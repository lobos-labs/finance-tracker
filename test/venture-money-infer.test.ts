import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { boundaryParts, classifyLines, ledgerLines, linesFor } from '../src/main/lines.ts'
import { drillFilter, lineQuery } from '../src/renderer/src/pages/txnFilter.ts'
import { getBalanceSheet, getNetWorthSeries } from '../src/main/netWorth.ts'
import { openIssues, runAssistantTool, runTool } from '../src/main/tools.ts'
import { claimsThrough, DRAW_MATCH_PCT, intentParts, positionBook, ventureValues } from '../src/main/ventureMoney.ts'
import { getVenture } from '../src/main/ventures.ts'
import { getWaterfall } from '../src/main/waterfall.ts'
import { REIMBURSE_DAYS } from '../src/main/windows.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { CashIdentity, NetWorthBridge, StageId } from '../src/shared/types.ts'
import { budgetRatio, busyMs, paired, within } from './cost.ts'
import { noonOn } from './days.ts'
import { elmSt } from './fixtures/elm.ts'
import { largeLedger } from './fixtures/large-ledger.ts'
import { ACCOUNTS as TIE, line as tieLine, tieOut, type TieOut } from './fixtures/tieout.ts'
import { ACCOUNTS, kestrelBooks, line } from './fixtures/venture-money.ts'

// Money between Personal and a venture (waterfall spec addendum 1.11, sub-phase 1j), part 3: what a boundary line
// with no intent stored is read as. A remembered answer for its pattern first, then the first of the five safe
// inferences that applies (I1 support, I2 salary, I4 payback, I5 matched cost, I3 draw), else it stays unset, in the
// Ventures term; and Review's questions about what's left unset: one venture_money issue per pattern, and one
// venture_paycheck issue per account a venture holds that pay lands on. On the section 2 tie-out (example A),
// Kestrel Studio's two accounts (examples C, E and the patterns), a parent the user supports (D), a duplex the user
// lives in (G), a paycheck account a venture holds (H), the demo and Elm St.

configureLicense({ dev: true })

const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const issueKeys = (kind: string): string[] => openIssues().filter((i) => i.kind === kind).map((i) => i.key).sort()
const issuesOf = (kind: string): ReturnType<typeof openIssues> => openIssues().filter((i) => i.kind === kind)
function revert(changeId: number | undefined): void {
  const c = db.getChange(changeId!)!
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId!)
}

/** A span's figures: each row's actual (Gross pay read with Take-home when there's no paystub), the cash identity with its two sides, the bridge and a row's part. */
function figures(from: string, to = from): { rows: Partial<Record<StageId, number>>; identity: CashIdentity; left: number; right: number; bridge: NetWorthBridge; part: (row: StageId, key: string) => { actualCents: number; runRateCents: number | null; name: string } | undefined } {
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
    part: (row, key) => w.rows.find((r) => r.id === merged(row))?.parts.find((p) => p.key === key)
  }
}

/** A transaction's boundary parts as the ledger lists them: key, class, cents, venture, intent and who set it. */
const partsOfTxn = (txnId: string, day: string): Array<[string, string, number, number | null, string | null, string | null]> =>
  ledgerLines(day, day)
    .filter((l) => l.txnId === txnId)
    .map((l) => [l.key.slice(txnId.length), l.cls, l.cents, l.ventureId, l.intent, l.intentSource])

/** A transaction's intent and who set it, as the ledger lists its first boundary part. */
const intentOf = (txnId: string, day: string): [string | null, string | null] => {
  const p = ledgerLines(day, day).find((l) => l.txnId === txnId && l.ventureId !== null)
  return [p?.intent ?? null, p?.intentSource ?? null]
}

