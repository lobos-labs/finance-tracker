import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { ledgerLines, perimeter, seriesByKey } from '../src/main/lines.ts'
import { ACCEPT_AT_LEAST, ACCEPT_HOLD_MS, ACCEPT_PER_CALL, acceptCloseChanges, BOOKS_TABLES, balancesDigest, changedMonths, checkClosed, closeDueMonths, deleteClose, inputsStamp, linesDigest, listSnapshots, rawDigest, rowsDigest } from '../src/main/snapshots.ts'
import { runTool } from '../src/main/tools.ts'
import { monthClose } from '../src/main/waterfall.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { MonthSnapshot } from '../src/shared/types.ts'
import { busyMs, busyOf } from './cost.ts'
import { noonOn } from './days.ts'
import { largeLedger } from './fixtures/large-ledger.ts'
import * as tie from './fixtures/tieout.ts'
import * as hh from './fixtures/waterfall-household.ts'

// Checking closed months without holding the window's process (waterfall spec 2, Silent rewrites and its Cost): a
// check's look at the books is taken a step at a time, each shorter than recomputing one month, and keeps the
// digests the look in one stretch kept; a write between two steps is read by that check or the next one, and the
// months it moves are recomputed once; a write nothing a closed month reads costs a digest of the books; and
// accepting a change in the window's process keeps four months a call at least, and more while the call stays
// within a second.

configureLicense({ dev: true })

const nov = (day: number): number => noonOn(2026, 11, day)
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const closedMonths = (): string[] => [...new Set(listSnapshots(1000).map((s) => s.month))].sort()
const latest = (month: string): MonthSnapshot | undefined => listSnapshots(1000).find((s) => s.month === month)
const cat = (name: string): number => db.listCategories().find((c) => c.name === name)!.id

/** What a month's check kept: what it read when its figures last equaled its close's, and when it was last found changed. */
interface Kept {
  v: number
  same: { raw: string; parts?: Record<string, string> | null; lines: string; series: string | null; stamp: string; engine?: number; ahead?: string; claims?: Record<string, string> }
  seen?: Kept['same']
}
const keptOf = (month: string): Kept | null => {
  const v = db.getSetting(`snapshots.checked:${month}`)
  return v ? (JSON.parse(v) as Kept) : null
}

/**
 * The look at the books as an earlier check took it, in one stretch (survey, rawRead and
 * inputsStamp): each closed month's lines' facts and series digests from one classification of every closed month
 * from 13 months before the first, its raw digest over the accounts its bridge reads, and the inputs stamp.
 */
function lookAtOnce(): Map<string, Kept['same']> {
  const months = closedMonths()
  const from = months[0]
  const to = months[months.length - 1]
  const facts = new Map<string, string[]>()
  const keys = new Map<string, Set<string>>()
  for (const l of ledgerLines(`${shiftMonth(from, -13)}-01`, lastDay(to))) {
    const m = l.day.slice(0, 7)
    if (m >= from) facts.set(m, [...(facts.get(m) ?? []), `${l.key}|${l.cls}|${l.cents}|${l.owner ?? ''}|${l.seriesKey ?? ''}|${l.paycheckKey ?? ''}|${l.assetId ?? ''}`])
    if (l.seriesKey) keys.set(m, new Set([...(keys.get(m) ?? []), l.seriesKey]))
  }
  const series = seriesByKey()
  const accounts = db.listAccounts()
  const counted = db.countedAccounts()
  const stamp = inputsStamp()
  const out = new Map<string, Kept['same']>()
  for (const m of months) {
    const read: string[] = []
    for (let k = 13; k >= 0; k--) read.push(...(keys.get(shiftMonth(m, -k)) ?? []))
    const seriesText = [...new Set(read)]
      .sort()
      .map((k) => {
        const s = series.get(k)
        return s ? `${k}|${s.kind}|${s.cadence}|${s.variable ? 1 : 0}|${s.confirmed ? 1 : 0}` : `${k}|`
      })
      .join('\n')
    out.set(m, { raw: rawDigest(m, [...new Set([...perimeter(m, accounts), ...counted])]), lines: sha256((facts.get(m) ?? []).sort().join('\n')), series: sha256(seriesText), stamp })
  }
  return out
}

