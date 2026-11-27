import * as db from './db'
import { firstLedgerDay, ledgerLines, personalPart, type LedgerLine } from './lines'
import { netWorthNow } from './netWorth'
import { categoryRole } from '../shared/categoryRole'
import { daysIn, isDay, shiftDay } from '../shared/period'
import { addDays, daysInMonth, shiftMonth } from '../shared/zone'
import type { BucketSelection, CategorySpend, LineClass, MerchantSpend, MonthPoint, MonthSummary } from '../shared/types'

// Spending, income and where they came from and went, for a month or a span: getSummary, getRangeSummary and Review's
// month_summary. Personal's money is the classifier's (lines.ts), read as the waterfall's rows read it, so the two
// agree to the cent:
//   - spending is Committed, Everyday and One-offs: bills and subscriptions, interest and escrow on debts, everyday
//     spending and one-offs, less one-off income (a reimbursement nets against the one-offs it repays)
//   - income is Take-home: pay as deposited and other income, less income tax paid from the bank (a refund adds)
// so income less spending is what was kept. Uncategorized money is in neither until it's categorized (unsortedCents),
// and neither is interest on cash (Growth), money moved between the user's own accounts or to savings, investments
// or debts, or an asset bought or sold. A venture's money is cash in and out by category, as its books read it
// (db.bucketSummary); a view of Personal and ventures together adds the two, a line placed in one of the ventures
// counted there whole and not again in Personal, and a cost Personal shares with one of them by use (a house with
// rooms rented) counted as both parts, so whole.

/** The classes Personal's spending reads, each line's spending its cents negated: Committed, Everyday and One-offs. */
export const SPENDING: ReadonlySet<LineClass> = new Set<LineClass>(['committed', 'debtCost', 'everyday', 'oneOff', 'oneOffIncome'])
/** The classes Personal's income reads, at their cents: Take-home. */
export const TAKE_HOME: ReadonlySet<LineClass> = new Set<LineClass>(['pay', 'income', 'tax'])

/**
 * Where Personal's spending goes by category: a line's own category, but a loan's interest paid by a transfer (a
 * line in no expense category) goes under the loan, as the waterfall's Committed part names it, so no transfer ever
 * reads as spending. `key` tells the groups apart.
 */
export function spendingCategories(): (l: LedgerLine) => { key: string; name: string } {
  const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
  return (l) => {
    const loan = l.cls === 'debtCost' && l.debtId !== null && l.kind !== 'expense' ? names.get(l.debtId) : undefined
    return loan === undefined ? { key: `cat:${l.categoryId ?? 'none'}`, name: l.category ?? 'Uncategorized' } : { key: `loan:${l.debtId}`, name: loan }
  }
}

const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const isMonth = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

/** The days a summary covers (both included), the days it compares with, and the months of its trend. */
interface Spans {
  cur: [string, string]
  prev: [string, string]
  trend: string[]
}

/** A month's summary, against the month before, with the twelve months through it. */
export function getSummary(month: string, buckets?: BucketSelection): MonthSummary {
  if (!isMonth(String(month))) throw new Error(`Invalid month: ${month}`)
  const before = shiftMonth(month, -1)
  const trend = Array.from({ length: 12 }, (_, i) => shiftMonth(month, i - 11))
  return { month, ...summarize(buckets, { cur: [`${month}-01`, lastDayOf(month)], prev: [`${before}-01`, lastDayOf(before)], trend }) }
}

/**
 * The same summary over a range of months, inclusive (a rental from purchase to sale), or of days
 * (YYYY-MM-DD, inclusive: the last 30). Days compare with as many days just before, and their
 * trend is the twelve months through the last day's.
 */
