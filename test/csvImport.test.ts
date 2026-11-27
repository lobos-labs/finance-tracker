import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { importCsv, preview } from '../src/main/csvImport.ts'
import { planState } from '../src/main/license.ts'
import type { CsvMapping } from '../src/shared/types.ts'
import { noonOn } from './days.ts'

const dir = mkdtempSync(join(tmpdir(), 'ft-csv-'))
before(() => db.openDb(join(dir, 'test.db')))
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

let files = 0
const csv = (text: string, name = `statement-${files++}.csv`): string => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}
const noon = noonOn

const account = (name: string): string => {
  const id = `acct:${name.toLowerCase()}`
  db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  return id
}
const rows = (accountId: string): Array<[number, number, string]> =>
  db
    .all<{ posted: number; cents: number; description: string }>('SELECT posted, amount_cents AS cents, description FROM transactions WHERE account_id = ? ORDER BY posted, description', accountId)
    .map((r) => [r.posted, r.cents, r.description])

/** Previews a file and imports it with the guessed mapping. */
const run = (file: string, accountId?: string, mapping?: Partial<CsvMapping>): ReturnType<typeof importCsv> => {
  const p = preview(file)
  return importCsv({ token: p.token, mapping: { ...p.guess, ...mapping }, accountId })
}

const BANK = `Date,Description,Amount
10/01/2026,ACME PAYROLL,2500.00
10/03/2026,Blue Bottle,-4.50
10/03/2026,Blue Bottle,-4.50
10/05/2026,Netflix,-15.99
10/07/2026,Rent,"-1,850.00"
`
const BANK_ROWS: Array<[number, number, string]> = [
  [noon(2026, 10, 1), 250000, 'ACME PAYROLL'],
  [noon(2026, 10, 3), -450, 'Blue Bottle'],
  [noon(2026, 10, 3), -450, 'Blue Bottle'],
  [noon(2026, 10, 5), -1599, 'Netflix'],
  [noon(2026, 10, 7), -185000, 'Rent']
]

const CARD = `Transaction Date,Description,Amount
10/02/2026,Trader Joes,54.12
10/03/2026,Shell,40.00
10/04/2026,Amazon,23.99
10/05/2026,Spotify,11.99
10/06/2026,PAYMENT THANK YOU,-500.00
`

describe('column guessing', () => {
  test('date, description, amount', () => {
    const p = preview(csv(BANK))
    assert.deepEqual(p.headers, ['Date', 'Description', 'Amount'])
    assert.deepEqual(p.guess, { date: 0, description: 1, amount: 2, debit: null, credit: null, invertSign: false, balance: null })
    assert.equal(p.rowCount, 5)
    assert.equal(p.sample.length, 5)
    assert.deepEqual(p.sample[0], ['10/01/2026', 'ACME PAYROLL', '2500.00'])
  })

  test('amount first, then payee, then the transaction date', () => {
    const p = preview(csv('Amount,Payee,Transaction Date\n-4.50,Blue Bottle,10/03/2026\n-15.99,Netflix,10/05/2026\n'))
    assert.deepEqual(p.guess, { date: 2, description: 1, amount: 0, debit: null, credit: null, invertSign: false, balance: null })
  })

  test('debit and credit columns', () => {
    const p = preview(csv('Posted Date,Details,Debit,Credit\n10/01/2026,Paycheck,,2500.00\n10/02/2026,Grocery,82.10,\n'))
    assert.deepEqual(p.guess, { date: 0, description: 1, amount: null, debit: 2, credit: 3, invertSign: false, balance: null })
  })

  test('the header row is found below a preamble', () => {
    const p = preview(csv(`Account: Checking ****1234\nPeriod: 09/01/2026 to 09/30/2026\n\n${BANK}`))
    assert.deepEqual(p.headers, ['Date', 'Description', 'Amount'])
    assert.equal(p.rowCount, 5)
    assert.equal(p.guess.date, 0)
  })

  test('a byte-order mark and a blank header cell', () => {
    const p = preview(csv('﻿Date,,Amount\n10/01/2026,Netflix,-15.99\n'))
    assert.deepEqual(p.headers, ['Date', 'Column 2', 'Amount'])
    assert.equal(p.guess.description, 1)
  })

  test('a card export that lists charges as positive gets its sign flipped', () => {
    assert.equal(preview(csv(CARD)).guess.invertSign, true)
    assert.equal(preview(csv(BANK)).guess.invertSign, false)
  })

  test('an empty file', () => {
    assert.throws(() => preview(csv('')), /empty/)
  })
})

