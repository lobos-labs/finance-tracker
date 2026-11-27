import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { latestRun } from '../src/main/cadence.ts'
import { configureLicense } from '../src/main/license.ts'
import { checksPerYear, payrollChecks, payRunRates, savePaystub } from '../src/main/paystubs.ts'
import { getWaterfall } from '../src/main/waterfall.ts'
import { addDays, daysInMonth, shiftMonth, weekday } from '../src/shared/zone.ts'
import { noonOn } from './days.ts'
import { deposit, household, TODAY } from './fixtures/paystubs.ts'

// Pay run rates across a change of schedule, and a new payroll's first checks (waterfall spec 1.1 and 1.2). A
// payroll's run rate is the mean of each figure over the window's regular checks times its checks a year, over 12.
// Once a payroll's checks settle on a new schedule paying a different number of checks a year, the window's checks
// on the old one are left out: they pay a different period. A check off the schedule the checks kept when it came is
// bonus, as it was then, so a later check never moves it. A run's first check that is two thirds of the typical
// check after it or less pays part of a period, so it counts in every actual and in no run rate. The checks here have no stubs, so a month's Take-home run rate is its deposits' mean times the checks a year, over 12.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
after(() => mock.timers.reset())

const key = (payee: string): string => `${payee.toLowerCase()}|+`
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
/** Every `step` days from one day through another. */
const every = (step: number, from: string, to: string): string[] => {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, step)) out.push(d)
  return out
}
const months = (from: string, to: string): string[] => {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m)
  return out
}
/** Each month's checks a year for a payroll, by month. */
const perYear = (payee: string, from: string, to: string): Record<string, number> => Object.fromEntries(months(from, to).map((m) => [m, checksPerYear(key(payee), m)]))
/** Each month's Take-home run rate for one payroll, by month. */
const takeHome = (payee: string, from: string, to: string): Record<string, number | null> =>
  Object.fromEntries(months(from, to).map((m) => [m, payRunRates(m).keys.find((k) => k.paycheckKey === key(payee))?.takeHomeCents ?? null]))
/** Deposits a payroll's checks: each day at one amount, or at its own. */
const pay = (payee: string, checks: Array<[string, number]>): void => {
  for (const [day, cents] of checks) deposit(day, cents, payee)
}
const at = (cents: number, days: string[]): Array<[string, number]> => days.map((d) => [d, cents])
/** A pay day moved to the Friday before when it falls on a weekend. */
const friday = (day: string): string => (weekday(day) === 6 ? addDays(day, -1) : weekday(day) === 0 ? addDays(day, -2) : day)
/** The 15th and the last of each month from one month through another, moved to the Friday before a weekend. */
const fifteenthAndLast = (from: string, to: string): string[] => months(from, to).flatMap((m) => [friday(`${m}-15`), friday(lastDay(m))])

