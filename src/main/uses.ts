import * as db from './db'
import { assetParts, classifyLines, fanOut, residences, unattachedCosts, type AssetPart } from './lines'
import { loadPolicies } from './policies'
import { categoryRole } from '../shared/categoryRole'
import { addDays, isRealDay, shiftMonth } from '../shared/zone'
import type { Account, AssetUse, CarryingCost, CarryingKind, ClassifiedLine, LineAsset } from '../shared/types'

// Mixed use: who uses an asset, and so who pays its running costs. A house with rooms rented while the
// user lives in it is used 66% by the rental and 34% by Personal; a car driven partly for rideshare 35%
// and 65%. Each period names its days and each owner's share of them, and the classifier (lines.ts)
// shares every cost of the asset on those days by them: interest and escrow, dues, utilities, insurance,
// gas. The asset's owner keeps its value, its gain and the loan principal paid on it. Days no period
// covers are the owner's alone, as they always were. Review sets the uses (set_asset_use); there's no
// page to edit them. A home the user lived in while a venture held it became Personal's whole use of it
// (migration 41, from the venture's residence dates), which Review is asked to measure (shareQuestions).
// What an asset costs to keep a month, and each owner's part of it (carryingCost), is worked out here from the
// same lines, and so is which transactions are an asset's costs and Personal's share of each (lineAssets).

/** What a share can be measured by. */
export const USE_BASES: ReadonlyArray<NonNullable<AssetUse['basis']>> = ['rooms', 'area', 'miles', 'time', 'other']

/** A period as it's saved: an owner's share of the asset over days. */
export type UseRow = Omit<AssetUse, 'id' | 'assetId'>

/** An asset's use periods (every asset's when none is named), by day, ventures by id and Personal last on each. */
export function listUses(assetId?: string): AssetUse[] {
  return db.listAssetUses(assetId)
}

/** A house, a vehicle or another asset with costs of its own, or a plain refusal. */
function costedAsset(assetId: string): Account {
  const a = db.listAccounts().find((x) => x.id === assetId)
  if (!a) throw new Error(`No account ${assetId}`)
  if (!db.COSTED_ASSETS.includes(a.assetType)) throw new Error(`${a.name} isn't a house, a vehicle or another asset: only those have running costs to share`)
  return a
}

/**
 * Replaces an asset's use periods. Owners that share days share all of them: periods either cover the same days
 * or none in common, never part of each other's. On each period's days the shares add up to 100%, and each owner
 * is in it once. No rows clears the uses, so every day is the owner's alone again.
 */
export function saveUses(assetId: string, rows: UseRow[]): void {
  costedAsset(assetId)
  const ventures = new Set(db.listBuckets().map((b) => b.id))
  const spans = new Map<string, { fromDay: string; toDay: string; rows: UseRow[] }>()
  for (const r of rows) {
    if (!isRealDay(String(r.fromDay))) throw new Error(`A use starts on a date like 2025-02-01, not ${String(r.fromDay)}`)
    if (r.toDay !== null && !isRealDay(String(r.toDay))) throw new Error(`A use ends on a date like 2025-12-31 or not at all, not ${String(r.toDay)}`)
    if (r.toDay !== null && r.toDay < r.fromDay) throw new Error(`A use from ${r.fromDay} can't end before it starts (${r.toDay})`)
    if (r.bucketId !== null && !ventures.has(r.bucketId)) throw new Error(`No venture ${r.bucketId}`)
    if (!Number.isInteger(r.shareBp) || r.shareBp <= 0 || r.shareBp > 10000) throw new Error(`A share is more than 0% and at most 100%, in hundredths of a percent`)
    if (r.basis !== null && !USE_BASES.includes(r.basis)) throw new Error(`A share is measured by ${USE_BASES.join(', ')}`)
    const toDay = r.toDay ?? '9999-12-31'
    const key = `${r.fromDay}|${toDay}`
    const span = spans.get(key) ?? { fromDay: r.fromDay, toDay, rows: [] }
    spans.set(key, span)
    if (span.rows.some((x) => x.bucketId === r.bucketId)) throw new Error(`${ownerName(r.bucketId)} is in the use from ${r.fromDay} twice`)
    span.rows.push(r)
  }
  const sorted = [...spans.values()].sort((a, b) => a.fromDay.localeCompare(b.fromDay))
  sorted.forEach((s, i) => {
    const total = s.rows.reduce((t, r) => t + r.shareBp, 0)
    if (total !== 10000) throw new Error(`The shares from ${s.fromDay} add up to ${total / 100}%, not 100%`)
    const next = sorted[i + 1]
    if (next && next.fromDay <= s.toDay) throw new Error(`The use from ${next.fromDay} starts inside the one from ${s.fromDay}: owners who share days share all of them`)
  })
  db.replaceAssetUses(assetId, sorted.flatMap((s) => s.rows.map((r) => ({ fromDay: r.fromDay, toDay: r.toDay, bucketId: r.bucketId, shareBp: r.shareBp, basis: r.basis, source: r.source }))))
}

