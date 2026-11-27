import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { openIssues, runAssistantTool, runTool, setTurnId } from '../src/main/tools.ts'

// Every write a tool makes is journaled with the rows it replaced, and the
// journal can put them back. The assistant's own categorizations are marked
// as its, kept like the user's, and never mistaken for a hand edit.

// The tools run as in a development build: every plan feature on (the plan gates are tested in license.test.ts).
configureLicense({ dev: true })

const dir = mkdtempSync(join(tmpdir(), 'finance-journal-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const txn = (id: string, description: string, cents = -1234): void => {
  db.upsertTransaction({ id, accountId: 'manual:a', posted: 1_760_000_000, amountCents: cents, description, pending: false })
}
/** Undoes a change the way the Review chat does. */
const revert = (changeId: number): void => {
  const c = db.getChange(changeId)!
  assert.equal(c.undoneAt, null)
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId)
}

describe('the changes journal', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
    db.openDb(join(dir, 'finance.db'))
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    txn('t1', 'COSTCO WHSE #123')
    txn('t2', 'COSTCO GAS #123')
    txn('t3', 'NETFLIX.COM')
    setTurnId('turn-1')
  })
  after(db.closeDb)

  test('the assistant\'s categorize is marked as its, is kept like the user\'s, and can be undone', () => {
    const r = runAssistantTool('categorize', { transaction_ids: ['t1'], category: 'Groceries' })
    assert.equal(typeof r.changeId, 'number')
    assert.deepEqual([db.getTransaction('t1')!.categoryId, db.getTransaction('t1')!.categorySource], [category('Groceries'), 'assistant'])
    // Claude's categorizer and rules never replace it.
    db.setTransactionFields('t1', { categoryId: category('Shopping'), source: 'ai', confidence: 'high' })
    db.setTransactionFields('t1', { categoryId: category('Shopping'), source: 'rule' })
    assert.equal(db.getTransaction('t1')!.categoryId, category('Groceries'))
    const c = db.getChange(r.changeId!)!
    assert.deepEqual([c.tool, c.origin, c.turnId], ['categorize', 'assistant', 'turn-1'])
    assert.deepEqual((c.before as { rows: Array<{ id: string; categoryId: number | null }> }).rows, [{ id: 't1', categoryId: null, source: null, confidence: null, merchant: null }])
    revert(r.changeId!)
    assert.deepEqual([db.getTransaction('t1')!.categoryId, db.getTransaction('t1')!.categorySource], [null, null])
    assert.equal(typeof db.getChange(r.changeId!)!.undoneAt, 'number')
  })

  test('categorize with remember makes a rule; undo removes the rule, the row\'s category, and puts back every other row the rule moved', () => {
    // Two more of the merchant's charges, already filed elsewhere by the AI: the new rule moves them too.
    txn('t4', 'NETFLIX.COM 0412', -1599)
    txn('t5', 'NETFLIX.COM 0512', -1699)
    for (const id of ['t4', 't5']) db.setTransactionFields(id, { categoryId: category('Shopping'), source: 'ai', confidence: 'high', merchant: 'Netflix' })
    const filed = (id: string): unknown[] => [db.getTransaction(id)!.categoryId, db.getTransaction(id)!.categorySource]
    const r = runAssistantTool('categorize', { transaction_ids: ['t3'], category: 'Subscriptions', merchant: 'Netflix', remember: true })
    assert.deepEqual(r.result, { updated: 1, rule_applied_to_others: 2 })
    assert.equal(db.listRules().length, 1)
    assert.equal(db.getTransaction('t3')!.merchant, 'Netflix')
    assert.deepEqual([filed('t4'), filed('t5')], [[category('Subscriptions'), 'rule'], [category('Subscriptions'), 'rule']])
    revert(r.changeId!)
    assert.equal(db.listRules().length, 0)
    assert.deepEqual([db.getTransaction('t3')!.categoryId, db.getTransaction('t3')!.merchant], [null, null])
    // Back where the AI had them, not left under a rule that is gone.
    for (const id of ['t4', 't5']) assert.deepEqual([...filed(id), db.getTransaction(id)!.confidence], [category('Shopping'), 'ai', 'high'], id)
    // Out of the way of the cases after this one.
    for (const id of ['t4', 't5']) db.deleteTransaction(id)
  })

  test('set_note, mark_one_time and set_bucket go back to what they replaced', () => {
    db.setTransactionFields('t2', { notes: 'old note' })
    const note = runAssistantTool('set_note', { transaction_ids: ['t1', 't2'], note: 'new note' })
    assert.deepEqual([db.getTransaction('t1')!.notes, db.getTransaction('t2')!.notes], ['new note', 'new note'])
    revert(note.changeId!)
    assert.deepEqual([db.getTransaction('t1')!.notes, db.getTransaction('t2')!.notes], [null, 'old note'])

    const one = runAssistantTool('mark_one_time', { transaction_ids: ['t1'], one_time: true })
    assert.equal(db.getTransaction('t1')!.oneTime, true)
    revert(one.changeId!)
    assert.equal(db.getTransaction('t1')!.oneTime, false)

    db.saveBucket({ name: 'Rental', kind: 'rental' })
    const bucket = runAssistantTool('set_bucket', { transaction_ids: ['t2'], bucket: 'Rental' })
    assert.equal(db.getTransaction('t2')!.bucketId, db.bucketByName('Rental')!.id)
    revert(bucket.changeId!)
    assert.equal(db.getTransaction('t2')!.bucketId, null)
  })

  test('remember and forget: the fact comes back under its old id', () => {
    const r = runAssistantTool('remember', { fact: 'Rent is paid on the 1st' })
    const id = db.listFacts()[0].id
    revert(r.changeId!)
    assert.equal(db.listFacts().length, 0)
    runAssistantTool('remember', { fact: 'Rent is paid on the 1st' })
    const fact = db.listFacts()[0]
    // forget is destructive: the assistant's call is queued, not journaled; the approval run is.
    const queued = runAssistantTool('forget', { fact_id: fact.id })
    assert.equal(queued.changeId, undefined)
    const approved = runTool('forget', { fact_id: fact.id }, 'user')
    assert.equal(db.listFacts().length, 0)
    assert.equal(db.getChange(approved.changeId!)!.origin, 'user')
    revert(approved.changeId!)
    assert.deepEqual(db.listFacts().map((f) => [f.id, f.text]), [[fact.id, 'Rent is paid on the 1st']])
    assert.ok(id > 0)
  })

  test('resolve_issue names the issue it skips, lists it as resolved, and undo brings it back', () => {
    const key = openIssues().find((i) => i.kind === 'uncategorized' && i.transaction_ids?.includes('t3'))!.key
    assert.throws(() => runAssistantTool('resolve_issue', { issue_key: 'uncategorized:nothing' }), /No open issue/)
    const r = runAssistantTool('resolve_issue', { issue_key: key, note: 'a one-off' })
    assert.match(r.action!, /^Skipped: 1 uncategorized "NETFLIX\.COM"/)
    assert.match(r.action!, /a one-off/)
    assert.ok(!openIssues().some((i) => i.key === key))
    const resolved = db.listResolvedIssues()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].key, key)
    assert.match(resolved[0].summary!, /NETFLIX/)
    assert.equal(resolved[0].note, 'a one-off')
    revert(r.changeId!)
    assert.deepEqual(db.listResolvedIssues(), [])
    assert.ok(openIssues().some((i) => i.key === key))
    // The list's own control.
    runAssistantTool('resolve_issue', { issue_key: key })
    assert.equal(db.unresolveIssue(key), true)
    assert.equal(db.unresolveIssue(key), false)
  })

  test('create_rule keeps the rows it changes; undo removes the rule and restores them', () => {
    db.setTransactionFields('t2', { categoryId: category('Gas & Fuel'), source: 'ai', confidence: 'medium' })
    const r = runAssistantTool('create_rule', { field: 'contains', pattern: 'costco', category: 'Groceries' })
    assert.deepEqual(r.result, { matched: 2, applied_to: 2 })
    assert.equal(db.getTransaction('t2')!.categorySource, 'rule')
    revert(r.changeId!)
    assert.equal(db.listRules().length, 0)
    assert.deepEqual([db.getTransaction('t1')!.categoryId, db.getTransaction('t2')!.categoryId, db.getTransaction('t2')!.categorySource], [null, category('Gas & Fuel'), 'ai'])
  })

  test('record_balance, delete_calendar_event and update_account round-trip', () => {
    const point = runAssistantTool('record_balance', { account_id: 'manual:a', date: '2026-01-31', amount: 100 })
    assert.equal(db.listBalancePoints('manual:a').length, 1)
    revert(point.changeId!)
    assert.deepEqual(db.listBalancePoints('manual:a'), [])

    const id = db.addCalendarEvent({ day: '2030-01-01', title: 'Pay the thing', notes: 'policy 123', createdBy: 'user' })
    const gone = runTool('delete_calendar_event', { event_id: id }, 'user')
    assert.equal(db.listCalendarEvents('2000-01-01').length, 0)
    revert(gone.changeId!)
    assert.deepEqual(db.listCalendarEvents('2000-01-01').map((e) => [e.id, e.title, e.notes]), [[id, 'Pay the thing', 'policy 123']])

    const renamed = runAssistantTool('update_account', { account_id: 'manual:a', name: 'Everyday', details: 'ending 1234' })
    assert.deepEqual([db.listAccounts()[0].name, db.listAccounts()[0].details], ['Everyday', 'ending 1234'])
    revert(renamed.changeId!)
    assert.deepEqual([db.listAccounts()[0].name, db.listAccounts()[0].details], ['Checking', null])
  })

  test('a change can be undone once', () => {
    const r = runAssistantTool('set_note', { transaction_ids: ['t1'], note: 'x' })
    revert(r.changeId!)
    assert.equal(typeof db.getChange(r.changeId!)!.undoneAt, 'number')
  })
})
