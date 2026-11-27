import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ClosedRow } from '../src/main/db.ts'
import type { HandlerContext } from '../src/main/handlers/context.ts'
import type { ClosedLine, Opened } from '../src/renderer/src/pages/homeView.ts'
import type { ChangedMonth, LineClass, MonthSnapshot, PayBasis, StageId, Waterfall } from '../src/shared/types.ts'
import { budgetRatio, busyOf, paired, repeatedMs, within } from './cost.ts'
import { noonOn } from './days.ts'

// Change detection (waterfall spec 2, Silent rewrites; sub-phase 1i): a closed month whose figures move after it
// closed shows as changed, with what moved and why, in one month_changed issue that groups the months by what changed
// them, until Review keeps the new figures or the change is undone; three narrow changes re-close a month by
// themselves. Section 2's tie-out, section 5's household and two small checking-account books are the ledgers.

// The handlers' modules import Electron: the demo dump's stand-in takes its place, so a page's edit runs as it does.
const stand = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stand, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})

const db = await import('../src/main/db.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { undo } = await import('../src/main/journal.ts')
const { ENGINE_VERSION } = await import('../src/main/lines.ts')
const { answer } = await import('../src/main/handlers/table.ts')
const { savePaystub } = await import('../src/main/paystubs.ts')
const snapshots = await import('../src/main/snapshots.ts')
const { openIssues, runTool } = await import('../src/main/tools.ts')
const { closedFigures, getWaterfall, monthClose } = await import('../src/main/waterfall.ts')
const { shiftMonth, daysInMonth } = await import('../src/shared/zone.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
const tie = await import('./fixtures/tieout.ts')
const hh = await import('./fixtures/waterfall-household.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')
const { checkClosed, closeDueMonths, changedMonths, diffSnapshot, listSnapshots, rawDigest, balancesDigest, linesDigest, rowsDigest } = snapshots

configureLicense({ dev: true })

const nov = (day: number): number => noonOn(2026, 11, day)
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const latest = (month: string): MonthSnapshot | undefined => listSnapshots(1000).find((s) => s.month === month)
const cat = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const issuesOf = (kind: string): ReturnType<typeof openIssues> => openIssues().filter((i) => i.kind === kind)
const batches = (): string[] => [...new Set(changedMonths().map((c) => c.batch))]
const months = (list: ChangedMonth[] | Array<{ month: string }>): string[] => list.map((c) => c.month).sort()
const runRate = (w: Waterfall, id: StageId): number | null => w.rows.find((r) => r.id === id)!.runRateCents
/** That every closed month is its latest close's, or shows as changed: the acceptance check. */
function noSilentChange(where: string): void {
  for (const s of listSnapshots(1000).filter((x, i, all) => all.findIndex((y) => y.month === x.month) === i)) {
    if (s.status === 'changed') continue
    const c = monthClose(s.month)
    assert.deepEqual([linesDigest(c.lines), balancesDigest(c.balances), rowsDigest(c.waterfall)], [s.digests.lines, s.digests.balances, s.digests.rows], `${where}: ${s.month} moved without showing`)
  }
}

/** Money out of the row above, which Home shows negative. */
const COSTS = new Set<StageId>(['taxes', 'benefits', 'savedAtWork', 'committed', 'everyday', 'oneOffs'])
const CLOSED_FIELD = { actual: 'actualCents', runRate: 'runRateCents', rate: 'rate', change: 'changeCents', pts: 'rateChangePts', basis: 'basis' } as const
type Kept = { id: StageId; actualCents: number; runRateCents: number | null; changeCents: number | null; rate: number | null; rateChangePts?: number | null; basis?: PayBasis | null; parts?: Kept[]; key?: string }

/** The classes of the lines that go into each row, and into each term of the cash identity; a venture's lines go into Ventures. */
const LINES_OF: Record<string, string[]> = {
  'row:takeHome': ['pay'],
  'row:gross': ['income'],
  'row:taxes': ['tax'],
  'row:committed': ['committed', 'debtCost'],
  'row:everyday': ['everyday'],
  'row:oneOffs': ['oneOff', 'oneOffIncome'],
  'term:venturesCents': ['venture'],
  'term:cashReturnCents': ['cashReturn'],
  'term:unsortedCents': ['unsorted'],
  'term:debtPaidCents': ['principal'],
  'term:toInvestmentsCents': ['invested'],
  'term:boughtCents': ['capital'],
  'term:inTransitCents': ['internal'],
  'term:unexplainedCents': ['orphan']
}

/**
 * That every changed month shows on Home what moved since its close (spec 2, On Home): at least one closed line in
 * Home's default view, and every closed line in any of Home's views the close's figure beside today's, the close's
 * as its rows, identity, bridge and lines were frozen and today's as closing the month again would freeze them; and
 * Home's figures are the month's snapshotDiff's.
 */
function showsWhatMoved(where: string): void {
  for (const s of listSnapshots(1000).filter((x, i, all) => all.findIndex((y) => y.month === x.month) === i && x.status === 'changed')) {
    const at = `${where}: ${s.month}`
    const w = getWaterfall({ from: s.month, to: s.month })
    const close = monthClose(s.month)
    const now = close.waterfall
    const kept = db.get<{ rows: string; identity: string; bridge: string }>('SELECT "rows", identity, bridge FROM month_snapshots WHERE month = ? AND version = ?', s.month, s.version)!
    const keptLines = db.all<{ key: string; cls: LineClass; cents: number; owner: number | null }>('SELECT line_key AS key, class AS cls, cents, owner FROM snapshot_lines WHERE month = ? AND version = ?', s.month, s.version)
    const frozen = { rows: (JSON.parse(kept.rows) as { rows: Kept[] }).rows, identity: JSON.parse(kept.identity) as Record<string, number>, bridge: JSON.parse(kept.bridge) as Waterfall['bridge'], lines: keptLines }
    // snapshotDiff's figures, the close's beside closing the month again, as diffSnapshot reads them.
    assert.deepEqual(w.closed, closedFigures(frozen, { ...now, lines: close.lines }), at)
    assert.deepEqual(w.closed, (({ month, version, lines, inputs, autoReclose, ...figures }) => figures)(diffSnapshot(s.month)!), at)
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    const views = (open: Opened, drill = {}): ClosedLine[] => view.homeTable(w, open, names, drill).lines.filter((l): l is ClosedLine => l.kind === 'closed')
    const shown = views(null)
    assert.ok(shown.length > 0, `${at} shows no closed line, its rows ${rowsDigest(now) === s.digests.rows ? 'as closed' : 'moved'} and its lines ${linesDigest(close.lines) === s.digests.lines ? 'as closed' : 'moved'}`)
    const all = [...shown, ...view.MAIN_ROWS.flatMap((open) => views(open)), ...view.GROUP_ORDER.flatMap((group) => views('elective', { group }))]
    // A row or part one side hasn't was nothing there: 0, no Δ pts, a rate of 0 where the other has one, the other's basis.
    const nothing = (other: Kept): Kept => ({ id: other.id, actualCents: 0, runRateCents: 0, changeCents: other.changeCents === null ? null : 0, rate: other.rate === null ? null : 0, rateChangePts: null, basis: other.basis ?? null, parts: [] })
    const sides = (row: StageId, part: string | null): [Kept, Kept] => {
      const find = (rows: Kept[]): Kept | undefined => {
        const r = rows.find((x) => x.id === row) ?? (row === 'gross' ? rows.find((x) => x.id === 'takeHome') : undefined)
        return part === null ? r : (r?.parts ?? []).find((x) => x.key === part)
      }
      const [a, b] = [find(frozen.rows), find(now.rows as Kept[])]
      return [a ?? nothing(b!), b ?? nothing(a!)]
    }
    // Whole dollars, or dollars and cents where the whole dollars don't move by what the figure did; a figure one side
    // lacks is a dash.
    const amounts = (a: number | null | undefined, b: number | null | undefined): [string, string] => {
      if (a === null || a === undefined || b === null || b === undefined) return [a === null || a === undefined ? '—' : view.dollars(a), b === null || b === undefined ? '—' : view.dollars(b)]
      const [x, y] = [Math.sign(a) * Math.round(Math.abs(a) / 100), Math.sign(b) * Math.round(Math.abs(b) / 100)]
      const d = a - b
      return x !== y && Math.sign(d) * Math.round(Math.abs(d) / 100) === x - y ? [view.dollars(a), view.dollars(b)] : [view.money(a), view.money(b)]
    }
    const text = (figure: keyof typeof CLOSED_FIELD, row: StageId, is: number | string | null | undefined, was: number | string | null | undefined): [string, string] => {
      const one = (v: number | string | null | undefined): string => (v === null || v === undefined ? '—' : figure === 'rate' ? view.pct(v as number) : figure === 'pts' ? view.pts(v as number) : String(v))
      if (figure === 'rate' || figure === 'pts' || figure === 'basis') return [one(is), one(was)]
      const sign = (v: number | string | null | undefined): number | null => (typeof v === 'number' ? (COSTS.has(row) ? -v : v) : null)
      return amounts(sign(is), sign(was))
    }
    for (const l of all) {
      const [, figure, ...path] = l.key.split(':')
      if (figure === 'lines') {
        // How many lines go into the row or term now and in the close, and that some came or went.
        const classes = new Set(LINES_OF[path.join(':')])
        const venture = path.join(':') === 'term:venturesCents'
        const count = (list: ReadonlyArray<{ cls: LineClass; owner: number | null }>): string => String(list.filter((x) => (x.owner === null ? classes.has(x.cls) : venture)).length)
        assert.deepEqual([l.now, l.closed], [count(close.lines), count(keptLines)], `${at}: ${l.name}`)
        assert.notEqual(l.change, '', `${at}: ${l.name} moved`)
        continue
      }
      let want: [string, string]
      if (figure === 'identity') want = amounts(now.identity[path[0] as keyof Waterfall['identity']], frozen.identity[path[0]])
      else if (figure === 'bridge') want = amounts(now.bridge[path[0] as 'startCents'], frozen.bridge[path[0] as 'startCents'])
      else if (figure === 'other') {
        const sum = (b: Waterfall['bridge']): number => b.other.filter((o) => o.kind === path[0] && o.accountId === path.slice(1).join(':')).reduce((t, o) => t + o.cents, 0)
        want = amounts(sum(now.bridge), sum(frozen.bridge))
      } else {
        const f = figure as keyof typeof CLOSED_FIELD
        const row = path[0] as StageId
        const [was, is] = sides(row, path.length > 1 ? path.slice(1).join(':') : null)
        want = text(f, row, is[CLOSED_FIELD[f]], was[CLOSED_FIELD[f]])
      }
      assert.deepEqual([l.now, l.closed], want, `${at}: ${l.name}`)
      assert.notEqual(l.now, l.closed, `${at}: ${l.name} moved`)
    }
  }
}

/** A page's call, as the window makes it: no journal entry. */
const page = (): HandlerContext =>
  ({
    platform: 'web',
    plan: { plan: 'plus' },
    broadcast: () => {},
    backup: async () => {},
    settings: () => ({})
  }) as unknown as HandlerContext
const onPage = async (method: string, ...args: unknown[]): Promise<unknown> => {
  const r = (await answer(method, args, page())) as { ok: boolean; data?: unknown; error?: string }
  assert.ok(r.ok, r.error)
  return r.data
}

/**
 * Small books on one checking account, May to October 2026 with November open: pay of 3,000.00 on the 1st, rent of
 * 1,200.00 on the 2nd and groceries of 400.00 on the 10th each month, `extra` lines among them, and a statement at
 * each month's end and on Nov 3, so no month has a gap.
 */
function books(extra: Array<[string, number, string, string]> = []): void {
  db.openDb(':memory:')
  db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.updateAccount('csv:chk', { assetType: 'cash' })
  const list: Array<[string, number, string, string]> = []
  for (let m = '2026-05'; m <= '2026-10'; m = shiftMonth(m, 1)) {
    list.push([`${m}-01`, 300_000, 'Gale Payroll', 'Paycheck'], [`${m}-02`, -120_000, 'Birchwood Apartments', 'Housing'], [`${m}-10`, -40_000, 'Freshway Market', 'Groceries'])
  }
  list.push(...extra)
  let n = 0
  const sums = new Map<string, number>()
  db.inTransaction(() => {
    for (const [day, cents, payee, category] of list) {
      const [y, mo, d] = day.split('-').map(Number)
      const id = `bk${++n}`
      db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, mo, d), amountCents: cents, description: payee.toUpperCase(), pending: false })
      db.setTransactionFields(id, { categoryId: cat(category), source: 'user', merchant: payee })
      const key = day <= '2026-10-31' ? day.slice(0, 7) : 'after'
      sums.set(key, (sums.get(key) ?? 0) + cents)
    }
  })
  let balance = 500_000
  db.setBalancePoint('csv:chk', '2026-04-30', balance)
  for (let m = '2026-05'; m <= '2026-10'; m = shiftMonth(m, 1)) {
    balance += sums.get(m) ?? 0
    db.setBalancePoint('csv:chk', lastDay(m), balance)
  }
  db.setBalancePoint('csv:chk', '2026-11-03', balance + (sums.get('after') ?? 0))
}

