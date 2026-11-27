import * as db from './db'
import { fromPayroll, lineOwner, payrollKeys, periodOn, placedBucket, residences, usePeriods, type Residences, type UsePeriod } from './owners'
import { loadPolicies } from './policies'
import { cadenceOf, CHECKS_A_YEAR, latestRun, onScheduleDay } from './cadence'
import { CADENCES, detectRecurring, recurringHistory } from './recurring'
import { tripAt, tripWindows, type TripWindow } from './trips'
import { LEG_DAYS, PROCEEDS_DAYS, PURCHASE_DAYS } from './windows'
import { categoryRole, type CategoryRole } from '../shared/categoryRole'
import { payeeKey, payeeName, payrollKey, type Payee } from '../shared/payroll'
import { addDays, daysBetween, daysInMonth, isRealDay, shiftMonth } from '../shared/zone'
import type { Account, AssetType, BucketKind, ClassifiedLine, LineClass, LinePage, LineQuery, RecurringSeries, VentureIntent, VentureShare } from '../shared/types'
// ventureMoney.ts reads the classifier's lines and this reads its inferences: each calls the other only from inside
// its functions, never as it loads, so the two can import each other.
import { inferIntents, unitKey, type BoundaryUnit, type IntentPart } from './ventureMoney'

// The owner rule (owners.ts) and the payee keys (shared/payroll.ts) live apart so that db.ts and
// recurring.ts can read them without importing the classifier; they are the classifier's too.
export { lineOwner, payrollKeys, residences, type OwnerLine, type Residences } from './owners'
export { payeeKey, payrollKey, type Payee } from '../shared/payroll'

// ---------- the classifier ----------

// Every line of the ledger gets one class, for the Personal waterfall. The ledger for a month is every
// line on a perimeter account (the month's Personal cash and card accounts), whatever its owner, and
// every Personal line on a cash or card account a venture holds. The first rule that applies:
//   0. Money between Personal and a venture that Review or the user said what it is (waterfall spec addendum 1.11):
//      a boundary line's intent parts (venture_money) take their intents' classes. A transfer to or from a venture's
//      account, a venture's cost or revenue paid from or into Personal's cash and cards, or another line Review tied
//      to a venture is replaced by its parts, as a bonus is split from a paycheck; a Personal line a venture's cash
//      or card paid keeps its class from the rules below and gains parts for its funding (:fund), minus the line (or
//      minus Personal's use share of it), on the venture's account. A boundary line with no intent is unset: rules 1
//      to 12 class it as they always have.
//   1. A venture's line on a perimeter account is venture.
//   2. A transfer, or a line paired with another leg, takes its class from the other side: another
//      perimeter account internal, a Personal investment, retirement or HSA account invested, a
//      Personal debt a payment (split into interest and principal) or money borrowed (principal), a
//      Personal asset capital, a venture's account venture, a hidden account orphan. With no leg, a
//      payment found by a debt's payment key is split the same way, money in that matches a rise in
//      what a Personal debt owes is borrowed, and a large line in an asset's capital window is capital;
//      the rest are orphans. A line Review marked as capital skips this rule.
//   3. A line Review marked as capital, or a large one in an asset's capital window, is capital.
//   4. Money in: pay from a payroll (bonus by its paystub, or beyond its schedule or size), interest and dividends
//      cashReturn, a tax refund tax, a one-time, reimbursed, gifted or sold income oneOffIncome, any
//      other income income.
//   5. Income tax paid is tax.
//   6. A debt payment filed as spending (a mortgage in Housing), found by the debt's payment key, is
//      split into interest and principal.
//   7. Fees and interest on a credit card are debtCost.
//   8. A payment of a Personal bill, loan or subscription series, or of another series once
//      confirmed, is committed.
//   9. Anything flagged one-time or bought on a trip is oneOff.
//  10. Uncategorized is unsorted, in or out.
//  11. In a category that is a one-off by default, everyday when it's a habit, else oneOff.
//  12. Any other spending is everyday; a refund takes its category's class.
//
// A loan payment is split by the debt's balances (loanSplit): the principal paid between two known
// balances is what the debt went down by, plus what was borrowed on it between them, shared over the
// payments between them; the rest of each payment is interest and escrow (debtCost). A cost the legacy
// residence clause makes Personal (owners.ts) that pays a loan on the venture's place keeps its principal with
// the venture.
//
// A line can be an asset's cost: a payment on a loan linked to it, a line an asset rule or a hand put on it,
// a cost the rules placed in a venture that holds that one property or vehicle, or, when Personal holds just
// one house or one vehicle, a Personal cost of its kind (housing and utilities, or fuel, upkeep and the
// insurance its policy matches). On a day the asset's uses
// cover (rooms rented in a house the user lives in, a car driven partly for a business), the cost is shared:
// a loan payment's interest and escrow, or the whole of any other cost, go to each owner by its use share, and
// the principal goes whole to the loan's owner. Use shares cost; ownership keeps value, gain and principal.
// A home the user lived in while a venture held it is Personal's use of it: migration 41 turned each venture's
// residence dates into a use of 100% Personal over them and put the costs in them on the house, so the lines
// those dates made Personal are Personal's by the use, with the same classes and amounts.

/**
 * The engine's version: when the classifier's rules or the arithmetic of the rows change, months closed under an
 * earlier one show as changed, with cause engine (spec 2, Silent rewrites). It is in the inputs stamp, so every
 * closed month is read again under a new one. 2, one bump for the unreleased changes: a payroll's checks a year
 * and a series' cadence are told by the days they land on (cadence.ts), a check moved for a bank holiday as for a
 * weekend, so a closed month's Gross pay and Take-home run rates, its tolerance, and the Committed run rate of a
 * bill paid twice a month can differ from version 1's; a payroll's run rates read only its checks on a new
 * schedule, and not a first check that pays part of a period or the old schedule's last (paystubs.ts), and a check
 * off schedule is judged by the schedule its checks kept when it came, not today's series, with the checks before
 * a new schedule counted as checks on it in the typical check; and (sub-phase 1i) a payee's series is judged on
 * the 400 days before its own latest payment, not before today, so a closed month's lines no longer move as time
 * passes, and its category and kind are its latest filed payment's, so a new charge that arrives with no category
 * yet doesn't move them. 3 (sub-phase 1j, also unreleased): net worth counts each venture's position (its claims and
 * the share of its net assets, or a Stakes account's estimate) in place of its accounts, so a close freezes each
 * venture's position at the bridge's start and end (NetWorthBridge.ventures) in its rows digest, and a leg on a
 * Stakes account linked to a venture is money to or from that venture; money between Personal and a venture takes
 * the classes of the intents Review or the user gives it (rule 0), and pay landing on a venture's account stays
 * Personal's (the paycheck clause, owners.ts). With every share migrated and no intent given, what moves is a
 * paycheck on a venture's account, and the lines the five safe inferences give an intent (ventureMoney.ts): support
 * to someone the user supports and owns none of (a gift), pay from a venture's own payroll (salary), a cost one side
 * paid for the other and the transfer the other way that pays it back (reimbursements), and transfers back from a
 * venture as much as in each of the 2 months before (regular draws).
 */
export const ENGINE_VERSION = 3

const DAY = 86_400
const CASH_AND_CARDS = new Set<AssetType>(['cash', 'credit_card'])
const INVESTED = new Set<AssetType>(['investment', 'retirement'])
const DEBTS = new Set<AssetType>(['loan', 'mortgage', 'other_debt'])
/** Assets bought and sold with cash: property, vehicles, other assets, money lent and stakes (type venture). */
const ASSETS = new Set<AssetType>(['property', 'vehicle', 'other_asset', 'receivable', 'venture'])
/** budget.ts's default one-off tier (DEFAULT_TIER), by name. */
const ONE_OFF_BY_DEFAULT = new Set(['shopping', 'travel', 'gifts & donations', 'education', 'other'])
const COMMITTED_KINDS = new Set<RecurringSeries['kind']>(['bill', 'loan', 'subscription'])
/** Interest and dividends paid on cash, as banks describe them. */
const RETURNS = /interest paid|interest earned|dividend/i
/** Income that doesn't recur, by its category or a tag: a reimbursement, a gift, a sale. */
const ONE_OFF_INCOME = /reimburs|\bgift|\bsale\b|\bsold\b/i
/** The smallest line a capital window takes: $500, or a tenth of the window's cap when that's more. */
const CAPITAL_FLOOR = 50_000
/** Classes a capital window never takes a line from: pay, a commitment, interest earned. */
const ROUTINE = new Set<LineClass>(['pay', 'committed', 'cashReturn'])

/** An account as the classifier reads it. */
interface Acct {
  type: AssetType
  hidden: boolean
  bucketId: number | null
  openedDay: string | null
  closedDay: string | null
  /** a cash account kept as an HSA: money saved, not spent from */
  hsa: boolean
  account: Account
}

/** A line as the classifier reads it. */
interface Line extends Payee {
  id: string
  splitId: number | null
  accountId: string
  posted: number
  day: string
  cents: number
  categoryId: number | null
  category: string | null
  kind: string | null
  description: string
  bucketId: number | null
  bucketSource: string | null
  ownBucket: number
  oneTime: number
  capitalAssetId: string | null
  /** the asset an asset rule or a hand put the line on, and which: 'rule', or 'user', 'ai' or 'migrated' by hand (null asset and a hand's source: taken off by hand) */
  assetId: string | null
  assetSource: string | null
  owner: number | null
  /** the venture rules 1 to 3 name, before the residence clause made the line Personal */
  placed: number | null
  perimeter: boolean
  /** on a visible cash or card account a venture holds */
  held: boolean
  /** in the ledger: on a perimeter account, or Personal on a cash or card account a venture holds */
  ledger: boolean
}

/** A line's own id: its transaction's, and its part's when it's split. */
const lineId = (l: Pick<Line, 'id' | 'splitId'>): string => `${l.id}:${l.splitId ?? ''}`
const byPosting = (x: Line, y: Line): number => x.posted - y.posted || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0) || (x.splitId ?? 0) - (y.splitId ?? 0)

const acctOf = (a: Account): Acct => ({ type: a.assetType, hidden: a.hidden, bucketId: a.bucketId, openedDay: a.openedDay, closedDay: a.closedDay, hsa: a.assetType === 'cash' && db.taxTreatment(a) === 'hsa', account: a })

function accountsById(): Map<string, Acct> {
  return new Map(db.listAccounts().map((a) => [a.id, acctOf(a)]))
}

const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

/** One of a month's Personal cash and card accounts: visible, in no venture, open on a day of the month, and not an HSA kept as cash. */
function inPerimeter(a: Acct, month: string): boolean {
  return !a.hidden && a.bucketId === null && CASH_AND_CARDS.has(a.type) && !a.hsa && (!a.openedDay || a.openedDay <= lastDayOf(month)) && (!a.closedDay || a.closedDay >= `${month}-01`)
}

/**
 * A month's perimeter (YYYY-MM): the Personal cash and card accounts the waterfall starts from, of `accounts` when
 * the caller has them. An account closed since keeps its past months.
 */
export function perimeter(month: string, accounts: Account[] = db.listAccounts()): string[] {
  return accounts.filter((a) => inPerimeter(acctOf(a), month)).map((a) => a.id)
}

/** What the owner rule reads beside a line: the accounts, the residences and the payrolls (the paycheck clause). */
type Owners = Pick<Ctx, 'accts' | 'homes' | 'payroll'>

/** The lines a condition on TXN_LINES (as t) picks, oldest first, with their owners and whether they're in the ledger. */
function loadLines({ accts, homes, payroll }: Owners, where: string, ...params: Array<string | number>): Line[] {
  const rows = db.all<Omit<Line, 'owner' | 'placed' | 'perimeter' | 'held' | 'ledger'>>(
    `SELECT t.id, t.split_id AS splitId, t.account_id AS accountId, t.posted, date(${db.localSql('t.posted')}) AS day, t.amount_cents AS cents,
            t.category_id AS categoryId, c.name AS category, c.kind, t.merchant, t.desc_key AS descKey, t.description,
            t.bucket_id AS bucketId, t.bucket_source AS bucketSource, COALESCE(s.own_bucket, 0) AS ownBucket, t.one_time AS oneTime,
            t.capital_asset_id AS capitalAssetId, t.asset_id AS assetId, t.asset_source AS assetSource
     FROM ${db.TXN_LINES} t LEFT JOIN transaction_splits s ON s.id = t.split_id LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${where}
     ORDER BY t.posted, t.id, t.split_id`,
    ...params
  )
  return rows.map((r) => {
    const a = accts.get(r.accountId)
    const o = { ownBucket: r.ownBucket === 1, bucketId: r.bucketId, bucketSource: r.bucketSource, accountBucketId: a?.bucketId ?? null }
    const owner = lineOwner({ ...o, day: r.day, income: r.kind === 'income', uncategorized: r.categoryId === null, cents: r.cents, merchant: r.merchant, descKey: r.descKey }, homes, payroll)
    const perimeter = !!a && inPerimeter(a, r.day.slice(0, 7))
    const held = !!a && !a.hidden && a.bucketId !== null && CASH_AND_CARDS.has(a.type)
    return { ...r, owner, placed: placedBucket(o), perimeter, held, ledger: perimeter || (held && owner === null) }
  })
}

/** Lines posted from one unix time to another. */
const linesPosted = (owners: Owners, from: number, to: number, inflowsOnly = false): Line[] =>
  loadLines(owners, `t.posted >= ? AND t.posted < ?${inflowsOnly ? ' AND t.amount_cents > 0' : ''}`, from, to)

/** What every part of the classifier reads: the accounts, the residences, the payrolls, each transfer's other leg and the assets' uses. */
interface Ctx {
  accts: Map<string, Acct>
  homes: Residences
  /** payrollKeys(): the payees pay comes from */
  payroll: Set<string>
  pairOf: Map<string, db.TransferLeg>
  uses: Map<string, UsePeriod[]>
  /** each Stakes account linked to a venture, and its venture: money to or from one is the venture's, never capital */
  stakes: Map<string, number>
}

function context(): Ctx {
  // Legs over every day: a debt's payments and borrowing are counted over all of them.
  return { accts: accountsById(), homes: residences(), payroll: payrollKeys(), pairOf: db.transferPairs('0000-01-01', '9999-12-31').pairOf, uses: usePeriods(), stakes: db.linkedStakes() }
}

// ---------- uses ----------

/** Asset types whose costs can be shared by use: a house, a vehicle, another asset. */
const COSTED = new Set<AssetType>(db.COSTED_ASSETS)

/**
 * Shares cents over owners by their basis points, in the order a use period lists them (ventures by id, Personal
 * last): each owner but the last gets sign × floor((|cents| × bp + 5000) / 10000), its share rounded half away
 * from zero, and the last gets the rest, so the parts add up to the cents exactly.
 */
export function fanOut(cents: number, owners: ReadonlyArray<{ owner: number | null; bp: number }>): Array<{ owner: number | null; bp: number; cents: number }> {
  const sign = cents < 0 ? -1 : 1
  let left = cents
  return owners.map((o, i) => {
    const part = i === owners.length - 1 ? left : sign * Math.floor((Math.abs(cents) * o.bp + 5000) / 10000)
    left -= part
    return { owner: o.owner, bp: o.bp, cents: part }
  })
}

const legOf = (ctx: Ctx, l: Line): db.TransferLeg | undefined => (l.splitId === null ? ctx.pairOf.get(l.id) : undefined)

// ---------- debts ----------

/** A debt as the classifier reads it. */
interface Debt {
  id: string
  /** the venture that owns it: its own, or its linked asset's (a loan goes with what secures it); null Personal */
  owner: number | null
  linkedAssetId: string | null
  openedDay: string | null
  apr: number | null
  escrowCents: number
  paymentKey: string | null
  /** known balances, oldest first, as amounts owed; a closed debt owes nothing from its closing day */
  anchors: Array<{ day: string; owed: number }>
}

/** A line's link to a debt: a payment to it, or money borrowed on it. */
interface DebtLink {
  debtId: string
  kind: 'payment' | 'borrowing'
}

