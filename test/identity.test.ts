import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { getNetWorthSeries } from '../src/main/netWorth.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines } from '../src/main/lines.ts'
import { runTool } from '../src/main/tools.ts'
import { cashIdentity, closingStatus, getWaterfall, netWorthBridge } from '../src/main/waterfall.ts'
import { addDays, daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { CashIdentity, NetWorthBridge, StageId, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { household, link, manual, txn } from './fixtures/debts.ts'
import { ACCOUNTS, TODAY, line, tieOut, type TieOut } from './fixtures/tieout.ts'

// The cash identity and the net worth bridge (spec 2, sub-phase 1g): where Kept went, and how net worth moved,
// each to the cent. Section 2's tie-out is the fixture: every figure the spec works out for its October comes out of
// the engine here. 1c's purchases, sales and borrowing tie too, and so does every month of the sample household.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const actual = (w: Waterfall, id: StageId): number => w.rows.find((r) => r.id === id)!.actualCents

/** The cash identity's two sides. */
const sides = (x: CashIdentity): [number, number] => [
  x.keptCents + x.venturesCents + x.cashReturnCents + x.unsortedCents,
  x.movedCents + x.checkingCents + x.debtPaidCents + x.toInvestmentsCents + x.boughtCents + x.inTransitCents + x.unexplainedCents
]
/** The bridge's terms added up. */
const terms = (b: NetWorthBridge): number => b.savedCents + b.growthCents + b.revaluationCents + b.venturesCents + b.unsortedCents - b.inTransitCents - b.unexplainedCents + b.otherCents
/** An Other item's cents, 0 when there's none. */
const other = (b: NetWorthBridge, kind: NetWorthBridge['other'][number]['kind'], accountId: string): number => b.other.filter((x) => x.kind === kind && x.accountId === accountId).reduce((s, x) => s + x.cents, 0)

/** Both identities tie to the cent: the cash identity's sides, its items against Unexplained, and the bridge's terms against the change in net worth. */
function assertTies(w: Pick<Waterfall, 'identity' | 'bridge' | 'leaks'>, what: string): void {
  const [left, right] = sides(w.identity)
  assert.equal(left, right, `${what}: the cash identity's sides`)
  assert.equal(w.identity.engineErrorCents, 0, `${what}: Unexplained against its items`)
  assert.equal(w.identity.itemizedCents, w.identity.unexplainedCents, `${what}: Unexplained's items`)
  assert.equal(terms(w.bridge), w.bridge.endCents - w.bridge.startCents, `${what}: the bridge's terms`)
  assert.equal(w.bridge.engineErrorCents, 0, `${what}: the bridge`)
  assert.deepEqual(w.leaks.filter((x) => x.kind === 'engine_error'), [], `${what}: engine errors`)
}

describe("section 2's tie-out", () => {
  let t: TieOut
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    t = tieOut()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("October's rows: Gross pay 5,600.00, Take-home 4,000.00, Committed 1,575.00, Everyday 880.00, One-offs 450.00, Kept 1,095.00 and Saved 1,845.00", () => {
    const w = month('2026-10')
    assert.deepEqual(
      (['gross', 'taxes', 'benefits', 'savedAtWork', 'takeHome', 'committed', 'elective', 'everyday', 'leftOver', 'oneOffs', 'saved'] as StageId[]).map((id) => actual(w, id)),
      [560_000, 90_000, 20_000, 50_000, 400_000, 157_500, 242_500, 88_000, 154_500, 45_000, 184_500]
    )
    assert.deepEqual(
      w.rows.find((r) => r.id === 'saved')!.parts.map((p) => [p.key, p.actualCents]),
      [
        ['kept', 109_500],
        ['atWork', 50_000],
        ['employer', 25_000]
      ]
    )
    // Growth: the brokerage's 500.00, the 401(k)'s 600.00 and the savings interest's 20.00.
    assert.equal(actual(w, 'growth'), 112_000)
  })

  test('both sides of the cash identity are 945.00', () => {
    const w = month('2026-10')
    assert.deepEqual(sides(w.identity), [94_500, 94_500])
    assert.deepEqual(w.identity, {
      keptCents: 109_500,
      venturesCents: -17_000,
      cashReturnCents: 2_000,
      unsortedCents: 0,
      movedCents: 2_000,
      checkingCents: 11_000,
      debtPaidCents: -2_500,
      toInvestmentsCents: 30_000,
      boughtCents: 0,
      inTransitCents: 50_000,
      unexplainedCents: 4_000,
      itemizedCents: 4_000,
      engineErrorCents: 0
    })
    // The month on its own reads the same.
    assert.deepEqual(cashIdentity('2026-10').identity, w.identity)
  })

  test('ΔNW is 3,355.00, and the bridge terms add to it to the cent', () => {
    const w = month('2026-10')
    assert.deepEqual(w.bridge, {
      startCents: 15_480_000,
      endCents: 15_815_500,
      savedCents: 184_500,
      growthCents: 112_000,
      revaluationCents: -20_000,
      venturesCents: 113_000,
      unsortedCents: 0,
      inTransitCents: 50_000,
      unexplainedCents: 4_000,
      otherCents: 0,
      other: [],
      engineErrorCents: 0,
      // Wren Rentals' position, its accounts at its migrated share of 100% (sub-phase 1j): 4,000.00 to 5,500.00 - 200.00.
      ventures: [{ bucketId: t.venture, startCents: 400_000, endCents: 530_000 }]
    })
    assert.equal(terms(w.bridge), 335_500)
    // The car loan's 355.00 of principal is what it went down by: its debtResidual is 355 - 355 = 0.
    assert.equal(other(w.bridge, 'debtResidual', t.carLoan), 0)
    assert.deepEqual(netWorthBridge('2026-10').bridge, w.bridge)
    assertTies(w, 'October')
  })

  test("the Checking gap is -40.00 and dailyBalances' err +40.00; the balance_gap item and Unexplained are both 40.00, so engine_error is 0", () => {
    assert.deepEqual(db.balanceGaps([ACCOUNTS.checking], '2026-10-01', '2026-10-31'), [{ accountId: ACCOUNTS.checking, month: '2026-10', fromDay: '2026-09-30', toDay: '2026-10-31', cents: -4_000 }])
    // Walking back from Oct 31: 3,110.00 less October's lines of 150.00 is 2,960.00, against 3,000.00 known on Sep 30.
    const lines = classifyLines('2026-10-01', '2026-10-31').filter((l) => l.accountId === ACCOUNTS.checking).reduce((s, l) => s + l.cents, 0)
    const [sep, oct] = ['2026-09-30', '2026-10-31'].map((d) => db.balancesOn([ACCOUNTS.checking], d).get(ACCOUNTS.checking)!)
    assert.deepEqual([sep, oct, lines, sep - (oct - lines)], [300_000, 311_000, 15_000, 4_000])
    const w = month('2026-10')
    assert.deepEqual(w.leaks, [{ kind: 'balance_gap', cents: 4_000, accountId: ACCOUNTS.checking, fromDay: '2026-09-30', toDay: '2026-10-31' }])
    assert.deepEqual([w.identity.unexplainedCents, w.identity.itemizedCents, w.identity.engineErrorCents], [4_000, 4_000, 0])
    // The gap is bent across the bracket's days: round(4,000 × 16 / 31) of it is still to come after Oct 15.
    const part = (from: string, to: string): number => db.balanceGaps([ACCOUNTS.checking], from, to).reduce((s, g) => s + g.cents, 0)
    assert.deepEqual([part('2026-10-01', '2026-10-15'), part('2026-10-16', '2026-10-31')], [-1_935, -2_065])
  })

  test('the tolerance is 20.00 on a Take-home run rate of 4,000.00, so October closes with status gap', () => {
    const w = month('2026-10')
    assert.equal(w.rows.find((r) => r.id === 'takeHome')!.runRateCents, 400_000)
    assert.equal(w.toleranceCents, 2_000)
    assert.equal(closingStatus(w), 'gap')
    // Unsorted is 0, so the focus dot goes to Unexplained.
    assert.equal(w.focus, 'unexplained')
    // Within the tolerance it would close.
    assert.equal(closingStatus({ ...w, toleranceCents: 4_000 }), 'closed')
  })

  test('In transit is 500.00, Debt paid down -25.00, Moved to investments 300.00, Ventures -170.00 and Ventures(NW) 1,130.00', () => {
    const w = month('2026-10')
    assert.deepEqual([w.identity.inTransitCents, w.identity.debtPaidCents, w.identity.toInvestmentsCents, w.identity.venturesCents, w.bridge.venturesCents], [50_000, -2_500, 30_000, -17_000, 113_000])
  })

  test('the 500.00 lands in November: there it is -500.00 in transit, and over October and November in transit not at all', () => {
    const nov = month('2026-11')
    assert.equal(nov.identity.inTransitCents, -50_000)
    assertTies(nov, 'November')
    const both = getWaterfall({ from: '2026-10', to: '2026-11' })
    assert.deepEqual([both.identity.inTransitCents, both.identity.unexplainedCents], [0, 4_000])
    // The bridge runs from Sep 30 to Nov 30, and the landed 500.00 is in net worth again.
    assert.deepEqual([both.bridge.startCents, both.bridge.endCents], [15_480_000, 15_865_500])
    assertTies(both, 'October and November')
  })

  test("a span of days ties too: from Oct 9 to Nov 7, Unexplained is the Checking gap's part in those days, round(4,000 × 23 / 31)", () => {
    const w = getWaterfall({ from: '2026-10-09', to: TODAY })
    assert.deepEqual([w.identity.unexplainedCents, w.identity.inTransitCents], [2_968, 0])
    assert.deepEqual(w.leaks, [{ kind: 'balance_gap', cents: 2_968, accountId: ACCOUNTS.checking, fromDay: '2026-09-30', toDay: '2026-10-31' }])
    assert.deepEqual([w.bridge.savedCents, w.bridge.growthCents], [actual(w, 'saved'), actual(w, 'growth')])
    assertTies(w, 'Oct 9 to Nov 7')
  })

  test("dropping one line from the classifier's output yields an engine_error item", () => {
    const lines = classifyLines('2026-10-01', '2026-10-31')
    assert.deepEqual(cashIdentity('2026-10', lines).leaks.map((x) => x.kind), ['balance_gap'])
    const groceries = lines.findIndex((l) => l.accountId === ACCOUNTS.visa && l.cents === -60_000)
    const { identity, leaks } = cashIdentity('2026-10', lines.filter((_, i) => i !== groceries))
    // Kept, and with it Unexplained, rise by the 600.00 lost; the balance gap still says 40.00.
    assert.deepEqual([identity.keptCents, identity.unexplainedCents, identity.itemizedCents, identity.engineErrorCents], [169_500, 64_000, 4_000, 60_000])
    assert.deepEqual(leaks.filter((x) => x.kind === 'engine_error'), [{ kind: 'engine_error', cents: 60_000, fromDay: '2026-10-01', toDay: '2026-10-31' }])
  })
})

describe('the tie-out with an account first valued in October', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a manual asset with no opening day, first valued at 2,000.00 on Oct 15, is added: Other 2,000.00, Revaluation as it was, and the bridge ties', () => {
    tieOut()
    const watch = manual('Watch', 'other_asset', { points: [['2026-10-15', 200_000]] })
    const w = month('2026-10')
    assert.equal(other(w.bridge, 'added', watch), 200_000)
    assert.deepEqual([w.bridge.endCents - w.bridge.startCents, w.bridge.revaluationCents, w.bridge.otherCents], [535_500, -20_000, 200_000])
    assertTies(w, 'October')
  })
})

