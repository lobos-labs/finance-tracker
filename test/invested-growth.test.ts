import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StageId, Waterfall } from '../src/shared/types.ts'
import { shiftMonth } from '../src/shared/zone.ts'
import { budgetRatio, paired, repeatedMs, within } from './cost.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS, household, line, PAYROLL, stub as paystub, TODAY } from './fixtures/waterfall-household.ts'

// Invested's and Growth's drills (waterfall spec sub-phase 2c, part 2). Invested: its parts at work, from the
// employer and from cash, each with its month, run rate and Δ 3 mo, every one of its levers, and the retirement line
// once its settings are set. Growth: its returns by account and by tax treatment, Cash return, the 12-month
// time-weighted return, Revaluation by account, net worth and its bridge, and the links to Investments and Net worth.
// Section 5's household draws every figure its wireframe shows; each drill sums to its row on that household, the
// sample household and the section 2 tie-out, month by month and over spans; the TWR is checked against a figure
// worked out by hand; and the drills are timed on a large ledger.

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

const db = await import('../src/main/db.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { getWaterfall, investedAccounts } = await import('../src/main/waterfall.ts')
const { investedTrack, investments, returnsByTreatment, twrTogether } = await import('../src/main/investments.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { linesFor } = await import('../src/main/lines.ts')
const { checkClosed, closeDueMonths } = await import('../src/main/snapshots.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const { HomeRows } = await import('../src/renderer/src/pages/HomeRows.tsx')
const { accountTrack } = await import('../src/shared/returns.ts')
const { tieOut } = await import('./fixtures/tieout.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')
type HomeLine = import('../src/renderer/src/pages/homeView.ts').HomeLine
type RowLine = import('../src/renderer/src/pages/homeView.ts').RowLine
type Opened = import('../src/renderer/src/pages/homeView.ts').Opened

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const source = (path: string): string => readFileSync(join(root, path), 'utf8')

/**
 * What an open row shows, as homeView lays it out: the row (name, amount, run rate, rate, Δ pts, Δ 3 mo), then under
 * it its parts (name, amount, run rate, Δ 3 mo), its accounts (name, note, amount, run rate), its data lines
 * (label, text) and what moved since a changed month's close (name, now, closed, change).
 */
function opened(w: Waterfall, open: Opened): { row: string[]; under: string[][] } {
  const lines = view.homeTable(w, open).lines
  const at = lines.findIndex((l) => l.kind === 'row' && l.open)
  const head = lines[at] as RowLine
  const under: string[][] = []
  for (const l of lines.slice(at + 1)) {
    if (l.kind === 'row' && !l.less) break
    if (l.kind === 'row') under.push([l.name, l.amount, l.runRate, l.rate, l.change])
    else if (l.kind === 'part') under.push([l.name, l.amount, l.runRate, l.change])
    else if (l.kind === 'account') under.push([l.name, l.note, l.amount, l.runRate])
    else if (l.kind === 'data') under.push([l.label, l.text])
    else if (l.kind === 'closed') under.push([l.name, l.now, l.closed, l.change])
  }
  return { row: [head.name, head.amount, head.runRate, head.rate, head.pts ?? '', head.change], under }
}

const sum = <T>(xs: readonly T[], f: (x: T) => number | null): number => xs.reduce((s, x) => s + (f(x) ?? 0), 0)

/**
 * Each drill sums to its row (spec 1.7): Invested's three parts are Invested in every column, and From cash opens
 * exactly its lines; Growth's accounts and Cash return are Growth over the span and as run rates, the treatments are
 * the accounts, every account is Growth's part for it (or a return of 0), Cash return opens exactly its lines, and
 * Revaluation by account is the bridge's. Home draws an account line for each, in the same order.
 */
function drillsTie(w: Waterfall, label: string): void {
  const row = (id: StageId): Waterfall['rows'][number] => w.rows.find((r) => r.id === id)!
  const invested = row('invested')
  assert.deepEqual(
    invested.parts.map((p) => p.key),
    ['atWork', 'employer', 'fromCash'],
    label
  )
  for (const f of ['actualCents', 'perMonthCents', 'runRateCents', 'changeCents'] as const) {
    if (f === 'perMonthCents' && invested.perMonthCents === null) assert.ok(invested.parts.every((p) => p.perMonthCents === null), `${label} Invested's parts per month`)
    else if (f !== 'perMonthCents') assert.equal(sum(invested.parts, (p) => p[f]), invested[f], `${label} Invested ${f}`)
  }
  const fromCash = invested.parts.find((p) => p.key === 'fromCash')!
  assert.equal(-linesFor(fromCash.drill, { limit: 1000 }).cents || 0, fromCash.actualCents, `${label} From cash's lines`)

  const growth = row('growth')
  const g = w.growth!
  const cash = growth.parts.find((p) => p.key === 'cashReturn')
  assert.equal(sum(g.accounts, (a) => a.actualCents) + (cash?.actualCents ?? 0), growth.actualCents, `${label} Growth's accounts and Cash return`)
  assert.equal(sum(g.accounts, (a) => a.runRateCents) + (cash?.runRateCents ?? 0), growth.runRateCents, `${label} Growth's run rates`)
  for (const f of ['actualCents', 'runRateCents'] as const) assert.equal(sum(g.byTreatment, (t) => t[f]), sum(g.accounts, (a) => a[f]), `${label} by treatment ${f}`)
  for (const t of g.byTreatment) assert.equal(t.actualCents, sum(g.accounts.filter((a) => a.treatment === t.treatment), (a) => a.actualCents), `${label} ${t.treatment}`)
  for (const a of g.accounts) {
    const p = growth.parts.find((x) => x.key === `return:${a.accountId}`)
    assert.deepEqual([a.actualCents ?? 0, a.runRateCents ?? 0], [p?.actualCents ?? 0, p?.runRateCents ?? 0], `${label} ${a.name}`)
    assert.ok(a.actualCents !== null || a.runRateCents !== null || a.unmeasured !== null, `${label} ${a.name} is listed for a figure`)
  }
  for (const p of growth.parts) if (p.key !== 'cashReturn') assert.ok(g.accounts.some((a) => `return:${a.accountId}` === p.key), `${label} ${p.key} is an account`)
  if (cash) assert.equal(linesFor(cash.drill, { limit: 1000 }).cents, cash.actualCents, `${label} Cash return's lines`)
  // Revaluation by asset, and each account's change less what was put in over days its return can't be measured,
  // are the bridge's Revaluation; an invested account is never revalued.
  const unmeasured = sum(g.accounts, (a) => (a.unmeasured ? a.unmeasured.changeCents - a.unmeasured.putInCents : 0))
  assert.equal(sum(g.revaluation, (x) => x.cents) + unmeasured, w.bridge.revaluationCents, `${label} Revaluation by asset`)
  assert.ok(g.revaluation.every((x) => x.cents !== 0 && ['property', 'vehicle', 'other_asset', 'receivable', 'venture'].includes(x.assetType)), `${label} Revaluation lists the assets that moved`)

  // Home draws a line for each account's return, then for each asset's revaluation, in the same order.
  const lines = view.homeTable(w, 'growth').lines
  assert.deepEqual(
    lines.filter((l) => l.kind === 'account').map((l) => l.key),
    [...g.accounts.map((a) => `return:${a.accountId}`), ...g.revaluation.map((x) => `revaluation:${x.accountId}`)],
    `${label} Growth's account lines`
  )
  assert.deepEqual(
    view
      .homeTable(w, 'invested')
      .lines.filter((l) => l.kind === 'part')
      .map((l) => l.key),
    ['atWork', 'employer', 'fromCash'],
    `${label} Invested's part lines`
  )
}

/** Every month from one to another (YYYY-MM), both included. */
function monthsFrom(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m)
  return out
}

/** Each drill sums to its row over every month of the books, and over YTD, 12M, All, a custom span and the last 30 days. */
function everySpanTies(label: string, custom: { from: string; to: string }): void {
  const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
  const current = db.today().slice(0, 7)
  for (const m of monthsFrom(first, current)) drillsTie(month(m), `${label} ${m}`)
  drillsTie(getWaterfall({ from: `${current.slice(0, 4)}-01`, to: current }), `${label} YTD`)
  drillsTie(getWaterfall({ from: shiftMonth(current, -11), to: current }), `${label} 12M`)
  drillsTie(getWaterfall({ from: first, to: current }), `${label} All`)
  drillsTie(getWaterfall(custom), `${label} ${custom.from}..${custom.to}`)
  const today = db.today()
  drillsTie(getWaterfall({ from: new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10), to: today }), `${label} 30D`)
}

describe("section 5's household", () => {
  let h: ReturnType<typeof household>
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    h = household()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("the Invested drill's parts are 600, 288 and 500 in October, and 600, 288 and 250 as run rates", () => {
    const w = month('2026-10')
    const invested = w.rows.find((r) => r.id === 'invested')!
    assert.deepEqual(
      invested.parts.map((p) => [p.key, p.actualCents, p.runRateCents, p.changeCents]),
      [
        ['atWork', 60_000, 60_000, 0],
        ['employer', 28_800, 28_800, 0],
        ['fromCash', 50_000, 25_000, 0]
      ]
    )
    // Invested 1,388.00 against 1,138.00 in force: 1,138 / 1,188.50 of Saved is 95.8%, 8.748 points up on July's 87.0%.
    assert.deepEqual([invested.actualCents, invested.runRateCents, invested.rate, invested.rateChangePts, invested.changeCents], [138_800, 113_800, 95.8, 8.7, 0])
  })

  test('INVESTED OPEN: its parts each with the month, run rate and Δ 3 mo, the 401(k) and HSA room, and the retirement line', () => {
    const w = month('2026-10')
    assert.deepEqual(opened(w, 'invested'), {
      row: ['Invested', '1,388', '1,138', '95.8%', '+8.7 pts', '0'],
      under: [
        ['Saved at work', '600', '600', '0'],
        ['Employer saving', '288', '288', '0'],
        ['From cash', '500', '250', '0'],
        // round(2,450,000 / 12) - 48,000 cents is 1,561.67, and round(440,000 / 12) - 16,800 cents 198.67.
        ['Levers', '401(k) room 1,562/mo · HSA room 199/mo'],
        ['Retire at 65 in 2055', "1,853,239 today's dollars · invested 243,471 · +1,138/mo · 5.0% real"]
      ]
    })
    // n = 65 - (2026 - 1990) = 29; B = 240,000 + 500 + 600 + 288 + 2,083 = 243,471.00; A = 12 × 1,138 = 13,656.00;
    // B × 1.05^29 + A × (1.05^29 - 1) / 0.05 = 1,002,159.65 + 851,078.95 = 1,853,238.60.
    assert.deepEqual(w.retirement, { birthYear: 1990, retireAge: 65, realReturnBp: 500, years: 29, year: 2055, investedCents: 24_347_100, contributionCents: 113_800, projectedCents: 185_323_860 })
    assert.equal(w.levers.filter((l) => l.stage === 'invested').map((l) => l.monthlyCents).join(' '), '156167 19867')
  })

  test('the retirement line is absent until the birth year, the age and the real return are all set', () => {
    for (const key of ['retire.birthYear', 'retire.age', 'retire.realReturnBp']) {
      const was = db.getSetting(key)
      db.setSetting(key, null)
      try {
        assert.equal(month('2026-10').retirement, null, key)
        assert.ok(!opened(month('2026-10'), 'invested').under.some((u) => u[0].startsWith('Retire at')), key)
      } finally {
        db.setSetting(key, was)
      }
    }
    assert.equal(opened(month('2026-10'), 'invested').under.at(-1)![0], 'Retire at 65 in 2055')
  })

  test('with inflation set too, savings above the goals joins the levers line, after the yearly limits', () => {
    db.setSetting('retire.inflationBp', '300')
    try {
      const w = month('2026-10')
      const cash = w.levers.find((l) => l.kind === 'cash_above_goals')!
      assert.equal(cash.name, 'Savings')
      // Every one of Invested's levers, the largest first: Home's line for any other row holds its top two.
      const levers = opened(w, 'invested').under.find((u) => u[0] === 'Levers')!
      assert.equal(levers[1], `401(k) room 1,562/mo · HSA room 199/mo · Savings above goals ${view.dollars(cash.monthlyCents)}/mo`)
      assert.equal(view.leverLine(w.levers, 'invested'), '401(k) room 1,562/mo · HSA room 199/mo')
    } finally {
      db.setSetting('retire.inflationBp', null)
    }
  })

  test('GROWTH OPEN: returns by account and by treatment, Cash return, the 12-month TWR, Revaluation, and net worth with its bridge', () => {
    const w = month('2026-10')
    assert.deepEqual(opened(w, 'growth'), {
      row: ['Growth', '2,140', '1,200', '0.5%', '', ''],
      under: [
        // The wireframe's two lines first, in its order.
        ['Returns', '2,083 · Cash return 57'],
        ['Net worth 412,300', '+2,391 = Saved 686 + Growth 2,140 + Revaluation −130 + Ventures −289 + Unsorted −16 − In transit 0 − Unexplained 0 + Other 0'],
        // Then what 1.7 adds. The brokerage earned 2,083.00 in October and 13,716.00 over the twelve months to it:
        // 1,143 a month. The 401(k) and the HSA take the checks' saving and earn nothing. Each treatment holds one
        // account, so the account lines are the returns by treatment too, and no By treatment line repeats them.
        ['Brokerage', 'Taxable', '2,083', '1,143'],
        ['Brightline 401(k)', 'Pre-tax', '0', '0'],
        ['Brightline HSA', 'HSA', '0', '0'],
        ['TWR 12 mo', '6.2%'],
        ['2017 Civic', 'Revaluation', '−130', ''],
        ['', 'Investments · Net worth']
      ]
    })
    assert.deepEqual(
      w.growth!.byTreatment.map((t) => [t.treatment, t.actualCents]),
      [
        ['pretax', 0],
        ['hsa', 0],
        ['taxable', 208_300]
      ]
    )
    // ΔNW = 685.70 + 2,140.00 - 130.00 + (220.00 - 509.00) - 16.00 - 0 - 0 + 0 = 2,390.70.
    const b = w.bridge
    assert.deepEqual([b.endCents, b.endCents - b.startCents, b.savedCents, b.growthCents, b.revaluationCents, b.venturesCents, b.unsortedCents, b.inTransitCents, b.unexplainedCents, b.otherCents, b.engineErrorCents], [41_230_000, 239_070, 68_570, 214_000, -13_000, -28_900, -1_600, 0, 0, 0, 0])
    assert.deepEqual(w.growth!.twr, { fromDay: '2025-10-31', toDay: '2026-10-31', rate: w.growth!.twr.rate })
    assert.deepEqual(w.growth!.revaluation, [{ accountId: h.civic, name: '2017 Civic', assetType: 'vehicle', cents: -13_000 }])
  })

  test('each account opens what Net worth opens it on, Cash return opens its lines, and the links go to Investments and Net worth', () => {
    const w = month('2026-10')
    const lines = view.homeTable(w, 'growth').lines
    // An invested account opens Investments, and the car Property, where each is on Net worth.
    assert.deepEqual(
      lines.filter((x): x is Extract<HomeLine, { kind: 'account' }> => x.kind === 'account').map((l) => [l.name, l.view]),
      [
        ['Brokerage', 'investments'],
        ['Brightline 401(k)', 'investments'],
        ['Brightline HSA', 'investments'],
        ['2017 Civic', 'property']
      ]
    )
    const returns = lines.find((l) => l.kind === 'data' && l.key === 'returns') as Extract<HomeLine, { kind: 'data' }>
    assert.deepEqual(returns.items, [{ text: '2,083' }, { text: 'Cash return 57', drill: { month: '2026-10', toMonth: '2026-10', cls: ['cashReturn'], name: 'Growth · Cash return' } }])
    const pages = lines.find((l) => l.kind === 'data' && l.key === 'pages') as Extract<HomeLine, { kind: 'data' }>
    assert.deepEqual(pages.items, [
      { text: 'Investments', page: 'networth', view: 'investments' },
      { text: 'Net worth', page: 'networth', view: 'overview' }
    ])
    // Rendered: each account a row that opens, its treatment beside it; the links as links.
    const html = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(w, 'growth'), onOpen: () => {}, onDrill: () => {}, onPage: () => {} }))
    assert.match(html, /<tr class="part account drill"><th scope="row" class="name"><button class="row-name"><span class="account-name">Brokerage<\/span><\/button><span class="part-note">Taxable<\/span><\/th><td class="num">2,083<\/td><td class="num">1,143<\/td>/)
    assert.match(html, /<tr class="part account drill"><th scope="row" class="name"><button class="row-name"><span class="account-name">2017 Civic<\/span><\/button><span class="part-note">Revaluation<\/span><\/th><td class="num">−130<\/td><td class="num"><\/td>/)
    // An account line's name stays on a line up to 15em and wraps past it, inside a word if it must, so a bank's
    // long name never widens the table; in a narrow window it wraps to what's left.
    const css = source('src/renderer/src/styles.css')
    assert.match(css, /\.home-rows tr\.account \.account-name \{\s*display: inline-block;\s*width: max-content;\s*max-width: 15em;\s*white-space: normal;\s*overflow-wrap: anywhere;/)
    assert.match(css, /@container \(max-width: 560px\) \{[^@]*\.home-rows tr\.account \.account-name \{\s*width: auto;\s*max-width: none;\s*\}/)
    // An account line is a part's row too, and a part's name is cut to its column (Left over's payees): the account's
    // column makes room for its name instead, after that rule, so the name never runs under its figures.
    const cut = css.search(/\.home-rows tr\.part \.name \{\s*max-width: 0;\s*\}/)
    const room = css.search(/\.home-rows tr\.account \.name \{\s*max-width: none;\s*\}/)
    assert.ok(cut >= 0 && room > cut, 'the account line\'s name column is exempt from the part\'s cut')
    // So does a changed month's line beside its close's, which carries the account's name too.
    assert.match(css, /\.home-rows tr\.closed \.name \{\s*padding-left: 26px;\s*white-space: normal;\s*overflow-wrap: anywhere;\s*\}/)
    assert.match(html, /<button class="link small">› Investments<\/button> · <button class="link small">› Net worth<\/button>/)
    assert.match(html, /<span class="label-muted">Returns<\/span><span class="data-text">2,083 · <button class="link-quiet">Cash return 57<\/button><\/span>/)
    // Home opens a view of Net worth as the sidebar does.
    assert.match(source('src/renderer/src/pages/Home.tsx'), /onPage=\{\(p, v\) => \(v \? goNet\(v\) : go\(p\)\)\}/)
    assert.match(source('src/renderer/src/pages/HomeRows.tsx'), /l\.view && onPage \? \(\) => onPage\('networth', l\.view!\)/)
    assert.match(source('src/renderer/src/App.tsx'), /const goNet = useCallback\(\s*\(v: NetView\) => \{\s*if \(v === 'debts'\) focusPayoff\(\)\s*setOpenGroup\(groupOf\('networth'\)\?\.id \?\? null\)\s*pickNet\(v\)/)
    // Growth is Home's last row, so its links sit at the foot of a scrolled page: the page or view they open starts at
    // its top, Net worth's headline in view.
    assert.match(source('src/renderer/src/App.tsx'), /useLayoutEffect\(\(\) => \{\s*mainRef\.current\?\.scrollTo\?\.\(0, 0\)\s*\}, \[page, netView, netPicks, opened\]\)/)
    assert.match(source('src/renderer/src/App.tsx'), /<main className="main" ref=\{mainRef\}>/)
  })

  test('over a span, every figure is the span\'s: returns and Revaluation summed, the TWR over the 12 months to its end, the bridge from its first day to its last', () => {
    const months = monthsFrom('2026-01', '2026-10')
    const each = months.map(month)
    for (const span of [
      { from: '2026-01', to: '2026-10' },
      { from: '2025-11', to: '2026-10' }
    ]) {
      const w = getWaterfall(span)
      const inside = span.from === '2026-01' ? each : [...monthsFrom('2025-11', '2025-12').map(month), ...each]
      const g = w.growth!
      for (const a of g.accounts) assert.equal(a.actualCents, sum(inside, (x) => x.growth!.accounts.find((y) => y.accountId === a.accountId)?.actualCents ?? 0), `${span.from} ${a.name}`)
      // The run rates are October's, in force at the span's end, and so is the TWR's window.
      assert.deepEqual(
        g.accounts.map((a) => a.runRateCents),
        each.at(-1)!.growth!.accounts.map((a) => a.runRateCents)
      )
      assert.deepEqual(g.twr, each.at(-1)!.growth!.twr)
      assert.equal(sum(g.revaluation, (x) => x.cents), sum(inside, (x) => x.bridge.revaluationCents))
      assert.deepEqual([w.bridge.startCents, w.bridge.endCents], [inside[0].bridge.startCents, inside.at(-1)!.bridge.endCents])
      // An average month beside the run rate.
      assert.equal(g.accounts[0].perMonthCents, Math.round(g.accounts[0].actualCents! / inside.length))
      assert.ok(view.homeTable(w, 'growth').lines.some((l) => l.kind === 'account' && l.perMonth === view.dollars(g.accounts[0].perMonthCents!)))
    }
    // The open month and the last 30 days end in November: their run rates are October's, the latest full month's
    // (spec 1.1 and 1.12), and so is the TWR beside them, over the same twelve months, November 2025 to October 2026.
    const october = month('2026-10').growth!.twr
    assert.deepEqual(october, { fromDay: '2025-10-31', toDay: '2026-10-31', rate: october.rate })
    assert.deepEqual(month('2026-11').growth!.twr, october)
    assert.deepEqual(getWaterfall({ from: '2026-10-09', to: '2026-11-07' }).growth!.twr, october)
    // A span ending inside a past month reads the month before's: from Sep 15 to Oct 15, September's twelve months.
    const inside = getWaterfall({ from: '2026-09-15', to: '2026-10-15' })
    assert.equal(inside.endMonth, '2026-09')
    assert.deepEqual(inside.growth!.twr, month('2026-09').growth!.twr)
    assert.deepEqual([inside.growth!.twr.fromDay, inside.growth!.twr.toDay], ['2025-09-30', '2026-09-30'])
    assert.equal(inside.rows.find((r) => r.id === 'growth')!.runRateCents, month('2026-09').rows.find((r) => r.id === 'growth')!.runRateCents)
  })

  test('each drill sums to its row, every month, YTD, 12M, All, a custom span and the last 30 days', () => {
    everySpanTies('household', { from: '2025-03', to: '2026-06' })
  })

  test("while October is changed since its close, what moved shows under Growth's account and under its bridge", async () => {
    await closeDueMonths()
    await checkClosed()
    // October's brokerage statement 5.00 higher: its return, Growth and net worth move by 5.00.
    db.setBalancePoint(ACCOUNTS.brokerage, '2026-10-31', db.balancesOn([ACCOUNTS.brokerage], '2026-10-31').get(ACCOUNTS.brokerage)! + 500)
    try {
      const run = await checkClosed()
      assert.ok(run.changed.some((c) => c.month === '2026-10'))
      const shown = opened(month('2026-10'), 'growth').under
      const at = shown.findIndex((u) => u[0] === 'Brokerage')
      assert.deepEqual(shown[at + 1], ['Brokerage', '2,088', '2,083', '5'])
      const nw = shown.findIndex((u) => u[0].startsWith('Net worth'))
      assert.deepEqual(
        shown.slice(nw + 1, nw + 3),
        [
          ['Net worth', '412,305', '412,300', '5'],
          ['Growth', '2,145', '2,140', '5']
        ]
      )
    } finally {
      db.setBalancePoint(ACCOUNTS.brokerage, '2026-10-31', db.balancesOn([ACCOUNTS.brokerage], '2026-10-31').get(ACCOUNTS.brokerage)! - 500)
      await checkClosed()
    }
  })

  test("opening Invested or Growth reads nothing beyond Home's waterfall, whatever the span", () => {
    // Both drills are figures in the waterfall Home already has: no call of their own, so switching spans or rows
    // asks for nothing but the span's waterfall.
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.deepEqual([...home.matchAll(/api\.(?!on[A-Z])(\w+)\(/g)].map((m) => m[1]).sort(), ['getHomePlans', 'getInsight', 'getSpendable', 'getWaterfall', 'listAccounts', 'listContributions'])
    // Left over's and Saved's plans are the one call either of those drills makes, and neither of these makes it.
    assert.match(home, /const wantPlans = open === 'leftOver' \|\| open === 'saved'\n/)
    assert.doesNotMatch(home, /open === '(invested|growth)'/)
    assert.doesNotMatch(source('src/renderer/src/pages/homeView.ts'), /\bapi\./)
  })
})

describe('variations on the household', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('DEPOSITS ONLY: Invested 500 250 83.2% 0, all of it from cash', () => {
    household({ paystubs: false })
    const w = month('2026-10')
    // 250 / 300.50 of Saved is 83.2%, and 250 three months before, so Δ 3 mo is 0. Open, it shows its Δ pts too: in
    // July Saved was its Kept alone, 420.00, so 250 / 420 = 59.524%, and 83.195 - 59.524 = +23.7 points.
    assert.deepEqual(opened(w, 'invested'), {
      row: ['Invested', '500', '250', '83.2%', '+23.7 pts', '0'],
      under: [
        ['Saved at work', '0', '0', '0'],
        ['Employer saving', '0', '0', '0'],
        ['From cash', '500', '250', '0'],
        // No 401(k) election, but an HSA held: round(440,000 / 12) of room.
        ['Levers', 'HSA room 367/mo'],
        // A = 12 × 250 = 3,000.00: 243,471.00 × 1.05^29 + 3,000.00 × (1.05^29 - 1) / 0.05 = 1,189,127.79.
        ['Retire at 65 in 2055', "1,189,128 today's dollars · invested 243,471 · +250/mo · 5.0% real"]
      ]
    })
    drillsTie(w, 'deposits only')
  })

  test("an account whose return can't be measured is not in Returns: it shows what its value did, beside the others; an HSA held as cash opens nothing", () => {
    household({ paystubs: false })
    // An IRA with two statements and no flows known makes no track; an HSA held as cash, opened in August, earns 12.00 in October.
    const ira = db.addManualAccount({ name: 'Old IRA', assetType: 'retirement', points: [{ day: '2026-09-30', cents: 5_000_000 }, { day: '2026-10-31', cents: 5_100_000 }] })
    db.upsertAccount({ id: 'csv:hsa-cash', source: 'csv', name: 'HSA Cash', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:hsa-cash', { assetType: 'cash' })
    line('csv:hsa-cash', '2026-08-01', 100_000, 'CONTRIBUTION')
    for (const [day, cents] of [
      ['2026-08-31', 100_000],
      ['2026-09-30', 100_000],
      ['2026-10-31', 101_200]
    ] as const)
      db.setBalancePoint('csv:hsa-cash', day, cents)
    const w = month('2026-10')
    const g = w.growth!
    assert.deepEqual(
      g.accounts.map((a) => [a.name, a.treatment, a.actualCents, a.unmeasured]),
      [
        ['Brokerage', 'taxable', 208_300, null],
        ['HSA Cash', 'hsa', 1_200, null],
        ['Brightline 401(k)', 'pretax', 0, null],
        ['Brightline HSA', 'hsa', 0, null],
        // Its 1,000.00 rise is neither a return nor a revaluation: no figure in Returns, and the change beside it.
        ['Old IRA', 'pretax', null, { changeCents: 100_000, putInCents: 0 }]
      ]
    )
    assert.equal(g.accounts.find((a) => a.accountId === ira)!.runRateCents, null)
    // The treatments are of the returns measured: the IRA adds nothing to Pre-tax's.
    assert.deepEqual(
      g.byTreatment.map((t) => [t.treatment, t.actualCents]),
      [
        ['pretax', 0],
        ['hsa', 1_200],
        ['taxable', 208_300]
      ]
    )
    // Growth is the measured returns and Cash return: 2,083 + 12 + 57.
    assert.equal(w.rows.find((r) => r.id === 'growth')!.actualCents, 214_000 + 1_200)
    // The bridge's Revaluation still holds the IRA's 1,000.00, as spec 2 has it; Revaluation by asset is the car alone.
    assert.deepEqual(
      g.revaluation.map((x) => [x.name, x.cents]),
      [['2017 Civic', -13_000]]
    )
    assert.equal(w.bridge.revaluationCents, 87_000)
    assert.equal(w.bridge.engineErrorCents, 0)
    const under = opened(w, 'growth').under
    assert.deepEqual(
      under.find((u) => u[1] === 'Revaluation'),
      ['2017 Civic', 'Revaluation', '−130', '']
    )
    // Two accounts are HSAs, so By treatment adds what the account lines don't say.
    assert.deepEqual(
      under.find((u) => u[0] === 'By treatment'),
      ['By treatment', 'Pre-tax 0 · HSA 12 · Taxable 2,083']
    )
    assert.deepEqual(
      under.find((u) => u[0] === 'Old IRA'),
      ['Old IRA', 'Pre-tax · value +1,000', '—', '—']
    )
    // An HSA held as cash is on no page of Net worth's own, and no lines add up to its return: it opens nothing.
    const table = view.homeTable(w, 'growth')
    const cash = table.lines.find((l): l is Extract<HomeLine, { kind: 'account' }> => l.kind === 'account' && l.name === 'HSA Cash')!
    assert.deepEqual([cash.note, cash.view], ['HSA', null])
    assert.ok(!('drill' in cash))
    const html = renderToStaticMarkup(createElement(HomeRows, { table, onOpen: () => {}, onDrill: () => {}, onPage: () => {} }))
    assert.match(html, /<tr class="part account"><th scope="row" class="name"><span class="account-name">HSA Cash<\/span><span class="part-note">HSA<\/span><\/th>/)
    drillsTie(w, 'unmeasured')
  })

  test("the open month before the statements are in: the 401(k)'s and the HSA's checks show as money put in beside them, never as a loss", () => {
    household()
    // November's first check, on Nov 5: 360.00 to the 401(k) and 84.00 to the HSA from pay, with no statement yet.
    paystub('2026-11-05')
    line(ACCOUNTS.checking, '2026-11-05', 188_850, 'BRIGHTLINE PAYROLL DIR DEP', 'Paycheck', PAYROLL)
    const w = month('2026-11')
    const shown = opened(w, 'growth').under
    // No account's November return can be measured yet: — in Returns and in each account's month, beside its run rate.
    assert.deepEqual(shown[0], ['Returns', '— · Cash return 0'])
    assert.deepEqual(
      shown.filter((u) => ['Brokerage', 'Brightline 401(k)', 'Brightline HSA'].includes(u[0])),
      [
        ['Brokerage', 'Taxable', '—', '1,143'],
        ['Brightline 401(k)', 'Pre-tax · put in 360', '—', '0'],
        ['Brightline HSA', 'HSA · put in 84', '—', '0']
      ]
    )
    // Net worth can't see the 444.00 until the statements come: the bridge's Revaluation holds it, and nothing is
    // shown as a revaluation of the 401(k) or the HSA.
    assert.equal(w.bridge.revaluationCents, -44_400)
    assert.equal(w.bridge.engineErrorCents, 0)
    assert.ok(!shown.some((u) => u[0] === 'Revaluation'))
    drillsTie(w, 'November')
    // The last 30 days: October's returns are measured to Oct 31, and the car's fall is the one revaluation.
    const days = getWaterfall({ from: '2026-10-09', to: '2026-11-07' })
    assert.deepEqual(
      days.growth!.revaluation.map((x) => x.name),
      ['2017 Civic']
    )
    assert.deepEqual(
      days.growth!.accounts.map((a) => [a.name, a.unmeasured]),
      [
        ['Brokerage', null],
        ['Brightline 401(k)', { changeCents: 0, putInCents: 36_000 }],
        ['Brightline HSA', { changeCents: 0, putInCents: 8_400 }]
      ]
    )
    drillsTie(days, '30D')
  })

  test('a 401(k) with no balance history: what was put in shows beside it, and Revaluation is the house and the car', () => {
    household()
    db.run('DELETE FROM balance_snapshots WHERE account_id = ?', ACCOUNTS.retirement)
    db.run('DELETE FROM transactions WHERE account_id = ?', ACCOUNTS.retirement)
    const w = month('2026-10')
    // October's two checks put 720.00 in: 240.00 and 120.00 each.
    assert.deepEqual(
      opened(w, 'growth').under.find((u) => u[0] === 'Brightline 401(k)'),
      ['Brightline 401(k)', 'Pre-tax · put in 720', '—', '—']
    )
    assert.deepEqual(
      w.growth!.revaluation.map((x) => [x.name, x.cents]),
      [['2017 Civic', -13_000]]
    )
    assert.equal(w.bridge.revaluationCents, -13_000 - 72_000)
    drillsTie(w, 'no history')
    const year = getWaterfall({ from: '2026-01', to: '2026-10' })
    assert.deepEqual(
      year.growth!.revaluation.map((x) => x.name),
      ['Alder Lane house', '2017 Civic']
    )
    assert.deepEqual(year.growth!.accounts.find((a) => a.name === 'Brightline 401(k)')!.unmeasured, { changeCents: 0, putInCents: 720_000 })
    drillsTie(year, 'no history, YTD')
  })

  test('an account whose return a changed month closed with, gone from the books since, shows what moved in it under the accounts', async () => {
    household()
    await closeDueMonths()
    await checkClosed()
    // The brokerage hidden after October closed with its 2,083.00 return: Growth falls by it, and no account line is left for it.
    db.updateAccount(ACCOUNTS.brokerage, { hidden: true })
    const run = await checkClosed()
    assert.ok(run.changed.some((c) => c.month === '2026-10'))
    const w = month('2026-10')
    assert.ok(!w.growth!.accounts.some((a) => a.accountId === ACCOUNTS.brokerage))
    const shown = opened(w, 'growth').under
    const after = shown.findIndex((u) => u[0] === 'Brightline HSA')
    assert.deepEqual(shown.slice(after + 1, after + 3), [
      ['Brokerage', '0', '2,083', '−2,083'],
      ['Brokerage run rate', '0', '1,143', '−1,143']
    ])
    // Each is drawn once, and closed, Growth shows it under the row.
    assert.equal(shown.filter((u) => u[0] === 'Brokerage').length, 1)
    const lines = view.homeTable(w, null).lines
    assert.ok(lines.some((l) => l.kind === 'closed' && l.name === 'Growth'))
  })

  test("the 12 months' TWR needs the money it measures: an old IRA known only by its statements, holding most of it, leaves none", () => {
    household()
    const alone = month('2026-10').growth!.twr.rate!
    // An old plan's month-end statements from Oct 2024, 500,000.00 rising 1,000.00 a month, and no flows known: it has
    // no track of its own, and it holds about two thirds of the money on Oct 31, 2025.
    const ends = monthsFrom('2024-10', '2026-10').map((m) => `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`)
    const ira = db.addManualAccount({ name: 'Old IRA', assetType: 'retirement', points: ends.map((day, i) => ({ day, cents: 50_000_000 + i * 100_000 })) })
    const w = month('2026-10')
    assert.equal(w.growth!.twr.rate, null)
    assert.ok(!opened(w, 'growth').under.some((u) => u[0] === 'TWR 12 mo'))
    // As the Investments page has it: no 1Y for every account together, and none for pre-tax, the IRA's.
    const oneYear = (id: string): boolean => !!investments().returns.find((g) => g.id === id)?.returns.periods.some((p) => p.period === '1Y')
    assert.deepEqual([oneYear('all'), oneYear('pretax')], [false, false])
    // Holding under a tenth of the money, 1,000.00, it leaves the others' TWR as it was.
    db.run('DELETE FROM balance_snapshots WHERE account_id = ?', ira)
    for (const day of ends) db.setBalancePoint(ira, day, 100_000)
    assert.equal(month('2026-10').growth!.twr.rate, alone)
    assert.equal(opened(month('2026-10'), 'growth').under.find((u) => u[0] === 'TWR 12 mo')![1], '6.2%')
  })
})

describe('the sample household and the section 2 tie-out', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the sample household: each drill sums to its row, every month and over spans, with the 401(k) pre-tax and the HSA by itself', () => {
    db.openDb(':memory:')
    loadDemoData()
    everySpanTies('demo', { from: shiftMonth(db.today().slice(0, 7), -7), to: shiftMonth(db.today().slice(0, 7), -2) })
    const w = month(shiftMonth(db.today().slice(0, 7), -1))
    assert.deepEqual(
      w.growth!.byTreatment.map((t) => t.treatment),
      ['pretax', 'hsa']
    )
    // The house and the car are revalued; the rental condo is the venture's.
    assert.deepEqual(w.growth!.revaluation.map((x) => x.assetType).sort(), ['property', 'vehicle'])
    // Each is a line of its own, so the house's name, with a · in it, reads whole; each opens Property. (The house's
    // name is the sample's own, read from it: it looks like a street address, which the public export keeps to demo.ts.)
    const house = db.listAccounts().find((a) => a.id === w.growth!.revaluation.find((x) => x.assetType === 'property')!.accountId)!.name
    assert.match(house, / · /)
    const revalued = view
      .homeTable(w, 'growth')
      .lines.filter((l): l is Extract<HomeLine, { kind: 'account' }> => l.kind === 'account' && l.note === 'Revaluation')
      .map((l) => [l.name, l.view])
    assert.deepEqual(
      revalued.sort(),
      [
        ['2022 Subaru Outback', 'property'],
        [house, 'property']
      ].sort()
    )
    // Each treatment holds one account: no By treatment line repeats the account lines.
    assert.ok(!view.homeTable(w, 'growth').lines.some((l) => l.kind === 'data' && l.key === 'byTreatment'))
  })

  test('the tie-out: Brokerage 500 and the 401(k) 600, taxable and pre-tax, Cash return 20, and the car down 200', () => {
    tieOut()
    const w = month('2026-10')
    // The returns begin with the accounts' first statements after their first flows, May 31: over the 12 months to
    // October, 500.00 and 600.00 over 12 are 41.67 and 50.00, and six months' 20.00 of interest over 12 is 10.00, so
    // Growth runs at 101.67, 0.1% of the 130,000.00 invested on Oct 1.
    assert.deepEqual(opened(w, 'growth'), {
      row: ['Growth', '1,120', '102', '0.1%', '', ''],
      under: [
        ['Returns', '1,100 · Cash return 20'],
        ['Net worth 158,155', '+3,355 = Saved 1,845 + Growth 1,120 + Revaluation −200 + Ventures 1,130 + Unsorted 0 − In transit 500 − Unexplained 40 + Other 0'],
        ['Finch 401(k)', 'Pre-tax', '600', '50'],
        ['Brokerage', 'Taxable', '500', '42'],
        // The values begin on May 31, 2026: they don't reach back to Oct 31, 2025, so there is no 12 months' TWR, as
        // the Investments page shows no 1Y for them.
        ['Car', 'Revaluation', '−200', ''],
        ['', 'Investments · Net worth']
      ]
    })
    assert.deepEqual(w.growth!.twr, { fromDay: '2025-10-31', toDay: '2026-10-31', rate: null })
    everySpanTies('tie-out', { from: '2026-06', to: '2026-09' })
  })
})

describe("the 12 months' time-weighted return", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('against a figure worked out by hand: money in and out inside the months, two accounts earning alike', () => {
    // A brokerage and a Roth IRA holding twice as much, each with a statement at every month's end, opened with
    // 10,000.00 (the Roth 20,000.00) on Oct 15, 2025. Each month's return is its Modified Dietz return: the gain over
    // what was held as it began and each flow by the share of the month left after it. For the brokerage:
    //   November (30 days): 1,500.00 in on the 15th, 11,800.00 at the end: (11,800 - 10,000 - 1,500) /
    //     (10,000 + 1,500 × 15/30) = 300 / 10,750.
    //   March (31 days): 2,000.00 out on the 21st, 9,600.00 at the end: (9,600 - 11,800 + 2,000) /
    //     (11,800 - 2,000 × 10/31) = -6,200 / 345,800.
    //   August (31 days): 600.00 in on the 1st, 10,500.00 at the end: (10,500 - 9,600 - 600) / (9,600 + 600 × 30/31)
    //     = 9,300 / 315,600.
    //   Every other month: no flow and no gain, 0.
    // The time-weighted return chains them: (11,050 / 10,750) × (339,600 / 345,800) × (324,900 / 315,600) - 1 =
    // 0.0392241, 3.9%. The Roth earns the same each day, so the two together do too.
    db.openDb(':memory:')
    const csv = (id: string, name: string, assetType: 'cash' | 'investment' | 'retirement'): void => {
      db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
      db.updateAccount(id, { assetType })
    }
    csv('csv:chk', 'Checking', 'cash')
    csv('csv:brk', 'Lakeside Brokerage', 'investment')
    csv('csv:roth', 'Lakeside Roth IRA', 'retirement')
    const ends: Array<[string, number]> = [
      ['2025-10-31', 1_000_000],
      ...['2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28'].map((d): [string, number] => [d, 1_180_000]),
      ...['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31'].map((d): [string, number] => [d, 960_000]),
      ...['2026-08-31', '2026-09-30', '2026-10-31'].map((d): [string, number] => [d, 1_050_000])
    ]
    const flows: Array<[string, number]> = [
      ['2025-10-15', 1_000_000],
      ['2025-11-15', 150_000],
      ['2026-03-21', -200_000],
      ['2026-08-01', 60_000]
    ]
    for (const [id, k] of [
      ['csv:brk', 1],
      ['csv:roth', 2]
    ] as const) {
      for (const [day, cents] of flows) {
        line(id, day, k * cents, cents > 0 ? 'TRANSFER FROM CHECKING' : 'TRANSFER TO CHECKING', 'Transfers')
        line('csv:chk', day, -k * cents, cents > 0 ? 'TRANSFER TO INVESTMENTS' : 'TRANSFER FROM INVESTMENTS', 'Transfers')
      }
      for (const [day, cents] of ends) db.setBalancePoint(id, day, k * cents)
    }
    const byHand = (11_050 / 10_750) * (339_600 / 345_800) * (324_900 / 315_600) - 1
    const w = month('2026-10')
    assert.deepEqual([w.growth!.twr.fromDay, w.growth!.twr.toDay], ['2025-10-31', '2026-10-31'])
    assert.ok(Math.abs(w.growth!.twr.rate! - byHand) < 1e-9, `${w.growth!.twr.rate} against ${byHand}`)
    assert.equal(opened(w, 'growth').under.find((u) => u[0] === 'TWR 12 mo')![1], '3.9%')
    // Over the twelve months: the brokerage's 300 - 200 + 300, and the Roth's twice that.
    const year = getWaterfall({ from: '2025-11', to: '2026-10' }).growth!
    assert.deepEqual(
      year.accounts.map((a) => [a.name, a.treatment, a.actualCents]),
      [
        ['Lakeside Roth IRA', 'roth', 80_000],
        ['Lakeside Brokerage', 'taxable', 40_000]
      ]
    )
    assert.deepEqual(year.twr, w.growth!.twr)
    // The twelve months to March 2026 or to September begin before Oct 15, 2025, when the accounts opened: their values
    // don't reach the window's start, so neither has a 12 months' TWR, and Home shows none.
    for (const m of ['2026-03', '2026-09']) {
      assert.equal(month(m).growth!.twr.rate, null, m)
      assert.ok(!opened(month(m), 'growth').under.some((u) => u[0] === 'TWR 12 mo'), m)
    }
    // Over any days the two cover, the accounts together are the hand's figures: November's and March's to March.
    const brk = investedTrack(db.listAccounts().find((a) => a.id === 'csv:brk')!)
    const roth = investedTrack(db.listAccounts().find((a) => a.id === 'csv:roth')!)
    const both = [
      { track: brk, cents: 1_000_000 },
      { track: roth, cents: 2_000_000 }
    ]
    assert.ok(Math.abs(twrTogether(both, '2025-10-31', '2026-03-31')! - ((11_050 / 10_750) * (339_600 / 345_800) - 1)) < 1e-9)
    // Before any account holds money there is none.
    assert.equal(twrTogether([{ track: brk, cents: 0 }], '2024-01-31', '2025-01-31'), null)
    assert.deepEqual(
      returnsByTreatment([
        { treatment: 'taxable', actualCents: 5, runRateCents: 1 },
        { treatment: 'pretax', actualCents: 7, runRateCents: 2 },
        { treatment: 'taxable', actualCents: -1, runRateCents: 3 }
      ]),
      [
        { treatment: 'pretax', actualCents: 7, runRateCents: 2 },
        { treatment: 'taxable', actualCents: 4, runRateCents: 4 }
      ]
    )
  })

  test('two accounts earning differently: each day weighted by what each held as it began', () => {
    // No flows, and a statement only at each end of the year: one account goes from 10,000.00 to 11,000.00, the other
    // from 30,000.00 to 29,400.00. Each compounds evenly by day, 1.1^(1/365) and 0.98^(1/365), and holds as each day
    // begins its value then, interpolated evenly through the year. Chaining the days' weighted returns by hand gives
    // 1.0016%, not the 1.00% a single Modified Dietz over the two would.
    const from = '2025-10-31'
    const to = '2026-10-31'
    const a = accountTrack([{ day: from, cents: 1_000_000 }, { day: to, cents: 1_100_000 }], [], '2025-10-01')
    const b = accountTrack([{ day: from, cents: 3_000_000 }, { day: to, cents: 2_940_000 }], [], '2025-10-01')
    const [ra, rb] = [1.1 ** (1 / 365) - 1, 0.98 ** (1 / 365) - 1]
    let g = 1
    for (let i = 1; i <= 365; i++) {
      const ca = Math.round(1_000_000 + (100_000 * (i - 1)) / 365)
      const cb = Math.round(3_000_000 - (60_000 * (i - 1)) / 365)
      g *= 1 + (ca * ra + cb * rb) / (ca + cb)
    }
    const rate = twrTogether(
      [
        { track: a, cents: 1_000_000 },
        { track: b, cents: 3_000_000 }
      ],
      from,
      to
    )!
    assert.ok(Math.abs(rate - (g - 1)) < 1e-9, `${rate} against ${g - 1}`)
    assert.equal(Math.round(rate * 100_000), 1_002)
  })
})

