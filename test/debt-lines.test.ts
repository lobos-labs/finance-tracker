import { after, afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { capitalWindows, classifyLines, financed, loanSplit, perimeter } from '../src/main/lines.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { LEG_DAYS, PROCEEDS_DAYS, PURCHASE_DAYS } from '../src/main/windows.ts'
import { addDays, daysInMonth } from '../src/shared/zone.ts'
import type { CashRole, ClassifiedLine, LineClass } from '../src/shared/types.ts'
import { household, link, manual, txn } from './fixtures/debts.ts'

// Debt and capital lines: a loan payment splits into interest (with escrow) and principal by the debt's
// balances, money borrowed is principal, and buying, selling or lending an asset is capital, so none of
// it reaches Saved. The cash and bridge terms are worked out here from the classifier's lines and the
// balances, as section 2 defines them; test/identity.test.ts has waterfall.ts compute them for the same cases.

configureLicense({ dev: true })

const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

/** A month's lines of some transactions, as [class, cents], oldest first. */
function linesOf(month: string, ...ids: string[]): Array<[LineClass, number]> {
  return classifyLines(`${month}-01`, lastDay(month))
    .filter((l) => ids.includes(l.txnId))
    .map((l): [LineClass, number] => [l.cls, l.cents])
}

/**
 * Section 2's terms for a month, from the classifier's lines and the balances: Debt paid down (minus the principal
 * lines, plus what the perimeter's cards went down by), Bought assets (minus the capital lines), Left in checking
 * and Moved to savings (the balance changes of spending and saving cash), an asset's Revaluation (its value change
 * less what was bought of it and less what was financed) and a debt's debtResidual (minus its change in what's owed,
 * less the principal paid on it, plus what was financed on it).
 */
function terms(month: string): {
  lines: ClassifiedLine[]
  debtPaidDown: number
  bought: number
  leftInChecking: number
  movedToSavings: number
  revaluation: (assetId: string) => number
  debtResidual: (debtId: string) => number
} {
  const from = `${month}-01`
  const to = lastDay(month)
  const lines = classifyLines(from, to)
  const sum = (f: (l: ClassifiedLine) => boolean): number => lines.filter(f).reduce((s, l) => s + l.cents, 0)
  // Balances are signed, debts negative: a debt's rise in balance is what's owed going down.
  const change = (id: string): number => (db.balancesOn([id], to).get(id) ?? 0) - (db.balancesOn([id], addDays(from, -1)).get(id) ?? 0)
  const accounts = db.listAccounts()
  const kept = perimeter(month).map((id) => accounts.find((a) => a.id === id)!)
  const cash = (role: CashRole): number => kept.filter((a) => a.cashRole === role).reduce((s, a) => s + change(a.id), 0)
  const financedIn = (assetId: string | null): number => capitalWindows().filter((w) => w.assetId === assetId && w.day >= from && w.day <= to).reduce((s, w) => s + w.financedCents, 0)
  return {
    lines,
    debtPaidDown: -sum((l) => l.cls === 'principal') + kept.filter((a) => a.assetType === 'credit_card').reduce((s, a) => s + change(a.id), 0),
    bought: -sum((l) => l.cls === 'capital'),
    leftInChecking: cash('spending'),
    movedToSavings: cash('saving'),
    revaluation: (assetId) => change(assetId) + sum((l) => l.cls === 'capital' && l.assetId === assetId) - financedIn(assetId),
    debtResidual: (debtId) => change(debtId) + sum((l) => l.cls === 'principal' && l.debtId === debtId) + financedIn(accounts.find((a) => a.id === debtId)!.linkedAssetId)
  }
}

describe('a loan payment split by its balances', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test('2,000.00 between 100,000.00 owed on Sep 30 and 99,200.00 on Oct 31: principal 800.00, interest and escrow 1,200.00; with 300.00 escrow, interest 900.00', () => {
    const loan = manual('Cedar Home Loans', 'mortgage', { points: [['2025-09-30', 10_000_000], ['2025-10-31', 9_920_000]] })
    const pay = txn('csv:chk', '2025-10-15', -200_000, 'CEDAR HOME LOANS PMT', { cat: 'Housing', merchant: 'Cedar Home Loans' })
    // Filed as Housing and not yet linked, it's spending.
    assert.deepEqual(linesOf('2025-10', pay), [['everyday', -200_000]])
    const r = runTool('link_loan_payment', { account_id: loan, transaction_id: pay }, 'assistant')
    assert.equal(db.listAccounts().find((a) => a.id === loan)!.paymentKey, 'cedar home loans|-')
    assert.deepEqual(loanSplit(loan, pay), { principalCents: 80_000, interestCents: 120_000, escrowCents: 0, estimated: false })
    const lines = classifyLines('2025-10-01', '2025-10-31').filter((l) => l.txnId === pay)
    assert.deepEqual(
      lines.map((l) => [l.key.slice(pay.length), l.cls, l.cents, l.debtId, l.estimated]),
      [
        ['::p:int', 'debtCost', -120_000, loan, false],
        ['::p:prin', 'principal', -80_000, loan, false]
      ]
    )
    runTool('update_account', { account_id: loan, escrow: 300 }, 'assistant')
    assert.deepEqual(loanSplit(loan, pay), { principalCents: 80_000, interestCents: 90_000, escrowCents: 30_000, estimated: false })
    // Interest and escrow are one debt cost line; the escrow splits them for the drill.
    assert.deepEqual(linesOf('2025-10', pay), [['debtCost', -120_000], ['principal', -80_000]])
    // Undone, the payment is spending again.
    const c = db.getChange(r.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    assert.equal(db.listAccounts().find((a) => a.id === loan)!.paymentKey, null)
    assert.deepEqual(linesOf('2025-10', pay), [['everyday', -200_000]])
  })

  test('balances on Aug 31 and Oct 31 that drop 1,600.00 over two payments give 800.00 each', () => {
    const loan = manual('Cedar Home Loans', 'mortgage', { points: [['2025-08-31', 10_000_000], ['2025-10-31', 9_840_000]] })
    const sep = txn('csv:chk', '2025-09-15', -200_000, 'CEDAR HOME LOANS PMT', { cat: 'Housing', merchant: 'Cedar Home Loans' })
    const oct = txn('csv:chk', '2025-10-15', -200_000, 'CEDAR HOME LOANS PMT', { cat: 'Housing', merchant: 'Cedar Home Loans' })
    link(loan, sep)
    assert.deepEqual([loanSplit(loan, sep)!.principalCents, loanSplit(loan, oct)!.principalCents], [80_000, 80_000])
  })

  test('a drop of 430.00 over six payments of 1,985.00: 71.66 five times and 71.70 for the last', () => {
    const loan = manual('Pine Home Loans', 'mortgage', { points: [['2025-03-06', 30_800_000], ['2025-09-06', 30_757_000]] })
    const pays = ['2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01'].map((day) => txn('csv:chk', day, -198_500, 'PINE HOME LOANS PMT', { cat: 'Housing', merchant: 'Pine Home Loans' }))
    link(loan, pays[0])
    assert.deepEqual(
      pays.map((id) => loanSplit(loan, id)!.principalCents),
      [7_166, 7_166, 7_166, 7_166, 7_166, 7_170]
    )
    assert.equal(loanSplit(loan, pays[0])!.interestCents, 198_500 - 7_166)
  })

  test('a HELOC: 20,000.00 owed, a 5,000.00 draw to checking and a 300.00 payment, then 24,800.00 owed; the draw is principal, the payment 200.00 principal and 100.00 interest', () => {
    const heloc = manual('Harbor HELOC', 'other_debt', { points: [['2025-09-30', 2_000_000], ['2025-10-31', 2_480_000]] })
    const draw = txn('csv:chk', '2025-10-10', 500_000, 'HELOC ADVANCE', { cat: 'Transfers' })
    const pay = txn('csv:chk', '2025-10-20', -30_000, 'HARBOR HELOC PMT', { cat: 'Transfers', merchant: 'Harbor HELOC' })
    link(heloc, pay)
    assert.deepEqual(linesOf('2025-10', draw, pay), [['principal', 500_000], ['debtCost', -10_000], ['principal', -20_000]])
    assert.deepEqual(loanSplit(heloc, pay), { principalCents: 20_000, interestCents: 10_000, escrowCents: 0, estimated: false })
    const t = terms('2025-10')
    // Debt paid down is what's owed going up: -4,800.00.
    assert.equal(t.debtPaidDown, -480_000)
    assert.equal(t.debtResidual(heloc), 0)
  })

  test('a balance that rises with no borrowing booked holds the principal at 0', () => {
    const loan = manual('Cedar Home Loans', 'mortgage', { points: [['2025-09-30', 10_000_000], ['2025-10-31', 10_050_000]] })
    const pay = txn('csv:chk', '2025-10-15', -200_000, 'CEDAR HOME LOANS PMT', { cat: 'Housing', merchant: 'Cedar Home Loans' })
    link(loan, pay)
    assert.deepEqual(loanSplit(loan, pay), { principalCents: 0, interestCents: 200_000, escrowCents: 0, estimated: false })
    assert.deepEqual(linesOf('2025-10', pay), [['debtCost', -200_000]])
  })

  test('with no bracket, 9,000.00 owed at 6.4% and a 412.00 payment: interest 48.00, principal 364.00, estimated', () => {
    const loan = manual('Maple Auto Finance', 'loan', { points: [['2025-09-30', 900_000]] })
    db.updateAccount(loan, { apr: 6.4 })
    const pay = txn('csv:chk', '2025-10-15', -41_200, 'MAPLE AUTO PMT', { cat: 'Transfers', merchant: 'Maple Auto Finance' })
    link(loan, pay)
    assert.deepEqual(loanSplit(loan, pay), { principalCents: 36_400, interestCents: 4_800, escrowCents: 0, estimated: true })
    const lines = classifyLines('2025-10-01', '2025-10-31').filter((l) => l.txnId === pay)
    assert.deepEqual(lines.map((l) => [l.cls, l.cents, l.estimated]), [['debtCost', -4_800, true], ['principal', -36_400, true]])
  })
})

describe('money borrowed', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test('a personal loan of 6,000.00 paid straight to the Visa: the card line is principal, borrowed, and Debt paid down is -6,000 + 6,000 = 0', () => {
    db.upsertAccount({ id: 'csv:visa', source: 'csv', name: 'Visa', institution: null, currency: 'USD', balanceCents: 0, availableCents: null, balanceDate: db.now() })
    txn('csv:visa', '2025-10-10', -600_000, 'HARBOR HOME FURNISHINGS', { cat: 'Shopping' })
    const loan = manual('Lightstream Loan', 'loan', { opened: '2025-11-02', points: [['2025-11-02', 600_000]] })
    const paid = txn('csv:visa', '2025-11-03', 600_000, 'PAYMENT FROM LIGHTSTREAM', { cat: 'Transfers' })
    const t = terms('2025-11')
    assert.deepEqual(
      t.lines.filter((l) => l.txnId === paid).map((l) => [l.cls, l.cents, l.debtId]),
      [['principal', 600_000, loan]]
    )
    assert.equal(t.debtPaidDown, 0)
    assert.equal(t.debtResidual(loan), 0)
  })

  test('a loan of 10,000.00 deposited to checking: Debt paid down -10,000.00, Left in checking +10,000.00', () => {
    const loan = manual('Lightstream Loan', 'loan', { opened: '2025-11-02', points: [['2025-11-02', 1_000_000]] })
    const deposit = txn('csv:chk', '2025-11-03', 1_000_000, 'LIGHTSTREAM LOAN PROCEEDS', { cat: 'Transfers' })
    const t = terms('2025-11')
    assert.deepEqual(linesOf('2025-11', deposit), [['principal', 1_000_000]])
    assert.equal(t.debtPaidDown, -1_000_000)
    assert.equal(t.leftInChecking, 1_000_000)
    assert.equal(t.debtResidual(loan), 0)
  })
})

