import * as db from './db'
import { accountTrack, annualized, Composite, dayNum, flowsIn, gainOver, irrOver, maxDrawdown, mwr, numDay, placed, series, twr, volatility, withRecorded, type Balance, type Dated, type Track } from '../shared/returns'
import { TAX_TREATMENTS, type Account, type Holding, type InvestmentAccount, type Investments, type PeriodReturn, type ReturnPeriodId, type Returns, type TaxTreatment } from '../shared/types'

// Most workplace plans don't report cost basis, so it's estimated:
//  - cash and money market funds cost what they're worth;
//  - a fund bought inside the account costs what its purchases add up to;
//  - otherwise the account's money in (contributions and rollovers, with
//    paychecks from before the bank history began filled in from the
//    contribution plan) is spread over its remaining funds.
// An ESPP with no positions is held as the company's stock, and a balance
// beyond the reported positions is cash.

type Plan = ReturnType<typeof db.listContributionRows>[number]
type Activity = ReturnType<typeof db.accountActivity>[number] & { kind: string | null }

const CASH_SYMBOLS = new Set(['SPAXX', 'FDRXX', 'FZFXX', 'SPRXX', 'FCASH', 'CORE', 'SWVXX', 'SNVXX', 'SNSXX', 'VMFXX', 'VMRXX', 'VUSXX', 'TTTXX'])
const CASH_NAME = /money market|cash reserves|government cash|core position|sweep|^cash$/i
// Activity that isn't new money: earnings, fees, and moves between funds inside the account.
const NOT_MONEY_IN = /dividend|interest|gain|earnings|redemption|reinvest|fee|exchange|purchase|sale\b|sold|bought|transfer of assets between/i
const BOUGHT = /purchase|reinvest|bought/i

const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const daysApart = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000
const isCash = (h: Holding): boolean => (!!h.symbol && CASH_SYMBOLS.has(h.symbol.toUpperCase())) || CASH_NAME.test(h.description)
const total = (xs: Dated[]): number => xs.reduce((s, x) => s + x.cents, 0)

/** An account's settled transactions, oldest first, with the payee and the bank's description together for matching, and the category's kind. */
const activity = (accountId: string): Activity[] =>
  db.all<Activity>(
    `SELECT date(${db.localSql('t.posted')}) AS day, t.amount_cents AS cents, COALESCE(t.merchant, '') || ' | ' || t.description AS text, c.kind AS kind
     FROM ${db.TXN_LINES} t LEFT JOIN categories c ON c.id = t.category_id WHERE t.account_id = ? AND t.pending = 0 ORDER BY t.posted`,
    accountId
  )

/** A paycheck's contribution under the plan (the election in effect that day) plus the match. */
const paycheckCents = (plan: Plan, day: string): number =>
  (plan.nextFrom && plan.nextEmployeeCents !== null && day >= plan.nextFrom ? plan.nextEmployeeCents : (plan.employeeCents ?? 0)) + (plan.matchCents ?? 0)

/** The paycheck plan feeding an account: the one linked to it, or the one whose employer is in its name. */
export function planFor(a: Account, treatment: TaxTreatment, plans: Plan[]): Plan | undefined {
  const linked = plans.find((p) => p.accountId === a.id)
  if (linked) return linked
  const name = a.name.toLowerCase()
  const fits = plans.filter((p) =>
    p.kind === 'hsa' ? treatment === 'hsa' : p.kind === 'espp' ? /espp/.test(name) : /401|403|457/.test(name) && (p.kind === 'roth_401k') === /roth/.test(name)
  )
  const byEmployer = fits.find((p) => name.includes(p.name.toLowerCase().split(/\s+/)[0]))
  if (byEmployer) return byEmployer
  return fits.length === 1 && (fits[0].kind === 'hsa' || fits[0].kind === 'espp') ? fits[0] : undefined
}