const ownerName = (bucketId: number | null): string => (bucketId === null ? 'Personal' : (db.listBuckets().find((b) => b.id === bucketId)?.name ?? `Venture ${bucketId}`))

/** Puts transactions (or one split part of one) on an asset by hand, or takes them off with null; rules don't move them after. */
export function attachToAsset(ids: string[], assetId: string | null, source: 'user' | 'ai' | 'migrated', splitId?: number): number {
  if (assetId !== null) costedAsset(assetId)
  return db.setTransactionsAsset(ids, assetId, source, splitId)
}

// ---------- carrying cost ----------

const ROW_ORDER: CarryingKind[] = ['interest', 'escrow', 'hoa', 'utilities', 'insurance', 'gas', 'repairs', 'principal']

/** A month's share of cents over 12 months, rounded half away from zero. */
const perMonth = (cents: number): number => Math.sign(cents) * Math.floor((Math.abs(cents) * 2 + 12) / 24)

/** Owners as a carrying cost's columns list them: Personal first, then ventures by id. */
const byColumn = (a: number | null, b: number | null): number => (a === null ? -1 : b === null ? 1 : a - b)
/** Owners as the fan-out orders them (lines.ts): ventures by id, then Personal, which takes what rounding leaves. */
const byFanOut = (a: number | null, b: number | null): number => (a === null ? 1 : b === null ? -1 : a - b)

/**
 * What a house, vehicle or other asset costs to keep, a month (section 3): each linked loan's interest, escrow and
 * principal from its latest payment, and the asset's other costs (its dues, utilities, insurance, gas, repairs)
 * as their average over the 12 full months before this one. Dues are its housing that recurs; insurance is a
 * charge in an insurance category or one a policy matches. Null for an account that isn't such an asset. Each row
 * is split by who bears it: each owner's parts of the costs as the asset's uses shared them, and the principal under
 * the loan's owner, the asset's. With uses sharing the costs, a row's cents are every owner's together.
 */
