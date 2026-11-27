import * as db from '../../src/main/db.ts'
import type { VentureIntent } from '../../src/shared/types.ts'
import { noonOn } from '../days.ts'

// Kestrel Studio, the venture-money addendum's example B (waterfall spec addendum 1.11, sub-phase 1j): a business the
// user owns 40% of from 2026-01-15 and 50% from 2026-11-02, with December open. Amounts are cents.
//   Jan 15: Checking sends Kestrel Checking 4,000.00 (equity, for 40%), and the other owners send it 6,000.00, in
//   Transfers with no leg the books see. Kestrel has no other money until November.
//   May to October: rent of 2,000.00 from Checking on the 5th, a bill series the fixture confirms.
//   Oct 31: Checking 6,000.00, Kestrel Checking 10,000.00.
//   November: Nov 2, Checking sends Kestrel Checking 5,000.00 (a loan of 3,000.00 and equity of 2,000.00, for 50%);
//   Nov 3, pay of 4,000.00 into Checking, in Paycheck, with no paystub; Nov 5, the rent; Nov 9, groceries of 600.00
//   on Checking; Nov 12, Kestrel Checking pays 100.00 of groceries, placed in Personal (its funding is a
//   reimbursement); Nov 16 and 18, Kestrel's own revenue of 4,000.00 and costs of 1,200.00; Nov 20, Kestrel Checking
//   sends Checking 1,030.00 (a loan repayment with 30.00 of interest).
//   Nov 30: Checking 3,430.00, Kestrel Checking 16,670.00.
// With `stake`, a Personal Stakes account, Kestrel stake, worth 8,000.00 on Oct 31 and 9,000.00 on Nov 30, not yet
// linked to the venture. The shares are written as Review's, unless `shares` is false: then Kestrel has only the 0%
// it was made with, as Review's set_venture_money finds a venture whose share was never recorded. The intent parts
// are written straight into venture_money by storeParts, or by Review's set_venture_money (setParts).

export const TODAY = '2026-12-07'
export const PAYROLL = 'Orbit Labs Payroll'

export const ACCOUNTS = {
  checking: 'csv:chk',
  kestrel: 'csv:kestrel'
} as const

export interface Kestrel {
  venture: number
  /** the Personal Stakes account, with `stake` */
  stake: string | null
  /** Jan 15's 4,000.00 from Checking */
  equity: string
  /** Nov 2's 5,000.00 from Checking */
  mixed: string
  /** Nov 12's 100.00 of groceries Kestrel Checking paid, placed in Personal */
  groceries: string
  /** Nov 20's 1,030.00 into Checking */
  repayment: string
  /** the legs on Kestrel Checking of Jan 15, Nov 2 and Nov 20 */
  legs: { equity: string; mixed: string; repayment: string }
}

let n = 0

