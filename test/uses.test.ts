import { after, afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, fanOut, ventureParts } from '../src/main/lines.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { getWaterfall } from '../src/main/waterfall.ts'
import { listUses, saveUses } from '../src/main/uses.ts'
import type { ClassifiedLine, LineClass } from '../src/shared/types.ts'
import { bayview, txn } from './fixtures/bayview.ts'
import { outback } from './fixtures/outback.ts'
import { noonOn } from './days.ts'

// Mixed use (waterfall spec, section 3): an asset's running costs are shared by who uses it, by dated
// periods, while its owner keeps its value, gain and loan principal. A loan payment is split into interest
// and principal first; the interest and escrow, or the whole of any other cost, go to each owner by its
// share (ventures by id, Personal last, the last taking the rest), and the principal to the loan's owner.

configureLicense({ dev: true })

/** A transaction's lines in October of a year, as [owner, key suffix after the txn id, class, cents]. */
function partsOf(id: string, month: string): Array<[number | null, string, LineClass, number]> {
  return classifyLines(`${month}-01`, `${month}-31`)
    .filter((l) => l.txnId === id)
    .map((l): [number | null, string, LineClass, number] => [l.owner, l.key.slice(id.length), l.cls, l.cents])
}

const sum = (lines: ClassifiedLine[]): number => lines.reduce((s, l) => s + l.cents, 0)
/** Personal's lines and a venture's of some transactions in a month. */
function owners(month: string, ids: string[]): { personal: number; venture: number } {
  const lines = classifyLines(`${month}-01`, `${month}-31`).filter((l) => ids.includes(l.txnId))
  return { personal: sum(lines.filter((l) => l.owner === null)), venture: sum(lines.filter((l) => l.owner !== null)) }
}
const revert = (changeId: number): void => {
  const c = db.getChange(changeId)!
  undo(c.tool, c.before, c.after, c.input)
}

describe('rules: one for a venture and one for an asset', () => {
  afterEach(db.closeDb)

  test('both apply to a line they both match: it keeps its venture and gains the asset', () => {
    const h = bayview()
    // The dues go to the rooms by a venture rule, and onto the house by an asset rule on Housing.
    runTool('add_bucket_rule', { bucket: 'Bayview Rooms', contains: 'bayview ct hoa' }, 'assistant')
    runTool('add_bucket_rule', { asset_id: h.house, category: 'Housing' }, 'assistant')
    const row = (id: string): { bucket_id: number | null; bucket_source: string | null; asset_id: string | null; asset_source: string | null } =>
      db.get('SELECT bucket_id, bucket_source, asset_id, asset_source FROM transactions WHERE id = ?', id)!
    assert.deepEqual(row(h.hoa), { bucket_id: h.rooms, bucket_source: 'rule', asset_id: h.house, asset_source: 'rule' })
    // Income never goes on an asset; the rent's venture rule still places it.
    assert.deepEqual(row(h.rent), { bucket_id: h.rooms, bucket_source: 'rule', asset_id: null, asset_source: null })
    // A line placed on the asset by hand stays there whatever the rules say, and one taken off by hand stays off.
    runTool('place_on_asset', { transaction_ids: [h.utilities], asset_id: null }, 'assistant')
    db.applyBucketRules()
    assert.deepEqual(row(h.utilities), { bucket_id: null, bucket_source: null, asset_id: null, asset_source: 'ai' })
    const rules = db.listBucketRules()
    assert.deepEqual(
      rules.map((r) => [r.bucketId, r.assetId, r.categoryName, r.contains]),
      [
        [h.rooms, null, null, 'bayview rooms rent'],
        [null, h.house, null, 'bayview ct hoa'],
        [null, h.house, 'Utilities', null],
        [h.rooms, null, null, 'bayview ct hoa'],
        [null, h.house, 'Housing', null]
      ]
    )
    // A rule names a venture or an asset, never both and never neither.
    assert.throws(() => db.all('INSERT INTO bucket_rules (account_id, created_at) VALUES (?, 0)', 'csv:chk'), /CHECK/)
    assert.throws(() => runTool('add_bucket_rule', { bucket: 'Bayview Rooms', asset_id: h.house, contains: 'dues' }), /not both/)
    assert.throws(() => runTool('add_bucket_rule', { asset_id: 'csv:chk', contains: 'dues' }), /only a house, a vehicle or another asset/)
  })

  test('an asset rule is undone with its lines, and so is deleting one', () => {
    const h = bayview()
    const r = runTool('add_bucket_rule', { asset_id: h.house, category: 'Housing' }, 'assistant')
    const id = (r.result as { rule_id: number }).rule_id
    assert.equal(db.getTransaction(h.payment) && db.get<{ a: string | null }>('SELECT asset_id AS a FROM transactions WHERE id = ?', h.payment)!.a, h.house)
    revert(r.changeId!)
    assert.equal(db.get<{ a: string | null }>('SELECT asset_id AS a FROM transactions WHERE id = ?', h.payment)!.a, null)
    assert.ok(!db.listBucketRules().some((x) => x.id === id))
    const util = db.listBucketRules().find((x) => x.categoryName === 'Utilities')!
    const d = runTool('delete_bucket_rule', { rule_id: util.id }, 'assistant')
    assert.equal(db.get<{ a: string | null }>('SELECT asset_id AS a FROM transactions WHERE id = ?', h.utilities)!.a, null)
    revert(d.changeId!)
    assert.deepEqual(db.get('SELECT asset_id, asset_source FROM transactions WHERE id = ?', h.utilities), { asset_id: h.house, asset_source: 'rule' })
    assert.ok(db.listBucketRules().some((x) => x.id === util.id && x.assetId === h.house))
  })
})

