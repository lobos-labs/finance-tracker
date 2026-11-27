import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRulesToAll, closeDb, getTransaction, listCategories, openDb, setTransactionFields, upsertAccount, upsertRule, upsertTransaction } from '../src/main/db.ts'

const dir = mkdtempSync(join(tmpdir(), 'finance-writes-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const category = (name: string): number => listCategories().find((c) => c.name === name)!.id
const txn = (id: string, description: string): void => {
  upsertTransaction({ id, accountId: 'manual:a', posted: 1_760_000_000, amountCents: -1234, description, pending: false })
}

describe('automatic writes never replace a category the user set', () => {
  before(() => {
    openDb(join(dir, 'finance.db'))
    upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    txn('t1', 'COSTCO WHSE #123')
    txn('t2', 'COSTCO GAS #123')
  })
  after(closeDb)

  test('Claude and rules set a category while there is none, and may replace each other', () => {
    setTransactionFields('t1', { categoryId: category('Shopping'), source: 'ai', confidence: 'medium', merchant: 'Costco' })
    assert.deepEqual([getTransaction('t1')!.categoryId, getTransaction('t1')!.categorySource, getTransaction('t1')!.merchant], [category('Shopping'), 'ai', 'Costco'])
    setTransactionFields('t1', { categoryId: category('Groceries'), source: 'rule' })
    assert.deepEqual([getTransaction('t1')!.categoryId, getTransaction('t1')!.categorySource], [category('Groceries'), 'rule'])
  })

  test('once the user has chosen, Claude and rules leave the row alone', () => {
    setTransactionFields('t1', { categoryId: category('Dining Out'), source: 'user' })
    setTransactionFields('t1', { categoryId: category('Groceries'), source: 'ai', confidence: 'high', merchant: 'Costco Wholesale' })
    setTransactionFields('t1', { categoryId: category('Groceries'), source: 'rule' })
    const t = getTransaction('t1')!
    assert.deepEqual([t.categoryId, t.categorySource, t.merchant], [category('Dining Out'), 'user', 'Costco'])
  })

  test('applying rules to everything skips the user\'s rows', () => {
    upsertRule('contains', 'costco', category('Groceries'))
    assert.equal(applyRulesToAll(), 1)
    assert.deepEqual([getTransaction('t1')!.categoryId, getTransaction('t2')!.categoryId, getTransaction('t2')!.categorySource], [category('Dining Out'), category('Groceries'), 'rule'])
  })

  test('the user can still change their mind, and other fields are untouched by the guard', () => {
    setTransactionFields('t1', { categoryId: category('Groceries'), source: 'user' })
    setTransactionFields('t1', { notes: 'bulk run' })
    assert.deepEqual([getTransaction('t1')!.categoryId, getTransaction('t1')!.notes], [category('Groceries'), 'bulk run'])
  })
})