/** That every closed month is its latest close's, or shows as changed, and that every month shown changed differs. */
function noSilentChange(where: string): void {
  for (const m of closedMonths()) {
    const s = latest(m)!
    const c = monthClose(m)
    const same = linesDigest(c.lines) === s.digests.lines && balancesDigest(c.balances) === s.digests.balances && rowsDigest(c.waterfall) === s.digests.rows
    assert.equal(s.status === 'changed', !same, `${where}: ${m} is ${s.status}, and its figures are ${same ? '' : 'not '}its close's`)
  }
}

/**
 * Small books on one checking account from September 2024 to October 2026, with November open: pay of 3,000.00 on the
 * 1st, rent of 1,200.00 on the 2nd and groceries of 400.00 on the 10th each month, `extra` lines among them, and a
 * statement at each month's end, so no month has a gap. Its 26 closed months take three steps of raw digests.
 */
function books(extra: Array<[string, number, string, string]> = []): void {
  db.openDb(':memory:')
  db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.updateAccount('csv:chk', { assetType: 'cash' })
  const list: Array<[string, number, string, string]> = []
  for (let m = '2024-09'; m <= '2026-10'; m = shiftMonth(m, 1)) {
    list.push([`${m}-01`, 300_000, 'Gale Payroll', 'Paycheck'], [`${m}-02`, -120_000, 'Birchwood Apartments', 'Housing'], [`${m}-10`, -40_000, 'Freshway Market', 'Groceries'])
  }
  list.push(...extra)
  const sums = new Map<string, number>()
  db.inTransaction(() => {
    list.forEach(([day, cents, payee, category], i) => {
      bookLine(`bk${i + 1}`, day, cents, payee, category)
      sums.set(day.slice(0, 7), (sums.get(day.slice(0, 7)) ?? 0) + cents)
    })
  })
  let balance = 500_000
  db.setBalancePoint('csv:chk', '2024-08-31', balance)
  for (let m = '2024-09'; m <= '2026-10'; m = shiftMonth(m, 1)) {
    balance += sums.get(m) ?? 0
    db.setBalancePoint('csv:chk', lastDay(m), balance)
  }
  db.setBalancePoint('csv:chk', '2026-11-03', balance)
}

/** A line on the small books' checking account, as an import brings it. */
function bookLine(id: string, day: string, cents: number, payee: string, category: string): void {
  const [y, m, d] = day.split('-').map(Number)
  db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description: payee.toUpperCase(), pending: false })
  db.setTransactionFields(id, { categoryId: cat(category), source: 'user', merchant: payee })
}

/** Lumen Streaming paid on Jul 7 and Aug 7, 2025: two payments, no series, so Everyday; the raw digests' second step starts in September. */
const LUMEN: Array<[string, number, string, string]> = [
  ['2025-07-07', -1_299, 'Lumen Streaming', 'Subscriptions'],
  ['2025-08-07', -1_299, 'Lumen Streaming', 'Subscriptions']
]
/**
 * Its third payment, Sep 7, 2025, found late (a 12.99 gap in September, within its tolerance): a monthly series now,
 * so July's and August's lines are committed. July's raw digest doesn't move (it reads the rows up to its next
 * statement, Aug 31); August's does (up to Sep 30).
 */
const thirdLumen = (): void => bookLine('lumen-sep', '2025-09-07', -1_299, 'Lumen Streaming', 'Subscriptions')

/** A note on a transaction: the books' digest moves, so a check takes its look, and nothing a closed month reads does. */
const note = (text: string): void => void db.run('UPDATE transactions SET notes = ? WHERE id = ?', text, 'bk1')

/** A check, with what comes after each of its pauses. */
async function stepsOf(o: { limit?: number } = {}): Promise<string[]> {
  const seen: string[] = []
  await checkClosed({ ...o, between: (next) => seen.push(next) })
  return seen
}

