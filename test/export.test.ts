import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addFact, closeDb, exportAll, LATEST_SCHEMA_VERSION, openDb, setSetting } from '../src/main/db.ts'

const dir = mkdtempSync(join(tmpdir(), 'finance-export-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('the full export', () => {
  before(() => {
    openDb(join(dir, 'finance.db'))
    addFact('Rent is due on the 1st')
    setSetting('ai.model', 'claude-opus-5-5')
    setSetting('secret.simplefinAccessUrl', 'ZW5jcnlwdGVk')
  })
  after(closeDb)

  test('has every table as rows, and no secrets', () => {
    const out = exportAll()
    assert.equal(out.schemaVersion, LATEST_SCHEMA_VERSION)
    assert.ok(!Number.isNaN(Date.parse(out.exportedAt)))
    for (const t of ['accounts', 'transactions', 'categories', 'rules', 'settings', 'facts', 'calendar_events', 'recorded_flows', 'flows_known_from']) assert.ok(t in out.tables, t)
    assert.ok(!('sqlite_sequence' in out.tables))
    assert.equal(out.tables.categories.length, 25)
    assert.deepEqual(out.tables.facts.map((r) => r.text), ['Rent is due on the 1st'])
    assert.deepEqual(out.tables.settings.map((r) => r.key), ['ai.model'])
    assert.ok(JSON.stringify(out).length > 0)
  })
})