describe('a payroll that changed schedule inside the window', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  const FREIGHT = 'Quillfeather Freight Payroll'
  const DOCK = 'Bramblecot Dockworks Payroll'
  /** Every other Wednesday at 2,400.00 through Apr 24, 2024, then every Tuesday at 1,204.00 from Apr 30, its first 960.00. */
  const freight = (): void => {
    pay(FREIGHT, at(240_000, every(14, '2023-10-11', '2024-04-24')))
    pay(FREIGHT, [['2024-04-30', 96_000], ...at(120_400, every(7, '2024-05-07', '2024-10-01'))])
  }

  test("every other Wednesday at 2,400.00, then weekly on Tuesdays at 1,204.00 from Apr 30, 2024: May's and June's Take-home run rates are 5,217.33 from the weekly checks alone, not 7,403.26 and 6,063.52 with the checks every other week", () => {
    freight()
    // April's one Tuesday is a check off the schedule: the checks a year are still every other week's.
    assert.deepEqual(perYear(FREIGHT, '2024-03', '2024-08'), { '2024-03': 26, '2024-04': 26, '2024-05': 52, '2024-06': 52, '2024-07': 52, '2024-08': 52 })
    // Apr 30, six days after Wednesday Apr 24, came off the schedule the checks kept then, so it is bonus: in April's
    // actual and in no run rate, as it was when it came.
    assert.deepEqual(payrollChecks('2024-04-30', '2024-04-30').map((c) => [c.kind, c.depositCents]), [['bonus', 96_000]])
    const may = payRunRates('2024-05').keys[0]
    // May's four Tuesdays; March's and April's four Wednesdays are left out.
    assert.deepEqual([may.checks, may.days], [4, ['2024-05-07', '2024-05-14', '2024-05-21', '2024-05-28']])
    assert.deepEqual(takeHome(FREIGHT, '2024-03', '2024-08'), {
      // Seven checks of 2,400.00 in January to March, and six in February to April: 2,400.00 x 26 / 12.
      '2024-03': 520_000,
      '2024-04': 520_000,
      // 1,204.00 x 52 / 12. With the four Wednesdays and Apr 30 it was 15,376.00 x 52 / (9 x 12).
      '2024-05': 521_733,
      // Eight Tuesdays, where with Apr 10, Apr 24 and Apr 30 it was 15,392.00 x 52 / (11 x 12).
      '2024-06': 521_733,
      '2024-07': 521_733,
      '2024-08': 521_733
    })
  })

  test('the new schedule takes over once its days settle: two weekly checks at the end of May leave May at 26 a year over every regular check in the window, and June reads only the weekly run', () => {
    // Every other Wednesday through May 8, 2024, then every Tuesday from May 21.
    pay(FREIGHT, at(240_000, every(14, '2023-10-11', '2024-05-08')))
    pay(FREIGHT, at(120_400, every(7, '2024-05-21', '2024-10-01')))
    assert.deepEqual(perYear(FREIGHT, '2024-04', '2024-07'), { '2024-04': 26, '2024-05': 26, '2024-06': 52, '2024-07': 52 })
    // May 21 is 13 days after May 8, on time for every other week; May 28 a week after it is off the schedule then.
    assert.deepEqual(payrollChecks('2024-05-21', '2024-05-28').map((c) => c.kind), ['regular', 'bonus'])
    assert.deepEqual(takeHome(FREIGHT, '2024-05', '2024-06'), {
      // Five of 2,400.00 and May 21's 1,204.00 in March to May: 13,204.00 x 26 / (6 x 12).
      '2024-05': 476_811,
      // May 21 to Jun 25 on the new schedule: 1,204.00 x 52 / 12.
      '2024-06': 521_733
    })
    // May 28's day is among the days the schedule is read from, so the weekly run begins at May 21; May 28 itself,
    // bonus when it came, is in no run rate.
    assert.deepEqual(payRunRates('2024-06').keys[0].days, ['2024-05-21', '2024-06-04', '2024-06-11', '2024-06-18', '2024-06-25'])
  })

  test("every other Friday at 2,000.00 through Jun 19, 2026, then the 15th and the last at 2,166.67, whose first check, Jul 15, paid 1,083.33 for part of a period: August's Take-home run rate is 4,333.34, not 3,861.11", () => {
    const semimonthly = fifteenthAndLast('2026-07', '2026-10')
    pay(DOCK, [...at(200_000, every(14, '2026-01-02', '2026-06-19')), ['2026-07-15', 108_333], ...at(216_667, semimonthly.slice(1))])
    assert.deepEqual(perYear(DOCK, '2026-06', '2026-10'), { '2026-06': 26, '2026-07': 26, '2026-08': 24, '2026-09': 24, '2026-10': 24 })
    assert.deepEqual(takeHome(DOCK, '2026-07', '2026-10'), {
      // July's two checks on the new days don't settle it: every regular check in May to July at 26 a year,
      // 11,250.00 x 26 / (6 x 12).
      '2026-07': 406_250,
      // The run from Jul 15 without it, 1,083.33 being under two thirds of 2,166.67: 2,166.67 x 24 / 12. Every check
      // in June to August at 24 a year was 11,583.34 x 24 / (6 x 12).
      '2026-08': 433_334,
      '2026-09': 433_334,
      '2026-10': 433_334
    })
    assert.deepEqual(payRunRates('2026-08').keys[0].days, ['2026-07-31', '2026-08-14', '2026-08-31'])
    // A first check of 1,800.00 is 83% of the next ones, more than two thirds: it counts, (1,800.00 + 6,500.01) x 24 / (4 x 12).
    db.closeDb()
    household()
    pay(DOCK, [...at(200_000, every(14, '2026-01-02', '2026-06-19')), ['2026-07-15', 180_000], ...at(216_667, semimonthly.slice(1))])
    assert.deepEqual([payRunRates('2026-08').keys[0].checks, takeHome(DOCK, '2026-08', '2026-08')['2026-08']], [4, 415_001])
  })

  test("the first check on a faster schedule is bonus when it comes, and its day still counts toward the new schedule: weekly from Tuesday May 7, 2024, after Wednesday May 1, reads 52 a year in May from May 14 on", () => {
    pay(FREIGHT, at(240_000, every(14, '2023-10-04', '2024-05-01')))
    pay(FREIGHT, at(120_400, every(7, '2024-05-07', '2024-10-01')))
    assert.deepEqual(payrollChecks('2024-05-07', '2024-05-07').map((c) => c.kind), ['bonus'])
    assert.deepEqual(perYear(FREIGHT, '2024-04', '2024-06'), { '2024-04': 26, '2024-05': 52, '2024-06': 52 })
    // 1,204.00 x 52 / 12, where without May 7's day May read 26 a year over every regular check, 4,228.25.
    assert.deepEqual(takeHome(FREIGHT, '2024-05', '2024-06'), { '2024-05': 521_733, '2024-06': 521_733 })
    assert.deepEqual(payRunRates('2024-05').keys[0].days, ['2024-05-14', '2024-05-21', '2024-05-28'])
  })

  test('monthly on the 1st at 4,333.33 through Thursday Aug 1, 2024, then every other Thursday at 2,000.00 from Aug 15: September is 4,333.33 at 26 a year, its run without Aug 1, which lands on the new days and pays 1.5 times the checks after it or more', () => {
    pay(DOCK, at(433_333, months('2024-01', '2024-08').map((m) => `${m}-01`)))
    pay(DOCK, at(200_000, every(14, '2024-08-15', '2025-03-27')))
    assert.deepEqual(payrollChecks('2024-08-15', '2024-08-15').map((c) => c.kind), ['bonus'])
    assert.deepEqual(perYear(DOCK, '2024-09', '2024-10'), { '2024-09': 26, '2024-10': 26 })
    // 2,000.00 x 26 / 12. Without Aug 15's day September read 12 a year, 2,933.33, and before that 26 a year over
    // Aug 1 too, 6,018.52.
    assert.deepEqual(takeHome(DOCK, '2024-09', '2024-11'), { '2024-09': 433_333, '2024-10': 433_333, '2024-11': 433_333 })
    assert.deepEqual(payRunRates('2024-09').keys[0].days, ['2024-08-29', '2024-09-12', '2024-09-26'])
  })

  test('every other Friday at 2,000.00 through Jul 25, 2025, then every Friday at 1,000.00: the weekly run begins at Jul 25, which lands on a Friday, and leaves it out as 1.5 times the checks after it', () => {
    pay(DOCK, [...at(200_000, every(14, '2025-01-10', '2025-07-25')), ...at(100_000, every(7, '2025-08-01', '2026-03-27'))])
    assert.deepEqual(payRunRates('2025-08').keys[0].days, ['2025-08-08', '2025-08-15', '2025-08-22', '2025-08-29'])
    assert.deepEqual(takeHome(DOCK, '2025-08', '2025-09'), { '2025-08': 433_333, '2025-09': 433_333 })
  })

  test('a raise inside the window on the same schedule still averages every check in it: four every other Friday at 2,000.00 and three at 2,200.00 are 4,519.05, July to September', () => {
    const days = every(14, '2026-01-02', '2026-10-23')
    pay(DOCK, days.map((d) => [d, d >= '2026-08-28' ? 220_000 : 200_000]))
    assert.deepEqual(perYear(DOCK, '2026-07', '2026-10'), { '2026-07': 26, '2026-08': 26, '2026-09': 26, '2026-10': 26 })
    const september = payRunRates('2026-09').keys[0]
    assert.deepEqual(september.days, ['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25'])
    // 14,600.00 x 26 / (7 x 12).
    assert.equal(september.takeHomeCents, 451_905)
  })
})

