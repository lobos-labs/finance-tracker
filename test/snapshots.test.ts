import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { bulkBackup } from '../src/main/backup.ts'
import { loadDemoData, clearDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { restoreExport } from '../src/main/ledgerImport.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, firstLedgerDay } from '../src/main/lines.ts'
import { savePaystub } from '../src/main/paystubs.ts'
import { setTaxYear } from '../src/main/taxes.ts'
import { backfillSnapshots, balancesDigest, closeDueMonths, closeMonth, inputsStamp, linesDigest, listSnapshots, nextCloseDay, rawDigest, rowsDigest } from '../src/main/snapshots.ts'
import { DatabaseSync } from '../src/main/sqlite.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { getWaterfall, monthClose } from '../src/main/waterfall.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { MonthSnapshot, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { largeLedger } from './fixtures/large-ledger.ts'
import { ACCOUNTS, MONTHS, TODAY, line, stub, tieOut, type TieOut } from './fixtures/tieout.ts'

// Closing a month (spec 2, sub-phase 1h): when a past month closes, what it freezes, and that every version is kept.
// Section 2's tie-out is the household for when: its October is 40.00 short on Checking, above its 20.00 tolerance.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
const nov = (day: number): number => noonOn(2026, 11, day)
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
/** A month's latest close. */
const latest = (month: string): MonthSnapshot | undefined => listSnapshots(1000).find((s) => s.month === month)
const versions = (month: string): MonthSnapshot[] => listSnapshots(1000).filter((s) => s.month === month)
const items = (s: MonthSnapshot, kind: string): MonthSnapshot['leaks'] => s.leaks.filter((x) => x.kind === kind)
const BEFORE_OCTOBER = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']

describe('when a month closes', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('October waits for Nov 3, and for a balance after Oct 31 on every bank-fed perimeter account; with the Visa last reporting on Oct 28 it closes on Nov 15, with late_sync and month_end_unbracketed for the Visa', async () => {
    tieOut({ fed: true, visaReported: '2026-10-28' })
    // The first close of the books is a backfill of every past month that's due: May to September, not October.
    const first = await closeDueMonths(nov(2))
    assert.deepEqual(
      first.closed.map((c) => [c.month, c.version, c.origin]),
      BEFORE_OCTOBER.map((m) => [m, 1, 'backfill'])
    )
    assert.equal(latest('2026-10'), undefined)
    // From Nov 3 its day has come, but the Visa's feed hasn't reported since Oct 28.
    for (const day of [3, 4, 10, 14]) assert.deepEqual((await closeDueMonths(nov(day))).closed, [], `Nov ${day}`)
    // The 15th closes it anyway.
    const forced = await closeDueMonths(nov(15))
    assert.deepEqual(forced.closed, [{ month: '2026-10', version: 1, status: 'gap', origin: 'auto' }])
    const s = latest('2026-10')!
    assert.deepEqual(items(s, 'late_sync'), [{ kind: 'late_sync', cents: 0, accountId: ACCOUNTS.visa }])
    // The Visa's month-end balance is carried on from Oct 28, the last it reported.
    assert.deepEqual(items(s, 'month_end_unbracketed'), [{ kind: 'month_end_unbracketed', cents: -158_000, accountId: ACCOUNTS.visa, fromDay: '2026-10-28' }])
    const visa = db.get<{ source: string; end_cents: number }>("SELECT source, end_cents FROM snapshot_balances WHERE month = '2026-10' AND account_id = ?", ACCOUNTS.visa)
    assert.deepEqual(visa, { source: 'unbracketed', end_cents: -158_000 })
    // Nothing more is due, and a run closes nothing twice.
    assert.deepEqual((await closeDueMonths(nov(16))).closed, [])
    assert.equal(versions('2026-10').length, 1)
  })

  test("once the Visa's feed reports after Oct 31, October closes that day with neither item", async () => {
    tieOut({ fed: true, visaReported: '2026-10-28' })
    await closeDueMonths(nov(3))
    assert.equal(latest('2026-10'), undefined)
    db.upsertAccount({ id: ACCOUNTS.visa, source: 'simplefin', name: 'Visa', institution: null, currency: 'USD', balanceCents: -158_000, availableCents: null, balanceDate: nov(4) })
    assert.deepEqual((await closeDueMonths(nov(4))).closed, [{ month: '2026-10', version: 1, status: 'gap', origin: 'auto' }])
    const s = latest('2026-10')!
    assert.deepEqual([items(s, 'late_sync'), items(s, 'month_end_unbracketed')], [[], []])
    assert.equal(db.get<{ source: string }>("SELECT source FROM snapshot_balances WHERE month = '2026-10' AND account_id = ?", ACCOUNTS.visa)?.source, 'walked')
  })

  test('with every feed reported, October waits only for its day: not on Nov 2, on Nov 3', async () => {
    tieOut({ fed: true })
    await closeDueMonths(nov(2))
    assert.equal(latest('2026-10'), undefined)
    assert.deepEqual((await closeDueMonths(nov(3))).closed.map((c) => c.month), ['2026-10'])
    assert.deepEqual(latest('2026-10')!.leaks.map((x) => x.kind), ['balance_gap'])
  })

  test('a line still pending in October holds it back until the 15th, which closes it with a late_sync naming the line', async () => {
    tieOut({ fed: true })
    await closeDueMonths(nov(2))
    const [y, m, d] = [2026, 10, 30]
    db.upsertTransaction({ id: 'pending-coffee', accountId: ACCOUNTS.visa, posted: noonOn(y, m, d), amountCents: -650, description: 'CORNER CAFE', pending: true })
    assert.deepEqual((await closeDueMonths(nov(3))).closed, [])
    assert.deepEqual((await closeDueMonths(nov(15))).closed.map((c) => c.month), ['2026-10'])
    assert.deepEqual(items(latest('2026-10')!, 'late_sync'), [{ kind: 'late_sync', cents: -650, accountId: ACCOUNTS.visa, txnIds: ['pending-coffee'] }])
  })

  test("a venture's own charge still pending on its card holds nothing back; a pending line there placed in Personal does", async () => {
    tieOut({ fed: true })
    await closeDueMonths(nov(2))
    db.upsertTransaction({ id: 'pending-supplies', accountId: ACCOUNTS.wrenCard, posted: noonOn(2026, 10, 30), amountCents: -4_500, description: 'HARDWARE DEPOT', pending: true })
    db.upsertTransaction({ id: 'pending-lunch', accountId: ACCOUNTS.wrenCard, posted: noonOn(2026, 10, 30), amountCents: -1_800, description: 'CORNER BISTRO', pending: true })
    db.setTransactionsBucket(['pending-lunch'], null)
    assert.deepEqual((await closeDueMonths(nov(3))).closed, [])
    db.deleteTransaction('pending-lunch')
    assert.deepEqual((await closeDueMonths(nov(3))).closed.map((c) => c.month), ['2026-10'])
    assert.deepEqual(items(latest('2026-10')!, 'late_sync'), [])
  })

  test('a bank-fed account closed during October holds nothing back: its month-end balance is known, the nothing it holds from its closing', async () => {
    tieOut({ fed: true })
    db.upsertAccount({ id: 'simplefin:old', source: 'simplefin', name: 'Old Checking', institution: null, currency: 'USD', balanceCents: 0, availableCents: null, balanceDate: noonOn(2026, 10, 10) })
    db.updateAccount('simplefin:old', { assetType: 'cash', closedDay: '2026-10-10' })
    const run = await closeDueMonths(nov(3))
    assert.deepEqual(run.closed.map((c) => c.month).at(-1), '2026-10')
    const s = latest('2026-10')!
    assert.deepEqual([items(s, 'month_end_unbracketed'), items(s, 'late_sync')], [[], []])
    assert.deepEqual(db.get("SELECT end_cents AS cents, source FROM snapshot_balances WHERE month = '2026-10' AND account_id = 'simplefin:old'"), { cents: 0, source: 'closed' })
  })

  test('a run tries at most its limit of months: when every close fails, the rest wait for the next run', async () => {
    tieOut()
    db.run("CREATE TRIGGER no_room BEFORE INSERT ON month_snapshots BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END")
    const run = await closeDueMonths(nov(7), { limit: 2 })
    assert.deepEqual([run.closed, run.failed.map((f) => f.month), run.left], [[], ['2026-05', '2026-06'], 4])
    db.run('DROP TRIGGER no_room')
    assert.equal((await closeDueMonths(nov(7))).closed.length, 6)
  })

  test("Review closing a month first leaves the books' first run a backfill of every month due, the last full one too", async () => {
    tieOut({ fed: true })
    runTool('close_month', { month: '2026-09' }, 'assistant')
    const run = await closeDueMonths(nov(7))
    assert.deepEqual(
      run.closed.map((c) => [c.month, c.origin]),
      ['2026-05', '2026-06', '2026-07', '2026-08', '2026-10'].map((m) => [m, 'backfill'])
    )
    assert.equal(latest('2026-09')!.origin, 'review')
  })

  test('close.earliestDay and close.forceDay move the days', async () => {
    tieOut({ fed: true, visaReported: '2026-10-28' })
    // The days a month can fall due on, which a hosted ledger with no bank wakes for: the 3rd and the 15th.
    assert.deepEqual(['2026-11-02', '2026-11-03', '2026-11-15', '2026-12-31'].map((d) => nextCloseDay(d)), ['2026-11-03', '2026-11-15', '2026-12-03', '2027-01-03'])
    db.setSetting('close.earliestDay', '5')
    db.setSetting('close.forceDay', '10')
    assert.equal(nextCloseDay('2026-11-07'), '2026-11-10')
    await closeDueMonths(nov(9))
    assert.equal(latest('2026-10'), undefined)
    assert.deepEqual((await closeDueMonths(nov(10))).closed.map((c) => c.month), ['2026-10'])
  })

  test('the current month never closes, and Review can close a month sooner or again', () => {
    tieOut({ fed: true, visaReported: '2026-10-28' })
    assert.throws(() => closeMonth('2026-11', 'review', nov(7)), /hasn't ended/)
    assert.throws(() => closeMonth('2026-12', 'review', nov(7)), /hasn't ended/)
    assert.throws(() => closeMonth('2026-04', 'review', nov(7)), /start in 2026-05/)
    // On Nov 7 October isn't due, but close_month closes it: version 1, then version 2.
    const r = runTool('close_month', { month: '2026-10' }, 'assistant')
    assert.deepEqual([(r.result as { version: number }).version, (r.result as { status: string }).status], [1, 'gap'])
    assert.equal((r.result as { unexplained: number }).unexplained, 40)
    runTool('close_month', { month: '2026-10' }, 'assistant')
    assert.deepEqual(versions('2026-10').map((s) => [s.version, s.origin]), [
      [2, 'review'],
      [1, 'review']
    ])
  })
})

describe("a month's status", () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a month with |Unexplained| above the tolerance closes with status gap, and one within it closed', async () => {
    const run = await closeDueMonths(nov(7))
    assert.deepEqual(
      run.closed.map((c) => [c.month, c.status]),
      [...BEFORE_OCTOBER.map((m) => [m, 'closed']), ['2026-10', 'gap']]
    )
    const october = latest('2026-10')!
    // Unexplained is 40.00 against a tolerance of 20.00 (0.5% of a Take-home run rate of 4,000.00).
    assert.deepEqual([october.unexplainedCents, october.toleranceCents], [4_000, 2_000])
    assert.deepEqual(items(october, 'balance_gap'), [{ kind: 'balance_gap', cents: 4_000, accountId: ACCOUNTS.checking, fromDay: '2026-09-30', toDay: '2026-10-31' }])
    // Checking's gap is the statement less what the lines give: -40.00.
    assert.deepEqual(db.all("SELECT account_id AS id, start_cents AS start, end_cents AS end, gap_cents AS gap FROM snapshot_balances WHERE month = '2026-10' ORDER BY account_id"), [
      { id: ACCOUNTS.checking, start: 300_000, end: 311_000, gap: -4_000 },
      { id: ACCOUNTS.savings, start: 1_000_000, end: 1_002_000, gap: 0 },
      { id: ACCOUNTS.visa, start: -120_000, end: -158_000, gap: 0 }
    ])
  })

  test("the waterfall reads the closes: each month's status and origin, the span's marker and a month's version", () => {
    const october: Waterfall = getWaterfall({ from: '2026-10', to: '2026-10' })
    // The month Home marks as a gap gives the close's Unexplained and tolerance beside its status, and its bridge, a
    // span of one month's own; it hasn't changed since its close, so there is no closed bridge beside it.
    assert.deepEqual([october.status, october.version, october.months], ['gap', 1, [{ month: '2026-10', status: 'gap', origin: 'backfill', unexplainedCents: 4_000, toleranceCents: 2_000, bridge: october.bridge, closedBridge: null }]])
    const summer = getWaterfall({ from: '2026-06', to: '2026-08' })
    assert.deepEqual([summer.status, summer.version], ['closed', null])
    // A span into the open month is open, unless a month in it has a gap.
    assert.equal(getWaterfall({ from: '2026-11', to: '2026-11' }).status, 'open')
    assert.equal(getWaterfall({ from: '2026-09', to: '2026-11' }).status, 'gap')
    assert.deepEqual(
      getWaterfall({ from: '2026-09', to: '2026-11' }).months.map((m) => [m.month, m.status]),
      [
        ['2026-09', 'closed'],
        ['2026-10', 'gap'],
        ['2026-11', 'open']
      ]
    )
    // The sparkline's points carry their months' statuses too: April has no books.
    const trend = october.rows.find((r) => r.id === 'takeHome')!.trend
    assert.deepEqual(
      trend.slice(-7).map((p) => [p.month, p.status]),
      [['2026-04', 'open'], ...BEFORE_OCTOBER.map((m) => [m, 'closed']), ['2026-10', 'gap']]
    )
  })
})

