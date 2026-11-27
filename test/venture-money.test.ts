import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, ENGINE_VERSION, isFundPart, ledgerLines, linesFor } from '../src/main/lines.ts'
import { getBalanceSheet, getNetWorthSeries, netWorthNow } from '../src/main/netWorth.ts'
import { changedMonths, checkClosed, closeDueMonths, listSnapshots, rowsDigest } from '../src/main/snapshots.ts'
import { openIssues, runAssistantTool, runTool } from '../src/main/tools.ts'
import { basisThrough, claimsThrough, positionBook, positionsOn, shareOn, ventureValues } from '../src/main/ventureMoney.ts'
import { getVenture, listVentures } from '../src/main/ventures.ts'
import { getWaterfall, monthClose } from '../src/main/waterfall.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { CashIdentity, NetWorthBridge, StageId, VentureShare } from '../src/shared/types.ts'
import { budgetRatio, busyMs, paired, within } from './cost.ts'
import { noonOn } from './days.ts'
import { elmSt } from './fixtures/elm.ts'
import { largeLedger } from './fixtures/large-ledger.ts'
import { ACCOUNTS as ACCOUNTS_TIE, tieOut, type TieOut } from './fixtures/tieout.ts'
import { ACCOUNTS, kestrel, kestrelBooks, line, setParts, storeParts, type Kestrel } from './fixtures/venture-money.ts'

// Money between Personal and a venture (waterfall spec addendum 1.11, sub-phase 1j). Part 1: each venture's dated
// share, its claims and basis from its intent parts, and its position in Personal net worth, the series, the balance
// sheet and the bridge reading it alike; Review's set_venture_share and set_venture_value with their undo,
// in_net_worth as their alias, and the share_unset and venture_value issues. Part 2: the classifier's boundary lines
// and rule 0, each intent's class on Personal's side, the Ventures term and the identities reading them, and Review's
// set_venture_money with its refusals and undo, on the section 2 tie-out (example A) and Kestrel Studio
// (test/fixtures/venture-money.ts, examples B, E, F) and a paycheck account a venture holds (example H).

configureLicense({ dev: true })

const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
/** The share rows of a venture, as its tools and undo keep them. */
const sharesOf = (id: number): VentureShare[] => db.ventureShareRows(id).map(({ fromDay, shareBp, source }) => ({ fromDay, shareBp, source }))
/** Personal net worth on each of some days, from the series. */
function seriesOn(...days: string[]): number[] {
  const at = new Map(getNetWorthSeries().points.map((p) => [p.day, p.cents]))
  return days.map((d) => at.get(d)!)
}
/** Undoes a change the way the Review chat does. */
function revert(changeId: number | undefined): void {
  const c = db.getChange(changeId!)!
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId!)
}
const issueKeys = (kind: string): string[] => openIssues().filter((i) => i.kind === kind).map((i) => i.key).sort()

describe('migration 43', () => {
  afterEach(() => db.closeDb())

  test('a ledger built before it: each venture gets one share row from 0000-01-01, 100% where it was counted and 0% where it was left out', () => {
    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 42 })
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    const mom = db.saveBucket({ name: 'Mom', kind: 'person', inNetWorth: false })
    db.migrate()
    assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
    assert.deepEqual(sharesOf(shop), [{ fromDay: '0000-01-01', shareBp: 10000, source: 'migrated' }])
    assert.deepEqual(sharesOf(mom), [{ fromDay: '0000-01-01', shareBp: 0, source: 'migrated' }])
    const listed = new Map(db.listBuckets().map((b) => [b.id, b]))
    assert.deepEqual([listed.get(shop)!.shareBp, listed.get(shop)!.inNetWorth, listed.get(shop)!.valueSource, listed.get(shop)!.stakeAccountId], [10000, true, 'books', null])
    assert.deepEqual([listed.get(mom)!.shareBp, listed.get(mom)!.inNetWorth], [0, false])
    assert.deepEqual(db.all('SELECT value_source, stake_account_id FROM buckets ORDER BY id'), [{ value_source: null, stake_account_id: null }, { value_source: null, stake_account_id: null }])
    for (const t of ['venture_money', 'venture_money_rules']) assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n, 0, t)
  })

  test('a fresh ledger: a venture made later gets the same row from its in_net_worth, 100% unless it is false', () => {
    db.openDb(':memory:')
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    const mom = db.saveBucket({ name: 'Mom', kind: 'person', inNetWorth: false })
    assert.deepEqual(sharesOf(shop), [{ fromDay: '0000-01-01', shareBp: 10000, source: 'migrated' }])
    assert.deepEqual(sharesOf(mom), [{ fromDay: '0000-01-01', shareBp: 0, source: 'migrated' }])
    // Deleting a venture takes its share rows, its stored parts and its remembered answers with it.
    db.run("INSERT INTO venture_money_rules (venture_id, shape, direction, intent, created_at) VALUES (?, 'C', 'out', 'equity', 0)", shop)
    db.deleteBucket(shop)
    for (const [t, c] of [['venture_shares', 'bucket_id'], ['venture_money_rules', 'venture_id']]) assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, shop)!.n, 0, t)
    assert.ok(Object.keys(db.exportAll().tables).includes('venture_shares'))
  })
})

describe('the share is a dated step function', () => {
  test('the row with the latest day on or before the day, and 0 before the first', () => {
    const rows: VentureShare[] = [
      { fromDay: '2026-01-15', shareBp: 4000, source: 'review' },
      { fromDay: '2026-11-02', shareBp: 5000, source: 'review' }
    ]
    assert.deepEqual(['2026-01-14', '2026-01-15', '2026-11-01', '2026-11-02', '2027-06-30'].map((d) => shareOn(rows, d)), [0, 4000, 4000, 5000, 5000])
    assert.equal(shareOn([], '2026-06-01'), 0)
    assert.equal(shareOn([{ fromDay: '0000-01-01', shareBp: 10000, source: 'migrated' }], '1990-01-01'), 10000)
  })
})

