import * as db from './db'
import { positionBook, positionsOn, shareOn, valuesOver, type PositionBook } from './ventureMoney'
import { addDays, daysBetween, daysInMonth } from '../shared/zone'
import { SHEET_GROUP_OF, SHEET_GROUPS, type BalanceSheet, type BucketSelection, type NetWorthPoint, type NetWorthSeries } from '../shared/types'

// Personal net worth (waterfall spec addendum 1.11, sub-phase 1j): on any day, the visible Personal accounts (in no
// venture, not linked to a venture's asset, and not a Stakes account linked to a venture) at their balances as the
// one walk of balances has them (db.balancesOver), plus every venture's position that day (ventureMoney.ts). The net
// worth series, the balance sheet and net worth now all read it, and the bridge reads the same accounts and positions
// (waterfall.ts), so the Overview's line is the bridge's net worth at every month's end. With every share migrated,
// each venture's position is what its accounts hold or nothing, so these are what they were before 1j.
//
// This lives apart from db.ts because a venture's position reads its intent parts (ventureMoney.ts's intentParts),
// which from 1j's part 2 on reads the classifier.

/**
 * Whether an account counts whole in net worth on every day from one to another: a Personal one, or one a venture
 * holds whose stake is all the user's by its books on each of those days, so that what the account moves moves net
 * worth by as much.
 */
function countsWhole(book: PositionBook): (accountId: string, fromDay: string, toDay: string) => boolean {
  const personal = new Set(book.personal)
  const heldBy = new Map<string, db.VentureHolding>()
  for (const v of book.ventures) if (v.valueSource === 'books' && v.accounts.length) for (const id of v.reads) heldBy.set(id, v)
  return (accountId, fromDay, toDay) => {
    if (personal.has(accountId)) return true
    const v = heldBy.get(accountId)
    return !!v && shareOn(v.shares, fromDay) === 10000 && v.shares.every((s) => s.fromDay <= fromDay || s.fromDay > toDay || s.shareBp === 10000)
  }
}

/**
 * Daily net worth, from the day before the earliest thing known about any account to today. Personal's (no venture
 * named) is the visible Personal accounts, a balance of their own or not, each at its balance as balancesOver walks
 * it, plus each venture's position on the day, so at every month's end the series is the bridge's net worth to the
 * cent: money between two accounts across a month's end counts on each leg's own day, the bridge's In transit. Money
 * between two accounts that count whole, inside one month, counts on the later leg's day (`landed`), since it never
 * left net worth, so a card payment that leaves checking two days before the card shows it draws no dip. Its first
 * point is what every account held before anything was known, as it was on any earlier day. When a line is already
 * dated after today, `ahead` runs on from tomorrow to the open month's last day, where the month's bridge ends. A
 * venture named on its own, or beside Personal, is its accounts with a balance, each transfer's legs counted on the
 * later of their days (db.ventureNetWorthSeries).
 */
export function getNetWorthSeries(buckets?: BucketSelection): NetWorthSeries {
  if ((buckets ?? []).some((id) => Number.isInteger(id) && id > 0)) return db.ventureNetWorthSeries(buckets!)
  const today = db.today()
  // Walked on to the open month's last day, where its bridge ends, for a line already dated after today (`ahead`).
  const [y, m] = today.split('-').map(Number)
  const end = `${today.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, '0')}`
  const book = positionBook(end, { values: true })
  const read = [...new Set([...book.personal, ...book.reads])]
  if (!read.length) return { points: [], accountsIncluded: 0, accountsMissing: 0, landed: [], ahead: [] }
  const { days, byId } = db.balancesOver(read, null, end)
  const totals = new Array<number>(days.length).fill(0)
  for (const id of book.personal) byId.get(id)?.forEach((b, i) => (totals[i] += b))
  for (const values of valuesOver(book, days, byId).values()) values.forEach((v, i) => (totals[i] += v))
  const last = days.indexOf(today)
  // Both legs on accounts whose lines move their balance and that count whole, in one month and posted by today: from
  // the first leg's day to the day before the second's, the first leg is taken back, as if both landed on the second's
  // day. That never reaches a month's last day, so no month's end moves.
  const manual = new Set(db.all<{ id: string }>("SELECT id FROM accounts WHERE source = 'manual'").map((r) => r.id))
  const whole = countsWhole(book)
  const landed: NetWorthSeries['landed'] = []
  for (const [out, into] of db.transfersApart()) {
    const [first, second] = out.day < into.day ? [out, into] : [into, out]
    if (first.day.slice(0, 7) !== second.day.slice(0, 7) || second.day > today || first.day < days[0]) continue
    const toDay = addDays(second.day, -1)
    if ([out, into].some((l) => manual.has(l.accountId) || !whole(l.accountId, first.day, toDay))) continue
    const x = { fromDay: first.day, toDay, cents: -first.cents }
    for (let i = daysBetween(days[0], x.fromDay); i <= daysBetween(days[0], x.toDay); i++) totals[i] += x.cents
    landed.push(x)
  }
  landed.sort((a, b) => (a.fromDay < b.fromDay ? -1 : a.fromDay > b.fromDay ? 1 : 0))
  const point = (day: string, i: number): NetWorthPoint => ({ day, cents: totals[i] })
  const moves = totals.slice(last + 1).some((c) => c !== totals[last])
  return {
    points: days.slice(0, last + 1).map(point),
    accountsIncluded: read.length,
    accountsMissing: 0,
    landed,
    ahead: moves ? days.slice(last + 1).map((day, i) => point(day, last + 1 + i)) : []
  }
}

