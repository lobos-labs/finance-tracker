import * as db from './db'
import { personalLines } from './lines'
import { detectRecurring } from './recurring'
import { daysAway, tripAt, tripWindows } from './trips'
import { payeeKey } from '../shared/payroll'
import { QUANTILES } from '../shared/ranges'
import type { RecurringSeries } from '../shared/types'
import { addDays, daysInMonth, shiftMonth } from '../shared/zone'

// What a month of spending is likely to cost, as a range rather than one
// number. Each category is its recurring bills (fixed: the same every month)
// plus everything else, simulated a few thousand times from the last six
// months: how many purchases happen in a month (Poisson at the observed
// rate) and what each one costs (drawn from the real amounts, refunds
// included). The spread of the simulated months gives the range, and the
// number of purchases behind it gives the confidence.

const TRIALS = 2000

export interface CategoryModel {
  categoryId: number | null
  name: string
  /** recurring bills and subscriptions in this category, per month */
  fixedCents: number
  /** the part of fixedCents usually charged by today */
  fixedToDateCents: number
  /** variable purchases (and refunds, negative) over the window, each with the transaction it is on */
  events: Array<{ cents: number; merchant: string; posted: number; account: string; id: string }>
  perMonth: number
  /** the average month: what targets default to, since averages add up across categories */
  meanCents: number
  /** spending at each of QUANTILES percent, for a whole month and through today */
  month: number[]
  toDate: number[] | null
  confidence: 'high' | 'medium' | 'low'
  trials: Float64Array
  trialsToDate: Float64Array | null
}

export interface SpendModel {
  months: string[]
  categories: CategoryModel[]
  total: number[]
  totalToDate: number[] | null
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash = (s: string): number => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261)

function poisson(lambda: number, rand: () => number): number {
  if (lambda <= 0) return 0
  if (lambda > 30) {
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand())
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z))
  }
  const l = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= rand()
  } while (p > l)
  return k - 1
}

export function quantiles(values: Float64Array): number[] {
  const sorted = Float64Array.from(values).sort()
  return QUANTILES.map((q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * (sorted.length - 1)))]))
}

const monthStart = (month: string): number => db.monthStart(month)
const shift = shiftMonth
const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

/** A purchase's payee key, as recurring series are keyed: the payee and the direction. */
export const PAYEE_KEY = `lower(trim(COALESCE(t.merchant, t.desc_key))) || CASE WHEN t.amount_cents < 0 THEN '|-' ELSE '|+' END`

/** One line of Personal spending: its part of a line in an expense category, or of uncategorized money out. */
export interface SpendLine {
  id: string
  splitId: number | null
  account: string
  cat: number | null
  /** its category's name, or Uncategorized */
  name: string
  /** YYYY-MM */
  m: string
  posted: number
  merchant: string
  /** its payee key, as recurring series are keyed */
  key: string
  /** spent: positive, a refund negative */
  cents: number
  /** the whole line's spending, Personal's or not: what a loan's payment is known by */
  lineCents: number
  oneTime: boolean
}

/**
 * Personal spending between two unix times (end exclusive), line by line, oldest first: Personal's part of each line
 * in an expense category, refunds included, and of each line of uncategorized money out, as the classifier gives it
 * (lines.ts): its own lines, and its use share of a place's costs a venture shares. The classifier is read through
 * the current month's end at least, so the budget, the debt plan, the headline and the waterfall's open month share
 * one read of it.
 */
export function personalSpending(from: number, to: number): SpendLine[] {
  if (to <= from) return []
  const end = [lastDayOf(db.today().slice(0, 7)), db.dayKey(to - 1)].sort()[1]
  const out = new Map<string, SpendLine>()
  for (const l of personalLines(db.dayKey(from), end)) {
    if (l.posted < from || l.posted >= to || !(l.kind === 'expense' || (l.categoryId === null && l.cents < 0))) continue
    // A loan payment's interest and principal, or a capital part, are one line of spending here.
    const k = `${l.txnId}:${l.splitId ?? ''}`
    const had = out.get(k)
    if (had) {
      had.cents -= l.cents
      continue
    }
    out.set(k, { id: l.txnId, splitId: l.splitId, account: l.accountId, cat: l.categoryId, name: l.category ?? 'Uncategorized', m: l.day.slice(0, 7), posted: l.posted, merchant: l.merchant ?? l.description, key: payeeKey(l), cents: -l.cents, lineCents: -l.lineCents, oneTime: l.oneTime })
  }
  return [...out.values()]
}