describe('Kestrel Studio, example B', () => {
  let k: Kestrel
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    k = kestrel()
    storeParts(k)
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('Oct 31: V 4,000.00, 40% of 10,000.00; Nov 30: lent 2,000.00, due -100.00, E 14,770.00, stake 7,385.00, V 9,285.00', () => {
    const book = positionBook('2026-11-30')
    const parts = book.parts.get(k.venture)!
    assert.deepEqual(claimsThrough(parts, '2026-10-31'), { lentCents: 0, borrowedCents: 0, dueCents: 0 })
    assert.deepEqual(claimsThrough(parts, '2026-11-30'), { lentCents: 200_000, borrowedCents: 0, dueCents: -10_000 })
    assert.deepEqual([basisThrough(parts, '2026-10-31'), basisThrough(parts, '2026-11-30')], [
      { basisCents: 400_000, aboveBasisCents: 0 },
      { basisCents: 600_000, aboveBasisCents: 0 }
    ])
    const balances = db.balancesOn([ACCOUNTS.kestrel], '2026-11-30')
    const p = positionsOn(book, '2026-11-30', (id) => balances.get(id) ?? 0).get(k.venture)!
    assert.deepEqual(p, { lentCents: 200_000, borrowedCents: 0, dueCents: -10_000, shareBp: 5000, netAssetsCents: 1_667_000, equityCents: 1_477_000, stakeCents: 738_500, positionCents: 928_500 })
    assert.deepEqual(ventureValues(['2026-10-31', '2026-11-30']).get(k.venture), [400_000, 928_500])
    // The venture's books show the same, today.
    const owner = getVenture(k.venture).result.owner
    assert.deepEqual([owner.shareBp, owner.valueSource, owner.basisCents, owner.lentCents, owner.dueCents, owner.netAssetsCents, owner.stakeCents, owner.positionCents], [5000, 'books', 600_000, 200_000, -10_000, 1_667_000, 738_500, 928_500])
    assert.deepEqual(owner.shares.map((s) => [s.fromDay, s.shareBp, s.source]), [
      ['0000-01-01', 0, 'migrated'],
      ['2026-01-15', 4000, 'review'],
      ['2026-11-02', 5000, 'review']
    ])
    assert.deepEqual(owner.byIntent, [
      { intent: 'equity', inCents: 0, outCents: 600_000, interestCents: 0 },
      { intent: 'loan', inCents: 0, outCents: 300_000, interestCents: 0 },
      { intent: 'reimbursement', inCents: 10_000, outCents: 0, interestCents: 0 },
      { intent: 'loan_repayment', inCents: 103_000, outCents: 0, interestCents: 3_000 }
    ])
    const listed = listVentures().find((b) => b.id === k.venture)!
    assert.deepEqual([listed.shareBp, listed.inNetWorth, listed.valueSource, listed.positionCents], [5000, true, 'books', 928_500])
  })

  test('Personal net worth is Checking and the position: 10,000.00 on Oct 31, 12,715.00 on Nov 30, and the bridge ties', () => {
    assert.deepEqual(seriesOn('2026-10-31', '2026-11-30'), [1_000_000, 1_271_500])
    assert.equal(netWorthNow(), 1_271_500)
    assert.equal(getBalanceSheet().netWorthCents, 1_271_500)
    const nov = getWaterfall({ from: '2026-11', to: '2026-11' }).bridge
    assert.deepEqual([nov.startCents, nov.endCents, nov.engineErrorCents, nov.revaluationCents], [1_000_000, 1_271_500, 0, 0])
    assert.deepEqual(nov.ventures, [{ bucketId: k.venture, startCents: 400_000, endCents: 928_500 }])
    // The intent parts take the 5,000.00 out, the 1,030.00 back and the 100.00 Kestrel paid for Personal out of the
    // Ventures term (rule 0, part 2): Ventures(NW) is the change in position, 5,285.00, less the 3,900.00 of claims
    // and stake Bought assets holds, 1,385.00.
    assert.equal(nov.venturesCents, 138_500)
    // January's 4,000.00 of equity bought 40% at book, so net worth didn't move with it.
    const jan = getWaterfall({ from: '2026-01', to: '2026-01' }).bridge
    assert.deepEqual([jan.endCents - jan.startCents, jan.venturesCents, jan.ventures], [0, 0, [{ bucketId: k.venture, startCents: 0, endCents: 400_000 }]])
  })

  test("the Overview's line is the bridge at every month's end", () => {
    const at = new Map(getNetWorthSeries().points.map((p) => [p.day, p.cents]))
    for (let m = '2026-01'; m <= '2026-11'; m = shiftMonth(m, 1)) {
      const b = getWaterfall({ from: m, to: m }).bridge
      assert.equal(at.get(lastDay(m)), b.endCents, m)
      assert.equal(b.engineErrorCents, 0, m)
    }
  })

  test('the balance sheet: a Ventures row with the share, the position and its 30-day change; Kestrel Checking in no other group', () => {
    const sheet = getBalanceSheet()
    const ventures = sheet.groups.find((g) => g.id === 'ventures')!
    // Nov 7, 30 days ago: Kestrel Checking 15,000.00 with 3,000.00 lent, so 3,000.00 + 50% of 12,000.00 = 9,000.00.
    assert.deepEqual(ventures.ventures, [{ bucketId: k.venture, name: 'Kestrel Studio', shareBp: 5000, cents: 928_500, change30Cents: 28_500 }])
    assert.deepEqual([ventures.cents, ventures.change30Cents, ventures.accounts, ventures.zeroCount], [928_500, 28_500, [], 0])
    assert.deepEqual(sheet.groups.find((g) => g.id === 'cash')!.accounts.map((x) => [x.account.id, x.cents]), [[ACCOUNTS.checking, 343_000]])
    assert.ok(!sheet.groups.some((g) => g.accounts.some((x) => x.account.id === ACCOUNTS.kestrel)))
    assert.deepEqual([sheet.ownCents, Math.abs(sheet.oweCents), sheet.netWorthCents], [1_271_500, 0, 1_271_500])
  })
})

describe('the estimate source, and never both', () => {
  let k: Kestrel
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    k = kestrel({ stake: true })
    storeParts(k)
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a Stakes account worth 8,000.00 on Oct 31 and 9,000.00 on Nov 30: V 8,000.00 then 10,900.00, net worth 14,000.00 to 14,330.00', () => {
    // Before it's linked it's a Personal asset beside the venture's position.
    assert.deepEqual(seriesOn('2026-10-31', '2026-11-30'), [1_800_000, 2_171_500])
    runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake }, 'assistant')
    assert.deepEqual(ventureValues(['2026-10-31', '2026-11-30']).get(k.venture), [800_000, 1_090_000])
    assert.deepEqual(seriesOn('2026-10-31', '2026-11-30'), [1_400_000, 1_433_000])
    const nov = getWaterfall({ from: '2026-11', to: '2026-11' }).bridge
    assert.deepEqual([nov.startCents, nov.endCents, nov.engineErrorCents, nov.revaluationCents], [1_400_000, 1_433_000, 0, 0])
    assert.deepEqual(nov.ventures, [{ bucketId: k.venture, startCents: 800_000, endCents: 1_090_000 }])
    const listed = listVentures().find((b) => b.id === k.venture)!
    assert.deepEqual([listed.valueSource, listed.stakeAccountId, listed.positionCents], ['estimate', k.stake, 1_090_000])
    // The Stakes account is the venture's now: on no group of the balance sheet but the Ventures row.
    const sheet = getBalanceSheet()
    assert.ok(!sheet.groups.some((g) => g.accounts.some((x) => x.account.id === k.stake)))
    assert.equal(sheet.netWorthCents, 1_433_000)
  })

  test('linked and valued by the books, net worth on Nov 30 is 12,715.00, not 21,715.00, and Revaluation holds nothing for the Stakes account', () => {
    const before = getWaterfall({ from: '2026-11', to: '2026-11' }).bridge
    // Unlinked, its 1,000.00 rise is Personal's Revaluation.
    assert.equal(before.revaluationCents, 100_000)
    runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'books', stake_account_id: k.stake }, 'assistant')
    assert.deepEqual(seriesOn('2026-11-30'), [1_271_500])
    assert.equal(netWorthNow(), 1_271_500)
    const nov = getWaterfall({ from: '2026-11', to: '2026-11' }).bridge
    assert.deepEqual([nov.endCents, nov.revaluationCents, nov.engineErrorCents], [1_271_500, 0, 0])
    const listed = listVentures().find((b) => b.id === k.venture)!
    assert.deepEqual([listed.valueSource, listed.stakeAccountId, listed.positionCents], ['books', k.stake, 928_500])
    // No capital line attaches to it.
    assert.throws(() => runTool('mark_capital', { transaction_ids: [k.equity], asset_id: k.stake }, 'assistant'), /stake/)
  })
})

describe("Review's set_venture_share and set_venture_value, and their undo", () => {
  let k: Kestrel
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    k = kestrel({ stake: true })
    storeParts(k)
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('set_venture_share writes a row from its day, removes one with null, and undo puts the rows back', () => {
    const was = sharesOf(k.venture)
    const r = runAssistantTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-12-01', share_pct: 60 })
    assert.deepEqual(sharesOf(k.venture).at(-1), { fromDay: '2026-12-01', shareBp: 6000, source: 'review' })
    // From Dec 1, 60% of the 14,770.00: 8,862.00, beside the claims of 1,900.00.
    assert.deepEqual([listVentures()[0].shareBp, listVentures()[0].positionCents], [6000, 200_000 - 10_000 + 886_200])
    revert(r.changeId)
    assert.deepEqual(sharesOf(k.venture), was)
    assert.equal(listVentures()[0].positionCents, 928_500)

    const removed = runAssistantTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-11-02', share_pct: null })
    assert.deepEqual(sharesOf(k.venture).map((s) => s.shareBp), [0, 4000])
    revert(removed.changeId)
    assert.deepEqual(sharesOf(k.venture), was)

    assert.throws(() => runTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-12-01', share_pct: 101 }, 'assistant'), /0 to 100/)
    assert.throws(() => runTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-12-01', share_pct: 12.345 }, 'assistant'), /two decimals/)
    assert.throws(() => runTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-12-01', share_pct: null }, 'assistant'), /no share from 2026-12-01/)
    assert.throws(() => runTool('set_venture_share', { venture: 'Kestrel Studio', from: 'December', share_pct: 50 }, 'assistant'), /from is the day/)
    // Two decimals are kept.
    runTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-12-01', share_pct: 33.33 }, 'assistant')
    assert.equal(sharesOf(k.venture).at(-1)!.shareBp, 3333)
  })

  test('set_venture_value links a Stakes account for an estimate, and undo goes back to the books', () => {
    assert.throws(() => runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate' }, 'assistant'), /needs a Personal Stakes account/)
    assert.throws(() => runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: ACCOUNTS.checking }, 'assistant'), /isn't a visible Personal Stakes account/)
    const r = runAssistantTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake })
    assert.deepEqual(db.ventureValueFields(k.venture), { valueSource: 'estimate', stakeAccountId: k.stake })
    assert.equal(netWorthNow(), 1_433_000)
    revert(r.changeId)
    assert.deepEqual(db.ventureValueFields(k.venture), { valueSource: null, stakeAccountId: null })
    assert.equal(netWorthNow(), 343_000 + 928_500 + 900_000)
    // A Stakes account a capital line already counts would count twice: its lines are unmarked first. (A line with an
    // intent is never capital: the equity's is removed to mark it.)
    assert.throws(() => runTool('mark_capital', { transaction_ids: [k.equity], asset_id: k.stake }, 'assistant'), /has an intent with Kestrel Studio/)
    runTool('set_venture_money', { transaction_ids: [k.equity], venture: 'Kestrel Studio', intent: 'none' }, 'assistant')
    runTool('mark_capital', { transaction_ids: [k.equity], asset_id: k.stake }, 'assistant')
    assert.throws(() => runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake }, 'assistant'), /marked as capital/)
    runTool('mark_capital', { transaction_ids: [k.equity], asset_id: null }, 'assistant')
    runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake }, 'assistant')
    // Left out, the Stakes account linked stays linked.
    runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'books' }, 'assistant')
    assert.deepEqual(db.ventureValueFields(k.venture), { valueSource: 'books', stakeAccountId: k.stake })
  })
})

