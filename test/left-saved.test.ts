import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HandlerContext } from '../src/main/handlers/context.ts'
import type { HomePlans, LineQuery, StageId, Waterfall } from '../src/shared/types.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import { budgetRatio, paired, repeatedMs, within } from './cost.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS, household, line, TODAY } from './fixtures/waterfall-household.ts'

// Left over's and Saved's drills (waterfall spec sub-phase 2c, part 1): section 5's LEFT OVER OPEN, SAVED OPEN and
// DEPOSITS ONLY, figure for figure; Everyday by category, Lifestyle and Essentials together with a tag, their targets
// and rollover and the habits under them, or by payee; the open month's pace; One-offs' items, trips and budget, where
// Kept went and what reconciles it, the goals and the debt plan's next target; the debt plan's inputs from the run
// rates (spec 1.6); every drill adding up to its row and opening exactly its lines, on the household, the sample
// household and the section 2 tie-out, month by month and over spans; and what opening either costs on a large ledger.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place. The renderer's .tsx load through
// the same transform the app's bundler uses (Vite's Rolldown), so a page's component renders here as it does there.
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
const { getWaterfall, runRates } = await import('../src/main/waterfall.ts')
const { ledgerLines, linesFor } = await import('../src/main/lines.ts')
const { homePlans } = await import('../src/main/homePlans.ts')
const { getDebts } = await import('../src/main/debts.ts')
const { saveTrip } = await import('../src/main/trips.ts')
const { commitHabit } = await import('../src/main/budget.ts')
const { setHiddenVendors } = await import('../src/main/privacy.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { answer } = await import('../src/main/handlers/table.ts')
const { methodKind } = await import('../src/main/handlers/table.ts')
const { checkClosed, closeDueMonths } = await import('../src/main/snapshots.ts')
const { payeeName } = await import('../src/shared/payroll.ts')
const { simulate } = await import('../src/shared/debtPlan.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const { drillFilter, lineQuery } = await import('../src/renderer/src/pages/txnFilter.ts')
const { HomeRows } = await import('../src/renderer/src/pages/HomeRows.tsx')
const { tieOut, MONTHS: TIE_MONTHS } = await import('./fixtures/tieout.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')
type HomeLine = import('../src/renderer/src/pages/homeView.ts').HomeLine
type PartLine = import('../src/renderer/src/pages/homeView.ts').PartLine
type DataLine = import('../src/renderer/src/pages/homeView.ts').DataLine
type RowLine = import('../src/renderer/src/pages/homeView.ts').RowLine
type TxnFilter = import('../src/renderer/src/pages/txnFilter.ts').TxnFilter
type DrillState = import('../src/renderer/src/pages/homeView.ts').DrillState

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const source = (path: string): string => readFileSync(join(root, path), 'utf8')
const web = (plan: 'plus' | 'free' = 'plus'): HandlerContext =>
  ({
    platform: 'web',
    plan: { plan },
    broadcast: () => {},
    calendarChanged: () => {},
    settings: () => ({ licenseTokenSaved: false, apiKeySource: 'none', simplefinConnected: false, bank: { available: true, connections: [] }, lastSyncAt: null, syncsLast24h: 0, historyFrom: null, historyComplete: false, syncWarnings: [], dataPath: '', database: { encrypted: false, switchable: false, switchOn: false, recoveryPending: false, keySeal: 'install' } })
  }) as unknown as HandlerContext

/** Every line a query picks, a page of 1,000 at a time: their keys, sorted, and their sum. */
function drilled(q: LineQuery): { keys: string[]; cents: number } {
  const keys: string[] = []
  let cents = 0
  for (let offset = 0; ; offset += 1000) {
    const page = linesFor(q, { offset, limit: 1000 })
    keys.push(...page.lines.map((l) => l.key))
    cents = page.cents
    if (offset + 1000 >= page.total) break
  }
  return { keys: keys.sort(), cents }
}
/** The lines a Transactions filter opens on. */
const listed = (f: TxnFilter): ReturnType<typeof drilled> => drilled(lineQuery(f, TODAY)!)
const keysOf = (lines: Array<{ key: string }>): string[] => lines.map((l) => l.key).sort()
const sumOf = (lines: Array<{ cents: number }>): number => lines.reduce((s, l) => s + l.cents, 0)
/** Money out as lines see it: minus a cost, and 0 for nothing (not -0). */
const neg = (cents: number): number => (cents === 0 ? 0 : -cents)

/** A span's first and last days. */
function daysOf(w: Waterfall): { fromDay: string; toDay: string } {
  if (w.span.from.length === 10) return { fromDay: w.span.from, toDay: w.span.to }
  const [y, m] = w.span.to.split('-').map(Number)
  return { fromDay: `${w.span.from}-01`, toDay: `${w.span.to}-${String(daysInMonth(y, m)).padStart(2, '0')}` }
}

/** What an open row shows under it: its less rows, its parts (name, tag, amount, run rate, Δ 3 mo, note) and its data lines (label, text). */
function opened(w: Waterfall, open: 'leftOver' | 'saved', drill: DrillState = {}): { row: string[]; under: Array<Array<string | null>> } {
  const lines = view.homeTable(w, open, new Map(), drill).lines
  const at = lines.findIndex((l) => l.kind === 'row' && l.open)
  const head = lines[at] as RowLine
  const under: Array<Array<string | null>> = []
  for (const l of lines.slice(at + 1)) {
    if (l.kind === 'row' && !l.less) break
    if (l.kind === 'row') under.push([l.name, l.amount, l.runRate, l.rate, l.change])
    else if (l.kind === 'part') under.push([l.nested ? `  ${l.name}` : l.name, l.tag ?? '', l.amount, l.runRate, l.change, l.note])
    else if (l.kind === 'data') under.push([l.label, l.text])
    else if (l.kind === 'switch') under.push([`switch ${l.value}`])
  }
  return { row: [head.name, head.amount, head.runRate, head.rate, head.change, head.pts ?? '', head.focus ? '●' : ''], under }
}

/**
 * Left over's drill ties (spec 1.5): each Everyday category opens exactly its lines, Personal's everyday lines in it
 * over the span, adding up to the part, and the parts to Everyday, in amount, run rate and change; each payee opens
 * exactly the everyday lines paid to it, the rest one line, and they add up to Everyday too.
 */
function leftOverTies(w: Waterfall, label: string): void {
  const days = daysOf(w)
  const everyday = w.rows.find((r) => r.id === 'everyday')!
  const mine = ledgerLines(days.fromDay, days.toDay).filter((l) => l.owner === null && l.cls === 'everyday')
  const parts = view.homeTable(w, 'leftOver').lines.filter((l): l is PartLine => l.kind === 'part' && !l.nested)
  assert.deepEqual(
    parts.map((l) => l.key),
    everyday.parts.map((p) => p.key),
    `${label} a line a category`
  )
  for (const p of everyday.parts) {
    const got = listed(parts.find((l) => l.key === p.key)!.drill!)
    const want = mine.filter((l) => `cat:${l.categoryId ?? 'none'}` === p.key)
    assert.deepEqual(got.keys, keysOf(want), `${label} ${p.name}'s lines`)
    assert.equal(got.cents, neg(p.actualCents), `${label} ${p.name}`)
  }
  const total = (f: (p: (typeof everyday.parts)[number]) => number | null): number => everyday.parts.reduce((s, p) => s + (f(p) ?? 0), 0)
  assert.deepEqual([total((p) => p.actualCents), total((p) => p.runRateCents), total((p) => p.changeCents)], [everyday.actualCents, everyday.runRateCents, everyday.changeCents], `${label} the categories are Everyday`)
  // By payee: each a payee's lines, the rest and any hidden vendor one line, together every everyday line.
  for (const x of w.payees) {
    const want = mine.filter((l) => payeeName(l) === x.key)
    assert.deepEqual([x.cents, x.count], [neg(sumOf(want)), want.length], `${label} ${x.key}`)
  }
  assert.equal(w.payees.reduce((s, x) => s + x.cents, 0), everyday.actualCents, `${label} the payees are Everyday`)
  const payees = view.homeTable(w, 'leftOver', new Map(), { leftOverView: 'payees' }).lines.filter((l): l is PartLine => l.kind === 'part')
  assert.ok(payees.length <= view.PAYEES_SHOWN + 1, label)
  const seen: string[] = []
  let cents = 0
  for (const l of payees) {
    const got = listed(l.drill!)
    assert.equal(view.dollars(got.cents), l.amount, `${label} ${l.name}`)
    seen.push(...got.keys)
    cents += got.cents
  }
  assert.deepEqual(seen.sort(), keysOf(mine), `${label} every everyday line under one payee`)
  assert.equal(cents, neg(everyday.actualCents), `${label} the payees' lines are Everyday`)
}

/**
 * Saved's drill ties (spec 1.6): its parts are Saved; One-offs' lines over the span are One-offs, its items each a
 * transaction's one-off lines, the largest first, and its trips each the one-offs bought on it.
 */
function savedTies(w: Waterfall, label: string): void {
  const days = daysOf(w)
  const row = (id: StageId): Waterfall['rows'][number] => w.rows.find((r) => r.id === id)!
  const saved = row('saved')
  assert.equal(
    saved.parts.reduce((s, p) => s + p.actualCents, 0),
    saved.actualCents,
    `${label} Saved's parts`
  )
  const offs = ledgerLines(days.fromDay, days.toDay).filter((l) => l.owner === null && (l.cls === 'oneOff' || l.cls === 'oneOffIncome'))
  const byTxn = new Map<string, number>()
  for (const l of offs) byTxn.set(l.txnId, (byTxn.get(l.txnId) ?? 0) - l.cents)
  assert.equal(w.oneOffs.count, byTxn.size, `${label} one-off items`)
  assert.equal(w.oneOffs.items.length, Math.min(40, byTxn.size), label)
  for (const i of w.oneOffs.items) assert.equal(i.cents, byTxn.get(i.txnId), `${label} ${i.txnId}`)
  const all = [...byTxn.values()].sort((a, b) => b - a)
  assert.deepEqual(
    w.oneOffs.items.map((i) => i.cents),
    all.slice(0, 40),
    `${label} the largest items`
  )
  assert.equal(
    all.reduce((s, c) => s + c, 0),
    row('oneOffs').actualCents,
    `${label} the items are One-offs`
  )
  // Saved's Items line: each opens its transaction's one-off lines, and All every one of them.
  const items = view.homeTable(w, 'saved').lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'oneOffItems')?.items ?? []
  assert.equal(items.length > 0, byTxn.size > 0, label)
  for (const i of items) {
    const got = listed(i.drill!)
    const want = i.text.startsWith('All ') ? offs : offs.filter((l) => i.drill!.ids!.includes(l.txnId))
    assert.deepEqual(got.keys, keysOf(want), `${label} ${i.text}`)
    if (i.text.startsWith('All ')) assert.equal(got.cents, neg(row('oneOffs').actualCents), `${label} All`)
  }
  for (const t of w.oneOffs.trips) {
    const got = drilled({ ...days, cls: ['oneOff', 'oneOffIncome'], owner: null, ids: t.ids })
    assert.equal(got.cents, neg(t.cents), `${label} ${t.name}`)
  }
}

describe("section 5's household: Left over and Saved open (spec section 5)", () => {
  let w: Waterfall
  let plans: HomePlans
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    w = month('2026-10')
    plans = homePlans()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('LEFT OVER OPEN: Everyday -1,106 -1,020 64.9% -70, the over_target levers, and Dining out L -520 -478 -70 target -400 · Groceries E -330 -312 0 · Coffee L -151 -132 0 target -100 · Gas E -105 -98 0', () => {
    const m = view.MINUS
    assert.deepEqual(opened(w, 'leftOver', { plans }), {
      row: ['Left over', '438', '551', '35.1%', `${m}105`, `${m}5.8 pts`, '●'],
      under: [
        ['Everyday', `${m}1,106`, `${m}1,020`, '64.9%', `${m}70`],
        ['Levers', 'Dining Out over target 78/mo +5.0 pts · Coffee over target 32/mo +2.0 pts'],
        ['switch categories'],
        ['Dining Out', 'L', `${m}520`, `${m}478`, `${m}70`, `target ${m}400`],
        ['Groceries', 'E', `${m}330`, `${m}312`, '0', null],
        ['Coffee', 'L', `${m}151`, `${m}132`, '0', `target ${m}100`],
        // The coffee habit under Coffee: about 3 a month at home over August to October, 132.00 a month, as data.
        ['  Coffee out', '', '', '', '', 'about 3 times a month · 132/mo'],
        ['Gas & Fuel', 'E', `${m}105`, `${m}98`, '0', null]
      ]
    })
    // Categories sum to Everyday to the cent: 520.40 + 330.00 + 151.00 + 105.00 = 1,106.40, and 478 + 312 + 132 + 98 = 1,020.
    const everyday = w.rows.find((r) => r.id === 'everyday')!
    assert.deepEqual(
      everyday.parts.map((p) => [p.actualCents, p.runRateCents, p.changeCents]),
      [
        [52_040, 47_800, 7_000],
        [33_000, 31_200, 0],
        [15_100, 13_200, 0],
        [10_500, 9_800, 0]
      ]
    )
    assert.deepEqual([everyday.actualCents, everyday.runRateCents], [110_640, 102_000])
    // The habit opens the nine purchases it was measured from, August to October: 108.00 + 137.00 + 151.00.
    const coffee = view.homeTable(w, 'leftOver', new Map(), { plans }).lines.find((l): l is PartLine => l.kind === 'part' && l.key === 'habit:coffee')!
    const got = listed(coffee.drill!)
    assert.deepEqual([got.keys.length, got.cents], [9, -39_600])
    assert.equal(coffee.drill!.name, 'Left over · Coffee out')
    leftOverTies(w, 'October')
  })

  test("Left over's Payees: the parked merchants card's data from the classifier's Everyday lines, each payee opening exactly its lines", () => {
    const m = view.MINUS
    assert.deepEqual(opened(w, 'leftOver', { plans, leftOverView: 'payees' }).under.slice(2), [
      ['switch payees'],
      ['Corner Bistro', '', `${m}520`, '', '', null],
      ['Freshway Market', '', `${m}330`, '', '', null],
      ['Daily Grind', '', `${m}151`, '', '', null],
      ['Shell', '', `${m}105`, '', '', null]
    ])
    assert.deepEqual(
      w.payees.map((x) => [x.key, x.name, x.cents, x.count]),
      [
        ['corner bistro', 'Corner Bistro', 52_040, 2],
        ['freshway market', 'Freshway Market', 33_000, 2],
        ['daily grind', 'Daily Grind', 15_100, 3],
        ['shell', 'Shell', 10_500, 2]
      ]
    )
    // Gas's two lines, -59.00 and -46.00, as the Gas & Fuel category opens them.
    const shell = view.homeTable(w, 'leftOver', new Map(), { leftOverView: 'payees' }).lines.find((l): l is PartLine => l.kind === 'part' && l.name === 'Shell')!
    assert.deepEqual(shell.drill, { month: '2026-10', toMonth: '2026-10', cls: ['everyday'], owner: null, payees: ['shell'], name: 'Everyday · Shell' })
    assert.deepEqual(listed(shell.drill!).cents, -10_500)
    // The categories' parts aren't drawn here, so a changed month's lines for them stay under Everyday.
    assert.ok(!view.homeTable(w, 'leftOver', new Map(), { leftOverView: 'payees' }).lines.some((l) => l.kind === 'part' && l.key.startsWith('cat:')))
  })

  test('SAVED OPEN: One-offs -640 -250 45.4% -15, Kept -202 301, Saved at work 600 600, Employer saving 288, Went to, Reconciling, Goals and the next debt', () => {
    const m = view.MINUS
    assert.deepEqual(opened(w, 'saved', { plans }), {
      row: ['Saved', '686', '1,189', '18.9%', `${m}120`, `${m}1.9 pts`, ''],
      under: [
        ['One-offs', `${m}640`, `${m}250`, '45.4%', `${m}15`],
        ['Items', 'One-off Goods 23 640'],
        // Kept's change over 3 months is shown with it: -119.50 (section 5 draws Kept with none, Saved's -120 beside it).
        ['Kept', '', `${m}202`, '301', `${m}120`, null],
        ['Saved at work', '', '600', '600', '0', null],
        ['Employer saving', '', '288', '288', '0', null],
        ['Went to', `Savings 300 · Investments 500 · Debt paid down 1,233 · Checking ${m}1,974`],
        ['Reconciling', `Ventures +220 · Cash return +57 · Unsorted ${m}16 · Unexplained 0 ✓`],
        ['Goals', 'Emergency 18,400 of 25,000 · Norway 2027 1,200 of 4,000'],
        ['Debt', 'next Visa 24.0% · 3,000']
      ]
    })
    // The debt line opens Net worth's Debts; the one-off item its own line.
    const lines = view.homeTable(w, 'saved', new Map(), { plans }).lines
    assert.deepEqual(lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'debt')!.net, { view: 'debts', label: 'Debts' })
    const item = lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'oneOffItems')!.items![0]
    assert.deepEqual(listed(item.drill!).cents, -64_000)
    assert.deepEqual(w.oneOffs, { items: [{ txnId: w.oneOffs.items[0].txnId, day: '2026-10-18', name: 'One-off Goods 23', categoryId: db.listCategories().find((c) => c.name === 'Shopping')!.id, cents: 64_000, trip: null }], count: 1, trips: [] })
    // The plans as Review keeps them: no one-off budget, the goals as goals.ts shows them, and the plan's first target.
    assert.deepEqual(
      [plans.oneOffTargetCents, plans.goals.map((g) => [g.name, g.savedCents, g.targetCents]), plans.nextDebt && [plans.nextDebt.name, plans.nextDebt.aprBp, plans.nextDebt.owedCents]],
      [
        null,
        [
          ['Emergency', 1_840_000, 2_500_000],
          ['Norway 2027', 120_000, 400_000]
        ],
        ['Visa', 2_400, 300_000]
      ]
    )
    savedTies(w, 'October')
  })

  test("the debt plan's inputs (spec 1.6): Take-home 3,777.00, spending 832.50 + 380.00 + 1,020.00 + 250.00, and every Personal debt with its payment", () => {
    const d = getDebts()
    assert.deepEqual([d.takeHomeCents, d.incomeSources], [377_700, [{ name: 'Brightline Payroll', monthlyCents: 377_700 }]])
    // Committed in force is 2,206.50, of which the debts charge 994.00 in interest (Pinecrest's 800.00, Visa's 60.00,
    // Civic's 48.00 and the student loan's 86.00) and Pinecrest holds 380.00 in escrow: 832.50 is the bills, and the
    // escrow is spending too, as it pays the house's taxes and insurance. Then Everyday's 1,020.00 and One-offs' 250.00.
    assert.equal(d.spendCents, 83_250 + 38_000 + 102_000 + 25_000)
    // October's spending: the bills 860.50 (HOA 232.00, utilities 318.00, insurance 210.00, subscriptions 100.50),
    // Pinecrest's escrow 380.00, Everyday 1,106.40 and One-offs 640.00.
    assert.deepEqual(d.spendMonths.at(-1), { month: '2026-10', cents: 86_050 + 38_000 + 110_640 + 64_000 })
    assert.equal(d.spendMonths.length, 12)
    assert.deepEqual([d.spendLowCents, d.spendHighCents], [Math.min(...d.spendMonths.map((x) => x.cents)), Math.max(...d.spendMonths.map((x) => x.cents))])
    // The mortgage is among the debts, each loan's minimum its latest payment less its escrow (Pinecrest's 1,985.00 is
    // principal 805.00, interest 800.00 and escrow 380.00); the Visa's the card's usual minimum.
    assert.deepEqual(
      d.debts.map((x) => [x.name, x.kind, x.balanceCents, x.apr, x.minPaymentCents]).sort(),
      [
        ['Civic Auto Loan', 'loan', 863_600, 6.4, 41_200],
        ['Pinecrest Mortgage', 'loan', 29_919_500, 3.75, 160_500],
        ['Student Loan', 'loan', 2_378_600, 4.3, 30_000],
        ['Visa', 'card', 300_000, 24, null]
      ]
    )
    assert.equal(d.strategy, 'avalanche')
    // The plan's first month takes Pinecrest down by its principal alone: 299,195.00 + 934.98 interest - 1,605.00.
    const plan = simulate(
      d.debts.map((x) => ({ ...x, apr: x.apr ?? 0 })),
      d.takeHomeCents - d.spendCents,
      d.strategy,
      '2026-12'
    )
    assert.equal(plan.months[0].balances[d.debts.findIndex((x) => x.name === 'Pinecrest Mortgage')], 29_919_500 + 93_498 - 160_500)
  })
})

