import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as db from '../src/main/db.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { ENGINE_VERSION } from '../src/main/lines.ts'
import { changedMonths, checkClosed, closeDueMonths, diffSnapshot, inputsStamp, listSnapshots, monthsAhead, rawDigest, rowsDigest, linesDigest, balancesDigest } from '../src/main/snapshots.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { getWaterfall, monthClose } from '../src/main/waterfall.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { MonthSnapshot, StageId } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { ACCOUNTS as TIE, line, tieOut, type TieOut } from './fixtures/tieout.ts'
import { ACCOUNTS as KESTREL, kestrel, kestrelBooks, line as kestrelLine, storeParts } from './fixtures/venture-money.ts'

// Closes and money between Personal and a venture (waterfall spec addendum 1.11, Frozen data and "An intent changed
// after a month is closed"; sub-phase 1j, part 4). What a close digests of it: each source row's stored intent parts
// in the raw digest, every share row, remembered answer and venture's kind, value source and Stakes account in the
// inputs stamp, and each venture's position in the rows digest from engine version 3. When a check recomputes a closed
// month for it: a month ahead of it changed (I5 reads 30 days ahead), or the claims its positions read moved, however
// far back the line. And the fourth change that re-closes a month by itself: money with a venture moved between
// Ventures, Bought assets and Debt paid down alone. Example A2 on the section 2 tie-out is the worked case.

configureLicense({ dev: true })

const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const latest = (month: string): MonthSnapshot | undefined => listSnapshots(1000).find((s) => s.month === month)
const issuesOf = (kind: string): ReturnType<typeof openIssues> => openIssues().filter((i) => i.kind === kind)
const batches = (): string[] => [...new Set(changedMonths().map((c) => c.batch))]
const months = (list: Array<{ month: string }>): string[] => list.map((c) => c.month).sort()
const span = (from: string, to: string): string[] => {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m)
  return out
}
/** Undoes a change the way the Review chat does. */
function revert(changeId: number | undefined): void {
  const c = db.getChange(changeId!)!
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId!)
}
/** A month's figures as Home has them: each row's actual and run rate, the cash identity and the bridge. */
function figures(month: string): { rows: Partial<Record<StageId, number>>; runRates: Partial<Record<StageId, number | null>>; identity: ReturnType<typeof getWaterfall>['identity']; bridge: ReturnType<typeof getWaterfall>['bridge'] } {
  const w = getWaterfall({ from: month, to: month })
  return { rows: Object.fromEntries(w.rows.map((r) => [r.id, r.actualCents])), runRates: Object.fromEntries(w.rows.map((r) => [r.id, r.runRateCents])), identity: w.identity, bridge: w.bridge }
}
/** That every closed month is its latest close's, or shows as changed: no silent change. */
function noSilentChange(where: string): void {
  for (const s of listSnapshots(1000).filter((x, i, all) => all.findIndex((y) => y.month === x.month) === i)) {
    if (s.status === 'changed') continue
    const c = monthClose(s.month)
    assert.deepEqual([linesDigest(c.lines), balancesDigest(c.balances), rowsDigest(c.waterfall)], [s.digests.lines, s.digests.balances, s.digests.rows], `${where}: ${s.month} moved without showing`)
  }
}

afterEach(() => {
  db.closeDb()
  mock.timers.reset()
})

describe('what a close digests of money with a venture', () => {
  test("the raw digest reads each source row's stored intent parts (intent, cents, interest, regular and who set them), and a row with none reads as before", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    const accounts = [...monthClose('2026-10').balances.keys()]
    const unset = rawDigest('2026-10', accounts)
    const [august, september] = ['2026-08', '2026-09'].map((m) => rawDigest(m, accounts))
    const draw = runTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw' }, 'assistant')
    const drawn = rawDigest('2026-10', accounts)
    assert.notEqual(drawn, unset)
    // September's reads it too, among Wren Card's rows up to its next statement, Oct 31; August's doesn't.
    assert.deepEqual([rawDigest('2026-08', accounts) === august, rawDigest('2026-09', accounts) === september], [true, false])
    // The same draw, regular: another digest; then by the user, not Review: another still.
    runTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw', regular: true }, 'assistant')
    const regular = rawDigest('2026-10', accounts)
    runTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw', regular: true }, 'phone')
    assert.equal(new Set([unset, drawn, regular, rawDigest('2026-10', accounts)]).size, 4)
    // Taken back, the month reads as it did with none: a row's parts are read only when it has some.
    runTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'none' }, 'assistant')
    assert.equal(rawDigest('2026-10', accounts), unset)
    // The first draw undone puts back what was before it: none.
    revert(draw.changeId)
    assert.equal(rawDigest('2026-10', accounts), unset)
  })

  test("the inputs stamp reads every share row, every remembered answer, and each venture's kind, value source and Stakes account", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    const seen = new Set([inputsStamp()])
    const moved = (what: string): void => {
      const s = inputsStamp()
      assert.ok(!seen.has(s), what)
      seen.add(s)
    }
    const share = runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-10-15', share_pct: 50 }, 'assistant')
    moved('a share row')
    revert(share.changeId)
    assert.ok(seen.has(inputsStamp()), 'the share row undone')
    runTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement', remember: true }, 'assistant')
    moved('a remembered answer')
    runTool('update_bucket', { bucket: 'Wren Rentals', kind: 'business' }, 'assistant')
    moved("the venture's kind")
    const stake = db.addManualAccount({ name: 'Wren stake', assetType: 'venture', points: [{ day: '2026-10-31', cents: 500_000 }] })
    moved('a new account')
    runTool('set_venture_value', { venture: 'Wren Rentals', source: 'estimate', stake_account_id: stake }, 'assistant')
    moved('its value source and Stakes account')
    runTool('set_venture_value', { venture: 'Wren Rentals', source: 'books' }, 'assistant')
    moved('its value source alone')
  })

  test('the rows digest reads each venture\'s position from engine version 3, never under 2, and never a venture at 0 at both ends', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    tieOut()
    const before = monthClose('2026-10').waterfall
    assert.deepEqual(before.bridge.ventures.map((p) => [p.startCents, p.endCents]), [[400_000, 530_000]])
    assert.notEqual(rowsDigest(before, 2), rowsDigest(before, 3))
    assert.equal(rowsDigest(before), rowsDigest(before, ENGINE_VERSION))
    // A venture made since, with nothing in it, is on the bridge's list at 0 and moves no digest.
    runTool('create_bucket', { name: 'Empty Shop', kind: 'business' }, 'assistant')
    const after = monthClose('2026-10').waterfall
    assert.equal(after.bridge.ventures.length, 2)
    assert.deepEqual([rowsDigest(after, 2), rowsDigest(after)], [rowsDigest(before, 2), rowsDigest(before)])
  })
})

