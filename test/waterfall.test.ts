import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, linesFor } from '../src/main/lines.ts'
import { payrollChecks, savePaystub } from '../src/main/paystubs.ts'
import { carryingCost } from '../src/main/uses.ts'
import { getWaterfall, runRates } from '../src/main/waterfall.ts'
import { ratePct, roundDiv } from '../src/shared/rounding.ts'
import { addDays, daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { ClassifiedLine, LineClass, StageId, StagePart, StageRow, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { deposit as payDeposit, household as payHousehold, KEY as PAY_KEY } from './fixtures/paystubs.ts'
import { ACCOUNTS, gigHousehold, household, line, stub, TODAY, transactorHousehold } from './fixtures/waterfall-household.ts'

// The Personal waterfall (spec 1.1 to 1.12, sub-phase 1e): every row's amount, run rate, rate and their changes over
// 3 months, from the classifier's lines and the paystubs' checks. Section 5's household is the fixture: every
// figure the spec derives for its October 2026 comes out of the engine here. Subtotals are differences, so the chain
// ties to the cent in every month and every span; ventures never move a row.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const KEPT: LineClass[] = ['pay', 'income', 'tax', 'committed', 'debtCost', 'everyday', 'oneOff', 'oneOffIncome']
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const row = (w: Waterfall, id: StageId): StageRow => {
  const r = w.rows.find((x) => x.id === id)
  assert.ok(r, `no ${id} row`)
  return r
}
const part = (r: StageRow, key: string): StagePart => {
  const p = r.parts.find((x) => x.key === key)
  assert.ok(p, `no part ${key} in ${r.id}`)
  return p
}
/** A row's figures as Home lays them out: amount, run rate, rate, Δ 3 mo and Δ pts. */
const figures = (r: StageRow): Array<number | null> => [r.actualCents, r.runRateCents, r.rate, r.changeCents, r.rateChangePts]
/** Whole dollars, each rounded half away from zero from its own cents, as Home shows them. */
const dollars = (cents: number): number => roundDiv(cents, 100)
const sum = (parts: StagePart[], f: (p: StagePart) => number | null): number => parts.reduce((s, p) => s + (f(p) ?? 0), 0)
const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id

/**
 * The chain to the cent, for amounts and run rates alike: each subtotal from the rows before it, Saved and Invested
 * from their parts, every row the sum of its parts; Kept, against the ledger's own lines over the span.
 */
function assertChain(w: Waterfall, lines: ClassifiedLine[]): void {
  type Figure = Pick<StageRow, 'actualCents' | 'runRateCents'>
  for (const [what, f] of [
    ['amounts', (x: Figure) => x.actualCents],
    ['run rates', (x: Figure) => x.runRateCents ?? 0]
  ] as const) {
    const at = (id: StageId): number => {
      const r = w.rows.find((x) => x.id === id)
      return r ? f(r) : 0
    }
    const merged = !w.rows.some((r) => r.id === 'gross')
    if (!merged) assert.equal(at('gross') - at('taxes') - at('benefits') - at('savedAtWork') + at('payrollDiff'), at('takeHome'), `Take-home's ${what}`)
    assert.equal(at('takeHome') - at('committed'), at('elective'), `Elective's ${what}`)
    assert.equal(at('elective') - at('everyday'), at('leftOver'), `Left over's ${what}`)
    const of = (r: StageRow, key: string): number => f(part(r, key))
    const saved = row(w, 'saved')
    const invested = row(w, 'invested')
    assert.equal(at('leftOver') - at('oneOffs'), of(saved, 'kept'), `Kept's ${what}`)
    assert.equal(of(saved, 'kept') + of(saved, 'atWork') + of(saved, 'employer'), at('saved'), `Saved's ${what}`)
    assert.equal(of(invested, 'atWork') + of(invested, 'employer') + of(invested, 'fromCash'), at('invested'), `Invested's ${what}`)
    assert.equal(of(saved, 'atWork'), at('savedAtWork'), `Saved at work's ${what}`)
    for (const r of w.rows) if (r.parts.length) assert.equal(r.parts.reduce((s, x) => s + f(x), 0), f(r), `${r.id}'s parts' ${what}`)
  }
  // The parts explain each row's Δ 3 mo, a part gone since included.
  for (const r of w.rows) if (r.parts.length && r.changeCents !== null) assert.equal(sum(r.parts, (p) => p.changeCents), r.changeCents, `${r.id}'s parts' Δ 3 mo`)
  const keptLines = lines.filter((l) => l.owner === null && KEPT.includes(l.cls)).reduce((s, l) => s + l.cents, 0)
  assert.equal(part(row(w, 'saved'), 'kept').actualCents, keptLines, "Kept is the ledger's own lines")
}

describe("section 5's household", () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('October 2026 reproduces every derived figure: amounts, run rates, rates, Δ 3 mo and Δ pts', () => {
    const w = month('2026-10')
    assert.deepEqual([w.endMonth, w.partial], ['2026-10', false])
    assert.deepEqual(
      w.rows.map((r) => r.id),
      ['gross', 'taxes', 'benefits', 'savedAtWork', 'takeHome', 'committed', 'elective', 'everyday', 'leftOver', 'oneOffs', 'saved', 'invested', 'growth']
    )
    // Pay: semimonthly, every check its own stub, deposited as it says.
    assert.ok(payrollChecks('2026-08-01', '2026-10-31').every((c) => c.basis === 'paystub' && c.differenceCents === 0))
    assert.deepEqual(figures(row(w, 'gross')), [600_000, 600_000, null, 0, null])
    assert.deepEqual(figures(row(w, 'taxes')), [143_100, 143_100, 23.9, 0, 0])
    assert.deepEqual(figures(row(w, 'benefits')), [19_200, 19_200, 3.2, 0, 0])
    assert.deepEqual(figures(row(w, 'savedAtWork')), [60_000, 60_000, 10, 0, 0])
    assert.deepEqual(figures(row(w, 'takeHome')), [377_700, 377_700, 63, 0, 0])
    // Committed in force: 800 + 380 + 232 + 60 + 48 + 86 + 290 + 210 + 100.50, with Netflix at 17.99.
    assert.deepEqual(figures(row(w, 'committed')), [223_290, 220_650, 58.4, 3_450, 0.9])
    assert.deepEqual(figures(row(w, 'elective')), [154_410, 157_050, 41.6, -3_450, -0.9])
    assert.deepEqual(figures(row(w, 'everyday')), [110_640, 102_000, 64.9, 7_000, 5.8])
    assert.deepEqual(figures(row(w, 'leftOver')), [43_770, 55_050, 35.1, -10_450, -5.8])
    assert.deepEqual(figures(row(w, 'oneOffs')), [64_000, 25_000, 45.4, 1_500, 9.5])
    assert.deepEqual(figures(row(w, 'saved')), [68_570, 118_850, 18.9, -11_950, -1.9])
    assert.deepEqual(figures(row(w, 'invested')), [138_800, 113_800, 95.8, 0, 8.7])
    assert.deepEqual(figures(row(w, 'growth')), [214_000, 120_000, 0.5, null, null])
    assert.deepEqual(
      row(w, 'saved').parts.map((p) => [p.key, p.actualCents, p.runRateCents]),
      [
        ['kept', -20_230, 30_050],
        ['atWork', 60_000, 60_000],
        ['employer', 28_800, 28_800]
      ]
    )
    assert.deepEqual(
      row(w, 'invested').parts.map((p) => [p.name, p.actualCents, p.runRateCents, p.changeCents]),
      [
        ['Saved at work', 60_000, 60_000, 0],
        ['Employer saving', 28_800, 28_800, 0],
        ['From cash', 50_000, 25_000, 0]
      ]
    )
    assert.deepEqual(w.employerAdds, { matchCents: 24_000, hsaCents: 4_800, premiumCents: 41_000 })
    // Growth: the brokerage's 2,083.00 and the savings' 57.00, on 240,000.00 invested on Oct 1.
    assert.deepEqual(row(w, 'growth').parts.map((p) => [p.name, p.actualCents, p.runRateCents]), [
      ['Brokerage', 208_300, 114_300],
      ['Cash return', 5_700, 5_700]
    ])
    assert.equal(row(w, 'growth').rateFrom, 'investedBalance')
    // The pay rows carry where their pay comes from; the rest don't.
    assert.deepEqual(w.rows.filter((r) => r.basis !== null).map((r) => [r.id, r.basis]), [
      ['gross', 'paystub'],
      ['taxes', 'paystub'],
      ['benefits', 'paystub'],
      ['savedAtWork', 'paystub'],
      ['takeHome', 'paystub'],
      ['saved', 'paystub'],
      ['invested', 'paystub']
    ])
    assertChain(w, classifyLines('2026-10-01', '2026-10-31'))
  })

  test("three months earlier (July, its window May to July): Elective 1,605.00, Left over 655.00, Kept 420.00, Saved 1,308.00, Invested 1,138.00", () => {
    const r = runRates('2026-07')
    assert.deepEqual([r.fromMonth, r.toMonth, r.basis], ['2026-05', '2026-07', 'paystub'])
    assert.deepEqual(
      [r.rows.takeHome, r.rows.committed, r.rows.elective, r.rows.everyday, r.rows.leftOver, r.rows.oneOffs, r.rows.saved, r.rows.invested, r.employerSavingCents],
      [377_700, 217_200, 160_500, 95_000, 65_500, 23_500, 130_800, 113_800, 28_800]
    )
    const july = month('2026-07')
    assert.equal(part(row(july, 'saved'), 'kept').runRateCents, 42_000)
    assert.deepEqual(['elective', 'leftOver', 'saved', 'invested'].map((id) => row(july, id as StageId).rate), [42.5, 40.8, 20.8, 87])
    assert.equal(part(row(july, 'everyday'), 'cat:' + category('Dining Out')).runRateCents, 40_800)
    assert.equal(part(row(july, 'committed'), 'series:netflix|-').runRateCents, 1_549)
    // October's run rates less July's are its Δ 3 mo, and its trend's points are each month's run rates.
    const oct = month('2026-10')
    for (const id of ['committed', 'elective', 'leftOver', 'saved', 'invested'] as StageId[]) assert.equal(row(oct, id).changeCents, row(oct, id).runRateCents! - (r.rows[id] as number))
    assert.deepEqual(row(oct, 'leftOver').trend.slice(-4).map((t) => [t.month, t.runRateCents]), [
      ['2026-07', 65_500],
      ['2026-08', 65_913],
      ['2026-09', 60_813],
      ['2026-10', 55_050]
    ])
    assert.equal(row(oct, 'leftOver').trend.length, 12)
    assert.equal(row(oct, 'leftOver').trend[0].month, '2025-11')
  })

  test('Home shows Δ 3 mo as -35, -35, -105, -120 and 0, and the amounts and run rates in whole dollars', () => {
    const w = month('2026-10')
    // Committed is a cost: its rise of 34.50 shows as -35.
    assert.deepEqual([-dollars(row(w, 'committed').changeCents!), ...(['elective', 'leftOver', 'saved', 'invested'] as StageId[]).map((id) => dollars(row(w, id).changeCents!))], [-35, -35, -105, -120, 0])
    assert.deepEqual(
      (['takeHome', 'elective', 'leftOver', 'saved', 'invested', 'growth'] as StageId[]).map((id) => [dollars(row(w, id).actualCents), dollars(row(w, id).runRateCents!)]),
      [
        [3_777, 3_777],
        [1_544, 1_571],
        [438, 551],
        [686, 1_189],
        [1_388, 1_138],
        [2_140, 1_200]
      ]
    )
    // Δ pts is the exact ratios' difference: Left over's displayed rates differ by -5.7, Invested's by +8.8.
    assert.equal(Math.round((row(w, 'leftOver').rate! - 40.8) * 10) / 10, -5.7)
    assert.equal(Math.round((row(w, 'invested').rate! - 87) * 10) / 10, 8.8)
  })

  test("Committed's groups, Everyday's categories and the series behind them", () => {
    const w = month('2026-10')
    const committed = row(w, 'committed').parts
    const group = (g: string): [number, number] => {
      const mine = committed.filter((p) => p.group === g)
      return [sum(mine, (p) => p.actualCents), sum(mine, (p) => p.runRateCents)]
    }
    // Actuals 1,412 + 192 + 318 + 210 + 101 = 2,233; run rates 1,412 + 194 + 290 + 210 + 101 = 2,207.
    assert.deepEqual(
      ['housing', 'debtCost', 'utilities', 'insurance', 'subscriptions'].map(group),
      [
        [141_200, 141_200],
        [19_240, 19_400],
        [31_800, 29_000],
        [21_000, 21_000],
        [10_050, 10_050]
      ]
    )
    assert.deepEqual(committed.filter((p) => p.group === 'debtCost').map((p) => [p.name, p.actualCents, p.runRateCents]), [
      ['Student Loan', 8_600, 8_600],
      ['Visa', 5_840, 6_000],
      ['Civic Auto Loan', 4_800, 4_800]
    ])
    assert.deepEqual([part(row(w, 'committed'), 'series:netflix|-').runRateCents, part(row(w, 'committed'), 'series:netflix|-').marker], [1_799, 'priceChange'])
    // The utility's run rate is the median of its latest six; a year before, 270.00 against 284.00 that month.
    const year = month('2025-10')
    assert.deepEqual([part(row(year, 'committed'), 'series:harbor power|-').actualCents, part(row(year, 'committed'), 'series:harbor power|-').runRateCents], [28_400, 27_000])
    assert.deepEqual(
      row(w, 'everyday').parts.map((p) => [p.name, p.tag, p.actualCents, p.runRateCents, p.changeCents]),
      [
        ['Dining Out', 'lifestyle', 52_040, 47_800, 7_000],
        ['Groceries', 'essential', 33_000, 31_200, 0],
        ['Coffee', 'lifestyle', 15_100, 13_200, 0],
        ['Gas & Fuel', 'essential', 10_500, 9_800, 0]
      ]
    )
    // A part's drill finds its lines: October's gas is the two Shell lines on the Visa.
    const gas = linesFor(part(row(w, 'everyday'), `cat:${category('Gas & Fuel')}`).drill)
    assert.deepEqual([gas.total, gas.cents], [2, -10_500])
  })

  test('the focus dot goes to Left over, whose rate fell most; Unsorted is 16.00, within the tolerance of 18.89', () => {
    const w = month('2026-10')
    assert.equal(w.toleranceCents, 1_889)
    assert.deepEqual([w.unsorted.cents, w.unsorted.count], [-1_600, 2])
    assert.equal(w.focus, 'leftOver')
  })

  test('One-offs stay out of the Everyday run rate and enter Saved at the 12-month average', () => {
    const before = month('2026-10')
    // A 1,200.00 one-off in October, from a payee never seen before.
    const id = line(ACCOUNTS.visa, '2026-10-24', -120_000, 'LUMEN ELECTRONICS', 'Shopping', 'Lumen Electronics')
    try {
      const w = month('2026-10')
      assert.deepEqual([row(w, 'everyday').actualCents, row(w, 'everyday').runRateCents], [row(before, 'everyday').actualCents, 102_000])
      assert.deepEqual([row(w, 'oneOffs').actualCents, row(w, 'oneOffs').runRateCents], [184_000, 35_000])
      assert.equal(row(w, 'saved').runRateCents, row(before, 'saved').runRateCents! - 10_000)
      assert.equal(row(w, 'saved').actualCents, row(before, 'saved').actualCents - 120_000)
    } finally {
      db.deleteTransaction(id)
    }
  })

  test("its balances carry section 5's October for the identities (sub-phase 1g): checking -1,974.30, savings +300.00, Visa owing 150.00 more, 240,000.00 invested, net worth 412,300.00 up 2,390.70", () => {
    const ids = db.listAccounts().filter((a) => !a.hidden).map((a) => a.id)
    const [start, end] = ['2026-09-30', '2026-10-31'].map((d) => db.balancesOn(ids, d))
    const change = (id: string): number => end.get(id)! - start.get(id)!
    assert.deepEqual([change(ACCOUNTS.checking), change(ACCOUNTS.savings), change(ACCOUNTS.visa), change(ACCOUNTS.studio)], [-197_430, 30_000, -15_000, -50_900])
    assert.equal([ACCOUNTS.brokerage, ACCOUNTS.retirement, ACCOUNTS.hsa].reduce((s, id) => s + start.get(id)!, 0), 24_000_000)
    // B: 240,000 + 500 + 600 + 288 + 2,083.
    assert.equal([ACCOUNTS.brokerage, ACCOUNTS.retirement, ACCOUNTS.hsa].reduce((s, id) => s + end.get(id)!, 0), 24_347_100)
    const total = (m: Map<string, number>): number => [...m.values()].reduce((s, c) => s + c, 0)
    assert.deepEqual([total(end), total(end) - total(start)], [41_230_000, 239_070])
  })

  test("the house's and the car's carrying cost are section 5's", () => {
    const h = db.listAccounts()
    const house = carryingCost(h.find((a) => a.name === 'Alder Lane house')!.id)!
    assert.deepEqual(house.rows.map((r) => [r.kind, r.cents]), [
      ['interest', 80_000],
      ['escrow', 38_000],
      ['hoa', 23_200],
      ['utilities', 29_000],
      ['insurance', 14_200],
      ['principal', 80_500]
    ])
    const car = carryingCost(h.find((a) => a.name === '2017 Civic')!.id)!
    assert.deepEqual(car.rows.map((r) => [r.kind, r.cents]), [
      ['interest', 4_800],
      ['insurance', 6_800],
      ['gas', 9_800],
      ['principal', 36_400]
    ])
  })
})

describe('variations on the household', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('Unsorted at -86.00 (3 lines) puts the focus on Unsorted, because 86.00 is above 18.89', () => {
    household({ unsorted86: true })
    const w = month('2026-10')
    assert.deepEqual([w.unsorted.cents, w.unsorted.count], [-8_600, 3])
    assert.equal(w.focus, 'unsorted')
    // Unsorted is in no row: Left over is as it was.
    assert.equal(row(w, 'leftOver').actualCents, 43_770)
  })

  test("deposits only: Gross pay and Take-home are one row, Saved's rate is 8.0% and Invested's 83.2%", () => {
    household({ paystubs: false })
    const w = month('2026-10')
    assert.deepEqual(
      w.rows.map((r) => r.id),
      ['takeHome', 'committed', 'elective', 'everyday', 'leftOver', 'oneOffs', 'saved', 'invested', 'growth']
    )
    assert.deepEqual(figures(row(w, 'takeHome')), [377_700, 377_700, null, 0, null])
    assert.equal(row(w, 'takeHome').basis, 'deposits')
    assert.deepEqual(figures(row(w, 'elective')), [154_410, 157_050, 41.6, -3_450, -0.9])
    assert.deepEqual(figures(row(w, 'leftOver')), [43_770, 55_050, 35.1, -10_450, -5.8])
    // Saved's base is Gross pay, which is Take-home here, plus no employer saving: 300.50 / 3,777.
    assert.deepEqual(figures(row(w, 'saved')).slice(0, 4), [-20_230, 30_050, 8, -11_950])
    // Invested is only the money from cash: 250 / 300.50, and 250 three months before.
    assert.deepEqual(figures(row(w, 'invested')).slice(0, 4), [50_000, 25_000, 83.2, 0])
    assert.deepEqual(figures(row(w, 'growth')), [214_000, 120_000, 0.5, null, null])
    assert.equal(w.focus, 'leftOver')
    assertChain(w, classifyLines('2026-10-01', '2026-10-31'))
  })

  test('a deposit 2.00 above its stub in March shows a Payroll difference while it is in an amount, a run rate or a change, and not in October', () => {
    household()
    const march = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description = 'BRIGHTLINE PAYROLL DIR DEP'").find((r) => db.dayKey(r.posted) === '2026-03-15')!.id
    db.run('UPDATE transactions SET amount_cents = amount_cents + 200 WHERE id = ?', march)
    // 200 × 24 / (6 × 12) = 66.67 a month while March is in the window, and -66.67 three months after.
    const diff = (m: string): Array<number | null> | null => {
      const r = month(m).rows.find((x) => x.id === 'payrollDiff')
      return r ? [r.actualCents, r.runRateCents, r.changeCents] : null
    }
    assert.deepEqual(['2026-03', '2026-05', '2026-06', '2026-10'].map(diff), [[200, 67, 67], [0, 67, 67], [0, 0, -67], null])
    assertChain(month('2026-03'), classifyLines('2026-03-01', '2026-03-31'))
    assert.equal(row(month('2026-03'), 'takeHome').actualCents, 377_900)
  })

  test("a part gone since 3 months before stays among the parts, so they explain the row's Δ 3 mo", () => {
    household()
    for (const day of ['2026-05-10', '2026-06-10']) line(ACCOUNTS.visa, day, -3_000, 'GLOSS SALON', 'Personal Care', 'Gloss Salon')
    const w = month('2026-10')
    // July's Everyday run rate had 20.00 of Personal Care (60.00 over 3); October's has none.
    assert.equal(row(w, 'everyday').changeCents, 7_000 - 2_000)
    assert.deepEqual(row(w, 'everyday').parts.map((p) => [p.name, p.actualCents, p.runRateCents, p.changeCents]).at(-1), ['Personal Care', 0, 0, -2_000])
    // assertChain checks every row's parts against its Δ 3 mo.
    assertChain(w, classifyLines('2026-10-01', '2026-10-31'))
  })

  test("a series' price in force is rounded once: a weekly 10.00 and 10.01 in turn is 10.005 a week, 43.36 a month", () => {
    household()
    for (let day = '2026-07-03', i = 0; day <= '2026-10-31'; day = addDays(day, 7), i++) line(ACCOUNTS.visa, day, i % 2 ? -1_001 : -1_000, 'MORNING PRESS', 'Subscriptions', 'Morning Press')
    const press = row(month('2026-10'), 'committed').parts.find((p) => p.name === 'Morning Press')
    assert.ok(press, 'no Morning Press part')
    // 1,000.5 × 52 / 12 = 4,335.5, rounded once; the median rounded first would give 1,001 × 52 / 12 = 4,337.67.
    assert.deepEqual([press.actualCents, press.runRateCents], [5_003, 4_336])
  })

  test('deposits only, with November open: a paystub dated Oct 31 puts November and August on estimated pay alike, so Take-home moves 0.0 points and gets no focus', () => {
    household({ paystubs: false })
    stub('2026-10-31')
    const w = month('2026-11')
    assert.deepEqual([w.endMonth, w.partial, w.status], ['2026-11', true, 'open'])
    assert.equal(row(w, 'takeHome').basis, 'estimated')
    // August's window, June to August, reads the same stub: the earliest after its checks in the year.
    assert.equal(runRates('2026-08').basis, 'estimated')
    assert.deepEqual([row(w, 'gross').runRateCents, row(w, 'takeHome').runRateCents, row(w, 'takeHome').rate, row(w, 'takeHome').rateChangePts], [600_000, 377_700, 63, 0])
    assert.equal(runRates('2026-08').rows.takeHome, 377_700)
    assert.notEqual(row(w, 'saved').rateChangePts, null)
    assert.notEqual(w.focus, 'takeHome')
  })
})

