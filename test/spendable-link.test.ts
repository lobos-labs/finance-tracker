import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { applyPage, type PlaidTxn, type SyncPage } from '../src/main/bankPage.ts'
import { historyPending, plaidBills, setHistoryPending } from '../src/main/bankHistory.ts'
import { getSpendable, setSpendSettings } from '../src/main/spendable.ts'
import type { SpendAccount, SpendItem, SyncResult } from '../src/shared/types.ts'
import { addDays } from '../src/shared/zone.ts'
import { noonOn, zoned } from './days.ts'

// Spendable right after a bank links, while its history is still arriving
// (bankHistory.ts: bills seen once count again), and for pay that keeps no
// schedule (earnings.ts: gig apps, tips). Today is Tuesday, November 3, 2026.

const TODAY = zoned(2026, 10, 3, 12)
const dir = mkdtempSync(join(tmpdir(), 'ft-spend-link-'))
let dbs = 0
let seq = 0
const categories = new Map<string, number>()

function account(id: string, name: string, balanceCents: number): void {
  db.upsertAccount({ id, source: 'simplefin', name, institution: null, currency: 'USD', balanceCents, availableCents: null, balanceDate: Math.floor(TODAY.getTime() / 1000) - 3600 })
}

/** A row on a day; a category when given, a merchant name when given. */
function add(day: string, description: string, cents: number, o: { category?: string; merchant?: string; accountId?: string } = {}): string {
  const id = `t${seq++}`
  const [y, m, d] = day.split('-').map(Number)
  db.insertTransactionIfNew({ id, accountId: o.accountId ?? 'chk', posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
  if (o.category) db.setTransactionFields(id, { categoryId: categories.get(o.category)!, source: 'user' })
  if (o.merchant) db.setTransactionFields(id, { merchant: o.merchant })
  return id
}

/** Mondays, the latest Nov 2, oldest first: one deposit each, of the amounts given. */
const mondays = (n: number): string[] => Array.from({ length: n }, (_, i) => addDays('2026-11-02', -7 * (n - 1 - i)))

const checking = (): SpendAccount => {
  const a = getSpendable().accounts.find((x) => x.id === 'chk')
  assert.ok(a, 'checking is forecast')
  return a
}
const earned = (): Array<[string, number]> =>
  getSpendable()
    .items.filter((i) => i.irregular)
    .map((i) => [i.day, i.cents])

/** A Plaid transaction as the server trims it (money out positive, as Plaid has it). */
function plaid(id: string, date: string, amount: number, name: string, detailed: string | null): PlaidTxn {
  return { transaction_id: id, account_id: 'acc-chk', amount, date, name, merchant_name: null, pending: false, pending_transaction_id: null, personal_finance_category: detailed ? { primary: detailed.split('_').slice(0, -1).join('_'), detailed } : null }
}

function sync(added: PlaidTxn[]): void {
  const page: SyncPage = {
    added,
    modified: [],
    removed: [],
    accounts: [{ account_id: 'acc-chk', name: 'Checking', official_name: null, mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 2000, available: 2000, limit: null, iso_currency_code: 'USD' } }],
    nextCursor: 'c1',
    hasMore: false
  }
  const result: SyncResult = { accounts: 0, added: 0, updated: 0, warnings: [] }
  applyPage(page, 'First Platypus Bank', result)
}

before(() => mock.timers.enable({ apis: ['Date'], now: TODAY.getTime() }))
after(() => {
  mock.timers.reset()
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  db.closeDb()
  db.openDb(join(dir, `${dbs++}.db`))
  categories.clear()
  for (const c of db.listCategories()) categories.set(c.name, c.id)
})

describe('provisional while the bank\'s history arrives', () => {
  // The first pull: a month of history with the rent in it once (Oct 6), coffee, and groceries.
  const firstMonth = (): PlaidTxn[] => [
    plaid('rent-1', '2026-10-06', 1500, 'SUNNY APTS ACH', 'RENT_AND_UTILITIES_RENT'),
    plaid('cafe-1', '2026-10-12', 4.5, 'BLUE BOTTLE', 'FOOD_AND_DRINK_COFFEE'),
    plaid('groc-1', '2026-10-20', 62, 'CORNER GROCER', 'FOOD_AND_DRINK_GROCERIES')
  ]
  const rent = (): SpendItem | undefined => getSpendable().items.find((i) => i.provisional)

  test('one month of history with the rent in it once: the rent comes again a month on, at the worst case\'s margin, whatever the risk', () => {
    setHistoryPending(true)
    sync(firstMonth())
    assert.equal(getSpendable().provisional, true)
    for (const risk of ['cautious', 'balanced', 'tight'] as const) {
      setSpendSettings({ risk })
      assert.deepEqual(
        getSpendable().items.filter((i) => i.provisional).map((i) => [i.day, i.name, i.kind, i.cents, i.estimated]),
        [['2026-11-06', 'SUNNY APTS ACH', 'bill', -172500, true]],
        risk
      )
    }
    const a = getSpendable().accounts.find((x) => x.id === 'plaid:acc-chk')!
    assert.deepEqual(a.byRisk, { cautious: 200000 - 172500, balanced: 200000 - 172500, tight: 200000 - 172500 })
    assert.equal(a.lowDay, '2026-11-06')
  })

  test('the app\'s own category counts too: a charge filed under Housing, with no word from Plaid', () => {
    setHistoryPending(true)
    account('chk', 'Checking', 200000)
    add('2026-10-15', 'OAK PROPERTY MGMT', -95000, { category: 'Housing' })
    add('2026-10-18', 'CITY WATER', -4000, { category: 'Utilities' })
    add('2026-10-19', 'CORNER GROCER', -6000, { category: 'Groceries' })
    // Nov 15 is a Sunday: out on the Friday before.
    assert.deepEqual(
      getSpendable()
        .items.filter((i) => i.provisional)
        .map((i) => [i.day, i.cents]),
      [
        ['2026-11-13', -109250],
        ['2026-11-18', -4600]
      ]
    )
  })

  test('it flips to normal when the history is in: nothing guessed, and what Plaid called bills is forgotten', () => {
    setHistoryPending(true)
    sync(firstMonth())
    assert.equal(plaidBills().get('plaid:rent-1'), 'bill')
    assert.ok(rent())

    setHistoryPending(false)
    assert.equal(historyPending(), false)
    assert.equal(getSpendable().provisional, false)
    assert.equal(rent(), undefined)
    assert.equal(plaidBills().size, 0)
    assert.equal(getSpendable().accounts[0].spendableCents, 200000)
  })

  test('a ledger whose history was never pending (the desktop\'s) guesses nothing, and its pulls note nothing', () => {
    sync(firstMonth())
    assert.equal(getSpendable().provisional, false)
    assert.equal(rent(), undefined)
    assert.equal(plaidBills().size, 0)
  })

  test('a bill already found on its schedule isn\'t counted twice; a charge marked one-time isn\'t a bill', () => {
    setHistoryPending(true)
    account('chk', 'Checking', 500000)
    for (const d of ['2026-07-10', '2026-08-10', '2026-09-10', '2026-10-10']) add(d, 'METRO POWER', -12000, { category: 'Utilities' })
    const once = add('2026-10-22', 'ACME INSURANCE', -30000, { category: 'Insurance' })
    db.setOneTime([once], true)
    const items = getSpendable().items.filter((i) => i.name === 'METRO POWER' || i.name === 'ACME INSURANCE')
    assert.deepEqual(
      items.map((i) => [i.name, !!i.provisional]),
      [['METRO POWER', false]]
    )
  })
})

describe('irregular pay', () => {
  // Twelve weeks of DoorDash payouts on Mondays; the lowest $300, the median $465, the mean $486.67.
  const WEEKS = [42000, 51000, 38000, 61000, 45000, 30000, 70000, 48000, 53000, 42000, 39000, 65000]
  const doordash = (amounts = WEEKS, o: { category?: string } = { category: 'Other Income' }): void =>
    mondays(amounts.length).forEach((d, i) => add(d, 'DOORDASH INC PAYOUT', amounts[i], { ...o, merchant: 'DoorDash' }))
  /** Rent on the 17th, two weeks out: the low day. */
  const rentOn17th = (): void => ['2026-07-17', '2026-08-17', '2026-09-17', '2026-10-17'].forEach((d) => add(d, 'Rent', -230000, { category: 'Housing' }))

  // Worst case unless a test says otherwise: these hold its floor (Most likely is the default with nothing chosen).
  beforeEach(() => {
    account('chk', 'Checking', 200000)
    setSpendSettings({ risk: 'cautious' })
  })

  test('a gig earner with twelve weeks of DoorDash payouts: worst case the lowest week, most likely the median, best case the mean', () => {
    doordash()
    rentOn17th()
    const a = checking()
    assert.deepEqual(a.byRisk, { cautious: 200000 + 2 * 30000 - 230000, balanced: 200000 + 2 * 46500 - 230000, tight: 200000 + 2 * 48667 - 230000 })
    assert.ok(a.byRisk.cautious < a.byRisk.balanced && a.byRisk.balanced < a.byRisk.tight)
    // No regular payday: two weeks, the payouts on their Mondays, estimated like everyday trips.
    assert.equal(a.nextPayday, null)
    assert.equal(a.perDayCents, null)
    assert.equal(a.days.length, 15)
    const pay = getSpendable().items.filter((i) => i.irregular)
    assert.deepEqual(
      pay.map((i) => [i.day, i.name, i.kind, i.cents, i.estimated]),
      [
        ['2026-11-09', 'DoorDash', 'income', 30000, true],
        ['2026-11-16', 'DoorDash', 'income', 30000, true]
      ]
    )
    setSpendSettings({ risk: 'balanced' })
    assert.deepEqual(earned(), [
      ['2026-11-09', 46500],
      ['2026-11-16', 46500]
    ])
  })

  test('steady payouts that look like a weekly paycheck are still a gig app\'s: counted at the floor, not as pay', () => {
    doordash([40000, 41000, 40000, 40500, 39800, 40000, 40200, 40000, 41000, 40000, 40000, 30000])
    rentOn17th()
    assert.equal(checking().byRisk.cautious, 200000 + 2 * 30000 - 230000)
    assert.equal(checking().nextPayday, null)
  })

  test('transfers between their own accounts aren\'t pay: filed as transfers, or with the other side on another account', () => {
    account('sav', 'Savings', 900000)
    // Uneven, as gig pay is, so none of it looks like a paycheck.
    const uneven = [15000, 32000, 8000, 21000, 27000, 12000, 30000, 9000, 24000, 18000, 35000, 11000]
    // Filed as transfers, weekly from savings.
    mondays(12).forEach((d, i) => add(d, 'ONLINE TRANSFER FROM SAVINGS', uneven[i] + 500, { category: 'Transfers' }))
    // Not filed at all, but the same amount left savings the day before.
    mondays(12).forEach((d, i) => {
      add(addDays(d, -1), 'TO CHECKING', -uneven[i], { accountId: 'sav' })
      add(d, 'MOBILE XFR CR', uneven[i])
    })
    // A wallet's cash-out is their own money too.
    mondays(12).forEach((d, i) => add(addDays(d, -2), 'VENMO CASHOUT', uneven[11 - i] + 300))
    assert.deepEqual(getSpendable().items.filter((i) => i.irregular), [])
    assert.equal(checking().days.length, 31)
  })

  test('a gig app\'s payout filed as a transfer still counts; a refund from one doesn\'t', () => {
    doordash(WEEKS, { category: 'Transfers' })
    mondays(6).forEach((d) => add(addDays(d, 3), 'UBER EATS REFUND', 1500, { category: 'Dining Out', merchant: 'Uber Eats' }))
    setSpendSettings({ risk: 'balanced' })
    assert.deepEqual(earned(), [
      ['2026-11-09', 46500],
      ['2026-11-16', 46500]
    ])
  })

  test('person to person: the same person paying week after week is pay; one-offs from friends aren\'t', () => {
    setSpendSettings({ risk: 'balanced' })
    // Cleaning for the same client on Fridays, paid what the hours came to; the median week $290.
    const fridays = [30000, 18000, 42000, 25000, 36000, 20000, 40000, 28000]
    mondays(8).forEach((d, i) => add(addDays(d, -3), `ZELLE PAYMENT FROM TAYLOR Q CONF ${i}A${i}`, fridays[i]))
    ;['ALEX R', 'SAM T', 'JORDAN M', 'CASEY P', 'RILEY K'].forEach((who, i) => add(addDays('2026-09-04', i * 9), `ZELLE PAYMENT FROM ${who}`, 2500))
    // Paid Fridays: Nov 6 and 13.
    assert.deepEqual(earned(), [
      ['2026-11-06', 29000],
      ['2026-11-13', 29000]
    ])
  })

  test('patchy: a week with nothing makes the worst case nothing', () => {
    mondays(12).forEach((d, i) => i !== 8 && add(d, 'DOORDASH INC PAYOUT', WEEKS[i], { merchant: 'DoorDash' }))
    assert.deepEqual(earned(), [])
    setSpendSettings({ risk: 'balanced' })
    assert.deepEqual(earned(), [
      ['2026-11-09', 43500],
      ['2026-11-16', 43500]
    ])
  })

  test('fewer than four full weeks in: nothing at worst, the median at most likely', () => {
    ;['2026-10-19', '2026-10-26', '2026-11-02'].forEach((d, i) => add(d, 'INSTACART SHOPPER PAY', [40000, 50000, 45000][i], { merchant: 'Instacart' }))
    assert.deepEqual(earned(), [])
    setSpendSettings({ risk: 'balanced' })
    assert.deepEqual(earned(), [
      ['2026-11-09', 45000],
      ['2026-11-16', 45000]
    ])
  })

  test('paid out on no particular day: a seventh of the week each day from tomorrow', () => {
    // Instacart's instant cash-outs, scattered over twelve weeks: $350 a week.
    for (let w = 0; w < 12; w++) for (const [k, c] of [[1, 10000], [3 + (w % 3), 15000], [6, 10000]] as const) add(addDays('2026-11-02', -7 * w - (6 - k)), 'INSTACART SHOPPER PAY', c, { merchant: 'Instacart' })
    setSpendSettings({ risk: 'balanced' })
    const pay = earned()
    assert.equal(pay.length, 14)
    assert.deepEqual(pay[0], ['2026-11-04', 5000])
    assert.equal(pay[13][0], '2026-11-17')
  })

  test('a regular paycheck is no irregular pay, and its forecast is unchanged', () => {
    for (let i = 5; i >= 0; i--) add(addDays('2026-10-30', -14 * i), 'Acme Payroll', 300000, { category: 'Paycheck' })
    assert.deepEqual(getSpendable().items.filter((i) => i.irregular), [])
    assert.equal(checking().nextPayday, '2026-11-13')
  })

  test('while the history arrives, every risk counts the floor', () => {
    doordash()
    rentOn17th()
    setHistoryPending(true)
    assert.deepEqual(checking().byRisk, { cautious: 200000 + 2 * 30000 - 230000, balanced: 200000 + 2 * 30000 - 230000, tight: 200000 + 2 * 30000 - 230000 })
  })

  test('a source that\'s stopped paying for two weeks isn\'t counted', () => {
    // The last payout Oct 19, fifteen days ago.
    mondays(12)
      .slice(0, 10)
      .forEach((d, i) => add(d, 'DOORDASH INC PAYOUT', WEEKS[i], { merchant: 'DoorDash' }))
    setSpendSettings({ risk: 'balanced' })
    assert.deepEqual(earned(), [])
  })
})