describe('migration 40: the rules rebuilt', () => {
  after(db.closeDb)

  test('every rule keeps its id and target, an auto rule stays auto, and the accounts in a venture keep their lines there', () => {
    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 39 })
    for (const id of ['csv:shop', 'csv:mine']) db.upsertAccount({ id, source: 'csv', name: id, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    db.all('UPDATE accounts SET bucket_id = ? WHERE id = ?', shop, 'csv:shop')
    db.all('INSERT INTO bucket_rules (id, bucket_id, account_id, auto, created_at) VALUES (7, ?, ?, 1, 0)', shop, 'csv:shop')
    db.all('INSERT INTO bucket_rules (id, bucket_id, account_id, contains, created_at) VALUES (9, ?, ?, ?, 0)', shop, 'csv:mine', 'supplies')
    db.insertTransactionIfNew({ id: 's1', accountId: 'csv:shop', posted: noonOn(2026, 3, 2), amountCents: -2_500, description: 'PAPER', pending: false })
    db.insertTransactionIfNew({ id: 'm1', accountId: 'csv:mine', posted: noonOn(2026, 3, 2), amountCents: -1_500, description: 'SUPPLIES DEPOT', pending: false })
    db.migrate()
    assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
    assert.deepEqual(
      db.listBucketRules().map((r) => [r.id, r.bucketId, r.assetId, r.accountId, r.categoryId, r.contains, r.auto]),
      [
        [7, shop, null, 'csv:shop', null, null, true],
        [9, shop, null, 'csv:mine', null, 'supplies', false]
      ]
    )
    db.applyBucketRules()
    assert.deepEqual([db.getTransaction('s1')!.bucketId, db.getTransaction('m1')!.bucketId], [shop, shop])
    // A new rule gets the next id; the auto rule can't be deleted on its own, as before.
    assert.ok(db.addBucketRule({ bucketId: shop, contains: 'toner' }) > 9)
    assert.throws(() => db.deleteBucketRule(7), /take the account out of the venture/)
    assert.deepEqual(db.checkIntegrity(), { corruption: [], foreignKeys: [] })
  })

  test("a rule deleted before the rebuild keeps its id to itself, so undoing that deletion can't replace a newer rule", () => {
    db.closeDb()
    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 39 })
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    db.all('INSERT INTO bucket_rules (id, bucket_id, contains, created_at) VALUES (4, ?, ?, 0)', shop, 'paper')
    db.all('INSERT INTO bucket_rules (id, bucket_id, contains, created_at) VALUES (5, ?, ?, 0)', shop, 'toner')
    db.all('DELETE FROM bucket_rules WHERE id = 5')
    // Migration 36's follow-up waits for the asset columns, and runs once they're in.
    assert.equal(db.getSetting('migrate.after.36'), '1')
    db.migrate()
    assert.equal(db.getSetting('migrate.after.36'), null)
    // The newest rule was 5, so the next is 6, not 5 again.
    assert.equal(db.addBucketRule({ bucketId: shop, contains: 'ink cartridges' }), 6)
    // Undoing the old deletion puts rule 5 back beside the new one.
    db.restoreBucketRule({ id: 5, bucketId: shop, assetId: null, assetName: null, accountId: null, accountName: null, categoryId: null, categoryName: null, contains: 'toner', amountCents: null, fromDay: null, toDay: null, auto: false })
    assert.deepEqual(
      db.listBucketRules().map((r) => [r.id, r.contains]),
      [
        [4, 'paper'],
        [5, 'toner'],
        [6, 'ink cartridges']
      ]
    )
  })
})

