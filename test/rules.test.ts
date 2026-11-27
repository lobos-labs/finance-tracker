import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { vendorHider } from '../src/main/privacy.ts'
import { RULE_LIMIT, runAssistantTool, runTool, toolRisk } from '../src/main/tools.ts'

// A rule can't match on one or two characters, and one that would rewrite
// hundreds of transactions at once waits for the user like a delete does.

// The tools run as in a development build: every plan feature on (the plan gates are tested in license.test.ts).
configureLicense({ dev: true })

const dir = mkdtempSync(join(tmpdir(), 'finance-rules-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id

describe('rules', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
    db.openDb(join(dir, 'finance.db'))
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.saveBucket({ name: 'Rental', kind: 'rental' })
    for (let i = 1; i <= RULE_LIMIT + 50; i++) db.upsertTransaction({ id: `t${i}`, accountId: 'manual:a', posted: 1_760_000_000 + i, amountCents: -1000, description: `PAYMENT ${i} ONLINE`, pending: false })
    db.upsertTransaction({ id: 'user', accountId: 'manual:a', posted: 1_760_000_000, amountCents: -1000, description: 'PAYMENT BY HAND', pending: false })
    db.setTransactionFields('user', { categoryId: category('Housing'), source: 'user' })
  })
  after(db.closeDb)

  test('a "contains" pattern needs at least three characters', () => {
    assert.throws(() => db.upsertRule('contains', 'ay', category('Transfers')), /3 characters/)
    assert.throws(() => db.upsertRule('contains', ' a  ', category('Transfers')), /3 characters/)
    assert.throws(() => runAssistantTool('create_rule', { field: 'contains', pattern: 'e', category: 'Transfers' }), /3 characters/)
    assert.throws(() => db.addBucketRule({ bucketId: db.bucketByName('Rental')!.id, contains: 'ay' }), /3 characters/)
    assert.equal(db.listRules().length, 0)
  })

  test('the match count counts only rows the rule would change', () => {
    assert.equal(db.countRuleMatches('contains', 'payment', category('Transfers')), RULE_LIMIT + 50)
    assert.equal(db.countRuleMatches('contains', 'payment 25', category('Transfers')), 2)
    assert.equal(db.countRuleMatches('merchant', 'nothing', category('Transfers')), 0)
  })

  test('a rule over the limit is destructive: queued for the assistant, confirmed by the bridge, run on approval', () => {
    const big = { field: 'contains', pattern: 'payment', category: 'Transfers' }
    const small = { field: 'contains', pattern: 'payment 25', category: 'Transfers' }
    assert.equal(toolRisk('create_rule', big), 'destructive')
    assert.equal(toolRisk('create_rule', small), 'write')
    const r = runAssistantTool('create_rule', big)
    assert.equal(typeof r.pending, 'number')
    assert.equal((r.result as { would_change: number }).would_change, RULE_LIMIT + 50)
    assert.equal(db.listRules().length, 0)
    assert.equal(db.listPendingActions().length, 1)
    // Approved: it runs as the user's own decision and is journaled, so it can still be undone.
    const approved = runTool('create_rule', big, 'user')
    assert.deepEqual(approved.result, { matched: RULE_LIMIT + 50, applied_to: RULE_LIMIT + 50 })
    assert.equal(db.getTransaction('user')!.categoryId, category('Housing'))
    const c = db.getChange(approved.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    assert.equal(db.listRules().length, 0)
    assert.equal(db.getTransaction('t1')!.categoryId, null)
    assert.equal(db.getTransaction('user')!.categoryId, category('Housing'))
  })

  test('a small rule runs at once', () => {
    const r = runAssistantTool('create_rule', { field: 'contains', pattern: 'payment 25', category: 'Transfers' })
    assert.equal(r.pending, undefined)
    assert.deepEqual(r.result, { matched: 2, applied_to: 2 })
    assert.equal(db.getTransaction('t25')!.categorySource, 'rule')
  })

  test('a bucket rule over the limit waits too', () => {
    assert.equal(toolRisk('add_bucket_rule', { bucket: 'Rental', contains: 'payment' }), 'destructive')
    assert.equal(toolRisk('add_bucket_rule', { bucket: 'Rental', contains: 'payment 26' }), 'write')
    const r = runAssistantTool('add_bucket_rule', { bucket: 'Rental', contains: 'payment' })
    assert.equal(typeof r.pending, 'number')
    assert.equal(db.listBucketRules().length, 0)
    // t25 and t250 became transfers above, which bucket rules leave alone; "payment 26" matches t26 alone.
    const small = runAssistantTool('add_bucket_rule', { bucket: 'Rental', contains: 'payment 26' })
    assert.equal((small.result as { moved: number }).moved, 1)
    assert.equal(db.getTransaction('t26')!.bucketId, db.bucketByName('Rental')!.id)
    const c = db.getChange(small.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    assert.equal(db.listBucketRules().length, 0)
    assert.equal(db.getTransaction('t26')!.bucketId, null)
  })
})

describe('hidden vendors', () => {
  test('a short name hides whole words only; a longer one hides wherever it appears', () => {
    const short = vendorHider(['Acme'])
    assert.equal(short('ACME STORE #12'), true)
    assert.equal(short('acme'), true)
    assert.equal(short('MACME DEPOT'), false)
    assert.equal(short('ACMEX'), false)
    const long = vendorHider(['acme store'])
    assert.equal(long('THE ACME STOREFRONT'), true)
    assert.equal(long('ACME'), false)
    assert.equal(vendorHider([])('anything'), false)
    assert.equal(vendorHider(['a.b'])('a.b co'), true)
    assert.equal(vendorHider(['a.b'])('axb co'), false)
  })
})
