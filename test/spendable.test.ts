import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { bankDay, getSpendable, isBankDay, seasonal, setSpendSettings, spendableStrip, spendSettings } from '../src/main/spendable.ts'
import type { SpendAccount } from '../src/shared/types.ts'

const DAY = 86_400
const ts = (d: Date): number => Math.floor(d.getTime() / 1000)
// The forecast runs against a fixed "today": Tuesday, November 3, 2026 at noon.
const TODAY = new Date(2026, 10, 3, 12)
const at = (y: number, m: number, d: number): Date => new Date(y, m - 1, d, 12)

const dir = mkdtempSync(join(tmpdir(), 'ft-spendable-'))
let dbs = 0
let seq = 0
const categories = new Map<string, number>()

function account(id: string, name: string, balanceCents: number | null, balanceDate = ts(TODAY) - 3600, availableCents: number | null = null): void {
  db.upsertAccount({ id, source: 'simplefin', name, institution: null, currency: 'USD', balanceCents, availableCents, balanceDate })
}

function add(day: Date, description: string, cents: number, category: string, accountId = 'chk'): void {
  const id = `t${seq++}`
  db.insertTransactionIfNew({ id, accountId, posted: ts(day), amountCents: cents, description, pending: false })
  db.setTransactionFields(id, { categoryId: categories.get(category)!, source: 'user' })
}

/** The same day of each month for the `count` months up to and including the given one (1-based month); amounts oldest first. */
function monthly(day: number, count: number, lastY: number, lastM: number, description: string, cents: number | number[], category: string, accountId?: string): void {
  for (let i = count - 1; i >= 0; i--) add(at(lastY, lastM - i, day), description, Array.isArray(cents) ? cents[count - 1 - i] : cents, category, accountId)
}

/** Every 14 days, the latest on the given day. */
function biweekly(last: Date, count: number, description: string, cents: number, category: string, accountId?: string): void {
  for (let i = count - 1; i >= 0; i--) add(new Date(last.getTime() - i * 14 * DAY * 1000), description, cents, category, accountId)
}

const checking = (): SpendAccount => {
  const a = getSpendable().accounts.find((x) => x.id === 'chk')
  assert.ok(a, 'checking is forecast')
  return a
}
const day = (a: SpendAccount, d: string): SpendAccount['days'][number] => a.days.find((x) => x.day === d)!

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
  account('chk', 'Checking', 200000)
})

describe('bank days', () => {
  test('weekends and the Federal Reserve holidays are closed, a Sunday holiday moving to Monday', () => {
    assert.equal(isBankDay('2026-11-03'), true)
    assert.equal(isBankDay('2026-11-07'), false)
    assert.equal(isBankDay('2026-11-11'), false) // Veterans Day
    assert.equal(isBankDay('2026-11-26'), false) // Thanksgiving
    assert.equal(isBankDay('2027-07-05'), false) // July 4 is a Sunday
    assert.equal(isBankDay('2027-05-31'), false) // Memorial Day
  })
  test('a closed day moves to the bank day before or after', () => {
    assert.equal(bankDay('2026-11-07', -1), '2026-11-06')
    assert.equal(bankDay('2026-11-07', 1), '2026-11-09')
    assert.equal(bankDay('2026-11-26', 1), '2026-11-27')
  })
})

describe('seasonal amounts', () => {
  test('without a year of history, the recent level', () => {
    const p = [80, 90, 100].map((c, i) => ({ posted: ts(at(2026, 8 + i, 10)), cents: -c * 100 }))
    assert.equal(seasonal(p, ts(at(2026, 11, 10))), 9000)
  })
  test('last year\'s same season, scaled to how the level has moved since', () => {
    // A winter-heavy bill: $200 last November, $100 a month in the shoulder months, now 10% dearer than a year ago.
    const amounts: Array<[number, number, number]> = [
      [2025, 10, 100],
      [2025, 11, 200],
      [2025, 12, 220],
      [2026, 1, 230],
      [2026, 2, 180],
      [2026, 3, 120],
      [2026, 4, 100],
      [2026, 5, 110],
      [2026, 6, 150],
      [2026, 7, 170],
      [2026, 8, 160],
      [2026, 9, 110],
      [2026, 10, 110]
    ]
    const p = amounts.map(([y, m, c]) => ({ posted: ts(at(y, m, 10)), cents: -c * 100 }))
    // Last November ($200), times October against last October ($110 / $100); Aug and Sep have no year-ago payment.
    assert.equal(seasonal(p, ts(at(2026, 11, 10))), 22000)
  })
})