describe('the tie-out with an imported account that has statements but no balance of its own', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("its statements are its known balances, not a balance of 0 on the day it was added: no gap in any month, and October's Left in checking is 110.00 + 150.00", () => {
    tieOut()
    // Imported on Oct 15 from a file with no balance, as a CSV import adds an account; its statements close on the
    // 20th and Review records them. Each month it pays 100.00 and takes in 300.00, so every statement matches.
    db.upsertAccount({ id: 'csv:chk2', source: 'csv', name: 'Second Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:chk2', { assetType: 'cash' })
    db.run('UPDATE accounts SET created_at = ? WHERE id = ?', noonOn(2026, 10, 15), 'csv:chk2')
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      line('csv:chk2', `${m}-05`, -10_000, 'CORNER BISTRO', 'Dining Out', 'Corner Bistro')
      line('csv:chk2', `${m}-12`, 30_000, 'SIDE GIG', 'Other Income', 'Side Gig')
    }
    line('csv:chk2', '2026-10-25', -5_000, 'CORNER BISTRO', 'Dining Out', 'Corner Bistro')
    line('csv:chk2', '2026-11-03', -5_000, 'CORNER BISTRO', 'Dining Out', 'Corner Bistro')
    const statements = [['2026-07-20', 1_000], ['2026-08-20', 1_200], ['2026-09-20', 1_400], ['2026-10-20', 1_600]].map(([date, balance]) => ({ date, balance }))
    runTool('record_balances', { account_id: 'csv:chk2', balances: statements }, 'assistant')

    const on = (day: string): number => db.balancesOn(['csv:chk2'], day).get('csv:chk2')!
    assert.deepEqual(['2026-09-30', '2026-10-15', '2026-10-31', '2026-11-07'].map(on), [140_000, 160_000, 155_000, 150_000])
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11']) {
      const w = month(m)
      assert.deepEqual(w.leaks.filter((x) => x.accountId === 'csv:chk2'), [], m)
      assert.equal(w.identity.unexplainedCents, m === '2026-10' ? 4_000 : 0, m)
      assertTies(w, m)
    }
    assert.equal(month('2026-10').identity.checkingCents, 26_000)
  })
})