describe("section 5's DEPOSITS ONLY: the same household with no paystub and no elections", () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household({ paystubs: false })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('Left over 438 551 35.1% ● -105 with the same categories; Saved -202 301 8.0% -120, nothing saved at work', () => {
    const w = month('2026-10')
    const plans = homePlans()
    const m = view.MINUS
    const left = opened(w, 'leftOver', { plans })
    assert.deepEqual(left.row, ['Left over', '438', '551', '35.1%', `${m}105`, `${m}5.8 pts`, '●'])
    assert.deepEqual(
      left.under.filter((l) => l.length === 6 && !String(l[0]).startsWith(' ')).map((l) => l.slice(0, 5)),
      [
        ['Dining Out', 'L', `${m}520`, `${m}478`, `${m}70`],
        ['Groceries', 'E', `${m}330`, `${m}312`, '0'],
        ['Coffee', 'L', `${m}151`, `${m}132`, '0'],
        ['Gas & Fuel', 'E', `${m}105`, `${m}98`, '0']
      ]
    )
    // Saved's base is Gross pay, which is Take-home here, plus no employer saving: 300.50 / 3,777.00 = 8.0%.
    const saved = opened(w, 'saved', { plans })
    assert.equal(saved.row.slice(0, 5).join(' '), `Saved ${m}202 301 8.0% ${m}120`)
    assert.deepEqual(saved.under.slice(0, 5), [
      ['One-offs', `${m}640`, `${m}250`, '45.4%', `${m}15`],
      ['Items', 'One-off Goods 23 640'],
      ['Kept', '', `${m}202`, '301', `${m}120`, null],
      ['Saved at work', '', '0', '0', '0', null],
      ['Employer saving', '', '0', '0', '0', null]
    ])
    assert.deepEqual(saved.under.slice(-2), [
      ['Goals', 'Emergency 18,400 of 25,000 · Norway 2027 1,200 of 4,000'],
      ['Debt', 'next Visa 24.0% · 3,000']
    ])
    leftOverTies(w, 'deposits only')
    savedTies(w, 'deposits only')
    // The debt plan's take-home is the deposits' run rate, the same 3,777.00.
    assert.equal(getDebts().takeHomeCents, 377_700)
  })
})

