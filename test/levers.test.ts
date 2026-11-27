import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { archiveGoal, saveGoal } from '../src/main/goals.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { linesFor } from '../src/main/lines.ts'
import { savePaystub } from '../src/main/paystubs.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { getWaterfall, RETIRE_KEYS, retirementSettings } from '../src/main/waterfall.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { Lever, LeverKind, StageId, StageRow, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { CHECKING, deposit, KEY as ACME, household as payHousehold, matchHousehold } from './fixtures/paystubs.ts'
import { ACCOUNTS, household, line, TODAY } from './fixtures/waterfall-household.ts'

// Levers and the retirement line (spec 1.7 and 1.8, sub-phase 1f): the money each row could gain a month, as data on
// the waterfall, and what is invested grown to retirement at the user's own return. Section 5's household is the
// fixture, with the 1d match household for the match and a savings account of its own for cash above the goals.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const row = (w: Waterfall, id: StageId): StageRow => {
  const r = w.rows.find((x) => x.id === id)
  assert.ok(r, `no ${id} row`)
  return r
}
/** A lever as Home's line reads it: its row, kind, name, a month's cents, its rate and its rate points. */
const shown = (l: Lever): [StageId, LeverKind, string, number, number | null, number | null] => [l.stage, l.kind, l.name, l.monthlyCents, l.aprBp, l.ratePts]
/** A lever's lines: how many, and their cents. */
const drilled = (l: Lever): { total: number; cents: number } => {
  const page = linesFor(l.drill!, { limit: 1000 })
  return { total: page.total, cents: page.cents }
}
const undoChange = (changeId: number | undefined): void => {
  const c = db.getChange(changeId!)!
  undo(c.tool, c.before, c.after, c.input)
}
const retirementIssues = (): string[] => openIssues().filter((i) => i.kind === 'retirement_unset').map((i) => i.key)

