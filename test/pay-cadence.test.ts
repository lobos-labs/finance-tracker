import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { cadenceOf, periodCadence } from '../src/main/cadence.ts'
import { configureLicense } from '../src/main/license.ts'
import { checksPerYear, payrollChecks, payRunRates, savePaystub } from '../src/main/paystubs.ts'
import { detectRecurring } from '../src/main/recurring.ts'
import { addDays, daysBetween, daysInMonth, shiftMonth, weekday } from '../src/shared/zone.ts'
import { noonOn } from './days.ts'
import { deposit, household, KEY, TODAY } from './fixtures/paystubs.ts'
import { household as section5, KEY as BRIGHTLINE } from './fixtures/waterfall-household.ts'

// A payroll's checks a year (waterfall spec 1.1: Gross pay per payroll is the mean over the window's regular checks
// times its checks a year, over 12), read from the best evidence dated up to the month: its paystubs' pay periods,
// else the days its checks land on (cadence.ts), one weekday every week or every other week, or one or two days of
// the month. A series' cadence is told apart the same way (recurring.ts). A check here deposits 2,000.00 (a weekly
// one 1,000.00) with no stub, so a month's Take-home run rate is that times the checks a year over 12.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
after(() => mock.timers.reset())

const CHECK = 200_000
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
/** A pay day moved to the Friday before when it falls on a weekend. */
const friday = (day: string): string => (weekday(day) === 6 ? addDays(day, -1) : weekday(day) === 0 ? addDays(day, -2) : day)
/** Every `step` days from one day through another. */
const every = (step: number, from: string, to: string): string[] => {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, step)) out.push(d)
  return out
}
/** Days of each month from one month through another (31 is the month's last day), moved to the Friday before a weekend. */
const onDates = (dates: number[], from: string, to: string): string[] => {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) for (const d of dates) out.push(friday(d === 31 ? lastDay(m) : `${m}-${String(d).padStart(2, '0')}`))
  return out
}
const months = (from: string, to: string): string[] => {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m)
  return out
}
/** Each month's checks a year, by month. */
const perYear = (from: string, to: string, key = KEY): Record<string, number> => Object.fromEntries(months(from, to).map((m) => [m, checksPerYear(key, m)]))
const all = (from: string, to: string, n: number): Record<string, number> => Object.fromEntries(months(from, to).map((m) => [m, n]))
/** The share of gaps that are 13 to 15 days: the old rule called pay every other week at 80%. */
const twoWeekShare = (days: string[]): number => {
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d))
  return gaps.filter((g) => g >= 13 && g <= 15).length / gaps.length
}

/** The Federal Reserve's holidays from 2019 to 2037: one on a Sunday is kept the Monday after, one on a Saturday isn't. */
const HOLIDAYS = new Set(
  Array.from({ length: 19 }, (_, i) => 2019 + i).flatMap((y) => {
    const nth = (m: number, wd: number, n: number): string => {
      let d = `${y}-${String(m).padStart(2, '0')}-01`
      while (weekday(d) !== wd) d = addDays(d, 1)
      return addDays(d, 7 * (n - 1))
    }
    let memorial = `${y}-05-31`
    while (weekday(memorial) !== 1) memorial = addDays(memorial, -1)
    const fixed = [`${y}-01-01`, `${y}-06-19`, `${y}-07-04`, `${y}-11-11`, `${y}-12-25`].map((d) => (weekday(d) === 0 ? addDays(d, 1) : d))
    return [...fixed, nth(1, 1, 3), nth(2, 1, 3), memorial, nth(9, 1, 1), nth(10, 1, 2), nth(11, 4, 4)]
  })
)
const isBusinessDay = (day: string): boolean => weekday(day) !== 0 && weekday(day) !== 6 && !HOLIDAYS.has(day)
/** A pay day moved to the business day before (or after) when it falls on a weekend or a holiday. */
const businessDay = (day: string, way: 'before' | 'after'): string => (isBusinessDay(day) ? day : businessDay(addDays(day, way === 'before' ? -1 : 1), way))
/** Days of each month from one month through another (31 is the month's last day), moved to a business day. */
const onBusinessDays = (dates: number[], from: string, to: string, way: 'before' | 'after'): string[] =>
  months(from, to).flatMap((m) => dates.map((d) => businessDay(d === 31 ? lastDay(m) : `${m}-${String(d).padStart(2, '0')}`, way)))
/** A charge to checking on a day, filed under a category. */
const charge = (id: string, day: string, cents: number, payee: string, category: string): void => {
  const [y, m, d] = day.split('-').map(Number)
  db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description: payee.toUpperCase(), pending: false })
  db.setTransactionFields(id, { categoryId: db.listCategories().find((c) => c.name === category)!.id, source: 'user', merchant: payee })
}