describe("a check's look, a step at a time", () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** That every closed month's check keeps what the look in one stretch reads of it now: as the month it equals, or the changed month it last saw. */
  function keepsTheLook(where: string): void {
    const once = lookAtOnce()
    for (const m of closedMonths()) {
      const kept = keptOf(m)
      assert.ok(kept, `${where}: ${m} was checked`)
      const d = kept.seen ?? kept.same
      assert.deepEqual({ raw: d.raw, lines: d.lines, series: d.series, stamp: d.stamp }, once.get(m), `${where}: ${m}`)
    }
  }

  for (const [name, build] of [
    ["section 5's household", () => void hh.household()],
    ['the tie-out', () => void tie.tieOut()],
    ['the sample household', () => (db.openDb(':memory:'), void loadDemoData())]
  ] as Array<[string, () => void]>) {
    test(`${name}: every month's check keeps the digests the look in one stretch read, and the next check finds nothing to recompute`, async () => {
      if (name !== 'the sample household') mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
      build()
      await closeDueMonths()
      const steps = await stepsOf()
      const months = closedMonths()
      assert.ok(months.length >= 6, `${months.length} closed months`)
      // The look's steps: the raw digests twelve months a step, the series, the classification, its digests, and the plan.
      assert.deepEqual(steps, [...months.filter((_, i) => i % 12 === 0).map((m) => `raw:${m}`), 'series', 'lines', 'survey', 'plan'])
      keepsTheLook(name)
      // Nothing moved since the closes: each month's raw digest is its close's own.
      for (const m of months) assert.equal(keptOf(m)!.same.raw, latest(m)!.digests.raw, `${name}: ${m}'s raw digest`)
      // A write in the open month moves the books, not a closed month: the whole look again, with nothing changed.
      db.upsertTransaction({ id: 'open-cafe', accountId: db.listAccounts().find((a) => a.assetType === 'cash' && a.bucketId === null)!.id, posted: db.now(), amountCents: -1_250, description: 'CORNER CAFE', pending: false })
      const again = await checkClosed()
      assert.deepEqual([again.changed, again.reclosed, again.failed], [[], [], []])
      keepsTheLook(`${name}, after a line in the open month`)
    })
  }

  test('a series whose payments fall in two steps of the raw digests: its third payment changes the months of the first step its lines moved in, as well as its own', async () => {
    mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
    books(LUMEN)
    await closeDueMonths()
    assert.deepEqual(await stepsOf(), ['raw:2024-09', 'raw:2025-09', 'raw:2026-09', 'series', 'lines', 'survey', 'plan'])
    keepsTheLook('the small books')
    const before = lookAtOnce()
    thirdLumen()
    const now = lookAtOnce()
    // July's raw digest, read in the first step, didn't move: its lines did. August's raw digest reads September's rows.
    assert.deepEqual(
      ['2025-07', '2025-08', '2025-09'].map((m) => [now.get(m)!.raw === before.get(m)!.raw, now.get(m)!.lines === before.get(m)!.lines]),
      [
        [true, false],
        [false, false],
        [false, false]
      ]
    )
    const run = await checkClosed()
    assert.deepEqual(run.failed, [])
    assert.deepEqual(run.changed.map((c) => c.month).slice(0, 3), ['2025-07', '2025-08', '2025-09'])
    noSilentChange('the third payment')
    keepsTheLook('after the third payment')
    assert.deepEqual((await checkClosed()).checked, [])
  })
})