/** Money from Kestrel Checking into Checking on a day, by transfer: its line on Checking. */
const fromKestrel = (day: string, cents: number): string => {
  line(ACCOUNTS.kestrel, day, -cents, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
  return line(ACCOUNTS.checking, day, cents, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
}
/** Money from Checking into Kestrel Checking on a day, by transfer: its line on Checking. */
const toKestrel = (day: string, cents: number): string => {
  const out = line(ACCOUNTS.checking, day, -cents, 'TRANSFER TO KESTREL', 'Transfers', 'Kestrel Studio')
  line(ACCOUNTS.kestrel, day, cents, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
  return out
}
/** A cost of Kestrel's paid from Checking (C): its line, placed in the venture. */
const kestrelCost = (venture: number, day: string, cents: number, description = 'STUDIO SUPPLIES'): string => {
  const id = line(ACCOUNTS.checking, day, -cents, description, 'Other', 'Studio Supplies')
  db.setTransactionsBucket([id], venture)
  return id
}

describe('example A: the payback of a reimbursement, and a matched cost', () => {
  let t: TieOut
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })
  const payback = (): string => {
    tieLine(TIE.wrenChecking, '2026-11-04', -25_000, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
    return tieLine(TIE.checking, '2026-11-04', 25_000, 'TRANSFER FROM WREN', 'Transfers', 'Wren Rentals')
  }

  test('with the repair a reimbursement and the groceries a draw, the Nov 4 250.00 is reimbursement by I4: capital +250.00, Bought assets -250.00 in November, due 0', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    t = tieOut()
    runAssistantTool('set_venture_money', { transaction_ids: [t.repair], venture: 'Wren Rentals', intent: 'reimbursement' })
    runAssistantTool('set_venture_money', { transaction_ids: [t.groceries], venture: 'Wren Rentals', intent: 'draw' })
    const back = payback()
    assert.deepEqual(partsOfTxn(back, '2026-11-04'), [['::p', 'capital', 25_000, t.venture, 'reimbursement', 'inferred']])
    const nov = figures('2026-11')
    assert.deepEqual([nov.identity.boughtCents, nov.identity.venturesCents, nov.identity.engineErrorCents, nov.left - nov.right], [-25_000, 0, 0, 0])
    assert.deepEqual(claimsThrough(positionBook('2026-11-30').parts.get(t.venture)!, '2026-10-31'), { lentCents: 0, borrowedCents: 0, dueCents: 25_000 })
    assert.deepEqual(claimsThrough(positionBook('2026-11-30').parts.get(t.venture)!, '2026-11-30'), { lentCents: 0, borrowedCents: 0, dueCents: 0 })
    // October keeps example A's figures, and nothing is left to ask about.
    const oct = figures('2026-10')
    assert.deepEqual([oct.rows.saved, oct.identity.venturesCents, oct.identity.boughtCents, oct.bridge.venturesCents], [192_500, 0, 25_000, 105_000])
    assert.deepEqual(issueKeys('venture_money'), [])
  })

  test('with both October intents unset, the Oct 20 repair and the Nov 4 transfer are both reimbursement by I5', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    t = tieOut()
    const before = figures('2026-10')
    const back = payback()
    assert.deepEqual(partsOfTxn(t.repair, '2026-10-20'), [[`::${t.venture}`, 'capital', -25_000, t.venture, 'reimbursement', 'inferred']])
    assert.deepEqual(partsOfTxn(back, '2026-11-04'), [['::p', 'capital', 25_000, t.venture, 'reimbursement', 'inferred']])
    // The groceries' funding has no match, and stays unset.
    assert.deepEqual(partsOfTxn(t.groceries, '2026-10-09'), [['::p', 'everyday', -8_000, t.venture, null, null]])
    // October: only Ventures and Bought assets move, by the repair; every row, Ventures(NW) and ΔNW are as they were.
    const oct = figures('2026-10')
    assert.deepEqual([before.identity.venturesCents, before.identity.boughtCents], [-17_000, 0])
    assert.deepEqual([oct.identity.venturesCents, oct.identity.boughtCents, oct.left, oct.right], [8_000, 25_000, 119_500, 119_500])
    assert.deepEqual([oct.rows.saved, oct.bridge.venturesCents, oct.bridge.endCents - oct.bridge.startCents, oct.bridge.engineErrorCents], [184_500, 113_000, 335_500, 0])
    for (const id of ['gross', 'takeHome', 'committed', 'everyday', 'oneOffs', 'saved'] as StageId[]) assert.equal(oct.rows[id], before.rows[id], id)
    assert.deepEqual([figures('2026-11').identity.boughtCents, claimsThrough(positionBook('2026-11-30').parts.get(t.venture)!, '2026-11-30').dueCents], [-25_000, 0])
    // What's left is the groceries' funding: one pattern.
    assert.deepEqual(issueKeys('venture_money'), [`venture_money:${t.venture}:F:in:2026-10-09`])
  })
})

describe('example C: a draw pattern', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** Kestrel at 100%, with no loans: 1,500.00 on Sep 15, Oct 15 and Nov 15, 1,510.00 on Dec 15 and 1,700.00 on 2027-01-15. */
  function draws(o: { lent?: boolean } = {}): { k: number; ids: Record<'sep' | 'oct' | 'nov' | 'dec' | 'jan', string>; loan?: string } {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 2, 7) * 1000 })
    const k = kestrelBooks()
    const loan = o.lent ? toKestrel('2026-10-01', 200_000) : undefined
    if (loan) runTool('set_venture_money', { transaction_ids: [loan], venture: 'Kestrel Studio', intent: 'loan' }, 'assistant')
    const ids = {
      sep: fromKestrel('2026-09-15', 150_000),
      oct: fromKestrel('2026-10-15', 150_000),
      nov: fromKestrel('2026-11-15', 150_000),
      dec: fromKestrel('2026-12-15', 151_000),
      jan: fromKestrel('2027-01-15', 170_000)
    }
    return { k, ids, loan }
  }

  test('Sep and Oct unset with one issue; Nov and Dec inferred regular draws in Gross pay; Jan unset in the same issue; December’s Draws run rate 1,003.33', () => {
    const { k, ids } = draws()
    assert.equal(DRAW_MATCH_PCT, 1)
    assert.deepEqual(['2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15'].map((d, i) => intentOf(Object.values(ids)[i], d)), [
      [null, null],
      [null, null],
      ['draw', 'inferred'],
      ['draw', 'inferred'],
      [null, null]
    ])
    for (const m of ['2026-09', '2026-10']) assert.equal(figures(m).identity.venturesCents, 150_000, m)
    const nov = figures('2026-11')
    assert.deepEqual(partsOfTxn(ids.nov, '2026-11-15'), [['::p', 'income', 150_000, k, 'draw', 'inferred']])
    assert.deepEqual([nov.part('gross', `draw:${k}`)?.name, nov.part('gross', `draw:${k}`)?.actualCents, nov.identity.venturesCents], ['Draws · Kestrel Studio', 150_000, 0])
    // December's run rate is the draws over its window, Oct to Dec, over 3: October's is unset.
    assert.equal(figures('2026-12').part('gross', `draw:${k}`)?.runRateCents, 100_333)
    assert.equal(figures('2027-01').identity.venturesCents, 170_000)
    // One issue for the pattern, listing Sep, Oct and Jan.
    const issues = issuesOf('venture_money')
    assert.equal(issues.length, 1)
    assert.equal(issues[0].key, `venture_money:${k}:T:in:kestrel studio|+:2027-01-15`)
    assert.match(issues[0].summary, /^3 lines of transfers from Kestrel Studio into the user's accounts \("kestrel studio"\) have no intent \(\$4,700\.00 in, 2026-09-15 to 2027-01-15; \$1,500\.00 × 2, \$1,700\.00 × 1\)/)
    assert.deepEqual([...issues[0].transaction_ids!].sort(), [ids.sep, ids.oct, ids.jan].sort())
  })

  test("the Draws part's drill opens on its lines alone, through the Transactions filter, with other income in the month", () => {
    const { k, ids } = draws()
    line(ACCOUNTS.checking, '2026-11-20', 30_000, 'ETSY PAYOUT', 'Other Income', 'Etsy')
    const part = getWaterfall({ from: '2026-11', to: '2026-11' }).rows.flatMap((r) => r.parts).find((p) => p.key === `draw:${k}`)!
    const q = lineQuery(drillFilter(part.drill, part.name), '2027-02-07')!
    const page = linesFor(q)
    assert.deepEqual([page.total, page.cents, page.lines.map((l) => l.txnId)], [1, part.actualCents, [ids.nov]])
  })

  test('in November, against the unset version: Saved 1,500.00 higher, Ventures(NW) 1,500.00 lower, ΔNW unchanged', () => {
    const { ids } = draws()
    const drawn = figures('2026-11')
    const r = runAssistantTool('set_venture_money', { transaction_ids: [ids.nov], venture: 'Kestrel Studio', intent: 'other' })
    const unset = figures('2026-11')
    assert.equal(unset.identity.venturesCents, 150_000)
    assert.deepEqual(
      [drawn.rows.saved! - unset.rows.saved!, drawn.bridge.venturesCents - unset.bridge.venturesCents, drawn.bridge.endCents - drawn.bridge.startCents - (unset.bridge.endCents - unset.bridge.startCents)],
      [150_000, -150_000, 0]
    )
    revert(r.changeId)
    assert.deepEqual(intentOf(ids.nov, '2026-11-15'), ['draw', 'inferred'])
  })

  test("after Review answers draw, regular, on Sep, Oct and Jan: December's run rate 1,503.33 and January's 1,570.00, and no issue", () => {
    const { k, ids } = draws()
    runAssistantTool('set_venture_money', { transaction_ids: [ids.sep, ids.oct, ids.jan], venture: 'Kestrel Studio', intent: 'draw', regular: true })
    assert.equal(figures('2026-12').part('gross', `draw:${k}`)?.runRateCents, 150_333)
    assert.equal(figures('2027-01').part('gross', `draw:${k}`)?.runRateCents, 157_000)
    assert.deepEqual(issueKeys('venture_money'), [])
  })

  test('with 2,000.00 lent to Kestrel on Oct 1 and still outstanding, the Nov line is not inferred', () => {
    const { k, ids } = draws({ lent: true })
    assert.equal(claimsThrough(positionBook('2026-11-30').parts.get(k)!, '2026-11-14').lentCents, 200_000)
    assert.deepEqual([intentOf(ids.nov, '2026-11-15'), intentOf(ids.dec, '2026-12-15')], [
      [null, null],
      [null, null]
    ])
  })
})

