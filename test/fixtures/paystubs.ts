// Households for the paystub tests (test/paystubs.test.ts) and the waterfall sub-phases that read pay after them:
// one checking account, a payroll paid into it, and the paystubs that explain its checks. Amounts are cents.
import * as db from '../../src/main/db.ts'
import { savePaystub } from '../../src/main/paystubs.ts'
import type { PaystubInput } from '../../src/shared/types.ts'
import { noonOn } from '../days.ts'

export const PAYROLL = 'Acme Corp Payroll'
export const KEY = 'acme corp payroll|+'
export const CHECKING = 'csv:chk'
/** The day the tests run on: November is open, so September and October are closed months. */
export const TODAY = '2026-11-07'

let n = 0

/** A new household with one checking account. */
export function household(): void {
  db.openDb(':memory:')
  db.upsertAccount({ id: CHECKING, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.updateAccount(CHECKING, { assetType: 'cash' })
}

/** A paycheck deposited to checking on a day (YYYY-MM-DD), filed as Paycheck. */
export function deposit(day: string, cents: number, payee = PAYROLL): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `pay${++n}`
  db.upsertTransaction({ id, accountId: CHECKING, posted: noonOn(y, m, d), amountCents: cents, description: `${payee.toUpperCase()} DIR DEP`, pending: false })
  db.setTransactionFields(id, { categoryId: db.listCategories().find((c) => c.name === 'Paycheck')!.id, source: 'user', merchant: payee })
  return id
}

/** Acme's lines on a check of 2,880.00 or 3,000.00: taxes 690.00 or 720.00, medical 96.00 and an 8% 401(k). */
export function acmeLines(gross: 288_000 | 300_000): PaystubInput['items'] {
  const taxes: PaystubInput['items'] =
    gross === 288_000
      ? [
          { kind: 'federal', cents: 34_000 },
          { kind: 'social_security', cents: 17_856 },
          { kind: 'medicare', cents: 4_176 },
          { kind: 'state', cents: 12_968 }
        ]
      : [
          { kind: 'federal', cents: 36_000 },
          { kind: 'social_security', cents: 18_600 },
          { kind: 'medicare', cents: 4_350 },
          { kind: 'state', cents: 13_050 }
        ]
  return [...taxes, { kind: 'medical', cents: 9_600 }, { kind: '401k', name: 'Acme 401(k)', cents: gross === 288_000 ? 23_040 : 24_000 }]
}

/** Net pay on Acme's checks: 1,863.60 on 2,880.00 and 1,944.00 on 3,000.00. */
export const ACME_NET = { 288_000: 186_360, 300_000: 194_400 } as const

/** A paystub for Acme's payroll. */
export const acmeStub = (day: string, gross: 288_000 | 300_000, o: Partial<PaystubInput> = {}): number => savePaystub({ paycheckKey: KEY, payDay: day, grossCents: gross, items: acmeLines(gross), ...o })

/** Every other Friday from Jul 10 through Oct 30, 2026. */
export const FRIDAYS = ['2026-07-10', '2026-07-24', '2026-08-07', '2026-08-21', '2026-09-04', '2026-09-18', '2026-10-02', '2026-10-16', '2026-10-30']

/**
 * The 1d match household: paid 3,000.00 semimonthly (the 15th and the month's last day, Jul 15 to Oct 31, 2026),
 * with a 4% 401(k) election of 120.00 a check, matched at 50% of the first 6%: 60.00 a check from the employer. The
 * latest check's stub has taxes 649.50 and the 401(k), so each deposit is 2,230.50.
 */
export function matchHousehold(): void {
  household()
  const days = ['2026-07-15', '2026-07-31', '2026-08-15', '2026-08-31', '2026-09-15', '2026-09-30', '2026-10-15', '2026-10-31']
  for (const day of days) deposit(day, 223_050)
  db.saveContribution({ name: 'Acme 401(k)', kind: '401k', paycheckKey: KEY, percent: 4, employeeCents: 12_000, matchCents: 6_000, matchNote: '50% of the first 6%' })
  savePaystub({
    paycheckKey: KEY,
    payDay: '2026-10-31',
    grossCents: 300_000,
    items: [
      { kind: 'federal', cents: 30_000 },
      { kind: 'social_security', cents: 18_600 },
      { kind: 'medicare', cents: 4_350 },
      { kind: 'state', cents: 12_000 },
      { kind: '401k', name: 'Acme 401(k)', cents: 12_000, employerCents: 6_000 }
    ]
  })
}
