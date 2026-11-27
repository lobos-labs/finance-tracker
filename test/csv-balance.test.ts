import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { closingBalance, importCsv, preview } from '../src/main/csvImport.ts'
import { buildDigest } from '../src/main/insights.ts'
import { addDays } from '../src/shared/zone.ts'
import type { CsvMapping } from '../src/shared/types.ts'

// A CSV's balance column (csvImport.ts closingBalance): the latest day's closing balance becomes the account's
// balance and a balance point, as a statement file's closing balance does, whichever order the file lists its rows
// in and whichever sign it gives a card's balance. A CSV without one leaves the account with no balance, and the
// headline then makes no net worth claim it can't back (insights.ts buildDigest), until a balance is set.

const dir = mkdtempSync(join(tmpdir(), 'ft-csv-balance-'))
before(() => db.openDb(join(dir, 'test.db')))
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

let files = 0
const csv = (text: string): string => {
  const p = join(dir, `export-${files++}.csv`)
  writeFileSync(p, text)
  return p
}
const run = (text: string, mapping?: Partial<CsvMapping>, newAccountName?: string): ReturnType<typeof importCsv> => {
  const p = preview(csv(text))
  return importCsv({ token: p.token, mapping: { ...p.guess, ...mapping }, newAccountName })
}
const account = (id: string): { balanceCents: number | null; day: string | null } => {
  const a = db.listAccounts().find((x) => x.id === id)!
  return { balanceCents: a.balanceCents, day: a.balanceDate === null ? null : db.dayKey(a.balanceDate) }
}

const OLDEST_FIRST = `Date,Description,Amount,Balance
10/01/2026,ACME PAYROLL,2100.00,4600.00
10/01/2026,TRADER JOES,-12.00,4588.00
10/03/2026,RENT,-1450.00,3138.00
10/04/2026,CITY GROCERY,-33.00,3105.00
10/04/2026,CORNER CAFE,-4.50,3100.50
`
// The same days newest first, as many banks export them.
const NEWEST_FIRST = `Posted Date,Description,Amount,Running Balance
10/04/2026,CORNER CAFE,-4.50,3100.50
10/04/2026,CITY GROCERY,-33.00,3105.00
10/03/2026,RENT,-1450.00,3138.00
10/01/2026,TRADER JOES,-12.00,4588.00
10/01/2026,ACME PAYROLL,2100.00,4600.00
`
// A card export: charges positive, the payment negative, the balance owed positive.
const CARD = `Transaction Date,Description,Amount,Balance
10/02/2026,Trader Joes,54.12,354.12
10/03/2026,Shell,40.00,394.12
10/05/2026,PAYMENT THANK YOU,-300.00,94.12
10/06/2026,Spotify,11.99,106.11
`

describe('the balance column', () => {
  test('is guessed from its header, and is none when the file has no such column', () => {
    assert.equal(preview(csv(OLDEST_FIRST)).guess.balance, 3)
    assert.equal(preview(csv(NEWEST_FIRST)).guess.balance, 3)
    assert.equal(preview(csv('Date,Description,Amount\n10/01/2026,Netflix,-15.99\n')).guess.balance, null)
  })

  test('oldest first: the last row of the latest day is the balance, on that day', () => {
    const r = run(OLDEST_FIRST, {}, 'Oldest first')
    assert.equal(r.balances, 1)
    assert.deepEqual(account(r.accountId), { balanceCents: 310050, day: '2026-10-04' })
    assert.equal(db.getBalancePoint(r.accountId, '2026-10-04')?.cents, 310050)
  })

  test('newest first: the first row of the latest day', () => {
    const r = run(NEWEST_FIRST, {}, 'Newest first')
    assert.deepEqual(account(r.accountId), { balanceCents: 310050, day: '2026-10-04' })
  })

  test('a card export with its balance owed positive goes in as owed', () => {
    const r = run(CARD, {}, 'Card')
    assert.equal(preview(csv(CARD)).guess.invertSign, true)
    assert.deepEqual(account(r.accountId), { balanceCents: -10611, day: '2026-10-06' })
  })

  test('rows that add up decide the order and the sign over the dates and the amounts', () => {
    const m: CsvMapping = { date: 0, description: 1, amount: 2, debit: null, credit: null, invertSign: false, balance: 3 }
    const rows = (text: string): string[][] => text.trim().split('\n').slice(1).map((l) => l.split(','))
    // One day only, listed newest first: the dates can't tell, the running balance can.
    assert.deepEqual(closingBalance(rows('Date,Description,Amount,Balance\n10/04/2026,CAFE,-4.50,95.50\n10/04/2026,GROCERY,-20.00,100.00\n10/04/2026,REFUND,20.00,120.00'), m), { day: '2026-10-04', cents: 9550 })
    // A card listing charges negative and its balance owed positive.
    assert.deepEqual(closingBalance(rows('Date,Description,Amount,Balance\n10/01/2026,SHELL,-40.00,40.00\n10/02/2026,CAFE,-5.00,45.00'), m), { day: '2026-10-02', cents: -4500 })
    // No balance column, or none filled: nothing.
    assert.equal(closingBalance(rows('Date,Description,Amount,Balance\n10/01/2026,SHELL,-40.00,'), m), null)
    assert.equal(closingBalance(rows('Date,Description,Amount\n10/01/2026,SHELL,-40.00'), { ...m, balance: null }), null)
  })

  test('none chosen: no balance', () => {
    const r = run(OLDEST_FIRST, { balance: null }, 'No column')
    assert.equal(r.balances, 0)
    assert.equal(account(r.accountId).balanceCents, null)
  })

  test('a mapping must point at a column in the file', () => {
    const p = preview(csv(OLDEST_FIRST))
    assert.throws(() => importCsv({ token: p.token, mapping: { ...p.guess, balance: 9 }, newAccountName: 'Out of range' }), /out of range/)
  })
})

describe('the headline with an account that has no balance', () => {
  test('no net worth, or change, until every account has one', () => {
    // Fresh days, so the 30-day change has something to say.
    const today = db.today()
    const day = (n: number): string => {
      const d = addDays(today, -n)
      return `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`
    }
    for (const a of db.listAccounts()) db.updateAccount(a.id, { hidden: true })
    // Pay in, a bill out, pay in, a bill out: 2,100, 2,000, 4,100 and 4,000 after each.
    const text = ['Date,Description,Amount,Balance', `${day(40)},PAYROLL,2100.00,2100.00`, `${day(25)},POWER CO,-100.00,2000.00`, `${day(10)},PAYROLL,2100.00,4100.00`, `${day(2)},POWER CO,-100.00,4000.00`].join('\n')
    const without = run(text, { balance: null }, 'CSV only')
    const d = buildDigest()
    assert.ok(d)
    assert.equal(d.netWorth, null)
    // The same file with its balance column: net worth is the balance, and its change is backed.
    db.deleteAccount(without.accountId)
    const withBalance = run(text, {}, 'CSV with balance')
    assert.equal(account(withBalance.accountId).balanceCents, 400000)
    const after = buildDigest()
    assert.equal(after?.netWorth?.current, 4000)
    assert.equal(after?.netWorth?.change30d, 1900)
  })
})
