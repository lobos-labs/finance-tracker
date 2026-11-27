import { createHash } from 'node:crypto'
import * as db from './db'
import { aiEnabled, getBackend, getProvider, routeModel, toAiError } from './ai/backend'
import { perLedger } from './ai/host'
import { detectRecurring } from './recurring'
import { investments } from './investments'
import { getBudget } from './budget'
import { DEBT_PLAN_KEY, getDebts } from './debts'
import { listTrips } from './trips'
import { vendorHider } from './privacy'
import { behindAccounts } from './feeds'
import { personalLines, type LedgerLine } from './lines'
import { getNetWorthSeries } from './netWorth'
import { SPENDING, spendingCategories, TAKE_HOME } from './summary'
import { monthsBetween, runDebtPlan } from '../shared/debtPlan'
import { dateString, dayFrom, daysInMonth as monthLength } from '../shared/zone'
import type { Insight } from '../shared/types'

// Home's headline. All arithmetic happens here in SQL/JS; Claude only
// chooses which fact matters most and phrases it, so it never has to invent
// or compute a number from raw rows.

const DAY = 86_400
const $ = (cents: number): number => Math.round(cents / 100)

interface Totals {
  spend: number
  income: number
  byCategory: Record<string, number>
}

interface Digest {
  today: string
  month: string
  dayOfMonth: number
  daysInMonth: number
  fullMonthsOfHistory: number
  /** accounts that usually have activity but whose feed has nothing recent (the bank sync is behind); monthToDate and typicalByThisDay both leave them out */
  behindAccounts: Array<{ account: string; lastTransaction: string; typicalSpendByThisDay: number }>
  monthToDate: Totals
  /** average of recent full months, measured through the same day of the month */
  typicalByThisDay: Totals | null
  /** average full month over the same recent months */
  typicalFullMonth: Totals | null
  recentMonths: Array<{ month: string; spend: number; income: number }>
  largestThisMonth: Array<{ merchant: string; amount: number; category: string; date: string }>
  newMerchantsThisMonth: Array<{ merchant: string; amount: number; category: string }>
  /** amounts keep cents so small subscription price changes are visible */
  recurringCharges: Array<{ merchant: string; kind: string; cadence: string; status: string; latest: number; previous: number; priceChanged: boolean; lastCharged: string; nextDue: string }>
  netWorth: { current: number; change30d: number | null; change90d: number | null; change365d: number | null } | null
  /** card and loan balances owed, now and 30 days ago */
  debt: { owed: number; owed30dAgo: number | null; accounts: Array<{ account: string; owed: number }> } | null
  investments: { value: number; change30d: number | null } | null
  /** bills, subscriptions and loan payments due in the next 10 days */
  upcoming: Array<{ merchant: string; amount: number; due: string }>
  /** merchants visited most often this month */
  frequentThisMonth: Array<{ merchant: string; visits: number; amount: number }>
  /** the debt plan's debts (Net worth's Debts): what they owe, when the plan pays them off at current habits, and specific changes with how much sooner each would clear them */
  payoff: { owed: number; debtFreeAsIs: string | null; plans: Array<{ action: string; detail: string; savesPerMonth: number; debtFreeIf: string | null; monthsSooner: number | null }> } | null
  uncategorizedThisMonth: number
  /** time away, now or within six weeks either side: spending jumps then (meals and rides away, a place to stay) and it's budgeted as one-offs */
  trips: Array<{ name: string; from: string; to: string }>
  /** things the user told the assistant */
  facts: string[]
}

// The headline is about everyday money: Personal's, as the classifier gives it its part of every line (lines.ts),
// with spending and income as the waterfall's rows read them (summary.ts), so the headline, Home and Review agree.
// Buckets (a rental, a business) are left out.

/** The start of month `m` (0-11, rolling over) of year `y` in the ledger's zone. */
function monthStart(y: number, m: number): number {
  return db.monthStart(dayFrom(y, m + 1, 1).slice(0, 7))
}

/** The category a line of Personal's spending goes under, as getSummary names it (summary.spendingCategories). */
type CategoryOf = (l: LedgerLine) => string

