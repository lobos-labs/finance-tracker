import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { NetWorthBridge, Span } from '../src/shared/types.ts'
import { budgetRatio, busyMs, paired, within } from './cost.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS, household, TODAY } from './fixtures/waterfall-household.ts'

// Net worth's Overview (waterfall spec sub-phase 2d, part 2): the net worth line and the monthly bridge over the span
// picked, on one source. The line is the net worth series and the bridge getWaterfall's months, and both read one
// walk of the balances, so at every month's end the line is the month's bridge end, its first point the span's
// start, and the Overview's net worth today the open month's end; each month ties and the months chain. The balance
// sheet and the series count every account the bridge counts, so section 5's household reads 412,300.00 and Net
// worth's Debts lists every debt the plan reads, owing the same. None of it moves a row, an identity, a bridge or a
// close (networth-unchanged.test.ts).

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place. The renderer's .tsx load through
// the same transform the app's bundler uses (Vite's Rolldown), so the bridge renders here as it does on the page.
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
const { getBalanceSheet, getNetWorthSeries } = await import('../src/main/netWorth.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { getWaterfall } = await import('../src/main/waterfall.ts')
const { getDebts, nextDebt } = await import('../src/main/debts.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { checkClosed, closeDueMonths } = await import('../src/main/snapshots.ts')
const { runTool } = await import('../src/main/tools.ts')
const { addDays, daysInMonth, shiftMonth } = await import('../src/shared/zone.ts')
const { lastDays } = await import('../src/shared/period.ts')
const view = await import('../src/renderer/src/pages/netWorthView.ts')
const home = await import('../src/renderer/src/pages/homeView.ts')
const { BridgeTable } = await import('../src/renderer/src/pages/NetWorthBridge.tsx')
const { tieOut, line } = await import('./fixtures/tieout.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

/** The bridge's terms added up, In transit and Unexplained taken away. */
const terms = (b: NetWorthBridge): number => b.savedCents + b.growthCents + b.revaluationCents + b.venturesCents + b.unsortedCents - b.inTransitCents - b.unexplainedCents + b.otherCents
const NUMBERS = ['savedCents', 'growthCents', 'revaluationCents', 'venturesCents', 'unsortedCents', 'inTransitCents', 'unexplainedCents', 'otherCents', 'engineErrorCents'] as const

/** Each fixture's spans: YTD, 12M, All, the last 30 days, a custom span of months and one of days, and every month. */
function spansOf(first: string): Span[] {
  const today = db.today()
  const cur = today.slice(0, 7)
  const months: Span[] = []
  for (let m = first; m <= cur; m = shiftMonth(m, 1)) months.push({ from: m, to: m })
  return [{ from: `${cur.slice(0, 4)}-01`, to: cur }, { from: shiftMonth(cur, -11), to: cur }, { from: first, to: cur }, lastDays(30, today), { from: '2026-03', to: '2026-08' }, { from: '2026-09-10', to: '2026-10-20' }, { from: '2026-10-26', to: '2026-11-04' }, ...months]
}

/**
 * The Overview over every span of a fixture: the line starts at the span's start and ends at its end; at each month's
 * end it is the month's bridge end; each month ties, starts where the one before it ended, and the span's terms are
 * the months' added up; the lines the Overview lists are the span's first, then the months newest first, each tying in
 * cents. The Overview's net worth today is the open month's end, and so is the series' last point.
 */
function assertOneSource(label: string): void {
  const today = db.today()
  const cur = today.slice(0, 7)
  const series = getNetWorthSeries()
  const first = getWaterfall({ from: cur, to: cur }).firstMonth!
  for (const s of spansOf(first)) {
    const what = `${label} ${s.from}..${s.to}`
    const w = getWaterfall(s)
    const points = view.chartPoints(series, w.span, today)
    const at = new Map(points.map((p) => [p.day, p.cents]))
    const { fromDay, toDay } = view.spanDays(w.span)
    assert.deepEqual(points[0], { day: addDays(fromDay, -1), cents: w.bridge.startCents }, `${what}: the line's first point is the span's start`)
    assert.deepEqual(points.at(-1), { day: toDay < today ? toDay : today, cents: w.bridge.endCents }, `${what}: its last point is the span's end`)
    assert.equal(w.bridge.startCents + terms(w.bridge), w.bridge.endCents, `${what}: the span ties`)
    let start = w.bridge.startCents
    for (const m of w.months) {
      const b = m.bridge
      assert.equal(b.startCents, start, `${what} ${m.month}: starts where the month before ended`)
      assert.equal(b.startCents + terms(b), b.endCents, `${what} ${m.month}: ties`)
      assert.equal(b.engineErrorCents, 0, `${what} ${m.month}: no engine error`)
      const end = [toDay, lastDay(m.month)].sort()[0]
      if (end <= today) assert.equal(at.get(end), b.endCents, `${what} ${m.month}: the line at the month's end is its bridge's end`)
      start = b.endCents
    }
    assert.equal(start, w.bridge.endCents, `${what}: the last month ends where the span does`)
    for (const k of NUMBERS) assert.equal(w.months.reduce((t, m) => t + m.bridge[k], 0), w.bridge[k], `${what}: ${k} is the months' added up`)
    const lines = view.bridgeLines(w)
    assert.ok(lines[0].span, what)
    assert.deepEqual([lines[0].startCents, lines[0].endCents], [w.bridge.startCents, w.bridge.endCents], what)
    // The months the books cover, or anything moved in, the newest first; a span of one month is its line alone.
    const shown = w.months.filter((m) => m.month >= w.firstMonth! || m.bridge.startCents !== m.bridge.endCents || NUMBERS.some((k) => m.bridge[k] !== 0))
    assert.deepEqual(
      lines.slice(1).map((l) => l.key),
      w.months.length === 1 ? [] : shown.map((m) => m.month).reverse(),
      `${what}: the months, the newest first`
    )
    for (const l of lines) assert.equal(l.startCents + view.termsTotal(l.terms), l.endCents, `${what} ${l.key}: the line ties`)
  }
  const open = getWaterfall({ from: cur, to: cur })
  assert.equal(getBalanceSheet().netWorthCents, open.months[0].bridge.endCents, `${label}: the Overview's net worth today is the open month's end`)
  assert.equal(series.points.at(-1)!.cents, open.bridge.endCents, `${label}: so is the series' last point`)
}

/** Net worth's Debts (the balance sheet's cards and loans) lists every debt the plan reads, owing what the plan has it owe. */
function assertDebtsListed(label: string): Map<string, number> {
  const d = getDebts()
  assert.ok(d.debts.length > 0, label)
  const sheet = getBalanceSheet()
  const listed = new Map(sheet.groups.filter((g) => g.id === 'cards' || g.id === 'loans').flatMap((g) => g.accounts.map((x) => [x.account.id, -x.cents] as const)))
  for (const x of d.debts) assert.equal(listed.get(x.id), x.balanceCents, `${label} ${x.name} on Debts`)
  return listed
}

describe("section 5's household on Net worth's Overview", () => {
  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    await closeDueMonths()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("net worth on Oct 31, 2026 is 412,300.00, and October's line is Start 409,909.30, Saved 685.70, Growth 2,140.00, Revaluation -130.00, Ventures -289.00, Unsorted -16.00, In transit 0, Unexplained 0 and Other 0: ΔNW 2,390.70", () => {
    const w = getWaterfall({ from: '2025-12', to: '2026-11' })
    const points = view.chartPoints(getNetWorthSeries(), w.span, db.today())
    assert.equal(points.find((p) => p.day === '2026-10-31')?.cents, 41_230_000)
    // Nothing moved since: the Overview's net worth today is the same, and so is the Growth drill's.
    assert.equal(getBalanceSheet().netWorthCents, 41_230_000)
    const oct = view.bridgeLines(w).find((l) => l.key === '2026-10')!
    assert.deepEqual(
      { start: oct.startCents, terms: oct.terms, end: oct.endCents },
      { start: 40_990_930, terms: { saved: 68_570, growth: 214_000, revaluation: -13_000, ventures: -28_900, unsorted: -1_600, inTransit: 0, unexplained: 0, other: 0 }, end: 41_230_000 }
    )
    assert.equal(oct.endCents - oct.startCents, 239_070)
    // As the Overview draws it, in whole dollars, October closed.
    assert.equal(oct.name, 'Oct 2026')
    assert.equal(oct.mark, '✓')
    assert.deepEqual(oct.cells, ['409,909', '686', '2,140', '−130', '−289', '−16', '0', '0', '0', '412,300'])
    // November is open, and the span holds it.
    assert.deepEqual([view.bridgeLines(w)[0].mark, view.bridgeLines(w)[1].key, view.bridgeLines(w)[1].mark], ['○', '2026-11', '○'])
  })

  test('every account the bridge counts is in the series and the balance sheet, at the same balance: the CSV accounts have no balance of their own', () => {
    const series = getNetWorthSeries()
    assert.deepEqual([series.accountsIncluded, series.accountsMissing], [db.countedAccounts().length, 0])
    const sheet = getBalanceSheet()
    const walked = db.balancesOn(db.countedAccounts(), db.today())
    const listed = new Map(sheet.groups.flatMap((g) => g.accounts.map((x) => [x.account.id, x.cents] as const)))
    // Personal's accounts each in their group; a venture's (sub-phase 1j) in its position on the Ventures row, all of
    // them at its migrated share of 100%.
    const { personal, ventures } = db.ventureHoldings()
    for (const id of personal) if (walked.get(id)) assert.equal(listed.get(id), walked.get(id), id)
    const rows = new Map((sheet.groups.find((g) => g.id === 'ventures')!.ventures ?? []).map((v) => [v.bucketId, v.cents]))
    for (const v of ventures) assert.equal(rows.get(v.id) ?? 0, v.accounts.reduce((s, id) => s + (walked.get(id) ?? 0), 0), v.name)
    assert.equal(sheet.netWorthCents, [...walked.values()].reduce((s, c) => s + c, 0))
  })

  test('the line is the bridge at every month end, starting at the span start; each month ties and the months chain, over YTD, 12M, All, 30D and custom spans', () => {
    assertOneSource('household')
  })

  test("Review's month summary and its net worth give the Overview's net worth today, the CSV accounts counted", () => {
    const sheet = getBalanceSheet().netWorthCents
    assert.equal(sheet, 41_230_000)
    assert.equal((runTool('month_summary', { month: '2026-11' }).result as { netWorthCents: number }).netWorthCents, sheet)
    assert.equal((runTool('net_worth', {}).result as { points: Array<{ cents: number }> }).points.at(-1)?.cents, sheet)
  })

  test("Net worth's Debts lists every debt getDebts plans at the same cents: the Visa the Saved drill names owes 3,000.00", () => {
    const listed = assertDebtsListed('household')
    assert.equal(listed.get('csv:visa'), 300_000)
    assert.ok(getDebts().debts.some((x) => x.id === 'csv:visa'))
  })

  test("the bridge draws its lines and no control: a span line, then the months, each a marker and ten figures", () => {
    const w = getWaterfall({ from: '2026-01', to: '2026-11' })
    const drawn = renderToStaticMarkup(createElement(BridgeTable, { lines: view.bridgeLines(w) }))
    assert.doesNotMatch(drawn, /<button|<input|<select|<a /)
    // The span's name breaks only after its dash, its spaces kept; the minus stays with its heading's word.
    assert.match(drawn, /<th class="name" scope="row">Jan–<wbr\/>Nov<span/)
    const html = drawn.replace(/<wbr\/>/g, '').replace(/ /g, ' ')
    const rows = [...html.matchAll(/<tr( class="span")?><th class="name" scope="row">([^<]+)<span class="span-mark mono" title="[^"]*" aria-label="[^"]*">(.)<\/span><\/th>((?:<td class="num">[^<]*<\/td>){10})<\/tr>/g)]
    assert.equal(rows.length, 12)
    assert.deepEqual(
      rows.map((r) => [!!r[1], r[2], r[3]]),
      [[true, 'Jan–Nov', '○'], [false, 'Nov 2026', '○'], ...['Oct', 'Sep', 'Aug', 'Jul', 'Jun', 'May', 'Apr', 'Mar', 'Feb', 'Jan'].map((m) => [false, `${m} 2026`, '✓'])]
    )
    assert.match(html, /<th>Start<\/th><th>Saved<\/th><th>Growth<\/th><th>Revaluation<\/th><th>Ventures<\/th><th>Unsorted<\/th><th>− In transit<\/th><th>− Unexplained<\/th><th>Other<\/th><th>End<\/th>/)
  })

  test("the line's axis names the span's own months and days, though the line starts the day before them", async () => {
    // The renderer's lib reads window.api once, as it loads; a window only for that.
    const g = globalThis as Record<string, unknown>
    const hadWindow = 'window' in g
    if (!hadWindow) g['window'] = {}
    const { dateTicks } = await import('../src/renderer/src/lib.ts')
    if (!hadWindow) delete g['window']
    const series = getNetWorthSeries()
    for (const [s, first] of [
      [{ from: '2025-12', to: '2026-11' }, 'DEC'],
      [{ from: '2026-01', to: '2026-11' }, 'JAN'],
      [{ from: '2026-10-09', to: '2026-11-07' }, 'OCT 9']
    ] as const) {
      const points = view.chartPoints(series, s, db.today())
      assert.equal(points[0].day, addDays(view.spanDays(s).fromDay, -1))
      const axis = dateTicks(view.axisDays(points))
      assert.equal(axis.ticks[0], view.spanDays(s).fromDay, `${s.from}..${s.to}`)
      assert.equal(axis.format(axis.ticks[0]), first)
    }
  })

  test("the Overview keeps Home's span, the viewer's one choice: Growth's › Net worth opens on the span the drill showed", () => {
    // A store as localStorage is, read and written the way Home and the Overview both do.
    const kept = new Map<string, string>()
    const store = (): Pick<Storage, 'getItem' | 'setItem'> => ({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) })
    home.writeSpan(store, { from: '2026-10', to: '2026-10' }, null, TODAY)
    assert.deepEqual(home.readSpan(store, TODAY), { span: { from: '2026-10', to: '2026-10' }, preset: null })
    home.writeSpan(store, { from: '2026-06', to: '2026-09' }, null, TODAY)
    assert.deepEqual([...kept.keys()], [home.SPAN_KEY])
    assert.equal(home.SPAN_KEY, 'home.span')
    // A store that can't be read gives Home's default, the last full month.
    assert.deepEqual(home.readSpan(() => { throw new Error('blocked') }, TODAY), { span: { from: '2026-10', to: '2026-10' }, preset: null })
    // Both pages read and write it through these, and nothing else keeps a span.
    for (const page of ['Home.tsx', 'NetWorthChart.tsx']) {
      const source = readFileSync(join(root, 'src', 'renderer', 'src', 'pages', page), 'utf8')
      assert.match(source, /readSpan\(\(\) => localStorage, todayKey\(\)\)/, page)
      assert.match(source, /writeSpan\(\(\) => localStorage, s, preset, todayKey\(\)\)/, page)
      assert.doesNotMatch(source, /'networth\.span'|SPAN_KEY/, page)
    }
  })

  test("Growth's › Net worth opens the Overview", () => {
    const lines = home.homeTable(getWaterfall({ from: '2026-10', to: '2026-10' }), 'growth').lines
    const pages = lines.find((l) => l.kind === 'data' && l.key === 'pages')
    assert.ok(pages && pages.kind === 'data')
    assert.deepEqual(
      pages.items?.find((i) => i.text === 'Net worth'),
      { text: 'Net worth', page: 'networth', view: 'overview' }
    )
  })
})

describe('the sample household and the section 2 tie-out on the Overview', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the sample household: the line is the bridge at every month end; Debts lists every debt the plan reads', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    db.openDb(':memory:')
    loadDemoData()
    await closeDueMonths()
    assertOneSource('demo')
    assertDebtsListed('demo')
  })

  test("the sample household: a card payment counts on the day the card shows it, as the line had it before, and the line starts where the bridge does when the payment is on its way that day", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    db.openDb(':memory:')
    loadDemoData()
    await closeDueMonths()
    // 1,793.70 leaves Everyday Checking on Oct 25 for the Rewards Visa, which shows it on Oct 27.
    const series = getNetWorthSeries()
    assert.deepEqual(
      series.landed.find((x) => x.fromDay === '2026-10-25'),
      { fromDay: '2026-10-25', toDay: '2026-10-26', cents: 179_370 }
    )
    const at = new Map(series.points.map((p) => [p.day, p.cents]))
    const walked = (day: string): number => [...db.balancesOn(db.countedAccounts(), day).values()].reduce((s, c) => s + c, 0)
    for (const day of ['2026-10-25', '2026-10-26']) assert.equal(at.get(day), walked(day) + 179_370, day)
    for (const day of ['2026-10-24', '2026-10-27', '2026-10-31']) assert.equal(at.get(day), walked(day), day)
    // Every day of the last year is as the line was before the bridge's walk: the sample has no transfer across a
    // month's end. That line is still a venture's beside Personal (every sample account has a balance of its own).
    const before = new Map(getNetWorthSeries([0, db.listBuckets()[0].id]).points.map((p) => [p.day, p.cents]))
    for (const p of series.points) if (p.day >= '2025-11-30') assert.equal(p.cents, before.get(p.day), p.day)
    // Ten days from Oct 26: the line starts on Oct 25 with the payment out of checking and not yet on the card, the
    // bridge's start, and the payment lands inside the span, its In transit.
    const w = getWaterfall({ from: '2026-10-26', to: '2026-11-04' })
    const points = view.chartPoints(series, w.span, db.today())
    assert.deepEqual(points.slice(0, 3), [
      { day: '2026-10-25', cents: w.bridge.startCents },
      { day: '2026-10-26', cents: walked('2026-10-26') },
      { day: '2026-10-27', cents: walked('2026-10-27') }
    ])
    assert.equal(w.bridge.startCents, walked('2026-10-25'))
    assert.equal(w.bridge.inTransitCents, -179_370)
    assert.equal(points.at(-1)?.cents, w.bridge.endCents)
  })

  test('the tie-out: the line is the bridge at every month end, October with 500.00 in transit; Debts lists every debt the plan reads', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
    await closeDueMonths()
    assertOneSource('tie-out')
    assertDebtsListed('tie-out')
    const oct = getWaterfall({ from: '2026-10', to: '2026-10' }).bridge
    assert.deepEqual([oct.startCents, oct.endCents, oct.inTransitCents], [15_480_000, 15_815_500, 50_000])
    // October as the Overview draws it, under − In transit and − Unexplained, the figures Home's Growth drill shows.
    const line = view.bridgeLines(getWaterfall({ from: '2026-09', to: '2026-10' })).find((l) => l.key === '2026-10')!
    assert.deepEqual(line.cells, ['154,800', '1,845', '1,120', '−200', '1,130', '0', '500', '40', '0', '158,155'])
    const growth = home.homeTable(getWaterfall({ from: '2026-10', to: '2026-10' }), 'growth').lines.find((l) => l.kind === 'data' && l.key === 'netWorth')
    assert.match(JSON.stringify(growth), /− In transit 500 − Unexplained 40 /)
  })
})

