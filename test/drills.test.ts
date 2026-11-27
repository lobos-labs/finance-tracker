import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HandlerContext } from '../src/main/handlers/context.ts'
import type { ClassifiedLine, LineQuery, PayCheck, Spendable, StageId, Waterfall } from '../src/shared/types.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import { budgetRatio, busyMs, paired, repeatedMs, within } from './cost.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS, household, KEY, line, TODAY } from './fixtures/waterfall-household.ts'

// Take-home's and Elective's drills (waterfall spec sub-phase 2b): every part opens the Transactions list on
// exactly its lines, and they add up to the part, on section 5's household, the sample household, the section 2
// tie-out and a payroll with deposits alone; the pay-day table and the Elective groups as section 5 draws them; the
// By date list and the Calendar's next 30 days as one list from one forecast; the Transactions filter of Everyday
// gas in October; the Contributions list from its new home; and what a drill costs on a large ledger.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place. The renderer's .tsx load through
// the same transform the app's bundler uses (Vite's Rolldown), and the pages read window.api and the location as
// the app's window has them, so a component renders here as it does there.
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
const { configureLicense } = await import('../src/main/license.ts')
const { getWaterfall } = await import('../src/main/waterfall.ts')
const { classifyLines, linesFor } = await import('../src/main/lines.ts')
const { getSpendable } = await import('../src/main/spendable.ts')
const { contributionSummary } = await import('../src/main/contributions.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { answer } = await import('../src/main/handlers/table.ts')
const { openIssues, runTool } = await import('../src/main/tools.ts')
const { changedMonths, checkClosed, closeDueMonths, listSnapshots } = await import('../src/main/snapshots.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const { drillFilter, drillRows, lineQuery } = await import('../src/renderer/src/pages/txnFilter.ts')
const { HomeRows } = await import('../src/renderer/src/pages/HomeRows.tsx')
const { UpcomingList, upcomingItems, upcomingUntil } = await import('../src/renderer/src/pages/Upcoming.tsx')
const { Contributions } = await import('../src/renderer/src/pages/Contributions.tsx')
const { tieOut, MONTHS: TIE_MONTHS } = await import('./fixtures/tieout.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')
type HomeLine = import('../src/renderer/src/pages/homeView.ts').HomeLine
type TxnFilter = import('../src/renderer/src/pages/txnFilter.ts').TxnFilter

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const source = (path: string): string => readFileSync(join(root, path), 'utf8')
const web = (): HandlerContext =>
  ({
    platform: 'web',
    plan: { plan: 'plus' },
    broadcast: () => {},
    calendarChanged: () => {},
    settings: () => ({ licenseTokenSaved: false, apiKeySource: 'none', simplefinConnected: false, bank: { available: true, connections: [] }, lastSyncAt: null, syncsLast24h: 0, historyFrom: null, historyComplete: false, syncWarnings: [], dataPath: '', database: { encrypted: false, switchable: false, switchOn: false, recoveryPending: false, keySeal: 'install' } })
  }) as unknown as HandlerContext

/** A drill's lines: every one (a drill never holds more than a page of 1,000 here), their keys and their sum. */
function drilled(q: LineQuery): { lines: ClassifiedLine[]; keys: string[]; cents: number } {
  const page = linesFor(q, { limit: 1000 })
  assert.ok(page.total <= 1000, 'one page')
  return { lines: page.lines, keys: page.lines.map((l) => l.key), cents: page.cents }
}
/** Money out as lines see it: minus a cost, and 0 for nothing (not -0). */
const neg = (cents: number): number => (cents === 0 ? 0 : -cents)
/** The lines a Transactions filter opens on. */
const listed = (f: TxnFilter, today = TODAY): ReturnType<typeof drilled> => drilled(lineQuery(f, today)!)

/** A span of months' days. */
const days = (w: Waterfall): { fromDay: string; toDay: string } => ({ fromDay: `${w.span.from}-01`, toDay: `${w.span.to}-${String(daysInMonth(Number(w.span.to.slice(0, 4)), Number(w.span.to.slice(5, 7)))).padStart(2, '0')}` })

/**
 * Take-home's drill ties (spec 1.3): each payroll's deposits are its Gross pay less what its checks took out plus
 * its Payroll difference; each pay day's column opens that check's deposits; a payroll's Taxes, Benefits and Saved
 * at work open its checks' deposits, whose paystubs' items add to the part; other income and the bank's tax open
 * their lines; and deposits plus other income less the bank's tax are Take-home.
 */
function takeHomeTies(w: Waterfall, label: string): void {
  const row = (id: StageId): Waterfall['rows'][number] | undefined => w.rows.find((r) => r.id === id)
  const part = (id: StageId, key: string): number => row(id)?.parts.find((p) => p.key === key)?.actualCents ?? 0
  const sources = (row('gross') ?? row('takeHome'))!.parts
  const tables = view.payTables(w)
  let total = 0
  for (const p of sources) {
    const got = drilled(p.drill)
    if (p.key.startsWith('pay:')) {
      const key = p.key.slice(4)
      const paid = row('gross') ? part('gross', p.key) - part('taxes', p.key) - part('benefits', p.key) - part('savedAtWork', p.key) + part('payrollDiff', p.key) : p.actualCents
      assert.equal(got.cents, paid, `${label} ${p.key}'s deposits`)
      assert.ok(got.lines.every((l) => l.cls === 'pay' && l.paycheckKey === key))
      // Its table opens the same lines, and each of its pay days that check's own deposits.
      const checks = w.payChecks.filter((c) => c.paycheckKey === key)
      const table = tables.find((t) => t.key === key)
      if (checks.length) {
        assert.deepEqual(listed(table!.drill).keys, got.keys, `${label} ${p.key}'s table`)
        table!.checks.forEach((c, i) => {
          const check = listed(c.drill)
          assert.equal(check.cents, checks[i].depositCents, `${label} ${checks[i].day}`)
          assert.deepEqual([...new Set(check.lines.map((l) => l.txnId))].sort(), [...checks[i].txnIds].sort(), `${label} ${checks[i].day}'s lines`)
        })
      }
      // A figure from the checks' paystubs opens the checks' deposits; their items add up to it.
      for (const [id, of] of [['taxes', (c: PayCheck) => c.taxesCents], ['benefits', (c: PayCheck) => c.benefitsCents], ['savedAtWork', (c: PayCheck) => c.savedAtWorkCents]] as const) {
        const q = row(id)?.parts.find((x) => x.key === p.key)
        if (!q) continue
        assert.deepEqual(drilled(q.drill).keys, got.keys, `${label} ${id} ${p.key}`)
        assert.equal(checks.reduce((s, c) => s + of(c), 0), q.actualCents, `${label} ${id} ${p.key}`)
      }
    } else assert.equal(got.cents, p.actualCents, `${label} ${p.key}`)
    total += got.cents
  }
  for (const p of row('taxes')?.parts.filter((x) => x.key.startsWith('tax:')) ?? []) {
    const got = drilled(p.drill)
    assert.equal(got.cents, neg(p.actualCents), `${label} ${p.key}`)
    total += got.cents
  }
  assert.equal(total, row('takeHome')!.actualCents, `${label} Take-home`)
}

/**
 * Elective's drill ties (spec 1.4): each Committed part opens exactly its lines, no line in two parts and none left
 * out, adding up to the part and together to Committed; each group is its parts; each debt's principal opens its
 * principal lines.
 */
function electiveTies(w: Waterfall, label: string): void {
  const committed = w.rows.find((r) => r.id === 'committed')!
  const seen = new Set<string>()
  let total = 0
  for (const p of committed.parts) {
    const got = drilled(p.drill)
    assert.equal(got.cents, neg(p.actualCents), `${label} ${p.key}`)
    for (const k of got.keys) {
      assert.ok(!seen.has(k), `${label} ${k} in two parts`)
      seen.add(k)
    }
    total += got.cents
  }
  assert.equal(total, neg(committed.actualCents), `${label} Committed`)
  const span = days(w)
  assert.equal(drilled({ ...span, cls: ['committed', 'debtCost'], owner: null }).keys.length, seen.size, `${label} every Committed line in a part`)
  // Each group's figures are its parts'.
  const groups = view.homeTable(w, 'elective').lines.filter((l) => l.kind === 'group')
  for (const g of groups) {
    const mine = committed.parts.filter((p) => (p.group ?? 'other') === g.key)
    assert.equal(g.amount, view.dollars(-mine.reduce((s, p) => s + p.actualCents, 0)), `${label} ${g.key}`)
  }
  assert.equal(groups.length, new Set(committed.parts.map((p) => p.group ?? 'other')).size)
  let principal = 0
  for (const d of w.principal) {
    const got = drilled(d.drill)
    assert.equal(got.cents, neg(d.cents), `${label} ${d.name}'s principal`)
    assert.ok(got.lines.every((l) => l.cls === 'principal' && l.debtId === d.debtId), `${label} ${d.name}'s principal lines`)
    principal += d.cents
  }
  assert.equal(drilled({ ...span, cls: ['principal'], owner: null }).cents, neg(principal), `${label} every principal line`)
}

describe("section 5's household: Take-home and Elective open (spec section 5)", () => {
  let w: Waterfall
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
    w = month('2026-10')
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("Take-home's pay-day table: Brightline's two checks, gross 3,000.00, each item, net and deposit 1,888.50 ✓", () => {
    const [table, ...more] = view.payTables(w)
    assert.deepEqual(more, [])
    assert.deepEqual([table.name, table.checks.map((c) => c.label), table.tied], ['Brightline Payroll', ['Oct 15', 'Oct 31'], true])
    assert.deepEqual(
      table.rows.map((r) => [r.label, ...r.cells]),
      [
        ['Gross', '3,000.00', '3,000.00'],
        ['Federal', '−348.00', '−348.00'],
        ['Social Security', '−186.00', '−186.00'],
        ['Medicare', '−43.50', '−43.50'],
        ['State', '−138.00', '−138.00'],
        ['Medical', '−96.00', '−96.00'],
        ['401(k)', '−240.00', '−240.00'],
        ['HSA', '−60.00', '−60.00'],
        ['Net', '1,888.50', '1,888.50'],
        ['Deposit', '1,888.50', '1,888.50']
      ]
    )
    // The year's limits so far: 20 checks of 240.00, and of 60.00 and the employer's 24.00. Then the employer adds.
    const lines = view.homeTable(w, 'takeHome').lines
    const data = (key: string): string | undefined => lines.find((l): l is Extract<HomeLine, { kind: 'data' }> => l.kind === 'data' && l.key === key)?.text
    assert.equal(data('limits'), '401(k) 4,800 of 24,500 · HSA 1,680 of 4,400')
    assert.equal(data('employer'), 'Match 240 · HSA 48 · Premium share 410')
    // In the order section 5 draws it: the less rows, the lever, the table, the limits, the employer adds; then the
    // contributions and the links to Pay & benefits and Taxes.
    const at = lines.findIndex((l) => l.kind === 'row' && l.id === 'takeHome')
    assert.deepEqual(
      lines.slice(at + 1, at + 10).map((l) => (l.kind === 'row' ? l.name : l.kind === 'data' ? l.key : l.kind === 'slot' ? `slot:${l.key}` : l.kind)),
      ['Taxes', 'Benefits', 'Saved at work', 'levers:takeHome', 'payTable', 'limits', 'employer', 'slot:contributions', 'pages']
    )
    assert.deepEqual(lines.find((l): l is Extract<HomeLine, { kind: 'data' }> => l.kind === 'data' && l.key === 'pages')!.items, [
      { text: 'Pay & benefits', page: 'benefits' },
      { text: 'Taxes', page: 'taxes' }
    ])
  })

  test("Take-home's parts open exactly their lines: the payroll's 3,777.00 of deposits, each check's 1,888.50, and the stubs' 1,431.00, 192.00 and 600.00", () => {
    takeHomeTies(w, 'October')
    const table = view.payTables(w)[0]
    assert.deepEqual([listed(table.drill).keys.length, listed(table.drill).cents], [2, 377_700])
    assert.deepEqual(
      table.checks.map((c) => listed(c.drill).cents),
      [188_850, 188_850]
    )
    const part = (id: StageId): number => w.rows.find((r) => r.id === id)!.parts.find((p) => p.key === `pay:${KEY}`)!.actualCents
    assert.deepEqual([part('taxes'), part('benefits'), part('savedAtWork')], [143_100, 19_200, 60_000])
  })

  test('Elective by group, as section 5 draws it: Housing, Debt cost, Utilities, Insurance and Subscriptions, then the principal', () => {
    const lines = view.homeTable(w, 'elective').lines
    assert.deepEqual(
      lines.filter((l) => l.kind === 'group').map((l) => (l.kind === 'group' ? [l.name, l.amount, l.runRate, l.label] : [])),
      [
        ['Housing', '−1,412', '−1,412', 'Pinecrest Mortgage interest 800 · escrow 380 · Alder Lane HOA 232'],
        ['Debt cost', '−192', '−194', 'Visa 24.0% 60 · Civic Auto Loan 6.4% 48 · Student Loan 4.3% 86'],
        ['Utilities', '−318', '−290', 'vs Oct 2025 284 +12%'],
        ['Insurance', '−210', '−210', 'Harborline Mutual 142 · Crestline Insurance 68'],
        ['Subscriptions', '−101', '−101', 'Netflix 15.49 > 17.99']
      ]
    )
    // The groups add up to Committed: 1,412 + 192 + 318 + 210 + 101 = 2,233 and 1,412 + 194 + 290 + 210 + 101 = 2,207.
    const parts = w.rows.find((r) => r.id === 'committed')!.parts
    const of = (g: string, f: 'actualCents' | 'runRateCents'): number => parts.filter((p) => p.group === g).reduce((s, p) => s + (p[f] ?? 0), 0)
    assert.deepEqual(
      ['housing', 'debtCost', 'utilities', 'insurance', 'subscriptions'].map((g) => [of(g, 'actualCents'), of(g, 'runRateCents')]),
      [
        [141_200, 141_200],
        [19_240, 19_400],
        [31_800, 29_000],
        [21_000, 21_000],
        [10_050, 10_050]
      ]
    )
    assert.deepEqual([parts.reduce((s, p) => s + p.actualCents, 0), parts.reduce((s, p) => s + p.runRateCents!, 0)], [223_290, 220_650])
    // Principal goes to Saved: Pinecrest 805, Civic 364, Student 214.
    const principal = lines.find((l): l is Extract<HomeLine, { kind: 'data' }> => l.kind === 'data' && l.key === 'principal')!
    assert.deepEqual([principal.label, principal.text, principal.to], ['Principal', 'Pinecrest Mortgage 805 · Civic Auto Loan 364 · Student Loan 214', 'saved'])
    assert.deepEqual(
      principal.items!.map((i) => listed(i.drill!).cents),
      [-80_500, -36_400, -21_400]
    )
    // Groups is the view until By date is picked, which hands the page its slot.
    assert.deepEqual(lines.find((l) => l.kind === 'switch'), { kind: 'switch', key: 'electiveView', value: 'groups', options: [{ id: 'groups', label: 'Groups' }, { id: 'byDate', label: 'By date' }] })
    const byDate = view.homeTable(w, 'elective', new Map(), { electiveView: 'byDate' }).lines
    assert.ok(byDate.some((l) => l.kind === 'slot' && l.key === 'byDate'))
    assert.ok(!byDate.some((l) => l.kind === 'group'))
  })

  test('Utilities compares like with like: the span\'s full months against the same months a year before, all of them in the books', () => {
    const utilities = (span: { from: string; to: string }): string => {
      const l = view.homeTable(getWaterfall(span), 'elective').lines.find((x) => x.kind === 'group' && x.key === 'utilities')
      return l?.kind === 'group' ? l.label : ''
    }
    // October, closed: 318.00 against 284.00.
    assert.equal(utilities({ from: '2026-10', to: '2026-10' }), 'vs Oct 2025 284 +12%')
    // The year to date leaves out November, open with its bill not yet in: January to October, 2,916.00 against 2,792.00.
    assert.equal(utilities({ from: '2026-01', to: '2026-11' }), 'vs Jan–Oct 2025 2,792 +4%')
    // Twelve months to November: December to October, 3,198.00 against 3,082.00.
    assert.equal(utilities({ from: '2025-12', to: '2026-11' }), 'vs Dec 2024–Oct 2025 3,082 +4%')
    // November alone has no full month, and a span of more than twelve months a year before that overlaps it; the
    // months before the books began aren't 0. Each shows the run rates instead.
    for (const span of [
      { from: '2026-11', to: '2026-11' },
      { from: '2024-11', to: '2026-11' },
      { from: '2024-11', to: '2026-10' },
      { from: '2025-08', to: '2025-10' }
    ]) {
      const w = getWaterfall(span)
      assert.ok(w.rows.find((r) => r.id === 'committed')!.parts.every((p) => p.yearAgo === null), `${span.from}..${span.to}`)
      assert.doesNotMatch(utilities(span), /^vs /, `${span.from}..${span.to}`)
    }
  })

  test("a group opens into its series, each with its month, run rate, cadence, next payment, price change and whether it's confirmed", () => {
    const spend = getSpendable()
    const next = view.nextDays(spend.items)
    const lines = view.homeTable(w, 'elective', new Map(), { group: 'subscriptions', nextDays: next }).lines
    const parts = lines.filter((l): l is Extract<HomeLine, { kind: 'part' }> => l.kind === 'part')
    assert.deepEqual(
      parts.map((l) => [l.name, l.amount, l.runRate, l.nested]),
      [
        ['Fit Club', '−41', '−41', true],
        ['Cloudbox', '−30', '−30', true],
        ['Netflix', '−18', '−18', true],
        ['Tunewave', '−12', '−12', true]
      ]
    )
    const netflix = parts.find((l) => l.name === 'Netflix')!
    // November 7's Netflix hasn't posted: late, and it says so. Most likely, the default, holds it to the next bank day
    // (today is a Saturday; Worst case holds it today). A price change and the series unconfirmed, both: one doesn't
    // hide the other.
    assert.deepEqual(next.get('netflix|-'), { day: '2026-11-09', late: true })
    const netflixNote = (confirmed: boolean): string => `Monthly · late · 15.49 > 17.99${confirmed ? '' : ' · unconfirmed'}`
    assert.equal(netflix.note, netflixNote(false))
    // Tunewave's comes on the 9th.
    assert.equal(parts.find((l) => l.name === 'Tunewave')!.note, 'Monthly · next Nov 9 · unconfirmed')
    db.setRecurringOverride('netflix|-', { status: 'confirmed' })
    try {
      const confirmed = view.homeTable(month('2026-10'), 'elective', new Map(), { group: 'subscriptions', nextDays: next }).lines.find((l) => l.kind === 'part' && l.name === 'Netflix')
      assert.equal(confirmed?.kind === 'part' && confirmed.note, netflixNote(true))
    } finally {
      db.setRecurringOverride('netflix|-', { status: null })
    }
    assert.equal(parts.find((l) => l.name === 'Fit Club')!.note!, 'Monthly · late · unconfirmed')
    // Each opens the Transactions list on its series, its lines adding to its month.
    assert.deepEqual(netflix.drill, { month: '2026-10', toMonth: '2026-10', cls: ['committed'], seriesKey: 'netflix|-', name: 'Committed · Netflix' })
    assert.equal(listed(netflix.drill!).cents, -1_799)
    // A loan in Housing says its rate, its interest and its escrow.
    const housing = view.homeTable(w, 'elective', new Map(), { group: 'housing' }).lines.filter((l): l is Extract<HomeLine, { kind: 'part' }> => l.kind === 'part')
    assert.deepEqual(
      housing.map((l) => [l.name, l.note]),
      [
        ['Pinecrest Mortgage', '3.75% · interest 800 · escrow 380'],
        ['Alder Lane HOA', 'Monthly · unconfirmed']
      ]
    )
    // Debt cost opens in its line's order, the highest rate first (Decision 19).
    const debt = view.homeTable(w, 'elective', new Map(), { group: 'debtCost' }).lines.filter((l): l is Extract<HomeLine, { kind: 'part' }> => l.kind === 'part')
    assert.deepEqual(
      debt.map((l) => l.name),
      ['Visa', 'Civic Auto Loan', 'Student Loan']
    )
    // A car loan and a student loan hold no escrow: their payments' rest is interest. A mortgage that doesn't say what
    // it holds in escrow shows the two together.
    assert.deepEqual(
      debt.map((l) => l.note),
      ['24.0%', '6.4% · interest 48', '4.3% · interest 86']
    )
    const mortgage = db.listAccounts().find((a) => a.name === 'Pinecrest Mortgage')!
    db.updateAccount(mortgage.id, { escrowCents: null })
    try {
      const unsaid = view.homeTable(month('2026-10'), 'elective', new Map(), { group: 'housing' }).lines.find((l) => l.kind === 'part' && l.name === 'Pinecrest Mortgage')
      assert.equal(unsaid?.kind === 'part' && unsaid.note, '3.75% · interest + escrow 1,180')
    } finally {
      db.updateAccount(mortgage.id, { escrowCents: 38_000 })
    }
  })

  test("Elective's parts open exactly their lines, and they add up to each part, each group and Committed", () => {
    electiveTies(w, 'October')
  })

  test("Saved's and Invested's parts open lines only where their lines add up to them: Kept and From cash, not the paystubs' saving", () => {
    for (const open of ['saved', 'invested'] as const) {
      const parts = view.homeTable(w, open).lines.filter((l): l is Extract<HomeLine, { kind: 'part' }> => l.kind === 'part')
      const row = w.rows.find((r) => r.id === open)!
      assert.deepEqual(
        parts.map((l) => [l.name, l.amount, !!l.drill]),
        open === 'saved'
          ? [
              ['Kept', '−202', true],
              ['Saved at work', '600', false],
              ['Employer saving', '288', false]
            ]
          : [
              ['Saved at work', '600', false],
              ['Employer saving', '288', false],
              ['From cash', '500', true]
            ]
      )
      for (const l of parts.filter((x) => x.drill)) {
        const part = row.parts.find((p) => p.key === l.key)!
        assert.equal(Math.abs(listed(l.drill!).cents), Math.abs(part.actualCents), `${open} ${l.name}`)
      }
    }
  })

  test('a Transactions filter of Everyday, Gas and October lists the two gas lines, -59.00 and -46.00', async () => {
    const gas = db.listCategories().find((c) => c.name === 'Gas & Fuel')!.id
    const f: TxnFilter = { cls: ['everyday'], categoryId: gas, month: '2026-10' }
    assert.deepEqual(lineQuery(f, TODAY), { fromDay: '2026-10-01', toDay: '2026-10-31', cls: ['everyday'], categoryId: gas })
    const page = listed(f)
    assert.deepEqual(
      page.lines.map((l) => [l.day, l.accountId, l.cents]),
      [
        ['2026-10-27', ACCOUNTS.visa, -4_600],
        ['2026-10-09', ACCOUNTS.visa, -5_900]
      ]
    )
    assert.equal(page.cents, -10_500)
    // The same through the hosted handler the page calls, and from Left over's Gas & Fuel part, whose drill is this filter.
    const r = await answer('linesFor', [lineQuery(f, TODAY), { limit: 200 }], web())
    assert.ok(r.ok)
    assert.deepEqual((r.data as { total: number; cents: number }).total, 2)
    const part = w.rows.find((x) => x.id === 'everyday')!.parts.find((p) => p.key === `cat:${gas}`)!
    assert.deepEqual(drillFilter(part.drill, 'Everyday · Gas & Fuel'), { ...f, toMonth: '2026-10', name: 'Everyday · Gas & Fuel' })
    // A filter with no line field lists transactions, as before.
    assert.equal(lineQuery({ categoryId: gas, month: '2026-10' }, TODAY), null)
  })

  test('the Transactions page takes the drill filters through linesFor, and lists each line at its own amount', () => {
    const page = source('src/renderer/src/pages/Transactions.tsx')
    assert.match(page, /const q = lineQuery\(initialFilter, todayKey\(\)\)/)
    assert.match(page, /drillRows\(api\.linesFor, api\.listTransactions, drill\.q, /)
    assert.match(page, /cents: l\.cents, line: l/)
    // Every filter field section 6 names, and a drill's name.
    const filter = source('src/renderer/src/pages/txnFilter.ts')
    for (const f of ['cls', 'seriesKey', 'paycheckKey', 'assetId', 'owner', 'ids']) assert.match(filter, new RegExp(`if \\(f\\.${f} !== undefined\\) q\\.${f} = f\\.${f}`), f)
    // The Pinecrest payment opens on its interest and escrow, 1,180.00 of the 1,985.00 paid.
    const loan = w.rows.find((r) => r.id === 'committed')!.parts.find((p) => p.name === 'Pinecrest Mortgage')!
    assert.deepEqual(
      listed(drillFilter(loan.drill, 'x')).lines.map((l) => [l.key.endsWith(':int'), l.cents]),
      [[true, -118_000]]
    )
  })

  test("the By date list is the Calendar's next 30 days: one list, from one forecast", () => {
    const spend: Spendable = getSpendable()
    const until = upcomingUntil(TODAY)
    assert.equal(until, '2026-12-07')
    const items = upcomingItems(spend, until)
    assert.ok(items.length > 0)
    // Bills, paychecks and transfers; not everyday trips or irregular pay.
    assert.ok(items.every((i) => i.day >= TODAY && i.day <= until && !i.everyday && !i.irregular))
    assert.ok(items.some((i) => i.seriesKey === 'netflix|-'))
    // The Calendar's card and Elective's By date draw the one component over the same days of the same answer.
    const calendar = source('src/renderer/src/pages/Calendar.tsx')
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.match(calendar, /api\.getSpendable\(\)\.then\(setSpend/)
    assert.match(calendar, /<UpcomingList spend=\{spend\} until=\{upcomingUntil\(today\)\} \/>/)
    assert.match(home, /byDate: spend \? <UpcomingList spend=\{spend\} until=\{upcomingUntil\(todayKey\(\)\)\} \/>/)
    assert.doesNotMatch(calendar, /listCalendar\(today/)
    const html = renderToStaticMarkup(createElement(UpcomingList, { spend, until }))
    const shown = [...html.matchAll(/<div class="grow clamp-2">([^<]+)<\/div>/g)].map((m) => m[1])
    assert.equal(shown.length, items.length)
    // Rendered in Home's By date slot, it is the same list.
    const rows = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(w, 'elective', new Map(), { electiveView: 'byDate' }), onOpen: () => {}, onDrill: () => {}, slots: { byDate: createElement(UpcomingList, { spend, until }) } }))
    assert.ok(rows.includes(html))
    // Each series' next payment under Elective is its first in the list.
    const next = view.nextDays(spend.items)
    for (const i of items) if (i.seriesKey) assert.ok(next.get(i.seriesKey)!.day <= i.day, i.key)
    // The one list has one home: no other page keeps its own upcoming list, and the parked Dashboard card is gone.
    const pages = join(root, 'src/renderer/src/pages')
    const owners = readdirSync(pages).filter((f) => /function UpcomingList\b/.test(readFileSync(join(pages, f), 'utf8')))
    assert.deepEqual(owners, ['Upcoming.tsx'])
    assert.ok(!existsSync(join(root, 'src/renderer/src/pages/Cards.tsx')))
  })

  test('Home renders the drills: the pay-day table with its tie, the groups with their data, each part a link to its lines', () => {
    const drills: TxnFilter[] = []
    const take = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(w, 'takeHome'), onOpen: () => {}, onDrill: (f: TxnFilter) => drills.push(f), onPage: () => {}, slots: { contributions: createElement('i', null, 'plans') } }))
    assert.match(take, /<table class="pay-table">/)
    assert.match(take, /<button class="link-quiet">Brightline Payroll<\/button>/)
    assert.match(take, /<tr class="pay-deposit"><th scope="row">Deposit<\/th><td class="num">1,888\.50<\/td><td class="num">1,888\.50<\/td><td class="pay-tie">✓<\/td><\/tr>/)
    assert.match(take, /<i>plans<\/i>/)
    assert.match(take, /› Pay &amp; benefits/)
    const elective = renderToStaticMarkup(createElement(HomeRows, { table: view.homeTable(w, 'elective', new Map(), { group: 'housing' }), onOpen: () => {}, onDrill: () => {} }))
    assert.match(elective, /<td colSpan="3" class="group-label">vs Oct 2025 284 \+12%<\/td>/)
    assert.match(elective, /<tr class="part drill nested">/)
    assert.match(elective, /<span class="part-note">3\.75% · interest 800 · escrow 380<\/span>/)
    assert.match(elective, /aria-pressed="true">Groups<\/button>/)
    // Home's pay-day table keeps its row names in view as a span's checks scroll under them, as Pay & benefits' does;
    // and at 900 px a long span's heading wraps before Elective's open groups widen the rows past the window.
    const css = source('src/renderer/src/styles.css')
    assert.match(css, /\.pay-table th:first-child,\s*\.home-rows tr\.data \.pay-table th:first-child \{\s*position: sticky;\s*left: 0;/)
    assert.match(css, /@container \(max-width: 720px\) \{\s*\.home-rows thead th:nth-child\(2\),\s*\.home-rows thead th\.per-month \{\s*white-space: normal;/)
    // Back from a drill's Transactions list, Elective's view and open group are as they were left, for the window's
    // life: localStorage keeps only the open row and the view (spec section 7).
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.match(home, /useState<ElectiveView>\(electiveKept\.view\)/)
    assert.match(home, /useState<CommittedGroup \| null>\(electiveKept\.group\)/)
    assert.match(home, /electiveKept\.view = v\r?\n/)
    assert.match(home, /electiveKept\.group = g\r?\n/)
    assert.doesNotMatch(home, /localStorage\.setItem\([^)]*elective/i)
  })

  test("the plans' year so far is the year's checks, as Take-home's Limits line reads them, when no total was entered", () => {
    // Twenty checks to October 31: 4,800.00 to the 401(k) and 1,200.00 of the employee's to the HSA (the Limits line's
    // 1,680.00 adds the employer's 480.00, which the HSA's limit counts). Four checks are left, the 15th and the
    // month's last day of November and December.
    const summary = contributionSummary()
    const plan = (kind: string): (typeof summary.plans)[number] => summary.plans.find((p) => p.kind === kind)!
    assert.deepEqual(
      ['401k', 'hsa'].map((k) => [plan(k).soFarCents, plan(k).checksLeft, plan(k).projectedCents]),
      [
        [480_000, 4, 576_000],
        [120_000, 4, 144_000]
      ]
    )
    assert.deepEqual(
      summary.limits.map((l) => [l.label, l.ytdCents, l.unknown]),
      [
        ['401(k) elective deferrals, all employers', 480_000, []],
        ['HSA, self-only', 120_000, []]
      ]
    )
    const limits = view.homeTable(w, 'takeHome').lines.find((l) => l.kind === 'data' && l.key === 'limits')
    assert.equal(limits?.kind === 'data' && limits.text, '401(k) 4,800 of 24,500 · HSA 1,680 of 4,400')
  })

  test('the Contributions list from its new home: the plans with their elections, as data, and a plan Review saves, changes and removes', () => {
    // Take-home's drill lists the plans and leaves the limits to its Limits line; Pay & benefits shows both.
    const summary = contributionSummary()
    const compact = renderToStaticMarkup(createElement(Contributions, { summary, compact: true }))
    assert.match(compact, /<section class="contrib compact">/)
    assert.match(compact, /Brightline 401\(k\)/)
    assert.match(compact, /\$240\.00<span class="txn-desc">\+ \$120\.00 match<\/span>/)
    assert.doesNotMatch(compact, /contrib-limit/)
    const full = renderToStaticMarkup(createElement(Contributions, { summary }))
    assert.match(full, /<section class="card contrib">/)
    assert.match(full, /401\(k\) elective deferrals, all employers · limit \$24,500/)
    // Data only: no Add plan, no edit, no form. Review keeps the plans with its tools.
    for (const html of [compact, full]) assert.doesNotMatch(html, /<button|<input|<select|Add plan|Edit /)
    const plan = (): { employeeCents: number | null } | undefined => contributionSummary().plans.find((p) => p.name === 'Brightline ESPP') as { employeeCents: number | null } | undefined
    runTool('set_contribution', { name: 'Brightline ESPP', kind: 'espp', paycheck_key: KEY, per_paycheck: 150 }, 'assistant')
    assert.equal(plan()?.employeeCents, 15_000)
    runTool('set_contribution', { name: 'Brightline ESPP', kind: 'espp', paycheck_key: KEY, per_paycheck: 180 }, 'assistant')
    assert.equal(plan()?.employeeCents, 18_000)
    assert.match(renderToStaticMarkup(createElement(Contributions, { summary: contributionSummary(), compact: true })), /Brightline ESPP[\s\S]*\$180\.00/)
    runTool('delete_contribution', { name: 'Brightline ESPP' }, 'assistant')
    assert.equal(plan(), undefined)
    // The list lives in one place, Home's Take-home drill and Pay & benefits import it (the Recurring page did until
    // sub-phase 2e deleted it), and no page has a plan's form: none had one before that either, as the Recurring page that drew
    // it then had no route.
    const pages = join(root, 'src/renderer/src/pages')
    assert.deepEqual(readdirSync(pages).filter((f) => /function Contributions\b/.test(readFileSync(join(pages, f), 'utf8'))), ['Contributions.tsx'])
    const renderer = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? renderer(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
    for (const file of renderer(join(root, 'src/renderer/src'))) assert.doesNotMatch(readFileSync(file, 'utf8'), /ContributionModal|api\.(saveContribution|deleteContribution)\(/, file)
    assert.match(source('src/renderer/src/pages/Home.tsx'), /contributions: <Contributions summary=\{contrib\} compact \/>/)
    assert.match(source('src/renderer/src/pages/Benefits.tsx'), /<Contributions summary=\{contrib\} \/>/)
    assert.equal(existsSync(join(root, 'src/renderer/src/pages/Recurring.tsx')), false)
    const importers = renderer(join(root, 'src/renderer/src')).filter((f) => /import \{ Contributions \} from '\.\/Contributions'/.test(readFileSync(f, 'utf8')))
    assert.deepEqual(importers.map((f) => f.slice(root.length + 1).replaceAll('\\', '/')).sort(), ['src/renderer/src/pages/Benefits.tsx', 'src/renderer/src/pages/Home.tsx'])
  })

  test('Pay & benefits: the page is named so in the sidebar, with the pay-day table of the year and its checks from listPayChecks', async () => {
    assert.match(source('src/renderer/src/App.tsx'), /\{ label: 'Pay & benefits', page: 'benefits' \}/)
    const page = source('src/renderer/src/pages/Benefits.tsx')
    assert.match(page, /<PageHeader title="Pay & benefits">/)
    // Review sends the owner to the page by the name the sidebar shows.
    for (const file of ['src/main/review.ts', 'src/main/tools.ts']) assert.doesNotMatch(source(file), /Benefits page/, file)
    assert.match(page, /api\.listPayChecks\(`\$\{today\.slice\(0, 4\)\}-01-01`, today\)/)
    const r = await answer('listPayChecks', ['2026-01-01', TODAY], web())
    assert.ok(r.ok)
    const checks = r.data as PayCheck[]
    // Twenty checks, the 15th and the month's last day from January to October.
    assert.equal(checks.length, 20)
    const [table] = view.payTablesOf(checks, { fromDay: '2026-01-01', toDay: TODAY }, () => 'Brightline Payroll')
    assert.deepEqual([table.checks[0].label, table.checks.at(-1)!.label, table.rows[0].cells.length], ['Jan 15', 'Oct 31', 20])
    assert.deepEqual(await answer('listPayChecks', ['2026-1-1', TODAY], web()), { ok: false, error: 'fromDay and toDay must be dates like 2026-10-01' })
    // Each year asked is classified, so a hosted call reads at most three of them.
    const all = await answer('listPayChecks', ['2024-01-01', '2026-12-31'], web())
    assert.ok(all.ok)
    assert.equal((all.data as PayCheck[]).length, 48)
    assert.deepEqual(await answer('listPayChecks', ['1900-01-01', '2100-12-31'], web()), { ok: false, error: 'fromDay and toDay must be within 3 calendar years' })
    assert.deepEqual(await answer('listPayChecks', ['2026-11-07', '2026-01-01'], web()), { ok: true, data: [] })
  })
})

describe("the same ties on a payroll with deposits alone, the section 2 tie-out and the sample household", () => {
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('deposits only: Take-home stands alone, its deposits 3,777.00, its pay-day table the deposits, and Elective ties', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household({ paystubs: false })
    const w = month('2026-10')
    takeHomeTies(w, 'deposits only')
    electiveTies(w, 'deposits only')
    // With no paystub its gross and net are the deposit by definition: the table is the deposits, with no tie to mark.
    const [table] = view.payTables(w)
    assert.deepEqual(
      table.rows.map((r) => [r.label, ...r.cells]),
      [['Deposit', '1,888.50', '1,888.50']]
    )
    assert.equal(table.tied, false)
    assert.equal(listed(table.drill).cents, 377_700)
    db.closeDb()
    mock.timers.reset()
  })

  test("a check split into regular pay and bonus: each of its two columns opens its own part of the one deposit", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household({ paystubs: false })
    // October 31's deposit is 4,888.50, above 1.5 times the usual 1,888.50: 2,832.75 of it is pay and 2,055.75 bonus,
    // two parts of one transaction.
    const deposit = db.get<{ id: string }>("SELECT id FROM transactions WHERE account_id = ? AND amount_cents = 188850 ORDER BY posted DESC LIMIT 1", ACCOUNTS.checking)!.id
    db.run('UPDATE transactions SET amount_cents = 488850 WHERE id = ?', deposit)
    const w = month('2026-10')
    const oct31 = w.payChecks.filter((c) => c.day === '2026-10-31')
    assert.deepEqual(
      oct31.map((c) => [c.kind, c.depositCents, c.txnIds]),
      [
        ['regular', 283_275, [deposit]],
        ['bonus', 205_575, [deposit]]
      ]
    )
    const [table] = view.payTables(w)
    assert.deepEqual(
      table.checks.map((c) => c.label),
      ['Oct 15', 'Oct 31', 'Oct 31 bonus']
    )
    assert.deepEqual(
      table.checks.map((c) => listed(c.drill).cents),
      [188_850, 283_275, 205_575]
    )
    // Each is named by its payroll, the Transactions list giving its days.
    assert.deepEqual(
      table.checks.map((c) => c.drill.name),
      ['Brightline Payroll', 'Brightline Payroll', 'Brightline Payroll bonus']
    )
    takeHomeTies(w, 'split check')
    db.closeDb()
    mock.timers.reset()
  })

  test("a loan paid from the card: the loan's interest opens with the loan, and the card's part opens its own interest alone", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    const h = household()
    // An extra 300.00 to the student loan on October 21, charged to the Visa and linked to the loan.
    const paid = line(ACCOUNTS.visa, '2026-10-21', -30_000, 'STUDENT LOAN PMT', 'Transfers', 'Student Loan')
    runTool('link_loan_payment', { account_id: h.studentLoan, transaction_id: paid }, 'assistant')
    const w = month('2026-10')
    const visa = drilled(w.rows.find((x) => x.id === 'committed')!.parts.find((p) => p.key === `card:${ACCOUNTS.visa}`)!.drill)
    assert.ok(visa.lines.length > 0 && visa.lines.every((l) => l.debtId === ACCOUNTS.visa), 'the card part lists its own interest alone')
    assert.ok(drilled({ fromDay: '2026-10-01', toDay: '2026-10-31', cls: ['debtCost'], ids: [paid] }).lines.some((l) => l.debtId === h.studentLoan), "the loan's interest is on the card's line")
    electiveTies(w, 'a loan paid from the card')
    // The card's interest lever opens the same lines.
    const lever = w.levers.find((l) => l.kind === 'card_interest')!
    assert.ok(drilled(lever.drill!).lines.every((l) => l.debtId === ACCOUNTS.visa))
    db.closeDb()
    mock.timers.reset()
  })

  test("the tie-out: every month's Take-home and Elective parts open lines that add up to them", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
    for (const m of TIE_MONTHS) {
      const w = month(m)
      takeHomeTies(w, `tie-out ${m}`)
      electiveTies(w, `tie-out ${m}`)
    }
    db.closeDb()
    mock.timers.reset()
  })

  test('the sample household: every month, and its year to date', () => {
    db.openDb(':memory:')
    loadDemoData()
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    const current = db.today().slice(0, 7)
    let checks = 0
    for (let m = first; m <= current; m = shiftMonth(m, 1)) {
      const w = month(m)
      takeHomeTies(w, `demo ${m}`)
      electiveTies(w, `demo ${m}`)
      checks += w.payChecks.length
    }
    assert.ok(checks > 20)
    const ytd = getWaterfall({ from: `${current.slice(0, 4)}-01`, to: current })
    takeHomeTies(ytd, 'demo YTD')
    electiveTies(ytd, 'demo YTD')
    // Its books begin a year before the open month, so no span has a year before it to compare with.
    for (const w of [ytd, getWaterfall({ from: shiftMonth(current, -3), to: shiftMonth(current, -1) })]) assert.ok(w.rows.find((r) => r.id === 'committed')!.parts.every((p) => p.yearAgo === null), `demo ${w.span.from}..${w.span.to}`)
    db.closeDb()
  })

  test("the sample household with its months closed: an Unsorted line filed re-closes them, a line moved to Travel on the Transactions page changes the last, and its drills and Review's totals still tie to the rows Home shows beside the close's", async () => {
    db.openDb(':memory:')
    loadDemoData()
    await closeDueMonths()
    const closed = [...new Set(listSnapshots(1000).map((s) => s.month))].sort()
    const last = closed.at(-1)!
    const lastDay = (m: string): string => `${m}-${String(daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5, 7)))).padStart(2, '0')}`
    const cat = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
    const changedIssues = (): unknown[] => openIssues().filter((i) => i.kind === 'month_changed')
    const edit = async (id: string, categoryId: number): Promise<void> => assert.ok(((await answer('updateTransaction', [id, { categoryId }], web())) as { ok: boolean }).ok)
    // An Unsorted line in a closed month given a category: the month and the ones after it re-close by themselves.
    const unsorted = classifyLines(`${closed[0]}-01`, lastDay(last)).find((l) => l.cls === 'unsorted' && l.owner === null && l.splitId === null && l.cents < 0)!
    await edit(unsorted.txnId, cat('Shopping'))
    const filed = await checkClosed()
    assert.deepEqual([filed.changed, filed.reclosed[0]?.month, filed.reclosed[0]?.why], [[], unsorted.day.slice(0, 7), 'unsortedCategorized'])
    assert.ok(filed.reclosed.slice(1).every((r) => r.why === 'follower'))
    assert.deepEqual(changedIssues(), [])
    // Groceries moved to Travel on the Transactions page: the last closed month is changed, in one batch, the user's.
    const groceries = classifyLines(`${last}-01`, lastDay(last)).find((l) => l.cls === 'everyday' && l.owner === null && l.splitId === null && l.categoryId === cat('Groceries'))!
    await edit(groceries.txnId, cat('Travel'))
    const moved = await checkClosed()
    assert.deepEqual(moved.changed.map((c) => [c.month, c.cause]), [[last, 'user']])
    assert.deepEqual([changedMonths().length, changedIssues().length], [1, 1])
    const w = month(last)
    assert.deepEqual([w.status, view.spanMark(w.months).mark], ['changed', 'Δ'])
    const everyday = w.rows.find((r) => r.id === 'everyday')!
    assert.equal(everyday.actualCents - everyday.closedCents!, groceries.cents)
    const shown = (open: StageId): string[] => view.homeTable(w, open).lines.flatMap((l) => (l.kind === 'closed' ? [l.key] : []))
    // Everyday's amount, its run rate, the rate and the changes over 3 months they make; One-offs' amount, its run
    // rate (a twelfth of the line) and its change, its rate the same to the tenth on a Left over the line moved too.
    assert.deepEqual([shown('leftOver').filter((k) => k.endsWith(':everyday')), shown('saved').filter((k) => k.endsWith(':oneOffs'))], [
      ['closed:actual:everyday', 'closed:runRate:everyday', 'closed:rate:everyday', 'closed:change:everyday', 'closed:pts:everyday'],
      ['closed:actual:oneOffs', 'closed:runRate:oneOffs', 'closed:change:oneOffs']
    ])
    // The drills read the books as they are now, as the rows do, so they tie to the rows' figures, not the close's.
    for (const x of [w, getWaterfall({ from: shiftMonth(last, -11), to: last })]) {
      takeHomeTies(x, `demo changed ${x.span.from}..${x.span.to}`)
      electiveTies(x, `demo changed ${x.span.from}..${x.span.to}`)
    }
    const s = runTool('month_summary', { month: last }).result as { spendCents: number; incomeCents: number }
    const actual = (id: StageId): number => w.rows.find((r) => r.id === id)?.actualCents ?? 0
    assert.deepEqual([s.spendCents, s.incomeCents], [actual('committed') + actual('everyday') + actual('oneOffs'), actual('takeHome')])
    db.closeDb()
  })
})