describe('a write between two steps of a check', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** The months a write changes, on new books checked after it with nothing between. */
  async function changedBy(write: () => void, first?: () => void): Promise<string[]> {
    books(LUMEN)
    await closeDueMonths()
    await checkClosed()
    first?.()
    write()
    await checkClosed()
    noSilentChange('the write alone')
    return changedMonths().map((c) => c.month).sort()
  }

  test("is read by that check or the next: the third payment written at each of the look's pauses changes the same months as written before it", async () => {
    const want = await changedBy(thirdLumen)
    assert.ok(want.includes('2025-07') && want.includes('2025-09'), want.join(', '))
    db.closeDb()
    books(LUMEN)
    await closeDueMonths()
    const pauses = await stepsOf()
    db.closeDb()
    for (const at of pauses) {
      books(LUMEN)
      await closeDueMonths()
      await checkClosed()
      // A note first, so the check takes its look; then the run that was looking when the write landed, and the one
      // the write asks for.
      note('looked at')
      let wrote = false
      const run = await checkClosed({ between: (next) => void (next === at && !wrote && (thirdLumen(), (wrote = true))) })
      assert.ok(wrote, at)
      assert.deepEqual(run.failed, [], at)
      await checkClosed()
      assert.deepEqual(changedMonths().map((c) => c.month).sort(), want, `written before ${at}`)
      noSilentChange(`written before ${at}`)
      assert.deepEqual((await checkClosed()).changed, [], `${at}: a third check`)
      db.closeDb()
    }
  })

  /**
   * Section 5's household checked once, with a note so the next check takes its look, and the months recomputed by
   * that check and the two after it, run by run: `write` lands at the look's pause `at`, or before the check with none.
   */
  async function recomputedBy(write: () => void, at: string | null): Promise<string[][]> {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    db.run('UPDATE transactions SET notes = ? WHERE id = (SELECT id FROM transactions ORDER BY posted LIMIT 1)', 'looked at')
    if (at === null) write()
    let wrote = at === null
    const runs = [await checkClosed({ between: (next) => void (next === at && !wrote && (write(), (wrote = true))) })]
    assert.ok(wrote, `${at}`)
    runs.push(await checkClosed(), await checkClosed())
    assert.deepEqual(runs.flatMap((r) => r.failed), [], `${at}`)
    noSilentChange(`written before ${at ?? 'the check'}`)
    const out = runs.map((r) => r.checked)
    db.closeDb()
    return out
  }

  /** The look's pauses on section 5's household, after a note, in order. */
  async function householdPauses(): Promise<string[]> {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    db.run('UPDATE transactions SET notes = ? WHERE id = (SELECT id FROM transactions ORDER BY posted LIMIT 1)', 'looked at')
    const pauses = await stepsOf()
    db.closeDb()
    return pauses.filter((p) => !p.startsWith('month:'))
  }

  test("recomputes the months a line moves once, wherever in the look it lands: a line on the Visa in March 2026, written at each pause, recomputes as many months across three checks as written before the first", async () => {
    const bistro = (): void => hh.line(hh.ACCOUNTS.visa, '2026-03-14', -2_500, 'CORNER BISTRO', 'Dining Out', 'Corner Bistro')
    const before = (await recomputedBy(bistro, null)).flat()
    assert.ok(before.includes('2026-03') && before.includes('2026-10'), before.join(', '))
    for (const at of await householdPauses()) {
      const runs = await recomputedBy(bistro, at)
      assert.deepEqual(runs.flat().sort(), [...before].sort(), `written before ${at}: ${JSON.stringify(runs)}`)
    }
  })

  test('recomputes a month Review closes while the look is taken once, with the digests the next look reads: October closed again at each pause, after its close was undone', async () => {
    const closeOctober = (): void => void runTool('close_month', { month: '2026-10' }, 'assistant')
    for (const at of [null, ...(await householdPauses())]) {
      hh.household()
      await closeDueMonths()
      // October's close undone, so the look reads the months to September.
      deleteClose('2026-10', 1)
      await checkClosed()
      await checkClosed()
      db.run('UPDATE transactions SET notes = ? WHERE id = (SELECT id FROM transactions ORDER BY posted LIMIT 1)', 'looked at')
      if (at === null) closeOctober()
      let wrote = at === null
      const runs = [await checkClosed({ between: (next) => void (next === at && !wrote && (closeOctober(), (wrote = true))) })]
      runs.push(await checkClosed(), await checkClosed())
      assert.ok(wrote, `${at}`)
      noSilentChange(`closed before ${at ?? 'the check'}`)
      const checked = runs.map((r) => r.checked)
      // Closed before the check, the look reads it with the rest; closed during it, it's recomputed by that check, once.
      assert.deepEqual(checked, at === null ? [[], [], []] : [['2026-10'], [], []], `closed before ${at ?? 'the check'}`)
      assert.deepEqual(changedMonths(), [], `closed before ${at ?? 'the check'}`)
      db.closeDb()
    }
  })

  test('is read by that check or the next while it recomputes months: written before each month a category renamed recomputes, it changes the same months', async () => {
    const rename = (): void => {
      const coffee = db.listCategories().find((c) => c.name === 'Coffee')!
      db.saveCategory({ ...coffee, name: 'Coffee & Tea' })
    }
    const want = await changedBy(thirdLumen, rename)
    for (const at of ['2024-09', '2025-07', '2025-08', '2025-09', '2025-10', '2026-10']) {
      db.closeDb()
      books(LUMEN)
      await closeDueMonths()
      await checkClosed()
      rename()
      let wrote = false
      const run = await checkClosed({ between: (next) => void (next === `month:${at}` && !wrote && (thirdLumen(), (wrote = true))) })
      assert.ok(wrote && run.checked.length === closedMonths().length, `before ${at}: ${run.checked.length} months recomputed`)
      await checkClosed()
      assert.deepEqual(changedMonths().map((c) => c.month).sort(), want, `written before ${at}`)
      noSilentChange(`written before ${at}`)
    }
  })
})