/** The order the levers come in: interest first, the highest rate first and one with no rate after them; then the rest, the largest first. */
function assertOrder(levers: Lever[]): void {
  const interest = (l: Lever): boolean => l.kind === 'card_interest' || l.kind === 'loan_interest'
  for (let i = 1; i < levers.length; i++) {
    const [a, b] = [levers[i - 1], levers[i]]
    assert.ok(interest(a) || !interest(b), `${b.name} is interest after ${a.name}`)
    if (interest(a) && interest(b)) assert.ok(a.aprBp === null ? b.aprBp === null && a.monthlyCents >= b.monthlyCents : b.aprBp === null || a.aprBp >= b.aprBp, `${a.name} before ${b.name}`)
    else if (!interest(a) && !interest(b)) assert.ok(a.monthlyCents >= b.monthlyCents, `${a.name} before ${b.name}`)
  }
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

  test("every lever with section 5's figures: W-4, card and loan interest, the utility and Netflix, dining out and coffee, and the 401(k) and HSA room", () => {
    const w = month('2026-10')
    assert.deepEqual(w.levers.map(shown), [
      // Elective's points are each amount over Take-home's 3,777.00.
      ['elective', 'card_interest', 'Visa', 6_000, 2_400, 1.6],
      ['elective', 'loan_interest', 'Civic Auto Loan', 4_800, 640, 1.3],
      ['elective', 'loan_interest', 'Student Loan', 8_600, 430, 2.3],
      // Pinecrest's 1,180.00 a month in force is 800.00 of interest and 380.00 of escrow.
      ['elective', 'loan_interest', 'Pinecrest Mortgage', 80_000, 375, 21.2],
      // round(2,450,000 / 12) - 48,000, the employee's 240.00 twice a month; round(440,000 / 12) - 16,800, the
      // employee's 60.00 and the employer's 24.00 twice a month, as the HSA limit counts both.
      ['invested', 'tax_room', '401(k)', 156_167, null, null],
      ['invested', 'tax_room', 'HSA', 19_867, null, null],
      // The 2025 refund of 1,020.00 over 12, over Gross pay's 6,000.00.
      ['takeHome', 'w4', 'W-4', 8_500, null, 1.4],
      // Over Elective's 1,570.50: 478.00 against 400.00, and 132.00 against 100.00.
      ['leftOver', 'over_target', 'Dining Out', 7_800, null, 5],
      ['leftOver', 'over_target', 'Coffee', 3_200, null, 2],
      // 290.00 in force against 270.00 a year before, and Netflix's 17.99 against 15.49.
      ['elective', 'utilities_change', 'Harbor Power', 2_000, null, 0.5],
      ['elective', 'price_change', 'Netflix', 250, null, 0.1]
    ])
    assertOrder(w.levers)
    assert.ok(w.levers.every((l) => !l.estimated))
    // The open month's levers are the last full month's, as its run rates are.
    assert.deepEqual(month('2026-11').levers, w.levers)
  })

  test("Home's Elective line is Visa (24.0%) then Civic (6.4%), the two highest rates", () => {
    const top = month('2026-10').levers.filter((l) => l.stage === 'elective').slice(0, 2)
    assert.deepEqual(
      top.map((l) => [l.name, l.aprBp! / 100]),
      [
        ['Visa', 24],
        ['Civic Auto Loan', 6.4]
      ]
    )
  })

  test("each lever's drill finds its lines: the Visa's October interest, the loans' payments in the window, Netflix over the year, Dining Out over the window", () => {
    const w = month('2026-10')
    const lever = (name: string): Lever => w.levers.find((l) => l.name === name)!
    assert.deepEqual(drilled(lever('Visa')), { total: 1, cents: -5_840 })
    // August to October's payments: their interest with escrow.
    assert.deepEqual(drilled(lever('Pinecrest Mortgage')), { total: 3, cents: -3 * 118_000 })
    assert.deepEqual(drilled(lever('Civic Auto Loan')), { total: 3, cents: -3 * 4_800 })
    // October 2025 to October 2026: twelve at 15.49 and one at 17.99.
    assert.deepEqual(drilled(lever('Netflix')), { total: 13, cents: -(12 * 1_549 + 1_799) })
    assert.equal(drilled(lever('Dining Out')).cents, -(41_360 + 50_000 + 52_040))
    assert.equal(lever('W-4').drill, null)
  })

  test('a card on an intro rate has no card_interest lever, while its interest at that rate stays in Committed', () => {
    db.updateAccount(ACCOUNTS.visa, { promoApr: 9.99, promoEnds: '2027-03-01' })
    try {
      const w = month('2026-10')
      assert.ok(!w.levers.some((l) => l.kind === 'card_interest'))
      // 3,000.00 at 9.99% over 12.
      assert.equal(row(w, 'committed').parts.find((p) => p.key === `card:${ACCOUNTS.visa}`)!.runRateCents, 2_498)
    } finally {
      db.updateAccount(ACCOUNTS.visa, { promoApr: null, promoEnds: null })
    }
  })

  test('the retirement line: 1,853,238.60 in 2055; with a real return of 0, 639,495.00', () => {
    // n = 65 - (2026 - 1990) = 29. B = 240,000 + 500 + 600 + 288 + 2,083 = 243,471.00 on Oct 31; A = 12 × 1,138.00.
    // B × 1.05^29 = 1,002,159.65 and A × (1.05^29 - 1) / 0.05 = 851,078.95.
    assert.deepEqual(month('2026-10').retirement, {
      birthYear: 1990,
      retireAge: 65,
      realReturnBp: 500,
      years: 29,
      year: 2055,
      investedCents: 24_347_100,
      contributionCents: 113_800,
      projectedCents: 185_323_860
    })
    // The open month's is the last full month's, as its run rates are.
    assert.deepEqual(month('2026-11').retirement, month('2026-10').retirement)
    const r = runTool('set_retirement', { real_return_pct: 0 }, 'assistant')
    try {
      // B + A × n = 243,471 + 13,656 × 29.
      assert.equal(month('2026-10').retirement!.projectedCents, 63_949_500)
    } finally {
      undoChange(r.changeId)
    }
    assert.equal(retirementSettings().realReturnBp, 500)
    assert.equal(month('2026-10').retirement!.projectedCents, 185_323_860)
  })

  test('with the retirement settings but no inflation, there is no cash_above_goals lever and no retirement_unset issue', () => {
    assert.equal(retirementSettings().inflationBp, null)
    assert.ok(!month('2026-10').levers.some((l) => l.kind === 'cash_above_goals'))
    assert.deepEqual(retirementIssues(), [])
  })
})