describe('where the latest schedule began', () => {
  /** Weekly Fridays through one day, then every other Friday from another through Nov 21, 2025. */
  const weeklyThen = (through: string, from: string): string[] => [...every(7, '2025-01-03', through), ...every(14, from, '2025-11-21')]

  test('every Friday through Sep 26, 2025, then every other Friday from Oct 10: the run every other week begins at Sep 26, the weekly checks before it each an extra on the new schedule, two of which in a run of eight end it', () => {
    assert.deepEqual(latestRun(weeklyThen('2025-09-26', '2025-10-10')), { cadence: 'biweekly', from: '2025-09-26', was: 'weekly' })
    // With a week unpaid before the change, Sep 19 is the last weekly check and lands on the new schedule's days.
    assert.deepEqual(latestRun(weeklyThen('2025-09-19', '2025-10-03')), { cadence: 'biweekly', from: '2025-09-19', was: 'weekly' })
  })

  test('two checks off a schedule that never changed are no new schedule, nor is one, and the switch to weekly pay begins at its first weekly check', () => {
    const fridays = every(14, '2025-11-07', '2026-10-30')
    assert.equal(latestRun([...fridays, '2026-06-09', '2026-06-23'].sort()), null)
    assert.equal(latestRun([...fridays, '2026-06-09'].sort()), null)
    assert.deepEqual(latestRun([...every(14, '2023-10-11', '2024-04-24'), '2024-04-30', ...every(7, '2024-05-07', '2024-07-30')]), { cadence: 'weekly', from: '2024-04-30', was: 'biweekly' })
  })

  test("so November's run rate for every Friday at 1,000.00 and then every other Friday at 2,000.00 from Oct 10, 2025 reads the checks every other week alone, where it read every check from Sep 5", () => {
    household()
    pay('Saltmarrow Kiln Payroll', [...at(100_000, every(7, '2025-01-03', '2025-09-26')), ...at(200_000, every(14, '2025-10-10', '2026-03-27'))])
    // Sep 26 begins the run, and pays 1,000.00, two thirds of the checks after it or less: like a first check paying
    // part of a period, it counts in no run rate.
    assert.deepEqual(payRunRates('2025-11').keys[0].days, ['2025-10-10', '2025-10-24', '2025-11-07', '2025-11-21'])
    db.closeDb()
  })
})