describe("a payroll's checks a year", () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test("(a) a new payroll paid twice a month whose first checks fall on Aug 31 and Sep 15, 15 days apart, is 24 a year, not 26: September's Take-home run rate is 4,000.00", () => {
    const days = ['2026-08-31', '2026-09-15', '2026-09-30']
    for (const day of days) deposit(day, CHECK)
    // Every gap is 15 days, which the share of two-week gaps took for every other week.
    assert.equal(twoWeekShare(days), 1)
    assert.deepEqual(perYear('2026-08', '2026-10'), { '2026-08': 12, '2026-09': 24, '2026-10': 24 })
    const r = payRunRates('2026-09')
    assert.deepEqual(r.keys.map((k) => [k.paycheckKey, k.checksPerYear, k.checks]), [[KEY, 24, 3]])
    assert.equal(r.totals.takeHomeCents, 400_000)
  })

  test("(b) a new payroll's single check is 12 a year with nothing else, and its stub's pay period decides it: half a month is 24, so October's Take-home run rate is 4,000.00, not 2,000.00", () => {
    deposit('2026-10-30', CHECK)
    assert.equal(checksPerYear(KEY, '2026-10'), 12)
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 200_000)
    const stub = (periodFrom: string, periodTo: string): number => savePaystub({ paycheckKey: KEY, payDay: '2026-10-30', periodFrom, periodTo, grossCents: CHECK, items: [] })
    stub('2026-10-16', '2026-10-31')
    assert.equal(checksPerYear(KEY, '2026-10'), 24)
    const r = payRunRates('2026-10')
    assert.deepEqual([r.keys[0].checksPerYear, r.basis, r.totals.grossCents, r.totals.takeHomeCents], [24, 'paystub', 400_000, 400_000])
    // The same check's stub over 7 days, 14 days or the whole month.
    stub('2026-10-24', '2026-10-30')
    assert.deepEqual([checksPerYear(KEY, '2026-10'), payRunRates('2026-10').totals.takeHomeCents], [52, 866_667])
    stub('2026-10-17', '2026-10-30')
    assert.deepEqual([checksPerYear(KEY, '2026-10'), payRunRates('2026-10').totals.takeHomeCents], [26, 433_333])
    stub('2026-10-01', '2026-10-31')
    assert.deepEqual([checksPerYear(KEY, '2026-10'), payRunRates('2026-10').totals.takeHomeCents], [12, 200_000])
    // A period that is no schedule, a new hire's first part of one, leaves it to the checks.
    stub('2026-10-21', '2026-10-31')
    assert.equal(checksPerYear(KEY, '2026-10'), 12)
  })

  test('(c) a weekly payroll ramping up, some weeks skipped, is 52 a year, not 24: gaps of 7, 14, 14, 7, 21, 7 and 14 days, all Fridays', () => {
    const days = ['2026-08-07', '2026-08-14', '2026-08-28', '2026-09-11', '2026-09-18', '2026-10-09', '2026-10-16', '2026-10-30']
    for (const day of days) deposit(day, 100_000)
    // The median gap is 14 days and three of seven are 13 to 15, which the old rule took for twice a month.
    assert.ok(twoWeekShare(days) < 0.8)
    assert.deepEqual(perYear('2026-08', '2026-10'), { '2026-08': 52, '2026-09': 52, '2026-10': 52 })
    // Eight checks of 1,000.00 in August to October: 1,000.00 x 52 / 12.
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 433_333)
  })

  test("a weekly payroll ramping up hasn't stopped 19 days after its latest check when it usually pays two weeks apart: September's Take-home run rate keeps it, 1,000.00 x 52 / 12", () => {
    const days = ['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-07', '2026-08-21', '2026-09-04', '2026-09-11', '2026-10-02', '2026-10-16']
    for (const day of days) deposit(day, 100_000)
    // July's three Fridays are two weeks apart; Friday Aug 7 is a week after Jul 31.
    assert.deepEqual(perYear('2026-07', '2026-10'), { '2026-07': 26, ...all('2026-08', '2026-10', 52) })
    // Friday Sep 11 is 19 days before Sep 30, more than two weeks and four days of grace.
    const r = payRunRates('2026-09')
    assert.deepEqual(r.keys.map((k) => [k.paycheckKey, k.checks]), [[KEY, 7]])
    assert.equal(r.totals.takeHomeCents, 433_333)
    // Every Friday, it has stopped 19 days on.
    db.closeDb()
    household()
    for (const day of every(7, '2026-07-03', '2026-09-11')) deposit(day, 100_000)
    assert.deepEqual(payRunRates('2026-09').keys, [])
  })

  test('weekly every Friday is 52 a year, and so with weeks skipped', () => {
    for (const day of every(7, '2026-07-03', '2026-10-30').filter((d) => d !== '2026-08-21' && d !== '2026-09-25')) deposit(day, 100_000)
    assert.deepEqual(perYear('2026-07', '2026-10'), all('2026-07', '2026-10', 52))
  })

  test('every other Friday is 26 a year in every month, though the check of Friday Jul 3 (a holiday) came on Thursday Jul 2', () => {
    const days = every(14, '2026-01-02', '2026-10-30').map((d) => (d === '2026-07-03' ? '2026-07-02' : d))
    assert.ok(days.includes('2026-07-02') && days.includes('2026-07-17'))
    for (const day of days) deposit(day, CHECK)
    assert.deepEqual(perYear('2026-01', '2026-10'), all('2026-01', '2026-10', 26))
    assert.equal(payRunRates('2026-07').totals.takeHomeCents, 433_333)
  })

  test('the 15th and the last day, moved to the Friday before a weekend, are 24 a year in every month: through February, and months ending on a Saturday or Sunday (January, May, October)', () => {
    const days = onDates([15, 31], '2026-01', '2026-10')
    // Jan 31 is a Saturday, Feb 15 a Sunday and Feb 28 a Saturday: Jan 30, Feb 13 and Feb 27, all Fridays 14 days apart.
    assert.deepEqual(days.slice(0, 6), ['2026-01-15', '2026-01-30', '2026-02-13', '2026-02-27', '2026-03-13', '2026-03-31'])
    assert.ok(days.includes('2026-05-29') && days.includes('2026-10-30'))
    for (const day of days) deposit(day, CHECK)
    // Through February and March nearly every gap is two weeks, which the old rule took for every other week.
    assert.equal(twoWeekShare(days.slice(0, 4)), 1)
    assert.ok(twoWeekShare(days.slice(0, 6)) >= 0.8)
    assert.deepEqual(perYear('2026-01', '2026-10'), all('2026-01', '2026-10', 24))
    assert.equal(payRunRates('2026-02').totals.takeHomeCents, 400_000)
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 400_000)
  })

  test('the 1st and the 15th, moved to the Friday before a weekend, are 24 a year, though February 2026 pays on four Fridays 14 days apart', () => {
    const days = onDates([1, 15], '2026-02', '2026-10')
    for (const day of ['2026-01-15', ...days]) deposit(day, CHECK)
    // Feb 1, Feb 15, Mar 1 and Mar 15 are Sundays.
    assert.deepEqual(days.slice(0, 4), ['2026-01-30', '2026-02-13', '2026-02-27', '2026-03-13'])
    assert.equal(twoWeekShare(['2026-01-15', ...days.slice(0, 3)]), 1)
    // The Thursday 15th before the Fridays tells February from every other Friday.
    assert.deepEqual(perYear('2026-01', '2026-10'), all('2026-01', '2026-10', 24))
    assert.equal(payRunRates('2026-03').totals.takeHomeCents, 400_000)
  })

  test('monthly on the 25th, moved to the Friday before a weekend and before Memorial Day (Monday May 25), is 12 a year', () => {
    for (const day of onDates([25], '2026-01', '2026-10').map((d) => (d === '2026-05-25' ? '2026-05-22' : d))) deposit(day, CHECK)
    assert.deepEqual(perYear('2026-01', '2026-10'), all('2026-01', '2026-10', 12))
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 200_000)
  })

  test("one check off the schedule among the latest three (another check, a correction, a bonus deposited alone) leaves the 15th and the last at 24 a year, where weekly's 52 doubled October's Take-home run rate", () => {
    const cases: Array<[string, number]> = [
      ['2026-10-23', CHECK],
      ['2026-10-08', 35_000],
      ['2026-10-23', 500_000]
    ]
    for (const [day, cents] of cases) {
      db.closeDb()
      household()
      for (const d of onDates([15, 31], '2025-11', '2026-10')) deposit(d, CHECK)
      // Thursday Oct 15 and the Fridays Oct 23 and Oct 30 are a week apart on one weekday, but for the Thursday.
      deposit(day, cents)
      assert.equal(checksPerYear(KEY, '2026-10'), 24, day)
      assert.deepEqual(detectRecurring({ scope: 'all' }).map((s) => [s.key, s.cadence]), [[KEY, 'semimonthly']], day)
    }
    db.closeDb()
    household()
    for (const d of [...onDates([15, 31], '2025-11', '2026-10'), '2026-10-23']) deposit(d, CHECK)
    // Seven checks of 2,000.00 in August to October: 2,000.00 x 24 / 12.
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 400_000)
  })

  test('every other Friday for a year is 26 a year though one check came a day early, on Thursday Sep 10: October is 4,333.33, not 4,000.00', () => {
    for (const day of every(14, '2025-11-07', '2026-10-23').map((d) => (d === '2026-09-11' ? '2026-09-10' : d))) deposit(day, CHECK)
    assert.deepEqual(perYear('2025-11', '2026-10'), all('2025-11', '2026-10', 26))
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 433_333)
  })

  test('the 15th and the last day paid the business day after a weekend or a holiday are 24 a year in every month, though Monday Mar 2 and Monday Mar 16, 2026 are 14 days apart', () => {
    const days = onBusinessDays([15, 31], '2025-04', '2026-03', 'after')
    assert.deepEqual(days.slice(-5), ['2026-02-02', '2026-02-17', '2026-03-02', '2026-03-16', '2026-03-31'])
    for (const day of days) deposit(day, CHECK)
    assert.deepEqual(perYear('2025-04', '2026-03'), all('2025-04', '2026-03', 24))
    assert.equal(payRunRates('2026-03').totals.takeHomeCents, 400_000)
  })

  test('the 15th and the last day are 24 a year though the bank posted two checks a day early, Monday Sep 14 and Thursday Oct 29', () => {
    for (const day of onDates([15, 31], '2025-11', '2026-10').map((d) => (d === '2026-09-15' ? '2026-09-14' : d === '2026-10-30' ? '2026-10-29' : d))) deposit(day, CHECK)
    assert.deepEqual(perYear('2025-11', '2026-10'), all('2025-11', '2026-10', 24))
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 400_000)
  })

  test('a payroll that goes from every other Friday to the 15th and the last in July is 26 a year to July and 24 from August', () => {
    for (const day of [...every(14, '2026-01-02', '2026-06-19'), ...onDates([15, 31], '2026-07', '2026-10')]) deposit(day, CHECK)
    // July's two checks on the new days aren't enough to settle it, so its checks a year come from the median gap, two weeks.
    assert.deepEqual(perYear('2026-01', '2026-10'), { ...all('2026-01', '2026-07', 26), ...all('2026-08', '2026-10', 24) })
    assert.equal(payRunRates('2026-06').totals.takeHomeCents, 433_333)
    assert.equal(payRunRates('2026-09').totals.takeHomeCents, 400_000)
  })

  test("a stub's 14-day period from before the payroll moved to the 15th and the last decides only until the checks after it settle on twice a month: May and October are 24 a year, not 26", () => {
    for (const day of [...every(14, '2025-11-07', '2026-02-20'), ...onDates([15, 31], '2026-03', '2026-10')]) deposit(day, CHECK)
    savePaystub({ paycheckKey: KEY, payDay: '2026-01-09', periodFrom: '2025-12-27', periodTo: '2026-01-09', grossCents: CHECK, items: [] })
    // To March the checks after the stub are every other Friday and two on the new days: the stub decides.
    assert.deepEqual(perYear('2026-01', '2026-03'), all('2026-01', '2026-03', 26))
    assert.deepEqual(perYear('2026-05', '2026-10'), all('2026-05', '2026-10', 24))
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 400_000)
    // A stub on the new days says twice a month itself.
    savePaystub({ paycheckKey: KEY, payDay: '2026-10-15', periodFrom: '2026-10-01', periodTo: '2026-10-15', grossCents: CHECK, items: [] })
    assert.equal(checksPerYear(KEY, '2026-10'), 24)
  })

  test("a month's answer reads only what is dated up to it: later checks and two years never change an earlier month's checks a year or run rates, nor a later stub its checks a year", () => {
    const days = [...every(14, '2026-01-02', '2026-03-27'), ...onDates([15, 31], '2026-04', '2026-10')]
    const seen = new Map<string, { perYear: number; rates: ReturnType<typeof payRunRates> }>()
    for (const m of months('2026-01', '2026-10')) {
      for (const day of days.filter((d) => d.startsWith(m))) deposit(day, CHECK)
      // Once a month's checks are in, its answer is what it stays.
      seen.set(m, { perYear: checksPerYear(KEY, m), rates: payRunRates(m) })
      for (const [earlier, was] of seen) assert.deepEqual({ perYear: checksPerYear(KEY, earlier), rates: payRunRates(earlier) }, was, `${earlier} after ${m}`)
    }
    // November's checks come in, and two years pass.
    deposit('2026-11-13', CHECK)
    deposit('2026-11-30', CHECK)
    mock.timers.setTime(noonOn(2028, 11, 7) * 1000)
    try {
      for (const [m, was] of seen) assert.deepEqual({ perYear: checksPerYear(KEY, m), rates: payRunRates(m) }, was, m)
      // A stub dated Nov 13 over a week's period decides November, and no month before it. (It is the year's first
      // stub, so the checks before it are estimated from it, spec 1.2: their basis moves, not their checks a year.)
      savePaystub({ paycheckKey: KEY, payDay: '2026-11-13', periodFrom: '2026-11-07', periodTo: '2026-11-13', grossCents: CHECK, items: [] })
      assert.equal(checksPerYear(KEY, '2026-11'), 52)
      for (const [m, was] of seen) assert.equal(checksPerYear(KEY, m), was.perYear, m)
    } finally {
      mock.timers.setTime(noonOn(Y, M, D) * 1000)
    }
    // Every other Friday to March, then the 15th and the last.
    for (const m of months('2026-01', '2026-03')) assert.equal(seen.get(m)!.perYear, 26, m)
    for (const m of months('2026-05', '2026-10')) assert.equal(seen.get(m)!.perYear, 24, m)
  })

  test("a new payroll every other Friday from Dec 11, 2020, its second check on Thursday Dec 24 for Christmas Day, is 26 a year from its first month: December's Take-home run rate is 6,218.33, not 24 a year's 5,740.00", () => {
    for (const day of ['2020-12-11', '2020-12-24', ...every(14, '2021-01-08', '2021-04-30')]) deposit(day, 287_000)
    assert.deepEqual(perYear('2020-12', '2021-04'), all('2020-12', '2021-04', 26))
    // 2,870.00 x 26 / 12 in every month.
    for (const m of months('2020-12', '2021-04')) assert.equal(payRunRates(m).totals.takeHomeCents, 621_833, m)
  })

  test("a new payroll's first two checks 13 days apart with no holiday between, Friday Oct 2 and Thursday Oct 15, 2026, are no schedule the days tell, so their gap says every other week: 26 a year", () => {
    deposit('2026-10-02', CHECK)
    deposit('2026-10-15', CHECK)
    assert.equal(checksPerYear(KEY, '2026-10'), 26)
  })

  test("a later check off the schedule leaves an earlier month's bonus as it was: Monday Jun 22's 1,500.00 stays bonus, and June to August's Gross pay run rates stay 4,000.00", () => {
    for (const day of onDates([15, 31], '2025-11', '2026-10')) deposit(day, CHECK)
    deposit('2026-06-22', 150_000)
    const summer = (): unknown => ({ jun22: payrollChecks('2026-06-22', '2026-06-22').map((c) => c.kind), gross: months('2026-06', '2026-08').map((m) => payRunRates(m).totals.grossCents) })
    const was = { jun22: ['bonus'], gross: [400_000, 400_000, 400_000] }
    assert.deepEqual(summer(), was)
    // Friday Oct 23, eight days after Thursday Oct 15 and a week before Friday Oct 30, read today's series as weekly,
    // whose checks a week apart are all regular, Jun 22's too.
    deposit('2026-10-23', CHECK)
    assert.deepEqual(summer(), was)
    assert.deepEqual(detectRecurring({ scope: 'all' }).map((s) => s.cadence), ['semimonthly'])
  })
})