/** Personal totals between two times, from its lines, leaving out some accounts or covering only some. */
function totalsBetween(lines: LedgerLine[], categoryOf: CategoryOf, from: number, to: number, accounts: { skip?: string[]; only?: string[] } = {}): Totals {
  const only = accounts.only ? new Set(accounts.only) : null
  const skip = new Set(accounts.skip ?? [])
  const spent = new Map<string, number>()
  let spend = 0
  let income = 0
  for (const l of lines) {
    if (l.posted < from || l.posted >= to || (only ? !only.has(l.accountId) : skip.has(l.accountId))) continue
    if (SPENDING.has(l.cls)) {
      spend -= l.cents
      const name = categoryOf(l)
      spent.set(name, (spent.get(name) ?? 0) - l.cents)
    } else if (TAKE_HOME.has(l.cls)) income += l.cents
  }
  const byCategory: Record<string, number> = {}
  for (const [name, cents] of spent) if (cents > 0) byCategory[name] = $(cents)
  return { spend: $(spend), income: $(income), byCategory }
}

/** Personal's purchases: its spending, and money out not yet categorized. */
const bought = (l: LedgerLine): boolean => l.cents < 0 && (SPENDING.has(l.cls) || l.cls === 'unsorted')

/** Purchases grouped by a key: each group's money out (positive), how many transactions, its first line's payee and day, and its largest line's category. */
function purchaseGroups(lines: LedgerLine[], categoryOf: CategoryOf, keyOf: (l: LedgerLine) => string): Array<{ key: string; m: string; a: number; n: number; cat: string; posted: number }> {
  const groups = new Map<string, { m: string; a: number; ids: Set<string>; cat: string; posted: number; top: number }>()
  for (const l of lines) {
    const k = keyOf(l)
    const g = groups.get(k) ?? { m: l.merchant ?? l.description, a: 0, ids: new Set<string>(), cat: categoryOf(l), posted: l.posted, top: 0 }
    g.a -= l.cents
    g.ids.add(l.txnId)
    // A split purchase goes under its largest part's category.
    if (-l.cents > g.top) [g.top, g.cat] = [-l.cents, categoryOf(l)]
    groups.set(k, g)
  }
  return [...groups].map(([key, g]) => ({ key, m: g.m, a: g.a, n: g.ids.size, cat: g.cat, posted: g.posted }))
}

function average(list: Totals[]): Totals | null {
  if (!list.length) return null
  const byCategory: Record<string, number> = {}
  for (const t of list) for (const [k, v] of Object.entries(t.byCategory)) byCategory[k] = (byCategory[k] ?? 0) + v
  for (const k of Object.keys(byCategory)) byCategory[k] = Math.round(byCategory[k] / list.length)
  return {
    spend: Math.round(list.reduce((s, t) => s + t.spend, 0) / list.length),
    income: Math.round(list.reduce((s, t) => s + t.income, 0) / list.length),
    byCategory
  }
}

const fmtDay = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: db.zone() })

