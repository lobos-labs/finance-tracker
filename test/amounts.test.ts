import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { importCsv, preview } from '../src/main/csvImport.ts'
import { centsOf as toCents, isCents, MAX_CENTS, parseAmount, parseDate, rowAmount } from '../src/shared/parse.ts'

// Every amount the app stores is a safe integer of cents within a cap, so one
// huge figure in a CSV or a bank feed can't make every money view fail; dates
// have to be real days; text is capped. Imported and manual rows can be deleted.

const dir = mkdtempSync(join(tmpdir(), 'finance-amounts-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('amount bounds', () => {
  test('parseAmount refuses amounts past the cap and anything unsafe', () => {
    assert.equal(MAX_CENTS, 10_000_000_000_000)
    assert.equal(parseAmount('100000000000.00'), MAX_CENTS)
    assert.equal(parseAmount('100000000000.01'), null)
    assert.equal(parseAmount('1234567890123456'), null)
    assert.equal(parseAmount('(1234567890123456)'), null)
    assert.equal(isCents(2 ** 53), false)
    assert.equal(isCents(1.5), false)
    assert.equal(isCents(-MAX_CENTS), true)
  })

  test('rowAmount keeps the cap after the sign flip and debit/credit sums', () => {
    const m = { date: 0, description: 1, amount: 2, debit: null, credit: null, invertSign: true }
    assert.equal(rowAmount(['d', 'x', '100000000000.00'], m), -MAX_CENTS)
    assert.equal(rowAmount(['d', 'x', '100000000000.01'], m), null)
  })

  test('the bridge\'s amounts go through the same check', () => {
    assert.equal(toCents('12.34'), 1234)
    assert.equal(toCents(12.34), 1234)
    assert.equal(toCents('1e20'), null)
    assert.equal(toCents('abc'), null)
    assert.equal(toCents(null), null)
    assert.equal(toCents({ amount: 1 }), null)
  })

  test('dates have to be real days; bare numbers and codes are not dates', () => {
    assert.equal(parseDate('13/01/2024'), null)
    assert.equal(parseDate('02/30/2024'), null)
    assert.equal(parseDate('2024-13-45'), null)
    assert.equal(parseDate('CHECK 1234'), null)
    assert.equal(parseDate('1'), null)
    assert.equal(parseDate('Payment 2'), null)
    assert.ok(parseDate('02/29/2024') !== null)
    assert.ok(parseDate('Oct 14, 2026') !== null)
  })
})

describe('database writes', () => {
  before(() => {
    db.openDb(join(dir, 'finance.db'))
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'House', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.upsertAccount({ id: 'csv:a', source: 'csv', name: 'Imported', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.upsertAccount({ id: 'sf:c:1', source: 'simplefin', name: 'Bank', institution: null, currency: 'USD', balanceCents: 100, availableCents: null, balanceDate: null })
  })
  after(db.closeDb)

  const t = (id: string, accountId: string, amountCents: number, description = 'x'): boolean => db.upsertTransaction({ id, accountId, posted: 1_760_000_000, amountCents, description, pending: false })

  test('a transaction, a balance point and a flow past the cap are refused', () => {
    assert.throws(() => t('big', 'csv:a', 2 ** 53), /whole number of cents/)
    assert.throws(() => t('big', 'csv:a', MAX_CENTS + 1), /whole number of cents/)
    assert.throws(() => t('frac', 'csv:a', 12.5), /whole number of cents/)
    assert.throws(() => db.setBalancePoint('manual:a', '2026-01-31', MAX_CENTS + 1), /whole number of cents/)
    assert.throws(() => db.addRecordedFlow('manual:a', '2026-01-31', 2 ** 53, null), /whole number of cents/)
    assert.throws(() => db.updateAccount('csv:a', { balanceCents: 2 ** 53 }), /whole number of cents/)
    assert.equal(db.getTransaction('big'), null)
    assert.equal(t('ok', 'csv:a', -MAX_CENTS), true)
  })

  test('an impossible day is refused instead of rolled into the next month', () => {
    assert.throws(() => db.setBalancePoint('manual:a', '2026-02-30', 100), /date like/)
    assert.throws(() => db.addCalendarEvent({ day: '2026-04-31', title: 'x' }), /date like/)
    db.setBalancePoint('manual:a', '2024-02-29', 100)
  })

  test('text is cleaned and capped on the way in', () => {
    t('long', 'csv:a', -100, `A\u0000B​C  D${'x'.repeat(400)}`)
    const d = db.getTransaction('long')!.description
    assert.equal(d.length, db.DESCRIPTION_MAX)
    assert.ok(d.startsWith('ABC D'))
    db.setTransactionFields('long', { notes: 'n'.repeat(3000), merchant: 'm'.repeat(300) })
    assert.equal(db.getTransaction('long')!.notes!.length, db.NOTES_MAX)
    assert.equal(db.getTransaction('long')!.merchant!.length, db.MERCHANT_MAX)
  })

  test('a sync never replaces a balance the user entered on the same day', () => {
    db.setBalancePoint('csv:a', '2026-03-31', 5000)
    db.upsertAccount({ id: 'csv:a', source: 'csv', name: 'Imported', institution: null, currency: 'USD', balanceCents: 1, availableCents: null, balanceDate: Math.floor(new Date('2026-03-31T12:00:00').getTime() / 1000) })
    assert.deepEqual({ ...db.listBalancePoints('csv:a').find((p) => p.day === '2026-03-31') }, { day: '2026-03-31', cents: 5000, source: 'manual' })
  })

  test('imported and manual rows can be deleted; a bank-synced row cannot', () => {
    t('csv:a:csv:abc', 'csv:a', -100)
    t('sf:c:1:txn', 'sf:c:1', -100)
    t('sf:c:1:csv:merged', 'sf:c:1', -100)
    assert.equal(db.isDeletableTransaction('csv:a:csv:abc'), true)
    assert.equal(db.isDeletableTransaction('sf:c:1:csv:merged'), true)
    assert.equal(db.isDeletableTransaction('sf:c:1:txn'), false)
    assert.equal(db.deleteTransaction('csv:a:csv:abc')!.id, 'csv:a:csv:abc')
    assert.equal(db.getTransaction('csv:a:csv:abc'), null)
    assert.throws(() => db.deleteTransaction('sf:c:1:txn'), /come back/)
    assert.equal(db.deleteTransaction('missing'), null)
  })

  test('a CSV row with an amount past the cap is counted as unreadable and skipped', () => {
    const file = join(dir, 'huge.csv')
    writeFileSync(file, 'Date,Description,Amount\n10/01/2026,Fine,-4.50\n10/02/2026,Card number as amount,4111111111111111\n10/03/2026,Also fine,-1.00\n')
    const p = preview(file)
    assert.equal(p.unreadable, 1)
    const r = importCsv({ token: p.token, mapping: p.guess, accountId: 'csv:a' })
    assert.deepEqual([r.imported, r.invalid], [2, 1])
  })
})