/** A line on the small books' checking account, as a sync or an import brings it. */
function bookLine(id: string, day: string, cents: number, payee: string, category: string): void {
  const [y, m, d] = day.split('-').map(Number)
  db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description: payee.toUpperCase(), pending: false })
  db.setTransactionFields(id, { categoryId: cat(category), source: 'user', merchant: payee })
}

describe('changes that re-close a month by themselves', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("the tie-out's late 40.00 line fills its gap, and October re-closes automatically with status closed and no issue", async () => {
    tie.tieOut()
    await closeDueMonths(nov(7))
    assert.deepEqual([latest('2026-10')!.status, latest('2026-10')!.unexplainedCents], ['gap', 4_000])
    assert.equal(issuesOf('month_gap').length, 1)
    // The missing purchase on Checking, the -40.00 its statement holds beyond the lines.
    tie.line(tie.ACCOUNTS.checking, '2026-10-29', -4_000, 'CORNER CAFE', 'Dining Out', 'Corner Cafe')
    const run = await checkClosed()
    assert.deepEqual(run.reclosed, [{ month: '2026-10', version: 2, status: 'closed', why: 'gapFill' }])
    assert.deepEqual([run.changed, changedMonths()], [[], []])
    const s = latest('2026-10')!
    assert.deepEqual([s.version, s.origin, s.status, s.unexplainedCents], [2, 'auto', 'closed', 0])
    assert.deepEqual([issuesOf('month_changed'), issuesOf('month_gap')], [[], []])
    noSilentChange('the late line')
  })

  test('categorizing an Unsorted line re-closes automatically, and so do the followers it moves', async () => {
    hh.household()
    // July's first coffee was left uncategorized when the books closed.
    const coffee = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description = 'DAILY GRIND CAFE' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2026-07'))!.id
    db.run('UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?', coffee)
    await closeDueMonths()
    await checkClosed()
    await onPage('updateTransaction', coffee, { categoryId: cat('Coffee') })
    const run = await checkClosed()
    // July itself, then August and September, whose Everyday run rates read July; October's window starts in August.
    assert.deepEqual(
      run.reclosed.map((r) => [r.month, r.version, r.why]),
      [
        ['2026-07', 2, 'unsortedCategorized'],
        ['2026-08', 2, 'follower'],
        ['2026-09', 2, 'follower']
      ]
    )
    assert.deepEqual([run.changed, issuesOf('month_changed')], [[], []])
    assert.equal(latest('2026-10')!.version, 1)
    noSilentChange('the categorized coffee')
  })

  test("an Unsorted line categorized in a month whose run rates an earlier change waiting for Review moves is changed with it, not re-closed by itself", async () => {
    hh.household()
    // August's first coffee was left uncategorized when the books closed.
    const find = (description: string, month: string): string => db.all<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE description LIKE ? ORDER BY posted', description).find((r) => db.dayKey(r.posted).startsWith(month))!.id
    const coffee = find('DAILY GRIND CAFE', '2026-08')
    db.run('UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?', coffee)
    await closeDueMonths()
    await checkClosed()
    // June's one-off filed as Groceries moves the run rates of June and every month after it; then the coffee.
    await onPage('updateTransaction', find('ONE-OFF GOODS%', '2026-06'), { categoryId: cat('Groceries') })
    await onPage('updateTransaction', coffee, { categoryId: cat('Coffee') })
    const run = await checkClosed()
    assert.deepEqual([months(run.changed), run.reclosed], [['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], []])
    assert.equal(batches().length, 1)
    assert.deepEqual(listSnapshots(1000).filter((s) => s.version > 1), [])
    noSilentChange('the June edit and the coffee')
    showsWhatMoved('the June edit and the coffee')
  })

  test("an Unsorted line categorized in a month an earlier change waiting for Review had already reached when it was last checked re-closes by itself", async () => {
    hh.household()
    const coffee = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description = 'DAILY GRIND CAFE' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2026-09'))!.id
    db.run('UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?', coffee)
    await closeDueMonths()
    await checkClosed()
    // June's brokerage statement 500.00 higher changes June and July, and no month after them.
    await onPage('setBalancePoint', hh.ACCOUNTS.brokerage, '2026-06-30', db.balancesOn([hh.ACCOUNTS.brokerage], '2026-06-30').get(hh.ACCOUNTS.brokerage)! + 50_000)
    assert.deepEqual(months((await checkClosed()).changed), ['2026-06', '2026-07'])
    await onPage('updateTransaction', coffee, { categoryId: cat('Coffee') })
    const run = await checkClosed()
    assert.deepEqual([run.changed, run.reclosed.map((r) => [r.month, r.why])], [[], [['2026-09', 'unsortedCategorized'], ['2026-10', 'follower']]])
    assert.deepEqual(months(changedMonths()), ['2026-06', '2026-07'])
    assert.deepEqual(diffSnapshot('2026-09')!.inputs, [])
    noSilentChange('the statement and the coffee')
    showsWhatMoved('the statement and the coffee')
  })

  test('a new balance that refines a loan split re-closes automatically', async () => {
    const h = hh.household()
    // The student loan's Sep 30 balance wasn't in when the books closed: its September and October payments shared
    // the drop from Aug 31 to Oct 31, 214.00 of principal each.
    db.deleteBalancePoint(h.studentLoan, '2026-09-30')
    await closeDueMonths()
    await checkClosed()
    const principal = (month: string): number => -monthClose(month).lines.filter((l) => l.debtId === h.studentLoan && l.cls === 'principal').reduce((s, l) => s + l.cents, 0)
    assert.deepEqual([principal('2026-09'), principal('2026-10')], [21_400, 21_400])
    // The statement says 24,020.00 on Sep 30: 194.00 of principal in September and 234.00 in October.
    db.setBalancePoint(h.studentLoan, '2026-09-30', -2_402_000)
    assert.deepEqual([principal('2026-09'), principal('2026-10')], [19_400, 23_400])
    const run = await checkClosed()
    assert.deepEqual(
      run.reclosed.map((r) => [r.month, r.why]),
      [
        ['2026-09', 'loanRefined'],
        ['2026-10', 'loanRefined']
      ]
    )
    assert.deepEqual([run.changed, issuesOf('month_changed')], [[], []])
    noSilentChange('the loan balance')
  })
})

describe('changes Review is asked about', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a recategorization on the Transactions page (updateTransaction, no journal) is found and has cause user', async () => {
    hh.household()
    await closeDueMonths()
    const bistro = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description = 'CORNER BISTRO' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2026-10'))!.id
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM changes')!.n
    await onPage('updateTransaction', bistro, { categoryId: cat('Groceries') })
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM changes')!.n, before, 'the page writes no journal entry')
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause]), [['2026-10', 'user']])
    const d = diffSnapshot('2026-10')!
    assert.deepEqual(d.lines, [{ key: `${bistro}::p`, change: 'restaged', fromCls: 'everyday', toCls: 'everyday', fromCents: -26_000, toCents: -26_000, cause: 'user' }])
    assert.equal(latest('2026-10')!.status, 'changed')
    noSilentChange('the page edit')
    showsWhatMoved('the page edit')
  })

  test("section 5's 48.00 September meal moved from Travel to Dining out marks September and October changed in one batch; October's Everyday run rate goes from 1,020.00 to 1,036.00 and its One-offs from 250.00 to 246.00", async () => {
    const h = hh.household()
    await closeDueMonths()
    const october = monthClose('2026-10')
    assert.deepEqual([runRate(october.waterfall, 'everyday'), runRate(october.waterfall, 'oneOffs')], [102_000, 25_000])
    await onPage('updateTransaction', h.meal, { categoryId: cat('Dining Out') })
    const run = await checkClosed()
    assert.deepEqual(months(run.changed), ['2026-09', '2026-10'])
    assert.equal(batches().length, 1)
    assert.deepEqual(changedMonths().map((c) => [c.month, c.cause]), [
      ['2026-10', 'user'],
      ['2026-09', 'user']
    ])
    // September's meal moved stage; October's lines didn't, but its run rates read September.
    const sep = diffSnapshot('2026-09')!
    assert.deepEqual(sep.lines.map((l) => [l.key, l.change, l.fromCls, l.toCls, l.cause]), [[`${h.meal}::p`, 'restaged', 'oneOff', 'everyday', 'user']])
    assert.deepEqual(sep.byStage.filter((s) => s.id === 'everyday').map((s) => [s.closedCents, s.nowCents]), [[105_200, 110_000]])
    const oct = diffSnapshot('2026-10')!
    assert.deepEqual([oct.lines, oct.inputs], [[], [{ kind: 'earlierMonth', ref: '2026-09', cause: 'user' }]])
    const stage = (id: StageId): [number | null, number | null] => {
      const s = oct.byStage.find((x) => x.id === id)!
      return [s.closedRunRateCents, s.nowRunRateCents]
    }
    assert.deepEqual([stage('everyday'), stage('oneOffs')], [
      [102_000, 103_600],
      [25_000, 24_600]
    ])
    // The Left over run rate is 534.50 and Kept 288.50 (534.50 - 246.00).
    assert.equal(stage('leftOver')[1], 53_450)
    assert.equal(linesDigest(monthClose('2026-10').lines), latest('2026-10')!.digests.lines)
    const [issue] = issuesOf('month_changed')
    assert.match(issue.summary, /^2 closed months have changed since they closed: Your edits restated 2 months \(2026-09, 2026-10\)\./)
    showsWhatMoved('the September meal')
  })

  test("on section 5's household, each of these raises one month_changed batch with no ledger line changed: record_paystub for a past check with a 401(k) of 250.00, a brokerage statement dated in a closed month, and an edit of the Visa's APR on the Accounts page", async () => {
    const cases: Array<[string, () => Promise<unknown> | unknown, string[], ChangedMonth['cause']]> = [
      [
        'record_paystub',
        () =>
          runTool(
            'record_paystub',
            {
              paycheck_key: hh.KEY,
              pay_day: '2026-08-15',
              gross: 3000,
              items: [
                { kind: 'federal', amount: 348 },
                { kind: 'social_security', amount: 186 },
                { kind: 'medicare', amount: 43.5 },
                { kind: 'state', amount: 138 },
                { kind: 'medical', name: 'Medical', amount: 96, employer: 205 },
                { kind: '401k', name: 'Brightline 401(k)', amount: 250, employer: 120 },
                { kind: 'hsa', name: 'Brightline HSA', amount: 60, employer: 24 }
              ],
              net: 1878.5
            },
            'assistant'
          ),
        // August's check reads its own stub; August, September and October's run-rate windows hold it.
        ['2026-08', '2026-09', '2026-10'],
        'ai'
      ],
      [
        'a brokerage statement',
        // June's statement 500.00 higher: June's return is 500.00 more and July's 500.00 less, and July's Growth starts from it.
        () => onPage('setBalancePoint', hh.ACCOUNTS.brokerage, '2026-06-30', db.balancesOn([hh.ACCOUNTS.brokerage], '2026-06-30').get(hh.ACCOUNTS.brokerage)! + 50_000),
        ['2026-06', '2026-07'],
        'user'
      ],
      [
        "the Visa's APR",
        // The Visa charges interest every month: every month's Committed run rate reads its rate.
        () => onPage('updateAccount', hh.ACCOUNTS.visa, { apr: 26 }),
        hh.MONTHS,
        'user'
      ]
    ]
    for (const [name, write, want, cause] of cases) {
      mock.timers.setTime(nov(7) * 1000)
      hh.household()
      await closeDueMonths()
      await checkClosed()
      await write()
      const run = await checkClosed()
      assert.deepEqual(months(run.changed), [...want].sort(), name)
      assert.equal(batches().length, 1, name)
      assert.deepEqual([...new Set(changedMonths().map((c) => c.cause))], [cause], name)
      for (const m of want) assert.deepEqual(diffSnapshot(m)!.lines, [], `${name}: ${m}'s lines`)
      assert.equal(issuesOf('month_changed').length, 1, name)
      noSilentChange(name)
      showsWhatMoved(name)
      db.closeDb()
    }
  })

  test("set_contribution changing the 401(k) election moves no closed month where every check has its own paystub, and raises one batch where checks are estimated from the elections", async () => {
    // Section 5's checks each have a stub, which the run rates read in place of the election.
    hh.household()
    await closeDueMonths()
    await checkClosed()
    runTool('set_contribution', { name: 'Brightline 401(k)', kind: '401k', per_paycheck: 250 }, 'assistant')
    const run = await checkClosed()
    assert.equal(run.checked.length, 24)
    assert.deepEqual([run.changed, changedMonths(), issuesOf('month_changed')], [[], [], []])
    db.closeDb()
    // The household with no stubs: its checks are what was deposited, and an election puts Saved at work in them.
    hh.household({ paystubs: false })
    await closeDueMonths()
    await checkClosed()
    runTool('set_contribution', { name: 'Brightline 401(k)', kind: '401k', paycheck_key: hh.KEY, per_paycheck: 240, match_per_paycheck: 120 }, 'assistant')
    const estimated = await checkClosed()
    assert.deepEqual(months(estimated.changed), hh.MONTHS)
    assert.equal(batches().length, 1)
    assert.deepEqual(diffSnapshot('2026-10')!.inputs.map((i) => [i.kind, i.ref, i.cause]), [['contribution', 'Brightline 401(k)', 'ai']])
    assert.deepEqual(diffSnapshot('2026-10')!.lines, [])
    showsWhatMoved('the 401(k) election')
  })

  test('a remembered rule that rewrites 14 closed months raises one month_changed issue with one batch', async () => {
    hh.household()
    // Review categorized the Daily Grind's coffee from September 2025 on; the user set the months before by hand.
    db.run("UPDATE transactions SET category_source = 'ai' WHERE description = 'DAILY GRIND CAFE' AND posted >= ?", db.monthStart('2025-09'))
    await closeDueMonths()
    await checkClosed()
    runTool('create_rule', { field: 'merchant', pattern: 'Daily Grind', category: 'Shopping' }, 'assistant')
    const run = await checkClosed()
    const want = Array.from({ length: 14 }, (_, i) => shiftMonth('2025-09', i))
    assert.deepEqual(months(run.changed), want)
    assert.equal(batches().length, 1)
    assert.deepEqual([...new Set(changedMonths().map((c) => [c.cause, c.label].join()))], ['ai,Rule Daily Grind > Shopping'])
    const issues = issuesOf('month_changed')
    assert.equal(issues.length, 1)
    assert.match(issues[0].summary, /^14 closed months have changed since they closed: Rule Daily Grind > Shopping restated 14 months \(2025-09 to 2026-10\)\./)
    // Its first three months are one-offs now (Shopping is one until it's a habit), and the rest Everyday's Shopping.
    assert.deepEqual([...new Set(diffSnapshot('2025-09')!.lines.map((l) => `${l.fromCls}>${l.toCls}`))], ['everyday>oneOff'])
    assert.deepEqual([...new Set(diffSnapshot('2026-10')!.lines.map((l) => `${l.fromCls}>${l.toCls}`))], ['everyday>everyday'])
    showsWhatMoved('the rule')
  })

  test('a sync that changes an amount has cause sync', async () => {
    tie.tieOut({ fed: true })
    await closeDueMonths(nov(7))
    await checkClosed()
    const groceries = db.all<{ id: string; posted: number; description: string }>("SELECT id, posted, description FROM transactions WHERE account_id = ? AND description = 'FRESHWAY MARKET' ORDER BY posted", tie.ACCOUNTS.visa).at(-1)!
    // The bank settles October's groceries at 610.00, not 600.00.
    db.upsertTransaction({ id: groceries.id, accountId: tie.ACCOUNTS.visa, posted: groceries.posted, amountCents: -61_000, description: groceries.description, pending: false })
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.label]), [['2026-10', 'sync', 'A sync or import']])
    assert.deepEqual(diffSnapshot('2026-10')!.lines, [{ key: `${groceries.id}::p`, change: 'reamounted', fromCls: 'everyday', toCls: 'everyday', fromCents: -60_000, toCents: -61_000, cause: 'sync' }])
    showsWhatMoved('the settled amount')
  })

  test('an ENGINE_VERSION bump has cause engine: months whose figures are the same stay closed, and one whose line the new classifier classes otherwise is changed', async () => {
    tie.tieOut()
    await closeDueMonths(nov(7))
    await checkClosed()
    // The books as an earlier classifier closed and checked them: its version, its inputs stamp (which reads the
    // version), and September's bistro dinner a one-off.
    const bistro = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description = 'CORNER BISTRO' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2026-09'))!.id
    db.run("UPDATE month_snapshots SET engine_version = ?, inputs_stamp = 'an earlier classifier'", ENGINE_VERSION - 1)
    db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%'")
    db.run("UPDATE snapshot_lines SET class = 'oneOff' WHERE month = '2026-09' AND txn_id = ?", bistro)
    const kept = db.all<{ key: string; cls: string; cents: number }>("SELECT line_key AS key, class AS cls, cents FROM snapshot_lines WHERE month = '2026-09' AND version = 1")
    db.run("UPDATE month_snapshots SET line_digest = ? WHERE month = '2026-09'", linesDigest(kept))
    const run = await checkClosed()
    assert.equal(run.checked.length, 6)
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.batch, c.label]), [['2026-09', 'engine', `engine:${ENGINE_VERSION}`, `The engine's version ${ENGINE_VERSION}`]])
    assert.deepEqual(diffSnapshot('2026-09')!.lines.map((l) => [l.change, l.fromCls, l.toCls, l.cause]), [['restaged', 'oneOff', 'everyday', 'engine']])
    assert.deepEqual(listSnapshots(1000).filter((s) => s.status === 'changed').map((s) => s.month), ['2026-09'])
    // Its rows were frozen as this classifier has them: its lines alone moved, and Home shows them, the dinner gone
    // from One-offs' lines and come into Everyday's, under the rows they go into.
    const lines = (open: Opened): string[][] => view.homeTable(getWaterfall({ from: '2026-09', to: '2026-09' }), open).lines.flatMap((l) => (l.kind === 'closed' ? [[l.name, l.now, l.closed, l.change]] : []))
    const moved = [
      ['Everyday lines', '2', '1', '+1'],
      ['One-offs lines', '0', '1', `${view.MINUS}1`]
    ]
    for (const open of [null, 'leftOver', 'saved'] as Opened[]) assert.deepEqual(lines(open), moved, String(open))
    showsWhatMoved('the earlier classifier')
  })

  test("checks a year read from the days checks land on (version 2) restate only a payroll's first month closed under version 1, as one batch with cause engine, never silently", async () => {
    // What version 1 (main before the pay-cadence change) read in each fixture's first month: the first few checks of
    // a payroll paid on the 3rd and the 17th, or on the 1st and the 15th, as every other week, 26 a year, not 24.
    const VERSION_1: Array<{ setUp: () => void; month: string; tolerance: number; runRates: Partial<Record<StageId, number>>; now: Partial<Record<StageId, number>> }> = [
      {
        setUp: () => void tie.tieOut(),
        month: '2026-05',
        tolerance: 2_167,
        runRates: { gross: 606_667, taxes: 97_500, benefits: 21_667, savedAtWork: 54_167, takeHome: 433_333, elective: 276_433, leftOver: 249_766, saved: 331_016, invested: 83_750 },
        now: { gross: 560_000, takeHome: 400_000, saved: 291_433 }
      },
      {
        setUp: () => void hh.household(),
        month: '2024-11',
        tolerance: 2_046,
        runRates: { gross: 650_000, taxes: 155_025, benefits: 20_800, savedAtWork: 65_000, takeHome: 409_175, elective: 191_975, leftOver: 160_308, saved: 254_425, invested: 98_283 },
        now: { gross: 600_000, takeHome: 377_700, saved: 215_550 }
      }
    ]
    for (const v1 of VERSION_1) {
      v1.setUp()
      await closeDueMonths(nov(7))
      const closed = [...new Set(listSnapshots(1000).map((s) => s.month))]
      assert.ok(closed.includes(v1.month), `${v1.month} closed`)
      // The books as version 1 closed them, before a check kept its state or the stamp's parts: its version and its
      // inputs stamp (which reads the version) on every month, and the first month's pay rows as version 1 read them.
      db.run("UPDATE month_snapshots SET engine_version = ?, inputs_stamp = 'version 1'", ENGINE_VERSION - 1)
      db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%' OR key LIKE 'snapshots.stamp:%' OR key = 'snapshots.sweep'")
      for (const r of db.all<{ month: string; rows: string; identity: string }>('SELECT month, "rows", identity FROM month_snapshots')) {
        const frozen = JSON.parse(r.rows) as { rows: Array<{ id: StageId; runRateCents: number | null }>; series?: string; raw?: unknown }
        delete frozen.series
        delete frozen.raw
        if (r.month !== v1.month) {
          db.run('UPDATE month_snapshots SET "rows" = ? WHERE month = ?', JSON.stringify(frozen), r.month)
          continue
        }
        const at = (id: StageId, cents: number | null): number | null => v1.runRates[id] ?? cents
        const w = monthClose(r.month).waterfall
        frozen.rows = frozen.rows.map((x) => ({ ...x, runRateCents: at(x.id, x.runRateCents) }))
        db.run(
          'UPDATE month_snapshots SET "rows" = ?, identity = ?, rows_digest = ? WHERE month = ?',
          JSON.stringify(frozen),
          JSON.stringify({ ...JSON.parse(r.identity), toleranceCents: v1.tolerance }),
          rowsDigest({ ...w, rows: w.rows.map((x) => ({ ...x, runRateCents: at(x.id, x.runRateCents) })) }),
          r.month
        )
      }
      const run = await checkClosed()
      assert.equal(run.checked.length, closed.length)
      // Only the first month moved, and it shows: its lines and inputs are the same, so the new engine is the cause.
      assert.deepEqual([run.changed.map((c) => [c.month, c.cause, c.batch, c.label]), run.reclosed], [[[v1.month, 'engine', `engine:${ENGINE_VERSION}`, `The engine's version ${ENGINE_VERSION}`]], []])
      const d = diffSnapshot(v1.month)!
      assert.deepEqual([d.lines, d.inputs, d.autoReclose], [[], [], null])
      const stage = (id: StageId): [number | null, number | null] => {
        const s = d.byStage.find((x) => x.id === id)!
        return [s.closedRunRateCents, s.nowRunRateCents]
      }
      for (const [id, cents] of Object.entries(v1.now) as Array<[StageId, number]>) assert.deepEqual(stage(id), [v1.runRates[id], cents], `${v1.month}'s ${id}`)
      assert.equal(issuesOf('month_changed').length, 1)
      assert.equal(batches().length, 1)
      // Home shows the closed run rate beside today's until Review keeps the new figures.
      const takeHome = getWaterfall({ from: v1.month, to: v1.month }).rows.find((r) => r.id === 'takeHome')!
      assert.deepEqual([takeHome.closedRunRateCents, takeHome.runRateCents], [v1.runRates.takeHome, v1.now.takeHome])
      noSilentChange(v1.month)
      showsWhatMoved(v1.month)
      runTool('accept_close_changes', {}, 'assistant')
      assert.deepEqual([latest(v1.month)!.version, latest(v1.month)!.engineVersion, changedMonths(), issuesOf('month_changed')], [2, ENGINE_VERSION, [], []])
      assert.deepEqual((await checkClosed()).changed, [])
      db.closeDb()
    }
  })

  test('months closed under an earlier classifier and found unchanged under this one take a later change as a series, rule or setting, not as the classifier', async () => {
    // Lumen Streaming, paid on Sep 7 and Oct 7: no series yet.
    books([
      ['2026-09-07', -1_299, 'Lumen Streaming', 'Subscriptions'],
      ['2026-10-07', -1_299, 'Lumen Streaming', 'Subscriptions']
    ])
    await closeDueMonths(nov(7))
    db.run("UPDATE month_snapshots SET engine_version = ?, inputs_stamp = 'an earlier classifier'", ENGINE_VERSION - 1)
    db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%'")
    const first = await checkClosed()
    assert.deepEqual([first.checked.length, first.changed], [6, []])
    // November's payment makes it a monthly series.
    bookLine('lumen-nov', '2026-11-06', -1_299, 'Lumen Streaming', 'Subscriptions')
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.label]), [
      ['2026-09', 'rule', 'A series, rule or setting'],
      ['2026-10', 'rule', 'A series, rule or setting']
    ])
    assert.deepEqual(diffSnapshot('2026-09')!.lines.map((l) => [l.change, l.fromCls, l.toCls, l.cause]), [['restaged', 'everyday', 'committed', 'rule']])
    showsWhatMoved('the series under this classifier')
  })
})