const monthName = (m: string | null): string | null => (m ? new Date(`${m}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : null)

/** The payoff plans as last worked out, with the debt plan's inputs they ran on, and the headline being asked for: one of each per ledger (ai/host.ts). */
const kept = perLedger(() => ({ payoff: null as { at: number; plan: string | null; value: Digest['payoff'] } | null, inflight: null as { key: string; promise: Promise<Insight | null> } | null }))

/**
 * The debt plan as Net worth's Debts runs it (debtPlan.ts runDebtPlan, on the debt.plan inputs): what the debts it
 * pays down owe and when they're gone, and specific changes with how much sooner each would clear them. Recomputed at
 * most every ten minutes, and as soon as the plan's inputs change.
 */
function payoffPlans(): Digest['payoff'] {
  const cache = kept()
  const plan = db.getSetting(DEBT_PLAN_KEY)
  if (cache.payoff && cache.payoff.plan === plan && Date.now() - cache.payoff.at < 10 * 60_000) return cache.payoff.value
  let value: Digest['payoff'] = null
  try {
    const view = getDebts()
    const base = runDebtPlan(view)
    if (base.debts.length) {
      value = {
        owed: $(base.debts.reduce((s, d) => s + d.balanceCents, 0)),
        debtFreeAsIs: monthName(base.result.debtFree),
        plans: getBudget(view.month)
          .habits.filter((h) => !h.committed && h.options.length)
          .slice(0, 6)
          .map((h) => {
            const o = h.options[h.options.length - 1]
            const r = runDebtPlan(view, view.spendCents - o.savingsCents).result
            const free = base.result.debtFree
            return { action: o.label, detail: `${h.title} (${h.detail})`, savesPerMonth: $(o.savingsCents), debtFreeIf: monthName(r.debtFree), monthsSooner: free && r.debtFree ? monthsBetween(r.debtFree, free) : null }
          })
          .filter((p) => (p.monthsSooner ?? 0) > 0)
      }
    }
  } catch {
    value = null
  }
  cache.payoff = { at: Date.now(), plan, value }
  return value
}
const fmtMonth = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: db.zone() })

export function buildDigest(): Digest | null {
  const nowTs = db.now()
  const today = db.dayKey(nowTs)
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7)) - 1
  const ms = monthStart(y, m)
  const dayOfMonth = Number(today.slice(8))
  const daysInMonth = monthLength(y, m + 1)

  const first = db.get<{ p: number | null }>(`SELECT MIN(t.posted) AS p ${db.VISIBLE_TXN_FROM}`)?.p
  if (!first) return null

  // Up to three prior months that our data fully covers.
  const covered: Array<{ start: number; end: number }> = []
  for (let i = 1; i <= 3; i++) {
    const start = monthStart(y, m - i)
    if (first <= start + 5 * DAY) covered.push({ start, end: monthStart(y, m - i + 1) })
  }
  // Personal's lines through this month's end, read once: the days getSummary's month and the budget read too
  // (lines.ts keeps them).
  const lines = personalLines(db.dayKey(covered.at(-1)?.start ?? ms), `${today.slice(0, 7)}-${String(daysInMonth).padStart(2, '0')}`)
  // Spending by category as getSummary names it: a loan's interest paid by a transfer under the loan.
  const spentAs = spendingCategories()
  const categoryOf: CategoryOf = (l) => spentAs(l).name
  // Pace compares like with like: accounts whose feed is behind are left out of both sides.
  const late = behindAccounts(nowTs)
  const skip = { skip: late.map((a) => a.id) }
  const byThisDay = covered.map(({ start, end }) => totalsBetween(lines, categoryOf, start, Math.min(start + dayOfMonth * DAY, end), skip))
  const behindList = late.map((a) => {
    const typical = average(covered.map(({ start, end }) => totalsBetween(lines, categoryOf, start, Math.min(start + dayOfMonth * DAY, end), { only: [a.id] })))
    return { account: a.name, lastTransaction: fmtDay(a.last), typicalSpendByThisDay: typical?.spend ?? 0 }
  })
  const full = covered.map(({ start, end }) => totalsBetween(lines, categoryOf, start, end))

  // Vendors the user hid are never named in an insight.
  const hidden = vendorHider()
  const purchases = lines.filter((l) => l.posted >= ms && bought(l))
  // One purchase each: a split one's personal spending parts added up, under its largest part's category.
  const largest = purchaseGroups(purchases, categoryOf, (l) => l.txnId)
    .sort((a, b) => b.a - a.a)
    .slice(0, 12)

  // Payees first paid this month (no transaction of theirs before it), with at least $25 spent there.
  const byPayee = purchaseGroups(purchases, categoryOf, (l) => l.merchant ?? l.descKey)
  const candidates = covered.length ? byPayee.filter((g) => g.a >= 2500) : []
  const seen = new Set<string>()
  for (let i = 0; i < candidates.length; i += 500) {
    const chunk = candidates.slice(i, i + 500).map((g) => g.key)
    for (const r of db.all<{ k: string }>(`SELECT DISTINCT COALESCE(merchant, desc_key) AS k FROM transactions WHERE posted < ? AND COALESCE(merchant, desc_key) IN (${chunk.map(() => '?').join(',')})`, ms, ...chunk)) seen.add(r.k)
  }
  const newMerchants = candidates
    .filter((g) => !seen.has(g.key))
    .sort((a, b) => b.a - a.a)
    .slice(0, 12)

  const recurring: Digest['recurringCharges'] = detectRecurring()
    .filter((s) => !s.dismissed && s.kind !== 'transfer' && !hidden(s.name))
    .map((s) => ({ merchant: s.name, kind: s.kind, cadence: s.cadence, status: s.status, latest: Math.abs(s.lastCents) / 100, previous: Math.abs(s.previousCents) / 100, priceChanged: s.priceChanged, lastCharged: fmtDay(s.lastDate), nextDue: fmtDay(s.nextDate) }))

  const series = getNetWorthSeries().points
  const back = (days: number): number | null => (series.length > days ? series[series.length - 1].cents - series[series.length - 1 - days].cents : null)
  // An account with no balance (a CSV with no balance column, say; Review's missing_balance) is walked from nothing, so
  // the series can't back a net worth or its change until one is set: neither the headline nor Claude's gets them.
  const unbacked = db.listAccounts().some((a) => !a.hidden && a.balanceCents === null)
  const netWorth = series.length && !unbacked
    ? { current: $(series[series.length - 1].cents), change30d: back(30) === null ? null : $(back(30)!), change90d: back(90) === null ? null : $(back(90)!), change365d: back(365) === null ? null : $(back(365)!) }
    : null

  const uncategorized = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${db.VISIBLE_TXN_FROM} WHERE t.posted >= ? AND t.category_id IS NULL AND ${db.NOT_SPLIT}`, ms)?.n ?? 0

  const debts = db.listAccounts().filter((a) => !a.hidden && ['credit_card', 'loan', 'other_debt'].includes(a.assetType) && (a.balanceCents ?? 0) < 0)
  const past = db.balancesOn(debts.map((a) => a.id), db.dayKey(nowTs - 30 * DAY))
  const debt = debts.length
    ? {
        owed: $(debts.reduce((s, a) => s - (a.balanceCents ?? 0), 0)),
        owed30dAgo: $(debts.reduce((s, a) => s - Math.min(0, past.get(a.id) ?? 0), 0)),
        accounts: debts.map((a) => ({ account: a.name, owed: $(-(a.balanceCents ?? 0)) })).sort((a, b) => b.owed - a.owed)
      }
    : null

  const inv = investments().points
  const invTotal = (p: (typeof inv)[number]): number => p.pretax + p.roth + p.hsa + p.taxable
  const investmentsNow = inv.length ? { value: $(invTotal(inv[inv.length - 1])), change30d: inv.length > 5 ? $(invTotal(inv[inv.length - 1]) - invTotal(inv[inv.length - 5])) : null } : null

  const upcoming = detectRecurring()
    .filter((s) => !s.dismissed && s.status !== 'stopped' && s.kind !== 'income' && s.kind !== 'transfer' && s.nextDate >= nowTs - DAY && s.nextDate <= nowTs + 10 * DAY && !hidden(s.name))
    .sort((a, b) => a.nextDate - b.nextDate)
    .slice(0, 8)
    .map((s) => ({ merchant: s.name, amount: Math.abs(s.typicalCents) / 100, due: fmtDay(s.nextDate) }))

  const frequent = byPayee
    .filter((g) => g.n >= 4)
    .sort((a, b) => b.n - a.n)
    .slice(0, 10)

  return {
    today: dateString(today),
    month: fmtMonth(ms),
    dayOfMonth,
    daysInMonth,
    fullMonthsOfHistory: covered.length,
    behindAccounts: behindList,
    monthToDate: totalsBetween(lines, categoryOf, ms, nowTs + DAY, skip),
    typicalByThisDay: average(byThisDay),
    typicalFullMonth: average(full),
    recentMonths: covered.map(({ start }, i) => ({ month: fmtMonth(start), spend: full[i].spend, income: full[i].income })),
    largestThisMonth: largest.filter((r) => !hidden(r.m)).slice(0, 5).map((r) => ({ merchant: r.m, amount: $(r.a), category: r.cat, date: fmtDay(r.posted) })),
    newMerchantsThisMonth: newMerchants.filter((r) => !hidden(r.m)).slice(0, 5).map((r) => ({ merchant: r.m, amount: $(r.a), category: r.cat })),
    recurringCharges: recurring.slice(0, 25),
    netWorth,
    debt,
    investments: investmentsNow,
    upcoming,
    frequentThisMonth: frequent.filter((r) => !hidden(r.m)).slice(0, 4).map((r) => ({ merchant: r.m, visits: r.n, amount: $(r.a) })),
    payoff: payoffPlans(),
    uncategorizedThisMonth: uncategorized,
    trips: listTrips()
      .filter((t) => t.to >= db.dayKey(db.now() - 42 * 86_400) && t.from <= db.dayKey(db.now() + 42 * 86_400))
      .map((t) => ({ name: t.name, from: t.from, to: t.to })),
    facts: db.promptFacts().map((f) => f.text)
  }
}