describe('example A2: October closed with both intents unset, then restated', () => {
  test('the reimbursement moves only Ventures and Bought assets and October re-closes by itself as version 2; the draw changes October and November in one batch with cause ai; undoing it brings back version 2 and clears the issue', async () => {
    // December open, so November is closed too: its One-offs run rate reads October.
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const t = tieOut()
    await closeDueMonths()
    await checkClosed()
    assert.deepEqual(['2026-10', '2026-11'].map((m) => [latest(m)!.version, latest(m)!.engineVersion]), [[1, ENGINE_VERSION], [1, ENGINE_VERSION]])
    const gaps = issuesOf('month_gap')
    const unset = figures('2026-10')
    assert.deepEqual([unset.identity.venturesCents, unset.identity.boughtCents, unset.bridge.venturesCents, unset.bridge.endCents - unset.bridge.startCents], [-17_000, 0, 113_000, 335_500])

    // The repair a reimbursement: Ventures -170.00 to +80.00 and Bought assets 0 to 250.00, every row as it was,
    // Ventures(NW) 80.00 + 1,300.00 - 250.00 = 1,130.00 as before, and ΔNW as before.
    runTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement' }, 'assistant')
    const repaid = figures('2026-10')
    assert.deepEqual([repaid.identity.venturesCents, repaid.identity.boughtCents, repaid.bridge.venturesCents, repaid.bridge.endCents - repaid.bridge.startCents], [8_000, 25_000, 113_000, 335_500])
    assert.deepEqual([repaid.rows, repaid.runRates], [unset.rows, unset.runRates])
    const { venturesCents: _v, boughtCents: _b, ...rest } = repaid.identity
    const { venturesCents: _v0, boughtCents: _b0, ...was } = unset.identity
    assert.deepEqual(rest, was)
    assert.deepEqual(repaid.bridge, unset.bridge)
    const first = await checkClosed()
    assert.deepEqual(first.reclosed, [{ month: '2026-10', version: 2, status: 'gap', why: 'boundaryMoved' }])
    assert.deepEqual([first.changed, changedMonths(), issuesOf('month_changed'), issuesOf('month_gap')], [[], [], [], gaps])
    // November read October again, and is its close's still.
    assert.ok(first.checked.includes('2026-11'))
    assert.deepEqual([latest('2026-10')!.origin, latest('2026-11')!.version], ['auto', 1])
    const v2 = latest('2026-10')!.digests
    noSilentChange('the reimbursement')

    // The groceries' funding a draw: One-offs 450.00 to 370.00, Kept and Saved 80.00 higher, Ventures(NW) 1,050.00.
    const draw = runTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw' }, 'assistant')
    const drawn = figures('2026-10')
    assert.deepEqual([drawn.rows.oneOffs, drawn.identity.keptCents, drawn.rows.saved, drawn.identity.venturesCents, drawn.bridge.venturesCents], [37_000, 117_500, 192_500, 0, 105_000])
    const second = await checkClosed()
    assert.deepEqual([months(second.changed), second.reclosed], [['2026-10', '2026-11'], []])
    assert.deepEqual(second.changed.map((c) => [c.cause, c.batch]), [['ai', `change:${draw.changeId}`], ['ai', `change:${draw.changeId}`]])
    assert.equal(batches().length, 1)
    assert.equal(issuesOf('month_changed').length, 1)
    const diff = diffSnapshot('2026-10')!
    assert.deepEqual(diff.lines.map((l) => [l.change, l.cause]), [['restaged', 'ai']])
    assert.equal(diff.autoReclose, null)
    assert.deepEqual(['oneOffs', 'saved'].map((id) => diff.byStage.find((s) => s.id === id)!).map((s) => [s.closedCents, s.nowCents]), [[45_000, 37_000], [184_500, 192_500]])
    // November's own lines didn't move: its One-offs run rate, October's 12 months over 12, did, from 37.50 to 30.83.
    const nov = diffSnapshot('2026-11')!
    assert.deepEqual([nov.lines, nov.inputs], [[], [{ kind: 'earlierMonth', ref: '2026-10', cause: 'ai' }]])
    const oneOffs = nov.byStage.find((s) => s.id === 'oneOffs')!
    assert.deepEqual([oneOffs.closedRunRateCents, oneOffs.nowRunRateCents], [3_750, 3_083])

    // Undone through the journal: October is version 2's again, November version 1's, and the issue is gone.
    revert(draw.changeId)
    const third = await checkClosed()
    assert.deepEqual([months(third.changed), [...third.restored].sort(), third.reclosed], [[], ['2026-10', '2026-11'], []])
    assert.deepEqual([changedMonths(), issuesOf('month_changed')], [[], []])
    const now = monthClose('2026-10')
    assert.deepEqual([linesDigest(now.lines), balancesDigest(now.balances), rowsDigest(now.waterfall), rawDigest('2026-10', [...now.balances.keys()])], [v2.lines, v2.balances, v2.rows, v2.raw])
    assert.deepEqual([latest('2026-10')!.version, latest('2026-10')!.status], [2, 'gap'])
    noSilentChange('the draw undone')
  })

  test("at 50% the same reimbursement is no such change: the claim moves October's position, so October is changed with cause ai", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-01-01', share_pct: 50 }, 'assistant')
    await closeDueMonths()
    await checkClosed()
    const change = runTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement' }, 'assistant')
    // Oct 31: 250.00 due and half of 5,300.00 - 250.00, so V is 2,775.00 where it was 2,650.00.
    assert.deepEqual(figures('2026-10').bridge.ventures.map((p) => p.endCents), [277_500])
    const run = await checkClosed()
    assert.deepEqual([run.reclosed, run.changed.map((c) => [c.month, c.cause, c.batch])], [[], [['2026-10', 'ai', `change:${change.changeId}`]]])
    assert.equal(diffSnapshot('2026-10')!.autoReclose, null)
  })

  test('a remembered answer that gives the repair a reimbursement at 100% re-closes October by itself, though the inputs stamp moved and every month is recomputed', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    await closeDueMonths()
    await checkClosed()
    const closed = listSnapshots(1000).map((s) => s.month)
    runTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement', remember: true }, 'assistant')
    const run = await checkClosed()
    assert.deepEqual([...run.checked].sort(), [...closed].sort())
    assert.deepEqual([run.changed, run.reclosed], [[], [{ month: '2026-10', version: 2, status: 'gap', why: 'boundaryMoved' }]])
  })
})