describe('a closed month as time passes', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a year on, with nothing changed, every closed month's rows, lines and balances are what was frozen: Finch's checks are 24 a year after its series has left the window", async () => {
    await closeDueMonths(nov(7))
    mock.timers.setTime(noonOn(2027, 12, 10) * 1000)
    const closes = listSnapshots(1000)
    assert.equal(closes.length, 6)
    for (const s of closes) {
      const c = monthClose(s.month)
      assert.deepEqual([rowsDigest(c.waterfall), linesDigest(c.lines), balancesDigest(c.balances), c.waterfall.toleranceCents], [s.digests.rows, s.digests.lines, s.digests.balances, s.toleranceCents], s.month)
    }
    assert.equal(monthClose('2026-08').waterfall.rows.find((r) => r.id === 'gross')!.runRateCents, 560_000)
  })
})

describe('a backfill of 24 months', () => {
  // A checking account two years long: pay of 3,000.00 on the 1st, rent of 1,200.00 on the 2nd and 400.00 of groceries
  // on the 10th each month, and a statement at each month's end. In five months 150.00 left the account with no line
  // for it, so the statements from then on are 150.00 lower: those months are 150.00 short and the rest tie. The
  // tolerance is 15.00, 0.5% of a Take-home run rate of 3,000.00.
  const GAPS = ['2025-01', '2025-06', '2026-02', '2026-05', '2026-08']
  const MONTHS = Array.from({ length: 24 }, (_, i) => shiftMonth('2024-10', i))
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 10, 20) * 1000 })
    db.openDb(':memory:')
    const cat = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
    let n = 0
    const add = (day: string, cents: number, description: string, category: string, merchant: string): void => {
      const [y, m, d] = day.split('-').map(Number)
      const id = `g${++n}`
      db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
      db.setTransactionFields(id, { categoryId: cat(category), source: 'user', merchant })
    }
    let balance = 500_000
    const ends: Array<[string, number]> = [['2024-09-30', balance]]
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    db.inTransaction(() => {
      for (const m of MONTHS) {
        add(`${m}-01`, 300_000, 'GALE PAYROLL', 'Paycheck', 'Gale Payroll')
        add(`${m}-02`, -120_000, 'BIRCHWOOD APARTMENTS', 'Housing', 'Birchwood Apartments')
        add(`${m}-10`, -40_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
        balance += 300_000 - 120_000 - 40_000 - (GAPS.includes(m) ? 15_000 : 0)
        ends.push([lastDay(m), balance])
      }
    })
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: balance, availableCents: null, balanceDate: noonOn(2026, 10, 20) })
    for (const [day, cents] of ends) db.setBalancePoint('csv:chk', day, cents)
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('closes every month as version 1 with origin backfill, and its 5 gap months raise one month_gap issue', async () => {
    const run = await backfillSnapshots()
    assert.deepEqual(
      run.closed.map((c) => [c.month, c.version, c.origin, c.status]),
      MONTHS.map((m) => [m, 1, 'backfill', GAPS.includes(m) ? 'gap' : 'closed'])
    )
    assert.deepEqual(run.failed, [])
    const august = latest('2026-08')!
    assert.deepEqual([august.unexplainedCents, august.toleranceCents], [15_000, 1_500])
    const issues = openIssues().filter((i) => i.kind === 'month_gap')
    assert.equal(issues.length, 1)
    const [issue] = issues
    assert.equal(issue.key, 'month_gap:2026-08:5')
    // The newest three with their items, and a count of the rest.
    assert.match(issue.summary, /^5 closed months have cash that doesn't tie: 2026-08: Unexplained \$150\.00 against a tolerance of \$15\.00 \(balance_gap Checking \$150\.00 \(2026-07-31 to 2026-08-31\)\); 2026-05: .*; 2026-02: .*; and 2 more\./)
    assert.doesNotMatch(issue.summary, /2025-06|2025-01/)
  })
})