describe('the house with rooms rented while living there (the Bayview house)', () => {
  afterEach(db.closeDb)

  test('held personally, the 2,000.00 payment gives Bayview Rooms 792.00 and Personal 408.00 of interest and escrow plus the 800.00 principal', () => {
    const h = bayview()
    assert.deepEqual(partsOf(h.payment, '2025-10'), [
      [h.rooms, `::${h.rooms}:int`, 'venture', -79_200],
      [null, '::p:int', 'debtCost', -40_800],
      [null, '::p:prin', 'principal', -80_000]
    ])
    assert.deepEqual(owners('2025-10', [h.payment]), { personal: -120_800, venture: -79_200 })
    const lines = classifyLines('2025-10-01', '2025-10-31')
    // Paid from Personal checking, the venture's part is the Ventures term: -792.00 of the payment, and the rent whole.
    assert.equal(sum(lines.filter((l) => l.cls === 'venture' && l.txnId === h.payment)), -79_200)
    assert.deepEqual(partsOf(h.rent, '2025-10'), [[h.rooms, `::${h.rooms}`, 'venture', 240_000]])
    // The dues and the utilities are shared the same way: 254.10 and 130.90, 191.40 and 98.60.
    assert.deepEqual(partsOf(h.hoa, '2025-10'), [
      [h.rooms, `::${h.rooms}`, 'venture', -25_410],
      [null, '::p', 'everyday', -13_090]
    ])
    assert.deepEqual(partsOf(h.utilities, '2025-10'), [
      [h.rooms, `::${h.rooms}`, 'venture', -19_140],
      [null, '::p', 'everyday', -9_860]
    ])
    // Each line's parts add up to it, they name the house and the owner's share, and every key is once.
    for (const id of [h.payment, h.hoa, h.utilities]) assert.equal(sum(lines.filter((l) => l.txnId === id)), db.getTransaction(id)!.amountCents)
    assert.ok(lines.filter((l) => [h.payment, h.hoa, h.utilities].includes(l.txnId)).every((l) => l.assetId === h.house))
    assert.deepEqual(lines.filter((l) => l.txnId === h.hoa).map((l) => l.shareBp), [6600, 3400])
    assert.equal(new Set(lines.map((l) => l.key)).size, lines.length)
    // A vacancy moves only the venture: no rent, and Personal's share of every cost the same.
    db.deleteTransaction(h.rent)
    assert.deepEqual(owners('2025-10', [h.payment, h.hoa, h.utilities]), { personal: -120_800 - 13_090 - 9_860, venture: -79_200 - 25_410 - 19_140 })
  })

  test('owned by the venture, Personal gets 408.00 and the venture 1,592.00, which is the Ventures term', () => {
    const h = bayview({ ventureOwned: true })
    assert.deepEqual(partsOf(h.payment, '2025-10'), [
      [h.rooms, `::${h.rooms}:int`, 'venture', -79_200],
      [null, '::p:int', 'debtCost', -40_800],
      [h.rooms, `::${h.rooms}:prin`, 'venture', -80_000]
    ])
    assert.deepEqual(owners('2025-10', [h.payment]), { personal: -40_800, venture: -159_200 })
    assert.equal(sum(classifyLines('2025-10-01', '2025-10-31').filter((l) => l.cls === 'venture' && l.txnId === h.payment)), -159_200)
    // The venture's books read its parts: its share of each cost and the principal on its loan.
    assert.deepEqual(
      ventureParts([h.rooms]).map((p) => [p.txnId, p.cents, p.shareBp, p.principal]),
      [
        [h.hoa, -25_410, 6600, false],
        [h.utilities, -19_140, 6600, false],
        [h.payment, -79_200, 6600, false],
        [h.payment, -80_000, 10000, true]
      ]
    )
  })

  test("owned by the venture and answered equity, its 1,592.00 is one part under the line's own key: Bought assets 1,592.00 and none of it in the Ventures term", () => {
    const h = bayview({ ventureOwned: true })
    const before = getWaterfall({ from: '2025-10', to: '2025-10' }).identity
    runTool('set_venture_money', { transaction_ids: [h.payment], venture: 'Bayview Rooms', intent: 'equity', share_after_pct: 100 }, 'assistant')
    assert.deepEqual(partsOf(h.payment, '2025-10'), [
      [h.rooms, `::${h.rooms}`, 'capital', -159_200],
      [null, '::p:int', 'debtCost', -40_800]
    ])
    const after = getWaterfall({ from: '2025-10', to: '2025-10' }).identity
    assert.deepEqual([after.boughtCents - before.boughtCents, after.venturesCents - before.venturesCents], [159_200, 159_200])
  })

  test('at 40% Personal use: held personally, Personal 1,280.00 and the venture 720.00; owned by the venture, Personal 480.00 and the venture 1,520.00', () => {
    let h = bayview({ personalPct: 40 })
    assert.deepEqual(owners('2025-10', [h.payment]), { personal: -128_000, venture: -72_000 })
    db.closeDb()
    h = bayview({ personalPct: 40, ventureOwned: true })
    assert.deepEqual(owners('2025-10', [h.payment]), { personal: -48_000, venture: -152_000 })
  })

  test('before the uses begin, and with none, the costs are the owner’s alone', () => {
    const h = bayview({ noUse: true })
    assert.deepEqual(partsOf(h.payment, '2025-10'), [
      [null, '::p:int', 'debtCost', -120_000],
      [null, '::p:prin', 'principal', -80_000]
    ])
    assert.ok(classifyLines('2025-10-01', '2025-10-31').filter((l) => l.txnId === h.payment).every((l) => l.assetId === h.house && l.shareBp === 10000))
    assert.deepEqual(ventureParts([h.rooms]), [])
    saveUses(h.house, [
      { fromDay: '2025-11-01', toDay: null, bucketId: h.rooms, shareBp: 6600, basis: 'rooms', source: 'user' },
      { fromDay: '2025-11-01', toDay: null, bucketId: null, shareBp: 3400, basis: 'rooms', source: 'user' }
    ])
    assert.deepEqual(owners('2025-10', [h.payment, h.hoa, h.utilities]), { personal: -200_000 - 38_500 - 29_000, venture: 0 })
  })
})

