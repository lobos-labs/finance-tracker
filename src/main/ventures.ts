import * as db from './db'
import { accountGain, accountMoves } from './investments'
import { sharedLines } from './lines'
import { paycheckClause, payrollKeys, residences, usePeriods } from './owners'
import { ownerMoneys, positionBook, type IntentPart } from './ventureMoney'
import { LEG_DAYS, PROCEEDS_DAYS, PURCHASE_DAYS } from './windows'
import { shiftDay } from '../shared/period'
import { daysBetween } from '../shared/zone'
import type { Account, AssetType, Bucket, BucketDetail, VentureAsset, VentureIntent, VentureResult } from '../shared/types'

// A venture's result: what it made or lost, its assets' gains included, with nothing counted twice.
//
// Buying and selling an asset show up in a bucket's cash either as transfers (left out already)
// or as spending and income, depending on how they were categorized. So money spent on or up to
// 90 days before an asset's purchase, and money received on its sale day or in the week after,
// is left out of operating; the asset counts once, by its gain: its value (the sale price once
// sold) less selling costs less its cost, realized once it's sold and on paper while it's owned.
// For a house that's all the spending and receipts in those dates, as it's always been. Anything
// else is often bought or sold in the middle of a business's or a rental's life, so only up to
// what buying it took in cash (its cost less the loans it was bought with) is left out, nearest
// the purchase day first, and only up to what the sale brought (its value then less selling costs
// and the loans paid off), nearest the sale day first; the rent and revenue around them stay in
// operating. Without a cost, only the purchase day's spending is taken as buying it.
//
// Money owed to you is lent and paid back rather than bought and sold. The money lent is left out
// of operating up to the amount lent, and so is what's come back of it (the amount lent less what's
// still owed, all of it once it's closed), from the first money in after it was lent. Its gain is
// what's been paid back and is still owed less what was lent: 0 for a loan repaid in full (any
// interest stays in operating), a loss for one written off.
//
// An investment account's gain is its returns, which keep the money put in and taken out apart
// from the gain (so dividends, contributions and withdrawals are handled, which value less cost
// can't do). Its own transactions are therefore left out of operating, and so is the other side
// of money moved between it and another of the user's accounts. Money it paid or received from
// none of them (a bill paid from its cash) stays in operating as the money it was.
//
// Loan payments are spending in full, so the principal (what each loan went down from its start,
// or from the venture's first record if that's later, to its payoff, the sale or today) is added
// back, up to the venture's spending in those dates: payments made outside its records (from
// Personal, as transfers, or before its records begin) never came out of operating. That
// principal is the equity paid down, and it's already inside the gains: an asset's cost includes
// its loan, so its gain is measured against the whole price whatever is still owed. It's given on
// its own and not added to the total again. An asset with no cost has no gain and the total goes
// without it (missingCost names it); what bought and sold it and its loans' principal are still
// left out of operating, since they aren't operating either way. Repairs and improvements stay in
// operating as the spending they were. A venture with no assets is its cash flow.
//
// A place's costs that an asset's uses share are the venture's by its share of them (lines.ts): a house with
// rooms rented while the user lives in it, a home the user lived in before renting it out. Its books read its
// parts of those lines in place of the whole lines, and Personal's parts are the venture's Personal use, which
// its operating leaves out: what they cost Personal over each use, so operating plus Personal use is what it
// would be if the venture bore those costs whole. A loan payment's principal stays with the venture that owns the
// loan, where the principal added back still covers it. A venture whose residence dates aren't a use yet (it has
// no house to put one on) leaves its costs in those dates out the same way, as Personal's.
//
// Money between the user and the venture changes operating only where its intent says what it was (waterfall spec
// addendum 1.11, the venture's books; ownerBooks below). The venture's own leg of a transfer with Personal is money
// between it and its owner, out of operating whatever its category, for a loan or its repayment, equity or a return
// of it, a gift, a draw, a reimbursement, or a loan from the venture or its repayment; salary and trade are its
// operating whatever their category, as wages, revenue or a cost; a repayment's interest is its cost when it repays
// the user, and its income when the user repays it. Money with no intent, or other, counts by its category as it
// always has, so a transfer stays out. Pay the paycheck clause keeps the user's, on an account the venture holds, is
// never the venture's (owners.ts).
//
// (This lives apart from db.ts because an investment account's gain comes from its returns, in
// investments.ts, which reads the database itself.)