describe('what a close freezes', () => {
  let books: TieOut
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    books = tieOut()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the lines digest is sha-256 of the sorted key|class|cents values, with their count and sum', () => {
    const s = closeMonth('2026-10', 'review', nov(7))!
    const lines = classifyLines('2026-10-01', '2026-10-31')
    assert.equal(s.digests.lines, sha256(lines.map((l) => `${l.key}|${l.cls}|${l.cents}`).sort().join('\n')))
    assert.deepEqual([s.lineCount, s.lineSumCents], [lines.length, lines.reduce((t, l) => t + l.cents, 0)])
    // The ledger is kept line by line, with what decides its stage.
    const kept = db.all<{ key: string; cls: string; cents: number }>("SELECT line_key AS key, class AS cls, cents FROM snapshot_lines WHERE month = '2026-10' AND version = ?", s.version)
    assert.equal(linesDigest(kept), s.digests.lines)
    assert.deepEqual(
      kept.map((l) => l.key).sort(),
      lines.map((l) => l.key).sort()
    )
    // The rental repair paid from Checking is the venture's, and so a Ventures line in Personal's ledger.
    assert.deepEqual(db.get("SELECT class, cents, owner, account_id AS account FROM snapshot_lines WHERE month = '2026-10' AND txn_id = ?", books.repair), { class: 'venture', cents: -25_000, owner: books.venture, account: ACCOUNTS.checking })
  })

  test("the rows digest covers every row's and part's actual, run rate, rate and pay basis, and the identities' terms", () => {
    const w = monthClose('2026-10').waterfall
    const digest = rowsDigest(w)
    assert.equal(latest('2026-10')!.digests.rows, digest)
    const copy = (): Waterfall => structuredClone(w)
    const changed = (edit: (x: Waterfall) => void): boolean => {
      const x = copy()
      edit(x)
      return rowsDigest(x) !== digest
    }
    for (const [i, r] of w.rows.entries()) {
      assert.ok(changed((x) => (x.rows[i].actualCents += 1)), `${r.id}'s actual`)
      assert.ok(changed((x) => (x.rows[i].runRateCents = (x.rows[i].runRateCents ?? 0) + 1)), `${r.id}'s run rate`)
      assert.ok(changed((x) => (x.rows[i].rate = (x.rows[i].rate ?? 0) + 0.1)), `${r.id}'s rate`)
      for (const [j, p] of r.parts.entries()) {
        assert.ok(changed((x) => (x.rows[i].parts[j].actualCents += 1)), `${r.id} ${p.key}'s actual`)
        assert.ok(changed((x) => (x.rows[i].parts[j].runRateCents = (x.rows[i].parts[j].runRateCents ?? 0) + 1)), `${r.id} ${p.key}'s run rate`)
        assert.ok(changed((x) => (x.rows[i].parts[j].rate = (x.rows[i].parts[j].rate ?? 0) + 0.1)), `${r.id} ${p.key}'s rate`)
      }
    }
    const paid = w.rows.findIndex((r) => r.basis !== null)
    assert.ok(paid >= 0)
    assert.ok(changed((x) => (x.rows[paid].basis = x.rows[paid].basis === 'deposits' ? 'paystub' : 'deposits')), 'the pay basis')
    assert.ok(changed((x) => (x.identity.unexplainedCents += 1)), 'Unexplained')
    assert.ok(changed((x) => (x.bridge.revaluationCents += 1)), 'Revaluation')
    // What isn't a figure of the month (its sparkline, a part's name, the levers) doesn't move it.
    assert.ok(!changed((x) => (x.rows[0].trend = [])))
    assert.ok(!changed((x) => (x.rows[0].parts[0].name = 'renamed')))
    assert.ok(!changed((x) => (x.levers = [])))
  })

  test('every row and part is kept with its actual, run rate, rate, change in points and pay basis, and the identities and items with them', () => {
    const w = monthClose('2026-10').waterfall
    const row = db.get<{ rows: string; identity: string; bridge: string; checks: string }>(`SELECT "rows", identity, bridge, checks FROM month_snapshots WHERE month = '2026-10' ORDER BY version DESC LIMIT 1`)!
    const frozen = JSON.parse(row.rows) as { rows: Array<{ id: string; actualCents: number; runRateCents: number | null; rate: number | null; rateChangePts: number | null; basis: string | null; parts: Array<{ key: string; actualCents: number; runRateCents: number | null; rate: number | null }> }> }
    assert.deepEqual(
      frozen.rows.map((r) => [r.id, r.actualCents, r.runRateCents, r.rate, r.rateChangePts, r.basis, r.parts.map((p) => [p.key, p.actualCents, p.runRateCents, p.rate])]),
      w.rows.map((r) => [r.id, r.actualCents, r.runRateCents, r.rate, r.rateChangePts, r.basis, r.parts.map((p) => [p.key, p.actualCents, p.runRateCents, p.rate])])
    )
    assert.deepEqual(JSON.parse(row.identity), { ...w.identity, toleranceCents: 2_000 })
    assert.deepEqual(JSON.parse(row.bridge), w.bridge)
    assert.deepEqual((JSON.parse(row.checks) as { leaks: unknown[] }).leaks, w.leaks)
  })
})

