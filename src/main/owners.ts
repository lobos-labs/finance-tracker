import * as db from './db'
import { categoryRole } from '../shared/categoryRole'
import { payrollKey, type Payee } from '../shared/payroll'

// Who a line's money belongs to: a venture (its bucket id) or Personal (null). It is decided line by
// line, after a split transaction is opened into its parts, and not by the account the money moved
// through. The first of these that applies:
//   1. A split part put in a venture of its own, or in Personal of its own, is there.
//   2. Otherwise the transaction's venture, when it has one.
//   3. Otherwise a line on an account a venture holds is that venture's, unless the user or Review
//      placed it in Personal on purpose (bucket_source 'user' or 'ai').
//   4. Anything else is Personal.
// Pay is the user's wherever it lands (the paycheck clause, waterfall spec addendum 1.11): money in from a payroll
// on an account a venture holds stays Personal's while only the rules put it in the venture (bucket_source null or
// 'rule'), so Gross pay never loses a paycheck because its account was put in a venture. The user or Review can
// still place it in the venture on purpose.
// A place's costs while it was the user's home are their own housing. That is Personal's use of the place
// (asset_uses), which the classifier shares the place's costs by (lines.ts); migration 41 turned each venture's
// residence dates into one. A venture whose dates aren't converted yet, one with no house to put the use on,
// keeps the narrow legacy clause: its costs in its residence dates are Personal whichever venture the rules
// above name, and its income stays with the venture. A payment then on a loan of the place's is split first
// (lines.ts): its interest and escrow are Personal, its principal stays with the venture.
// The rule is here, apart from the classifier, so recurring.ts can read it and lines.ts can read
// recurring.ts with no import cycle; lines.ts exports it too.

/** One line, as the owner rule reads it: with its payee, for the paycheck clause. */
export interface OwnerLine extends Payee {
  /** a split part put in a venture (or in Personal) of its own */
  ownBucket: boolean
  /** the part's own venture when ownBucket, else the transaction's */
  bucketId: number | null
  /** the transaction's bucket_source: 'user' or 'ai' placed it by hand, 'rule' or null by rules */
  bucketSource: string | null
  /** the venture that holds the line's account, if one does */
  accountBucketId: number | null
  /** YYYY-MM-DD in the ledger's zone */
  day: string
  /** its category is an income one */
  income: boolean
  /** it has no category */
  uncategorized: boolean
  /** signed: money in is positive */
  cents: number
}

/**
 * The payrolls: what contributions and paystubs name, and every payee paid into a paycheck category. The classifier's
 * pay rule (lines.ts), the paycheck clause below and the series' owners (recurring.ts) read this one set, kept until
 * the ledger's data moves (db.dataStamp), as the classifier keeps its series. Read only; never changed by a caller.
 */
export function payrollKeys(): Set<string> {
  const stamp = db.dataStamp()
  const owner = db.currentConnection()
  if (stamp === null || !owner) return findPayrollKeys()
  const kept = payrollKept.get(owner)
  if (kept?.stamp === stamp) return kept.keys
  const keys = findPayrollKeys()
  payrollKept.set(owner, { stamp, keys })
  return keys
}

const payrollKept = new WeakMap<object, { stamp: string; keys: Set<string> }>()

function findPayrollKeys(): Set<string> {
  const keys = new Set<string>()
  for (const p of db.listContributionRows()) if (p.paycheckKey) keys.add(p.paycheckKey)
  // Books part way through their steps (a step's follow-up reads the series) have no paystubs before step 39, and
  // their split parts have no asset of their own before step 40: their lines are read whole then.
  if (db.schemaVersion() >= 39) for (const r of db.all<{ key: string }>('SELECT DISTINCT paycheck_key AS key FROM paystubs')) keys.add(r.key)
  const pay = db.listCategories().filter((c) => categoryRole(c.name) === 'paycheck').map((c) => c.id)
  const lines = db.schemaVersion() >= 40 ? db.TXN_LINES : 'transactions'
  if (pay.length) for (const r of db.all<Payee>(`SELECT DISTINCT t.merchant, t.desc_key AS descKey FROM ${lines} t WHERE t.amount_cents > 0 AND t.category_id IN (${pay.join(',')})`)) keys.add(payrollKey(r))
  return keys
}