describe('the car used partly for a business (a 2021 Outback)', () => {
  afterEach(db.closeDb)

  test('the 412.00 payment gives Rideshare 30.56 and Personal 381.44; a 46.00 tank gives 16.10 and 29.90 in Everyday', () => {
    const c = outback()
    assert.deepEqual(partsOf(c.payment, '2026-10'), [
      [c.rideshare, `::${c.rideshare}:int`, 'venture', -3_056],
      [null, '::p:int', 'debtCost', -5_674],
      [null, '::p:prin', 'principal', -32_470]
    ])
    assert.deepEqual(owners('2026-10', [c.payment]), { personal: -38_144, venture: -3_056 })
    assert.equal(38_144 + 3_056, 41_200)
    assert.deepEqual(partsOf(c.gas, '2026-10'), [
      [c.rideshare, `::${c.rideshare}`, 'venture', -1_610],
      [null, '::p', 'everyday', -2_990]
    ])
    // The insurer is the car's by its rule too.
    assert.deepEqual(owners('2026-10', [c.insurance]), { personal: -11_800 + 4_130, venture: -4_130 })
    // Before the uses began (March 1), the car's costs were Personal's alone.
    const march = txn(c.card, '2026-02-27', -4_600, 'SHELL OIL 5521', 'Gas & Fuel', 'Shell')
    db.applyBucketRules()
    assert.deepEqual(partsOf(march, '2026-02'), [[null, '::p', 'everyday', -4_600]])
  })

  test('odd cents: a 100.01 payment of 33.33 interest and 66.68 principal at 35/65 gives Rideshare 11.67 and Personal 88.34, and -11.67 and -88.34 the other way', () => {
    const shares = [{ owner: 4, bp: 3500 }, { owner: null, bp: 6500 }]
    assert.deepEqual(fanOut(3_333, shares).map((p) => p.cents), [1_167, 2_166])
    assert.equal(2_166 + 6_668, 8_834)
    assert.deepEqual(fanOut(-3_333, shares).map((p) => p.cents), [-1_167, -2_166])
    const c = outback({ payment: 10_001, principal: 6_668 })
    assert.deepEqual(partsOf(c.payment, '2026-10'), [
      [c.rideshare, `::${c.rideshare}:int`, 'venture', -1_167],
      [null, '::p:int', 'debtCost', -2_166],
      [null, '::p:prin', 'principal', -6_668]
    ])
    assert.deepEqual(owners('2026-10', [c.payment]), { personal: -8_834, venture: -1_167 })
  })

  test('set_asset_use and place_on_asset are journaled, and undone the uses and the line go back', () => {
    const c = outback()
    const before = listUses(c.car)
    const r = runTool('set_asset_use', { asset_id: c.car, uses: [{ owner: 'Personal', share_pct: 100, from: '2026-03-01' }] }, 'assistant')
    assert.deepEqual(owners('2026-10', [c.gas]), { personal: -4_600, venture: 0 })
    revert(r.changeId!)
    assert.deepEqual(listUses(c.car).map(({ id: _id, ...u }) => u), before.map(({ id: _id, ...u }) => u))
    assert.deepEqual(owners('2026-10', [c.gas]), { personal: -2_990, venture: -1_610 })
    // A coffee on the car's card isn't the car's, until it's put on it by hand.
    const coffee = txn(c.card, '2026-10-11', -500, 'BEAN THERE', 'Coffee', 'Bean There')
    assert.deepEqual(owners('2026-10', [coffee]), { personal: -500, venture: 0 })
    const p = runTool('place_on_asset', { transaction_ids: [coffee], asset_id: c.car }, 'assistant')
    assert.deepEqual(owners('2026-10', [coffee]), { personal: -325, venture: -175 })
    revert(p.changeId!)
    assert.deepEqual(owners('2026-10', [coffee]), { personal: -500, venture: 0 })
    // Shares that don't add up, days that only partly overlap, and an owner twice are refused.
    const use = (owner: string, share_pct: number, from: string, to?: string): Record<string, unknown> => ({ owner, share_pct, from, ...(to ? { to } : {}) })
    assert.throws(() => runTool('set_asset_use', { asset_id: c.car, uses: [use('Rideshare', 35, '2026-03-01'), use('Personal', 60, '2026-03-01')] }), /add up to 95%, not 100%/)
    assert.throws(() => runTool('set_asset_use', { asset_id: c.car, uses: [use('Personal', 100, '2026-01-01', '2026-06-30'), use('Rideshare', 35, '2026-03-01'), use('Personal', 65, '2026-03-01')] }), /starts inside/)
    assert.throws(() => runTool('set_asset_use', { asset_id: c.car, uses: [use('Personal', 50, '2026-03-01'), use('Personal', 50, '2026-03-01')] }), /twice/)
    assert.throws(() => runTool('set_asset_use', { asset_id: c.checking, uses: [] }), /only a house, a vehicle or another asset/)
  })
})

