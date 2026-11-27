import * as db from './db'
import { detectRecurring } from './recurring'
import { listPolicies, renewals } from './insurance'
import { addDays, occurrences } from '../shared/schedule'
import { isZone } from '../shared/zone'
import type { CalendarItem, RecurringSeries } from '../shared/types'

export { addDays }

// What goes on the calendar: reminders and deadlines (entered by the user or
// the assistant) plus the expected dates of recurring bills, paychecks and
// transfers, projected forward from each series' next date.

/** The ledger's time zone (db.zone): its days, and reminder times as wall-clock times. The calendar.timeZone setting, or the system's. */
export const timeZone = (): string => db.zone()

/** Sets the ledger's time zone by IANA name ("America/New_York"); null goes back to the system's. */
export function setTimeZone(zone: string | null): void {
  const z = zone?.trim() || null
  if (z && !isZone(z)) throw new Error(`Unknown time zone "${z}". Use a name like America/New_York.`)
  db.setSetting('calendar.timeZone', z)
}

const KIND: Record<RecurringSeries['kind'], CalendarItem['kind']> = { income: 'income', transfer: 'transfer', subscription: 'bill', bill: 'bill', loan: 'bill', other: 'bill' }

/** Whether transfers between the user's own accounts go on the calendar (off by default: they crowd out bills and paychecks). */
export const showTransfers = (): boolean => db.getSetting('calendar.transfers') === '1'

/** Reminders between `from` and `to`, and projected recurring items from today on. */
const CADENCE_WORDS: Record<string, string> = { weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly' }

export function calendarItems(from: string, to: string): CalendarItem[] {
  const transfers = showTransfers()
  const today = db.dayKey(db.now())
  const items: CalendarItem[] = db
    .listCalendarEvents(from)
    .filter((e) => e.day <= to)
    .map((e) => ({ key: `event:${e.id}`, day: e.day, title: e.title, amountCents: e.amountCents, kind: 'reminder', notes: e.notes, eventId: e.id, start: e.startTime, end: e.endTime, task: e.task && !e.startTime, done: e.doneAt !== null }))

  for (const s of detectRecurring()) {
    if (s.dismissed || s.status === 'stopped' || (KIND[s.kind] === 'transfer' && !transfers)) continue
    // Paydays show without an amount; bills and transfers keep theirs.
    const amount = s.kind === 'income' ? null : s.priceChanged ? s.lastCents : s.typicalCents
    const notes = [CADENCE_WORDS[s.cadence], s.variable && s.kind !== 'income' ? 'amount varies' : null, s.accountName].filter(Boolean).join(' · ')
    for (const d of occurrences(db.dayKey(s.nextDate), s.cadence, to)) {
      if (d < from || d < today) continue
      items.push({ key: `recurring:${s.key}:${d}`, day: d, title: s.name, amountCents: amount, kind: KIND[s.kind], notes, eventId: null, start: null, end: null, task: false, done: false })
    }
  }
  // Insurance renewals, rolled forward by each policy's term.
  for (const p of listPolicies()) {
    if (p.status !== 'active') continue
    const premium = p.premiumPeriod === 'year' || p.premiumPeriod === 'half-year' ? p.premiumCents : null
    const notes = [p.carrier, p.policyNumber && `policy ${p.policyNumber}`].filter(Boolean).join(' · ') || null
    for (const d of renewals(p, from > today ? from : today, to))
      items.push({ key: `insurance:${p.id}:${d}`, day: d, title: `${p.name} renews`, amountCents: premium, kind: 'reminder', notes, eventId: null, start: null, end: null, task: false, done: false })
  }
  const order = { reminder: 0, income: 1, bill: 2, transfer: 3 }
  return items.sort((a, b) => a.day.localeCompare(b.day) || order[a.kind] - order[b.kind] || (a.start ?? '').localeCompare(b.start ?? '') || a.title.localeCompare(b.title))
}

/** A text value for an .ics property: line breaks, backslashes, commas and semicolons escaped; other control characters out, so a value can't add properties of its own. */
export const icsText = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/([,;])/g, '\\$1')

/** Folds one content line at 75 octets, as RFC 5545 asks, continuing with a space. */
export function foldIcs(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

const icsTime = (day: string, time: string): string => `${day.replace(/-/g, '')}T${time.replace(':', '')}00`

/** The calendar as an iCalendar file: a month back and six months ahead. */
export function calendarIcs(): string {
  const today = db.dayKey(db.now())
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Finance Tracker//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Finance Tracker']
  const tz = timeZone()
  for (const i of calendarItems(addDays(today, -30), addDays(today, 183))) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${i.key.replace(/[^\w.:-]/g, '_')}@finance-tracker`,
      `DTSTAMP:${stamp}`,
      ...(i.start && i.end
        ? [`DTSTART;TZID=${tz}:${icsTime(i.day, i.start)}`, `DTEND;TZID=${tz}:${icsTime(i.day, i.end)}`]
        : [`DTSTART;VALUE=DATE:${i.day.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(i.day, 1).replace(/-/g, '')}`]),
      `SUMMARY:${icsText(itemSummary(i))}`,
      ...(i.notes ? [`DESCRIPTION:${icsText(i.notes)}`] : []),
      // An appointment holds its time; all-day items leave the day free.
      `TRANSP:${i.start ? 'OPAQUE' : 'TRANSPARENT'}`,
      'END:VEVENT'
    )
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldIcs).join('\r\n')}\r\n`
}

/** "Rent · $1,500", or a payday's or reminder's title. */
export function itemSummary(i: Pick<CalendarItem, 'title' | 'amountCents' | 'kind'>): string {
  if (i.amountCents === null) return i.title
  const amount = `$${Math.abs(Math.round(i.amountCents / 100)).toLocaleString('en-US')}`
  return `${i.title} · ${i.kind === 'income' ? '+' : ''}${amount}`
}