describe('capital: buying, selling and lending', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  /** Saved's lines (Kept's classes: all but capital, principal, invested, internal, venture, cash returns, unsorted and orphans) in a month, and the One-offs over the 12 months to it. */
  function savedAndOneOffs(month: string): { kept: number; oneOffs: number } {
    const lines = classifyLines(`${month.slice(0, 4)}-01-01`, lastDay(month))
    const sum = (classes: LineClass[], from: string): number => lines.filter((l) => classes.includes(l.cls) && l.day >= from).reduce((s, l) => s + l.cents, 0)
    return { kept: sum(['pay', 'income', 'oneOffIncome', 'tax', 'committed', 'debtCost', 'everyday', 'oneOff'], `${month}-01`), oneOffs: sum(['oneOff', 'oneOffIncome'], `${month.slice(0, 4)}-01-01`) }
  }

  test("a 30,000.00 cashier's check from savings filed as a transfer with no leg, two days before a car bought for 30,000.00 with no loan, is capital by rule 2's fallback; Saved and the One-offs don't move", () => {
    txn('csv:chk', '2025-11-07', 300_000, 'NORTHWIND PAYROLL', { cat: 'Paycheck', merchant: 'Northwind Payroll' })
    txn('csv:visa', '2025-11-08', -12_000, 'GREENFIELD MARKET', { cat: 'Groceries' })
    txn('csv:visa', '2025-11-09', -24_000, 'HARBOR HOME FURNISHINGS', { cat: 'Shopping' })
    const car = manual('2022 Outback', 'vehicle', { opened: '2025-11-05', cost: 3_000_000, points: [['2025-11-05', 3_000_000]] })
    const before = savedAndOneOffs('2025-11')
    const check = txn('csv:sav', '2025-11-03', -3_000_000, 'CASHIERS CHECK 4471', { cat: 'Transfers' })
    const t = terms('2025-11')
    assert.deepEqual(
      t.lines.filter((l) => l.txnId === check).map((l) => [l.cls, l.cents, l.assetId]),
      [['capital', -3_000_000, car]]
    )
    assert.deepEqual(savedAndOneOffs('2025-11'), before)
    assert.equal(t.bought, 3_000_000)
    assert.equal(t.movedToSavings, -3_000_000)
    assert.equal(t.revaluation(car), 0)
    assert.deepEqual(
      capitalWindows().map((w) => [w.kind, w.fromDay, w.toDay, w.capCents, w.financedCents]),
      [['purchase', addDays('2025-11-05', -PURCHASE_DAYS), '2025-11-05', 3_000_000, 0]]
    )
  })

  test('the same car with a 25,000.00 loan deposited to checking and a 30,000.00 check from it: the deposit is principal, nothing is financed, and all 30,000.00 is capital', () => {
    const car = manual('2022 Outback', 'vehicle', { opened: '2025-11-05', cost: 3_000_000, points: [['2025-11-05', 3_000_000]] })
    const loan = manual('Maple Auto Finance', 'loan', { opened: '2025-11-03', linked: car, points: [['2025-11-03', 2_500_000]] })
    const deposit = txn('csv:chk', '2025-11-03', 2_500_000, 'MAPLE AUTO LOAN PROCEEDS', { cat: 'Transfers' })
    const check = txn('csv:chk', '2025-11-04', -3_000_000, 'CHECK 1042', { cat: 'Transfers' })
    assert.equal(financed(car, 'purchase'), 0)
    const t = terms('2025-11')
    assert.deepEqual(linesOf('2025-11', deposit, check), [['principal', 2_500_000], ['capital', -3_000_000]])
    assert.equal(t.bought, 3_000_000)
    assert.equal(t.debtPaidDown, -2_500_000)
    assert.equal(t.leftInChecking, -500_000)
    assert.equal(t.revaluation(car), 0)
    assert.equal(t.debtResidual(loan), 0)
  })

  test('the same car with the 25,000.00 loan paid to the dealer: 25,000.00 is financed, the cap is 5,000.00 and the 5,000.00 down payment is all capital', () => {
    const car = manual('2022 Outback', 'vehicle', { opened: '2025-11-05', cost: 3_000_000, points: [['2025-11-05', 3_000_000]] })
    const loan = manual('Maple Auto Finance', 'loan', { opened: '2025-11-05', linked: car, points: [['2025-11-05', 2_500_000]] })
    const down = txn('csv:chk', '2025-11-04', -500_000, 'OUTBACK DEALER DEPOSIT', { cat: 'Transfers' })
    assert.equal(financed(car, 'purchase'), 2_500_000)
    assert.equal(capitalWindows()[0].capCents, 500_000)
    const t = terms('2025-11')
    assert.deepEqual(linesOf('2025-11', down), [['capital', -500_000]])
    assert.equal(t.bought, 500_000)
    assert.equal(t.revaluation(car), 0)
    assert.equal(t.debtResidual(loan), 0)
  })

  test('sold on Dec 10 for 12,000.00 with nothing owed: the cap is 12,000.00 and the threshold 1,200.00, so the 12,000.00 two days later is capital and a smaller deposit nearer the sale is not', () => {
    const car = manual('2017 Civic', 'vehicle', { opened: '2023-01-01', closed: '2025-12-10', cost: 2_000_000, points: [['2023-01-01', 2_000_000], ['2025-11-01', 1_200_000], ['2025-12-10', 1_200_000]] })
    const near = txn('csv:chk', '2025-12-11', 119_999, 'VENMO FROM SAM')
    const proceeds = txn('csv:chk', '2025-12-12', 1_200_000, 'CARMAX AUTO PURCHASE', { cat: 'Other Income' })
    const sale = capitalWindows().find((w) => w.kind === 'sale')!
    assert.deepEqual([sale.fromDay, sale.toDay, sale.capCents, sale.financedCents], ['2025-12-10', addDays('2025-12-10', PROCEEDS_DAYS), 1_200_000, 0])
    const t = terms('2025-12')
    assert.deepEqual(linesOf('2025-12', near, proceeds), [['unsorted', 119_999], ['capital', 1_200_000]])
    assert.equal(t.bought, -1_200_000)
    assert.equal(t.revaluation(car), 0)
  })

  test('sold the same way with 4,000.00 owed and paid off at closing: -4,000.00 financed, an 8,000.00 cap and an 8,000.00 inflow all capital; paid off from checking instead, all 12,000.00 is capital and the payoff principal', () => {
    const car = manual('2017 Civic', 'vehicle', { opened: '2023-01-01', closed: '2025-12-10', cost: 2_000_000, points: [['2023-01-01', 2_000_000], ['2025-11-01', 1_200_000], ['2025-12-10', 1_200_000]] })
    const loan = manual('Civic Auto Loan', 'loan', { opened: '2023-01-01', closed: '2025-12-10', linked: car, points: [['2023-01-01', 1_000_000], ['2025-11-01', 400_000]] })
    const proceeds = txn('csv:chk', '2025-12-12', 800_000, 'CARMAX AUTO PURCHASE', { cat: 'Other Income' })
    assert.equal(financed(car, 'sale'), -400_000)
    let t = terms('2025-12')
    assert.equal(capitalWindows().find((w) => w.kind === 'sale')!.capCents, 800_000)
    assert.deepEqual(linesOf('2025-12', proceeds), [['capital', 800_000]])
    assert.equal(t.revaluation(car), 0)
    assert.equal(t.debtResidual(loan), 0)

    // The sale's 12,000.00 lands in checking, and the loan is paid off from there.
    db.deleteTransaction(proceeds)
    const all = txn('csv:chk', '2025-12-12', 1_200_000, 'CARMAX AUTO PURCHASE', { cat: 'Other Income' })
    const payoff = txn('csv:chk', '2025-12-13', -400_000, 'CIVIC AUTO LOAN PAYOFF', { cat: 'Transfers', merchant: 'Civic Auto Loan' })
    link(loan, payoff)
    assert.equal(financed(car, 'sale'), 0)
    t = terms('2025-12')
    assert.deepEqual(linesOf('2025-12', all, payoff), [['capital', 1_200_000], ['principal', -400_000]])
    assert.equal(t.revaluation(car), 0)
    assert.equal(t.debtResidual(loan), 0)
  })

  test('lent 2,000.00 on Nov 2 and repaid 500.00 on Dec 1: both are capital', () => {
    const lent = manual('Loan to Jordan', 'receivable', { opened: '2025-11-02', cost: 200_000, points: [['2025-11-02', 200_000], ['2025-12-01', 150_000]] })
    const out = txn('csv:chk', '2025-11-02', -200_000, 'ZELLE TO JORDAN M', { cat: 'Transfers' })
    const back = txn('csv:chk', '2025-12-01', 50_000, 'ZELLE FROM JORDAN M', { cat: 'Transfers' })
    assert.deepEqual(linesOf('2025-11', out), [['capital', -200_000]])
    assert.deepEqual(linesOf('2025-12', back), [['capital', 50_000]])
    assert.deepEqual(
      capitalWindows().map((w) => [w.kind, w.capCents]),
      [['lent', 200_000], ['repaid', 50_000]]
    )
    assert.ok(classifyLines('2025-11-01', '2025-12-31').filter((l) => l.cls === 'capital').every((l) => l.assetId === lent))
  })

  test('a window takes up to its cap, nearest first: the last line taken is split, its capital part keyed :cap', () => {
    const car = manual('2022 Outback', 'vehicle', { opened: '2025-11-05', cost: 3_000_000, points: [['2025-11-05', 3_000_000]] })
    const check = txn('csv:chk', '2025-11-04', -2_000_000, 'CHECK 1042', { cat: 'Transfers' })
    const wire = txn('csv:sav', '2025-11-01', -1_500_000, 'WIRE OUT', { cat: 'Transfers' })
    const lines = classifyLines('2025-11-01', '2025-11-30').filter((l) => l.txnId === check || l.txnId === wire)
    assert.deepEqual(
      lines.map((l) => [l.key.slice(l.txnId.length), l.cls, l.cents, l.assetId]),
      [
        ['::p', 'orphan', -500_000, null],
        ['::p:cap', 'capital', -1_000_000, car],
        ['::p', 'capital', -2_000_000, car]
      ]
    )
  })

  test('a line Review marks with mark_capital is capital though it is filed as a transfer, until unmarked', () => {
    const ring = manual('Engagement ring', 'other_asset', { points: [['2025-06-01', 450_000]] })
    const paid = txn('csv:chk', '2025-10-12', -450_000, 'JEWELERS ROW', { cat: 'Transfers' })
    assert.deepEqual(linesOf('2025-10', paid), [['orphan', -450_000]])
    const r = runTool('mark_capital', { transaction_ids: [paid], asset_id: ring }, 'assistant')
    assert.deepEqual(
      classifyLines('2025-10-01', '2025-10-31').filter((l) => l.txnId === paid).map((l) => [l.cls, l.cents, l.assetId]),
      [['capital', -450_000, ring]]
    )
    const c = db.getChange(r.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    assert.deepEqual(linesOf('2025-10', paid), [['orphan', -450_000]])
    assert.throws(() => runTool('mark_capital', { transaction_ids: [paid], asset_id: 'csv:visa' }), /capital buys, sells or lends/)
  })
})