/** A loan payment's parts, each positive: principal, interest and escrow. Estimated when no bracket of known balances measured it. */
export interface LoanSplit {
  principalCents: number
  interestCents: number
  escrowCents: number
  estimated: boolean
}

/** Every visible debt with the lines linked to it (oldest first), and each payment's split. */
interface DebtBook {
  debts: Map<string, Debt>
  links: Map<string, DebtLink>
  lines: Map<string, Line[]>
  splits: Map<string, LoanSplit>
}

/** The lines that pay or borrow on each debt, and each payment's interest and principal. */
function debtBook(ctx: Ctx): DebtBook {
  const book: DebtBook = { debts: new Map(), links: new Map(), lines: new Map(), splits: new Map() }
  for (const [id, a] of ctx.accts) {
    if (!DEBTS.has(a.type) || a.hidden) continue
    const x = a.account
    const asset = x.linkedAssetId ? ctx.accts.get(x.linkedAssetId) : undefined
    book.debts.set(id, { id, owner: x.bucketId ?? asset?.bucketId ?? null, linkedAssetId: x.linkedAssetId, openedDay: x.openedDay ?? asset?.openedDay ?? null, apr: x.apr, escrowCents: x.escrowCents ?? 0, paymentKey: x.paymentKey, anchors: [] })
  }
  if (!book.debts.size) return book
  const ids = [...book.debts.keys()]
  for (const r of db.all<{ id: string; day: string; cents: number }>(`SELECT account_id AS id, day, balance_cents AS cents FROM balance_snapshots WHERE account_id IN (${ids.map(() => '?').join(',')}) ORDER BY account_id, day`, ...ids)) {
    const d = book.debts.get(r.id)!
    if (!d.openedDay || r.day >= d.openedDay) d.anchors.push({ day: r.day, owed: -r.cents })
  }
  for (const d of book.debts.values()) {
    const closed = ctx.accts.get(d.id)!.closedDay
    if (!closed) continue
    d.anchors = [...d.anchors.filter((p) => p.day < closed), { day: closed, owed: 0 }]
  }

  // Payments and borrowing by the other leg: a transfer to or from the debt's own account.
  const legged = [...ctx.pairOf].filter(([, leg]) => book.debts.has(leg.accountId)).map(([id]) => id)
  const found = new Map<string, Line>()
  for (let i = 0; i < legged.length; i += 500) {
    const chunk = legged.slice(i, i + 500)
    for (const l of loadLines(ctx, `t.split_id IS NULL AND t.id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) found.set(lineId(l), l)
  }
  // Payments by the payee key: a mortgage paid as Housing, a car loan as a transfer with no other side.
  const byPayee = new Map<string, string>()
  for (const d of book.debts.values()) if (d.paymentKey && !byPayee.has(d.paymentKey)) byPayee.set(d.paymentKey, d.id)
  const payees = [...byPayee.keys()].map((k) => k.slice(0, -2))
  if (payees.length) {
    for (const l of loadLines(ctx, `t.amount_cents < 0 AND lower(trim(COALESCE(t.merchant, t.desc_key))) IN (${payees.map(() => '?').join(',')})`, ...payees)) {
      if (!found.has(lineId(l))) found.set(lineId(l), l)
    }
  }
  const link = (l: Line, debtId: string, kind: DebtLink['kind']): void => {
    book.links.set(lineId(l), { debtId, kind })
    const list = book.lines.get(debtId)
    if (list) list.push(l)
    else book.lines.set(debtId, [l])
  }
  for (const l of [...found.values()].sort(byPosting)) {
    const leg = legOf(ctx, l)
    if (leg) {
      if (book.debts.has(leg.accountId)) link(l, leg.accountId, l.cents < 0 ? 'payment' : 'borrowing')
      continue
    }
    const debtId = byPayee.get(payeeKey(l))
    if (debtId && l.accountId !== debtId) link(l, debtId, 'payment')
  }

  // Money borrowed with no other side (a loan deposited, a draw): money in filed as a transfer, within LEG_DAYS of a
  // rise in what a Personal debt owes between two known balances, or at its opening. A rise can hold what was paid
  // on the debt between them as well.
  const rises: Array<{ debtId: string; from: string; to: string; left: number }> = []
  for (const d of book.debts.values()) {
    if (d.owner !== null) continue
    const points = d.openedDay && (!d.anchors.length || d.anchors[0].day >= d.openedDay) ? [{ day: addDays(d.openedDay, -1), owed: 0 }, ...d.anchors] : d.anchors
    const paid = (book.lines.get(d.id) ?? []).filter((l) => l.cents < 0)
    for (let i = 1; i < points.length; i++) {
      const [p, q] = [points[i - 1], points[i]]
      const rise = q.owed - p.owed
      if (rise > 0) rises.push({ debtId: d.id, from: p.day, to: q.day, left: rise - paid.filter((l) => l.day > p.day && l.day <= q.day).reduce((s, l) => s + l.cents, 0) })
    }
  }
  if (rises.length) {
    const inflows = loadLines(ctx, "t.amount_cents > 0 AND c.kind = 'transfer'").filter((l) => l.ledger && l.owner === null && !l.capitalAssetId && !legOf(ctx, l))
    for (const l of inflows) {
      let best: (typeof rises)[number] | null = null
      let bestGap = LEG_DAYS + 1
      for (const r of rises) {
        if (r.left < l.cents) continue
        const gap = l.day <= r.from ? daysBetween(l.day, addDays(r.from, 1)) : l.day > r.to ? daysBetween(r.to, l.day) : 0
        if (gap < bestGap) {
          best = r
          bestGap = gap
        }
      }
      if (!best) continue
      best.left -= l.cents
      link(l, best.debtId, 'borrowing')
    }
    for (const list of book.lines.values()) list.sort(byPosting)
  }

  // Each payment's split, from the balances that bracket it.
  const firstDay = new Map(db.all<{ id: string; p: number }>('SELECT account_id AS id, MIN(posted) AS p FROM transactions GROUP BY account_id').map((r) => [r.id, db.dayKey(r.p)]))
  for (const d of book.debts.values()) {
    const mine = book.lines.get(d.id) ?? []
    const pays = mine.filter((l) => book.links.get(lineId(l))!.kind === 'payment')
    if (pays.length) splitPayments(d, pays, mine.filter((l) => l.cents > 0), firstDay, book.splits)
  }
  return book
}

/**
 * Splits a debt's payments into principal and interest with escrow (1.4). Between the last known balance before a
 * payment's day and the first on or after it (a balance is the day's closing one, so a line on its day is in it),
 * the principal is the drop in what's owed plus what was borrowed then, shared over the payments then: each gets
 * the total over their number, rounded down, and the last the rest, each held between nothing and the payment. A
 * bracket that starts before the paying accounts' records do misses payments, so it's no bracket. After the last
 * balance, a payment takes the bracket before's share; with no bracket at all, the interest is what's owed times the
 * rate for a month. Both are estimated. Escrow, as set on the debt, comes out of the interest.
 */
function splitPayments(d: Debt, pays: Line[], borrowed: Line[], firstDay: Map<string, string>, out: Map<string, LoanSplit>): void {
  const anchors = d.anchors
  const known = [...new Set([...pays, ...borrowed].map((l) => l.accountId))].map((id) => firstDay.get(id)).filter((x): x is string => !!x).sort()[0] ?? null
  /** the index of the first known balance on or after a day: payments on that day are in the bracket that ends there */
  const after = (day: string): number => {
    let k = 0
    while (k < anchors.length && anchors[k].day < day) k++
    return k
  }
  const complete = (k: number): boolean => k >= 1 && k < anchors.length && (!known || anchors[k - 1].day >= addDays(known, -1))
  const brackets = new Map<number, Line[]>()
  for (const p of pays) {
    const k = after(p.day)
    const list = brackets.get(k)
    if (list) list.push(p)
    else brackets.set(k, [p])
  }
  const principalOf = new Map<Line, number>()
  /** each complete bracket's share per payment */
  const share = new Map<number, number>()
  for (const [k, list] of brackets) {
    if (!complete(k)) continue
    const [a, b] = [anchors[k - 1], anchors[k]]
    const total = a.owed - b.owed + borrowed.filter((l) => l.day > a.day && l.day <= b.day).reduce((s, l) => s + l.cents, 0)
    const each = Math.floor(total / list.length)
    share.set(k, each)
    list.forEach((p, i) => principalOf.set(p, i === list.length - 1 ? total - each * (list.length - 1) : each))
  }
  // What was owed the day before each payment that has no bracket, read once.
  const fallback = pays.filter((p) => !principalOf.has(p)).map((p) => addDays(p.day, -1))
  const balances = db.balancesOnDays(d.id, fallback)
  const owedBefore = new Map(fallback.map((day, i) => [day, Math.max(0, -balances[i])]))
  for (const p of pays) {
    const paid = -p.cents
    let principal = principalOf.get(p)
    let estimated = false
    if (principal === undefined) {
      estimated = true
      const k = after(p.day)
      const before = k === anchors.length ? [...share.keys()].filter((j) => j < k).sort((x, y) => y - x)[0] : undefined
      if (before !== undefined) principal = share.get(before)!
      else {
        const owed = owedBefore.get(addDays(p.day, -1)) ?? 0
        principal = paid - Math.round((owed * (d.apr ?? 0)) / 1200) - d.escrowCents
      }
    }
    principal = Math.max(0, Math.min(paid, principal))
    const escrow = Math.min(d.escrowCents, paid - principal)
    out.set(lineId(p), { principalCents: principal, interestCents: paid - principal - escrow, escrowCents: escrow, estimated })
  }
}

/** A payment's principal, interest and escrow on a loan; null when the transaction isn't a payment on it. */
export function loanSplit(loanId: string, txnId: string): LoanSplit | null {
  const book = debtBook(context())
  let out: LoanSplit | null = null
  for (const l of book.lines.get(loanId) ?? []) {
    const s = l.id === txnId ? book.splits.get(lineId(l)) : undefined
    if (!s) continue
    out = out
      ? { principalCents: out.principalCents + s.principalCents, interestCents: out.interestCents + s.interestCents, escrowCents: out.escrowCents + s.escrowCents, estimated: out.estimated || s.estimated }
      : { ...s }
  }
  return out
}

/** Personal debts that owe something today and have no payment linked to them, by a transfer to them or their payment key. */
export function unlinkedDebts(): Account[] {
  const ctx = context()
  const today = db.today()
  const book = debtBook(ctx)
  return [...book.debts.values()]
    .filter((d) => d.owner === null)
    .map((d) => ctx.accts.get(d.id)!.account)
    .filter((a) => (a.balanceCents ?? 0) < 0 && !(a.closedDay && a.closedDay <= today) && !(book.lines.get(a.id) ?? []).some((l) => l.cents < 0))
}

/**
 * Links each Personal debt with no payment key to the payments that pay it: a live outflow series named as the debt
 * is, or else one on the debt's own account (the match the debt plan makes). Runs once after migration 38 and for the
 * sample household; Review links the rest (link_loan_payment). Returns how many it linked.
 */
export function linkLoanPayments(): number {
  const accounts = db.listAccounts()
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const series = detectRecurring().filter((s) => !s.dismissed && s.status !== 'stopped' && s.typicalCents < 0)
  const named = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  let n = 0
  for (const a of accounts) {
    if (!DEBTS.has(a.assetType) || a.hidden || a.paymentKey || a.bucketId !== null || (a.linkedAssetId && (byId.get(a.linkedAssetId)?.bucketId ?? null) !== null)) continue
    const byName = series.filter((s) => named(s.name) === named(a.name))
    const onIt = series.filter((s) => (s.accountId ? s.accountId === a.id : s.accountName === a.name))
    const pick = byName.length === 1 ? byName[0] : !byName.length && onIt.length === 1 ? onIt[0] : null
    if (!pick) continue
    db.setPaymentKey(a.id, pick.key)
    n++
  }
  return n
}

db.supplyFollowUp(38, () => void linkLoanPayments())

// ---------- capital ----------

/** The days in which an asset's purchase, sale, lending or repayment moves money, and how much of it they take at most. */
export interface CapitalWindow {
  assetId: string
  kind: 'purchase' | 'sale' | 'lent' | 'repaid'
  /** money out (-1) or in (1) */
  sign: 1 | -1
  fromDay: string
  toDay: string
  /** lines nearest this day are taken first */
  day: string
  /** the cost less what was financed, or the value at the sale less selling costs plus what was financed (paid off) */
  capCents: number
  /** the linked loans' part that never touched the perimeter: positive at a purchase, zero or negative at a sale */
  financedCents: number
  /** financedCents loan by loan, for each linked loan with a part of it */
  loans: Array<{ debtId: string; cents: number }>
}

/**
 * The capital windows of each Personal asset (property, vehicles, other assets, money lent and stakes). A purchase
 * takes money out from PURCHASE_DAYS before it opened to that day, up to its cost less what its loans paid the seller
 * (each linked loan opened then: its first balance less what was borrowed on it then). A sale takes money in from its
 * closing to PROCEEDS_DAYS after, up to its value then less selling costs, less what was paid off its loans at closing
 * without passing through the perimeter (their drop then less the principal paid on them from it). Money lent is
 * taken like a purchase, up to the amount lent; repayments from then to PROCEEDS_DAYS after it closed (or today), up
 * to the amount lent less what's still owed.
 */
function windowsOf(ctx: Ctx, book: DebtBook): CapitalWindow[] {
  const today = db.today()
  const out: CapitalWindow[] = []
  const owedOn = (id: string, day: string): number => Math.max(0, -db.balancesOnDays(id, [day])[0])
  for (const [id, x] of ctx.accts) {
    // A Stakes account linked to a venture is the venture's stake: no capital line attaches to it.
    if (!ASSETS.has(x.type) || x.hidden || x.bucketId !== null || ctx.stakes.has(id)) continue
    const a = x.account
    const loans = [...book.debts.values()].filter((d) => d.linkedAssetId === id)
    if (a.openedDay) {
      const fromDay = addDays(a.openedDay, -PURCHASE_DAYS)
      const byLoan: CapitalWindow['loans'] = []
      for (const d of loans) {
        if (!d.openedDay || d.openedDay < fromDay || d.openedDay > a.openedDay) continue
        const borrowed = (book.lines.get(d.id) ?? []).filter((l) => l.cents > 0 && l.day >= fromDay && l.day <= a.openedDay!).reduce((s, l) => s + l.cents, 0)
        const cents = Math.max(0, (d.anchors[0]?.owed ?? 0) - borrowed)
        if (cents) byLoan.push({ debtId: d.id, cents })
      }
      const financed = byLoan.reduce((s, x) => s + x.cents, 0)
      out.push({ assetId: id, kind: a.assetType === 'receivable' ? 'lent' : 'purchase', sign: -1, fromDay, toDay: a.openedDay, day: a.openedDay, capCents: a.costCents === null ? 0 : Math.max(0, a.costCents - financed), financedCents: financed, loans: byLoan })
    }
    if (a.assetType === 'receivable') {
      if (a.costCents === null || !a.openedDay) continue
      const owed = a.closedDay && a.closedDay <= today ? 0 : Math.max(0, db.balancesOnDays(id, [today])[0])
      out.push({ assetId: id, kind: 'repaid', sign: 1, fromDay: a.openedDay, toDay: a.closedDay ? addDays(a.closedDay, PROCEEDS_DAYS) : today, day: a.openedDay, capCents: Math.max(0, a.costCents - owed), financedCents: 0, loans: [] })
      continue
    }
    if (!a.closedDay) continue
    const toDay = addDays(a.closedDay, PROCEEDS_DAYS)
    const byLoan: CapitalWindow['loans'] = []
    for (const d of loans) {
      const drop = owedOn(d.id, addDays(a.closedDay, -1)) - owedOn(d.id, toDay)
      const paid = (book.lines.get(d.id) ?? []).filter((l) => l.perimeter && l.cents < 0 && l.day >= a.closedDay! && l.day <= toDay).reduce((s, l) => s + (book.splits.get(lineId(l))?.principalCents ?? 0), 0)
      const cents = Math.min(0, paid - drop)
      if (cents) byLoan.push({ debtId: d.id, cents })
    }
    const financed = byLoan.reduce((s, x) => s + x.cents, 0)
    const value = db.balancesOver([id], a.closedDay, a.closedDay, true).byId.get(id)?.[0] ?? 0
    out.push({ assetId: id, kind: 'sale', sign: 1, fromDay: a.closedDay, toDay, day: a.closedDay, capCents: Math.max(0, value - (a.saleCostsCents ?? 0) + financed), financedCents: financed, loans: byLoan })
  }
  const order: Record<CapitalWindow['kind'], number> = { purchase: 0, lent: 0, sale: 1, repaid: 2 }
  return out.sort((x, y) => order[x.kind] - order[y.kind] || x.day.localeCompare(y.day) || x.assetId.localeCompare(y.assetId))
}

/** Every Personal asset's capital windows, purchases and money lent first, then sales, then repayments. */
export function capitalWindows(): CapitalWindow[] {
  const ctx = context()
  return windowsOf(ctx, debtBook(ctx))
}

/** What an asset's linked loans financed at its purchase (positive) or paid off at its sale (zero or negative) without touching the perimeter. */
export function financed(assetId: string, window: 'purchase' | 'sale'): number {
  return capitalWindows()
    .filter((w) => w.assetId === assetId && (window === 'sale' ? w.kind === 'sale' : w.kind === 'purchase' || w.kind === 'lent'))
    .reduce((s, w) => s + w.financedCents, 0)
}

/**
 * The capital each window takes, by line: lines on perimeter accounts in its days and its direction, each at least
 * CAPITAL_FLOOR and a tenth of its cap, that are no transfer with a leg, no debt's payment or borrowing, not pay, a
 * commitment or interest earned, and not money with a venture Review or the user gave an intent (`intended`): that is
 * its intent's. Nearest its day first, then larger first, up to its cap; the last one taken can be taken in part. A
 * line goes to one window only.
 */
function allocateCapital(ctx: Ctx, book: DebtBook, windows: CapitalWindow[], routine: (l: Line) => boolean, intended: (l: Line) => boolean = () => false): Map<string, { assetId: string; cents: number }> {
  const taken = new Map<string, { assetId: string; cents: number }>()
  const open = windows.filter((w) => w.capCents > 0)
  if (!open.length) return taken
  const spans = open.map((w) => [w.fromDay, w.toDay] as const).sort((x, y) => x[0].localeCompare(y[0]))
  const merged: Array<[string, string]> = []
  for (const [from, to] of spans) {
    const last = merged[merged.length - 1]
    if (last && from <= addDays(last[1], 1)) last[1] = to > last[1] ? to : last[1]
    else merged.push([from, to])
  }
  const lines = merged
    .flatMap(([from, to]) => linesPosted(ctx, db.dayStart(from), db.dayStart(addDays(to, 1))))
    .filter((l) => l.perimeter && l.owner === null && !l.capitalAssetId && !legOf(ctx, l) && !book.links.has(lineId(l)) && !intended(l) && !routine(l))
  for (const w of open) {
    const near = (l: Line): number => Math.abs(daysBetween(w.day, l.day))
    const candidates = lines
      .filter((l) => l.day >= w.fromDay && l.day <= w.toDay && Math.sign(l.cents) === w.sign && !taken.has(lineId(l)) && Math.abs(l.cents) >= CAPITAL_FLOOR && 10 * Math.abs(l.cents) >= w.capCents)
      .sort((x, y) => near(x) - near(y) || Math.abs(y.cents) - Math.abs(x.cents) || byPosting(x, y))
    let left = w.capCents
    for (const l of candidates) {
      if (left <= 0) break
      const part = Math.min(left, Math.abs(l.cents))
      taken.set(lineId(l), { assetId: w.assetId, cents: w.sign * part })
      left -= part
    }
  }
  return taken
}

// ---------- money between Personal and a venture ----------

// A boundary line moves money between Personal and one venture (waterfall spec addendum 1.11). Its shape is one of:
//   T, a transfer: a line on a perimeter account whose other leg is on an account the venture holds, or that pays or
//      borrows on a debt the venture owns, by its leg or its payment key (rules 2 and 6 class it venture);
//   C, a cost or revenue: the venture's line, or part of one, on a perimeter account (rule 1, a split part, the
//      principal of a payment on its place in its residence dates, its use share of a shared cost);
//   F, a funding: a Personal line on a cash or card account the venture holds (a Personal cost it paid, or pay that
//      landed in its account), whose boundary is its funding, minus the line;
//   R, tied: any other Personal line Review ties to the venture (a share bought from a co-owner, money sent to an
//      account of the venture's that isn't tracked).
// From phase 3 a shared cost's parts have the same shapes: the venture's use share paid from Personal's cash is a C
// part, and Personal's paid from the venture's account an F part. Money out of Personal is negative: a line's sign for
// T, C and R, the funding's for F. The intent parts Review or the user stored (venture_money) add up to the line, or
// for F to its funding; rule 0 applies them only while the line still has that shape with that venture: a line's own
// while it's on a perimeter account and has a part with the venture, or no part with any venture and no other account
// of Personal's holding its money (R); a funding's while the line is Personal's on that venture's cash or card and no
// leg of it is on a perimeter account (that crossing is the T line on Personal's side). A line whose account, leg or
// owner changed since keeps its stored parts, which apply again if it changes back, and Review is asked about them.
// What the classifier counts and what a venture's claims read (appliedIntentParts, ventureMoney.ts) are the same parts.

/**
 * One intent part of a boundary line, as rule 0 applies it: one Review or the user stored, or one a remembered answer
 * or an inference gives a line with none stored (ventureMoney.ts inferIntents), the whole of its boundary.
 */
interface Stored {
  face: 'line' | 'fund'
  ventureId: number
  intent: VentureIntent
  /** signed as the line, or the funding */
  cents: number
  /** a repayment's interest, positive; the rest is principal */
  interestCents: number
  regular: boolean | null
  source: 'review' | 'user' | 'rule' | 'inferred'
}

/** A line's stored parts that apply, by face: its own (T, C, R) and its funding's (F). */
interface Applied {
  line: Stored[]
  fund: Stored[]
}

/** Every stored part, by line (`txnId:splitId`), in the order they were stored. Books before migration 43 have none. */
function storedParts(): Map<string, Stored[]> {
  const out = new Map<string, Stored[]>()
  if (!db.upToDate()) return out
  for (const r of db.all<Stored & { txnId: string; splitId: number | null; regular: number | null }>(
    `SELECT txn_id AS txnId, split_id AS splitId, face, venture_id AS ventureId, intent, cents, interest_cents AS interestCents, regular, source
     FROM venture_money ORDER BY id`
  )) {
    const key = `${r.txnId}:${r.splitId ?? ''}`
    const s: Stored = { face: r.face, ventureId: r.ventureId, intent: r.intent, cents: r.cents, interestCents: r.interestCents, regular: r.regular === null ? null : r.regular === 1, source: r.source }
    const list = out.get(key)
    if (list) list.push(s)
    else out.set(key, [s])
  }
  return out
}

/**
 * Whether a line's stored parts of a face apply: its own while it's in the ledger, a funding's while it's on a
 * venture's cash or card (the funding of Personal's parts of it: the line, when it's Personal's, or Personal's use
 * share of a cost the venture's account paid).
 */
const applies = (l: Pick<Line, 'ledger' | 'held'>, face: 'line' | 'fund'): boolean => (face === 'line' ? l.ledger : l.held)

/** A line's stored parts that apply (by `fits`, the faces alone when none is given), or null with none. */
function appliedOf(l: Line, stored: Map<string, Stored[]>, fits: (l: Line, s: Stored) => boolean = (x, s) => applies(x, s.face)): Applied | null {
  const list = stored.get(lineId(l))
  if (!list) return null
  const line = list.filter((s) => s.face === 'line' && fits(l, s))
  const fund = list.filter((s) => s.face === 'fund' && fits(l, s))
  return line.length || fund.length ? { line, fund } : null
}

/**
 * The classes a Personal line takes when another account of Personal's already holds its money: another of its cash
 * and cards (internal), an investment (invested), a debt (principal) or an asset (capital). A line Review ties to a
 * venture (R) is money no account of Personal's holds, so none of these is one: tied, its money would count twice,
 * in the account and as a claim or a stake.
 */
const HELD_BY_PERSONAL = new Set<LineClass>(['internal', 'invested', 'principal', 'capital'])

/** A part's interest, signed as its cents: a repayment's (of a loan to the venture, money in; of one from it, money out); 0 for any other. */
const interestOf = (s: Pick<Stored, 'intent' | 'cents' | 'interestCents'>): number =>
  (s.intent === 'loan_repayment' || s.intent === 'venture_loan_repayment') && s.interestCents ? Math.sign(s.cents) * s.interestCents : 0

/**
 * The intent parts that apply, on lines dated from one day to another (YYYY-MM-DD, inclusive), oldest first: the
 * parts rule 0 gives the classifier's lines, those Review or the user stored and those a remembered answer or an
 * inference gives (moneyBook), so a venture's claims and basis, and its position in net worth, are moved by the same
 * parts the waterfall counts.
 */
export function appliedIntentParts(fromDay = '0000-01-01', toDay = '9999-12-31'): IntentPart[] {
  return moneyBook().parts.filter((p) => p.day >= fromDay && p.day <= toDay)
}

/**
 * The stored intent parts that apply, oldest first, each with its line's posting time: read without classifying (a
 * line's owner and accounts are all that say whether they apply).
 */
function storedApplied(): Array<IntentPart & { posted: number }> {
  if (!db.upToDate()) return []
  const rows = db.all<{ txnId: string; splitId: number | null; face: 'line' | 'fund'; ventureId: number; intent: VentureIntent; cents: number; interestCents: number; regular: number | null; source: 'review' | 'user' }>(
    `SELECT m.txn_id AS txnId, m.split_id AS splitId, m.face, m.venture_id AS ventureId, m.intent, m.cents, m.interest_cents AS interestCents, m.regular, m.source
     FROM venture_money m JOIN transactions t ON t.id = m.txn_id
     ORDER BY t.posted, m.txn_id, m.split_id, m.face, m.id`
  )
  if (!rows.length) return []
  const owners: Owners = { accts: accountsById(), homes: residences(), payroll: payrollKeys() }
  const ids = [...new Set(rows.map((r) => r.txnId))]
  const lines = new Map<string, Line>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const l of loadLines(owners, `t.id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) lines.set(lineId(l), l)
  }
  return rows.flatMap((r) => {
    const l = lines.get(`${r.txnId}:${r.splitId ?? ''}`)
    if (!l || !applies(l, r.face)) return []
    return [{ txnId: r.txnId, splitId: r.splitId, face: r.face, ventureId: r.ventureId, day: l.day, accountId: l.accountId, intent: r.intent, cents: r.cents, interestCents: r.interestCents, regular: r.regular === null ? null : r.regular === 1, source: r.source, posted: l.posted }]
  })
}

/** Every venture's money with Personal as rule 0 reads it: what was stored, and what a remembered answer or an inference gives. */
interface MoneyBook {
  /** the parts Review or the user stored, by line (`txnId:splitId`): a capital window never takes a line whose own parts they are */
  stored: Map<string, Stored[]>
  /** every part rule 0 applies, by line: the stored ones, and for a boundary part with none, a remembered answer's or an inference's */
  byLine: Map<string, Stored[]>
  /** the same parts where they apply, oldest first, with their lines' days and accounts */
  parts: IntentPart[]
  /** every boundary part the classifier finds, oldest first: a line's money with one venture, before any intent */
  units: BoundaryUnit[]
  /** of those, the ones with no intent, with what a line's stored parts leave of it after its amount changed: oldest first */
  unset: BoundaryUnit[]
  /** the stored parts that no longer fit their lines (an account left the venture, a leg or an owner changed): none counts, oldest first */
  stale: StaleParts[]
}

/** A line's stored parts of one face and venture that don't apply to it now, as Review is asked about them. */
export interface StaleParts {
  txnId: string
  splitId: number | null
  face: 'line' | 'fund'
  ventureId: number
  day: string
  /** what they add up to, signed as the line or the funding */
  cents: number
}

/** Each ledger's money book, kept until its data moves (db.dataStamp) or the day turns. Read only. */
const moneyKept = new WeakMap<object, { stamp: string; book: MoneyBook }>()

/**
 * The money book (MoneyBook): the stored intent parts, and those the remembered answers and the inferences give the
 * boundary lines with none stored, walked over every day there are lines, since a line's claims and paybacks read the
 * lines before it and I5 reads ahead. The stored parts count only where they fit their lines as the classifier finds
 * them now (rule 0), so a venture's claims and the waterfall's classes agree. Books with no line that could be money
 * with a venture and no stored part (mayCross) are read without classifying. Read only.
 */
function moneyBook(): MoneyBook {
  // The books' data, and the day: nothing the money book reads moves by the minute, as the data stamp does.
  const data = db.dataStamp()
  const stamp = data === null ? null : `${data.slice(0, data.lastIndexOf(':'))}:${db.today()}`
  const owner = db.currentConnection()
  if (stamp === null || !owner) return findMoneyBook()
  const kept = moneyKept.get(owner)
  if (kept?.stamp === stamp) return kept.book
  const book = findMoneyBook()
  moneyKept.set(owner, { stamp, book })
  return book
}

function findMoneyBook(): MoneyBook {
  const stored = storedParts()
  // Books with a stored part always cross (mayCross), so with none read here there's nothing to apply.
  if (!db.upToDate() || !mayCross()) return { stored, byLine: stored, parts: [], units: [], unset: [], stale: [] }
  const span = db.get<{ first: number | null; last: number | null }>('SELECT MIN(posted) AS first, MAX(posted) AS last FROM transactions')
  if (!span || span.first === null || span.last === null) return { stored, byLine: stored, parts: [], units: [], unset: [], stale: [] }
  const fromDay = db.dayKey(span.first)
  const c = classify(fromDay, db.dayKey(span.last), { intents: stored })
  // The stored parts rule 0 applies, as the classifier fits them to their lines; the rest are stale, and count nowhere.
  const fit = new Set<string>()
  for (const l of c.lines) {
    if (!stored.has(lineId(l))) continue
    const a = c.intentsOf(l)
    for (const s of a ? [...a.line, ...a.fund] : []) fit.add(`${lineId(l)}:${s.face}:${s.ventureId}`)
  }
  const fits = (p: { txnId: string; splitId: number | null; face: 'line' | 'fund'; ventureId: number }): boolean => fit.has(`${p.txnId}:${p.splitId ?? ''}:${p.face}:${p.ventureId}`)
  const applied = storedApplied().filter(fits)
  const stale = staleParts(fits)
  const units = boundaryUnits(c, fromDay)
  const shares = new Map<number, VentureShare[]>()
  for (const r of db.ventureShareRows()) shares.set(r.bucketId, [...(shares.get(r.bucketId) ?? []), { fromDay: r.fromDay, shareBp: r.shareBp, source: r.source }])
  const ventures = db.all<{ id: number; kind: BucketKind }>('SELECT id, kind FROM buckets').map((b) => ({ ...b, shares: shares.get(b.id) ?? [] }))
  const rules = db.all<{ venture_id: number; shape: 'T' | 'C' | 'F'; direction: 'out' | 'in'; payee_key: string | null; intent: VentureIntent; regular: number | null }>('SELECT venture_id, shape, direction, payee_key, intent, regular FROM venture_money_rules ORDER BY id')
  const given = inferIntents(
    units,
    applied,
    ventures,
    rules.map((r) => ({ ventureId: r.venture_id, shape: r.shape, direction: r.direction, payeeKey: r.payee_key, intent: r.intent, regular: r.regular === null ? null : r.regular === 1 }))
  )
  const byLine = new Map([...stored].map(([k, list]) => [k, [...list]]))
  const covered = new Map<string, number>()
  for (const p of applied) covered.set(unitKey(p), (covered.get(unitKey(p)) ?? 0) + p.cents)
  const unset: BoundaryUnit[] = []
  const ordered: Array<IntentPart & { posted: number }> = [...applied]
  for (const u of units) {
    const key = unitKey(u)
    const g = given.get(key)
    if (g) {
      const s: Stored = { face: u.face, ventureId: u.ventureId, intent: g.intent, cents: u.cents, interestCents: 0, regular: g.regular, source: g.source }
      const line = `${u.txnId}:${u.splitId ?? ''}`
      byLine.set(line, [...(byLine.get(line) ?? []), s])
      ordered.push({ txnId: u.txnId, splitId: u.splitId, face: u.face, ventureId: u.ventureId, day: u.day, accountId: u.accountId, intent: g.intent, cents: u.cents, interestCents: 0, regular: g.regular, source: g.source, posted: u.posted })
      continue
    }
    // What a line's stored parts leave of it, after its amount changed, is unset as rule 0's :rest part is.
    const left = covered.has(key) ? u.cents - covered.get(key)! : u.cents
    if (left) unset.push(left === u.cents ? u : { ...u, cents: left })
  }
  ordered.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0) || x.posted - y.posted)
  return { stored, byLine, parts: ordered.map(({ posted: _posted, ...p }) => p), units, unset, stale }
}

