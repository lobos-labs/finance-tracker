import * as db from './db'
import { byTwoWeekGaps, cadenceOf } from './cadence'
import { lineOwner, payrollKeys, periodOn, placedBucket, residences, usePeriods, type OwnerLine, type Residences, type UsePeriod } from './owners'
import { payeeKey } from '../shared/payroll'
import type { Cadence, RecurringKind, RecurringSeries } from '../shared/types'
import { addMonths } from '../shared/zone'

// Finds charges and deposits that repeat on a schedule: subscriptions,
// bills, loan payments, paychecks. A series is one merchant in one
// direction (money in vs out) whose gaps match a cadence and whose amounts
// hold steady (looser for utilities and income, which vary).

const DAY = 86_400
const LOOKBACK_DAYS = 400

export const CADENCES: Array<{ id: Cadence; days: number; min: number; max: number; grace: number }> = [
  { id: 'weekly', days: 7, min: 5, max: 9, grace: 4 },
  { id: 'biweekly', days: 14, min: 12, max: 16, grace: 5 },
  { id: 'semimonthly', days: 15.2, min: 12, max: 19, grace: 5 },
  { id: 'monthly', days: 30.44, min: 25, max: 36, grace: 10 },
  { id: 'quarterly', days: 91.3, min: 80, max: 100, grace: 20 },
  { id: 'annual', days: 365.25, min: 340, max: 390, grace: 30 }
]

const BILL_CATEGORIES = new Set(['utilities', 'insurance', 'housing', 'education', 'taxes', 'health & medical', 'fees & interest'])
const VARIABLE_CATEGORIES = new Set(['utilities', 'gas & fuel'])
// Everyday spending that happens to repeat (the usual coffee shop) isn't a commitment, and
// card interest moves with the balance: they only count once the user confirms them or gives them a type.
const EVERYDAY_CATEGORIES = new Set(['dining out', 'coffee', 'groceries', 'gas & fuel', 'shopping', 'travel', 'fees & interest'])
export const LOAN = /\bloan\b|mortgage|auto ?pay.*(fin|lend)|lending|financial services|sallie|navient|nelnet|mohela|toyota fin|honda fin/i

interface Row {
  id: string
  key: string
  name: string
  merchant: string | null
  descKey: string
  posted: number
  cents: number
  category: string | null
  kind: string | null
  account: string
  accountId: string
  bucketId: number | null
  bucketSource: string | null
  accountBucketId: number | null
  /** the asset a rule or a hand put it on, and which ('rule', or 'user', 'ai' or 'migrated' by hand) */
  assetId: string | null
  assetSource: string | null
}

/** A split payment's part, as the owner rule reads it. */
interface Part {
  cents: number
  ownBucket: number
  bucketId: number | null
  kind: string | null
  /** an asset put on the part by hand */
  assetId: string | null
}

/** What sharing a line by an asset's uses reads: the uses, the loans' assets by payee key, and each venture's houses and vehicles. */
interface UseBook {
  uses: Map<string, UsePeriod[]>
  loanAsset: Map<string, string>
  held: Map<number, Array<{ id: string; openedDay: string | null; closedDay: string | null }>>
}

function useBook(): UseBook | null {
  const uses = usePeriods()
  if (!uses.size) return null
  const accounts = db.listAccounts()
  const costed = new Set(accounts.filter((a) => db.COSTED_ASSETS.includes(a.assetType)).map((a) => a.id))
  const loanAsset = new Map<string, string>()
  for (const d of accounts) if (d.paymentKey && d.linkedAssetId && costed.has(d.linkedAssetId) && !d.hidden && !loanAsset.has(d.paymentKey)) loanAsset.set(d.paymentKey, d.linkedAssetId)
  const held = new Map<number, Array<{ id: string; openedDay: string | null; closedDay: string | null }>>()
  for (const a of accounts) {
    if (a.bucketId === null || a.hidden || (a.assetType !== 'property' && a.assetType !== 'vehicle')) continue
    held.set(a.bucketId, [...(held.get(a.bucketId) ?? []), { id: a.id, openedDay: a.openedDay, closedDay: a.closedDay }])
  }
  return { uses, loanAsset, held }
}

/**
 * The use period that shares a line among its owners, as the classifier (lines.ts) finds it from what a series reads:
 * a payment on a loan linked to the asset (by the loan's payee key), a line a rule or a hand put on the asset, or a
 * cost the rules put in a venture that holds just that one house or vehicle, on a day the asset's uses cover. Income
 * and transfers but loan payments never are; a part in a venture of its own, and a line placed in a venture by hand
 * that no hand put on the asset, stay whole.
 */