/** What a venture counts a gain or loss for: what's bought, held and sold or closed (not cash or debts). */
const GAIN_TYPES: AssetType[] = ['property', 'vehicle', 'other_asset', 'venture', 'receivable', 'investment']

/** A line of a venture's cash flow as its result reads it: db.bucketFlows', a part of a cost a use shares, or money an intent puts in operating. */
type Flow = Pick<db.BucketFlow, 'bucketId' | 'accountId' | 'day' | 'cents' | 'txnId' | 'splitId' | 'income'>
type PersonalUse = VentureResult['personalUse'][number]
/** The intents whose money is the venture's operating whatever its category: its wages, its revenue or a cost. */
const OPERATING_INTENTS = new Set<VentureIntent | null>(['salary', 'trade'])
/** A flow, with the part of it not yet taken as buying, selling or lending something or as money moved. */
type Line = Flow & { left: number }
type ValueOn = (id: string, day: string) => number
/** How many times each key is still to be found. */
type Counts = Map<string, number>
/** Investment accounts' moves: the other sides (account, day and amount) and each account's own moves with no other side (day and amount). */
interface Moves {
  legs: Counts
  unpaired: Map<string, Counts>
}

const count = (c: Counts, key: string): void => void c.set(key, (c.get(key) ?? 0) + 1)
/** Whether the key is still to be found, counting it found. */
function take(c: Counts | undefined, key: string): boolean {
  const n = c?.get(key) ?? 0
  if (n > 0) c!.set(key, n - 1)
  return n > 0
}

/**
 * Every venture with its money in and out, its result's operating, gains and total, and its position today. Its
 * result's owner money lists the boundary lines that have an intent; the venture's own (getVenture) lists every one.
 */
export function listVentures(): Bucket[] {
  const buckets = db.listBuckets()
  const results = ventureResults(buckets, false)
  return buckets.map((b) => withResult(b, results.get(b.id)!))
}

/**
 * One venture: its cash flow by year, category and payee, its accounts and rules, its result and the money between
 * it and Personal, every boundary line with it among them, those with no intent yet too.
 */
export function getVenture(id: number): BucketDetail {
  const d = db.getBucket(id)
  const result = ventureResults([d.bucket], true).get(id)!
  return { ...d, bucket: withResult(d.bucket, result), result }
}

const withResult = (b: db.BucketCash, r: VentureResult): Bucket => ({ ...b, operatingCents: r.operatingCents, gainsCents: r.realizedCents + r.onPaperCents, totalCents: r.totalCents, positionCents: r.owner.positionCents })

/**
 * The buckets' results, from one read of their cash flow and one of their assets' and loans' values, each with the
 * money between it and Personal (ventureMoney.ts): its shares, claims, basis, stake and position today.
 */
function ventureResults(buckets: db.BucketCash[], unset: boolean): Map<number, VentureResult> {
  // One read of the intent parts for both: the owner money, and the operating they change.
  const book = positionBook(db.today())
  const owners = ownerMoneys(buckets.map((b) => b.id), db.today(), { unset, book })
  const results = operatingResults(buckets, book.parts)
  return new Map([...results].map(([id, r]) => [id, { ...r, owner: owners.get(id)! }]))
}

