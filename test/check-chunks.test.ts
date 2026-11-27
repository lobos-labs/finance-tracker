import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { configureLicense } from '../src/main/license.ts'
import { ENGINE_VERSION } from '../src/main/lines.ts'
import { balancesDigest, changedMonths, checkClosed, closeDueMonths, diffSnapshot, linesDigest, listSnapshots, rowsDigest, type CheckRun } from '../src/main/snapshots.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { getWaterfall, monthClose } from '../src/main/waterfall.ts'
import type { StageId } from '../src/shared/types.ts'
import { shiftMonth } from '../src/shared/zone.ts'
import { noonOn } from './days.ts'
import { largeLedger } from './fixtures/large-ledger.ts'
import * as hh from './fixtures/waterfall-household.ts'

// A check cut short by its limit carries on where it stopped (waterfall spec 2, Silent rewrites and its Cost): run
// in chunks, a minute apart, it finds the same changed months as one run does, in the same batches with the same
// causes, and each shows the same diff and the same closed figures on Home.

configureLicense({ dev: true })

const nov = (day: number): number => noonOn(2026, 11, day)
const cat = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
/** `count` months from one (YYYY-MM). */
const months = (from: string, count: number): string[] => Array.from({ length: count }, (_, k) => shiftMonth(from, k))
/** A line on a payee in a month, the first of them. */
const find = (description: string, month: string): string => db.all<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE description = ? ORDER BY posted', description).find((r) => db.dayKey(r.posted).startsWith(month))!.id

/** One check, or checks of `limit` months each a minute apart until none is left. */
async function checks(limit?: number): Promise<CheckRun[]> {
  const runs: CheckRun[] = []
  do {
    runs.push(await checkClosed({ limit }))
    mock.timers.tick(60_000)
  } while (runs[runs.length - 1].left > 0)
  return runs
}

/**
 * What the checks found: every month they recomputed, the changed months (their version, cause, batch and label),
 * each one's diff and Home's closed figures for it, and the month_changed issue; and that a check after them finds
 * nothing to do, and, in chunks, that every closed month is its latest close's or shows as changed.
 */
async function found(limit?: number): Promise<Record<string, unknown>> {
  const runs = await checks(limit)
  const again = await checkClosed()
  assert.deepEqual([again.checked, again.changed], [[], []])
  if (limit !== undefined) assert.ok(runs.length > 1, `${runs.length} run`)
  for (const s of limit === undefined ? [] : listSnapshots(1000).filter((x, i, all) => all.findIndex((y) => y.month === x.month) === i)) {
    const c = monthClose(s.month)
    const same = linesDigest(c.lines) === s.digests.lines && balancesDigest(c.balances) === s.digests.balances && rowsDigest(c.waterfall) === s.digests.rows
    assert.equal(s.status === 'changed', !same, `${s.month} is ${s.status}`)
  }
  const changed = changedMonths()
  assert.ok(changed.length > 0)
  // A line by its transaction's description and day: the household's ids count on across the books a process makes.
  const named = (key: string): string =>
    key.replace(/^[^:]+/, (id) => {
      const t = db.get<{ description: string; posted: number }>('SELECT description, posted FROM transactions WHERE id = ?', id)
      return t ? `${t.description} ${db.dayKey(t.posted)}` : id
    })
  return {
    checked: runs.flatMap((r) => r.checked).sort(),
    reclosed: runs.flatMap((r) => r.reclosed),
    failed: runs.flatMap((r) => r.failed),
    changed: changed.map(({ since, ...c }) => c),
    diffs: changed.map((c) => {
      const d = diffSnapshot(c.month)!
      return { ...d, lines: d.lines.map((l) => ({ ...l, key: named(l.key) })) }
    }),
    home: changed.map((c) => getWaterfall({ from: c.month, to: c.month }).closed),
    issue: openIssues()
      .filter((i) => i.kind === 'month_changed')
      .map((i) => [i.key, i.summary])
  }
}

/**
 * Section 5's household closed as version 1 closed it (test/snapshot-changes.test.ts): every month's version and
 * inputs stamp version 1's, so a check recomputes all 24, and November 2024's pay at 26 checks a year, which version
 * 2 restates.
 */