function sharedBy(book: UseBook, r: Row, line: OwnerLine, part: Part | undefined): UsePeriod | undefined {
  const kind = part ? part.kind : r.kind
  if (line.ownBucket || kind === 'income') return undefined
  const assetId = part?.assetId ?? r.assetId
  const source = part?.assetId ? 'user' : r.assetSource
  const byHand = source !== null && source !== 'rule'
  const loan = r.cents < 0 ? book.loanAsset.get(r.key) : undefined
  let asset: string | null = null
  if (loan) asset = loan
  else if (kind === 'transfer') return undefined
  else if (byHand || assetId) asset = assetId
  else {
    const placed = placedBucket(line)
    const open = placed !== null && line.bucketSource !== 'user' && line.bucketSource !== 'ai' ? (book.held.get(placed) ?? []).filter((a) => (!a.openedDay || a.openedDay <= line.day) && (!a.closedDay || a.closedDay >= line.day)) : []
    if (open.length === 1) asset = open[0].id
  }
  if (!asset) return undefined
  if (!(byHand && assetId === asset) && line.bucketId !== null && (line.bucketSource === 'user' || line.bucketSource === 'ai')) return undefined
  return periodOn(book.uses, asset, line.day)
}

/** Which series a caller reads: Personal ones (the default), or every series with its owner (listRecurring, list_recurring and the checks that update a series). */
export type RecurringScope = 'personal' | 'all'

/** A series Personal views show: some of its latest payment is Personal's. */
export const isPersonal = (s: Pick<RecurringSeries, 'personalBp'>): boolean => s.personalBp > 0

/**
 * Who a series belongs to, from its latest payment (every line of it on that day): the owner of most
 * of that money, Personal on a tie, and Personal's share of it in basis points. A line an asset's uses
 * share counts for each owner by its share, so a home's bills are Personal's while the user lives there.
 */