describe('import', () => {
  test('a bank statement into a new account named after the file', () => {
    const r = run(csv(BANK, 'Chase Checking.csv'))
    assert.deepEqual([r.imported, r.skipped, r.invalid], [5, 0, 0])
    const a = db.listAccounts().find((x) => x.id === r.accountId)!
    assert.equal(a.name, 'Chase Checking')
    assert.equal(a.source, 'csv')
    assert.equal(a.institution, 'Imported CSV')
    assert.deepEqual(rows(r.accountId), BANK_ROWS)
  })

  test('Free takes any number of accounts: a new one goes in with four already fed', () => {
    assert.equal(planState().plan, 'free')
    for (const n of ['One', 'Two', 'Three', 'Four']) account(n)
    const before = db.listAccounts().length
    const r = run(csv(BANK))
    assert.equal(r.imported, 5)
    assert.equal(db.listAccounts().length, before + 1)
  })

  test('a name for the new account', () => {
    const p = preview(csv(BANK))
    const r = importCsv({ token: p.token, mapping: p.guess, newAccountName: 'Everyday' })
    assert.equal(db.listAccounts().find((x) => x.id === r.accountId)!.name, 'Everyday')
  })

  test('a card statement: charges go in negative, the payment positive', () => {
    const id = account('Visa')
    const r = run(csv(CARD), id)
    assert.deepEqual([r.imported, r.skipped, r.invalid], [5, 0, 0])
    assert.deepEqual(rows(id), [
      [noon(2026, 10, 2), -5412, 'Trader Joes'],
      [noon(2026, 10, 3), -4000, 'Shell'],
      [noon(2026, 10, 4), -2399, 'Amazon'],
      [noon(2026, 10, 5), -1199, 'Spotify'],
      [noon(2026, 10, 6), 50000, 'PAYMENT THANK YOU']
    ])
  })

  test('debit and credit columns', () => {
    const id = account('Credit Union')
    run(csv('Posted Date,Details,Debit,Credit\n10/01/2026,Paycheck,,2500.00\n10/02/2026,Grocery,82.10,\n'), id)
    assert.deepEqual(rows(id), [
      [noon(2026, 10, 1), 250000, 'Paycheck'],
      [noon(2026, 10, 2), -8210, 'Grocery']
    ])
  })

  test('the same file again adds nothing', () => {
    const id = account('Dup')
    const file = csv(BANK)
    assert.deepEqual([run(file, id).imported, run(file, id).skipped], [5, 5])
    const again = run(file, id)
    assert.deepEqual([again.imported, again.skipped, again.invalid], [0, 5, 0])
    assert.deepEqual(rows(id), BANK_ROWS)
  })

  test('an overlapping file adds only its new rows', () => {
    const id = account('Overlap')
    run(csv(BANK), id)
    const r = run(csv('Date,Description,Amount\n10/03/2026,Blue Bottle,-4.50\n10/05/2026,Netflix,-15.99\n10/07/2026,Rent,"-1,850.00"\n10/09/2026,Spotify,-11.99\n10/10/2026,Shell,-40.00\n'), id)
    assert.deepEqual([r.imported, r.skipped], [2, 3])
    assert.equal(rows(id).length, 7)
    // the second coffee of October 3 is still there, once
    assert.equal(rows(id).filter((x) => x[2] === 'Blue Bottle').length, 2)
  })

  test('rows without a date, a description or an amount are invalid', () => {
    const id = account('Messy')
    const r = run(csv('Date,Description,Amount\nnot a date,Netflix,-15.99\n10/05/2026,,-15.99\n10/05/2026,Netflix,abc\n10/06/2026,Netflix,-15.99\n'), id)
    assert.deepEqual([r.imported, r.skipped, r.invalid], [1, 0, 3])
    assert.deepEqual(rows(id), [[noon(2026, 10, 6), -1599, 'Netflix']])
  })

  test('a mapping must point at columns in the file', () => {
    const id = account('Bad Mapping')
    assert.throws(() => run(csv(BANK), id, { amount: 7 }), /out of range/)
    assert.throws(() => run(csv(BANK), id, { amount: null, debit: null, credit: null }), /amount column/)
  })

  test('a preview is good for one import', () => {
    const id = account('Once')
    const p = preview(csv(BANK))
    importCsv({ token: p.token, mapping: p.guess, accountId: id })
    assert.throws(() => importCsv({ token: p.token, mapping: p.guess, accountId: id }), /expired/)
  })
})