describe("the open month, a trip and a target with rollover on the household", () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the open month: the Month column is Everyday to date, and the drill shows the pace, scaled for the days away', () => {
    household()
    // November to the 7th: coffee 35.00 on the 1st and groceries 70.00 on the 2nd, then away on the 4th and 5th.
    line(ACCOUNTS.visa, '2026-11-01', -3_500, 'DAILY GRIND CAFE', 'Coffee', 'Daily Grind')
    line(ACCOUNTS.visa, '2026-11-02', -7_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    saveTrip({ name: 'Harbor weekend', from: '2026-11-04', to: '2026-11-05' })
    const w = month('2026-11')
    const everyday = w.rows.find((r) => r.id === 'everyday')!
    // 105.00 to date over the 5 of 7 days at home so far, for the 28 days at home of November's 30.
    assert.deepEqual([everyday.actualCents, everyday.paceCents], [10_500, 58_800])
    // The run rate is October's, the last full month's, and its change is from August's: 1,020.00 less 933.87.
    const left = opened(w, 'leftOver')
    assert.deepEqual(left.under.slice(0, 2), [
      ['Everyday', `${view.MINUS}105`, `${view.MINUS}1,020`, '64.9%', `${view.MINUS}86`],
      ['Pace', `${view.MINUS}588`]
    ])
    // A closed month has no pace.
    assert.ok(!opened(month('2026-10'), 'leftOver').under.some((l) => l[0] === 'Pace'))
    leftOverTies(w, 'November')
  })

  test("Saved's trips: the one-offs bought on a trip, as their own line, opening exactly them", () => {
    household()
    // Away October 10 to 12: the coffee of the 11th is bought on the trip, a one-off; the power bill of the 12th is a bill.
    saveTrip({ name: 'Lisbon', from: '2026-10-10', to: '2026-10-12' })
    const w = month('2026-10')
    assert.deepEqual(
      w.oneOffs.trips.map((t) => [t.name, t.fromDay, t.toDay, t.cents, t.ids.length]),
      [['Lisbon', '2026-10-10', '2026-10-12', 5_000, 1]]
    )
    // One-offs' run rate takes the coffee too, 250.00 + 50.00 / 12; Everyday's three days fewer at home scale it up, so
    // Left over is 533.09 and One-offs 47.7% of it.
    const lines = opened(w, 'saved').under
    assert.deepEqual(lines.slice(0, 3), [
      ['One-offs', `${view.MINUS}690`, `${view.MINUS}254`, '47.7%', `${view.MINUS}19`],
      ['Items', 'One-off Goods 23 640 · Daily Grind 50'],
      ['Trips', 'Lisbon 50']
    ])
    assert.equal(w.oneOffs.items[1].trip, 'Lisbon')
    savedTies(w, 'a trip')
  })

  test("Saved's trips: one not over yet comes after the span's, as Budget's trip list had it, beside the run rate's spans", () => {
    household()
    saveTrip({ name: 'Lisbon', from: '2026-10-10', to: '2026-10-12' })
    // A trip's id is the clock's: a second later, so the two are two trips.
    mock.timers.tick(1000)
    saveTrip({ name: 'Iceland', from: '2027-02-11', to: '2027-02-19' })
    const plans = homePlans()
    assert.deepEqual(plans.trips, [{ name: 'Iceland', fromDay: '2027-02-11', toDay: '2027-02-19', spentCents: 0 }])
    const trips = (s: { from: string; to: string }): string | undefined => view.homeTable(getWaterfall(s), 'saved', new Map(), { plans }).lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'trips')?.text
    assert.equal(trips({ from: '2026-10', to: '2026-10' }), 'Lisbon 50 · Iceland Feb 11–Feb 19')
    assert.equal(trips({ from: '2026-11', to: '2026-11' }), 'Iceland Feb 11–Feb 19')
    // A span that ended before the run rate's window has the trips it had alone.
    assert.equal(trips({ from: '2026-04', to: '2026-04' }), undefined)
    // The trip ahead opens nothing: nothing's bought on it yet.
    const line = view.homeTable(month('2026-11'), 'saved', new Map(), { plans }).lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'trips')!
    assert.deepEqual(line.items, [{ text: 'Iceland Feb 11–Feb 19' }])
  })

  test("a house put in a venture takes its mortgage with it: the plan's debts are Personal's, as the classifier owns them", () => {
    const h = household()
    // The Assets page sets the house's bucket alone; the mortgage linked to it is the venture's from then on, and
    // October's 1,985.00 from checking is money to the venture, with no principal or interest of Personal's.
    db.updateAccount(h.house, { bucketId: h.venture })
    const october = ledgerLines('2026-10-01', '2026-10-31')
    assert.ok(!october.some((l) => l.debtId === h.mortgage))
    assert.deepEqual(
      october.filter((l) => l.cls === 'venture' && l.cents === -198_500).map((l) => l.owner),
      [null]
    )
    assert.deepEqual(
      getDebts()
        .debts.map((d) => d.name)
        .sort(),
      ['Civic Auto Loan', 'Student Loan', 'Visa']
    )
    assert.equal(homePlans().nextDebt?.name, 'Visa')
    // Its house back in Personal, the mortgage is Personal's again.
    db.updateAccount(h.house, { bucketId: null })
    assert.ok(getDebts().debts.some((d) => d.id === h.mortgage))
  })

  test("the next debt shows the rate the plan ranks it by: a card's intro rate while it lasts, and when it ends", () => {
    household()
    // At 0% to June 2027 the Visa waits behind the Civic's 6.4%.
    db.updateAccount(ACCOUNTS.visa, { promoApr: 0, promoEnds: '2027-06-01' })
    assert.deepEqual(homePlans().nextDebt && [homePlans().nextDebt!.name, homePlans().nextDebt!.aprBp, homePlans().nextDebt!.promoEnds], ['Civic Auto Loan', 640, null])
    // At 9.99% to then it comes first, at the rate it charges, not its 24.0% on file.
    db.updateAccount(ACCOUNTS.visa, { promoApr: 9.99 })
    const plans = homePlans()
    assert.deepEqual(plans.nextDebt && [plans.nextDebt.name, plans.nextDebt.aprBp, plans.nextDebt.promoEnds], ['Visa', 999, '2027-06-01'])
    const debt = view.homeTable(month('2026-10'), 'saved', new Map(), { plans }).lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'debt')!
    assert.equal(debt.text, 'next Visa 9.99% to Jun 2027 · 3,000')
  })

  test('a target with rollover on shows what carried into this month beside this month; the one-off budget and its commitment under One-offs', () => {
    household()
    const m = view.MINUS
    // Coffee's 100.00 rolls over from October, when it was the target too: October's 151.00 overspent it by 51.00.
    const coffee = db.listCategories().find((c) => c.name === 'Coffee')!.id
    db.setRollover(coffee, true)
    db.run("UPDATE budget_rollover SET from_month = '2026-10' WHERE category_id = ?", coffee)
    db.run("INSERT OR REPLACE INTO budget_targets (category_id, month, cents) VALUES (?, '2026-10', 10000)", coffee)
    // Review commits One-offs to about half of their 250.00 average, to the nearest 50.00: the one-off budget is 150.00.
    commitHabit(TODAY.slice(0, 7), 'oneoffs', 'cap50')
    const plans = homePlans()
    assert.equal(plans.month, '2026-11')
    assert.deepEqual(
      plans.targets.find((x) => x.categoryId === coffee),
      { categoryId: coffee, targetCents: 10_000, rollover: { carriedCents: -5_100, availableCents: 4_900 } }
    )
    // The 51.00 carried into November, beside November's Coffee; October's shows its target alone.
    const coffeeIn = (s: { from: string; to: string }): PartLine => view.homeTable(getWaterfall(s), 'leftOver', new Map(), { plans }).lines.find((l): l is PartLine => l.kind === 'part' && l.name === 'Coffee')!
    assert.equal(coffeeIn({ from: '2026-11', to: '2026-11' }).note, `target ${m}100 · rollover ${m}51`)
    assert.equal(coffeeIn({ from: '2026-01', to: '2026-11' }).note, `target ${m}100 · rollover ${m}51`)
    assert.equal(coffeeIn({ from: '2026-10', to: '2026-10' }).note, `target ${m}100`)
    assert.equal(coffeeIn({ from: '2026-04', to: '2026-04' }).note, `target ${m}100`)
    const w = month('2026-10')
    const saved = opened(w, 'saved', { plans }).under
    assert.equal(plans.oneOffTargetCents, 15_000)
    assert.deepEqual(saved.slice(1, 4), [
      ['Items', 'One-off Goods 23 640'],
      // The budget in the items' sign: Saved's data lines read their money as it is, a cost as spent.
      ['Target', '150'],
      // Under One-offs, the commitment and how this month is going, as the budget counts it: the Visa's feed is a few
      // days behind, so a month's cap is unknown until it catches up. The row above has One-offs' run rate; the
      // budget's own six-month average isn't another figure beside it, and the line opens nothing of its own.
      ['  One-offs', '', '', '', '', 'Keep one-offs under $150 a month: $0 of $120, waiting on Visa']
    ])
    const commitment = view.homeTable(w, 'saved', new Map(), { plans }).lines.find((l): l is PartLine => l.kind === 'part' && l.key === 'habit:oneoffs')!
    assert.equal(commitment.drill, null)
  })

  test("habits are the run rate's: under their category while the span's run rate is the last full month's, their monthly cost as data, not a column", () => {
    household()
    const plans = homePlans()
    const habits = (s: { from: string; to: string }): Array<[string, string, string | null]> =>
      view
        .homeTable(getWaterfall(s), 'leftOver', new Map(), { plans })
        .lines.filter((l): l is PartLine => l.kind === 'part' && l.nested)
        .map((l) => [l.name, l.runRate, l.note])
    // Measured over August to October, the run-rate window of October and of November so far: about 3 a month, 132.00.
    const coffee: Array<[string, string, string | null]> = [['Coffee out', '', 'about 3 times a month · 132/mo']]
    for (const s of [
      { from: '2026-10', to: '2026-10' },
      { from: '2026-11', to: '2026-11' },
      { from: '2026-01', to: '2026-11' },
      { from: '2025-11', to: '2026-10' }
    ])
      assert.deepEqual(habits(s), coffee, `${s.from}..${s.to}`)
    // A span whose run rate is an earlier window's shows none: April's coffee isn't what August to October measured.
    for (const s of [
      { from: '2026-04', to: '2026-04' },
      { from: '2026-04', to: '2026-06' },
      { from: '2026-09', to: '2026-09' }
    ])
      assert.deepEqual(habits(s), [], `${s.from}..${s.to}`)
  })

  test("a commitment whose habit is no longer measured stays under its own category, opening nothing, and never under One-offs", () => {
    household()
    const coffee = db.listCategories().find((c) => c.name === 'Coffee')!.id
    commitHabit(TODAY.slice(0, 7), 'coffee', 'home')
    // August to October's coffee but the first recategorized as Groceries: one purchase in three months is no habit,
    // though Coffee still has a run rate in October.
    const groceries = db.listCategories().find((c) => c.name === 'Groceries')!.id
    const since = db.dayStart('2026-08-01')
    db.run('UPDATE transactions SET category_id = ? WHERE category_id = ? AND posted >= ? AND id <> (SELECT id FROM transactions WHERE category_id = ? AND posted >= ? ORDER BY posted, id LIMIT 1)', groceries, coffee, since, coffee, since)
    const plans = homePlans()
    const habit = plans.habits.find((h) => h.id === 'coffee')!
    assert.deepEqual([habit.kind, habit.categoryId, habit.commitment, habit.drill], ['coffee', coffee, 'Brew coffee at home', null])
    const w = month('2026-10')
    const lines = view.homeTable(w, 'leftOver', new Map(), { plans }).lines
    const at = lines.findIndex((l) => l.kind === 'part' && l.name === 'Coffee')
    const line = lines[at + 1] as PartLine
    assert.deepEqual([line.kind, line.name, line.drill], ['part', 'Coffee out', null])
    assert.ok(!view.homeTable(w, 'saved', new Map(), { plans }).lines.some((l) => l.kind === 'part' && l.key === 'habit:coffee'))
    // With no coffee at all in the budget's six months, the commitment keeps Coffee as its category, never One-offs'.
    db.run('UPDATE transactions SET category_id = ? WHERE category_id = ?', groceries, coffee)
    const none = homePlans()
    assert.equal(none.habits.find((h) => h.id === 'coffee')!.categoryId, coffee)
    assert.ok(!view.homeTable(month('2026-10'), 'saved', new Map(), { plans: none }).lines.some((l) => l.kind === 'part' && l.key === 'habit:coffee'))
  })
})

