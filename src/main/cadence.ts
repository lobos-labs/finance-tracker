import { addDays, addMonths, daysBetween, daysInMonth } from '../shared/zone'
import type { Cadence } from '../shared/types'

// How often pay comes, or a bill, told from the days it came: a payroll's checks a year (paystubs.ts) and a
// series' cadence (recurring.ts) are told the same way.
//
// Pay every other week lands on one weekday, 14 days apart, bar a holiday that moves a check a day or two. Weekly
// pay lands on one weekday 7 days apart, and a payroll ramping up skips some weeks, so a run of 7-day gaps with
// some 14s is still weekly. Pay twice a month lands on two fixed days of the month (the 15th and the last, the 1st
// and the 15th), moved to the business day before or after when one falls on a weekend or a bank holiday, so its
// weekdays vary and its gaps run from 12 to 18 days. Monthly pay lands on one fixed day. So the two are told apart
// by whether the days keep one weekday or two days of the month, not by how many gaps are two weeks long. A bank can
// post a check a day or two early or late, and a payroll pays the odd check off its schedule (a correction, a bonus
// on its own). A payroll that changes its schedule is told by its latest checks once they clearly keep the new one,
// and its checks on the new one are the latest run of them (latestRun).

/** The schedules pay comes on. */
export type PayCadence = Extract<Cadence, 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'>

/** How many checks each schedule pays a year. */
export const CHECKS_A_YEAR: Record<PayCadence, 52 | 26 | 24 | 12> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }

const DAY_MS = 86_400_000

interface Day {
  /** days since 1970-01-01 */
  n: number
  /** months since year 0 */
  month: number
  /** the day of the month, and how many days the month has */
  date: number
  length: number
}

function dayOf(n: number): Day {
  const t = new Date(n * DAY_MS)
  const y = t.getUTCFullYear()
  const m = t.getUTCMonth() + 1
  return { n, month: y * 12 + m - 1, date: t.getUTCDate(), length: daysInMonth(y, m) }
}

const dayNumber = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS

/** A day's weekday (days since 1970-01-01, a Thursday): 0 is Sunday. */
const weekdayOf = (n: number): number => (((n + 4) % 7) + 7) % 7

/** Whether a day (days since 1970-01-01) is Monday to Friday. */
const isWeekday = (n: number): boolean => {
  const weekday = weekdayOf(n)
  return weekday !== 0 && weekday !== 6
}

/**
 * The weekdays banks are closed, 1990 to 2100 (days since 1970-01-01): the Federal Reserve's holidays as they are
 * now, a Sunday's kept the Monday after and a Saturday's not at all (the Friday before is a business day), and
 * Juneteenth from 2022, the first year it kept it. A direct deposit can't land on one, so pay due then comes the
 * business day before or after, as for a weekend.
 */
const CLOSED = new Set(
  Array.from({ length: 111 }, (_, i) => 1990 + i).flatMap((y) => {
    const on = (m: number, d: number): number => Date.UTC(y, m - 1, d) / DAY_MS
    /** A month's nth Monday (or other weekday), or with n = -1 its last. */
    const nth = (m: number, weekday: number, n: number): number => {
      if (n < 0) {
        const last = on(m + 1, 0)
        return last - ((weekdayOf(last) - weekday + 7) % 7)
      }
      const first = on(m, 1)
      return first + ((weekday - weekdayOf(first) + 7) % 7) + 7 * (n - 1)
    }
    const fixed = [on(1, 1), ...(y >= 2022 ? [on(6, 19)] : []), on(7, 4), on(11, 11), on(12, 25)].map((n) => (weekdayOf(n) === 0 ? n + 1 : n))
    return [...fixed, nth(1, 1, 3), nth(2, 1, 3), nth(5, 1, -1), nth(9, 1, 1), nth(10, 1, 2), nth(11, 4, 4)].filter(isWeekday)
  })
)

/** Whether a day (days since 1970-01-01) is a business day: Monday to Friday, and not a bank holiday. */
const isBusinessDay = (n: number): boolean => isWeekday(n) && !CLOSED.has(n)

