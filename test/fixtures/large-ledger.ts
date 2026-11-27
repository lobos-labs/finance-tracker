import * as db from '../../src/main/db.ts'
import { shiftMonth } from '../../src/shared/zone.ts'
import { noonOn } from '../days.ts'

// A large household for timing the totals that read the classifier (waterfall spec sub-phase 2g): five years of a
// working household's shape, about 16,000 transactions, from November 2021 through October 2026. Pay every two weeks, a
// mortgage paid as Housing with a balance each month, bills and subscriptions, card payments and money moved to
// savings as transfers with both legs, interest on savings, eight purchases a day from 300 payees across the
// everyday categories (one in fifty uncategorized), a trip every quarter, and a rental venture with its own
// checking account. With `invested` (sub-phase 2c), four invested accounts beside them, each with its statement at
// every month's end: a brokerage that checking pays 400.00 into each month, a 401(k) and an HSA that every paycheck
// pays into (the employee's and the employer's money as lines of their own), and a Roth IRA paid 6,500.00 each
// January. Each earns between -0.3% and 0.5% a month.

export interface LargeLedger {
  /** the first and last months with lines (YYYY-MM) */
  first: string
  last: string
  transactions: number
}

const EVERYDAY = ['Groceries', 'Dining Out', 'Coffee', 'Gas & Fuel', 'Personal Care', 'Entertainment', 'Health & Medical', 'Shopping']

/** The invested accounts `invested` adds, with what each starts with. */
const INVESTED: Array<{ id: string; name: string; assetType: 'investment' | 'retirement'; startCents: number }> = [
  { id: 'csv:brk', name: 'Brokerage', assetType: 'investment', startCents: 2_500_000 },
  { id: 'csv:401k', name: 'Northwind 401(k)', assetType: 'retirement', startCents: 6_000_000 },
  { id: 'csv:hsa', name: 'Northwind HSA', assetType: 'investment', startCents: 800_000 },
  { id: 'csv:roth', name: 'Roth IRA', assetType: 'retirement', startCents: 1_500_000 }
]

/** Builds the household on the open database (after migrations), from November 2021, or from `from` (YYYY-MM): from 2018-12 it is 95 months, a long ledger. */
export function largeLedger(o: { from?: string; invested?: boolean } = {}): LargeLedger {
  const from = o.from ?? '2021-11'
  const account = (id: string, name: string, assetType: 'cash' | 'credit_card' | 'investment' | 'retirement'): void => {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(id, { assetType })
  }
  account('csv:chk', 'Checking', 'cash')
  account('csv:sav', 'Savings', 'cash')
  account('csv:visa', 'Visa', 'credit_card')
  account('csv:mc', 'Mastercard', 'credit_card')
  account('csv:rent', 'Rental Checking', 'cash')
  const house = db.addManualAccount({ name: 'Home', assetType: 'property', openedDay: '2019-06-01', costCents: 42_000_000, points: [{ day: '2019-06-01', cents: 42_000_000 }] })
  const months: string[] = []
  for (let m = from; m <= '2026-10'; m = shiftMonth(m, 1)) months.push(m)
  // What the mortgage owes at each month's end: 600.00 less each month.
  const mortgage = db.addManualAccount({
    name: 'Home Mortgage',
    assetType: 'mortgage',
    openedDay: '2019-06-01',
    linkedAssetId: house,
    points: months.map((m, i) => ({ day: `${m}-28`, cents: -(30_000_000 - 60_000 * i) }))
  })
  db.setPaymentKey(mortgage, 'lakeshore lending|-')

  const cat = new Map(db.listCategories().map((c) => [c.name, c.id]))
  const insert = 'INSERT INTO transactions (id, account_id, posted, amount_cents, description, desc_key, merchant, category_id, category_source, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)'
  let n = 0
  const line = (accountId: string, posted: number, cents: number, description: string, merchant: string | null, category: string | null): void => {
    db.run(insert, `L${n++}`, accountId, posted, cents, description, description.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(), merchant, category === null ? null : cat.get(category)!, category === null ? null : 'user')
  }
  db.inTransaction(() => {
    const start = noonOn(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 1)
    const days = Math.round((noonOn(2026, 10, 31) - start) / 86_400) + 1
    for (let d = 0; d < days; d++) {
      const t = start + d * 86_400
      if (d % 14 === 4) line('csv:chk', t, 412_500, 'NORTHWIND PAYROLL', 'Northwind Payroll', 'Paycheck')
      for (let k = 0; k < 8; k++) {
        const i = d * 8 + k
        const payee = (i * 37) % 300
        line(i % 3 === 0 ? 'csv:chk' : i % 3 === 1 ? 'csv:visa' : 'csv:mc', t + k * 60, -(300 + ((i * 7919) % 3000)), `PAYEE ${payee} STORE`, `Payee ${payee}`, i % 50 === 7 ? null : EVERYDAY[payee % EVERYDAY.length])
      }
    }
    months.forEach((m, i) => {
      const [y, mo] = m.split('-').map(Number)
      const on = (day: number): number => noonOn(y, mo, day)
      line('csv:chk', on(1), -245_000, 'LAKESHORE LENDING', 'Lakeshore Lending', 'Housing')
      line('csv:chk', on(3), -(9_000 + ((i * 3_701) % 6_000)), 'CITY POWER', 'City Power', 'Utilities')
      line('csv:visa', on(5), -7_999, 'FIBERLINE INTERNET', 'Fiberline', 'Utilities')
      line('csv:visa', on(7), -1_599, 'STREAMFLIX', 'Streamflix', 'Subscriptions')
      line('csv:mc', on(7), -1_099, 'TUNEBOX', 'Tunebox', 'Subscriptions')
      line('csv:chk', on(10), -14_200, 'SAFEHARBOR INSURANCE', 'Safeharbor Insurance', 'Insurance')
      line('csv:chk', on(15), -150_000, 'VISA PAYMENT', null, 'Transfers')
      line('csv:visa', on(15), 150_000, 'PAYMENT THANK YOU', null, 'Transfers')
      line('csv:chk', on(16), -60_000, 'MASTERCARD PAYMENT', null, 'Transfers')
      line('csv:mc', on(16), 60_000, 'PAYMENT RECEIVED', null, 'Transfers')
      line('csv:chk', on(20), -50_000, 'TRANSFER TO SAVINGS', null, 'Transfers')
      line('csv:sav', on(20), 50_000, 'TRANSFER FROM CHECKING', null, 'Transfers')
      line('csv:sav', on(28), 1_500 + i * 20, 'INTEREST PAID', null, 'Other Income')
      line('csv:rent', on(2), 180_000, 'TENANT RENT', 'Tenant', 'Other Income')
      line('csv:rent', on(12), -40_000, 'BIRCH HOA', 'Birch HOA', 'Housing')
      if (i % 3 === 1) line('csv:visa', on(22), -120_000, 'SKYWAY AIR', 'Skyway Air', 'Travel')
    })
  })
  // The rental's account goes in its venture, which puts its lines there.
  db.updateAccount('csv:rent', { bucketId: db.saveBucket({ name: 'Birch Rental', kind: 'rental' }) })
  if (o.invested) investedAccounts(from, months, line)
  return { first: months[0], last: months[months.length - 1], transactions: n }
}

