import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AiHost } from '../src/main/ai/host.ts'
import type { HandlerContext } from '../src/main/handlers/context.ts'
import type { Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS, household, TODAY } from './fixtures/waterfall-household.ts'

// Home's Left over, Saved, Invested and Growth drills together (waterfall spec sub-phase 2c, its two parts merged):
// a month changed since its close shows what moved under the drill line it moved in, in each of the four drills,
// and nothing under a line that didn't move; and Saved's next debt is the debt plan's first target, the one Net
// worth's Debts lists and Review's payoff headline counts, owing the same.

const here = dirname(fileURLToPath(import.meta.url))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})

const db = await import('../src/main/db.ts')
const { getBalanceSheet } = await import('../src/main/netWorth.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { getWaterfall } = await import('../src/main/waterfall.ts')
const { homePlans } = await import('../src/main/homePlans.ts')
const { getDebts } = await import('../src/main/debts.ts')
const { buildDigest } = await import('../src/main/insights.ts')
const { withAiHost } = await import('../src/main/ai/host.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { answer } = await import('../src/main/handlers/table.ts')
const { checkClosed, closeDueMonths } = await import('../src/main/snapshots.ts')
const { targetOf, CARD_APR, LOAN_APR } = await import('../src/shared/debtPlan.ts')
const { shiftMonth } = await import('../src/shared/zone.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const { tieOut } = await import('./fixtures/tieout.ts')
type HomeLine = import('../src/renderer/src/pages/homeView.ts').HomeLine
type Opened = import('../src/renderer/src/pages/homeView.ts').Opened

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const names = (): Map<string, string> => new Map(db.listAccounts().map((a) => [a.id, a.name]))
const web = (): HandlerContext =>
  ({
    platform: 'web',
    plan: { plan: 'plus' },
    broadcast: () => {},
    calendarChanged: () => {},
    settings: () => ({ licenseTokenSaved: false, apiKeySource: 'none', simplefinConnected: false, bank: { available: true, connections: [] }, lastSyncAt: null, syncsLast24h: 0, historyFrom: null, historyComplete: false, syncWarnings: [], dataPath: '', database: { encrypted: false, switchable: false, switchOn: false, recoveryPending: false, keySeal: 'install' } })
  }) as unknown as HandlerContext

/**
 * What an open row draws under it, a line each: a part or an account line by its name, a data line by its key, and a
 * closed line as its name, today's figure, the close's and the move, a step in when it's under a part of its own.
 */
function drawn(w: Waterfall, open: Opened): string[] {
  const lines = view.homeTable(w, open, names(), { plans: homePlans() }).lines
  const at = lines.findIndex((l) => l.kind === 'row' && l.open)
  const out: string[] = []
  for (const l of lines.slice(at + 1) as HomeLine[]) {
    if (l.kind === 'row' && !l.less) break
    if (l.kind === 'row') out.push(`row ${l.name}`)
    else if (l.kind === 'part' || l.kind === 'account') out.push(`${l.kind} ${l.name}`)
    else if (l.kind === 'data') out.push(`data ${l.key}`)
    else if (l.kind === 'closed') out.push(`${l.nested ? '  ' : ''}closed ${l.name} ${l.now} | ${l.closed} | ${l.change}`)
    else out.push(l.kind)
  }
  return out
}

describe("a month changed since its close, in each of the four drills, on section 5's household", () => {
  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    const h = household()
    await closeDueMonths()
    // On the Transactions page, September's 48.00 meal moves from Travel to Dining Out, and October's 500.00 to the
    // brokerage is put in the Side Studio venture; on the Accounts page, October's brokerage statement is 5.00 higher.
    const dining = db.listCategories().find((c) => c.name === 'Dining Out')!.id
    assert.ok((await answer('updateTransaction', [h.meal, { categoryId: dining }], web())).ok)
    const toBrokerage = db.get<{ id: string }>("SELECT id FROM transactions WHERE account_id = ? AND description = 'TRANSFER TO BROKERAGE' AND posted >= ?", ACCOUNTS.checking, noonOn(2026, 10, 1))!.id
    assert.ok((await answer('updateTransaction', [toBrokerage, { bucketId: h.venture }], web())).ok)
    db.setBalancePoint(ACCOUNTS.brokerage, '2026-10-31', db.balancesOn([ACCOUNTS.brokerage], '2026-10-31').get(ACCOUNTS.brokerage)! + 500)
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => c.month).sort(), ['2026-09', '2026-10'])
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  const m = view.MINUS

  test("Left over: Dining Out's run rate and change a step in under it, the other categories with none", () => {
    const shown = drawn(month('2026-10'), 'leftOver')
    const at = shown.indexOf('part Dining Out')
    assert.deepEqual(shown.slice(at, at + 4), ['part Dining Out', `  closed Dining Out run rate ${m}494 | ${m}478 | ${m}16`, `  closed Dining Out Δ 3 mo ${m}86 | ${m}70 | ${m}16`, 'part Groceries'])
    for (const name of ['Groceries', 'Coffee', 'Gas & Fuel']) assert.ok(!shown.some((l) => l.includes(`closed ${name}`)), name)
  })

  test("Saved: Kept's run rate under Kept, and under Reconciling where Kept went: Ventures and Moved to investments", () => {
    const shown = drawn(month('2026-10'), 'saved')
    const kept = shown.indexOf('part Kept')
    // October's Left over run rate is 534.50 and One-offs' 246.00, so Kept's is 288.50 against 300.50.
    assert.deepEqual(shown.slice(kept, kept + 4), ['part Kept', `  closed Kept run rate 289 | 301 | ${m}12`, `  closed Kept Δ 3 mo ${m}132 | ${m}120 | ${m}12`, 'part Saved at work'])
    const reconciling = shown.indexOf('data reconciling')
    assert.deepEqual(shown.slice(reconciling, reconciling + 4), ['data reconciling', `closed Ventures ${m}280 | 220 | ${m}500`, `closed Moved to investments 0 | 500 | ${m}500`, 'data goals'])
    assert.ok(!shown.some((l) => /closed (Saved at work|Employer saving)/.test(l)))
  })

  test('Invested: From cash a step in under its own line; Saved at work and employer saving, which held, with none', () => {
    const shown = drawn(month('2026-10'), 'invested')
    const at = shown.indexOf('part Saved at work')
    assert.deepEqual(shown.slice(at, at + 7), [
      'part Saved at work',
      'part Employer saving',
      'part From cash',
      `  closed From cash 0 | 500 | ${m}500`,
      `  closed From cash run rate 208 | 250 | ${m}42`,
      `  closed From cash Δ 3 mo ${m}42 | 0 | ${m}42`,
      'data levers:invested'
    ])
    // A part draws no rate, so no closed rate is drawn under one.
    assert.ok(!shown.some((l) => / rate \d/.test(l) && l.startsWith('  closed') && !l.includes('run rate')))
  })

  test("Growth: the brokerage's return under its account line, and the bridge's moves under Net worth", () => {
    const shown = drawn(month('2026-10'), 'growth')
    const nw = shown.indexOf('data netWorth')
    // Net worth is 5.00 higher; the 500.00 the venture paid into the brokerage is Ventures' and the bridge's Other.
    assert.deepEqual(shown.slice(nw, nw + 6), [
      'data netWorth',
      'closed Net worth 412,305 | 412,300 | 5',
      'closed Growth 2,145 | 2,140 | 5',
      `closed Ventures ${m}789 | ${m}289 | ${m}500`,
      'closed Other 500 | 0 | 500',
      'closed Brokerage outside flow 500 | 0 | 500'
    ])
    // Its return 2,088.00 against 2,083.00, and its run rate 5.00 / 12 higher, in cents as whole dollars wouldn't move.
    const brokerage = shown.indexOf('account Brokerage')
    assert.deepEqual(shown.slice(brokerage, brokerage + 4), ['account Brokerage', '  closed Brokerage 2,088 | 2,083 | 5', '  closed Brokerage run rate 1,143.42 | 1,143.00 | 0.42', 'account Brightline 401(k)'])
    assert.ok(!shown.some((l) => l.startsWith('closed Brightline')))
  })
})

describe("Saved's next debt is the debt plan's first target, on Net worth's Debts and in Review's payoff, owing the same", () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /**
   * The plan's inputs (getDebts), Saved's debt line, the Debts page (the balance sheet's cards and loans) and the
   * payoff the headline and Review read agree: every planned debt is listed owing what the plan has it owe, the line
   * names the plan's first target with what it owes, and the payoff owes their total.
   */
  function agree(label: string): void {
    const d = getDebts()
    assert.ok(d.debts.length > 0, label)
    const plans = homePlans()
    const next = plans.nextDebt!
    const planned = d.debts.map((x) => ({ ...x, apr: x.apr ?? (x.kind === 'card' ? CARD_APR : LOAN_APR) }))
    const start = shiftMonth(db.today().slice(0, 7), 1)
    const first = d.debts[targetOf(planned, planned.map((x) => x.balanceCents), d.strategy, start)]
    assert.deepEqual([next.id, next.owedCents], [first.id, first.balanceCents], `${label} the plan's first target`)
    // Saved's line, the last full month open, as Home opens by default.
    const w = month(shiftMonth(db.today().slice(0, 7), -1))
    const line = view.homeTable(w, 'saved', names(), { plans }).lines.find((l) => l.kind === 'data' && l.key === 'debt')
    assert.ok(line && line.kind === 'data', label)
    assert.ok(line.text.startsWith(`next ${first.name} `) && line.text.endsWith(` · ${view.dollars(first.balanceCents)}`), `${label} ${line.text}`)
    assert.deepEqual(line.net, { view: 'debts', label: 'Debts' })
    // Net worth's Debts: each planned debt, owing what the plan has it owe.
    const sheet = getBalanceSheet()
    const listed = new Map(sheet.groups.filter((g) => g.id === 'cards' || g.id === 'loans').flatMap((g) => g.accounts.map((x) => [x.account.id, -x.cents] as const)))
    for (const x of d.debts) assert.equal(listed.get(x.id), x.balanceCents, `${label} ${x.name} on Debts`)
    // Review's payoff headline counts the same debts, in whole dollars, its plan worked out for this ledger alone.
    const digest = withAiHost({} as AiHost, () => buildDigest())
    assert.equal(digest?.payoff?.owed, Math.round(d.debts.reduce((s, x) => s + x.balanceCents, 0) / 100), label)
  }

  test('the sample household', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    db.openDb(':memory:')
    loadDemoData()
    agree('demo')
  })

  test('the section 2 tie-out', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
    agree('tie-out')
  })
})