/** The buckets' results before the money between them and Personal, their operating as each one's intent parts (`parts`, by venture) change it. */
function operatingResults(buckets: db.BucketCash[], parts: ReadonlyMap<number, readonly IntentPart[]>): Map<number, Omit<VentureResult, 'owner'>> {
  const today = db.dayKey(db.now())
  const accounts = db.listAccounts()
  const ids = new Set(buckets.map((b) => b.id))
  const assets = accounts.filter((a) => a.bucketId !== null && ids.has(a.bucketId) && GAIN_TYPES.includes(a.assetType))
  const held = new Set(assets.map((a) => a.id))
  const loans = accounts.filter((d) => d.linkedAssetId !== null && held.has(d.linkedAssetId))
  // Every value is read on a purchase, payoff or sale day, a day within a loan's span, or today: one series from the earliest purchase or payoff covers all.
  const days = [...assets, ...loans].flatMap((a) => [a.openedDay, a.closedDay]).filter((d): d is string => !!d && d < today)
  const from = days.sort()[0] ?? today
  const series = held.size ? db.balancesOver([...held, ...loans.map((d) => d.id)], from, today, true) : { days: [], byId: new Map<string, number[]>() }
  const index = new Map(series.days.map((d, i) => [d, i]))
  const value: ValueOn = (id, day) => series.byId.get(id)?.[index.get(day) ?? -1] ?? 0
  const books = venturesBooks([...ids], accounts, today, parts)
  const moves = investedMoves(assets.filter((a) => a.assetType === 'investment'))
  return new Map(
    buckets.map((b) => [
      b.id,
      ventureResult(
        assets.filter((a) => a.bucketId === b.id),
        loans,
        books.flows.filter((f) => f.bucketId === b.id),
        books.personalUse.get(b.id) ?? [],
        value,
        today,
        moves
      )
    ])
  )
}

/**
 * The ventures' cash flow line by line, as their books read it: db.bucketFlows' lines, with each line an asset's
 * uses share replaced by the venture's parts of it (its share of the cost, the principal on its own loan), and the
 * costs the legacy residence clause makes Personal left out. With each venture's Personal use: for each use that
 * shares a place it owns or uses with Personal, Personal's parts of the costs over its days, and the residence
 * dates' costs of a venture whose dates aren't a use yet. Transfers stay out, as bucketFlows leaves them, and so does
 * pay the paycheck clause keeps the user's; the money between each venture and Personal counts as its intent parts
 * (`parts`, by venture) say (ownerBooks).
 */
function venturesBooks(ids: number[], accounts: Account[], today: string, parts: ReadonlyMap<number, readonly IntentPart[]>): { flows: Flow[]; personalUse: Map<number, PersonalUse[]> } {
  const want = new Set(ids)
  const shared = sharedLines(ids)
  const sharedKeys = new Set(shared.map((l) => `${l.txnId}:${l.splitId ?? ''}`))
  const homes = residences()
  const personalUse = new Map<number, PersonalUse[]>()
  const use = (bucketId: number, u: PersonalUse): void => void personalUse.set(bucketId, [...(personalUse.get(bucketId) ?? []), u])
  const legacy = new Map<number, PersonalUse>()
  for (const [id, home] of homes) if (want.has(id)) legacy.set(id, { assetId: null, fromDay: home.from, toDay: home.to ?? today, personalBp: 10000, cents: 0 })
  const byId = new Map(accounts.map((a) => [a.id, a]))

  // Pay on an account a venture holds that only the rules put in it is the user's (the paycheck clause): the
  // payrolls are read only when a line could be pay.
  let payroll: ReadonlySet<string> | null = null
  const usersPay = (f: db.BucketFlow): boolean => {
    const accountBucketId = byId.get(f.accountId)?.bucketId ?? null
    if (f.cents <= 0 || accountBucketId === null || f.ownBucket || !(f.income || f.uncategorized) || (f.bucketSource !== null && f.bucketSource !== 'rule')) return false
    return paycheckClause({ ...f, accountBucketId }, (payroll ??= payrollKeys()))
  }
  const cash = db.bucketFlows(ids).filter((f) => !sharedKeys.has(`${f.txnId}:${f.splitId ?? ''}`) && !usersPay(f))
  const owner = ownerBooks(parts, cash, want)

  const flows: Flow[] = []
  for (const line of cash) {
    // A venture's leg of money between it and Personal: as much of it as its intents leave in operating.
    const kept = owner.legs.get(`${line.txnId}:${line.splitId ?? ''}`)
    if (kept === 0) continue
    const f = kept === undefined ? line : { ...line, cents: kept }
    const home = homes.get(f.bucketId)
    if (home && !f.income && f.day >= home.from && f.day <= (home.to ?? '9999-12-31')) {
      legacy.get(f.bucketId)!.cents += f.cents
      continue
    }
    flows.push(f)
  }
  for (const l of shared) {
    if (l.transfer) continue
    for (const p of l.parts) if (p.owner !== null && want.has(p.owner)) flows.push({ bucketId: p.owner, accountId: l.accountId, day: l.day, cents: p.cents, txnId: l.txnId, splitId: l.splitId, income: false })
  }
  flows.push(...owner.added)

  for (const [assetId, periods] of usePeriods()) {
    const asset = byId.get(assetId)
    if (!asset) continue
    const sold = asset.closedDay && asset.closedDay <= today ? asset.closedDay : null
    for (const p of periods) {
      const personal = p.owners.find((o) => o.owner === null)
      if (!personal) continue
      const toDay = p.toDay === '9999-12-31' ? (sold ?? today) : p.toDay
      for (const bucketId of new Set([asset.bucketId, ...p.owners.map((o) => o.owner)])) {
        if (bucketId === null || !want.has(bucketId)) continue
        const cents = shared
          .filter((l) => !l.transfer && l.assetId === assetId && l.day >= p.fromDay && l.day <= p.toDay && (l.bucketId === bucketId || l.parts.some((x) => x.owner === bucketId)))
          .reduce((s, l) => s + l.parts.filter((x) => x.owner === null && !x.principal).reduce((t, x) => t + x.cents, 0), 0)
        use(bucketId, { assetId, fromDay: p.fromDay, toDay, personalBp: personal.bp, cents })
      }
    }
  }
  for (const [bucketId, u] of legacy) use(bucketId, u)
  for (const list of personalUse.values()) list.sort((a, b) => a.fromDay.localeCompare(b.fromDay) || (a.assetId ?? '').localeCompare(b.assetId ?? ''))
  return { flows, personalUse }
}

