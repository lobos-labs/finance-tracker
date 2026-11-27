import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, linesFor } from '../src/main/lines.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { carryingCost, lineAssets, listUses } from '../src/main/uses.ts'
import { addDays } from '../src/shared/zone.ts'
import type { CarryingCost, ClassifiedLine } from '../src/shared/types.ts'
import { bayview, txn } from './fixtures/bayview.ts'
import { household, TODAY } from './fixtures/carrying.ts'
import { noonOn } from './days.ts'

// A Personal house's or car's costs are its own (waterfall spec 1.0, phase 2): its loan's payments, and when
// Personal holds just one house, its housing, utilities and the charges its home policy matches; when just
// one vehicle, its fuel, upkeep, Transportation that isn't a ride, and the charges its auto policy matches.
// What it costs to keep a month is its loans' latest payment and the 12-month average of the rest.

configureLicense({ dev: true })

const rows = (c: CarryingCost | null): Array<[string, number]> => (c?.rows ?? []).map((r) => [r.kind, r.cents])
const merchantOf = (l: ClassifiedLine): string => db.getTransaction(l.txnId)!.merchant ?? ''

describe("the sample household's house and car", () => {
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
  })
  after(db.closeDb)

  test("the house's carrying cost has Pinecrest's interest and escrow, the utilities and Harborline; the car's has Lakeside's interest, Crestline and gas", () => {
    const house = carryingCost('demo:house')!
    assert.deepEqual([house.owner, house.shared], [null, false])
    assert.deepEqual(house.rows.map((r) => r.kind), ['interest', 'utilities', 'insurance', 'principal'])
    // Pinecrest has no escrow set, so its interest holds the escrow; Harborline is 142.00 every month.
    assert.equal(house.rows[0].withEscrow, true)
    assert.equal(house.rows.find((r) => r.kind === 'insurance')!.cents, 14_200)
    const car = carryingCost('demo:car')!
    assert.deepEqual(car.rows.map((r) => r.kind), ['interest', 'insurance', 'gas', 'principal'])
    assert.equal(car.rows.find((r) => r.kind === 'insurance')!.cents, 14_800)
    // A payment's interest and principal come from the same payment, which they add up to.
    const lines = classifyLines(addDays(db.today(), -62), db.today())
    const pinecrest = lines.filter((l) => l.debtId === 'demo:mortgage').at(-1)!
    const paid = lines.filter((l) => l.txnId === pinecrest.txnId)
    assert.equal(-paid.reduce((s, l) => s + l.cents, 0), house.rows[0].cents + house.rows.at(-1)!.cents)
    // Each line names its asset; the condo's are the rental's and on neither.
    const of = (merchant: string): Set<string | null> => new Set(lines.filter((l) => merchantOf(l) === merchant).map((l) => l.assetId))
    assert.deepEqual(of('Harborline Mutual'), new Set(['demo:house']))
    assert.deepEqual(of('Prairie Electric'), new Set(['demo:house']))
    assert.deepEqual(of('Crestline Insurance'), new Set(['demo:car']))
    assert.deepEqual(of('Lakeside Auto Loan'), new Set(['demo:car']))
    assert.ok(lines.filter((l) => l.categoryId === db.listCategories().find((c) => c.name === 'Gas & Fuel')!.id).every((l) => l.assetId === 'demo:car'))
    assert.ok(lines.filter((l) => merchantOf(l).startsWith('Bayview')).every((l) => l.assetId === null))
    // Only an asset has a carrying cost.
    assert.equal(carryingCost('demo:checking'), null)
  })
})

describe("the sample rental's condo", () => {
  afterEach(db.closeDb)

  test('once Review links its mortgage, the payments from the rental’s own checking are its interest and principal, not a repair', () => {
    db.openDb(':memory:')
    loadDemoData()
    const paid = db.all<{ id: string }>("SELECT id FROM transactions WHERE merchant = 'Bayview Condo Mortgage' ORDER BY posted DESC")
    assert.ok(paid.length >= 12)
    assert.deepEqual(carryingCost('demo:condo')!.rows, [])
    runTool('link_loan_payment', { account_id: 'demo:condo-mortgage', transaction_id: paid[0].id }, 'assistant')
    // The latest payment of 1,380.00, all the rental's: the condo is its own, and no use shares it.
    const cost = carryingCost('demo:condo')!
    assert.deepEqual([cost.owner, cost.shared, cost.owners], [1, false, [1]])
    assert.deepEqual(cost.rows.map((r) => r.kind), ['interest', 'principal'])
    assert.equal(cost.rows[0].cents + cost.rows[1].cents, 138_000)
    assert.ok(cost.rows.every((r) => r.byOwner.length === 1 && r.byOwner[0].cents === r.cents))
  })
})