/**
 * Everything counted in net worth today (the same accounts, balances and positions as the net worth series and the
 * bridge: an account with no balance of its own at what its lines and known balances give), grouped by what it is,
 * with each account's change over the last 30 days. A venture's accounts, and a Stakes account linked to one, are in
 * no group of their own: each venture is one row of Ventures, its position with its share, and its change over the 30
 * days.
 */
export function getBalanceSheet(): BalanceSheet {
  const today = db.today()
  const monthAgo = db.dayKey(db.now() - 30 * 86_400)
  const book = positionBook(today, { values: true })
  const all = db.listAccounts()
  const personal = new Set(book.personal)
  const counted = all.filter((a) => personal.has(a.id))
  const { days, byId } = db.balancesOver([...new Set([...book.personal, ...book.reads])], monthAgo, today)
  const last = days.length - 1
  const name = new Map(all.map((a) => [a.id, a.name]))

  const groups: BalanceSheet['groups'] = SHEET_GROUPS.map((g) => ({ id: g.id, cents: 0, change30Cents: 0, accounts: [], zeroCount: 0, ...(g.id === 'ventures' ? { ventures: [] } : {}) }))
  for (const a of counted) {
    const g = groups.find((x) => x.id === SHEET_GROUP_OF[a.assetType])!
    const series = byId.get(a.id) ?? []
    const cents = series[last] ?? 0
    const change = cents - (series[0] ?? 0)
    g.cents += cents
    g.change30Cents += change
    if (a.closedDay && a.closedDay <= today) continue
    // A card paid off this month still shows, so the rows add up to the group's change.
    if (Math.abs(cents) < 1 && Math.abs(change) < 1) g.zeroCount++
    else g.accounts.push({ account: a, cents, change30Cents: change, linkedAsset: a.linkedAssetId ? (name.get(a.linkedAssetId) ?? null) : null })
  }
  const ventures = groups.find((g) => g.id === 'ventures')!
  const values = valuesOver(book, days, byId)
  for (const v of book.ventures) {
    const series = values.get(v.id) ?? []
    const cents = series[last] ?? 0
    const change = cents - (series[0] ?? 0)
    ventures.cents += cents
    ventures.change30Cents += change
    if (!cents && !change) ventures.zeroCount++
    else ventures.ventures!.push({ bucketId: v.id, name: v.name, shareBp: shareOn(v.shares, today), cents, change30Cents: change })
  }
  for (const g of groups) g.accounts.sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents))
  ventures.ventures!.sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents) || x.name.localeCompare(y.name))
  const own = groups.filter((g) => !SHEET_GROUPS.find((x) => x.id === g.id)!.debt).reduce((s, g) => s + g.cents, 0)
  const owe = -groups.filter((g) => SHEET_GROUPS.find((x) => x.id === g.id)!.debt).reduce((s, g) => s + g.cents, 0)
  return { netWorthCents: own - owe, ownCents: own, oweCents: owe, change30Cents: groups.reduce((s, g) => s + g.change30Cents, 0), groups }
}

/**
 * Net worth now, as Net worth's Overview and the bridge have it: every visible Personal account at its balance today
 * (an account with no balance of its own at what its lines and known balances give), and every venture's position.
 */
export function netWorthNow(): number {
  const today = db.today()
  const book = positionBook(today, { values: true })
  const balances = db.balancesOn([...new Set([...book.personal, ...book.reads])], today)
  const balance = (id: string): number => balances.get(id) ?? 0
  let cents = book.personal.reduce((s, id) => s + balance(id), 0)
  for (const p of positionsOn(book, today, balance).values()) cents += p.positionCents
  return cents
}
