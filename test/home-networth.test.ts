import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiHost } from '../src/main/ai/host.ts'
import type { Span, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { household, TODAY } from './fixtures/waterfall-household.ts'

// Home's three views, Net worth's Overview and its Debts together (waterfall spec sub-phase 2d, its three parts
// merged): on the sample household, section 5's household and the section 2 tie-out, a month and YTD read the same
// figures in Home's Rows, Walk and Sankey; the Overview's line meets its bridge at every month's end, and its net worth
// today is the open month's bridge end; Debts' payoff plan lists every debt getDebts plans, owing what the balance
// sheet has it owe, and pays extra first on the debt Saved names; and Review's debt_plan, the headline's payoff digest,
// Saved's next debt and the Debts page all read the same debt.plan.

const here = dirname(fileURLToPath(import.meta.url))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place. The renderer's .tsx load through
// the same transform the app's bundler uses (Vite's Rolldown).
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
const { getBalanceSheet, getNetWorthSeries } = await import('../src/main/netWorth.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { getWaterfall } = await import('../src/main/waterfall.ts')
const { homePlans } = await import('../src/main/homePlans.ts')
const { DEBT_PLAN_KEY, debtPlan, getDebts, nextDebt } = await import('../src/main/debts.ts')
const { buildDigest } = await import('../src/main/insights.ts')
const { withAiHost } = await import('../src/main/ai/host.ts')
const { undo } = await import('../src/main/journal.ts')
const { runTool } = await import('../src/main/tools.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { runDebtPlan, shiftMonth, targetOf } = await import('../src/shared/debtPlan.ts')
const { fmtMoneyRound } = await import('../src/renderer/src/lib.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const nw = await import('../src/renderer/src/pages/netWorthView.ts')
const charts = await import('../src/renderer/src/Flow.tsx')
const { PayoffPlan, STRATEGY_NAME } = await import('../src/renderer/src/pages/DebtPlan.tsx')
const { tieOut } = await import('./fixtures/tieout.ts')

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const names = (): Map<string, string> => new Map(db.listAccounts().map((a) => [a.id, a.name]))
const page = (): string => renderToStaticMarkup(createElement(PayoffPlan, { view: getDebts() }))
const digestOf = (): ReturnType<typeof buildDigest> => withAiHost({} as AiHost, () => buildDigest())
const monthLong = (m: string): string => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

/** The three fixtures, each built on the ledger's clock at section 5's today. */
const FIXTURES: Array<[string, () => void]> = [
  [
    'the sample household',
    () => {
      db.openDb(':memory:')
      loadDemoData()
    }
  ],
  ["section 5's household", () => void household()],
  ['the section 2 tie-out', () => void tieOut()]
]

/** The last full month and YTD, as Home's picker gives them. */
function spans(): Array<[string, Span]> {
  const today = db.today()
  const cur = today.slice(0, 7)
  const first = getWaterfall({ from: cur, to: cur }).firstMonth
  const last = shiftMonth(cur, -1)
  return [
    [last, { from: last, to: last }],
    ['YTD', view.presetSpan('YTD', today, first)!]
  ]
}

/**
 * One span in the three views, figure by figure as each draws it: every Walk bar and every Sankey node reads what the
 * Rows show for its row (Gross pay to Saved, with the subtotal each row leads into open), and Kept, Saved at work and
 * the employer's saving after Kept read Saved's parts. Returns how many figures were compared.
 */
function sameInThreeViews(w: Waterfall, what: string): number {
  const rows = new Map<string, string>()
  const parts = new Map<string, string>()
  for (const open of [null, 'takeHome', 'elective', 'leftOver', 'saved'] as const)
    for (const l of view.homeTable(w, open, names()).lines) {
      if (l.kind === 'row') rows.set(l.name, l.amount)
      else if (open === 'saved' && l.kind === 'part') parts.set(l.name, l.amount)
    }
  let compared = 0
  const same = (figure: string, want: string | undefined, how: string): void => {
    assert.equal(figure, want, `${what}: ${how}`)
    compared++
  }
  // The Walk: up to Kept its bars are rows; from Kept on, Saved's parts, and then Saved.
  let inSaved = false
  for (const s of view.walkSteps(w)) {
    if (s.name === 'Kept') inSaved = true
    const own = s.name === 'Saved' ? rows : inSaved ? parts : rows
    same(charts.walkFigure(s), own.get(s.name), `the Walk's ${s.name}`)
  }
  // The Sankey as it opens, each node's label: Kept and the employer's saving are Saved's parts; Savings or credit
  // has no row.
  const f = view.sankeyFlow(w)
  const drawn = charts.drawSankey(f, new Set(charts.opensWith(f)), 662)
  for (const n of drawn.nodes) {
    if (n.of || n.name === 'Savings or credit') continue
    const own = n.name === 'Kept' || n.name === 'Employer saving' || (n.name === 'Saved at work' && !rows.has(n.name)) ? parts : rows
    same(n.label.figure, own.get(n.name), `the Sankey's ${n.name}`)
  }
  // Saved, the chain's end, in all three.
  const saved = rows.get('Saved')
  assert.ok(saved !== undefined, what)
  assert.equal(charts.walkFigure(view.walkSteps(w).at(-1)!), saved, `${what}: the Walk ends at Saved`)
  return compared
}

/**
 * The Overview over a span: its line at every month's end that has come is the month's line of the bridge as drawn,
 * the line starts at the bridge's start and ends at its end, and Net worth's tile, the balance sheet's, is the open
 * month's bridge end, the line's last point today.
 */
function overviewAgrees(w: Waterfall, what: string): void {
  const today = db.today()
  const points = nw.chartPoints(getNetWorthSeries([0]), w.span, today)
  const at = new Map(points.map((p) => [p.day, p.cents]))
  const lines = nw.bridgeLines(w)
  assert.deepEqual([points[0].cents, points.at(-1)!.cents], [lines[0].startCents, lines[0].endCents], `${what}: the line starts and ends where the bridge does`)
  for (const l of lines.filter((x) => !x.span && !x.closed)) {
    const m = w.months.find((x) => x.month === l.key)!
    const end = nw.spanDays({ from: m.month, to: m.month }).toDay
    if (end <= today) assert.equal(at.get(end), l.endCents, `${what} ${l.key}: the line at the month's end is its bridge's end`)
  }
}

/**
 * Debts as drawn: the payoff plan lists every debt getDebts plans, owing on the page what the balance sheet's cards
 * and loans have it owe (Net worth's walk to today), and its heading's next debt is Saved's, the plan's first target.
 */
function debtsAgree(what: string): void {
  const v = getDebts()
  assert.ok(v.debts.length > 0, what)
  const html = page()
  const sheet = getBalanceSheet()
  const listed = new Map(sheet.groups.filter((g) => g.id === 'cards' || g.id === 'loans').flatMap((g) => g.accounts.map((x) => [x.account.id, -x.cents] as const)))
  for (const d of v.debts) {
    assert.equal(listed.get(d.id), d.balanceCents, `${what}: ${d.name} on Debts`)
    assert.ok(html.includes(`title="${d.name}">`) && new RegExp(`${d.name}</span><span class="num" role="cell">${fmtMoneyRound(d.balanceCents).replace('$', '\\$')}</span>`).test(html), `${what}: ${d.name} in the plan at ${fmtMoneyRound(d.balanceCents)}`)
  }
  const run = runDebtPlan(v)
  const first = targetOf(run.debts, run.debts.map((d) => d.balanceCents), v.plan.strategy, shiftMonth(v.month, 1))
  const next = homePlans().nextDebt!
  assert.deepEqual([next.id, next.owedCents], [run.debts[first].id, run.debts[first].balanceCents], `${what}: Saved's next debt is the plan's first target`)
  assert.ok(html.includes(`${STRATEGY_NAME[v.plan.strategy]} · next ${next.name}</span>`), `${what}: the plan's heading names it`)
  const w = getWaterfall({ from: shiftMonth(v.month, -1), to: shiftMonth(v.month, -1) })
  const line = view.homeTable(w, 'saved', names(), { plans: homePlans() }).lines.find((l) => l.kind === 'data' && l.key === 'debt')
  assert.ok(line?.kind === 'data' && line.text.startsWith(`next ${next.name} `) && line.text.endsWith(` · ${view.dollars(next.owedCents)}`), `${what}: Saved's line ${JSON.stringify(line)}`)
}

/** What each reader of debt.plan makes of it: Review's debt_plan, the payoff digest, Saved's next debt and the Debts page. */
function readersAgree(what: string): void {
  const stored = JSON.parse(db.getSetting(DEBT_PLAN_KEY) ?? 'null') as Record<string, unknown> | null
  const v = getDebts()
  assert.deepEqual(v.plan, debtPlan(), what)
  if (stored) assert.deepEqual(v.plan, stored, `${what}: the page reads the setting as stored`)
  const run = runDebtPlan(v)
  const read = runTool('debt_plan', {}, 'assistant').result as { strategy: string; left_out: Array<{ account_id: string }>; take_home: number; set_aside: number; lump_sum: number; next: { account_id: string } | null; debt_free: string | null; debts: Array<{ account_id: string; owed: number }> }
  assert.deepEqual(
    [read.strategy, read.left_out.map((x) => x.account_id), read.take_home, read.set_aside, read.lump_sum],
    [v.plan.strategy, v.plan.leftOut, run.takeHomeCents / 100, v.plan.setAsideCents / 100, v.plan.lumpCents / 100],
    `${what}: Review's debt_plan`
  )
  assert.deepEqual(read.debts.map((d) => [d.account_id, d.owed]).sort(), run.debts.map((d) => [d.id, d.balanceCents / 100]).sort(), `${what}: Review's debts are the plan's`)
  assert.equal(read.debt_free, run.debts.length ? run.result.debtFree : null, `${what}: Review's debt-free month`)
  const next = nextDebt()
  assert.equal(read.next?.account_id ?? null, next?.id ?? null, `${what}: Review's next debt is Saved's`)
  const html = page()
  assert.ok(html.includes(`${STRATEGY_NAME[v.plan.strategy]}${next ? ` · next ${next.name}` : ''}</span>`), `${what}: the page's order and next debt`)
  const short = run.result.debtFree && run.debts.length ? `${new Date(`${run.result.debtFree}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short' })} ${run.result.debtFree.slice(0, 4)}` : '—'
  assert.ok(html.includes(`<div class="label-muted">Debt-free</div><div class="tile-value">${short}</div>`), `${what}: the page's debt-free month ${short}`)
  const payoff = digestOf()?.payoff ?? null
  if (!run.debts.length) assert.equal(payoff, null, what)
  else {
    assert.equal(payoff?.owed, Math.round(run.debts.reduce((s, d) => s + d.balanceCents, 0) / 100), `${what}: the digest owes the plan's debts`)
    assert.equal(payoff?.debtFreeAsIs, run.result.debtFree ? monthLong(run.result.debtFree) : null, `${what}: the digest's debt-free month`)
  }
}

describe("a month and YTD in Home's three views, on the Overview and on Debts", () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  for (const [what, load] of FIXTURES)
    test(what, () => {
      mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
      load()
      const cur = db.today().slice(0, 7)
      for (const [label, s] of spans()) {
        const w = getWaterfall(s)
        assert.ok(sameInThreeViews(w, `${what} ${label}`) >= 10, `${what} ${label}: the chain's figures compared`)
        overviewAgrees(w, `${what} ${label}`)
      }
      overviewAgrees(getWaterfall(view.presetSpan('12M', db.today(), null)!), `${what} 12M`)
      // Net worth's tile today is the open month's bridge end, with nothing dated after today in these books.
      const open = getWaterfall({ from: cur, to: cur })
      assert.deepEqual(getNetWorthSeries([0]).ahead, [], what)
      assert.equal(getBalanceSheet().netWorthCents, open.bridge.endCents, `${what}: net worth today is the open month's bridge end`)
      assert.equal(nw.bridgeLines(open)[0].endCents, open.bridge.endCents, what)
      debtsAgree(what)
    })
})

describe('debt.plan, read the same by Review, the payoff digest, Saved and the Debts page', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  for (const [what, load] of FIXTURES)
    test(what, () => {
      mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
      load()
      // Unset, the plan is the highest rate first with every debt in it.
      assert.equal(db.getSetting(DEBT_PLAN_KEY), null)
      readersAgree(`${what} unset`)
      // Review sets the smallest balance first, the debt it would pay first left out, its own take-home and a set-aside.
      const first = nextDebt()!
      const set = runTool('set_debt_plan', { strategy: 'snowball', left_out: [first.id], take_home: 7000, set_aside: 150 }, 'assistant')
      assert.ok(set.changeId, what)
      readersAgree(`${what} set`)
      assert.notEqual(nextDebt()?.id, first.id, `${what}: the debt left out is no longer Saved's next`)
      debtsAgree(`${what} set`)
      // Undone, every reader is back on the plan unset.
      const c = db.getChange(set.changeId!)!
      undo(c.tool, c.before, c.after, c.input)
      assert.equal(db.getSetting(DEBT_PLAN_KEY), null)
      readersAgree(`${what} undone`)
      assert.equal(nextDebt()?.id, first.id, what)
    })
})
