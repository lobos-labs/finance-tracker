// Times the tests build on the ledger's clock. new Date(y, m, d, 12) is noon
// on this machine's clock, which under npm run test:utc is UTC, not the
// ledger's: these build the same times in the default zone (test/utc.mjs sets
// it; otherwise it's the system's, and they equal new Date's).
import { dayFrom, dayIn, defaultZone, timeIn, timeOfDay } from '../src/shared/zone.ts'

/** Like new Date(year, monthIndex, day, hours, minutes), on the ledger's clock. Parts out of range roll over. */
export const zoned = (y: number, monthIndex: number, d: number, h = 0, min = 0): Date => new Date(timeIn(dayFrom(y, monthIndex + 1, d), defaultZone(), h, min) * 1000)

/** Unix seconds at noon on a day (month 1-12) on the ledger's clock. */
export const noonOn = (y: number, m: number, d: number): number => timeIn(dayFrom(y, m, d), defaultZone(), 12)

/** The day a Date falls on, on the ledger's clock. */
export const dayOn = (t: Date): string => dayIn(t.getTime() / 1000, defaultZone())

/** 'HH:MM' that a Date shows on the ledger's clock. */
export function clockOn(t: Date): string {
  const c = timeOfDay(t.getTime() / 1000, defaultZone())
  return `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`
}