describe('in_net_worth as the alias of the share', () => {
  let k: Kestrel
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    k = kestrel()
    storeParts(k)
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('true makes it 100% from 0000-01-01 and false 0%, both migrated; an edit without it keeps the shares; update_bucket undo puts the rows back', () => {
    const was = sharesOf(k.venture)
    const made = runAssistantTool('create_bucket', { name: 'Mom', kind: 'person', in_net_worth: false })
    const mom = (made.result as { id: number }).id
    assert.deepEqual(sharesOf(mom), [{ fromDay: '0000-01-01', shareBp: 0, source: 'migrated' }])
    const renamed = runAssistantTool('update_bucket', { bucket: 'Kestrel Studio', description: 'design studio' })
    assert.deepEqual(sharesOf(k.venture), was)
    revert(renamed.changeId)
    assert.deepEqual(sharesOf(k.venture), was)

    const all = runAssistantTool('update_bucket', { bucket: 'Kestrel Studio', in_net_worth: true })
    assert.deepEqual(sharesOf(k.venture), [{ fromDay: '0000-01-01', shareBp: 10000, source: 'migrated' }])
    // At 100% by the books the position is the account: 16,670.00.
    assert.equal(listVentures().find((b) => b.id === k.venture)!.positionCents, 1_667_000)
    revert(all.changeId)
    assert.deepEqual(sharesOf(k.venture), was)
    assert.equal(listVentures().find((b) => b.id === k.venture)!.positionCents, 928_500)

    db.saveBucket({ id: k.venture, name: 'Kestrel Studio', kind: 'business', inNetWorth: false })
    assert.deepEqual(sharesOf(k.venture), [{ fromDay: '0000-01-01', shareBp: 0, source: 'migrated' }])
    // At 0% the position is the claims alone: 2,000.00 lent and 100.00 owed back.
    assert.equal(listVentures().find((b) => b.id === k.venture)!.positionCents, 190_000)
  })
})

describe('share_unset and venture_value', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('share_unset while every share row is migrated and money crosses; venture_value while owned with nothing to value it by', () => {
    const k = kestrel({ stake: true })
    // Kestrel's shares are Review's: no issue.
    assert.deepEqual([issueKeys('share_unset'), issueKeys('venture_value')], [[], []])
    // Back to the migrated share, with its account: share_unset, until a share is recorded.
    runTool('update_bucket', { bucket: 'Kestrel Studio', in_net_worth: true }, 'assistant')
    assert.deepEqual(issueKeys('share_unset'), [`share_unset:${k.venture}`])
    runTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-01-15', share_pct: 40 }, 'assistant')
    assert.deepEqual(issueKeys('share_unset'), [])

    // A rental with no account and lines placed in it on Personal's checking, at the 100% it was made with.
    const pine = db.saveBucket({ name: 'Pine Rentals', kind: 'rental' })
    // With nothing placed in it and nothing held, only its value is asked for.
    assert.deepEqual([issueKeys('share_unset'), issueKeys('venture_value')], [[], [`venture_value:${pine}`]])
    const repair = db.all<{ id: string }>("SELECT id FROM transactions WHERE description = 'FRESHWAY MARKET' AND account_id = ?", ACCOUNTS.checking)[0].id
    db.setTransactionsBucket([repair], pine)
    assert.deepEqual([issueKeys('share_unset'), issueKeys('venture_value')], [[`share_unset:${pine}`], [`venture_value:${pine}`]])
    // A Stakes account values it.
    runTool('set_venture_value', { venture: 'Pine Rentals', source: 'estimate', stake_account_id: k.stake }, 'assistant')
    assert.deepEqual(issueKeys('venture_value'), [])
    // Someone the user supports, at 0%: neither.
    db.saveBucket({ name: 'Mom', kind: 'person', inNetWorth: false })
    assert.deepEqual(issueKeys('venture_value'), [])
    runTool('set_venture_share', { venture: 'Pine Rentals', from: '2026-01-01', share_pct: 100 }, 'assistant')
    assert.deepEqual(issueKeys('share_unset'), [])
  })

  test("a Stakes account Kestrel holds itself is asked about once, before its share scales the user's own estimate; set_venture_value says to take it out first", () => {
    const k = kestrel({ stake: true })
    storeParts(k)
    // Kestrel stake (9,000.00) in the venture: its books count it as Kestrel's own money, at 50%.
    db.updateAccount(k.stake!, { bucketId: k.venture })
    const asked = openIssues().filter((i) => i.kind === 'venture_value')
    assert.deepEqual(asked.map((i) => i.key), [`venture_value:${k.venture}:${k.stake}`])
    assert.match(asked[0].summary, /^Kestrel Studio holds Kestrel stake \[.+\], a Stakes account: its books count it as Kestrel Studio's own money/)
    assert.throws(() => runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake }, 'assistant'), /is in a venture, which counts it as the venture's own money: take it out of the venture first/)
    // Out of the venture and linked, the stake is the estimate, and nothing is asked: 3,430.00 + 2,000.00 - 100.00 + 9,000.00.
    db.updateAccount(k.stake!, { bucketId: null })
    runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake }, 'assistant')
    assert.deepEqual([issueKeys('venture_value'), netWorthNow()], [[], 1_433_000])
  })

  test('the demo raises one share_unset, Bayview Condo, and no venture_value; Elm St one share_unset', () => {
    db.openDb(':memory:')
    loadDemoData()
    const bayview = db.listBuckets().find((b) => b.name === 'Bayview Condo')!
    assert.deepEqual([issueKeys('share_unset'), issueKeys('venture_value')], [[`share_unset:${bayview.id}`], []])
    db.closeDb()
    db.openDb(':memory:')
    const elm = elmSt()
    assert.deepEqual([issueKeys('share_unset'), issueKeys('venture_value')], [[`share_unset:${elm.bucket}`], []])
  })
})

describe('the engine version that freezes positions', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('a month closed under version 2, figures unchanged, stays closed with no issue after the bump', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    tieOut()
    await closeDueMonths()
    const closes = listSnapshots(1000)
    assert.ok(closes.length >= 6)
    // What version 2 froze: rows digested without the positions. Wren Rentals holds 4,000.00 or more at each month's
    // ends, so the two digests differ.
    db.run("DELETE FROM settings WHERE key LIKE 'snapshots.checked:%' OR key LIKE 'snapshots.stamp:%' OR key = 'snapshots.sweep'")
    for (const s of closes) {
      const w = monthClose(s.month).waterfall
      assert.notEqual(rowsDigest(w, 2), rowsDigest(w), s.month)
      db.run("UPDATE month_snapshots SET engine_version = 2, rows_digest = ?, inputs_stamp = 'version 2' WHERE month = ? AND version = ?", rowsDigest(w, 2), s.month, s.version)
    }
    const run = await checkClosed()
    assert.equal(run.checked.length, closes.length)
    assert.deepEqual([run.changed, run.reclosed, changedMonths(), openIssues().filter((i) => i.kind === 'month_changed')], [[], [], [], []])
    assert.deepEqual(
      listSnapshots(1000).map((s) => [s.month, s.version, s.status, s.engineVersion]),
      closes.map((s) => [s.month, s.version, s.status, 2])
    )
    assert.equal(ENGINE_VERSION, 3)
  })

  test("closed under version 3, a share recorded from October moves October's position, and so its close, with cause ai", async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    tieOut()
    await closeDueMonths()
    await checkClosed()
    const before = monthClose('2026-10').waterfall.bridge.ventures
    runTool('set_venture_share', { venture: 'Wren Rentals', from: '2026-10-01', share_pct: 50 }, 'assistant')
    // Half of Oct 31's 5,300.00.
    assert.deepEqual([before[0].endCents, monthClose('2026-10').waterfall.bridge.ventures[0].endCents], [530_000, 265_000])
    const moved = await checkClosed()
    assert.deepEqual(moved.changed.map((c) => [c.month, c.cause]), [['2026-10', 'ai']])
  })
})