describe('a share edit on a closed month', () => {
  test('reclassifies every closed month through the inputs stamp: from Oct 15 at 50%, October and November change in one batch with cause ai; a share from after them changes none', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const t: TieOut = tieOut()
    await closeDueMonths()
    await checkClosed()
    const closed = listSnapshots(1000).map((s) => s.month).sort()
    assert.deepEqual(closed, span('2026-05', '2026-11'))
    const share = runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-10-15', share_pct: 50 }, 'assistant')
    const run = await checkClosed()
    assert.deepEqual([...run.checked].sort(), closed)
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.batch]).sort(), [['2026-10', 'ai', `change:${share.changeId}`], ['2026-11', 'ai', `change:${share.changeId}`]])
    assert.deepEqual(diffSnapshot('2026-10')!.inputs, [{ kind: 'setting', ref: `venture_shares:${t.venture}:2026-10-15`, cause: 'ai' }])
    // October's end, and November's both ends: half of what Wren Rentals holds.
    assert.deepEqual(diffSnapshot('2026-11')!.bridge.filter((b) => b.key === 'startCents').map((b) => b.nowCents - b.closedCents), [-265_000])
    revert(share.changeId)
    const back = await checkClosed()
    assert.deepEqual([[...back.restored].sort(), changedMonths(), issuesOf('month_changed')], [['2026-10', '2026-11'], [], []])
    runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-12-01', share_pct: 50 }, 'assistant')
    const later = await checkClosed()
    assert.deepEqual([[...later.checked].sort(), later.changed, later.reclosed], [closed, [], []])
    noSilentChange('a share from December')
  })

  test("equity on the Oct 20 repair with the share after it 100%, the share it was migrated at, moves only Ventures and Bought assets: October re-closes by itself", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t: TieOut = tieOut()
    await closeDueMonths()
    await checkClosed()
    runTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'equity', share_after_pct: 100 }, 'assistant')
    assert.deepEqual(diffSnapshot('2026-10')!.inputs, [{ kind: 'setting', ref: `venture_shares:${t.venture}:2026-10-20`, cause: 'ai' }])
    const run = await checkClosed()
    assert.deepEqual([run.reclosed.map((r) => [r.month, r.why]), run.changed, issuesOf('month_changed')], [[['2026-10', 'boundaryMoved']], [], []])
    noSilentChange('the equity')
  })
})

/**
 * Four months of a checking account in a year, January to April, each with its statement at the month's end, and a
 * venture's cost paid from it in January (a C part with no intent): pay on the 3rd, groceries on the 10th, and the
 * cost of 150.00 on Jan 20. With `answered`, the cost is a reimbursement, so January holds nothing a later line can
 * give an intent.
 */