describe('a write no closed month reads', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("costs a digest of the books: no look, until the books, what the checks keep or the day move, or a write landed while a look was taken", async () => {
    hh.household()
    await closeDueMonths()
    assert.ok((await stepsOf()).length > 0, 'the first look after the backfill')
    // Nothing moved since a look that found nothing: no look.
    assert.deepEqual(await stepsOf(), [])
    // A setting no month reads, a goal, a note on the calendar, a fact, the chat: no look.
    db.setSetting('focus.points', '2')
    db.addFact('The user is saving for a canoe')
    db.addCalendarEvent({ day: '2026-11-20', title: 'Dentist' })
    db.setSetting('review.session', JSON.stringify({ items: [] }))
    assert.deepEqual(await stepsOf(), [])
    // A transaction's note is in the books' digest (its row is): the look is taken, and finds nothing.
    const fresh = db.all<{ id: string }>('SELECT id FROM transactions ORDER BY posted DESC LIMIT 1')[0].id
    db.run('UPDATE transactions SET notes = ? WHERE id = ?', 'checked with the bank', fresh)
    const noted = await checkClosed({ between: () => {} })
    assert.deepEqual([noted.checked, noted.changed], [[], []])
    assert.deepEqual(await stepsOf(), [])
    // A write while the look is taken: the next check looks again.
    db.run('UPDATE transactions SET notes = ? WHERE id = ?', 'twice', fresh)
    await checkClosed({ between: (next) => void (next === 'plan' && db.run('UPDATE transactions SET notes = ? WHERE id = ?', 'thrice', fresh)) })
    assert.ok((await stepsOf()).length > 0, 'after a write mid-look')
    assert.deepEqual(await stepsOf(), [])
    // What a check keeps, written by Review's accept or its undo, or a close: the look is taken.
    db.writingCloses(() => db.setSetting('snapshots.checked:2026-10', db.getSetting('snapshots.checked:2026-10')!.replace('"v":1', '"v":1 ')))
    assert.ok((await stepsOf()).length > 0, "after a month's check was rewritten")
    // A new day: a capital window for money lent reaches to today.
    mock.timers.setTime(nov(8) * 1000)
    assert.ok((await stepsOf()).length > 0, 'on a new day')
    assert.deepEqual(await stepsOf(), [])
    // A line in a closed month: the look, and the month recomputed.
    hh.line(hh.ACCOUNTS.visa, '2026-09-14', -2_500, 'CORNER BISTRO', 'Dining Out', 'Corner Bistro')
    const run = await checkClosed()
    assert.ok(run.checked.includes('2026-09'), run.checked.join(', '))
  })

  test('every table is one the look reads, in the books digest, or one it reads nothing of', () => {
    db.openDb(':memory:')
    // Why each other table can't move a closed month's figures as the look reads them.
    const unread: Record<string, string> = {
      ai_requests: "the AI's request log",
      ai_usage: "the AI's usage",
      bridge_requests: "the file bridge's requests",
      budget_rollover: "budgets: read by Left over's targets and the levers, not by a classification or a raw digest",
      budget_targets: 'budgets, as above',
      budgets: 'budgets, as above',
      calendar_events: 'the calendar',
      changes: 'the journal',
      documents: 'the documents inbox',
      facts: "what Review remembers",
      goal_accounts: 'goals: no close keeps them',
      goal_contributions: 'goals, as above',
      goals: 'goals, as above',
      holdings: "investments' positions: no classification reads them",
      month_snapshots: 'the closes: in what the checks keep (checkState)',
      paycheck_withholding: 'the withholding before paystubs, migrated to them',
      pending_actions: "Review's calls waiting for approval",
      questions: "Review's saved questions",
      resolved_issues: "Review's resolved issues",
      settings: "the settings a month reads are in the inputs stamp; the checks' own in checkState",
      snapshot_balances: 'the closes, as month_snapshots',
      snapshot_lines: 'the closes, as month_snapshots',
      sqlite_sequence: "SQLite's own counters"
    }
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)
    assert.deepEqual(tables.filter((t) => !(BOOKS_TABLES as readonly string[]).includes(t)), Object.keys(unread).sort())
    for (const t of BOOKS_TABLES) assert.ok(tables.includes(t), t)
    db.closeDb()
  })
})

