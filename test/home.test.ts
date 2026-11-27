import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HandlerContext } from '../src/main/handlers/context.ts'
import type { Lever, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { shiftMonth } from '../src/shared/zone.ts'
import { ACCOUNTS, household, line, TODAY, type Household } from './fixtures/waterfall-household.ts'

// Home (waterfall spec sub-phase 2a): the Personal waterfall's rows as Home shows them, from one getWaterfall per
// span, with section 5's household drawing every figure its wireframe shows; go() landing old pages on Home with
// the right row open; and onboarding's answer setting home.open.

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
const { getWaterfall } = await import('../src/main/waterfall.ts')
const { spendableStrip } = await import('../src/main/spendable.ts')
const { answer } = await import('../src/main/handlers/table.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const { HomeRows } = await import('../src/renderer/src/pages/HomeRows.tsx')
const { checkClosed, closeDueMonths } = await import('../src/main/snapshots.ts')
const { tieOut } = await import('./fixtures/tieout.ts')
const { linesFor } = await import('../src/main/lines.ts')
const { lineQuery } = await import('../src/renderer/src/pages/txnFilter.ts')
type HomeLine = import('../src/renderer/src/pages/homeView.ts').HomeLine
type RowLine = import('../src/renderer/src/pages/homeView.ts').RowLine
type Opened = import('../src/renderer/src/pages/homeView.ts').Opened

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const source = (path: string): string => readFileSync(join(root, path), 'utf8')

/** The rows Home lists: name, amount, run rate, rate, Δ 3 mo and the focus dot. */
const rows = (lines: HomeLine[]): Array<[string, string, string, string, string, boolean]> =>
  lines.filter((l): l is RowLine => l.kind === 'row' && !l.less).map((l) => [l.name, l.amount, l.runRate, l.rate, l.change, l.focus])
/** What an open row shows under it: its less rows (name, amount, run rate, rate, Δ 3 mo), its parts (name, amount, run rate, Δ) and its data lines (label, text). */
function opened(w: Waterfall, open: Opened): { pts: string | null; under: Array<string[]> } {
  const lines = view.homeTable(w, open).lines
  const at = lines.findIndex((l) => l.kind === 'row' && l.open)
  const head = lines[at] as RowLine
  const under: Array<string[]> = []
  for (const l of lines.slice(at + 1)) {
    if (l.kind === 'row' && !l.less) break
    if (l.kind === 'row') under.push([l.name, l.amount, l.runRate, l.rate, l.change])
    else if (l.kind === 'part') under.push([l.name, l.amount, l.runRate, l.change])
    else if (l.kind === 'data') under.push([l.label, l.text])
  }
  return { pts: head.pts, under }
}

const web = (): HandlerContext =>
  ({
    platform: 'web',
    plan: { plan: 'plus' },
    broadcast: () => {},
    settings: () => ({ licenseTokenSaved: false, apiKeySource: 'none', simplefinConnected: false, bank: { available: true, connections: [] }, lastSyncAt: null, syncsLast24h: 0, historyFrom: null, historyComplete: false, syncWarnings: [], dataPath: '', database: { encrypted: false, switchable: false, switchOn: false, recoveryPending: false, keySeal: 'install' } })
  }) as unknown as HandlerContext

describe('the way to Home', () => {
  test("go('dashboard'), go('budget') and go('recurring') land on Home with the right row open", () => {
    // The Dashboard opens Home as home.open has it; Budget's categories are Left over's; Recurring's bills Elective's.
    assert.deepEqual(view.routeOf('dashboard', { homeOpen: 'saved' }), { page: 'home', open: 'saved' })
    assert.deepEqual(view.routeOf('dashboard', { homeOpen: null }), { page: 'home', open: null })
    assert.deepEqual(view.routeOf('budget', { homeOpen: 'saved' }), { page: 'home', open: 'leftOver' })
    assert.deepEqual(view.routeOf('recurring', { homeOpen: null }), { page: 'home', open: 'elective' })
    // A Dashboard notification is a shortfall or an overdraw (ledgerAlerts.ts, overdraw.ts): it opens Spendable.
    assert.deepEqual(view.routeOf('dashboard', { homeOpen: 'growth', notification: true }), { page: 'home', open: 'spendable' })
    assert.deepEqual(view.routeOf('recurring', { homeOpen: null, notification: true }), { page: 'home', open: 'elective' })
    // Every other page is itself, and Home named on its own keeps its row.
    assert.deepEqual(view.routeOf('home', { homeOpen: 'saved' }), { page: 'home' })
    assert.deepEqual(view.routeOf('transactions', { homeOpen: 'saved' }), { page: 'transactions' })
  })

  test('nothing routes to the Dashboard: it is gone, the pages are section 4\'s 13, and the sidebar opens Home', () => {
    assert.equal(existsSync(join(root, 'src/renderer/src/pages/Dashboard.tsx')), false)
    const app = source('src/renderer/src/App.tsx')
    const pages = /export type Page = ([^\n]+)/.exec(app)![1].match(/'(\w+)'/g)!.map((p) => p.slice(1, -1))
    assert.deepEqual(pages.sort(), ['accounts', 'benefits', 'buckets', 'calendar', 'credit', 'goals', 'home', 'insurance', 'networth', 'review', 'settings', 'taxes', 'transactions'])
    assert.match(app, /useState<Page>\(\(\) => \(planFocused\(\) \? 'settings' : 'home'\)\)/)
    assert.match(app, /routeOf\(p, \{ homeOpen: homeOpen\.current, notification \}\)/)
    // No page renders or imports the Dashboard.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
    for (const f of walk(join(root, 'src/renderer/src'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /from '\.\/(pages\/)?Dashboard'/, f)
  })

  test('onboarding sets home.open: overdraft opens Spendable, debt Saved, net worth Growth, spending Left over', async () => {
    // The Home step asks what comes first, by the same aims as before sub-phase 2e and as the phone's Home step, and
    // stores home.open's own values, so what the step stored before reads the same.
    assert.deepEqual(
      view.HOME_CHOICES.map((c) => [c.open, c.label]),
      [
        [null, 'Everything'],
        ['spendable', 'Not overdrawing'],
        ['saved', 'Paying off debt'],
        ['growth', 'Growing net worth'],
        ['leftOver', 'Where my money goes']
      ]
    )
    // The Done step names the one chosen, and Everything when the step was skipped.
    assert.deepEqual([view.homeChoiceLabel('growth'), view.homeChoiceLabel('leftOver'), view.homeChoiceLabel(null)], ['Growing net worth', 'Where my money goes', 'Everything'])
    // The Home step lists them and saves the answer, the Done step names it, and finishing lands on Home open on it.
    const wizard = source('src/renderer/src/pages/Onboarding.tsx')
    assert.match(wizard, /\{HOME_CHOICES\.map\(\(c\) => \(\s*<button key=\{c\.label\} role="radio" aria-checked=\{lead === c\.open\}/)
    assert.match(wizard, /api\.setSettings\(\{ homeOpen: lead \}\)/)
    assert.match(wizard, /<code>\{homeChoiceLabel\(leadChosen\)\}<\/code>/)
    assert.match(wizard, /go\('home', undefined, settings\?\.homeOpen \?\? null\)/)
    assert.doesNotMatch(wizard, /DASHBOARD_PRESETS|DashboardPreset|shared\/dashboard/)
    // The setting through the hosted handlers, as the wizard's step saves it and Home reads it.
    db.openDb(':memory:')
    try {
      const ctx = web()
      const homeOpen = async (): Promise<unknown> => {
        const r = await answer('getSettings', [], ctx)
        assert.ok(r.ok)
        return (r.data as { homeOpen: unknown }).homeOpen
      }
      assert.equal(await homeOpen(), null)
      for (const choice of view.HOME_CHOICES) {
        assert.equal((await answer('setSettings', [{ homeOpen: choice.open }], ctx)).ok, true)
        assert.equal(await homeOpen(), choice.open, choice.label)
      }
      assert.equal(db.getSetting('home.open'), 'leftOver')
      // A less row, or anything else, is no place to open on.
      assert.deepEqual(await answer('setSettings', [{ homeOpen: 'taxes' }], ctx), { ok: false, error: 'Home opens on one of its rows or Spendable' })
      assert.equal(await homeOpen(), 'leftOver')
      await answer('setSettings', [{ homeOpen: null }], ctx)
      assert.equal(db.getSetting('home.open'), null)
    } finally {
      db.closeDb()
    }
  })

  test("Spendable's risk: Most likely until one is chosen, in Settings or on its card into the one setting, and an asterisk with its one line where it can overestimate", async () => {
    // Through the hosted handlers, as Settings and the card both save it and every page reads it.
    db.openDb(':memory:')
    try {
      const ctx = web()
      const risk = async (): Promise<unknown> => ((await answer('getSettings', [], ctx)).data as { spendRisk: unknown }).spendRisk
      assert.equal(await risk(), 'balanced')
      for (const r of ['cautious', 'tight', 'balanced'] as const) {
        assert.equal((await answer('setSpendSettings', [{ risk: r }], ctx)).ok, true)
        assert.equal(await risk(), r)
        assert.equal(db.getSetting('spend.risk'), r)
      }
    } finally {
      db.closeDb()
    }
    // One line, at the risks that can overestimate; none at Worst case.
    assert.equal(view.spendNote('cautious'), null)
    assert.equal(view.spendNote('balanced'), '* Most likely can overestimate; Worst case errs low.')
    assert.equal(view.spendNote('tight'), '* Best case can overestimate; Worst case errs low.')
    // The strip's figure and its day apart, for the asterisk between them; its text as before, which the phone draws.
    const strip = { cents: 124000, untilDay: '2026-11-14', risk: 'balanced' as const }
    assert.deepEqual(view.spendableParts(strip), { figure: '1,240', until: 'Nov 14' })
    assert.equal(view.spendableText(strip), '1,240 through Nov 14')
    // Settings: the three by their names, saving the setting the card's risks save, which still do.
    const settings = source('src/renderer/src/pages/Settings.tsx')
    assert.match(settings, /<Privacy \/>\s*<SpendSettings \/>/)
    assert.match(settings, /\{SPEND_RISKS\.map\(\(r\) => \(\s*<button key=\{r\.id\} role="radio" aria-checked=\{settings\.spendRisk === r\.id\}/)
    assert.match(settings, /api\.setSpendSettings\(\{ risk \}\)\.then\(reloadSettings/)
    const card = source('src/renderer/src/pages/Spendable.tsx')
    assert.match(card, /onClick=\{\(\) => spend\.risk !== r\.id && save\(\{ risk: r\.id \}\)\}/)
    // The asterisk on the chosen figure and on Home's strip, its line under the card and as the strip's tooltip.
    assert.match(card, /\{spend\.risk === r\.id && note && <span className="spend-mark">\*<\/span>\}/)
    assert.match(card, /\{note && <div className="spend-note muted small">\{note\}<\/div>\}/)
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.match(home, /<SpendableFigure strip=\{wf\.spendable\} \/>/)
    assert.match(home, /<span className="spend-mark" title=\{note\}>/)
    // The first run stays short: no step for it.
    assert.doesNotMatch(source('src/renderer/src/pages/Onboarding.tsx'), /setSpendSettings/)
  })
})

describe("Home over section 5's household", () => {
  let h: Household
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    h = household()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the default view: every row in whole dollars, Δ 3 mo with Committed as a cost, the focus dot on Left over, and Unsorted 2 · -16', () => {
    const w = month('2026-10')
    const t = view.homeTable(w, null)
    assert.deepEqual(rows(t.lines), [
      ['Gross pay', '6,000', '6,000', '', '0', false],
      ['Take-home', '3,777', '3,777', '63.0%', '0', false],
      ['Elective', '1,544', '1,571', '41.6%', '−35', false],
      ['Left over', '438', '551', '35.1%', '−105', true],
      ['Saved', '686', '1,189', '18.9%', '−120', false],
      ['Invested', '1,388', '1,138', '95.8%', '0', false],
      ['Growth', '2,140', '1,200', '0.5%', '', false]
    ])
    // Unsorted shows because it isn't 0; 16.00 is within the tolerance of 18.89, so the dot stays on Left over.
    assert.deepEqual(t.lines.filter((l) => l.kind === 'unsorted'), [{ kind: 'unsorted', count: 2, amount: '−16', focus: false, drill: view.unsortedFilter(w) }])
    assert.ok(!t.lines.some((l) => l.kind === 'unexplained'))
    assert.deepEqual([t.heading, t.perMonth], [{ amount: 'Oct', spark: '12 mo' }, false])
    // Nothing is open: no row's Δ pts, no less rows, no data lines.
    assert.ok(t.lines.every((l) => l.kind !== 'row' || (!l.open && !l.less && l.pts === null)))
    assert.ok(!t.lines.some((l) => l.kind === 'part' || l.kind === 'data'))
    // Each row's sparkline is the twelve months to October, its run rates as shown: Left over ends 655, 659, 608, 551.
    const left = t.lines.find((l) => l.kind === 'row' && l.id === 'leftOver') as RowLine
    assert.deepEqual([left.spark!.length, left.spark!.slice(-4)], [12, [65_500, 65_913, 60_813, 55_050]])
    // The span picker's marker: every month is open until snapshots (1h) close them.
    assert.deepEqual(view.spanMark(w.months), { mark: '○', title: 'Oct 2026 open' })
  })

  test('Take-home open: Taxes, Benefits and Saved at work at 0.0 pts, the W-4 lever and the employer adds', () => {
    // The pay-day table and the contributions between the lever and the employer adds are 2b's (test/drills.test.ts).
    assert.deepEqual(opened(month('2026-10'), 'takeHome'), {
      pts: '0.0 pts',
      under: [
        ['Taxes', '−1,431', '−1,431', '23.9%', '0'],
        ['Benefits', '−192', '−192', '3.2%', '0'],
        ['Saved at work', '−600', '−600', '10.0%', '0'],
        ['Levers', 'W-4 refund 85/mo +1.4 pts'],
        ['Limits', '401(k) 4,800 of 24,500 · HSA 1,680 of 4,400'],
        ['Employer adds', 'Match 240 · HSA 48 · Premium share 410'],
        ['', 'Pay & benefits · Taxes']
      ]
    })
    const atWork = view.homeTable(month('2026-10'), 'takeHome').lines.find((l) => l.kind === 'row' && l.id === 'savedAtWork') as RowLine
    assert.equal(atWork.to, 'saved')
  })

  test('Elective open: Committed -2,233 against -2,207 in force, and its levers Visa (24.0%) then Civic (6.4%)', () => {
    assert.deepEqual(opened(month('2026-10'), 'elective'), {
      pts: '−0.9 pts',
      under: [
        ['Committed', '−2,233', '−2,207', '58.4%', '−35'],
        ['Levers', 'Visa 24.0% interest 60/mo +1.6 pts · Civic Auto Loan 6.4% interest 48/mo +1.3 pts'],
        // Its groups between these are 2b's (test/drills.test.ts).
        ['Principal', 'Pinecrest Mortgage 805 · Civic Auto Loan 364 · Student Loan 214']
      ]
    })
  })

  test('Left over open: Everyday -1,106 against -1,020, -5.8 pts, dining out and coffee over their targets, and each category', () => {
    // Its targets and habits come beside the waterfall (getHomePlans, test/left-saved.test.ts).
    assert.deepEqual(opened(month('2026-10'), 'leftOver'), {
      pts: '−5.8 pts',
      under: [
        ['Everyday', '−1,106', '−1,020', '64.9%', '−70'],
        ['Levers', 'Dining Out over target 78/mo +5.0 pts · Coffee over target 32/mo +2.0 pts'],
        ['Dining Out', '−520', '−478', '−70'],
        ['Groceries', '−330', '−312', '0'],
        ['Coffee', '−151', '−132', '0'],
        ['Gas & Fuel', '−105', '−98', '0']
      ]
    })
  })

  test('Saved open: One-offs and its items, Kept, saving at work, where Kept went and what reconciles it', () => {
    // The goals and the debt plan's next target come beside the waterfall (getHomePlans, test/left-saved.test.ts).
    assert.deepEqual(opened(month('2026-10'), 'saved'), {
      pts: '−1.9 pts',
      under: [
        ['One-offs', '−640', '−250', '45.4%', '−15'],
        ['Items', 'One-off Goods 23 640'],
        ['Kept', '−202', '301', '−120'],
        ['Saved at work', '600', '600', '0'],
        ['Employer saving', '288', '288', '0'],
        // 300 + 500 + 1,233 - 1,974 = 59, and -202 + 220 + 57 - 16 = 59 (58.70).
        ['Went to', 'Savings 300 · Investments 500 · Debt paid down 1,233 · Checking −1,974'],
        ['Reconciling', 'Ventures +220 · Cash return +57 · Unsorted −16 · Unexplained 0 ✓']
      ]
    })
  })

  test('Invested open: its parts, the 401(k) and HSA room, and the retirement line', () => {
    assert.deepEqual(opened(month('2026-10'), 'invested'), {
      pts: '+8.7 pts',
      under: [
        ['Saved at work', '600', '600', '0'],
        ['Employer saving', '288', '288', '0'],
        ['From cash', '500', '250', '0'],
        ['Levers', '401(k) room 1,562/mo · HSA room 199/mo'],
        ['Retire at 65 in 2055', "1,853,239 today's dollars · invested 243,471 · +1,138/mo · 5.0% real"]
      ]
    })
    // More moved out of investments than went in: the run rate is below zero, with a true minus and no plus.
    const w = month('2026-10')
    const out = opened({ ...w, retirement: { ...w.retirement!, contributionCents: -45_000 } }, 'invested').under.at(-1)!
    assert.equal(out[1], "1,853,239 today's dollars · invested 243,471 · −450/mo · 5.0% real")
  })

  test('Growth open: returns and cash return, and net worth with its bridge', () => {
    // The returns by account between them, and the drill as a whole, are 2c's (test/invested-growth.test.ts).
    assert.deepEqual(opened(month('2026-10'), 'growth'), {
      pts: null,
      under: [
        ['Returns', '2,083 · Cash return 57'],
        ['Net worth 412,300', '+2,391 = Saved 686 + Growth 2,140 + Revaluation −130 + Ventures −289 + Unsorted −16 − In transit 0 − Unexplained 0 + Other 0'],
        ['TWR 12 mo', '6.2%'],
        ['', 'Investments · Net worth']
      ]
    })
  })

  test("Unsorted opens the Transactions list on its own lines: the same count and the same sum as the row", () => {
    // October's uncategorized lines also include the 401(k)'s and the HSA's, which are outside the ledger and never
    // Unsorted: the list is the row's two purchases and nothing else.
    // Since 2b the list takes Unsorted's own lines through linesFor, as every drill does: Personal's unsorted lines.
    const listed = (w: Waterfall): [number, number, string[]] => {
      const r = linesFor(lineQuery(view.unsortedFilter(w), TODAY)!, { limit: 1000 })
      return [r.total, r.cents, [...new Set(r.lines.map((l) => l.txnId))].sort()]
    }
    const oct = month('2026-10')
    assert.deepEqual(oct.unsorted, { cents: -1_600, count: 2, ids: [...h.unsorted].sort() })
    assert.deepEqual(view.unsortedFilter(oct), { month: '2026-10', toMonth: '2026-10', cls: ['unsorted'], owner: null, name: 'Unsorted' })
    assert.deepEqual(listed(oct), [2, -1_600, oct.unsorted.ids])
    const ytd = getWaterfall({ from: '2026-01', to: '2026-10' })
    assert.deepEqual(listed(ytd), [ytd.unsorted.count, ytd.unsorted.cents, ytd.unsorted.ids])
    // A span of days names its days.
    assert.deepEqual(view.unsortedFilter(getWaterfall({ from: '2026-10-09', to: '2026-11-07' })).fromDay, '2026-10-09')
    // With no lines, the list is empty, not every transaction.
    assert.equal(db.listTransactions({ ids: [] }).total, 0)
    assert.match(source('src/renderer/src/pages/HomeRows.tsx'), /<tr key="unsorted" className="waterfall-row extra" onClick=\{\(\) => onDrill\(l\.drill\)\}>/)
    assert.match(source('src/renderer/src/pages/Home.tsx'), /onDrill=\{\(f\) => go\('transactions', f\)\}/)
  })

  test('one row is open at a time, and Unexplained shows only above tolerance', () => {
    const w = month('2026-10')
    const lines = view.homeTable(w, 'saved').lines
    assert.deepEqual(
      lines.filter((l): l is RowLine => l.kind === 'row' && (l.open || l.less)).map((l) => l.name),
      ['Saved', 'One-offs']
    )
    // 40.00 left unexplained, above 18.89, shows with its items; 10.00 doesn't.
    const gap = (cents: number): Waterfall => ({ ...w, identity: { ...w.identity, unexplainedCents: cents }, months: w.months.map((m) => ({ ...m, unexplainedCents: cents })), leaks: [{ kind: 'balance_gap', cents, accountId: 'csv:chk', fromDay: '2026-09-30', toDay: '2026-10-31' }] })
    assert.ok(!view.homeTable(gap(1_000), null).lines.some((l) => l.kind === 'unexplained'))
    assert.deepEqual(view.homeTable(gap(4_000), null).lines.filter((l) => l.kind === 'unexplained'), [{ kind: 'unexplained', amount: '40', focus: false, open: false }])
    assert.deepEqual(
      view.homeTable(gap(4_000), 'unexplained', new Map([['csv:chk', 'Checking']])).lines.filter((l) => l.kind === 'data'),
      [{ kind: 'data', key: 'leak:0', label: 'Balance gap', text: 'Checking · Sep 30 – Oct 31 · 40' }]
    )
  })

  test('a YTD span: amounts summed, Per month beside the run rate, and the months in its heading', () => {
    const w = getWaterfall({ from: '2026-01', to: '2026-10' })
    const t = view.homeTable(w, null)
    assert.deepEqual([t.heading, t.perMonth], [{ amount: 'Jan–Oct', spark: '12 mo' }, true])
    for (const l of t.lines) {
      if (l.kind !== 'row') continue
      const r = w.rows.find((x) => x.id === l.id)!
      assert.equal(l.perMonth, view.dollars(r.perMonthCents!), l.name)
      assert.equal(l.amount, view.dollars(r.actualCents), l.name)
    }
    assert.equal(view.spanHeading({ from: '2025-11', to: '2026-10' }), 'Nov ’25–Oct ’26')
    assert.equal(view.spanHeading({ from: '2026-10-09', to: '2026-11-07' }), '30 days')
  })

  test("over twelve months, an open row's parts read as an average month too", () => {
    const w = getWaterfall({ from: '2025-11', to: '2026-10' })
    // Saved's parts and Invested's: Kept 4,605 over the year is 384 a month beside the run rate.
    for (const id of ['saved', 'invested'] as const) {
      const parts = view.homeTable(w, id).lines.filter((l) => l.kind === 'part')
      const row = w.rows.find((r) => r.id === id)!
      assert.deepEqual(
        parts.map((l) => [l.name, l.amount, l.perMonth]),
        row.parts.map((p) => [{ kept: 'Kept', atWork: 'Saved at work', employer: 'Employer saving' }[p.key] ?? p.name, view.dollars(p.actualCents), view.dollars(Math.round(p.actualCents / 12))]),
        id
      )
      assert.equal(row.parts.reduce((s, p) => s + p.perMonthCents!, 0), row.perMonthCents, id)
    }
    // A month has no Per month column, and its parts none either.
    assert.ok(month('2026-10').rows.every((r) => r.parts.every((p) => p.perMonthCents === null)))
  })

  test("the Walk's bars and the Sankey's nodes are the rows' amounts", () => {
    const w = month('2026-10')
    const steps = view.walkSteps(w)
    assert.deepEqual(
      steps.map((s) => [s.name, s.type, s.cents]),
      [
        ['Gross pay', 'total', 600_000],
        ['Taxes', 'sub', 143_100],
        ['Benefits', 'sub', 19_200],
        ['Saved at work', 'sub', 60_000],
        ['Take-home', 'total', 377_700],
        ['Committed', 'sub', 223_290],
        ['Elective', 'total', 154_410],
        ['Everyday', 'sub', 110_640],
        ['Left over', 'total', 43_770],
        ['One-offs', 'sub', 64_000],
        ['Kept', 'total', -20_230],
        ['Saved at work', 'add', 60_000],
        ['Employer saving', 'add', 28_800],
        ['Saved', 'total', 68_570]
      ]
    )
    // Each total is the one before it with the steps between applied: the chain ties to the cent.
    let run = 0
    for (const s of steps) {
      if (s.type === 'total') assert.equal(s.cents, run || s.cents, s.name)
      run = s.type === 'total' ? s.cents : run + (s.type === 'add' ? s.cents : -s.cents)
    }
    // October spent 202.30 beyond what was left: Savings or credit meets it beside Left over, so Saved takes in the
    // 600.00 saved at work and the 288.00 the employer saved and reads 685.70, the row.
    const f = view.sankeyFlow(w)
    const node = (name: string): number => f.nodes.find((n) => n.name === name)?.cents ?? NaN
    assert.deepEqual(
      ['Gross pay', 'Taxes', 'Benefits', 'Saved at work', 'Take-home', 'Committed', 'Elective', 'Everyday', 'Left over', 'One-offs', 'Savings or credit', 'Employer saving', 'Saved'].map(node),
      [600_000, 143_100, 19_200, 60_000, 377_700, 223_290, 154_410, 110_640, 43_770, 64_000, 20_230, 28_800, 88_800]
    )
    const savedNode = f.nodes.findIndex((n) => n.name === 'Saved')
    assert.equal(f.nodes[savedNode].shownCents, 68_570)
    assert.ok(!f.nodes.some((n) => n.name === 'Kept'))
    for (let i = 0; i < f.nodes.length; i++) {
      const inflow = f.links.filter((l) => l.target === i).reduce((s, l) => s + l.value, 0)
      const outflow = f.links.filter((l) => l.source === i).reduce((s, l) => s + l.value, 0)
      if (i === savedNode) assert.equal(inflow - outflow, 88_800, 'Saved takes in its row and what Savings or credit met')
      else if (inflow && outflow) assert.equal(inflow, outflow, `${f.nodes[i].name} in and out`)
    }
    // With no paystub, nothing is saved at work: Saved is -202.30, what Savings or credit met, and nothing flows into it.
    const deposits = view.sankeyFlow({ ...w, rows: w.rows.map((r) => (r.id === 'saved' ? { ...r, actualCents: -20_230, parts: r.parts.map((p) => (p.key === 'kept' ? p : { ...p, actualCents: 0 })) } : r)) })
    assert.ok(!deposits.nodes.some((n) => n.name === 'Saved'))
    assert.deepEqual(
      deposits.nodes.filter((n) => n.name === 'Savings or credit').map((n) => [n.cents, n.shownCents]),
      [[20_230, 20_230]]
    )
    // Over the twelve months to October, Kept is above 0: Kept, Saved at work and employer saving make Saved.
    const year = getWaterfall({ from: '2025-11', to: '2026-10' })
    const saved = year.rows.find((r) => r.id === 'saved')!
    assert.ok(saved.parts.find((p) => p.key === 'kept')!.actualCents > 0)
    const y = view.sankeyFlow(year)
    assert.equal(y.nodes.find((n) => n.name === 'Saved')!.cents, saved.actualCents)
    assert.ok(!y.nodes.some((n) => n.name === 'Savings or credit'))
  })

  test('Home renders the rows as it lays them out: names in order, figures, the focus dot, the open row with its levers', () => {
    const html = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(month('2026-10'), 'leftOver'), onOpen: () => {}, onDrill: () => {} }))
    const names = [...html.matchAll(/<th scope="row" class="name">(?:<span class="part-name">)?(?:<button[^>]*>|<span[^>]*>)([^<]+)/g)].map((m) => m[1].trim())
    assert.deepEqual(names, ['Gross pay', 'Take-home', 'Elective', 'Left over', 'Everyday', 'Dining Out', 'Groceries', 'Coffee', 'Gas &amp; Fuel', 'Saved', 'Invested', 'Growth', 'Unsorted'])
    const row = (name: string): string => {
      const at = html.indexOf(`>${name}<`)
      return html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at))
    }
    assert.deepEqual([...row('Left over').matchAll(/<td class="num[^"]*">([^<]*)/g)].map((m) => m[1]), ['438', '551', '35.1%', '−105'])
    assert.match(row('Left over'), /class="focus-dot"/)
    assert.match(row('Left over'), /<span class="pts">−5\.8 pts<\/span>/)
    assert.match(row('Left over'), /aria-expanded="true"/)
    assert.doesNotMatch(row('Saved'), /focus-dot/)
    assert.deepEqual([...row('Everyday').matchAll(/<td class="num[^"]*">([^<]*)/g)].map((m) => m[1]), ['−1,106', '−1,020', '64.9%', '−70'])
    assert.match(html, /<span class="label-muted">Levers<\/span><span class="data-text">Dining Out over target 78\/mo \+5\.0 pts · Coffee over target 32\/mo \+2\.0 pts<\/span>/)
    // Twelve bars a row; none under the rows of the open one.
    assert.equal((row('Growth').match(/<rect /g) ?? []).length, 12)
    assert.doesNotMatch(row('Everyday'), /<rect /)
  })

  test('a sparkline past two years of months is a line through them, not bars under a pixel wide', () => {
    const t = view.homeTable(getWaterfall({ from: '2024-11', to: '2026-10' }), null)
    const spark = (table: typeof t, months: number): string => {
      const rows = table.lines.map((l) => (l.kind === 'row' ? { ...l, spark: Array.from({ length: months }, (_, i) => (l.spark![i % l.spark!.length] ?? 0) + i) } : l))
      return renderToStaticMarkup(createElement(HomeRows, { table: { ...table, lines: rows }, onOpen: () => {}, onDrill: () => {} }))
    }
    // The household's 24 months are still bars, one a month.
    assert.equal(t.heading.spark, '24 mo')
    assert.equal((spark(t, 24).match(/<rect /g) ?? []).length, 24 * 7)
    // 61 months (a ledger's All) are one line a row, its latest month marked.
    const long = spark(t, 61)
    assert.doesNotMatch(long, /<rect /)
    assert.equal((long.match(/<path d="M[^"]+" class="spark-line"/g) ?? []).length, 7)
    assert.equal((long.match(/<circle [^>]*class="spark-bar last/g) ?? []).length, 7)
  })

  test("one getWaterfall per span, with the Spendable strip in it; opening a row asks for at most its drill's one call", async () => {
    const r = await answer('getWaterfall', [{ from: '2026-10', to: '2026-10' }], web())
    assert.ok(r.ok)
    assert.deepEqual((r.data as Waterfall).spendable, spendableStrip())
    assert.equal(getWaterfall({ from: '2026-10', to: '2026-10' }).spendable, null)
    assert.equal((r.data as Waterfall).firstMonth, '2024-11')
    // Home's reads (its subscriptions aside): the waterfall in one place, keyed by the span; the rows component reads
    // nothing. Opening the Spendable strip or Elective reads the forecast, Take-home the contributions (2b), and Left
    // over or Saved their plans (2c), each once a data change, whatever the row or span, so switching rows and spans
    // asks for nothing Home has.
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.deepEqual([...home.matchAll(/api\.(?!on[A-Z])(\w+)\(/g)].map((m) => m[1]).sort(), ['getHomePlans', 'getInsight', 'getSpendable', 'getWaterfall', 'listAccounts', 'listContributions'])
    assert.match(home, /const wantPlans = open === 'leftOver' \|\| open === 'saved'/)
    // The plans are kept for the window with the data change they answer, so coming back to Home asks for them again
    // only after a change.
    assert.match(home, /^const plansKept: \{ tick: number; plans: HomePlans \| null \} = \{ tick: -1, plans: null \}$/m)
    assert.match(home, /useState<HomePlans \| null>\(plansKept\.plans\)/)
    assert.match(home, /if \(!wantPlans \|\| plansKept\.tick === tick\) return\s*plansKept\.tick = tick\s*api\.getHomePlans\(\)/)
    assert.match(home, /const wantSpend = spendOpen \|\| open === 'elective'/)
    assert.match(home, /if \(!wantSpend \|\| spendAsked\.current === tick\) return\s*spendAsked\.current = tick\s*api\.getSpendable\(\)/)
    assert.match(home, /const wantContrib = open === 'takeHome'/)
    assert.match(home, /if \(!wantContrib \|\| contribAsked\.current === tick\) return\s*contribAsked\.current = tick\s*api\.listContributions\(\)/)
    assert.doesNotMatch(source('src/renderer/src/pages/HomeRows.tsx'), /\bapi\b/)
    assert.doesNotMatch(source('src/renderer/src/pages/homeView.ts'), /\bapi\./)
  })
})

describe('Home over variations on the household', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('deposits only: Gross pay and Take-home are one row, Saved -202 at 8.0% and Invested 500 at 83.2%', () => {
    household({ paystubs: false })
    assert.deepEqual(rows(view.homeTable(month('2026-10'), null).lines), [
      ['Take-home', '3,777', '3,777', '', '0', false],
      ['Elective', '1,544', '1,571', '41.6%', '−35', false],
      ['Left over', '438', '551', '35.1%', '−105', true],
      ['Saved', '−202', '301', '8.0%', '−120', false],
      ['Invested', '500', '250', '83.2%', '0', false],
      ['Growth', '2,140', '1,200', '0.5%', '', false]
    ])
    // Take-home open shows where it came from, the pay Gross pay would have held: Brightline's deposits.
    const w = month('2026-10')
    const take = w.rows.find((r) => r.id === 'takeHome')!
    assert.equal(take.parts.reduce((s, p) => s + p.actualCents, 0), take.actualCents)
    assert.equal(take.parts.reduce((s, p) => s + (p.runRateCents ?? 0), 0), take.runRateCents)
    assert.deepEqual(opened(w, 'takeHome'), {
      pts: null,
      under: [
        ['Brightline Payroll', '3,777', '3,777', '0'],
        ['Levers', 'W-4 refund 85/mo'],
        ['', 'Pay & benefits · Taxes']
      ]
    })
    // The Sankey's Take-home opens into the same sources when there's more than one.
    assert.equal(view.sankeyFlow(w).nodes.find((n) => n.name === 'Take-home')!.cents, take.actualCents)
  })

  test('over a span, Unexplained shows when a month of it is above its tolerance, not when the months add past one', () => {
    household()
    // 10.00 of groceries the balances don't show, in each month from January to October: each month is 10.00 off,
    // within its 18.89, though the ten add up to 100.00.
    for (let m = 1; m <= 10; m++) line(ACCOUNTS.checking, `2026-${String(m).padStart(2, '0')}-10`, -1_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    const ytd = getWaterfall({ from: '2026-01', to: '2026-10' })
    assert.equal(ytd.identity.unexplainedCents, -10_000)
    assert.ok(ytd.months.every((m) => m.unexplainedCents === -1_000 && m.toleranceCents > 1_000), JSON.stringify(ytd.months))
    assert.ok(!view.homeTable(ytd, null).lines.some((l) => l.kind === 'unexplained'))
    assert.match(opened(ytd, 'saved').under.find(([label]) => label === 'Reconciling')![1], /Unexplained −100 ✓$/)
    // 30.00 off one way in September and back the other in October: the span adds to nothing, but both months are
    // above tolerance, so Unexplained shows, with its items.
    household()
    line(ACCOUNTS.checking, '2026-09-10', -3_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    line(ACCOUNTS.checking, '2026-10-10', 3_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    const two = getWaterfall({ from: '2026-09', to: '2026-10' })
    assert.equal(two.identity.unexplainedCents, 0)
    assert.deepEqual(two.months.map((m) => m.unexplainedCents), [-3_000, 3_000])
    assert.deepEqual(view.homeTable(two, null).lines.filter((l) => l.kind === 'unexplained'), [{ kind: 'unexplained', amount: '0', focus: true, open: false }])
    assert.match(opened(two, 'saved').under.find(([label]) => label === 'Reconciling')![1], /Unexplained 0 !$/)
  })

  test('Unsorted at -86.00 (3 lines) takes the focus dot from Left over', () => {
    household({ unsorted86: true })
    const w = month('2026-10')
    const lines = view.homeTable(w, null).lines
    assert.deepEqual(lines.filter((l) => l.kind === 'unsorted'), [{ kind: 'unsorted', count: 3, amount: '−86', focus: true, drill: view.unsortedFilter(w) }])
    assert.ok(rows(lines).every(([, , , , , focus]) => !focus))
  })

  test('uncategorized money is Unsorted everywhere (Decision 13): not a venture\'s income, and not a Budget one-off', async () => {
    const h = household()
    const { getRangeSummary } = await import('../src/main/summary.ts')
    const { getBudget } = await import('../src/main/budget.ts')
    const before = getRangeSummary('2026-10', '2026-10', [h.venture])
    // 50.00 into the venture's own account with no category: it's no income of the venture's until it's categorized.
    // 25.00 out of it with none is still the venture's spending, as it was.
    line(ACCOUNTS.studio, '2026-10-26', 5_000, 'DEPOSIT 5521')
    line(ACCOUNTS.studio, '2026-10-27', -2_500, 'POS PURCHASE 7781')
    // The account's auto rule puts them in the venture, as a sync would.
    db.applyBucketRules()
    const after = getRangeSummary('2026-10', '2026-10', [h.venture])
    assert.deepEqual([after.incomeCents, after.spendCents], [before.incomeCents, before.spendCents + 2_500])
    assert.ok(!after.incomeBySource.some((s) => s.name === 'Uncategorized'))
    // October's two uncategorized purchases, 16.00, are in no Budget row and no one-off.
    const b = getBudget('2026-10')
    assert.ok(!b.oneOffs.categories.includes('Uncategorized'))
    assert.ok(!b.rows.some((r) => r.categoryId === null || r.name === 'Uncategorized'))
    assert.ok(!b.oneOffs.items.some((i) => h.unsorted.includes(i.id)))
    assert.equal(b.oneOffs.spentCents, 64_000)
  })

  test("an uncategorized purchase marked one-time or bought on a trip is a one-off in Budget as on Home, not Unsorted", async () => {
    household()
    const { getBudget } = await import('../src/main/budget.ts')
    const { saveTrip } = await import('../src/main/trips.ts')
    // 300.00 with no category, marked one-time, and 45.00 with none bought on a trip: the classifier's One-offs both.
    const marked = line(ACCOUNTS.checking, '2026-10-20', -30_000, 'POS PURCHASE 6120')
    db.setOneTime([marked], true)
    saveTrip({ name: 'Lake weekend', from: '2026-10-29', to: '2026-10-30' })
    const away = line(ACCOUNTS.checking, '2026-10-29', -4_500, 'POS PURCHASE 8834')
    const w = month('2026-10')
    const oneOffs = w.rows.find((r) => r.id === 'oneOffs')!
    assert.equal(oneOffs.actualCents, 64_000 + 30_000 + 4_500)
    assert.deepEqual([w.unsorted.cents, w.unsorted.count], [-1_600, 2])
    const b = getBudget('2026-10')
    assert.equal(b.oneOffs.spentCents, oneOffs.actualCents)
    assert.deepEqual(b.oneOffs.items.filter((i) => i.id === marked || i.id === away).map((i) => [i.id, i.cents, i.trip]), [
      [marked, 30_000, null],
      [away, 4_500, 'Lake weekend']
    ])
    // The trip's own total counts the same purchase its one-offs do.
    assert.equal(b.trips.find((t) => t.name === 'Lake weekend')!.spentCents, 4_500)
  })
})

describe("Home's data labels", () => {
  test('Home keeps its own Rows, Walk or Sankey choice, the Sankey until one is picked: a chart picked on the old Dashboard counts for nothing', async () => {
    // Flow's helpers module reads the preload's api as it loads; nothing here calls it.
    const g = globalThis as { window?: unknown }
    const hadWindow = 'window' in g
    g.window ??= {}
    const { useFlowView } = await import('../src/renderer/src/Flow.tsx')
    if (!hadWindow) delete g.window
    const store = new Map<string, string>([['flow.view', 'walk']])
    const was = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)) } })
    try {
      // As Home asks, with the row this viewer left open (home.row) on arrival.
      const seen = (row?: Opened): string => {
        let v = ''
        const Probe = (): null => {
          ;[v] = useFlowView(view.HOME_VIEWS, view.HOME_VIEW_KEY, () => view.arrivalView(row))
          return null
        }
        renderToStaticMarkup(createElement(Probe))
        return v
      }
      // The Dashboard's flow card and the Recurring page kept their chart under 'flow.view'; Home reads its own.
      assert.equal(seen(), 'sankey')
      // A row open on arrival shows in the rows, the only view that draws it; Spendable's strip sits above every view.
      assert.equal(seen('saved'), 'rows')
      assert.equal(seen('unexplained'), 'rows')
      assert.equal(seen('spendable'), 'sankey')
      assert.equal(seen(null), 'sankey')
      // A view picked here wins over both.
      store.set(view.HOME_VIEW_KEY, 'walk')
      assert.equal(seen(), 'walk')
      assert.equal(seen('saved'), 'walk')
      store.set(view.HOME_VIEW_KEY, 'rows')
      assert.equal(seen(), 'rows')
    } finally {
      if (was) Object.defineProperty(globalThis, 'localStorage', was)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
    assert.equal(view.HOME_DEFAULT_VIEW, 'sankey')
    // The toggle keeps its order.
    assert.deepEqual(view.HOME_VIEWS, ['rows', 'walk', 'sankey'])
    // Home asks so; home.open's row on arrival, or a row asked for by go() or a notification, opens in the rows, shown
    // for now and kept nowhere, so the view picked (or none) stays as it was.
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.match(home, /useFlowView\(HOME_VIEWS, HOME_VIEW_KEY, \(\) => arrivalView\(keptRow\(\)\)\)/)
    assert.match(home, /if \(!viewPicked\) showView\(arrivalView\(settings\.homeOpen\)\)/)
    assert.match(home, /if \(request\.open && request\.open !== 'spendable'\) showView\('rows'\)/)
    assert.match(home, /<FlowViewToggle view=\{shownView\} onChange=\{setView\} views=\{HOME_VIEWS\} \/>/)
  })

  test('with no view picked, the Sankey gives way to the rows at a phone\'s width and when it has nothing to draw; one picked stays', () => {
    type Flow = Parameters<typeof view.shownHomeView>[0]['flow']
    const drawn = { nodes: [{ name: 'Gross pay', cents: 100, kind: 'income', column: 0 }, { name: 'Take-home', cents: 100, kind: 'income', column: 1 }], links: [{ source: 0, target: 1, value: 100 }] } as Flow
    // What sankeyFlow gives with nothing sorted: no band to draw.
    const empty = { nodes: [], links: [] } as Flow
    const shown = (o: Partial<Parameters<typeof view.shownHomeView>[0]>): string => view.shownHomeView({ flowOn: true, view: 'sankey', picked: false, flow: drawn, narrow: false, ...o })
    assert.equal(shown({}), 'sankey')
    // Its columns need about 560 px; a phone has 288 to 382 for it.
    assert.equal(shown({ narrow: true }), 'rows')
    // Nothing sorted yet (a first import with no AI): the rows, where Unsorted is.
    assert.equal(shown({ flow: empty }), 'rows')
    // Still loading: the Sankey's own placeholder.
    assert.equal(shown({ flow: null }), 'sankey')
    // Picked here, it stays, on a phone and empty too.
    assert.equal(shown({ picked: true, narrow: true }), 'sankey')
    assert.equal(shown({ picked: true, flow: empty }), 'sankey')
    // Walk and the rows are as picked; without the money flow feature, the rows.
    assert.equal(shown({ view: 'walk', narrow: true }), 'walk')
    assert.equal(shown({ flowOn: false }), 'rows')
    // Home follows the window's width as it changes.
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.match(home, /const shownView = shownHomeView\(\{ flowOn, view, picked: viewPicked, flow, narrow \}\)/)
    assert.match(home, /q\.addEventListener\('change', follow\)/)
  })

  test('levers lead with interest, the highest rate first and one with no rate after, then the rest by amount (Decision 19)', () => {
    const lever = (kind: Lever['kind'], name: string, monthlyCents: number, aprBp: number | null, ratePts: number | null = null): Lever => ({ stage: 'elective', kind, name, monthlyCents, aprBp, ratePts, drill: null, estimated: false })
    const levers = [lever('price_change', 'Netflix', 250, null, 0.1), lever('loan_interest', 'Pinecrest Mortgage', 80_000, 375, 21.2), lever('loan_interest', 'Family loan', 9_000, null), lever('card_interest', 'Visa', 6_000, 2_400, 1.6)]
    assert.equal(view.leverLine(levers, 'elective'), 'Visa 24.0% interest 60/mo +1.6 pts · Pinecrest Mortgage 3.75% interest 800/mo +21.2 pts')
    assert.equal(view.leverLine(levers.filter((l) => l.kind !== 'card_interest' && l.aprBp === null), 'elective'), 'Family loan interest 90/mo · Netflix price up 3/mo +0.1 pts')
    assert.equal(view.leverLine(levers, 'saved'), null)
  })

  test("the span's marker: Δ when a closed month changed, ! with a gap, ○ with the open month, ✓ when every month is closed", () => {
    const m = (month: string, status: Waterfall['months'][number]['status'], origin: Waterfall['months'][number]['origin'] = 'auto'): Waterfall['months'][number] => ({ month, status, origin })
    assert.equal(view.spanMark([m('2026-09', 'closed'), m('2026-10', 'closed')]).mark, '✓')
    assert.equal(view.spanMark([m('2026-09', 'closed'), m('2026-10', 'closed'), m('2026-11', 'open', null)]).mark, '○')
    assert.equal(view.spanMark([m('2026-09', 'gap'), m('2026-11', 'open', null)]).mark, '!')
    assert.deepEqual(view.spanMark([m('2026-08', 'closed', 'backfill'), m('2026-09', 'gap'), m('2026-10', 'changed')]), { mark: 'Δ', title: 'Aug 2026 closed (backfill)\nSep 2026 gap\nOct 2026 changed' })
  })

  test('whole dollars round half away from zero from their own cents, with a true minus', () => {
    assert.deepEqual([view.dollars(157_050), view.dollars(-220_650), view.dollars(43_770), view.dollars(-49), view.dollars(-50), view.dollars(0)], ['1,571', '−2,207', '438', '0', '−1', '0'])
    assert.deepEqual([view.signed(22_000), view.signed(-1_600), view.signed(0)], ['+220', '−16', '0'])
    assert.deepEqual([view.pct(63), view.pct(-5.2), view.pct(null)], ['63.0%', '−5.2%', ''])
    assert.deepEqual([view.pts(8.7), view.pts(-0.9), view.pts(0)], ['+8.7 pts', '−0.9 pts', '0.0 pts'])
  })

  test("the span picker's presets move with the date, and Home opens on the last full month", () => {
    assert.deepEqual(view.defaultSpan('2026-11-07'), { from: '2026-10', to: '2026-10' })
    assert.deepEqual(
      view.PRESETS.map((id) => view.presetSpan(id, '2026-11-07', '2024-11')),
      [
        { from: '2026-10-09', to: '2026-11-07' },
        { from: '2026-11', to: '2026-11' },
        { from: '2026-01', to: '2026-11' },
        { from: '2025-12', to: '2026-11' },
        { from: '2024-11', to: '2026-11' }
      ]
    )
    assert.equal(view.presetSpan('All', '2026-11-07', null), null)
  })

  test('a preset is kept by the name clicked, though two presets are the same span that day', () => {
    // On December 5, YTD and 12M are both January to December; picked as 12M, it's the last twelve months in January.
    assert.deepEqual(view.presetSpan('YTD', '2026-12-05', null), view.presetSpan('12M', '2026-12-05', null))
    const twelve = view.keptSpan({ from: '2026-01', to: '2026-12' }, '12M', '2026-12-05')
    assert.deepEqual(twelve, { preset: '12M', span: { from: '2026-01', to: '2026-12' } })
    assert.deepEqual(view.spanOf(JSON.parse(JSON.stringify(twelve)), '2027-01-12'), { span: { from: '2026-02', to: '2027-01' }, preset: '12M' })
    // On January 12, MTD and YTD are both January; picked as YTD, it's January and February in February.
    assert.deepEqual(view.spanOf(view.keptSpan({ from: '2027-01', to: '2027-01' }, 'YTD', '2027-01-12'), '2027-02-03'), { span: { from: '2027-01', to: '2027-02' }, preset: 'YTD' })
    assert.deepEqual(view.spanOf(view.keptSpan({ from: '2027-01', to: '2027-01' }, 'MTD', '2027-01-12'), '2027-02-03'), { span: { from: '2027-02', to: '2027-02' }, preset: 'MTD' })
    // The last full month moves with the date; any other span stays as picked; All keeps where it began.
    assert.deepEqual(view.spanOf(view.keptSpan({ from: '2026-10', to: '2026-10' }, null, '2026-11-07'), '2026-12-02'), { span: { from: '2026-11', to: '2026-11' }, preset: null })
    assert.deepEqual(view.spanOf(view.keptSpan({ from: '2026-03', to: '2026-06' }, null, '2026-11-07'), '2026-12-02'), { span: { from: '2026-03', to: '2026-06' }, preset: null })
    assert.deepEqual(view.spanOf({ preset: 'All', span: { from: '2024-11', to: '2026-11' } }, '2027-01-02'), { span: { from: '2024-11', to: '2027-01' }, preset: 'All' })
    assert.deepEqual(view.spanOf(null, '2026-11-07'), { span: { from: '2026-10', to: '2026-10' }, preset: null })
    // Only the preset picked shows pressed.
    const picker = source('src/renderer/src/pages/SpanPicker.tsx')
    assert.match(picker, /const on = preset \? p\.id === preset : /)
    assert.match(picker, /onClick=\{\(\) => onChange\(p\.span, p\.id\)\}/)
  })

  test("Home's styles: the app's focus ring on its controls, names that wrap from the left, sparklines at 3:1", async () => {
    const css = source('src/renderer/src/styles.css')
    const ring = /:where\(([^)]+)\):focus-visible \{\s*outline: 2px solid var\(--focus\)/.exec(css)![1].split(',').map((s) => s.trim())
    for (const c of ['.row-name', '.home-strip', '.home-headline-text', '.chip']) assert.ok(ring.includes(c), c)
    assert.match(css, /\.home-rows \.row-name \{[^}]*text-align: left;/)
    // At 900 the desktop app leaves the picker 520 px beside its caption buttons: the presets tighten to fit whole,
    // and narrower still the picker wraps rather than clip them.
    assert.match(css, /\.span-picker \{\s*display: flex;\s*flex-wrap: wrap;/)
    assert.match(css, /@media \(max-width: 1100px\) \{\s*\.span-picker \{\s*gap: 6px;\s*\}\s*\.span-picker \.segmented button \{\s*padding: 6px 5px;/)
    // The bars on the open and hovered rows are --ink-400: --ink-500 is 2.95:1 on the open row's wash in the dark.
    assert.match(css, /\.home-rows tr\.open \.spark-bar:not\(\.last\):not\(\.neg\),\s*\.home-rows tr\.waterfall-row:hover \.spark-bar:not\(\.last\):not\(\.neg\) \{\s*fill: var\(--ink-400\);/)
    const { measure } = await import('../scripts/contrast.ts')
    const home = measure(css).filter((p) => /^page (wash|hover|well)$/.test(p.bg))
    assert.ok(home.length >= 20)
    assert.deepEqual(home.filter((p) => p.ratio < p.floor), [])
  })

  test("Home's edges: no Spendable card without its strip, a new span's figures dimmed until they come, no empty headline", () => {
    const home = source('src/renderer/src/pages/Home.tsx')
    // Spendable opens only when there's a strip to close it with (a current balance).
    assert.match(home, /const spendOpen = open === 'spendable' && !!wf\?\.spendable/)
    // The figures shown are the answer's span's: a newer span dims them until its own arrive, or fail.
    assert.match(home, /const stale = !!answer && \(answer\.span\.from !== span\.from \|\| answer\.span\.to !== span\.to\)/)
    assert.match(home, /className=\{stale \? 'home-stale' : undefined\} aria-busy=\{stale\}/)
    assert.match(home, /failed \? <div className="card empty">\{failed\}<\/div>/)
    // No headline is no line at all, and a cut one keeps its words in its title.
    assert.match(home, /if \(!insight\) return null/)
    assert.match(home, /const title = \[insight\.headline, insight\.detail\]/)
  })
})

describe("Home's marker over the months' closes", () => {
  // Section 2's tie-out household: May to September tie out, and October's Checking is 40.00 short, above its 20.00
  // tolerance. The books' first close is a backfill of every past month.
  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
    await closeDueMonths()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("the marker reads each month's close from the handler: ✓ a closed month, ! the gap, ○ the open month, each a backfill in its title", async () => {
    const read = async (from: string, to: string): Promise<Waterfall> => {
      const r = await answer('getWaterfall', [{ from, to }], web())
      assert.ok(r.ok)
      return r.data as Waterfall
    }
    const [september, october, november, three] = [await read('2026-09', '2026-09'), await read('2026-10', '2026-10'), await read('2026-11', '2026-11'), await read('2026-09', '2026-11')]
    assert.deepEqual(view.spanMark(september.months), { mark: '✓', title: 'Sep 2026 closed (backfill)' })
    assert.deepEqual(view.spanMark(october.months), { mark: '!', title: 'Oct 2026 gap (backfill)' })
    assert.deepEqual(view.spanMark(november.months), { mark: '○', title: 'Nov 2026 open' })
    // A gap comes before the open month, and the title lists every month.
    assert.deepEqual(view.spanMark(three.months), { mark: '!', title: 'Sep 2026 closed (backfill)\nOct 2026 gap (backfill)\nNov 2026 open' })
    // The month closed as a gap is the month Home shows Unexplained in, judged against the same tolerance.
    assert.deepEqual([view.unexplainedAbove(september), view.unexplainedAbove(october), view.unexplainedAbove(three)], [false, true, true])
    assert.equal(view.homeTable(october, null).lines.filter((l) => l.kind === 'unexplained').length, 1)
    assert.equal(view.homeTable(september, null).lines.filter((l) => l.kind === 'unexplained').length, 0)
  })
})

describe('Home over a month changed since its close', () => {
  // Section 5's CHANGED MONTHS: the 48.00 September meal moved from Travel to Dining out on the Transactions page,
  // after the books closed.
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

  /** The closed figures under the rows: name, today's, the close's, and today's less the close's. */
  const closed = (w: Waterfall, open: Opened): string[][] =>
    view
      .homeTable(w, open)
      .lines.flatMap((l) => (l.kind === 'closed' ? [[l.name, l.now, l.closed, l.change]] : []))

  test("September's Everyday shows -1,100 closed -1,052 -48, and October's Everyday and Left over run rates -1,036 closed -1,020 and 535 closed 551, each -16; the marker is Δ", () => {
    const september = month('2026-09')
    const october = month('2026-10')
    assert.deepEqual(view.spanMark(september.months), { mark: 'Δ', title: 'Sep 2026 changed (backfill)' })
    assert.deepEqual(view.spanMark(october.months), { mark: 'Δ', title: 'Oct 2026 changed (backfill)' })
    assert.deepEqual(closed(september, 'leftOver').find((l) => l[0] === 'Everyday'), ['Everyday', `${view.MINUS}1,100`, `${view.MINUS}1,052`, `${view.MINUS}48`])
    // October's amounts didn't move; every figure that did shows: its run rates, the rates they make, their changes
    // over 3 months (from July's 950.00, 655.00 and 1,308.00) and the rates' changes. Left over is 534.50 against
    // 550.50 of Elective's 1,570.50 (34.0% against 35.1%), Everyday 1,036.00 (66.0% against 64.9%), Saved 1,176.50
    // of 6,288.00 (18.7% against 18.9%), and Invested's 1,138.00 is 96.7% of the lower Saved, not 95.8%.
    const m = view.MINUS
    assert.deepEqual(closed(october, 'leftOver'), [
      ['Left over run rate', '535', '551', `${m}16`],
      ['Left over rate', '34.0%', '35.1%', `${m}1.1 pts`],
      ['Left over Δ 3 mo', `${m}121`, `${m}105`, `${m}16`],
      ['Left over Δ pts', `${m}6.8 pts`, `${m}5.8 pts`, `${m}1.0 pts`],
      ['Everyday run rate', `${m}1,036`, `${m}1,020`, `${m}16`],
      ['Everyday rate', '66.0%', '64.9%', '+1.1 pts'],
      ['Everyday Δ 3 mo', `${m}86`, `${m}70`, `${m}16`],
      ['Everyday Δ pts', '+6.8 pts', '+5.8 pts', '+1.0 pts'],
      // Under its own line in Left over's categories, Dining Out's run rate of 494.00 against 478.00 and its change
      // over 3 months from 408.00; a category shows no rate, so its closed rate isn't drawn.
      ['Dining Out run rate', `${m}494`, `${m}478`, `${m}16`],
      ['Dining Out Δ 3 mo', `${m}86`, `${m}70`, `${m}16`],
      ['Saved run rate', '1,177', '1,189', `${m}12`],
      ['Saved rate', '18.7%', '18.9%', `${m}0.2 pts`],
      ['Saved Δ 3 mo', `${m}132`, `${m}120`, `${m}12`],
      ['Saved Δ pts', `${m}2.1 pts`, `${m}1.9 pts`, `${m}0.2 pts`],
      ['Invested rate', '96.7%', '95.8%', '+0.9 pts'],
      ['Invested Δ pts', '+9.7 pts', '+8.7 pts', '+1.0 pts']
    ])
    // Closed, Left over stands for Everyday, whose lines show once it's open.
    assert.deepEqual(closed(october, null).filter((l) => l[0].startsWith('Everyday')), [])
    // A month that didn't change shows none, and the rows draw the closed figures with their data label alone.
    assert.deepEqual(closed(month('2026-08'), 'leftOver'), [])
    const html = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(october, 'leftOver'), onOpen: () => {}, onUnsorted: () => {} }))
    assert.match(html, /<tr class="closed"><th scope="row" class="name">Everyday run rate<\/th><td class="num">−1,036<\/td><td class="num"><span class="label-muted">closed<\/span> −1,020<\/td><td><\/td><td class="num">−16<\/td>/)
  })

  test('a figure whose whole dollars would move by other than what it moved by shows in dollars and cents: 534.50 against 534.49, and 535.49 against 533.50', () => {
    const october = month('2026-10')
    const at = (now: number, was: number): string[] | undefined => {
      const w = structuredClone(october)
      const s = w.closed!.byStage.find((x) => x.id === 'leftOver')!
      s.nowRunRateCents = now
      s.closedRunRateCents = was
      return closed(w, 'leftOver').find((l) => l[0] === 'Left over run rate')
    }
    // 535 against 534 for a move of 0.01, and of 1.99.
    assert.deepEqual(at(53_450, 53_449), ['Left over run rate', '534.50', '534.49', '0.01'])
    assert.deepEqual(at(53_549, 53_350), ['Left over run rate', '535.49', '533.50', '1.99'])
    // Whole dollars that move by what the figure did stay whole: 535 against 551 is 16.00 less.
    assert.deepEqual(at(53_450, 55_050), ['Left over run rate', '535', '551', `${view.MINUS}16`])
    assert.deepEqual(at(53_400, 53_300), ['Left over run rate', '534', '533', '1'])
  })
})