/** The stored parts that don't fit their lines (`fits` says which do), one entry a line, face and venture, oldest first. */
function staleParts(fits: (p: { txnId: string; splitId: number | null; face: 'line' | 'fund'; ventureId: number }) => boolean): StaleParts[] {
  const out = new Map<string, StaleParts>()
  for (const r of db.all<{ txnId: string; splitId: number | null; face: 'line' | 'fund'; ventureId: number; day: string; cents: number }>(
    `SELECT m.txn_id AS txnId, m.split_id AS splitId, m.face, m.venture_id AS ventureId, date(${db.localSql('t.posted')}) AS day, m.cents
     FROM venture_money m JOIN transactions t ON t.id = m.txn_id
     ORDER BY t.posted, m.txn_id, m.split_id, m.face, m.id`
  )) {
    if (fits(r)) continue
    const key = `${r.txnId}:${r.splitId ?? ''}:${r.face}:${r.ventureId}`
    const s = out.get(key)
    if (s) s.cents += r.cents
    else out.set(key, { ...r })
  }
  return [...out.values()]
}

/** The stored parts that no longer fit their lines, oldest first (MoneyBook.stale): Review's question about them. Read only. */
export function staleIntentParts(): readonly StaleParts[] {
  return moneyBook().stale
}

/**
 * Whether any line could be money between Personal and a venture, by SQL alone, before anything is classified: a line
 * placed in a venture on Personal's own cash and cards (C), a Personal line on a venture's cash or card, one a
 * residence's legacy clause or the paycheck clause makes Personal's, or any asset's uses (F, and the parts uses share),
 * and a line on a venture's account or a Stakes account linked to one that a transfer could pair with, or a Personal
 * debt on a venture's asset, or a venture's debt paid by its payee (T). Books with a stored intent part always may:
 * whether it still fits its line is the classifier's to say. It may say yes for books with none; it never says no for
 * books with one.
 */