describe('the section 5 household', () => {
  before(() => section5())
  after(db.closeDb)

  test('its first month, November 2024, pays on Friday Nov 15 and Saturday Nov 30: 24 checks a year, as every month after, where the share of two-week gaps made it 26', () => {
    assert.deepEqual(perYear('2024-11', '2026-10', BRIGHTLINE), all('2024-11', '2026-10', 24))
    // 2 checks of 1,888.50 in November 2024: 1,888.50 x 24 / 12.
    assert.equal(payRunRates('2024-11').totals.takeHomeCents, 377_700)
    assert.equal(payRunRates('2026-10').totals.takeHomeCents, 377_700)
  })
})

describe("a series' cadence", () => {
  beforeEach(() => {
    household()
    mock.timers.setTime(noonOn(2026, 5, 7) * 1000)
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.setTime(noonOn(Y, M, D) * 1000)
  })

  test('pay on the 15th and the last day and a bill on the 1st and the 15th, from February to April 2026, are twice a month, as the payroll is', () => {
    for (const day of onDates([15, 31], '2026-02', '2026-04')) deposit(day, CHECK, 'Orbit Payroll')
    const daycare = db.listCategories().find((c) => c.name === 'Education')!.id
    for (const [i, day] of onDates([1, 15], '2026-02', '2026-04').entries()) {
      const [y, m, d] = day.split('-').map(Number)
      db.upsertTransaction({ id: `care${i}`, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: -45_000, description: 'TINY TOTS DAYCARE', pending: false })
      db.setTransactionFields(`care${i}`, { categoryId: daycare, source: 'user', merchant: 'Tiny Tots Daycare' })
    }
    // Four of five gaps are 13 to 15 days in each, which the share of two-week gaps took for every other week.
    assert.ok(twoWeekShare(onDates([15, 31], '2026-02', '2026-04')) >= 0.8)
    const found = detectRecurring({ scope: 'all' })
    assert.deepEqual(found.map((s) => [s.key, s.cadence, s.count]).sort(), [['orbit payroll|+', 'semimonthly', 6], ['tiny tots daycare|-', 'semimonthly', 6]])
    assert.equal(found.find((s) => s.key === 'tiny tots daycare|-')!.monthlyCents, Math.round((-45_000 * 30.44) / 15.2))
    assert.equal(checksPerYear('orbit payroll|+', '2026-04'), 24)
  })

  test('a bill on the 1st and the 15th is twice a month, at 450.00 x 30.44 / 15.2 a month, though one month it was charged once more, or each charge came the business day after a weekend or a holiday', () => {
    /** The bill's series a month after its charges, read the next week. */
    const daycare = (days: string[], [y, m, d]: number[]): Array<[string, string, number]> => {
      db.closeDb()
      household()
      for (const [i, day] of days.entries()) charge(`care${i}`, day, -45_000, 'Tiny Tots Daycare', 'Education')
      mock.timers.setTime(noonOn(y, m, d) * 1000)
      return detectRecurring({ scope: 'all' }).map((s) => [s.key, s.cadence, s.monthlyCents])
    }
    const twice: Array<[string, string, number]> = [['tiny tots daycare|-', 'semimonthly', Math.round((-45_000 * 30.44) / 15.2)]]
    // Thursday Oct 8 and Thursday Oct 15, a week apart, with Thursday Oct 1.
    assert.deepEqual(daycare([...onDates([1, 15], '2025-11', '2026-10'), '2026-10-08'].sort(), [2026, 11, 7]), twice)
    // Monday Mar 2 and Monday Mar 16, 2026, 14 days apart.
    assert.deepEqual(daycare(onBusinessDays([1, 15], '2025-03', '2026-03', 'after'), [2026, 4, 7]), twice)
  })

  test('every other Friday is still every other week, and every Friday weekly', () => {
    for (const day of every(14, '2026-01-02', '2026-05-01')) deposit(day, CHECK, 'Orbit Payroll')
    for (const day of every(7, '2026-03-06', '2026-05-01')) deposit(day, 40_000, 'Shift Payroll')
    assert.deepEqual(detectRecurring({ scope: 'all' }).map((s) => [s.key, s.cadence]).sort(), [['orbit payroll|+', 'biweekly'], ['shift payroll|+', 'weekly']])
  })
})

