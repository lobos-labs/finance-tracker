import * as db from './db'
import { CADENCES, detectRecurring, nextDate } from './recurring'
import { addDays } from '../shared/zone'
import type { RecurringSeries } from '../shared/types'
import type { Alert } from './alerts'

// Renewal reminders (the hosted ledger's `renewal` alert, on every plan): a
// yearly subscription a few days before it renews, and monthly ones too when
// the account turns those on. A text's replies mark a series (textReplies.ts):
// KEEP ends its reminders; HOW answers with how to cancel, and its
// reminders stop while the request stands, which is until the series charges
// again (it wasn't cancelled after all). Spendable keeps counting a series
// asked to cancel until a due date passes with no charge (cancelledByNow).

const MARKS = 'renewals.marks'
export const RENEWAL_DAYS = 3
/** A charge can post a few days after its date: a cancelled series is dropped from Spendable this long after. */
export const CANCEL_GRACE_DAYS = 3
/** A yearly subscription is found from its last two payments, so renewals read this far back (detection's own window is 400 days). */
const YEARLY_LOOKBACK_DAYS = 760

/** The series renewals look at: the usual detection, with the yearly ones from two years of payments. */
export const renewalSeries = (): RecurringSeries[] => [
  ...detectRecurring().filter((s) => s.cadence !== 'annual'),
  ...detectRecurring({ lookbackDays: YEARLY_LOOKBACK_DAYS }).filter((s) => s.cadence === 'annual')
]

export interface RenewalMark {
  /** KEEP: no more reminders for this series */
  keep?: boolean
  /** HOW: when someone on the books asked how to cancel (unix seconds) */
  cancelAt?: number
}

export function renewalMarks(): Record<string, RenewalMark> {
  try {
    const v = JSON.parse(db.getSetting(MARKS) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, RenewalMark>) : {}
  } catch {
    return {}
  }
}

export const renewalMark = (seriesKey: string): RenewalMark | null => renewalMarks()[seriesKey] ?? null

/** Sets a series' mark; null clears it. */
export function setRenewalMark(seriesKey: string, mark: RenewalMark | null): void {
  const all = renewalMarks()
  if (mark) all[seriesKey] = mark
  else delete all[seriesKey]
  db.setSetting(MARKS, Object.keys(all).length ? JSON.stringify(all) : null)
}

/** A cancel request stands while the series hasn't charged since. */
export const cancelStands = (s: Pick<RecurringSeries, 'lastDate'>, m: RenewalMark | null | undefined): boolean => !!m?.cancelAt && s.lastDate < m.cancelAt

/** Asked to cancel, and a due date since the request (and the grace after it) passed with no charge: Spendable stops counting it. */
export function cancelledByNow(s: Pick<RecurringSeries, 'lastDate' | 'nextDate' | 'cadence'>, today: string, m: RenewalMark | null | undefined): boolean {
  if (!cancelStands(s, m)) return false
  // A charge already overdue when it was asked may still come: the next date after the request is the one that counts.
  const asked = db.dayKey(m!.cancelAt!)
  const days = CADENCES.find((c) => c.id === s.cadence)?.days ?? 30.44
  let due = s.nextDate
  for (let i = 0; i < 60 && db.dayKey(due) < asked; i++) due = nextDate(due, s.cadence, days)
  return addDays(db.dayKey(due), CANCEL_GRACE_DAYS) < today
}

/** The series a renewal alert's key names ("renewal:<series key>:<day>"), or null. */
export function renewalSeriesKey(alertKey: string): string | null {
  const m = /^renewal:(.+):\d{4}-\d{2}-\d{2}$/.exec(alertKey)
  return m ? m[1] : null
}

/**
 * Subscriptions renewing from today through `days` ahead: yearly ones, and monthly ones with `monthly`. Not a
 * dismissed or stopped series, a hidden vendor, one marked KEEP, or one whose cancel request stands. Keyed by
 * the series and its renewal day, so each renewal is reminded once.
 */
export function renewalAlerts(series: RecurringSeries[], today: string, o: { days: number; monthly: boolean; hidden: (name: string) => boolean }): Alert[] {
  const marks = renewalMarks()
  const last = addDays(today, o.days)
  return series.flatMap((s): Alert[] => {
    if (s.kind !== 'subscription' || s.typicalCents >= 0 || s.dismissed || s.status === 'stopped' || o.hidden(s.name)) return []
    if (!(s.cadence === 'annual' || (o.monthly && s.cadence === 'monthly'))) return []
    const m = marks[s.key]
    if (m?.keep || cancelStands(s, m)) return []
    const day = db.dayKey(s.nextDate)
    if (day < today || day > last) return []
    return [
      {
        key: `renewal:${s.key}:${day}`,
        kind: 'renewal',
        title: 'Renews',
        body: s.name,
        target: { page: 'recurring' },
        facts: { name: s.name, cents: s.typicalCents, day, cadence: s.cadence === 'annual' ? 'annual' : 'monthly' }
      }
    ]
  })
}