export function getRangeSummary(fromMonth: string, toMonth: string, buckets?: BucketSelection): MonthSummary {
  if (fromMonth > toMonth) [fromMonth, toMonth] = [toMonth, fromMonth]
  if (isDay(fromMonth) || isDay(toMonth)) {
    if (!isDay(fromMonth) || !isDay(toMonth)) throw new Error(`Invalid days: ${fromMonth} to ${toMonth}`)
    const month = toMonth.slice(0, 7)
    const trend = Array.from({ length: 12 }, (_, i) => shiftMonth(month, i - 11))
    const prev: [string, string] = [shiftDay(fromMonth, -daysIn(fromMonth, toMonth)), shiftDay(fromMonth, -1)]
    return { month, fromMonth: fromMonth.slice(0, 7), fromDay: fromMonth, toDay: toMonth, ...summarize(buckets, { cur: [fromMonth, toMonth], prev, trend }) }
  }
  for (const m of [fromMonth, toMonth]) if (!isMonth(m)) throw new Error(`Invalid month: ${m}`)
  const months: string[] = []
  for (let m = fromMonth; m <= toMonth && months.length < 240; m = shiftMonth(m, 1)) months.push(m)
  // Compared with the same number of months just before.
  const prev: [string, string] = [`${shiftMonth(fromMonth, -months.length)}-01`, addDays(`${fromMonth}-01`, -1)]
  return { month: toMonth, fromMonth, ...summarize(buckets, { cur: [`${fromMonth}-01`, lastDayOf(toMonth)], prev, trend: months }) }
}

/** A line as a summary reads it: what it adds to spending and to income (null when it's neither), and where from. */
interface Line {
  txnId: string
  day: string
  categoryId: number | null
  category: string | null
  /** the group its spending goes under by category (spendingCategories) */
  spentAs: { key: string; name: string }
  merchant: string | null
  descKey: string
  description: string
  cents: number
  /** spent, positive (a refund negative); null for a line that's no spending */
  spend: number | null
  income: number | null
  /** income from a paycheck, named by its payer rather than by its category */
  paycheck: boolean
  /** uncategorized money, signed, that neither counts (Personal's) */
  unsorted: number
}

/** The selection's figures: Personal's from the classifier, the ventures' from their lines, and both added when it has both. */
function summarize(buckets: BucketSelection | undefined, s: Spans): db.SummaryFigures {
  const ids = (buckets ?? []).filter((n) => Number.isInteger(n) && n >= 0)
  const ventures = ids.filter((n) => n > 0)
  // A venture's own view is its books' cash in and out (db.ts), as it always was.
  const unix = ([from, to]: [string, string]): [number, number] => [db.dayStart(from), db.dayStart(addDays(to, 1))]
  if (ventures.length && !ids.includes(0)) return { ...db.bucketSummary(ventures, ...unix(s.cur), unix(s.prev), s.trend), netWorthCents: netWorthNow() }
  const fromDay = [s.cur[0], s.prev[0], `${s.trend[0]}-01`].sort()[0]
  const toDay = [s.cur[1], lastDayOf(s.trend[s.trend.length - 1])].sort()[1]
  // With ventures beside Personal, a line placed in one of them is theirs whole (below), not Personal's part of it.
  const picked = new Set(ventures)
  const theirsWhole = (l: LedgerLine): boolean => l.bucketId !== null && picked.has(l.bucketId)
  const ledger = ledgerLines(fromDay, toDay)
  const spentAs = spendingCategories()
  const lines: Line[] = ledger
    .filter((l) => personalPart(l) && !theirsWhole(l))
    .map((l) => ({ ...l, spentAs: spentAs(l), spend: SPENDING.has(l.cls) ? -l.cents : null, income: TAKE_HOME.has(l.cls) ? l.cents : null, paycheck: l.cls === 'pay', unsorted: l.cls === 'unsorted' ? l.cents : 0 }))
  let firstMonth = firstLedgerDay()?.slice(0, 7) ?? null
  if (ventures.length) {
    const pay = new Set(db.listCategories().filter((c) => categoryRole(c.name) === 'paycheck').map((c) => c.id))
    // A venture's money as its books read it: cash in and out by category. Its lines whole, and its use share of a
    // cost placed elsewhere (a house Personal shares with it), so the two together count every such cost once, whole.
    // Money in with no category isn't income until it's categorized, as a venture's books in db.ts count it.
    const cash = (l: Omit<Line, 'spentAs' | 'spend' | 'income' | 'paycheck' | 'unsorted'> & { kind: string | null }): Line => {
      const uncategorized = l.categoryId === null
      const spend = l.kind === 'expense' || (uncategorized && l.cents < 0) ? -l.cents : null
      const income = l.kind === 'income' ? l.cents : null
      return { ...l, spentAs: { key: `cat:${l.categoryId ?? 'none'}`, name: l.category ?? 'Uncategorized' }, spend, income, paycheck: l.categoryId !== null && pay.has(l.categoryId), unsorted: 0 }
    }
    const theirs = db.bucketLines(ventures, db.dayStart(fromDay), db.dayStart(addDays(toDay, 1)))
    for (const l of theirs.lines) lines.push(cash(l))
    for (const l of ledger) if (l.owner !== null && !personalPart(l) && picked.has(l.owner) && !theirsWhole(l)) lines.push(cash(l))
    firstMonth = [firstMonth, theirs.firstMonth].filter((m): m is string => m !== null).sort()[0] ?? null
  }
  return { ...figures(lines, s), firstMonth, uncategorizedCount: db.uncategorizedCount(), netWorthCents: netWorthNow() }
}