// ---------- fallback (no API key, or the call failed) ----------

const money = (n: number): string => `$${Math.abs(n).toLocaleString('en-US')}`

type Local = Pick<Insight, 'headline' | 'detail' | 'tone'> & { category: string | null; angle: Angle }

function localInsight(d: Digest, recent: Angle[]): Local {
  const mtd = d.monthToDate
  const typical = d.typicalByThisDay
  const monthName = d.month.split(' ')[0]
  const options: Local[] = []
  const gap = d.behindAccounts[0]
  const best = d.payoff?.plans[0]
  if (best?.monthsSooner && best.debtFreeIf && d.payoff?.debtFreeAsIs) {
    // The month the change brings with its year, and the month as it stands by name alone only in the same year: a
    // plan that runs to a mortgage's end is years out, and June before January reads wrong without them.
    const [month, year] = d.payoff.debtFreeAsIs.split(' ')
    options.push({
      angle: 'payoff',
      headline: `${best.action} and you're debt-free in ${best.debtFreeIf} instead of ${best.debtFreeIf.endsWith(` ${year}`) ? month : d.payoff.debtFreeAsIs}`,
      detail: `Saves about ${money(best.savesPerMonth)} a month: ${best.detail}.`.slice(0, 240),
      tone: 'positive',
      category: null
    })
  }
  if (typical) {
    const top = Object.entries(mtd.byCategory)
      .map(([cat, v]) => ({ cat, v, delta: v - (typical.byCategory[cat] ?? 0) }))
      .sort((a, b) => b.delta - a.delta)[0]
    if (top && top.delta >= 50) {
      options.push({
        angle: 'category',
        headline: `${top.cat} is ${money(top.delta)} above your usual pace this month`,
        detail: `${money(top.v)} so far vs ${money(typical.byCategory[top.cat] ?? 0)} by day ${d.dayOfMonth} in a typical month.`,
        tone: 'negative',
        category: top.cat
      })
    }
    const delta = mtd.spend - typical.spend
    // A behind feed makes a low total meaningless, so only a high one counts then.
    if (Math.abs(delta) >= 100 && (delta > 0 || !gap)) {
      options.push({
        angle: 'spending_pace',
        headline: `Spending is ${money(delta)} ${delta > 0 ? 'above' : 'below'} your usual pace for ${monthName}`,
        detail: `${money(mtd.spend)} so far vs ${money(typical.spend)} by day ${d.dayOfMonth} in a typical month.`,
        tone: delta > 0 ? 'negative' : 'positive',
        category: null
      })
    }
  }
  if (d.debt && d.debt.owed30dAgo !== null && Math.abs(d.debt.owed - d.debt.owed30dAgo) >= 100) {
    const down = d.debt.owed < d.debt.owed30dAgo
    options.push({ angle: 'debt', headline: `Card and loan balances are ${down ? 'down' : 'up'} ${money(d.debt.owed - d.debt.owed30dAgo)} in 30 days`, detail: `${money(d.debt.owed)} owed now vs ${money(d.debt.owed30dAgo)} a month ago.`, tone: down ? 'positive' : 'negative', category: null })
  }
  if (d.upcoming.length) {
    const total = d.upcoming.reduce((s, u) => s + u.amount, 0)
    options.push({ angle: 'upcoming', headline: `${money(Math.round(total))} in bills due over the next 10 days`, detail: d.upcoming.slice(0, 3).map((u) => `${u.merchant} ${money(Math.round(u.amount))} (${u.due})`).join(', ') + '.', tone: 'neutral', category: null })
  }
  if (d.frequentThisMonth[0]) {
    const f = d.frequentThisMonth[0]
    options.push({ angle: 'habit', headline: `${f.merchant}: ${f.visits} visits so far in ${monthName}`, detail: `${money(f.amount)} there this month.`, tone: 'neutral', category: null })
  }
  if (d.netWorth?.change30d) {
    options.push({ angle: 'net_worth', headline: `Net worth is ${d.netWorth.change30d > 0 ? 'up' : 'down'} ${money(d.netWorth.change30d)} in 30 days`, detail: `${money(d.netWorth.current)} now.`, tone: d.netWorth.change30d > 0 ? 'positive' : 'negative', category: null })
  }
  options.push({ angle: 'other', headline: `${money(mtd.spend)} spent so far in ${monthName}`, detail: `Income ${money(mtd.income)} · day ${d.dayOfMonth} of ${d.daysInMonth}.`, tone: 'neutral', category: null })
  return options.find((o) => !recent.includes(o.angle)) ?? options[0]
}