/** Rule 4's payroll test: money in, filed as income or not at all, from one of the payrolls. */
export const fromPayroll = (l: Pick<OwnerLine, 'cents' | 'income' | 'uncategorized' | 'merchant' | 'descKey'>, payroll: ReadonlySet<string>): boolean =>
  l.cents > 0 && (l.income || l.uncategorized) && payroll.has(payrollKey(l))

/** The ventures whose residence dates still say when the user lived there (the legacy clause), by id: those days. */
export type Residences = Map<number, { from: string; to: string | null }>

/** The ventures the legacy clause covers: residence dates not yet Personal's use of a house (convertResidences). */
export function residences(): Residences {
  const rows = db.all<{ id: number; from: string; to: string | null }>(
    `SELECT id, residence_from AS "from", residence_to AS "to" FROM buckets WHERE residence_from IS NOT NULL${db.upToDate() ? ' AND residence_converted = 0' : ''}`
  )
  return new Map(rows.map((r) => [r.id, { from: r.from, to: r.to }]))
}

/** The venture rules 1 to 3 name for a line, before the residence clause; null for Personal. */
export function placedBucket(l: Pick<OwnerLine, 'ownBucket' | 'bucketId' | 'bucketSource' | 'accountBucketId'>): number | null {
  return l.ownBucket || l.bucketId !== null ? l.bucketId : l.bucketSource === 'user' || l.bucketSource === 'ai' ? null : l.accountBucketId
}

/**
 * The paycheck clause: pay on an account a venture holds that only the rules put in a venture (not a split part of
 * its own, not placed by hand) is the user's, so a venture's books leave it out (ventures.ts) and Gross pay keeps it.
 */
export const paycheckClause = (l: Pick<OwnerLine, 'ownBucket' | 'accountBucketId' | 'bucketSource' | 'cents' | 'income' | 'uncategorized' | 'merchant' | 'descKey'>, payroll: ReadonlySet<string>): boolean =>
  !l.ownBucket && l.accountBucketId !== null && (l.bucketSource === null || l.bucketSource === 'rule') && fromPayroll(l, payroll)

/** The venture a line belongs to, or null for Personal; `payroll` is payrollKeys(). */
export function lineOwner(l: OwnerLine, homes: Residences, payroll: ReadonlySet<string>): number | null {
  const placed = placedBucket(l)
  if (placed === null) return null
  // The paycheck clause: pay on a venture's account that only the rules put in a venture is the user's.
  if (paycheckClause(l, payroll)) return null
  const home = homes.get(placed)
  return home && !l.income && l.day >= home.from && l.day <= (home.to ?? '9999-12-31') ? null : placed
}

// ---------- uses ----------

/** An asset's use over some days (to inclusive): each owner's share of its costs then, ventures by id and Personal last. */
export interface UsePeriod {
  fromDay: string
  toDay: string
  owners: Array<{ owner: number | null; bp: number }>
}

/** Every asset's use periods, by asset. Owners sharing the same days are one period (uses.ts saves them so). */
export function usePeriods(): Map<string, UsePeriod[]> {
  const out = new Map<string, UsePeriod[]>()
  if (!db.upToDate()) return out
  for (const u of db.listAssetUses()) {
    let list = out.get(u.assetId)
    if (!list) out.set(u.assetId, (list = []))
    const toDay = u.toDay ?? '9999-12-31'
    let p = list.find((x) => x.fromDay === u.fromDay && x.toDay === toDay)
    if (!p) list.push((p = { fromDay: u.fromDay, toDay, owners: [] }))
    p.owners.push({ owner: u.bucketId, bp: u.shareBp })
  }
  for (const list of out.values()) for (const p of list) p.owners.sort((a, b) => (a.owner === null ? 1 : b.owner === null ? -1 : a.owner - b.owner))
  return out
}

/** The period of an asset's uses that covers a day, if one does. */
export const periodOn = (uses: Map<string, UsePeriod[]>, assetId: string, day: string): UsePeriod | undefined => uses.get(assetId)?.find((p) => day >= p.fromDay && day <= p.toDay)