describe('what a change is put down to', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })
  const causes = (): string[] => [...new Set(changedMonths().map((c) => `${c.cause}|${c.label}`))]

  test("a setting changed on a page is the user's, though Review changed something else since the months closed", async () => {
    const h = hh.household()
    await closeDueMonths()
    await checkClosed()
    // Review files a November coffee as Groceries, then the user renames Housing on the Categories page.
    const coffee = hh.line(hh.ACCOUNTS.visa, '2026-11-04', -450, 'DAILY GRIND CAFE', 'Coffee', 'Daily Grind')
    runTool('categorize', { transaction_ids: [coffee], category: 'Groceries' }, 'assistant')
    assert.deepEqual((await checkClosed()).changed, [])
    const housing = db.listCategories().find((c) => c.name === 'Housing')!
    await onPage('saveCategory', { ...housing, name: 'Home costs' })
    await checkClosed()
    assert.deepEqual(causes(), ['user|Your edits'])
    assert.deepEqual(diffSnapshot('2026-10')!.inputs.map((i) => [i.kind, i.ref, i.cause]), [['setting', `categories:${housing.id}`, 'user']])
    showsWhatMoved('Housing renamed')
    db.closeDb()
    // Review renames the Visa, then the user edits its APR on the Accounts page.
    hh.household()
    await closeDueMonths()
    await checkClosed()
    runTool('update_account', { account_id: hh.ACCOUNTS.visa, name: 'Visa Signature' }, 'assistant')
    assert.deepEqual((await checkClosed()).changed, [])
    await onPage('updateAccount', hh.ACCOUNTS.visa, { apr: 26 })
    await checkClosed()
    assert.deepEqual(causes(), ['user|Your edits'])
    assert.deepEqual(diffSnapshot('2026-10')!.inputs.map((i) => [i.kind, i.ref, i.cause]), [['account', hh.ACCOUNTS.visa, 'user']])
    showsWhatMoved("the Visa's APR")
    void h
  })

  test("a line's own field edited on a page with no journal entry is the user's: one-time, a split and a category deleted", async () => {
    const cases: Array<[string, (find: (d: string, m: string) => string) => Promise<unknown>, string]> = [
      ['one-time', (find) => onPage('setOneTime', [find('CORNER BISTRO', '2026-04')], true), '2026-04'],
      ['a split', (find) => onPage('splitTransaction', find('FRESHWAY MARKET', '2026-03'), [{ amountCents: -10_000, categoryId: cat('Groceries') }, { amountCents: -5_000, categoryId: cat('Shopping') }]), '2026-03'],
      ['a category deleted', () => onPage('deleteCategory', cat('Coffee')), '2026-10']
    ]
    for (const [name, write, month] of cases) {
      mock.timers.setTime(nov(7) * 1000)
      hh.household()
      await closeDueMonths()
      await checkClosed()
      const find = (description: string, m: string): string => db.all<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE description = ? ORDER BY posted', description).find((r) => db.dayKey(r.posted).startsWith(m))!.id
      await write(find)
      await checkClosed()
      assert.deepEqual(causes(), ['user|Your edits'], name)
      const d = diffSnapshot(month)!
      assert.ok(d.lines.length > 0, name)
      assert.deepEqual([...new Set(d.lines.map((l) => l.cause))], ['user'], name)
      showsWhatMoved(name)
      db.closeDb()
    }
  })

  test('a value looked up for a house since its month closed is a sync, not an edit of the user\'s', async () => {
    const h = hh.household()
    // The house's Oct 31 value wasn't in when the books closed: October's month end is carried from Sep 30.
    db.deleteBalancePoint(h.house, '2026-10-31')
    await closeDueMonths()
    await checkClosed()
    db.addValuation(h.house, { day: '2026-11-08', valueCents: 46_000_000, lowCents: null, highCents: null, basis: 'estimate', sources: [] })
    await checkClosed()
    assert.deepEqual(months(changedMonths()), ['2026-10'])
    assert.deepEqual(causes(), ['sync|A sync or import'])
    assert.deepEqual(diffSnapshot('2026-10')!.inputs.map((i) => [i.kind, i.ref, i.cause]), [['balance', h.house, 'sync']])
    showsWhatMoved("the house's value")
  })

  test("a remembered categorization is named as its rule, a line deleted from an imported account is the user's, and one changed month reads as one", async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    const find = (description: string, m: string): string => db.all<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE description = ? ORDER BY posted', description).find((r) => db.dayKey(r.posted).startsWith(m))!.id
    runTool('categorize', { transaction_ids: [find('DAILY GRIND CAFE', '2026-10')], category: 'Groceries', remember: true }, 'assistant')
    await checkClosed()
    assert.deepEqual([...new Set(changedMonths().map((c) => c.label))], ['Rule Daily Grind > Groceries'])
    showsWhatMoved('the remembered categorization')
    db.closeDb()
    hh.household()
    await closeDueMonths()
    await checkClosed()
    await onPage('deleteTransaction', find('TUNEWAVE MUSIC', '2026-10'))
    await checkClosed()
    assert.deepEqual([months(changedMonths()), causes()], [['2026-10'], ['user|Your edits']])
    assert.deepEqual(diffSnapshot('2026-10')!.lines.map((l) => [l.change, l.cause]), [['removed', 'user']])
    assert.match(issuesOf('month_changed')[0].summary, /^A closed month has changed since it closed: Your edits restated 1 month \(2026-10\)\./)
    showsWhatMoved('the deleted line')
  })
})