function seriesOwner(latest: Row[], parts: Map<string, Part[]>, homes: Residences, payroll: ReadonlySet<string>, book: UseBook | null): Pick<RecurringSeries, 'owner' | 'personalBp'> {
  const byOwner = new Map<number | null, number>()
  for (const r of latest) {
    const base = { bucketSource: r.bucketSource, accountBucketId: r.accountBucketId, day: db.dayKey(r.posted), merchant: r.merchant, descKey: r.descKey }
    const lines: Array<{ cents: number; line: OwnerLine; part?: Part }> = parts
      .get(r.id)
      ?.map((p) => ({ cents: p.cents, part: p, line: { ...base, ownBucket: p.ownBucket === 1, bucketId: p.ownBucket === 1 ? p.bucketId : r.bucketId, income: p.kind === 'income', uncategorized: p.kind === null, cents: p.cents } })) ?? [
      { cents: r.cents, line: { ...base, ownBucket: false, bucketId: r.bucketId, income: r.kind === 'income', uncategorized: r.kind === null, cents: r.cents } }
    ]
    for (const { cents, line, part } of lines) {
      const use = book ? sharedBy(book, r, line, part) : undefined
      if (use) for (const o of use.owners) byOwner.set(o.owner, (byOwner.get(o.owner) ?? 0) + (Math.abs(cents) * o.bp) / 10000)
      else {
        const owner = lineOwner(line, homes, payroll)
        byOwner.set(owner, (byOwner.get(owner) ?? 0) + Math.abs(cents))
      }
    }
  }
  const total = [...byOwner.values()].reduce((t, c) => t + c, 0)
  let owner: number | null = null
  for (const [o, c] of byOwner) if (o !== null && c > (byOwner.get(owner) ?? 0)) owner = o
  return { owner, personalBp: total ? Math.round(((byOwner.get(null) ?? 0) * 10000) / total) : owner === null ? 10000 : 0 }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** When a series charged at `last` (unix) comes next: the same day of the month (noon, in the ledger's zone) for monthly and longer cadences. */
export function nextDate(last: number, cadence: Cadence, days: number): number {
  if (cadence === 'monthly' || cadence === 'quarterly' || cadence === 'annual') {
    const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12
    return db.noon(addMonths(db.dayKey(last), months))
  }
  return last + Math.round(days * DAY)
}

function autoKind(sign: number, category: string | null, categoryKind: string | null, name: string, monthlyAbs: number): RecurringKind {
  const cat = category?.toLowerCase() ?? ''
  if (categoryKind === 'transfer') return LOAN.test(name) ? 'loan' : 'transfer'
  if (sign > 0) return 'income'
  if (LOAN.test(name)) return 'loan'
  if (cat === 'subscriptions' || cat === 'fitness') return 'subscription'
  if (BILL_CATEGORIES.has(cat)) return 'bill'
  if (monthlyAbs <= 10000 && ['entertainment', 'fitness', 'shopping', 'other', 'personal care', 'education'].includes(cat)) return 'subscription'
  return 'other'
}

/**
 * A payee renamed partway (by the bank, or a new merchant name) carries on the
 * same series: a group joins an earlier one on the same account, or with the
 * same name, when it picks up where that one stopped at the same amount.
 */
function joinRenamed(groups: Row[][]): Row[][] {
  const info = groups
    .map((rows) => ({ rows, key: rows[rows.length - 1].key, account: rows[0].account, sign: Math.sign(rows[rows.length - 1].cents), first: rows[0].posted, last: rows[rows.length - 1].posted, amount: median(rows.slice(-3).map((r) => Math.abs(r.cents))) }))
    .sort((a, b) => a.first - b.first)
  const out: typeof info = []
  for (const g of info) {
    const prev = out.find(
      (p) => p.sign === g.sign && (p.account === g.account || p.key === g.key) && g.first > p.last && g.first - p.last <= 45 * DAY && Math.abs(p.amount - g.amount) <= Math.max(p.amount * 0.02, 100)
    )
    if (prev) Object.assign(prev, { rows: [...prev.rows, ...g.rows], key: g.key, last: g.last, amount: g.amount })
    else out.push({ ...g })
  }
  return out.map((g) => g.rows)
}

/** A series with the payments it was found from: one point per day, oldest first, and the transactions. */
export interface SeriesHistory {
  series: RecurringSeries
  points: Array<{ posted: number; cents: number }>
  ids: string[]
}

/**
 * `lookbackDays`: how far back to read (a yearly series needs two of its payments in it: renewals.ts reads two years).
 * `scope`: Personal series by default, so a venture's rent, mortgage and dues stay out of personal views; 'all' for every series.
 * `fromLast`: in place of a window ending today, each payee is judged on its payments in the 400 days before its own
 * latest one, so what a payee's past lines pay doesn't move as time passes with nothing new (the classifier's reading).
 */
export const detectRecurring = (o: { lookbackDays?: number; scope?: RecurringScope } = {}): RecurringSeries[] => recurringHistory(o).map((h) => h.series)

export function recurringHistory(o: { lookbackDays?: number; scope?: RecurringScope; fromLast?: boolean } = {}): SeriesHistory[] {
  const since = o.fromLast ? Number.MIN_SAFE_INTEGER : db.now() - (o.lookbackDays ?? LOOKBACK_DAYS) * DAY
  // Pending rows count: a paycheck that's arrived but not posted has still arrived.
  const rows = db.all<Omit<Row, 'key'>>(
    `SELECT t.id, COALESCE(t.merchant, t.description) AS name, t.merchant, t.desc_key AS descKey, t.posted, t.amount_cents AS cents,
            c.name AS category, c.kind AS kind, a.name AS account, a.id AS accountId,
            t.bucket_id AS bucketId, t.bucket_source AS bucketSource, a.bucket_id AS accountBucketId,
            ${db.upToDate() ? 't.asset_id' : 'NULL'} AS assetId, ${db.upToDate() ? 't.asset_source' : 'NULL'} AS assetSource
     ${db.VISIBLE_TXN_FROM}
     WHERE t.posted >= ? AND t.amount_cents != 0 AND COALESCE(t.merchant, t.desc_key) != ''
     ORDER BY t.posted`,
    since
  ).map((r): Row => ({ ...r, key: payeeKey(r) }))
  // Split payments' parts, for their owners: each part can be in a venture of its own.
  const parts = new Map<string, Part[]>()
  for (const p of db.all<Part & { id: string }>(
    `SELECT s.transaction_id AS id, s.amount_cents AS cents, s.own_bucket AS ownBucket, s.bucket_id AS bucketId, c.kind, ${db.upToDate() ? 's.asset_id' : 'NULL'} AS assetId
     FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id LEFT JOIN categories c ON c.id = s.category_id
     WHERE t.posted >= ?`,
    since
  )) {
    const list = parts.get(p.id)
    if (list) list.push(p)
    else parts.set(p.id, [p])
  }
  const homes = residences()
  const payroll = payrollKeys()
  const book = useBook()

  // One group per payee, direction and account, so the same payment seen on
  // two accounts (checking and the loan it pays) isn't added together.
  const byAccount = new Map<string, Row[]>()
  for (const r of rows) {
    const k = `${r.key}\u0000${r.account}`
    const g = byAccount.get(k)
    if (g) g.push(r)
    else byAccount.set(k, [r])
  }

  const overrides = db.recurringOverrides()
  const nowTs = db.now()
  const found: Array<{ series: RecurringSeries; transfer: boolean; points: SeriesHistory['points']; ids: string[] }> = []

  const fromLast = o.fromLast === true
  for (const whole of joinRenamed([...byAccount.values()])) {
    const cut = fromLast ? whole[whole.length - 1].posted - LOOKBACK_DAYS * DAY : Number.MIN_SAFE_INTEGER
    const list = fromLast ? whole.filter((r) => r.posted >= cut) : whole
    // A new row can carry the bank's raw text until it's named (a pending ACH, a row a rule
    // categorized): the series keeps the key and name of its latest named payment.
    const named = [...list].reverse().find((r) => r.merchant) ?? list[list.length - 1]
    // Likewise its category is its latest filed payment's: one that has just arrived with none yet (a sync before a
    // rule or Review has filed it) says nothing of what the series is, and would restate every month it paid.
    const filed = [...list].reverse().find((r) => r.category !== null) ?? list[list.length - 1]
    const key = named.key
    // One point per day (two charges on the same day are one payment).
    const byDay = new Map<string, { posted: number; cents: number }>()
    for (const r of list) {
      const k = db.dayKey(r.posted)
      const cur = byDay.get(k)
      byDay.set(k, cur ? { posted: cur.posted, cents: cur.cents + r.cents } : { posted: r.posted, cents: r.cents })
    }
    const points = [...byDay.values()]
    if (points.length < 2) continue

    const gaps = points.slice(1).map((p, i) => (p.posted - points[i].posted) / DAY)
    const med = median(gaps)
    let cadence = CADENCES.find((c) => med >= c.min && med <= c.max)
    if (!cadence) continue
    if (cadence.id === 'biweekly' || cadence.id === 'semimonthly') {
      // Two weeks or half a month apart: told by the days themselves, one weekday or two days of the month, as a
      // payroll's checks a year are (cadence.ts), else by how many gaps are two weeks. Payments this far apart are
      // one or the other, so a bill charged once more than usual never reads as weekly.
      const read = cadenceOf([...byDay.keys()])
      const told = read === 'biweekly' || read === 'semimonthly' ? read : byTwoWeekGaps(gaps)
      cadence = CADENCES.find((c) => c.id === told)!
    }
    if (points.length < (cadence.id === 'annual' ? 2 : 3)) continue

    // Regular: most gaps fit the cadence, allowing for one skipped period.
    const fits = gaps.filter((g) => (g >= cadence.min && g <= cadence.max) || (g >= 2 * cadence.min && g <= 2 * cadence.max)).length
    if (fits / gaps.length < 0.75) continue

    const sign = points[points.length - 1].cents < 0 ? -1 : 1
    // Paychecks shift with raises and benefit elections, and a first check is often
    // partial: judge them by the latest few deposits, allowing one that's off.
    const paycheck = sign > 0 && filed.kind !== 'transfer'
    const recent = points.slice(paycheck ? -4 : -6).map((p) => Math.abs(p.cents))
    const typical = median(paycheck ? recent.slice(-3) : recent)
    // Cents-sized fees (foreign transaction) aren't worth tracking.
    if (typical < 100) continue
    const category = filed.category
    const o = overrides.get(key)
    if (EVERYDAY_CATEGORIES.has(category?.toLowerCase() ?? '') && o?.status !== 'confirmed' && !o?.kind) continue
    // Card payments and transfers between own accounts naturally vary.
    let variable = VARIABLE_CATEGORIES.has(category?.toLowerCase() ?? '') || filed.kind === 'transfer'
    const tol = variable ? 0.4 : sign > 0 ? 0.25 : 0.15
    const within = (t: number): number => recent.filter((a) => Math.abs(a - typical) <= Math.max(typical * t, 150)).length
    const steady = within(tol)
    if (paycheck ? steady < recent.length - 1 : steady / recent.length < 0.7) {
      // A bill that comes like clockwork still counts when its amount moves
      // (insurance re-rated, a policy change); it's shown as approximate.
      const clockwork = fits === gaps.length && points.length >= 4
      if (!(sign < 0 && clockwork && BILL_CATEGORIES.has(category?.toLowerCase() ?? '') && within(0.4) / recent.length >= 0.5)) continue
      variable = true
    }

    const last = points[points.length - 1]
    const prev = points[points.length - 2]
    const lastDay = db.dayKey(last.posted)
    const next = nextDate(last.posted, cadence.id, cadence.days)
    const overdue = (nowTs - next) / DAY
    const status = overdue > cadence.grace + cadence.days ? 'stopped' : overdue > cadence.grace ? 'late' : 'active'
    const delta = Math.abs(Math.abs(last.cents) - Math.abs(prev.cents))
    const priceChanged = !variable && delta >= Math.max(50, Math.abs(prev.cents) * 0.02)
    // After a price change the new price is what to expect next.
    const expected = priceChanged ? Math.abs(last.cents) : typical
    const monthlyCents = Math.round((sign * expected * 30.44) / cadence.days)
    const name = o?.name || named.name

    found.push({
      transfer: filed.kind === 'transfer',
      points,
      ids: list.map((r) => r.id),
      series: {
      key,
      name,
      kind: o?.kind ?? autoKind(sign, category, filed.kind, name, Math.abs(monthlyCents)),
      cadence: cadence.id,
      typicalCents: sign * Math.round(expected),
      lastCents: last.cents,
      previousCents: prev.cents,
      priceChanged,
      variable,
      monthlyCents,
      lastDate: last.posted,
      nextDate: next,
      count: points.length,
      status,
      confirmed: o?.status === 'confirmed',
      dismissed: o?.status === 'dismissed',
      categoryName: category,
      accountName: list[list.length - 1].account,
      accountId: list[list.length - 1].accountId,
      pairAccountId: null,
      pairAccountName: null,
      ...seriesOwner(list.filter((r) => db.dayKey(r.posted) === lastDay), parts, homes, payroll, book)
      }
    })
  }

  // The same money seen twice (both sides of a transfer, a loan payment on
  // checking and on the loan): keep one, and remember the other side's account.
  // Personal's side comes first, whatever its category: money moved between a
  // venture's account and the user's own is Personal's on the user's side, so
  // a top-up filed as a transfer on checking still leaves checking when the
  // venture's side is uncategorized or income. Then the side that isn't a
  // transfer, the confirmed one, and the inflow.
  found.sort(
    (a, b) =>
      Number(isPersonal(b.series)) - Number(isPersonal(a.series)) ||
      Number(a.transfer) - Number(b.transfer) ||
      Number(b.series.confirmed) - Number(a.series.confirmed) ||
      Number(b.series.typicalCents > 0) - Number(a.series.typicalCents > 0)
  )
  const out: SeriesHistory[] = []
  const kept: typeof found = []
  const keys = new Set<string>()
  for (const f of found) {
    const s = f.series
    const twin = kept.find(
      (k) =>
        (k.transfer || f.transfer) &&
        k.series.cadence === s.cadence &&
        Math.abs(k.series.lastDate - s.lastDate) <= 3 * DAY &&
        Math.abs(Math.abs(k.series.typicalCents) - Math.abs(s.typicalCents)) <= Math.max(Math.abs(s.typicalCents) * 0.01, 100)
    )
    if (twin) {
      if (twin.series.accountId !== s.accountId && !twin.series.pairAccountId && Math.sign(twin.series.typicalCents) !== Math.sign(s.typicalCents))
        Object.assign(twin.series, { pairAccountId: s.accountId, pairAccountName: s.accountName })
      // The venture's side may be the one the user confirmed, dismissed or renamed (it was the side kept before
      // Personal's came first): the side kept takes that choice when it has none of its own. Not its kind, which
      // could make the venture's mortgage a Personal bill.
      const theirs = overrides.get(s.key)
      if (theirs && twin.series.owner !== s.owner && !overrides.has(twin.series.key))
        Object.assign(twin.series, {
          confirmed: theirs.status === 'confirmed',
          dismissed: theirs.status === 'dismissed',
          ...(theirs.name ? { name: theirs.name } : {})
        })
      continue
    }
    // The same payee on two accounts at once: the second one gets its own key.
    const shown = keys.has(s.key) ? { ...s, key: `${s.key}|${s.accountName}` } : s
    kept.push({ ...f, series: shown })
    out.push({ series: shown, points: f.points, ids: f.ids })
    keys.add(s.key)
  }

  const order: Record<RecurringSeries['status'], number> = { active: 0, late: 1, stopped: 2 }
  // Keys are given out over every series first, so a series keeps its key in every scope.
  const shown = o.scope === 'all' ? out : out.filter((h) => isPersonal(h.series))
  return shown.sort((a, b) => order[a.series.status] - order[b.series.status] || a.series.nextDate - b.series.nextDate)
}