function mayCross(): boolean {
  if (!db.get('SELECT 1 FROM buckets LIMIT 1')) return false
  if (db.get('SELECT 1 FROM asset_uses LIMIT 1') || db.get('SELECT 1 FROM venture_money LIMIT 1')) return true
  if (
    db.get(
      `SELECT 1 FROM accounts d LEFT JOIN accounts h ON h.id = d.linked_asset_id
       WHERE d.hidden = 0 AND d.asset_type IN ('loan', 'mortgage', 'other_debt')
         AND ((d.bucket_id IS NULL AND h.bucket_id IS NOT NULL) OR (d.bucket_id IS NOT NULL AND d.payment_key IS NOT NULL))
       LIMIT 1`
    )
  )
    return true
  if (db.get("SELECT 1 FROM buckets b JOIN accounts a ON a.bucket_id = b.id WHERE a.hidden = 0 AND a.asset_type IN ('cash', 'credit_card') AND b.residence_from IS NOT NULL AND b.residence_converted = 0 LIMIT 1")) return true
  const accounts = db.all<{ id: string; type: string; bucket: number | null; stake: number }>(
    'SELECT a.id, a.asset_type AS type, a.bucket_id AS bucket, EXISTS (SELECT 1 FROM buckets b WHERE b.stake_account_id = a.id) AS stake FROM accounts a WHERE a.hidden = 0'
  )
  const cards = (a: (typeof accounts)[number]): boolean => a.type === 'cash' || a.type === 'credit_card'
  const own = accounts.filter((a) => a.bucket === null && cards(a)).map((a) => a.id)
  const held = accounts.filter((a) => a.bucket !== null && cards(a)).map((a) => a.id)
  const ventures = accounts.filter((a) => a.bucket !== null || a.stake === 1).map((a) => a.id)
  const list = (ids: string[]): string => ids.map(() => '?').join(',')
  // C: a line, or a split part, placed in a venture on Personal's own cash and cards.
  if (own.length && (db.get(`SELECT 1 FROM transactions t WHERE t.bucket_id IS NOT NULL AND +t.account_id IN (${list(own)}) LIMIT 1`, ...own) || db.get(`SELECT 1 FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE s.own_bucket = 1 AND s.bucket_id IS NOT NULL AND +t.account_id IN (${list(own)}) LIMIT 1`, ...own))) return true
  // F: a line, or a part, placed in Personal on a venture's cash or card, or pay landing there.
  if (held.length) {
    if (db.get(`SELECT 1 FROM transactions t WHERE t.bucket_id IS NULL AND t.account_id IN (${list(held)}) LIMIT 1`, ...held) || db.get(`SELECT 1 FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE s.own_bucket = 1 AND s.bucket_id IS NULL AND t.account_id IN (${list(held)}) LIMIT 1`, ...held)) return true
    const payroll = payrollKeys()
    if (payroll.size && db.all<Payee>(`SELECT DISTINCT t.merchant, t.desc_key AS descKey FROM transactions t WHERE t.amount_cents > 0 AND t.account_id IN (${list(held)})`, ...held).some((p) => payroll.has(payrollKey(p)))) return true
  }
  // T: a line on a venture's account, or a Stakes account linked to one, that a transfer could pair with.
  if (!ventures.length) return false
  const legs = db.all<{ cents: number; transfer: number | null }>(`SELECT DISTINCT t.amount_cents AS cents, c.kind = 'transfer' AS transfer FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.account_id IN (${list(ventures)})`, ...ventures)
  if (legs.some((l) => l.transfer === 1)) return true
  const transfers = db.listCategories().filter((c) => c.kind === 'transfer').map((c) => c.id)
  const amounts = [...new Set(legs.map((l) => -l.cents))]
  for (let i = 0; transfers.length && i < amounts.length; i += 500) {
    const chunk = amounts.slice(i, i + 500)
    if (db.get(`SELECT 1 FROM transactions x WHERE x.category_id IN (${transfers.join(',')}) AND x.amount_cents IN (${list(chunk.map(String))}) LIMIT 1`, ...chunk)) return true
  }
  return false
}

/**
 * A transfer's payee, its pattern's (T): the line's payee key when it has a merchant; else the account or debt on its
 * other side (`side`), as `account:<id>|<+ or ->`, since a bank's reference code in a description, letters and digits
 * both, makes each line's description its own and so each line a pattern of its own.
 */
const transferPayee = (l: Line, side: string | null): string => (l.merchant !== null || side === null ? payeeKey(l) : `account:${side}|${l.cents < 0 ? '-' : '+'}`)

/**
 * Every boundary part among a classification's lines dated from a day on, oldest first, by the rules 1 to 12 its
 * intents would replace: on a venture's cash or card, the funding of Personal's parts of a line (F), unless its leg is
 * on a perimeter account, where the transfer's line on Personal's side (T) is that crossing; on a perimeter account,
 * the line's parts with each venture, a transfer with its accounts or debts (T) or its cost or revenue (C).
 */
function boundaryUnits(c: Classified, fromDay: string): BoundaryUnit[] {
  const units: BoundaryUnit[] = []
  for (const l of c.lines) {
    if (l.day < fromDay) continue
    if (l.held) {
      if ((l.owner !== null && !c.shared(l)) || c.perimeterLeg(l)) continue
      const personal = c.partsOf(l).filter((p) => p.owner === null)
      const cents = -personal.reduce((s, p) => s + p.cents, 0)
      const v = c.ctx.accts.get(l.accountId)?.bucketId ?? null
      if (!personal.length || !cents || v === null) continue
      const pay = fromPayroll({ cents: l.cents, income: l.kind === 'income', uncategorized: l.categoryId === null, merchant: l.merchant, descKey: l.descKey }, c.ctx.payroll)
      units.push({ txnId: l.id, splitId: l.splitId, face: 'fund', shape: 'F', ventureId: v, day: l.day, posted: l.posted, accountId: l.accountId, cents, payeeKey: null, payroll: false, pay })
      continue
    }
    // A Personal line on a perimeter account with no venture, no leg, no debt and no use sharing it has no part with one.
    if (!l.perimeter || (l.owner === null && l.placed === null && !legOf(c.ctx, l) && !c.linked(l) && !(c.ctx.uses.size && c.shared(l)))) continue
    const byVenture = new Map<number, Part[]>()
    for (const p of c.partsOf(l)) if (p.cls === 'venture' && p.ventureId !== null) byVenture.set(p.ventureId, [...(byVenture.get(p.ventureId) ?? []), p])
    for (const [v, parts] of byVenture) {
      const cents = parts.reduce((s, p) => s + p.cents, 0)
      if (!cents) continue
      const shape = parts[0].owner === null ? 'T' : 'C'
      units.push({ txnId: l.id, splitId: l.splitId, face: 'line', shape, ventureId: v, day: l.day, posted: l.posted, accountId: l.accountId, cents, payeeKey: shape === 'T' ? transferPayee(l, c.sideOf(l)) : null, payroll: shape === 'T' && c.ctx.payroll.has(payrollKey(l)), pay: false })
    }
  }
  return units
}

/**
 * Every boundary part, and those with no intent (Review's venture_money patterns and venture_paycheck accounts, and
 * share_unset's money that crosses), as the money book has them, oldest first. Read only.
 */
export function boundaryParts(): { units: readonly BoundaryUnit[]; unset: readonly BoundaryUnit[] } {
  const { units, unset } = moneyBook()
  return { units, unset }
}

/** A line's boundary with a venture before any intent, as set_venture_money reads it. */
export interface Boundary {
  txnId: string
  splitId: number | null
  day: string
  accountId: string
  /** the line, signed */
  lineCents: number
  /** null for a line that isn't in Personal's ledger, or one another account of Personal's already holds the money of (`heldAs`) */
  shape: 'T' | 'C' | 'F' | 'R' | null
  /**
   * for a Personal line on a perimeter account with no part with a venture that can't be tied to one: the class that
   * says which of Personal's accounts holds its money (internal, invested, principal, capital), or 'debt' for a line
   * that pays or borrows on a debt of Personal's; 'transfer' for a venture's own leg of a transfer placed in Personal,
   * whose crossing is the line on Personal's side. Null for any other line
   */
  heldAs: LineClass | 'debt' | 'transfer' | null
  /** the venture it moves money with; null for a line Review may tie to any (R) */
  ventureId: number | null
  face: 'line' | 'fund'
  /** what its intent parts add up to: the venture's parts of the line (T, C), the line (R), or its funding (F); negative is money out of Personal */
  cents: number
  /** the line's payee key: a transfer's pattern (T) */
  payeeKey: string
  capitalAssetId: string | null
  /** a capital window takes the line, in part or whole */
  capital: boolean
}

/** Each line of some transactions as a boundary line, by the rules 1 to 12 its intents would replace. */
export function boundariesOf(txnIds: string[]): Boundary[] {
  if (!txnIds.length) return []
  const days = db.get<{ first: string | null; last: string | null }>(
    `SELECT MIN(date(${db.localSql('t.posted')})) AS first, MAX(date(${db.localSql('t.posted')})) AS last FROM ${db.TXN_LINES} t WHERE t.id IN (${txnIds.map(() => '?').join(',')})`,
    ...txnIds
  )
  if (!days?.first || !days.last) return []
  const c = classify(days.first, days.last)
  const want = new Set(txnIds)
  const out: Boundary[] = []
  for (const l of c.lines) {
    if (!want.has(l.id) || l.day < days.first) continue
    const base = { txnId: l.id, splitId: l.splitId, day: l.day, accountId: l.accountId, lineCents: l.cents, payeeKey: transferPayee(l, c.sideOf(l)), capitalAssetId: l.capitalAssetId, capital: !!c.capitalOf(l), heldAs: null }
    // On a venture's cash or card: the funding of Personal's parts, when it has some and no leg on Personal's side.
    const personal = l.held ? c.partsOf(l).filter((p) => p.owner === null) : []
    if (personal.length) {
      if (c.perimeterLeg(l)) out.push({ ...base, shape: null, ventureId: null, face: 'fund', cents: l.cents, heldAs: 'transfer' })
      else out.push({ ...base, shape: 'F', ventureId: c.ctx.accts.get(l.accountId)?.bucketId ?? null, face: 'fund', cents: -personal.reduce((s, p) => s + p.cents, 0) })
      continue
    }
    if (!l.perimeter) {
      out.push({ ...base, shape: null, ventureId: null, face: 'line', cents: l.cents })
      continue
    }
    const parts = c.partsOf(l)
    const byVenture = new Map<number, Part[]>()
    for (const p of parts) if (p.cls === 'venture' && p.ventureId !== null) byVenture.set(p.ventureId, [...(byVenture.get(p.ventureId) ?? []), p])
    if (!byVenture.size) {
      // A line marked as capital is one to unmark first (set_venture_money says so), and isn't asked about here.
      const held = l.capitalAssetId ? null : c.linked(l) ? 'debt' : (parts.find((p) => HELD_BY_PERSONAL.has(p.cls))?.cls ?? null)
      out.push(held === null ? { ...base, shape: 'R', ventureId: null, face: 'line', cents: l.cents } : { ...base, shape: null, ventureId: null, face: 'line', cents: l.cents, heldAs: held })
    }
    for (const [v, ps] of byVenture) out.push({ ...base, shape: ps[0].owner === null ? 'T' : 'C', ventureId: v, face: 'line', cents: ps.reduce((s, p) => s + p.cents, 0) })
  }
  return out
}

// ---------- classifying ----------

/**
 * Every Personal series a transaction pays, by its id. First the series detectRecurring finds over each payee's 400
 * days before its own latest payment, so a recent line pays the series, and has the key, that listRecurring and
 * the run rates read; then the series found over the whole history, for older lines. A payee whose pattern changed
 * (quarterly, then monthly) can be a series in its last 400 days and not over the whole history. Neither depends on
 * the span asked for, nor on today: a payee's window ends at its latest payment, not today, so a closed month's
 * lines pay what they paid as time passes with nothing new (sub-phase 1i). A venture's series isn't here, so its
 * lines are never committed. A series the user dismissed isn't one, in either. A series that has stopped still was
 * one when it was paid.
 */
function seriesByTxn(): Map<string, RecurringSeries> {
  const stamp = db.dataStamp()
  const owner = db.currentConnection()
  if (stamp !== null && owner) {
    const kept = seriesKept.get(owner)
    if (kept?.stamp === stamp) return kept.series
    const series = findSeriesByTxn()
    seriesKept.set(owner, { stamp, series })
    return series
  }
  return findSeriesByTxn()
}

/**
 * Each ledger's series by transaction, kept until its data moves (db.dataStamp): they don't depend on the span, so
 * classifying month after month reads every payee's history once. Read only; never changed by a caller.
 */
const seriesKept = new WeakMap<object, { stamp: string; series: Map<string, RecurringSeries> }>()

/**
 * Every Personal series a line can pay, by its key: what a classified line's seriesKey names, with its cadence, kind
 * and whether its amount varies. The series found in detectRecurring's window come first. Read only.
 */
export function seriesByKey(): Map<string, RecurringSeries> {
  const out = new Map<string, RecurringSeries>()
  for (const s of seriesByTxn().values()) if (!out.has(s.key)) out.set(s.key, s)
  return out
}