describe('the typical check across a change of schedule', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  const KILN = 'Saltmarrow Kiln Payroll'
  /** The part of each check from one day to another that is bonus, by day. */
  const bonusParts = (from: string, to: string): Record<string, number> =>
    Object.fromEntries(
      payrollChecks(from, to)
        .filter((c) => c.kind === 'bonus')
        .map((c) => [c.day, c.depositCents])
    )

  test('every Friday at 1,000.00, then every other Friday at 2,000.00 from Oct 10, 2025: once the days settle on every other week, the weekly checks before count double in the typical check, so no part of 2,000.00 is bonus', () => {
    pay(KILN, [...at(100_000, every(7, '2025-01-03', '2025-09-26')), ...at(200_000, every(14, '2025-10-10', '2026-03-27'))])
    // Oct 10, Oct 24 and Nov 7 come while the days still read weekly pay that skipped weeks (four days every other
    // Friday also land on the 11th and the 26th): the part above 1.5 times 1,000.00 is bonus, as it was then. From
    // Nov 21 the days keep every other week.
    assert.deepEqual(bonusParts('2025-10-01', '2026-03-31'), { '2025-10-10': 50_000, '2025-10-24': 50_000, '2025-11-07': 50_000 })
    assert.deepEqual(takeHome(KILN, '2025-11', '2026-02'), {
      // Oct 10 to Nov 21: (3 x 1,500.00 + 2,000.00) x 26 / (4 x 12), where it was 3,453.13 with 125.00 of Nov 21's
      // check bonus.
      '2025-11': 352_083,
      // (3 x 1,500.00 + 3 x 2,000.00) x 26 / (6 x 12), where it was 3,746.53.
      '2025-12': 379_167,
      // (1,500.00 + 6 x 2,000.00) x 26 / (7 x 12), where it was 4,139.88.
      '2026-01': 417_857,
      '2026-02': 433_333
    })
  })

  test('every other Friday at 2,000.00, then monthly on the last business day at 4,333.33 from Jul 31, 2025: from September the checks every other week count 26 / 12 of themselves, so September is no longer split', () => {
    const lastFridays = months('2025-07', '2026-03').map((m) => friday(lastDay(m)))
    pay(KILN, [...at(200_000, every(14, '2025-01-10', '2025-06-27')), ...at(433_333, lastFridays)])
    // Jul 31 and Aug 29 come while the days still keep every other week.
    assert.deepEqual(bonusParts('2025-07-01', '2026-03-31'), { '2025-07-31': 133_333, '2025-08-29': 133_333 })
    assert.deepEqual(takeHome(KILN, '2025-09', '2025-11'), {
      // (3,000.00 + 3,000.00 + 4,333.33) x 12 / (3 x 12), where it was 3,000.00.
      '2025-09': 344_444,
      '2025-10': 388_889,
      '2025-11': 433_333
    })
  })

  test("every other Wednesday at 2,400.00, then every Tuesday at 1,204.00 from Apr 30, 2024, and a 1,400.00 bonus deposited with May 21's check: once the days keep weekly pay, the checks every other week count half, and 804.00 is bonus", () => {
    pay(KILN, [...at(240_000, every(14, '2023-10-11', '2024-04-24')), ['2024-04-30', 96_000], ...at(120_400, every(7, '2024-05-07', '2024-10-01')), ['2024-05-23', 140_000]])
    // Typical is 1,200.00, the median of four checks of 2,400.00 at half and two of 1,204.00: the part above
    // 1,800.00 is bonus. With the checks every other week at full, it was 2,400.00 and none of 2,604.00 was.
    assert.deepEqual(bonusParts('2024-05-01', '2024-05-31'), { '2024-05-21': 80_400 })
    // (3 x 1,204.00 + 1,800.00) x 52 / (4 x 12), where it was 6,734.00; then over 8 and 13 checks, where they were
    // 5,975.67 and 5,684.00.
    assert.deepEqual(takeHome(KILN, '2024-05', '2024-07'), { '2024-05': 586_300, '2024-06': 554_017, '2024-07': 541_600 })
  })
})