// ---------- Claude ----------

const SYSTEM = `You write the one-line headline for a personal finance dashboard. The reader is the account owner, who wants real information at a glance: no encouragement, tips, or generic advice.

From the data digest, choose one observation worth knowing right now. Topics ("angle"):
- spending_pace: total spending well above or below the owner's typical pace for this day of the month
- category: one category running well above or below its usual pace
- recurring: a new recurring charge, a price change, or one that stopped or is late
- large_purchase: an unusually large purchase
- new_merchant: significant spending at a new merchant
- habit: a merchant visited unusually often this month
- income: income missing or lower than usual, or spending outpacing income
- net_worth: a meaningful net worth move over 30 or 90 days
- debt: card and loan balances moving, or the biggest balance
- investments: the investment accounts' value or 30-day move
- upcoming: a notable bill or cluster of bills due in the next 10 days
- payoff: one plan from payoff.plans, said as what it does to the debt: "Eat out once a week and you're debt-free in March instead of June". Debt weighs on most people, so this lands; use the plan's own numbers and wording, never invent a plan
Vary the topic: recentHeadlines lists the last few headlines and their angles. Pick a different angle than any of them unless the same issue has become a serious warning. A different angle that's true and specific beats repeating the most obvious one.

Accuracy: monthToDate and typicalByThisDay leave out the accounts in behindAccounts, so they describe only the accounts that are current. When behindAccounts is not empty, never call total spending low, on track or below pace; compare only the current accounts. The user knows which feeds run behind (some cards post weeks late), so a sync delay is never the observation: don't mention it in the headline or detail. Spending during and right after a trip in trips is expected to jump (meals and rides away, a place to stay); it is never a warning.

Use only numbers that appear in the digest. Amounts are dollars: whole dollars ($1,234) everywhere except recurring charges, which keep cents ($17.99). Percentages computed from digest numbers are fine; round them to whole percent. Name the specific category or merchant. No emoji, no exclamation marks, no advice ("consider", "try"), no praise.

Never a recommendation to buy, sell, hold or move investments, and nothing about what to report, deduct or claim on taxes: the investments angle states the value and its move, nothing more. A payoff plan is the app's own computation; use it as given.

headline: one sentence, at most 90 characters.
detail: one sentence with the supporting numbers, at most 160 characters.
tone: "positive" if it is good news for the owner's finances, "negative" if it is a warning, otherwise "neutral".
category: the category the headline is about, exactly as named in the digest, or "" if none.
angle: the topic you chose, from the list above.`