// ---------- part 2: boundary lines, rule 0 and set_venture_money ----------

/**
 * A span's figures as the tests read them: each row's actual, the cash identity with both its sides, and the bridge.
 * With nothing taken from pay (no paystub), Gross pay is one row with Take-home: `gross` reads it there.
 */
function figures(from: string, to = from): { rows: Partial<Record<StageId, number>>; identity: CashIdentity; left: number; right: number; bridge: NetWorthBridge; part: (row: StageId, key: string) => number | undefined } {
  const w = getWaterfall({ from, to })
  const x = w.identity
  const rows: Partial<Record<StageId, number>> = Object.fromEntries(w.rows.map((r) => [r.id, r.actualCents]))
  const merged = (row: StageId): StageId => (row === 'gross' && rows.gross === undefined ? 'takeHome' : row)
  return {
    rows: { ...rows, gross: rows.gross ?? rows.takeHome },
    identity: x,
    left: x.keptCents + x.venturesCents + x.cashReturnCents + x.unsortedCents,
    right: x.movedCents + x.checkingCents + x.debtPaidCents + x.toInvestmentsCents + x.boughtCents + x.inTransitCents + x.unexplainedCents,
    bridge: w.bridge,
    part: (row, key) => w.rows.find((r) => r.id === merged(row))?.parts.find((p) => p.key === key)?.actualCents
  }
}

/**
 * Coverage (spec 2, identity 1, with the addendum's change): in every month from one to another, each source line's
 * parts add up to it, intent parts as a bonus split does, so the count and sum of source lines are as they were; and
 * each funding's parts, extra to its line, add up to minus the line. (No line here is a cost shared by use, whose
 * venture's part on its own account isn't in the ledger.)
 */
function assertCovered(from: string, to: string): void {
  for (let m = from; m <= to; m = shiftMonth(m, 1)) {
    const by = new Map<string, { line: number; parts: number; fund: number | null }>()
    for (const l of ledgerLines(`${m}-01`, lastDay(m))) {
      const k = `${l.txnId}:${l.splitId ?? ''}`
      const x = by.get(k) ?? { line: l.lineCents, parts: 0, fund: null }
      if (isFundPart(l)) x.fund = (x.fund ?? 0) + l.cents
      else x.parts += l.cents
      by.set(k, x)
    }
    for (const [k, x] of by) {
      assert.equal(x.parts, x.line, `${m} ${k}`)
      if (x.fund !== null) assert.equal(x.fund, -x.line, `${m} ${k} funding`)
    }
  }
}

/** The boundary parts of a transaction as the ledger lists them: key, class, cents, venture, intent and who set it. */
const partsOfTxn = (txnId: string, day: string): Array<[string, string, number, number | null, string | null, string | null]> =>
  ledgerLines(day, day)
    .filter((l) => l.txnId === txnId)
    .map((l) => [l.key.slice(txnId.length), l.cls, l.cents, l.ventureId, l.intent, l.intentSource])

describe('example A: the section 2 tie-out with the repair a reimbursement and the groceries a draw', () => {
  let t: TieOut
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    t = tieOut()
  })
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("with both unset, every figure is 1g's: Ventures -170.00, Saved 1,845.00, Ventures(NW) 1,130.00", () => {
    const oct = figures('2026-10')
    assert.deepEqual([oct.rows.oneOffs, oct.identity.keptCents, oct.rows.saved, oct.identity.venturesCents, oct.identity.boughtCents], [45_000, 109_500, 184_500, -17_000, 0])
    assert.deepEqual([oct.left, oct.right], [94_500, 94_500])
    assert.deepEqual([oct.bridge.endCents - oct.bridge.startCents, oct.bridge.venturesCents, oct.bridge.engineErrorCents], [335_500, 113_000, 0])
    // The repair is the venture's cost on Checking (C) and the groceries a Personal line Wren Card paid (F): each a
    // boundary part with Wren Rentals and no intent.
    assert.deepEqual(partsOfTxn(t.repair, '2026-10-20'), [[`::${t.venture}`, 'venture', -25_000, t.venture, null, null]])
    assert.deepEqual(partsOfTxn(t.groceries, '2026-10-09'), [['::p', 'everyday', -8_000, t.venture, null, null]])
    assert.equal(linesFor({ fromDay: '2026-10-01', toDay: '2026-10-31', ventureId: t.venture, intent: 'unset' }).total, 2)
  })

  test('One-offs 370.00, Kept 1,175.00, Saved 1,925.00, Ventures 0, Bought assets 250.00, both sides 1,195.00, V 4,000.00 to 5,300.00, Ventures(NW) 1,050.00, the bridge 3,355.00', () => {
    runAssistantTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement' })
    runAssistantTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw' })
    // The repair is replaced by its one part, which keeps its key; the groceries keep theirs and gain the funding's.
    assert.deepEqual(partsOfTxn(t.repair, '2026-10-20'), [[`::${t.venture}`, 'capital', -25_000, t.venture, 'reimbursement', 'review']])
    assert.deepEqual(partsOfTxn(t.groceries, '2026-10-09'), [
      ['::p', 'everyday', -8_000, null, null, null],
      ['::p:fund', 'oneOffIncome', 8_000, t.venture, 'draw', 'review']
    ])
    const oct = figures('2026-10')
    // No draw in the 2 months before: irregular, so a One-off income, under the venture's draws.
    assert.equal(oct.part('oneOffs', `draw:${t.venture}`), -8_000)
    assert.deepEqual([oct.rows.oneOffs, oct.identity.keptCents, oct.rows.saved, oct.identity.venturesCents, oct.identity.boughtCents], [37_000, 117_500, 192_500, 0, 25_000])
    assert.deepEqual([oct.left, oct.right], [119_500, 119_500])
    assert.equal(oct.identity.engineErrorCents, 0)
    assert.deepEqual(oct.bridge.ventures, [{ bucketId: t.venture, startCents: 400_000, endCents: 530_000 }])
    assert.deepEqual([oct.bridge.startCents, oct.bridge.endCents, oct.bridge.venturesCents, oct.bridge.savedCents, oct.bridge.engineErrorCents], [15_480_000, 15_815_500, 105_000, 192_500, 0])
    const terms = oct.bridge.savedCents + oct.bridge.growthCents + oct.bridge.revaluationCents + oct.bridge.venturesCents + oct.bridge.unsortedCents - oct.bridge.inTransitCents - oct.bridge.unexplainedCents + oct.bridge.otherCents
    assert.equal(terms, 335_500)
    // Oct 31: A 5,300.00 and 250.00 due, so E 5,050.00, stake 5,050.00 and V 5,300.00.
    const book = positionBook('2026-10-31')
    const balances = db.balancesOn([ACCOUNTS_TIE.wrenChecking, ACCOUNTS_TIE.wrenCard], '2026-10-31')
    assert.deepEqual(positionsOn(book, '2026-10-31', (id) => balances.get(id) ?? 0).get(t.venture), { lentCents: 0, borrowedCents: 0, dueCents: 25_000, shareBp: 10000, netAssetsCents: 530_000, equityCents: 505_000, stakeCents: 505_000, positionCents: 530_000 })
    assertCovered('2026-05', '2026-11')
    // Net worth on every day is the bridge's: at 100% the position is the accounts.
    assert.equal(new Map(getNetWorthSeries().points.map((p) => [p.day, p.cents])).get('2026-10-31'), 15_815_500)
  })

  test("a gift that paid the venture's cost stays the venture's line and is a One-off of Personal's", () => {
    runAssistantTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'gift' })
    // No habit of gifts to Quickfix Plumbing: read as Gifts & Donations, a one-off.
    const gifts = db.listCategories().find((c) => c.name === 'Gifts & Donations')!.id
    assert.deepEqual(ledgerLines('2026-10-20', '2026-10-20').filter((l) => l.txnId === t.repair).map((l) => [l.owner, l.cls, l.cents, l.categoryId, l.intent]), [[t.venture, 'oneOff', -25_000, gifts, 'gift']])
    const oct = figures('2026-10')
    assert.deepEqual([oct.rows.oneOffs, oct.part('oneOffs', `cat:${gifts}`), oct.identity.venturesCents, oct.identity.boughtCents], [70_000, 25_000, 8_000, 0])
    assert.deepEqual([oct.left, oct.right], [94_500, 94_500])
    // At 100% the gift leaves net worth where it was: Saved falls by it and Ventures(NW) rises by it.
    assert.deepEqual([oct.bridge.savedCents, oct.bridge.venturesCents, oct.bridge.endCents - oct.bridge.startCents, oct.bridge.engineErrorCents], [184_500 - 25_000, 113_000 + 25_000, 335_500, 0])
  })

  test('undo puts each line back to unset, and intent none does too', () => {
    const repair = runAssistantTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement' })
    const draw = runAssistantTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw' })
    revert(draw.changeId)
    assert.deepEqual([figures('2026-10').identity.venturesCents, figures('2026-10').rows.saved], [8_000, 184_500])
    revert(repair.changeId)
    assert.deepEqual(db.all('SELECT * FROM venture_money'), [])
    assert.deepEqual([figures('2026-10').identity.venturesCents, figures('2026-10').bridge.venturesCents], [-17_000, 113_000])
    runAssistantTool('set_venture_money', { transaction_ids: [t.repair, t.groceries], venture: 'Wren Rentals', intent: 'reimbursement' })
    assert.deepEqual([figures('2026-10').identity.venturesCents, figures('2026-10').identity.boughtCents], [0, 25_000 - 8_000])
    runAssistantTool('set_venture_money', { transaction_ids: [t.repair, t.groceries], venture: 'Wren Rentals', intent: 'none' })
    assert.deepEqual([figures('2026-10').identity.venturesCents, figures('2026-10').identity.boughtCents], [-17_000, 0])
  })
})

