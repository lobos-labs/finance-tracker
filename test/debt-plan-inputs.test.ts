import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiHost } from '../src/main/ai/host.ts'
import type { HandlerContext } from '../src/main/handlers/context.ts'
import type { DebtPlanInputs, DebtView, Waterfall } from '../src/shared/types.ts'
import { budgetRatio, paired, repeatedMs, within } from './cost.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS, household, TODAY } from './fixtures/waterfall-household.ts'

// The payoff plan on Net worth > Debts and its inputs in the debt.plan setting (waterfall spec sub-phase 2d, part
// 3): the one plan the app runs (shared/debtPlan.ts runDebtPlan, on getDebts and debt.plan), what goes to the debts a
// month, the order each strategy pays them in and when each is gone, figure for figure on section 5's household and
// the sample household; Saved's next debt as the plan's first target; Review's set_debt_plan and its undo; the inputs
// a viewer kept in its own storage arriving once; the headline's payoff and the Debts page agreeing; no plan with no
// debt; and what the Debts page's calls cost on a large ledger.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place. The renderer's .tsx load through
// the same transform the app's bundler uses (Vite's Rolldown), so the Debts page's plan renders here as it does there.
const viteRequire = createRequire(import.meta.resolve('vite'))
const { transformSync } = (await import(pathToFileURL(viteRequire.resolve('rolldown/utils')).href)) as typeof import('rolldown/utils')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL && existsSync(`${fileURLToPath(new URL(specifier, context.parentURL))}.tsx`)) return next(`${specifier}.tsx`, context)
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.endsWith('.tsx')) return next(url, context)
    const file = fileURLToPath(url)
    const { code, errors } = transformSync(file, readFileSync(file, 'utf8'), { lang: 'tsx', jsx: { runtime: 'automatic' } })
    if (errors.length) throw new Error(`${file}: ${errors.map((e) => e.message).join('; ')}`)
    return { format: 'module', source: code, shortCircuit: true }
  }
})
Object.assign(globalThis, { window: { api: {} }, location: new URL('file:///app/index.html') })