describe('example D: support for a parent the user owns none of', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** Mom (kind person, at share 0 unless `owned`) holds Mom Checking; Checking sends it 400.00 on the 1st of July to December 2026, in Transfers. */
  function mom(o: { owned?: boolean } = {}): { mom: number; ids: string[]; gifts: number } {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 1, 7) * 1000 })
    db.openDb(':memory:')
    const now = noonOn(2027, 1, 7)
    for (const [id, name, cents] of [
      [ACCOUNTS.checking, 'Checking', 500_000],
      ['csv:mom', 'Mom Checking', 300_000]
    ] as const) {
      db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: now })
      db.updateAccount(id, { assetType: 'cash' })
    }
    const venture = db.saveBucket({ name: 'Mom', kind: 'person', inNetWorth: !!o.owned })
    db.updateAccount('csv:mom', { bucketId: venture })
    const ids = ['07', '08', '09', '10', '11', '12'].map((m) => {
      line('csv:mom', `2026-${m}-01`, 40_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
      return line(ACCOUNTS.checking, `2026-${m}-01`, -40_000, 'TRANSFER TO MOM', 'Transfers', 'Mom')
    })
    return { mom: venture, ids, gifts: db.listCategories().find((c) => c.name === 'Gifts & Donations')!.id }
  }

  test('I1 makes each a gift: July to September oneOff, October to December everyday as Gifts & Donations; December’s run rates 400.00 and 100.00; Ventures 0; Mom Checking out of net worth', () => {
    const { mom: v, ids, gifts } = mom()
    const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']
    assert.deepEqual(
      ids.map((id, i) => partsOfTxn(id, `${months[i]}-01`)),
      months.map((_, i) => [['::p', i < 3 ? 'oneOff' : 'everyday', -40_000, v, 'gift', 'inferred']])
    )
    assert.deepEqual(ledgerLines('2026-10-01', '2026-10-01').filter((l) => l.txnId === ids[3]).map((l) => l.categoryId), [gifts])
    const dec = figures('2026-12')
    assert.deepEqual([dec.part('everyday', `cat:${gifts}`)?.runRateCents, dec.part('oneOffs', `cat:${gifts}`)?.runRateCents], [40_000, 10_000])
    for (const m of months) assert.equal(figures(m).identity.venturesCents, 0, m)
    // At share 0 Mom's account is nothing of the user's: net worth is Checking alone, and the gifts are spent.
    const sheet = getBalanceSheet()
    assert.equal(sheet.netWorthCents, 500_000)
    assert.ok(!sheet.groups.some((g) => g.accounts.some((x) => x.account.id === 'csv:mom')))
    assert.equal(new Map(getNetWorthSeries().points.map((p) => [p.day, p.cents])).get('2026-12-31'), 500_000)
    assert.deepEqual(issueKeys('venture_money'), [])
  })

  test('confirming the series makes every month committed 400.00', () => {
    const { ids } = mom()
    db.setRecurringOverride('mom|-', { status: 'confirmed' })
    const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']
    assert.deepEqual(
      ids.map((id, i) => partsOfTxn(id, `${months[i]}-01`)[0][1]),
      months.map(() => 'committed')
    )
    for (const m of months) assert.equal(figures(m).rows.committed, 40_000, m)
  })

  test('at share 100% I1 does not apply: each line is unset, Ventures -400.00 a month, and one venture_money issue', () => {
    const { mom: v, ids } = mom({ owned: true })
    for (const m of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) assert.equal(figures(m).identity.venturesCents, -40_000, m)
    assert.deepEqual(intentOf(ids[5], '2026-12-01'), [null, null])
    assert.deepEqual(issueKeys('venture_money'), [`venture_money:${v}:T:out:mom|-:2026-12-01`])
  })
})