describe('split parts', () => {
  afterEach(db.closeDb)

  test('a part with its own venture is not shared out; a 50/50 split mortgage is no longer all Personal in the residence dates', () => {
    const h = bayview({ noUse: true })
    db.saveBucket({ id: h.rooms, name: 'Bayview Rooms', kind: 'rental', residenceFrom: '2025-02-01', residenceTo: null })
    const [own, follows] = db.splitTransaction(h.payment, [
      { amountCents: -100_000, categoryId: db.getTransaction(h.payment)!.categoryId, bucketId: h.rooms },
      { amountCents: -100_000, categoryId: db.getTransaction(h.payment)!.categoryId }
    ])
    // The residence dates make the venture's half Personal too: all 2,000.00 is Personal's.
    assert.deepEqual(owners('2025-10', [h.payment]), { personal: -200_000, venture: 0 })
    // With the house's uses set (66% the rooms, 34% Personal), the venture's own half stays the venture's, whole;
    // the half that follows the transaction is shared: of its 600.00 interest 396.00 is the rooms', and its 400.00
    // principal is Personal's, whose house it is.
    runTool('set_asset_use', { asset_id: h.house, uses: [{ owner: 'Bayview Rooms', share_pct: 66, from: '2025-02-01' }, { owner: 'Personal', share_pct: 34, from: '2025-02-01' }] }, 'assistant')
    const lines = classifyLines('2025-10-01', '2025-10-31').filter((l) => l.txnId === h.payment)
    assert.deepEqual(
      lines.map((l) => [l.splitId, l.owner, l.cls, l.cents]),
      [
        [own.id, h.rooms, 'venture', -100_000],
        [follows.id, h.rooms, 'venture', -39_600],
        [follows.id, null, 'debtCost', -20_400],
        [follows.id, null, 'principal', -40_000]
      ]
    )
    assert.deepEqual(owners('2025-10', [h.payment]), { personal: -60_400, venture: -139_600 })
  })

  test("a part taken off its own asset follows its transaction, so it's refused while the transaction is on one", () => {
    const h = bayview({ noUse: true })
    const cat = db.getTransaction(h.hoa)!.categoryId
    const [dues, fee] = db.splitTransaction(h.hoa, [
      { amountCents: -30_000, categoryId: cat },
      { amountCents: -8_500, categoryId: cat }
    ])
    const on = (): Array<[number | null, string | null]> =>
      classifyLines('2025-10-01', '2025-10-31')
        .filter((l) => l.txnId === h.hoa)
        .map((l): [number | null, string | null] => [l.splitId, l.assetId])
    // The dues are on the house by its rule, and the fee with them: the fee alone can't come off.
    assert.throws(() => runTool('place_on_asset', { transaction_ids: [h.hoa], asset_id: null, split_id: fee.id }, 'assistant'), /follows its transaction, which is on Bayview house/)
    assert.deepEqual(on(), [
      [dues.id, h.house],
      [fee.id, h.house]
    ])
    // Taken off whole and the dues put back by hand, only the fee is off; the dues' part then comes off by itself.
    runTool('place_on_asset', { transaction_ids: [h.hoa], asset_id: null }, 'assistant')
    runTool('place_on_asset', { transaction_ids: [h.hoa], asset_id: h.house, split_id: dues.id }, 'assistant')
    assert.deepEqual(on(), [
      [dues.id, h.house],
      [fee.id, null]
    ])
    const r = runTool('place_on_asset', { transaction_ids: [h.hoa], asset_id: null, split_id: dues.id }, 'assistant')
    assert.deepEqual(on(), [
      [dues.id, null],
      [fee.id, null]
    ])
    revert(r.changeId!)
    assert.deepEqual(on(), [
      [dues.id, h.house],
      [fee.id, null]
    ])
  })
})