const db = await import('../src/main/db.ts')
const { getBalanceSheet } = await import('../src/main/netWorth.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { getWaterfall } = await import('../src/main/waterfall.ts')
const { homePlans } = await import('../src/main/homePlans.ts')
const { DEBT_PLAN_KEY, debtPlan, getDebts, nextDebt } = await import('../src/main/debts.ts')
const { setCategoryTarget, setOneOffBudget } = await import('../src/main/budget.ts')
const { buildDigest, getInsight } = await import('../src/main/insights.ts')
const { withAiHost } = await import('../src/main/ai/host.ts')
const { undo } = await import('../src/main/journal.ts')
const { runTool } = await import('../src/main/tools.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { answer } = await import('../src/main/handlers/table.ts')
const { likelyDebtFree, monthsBetween, rateFor, runDebtPlan } = await import('../src/shared/debtPlan.ts')
const { NOT_ADVICE } = await import('../src/shared/app.ts')
const { sendDebtPlan, KEPT } = await import('../src/renderer/src/plan.ts')
const { PayoffPlan, planChart } = await import('../src/renderer/src/pages/DebtPlan.tsx')
const { fmtMoneyRound } = await import('../src/renderer/src/lib.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')
type DataLine = import('../src/renderer/src/pages/homeView.ts').DataLine

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const source = (path: string): string => readFileSync(join(root, path), 'utf8')
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const events: string[] = []
const web = (): HandlerContext =>
  ({
    platform: 'web',
    plan: { plan: 'plus' },
    broadcast: (event: string) => void events.push(event),
    calendarChanged: () => {},
    settings: () => ({ licenseTokenSaved: false, apiKeySource: 'none', simplefinConnected: false, bank: { available: true, connections: [] }, lastSyncAt: null, syncsLast24h: 0, historyFrom: null, historyComplete: false, syncWarnings: [], dataPath: '', database: { encrypted: false, switchable: false, switchOn: false, recoveryPending: false, keySeal: 'install' } })
  }) as unknown as HandlerContext
const undoChange = (changeId: number | undefined): void => {
  const c = db.getChange(changeId!)!
  undo(c.tool, c.before, c.after, c.input)
}
const plan = (input: Record<string, unknown>): ReturnType<typeof runTool> => runTool('set_debt_plan', input, 'assistant')
/** Each planned debt by name, in the order the plan pays them off: its place, the month it's gone and its interest. */
function paidOff(v: DebtView): Array<[string, number | null, string | null, number]> {
  const run = runDebtPlan(v)
  const names = new Map(v.debts.map((d) => [d.id, d.name]))
  return run.result.debts.map((d) => [names.get(d.id)!, d.order, d.paidOff, d.interestCents] as [string, number | null, string | null, number]).sort((a, b) => (a[1] ?? 99) - (b[1] ?? 99))
}
const next = (): [string, number | null, string | null] | null => {
  const n = nextDebt()
  return n && [n.name, n.aprBp, n.promoEnds]
}
const digestOf = (): ReturnType<typeof buildDigest> => withAiHost({} as AiHost, () => buildDigest())
const page = (v: DebtView): string => renderToStaticMarkup(createElement(PayoffPlan, { view: v }))
const NONE: DebtPlanInputs = { strategy: 'avalanche', leftOut: [], takeHomeCents: null, setAsideCents: 0, lumpCents: 0 }

describe("the plan on section 5's household", () => {
  let h: ReturnType<typeof household>
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    h = household()
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('what goes to the debts a month is take-home less spending less the set-aside: 3,777.00 - 2,482.50 = 1,294.50, 1,113.10 short of the minimums', () => {
    const d = getDebts()
    assert.deepEqual([d.plan, d.strategy, d.month], [NONE, 'avalanche', '2026-11'])
    const run = runDebtPlan(d)
    assert.deepEqual([run.takeHomeCents, run.spendCents, run.monthlyCents], [377_700, 248_250, 129_450])
    // December's minimums: Pinecrest 1,605.00, the Civic 412.00, the student loan 300.00 and the Visa's usual 90.60
    // (1% of the 3,060.00 it owes after its 60.00 of interest, plus that interest), 2,407.60 in all.
    assert.equal(run.result.shortfallCents, 160_500 + 41_200 + 30_000 + 9_060 - 129_450)
    assert.equal(run.result.shortfallCents, 111_310)
    // Short of the minimums, the plan pays each its minimum and nothing more, so each goes when its minimum clears it.
    assert.deepEqual(paidOff(d), [
      ['Civic Auto Loan', 1, '2028-10', 54_664],
      ['Student Loan', 2, '2034-09', 424_623],
      ['Visa', 3, '2039-03', 436_956],
      ['Pinecrest Mortgage', 4, '2050-03', 15_017_537]
    ])
    assert.deepEqual([run.result.debtFree, run.result.interestCents], ['2050-03', 15_933_780])
    // 100.00 set aside a month: 1,194.50 goes to the debts.
    plan({ set_aside: 100 })
    assert.equal(runDebtPlan(getDebts()).monthlyCents, 377_700 - 248_250 - 10_000)
    // A take-home of 6,000.00 in place of the run rate: 6,000.00 - 2,482.50 - 100.00 = 3,417.50, the minimums met.
    plan({ take_home: 6000 })
    const more = runDebtPlan(getDebts())
    assert.deepEqual([more.monthlyCents, more.result.shortfallCents], [600_000 - 248_250 - 10_000, 0])
    // The set-aside never takes the month below nothing: 4,000.00 set aside leaves none for the debts.
    plan({ set_aside: 4000 })
    assert.equal(runDebtPlan(getDebts()).monthlyCents, 0)
  })

  test("a debt left out still takes its minimum from the same take-home: Pinecrest's 1,605.00 left out, the plan is 1,113.10 short as before", () => {
    plan({ left_out: [h.mortgage] })
    const run = runDebtPlan(getDebts())
    // 1,294.50 doesn't cover Pinecrest's 1,605.00 of principal and interest, so nothing is left for the other three,
    // and with their 802.60 of minimums the month is short by what it was with Pinecrest in the plan.
    assert.deepEqual([run.leftOutCents, run.monthlyCents, run.result.shortfallCents], [160_500, 0, 111_310])
    assert.deepEqual(
      run.debts.map((d) => d.name),
      ['Civic Auto Loan', 'Student Loan', 'Visa']
    )
    // A take-home of 6,000.00: 3,517.50 less Pinecrest's 1,605.00 is 1,912.50 a month for the other three.
    plan({ take_home: 6000 })
    const more = runDebtPlan(getDebts())
    assert.deepEqual([more.monthlyCents, more.result.shortfallCents, more.result.debtFree, more.result.interestCents], [191_250, 0, '2028-07', 147_583])
    // Review's answer names what the debt left out still takes.
    assert.deepEqual((runTool('debt_plan', {}, 'assistant').result as { left_out: unknown }).left_out, [{ account_id: h.mortgage, name: 'Pinecrest Mortgage', minimum: 1605 }])
    // The Civic left out is paid off by its 412.00 alone in October 2028, and from then the plan has its 412.00 too.
    plan({ left_out: [h.civicLoan] })
    const civic = runDebtPlan(getDebts())
    assert.equal(civic.monthlyCents, 600_000 - 248_250 - 41_200)
    const paid = (k: number): number => {
      const [was, now] = [civic.result.months[k - 1].balances, civic.result.months[k].balances]
      return civic.debts.reduce((s, d, i) => s + was[i] + Math.round((was[i] * rateFor(d, civic.result.months[k].month)) / 1200) - now[i], 0)
    }
    const at = (m: string): number => civic.result.months.findIndex((x) => x.month === m)
    assert.deepEqual([paid(at('2028-09')), paid(at('2028-11'))], [600_000 - 248_250 - 41_200, 600_000 - 248_250])
  })

  test("a loan's minimum on file is the payment its statement asks, escrow and all: Pinecrest's 1,985.00 is planned at 1,605.00", () => {
    // The 380.00 of escrow is the home's taxes and insurance, in the spending already; the loan is paid the rest.
    runTool('update_account', { account_id: h.mortgage, min_payment: 1985 }, 'assistant')
    const d = getDebts()
    assert.deepEqual([d.debts.find((x) => x.id === h.mortgage)!.minPaymentCents, d.spendCents], [160_500, 248_250])
    assert.equal(runDebtPlan(d).result.shortfallCents, 111_310)
    // A minimum no more than the escrow can't hold it, so it's read as principal and interest alone.
    runTool('update_account', { account_id: h.mortgage, min_payment: 300 }, 'assistant')
    assert.equal(getDebts().debts.find((x) => x.id === h.mortgage)!.minPaymentCents, 30_000)
    // A card has no escrow: its minimum on file stands.
    runTool('update_account', { account_id: ACCOUNTS.visa, min_payment: 40 }, 'assistant')
    assert.equal(getDebts().debts.find((x) => x.id === ACCOUNTS.visa)!.minPaymentCents, 4_000)
  })

  test('avalanche pays the highest rate first, an intro rate counting while it lasts; snowball the smallest balance first', () => {
    // A take-home of 6,000.00 leaves 3,517.50 a month for the debts, enough for extra past the minimums.
    plan({ take_home: 6000 })
    assert.equal(runDebtPlan(getDebts()).monthlyCents, 351_750)
    // Highest rate first: the Visa's 24.0%, then the Civic's 6.4%, the student loan's 4.3% and Pinecrest's 3.75%.
    assert.deepEqual(paidOff(getDebts()), [
      ['Visa', 1, '2027-02', 11_111],
      ['Civic Auto Loan', 2, '2027-07', 23_565],
      ['Student Loan', 3, '2028-07', 112_907],
      ['Pinecrest Mortgage', 4, '2036-05', 6_210_593]
    ])
    // At 0% to June 2027 the Visa waits behind the Civic, and comes first again at 24.0% once its intro rate ends.
    db.updateAccount(ACCOUNTS.visa, { promoApr: 0, promoEnds: '2027-06-01' })
    assert.deepEqual(paidOff(getDebts()), [
      ['Civic Auto Loan', 1, '2027-05', 15_296],
      ['Visa', 2, '2027-07', 8_047],
      ['Student Loan', 3, '2028-07', 111_905],
      ['Pinecrest Mortgage', 4, '2036-05', 6_206_386]
    ])
    // Smallest balance first: the Visa's 3,000.00, paid off before its intro rate ends, then the Civic's 8,636.00.
    plan({ strategy: 'snowball' })
    assert.deepEqual(paidOff(getDebts()), [
      ['Visa', 1, '2027-02', 0],
      ['Civic Auto Loan', 2, '2027-07', 23_264],
      ['Student Loan', 3, '2028-07', 112_407],
      ['Pinecrest Mortgage', 4, '2036-05', 6_206_523]
    ])
    assert.equal(getDebts().strategy, 'snowball')
  })

  test("Saved's next debt is the plan's first target, with a debt left out and with each strategy", () => {
    const saved = (): string => view.homeTable(month('2026-10'), 'saved', new Map(), { plans: homePlans() }).lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'debt')!.text
    assert.deepEqual(next(), ['Visa', 2_400, null])
    assert.equal(saved(), 'next Visa 24.0% · 3,000')
    db.updateAccount(ACCOUNTS.visa, { promoApr: 0, promoEnds: '2027-06-01' })
    assert.deepEqual(next(), ['Civic Auto Loan', 640, null])
    plan({ strategy: 'snowball' })
    assert.deepEqual(next(), ['Visa', 0, '2027-06-01'])
    assert.equal(saved(), 'next Visa 0.0% to Jun 2027 · 3,000')
    // The Civic left out: by rate the student loan's 4.3% comes next, by balance the Visa still.
    plan({ left_out: [h.civicLoan] })
    assert.deepEqual(next(), ['Visa', 0, '2027-06-01'])
    plan({ strategy: 'avalanche' })
    assert.deepEqual(next(), ['Student Loan', 430, null])
    assert.equal(saved(), 'next Student Loan 4.3% · 23,786')
    // The Visa left out: the Civic, by either order.
    plan({ left_out: [ACCOUNTS.visa] })
    assert.deepEqual(next(), ['Civic Auto Loan', 640, null])
    plan({ strategy: 'snowball' })
    assert.deepEqual(next(), ['Civic Auto Loan', 640, null])
    // Every debt left out: the plan pays none, and Saved names none.
    plan({ left_out: [ACCOUNTS.visa, h.civicLoan, h.studentLoan, h.mortgage] })
    assert.equal(next(), null)
    assert.equal(view.homeTable(month('2026-10'), 'saved', new Map(), { plans: homePlans() }).lines.find((l) => l.kind === 'data' && l.key === 'debt'), undefined)
    // The debt it names is the one the plan's run pays extra on first, and Home's plans carry it.
    plan({ left_out: [h.civicLoan], strategy: 'avalanche', take_home: 6000 })
    const d = getDebts()
    assert.deepEqual(
      paidOff(d).map((x) => x.slice(0, 3)),
      [
        ['Visa', 1, '2027-08'],
        ['Student Loan', 2, '2028-06'],
        ['Pinecrest Mortgage', 3, '2036-05']
      ]
    )
    assert.equal(homePlans().nextDebt?.name, 'Student Loan')
  })

  test('at the targets set: 2,372.50 of spending, with Dining Out at its 400.00 and Coffee at its 100.00; a one-off budget too', () => {
    // 2,482.50 less Dining Out's 478.00 over its 400.00 target and Coffee's 132.00 over its 100.00.
    assert.equal(getDebts().targetSpendCents, 248_250 - 7_800 - 3_200)
    plan({ take_home: 6000 })
    const d = getDebts()
    const at = runDebtPlan(d, d.targetSpendCents!)
    assert.deepEqual([at.monthlyCents, at.result.debtFree, runDebtPlan(d).result.debtFree], [600_000 - 237_250, '2036-01', '2036-05'])
    // The likely range: the plan at its spending less, and more, the twelve months' spread over the root of its months.
    assert.deepEqual(likelyDebtFree(d, runDebtPlan(d)), { early: '2036-04', late: '2036-07' })
    // A target above its run rate saves nothing and spends nothing more (spec 1.8's over_target, "when above"):
    // Groceries at 400.00 against its 312.00, and a one-off budget of 500.00 against One-offs' 250.00.
    setCategoryTarget(db.listCategories().find((c) => c.name === 'Groceries')!.id, 40_000)
    setOneOffBudget(50_000)
    assert.equal(getDebts().targetSpendCents, 237_250)
    const generous = getDebts()
    assert.ok(monthsBetween(runDebtPlan(generous, generous.targetSpendCents!).result.debtFree!, runDebtPlan(generous).result.debtFree!) >= 0)
    // A one-off budget of 200.00 puts One-offs' 250.00 at it: 50.00 less again.
    setOneOffBudget(20_000)
    assert.equal(getDebts().targetSpendCents, 237_250 - 5_000)
    // No target and no budget: nothing to compare.
    for (const c of db.listCategories().filter((x) => x.name === 'Dining Out' || x.name === 'Coffee' || x.name === 'Groceries')) setCategoryTarget(c.id, null)
    setOneOffBudget(null)
    assert.equal(getDebts().targetSpendCents, null)
  })
})

describe('the plan on the sample household', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    db.openDb(':memory:')
    loadDemoData()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("take-home less spending less the set-aside, each strategy's order and next debt, and a debt left out", () => {
    const d = getDebts()
    assert.deepEqual([d.plan, d.targetSpendCents], [NONE, null])
    assert.deepEqual([d.takeHomeCents, d.spendCents, runDebtPlan(d).monthlyCents], [638_516, 306_037, 638_516 - 306_037])
    // Highest rate first: the Mastercard's 0% lasts to March 7, so the Visa's 24.99% comes first, and the Mastercard
    // at 27.49% once its intro rate ends; the mortgage's 6.125% before the car loan's 5.9%, which its payments clear first.
    assert.deepEqual(next(), ['Rewards Visa', 2_499, null])
    assert.deepEqual(paidOff(d), [
      ['Cashback Mastercard', 1, '2027-04', 5_012],
      ['Rewards Visa', 2, '2027-05', 17_105],
      ['Lakeside Auto Loan', 3, '2030-07', 240_785],
      ['Pinecrest Mortgage', 4, '2038-01', 11_958_807]
    ])
    // Smallest balance first: the Mastercard's 1,682.12, gone before its intro rate ends, then the Visa's 2,730.29.
    plan({ strategy: 'snowball' })
    assert.deepEqual(next(), ['Cashback Mastercard', 0, '2027-03-07'])
    assert.deepEqual(paidOff(getDebts()), [
      ['Cashback Mastercard', 1, '2027-02', 0],
      ['Rewards Visa', 2, '2027-05', 25_897],
      ['Lakeside Auto Loan', 3, '2028-08', 130_180],
      ['Pinecrest Mortgage', 4, '2038-01', 12_080_269]
    ])
    // The Visa left out, by rate: the mortgage's 6.125% is next, with what's left once the Visa has its minimum: 1% of
    // the 2,787.15 it owes after its 56.86 of interest, plus that interest, 84.73 (its 35.00 on file is less).
    plan({ strategy: 'avalanche', left_out: ['demo:card-visa'] })
    assert.deepEqual(next(), ['Pinecrest Mortgage', 613, null])
    assert.equal(runDebtPlan(getDebts()).monthlyCents, 638_516 - 306_037 - 8_473)
    assert.deepEqual(paidOff(getDebts()), [
      ['Cashback Mastercard', 1, '2027-05', 5_308],
      ['Lakeside Auto Loan', 2, '2030-07', 240_785],
      ['Pinecrest Mortgage', 3, '2038-02', 12_022_207]
    ])
    // 500.00 set aside and 1,000.00 paid at once, by balance: 3,324.79 - 500.00 a month, less the Visa's 84.73.
    plan({ strategy: 'snowball', set_aside: 500, lump_sum: 1000 })
    const v = getDebts()
    assert.equal(runDebtPlan(v).monthlyCents, 638_516 - 306_037 - 50_000 - 8_473)
    assert.deepEqual(next(), ['Cashback Mastercard', 0, '2027-03-07'])
    assert.deepEqual(paidOff(v), [
      ['Cashback Mastercard', 1, '2027-03', 113],
      ['Lakeside Auto Loan', 2, '2029-06', 176_920],
      ['Pinecrest Mortgage', 3, '2041-03', 15_841_442]
    ])
  })

  test("short of the minimums, each debt still clears by its minimums: the Visa's 35.00 on file never leaves it compounding", () => {
    // 3,000.00 set aside leaves 324.79 of 3,324.79, short of the minimums; the Visa's 35.00 on file is below the 56.86
    // a month it charges, so it's paid its usual 1% and interest, and nothing runs for fifty years.
    plan({ strategy: 'avalanche', left_out: [], set_aside: 3000, lump_sum: 0 })
    const run = runDebtPlan(getDebts())
    assert.deepEqual([run.monthlyCents, run.result.shortfallCents, run.result.debtFree, run.result.interestCents], [638_516 - 306_037 - 300_000, 236_494, '2050-03', 26_628_636])
    assert.deepEqual(
      paidOff(getDebts()).map((x) => x.slice(0, 3)),
      [
        ['Cashback Mastercard', 1, '2029-05'],
        ['Lakeside Auto Loan', 2, '2030-07'],
        ['Rewards Visa', 3, '2038-08'],
        ['Pinecrest Mortgage', 4, '2050-03']
      ]
    )
  })
})