describe('money between two accounts across a month end', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    // Checking and Savings, each with its own balance today and none at a month's end: 500.00 leaves Checking on
    // Oct 31 and lands in Savings on Nov 1, so at October's end it is in neither.
    db.openDb(':memory:')
    for (const [id, name, cents] of [['csv:chk', 'Checking', 100_000], ['csv:sav', 'Savings', 550_000]] as const) {
      db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: noonOn(Y, M, D) })
      db.updateAccount(id, { assetType: 'cash' })
    }
    db.inTransaction(() => {
      line('csv:chk', '2026-10-15', 200_000, 'ACME PAYROLL DIR DEP', 'Paycheck', 'Acme Payroll')
      line('csv:chk', '2026-10-31', -50_000, 'TRANSFER TO SAVINGS', 'Transfers', 'Transfer to Savings')
      line('csv:sav', '2026-11-01', 50_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Transfer from Checking')
    })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("the line and the bridge give October's end the same figure, the 500.00 in neither account: the bridge's In transit", () => {
    const w = getWaterfall({ from: '2026-10', to: '2026-11' })
    const [oct, nov] = w.months.map((m) => m.bridge)
    assert.deepEqual([oct.startCents, oct.savedCents, oct.inTransitCents, oct.endCents], [450_000, 200_000, 50_000, 600_000])
    assert.deepEqual([nov.startCents, nov.inTransitCents, nov.endCents], [600_000, -50_000, 650_000])
    const points = new Map(view.chartPoints(getNetWorthSeries(), w.span, db.today()).map((p) => [p.day, p.cents]))
    assert.deepEqual([points.get('2026-09-30'), points.get('2026-10-30'), points.get('2026-10-31'), points.get('2026-11-01'), points.get(db.today())], [450_000, 650_000, 600_000, 650_000, 650_000])
    assert.equal(getBalanceSheet().netWorthCents, 650_000)
  })
})