function findSeriesByTxn(): Map<string, RecurringSeries> {
  const out = new Map<string, RecurringSeries>()
  const first = db.get<{ p: number | null }>('SELECT MIN(posted) AS p FROM transactions')?.p ?? null
  if (first === null) return out
  const seen = new Set<string>()
  for (const o of [{ fromLast: true }, { lookbackDays: Math.ceil((db.now() - first) / DAY) + 1 }]) {
    for (const h of recurringHistory(o)) {
      for (const id of h.ids) {
        if (seen.has(id)) continue
        seen.add(id)
        if (!h.series.dismissed) out.set(id, h.series)
      }
    }
  }
  return out
}

/** Transactions tagged as a reimbursement, a gift or a sale. */
function taggedOneOff(): Set<string> {
  return new Set(db.all<{ id: string; tag: string }>('SELECT transaction_id AS id, tag FROM transaction_tags').filter((r) => ONE_OFF_INCOME.test(r.tag)).map((r) => r.id))
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The habit rule (11): a line in a category that is a one-off by default is everyday when its payee had lines
 * in that category in at least 3 of the 6 calendar months before the line's month (`earlier`, any months), and
 * the line is at most twice their median size. It reads only earlier months, so a month's answer stays the
 * same when later months come in.
 */
export function habitEveryday(cents: number, month: string, earlier: Array<{ month: string; cents: number }>): boolean {
  const from = shiftMonth(month, -6)
  const prior = earlier.filter((e) => e.month >= from && e.month < month)
  if (new Set(prior.map((e) => e.month)).size < 3) return false
  return Math.abs(cents) <= 2 * median(prior.map((e) => Math.abs(e.cents)))
}

/** A paystub as the bonus rule reads it: its payroll, pay day, kind and net. */
interface StubDay {
  key: string
  day: string
  kind: 'regular' | 'bonus' | 'final'
  netCents: number
}

/** Every paystub's payroll, pay day, kind and net, by payroll. */
function stubDays(): Map<string, StubDay[]> {
  const out = new Map<string, StubDay[]>()
  for (const s of db.all<StubDay>('SELECT paycheck_key AS key, pay_day AS day, kind, net_cents AS netCents FROM paystubs ORDER BY pay_day, id')) {
    const list = out.get(s.key)
    if (list) list.push(s)
    else out.set(s.key, [s])
  }
  return out
}

/** The paystubs that belong to a check: a payroll's stubs dated within 3 days of its first deposit, as paystubs.ts matches them. */
const stubsOfCheck =(stubs: StubDay[] | undefined, day: string): StubDay[] => (stubs ?? []).filter((s) => Math.abs(daysBetween(s.day, day)) <= 3)

/**
 * How much of each pay line is bonus. A check is a payroll's deposits within 3 days of its first, across
 * accounts, so a split deposit adds up. A check with paystubs is what they say: the part its bonus stubs' net
 * pay covers is bonus, and the rest regular. Otherwise a check is off schedule, and all bonus, when it comes at
 * most half the payroll's usual gap after the last regular check (the median of the 6 gaps between regular
 * checks before it, once there are 3) and sooner than the schedule its checks keep allows: the cadence the days
 * of its checks over the year up to this one land on (cadence.ts), and it isn't on one of that schedule's days. A
 * payday moved for a weekend or a holiday is still regular, and so is a paycheck on its day after an off-cycle check
 * that came too late to look off schedule. A payroll that changed cadence is judged by its gaps at the time; the
 * schedule only keeps a payroll that now pays more often from looking off schedule, once its checks keep the new
 * one. So the first weekly check after every other week is off schedule, as it was when it came, and the ones after
 * it regular. Of a regular check, the part above 1.5 times the typical check is bonus: the median of the 6 regular
 * checks before it (once there are 3), those before a new schedule's run counted as checks on it once the days
 * settle on it. Bonus is taken from a check's largest deposits first. Apart from the stubs, only a check and the
 * checks before it are read, so a later check never makes an earlier one bonus or regular. `pay` is oldest first.
 */
function bonusOf(pay: Line[], stubs: Map<string, StubDay[]>): Map<Line, number> {
  const out = new Map<Line, number>()
  const byKey = new Map<string, Line[]>()
  for (const l of pay) {
    const k = payrollKey(l)
    const list = byKey.get(k)
    if (list) list.push(l)
    else byKey.set(k, [l])
  }
  for (const [key, lines] of byKey) {
    const checks: Line[][] = []
    for (const l of lines) {
      const c = checks[checks.length - 1]
      if (c && daysBetween(c[0].day, l.day) <= 3) c.push(l)
      else checks.push([l])
    }
    const regular: Array<{ day: string; cents: number }> = []
    /** days between one regular check and the next */
    const gaps: number[] = []
    /**
     * The days the schedule at check i is read from: its own and those of the year's checks before it. Two checks
     * off the schedule among the latest four leave those keeping none, so then the regular checks' days and check
     * i's: the schedule the earlier one was judged off.
     */
    const daysAt = (i: number): string[] => {
      const from = addDays(checks[i][0].day, -365)
      const all = checks.slice(0, i + 1).flatMap((c) => (c[0].day >= from ? [c[0].day] : []))
      return cadenceOf(all) ? all : [...regular.flatMap((r) => (r.day >= from ? [r.day] : [])), checks[i][0].day]
    }
    /** The shortest gap between regular checks the schedule at check i allows; null when its days keep none. */
    const shortest = (i: number): number | null => {
      const told = cadenceOf(daysAt(i))
      return told ? CADENCES.find((c) => c.id === told)!.min : null
    }
    /**
     * The typical check before check i: the median of the 6 regular checks before it. Once the days at check i settle
     * on a new schedule paying a different number of checks a year (cadence.ts latestRun), a check before its run paid
     * the old schedule's period, so with `across` it counts as it would on the new one: twice itself when weekly pay
     * became pay every other week, half the other way.
     */
    const typical = (i: number, across: boolean): number => {
      const run = across ? latestRun(daysAt(i)) : null
      return median(regular.slice(-6).map((r) => (run && r.day < run.from ? (r.cents * CHECKS_A_YEAR[run.was]) / CHECKS_A_YEAR[run.cadence] : r.cents)))
    }
    for (const [i, c] of checks.entries()) {
      const total = c.reduce((s, l) => s + l.cents, 0)
      const prev = regular[regular.length - 1]
      const gap = prev ? daysBetween(prev.day, c[0].day) : null
      const own = stubsOfCheck(stubs.get(key), c[0].day)
      const bonusNet = own.filter((s) => s.kind === 'bonus').reduce((s, x) => s + x.netCents, 0)
      const offSchedule = (): boolean => {
        if (gap === null || gaps.length < 3 || 2 * gap > median(gaps.slice(-6))) return false
        // A check on its schedule's day is the schedule's, though the regular check before it came off it.
        if (onScheduleDay(daysAt(i))) return false
        const min = shortest(i)
        return min !== null && gap < min
      }
      const allBonus = own.length ? bonusNet >= total : offSchedule()
      if (allBonus) {
        for (const l of c) out.set(l, l.cents)
        continue
      }
      const above = (t: number): number => Math.max(0, total - Math.floor((t * 3) / 2))
      let excess = own.length ? bonusNet : 0
      if (!own.length && regular.length >= 3) {
        excess = above(typical(i, false))
        // A change of schedule moves the bonus only of a check above 1.5 times the typical one, or of one two thirds of
        // the usual gap or less after the last: on a faster schedule. Only those read where the latest run began.
        if (excess || (gap !== null && gaps.length >= 3 && 3 * gap <= 2 * median(gaps.slice(-6)))) excess = above(typical(i, true))
      }
      let left = excess
      for (const l of [...c].sort((a, b) => b.cents - a.cents)) {
        if (!left) break
        const part = Math.min(left, l.cents)
        out.set(l, part)
        left -= part
      }
      regular.push({ day: c[0].day, cents: total - excess })
      if (gap !== null) gaps.push(gap)
    }
  }
  return out
}

/**
 * One classified part of a line: the whole line, or a derived part (interest, principal, capital), or an intent part
 * of money between Personal and a venture, which adds its intent (`:<intent>`) when its line has several, `:int` for a
 * repayment's interest, and `:fund` for a funding (rule 0).
 */
interface Part {
  suffix: string
  cents: number
  cls: LineClass
  owner: number | null
  assetId: string | null
  debtId: string | null
  estimated: boolean
  /** the owner's share of the line by an asset's use, in basis points; 10000 for a line no use shares */
  shareBp: number
  /** the venture a boundary part moves money with (a transfer to its account, its cost or revenue, a funding); null on any other part */
  ventureId: number | null
  /** what the boundary part is, when Review or the user said; null while it is unset */
  intent: VentureIntent | null
  intentSource: 'review' | 'user' | 'rule' | 'inferred' | null
  /** the category the part is counted in, when not its line's: a gift with no category or a transfer's is Gifts & Donations, a funding has none */
  categoryId?: number | null
}

/**
 * How a line came to be an asset's cost, in the order section 3 takes them: a payment on a loan linked to the asset
 * ('loan'), an asset rule ('rule'), Review or the user by hand ('hand'), a cost the venture rules placed in a
 * venture that holds one property or vehicle, on a day that asset is shared ('venture'), or a Personal cost of
 * Personal's one house or vehicle ('personal').
 */
type AttachedBy = 'loan' | 'rule' | 'hand' | 'venture' | 'personal'

/** The classifier over some days: every line it read (the 6 months before them too, for the habit rule), and each one's parts. */
interface Classified {
  ctx: Ctx
  lines: Line[]
  /** a line's parts by rules 1 to 12, before any intent: what a venture's books and an asset's costs read */
  partsOf: (l: Line) => Part[]
  /** a line's parts in the ledger: rule 0's intent parts in place of a boundary line's, or beside it for a funding */
  ledgerParts: (l: Line) => Part[]
  /** the intent parts rule 0 applies to a line: those given it that still fit its shape with their venture; null with none */
  intentsOf: (l: Line) => Applied | null
  /** whether a line's transfer leg is on a perimeter account (a venture's own leg placed in Personal has its crossing there) */
  perimeterLeg: (l: Line) => boolean
  /** the account a line's transfer leg is on, or the debt it pays or borrows on; null for any other line */
  sideOf: (l: Line) => string | null
  /** the line a pay part is a check of, for its bonus: the line, or a salary part of it as a line of its own */
  payLineOf: (l: Line, p: Part) => Line
  /** what a capital window takes of a line, if any */
  capitalOf: (l: Line) => { assetId: string; cents: number } | undefined
  /** whether an asset's uses share the line among its owners */
  shared: (l: Line) => boolean
  /** whether the line pays or borrows on a debt, by its leg or its payee */
  linked: (l: Line) => boolean
  /** a loan payment's escrow, positive; 0 for any other line */
  escrowOf: (l: Line) => number
  /** the debt a line pays, with the debt's owner and the payment's split; null for any other line */
  paymentOf: (l: Line) => { debtId: string; owner: number | null; split: LoanSplit } | null
  series: Map<string, RecurringSeries>
  bonus: Map<Line, number>
}

/** The ledger's lines from one day to another (YYYY-MM-DD, inclusive), oldest first, each with its owner and class. */
export function classifyLines(fromDay: string, toDay: string): ClassifiedLine[] {
  return ledger(fromDay, toDay, (c) => c)
}

/** A classified line with what its line says of itself, for totals that group it by payee, category or day. */
export interface LedgerLine extends ClassifiedLine {
  /** unix time */
  posted: number
  merchant: string | null
  descKey: string
  description: string
  /** its category's name and kind ('expense', 'income' or 'transfer'); null when it has none */
  category: string | null
  kind: string | null
  oneTime: boolean
  /** the venture the line is in, as the transactions list places it: a split part's own when it has one, else its transaction's */
  bucketId: number | null
  /** the whole line this is a part of, signed: a split part's amount, or the transaction's */
  lineCents: number
}

/**
 * Each ledger's classified lines by the month they run through, kept until its data moves (db.dataStamp). A line is
 * classified the same whichever day its span starts on: the habit rule reads the six months before its own, and
 * pay, debts and capital read all of history. And it's classified as its month's waterfall classifies it: every
 * span is read through its last month's end (cut on a day inside it, only a paycheck deposited in parts on both
 * sides of that day could read differently), from KEPT_MONTHS before that month at least. So lines kept from an
 * earlier start answer any span inside them, and the waterfall's month (its run rates reach back two years), the
 * summaries, the budget, the headline and Review's totals over any of the month's days classify once. Read only;
 * never changed by a caller.
 */
const ledgerKept = new WeakMap<object, { stamp: string; byEnd: Map<string, { fromDay: string; lines: LedgerLine[] }> }>()
/** How many months a ledger keeps lines through at once. */
const KEPT_SPANS = 6
/** How far back from its last month a span is classified at least: classifying more months costs little next to the first. */
const KEPT_MONTHS = 24

/**
 * The ledger's lines from one day to another (inclusive), oldest first, as classifyLines gives them, with each one's
 * payee, category, posting time and venture: what Personal's totals (summaries, the budget, the headline, Review's
 * spending_summary) and the waterfall's rows read, so they agree line for line. Read only.
 */
export function ledgerLines(fromDay: string, toDay: string): LedgerLine[] {
  if (toDay < fromDay) return []
  const stamp = db.dataStamp()
  const owner = db.currentConnection()
  if (stamp === null || !owner) return ledger(fromDay, toDay, withLine)
  let k = ledgerKept.get(owner)
  if (k?.stamp !== stamp) ledgerKept.set(owner, (k = { stamp, byEnd: new Map() }))
  const end = lastDayOf(toDay.slice(0, 7))
  const within = (lines: LedgerLine[]): LedgerLine[] => lines.filter((l) => l.day >= fromDay && l.day <= toDay)
  const hit = k.byEnd.get(end)
  if (hit && hit.fromDay <= fromDay) return within(hit.lines)
  const from = [fromDay, `${shiftMonth(toDay.slice(0, 7), -KEPT_MONTHS)}-01`].sort()[0]
  const lines = ledger(from, end, withLine)
  k.byEnd.delete(end)
  k.byEnd.set(end, { fromDay: from, lines })
  if (k.byEnd.size > KEPT_SPANS) k.byEnd.delete(k.byEnd.keys().next().value!)
  return within(lines)
}

/**
 * Whether a part in the ledger is Personal's to count: Personal's own, or a venture's whose intent gives it a class of
 * Personal's (rule 0: a gift that paid the venture's cost is the venture's line and a One-off of Personal's). A
 * venture's part with no intent, or with intent other, is venture, which only the Ventures terms read.
 */
export const personalPart = (l: Pick<ClassifiedLine, 'owner' | 'cls'>): boolean => l.owner === null || l.cls !== 'venture'

/** Personal's lines in the ledger from one day to another (inclusive): its parts of every line, at its share of each. Read only. */
export const personalLines = (fromDay: string, toDay: string): LedgerLine[] => ledgerLines(fromDay, toDay).filter(personalPart)

/**
 * Whether a classified part is a funding's (rule 0): a part beside a Personal line a venture's cash or card paid,
 * on the venture's account, that the line's own parts don't hold. Fundings are extra to the ledger's source lines.
 */
export const isFundPart = (l: Pick<ClassifiedLine, 'key' | 'txnId' | 'splitId'>): boolean => l.key.startsWith(`${l.txnId}:${l.splitId ?? ''}:p:fund`)

const withLine = (c: ClassifiedLine, l: Line): LedgerLine => ({ ...c, posted: l.posted, merchant: l.merchant, descKey: l.descKey, description: l.description, category: l.category, kind: l.kind, oneTime: l.oneTime === 1, bucketId: l.bucketId, lineCents: l.cents })

/** The first day a Personal cash or card account has a line on, or null with none: where Personal's history starts. */
export function firstLedgerDay(): string | null {
  const ids = [...accountsById()].filter(([, a]) => !a.hidden && a.bucketId === null && CASH_AND_CARDS.has(a.type) && !a.hsa).map(([id]) => id)
  if (!ids.length) return null
  const p = db.get<{ p: number | null }>(`SELECT MIN(posted) AS p FROM transactions WHERE account_id IN (${ids.map(() => '?').join(',')})`, ...ids)?.p ?? null
  return p === null ? null : db.dayKey(p)
}

/**
 * The lines from one day to another (inclusive) that an asset's uses give Personal a part of, as `txnId:splitId`: a
 * cost of a place Personal uses, which the owner rule may put in a venture. Only the days a use gives Personal a
 * share on are classified.
 */
export function usedByPersonal(fromDay: string, toDay: string): Set<string> {
  const out = new Set<string>()
  if (!db.upToDate()) return out
  const used = db.get<{ from: string | null; to: string | null }>(`SELECT MIN(from_day) AS "from", MAX(COALESCE(to_day, '9999-12-31')) AS "to" FROM asset_uses WHERE bucket_id IS NULL`)
  const last = db.get<{ p: number | null }>('SELECT MAX(posted) AS p FROM transactions')?.p ?? null
  if (!used?.from || !used.to || last === null) return out
  const from = used.from > fromDay ? used.from : fromDay
  const to = [used.to, toDay, db.dayKey(last)].sort()[0]
  for (const l of ledgerLines(from, to)) if (l.owner === null && l.assetId !== null) out.add(`${l.txnId}:${l.splitId ?? ''}`)
  return out
}

/**
 * Of some transactions, the ones with a line that's Personal's and meets `where` (a condition on TXN_LINES as t, with
 * its params): by the owner rule (lineOwner, with the legacy residence clause), or as a cost of a place Personal uses
 * on its day (usedByPersonal, read from one day to another only when a line the rule puts in a venture needs it).
 */
export function withPersonalLine(ids: string[], where: string, params: Array<string | number>, fromDay: string, toDay: string): Set<string> {
  const out = new Set<string>()
  if (!ids.length) return out
  const accts = accountsById()
  const homes = residences()
  const payroll = payrollKeys()
  let used: Set<string> | null = null
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const rows = db.all<{ id: string; splitId: number | null; accountId: string; day: string; bucketId: number | null; bucketSource: string | null; ownBucket: number; kind: string | null; categoryId: number | null; cents: number } & Payee>(
      `SELECT t.id, t.split_id AS splitId, t.account_id AS accountId, date(${db.localSql('t.posted')}) AS day, t.bucket_id AS bucketId, t.bucket_source AS bucketSource,
              COALESCE(s.own_bucket, 0) AS ownBucket, c.kind, t.category_id AS categoryId, t.amount_cents AS cents, t.merchant, t.desc_key AS descKey
       FROM ${db.TXN_LINES} t LEFT JOIN transaction_splits s ON s.id = t.split_id LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.id IN (${chunk.map(() => '?').join(',')}) AND ${where}`,
      ...chunk,
      ...params
    )
    for (const r of rows) {
      if (out.has(r.id)) continue
      const line = { ownBucket: r.ownBucket === 1, bucketId: r.bucketId, bucketSource: r.bucketSource, accountBucketId: accts.get(r.accountId)?.bucketId ?? null, day: r.day, income: r.kind === 'income', uncategorized: r.categoryId === null, cents: r.cents, merchant: r.merchant, descKey: r.descKey }
      const owner = lineOwner(line, homes, payroll)
      if (owner === null || (used ??= usedByPersonal(fromDay, toDay)).has(`${r.id}:${r.splitId ?? ''}`)) out.add(r.id)
    }
  }
  return out
}

