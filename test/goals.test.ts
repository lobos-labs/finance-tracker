import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { addContribution, archiveGoal, balancePace, contributionPace, deleteGoal, goalViews, monthsUntil, progress, saveGoal, snapshotGoals } from '../src/main/goals.ts'
import { getCredit, keepReminder, nextReminderDay, REMINDER_TITLE, setReminder } from '../src/main/credit.ts'
import { clearDemoData, loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { runAssistantTool, runTool, toolRisk } from '../src/main/tools.ts'

// Savings goals: progress from linked balances (less a start) or a log of
// contributions, what's needed a month to make the date, the pace and the
// status; the review's tools and their undo; the phone's optional field; the
// sample household's two goals. And the Credit page's monthly reminder.

configureLicense({ dev: true })

const dir = mkdtempSync(join(tmpdir(), 'finance-goals-'))
const view = (id: number, on?: string): ReturnType<typeof goalViews>[number] => goalViews(on).find((g) => g.id === id)!
const today = (): string => db.dayKey(db.now())
const revert = (changeId: number): void => {
  const c = db.getChange(changeId)!
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId)
}
const account = (id: string, name: string, cents: number): void => db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: db.now() })
const events = (): ReturnType<typeof db.listCalendarEvents> => db.listCalendarEvents('2000-01-01')

before(() => {
  process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
  db.openDb(join(dir, 'finance.db'))
  account('csv:save', 'Savings', 500_000)
  account('csv:brk', 'Brokerage', 200_000)
  account('csv:card', 'Visa', -40_000)
  db.updateAccount('csv:save', { assetType: 'cash' })
  db.updateAccount('csv:brk', { assetType: 'investment' })
  db.updateAccount('csv:card', { assetType: 'credit_card' })
})
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('goal progress math', () => {
  test('whole months to the date, at least one', () => {
    assert.equal(monthsUntil('2026-10-21', '2027-06-01'), 7)
    assert.equal(monthsUntil('2026-10-21', '2027-06-21'), 8)
    assert.equal(monthsUntil('2026-10-21', '2026-11-20'), 1)
    assert.equal(monthsUntil('2026-10-21', '2026-10-31'), 1)
    assert.equal(monthsUntil('2026-10-21', '2026-10-21'), 1)
    assert.equal(monthsUntil('2026-12-15', '2027-02-15'), 2)
  })

  test('what is needed a month, and whether the pace covers it', () => {
    const on = '2026-10-21'
    const p = progress({ targetCents: 1_000_000, targetDay: '2027-04-21', savedCents: 400_000, paceCents: 100_000 }, on)
    assert.deepEqual(p, { savedCents: 400_000, remainingCents: 600_000, pct: 0.4, paceCents: 100_000, monthsLeft: 6, monthlyNeededCents: 100_000, status: 'on_track' })
    assert.equal(progress({ targetCents: 1_000_000, targetDay: '2027-04-21', savedCents: 400_000, paceCents: 99_999 }, on).status, 'behind')
    // Cents round up, so the last month never comes up short.
    assert.equal(progress({ targetCents: 100_000, targetDay: '2027-01-21', savedCents: 0, paceCents: 0 }, on).monthlyNeededCents, 33_334)
  })

  test('past the date it is past due, with all that is left needed now', () => {
    const p = progress({ targetCents: 300_000, targetDay: '2026-09-30', savedCents: 120_000, paceCents: 50_000 }, '2026-10-21')
    assert.equal(p.status, 'past_due')
    assert.equal(p.monthsLeft, null)
    assert.equal(p.monthlyNeededCents, 180_000)
  })

  test('done once the target is reached; open without a date; never below zero', () => {
    const done = progress({ targetCents: 300_000, targetDay: '2026-09-30', savedCents: 350_000, paceCents: 0 }, '2026-10-21')
    assert.deepEqual([done.status, done.remainingCents, done.monthlyNeededCents, done.pct], ['done', 0, 0, 350_000 / 300_000])
    const open = progress({ targetCents: 300_000, targetDay: null, savedCents: 10_000, paceCents: 5_000 }, '2026-10-21')
    assert.deepEqual([open.status, open.monthsLeft, open.monthlyNeededCents], ['open', null, null])
    const under = progress({ targetCents: 300_000, targetDay: null, savedCents: -25_000, paceCents: -1_000 }, '2026-10-21')
    assert.deepEqual([under.savedCents, under.remainingCents, under.pct], [0, 300_000, 0])
  })

  test('the pace: contributions over the last three months, or since the goal began', () => {
    const on = '2026-10-21'
    const monthly = [{ day: '2026-07-15', cents: 30_000 }, { day: '2026-08-15', cents: 30_000 }, { day: '2026-09-15', cents: 30_000 }, { day: '2026-10-15', cents: 30_000 }]
    // Three of the four fall in the last 90 days, over three months' time.
    assert.equal(contributionPace(monthly, '2026-01-01', on), Math.round(90_000 / (90 / 30.44)))
    // A goal begun two weeks ago counts a month.
    assert.equal(contributionPace([{ day: '2026-10-10', cents: 50_000 }], '2026-10-07', on), 50_000)
    assert.equal(contributionPace([], '2026-10-07', on), 0)
    assert.equal(balancePace(560_000, 500_000), Math.round(60_000 / (90 / 30.44)))
  })
})