describe("a month changed since its close, on section 5's household", () => {
  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    await closeDueMonths()
    // On the Accounts page, October's brokerage statement is 5.00 higher: Growth and net worth on Oct 31 move by 5.00.
    db.setBalancePoint(ACCOUNTS.brokerage, '2026-10-31', db.balancesOn([ACCOUNTS.brokerage], '2026-10-31').get(ACCOUNTS.brokerage)! + 500)
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => c.month), ['2026-10'])
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("October's line, then its figures as it closed, as Home's Growth drill shows them; the months that didn't change have none", () => {
    for (const s of [{ from: '2026-09', to: '2026-11' }, { from: '2026-10', to: '2026-10' }]) {
      const lines = view.bridgeLines(getWaterfall(s))
      const at = lines.findIndex((l) => l.name === 'Oct 2026')
      const [oct, closed] = [lines[at], lines[at + 1]]
      assert.deepEqual([oct.mark, oct.closed, closed.key, closed.name, closed.closed], ['Δ', false, '2026-10:closed', 'Closed', true], `${s.from}..${s.to}`)
      assert.deepEqual(oct.cells, ['409,909', '686', '2,145', '−130', '−289', '−16', '0', '0', '0', '412,305'])
      assert.deepEqual(closed.cells, ['409,909', '686', '2,140', '−130', '−289', '−16', '0', '0', '0', '412,300'])
      assert.equal(closed.startCents + view.termsTotal(closed.terms), closed.endCents)
      assert.equal(lines.filter((l) => l.closed).length, 1)
    }
    const html = renderToStaticMarkup(createElement(BridgeTable, { lines: view.bridgeLines(getWaterfall({ from: '2026-09', to: '2026-11' })) }))
    assert.match(html, /<tr class="closed"><th class="name" scope="row">Closed<\/th>(<td class="num">[^<]*<\/td>){10}<\/tr>/)
  })
})