function aheadBooks(year: number, o: { answered?: boolean } = {}): void {
  db.openDb(':memory:')
  db.upsertAccount({ id: TIE.checking, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.updateAccount(TIE.checking, { assetType: 'cash' })
  const venture = db.saveBucket({ name: 'Fern Studio', kind: 'business' })
  let balance = 100_000
  db.setBalancePoint(TIE.checking, `${year - 1}-12-31`, balance)
  let cost = ''
  for (const m of span(`${year}-01`, `${year}-04`)) {
    line(TIE.checking, `${m}-03`, 300_000, 'TERN PAYROLL', 'Paycheck', 'Tern Payroll')
    line(TIE.checking, `${m}-10`, -40_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    balance += 260_000
    if (m.endsWith('-01')) {
      cost = line(TIE.checking, `${m}-20`, -15_000, 'FERN SUPPLIES', 'Shopping', 'Fern Supplies')
      balance -= 15_000
    }
    db.setBalancePoint(TIE.checking, lastDay(m), balance)
  }
  db.setTransactionsBucket([cost], venture)
  if (o.answered) runTool('set_venture_money', { transaction_ids: [cost], venture: 'Fern Studio', intent: 'reimbursement' }, 'assistant')
}

describe('the months ahead of a closed month', () => {
  test('are the month after, and for January March too: 30 days from Jan 31 is Mar 1 in a leap year and Mar 2 in a common one', () => {
    assert.deepEqual(['2028-01', '2027-01', '2028-02', '2027-02', '2026-10', '2026-11', '2026-12'].map(monthsAhead), [
      ['2028-02', '2028-03'],
      ['2027-02', '2027-03'],
      ['2028-03'],
      ['2027-03'],
      ['2026-11'],
      ['2026-12'],
      ['2027-01']
    ])
  })

  for (const [year, day] of [
    [2028, '2028-03-01'],
    [2027, '2027-03-02']
  ] as const) {
    test(`${year}: a line on ${day} classifies January again, as it holds a venture's cost with no intent; one in April doesn't; nor does March's once the cost has one`, async () => {
      mock.timers.enable({ apis: ['Date'], now: noonOn(year, 5, 7) * 1000 })
      aheadBooks(year)
      await closeDueMonths()
      await checkClosed()
      assert.deepEqual(listSnapshots(1000).map((s) => s.month).sort(), span(`${year}-01`, `${year}-04`))
      // January's raw digest reads Checking up to its statement on the last of February, so not March.
      const january = rawDigest(`${year}-01`, [TIE.checking])
      line(TIE.checking, day, -2_500, 'CORNER CAFE', 'Coffee', 'Corner Cafe')
      assert.equal(rawDigest(`${year}-01`, [TIE.checking]), january)
      const march = await checkClosed()
      // January for the months ahead of it; February, March and April as before 1j: February's raw digest reads
      // Checking up to its statement on Mar 31, March holds the line, and April's run rates read March.
      assert.deepEqual(march.checked, [`${year}-01`, `${year}-02`, `${year}-03`, `${year}-04`])
      assert.equal(latest(`${year}-01`)!.status, 'closed')
      // A line in April is ahead of March, which holds nothing a later line can give an intent, and of no month
      // January reads ahead.
      line(TIE.checking, `${year}-04-02`, -2_500, 'CORNER CAFE', 'Coffee', 'Corner Cafe')
      assert.deepEqual((await checkClosed()).checked, [`${year}-03`, `${year}-04`])

      db.closeDb()
      aheadBooks(year, { answered: true })
      await closeDueMonths()
      await checkClosed()
      line(TIE.checking, day, -2_500, 'CORNER CAFE', 'Coffee', 'Corner Cafe')
      assert.deepEqual((await checkClosed()).checked, [`${year}-02`, `${year}-03`, `${year}-04`])
    })
  }
})

describe('a month closed under engine version 2', () => {
  test('with its figures unchanged it stays closed with no issue, though version 3 digests the positions it froze none of', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    storeParts(kestrel())
    await closeDueMonths()
    const closes = listSnapshots(1000)
    assert.deepEqual(closes.map((s) => s.month).sort(), span('2026-01', '2026-11'))
    // What version 2 froze: the rows digested without positions, and its own inputs stamp.
    db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%' OR key LIKE 'snapshots.stamp:%' OR key = 'snapshots.sweep'")
    for (const s of closes) {
      const w = monthClose(s.month).waterfall
      assert.notEqual(rowsDigest(w, 2), rowsDigest(w), s.month)
      db.run("UPDATE month_snapshots SET engine_version = 2, rows_digest = ?, inputs_stamp = 'version 2' WHERE month = ? AND version = ?", rowsDigest(w, 2), s.month, s.version)
    }
    const run = await checkClosed()
    assert.deepEqual([[...run.checked].sort(), run.changed, run.reclosed, changedMonths(), issuesOf('month_changed')], [span('2026-01', '2026-11'), [], [], [], []])
    assert.ok(listSnapshots(1000).every((s) => s.engineVersion === 2 && s.version === 1 && s.status !== 'changed'))
  })

  test("with its own inputs stamp, what version 3 reads that 2 didn't (a venture's kind, value source and Stakes account, its migrated share) is no input that moved: the Nov 4 payback re-closes October by itself", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    await closeDueMonths()
    const closes = listSnapshots(1000)
    // Version 2's stamp: the venture's row as it read it (its residence dates alone) and no share rows.
    const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
    const parts = JSON.parse(db.getSetting(`snapshots.stamp:${closes[0].digests.inputs}`)!) as Record<string, string>
    const b = db.get<{ id: number; from: string | null; to: string | null; converted: number }>('SELECT id, residence_from AS "from", residence_to AS "to", residence_converted AS converted FROM buckets WHERE id = ?', t.venture)!
    const old: Record<string, string> = { engine: '2' }
    for (const [k, v] of Object.entries(parts)) if (k !== 'engine' && !k.startsWith('venture_shares:') && !k.startsWith('venture_money_rules:')) old[k] = v
    old[`buckets:${t.venture}`] = short(JSON.stringify([[b.id, b.from, b.to, b.converted]]))
    db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%' OR key LIKE 'snapshots.stamp:%' OR key = 'snapshots.sweep'")
    db.setSetting('snapshots.stamp:version 2', JSON.stringify(old))
    for (const s of closes) db.run("UPDATE month_snapshots SET engine_version = 2, rows_digest = ?, inputs_stamp = 'version 2' WHERE month = ? AND version = ?", rowsDigest(monthClose(s.month).waterfall, 2), s.month, s.version)
    payback()
    const october = diffSnapshot('2026-10')!
    assert.deepEqual([october.inputs, october.lines.map((l) => [l.key.startsWith(t.repair), l.change, l.fromCls, l.toCls])], [[], [[true, 'restaged', 'venture', 'capital']]])
    const run = await checkClosed()
    assert.deepEqual([run.reclosed.map((r) => [r.month, r.why]), run.changed, issuesOf('month_changed')], [[['2026-10', 'boundaryMoved']], [], []])
  })
})

/**
 * Moss Works, a venture the user owns part of, from January 2024 to June 2025 with July open: Checking gets pay of
 * 3,000.00 on the 3rd and pays groceries of 400.00 on the 10th each month; on Feb 10, 2024 it sends Moss Checking, the
 * venture's account, 1,000.00 in Transfers (a transfer with no intent); on Mar 12, 2024 it pays 250.00 of the
 * venture's printing (its cost, with no intent). The share is 50% from `from` (100% before it, as it was made).
 */
function mossWorks(from: string): { venture: number; transfer: string; printing: string } {
  db.openDb(':memory:')
  const now = noonOn(2025, 7, 7)
  for (const [id, name, cents] of [
    [TIE.checking, 'Checking', 100_000 + 18 * 260_000 - 100_000 - 25_000],
    ['csv:moss', 'Moss Checking', 100_000]
  ] as const) {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: now })
    db.updateAccount(id, { assetType: 'cash' })
  }
  const venture = db.saveBucket({ name: 'Moss Works', kind: 'business' })
  db.updateAccount('csv:moss', { bucketId: venture })
  db.setBalancePoint(TIE.checking, '2023-12-31', 100_000)
  for (const m of span('2024-01', '2025-06')) {
    line(TIE.checking, `${m}-03`, 300_000, 'TERN PAYROLL', 'Paycheck', 'Tern Payroll')
    line(TIE.checking, `${m}-10`, -40_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
  }
  const transfer = line(TIE.checking, '2024-02-10', -100_000, 'TRANSFER TO MOSS', 'Transfers', 'Moss Works')
  line('csv:moss', '2024-02-10', 100_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
  const printing = line(TIE.checking, '2024-03-12', -25_000, 'PRINT SHOP', 'Shopping', 'Print Shop')
  db.setTransactionsBucket([printing], venture)
  runTool('set_venture_share', { venture: 'Moss Works', from, share_pct: 50 }, 'assistant')
  return { venture, transfer, printing }
}

describe('a claim on a venture below 100% reaches every later closed month', () => {
  test('a loan on Feb 2024\'s transfer at 50% changes February and all 16 months after it in one batch with cause ai, past the eleven whose run rates read it; undone, every one is its close\'s again', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2025, 7, 7) * 1000 })
    const moss = mossWorks('2024-01-01')
    await closeDueMonths()
    await checkClosed()
    const closed = span('2024-01', '2025-06')
    assert.deepEqual(listSnapshots(1000).map((s) => s.month).sort(), closed)
    const before = new Map(closed.map((m) => [m, monthClose(m).waterfall.bridge.endCents]))
    const loan = runTool('set_venture_money', { transaction_ids: [moss.transfer], venture: 'Moss Works', intent: 'loan' }, 'assistant')
    // Lent 1,000.00: the position is the claim and half of what's left, 500.00 more at every month's end from February.
    for (const m of closed) assert.equal(monthClose(m).waterfall.bridge.endCents - before.get(m)!, m >= '2024-02' ? 50_000 : 0, m)
    const run = await checkClosed()
    assert.deepEqual(months(run.changed), span('2024-02', '2025-06'))
    assert.deepEqual([...new Set(run.changed.map((c) => `${c.cause} ${c.batch}`))], [`ai change:${loan.changeId}`])
    assert.deepEqual([batches().length, issuesOf('month_changed').length], [1, 1])
    // Each month after February follows the one before it; June 2025 is 16 months on.
    assert.deepEqual(diffSnapshot('2025-06')!.inputs, [{ kind: 'earlierMonth', ref: '2025-05', cause: 'ai' }])
    revert(loan.changeId)
    const back = await checkClosed()
    assert.deepEqual([[...back.restored].sort(), changedMonths(), issuesOf('month_changed')], [span('2024-02', '2025-06'), [], []])
    noSilentChange('the loan undone')
  })

  test("at 100% until 2025, a reimbursement on Mar 2024's printing re-closes March by itself, and January 2025, the first month at 50%, is changed for the claim it reads, with the months after it in its batch", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2025, 7, 7) * 1000 })
    const moss = mossWorks('2025-01-01')
    await closeDueMonths()
    await checkClosed()
    const repaid = runTool('set_venture_money', { transaction_ids: [moss.printing], venture: 'Moss Works', intent: 'reimbursement' }, 'assistant')
    const run = await checkClosed()
    assert.deepEqual(run.reclosed, [{ month: '2024-03', version: 2, status: 'closed', why: 'boundaryMoved' }])
    assert.deepEqual(months(run.changed), span('2025-01', '2025-06'))
    assert.deepEqual([...new Set(run.changed.map((c) => `${c.cause} ${c.batch}`))], [`ai change:${repaid.changeId}`])
    // Jan 31, 2025: 250.00 due and half of 1,000.00 - 250.00, so 625.00 where it was 500.00.
    const january = diffSnapshot('2025-01')!
    assert.deepEqual([january.lines, january.inputs], [[], [{ kind: 'claims', ref: String(moss.venture), cause: 'ai' }]])
    assert.deepEqual(january.bridge.filter((b) => b.key === 'endCents').map((b) => b.nowCents - b.closedCents), [12_500])
    assert.deepEqual(diffSnapshot('2025-02')!.inputs, [{ kind: 'earlierMonth', ref: '2025-01', cause: 'ai' }])
    noSilentChange('the reimbursement')
  })
})