/** The ledger's lines from one day to another, each made by `make` from its classified line and the line it is a part of. */
function ledger<T>(fromDay: string, toDay: string, make: (c: ClassifiedLine, l: Line) => T): T[] {
  if (toDay < fromDay) return []
  const { lines, ledgerParts, payLineOf, series, bonus } = classify(fromDay, toDay)
  const out: T[] = []
  for (const l of lines) {
    // The ledger: lines on perimeter accounts, and the Personal parts of lines on a venture's cash and card accounts.
    if (l.day < fromDay || !(l.perimeter || l.held)) continue
    for (const p of ledgerParts(l)) {
      // A venture's part of a line on the venture's own account isn't in the ledger.
      if (p.owner !== null && !l.perimeter) continue
      // A funding pays nothing of the line's series: it's money from the venture.
      const fund = p.suffix.startsWith(':fund')
      const line: ClassifiedLine = {
        key: `${l.id}:${l.splitId ?? ''}:${p.owner ?? 'p'}${p.suffix}`,
        txnId: l.id,
        splitId: l.splitId,
        owner: p.owner,
        day: l.day,
        accountId: l.accountId,
        perimeter: l.perimeter,
        cents: p.cents,
        cls: p.cls,
        categoryId: p.categoryId === undefined ? l.categoryId : p.categoryId,
        seriesKey: fund ? null : (series.get(l.id)?.key ?? null),
        paycheckKey: p.cls === 'pay' ? payrollKey(l) : null,
        assetId: p.assetId,
        debtId: p.debtId,
        shareBp: p.shareBp,
        estimated: p.estimated,
        ventureId: p.ventureId,
        intent: p.intent,
        intentSource: p.intentSource
      }
      const extra = p.cls === 'pay' ? (bonus.get(payLineOf(l, p)) ?? 0) : 0
      if (extra !== p.cents) out.push(make({ ...line, cents: p.cents - extra }, l))
      if (extra) out.push(make({ ...line, key: `${line.key}:bonus`, cents: extra }, l))
    }
  }
  return out
}

/** A venture's share of a cost an asset's uses share, or the principal of such a payment on a loan the venture owns. */
export interface VenturePart {
  bucketId: number
  txnId: string
  splitId: number | null
  accountId: string
  day: string
  cents: number
  assetId: string
  shareBp: number
  principal: boolean
}

/**
 * The ventures' parts of the lines an asset's uses share, on visible accounts and settled, oldest first, whoever
 * placed the whole line: what a venture's books count of those lines in place of the whole of each. A line no use
 * shares is whole, where db.bucketFlows reads it.
 */
export function ventureParts(bucketIds: number[]): VenturePart[] {
  const want = new Set(bucketIds)
  return sharedLines(bucketIds).flatMap((l) =>
    l.parts
      .filter((p) => p.owner !== null && want.has(p.owner))
      .map((p) => ({ bucketId: p.owner!, txnId: l.txnId, splitId: l.splitId, accountId: l.accountId, day: l.day, cents: p.cents, assetId: l.assetId, shareBp: p.shareBp, principal: p.principal }))
  )
}

/** A line an asset's uses share, with every owner's part of it (a loan payment's principal on its own). */
export interface SharedLine {
  txnId: string
  splitId: number | null
  accountId: string
  day: string
  assetId: string
  /** the venture the line is in (db.bucketFlows reads it there whole), or null */
  bucketId: number | null
  /** in a transfer category, which a venture's operating leaves out (a loan payment filed as one) */
  transfer: boolean
  parts: Array<{ owner: number | null; cents: number; shareBp: number; principal: boolean }>
}

/**
 * The lines an asset's uses share that touch one of the ventures, on visible accounts and settled, oldest first: in
 * one of them whole, or with a part that's one's. ventures.ts reads a venture's books from them in place of the
 * whole lines, and Personal's parts are its use of the venture's places. With no uses anywhere there are none.
 */
export function sharedLines(bucketIds: number[]): SharedLine[] {
  const want = new Set(bucketIds)
  if (!want.size || !db.upToDate() || !db.get('SELECT 1 FROM asset_uses LIMIT 1')) return []
  const span = db.get<{ first: number | null; last: number | null }>('SELECT MIN(posted) AS first, MAX(posted) AS last FROM transactions')
  if (!span || span.first === null || span.last === null) return []
  // A use shares a line only on a day it covers, so only the days from the first use to the last are classified: a
  // line's parts are the same whatever span it's classified in.
  const used = db.get<{ from: string; to: string }>(`SELECT MIN(from_day) AS "from", MAX(COALESCE(to_day, '9999-12-31')) AS "to" FROM asset_uses`)!
  const [first, last] = [db.dayKey(span.first), db.dayKey(span.last)]
  const fromDay = used.from > first ? used.from : first
  const toDay = used.to < last ? used.to : last
  if (toDay < fromDay) return []
  const c = classify(fromDay, toDay)
  const pending = new Set(db.all<{ id: string }>('SELECT id FROM transactions WHERE pending = 1').map((r) => r.id))
  const out: SharedLine[] = []
  for (const l of c.lines) {
    if (!c.shared(l) || pending.has(l.id) || c.ctx.accts.get(l.accountId)?.hidden !== false) continue
    const parts = c.partsOf(l)
    if (!(l.bucketId !== null && want.has(l.bucketId)) && !parts.some((p) => p.owner !== null && want.has(p.owner))) continue
    out.push({
      txnId: l.id,
      splitId: l.splitId,
      accountId: l.accountId,
      day: l.day,
      assetId: parts[0].assetId!,
      bucketId: l.bucketId,
      transfer: l.kind === 'transfer',
      parts: parts.map((p) => ({ owner: p.owner, cents: p.cents, shareBp: p.shareBp, principal: p.suffix === ':prin' }))
    })
  }
  return out
}

/** Rides and transit, which Transportation holds beside a car's service and repairs. */
const RIDES = /\b(?:uber|lyft|taxi|transit|metro|mta|bart|amtrak)\b/i

/** The match texts of the active policies on a home and on a vehicle (lower case, as insurance.ts saves them). */
interface PolicyTexts {
  home: string[]
  vehicle: string[]
}

function policyTexts(): PolicyTexts {
  const active = loadPolicies().filter((p) => p.status === 'active' && p.match)
  return { home: active.filter((p) => p.kind === 'home').map((p) => p.match!), vehicle: active.filter((p) => p.kind === 'auto' || p.kind === 'vehicle').map((p) => p.match!) }
}

const matchesPolicy = (l: Pick<Line, 'description' | 'merchant'>, texts: string[]): boolean => {
  if (!texts.length) return false
  const description = l.description.toLowerCase()
  const merchant = (l.merchant ?? '').toLowerCase()
  return texts.some((t) => description.includes(t) || merchant.includes(t))
}

/**
 * The kind of asset a cost is of by itself (1.0): a home's housing and utilities, or a charge its active home
 * policy matches; a vehicle's fuel and upkeep (the auto role), a charge its active auto or vehicle policy
 * matches, or Transportation that isn't a ride or transit.
 */
function assetKind(l: Pick<Line, 'category' | 'description' | 'merchant'>, role: CategoryRole | null, policies: PolicyTexts): 'property' | 'vehicle' | null {
  if (role === 'housing' || role === 'utilities' || matchesPolicy(l, policies.home)) return 'property'
  if (role === 'fuel' || role === 'auto' || matchesPolicy(l, policies.vehicle)) return 'vehicle'
  if ((l.category ?? '').toLowerCase() === 'transportation' && !RIDES.test(l.description)) return 'vehicle'
  return null
}

/** Personal's costs in the ledger from one day to another that are on no asset, with the kind of asset each is a cost of by itself. */
export function unattachedCosts(fromDay: string, toDay: string): Array<{ txnId: string; day: string; cents: number; kind: 'property' | 'vehicle' }> {
  if (toDay < fromDay) return []
  const c = classify(fromDay, toDay)
  const policies = policyTexts()
  const out: Array<{ txnId: string; day: string; cents: number; kind: 'property' | 'vehicle' }> = []
  for (const l of c.lines) {
    if (l.day < fromDay || !(l.perimeter || l.held) || l.cents >= 0 || l.kind === 'income' || l.kind === 'transfer') continue
    const kind = assetKind(l, categoryRole(l.category), policies)
    if (!kind) continue
    for (const p of c.partsOf(l)) if (p.owner === null && p.assetId === null && p.cls !== 'capital') out.push({ txnId: l.id, day: l.day, cents: p.cents, kind })
  }
  return out
}

/** One part of a line that is an asset's cost, whoever's it is and whichever account paid it. */
export interface AssetPart {
  txnId: string
  splitId: number | null
  day: string
  accountId: string
  owner: number | null
  cls: LineClass
  /** signed, as the account saw it */
  cents: number
  shareBp: number
  /** a loan payment's interest with escrow ('int') or principal ('prin'); '' for any other cost */
  part: '' | 'int' | 'prin'
  debtId: string | null
  /** for a loan payment's parts: the whole payment's escrow, positive */
  escrowCents: number
  categoryId: number | null
  category: string | null
  description: string
  merchant: string | null
  seriesKey: string | null
}

/**
 * Every part of the lines that are an asset's costs from one day to another, oldest first: those paid from the
 * ledger's accounts and from a venture's cash and cards. A line on any other account (an escrow payout on the
 * mortgage itself, which the payments' escrow already counts) isn't money paid to keep the asset. A payment on a
 * loan that the classifier keeps whole as a venture's money (a venture's loan paid with no use sharing the day, or a
 * loan paid from a venture's own account) is still the loan's interest with escrow and its principal: the cost is
 * the line's owner's, or the loan owner's when Personal paid it, and the principal the loan owner's.
 */
export function assetParts(assetId: string, fromDay: string, toDay: string): AssetPart[] {
  if (toDay < fromDay) return []
  const c = classify(fromDay, toDay)
  const out: AssetPart[] = []
  for (const l of c.lines) {
    if (l.day < fromDay || !(l.perimeter || l.held)) continue
    const escrow = c.escrowOf(l)
    const payment = c.paymentOf(l)
    for (const p of c.partsOf(l)) {
      if (p.assetId !== assetId || p.cls === 'capital') continue
      const line = { txnId: l.id, splitId: l.splitId, day: l.day, accountId: l.accountId, cls: p.cls, shareBp: p.shareBp, categoryId: l.categoryId, category: l.category, description: l.description, merchant: l.merchant, seriesKey: c.series.get(l.id)?.key ?? null }
      if (payment && p.suffix === '' && p.cls === 'venture') {
        const principal = (p.cents < 0 ? -1 : 1) * payment.split.principalCents
        out.push({ ...line, owner: p.owner ?? payment.owner, cents: p.cents - principal, part: 'int', debtId: payment.debtId, escrowCents: escrow })
        if (principal) out.push({ ...line, owner: payment.owner, cents: principal, part: 'prin', debtId: payment.debtId, escrowCents: escrow })
        continue
      }
      const part = p.suffix === ':int' ? 'int' : p.suffix === ':prin' ? 'prin' : ''
      out.push({ ...line, owner: p.owner, cents: p.cents, part, debtId: part ? p.debtId : null, escrowCents: part ? escrow : 0 })
    }
  }
  return out
}

/**
 * The classifier over some days. Rule 0 applies the money book's parts (moneyBook): the stored ones, and those its
 * remembered answers and inferences give. With `intents`, it applies those instead: the money book's own pass over
 * every day reads the boundary lines by the stored parts alone, before anything is inferred.
 */
