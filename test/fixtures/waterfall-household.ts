import * as db from '../../src/main/db.ts'
import { addContribution, saveGoal } from '../../src/main/goals.ts'
import { restorePolicy } from '../../src/main/insurance.ts'
import { savePaystub } from '../../src/main/paystubs.ts'
import { blankPolicy } from '../../src/main/policies.ts'
import { setTaxYear } from '../../src/main/taxes.ts'
import { runTool } from '../../src/main/tools.ts'
import { daysInMonth, shiftMonth } from '../../src/shared/zone.ts'
import { noonOn } from '../days.ts'

// The waterfall spec's section 5 household (sub-phase 1e and after): October 2026 is its latest closed month and
// November is open. It holds the 24 months from November 2024, so every run rate the spec reads, October's, July's
// three months before and October 2025's twelve months before, has whole windows. Amounts are cents.
//   Pay: Brightline Payroll pays semimonthly (24 checks a year), on the 15th and the month's last day. Each check is
//   gross 3,000.00; federal 348.00, Social Security 186.00, Medicare 43.50, state 138.00; medical 96.00 (the
//   employer's share 205.00); 401(k) 240.00 (match 120.00) and HSA 60.00 (employer 24.00); net and deposit 1,888.50.
//   The same every month, so pay, Saved at work and employer saving are the same at both ends of any window.
//   Committed: Pinecrest 1,985.00 on the 1st, 805.00 principal and 1,180.00 interest and escrow (380.00 escrow) by its
//   month-end balances; HOA 232.00; Civic 412.00 (364.00 principal, 48.00 interest) and the student loan 300.00
//   (214.00 principal, 86.00 interest), both filed as transfers; home insurance 142.00 and auto 68.00; four
//   subscriptions of 82.51 and Netflix at 15.49, 17.99 from October 2026; one utility that varies (284.00 in October
//   2025, 318.00 in October 2026), whose latest six give 270.00 in October 2025 and 290.00 in July and October 2026;
//   Visa interest each month, with Visa owing 1,400.00 at the end of each month to July 2026, then 2,000.00, 2,850.00
//   and 3,000.00.
//   Everyday on the Visa: dining out, groceries, coffee and gas at 408.00, 312.00, 132.00 and 98.00 a month, then
//   413.60, 296.00, 108.00 and 84.00 in August 2026, 500.00, 310.00, 137.00 and 105.00 in September and 520.40,
//   330.00, 151.00 and 105.00 in October. So the run rates are 950.00 in July and 1,020.00 in October, August's
//   Everyday is 901.60 and September's 1,052.00.
//   One-offs on the Visa, each from a payee seen once: 250.00 a month, but 200.00 from August to October 2025, 220.00
//   in July 2026, 40.00 in August, 100.00 in September (a 48.00 meal filed as Travel among it) and 640.00 in October:
//   the 12-month averages are 235.00 in July and 250.00 in October.
//   Saving: 243.00 a month to savings, which earns 57.00 of interest each month (Moved to savings 300.00); 250.00 a
//   month to the brokerage, but none in August 2026 and 500.00 in October. The brokerage earns 1,000.00 a month to
//   October 2025, then 1,058.00, 1,053.00 in September 2026 and 2,083.00 in October; the 401(k) and the HSA take the
//   checks' saving and earn nothing. 240,000.00 is invested on October 1, 2026, and Growth averages 1,200.00.
//   October 2026 also has two uncategorized lines of 10.00 and 6.00, a client's 220.00 for the Side Studio venture
//   paid into checking, 509.00 of the venture's costs on its own account, and the Civic's value down 130.00. Net
//   worth on October 31 is 412,300.00. The last return filed (2025) had a refund of 1,020.00. Two goals are set
//   aside by hand: Emergency, 18,400.00 of 25,000.00, and Norway 2027, 1,200.00 of 4,000.00.
// paystubs: false is the same household with no paystub and no elections, Gross pay then its deposits alone.
// unsorted86 adds a third uncategorized line of 70.00 in October, for 86.00 in all.

export const TODAY = '2026-11-07'
export const PAYROLL = 'Brightline Payroll'
export const KEY = 'brightline payroll|+'