describe('the December close', () => {
  // A year of monthly checks, each with its own stub: gross 2,500.00, taxes 500.00 (federal 300.00, Social Security
  // 155.00, Medicare 45.00), net and deposit 2,000.00. The filed return says wages of 30,100.00, 100.00 more than the
  // stubs' 30,000.00.
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 2, 10) * 1000 })
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 2_400_000, availableCents: null, balanceDate: noonOn(2026, 2, 10) })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    const pay = db.listCategories().find((c) => c.name === 'Paycheck')!.id
    for (let m = 1; m <= 12; m++) {
      const day = `2025-${String(m).padStart(2, '0')}-15`
      db.upsertTransaction({ id: `pay-${m}`, accountId: 'csv:chk', posted: noonOn(2025, m, 15), amountCents: 200_000, description: 'GALE PAYROLL', pending: false })
      db.setTransactionFields(`pay-${m}`, { categoryId: pay, source: 'user', merchant: 'Gale Payroll' })
      savePaystub({ paycheckKey: 'gale payroll|+', payDay: day, grossCents: 250_000, items: [{ kind: 'federal', cents: 30_000 }, { kind: 'social_security', cents: 15_500 }, { kind: 'medicare', cents: 4_500 }] })
    }
    setTaxYear(2025, { status: 'filed', wagesCents: 3_010_000 })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("compares the year's paystubs with its return: wages 100.00 short are a w2_mismatch", () => {
    assert.deepEqual(closeMonth('2025-12', 'review')!.checks, [{ kind: 'w2_mismatch', cents: -10_000, year: 2025 }])
    assert.deepEqual(closeMonth('2025-11', 'review')!.checks, [])
  })
})