describe('point in time across a change of schedule', () => {
  afterEach(db.closeDb)

  const PAYEE = 'Saltmarrow Kiln Payroll'
  const patterns: Record<string, Array<[string, number]>> = {
    'every Friday, then every other Friday': [...at(100_000, every(7, '2025-01-03', '2025-09-26')), ...at(200_000, every(14, '2025-10-10', '2026-03-27'))],
    'every other Friday, then monthly': [...at(200_000, every(14, '2025-01-10', '2025-06-27')), ...at(433_333, months('2025-07', '2026-03').map((m) => friday(lastDay(m))))],
    'monthly, then every other Thursday': [...at(433_333, months('2024-01', '2024-08').map((m) => `${m}-01`)), ...at(200_000, every(14, '2024-08-15', '2025-03-27'))],
    'every other Wednesday, then weekly, with a bonus': [...at(240_000, every(14, '2023-10-11', '2024-04-24')), ['2024-04-30', 96_000], ...at(120_400, every(7, '2024-05-07', '2024-11-26')), ['2024-05-23', 140_000]],
    'every other Friday with two checks off it': [...at(200_000, every(14, '2025-11-07', '2026-10-30')), ['2026-06-09', 30_000], ['2026-06-23', 25_000]],
    'every other Friday with an off-cycle check before payday': [...at(200_000, every(14, '2025-05-02', '2026-04-24')), ['2025-12-08', 500_000]]
  }

  for (const [name, checks] of Object.entries(patterns)) {
    test(`${name}: each month's run rates and checks read the same once later checks come in`, () => {
      household()
      const first = checks.map(([d]) => d.slice(0, 7)).sort()[0]
      const last = checks.map(([d]) => d.slice(0, 7)).sort().at(-1)!
      const seen = new Map<string, string>()
      for (const m of months(first, last)) {
        pay(PAYEE, checks.filter(([d]) => d.startsWith(m)))
        seen.set(m, JSON.stringify([payRunRates(m), payrollChecks(`${m}-01`, lastDay(m))]))
      }
      for (const [m, was] of seen) assert.equal(JSON.stringify([payRunRates(m), payrollChecks(`${m}-01`, lastDay(m))]), was, m)
    })
  }
})