describe("Review's set_debt_plan", () => {
  let h: ReturnType<typeof household>
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    h = household()
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('sets each input, and undo puts debt.plan back as it was, unset at the start', () => {
    assert.equal(db.getSetting(DEBT_PLAN_KEY), null)
    const steps = [
      [{ strategy: 'snowball' }, 'Debt plan: smallest balance first'],
      [{ left_out: [h.civicLoan] }, 'Debt plan: smallest balance first, Civic Auto Loan left out'],
      [{ take_home: 6000 }, 'Debt plan: smallest balance first, Civic Auto Loan left out, take-home $6,000.00'],
      [{ set_aside: 250.5 }, 'Debt plan: smallest balance first, Civic Auto Loan left out, take-home $6,000.00, $250.50 set aside'],
      [{ lump_sum: 1000 }, 'Debt plan: smallest balance first, Civic Auto Loan left out, take-home $6,000.00, $250.50 set aside, $1,000.00 lump sum']
    ] as const
    const seen: Array<string | null> = []
    const changes: Array<number | undefined> = []
    for (const [input, action] of steps) {
      seen.push(db.getSetting(DEBT_PLAN_KEY))
      const r = plan(input)
      assert.equal(r.action, action)
      changes.push(r.changeId)
    }
    assert.deepEqual(debtPlan(), { strategy: 'snowball', leftOut: [h.civicLoan], takeHomeCents: 600_000, setAsideCents: 25_050, lumpCents: 100_000 })
    // 6,000.00 - 2,482.50 - 250.50 = 3,267.00 a month, of which the Civic left out still takes its 412.00.
    assert.equal(runDebtPlan(getDebts()).monthlyCents, 326_700 - 41_200)
    for (let k = changes.length - 1; k >= 0; k--) {
      undoChange(changes[k])
      assert.equal(db.getSetting(DEBT_PLAN_KEY), seen[k], `undoing step ${k + 1}`)
    }
    assert.deepEqual(debtPlan(), NONE)
  })

  test('checks every input before writing any; null clears the take-home, set-aside and lump sum', () => {
    assert.throws(() => plan({}), /Give strategy, left_out, take_home, set_aside or lump_sum/)
    assert.throws(() => plan({ strategy: 'fastest' }), /avalanche .* or snowball/)
    assert.throws(() => plan({ left_out: [ACCOUNTS.checking] }), /Not a debt account: csv:chk/)
    assert.throws(() => plan({ left_out: 'csv:visa' }), /list of account ids/)
    assert.throws(() => plan({ strategy: 'snowball', set_aside: -5 }), /set_aside is dollars of zero or more/)
    assert.throws(() => plan({ take_home: 'lots' }), /take_home is dollars of zero or more/)
    assert.equal(db.getSetting(DEBT_PLAN_KEY), null)
    plan({ take_home: 6000, set_aside: 100, lump_sum: 500 })
    plan({ take_home: null, set_aside: null, lump_sum: 0 })
    assert.deepEqual(debtPlan(), NONE)
  })

  test("its answer is debt_plan's: the plan in dollars, with the same plan at the targets", () => {
    const read = runTool('debt_plan', {}, 'assistant').result as Record<string, unknown>
    assert.deepEqual(read, {
      strategy: 'avalanche',
      left_out: [],
      take_home: 3777,
      take_home_set: false,
      take_home_sources: [{ name: 'Brightline Payroll', monthly: 3777 }],
      spending: 2482.5,
      // August 2026's 2,151.60 and October 2026's 2,986.90, the lowest and highest of the twelve months.
      spending_low: 2151.6,
      spending_high: 2986.9,
      set_aside: 0,
      lump_sum: 0,
      per_month: 1294.5,
      short_of_minimums: 1113.1,
      debt_free: '2050-03',
      interest: 159337.8,
      next: { account_id: ACCOUNTS.visa, name: 'Visa' },
      // minimum is the one on file (a loan's less its escrow), minimum_planned what the plan pays as it starts.
      debts: [
        { account_id: h.civicLoan, name: 'Civic Auto Loan', owed: 8636, apr: 6.4, minimum: 412, minimum_planned: 412, paid_off: '2028-10', interest: 546.64 },
        { account_id: h.studentLoan, name: 'Student Loan', owed: 23786, apr: 4.3, minimum: 300, minimum_planned: 300, paid_off: '2034-09', interest: 4246.23 },
        { account_id: ACCOUNTS.visa, name: 'Visa', owed: 3000, apr: 24, minimum: null, minimum_planned: 90.6, paid_off: '2039-03', interest: 4369.56 },
        { account_id: h.mortgage, name: 'Pinecrest Mortgage', owed: 299195, apr: 3.75, minimum: 1605, minimum_planned: 1605, paid_off: '2050-03', interest: 150175.37 }
      ],
      at_targets: { spending: 2372.5, per_month: 1404.5, short_of_minimums: 1003.1, debt_free: '2050-03', interest: 159337.8 }
    })
    db.updateAccount(ACCOUNTS.visa, { promoApr: 0, promoEnds: '2027-06-01' })
    const set = plan({ take_home: 6000, left_out: [h.mortgage] }).result as Record<string, unknown>
    assert.deepEqual(set, { ok: true, ...(runTool('debt_plan', {}, 'assistant').result as object) })
    // 6,000.00 - 2,482.50, less the 1,605.00 Pinecrest still takes.
    assert.deepEqual([set.take_home, set.take_home_set, set.take_home_run_rate, set.per_month, set.left_out], [6000, true, 3777, 1912.5, [{ account_id: h.mortgage, name: 'Pinecrest Mortgage', minimum: 1605 }]])
    assert.deepEqual((set.debts as Array<Record<string, unknown>>).find((x) => x.name === 'Visa'), { account_id: ACCOUNTS.visa, name: 'Visa', owed: 3000, apr: 24, promo_apr: 0, promo_ends: '2027-06-01', minimum: null, minimum_planned: 35, paid_off: (set.debts as Array<{ name: string; paid_off: string }>).find((x) => x.name === 'Visa')!.paid_off, interest: (set.debts as Array<{ name: string; interest: number }>).find((x) => x.name === 'Visa')!.interest })
  })
})