describe('a price that rose', () => {
  before(() => {
    // January 2027, with Netflix paid at its new 17.99 in November and December too.
    mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 1, 7) * 1000 })
    household()
    for (const day of ['2026-11-04', '2026-12-04']) line(ACCOUNTS.visa, day, -1_799, 'NETFLIX.COM', 'Subscriptions', 'Netflix')
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("stays in force after the payment that brought it: Netflix is 17.99 in October's Committed run rate, and in November's and December's", () => {
    const netflix = (m: string): StagePart => part(row(month(m), 'committed'), 'series:netflix|-')
    // The latest six to December are four at 15.49 and two at 17.99: their median is still the old price. The price
    // change is marked in the month it came; after it the series is only what it is, one the user hasn't confirmed (2b).
    assert.deepEqual(
      ['2026-10', '2026-11', '2026-12'].map((m) => [netflix(m).runRateCents, netflix(m).marker, netflix(m).price]),
      [
        [1_799, 'priceChange', { fromCents: 1_549, toCents: 1_799 }],
        [1_799, 'unconfirmed', undefined],
        [1_799, 'unconfirmed', undefined]
      ]
    )
    assert.equal(netflix('2026-07').runRateCents, 1_549)
  })
})

describe('pay bases that do not compare', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 4, 7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a first paystub in January leaves the year before on deposits: April's open month is estimated and January's deposits, so Take-home's and Saved's Δ pts are blank and the focus goes to neither", () => {
    // Section 5's check, deposited semimonthly from June 2026; its stub, entered for Jan 15, 2027, reaches back
    // only through that year, so November and December's checks are deposits alone.
    payHousehold()
    for (let m = '2026-06'; m <= '2027-03'; m = shiftMonth(m, 1)) for (const day of [`${m}-15`, lastDay(m)]) payDeposit(day, 188_850)
    savePaystub({
      paycheckKey: PAY_KEY,
      payDay: '2027-01-15',
      grossCents: 300_000,
      items: [
        { kind: 'federal', cents: 34_800 },
        { kind: 'social_security', cents: 18_600 },
        { kind: 'medicare', cents: 4_350 },
        { kind: 'state', cents: 13_800 },
        { kind: 'medical', cents: 9_600 },
        { kind: '401k', cents: 24_000 },
        { kind: 'hsa', cents: 6_000 }
      ]
    })
    const w = month('2027-04')
    assert.deepEqual([row(w, 'takeHome').basis, runRates('2027-01').basis], ['estimated', 'deposits'])
    assert.deepEqual([row(w, 'gross').runRateCents, row(w, 'takeHome').runRateCents, row(w, 'takeHome').rate], [600_000, 377_700, 63])
    assert.deepEqual(['takeHome', 'saved', 'invested'].map((id) => row(w, id as StageId).rateChangePts), [null, null, null])
    // Elective's rate reads Take-home, which is what was deposited at both ends: it compares.
    assert.equal(row(w, 'elective').rateChangePts, 0)
    assert.ok(w.focus !== 'takeHome' && w.focus !== 'saved')
  })
})