/** New money into the account in its bank history; a fund switch reports both legs, which cancel. */
function moneyIn(rows: Activity[]): number {
  const outs = rows.filter((r) => r.cents < 0)
  let total = 0
  for (const r of rows) {
    if (r.cents <= 0 || NOT_MONEY_IN.test(r.text)) continue
    const leg = outs.findIndex((o) => o.cents === -r.cents && daysApart(o.day, r.day) <= 3)
    if (leg >= 0) outs.splice(leg, 1)
    else total += r.cents
  }
  return total
}

/** Paycheck contributions (yours and the match) from before the account's bank history begins. */
function beforeHistory(a: Account, first: string | null, plan: Plan | undefined): number | null {
  const opened = a.openedDay ?? a.historyFrom
  // History reaches back to the opening: nothing to fill.
  if (first && opened && (first <= opened || daysApart(first, opened) <= 5)) return 0
  if (!plan?.paycheckKey) return null
  const from = plan.startsDay ?? opened ?? '0000-00-00'
  const until = first ? new Date(Date.parse(first) - 86_400_000).toISOString().slice(0, 10) : db.dayKey(db.now())
  const days = db.paycheckDays(plan.paycheckKey, from, until).filter((d) => !plan.endsDay || d <= plan.endsDay)
  return days.reduce((s, d) => s + paycheckCents(plan, d), 0)
}

/** Whether a transaction's text names the position, by its symbol or its fund name. */
function names(h: Holding, text: string): boolean {
  const name = flat(h.description)
  return (!!h.symbol && text.toLowerCase().includes(`(${h.symbol.toLowerCase()})`)) || (name.length > 6 && flat(text).includes(name))
}

/** What a fund's purchases inside the account add up to, when they plausibly cover the whole position. */
function boughtFor(h: Holding, rows: Activity[]): number | null {
  const mine = rows.filter((r) => r.cents < 0 && BOUGHT.test(r.text) && names(h, r.text))
  if (!mine.length) return null
  const cost = mine.reduce((s, r) => s - r.cents, 0)
  return cost >= h.valueCents * 0.5 && cost <= h.valueCents * 2 ? cost : null
}

const PAID_OUT = /dividend|capital gain|sold|sale\b/i

/** The position's money-weighted return from its dated purchases (dividends and sales back out), when they cover it. */
function sinceBuy(h: Holding, rows: Activity[]): Holding['sinceBuy'] {
  if (isCash(h) || boughtFor(h, rows) === null) return null
  const day = db.dayKey(h.asOf)
  const mine = rows.filter((r) => r.day <= day && names(h, r.text) && (r.cents < 0 ? BOUGHT.test(r.text) : PAID_OUT.test(r.text)))
  const from = mine.find((r) => r.cents < 0)?.day
  if (!from || from >= day) return null
  const r = irrOver([...mine, { day, cents: h.valueCents }])
  const days = dayNum(day) - dayNum(from)
  return r === null ? null : { day: from, r: annualized(r, days), annualized: days > 366 }
}