/**
 * What it costs a check paid on one day to stand for another: the business days it moved past, counting the day it
 * stands for when that is a business day. A check on the business day before or after a weekend or a bank holiday
 * costs nothing (the Thursday before a Friday holiday, the Tuesday after a Monday one); one posted a day early or
 * late, or moved for a day the bank was open, costs one for each business day.
 */
function moved(from: number, to: number): number {
  let cost = 0
  for (let d = Math.min(from, to); d <= Math.max(from, to); d++) if (d !== from && isBusinessDay(d)) cost++
  return cost
}

/** The furthest a check moves off its day, in days, and in business days moved past. */
const REACH = 3
const MOST_MOVED = 2

/** The days of the month a check can stand for, and what each costs. */
function standsFor(c: Day): Array<{ day: Day; cost: number }> {
  const out: Array<{ day: Day; cost: number }> = [{ day: c, cost: 0 }]
  for (let by = -REACH; by <= REACH; by++) {
    const cost = moved(c.n, c.n + by)
    if (by && cost <= MOST_MOVED) out.push({ day: dayOf(c.n + by), cost })
  }
  return out
}

/** A schedule the days might keep: one weekday every week or every other week, or days of the month. */
type Schedule = { cadence: 'weekly' | 'biweekly'; period: 7 | 14; phase: number } | { cadence: 'semimonthly' | 'monthly'; slots: number[] }

/** Where a check falls on a schedule (the count of the schedule's days before it) and what placing it there costs; null when it's off the schedule. */
function place(s: Schedule, c: Day, options: Array<{ day: Day; cost: number }>): { index: number; cost: number } | null {
  if ('period' in s) {
    // A holiday or the bank moves a check a day or two either way off its weekday, or over a weekend; weekly pay
    // no further than two days, or every day would be some week's.
    const reach = s.period === 7 ? 2 : REACH
    const r = (((c.n - s.phase) % s.period) + s.period) % s.period
    const back = r <= reach ? { index: (c.n - r - s.phase) / s.period, cost: moved(c.n, c.n - r) } : null
    const ahead = s.period - r <= reach ? { index: (c.n + s.period - r - s.phase) / s.period, cost: moved(c.n, c.n + s.period - r) } : null
    const best = back && (!ahead || back.cost <= ahead.cost) ? back : ahead
    return best && best.cost <= MOST_MOVED ? best : null
  }
  // A day of the month past a short month's end is its last day, so 31 is always the last.
  let best: { index: number; cost: number } | null = null
  for (const o of options) {
    if (best && o.cost >= best.cost) continue
    const i = s.slots.findIndex((slot) => o.day.date === Math.min(slot, o.day.length))
    if (i >= 0) best = { index: o.day.month * s.slots.length + i, cost: o.cost }
  }
  return best
}

/** How a schedule fits the latest k days: its days that passed unpaid, the weekdays checks moved past, and the checks off it altogether (an off-cycle check). */
interface Fit {
  skipped: number
  cost: number
  extra: number
}

/**
 * A schedule's fit to the latest days, from the latest back (entry k - 1 is the latest k days'), as far as it explains
 * them: from the latest `first` days on, it ends where the schedule no longer explains them.
 */
function walk(s: Schedule, days: Day[], options: Array<Array<{ day: Day; cost: number }>>, first: number): Fit[] {
  const out: Fit[] = []
  const fit: Fit = { skipped: 0, cost: 0, extra: 0 }
  let after: number | null = null
  for (let i = days.length - 1; i >= 0; i--) {
    const p = place(s, days[i], options[i])
    if (!p || (after !== null && p.index >= after)) fit.extra++
    else {
      if (after !== null) fit.skipped += after - p.index - 1
      fit.cost += p.cost
      after = p.index
    }
    if (out.length + 1 >= first && !allowed(s.cadence, out.length + 1, fit)) break
    out.push({ ...fit })
  }
  return out
}

/** Two days of the month that pay twice a month: about half a month apart (the 1st and the 15th, the 5th and the 20th), or a day mid-month and the last. */
const halfApart = (a: number, b: number): boolean => (b - a >= 13 && b - a <= 16) || (b === 31 && a >= 13 && a <= 16)
/** The two schedules every payroll calls twice a month by name: the 1st and the 15th, and the 15th and the last day. */
const named = (slots: number[]): boolean => (slots[0] === 1 && slots[1] === 15) || (slots[0] === 15 && slots[1] === 31)

