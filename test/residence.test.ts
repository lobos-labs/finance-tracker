import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { getSummary } from '../src/main/summary.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, residences } from '../src/main/lines.ts'
import { detectRecurring } from '../src/main/recurring.ts'
import { openIssues, runAssistantTool, runTool } from '../src/main/tools.ts'
import { listUses } from '../src/main/uses.ts'
import { getVenture, listVentures } from '../src/main/ventures.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { ClassifiedLine } from '../src/shared/types.ts'
import { bayview } from './fixtures/bayview.ts'
import { ELM_MONTHS, elmSt } from './fixtures/elm.ts'
import { noonOn } from './days.ts'

// Residence dates become Personal's use of a house (waterfall spec, section 3 and sub-phase 3b). A venture's
// residence dates said when one of its places was the user's home, and its costs then counted as Personal's.
// Migration 41 turns them into a use of 100% Personal on the house over those days and puts the costs on it, so
// the classifier says the same of every line and Personal's totals don't move, while the venture's books stop
// counting what Personal does: Personal's part is its Personal use.

configureLicense({ dev: true })

const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const sum = (lines: ClassifiedLine[]): number => lines.reduce((s, l) => s + l.cents, 0)

/** Personal's total in a month as its totals read it since sub-phase 2g: its lines in the classifier, signed. */
const personalTotal = (month: string): number => sum(classifyLines(`${month}-01`, lastDay(month)).filter((l) => l.owner === null))

/**
 * What the classifier and Personal's totals say of each month: every line (without the asset it's a cost of, which
 * the conversion adds), Personal's sum, and the month's summary (the Dashboard's and month_summary's, which read the
 * classifier); and the Personal series with their owners and shares.
 */
function picture(months: string[]): unknown {
  return {
    months: months.map((m) => {
      const lines = classifyLines(`${m}-01`, lastDay(m))
      return { month: m, lines: lines.map(({ assetId: _asset, ...l }) => l), personal: sum(lines.filter((l) => l.owner === null)), summary: getSummary(m) }
    }),
    series: detectRecurring({ scope: 'all' }).map((s) => [s.key, s.owner, s.personalBp])
  }
}

/** A settled line on Personal checking, in a category and with a merchant when given. */
let n = 0
function txn(day: string, cents: number, description: string, cat?: string, merchant?: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const id = `r${++n}`
  db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  const categoryId = cat ? db.listCategories().find((c) => c.name === cat)!.id : undefined
  if (categoryId !== undefined || merchant) db.setTransactionFields(id, { ...(categoryId !== undefined ? { categoryId, source: 'user' as const } : {}), ...(merchant ? { merchant } : {}) })
  return id
}
const checking = (): void => {
  db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.updateAccount('csv:chk', { assetType: 'cash' })
  txn('2024-01-02', 5_000_000, 'OPENING DEPOSIT')
}
const house = (name: string, openedDay: string): string => db.addManualAccount({ name, assetType: 'property', openedDay, costCents: 30_000_000, points: [{ day: openedDay, cents: 30_000_000 }] })
const uses = (assetId: string): unknown[] => listUses(assetId).map(({ id: _id, assetId: _a, ...u }) => u)
const shareIssues = (): string[] => openIssues().filter((i) => i.kind === 'share_estimate').map((i) => i.key)
const partsOf = (id: string, month: string): Array<[number | null, string, string, number]> =>
  classifyLines(`${month}-01`, lastDay(month))
    .filter((l) => l.txnId === id)
    .map((l): [number | null, string, string, number] => [l.owner, l.key.slice(id.length), l.cls, l.cents])