describe('the bridge lists the months there is something to show in', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a span of one month is its line alone: MTD, a custom month and ten days inside one', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    for (const s of [{ from: '2026-11', to: '2026-11' }, { from: '2026-10', to: '2026-10' }, { from: '2026-10-05', to: '2026-10-14' }]) {
      const w = getWaterfall(s)
      const lines = view.bridgeLines(w)
      assert.equal(lines.length, 1, `${s.from}..${s.to}`)
      assert.deepEqual([lines[0].key, lines[0].span, lines[0].startCents, lines[0].endCents], ['span', true, w.bridge.startCents, w.bridge.endCents])
    }
    assert.equal(view.bridgeLines(getWaterfall({ from: '2026-10', to: '2026-10' }))[0].name, 'Oct 2026')
    assert.equal(view.bridgeLines(getWaterfall({ from: '2026-10-05', to: '2026-10-14' }))[0].name, 'Oct 5 – Oct 14')
  })

  test('no books and nothing owned: no bridge at all', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    db.openDb(':memory:')
    assert.deepEqual(view.bridgeLines(getWaterfall({ from: '2025-12', to: '2026-11' })), [])
  })

  test('books from November on, a house before them: the months before them that nothing moved in are left out', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    db.openDb(':memory:')
    db.addManualAccount({ name: 'Maple house', assetType: 'property', openedDay: '2025-01-15', costCents: 30_000_000, points: [{ day: '2025-01-15', cents: 30_000_000 }, { day: '2026-03-31', cents: 31_000_000 }] })
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 450_000, availableCents: null, balanceDate: noonOn(Y, M, D) })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    db.inTransaction(() => {
      line('csv:chk', '2026-11-03', 200_000, 'ACME PAYROLL DIR DEP', 'Paycheck', 'Acme Payroll')
    })
    const w = getWaterfall({ from: '2025-12', to: '2026-11' })
    assert.equal(w.firstMonth, '2026-11')
    // The house rose from January to March, so those months show; April to October moved nothing.
    assert.deepEqual(view.bridgeLines(w).map((l) => l.key), ['span', '2026-11', '2026-03', '2026-02', '2026-01', '2025-12'])
    for (const l of view.bridgeLines(w)) assert.equal(l.startCents + view.termsTotal(l.terms), l.endCents, l.key)
  })
})