function asVersion1(): void {
  const runRates: Partial<Record<StageId, number>> = { gross: 650_000, taxes: 155_025, benefits: 20_800, savedAtWork: 65_000, takeHome: 409_175, elective: 191_975, leftOver: 160_308, saved: 254_425, invested: 98_283 }
  db.run("UPDATE month_snapshots SET engine_version = ?, inputs_stamp = 'version 1'", ENGINE_VERSION - 1)
  db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%' OR key LIKE 'snapshots.stamp:%' OR key = 'snapshots.sweep'")
  for (const r of db.all<{ month: string; rows: string; identity: string }>('SELECT month, "rows", identity FROM month_snapshots')) {
    const frozen = JSON.parse(r.rows) as { rows: Array<{ id: StageId; runRateCents: number | null }>; series?: string; raw?: unknown }
    delete frozen.series
    delete frozen.raw
    if (r.month !== '2024-11') {
      db.run('UPDATE month_snapshots SET "rows" = ? WHERE month = ?', JSON.stringify(frozen), r.month)
      continue
    }
    const at = (id: StageId, cents: number | null): number | null => runRates[id] ?? cents
    const w = monthClose(r.month).waterfall
    frozen.rows = frozen.rows.map((x) => ({ ...x, runRateCents: at(x.id, x.runRateCents) }))
    db.run(
      'UPDATE month_snapshots SET "rows" = ?, identity = ?, rows_digest = ? WHERE month = ?',
      JSON.stringify(frozen),
      JSON.stringify({ ...JSON.parse(r.identity), toleranceCents: 2_046 }),
      rowsDigest({ ...w, rows: w.rows.map((x) => ({ ...x, runRateCents: at(x.id, x.runRateCents) })) }),
      r.month
    )
  }
}

describe('a check run in chunks', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("on section 5's household closed as version 1, with a dinner Review filed as Travel in June 2025 and groceries the user filed as Travel in February 2026: three batches, the same in chunks of five months as in one run", async () => {
    const seen: Record<string, Record<string, unknown>> = {}
    for (const [how, limit] of [
      ['one run', undefined],
      ['chunks', 5]
    ] as const) {
      mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
      hh.household()
      await closeDueMonths()
      asVersion1()
      runTool('categorize', { transaction_ids: [find('CORNER BISTRO', '2025-06')], category: 'Travel' }, 'assistant')
      db.setTransactionFields(find('FRESHWAY MARKET', '2026-02'), { categoryId: cat('Travel'), source: 'user' })
      seen[how] = await found(limit)
      db.closeDb()
      mock.timers.reset()
    }
    // Review's categorize is the journal's fifth entry, after the fixture's own four.
    const batches = [...new Set((seen['one run'].changed as Array<{ cause: string; batch: string }>).map((c) => `${c.cause} ${c.batch.replace(/\d{6,}$/, 'sweep')}`))].sort()
    assert.deepEqual(batches, ['ai change:5', `engine engine:${ENGINE_VERSION}`, 'user user:sweep'])
    assert.deepEqual(seen.chunks, seen['one run'])
  })

  test('on the large ledger, with a purchase Review filed as Travel in May 2023 and one the user filed as Travel in February 2025: two batches, the same in chunks of five months as in one run', async () => {
    const seen: Record<string, Record<string, unknown>> = {}
    for (const [how, limit] of [
      ['one run', undefined],
      ['chunks', 5]
    ] as const) {
      mock.timers.enable({ apis: ['Date'], now: nov(7) * 1000 })
      db.openDb(':memory:')
      largeLedger()
      await closeDueMonths()
      await checkClosed()
      const groceries = (month: string): string => db.all<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE category_id = ? ORDER BY posted', cat('Groceries')).find((r) => db.dayKey(r.posted).startsWith(month))!.id
      runTool('categorize', { transaction_ids: [groceries('2023-05')], category: 'Travel' }, 'assistant')
      db.setTransactionFields(groceries('2025-02'), { categoryId: cat('Travel'), source: 'user' })
      seen[how] = await found(limit)
      db.closeDb()
      mock.timers.reset()
    }
    const changed = seen['one run'].changed as Array<{ month: string; cause: string; batch: string }>
    assert.deepEqual([...new Set(changed.map((c) => `${c.cause} ${c.batch.replace(/\d{6,}$/, 'sweep')}`))].sort(), ['ai change:1', 'user user:sweep'])
    assert.deepEqual(changed.map((c) => c.month).sort(), [...months('2023-05', 12), ...months('2025-02', 12)])
    assert.deepEqual(seen.chunks, seen['one run'])
  })
})