describe("a change of schedule that each check's own paystub states", () => {
  beforeEach(household)
  afterEach(db.closeDb)

  const QUAY = 'Gorsewick Quay Payroll'
  /** A check whose own stub states its pay period, `length` days ending five days before it, with nothing taken out. */
  const stubbed = (cents: number, days: string[], length: number): void => {
    for (const day of days) {
      deposit(day, cents, QUAY)
      savePaystub({ paycheckKey: key(QUAY), payDay: day, periodFrom: addDays(day, -length - 4), periodTo: addDays(day, -5), grossCents: cents, items: [] })
    }
  }

  test("every other Wednesday at 2,400.00 with 14-day stubs, then every Tuesday from Apr 30, 2024 with 7-day stubs: April's run rate reads Apr 30's check alone at 52 a year, not every check since February", () => {
    stubbed(240_000, every(14, '2023-10-11', '2024-04-24'), 14)
    stubbed(96_000, ['2024-04-30'], 7)
    const april = payRunRates('2024-04')
    stubbed(120_400, every(7, '2024-05-07', '2024-10-01'), 7)
    // The checks and stubs after April change nothing of it.
    assert.deepEqual(payRunRates('2024-04'), april)
    // Apr 30's stub says a week: 52 a year in April, as before, and the weekly run begins after Apr 24, the latest
    // check whose own stub says two weeks.
    assert.deepEqual(perYear(QUAY, '2024-03', '2024-06'), { '2024-03': 26, '2024-04': 52, '2024-05': 52, '2024-06': 52 })
    assert.deepEqual(takeHome(QUAY, '2024-03', '2024-07'), {
      '2024-03': 520_000,
      // 960.00 x 52 / 12. With every check in February to April it was 15,360.00 x 52 / (7 x 12), 9,508.57.
      '2024-04': 416_000,
      // Apr 30's 960.00 is 80% of the 1,204.00 after it, more than two thirds, so it counts: (960.00 + 4 x
      // 1,204.00) x 52 / (5 x 12).
      '2024-05': 500_587,
      '2024-06': 509_985,
      '2024-07': 521_733
    })
  })

  test('every other Friday at 2,000.00 with 14-day stubs, then every Friday at 1,000.00 from Aug 1, 2025 with 7-day stubs: the weekly run begins at Aug 1, not at Jul 25, which falls on a Friday too', () => {
    stubbed(200_000, every(14, '2025-01-10', '2025-07-25'), 14)
    stubbed(100_000, every(7, '2025-08-01', '2026-03-27'), 7)
    assert.deepEqual(payRunRates('2025-08').keys[0].days, ['2025-08-01', '2025-08-08', '2025-08-15', '2025-08-22', '2025-08-29'])
    // 1,000.00 x 52 / 12. With Jul 25's 2,000.00 in the run, August was 5,055.56 and September 4,766.67.
    assert.deepEqual(takeHome(QUAY, '2025-07', '2025-09'), { '2025-07': 433_333, '2025-08': 433_333, '2025-09': 433_333 })
  })

  test('every Friday at 1,000.00 with 7-day stubs, then every other Friday at 2,000.00 from Oct 10, 2025 with 14-day stubs: October and November are 4,333.33, not 2,560.61 and 3,250.00', () => {
    stubbed(100_000, every(7, '2025-01-03', '2025-09-26'), 7)
    stubbed(200_000, every(14, '2025-10-10', '2026-06-26'), 14)
    assert.deepEqual(perYear(QUAY, '2025-09', '2025-11'), { '2025-09': 52, '2025-10': 26, '2025-11': 26 })
    assert.deepEqual(takeHome(QUAY, '2025-09', '2025-12'), { '2025-09': 433_333, '2025-10': 433_333, '2025-11': 433_333, '2025-12': 433_333 })
  })
})

describe('checks off the schedule', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  const MILL = 'Thistlewade Mill Payroll'

  test("two checks off the schedule two weeks apart are both bonus: every other Friday at 2,000.00 with 300.00 on Tuesday Jun 9 and 250.00 on Tuesday Jun 23, 2026 keeps May to October at 4,333.33", () => {
    pay(MILL, [...at(200_000, every(14, '2025-11-07', '2026-10-30')), ['2026-06-09', 30_000], ['2026-06-23', 25_000]])
    // Jun 23 comes with Jun 9 among the latest four days, which then keep no schedule: it is judged by the schedule
    // the regular checks keep, as Jun 9 was.
    assert.deepEqual(payrollChecks('2026-06-01', '2026-06-30').filter((c) => c.kind === 'bonus').map((c) => c.day), ['2026-06-09', '2026-06-23'])
    // 2,000.00 x 26 / 12.
    assert.deepEqual(takeHome(MILL, '2026-05', '2026-10'), Object.fromEntries(months('2026-05', '2026-10').map((m) => [m, 433_333])))
  })

  test("a paycheck on its schedule's day is regular though an off-cycle check came four days before it: every other Friday at 2,000.00, and 5,000.00 on Monday Dec 8, 2025, ten days after Nov 28", () => {
    pay(MILL, [...at(200_000, every(14, '2025-05-02', '2026-04-24')), ['2025-12-08', 500_000]])
    // Dec 8 comes more than half a period after Nov 28, so it counts as a regular check, its part above 3,000.00
    // bonus. Friday Dec 12 is every other Friday's own day: regular, where it was all bonus.
    assert.deepEqual(
      payrollChecks('2025-12-01', '2025-12-31').map((c) => [c.day, c.kind, c.depositCents]),
      [
        ['2025-12-08', 'regular', 300_000],
        ['2025-12-08', 'bonus', 200_000],
        ['2025-12-12', 'regular', 200_000],
        ['2025-12-26', 'regular', 200_000]
      ]
    )
  })

  test('the same on the 15th and the last: 300.00 on Monday Jun 22 and 250.00 on Tuesday Jul 7, 2026 are bonus, and May to October stay 4,000.00', () => {
    pay(MILL, [...at(200_000, fifteenthAndLast('2025-11', '2026-10')), ['2026-06-22', 30_000], ['2026-07-07', 25_000]])
    assert.deepEqual(payrollChecks('2026-06-01', '2026-07-31').filter((c) => c.kind === 'bonus').map((c) => c.day), ['2026-06-22', '2026-07-07'])
    assert.deepEqual(takeHome(MILL, '2026-05', '2026-10'), Object.fromEntries(months('2026-05', '2026-10').map((m) => [m, 400_000])))
  })
})