/** A boundary line's intent parts with one venture, on its face: the line's own, or its funding's. */
interface OwnerLine {
  ventureId: number
  txnId: string
  splitId: number | null
  face: 'line' | 'fund'
  day: string
  accountId: string
  parts: IntentPart[]
}

/**
 * What the money between Personal and the ventures does to their books (waterfall spec addendum 1.11, the venture's
 * books), from each boundary line's intent parts (`parts`, by venture: ventureMoney.ts's intentParts, so what a rule
 * or an inference gives a line counts here as a stored part does), against the ventures' cash flow line by line
 * (`cash`). Returns how much of each of a venture's own legs its operating keeps (by `txnId:splitId`; 0 leaves it
 * out), and the money its intents add to operating:
 *   - The venture's leg of a transfer with Personal (T), the line db.transferPairs pairs it with, leaves operating
 *     whatever its category, as far as the transfer's intents are a loan or its repayment, equity or its return, a
 *     gift, a draw, a reimbursement, or the venture's loan or its repayment: that's money between the venture and its
 *     owner, not money it made or spent. What other or no intent covers counts by the leg's category, as always.
 *   - Salary and trade are the venture's operating whatever their category, at the venture's side of them: wages or a
 *     cost when the money came to Personal, revenue when it went to the venture. Their leg leaves operating in their
 *     place, so they count once; a line Review tied to the venture (R), with no leg paired, finds its leg in the
 *     venture's books as the opposite amount within LEG_DAYS days, nearest first.
 *   - A repayment's interest is a cost of the venture's when it repays the user, and its income when the user repays
 *     its loan.
 * A cost or revenue of the venture's paid from or into Personal's money (C) is its own line, in its books as it is. A
 * Personal line the venture's cash or card paid (F) is Personal's, never in them; its funding's salary, trade and
 * interest count as a transfer's do, since that's the venture's money that paid them.
 */