const ANGLES = ['spending_pace', 'category', 'recurring', 'large_purchase', 'new_merchant', 'habit', 'income', 'net_worth', 'debt', 'investments', 'upcoming', 'payoff', 'other'] as const
type Angle = (typeof ANGLES)[number]
type Answer = { headline: string; detail: string; tone: Insight['tone']; category: string; angle: Angle }

/** The last few headlines and their topics, so the next one picks something else. */
interface Past {
  angle: Angle
  headline: string
}
const recentPast = (): Past[] => {
  try {
    return (JSON.parse(db.getSetting('insight.history') ?? '[]') as Past[]).slice(-4)
  } catch {
    return []
  }
}
function remember(p: Past): void {
  db.setSetting('insight.history', JSON.stringify([...recentPast(), p].slice(-8)))
}
const withHistory = (digest: Digest): string => `Data digest:\n${JSON.stringify({ ...digest, recentHeadlines: recentPast() })}`

const answerSchema = (categories: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: {
    headline: { type: 'string' },
    detail: { type: 'string' },
    tone: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
    category: { type: 'string', enum: [...categories, ''] },
    angle: { type: 'string', enum: [...ANGLES] }
  },
  required: ['headline', 'detail', 'tone', 'category', 'angle'],
  additionalProperties: false
})