describe('a debt with nothing linked to it', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test('a loan with a balance and no linked payment raises one loan_payment_unlinked, until a payment is linked', () => {
    const loan = manual('Maple Auto Finance', 'loan', { opened: '2025-03-01', points: [['2025-03-01', 2_000_000]] })
    manual('Paid-off loan', 'loan', { opened: '2020-03-01', closed: '2024-03-01', points: [['2020-03-01', 500_000]] })
    const unlinked = (): Array<string | undefined> => openIssues().filter((i) => i.kind === 'loan_payment_unlinked').map((i) => i.account_id)
    assert.deepEqual(unlinked(), [loan])
    const pay = txn('csv:chk', '2025-10-15', -41_200, 'MAPLE AUTO PMT', { cat: 'Transfers', merchant: 'Maple Auto Finance' })
    link(loan, pay)
    assert.deepEqual(unlinked(), [])
  })
})

describe('in the residence dates', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test("a payment on the venture's own mortgage is split first: its interest and escrow are Personal, its principal the venture's; after the dates it's all the venture's", () => {
    const bucket = db.saveBucket({ name: 'Elm St', kind: 'rental', residenceFrom: '2025-06-01', residenceTo: '2025-09-30' })
    const house = manual('Elm house', 'property', { opened: '2024-01-15', cost: 30_000_000, points: [['2024-01-15', 30_000_000]] })
    db.updateAccount(house, { bucketId: bucket })
    const loan = manual('Elm Lending', 'mortgage', { linked: house, points: [['2025-07-31', 20_000_000], ['2025-08-31', 19_920_000], ['2025-10-31', 19_840_000]] })
    const inside = txn('csv:chk', '2025-08-15', -200_000, 'ELM LENDING PMT', { cat: 'Housing', merchant: 'Elm Lending' })
    const outside = txn('csv:chk', '2025-10-15', -200_000, 'ELM LENDING PMT', { cat: 'Housing', merchant: 'Elm Lending' })
    db.setTransactionsBucket([inside, outside], bucket)
    link(loan, inside)
    const aug = classifyLines('2025-08-01', '2025-08-31').filter((l) => l.txnId === inside)
    assert.deepEqual(
      aug.map((l) => [l.key.slice(inside.length), l.owner, l.cls, l.cents]),
      [
        ['::p:int', null, 'debtCost', -120_000],
        [`::${bucket}:prin`, bucket, 'venture', -80_000]
      ]
    )
    assert.deepEqual(
      classifyLines('2025-10-01', '2025-10-31').filter((l) => l.txnId === outside).map((l) => [l.owner, l.cls, l.cents]),
      [[bucket, 'venture', -200_000]]
    )
  })
})