describe('one car', () => {
  afterEach(db.closeDb)

  test("Transportation that isn't a ride is the car's: JIFFY LUBE 1123 is, UBER TRIP isn't", () => {
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    const car = db.addManualAccount({ name: '2018 Forester', assetType: 'vehicle', openedDay: '2023-04-01', costCents: 1_900_000, points: [{ day: '2023-04-01', cents: 1_900_000 }] })
    const lube = txn('csv:chk', '2026-09-03', -8_999, 'JIFFY LUBE 1123', 'Transportation')
    const uber = txn('csv:chk', '2026-09-04', -2_350, 'UBER TRIP', 'Transportation')
    const repair = txn('csv:chk', '2026-09-08', -41_000, 'MAPLE AUTO BODY')
    const assetOf = (id: string): string | null => classifyLines('2026-09-01', '2026-09-30').find((l) => l.txnId === id)!.assetId
    assert.equal(assetOf(lube), car)
    assert.equal(assetOf(uber), null)
    // The auto role: a category named for a car's upkeep (made here; it isn't a default one).
    assert.equal(assetOf(repair), null)
    db.run("INSERT INTO categories (name, kind) VALUES ('Auto Repair', 'expense')")
    const category = db.listCategories().find((c) => c.name === 'Auto Repair')!.id
    db.setTransactionFields(repair, { categoryId: category, source: 'user' })
    assert.equal(assetOf(repair), car)
    // Before the car was bought, nothing was its.
    const earlier = txn('csv:chk', '2023-03-20', -8_999, 'JIFFY LUBE 1123', 'Transportation')
    assert.equal(classifyLines('2023-03-01', '2023-03-31').find((l) => l.txnId === earlier)!.assetId, null)
  })

  test('with a second car, only loan payments are a car’s until a rule puts the rest on one, and Review is asked once', () => {
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    const car = db.addManualAccount({ name: '2018 Forester', assetType: 'vehicle', openedDay: '2023-04-01', costCents: 1_900_000, points: [{ day: '2023-04-01', cents: 1_900_000 }] })
    db.addManualAccount({ name: '2015 Tacoma', assetType: 'vehicle', openedDay: '2024-04-01', costCents: 2_400_000, points: [{ day: '2024-04-01', cents: 2_400_000 }] })
    const gas = txn('csv:chk', db.today(), -5_200, 'SHELL OIL 4410', 'Gas & Fuel', 'Shell')
    assert.equal(classifyLines(db.today(), db.today()).find((l) => l.txnId === gas)!.assetId, null)
    assert.deepEqual(openIssues().filter((i) => i.kind === 'asset_attach').map((i) => i.key), ['asset_attach:vehicle'])
    db.addBucketRule({ assetId: car, categoryId: db.listCategories().find((c) => c.name === 'Gas & Fuel')!.id })
    db.applyBucketRules()
    assert.equal(classifyLines(db.today(), db.today()).find((l) => l.txnId === gas)!.assetId, car)
    assert.deepEqual(openIssues().filter((i) => i.kind === 'asset_attach'), [])
  })
})