describe('a line dated after today, in the open month', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    // Checking holds 9,000.00 today, and the water bill of 400.00 is already on the books for Nov 20.
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 900_000, availableCents: null, balanceDate: noonOn(Y, M, D) })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    db.inTransaction(() => {
      line('csv:chk', '2026-10-15', 300_000, 'ACME PAYROLL DIR DEP', 'Paycheck', 'Acme Payroll')
      line('csv:chk', '2026-11-20', -40_000, 'CITY WATER AUTOPAY', 'Utilities', 'City Water')
    })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("the line runs on to the open month's end, where the bridge ends; net worth today and the series' last point stay today's", () => {
    const series = getNetWorthSeries()
    assert.deepEqual(series.points.at(-1), { day: TODAY, cents: 900_000 })
    assert.equal(getBalanceSheet().netWorthCents, 900_000)
    for (const s of [{ from: '2026-11', to: '2026-11' }, { from: '2025-12', to: '2026-11' }, { from: '2026-01', to: '2026-11' }]) {
      const w = getWaterfall(s)
      assert.equal(w.bridge.endCents, 860_000, `${s.from}..${s.to}`)
      const points = view.chartPoints(series, w.span, db.today())
      assert.deepEqual(points.at(-1), { day: '2026-11-30', cents: w.bridge.endCents }, `${s.from}..${s.to}`)
      const at = new Map(points.map((p) => [p.day, p.cents]))
      assert.deepEqual([at.get(TODAY), at.get('2026-11-19'), at.get('2026-11-20')], [900_000, 900_000, 860_000])
    }
    // Thirty days to today end today.
    const d30 = getWaterfall(lastDays(30, db.today()))
    assert.deepEqual(view.chartPoints(series, d30.span, db.today()).at(-1), { day: TODAY, cents: d30.bridge.endCents })
    // Review's net worth is today's.
    assert.equal((runTool('net_worth', {}).result as { points: Array<{ day: string }> }).points.at(-1)?.day, TODAY)
  })
})

