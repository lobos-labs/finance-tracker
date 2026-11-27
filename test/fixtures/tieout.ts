import * as db from '../../src/main/db.ts'
import { savePaystub } from '../../src/main/paystubs.ts'
import { runTool } from '../../src/main/tools.ts'
import { daysInMonth, shiftMonth } from '../../src/shared/zone.ts'
import { noonOn } from '../days.ts'

// The waterfall spec's section 2 tie-out (sub-phase 1g and after): October 2026, with November open. Amounts are
// cents. May to September 2026 come before it, the same each month and with no gap, so October's run rates have
// whole windows and its investments their returns.
//   Pay: Finch Payroll pays semimonthly (24 checks a year) on the 3rd and the 17th. Each check is gross 2,800.00;
//   taxes 450.00 (federal 235.80, Social Security 173.60, Medicare 40.60), medical 100.00 and 401(k) 250.00 (match
//   125.00); net and deposit 2,000.00. The 401(k) takes both on the pay day.
//   Each month, on Checking: rent of 1,500.00 on the 1st (a series), the car loan's 400.00 on the 10th (45.00 of
//   interest and 355.00 of principal by its month-end balances), the Visa's payment on the 25th, 500.00 to Savings
//   on the 26th and 300.00 to the Brokerage on the 27th. On the Visa: groceries of 600.00, dining out of 200.00 and
//   30.00 of interest, paid off to 1,200.00 owed. Savings earns 20.00 on the month's last day. Nothing else earns.
//   October: the Visa's payment is 900.00, a 450.00 flight goes on it, the 500.00 to Savings leaves on Oct 31 and
//   lands Nov 1, and a 250.00 rental repair on Oct 20 is placed in the Wren Rentals venture. The venture's own
//   accounts, Wren Checking and Wren Card, start October at 4,000.00 and nothing: Wren Checking gets 1,800.00 of
//   rent and pays 300.00 of costs, and Wren Card pays 80.00 of groceries, placed in Personal, and 120.00 of supplies.
//   Checking's statement on Oct 31 is 3,110.00, 40.00 below what its lines give: a gap of -40.00. The brokerage
//   gains 500.00 and the 401(k) 600.00, and the car's value falls 200.00.

export const TODAY = '2026-11-07'
export const PAYROLL = 'Finch Payroll'
export const KEY = 'finch payroll|+'
/** The months before October, May to September 2026, then October. */
export const MONTHS = Array.from({ length: 6 }, (_, i) => shiftMonth('2026-05', i))

export const ACCOUNTS = {
  checking: 'csv:chk',
  savings: 'csv:sav',
  visa: 'csv:visa',
  brokerage: 'csv:brk',
  retirement: 'csv:401k',
  wrenChecking: 'csv:wren-chk',
  wrenCard: 'csv:wren-card'
} as const

export interface TieOut {
  venture: number
  car: string
  carLoan: string
  /** October's 250.00 repair on Checking, placed in the venture */
  repair: string
  /** October's 80.00 of groceries on Wren Card, placed in Personal */
  groceries: string
  /** the 500.00 that leaves Checking on Oct 31 and lands in Savings on Nov 1 */
  toSavings: [string, string]
}

const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

let n = 0