describe('what other months decide of a closed month', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a later payment that makes a payee a series makes its closed months' lines committed, though neither their raw digests nor the six months before them moved", async () => {
    // Lumen Streaming, paid on Sep 7 and Oct 7: two payments are no series, so they're Everyday.
    books([
      ['2026-09-07', -1_299, 'Lumen Streaming', 'Subscriptions'],
      ['2026-10-07', -1_299, 'Lumen Streaming', 'Subscriptions']
    ])
    await closeDueMonths(nov(7))
    await checkClosed()
    const raws = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((m) => rawDigest(m, [...monthClose(m).balances.keys()]))
    assert.deepEqual(raws, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((m) => latest(m)!.digests.raw))
    // November's payment makes it a monthly series: a subscription, committed.
    bookLine('lumen-nov', '2026-11-06', -1_299, 'Lumen Streaming', 'Subscriptions')
    assert.deepEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((m) => rawDigest(m, [...monthClose(m).balances.keys()])), raws)
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause]), [
      ['2026-09', 'rule'],
      ['2026-10', 'rule']
    ])
    assert.deepEqual(diffSnapshot('2026-09')!.lines.map((l) => [l.change, l.fromCls, l.toCls]), [['restaged', 'everyday', 'committed']])
    noSilentChange('the series')
    showsWhatMoved('the series')
  })

  test("a series' newest payment synced with no category yet moves no closed month, nor does its category once given", async () => {
    // Lumen Streaming at 15.49 a month, May to October: a subscription, committed.
    books(Array.from({ length: 6 }, (_, i): [string, number, string, string] => [`${shiftMonth('2026-05', i)}-07`, -1_549, 'Lumen Streaming', 'Subscriptions']))
    await closeDueMonths(nov(7))
    await checkClosed()
    assert.deepEqual([...new Set(monthClose('2026-08').lines.filter((l) => l.seriesKey?.startsWith('lumen')).map((l) => l.cls))], ['committed'])
    // November's charge arrives before any rule or Review has filed it.
    db.upsertTransaction({ id: 'lumen-nov', accountId: 'csv:chk', posted: noonOn(2026, 11, 7), amountCents: -1_549, description: 'LUMEN STREAMING', pending: false })
    db.setTransactionFields('lumen-nov', { merchant: 'Lumen Streaming' })
    const run = await checkClosed()
    assert.deepEqual([run.changed, changedMonths()], [[], []])
    db.setTransactionFields('lumen-nov', { categoryId: cat('Subscriptions'), source: 'ai' })
    assert.deepEqual((await checkClosed()).changed, [])
    noSilentChange('the series')
  })

  test("a line up to PURCHASE_DAYS later that a capital window takes first moves a closed month's capital: the purchase becomes an orphan", async () => {
    // A 30,000.00 cashier's check on Sep 10 for a car opened on Nov 5 at that cost: capital, by the purchase's window.
    books([['2026-09-10', -3_000_000, 'Cashiers Check', 'Transfers']])
    db.addManualAccount({ name: 'Wagon', assetType: 'vehicle', openedDay: '2026-11-05', costCents: 3_000_000, points: [{ day: '2026-11-05', cents: 3_000_000 }] })
    await closeDueMonths(nov(7))
    await checkClosed()
    assert.equal(monthClose('2026-09').waterfall.identity.boughtCents, 3_000_000)
    // A second check on Nov 4, a day before the car: nearest its day, it takes the window's whole cap.
    bookLine('check-nov', '2026-11-04', -3_000_000, 'Cashiers Check', 'Transfers')
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause]), [['2026-09', 'rule']])
    assert.deepEqual(diffSnapshot('2026-09')!.lines.map((l) => [l.change, l.fromCls, l.toCls]), [['restaged', 'capital', 'orphan']])
    assert.equal(monthClose('2026-09').waterfall.identity.boughtCents, 0)
    noSilentChange('the capital window')
    showsWhatMoved('the capital window')
  })
})

describe('what a close holds', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a close computes only what it keeps, and holds what Home shows for its month: every row's and part's figures, the identities and the bridge", async () => {
    mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
    for (const build of [() => void hh.household(), () => void hh.household({ paystubs: false }), () => void tie.tieOut()]) {
      build()
      await closeDueMonths()
      for (const s of listSnapshots(1000)) {
        const home = getWaterfall({ from: s.month, to: s.month })
        assert.equal(rowsDigest(home), s.digests.rows, s.month)
        const c = monthClose(s.month)
        assert.deepEqual(
          c.waterfall.rows.map((r) => [r.id, r.changeCents, r.rateChangePts]),
          home.rows.map((r) => [r.id, r.changeCents, r.rateChangePts]),
          s.month
        )
        assert.deepEqual([c.waterfall.levers, c.waterfall.retirement, c.waterfall.leaks, c.waterfall.checks, c.waterfall.toleranceCents], [[], null, home.leaks, home.checks, home.toleranceCents], s.month)
      }
      db.closeDb()
    }
  })
})

describe('a closed month as time passes, with no writes', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  for (const [name, build] of [
    ["section 5's household", () => void hh.household()],
    ['the tie-out', () => void tie.tieOut()],
    ['the small books with a car bought by check', () => {
      books([['2026-09-10', -3_000_000, 'Cashiers Check', 'Transfers']])
      db.addManualAccount({ name: 'Wagon', assetType: 'vehicle', openedDay: '2026-11-05', costCents: 3_000_000, points: [{ day: '2026-11-05', cents: 3_000_000 }] })
    }]
  ] as Array<[string, () => void]>) {
    test(`${name}: a check 3, 13 and 25 months on finds every month its close's, its classification and rows read nothing of today`, async () => {
      mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
      build()
      await closeDueMonths(nov(7))
      await checkClosed()
      for (const [y, m] of [
        [2027, 2],
        [2027, 12],
        [2028, 12]
      ]) {
        mock.timers.setTime(noonOn(y, m, 10) * 1000)
        const run = await checkClosed()
        assert.deepEqual([run.changed, run.reclosed, run.restored, run.failed], [[], [], [], []], `${y}-${m}`)
        noSilentChange(`${y}-${m}`)
      }
    })
  }

  test("a payee that's a series in its last 400 days and not over its whole history keeps its closed months' lines committed as they age past 400 days before today", async () => {
    mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
    // Peak Gym: five payments at odd gaps in 2024, then monthly from October 2025 to October 2026. Over its whole
    // history too few gaps are a month for a series; over the 400 days before its latest payment it's a monthly one.
    books([
      ...['2024-03-03', '2024-03-20', '2024-06-28', '2024-07-05', '2024-07-09'].map((d): [string, number, string, string] => [d, -4_500, 'Peak Gym', 'Subscriptions']),
      ...Array.from({ length: 13 }, (_, i): [string, number, string, string] => [`${shiftMonth('2025-10', i)}-15`, -4_500, 'Peak Gym', 'Subscriptions'])
    ])
    await closeDueMonths(nov(7))
    await checkClosed()
    const gym = (month: string): string[] => monthClose(month).lines.filter((l) => l.seriesKey === 'peak gym|-').map((l) => l.cls)
    assert.deepEqual([gym('2025-10'), gym('2026-10')], [['committed'], ['committed']])
    // Read from a window ending today, October 2025's line left the window by February and paid no series after.
    for (const [y, m] of [
      [2027, 2],
      [2027, 12]
    ]) {
      mock.timers.setTime(noonOn(y, m, 10) * 1000)
      const run = await checkClosed()
      assert.deepEqual([run.changed, run.checked], [[], []], `${y}-${m}`)
      assert.deepEqual([gym('2025-10'), gym('2026-10')], [['committed'], ['committed']], `${y}-${m}`)
    }
  })
})

describe('no false changes', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a sync that brings the same transactions again, a write of a value that was already there, and lines in the open month mark no closed month changed", async (t) => {
    tie.tieOut({ fed: true })
    await closeDueMonths(nov(7))
    await checkClosed()
    const timed = async (what: string, f: () => void): Promise<Awaited<ReturnType<typeof checkClosed>>> => {
      f()
      const t0 = performance.now()
      const run = await checkClosed()
      t.diagnostic(`${what}: ${run.checked.length} months recomputed, ${(performance.now() - t0).toFixed(0)} ms`)
      assert.deepEqual([run.changed, run.reclosed, run.restored], [[], [], []], what)
      return run
    }
    const october = db.all<{ id: string; account_id: string; posted: number; amount_cents: number; description: string }>('SELECT id, account_id, posted, amount_cents, description FROM transactions WHERE posted >= ? AND posted < ?', db.monthStart('2026-10'), db.monthStart('2026-11'))
    const again = await timed('the same October lines synced again', () => {
      for (const r of october) db.upsertTransaction({ id: r.id, accountId: r.account_id, posted: r.posted, amountCents: r.amount_cents, description: r.description, pending: false })
      db.upsertAccount({ id: tie.ACCOUNTS.checking, source: 'simplefin', name: 'Checking', institution: null, currency: 'USD', balanceCents: 311_000, availableCents: null, balanceDate: nov(7) })
    })
    assert.equal(again.checked.length, 0)
    const same = await timed('values written as they were', () => {
      db.updateAccount(tie.ACCOUNTS.visa, { apr: 24 })
      db.setTransactionFields(october[0].id, { categoryId: db.getTransaction(october[0].id)!.categoryId, source: 'user' })
      db.setSetting('close.tolerance', db.getSetting('close.tolerance'))
    })
    assert.equal(same.checked.length, 0)
    // The retirement line and the focus dot aren't frozen: their settings recompute nothing.
    const unfrozen = await timed('a retirement setting and the focus threshold', () => {
      runTool('set_retirement', { birth_year: 1990, retire_age: 65, real_return_pct: 4 }, 'assistant')
      db.setSetting('focus.points', '2')
    })
    assert.equal(unfrozen.checked.length, 0)
    // A line on Nov 2 is read by October's raw digest (a transfer's other side can land then), so October is recomputed.
    await timed('lines in the open month', () => {
      tie.line(tie.ACCOUNTS.checking, '2026-11-02', -1_250, 'CORNER CAFE', 'Coffee', 'Corner Cafe')
      tie.line(tie.ACCOUNTS.visa, '2026-11-06', -6_400, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    })
    assert.deepEqual([changedMonths(), issuesOf('month_changed')], [[], []])
  })
})