export function carryingCost(assetId: string): CarryingCost | null {
  const accounts = db.listAccounts()
  const a = accounts.find((x) => x.id === assetId)
  if (!a) throw new Error(`No account ${assetId}`)
  if (!db.COSTED_ASSETS.includes(a.assetType)) return null
  const today = db.today()
  const month = today.slice(0, 7)
  const fromDay = `${shiftMonth(month, -12)}-01`
  const toDay = addDays(`${month}-01`, -1)
  const parts = assetParts(assetId, fromDay, today)
  const totals = new Map<CarryingKind, { owners: Map<number | null, number>; withEscrow: boolean }>()
  const add = (kind: CarryingKind, owner: number | null, cents: number, withEscrow = false): void => {
    const t = totals.get(kind) ?? { owners: new Map<number | null, number>(), withEscrow: false }
    t.owners.set(owner, (t.owners.get(owner) ?? 0) + cents)
    totals.set(kind, { owners: t.owners, withEscrow: t.withEscrow || withEscrow })
  }

  // Each loan's latest payment: its interest with escrow and its principal, each owner's part as the uses shared it.
  // Only a loan that still owes something costs anything to keep: one paid off, or refinanced into another, is left out.
  const owing = (d: Account): boolean => (d.balanceCents ?? 0) < 0 && !(d.closedDay && d.closedDay <= today)
  for (const loan of accounts.filter((d) => d.linkedAssetId === assetId && !d.hidden && owing(d))) {
    const paid = parts.filter((p) => p.debtId === loan.id && p.part !== '')
    const last = paid.at(-1)
    if (!last) continue
    const payment = paid.filter((p) => p.txnId === last.txnId)
    // A payment is one line, or a split one's parts, each with its own escrow.
    for (const splitId of new Set(payment.map((p) => p.splitId))) {
      const line = payment.filter((p) => p.splitId === splitId)
      const costs = line.filter((p) => p.part === 'int')
      if (loan.escrowCents !== null) {
        // The line's escrow is shared as its interest and escrow were, so each owner's interest and escrow add up to its part.
        const escrow = fanOut(line[0].escrowCents, costs.map((p) => ({ owner: p.owner, bp: p.shareBp })))
        costs.forEach((p, i) => {
          add('interest', p.owner, -p.cents - escrow[i].cents)
          add('escrow', p.owner, escrow[i].cents)
        })
      } else for (const p of costs) add('interest', p.owner, -p.cents, true)
      for (const p of line.filter((p) => p.part === 'prin')) add('principal', p.owner, -p.cents)
    }
  }

  // The other costs over the 12 months, by what they are and whose they are.
  const policies = loadPolicies()
    .filter((p) => p.status === 'active' && p.match)
    .map((p) => p.match!)
  const kindOf = (p: AssetPart): CarryingKind => {
    const role = categoryRole(p.category)
    const text = `${p.description} ${p.merchant ?? ''}`.toLowerCase()
    if (role === 'insurance' || policies.some((m) => text.includes(m))) return 'insurance'
    if (role === 'utilities') return 'utilities'
    if (role === 'fuel') return 'gas'
    if (role === 'housing' && p.seriesKey !== null) return 'hoa'
    return 'repairs'
  }
  const sums = new Map<CarryingKind, Map<number | null, number>>()
  for (const p of parts) {
    if (p.part !== '' || p.day > toDay) continue
    const kind = kindOf(p)
    const owners = sums.get(kind) ?? new Map<number | null, number>()
    owners.set(p.owner, (owners.get(p.owner) ?? 0) - p.cents)
    sums.set(kind, owners)
  }
  // A month of each kind is the whole kind's average, shared as the fan-out shares a line: each owner but the last
  // gets the average of its own parts, and the last what's left, so the owners add up to the whole.
  for (const [kind, owners] of sums) {
    let left = perMonth([...owners.values()].reduce((s, c) => s + c, 0))
    const order = [...owners.keys()].sort(byFanOut)
    order.forEach((owner, i) => {
      const cents = i === order.length - 1 ? left : perMonth(owners.get(owner)!)
      left -= cents
      add(kind, owner, cents)
    })
  }

  const kept = ROW_ORDER.flatMap((kind) => {
    const t = totals.get(kind)
    const cents = t ? [...t.owners.values()].reduce((s, c) => s + c, 0) : 0
    return t && cents !== 0 ? [{ kind, cents, withEscrow: t.withEscrow, owners: t.owners }] : []
  })
  // The columns: everyone with a part of a row, else the asset's owner alone.
  const named = [...new Set(kept.flatMap((r) => [...r.owners].filter(([, c]) => c !== 0).map(([o]) => o)))].sort(byColumn)
  const owners = named.length ? named : [a.bucketId]
  const rows = kept.map((r) => ({ kind: r.kind, cents: r.cents, withEscrow: r.withEscrow, byOwner: owners.map((owner) => ({ owner, cents: r.owners.get(owner) ?? 0 })) }))
  return { assetId, owner: a.bucketId, shared: parts.some((p) => p.shareBp !== 10000), owners, fromDay, toDay, rows, costCents: rows.filter((r) => r.kind !== 'principal').reduce((s, r) => s + r.cents, 0) }
}

// ---------- share labels ----------

/**
 * The transactions that are an asset's costs, line by line (a split one's parts apart), with Personal's share of
 * each: every one in the history when no ids are named, else those. A line is an asset's cost as the classifier
 * finds it (a loan payment, an asset rule, a hand, a venture's one place, Personal's one house or car); the asset
 * a capital line bought or sold isn't. Personal's share is its part of the line's cost (a loan payment's interest
 * and escrow): its use share, 10000 when no use shares the line, 0 when another owner bears all of it, as it does
 * a payment from Personal's account on a venture's loan that no use shares (money to the venture). Only the
 * ledger's lines are read, so a venture's own line on its own account has none.
 */