describe('what the raw digest and the inputs stamp read', () => {
  let books: TieOut
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    books = tieOut({ fed: true })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a month's raw digest moves with its own lines and dated inputs, and not with another month's or a feed's daily balance", () => {
    const accounts = [...monthClose('2026-10').balances.keys()]
    const raw = (): string => rawDigest('2026-10', accounts)
    const was = raw()
    assert.equal(raw(), was)
    // A sync the next day moves the feeds' own balances, but a balance after October is known already.
    db.upsertAccount({ id: ACCOUNTS.checking, source: 'simplefin', name: 'Checking', institution: null, currency: 'USD', balanceCents: 311_000, availableCents: null, balanceDate: nov(8) })
    assert.equal(raw(), was)
    // September's lines are September's.
    const sep = db.all<{ id: string }>("SELECT id FROM transactions WHERE description = 'CORNER BISTRO' ORDER BY posted").map((r) => r.id)
    const dining = db.listCategories().find((c) => c.name === 'Dining Out')!.id
    const groceries = db.listCategories().find((c) => c.name === 'Groceries')!.id
    db.setTransactionFields(sep[sep.length - 2], { categoryId: groceries, source: 'user' })
    assert.equal(raw(), was)
    // October's line, a balance dated in October, and a venture placing move it.
    db.setTransactionFields(sep[sep.length - 1], { categoryId: groceries, source: 'user' })
    const recategorized = raw()
    assert.notEqual(recategorized, was)
    db.setTransactionFields(sep[sep.length - 1], { categoryId: dining, source: 'user' })
    assert.equal(raw(), was)
    db.setBalancePoint(ACCOUNTS.checking, '2026-10-15', 250_000)
    assert.notEqual(raw(), was)
    db.deleteBalancePoint(ACCOUNTS.checking, '2026-10-15')
    assert.equal(raw(), was)
    db.setTransactionsBucket([books.groceries], books.venture)
    assert.notEqual(raw(), was)
  })

  test('the inputs stamp moves with a setting, an account or a paystub, and not with a line', () => {
    const was = inputsStamp()
    line(ACCOUNTS.checking, '2026-11-05', -1_200, 'CORNER CAFE', 'Coffee', 'Corner Cafe')
    assert.equal(inputsStamp(), was)
    db.setSetting('close.tolerance', JSON.stringify({ cents: 1_000, bp: 50 }))
    const tolerance = inputsStamp()
    assert.notEqual(tolerance, was)
    db.updateAccount(ACCOUNTS.visa, { apr: 26 })
    assert.notEqual(inputsStamp(), tolerance)
    const apr = inputsStamp()
    stub('2026-11-03')
    assert.notEqual(inputsStamp(), apr)
  })

  test("the inputs stamp moves with the day an account's flows are known from, its name and its source, which decide its Growth", () => {
    // An IRA with a statement at each month's end, 100.00 higher each time, and no lines.
    const ira = db.addManualAccount({ name: 'Heron IRA', assetType: 'retirement', points: ['2026-04', ...MONTHS].map((m, i) => ({ day: lastDay(m), cents: 1_000_000 + i * 10_000 })) })
    const june = (): Waterfall['bridge'] => monthClose('2026-06').waterfall.bridge
    const [was, before] = [inputsStamp(), june()]
    // Known to have had no money in or out since Apr 30, its rise is Growth rather than Revaluation.
    db.setFlowsKnownFrom(ira, '2026-04-30')
    assert.deepEqual([june().growthCents - before.growthCents, june().revaluationCents - before.revaluationCents], [10_000, -10_000])
    const known = inputsStamp()
    assert.notEqual(known, was)
    db.updateAccount(ira, { name: 'Heron Rollover' })
    const renamed = inputsStamp()
    assert.notEqual(renamed, known)
    db.run("UPDATE accounts SET source = 'csv' WHERE id = ?", ira)
    assert.notEqual(inputsStamp(), renamed)
  })
})