describe("accepting a change in the window's process", () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** Runs `f` as Electron's main process, where the window's calls are answered. */
  async function inWindowProcess<T>(f: () => T | Promise<T>): Promise<T> {
    const p = process as { type?: string }
    const was = p.type
    p.type = 'browser'
    try {
      return await f()
    } finally {
      p.type = was
    }
  }

  /** Section 5's household with every closed month changed: the Visa's APR moves each one's Committed run rate. */
  async function allChanged(): Promise<void> {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    db.updateAccount(hh.ACCOUNTS.visa, { apr: 26 })
    await checkClosed()
    assert.equal(changedMonths().length, 24)
  }

  test('keeps four months a call at least, more while they fit in the hold, the oldest first, and says how many are left', async () => {
    await allChanged()
    const kept = (r: { kept: MonthSnapshot[] }): string[] => r.kept.map((s) => s.month)
    // No time to spare, as on large books where one month takes longer than the hold: four a call.
    const four = acceptCloseChanges(undefined, 0)
    assert.deepEqual([kept(four), four.left], [hh.MONTHS.slice(0, ACCEPT_AT_LEAST), 24 - ACCEPT_AT_LEAST])
    // The months named are kept, the oldest first.
    assert.deepEqual(kept(acceptCloseChanges([hh.MONTHS[9], hh.MONTHS[5]], 0)), [hh.MONTHS[5], hh.MONTHS[9]])
    // All the time there is: ACCEPT_PER_CALL.
    const many = acceptCloseChanges(undefined, Infinity)
    const after = hh.MONTHS.slice(ACCEPT_AT_LEAST).filter((m) => m !== hh.MONTHS[5] && m !== hh.MONTHS[9])
    assert.deepEqual([kept(many), many.left], [after.slice(0, ACCEPT_PER_CALL), after.length - ACCEPT_PER_CALL])
    // Outside the window's process the default is ACCEPT_PER_CALL; in it, a month after the fourth only while the
    // call stays within ACCEPT_HOLD_MS, which these books' months, a few tens of milliseconds each, all fit in.
    const rest = await inWindowProcess(() => acceptCloseChanges())
    assert.deepEqual([kept(rest), rest.left], [after.slice(ACCEPT_PER_CALL), 0])
    assert.deepEqual([ACCEPT_AT_LEAST, ACCEPT_HOLD_MS], [4, 1000])
  })

  test('accept_close_changes there is journaled and undone like any call, and one cut off keeps none of its months', async () => {
    await allChanged()
    const first = await inWindowProcess(() => runTool('accept_close_changes', {}, 'assistant'))
    const months = (first.result as { months: Array<{ month: string }> }).months.map((m) => m.month)
    assert.ok(months.length >= ACCEPT_AT_LEAST, `${months.length} kept`)
    assert.deepEqual(months, hh.MONTHS.slice(0, months.length))
    assert.equal((first.result as { left: number }).left, 24 - months.length)
    assert.deepEqual(changedMonths().map((c) => c.month).sort(), hh.MONTHS.slice(months.length))
    // Undone: those months are changed again, as they were.
    const c = db.getChange(first.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    db.markChangeUndone(first.changeId!)
    assert.deepEqual(changedMonths().map((x) => x.month).sort(), hh.MONTHS)
    assert.deepEqual(listSnapshots(1000).filter((s) => s.version > 1), [])
    // A call cut off at its first month (a month that can't be written) keeps none and journals nothing.
    db.run(`CREATE TEMP TRIGGER no_first BEFORE INSERT ON month_snapshots WHEN NEW.month = '${hh.MONTHS[0]}' BEGIN SELECT RAISE(ABORT, 'cut off'); END`)
    const versions = listSnapshots(1000).length
    const entries = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM changes')!.n
    await inWindowProcess(() => assert.throws(() => runTool('accept_close_changes', {}, 'assistant'), /cut off/))
    db.run('DROP TRIGGER no_first')
    assert.deepEqual([listSnapshots(1000).length, db.get<{ n: number }>('SELECT COUNT(*) AS n FROM changes')!.n], [versions, entries])
    // And one cut off at its second month, with time for more, keeps neither: its months are one write.
    db.run(`CREATE TEMP TRIGGER no_second BEFORE INSERT ON month_snapshots WHEN NEW.month = '${hh.MONTHS[1]}' BEGIN SELECT RAISE(ABORT, 'cut off'); END`)
    assert.throws(() => acceptCloseChanges(undefined, Infinity), /cut off/)
    db.run('DROP TRIGGER no_second')
    assert.deepEqual([listSnapshots(1000).length, changedMonths().length], [versions, 24])
    // Called until none are left, every month is kept.
    for (let n = 0; changedMonths().length && n < 30; n++) await inWindowProcess(() => runTool('accept_close_changes', {}, 'assistant'))
    assert.deepEqual(changedMonths(), [])
  })
})