/** A settled line on an account on a day (YYYY-MM-DD), with a category and a payee when given. */
export function line(account: string, day: string, cents: number, description: string, category?: string, merchant?: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `vm${++n}`
  db.upsertTransaction({ id, accountId: account, posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  const categoryId = category ? db.listCategories().find((c) => c.name === category)!.id : undefined
  if (categoryId !== undefined || merchant) db.setTransactionFields(id, { ...(categoryId !== undefined ? { categoryId, source: 'user' as const } : {}), ...(merchant ? { merchant } : {}) })
  return id
}

/** Kestrel Studio's books on a new ledger in memory. */
export function kestrel(o: { stake?: boolean; shares?: boolean } = {}): Kestrel {
  db.openDb(':memory:')
  const now = noonOn(2026, 12, 7)
  const csv = (id: string, name: string, balanceCents: number): void => {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents, availableCents: null, balanceDate: now })
    db.updateAccount(id, { assetType: 'cash' })
  }
  csv(ACCOUNTS.checking, 'Checking', 343_000)
  csv(ACCOUNTS.kestrel, 'Kestrel Checking', 1_667_000)
  // Made with none of it the user's: the shares below are the user's from the day they bought in.
  const venture = db.saveBucket({ name: 'Kestrel Studio', kind: 'business', inNetWorth: false })
  db.updateAccount(ACCOUNTS.kestrel, { bucketId: venture })
  if (o.shares !== false) {
    db.setVentureShare(venture, '2026-01-15', 4000, 'review')
    db.setVentureShare(venture, '2026-11-02', 5000, 'review')
  }

  const ids = db.inTransaction(() => {
    const equity = line(ACCOUNTS.checking, '2026-01-15', -400_000, 'TRANSFER TO KESTREL', 'Transfers', 'Kestrel Studio')
    const equityLeg = line(ACCOUNTS.kestrel, '2026-01-15', 400_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
    line(ACCOUNTS.kestrel, '2026-01-15', 600_000, 'PARTNER CAPITAL', 'Transfers', 'Partner Capital')
    for (const m of ['05', '06', '07', '08', '09', '10', '11']) line(ACCOUNTS.checking, `2026-${m}-05`, -200_000, 'ALDER LEASING RENT', 'Housing', 'Alder Leasing')
    const mixed = line(ACCOUNTS.checking, '2026-11-02', -500_000, 'TRANSFER TO KESTREL', 'Transfers', 'Kestrel Studio')
    const mixedLeg = line(ACCOUNTS.kestrel, '2026-11-02', 500_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
    line(ACCOUNTS.checking, '2026-11-03', 400_000, 'ORBIT LABS PAYROLL', 'Paycheck', PAYROLL)
    line(ACCOUNTS.checking, '2026-11-09', -60_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    const groceries = line(ACCOUNTS.kestrel, '2026-11-12', -10_000, 'FRESHWAY MARKET', 'Groceries', 'Freshway Market')
    line(ACCOUNTS.kestrel, '2026-11-16', 400_000, 'STUDIO CLIENT INVOICE', 'Other Income', 'Studio Client')
    line(ACCOUNTS.kestrel, '2026-11-18', -120_000, 'STUDIO SUPPLIES', 'Other', 'Studio Supplies')
    const repaymentLeg = line(ACCOUNTS.kestrel, '2026-11-20', -103_000, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
    const repayment = line(ACCOUNTS.checking, '2026-11-20', 103_000, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    return { equity, mixed, groceries, repayment, legs: { equity: equityLeg, mixed: mixedLeg, repayment: repaymentLeg } }
  })
  // The groceries are Personal's, though Kestrel's account paid them.
  db.setTransactionsBucket([ids.groceries], null)
  db.setRecurringOverride('alder leasing|-', { status: 'confirmed' })

  const stake = o.stake
    ? db.addManualAccount({ name: 'Kestrel stake', assetType: 'venture', points: [{ day: '2026-10-31', cents: 800_000 }, { day: '2026-11-30', cents: 900_000 }] })
    : null
  return { venture, stake, ...ids }
}

/** Writes one intent part straight into venture_money, as Review's set_venture_money (1j's part 2) will. */
export function storePart(venture: number, txnId: string, intent: VentureIntent, cents: number, o: { face?: 'line' | 'fund'; interestCents?: number; regular?: boolean } = {}): void {
  db.run(
    'INSERT INTO venture_money (txn_id, split_id, face, venture_id, intent, cents, interest_cents, regular, source, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    txnId,
    o.face ?? 'line',
    venture,
    intent,
    cents,
    o.interestCents ?? 0,
    o.regular === undefined ? null : o.regular ? 1 : 0,
    'review',
    db.now()
  )
}

/**
 * Example B's intent parts: Jan 15's 4,000.00 is equity; Nov 2's 5,000.00 a loan of 3,000.00 and equity of 2,000.00;
 * the 100.00 of groceries' funding (+100.00) a reimbursement; Nov 20's 1,030.00 a loan repayment with 30.00 of interest.
 */
export function storeParts(k: Kestrel): void {
  storePart(k.venture, k.equity, 'equity', -400_000)
  storePart(k.venture, k.mixed, 'loan', -300_000)
  storePart(k.venture, k.mixed, 'equity', -200_000)
  storePart(k.venture, k.groceries, 'reimbursement', 10_000, { face: 'fund' })
  storePart(k.venture, k.repayment, 'loan_repayment', 103_000, { interestCents: 3_000 })
}

/**
 * Example B's intent parts as Review gives them (set_venture_money), each with the share after it: Jan 15's 4,000.00
 * equity for 40%; Nov 2's 5,000.00 as a loan of 3,000.00 and equity of 2,000.00, for 50%; the groceries' funding a
 * reimbursement; Nov 20's 1,030.00 a loan repayment with 30.00 of interest. Returns each call's change id.
 */
export function setParts(k: Kestrel, run: (name: string, input: Record<string, unknown>) => { changeId?: number }): number[] {
  return [
    run('set_venture_money', { transaction_ids: [k.equity], venture: 'Kestrel Studio', intent: 'equity', share_after_pct: 40 }),
    run('set_venture_money', { transaction_ids: [k.mixed], venture: 'Kestrel Studio', intent: 'loan', parts: [{ intent: 'loan', amount: 3000 }, { intent: 'equity', amount: 2000 }], share_after_pct: 50 }),
    run('set_venture_money', { transaction_ids: [k.groceries], venture: 'Kestrel Studio', intent: 'reimbursement' }),
    run('set_venture_money', { transaction_ids: [k.repayment], venture: 'Kestrel Studio', intent: 'loan_repayment', interest: 30 })
  ].map((r) => r.changeId!)
}

/**
 * Kestrel Studio's two accounts alone, for examples E and F: Checking, and Kestrel Checking, which the venture holds
 * at the 100% it's made with. Each holds `checkingCents` and `kestrelCents` on Dec 7 (by default 1,980.00 and
 * 10,000.00), and neither has a line yet. Returns the venture's id.
 */
export function kestrelBooks(o: { checkingCents?: number; kestrelCents?: number } = {}): number {
  db.openDb(':memory:')
  const now = noonOn(2026, 12, 7)
  for (const [id, name, balanceCents] of [
    [ACCOUNTS.checking, 'Checking', o.checkingCents ?? 198_000],
    [ACCOUNTS.kestrel, 'Kestrel Checking', o.kestrelCents ?? 1_000_000]
  ] as const) {
    db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents, availableCents: null, balanceDate: now })
    db.updateAccount(id, { assetType: 'cash' })
  }
  const venture = db.saveBucket({ name: 'Kestrel Studio', kind: 'business' })
  db.updateAccount(ACCOUNTS.kestrel, { bucketId: venture })
  return venture
}