describe('migration 38', () => {
  after(db.closeDb)

  test("a Personal debt's payment key comes from the live series named as it is; one left without raises loan_payment_unlinked", () => {
    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 37 })
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    const mortgage = db.addManualAccount({ name: 'Cedar Home Loans', assetType: 'mortgage', points: [{ day: addDays(db.today(), -200), cents: -10_000_000 }] })
    const car = db.addManualAccount({ name: 'Maple Auto Finance', assetType: 'loan', points: [{ day: addDays(db.today(), -200), cents: -900_000 }] })
    for (let k = 5; k >= 0; k--) txn('csv:chk', addDays(db.today(), -30 * k), -200_000, 'CEDAR HOME LOANS PMT', { cat: 'Housing', merchant: 'Cedar Home Loans' })
    db.migrate()
    assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
    const key = (id: string): string | null => db.listAccounts().find((a) => a.id === id)!.paymentKey
    assert.deepEqual([key(mortgage), key(car)], ['cedar home loans|-', null])
    assert.deepEqual(openIssues().filter((i) => i.kind === 'loan_payment_unlinked').map((i) => i.account_id), [car])
    assert.ok(classifyLines(addDays(db.today(), -160), db.today()).some((l) => l.cls === 'principal' && l.debtId === mortgage))
    assert.deepEqual([PURCHASE_DAYS, PROCEEDS_DAYS, LEG_DAYS], [90, 7, 5])
  })
})