describe("accepting a month's change", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('accept_close_changes keeps the new figures as each changed month\'s next version, and undoing it leaves them changed as they were', async () => {
    const h = hh.household()
    await closeDueMonths()
    await onPage('updateTransaction', h.meal, { categoryId: cat('Dining Out') })
    await checkClosed()
    assert.deepEqual(months(changedMonths()), ['2026-09', '2026-10'])
    showsWhatMoved('before accepting')
    assert.throws(() => runTool('accept_close_changes', { months: ['2026-08'] }, 'assistant'), /2026-08 hasn't changed since its close/)
    const r = runTool('accept_close_changes', {}, 'assistant')
    assert.deepEqual((r.result as { months: Array<{ month: string; version: number; status: string }> }).months.map((m) => [m.month, m.version, m.status]), [
      ['2026-09', 2, 'closed'],
      ['2026-10', 2, 'closed']
    ])
    assert.deepEqual([changedMonths(), issuesOf('month_changed')], [[], []])
    assert.equal(latest('2026-09')!.origin, 'review')
    assert.deepEqual((await checkClosed()).changed, [])
    noSilentChange('accepted')
    // Undo: the new versions go, and the months are their first closes', changed, in their batch.
    const c = db.getChange(r.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    db.markChangeUndone(r.changeId!)
    assert.deepEqual([latest('2026-09')!.version, latest('2026-10')!.version], [1, 1])
    assert.deepEqual(months(changedMonths()), ['2026-09', '2026-10'])
    assert.equal(batches().length, 1)
    assert.equal(issuesOf('month_changed').length, 1)
    assert.deepEqual((await checkClosed()).changed, [])
    // Undoing the edit itself brings both back to their close.
    await onPage('updateTransaction', h.meal, { categoryId: cat('Travel') })
    const back = await checkClosed()
    assert.deepEqual(back.restored, ['2026-09', '2026-10'])
    assert.deepEqual(listSnapshots(1000).filter((s) => s.version === 1 && ['2026-09', '2026-10'].includes(s.month)).map((s) => s.status), ['closed', 'closed'])
    assert.deepEqual(issuesOf('month_changed'), [])
  })

  test('accept_close_changes keeps twelve months a call, the oldest first, in one write, and says how many are left; each call is undone on its own', async () => {
    db.closeDb()
    hh.household()
    await closeDueMonths()
    await checkClosed()
    // The Visa's APR moves every month's Committed run rate: 24 months changed.
    await onPage('updateAccount', hh.ACCOUNTS.visa, { apr: 26 })
    await checkClosed()
    assert.equal(changedMonths().length, 24)
    showsWhatMoved("the Visa's APR")
    const first = runTool('accept_close_changes', {}, 'assistant')
    const kept = (r: typeof first): string[] => (r.result as { months: Array<{ month: string }> }).months.map((m) => m.month)
    assert.deepEqual([kept(first), (first.result as { left: number }).left], [hh.MONTHS.slice(0, 12), 12])
    assert.deepEqual(months(changedMonths()), hh.MONTHS.slice(12))
    const second = runTool('accept_close_changes', {}, 'assistant')
    assert.deepEqual([kept(second), (second.result as { left: number }).left], [hh.MONTHS.slice(12), 0])
    assert.deepEqual([changedMonths(), issuesOf('month_changed')], [[], []])
    // Undoing the second call leaves the first's months kept.
    const c = db.getChange(second.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    db.markChangeUndone(second.changeId!)
    assert.deepEqual(months(changedMonths()), hh.MONTHS.slice(12))
    // A call cut off part way (here a month that can't be written) keeps none of its months, so none is kept unjournaled.
    db.run("CREATE TEMP TRIGGER no_june BEFORE INSERT ON month_snapshots WHEN NEW.month = '2026-06' BEGIN SELECT RAISE(ABORT, 'cut off'); END")
    const versions = listSnapshots(1000).length
    const entries = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM changes')!.n
    assert.throws(() => runTool('accept_close_changes', {}, 'assistant'), /cut off/)
    db.run('DROP TRIGGER no_june')
    assert.deepEqual([listSnapshots(1000).length, db.get<{ n: number }>('SELECT COUNT(*) AS n FROM changes')!.n], [versions, entries])
    assert.deepEqual(months(changedMonths()), hh.MONTHS.slice(12))
  })
})

describe('trends read a changed month as it closed', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("deposits only, with November open: a paystub dated Oct 31 puts November on estimated pay while August's close is on deposits, so Take-home's and Saved's Δ pts are blank until Review accepts; then August is estimated too, Take-home moves 0.0 points and gets no focus", async () => {
    hh.household({ paystubs: false })
    await closeDueMonths()
    await checkClosed()
    hh.stub('2026-10-31')
    const run = await checkClosed()
    // The stub gives every check of its year its gross: the months whose windows hold a check of 2026.
    assert.deepEqual(months(run.changed), Array.from({ length: 10 }, (_, i) => shiftMonth('2026-01', i)))
    assert.equal(batches().length, 1)
    const w = getWaterfall({ from: '2026-11', to: '2026-11' })
    const row = (id: StageId): Waterfall['rows'][number] => w.rows.find((r) => r.id === id)!
    assert.deepEqual([row('takeHome').basis, w.rows.find((r) => r.id === 'takeHome')!.trend.find((p) => p.month === '2026-08')!.basis], ['estimated', 'deposits'])
    assert.deepEqual([row('takeHome').rateChangePts, row('saved').rateChangePts], [null, null])
    assert.ok(w.focus !== 'takeHome' && w.focus !== 'saved', String(w.focus))
    showsWhatMoved('the Oct 31 stub')
    runTool('accept_close_changes', {}, 'assistant')
    const after = getWaterfall({ from: '2026-11', to: '2026-11' })
    const trend = after.rows.find((r) => r.id === 'takeHome')!.trend.find((p) => p.month === '2026-08')!
    assert.deepEqual([trend.basis, trend.runRateCents], ['estimated', 377_700])
    assert.deepEqual([after.rows.find((r) => r.id === 'takeHome')!.runRateCents, after.rows.find((r) => r.id === 'takeHome')!.rate, after.rows.find((r) => r.id === 'takeHome')!.rateChangePts], [377_700, 63, 0])
    assert.notEqual(after.focus, 'takeHome')
  })

  test("a changed month's sparkline, Δ 3 mo and Δ pts read its close, and its rows carry the closed actual and run rate beside today's", async () => {
    db.closeDb()
    const h = hh.household()
    await closeDueMonths()
    await onPage('updateTransaction', h.meal, { categoryId: cat('Dining Out') })
    await checkClosed()
    const oct = getWaterfall({ from: '2026-10', to: '2026-10' })
    const everyday = oct.rows.find((r) => r.id === 'everyday')!
    // Today's run rate beside the close's; the change over 3 months is the close's (1,020.00 less July's 950.00).
    assert.deepEqual([everyday.runRateCents, everyday.closedRunRateCents, everyday.changeCents, everyday.actualCents, everyday.closedCents], [103_600, 102_000, 7_000, 110_640, 110_640])
    assert.deepEqual(everyday.trend.slice(-2).map((p) => [p.month, p.runRateCents, p.status]), [
      ['2026-09', 96_787, 'changed'],
      ['2026-10', 102_000, 'changed']
    ])
    assert.equal(oct.rows.find((r) => r.id === 'leftOver')!.rateChangePts, -5.8)
    assert.deepEqual([oct.status, oct.months.map((m) => m.status)], ['changed', ['changed']])
    const sep = getWaterfall({ from: '2026-09', to: '2026-09' }).rows.find((r) => r.id === 'everyday')!
    assert.deepEqual([sep.actualCents, sep.closedCents], [110_000, 105_200])
    // A month not changed carries none.
    assert.deepEqual(getWaterfall({ from: '2026-08', to: '2026-08' }).rows.map((r) => r.closedCents).filter((c) => c !== null), [])
    assert.equal(getWaterfall({ from: '2026-08', to: '2026-08' }).closed, null)
    showsWhatMoved('the September meal')
  })
})

describe('a change to what every month reads', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a category renamed recomputes every closed month in the background, one at a time with the event loop free between them, in the closes\' queue; checks asked for meanwhile are one more run, and a run cut short carries on where it stopped', async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    const groceries = db.listCategories().find((c) => c.name === 'Groceries')!
    db.saveCategory({ ...groceries, name: 'Groceries & Market' })
    // Cut short after 5 months (the app quit, or a hosted event's limit): the rest wait.
    const part = await checkClosed({ limit: 5 })
    assert.deepEqual([part.checked, part.left], [hh.MONTHS.slice(0, 5), 19])
    // The rest, with a 1 ms timer ticking between months and two more checks and a close asked for meanwhile.
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    const order: string[] = []
    const rest = checkClosed().then((r) => (order.push('check'), r))
    const close = closeDueMonths().then((r) => (order.push('close'), r))
    const [x, y] = await Promise.all([checkClosed(), checkClosed()])
    const done = await rest
    await close
    clearInterval(timer)
    assert.deepEqual(done.checked, hh.MONTHS.slice(5))
    assert.ok(ticks >= done.checked.length - 1, `${ticks} ticks over ${done.checked.length} months`)
    assert.deepEqual(order, ['check', 'close'])
    // The two asked for meanwhile were one run, after the close, with nothing left to recompute.
    assert.equal(x, y)
    assert.deepEqual([x.checked, x.changed], [[], []])
    assert.deepEqual([done.changed, changedMonths()], [[], []])
  })

  test("a run cut short by its limit leaves the months after a changed one that it hadn't reached to the next run, so none of them changes silently", async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    // December 2025's one-off filed as Groceries: it and the ten closed months after it are changed.
    const oneOff = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description LIKE 'ONE-OFF GOODS%' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2025-12'))!.id
    await onPage('updateTransaction', oneOff, { categoryId: cat('Groceries') })
    // A hosted ledger's events, eight months each.
    const first = await checkClosed({ limit: 8 })
    assert.deepEqual([first.checked, first.left], [Array.from({ length: 8 }, (_, i) => shiftMonth('2025-11', i)), 4])
    const second = await checkClosed({ limit: 8 })
    assert.deepEqual([second.checked, second.left], [['2026-07', '2026-08', '2026-09', '2026-10'], 0])
    assert.deepEqual(months(changedMonths()), Array.from({ length: 11 }, (_, i) => shiftMonth('2025-12', i)))
    assert.equal(batches().length, 1)
    noSilentChange('after the second event')
    showsWhatMoved('after the second event')
    assert.deepEqual((await checkClosed()).checked, [])
  })

  test("a month that couldn't be checked (another process wrote meanwhile) is checked on the next run, and no month after it re-closes by itself in the meantime", async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    const oneOff = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description LIKE 'ONE-OFF GOODS%' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2026-06'))!.id
    await onPage('updateTransaction', oneOff, { categoryId: cat('Groceries') })
    // August's check can't write what it found.
    for (const on of ['INSERT', 'UPDATE']) db.run(`CREATE TEMP TRIGGER no_august_${on} BEFORE ${on} ON settings WHEN NEW.key = 'snapshots.checked:2026-08' BEGIN SELECT RAISE(ABORT, 'busy'); END`)
    const first = await checkClosed()
    assert.deepEqual([first.failed.map((f) => f.month), months(first.changed), first.reclosed], [['2026-08'], ['2026-06', '2026-07', '2026-09', '2026-10'], []])
    for (const on of ['INSERT', 'UPDATE']) db.run(`DROP TRIGGER no_august_${on}`)
    const next = await checkClosed()
    assert.deepEqual([next.checked, months(next.changed), next.failed], [['2026-08'], ['2026-08'], []])
    assert.equal(batches().length, 1)
    noSilentChange('after the month that failed')
    showsWhatMoved('after the month that failed')
  })
})

