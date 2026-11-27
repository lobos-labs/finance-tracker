import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { detectRecurring, nextDate } from '../src/main/recurring.ts'
import type { RecurringSeries } from '../src/shared/types.ts'
import { zoned } from './days.ts'

const DAY = 86_400
const ts = (d: Date): number => Math.floor(d.getTime() / 1000)
// Detection runs against a fixed "today": Tuesday, October 20, 2026 at noon.
const TODAY = zoned(2026, 9, 20, 12)
const daysAgo = (n: number): Date => new Date(TODAY.getTime() - n * DAY * 1000)
/** The given day of the month `n` months ago, at noon. */
const monthsAgo = (n: number, day: number): Date => zoned(TODAY.getFullYear(), TODAY.getMonth() - n, day, 12)

const dir = mkdtempSync(join(tmpdir(), 'ft-recurring-'))
let dbs = 0
let seq = 0
const categories = new Map<string, number>()

const account = (name: string): string => {
  const id = `acct:${name.toLowerCase()}`
  db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  return id
}

function add(day: Date, description: string, cents: number, category?: string, accountId = 'acct:checking'): void {
  const id = `t${seq++}`
  db.insertTransactionIfNew({ id, accountId, posted: ts(day), amountCents: cents, description, pending: false })
  if (category) db.setTransactionFields(id, { categoryId: categories.get(category)!, source: 'user' })
}

/** A charge every `gapDays` days, the latest `lastDaysAgo` days ago. */
function every(gapDays: number, count: number, lastDaysAgo: number, description: string, cents: number, category?: string): void {
  for (let i = count - 1; i >= 0; i--) add(daysAgo(lastDaysAgo + i * gapDays), description, cents, category)
}

/** A charge on the same day of each month, the latest `lastMonthsAgo` months ago; amounts oldest first. */
function monthly(day: number, count: number, lastMonthsAgo: number, description: string, cents: number | number[], category?: string, accountId?: string): void {
  for (let i = count - 1; i >= 0; i--) add(monthsAgo(lastMonthsAgo + i, day), description, Array.isArray(cents) ? cents[count - 1 - i] : cents, category, accountId)
}

const only = (): RecurringSeries => {
  const found = detectRecurring()
  assert.equal(found.length, 1, JSON.stringify(found))
  return found[0]
}

before(() => mock.timers.enable({ apis: ['Date'], now: TODAY.getTime() }))
after(() => {
  mock.timers.reset()
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})
// Every test starts from an empty database with one checking account.
beforeEach(() => {
  db.closeDb()
  db.openDb(join(dir, `${dbs++}.db`))
  categories.clear()
  for (const c of db.listCategories()) categories.set(c.name, c.id)
  account('Checking')
})

describe('next date', () => {
  test('monthly keeps the day of the month, clamped to the end of a short month', () => {
    assert.equal(nextDate(ts(zoned(2026, 0, 31, 12)), 'monthly', 30.44), ts(zoned(2026, 1, 28, 12)))
    assert.equal(nextDate(ts(zoned(2026, 2, 15, 12)), 'monthly', 30.44), ts(zoned(2026, 3, 15, 12)))
  })
  test('quarterly and annual step by calendar months', () => {
    assert.equal(nextDate(ts(zoned(2025, 10, 30, 12)), 'quarterly', 91.3), ts(zoned(2026, 1, 28, 12)))
    assert.equal(nextDate(ts(zoned(2024, 1, 29, 12)), 'annual', 365.25), ts(zoned(2025, 1, 28, 12)))
  })
  test('the shorter cadences add their days', () => {
    const last = ts(zoned(2026, 9, 15, 12))
    assert.equal(nextDate(last, 'weekly', 7), last + 7 * DAY)
    assert.equal(nextDate(last, 'biweekly', 14), last + 14 * DAY)
    assert.equal(nextDate(last, 'semimonthly', 15.2), last + Math.round(15.2 * DAY))
  })
})