describe('a card paid in full, and a gig with estimated tax', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a card paid in full each month, with 3,000.00 owed at 24% and no interest line, adds nothing to Committed and has no card_interest lever', () => {
    transactorHousehold()
    const w = month('2026-10')
    assert.deepEqual([row(w, 'committed').actualCents, row(w, 'committed').runRateCents, row(w, 'committed').parts.length], [0, 0, 0])
    assert.equal(db.balancesOn([ACCOUNTS.visa], '2026-10-31').get(ACCOUNTS.visa), -300_000)
    assert.ok(!w.levers.some((l) => l.kind === 'card_interest'))
  })

  test('four quarterly estimates of 1,200.00 in 12 months are Taxes of 400.00 a month; a balance due of 900.00 on Apr 15 counts in April and in no run rate', () => {
    const { due } = gigHousehold()
    const oct = month('2026-10')
    // No paystub: Taxes are what the bank paid, and Gross pay is the side income.
    assert.deepEqual([row(oct, 'gross').runRateCents, row(oct, 'taxes').runRateCents, row(oct, 'takeHome').runRateCents], [500_000, 40_000, 460_000])
    assert.deepEqual(row(oct, 'taxes').parts.map((p) => [p.name, p.actualCents, p.runRateCents]), [['Estimated tax', 0, 40_000]])
    const apr = month('2026-04')
    assert.deepEqual([row(apr, 'taxes').actualCents, row(apr, 'taxes').runRateCents], [210_000, 40_000])
    assert.deepEqual(
      row(apr, 'taxes').parts.map((p) => [p.name, p.actualCents, p.runRateCents]),
      [
        ['Estimated tax', 120_000, 40_000],
        ['Balance due', 90_000, 0]
      ]
    )
    assert.deepEqual(part(row(apr, 'taxes'), 'tax:due').drill.ids, [due])
    assert.equal(row(apr, 'takeHome').actualCents, 500_000 - 210_000)
  })
})