describe("1c's purchases, sales and borrowing", () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test('the cash car purchase, paid from Savings: Bought assets 30,000.00, Moved to savings -30,000.00, Revaluation 0, and the bridge ties', () => {
    txn('csv:chk', '2025-11-07', 300_000, 'NORTHWIND PAYROLL', { cat: 'Paycheck', merchant: 'Northwind Payroll' })
    manual('2022 Outback', 'vehicle', { opened: '2025-11-05', cost: 3_000_000, points: [['2025-11-05', 3_000_000]] })
    txn('csv:sav', '2025-11-03', -3_000_000, 'CASHIERS CHECK 4471', { cat: 'Transfers' })
    const w = month('2025-11')
    assert.deepEqual([w.identity.boughtCents, w.identity.movedCents, w.bridge.revaluationCents], [3_000_000, -3_000_000, 0])
    assertTies(w, 'November')
  })

  test('the car bought with a 25,000.00 loan deposited to checking: Revaluation 0, debtResidual 0, and the bridge ties', () => {
    const car = manual('2022 Outback', 'vehicle', { opened: '2025-11-05', cost: 3_000_000, points: [['2025-11-05', 3_000_000]] })
    const loan = manual('Maple Auto Finance', 'loan', { opened: '2025-11-03', linked: car, points: [['2025-11-03', 2_500_000]] })
    txn('csv:chk', '2025-11-03', 2_500_000, 'MAPLE AUTO LOAN PROCEEDS', { cat: 'Transfers' })
    txn('csv:chk', '2025-11-04', -3_000_000, 'CHECK 1042', { cat: 'Transfers' })
    const w = month('2025-11')
    assert.deepEqual([w.identity.boughtCents, w.identity.debtPaidCents, w.identity.checkingCents], [3_000_000, -2_500_000, -500_000])
    assert.deepEqual([w.bridge.revaluationCents, other(w.bridge, 'debtResidual', loan)], [0, 0])
    assertTies(w, 'November')
  })

  test('the car bought with the 25,000.00 loan paid to the dealer: 25,000.00 financed, Revaluation 0, debtResidual 0, and the bridge ties', () => {
    const car = manual('2022 Outback', 'vehicle', { opened: '2025-11-05', cost: 3_000_000, points: [['2025-11-05', 3_000_000]] })
    const loan = manual('Maple Auto Finance', 'loan', { opened: '2025-11-05', linked: car, points: [['2025-11-05', 2_500_000]] })
    txn('csv:chk', '2025-11-04', -500_000, 'OUTBACK DEALER DEPOSIT', { cat: 'Transfers' })
    const w = month('2025-11')
    // Revaluation is 30,000 - 5,000 - 25,000, and debtResidual -25,000 - 0 + 25,000.
    assert.deepEqual([w.identity.boughtCents, w.bridge.revaluationCents, other(w.bridge, 'debtResidual', loan)], [500_000, 0, 0])
    assertTies(w, 'November')
  })

  test('sold on Dec 10 with 4,000.00 owed and paid off at closing: Revaluation 0, debtResidual 0, and the bridge ties; paid off from checking instead, the same', () => {
    const car = manual('2017 Civic', 'vehicle', { opened: '2023-01-01', closed: '2025-12-10', cost: 2_000_000, points: [['2023-01-01', 2_000_000], ['2025-11-01', 1_200_000], ['2025-12-10', 1_200_000]] })
    const loan = manual('Civic Auto Loan', 'loan', { opened: '2023-01-01', closed: '2025-12-10', linked: car, points: [['2023-01-01', 1_000_000], ['2025-11-01', 400_000]] })
    const proceeds = txn('csv:chk', '2025-12-12', 800_000, 'CARMAX AUTO PURCHASE', { cat: 'Other Income' })
    let w = month('2025-12')
    // Revaluation is -12,000 + 8,000 + 4,000, and debtResidual 4,000 - 0 - 4,000.
    assert.deepEqual([w.identity.boughtCents, w.bridge.revaluationCents, other(w.bridge, 'debtResidual', loan)], [-800_000, 0, 0])
    assertTies(w, 'December')

    db.deleteTransaction(proceeds)
    txn('csv:chk', '2025-12-12', 1_200_000, 'CARMAX AUTO PURCHASE', { cat: 'Other Income' })
    link(loan, txn('csv:chk', '2025-12-13', -400_000, 'CIVIC AUTO LOAN PAYOFF', { cat: 'Transfers', merchant: 'Civic Auto Loan' }))
    w = month('2025-12')
    assert.deepEqual([w.identity.boughtCents, w.identity.debtPaidCents, w.bridge.revaluationCents, other(w.bridge, 'debtResidual', loan)], [-1_200_000, 400_000, 0, 0])
    assertTies(w, 'December')
  })

  test('the card consolidation: a 6,000.00 loan paid straight to the Visa is Debt paid down 0 and debtResidual 0', () => {
    db.upsertAccount({ id: 'csv:visa', source: 'csv', name: 'Visa', institution: null, currency: 'USD', balanceCents: 0, availableCents: null, balanceDate: db.now() })
    txn('csv:visa', '2025-10-10', -600_000, 'HARBOR HOME FURNISHINGS', { cat: 'Shopping' })
    const loan = manual('Lightstream Loan', 'loan', { opened: '2025-11-02', points: [['2025-11-02', 600_000]] })
    txn('csv:visa', '2025-11-03', 600_000, 'PAYMENT FROM LIGHTSTREAM', { cat: 'Transfers' })
    const w = month('2025-11')
    assert.deepEqual([w.identity.debtPaidCents, other(w.bridge, 'debtResidual', loan)], [0, 0])
    assertTies(w, 'November')
  })
})

