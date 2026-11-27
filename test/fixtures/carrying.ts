import * as db from '../../src/main/db.ts'
import { restorePolicy } from '../../src/main/insurance.ts'
import { blankPolicy } from '../../src/main/policies.ts'
import { runTool } from '../../src/main/tools.ts'
import { shiftMonth } from '../../src/shared/zone.ts'
import { txn } from './bayview.ts'

// The house and the car of the waterfall spec's section 5 household, as its phase 2 wireframes show them, with
// the 12 months before November 2026 (the household's October is its latest closed month). The full household is
// test/fixtures/waterfall-household.ts; this is only what its two assets cost to keep.
//   House (Alder Lane): the Pinecrest payment of 1,985.00 on the 1st is 800.00 interest, 380.00 escrow and, in
//   October, 805.00 principal; dues of 232.00 on the 5th; one variable utility averaging 290.00 (318.00 in
//   October); Harborline home insurance of 142.00 on the 22nd.
//   Car (2017 Civic): October's loan payment of 412.00, with 9,000.00 owed at 6.4% and no second balance, is
//   48.00 interest and 364.00 principal; Crestline auto insurance of 68.00 on the 17th; gas on the Visa
//   averaging 98.00 (59.00 on Oct 9 and 46.00 on Oct 27).

export const TODAY = '2026-11-07'

export interface Household {
  checking: string
  visa: string
  house: string
  mortgage: string
  civic: string
  civicLoan: string
  gas: string[]
}

/** The 12 months the averages are over, November 2025 to October 2026. */
const MONTHS = Array.from({ length: 12 }, (_, i) => shiftMonth('2025-11', i))

export function household(): Household {
  db.openDb(':memory:')
  for (const [id, name, assetType] of [['csv:chk', 'Checking', 'cash'], ['csv:visa', 'Visa', 'credit_card']] as const) {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(id, { assetType })
  }
  txn('csv:chk', '2025-10-01', 10_000_000, 'OPENING DEPOSIT')

  const house = db.addManualAccount({ name: 'Alder Lane house', assetType: 'property', openedDay: '2022-03-01', costCents: 38_000_000, points: [{ day: '2022-03-01', cents: 38_000_000 }, { day: '2026-10-31', cents: 41_000_000 }] })
  const mortgage = db.addManualAccount({ name: 'Pinecrest Mortgage', assetType: 'mortgage', openedDay: '2022-03-01', linkedAssetId: house, points: [{ day: '2026-09-30', cents: -30_000_000 }, { day: '2026-10-31', cents: -29_919_500 }] })
  db.updateAccount(mortgage, { apr: 3.75, escrowCents: 38_000 })
  const civic = db.addManualAccount({ name: '2017 Civic', assetType: 'vehicle', openedDay: '2019-06-01', costCents: 2_200_000, points: [{ day: '2019-06-01', cents: 2_200_000 }, { day: '2026-10-31', cents: 1_300_000 }] })
  const civicLoan = db.addManualAccount({ name: 'Civic Auto Loan', assetType: 'loan', openedDay: '2019-06-01', linkedAssetId: civic, points: [{ day: '2026-09-30', cents: -900_000 }] })
  db.updateAccount(civicLoan, { apr: 6.4 })

  const pinecrest: string[] = []
  const gas: string[] = []
  // One utility, variable: 284.00 a year before October, 287.40 or 288.00 a month after, 318.00 in October.
  txn('csv:chk', '2025-10-12', -28_400, 'HARBOR POWER CO', 'Utilities', 'Harbor Power')
  MONTHS.forEach((m, i) => {
    pinecrest.push(txn('csv:chk', `${m}-01`, -198_500, 'PINECREST MORTGAGE PMT', 'Housing', 'Pinecrest Mortgage'))
    txn('csv:chk', `${m}-05`, -23_200, 'ALDER LANE HOA DUES', 'Housing', 'Alder Lane HOA')
    txn('csv:chk', `${m}-12`, i === 11 ? -31_800 : i === 10 ? -28_800 : -28_740, 'HARBOR POWER CO', 'Utilities', 'Harbor Power')
    txn('csv:chk', `${m}-17`, -6_800, 'CRESTLINE AUTO PREM', 'Insurance', 'Crestline Insurance')
    txn('csv:chk', `${m}-22`, -14_200, 'HARBORLINE HO PREM', 'Insurance', 'Harborline Mutual')
    if (i < 9) gas.push(txn('csv:visa', `${m}-14`, -9_800, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell'))
    else if (i < 11) gas.push(txn('csv:visa', `${m}-14`, -9_450, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell'))
  })
  gas.push(txn('csv:visa', '2026-10-09', -5_900, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell'), txn('csv:visa', '2026-10-27', -4_600, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell'))
  const civicPayment = txn('csv:chk', '2026-10-05', -41_200, 'CIVIC AUTO LOAN PMT', 'Transfers', 'Civic Auto Loan')
  runTool('link_loan_payment', { account_id: mortgage, transaction_id: pinecrest[0] }, 'assistant')
  runTool('link_loan_payment', { account_id: civicLoan, transaction_id: civicPayment }, 'assistant')

  restorePolicy({ ...blankPolicy('Harborline Homeowners', 'home'), carrier: 'Harborline Mutual', match: 'harborline', premiumCents: 14_200, premiumPeriod: 'month' })
  restorePolicy({ ...blankPolicy('Crestline Auto', 'auto'), carrier: 'Crestline Insurance', match: 'crestline', premiumCents: 6_800, premiumPeriod: 'month' })
  return { checking: 'csv:chk', visa: 'csv:visa', house, mortgage, civic, civicLoan, gas }
}
