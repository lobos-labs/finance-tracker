import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FlowData, WalkStep } from '../src/renderer/src/Flow.tsx'
import type { Span, StageId, StageRow, Waterfall } from '../src/shared/types.ts'
import { shiftMonth } from '../src/shared/zone.ts'
import { budgetRatio, paired, repeatedMs, within } from './cost.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS, household, KEY, line, MONTHS, PAYROLL, TODAY } from './fixtures/waterfall-household.ts'

// Flow (waterfall spec sub-phase 2d, Decision 2): Home's Walk and Sankey are views of exactly its rows, over every
// span. Every Walk bar is its row's amount, or Saved's part's, to the cent, and the Walk ends at Saved; every Sankey
// node is its row, labeled as the rows show it, every band runs left to right with the subtotals' columns in the
// chain's order, and at every node what flows in less what flows out is what the node keeps, nothing at a subtotal.
// The Sankey as drawn reads its rows with any hub closed, and in the box Home has at 900 wide no label is cut or runs
// into another. Section 5's household, the sample household and the section 2 tie-out are drawn month by month and
// over YTD, 12M, All, a custom range and 30D, beside an open month, a month on deposits alone and one with a side
// income, a bonus, a Payroll difference either way, costs beyond what's left and every row below zero somewhere in
// the chain. October 2026 on the household is section 5's chain. The old pay math is gone, Roth and after-tax savings
// are post-tax however a stub was recorded, the charts show the rows' own whole dollars, their hubs work by keyboard,
// and switching the view asks for nothing.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place. The renderer's .tsx load through
// the same transform the app's bundler uses (Vite's Rolldown), so a page's hook runs here as it does there.
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
const { listPaystubs, savePaystub, yearCheck } = await import('../src/main/paystubs.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { planGroup, PAYSTUB_ITEM_KINDS } = await import('../src/shared/payroll.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const charts = await import('../src/renderer/src/Flow.tsx')
const { tieOut, MONTHS: TIE_MONTHS } = await import('./fixtures/tieout.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const month = (m: string): Waterfall => getWaterfall({ from: m, to: m })
const source = (path: string): string => readFileSync(join(root, path), 'utf8')

const rowOf = (w: Waterfall, id: StageId): StageRow | undefined => w.rows.find((r) => r.id === id)
/** A row's amount over the span, 0 when Home leaves the row out (a Payroll difference of 0, Gross pay standing as Take-home). */
const amount = (w: Waterfall, id: StageId): number => rowOf(w, id)?.actualCents ?? 0
/** A figure's opposite, 0 for 0 (never -0, which no amount is). */
const neg = (cents: number): number => (cents ? -cents : 0)
/** One of Saved's parts: Kept, saving at work, the employer's saving. */
const savedPart = (w: Waterfall, key: 'kept' | 'atWork' | 'employer'): number => rowOf(w, 'saved')!.parts.find((p) => p.key === key)!.actualCents

/**
 * The chain as Home's rows have it, in order: each subtotal at its amount, and between them what each row adds to the
 * running total (above zero) or takes off it (below): Gross pay and what comes off it at work, Take-home, Committed,
 * Elective, Everyday, Left over, One-offs, Kept, then saving at work and the employer's saving, and Saved.
 */
function chainOf(w: Waterfall): Array<[name: string, type: 'total' | 'step', cents: number]> {
  const out: Array<[string, 'total' | 'step', number]> = []
  const total = (name: string, cents: number): void => void out.push([name, 'total', cents])
  const step = (name: string, cents: number): void => void out.push([name, 'step', cents])
  if (rowOf(w, 'gross')) {
    total('Gross pay', amount(w, 'gross'))
    step('Taxes', neg(amount(w, 'taxes')))
    step('Benefits', neg(amount(w, 'benefits')))
    step('Saved at work', neg(amount(w, 'savedAtWork')))
    step('Payroll difference', amount(w, 'payrollDiff'))
  }
  total('Take-home', amount(w, 'takeHome'))
  step('Committed', neg(amount(w, 'committed')))
  total('Elective', amount(w, 'elective'))
  step('Everyday', neg(amount(w, 'everyday')))
  total('Left over', amount(w, 'leftOver'))
  step('One-offs', neg(amount(w, 'oneOffs')))
  total('Kept', savedPart(w, 'kept'))
  step('Saved at work', savedPart(w, 'atWork'))
  step('Employer saving', savedPart(w, 'employer'))
  total('Saved', amount(w, 'saved'))
  return out
}

/** The Walk's bars, each with what it adds to the running total: a total its figure, a step taken off below zero. */
const bars = (w: Waterfall): Array<[string, 'total' | 'step', number]> => view.walkSteps(w).map((s) => [s.name, s.type === 'total' ? 'total' : 'step', s.type === 'sub' ? -s.cents : s.cents])

/** Every Walk bar is its row's amount (a total) or its row's or Saved's part's (a step), to the cent; each total is the one before it with the steps between; the Walk ends at Saved. */
function walkTies(w: Waterfall, what: string): void {
  const steps = view.walkSteps(w)
  assert.deepEqual(bars(w), chainOf(w).filter(([, type, cents]) => type === 'total' || cents !== 0), `${what}: the Walk's bars are the rows`)
  // A step's bar is never below zero: what a row takes off below zero, it adds.
  assert.ok(steps.every((s) => s.type === 'total' || (s.cents > 0 && Number.isInteger(s.cents))), `${what}: every step above zero`)
  let run: number | null = null
  for (const [name, type, cents] of bars(w)) {
    if (type === 'step') run = run! + cents
    else {
      if (run !== null) assert.equal(cents, run, `${what}: ${name} is the total before it with the steps between`)
      run = cents
    }
  }
  assert.deepEqual(bars(w).at(-1), ['Saved', 'total', amount(w, 'saved')], `${what}: the Walk ends at Saved`)
  // Each bar's figure is its row's as the rows show it: what it takes off below zero, what it adds above, and a step
  // under 50 cents 0, never −0.
  assert.deepEqual(
    steps.map(charts.walkFigure),
    bars(w).map(([, , cents]) => view.dollars(cents)),
    `${what}: the Walk's figures are the rows'`
  )
}

/** A Sankey's links by their nodes' names. */
const named = (f: FlowData): Array<[string, string, number]> => f.links.map((l) => [f.nodes[l.source].name, f.nodes[l.target].name, l.value])

/** The subtotals in the chain's order, each with a column of its own. */
const SUBTOTALS = ['Gross pay', 'Take-home', 'Elective', 'Left over', 'Kept', 'Saved']

/**
 * Every Sankey node is its row, labeled as the rows show it, and every band runs left to right, the subtotals' columns
 * in the chain's order. At every node what flows in less what flows out is what the node keeps, to the cent: a cost
 * its row (below zero, what it gives), where the money starts (Gross pay, Take-home when it stands alone, a Payroll
 * difference above zero, the employer's saving) less its row, Saved what flows into it, and a subtotal and saving at
 * work nothing. Savings or credit gives what it met and is given back what refunds paid it: what it gave less what it
 * was given back is what Kept is below zero, the gap between Saved's row and what flows into it.
 */
function sankeyTies(w: Waterfall, what: string): FlowData {
  const f = view.sankeyFlow(w)
  const into = (i: number): number => f.links.filter((l) => l.target === i).reduce((s, l) => s + l.value, 0)
  const outOf = (i: number): number => f.links.filter((l) => l.source === i).reduce((s, l) => s + l.value, 0)
  const at = (name: string): number => f.nodes.findIndex((n) => n.name === name && !n.id)
  const alone = !rowOf(w, 'gross')
  const pos = (cents: number): number => Math.max(0, cents)
  const [kept, atWork, employer] = (['kept', 'atWork', 'employer'] as const).map((k) => savedPart(w, k))
  const keeps: Record<string, number> = {
    'Gross pay': neg(amount(w, 'gross')),
    Taxes: amount(w, 'taxes'),
    Benefits: amount(w, 'benefits'),
    'Saved at work': amount(w, 'savedAtWork') - pos(atWork),
    'Payroll difference': neg(amount(w, 'payrollDiff')),
    'Take-home': alone ? neg(amount(w, 'takeHome')) : 0,
    Committed: amount(w, 'committed'),
    Elective: 0,
    Everyday: amount(w, 'everyday'),
    'Left over': 0,
    'One-offs': amount(w, 'oneOffs'),
    Kept: 0,
    'Employer saving': neg(pos(employer)),
    Saved: pos(kept) + pos(atWork) + pos(employer)
  }
  // Each node once, and none but these and Savings or credit, drawn on and paid back.
  assert.deepEqual(
    f.nodes.map((n) => n.name).filter((n) => !(n in keeps) && n !== 'Savings or credit'),
    [],
    `${what}: no node of its own`
  )
  assert.equal(new Set(f.nodes.map((n) => `${n.name}:${n.id ?? ''}`)).size, f.nodes.length, `${what}: each node once`)
  for (const [name, cents] of Object.entries(keeps)) {
    const i = at(name)
    assert.equal(i < 0 ? 0 : into(i) - outOf(i), cents, `${what}: ${name} keeps ${cents}`)
  }
  const drawnOn = at('Savings or credit')
  const paidBack = f.nodes.findIndex((n) => n.name === 'Savings or credit' && !!n.id)
  const gave = drawnOn < 0 ? 0 : outOf(drawnOn)
  const given = paidBack < 0 ? 0 : into(paidBack)
  assert.equal(drawnOn < 0 ? 0 : into(drawnOn), 0, `${what}: Savings or credit drawn on only gives`)
  assert.equal(paidBack < 0 ? 0 : outOf(paidBack), 0, `${what}: Savings or credit paid back only takes`)
  assert.equal(gave - given, pos(-kept), `${what}: Savings or credit met what Kept is below zero`)
  // Each node is as large as what flows through it.
  f.nodes.forEach((n, i) => assert.equal(n.cents, Math.max(into(i), outOf(i)), `${what}: ${n.name} is what flows through it`))
  // Each node's label is its row as the rows show it: what comes off a subtotal below zero, below zero too where the
  // money starts, Saved its row; Savings or credit what it gave, and what it was given back below zero.
  const label: Record<string, number> = {
    'Gross pay': amount(w, 'gross'),
    ...Object.fromEntries((['taxes', 'benefits', 'savedAtWork', 'payrollDiff', 'committed', 'everyday', 'oneOffs'] as const).map((id) => [view.ROW_NAME[id], view.shown(id, amount(w, id))])),
    'Take-home': amount(w, 'takeHome'),
    Elective: amount(w, 'elective'),
    'Left over': amount(w, 'leftOver'),
    Kept: kept,
    'Employer saving': employer,
    Saved: amount(w, 'saved')
  }
  f.nodes.forEach((n) => assert.equal(n.shownCents, n.name === 'Savings or credit' ? (n.id ? -given : gave) : label[n.name], `${what}: ${n.name}'s label`))
  // A subtotal at or below zero has nothing flowing through it and isn't drawn, but where the money starts.
  for (const [name, cents] of [['Elective', amount(w, 'elective')], ['Left over', amount(w, 'leftOver')], ['Kept', kept], ...(alone ? [] : ([['Take-home', amount(w, 'takeHome')]] as const))] as const)
    assert.equal(at(name) >= 0, cents > 0, `${what}: ${name} drawn`)
  // Every band runs to a later column, and the subtotals drawn stand in the chain's order, each over its own column.
  assert.ok(
    f.links.every((l) => f.nodes[l.target].column > f.nodes[l.source].column),
    `${what}: every band runs left to right ${JSON.stringify(f.nodes.map((n) => [n.name, n.column]))}`
  )
  const chain = SUBTOTALS.filter((name) => at(name) >= 0)
  assert.deepEqual(
    chain.map((name) => f.nodes[at(name)].column),
    [...new Set(chain.map((name) => f.nodes[at(name)].column))].sort((a, b) => a - b),
    `${what}: the subtotals' columns in the chain's order`
  )
  for (const name of chain) assert.equal(f.nodes[at(name)].stage, name, `${what}: ${name} heads its column`)
  assert.ok(
    f.links.every((l) => l.value > 0 && Number.isInteger(l.value)),
    `${what}: every link carries whole cents`
  )
  return f
}

/** The box Home's charts have in a 900-wide window: the page less the sidebar and its padding. */
const BOX_900 = 662

/** Every label's box on the drawn Sankey: the nodes' and the groups' names. */
const boxes = (d: ReturnType<typeof charts.drawSankey>): Array<{ text: string; x: number; y: number; w: number; h: number }> => [
  ...d.nodes.map((n) => ({ text: `${n.label.name} ${n.label.figure}`, ...n.label.box })),
  ...d.groups.map((g) => ({ text: `${g.text} ${g.figure}`, ...g.box }))
]

/**
 * The Sankey as drawn, opened and closed hub by hub: each label reads its row whatever is closed, or its part's own
 * amount, and a block of parts names the node they stand in for with its figure. In the box Home has at 900 wide, by
 * default, no name is cut and no two labels overlap, and every column's header ends before the next one's starts.
 */
function drawnTies(w: Waterfall, what: string): void {
  const f = view.sankeyFlow(w)
  const rowFigure = new Map(f.nodes.map((n) => [`${n.kind}:${n.id ?? n.name}`, view.dollars(n.shownCents!)]))
  const check = (open: ReadonlySet<string>, how: string): ReturnType<typeof charts.drawSankey> => {
    const d = charts.drawSankey(f, open, BOX_900)
    for (const n of d.nodes) {
      const part = n.of ? f.nodes.find((x) => `${x.kind}:${x.id ?? x.name}` === n.of)?.parts?.find((p) => p.name === n.name) : undefined
      assert.equal(n.label.figure, part ? view.dollars(part.cents) : rowFigure.get(n.key), `${what} ${how}: ${n.name}'s label`)
    }
    for (const g of d.groups) if (g.of) assert.equal(g.figure, rowFigure.get(g.of), `${what} ${how}: ${g.text}'s parts under its figure`)
    return d
  }
  const start = new Set(charts.opensWith(f))
  const d = check(start, 'as it opens')
  for (const key of new Set(d.nodes.flatMap((n) => n.toggle ?? []).concat(d.groups.flatMap((g) => g.of ?? [])))) {
    const once = charts.toggled(f, start, key)
    check(once, `with ${key} clicked`)
    check(charts.toggled(f, once, key), `with ${key} clicked twice`)
  }
  for (const n of d.nodes) assert.equal(n.label.name, n.name, `${what}: ${n.name} isn't cut`)
  const all = boxes(d)
  for (let a = 0; a < all.length; a++)
    for (let b = a + 1; b < all.length; b++) {
      const [p, q] = [all[a], all[b]]
      const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y
      assert.ok(apart, `${what}: '${p.text}' and '${q.text}' overlap ${JSON.stringify([p, q])}`)
    }
  const heads = d.headers.map((h) => ({ text: h.text, from: h.first ? h.x - 8 - h.text.length * 10.5 * 0.78 : h.x + 16, to: h.first ? h.x - 8 : h.x + 16 + h.text.length * 10.5 * 0.78 }))
  for (let k = 1; k < heads.length; k++) assert.ok(heads[k - 1].to <= heads[k].from, `${what}: ${heads[k - 1].text} runs into ${heads[k].text}`)
  // The Walk's names, in its box, are whole too.
  assert.ok(
    charts.walkNames(view.walkSteps(w), BOX_900).names.every((lines) => lines.every((l) => !l.endsWith('…'))),
    `${what}: the Walk's names aren't cut ${JSON.stringify(charts.walkNames(view.walkSteps(w), BOX_900))}`
  )
}

const ties = (w: Waterfall, what: string): void => {
  walkTies(w, what)
  sankeyTies(w, what)
  drawnTies(w, what)
}

/** Every month from `first` to the open month, MTD among them, and the picker's YTD, 12M, All, a custom range and 30D. */
function spansOf(first: string, today: string): Array<{ what: string; span: Span }> {
  const cur = today.slice(0, 7)
  const out: Array<{ what: string; span: Span }> = []
  for (let m = first; m <= cur; m = shiftMonth(m, 1)) out.push({ what: m, span: { from: m, to: m } })
  for (const p of ['YTD', '12M', 'All', '30D'] as const) out.push({ what: p, span: view.presetSpan(p, today, first)! })
  out.push({ what: 'custom', span: { from: shiftMonth(cur, -8), to: shiftMonth(cur, -3) } })
  return out
}

/** Both charts over every span of a ledger; returns how many spans were drawn. */
function everySpan(first: string, what: string): number {
  const spans = spansOf(first, db.today())
  for (const { what: span, span: s } of spans) ties(getWaterfall(s), `${what} ${span} (${s.from}..${s.to})`)
  return spans.length
}

describe("section 5's household in the Walk and the Sankey", () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    household()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("October 2026 is section 5's chain, left to right: Gross pay 6,000.00 to Saved 685.70, Savings or credit meeting the 202.30 One-offs took beyond Left over", () => {
    const w = month('2026-10')
    walkTies(w, 'October')
    drawnTies(w, 'October')
    assert.deepEqual(
      view.walkSteps(w).map((s) => [s.name, s.type, s.cents]),
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
    const f = sankeyTies(w, 'October')
    assert.deepEqual(named(f), [
      ['Gross pay', 'Taxes', 143_100],
      ['Gross pay', 'Benefits', 19_200],
      ['Gross pay', 'Saved at work', 60_000],
      ['Gross pay', 'Take-home', 377_700],
      ['Take-home', 'Committed', 223_290],
      ['Take-home', 'Elective', 154_410],
      ['Elective', 'Everyday', 110_640],
      ['Elective', 'Left over', 43_770],
      ['Left over', 'One-offs', 43_770],
      ['Savings or credit', 'One-offs', 20_230],
      ['Saved at work', 'Saved', 60_000],
      ['Employer saving', 'Saved', 28_800]
    ])
    // Kept is -202.30, so no Kept node: Saved takes in 888.00 and reads 685.70, the row. Each subtotal has its column,
    // under its own name, with the rows that came off the one before it; Savings or credit stands beside Left over,
    // before the One-offs it met, and the employer's saving beside them, before Saved.
    assert.deepEqual(
      f.nodes.map((n) => [n.name, n.cents, n.shownCents, n.column, n.stage]),
      [
        ['Take-home', 377_700, 377_700, 1, 'Take-home'],
        ['Gross pay', 600_000, 600_000, 0, 'Gross pay'],
        ['Taxes', 143_100, -143_100, 1, 'Take-home'],
        ['Benefits', 19_200, -19_200, 1, 'Take-home'],
        ['Saved at work', 60_000, -60_000, 1, 'Take-home'],
        ['Elective', 154_410, 154_410, 2, 'Elective'],
        ['Committed', 223_290, -223_290, 2, 'Elective'],
        ['Left over', 43_770, 43_770, 3, 'Left over'],
        ['Everyday', 110_640, -110_640, 3, 'Left over'],
        ['One-offs', 64_000, -64_000, 4, 'Kept'],
        ['Savings or credit', 20_230, 20_230, 3, 'Left over'],
        ['Saved', 88_800, 68_570, 5, 'Saved'],
        ['Employer saving', 28_800, 28_800, 4, 'Kept']
      ]
    )
    // As drawn in the box Home has at 900 wide: the columns' headers in the chain's order, and Saved last.
    const d = charts.drawSankey(f, new Set(charts.opensWith(f)), BOX_900)
    assert.deepEqual(
      d.headers.map((h) => h.text),
      ['Gross pay', 'Take-home', 'Elective', 'Left over', 'Kept', 'Saved']
    )
    assert.ok(d.nodes.every((n) => n.x <= d.nodes.find((x) => x.name === 'Saved')!.x))
    // Rows, Walk and Sankey read the same whole dollars: the wireframe's 6,000, 3,777, 1,544, 438 and 686, and Kept -202.
    const rowsShow = view.homeTable(w, 'saved').lines.flatMap((l) => (l.kind === 'row' && !l.less ? [[l.name, l.amount]] : l.kind === 'part' && l.name === 'Kept' ? [[l.name, l.amount]] : []))
    assert.deepEqual(rowsShow.slice(0, 6), [
      ['Gross pay', '6,000'],
      ['Take-home', '3,777'],
      ['Elective', '1,544'],
      ['Left over', '438'],
      ['Saved', '686'],
      ['Kept', '−202']
    ])
    assert.deepEqual(
      view.walkSteps(w).filter((s) => s.type === 'total').map((s) => [s.name, view.dollars(s.cents)]),
      [
        ['Gross pay', '6,000'],
        ['Take-home', '3,777'],
        ['Elective', '1,544'],
        ['Left over', '438'],
        ['Kept', '−202'],
        ['Saved', '686']
      ]
    )
    assert.deepEqual(
      d.nodes.map((n) => [n.name, n.label.figure]),
      [
        ['Take-home', '3,777'],
        ['Gross pay', '6,000'],
        ['Taxes', '−1,431'],
        ['Benefits', '−192'],
        ['Saved at work', '−600'],
        ['Elective', '1,544'],
        ['Committed', '−2,233'],
        ['Left over', '438'],
        ['Everyday', '−1,106'],
        ['One-offs', '−640'],
        ['Savings or credit', '202'],
        ['Saved', '686'],
        ['Employer saving', '288']
      ]
    )
    // The rows show the less rows the same way, open under their subtotals.
    const less = (open: 'takeHome' | 'elective' | 'leftOver' | 'saved'): Array<[string, string]> => view.homeTable(w, open).lines.flatMap((l) => (l.kind === 'row' && l.less ? [[l.name, l.amount] as [string, string]] : []))
    assert.deepEqual([...less('takeHome'), ...less('elective'), ...less('leftOver'), ...less('saved')], [
      ['Taxes', '−1,431'],
      ['Benefits', '−192'],
      ['Saved at work', '−600'],
      ['Committed', '−2,233'],
      ['Everyday', '−1,106'],
      ['One-offs', '−640']
    ])
    // Closing Left over or Elective hides the One-offs past it, and Savings or credit with them; closing Saved at work
    // leaves Saved fed by the employer's saving alone. What stays reads its row.
    const shut = (key: string): Array<[string, string]> => charts.drawSankey(f, charts.toggled(f, new Set(charts.opensWith(f)), key), BOX_900).nodes.map((n) => [n.name, n.label.figure])
    assert.deepEqual(shut('pool:Left over'), [
      ['Take-home', '3,777'],
      ['Gross pay', '6,000'],
      ['Taxes', '−1,431'],
      ['Benefits', '−192'],
      ['Saved at work', '−600'],
      ['Elective', '1,544'],
      ['Committed', '−2,233'],
      ['Left over', '438'],
      ['Everyday', '−1,106'],
      ['Saved', '686'],
      ['Employer saving', '288']
    ])
    assert.ok(!shut('pool:Elective').some(([name]) => ['One-offs', 'Savings or credit', 'Left over', 'Everyday'].includes(name)))
    assert.deepEqual(
      shut('saving:Saved at work').filter(([name]) => ['Saved at work', 'Saved', 'Employer saving'].includes(name)),
      [
        ['Saved at work', '−600'],
        ['Saved', '686'],
        ['Employer saving', '288']
      ]
    )
  })

  test('every month from November 2024 to the open month, and YTD, 12M, All, a custom range and 30D', () => {
    const n = everySpan(MONTHS[0], 'household')
    assert.equal(n, 25 + 5)
    // 30D runs from Oct 9 to Nov 7: both October checks, and the days of November so far.
    assert.deepEqual(view.presetSpan('30D', db.today(), MONTHS[0]), { from: '2026-10-09', to: '2026-11-07' })
    const days = getWaterfall({ from: '2026-10-09', to: '2026-11-07' })
    assert.deepEqual(bars(days).slice(0, 5), [
      ['Gross pay', 'total', 600_000],
      ['Taxes', 'step', -143_100],
      ['Benefits', 'step', -19_200],
      ['Saved at work', 'step', -60_000],
      ['Take-home', 'total', 377_700]
    ])
    // A year to date whose Kept is above zero: Kept flows into Saved beside saving at work, and nothing is covered.
    const ytd = getWaterfall(view.presetSpan('YTD', db.today(), MONTHS[0])!)
    assert.ok(savedPart(ytd, 'kept') > 0)
    const f = view.sankeyFlow(ytd)
    assert.ok(!f.nodes.some((x) => x.name === 'Savings or credit'))
    assert.deepEqual(
      named(f).filter(([, to]) => to === 'Saved'),
      [
        ['Kept', 'Saved', savedPart(ytd, 'kept')],
        ['Saved at work', 'Saved', savedPart(ytd, 'atWork')],
        ['Employer saving', 'Saved', savedPart(ytd, 'employer')]
      ]
    )
  })
})

describe('the household in the months that bend the chain', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** The deposit of October 31's check. */
  const october31 = (): string => db.get<{ id: string }>('SELECT id FROM transactions WHERE account_id = ? AND amount_cents = 188850 ORDER BY posted DESC LIMIT 1', ACCOUNTS.checking)!.id

  test('deposits only: Take-home is where the money starts, and Savings or credit meets the 202.30 that leaves Saved below zero', () => {
    household({ paystubs: false })
    everySpan(MONTHS[0], 'deposits only')
    const w = month('2026-10')
    assert.equal(rowOf(w, 'gross'), undefined)
    assert.deepEqual(
      view.walkSteps(w).map((s) => [s.name, s.type, s.cents]),
      [
        ['Take-home', 'total', 377_700],
        ['Committed', 'sub', 223_290],
        ['Elective', 'total', 154_410],
        ['Everyday', 'sub', 110_640],
        ['Left over', 'total', 43_770],
        ['One-offs', 'sub', 64_000],
        ['Kept', 'total', -20_230],
        ['Saved', 'total', -20_230]
      ]
    )
    const f = sankeyTies(w, 'deposits only October')
    assert.deepEqual(named(f), [
      ['Take-home', 'Committed', 223_290],
      ['Take-home', 'Elective', 154_410],
      ['Elective', 'Everyday', 110_640],
      ['Elective', 'Left over', 43_770],
      ['Left over', 'One-offs', 43_770],
      ['Savings or credit', 'One-offs', 20_230]
    ])
    // Nothing flows into Saved, -202.30, so like any subtotal below zero it isn't drawn; the rows and the Walk show it.
    assert.ok(!f.nodes.some((n) => n.name === 'Saved'))
  })

  test('deposits and a side income: Take-home opens into its two sources, each its own amount, under Take-home and its 4,177', () => {
    household({ paystubs: false })
    line(ACCOUNTS.checking, '2026-10-20', 40_000, 'CRAFT FAIR PAYOUT', 'Other Income', 'Craft Fair')
    const w = month('2026-10')
    ties(w, 'deposits and a side income')
    const take = rowOf(w, 'takeHome')!
    assert.equal(take.actualCents, 417_700)
    const f = view.sankeyFlow(w)
    const d = charts.drawSankey(f, new Set(charts.opensWith(f)), BOX_900)
    assert.deepEqual(
      d.groups.map((g) => [g.text, g.figure, g.of]),
      [['Take-home', '4,177', 'pool:Take-home']]
    )
    assert.deepEqual(
      d.nodes.filter((n) => n.of === 'pool:Take-home').map((n) => [n.name, n.label.figure]),
      take.parts.map((p) => [p.name, view.dollars(p.actualCents)])
    )
    // Closed, Take-home is one node at its row.
    const closed = charts.drawSankey(f, charts.toggled(f, new Set(charts.opensWith(f)), 'pool:Take-home'), BOX_900)
    assert.deepEqual(
      closed.nodes.filter((n) => n.name === 'Take-home').map((n) => [n.label.figure, n.label.sign]),
      [['4,177', '+']]
    )
  })

  test("a bonus month: October's 5,000.00 bonus check counts in Gross pay, Taxes and Take-home in both charts, and Kept 3,315.20 flows into Saved", () => {
    household()
    line(ACCOUNTS.checking, '2026-10-20', 351_750, 'BRIGHTLINE PAYROLL DIR DEP', 'Paycheck', PAYROLL)
    savePaystub({ paycheckKey: KEY, payDay: '2026-10-20', kind: 'bonus', grossCents: 500_000, items: [{ kind: 'federal', cents: 110_000 }, { kind: 'social_security', cents: 31_000 }, { kind: 'medicare', cents: 7_250 }] })
    const w = month('2026-10')
    assert.ok(w.payChecks.some((c) => c.kind === 'bonus' && c.day === '2026-10-20'))
    ties(w, 'bonus October')
    assert.deepEqual(
      view.walkSteps(w).map((s) => [s.name, s.type, s.cents]),
      [
        ['Gross pay', 'total', 1_100_000],
        ['Taxes', 'sub', 291_350],
        ['Benefits', 'sub', 19_200],
        ['Saved at work', 'sub', 60_000],
        ['Take-home', 'total', 729_450],
        ['Committed', 'sub', 223_290],
        ['Elective', 'total', 506_160],
        ['Everyday', 'sub', 110_640],
        ['Left over', 'total', 395_520],
        ['One-offs', 'sub', 64_000],
        ['Kept', 'total', 331_520],
        ['Saved at work', 'add', 60_000],
        ['Employer saving', 'add', 28_800],
        ['Saved', 'total', 420_320]
      ]
    )
    assert.deepEqual(named(view.sankeyFlow(w)).slice(-5), [
      ['Left over', 'One-offs', 64_000],
      ['Left over', 'Kept', 331_520],
      ['Kept', 'Saved', 331_520],
      ['Saved at work', 'Saved', 60_000],
      ['Employer saving', 'Saved', 28_800]
    ])
    for (const s of [{ from: '2026-01', to: '2026-11' }, { from: '2026-10-09', to: '2026-11-07' }]) ties(getWaterfall(s), `bonus ${s.from}..${s.to}`)
  })

  test('a Payroll difference below zero comes off Gross pay beside the taxes, and one above zero adds to Take-home', () => {
    // October 31's deposit 50.00 short of its stub's net: Take-home is the deposits, 3,727.00.
    household()
    db.run('UPDATE transactions SET amount_cents = 183850 WHERE id = ?', october31())
    const short = month('2026-10')
    ties(short, 'Payroll difference -50.00')
    assert.equal(amount(short, 'payrollDiff'), -5_000)
    assert.deepEqual(bars(short).slice(0, 6), [
      ['Gross pay', 'total', 600_000],
      ['Taxes', 'step', -143_100],
      ['Benefits', 'step', -19_200],
      ['Saved at work', 'step', -60_000],
      ['Payroll difference', 'step', -5_000],
      ['Take-home', 'total', 372_700]
    ])
    assert.deepEqual(named(view.sankeyFlow(short)), [
      ['Gross pay', 'Taxes', 143_100],
      ['Gross pay', 'Benefits', 19_200],
      ['Gross pay', 'Saved at work', 60_000],
      ['Gross pay', 'Payroll difference', 5_000],
      ['Gross pay', 'Take-home', 372_700],
      ['Take-home', 'Committed', 223_290],
      ['Take-home', 'Elective', 149_410],
      ['Elective', 'Everyday', 110_640],
      ['Elective', 'Left over', 38_770],
      ['Left over', 'One-offs', 38_770],
      ['Savings or credit', 'One-offs', 25_230],
      ['Saved at work', 'Saved', 60_000],
      ['Employer saving', 'Saved', 28_800]
    ])
    // Its label keeps its sign, as the rows show it: −50 taken off, beside the taxes.
    const label = (w: Waterfall): Array<[string, number, string]> => charts.drawSankey(view.sankeyFlow(w), new Set(charts.opensWith(view.sankeyFlow(w))), BOX_900).nodes.flatMap((n) => (n.name === 'Payroll difference' ? [[n.kind, n.column, n.label.figure] as [string, number, string]] : []))
    assert.deepEqual(label(short), [['tax', 1, '−50']])
    everySpan(MONTHS[0], 'Payroll difference -50.00')
    db.closeDb()
    // 50.00 over its net: the difference joins Gross pay's band at Take-home, 3,827.00.
    household()
    db.run('UPDATE transactions SET amount_cents = 193850 WHERE id = ?', october31())
    const over = month('2026-10')
    ties(over, 'Payroll difference +50.00')
    assert.deepEqual(bars(over).slice(4, 6), [
      ['Payroll difference', 'step', 5_000],
      ['Take-home', 'total', 382_700]
    ])
    assert.deepEqual(named(view.sankeyFlow(over)).slice(0, 6), [
      ['Gross pay', 'Taxes', 143_100],
      ['Gross pay', 'Benefits', 19_200],
      ['Gross pay', 'Saved at work', 60_000],
      ['Gross pay', 'Take-home', 377_700],
      ['Payroll difference', 'Take-home', 5_000],
      ['Take-home', 'Committed', 223_290]
    ])
    // Added to Take-home: 50, beside Gross pay.
    assert.deepEqual(label(over), [['match', 0, '50']])
  })

  test('the open month so far: no pay yet, so Savings or credit meets every cost, and Saved, below zero, is not drawn', () => {
    household()
    line(ACCOUNTS.checking, '2026-11-01', -198_500, 'PINECREST MORTGAGE PMT', 'Housing', 'Pinecrest Mortgage')
    line(ACCOUNTS.visa, '2026-11-03', -6_400, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    line(ACCOUNTS.visa, '2026-11-04', -1_250, 'DAILY GRIND CAFE', 'Coffee', 'Daily Grind')
    const w = month('2026-11')
    assert.equal(w.partial, true)
    ties(w, 'November so far')
    assert.ok(amount(w, 'takeHome') === 0 && amount(w, 'committed') > 0 && amount(w, 'everyday') === 7_650)
    const f = view.sankeyFlow(w)
    // No subtotal holds anything, so none is drawn; Savings or credit meets the costs, under Take-home's header.
    assert.deepEqual(
      f.nodes.map((n) => [n.name, n.stage]),
      [
        ['Committed', 'Elective'],
        ['Savings or credit', 'Take-home'],
        ['Everyday', 'Left over']
      ]
    )
    assert.deepEqual(named(f), [
      ['Savings or credit', 'Committed', amount(w, 'committed')],
      ['Savings or credit', 'Everyday', 7_650]
    ])
    assert.equal(f.nodes.find((n) => n.name === 'Savings or credit')!.shownCents, amount(w, 'committed') + 7_650)
    for (const s of [view.presetSpan('MTD', db.today(), null)!, view.presetSpan('30D', db.today(), null)!, view.presetSpan('YTD', db.today(), null)!]) ties(getWaterfall(s), `with November's lines ${s.from}..${s.to}`)
  })

  test('every row below zero somewhere in the chain: a tax refund beyond withholding, Committed beyond Take-home with refunds after it, Take-home below zero with Gross pay and alone, and Gross pay below zero', () => {
    household()
    const october = month('2026-10')
    const template = rowOf(october, 'takeHome')!
    /** October with its chain set to these amounts, each subtotal the difference of the rows before it, as the engine takes them. */
    const chain = (c: { gross: number | null; taxes?: number; benefits?: number; savedAtWork?: number; payrollDiff?: number; takeHome?: number; committed: number; everyday: number; oneOffs: number; employer?: number }): Waterfall => {
      const alone = c.gross === null
      const savedAtWork = alone ? 0 : (c.savedAtWork ?? 0)
      const takeHome = alone ? c.takeHome! : c.gross! - (c.taxes ?? 0) - (c.benefits ?? 0) - savedAtWork + (c.payrollDiff ?? 0)
      const elective = takeHome - c.committed
      const leftOver = elective - c.everyday
      const kept = leftOver - c.oneOffs
      const employer = c.employer ?? 0
      const amounts: Partial<Record<StageId, number>> = { gross: c.gross ?? 0, taxes: c.taxes ?? 0, benefits: c.benefits ?? 0, savedAtWork, payrollDiff: c.payrollDiff ?? 0, takeHome, committed: c.committed, elective, everyday: c.everyday, leftOver, oneOffs: c.oneOffs, saved: kept + savedAtWork + employer }
      const ids: StageId[] = [...(alone ? [] : (['gross', 'taxes', 'benefits', 'savedAtWork', 'payrollDiff'] as StageId[])), 'takeHome', 'committed', 'elective', 'everyday', 'leftOver', 'oneOffs', 'saved', 'invested', 'growth']
      const parts = { kept, atWork: savedAtWork, employer }
      const rows = ids.map((id): StageRow => {
        const r = rowOf(october, id) ?? { ...template, id, parts: [] }
        if (id === 'saved') return { ...r, actualCents: amounts.saved!, parts: r.parts.map((p) => ({ ...p, actualCents: parts[p.key as keyof typeof parts] })) }
        return { ...r, actualCents: amounts[id] ?? r.actualCents, parts: id === 'gross' || id === 'takeHome' ? [] : r.parts }
      })
      return { ...october, rows }
    }
    // A refund of 500.00 beyond what was withheld: Taxes gives beside Gross pay.
    const refund = chain({ gross: 100_000, taxes: -50_000, committed: 60_000, everyday: 30_000, oneOffs: 10_000 })
    ties(refund, 'a tax refund')
    assert.deepEqual(named(view.sankeyFlow(refund)), [
      ['Gross pay', 'Take-home', 100_000],
      ['Taxes', 'Take-home', 50_000],
      ['Take-home', 'Committed', 60_000],
      ['Take-home', 'Elective', 90_000],
      ['Elective', 'Everyday', 30_000],
      ['Elective', 'Left over', 60_000],
      ['Left over', 'One-offs', 10_000],
      ['Left over', 'Kept', 50_000],
      ['Kept', 'Saved', 50_000]
    ])
    assert.deepEqual(bars(refund).slice(0, 3), [
      ['Gross pay', 'total', 100_000],
      ['Taxes', 'step', 50_000],
      ['Take-home', 'total', 150_000]
    ])
    // Committed 500.00 beyond Take-home, then 800.00 of refunds: they bring Left over back to 300.00 and pay Savings or
    // credit back the 500.00 it met, so Saved owes it nothing. Drawn on before Committed and paid back after the
    // refunds, it is two nodes, and every band still runs left to right.
    const back = chain({ gross: 300_000, taxes: 50_000, savedAtWork: 50_000, committed: 250_000, everyday: -80_000, oneOffs: 10_000, employer: 10_000 })
    ties(back, 'refunds after a shortfall')
    assert.deepEqual(
      view.sankeyFlow(back).nodes.filter((n) => n.name === 'Savings or credit' || n.name === 'Everyday').map((n) => [n.name, n.column, n.shownCents]),
      [
        ['Savings or credit', 1, 50_000],
        ['Everyday', 2, 80_000],
        ['Savings or credit', 3, -50_000]
      ]
    )
    assert.deepEqual(named(view.sankeyFlow(back)), [
      ['Gross pay', 'Taxes', 50_000],
      ['Gross pay', 'Saved at work', 50_000],
      ['Gross pay', 'Take-home', 200_000],
      ['Take-home', 'Committed', 200_000],
      ['Savings or credit', 'Committed', 50_000],
      ['Everyday', 'Left over', 30_000],
      ['Everyday', 'Savings or credit', 50_000],
      ['Left over', 'One-offs', 10_000],
      ['Left over', 'Kept', 20_000],
      ['Kept', 'Saved', 20_000],
      ['Saved at work', 'Saved', 50_000],
      ['Employer saving', 'Saved', 10_000]
    ])
    // An estimated tax payment of 1,200.00 in a month with no pay: Take-home -1,200.00, every cost met.
    const taxOnly = chain({ gross: 0, taxes: 120_000, committed: 50_000, everyday: 20_000, oneOffs: 0 })
    ties(taxOnly, 'Take-home below zero')
    assert.deepEqual(named(view.sankeyFlow(taxOnly)), [
      ['Savings or credit', 'Taxes', 120_000],
      ['Savings or credit', 'Committed', 50_000],
      ['Savings or credit', 'Everyday', 20_000]
    ])
    // Take-home standing alone at -300.00, and a 50.00 reimbursement among the One-offs: it pays Savings or credit back.
    const alone = chain({ gross: null, takeHome: -30_000, committed: 10_000, everyday: 0, oneOffs: -5_000 })
    ties(alone, 'Take-home alone below zero')
    const f = view.sankeyFlow(alone)
    assert.deepEqual(named(f), [
      ['Savings or credit', 'Take-home', 30_000],
      ['Savings or credit', 'Committed', 10_000],
      ['One-offs', 'Savings or credit', 5_000]
    ])
    assert.equal(f.nodes.find((n) => n.name === 'Take-home')!.shownCents, -30_000)
    // A check reversed: Gross pay -100.00.
    const reversed = chain({ gross: -10_000, committed: 0, everyday: 0, oneOffs: 0 })
    ties(reversed, 'Gross pay below zero')
    assert.deepEqual(named(view.sankeyFlow(reversed)), [['Savings or credit', 'Gross pay', 10_000]])
  })
})

describe('the tie-out and the sample household in the Walk and the Sankey', () => {
  test('the section 2 tie-out: every month, and YTD, 12M, All, a custom range and 30D', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    try {
      tieOut()
      assert.equal(everySpan(TIE_MONTHS[0], 'tie-out'), TIE_MONTHS.length + 1 + 5)
      // October: Gross pay 5,600.00 down to Take-home 4,000.00, the two checks' deposits.
      assert.deepEqual(bars(month('2026-10')).slice(0, 4), [
        ['Gross pay', 'total', 560_000],
        ['Taxes', 'step', -90_000],
        ['Benefits', 'step', -20_000],
        ['Saved at work', 'step', -50_000]
      ])
    } finally {
      db.closeDb()
      mock.timers.reset()
    }
  })

  test('the sample household: every month to the open one, and YTD, 12M, All, a custom range and 30D', () => {
    db.openDb(':memory:')
    try {
      loadDemoData()
      const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
      assert.ok(everySpan(first, 'demo') > 12)
      // Its open month is under way: the charts draw it as the rows have it so far.
      const open = month(db.today().slice(0, 7))
      assert.equal(open.partial, true)
      ties(open, 'demo open month')
      // A span of one check: its deposit is 0.38 short of its stub's net, which the rows show as 0 and the Walk too.
      const last = month(shiftMonth(db.today().slice(0, 7), -1))
      const check = last.payChecks.filter((c) => c.kind === 'regular').at(-1)!
      const one = getWaterfall({ from: check.day, to: check.day })
      ties(one, `demo ${check.day}`)
      assert.equal(amount(one, 'payrollDiff'), -38)
      const rowShows = view.homeTable(one, 'takeHome').lines.find((l) => l.kind === 'row' && l.name === 'Payroll difference')
      assert.equal(rowShows?.kind === 'row' ? rowShows.amount : null, '0')
      assert.deepEqual(
        view.walkSteps(one).filter((s) => s.name === 'Payroll difference').map(charts.walkFigure),
        ['0']
      )
    } finally {
      db.closeDb()
    }
  })

  test("at a phone's width the sample household's Walk keeps each figure apart from the next, and from 900 wide it is drawn as before", () => {
    db.openDb(':memory:')
    try {
      loadDemoData()
      const steps = view.walkSteps(month(shiftMonth(db.today().slice(0, 7), -1)))
      // A figure's width in the mono face, whose characters are all 0.6 of its size: a total's 11 px, a step's 10.5.
      const figure = (s: WalkStep): number => charts.walkFigure(s).length * (s.type === 'total' ? 11 : 10.5) * 0.6
      // The rows' box at 320, 375 and 414 wide, less 16 px a side: at 36 px a slot, Gross pay's total ran into the
      // step after it.
      for (const box of [288, 343, 382]) {
        const width = charts.walkWidth(steps, box)
        const slot = width / steps.length
        assert.ok(width > box, `${box}: the walk scrolls in its box`)
        for (let k = 1; k < steps.length; k++) {
          const gap = slot - (figure(steps[k - 1]) + figure(steps[k])) / 2
          assert.ok(gap >= 6, `${box}: ${charts.walkFigure(steps[k - 1])} and ${charts.walkFigure(steps[k])} are ${gap.toFixed(1)} px apart`)
        }
      }
      // A desktop window's box is the walk's width, its slots never under 36 px, as they were.
      for (const box of [BOX_900, 1000, 1400]) assert.equal(charts.walkWidth(steps, box), Math.max(box, steps.length * 36))
      assert.equal(charts.walkWidth(steps, 0), 0)
    } finally {
      db.closeDb()
    }
  })
})

describe('one source for the three views', () => {
  test('Roth is post-tax: planGroup reads each paystub line, so a Roth or after-tax 401(k) and the ESPP are post-tax, and the 401(k), 403(b), 457(b) and HSA pre-tax', () => {
    assert.equal(planGroup('roth_401k'), 'posttax')
    assert.equal(planGroup('after_tax_401k'), 'posttax')
    assert.equal(planGroup('espp'), 'posttax')
    assert.equal(planGroup('401k'), 'pretax')
    assert.equal(planGroup('403b'), 'pretax')
    assert.equal(planGroup('457'), 'pretax')
    assert.equal(planGroup('hsa'), 'pretax')
    // Every savings line, by its paystub kind's pretax flag.
    const savings = PAYSTUB_ITEM_KINDS.filter((k) => ['401k', 'roth_401k', 'after_tax_401k', '403b', '457', 'hsa', 'espp'].includes(k))
    assert.deepEqual(Object.fromEntries(savings.map((k) => [k, planGroup(k)])), { '401k': 'pretax', roth_401k: 'posttax', after_tax_401k: 'posttax', '403b': 'pretax', '457': 'pretax', hsa: 'pretax', espp: 'posttax' })
    // It lives with the paystub lines it reads; the charts no longer group pay at all.
    assert.doesNotMatch(source('src/renderer/src/Flow.tsx'), /planGroup|PRETAX|POSTTAX/)
    for (const f of ['src/main/contributions.ts', 'src/main/paystubs.ts', 'src/main/db.ts']) assert.match(source(f), /planGroup\(/, f)
  })

  test("a stub's savings plan is pre-tax or post-tax by its kind, whatever flag it was recorded with, so the year's wages count a Roth line", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    try {
      db.openDb(':memory:')
      // Two 3,000.00 checks with a 240.00 Roth 401(k) line, the second recorded as if taken before income tax, and a
      // 401(k) line recorded as if after it; a premium keeps the flag it was recorded with.
      savePaystub({ paycheckKey: KEY, payDay: '2026-01-15', grossCents: 300_000, items: [{ kind: 'federal', cents: 30_000 }, { kind: 'roth_401k', cents: 24_000 }] })
      savePaystub({ paycheckKey: KEY, payDay: '2026-01-30', grossCents: 300_000, items: [{ kind: 'federal', cents: 30_000 }, { kind: 'roth_401k', cents: 24_000, pretax: true }, { kind: '401k', cents: 10_000, pretax: false }, { kind: 'life', cents: 1_000, pretax: true }] })
      assert.deepEqual(
        listPaystubs(KEY).map((s) => s.items.map((x) => [x.kind, x.pretax])),
        [
          [
            ['federal', false],
            ['roth_401k', false]
          ],
          [
            ['federal', false],
            ['roth_401k', false],
            ['401k', true],
            ['life', true]
          ]
        ]
      )
      // Wages are gross less the pre-tax lines: the 401(k) and the premium come out, the Roth lines don't.
      assert.equal(yearCheck(2026).wagesCents, 600_000 - 10_000 - 1_000)
    } finally {
      db.closeDb()
      mock.timers.reset()
    }
  })

  test('a Roth election is post-tax on the checks it estimates, and the HSA beside it pre-tax', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    try {
      household({ paystubs: false })
      db.saveContribution({ name: 'Brightline Roth 401(k)', kind: 'roth_401k', accountId: ACCOUNTS.retirement, paycheckKey: KEY, employeeCents: 24_000, matchCents: 0 })
      db.saveContribution({ name: 'Brightline HSA', kind: 'hsa', accountId: ACCOUNTS.hsa, paycheckKey: KEY, employeeCents: 6_000, matchCents: 0 })
      const check = month('2026-10').payChecks.find((c) => c.day === '2026-10-15')!
      assert.deepEqual(
        check.items.map((x) => [x.kind, x.cents, x.pretax]).sort(([a], [b]) => String(a).localeCompare(String(b))),
        [
          ['hsa', 6_000, true],
          ['roth_401k', 24_000, false]
        ]
      )
    } finally {
      db.closeDb()
      mock.timers.reset()
    }
  })

  test("no pay math of the charts' own: grep finds no payFlows, the Recurring page's money flow is gone, and Flow.tsx draws only what Home builds", () => {
    const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|mts|cjs|mjs|md)$/.test(e.name) ? [join(dir, e.name)] : []))
    // This file names them to look for them. The public export's tree has no docs folder, so a folder this tree
    // doesn't have is nothing to look in.
    const self = join('test', 'flow.test.ts')
    const folders = ['src', 'test', 'scripts', 'docs'].filter((dir) => existsSync(join(root, dir)))
    assert.ok(folders.includes('src') && folders.includes('test'))
    for (const f of folders.flatMap(files).filter((f) => f !== self)) assert.doesNotMatch(source(f), /\b(payFlows|MoneyFlow|flowBuilder|spendFrom|RecurringFlow)\b/, f)
    assert.equal(existsSync(join(root, 'src/renderer/src/pages/RecurringFlow.tsx')), false)
    const flow = source('src/renderer/src/Flow.tsx')
    // The Walk and the Sankey take their bars and nodes as given: no walk of a flow of its own, no view prop.
    assert.doesNotMatch(flow, /function walk\(|view === 'walk'|view\?: FlowView/)
    assert.match(flow, /export function FlowChart\(\{ data \}: \{ data: FlowData \}\)/)
    assert.match(flow, /export function StepWalk\(\{ steps \}: \{ steps: WalkStep\[\] \}\)/)
    // In a box narrower than they need, both keep a width they can be read at and the box scrolls sideways, so a narrow
    // window never draws an empty Sankey or a walk of overlapping figures.
    assert.match(flow, /const width = Math\.max\(box, SANKEY_MIN\)/)
    const two: FlowData = {
      nodes: [
        { name: 'Gross pay', cents: 100, kind: 'job', column: 0 },
        { name: 'Taxes', cents: 100, kind: 'tax', column: 1 }
      ],
      links: [{ source: 0, target: 1, value: 100 }]
    }
    assert.equal(charts.drawSankey(two, new Set(), 137).width, 560)
    assert.match(flow, /const width = walkWidth\(steps, box\)/)
    assert.match(flow, /return Math\.max\(box, Math\.ceil\(steps\.length \* slot\)\)/)
    assert.equal(flow.match(/overflowX: 'auto'/g)?.length, 2)
    // FlowChart draws what drawSankey lays out, and every node names itself in full with its figure.
    assert.match(flow, /const drawn = useMemo\(\(\) => \(box > 0 \? drawSankey\(data, open, box\) : null\), \[data, open, box\]\)/)
    assert.match(flow, /<title>\{`\$\{nd\.name\} \$\{l\.figure\}`\}<\/title>/)
    // Their figures are the rows' whole dollars, rounded half away from zero with a true minus.
    assert.match(flow, /^import \{ dollars \} from '\.\/pages\/homeView'$/m)
    assert.doesNotMatch(flow, /fmtMoney/)
    assert.equal(view.dollars(-20_250), `${view.MINUS}203`)
    // Home draws them from the one waterfall it has.
    const home = source('src/renderer/src/pages/Home.tsx')
    assert.match(home, /const steps = useMemo\(\(\) => \(wf \? walkSteps\(wf\) : \[\]\), \[wf\]\)/)
    assert.match(home, /const flow = useMemo\(\(\) => \(wf \? sankeyFlow\(wf\) : null\), \[wf\]\)/)
    assert.match(home, /<StepWalk steps=\{steps\} \/>/)
    assert.match(home, /<FlowChart data=\{flow\} \/>/)
  })

  test("the Sankey's hubs are buttons: Tab reaches them, Enter or Space opens or closes them, and each says what it is and whether it's open", () => {
    const clicked: string[] = []
    const props = charts.hubProps('pool:Left over', true, 'Left over 438', (key) => clicked.push(key)) as { role: string; tabIndex: number; 'aria-expanded': boolean; 'aria-label': string; className: string; onKeyDown: (e: { key: string; preventDefault: () => void }) => void; onClick: () => void }
    assert.deepEqual([props.role, props.tabIndex, props['aria-expanded'], props['aria-label'], props.className], ['button', 0, true, 'Left over 438', 'flow-hub'])
    let prevented = 0
    for (const key of ['Enter', ' ', 'a', 'Tab']) props.onKeyDown({ key, preventDefault: () => prevented++ })
    props.onClick()
    assert.deepEqual(clicked, ['pool:Left over', 'pool:Left over', 'pool:Left over'])
    assert.equal(prevented, 2)
    // FlowChart gives every hub and every block of parts these, and the chart is a group of them, not one picture; so
    // is the Walk, whose figures and names a screen reader then reads bar by bar.
    const flow = source('src/renderer/src/Flow.tsx')
    assert.match(flow, /<svg width=\{drawn\.width\} height=\{drawn\.height\} role="group" aria-label="Money flow">/)
    assert.match(flow, /<svg width=\{width\} height=\{height\} role="group" aria-label="Money walk">/)
    assert.doesNotMatch(flow, /role="img"/)
    assert.match(flow, /\{\.\.\.\(g\.of \? hub\(g\.of, true, `\$\{g\.text\} \$\{g\.figure\}`\) : \{\}\)\}/)
    assert.match(flow, /\{\.\.\.\(nd\.toggle \? hub\(nd\.toggle, nd\.open, `\$\{nd\.name\} \$\{l\.figure\}`\) : \{\}\)\}/)
    assert.match(source('src/renderer/src/styles.css'), /\.flow-hub:focus-visible \{\n {2}outline: 2px solid var\(--focus\);/)
  })

  test('switching the view asks for nothing and is remembered in localStorage, and a viewer without it still switches', async () => {
    const { useFlowView } = await import('../src/renderer/src/Flow.tsx')
    // Home's effects read the span, the data change and the open row, never the view: switching it calls no handler.
    const home = source('src/renderer/src/pages/Home.tsx')
    const deps = [...home.matchAll(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[([^\]]*)\]\)/g)].map((m) => m[1])
    assert.ok(deps.length >= 5, deps.join(' | '))
    for (const d of deps) assert.doesNotMatch(d, /\b(view|shownView)\b/, d)
    assert.doesNotMatch(source('src/renderer/src/Flow.tsx'), /\bapi\b/)
    const store = new Map<string, string>()
    let throwing = false
    const was = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        if (throwing) throw new Error('blocked')
        return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)) }
      }
    })
    try {
      let pick: (v: 'rows' | 'walk' | 'sankey') => void = () => {}
      let show: (v: 'rows' | 'walk' | 'sankey') => void = () => {}
      let picked = false
      // As Home asks: the Sankey with none picked, and no row open on arrival.
      const seen = (): string => {
        let v = ''
        const Probe = (): null => {
          ;[v, pick, show, picked] = useFlowView(view.HOME_VIEWS, view.HOME_VIEW_KEY, () => view.arrivalView(undefined))
          return null
        }
        renderToStaticMarkup(createElement(Probe))
        return v
      }
      assert.equal(seen(), 'sankey')
      assert.equal(picked, false)
      // Shown for now only (a row asked for): nothing is kept, and the next open is the Sankey again.
      show('rows')
      assert.equal(store.has(view.HOME_VIEW_KEY), false)
      assert.equal(seen(), 'sankey')
      pick('walk')
      assert.equal(store.get(view.HOME_VIEW_KEY), 'walk')
      assert.equal(seen(), 'walk')
      assert.equal(picked, true)
      // A view picked here wins, the rows too.
      store.set(view.HOME_VIEW_KEY, 'rows')
      assert.equal(seen(), 'rows')
      store.set(view.HOME_VIEW_KEY, 'sankey')
      assert.equal(seen(), 'sankey')
      // A view no longer offered counts as none picked.
      store.set(view.HOME_VIEW_KEY, 'pie')
      assert.equal(seen(), 'sankey')
      assert.equal(picked, false)
      // With localStorage blocked (a private window, cleared site data), Home opens on its Sankey and picking still works.
      throwing = true
      assert.equal(seen(), 'sankey')
      assert.doesNotThrow(() => pick('rows'))
      // A page that gives no fallback opens on its first view, as before.
      throwing = false
      store.clear()
      let plain = ''
      const Plain = (): null => {
        ;[plain] = useFlowView(view.HOME_VIEWS, view.HOME_VIEW_KEY)
        return null
      }
      renderToStaticMarkup(createElement(Plain))
      assert.equal(plain, 'rows')
    } finally {
      if (was) Object.defineProperty(globalThis, 'localStorage', was)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})