function withCosts(x: InvestmentAccount, plan: Plan | undefined, rows: Activity[]): InvestmentAccount {
  let holdings: Holding[] = x.holdings.map((h) => ({ ...h, costEstimated: false, inferred: false }))
  const asOf = x.account.balanceDate ?? db.now()
  // An ESPP holds the company's stock (payroll money waits as cash until each purchase date).
  const ticker = x.account.name.match(/\b([A-Z]{1,5})\s+ESPP\b/)?.[1]
  if (!holdings.length && ticker && x.valueCents > 0) {
    holdings = [{ symbol: ticker, description: `${plan ? plan.name.replace(/\s*ESPP\b.*/i, '') : ticker} stock`, shares: null, priceCents: null, valueCents: x.valueCents, costCents: null, asOf, costEstimated: true, inferred: true }]
  }
  // A purchase that hasn't settled shows in the fund and still in cash: take the difference out of cash.
  const listed = holdings.reduce((s, h) => s + h.valueCents, 0)
  const pending = holdings.find((h) => isCash(h) && h.valueCents >= listed - x.valueCents)
  if (listed - x.valueCents >= 100 && pending) {
    const excess = listed - x.valueCents
    pending.valueCents -= excess
    if (pending.shares !== null && pending.priceCents === 100) pending.shares = Math.round(pending.shares * 100 - excess) / 100
  }
  // A balance beyond the reported positions is uninvested cash.
  const reported = holdings.reduce((s, h) => s + h.valueCents, 0)
  if (holdings.length && x.valueCents - reported >= 100) {
    holdings.push({ symbol: null, description: 'Cash', shares: null, priceCents: null, valueCents: x.valueCents - reported, costCents: null, asOf, costEstimated: true, inferred: true })
  }
  for (const h of holdings) {
    if (h.costCents !== null) continue
    if (isCash(h)) h.costCents = h.valueCents
    else h.costCents = boughtFor(h, rows)
    if (h.costCents !== null) h.costEstimated = true
  }
  // What's left of the account's money in goes to the funds still without a cost, by value.
  const open = holdings.filter((h) => h.costCents === null)
  if (open.length) {
    const before = beforeHistory(x.account, rows[0]?.day ?? null, plan)
    const total = before === null ? null : before + moneyIn(rows)
    const left = total === null ? 0 : total - holdings.reduce((s, h) => s + (h.costCents ?? 0), 0)
    const openValue = open.reduce((s, h) => s + h.valueCents, 0)
    if (total !== null && left > 0 && openValue > 0) {
      for (const h of open) {
        h.costCents = Math.round((left * h.valueCents) / openValue)
        h.costEstimated = true
      }
    }
  }
  const known = holdings.length > 0 && holdings.every((h) => h.costCents !== null)
  return {
    ...x,
    holdings: holdings.map((h) => ({ ...h, sinceBuy: sinceBuy(h, rows) })),
    costCents: known ? holdings.reduce((s, h) => s + h.costCents!, 0) : null,
    costEstimated: holdings.some((h) => h.costEstimated)
  }
}

// ---------- returns ----------
//
// An account's flows are known from its first bank transaction on, or from its
// plan's first paycheck when that's earlier (paychecks fill in before the bank
// history), or from the day set as known when its flows are recorded from
// statements. Its values are its balances from then on (see accountTrack).

// Money put in or taken out (a flow), dividends and interest (income), or part
// of the return: trades inside the account, fees, gains booked on a switch.
const INCOME = /dividend|interest|earnings|capital gain/i
const INSIDE = /purchase|bought|reinvest|redemption|exchange|sale\b|sold|transfer of assets between|core account|realized ?gain|gain\/loss/i
const FEE = /\bfees?\b/i
const PUT_IN = /contribution|contr\b|rollover|roll over|transfer|deposit|moneylink|employer|match|conversion/i
const TAKEN_OUT = /withdraw|distribution|rollover|roll over|transfer|disburse|conversion|moneylink|\beft\b|\bach\b|wire/i

const PERIODS: ReturnPeriodId[] = ['1M', '3M', 'YTD', '1Y']
/** A period's start this far into the gap between two values is too far from either to place. */
const MAX_GAP_DAYS = 35
/** A period shows when the values reach at least this much of it. */
const MIN_SHARE = 0.9
/** The shortest since-the-start period worth showing. */
const MIN_DAYS = 14
/** Accounts together start once the ones with values hold all but this share. */
const UNTRACKED_SHARE = 0.1

interface Tracked {
  x: InvestmentAccount
  track: Track | null
  income: Dated[]
}

/**
 * Flows and income from an account's own transactions. Unlabeled money in is a
 * paycheck contribution in an account a plan feeds, and otherwise a dividend;
 * unlabeled money out is a fee.
 */