describe('no retirement settings', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    for (const key of Object.values(RETIRE_KEYS)) db.setSetting(key, null)
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('retirement is null, cash_above_goals is absent, and one retirement_unset issue is raised', () => {
    const w = month('2026-10')
    assert.equal(w.retirement, null)
    assert.ok(!w.levers.some((l) => l.kind === 'cash_above_goals'))
    assert.deepEqual(retirementIssues(), ['retirement_unset'])
    assert.match(openIssues().find((i) => i.kind === 'retirement_unset')!.summary, /\$243,471\.00 is invested.*birth year, retirement age and real return.*set_retirement/)
  })

  test('set_retirement with all four settles the issue and draws the line and the savings lever; undo puts every setting back', () => {
    const r = runTool('set_retirement', { birth_year: 1990, retire_age: 65, real_return_pct: 5, inflation_pct: 3 }, 'assistant')
    assert.equal(r.action, 'Retirement: born 1990, retiring at 65, real return 5.00%, inflation 3.00%')
    assert.deepEqual(retirementSettings(), { birthYear: 1990, age: 65, realReturnBp: 500, inflationBp: 300 })
    assert.deepEqual(retirementIssues(), [])
    const w = month('2026-10')
    assert.equal(w.retirement!.projectedCents, 185_323_860)
    // The savings account's 20,000.00 has no goal, and earns less than the 8.00% the settings make nominal.
    assert.ok(w.levers.some((l) => l.kind === 'cash_above_goals' && l.name === 'Savings' && l.ratePts === null))
    undoChange(r.changeId)
    assert.deepEqual(retirementSettings(), { birthYear: null, age: null, realReturnBp: null, inflationBp: null })
    assert.deepEqual(Object.values(RETIRE_KEYS).map((k) => db.getSetting(k)), [null, null, null, null])
    assert.deepEqual(retirementIssues(), ['retirement_unset'])
  })

  test("set_retirement checks each figure before writing any, and null clears one", () => {
    assert.throws(() => runTool('set_retirement', {}, 'assistant'), /birth_year, retire_age, real_return_pct or inflation_pct/)
    assert.throws(() => runTool('set_retirement', { birth_year: 1990, retire_age: 300 }, 'assistant'), /retirement age/)
    assert.throws(() => runTool('set_retirement', { real_return_pct: 'five' }, 'assistant'), /real_return_pct/)
    assert.throws(() => runTool('set_retirement', { birth_year: 1990.5 }, 'assistant'), /birth year/)
    assert.deepEqual(retirementSettings(), { birthYear: null, age: null, realReturnBp: null, inflationBp: null })
    runTool('set_retirement', { birth_year: 1990, retire_age: 65, real_return_pct: 4.25 }, 'assistant')
    assert.equal(retirementSettings().realReturnBp, 425)
    runTool('set_retirement', { real_return_pct: null }, 'assistant')
    assert.deepEqual(retirementSettings(), { birthYear: 1990, age: 65, realReturnBp: null, inflationBp: null })
    assert.equal(month('2026-10').retirement, null)
  })

  test('no issue with nothing invested', () => {
    for (const id of [ACCOUNTS.brokerage, ACCOUNTS.retirement, ACCOUNTS.hsa]) db.updateAccount(id, { hidden: true })
    assert.deepEqual(retirementIssues(), [])
  })
})

