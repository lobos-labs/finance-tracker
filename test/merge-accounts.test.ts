import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { findLimit, setLimit } from '../src/main/credit.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { runTool } from '../src/main/tools.ts'

// A reconnected bank comes back as a new account, and every transaction from
// the new feed's start counts twice. merge_accounts folds the old account into
// the live one: each pair is kept once with what the user set on the old row,
// statement rows the feed lacks move over, and Undo puts both accounts back.

configureLicense({ dev: true })

const dir = mkdtempSync(join(tmpdir(), 'finance-merge-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const OLD = 'sf:MBR-1:ACT-old'
const NEW = 'sf:MBR-2:ACT-new'
const at = (day: string): number => Math.floor(new Date(`${day}T12:00:00`).getTime() / 1000)
const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const card = (id: string, name: string, cents: number, day: string): void =>
  db.upsertAccount({ id, source: 'simplefin', name, institution: 'Fernwhistle Bank', currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: at(day) })
const txn = (id: string, account: string, day: string, cents: number, description: string, pending = false): void => {
  db.upsertTransaction({ id, accountId: account, posted: at(day), amountCents: cents, description, pending })
}
const count = (account: string): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?', account)!.n

describe('merging a reconnected feed', () => {
  let bucket = 0
  before(() => {
    db.openDb(join(dir, 'finance.db'))
    card(OLD, 'Fernwhistle Rewards Card', -90_000, '2017-09-16')
    db.updateAccount(OLD, { openedDay: '2012-03-17', closedDay: '2017-09-21', apr: 12 })
    card(NEW, 'Fernwhistle Rewards Card (reconnected)', -65_000, '2017-09-25')
    db.updateAccount(NEW, { openedDay: '2017-09-08' })
    // The old feed's history, a fee from an imported statement that the feed doesn't carry, a pair, and a pending charge that posted on the new feed.
    txn(`${OLD}:t-early`, OLD, '2017-07-10', -1_200, 'BOOK SHOP')
    txn(`${OLD}:csv:fee`, OLD, '2017-07-26', -6_000, 'ANNUAL FEE')
    txn(`${OLD}:t-garden`, OLD, '2017-09-13', -13_000, 'GARDEN STORE')
    txn(`${OLD}:t-bistro`, OLD, '2017-09-10', -3_000, 'CORNER BISTRO', true)
    txn(`${NEW}:n-garden`, NEW, '2017-09-15', -13_000, 'GARDEN STORE')
    txn(`${NEW}:n-bistro`, NEW, '2017-09-09', -3_600, 'CORNER BISTRO')
    txn(`${NEW}:n-later`, NEW, '2017-09-24', -4_500, 'BIKE REPAIR')
    db.setTransactionFields(`${OLD}:t-garden`, { categoryId: category('Housing'), source: 'user', notes: 'two planters' })
    db.setTransactionFields(`${NEW}:n-garden`, { categoryId: category('Shopping'), source: 'ai', confidence: 'low' })
    db.setOneTime([`${OLD}:t-garden`], true)
    db.splitTransaction(`${OLD}:t-garden`, [{ amountCents: -11_000, categoryId: category('Housing') }, { amountCents: -2_000, categoryId: category('Housing') }])
    db.addTags([`${OLD}:t-garden`], ['patio'])
    db.setBalancePoint(OLD, '2017-07-26', -120_000)
    db.setBalancePoint(OLD, '2012-07-20', -15_000)
    bucket = db.saveBucket({ name: 'Studio', kind: 'business' })
    db.addBucketRule({ bucketId: bucket, accountId: OLD, contains: 'annual fee' })
    setLimit(OLD, 300_000)
  })
  after(db.closeDb)

  test('keeps each pair once with the old row\'s choices, moves the rest, and ignores the old feed', () => {
    const r = runTool('merge_accounts', { from_account_id: OLD, into_account_id: NEW, name: 'Fernwhistle Rewards Card' })
    assert.deepEqual(r.result, { matched: 1, moved: 2, dropped: 1, points: 2 })
    assert.equal(db.get('SELECT 1 FROM accounts WHERE id = ?', OLD), undefined)
    assert.equal(count(NEW), 5)

    const garden = db.getTransaction(`${NEW}:n-garden`)!
    assert.deepEqual([garden.categoryId, garden.categorySource, garden.notes, garden.oneTime], [category('Housing'), 'user', 'two planters', true])
    assert.equal(garden.splits.length, 2)
    assert.deepEqual(garden.tags, ['patio'])
    // The pending charge went (it posted on the new feed for a different amount); the statement row and older history came over.
    assert.equal(db.getTransaction(`${OLD}:t-bistro`), null)
    assert.equal(db.getTransaction(`${OLD}:csv:fee`)!.accountId, NEW)
    assert.equal(db.getTransaction(`${OLD}:t-early`)!.accountId, NEW)

    const a = db.listAccounts().find((x) => x.id === NEW)!
    assert.deepEqual([a.name, a.openedDay, a.closedDay, a.apr], ['Fernwhistle Rewards Card', '2012-03-17', null, 12])
    // Entered balances came over; the old feed's own synced balance from after the new feed started didn't.
    assert.deepEqual(db.listBalancePoints(NEW).map((p) => [p.day, p.source]), [['2012-07-20', 'manual'], ['2017-07-26', 'manual'], ['2017-09-25', 'sync']])
    assert.equal(db.listBucketRules(bucket)[0].accountId, NEW)
    assert.equal(findLimit(NEW)?.cents, 300_000)
    assert.deepEqual(db.mergedAccounts(), { [OLD]: NEW })
  })

  test('undo puts both accounts back as they were', () => {
    const c = db.getChange(db.get<{ id: number }>("SELECT MAX(id) AS id FROM changes WHERE tool = 'merge_accounts'")!.id)!
    undo(c.tool, c.before, c.after, c.input)
    assert.deepEqual([count(OLD), count(NEW)], [4, 3])
    const garden = db.getTransaction(`${NEW}:n-garden`)!
    assert.deepEqual([garden.categoryId, garden.categorySource, garden.notes, garden.oneTime, garden.splits.length, garden.tags], [category('Shopping'), 'ai', null, false, 0, []])
    const old = db.getTransaction(`${OLD}:t-garden`)!
    assert.deepEqual([old.notes, old.splits.length, old.tags], ['two planters', 2, ['patio']])
    const accounts = db.listAccounts()
    assert.deepEqual(accounts.find((x) => x.id === OLD)!.closedDay, '2017-09-21')
    assert.deepEqual(accounts.find((x) => x.id === NEW)!.openedDay, '2017-09-08')
    assert.deepEqual(db.listBalancePoints(NEW).map((p) => p.day), ['2017-09-25'])
    assert.equal(db.listBalancePoints(OLD).length, 3)
    assert.equal(db.listBucketRules(bucket)[0].accountId, OLD)
    assert.deepEqual([findLimit(OLD)?.cents, findLimit(NEW)], [300_000, null])
    assert.deepEqual(db.mergedAccounts(), {})
  })

  test('only accounts with transactions merge, never one into itself', () => {
    assert.throws(() => runTool('merge_accounts', { from_account_id: OLD, into_account_id: OLD }), /itself/)
    const house = db.addManualAccount({ name: 'House', assetType: 'real_estate', points: [{ day: '2024-01-01', cents: 30_000_000 }] })
    assert.throws(() => runTool('merge_accounts', { from_account_id: house, into_account_id: NEW }), /manual/)
  })
})