describe('the forecast', () => {
  test('bills and paychecks land on their days, and spendable is the lowest point', () => {
    setSpendSettings({ risk: 'balanced' })
    monthly(6, 4, 2026, 10, 'Rent', -150000, 'Housing')
    biweekly(at(2026, 10, 30), 6, 'Acme Payroll', 300000, 'Paycheck')
    const a = checking()
    assert.equal(a.startCents, 200000)
    assert.equal(day(a, '2026-11-06').outCents, -150000)
    assert.equal(day(a, '2026-11-13').inCents, 300000)
    assert.equal(a.lowDay, '2026-11-06')
    assert.equal(a.spendableCents, 50000)
    assert.equal(a.nextPayday, '2026-11-13')
    assert.equal(a.perDayCents, Math.floor(50000 / 10))
    // Through the second payday from now.
    assert.equal(a.days[a.days.length - 1].day, '2026-11-27')
  })

  test('every risk is worked out to compare, and each day starts where the day before ended', () => {
    monthly(13, 4, 2026, 10, 'Rent', -250000, 'Housing')
    monthly(10, 4, 2026, 10, 'City Power', [-9000, -11000, -10500, -10000], 'Utilities')
    biweekly(at(2026, 10, 30), 6, 'Acme Payroll', 300000, 'Paycheck')
    const a = checking()
    // Most likely, the default with nothing chosen.
    assert.equal(a.byRisk.balanced, a.spendableCents)
    assert.ok(a.byRisk.cautious <= a.byRisk.balanced && a.byRisk.balanced <= a.byRisk.tight, JSON.stringify(a.byRisk))
    for (let i = 1; i < a.days.length; i++) assert.equal(a.days[i].startCents, a.days[i - 1].endCents)
    assert.equal(a.days[0].startCents, a.startCents)
  })

  test('the cushion comes off, and the lower of balance and available balance starts it', () => {
    setSpendSettings({ risk: 'balanced', cushionCents: 30000 })
    account('chk', 'Checking', 200000, ts(TODAY) - 3600, 180000)
    monthly(6, 4, 2026, 10, 'Rent', -150000, 'Housing')
    assert.equal(checking().spendableCents, 180000 - 150000 - 30000)
  })

  test('on a day with money in and out, the money goes out first unless the risk is tight', () => {
    monthly(13, 4, 2026, 10, 'Rent', -250000, 'Housing')
    biweekly(at(2026, 10, 30), 6, 'Acme Payroll', 300000, 'Paycheck')
    setSpendSettings({ risk: 'balanced' })
    assert.equal(checking().spendableCents, 200000 - 250000)
    setSpendSettings({ risk: 'tight' })
    assert.equal(checking().spendableCents, 200000)
  })

  test('a weekend payday lands the bank day before, or after when cautious; a weekend bill the other way', () => {
    // Paydays every other Saturday (Nov 7); a bill on Saturdays the 14th... monthly on the 7th falls on a Saturday in November.
    biweekly(at(2026, 10, 24), 6, 'Acme Payroll', 300000, 'Paycheck')
    monthly(7, 4, 2026, 10, 'Gym', -5000, 'Housing')
    setSpendSettings({ risk: 'balanced' })
    let a = checking()
    assert.equal(day(a, '2026-11-06').inCents, 300000)
    assert.equal(day(a, '2026-11-09').outCents, -5000)
    setSpendSettings({ risk: 'cautious' })
    a = checking()
    assert.equal(day(a, '2026-11-09').inCents, 300000)
    assert.equal(day(a, '2026-11-06').outCents, -5000)
  })

  test('a card paid in full is expected at what it owes now, or its usual for the season if that is more, when cautious', () => {
    account('visa', 'Visa', -123456)
    monthly(20, 4, 2026, 10, 'Visa Autopay', [-81234, -64010, -92577, -70300], 'Transfers')
    monthly(20, 4, 2026, 10, 'Payment Thank You', [81234, 64010, 92577, 70300], 'Transfers', 'visa')
    setSpendSettings({ risk: 'balanced' })
    const pay = (): number => getSpendable().items.find((i) => i.accountId === 'chk' && i.name === 'Visa payment')!.cents
    assert.equal(pay(), -123456)
    account('visa', 'Visa', -20000)
    setSpendSettings({ risk: 'cautious' })
    assert.ok(pay() < -20000, `cautious takes the season's payment over a low balance, got ${pay()}`)
  })

  test('a card that owes nothing has no payment coming', () => {
    account('visa', 'Visa', 0)
    monthly(20, 4, 2026, 10, 'Visa Autopay', [-81234, -64010, -92577, -70300], 'Transfers')
    monthly(20, 4, 2026, 10, 'Payment Thank You', [81234, 64010, 92577, 70300], 'Transfers', 'visa')
    assert.equal(getSpendable().items.filter((i) => i.name === 'Visa payment' && i.day < '2026-11-30').length, 0)
  })

  test('a varying bill counts a margin above its usual when cautious', () => {
    monthly(10, 4, 2026, 10, 'City Power', [-9000, -11000, -10500, -10000], 'Utilities')
    setSpendSettings({ risk: 'balanced' })
    const bill = (): number => getSpendable().items.find((i) => i.name === 'City Power')!.cents
    // The median of the last three.
    assert.equal(bill(), -10500)
    setSpendSettings({ risk: 'cautious' })
    assert.equal(bill(), -Math.round(10500 * 1.15))
  })

  test('a late paycheck is expected today, except when cautious', () => {
    monthly(25, 4, 2026, 9, 'Acme Payroll', 300000, 'Paycheck')
    setSpendSettings({ risk: 'balanced' })
    assert.equal(day(checking(), '2026-11-03').inCents, 300000)
    setSpendSettings({ risk: 'cautious' })
    assert.equal(day(checking(), '2026-11-03').inCents, 0)
  })

  test('groceries come back when the last shop runs out: a big shop lasts longer than a quick one; lifestyle spending and bills are not trips', () => {
    setSpendSettings({ risk: 'balanced' })
    // $10 a day of groceries: shops of $70 a week apart, then a $140 shop on Oct 31.
    for (const d of ['2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24']) add(new Date(`${d}T12:00:00`), 'Corner Grocer', -7000, 'Groceries')
    add(at(2026, 10, 31), 'Corner Grocer', -14000, 'Groceries')
    for (let i = 0; i < 90; i += 3) add(new Date(TODAY.getTime() - i * DAY * 1000), 'Movie Night', -2500, 'Entertainment')
    monthly(6, 4, 2026, 10, 'Rent', -150000, 'Housing')
    const trips = getSpendable().items.filter((i) => i.everyday && i.accountId === 'chk')
    assert.deepEqual([...new Set(trips.map((t) => t.name))], ['Groceries'])
    // The $140 shop lasts 14 days; a usual $70 shop, 7.
    assert.deepEqual(
      trips.map((t) => [t.day, t.cents]),
      [
        ['2026-11-14', -7000],
        ['2026-11-21', -7000],
        ['2026-11-28', -7000]
      ]
    )
    const a = checking()
    assert.equal(day(a, '2026-11-03').endCents, 200000)
    assert.equal(day(a, '2026-11-14').outCents, -7000)
  })

  test('another weekly trip lands on its usual weekday', () => {
    setSpendSettings({ risk: 'balanced' })
    // Parking every Saturday at whatever it comes to (too uneven to be a bill), the last on Oct 31.
    for (let w = 0; w < 12; w++) add(new Date(at(2026, 10, 31).getTime() - w * 7 * DAY * 1000), 'City Garage', [-500, -900, -1300][w % 3], 'Transportation')
    assert.deepEqual(
      getSpendable()
        .items.filter((i) => i.everyday)
        .map((t) => [t.day, t.cents]),
      [
        ['2026-11-07', -900],
        ['2026-11-14', -900],
        ['2026-11-21', -900],
        ['2026-11-28', -900]
      ]
    )
  })

  test('a trip with no weekly day comes every usual gap from the last; worst case takes a dearer trip and the shorter gaps', () => {
    // The pharmacy: nine trips, 8, 10 or 12 days apart, the last on Oct 30.
    const trips = ['2026-08-11', '2026-08-19', '2026-08-27', '2026-09-04', '2026-09-16', '2026-09-28', '2026-10-10', '2026-10-20', '2026-10-30']
    trips.forEach((d, i) => add(new Date(`${d}T12:00:00`), 'Corner Pharmacy', -(4000 + i * 100), 'Health & Medical'))
    const forecast = (): Array<[string, number]> => getSpendable().items.filter((i) => i.everyday && i.day <= '2026-12-03').map((t) => [t.day, t.cents])
    setSpendSettings({ risk: 'balanced' })
    assert.deepEqual(forecast(), [
      ['2026-11-09', -4400],
      ['2026-11-19', -4400],
      ['2026-11-29', -4400]
    ])
    setSpendSettings({ risk: 'cautious' })
    assert.deepEqual(forecast(), [
      ['2026-11-07', -4600],
      ['2026-11-15', -4600],
      ['2026-11-23', -4600],
      ['2026-12-01', -4600]
    ])
  })

  test('gas comes back when what was bought runs out: $5 a day here, so the last $30 lasts six days and a usual $40 fill-up eight', () => {
    const fills: Array<[string, number]> = [
      ['2026-08-20', 4000],
      ['2026-08-28', 6000],
      ['2026-09-09', 5000],
      ['2026-09-19', 2000],
      ['2026-09-23', 6000],
      ['2026-10-05', 5000],
      ['2026-10-15', 4000],
      ['2026-10-23', 4000],
      ['2026-10-31', 3000]
    ]
    for (const [d, c] of fills) add(new Date(`${d}T12:00:00`), 'Quick Fuel', -c, 'Gas & Fuel')
    setSpendSettings({ risk: 'balanced' })
    assert.deepEqual(
      getSpendable()
        .items.filter((i) => i.everyday && i.day <= '2026-12-03')
        .map((t) => [t.day, t.cents]),
      [
        ['2026-11-06', -4000],
        ['2026-11-14', -4000],
        ['2026-11-22', -4000],
        ['2026-11-30', -4000]
      ]
    )
  })

  test('a $5 top-up comes back the next day', () => {
    for (const [d, c] of [
      ['2026-10-01', 4000],
      ['2026-10-09', 4000],
      ['2026-10-17', 4000],
      ['2026-10-25', 4000],
      ['2026-11-02', 500]
    ] as Array<[string, number]>)
      add(new Date(`${d}T12:00:00`), 'Quick Fuel', -c, 'Gas & Fuel')
    setSpendSettings({ risk: 'balanced' })
    assert.equal(getSpendable().items.find((i) => i.everyday)?.day, '2026-11-03')
  })

  test('two trips are not a habit', () => {
    add(at(2026, 10, 20), 'Corner Grocer', -8000, 'Groceries')
    add(at(2026, 10, 27), 'Corner Grocer', -8000, 'Groceries')
    assert.deepEqual(getSpendable().items.filter((i) => i.everyday), [])
  })

  test('a balance older than a week isn\'t forecast; its bills are still listed', () => {
    account('chk', 'Checking', 200000, ts(TODAY) - 10 * DAY)
    monthly(6, 4, 2026, 10, 'Rent', -150000, 'Housing')
    const s = getSpendable()
    assert.deepEqual(s.accounts, [])
    assert.equal(s.items[0].name, 'Rent')
  })

  test('the account shown first is the one picked, or the one paychecks land in', () => {
    account('sav', 'Savings', 900000)
    biweekly(at(2026, 10, 30), 6, 'Acme Payroll', 300000, 'Paycheck')
    assert.equal(getSpendable().accountId, 'chk')
    setSpendSettings({ accountId: 'sav' })
    assert.equal(getSpendable().accountId, 'sav')
  })

  test('the settings refuse a risk it doesn\'t know and a negative cushion', () => {
    assert.throws(() => setSpendSettings({ risk: 'yolo' as never }))
    assert.throws(() => setSpendSettings({ cushionCents: -1 }))
    assert.equal(getSpendable().risk, 'balanced')
  })

  test('with nothing chosen it plays Most likely; a risk chosen wins, and an unknown one stored reads as none', () => {
    assert.equal(db.getSetting('spend.risk'), null)
    assert.equal(spendSettings().risk, 'balanced')
    assert.equal(getSpendable().risk, 'balanced')
    for (const risk of ['cautious', 'tight', 'balanced'] as const) {
      setSpendSettings({ risk })
      assert.equal(getSpendable().risk, risk)
    }
    setSpendSettings({ risk: 'cautious' })
    // Home's strip carries the risk, for its asterisk.
    assert.equal(spendableStrip()?.risk, 'cautious')
    db.setSetting('spend.risk', 'yolo')
    assert.equal(spendSettings().risk, 'balanced')
  })
})