describe("section 5's household: the house and the car", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 }))
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('Alder Lane: interest 800, escrow 380, HOA 232, utilities 290, insurance 142, principal 805; the Civic: interest 48, insurance 68, gas 98, principal 364', () => {
    const h = household()
    assert.equal(db.today(), TODAY)
    const house = carryingCost(h.house)!
    assert.deepEqual([house.fromDay, house.toDay, house.owner, house.shared], ['2025-11-01', '2026-10-31', null, false])
    assert.deepEqual(rows(house), [
      ['interest', 80_000],
      ['escrow', 38_000],
      ['hoa', 23_200],
      ['utilities', 29_000],
      ['insurance', 14_200],
      ['principal', 80_500]
    ])
    assert.equal(house.costCents, 80_000 + 38_000 + 23_200 + 29_000 + 14_200)
    const civic = carryingCost(h.civic)!
    assert.deepEqual(rows(civic), [
      ['interest', 4_800],
      ['insurance', 6_800],
      ['gas', 9_800],
      ['principal', 36_400]
    ])
    assert.equal(civic.rows[0].withEscrow, true)
    // October's gas is the two Shell lines, both the Civic's.
    const gas = db.listCategories().find((c) => c.name === 'Gas & Fuel')!.id
    const october = linesFor({ fromDay: '2026-10-01', toDay: '2026-10-31', cls: ['everyday'], categoryId: gas })
    assert.deepEqual([october.total, october.cents], [2, -10_500])
    assert.ok(october.lines.every((l) => l.assetId === h.civic))
    // Each is Personal's alone, so the Transactions page names the Civic on it with no share (oldest first).
    const ids = october.lines.map((l) => l.txnId)
    assert.deepEqual(lineAssets(ids), [...ids].reverse().map((txnId) => ({ txnId, splitId: null, assetId: h.civic, personalBp: 10_000 })))
    // Personal owns both outright: one column each.
    assert.deepEqual([house.owners, civic.owners], [[null], [null]])
    assert.deepEqual(civic.rows.map((r) => r.byOwner), civic.rows.map((r) => [{ owner: null, cents: r.cents }]))
  })
})