function sortFlows(rows: Activity[], fedByPlan: boolean): { flows: Dated[]; income: Dated[] } {
  const income: Dated[] = []
  const moves: Array<Activity & { labeled: boolean }> = []
  for (const r of rows) {
    if (r.cents > 0 && INCOME.test(r.text)) income.push({ day: r.day, cents: r.cents })
    else if (r.cents === 0 || INSIDE.test(r.text) || FEE.test(r.text)) continue
    else if (r.cents > 0 && r.kind === 'income') income.push({ day: r.day, cents: r.cents })
    else moves.push({ ...r, labeled: (r.cents > 0 ? PUT_IN : TAKEN_OUT).test(r.text) })
  }
  // A move between funds reports both legs, which cancel.
  const outs = moves.filter((m) => m.cents < 0)
  const flows: Dated[] = []
  for (const m of moves.filter((m) => m.cents > 0)) {
    const leg = outs.findIndex((o) => o.cents === -m.cents && daysApart(o.day, m.day) <= 3)
    if (leg >= 0) outs.splice(leg, 1)
    else if (m.labeled || fedByPlan) flows.push({ day: m.day, cents: m.cents })
    else income.push({ day: m.day, cents: m.cents })
  }
  for (const o of outs) if (o.labeled) flows.push({ day: o.day, cents: o.cents })
  return { flows, income }
}

/** The first day the account's flows are known, the flows (with the recorded ones), and the income. */
function accountFlows(rows: Activity[], plan: Plan | undefined, recorded: Dated[], knownFrom: string | undefined, today: string): { since: string | null; flows: Dated[]; income: Dated[] } {
  const own = sortFlows(rows, !!plan)
  const firstOwn = rows[0]?.day ?? null
  const until = firstOwn ? numDay(dayNum(firstOwn) - 1) : today
  const paid = plan?.paycheckKey
    ? db
        .paycheckDays(plan.paycheckKey, plan.startsDay ?? '0000-00-00', until)
        .filter((d) => !plan.endsDay || d <= plan.endsDay)
        .sort()
        .map((d) => ({ day: d, cents: paycheckCents(plan, d) }))
    : []
  const since = [paid[0]?.day, firstOwn, knownFrom].filter((d): d is string => !!d).sort()[0] ?? null
  return { since, flows: [...paid, ...withRecorded(own.flows, recorded)], income: own.income }
}

/** Every balance known for the account (not estimates), with a synced account's current balance. */
function balances(a: Account): Balance[] {
  const points: Balance[] = db
    .listBalancePoints(a.id)
    .filter((p) => p.source !== 'estimate')
    .map((p) => ({ day: p.day, cents: p.cents, synced: p.source === 'sync' }))
  if ((a.source !== 'simplefin' && a.source !== 'plaid') || a.balanceCents === null || !a.balanceDate) return points
  const day = db.dayKey(a.balanceDate)
  return [...points.filter((p) => p.day !== day), { day, cents: a.balanceCents, synced: true }]
}

/** The calendar start of a period ending today. */
function periodStart(id: ReturnPeriodId, today: string): string {
  if (id === 'YTD') return `${Number(today.slice(0, 4)) - 1}-12-31`
  const months = id === '1M' ? 1 : id === '3M' ? 3 : 12
  const [y, m, d] = today.split('-').map(Number)
  // The same day of the month, or the month's last day when it's shorter.
  const lastDay = new Date(Date.UTC(y, m - months, 0)).getUTCDate()
  return numDay(Date.UTC(y, m - 1 - months, Math.min(d, lastDay)) / 86_400_000)
}

type Measured = Pick<PeriodReturn, 'twr' | 'mwr' | 'gainCents' | 'incomeCents' | 'flowCents'>