/** How many of the latest days are read together first: in fewer, one off-cycle check can't be told from a schedule's. */
const FIRST = 4

function schedules(days: Day[], options: Array<Array<{ day: Day; cost: number }>>): Schedule[] {
  const out: Schedule[] = []
  // Pay on one weekday keeps a weekday, Monday to Friday.
  for (let phase = 0; phase < 14; phase++) {
    if (!isWeekday(phase)) continue
    if (phase < 7) out.push({ cadence: 'weekly', period: 7, phase })
    out.push({ cadence: 'biweekly', period: 14, phase })
  }
  // The latest four checks hold both of a schedule's days of the month, though one of them is off-cycle, and the
  // latest two its one.
  const datesOf = (i: number): number[] => (i < 0 ? [] : options[i].flatMap((o) => (o.day.date === o.day.length ? [o.day.date, 31] : [o.day.date])))
  const last = days.length - 1
  const latest = (k: number): number[] => [...new Set(Array.from({ length: k }, (_, i) => datesOf(last - i)).flat())].sort((a, b) => a - b)
  // Two days of the month picked from two checks' own days explain those two checks exactly, so on two checks a pair
  // no payroll names, 13 or 14 days apart, is no schedule: such checks are every other week with one moved a day
  // (posted early, or for a day the bank was open), and a payroll paying twice a month on days of its own pays them
  // half a month apart, 15 days or more.
  const dates = latest(FIRST)
  const pairs = (a: number, b: number): boolean => halfApart(a, b) && (days.length > 2 || named([a, b]) || b - a >= 15)
  for (const a of dates) for (const b of dates) if (a < b && pairs(a, b)) out.push({ cadence: 'semimonthly', slots: [a, b] })
  for (const a of latest(2)) out.push({ cadence: 'monthly', slots: [a] })
  return out
}

/**
 * What a run of k checks may hold and still keep a schedule: weekdays moved past (none in two checks, then one for
 * every two checks), checks off the schedule altogether (none in two or three checks, then one, and one in eight from
 * sixteen on), and the schedule's days that passed unpaid (one in four, or for weekly pay as many as the weeks paid,
 * a ramp-up's).
 */
const allowed = (cadence: PayCadence, k: number, f: Fit): boolean =>
  f.cost <= (k <= 2 ? 0 : Math.floor(k / 2)) &&
  f.extra <= (k < FIRST ? 0 : Math.max(1, Math.floor(k / 8))) &&
  f.skipped <= (cadence === 'weekly' ? k - 1 : Math.floor(k / 4))

/** How badly a schedule explains the latest days: each day unpaid, check off it and weekday a check moved past counts one. */
const misses = (f: Fit): number => f.skipped + f.extra + f.cost

/** On a tie: the 1st and the 15th or the 15th and the last over every other week, and every other week over any other two days of the month. */
const rank = (s: Schedule): number => (s.cadence === 'semimonthly' ? (named(s.slots) ? 0 : 2) : s.cadence === 'biweekly' ? 1 : s.cadence === 'weekly' ? 3 : 4)

/** A fit's order: fewer misses, then fewer days unpaid, fewer checks off it, fewer weekdays moved, then the rank. */
const order = (f: Fit, s: Schedule): number[] => [misses(f), f.skipped, f.extra, f.cost, rank(s)]
/** Negative when `a` comes first. */
const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * Whether one fit explains the same days clearly better than another: two misses fewer, and fewer days unpaid or
 * checks off it, since checks moved a day or two (a holiday, or a bank posting early) are as likely on any schedule,
 * while a schedule the days don't keep soon leaves days unpaid or checks off it.
 */
const leads = (a: Fit, b: Fit): boolean => misses(b) >= misses(a) + 2 && b.skipped + b.extra > a.skipped + a.extra