describe('the Bayview house: its carrying cost by owner (section 5, phase 3)', () => {
  // February 2026: the 12 months the averages read, February 2025 to January 2026, are all in the uses.
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 2, 10) * 1000 }))
  after(() => mock.timers.reset())
  afterEach(db.closeDb)

  test('Interest + escrow 1,200: Personal 408, Bayview Rooms 792; HOA 385: 131 and 254; utilities 290: 99 and 191; principal 800, all Personal', () => {
    const h = bayview({ year: true })
    const cost = carryingCost(h.house)!
    assert.deepEqual([cost.fromDay, cost.toDay, cost.owner, cost.shared], ['2025-02-01', '2026-01-31', null, true])
    assert.deepEqual(cost.owners, [null, h.rooms])
    // Total, Personal and Bayview Rooms, in cents: the fan-out of each line (section 3), averaged.
    assert.deepEqual(
      cost.rows.map((r) => [r.kind, r.withEscrow, r.cents, ...r.byOwner.map((o) => o.cents)]),
      [
        ['interest', true, 120_000, 40_800, 79_200],
        ['hoa', false, 38_500, 13_090, 25_410],
        ['utilities', false, 29_000, 9_860, 19_140],
        ['principal', false, 80_000, 80_000, 0]
      ]
    )
    assert.equal(cost.costCents, 120_000 + 38_500 + 29_000)
    // The rest of the view: value 412,000, owed 171,200, owner Personal; the uses from 2025-02-01 on, Bayview Rooms
    // 66% and Personal 34% by rooms; and the rules that put the dues and utilities on the house.
    const house = db.listAssets().find((a) => a.account.id === h.house)!
    assert.deepEqual([house.valueCents, house.owedCents, house.account.bucketId], [41_200_000, 17_120_000, null])
    assert.deepEqual(
      listUses(h.house).map((u) => [u.fromDay, u.toDay, u.bucketId, u.shareBp, u.basis]),
      [
        ['2025-02-01', null, h.rooms, 6_600, 'rooms'],
        ['2025-02-01', null, null, 3_400, 'rooms']
      ]
    )
    assert.deepEqual(
      db.listBucketRules(undefined, h.house).map((r) => [r.assetId, r.contains, r.categoryName]),
      [
        [h.house, 'bayview ct hoa', null],
        [h.house, null, 'Utilities']
      ]
    )
  })

  test('owned by the venture: the principal is its own, and Personal still bears 408 of the interest and escrow', () => {
    const h = bayview({ year: true, ventureOwned: true })
    const cost = carryingCost(h.house)!
    assert.deepEqual([cost.owner, cost.owners], [h.rooms, [null, h.rooms]])
    assert.deepEqual(
      cost.rows.map((r) => [r.kind, r.cents, ...r.byOwner.map((o) => o.cents)]),
      [
        ['interest', 120_000, 40_800, 79_200],
        ['hoa', 38_500, 13_090, 25_410],
        ['utilities', 29_000, 9_860, 19_140],
        ['principal', 80_000, 0, 80_000]
      ]
    )
  })

  test('owned by the venture with no use: the payment from Personal checking is the venture’s 1,200 of interest and escrow and 800 of principal, not a repair', () => {
    const h = bayview({ year: true, ventureOwned: true, noUse: true })
    const cost = carryingCost(h.house)!
    assert.deepEqual([cost.owner, cost.shared, cost.owners], [h.rooms, false, [null, h.rooms]])
    // The dues and utilities Personal paid with no use to share them are Personal's, as the classifier has them.
    assert.deepEqual(
      cost.rows.map((r) => [r.kind, r.withEscrow, r.cents, ...r.byOwner.map((o) => o.cents)]),
      [
        ['interest', true, 120_000, 0, 120_000],
        ['hoa', false, 38_500, 38_500, 0],
        ['utilities', false, 29_000, 29_000, 0],
        ['principal', false, 80_000, 0, 80_000]
      ]
    )
    // The payment is money to the venture, so none of its cost is Personal's on the Transactions page.
    assert.deepEqual(lineAssets([h.payment]), [{ txnId: h.payment, splitId: null, assetId: h.house, personalBp: 0 }])
  })

  test('with its escrow set, each owner’s escrow is shared as its interest and escrow were', () => {
    const h = bayview({ year: true })
    db.updateAccount(h.mortgage, { escrowCents: 30_000 })
    // 1,200.00 is 900.00 of interest and 300.00 of escrow: Bayview Rooms gets 198.00 of the escrow and Personal 102.00.
    assert.deepEqual(
      carryingCost(h.house)!
        .rows.filter((r) => r.kind === 'interest' || r.kind === 'escrow')
        .map((r) => [r.kind, r.withEscrow, r.cents, ...r.byOwner.map((o) => o.cents)]),
      [
        ['interest', false, 90_000, 30_600, 59_400],
        ['escrow', false, 30_000, 10_200, 19_800]
      ]
    )
  })

  test("the Transactions page's labels: 34% of the payment, the dues and the utilities is Personal's, and the rent is on no asset", () => {
    const h = bayview({ year: true })
    const shown = [h.payment, h.hoa, h.utilities, h.rent]
    assert.deepEqual(
      lineAssets(shown).map((l) => [l.txnId, l.assetId, l.personalBp]),
      [
        [h.hoa, h.house, 3_400],
        [h.utilities, h.house, 3_400],
        [h.payment, h.house, 3_400]
      ]
    )
    // With none named, every line on the house in the history: a year of dues and utilities, and the payment.
    assert.equal(lineAssets().filter((l) => l.assetId === h.house).length, 25)
    assert.deepEqual(lineAssets([]), [])
    // Before the uses began, the house was Personal's alone.
    const january = txn(h.checking, '2025-01-12', -29_000, 'CITY UTILITIES', 'Utilities', 'City Utilities')
    db.applyBucketRules()
    assert.deepEqual(lineAssets([january]), [{ txnId: january, splitId: null, assetId: h.house, personalBp: 10_000 }])
  })
})

