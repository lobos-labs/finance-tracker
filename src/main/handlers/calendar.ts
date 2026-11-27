import * as db from '../db'
import { calendarItems, setTimeZone, showTransfers, timeZone } from '../calendar'
import { changed, desktopOnly, hosted } from './context'

// The calendar: reminders and projected recurring items, the user's own
// events, and what Google mirrors (each change tells the host's Google sync).
// Saving an .ics file and Google itself are the desktop's (ipc.ts).

type EventPatch = { day?: string; title?: string; notes?: string | null; amountCents?: number | null }

export const calendarHandlers = {
  listCalendar: hosted((_c, from: string, to: string) => calendarItems(from, to)),
  getCalendarTransfers: hosted(() => showTransfers()),
  setCalendarTransfers: hosted((ctx, on: boolean) => {
    db.setSetting('calendar.transfers', on ? '1' : '0')
    ctx.calendarChanged()
    return changed(ctx, undefined)
  }),
  getCalendarTimeZone: hosted(() => timeZone()),
  // On the web the ledger's zone is the account's (PATCH /v1/me), set on every call.
  setCalendarTimeZone: desktopOnly((ctx, zone: string | null) => {
    setTimeZone(zone === null || zone === undefined ? null : String(zone))
    ctx.calendarChanged()
    return changed(ctx, undefined)
  }),
  addCalendarEvent: hosted((ctx, e: { day: string; title: string; notes?: string | null; amountCents?: number | null }) => {
    const id = db.addCalendarEvent({ ...e, createdBy: 'user' })
    ctx.calendarChanged()
    return changed(ctx, id)
  }),
  updateCalendarEvent: hosted((ctx, id: number, patch: EventPatch) => {
    db.updateCalendarEvent(id, patch)
    ctx.calendarChanged()
    return changed(ctx, undefined)
  }),
  deleteCalendarEvent: hosted((ctx, id: number) => {
    db.deleteCalendarEvent(id)
    ctx.calendarChanged()
    return changed(ctx, undefined)
  })
}