/** How some pay days read: the schedule that explains them best, its cadence, and whether they settled on it. */
interface Told {
  cadence: PayCadence
  settled: boolean
  schedule: Schedule
  /** the days, oldest first, and what each can stand for */
  days: Day[]
  options: Array<Array<{ day: Day; cost: number }>>
}

/**
 * How a run of pay days (YYYY-MM-DD) reads: the schedule it keeps, and whether the days settled on it. Each schedule
 * is read from the latest day back, the latest four together (so one off-cycle check among them is allowed) and then
 * one more at a time, as far as it explains them. From four days on, the cadence whose best schedule explains them
 * with at most one miss in four and clearly better than every other cadence still explaining them settles it, so a
 * payroll that changed schedule is read by its latest checks. Otherwise it is the schedule that explains the longest
 * run, the best of those on a tie. Null with fewer than two days, when no schedule explains the latest four (two or
 * three, when there are only those), or when none settles and none explains half the days, as when a bank posts the
 * checks a varying day or two early.
 */
function tell(payDays: string[]): Told | null {
  const unique = [...new Set(payDays)].sort()
  const key = unique.join()
  if (read.has(key)) return read.get(key)!
  if (read.size >= READ_KEPT) read.clear()
  const t = readDays(unique)
  read.set(key, t)
  return t
}

/**
 * The latest readings, by their days: a payroll's checks a year and where its latest schedule began read the same
 * days, and a closed month's run rates are read again for the months after it. A reading is the same for the same
 * days, and its callers only read it. A few hundred are kept, each a year or so of days.
 */
const read = new Map<string, Told | null>()
const READ_KEPT = 256

function readDays(unique: string[]): Told | null {
  const days = unique.map((d) => dayOf(dayNumber(d)))
  if (days.length < 2) return null
  const options = days.map(standsFor)
  const first = Math.min(days.length, FIRST)
  const runs = schedules(days, options).flatMap((s) => {
    const steps = walk(s, days, options, first)
    return steps.length >= first ? [{ s, steps }] : []
  })
  if (!runs.length) return null
  const longest = Math.max(...runs.map((r) => r.steps.length))
  const bestAt = (k: number, list: typeof runs): (typeof runs)[number] => list.reduce((x, r) => (compare(order(r.steps[k - 1], r.s), order(x.steps[k - 1], x.s)) < 0 ? r : x))
  for (let k = FIRST; k <= longest; k++) {
    const live = runs.filter((r) => r.steps.length >= k)
    const best = bestAt(k, live)
    const mine = best.steps[k - 1]
    if (misses(mine) <= Math.floor(k / 4) && live.every((r) => r.s.cadence === best.s.cadence || leads(mine, r.steps[k - 1]))) return { cadence: best.s.cadence, settled: true, schedule: best.s, days, options }
  }
  if (longest * 2 < days.length) return null
  const s = bestAt(longest, runs.filter((r) => r.steps.length === longest)).s
  return { cadence: s.cadence, settled: false, schedule: s, days, options }
}

/** The schedule a run of pay days (YYYY-MM-DD) keeps, read as `tell` reads it, or null when the days can't tell. */
export const cadenceOf = (payDays: string[]): PayCadence | null => tell(payDays)?.cadence ?? null

/** The schedule a run of pay days settles on: four days or more that clearly keep it. Null when they don't. */
export function settledCadence(payDays: string[]): PayCadence | null {
  const t = tell(payDays)
  return t?.settled ? t.cadence : null
}

/**
 * Whether the latest of some pay days is one of the days of the schedule they keep, as `tell` reads it: on it, or
 * moved past a weekend or a bank holiday only. False when they keep none.
 */
export function onScheduleDay(payDays: string[]): boolean {
  const t = tell(payDays)
  if (!t) return false
  const last = t.days.length - 1
  const p = place(t.schedule, t.days[last], t.options[last])
  return p !== null && p.cost === 0
}

const dayString = (d: Day): string => new Date(d.n * DAY_MS).toISOString().slice(0, 10)

