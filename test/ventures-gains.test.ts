import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { configureLicense } from '../src/main/license.ts'
import { runAssistantTool } from '../src/main/tools.ts'
import { getVenture, listVentures } from '../src/main/ventures.ts'
import type { VentureResult } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { elmSt } from './fixtures/elm.ts'

// A venture's result is its whole picture: operating cash flow (without the
// money that bought and sold its assets, loan principal added back) plus each
// asset's gain or loss, realized once sold and on paper while owned.

configureLicense({ dev: true })

const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
let n = 0
/** A settled transaction on a day (YYYY-MM-DD), on the checking account unless another is named, optionally in a category. */
function txn(day: string, cents: number, description: string, o: { cat?: string; account?: string } = {}): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `t${++n}`
  db.upsertTransaction({ id, accountId: o.account ?? 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  if (o.cat) db.setTransactionFields(id, { categoryId: category(o.cat), source: 'user' })
  return id
}
/** The same transaction on a day of each month from one YYYY-MM to another. */
function monthly(from: string, to: string, day: number, cents: number, description: string): string[] {
  const ids: string[] = []
  let [y, m] = from.split('-').map(Number)
  for (; `${y}-${String(m).padStart(2, '0')}` <= to; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) ids.push(txn(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`, cents, description))
  return ids
}
const totals = (r: VentureResult): number[] => [r.inCents, r.outCents, r.operatingCents, r.purchaseCents, r.proceedsCents, r.principalCents, r.realizedCents, r.onPaperCents, r.totalCents]
const flowSum = (ids: string[]): number => ids.reduce((s, id) => s + db.getTransaction(id)!.amountCents, 0)

describe('venture result', () => {
  before(() => {
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  })
  after(db.closeDb)

  test('a sold house: its purchase, proceeds and principal out of operating, and its costs while the user lived there Personal’s use of it', () => {
    const { bucket, house } = elmSt()
    // Its residence dates become Personal's use of the house when the books next open (migration 41); here, at once.
    assert.equal(db.convertResidences(), 1)
    const r = getVenture(bucket).result
    // Pinned from the sold-house-only result this replaced (in 47,800.00, out 38,100.00, operating 9,700.00, total
    // 42,700.00), less the 12 mortgage payments and 12 utility bills of the residence dates (20,400.00): those are
    // Personal's, as its use of the house, and no longer counted by the venture too.
    assert.deepEqual(
      [r.inCents, r.outCents, r.operatingCents, r.purchaseCents, r.proceedsCents, r.principalCents, r.totalCents],
      [4_780_000, 1_770_000, 3_010_000, 7_500_000, 12_050_000, 1_500_000, 6_310_000]
    )
    assert.deepEqual(r.personalUse, [{ assetId: house, fromDay: '2020-06-01', toDay: '2021-06-30', personalBp: 10_000, cents: -2_040_000 }])
    // Operating plus Personal use is the 9,700.00 the venture made bearing those costs too.
    assert.equal(r.operatingCents + r.personalUse[0].cents, 970_000)
    assert.deepEqual(
      r.assets.map((a) => [a.id, a.boughtDay, a.soldDay, a.valueCents, a.saleCostsCents, a.costCents, a.gainCents, a.gainFrom, a.sold, a.owedCents, a.equityCents]),
      [[house, '2020-05-15', '2023-03-10', 36_000_000, 2_700_000, 30_000_000, 3_300_000, 'cost', true, 22_500_000, 13_500_000]]
    )
    assert.deepEqual([r.realizedCents, r.onPaperCents, r.missingCost], [3_300_000, 0, []])
    // The asset's numbers are the Assets page's.
    const shown = db.listAssets().find((a) => a.account.id === house)!
    assert.deepEqual([shown.valueCents, shown.owedCents, shown.equityCents, shown.gainCents, shown.sold], [36_000_000, 22_500_000, 13_500_000, 3_300_000, true])
  })

  test('an owned rental: the purchase money out of operating, principal added back, the gain on paper', () => {
    const bucket = db.saveBucket({ name: 'Oak Ave', kind: 'rental' })
    // $400,000 with $80,000 down and $8,000 of closing costs: the cost is the cash paid and the loan.
    const condo = db.addManualAccount({ name: 'Oak condo', assetType: 'property', openedDay: '2024-04-01', costCents: 40_800_000, points: [{ day: '2024-04-01', cents: 40_000_000 }, { day: '2025-10-01', cents: 44_000_000 }] })
    db.updateAccount(condo, { bucketId: bucket })
    db.addManualAccount({ name: 'Oak Ave mortgage', assetType: 'mortgage', openedDay: '2024-04-01', linkedAssetId: condo, points: [{ day: '2024-04-01', cents: -32_000_000 }, { day: '2025-10-01', cents: -31_400_000 }] })
    const ids = [
      txn('2024-03-01', -500_000, 'EARNEST MONEY'),
      txn('2024-04-01', -8_300_000, 'TITLE CO CLOSING'),
      ...monthly('2024-05', '2025-10', 1, -250_000, 'MORTGAGE PMT'),
      ...monthly('2024-06', '2025-10', 3, 320_000, 'RENT'),
      txn('2024-09-10', -120_000, 'HANDYMAN')
    ]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    // In: 17 rents. Out: 18 payments and the handyman, less the $6,000 the loan went down.
    assert.deepEqual(totals(r), [5_440_000, 4_020_000, 1_420_000, 8_800_000, 0, 600_000, 0, 3_200_000, 4_620_000])
    assert.equal(r.totalCents, r.operatingCents + r.onPaperCents)
    assert.deepEqual(
      r.assets.map((a) => [a.boughtDay, a.soldDay, a.costCents, a.valueCents, a.gainCents, a.sold, a.owedCents, a.equityCents]),
      [['2024-04-01', null, 40_800_000, 44_000_000, 3_200_000, false, 31_400_000, 12_600_000]]
    )
    assert.deepEqual(r.personalUse, [])
    const shown = db.listAssets().find((a) => a.account.id === condo)!
    assert.deepEqual([shown.valueCents, shown.owedCents, shown.equityCents, shown.gainCents], [44_000_000, 31_400_000, 12_600_000, 3_200_000])
    // Its cost being the cash paid and the loan, the total is every dollar in and out so far plus the equity held.
    assert.equal(r.totalCents, flowSum(ids) + r.assets[0].equityCents)
  })

  test('a vehicle bought and sold in a business: its gain realized, the purchase and proceeds out of operating', () => {
    const bucket = db.saveBucket({ name: 'Acme Studio', kind: 'business' })
    const van = db.addManualAccount({ name: 'Work van', assetType: 'vehicle', openedDay: '2023-02-01', closedDay: '2024-08-15', costCents: 3_000_000, points: [{ day: '2023-02-01', cents: 3_000_000 }, { day: '2024-08-15', cents: 2_200_000 }] })
    db.updateAccount(van, { bucketId: bucket, saleCostsCents: 50_000 })
    const ids = [
      txn('2023-02-01', -3_000_000, 'CITY MOTORS'),
      txn('2023-06-01', 500_000, 'CLIENT A'),
      txn('2023-09-12', -120_000, 'FUEL'),
      txn('2024-01-10', 500_000, 'CLIENT B'),
      txn('2024-08-15', 2_150_000, 'USED CAR BUYER'),
      txn('2024-08-30', 40_000, 'CLIENT C')
    ]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    assert.deepEqual(totals(r), [1_040_000, 120_000, 920_000, 3_000_000, 2_150_000, 0, -850_000, 0, 70_000])
    assert.deepEqual(r.assets.map((a) => [a.soldDay, a.valueCents, a.saleCostsCents, a.gainCents, a.sold]), [['2024-08-15', 2_200_000, 50_000, -850_000, true]])
    // Bought and sold for cash, the total is the venture's cash in and out.
    assert.equal(r.totalCents, flowSum(ids))
  })

  test('a stake written off: closed with nothing back is a realized loss of its cost', () => {
    const bucket = db.saveBucket({ name: 'Seed bets', kind: 'business' })
    // Closed on the asset's page: the date in its details, a value of 0 on that day in its history.
    const widget = db.addManualAccount({ name: 'Widget Co', assetType: 'venture', openedDay: '2022-05-01', costCents: 2_500_000, points: [{ day: '2022-05-01', cents: 2_500_000 }] })
    db.updateAccount(widget, { bucketId: bucket, closedDay: '2024-03-31' })
    db.setBalancePoint(widget, '2024-03-31', 0)
    // Added as closed, with 0 as its value at close.
    const gadget = db.addManualAccount({ name: 'Gadget Co', assetType: 'venture', openedDay: '2022-07-01', closedDay: '2023-12-31', costCents: 1_000_000, points: [{ day: '2022-07-01', cents: 1_000_000 }, { day: '2023-12-31', cents: 0 }] })
    db.updateAccount(gadget, { bucketId: bucket })
    const ids = [txn('2022-05-01', -2_500_000, 'WIRE TO WIDGET CO'), txn('2022-07-01', -1_000_000, 'WIRE TO GADGET CO')]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    assert.deepEqual(
      r.assets.map((a) => [a.name, a.valueCents, a.gainCents, a.sold]),
      [
        ['Widget Co', 0, -2_500_000, true],
        ['Gadget Co', 0, -1_000_000, true]
      ]
    )
    assert.deepEqual(totals(r), [0, 0, 0, 3_500_000, 0, 0, -3_500_000, 0, -3_500_000])
    assert.equal(db.listAssets().find((a) => a.account.id === widget)!.gainCents, -2_500_000)
  })

  test('an investment account in a venture: its gain is its returns, and its own transactions stay out of operating', () => {
    const bucket = db.saveBucket({ name: 'Side fund', kind: 'business' })
    db.upsertAccount({ id: 'csv:brk', source: 'csv', name: 'Brokerage', institution: null, currency: 'USD', balanceCents: 1_000_000, availableCents: null, balanceDate: noonOn(2023, 6, 30) })
    db.updateAccount('csv:brk', { assetType: 'investment', openedDay: '2022-01-03', bucketId: bucket })
    db.setBalancePoint('csv:brk', '2022-01-03', 1_000_000)
    db.setBalancePoint('csv:brk', '2022-12-31', 1_150_000)
    const own = [
      txn('2022-01-03', 1_000_000, 'CONTRIBUTION', { account: 'csv:brk' }),
      txn('2022-06-30', 20_000, 'DIVIDEND RECEIVED', { account: 'csv:brk' }),
      txn('2023-01-03', -200_000, 'WITHDRAWAL', { account: 'csv:brk' })
    ]
    const cash = [
      txn('2021-12-31', -1_000_000, 'TRANSFER TO BROKERAGE', { cat: 'Transfers' }),
      txn('2023-01-03', 200_000, 'TRANSFER FROM BROKERAGE', { cat: 'Transfers' }),
      txn('2023-03-01', -30_000, 'ACCOUNTANT')
    ]
    db.setTransactionsBucket([...own, ...cash], bucket)
    const r = getVenture(bucket).result
    // $10,000 put in, $2,000 taken out, $10,000 left: a $2,000 gain, the dividend inside it.
    assert.deepEqual(r.assets.map((a) => [a.assetType, a.costCents, a.valueCents, a.gainCents, a.gainFrom, a.sold]), [['investment', null, 1_000_000, 200_000, 'returns', false]])
    assert.deepEqual(totals(r), [0, 30_000, -30_000, 0, 0, 0, 0, 200_000, 170_000])
    assert.deepEqual(r.missingCost, [])
  })

  test('an asset with no cost: its gain is unknown, left out of the totals and named', () => {
    const bucket = db.saveBucket({ name: 'Collection', kind: 'other' })
    const painting = db.addManualAccount({ name: 'Painting', assetType: 'other_asset', openedDay: '2021-01-01', points: [{ day: '2021-01-01', cents: 500_000 }, { day: '2025-01-01', cents: 800_000 }] })
    const guitar = db.addManualAccount({ name: 'Guitar', assetType: 'other_asset', openedDay: '2022-01-01', costCents: 200_000, points: [{ day: '2022-01-01', cents: 200_000 }, { day: '2025-01-01', cents: 260_000 }] })
    for (const id of [painting, guitar]) db.updateAccount(id, { bucketId: bucket })
    db.setTransactionsBucket([txn('2023-05-01', -15_000, 'APPRAISAL')], bucket)
    const r = getVenture(bucket).result
    assert.deepEqual(r.assets.map((a) => [a.name, a.costCents, a.valueCents, a.gainCents]), [['Painting', null, 800_000, null], ['Guitar', 200_000, 260_000, 60_000]])
    assert.deepEqual(r.missingCost, ['Painting'])
    assert.deepEqual(totals(r), [0, 15_000, -15_000, 0, 0, 0, 0, 60_000, 45_000])
  })

  test('a venture with no assets is its cash flow', () => {
    const bucket = db.saveBucket({ name: 'Mom', kind: 'person' })
    db.setTransactionsBucket([txn('2024-02-01', -50_000, 'PHARMACY'), txn('2024-03-01', -70_000, 'GROCERIES'), txn('2024-03-15', 20_000, 'PAID BACK')], bucket)
    const d = getVenture(bucket)
    assert.deepEqual(totals(d.result), [20_000, 120_000, -100_000, 0, 0, 0, 0, 0, -100_000])
    assert.deepEqual([d.result.assets, d.result.personalUse, d.result.missingCost], [[], [], []])
    assert.equal(d.result.operatingCents, d.bucket.inCents - d.bucket.outCents)
    assert.deepEqual([d.bucket.operatingCents, d.bucket.gainsCents, d.bucket.totalCents], [-100_000, 0, -100_000])
  })

  test('an asset bought partway through: only its price leaves operating, the revenue and rent around it stay', () => {
    const bucket = db.saveBucket({ name: 'Bakery', kind: 'business' })
    const van = db.addManualAccount({ name: 'Delivery van', assetType: 'vehicle', openedDay: '2023-07-01', costCents: 3_000_000, points: [{ day: '2023-07-01', cents: 3_000_000 }] })
    db.updateAccount(van, { bucketId: bucket })
    const ids = [...monthly('2023-01', '2023-12', 15, 500_000, 'CAFE SALES'), ...monthly('2023-01', '2023-12', 20, -100_000, 'SHOP RENT'), txn('2023-07-01', -3_000_000, 'CITY MOTORS')]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    // Three months of sales and rent fall in the 90 days before the purchase; only the van's $30,000 is taken as buying it.
    assert.deepEqual(totals(r), [6_000_000, 1_200_000, 4_800_000, 3_000_000, 0, 0, 0, 0, 4_800_000])
    assert.equal(r.totalCents, flowSum(ids) + r.assets[0].equityCents)
  })

  test('a sale with income in the week after, and the next asset bought days later: the proceeds are what the sale brought', () => {
    const bucket = db.saveBucket({ name: 'Courier', kind: 'business' })
    const old = db.addManualAccount({ name: 'Old van', assetType: 'vehicle', openedDay: '2021-01-04', closedDay: '2024-06-01', costCents: 2_000_000, points: [{ day: '2021-01-04', cents: 2_000_000 }, { day: '2024-06-01', cents: 1_000_000 }] })
    const next = db.addManualAccount({ name: 'New van', assetType: 'vehicle', openedDay: '2024-06-10', costCents: 4_000_000, points: [{ day: '2024-06-10', cents: 4_000_000 }] })
    for (const id of [old, next]) db.updateAccount(id, { bucketId: bucket })
    const ids = [
      txn('2021-01-04', -2_000_000, 'DEALER'),
      txn('2022-03-01', 900_000, 'CLIENT A'),
      txn('2024-06-01', 1_000_000, 'USED CAR BUYER'),
      txn('2024-06-03', 700_000, 'CLIENT B'),
      txn('2024-06-10', -4_000_000, 'CITY MOTORS')
    ]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    // CLIENT B stays in operating; the sale (in the new van's 90 days too) is its proceeds, not its purchase.
    assert.deepEqual(totals(r), [1_600_000, 0, 1_600_000, 6_000_000, 1_000_000, 0, -1_000_000, 0, 600_000])
    assert.equal(r.totalCents, flowSum(ids) + r.assets.reduce((s, a) => s + (a.sold ? 0 : a.equityCents), 0))
  })

  test('loan payments made as transfers: no principal is added back for them, and money out never goes below zero', () => {
    const bucket = db.saveBucket({ name: 'Food truck', kind: 'business' })
    const truck = db.addManualAccount({ name: 'Taco truck', assetType: 'vehicle', openedDay: '2024-01-02', costCents: 3_000_000, points: [{ day: '2024-01-02', cents: 3_000_000 }] })
    db.updateAccount(truck, { bucketId: bucket })
    db.addManualAccount({ name: 'Truck loan', assetType: 'loan', openedDay: '2024-01-02', linkedAssetId: truck, points: [{ day: '2024-01-02', cents: -2_400_000 }, { day: '2025-01-02', cents: -1_800_000 }] })
    const ids = [txn('2024-01-02', -600_000, 'DOWN PAYMENT'), ...monthly('2024-02', '2024-12', 10, 300_000, 'CATERING')]
    // The bank calls a car payment a transfer: it's in the venture but not its spending.
    for (let m = 2; m <= 12; m++) ids.push(txn(`2024-${String(m).padStart(2, '0')}-05`, -60_000, 'AUTO LOAN PMT', { cat: 'Transfers' }))
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    assert.deepEqual(totals(r), [3_300_000, 0, 3_300_000, 600_000, 0, 0, 0, 0, 3_300_000])
    assert.deepEqual(r.assets.map((a) => [a.owedCents, a.equityCents, a.gainCents]), [[1_800_000, 1_200_000, 0]])
  })

  test('a house bought before the venture\'s records begin: principal counts from its first record', () => {
    const bucket = db.saveBucket({ name: 'Maple St', kind: 'rental' })
    const house = db.addManualAccount({ name: 'Maple house', assetType: 'property', openedDay: '2016-06-01', costCents: 25_000_000, points: [{ day: '2016-06-01', cents: 25_000_000 }] })
    db.updateAccount(house, { bucketId: bucket })
    db.addManualAccount({ name: 'Maple St mortgage', assetType: 'mortgage', openedDay: '2016-06-01', linkedAssetId: house, points: [{ day: '2016-06-01', cents: -20_000_000 }, { day: '2026-01-01', cents: -15_500_000 }, { day: '2026-10-01', cents: -15_400_000 }] })
    const ids = [...monthly('2026-01', '2026-10', 1, -120_000, 'MORTGAGE PMT'), ...monthly('2026-01', '2026-10', 3, 200_000, 'RENT')]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    // Ten payments in the records paid $1,000 of principal; the $45,000 paid before them isn't added back.
    assert.deepEqual(totals(r), [2_000_000, 1_100_000, 900_000, 0, 0, 100_000, 0, 0, 900_000])
  })

  test('money lent: what was lent and what came back of it leave operating; repaid in full is no gain, written off is a loss', () => {
    // Repaid with interest and closed through Add asset with what was paid back.
    const mom = db.saveBucket({ name: 'Mom loan', kind: 'person' })
    const toMom = db.addManualAccount({ name: 'Loan to Mom', assetType: 'receivable', openedDay: '2024-01-02', closedDay: '2024-11-01', costCents: 1_000_000, points: [{ day: '2024-01-02', cents: 1_000_000 }, { day: '2024-11-01', cents: 1_050_000 }] })
    db.updateAccount(toMom, { bucketId: mom })
    const momIds = [txn('2024-01-02', -1_000_000, 'ZELLE TO MOM'), ...monthly('2024-02', '2024-11', 1, 105_000, 'ZELLE FROM MOM'), txn('2024-05-10', -20_000, 'PHARMACY')]
    db.setTransactionsBucket(momIds, mom)
    const m = getVenture(mom).result
    assert.deepEqual([m.inCents, m.outCents, m.operatingCents, m.lentCents, m.repaidCents, m.realizedCents, m.totalCents], [50_000, 20_000, 30_000, 1_000_000, 1_000_000, 0, 30_000])
    assert.deepEqual(m.assets.map((a) => [a.valueCents, a.repaidCents, a.gainCents, a.sold]), [[0, 1_000_000, 0, true]])
    assert.equal(m.totalCents, flowSum(momIds))

    // Partly paid back, still owed falling with each payment, then closed with nothing more coming.
    const dad = db.saveBucket({ name: 'Dad loan', kind: 'person' })
    const toDad = db.addManualAccount({ name: 'Loan to Dad', assetType: 'receivable', openedDay: '2024-03-01', closedDay: '2024-12-31', costCents: 800_000, points: [{ day: '2024-03-01', cents: 800_000 }, { day: '2024-04-01', cents: 600_000 }, { day: '2024-05-01', cents: 400_000 }, { day: '2024-12-31', cents: 0 }] })
    db.updateAccount(toDad, { bucketId: dad })
    const dadIds = [txn('2024-03-01', -800_000, 'ZELLE TO DAD'), txn('2024-04-01', 200_000, 'ZELLE FROM DAD'), txn('2024-05-01', 200_000, 'ZELLE FROM DAD')]
    db.setTransactionsBucket(dadIds, dad)
    const d = getVenture(dad).result
    assert.deepEqual([d.operatingCents, d.lentCents, d.repaidCents, d.realizedCents, d.totalCents], [0, 800_000, 400_000, -400_000, -400_000])
    assert.equal(d.totalCents, flowSum(dadIds))

    // Half still owed, with costs before it was lent that stay in operating.
    const sis = db.saveBucket({ name: 'Sis loan', kind: 'person' })
    const toSis = db.addManualAccount({ name: 'Loan to Sis', assetType: 'receivable', openedDay: '2025-03-01', costCents: 1_000_000, points: [{ day: '2025-03-01', cents: 1_000_000 }, { day: '2025-09-01', cents: 500_000 }] })
    db.updateAccount(toSis, { bucketId: sis })
    const sisIds = [txn('2025-01-15', -100_000, 'PHARMACY'), txn('2025-03-01', -1_000_000, 'ZELLE TO SIS'), txn('2025-06-01', 250_000, 'ZELLE FROM SIS'), txn('2025-09-01', 250_000, 'ZELLE FROM SIS')]
    db.setTransactionsBucket(sisIds, sis)
    const s = getVenture(sis).result
    assert.deepEqual([s.inCents, s.outCents, s.operatingCents, s.lentCents, s.repaidCents, s.onPaperCents, s.totalCents], [0, 100_000, -100_000, 1_000_000, 500_000, 0, -100_000])
    assert.deepEqual(s.assets.map((a) => [a.valueCents, a.repaidCents, a.gainCents, a.sold]), [[500_000, 500_000, 0, false]])
    // What's still owed is held: the total is the cash plus it.
    assert.equal(s.totalCents, flowSum(sisIds) + 500_000)
  })

  test('money moved between the venture\'s checking and its brokerage is neither income nor spending; a bill paid from the brokerage is', () => {
    const bucket = db.saveBucket({ name: 'Reserve fund', kind: 'business' })
    db.upsertAccount({ id: 'csv:brk2', source: 'csv', name: 'Reserve brokerage', institution: null, currency: 'USD', balanceCents: 1_350_000, availableCents: null, balanceDate: noonOn(2024, 12, 31) })
    db.updateAccount('csv:brk2', { assetType: 'investment', openedDay: '2023-01-03', bucketId: bucket })
    db.setBalancePoint('csv:brk2', '2023-01-03', 1_000_000)
    db.setBalancePoint('csv:brk2', '2023-12-31', 1_600_000)
    db.setBalancePoint('csv:brk2', '2024-12-31', 1_350_000)
    // None of these are categorized (a CSV import without the assistant): the two sides pair up by day and amount.
    const ids = [
      txn('2023-01-03', -1_000_000, 'ONLINE TRANSFER TO BROKERAGE'),
      txn('2023-01-03', 1_000_000, 'DEPOSIT', { account: 'csv:brk2' }),
      txn('2023-09-01', -500_000, 'ONLINE TRANSFER TO BROKERAGE'),
      txn('2023-09-02', 500_000, 'DEPOSIT', { account: 'csv:brk2' }),
      txn('2024-02-01', -300_000, 'WITHDRAWAL', { account: 'csv:brk2' }),
      txn('2024-02-02', 300_000, 'FROM BROKERAGE'),
      txn('2024-03-01', -50_000, 'ACH PAYMENT COUNTY TAX', { account: 'csv:brk2' })
    ]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    // $15,000 put in, $3,500 taken out (the tax among it), $13,500 left: a $2,000 gain.
    assert.deepEqual(r.assets.map((a) => [a.valueCents, a.gainCents, a.gainFrom]), [[1_350_000, 200_000, 'returns']])
    assert.deepEqual(totals(r), [0, 50_000, -50_000, 0, 0, 0, 0, 200_000, 150_000])
  })

  test('an asset with no cost: what bought it and its loan\'s principal still leave operating, and the total goes without its gain', () => {
    const bucket = db.saveBucket({ name: 'Lake cabin', kind: 'rental' })
    const cabin = db.addManualAccount({ name: 'Cabin', assetType: 'property', openedDay: '2024-01-02', points: [{ day: '2024-01-02', cents: 30_000_000 }] })
    db.updateAccount(cabin, { bucketId: bucket })
    db.addManualAccount({ name: 'Cabin mortgage', assetType: 'mortgage', openedDay: '2024-01-02', linkedAssetId: cabin, points: [{ day: '2024-01-02', cents: -24_000_000 }, { day: '2025-01-02', cents: -23_400_000 }] })
    const ids = [txn('2023-12-15', -50_000, 'INSPECTION'), txn('2024-01-02', -6_000_000, 'TITLE CO'), ...monthly('2024-02', '2024-12', 1, -150_000, 'MORTGAGE PMT'), ...monthly('2024-02', '2024-12', 3, 200_000, 'RENT')]
    db.setTransactionsBucket(ids, bucket)
    const r = getVenture(bucket).result
    assert.deepEqual(totals(r), [2_200_000, 1_050_000, 1_150_000, 6_050_000, 0, 600_000, 0, 0, 1_150_000])
    assert.deepEqual([r.assets[0].gainCents, r.missingCost], [null, ['Cabin']])
  })

  test('the list carries each venture\'s operating, gains and total, as its own page does', () => {
    const list = listVentures()
    assert.equal(list.length, 16)
    for (const b of list) {
      const { bucket, result } = getVenture(b.id)
      assert.deepEqual(b, bucket, b.name)
      assert.deepEqual([b.operatingCents, b.gainsCents, b.totalCents], [result.operatingCents, result.realizedCents + result.onPaperCents, result.totalCents], b.name)
    }
    // The cash flow is the database's, untouched.
    const cash = db.listBuckets()
    assert.deepEqual(list.map((b) => [b.id, b.inCents, b.outCents, b.txnCount]), cash.map((b) => [b.id, b.inCents, b.outCents, b.txnCount]))
  })

  test('the assistant sees the same result', () => {
    const listed = (runAssistantTool('list_buckets', {}).result as Array<{ name: string; money_in: number; operating: number; gains: number; total: number }>).find((b) => b.name === 'Oak Ave')!
    const oak = listVentures().find((b) => b.name === 'Oak Ave')!
    assert.deepEqual([listed.money_in, listed.operating, listed.gains, listed.total], [oak.inCents / 100, oak.operatingCents / 100, oak.gainsCents / 100, oak.totalCents / 100])
    const summary = runAssistantTool('bucket_summary', { bucket: 'Seed bets' }).result as { result: { left_out_of_operating: { purchase: number }; equity_paid_down: number; assets: Array<{ name: string; sale_price?: number; gain: number | null; realized: boolean }>; gains: { realized: number; on_paper: number }; total: number } }
    assert.deepEqual(summary.result.assets.map((a) => [a.name, a.sale_price, a.gain, a.realized]), [['Widget Co', 0, -25_000, true], ['Gadget Co', 0, -10_000, true]])
    assert.deepEqual([summary.result.left_out_of_operating.purchase, summary.result.equity_paid_down, summary.result.gains, summary.result.total], [35_000, 0, { realized: -35_000, on_paper: 0 }, -35_000])
    const fund = runAssistantTool('bucket_summary', { bucket: 'Collection' }).result as { result: { missing_cost: string[] } }
    assert.deepEqual(fund.result.missing_cost, ['Painting'])
    const lent = runAssistantTool('bucket_summary', { bucket: 'Sis loan' }).result as { result: { left_out_of_operating: { lent: number; paid_back: number }; assets: Array<{ still_owed: number; paid_back: number; gain: number }> } }
    assert.deepEqual([lent.result.left_out_of_operating.lent, lent.result.left_out_of_operating.paid_back], [10_000, 5_000])
    assert.deepEqual(lent.result.assets.map((a) => [a.still_owed, a.paid_back, a.gain]), [[5_000, 5_000, 0]])
  })
})
