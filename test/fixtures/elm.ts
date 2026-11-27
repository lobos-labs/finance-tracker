import * as db from '../../src/main/db.ts'
import { noonOn } from '../days.ts'

// The Elm St house (test/ventures-gains.test.ts's sold house). The Elm St venture bought it on 2020-05-15 for
// 300,000.00 with a 240,000.00 mortgage; the user lived in it from 2020-06-01 to 2021-06-30 (the venture's
// residence dates), then rented it out, and it sold on 2023-03-10 for 360,000.00 less 27,000.00 of selling
// costs. Every line of the venture's is on Personal checking and placed in the venture by hand: in the residence
// dates, 12 mortgage payments of 1,500.00 and 12 utility bills of 200.00. Personal's own groceries of 95.00 come
// every month beside them.

export interface Elm {
  bucket: number
  house: string
  mortgage: string
  /** each description's transactions, oldest first */
  ids: Map<string, string[]>
}

/** The months the fixture's lines cover, YYYY-MM. */
export const ELM_MONTHS = Array.from({ length: 38 }, (_, i) => `${2020 + Math.floor((i + 1) / 12)}-${String(((i + 1) % 12) + 1).padStart(2, '0')}`)

/** The house on the open database, with Personal checking (csv:chk) and every line; ids are the same each time. */
export function elmSt(): Elm {
  let n = 0
  const ids = new Map<string, string[]>()
  const txn = (day: string, cents: number, description: string, cat?: string): string => {
    const [y, m, d] = day.split('-').map(Number)
    const id = `elm${++n}`
    db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
    if (cat) db.setTransactionFields(id, { categoryId: db.listCategories().find((c) => c.name === cat)!.id, source: 'user' })
    ids.set(description, [...(ids.get(description) ?? []), id])
    return id
  }
  const monthly = (from: string, to: string, day: number, cents: number, description: string): string[] =>
    ELM_MONTHS.filter((m) => m >= from && m <= to).map((m) => txn(`${m}-${String(day).padStart(2, '0')}`, cents, description))

  db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  const bucket = db.saveBucket({ name: 'Elm St', kind: 'rental', residenceFrom: '2020-06-01', residenceTo: '2021-06-30' })
  const house = db.addManualAccount({ name: 'Elm house', assetType: 'property', openedDay: '2020-05-15', closedDay: '2023-03-10', costCents: 30_000_000, points: [{ day: '2020-05-15', cents: 30_000_000 }, { day: '2023-03-10', cents: 36_000_000 }] })
  db.updateAccount(house, { bucketId: bucket, saleCostsCents: 2_700_000 })
  const mortgage = db.addManualAccount({ name: 'Elm St mortgage', assetType: 'mortgage', openedDay: '2020-05-15', linkedAssetId: house, points: [{ day: '2020-05-15', cents: -24_000_000 }, { day: '2023-03-10', cents: -22_500_000 }] })
  const placed = [
    txn('2020-02-01', -30_000, 'HOME INSPECTION'),
    txn('2020-03-01', -1_000_000, 'EARNEST MONEY'),
    txn('2020-05-15', -6_500_000, 'TITLE CO CLOSING'),
    txn('2020-05-20', -100_000, 'TRANSFER TO SAVINGS', 'Transfers'),
    ...monthly('2020-07', '2023-03', 1, -150_000, 'MORTGAGE PMT'),
    ...monthly('2020-07', '2021-06', 12, -20_000, 'CITY UTILITIES'),
    txn('2021-07-15', -80_000, 'PLUMBER'),
    ...monthly('2021-08', '2023-02', 3, 250_000, 'RENT'),
    txn('2023-03-10', 12_000_000, 'TITLE CO PROCEEDS'),
    txn('2023-03-12', -10_000, 'FINAL UTILITIES'),
    txn('2023-03-15', 50_000, 'ESCROW REFUND'),
    txn('2023-03-20', 30_000, 'DEPOSIT RETURNED')
  ]
  db.setTransactionsBucket(placed, bucket)
  for (const m of ELM_MONTHS) txn(`${m}-20`, -9_500, 'CORNER GROCER', 'Groceries')
  return { bucket, house, mortgage, ids }
}