describe('cadences', () => {
  test('weekly', () => {
    every(7, 8, 3, 'Weekly Cleaners', -4000)
    const s = only()
    assert.equal(s.key, 'weekly cleaners|-')
    assert.equal(s.name, 'Weekly Cleaners')
    assert.equal(s.cadence, 'weekly')
    assert.equal(s.count, 8)
    assert.equal(s.typicalCents, -4000)
    assert.equal(s.monthlyCents, Math.round((-4000 * 30.44) / 7))
    assert.equal(s.lastDate, ts(daysAgo(3)))
    assert.equal(s.nextDate, ts(daysAgo(3)) + 7 * DAY)
    assert.equal(s.status, 'active')
    assert.equal(s.kind, 'other')
    assert.equal(s.priceChanged, false)
    assert.equal(s.variable, false)
    assert.equal(s.accountName, 'Checking')
    assert.equal(s.categoryName, null)
  })

  test('a biweekly paycheck, with a partial first check', () => {
    add(daysAgo(4 + 7 * 14), 'ACME PAYROLL', 120000, 'Paycheck')
    every(14, 7, 4, 'ACME PAYROLL', 250000, 'Paycheck')
    const s = only()
    assert.equal(s.key, 'acme payroll|+')
    assert.equal(s.cadence, 'biweekly')
    assert.equal(s.kind, 'income')
    assert.equal(s.count, 8)
    assert.equal(s.typicalCents, 250000)
    assert.equal(s.monthlyCents, Math.round((250000 * 30.44) / 14))
    assert.equal(s.nextDate, ts(daysAgo(4)) + 14 * DAY)
    assert.equal(s.status, 'active')
  })

  test('semimonthly: the 1st and the 15th', () => {
    for (let m = 0; m < 4; m++) {
      add(monthsAgo(m, 1), 'Daycare', -30000)
      add(monthsAgo(m, 15), 'Daycare', -30000)
    }
    const s = only()
    assert.equal(s.cadence, 'semimonthly')
    assert.equal(s.count, 8)
    assert.equal(s.monthlyCents, Math.round((-30000 * 30.44) / 15.2))
    assert.equal(s.nextDate, ts(monthsAgo(0, 15)) + Math.round(15.2 * DAY))
  })

  test('monthly', () => {
    monthly(15, 6, 0, 'Netflix', -1599, 'Subscriptions')
    const s = only()
    assert.equal(s.cadence, 'monthly')
    assert.equal(s.kind, 'subscription')
    assert.equal(s.count, 6)
    assert.equal(s.typicalCents, -1599)
    assert.equal(s.monthlyCents, -1599)
    assert.equal(s.lastDate, ts(monthsAgo(0, 15)))
    assert.equal(s.nextDate, ts(zoned(2026, 10, 15, 12)))
    assert.equal(s.status, 'active')
    assert.equal(s.categoryName, 'Subscriptions')
  })

  test('yearly takes two charges', () => {
    add(zoned(2025, 9, 1, 12), 'Cloudbox', -13900)
    assert.deepEqual(detectRecurring(), [])
    add(zoned(2026, 9, 1, 12), 'Cloudbox', -13900)
    const s = only()
    assert.equal(s.cadence, 'annual')
    assert.equal(s.count, 2)
    assert.equal(s.typicalCents, -13900)
    assert.equal(s.monthlyCents, Math.round((-13900 * 30.44) / 365.25))
    assert.equal(s.nextDate, ts(zoned(2027, 9, 1, 12)))
    assert.equal(s.status, 'active')
  })
})

describe('amounts', () => {
  test('a price change: the new price is what to expect', () => {
    monthly(10, 6, 0, 'Audiowave', [-1099, -1099, -1099, -1099, -1099, -1199], 'Subscriptions')
    const s = only()
    assert.equal(s.priceChanged, true)
    assert.equal(s.previousCents, -1099)
    assert.equal(s.lastCents, -1199)
    assert.equal(s.typicalCents, -1199)
    assert.equal(s.monthlyCents, -1199)
    assert.equal(s.variable, false)
  })

  test('a utility bill varies around its median', () => {
    monthly(20, 6, 0, 'City Power', [-8000, -9500, -7000, -11000, -8500, -9000], 'Utilities')
    const s = only()
    assert.equal(s.kind, 'bill')
    assert.equal(s.variable, true)
    assert.equal(s.priceChanged, false)
    assert.equal(s.typicalCents, -8750)
    assert.equal(s.monthlyCents, -8750)
  })

  test('amounts that swing are not a series', () => {
    monthly(12, 6, 0, 'Flea Market', [-1000, -8000, -1500, -9500, -2000, -7000])
    assert.deepEqual(detectRecurring(), [])
  })
})

describe('status', () => {
  test('late once past the grace period', () => {
    monthly(3, 5, 1, 'Water Co', -6000, 'Utilities')
    const s = only()
    assert.equal(s.nextDate, ts(zoned(2026, 9, 3, 12)))
    assert.equal(s.status, 'late')
  })

  test('stopped once a whole period has gone by', () => {
    monthly(15, 6, 4, 'Gym', -4500, 'Fitness')
    const s = only()
    assert.equal(s.kind, 'subscription')
    assert.equal(s.nextDate, ts(zoned(2026, 6, 15, 12)))
    assert.equal(s.status, 'stopped')
  })

  test('active first, then late, then stopped', () => {
    monthly(15, 6, 4, 'Gym', -4500, 'Fitness')
    monthly(15, 6, 0, 'Netflix', -1599, 'Subscriptions')
    monthly(3, 5, 1, 'Water Co', -6000, 'Utilities')
    assert.deepEqual(
      detectRecurring().map((s) => [s.name, s.status]),
      [
        ['Netflix', 'active'],
        ['Water Co', 'late'],
        ['Gym', 'stopped']
      ]
    )
  })
})