describe('example B: Kestrel Studio through set_venture_money', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 }))

  test('the shares come from the equity, and November: the rows, Cash return 30.00, Bought assets 3,900.00, Ventures 0, both sides 1,330.00, ΔNW 2,715.00, Ventures(NW) 1,385.00', () => {
    const k = kestrel({ shares: false })
    const [, mixed] = setParts(k, (name, input) => runAssistantTool(name, input))
    // Undo takes the parts and the share row it wrote back off, and the call again puts them back.
    revert(mixed)
    assert.deepEqual([sharesOf(k.venture).map((s) => s.fromDay), db.all('SELECT intent FROM venture_money WHERE txn_id = ?', k.mixed)], [['0000-01-01', '2026-01-15'], []])
    runAssistantTool('set_venture_money', { transaction_ids: [k.mixed], venture: 'Kestrel Studio', intent: 'loan', parts: [{ intent: 'loan', amount: 3000 }, { intent: 'equity', amount: 2000 }], share_after_pct: 50 })
    assert.deepEqual(sharesOf(k.venture), [
      { fromDay: '0000-01-01', shareBp: 0, source: 'migrated' },
      { fromDay: '2026-01-15', shareBp: 4000, source: 'review' },
      { fromDay: '2026-11-02', shareBp: 5000, source: 'review' }
    ])
    // The mixed transfer is replaced by a part an intent, each adding its intent to the key; the repayment by its
    // principal, which keeps the key, and its interest.
    assert.deepEqual(partsOfTxn(k.mixed, '2026-11-02'), [
      ['::p:loan', 'capital', -300_000, k.venture, 'loan', 'review'],
      ['::p:equity', 'capital', -200_000, k.venture, 'equity', 'review']
    ])
    assert.deepEqual(partsOfTxn(k.repayment, '2026-11-20'), [
      ['::p', 'capital', 100_000, k.venture, 'loan_repayment', 'review'],
      ['::p:int', 'cashReturn', 3_000, k.venture, 'loan_repayment', 'review']
    ])
    assert.deepEqual(partsOfTxn(k.groceries, '2026-11-12'), [
      ['::p', 'everyday', -10_000, null, null, null],
      ['::p:fund', 'capital', 10_000, k.venture, 'reimbursement', 'review']
    ])
    const nov = figures('2026-11')
    assert.deepEqual([nov.rows.takeHome, nov.rows.committed, nov.rows.elective, nov.rows.everyday, nov.rows.leftOver, nov.rows.oneOffs, nov.identity.keptCents, nov.rows.saved], [400_000, 200_000, 200_000, 70_000, 130_000, 0, 130_000, 130_000])
    assert.equal(nov.rows.gross ?? nov.rows.takeHome, 400_000)
    assert.deepEqual([nov.identity.cashReturnCents, nov.identity.boughtCents, nov.identity.venturesCents, nov.identity.checkingCents], [3_000, 390_000, 0, -257_000])
    assert.deepEqual([nov.left, nov.right, nov.identity.engineErrorCents], [133_000, 133_000, 0])
    assert.deepEqual([nov.bridge.startCents, nov.bridge.endCents, nov.bridge.growthCents, nov.bridge.venturesCents, nov.bridge.engineErrorCents], [1_000_000, 1_271_500, 3_000, 138_500, 0])
    assert.deepEqual(nov.bridge.ventures, [{ bucketId: k.venture, startCents: 400_000, endCents: 928_500 }])
    // E 14,770.00, stake 7,385.00, V 9,285.00; basis 6,000.00.
    const book = positionBook('2026-11-30')
    const balances = db.balancesOn([ACCOUNTS.kestrel], '2026-11-30')
    const p = positionsOn(book, '2026-11-30', (id) => balances.get(id) ?? 0).get(k.venture)!
    assert.deepEqual([p.lentCents, p.dueCents, p.equityCents, p.stakeCents, p.positionCents], [200_000, -10_000, 1_477_000, 738_500, 928_500])
    assert.deepEqual(basisThrough(book.parts.get(k.venture)!, '2026-11-30'), { basisCents: 600_000, aboveBasisCents: 0 })
    // January's equity bought 40% at book: net worth didn't move with it.
    const jan = figures('2026-01')
    assert.deepEqual([jan.identity.boughtCents, jan.identity.venturesCents, jan.bridge.endCents - jan.bridge.startCents, jan.bridge.venturesCents], [400_000, 0, 0, 0])
    assertCovered('2026-01', '2026-12')
  })

  test('by the estimate: ΔNW 330.00 and Ventures(NW) -1,000.00', () => {
    const k = kestrel({ stake: true })
    storeParts(k)
    runTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake }, 'assistant')
    const nov = figures('2026-11')
    assert.deepEqual([nov.bridge.startCents, nov.bridge.endCents, nov.bridge.venturesCents, nov.bridge.revaluationCents, nov.bridge.engineErrorCents], [1_400_000, 1_433_000, -100_000, 0, 0])
    assert.deepEqual([nov.left, nov.right], [133_000, 133_000])
    assert.equal(nov.bridge.savedCents + nov.bridge.growthCents + nov.bridge.venturesCents, 33_000)
  })

  test('the four refusals: parts that do not add up, a draw out, principal above what is lent, and equity on a migrated share', () => {
    const k = kestrel()
    storeParts(k)
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.mixed], venture: 'Kestrel Studio', intent: 'loan', parts: [{ intent: 'loan', amount: 3000 }, { intent: 'equity', amount: 1500 }] }, 'assistant'), /add up to \$4,500\.00, and TRANSFER TO KESTREL on 2026-11-02 is \$5,000\.00/)
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.mixed], venture: 'Kestrel Studio', intent: 'draw' }, 'assistant'), /draw is money back from a venture, and TRANSFER TO KESTREL on 2026-11-02 is money out to Kestrel Studio/)
    // A further 2,500.00 back on Nov 25, all principal, while 2,000.00 is lent.
    const back = line(ACCOUNTS.checking, '2026-11-25', 250_000, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    line(ACCOUNTS.kestrel, '2026-11-25', -250_000, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [back], venture: 'Kestrel Studio', intent: 'loan_repayment' }, 'assistant'), /pays back \$2,500\.00 of principal, and \$2,000\.00 is lent to Kestrel Studio that day/)
    // With 500.00 of it interest, it's what's lent.
    runTool('set_venture_money', { transaction_ids: [back], venture: 'Kestrel Studio', intent: 'loan_repayment', interest: 500 }, 'assistant')
    assert.equal(claimsThrough(positionBook('2026-11-30').parts.get(k.venture)!, '2026-11-30').lentCents, 0)
    db.closeDb()
    const m = kestrel({ shares: false })
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [m.equity], venture: 'Kestrel Studio', intent: 'equity' }, 'assistant'), /share is still the one net worth counted it at before shares were kept/)
    assert.deepEqual(db.all('SELECT * FROM venture_money'), [])
  })

  test('and the rest it refuses: interest above the line, a draw at share 0, a line marked capital, a line of another venture, and remember across patterns', () => {
    const k = kestrel({ shares: false })
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.repayment], venture: 'Kestrel Studio', intent: 'loan_repayment', interest: 1100 }, 'assistant'), /interest of \$1,100\.00 is above/)
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.repayment], venture: 'Kestrel Studio', intent: 'draw' }, 'assistant'), /owns none of Kestrel Studio on 2026-11-20/)
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.repayment], venture: 'Kestrel Studio', intent: 'gift', interest: 10 }, 'assistant'), /interest is a repayment's/)
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.equity, k.mixed], venture: 'Kestrel Studio', intent: 'equity', share_after_pct: 40 }, 'assistant'), /give one transaction/)
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.equity, k.repayment], venture: 'Kestrel Studio', intent: 'gift', remember: true }, 'assistant'), /one pattern/)
    const other = db.saveBucket({ name: 'Heron Fund', kind: 'business' })
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.mixed], venture: 'Heron Fund', intent: 'loan' }, 'assistant'), /money with Kestrel Studio, not Heron Fund/)
    // A Personal line with no venture of its own is tied to one (R): the rent, as a gift to Heron Fund.
    const rent = db.all<{ id: string }>("SELECT id FROM transactions WHERE description = 'ALDER LEASING RENT' ORDER BY posted DESC")[0].id
    runTool('set_venture_money', { transaction_ids: [rent], venture: 'Heron Fund', intent: 'trade' }, 'assistant')
    assert.deepEqual(partsOfTxn(rent, '2026-11-05').map((x) => x.slice(1, 5)), [['committed', -200_000, other, 'trade']])
    // A line with an intent is never marked capital, and one marked capital takes no intent.
    const car = db.addManualAccount({ name: 'Studio Van', assetType: 'vehicle', openedDay: '2026-01-15', costCents: 400_000, points: [{ day: '2026-01-15', cents: 400_000 }] })
    assert.throws(() => runTool('mark_capital', { transaction_ids: [rent], asset_id: car }, 'assistant'), /has an intent with Heron Fund/)
    runTool('mark_capital', { transaction_ids: [k.equity], asset_id: car }, 'assistant')
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [k.equity], venture: 'Kestrel Studio', intent: 'equity', share_after_pct: 40 }, 'assistant'), /marked as capital/)
  })

  test('intent none on the Nov 12 funding: Ventures +100.00, Bought assets 4,000.00, due 0, both sides 1,430.00; undo restores the reimbursement', () => {
    const k = kestrel()
    storeParts(k)
    const r = runAssistantTool('set_venture_money', { transaction_ids: [k.groceries], venture: 'Kestrel Studio', intent: 'none' })
    let nov = figures('2026-11')
    assert.deepEqual([nov.identity.venturesCents, nov.identity.boughtCents, nov.left, nov.right], [10_000, 400_000, 143_000, 143_000])
    assert.equal(claimsThrough(positionBook('2026-11-30').parts.get(k.venture)!, '2026-11-30').dueCents, 0)
    assert.deepEqual(partsOfTxn(k.groceries, '2026-11-12'), [['::p', 'everyday', -10_000, k.venture, null, null]])
    revert(r.changeId)
    nov = figures('2026-11')
    assert.deepEqual([nov.identity.venturesCents, nov.identity.boughtCents, nov.left, nov.right], [0, 390_000, 133_000, 133_000])
    assert.equal(claimsThrough(positionBook('2026-11-30').parts.get(k.venture)!, '2026-11-30').dueCents, -10_000)
  })

  test('the owner block lists every boundary line, the unset ones among them', () => {
    const k = kestrel()
    storeParts(k)
    runTool('set_venture_money', { transaction_ids: [k.mixed], venture: 'Kestrel Studio', intent: 'none' }, 'assistant')
    const owner = getVenture(k.venture).result.owner
    assert.deepEqual(owner.byIntent, [
      { intent: 'equity', inCents: 0, outCents: 400_000, interestCents: 0 },
      { intent: 'unset', inCents: 0, outCents: 500_000, interestCents: 0 },
      { intent: 'reimbursement', inCents: 10_000, outCents: 0, interestCents: 0 },
      { intent: 'loan_repayment', inCents: 103_000, outCents: 0, interestCents: 3_000 }
    ])
    assert.deepEqual(owner.lines.find((l) => l.txnId === k.mixed), { txnId: k.mixed, splitId: null, face: 'line', day: '2026-11-02', accountId: ACCOUNTS.checking, cents: -500_000, parts: [{ intent: null, cents: -500_000, interestCents: 0, source: null }] })
  })

  test('remember writes the answer for the lines\' one pattern, and undo takes it back', () => {
    const k = kestrel()
    const r = runAssistantTool('set_venture_money', { transaction_ids: [k.repayment], venture: 'Kestrel Studio', intent: 'draw', regular: true, remember: true })
    assert.deepEqual(db.all('SELECT venture_id, shape, direction, payee_key, intent, regular FROM venture_money_rules'), [{ venture_id: k.venture, shape: 'T', direction: 'in', payee_key: 'kestrel studio|+', intent: 'draw', regular: 1 }])
    // A regular draw is income: a part of Gross pay of its own.
    assert.equal(figures('2026-11').part('gross', `draw:${k.venture}`), 103_000)
    revert(r.changeId)
    assert.deepEqual([db.all('SELECT * FROM venture_money_rules'), db.all('SELECT * FROM venture_money')], [[], []])
  })
})