/** The invested accounts, their lines and a statement at each month's end: each balance is the month before's grown by the month's return, with the month's money in added. */
function investedAccounts(from: string, months: string[], line: (accountId: string, posted: number, cents: number, description: string, merchant: string | null, category: string | null) => void): void {
  for (const a of INVESTED) {
    db.upsertAccount({ id: a.id, source: 'csv', name: a.name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(a.id, { assetType: a.assetType })
  }
  // Money in by account and month.
  const flows = new Map<string, number>()
  const into = (id: string, posted: number, cents: number, description: string): void => {
    line(id, posted, cents, description, null, null)
    const m = db.dayKey(posted).slice(0, 7)
    flows.set(`${id}|${m}`, (flows.get(`${id}|${m}`) ?? 0) + cents)
  }
  db.inTransaction(() => {
    const start = noonOn(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 1)
    const days = Math.round((noonOn(2026, 10, 31) - start) / 86_400) + 1
    // Each paycheck's saving, on its pay day.
    for (let d = 4; d < days; d += 14) {
      const t = start + d * 86_400
      into('csv:401k', t, 24_750, 'EMPLOYEE CONTRIBUTION')
      into('csv:401k', t, 12_375, 'EMPLOYER MATCH')
      into('csv:hsa', t, 6_000, 'EMPLOYEE CONTRIBUTION')
      into('csv:hsa', t, 2_000, 'EMPLOYER CONTRIBUTION')
    }
    months.forEach((m) => {
      const [y, mo] = m.split('-').map(Number)
      line('csv:chk', noonOn(y, mo, 21), -40_000, 'TRANSFER TO BROKERAGE', null, 'Transfers')
      into('csv:brk', noonOn(y, mo, 21), 40_000, 'TRANSFER FROM CHECKING')
      if (mo === 1) {
        line('csv:chk', noonOn(y, mo, 15), -650_000, 'TRANSFER TO ROTH IRA', null, 'Transfers')
        into('csv:roth', noonOn(y, mo, 15), 650_000, 'ROTH CONTRIBUTION')
      }
    })
  })
  const monthEnd = (m: string): string => `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`
  INVESTED.forEach((a, k) => {
    let balance = a.startCents
    db.setBalancePoint(a.id, monthEnd(shiftMonth(from, -1)), balance)
    months.forEach((m, i) => {
      // Between -0.3% and 0.5% a month, a different month for each account.
      balance = Math.round((balance * (1000 + ((i * 37 + k * 11) % 9) - 3)) / 1000) + (flows.get(`${a.id}|${m}`) ?? 0)
      db.setBalancePoint(a.id, monthEnd(m), balance)
    })
  })
}
