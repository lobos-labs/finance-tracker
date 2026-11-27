import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { getBudget, setBudgetRollover, setCategoryTarget } from '../src/main/budget.ts'
import { handlerFor, methodKind } from '../src/main/handlers/table.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { runAssistantTool } from '../src/main/tools.ts'
import { LAST_30_DAYS } from '../src/shared/period.ts'
import type { BudgetRow } from '../src/shared/types.ts'
import { timeIn } from '../src/shared/zone.ts'

// Budget rollover: a category's leftover, or its overspend, carries into the
// next month's available, from the month it was turned on, against the target
// each month had. The ledger's zone is set, so its months are that zone's
// whatever the machine's clock (npm run test:utc runs this in UTC).

configureLicense({ dev: true })

const ZONE = 'America/Chicago'
const dir = mkdtempSync(join(tmpdir(), 'finance-rollover-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const at = (day: string, hour = 12, minute = 0): number => timeIn(day, ZONE, hour, minute)
/** Moves the clock to a time of day (noon by default) on a day in the ledger's zone. */
const clock = (day: string, hour = 12, minute = 0): void => mock.timers.setTime(at(day, hour, minute) * 1000)

let n = 0
const category = (name: string): number => db.saveCategory({ name, kind: 'expense', description: '' }).id
/** A purchase in a category at a time in the ledger's zone. */
function spend(categoryId: number, day: string, cents: number, hour = 12, minute = 0): void {
  const id = `t${n++}`
  db.upsertTransaction({ id, accountId: 'manual:a', posted: at(day, hour, minute), amountCents: -cents, description: `PURCHASE ${id}`, pending: false })
  db.setTransactionFields(id, { categoryId, source: 'user' })
}
function row(categoryId: number, period: string): BudgetRow {
  const r = getBudget(period).rows.find((x) => x.categoryId === categoryId)
  assert.ok(r, `a row for category ${categoryId} in ${period}`)
  return r
}
/** Rollover on, what carried in, and the month's available. */
const rolled = (categoryId: number, period: string): [boolean, number, number | null] => {
  const r = row(categoryId, period)
  return [r.rolloverOn, r.carriedCents, r.availableCents]
}
/** Undoes a change the way the Review chat does. */
const revert = (changeId: number): void => {
  const c = db.getChange(changeId)!
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId)
}

describe('budget rollover', () => {
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: at('2026-09-01') * 1000 })
    process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
    db.openDb(join(dir, 'finance.db'))
    db.setSetting('calendar.timeZone', ZONE)
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a leftover carries into the next month', () => {
    const id = category('Leftover')
    clock('2026-10-05')
    setCategoryTarget(id, 20_000)
    setBudgetRollover(id, true)
    spend(id, '2026-10-06', 9_000)
    spend(id, '2026-10-20', 6_000)
    // The month it's turned on has nothing carried in.
    assert.deepEqual(rolled(id, '2026-10'), [true, 0, 20_000])

    clock('2026-11-10')
    spend(id, '2026-11-02', 1_000)
    assert.deepEqual(rolled(id, '2026-11'), [true, 5_000, 25_000])
    assert.equal(row(id, '2026-11').spentCents, 1_000)
    assert.equal(row(id, '2026-11').budgetCents, 20_000)
    // The last 30 days show the current month's.
    assert.deepEqual(rolled(id, LAST_30_DAYS), [true, 5_000, 25_000])
    // Turned on again while on, it keeps its month.
    setBudgetRollover(id, true)
    assert.deepEqual(rolled(id, '2026-11'), [true, 5_000, 25_000])
  })

  test('an overspend carries, and so on month after month', () => {
    const id = category('Overspent')
    clock('2026-10-05')
    setCategoryTarget(id, 20_000)
    setBudgetRollover(id, true)
    spend(id, '2026-10-06', 26_000)

    clock('2026-11-10')
    assert.deepEqual(rolled(id, '2026-11'), [true, -6_000, 14_000])
    spend(id, '2026-11-05', 10_000)

    clock('2026-12-03')
    spend(id, '2026-12-02', 500)
    assert.deepEqual(rolled(id, '2026-12'), [true, 4_000, 24_000])
    // A charge that posts late in a past month still counts.
    spend(id, '2026-11-30', 3_000)
    assert.deepEqual(rolled(id, '2026-12'), [true, 1_000, 21_000])
  })

  test('a target changed partway through counts for its month on; earlier months keep theirs', () => {
    const id = category('Changed')
    clock('2026-09-03')
    setCategoryTarget(id, 20_000)
    setBudgetRollover(id, true)
    spend(id, '2026-09-10', 15_000)

    clock('2026-10-15')
    setCategoryTarget(id, 30_000)
    spend(id, '2026-10-20', 28_000)

    clock('2026-11-05')
    spend(id, '2026-11-02', 1_000)
    // September carried against its own $200, not today's $300.
    assert.deepEqual(rolled(id, '2026-09'), [true, 0, 20_000])
    assert.equal(row(id, '2026-09').budgetCents, 30_000, 'the target as set now')
    assert.deepEqual(rolled(id, '2026-10'), [true, 5_000, 35_000])
    assert.deepEqual(rolled(id, '2026-11'), [true, 7_000, 37_000])
    assert.deepEqual(db.budgetHistory().get(id), [
      { month: '2026-09', cents: 20_000 },
      { month: '2026-10', cents: 30_000 }
    ])
  })

  test('turned off, it stops; on again, it starts afresh from that month', () => {
    const id = category('Toggled')
    clock('2026-09-03')
    setCategoryTarget(id, 20_000)
    setBudgetRollover(id, true)
    spend(id, '2026-09-10', 10_000)

    clock('2026-10-03')
    assert.deepEqual(rolled(id, '2026-10'), [true, 10_000, 30_000])
    setBudgetRollover(id, false)
    assert.deepEqual(rolled(id, '2026-10'), [false, 0, 20_000])
    spend(id, '2026-10-10', 5_000)

    clock('2026-11-03')
    setBudgetRollover(id, true)
    // Nothing back-filled from September or October.
    spend(id, '2026-11-04', 12_000)
    assert.deepEqual(rolled(id, '2026-11'), [true, 0, 20_000])

    clock('2026-12-03')
    spend(id, '2026-12-02', 500)
    assert.deepEqual(rolled(id, '2026-12'), [true, 8_000, 28_000])
  })

  test('months begin and end in the ledger\'s zone', () => {
    const id = category('Zoned')
    // 11:30 pm on Oct 31 in Chicago is Nov 1 in UTC: still October here.
    clock('2026-10-31', 23, 30)
    setCategoryTarget(id, 10_000)
    setBudgetRollover(id, true)
    assert.equal(db.listRollovers().get(id), '2026-10')
    assert.deepEqual(db.budgetHistory().get(id), [{ month: '2026-10', cents: 10_000 }])
    spend(id, '2026-10-31', 4_000, 22)
    spend(id, '2026-11-01', 2_500, 0, 30)

    clock('2026-11-02')
    const r = row(id, '2026-11')
    assert.deepEqual([r.rolloverOn, r.carriedCents, r.availableCents, r.spentCents], [true, 6_000, 16_000, 2_500])
  })

  test('with rollover off, a budget is as it was: available is the target, nothing carries', () => {
    const id = category('Plain')
    clock('2026-09-03')
    setCategoryTarget(id, 20_000)
    spend(id, '2026-09-10', 5_000)
    clock('2026-10-03')
    spend(id, '2026-10-02', 25_000)
    clock('2026-11-03')
    spend(id, '2026-11-02', 1_000)
    for (const period of ['2026-09', '2026-10', '2026-11', LAST_30_DAYS]) {
      const r = row(id, period)
      assert.deepEqual([r.rolloverOn, r.carriedCents, r.availableCents, r.budgetCents], [false, 0, 20_000, 20_000], period)
    }
    // No target: none available, rollover or not.
    const none = category('No target')
    spend(none, '2026-11-02', 1_000)
    setBudgetRollover(none, true)
    assert.deepEqual(rolled(none, '2026-11'), [true, 0, null])
  })

  test('set_category_target turns rollover on and off through the journal, and undo puts each back', () => {
    const id = category('Journaled')
    clock('2026-09-03')
    setCategoryTarget(id, 20_000)
    spend(id, '2026-09-10', 15_000)

    const on = runAssistantTool('set_category_target', { category: 'Journaled', rollover: true })
    assert.equal(on.action, 'Journaled: rollover on')
    assert.equal(db.listRollovers().get(id), '2026-09')
    revert(on.changeId!)
    assert.equal(db.listRollovers().has(id), false)
    assert.equal(row(id, '2026-09').rolloverOn, false)

    runAssistantTool('set_category_target', { category: 'Journaled', rollover: true })
    clock('2026-10-03')
    spend(id, '2026-10-02', 1_000)
    assert.deepEqual(rolled(id, '2026-10'), [true, 5_000, 25_000])
    // Off, then undone: on from September again, its carry back.
    const off = runAssistantTool('set_category_target', { category: 'Journaled', rollover: false })
    assert.deepEqual(rolled(id, '2026-10'), [false, 0, 20_000])
    revert(off.changeId!)
    assert.deepEqual(rolled(id, '2026-10'), [true, 5_000, 25_000])

    // A target with it: undo puts back the target and this month's line in the history.
    const both = runAssistantTool('set_category_target', { category: 'Journaled', amount: 250, rollover: false })
    assert.equal(both.action, 'Journaled: $250.00 a month, rollover off')
    assert.deepEqual([row(id, '2026-10').budgetCents, db.budgetHistory().get(id)?.at(-1)], [25_000, { month: '2026-10', cents: 25_000 }])
    revert(both.changeId!)
    assert.deepEqual(rolled(id, '2026-10'), [true, 5_000, 25_000])
    assert.equal(row(id, '2026-10').budgetCents, 20_000)
    assert.deepEqual(db.budgetHistory().get(id), [{ month: '2026-09', cents: 20_000 }])

    // A target typed over a commitment drops it; undo brings the commitment back with the target.
    const prefs = JSON.parse(db.getSetting('budget.prefs') ?? '{}')
    const commitment = { optionId: 'none', label: 'No Diner purchases', savingsCents: 5_000, category: 'Journaled', limit: { count: 0 } }
    db.setSetting('budget.prefs', JSON.stringify({ ...prefs, commitments: { 'store:Journaled:Diner': commitment }, before: { Journaled: null } }))
    const typed = runAssistantTool('set_category_target', { category: 'Journaled', amount: 180 })
    assert.deepEqual(JSON.parse(db.getSetting('budget.prefs')!).commitments, {})
    revert(typed.changeId!)
    const back = JSON.parse(db.getSetting('budget.prefs')!)
    assert.deepEqual([back.commitments, back.before], [{ 'store:Journaled:Diner': commitment }, { Journaled: null }])
    assert.equal(row(id, '2026-10').budgetCents, 20_000)

    assert.throws(() => runAssistantTool('set_category_target', { category: 'Journaled' }), /Nothing to change/)
    assert.throws(() => runAssistantTool('set_category_target', { category: 'Paycheck', rollover: true }), /isn't a spending category/)
  })

  test("no Api method sets it since the phone's Budget tab went (sub-phase 2h): Review's set_category_target does", () => {
    assert.equal(methodKind('setBudgetRollover'), null)
    assert.equal(handlerFor('setBudgetRollover'), undefined)
  })
})

describe('the rollover migration', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: at('2026-10-05') * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a target set before it counts from the start, so turning rollover on carries against it', () => {
    db.openDb(join(dir, 'older.db'), { migrate: false })
    db.migrate({ target: 33 })
    const id = db.listCategories().find((c) => c.name === 'Coffee')!.id
    db.run('INSERT INTO budgets (category_id, cents) VALUES (?, ?)', id, 15_000)
    db.migrate()
    db.setSetting('calendar.timeZone', ZONE)
    assert.deepEqual(db.budgetHistory().get(id), [{ month: '0000-01', cents: 15_000 }])
    assert.deepEqual(db.listRollovers(), new Map())

    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    setBudgetRollover(id, true)
    spend(id, '2026-10-06', 10_000)
    clock('2026-11-03')
    spend(id, '2026-11-02', 500)
    assert.deepEqual(rolled(id, '2026-11'), [true, 5_000, 20_000])
  })
})