describe('what a check holds the window for, on the large ledger', () => {
  const months: string[] = []
  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
    db.openDb(':memory:')
    largeLedger()
    await closeDueMonths()
    await checkClosed()
    months.push(...closedMonths())
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  let n = 0
  /** A line in the open month, a week after the last closed month: the books moved, no closed month did, so the look is taken whole. */
  const openLine = (): void => {
    db.upsertTransaction({ id: `open-${++n}`, accountId: 'csv:chk', posted: nov(7), amountCents: -1_250, description: 'CORNER CAFE', pending: false })
  }

  /** A check with the busy milliseconds each of its steps took (the event loop's, its pauses left out), by what the step was. */
  async function stepped(o: { limit?: number } = {}): Promise<{ run: Awaited<ReturnType<typeof checkClosed>>; steps: Array<[string, number]> }> {
    const steps: Array<[string, number]> = []
    let label = 'start'
    let at = performance.now()
    let was = performance.eventLoopUtilization()
    const lap = (next: string): void => {
      steps.push([label, performance.now() - at - performance.eventLoopUtilization(was).idle])
      label = next
      at = performance.now()
      was = performance.eventLoopUtilization()
    }
    const run = await checkClosed({ ...o, between: lap })
    lap('')
    return { run, steps }
  }

  test("every month's check keeps the digests the look in one stretch read, and a look after a line in the open month keeps them too", async () => {
    const once = lookAtOnce()
    for (const m of months) {
      assert.deepEqual(keptOf(m)?.same, { ...once.get(m)!, parts: keptOf(m)!.same.parts, engine: keptOf(m)!.same.engine, ahead: keptOf(m)!.same.ahead, claims: keptOf(m)!.same.claims }, m)
      assert.equal(keptOf(m)!.same.raw, latest(m)!.digests.raw, `${m}'s raw digest`)
    }
    openLine()
    const run = await checkClosed()
    assert.deepEqual([run.checked, run.changed], [[], []])
    const now = lookAtOnce()
    for (const m of months) assert.deepEqual(keptOf(m)!.same.lines, now.get(m)!.lines, m)
  })

  test("no step of a check's look takes longer than recomputing one month: the longest against the last month's recompute, by paired rounds", async (t) => {
    const last = months[months.length - 1]
    // Paired rounds, in alternating order, and the median of their ratios: npm test runs the files at once. One side is
    // a check's look after a line in the open month, its longest step; the other recomputes the last closed month as a
    // check does, with the series the look keeps found already.
    const ratios: number[] = []
    const seen: string[] = []
    for (let k = 0; k < 6; k++) {
      const ms: Record<string, number> = {}
      let longest = ''
      for (const side of k % 2 ? ['month', 'look'] : ['look', 'month']) {
        openLine()
        if (side === 'look') {
          const { run, steps } = await stepped()
          assert.deepEqual([run.checked, run.changed], [[], []])
          const top = steps.reduce((a, b) => (b[1] > a[1] ? b : a))
          ms.look = top[1]
          longest = top[0]
        } else {
          seriesByKey()
          ms.month = busyMs(() => monthClose(last))
        }
      }
      ratios.push(ms.look / ms.month)
      seen.push(`${longest} ${ms.look.toFixed(0)}/${ms.month.toFixed(0)}`)
    }
    ratios.sort((a, b) => a - b)
    const median = (ratios[2] + ratios[3]) / 2
    t.diagnostic(`the look's longest step against one month's recompute, busy ms by round: ${seen.join(', ')}; median ratio ${median.toFixed(2)}`)
    assert.ok(median <= 1, `the median ratio is ${median.toFixed(2)} (${seen.join(', ')})`)
  })

  test('a check after a write no closed month reads costs under a quarter of a look, by paired rounds', async (t) => {
    const ratios: number[] = []
    const seen: string[] = []
    for (let k = 0; k < 6; k++) {
      const ms: Record<string, number> = {}
      for (const side of k % 2 ? ['look', 'quiet'] : ['quiet', 'look']) {
        if (side === 'quiet') db.setSetting('focus.points', String(k))
        else openLine()
        ms[side] = await busyOf(async () => assert.deepEqual((await checkClosed()).checked, []))
      }
      ratios.push(ms.quiet / Math.max(ms.look, 0.01))
      seen.push(`${ms.quiet.toFixed(0)}/${ms.look.toFixed(0)}`)
    }
    ratios.sort((a, b) => a - b)
    const median = (ratios[2] + ratios[3]) / 2
    t.diagnostic(`a check after a write no month reads against one after a line in the open month, busy ms by round: ${seen.join(', ')}; median ratio ${median.toFixed(2)}`)
    assert.ok(median <= 0.25, `the median ratio is ${median.toFixed(2)} (${seen.join(', ')})`)
  })

  test('the longest hold of a check with nothing changed, after one edit in a closed month and after a category renamed: a step at most, and no step of the look longer than a month recomputed', async (t) => {
    /** A check, with the longest the event loop went unanswered (a timer every millisecond) and its steps' busy milliseconds. */
    const held = async (what: string, o: { limit?: number } = {}): Promise<{ longest: number; look: [string, number]; month: number }> => {
      let longest = 0
      let at = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        longest = Math.max(longest, now - at)
        at = now
      }, 1)
      const { run, steps } = await stepped(o)
      clearInterval(timer)
      const recomputed = steps.filter(([l]) => l.startsWith('month:')).map(([, ms]) => ms)
      const look = steps.filter(([l]) => !l.startsWith('month:')).reduce((a, b) => (b[1] > a[1] ? b : a))
      const step = Math.max(...steps.map(([, ms]) => ms))
      const month = recomputed.length ? Math.max(...recomputed) : 0
      t.diagnostic(
        `${what}: ${run.checked.length} months recomputed; the event loop held at most ${longest.toFixed(0)} ms; the look's longest step ${look[0]}, ${look[1].toFixed(0)} busy ms` +
          (recomputed.length ? `; a month's recompute at most ${month.toFixed(0)} ms` : '')
      )
      // The event loop is answered between every two steps: what holds it longest is one step, and a timer's tick
      // (15.6 ms on Windows) late.
      assert.ok(longest <= step + 50, `${what}: the event loop held ${longest.toFixed(0)} ms, the longest step ${step.toFixed(0)} ms`)
      return { longest, look, month }
    }
    openLine()
    const quiet = await held('a check with nothing changed')
    const groceries = db.all<{ id: string; posted: number }>("SELECT t.id, t.posted FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.name = 'Groceries' ORDER BY t.posted DESC").find((r) => db.dayKey(r.posted).startsWith('2026-09'))!
    db.setTransactionFields(groceries.id, { categoryId: cat('Travel'), source: 'user' })
    const edit = await held('after one edit in 2026-09')
    const coffee = db.listCategories().find((c) => c.name === 'Coffee')!
    db.saveCategory({ ...coffee, name: 'Coffee & Tea' })
    const rename = await held('after a category renamed, 12 months of it', { limit: 12 })
    // No step of a look holds the window longer than one month recomputed does.
    const month = Math.max(edit.month, rename.month)
    for (const [what, h] of [['nothing changed', quiet], ['one edit', edit], ['a category renamed', rename]] as const) {
      assert.ok(h.look[1] <= month, `${what}: the look's ${h.look[0]} took ${h.look[1].toFixed(0)} ms, a month's recompute at most ${month.toFixed(0)} ms`)
    }
  })
})