describe('example E: salary by I2', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('two checks of 2,500.00 from Kestrel Studio Payroll, with its legs in Transfers: salary, 5,000.00 in Gross pay, basis deposits', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    const pay = ['2026-11-01', '2026-11-15'].map((day) => {
      line(ACCOUNTS.kestrel, day, -250_000, 'PAYROLL', 'Transfers', 'Kestrel Payroll Run')
      return line(ACCOUNTS.checking, day, 250_000, 'KESTREL STUDIO PAYROLL', 'Paycheck', 'Kestrel Studio Payroll')
    })
    const w = getWaterfall({ from: '2026-11', to: '2026-11' })
    const gross = w.rows.find((r) => r.id === 'gross') ?? w.rows.find((r) => r.id === 'takeHome')!
    assert.deepEqual([gross.actualCents, gross.basis, gross.parts.map((p) => [p.key, p.actualCents])], [500_000, 'deposits', [['pay:kestrel studio payroll|+', 500_000]]])
    assert.deepEqual(partsOfTxn(pay[0], '2026-11-01'), [['::p', 'pay', 250_000, k, 'salary', 'inferred']])
    assert.deepEqual([figures('2026-11').identity.venturesCents, issueKeys('venture_money')], [0, []])
  })

  test("an employer's paycheck the same as a transfer out of Kestrel's account is never that transfer's leg: a deposit filed as income is, and with none the paycheck is pay, as before 1j", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    const checks = ['08', '09', '10', '11'].map((m) => line(ACCOUNTS.checking, `2026-${m}-16`, 200_000, 'GLOBEX PAYROLL', 'Paycheck', 'Globex Payroll'))
    const sent = line(ACCOUNTS.kestrel, '2026-10-15', -200_000, 'TRANSFER TO OWNER', 'Transfers', 'Owner Transfer')
    // With nothing else of its amount near it, the transfer has no leg: the October check is pay, and Kestrel paid no wages.
    assert.deepEqual(partsOfTxn(checks[2], '2026-10-16'), [['::p', 'pay', 200_000, null, null, null]])
    assert.equal(db.transferPairs('2026-10-01', '2026-10-31').pairOf.get(sent), undefined)
    assert.equal(getVenture(k).result.operatingCents, 0)
    // A deposit three days after it, filed as income, is its leg, as it was before 1j, though the check is a day nearer.
    const deposit = line(ACCOUNTS.checking, '2026-10-18', 200_000, 'MOBILE DEPOSIT', 'Other Income', 'Mobile Deposit')
    assert.equal(db.transferPairs('2026-10-01', '2026-10-31').pairOf.get(sent)?.id, deposit)
    const oct = figures('2026-10')
    assert.deepEqual([oct.rows.takeHome, oct.rows.saved, oct.identity.venturesCents], [200_000, 200_000, 200_000])
    assert.deepEqual(partsOfTxn(checks[2], '2026-10-16'), [['::p', 'pay', 200_000, null, null, null]])
  })
})