describe('goals in the ledger', () => {
  test('linked accounts count their combined balance, or only what is saved from the start', () => {
    const whole = saveGoal({ name: 'House fund', targetCents: 1_000_000, targetDay: null, funding: 'accounts', accountIds: ['csv:save', 'csv:brk'] })
    assert.equal(view(whole).savedCents, 700_000)
    assert.equal(view(whole).status, 'open')
    const fresh = saveGoal({ name: 'New car', targetCents: 300_000, targetDay: null, funding: 'accounts', accountIds: ['csv:save'], fromNow: true })
    assert.deepEqual([view(fresh).startCents, view(fresh).startDay, view(fresh).savedCents], [500_000, today(), 0])
    db.updateAccount('csv:save', { balanceCents: 560_000 })
    assert.equal(view(fresh).savedCents, 60_000)
    assert.equal(view(whole).savedCents, 760_000)
    // Edited without touching the start keeps it; moving to other accounts takes theirs on the start day.
    saveGoal({ id: fresh, name: 'New car', targetCents: 350_000, targetDay: null, funding: 'accounts', accountIds: ['csv:save'] })
    assert.deepEqual([view(fresh).startCents, view(fresh).targetCents], [500_000, 350_000])
    saveGoal({ id: fresh, name: 'New car', targetCents: 350_000, targetDay: null, funding: 'accounts', accountIds: ['csv:save', 'csv:brk'], fromNow: true })
    assert.equal(view(fresh).startCents, [...db.balancesOn(['csv:save', 'csv:brk'], today()).values()].reduce((t, c) => t + c, 0))
    saveGoal({ id: fresh, name: 'New car', targetCents: 350_000, targetDay: null, funding: 'accounts', accountIds: ['csv:save'], fromNow: false })
    assert.deepEqual([view(fresh).startCents, view(fresh).startDay, view(fresh).savedCents], [null, null, 560_000])
    deleteGoal(whole)
    deleteGoal(fresh)
  })

  test('a goal counts accounts that hold money, needs one, and loses a deleted one', () => {
    assert.throws(() => saveGoal({ name: 'x', targetCents: 100, targetDay: null, funding: 'accounts', accountIds: ['csv:card'] }), /doesn't hold money/)
    const car = db.addManualAccount({ name: 'Car', assetType: 'vehicle', points: [{ day: '2026-01-01', cents: 2_000_000 }] })
    assert.throws(() => saveGoal({ name: 'x', targetCents: 100, targetDay: null, funding: 'accounts', accountIds: [car] }), /doesn't hold money/)
    db.deleteAccount(car)
    assert.throws(() => saveGoal({ name: 'x', targetCents: 100, targetDay: null, funding: 'accounts', accountIds: [] }), /at least one account/)
    assert.throws(() => saveGoal({ name: ' ', targetCents: 100, targetDay: null, funding: 'manual' }), /name/)
    assert.throws(() => saveGoal({ name: 'x', targetCents: 0, targetDay: null, funding: 'manual' }), /more than zero/)
    assert.throws(() => saveGoal({ name: 'x', targetCents: 100, targetDay: '2027-02-30', funding: 'manual' }), /date/)
    account('csv:tmp', 'Old savings', 90_000)
    const id = saveGoal({ name: 'Rainy day', targetCents: 100_000, targetDay: null, funding: 'accounts', accountIds: ['csv:tmp', 'csv:brk'] })
    db.deleteAccount('csv:tmp')
    assert.deepEqual(view(id).accountIds, ['csv:brk'])
    deleteGoal(id)
  })

  test('a linked account closed, or no longer a kind a goal counts, holds nothing toward it', () => {
    account('csv:ef', 'EF savings', 500_000)
    db.updateAccount('csv:ef', { assetType: 'cash' })
    const id = saveGoal({ name: 'EF', targetCents: 1_000_000, targetDay: null, funding: 'accounts', accountIds: ['csv:ef'] })
    assert.equal(view(id).savedCents, 500_000)
    const closed = db.dayKey(db.now() - 10 * 86_400)
    db.updateAccount('csv:ef', { closedDay: closed })
    // The pace's walk has it at 0 from its closing day; what's saved agrees.
    assert.equal(view(id).savedCents, 0)
    assert.ok(view(id).paceCents < 0)
    assert.equal(view(id, db.dayKey(db.now() - 20 * 86_400)).savedCents, 500_000, 'before it closed it counted')
    db.updateAccount('csv:ef', { closedDay: null })
    assert.equal(view(id).savedCents, 500_000)
    db.updateAccount('csv:ef', { assetType: 'credit_card' })
    assert.deepEqual([view(id).savedCents, view(id).paceCents], [0, 0])
    // A goal counting from now starts from what still counts.
    const fresh = saveGoal({ name: 'EF 2', targetCents: 1_000_000, targetDay: null, funding: 'accounts', accountIds: ['csv:save'], fromNow: true })
    assert.equal(view(fresh).startCents, 560_000)
    deleteGoal(id)
    deleteGoal(fresh)
    db.deleteAccount('csv:ef')
  })

  test('a contribution is never dated ahead, and one after the day asked about is not saved yet', () => {
    const id = saveGoal({ name: 'Ahead', targetCents: 100_000, targetDay: null, funding: 'manual' })
    const tomorrow = db.dayKey(db.now() + 86_400)
    assert.throws(() => addContribution(id, { day: tomorrow, cents: 30_000 }), /future/)
    assert.throws(() => runAssistantTool('update_goal', { goal: id, add_contribution: { day: tomorrow, amount: 300 } }), /future/)
    addContribution(id, { day: today(), cents: 30_000 })
    assert.equal(view(id).savedCents, 30_000)
    assert.equal(view(id, db.dayKey(db.now() - 86_400)).savedCents, 0)
    deleteGoal(id)
  })

  test('a log of contributions, with the monthly amount needed by the date and past due after it', () => {
    const id = saveGoal({ name: 'Trip', targetCents: 400_000, targetDay: '2027-06-01', funding: 'manual' })
    addContribution(id, { day: '2026-09-15', cents: 30_000, note: 'September' })
    addContribution(id, { day: '2026-10-15', cents: 30_000 })
    addContribution(id, { day: '2026-10-18', cents: -5_000, note: 'deposit refund' })
    assert.throws(() => addContribution(id, { day: '2026-10-18', cents: 0 }), /zero/)
    const g = view(id, '2026-10-21')
    assert.equal(g.savedCents, 55_000)
    assert.deepEqual(g.contributions.map((c) => c.cents), [-5_000, 30_000, 30_000])
    assert.equal(g.monthsLeft, 7)
    assert.equal(g.monthlyNeededCents, Math.ceil(345_000 / 7))
    assert.equal(g.status, 'behind')
    const late = view(id, '2027-06-02')
    assert.deepEqual([late.status, late.monthlyNeededCents], ['past_due', 345_000])
    archiveGoal(id, true)
    assert.notEqual(view(id).archivedAt, null)
    archiveGoal(id, false)
    deleteGoal(id)
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM goal_contributions')!.n, 0)
  })
})

describe('the review tools for goals', () => {
  test('risks: list read, create and update write, delete destructive', () => {
    assert.equal(toolRisk('list_goals', {}), 'read')
    assert.equal(toolRisk('create_goal', { name: 'x', target: 1 }), 'write')
    assert.equal(toolRisk('update_goal', { goal: 'x' }), 'write')
    assert.equal(toolRisk('delete_goal', { goal: 'x' }), 'destructive')
  })

  test('create, update and delete are journaled, and undo puts each back', () => {
    const made = runAssistantTool('create_goal', { name: 'Vacation', target: 4000, target_day: '2027-06-01', contributions: [{ amount: 300, day: '2026-09-15' }] })
    const id = (made.result as { goal_id: number }).goal_id
    assert.equal(made.action, 'Goal: Vacation · $4,000.00 by 2027-06-01')
    assert.equal(view(id).savedCents, 30_000)
    const listed = runAssistantTool('list_goals', { goal: 'vacation' }).result as { saved: number; contributions: Array<{ amount: number }> }
    assert.deepEqual([listed.saved, listed.contributions.map((c) => c.amount)], [300, [300]])

    const upd = runAssistantTool('update_goal', { goal: 'Vacation', target: 5000, add_contribution: { amount: 250, day: '2026-10-15', note: 'bonus' }, archived: true })
    assert.match(upd.action!, /^Goal: Vacation updated, \$250\.00 on 2026-10-15, archived$/)
    assert.deepEqual([view(id).targetCents, view(id).savedCents, view(id).archivedAt !== null], [500_000, 55_000, true])
    revert(upd.changeId!)
    assert.deepEqual([view(id).targetCents, view(id).savedCents, view(id).archivedAt], [400_000, 30_000, null])

    // Linked to an account, from today.
    runAssistantTool('update_goal', { goal: id, account_ids: ['csv:save'], from_now: true })
    assert.deepEqual([view(id).funding, view(id).startCents, view(id).savedCents], ['accounts', 560_000, 0])

    // The assistant's delete waits for approval; the approved run is journaled and undone with its log.
    const queued = runAssistantTool('delete_goal', { goal: 'Vacation' })
    assert.equal(typeof queued.pending, 'number')
    assert.ok(view(id))
    const gone = runTool('delete_goal', { goal: 'Vacation' }, 'user')
    assert.equal(goalViews().length, 0)
    revert(gone.changeId!)
    const back = view(id)
    assert.deepEqual([back.name, back.funding, back.accountIds, back.startCents, back.contributions.length], ['Vacation', 'accounts', ['csv:save'], 560_000, 1])

    revert(made.changeId!)
    assert.equal(goalViews().length, 0)
  })

  test('mistakes come back as errors', () => {
    assert.throws(() => runAssistantTool('update_goal', { goal: 'Nope', target: 1 }), /No goal Nope/)
    assert.throws(() => runAssistantTool('create_goal', { name: 'x' }), /target is required/)
    assert.throws(() => runAssistantTool('create_goal', { name: 'x', target: 10, account_ids: ['csv:save'], contributions: [{ amount: 1, day: '2026-10-01' }] }), /not both/)
    const id = (runAssistantTool('create_goal', { name: 'Kept', target: 10 }).result as { goal_id: number }).goal_id
    assert.throws(() => runAssistantTool('update_goal', { goal: id }), /Nothing to change/)
    deleteGoal(id)
  })
})

describe('the sample household', () => {
  test('has an emergency fund in savings and a vacation with a date; removing it keeps the user\'s goals', () => {
    const mine = saveGoal({ name: 'Mine', targetCents: 100, targetDay: null, funding: 'manual' })
    loadDemoData()
    const goals = goalViews()
    const fund = goals.find((g) => g.name === 'Emergency fund')!
    const trip = goals.find((g) => g.name === 'Vacation')!
    assert.deepEqual([fund.funding, fund.accountIds], ['accounts', ['demo:savings']])
    assert.ok(fund.savedCents > 1_000_000 && fund.pct < 1)
    assert.equal(trip.funding, 'manual')
    assert.ok(trip.targetDay && trip.targetDay > today())
    assert.equal(trip.contributions.length, 4)
    assert.equal(trip.status, 'behind')
    clearDemoData()
    assert.deepEqual(goalViews().map((g) => g.id), [mine])
    deleteGoal(mine)
  })
})

describe('the monthly credit-score reminder', () => {
  test('the next day of the month, the month\'s last day when it is shorter', () => {
    assert.equal(nextReminderDay('2026-10-21', 15), '2026-11-15')
    assert.equal(nextReminderDay('2026-10-21', 21), '2026-10-21')
    assert.equal(nextReminderDay('2026-10-21', 28), '2026-10-28')
    assert.equal(nextReminderDay('2027-02-01', 31), '2027-02-28')
    assert.equal(nextReminderDay('2026-12-20', 5), '2027-01-05')
  })

  test('on: one to-do ahead; checked off: the next month\'s; left past its day: moved; off: removed', () => {
    setReminder(15, '2026-10-21')
    assert.equal(getCredit().reminderDay, 15)
    let list = events()
    assert.equal(list.length, 1)
    assert.deepEqual([list[0].day, list[0].title, list[0].task, list[0].startTime], ['2026-11-15', REMINDER_TITLE, true, null])
    // Nothing to do while it waits.
    assert.equal(keepReminder('2026-11-01'), false)
    // Checked off: next month's comes, the done one stays.
    db.updateCalendarEvent(list[0].id, { done: true })
    assert.equal(keepReminder('2026-11-16'), true)
    list = events()
    assert.deepEqual(list.map((e) => [e.day, e.doneAt !== null]), [['2026-11-15', true], ['2026-12-15', false]])
    // Checked off early: the one after still comes the month after it.
    db.updateCalendarEvent(list[1].id, { done: true })
    keepReminder('2026-12-10')
    assert.deepEqual(events().map((e) => e.day), ['2026-11-15', '2026-12-15', '2027-01-15'])
    // Left unchecked past its day: it moves on.
    assert.equal(keepReminder('2027-01-20'), true)
    assert.deepEqual(events().map((e) => e.day), ['2026-11-15', '2026-12-15', '2027-02-15'])
    // Another day of the month moves the waiting one.
    setReminder(3, '2027-01-20')
    assert.deepEqual(events().map((e) => e.day), ['2026-11-15', '2026-12-15', '2027-02-03'])
    // Off: the waiting one goes, the checked-off ones stay.
    setReminder(null)
    assert.equal(getCredit().reminderDay, null)
    assert.deepEqual(events().map((e) => e.day), ['2026-11-15', '2026-12-15'])
    assert.equal(keepReminder('2027-03-01'), false)
    assert.throws(() => setReminder(0), /1 to 31/)
    for (const e of events()) db.deleteCalendarEvent(e.id)
  })

  test('a to-do deleted by hand comes back while the reminder is on', () => {
    setReminder(1, '2026-10-21')
    const [e] = events()
    assert.equal(e.day, '2026-11-01')
    db.deleteCalendarEvent(e.id)
    assert.equal(keepReminder('2026-10-22'), true)
    assert.deepEqual(events().map((x) => x.day), ['2026-11-01'])
    setReminder(null)
    assert.deepEqual(events(), [])
  })
})