describe('every drill sums to its row and opens exactly its lines: the household, the sample household and the tie-out, by month and over spans', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /**
   * Each month from one to another, and the year to date, twelve months, a custom span ending at a month, every month
   * from the first to today's (All), and thirty days.
   */
  const spans = (first: string, last: string, today: string): Array<{ from: string; to: string }> => {
    const out: Array<{ from: string; to: string }> = []
    for (let m = first; m <= last; m = shiftMonth(m, 1)) out.push({ from: m, to: m })
    const at = last.slice(0, 4)
    out.push({ from: `${at}-01`, to: last }, { from: shiftMonth(last, -11), to: last }, { from: shiftMonth(last, -7), to: shiftMonth(last, -3) }, { from: first, to: today.slice(0, 7) })
    const back = new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10)
    out.push({ from: back, to: today })
    return out
  }

  test("section 5's household, each of its 25 months and five spans", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    for (const s of spans('2024-11', '2026-11', TODAY)) {
      const w = getWaterfall(s)
      leftOverTies(w, `household ${s.from}..${s.to}`)
      savedTies(w, `household ${s.from}..${s.to}`)
    }
  })

  test('the section 2 tie-out, each month and the spans', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
    for (const s of spans(TIE_MONTHS[0], TIE_MONTHS.at(-1)!, TODAY)) {
      const w = getWaterfall(s)
      leftOverTies(w, `tie-out ${s.from}..${s.to}`)
      savedTies(w, `tie-out ${s.from}..${s.to}`)
    }
  })

  test('the sample household, every month and the spans', () => {
    db.openDb(':memory:')
    loadDemoData()
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    const current = db.today().slice(0, 7)
    for (const s of spans(first, current, db.today())) {
      const w = getWaterfall(s)
      leftOverTies(w, `demo ${s.from}..${s.to}`)
      savedTies(w, `demo ${s.from}..${s.to}`)
    }
  })
})