describe('example E: salary from Kestrel', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('two checks of 2,500.00 under its payroll key: Gross pay 5,000.00, basis deposits', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    const pay = ['2026-11-01', '2026-11-15'].map((day) => {
      line(ACCOUNTS.kestrel, day, -250_000, 'PAYROLL', 'Transfers', 'Kestrel Payroll Run')
      return line(ACCOUNTS.checking, day, 250_000, 'KESTREL STUDIO PAYROLL', 'Paycheck', 'Kestrel Studio Payroll')
    })
    runAssistantTool('set_venture_money', { transaction_ids: pay, venture: 'Kestrel Studio', intent: 'salary' })
    const w = getWaterfall({ from: '2026-11', to: '2026-11' })
    const gross = w.rows.find((r) => r.id === 'gross') ?? w.rows.find((r) => r.id === 'takeHome')!
    assert.deepEqual([gross.actualCents, gross.basis, gross.parts.map((p) => [p.key, p.actualCents])], [500_000, 'deposits', [['pay:kestrel studio payroll|+', 500_000]]])
    assert.deepEqual(partsOfTxn(pay[0], '2026-11-01'), [['::p', 'pay', 250_000, k, 'salary', 'review']])
    assert.equal(figures('2026-11').identity.venturesCents, 0)
  })
})

describe('example F: a venture loan at share 100%', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('Debt paid down -2,000.00, debtCost 20.00 in Committed, Ventures(NW) 20.00, and net worth unchanged', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    line(ACCOUNTS.kestrel, '2026-11-06', -300_000, 'LOAN TO OWNER', 'Transfers', 'Owner Transfer')
    const borrowed = line(ACCOUNTS.checking, '2026-11-06', 300_000, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    const repaid = line(ACCOUNTS.checking, '2026-11-30', -102_000, 'TRANSFER TO KESTREL', 'Transfers', 'Kestrel Studio')
    line(ACCOUNTS.kestrel, '2026-11-30', 102_000, 'LOAN REPAYMENT', 'Transfers', 'Owner Transfer')
    runAssistantTool('set_venture_money', { transaction_ids: [borrowed], venture: 'Kestrel Studio', intent: 'venture_loan' })
    runAssistantTool('set_venture_money', { transaction_ids: [repaid], venture: 'Kestrel Studio', intent: 'venture_loan_repayment', interest: 20 })
    const nov = figures('2026-11')
    assert.deepEqual([nov.identity.debtPaidCents, nov.rows.committed, nov.part('committed', `ventureLoan:${k}`), nov.identity.keptCents], [-200_000, 2_000, 2_000, -2_000])
    // Left in checking +1,980.00 and Debt paid down -2,000.00: -20.00 on both sides.
    assert.deepEqual([nov.identity.checkingCents, nov.left, nov.right], [198_000, -2_000, -2_000])
    // Kestrel Checking falls 1,980.00: ΔV -1,980.00, less the -2,000.00 of principal, is Ventures(NW) 20.00.
    assert.deepEqual(nov.bridge.ventures.map((v) => v.endCents - v.startCents), [-198_000])
    assert.deepEqual([nov.bridge.venturesCents, nov.bridge.endCents - nov.bridge.startCents, nov.bridge.engineErrorCents], [2_000, 0, 0])
    assert.deepEqual(claimsThrough(positionBook('2026-11-30').parts.get(k)!, '2026-11-30'), { lentCents: 0, borrowedCents: 200_000, dueCents: 0 })
    // Its interest is in December's Committed run rate: November's 20.00 over the 12-month window, over 12.
    const dec = getWaterfall({ from: '2026-12', to: '2026-12' }).rows.find((r) => r.id === 'committed')!.parts.find((p) => p.key === `ventureLoan:${k}`)
    assert.equal(dec?.runRateCents, 167)
  })
})