async function ask(digest: Digest, categories: string[]): Promise<Answer> {
  return checked(await getBackend().structured({ route: 'headline', system: SYSTEM, prompt: withHistory(digest), schema: answerSchema(categories) }))
}

function checked(parsed: unknown): Answer {
  const a = parsed as Partial<Answer> | null
  if (!a || typeof a.headline !== 'string' || !a.headline.trim()) throw new Error('The AI returned an empty insight.')
  return { headline: a.headline, detail: String(a.detail ?? ''), tone: a.tone === 'positive' || a.tone === 'negative' ? a.tone : 'neutral', category: String(a.category ?? ''), angle: ANGLES.includes(a.angle as Angle) ? (a.angle as Angle) : 'other' }
}

interface Cached {
  key: string
  /** the key with the date left out of the digest */
  undated?: string
  insight: Insight
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')

/** Returns the cached headline when the numbers haven't changed; otherwise asks Claude for a new one. */
export function getInsight(force = false): Promise<Insight | null> {
  const digest = buildDigest()
  if (!digest) return Promise.resolve(null)
  // The instructions and the model are part of the key, so changing them retires a cached headline.
  const stamp = SYSTEM + routeModel('headline')
  const key = sha1(stamp + JSON.stringify(digest))
  const undated = sha1(stamp + JSON.stringify({ ...digest, today: '', dayOfMonth: 0 }))
  // Share a request already under way for the same numbers. If the numbers
  // changed since it started (a categorization run finished, say), ask again.
  const state = kept()
  if (state.inflight?.key === key) return state.inflight.promise
  const run = {
    key,
    promise: compute(digest, key, undated, force).finally(() => {
      if (state.inflight === run) state.inflight = null
    })
  }
  state.inflight = run
  return run.promise
}

/**
 * Whether the cached headline stays: always while the digest is unchanged. In
 * API-key and hosted mode, where each call costs money, also when only the
 * date moved, and when one was already written today.
 */
function keep(cached: Cached, key: string, undated: string): boolean {
  if (cached.key === key) return true
  if (getProvider() === 'claude-code') return false
  if (cached.undated === undated) return true
  return db.dayKey(cached.insight.generatedAt) === db.dayKey(db.now())
}

async function compute(digest: Digest, key: string, undated: string, force: boolean): Promise<Insight | null> {
  const categories = db.listCategories()
  const idByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]))

  const cached = JSON.parse(db.getSetting('insight.cache') ?? 'null') as Cached | null
  // With the AI off, the local headline, not an earlier one of Claude's.
  if (!force && cached && aiEnabled() && keep(cached, key, undated)) return cached.insight

  const fallback = (error?: string): Insight => {
    const l = localInsight(digest, recentPast().map((p) => p.angle))
    remember({ angle: l.angle, headline: l.headline })
    return { headline: l.headline, detail: l.detail, tone: l.tone, categoryId: l.category ? (idByName.get(l.category.toLowerCase()) ?? null) : null, source: 'local', generatedAt: db.now(), error }
  }

  try {
    const r = await ask(digest, categories.map((c) => c.name))
    const insight: Insight = {
      headline: r.headline.trim().slice(0, 160),
      detail: r.detail.trim().slice(0, 240),
      tone: r.tone,
      categoryId: r.category ? (idByName.get(r.category.toLowerCase()) ?? null) : null,
      source: 'ai',
      generatedAt: db.now()
    }
    db.setSetting('insight.cache', JSON.stringify({ key, undated, insight } satisfies Cached))
    remember({ angle: r.angle, headline: insight.headline })
    return insight
  } catch (err) {
    return fallback(toAiError(err).message)
  }
}