describe('the Elm St house, lived in and then rented out', () => {
  afterEach(db.closeDb)

  test('its residence dates become Personal’s use of the house, and every month’s lines and Personal totals stay as they were', () => {
    db.openDb(':memory:')
    const elm = elmSt()
    const before = picture(ELM_MONTHS)
    assert.equal(db.convertResidences(), 1)
    assert.equal(db.convertResidences(), 0)
    // A use of 100% Personal over the residence dates, migrated and not measured.
    assert.deepEqual(uses(elm.house), [{ fromDay: '2020-06-01', toDay: '2021-06-30', bucketId: null, shareBp: 10_000, basis: null, source: 'migrated' }])
    assert.deepEqual(residences(), new Map())
    // The 24 costs in those dates are on the house, put there by the migration; the rent, the later costs and the groceries aren't.
    const inside = [...elm.ids.get('MORTGAGE PMT')!.slice(0, 12), ...elm.ids.get('CITY UTILITIES')!].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    assert.deepEqual(
      db.all<{ id: string }>("SELECT id FROM transactions WHERE asset_id = ? AND asset_source = 'migrated'", elm.house).map((r) => r.id).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))),
      inside
    )
    assert.deepEqual(picture(ELM_MONTHS), before)
    const lines = classifyLines('2020-01-01', '2023-12-31')
    assert.ok(lines.filter((l) => inside.includes(l.txnId)).every((l) => l.owner === null && l.assetId === elm.house && l.shareBp === 10_000))
    assert.ok(lines.filter((l) => !inside.includes(l.txnId)).every((l) => l.assetId === null))
  })

  test('its result loses the double count: operating leaves out Personal’s 20,400.00, its Personal use, and with it is the 9,700.00 it was', () => {
    db.openDb(':memory:')
    const elm = elmSt()
    const figures = (): number[] => {
      const r = getVenture(elm.bucket).result
      return [r.inCents, r.outCents, r.operatingCents, r.purchaseCents, r.proceedsCents, r.principalCents, r.realizedCents, r.totalCents]
    }
    // Before 3b the venture counted all 33 mortgage payments and the 12 utility bills, and Personal counted the
    // 24 in the residence dates as well: in 47,800.00, out 38,100.00, operating 9,700.00, total 42,700.00.
    const want = [4_780_000, 3_810_000 - 2_040_000, 970_000 + 2_040_000, 7_500_000, 12_050_000, 1_500_000, 3_300_000, 4_270_000 + 2_040_000]
    // The dates themselves, before they're converted, already keep those costs out.
    assert.deepEqual(figures(), want)
    assert.deepEqual(getVenture(elm.bucket).result.personalUse, [{ assetId: null, fromDay: '2020-06-01', toDay: '2021-06-30', personalBp: 10_000, cents: -2_040_000 }])
    db.convertResidences()
    const r = getVenture(elm.bucket).result
    assert.deepEqual(figures(), want)
    assert.deepEqual(r.personalUse, [{ assetId: elm.house, fromDay: '2020-06-01', toDay: '2021-06-30', personalBp: 10_000, cents: -2_040_000 }])
    // Operating plus Personal use is the operating the venture had bearing those costs whole.
    assert.equal(r.operatingCents + r.personalUse.reduce((s, u) => s + u.cents, 0), 970_000)
    // Personal use is exactly the lines the classifier gives Personal in those dates.
    const personal = classifyLines('2020-06-01', '2021-06-30').filter((l) => l.owner === null && l.assetId === elm.house)
    assert.equal(sum(personal), -2_040_000)
    // Review sees the same.
    const summary = runAssistantTool('bucket_summary', { bucket: 'Elm St' }).result as { result: { operating: { net: number }; personal_use: unknown[] } }
    assert.deepEqual([summary.result.operating.net, summary.result.personal_use], [30_100, [{ asset: 'Elm house', from: '2020-06-01', to: '2021-06-30', personal_pct: 100, net: -20_400 }]])
  })

  test('migration 41 converts a database at step 40 the same way, and raises one share_estimate for the house', () => {
    db.openDb(':memory:')
    elmSt()
    db.convertResidences()
    const want = picture(ELM_MONTHS)
    db.closeDb()

    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 40 })
    const elm = elmSt()
    db.migrate()
    assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
    assert.deepEqual(db.get('SELECT residence_from, residence_to, residence_converted FROM buckets WHERE id = ?', elm.bucket), { residence_from: '2020-06-01', residence_to: '2021-06-30', residence_converted: 1 })
    assert.deepEqual(uses(elm.house), [{ fromDay: '2020-06-01', toDay: '2021-06-30', bucketId: null, shareBp: 10_000, basis: null, source: 'migrated' }])
    assert.deepEqual(picture(ELM_MONTHS), want)
    assert.deepEqual(shareIssues(), [`share_estimate:${elm.house}`])
    // Measured by rooms, the issue goes; undone, the migrated use and the issue come back.
    const migrated = uses(elm.house)
    const r = runTool('set_asset_use', { asset_id: elm.house, uses: [{ owner: 'Personal', share_pct: 100, from: '2020-06-01', to: '2021-06-30', basis: 'rooms' }] }, 'assistant')
    assert.deepEqual(shareIssues(), [])
    const c = db.getChange(r.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    assert.deepEqual(uses(elm.house), migrated)
    assert.deepEqual(shareIssues(), [`share_estimate:${elm.house}`])
    // Settled by Review instead, it doesn't come up again.
    runTool('resolve_issue', { issue_key: `share_estimate:${elm.house}` }, 'assistant')
    assert.deepEqual(shareIssues(), [])
  })
})