describe('the cost of checking', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  // Each budget (spec 2, Cost) is timed against test/cost.ts's reference work in paired rounds, and holds as the
  // median of the rounds' ratios: a budget of B ms is a ratio of B / REFERENCE_MS, what the work may take against
  // the reference on the reference machine's fast cores with nothing else running (where the reference takes
  // REFERENCE_MS). The reference runs none of the engine, so a slower monthClose or classifier can't slow it too and
  // cancel out.

  test("raw digests for 60 closed months take under 150 ms, and a check that finds nothing moved costs little more", async (t) => {
    db.openDb(':memory:')
    largeLedger()
    await closeDueMonths()
    await checkClosed()
    const closed = listSnapshots(1000).map((s) => s.month)
    assert.equal(closed.length, 60)
    const accounts = new Map(closed.map((m) => [m, [...monthClose(m).balances.keys()]]))
    const raw = await paired(6, () => repeatedMs(() => closed.forEach((m) => rawDigest(m, accounts.get(m)!))))
    t.diagnostic(within('raw digests of 60 closed months', 150, raw))
    assert.ok(raw.ratio <= budgetRatio(150), within('raw digests of 60 closed months', 150, raw))
    // A check after a line in the open month: every month's raw digest, the inputs stamp and one classification of
    // the books, a step at a time; then one after a write no month reads, which finds the books as they were.
    tie.line('csv:chk', '2026-11-07', -1_250, 'CORNER CAFE', 'Coffee', 'Corner Cafe')
    const fresh = await busyOf(() => checkClosed())
    db.setSetting('x.poke', '1')
    const quiet = await busyOf(() => checkClosed())
    t.diagnostic(`a check that finds nothing moved: ${fresh.toFixed(0)} busy ms after a line in the open month, ${quiet.toFixed(0)} ms after a write no month reads`)
  })

  test("and 95 months' raw digests, a long ledger's, take under 150 ms too", async (t) => {
    db.closeDb()
    db.openDb(':memory:')
    const books = largeLedger({ from: '2018-12' })
    const closed = Array.from({ length: 95 }, (_, i) => shiftMonth(books.first, i))
    assert.equal(closed.at(-1), '2026-10')
    // Every account is open in every month, so each month's close reads the same accounts.
    const accounts = [...monthClose('2026-10').balances.keys()]
    const raw = await paired(6, () => repeatedMs(() => closed.forEach((m) => rawDigest(m, accounts))))
    t.diagnostic(within(`raw digests of 95 months over ${books.transactions} transactions`, 150, raw))
    assert.ok(raw.ratio <= budgetRatio(150), within('raw digests of 95 months', 150, raw))
  })

  test('one changed month, reclassified and recomputed with its eleven followers, takes under 500 ms', async (t) => {
    // Each round on new books, set up untimed: the timed side is the check after the edit, its look at the books and
    // the 13 months.
    const r = await paired(
      6,
      async () => {
        let run: Awaited<ReturnType<typeof checkClosed>> | null = null
        const ms = await busyOf(async () => (run = await checkClosed()))
        // September 2025 too: its raw digest reads the Visa's lines up to its next statement after September, Oct 31.
        assert.deepEqual(run!.checked, Array.from({ length: 13 }, (_, k) => shiftMonth('2025-09', k)))
        assert.deepEqual(months(run!.changed), Array.from({ length: 12 }, (_, k) => shiftMonth('2025-10', k)))
        return ms
      },
      async () => {
        db.closeDb()
        hh.household()
        await closeDueMonths()
        await checkClosed()
        // October 2025's one-off filed as Everyday's Groceries: it and the eleven months after it are recomputed.
        const oneOff = db.all<{ id: string; posted: number }>("SELECT id, posted FROM transactions WHERE description LIKE 'ONE-OFF GOODS%' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2025-10'))!.id
        db.setTransactionFields(oneOff, { categoryId: cat('Groceries'), source: 'user' })
      }
    )
    t.diagnostic(within('13 months recomputed', 500, r))
    assert.ok(r.ratio <= budgetRatio(500), within('13 months recomputed', 500, r))
  })

  test('on the large ledger a month recomputes in a background run with the event loop free between months', async (t) => {
    db.closeDb()
    db.openDb(':memory:')
    largeLedger()
    await closeDueMonths()
    await checkClosed()
    // A category renamed: every month is recomputed. Twelve of them, timed, as a run cut short by its limit.
    const coffee = db.listCategories().find((c) => c.name === 'Coffee')!
    db.saveCategory({ ...coffee, name: 'Coffee & Tea' })
    let longest = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    let run: Awaited<ReturnType<typeof checkClosed>> | null = null
    const ms = await busyOf(async () => (run = await checkClosed({ limit: 12 })))
    clearInterval(timer)
    t.diagnostic(`12 of 60 months recomputed: ${(ms / 12).toFixed(0)} busy ms a month (95 months: ${((ms / 12) * 95 / 1000).toFixed(1)} s); the event loop held at most ${longest.toFixed(0)} ms`)
    assert.deepEqual([run!.checked.length, run!.left, run!.changed.length], [12, 48, 0])
  })
})

describe('every write path', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('no write changes a closed month without it showing as changed or re-closed', async () => {
    const h = hh.household()
    await closeDueMonths()
    await checkClosed()
    const find = (description: string, month: string): string => db.all<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE description = ? ORDER BY posted', description).find((r) => db.dayKey(r.posted).startsWith(month))!.id
    const writes: Array<[string, () => unknown]> = [
      ['a category on the Transactions page', () => onPage('updateTransaction', find('FRESHWAY MARKET', '2026-06'), { categoryId: cat('Dining Out') })],
      ['a venture on the Transactions page', () => onPage('updateTransaction', find('SHELL OIL 4410', '2026-05'), { bucketId: h.venture })],
      ['one-time', () => onPage('setOneTime', [find('CORNER BISTRO', '2026-04')], true)],
      ['a split', () => onPage('splitTransaction', find('FRESHWAY MARKET', '2026-03'), [{ amountCents: -10_000, categoryId: cat('Groceries') }, { amountCents: -5_000, categoryId: cat('Shopping') }])],
      ['a delete', () => onPage('deleteTransaction', find('TUNEWAVE MUSIC', '2026-02'))],
      ['Review categorizing', () => runTool('categorize', { transaction_ids: [find('DAILY GRIND CAFE', '2026-01')], category: 'Groceries' }, 'assistant')],
      ['a rule', () => runTool('create_rule', { field: 'contains', pattern: 'CLOUDBOX', category: 'Shopping' }, 'assistant')],
      ['a balance', () => onPage('setBalancePoint', hh.ACCOUNTS.savings, '2025-12-31', 1_000_000)],
      ['an account closed', () => onPage('updateAccount', hh.ACCOUNTS.hsa, { closedDay: '2025-11-30' })],
      ['a paystub', () => hh.stub('2025-11-15')],
      ['a tax year', () => runTool('set_tax_year', { year: 2025, status: 'filed', refund: -500 }, 'assistant')],
      ['a trip', () => db.setSetting('budget.trips', JSON.stringify([{ id: 'tr1', name: 'Coast', from: '2026-07-04', to: '2026-07-10' }]))],
      ['a sync', () => db.upsertTransaction({ id: find('HARBOR POWER CO', '2026-09'), accountId: hh.ACCOUNTS.checking, posted: noonOn(2026, 9, 12), amountCents: -30_000, description: 'HARBOR POWER CO', pending: false })]
    ]
    for (const [name, write] of writes) {
      await write()
      const run = await checkClosed()
      assert.deepEqual(run.failed, [], name)
      noSilentChange(name)
    }
    assert.ok(changedMonths().length > 0)
    assert.equal(issuesOf('month_changed').length, 1)
    showsWhatMoved('every write')
  })
})

describe('a month whose changes over 3 months alone moved', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** May 15's paystub with 16.00 more federal tax than section 5's, and `gross` and `net` as given. */
  const mayStub = (gross: number, net: number): unknown =>
    runTool(
      'record_paystub',
      {
        paycheck_key: hh.KEY,
        pay_day: '2026-05-15',
        gross,
        items: [
          { kind: 'federal', amount: 364 },
          { kind: 'social_security', amount: 186 },
          { kind: 'medicare', amount: 43.5 },
          { kind: 'state', amount: 138 },
          { kind: 'medical', name: 'Medical', amount: 96, employer: 205 },
          { kind: '401k', name: 'Brightline 401(k)', amount: 240, employer: 120 },
          { kind: 'hsa', name: 'Brightline HSA', amount: 60, employer: 24 }
        ],
        net
      },
      'assistant'
    )
  const closedLines = (m: string, open: Opened = null): string[][] =>
    view
      .homeTable(getWaterfall({ from: m, to: m }), open)
      .lines.flatMap((l) => (l.kind === 'closed' ? [[l.name, l.now, l.closed, l.change]] : []))

  test("May 15's stub with 16.00 more federal tax and its deposit as it was: May to July's run rates move, and August to October change in their changes over 3 months alone, each showing them on Home", async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    // The check's net is 1,872.50 against its 1,888.50 deposit: Taxes 16.00 more and a Payroll difference of +16.00.
    // A run rate whose window holds the check (May's, June's and July's) reads it once in its 6 checks, 16.00 × 24 /
    // 72 = 5.33 on Taxes and on the Payroll difference, so Take-home's is as it closed.
    mayStub(3000, 1872.5)
    const run = await checkClosed()
    assert.deepEqual(months(run.changed), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    assert.equal(batches().length, 1)
    const stage = (m: string, id: StageId): Record<string, unknown> => diffSnapshot(m)!.byStage.find((s) => s.id === id)! as unknown as Record<string, unknown>
    const pick = (s: Record<string, unknown>, ...keys: string[]): unknown[] => keys.map((k) => s[k])
    assert.deepEqual(pick(stage('2026-05', 'taxes'), 'closedCents', 'nowCents', 'closedRunRateCents', 'nowRunRateCents'), [143_100, 144_700, 143_100, 143_633])
    assert.deepEqual(pick(stage('2026-05', 'payrollDiff'), 'closedCents', 'nowCents', 'closedRunRateCents', 'nowRunRateCents'), [0, 1_600, 0, 533])
    assert.deepEqual(pick(stage('2026-05', 'takeHome'), 'closedRunRateCents', 'nowRunRateCents'), [377_700, 377_700])
    // August to October: no line and no figure of their own moved, and their run rates are as they closed. Their run
    // rates 3 months before (May's to July's) hold the 5.33: Taxes' change over 3 months is 0 less 5.33, and its rate
    // 23.85% (143,100 of 600,000) against 23.94%, -0.09 points; and the Payroll difference row is there for its own,
    // 0 against 5.33 (0.09% of Gross pay), which the rows digest reads.
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      const d = diffSnapshot(m)!
      assert.deepEqual([d.lines, d.inputs.map((i) => [i.kind, i.ref, i.cause])], [[], [['paystub', `${hh.KEY} 2026-05-15`, 'ai']]], m)
      for (const s of d.byStage) assert.deepEqual(pick(s as unknown as Record<string, unknown>, 'closedCents', 'closedRunRateCents', 'closedRate', 'closedBasis'), pick(s as unknown as Record<string, unknown>, 'nowCents', 'nowRunRateCents', 'nowRate', 'nowBasis'), `${m} ${s.id}`)
      assert.deepEqual(
        d.byStage.filter((s) => s.closedChangeCents !== s.nowChangeCents || s.closedRateChangePts !== s.nowRateChangePts).map((s) => [s.id, s.closedChangeCents, s.nowChangeCents, s.closedRateChangePts, s.nowRateChangePts]),
        [
          ['taxes', 0, -533, 0, -0.1],
          ['payrollDiff', 0, -533, null, -0.1]
        ],
        m
      )
      assert.deepEqual([d.identity.filter((t) => t.closedCents !== t.nowCents), d.bridge.filter((t) => t.closedCents !== t.nowCents), d.other], [[], [], []], m)
      assert.notEqual(rowsDigest(monthClose(m).waterfall), latest(m)!.digests.rows, m)
      // Home reads the same figures.
      assert.deepEqual(getWaterfall({ from: m, to: m }).closed, { byStage: d.byStage, identity: d.identity, bridge: d.bridge, other: d.other, lineCounts: [] }, m)
      // Home: Take-home's own figures didn't move, so the rows leading into it show under it; open, each under its own.
      const m5 = `${view.MINUS}0.1 pts`
      const lines = [
        ['Taxes Δ 3 mo', '5', '0', '5'],
        ['Taxes Δ pts', m5, '0.0 pts', m5],
        ['Payroll difference Δ 3 mo', `${view.MINUS}5`, '0', `${view.MINUS}5`],
        ['Payroll difference Δ pts', m5, '—', '']
      ]
      assert.deepEqual(closedLines(m), lines, m)
      assert.deepEqual(closedLines(m, 'takeHome'), lines, m)
      const table = view.homeTable(getWaterfall({ from: m, to: m }), 'takeHome').lines
      const under = (name: string): string | undefined => {
        const at = table.findIndex((l) => l.kind === 'row' && l.name === name)
        const next = table[at + 1]
        return next?.kind === 'closed' ? next.name : undefined
      }
      assert.deepEqual([under('Taxes'), under('Payroll difference')], ['Taxes Δ 3 mo', 'Payroll difference Δ 3 mo'], m)
    }
    noSilentChange('the May stub')
    showsWhatMoved('the May stub')
  })

  test("the same stub with the gross 16.00 more too, so nothing comes between its net and its deposit: August to October's changes over 3 months move with no row or part coming or going, which the rows digest doesn't read, so they stay as they closed", async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    mayStub(3016, 1888.5)
    const run = await checkClosed()
    assert.deepEqual(months(run.changed), ['2026-05', '2026-06', '2026-07'])
    // Gross pay's and Taxes' changes over 3 months move by the 5.33 May's to July's run rates hold, the rates' with them.
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      const frozen = (JSON.parse(db.get<{ rows: string }>('SELECT "rows" FROM month_snapshots WHERE month = ? AND version = 1', m)!.rows) as { rows: Array<{ id: StageId; changeCents: number | null }> }).rows
      const now = monthClose(m).waterfall
      const moved = now.rows.filter((r) => r.changeCents !== frozen.find((x) => x.id === r.id)?.changeCents).map((r) => [r.id, frozen.find((x) => x.id === r.id)?.changeCents, r.changeCents])
      assert.deepEqual(moved, [
        ['gross', 0, -533],
        ['taxes', 0, -533]
      ], m)
      assert.equal(rowsDigest(now), latest(m)!.digests.rows, m)
      assert.equal(latest(m)!.status, 'closed', m)
    }
    noSilentChange('the May stub with its gross')
    showsWhatMoved('the May stub with its gross')
  })
})

