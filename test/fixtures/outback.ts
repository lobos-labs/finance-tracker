import * as db from '../../src/main/db.ts'
import { runTool } from '../../src/main/tools.ts'
import { txn } from './bayview.ts'

// A 2021 Outback driven partly for a business (section 3 of the waterfall spec). It's Personal; from
// 2026-03-01 Rideshare uses 35% of it and Personal 65%, by miles. Rules put the insurer and Gas & Fuel on
// the car's own card on it, and its loan's payments are its own. In October 2026 the loan payment of
// 412.00 is 87.30 of interest and 324.70 of principal (its balance goes from 15,000.00 to 14,675.30), and a
// 46.00 tank of gas goes on the card.

export interface Outback {
  checking: string
  card: string
  car: string
  loan: string
  rideshare: number
  payment: string
  gas: string
  insurance: string
}

/** The car on a new household; payment and principal (cents) change October's loan payment and what it pays down. */
export function outback(o: { payment?: number; principal?: number } = {}): Outback {
  const payment = o.payment ?? 41_200
  const principal = o.principal ?? 32_470
  db.openDb(':memory:')
  for (const [id, name, assetType] of [['csv:chk', 'Checking', 'cash'], ['csv:car-card', 'Outback Visa', 'credit_card']] as const) {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(id, { assetType })
  }
  txn('csv:chk', '2026-01-02', 2_000_000, 'OPENING DEPOSIT')
  const rideshare = db.saveBucket({ name: 'Rideshare', kind: 'business' })
  const car = db.addManualAccount({ name: '2021 Outback', assetType: 'vehicle', openedDay: '2024-01-10', costCents: 2_800_000, points: [{ day: '2024-01-10', cents: 2_800_000 }, { day: '2026-10-31', cents: 2_100_000 }] })
  const loan = db.addManualAccount({ name: 'Summit Auto Loan', assetType: 'loan', openedDay: '2024-01-10', linkedAssetId: car, points: [{ day: '2026-09-30', cents: -1_500_000 }, { day: '2026-10-31', cents: -(1_500_000 - principal) }] })
  const pay = txn('csv:chk', '2026-10-05', -payment, 'SUMMIT AUTO PMT', 'Transfers', 'Summit Auto Loan')
  runTool('link_loan_payment', { account_id: loan, transaction_id: pay }, 'assistant')
  const gas = txn('csv:car-card', '2026-10-09', -4_600, 'SHELL OIL 5521', 'Gas & Fuel', 'Shell')
  const insurance = txn('csv:chk', '2026-10-17', -11_800, 'BLUEPEAK AUTO INS', 'Insurance', 'Bluepeak Insurance')
  runTool('add_bucket_rule', { asset_id: car, contains: 'bluepeak auto' }, 'assistant')
  runTool('add_bucket_rule', { asset_id: car, account_id: 'csv:car-card', category: 'Gas & Fuel' }, 'assistant')
  runTool('set_asset_use', { asset_id: car, uses: [{ owner: 'Rideshare', share_pct: 35, from: '2026-03-01', basis: 'miles' }, { owner: 'Personal', share_pct: 65, from: '2026-03-01', basis: 'miles' }] }, 'assistant')
  return { checking: 'csv:chk', card: 'csv:car-card', car, loan, rideshare, payment: pay, gas, insurance }
}