/** The periods from `first` to `end` whose start the values cover, each measured from its start. */
function periods(first: string, end: string, today: string, covers: (from: string) => boolean, measure: (from: string) => Measured): PeriodReturn[] {
  const out: PeriodReturn[] = []
  const add = (period: ReturnPeriodId, from: string): void => {
    const days = dayNum(end) - dayNum(from)
    if (from < first || days <= 0 || (period !== 'All' && days < MIN_SHARE * (dayNum(today) - dayNum(from))) || !covers(from)) return
    const m = measure(from)
    if (m.twr === null) return
    out.push({ period, from, to: end, annualized: days > 366, ...m, twr: annualized(m.twr, days), mwr: m.mwr === null ? null : annualized(m.mwr, days) })
  }
  for (const p of PERIODS) add(p, periodStart(p, today))
  if (dayNum(end) - dayNum(first) >= MIN_DAYS) add('All', first)
  return out
}

function accountReturns(t: Track, income: Dated[], today: string): Returns {
  const first = t.points[0].day
  const end = t.points[t.points.length - 1].day
  const s = series(t)
  return {
    periods: periods(first, end, today, (from) => placed(t, from, MAX_GAP_DAYS), (from) => ({
      twr: twr(t, from, end),
      mwr: mwr(t, from, end),
      gainCents: gainOver(t, from, end) ?? 0,
      incomeCents: total(flowsIn(income, from, end)),
      flowCents: total(flowsIn(t.flows, from, end))
    })),
    volatility: volatility(s),
    maxDrawdown: maxDrawdown(s)
  }
}

/**
 * Whether accounts held together can be measured from a day: they hold money at its end (`cents`, each one's), and
 * those whose values place the day (on a value, or inside a gap of at most MAX_GAP_DAYS between two) hold all but a
 * tenth of it. So money with no track of its own, an old plan known only by its statements, never drops out of a
 * return the others make alone.
 */
function covered(members: ReadonlyArray<{ track: Track | null; cents: number }>, day: string): boolean {
  let all = 0
  let untracked = 0
  for (const m of members) {
    const v = Math.max(0, m.cents)
    all += v
    if (!m.track || !placed(m.track, day, MAX_GAP_DAYS)) untracked += v
  }
  return all > 0 && untracked <= UNTRACKED_SHARE * all
}

/** Accounts together, over periods whose start the accounts with values there cover all but a tenth of the money. */
function groupReturns(members: Tracked[], today: string, valueOn: (day: string) => Map<string, number>): Returns | null {
  const tracked = members.filter((m): m is Tracked & { track: Track } => m.track !== null)
  if (!tracked.length) return null
  const firstOf = (t: Track): string => t.points[0].day
  const lastOf = (t: Track): string => t.points[t.points.length - 1].day
  const covers = (day: string): boolean => {
    const values = valueOn(day)
    return covered(
      members.map((m) => ({ track: m.track, cents: values.get(m.x.account.id) ?? 0 })),
      day
    )
  }
  // The first known value that covers the money (an account starting empty covers nothing on its first day).
  const start = [...new Set(tracked.flatMap((m) => m.track.points.map((p) => p.day)))].sort().find(covers)
  if (!start) return null
  const c = new Composite(tracked.map((m) => m.track))
  const end = c.last!
  const income = (from: string): number =>
    tracked.reduce((s, m) => {
      const a = from > firstOf(m.track) ? from : firstOf(m.track)
      const b = end < lastOf(m.track) ? end : lastOf(m.track)
      return s + (a < b ? total(flowsIn(m.income, a, b)) : 0)
    }, 0)
  const s = c.series(start, end)
  return {
    periods: periods(start, end, today, covers, (from) => ({ twr: c.twr(from, end), mwr: c.mwr(from, end), gainCents: c.gain(from, end), incomeCents: income(from), flowCents: c.flows(from, end) })),
    volatility: volatility(s),
    maxDrawdown: maxDrawdown(s)
  }
}

/**
 * An account's values and the money put in or taken out, linked as its returns measure them (accountTrack): what its
 * gain over any days and its time-weighted return are read from. Null when its values and flows make no track.
 */
