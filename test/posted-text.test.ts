import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'

// A paycheck can arrive pending in the bank's raw ACH format, get named by
// Claude from that text, then post under the usual payroll text. The posted
// row takes the name its earlier payments had, so its series (and the
// paystub withholding keyed to it) carries on; a name the user gave stays.

const dir = mkdtempSync(join(tmpdir(), 'finance-posted-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const ACCOUNT = 'sf:C:checking'
const PAYROLL = 'NORTHWIND CORP PAYROLL PPD ID: XXXXXX4242'
const RAW = 'ORIG CO NAME:NORTHWIND CORP CO ENTRY DESCR:PAYROLL SEC:PPD IND ID:XXXXXX4242'
const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const sync = (id: string, description: string, pending: boolean): void => {
  db.upsertTransaction({ id, accountId: ACCOUNT, posted: 1_793_000_000, amountCents: 287_513, description, pending })
}

describe('a pending row that posts under new text', () => {
  before(() => {
    db.openDb(join(dir, 'finance.db'))
    db.upsertAccount({ id: ACCOUNT, source: 'simplefin', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.upsertTransaction({ id: 'oct15', accountId: ACCOUNT, posted: 1_791_700_000, amountCents: 287_514, description: PAYROLL, pending: false })
    db.setTransactionFields('oct15', { categoryId: category('Paycheck'), source: 'ai', confidence: 'high', merchant: 'Northwind Payroll' })
  })
  after(db.closeDb)

  test('takes the name its earlier payments had in place of Claude\'s guess at the raw text', () => {
    sync('oct30', RAW, true)
    db.setTransactionFields('oct30', { categoryId: category('Other Income'), source: 'ai', confidence: 'medium', merchant: 'Northwind' })
    sync('oct30', PAYROLL, false)
    const t = db.getTransaction('oct30')!
    assert.deepEqual([t.merchant, t.categoryId, t.categorySource], ['Northwind Payroll', category('Paycheck'), 'ai'])
  })

  test('a name the user gave is kept', () => {
    sync('nov14', RAW, true)
    db.setTransactionFields('nov14', { categoryId: category('Other Income'), source: 'user', merchant: 'Bonus' })
    sync('nov14', PAYROLL, false)
    assert.deepEqual([db.getTransaction('nov14')!.merchant, db.getTransaction('nov14')!.categorySource], ['Bonus', 'user'])
  })
})