describe('spans', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a YTD span's amounts are the sums of its months'; its rates are ratios of the span sums; its run rates are its end's; Per month is the amount over its months", () => {
    const ytd = getWaterfall({ from: '2026-01', to: '2026-11' })
    assert.deepEqual([ytd.endMonth, ytd.partial], ['2026-11', true])
    const months = Array.from({ length: 11 }, (_, i) => month(shiftMonth('2026-01', i)))
    const oct = month('2026-10')
    for (const r of ytd.rows) {
      assert.equal(r.actualCents, months.reduce((s, w) => s + row(w, r.id).actualCents, 0), r.id)
      assert.equal(r.perMonthCents, roundDiv(r.actualCents, 11), r.id)
      // A span ending in the open month takes its run rate from the last full month.
      assert.equal(r.runRateCents, row(oct, r.id).runRateCents, r.id)
      assert.equal(r.trend.length, 12)
    }
    // Each rate is the span's amount over the span's amount of the money it came from, in tenths of a percent.
    const at = (id: StageId): number => row(ytd, id).actualCents
    const tenths = (a: number, b: number): number => (Math.sign(a) * Math.floor((2000 * Math.abs(a) + b) / (2 * b))) / 10
    for (const r of ytd.rows) {
      if (r.id === 'gross' || r.id === 'growth') continue
      const base = r.rateFrom === 'earned' ? at('gross') + part(row(ytd, 'saved'), 'employer').actualCents : at(r.rateFrom as StageId)
      assert.equal(r.rate, tenths(r.actualCents, base), r.id)
    }
    assert.equal(row(ytd, 'saved').rateFrom, 'earned')
    assertChain(ytd, classifyLines('2026-01-01', '2026-11-30'))
    // A single month has no Per month.
    assert.equal(row(oct, 'everyday').perMonthCents, null)
  })

  test('a 30D span sums exactly the lines in those days; one that ends inside a closed month takes the month before\'s run rates', () => {
    const span = { from: addDays(TODAY, -29), to: TODAY }
    const w = getWaterfall(span)
    assert.deepEqual([w.endMonth, w.partial], ['2026-11', true])
    const lines = classifyLines(span.from, span.to)
    const cost = (cls: LineClass[]): number => -lines.filter((l) => l.owner === null && cls.includes(l.cls)).reduce((s, l) => s + l.cents, 0)
    assert.equal(row(w, 'everyday').actualCents, cost(['everyday']))
    assert.equal(row(w, 'committed').actualCents, cost(['committed', 'debtCost']))
    assert.equal(row(w, 'oneOffs').actualCents, cost(['oneOff', 'oneOffIncome']))
    assert.equal(row(w, 'everyday').actualCents, -linesFor({ fromDay: span.from, toDay: span.to, cls: ['everyday'] }, { limit: 1000 }).cents)
    // 30 days is less than a month: no Per month.
    assert.equal(row(w, 'everyday').perMonthCents, null)
    // Its rates are ratios of its own amounts, as any span's but one month's are; its run rates are the last full month's.
    for (const [id, base] of [['committed', 'takeHome'], ['everyday', 'elective'], ['leftOver', 'elective'], ['oneOffs', 'leftOver'], ['invested', 'saved']] as Array<[StageId, StageId]>) {
      assert.equal(row(w, id).rate, ratePct(row(w, id).actualCents, row(w, base).actualCents), id)
    }
    assert.equal(row(w, 'saved').rate, ratePct(row(w, 'saved').actualCents, row(w, 'gross').actualCents + part(row(w, 'saved'), 'employer').actualCents))
    assertChain(w, lines)
    const inside = getWaterfall({ from: '2026-09-21', to: '2026-10-20' })
    assert.deepEqual([inside.endMonth, inside.partial], ['2026-09', true])
    const sep = month('2026-09')
    for (const r of inside.rows) assert.equal(r.runRateCents, row(sep, r.id).runRateCents, r.id)
    // Its trend's last point, October, is at the run rate in force on Oct 20, September's, not October's own.
    for (const r of inside.rows) assert.deepEqual([r.trend.at(-1)!.month, r.trend.at(-1)!.runRateCents, r.trend.at(-1)!.rate], ['2026-10', row(sep, r.id).runRateCents, row(sep, r.id).rate], r.id)
    assert.notEqual(row(month('2026-10'), 'leftOver').runRateCents, row(sep, 'leftOver').runRateCents)
  })

  test('a span of days past today is cut at today, as a span of months is at the current month', () => {
    const w = getWaterfall({ from: '2026-10-09', to: '2027-02-15' })
    assert.deepEqual([w.span, w.endMonth, w.partial, w.months.at(-1)!.month], [{ from: '2026-10-09', to: TODAY }, '2026-11', true, '2026-11'])
    // Its run rates and their changes are today's: Left over's 550.50 is 108.63 below August's 659.13, where
    // against a month to come it would have been 0.
    assert.deepEqual(w.rows, getWaterfall({ from: '2026-10-09', to: TODAY }).rows)
    assert.deepEqual([row(w, 'leftOver').runRateCents, row(w, 'leftOver').changeCents], [55_050, -10_863])
    assert.equal(getWaterfall({ from: '2027-01-01', to: '2027-01-31' }).span.from, TODAY)
  })
})

