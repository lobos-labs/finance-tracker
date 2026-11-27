import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'

// Review's budget tools (waterfall spec sub-phase 2e): every write the Budget and Recurring pages offered is a Review
// tool now. A category's tier (set_category_tier), the cheaper grocer (set_cheaper_store) and the one-off budget
// (set_one_off_budget) join set_category_target and commit_habit; commit_habit shows hidden habits again, and
// update_recurring takes back a confirm or a dismiss. Each is journaled and undone as the Review chat undoes it. A
// tier is read by the budget, Spendable and the Left over drill's E and L, never by the classifier: a tier changed
// after a close leaves every closed month as it closed.

// The handlers' modules import Electron: the demo dump's stand-in takes its place.
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
const { essentialTier, getBudget } = await import('../src/main/budget.ts')
const { homePlans } = await import('../src/main/homePlans.ts')
const { detectRecurring } = await import('../src/main/recurring.ts')
const { openIssues, runAssistantTool, toolFeature, TOOLS } = await import('../src/main/tools.ts')
const { getWaterfall } = await import('../src/main/waterfall.ts')
const { checkClosed, closeDueMonths, listSnapshots, rowsDigest } = await import('../src/main/snapshots.ts')
const { ENGINE_VERSION } = await import('../src/main/lines.ts')
const hh = await import('./fixtures/waterfall-household.ts')

configureLicense({ dev: true })

const [Y, M, D] = hh.TODAY.split('-').map(Number)
const prefs = (): Record<string, unknown> => JSON.parse(db.getSetting('budget.prefs') ?? '{}') as Record<string, unknown>
/** Undoes a change the way the Review chat does. */
function revert(changeId: number | undefined): void {
  const c = db.getChange(changeId!)!
  assert.equal(c.undoneAt, null)
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId!)
}
/** Every row's and part's figures, as the rows digest reads them, with each Everyday part's tag beside it. */
const figures = (w: Waterfall): { digest: string; tags: Record<string, string | undefined> } => ({
  digest: rowsDigest(w),
  tags: Object.fromEntries((w.rows.find((r) => r.id === 'everyday')?.parts ?? []).map((p) => [p.name, p.tag]))
})