/**
 * Where the latest schedule began, for a payroll that changed it: the schedule its days settled on (four or more
 * clearly keeping it), the first day of the latest run of days on it, and the schedule the days before that run
 * keep (`was`), when that one pays a different number of checks a year. Null when the days haven't settled, or keep
 * one schedule throughout, bar a check off it or a ramp-up's weeks unpaid.
 *
 * The run is read from the latest day back, each day the schedule's next one before (on its day, or moved past a
 * weekend or a bank holiday). One day between two such may be moved a day (posted early or late) or off the schedule
 * altogether (an extra check). A day of the schedule unpaid ends the run, so every other Wednesday before weekly
 * Wednesdays isn't read as weekly pay skipping weeks: the days before it then keep every other week. Extra checks
 * are as rare in a run as a schedule's reading allows (one, and one in eight from sixteen days on): weekly pay on
 * the weekday every other week now keeps has every other check an extra on the new schedule, so a second extra too
 * soon ends the run after the latest one.
 */
export function latestRun(payDays: string[]): { cadence: PayCadence; from: string; was: PayCadence } | null {
  const t = tell(payDays)
  if (!t?.settled) return null
  const { days, options, schedule } = t
  const placed = (i: number): { index: number; cost: number } | null => place(schedule, days[i], options[i])
  /** Whether day i is on the schedule's day `index`, unmoved. */
  const on = (i: number, index: number): boolean => {
    const p = placed(i)
    return p !== null && p.cost === 0 && p.index === index
  }
  let first = days.length - 1
  while (first >= 0 && !placed(first)) first--
  if (first < 0) return null
  let index = placed(first)!.index
  /** the extra checks in the run so far, and its first day after the latest of them */
  let extras = 0
  let afterExtra = first
  for (let i = first - 1; i >= 0; ) {
    if (on(i, index - 1)) {
      first = i
      index--
      i--
    } else if (i > 0 && on(i - 1, index - 1)) {
      // An extra check between two on the schedule.
      if (extras + 1 > Math.max(1, Math.floor((days.length - i) / 8))) {
        first = afterExtra
        break
      }
      extras++
      afterExtra = first
      first = i - 1
      index--
      i -= 2
    } else if (i > 0 && placed(i)?.index === index - 1 && on(i - 1, index - 2)) {
      // A check moved a day, between two on the schedule.
      first = i - 1
      index -= 2
      i -= 2
    } else break
  }
  if (first === 0) return null
  const before = cadenceOf(days.slice(0, first).map(dayString))
  if (!before || CHECKS_A_YEAR[before] === CHECKS_A_YEAR[t.cadence]) return null
  return { cadence: t.cadence, from: dayString(days[first]), was: before }
}

/** When the days can't tell, pay a week to three weeks apart is every other week when at least this share of its gaps is 13 to 15 days, else twice a month. */
const TWO_WEEK_SHARE = 0.8

/** Every other week or twice a month by the share of gaps (in days) that are two weeks long. */
export const byTwoWeekGaps = (gaps: number[]): 'biweekly' | 'semimonthly' => (gaps.filter((g) => g >= 13 && g <= 15).length / gaps.length >= TWO_WEEK_SHARE ? 'biweekly' : 'semimonthly')

/**
 * A paystub's pay period, first day to last, as a schedule: 7 days is weekly, 14 every other week, half a month
 * (the 1st to the 15th, the 16th to the last, or the like a set number of days on) twice a month, and a whole month
 * monthly. Null for any other period, such as a new hire's first, and for any 14 days from the 16th of a leap
 * February on (the 16th to the 29th, the 20th to March 4th), which are both half a month and two weeks: an earlier
 * stub, or the checks, decide those.
 */
export function periodCadence(from: string, to: string): PayCadence | null {
  const length = daysBetween(from, to) + 1
  if (length < 1) return null
  const next = addDays(to, 1)
  if (next === addMonths(from, 1)) return 'monthly'
  const date = Number(from.slice(8, 10))
  // Half a month on is 15 days from the first half's start, or the same day less 15 in the next month from the second's.
  const half = date <= 15 ? addDays(from, 15) : `${addMonths(from, 1).slice(0, 8)}${String(date - 15).padStart(2, '0')}`
  if (next === half) return length === 14 ? null : 'semimonthly'
  if (length === 7) return 'weekly'
  if (length === 14) return 'biweekly'
  return null
}
