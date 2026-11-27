import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { accountTrack, annualized, Composite, dietz, gainOver, growth, maxDrawdown, mwr, track, twr, valueAt, volatility, withRecorded, xirr } from '../src/shared/returns.ts'

const close = (actual: number | null, expected: number, tol = 1e-9): void => {
  assert.ok(actual !== null, `expected ${expected}, got null`)
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`)
}
const pts = (...xs: Array<[string, number]>): Array<{ day: string; cents: number }> => xs.map(([day, cents]) => ({ day, cents }))

describe('Modified Dietz', () => {
  test('no flows: the change over the start', () => {
    close(dietz(1000, 1100, [], '2026-01-01', '2026-01-31'), 0.1)
  })
  test('a flow halfway through counts half', () => {
    // base = 1000 + 500 × 15/30 = 1250; gain = 1600 − 1000 − 500 = 100
    close(dietz(1000, 1600, pts(['2026-01-16', 500]), '2026-01-01', '2026-01-31'), 100 / 1250)
  })
  test('a withdrawal halfway through', () => {
    // base = 1000 − 700 × 15/30 = 650; gain = 400 − 1000 + 700 = 100
    close(dietz(1000, 400, pts(['2026-01-16', -700]), '2026-01-01', '2026-01-31'), 100 / 650)
  })
  test('a flow on the closing day is in the ending value and earned nothing', () => {
    close(dietz(1000, 1600, pts(['2026-01-31', 500]), '2026-01-01', '2026-01-31'), 0.1)
  })
  test('starting empty, the period starts with the first money in', () => {
    // 1000 in at the end of Jan 2, worth 1050 on Jan 11
    close(dietz(0, 1050, pts(['2026-01-02', 1000]), '2026-01-01', '2026-01-11'), 0.05)
    // second deposit halfway through what's left: base = 1000 + 1000 × 4/8
    close(dietz(0, 2090, pts(['2026-01-03', 1000], ['2026-01-07', 1000]), '2026-01-01', '2026-01-11'), 90 / 1500)
  })
  test('starting empty with the only money in on the closing day: nothing was invested', () => {
    assert.equal(dietz(0, 1000, pts(['2026-01-11', 1000]), '2026-01-01', '2026-01-11'), null)
  })
})

describe('time-weighted return', () => {
  test('chains sub-periods', () => {
    const t = track(pts(['2026-01-01', 100], ['2026-01-31', 110], ['2026-03-02', 99]), [])
    close(twr(t, '2026-01-01', '2026-03-02'), 1.1 * 0.9 - 1)
  })

  test('a flow on the same day as a value splits the periods exactly', () => {
    // +10% on 1000, then 500 in (in the Jan 11 value), then −10% on 1600
    const t = track(pts(['2026-01-01', 1000], ['2026-01-11', 1600], ['2026-01-21', 1440]), pts(['2026-01-11', 500]))
    close(t.subs[0].r, 0.1)
    close(t.subs[1].r, -0.1)
    close(twr(t, '2026-01-01', '2026-01-21'), -0.01)
    close(gainOver(t, '2026-01-01', '2026-01-21'), 1440 - 1000 - 500)
  })

  test('a flow on the first day of a period is already in its starting value', () => {
    const t = track(pts(['2026-01-01', 1000], ['2026-01-11', 1100]), pts(['2026-01-01', 500]))
    close(twr(t, '2026-01-01', '2026-01-11'), 0.1)
  })

  test('zero starting value', () => {
    // empty until 1000 lands on Jan 11's value, then +10%
    const t = track(pts(['2026-01-01', 0], ['2026-01-11', 1000], ['2026-01-21', 1100]), pts(['2026-01-11', 1000]))
    assert.equal(t.subs[0].r, null)
    close(growth(t, '2026-01-11'), 1)
    close(twr(t, '2026-01-01', '2026-01-21'), 0.1)
  })

  test('a start between values compounds evenly through the period', () => {
    const t = track(pts(['2026-01-01', 1000], ['2026-01-31', 1100]), [])
    close(twr(t, '2026-01-16', '2026-01-31'), Math.sqrt(1.1) - 1)
    close(growth(t, '2026-01-16'), Math.sqrt(1.1))
    close(valueAt(t, '2026-01-16'), 1050)
    // too far from a known value to place
    assert.equal(twr(t, '2026-01-16', '2026-01-31', 20), null)
    close(twr(t, '2026-01-16', '2026-01-31', 30), Math.sqrt(1.1) - 1)
  })

  test('a period with flows and no values inside it', () => {
    const t = track(pts(['2026-01-01', 1000], ['2026-01-31', 1600]), pts(['2026-01-16', 500]))
    close(t.subs[0].r, 0.08)
    // 1000 + 500 in + 20/30 of the 100 gain
    close(valueAt(t, '2026-01-21'), 1567)
  })

  test('nothing outside the values', () => {
    const t = track(pts(['2026-01-01', 1000], ['2026-01-31', 1100]), [])
    assert.equal(growth(t, '2025-12-31'), null)
    assert.equal(growth(t, '2026-02-01'), null)
    assert.equal(twr(t, '2025-12-01', '2026-01-31'), null)
  })
})

describe('money-weighted return', () => {
  test('XIRR: one year', () => {
    close(xirr(pts(['2025-01-01', -1000], ['2026-01-01', 1100])), 0.1)
  })
  test('XIRR: the example in Excel’s documentation', () => {
    const cf = pts(['2008-01-01', -10000], ['2008-03-01', 2750], ['2008-10-30', 4250], ['2009-02-15', 3250], ['2009-04-01', 2750])
    close(xirr(cf), 0.373362535, 1e-8)
  })
  test('XIRR: no money in or no money out', () => {
    assert.equal(xirr(pts(['2025-01-01', 1000], ['2026-01-01', 1100])), null)
    assert.equal(xirr(pts(['2025-01-01', -1000])), null)
  })

  test('over a period, with a flow on the same day as a value', () => {
    // 1000·u² + 500·u = 1440, u = growth per 10 days; the period is 20 days
    const t = track(pts(['2026-01-01', 1000], ['2026-01-11', 1600], ['2026-01-21', 1440]), pts(['2026-01-11', 500]))
    const u = (-500 + Math.sqrt(500 ** 2 + 4 * 1000 * 1440)) / 2000
    close(mwr(t, '2026-01-01', '2026-01-21'), u * u - 1)
  })

  test('equals the time-weighted return when both periods earn the same', () => {
    // 1000·u² + 500·u = 1760 gives u = 1.1
    const t = track(pts(['2026-01-01', 1000], ['2026-01-11', 1600], ['2026-01-21', 1760]), pts(['2026-01-11', 500]))
    close(twr(t, '2026-01-01', '2026-01-21'), 0.21)
    close(mwr(t, '2026-01-01', '2026-01-21'), 0.21)
  })

  test('starting empty, it runs from the first money in', () => {
    const t = track(pts(['2026-01-01', 0], ['2026-01-11', 1050]), pts(['2026-01-02', 1000]))
    close(mwr(t, '2026-01-01', '2026-01-11'), 0.05)
    close(twr(t, '2026-01-01', '2026-01-11'), 0.05)
  })

  test('a start between values uses the estimated value there', () => {
    const t = track(pts(['2026-01-01', 1000], ['2026-01-31', 1100]), [])
    close(mwr(t, '2026-01-16', '2026-01-31'), 1100 / 1050 - 1)
  })
})

describe('annualized', () => {
  test('compounded once longer than a year', () => {
    close(annualized(0.21, 730), 0.1)
  })
  test('a year or less stays as it is', () => {
    close(annualized(0.05, 200), 0.05)
    close(annualized(0.1, 366), 0.1)
  })
})

describe('risk', () => {
  test('volatility of alternating ±1% days', () => {
    // log returns ±ln(1.01) with no drift: a day's variance is 60·ln(1.01)²/59
    const s = Array.from({ length: 61 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), g: i % 2 ? 1.01 : 1 }))
    close(volatility(s), Math.log(1.01) * Math.sqrt((60 / 59) * 365), 1e-12)
  })
  test('volatility needs enough history', () => {
    const s = Array.from({ length: 10 }, (_, i) => ({ day: `2026-01-${String(i + 1).padStart(2, '0')}`, g: 1 + i / 100 }))
    assert.equal(volatility(s), null)
  })
  test('max drawdown is the deepest fall from a high', () => {
    const g = [1, 1.2, 0.9, 1.1, 1.3, 1.0]
    const s = g.map((x, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i * 20)).toISOString().slice(0, 10), g: x }))
    close(maxDrawdown(s, 6, 60), 0.9 / 1.2 - 1)
    assert.equal(maxDrawdown(s), null)
  })
})

describe('an account’s track', () => {
  test('a synced balance up to two days after a flow is left out', () => {
    const balances = [
      { day: '2026-01-01', cents: 1000, synced: true },
      { day: '2026-01-10', cents: 1000, synced: true },
      { day: '2026-01-11', cents: 1500, synced: true },
      { day: '2026-01-12', cents: 1650, synced: true }
    ]
    const t = accountTrack(balances, pts(['2026-01-09', 500]), '2026-01-01')!
    assert.deepEqual(
      t.points.map((p) => p.day),
      ['2026-01-01', '2026-01-12']
    )
    close(t.subs[0].r, 150 / (1000 + (500 * 3) / 11))
  })

  test('a statement value on a flow’s day is kept', () => {
    const t = accountTrack(pts(['2026-01-01', 1000], ['2026-01-11', 1600]), pts(['2026-01-11', 500]), '2026-01-01')!
    close(t.subs[0].r, 0.1)
  })

  test('a first value about equal to the money put in starts empty', () => {
    const t = accountTrack(pts(['2026-02-15', 1520]), pts(['2026-02-01', 500], ['2026-02-08', 500], ['2026-02-15', 500]), '2026-02-01')!
    assert.deepEqual(t.points[0], { day: '2026-01-31', cents: 0 })
    // from Feb 1 with 500; 500 more for 7 of 14 days; the last 500 on the closing day
    close(t.subs[0].r, 20 / (500 + 250))
  })

  test('a first value well above the money put in does not', () => {
    assert.equal(accountTrack(pts(['2026-02-15', 3000]), pts(['2026-02-01', 500], ['2026-02-08', 500], ['2026-02-15', 500]), '2026-02-01'), null)
  })

  test('values from before the flows are known are ignored', () => {
    const t = accountTrack(pts(['2026-01-01', 5000], ['2026-02-01', 6000], ['2026-03-01', 6100]), [], '2026-02-02')!
    assert.deepEqual(
      t.points.map((p) => p.day),
      ['2026-02-01', '2026-03-01']
    )
  })

  test('a jump that can only be a missing flow starts the track over', () => {
    const t = accountTrack(pts(['2026-01-01', 1000], ['2026-02-01', 2000], ['2026-03-01', 2100]), [], '2026-01-01')!
    assert.equal(t.points[0].day, '2026-02-01')
    close(twr(t, '2026-02-01', '2026-03-01'), 0.05)
  })

  test('under a dollar is empty: the track starts over the last time the account was empty', () => {
    // $1,000 withdrawn leaving 12¢, idle for a month, then $6,000 in on Mar 15
    const balances = pts(['2026-01-01', 100_000], ['2026-02-01', 12], ['2026-03-01', 12], ['2026-04-01', 600_000], ['2026-05-01', 660_000])
    const t = accountTrack(balances, pts(['2026-01-15', -100_000], ['2026-03-15', 600_000]), '2026-01-01')!
    assert.deepEqual(t.points[0], { day: '2026-03-01', cents: 0 })
    // April starts with the deposit and ends flat; May earns 10%
    close(twr(t, '2026-03-01', '2026-05-01'), 0.1)
  })

  test('an account that is empty now ends the day it emptied', () => {
    const balances = pts(['2026-01-01', 100_000], ['2026-02-01', 110_000], ['2026-03-01', 40], ['2026-04-01', 0])
    const t = accountTrack(balances, pts(['2026-03-01', -110_000]), '2026-01-01')!
    assert.deepEqual(
      t.points.map((p) => p.day),
      ['2026-01-01', '2026-02-01', '2026-03-01']
    )
    close(twr(t, '2026-01-01', '2026-03-01'), 0.1)
  })

  test('an account that never held a dollar has no track', () => {
    assert.equal(accountTrack(pts(['2026-01-01', 12], ['2026-02-01', 12]), [], '2026-01-01'), null)
  })
})

describe('recorded flows', () => {
  test('one the feed also reports counts once', () => {
    const feed = pts(['2026-03-02', 650000])
    assert.deepEqual(withRecorded(feed, pts(['2026-03-05', 650000])), feed)
    // a different amount, or further than three days off, is another flow
    assert.equal(withRecorded(feed, pts(['2026-03-02', 600000], ['2026-03-06', 650000])).length, 3)
    // two recorded alike match one reported
    assert.equal(withRecorded(feed, pts(['2026-03-01', 650000], ['2026-03-02', 650000])).length, 2)
  })

  test('statements before the feed reach back once their flows are recorded', () => {
    // +5% in January; +10% in February with 6,000 put in on the closing day;
    // March: all of it taken out on the 1st, nothing earned
    const values = pts(['2024-12-31', 10000_00], ['2025-01-31', 10500_00], ['2025-02-28', 17550_00], ['2025-03-31', 0])
    const recorded = pts(['2025-02-28', 6000_00], ['2025-03-01', -17550_00])
    // without them, the money taken out in March can only be a missing flow
    assert.equal(accountTrack(values, [], '2025-01-01'), null)
    const t = accountTrack(values, withRecorded([], recorded), '2025-01-01')!
    assert.equal(t.points[0].day, '2024-12-31')
    close(twr(t, '2024-12-31', '2025-03-31'), 1.05 * 1.1 - 1)
    close(gainOver(t, '2024-12-31', '2025-03-31'), 500_00 + 1050_00)
  })
})

describe('accounts together', () => {
  test('a day’s return is weighted by capital at the start of the day', () => {
    const c = new Composite([track(pts(['2026-01-01', 1000], ['2026-01-02', 1100]), []), track(pts(['2026-01-01', 3000], ['2026-01-02', 3000]), [])])
    close(c.twr('2026-01-01', '2026-01-02'), 0.025)
  })

  test('money in on the day earns nothing that day', () => {
    const c = new Composite([track(pts(['2026-01-01', 1000], ['2026-01-02', 2100]), pts(['2026-01-02', 1000])), track(pts(['2026-01-01', 1000], ['2026-01-02', 1000]), [])])
    close(c.twr('2026-01-01', '2026-01-02'), 0.05)
    close(c.gain('2026-01-01', '2026-01-02'), 100)
    close(c.flows('2026-01-01', '2026-01-02'), 1000)
  })

  test('an account joining later counts from its first value', () => {
    // both earn the same daily rate: 10% over the ten days
    const a = track(pts(['2026-01-01', 100000], ['2026-01-11', 110000]), [])
    const b = track(pts(['2026-01-06', 50000], ['2026-01-11', Math.round(50000 * Math.sqrt(1.1))]), [])
    const c = new Composite([a, b])
    assert.equal(c.first, '2026-01-01')
    close(c.twr('2026-01-01', '2026-01-11'), 0.1, 1e-5)
    close(c.mwr('2026-01-01', '2026-01-11'), 0.1, 1e-5)
    close(c.gain('2026-01-01', '2026-01-11'), 10000 + 2440)
  })
})