describe('the cost of the Invested and Growth drills on a large ledger', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("Home's waterfall carries both drills: laying them out under 25 ms, and Growth's figures beyond its parts under 25 ms", async (t) => {
    db.openDb(':memory:')
    largeLedger({ from: '2018-12', invested: true })
    const w = month('2026-10')
    assert.equal(w.growth!.accounts.length, 4)
    drillsTie(w, 'large')
    // npm test runs the files at once: each budget is timed against test/cost.ts's reference work in paired rounds,
    // and holds as the median of the rounds' ratios. Laying either drill out reads nothing: its figures are in the
    // waterfall.
    const layout = await paired(6, () => repeatedMs(() => (['invested', 'growth'] as const).forEach((open) => view.homeTable(w, open))))
    t.diagnostic(within('laying out Invested and Growth', 25, layout))
    assert.ok(layout.ratio <= budgetRatio(25), within('laying out Invested and Growth', 25, layout))
    // What getWaterfall works out for Growth's drill beyond its parts, over the tracks the returns already read: the
    // returns by treatment and the four accounts' time-weighted return over the year, from 95 months of statements.
    const accounts = investedAccounts(db.listAccounts())
    const tracks = accounts.map(investedTrack)
    assert.ok(tracks.every((x) => (x?.points.length ?? 0) > 90))
    const { fromDay, toDay } = w.growth!.twr
    const twr = await paired(6, () =>
      repeatedMs(() => {
        returnsByTreatment(w.growth!.accounts)
        const held = db.balancesOn(
          accounts.map((a) => a.id),
          fromDay
        )
        twrTogether(
          accounts.map((a, i) => ({ track: tracks[i], cents: held.get(a.id) ?? 0 })),
          fromDay,
          toDay
        )
      })
    )
    t.diagnostic(within("Growth's treatments and TWR", 25, twr))
    assert.ok(twr.ratio <= budgetRatio(25), within("Growth's treatments and TWR", 25, twr))
    const held = db.balancesOn(
      accounts.map((a) => a.id),
      fromDay
    )
    assert.ok(w.growth!.twr.rate !== null)
    assert.equal(
      twrTogether(
        accounts.map((a, i) => ({ track: tracks[i], cents: held.get(a.id) ?? 0 })),
        fromDay,
        toDay
      ),
      w.growth!.twr.rate
    )
  })
})