describe("the debt plan's inputs on the sample household (spec 2c's test)", () => {
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
  })
  after(db.closeDb)

  test('getDebts uses the Take-home run rate, includes the Pinecrest mortgage and leaves out Harbor Bank Interest', () => {
    const d = getDebts()
    const current = db.today().slice(0, 7)
    const w = month(current)
    const rate = (id: StageId): number => w.rows.find((r) => r.id === id)!.runRateCents!
    assert.equal(d.takeHomeCents, rate('takeHome'))
    assert.equal(d.takeHomeCents, runRates(current).rows.takeHome)
    assert.equal(d.incomeSources.reduce((s, x) => s + x.monthlyCents, 0), d.takeHomeCents)
    // The savings account's interest is Growth's Cash return, not take-home.
    assert.ok(!d.incomeSources.some((s) => /harbor bank/i.test(s.name)), d.incomeSources.map((s) => s.name).join(', '))
    const pinecrest = d.debts.find((x) => x.name === 'Pinecrest Mortgage')
    assert.deepEqual(pinecrest && [pinecrest.kind, pinecrest.apr, pinecrest.minPaymentCents], ['loan', 6.125, 198_500])
    assert.ok(pinecrest!.balanceCents > 0)
    // The rental's mortgage is the venture's: no Bayview debt.
    assert.ok(!d.debts.some((x) => /bayview|condo/i.test(x.name)), d.debts.map((x) => x.name).join(', '))
    // Spending: Committed in force without the debts' interest, escrow and card interest, plus Everyday and One-offs.
    const series = w.rows.find((r) => r.id === 'committed')!.parts.filter((p) => p.key.startsWith('series:')).reduce((s, p) => s + p.runRateCents!, 0)
    assert.equal(d.spendCents, series + rate('everyday') + rate('oneOffs'))
    // The next target is the highest rate in force: the Mastercard's intro 0% waits, so the Visa at 24.99%.
    const plans = homePlans()
    assert.deepEqual(plans.nextDebt && [plans.nextDebt.name, plans.nextDebt.aprBp], [d.debts.find((x) => x.apr === 24.99)!.name, 2_499])
    // The Debts page lists the same debts, cards then loans, each by what it owes; the plan's order is by rate.
    const sheet = getBalanceSheet()
    const listed = sheet.groups.filter((g) => g.id === 'cards' || g.id === 'loans').flatMap((g) => g.accounts.filter((x) => Math.abs(x.cents) >= 1).map((x) => x.account.id))
    assert.ok(d.debts.every((x) => listed.includes(x.id)), 'every planned debt is on the Debts page')
    assert.ok(listed.includes(plans.nextDebt!.id))
  })

  test('the headline and the Debts page read the same inputs: the plan runs on them', async () => {
    const r = await answer('getDebts', [], web())
    assert.ok(r.ok)
    assert.deepEqual(r.data, getDebts())
    assert.equal(methodKind('getHomePlans'), 'hosted')
    const plans = await answer('getHomePlans', [], web())
    assert.ok(plans.ok)
    assert.deepEqual(plans.data, homePlans())
    // Goals come with the plan that has them, as listGoals does.
    assert.ok((plans.data as HomePlans).goals.length > 0)
    const free = await answer('getHomePlans', [], web('free'))
    assert.ok(free.ok)
    assert.deepEqual((free.data as HomePlans).goals, [])
    assert.deepEqual(await answer('listGoals', [], web('free')), { ok: false, error: 'plan', feature: 'netWorth' })
  })
})

