import * as db from '../../src/main/db.ts'
import { runTool } from '../../src/main/tools.ts'
import { noonOn } from '../days.ts'

// The Bayview house (section 3 of the waterfall spec): a house the owner lives in with rooms rented out. From
// 2025-02-01 Bayview Rooms uses 66% of it and Personal 34%, by rooms. In October 2025 the mortgage payment
// of 2,000.00 is 1,200.00 of interest and escrow and 800.00 of principal (its balance goes from 172,000.00
// to 171,200.00), the dues are 385.00 and the utilities 290.00, all from Personal checking; the rooms'
// rent of 2,400.00 lands there too and goes to the venture by its rule. The house is worth 412,000.00.

export interface Bayview {
  checking: string
  house: string
  mortgage: string
  rooms: number
  payment: string
  hoa: string
  utilities: string
  rent: string
}

let n = 0
/** A settled line on an account on a day (YYYY-MM-DD), with a category and a merchant when given. */
export function txn(account: string, day: string, cents: number, description: string, cat?: string, merchant?: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `bv${++n}`
  db.upsertTransaction({ id, accountId: account, posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  const categoryId = cat ? db.listCategories().find((c) => c.name === cat)!.id : undefined
  if (categoryId !== undefined || merchant) db.setTransactionFields(id, { ...(categoryId !== undefined ? { categoryId, source: 'user' as const } : {}), ...(merchant ? { merchant } : {}) })
  return id
}

/**
 * The house on a new household. personalPct is Personal's use (34 as the spec has it); ventureOwned puts the house
 * (and so its mortgage) in Bayview Rooms instead of Personal; noUse leaves its uses unset; year adds the same dues
 * and utilities in every month from February 2025 to January 2026, the 12 months its uses cover that a carrying
 * cost reads in February 2026.
 */
export function bayview(o: { personalPct?: number; ventureOwned?: boolean; noUse?: boolean; year?: boolean } = {}): Bayview {
  db.openDb(':memory:')
  db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.updateAccount('csv:chk', { assetType: 'cash' })
  txn('csv:chk', '2025-01-02', 5_000_000, 'OPENING DEPOSIT')
  const rooms = db.saveBucket({ name: 'Bayview Rooms', kind: 'rental' })
  const house = db.addManualAccount({ name: 'Bayview house', assetType: 'property', openedDay: '2024-06-01', costCents: 40_000_000, points: [{ day: '2024-06-01', cents: 40_000_000 }, { day: '2025-10-31', cents: 41_200_000 }] })
  const mortgage = db.addManualAccount({ name: 'Bayview Lending', assetType: 'mortgage', openedDay: '2024-06-01', linkedAssetId: house, points: [{ day: '2025-09-30', cents: -17_200_000 }, { day: '2025-10-31', cents: -17_120_000 }] })
  if (o.ventureOwned) db.updateAccount(house, { bucketId: rooms })
  const payment = txn('csv:chk', '2025-10-15', -200_000, 'BAYVIEW LENDING PMT', 'Housing', 'Bayview Lending')
  runTool('link_loan_payment', { account_id: mortgage, transaction_id: payment }, 'assistant')
  const hoa = txn('csv:chk', '2025-10-05', -38_500, 'BAYVIEW CT HOA DUES', 'Housing', 'Bayview Ct HOA')
  const utilities = txn('csv:chk', '2025-10-12', -29_000, 'CITY UTILITIES', 'Utilities', 'City Utilities')
  const rent = txn('csv:chk', '2025-10-01', 240_000, 'BAYVIEW ROOMS RENT', 'Other Income', 'Bayview Rooms Rent')
  if (o.year) {
    for (const month of ['2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-11', '2025-12', '2026-01']) {
      txn('csv:chk', `${month}-05`, -38_500, 'BAYVIEW CT HOA DUES', 'Housing', 'Bayview Ct HOA')
      txn('csv:chk', `${month}-12`, -29_000, 'CITY UTILITIES', 'Utilities', 'City Utilities')
    }
  }
  runTool('add_bucket_rule', { bucket: 'Bayview Rooms', contains: 'bayview rooms rent' }, 'assistant')
  runTool('add_bucket_rule', { asset_id: house, contains: 'bayview ct hoa' }, 'assistant')
  runTool('add_bucket_rule', { asset_id: house, category: 'Utilities' }, 'assistant')
  if (!o.noUse) {
    const personal = o.personalPct ?? 34
    runTool('set_asset_use', { asset_id: house, uses: [{ owner: 'Bayview Rooms', share_pct: 100 - personal, from: '2025-02-01', basis: 'rooms' }, { owner: 'Personal', share_pct: personal, from: '2025-02-01', basis: 'rooms' }] }, 'assistant')
  }
  return { checking: 'csv:chk', house, mortgage, rooms, payment, hoa, utilities, rent }
}