describe('a card whose own balance is older than its latest lines', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    // The Visa's balance of its own is 800.00 owed on Oct 1, and 200.00 and 50.00 more are spent on it after that day:
    // it owes 1,050.00 today, on the balance sheet, in the bridge and in the plan.
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 900_000, availableCents: null, balanceDate: noonOn(Y, M, D) })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    db.upsertAccount({ id: 'csv:visa', source: 'csv', name: 'Visa', institution: null, currency: 'USD', balanceCents: -80_000, availableCents: null, balanceDate: noonOn(2026, 10, 1) })
    db.updateAccount('csv:visa', { assetType: 'credit_card', apr: 22 })
    db.inTransaction(() => {
      line('csv:chk', '2026-10-15', 300_000, 'ACME PAYROLL DIR DEP', 'Paycheck', 'Acme Payroll')
      line('csv:visa', '2026-10-20', -20_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
      line('csv:visa', '2026-11-03', -5_000, 'DAILY GRIND', 'Coffee', 'Daily Grind')
    })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("Net worth's Debts and the plan have it owe 1,050.00, and so does Saved's next debt", () => {
    const listed = assertDebtsListed('a card with lines after its balance')
    assert.equal(listed.get('csv:visa'), 105_000)
    assert.equal(nextDebt()?.owedCents, 105_000)
  })
})

