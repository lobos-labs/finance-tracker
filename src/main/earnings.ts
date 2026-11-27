import * as db from './db'
import type { SeriesHistory } from './recurring'
import { addDays, daysBetween, weekday } from '../shared/zone'
import type { RecurringSeries, SpendRisk } from '../shared/types'

// Pay that keeps no schedule: gig apps, tips, freelance clients. Recurring
// detection finds pay that comes on a cadence at a steady amount; this finds
// deposits that repeat without one, from the same source, and sums them by
// full week (the seven days before today, the seven before those, back twelve
// weeks or to the first of them). Spendable counts a week of it at the risk's
// figure: Most likely the median week, Best case the mean (never under the
// median), and Worst case the lowest full week, which is nothing when a week
// went empty or fewer than four are in. The worst case is the floor because it
// is a week that happened: someone paid this way has bad weeks (a sick day,
// the car in the shop, a slow month), and the number that keeps them from
// overdrawing has to survive the next one. A deposit a gig app makes counts
// from its third week; anything else from its fourth.
// Money moved between their own accounts is never pay: a deposit whose other
// side left another of their accounts within a few days, one filed as a
// transfer, a cash-out from a wallet. A person-to-person payment counts only
// when the same person sends it week after week, like pay.

const DAY = 86_400
/** The full weeks read. */
const WEEKS = 12
/** Fewer full weeks of it than this and there's no floor to count on. */
const MIN_WEEKS = 4
/** A source that hasn't paid in this long has stopped. */
const ACTIVE_DAYS = 14
/** The most days apart the two sides of a move between their own accounts post. */
const PAIR_DAYS = 3
/** Of the days it pays, the share on one weekday that makes it the payout day. */
const PAYOUT_SHARE = 0.6

export const GIG = /door ?dash|\buber\b|\blyft\b|instacart|\bshipt\b|grubhub|amazon ?flex|upwork|fiverr|\betsy\b/i
const P2P = /venmo|zelle|cash ?app|square cash|paypal|apple cash/i
/** Their own money moved: a transfer, a wallet's cash-out, a deposit from their own savings. */
const OWN = /\b(transfer|xfer|tfr)\b|cash ?out|\bfrom (savings|checking|sav|chk|share)\b/i

/** A gig app's pay found on a schedule: forecast as earnings here, unless it was confirmed as recurring. */
export const gigPay = (s: RecurringSeries): boolean => s.typicalCents > 0 && !s.confirmed && (GIG.test(s.key) || GIG.test(s.name))

/** Irregular pay into one account. */
export interface Earnings {
  accountId: string
  /** the source's, or "Earnings" for several */
  name: string
  /** a week of it at each risk */
  weekly: Record<SpendRisk, number>
  /** the weekday (0 Sunday) it's paid out on, when most of it is; null: it comes through the week */
  weekday: number | null
  /** the latest deposit's day */
  last: string
}

interface Deposit {
  posted: number
  cents: number
  accountId: string
  merchant: string | null
  description: string
  descKey: string
  kind: string | null
  /** the payee and direction, as recurring.ts keys a series */
  key: string
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Who it's from: the payee, or the sender for a person-to-person app (the app's name alone says nothing). */
function sourceOf(d: Deposit): string {
  if (P2P.test(`${d.merchant ?? ''} ${d.description}`)) return `p2p:${d.descKey.replace(/\b(conf|ref|id|trace|memo|on)\b.*$/, '').trim()}`
  return d.key
}

/**
 * Each cash account's irregular pay over the last twelve weeks. While a bank's
 * history is still arriving every risk counts the floor.
 */