/** The figures over the spans, from lines read once over all of them. */
function figures(lines: Line[], s: Spans): Omit<db.SummaryFigures, 'firstMonth' | 'uncategorizedCount' | 'netWorthCents'> {
  const within = ([from, to]: [string, string]): Line[] => lines.filter((l) => l.day >= from && l.day <= to)
  let spend = 0
  let income = 0
  let unsorted = 0
  const txns = new Set<string>()
  const byCategory = new Map<string, { categoryId: number | null; name: string; cents: number; ids: Set<string> }>()
  const merchants = new Map<string, { name: string; cents: number; ids: Set<string> }>()
  const sources = new Map<string, { cents: number; paycheck: boolean; payers: Map<string, { name: string; cents: number }> }>()
  for (const l of within(s.cur)) {
    txns.add(l.txnId)
    unsorted += l.unsorted
    if (l.spend !== null) {
      spend += l.spend
      const c = byCategory.get(l.spentAs.key) ?? { categoryId: l.categoryId, name: l.spentAs.name, cents: 0, ids: new Set<string>() }
      c.cents += l.spend
      c.ids.add(l.txnId)
      byCategory.set(l.spentAs.key, c)
      const key = l.merchant ?? l.descKey
      const m = merchants.get(key) ?? { name: l.merchant ?? l.description, cents: 0, ids: new Set<string>() }
      m.cents += l.spend
      if (l.cents < 0) m.ids.add(l.txnId)
      merchants.set(key, m)
    }
    if (l.income !== null) {
      income += l.income
      // A paycheck by its payer; other income (and Personal's income tax paid from the bank) by category, each payer within.
      const name = l.paycheck ? (l.merchant ?? l.description) : (l.category ?? 'Uncategorized')
      const src = sources.get(name) ?? { cents: 0, paycheck: l.paycheck, payers: new Map() }
      src.cents += l.income
      if (!l.paycheck) {
        const key = l.merchant ?? l.descKey
        const p = src.payers.get(key) ?? { name: l.merchant ?? l.description, cents: 0 }
        p.cents += l.income
        src.payers.set(key, p)
      }
      sources.set(name, src)
    }
  }

  const trendOf = new Map(s.trend.map((m) => [m, { incomeCents: 0, spendCents: 0 }]))
  for (const l of lines) {
    const t = trendOf.get(l.day.slice(0, 7))
    if (!t) continue
    t.spendCents += l.spend ?? 0
    t.incomeCents += l.income ?? 0
  }
  const trend: MonthPoint[] = s.trend.map((month) => ({ month, ...trendOf.get(month)! }))
  // Drop leading empty months so a new install doesn't show a year of zeros.
  while (trend.length > 1 && trend[0].incomeCents === 0 && trend[0].spendCents === 0) trend.shift()

  return {
    incomeBySource: [...sources]
      .filter(([, x]) => x.cents !== 0)
      .sort((a, b) => b[1].cents - a[1].cents)
      .map(([name, x]) => {
        const payers = [...x.payers.values()].filter((p) => p.cents > 0).sort((a, b) => b.cents - a.cents)
        return { name, cents: x.cents, paycheck: x.paycheck, ...(payers.length > 1 ? { parts: payers } : {}) }
      }),
    incomeCents: income,
    spendCents: spend,
    prevSpendCents: within(s.prev).reduce((t, l) => t + (l.spend ?? 0), 0),
    byCategory: [...byCategory.values()]
      .map((c): CategorySpend => ({ categoryId: c.categoryId, name: c.name, cents: c.cents, count: c.ids.size }))
      .filter((c) => c.cents > 0)
      .sort((a, b) => b.cents - a.cents),
    trend,
    topMerchants: [...merchants.values()]
      .filter((m) => m.cents > 0)
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 12)
      .map((m): MerchantSpend => ({ merchant: m.name, cents: m.cents, count: m.ids.size })),
    unsortedCents: unsorted,
    txnCount: txns.size
  }
}