export function investedTrack(a: Account): Track | null {
  const today = db.dayKey(db.now())
  const plan = planFor(a, db.taxTreatment(a), db.listContributionRows())
  const rows = activity(a.id)
  const recorded = db.listRecordedFlows(a.id).map((r) => ({ day: r.day, cents: r.cents }))
  const f = accountFlows(rows, plan, recorded, db.flowsKnownFrom().get(a.id), today)
  return f.since ? accountTrack(balances(a), f.flows, f.since) : null
}

/**
 * An account's gain from `from` (null: its first value) to `to`, within the span its values
 * cover, as its returns measure it: the change in value less the money put in, so dividends and
 * interest are part of it and contributions and withdrawals are not. Null when its values and
 * flows make no track.
 */
export function accountGain(a: Account, from: string | null, to: string): number | null {
  const t = investedTrack(a)
  if (!t) return null
  const first = t.points[0].day
  const last = t.points[t.points.length - 1].day
  const start = from && from > first ? from : first
  const end = to < last ? to : last
  return start < end ? gainOver(t, start, end) : null
}

/**
 * An account's gain over each span between one day of `bounds` and the next ((bounds[i - 1], bounds[i]], so one
 * fewer than the days), measured as accountGain measures one, from one track: a month's returns, month after month.
 */
export function accountGains(a: Account, bounds: string[]): Array<number | null> {
  if (bounds.length < 2) return []
  return gainsOn(investedTrack(a), bounds)
}

/** A track's gain over each span between one day of `bounds` and the next, as accountGains reads them; null where its values don't reach. */
export function gainsOn(t: Track | null, bounds: string[]): Array<number | null> {
  if (bounds.length < 2) return []
  if (!t) return bounds.slice(1).map(() => null)
  const first = t.points[0].day
  const last = t.points[t.points.length - 1].day
  return bounds.slice(1).map((to, i) => {
    const from = bounds[i]
    const start = from > first ? from : first
    const end = to < last ? to : last
    return start < end ? gainOver(t, start, end) : null
  })
}

/**
 * Returns by how they are taxed (spec 1.7, the Growth drill): each account's return added up by its tax treatment, in
 * the order TAX_TREATMENTS lists them, a treatment no account has left out. Its return over the span and its run rate,
 * so the treatments add up to the accounts' to the cent; a return that can't be measured (null) adds nothing. A stake
 * (private) has no return of its own and is never here.
 */
export function returnsByTreatment(accounts: ReadonlyArray<{ treatment: TaxTreatment; actualCents: number | null; runRateCents: number | null }>): Array<{ treatment: TaxTreatment; actualCents: number; runRateCents: number }> {
  return TAX_TREATMENTS.filter((t) => t.id !== 'private' && accounts.some((a) => a.treatment === t.id)).map((t) => {
    const mine = accounts.filter((a) => a.treatment === t.id)
    return { treatment: t.id, actualCents: mine.reduce((s, a) => s + (a.actualCents ?? 0), 0), runRateCents: mine.reduce((s, a) => s + (a.runRateCents ?? 0), 0) }
  })
}

/**
 * A track over (from, to] alone: its values from the last on or before `from` to the first on or after `to`, the
 * sub-periods between them and their flows. Every day inside has the value and the daily rate the whole track gives
 * it, so returns over those days are the same, read over a year's values instead of the account's whole history.
 */
function within(t: Track, from: string, to: string): Track | null {
  const a = Math.max(0, t.points.findLastIndex((p) => p.day <= from))
  const found = t.points.findIndex((p) => p.day >= to)
  const b = found < 0 ? t.points.length - 1 : found
  if (b <= a) return null
  const points = t.points.slice(a, b + 1)
  return { points, subs: t.subs.slice(a, b), flows: flowsIn(t.flows, points[0].day, points[points.length - 1].day) }
}

