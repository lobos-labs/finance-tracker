import * as db from '../../src/main/db.ts'
import { runTool } from '../../src/main/tools.ts'
import type { AssetType } from '../../src/shared/types.ts'
import { noonOn } from '../days.ts'

// The debt and capital household of sub-phase 1c (test/debt-lines.test.ts), which 1g's identities reuse: checking,
// savings and a Visa with records from January 2025, so every bracket of balances after starts after they do.

const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id

let n = 0
/** A settled transaction on an account on a day (YYYY-MM-DD), with a category and a merchant if given. */
export function txn(account: string, day: string, cents: number, description: string, o: { cat?: string; merchant?: string } = {}): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `d${++n}`
  db.upsertTransaction({ id, accountId: account, posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  if (o.cat || o.merchant) db.setTransactionFields(id, { ...(o.cat ? { categoryId: category(o.cat), source: 'user' as const } : {}), ...(o.merchant ? { merchant: o.merchant } : {}) })
  return id
}

/** A manual asset or debt with its known values (debts as amounts owed, positive here). */
export function manual(name: string, assetType: AssetType, o: { opened?: string; closed?: string; cost?: number; linked?: string; points: Array<[string, number]> }): string {
  const sign = assetType === 'loan' || assetType === 'mortgage' || assetType === 'other_debt' ? -1 : 1
  return db.addManualAccount({ name, assetType, openedDay: o.opened ?? null, closedDay: o.closed ?? null, costCents: o.cost ?? null, linkedAssetId: o.linked ?? null, points: o.points.map(([day, cents]) => ({ day, cents: sign * cents })) })
}

/** A new household: checking, savings and a Visa, with records from January 2025. */
export function household(): void {
  db.openDb(':memory:')
  for (const [id, name, assetType] of [['csv:chk', 'Checking', 'cash'], ['csv:sav', 'Savings', 'cash'], ['csv:visa', 'Visa', 'credit_card']] as const) {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(id, { assetType })
  }
  txn('csv:chk', '2025-01-02', 500_000, 'OPENING DEPOSIT')
  txn('csv:sav', '2025-01-02', 5_000_000, 'OPENING DEPOSIT')
}

/** Links a debt to the payments of a transaction's payee, as Review does. */
export const link = (debt: string, payment: string): void => void runTool('link_loan_payment', { account_id: debt, transaction_id: payment }, 'assistant')