describe('the Overview on a large ledger', () => {
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("opening it after Home: its own reads, the series and the balance sheet, under 100 ms, and with its waterfall over 12 months under 400 ms", async (t) => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    db.openDb(':memory:')
    largeLedger({ from: '2018-12', invested: true })
    const span = { from: '2025-12', to: '2026-11' }
    // npm test runs the files at once: each budget is timed against test/cost.ts's reference work in paired rounds, and
    // holds as the median of the rounds' ratios. Each round's write first, then Home's waterfall over the last full
    // month, as the app opens on it: the books are classified again after the write, as Home reads them, and the
    // Overview's calls come after.
    const afterHome = (k: number): void => {
      db.setSetting('test.overviewRound', String(k))
      getWaterfall({ from: '2026-10', to: '2026-10' })
    }
    const own = await paired(
      6,
      () =>
        busyMs(() => {
          getNetWorthSeries()
          getBalanceSheet()
        }),
      afterHome
    )
    t.diagnostic(within('the series and the balance sheet', 100, own))
    assert.ok(own.ratio <= budgetRatio(100), within('the series and the balance sheet', 100, own))
    const all = await paired(
      6,
      () =>
        busyMs(() => {
          getWaterfall(span)
          getNetWorthSeries()
          getBalanceSheet()
        }),
      afterHome
    )
    t.diagnostic(within("the Overview's three calls", 400, all))
    assert.ok(all.ratio <= budgetRatio(400), within("the Overview's three calls", 400, all))
    // The series walks every account the bridge counts: the large ledger's CSV accounts have no balance of their own.
    const series = getNetWorthSeries()
    assert.deepEqual([series.accountsIncluded, series.accountsMissing], [db.countedAccounts().length, 0])
    const w = getWaterfall(span)
    const at = new Map(view.chartPoints(series, w.span, db.today()).map((p) => [p.day, p.cents]))
    for (const m of w.months) if (lastDay(m.month) <= db.today()) assert.equal(at.get(lastDay(m.month)), m.bridge.endCents, m.month)
  })
})