export const ACCOUNTS = {
  checking: 'csv:chk',
  savings: 'csv:sav',
  visa: 'csv:visa',
  brokerage: 'csv:brk',
  retirement: 'csv:401k',
  hsa: 'csv:hsa',
  studio: 'csv:studio'
} as const

export interface Household {
  house: string
  mortgage: string
  civic: string
  civicLoan: string
  studentLoan: string
  venture: number
  /** the 48.00 meal of September 2026, filed as Travel */
  meal: string
  /** October 2026's uncategorized lines */
  unsorted: string[]
}

/** The 24 months, November 2024 to October 2026. */
export const MONTHS = Array.from({ length: 24 }, (_, i) => shiftMonth('2024-11', i))
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

let n = 0

/** A settled line on an account on a day (YYYY-MM-DD), with a category and a payee when given. */
export function line(account: string, day: string, cents: number, description: string, category?: string, merchant?: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `wf${++n}`
  db.upsertTransaction({ id, accountId: account, posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  const categoryId = category ? db.listCategories().find((c) => c.name === category)!.id : undefined
  if (categoryId !== undefined || merchant) db.setTransactionFields(id, { ...(categoryId !== undefined ? { categoryId, source: 'user' as const } : {}), ...(merchant ? { merchant } : {}) })
  return id
}

/** Each month's figures, by its index in MONTHS (October 2026 is 23, July 2026 20, October 2025 11). */
const at = (i: number, values: Partial<Record<number, number>>, otherwise: number): number => values[i] ?? otherwise
const UTILITIES: Record<string, number> = {
  '2025-05': 26_200,
  '2025-06': 26_600,
  '2025-07': 27_000,
  '2025-08': 27_000,
  '2025-09': 28_000,
  '2025-10': 28_400,
  '2025-11': 28_200,
  '2025-12': 28_200,
  '2026-01': 28_200,
  '2026-05': 28_600,
  '2026-06': 28_800,
  '2026-09': 29_200,
  '2026-10': 31_800
}
/** What the Visa owes at each month's end. */
const visaOwed = (i: number): number => at(i, { 21: 200_000, 22: 285_000, 23: 300_000 }, 140_000)
const DINING = (i: number): [number, number] => (i === 21 ? [20_000, 21_360] : i === 22 ? [25_000, 25_000] : i === 23 ? [26_000, 26_040] : [20_000, 20_800])
const GROCERIES = (i: number): [number, number] => (i === 21 ? [15_000, 14_600] : i === 22 ? [15_000, 16_000] : i === 23 ? [16_500, 16_500] : [15_000, 16_200])
const COFFEE = (i: number): [number, number, number] => (i === 21 ? [3_600, 3_600, 3_600] : i === 22 ? [4_500, 4_600, 4_600] : i === 23 ? [5_000, 5_000, 5_100] : [4_400, 4_400, 4_400])
/** One-offs by month; September 2026's are a 48.00 meal and a 52.00 purchase, booked on their own. */
const ONE_OFFS = (i: number): number => at(i, { 9: 20_000, 10: 20_000, 11: 20_000, 20: 22_000, 21: 4_000, 23: 64_000 }, 25_000)
const RETURNS = (i: number): number => (i <= 11 ? 100_000 : i === 22 ? 105_300 : i === 23 ? 208_300 : 105_800)
const TO_BROKERAGE = (i: number): number => at(i, { 21: 0, 23: 50_000 }, 25_000)

/** The section 5 household on a new ledger. */
export function household(o: { paystubs?: boolean; unsorted86?: boolean } = {}): Household {
  const stubs = o.paystubs ?? true
  db.openDb(':memory:')
  const csv = (id: string, name: string, assetType: 'cash' | 'credit_card' | 'investment' | 'retirement'): void => {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(id, { assetType })
  }
  csv(ACCOUNTS.checking, 'Checking', 'cash')
  csv(ACCOUNTS.savings, 'Savings', 'cash')
  csv(ACCOUNTS.visa, 'Visa', 'credit_card')
  db.updateAccount(ACCOUNTS.visa, { apr: 24 })
  csv(ACCOUNTS.brokerage, 'Brokerage', 'investment')
  csv(ACCOUNTS.retirement, 'Brightline 401(k)', 'retirement')
  csv(ACCOUNTS.hsa, 'Brightline HSA', 'investment')
  csv(ACCOUNTS.studio, 'Studio Checking', 'cash')

  // The debts' month-end balances fall by each payment's principal: Sep 30, 2026 is 300,000.00, 9,000.00 and 24,000.00.
  const owedPoints = (sep2026: number, principal: number): Array<{ day: string; cents: number }> => ['2024-10', ...MONTHS].map((m, k) => ({ day: lastDay(m), cents: -(sep2026 + principal * (23 - k)) }))
  const house = db.addManualAccount({ name: 'Alder Lane house', assetType: 'property', openedDay: '2022-03-01', costCents: 38_000_000, points: [{ day: '2022-03-01', cents: 38_000_000 }, { day: '2026-09-30', cents: 45_500_000 }, { day: '2026-10-31', cents: 45_500_000 }] })
  const mortgage = db.addManualAccount({ name: 'Pinecrest Mortgage', assetType: 'mortgage', openedDay: '2022-03-01', linkedAssetId: house, points: owedPoints(30_000_000, 80_500) })
  db.updateAccount(mortgage, { apr: 3.75, escrowCents: 38_000 })
  const civic = db.addManualAccount({ name: '2017 Civic', assetType: 'vehicle', openedDay: '2019-06-01', costCents: 2_200_000, points: [{ day: '2019-06-01', cents: 2_200_000 }, { day: '2026-09-30', cents: 1_313_000 }, { day: '2026-10-31', cents: 1_300_000 }] })
  const civicLoan = db.addManualAccount({ name: 'Civic Auto Loan', assetType: 'loan', openedDay: '2019-06-01', linkedAssetId: civic, points: owedPoints(900_000, 36_400) })
  db.updateAccount(civicLoan, { apr: 6.4 })
  const studentLoan = db.addManualAccount({ name: 'Student Loan', assetType: 'loan', openedDay: '2016-09-01', points: owedPoints(2_400_000, 21_400) })
  db.updateAccount(studentLoan, { apr: 4.3 })
  const venture = db.saveBucket({ name: 'Side Studio', kind: 'business' })
  db.updateAccount(ACCOUNTS.studio, { bucketId: venture })

  const ids = { pinecrest: '', civic: '', student: '', meal: '', unsorted: [] as string[] }
  const sums = new Map<string, number>()
  const book = (account: string, day: string, cents: number, description: string, category?: string, merchant?: string): string => {
    sums.set(`${account}|${day.slice(0, 7)}`, (sums.get(`${account}|${day.slice(0, 7)}`) ?? 0) + cents)
    return line(account, day, cents, description, category, merchant)
  }
  db.inTransaction(() => {
    MONTHS.forEach((m, i) => {
      const end = lastDay(m)
      const on = (d: number): string => `${m}-${String(d).padStart(2, '0')}`
      // Checking: pay, the bills and the loans, the card's payment, and what goes to savings and the brokerage.
      for (const day of [on(15), end]) {
        book(ACCOUNTS.checking, day, 188_850, 'BRIGHTLINE PAYROLL DIR DEP', 'Paycheck', PAYROLL)
        // The 401(k) and the HSA take each check's saving: the employee's and the employer's.
        book(ACCOUNTS.retirement, day, 24_000, 'EMPLOYEE CONTRIBUTION')
        book(ACCOUNTS.retirement, day, 12_000, 'EMPLOYER MATCH')
        book(ACCOUNTS.hsa, day, 6_000, 'EMPLOYEE CONTRIBUTION')
        book(ACCOUNTS.hsa, day, 2_400, 'EMPLOYER CONTRIBUTION')
      }
      const pinecrest = book(ACCOUNTS.checking, on(1), -198_500, 'PINECREST MORTGAGE PMT', 'Housing', 'Pinecrest Mortgage')
      book(ACCOUNTS.checking, on(5), -23_200, 'ALDER LANE HOA DUES', 'Housing', 'Alder Lane HOA')
      const civicPay = book(ACCOUNTS.checking, on(6), -41_200, 'CIVIC AUTO LOAN PMT', 'Transfers', 'Civic Auto Loan')
      book(ACCOUNTS.checking, on(12), -(UTILITIES[m] ?? 29_000), 'HARBOR POWER CO', 'Utilities', 'Harbor Power')
      book(ACCOUNTS.checking, on(17), -6_800, 'CRESTLINE AUTO PREM', 'Insurance', 'Crestline Insurance')
      const studentPay = book(ACCOUNTS.checking, on(20), -30_000, 'STUDENT LOAN PMT', 'Transfers', 'Student Loan')
      book(ACCOUNTS.checking, on(22), -14_200, 'HARBORLINE HO PREM', 'Insurance', 'Harborline Mutual')
      book(ACCOUNTS.checking, on(26), -24_300, 'TRANSFER TO SAVINGS', 'Transfers', 'Transfer to Savings')
      book(ACCOUNTS.savings, on(26), 24_300, 'TRANSFER FROM CHECKING', 'Transfers', 'Transfer from Checking')
      book(ACCOUNTS.savings, end, 5_700, 'INTEREST PAID', 'Other Income', 'Harbor Bank Interest')
      if (TO_BROKERAGE(i)) {
        book(ACCOUNTS.checking, on(27), -TO_BROKERAGE(i), 'TRANSFER TO BROKERAGE', 'Transfers', 'Transfer to Brokerage')
        book(ACCOUNTS.brokerage, on(27), TO_BROKERAGE(i), 'TRANSFER FROM CHECKING', 'Transfers', 'Transfer from Checking')
      }
      if (i === 0) [ids.pinecrest, ids.civic, ids.student] = [pinecrest, civicPay, studentPay]

      // The Visa: subscriptions, everyday spending, a one-off, interest, and the payment.
      book(ACCOUNTS.visa, on(3), -4_053, 'FIT CLUB MEMBERSHIP', 'Subscriptions', 'Fit Club')
      book(ACCOUNTS.visa, on(4), m >= '2026-10' ? -1_799 : -1_549, 'NETFLIX.COM', 'Subscriptions', 'Netflix')
      book(ACCOUNTS.visa, on(9), -1_199, 'TUNEWAVE MUSIC', 'Subscriptions', 'Tunewave')
      book(ACCOUNTS.visa, on(16), -2_999, 'CLOUDBOX STORAGE', 'Subscriptions', 'Cloudbox')
      DINING(i).forEach((c, k) => book(ACCOUNTS.visa, on(8 + 11 * k), -c, 'CORNER BISTRO', 'Dining Out', 'Corner Bistro'))
      GROCERIES(i).forEach((c, k) => book(ACCOUNTS.visa, on(6 + 15 * k), -c, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market'))
      COFFEE(i).forEach((c, k) => book(ACCOUNTS.visa, on(2 + 9 * k), -c, 'DAILY GRIND CAFE', 'Coffee', 'Daily Grind'))
      if (i === 23) {
        book(ACCOUNTS.visa, on(9), -5_900, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell')
        book(ACCOUNTS.visa, on(27), -4_600, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell')
      } else book(ACCOUNTS.visa, on(14), i === 21 ? -8_400 : i === 22 ? -10_500 : -9_800, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell')
      if (i === 22) {
        ids.meal = book(ACCOUNTS.visa, on(11), -4_800, 'HARBORSIDE GRILL', 'Travel', 'Harborside Grill')
        book(ACCOUNTS.visa, on(18), -5_200, 'ONE-OFF GOODS 22', 'Shopping', 'One-off Goods 22')
      } else book(ACCOUNTS.visa, on(18), -ONE_OFFS(i), `ONE-OFF GOODS ${i}`, 'Shopping', `One-off Goods ${i}`)
      book(ACCOUNTS.visa, on(28), i === 23 ? -5_840 : i === 22 ? -4_000 : -2_800, 'INTEREST CHARGE', 'Fees & Interest', 'Visa Interest')
      // The payment brings what the card owes to its month-end figure.
      const charged = -(sums.get(`${ACCOUNTS.visa}|${m}`) ?? 0)
      const payment = visaOwed(i - 1) + charged - visaOwed(i)
      book(ACCOUNTS.checking, on(25), -payment, 'PAYMENT TO VISA', 'Transfers', 'Visa Payment')
      book(ACCOUNTS.visa, on(25), payment, 'PAYMENT THANK YOU', 'Transfers', 'Visa Payment')
    })

    // October 2026: the uncategorized lines, the venture's client, and the venture's own costs.
    ids.unsorted.push(book(ACCOUNTS.checking, '2026-10-08', -1_000, 'POS PURCHASE 4471'), book(ACCOUNTS.checking, '2026-10-21', -600, 'POS PURCHASE 9902'))
    if (o.unsorted86) ids.unsorted.push(book(ACCOUNTS.checking, '2026-10-23', -7_000, 'POS PURCHASE 3318'))
    book(ACCOUNTS.checking, '2026-10-14', 22_000, 'STUDIO CLIENT PAYMENT', 'Other Income', 'Studio Client')
    book(ACCOUNTS.studio, '2026-10-09', -30_900, 'PRINT SUPPLY CO', 'Shopping', 'Print Supply Co')
    book(ACCOUNTS.studio, '2026-10-19', -20_000, 'STUDIO SOFTWARE', 'Subscriptions', 'Studio Software')
  })
  runTool('add_bucket_rule', { bucket: 'Side Studio', contains: 'studio client' }, 'assistant')
  runTool('link_loan_payment', { account_id: mortgage, transaction_id: ids.pinecrest }, 'assistant')
  runTool('link_loan_payment', { account_id: civicLoan, transaction_id: ids.civic }, 'assistant')
  runTool('link_loan_payment', { account_id: studentLoan, transaction_id: ids.student }, 'assistant')

  // Month-end balances from the lines, so no month has a gap: checking ends October at 13,446.00, savings at
  // 20,000.00, the venture's account at 2,000.00; the brokerage holds 100,000.00 on Sep 30, 2026, the 401(k)
  // 120,000.00 and the HSA 20,000.00.
  const ends = (account: string, last: number, extra: (i: number) => number = () => 0): void => {
    const flows = MONTHS.map((m, i) => (sums.get(`${account}|${m}`) ?? 0) + extra(i))
    let balance = last - flows.reduce((s, c) => s + c, 0)
    db.setBalancePoint(account, '2024-10-31', balance)
    MONTHS.forEach((m, i) => {
      balance += flows[i]
      db.setBalancePoint(account, lastDay(m), balance)
    })
  }
  ends(ACCOUNTS.checking, 1_344_600)
  ends(ACCOUNTS.savings, 2_000_000)
  ends(ACCOUNTS.visa, -300_000)
  ends(ACCOUNTS.studio, 200_000)
  ends(ACCOUNTS.brokerage, 10_000_000 + 50_000 + 208_300, RETURNS)
  ends(ACCOUNTS.retirement, 12_072_000)
  ends(ACCOUNTS.hsa, 2_016_800)

  if (stubs) {
    db.saveContribution({ name: 'Brightline 401(k)', kind: '401k', accountId: ACCOUNTS.retirement, paycheckKey: KEY, employeeCents: 24_000, matchCents: 12_000 })
    db.saveContribution({ name: 'Brightline HSA', kind: 'hsa', accountId: ACCOUNTS.hsa, paycheckKey: KEY, employeeCents: 6_000, matchCents: 2_400 })
    for (const m of MONTHS) for (const day of [`${m}-15`, lastDay(m)]) stub(day)
  }

  db.setBudget(db.listCategories().find((c) => c.name === 'Dining Out')!.id, 40_000)
  db.setBudget(db.listCategories().find((c) => c.name === 'Coffee')!.id, 10_000)
  // Two goals set aside by hand (section 5's Saved): Emergency 18,400.00 of 25,000.00 and Norway 2027 1,200.00 of 4,000.00.
  addContribution(saveGoal({ name: 'Emergency', targetCents: 2_500_000, targetDay: null, funding: 'manual' }), { day: '2026-10-15', cents: 1_840_000 })
  addContribution(saveGoal({ name: 'Norway 2027', targetCents: 400_000, targetDay: '2027-04-01', funding: 'manual' }), { day: '2026-10-15', cents: 120_000 })
  setTaxYear(2025, { status: 'filed', refundCents: 102_000 })
  db.setSetting('retire.birthYear', '1990')
  db.setSetting('retire.age', '65')
  db.setSetting('retire.realReturnBp', '500')
  restorePolicy({ ...blankPolicy('Harborline Homeowners', 'home'), carrier: 'Harborline Mutual', match: 'harborline', premiumCents: 14_200, premiumPeriod: 'month' })
  restorePolicy({ ...blankPolicy('Crestline Auto', 'auto'), carrier: 'Crestline Insurance', match: 'crestline', premiumCents: 6_800, premiumPeriod: 'month' })
  return { house, mortgage, civic, civicLoan, studentLoan, venture, meal: ids.meal, unsorted: ids.unsorted }
}

/** A check's paystub, as section 5 has it. */
export function stub(day: string): number {
  return savePaystub({
    paycheckKey: KEY,
    payDay: day,
    grossCents: 300_000,
    items: [
      { kind: 'federal', cents: 34_800 },
      { kind: 'social_security', cents: 18_600 },
      { kind: 'medicare', cents: 4_350 },
      { kind: 'state', cents: 13_800 },
      { kind: 'medical', name: 'Medical', cents: 9_600, employerCents: 20_500 },
      { kind: '401k', name: 'Brightline 401(k)', cents: 24_000, employerCents: 12_000 },
      { kind: 'hsa', name: 'Brightline HSA', cents: 6_000, employerCents: 2_400 }
    ]
  })
}

/**
 * A gig earner with no paystub: 5,000.00 of side income each month from November 2024, and estimated tax of
 * 1,200.00 paid on Jun 15, Sep 15, Jan 15 and Apr 15, so four estimates fall in any 12 months. 2025's return,
 * filed, owed 900.00, paid on Apr 15, 2026 beside that day's estimate.
 */
export function gigHousehold(): { due: string } {
  db.openDb(':memory:')
  db.upsertAccount({ id: ACCOUNTS.checking, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.updateAccount(ACCOUNTS.checking, { assetType: 'cash' })
  let due = ''
  db.inTransaction(() => {
    for (const m of MONTHS) {
      line(ACCOUNTS.checking, `${m}-10`, 500_000, 'RIDEWELL PAYOUT', 'Other Income', 'Ridewell')
      if (['01', '04', '06', '09'].includes(m.slice(5))) line(ACCOUNTS.checking, `${m}-15`, -120_000, 'US TREASURY ESTIMATED TAX', 'Taxes', 'US Treasury')
    }
    due = line(ACCOUNTS.checking, '2026-04-15', -90_000, 'US TREASURY BALANCE DUE', 'Taxes', 'US Treasury')
  })
  setTaxYear(2025, { status: 'filed', refundCents: -90_000 })
  return { due }
}

/** Checking and a card that is paid in full each month: 3,000.00 charged and owed at each month's end, at 24%, and never charged interest. */
export function transactorHousehold(): void {
  db.openDb(':memory:')
  for (const [id, name, assetType] of [[ACCOUNTS.checking, 'Checking', 'cash'], [ACCOUNTS.visa, 'Visa', 'credit_card']] as const) {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(id, { assetType })
  }
  db.updateAccount(ACCOUNTS.visa, { apr: 24 })
  db.inTransaction(() => {
    MONTHS.forEach((m, i) => {
      line(ACCOUNTS.checking, `${m}-01`, 500_000, 'ACME PAYROLL DIR DEP', 'Paycheck', 'Acme Payroll')
      line(ACCOUNTS.visa, `${m}-10`, -300_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
      if (i > 0) {
        line(ACCOUNTS.checking, `${m}-05`, -300_000, 'PAYMENT TO VISA', 'Transfers', 'Visa Payment')
        line(ACCOUNTS.visa, `${m}-05`, 300_000, 'PAYMENT THANK YOU', 'Transfers', 'Visa Payment')
      }
    })
  })
  db.setBalancePoint(ACCOUNTS.visa, '2026-10-31', -300_000)
}