describe("Review's budget tools", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    hh.household()
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('each is a write on every plan, journaled, beside set_category_target and commit_habit', () => {
    const names = TOOLS.map((t) => t.name)
    const at = names.indexOf('set_category_target')
    assert.deepEqual(names.slice(names.indexOf('commit_habit'), at + 4), ['commit_habit', 'set_category_target', 'set_category_tier', 'set_cheaper_store', 'set_one_off_budget'])
    for (const name of ['set_category_tier', 'set_cheaper_store', 'set_one_off_budget']) {
      assert.equal(TOOLS.find((t) => t.name === name)!.risk, 'write', name)
      // As set_category_target and commit_habit: the budget is free, so no plan feature gates them.
      assert.equal(toolFeature(name), undefined, name)
      for (const t of ['set_category_target', 'commit_habit']) assert.equal(toolFeature(t), undefined, t)
    }
  })

  test("set_category_tier: the budget, Spendable's essentials and Left over's tags read it, and undo puts the tier back", () => {
    const month = hh.TODAY.slice(0, 7)
    const rowOf = (name: string): { tier: string } | undefined => getBudget(month).rows.find((r) => r.name === name)
    assert.equal(rowOf('Dining Out')?.tier, 'lifestyle')
    assert.equal(essentialTier()('Dining Out'), false)
    const before = db.getSetting('budget.prefs')

    const set = runAssistantTool('set_category_tier', { category: 'dining out', tier: 'essential' })
    assert.equal(set.action, 'Dining Out: Essential')
    assert.deepEqual(prefs().tiers, { 'Dining Out': 'essential' })
    assert.equal(rowOf('Dining Out')?.tier, 'essential')
    assert.equal(essentialTier()('Dining Out'), true)
    revert(set.changeId)
    assert.equal(db.getSetting('budget.prefs'), before)
    assert.equal(rowOf('Dining Out')?.tier, 'lifestyle')

    // A one-off category's purchases are the budget's one-offs, not a row; null goes back to the default.
    const off = runAssistantTool('set_category_tier', { category: 'Dining Out', tier: 'oneoff' })
    assert.equal(rowOf('Dining Out'), undefined)
    assert.ok(getBudget(month).oneOffs.categories.includes('Dining Out'))
    const back = runAssistantTool('set_category_tier', { category: 'Dining Out', tier: null })
    assert.equal(back.action, 'Dining Out: back to its default tier')
    assert.deepEqual(prefs().tiers, {})
    revert(back.changeId)
    assert.deepEqual(prefs().tiers, { 'Dining Out': 'oneoff' })
    revert(off.changeId)
    assert.equal(db.getSetting('budget.prefs'), before)
    assert.equal(rowOf('Dining Out')?.tier, 'lifestyle')

    // A commitment made for the category is dropped with the tier's change, and comes back with its undo.
    const commitment = { optionId: 'none', label: 'No Corner Bistro purchases', savingsCents: 5_000, category: 'Dining Out', limit: { count: 0 } }
    db.setSetting('budget.prefs', JSON.stringify({ ...prefs(), commitments: { 'store:Dining Out:Corner Bistro': commitment }, before: { 'Dining Out': null } }))
    const dropped = runAssistantTool('set_category_tier', { category: 'Dining Out', tier: 'essential' })
    assert.deepEqual([prefs().commitments, prefs().before], [{}, {}])
    revert(dropped.changeId)
    assert.deepEqual([prefs().commitments, prefs().before], [{ 'store:Dining Out:Corner Bistro': commitment }, { 'Dining Out': null }])

    assert.throws(() => runAssistantTool('set_category_tier', { category: 'Dining Out', tier: 'luxury' }), /tier must be one of lifestyle, essential, oneoff/)
    assert.throws(() => runAssistantTool('set_category_tier', { category: 'Paycheck', tier: 'essential' }), /isn't a spending category/)
    assert.throws(() => runAssistantTool('set_category_tier', { category: 'Llamas', tier: 'essential' }), /Unknown category "Llamas"/)
  })

  test('set_cheaper_store names the grocer the groceries habit measures against; null names none; undo puts it back', () => {
    const month = hh.TODAY.slice(0, 7)
    assert.equal(getBudget(month).cheaperStore, null)
    const set = runAssistantTool('set_cheaper_store', { store: '  Aldi ' })
    assert.equal(set.action, 'Cheaper grocer: Aldi')
    assert.equal(getBudget(month).cheaperStore, 'Aldi')
    const none = runAssistantTool('set_cheaper_store', { store: null })
    assert.equal(none.action, 'No cheaper grocer')
    assert.equal(getBudget(month).cheaperStore, null)
    revert(none.changeId)
    assert.equal(getBudget(month).cheaperStore, 'Aldi')
    revert(set.changeId)
    assert.equal(getBudget(month).cheaperStore, null)
    assert.equal(db.getSetting('budget.prefs'), null)
    assert.throws(() => runAssistantTool('set_cheaper_store', { store: 'Al' }), /at least 3 characters/)
    assert.throws(() => runAssistantTool('set_cheaper_store', { store: 12 }), /store is a store name/)
    // A store is found inside a merchant's name, so one longer than any merchant's name is refused, not kept to match
    // nothing (and quietly end the groceries habit).
    assert.throws(() => runAssistantTool('set_cheaper_store', { store: 'x'.repeat(db.MERCHANT_MAX + 1) }), new RegExp(`at most ${db.MERCHANT_MAX} characters`))
    assert.equal(runAssistantTool('set_cheaper_store', { store: 'x'.repeat(db.MERCHANT_MAX) }).action, `Cheaper grocer: ${'x'.repeat(db.MERCHANT_MAX)}`)
    runAssistantTool('set_cheaper_store', { store: null })
    assert.equal(getBudget(month).cheaperStore, null)
  })

  test("set_one_off_budget: Saved's One-offs and the debt plan read it; null is the average again; undo puts it back", () => {
    const month = hh.TODAY.slice(0, 7)
    assert.equal(homePlans().oneOffTargetCents, null)
    const set = runAssistantTool('set_one_off_budget', { amount: 300 })
    assert.equal(set.action, 'One-off budget: $300.00 a month')
    assert.deepEqual([homePlans().oneOffTargetCents, getBudget(month).oneOffs.targetCents], [30_000, 30_000])
    // It replaces the commitment that set it, which undo brings back with the budget it had.
    const commitment = { optionId: 'cap', label: 'One-offs under $200', savingsCents: 5_000, category: 'One-offs', limit: { cents: 20_000 } }
    db.setSetting('budget.prefs', JSON.stringify({ ...prefs(), oneOffTargetCents: 20_000, commitments: { oneoffs: commitment }, before: { 'One-offs': 30_000 } }))
    const typed = runAssistantTool('set_one_off_budget', { amount: null })
    assert.equal(typed.action, 'One-off budget back to the average')
    assert.deepEqual([homePlans().oneOffTargetCents, prefs().commitments, prefs().before], [null, {}, {}])
    revert(typed.changeId)
    assert.deepEqual([homePlans().oneOffTargetCents, prefs().commitments], [20_000, { oneoffs: commitment }])
    revert(set.changeId)
    assert.equal(homePlans().oneOffTargetCents, null)
    assert.throws(() => runAssistantTool('set_one_off_budget', { amount: -5 }), /zero or more/)
    assert.throws(() => runAssistantTool('set_one_off_budget', {}), /amount is dollars a month/)
    // An amount is a number or text that reads as one: "" and true are no amount, not $0.00 and $1.00.
    for (const amount of ['', ' ', true, false, [], 'abc']) assert.throws(() => runAssistantTool('set_one_off_budget', { amount }), /amount \(dollars\) must be a number/, JSON.stringify(amount))
    assert.equal(runAssistantTool('set_one_off_budget', { amount: '125.50' }).action, 'One-off budget: $125.50 a month')
    assert.equal(homePlans().oneOffTargetCents, 12_550)
    // set_category_target reads its amount the same way.
    assert.throws(() => runAssistantTool('set_category_target', { category: 'Dining Out', amount: '' }), /amount \(dollars\) must be a number/)
    assert.throws(() => runAssistantTool('set_category_target', { category: 'Dining Out', amount: true }), /amount \(dollars\) must be a number/)
  })

  test("commit_habit makes a commitment part of its category's target, and undo true takes it back; the journal undoes each", () => {
    const month = hh.TODAY.slice(0, 7)
    // A habit on a category of its own (not the one-offs'), with a commitment to make.
    const habit = getBudget(month).habits.find((h) => h.categoryId !== null && h.options.length > 0 && !h.committed)!
    assert.ok(habit, 'the household has a habit to commit to')
    const option = habit.options[0]
    const target = (): number | null | undefined => getBudget(month).rows.find((r) => r.categoryId === habit.categoryId)?.budgetCents
    const state = (): unknown[] => [db.getSetting('budget.prefs'), [...db.listBudgets()].sort(([a], [b]) => a - b), target()]
    const was = state()
    const targetWas = target()

    const made = runAssistantTool('commit_habit', { habit: habit.id, option: option.id })
    assert.match(made.action ?? '', /^Committed: /)
    assert.equal((prefs().commitments as Record<string, { optionId: string }>)[habit.id]?.optionId, option.id)
    assert.notEqual(target(), targetWas, "the category's target moved by the commitment")
    revert(made.changeId)
    assert.deepEqual(state(), was)

    // undo true removes the commitment, and puts back the target it replaced (the preferences are written back
    // empty, which reads as none); the journal makes it again.
    runAssistantTool('commit_habit', { habit: habit.id, option: option.id })
    const committed = state()
    const undone = runAssistantTool('commit_habit', { habit: habit.id, undo: true })
    assert.match(undone.action ?? '', /^Commitment undone: /)
    assert.deepEqual([prefs().commitments, prefs().before, prefs().oneOffTargetCents ?? null], [{}, {}, null])
    assert.deepEqual(state().slice(1), was.slice(1))
    revert(undone.changeId)
    assert.deepEqual(state(), committed)
  })

  test('commit_habit with hide false shows that habit again, or with "all" every hidden one, as the Budget page and the phone did; undo hides them again', () => {
    const hidden = (): unknown => prefs().hidden
    runAssistantTool('commit_habit', { habit: 'store:Groceries:Costco', hide: true })
    runAssistantTool('commit_habit', { habit: 'store:Dining Out:Corner Bistro', hide: true })
    assert.deepEqual(hidden(), ['store:Groceries:Costco', 'store:Dining Out:Corner Bistro'])
    // One habit by its id: the others stay hidden.
    const one = runAssistantTool('commit_habit', { habit: 'store:Groceries:Costco', hide: false })
    assert.equal(one.action, 'Habit shown again: Costco')
    assert.deepEqual(hidden(), ['store:Dining Out:Corner Bistro'])
    revert(one.changeId)
    assert.deepEqual(hidden(), ['store:Groceries:Costco', 'store:Dining Out:Corner Bistro'])
    // A habit that isn't hidden is refused, naming the ones that are, and nothing changes.
    assert.throws(() => runAssistantTool('commit_habit', { habit: 'store:Groceries:Aldi', hide: false }), /store:Groceries:Aldi isn't hidden; the hidden habits are store:Groceries:Costco, store:Dining Out:Corner Bistro \(habit "all" shows every one\)/)
    assert.throws(() => runAssistantTool('commit_habit', { hide: false }), /habit is required/)
    assert.deepEqual(hidden(), ['store:Groceries:Costco', 'store:Dining Out:Corner Bistro'])
    const shown = runAssistantTool('commit_habit', { habit: 'all', hide: false })
    assert.equal(shown.action, 'Hidden habits shown again')
    assert.deepEqual(hidden(), [])
    revert(shown.changeId)
    assert.deepEqual(hidden(), ['store:Groceries:Costco', 'store:Dining Out:Corner Bistro'])
  })

  test("update_recurring with status null takes back a confirm or a dismiss, as the Recurring page's toggles did; undo puts each back", () => {
    const series = detectRecurring({ scope: 'all' }).find((s) => s.kind === 'subscription')!
    const state = (): [boolean, boolean] => {
      const s = detectRecurring({ scope: 'all' }).find((x) => x.key === series.key)!
      return [s.confirmed, s.dismissed]
    }
    runAssistantTool('update_recurring', { key: series.key, status: 'dismissed' })
    assert.deepEqual(state(), [false, true])
    const back = runAssistantTool('update_recurring', { key: series.key, status: null })
    assert.equal(back.action, `${detectRecurring({ scope: 'all' }).find((x) => x.key === series.key)!.name}: no longer dismissed`)
    assert.deepEqual(state(), [false, false])
    revert(back.changeId)
    assert.deepEqual(state(), [false, true])
    runAssistantTool('update_recurring', { key: series.key, status: 'confirmed' })
    const unconfirmed = runAssistantTool('update_recurring', { key: series.key, status: null })
    assert.match(unconfirmed.action ?? '', /: no longer confirmed$/)
    assert.deepEqual(state(), [false, false])
    revert(unconfirmed.changeId)
    assert.deepEqual(state(), [true, false])
    // What updateRecurring took unchecked, the tool refuses, and writes nothing.
    assert.throws(() => runAssistantTool('update_recurring', { key: series.key, status: 'paused' }), /status must be confirmed, dismissed, or null/)
    assert.throws(() => runAssistantTool('update_recurring', { key: series.key, kind: 'rent' }), /kind must be one of subscription, bill, loan, income, transfer, other/)
    assert.deepEqual(state(), [true, false])
    assert.equal(detectRecurring({ scope: 'all' }).find((x) => x.key === series.key)!.kind, series.kind)
  })

  test("update_recurring's kind and name change the series, as the Recurring page's type did; undo puts each back", () => {
    const series = detectRecurring({ scope: 'all' }).find((s) => s.kind === 'subscription' && !s.confirmed && !s.dismissed)!
    const now = (): { kind: string; name: string; confirmed: boolean; dismissed: boolean } => {
      const s = detectRecurring({ scope: 'all' }).find((x) => x.key === series.key)!
      return { kind: s.kind, name: s.name, confirmed: s.confirmed, dismissed: s.dismissed }
    }
    const was = now()
    const typed = runAssistantTool('update_recurring', { key: series.key, kind: 'bill' })
    assert.equal(typed.action, `${series.name}: as bill`)
    assert.deepEqual(now(), { ...was, kind: 'bill' })
    revert(typed.changeId)
    assert.deepEqual(now(), was)
    // Over a confirm already made, the type and the name change and the confirm stays; undo keeps the confirm.
    runAssistantTool('update_recurring', { key: series.key, status: 'confirmed' })
    const both = runAssistantTool('update_recurring', { key: series.key, kind: 'other', name: 'Streaming' })
    assert.equal(both.action, `${series.name}: as other, renamed "Streaming"`)
    assert.deepEqual(now(), { ...was, kind: 'other', name: 'Streaming', confirmed: true })
    revert(both.changeId)
    assert.deepEqual(now(), { ...was, confirmed: true })
  })
})

describe('a tier changed after the months closed', () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('moves no figure and changes no closed month: only the Left over drill marks the category E in place of L', async () => {
    hh.household()
    await closeDueMonths()
    await checkClosed()
    const closes = (): Array<[string, number, string]> => listSnapshots(1000).map((s) => [s.month, s.version, s.status])
    const closed = closes()
    assert.ok(closed.some(([m, , status]) => m === '2026-10' && status === 'closed'))
    const october = { from: '2026-10', to: '2026-10' }
    const was = figures(getWaterfall(october))
    assert.equal(was.tags['Dining Out'], 'lifestyle')
    const stampWas = db.getSetting('budget.prefs')

    const set = runAssistantTool('set_category_tier', { category: 'Dining Out', tier: 'essential' })
    const run = await checkClosed()
    // The classifier reads the default tiers and the habit rule (lines.ts ONE_OFF_BY_DEFAULT), never the budget's:
    // every closed month is as it closed, so none is changed, re-closed or raised as month_changed.
    assert.deepEqual([run.changed, run.reclosed], [[], []])
    assert.deepEqual(closes(), closed)
    assert.deepEqual(openIssues().filter((i) => i.kind === 'month_changed'), [])
    const now = figures(getWaterfall(october))
    assert.equal(now.digest, was.digest)
    assert.deepEqual(now.tags, { ...was.tags, 'Dining Out': 'essential' })
    assert.equal(ENGINE_VERSION, 3)

    revert(set.changeId)
    assert.equal(db.getSetting('budget.prefs'), stampWas)
    assert.deepEqual(figures(getWaterfall(october)), was)
    assert.deepEqual([(await checkClosed()).changed, closes()], [[], closed])
  })
})