function classify(fromDay: string, toDay: string, o: { intents?: Map<string, Stored[]> } = {}): Classified {
  // Read first: the money book's own pass classifies every day, and the context below would be read twice over.
  const money = o.intents ? null : moneyBook()
  const ctx = context()
  const { accts, payroll } = ctx
  // The habit rule reads the 6 months before the first month asked for.
  const start = db.dayStart(`${shiftMonth(fromDay.slice(0, 7), -6)}-01`)
  const lines = linesPosted(ctx, start, db.dayStart(addDays(toDay, 1)))
  const series = seriesByTxn()
  const tagged = taggedOneOff()
  const trips: TripWindow[] = tripWindows()
  const roles = new Map<number, CategoryRole | null>()
  const roleOf = (l: Line): CategoryRole | null => {
    if (l.categoryId === null) return null
    if (!roles.has(l.categoryId)) roles.set(l.categoryId, categoryRole(l.category))
    return roles.get(l.categoryId)!
  }
  const book = debtBook(ctx)

  // Rule 0's parts: what Review or the user said each boundary line is, or a remembered answer or an inference, where
  // it applies. A capital window skips only the lines whose own parts were stored: a line a remembered answer or an
  // inference gives an intent is a transfer with a venture, its cost or revenue, or a funding, none of which a window
  // takes, so the boundary lines the money book reads before inferring are the ones read here.
  const stored = money?.stored ?? o.intents!
  const given = money?.byLine ?? o.intents!
  /** Whether a line's transfer leg is on a perimeter account: a venture's own leg placed in Personal crosses on Personal's side. */
  const perimeterLeg = (l: Line): boolean => {
    const leg = legOf(ctx, l)
    const a = leg ? accts.get(leg.accountId) : undefined
    return !!a && inPerimeter(a, leg!.day.slice(0, 7))
  }
  /**
   * Whether a part given a line fits it, by what the line's own fields say before it's classified: a line's own (T, C,
   * R) while the line is on a perimeter account and is the venture's, or is a transfer with the venture's account or
   * debt, or has no leg on, and no debt of, any account that holds its money (R); a funding's while the line is on that
   * venture's cash or card with no leg on a perimeter account. Where an asset's uses may share a line among owners,
   * this says yes, and its parts (intentsOf, below) say.
   */
  const fitsLine = (l: Line, s: Stored): boolean => {
    if (s.face === 'fund') return l.held && accts.get(l.accountId)?.bucketId === s.ventureId && (l.owner === null || ctx.uses.size > 0) && !perimeterLeg(l)
    if (!l.perimeter) return false
    if (l.owner !== null) return l.owner === s.ventureId || ctx.uses.size > 0
    if (l.capitalAssetId) return false
    const link = book.links.get(lineId(l))
    const debtOwner = link ? (book.debts.get(link.debtId)?.owner ?? null) : null
    const leg = legOf(ctx, l)
    const a = leg ? accts.get(leg.accountId) : undefined
    if (leg && (!a || a.hidden)) return true
    if (link) return debtOwner === s.ventureId || ctx.uses.size > 0
    if (leg) return a!.bucketId === s.ventureId || ctx.stakes.get(leg.accountId) === s.ventureId
    return true
  }
  const intents = (l: Line): Applied | null => (given.size ? appliedOf(l, given, fitsLine) : null)
  /** A line whose own parts are its intents': a transfer with a venture, its cost or revenue, or a line tied to one. */
  const intended = (l: Line): boolean => !!intents(l)?.line.length
  const storedLine = (l: Line): boolean => stored.has(lineId(l)) && !!appliedOf(l, stored, fitsLine)?.line.length

  // Pay: deposits from a payroll into the ledger, Personal, not a transfer's leg, and no money with a venture that has
  // an intent (salary is pay by its intent). Its checks reach back before the span for bonus, with each salary part a
  // check of its own.
  const isPay = (l: Line): boolean => l.ledger && l.owner === null && l.cents > 0 && (l.kind === 'income' || l.categoryId === null) && !legOf(ctx, l) && payroll.has(payrollKey(l)) && !intended(l)
  const salaries = new Map<string, Line>()
  const paychecks = (list: Line[]): Line[] =>
    list.flatMap((l) => {
      const own = isPay(l) ? [l] : []
      const a = intents(l)
      if (!a) return own
      const parts = [...a.line.map((s) => ({ s, face: 'line' })), ...a.fund.map((s) => ({ s, face: 'fund' }))].filter((x) => x.s.intent === 'salary')
      return [
        ...own,
        ...parts.map(({ s, face }) => {
          const check = { ...l, cents: s.cents }
          salaries.set(`${lineId(l)}:${face}`, check)
          return check
        })
      ]
    })
  const salaried = [...given.values()].some((list) => list.some((s) => s.intent === 'salary'))
  const earlierPay = payroll.size || salaried ? paychecks(linesPosted(ctx, Number.MIN_SAFE_INTEGER, start, true)) : []
  const bonus = bonusOf([...earlierPay, ...paychecks(lines)], payroll.size || salaried ? stubDays() : new Map())
  const payLineOf = (l: Line, p: Part): Line => (p.intent === 'salary' ? (salaries.get(`${lineId(l)}:${p.suffix.startsWith(':fund') ? 'fund' : 'line'}`) ?? l) : l)

  // The draws each venture paid, by month, for a draw's regularity: a draw is regular when the venture paid one in
  // each of the 2 calendar months before its own. Only earlier months are read, so a closed month keeps its answer.
  const draws = new Map<number, Set<string>>()
  for (const l of lines) {
    const a = intents(l)
    if (!a) continue
    for (const s of [...a.line, ...a.fund]) {
      if (s.intent !== 'draw') continue
      let months = draws.get(s.ventureId)
      if (!months) draws.set(s.ventureId, (months = new Set()))
      months.add(l.day.slice(0, 7))
    }
  }
  const regular = (l: Line, s: Stored): boolean => {
    if (s.regular !== null) return s.regular
    const m = l.day.slice(0, 7)
    const months = draws.get(s.ventureId)
    return !!months && months.has(shiftMonth(m, -1)) && months.has(shiftMonth(m, -2))
  }
  const categories = new Map(db.listCategories().map((c) => [c.id, c.name]))
  /** Gifts & Donations, which a gift filed as a transfer or not at all is read as (rule 11). */
  const gifts = [...categories].find(([, name]) => name.toLowerCase() === 'gifts & donations')?.[0] ?? null
  /**
   * The category a gift out is counted in, by the habit rule: its line's when that's a category one-offs are kept in
   * by default (Shopping, Gifts & Donations), else Gifts & Donations, for a transfer's, none, a funding, or a cost of
   * the venture's it paid.
   */
  const giftCategory = (l: Line, fund: boolean): number | null => (!fund && oneOffByDefault(l.categoryId) ? l.categoryId : gifts)

  // The properties and vehicles each venture holds, for a cost its rules placed there (way 4 of section 3), and
  // Personal's, for a cost of Personal's one house or one vehicle (way 5, the single-asset rule of 1.0).
  const heldAssets = new Map<number | null, Acct[]>()
  for (const a of accts.values()) {
    if ((a.type !== 'property' && a.type !== 'vehicle') || a.hidden) continue
    const list = heldAssets.get(a.bucketId)
    if (list) list.push(a)
    else heldAssets.set(a.bucketId, [a])
  }
  /** The one property or vehicle (of a type, when one is named) an owner holds on a day, if it holds exactly one then. */
  const onlyAsset = (owner: number | null, day: string, type?: 'property' | 'vehicle'): string | null => {
    const open = (heldAssets.get(owner) ?? []).filter((a) => (!type || a.type === type) && (!a.openedDay || a.openedDay <= day) && (!a.closedDay || a.closedDay >= day))
    return open.length === 1 ? open[0].account.id : null
  }

  // Each payee's Personal lines by category and month, for the habit rule. A venture's line that's a cost of an asset
  // whose uses give Personal a share that day counts as Personal's part of it, as sharing (below) finds the asset: the
  // one a rule or a hand put it on, or the venture's one house or vehicle for a cost its rules placed. So a home's
  // costs that were Personal's by its residence dates still are, as Personal's use of it.
  // A gift a boundary line gave (rule 0) counts in the category it's read as, and a line whose own parts are its
  // intents' counts by none of its own.
  const habits = new Map<string, Array<{ month: string; cents: number }>>()
  const habitKey = (l: Line, categoryId: number | null = l.categoryId): string => `${categoryId}\u0000${payeeName(l)}`
  const habit = (key: string, month: string, cents: number): void => {
    const list = habits.get(key)
    if (list) list.push({ month, cents })
    else habits.set(key, [{ month, cents }])
  }
  const oneOffByDefault = (categoryId: number | null): boolean => categoryId !== null && ONE_OFF_BY_DEFAULT.has((categories.get(categoryId) ?? '').toLowerCase())
  const personalCents = (l: Line): number | null => {
    if (l.ledger && l.owner === null) return l.cents
    if (!(l.perimeter || l.held) || l.ownBucket || l.capitalAssetId || legOf(ctx, l)) return null
    const byHand = l.assetSource !== null && l.assetSource !== 'rule'
    const ruled = l.bucketSource !== 'user' && l.bucketSource !== 'ai'
    const assetId = l.assetId ?? (!byHand && ruled && l.placed !== null ? onlyAsset(l.placed, l.day) : null)
    if (!assetId || (!byHand && !ruled && l.bucketId !== null)) return null
    const use = periodOn(ctx.uses, assetId, l.day)
    return use?.owners.at(-1)?.owner === null ? fanOut(l.cents, use.owners).at(-1)!.cents : null
  }
  for (const l of lines) {
    const a = intents(l)
    for (const [list, fund] of a ? ([[a.line, false], [a.fund, true]] as const) : []) {
      for (const s of list) {
        if (s.intent !== 'gift' || s.cents >= 0) continue
        const categoryId = giftCategory(l, fund)
        if (oneOffByDefault(categoryId)) habit(habitKey(l, categoryId), l.day.slice(0, 7), s.cents)
      }
    }
    if (a?.line.length || l.category === null || !ONE_OFF_BY_DEFAULT.has(l.category.toLowerCase())) continue
    const cents = personalCents(l)
    if (cents !== null) habit(habitKey(l), l.day.slice(0, 7), cents)
  }

  /**
   * Rules 4 to 12 for a Personal line that isn't a transfer; 'debt' for rule 6, a payment found by a debt's payment
   * key. With `trade`, for rent, goods or services bought from or sold to a venture (rule 0): by its category alone,
   * never pay or a debt's payment.
   */
  const ruleClass = (l: Line, trade = false): LineClass | 'debt' => {
    const role = roleOf(l)
    const income = l.kind === 'income'
    if (l.cents > 0) {
      if (!trade && isPay(l)) return 'pay'
      if (role === 'returns' || ((income || l.categoryId === null) && accts.get(l.accountId)?.type === 'cash' && RETURNS.test(l.description))) return 'cashReturn'
      if (role === 'taxes') return 'tax'
      if (income && (l.oneTime === 1 || ONE_OFF_INCOME.test(l.category ?? '') || tagged.has(l.id))) return 'oneOffIncome'
    }
    if (income) return 'income'
    if (role === 'taxes') return 'tax'
    if (!trade && book.links.get(lineId(l))?.kind === 'payment') return 'debt'
    if (role === 'fees' && accts.get(l.accountId)?.type === 'credit_card') return 'debtCost'
    const s = series.get(l.id)
    if (s && (COMMITTED_KINDS.has(s.kind) || (s.kind === 'other' && s.confirmed))) return 'committed'
    // Bought on a trip: money out. A deposit or a refund then is still unsorted, or its category's.
    if (l.oneTime === 1 || (l.cents < 0 && tripAt(trips, l.posted))) return 'oneOff'
    if (l.categoryId === null) return 'unsorted'
    if (ONE_OFF_BY_DEFAULT.has((l.category ?? '').toLowerCase())) return habitEveryday(l.cents, l.day.slice(0, 7), habits.get(habitKey(l)) ?? []) ? 'everyday' : 'oneOff'
    return 'everyday'
  }
  const capital = allocateCapital(ctx, book, windowsOf(ctx, book), (l) => l.kind !== 'transfer' && ROUTINE.has(ruleClass(l) as LineClass), storedLine)

  const whole = (l: Line, cls: LineClass, o: Partial<Part> = {}): Part[] => [{ suffix: '', cents: l.cents, cls, owner: l.owner, assetId: null, debtId: null, estimated: false, shareBp: 10000, ventureId: null, intent: null, intentSource: null, ...o }]

  const policies = heldAssets.has(null) ? policyTexts() : { home: [], vehicle: [] }

  /**
   * The asset a line is a cost of, and how it came to be (AttachedBy, in that order). Income never is (rent goes to
   * its venture whole), nor capital, nor a transfer or a line paired with another leg, but for a loan payment.
   */
  const assetOf = (l: Line): { assetId: string; by: AttachedBy } | null => {
    if (l.kind === 'income' || l.capitalAssetId || capital.has(lineId(l))) return null
    const link = book.links.get(lineId(l))
    if (link?.kind === 'payment') {
      const asset = book.debts.get(link.debtId)!.linkedAssetId
      const a = asset ? accts.get(asset) : undefined
      if (a && COSTED.has(a.type)) return { assetId: asset!, by: 'loan' }
    }
    if (l.kind === 'transfer' || legOf(ctx, l)) return null
    // Put on an asset by hand, or taken off one: rules don't move it.
    if (l.assetSource !== null && l.assetSource !== 'rule') return l.assetId ? { assetId: l.assetId, by: 'hand' } : null
    if (l.assetId) return { assetId: l.assetId, by: 'rule' }
    if (l.placed !== null && !l.ownBucket && l.bucketSource !== 'user' && l.bucketSource !== 'ai' && ctx.uses.size) {
      const only = onlyAsset(l.placed, l.day)
      if (only && periodOn(ctx.uses, only, l.day)) return { assetId: only, by: 'venture' }
    }
    // A Personal cost of the kind a house or a vehicle has, when Personal holds just one of that kind then; with
    // more than one, only their loans' payments and the lines a rule or a hand puts on one are theirs. A cost the
    // venture rules place is the venture's place's, even while its residence dates make it Personal's.
    if (l.owner === null && l.placed === null && heldAssets.has(null)) {
      const kind = assetKind(l, roleOf(l), policies)
      const only = kind ? onlyAsset(null, l.day, kind) : null
      if (only) return { assetId: only, by: 'personal' }
    }
    return null
  }

  /**
   * The use period that shares an asset's cost among its owners on the line's day. A split part put in a venture of
   * its own keeps its owner, and a line placed in a venture by hand stays whole there (a listing fee, a repair for
   * the tenant alone) unless a hand also put it on the asset: a loan payment its loan puts there too, as migration
   * 41 put a home's costs in its residence dates on it.
   */
  const sharing = (l: Line, att: { assetId: string; by: AttachedBy } | null): UsePeriod | undefined => {
    if (!att || l.ownBucket) return undefined
    const byHand = att.by === 'hand' || (l.assetId === att.assetId && l.assetSource !== null && l.assetSource !== 'rule')
    if (!byHand && l.bucketId !== null && (l.bucketSource === 'user' || l.bucketSource === 'ai')) return undefined
    return periodOn(ctx.uses, att.assetId, l.day)
  }

  /**
   * A cost shared by an asset's uses (section 3): a loan payment is split into interest with escrow and principal
   * first; the cost (the interest and escrow, or the whole line) is shared over the owners of the day's use, and
   * the principal goes whole to the loan's owner, the asset's, with no second rounding. Personal's share takes the
   * class the line has as Personal's own; a venture's is venture.
   */
  const sharedParts = (l: Line, assetId: string, use: UsePeriod): Part[] => {
    const link = book.links.get(lineId(l))
    const s = link?.kind === 'payment' ? book.splits.get(lineId(l)) : undefined
    const debt = s ? book.debts.get(link!.debtId)! : null
    const sign = l.cents < 0 ? -1 : 1
    const principal = s ? sign * s.principalCents : 0
    const own = s ? 'debtCost' : ruleClass(l)
    const cls: LineClass = own === 'debt' ? 'debtCost' : own
    const debtId = debt?.id ?? (cls === 'debtCost' ? l.accountId : null)
    // A venture's part is money between Personal and it when Personal's account paid it: a cost of the venture's (C).
    const parts: Part[] = fanOut(l.cents - principal, use.owners)
      .filter((o) => o.cents !== 0)
      .map((o) => ({ suffix: s ? ':int' : '', cents: o.cents, cls: o.owner === null ? cls : 'venture', owner: o.owner, assetId, debtId, estimated: s?.estimated ?? false, shareBp: o.bp, ventureId: o.owner, intent: null, intentSource: null }))
    if (debt && principal) parts.push({ suffix: ':prin', cents: principal, cls: debt.owner === null ? 'principal' : 'venture', owner: debt.owner, assetId, debtId: debt.id, estimated: s!.estimated, shareBp: 10000, ventureId: debt.owner, intent: null, intentSource: null })
    return parts.length ? parts : whole(l, cls, { assetId })
  }

  /** A payment's interest and principal, or money borrowed; a venture's debt is the venture's, but for a payment on its place in the residence dates. */
  const debtParts = (l: Line, link: DebtLink): Part[] => {
    const d = book.debts.get(link.debtId)!
    const residence = d.owner !== null && l.owner === null && l.placed === d.owner
    // Paying or borrowing on a venture's debt is money with the venture (T); so is its principal in the residence dates (C).
    if (d.owner !== null && (link.kind === 'borrowing' || !residence)) return whole(l, 'venture', { ventureId: d.owner })
    if (link.kind === 'borrowing') return whole(l, 'principal', { debtId: d.id })
    const s = book.splits.get(lineId(l))!
    const sign = l.cents < 0 ? -1 : 1
    const principal: Part = residence
      ? { suffix: ':prin', cents: sign * s.principalCents, cls: 'venture', owner: d.owner, assetId: null, debtId: d.id, estimated: s.estimated, shareBp: 10000, ventureId: d.owner, intent: null, intentSource: null }
      : { suffix: ':prin', cents: sign * s.principalCents, cls: 'principal', owner: null, assetId: null, debtId: d.id, estimated: s.estimated, shareBp: 10000, ventureId: null, intent: null, intentSource: null }
    const cost: Part = { suffix: ':int', cents: sign * (s.interestCents + s.escrowCents), cls: 'debtCost', owner: null, assetId: null, debtId: d.id, estimated: s.estimated, shareBp: 10000, ventureId: null, intent: null, intentSource: null }
    // A part of nothing is left out; a payment of nothing is all principal.
    const parts = [cost, principal].filter((p) => p.cents !== 0)
    return parts.length ? parts : [principal]
  }

  /** The class, with the part a capital window took as capital (rule 3). */
  const withCapital = (l: Line, cls: LineClass, o: Partial<Part> = {}): Part[] => {
    const take = capital.get(lineId(l))
    if (!take) return whole(l, cls, o)
    if (take.cents === l.cents) return whole(l, 'capital', { assetId: take.assetId })
    return [...whole(l, cls, { ...o, cents: l.cents - take.cents }), { suffix: ':cap', cents: take.cents, cls: 'capital', owner: null, assetId: take.assetId, debtId: null, estimated: false, shareBp: 10000, ventureId: null, intent: null, intentSource: null }]
  }

  /**
   * A line's parts: shared by its asset's uses when they share it; otherwise by its owner and class, each part naming
   * the asset it's a cost of. On a day the asset's uses cover, they say who used it, not a residence's dates: a part
   * put in a venture of its own, or a line placed there by hand, stays the venture's whole.
   */
  const partsOf = (l: Line): Part[] => {
    const att = assetOf(l)
    const use = sharing(l, att)
    if (use) return sharedParts(l, att!.assetId, use)
    const placed = att && l.owner === null && l.placed !== null && periodOn(ctx.uses, att.assetId, l.day) ? { ...l, owner: l.placed } : l
    const parts = ownParts(placed)
    return att ? parts.map((p) => (p.assetId === null ? { ...p, assetId: att.assetId } : p)) : parts
  }

  /** A line's parts by its owner and class alone (rules 1 to 12). */
  const ownParts = (l: Line): Part[] => {
    // A venture's cost or revenue (C) on Personal's account: money between Personal and the venture.
    if (l.owner !== null) return whole(l, 'venture', { ventureId: l.owner })
    if (l.capitalAssetId) return whole(l, 'capital', { assetId: l.capitalAssetId })
    const link = book.links.get(lineId(l))
    const leg = legOf(ctx, l)
    if (leg) {
      const a = accts.get(leg.accountId)
      if (!a || a.hidden) return whole(l, 'orphan')
      if (link) return debtParts(l, link)
      // A transfer to or from a venture's account (T). A leg on a Stakes account linked to a venture is a leg on the
      // venture's own account.
      if (a.bucketId !== null || ctx.stakes.has(leg.accountId)) return whole(l, 'venture', { ventureId: a.bucketId ?? ctx.stakes.get(leg.accountId)! })
      if (inPerimeter(a, leg.day.slice(0, 7))) return whole(l, 'internal')
      if (INVESTED.has(a.type) || a.hsa) return whole(l, 'invested')
      if (ASSETS.has(a.type)) return whole(l, 'capital', { assetId: leg.accountId })
      // A Personal cash or card account outside its open dates.
      return whole(l, 'orphan')
    }
    if (l.kind === 'transfer') return link ? debtParts(l, link) : withCapital(l, 'orphan')
    const cls = ruleClass(l)
    if (cls === 'debt') return debtParts(l, link!)
    return withCapital(l, cls, cls === 'debtCost' ? { debtId: l.accountId } : {})
  }

  const paymentOf = (l: Line): { debtId: string; owner: number | null; split: LoanSplit } | null => {
    const link = book.links.get(lineId(l))
    const split = link?.kind === 'payment' ? book.splits.get(lineId(l)) : undefined
    return split ? { debtId: link!.debtId, owner: book.debts.get(link!.debtId)!.owner, split } : null
  }

  // ---------- rule 0: money between Personal and a venture ----------

  /**
   * The class an intent part takes on Personal's side (waterfall spec addendum 1.11), and the category it's counted in
   * when not its line's. `cents` is the part's, signed (out of Personal negative), and `fund` says it's a funding's.
   *   loan, equity, capital_return, reimbursement, a loan repayment's principal: capital (a claim or the stake, not spent)
   *   venture_loan, a venture loan repayment's principal: principal (money borrowed, and paid back)
   *   gift out: committed when it pays a confirmed series; oneOff when flagged one-time; else by the habit rule in its
   *     category, a transfer's, none or a funding's read as Gifts & Donations. gift in: oneOffIncome
   *   draw: income when regular (Review said so, or the venture paid a draw in each of the 2 months before), else oneOffIncome
   *   salary: pay, under the line's payroll key
   *   trade: by its category, as if bought from or sold to anyone; filed as a transfer, or not at all, it's unsorted
   *   other: venture, in the Ventures term as an unset part is
   */
  const intentClass = (l: Line, s: Stored, cents: number, fund: boolean): { cls: LineClass; categoryId?: number | null } => {
    const none = fund ? { categoryId: null } : {}
    switch (s.intent) {
      case 'loan':
      case 'loan_repayment':
      case 'equity':
      case 'capital_return':
      case 'reimbursement':
        return { cls: 'capital', ...none }
      case 'venture_loan':
      case 'venture_loan_repayment':
        return { cls: 'principal', ...none }
      case 'gift': {
        if (cents > 0) return { cls: 'oneOffIncome', ...none }
        const confirmed = !fund ? series.get(l.id) : undefined
        if (confirmed?.confirmed) return { cls: 'committed' }
        if (!fund && l.oneTime === 1) return { cls: 'oneOff' }
        const categoryId = giftCategory(l, fund)
        const at = categoryId === l.categoryId && !fund ? {} : { categoryId }
        // With no Gifts & Donations to read it as, a gift is a one-off.
        if (!oneOffByDefault(categoryId)) return { cls: 'oneOff', ...at }
        return { cls: habitEveryday(cents, l.day.slice(0, 7), habits.get(habitKey(l, categoryId)) ?? []) ? 'everyday' : 'oneOff', ...at }
      }
      case 'draw':
        return { cls: regular(l, s) ? 'income' : 'oneOffIncome', ...none }
      case 'salary':
        return { cls: 'pay', ...none }
      case 'trade': {
        if (fund || l.kind === 'transfer' || l.categoryId === null) return { cls: 'unsorted', ...none }
        const cls = ruleClass({ ...l, cents }, true)
        return { cls: cls === 'debt' ? 'everyday' : cls }
      }
      case 'other':
        return { cls: 'venture', ...none }
    }
  }

  /**
   * A boundary line's intent parts in place of `target`, its parts the intents are of: one part keeps the target's
   * key (the line's own when the target is several parts, as a venture's share of a payment's interest and its
   * principal), several each add their intent, and a repayment's interest adds :int (cashReturn on a loan to the
   * venture, debtCost on one from it). What the stored parts don't cover of the target, after an amount changed,
   * stays as it was: unset with the venture, or the line's own.
   */
  const intentPartsOf = (l: Line, list: Stored[], target: Part[], fund: boolean): Part[] => {
    const first = target[0]
    const base = fund ? ':fund' : target.length === 1 ? first.suffix : ''
    const owner = fund ? null : first.owner
    const several = list.length > 1
    const out: Part[] = []
    for (const s of list) {
      const tag = several ? `:${s.intent}` : ''
      const interest = interestOf(s)
      const principal = s.cents - interest
      const common = { owner, debtId: null, estimated: false, shareBp: fund ? 10000 : first.shareBp, ventureId: s.ventureId, intent: s.intent, intentSource: s.source }
      if (principal || !interest) {
        const c = intentClass(l, s, principal, fund)
        const claim = c.cls === 'capital' || c.cls === 'principal'
        out.push({ ...common, suffix: `${base}${tag}`, cents: principal, cls: c.cls, assetId: claim || fund ? null : first.assetId, ...('categoryId' in c ? { categoryId: c.categoryId } : {}) })
      }
      if (interest) out.push({ ...common, suffix: `${base}${tag}:int`, cents: interest, cls: s.intent === 'loan_repayment' ? 'cashReturn' : 'debtCost', assetId: null, ...(fund ? { categoryId: null } : {}) })
    }
    const covered = list.reduce((sum, s) => sum + s.cents, 0)
    // A funding is minus Personal's parts of the line: all of a Personal line, or its use share of a shared cost.
    const whole = fund ? -target.filter((p) => p.owner === null).reduce((sum, p) => sum + p.cents, 0) : target.reduce((sum, p) => sum + p.cents, 0)
    if (whole !== covered) {
      const v = list[0].ventureId
      const rest = fund || first.cls === 'venture' ? { cls: 'venture' as const, ventureId: v, assetId: fund ? null : first.assetId, debtId: null } : { cls: first.cls, ventureId: null, assetId: first.assetId, debtId: first.debtId }
      out.push({ suffix: `${base}:rest`, cents: whole - covered, owner, estimated: false, shareBp: fund ? 10000 : first.shareBp, intent: null, intentSource: null, ...rest, ...(fund ? { categoryId: null } : {}) })
    }
    return out
  }

  /**
   * A line's parts in the ledger (rule 0). A transfer with a venture, a venture's cost or revenue paid from or into
   * Personal's account, or a line Review tied to a venture is replaced by its intent parts, for each venture they
   * name: in place of the line's parts with that venture, or of the whole line when it has none (a line tied to one).
   * Personal's parts of a line a venture's cash or card paid keep their classes, and gain their funding's intent
   * parts. A boundary part with no intent is unset: Personal's parts of a line a venture's account paid then name the
   * venture themselves.
   */
  /**
   * The parts given a line that fit its parts by rules 1 to 12: a line's own while it has a part with their venture (T,
   * C), or no part with any venture, no debt and none an account of Personal's holds (R); a funding's while Personal
   * has parts of it. A part that doesn't fit counts nowhere, in the classes or in any venture's claims.
   */
  const fitted = new Map<Line, Applied | null>()
  const intentsOf = (l: Line): Applied | null => {
    if (fitted.has(l)) return fitted.get(l)!
    const a = intents(l)
    let out: Applied | null = null
    if (a) {
      const parts = partsOf(l)
      const tied = !book.links.has(lineId(l)) && parts.every((p) => p.ventureId === null && !HELD_BY_PERSONAL.has(p.cls))
      const line = a.line.filter((s) => parts.some((p) => p.cls === 'venture' && p.ventureId === s.ventureId) || tied)
      const fund = parts.reduce((s, p) => s + (p.owner === null ? p.cents : 0), 0) !== 0 ? a.fund : []
      out = line.length || fund.length ? { line, fund } : null
    }
    fitted.set(l, out)
    return out
  }

  const ledgerParts = (l: Line): Part[] => {
    let parts = partsOf(l)
    const a = intentsOf(l)
    const funded = !!a?.fund.length
    if (a?.line.length) {
      const byVenture = new Map<number, Stored[]>()
      for (const s of a.line) byVenture.set(s.ventureId, [...(byVenture.get(s.ventureId) ?? []), s])
      for (const [v, list] of byVenture) {
        let target = parts.filter((p) => p.cls === 'venture' && p.ventureId === v && p.intent === null)
        if (!target.length) target = parts.filter((p) => p.intent === null)
        if (!target.length) continue
        const made = intentPartsOf(l, list, target, false)
        const at = parts.indexOf(target[0])
        parts = [...parts.slice(0, at).filter((p) => !target.includes(p)), ...made, ...parts.slice(at).filter((p) => !target.includes(p))]
      }
    }
    if (funded) parts = [...parts, ...intentPartsOf(l, a!.fund, parts, true)]
    else if (l.held) {
      const v = accts.get(l.accountId)?.bucketId ?? null
      parts = parts.map((p) => (p.owner === null && p.ventureId === null ? { ...p, ventureId: v } : p))
    }
    return parts
  }

  return {
    ctx,
    lines,
    partsOf,
    ledgerParts,
    intentsOf,
    perimeterLeg,
    sideOf: (l) => legOf(ctx, l)?.accountId ?? book.links.get(lineId(l))?.debtId ?? null,
    payLineOf,
    capitalOf: (l) => capital.get(lineId(l)),
    shared: (l) => !!sharing(l, assetOf(l)),
    linked: (l) => book.links.has(lineId(l)),
    escrowOf: (l) => book.splits.get(lineId(l))?.escrowCents ?? 0,
    paymentOf,
    series,
    bonus
  }
}