/** Recurring bills and subscriptions still coming. */
export const recurringBills = (series = detectRecurring()): RecurringSeries[] =>
  series.filter((s) => !s.dismissed && s.status !== 'stopped' && s.typicalCents < 0 && s.kind !== 'income' && s.kind !== 'transfer' && s.categoryName)

/** A recurring bill's share in one category, per month and per charge (positive cents). */
export interface BillShare {
  series: RecurringSeries
  /** the payee key, without the account a second series on the same payee carries */
  key: string
  name: string
  monthly: number
  typical: number
  /** from a split charge: only its own category's lines are the bill */
  split: boolean
}

/**
 * Each bill by category, at Personal's share. A bill whose latest charge is split is shared among that
 * charge's parts in the view (Personal by default), each in its own category; a part in a venture has
 * no share, and neither has a venture's own bill.
 */
export function billShares(recurring = recurringBills()): BillShare[] {
  const bills: Array<{ whole: BillShare; last: { id: string; cents: number; posted: number } | undefined }> = []
  for (const s of recurring) {
    if (s.personalBp <= 0) continue
    const key = s.key.split('|').slice(0, 2).join('|')
    const whole = { series: s, key, name: s.categoryName!, monthly: Math.abs(s.monthlyCents), typical: Math.abs(s.typicalCents), split: false }
    const last = db.get<{ id: string; cents: number; posted: number }>(`SELECT t.id, t.amount_cents AS cents, t.posted FROM transactions t WHERE ${PAYEE_KEY} = ? AND t.posted = ? AND ${db.IS_SPLIT} LIMIT 1`, key, s.lastDate)
    bills.push({ whole, last })
  }
  // Each split charge's Personal parts by category (negative, as the charge is), from one read of the classifier.
  const split = bills.flatMap((b) => (b.last ? [b.last.posted] : []))
  const parts = new Map<string, Map<string, number>>()
  if (split.length) {
    for (const p of personalSpending(db.dayStart(db.dayKey(Math.min(...split))), db.dayStart(addDays(db.dayKey(Math.max(...split)), 1)))) {
      const byName = parts.get(p.id) ?? new Map<string, number>()
      byName.set(p.name, (byName.get(p.name) ?? 0) - p.cents)
      parts.set(p.id, byName)
    }
  }
  const out: BillShare[] = []
  for (const { whole, last } of bills) {
    if (!last) {
      out.push({ ...whole, monthly: Math.round((whole.monthly * whole.series.personalBp) / 10000) })
      continue
    }
    for (const [name, cents] of parts.get(last.id) ?? []) out.push({ ...whole, name, monthly: Math.round((whole.monthly * cents) / last.cents), typical: Math.round((whole.typical * cents) / last.cents), split: true })
  }
  return out
}

/** Whether a purchase pays a recurring bill: by payee key (and category, for a split bill), or by its category and an amount near the bill's (bank descriptions drift month to month). */
export function billTest(shares = billShares()): (r: { key: string; name: string; cents: number }) => boolean {
  const keys = new Set(shares.map((b) => (b.split ? `${b.key}\u0000${b.name}` : b.key)))
  const amounts = new Map<string, number[]>()
  for (const b of shares) amounts.set(b.name, [...(amounts.get(b.name) ?? []), b.typical])
  return (r) => r.cents > 0 && (keys.has(r.key) || keys.has(`${r.key}\u0000${r.name}`) || (amounts.get(r.name) ?? []).some((a) => Math.abs(r.cents - a) <= Math.max(100, a * 0.02)))
}

/**
 * Personal spending over the six full months before `anchor`, modeled by category.
 * dayFraction (0 to 1) also models the month through that point; skip leaves out
 * categories by name, and skipAmounts leaves out recurring bills of those amounts
 * (loan payments the debt plan makes on its own). Accounts in behind (their feed
 * lags) are left out of the month so far, since this month has none of their charges yet.
 * Purchases marked one-time, and what's bought on a trip, are left out unless withOneTime
 * (the debt plan counts everything); a month's rate of purchases counts only the days at home.
 */