describe('the sample household', () => {
  afterEach(db.closeDb)

  const months = (): string[] => {
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    const out: string[] = []
    for (let m = first; m <= db.today().slice(0, 7); m = shiftMonth(m, 1)) out.push(m)
    return out
  }

  test('has no residence dates: nothing converts, and every month and the Ventures page are as they were', () => {
    db.openDb(':memory:')
    loadDemoData()
    const before = picture(months())
    const ventures = listVentures()
    assert.equal(db.convertResidences(), 0)
    assert.deepEqual(picture(months()), before)
    assert.deepEqual(listVentures(), ventures)
    const condo = ventures.find((b) => b.name === 'Bayview Condo')!
    assert.deepEqual(getVenture(condo.id).result.personalUse, [])
    assert.deepEqual(shareIssues(), [])
  })

  test('with the condo lived in for the last four months, its costs on Rental Checking stay Personal’s, by use, line for line', () => {
    db.openDb(':memory:')
    loadDemoData()
    const condo = listVentures().find((b) => b.name === 'Bayview Condo')!
    const from = `${shiftMonth(db.today().slice(0, 7), -4)}-01`
    db.saveBucket({ id: condo.id, name: condo.name, kind: condo.kind, residenceFrom: from, residenceTo: null })
    // The condo's costs in those months: its dues, mortgage and repairs, paid from Rental Checking.
    const costs = db
      .all<{ id: string }>(
        `SELECT t.id FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.bucket_id = ? AND date(${db.localSql('t.posted')}) >= ? AND (c.kind IS NULL OR c.kind <> 'income')`,
        condo.id,
        from
      )
      .map((r) => r.id)
    const ofCosts = (): ClassifiedLine[] => classifyLines(from, db.today()).filter((l) => costs.includes(l.txnId))
    // They're Personal's in those months, and in the ledger, though the account is the venture's.
    assert.ok(costs.length >= 8, `${costs.length} costs`)
    assert.ok(ofCosts().every((l) => l.owner === null && !l.perimeter))
    const before = picture(months())
    const result = getVenture(condo.id).result
    assert.equal(db.convertResidences(), 1)
    assert.deepEqual(picture(months()), before)
    const condoHouse = db.listAccounts().find((a) => a.bucketId === condo.id && a.assetType === 'property')!
    assert.ok(ofCosts().every((l) => l.owner === null && l.assetId === condoHouse.id))
    // The venture's books are the same too, its Personal use now on the condo.
    const after = getVenture(condo.id).result
    assert.deepEqual({ ...after, personalUse: after.personalUse.map((u) => ({ ...u, assetId: null })) }, result)
    assert.deepEqual(after.personalUse.map((u) => [u.assetId, u.fromDay, u.toDay, u.personalBp]), [[condoHouse.id, from, db.today(), 10_000]])
    assert.ok(after.personalUse[0].cents < 0)
    // Its operating no longer holds the Personal housing: with it, it's the cash flow with the principal added back,
    // as the demo's condo always was.
    const cash = db.listBuckets().find((b) => b.id === condo.id)!
    assert.equal(after.operatingCents + after.personalUse[0].cents, cash.inCents - cash.outCents + after.principalCents)
    assert.deepEqual(shareIssues(), [`share_estimate:${condoHouse.id}`])
  })
})