describe('the 1d match household', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    matchHousehold()
    runTool('set_contribution', { name: 'Acme 401(k)', kind: '401k', match_rate_pct: 50, match_cap_pct: 6 }, 'assistant')
    // Spending of 3,821.00 a month from August, so Saved runs at 1,000.00: Take-home 4,461.00 less it, plus the
    // 240.00 saved at work and the employer's 120.00.
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      line(CHECKING, `${m}-03`, -200_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
      line(CHECKING, `${m}-17`, -182_100, 'HILLTOP GROCER', 'Groceries', 'Hilltop Grocer')
    }
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('match_left is 60.00 a month, and with Saved at 1,000.00 and employer saving 120.00 it moves Saved +0.8 points', () => {
    const w = month('2026-10')
    const saved = row(w, 'saved')
    assert.deepEqual([saved.runRateCents, saved.parts.find((p) => p.key === 'employer')!.runRateCents, row(w, 'gross').runRateCents], [100_000, 12_000, 600_000])
    // (1,000 + 60) / (6,120 + 60) - 1,000 / 6,120 = 0.812 points.
    assert.deepEqual(w.levers.filter((l) => l.kind === 'match_left').map(shown), [['saved', 'match_left', 'Acme 401(k)', 6_000, null, 0.8]])
    // Every check but the last is estimated from the Oct 31 stub; the last is its own.
    assert.equal(w.levers.find((l) => l.kind === 'match_left')!.estimated, false)
    assert.deepEqual(drilled(w.levers.find((l) => l.kind === 'match_left')!), { total: 6, cents: 6 * 223_050 })
    // Its 401(k) takes 120.00 a check, 240.00 a month, of the 2,041.67 a month the limit allows; it has no HSA.
    assert.deepEqual(w.levers.filter((l) => l.kind === 'tax_room').map(shown), [['invested', 'tax_room', '401(k)', 204_167 - 24_000, null, null]])
    assertOrder(w.levers)
  })
})

describe('a match plan out of force', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    matchHousehold()
    runTool('set_contribution', { name: 'Acme 401(k)', kind: '401k', match_rate_pct: 50, match_cap_pct: 6 }, 'assistant')
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  const left = (): Array<[string, number]> => month('2026-10').levers.filter((l) => l.kind === 'match_left').map((l) => [l.name, l.monthlyCents])

  test("a plan replaced on the same payroll takes no match left: only the plan in force at the window's end has an election", () => {
    const old = db.listContributionRows().find((p) => p.name === 'Acme 401(k)')!.id
    db.saveContribution({ id: old, name: 'Acme 401(k)', kind: '401k', endsDay: '2026-06-30' })
    assert.deepEqual(left(), [])
    // The plan that replaced it, from July, elects the 6% the match is capped at, so nothing is left.
    const next = db.saveContribution({ name: 'Acme 401(k) Plan B', kind: '401k', paycheckKey: ACME, percent: 6, employeeCents: 18_000, startsDay: '2026-07-01', matchRateBp: 5_000, matchCapBp: 600 })
    assert.deepEqual(left(), [])
    // Starting after the window, it has nothing left either; at 4% from July, 30.00 a check is left, 60.00 a month.
    db.saveContribution({ id: next, name: 'Acme 401(k) Plan B', kind: '401k', startsDay: '2026-12-01' })
    assert.deepEqual(left(), [])
    db.saveContribution({ id: next, name: 'Acme 401(k) Plan B', kind: '401k', percent: 4, employeeCents: 12_000, startsDay: '2026-07-01' })
    assert.deepEqual(left(), [['Acme 401(k) Plan B', 6_000]])
  })
})