describe("what isn't a Personal house's cost", () => {
  before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 }))
  after(() => mock.timers.reset())
  afterEach(db.closeDb)

  /** A checking account and a Personal house, on a new household. */
  function house(): string {
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    txn('csv:chk', '2025-10-01', 10_000_000, 'OPENING DEPOSIT')
    return db.addManualAccount({ name: 'Alder Lane house', assetType: 'property', openedDay: '2022-03-01', costCents: 38_000_000, points: [{ day: '2022-03-01', cents: 38_000_000 }] })
  }

  test('a mortgage refinanced in April: only the new loan, which still owes, gives the interest and principal', () => {
    const h = house()
    // The old loan's 2,500.00 payments ran to March, when it was paid off and closed; the new one's are 1,500.00,
    // October's 700.00 interest and 800.00 principal.
    const old = db.addManualAccount({ name: 'Pinecrest Mortgage', assetType: 'mortgage', openedDay: '2022-03-01', linkedAssetId: h, points: [{ day: '2025-10-31', cents: -30_000_000 }, { day: '2026-03-31', cents: -29_800_000 }] })
    db.updateAccount(old, { closedDay: '2026-04-01' })
    const cedar = db.addManualAccount({ name: 'Cedar Home Loans', assetType: 'mortgage', openedDay: '2026-04-01', linkedAssetId: h, points: [{ day: '2026-09-30', cents: -29_000_000 }, { day: '2026-10-31', cents: -28_920_000 }] })
    const olds = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'].map((m) => txn('csv:chk', `${m}-01`, -250_000, 'PINECREST MORTGAGE PMT', 'Housing', 'Pinecrest Mortgage'))
    const news = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((m) => txn('csv:chk', `${m}-01`, -150_000, 'CEDAR HOME LOANS PMT', 'Housing', 'Cedar Home Loans'))
    runTool('link_loan_payment', { account_id: old, transaction_id: olds[0] }, 'assistant')
    runTool('link_loan_payment', { account_id: cedar, transaction_id: news[0] }, 'assistant')
    assert.deepEqual(rows(carryingCost(h)), [
      ['interest', 70_000],
      ['principal', 80_000]
    ])
  })

  test("an escrow payout on the mortgage itself isn't counted again: the payments' escrow holds it", () => {
    const h = house()
    const mortgage = db.addManualAccount({ name: 'Pinecrest Mortgage', assetType: 'mortgage', openedDay: '2022-03-01', linkedAssetId: h, points: [{ day: '2026-09-30', cents: -30_000_000 }, { day: '2026-10-31', cents: -29_919_500 }] })
    db.updateAccount(mortgage, { escrowCents: 38_000 })
    const pay = txn('csv:chk', '2026-10-01', -198_500, 'PINECREST MORTGAGE PMT', 'Housing', 'Pinecrest Mortgage')
    runTool('link_loan_payment', { account_id: mortgage, transaction_id: pay }, 'assistant')
    // The county's tax, paid out of escrow on the mortgage account, is in Housing too.
    txn(mortgage, '2026-06-15', -240_000, 'ESCROW DISB COUNTY TAX', 'Housing')
    assert.deepEqual(rows(carryingCost(h)), [
      ['interest', 80_000],
      ['escrow', 38_000],
      ['principal', 80_500]
    ])
  })

  test("a cost a venture's rules place is its place's, even in the residence dates that make it Personal's", () => {
    const h = house()
    // The user lived in Elm St's house, a rental, from June 2026, while still holding the Alder Lane house.
    const elm = db.saveBucket({ name: 'Elm St', kind: 'rental', residenceFrom: '2026-06-01', residenceTo: null })
    const elmHouse = db.addManualAccount({ name: 'Elm house', assetType: 'property', openedDay: '2024-05-15', costCents: 30_000_000, points: [{ day: '2024-05-15', cents: 30_000_000 }] })
    db.updateAccount(elmHouse, { bucketId: elm })
    const elmPower = txn('csv:chk', '2026-07-12', -20_000, 'ELM CITY UTILITIES', 'Utilities', 'Elm City Utilities')
    const alderPower = txn('csv:chk', '2026-07-14', -29_000, 'HARBOR POWER CO', 'Utilities', 'Harbor Power')
    runTool('add_bucket_rule', { bucket: 'Elm St', contains: 'elm city utilities' }, 'assistant')
    const july = classifyLines('2026-07-01', '2026-07-31')
    // Both are Personal's (Elm St's by its residence dates), and only Alder Lane's own power is Alder Lane's.
    assert.deepEqual(
      july.filter((l) => l.txnId === elmPower || l.txnId === alderPower).map((l) => [l.txnId, l.owner, l.assetId]),
      [
        [elmPower, null, null],
        [alderPower, null, h]
      ]
    )
    assert.deepEqual(rows(carryingCost(h)), [['utilities', 2_417]])
  })
})