describe('what comes after a month and still decides it', () => {
  let books: TieOut
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    books = tieOut()
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })
  const october = (): string => rawDigest('2026-10', [...monthClose('2026-10').balances.keys()])
  const checking = (): number => monthClose('2026-10').waterfall.identity.checkingCents

  test("with Checking's Oct 31 statement gone, its month end is walked back from Nov 7: a Nov 4 line moves October's Left in checking, and its raw digest", () => {
    db.deleteBalancePoint(ACCOUNTS.checking, '2026-10-31')
    const [was, left] = [october(), checking()]
    line(ACCOUNTS.checking, '2026-11-04', -10_000, 'CORNER CAFE', 'Coffee', 'Corner Cafe')
    // October's part of the bracket from Sep 30 to Nov 7, by days.
    assert.deepEqual([left, checking()], [11_737, 19_895])
    assert.notEqual(october(), was)
  })

  test("the Oct 31 transfer's landing on Nov 1 makes it In transit: deleting the landing makes it an orphan, and moves October's raw digest", () => {
    const was = october()
    const transit = monthClose('2026-10').waterfall.identity.inTransitCents
    db.deleteTransaction(books.toSavings[1])
    assert.deepEqual([monthClose('2026-10').waterfall.identity.inTransitCents, transit], [0, 50_000])
    assert.notEqual(october(), was)
  })

  test('a landing up to five days on counts though its account has a balance before it: 300.00 from Checking on Oct 30 lands in the Brokerage on Nov 4, after its Nov 2 statement', () => {
    line(ACCOUNTS.checking, '2026-10-30', -30_000, 'TRANSFER TO BROKERAGE', 'Transfers', 'Transfer to Brokerage')
    db.setBalancePoint(ACCOUNTS.brokerage, '2026-11-02', 5_080_000)
    const leg = line(ACCOUNTS.brokerage, '2026-11-04', 30_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Transfer from Checking')
    const was = october()
    const invested = (): number => monthClose('2026-10').waterfall.identity.toInvestmentsCents
    assert.equal(invested(), 60_000)
    db.deleteTransaction(leg)
    assert.equal(invested(), 30_000)
    assert.notEqual(october(), was)
  })

  test("a card linked after October, with nothing in it, leaves every closed month's balances and raw digests as they were", async () => {
    await closeDueMonths(nov(7))
    const closes = listSnapshots(1000)
    db.upsertAccount({ id: 'csv:new-card', source: 'csv', name: 'New Card', institution: null, currency: 'USD', balanceCents: -5_000, availableCents: null, balanceDate: nov(7) })
    db.updateAccount('csv:new-card', { assetType: 'credit_card', openedDay: '2026-11-05' })
    for (const s of closes) {
      const c = monthClose(s.month)
      assert.ok(c.balances.has('csv:new-card'), s.month)
      assert.deepEqual([balancesDigest(c.balances), rawDigest(s.month, [...c.balances.keys()]), rowsDigest(c.waterfall)], [s.digests.balances, s.digests.raw, s.digests.rows], s.month)
    }
  })
})

