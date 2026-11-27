import { addDays, dayIn, daysBetween, defaultZone, startIn } from './zone'

// The pages open on the last 30 days, today included, so they read the same on
// the 2nd of a month as on the 28th. Calendar months stay a choice. Days are
// YYYY-MM-DD: local time on a page, the ledger's time zone in the engine.

/** How many days the rolling window covers. */
export const WINDOW_DAYS = 30

/**
 * budget.ts getBudget's period for the last 30 days (any other period is a YYYY-MM month). No page or phone screen
 * opens on it since the phone's Budget tab went in sub-phase 2h; Review's tools, the headline and Home's plans read a
 * month.
 */
export const LAST_30_DAYS = '30d'

export const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

/** A Date's local day as YYYY-MM-DD. */
export const dayOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** A day moved by whole days. */
export const shiftDay = (day: string, delta: number): string => addDays(day, delta)

/** The last `n` days through `today` (in the default zone when left out), both ends included. */
export function lastDays(n = WINDOW_DAYS, today = dayIn(Date.now() / 1000, defaultZone())): { from: string; to: string } {
  return { from: shiftDay(today, 1 - n), to: today }
}

/** Unix seconds from the start of `from` to the start of the day after `to`, in `zone` (the default zone when left out). */
export function dayBounds(from: string, to: string, zone = defaultZone()): { from: number; to: number } {
  return { from: startIn(from, zone), to: startIn(shiftDay(to, 1), zone) }
}

/** Days from `from` through `to`, both included. */
export const daysIn = (from: string, to: string): number => daysBetween(from, to) + 1
