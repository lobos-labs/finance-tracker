import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from '../src/main/db.ts'
import { getBudget } from '../src/main/budget.ts'
import { getDebts } from '../src/main/debts.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { buildDigest } from '../src/main/insights.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, ledgerLines } from '../src/main/lines.ts'
import { setHiddenVendors } from '../src/main/privacy.ts'
import { getRangeSummary, getSummary, SPENDING, TAKE_HOME } from '../src/main/summary.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { getWaterfall } from '../src/main/waterfall.ts'
import { addDays, daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { ClassifiedLine, MonthSummary, StageId, Waterfall } from '../src/shared/types.ts'
import { bayview } from './fixtures/bayview.ts'
import { outback } from './fixtures/outback.ts'
import { largeLedger } from './fixtures/large-ledger.ts'
import { noonOn } from './days.ts'

// Every Personal total reads the classifier (waterfall spec, sub-phase 2g): the Dashboard's summary and Review's
// month_summary, spending_summary, the headline, the budget and spending model, the large-purchase scan and
// search_transactions' Personal filter. So Review's answers and the waterfall's rows agree to the cent: spending is
// Committed, Everyday and One-offs, income is Take-home, and uncategorized money is Unsorted. A venture's own view
// keeps its books' cash in and out by category in SQL; Personal's money is in no SQL total but the transactions list.

configureLicense({ dev: true })

const root = fileURLToPath(new URL('..', import.meta.url))
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const actual = (w: Waterfall, id: StageId): number => w.rows.find((r) => r.id === id)?.actualCents ?? 0
const cents = (dollars: number): number => Math.round(dollars * 100)

/** The months from one YYYY-MM to another, inclusive. */
function months(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m)
  return out
}