describe('example H: a paycheck account a venture holds', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('Gross pay 4,000.00 and Ventures -4,000.00; with a share and equity on both fundings, Bought assets 4,000.00, Ventures 0 and basis 4,000.00', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    db.upsertAccount({ id: ACCOUNTS.checking, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 400_000, availableCents: null, balanceDate: noonOn(2026, 11, 7) })
    db.updateAccount(ACCOUNTS.checking, { assetType: 'cash' })
    const pay = ['2026-10-15', '2026-10-31'].map((day) => line(ACCOUNTS.checking, day, 200_000, 'LANTERN PAYROLL', 'Paycheck', 'Lantern Payroll'))
    const shop = db.saveBucket({ name: 'Side Shop', kind: 'business' })
    db.updateAccount(ACCOUNTS.checking, { bucketId: shop })
    // The auto rule puts the deposits in the venture; the paycheck clause keeps them the user's pay.
    assert.deepEqual(db.all<{ bucket_id: number; bucket_source: string }>('SELECT bucket_id, bucket_source FROM transactions ORDER BY posted'), [{ bucket_id: shop, bucket_source: 'rule' }, { bucket_id: shop, bucket_source: 'rule' }])
    let oct = figures('2026-10')
    assert.deepEqual([oct.rows.gross ?? oct.rows.takeHome, oct.identity.venturesCents, oct.left, oct.right], [400_000, -400_000, 0, 0])
    assert.deepEqual(partsOfTxn(pay[0], '2026-10-15'), [['::p', 'pay', 200_000, shop, null, null]])
    assert.throws(() => runTool('set_venture_money', { transaction_ids: pay, venture: 'Side Shop', intent: 'equity' }, 'assistant'), /share is still the one/)
    runAssistantTool('set_venture_share', { venture: 'Side Shop', from: '2026-01-01', share_pct: 100 })
    runAssistantTool('set_venture_money', { transaction_ids: pay, venture: 'Side Shop', intent: 'equity' })
    oct = figures('2026-10')
    assert.deepEqual([oct.rows.gross ?? oct.rows.takeHome, oct.identity.boughtCents, oct.identity.venturesCents, oct.left, oct.right], [400_000, 400_000, 0, 400_000, 400_000])
    assert.deepEqual(partsOfTxn(pay[0], '2026-10-15'), [
      ['::p', 'pay', 200_000, null, null, null],
      ['::p:fund', 'capital', -200_000, shop, 'equity', 'review']
    ])
    assert.deepEqual(basisThrough(positionBook('2026-10-31').parts.get(shop)!), { basisCents: 400_000, aboveBasisCents: 0 })
    // Net worth rose by the pay, which the venture's position holds: Ventures(NW) is its rise less the equity, 0.
    assert.deepEqual([oct.bridge.endCents - oct.bridge.startCents, oct.bridge.venturesCents, oct.bridge.engineErrorCents], [400_000, 0, 0])
    assertCovered('2026-10', '2026-11')
  })
})

describe('an intent counts only while its line still crosses with its venture', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a line another account of Personal's holds the money of is never tied to a venture: to Savings, to the Brokerage, the car loan's payment", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    const t = tieOut()
    runAssistantTool('set_venture_share', { venture: 'Wren Rentals', from: '2000-01-01', share_pct: 50 })
    const nw = netWorthNow()
    const oct = figures('2026-10')
    const on = (description: string, day: string): string => db.all<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE description = ?', description).find((r) => db.dayKey(r.posted) === day)!.id
    for (const [id, held] of [
      [t.toSavings[0], /another of the user's cash and cards, which holds it already/],
      [on('TRANSFER TO BROKERAGE', '2026-10-27'), /an investment account, which holds it already/],
      [on('LARK AUTO FINANCE PMT', '2026-10-10'), /a debt, which holds it already/]
    ] as const) {
      assert.throws(() => runTool('set_venture_money', { transaction_ids: [id], venture: 'Wren Rentals', intent: 'loan' }, 'assistant'), held)
    }
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM venture_money')!.n, 0)
    const now = figures('2026-10')
    assert.deepEqual([netWorthNow(), now.identity.inTransitCents, now.identity.boughtCents, now.identity.debtPaidCents], [nw, oct.identity.inTransitCents, oct.identity.boughtCents, oct.identity.debtPaidCents])
  })

  test("Kestrel Checking leaves the venture: its stored parts count nowhere, net worth is the two accounts, Review asks once, and they count again when it's back", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrel()
    storeParts(k)
    db.updateAccount(ACCOUNTS.kestrel, { bucketId: null })
    // Checking 3,430.00 and Kestrel Checking 16,670.00, both Personal's: the 2,000.00 lent isn't counted again.
    assert.deepEqual([netWorthNow(), ...seriesOn('2026-11-30'), getBalanceSheet().netWorthCents], [2_010_000, 2_010_000, 2_010_000])
    assert.deepEqual(claimsThrough(positionBook('2026-11-30').parts.get(k.venture)!, '2026-11-30'), { lentCents: 0, borrowedCents: 0, dueCents: 0 })
    let nov = figures('2026-11')
    assert.deepEqual([nov.identity.boughtCents, nov.identity.inTransitCents, nov.identity.engineErrorCents, nov.bridge.engineErrorCents, nov.left - nov.right], [0, 0, 0, 0, 0])
    assert.deepEqual(partsOfTxn(k.mixed, '2026-11-02'), [['::p', 'internal', -500_000, null, null, null]])
    const stale = openIssues().filter((i) => i.key.startsWith(`venture_money:${k.venture}:stale:`))
    assert.deepEqual(stale.map((i) => [i.key, i.transaction_ids]), [[`venture_money:${k.venture}:stale:4:2026-11-20`, [k.repayment, k.groceries, k.mixed, k.equity]]])
    assert.match(stale[0].summary, /^4 lines have intents with Kestrel Studio that no longer fit them/)

    // Put back, the parts count again: 12,715.00, and no question.
    db.updateAccount(ACCOUNTS.kestrel, { bucketId: k.venture })
    assert.equal(netWorthNow(), 1_271_500)
    assert.deepEqual(issueKeys('venture_money'), [])

    // Taken out again, Review clears them (intent none), and the undo brings them and the question back.
    db.updateAccount(ACCOUNTS.kestrel, { bucketId: null })
    const r = runAssistantTool('set_venture_money', { transaction_ids: [k.equity, k.mixed, k.groceries, k.repayment], venture: 'Kestrel Studio', intent: 'none' })
    assert.deepEqual([db.get<{ n: number }>('SELECT COUNT(*) AS n FROM venture_money')!.n, issueKeys('venture_money'), netWorthNow()], [0, [], 2_010_000])
    revert(r.changeId)
    assert.deepEqual([db.get<{ n: number }>('SELECT COUNT(*) AS n FROM venture_money')!.n, issueKeys('venture_money')], [5, [`venture_money:${k.venture}:stale:4:2026-11-20`]])
    nov = figures('2026-11')
    assert.equal(nov.bridge.engineErrorCents, 0)
  })

  test("merging Checking's import into its bank feed keeps every line's intents: claims, basis and net worth as before, and the undo puts them back on the old rows", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrel()
    storeParts(k)
    const nw = netWorthNow()
    const owner = getVenture(k.venture).result.owner
    // The same Checking, as a bank feed reports it: its lines a day later, with ids of its own.
    db.upsertAccount({ id: 'plaid:chk', source: 'plaid', name: 'Checking (bank)', institution: null, currency: 'USD', balanceCents: 343_000, availableCents: null, balanceDate: noonOn(2026, 12, 7) })
    db.updateAccount('plaid:chk', { assetType: 'cash' })
    const rows = db.all<{ posted: number; amount_cents: number; description: string; category_id: number | null; merchant: string | null }>('SELECT posted, amount_cents, description, category_id, merchant FROM transactions WHERE account_id = ? ORDER BY posted', ACCOUNTS.checking)
    rows.forEach((r, i) => {
      db.upsertTransaction({ id: `feed${i}`, accountId: 'plaid:chk', posted: r.posted + 86_400, amountCents: r.amount_cents, description: r.description, pending: false })
      if (r.category_id !== null) db.setTransactionFields(`feed${i}`, { categoryId: r.category_id, source: 'user', ...(r.merchant ? { merchant: r.merchant } : {}) })
    })
    const r = runTool('merge_accounts', { from_account_id: ACCOUNTS.checking, into_account_id: 'plaid:chk' }, 'assistant')
    assert.equal((r.result as { matched: number }).matched, rows.length)
    assert.deepEqual(db.all<{ txn_id: string }>('SELECT txn_id FROM venture_money ORDER BY id').map((x) => x.txn_id.startsWith('feed') || x.txn_id === k.groceries), [true, true, true, true, true])
    const merged = getVenture(k.venture).result.owner
    assert.deepEqual([netWorthNow(), merged.lentCents, merged.dueCents, merged.basisCents, merged.positionCents], [nw, owner.lentCents, owner.dueCents, owner.basisCents, owner.positionCents])
    assert.deepEqual(issueKeys('venture_money'), [])
    revert(r.changeId)
    assert.deepEqual(db.all<{ txn_id: string }>('SELECT txn_id FROM venture_money ORDER BY id').map((x) => x.txn_id), [k.equity, k.mixed, k.mixed, k.groceries, k.repayment])
    // Both accounts are back, each holding 3,430.00, and the claims and basis with them.
    const back = getVenture(k.venture).result.owner
    assert.deepEqual([netWorthNow(), back.lentCents, back.basisCents], [nw + 343_000, owner.lentCents, owner.basisCents])
  })
})