describe("accepting a change on the large ledger in the window's process", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a month's change and its eleven followers: four months a call at least, so three calls at most", async (t) => {
    db.openDb(':memory:')
    largeLedger()
    await closeDueMonths()
    await checkClosed()
    const months = closedMonths()
    // A November 2025 grocery bill filed as Travel: it and the eleven months after it change.
    const bill = db.all<{ id: string; posted: number }>("SELECT t.id, t.posted FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.name = 'Groceries' ORDER BY t.posted").find((r) => db.dayKey(r.posted).startsWith('2025-11'))!
    db.setTransactionFields(bill.id, { categoryId: cat('Travel'), source: 'user' })
    await checkClosed()
    noSilentChange('the bill filed as Travel')
    const changed = changedMonths().map((c) => c.month).sort()
    assert.deepEqual(changed, months.slice(months.indexOf('2025-11')))
    const calls: string[] = []
    const p = process as { type?: string }
    const was = p.type
    p.type = 'browser'
    try {
      for (let n = 0; changedMonths().length && n < changed.length; n++) {
        const at = performance.now()
        const r = runTool('accept_close_changes', {}, 'assistant')
        calls.push(`${(r.result as { months: unknown[] }).months.length} in ${(performance.now() - at).toFixed(0)} ms`)
      }
    } finally {
      p.type = was
    }
    t.diagnostic(`${changed.length} changed months kept in the window's process, months a call: ${calls.join(', ')}`)
    assert.deepEqual(changedMonths(), [])
    assert.ok(calls.length <= Math.ceil(changed.length / ACCEPT_AT_LEAST), calls.join(', '))
    noSilentChange('every change kept')
  })
})