describe('debt.plan arrives once and localStorage is cleared', () => {
  /** A viewer's storage, as the renderer's localStorage. */
  function storage(entries: Record<string, string> = {}, broken = false): Map<string, string> {
    const m = new Map(Object.entries(entries))
    const store = {
      getItem: (k: string) => {
        if (broken) throw new Error('storage is off')
        return m.get(k) ?? null
      },
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k)
    }
    Object.assign(globalThis, { localStorage: store })
    return m
  }
  const SKIP = JSON.stringify(['csv:visa', 'gone'])
  const INPUTS = JSON.stringify({ takeHome: '4,200', setAside: '$150', lump: '' })

  test('the renderer sends what it kept once, as stored, and clears it once answered (plan.ts with a fake localStorage)', async () => {
    const sent: unknown[] = []
    const api = { adoptDebtPlan: async (s: { skip: string | null; inputs: string | null }) => (sent.push(s), { adopted: sent.length === 1 }) }
    const kept = storage({ [KEPT.skip]: SKIP, [KEPT.inputs]: INPUTS, other: 'stays' })
    await sendDebtPlan(api)
    assert.deepEqual(sent, [{ skip: SKIP, inputs: INPUTS }])
    assert.deepEqual([...kept.keys()], ['other'])
    // Sent again with nothing kept, nothing goes.
    await sendDebtPlan(api)
    assert.equal(sent.length, 1)
    // Answered without taking them (the books had a plan already), they're cleared all the same; a key alone goes alone.
    const one = storage({ [KEPT.inputs]: INPUTS })
    await sendDebtPlan(api)
    assert.deepEqual(sent.at(-1), { skip: null, inputs: INPUTS })
    assert.equal(one.size, 0)
    // A call that fails keeps them for the next open; storage that can't be read sends nothing.
    const failing = storage({ [KEPT.skip]: SKIP })
    await sendDebtPlan({ adoptDebtPlan: async () => Promise.reject(new Error('offline')) })
    assert.deepEqual([...failing.keys()], [KEPT.skip])
    storage({ [KEPT.skip]: SKIP }, true)
    await sendDebtPlan(api)
    assert.equal(sent.length, 2)
    // The app sends them once, as it starts.
    assert.match(source('src/renderer/src/App.tsx'), /void reloadCategories\(\)\s*\/\/[^\n]*\n\s*void sendDebtPlan\(api\)/)
  })

  describe('the handler', () => {
    beforeEach(() => {
      mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
      household()
      events.length = 0
    })
    afterEach(() => {
      db.closeDb()
      mock.timers.reset()
    })

    test('fills an unset debt.plan, and a second send does not overwrite it', async () => {
      assert.deepEqual(await answer('adoptDebtPlan', [{ skip: SKIP, inputs: INPUTS }], web()), { ok: true, data: { adopted: true } })
      // The debts still on the books; 4,200.00 typed as the take-home, 150.00 set aside, no lump sum typed.
      assert.deepEqual(debtPlan(), { strategy: 'avalanche', leftOut: [ACCOUNTS.visa], takeHomeCents: 420_000, setAsideCents: 15_000, lumpCents: 0 })
      assert.deepEqual(events, ['data:changed'])
      const stored = db.getSetting(DEBT_PLAN_KEY)
      assert.deepEqual(await answer('adoptDebtPlan', [{ skip: '[]', inputs: JSON.stringify({ takeHome: '9000' }) }], web()), { ok: true, data: { adopted: false } })
      assert.equal(db.getSetting(DEBT_PLAN_KEY), stored)
      assert.deepEqual(events, ['data:changed'])
      // The plan runs on them: 4,200.00 - 2,482.50 - 150.00 = 1,567.50 a month, less the Visa's 90.60 left out.
      const run = runDebtPlan(getDebts())
      assert.deepEqual([run.monthlyCents, run.debts.map((d) => d.name).sort()], [156_750 - 9_060, ['Civic Auto Loan', 'Pinecrest Mortgage', 'Student Loan']])
      // Once Review has set the plan, a viewer's kept inputs change nothing either.
      db.setSetting(DEBT_PLAN_KEY, null)
      runTool('set_debt_plan', { strategy: 'snowball' }, 'assistant')
      assert.deepEqual(await answer('adoptDebtPlan', [{ skip: SKIP, inputs: INPUTS }], web()), { ok: true, data: { adopted: false } })
      assert.deepEqual(debtPlan(), { ...NONE, strategy: 'snowball' })
    })

    test('a missing key changes nothing; a value the Budget page read as none is none, and the rest still arrives', async () => {
      for (const saved of [{ skip: null, inputs: null }, {}, null, { skip: 5 }]) {
        assert.deepEqual(await answer('adoptDebtPlan', [saved], web()), { ok: true, data: { adopted: false } }, JSON.stringify(saved))
        assert.equal(db.getSetting(DEBT_PLAN_KEY), null, JSON.stringify(saved))
      }
      assert.deepEqual(events, [])
      // The renderer clears both keys once answered, so what the viewer saw arrives: a figure the old page couldn't
      // read as dollars of zero or more ("1.2k", "-20", "lots", true) planned as none, and the debts left out with it.
      const VISA_OUT = { ...NONE, leftOut: [ACCOUNTS.visa] }
      for (const [saved, plan] of [
        [{ skip: SKIP, inputs: JSON.stringify({ takeHome: '', setAside: '1.2k', lump: '' }) }, VISA_OUT],
        [{ skip: SKIP, inputs: JSON.stringify({ takeHome: true, setAside: '-20', lump: 'lots' }) }, VISA_OUT],
        [{ skip: 'not json', inputs: INPUTS }, { ...NONE, takeHomeCents: 420_000, setAsideCents: 15_000 }],
        [{ skip: JSON.stringify({ visa: true }), inputs: JSON.stringify({ lump: '500' }) }, { ...NONE, lumpCents: 50_000 }],
        [{ skip: JSON.stringify([1, ACCOUNTS.visa]) }, VISA_OUT],
        [{ skip: SKIP, inputs: '["4200"]' }, VISA_OUT],
        // A key the viewer never wrote is none: the take-home typed alone.
        [{ skip: null, inputs: JSON.stringify({ takeHome: '5000' }) }, { ...NONE, takeHomeCents: 500_000 }]
      ] as Array<[Record<string, unknown>, DebtPlanInputs]>) {
        db.setSetting(DEBT_PLAN_KEY, null)
        assert.deepEqual(await answer('adoptDebtPlan', [saved], web()), { ok: true, data: { adopted: true } }, JSON.stringify(saved))
        assert.deepEqual(debtPlan(), plan, JSON.stringify(saved))
      }
    })

    test('the order picked on the Budget page before carries over, and debt.plan decides it from the first write on', async () => {
      db.setSetting('budget.prefs', JSON.stringify({ debtStrategy: 'snowball' }))
      db.updateAccount(ACCOUNTS.visa, { promoApr: 0, promoEnds: '2027-06-01' })
      assert.deepEqual([debtPlan().strategy, getDebts().strategy, next()], ['snowball', 'snowball', ['Visa', 0, '2027-06-01']])
      // The budget's own writes keep it as stored.
      setCategoryTarget(db.listCategories().find((c) => c.name === 'Groceries')!.id, 30_000)
      assert.equal(JSON.parse(db.getSetting('budget.prefs')!).debtStrategy, 'snowball')
      // The inputs a viewer kept arrive with it.
      assert.deepEqual(await answer('adoptDebtPlan', [{ skip: '[]' }], web()), { ok: true, data: { adopted: true } })
      assert.equal(JSON.parse(db.getSetting(DEBT_PLAN_KEY)!).strategy, 'snowball')
      runTool('set_debt_plan', { strategy: 'avalanche' }, 'assistant')
      assert.deepEqual([debtPlan().strategy, next()], ['avalanche', ['Civic Auto Loan', 640, null]])
      // Nothing outside debts.ts decides the order.
      const code = (file: string): string => source(file).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
      for (const file of ['src/main/budget.ts', 'src/main/insights.ts', 'src/main/tools.ts', 'src/main/homePlans.ts', 'src/main/handlers/budget.ts']) assert.doesNotMatch(code(file), /debtStrategy|setDebtStrategy/, file)
    })
  })
})