describe('the classifier with intents, on the cost budget', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("every demo month classified within 1b's 300 ms against the reference", async (t) => {
    db.openDb(':memory:')
    loadDemoData()
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    const current = db.today().slice(0, 7)
    const months: string[] = []
    for (let m = first; m <= current; m = shiftMonth(m, 1)) months.push(m)
    const r = await paired(6, () => busyMs(() => months.forEach((m) => classifyLines(`${m}-01`, lastDay(m)))), (k) => db.setSetting('test.classifyRound', String(k)))
    t.diagnostic(within('classifying every demo month', CLASSIFY_MS, r))
    assert.ok(r.ratio <= budgetRatio(CLASSIFY_MS), within('classifying every demo month', CLASSIFY_MS, r))
  })
})

// ---------- acceptance: the parts together ----------

/**
 * The demo's and Elm St's figures before 1j, with the clock at Nov 7, 2026: every month's rows, cash identity and bridge
 * (each venture's position on the bridge came with 1j), Personal's net worth series on every day, the balance sheet's
 * net worth and net worth now, and every close's lines digest; the demo's closes with their raw, balances and rows
 * digests (the rows as engine version 2 reads them, with no positions). Each as sha-256 (16 hex) of its JSON, with each
 * manual account's name in place of its id (they are random).
 */
const BEFORE_1J = {
  demo: { months: '098b55c89c92aead', series: '85ed6d086cf82d1a', netWorthCents: 28_560_735, lines: 'c24283316cf45ff4', closes: '771c0404fe8a757c' },
  elm: { months: '3ac77b03d67f814a', series: '420afbb08af1778e', netWorthCents: 0, lines: 'e38bd55992b0691d' }
}

describe('acceptance: no figure moves with no intent set and the shares migrated', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)
  /** Each figure of the open ledger as BEFORE_1J digests it. */
  async function digests(): Promise<{ months: string; series: string; netWorthCents: number[]; lines: string; closes: string }> {
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    const norm = (v: unknown): string => {
      let s = JSON.stringify(v)
      for (const [id, n] of names) if (id.startsWith('manual:')) s = s.split(id).join(`acct:${n}`)
      return s
    }
    const cur = db.today().slice(0, 7)
    const figures: unknown[] = []
    for (let m = getWaterfall({ from: cur, to: cur }).firstMonth!; m <= cur; m = shiftMonth(m, 1)) {
      const w = getWaterfall({ from: m, to: m })
      const { ventures: _ventures, ...bridge } = w.bridge
      figures.push({ rows: w.rows, identity: w.identity, bridge })
    }
    const series = sha16(JSON.stringify(getNetWorthSeries().points))
    const netWorthCents = [getBalanceSheet().netWorthCents, netWorthNow()]
    await closeDueMonths()
    const closes = listSnapshots(1000)
    return {
      months: sha16(norm(figures)),
      series,
      netWorthCents,
      lines: sha16(JSON.stringify(closes.map((c) => [c.month, c.version, c.status, c.digests.lines]))),
      closes: sha16(JSON.stringify(closes.map((c) => [c.month, c.version, c.status, c.digests.lines, c.digests.raw, c.digests.balances, rowsDigest(monthClose(c.month).waterfall, 2)])))
    }
  }

  test('the demo: every month, net worth on every day and every close as before 1j, no closed month changes, and Review gains one share_unset, Bayview Condo, and no venture_money issue', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    loadDemoData()
    const now = await digests()
    const was = BEFORE_1J.demo
    assert.deepEqual(now, { months: was.months, series: was.series, netWorthCents: [was.netWorthCents, was.netWorthCents], lines: was.lines, closes: was.closes })
    const run = await checkClosed()
    assert.deepEqual([run.changed, run.reclosed, changedMonths()], [[], [], []])
    const bayview = db.listBuckets().find((b) => b.name === 'Bayview Condo')!
    assert.deepEqual([issueKeys('share_unset'), issueKeys('venture_money'), issueKeys('venture_paycheck'), issueKeys('venture_value')], [[`share_unset:${bayview.id}`], [], [], []])
  })

  test('Elm St: every figure as before 1j, no closed month changes, and Review gains two venture_money issues, (Elm St, C, out) and (Elm St, C, in), and one share_unset', async () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    const elm = elmSt()
    const { closes: _closes, ...now } = await digests()
    const was = BEFORE_1J.elm
    assert.deepEqual(now, { months: was.months, series: was.series, netWorthCents: [was.netWorthCents, was.netWorthCents], lines: was.lines })
    const run = await checkClosed()
    assert.deepEqual([run.changed, run.reclosed, changedMonths()], [[], [], []])
    assert.deepEqual(issueKeys('venture_money').map((k) => k.split(':').slice(0, 4).join(':')), [`venture_money:${elm.bucket}:C:in`, `venture_money:${elm.bucket}:C:out`])
    assert.deepEqual(issueKeys('share_unset'), [`share_unset:${elm.bucket}`])
  })
})

describe('the cost on a large ledger', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("Personal's series, the balance sheet and a 12M waterfall, each against the reference", async (t) => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    largeLedger({ from: '2018-12', invested: true })
    getWaterfall({ from: '2026-10', to: '2026-10' })
    const timed = async (what: string, budget: number, f: () => unknown): Promise<void> => {
      const r = await paired(6, () => busyMs(f), (k) => db.setSetting('test.ventureRound', String(k)))
      t.diagnostic(within(what, budget, r))
      assert.ok(r.ratio <= budgetRatio(budget), within(what, budget, r))
    }
    // Each round's write first, so each side reads the books as a page opened after a change does.
    await timed("Personal's net worth series", SERIES_MS, () => getNetWorthSeries())
    await timed('the balance sheet', SHEET_MS, () => getBalanceSheet())
    await timed('a 12M waterfall', WATERFALL_MS, () => getWaterfall({ from: '2025-11', to: '2026-10' }))
  })

  test('with a rental that holds no account and 75 lines of Checking placed in it, net worth reads no money book: the series, the balance sheet and net worth now on the same budgets', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    largeLedger({ from: '2018-12', invested: true })
    const cabin = db.saveBucket({ name: 'Cabin', kind: 'rental' })
    const placed = db.all<{ id: string }>("SELECT id FROM transactions WHERE account_id = 'csv:chk' AND amount_cents < 0 ORDER BY posted DESC LIMIT 75").map((r) => r.id)
    db.setTransactionsBucket(placed, cabin)
    getWaterfall({ from: '2026-10', to: '2026-10' })
    const timed = async (what: string, budget: number, f: () => unknown): Promise<void> => {
      const r = await paired(6, () => busyMs(f), (k) => db.setSetting('test.ventureRound', String(k)))
      t.diagnostic(within(what, budget, r))
      assert.ok(r.ratio <= budgetRatio(budget), within(what, budget, r))
    }
    await timed("Personal's net worth series", SERIES_MS, () => getNetWorthSeries())
    await timed('the balance sheet', SHEET_MS, () => getBalanceSheet())
    await timed('net worth now', NOW_MS, () => netWorthNow())
  })
})

/**
 * The budgets, each twice what it costs alone against the reference on the reference machine (the
 * series about 30 ms, the balance sheet about 24 ms, the 12M waterfall about 410 ms), so a run under the whole suite
 * doesn't fail it with nothing slower.
 */
const SERIES_MS = 60
/** Classifying every demo month: sub-phase 1b's budget, far above twice what it costs alone (about 35 ms, 2026-11-10). */
const CLASSIFY_MS = 300
const SHEET_MS = 50
const WATERFALL_MS = 850
/** Net worth now: over twice what it costs alone (about 20 ms, 2026-11-10). */
const NOW_MS = 45