describe('the sample household', () => {
  let first = ''
  let current = ''
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
    first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    current = db.today().slice(0, 7)
  })
  after(db.closeDb)

  test('every month ties both identities to the cent, and so do the 12M and All spans and the 30D and YTD spans of days', () => {
    for (let m = first; m <= current; m = shiftMonth(m, 1)) {
      const w = month(m)
      assertTies(w, m)
      // Kept is the Saved row's.
      assert.equal(w.identity.keptCents, w.rows.find((r) => r.id === 'saved')!.parts.find((p) => p.key === 'kept')!.actualCents, m)
      assert.equal(w.bridge.savedCents, actual(w, 'saved'), m)
      assert.equal(w.bridge.growthCents, actual(w, 'growth'), m)
    }
    assertTies(getWaterfall({ from: shiftMonth(current, -11), to: current }), '12M')
    assertTies(getWaterfall({ from: first, to: current }), 'All')
    const today = db.today()
    assertTies(getWaterfall({ from: addDays(today, -29), to: today }), '30D')
    assertTies(getWaterfall({ from: `${today.slice(0, 4)}-01-01`, to: today }), 'YTD by days')
  })

  test("the bridge's net worth is the Net worth page's on each month's last day", () => {
    const series = new Map(getNetWorthSeries().points.map((p) => [p.day, p.cents]))
    for (let m = first; m < current; m = shiftMonth(m, 1)) assert.equal(month(m).bridge.endCents, series.get(lastDay(m)), m)
  })
})
