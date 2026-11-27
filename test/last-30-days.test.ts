import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { getRangeSummary } from '../src/main/summary.ts'
import { getBudget } from '../src/main/budget.ts'
import { configureLicense } from '../src/main/license.ts'
import { dayBounds, daysIn, LAST_30_DAYS, lastDays, shiftDay } from '../src/shared/period.ts'
import { dayOn, noonOn, zoned } from './days.ts'

// The last 30 days, today included, read the same on the 2nd of a month as
// on the 28th: the summary and the budget can be read over them, though no
// screen opens on them since the phone's Budget tab went (sub-phase 2h).
// Calendar months stay a choice and count as before.

configureLicense({ dev: true })

const dir = mkdtempSync(join(tmpdir(), 'finance-last30-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('the window', () => {
  test('is the 30 days through today, both ends included', () => {
    assert.deepEqual(lastDays(30, '2026-11-02'), { from: '2026-10-04', to: '2026-11-02' })
    assert.deepEqual(lastDays(30, '2026-03-01'), { from: '2026-01-31', to: '2026-03-01' })
    assert.equal(daysIn('2026-10-04', '2026-11-02'), 30)
    // Across the end of daylight saving time (Nov 1 in the US) the days stay whole.
    assert.equal(shiftDay('2026-11-02', -1), '2026-11-01')
    assert.equal(shiftDay('2026-10-31', 2), '2026-11-02')
  })

  test('runs from the first day\'s midnight to the midnight after the last', () => {
    const b = dayBounds('2026-10-04', '2026-11-02')
    assert.equal(b.from, zoned(2026, 9, 4).getTime() / 1000)
    assert.equal(b.to, zoned(2026, 10, 3).getTime() / 1000)
  })
})

describe('the last 30 days', () => {
  const today = dayOn(new Date())
  const month = today.slice(0, 7)
  /** Noon, `back` days ago. */
  const noon = (back: number): number => {
    const [y, m, d] = shiftDay(today, -back).split('-').map(Number)
    return noonOn(y, m, d)
  }
  // Days back and amounts: 29 days back is the window's first day, 30 the day before it.
  const groceries: Array<[number, number]> = [
    [0, -1200],
    [10, -3400],
    [25, -5600],
    [29, -7800],
    [30, -9100],
    [45, -2300]
  ]
  const inWindow = (back: number): boolean => back <= 29
  const sum = (keep: (back: number) => boolean): number => groceries.filter(([back]) => keep(back)).reduce((s, [, cents]) => s - cents, 0)

  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
    db.openDb(join(dir, 'finance.db'))
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    const g = db.listCategories().find((c) => c.name === 'Groceries')!.id
    for (const [back, cents] of groceries) {
      db.upsertTransaction({ id: `g${back}`, accountId: 'manual:a', posted: noon(back), amountCents: cents, description: `GREEN MARKET ${back}`, pending: false })
      db.setTransactionFields(`g${back}`, { categoryId: g, source: 'user' })
    }
  })
  after(db.closeDb)

  test('the summary covers the days, against the 30 days before them', () => {
    const last = lastDays(30, today)
    const s = getRangeSummary(last.from, last.to, [0])
    assert.equal(s.spendCents, sum(inWindow))
    assert.equal(s.prevSpendCents, sum((back) => back >= 30 && back <= 59))
    assert.equal(s.fromDay, last.from)
    assert.equal(s.toDay, today)
    assert.equal(s.month, month)
    assert.equal(s.byCategory.find((c) => c.name === 'Groceries')?.cents, sum(inWindow))
    assert.equal(s.trend.at(-1)?.month, month, 'the trend runs through this month')
  })

  test('a calendar month still sums the month', () => {
    assert.equal(getRangeSummary(month, month, [0]).spendCents, sum((back) => shiftDay(today, -back).startsWith(month)))
  })

  test('mixed or malformed days are refused', () => {
    assert.throws(() => getRangeSummary('2026-10', '2026-11-02', [0]), /Invalid days/)
  })

  test('the budget counts the last 30 days against the monthly ranges, habits with this month', () => {
    const view = getBudget(LAST_30_DAYS)
    assert.deepEqual(view.days, lastDays(30, today))
    assert.equal(view.month, month)
    assert.equal(view.dayOfMonth, null, 'whole: compared with a whole month, not the month so far')
    assert.equal(view.rows.find((r) => r.name === 'Groceries')?.spentCents, sum(inWindow))
  })

  test('the budget for a calendar month is unchanged', () => {
    const view = getBudget(month)
    assert.equal(view.days, null)
    assert.equal(view.dayOfMonth, Number(today.slice(8)))
    assert.equal(view.rows.find((r) => r.name === 'Groceries')?.spentCents ?? 0, sum((back) => shiftDay(today, -back).startsWith(month)))
  })

  test('one-offs in the budget follow the same days', () => {
    db.setOneTime(['g10', 'g30'], true)
    try {
      const view = getBudget(LAST_30_DAYS)
      assert.equal(view.oneOffs.spentCents, 3400)
      assert.deepEqual(view.oneOffs.items.map((o) => o.id), ['g10'])
      assert.equal(view.rows.find((r) => r.name === 'Groceries')?.spentCents, sum(inWindow) - 3400)
    } finally {
      db.setOneTime(['g10', 'g30'], false)
    }
  })
})