describe('debts on the sample household', () => {
  let first = ''
  beforeEach(() => {
    db.openDb(':memory:')
    loadDemoData()
    first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p)
  })
  afterEach(db.closeDb)

  test('Lakeside Auto Loan and Pinecrest Mortgage payments split into interest and principal; no line with a payment key is an orphan', () => {
    const accounts = db.listAccounts()
    const keyed = accounts.filter((a) => a.paymentKey)
    assert.deepEqual(keyed.map((a) => [a.id, a.paymentKey]).sort(), [['demo:car-loan', 'lakeside auto loan|-'], ['demo:mortgage', 'pinecrest mortgage|-']])
    const all = classifyLines(first, db.today())
    for (const debt of keyed) {
      const payee = debt.paymentKey!.slice(0, -2)
      const lines = all.filter((l) => (db.getTransaction(l.txnId)!.merchant ?? '').toLowerCase() === payee)
      assert.ok(lines.length >= 13, debt.name)
      assert.ok(lines.every((l) => (l.cls === 'debtCost' || l.cls === 'principal') && l.debtId === debt.id), debt.name)
      // Each payment's parts add up to it.
      const byTxn = new Map<string, number>()
      for (const l of lines) byTxn.set(l.txnId, (byTxn.get(l.txnId) ?? 0) + l.cents)
      for (const [id, cents] of byTxn) assert.equal(cents, db.getTransaction(id)!.amountCents, id)
      assert.ok(lines.some((l) => l.cls === 'principal' && l.cents < 0))
    }
    assert.ok(all.some((l) => l.cls === 'debtCost' && l.debtId === 'demo:mortgage'))
    assert.equal(all.filter((l) => l.cls === 'orphan').length, 0)
    assert.deepEqual(openIssues().filter((i) => i.kind === 'loan_payment_unlinked'), [])
  })

  test("Pinecrest's brackets: each one after the records start shares its drop over its payments, rounded down, the last taking the rest; a 6-month drop of 2,580.00 gives 430.00 each", () => {
    const anchors = db.listBalancePoints('demo:mortgage')
    const principal = new Map<string, { day: string; cents: number }>()
    for (const l of classifyLines(first, db.today()).filter((x) => x.debtId === 'demo:mortgage' && x.cls === 'principal')) principal.set(l.txnId, { day: l.day, cents: -l.cents })
    const seen: number[][] = []
    for (let k = 1; k < anchors.length; k++) {
      const [a, b] = [anchors[k - 1], anchors[k]]
      if (a.day < addDays(first, -1)) continue
      const pays = [...principal.values()].filter((p) => p.day > a.day && p.day <= b.day)
      if (!pays.length) continue
      const drop = b.cents - a.cents
      const each = Math.floor(drop / pays.length)
      assert.deepEqual(pays.map((p) => p.cents), pays.map((_, i) => (i === pays.length - 1 ? drop - each * (pays.length - 1) : each)), `${a.day} to ${b.day}`)
      seen.push(pays.map((p) => p.cents))
    }
    assert.ok(seen.some((s) => s.length === 6 && s.every((c) => c === 43_000)), JSON.stringify(seen))
  })
})