describe("the headline's payoff and the Debts page agree", () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** The payoff Review's digest gives and the plan the Debts page draws: what's owed, the debt-free month, the order. */
  function agree(label: string): void {
    const v = getDebts()
    const run = runDebtPlan(v)
    const payoff = digestOf()!.payoff!
    const owed = run.debts.reduce((s, d) => s + d.balanceCents, 0)
    const free = new Date(`${run.result.debtFree}-15T12:00:00`)
    assert.deepEqual([payoff.owed, payoff.debtFreeAsIs], [Math.round(owed / 100), free.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })], label)
    const html = page(v)
    const short = `${free.toLocaleDateString('en-US', { month: 'short' })} ${run.result.debtFree!.slice(0, 4)}`
    assert.ok(html.includes(`<div class="label-muted">Debt-free</div><div class="tile-value">${short}</div>`), `${label}: ${short}`)
    assert.ok(html.includes(`${run.debts.length} ${run.debts.length === 1 ? 'debt' : 'debts'} · $${Math.round(owed / 100).toLocaleString('en-US')}`) || run.result.shortfallCents > 0, label)
  }

  test('on the household as it is, with a take-home of its own and a debt left out, and on the sample household', () => {
    const h = household()
    agree('household')
    assert.equal(digestOf()!.payoff!.debtFreeAsIs, 'March 2050')
    // The digest follows the plan's inputs as soon as they change, not ten minutes later.
    runTool('set_debt_plan', { take_home: 6000, left_out: [h.mortgage] }, 'assistant')
    agree('a take-home and the mortgage left out')
    // The mortgage left out still takes its 1,605.00 a month of the 3,517.50.
    assert.deepEqual([digestOf()!.payoff!.owed, digestOf()!.payoff!.debtFreeAsIs], [8636 + 23786 + 3000, 'July 2028'])
    db.closeDb()
    db.openDb(':memory:')
    loadDemoData()
    agree('demo')
    assert.equal(digestOf()!.payoff!.debtFreeAsIs, 'January 2038')
  })

  test("the local headline's payoff keeps the years: debt-free in June 2037 instead of January 2038, not June instead of January", async () => {
    db.openDb(':memory:')
    loadDemoData()
    const local = await withAiHost({} as AiHost, () => getInsight(true))
    assert.equal(local?.source, 'local')
    assert.equal(local?.headline, "Eat out once a week and you're debt-free in June 2037 instead of January 2038")
  })

  test('Debts draws the plan as data: no input, toggle or button; the not-advice line stays; the inputs, the order and the debts left out as data', () => {
    const h = household()
    db.updateAccount(ACCOUNTS.visa, { promoApr: 0, promoEnds: '2027-06-01' })
    runTool('set_debt_plan', { take_home: 6000, left_out: [h.civicLoan], set_aside: 250, lump_sum: 1000 }, 'assistant')
    const html = page(getDebts())
    assert.doesNotMatch(html, /<input|<select|<button|<form|<textarea/)
    assert.ok(html.includes(NOT_ADVICE))
    // The heading takes the keyboard's place when Saved's › Debts opens the plan; the order and next debt are cut short
    // to one line, whole in their title.
    assert.match(html, /<h2 id="payoff-head" tabindex="-1">Payoff plan<\/h2><span class="label-muted" title="Highest rate first · next Student Loan">Highest rate first · next Student Loan<\/span>/)
    const v = getDebts()
    // As the Budget page had them: the run rate by where it comes from, and the spending in each of the twelve months.
    const sources = v.incomeSources.map((s) => `${s.name} ${fmtMoneyRound(s.monthlyCents)}`).join('\n')
    const spent = [`${fmtMoneyRound(v.spendLowCents)} – ${fmtMoneyRound(v.spendHighCents)}`, ...v.spendMonths.map((m) => `${new Date(`${m.month}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short' })} ${m.month.slice(0, 4)} ${fmtMoneyRound(m.cents)}`)].join('\n')
    assert.deepEqual([v.incomeSources.length, v.spendMonths.length], [1, 12])
    for (const [label, value, title] of [
      ['Take-home', '$6,000 · run rate $3,777', sources],
      ['Spending', '$2,483 · at targets $2,373', spent],
      ['Set aside', '$250'],
      ['Lump sum', '$1,000'],
      ['Left out', 'Civic Auto Loan $412']
    ])
      assert.ok(html.includes(`<span class="label-muted">${label}</span> <span class="num"${title ? ` title="${title}"` : ''}>${value}</span>`), `${label} ${value}`)
    const read = runTool('debt_plan', {}, 'assistant').result as Record<string, unknown>
    assert.deepEqual([read.take_home_sources, read.spending_low, read.spending_high], [v.incomeSources.map((s) => ({ name: s.name, monthly: s.monthlyCents / 100 })), v.spendLowCents / 100, v.spendHighCents / 100])
    // 6,000.00 - 2,482.50 - 250.00 - the Civic's 412.00 = 2,855.50 to the debts a month.
    assert.ok(html.includes('<div class="label-muted">To debts a month</div><div class="tile-value">$2,856</div>'))
    // The debt left out is listed, dimmed, with nothing planned for it; the Visa at its intro rate.
    assert.match(html, /<div class="debt-row off" role="row"><span class="debt-name clamp-2" role="cell" title="Civic Auto Loan">Civic Auto Loan<\/span><span class="num" role="cell">\$8,636<\/span><span class="num " role="cell">6\.4%<\/span><span class="num " role="cell">\$412<\/span><span class="num" role="cell">—<\/span><span class="num" role="cell">Left out<\/span><span class="num muted" role="cell">—<\/span><\/div>/)
    // Rates as Saved writes the next debt's: 0.0% to Jun 2027, then 24.0%.
    assert.match(html, /title="24\.0% from Jun 2027">0\.0% to Jun 2027<\/span>/)
    // The Visa has no minimum on file: the plan's, its usual 35.00 at 0%, marked as one the plan assumes.
    assert.match(html, /Visa<\/span><span class="num" role="cell">\$3,000<\/span><span[^>]*>[^<]*<\/span><span class="num muted" role="cell">≈\$35<\/span>/)
    // A table of rows and cells under their column heads.
    assert.equal(html.match(/role="columnheader"/g)?.length, 7)
    assert.equal(html.match(/role="cell"/g)?.length, 7 * 4)
    // The order shown is the plan's: each debt's place and payoff month.
    const run = runDebtPlan(getDebts())
    for (const d of run.result.debts) {
      const name = run.debts.find((x) => x.id === d.id)!.name
      const off = d.paidOff!
      const month = `${new Date(`${off}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short' })} ${off.slice(0, 4)}`
      assert.match(html, new RegExp(`${name}</span><span class="num" role="cell">[^<]*</span><span class="num[^"]*"[^>]*>[^<]*</span><span class="num[^"]*" role="cell">[^<]*</span><span class="num" role="cell">${d.order}</span><span class="num" role="cell">${month}</span>`), name)
    }
  })

  test("the chart: a debt's layer ends the month it's paid off, so the stack's top is a debt still owing; each debt keeps its colour", () => {
    household()
    runTool('set_debt_plan', { take_home: 6000 }, 'assistant')
    const v = getDebts()
    const points = planChart(v.month, runDebtPlan(v))
    const visa = (m: string): unknown => points.find((p) => p.month === m)?.[ACCOUNTS.visa]
    // Paid off in February 2027: 3,000.00 as the plan starts, nothing in February, and no point after.
    assert.deepEqual([points[0].month, visa('2026-11'), visa('2027-02'), visa('2027-03'), visa('2036-05')], ['2026-11', 300_000, 0, null, null])
    assert.equal(points.length, runDebtPlan(v).result.months.length + 1)
    // The Civic's colour with every debt in the plan and with the Visa left out.
    const dot = (html: string): string => /background:([^"]+)"><\/span>Civic Auto Loan/.exec(html)![1]
    const before = dot(page(v))
    runTool('set_debt_plan', { left_out: [ACCOUNTS.visa] }, 'assistant')
    assert.equal(dot(page(getDebts())), before)
  })

  test('a plan that never ends shows no interest: fifty years of it is no figure', () => {
    const h = household()
    // The student loan's 50.00 on file is under the 86.00 it charges, and 4,000.00 set aside leaves nothing extra.
    runTool('update_account', { account_id: h.studentLoan, min_payment: 50 }, 'assistant')
    runTool('set_debt_plan', { set_aside: 4000 }, 'assistant')
    const v = getDebts()
    const run = runDebtPlan(v)
    assert.equal(run.result.debtFree, null)
    const html = page(v)
    assert.ok(html.includes('<div class="label-muted">Interest</div><div class="tile-value">—</div>'))
    assert.match(html, /Student Loan<\/span><span class="num" role="cell">\$23,786<\/span>(<span[^>]*>[^<]*<\/span>){3}<span class="num" role="cell">—<\/span><span class="num muted" role="cell">—<\/span>/)
    assert.doesNotMatch(html, /— interest/)
    const read = runTool('debt_plan', {}, 'assistant').result as { interest: number | null; debts: Array<{ name: string; interest: number | null }> }
    assert.equal(read.interest, null)
    assert.equal(read.debts.find((d) => d.name === 'Student Loan')!.interest, null)
    // A debt the plan does pay off keeps its interest.
    assert.equal(read.debts.find((d) => d.name === 'Civic Auto Loan')!.interest, 546.64)
  })

  test('every debt left out: the plan pays none, so it has no monthly amount, debt-free month or interest, and the list wraps', () => {
    const h = household()
    runTool('set_debt_plan', { left_out: [ACCOUNTS.visa, h.civicLoan, h.studentLoan, h.mortgage] }, 'assistant')
    const v = getDebts()
    assert.deepEqual([runDebtPlan(v).monthlyCents, runDebtPlan(v).debts.length], [0, 0])
    const html = page(v)
    for (const label of ['Debt-free', 'To debts a month', 'Interest']) assert.ok(html.includes(`<div class="label-muted">${label}</div><div class="tile-value">—</div>`), label)
    assert.doesNotMatch(html, /0 debts/)
    // The four left out, each with its minimum: 1,294.50 doesn't cover their 2,407.60.
    assert.ok(html.includes('$1,113 short of the minimums'))
    assert.match(source('src/renderer/src/styles.css'), /\.plan-input \.num \{\s*white-space: normal;/)
    // And a plan too narrow for its chart's plot beside the axis draws no chart.
    assert.match(source('src/renderer/src/styles.css'), /#payoff \{[^}]*container: payoff \/ inline-size;[^}]*\}[\s\S]*@container payoff \(max-width: 320px\) \{\s*\.plan-chart \{\s*display: none;/)
  })

  test('with no debts the plan is absent', () => {
    const h = household()
    for (const id of [ACCOUNTS.visa, h.civicLoan, h.studentLoan, h.mortgage]) db.updateAccount(id, { hidden: true })
    const v = getDebts()
    assert.deepEqual(v.debts, [])
    assert.equal(page(v), '')
    assert.equal(nextDebt(), null)
    assert.equal(homePlans().nextDebt, null)
    assert.equal(digestOf()!.payoff, null)
    const read = runTool('debt_plan', {}, 'assistant').result as Record<string, unknown>
    assert.deepEqual([read.next, read.debts, read.debt_free, read.interest], [null, [], null, 0])
  })
})

describe('the parked debt card and the Budget page\'s payoff are gone; Debts is the plan\'s only home', () => {
  test('DebtCard.tsx and Budget.tsx are deleted, no other page draws a plan or a Debt-free tile, and plan.ts keeps none of the old inputs', () => {
    assert.ok(!existsSync(join(root, 'src/renderer/src/pages/DebtCard.tsx')))
    assert.ok(!existsSync(join(root, 'src/renderer/src/pages/Budget.tsx')))
    const kept = source('src/renderer/src/plan.ts')
    assert.doesNotMatch(kept, /loadPrefs|savePrefs|runPlan|parseDollars|budgetSavings|localStorage\.setItem/)
    assert.doesNotMatch(source('src/shared/types.ts'), /setDebtStrategy/)
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
    // Only Debts reads the debts or names the date they're gone (the demo's key list names every read); Home's Saved
    // reads the plan's next target from getHomePlans, and the App only sends the old inputs and opens the plan.
    const pages = walk(join(root, 'src/renderer/src')).filter((f) => !f.includes(`${join('src', 'renderer', 'src', 'demo')}`))
    assert.deepEqual(pages.filter((f) => /Debt-free|getDebts|setDebtStrategy/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1).replaceAll('\\', '/')), ['src/renderer/src/pages/DebtPlan.tsx'])
    assert.deepEqual(pages.filter((f) => /from '\.\.?\/plan'/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1).replaceAll('\\', '/')).sort(), ['src/renderer/src/App.tsx', 'src/renderer/src/pages/DebtPlan.tsx'])
    const plans = walk(join(root, 'src/renderer/src')).filter((f) => /simulate\(|runDebtPlan\(/.test(readFileSync(f, 'utf8')))
    assert.deepEqual(plans.map((f) => f.slice(root.length + 1).replaceAll('\\', '/')), ['src/renderer/src/pages/DebtPlan.tsx'])
    // Net worth's Debts draws it, and opening Debts through goNet (Saved's › Debts) lands on it.
    assert.match(source('src/renderer/src/pages/NetWorth.tsx'), /<DebtPlan \/>/)
    assert.match(source('src/renderer/src/App.tsx'), /if \(v === 'debts'\) focusPayoff\(\)/)
    // Its four figures go one above the other at a phone's width: the strip rule under 1000 px, more specific than
    // the plan's own, leaves the plan's alone; and a debt left out is dimmed by a colour that reads, not by opacity.
    const css = source('src/renderer/src/styles.css')
    assert.match(css, /@media \(max-width: 1000px\) \{\s*\.stat-strip:not\(\[style\]\):not\(\.three\):not\(\.five\):not\(\.plan-strip\) \{/)
    assert.match(css, /@media \(max-width: 700px\) \{\s*\.stat-strip\.plan-strip\.even,\s*\.stat-strip\.plan-strip\.three \{\s*grid-template-columns: minmax\(0, 1fr\);/)
    assert.doesNotMatch(css, /\.debt-row\.off \{\s*opacity/)
    // In view below the top bar as tall as it stands, with the keyboard's place on its heading.
    assert.match(
      source('src/renderer/src/pages/DebtPlan.tsx'),
      /if \(takePayoffFocus\(\) && view\.debts\.length\)\s*requestAnimationFrame\(\(\) => \{\s*const plan = document\.getElementById\('payoff'\)\s*const bar = document\.querySelector\('\.topbar'\)\?\.getBoundingClientRect\(\)\.height\s*if \(plan && bar\) plan\.style\.scrollMarginTop = `\$\{Math\.ceil\(bar\) \+ 8\}px`\s*plan\?\.scrollIntoView\(\{ block: 'start' \}\)\s*document\.getElementById\('payoff-head'\)\?\.focus\(\{ preventScroll: true \}\)/
    )
  })
})

describe("the cost of Net worth's Debts on a large ledger", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("its calls, the balance sheet and getDebts, and the plan with its comparisons: after Home's waterfall under 100 ms, after a change nothing has read since under 500 ms", async (t) => {
    db.openDb(':memory:')
    largeLedger({ from: '2018-12' })
    const debts = (): void => {
      getBalanceSheet()
      const v = getDebts()
      const run = runDebtPlan(v)
      likelyDebtFree(v, run)
      if (v.targetSpendCents !== null) runDebtPlan(v, v.targetSpendCents)
    }
    assert.ok(getDebts().debts.length > 0)
    // npm test runs the files at once: each budget is timed against test/cost.ts's reference work in paired rounds,
    // and holds as the median of the rounds' ratios. Opened from Home, the lines Home's waterfall classified are
    // read again; each round's write first, then the waterfall, as Home has it open. The balance sheet walks every
    // counted account to today, an account with no balance of its own too, as Net worth's Overview reads it, so Debts'
    // own reads have the Overview's budget for its own, 100 ms.
    const warm = await paired(
      6,
      () => repeatedMs(debts, 50),
      (k) => {
        db.setSetting('test.debtsRound', String(k))
        month('2026-10')
      }
    )
    t.diagnostic(within("Debts after Home's waterfall", 100, warm))
    assert.ok(warm.ratio <= budgetRatio(100), within("Debts after Home's waterfall", 100, warm))
    // Open when a sync lands: the plan's run rates classify their months again, as a waterfall would.
    const cold = await paired(
      6,
      () => {
        const at = performance.now()
        debts()
        return performance.now() - at
      },
      (k) => db.setSetting('test.debtsCold', String(k))
    )
    t.diagnostic(within('Debts after a change', 500, cold))
    assert.ok(cold.ratio <= budgetRatio(500), within('Debts after a change', 500, cold))
  })
})