/**
 * The time-weighted return of accounts held together over (from, to] (spec 1.7, Growth's 12-month TWR), as the
 * Investments page measures every account together: each day's return is the accounts' own, weighted by what each
 * held as the day began, chained over the days; a sub-period between two values compounds evenly by day. So money put
 * in or taken out moves no return, and an account counts from its first value to its last. Each member's `cents` is
 * what it held as `from` ended. Null unless the days can be measured as the Investments page's periods are: the
 * accounts with values on `from` hold all but a tenth of the money there (an account with no track of its own, an old
 * plan known only by its statements, is money they don't cover), and the values reach nine tenths of the way to `to`.
 * A fraction (0.05 is 5%).
 */
export function twrTogether(members: ReadonlyArray<{ track: Track | null; cents: number }>, from: string, to: string): number | null {
  if (!covered(members, from)) return null
  const clipped = members.map((m) => (m.track ? within(m.track, from, to) : null)).filter((t): t is Track => t !== null)
  const c = new Composite(clipped)
  const last = c.last
  if (!last || dayNum(last) - dayNum(from) < MIN_SHARE * (dayNum(to) - dayNum(from))) return null
  return c.twr(from, to)
}

/** The account's own transactions that its returns take as money put in or taken out, which its gain leaves out. */
export function accountMoves(a: Account): Dated[] {
  const plan = planFor(a, db.taxTreatment(a), db.listContributionRows())
  return sortFlows(activity(a.id), !!plan).flows
}

/** The same view with the returns left out: holdings and balances are free; the returns table is Plus. */
export const withoutReturns = (inv: Investments): Investments => ({ ...inv, accounts: inv.accounts.map((a) => ({ ...a, returns: null })), returns: [] })

/**
 * Investment accounts with positions, cost basis (reported or estimated) and
 * returns, and returns for every account together and by tax treatment. A
 * stake's cost is what was put in; stakes have no returns.
 */
export function investments(): Investments {
  const raw = db.getInvestments()
  const plans = db.listContributionRows()
  const today = db.dayKey(db.now())
  const recorded = db.listRecordedFlows()
  const knownFrom = db.flowsKnownFrom()
  const all: Tracked[] = raw.accounts.map((x) => {
    if (x.treatment === 'private') return { x: { ...x, costCents: x.account.costCents, costEstimated: false, returns: null }, track: null, income: [] }
    const plan = planFor(x.account, x.treatment, plans)
    const rows = activity(x.account.id)
    const mine = recorded.filter((r) => r.accountId === x.account.id).map((r) => ({ day: r.day, cents: r.cents }))
    const f = accountFlows(rows, plan, mine, knownFrom.get(x.account.id), today)
    const track = f.since ? accountTrack(balances(x.account), f.flows, f.since) : null
    return { x: { ...withCosts(x, plan, rows), returns: track ? accountReturns(track, f.income, today) : null }, track, income: f.income }
  })
  const liquid = all.filter((m) => m.x.treatment !== 'private')
  const ids = liquid.map((m) => m.x.account.id)
  const values = new Map<string, Map<string, number>>()
  const valueOn = (day: string): Map<string, number> => {
    if (!values.has(day)) values.set(day, db.balancesOn(ids, day))
    return values.get(day)!
  }
  const groups: Array<{ id: 'all' | TaxTreatment; members: Tracked[] }> = [
    { id: 'all', members: liquid },
    ...TAX_TREATMENTS.filter((t) => t.id !== 'private').map((t) => ({ id: t.id, members: liquid.filter((m) => m.x.treatment === t.id) }))
  ]
  return {
    ...raw,
    accounts: all.map((m) => m.x),
    returns: groups.flatMap((g) => {
      const r = g.members.length ? groupReturns(g.members, today, valueOn) : null
      return r ? [{ id: g.id, returns: r }] : []
    })
  }
}