describe('cash above the goals', () => {
  const SAVINGS = 'csv:sav'
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    payHousehold()
    db.upsertAccount({ id: SAVINGS, source: 'csv', name: 'Savings', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(SAVINGS, { assetType: 'cash' })
    // 20,000.00 held all year, earning 66.67 a month swept to checking the day it's paid: 800.04 on 20,000.00 is a
    // yield of 4.00%.
    db.setBalancePoint(SAVINGS, '2025-10-31', 2_000_000)
    for (let m = '2025-11'; m <= '2026-10'; m = shiftMonth(m, 1)) {
      line(SAVINGS, lastDay(m), 6_667, 'INTEREST PAID', 'Other Income', 'Harbor Bank Interest')
      line(SAVINGS, lastDay(m), -6_667, 'TRANSFER TO CHECKING', 'Transfers', 'Transfer to Checking')
      line(CHECKING, lastDay(m), 6_667, 'TRANSFER FROM SAVINGS', 'Transfers', 'Transfer from Savings')
      db.setBalancePoint(SAVINGS, lastDay(m), 2_000_000)
    }
    saveGoal({ name: 'Emergency fund', targetCents: 1_000_000, funding: 'accounts', accountIds: [SAVINGS] })
    db.setSetting(RETIRE_KEYS.realReturnBp, '500')
    db.setSetting(RETIRE_KEYS.inflationBp, '300')
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('10,000.00 above the goals, a real return of 5.00%, inflation of 3.00% and a cash yield of 4.00% give 10,000 × 0.04 / 12 = 33.33 a month', () => {
    const w = month('2026-10')
    assert.deepEqual(w.levers.map(shown), [['invested', 'cash_above_goals', 'Savings', 3_333, null, null]])
    // Its drill is the interest that set the yield.
    assert.deepEqual(drilled(w.levers[0]), { total: 12, cents: 12 * 6_667 })
    // Without the birth year and the age, there is no retirement line.
    assert.equal(w.retirement, null)
  })

  test('with the goal archived, all 20,000.00 is above the goals: 66.67 a month', () => {
    const goal = db.get<{ id: number }>("SELECT id FROM goals WHERE name = 'Emergency fund'")!.id
    archiveGoal(goal, true)
    try {
      assert.equal(month('2026-10').levers.find((l) => l.kind === 'cash_above_goals')!.monthlyCents, 6_667)
    } finally {
      archiveGoal(goal, false)
    }
  })

  test('with no inflation set, the lever is absent', () => {
    db.setSetting(RETIRE_KEYS.inflationBp, null)
    try {
      assert.deepEqual(month('2026-10').levers, [])
    } finally {
      db.setSetting(RETIRE_KEYS.inflationBp, '300')
    }
  })

  test("with a second savings account, the lever counts both, and its drill is both accounts' interest and not checking's", () => {
    const MARKET = 'csv:mm'
    db.upsertAccount({ id: MARKET, source: 'csv', name: 'Money Market', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(MARKET, { assetType: 'cash' })
    // 10,000.00 held all year at 33.33 a month, swept to checking, and checking paid 1.00 a month of its own.
    db.setBalancePoint(MARKET, '2025-10-31', 1_000_000)
    for (let m = '2025-11'; m <= '2026-10'; m = shiftMonth(m, 1)) {
      line(MARKET, lastDay(m), 3_333, 'INTEREST PAID', 'Other Income', 'Harbor Bank Interest')
      line(MARKET, lastDay(m), -3_333, 'TRANSFER TO CHECKING', 'Transfers', 'Transfer to Checking')
      line(CHECKING, lastDay(m), 3_333, 'TRANSFER FROM MONEY MARKET', 'Transfers', 'Transfer from Money Market')
      line(CHECKING, lastDay(m), 100, 'INTEREST PAID', 'Other Income', 'Harbor Bank Interest')
      db.setBalancePoint(MARKET, lastDay(m), 1_000_000)
    }
    // 30,000.00 less the goal's 10,000.00, at 5.00% + 3.00% less 1,200.00 of interest a year on 30,000.00 (4.00%):
    // 20,000 × 0.04 / 12 = 66.67 a month.
    const lever = month('2026-10').levers.find((l) => l.kind === 'cash_above_goals')!
    assert.deepEqual(shown(lever), ['invested', 'cash_above_goals', 'Savings', 6_667, null, null])
    assert.deepEqual(drilled(lever), { total: 24, cents: 12 * (6_667 + 3_333) })
  })
})

describe('a 401(k) plan out of force', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    payHousehold()
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  const room = (): Array<[string, number]> => month('2026-10').levers.filter((l) => l.kind === 'tax_room').map((l) => [l.name, l.monthlyCents])

  test('a plan that ended before the window, or starts after it, has no room; one in force has the whole limit over 12', () => {
    const id = db.saveContribution({ name: 'Old Job 401(k)', kind: '401k', paycheckKey: null, employeeCents: 0, endsDay: '2026-06-30' })
    assert.deepEqual(room(), [])
    db.saveContribution({ id, name: 'Old Job 401(k)', kind: '401k', endsDay: null, startsDay: '2026-12-01' })
    assert.deepEqual(room(), [])
    db.saveContribution({ id, name: 'Old Job 401(k)', kind: '401k', startsDay: null })
    // round(2,450,000 / 12), with nothing going in.
    assert.deepEqual(room(), [['401(k)', 204_167]])
  })
})

describe('a 401(k) the year has filled', () => {
  /** Checks of 10,000.00 on the 15th and the month's last day from January, with 401(k) deferrals of 4,000.00 each until `upTo` is reached. */
  const highSaver = (upTo: number): void => {
    payHousehold()
    db.saveContribution({ name: 'Acme 401(k)', kind: '401k', paycheckKey: ACME, employeeCents: 400_000 })
    let ytd = 0
    for (let m = '2026-01'; m <= '2026-10'; m = shiftMonth(m, 1)) {
      for (const day of [`${m}-15`, lastDay(m)]) {
        const k = Math.min(400_000, upTo - ytd)
        ytd += k
        deposit(day, 1_000_000 - 200_000 - k)
        savePaystub({ paycheckKey: ACME, payDay: day, grossCents: 1_000_000, items: [{ kind: 'federal', cents: 200_000 }, ...(k ? [{ kind: '401k' as const, name: 'Acme 401(k)', cents: k }] : [])] })
      }
    }
  }
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  const room = (): Array<[string, number]> => month('2026-10').levers.filter((l) => l.kind === 'tax_room').map((l) => [l.name, l.monthlyCents])

  test('with the 24,500.00 limit filled by April, nothing goes in from August to October, and there is no room left', () => {
    highSaver(2_450_000)
    assert.deepEqual(room(), [])
  })

  test("with 24,000.00 in by March, what's left of the limit over November and December is the room: 250.00 a month", () => {
    highSaver(2_400_000)
    // round(2,450,000 / 12) less nothing going in would be 2,041.67; 500.00 is left for the two months after October.
    assert.deepEqual(room(), [['401(k)', 25_000]])
  })
})

describe('the sample household', () => {
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
  })
  after(db.closeDb)

  test('every month has its levers in order, each with the fields Home reads, and no lever needs a field the engine lacks', () => {
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    const current = db.today().slice(0, 7)
    const kinds = new Set<LeverKind>()
    for (let m = first; m <= current; m = shiftMonth(m, 1)) {
      const w = month(m)
      assertOrder(w.levers)
      for (const l of w.levers) {
        kinds.add(l.kind)
        assert.ok(Number.isInteger(l.monthlyCents) && l.monthlyCents > 0, `${m} ${l.kind} ${l.name}`)
        assert.ok(w.rows.some((r) => r.id === l.stage) || (l.stage === 'takeHome' && !w.rows.some((r) => r.id === 'gross')), `${m} ${l.kind} on ${l.stage}`)
        assert.equal(l.ratePts === null, l.stage === 'invested' || row(w, l.stage).rate === null, `${m} ${l.kind} ${l.name}'s points`)
        if (l.drill) assert.ok(linesFor(l.drill).total > 0, `${m} ${l.kind} ${l.name}'s drill`)
      }
    }
    // The sample household's own: its two loans' interest, its 401(k) and HSA room, its utilities and Streamly's price.
    // Its Visa is never charged interest and its Mastercard is on an intro 0%, so neither card is a lever; the rest
    // come from section 5's household and the fixtures above.
    assert.deepEqual([...kinds].sort(), ['loan_interest', 'price_change', 'tax_room', 'utilities_change'])
  })

  test("Review's open items name every kind the sample household raises, retirement_unset included", () => {
    // Review.tsx shows an open item by its kind's label, and by the kind itself when it has none.
    const page = readFileSync(fileURLToPath(new URL('../src/renderer/src/pages/Review.tsx', import.meta.url)), 'utf8')
    const block = /const ISSUE_LABEL[^{]*\{([^}]*)\}/.exec(page)![1]
    const labelled = new Set([...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]))
    const kinds = [...new Set(openIssues().map((i) => i.kind))]
    assert.ok(kinds.includes('retirement_unset'))
    assert.deepEqual(kinds.filter((k) => !labelled.has(k)), [])
  })
})