describe('the sample household', () => {
  let first = ''
  let current = ''
  const months = (): string[] => {
    const out: string[] = []
    for (let m = first; m <= current; m = shiftMonth(m, 1)) out.push(m)
    return out
  }
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
    first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    current = db.today().slice(0, 7)
  })
  after(db.closeDb)

  test('the chain ties to the cent in every month, and Kept is the ledger\'s own lines', () => {
    for (const m of months()) assertChain(month(m), classifyLines(`${m}-01`, lastDay(m)))
  })

  test('the chain ties over the 12M and All spans to the cent', () => {
    const twelve = { from: shiftMonth(current, -11), to: current }
    assertChain(getWaterfall(twelve), classifyLines(`${twelve.from}-01`, lastDay(current)))
    const all = getWaterfall({ from: first, to: current })
    assert.equal(all.rows[0].trend.length, months().length)
    assertChain(all, classifyLines(`${first}-01`, lastDay(current)))
  })

  test('doubling Bayview Rent changes no row', () => {
    const shown = (w: Waterfall): unknown => w.rows.map((r) => ({ ...r, parts: r.parts.map((p) => ({ ...p, drill: { ...p.drill, ids: undefined } })) }))
    const before = months().map((m) => shown(month(m)))
    const rent = db.all<{ id: string }>("SELECT id FROM transactions WHERE description LIKE 'RENTPAY%'").map((r) => r.id)
    assert.ok(rent.length > 10)
    db.run("UPDATE transactions SET amount_cents = amount_cents * 2 WHERE description LIKE 'RENTPAY%'")
    try {
      assert.deepEqual(months().map((m) => shown(month(m))), before)
    } finally {
      db.run("UPDATE transactions SET amount_cents = amount_cents / 2 WHERE description LIKE 'RENTPAY%'")
    }
  })

  test('getWaterfall takes under 200 ms of CPU for any month, and under 600 ms for the 12M span', () => {
    month(current)
    // CPU time, not the wall clock: npm test runs the test files at once, and a busy machine slows the clock
    // without the work getting any slower.
    const cpu = (f: () => unknown): number => {
      const t = process.cpuUsage()
      f()
      const used = process.cpuUsage(t)
      return (used.user + used.system) / 1000
    }
    for (const m of months()) {
      const ms = cpu(() => month(m))
      assert.ok(ms < 200, `${m} took ${ms.toFixed(0)} ms of CPU`)
    }
    const ms = cpu(() => getWaterfall({ from: shiftMonth(current, -11), to: current }))
    assert.ok(ms < 600, `the 12M span took ${ms.toFixed(0)} ms of CPU`)
  })
})