describe('converting other residences', () => {
  afterEach(db.closeDb)

  test('a payment on the venture’s own mortgage, placed there by hand, is still split: interest and escrow Personal’s, principal the venture’s', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Ash Row', kind: 'rental', residenceFrom: '2025-06-01', residenceTo: '2025-09-30' })
    const home = house('Ash house', '2024-01-15')
    db.updateAccount(home, { bucketId: bucket })
    const loan = db.addManualAccount({ name: 'Ash Lending', assetType: 'mortgage', linkedAssetId: home, points: [{ day: '2025-07-31', cents: -20_000_000 }, { day: '2025-08-31', cents: -19_920_000 }, { day: '2025-10-31', cents: -19_840_000 }] })
    const inside = txn('2025-08-15', -200_000, 'ASH LENDING PMT', 'Housing', 'Ash Lending')
    const outside = txn('2025-10-15', -200_000, 'ASH LENDING PMT', 'Housing', 'Ash Lending')
    db.setTransactionsBucket([inside, outside], bucket)
    runTool('link_loan_payment', { account_id: loan, transaction_id: inside }, 'assistant')
    const want: Array<[number | null, string, string, number]> = [
      [null, '::p:int', 'debtCost', -120_000],
      [bucket, `::${bucket}:prin`, 'venture', -80_000]
    ]
    assert.deepEqual(partsOf(inside, '2025-08'), want)
    db.convertResidences()
    assert.deepEqual(partsOf(inside, '2025-08'), want)
    assert.deepEqual(partsOf(outside, '2025-10'), [[bucket, `::${bucket}`, 'venture', -200_000]])
    assert.deepEqual(db.get('SELECT asset_id, asset_source FROM transactions WHERE id = ?', inside), { asset_id: home, asset_source: 'migrated' })
  })

  test('a payment on the house’s loan left in Personal was money to the venture by the dates, which named only what was placed in it; by the use it’s shared too, interest and escrow Personal’s and principal the venture’s', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Hazel Rental', kind: 'rental', residenceFrom: '2025-06-01', residenceTo: '2025-09-30' })
    const home = house('Hazel house', '2024-01-15')
    db.updateAccount(home, { bucketId: bucket })
    const loan = db.addManualAccount({ name: 'Hazel Lending', assetType: 'mortgage', linkedAssetId: home, points: [{ day: '2025-07-31', cents: -20_000_000 }, { day: '2025-08-31', cents: -19_920_000 }] })
    const pay = txn('2025-08-15', -200_000, 'HAZEL LENDING PMT', 'Housing', 'Hazel Lending')
    runTool('link_loan_payment', { account_id: loan, transaction_id: pay }, 'assistant')
    // The venture's own dues, before the user moved in.
    db.setTransactionsBucket([txn('2025-05-05', -30_000, 'HAZEL HOA', 'Housing', 'Hazel HOA')], bucket)
    assert.deepEqual(partsOf(pay, '2025-08'), [[null, '::p', 'venture', -200_000]])
    db.convertResidences()
    // Nothing placed it, so the migration doesn't put it on the house: its loan does.
    assert.deepEqual(db.get('SELECT asset_id, asset_source FROM transactions WHERE id = ?', pay), { asset_id: null, asset_source: null })
    assert.deepEqual(partsOf(pay, '2025-08'), [
      [null, '::p:int', 'debtCost', -120_000],
      [bucket, `::${bucket}:prin`, 'venture', -80_000]
    ])
    // Personal's totals read the classifier: its interest and escrow are Personal's spending, and the principal is the
    // venture's. The transactions list's Personal filter, in SQL, still lists the payment whole: it's in no venture.
    assert.equal(personalTotal('2025-08'), -120_000)
    assert.equal(getSummary('2025-08').spendCents, 120_000)
    assert.equal(db.listTransactions({ bucketId: 'personal', search: 'HAZEL LENDING' }).sumCents, -200_000)
    // The venture's books gain its principal, paid down on its own loan and added back, and Personal's interest is its
    // Personal use: operating is its dues alone.
    const r = getVenture(bucket).result
    assert.deepEqual([r.inCents, r.outCents, r.principalCents, r.operatingCents, r.personalUse.map((u) => [u.assetId, u.cents])], [0, 30_000, 80_000, -30_000, [[home, -120_000]]])
  })

  test('money moved into the venture’s own account while the user lived there was Personal’s by the dates; once they’re a use it’s the venture’s, as the transfer that sent it already was', () => {
    db.openDb(':memory:')
    checking()
    db.upsertAccount({ id: 'csv:fern', source: 'csv', name: 'Fern Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:fern', { assetType: 'cash' })
    const bucket = db.saveBucket({ name: 'Fern Rental', kind: 'rental', residenceFrom: '2025-01-01', residenceTo: '2025-12-31' })
    const home = house('Fern house', '2024-01-15')
    for (const id of [home, 'csv:fern']) db.updateAccount(id, { bucketId: bucket })
    /** A settled line on Fern Checking, in a category. */
    const fern = (id: string, day: string, cents: number, description: string, cat: string): string => {
      const [y, m, d] = day.split('-').map(Number)
      db.upsertTransaction({ id, accountId: 'csv:fern', posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
      db.setTransactionFields(id, { categoryId: db.listCategories().find((c) => c.name === cat)!.id, source: 'user' })
      return id
    }
    const sent = txn('2025-04-10', -15_000, 'TRANSFER TO FERN', 'Transfers')
    const landed = fern('fern1', '2025-04-10', 15_000, 'TRANSFER FROM CHECKING', 'Transfers')
    const power = fern('fern2', '2025-04-12', -15_000, 'CITY POWER', 'Utilities')
    db.applyBucketRules()
    const april = (): unknown => classifyLines('2025-04-01', '2025-04-30').map((l) => [l.txnId, l.owner, l.cls, l.cents])
    // By the dates both lines on Fern Checking are Personal's, money the user put in its account and a cost of theirs
    // it paid, the same amount two days apart: two fundings, which no transfer settles, so neither is a reimbursement
    // (sub-phase 1j, I5).
    assert.deepEqual(april(), [
      [landed, null, 'internal', 15_000],
      [sent, null, 'venture', -15_000],
      [power, null, 'everyday', -15_000]
    ])
    db.convertResidences()
    // The bill Fern Checking paid is still Personal's, by the use; the money that paid it is the venture's, so the
    // transfer is venture money on both of its legs.
    assert.deepEqual(april(), [
      [sent, null, 'venture', -15_000],
      [power, null, 'everyday', -15_000]
    ])
    assert.deepEqual(db.get('SELECT asset_id FROM transactions WHERE id = ?', landed), { asset_id: null })
  })

  test('with two houses, a loan payment goes on its loan’s house and any other cost on the first; each gets the use and its own share_estimate', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Two Doors', kind: 'rental', residenceFrom: '2025-03-01', residenceTo: '2025-08-31' })
    const front = house('Front house', '2024-01-10')
    const back = house('Back cottage', '2024-06-01')
    for (const id of [back, front]) db.updateAccount(id, { bucketId: bucket })
    const loan = db.addManualAccount({ name: 'Cottage Lending', assetType: 'mortgage', linkedAssetId: back, points: [{ day: '2025-04-30', cents: -9_000_000 }, { day: '2025-05-31', cents: -8_960_000 }] })
    const pay = txn('2025-05-01', -60_000, 'COTTAGE LENDING PMT', 'Housing', 'Cottage Lending')
    const power = txn('2025-05-14', -15_000, 'CITY POWER', 'Utilities', 'City Power')
    const later = txn('2025-09-14', -15_000, 'CITY POWER', 'Utilities', 'City Power')
    db.setTransactionsBucket([pay, power, later], bucket)
    runTool('link_loan_payment', { account_id: loan, transaction_id: pay }, 'assistant')
    const before = [partsOf(pay, '2025-05'), partsOf(power, '2025-05'), partsOf(later, '2025-09')]
    assert.deepEqual(before, [
      [
        [null, '::p:int', 'debtCost', -20_000],
        [bucket, `::${bucket}:prin`, 'venture', -40_000]
      ],
      [[null, '::p', 'everyday', -15_000]],
      [[bucket, `::${bucket}`, 'venture', -15_000]]
    ])
    db.convertResidences()
    assert.deepEqual([partsOf(pay, '2025-05'), partsOf(power, '2025-05'), partsOf(later, '2025-09')], before)
    const on = (id: string): unknown => db.get<{ asset_id: string | null }>('SELECT asset_id FROM transactions WHERE id = ?', id)!.asset_id
    assert.deepEqual([on(pay), on(power), on(later)], [back, front, null])
    const span = [{ fromDay: '2025-03-01', toDay: '2025-08-31', bucketId: null, shareBp: 10_000, basis: null, source: 'migrated' }]
    assert.deepEqual([uses(front), uses(back)], [span, span])
    assert.deepEqual(shareIssues().sort(), [`share_estimate:${back}`, `share_estimate:${front}`].sort())
  })

  test('a house the venture sold before the residence was never the home then: the costs and the use go on the one it held', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Linden Rental', kind: 'rental', residenceFrom: '2025-03-01', residenceTo: '2025-08-31' })
    const sold = db.addManualAccount({ name: 'Old house', assetType: 'property', openedDay: '2018-01-01', closedDay: '2023-06-30', costCents: 20_000_000, points: [{ day: '2018-01-01', cents: 20_000_000 }] })
    const home = house('New house', '2024-02-01')
    const later = house('Corner lot', '2025-10-01')
    for (const id of [sold, home, later]) db.updateAccount(id, { bucketId: bucket })
    const power = txn('2025-05-14', -15_000, 'CITY POWER', 'Utilities', 'City Power')
    db.setTransactionsBucket([power], bucket)
    assert.deepEqual(partsOf(power, '2025-05'), [[null, '::p', 'everyday', -15_000]])
    db.convertResidences()
    assert.deepEqual(partsOf(power, '2025-05'), [[null, '::p', 'everyday', -15_000]])
    assert.deepEqual(db.get('SELECT asset_id, asset_source FROM transactions WHERE id = ?', power), { asset_id: home, asset_source: 'migrated' })
    assert.deepEqual([uses(sold), uses(home), uses(later)], [[], [{ fromDay: '2025-03-01', toDay: '2025-08-31', bucketId: null, shareBp: 10_000, basis: null, source: 'migrated' }], []])
    assert.deepEqual(shareIssues(), [`share_estimate:${home}`])
    assert.deepEqual(getVenture(bucket).result.personalUse, [{ assetId: home, fromDay: '2025-03-01', toDay: '2025-08-31', personalBp: 10_000, cents: -15_000 }])
  })

  test('a use already set on the house keeps its days; the residence becomes Personal’s use only of the days before it', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Garden Flat', kind: 'rental', residenceFrom: '2025-01-01', residenceTo: null })
    const home = house('Garden house', '2024-03-01')
    db.updateAccount(home, { bucketId: bucket })
    runTool('set_asset_use', { asset_id: home, uses: [{ owner: 'Garden Flat', share_pct: 60, from: '2025-07-01', basis: 'rooms' }, { owner: 'Personal', share_pct: 40, from: '2025-07-01', basis: 'rooms' }] }, 'assistant')
    db.convertResidences()
    assert.deepEqual(uses(home), [
      { fromDay: '2025-01-01', toDay: '2025-06-30', bucketId: null, shareBp: 10_000, basis: null, source: 'migrated' },
      { fromDay: '2025-07-01', toDay: null, bucketId: bucket, shareBp: 6_000, basis: 'rooms', source: 'review' },
      { fromDay: '2025-07-01', toDay: null, bucketId: null, shareBp: 4_000, basis: 'rooms', source: 'review' }
    ])
  })

  test('a venture with no house keeps its dates, asks once for the house, and converts the next time the books open after it gets one', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Maple Duplex', kind: 'rental', residenceFrom: '2026-01-01', residenceTo: null })
    const water = txn('2026-03-12', -9_000, 'CITY WATER', 'Utilities', 'City Water')
    db.setTransactionsBucket([water], bucket)
    assert.equal(db.convertResidences(), 0)
    assert.deepEqual(partsOf(water, '2026-03'), [[null, '::p', 'everyday', -9_000]])
    assert.deepEqual(shareIssues(), [`share_estimate:venture:${bucket}`])
    // Its Personal use is the dates' costs, out of its operating.
    assert.deepEqual(getVenture(bucket).result.personalUse, [{ assetId: null, fromDay: '2026-01-01', toDay: db.today(), personalBp: 10_000, cents: -9_000 }])
    assert.equal(getVenture(bucket).result.operatingCents, 0)
    const home = house('Maple house', '2025-11-01')
    db.updateAccount(home, { bucketId: bucket })
    // Until the books open again the dates still say it: nothing moves in between.
    assert.ok(residences().has(bucket))
    assert.deepEqual(partsOf(water, '2026-03'), [[null, '::p', 'everyday', -9_000]])
    db.migrate()
    assert.ok(!residences().has(bucket))
    assert.deepEqual(uses(home), [{ fromDay: '2026-01-01', toDay: null, bucketId: null, shareBp: 10_000, basis: null, source: 'migrated' }])
    assert.deepEqual(partsOf(water, '2026-03'), [[null, '::p', 'everyday', -9_000]])
    assert.deepEqual(shareIssues(), [`share_estimate:${home}`])
  })

  test('a cost a hand put on its second house stays there, and that house gets the use too', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Pine Court', kind: 'rental', residenceFrom: '2025-03-01', residenceTo: '2025-08-31' })
    const main = house('Main house', '2024-01-10')
    const annex = house('Annex', '2024-06-01')
    for (const id of [main, annex]) db.updateAccount(id, { bucketId: bucket })
    const roof = txn('2025-05-20', -50_000, 'ANNEX ROOF', 'Housing', 'Roof Co')
    db.setTransactionsBucket([roof], bucket)
    db.setTransactionsAsset([roof], annex, 'user')
    assert.deepEqual(partsOf(roof, '2025-05'), [[null, '::p', 'everyday', -50_000]])
    db.convertResidences()
    assert.deepEqual(partsOf(roof, '2025-05'), [[null, '::p', 'everyday', -50_000]])
    assert.deepEqual(db.get('SELECT asset_id, asset_source FROM transactions WHERE id = ?', roof), { asset_id: annex, asset_source: 'user' })
    const span = [{ fromDay: '2025-03-01', toDay: '2025-08-31', bucketId: null, shareBp: 10_000, basis: null, source: 'migrated' }]
    assert.deepEqual([uses(main), uses(annex)], [span, span])
  })

  test('a payment split half to the venture of its own is all Personal’s by the residence dates, and half the venture’s once they are a use, as a split part keeps its owner', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Birch Duplex', kind: 'rental', residenceFrom: '2025-01-01', residenceTo: '2025-12-31' })
    const home = house('Birch house', '2024-06-01')
    db.updateAccount(home, { bucketId: bucket })
    const pay = txn('2025-04-01', -200_000, 'BIRCH LENDING PMT', 'Housing', 'Birch Lending')
    const cat = db.getTransaction(pay)!.categoryId
    const [own, follows] = db.splitTransaction(pay, [
      { amountCents: -100_000, categoryId: cat, bucketId: bucket },
      { amountCents: -100_000, categoryId: cat }
    ])
    const owners = (): Array<[number | null, number | null, number]> =>
      classifyLines('2025-04-01', '2025-04-30')
        .filter((l) => l.txnId === pay)
        .map((l): [number | null, number | null, number] => [l.splitId, l.owner, l.cents])
    assert.deepEqual(owners(), [
      [own.id, null, -100_000],
      [follows.id, null, -100_000]
    ])
    assert.equal(personalTotal('2025-04'), -200_000)
    db.convertResidences()
    // The venture's half is the venture's, in the classifier, in Personal's totals and in its operating.
    assert.deepEqual(owners(), [
      [own.id, bucket, -100_000],
      [follows.id, null, -100_000]
    ])
    assert.equal(personalTotal('2025-04'), -100_000)
    assert.equal(getVenture(bucket).result.operatingCents, -100_000)
  })

  test('later in a residence it converted, a cost its rules put in the venture is Personal’s by the use and one placed there by hand the venture’s, in the classifier, Personal’s totals and its books alike', () => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Cedar Loft', kind: 'rental', residenceFrom: '2026-01-01', residenceTo: null })
    const home = house('Cedar house', '2025-06-01')
    db.updateAccount(home, { bucketId: bucket })
    db.convertResidences()
    const power = txn('2026-03-14', -15_000, 'CITY POWER', 'Utilities', 'City Power')
    db.addBucketRule({ bucketId: bucket, contains: 'CITY POWER' })
    db.applyBucketRules()
    const fee = txn('2026-03-20', -40_000, 'LISTING FEE', 'Housing', 'Listing Co')
    db.setTransactionsBucket([fee], bucket)
    assert.deepEqual(partsOf(power, '2026-03'), [[null, '::p', 'everyday', -15_000]])
    assert.deepEqual(partsOf(fee, '2026-03'), [[bucket, `::${bucket}`, 'venture', -40_000]])
    // Each counts once: the bill in Personal's totals and its Personal use, the fee in the venture's operating.
    assert.equal(personalTotal('2026-03'), -15_000)
    assert.equal(getSummary('2026-03').spendCents, 15_000)
    const r = getVenture(bucket).result
    assert.equal(r.operatingCents, -40_000)
    assert.deepEqual(r.personalUse, [{ assetId: home, fromDay: '2026-01-01', toDay: db.today(), personalBp: 10_000, cents: -15_000 }])
  })
})