describe('example G: a rental the user lives in, phase 1', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the CITY WATER funding is unset with one issue for (Maple Duplex, F, in); the Oct 25 transfer makes both reimbursement by I5', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    const now = noonOn(2026, 11, 7)
    for (const [id, name, cents] of [
      [ACCOUNTS.checking, 'Checking', 400_000],
      ['csv:maple', 'Maple Checking', 200_000]
    ] as const) {
      db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: now })
      db.updateAccount(id, { assetType: 'cash' })
    }
    const maple = db.saveBucket({ name: 'Maple Duplex', kind: 'rental', residenceFrom: '2026-01-01' })
    db.updateAccount('csv:maple', { bucketId: maple })
    const house = db.addManualAccount({ name: 'Maple house', assetType: 'property', openedDay: '2025-06-01', costCents: 40_000_000, points: [{ day: '2025-06-01', cents: 40_000_000 }] })
    db.updateAccount(house, { bucketId: maple })
    // The residence dates become Personal's use of the house, as the books do when they next open.
    assert.equal(db.convertResidences(), 1)
    const water = line('csv:maple', '2026-10-12', -9_000, 'CITY WATER', 'Utilities', 'City Water')
    // The bill is Personal's, in Everyday; its funding, +90.00, is an F part, in.
    assert.deepEqual(partsOfTxn(water, '2026-10-12'), [['::p', 'everyday', -9_000, maple, null, null]])
    assert.equal(figures('2026-10').identity.venturesCents, 9_000)
    assert.deepEqual(issueKeys('venture_money'), [`venture_money:${maple}:F:in:2026-10-12`])

    const back = line(ACCOUNTS.checking, '2026-10-25', -9_000, 'TRANSFER TO MAPLE', 'Transfers', 'Maple Duplex')
    line('csv:maple', '2026-10-25', 9_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
    assert.deepEqual(partsOfTxn(water, '2026-10-12'), [
      ['::p', 'everyday', -9_000, null, null, null],
      ['::p:fund', 'capital', 9_000, maple, 'reimbursement', 'inferred']
    ])
    assert.deepEqual(partsOfTxn(back, '2026-10-25'), [['::p', 'capital', -9_000, maple, 'reimbursement', 'inferred']])
    const oct = figures('2026-10')
    assert.deepEqual([oct.identity.boughtCents, oct.identity.venturesCents, oct.identity.engineErrorCents, oct.left - oct.right], [0, 0, 0, 0])
    assert.equal(claimsThrough(positionBook('2026-10-31').parts.get(maple)!, '2026-10-31').dueCents, 0)
    assert.deepEqual(issueKeys('venture_money'), [])
  })

  test("with no house, the residence dates make the venture's own leg of the transfer Personal's, and the transfer is still one crossing: one question, due 0 and Bought assets 0, one loan of 90.00", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    const now = noonOn(2026, 11, 7)
    for (const [id, name, cents] of [
      [ACCOUNTS.checking, 'Checking', 400_000],
      ['csv:maple', 'Maple Checking', 200_000]
    ] as const) {
      db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: now })
      db.updateAccount(id, { assetType: 'cash' })
    }
    const maple = db.saveBucket({ name: 'Maple Duplex', kind: 'rental', residenceFrom: '2026-01-01' })
    db.updateAccount('csv:maple', { bucketId: maple })
    const water = line('csv:maple', '2026-10-12', -9_000, 'CITY WATER', 'Utilities', 'City Water')
    const back = line(ACCOUNTS.checking, '2026-10-25', -9_000, 'TRANSFER TO MAPLE', 'Transfers', 'Maple Duplex')
    const leg = line('csv:maple', '2026-10-25', 9_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
    // The leg on Maple Checking is Personal's by the legacy clause, internal as before 1j; its crossing is the line on
    // Checking, so it's no funding of its own.
    assert.deepEqual(partsOfTxn(leg, '2026-10-25'), [['::p', 'internal', 9_000, maple, null, null]])
    assert.deepEqual(partsOfTxn(back, '2026-10-25'), [['::p', 'capital', -9_000, maple, 'reimbursement', 'inferred']])
    assert.deepEqual(partsOfTxn(water, '2026-10-12').map((p) => p.slice(1, 5)), [
      ['everyday', -9_000, null, null],
      ['capital', 9_000, maple, 'reimbursement']
    ])
    let oct = figures('2026-10')
    // Ventures and In transit hold the Personal leg, as they did before 1j.
    assert.deepEqual([oct.identity.boughtCents, oct.identity.venturesCents, oct.identity.inTransitCents, oct.identity.engineErrorCents, oct.bridge.engineErrorCents, oct.left - oct.right], [0, -9_000, -9_000, 0, 0, 0])
    assert.equal(claimsThrough(positionBook('2026-10-31').parts.get(maple)!, '2026-10-31').dueCents, 0)
    assert.deepEqual(issueKeys('venture_money'), [])
    // At 50% the inferences claim nothing: net worth is Checking and half of Maple Checking.
    runAssistantTool('set_venture_share', { venture: 'Maple Duplex', from: '2000-01-01', share_pct: 50 })
    assert.equal(getBalanceSheet().netWorthCents, 400_000 + 100_000)
    // The leg takes no intent; the line on Checking takes the one loan.
    assert.throws(() => runTool('set_venture_money', { transaction_ids: [leg], venture: 'Maple Duplex', intent: 'loan' }, 'assistant'), /the venture's own leg of a transfer/)
    runAssistantTool('set_venture_money', { transaction_ids: [back], venture: 'Maple Duplex', intent: 'loan' })
    assert.deepEqual(claimsThrough(positionBook('2026-10-31').parts.get(maple)!, '2026-10-31'), { lentCents: 9_000, borrowedCents: 0, dueCents: 0 })
    assert.equal(getBalanceSheet().netWorthCents, 400_000 + 9_000 + Math.floor(((200_000 - 9_000) * 5000 + 5000) / 10000))
    oct = figures('2026-10')
    assert.deepEqual([oct.identity.boughtCents, oct.bridge.engineErrorCents, oct.left - oct.right], [9_000, 0, 0])
    assert.deepEqual(issueKeys('venture_money'), [`venture_money:${maple}:F:in:2026-10-12`])
    assert.match(issuesOf('venture_money')[0].summary, /^1 line of Personal costs Maple Duplex's cash and cards paid has no intent/)
  })

  test("Kestrel's own leg of a repayment placed in Personal is no second crossing: the line on Checking holds it", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    kestrelBooks()
    const repaid = line(ACCOUNTS.checking, '2026-11-20', 103_000, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    const leg = line(ACCOUNTS.kestrel, '2026-11-20', -103_000, 'TRANSFER TO CHECKING', 'Transfers', 'Owner Transfer')
    const before = issueKeys('venture_money')
    db.setTransactionsBucket([leg], null)
    assert.deepEqual(issueKeys('venture_money'), before)
    assert.deepEqual(boundaryParts().units.map((u) => [u.txnId, u.shape, u.cents]), [[repaid, 'T', 103_000]])
  })
})

describe('example H: one venture_paycheck issue', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('pay landing on a checking account a venture holds raises one venture_paycheck for the account, and no venture_money; equity on the fundings answers it', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    db.upsertAccount({ id: ACCOUNTS.checking, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 400_000, availableCents: null, balanceDate: noonOn(2026, 11, 7) })
    db.updateAccount(ACCOUNTS.checking, { assetType: 'cash' })
    const pay = ['2026-10-15', '2026-10-31'].map((day) => line(ACCOUNTS.checking, day, 200_000, 'LANTERN PAYROLL', 'Paycheck', 'Lantern Payroll'))
    const shop = db.saveBucket({ name: 'Side Shop', kind: 'business' })
    db.updateAccount(ACCOUNTS.checking, { bucketId: shop })
    assert.equal(figures('2026-10').identity.venturesCents, -400_000)
    const issues = issuesOf('venture_paycheck')
    assert.deepEqual(issues.map((i) => [i.key, i.account_id, [...i.transaction_ids!].sort()]), [[`venture_paycheck:${ACCOUNTS.checking}`, ACCOUNTS.checking, [...pay].sort()]])
    assert.match(issues[0].summary, /^Checking is Side Shop's, and 2 paychecks land on it \(\$4,000\.00, 2026-10-15 to 2026-10-31\)/)
    assert.deepEqual(issueKeys('venture_money'), [])
    runAssistantTool('set_venture_share', { venture: 'Side Shop', from: '2026-01-01', share_pct: 100 })
    runAssistantTool('set_venture_money', { transaction_ids: pay, venture: 'Side Shop', intent: 'equity' })
    assert.deepEqual([issueKeys('venture_paycheck'), issueKeys('venture_money')], [[], []])
  })
})