describe('backfill and versions', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 9) * 1000 })
    db.openDb(':memory:')
    loadDemoData()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('on first launch of the demo every past month closes in the background, as version 1 with origin backfill, and Review shows at most one month_gap issue', async () => {
    const first = firstLedgerDay()!.slice(0, 7)
    const months: string[] = []
    for (let m = first; m < '2026-11'; m = shiftMonth(m, 1)) months.push(m)
    // A run cut short: two months, then the rest, and nothing closed twice.
    const part = await closeDueMonths(undefined, { limit: 2 })
    assert.deepEqual(part.closed.map((c) => c.month), months.slice(0, 2))
    assert.equal(part.left, months.length - 2)
    // Two runs asked for at once: the second waits for the first.
    const [rest, again] = await Promise.all([closeDueMonths(), closeDueMonths()])
    assert.deepEqual(rest.closed.map((c) => c.month), months.slice(2))
    assert.deepEqual(again.closed, [])
    const all = listSnapshots(1000)
    assert.deepEqual(all.map((s) => [s.month, s.version, s.origin]).reverse(), months.map((m) => [m, 1, 'backfill']))
    assert.ok(openIssues().filter((i) => i.kind === 'month_gap').length <= 1)
  })

  test('every version is kept; undoing close_month removes the version it wrote', () => {
    const r = runTool('close_month', { month: '2026-09' }, 'assistant')
    assert.equal((r.result as { version: number }).version, 2)
    const kept = (v: number): number[] => ['month_snapshots', 'snapshot_lines', 'snapshot_balances'].map((t) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE month = '2026-09' AND version = ?`, v)!.n)
    assert.deepEqual(versions('2026-09').map((s) => [s.version, s.origin]), [
      [2, 'review'],
      [1, 'backfill']
    ])
    const [v1, v2] = [kept(1), kept(2)]
    assert.ok(v2.every((n) => n > 0))
    assert.deepEqual(v2, v1)
    // The same books, closed again: the same digests.
    assert.deepEqual(versions('2026-09')[0].digests, versions('2026-09')[1].digests)
    const c = db.getChange(r.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    db.markChangeUndone(r.changeId!)
    assert.deepEqual(kept(2), [0, 0, 0])
    assert.deepEqual(kept(1), v1)
  })

  test('clearing the sample data forgets the months it closed', () => {
    assert.ok(listSnapshots().length > 0)
    clearDemoData()
    assert.deepEqual(listSnapshots(), [])
  })
})

describe('the closes leave with the books', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-closes-'))
  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut()
    await closeDueMonths(nov(7))
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
    rmSync(dir, { recursive: true, force: true })
  })

  test('exportAll includes the three tables', () => {
    const x = db.exportAll()
    const count = (t: string): number => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n
    for (const t of ['month_snapshots', 'snapshot_lines', 'snapshot_balances']) {
      assert.ok(x.tables[t], t)
      assert.equal(x.tables[t].length, count(t), t)
      assert.ok(count(t) > 0, t)
    }
  })

  test('a backup holds them, and the books moved into an empty ledger bring them along', async () => {
    const want = listSnapshots(1000)
    const lines = db.all('SELECT * FROM snapshot_lines ORDER BY month, version, line_key')
    const file = await bulkBackup(dir)
    // The copy is under the books' own key: none for a ledger in memory.
    const copy = new DatabaseSync(file, { readOnly: true, ...(db.dbEncrypted() ? {} : { key: null }) })
    try {
      assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM month_snapshots').get() as { n: number }).n, want.length)
      assert.deepEqual(copy.prepare('SELECT * FROM snapshot_lines ORDER BY month, version, line_key').all(), lines)
    } finally {
      copy.close()
    }
    const exported = JSON.parse(JSON.stringify(db.exportAll()))
    db.closeDb()
    db.openDb(':memory:')
    restoreExport(exported)
    assert.deepEqual(listSnapshots(1000), want)
    assert.deepEqual(db.all('SELECT * FROM snapshot_lines ORDER BY month, version, line_key'), lines)
  })
})

describe('a write from another process while a month closes', () => {
  // Review's tool server (mcp-server.ts) writes to the same file from its own process.
  const dir = mkdtempSync(join(tmpdir(), 'finance-close-race-'))
  const file = join(dir, 'finance.db')
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    tieOut({ file })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
    rmSync(dir, { recursive: true, force: true })
  })

  test("a close reads the books as of one moment: a recategorization another process commits partway through fails it, and the next close holds the line as it is now", () => {
    const other = new DatabaseSync(file, db.dbEncrypted() ? {} : { key: null })
    const bistro = db.all<{ id: string }>("SELECT id FROM transactions WHERE description = 'CORNER BISTRO' ORDER BY posted").at(-1)!.id
    const shopping = db.listCategories().find((c) => c.name === 'Shopping')!.id
    // The other process commits once the close has read October's lines and starts on its raw digest.
    const books = db.currentConnection()! as { prepare: (sql: string) => unknown }
    const prepare = books.prepare.bind(books)
    let wrote = false
    books.prepare = (sql: string) => {
      if (!wrote && sql.includes('transaction_tags')) {
        wrote = true
        other.prepare('UPDATE transactions SET category_id = ?, one_time = 1 WHERE id = ?').run(shopping, bistro)
      }
      return prepare(sql)
    }
    try {
      assert.throws(() => closeMonth('2026-10', 'review', nov(7)), { code: 'SQLITE_BUSY_SNAPSHOT' })
    } finally {
      delete (books as { prepare?: unknown }).prepare
      other.close()
    }
    assert.equal(wrote, true)
    assert.equal(latest('2026-10'), undefined)
    const s = closeMonth('2026-10', 'review', nov(7))!
    assert.equal(s.digests.lines, linesDigest(classifyLines('2026-10-01', '2026-10-31')))
    assert.equal(s.digests.raw, rawDigest('2026-10', [...monthClose('2026-10').balances.keys()]))
    assert.equal(db.get<{ cls: string }>("SELECT class AS cls FROM snapshot_lines WHERE month = '2026-10' AND txn_id = ?", bistro)?.cls, 'oneOff')
  })

  test("a month the other process closes meanwhile isn't closed twice: this close fails, and its version stands alone", () => {
    const other = new DatabaseSync(file, db.dbEncrypted() ? {} : { key: null })
    const books = db.currentConnection()! as { prepare: (sql: string) => unknown }
    const prepare = books.prepare.bind(books)
    let wrote = false
    books.prepare = (sql: string) => {
      if (!wrote && sql.includes('INSERT INTO month_snapshots')) {
        wrote = true
        other
          .prepare("INSERT INTO month_snapshots (scope, month, version, origin, closed_at, engine_version, status, \"rows\", checks, identity, bridge, line_digest, line_count, line_sum, raw_digest, balance_digest, rows_digest, inputs_stamp) VALUES ('personal', '2026-09', 1, 'review', 0, 0, 'closed', '{}', '{}', '{}', '{}', '', 0, 0, '', '', '', '')")
          .run()
      }
      return prepare(sql)
    }
    try {
      assert.throws(() => closeMonth('2026-09', 'backfill', nov(7), { once: true }), { code: 'SQLITE_BUSY_SNAPSHOT' })
    } finally {
      delete (books as { prepare?: unknown }).prepare
      other.close()
    }
    assert.deepEqual(versions('2026-09').map((s) => [s.version, s.origin]), [[1, 'review']])
    assert.equal(closeMonth('2026-09', 'backfill', nov(7), { once: true }), null)
  })
})

describe('the cost of closing', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    largeLedger()
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a month costs little beyond its waterfall, the digests almost nothing, and a backfill gives the event loop back between months', async (t) => {
    const cpu = (f: () => unknown): number => {
      const was = process.cpuUsage()
      f()
      const u = process.cpuUsage(was)
      return (u.user + u.system) / 1000
    }
    // Paired rounds: a month's waterfall, then its close, each round on its own month; the median of the ratios.
    getWaterfall({ from: '2026-09', to: '2026-09' })
    const ratios: number[] = []
    for (const m of ['2026-08', '2026-06', '2026-04', '2026-02', '2025-12']) {
      const prior = shiftMonth(m, -1)
      const waterfall = cpu(() => getWaterfall({ from: prior, to: prior }))
      const close = cpu(() => closeMonth(m, 'backfill'))
      ratios.push(close / Math.max(waterfall, 1))
    }
    const median = [...ratios].sort((a, b) => a - b)[2]
    t.diagnostic(`close / waterfall, median of 5 rounds: ${median.toFixed(2)}`)
    assert.ok(median < 2, `a close costs ${median.toFixed(2)} times its waterfall`)

    // The digests of a month, timed by the wall clock over many rounds (CPU time is too coarse on Windows).
    const c = monthClose('2026-07')
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) {
      linesDigest(c.lines)
      rowsDigest(c.waterfall)
    }
    const digests = (performance.now() - t0) / 20
    t.diagnostic(`lines and rows digests of a month of ${c.lines.length} lines: ${digests.toFixed(2)} ms`)
    assert.ok(digests < 20, `${digests.toFixed(2)} ms`)

    // The backfill of the rest: a 1 ms timer gets in between every two months.
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    const was = process.cpuUsage()
    const run = await closeDueMonths()
    const u = process.cpuUsage(was)
    clearInterval(timer)
    t.diagnostic(`backfill of ${run.closed.length} months: ${((u.user + u.system) / 1000 / run.closed.length).toFixed(0)} ms of CPU a month`)
    assert.equal(run.closed.length, 60 - 5)
    assert.ok(ticks >= run.closed.length - 1, `${ticks} ticks over ${run.closed.length} months`)
  })
})