describe('the cost of a residence', () => {
  afterEach(db.closeDb)

  test('the Ventures list over 50,000 lines with a year lived in classifies that year, not the whole history', (t) => {
    db.openDb(':memory:')
    checking()
    const bucket = db.saveBucket({ name: 'Larch Rental', kind: 'rental', residenceFrom: '2019-02-01', residenceTo: '2019-10-31' })
    const home = house('Larch house', '2018-06-01')
    db.updateAccount(home, { bucketId: bucket })
    const cats = ['Groceries', 'Dining Out', 'Coffee', 'Personal Care', 'Shopping', 'Entertainment'].map((name) => db.listCategories().find((c) => c.name === name)!.id)
    const insert = 'INSERT INTO transactions (id, account_id, posted, amount_cents, description, desc_key, merchant, category_id, category_source, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)'
    const start = noonOn(2019, 1, 1)
    const placed: string[] = []
    db.inTransaction(() => {
      // About 34 lines a day over four years, from a few hundred payees; one in six is placed in the venture by hand.
      for (let i = 0; i < 50_000; i++) {
        const id = `p${i}`
        db.run(insert, id, 'csv:chk', start + Math.floor(i / 34) * 86_400 + (i % 34), -(500 + ((i * 7919) % 9000)), `PAYEE ${i % 400}`, `payee ${i % 400}`, `Payee ${i % 400}`, cats[i % cats.length], 'user')
        if (i % 6 === 3 && placed.length < 1_000) placed.push(id)
      }
    })
    db.setTransactionsBucket(placed, bucket)
    const cpu = (f: () => unknown): number => {
      const runs: number[] = []
      for (let k = 0; k < 3; k++) {
        const was = process.cpuUsage()
        f()
        const d = process.cpuUsage(was)
        runs.push((d.user + d.system) / 1000)
      }
      return Math.min(...runs)
    }
    listVentures()
    const plain = cpu(() => listVentures())
    assert.equal(db.convertResidences(), 1)
    const year = cpu(() => classifyLines('2019-02-01', '2019-10-31'))
    assert.ok(getVenture(bucket).result.personalUse[0].cents < 0)
    const lived = cpu(() => listVentures())
    t.diagnostic(`${lived.toFixed(0)} ms of CPU with the residence, ${plain.toFixed(0)} ms without, ${year.toFixed(0)} ms to classify its months`)
    assert.ok(lived <= 1.5 * (plain + year), `${lived.toFixed(0)} ms against ${plain.toFixed(0)} + ${year.toFixed(0)} ms`)
  })
})

describe('Personal use of a house the venture shares', () => {
  afterEach(db.closeDb)

  test('the Bayview rooms: their operating holds their 66% of the costs, their Personal use Personal’s 34%, and the two make the costs whole', () => {
    const h = bayview()
    const r = getVenture(h.rooms).result
    assert.deepEqual([r.inCents, r.outCents, r.operatingCents], [240_000, 79_200 + 25_410 + 19_140, 116_250])
    assert.deepEqual(r.personalUse, [{ assetId: h.house, fromDay: '2025-02-01', toDay: db.today(), personalBp: 3_400, cents: -40_800 - 13_090 - 9_860 }])
    // 2,400.00 of rent less 1,200.00 of interest and escrow, 385.00 of dues and 290.00 of utilities.
    assert.equal(r.operatingCents + r.personalUse[0].cents, 240_000 - 120_000 - 38_500 - 29_000)
    // A use measured by rooms needs no estimate.
    assert.deepEqual(shareIssues(), [])
  })
})