describe('Left over and Saved on Home', () => {
  let w: Waterfall
  let plans: HomePlans
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    w = month('2026-10')
    plans = homePlans()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the rows render the tag, the Categories | Payees switch and the link to Debts, with no buttons for what Review does', () => {
    const nets: string[] = []
    const left = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(w, 'leftOver', new Map(), { plans }), onOpen: () => {}, onDrill: () => {} }))
    // The tag in its own place at the name's right edge, read out as its tier; the target after the figures, as
    // section 5 draws it, and under the name in a narrow window.
    assert.match(left, /<span class="part-name"><button class="row-name" title="Dining Out">Dining Out<\/button><abbr class="part-tag" title="Lifestyle">L<\/abbr><\/span><span class="part-note beside">target −400<\/span><\/th>/)
    assert.match(left, /<td class="num">−70<\/td><td class="spark-col"><span class="part-beside">target −400<\/span><\/td>/)
    assert.match(left, /<div class="segmented" role="group" aria-label="Everyday by"><button class="active" aria-pressed="true">Categories<\/button><button class="" aria-pressed="false">Payees<\/button><\/div>/)
    // A habit has no figures of its own: its data runs across their columns, not in them.
    assert.match(left, /<tr class="part drill nested"><th scope="row" class="name"><span class="part-name"><button class="row-name" title="Coffee out">Coffee out<\/button><\/span><span class="part-note beside">about 3 times a month · 132\/mo<\/span><\/th><td col[sS]pan="5" class="beside-span"><span class="part-beside">about 3 times a month · 132\/mo<\/span><\/td><\/tr>/)
    const saved = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(w, 'saved', new Map(), { plans }), onOpen: () => {}, onDrill: () => {}, onNet: (v: string) => nets.push(v) }))
    assert.match(saved, /<span class="label-muted">Debt<\/span><span class="data-text">next Visa 24\.0% · 3,000<button class="link small data-to">› Debts<\/button><\/span>/)
    assert.match(saved, /<span class="label-muted">Goals<\/span><span class="data-text">Emergency 18,400 of 25,000 · Norway 2027 1,200 of 4,000<\/span>/)
    assert.match(saved, /<span class="label-muted">Items<\/span><span class="data-text"><button class="link-quiet">One-off Goods 23 640<\/button><\/span>/)
    // Data only: no form, no Add or Edit; targets, habits, goals and debts are Review's.
    for (const html of [left, saved]) assert.doesNotMatch(html, /<input|<select|<form|>Add |>Edit |>Set /)
    // Home opens Net worth's Debts through the app's goNet, as the sidebar does.
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.match(home, /onNet=\{goNet\}/)
    assert.match(home, /onLeftOverView=\{setLeftOverView\}/)
    assert.match(source('src/renderer/src/App.tsx'), /const goNet = useCallback\(\s*\(v: NetView\) => \{\s*if \(v === 'debts'\) focusPayoff\(\)\s*setOpenGroup\(groupOf\('networth'\)\?\.id \?\? null\)\s*pickNet\(v\)/)
    // The page a drill or the Debts link opens starts at its top, not at Home's scroll: its filter and heading in view.
    assert.match(source('src/renderer/src/App.tsx'), /useLayoutEffect\(\(\) => \{\s*mainRef\.current\?\.scrollTo\?\.\(0, 0\)\s*\}, \[page, netView, netPicks, opened\]\)/)
    assert.match(source('src/renderer/src/App.tsx'), /<main className="main" ref=\{mainRef\}>/)
    // Back from a drill's Transactions list, Left over's view is as it was left, for the window's life only.
    assert.match(home, /useState<LeftOverView>\(leftOverKept\.view\)/)
    assert.doesNotMatch(home, /localStorage\.setItem\([^)]*left/i)
  })

  test("switching Categories and Payees, or the span, asks for nothing more: the categories, payees and one-offs are the waterfall's, the plans one call a data change", () => {
    // Both views from the one waterfall and the one plans answer, laid out with no call.
    const categories = view.homeTable(w, 'leftOver', new Map(), { plans, leftOverView: 'categories' })
    const payees = view.homeTable(w, 'leftOver', new Map(), { plans, leftOverView: 'payees' })
    assert.ok(categories.lines.some((l) => l.kind === 'part' && l.key.startsWith('cat:')))
    assert.ok(payees.lines.some((l) => l.kind === 'part' && l.key.startsWith('payee:')))
    const home = source('src/renderer/src/pages/Home.tsx')
    // The plans aren't asked again with the span: their effect reads the open row and the data change alone.
    assert.match(home, /\}, \[wantPlans, tick, toast\]\)/)
    assert.doesNotMatch(source('src/renderer/src/pages/homeView.ts'), /\bapi\./)
  })

  test('a vendor the user hides is never named among the payees or the one-offs, and its money stays in', () => {
    setHiddenVendors(['Daily Grind', 'One-off Goods 23'])
    try {
      const hidden = month('2026-10')
      assert.deepEqual(
        hidden.payees.map((x) => [x.name, x.cents]),
        [
          ['Corner Bistro', 52_040],
          ['Freshway Market', 33_000],
          [null, 15_100],
          ['Shell', 10_500]
        ]
      )
      // The named payees one by one, the hidden one in the rest's line, which opens its lines.
      const lines = view.homeTable(hidden, 'leftOver', new Map(), { leftOverView: 'payees' }).lines.filter((l): l is PartLine => l.kind === 'part')
      assert.deepEqual(
        lines.map((l) => [l.name, l.amount]),
        [
          ['Corner Bistro', `${view.MINUS}520`],
          ['Freshway Market', `${view.MINUS}330`],
          ['Shell', `${view.MINUS}105`],
          ['1 more', `${view.MINUS}151`]
        ]
      )
      assert.equal(listed(lines[3].drill!).cents, -15_100)
      // The one-off is unnamed, and Items opens all of One-offs instead.
      assert.deepEqual(hidden.oneOffs.items.map((i) => [i.name, i.cents]), [[null, 64_000]])
      const items = view.homeTable(hidden, 'saved').lines.find((l): l is DataLine => l.kind === 'data' && l.key === 'oneOffItems')!
      assert.equal(items.text, 'All 1')
      assert.equal(listed(items.items![0].drill!).cents, -64_000)
      leftOverTies(hidden, 'hidden vendors')
      savedTies(hidden, 'hidden vendors')
    } finally {
      setHiddenVendors([])
    }
  })

  test('the Categories | Payees switch shows only with something to switch between', () => {
    // October 2024, before the household's books: no Everyday category, run rate or payee.
    const before = month('2024-10')
    assert.deepEqual([before.rows.find((r) => r.id === 'everyday')?.parts.length ?? 0, before.payees.length], [0, 0])
    for (const leftOverView of ['categories', 'payees'] as const) assert.ok(!view.homeTable(before, 'leftOver', new Map(), { leftOverView }).lines.some((l) => l.kind === 'switch'), leftOverView)
    // November has no purchase yet, but its categories have their run rates: the switch stays, so Categories can be
    // had back from an empty Payees.
    const november = month('2026-11')
    assert.equal(november.payees.length, 0)
    assert.ok(view.homeTable(november, 'leftOver', new Map(), { leftOverView: 'payees' }).lines.some((l) => l.kind === 'switch'))
  })

  test("a payee with no merchant is named by its bank description, as Transactions names it, cut short to the name's column", () => {
    const raw = 'PURCHASE AUTHORIZED ON 10/20 SQ *HARBORSIDE NOODLE COMPANY 0042 PORTLAND OR REFERENCE ON FILE CARD 4417'
    const id = line(ACCOUNTS.visa, '2026-10-20', -60_000, raw, 'Dining Out')
    try {
      const w = month('2026-10')
      const payee = view.homeTable(w, 'leftOver', new Map(), { leftOverView: 'payees' }).lines.find((l): l is PartLine => l.kind === 'part' && l.name === raw)!
      assert.equal(listed(payee.drill!).cents, -60_000)
      const html = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(w, 'leftOver', new Map(), { leftOverView: 'payees' }), onOpen: () => {}, onDrill: () => {} }))
      assert.ok(html.includes(`<span class="part-name"><button class="row-name" title="${raw}">${raw}</button></span>`))
      // The name's cell never widens the column: the name is cut short with an ellipsis, whole in its title.
      const css = source('src/renderer/src/styles.css')
      assert.match(css, /\.home-rows tr\.part \.name \{\s*max-width: 0;\s*\}/)
      assert.match(css, /\.home-rows \.part-name > :first-child \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*\}/)
      // A narrow window wraps names instead, so a one-word name (Groceries) is never cut.
      assert.match(css, /@container \(max-width: 560px\) \{[\s\S]*?\.home-rows tr\.part \.name \{\s*max-width: none;\s*\}[\s\S]*?\n\}/)
    } finally {
      db.run('DELETE FROM transactions WHERE id = ?', id)
    }
  })

  test("the parked cards' code is gone: categories, merchants and goals live in Left over and Saved, the net worth chart in Net worth's Overview and the debt card's plan on Net worth's Debts (2d)", () => {
    assert.ok(!existsSync(join(root, 'src/renderer/src/pages/Cards.tsx')))
    assert.match(source('src/renderer/src/pages/NetWorthChart.tsx'), /export function NetWorthChart\b/)
    assert.ok(!existsSync(join(root, 'src/renderer/src/pages/DebtCard.tsx')))
    for (const file of ['src/renderer/src/pages/Home.tsx', 'src/renderer/src/pages/HomeRows.tsx']) assert.doesNotMatch(source(file), /CategoryBars|TopMerchants|GoalsCard/, file)
  })
})