describe('a hand on an asset is kept', () => {
  afterEach(db.closeDb)

  test('when a pending line posts under a new id, and when a merge pairs it with the kept account’s line', () => {
    const c = outback()
    const asset = (id: string): unknown => db.get('SELECT asset_id, asset_source FROM transactions WHERE id = ?', id)
    // A pending wash put on the car by hand posts under a new id.
    const pending = txn(c.checking, '2026-10-20', -2_400, 'SUDS CAR WASH 12')
    db.all('UPDATE transactions SET pending = 1 WHERE id = ?', pending)
    runTool('place_on_asset', { transaction_ids: [pending], asset_id: c.car }, 'assistant')
    const posted = txn(c.checking, '2026-10-21', -2_400, 'SUDS CAR WASH 12')
    db.carryPending(pending, posted)
    assert.deepEqual(asset(posted), { asset_id: c.car, asset_source: 'ai' })
    // One taken off by hand stays off, though the car's rule would put it on.
    const off = txn(c.card, '2026-10-22', -4_100, 'SHELL OIL 5521', 'Gas & Fuel', 'Shell')
    db.all('UPDATE transactions SET pending = 1 WHERE id = ?', off)
    runTool('place_on_asset', { transaction_ids: [off], asset_id: null }, 'assistant')
    const offPosted = txn(c.card, '2026-10-23', -4_100, 'SHELL OIL 5521', 'Gas & Fuel', 'Shell')
    db.carryPending(off, offPosted)
    db.applyBucketRules()
    assert.deepEqual(asset(offPosted), { asset_id: null, asset_source: 'ai' })
    // A charge on an old feed of the checking account, put on the car there, merges into the same charge on the kept one.
    db.upsertAccount({ id: 'csv:chk-old', source: 'csv', name: 'Checking (old feed)', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:chk-old', { assetType: 'cash' })
    const old = txn('csv:chk-old', '2026-10-25', -3_100, 'AUTOZONE 881')
    const kept = txn(c.checking, '2026-10-26', -3_100, 'AUTOZONE 881')
    runTool('place_on_asset', { transaction_ids: [old], asset_id: c.car }, 'assistant')
    db.mergeAccounts('csv:chk-old', c.checking)
    assert.ok(!db.getTransaction(old))
    assert.deepEqual(asset(kept), { asset_id: c.car, asset_source: 'ai' })
  })
})

describe('deleting a venture', () => {
  afterEach(db.closeDb)

  test('gives its use shares to Personal, as it gives its lines, so each period still adds up to 100%', () => {
    const h = bayview()
    db.deleteBucket(h.rooms)
    assert.deepEqual(listUses(h.house).map((u) => [u.bucketId, u.shareBp, u.fromDay, u.toDay]), [[null, 10_000, '2025-02-01', null]])
    assert.deepEqual(
      classifyLines('2025-10-01', '2025-10-31')
        .filter((l) => l.txnId === h.hoa)
        .map((l) => [l.owner, l.cents, l.shareBp]),
      [[null, -38_500, 10_000]]
    )
    db.closeDb()
    // With no Personal share in a period, the venture's becomes Personal's own.
    const c = outback()
    saveUses(c.car, [{ fromDay: '2026-03-01', toDay: '2026-06-30', bucketId: c.rideshare, shareBp: 10_000, basis: 'miles', source: 'user' }])
    db.deleteBucket(c.rideshare)
    assert.deepEqual(listUses(c.car).map((u) => [u.bucketId, u.shareBp, u.fromDay, u.toDay]), [[null, 10_000, '2026-03-01', '2026-06-30']])
  })
})

describe('asset_attach', () => {
  afterEach(db.closeDb)

  test('with two Personal houses, their housing and utilities raise one issue until they are put on one', () => {
    const h = bayview({ noUse: true })
    const issues = (): Array<{ key: string; transaction_ids?: string[] }> => openIssues().filter((i) => i.kind === 'asset_attach')
    // One house: nothing to ask.
    db.all('DELETE FROM bucket_rules WHERE asset_id IS NOT NULL')
    db.applyBucketRules()
    const recent = txn(h.checking, db.today(), -29_000, 'CITY UTILITIES', 'Utilities', 'City Utilities')
    assert.deepEqual(issues(), [])
    db.addManualAccount({ name: 'Pine house', assetType: 'property', openedDay: '2025-01-01', costCents: 30_000_000, points: [{ day: '2025-01-01', cents: 30_000_000 }] })
    assert.deepEqual(issues().map((i) => [i.key, i.transaction_ids]), [['asset_attach:property', [recent]]])
    runTool('place_on_asset', { transaction_ids: [recent], asset_id: h.house }, 'assistant')
    assert.deepEqual(issues(), [])
  })
})

describe('the cost of sharing', () => {
  after(db.closeDb)

  test('classifyLines over 50,000 lines with 500 on a shared asset takes at most 1.5 times as long as with no uses', (t) => {
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:chk', { assetType: 'cash' })
    db.upsertAccount({ id: 'csv:card', source: 'csv', name: 'Visa', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:card', { assetType: 'credit_card' })
    const car = db.addManualAccount({ name: 'Wagon', assetType: 'vehicle', openedDay: '2020-01-01', costCents: 2_000_000, points: [{ day: '2020-01-01', cents: 2_000_000 }] })
    const shop = db.saveBucket({ name: 'Delivery', kind: 'business' })
    // No category here is a vehicle's by itself, so only the 500 put on the wagon by hand are its.
    const cats = ['Groceries', 'Dining Out', 'Coffee', 'Personal Care', 'Shopping', 'Entertainment'].map((name) => db.listCategories().find((c) => c.name === name)!.id)
    const insert = 'INSERT INTO transactions (id, account_id, posted, amount_cents, description, desc_key, merchant, category_id, category_source, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)'
    const start = noonOn(2022, 1, 1)
    const placed: string[] = []
    db.inTransaction(() => {
      for (let i = 0; i < 50_000; i++) {
        const cat = cats[i % cats.length]
        const id = `p${i}`
        // About 34 lines a day over four years, from a few hundred payees.
        db.run(insert, id, i % 3 ? 'csv:card' : 'csv:chk', start + Math.floor(i / 34) * 86_400 + (i % 34), -(500 + ((i * 7919) % 9000)), `PAYEE ${i % 400}`, `payee ${i % 400}`, `Payee ${i % 400}`, cat, 'user')
        if (cat === cats[3] && placed.length < 500) placed.push(id)
      }
    })
    const share = (on: boolean): void => {
      db.setTransactionsAsset(placed, on ? car : null, 'user')
      saveUses(
        car,
        on
          ? [
              { fromDay: '2022-01-01', toDay: null, bucketId: shop, shareBp: 3500, basis: 'miles', source: 'user' },
              { fromDay: '2022-01-01', toDay: null, bucketId: null, shareBp: 6500, basis: 'miles', source: 'user' }
            ]
          : []
      )
    }
    // One warm run after the change, then the measured one.
    const cpu = (): number => {
      classifyLines('2022-01-01', '2026-01-31')
      const was = process.cpuUsage()
      classifyLines('2022-01-01', '2026-01-31')
      const d = process.cpuUsage(was)
      return (d.user + d.system) / 1000
    }
    share(true)
    const lines = classifyLines('2022-01-01', '2026-01-31')
    assert.equal(lines.filter((l) => l.assetId === car && l.owner === shop).length, 500)
    // npm test runs the test files at once, so the load on the machine changes from moment to moment, and a busy
    // moment can make the same work take half again as long. Each round times the two cases back to back, in
    // alternating order, and the ratio is the median of the rounds' own ratios, so a busy stretch slows both
    // sides of a round alike and one busy round doesn't decide it.
    const ratios: number[] = []
    const seen: string[] = []
    for (let k = 0; k < 6; k++) {
      const order = k % 2 ? [true, false] : [false, true]
      const ms: Record<string, number> = {}
      for (const on of order) {
        share(on)
        ms[String(on)] = cpu()
      }
      ratios.push(ms.true / ms.false)
      seen.push(`${ms.true.toFixed(0)}/${ms.false.toFixed(0)}`)
    }
    ratios.sort((a, b) => a - b)
    const median = (ratios[2] + ratios[3]) / 2
    t.diagnostic(`with uses against without, ms of CPU by round: ${seen.join(', ')}; median ratio ${median.toFixed(2)}`)
    assert.ok(median <= 1.5, `the median ratio is ${median.toFixed(2)} (${seen.join(', ')})`)
  })
})