describe('a span of months with a changed month in it', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /**
   * That a span's closed figures are its months' closes where they're changed and today's where they aren't: each
   * identity term and each of the bridge's flows the months' sum, net worth at the start the first month's and at the
   * end the last month's; and that Home shows a closed line for a term exactly where it moved.
   */
  function spanShowsWhatMoved(from: string, to: string): Waterfall {
    const at = `${from}..${to}`
    const w = getWaterfall({ from, to })
    assert.ok(w.closed, `${at} has a changed month`)
    const list: string[] = []
    for (let m = from; m <= to; m = shiftMonth(m, 1)) list.push(m)
    const changed = list.filter((m) => latest(m)?.status === 'changed')
    const kept = new Map(
      changed.map((m) => {
        const k = db.get<{ identity: string; bridge: string }>('SELECT identity, bridge FROM month_snapshots WHERE month = ? AND version = ?', m, latest(m)!.version)!
        return [m, { identity: JSON.parse(k.identity) as Record<string, number>, bridge: JSON.parse(k.bridge) as Record<string, number> }]
      })
    )
    const today = new Map(changed.map((m) => [m, monthClose(m).waterfall]))
    const moved = (side: 'identity' | 'bridge', k: string): number => changed.reduce((s, m) => s + kept.get(m)![side][k] - (today.get(m)![side] as unknown as Record<string, number>)[k], 0)
    for (const t of w.closed!.identity) assert.deepEqual([t.closedCents, t.nowCents], [w.identity[t.key] + moved('identity', t.key), w.identity[t.key]], `${at}: ${t.key}`)
    const ends: Record<string, number> = {
      startCents: changed.includes(from) ? kept.get(from)!.bridge.startCents : w.bridge.startCents,
      endCents: changed.includes(to) ? kept.get(to)!.bridge.endCents : w.bridge.endCents
    }
    for (const t of w.closed!.bridge) {
      const now = w.bridge[t.key]
      assert.deepEqual([t.closedCents, t.nowCents], [t.key in ends ? ends[t.key] : now + moved('bridge', t.key), now], `${at}: ${t.key}`)
    }
    // Home: a term's line under Growth or Saved where it moved, and none where it didn't.
    const shown = new Set([null, 'growth', 'saved'].flatMap((open) => view.homeTable(w, open as Opened).lines.flatMap((l) => (l.kind === 'closed' ? [l.key] : []))))
    for (const t of w.closed!.bridge) assert.equal(shown.has(`closed:bridge:${t.key}`), t.closedCents !== t.nowCents, `${at}: ${t.key} shown`)
    for (const t of w.closed!.identity) assert.equal(shown.has(`closed:identity:${t.key}`), t.closedCents !== t.nowCents, `${at}: ${t.key} shown`)
    return w
  }
  const net = (w: Waterfall, key: 'startCents' | 'endCents'): [number, number] => {
    const t = w.closed!.bridge.find((x) => x.key === key)!
    return [t.closedCents, t.nowCents]
  }

  test("June's brokerage statement 500.00 higher changes June and July: over a span, net worth at its start is its first month's and at its end its last month's, and a month between them moves neither", async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    db.setBalancePoint(hh.ACCOUNTS.brokerage, '2026-06-30', db.balancesOn([hh.ACCOUNTS.brokerage], '2026-06-30').get(hh.ACCOUNTS.brokerage)! + 50_000)
    const run = await checkClosed()
    assert.deepEqual(months(run.changed), ['2026-06', '2026-07'])
    // June's and July's Growth move by 500.00 each way, so over a span holding both, nothing in net worth moved.
    for (const [from, to] of [
      ['2026-05', '2026-07'],
      ['2026-06', '2026-08'],
      ['2026-05', '2026-08'],
      ['2026-01', '2026-11'],
      ['2025-12', '2026-11']
    ]) {
      const w = spanShowsWhatMoved(from, to)
      for (const key of ['startCents', 'endCents'] as const) assert.equal(net(w, key)[0], net(w, key)[1], `${from}..${to}: ${key}`)
    }
    // July's start is June's end, which its close had 500.00 lower; and so is the end of a span ending in June.
    const july = spanShowsWhatMoved('2026-07', '2026-09')
    assert.deepEqual([net(july, 'startCents')[1] - net(july, 'startCents')[0], net(july, 'endCents')[1] - net(july, 'endCents')[0]], [50_000, 0])
    const june = spanShowsWhatMoved('2026-04', '2026-06')
    assert.deepEqual([net(june, 'startCents')[1] - net(june, 'startCents')[0], net(june, 'endCents')[1] - net(june, 'endCents')[0]], [0, 50_000])
  })

  test('the savings statement 100.00 higher on Aug 31 changes August and September: a span shows net worth at its start or end only where that moved', async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    db.setBalancePoint(hh.ACCOUNTS.savings, '2026-08-31', db.balancesOn([hh.ACCOUNTS.savings], '2026-08-31').get(hh.ACCOUNTS.savings)! + 10_000)
    const run = await checkClosed()
    assert.deepEqual(months(run.changed).filter((m) => m === '2026-08' || m === '2026-09'), ['2026-08', '2026-09'])
    for (const [from, to] of [
      ['2026-07', '2026-09'],
      ['2026-07', '2026-10'],
      ['2026-01', '2026-11'],
      ['2026-09', '2026-10']
    ]) {
      const w = spanShowsWhatMoved(from, to)
      if (to >= '2026-09' && from <= '2026-08') for (const key of ['startCents', 'endCents'] as const) assert.equal(net(w, key)[0], net(w, key)[1], `${from}..${to}: ${key}`)
    }
  })

  test("deposits only, with a paystub dated Oct 31: a span ending in a month whose close had Take-home standing for Gross pay has no closed Take-home rate, as that month alone hasn't; ending in the open month, it's Take-home's share of Gross pay as the closes had them", async () => {
    hh.household({ paystubs: false })
    await closeDueMonths()
    await checkClosed()
    hh.stub('2026-10-31')
    await checkClosed()
    const rates = (from: string, to: string): [number | null, number | null] => {
      const s = getWaterfall({ from, to }).closed!.byStage.find((x) => x.id === 'takeHome')!
      return [s.closedRate, s.nowRate]
    }
    for (const [from, to] of [
      ['2026-08', '2026-08'],
      ['2026-08', '2026-10'],
      ['2026-01', '2026-10']
    ])
      assert.deepEqual(rates(from, to), [null, 63], `${from}..${to}`)
    // November is open and on estimated pay, so the span's Take-home and Gross pay are two rows on the closed books
    // too: January to October's Gross pay as closed is their Take-home, and November has no pay yet.
    assert.deepEqual(rates('2026-01', '2026-11'), [100, 63])
  })

  test("deposits only, with a paystub dated Oct 31: the month's pay basis, estimated now and deposits as closed, shows once, under Gross pay, in every view of Home", async () => {
    hh.household({ paystubs: false })
    await closeDueMonths()
    await checkClosed()
    hh.stub('2026-10-31')
    await checkClosed()
    for (const [from, to] of [
      ['2026-08', '2026-08'],
      ['2026-08', '2026-10']
    ]) {
      const w = getWaterfall({ from, to })
      // Gross pay, Take-home, Saved and Invested are each on pay, and each moved from deposits to estimated.
      assert.deepEqual(w.closed!.byStage.filter((s) => s.closedBasis !== s.nowBasis).map((s) => s.id), ['gross', 'takeHome', 'saved', 'invested'], `${from}..${to}`)
      for (const open of [null, ...view.MAIN_ROWS] as Opened[]) {
        const lines = view.homeTable(w, open).lines
        const at = lines.flatMap((l, i) => (l.kind === 'closed' && l.key.startsWith('closed:basis:') ? [i] : []))
        assert.equal(at.length, 1, `${from}..${to} ${open}`)
        const l = lines[at[0]] as ClosedLine
        assert.deepEqual([l.name, l.now, l.closed, l.change], ['Pay basis', 'estimated', 'deposits', ''], `${from}..${to} ${open}`)
        const row = lines.slice(0, at[0]).findLast((x) => x.kind === 'row')
        assert.equal(row?.kind === 'row' && row.id, 'gross', `${from}..${to} ${open}`)
      }
    }
  })
})

describe('a month whose lines alone moved', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("September's 150.00 at Freshway Market split by Review into two Groceries parts moves no figure, and Home shows Everyday's lines beside the close's: one more, two come and one gone", async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    const market = db.all<{ id: string; posted: number; amount: number }>("SELECT id, posted, amount_cents AS amount FROM transactions WHERE description = 'FRESHWAY MARKET' ORDER BY posted").find((r) => db.dayKey(r.posted).startsWith('2026-09'))!
    const third = Math.round(market.amount / 3)
    runTool('split_transaction', { transaction_id: market.id, parts: [{ amount_cents: third, category: 'Groceries' }, { amount_cents: market.amount - third, category: 'Groceries' }] }, 'assistant')
    const run = await checkClosed()
    assert.deepEqual(months(run.changed), ['2026-09'])
    const now = monthClose('2026-09')
    assert.equal(rowsDigest(now.waterfall), latest('2026-09')!.digests.rows)
    assert.notEqual(linesDigest(now.lines), latest('2026-09')!.digests.lines)
    const d = diffSnapshot('2026-09')!
    const everyday = now.lines.filter((l) => l.owner === null && l.cls === 'everyday').length
    assert.deepEqual(d.lineCounts, [{ row: 'everyday', term: null, closedCount: everyday - 1, nowCount: everyday, added: 2, removed: 1 }])
    const lines = (open: Opened): string[][] => view.homeTable(getWaterfall({ from: '2026-09', to: '2026-09' }), open).lines.flatMap((l) => (l.kind === 'closed' ? [[l.name, l.now, l.closed, l.change]] : []))
    const want = [['Everyday lines', String(everyday), String(everyday - 1), `+2 ${view.MINUS}1`]]
    // Closed, Left over stands for Everyday; open, the line is under Everyday's row.
    assert.deepEqual(lines(null), want)
    assert.deepEqual(lines('leftOver'), want)
    const table = view.homeTable(getWaterfall({ from: '2026-09', to: '2026-09' }), 'leftOver').lines
    const at = table.findIndex((l) => l.kind === 'closed')
    assert.equal(table.slice(0, at).findLast((l) => l.kind === 'row')?.kind === 'row' && (table.slice(0, at).findLast((l) => l.kind === 'row') as { id: string }).id, 'everyday')
    // Over the year, the same lines beside the year's.
    const year = getWaterfall({ from: '2026-01', to: '2026-11' }).closed!.lineCounts
    assert.deepEqual(year.map((l) => [l.row, l.nowCount - l.closedCount, l.added, l.removed]), [['everyday', 1, 2, 1]])
    showsWhatMoved('the split')
  })
})