/** Wren Checking's 250.00 to Checking on Nov 4, with no intent: its line on Checking. */
function payback(): string {
  line(TIE.wrenChecking, '2026-11-04', -25_000, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
  return line(TIE.checking, '2026-11-04', 25_000, 'TRANSFER FROM WREN', 'Transfers', 'Wren Rentals')
}

describe('inferences in closed months (parts 3 and 4 together)', () => {
  test('example A with both October intents unset: the Nov 4 payback makes it and the Oct 20 repair reimbursements by I5, and October re-closes by itself; then A2, the draw changes October with cause ai and its undo brings back version 2', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    await closeDueMonths()
    await checkClosed()
    assert.deepEqual([latest('2026-10')!.version, latest('2026-10')!.status], [1, 'gap'])
    const gaps = issuesOf('month_gap')
    const unset = figures('2026-10')
    assert.deepEqual([unset.identity.venturesCents, unset.identity.boughtCents, unset.bridge.venturesCents], [-17_000, 0, 113_000])

    // The payback lands in November, the open month. October holds the repair with no intent, a cost of the venture's
    // a later line can pay back, so the check reads October again: the repair and the payback are both reimbursement,
    // which moves Ventures from -170.00 to +80.00 and Bought assets from 0 to 250.00 and nothing else.
    payback()
    const repaid = figures('2026-10')
    assert.deepEqual([repaid.identity.venturesCents, repaid.identity.boughtCents], [8_000, 25_000])
    assert.deepEqual([repaid.rows, repaid.runRates, repaid.bridge], [unset.rows, unset.runRates, unset.bridge])
    const first = await checkClosed()
    assert.deepEqual(first.reclosed, [{ month: '2026-10', version: 2, status: 'gap', why: 'boundaryMoved' }])
    assert.deepEqual([first.changed, changedMonths(), issuesOf('month_changed'), issuesOf('month_gap')], [[], [], [], gaps])
    assert.deepEqual(monthClose('2026-10').lines.filter((l) => l.txnId === t.repair).map((l) => [l.cls, l.cents]), [['capital', -25_000]])
    const november = figures('2026-11')
    assert.deepEqual([november.identity.boughtCents, november.identity.venturesCents], [-25_000, 0])
    const v2 = latest('2026-10')!.digests
    noSilentChange('the payback')
    // The re-close froze the reimbursements: the next check finds nothing moved.
    const quiet = await checkClosed()
    assert.deepEqual([quiet.changed, quiet.reclosed], [[], []])

    // A2 with the inference there: the groceries' funding a draw moves One-offs, Kept and Saved, so October is changed
    // with cause ai, in one batch; the repair stays the payback's reimbursement.
    const draw = runTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw' }, 'assistant')
    const drawn = figures('2026-10')
    assert.deepEqual([drawn.rows.oneOffs, drawn.identity.keptCents, drawn.rows.saved, drawn.identity.venturesCents, drawn.identity.boughtCents, drawn.bridge.venturesCents], [37_000, 117_500, 192_500, 0, 25_000, 105_000])
    const second = await checkClosed()
    assert.deepEqual([second.changed.map((c) => [c.month, c.cause, c.batch]), second.reclosed], [[['2026-10', 'ai', `change:${draw.changeId}`]], []])
    assert.deepEqual([batches().length, issuesOf('month_changed').length], [1, 1])
    assert.deepEqual(diffSnapshot('2026-10')!.lines.map((l) => [l.change, l.cause]), [['restaged', 'ai']])

    // Undone through the journal: October is version 2's again, with the payback's reimbursement, and the issue is gone.
    revert(draw.changeId)
    const third = await checkClosed()
    assert.deepEqual([months(third.changed), third.restored, third.reclosed], [[], ['2026-10'], []])
    assert.deepEqual([changedMonths(), issuesOf('month_changed')], [[], []])
    const now = monthClose('2026-10')
    assert.deepEqual([linesDigest(now.lines), balancesDigest(now.balances), rowsDigest(now.waterfall), rawDigest('2026-10', [...now.balances.keys()])], [v2.lines, v2.balances, v2.rows, v2.raw])
    assert.deepEqual([latest('2026-10')!.version, latest('2026-10')!.status], [2, 'gap'])
    noSilentChange('the draw undone')
  })

  test('a new line that gives a closed month an inference changes it with cause rule: at 50%, the Nov 4 payback makes the Oct 20 repair a reimbursement by I5, and the claim moves October’s position', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-01-01', share_pct: 50 }, 'assistant')
    await closeDueMonths()
    await checkClosed()
    const was = monthClose('2026-10').waterfall.bridge.ventures.map((p) => p.endCents)
    payback()
    // Oct 31: 250.00 due and half of 5,300.00 - 250.00, so V is 2,775.00 where it was 2,650.00.
    assert.deepEqual([was, figures('2026-10').bridge.ventures.map((p) => p.endCents)], [[265_000], [277_500]])
    const run = await checkClosed()
    assert.deepEqual(run.reclosed, [])
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.label]), [['2026-10', 'rule', 'A series, rule or setting']])
    assert.deepEqual(diffSnapshot('2026-10')!.lines.map((l) => [l.key.startsWith(t.repair), l.change, l.fromCls, l.toCls, l.cause]), [[true, 'restaged', 'venture', 'capital', 'rule']])
    assert.equal(issuesOf('month_changed').length, 1)
  })

  test("a remembered answer that gives a closed month's line its intent is put down to Review's answer: at 50%, September's cost of Wren's takes October's reimbursement, and both months change with cause ai in its batch", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    // A cost of Wren Rentals' paid from Checking in September: the repair's pattern, (Wren Rentals, C, out).
    const gutter = line(TIE.checking, '2026-09-18', -12_000, 'GUTTER PROS', 'Housing', 'Gutter Pros')
    db.setTransactionsBucket([gutter], t.venture)
    runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-01-01', share_pct: 50 }, 'assistant')
    await closeDueMonths()
    await checkClosed()
    const answer = runTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement', remember: true }, 'assistant')
    assert.deepEqual(monthClose('2026-09').lines.filter((l) => l.txnId === gutter).map((l) => [l.cls, l.intent, l.intentSource]), [['capital', 'reimbursement', 'rule']])
    const run = await checkClosed()
    assert.deepEqual(run.reclosed, [])
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.batch]).sort(), [['2026-09', 'ai', `change:${answer.changeId}`], ['2026-10', 'ai', `change:${answer.changeId}`]])
    assert.deepEqual(diffSnapshot('2026-09')!.lines.map((l) => [l.key.startsWith(gutter), l.change, l.fromCls, l.toCls, l.cause]), [[true, 'restaged', 'venture', 'capital', 'ai']])
    revert(answer.changeId)
    const back = await checkClosed()
    assert.deepEqual([[...back.restored].sort(), changedMonths(), issuesOf('month_changed')], [['2026-09', '2026-10'], [], []])
  })

  test("a loan set on a line more than eleven months before closed months whose draws were inferred changes them, with cause ai in the loan's batch: I3 reads that nothing is lent, at 100% by the books too", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 1, 7) * 1000 })
    kestrelBooks()
    // 2,000.00 to Kestrel in June 2025, with no intent; then 1,500.00 back each month from September 2026.
    const sent = kestrelLine(KESTREL.checking, '2025-06-10', -200_000, 'TRANSFER TO KESTREL', 'Transfers', 'Kestrel Studio')
    kestrelLine(KESTREL.kestrel, '2025-06-10', 200_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
    const draws = ['2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15'].map((day) => {
      kestrelLine(KESTREL.kestrel, day, -150_000, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
      return kestrelLine(KESTREL.checking, day, 150_000, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    })
    await closeDueMonths()
    await checkClosed()
    assert.deepEqual(['2026-11', '2026-12'].map((m) => figures(m).identity.venturesCents), [0, 0])
    const loan = runTool('set_venture_money', { transaction_ids: [sent], venture: 'Kestrel Studio', intent: 'loan' }, 'assistant')
    // Lent 2,000.00 from June 2025, so November's and December's transfers back are no draws: Ventures +1,500.00 each.
    assert.deepEqual(['2026-11', '2026-12'].map((m) => figures(m).identity.venturesCents), [150_000, 150_000])
    // June 2025 only moved the transfer from Ventures to Bought assets, and re-closes by itself. November and December,
    // 17 and 18 months on, are read again by the check's look over every closed month: their lines changed class with
    // no field of theirs moving, by Review's answer for Kestrel's money since they closed, so it's theirs: ai, in its batch.
    const run = await checkClosed()
    assert.deepEqual(run.reclosed.map((r) => [r.month, r.why]), [['2025-06', 'boundaryMoved']])
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.batch]).sort(), [['2026-11', 'ai', `change:${loan.changeId}`], ['2026-12', 'ai', `change:${loan.changeId}`]])
    assert.deepEqual(diffSnapshot('2026-11')!.lines.map((l) => l.cause), ['ai'])
    assert.deepEqual(diffSnapshot('2026-11')!.lines.map((l) => [l.key.startsWith(draws[2]), l.change, l.fromCls, l.toCls]), [[true, 'restaged', 'income', 'venture']])
    noSilentChange('the loan')
    revert(loan.changeId)
    const back = await checkClosed()
    assert.deepEqual([[...back.restored].sort(), changedMonths(), issuesOf('month_changed')], [['2026-11', '2026-12'], [], []])
    noSilentChange('the loan undone')
  })

  test("example C closed from September to January: Review's draw, regular, on Sep, Oct and Jan changes every closed month whose rows move in one batch with cause ai, and its undo restores them", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 2, 7) * 1000 })
    const k = kestrelBooks()
    // Kestrel at 100%, with no loans: 1,500.00 on Sep 15, Oct 15 and Nov 15, 1,510.00 on Dec 15 and 1,700.00 on Jan 15.
    const draw = (day: string, cents: number): string => {
      kestrelLine(KESTREL.kestrel, day, -cents, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
      return kestrelLine(KESTREL.checking, day, cents, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    }
    const ids = { sep: draw('2026-09-15', 150_000), oct: draw('2026-10-15', 150_000), nov: draw('2026-11-15', 150_000), dec: draw('2026-12-15', 151_000), jan: draw('2027-01-15', 170_000) }
    await closeDueMonths()
    await checkClosed()
    assert.deepEqual(listSnapshots(1000).map((s) => s.month).sort(), span('2026-09', '2027-01'))
    // November and December closed as inferred regular draws, December's Draws run rate 1,003.33.
    assert.deepEqual(['2026-11', '2026-12'].map((m) => figures(m).identity.venturesCents), [0, 0])
    const runRate = (month: string): number | null | undefined => getWaterfall({ from: month, to: month }).rows.flatMap((r) => r.parts).find((p) => p.key === `draw:${k}`)?.runRateCents
    assert.equal(runRate('2026-12'), 100_333)

    const answer = runTool('set_venture_money', { transaction_ids: [ids.sep, ids.oct, ids.jan], venture: 'Kestrel Studio', intent: 'draw', regular: true }, 'assistant')
    assert.deepEqual([runRate('2026-12'), runRate('2027-01')], [150_333, 157_000])
    const run = await checkClosed()
    assert.deepEqual([months(run.changed), run.reclosed], [span('2026-09', '2027-01'), []])
    assert.deepEqual([...new Set(run.changed.map((c) => `${c.cause} ${c.batch}`))], [`ai change:${answer.changeId}`])
    assert.deepEqual([batches().length, issuesOf('month_changed').length], [1, 1])
    // September's own line moved from Ventures to a draw; December's lines didn't, its run rates did.
    assert.deepEqual(diffSnapshot('2026-09')!.lines.map((l) => [l.key.startsWith(ids.sep), l.change, l.fromCls, l.toCls, l.cause]), [[true, 'restaged', 'venture', 'income', 'ai']])
    assert.deepEqual(diffSnapshot('2026-12')!.lines, [])
    assert.deepEqual(diffSnapshot('2026-12')!.inputs.map((i) => [i.kind, i.cause]), [['earlierMonth', 'ai']])

    revert(answer.changeId)
    const back = await checkClosed()
    assert.deepEqual([[...back.restored].sort(), changedMonths(), issuesOf('month_changed')], [span('2026-09', '2027-01'), [], []])
    noSilentChange('the answer undone')
  })

  test("example C closed, then Review's reimbursement on September: the draws inferred after it go, and every month that moves is Review's, ai in its batch", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 2, 7) * 1000 })
    kestrelBooks()
    const draw = (day: string, cents: number): string => {
      kestrelLine(KESTREL.kestrel, day, -cents, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
      return kestrelLine(KESTREL.checking, day, cents, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    }
    const sep = draw('2026-09-15', 150_000)
    draw('2026-10-15', 150_000)
    const nov = draw('2026-11-15', 150_000)
    draw('2026-12-15', 151_000)
    draw('2027-01-15', 170_000)
    await closeDueMonths()
    await checkClosed()
    const answer = runTool('set_venture_money', { transaction_ids: [sep], venture: 'Kestrel Studio', intent: 'reimbursement' }, 'assistant')
    const run = await checkClosed()
    // September only moved its transfer from Ventures to Bought assets, at 100%: it re-closes by itself.
    assert.deepEqual(run.reclosed.map((r) => [r.month, r.why]), [['2026-09', 'boundaryMoved']])
    assert.ok(months(run.changed).includes('2026-11'))
    assert.deepEqual([...new Set(run.changed.map((c) => `${c.cause} ${c.batch}`))], [`ai change:${answer.changeId}`])
    assert.deepEqual(diffSnapshot('2026-11')!.lines.map((l) => [l.key.startsWith(nov), l.change, l.fromCls, l.toCls, l.cause]), [[true, 'restaged', 'income', 'venture', 'ai']])
    assert.equal(batches().length, 1)
    noSilentChange('the reimbursement')
  })
})

describe('a change nothing in the journal names', () => {
  test("intent parts written with no journal entry, as an inference or a remembered rule gives them, restate a closed month with cause rule", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-01-01', share_pct: 50 }, 'assistant')
    await closeDueMonths()
    await checkClosed()
    db.setVentureMoney(t.repair, null, 'line', [{ ventureId: t.venture, intent: 'reimbursement', cents: -25_000, interestCents: 0, regular: null, source: 'review' }])
    const run = await checkClosed()
    assert.deepEqual(run.changed.map((c) => [c.month, c.cause, c.label]), [['2026-10', 'rule', 'A series, rule or setting']])
    assert.deepEqual(diffSnapshot('2026-10')!.lines.map((l) => [l.change, l.fromCls, l.toCls, l.cause]), [['restaged', 'venture', 'capital', 'rule']])
  })
})