describe("a new payroll's first checks", () => {
  beforeEach(household)
  afterEach(db.closeDb)

  const LARK = 'Larkmoor Payroll'
  const CLINIC = 'Fernhollow Clinic Payroll'
  const LABS = 'Marrowby Labs Payroll'

  /** The 15th and the last from Jun 30, 2025: a first check of 440.00, then 2,900.00, 2,830.00 and 2,860.00 from August. */
  const clinic = (through: string): Array<[string, number]> => [['2025-06-30', 44_000], ['2025-07-15', 290_000], ['2025-07-31', 283_000], ...at(286_000, fifteenthAndLast('2025-08', through))]

  test("a job on the 15th and the last whose first check, Jun 30, 2025, paid 440.00 for part of the period: July's Take-home run rate is 5,730.00 from the two checks after it, not 4,113.33", () => {
    pay(CLINIC, clinic('2026-01'))
    assert.deepEqual(perYear(CLINIC, '2025-06', '2025-10'), { '2025-06': 12, '2025-07': 24, '2025-08': 24, '2025-09': 24, '2025-10': 24 })
    assert.deepEqual(takeHome(CLINIC, '2025-06', '2025-10'), {
      // June's one check, with nothing after it to judge it by: 440.00 x 12 / 12.
      '2025-06': 44_000,
      // 440.00 is under two thirds of 2,865.00, the two checks after it: (2,900.00 + 2,830.00) x 24 / (2 x 12).
      '2025-07': 573_000,
      // 11,450.00 x 24 / (4 x 12).
      '2025-08': 572_500,
      // Jun 30 is before the window: 17,170.00 x 24 / (6 x 12).
      '2025-09': 572_333,
      '2025-10': 572_000
    })
    assert.deepEqual(payRunRates('2025-07').keys[0].days, ['2025-07-15', '2025-07-31'])
    // It is still a regular check, in June's actual.
    assert.deepEqual(payrollChecks('2025-06-30', '2025-06-30').map((c) => [c.kind, c.depositCents]), [['regular', 44_000]])
  })

  test("the 401(k)'s room reads the checks the run rate reads: with the first check's own stub left out, July's Saved at work is 600.00 and the room 1,358.33, the twelfth of the limit less it", () => {
    const stub = (payDay: string, gross: number, k401: number): number => savePaystub({ paycheckKey: key(CLINIC), payDay, grossCents: gross, items: [{ kind: '401k', name: 'Fernhollow 401(k)', cents: k401 }] })
    pay(CLINIC, [['2025-06-30', 95_000], ['2025-07-15', 570_000], ['2025-07-31', 570_000]])
    stub('2025-06-30', 100_000, 5_000)
    stub('2025-07-15', 600_000, 30_000)
    stub('2025-07-31', 600_000, 30_000)
    const w = getWaterfall({ from: '2025-07', to: '2025-07' })
    // 300.00 x 24 / 12; with Jun 30's 50.00 it was 650.00 x 24 / (3 x 12), 433.33.
    assert.equal(w.rows.find((r) => r.id === 'savedAtWork')!.runRateCents, 60_000)
    assert.deepEqual(w.levers.filter((l) => l.kind === 'tax_room').map((l) => [l.name, l.monthlyCents]), [['401(k)', 195_833 - 60_000]])
  })

  test("a job whose single first check, Sep 30, 2025, has nothing else is 12 a year in September, until a stub's half-month pay period says 24: the day of the month doesn't", () => {
    pay(LABS, at(512_500, ['2025-09-30', ...fifteenthAndLast('2025-10', '2026-01')]))
    assert.deepEqual(perYear(LABS, '2025-09', '2025-11'), { '2025-09': 12, '2025-10': 24, '2025-11': 24 })
    assert.deepEqual(takeHome(LABS, '2025-09', '2025-10'), { '2025-09': 512_500, '2025-10': 1_025_000 })
    pay(CLINIC, clinic('2025-09'))
    // September's Take-home run rate with both jobs: 5,723.33 and 5,125.00.
    assert.equal(payRunRates('2025-09').totals.takeHomeCents, 1_084_833)
    savePaystub({ paycheckKey: key(LABS), payDay: '2025-09-30', periodFrom: '2025-09-16', periodTo: '2025-09-30', grossCents: 512_500, items: [] })
    assert.deepEqual([checksPerYear(key(LABS), '2025-09'), takeHome(LABS, '2025-09', '2025-09')['2025-09']], [24, 1_025_000])
  })

  test('a first check is judged only once two checks follow it: every other Friday from Oct 16, 2026 at 700.00 and then 2,800.00 keeps October at 3,791.67', () => {
    pay(LARK, [['2026-10-16', 70_000], ['2026-10-30', 280_000]])
    // 3,500.00 x 26 / (2 x 12): one check after it could be the odd one itself.
    assert.deepEqual([checksPerYear(key(LARK), '2026-10'), takeHome(LARK, '2026-10', '2026-10')['2026-10']], [26, 379_167])
  })

  test("a month's run rates read only what is dated up to it: later checks never change an earlier month's, the first checks' months among them", () => {
    const checks: Array<[string, string, number]> = [
      ...every(14, '2023-10-11', '2024-04-24').map((d): [string, string, number] => ['Quillfeather Freight Payroll', d, 240_000]),
      ['Quillfeather Freight Payroll', '2024-04-30', 96_000],
      ...every(7, '2024-05-07', '2025-05-27').map((d): [string, string, number] => ['Quillfeather Freight Payroll', d, 120_400]),
      ...clinic('2026-01').map(([d, cents]): [string, string, number] => ['Fernhollow Clinic Payroll', d, cents]),
      ...['2025-09-30', ...fifteenthAndLast('2025-10', '2026-01')].map((d): [string, string, number] => ['Marrowby Labs Payroll', d, 512_500]),
      ['Larkmoor Payroll', '2026-10-16', 70_000],
      ['Larkmoor Payroll', '2026-10-30', 280_000],
      ...every(14, '2025-11-07', '2026-06-19').map((d): [string, string, number] => ['Bramblecot Dockworks Payroll', d, 200_000]),
      ['Bramblecot Dockworks Payroll', '2026-07-15', 108_333],
      ...fifteenthAndLast('2026-07', '2026-10')
        .slice(1)
        .map((d): [string, string, number] => ['Bramblecot Dockworks Payroll', d, 216_667])
    ]
    const seen = new Map<string, ReturnType<typeof payRunRates>>()
    for (const m of months('2023-10', '2026-10')) {
      for (const [payee, day, cents] of checks.filter(([, d]) => d.startsWith(m))) deposit(day, cents, payee)
      seen.set(m, payRunRates(m))
      for (const [earlier, was] of seen) assert.deepEqual(payRunRates(earlier), was, `${earlier} after ${m}`)
    }
    // The figures each month read when its checks were in.
    const of = (m: string, payee: string): number | undefined => seen.get(m)!.keys.find((k) => k.paycheckKey === key(payee))?.takeHomeCents
    assert.deepEqual([of('2024-04', 'Quillfeather Freight Payroll'), of('2024-05', 'Quillfeather Freight Payroll'), of('2024-07', 'Quillfeather Freight Payroll')], [520_000, 521_733, 521_733])
    assert.deepEqual([of('2025-06', CLINIC), of('2025-07', CLINIC), of('2025-09', LABS), of('2026-10', LARK)], [44_000, 573_000, 512_500, 379_167])
    assert.deepEqual([of('2026-07', 'Bramblecot Dockworks Payroll'), of('2026-08', 'Bramblecot Dockworks Payroll')], [406_250, 433_334])
  })
})