describe('Home over a month changed since its close: the categories carry their closed figures', () => {
  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    const h = household()
    await closeDueMonths()
    const r = await answer('updateTransaction', [h.meal, { categoryId: db.listCategories().find((c) => c.name === 'Dining Out')!.id }], web())
    assert.ok(r.ok)
    await checkClosed()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("September's Dining Out shows -548 closed -500 under its own line; the other categories show none", () => {
    const lines = view.homeTable(month('2026-09'), 'leftOver').lines
    const m = view.MINUS
    const at = lines.findIndex((l) => l.kind === 'part' && l.name === 'Dining Out')
    // September's 548.00 against 500.00, its run rate (408.00 + 413.60 + 548.00) / 3 = 456.53 against 440.53, and its
    // change from June's 408.00; a step in from the category, as its own. A category shows no rate, so its closed
    // rate isn't drawn either.
    assert.deepEqual(
      lines.slice(at + 1, at + 5).map((l) => (l.kind === 'closed' ? [l.name, l.now, l.closed, l.change, l.nested] : l.kind === 'part' ? ['part', l.name] : [l.kind])),
      [
        ['Dining Out', `${m}548`, `${m}500`, `${m}48`, true],
        ['Dining Out run rate', `${m}457`, `${m}441`, `${m}16`, true],
        ['Dining Out Δ 3 mo', `${m}49`, `${m}33`, `${m}16`, true],
        ['part', 'Groceries']
      ]
    )
    assert.ok(!lines.some((l) => l.kind === 'closed' && l.name === 'Dining Out rate'))
    const html = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(month('2026-09'), 'leftOver'), onOpen: () => {}, onDrill: () => {} }))
    assert.match(html, /<tr class="closed nested"><th scope="row" class="name">Dining Out run rate<\/th>/)
    // Everyday's own rate is a row's, and stays.
    assert.ok(lines.some((l) => l.kind === 'closed' && l.name === 'Everyday rate' && !l.nested))
    // Everyday's own figures stay under its row, and no other category moved.
    assert.ok(lines.some((l) => l.kind === 'closed' && l.name === 'Everyday' && l.closed === `${m}1,052`))
    assert.ok(!lines.some((l) => l.kind === 'closed' && /^(Groceries|Coffee|Gas)/.test(l.name)))
    // By payee, the categories aren't drawn: Everyday's own lines stand for them, as for a row not open.
    const payees = view.homeTable(month('2026-09'), 'leftOver', new Map(), { leftOverView: 'payees' }).lines
    assert.ok(!payees.some((l) => l.kind === 'closed' && l.name.startsWith('Dining Out')))
    assert.ok(payees.some((l) => l.kind === 'closed' && l.name === 'Everyday run rate'))
  })

  test("October's Dining Out: its closed run rate and change right under it, then its habits", () => {
    const m = view.MINUS
    const dining = db.listCategories().find((c) => c.name === 'Dining Out')!.id
    const plans = homePlans()
    // A meals-out habit under Dining Out, as the budget would measure one.
    const meals: HomePlans['habits'][number] = { id: 'eat_out', kind: 'eat_out', categoryId: dining, name: 'Meals out', often: 'about twice a week', monthlyCents: 30_000, commitment: null, progress: null, drill: null }
    const lines = view.homeTable(month('2026-10'), 'leftOver', new Map(), { plans: { ...plans, habits: [meals, ...plans.habits] } }).lines
    const at = lines.findIndex((l) => l.kind === 'part' && l.name === 'Dining Out')
    assert.deepEqual(
      lines.slice(at + 1, at + 5).map((l) => (l.kind === 'closed' ? [l.name, l.now, l.closed] : l.kind === 'part' ? [l.name, l.note] : [l.kind])),
      [
        ['Dining Out run rate', `${m}494`, `${m}478`],
        ['Dining Out Δ 3 mo', `${m}86`, `${m}70`],
        ['Meals out', 'about twice a week · 300/mo'],
        ['Groceries', null]
      ]
    )
  })
})