/** A settled line on an account on a day (YYYY-MM-DD), with a category and a payee when given. */
export function line(account: string, day: string, cents: number, description: string, category?: string, merchant?: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `to${++n}`
  db.upsertTransaction({ id, accountId: account, posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  const categoryId = category ? db.listCategories().find((c) => c.name === category)!.id : undefined
  if (categoryId !== undefined || merchant) db.setTransactionFields(id, { ...(categoryId !== undefined ? { categoryId, source: 'user' as const } : {}), ...(merchant ? { merchant } : {}) })
  return id
}

/** Each account's month-end balance, from Apr 30 to Oct 31, 2026 (debts as amounts owed, positive here). */
const ENDS: Record<string, number[]> = {
  [ACCOUNTS.checking]: [65_000, 112_000, 159_000, 206_000, 253_000, 300_000, 311_000],
  [ACCOUNTS.savings]: [740_000, 792_000, 844_000, 896_000, 948_000, 1_000_000, 1_002_000],
  [ACCOUNTS.visa]: [-120_000, -120_000, -120_000, -120_000, -120_000, -120_000, -158_000],
  [ACCOUNTS.brokerage]: [4_850_000, 4_880_000, 4_910_000, 4_940_000, 4_970_000, 5_000_000, 5_080_000],
  [ACCOUNTS.retirement]: [7_625_000, 7_700_000, 7_775_000, 7_850_000, 7_925_000, 8_000_000, 8_135_000],
  [ACCOUNTS.wrenChecking]: [400_000, 400_000, 400_000, 400_000, 400_000, 400_000, 550_000],
  [ACCOUNTS.wrenCard]: [0, 0, 0, 0, 0, 0, -20_000]
}
const LOAN_OWED = [1_077_500, 1_042_000, 1_006_500, 971_000, 935_500, 900_000, 864_500]

/**
 * The tie-out on a new ledger. With `fed`, Checking, Savings and the Visa are fed by a bank (SimpleFIN), as a month's
 * close waits for them (sub-phase 1h); with `visaReported` (YYYY-MM-DD), the Visa's feed last reported that day, at the
 * balance it has then, and it has no balance after. With `file`, the ledger is that file rather than one in memory.
 */
export function tieOut(o: { fed?: boolean; visaReported?: string; file?: string } = {}): TieOut {
  db.openDb(o.file ?? ':memory:')
  const now = noonOn(2026, 11, 7)
  const fed = new Set<string>(o.fed ? [ACCOUNTS.checking, ACCOUNTS.savings, ACCOUNTS.visa] : [])
  const reported = (id: string): number => {
    if (id !== ACCOUNTS.visa || !o.visaReported) return now
    const [y, m, d] = o.visaReported.split('-').map(Number)
    return noonOn(y, m, d)
  }
  const csv = (id: string, name: string, assetType: 'cash' | 'credit_card' | 'investment' | 'retirement', balanceCents: number): void => {
    db.upsertAccount({ id, source: fed.has(id) ? 'simplefin' : 'csv', name, institution: null, currency: 'USD', balanceCents, availableCents: null, balanceDate: reported(id) })
    db.updateAccount(id, { assetType })
  }
  csv(ACCOUNTS.checking, 'Checking', 'cash', 311_000)
  csv(ACCOUNTS.savings, 'Savings', 'cash', 1_052_000)
  csv(ACCOUNTS.visa, 'Visa', 'credit_card', -158_000)
  db.updateAccount(ACCOUNTS.visa, { apr: 24 })
  csv(ACCOUNTS.brokerage, 'Brokerage', 'investment', 5_080_000)
  csv(ACCOUNTS.retirement, 'Finch 401(k)', 'retirement', 8_135_000)
  csv(ACCOUNTS.wrenChecking, 'Wren Checking', 'cash', 550_000)
  csv(ACCOUNTS.wrenCard, 'Wren Card', 'credit_card', -20_000)
  const venture = db.saveBucket({ name: 'Wren Rentals', kind: 'rental' })
  db.updateAccount(ACCOUNTS.wrenChecking, { bucketId: venture })
  db.updateAccount(ACCOUNTS.wrenCard, { bucketId: venture })
  const car = db.addManualAccount({ name: 'Car', assetType: 'vehicle', openedDay: '2023-06-01', costCents: 2_400_000, points: [{ day: '2023-06-01', cents: 2_400_000 }, { day: '2026-04-30', cents: 1_800_000 }, { day: '2026-09-30', cents: 1_800_000 }, { day: '2026-10-31', cents: 1_780_000 }] })
  const carLoan = db.addManualAccount({ name: 'Lark Auto Finance', assetType: 'loan', openedDay: '2023-06-01', linkedAssetId: car, points: ['2026-04', ...MONTHS].map((m, i) => ({ day: lastDay(m), cents: -LOAN_OWED[i] })) })

  const ids = { carLoan: '', repair: '', groceries: '', toSavings: ['', ''] as [string, string] }
  db.inTransaction(() => {
    for (const m of MONTHS) {
      const on = (d: number): string => `${m}-${String(d).padStart(2, '0')}`
      const october = m === '2026-10'
      line(ACCOUNTS.checking, on(1), -150_000, 'HERON PROPERTY RENT', 'Housing', 'Heron Property')
      for (const day of [on(3), on(17)]) {
        line(ACCOUNTS.checking, day, 200_000, 'FINCH PAYROLL DIR DEP', 'Paycheck', PAYROLL)
        line(ACCOUNTS.retirement, day, 25_000, 'EMPLOYEE CONTRIBUTION')
        line(ACCOUNTS.retirement, day, 12_500, 'EMPLOYER MATCH')
      }
      const loan = line(ACCOUNTS.checking, on(10), -40_000, 'LARK AUTO FINANCE PMT', 'Transfers', 'Lark Auto Finance')
      if (m === MONTHS[0]) ids.carLoan = loan
      line(ACCOUNTS.visa, on(6), -60_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
      line(ACCOUNTS.visa, on(14), -20_000, 'CORNER BISTRO', 'Dining Out', 'Corner Bistro')
      if (october) line(ACCOUNTS.visa, on(12), -45_000, 'SKYLINE AIR', 'Travel', 'Skyline Air')
      line(ACCOUNTS.visa, on(28), -3_000, 'INTEREST CHARGE', 'Fees & Interest', 'Visa Interest')
      const payment = october ? 90_000 : 83_000
      line(ACCOUNTS.checking, on(25), -payment, 'PAYMENT TO VISA', 'Transfers', 'Visa Payment')
      line(ACCOUNTS.visa, on(25), payment, 'PAYMENT THANK YOU', 'Transfers', 'Visa Payment')
      if (october) {
        ids.toSavings = [line(ACCOUNTS.checking, '2026-10-31', -50_000, 'TRANSFER TO SAVINGS', 'Transfers', 'Transfer to Savings'), line(ACCOUNTS.savings, '2026-11-01', 50_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Transfer from Checking')]
      } else {
        line(ACCOUNTS.checking, on(26), -50_000, 'TRANSFER TO SAVINGS', 'Transfers', 'Transfer to Savings')
        line(ACCOUNTS.savings, on(26), 50_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Transfer from Checking')
      }
      line(ACCOUNTS.checking, on(27), -30_000, 'TRANSFER TO BROKERAGE', 'Transfers', 'Transfer to Brokerage')
      line(ACCOUNTS.brokerage, on(27), 30_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Transfer from Checking')
      line(ACCOUNTS.savings, lastDay(m), 2_000, 'INTEREST PAID', 'Other Income', 'Savings Interest')
    }
    ids.repair = line(ACCOUNTS.checking, '2026-10-20', -25_000, 'QUICKFIX PLUMBING', 'Housing', 'Quickfix Plumbing')
    line(ACCOUNTS.wrenChecking, '2026-10-05', 180_000, 'TENANT RENT', 'Other Income', 'Wren Tenant')
    line(ACCOUNTS.wrenChecking, '2026-10-15', -30_000, 'WREN UPKEEP', 'Housing', 'Wren Upkeep')
    ids.groceries = line(ACCOUNTS.wrenCard, '2026-10-09', -8_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    line(ACCOUNTS.wrenCard, '2026-10-15', -12_000, 'HARDWARE DEPOT', 'Shopping', 'Hardware Depot')
  })
  db.setTransactionsBucket([ids.repair], venture)
  db.setTransactionsBucket([ids.groceries], null)
  runTool('link_loan_payment', { account_id: carLoan, transaction_id: ids.carLoan }, 'assistant')

  for (const [account, ends] of Object.entries(ENDS)) {
    ['2026-04', ...MONTHS].forEach((m, i) => {
      if (account === ACCOUNTS.visa && o.visaReported && lastDay(m) > o.visaReported) return
      db.setBalancePoint(account, lastDay(m), ends[i])
    })
  }

  db.saveContribution({ name: 'Finch 401(k)', kind: '401k', accountId: ACCOUNTS.retirement, paycheckKey: KEY, employeeCents: 25_000, matchCents: 12_500 })
  for (const m of MONTHS) for (const day of [`${m}-03`, `${m}-17`]) stub(day)
  return { venture, car, carLoan, repair: ids.repair, groceries: ids.groceries, toSavings: ids.toSavings }
}

/** A check's paystub, as section 2 has it. */
export function stub(day: string): number {
  return savePaystub({
    paycheckKey: KEY,
    payDay: day,
    grossCents: 280_000,
    items: [
      { kind: 'federal', cents: 23_580 },
      { kind: 'social_security', cents: 17_360 },
      { kind: 'medicare', cents: 4_060 },
      { kind: 'medical', name: 'Medical', cents: 10_000 },
      { kind: '401k', name: 'Finch 401(k)', cents: 25_000, employerCents: 12_500 }
    ]
  })
}