describe('the sample household on the days a card payment would be on its way', () => {
  const clock = Date.now
  afterEach(() => {
    db.closeDb()
    Date.now = clock
  })

  /** The sample household as it is loaded at midday on `day`: its orphan lines, and that month's card payments as "account day-of-month". */
  const loadedOn = (day: string): { orphans: ClassifiedLine[]; payments: string[] } => {
    Date.now = () => Date.parse(`${day}T18:00:00Z`)
    db.openDb(':memory:')
    loadDemoData()
    assert.equal(db.today(), day)
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p)
    const rows = db.all<{ account_id: string; posted: number }>("SELECT account_id, posted FROM transactions WHERE description LIKE 'PAYMENT %' ORDER BY posted, account_id")
    const payments = rows.map((r) => [r.account_id, db.dayKey(r.posted)]).filter(([, d]) => d.slice(0, 7) === day.slice(0, 7)).map(([a, d]) => `${a} ${Number(d.slice(8))}`)
    return { orphans: classifyLines(first, db.today()).filter((l) => l.cls === 'orphan'), payments }
  }

  test('a card payment is in the sample only once both its sides have posted, so no day of the month shows money on its way to nowhere', () => {
    // The promo card's payment leaves checking on the 20th and reaches the card on the 22nd; the other card's, the 25th and the 27th.
    const days: Array<[string, string[]]> = [
      ['2026-03-19', []],
      ['2026-03-20', []],
      ['2026-03-21', []],
      ['2026-03-22', ['demo:checking 20', 'demo:card-mastercard 22']],
      ['2026-03-25', ['demo:checking 20', 'demo:card-mastercard 22']],
      ['2026-03-26', ['demo:checking 20', 'demo:card-mastercard 22']],
      ['2026-03-27', ['demo:checking 20', 'demo:card-mastercard 22', 'demo:checking 25', 'demo:card-visa 27']]
    ]
    for (const [day, payments] of days) {
      const got = loadedOn(day)
      assert.deepEqual(got.payments, payments, day)
      assert.deepEqual(got.orphans, [], day)
      db.closeDb()
    }
    // The last day is left open for afterEach to close.
    db.openDb(':memory:')
  })
})