function ownerBooks(parts: ReadonlyMap<number, readonly IntentPart[]>, cash: readonly db.BucketFlow[], want: ReadonlySet<number>): { legs: Map<string, number>; added: Flow[] } {
  const legs = new Map<string, number>()
  const added: Flow[] = []
  const lines = new Map<string, OwnerLine>()
  for (const [ventureId, list] of parts) {
    if (!want.has(ventureId)) continue
    for (const p of list) {
      const key = `${p.txnId}:${p.splitId ?? ''}:${p.face}:${ventureId}`
      const line = lines.get(key)
      if (line) line.parts.push(p)
      else lines.set(key, { ventureId, txnId: p.txnId, splitId: p.splitId, face: p.face, day: p.day, accountId: p.accountId, parts: [p] })
    }
  }
  if (!lines.size) return { legs, added }

  // Each boundary line's own row: its amount, and the venture it's in when it's the venture's own (C).
  const rows = new Map<string, { bucketId: number | null; cents: number }>()
  const ids = [...new Set([...lines.values()].map((l) => l.txnId))]
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const r of db.all<{ id: string; splitId: number | null; bucketId: number | null; cents: number }>(
      `SELECT t.id, t.split_id AS splitId, t.bucket_id AS bucketId, t.amount_cents AS cents FROM ${db.TXN_LINES} t WHERE t.id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk
    ))
      rows.set(`${r.id}:${r.splitId ?? ''}`, { bucketId: r.bucketId, cents: r.cents })
  }

  const books = new Map(cash.map((f) => [`${f.txnId}:${f.splitId ?? ''}`, f]))
  const ordered = [...lines.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (a.txnId < b.txnId ? -1 : a.txnId > b.txnId ? 1 : 0))
  // Transfers' legs, read once and only when a transfer with Personal has an intent: from LEG_DAYS days before the first such line to LEG_DAYS after the last.
  let pairs: Map<string, db.TransferLeg> | null = null
  const pairOf = (): Map<string, db.TransferLeg> => (pairs ??= db.transferPairs(shiftDay(ordered[0].day, -LEG_DAYS), shiftDay(ordered[ordered.length - 1].day, LEG_DAYS)).pairOf)
  const used = new Set<string>()
  for (const l of ordered) {
    const row = rows.get(`${l.txnId}:${l.splitId ?? ''}`)
    if (!row || (l.face === 'line' && row.bucketId === l.ventureId)) continue
    for (const p of l.parts) {
      const cents = OPERATING_INTENTS.has(p.intent) ? -p.cents : p.intent === 'loan_repayment' ? -p.interestCents : p.intent === 'venture_loan_repayment' ? p.interestCents : 0
      if (cents) added.push({ bucketId: l.ventureId, accountId: l.accountId, day: l.day, cents, txnId: l.txnId, splitId: l.splitId, income: cents > 0 })
    }
    if (l.face === 'fund' || l.splitId !== null) continue
    // The venture's own leg, when its books count it (in a category that isn't a transfer's).
    const paired = pairOf().get(l.txnId)
    let leg = paired && books.get(`${paired.id}:`)?.bucketId === l.ventureId ? `${paired.id}:` : null
    if (!paired && l.parts.some((p) => OPERATING_INTENTS.has(p.intent))) {
      let gap = LEG_DAYS + 1
      for (const f of cash) {
        const key = `${f.txnId}:`
        if (f.bucketId !== l.ventureId || f.splitId !== null || f.cents !== -row.cents || used.has(key) || pairOf().has(f.txnId)) continue
        const g = Math.abs(daysBetween(l.day, f.day))
        if (g < gap) {
          leg = key
          gap = g
        }
      }
    }
    if (!leg || used.has(leg)) continue
    used.add(leg)
    // What other or no intent covers stays as its category has it; the rest of the leg leaves operating.
    legs.set(leg, -row.cents + l.parts.reduce((s, p) => s + (p.intent === null || p.intent === 'other' ? 0 : p.cents), 0))
  }
  return { legs, added }
}

/** The investment accounts' own money put in and taken out, each paired with the other side on another of the user's accounts when there is one. */
function investedMoves(accounts: Account[]): Moves {
  const moves: Moves = { legs: new Map(), unpaired: new Map() }
  const used = new Set<string>()
  for (const a of accounts) {
    const own = accountMoves(a)
    const unpaired: Counts = new Map()
    moves.unpaired.set(a.id, unpaired)
    if (!own.length) continue
    const amounts = [...new Set(own.map((m) => -m.cents))]
    const others = db.all<{ key: string; accountId: string; day: string; cents: number }>(
      `SELECT t.id || ':' || COALESCE(t.split_id, '') AS key, t.account_id AS accountId, date(${db.localSql('t.posted')}) AS day, t.amount_cents AS cents
       FROM ${db.TXN_LINES} t WHERE t.pending = 0 AND t.account_id != ? AND t.amount_cents IN (${amounts.map(() => '?').join(',')})`,
      a.id,
      ...amounts
    )
    for (const m of own) {
      let best: (typeof others)[number] | undefined
      let gap = LEG_DAYS + 1
      for (const o of others) {
        if (o.cents !== -m.cents || used.has(o.key)) continue
        const g = Math.abs(daysBetween(m.day, o.day))
        if (g < gap) {
          best = o
          gap = g
        }
      }
      if (best) {
        used.add(best.key)
        count(moves.legs, `${best.accountId}|${best.day}|${best.cents}`)
      } else count(unpaired, `${m.day}|${m.cents}`)
    }
  }
  return moves
}

function ventureResult(assets: Account[], loans: Account[], flows: Flow[], personalUse: PersonalUse[], value: ValueOn, today: string, moves: Moves): Omit<VentureResult, 'owner'> {
  const soldOn = (a: Account): string | null => (a.closedDay && a.closedDay <= today ? a.closedDay : null)
  const debtsOf = (a: Account): Account[] => loans.filter((d) => d.linkedAssetId === a.id)
  const owedOn = (a: Account, day: string): number => debtsOf(a).reduce((s, d) => s + Math.max(0, -value(d.id, day)), 0)
  const lines: Line[] = flows.map((f) => ({ ...f, left: f.cents }))
  const first = flows.reduce<string | null>((d, f) => (d === null || f.day < d ? f.day : d), null)

  // Money moved between an investment account and another of the user's accounts, and the account's own transactions other than money from or to none of them, are inside its gain.
  for (const l of lines) {
    const key = `${l.day}|${l.cents}`
    if (take(moves.legs, `${l.accountId}|${key}`) || (moves.unpaired.has(l.accountId) && !take(moves.unpaired.get(l.accountId), key))) l.left = 0
  }

  /** Takes up to `cap` of the lines' money in (sign 1) or out (-1) within the dates, nearest `near` first, and returns how much. */
  function pull(sign: 1 | -1, fromDay: string, toDay: string, near: string, cap: number): number {
    let taken = 0
    const within = lines.filter((l) => Math.sign(l.left) === sign && l.day >= fromDay && l.day <= toDay).sort((x, y) => Math.abs(daysBetween(near, x.day)) - Math.abs(daysBetween(near, y.day)))
    for (const l of within) {
      if (taken >= cap) break
      const part = Math.min(cap - taken, Math.abs(l.left))
      l.left -= sign * part
      taken += part
    }
    return taken
  }

  let purchaseCents = 0
  let lentCents = 0
  for (const a of assets.filter((x) => x.openedDay && x.assetType !== 'investment').sort((x, y) => x.openedDay!.localeCompare(y.openedDay!))) {
    const day = a.openedDay!
    const house = a.assetType === 'property'
    // In cash, buying it took its cost less the loans it was bought with.
    const loaned = debtsOf(a).reduce((s, d) => s + Math.max(0, -value(d.id, d.openedDay ?? day)), 0)
    const cap = house || a.costCents === null ? Infinity : Math.max(0, a.costCents - loaned)
    const taken = pull(-1, house || a.costCents !== null ? shiftDay(day, -PURCHASE_DAYS) : day, day, day, cap)
    if (a.assetType === 'receivable') lentCents += taken
    else purchaseCents += taken
  }

  let proceedsCents = 0
  for (const a of assets.filter((x) => soldOn(x) && x.assetType !== 'investment' && x.assetType !== 'receivable').sort((x, y) => x.closedDay!.localeCompare(y.closedDay!))) {
    const day = soldOn(a)!
    // What the sale brought: its value then less selling costs and the loans paid off at closing.
    const cap = a.assetType === 'property' ? Infinity : Math.max(0, value(a.id, day) - (a.saleCostsCents ?? 0) - owedOn(a, day))
    proceedsCents += pull(1, day, shiftDay(day, PROCEEDS_DAYS), day, cap)
  }

  let repaidCents = 0
  const repaid = new Map<string, number>()
  for (const a of assets.filter((x) => x.assetType === 'receivable' && x.costCents !== null)) {
    const sold = soldOn(a)
    const lent = a.openedDay ?? first ?? today
    const back = pull(1, lent, sold ? shiftDay(sold, PROCEEDS_DAYS) : today, lent, Math.max(0, a.costCents! - (sold ? 0 : value(a.id, today))))
    repaid.set(a.id, back)
    repaidCents += back
  }

  let inCents = 0
  let outCents = 0
  for (const l of lines) {
    if (l.left > 0) inCents += l.left
    else outCents -= l.left
  }

  // What the venture spent from one day to another: all its loan payments then can have come out of.
  const spent = (fromDay: string, toDay: string): number => lines.reduce((s, l) => s + (l.left < 0 && l.day >= fromDay && l.day <= toDay ? -l.left : 0), 0)
  let principalCents = 0
  for (const a of assets) {
    const on = soldOn(a) ?? today
    for (const loan of debtsOf(a)) {
      const opened = loan.openedDay ?? a.openedDay
      if (!opened || !first) continue
      const start = opened > first ? opened : first
      const end = loan.closedDay && loan.closedDay < on ? loan.closedDay : on
      if (start > end) continue
      const paid = value(loan.id, end) - value(loan.id, start)
      if (!paid) continue
      principalCents += paid > 0 ? Math.min(paid, spent(start, end), Math.max(0, outCents - principalCents)) : paid
    }
  }

  const rows = assets.map((a): VentureAsset => {
    const sold = soldOn(a)
    // A sold asset is shown as of its sale (its sale value, its loans as they were at closing), as on the Assets page.
    const on = sold ?? today
    const lent = a.assetType === 'receivable'
    // Money owed to you is worth what's still owed, nothing once it's closed (repaid or written off).
    const valueCents = lent && sold ? 0 : value(a.id, on)
    const owedCents = owedOn(a, on)
    const back = lent ? (repaid.get(a.id) ?? 0) : null
    // An investment account's cost isn't a fixed price: money goes in and comes out over the years
    // and dividends are reinvested, so value less cost would count a deposit as a gain and a
    // withdrawal as a loss. Its returns measure the change in value less the money put in, over
    // its span (from its opening to its close or today); its cost is used only when they can't.
    const returns = a.assetType === 'investment' ? accountGain(a, a.openedDay, on) : null
    const byCost = a.costCents === null ? null : valueCents + (back ?? 0) - (sold ? (a.saleCostsCents ?? 0) : 0) - a.costCents
    return {
      id: a.id,
      name: a.name,
      assetType: a.assetType,
      boughtDay: a.openedDay,
      soldDay: sold,
      costCents: a.costCents,
      valueCents,
      saleCostsCents: a.saleCostsCents,
      repaidCents: back,
      gainCents: returns ?? byCost,
      gainFrom: returns === null ? 'cost' : 'returns',
      sold: sold !== null,
      owedCents,
      equityCents: valueCents - owedCents
    }
  })
  outCents -= principalCents
  const operatingCents = inCents - outCents
  const gains = (sold: boolean): number => rows.reduce((s, r) => s + (r.sold === sold ? (r.gainCents ?? 0) : 0), 0)
  const realizedCents = gains(true)
  const onPaperCents = gains(false)
  return {
    inCents,
    outCents,
    operatingCents,
    purchaseCents,
    proceedsCents,
    lentCents,
    repaidCents,
    principalCents,
    personalUse,
    assets: rows.sort((x, y) => (x.boughtDay ?? '').localeCompare(y.boughtDay ?? '') || x.name.localeCompare(y.name)),
    realizedCents,
    onPaperCents,
    missingCost: rows.filter((r) => r.gainCents === null).map((r) => r.name),
    totalCents: operatingCents + realizedCents + onPaperCents
  }
}