describe('closed months the pay change moves', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  const CLINIC = 'Fernhollow Clinic Payroll'
  const KEY = 'fernhollow clinic payroll|+'
  const PART = `pay:${KEY}`
  /** The 15th and the last from June 2026, a weekend's moved to the Friday before. */
  const DAYS = ['2026-06-15', '2026-06-30', '2026-07-15', '2026-07-31', '2026-08-14', '2026-08-31', '2026-09-15', '2026-09-30', '2026-10-15', '2026-10-30']
  type Figures = Partial<Pick<ClosedRow, 'runRateCents' | 'changeCents' | 'rate' | 'rateChangePts'>>
  /**
   * What the engine before the pay change froze where today's engine reads otherwise: every figure
   * that differs, by row and part, its Payroll difference row, which today's has none of, and the cash identity's
   * tolerance, which reads the Take-home run rate. `groceries` is Everyday's part for Groceries.
   */
  const frozenBefore = (groceries: string): Record<string, { rows: Array<[StageId, string | null, Figures]>; payrollDiff: Figures; toleranceCents?: number }> => ({
    // June's and July's run rates read May 29's 700.00 among the checks after it: (700.00 + 2 × 4,940.00) × 24 / (3 ×
    // 12) for Take-home in June, and its 2.00 short of its stub's net, -2.00 × 24 / 36, as the Payroll difference.
    '2026-06': {
      rows: [
        ['gross', null, { runRateCents: 1_266_667, changeCents: 1_266_667 }],
        ['gross', PART, { runRateCents: 966_667, changeCents: 966_667 }],
        ['taxes', null, { runRateCents: 261_200, changeCents: 261_200, rate: 20.6 }],
        ['taxes', PART, { runRateCents: 261_200, changeCents: 261_200, rate: 20.6 }],
        ['takeHome', null, { runRateCents: 1_005_334, changeCents: 1_005_334, rate: 79.4 }],
        ['committed', null, { rate: 11.9 }],
        ['committed', 'series:birchwood apartments|-', { rate: 11.9 }],
        ['elective', null, { runRateCents: 885_334, changeCents: 885_334, rate: 88.1 }],
        ['everyday', null, { rate: 3.0 }],
        ['everyday', groceries, { rate: 3.0 }],
        ['leftOver', null, { runRateCents: 858_667, changeCents: 858_667, rate: 97.0 }],
        ['saved', null, { runRateCents: 858_667, changeCents: 858_667, rate: 67.8 }],
        ['saved', 'kept', { runRateCents: 858_667, changeCents: 858_667, rate: 67.8 }]
      ],
      payrollDiff: { runRateCents: -133, changeCents: -133, rateChangePts: null },
      toleranceCents: 5_027
    },
    '2026-07': {
      rows: [
        ['gross', null, { runRateCents: 1_424_000, changeCents: 1_424_000 }],
        ['gross', PART, { runRateCents: 1_124_000, changeCents: 1_124_000 }],
        ['taxes', null, { runRateCents: 305_520, changeCents: 305_520, rate: 21.5 }],
        ['taxes', PART, { runRateCents: 305_520, changeCents: 305_520, rate: 21.5 }],
        ['takeHome', null, { runRateCents: 1_118_400, changeCents: 1_118_400, rate: 78.5 }],
        ['committed', null, { rate: 10.7 }],
        ['committed', 'series:birchwood apartments|-', { rate: 10.7 }],
        ['elective', null, { runRateCents: 998_400, changeCents: 998_400, rate: 89.3 }],
        ['everyday', null, { rate: 4.0 }],
        ['everyday', groceries, { rate: 4.0 }],
        ['leftOver', null, { runRateCents: 958_400, changeCents: 958_400, rate: 96.0 }],
        ['saved', null, { runRateCents: 958_400, changeCents: 958_400, rate: 67.3 }],
        ['saved', 'kept', { runRateCents: 958_400, changeCents: 958_400, rate: 67.3 }]
      ],
      payrollDiff: { runRateCents: -80, changeCents: -80, rateChangePts: null },
      toleranceCents: 5_592
    },
    // September's and October's own figures are the same; their changes over 3 months read June's and July's, and
    // the Payroll difference row is there only for its change over 3 months.
    '2026-09': {
      rows: [
        ['gross', null, { changeCents: 393_333 }],
        ['gross', PART, { changeCents: 393_333 }],
        ['taxes', null, { changeCents: 110_800, rateChangePts: 1.8 }],
        ['taxes', PART, { changeCents: 110_800 }],
        ['takeHome', null, { changeCents: 282_666, rateChangePts: -1.8 }],
        ['committed', null, { rateChangePts: -2.6 }],
        ['elective', null, { changeCents: 282_666, rateChangePts: 2.6 }],
        ['everyday', null, { rateChangePts: 0.4 }],
        ['leftOver', null, { changeCents: 269_333, rateChangePts: -0.4 }],
        ['saved', null, { changeCents: 269_333, rateChangePts: 0.2 }],
        ['saved', 'kept', { changeCents: 269_333 }]
      ],
      payrollDiff: { runRateCents: 0, changeCents: 133, rateChangePts: 0 }
    },
    '2026-10': {
      rows: [
        ['gross', null, { changeCents: 236_000 }],
        ['gross', PART, { changeCents: 236_000 }],
        ['taxes', null, { changeCents: 66_480, rateChangePts: 1.0 }],
        ['taxes', PART, { changeCents: 66_480 }],
        ['takeHome', null, { changeCents: 169_600, rateChangePts: -0.9 }],
        ['committed', null, { rateChangePts: -1.4 }],
        ['elective', null, { changeCents: 169_600, rateChangePts: 1.4 }],
        ['everyday', null, { rateChangePts: -0.6 }],
        ['leftOver', null, { changeCents: 169_600, rateChangePts: 0.6 }],
        ['saved', null, { changeCents: 169_600, rateChangePts: 0.6 }],
        ['saved', 'kept', { changeCents: 169_600 }]
      ],
      payrollDiff: { runRateCents: 0, changeCents: 80, rateChangePts: 0 }
    }
  })
  const closedLines = (m: string, open: Opened = null): string[][] =>
    view
      .homeTable(getWaterfall({ from: m, to: m }), open)
      .lines.flatMap((l) => (l.kind === 'closed' ? [[l.name, l.now, l.closed, l.change]] : []))

  test("a new job's first check paying part of a period, now in no run rate: June and July closed with it show their run rates beside today's, and September and October their changes over 3 months alone, each on Home and in its diff, as one engine batch", async () => {
    // The small books, and a job on the 15th and the last whose first check, May 29, 2026, paid 700.00 for part of a
    // period. Each check has its stub: 6,800.00 gross and 1,860.00 of taxes, and May 29's 900.00 and 198.00, whose
    // net of 702.00 is 2.00 more than its deposit.
    books([['2026-05-29', 70_000, CLINIC, 'Paycheck'], ...DAYS.map((d): [string, number, string, string] => [d, 494_000, CLINIC, 'Paycheck'])])
    savePaystub({ paycheckKey: KEY, payDay: '2026-05-29', grossCents: 90_000, items: [{ kind: 'federal', cents: 12_920 }, { kind: 'social_security', cents: 5_580 }, { kind: 'medicare', cents: 1_300 }] })
    for (const d of DAYS) savePaystub({ paycheckKey: KEY, payDay: d, grossCents: 680_000, items: [{ kind: 'federal', cents: 124_300 }, { kind: 'social_security', cents: 42_160 }, { kind: 'medicare', cents: 9_860 }, { kind: 'state', cents: 9_680 }] })
    await closeDueMonths()
    assert.deepEqual([...new Set(listSnapshots(1000).map((s) => s.month))].sort(), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    // The closes as the engine before the pay change froze them, before a check kept its state or the stamp's parts.
    // ENGINE_VERSION 2 was never released, so every close made before it is version 1's: their version and inputs stamp are
    // version 1's, and a check recomputes every month.
    db.run("UPDATE month_snapshots SET engine_version = ?, inputs_stamp = 'version 1'", ENGINE_VERSION - 1)
    db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%' OR key LIKE 'snapshots.stamp:%' OR key = 'snapshots.sweep'")
    const before = frozenBefore(`cat:${cat('Groceries')}`)
    for (const r of db.all<{ month: string; rows: string; identity: string; bridge: string; digest: string }>('SELECT month, "rows", identity, bridge, rows_digest AS digest FROM month_snapshots')) {
      const frozen = JSON.parse(r.rows) as { rows: ClosedRow[]; series?: string; raw?: unknown }
      delete frozen.series
      delete frozen.raw
      const { toleranceCents, ...terms } = JSON.parse(r.identity) as Record<string, number>
      const digest = (): string => rowsDigest({ rows: frozen.rows, identity: terms, bridge: JSON.parse(r.bridge) } as unknown as Waterfall)
      // A close's rows digest reads its frozen rows, its identity's terms and its bridge.
      assert.equal(digest(), r.digest, r.month)
      const was = before[r.month]
      if (was) {
        for (const [id, part, figures] of was.rows) {
          const row = frozen.rows.find((x) => x.id === id)!
          Object.assign(part === null ? row : row.parts.find((p) => p.key === part)!, figures)
        }
        const diff = { actualCents: 0, runRateCents: 0, changeCents: null, rate: 0, rateChangePts: null, ...was.payrollDiff }
        const row = { id: 'payrollDiff', ...diff, rateFrom: 'gross', basis: 'deposits', parts: [{ key: PART, name: CLINIC, actualCents: 0, runRateCents: diff.runRateCents, changeCents: diff.changeCents, rate: 0 }] }
        frozen.rows.splice(frozen.rows.findIndex((x) => x.id === 'takeHome'), 0, row as ClosedRow)
      }
      db.run('UPDATE month_snapshots SET "rows" = ?, identity = ?, rows_digest = ? WHERE month = ?', JSON.stringify(frozen), JSON.stringify({ ...terms, toleranceCents: was?.toleranceCents ?? toleranceCents }), digest(), r.month)
    }

    const run = await checkClosed()
    assert.equal(run.checked.length, 6)
    // May's and August's figures are as they closed: May's run rates read May 29 as the payroll's one check, and
    // August's window begins after it. The others moved with nothing written, so the new engine is the cause, in one
    // batch.
    const engine = ['engine', `engine:${ENGINE_VERSION}`, `The engine's version ${ENGINE_VERSION}`]
    assert.deepEqual([run.changed.map((c) => [c.month, c.cause, c.batch, c.label]), run.reclosed], [['2026-06', '2026-07', '2026-09', '2026-10'].map((m) => [m, ...engine]), []])
    assert.deepEqual([batches(), issuesOf('month_changed').length], [[`engine:${ENGINE_VERSION}`], 1])
    const pick = (m: string, id: StageId, ...keys: string[]): unknown[] => {
      const s = diffSnapshot(m)!.byStage.find((x) => x.id === id)! as unknown as Record<string, unknown>
      return keys.map((k) => s[k])
    }
    // June and July: today's run rates leave May 29 out, the run's first check, 14% of the checks after it.
    assert.deepEqual(pick('2026-06', 'takeHome', 'closedRunRateCents', 'nowRunRateCents'), [1_005_334, 1_288_000])
    assert.deepEqual(pick('2026-07', 'takeHome', 'closedRunRateCents', 'nowRunRateCents'), [1_118_400, 1_288_000])
    assert.deepEqual(pick('2026-06', 'payrollDiff', 'closedRunRateCents', 'nowRunRateCents'), [-133, 0])
    // September and October: every row's amount, run rate, rate and pay basis as closed, and Δ 3 mo and Δ pts alone
    // moved, which the diff puts down to the nearest earlier month changed with them.
    for (const [m, from] of [
      ['2026-09', '2026-07'],
      ['2026-10', '2026-09']
    ]) {
      const d = diffSnapshot(m)!
      const moved = (list: Array<{ closedCents: number; nowCents: number }>): unknown[] => list.filter((t) => t.closedCents !== t.nowCents)
      assert.deepEqual([d.lines, d.inputs.map((i) => [i.kind, i.ref, i.cause]), d.lineCounts, moved(d.identity), moved(d.bridge)], [[], [['earlierMonth', from, 'engine']], [], [], []], m)
      for (const s of d.byStage) assert.deepEqual(pick(m, s.id, 'closedCents', 'closedRunRateCents', 'closedRate', 'closedBasis'), pick(m, s.id, 'nowCents', 'nowRunRateCents', 'nowRate', 'nowBasis'), `${m} ${s.id}`)
      const changes = d.byStage.filter((s) => s.closedChangeCents !== s.nowChangeCents || s.closedRateChangePts !== s.nowRateChangePts).map((s) => s.id)
      assert.deepEqual(changes, ['gross', 'taxes', 'payrollDiff', 'takeHome', 'committed', 'elective', 'everyday', 'leftOver', 'saved'], m)
    }
    const m = view.MINUS
    assert.deepEqual(closedLines('2026-09'), [
      ['Gross pay Δ 3 mo', '0', '3,933', `${m}3,933`],
      ['Take-home Δ 3 mo', '0', '2,827', `${m}2,827`],
      ['Take-home Δ pts', '0.0 pts', `${m}1.8 pts`, '+1.8 pts'],
      ['Elective Δ 3 mo', '0', '2,827', `${m}2,827`],
      ['Elective Δ pts', '0.0 pts', '+2.6 pts', `${m}2.6 pts`],
      ['Left over Δ 3 mo', `${m}133.33`, '2,693.33', `${m}2,826.66`],
      ['Left over Δ pts', `${m}1.1 pts`, `${m}0.4 pts`, `${m}0.7 pts`],
      ['Saved Δ 3 mo', `${m}133.33`, '2,693.33', `${m}2,826.66`],
      ['Saved Δ pts', `${m}0.8 pts`, '+0.2 pts', `${m}1.0 pts`]
    ])
    // Take-home open: the Payroll difference row the close had, there for its change over 3 months alone.
    assert.deepEqual(closedLines('2026-09', 'takeHome').filter(([name]) => name.startsWith('Payroll difference')), [
      ['Payroll difference Δ 3 mo', '0', '1', `${m}1`],
      ['Payroll difference Δ pts', '—', '0.0 pts', '']
    ])
    noSilentChange('the pay change')
    showsWhatMoved('the pay change')

    // Review keeps the new figures: every month is closed again, and the next check finds nothing.
    runTool('accept_close_changes', {}, 'assistant')
    assert.deepEqual([changedMonths(), issuesOf('month_changed')], [[], []])
    assert.deepEqual((await checkClosed()).changed, [])
    noSilentChange('after Review kept them')
  })
})
