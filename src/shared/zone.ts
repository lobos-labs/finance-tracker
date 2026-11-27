// Days in a time zone. A ledger counts its days ("today", the day a
// transaction posted, where a month starts) in its owner's zone, an IANA name
// like "America/New_York", wherever the code runs: a hosted ledger's clock is
// UTC. Days are YYYY-MM-DD, months YYYY-MM, times unix seconds. Arithmetic on
// days (adding days or months, weekdays) needs no zone and is done in UTC.

const DAY_MS = 86_400_000

const pad = (n: number): string => String(n).padStart(2, '0')

const partsOf = (day: string): [number, number, number] => {
  const [y, m, d] = day.split('-').map(Number)
  return [y, m, d]
}

/** A day from a year, month (1-12) and day; parts out of range roll over, so day 0 is the last of the month before. */
export function dayFrom(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Whether `day` is a real day written YYYY-MM-DD (2026-02-30 isn't). */
export function isRealDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const [y, m, d] = partsOf(day)
  return dayFrom(y, m, d) === day
}

/** How many days month `m` (1-12) of year `y` has. */
export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** A day moved by whole days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = partsOf(day)
  return dayFrom(y, m, d + n)
}

/** The same day of the month `n` months away, kept within that month (Jan 31 and a month is Feb 28). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = partsOf(day)
  const first = dayFrom(y, m + n, 1)
  const [ty, tm] = partsOf(first)
  return dayFrom(ty, tm, Math.min(d, daysInMonth(ty, tm)))
}

/** A month (YYYY-MM) moved by whole months. */
export const shiftMonth = (month: string, n: number): string => {
  const [y, m] = partsOf(month)
  return dayFrom(y, m + n, 1).slice(0, 7)
}

/** The day of the week, 0 for Sunday. */
export function weekday(day: string): number {
  const [y, m, d] = partsOf(day)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Whole days from `a` to `b`, negative when `b` comes first. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = partsOf(a)
  const [by, bm, bd] = partsOf(b)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A day as Date's toDateString writes it: "Tue Nov 03 2026". */
export function dateString(day: string): string {
  const [y, m, d] = partsOf(day)
  return `${WEEKDAYS[weekday(day)]} ${MONTHS[m - 1]} ${pad(d)} ${String(y).padStart(4, '0')}`
}

// ---------- zones ----------

let system: string | null = null
let fallback: string | null = null

/** The zone this process runs in (a hosted ledger's is UTC). Read once. */
export function systemZone(): string {
  system ??= Intl.DateTimeFormat().resolvedOptions().timeZone
  return system
}

/** The zone days are counted in when none is named (a ledger with no zone of its own): the system's, unless set. */
export const defaultZone = (): string => fallback ?? systemZone()

/** Sets the default zone (a test run's); null goes back to the system's. */
export function setDefaultZone(zone: string | null): void {
  fallback = zone
}

/** Whether `zone` is a time zone this runtime knows. */
export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()

function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(zone, f)
  }
  return f
}

interface Clock {
  y: number
  m: number
  d: number
  h: number
  min: number
  s: number
}

/** The wall clock in `zone` at `unix`: the process's own clock when that's the zone it runs in. */
function clock(unix: number, zone: string): Clock {
  const t = new Date(unix * 1000)
  if (zone === systemZone() || Number.isNaN(t.getTime())) return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), min: t.getMinutes(), s: t.getSeconds() }
  const c: Clock = { y: 0, m: 0, d: 0, h: 0, min: 0, s: 0 }
  for (const p of format(zone).formatToParts(t.getTime())) {
    const n = Number(p.value)
    if (p.type === 'year') c.y = n
    else if (p.type === 'month') c.m = n
    else if (p.type === 'day') c.d = n
    else if (p.type === 'hour') c.h = n % 24
    else if (p.type === 'minute') c.min = n
    else if (p.type === 'second') c.s = n
  }
  return c
}

/** The day `unix` falls on in `zone`. */
export function dayIn(unix: number, zone: string): string {
  const c = clock(unix, zone)
  return `${c.y}-${pad(c.m)}-${pad(c.d)}`
}

/** The hour and minute `unix` shows on a clock in `zone`. */
export function timeOfDay(unix: number, zone: string): { hour: number; minute: number } {
  const c = clock(unix, zone)
  return { hour: c.h, minute: c.min }
}

/** Seconds `zone` is ahead of UTC at `unix` (negative west of Greenwich). */
export function offsetAt(unix: number, zone: string): number {
  const at = Math.floor(unix)
  const c = clock(at, zone)
  return Date.UTC(c.y, c.m - 1, c.d, c.h, c.min, c.s) / 1000 - at
}

/**
 * The unix time a clock in `zone` reads `hour`:`minute` on `day` (noon when left out). A time a clock
 * change skips is read as the same time after the change, and one it repeats as the first, as Date does.
 */
export function timeIn(day: string, zone: string, hour = 12, minute = 0): number {
  const [y, m, d] = partsOf(day)
  if (zone === systemZone()) return Math.floor(new Date(y, m - 1, d, hour, minute).getTime() / 1000)
  const wall = Date.UTC(y, m - 1, d, hour, minute) / 1000
  // The offsets a day either side: any clock change near this time is between them.
  const before = offsetAt(wall - 86_400, zone)
  const after = offsetAt(wall + 86_400, zone)
  const fits = [wall - before, wall - after].filter((t) => offsetAt(t, zone) === wall - t)
  return fits.length ? Math.min(...fits) : wall - Math.min(before, after)
}

/** Noon of `day` in `zone`: the time a dated row with no time of its own gets. */
export const noonIn = (day: string, zone: string): number => timeIn(day, zone, 12)

/** The start of `day` in `zone` (its midnight, or the first moment after a clock change skips it). */
export const startIn = (day: string, zone: string): number => timeIn(day, zone, 0)

/** The start of a month (YYYY-MM) in `zone`. */
export const monthStartIn = (month: string, zone: string): number => startIn(`${month}-01`, zone)

/**
 * The offsets `zone` keeps from `from` to `to` (unix): the one at `from`, then each change with the
 * moment it takes effect, oldest first. Changes are looked for a week apart, so two in one week show as none.
 */
export function offsetChanges(zone: string, from: number, to: number): Array<{ at: number; offset: number }> {
  const WEEK = 7 * 86_400
  const out = [{ at: from, offset: offsetAt(from, zone) }]
  for (let lo = from; lo < to; lo += WEEK) {
    const hi = Math.min(lo + WEEK, to)
    const was = out[out.length - 1].offset
    const now = offsetAt(hi, zone)
    if (now === was) continue
    // The first second with the new offset.
    let a = lo
    let b = hi
    while (b - a > 1) {
      const mid = Math.floor((a + b) / 2)
      if (offsetAt(mid, zone) === was) a = mid
      else b = mid
    }
    out.push({ at: b, offset: now })
  }
  return out
}