describe('the days alone', () => {
  test('two days are enough to tell, and with more the latest three must agree on a schedule', () => {
    assert.equal(cadenceOf([]), null)
    assert.equal(cadenceOf(['2026-10-30']), null)
    // 14 days apart on one weekday: every other week, but the 1st and the 15th are twice a month by name.
    assert.equal(cadenceOf(['2026-10-02', '2026-10-16']), 'biweekly')
    assert.equal(cadenceOf(['2026-10-01', '2026-10-15']), 'semimonthly')
    // Friday Oct 30 for Saturday Oct 31, and Friday Nov 13 for Sunday Nov 15.
    assert.equal(cadenceOf(['2026-10-30', '2026-11-13']), 'semimonthly')
    assert.equal(cadenceOf(['2026-10-23', '2026-10-30']), 'weekly')
    assert.equal(cadenceOf(['2026-09-10', '2026-10-01']), null)
    // Friday Sep 25 and Monday Oct 26 are the 26th, a Saturday in September.
    assert.equal(cadenceOf(['2026-09-25', '2026-10-26']), 'monthly')
    // The latest two are every other Friday, but no schedule explains the latest three.
    assert.equal(cadenceOf(['2026-09-09', '2026-10-02', '2026-10-16']), null)
  })

  test('a year of pay on each schedule, moved to the business day before or after a weekend or a holiday, reads as its schedule in every year ending a month from 2020 to 2036', () => {
    const schedules: Array<[string, (way: 'before' | 'after') => string[], string]> = [
      ['every other Friday', (way) => every(14, '2019-01-04', '2036-12-31').map((d) => businessDay(d, way)), 'biweekly'],
      ['every other Friday, the other weeks', (way) => every(14, '2019-01-11', '2036-12-31').map((d) => businessDay(d, way)), 'biweekly'],
      ['every other Wednesday', (way) => every(14, '2019-01-02', '2036-12-31').map((d) => businessDay(d, way)), 'biweekly'],
      ['every other Monday', (way) => every(14, '2019-01-07', '2036-12-31').map((d) => businessDay(d, way)), 'biweekly'],
      ['every Friday', (way) => every(7, '2019-01-04', '2036-12-31').map((d) => businessDay(d, way)), 'weekly'],
      ['the 15th and the last', (way) => onBusinessDays([15, 31], '2019-01', '2036-12', way), 'semimonthly'],
      ['the 1st and the 15th', (way) => onBusinessDays([1, 15], '2019-01', '2036-12', way), 'semimonthly'],
      ['the 5th and the 20th', (way) => onBusinessDays([5, 20], '2019-01', '2036-12', way), 'semimonthly'],
      ['the 10th and the 25th', (way) => onBusinessDays([10, 25], '2019-01', '2036-12', way), 'semimonthly'],
      ['the 25th', (way) => onBusinessDays([25], '2019-01', '2036-12', way), 'monthly'],
      ['the last', (way) => onBusinessDays([31], '2019-01', '2036-12', way), 'monthly']
    ]
    const wrong: string[] = []
    for (const [name, days, cadence] of schedules) {
      for (const way of ['before', 'after'] as const) {
        const paid = days(way)
        for (const m of months('2020-01', '2036-12')) {
          const year = paid.filter((d) => d >= `${shiftMonth(m, -11)}-01` && d <= lastDay(m))
          const told = cadenceOf(year)
          if (told !== cadence) wrong.push(`${name}, ${way}, ${m}: ${told}`)
        }
      }
    }
    assert.deepEqual(wrong, [])
  })

  test("one check in six off the 15th and the last or the 1st and the 15th, or one in twelve off every other Friday, a week after a regular one, never reads as another schedule in a year ending a month from 2020 to 2036", () => {
    // Where the checks off it are too many for the days to tell (null), the median gap between them decides.
    const offCycle = (days: string[], nth: number, by: number): string[] => [...days, ...days.filter((_, i) => i % nth === nth - 1).map((d) => businessDay(addDays(d, by), 'before'))].sort()
    const schedules: Array<[string, string[], string]> = [
      ['the 15th and the last', offCycle(onBusinessDays([15, 31], '2019-01', '2036-12', 'before'), 6, 8), 'semimonthly'],
      ['the 1st and the 15th', offCycle(onBusinessDays([1, 15], '2019-01', '2036-12', 'before'), 6, 6), 'semimonthly'],
      ['every other Friday', offCycle(every(14, '2019-01-04', '2036-12-31').map((d) => businessDay(d, 'before')), 12, 6), 'biweekly'],
      ['the 25th', offCycle(onBusinessDays([25], '2019-01', '2036-12', 'before'), 6, 12), 'monthly']
    ]
    const wrong: string[] = []
    for (const [name, paid, cadence] of schedules) {
      for (const m of months('2020-01', '2036-12')) {
        const told = cadenceOf(paid.filter((d) => d >= `${shiftMonth(m, -11)}-01` && d <= lastDay(m)))
        if (told !== cadence && told !== null) wrong.push(`${name}, ${m}: ${told}`)
      }
    }
    assert.deepEqual(wrong, [])
  })

  test('every other Friday through Veterans Day 2022, paid Thursday Nov 10, is every other week, though the latest four checks also land on the 10th and the 25th', () => {
    // Christmas 2021 was kept on Friday Dec 24, paid Thursday Dec 23.
    const days = every(14, '2021-12-24', '2022-12-23').map((d) => (d === '2021-12-24' ? '2021-12-23' : d === '2022-11-11' ? '2022-11-10' : d))
    assert.deepEqual(days.slice(-4), ['2022-11-10', '2022-11-25', '2022-12-09', '2022-12-23'])
    assert.equal(cadenceOf(days), 'biweekly')
  })

  test('two checks: one moved for a bank holiday costs nothing, as for a weekend, and two days 13 or 14 apart no payroll names are no schedule', () => {
    // Friday Jun 19, 2026 is Juneteenth: the Thursday before is every other Friday's, though the 5th and the 18th fit
    // two days of the month exactly.
    assert.equal(cadenceOf(['2026-06-05', '2026-06-18']), 'biweekly')
    // Thursday Oct 15 is no holiday: a bank posting a day early, or the 2nd and the 15th. Neither is told.
    assert.equal(cadenceOf(['2026-10-02', '2026-10-15']), null)
    // The 5th and the 20th are half a month apart: Monday Oct 5 and Tuesday Oct 20 are twice a month.
    assert.equal(cadenceOf(['2026-10-05', '2026-10-20']), 'semimonthly')
    // The 1st and the 15th paid the Friday before New Year's Day and Martin Luther King Jr. Day, both Mondays in 2024,
    // are 14 days apart on one weekday, and the 1st and the 15th by name.
    assert.equal(cadenceOf(['2023-12-29', '2024-01-12']), 'semimonthly')
  })

  /** Day i of a schedule's days of the month, counted from January 2022 (31 is the month's last day). */
  const slotDay = (dates: number[], i: number): string => {
    const m = shiftMonth('2022-01', Math.floor(i / dates.length))
    const d = dates[i % dates.length]
    return d === 31 ? lastDay(m) : `${m}-${String(d).padStart(2, '0')}`
  }
  const NAMED = [
    [1, 15],
    [15, 31]
  ]

  test("a new payroll on the 1st and the 15th or the 15th and the last reads twice a month on its first 2 to 5 checks from every start from 2023 to 2036, paid the business day before or after a weekend or a holiday: none of 5,376 misread, where 62 read every other week before, a holiday costing a move", () => {
    const wrong: string[] = []
    let n = 0
    for (const dates of NAMED) {
      for (const way of ['before', 'after'] as const) {
        const paid = Array.from({ length: 15 * 24 + 5 }, (_, i) => businessDay(slotDay(dates, i), way))
        for (let start = 24; start < 15 * 24; start++) {
          for (let k = 2; k <= 5; k++) {
            n++
            const days = paid.slice(start, start + k)
            if (cadenceOf(days) !== 'semimonthly') wrong.push(`${days.join(' ')}: ${cadenceOf(days)}`)
          }
        }
      }
    }
    assert.deepEqual([n, wrong], [5_376, []])
  })

  test("a new payroll every other week reads every other week on its first 2 to 5 checks from every weekday start from 2023 to 2036, paid the business day before or after a weekend or a holiday, but where the checks also land on the 1st and the 15th or the 15th and the last, which payrolls name: 935 of 29,224, where 1,694 misread before", () => {
    /** Whether days land on consecutive days of a named pair, each its day or moved to a business day past weekend days and holidays. */
    const onNamed = (days: string[]): boolean =>
      NAMED.some((dates) => {
        const near = (i: number, day: string): boolean => Math.abs(daysBetween(slotDay(dates, i), day)) <= 4 && [slotDay(dates, i), ...(['before', 'after'] as const).map((w) => businessDay(slotDay(dates, i), w))].includes(day)
        const first = Array.from({ length: 16 * 24 }, (_, i) => i).filter((i) => near(i, days[0]))
        return first.some((i) => days.every((d, j) => near(i + j, d)))
      })
    let n = 0
    let misread = 0
    const other: string[] = []
    for (const way of ['before', 'after'] as const) {
      for (let d = '2023-01-01'; d <= '2036-12-31'; d = addDays(d, 1)) {
        if (weekday(d) === 0 || weekday(d) === 6) continue
        const paid = Array.from({ length: 5 }, (_, j) => businessDay(addDays(d, 14 * j), way))
        for (let k = 2; k <= 5; k++) {
          n++
          const days = paid.slice(0, k)
          const told = cadenceOf(days)
          if (told === 'biweekly') continue
          misread++
          if (told !== 'semimonthly' || !onNamed(days)) other.push(`${days.join(' ')}: ${told}`)
        }
      }
    }
    assert.deepEqual([n, misread, other], [29_224, 935, []])
  })

  test("a paystub's pay period: 7 days weekly, 14 every other week, half a month twice a month, a whole month monthly", () => {
    const cases: Array<[string, string, string | null]> = [
      ['2026-10-24', '2026-10-30', 'weekly'],
      ['2026-10-17', '2026-10-30', 'biweekly'],
      ['2026-02-15', '2026-02-28', 'biweekly'],
      ['2026-10-01', '2026-10-15', 'semimonthly'],
      ['2026-10-16', '2026-10-31', 'semimonthly'],
      ['2026-09-16', '2026-09-30', 'semimonthly'],
      ['2026-02-16', '2026-02-28', 'semimonthly'],
      ['2026-10-11', '2026-10-25', 'semimonthly'],
      ['2026-10-26', '2026-11-10', 'semimonthly'],
      ['2026-10-01', '2026-10-31', 'monthly'],
      ['2026-10-16', '2026-11-15', 'monthly'],
      // Any 14 days from the 16th of a leap February on are both half a month (the 16th to the last, or the 20th to the
      // 4th) and two weeks; 14 days from the 15th are two weeks; a new hire's first period is neither.
      ['2028-02-16', '2028-02-29', null],
      ['2028-02-20', '2028-03-04', null],
      ['2028-02-29', '2028-03-13', null],
      ['2028-02-15', '2028-02-28', 'biweekly'],
      ['2028-03-01', '2028-03-14', 'biweekly'],
      ['2026-10-21', '2026-10-31', null],
      ['2026-10-31', '2026-10-01', null]
    ]
    for (const [from, to, cadence] of cases) assert.equal(periodCadence(from, to), cadence, `${from} to ${to}`)
  })
})