describe('a remembered answer', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('gives the later lines of its pattern its intent, and raises no issue for them', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    // Money back from Kestrel of different amounts each month: nothing infers it.
    const first = fromKestrel('2026-09-10', 120_000)
    const second = fromKestrel('2026-10-10', 95_000)
    assert.equal(issuesOf('venture_money').length, 1)
    const r = runAssistantTool('set_venture_money', { transaction_ids: [first], venture: 'Kestrel Studio', intent: 'draw', remember: true })
    const later = fromKestrel('2026-11-10', 132_500)
    assert.deepEqual([intentOf(first, '2026-09-10'), intentOf(second, '2026-10-10'), intentOf(later, '2026-11-10')], [
      ['draw', 'review'],
      ['draw', 'rule'],
      ['draw', 'rule']
    ])
    // A remembered draw is a draw by its own regularity: November's has one in each of the 2 months before.
    assert.deepEqual(partsOfTxn(later, '2026-11-10'), [['::p', 'income', 132_500, k, 'draw', 'rule']])
    assert.deepEqual(issueKeys('venture_money'), [])
    // Its claims read the remembered parts as they read the stored ones: a remembered loan repayment never takes more
    // principal than is lent.
    revert(r.changeId)
    assert.deepEqual([intentOf(second, '2026-10-10'), issuesOf('venture_money').length], [[null, null], 1])
    const lent = toKestrel('2026-08-01', 100_000)
    runAssistantTool('set_venture_money', { transaction_ids: [lent], venture: 'Kestrel Studio', intent: 'loan' })
    runAssistantTool('set_venture_money', { transaction_ids: [second], venture: 'Kestrel Studio', intent: 'loan_repayment', remember: true })
    // 1,000.00 lent: September's 1,200.00 would be more principal than that, and November's 1,325.00 more than the 50.00 left.
    assert.deepEqual([intentOf(first, '2026-09-10'), intentOf(second, '2026-10-10'), intentOf(later, '2026-11-10')], [
      [null, null],
      ['loan_repayment', 'review'],
      [null, null]
    ])
    assert.equal(claimsThrough(intentParts('0000-01-01', '9999-12-31').filter((p) => p.ventureId === k), '2026-12-31').lentCents, 5_000)
  })

  test('never gives equity on a migrated share, nor a draw at share 0: such a line stays unset', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    const out = [toKestrel('2026-09-01', 50_000), toKestrel('2026-10-01', 50_000)]
    db.run("INSERT INTO venture_money_rules (venture_id, shape, direction, payee_key, intent, created_at) VALUES (?, 'T', 'out', 'kestrel studio|-', 'equity', 0)", k)
    assert.deepEqual(intentOf(out[1], '2026-10-01'), [null, null])
    runTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-01-01', share_pct: 100 }, 'assistant')
    assert.deepEqual(intentOf(out[1], '2026-10-01'), ['equity', 'rule'])
    const back = fromKestrel('2026-11-01', 20_000)
    db.run("INSERT INTO venture_money_rules (venture_id, shape, direction, payee_key, intent, created_at) VALUES (?, 'T', 'in', 'kestrel studio|+', 'draw', 0)", k)
    assert.deepEqual(intentOf(back, '2026-11-01'), ['draw', 'rule'])
    runTool('set_venture_share', { venture: 'Kestrel Studio', from: '2026-10-15', share_pct: 0 }, 'assistant')
    assert.deepEqual(intentOf(back, '2026-11-01'), [null, null])
  })
})

describe('the demo and Elm St', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('the demo: one share_unset issue, Bayview Condo, and no venture_money issue', () => {
    db.openDb(':memory:')
    loadDemoData()
    const bayview = db.listBuckets().find((b) => b.name === 'Bayview Condo')!
    assert.deepEqual([issueKeys('share_unset'), issueKeys('venture_money'), issueKeys('venture_paycheck')], [[`share_unset:${bayview.id}`], [], []])
    assert.deepEqual(intentParts('0000-01-01', '9999-12-31'), [])
  })

  test('Elm St: nothing inferred, two venture_money issues, (Elm St, C, out) and (Elm St, C, in), and one share_unset issue', () => {
    db.openDb(':memory:')
    const elm = elmSt()
    assert.deepEqual(intentParts('0000-01-01', '9999-12-31'), [])
    const keys = issueKeys('venture_money')
    assert.deepEqual(
      keys.map((k) => k.split(':').slice(0, 4).join(':')),
      [`venture_money:${elm.bucket}:C:in`, `venture_money:${elm.bucket}:C:out`]
    )
    assert.deepEqual(issueKeys('share_unset'), [`share_unset:${elm.bucket}`])
    // Every boundary line is one of the two patterns, all of them unset.
    const { units, unset } = boundaryParts()
    assert.equal(unset.length, units.length)
    assert.ok(units.every((u) => u.shape === 'C' && u.ventureId === elm.bucket))
  })
})