describe('noise', () => {
  test('irregular visits are not a series', () => {
    for (const d of [2, 5, 25, 26, 60, 61, 100]) add(daysAgo(d), 'Corner Store', -(1000 + d * 37))
    assert.deepEqual(detectRecurring(), [])
  })

  test('two charges a month apart are not enough', () => {
    monthly(8, 2, 0, 'Dentist', -12000)
    assert.deepEqual(detectRecurring(), [])
  })

  test('cents-sized fees are ignored', () => {
    monthly(8, 6, 0, 'Foreign Transaction Fee', -45)
    assert.deepEqual(detectRecurring(), [])
  })

  test('everyday spending counts only once confirmed', () => {
    every(7, 6, 2, 'Blue Bottle', -550, 'Coffee')
    assert.deepEqual(detectRecurring(), [])
    db.setRecurringOverride('blue bottle|-', { status: 'confirmed', kind: 'subscription', name: 'Coffee habit' })
    const s = only()
    assert.equal(s.confirmed, true)
    assert.equal(s.kind, 'subscription')
    assert.equal(s.name, 'Coffee habit')
    assert.equal(s.cadence, 'weekly')
  })

  test('a dismissed series is still reported, flagged', () => {
    monthly(15, 6, 0, 'Netflix', -1599, 'Subscriptions')
    db.setRecurringOverride('netflix|-', { status: 'dismissed' })
    const s = only()
    assert.equal(s.dismissed, true)
    assert.equal(s.confirmed, false)
  })
})

describe('accounts', () => {
  test('both sides of a loan payment are one series', () => {
    account('Auto Loan')
    monthly(5, 4, 0, 'Crestline Lending', -40000, 'Transfers')
    monthly(5, 4, 0, 'Crestline Lending', 40000, 'Transfers', 'acct:auto loan')
    const s = only()
    assert.equal(s.kind, 'loan')
    assert.equal(s.typicalCents, 40000)
    assert.equal(s.accountName, 'Auto Loan')
    assert.equal(s.count, 4)
    assert.equal(s.accountId, 'acct:auto loan')
    assert.equal(s.pairAccountId, 'acct:checking')
    assert.equal(s.pairAccountName, 'Checking')
  })

  test('a card paid from checking keeps the checking side as its pair, whatever each month comes to', () => {
    account('Visa')
    monthly(20, 4, 1, 'Visa Autopay', [-81234, -64010, -92577, -70300], 'Transfers')
    monthly(20, 4, 1, 'Payment Thank You', [81234, 64010, 92577, 70300], 'Transfers', 'acct:visa')
    const s = only()
    assert.equal(s.accountId, 'acct:visa')
    assert.equal(s.pairAccountId, 'acct:checking')
  })

  test('a series seen on one account has no pair', () => {
    monthly(15, 6, 0, 'Netflix', -1599, 'Subscriptions')
    const s = only()
    assert.equal(s.accountId, 'acct:checking')
    assert.equal(s.pairAccountId, null)
  })

  test('the same payee on two accounts is two series with distinct keys', () => {
    account('Visa')
    monthly(15, 4, 0, 'Netflix', -1599, 'Subscriptions')
    monthly(15, 4, 0, 'Netflix', -1599, 'Subscriptions', 'acct:visa')
    const found = detectRecurring()
    assert.equal(found.length, 2)
    assert.deepEqual(new Set(found.map((s) => s.key)), new Set(['netflix|-', `netflix|-|${found.find((s) => s.key !== 'netflix|-')!.accountName}`]))
  })

  test('a payee renamed partway carries on the same series', () => {
    monthly(15, 3, 3, 'Hulu', -1299, 'Subscriptions')
    monthly(15, 3, 0, 'HULU LLC', -1299, 'Subscriptions')
    const s = only()
    assert.equal(s.key, 'hulu llc|-')
    assert.equal(s.name, 'HULU LLC')
    assert.equal(s.count, 6)
    assert.equal(s.cadence, 'monthly')
  })

  test('a payment that comes in with the bank\'s raw text keeps the series\' name', () => {
    const first = seq
    monthly(6, 3, 1, 'OSPREY LEASING RENT 000000000000001 WEB ID: 0000000000', -145_830, 'Housing')
    for (let i = first; i < seq; i++) db.setTransactionFields(`t${i}`, { merchant: 'Osprey Leasing' })
    // This month's is still pending, in the ACH format, and a rule named no payee.
    add(monthsAgo(0, 6), 'ORIG CO NAME:OSPREY LEASING CO ENTRY DESCR:RENT SEC:WEB IND ID:000000000000002 ORIG ID:0000000000', -146_015, 'Housing')
    const s = only()
    assert.deepEqual([s.key, s.name, s.count], ['osprey leasing|-', 'Osprey Leasing', 4])
  })
})