export function buildModel(
  anchor: string,
  opts: { dayOfMonth?: number | null; daysInMonth?: number; skip?: string[]; skipAmounts?: number[]; behind?: string[]; withOneTime?: boolean } = {}
): SpendModel {
  const months = Array.from({ length: 6 }, (_, i) => shift(anchor, i - 6))
  const from = monthStart(months[0])
  const to = monthStart(anchor)
  const fraction = opts.dayOfMonth && opts.daysInMonth ? opts.dayOfMonth / opts.daysInMonth : null

  // Recurring bills and subscriptions still coming, by payee key; a split one by its parts' categories.
  const shares = billShares()
  const skipAmounts = new Set(opts.skipAmounts ?? [])
  const isBill = billTest(shares)
  const fixedBy = new Map<string, { month: number; toDate: number }>()
  for (const { series: s, name, monthly } of shares) {
    if (skipAmounts.has(Math.abs(s.typicalCents))) continue
    const f = fixedBy.get(name) ?? { month: 0, toDate: 0 }
    f.month += monthly
    if (fraction !== null) {
      // A monthly bill counts toward today once its usual day has passed; more frequent ones accrue.
      const usualDay = Number(db.dayKey(s.lastDate).slice(8))
      f.toDate += ['monthly', 'quarterly', 'annual'].includes(s.cadence) ? (usualDay <= opts.dayOfMonth! ? monthly : 0) : Math.round(monthly * fraction)
    }
    fixedBy.set(name, f)
  }

  const rows = personalSpending(from, to).filter((r) => opts.withOneTime || !r.oneTime)
  const skip = new Set(opts.skip ?? [])
  const trips = opts.withOneTime ? [] : tripWindows()
  // Months at home: days away have none of the purchases a month's range is drawn from.
  const home = Math.max(1, months.length - daysAway(trips, from, to) / 30.44)
  const byCat = new Map<string, { cat: number | null; events: CategoryModel['events'] }>()
  const names = new Map<string, number | null>(db.listCategories().filter((c) => c.kind === 'expense').map((c) => [c.name, c.id]))
  for (const [name, cat] of names) if (!skip.has(name)) byCat.set(name, { cat, events: [] })
  for (const r of rows) {
    if (skip.has(r.name)) continue
    // Recurring bills are the fixed part; a refund of one still nets against the variable part.
    if (isBill(r)) continue
    // What's bought away is a one-off, like a purchase marked one-time.
    if (tripAt(trips, r.posted)) continue
    const c = byCat.get(r.name) ?? { cat: r.cat, events: [] }
    c.events.push({ cents: r.cents, merchant: r.merchant, posted: r.posted, account: r.account, id: r.id })
    byCat.set(r.name, c)
  }

  const categories: CategoryModel[] = []
  const total = new Float64Array(TRIALS)
  const totalToDate = fraction !== null ? new Float64Array(TRIALS) : null
  for (const [name, { cat, events }] of byCat) {
    const fixed = fixedBy.get(name) ?? { month: 0, toDate: 0 }
    if (!events.length && !fixed.month) continue
    const perMonth = events.length / home
    const behind = new Set(opts.behind ?? [])
    const current = behind.size ? events.filter((e) => !behind.has(e.account)) : events
    const rand = mulberry32(hash(name))
    const trials = new Float64Array(TRIALS)
    const trialsToDate = fraction !== null ? new Float64Array(TRIALS) : null
    for (let i = 0; i < TRIALS; i++) {
      let sum = 0
      const n = poisson(perMonth, rand)
      for (let k = 0; k < n; k++) sum += events[Math.floor(rand() * events.length)].cents
      trials[i] = Math.max(0, sum) + fixed.month
      if (trialsToDate) {
        let part = 0
        const m = current.length ? poisson((current.length / home) * fraction!, rand) : 0
        for (let k = 0; k < m; k++) part += current[Math.floor(rand() * current.length)].cents
        trialsToDate[i] = Math.max(0, part) + fixed.toDate
      }
      total[i] += trials[i]
      if (totalToDate && trialsToDate) totalToDate[i] += trialsToDate[i]
    }
    const purchases = events.filter((e) => e.cents > 0).length
    const fixedShare = fixed.month / Math.max(1, fixed.month + Math.max(0, events.reduce((s, e) => s + e.cents, 0)) / months.length)
    categories.push({
      categoryId: cat,
      name,
      fixedCents: fixed.month,
      fixedToDateCents: fixed.toDate,
      events,
      perMonth,
      meanCents: Math.round(trials.reduce((s, v) => s + v, 0) / TRIALS),
      month: quantiles(trials),
      toDate: trialsToDate ? quantiles(trialsToDate) : null,
      confidence: fixedShare >= 0.8 || purchases >= 40 ? 'high' : purchases >= 12 ? 'medium' : 'low',
      trials,
      trialsToDate
    })
  }
  return { months, categories, total: quantiles(total), totalToDate: totalToDate ? quantiles(totalToDate) : null }
}