/** Every .ts and .tsx file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

describe("Personal's money in SQL", () => {
  test('nothing outside db.ts and lines.ts names the SQL that totalled Personal, and in db.ts only the transactions list reads Personal by it', () => {
    const named = /\b(bucketClause|personalClause|VISIBLE_FROM|SPEND_EXPR|INCOME_EXPR)\b/
    const outside = sources(join(root, 'src'))
      .map((p) => relative(root, p).replaceAll('\\', '/'))
      .filter((p) => p !== 'src/main/db.ts' && p !== 'src/main/lines.ts')
      .filter((p) => named.test(readFileSync(join(root, p), 'utf8')))
    assert.deepEqual(outside, [])
    // The Transactions page's Personal filter is money in no venture (with the legacy residence clause), until its
    // owner filters (sub-phase 2b) read the classifier too.
    const text = readFileSync(join(root, 'src/main/db.ts'), 'utf8')
    const list = text.indexOf('export function listTransactions(')
    const end = text.indexOf('\nexport ', list + 1)
    const calls = [...text.matchAll(/personalClause\(\)/g)].map((m) => m.index)
    assert.ok(calls.length > 0 && calls.every((i) => i > list && i < end), 'personalClause() outside listTransactions')
  })

  test("the summaries' Personal path never reaches bucketClause, which only names ventures", () => {
    assert.equal('getSummary' in db, false)
    assert.equal('getRangeSummary' in db, false)
    for (const sel of [[], [0], [0, -1, 1.5]]) assert.throws(() => db.bucketClause(sel), /Name a venture/)
    assert.throws(() => db.bucketSummary([0], 0, 1, null, []), /Name a venture/)
    assert.throws(() => db.bucketLines([0], 0, 1), /Name a venture/)
    assert.throws(() => db.bucketSpending([0], 0, 1, 'category'), /Name a venture/)
    assert.equal(db.bucketClause([0, 3, 7]), '(t.bucket_id IN (3,7))')
  })
})

describe("Review's totals and the waterfall's rows on the sample household", () => {
  let first = ''
  let current = ''
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
    first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    current = db.today().slice(0, 7)
  })
  after(db.closeDb)

  test("every month: spending_summary's and month_summary's Personal totals are the waterfall's rows", () => {
    let spent = 0
    for (const m of months(first, current)) {
      const w = getWaterfall({ from: m, to: m })
      const s = runTool('month_summary', { month: m }).result as MonthSummary & { levers: Array<{ stage: string; kind: string; name: string; monthly: number }> }
      const rows = { spend: actual(w, 'committed') + actual(w, 'everyday') + actual(w, 'oneOffs'), income: actual(w, 'takeHome'), unsorted: w.unsorted.cents }
      assert.deepEqual({ spend: s.spendCents, income: s.incomeCents, unsorted: s.unsortedCents }, rows, m)
      // And the classifier's own lines, read afresh for the month alone, say the same.
      const fresh = classifyLines(`${m}-01`, lastDay(m)).filter((l) => l.owner === null)
      const sum = (pick: (l: ClassifiedLine) => boolean): number => fresh.filter(pick).reduce((t, l) => t + l.cents, 0)
      assert.deepEqual({ spend: -sum((l) => SPENDING.has(l.cls)), income: sum((l) => TAKE_HOME.has(l.cls)), unsorted: sum((l) => l.cls === 'unsorted') }, rows, m)
      // The levers are the waterfall's, in its order, in dollars.
      const levers = w.levers.map((l) => [l.stage, l.kind, l.name, l.monthlyCents / 100])
      assert.deepEqual(
        s.levers.map((l) => [l.stage, l.kind, l.name, l.monthly]),
        levers,
        m
      )
      // spending_summary over the month's days, by month and by category, comes to the same totals.
      const span = { from: `${m}-01`, to: `${shiftMonth(m, 1)}-01` }
      const byMonth = runTool('spending_summary', { ...span, group_by: 'month' }).result as { groups: Array<{ month: string; spending: number; income: number; unsorted?: number }>; levers: Array<{ stage: string; kind: string; name: string; monthly: number }> }
      assert.deepEqual(
        byMonth.groups.map((g) => [g.month, cents(g.spending), cents(g.income), cents(g.unsorted ?? 0)]),
        rows.spend || rows.income || rows.unsorted ? [[m, rows.spend, rows.income, rows.unsorted]] : [],
        m
      )
      assert.deepEqual(
        byMonth.levers.map((l) => [l.stage, l.kind, l.name, l.monthly]),
        levers,
        m
      )
      const byCategory = (runTool('spending_summary', { ...span, group_by: 'category' }).result as { groups: Array<{ spending: number; income: number }> }).groups
      assert.deepEqual([cents(byCategory.reduce((t, g) => t + g.spending, 0)), cents(byCategory.reduce((t, g) => t + g.income, 0))], [rows.spend, rows.income], m)
      spent += rows.spend
    }
    assert.ok(spent > 0)
  })

  test('the Dashboard summary over a span of months is its months added up, and its trend is each month', () => {
    const from = shiftMonth(current, -5)
    const span = getRangeSummary(from, current, [0])
    const each = months(from, current).map((m) => getSummary(m))
    assert.equal(span.spendCents, each.reduce((t, s) => t + s.spendCents, 0))
    assert.equal(span.incomeCents, each.reduce((t, s) => t + s.incomeCents, 0))
    assert.equal(span.unsortedCents, each.reduce((t, s) => t + (s.unsortedCents ?? 0), 0))
    assert.deepEqual(
      span.trend.map((p) => [p.month, p.spendCents, p.incomeCents]),
      each.map((s) => [s.month, s.spendCents, s.incomeCents])
    )
  })

  test('a span read from lines kept for its month is the span classified afresh, line for line', () => {
    // The open month's waterfall reads two years through the month's end; the spans below are inside it.
    getWaterfall({ from: current, to: current })
    const prev = shiftMonth(current, -1)
    const spans: Array<[string, string]> = [
      [`${prev}-15`, `${prev}-20`],
      [`${shiftMonth(current, -3)}-03`, `${prev}-28`],
      [addDays(db.today(), -29), db.today()],
      [`${current}-01`, db.today()]
    ]
    for (const [from, to] of spans) {
      const fresh = classifyLines(from, to)
      const keys = Object.keys(fresh[0]) as Array<keyof ClassifiedLine>
      const kept = ledgerLines(from, to).map((l) => Object.fromEntries(keys.map((k) => [k, l[k]])))
      assert.ok(fresh.length > 0, `${from} ${to}`)
      assert.deepEqual(kept, fresh, `${from} to ${to}`)
    }
  })

  test('a change to the books is in the next total', () => {
    const prev = shiftMonth(current, -1)
    const before = getSummary(prev)
    const line = ledgerLines(`${prev}-01`, lastDay(prev)).find((l) => l.owner === null && l.cls === 'everyday' && l.category === 'Groceries' && l.splitId === null && l.cents < 0)!
    // Uncategorized, the purchase leaves spending for Unsorted.
    db.setTransactionFields(line.txnId, { categoryId: null, source: 'user' })
    try {
      const after = getSummary(prev)
      assert.equal(after.spendCents, before.spendCents + line.cents)
      assert.equal(after.unsortedCents, (before.unsortedCents ?? 0) + line.cents)
    } finally {
      db.setTransactionFields(line.txnId, { categoryId: line.categoryId, source: 'user' })
    }
    assert.equal(getSummary(prev).spendCents, before.spendCents)
  })

  test("a loan's interest paid by a transfer is spending under the loan, as the waterfall names it, never under a transfer category", () => {
    const transfers = new Set(db.listCategories().filter((c) => c.kind === 'transfer').map((c) => c.name))
    const prev = shiftMonth(current, -1)
    // The sample car loan is paid from checking as a transfer: its interest is a Committed part named for the loan.
    const loan = getWaterfall({ from: prev, to: prev }).rows.find((r) => r.id === 'committed')!.parts.find((p) => p.key === 'loan:demo:car-loan')!
    assert.ok(loan.actualCents > 0)
    const s = getSummary(prev)
    assert.deepEqual(s.byCategory.filter((c) => transfers.has(c.name)), [])
    assert.equal(s.byCategory.find((c) => c.name === loan.name)?.cents, loan.actualCents)
    const groups = (runTool('spending_summary', { from: `${prev}-01`, to: `${current}-01`, group_by: 'category' }).result as { groups: Array<{ category: string; spending: number }> }).groups
    assert.deepEqual(groups.filter((g) => transfers.has(g.category)), [])
    assert.equal(cents(groups.find((g) => g.category === loan.name)!.spending), loan.actualCents)
    // The headline's digest names it the same way, this month and in the months it averages.
    const digest = buildDigest()!
    assert.ok(digest.largestThisMonth.some((p) => p.category === loan.name))
    for (const t of [digest.monthToDate, digest.typicalFullMonth!]) {
      assert.deepEqual(Object.keys(t.byCategory).filter((n) => transfers.has(n)), [])
      assert.ok(t.byCategory[loan.name] > 0)
    }
    assert.deepEqual(digest.largestThisMonth.filter((p) => transfers.has(p.category)), [])
  })

  test('month_summary refuses a month that is no month, as the summary does', () => {
    for (const month of ['2026-13', 'soon', '']) assert.throws(() => runTool('month_summary', { month }), /Invalid month/)
  })

  test("a lever named for a hidden vendor isn't in month_summary or spending_summary, while the waterfall keeps it", () => {
    const prev = shiftMonth(current, -1)
    const lever = getWaterfall({ from: prev, to: prev }).levers.find((l) => l.kind === 'price_change')!
    assert.ok(lever, 'no price_change lever')
    const names = (r: unknown): string[] => (r as { levers: Array<{ name: string }> }).levers.map((l) => l.name)
    const span = { from: `${prev}-01`, to: `${current}-01`, group_by: 'month' }
    assert.ok(names(runTool('month_summary', { month: prev }).result).includes(lever.name))
    setHiddenVendors([lever.name])
    try {
      assert.equal(names(runTool('month_summary', { month: prev }).result).includes(lever.name), false)
      assert.equal(names(runTool('spending_summary', span).result).includes(lever.name), false)
      assert.ok(getWaterfall({ from: prev, to: prev }).levers.some((l) => l.name === lever.name))
    } finally {
      setHiddenVendors([])
    }
    assert.ok(names(runTool('spending_summary', span).result).includes(lever.name))
  })
})

describe('a house Personal lives in with rooms rented (220 Bayview, section 3)', () => {
  afterEach(db.closeDb)
  const oct = '2025-10'
  const span = { from: '2025-10-01', to: '2025-11-01' }

  test("Personal's totals are its use share; with the rooms beside it, each shared cost counts once, whole", () => {
    const h = bayview()
    // Personal's 34%: the payment's 408.00 of interest and escrow (its 800.00 of principal is no spending), and 130.90
    // of the dues and 98.60 of the utilities. The rooms' rent is theirs.
    const personal = getSummary(oct)
    assert.deepEqual([personal.spendCents, personal.incomeCents], [40_800 + 13_090 + 9_860, 0])
    assert.deepEqual(
      personal.byCategory.map((c) => [c.name, c.cents]),
      [
        ['Housing', 40_800 + 13_090],
        ['Utilities', 9_860]
      ]
    )
    // The rooms alone are their books: the lines placed in them, by category.
    const rooms = getSummary(oct, [h.rooms])
    assert.deepEqual([rooms.spendCents, rooms.incomeCents], [0, 240_000])
    // Together, the rooms' 66% of each cost is beside Personal's 34%: 1,200.00 + 385.00 + 290.00, and the rent.
    const both = getSummary(oct, [0, h.rooms])
    assert.deepEqual([both.spendCents, both.incomeCents], [120_000 + 38_500 + 29_000, 240_000])
    const everyone = runTool('spending_summary', { ...span, group_by: 'bucket', bucket: 'all' }).result as { groups: Array<{ bucket: string; spending: number; income: number }> }
    assert.deepEqual(
      everyone.groups.map((g) => [g.bucket, cents(g.spending), cents(g.income)]),
      [
        ['Bayview Rooms', 79_200 + 25_410 + 19_140, 240_000],
        ['Personal', 40_800 + 13_090 + 9_860, 0]
      ]
    )
    const mine = runTool('spending_summary', { ...span, group_by: 'category' }).result as { groups: Array<{ category: string; spending: number }> }
    assert.deepEqual(
      mine.groups.map((g) => [g.category, cents(g.spending)]),
      [
        ['Housing', 40_800 + 13_090],
        ['Utilities', 9_860]
      ]
    )
  })

  test("search_transactions' Personal is every transaction Personal has a part of, by the owner rule and the uses", () => {
    const h = bayview()
    // The dues go to the rooms by a venture rule; Personal's use share of the house still makes them partly Personal's.
    runTool('add_bucket_rule', { bucket: 'Bayview Rooms', contains: 'bayview ct hoa' }, 'assistant')
    const ids = (input: Record<string, unknown>): string[] => (runTool('search_transactions', { ...input, from: span.from, to: '2025-10-31' }).result as Array<{ id: string }>).map((r) => r.id)
    assert.deepEqual(ids({ bucket: 'Personal' }), [h.payment, h.utilities, h.hoa])
    assert.deepEqual(ids({ bucket: 'Personal', category: 'Housing' }), [h.payment, h.hoa])
    assert.deepEqual(ids({ bucket: 'Bayview Rooms' }), [h.hoa, h.rent])
    // The transactions list's Personal filter is money in no venture.
    assert.deepEqual(
      db.listTransactions({ bucketId: 'personal', from: db.dayStart(span.from), to: db.dayStart(span.to) }).rows.map((t) => t.id),
      [h.payment, h.utilities]
    )
  })
})

describe("the debt plan's months beside a car a business uses part of (the Outback, section 3)", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 }))
  afterEach(db.closeDb)
  after(() => mock.timers.reset())

  test("a loan's payment filed as spending stays out of the months when a use shares it, as the plan pays it as a minimum", () => {
    const c = outback()
    // Filed as Transportation, the 412.00 payment is spending; Rideshare's 35% of its interest leaves Personal 381.44.
    const transportation = db.listCategories().find((x) => x.name === 'Transportation')!.id
    db.setTransactionFields(c.payment, { categoryId: transportation, source: 'user' })
    db.updateAccount(c.loan, { minPaymentCents: 41_200 })
    const debts = getDebts()
    assert.deepEqual(
      debts.debts.filter((d) => d.kind === 'loan').map((d) => [d.name, d.minPaymentCents]),
      [['Summit Auto Loan', 41_200]]
    )
    // October's spending is Personal's 29.90 of the gas and 76.70 of the insurance, without the loan's payment.
    assert.equal(debts.spendMonths.find((m) => m.month === '2026-10')?.cents, 2_990 + 7_670)
  })
})

describe("the cost of Personal's totals", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("after a change to the books, the open month's totals read the classifier once between them", () => {
    db.openDb(':memory:')
    const ledger = largeLedger()
    assert.ok(ledger.transactions > 15_000)
    const open = db.today().slice(0, 7)
    let n = 0
    const touch = (): void => db.setSetting('test.touch', String(n++))
    const cpu = (f: () => void): number => {
      const was = process.cpuUsage()
      f()
      const d = process.cpuUsage(was)
      return (d.user + d.system) / 1000
    }
    // What Home, the Dashboard and Review read for the open month: the waterfall, the month's summary and the last
    // 30 days', the budget, the headline, month_summary, spending_summary and the issues (the large-purchase scan).
    const waterfall = (): void => void getWaterfall({ from: open, to: open })
    const everything = (): void => {
      waterfall()
      getRangeSummary(open, open, [0])
      getRangeSummary(addDays(db.today(), -29), db.today(), [0])
      getBudget(open)
      buildDigest()
      runTool('month_summary', { month: open })
      runTool('spending_summary', { from: `${open}-01`, to: addDays(db.today(), 1), group_by: 'category' })
      openIssues()
    }
    everything()
    // Each round times the waterfall alone and everything, each after a change, back to back in alternating order,
    // and the ratio is the median of the rounds' own ratios, so the load npm test puts on the machine slows both
    // sides of a round alike. Reading the classifier once between them, everything costs about 1.6 times the
    // waterfall alone; with each total classifying the days on its own, about 3 times.
    const ratios: number[] = []
    const seen: string[] = []
    for (let k = 0; k < 5; k++) {
      const order = k % 2 ? [everything, waterfall] : [waterfall, everything]
      const ms = new Map<() => void, number>()
      for (const f of order) {
        touch()
        ms.set(f, cpu(f))
      }
      ratios.push(ms.get(everything)! / ms.get(waterfall)!)
      seen.push(`${Math.round(ms.get(waterfall)!)}/${Math.round(ms.get(everything)!)} ms`)
    }
    const median = [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)]
    assert.ok(median <= 2.5, `everything over the waterfall alone: ${median.toFixed(2)} (${seen.join(', ')})`)
  })
})