/** A ledger line as a drill lists it: the classified line alone, without its payee, category and posting time. */
const classifiedOf = (l: LedgerLine): ClassifiedLine => ({
  key: l.key,
  txnId: l.txnId,
  splitId: l.splitId,
  owner: l.owner,
  day: l.day,
  accountId: l.accountId,
  perimeter: l.perimeter,
  cents: l.cents,
  cls: l.cls,
  categoryId: l.categoryId,
  seriesKey: l.seriesKey,
  paycheckKey: l.paycheckKey,
  assetId: l.assetId,
  debtId: l.debtId,
  shareBp: l.shareBp,
  estimated: l.estimated,
  ventureId: l.ventureId,
  intent: l.intent,
  intentSource: l.intentSource
})

/**
 * Classified lines a query picks, newest first, a page at a time (100 by default, at most 1000), with how many
 * matched and their sum. They're the ledger's kept lines (ledgerLines), the ones the waterfall's figures were added
 * from, so a drill opened beside Home, and every page of it after, reads them again only once the data changes.
 */
export function linesFor(q: LineQuery, page: { offset?: number; limit?: number } = {}): LinePage {
  if (!q || typeof q !== 'object' || !isRealDay(String(q.fromDay)) || !isRealDay(String(q.toDay))) throw new Error('fromDay and toDay must be dates like 2026-10-01')
  const cls = Array.isArray(q.cls) ? new Set(q.cls) : null
  const ids = Array.isArray(q.ids) ? new Set(q.ids.map(String)) : null
  const bonus = typeof q.bonus === 'boolean' ? q.bonus : null
  const payees = Array.isArray(q.payees) ? new Set(q.payees.map(String)) : null
  const lines = ledgerLines(q.fromDay, q.toDay)
    .filter(
      (l) =>
        (!cls || cls.has(l.cls)) &&
        (q.categoryId === undefined || l.categoryId === (q.categoryId === 'none' ? null : q.categoryId)) &&
        (q.seriesKey === undefined || l.seriesKey === q.seriesKey) &&
        (q.paycheckKey === undefined || l.paycheckKey === q.paycheckKey) &&
        (q.accountId === undefined || l.accountId === q.accountId) &&
        (q.assetId === undefined || l.assetId === q.assetId) &&
        (q.owner === undefined || l.owner === q.owner) &&
        (!ids || ids.has(l.txnId)) &&
        (bonus === null || l.key.endsWith(':bonus') === bonus) &&
        (!payees || payees.has(payeeName(l))) &&
        (q.ventureId === undefined || l.ventureId === q.ventureId) &&
        // Unset: a boundary part with no intent yet.
        (q.intent === undefined || (q.intent === 'unset' ? l.ventureId !== null && l.intent === null : l.intent === q.intent))
    )
    .reverse()
  const offset = Math.max(0, Math.floor(Number(page?.offset) || 0))
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(page?.limit) || 100)))
  return { lines: lines.slice(offset, offset + limit).map(classifiedOf), total: lines.length, cents: lines.reduce((s, l) => s + l.cents, 0) }
}