describe('the cost of a drill on a large ledger', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("opening Take-home or Elective after Home's waterfall: its rows at once (under 25 ms), and one part's lines in one linesFor (two drills under 400 ms)", async (t) => {
    db.openDb(':memory:')
    largeLedger()
    const m = '2026-10'
    const w = month(m)
    // npm test runs the files at once: each budget is timed against test/cost.ts's reference work in paired rounds,
    // and holds as the median of the rounds' ratios. A budget of B ms is a ratio of B / REFERENCE_MS, what the work
    // may take against the reference on the reference machine's fast cores with nothing else running. The reference
    // runs none of the engine or the page, so a slower layout or linesFor can't slow it too and cancel out.
    // Laying an open row out reads nothing: the pay-day table, the groups and their data come from the waterfall.
    const layout = await paired(6, () => repeatedMs(() => ['takeHome', 'elective'].forEach((open) => view.homeTable(w, open as 'takeHome', new Map(), { group: 'housing' }))))
    t.diagnostic(within('laying out Take-home and Elective', 25, layout))
    assert.ok(layout.ratio <= budgetRatio(25), within('laying out Take-home and Elective', 25, layout))
    // A part's lines are one linesFor over the span: the month's largest Committed series, and the payroll's deposits.
    // Each round's write first, as a minute passing does: the lines kept per data stamp are gone, so the first drill
    // classifies the span, and the second reads what it kept.
    const series = w.rows.find((r) => r.id === 'committed')!.parts[0]
    const pay = (w.rows.find((r) => r.id === 'gross') ?? w.rows.find((r) => r.id === 'takeHome'))!.parts[0]
    const drill = await paired(
      6,
      () => busyMs(() => [series.drill, pay.drill].forEach((q) => linesFor(q, { limit: 200 }))),
      (k) => db.setSetting('test.drillRound', String(k))
    )
    t.diagnostic(within('two drills over a month', 400, drill))
    assert.ok(drill.ratio <= budgetRatio(400), within('two drills over a month', 400, drill))
    assert.equal(linesFor(series.drill, { limit: 1000 }).cents, -series.actualCents)
  })

  test("a drill of more than 1,000 lines shows more past the first 1,000: a page at a time, each read once, its transactions too", async () => {
    db.openDb(':memory:')
    largeLedger()
    const w = getWaterfall({ from: '2025-12', to: '2026-11' })
    const kept = w.rows.find((r) => r.id === 'saved')!.parts.find((p) => p.key === 'kept')!
    const q = lineQuery(drillFilter(kept.drill, 'Saved · Kept'), '2026-11-09')!
    const total = linesFor(q).total
    assert.ok(total > 1_200, `Kept has ${total} lines`)
    // One call gives at most 1,000, so asking for more from the start stops there.
    assert.equal(linesFor(q, { limit: 1_200 }).lines.length, 1_000)
    const asked: Array<{ offset?: number; limit?: number }> = []
    const read = async (query: LineQuery, page: { offset?: number; limit?: number }): Promise<ReturnType<typeof linesFor>> => {
      asked.push(page)
      return linesFor(query, page)
    }
    const fetched: string[][] = []
    const list = async (query: { ids?: string[]; limit?: number }): Promise<{ rows: Array<{ id: string }> }> => {
      fetched.push(query.ids ?? [])
      return { rows: db.listTransactions({ ids: query.ids, limit: query.limit }).rows }
    }
    // Shown 200 at a time, as the page's Show more asks, to 1,200: each step reads only the lines it adds.
    let shown: Awaited<ReturnType<typeof drillRows>> | null = null
    for (let want = 200; want <= 1_200; want += 200) shown = await drillRows(read, list as never, q, shown, want)
    assert.equal(shown!.lines.length, 1_200)
    assert.deepEqual(
      shown!.lines.map((l) => l.key),
      linesFor(q, { limit: 1000 }).lines.map((l) => l.key).concat(linesFor(q, { offset: 1000, limit: 200 }).lines.map((l) => l.key))
    )
    assert.deepEqual([shown!.total, shown!.cents], [total, linesFor(q).cents])
    assert.deepEqual(
      asked.map((p) => [p.offset, p.limit]),
      [0, 200, 400, 600, 800, 1000].map((o) => [o, 200])
    )
    // Every line's transaction is at hand, each asked for once.
    for (const l of shown!.lines) assert.ok(shown!.txns.has(l.txnId), l.txnId)
    assert.equal(fetched.flat().length, new Set(fetched.flat()).size)
    // All at once, past 1,000, takes pages of 1,000.
    asked.length = 0
    const whole = await drillRows(read, list as never, q, null, total)
    assert.equal(whole.lines.length, total)
    assert.ok(asked.every((p) => (p.limit ?? 0) <= 1000))
  })

  test("a drill reads the lines the waterfall classified, kept until the data changes: over a month, 12M and All, a small part of classifying them again", (t) => {
    db.openDb(':memory:')
    largeLedger()
    const cpu = (f: () => void): number => {
      const was = process.cpuUsage()
      f()
      const d = process.cpuUsage(was)
      return (d.user + d.system) / 1000
    }
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    for (const span of [
      { from: '2026-10', to: '2026-10' },
      { from: '2025-12', to: '2026-11' },
      { from: first, to: '2026-11' }
    ]) {
      const w = getWaterfall(span)
      const q = lineQuery(view.unsortedFilter(w), '2026-11-09')!
      // The list's lines are the classified lines alone, as before: no payee or posting time rides along. Sub-phase 1j
      // added each line's venture, intent and who set it.
      const page = linesFor(q, { limit: 5 })
      assert.equal(page.total, w.unsorted.count, `${span.from} Unsorted's lines`)
      for (const l of page.lines) assert.deepEqual(Object.keys(l).sort(), ['accountId', 'assetId', 'categoryId', 'cents', 'cls', 'day', 'debtId', 'estimated', 'intent', 'intentSource', 'key', 'owner', 'paycheckKey', 'perimeter', 'seriesKey', 'shareBp', 'splitId', 'txnId', 'ventureId'])
      // Paired rounds, in alternating order, and the median of their ratios: npm test runs the files at once. Each
      // side runs often enough to take 120 ms classified again, well above the CPU clock's tick.
      const reps = Math.max(1, Math.ceil(120 / Math.max(cpu(() => classifyLines(q.fromDay, q.toDay)), 15.6)))
      const ratios: number[] = []
      const seen: string[] = []
      for (let k = 0; k < 6; k++) {
        const ms: Record<string, number> = {}
        for (const kept of k % 2 ? [true, false] : [false, true]) {
          ms[String(kept)] = cpu(() => {
            for (let i = 0; i < reps; i++) kept ? linesFor(q, { limit: 200 }) : classifyLines(q.fromDay, q.toDay)
          })
        }
        ratios.push(ms.true / Math.max(ms.false, 0.01))
        seen.push(`${ms.true.toFixed(1)}/${ms.false.toFixed(1)}`)
      }
      ratios.sort((a, b) => a - b)
      const median = (ratios[2] + ratios[3]) / 2
      t.diagnostic(`${span.from}..${span.to}: linesFor against classifyLines, ms of CPU by round: ${seen.join(', ')}; median ratio ${median.toFixed(2)}`)
      assert.ok(median <= 0.25, `${span.from}..${span.to}: the median ratio is ${median.toFixed(2)} (${seen.join(', ')})`)
    }
  })
})