describe('the cost of opening Left over or Saved on a large ledger', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("after Home's waterfall: laying either out (under 25 ms), and its one call for the plans (under 200 ms)", async (t) => {
    db.openDb(':memory:')
    largeLedger({ from: '2018-12' })
    const w = month('2026-10')
    const plans = homePlans()
    assert.ok(w.payees.length > 100 && plans.habits.length > 0, `${w.payees.length} payees, ${plans.habits.length} habits`)
    // npm test runs the files at once: each budget is timed against test/cost.ts's reference work in paired rounds,
    // and holds as the median of the rounds' ratios. Laying an open row out reads nothing: the categories, payees and
    // one-offs come in the waterfall, and the targets, habits, goals and next debt in the plans.
    const layout = await paired(6, () =>
      repeatedMs(() => {
        for (const leftOverView of ['categories', 'payees'] as const) view.homeTable(w, 'leftOver', new Map(), { plans, leftOverView })
        view.homeTable(w, 'saved', new Map(), { plans })
      })
    )
    t.diagnostic(within('laying out Left over and Saved', 25, layout))
    assert.ok(layout.ratio <= budgetRatio(25), within('laying out Left over and Saved', 25, layout))
    // The plans, once a data change, after the waterfall Home read for it: the budget's habits and targets, the goals
    // and the debt plan's next target. Each round's write first, then the waterfall, as Home has it open.
    const call = await paired(
      6,
      () => repeatedMs(() => homePlans(), 50),
      (k) => {
        db.setSetting('test.plansRound', String(k))
        month('2026-10')
      }
    )
    // 200 ms, twice its cost: alone it reads a median ratio of 4.75 to 4.85 (about 103 ms) before and after 2d
    // alike, and under the whole suite 5.7 to 7.3, which 150 ms (7.01) failed about one full run in four.
    t.diagnostic(within('the plans after the waterfall', 200, call))
    assert.ok(call.ratio <= budgetRatio(200), within('the plans after the waterfall', 200, call))
  })
})