describe('I5 settles a cost by a transfer only', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("a venture's cost and a revenue of the same amount 14 days apart stay unset, so a venture that holds no account, whose position is its claims, keeps net worth where it was", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    db.openDb(':memory:')
    db.upsertAccount({ id: ACCOUNTS.checking, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 500_000, availableCents: null, balanceDate: noonOn(2026, 12, 7) })
    db.updateAccount(ACCOUNTS.checking, { assetType: 'cash' })
    // A rental placed by hand on the user's checking, with no account of its own.
    const lot = db.saveBucket({ name: 'Birch Lot', kind: 'rental' })
    const cost = line(ACCOUNTS.checking, '2026-10-20', -45_000, 'BIRCH LOT MOWING', 'Housing', 'Birch Mowing')
    const rent = line(ACCOUNTS.checking, '2026-11-03', 45_000, 'BIRCH LOT RENT', 'Other Income', 'Birch Tenant')
    db.setTransactionsBucket([cost, rent], lot)
    assert.deepEqual([partsOfTxn(cost, '2026-10-20'), partsOfTxn(rent, '2026-11-03')], [[[`::${lot}`, 'venture', -45_000, lot, null, null]], [[`::${lot}`, 'venture', 45_000, lot, null, null]]])
    // Its position is nothing on every day, so net worth is Checking's alone, as before 1j.
    assert.deepEqual(ventureValues(['2026-10-19', '2026-10-31', '2026-11-30']).get(lot), [0, 0, 0])
    const at = new Map(getNetWorthSeries().points.map((p) => [p.day, p.cents]))
    assert.deepEqual(['2026-10-31', '2026-11-30'].map((d) => at.get(d)), ['2026-10-31', '2026-11-30'].map((d) => db.balancesOn([ACCOUNTS.checking], d).get(ACCOUNTS.checking)))
    assert.deepEqual(issueKeys('venture_money').map((k) => k.split(':').slice(0, 4).join(':')), [`venture_money:${lot}:C:in`, `venture_money:${lot}:C:out`])
  })

  test("a rental's rent received in Checking and the next payment on its mortgage of the same amount stay unset: revenue is no cost to pay back", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    db.openDb(':memory:')
    db.upsertAccount({ id: ACCOUNTS.checking, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 500_000, availableCents: null, balanceDate: noonOn(2026, 12, 7) })
    db.updateAccount(ACCOUNTS.checking, { assetType: 'cash' })
    const rental = db.saveBucket({ name: 'East Rental', kind: 'rental' })
    const house = db.addManualAccount({ name: 'East house', assetType: 'property', openedDay: '2020-01-01', costCents: 30_000_000, points: [{ day: '2020-01-01', cents: 30_000_000 }] })
    db.updateAccount(house, { bucketId: rental })
    // The mortgage is Personal's, linked to the rental's house, so its payments are money with the rental (T).
    const loan = db.addManualAccount({ name: 'East Mortgage', assetType: 'mortgage', openedDay: '2020-01-01', linkedAssetId: house, points: [{ day: '2026-07-31', cents: -20_000_000 }, { day: '2026-11-30', cents: -19_800_000 }] })
    const rents = ['2026-08-28', '2026-09-28', '2026-10-28'].map((d) => line(ACCOUNTS.checking, d, 210_000, 'EAST TENANT RENT', 'Other Income', 'East Tenant'))
    db.setTransactionsBucket(rents, rental)
    const pays = ['2026-09-03', '2026-10-03', '2026-11-03'].map((d) => line(ACCOUNTS.checking, d, -210_000, 'EAST MORTGAGE PMT', 'Transfers', 'East Mortgage'))
    runTool('link_loan_payment', { account_id: loan, transaction_id: pays[0] }, 'assistant')
    assert.deepEqual(boundaryParts().units.map((u) => [u.shape, u.cents]), [['C', 210_000], ['T', -210_000], ['C', 210_000], ['T', -210_000], ['C', 210_000], ['T', -210_000]])
    for (const [ids, days] of [[rents, ['2026-08-28', '2026-09-28', '2026-10-28']], [pays, ['2026-09-03', '2026-10-03', '2026-11-03']]] as const) ids.forEach((id, i) => assert.deepEqual(intentOf(id, days[i]), [null, null]))
    // August holds the rent alone, in the Ventures term as before 1j; its payment is September's.
    const aug = figures('2026-08')
    assert.deepEqual([aug.identity.venturesCents, aug.identity.boughtCents], [210_000, 0])
    assert.deepEqual(issueKeys('venture_money').map((k) => k.split(':').slice(0, 4).join(':')), [`venture_money:${rental}:C:in`, `venture_money:${rental}:T:out`])
  })
})

describe('years of money with a venture', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('40 months of transfers both ways and costs of varying amounts raise one issue per pattern, each with its count, total, span and 5 amounts', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    let totalOut = 0
    for (let i = 0; i < 40; i++) {
      const m = shiftMonth('2023-08', i)
      // Out each month, varying; back each month, varying by more than 1%; a cost of the studio's on Checking.
      const out = 50_000 + ((i * 7_919) % 20_000)
      totalOut += out
      toKestrel(`${m}-03`, out)
      fromKestrel(`${m}-20`, 200_000 + ((i * 3_301) % 9) * 10_000)
      kestrelCost(k, `${m}-11`, 1_000 + ((i * 37) % 4) * 250)
    }
    const issues = issuesOf('venture_money')
    assert.deepEqual(
      issues.map((i) => i.key.split(':').slice(0, 4).join(':')).sort(),
      [`venture_money:${k}:C:out`, `venture_money:${k}:T:in`, `venture_money:${k}:T:out`]
    )
    for (const i of issues) {
      assert.match(i.summary, /^40 lines /)
      assert.match(i.summary, /2023-08-\d\d to 2026-11-\d\d/)
      assert.equal(i.transaction_ids!.length, 30)
    }
    const out = issues.find((i) => i.key.includes(':T:out:'))!
    assert.ok(out.summary.includes(`(${'$'}${(totalOut / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} out,`), out.summary)
    // The costs come in 4 amounts, 10 of each, the largest first on a tie; the transfers back in 9, so 5 are listed.
    const cost = issues.find((i) => i.key.includes(':C:out'))!
    assert.match(cost.summary, /\(\$550\.00 out, 2023-08-11 to 2026-11-11; \$17\.50 × 10, \$15\.00 × 10, \$12\.50 × 10, \$10\.00 × 10\)/)
    assert.equal((issues.find((i) => i.key.includes(':T:in:'))!.summary.match(/×/g) ?? []).length, 5)
  })

  test("12 transfers back with no merchant, each description with a bank's reference code of letters and digits, are one pattern by Kestrel Checking, and remember covers the next", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    const codes = ['IBK', 'QZT', 'WMR', 'PLX', 'HJD', 'NVC', 'RTY', 'UEO', 'SDF', 'GHJ', 'KLZ', 'XCV', 'BNM']
    const back = (i: number): string => {
      const day = `${shiftMonth('2025-12', i)}-12`
      line(ACCOUNTS.kestrel, day, -(50_000 + i * 1_000), `ONLINE TRANSFER TO CHECKING REF ${codes[i]}${i}`, 'Transfers')
      return line(ACCOUNTS.checking, day, 50_000 + i * 1_000, `ONLINE TRANSFER FROM KESTREL REF ${codes[i]}${i}X`, 'Transfers')
    }
    const ids = Array.from({ length: 12 }, (_, i) => back(i))
    const issues = issuesOf('venture_money')
    assert.deepEqual(issues.map((i) => i.key), [`venture_money:${k}:T:in:account:${ACCOUNTS.kestrel}|+:2026-11-12`])
    assert.match(issues[0].summary, /^12 lines .*\(with Kestrel Checking\) have no intent/)
    runAssistantTool('set_venture_money', { transaction_ids: ids, venture: 'Kestrel Studio', intent: 'other', remember: true })
    const next = back(12)
    assert.deepEqual([intentOf(next, '2026-12-12'), issueKeys('venture_money')], [['other', 'rule'], []])
  })
})