export function irregularEarnings(o: { now: number; today: string; cash: (accountId: string) => boolean; history: SeriesHistory[]; hidden: (name: string) => boolean; provisional: boolean }): Earnings[] {
  const { now, today } = o
  const from = db.dayStart(addDays(today, -WEEKS * 7))
  // Pay on a schedule is the forecast's own (except a gig app's).
  const scheduled = new Set(
    o.history
      .map((h) => h.series)
      .filter((s) => s.typicalCents > 0 && !s.dismissed && s.status !== 'stopped' && !gigPay(s))
      .map((s) => s.key.split('|').slice(0, 2).join('|'))
  )
  const deposits = db.all<Deposit>(
    `SELECT t.posted, t.amount_cents AS cents, t.account_id AS accountId, t.merchant, t.description, t.desc_key AS descKey, c.kind AS kind,
            lower(trim(COALESCE(t.merchant, t.desc_key))) || '|+' AS key
     ${db.VISIBLE_TXN_FROM}
     WHERE t.posted >= ? AND t.posted <= ? AND t.amount_cents > 0 AND t.one_time = 0 AND COALESCE(t.merchant, t.desc_key) != ''
     ORDER BY t.posted`,
    from,
    now
  )
  // The other side of a move between their own accounts: the same amount out of another of them (hidden ones too).
  const outs = new Map<number, Array<{ accountId: string; posted: number }>>()
  for (const r of db.all<{ accountId: string; posted: number; cents: number }>(
    'SELECT account_id AS accountId, posted, amount_cents AS cents FROM transactions WHERE amount_cents < 0 AND posted >= ? AND posted <= ?',
    from - PAIR_DAYS * DAY,
    now + PAIR_DAYS * DAY
  )) {
    const list = outs.get(-r.cents) ?? []
    list.push(r)
    outs.set(-r.cents, list)
  }
  const moved = (d: Deposit): boolean => (outs.get(d.cents) ?? []).some((x) => x.accountId !== d.accountId && Math.abs(x.posted - d.posted) <= PAIR_DAYS * DAY)

  const groups = new Map<string, { accountId: string; gig: boolean; name: string; days: Map<string, number> }>()
  for (const d of deposits) {
    if (!o.cash(d.accountId) || scheduled.has(d.key) || moved(d)) continue
    const gig = GIG.test(`${d.merchant ?? ''} ${d.description}`)
    // A refund (filed under what was bought) isn't pay, nor their own money moved, unless it's a gig app paying out.
    if (d.kind === 'expense' || (!gig && (d.kind === 'transfer' || OWN.test(d.description)))) continue
    const k = `${d.accountId}\u0000${sourceOf(d)}`
    const g = groups.get(k) ?? { accountId: d.accountId, gig, name: '', days: new Map<string, number>() }
    const day = db.dayKey(d.posted)
    g.days.set(day, (g.days.get(day) ?? 0) + d.cents)
    g.name = d.merchant ?? d.description
    groups.set(k, g)
  }

  // Full weeks back from today: 1 is the seven days before it; today is 0, not yet a full week.
  const week = (day: string): number => Math.ceil(daysBetween(day, today) / 7)
  const counted = [...groups.values()].filter((g) => {
    const days = [...g.days.keys()].sort()
    const need = g.gig ? 3 : 4
    return days.length >= need && new Set(days.map(week).filter((w) => w >= 1)).size >= need && daysBetween(days[days.length - 1], today) <= ACTIVE_DAYS
  })

  const out: Earnings[] = []
  for (const accountId of new Set(counted.map((g) => g.accountId))) {
    const mine = counted.filter((g) => g.accountId === accountId)
    const days = new Map<string, number>()
    for (const g of mine) for (const [d, c] of g.days) days.set(d, (days.get(d) ?? 0) + c)
    const keys = [...days.keys()].sort()
    // From the week of the first deposit: weeks before anyone paid aren't weeks it went empty.
    const n = Math.min(WEEKS, week(keys[0]))
    const totals = Array.from({ length: n }, (_, i) => keys.filter((d) => week(d) === i + 1).reduce((t, d) => t + days.get(d)!, 0))
    const floor = n < MIN_WEEKS ? 0 : Math.min(...totals)
    const mid = Math.round(median(totals))
    const mean = Math.round(totals.reduce((t, c) => t + c, 0) / n)
    const counts = [0, 1, 2, 3, 4, 5, 6].map((w) => keys.filter((d) => weekday(d) === w).length)
    const top = Math.max(...counts)
    const name = mine.length === 1 && !o.hidden(mine[0].name) ? mine[0].name : 'Earnings'
    out.push({
      accountId,
      name,
      weekly: o.provisional ? { cautious: floor, balanced: floor, tight: floor } : { cautious: floor, balanced: mid, tight: Math.max(mean, mid) },
      weekday: top / keys.length >= PAYOUT_SHARE ? counts.indexOf(top) : null,
      last: keys[keys.length - 1]
    })
  }
  return out
}
