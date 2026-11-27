import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addFact, closeDb, deleteFact, FACTS_LIMIT, finishPendingAction, listFacts, listPendingActions, openDb, PROMPT_FACTS_LIMIT, promptFacts } from '../src/main/db.ts'
import { describeCall, runAssistantTool, runTool, toolRisk } from '../src/main/tools.ts'

const dir = mkdtempSync(join(tmpdir(), 'finance-pending-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('destructive assistant calls wait for the user', () => {
  before(() => openDb(join(dir, 'finance.db')))
  after(closeDb)

  test('every tool carries a risk, and the input decides for the two that depend on it', () => {
    assert.equal(toolRisk('search_transactions', {}), 'read')
    assert.equal(toolRisk('list_documents', {}), 'read')
    assert.equal(toolRisk('categorize', { transaction_ids: ['t'], category: 'Groceries' }), 'write')
    assert.equal(toolRisk('resolve_issue', { issue_key: 'x' }), 'write')
    assert.equal(toolRisk('delete_tax_year', { year: 2024 }), 'destructive')
    assert.equal(toolRisk('forget', { fact_id: 1 }), 'destructive')
    assert.equal(toolRisk('delete_category', { category: 'Other' }), 'destructive')
    assert.equal(toolRisk('rename_transactions', { transaction_ids: ['t'], description: 'x' }), 'destructive')
    assert.equal(toolRisk('hide_vendor', { vendor: 'Acme Store' }), 'destructive')
    assert.equal(toolRisk('hide_vendor', { vendor: 'Acme Store', hidden: false }), 'write')
    assert.equal(toolRisk('update_account', { account_id: 'a', name: 'Checking' }), 'write')
    assert.equal(toolRisk('update_account', { account_id: 'a', hidden: true }), 'destructive')
    assert.equal(toolRisk('update_account', { account_id: 'a', closed: '2026-01-31' }), 'destructive')
    assert.equal(toolRisk('update_account', { account_id: 'a', closed: '' }), 'write')
  })

  test('an ordinary write runs at once, with the assistant as the fact\'s origin', () => {
    const r = runAssistantTool('remember', { fact: 'Rent is paid on the 1st' })
    assert.equal(r.pending, undefined)
    assert.match(r.action!, /^Remembered: Rent/)
    const f = listFacts()
    assert.equal(f.length, 1)
    assert.equal(f[0].origin, 'assistant')
    assert.deepEqual(listPendingActions(), [])
  })

  test('a destructive call is queued, not run', () => {
    const id = listFacts()[0].id
    const r = runAssistantTool('forget', { fact_id: id })
    assert.equal(typeof r.pending, 'number')
    assert.equal(r.action, undefined)
    assert.equal((r.result as { queued_for_approval: boolean }).queued_for_approval, true)
    assert.equal(listFacts().length, 1)
    const pending = listPendingActions()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].tool, 'forget')
    assert.deepEqual(JSON.parse(pending[0].input), { fact_id: id })
    assert.equal(describeCall(pending[0].tool, JSON.parse(pending[0].input)), `forget · fact_id ${id}`)
  })

  test('approving runs the stored call; discarding drops it', () => {
    const [p] = listPendingActions()
    const r = runTool(p.tool, JSON.parse(p.input), 'user')
    finishPendingAction(p.id, 'done')
    assert.match(r.action!, /^Forgot: Rent/)
    assert.equal(listFacts().length, 0)
    assert.deepEqual(listPendingActions(), [])

    runAssistantTool('hide_vendor', { vendor: 'Acme Store' })
    const [q] = listPendingActions()
    finishPendingAction(q.id, 'discarded')
    assert.deepEqual(listPendingActions(), [])
  })

  test('the bridge runs destructive tools itself and records the bridge as the origin', () => {
    const r = runTool('hide_vendor', { vendor: 'Acme Store' }, 'bridge')
    assert.equal(r.action, 'Vendor hidden: Acme Store')
    assert.throws(() => runTool('hide_vendor', { vendor: 'ab' }), /3 characters/)
    runTool('remember', { fact: 'From a script' }, 'bridge')
    assert.equal(listFacts()[0].origin, 'bridge')
    runTool('forget', { fact_id: listFacts()[0].id }, 'bridge')
  })

  test('categorization prompts take the shortest facts that fit, in the order they were saved', () => {
    const big = Array.from({ length: PROMPT_FACTS_LIMIT / 2000 }, (_, i) => addFact(String(i).padEnd(2000, 'x'), 'user'))
    const short = addFact('Zelle to Sam is the hairdresser', 'user')
    assert.deepEqual(promptFacts().map((f) => f.id), [...big.slice(0, -1), short])
    assert.equal(listFacts().length, big.length + 1)
    for (const id of [...big, short]) deleteFact(id)
  })

  test('the facts together stay under the limit', () => {
    const big = 'x'.repeat(2000)
    for (let i = 0; i < FACTS_LIMIT / 2000; i++) addFact(big, 'user')
    assert.throws(() => addFact('one more', 'assistant'), /full.*forget/)
    assert.throws(() => runAssistantTool('remember', { fact: 'one more' }), /full.*forget/)
  })
})