describe('the 30 days of I4 and I5 over month ends and February', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** A cost of Kestrel's from Checking on one day, and as much back from Kestrel on another: each one's intent. */
  function matched(costDay: string, backDay: string, o: { backFirst?: boolean } = {}): string[] {
    const [y, m] = backDay.split('-').map(Number)
    mock.timers.enable({ apis: ['Date'], now: noonOn(y, m, 28) * 1000 })
    const k = kestrelBooks()
    const early = o.backFirst ? fromKestrel(backDay, 12_345) : null
    const cost = kestrelCost(k, costDay, 12_345)
    const back = early ?? fromKestrel(backDay, 12_345)
    const out = [intentOf(cost, costDay)[0] ?? 'unset', intentOf(back, backDay)[0] ?? 'unset']
    db.closeDb()
    mock.timers.reset()
    return out
  }

  test('30 days from Jan 31 is Mar 2, or Mar 1 in a leap year; from Oct 31, Nov 30', () => {
    assert.equal(REIMBURSE_DAYS, 30)
    assert.deepEqual(matched('2027-01-31', '2027-03-02'), ['reimbursement', 'reimbursement'])
    assert.deepEqual(matched('2027-01-31', '2027-03-03'), ['unset', 'unset'])
    assert.deepEqual(matched('2028-01-31', '2028-03-01'), ['reimbursement', 'reimbursement'])
    assert.deepEqual(matched('2028-01-31', '2028-03-02'), ['unset', 'unset'])
    assert.deepEqual(matched('2026-10-31', '2026-11-30'), ['reimbursement', 'reimbursement'])
    assert.deepEqual(matched('2026-10-31', '2026-12-01'), ['unset', 'unset'])
    // The same day counts, whichever of the two the books have first.
    assert.deepEqual(matched('2026-10-31', '2026-10-31'), ['reimbursement', 'reimbursement'])
    assert.deepEqual(matched('2026-10-31', '2026-10-31', { backFirst: true }), ['reimbursement', 'reimbursement'])
  })

  test('I4 pays back one reimbursement not yet paid back, the oldest first, or all of them together, each once', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2027, 4, 7) * 1000 })
    const k = kestrelBooks()
    const a = kestrelCost(k, '2027-01-31', 10_000, 'STUDIO PRINTS')
    const b = kestrelCost(k, '2027-02-10', 10_000, 'STUDIO FRAMES')
    runTool('set_venture_money', { transaction_ids: [a, b], venture: 'Kestrel Studio', intent: 'reimbursement' }, 'assistant')
    // Two of 100.00 owed: the first 100.00 back pays the oldest, the second the other, a third nothing.
    const backs = ['2027-02-20', '2027-02-25', '2027-03-01'].map((d) => fromKestrel(d, 10_000))
    assert.deepEqual(['2027-02-20', '2027-02-25', '2027-03-01'].map((d, i) => intentOf(backs[i], d)[0]), ['reimbursement', 'reimbursement', null])
    // Two owed, one back for both.
    const c = kestrelCost(k, '2027-03-05', 4_000, 'STUDIO INK')
    const d = kestrelCost(k, '2027-03-06', 6_000, 'STUDIO PAPER')
    runTool('set_venture_money', { transaction_ids: [c, d], venture: 'Kestrel Studio', intent: 'reimbursement' }, 'assistant')
    const both = fromKestrel('2027-03-20', 10_000)
    assert.deepEqual(intentOf(both, '2027-03-20'), ['reimbursement', 'inferred'])
    assert.equal(claimsThrough(positionBook('2027-03-31').parts.get(k)!, '2027-03-31').dueCents, 0)
  })
})

describe('the cost of reading intents', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("every demo month classified within 1b's 300 ms, and Personal's series on the demo, each against the reference", async (t) => {
    db.openDb(':memory:')
    loadDemoData()
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    const months: string[] = []
    for (let m = first; m <= db.today().slice(0, 7); m = shiftMonth(m, 1)) months.push(m)
    const classify = await paired(6, () => busyMs(() => months.forEach((m) => classifyLines(`${m}-01`, lastDay(m)))), (k) => db.setSetting('test.inferRound', String(k)))
    t.diagnostic(within('classifying every demo month', CLASSIFY_MS, classify))
    assert.ok(classify.ratio <= budgetRatio(CLASSIFY_MS), within('classifying every demo month', CLASSIFY_MS, classify))
    const series = await paired(6, () => busyMs(() => getNetWorthSeries()), (k) => db.setSetting('test.inferRound', String(k)))
    t.diagnostic(within("the demo's net worth series", DEMO_SERIES_MS, series))
    assert.ok(series.ratio <= budgetRatio(DEMO_SERIES_MS), within("the demo's net worth series", DEMO_SERIES_MS, series))
  })

  test("Review's issue scan on a large ledger, against the reference", async (t) => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    largeLedger({ from: '2018-12', invested: true })
    openIssues()
    const r = await paired(6, () => busyMs(() => openIssues()), (k) => db.setSetting('test.inferRound', String(k)))
    t.diagnostic(within("Review's issue scan", ISSUES_MS, r))
    assert.ok(r.ratio <= budgetRatio(ISSUES_MS), within("Review's issue scan", ISSUES_MS, r))
  })
})

/** Classifying every demo month: sub-phase 1b's budget, far above twice what it costs alone. */
const CLASSIFY_MS = 300
/**
 * The demo's net worth series and the large ledger's issue scan, each at least twice what it costs alone against the
 * reference on the reference machine (the series about 2.9 ms with the parts together, against
 * 2.6 ms before them, inside the allowed 1.2 times; the scan about 240 ms), so a run under the whole suite doesn't
 * fail it with nothing slower: at 5 ms the series failed one full run with nothing slower.
 */
const DEMO_SERIES_MS = 8
const ISSUES_MS = 500