export function lineAssets(ids?: string[]): LineAsset[] {
  const want = Array.isArray(ids) ? new Set(ids.map(String)) : null
  if (want && !want.size) return []
  if (!db.listAccounts().some((a) => db.COSTED_ASSETS.includes(a.assetType) && !a.hidden)) return []
  // The days the transactions were posted on, from the first to the last, are the only ones classified.
  const posted: number[] = []
  const ask = want ? [...want] : null
  for (let i = 0; i < (ask?.length ?? 1); i += 500) {
    const chunk = ask?.slice(i, i + 500) ?? []
    const span = db.get<{ first: number | null; last: number | null }>(`SELECT MIN(posted) AS first, MAX(posted) AS last FROM transactions${ask ? ` WHERE id IN (${chunk.map(() => '?').join(',')})` : ''}`, ...chunk)
    if (span && span.first !== null && span.last !== null) posted.push(span.first, span.last)
  }
  if (!posted.length) return []
  const byLine = new Map<string, ClassifiedLine[]>()
  for (const l of classifyLines(db.dayKey(Math.min(...posted)), db.dayKey(Math.max(...posted)))) {
    if (l.assetId === null || l.cls === 'capital' || (want && !want.has(l.txnId))) continue
    const key = `${l.txnId}:${l.splitId ?? ''}`
    byLine.set(key, [...(byLine.get(key) ?? []), l])
  }
  return [...byLine.values()].map((parts) => {
    const costs = parts.filter((p) => !p.key.endsWith(':prin'))
    // A payment that was all principal has no cost to share: it's all Personal's when Personal owns the loan. A Personal
    // line the classifier keeps whole as a venture's money bears none of the cost.
    const personal = (costs.length ? costs : parts).find((p) => p.owner === null && p.cls !== 'venture')
    const personalBp = !personal ? 0 : costs.length ? personal.shareBp : 10000
    return { txnId: parts[0].txnId, splitId: parts[0].splitId, assetId: parts[0].assetId!, personalBp }
  })
}

/**
 * A share of an asset's use that needs measuring: an asset's uses with no basis (migration 41's, from a venture's
 * residence dates, or one set without one), or a venture whose residence dates have no house to become a use of.
 */
export interface ShareQuestion {
  /** the asset whose uses aren't measured; null for a venture with no house */
  asset: Account | null
  uses: AssetUse[]
  /** the venture with residence dates and no house, and the dates */
  venture: { id: number; name: string; fromDay: string; toDay: string | null } | null
}

/**
 * One question per asset whose uses aren't measured, until each names its basis (rooms, area, miles), and one per
 * venture with residence dates and no house: all its costs in them count as Personal's until it has one. Nothing is
 * ever estimated from the rent.
 */
export function shareQuestions(): ShareQuestion[] {
  const accounts = db.listAccounts()
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const out: ShareQuestion[] = []
  const unmeasured = new Map<string, AssetUse[]>()
  for (const u of listUses()) if (u.basis === null) unmeasured.set(u.assetId, [...(unmeasured.get(u.assetId) ?? []), u])
  for (const [assetId, uses] of unmeasured) {
    const asset = byId.get(assetId)
    if (asset && !asset.hidden) out.push({ asset, uses, venture: null })
  }
  const housed = new Set(accounts.filter((a) => a.assetType === 'property' && a.bucketId !== null).map((a) => a.bucketId))
  const unhoused = [...residences()].filter(([id]) => !housed.has(id))
  if (!unhoused.length) return out
  const names = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM buckets').map((b) => [b.id, b.name]))
  for (const [id, home] of unhoused) out.push({ asset: null, uses: [], venture: { id, name: names.get(id) ?? `Venture ${id}`, fromDay: home.from, toDay: home.to } })
  return out
}

/** The houses or vehicles Personal holds more than one of, with Personal's costs of the last 12 months of that kind on no asset. */
export interface AttachQuestion {
  type: 'property' | 'vehicle'
  assets: Account[]
  count: number
  cents: number
  fromDay: string
  toDay: string
  txnIds: string[]
}

/**
 * Where Personal holds more than one open house, or vehicle, its costs of that kind (a home's housing, utilities
 * and insurance, a vehicle's fuel, upkeep and insurance) can't be put on one by themselves: Review is asked once
 * per kind to put them on the right one, by an asset rule or by hand. Only the last 12 months are read.
 */
export function attachQuestions(): AttachQuestion[] {
  const today = db.today()
  const accounts = db.listAccounts()
  const held = (type: AttachQuestion['type']): Account[] => accounts.filter((a) => a.assetType === type && !a.hidden && a.bucketId === null && !(a.closedDay && a.closedDay <= today) && !(a.openedDay && a.openedDay > today))
  const many = (['property', 'vehicle'] as const).map((type) => ({ type, assets: held(type) })).filter((x) => x.assets.length > 1)
  if (!many.length) return []
  const costs = unattachedCosts(addDays(today, -365), today)
  return many.flatMap(({ type, assets }) => {
    const mine = costs.filter((l) => l.kind === type)
    if (!mine.length) return []
    const days = mine.map((l) => l.day).sort()
    return [{ type, assets, count: mine.length, cents: mine.reduce((s, l) => s + l.cents, 0), fromDay: days[0], toDay: days[days.length - 1], txnIds: [...new Set(mine.map((l) => l.txnId))].slice(0, 30) }]
  })
}