describe('the Walk and the Sankey on a large ledger', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('over All of 95 months they tie to the rows, and switching to either takes under 1 ms from the waterfall Home has', async (t) => {
    db.openDb(':memory:')
    const ledger = largeLedger({ from: '2018-12', invested: true })
    const all = getWaterfall(view.presetSpan('All', db.today(), ledger.first)!)
    ties(all, 'large All')
    for (const s of [view.presetSpan('12M', db.today(), null)!, view.presetSpan('30D', db.today(), null)!, { from: ledger.last, to: ledger.last }]) ties(getWaterfall(s), `large ${s.from}..${s.to}`)
    // npm test runs the files at once: the budget is timed against test/cost.ts's reference in paired rounds, and holds
    // as the median of the rounds' ratios. The spec sets none for drawing the views; 1 ms keeps a switch instant.
    const r = await paired(6, () =>
      repeatedMs(() => {
        view.walkSteps(all)
        view.sankeyFlow(all)
      })
    )
    t.diagnostic(within('the Walk and the Sankey from the waterfall', 1, r))
    assert.ok(r.ratio <= budgetRatio(1), within('the Walk and the Sankey from the waterfall', 1, r))
    // Laying the Sankey out (its sweeps and relaxation passes over a dozen nodes, whatever the ledger's size) and
    // closing a hub redraw it: 5 ms, a third of a frame.
    const f = view.sankeyFlow(all)
    const open = new Set(charts.opensWith(f))
    const drawn = await paired(6, () =>
      repeatedMs(() => {
        charts.drawSankey(f, open, BOX_900)
        charts.drawSankey(f, charts.toggled(f, open, 'pool:Left over'), BOX_900)
      })
    )
    t.diagnostic(within('the Sankey drawn twice', 5, drawn))
    assert.ok(drawn.ratio <= budgetRatio(5), within('the Sankey drawn twice', 5, drawn))
  })
})
