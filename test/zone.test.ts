import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { setTimeZone, timeZone } from '../src/main/calendar.ts'
import { addDays, addMonths, dateString, dayIn, daysBetween, defaultZone, isRealDay, monthStartIn, noonIn, offsetAt, offsetChanges, shiftMonth, startIn, timeIn, timeOfDay, weekday } from '../src/shared/zone.ts'

// Days in a time zone, wherever the process runs. The zones here are never
// the process's own, so the Intl path runs in every run of the suite.

const utc = (iso: string): number => Date.parse(iso) / 1000

describe('day arithmetic', () => {
  test('days and months roll over, and a month keeps its day when it can', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
    assert.equal(addMonths('2024-02-29', 12), '2025-02-28')
    assert.equal(addMonths('2026-11-15', -11), '2025-12-15')
    assert.equal(shiftMonth('2026-11', 2), '2027-01')
    assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2)
    assert.equal(weekday('2026-11-03'), 2)
    assert.equal(dateString('2026-11-03'), 'Tue Nov 03 2026')
    assert.ok(isRealDay('2024-02-29') && !isRealDay('2026-02-29') && !isRealDay('2026-2-01'))
  })
})

describe('a zone that is not the process\'s', () => {
  test('the day a time falls on', () => {
    // 6:30 pm Central on Nov 3 is already Nov 4 in UTC; Seoul is a day ahead by morning.
    assert.equal(dayIn(utc('2026-11-04T00:30:00Z'), 'America/Chicago'), '2026-11-03')
    assert.equal(dayIn(utc('2026-11-04T00:30:00Z'), 'Asia/Seoul'), '2026-11-04')
    assert.equal(dayIn(utc('2026-11-03T14:59:59Z'), 'Asia/Seoul'), '2026-11-03')
    assert.deepEqual(timeOfDay(utc('2026-07-01T17:45:00Z'), 'America/Chicago'), { hour: 12, minute: 45 })
  })

  test('noon and midnight of a day, across clock changes', () => {
    assert.equal(noonIn('2026-07-01', 'America/Chicago'), utc('2026-07-01T17:00:00Z'))
    assert.equal(noonIn('2026-12-01', 'America/Chicago'), utc('2026-12-01T18:00:00Z'))
    assert.equal(startIn('2026-03-08', 'America/Chicago'), utc('2026-03-08T06:00:00Z'))
    assert.equal(startIn('2026-03-09', 'America/Chicago'), utc('2026-03-09T05:00:00Z'))
    assert.equal(monthStartIn('2026-11', 'Asia/Kolkata'), utc('2026-10-31T18:30:00Z'))
    // A time the change skips reads as the hour after; one it repeats, as the first.
    assert.equal(timeIn('2026-03-08', 'America/Chicago', 2, 30), utc('2026-03-08T08:30:00Z'))
    assert.equal(timeIn('2026-11-01', 'America/Chicago', 1, 30), utc('2026-11-01T06:30:00Z'))
    assert.equal(timeIn('2026-10-25', 'Europe/Berlin', 2, 30), utc('2026-10-25T00:30:00Z'))
    // Beirut's clocks skip midnight in March: the day starts at 1 am.
    assert.equal(startIn('2026-03-29', 'Asia/Beirut'), utc('2026-03-28T22:00:00Z'))
  })

  test('the offsets and their changes', () => {
    assert.equal(offsetAt(utc('2026-07-01T00:00:00Z'), 'America/Chicago'), -5 * 3600)
    assert.equal(offsetAt(utc('2026-07-01T00:00:00Z'), 'Australia/Lord_Howe'), 10.5 * 3600)
    const changes = offsetChanges('America/Chicago', utc('2026-01-01T00:00:00Z'), utc('2027-01-01T00:00:00Z'))
    assert.deepEqual(changes, [
      { at: utc('2026-01-01T00:00:00Z'), offset: -6 * 3600 },
      { at: utc('2026-03-08T08:00:00Z'), offset: -5 * 3600 },
      { at: utc('2026-11-01T07:00:00Z'), offset: -6 * 3600 }
    ])
    assert.deepEqual(offsetChanges('Asia/Seoul', utc('2020-01-01T00:00:00Z'), utc('2030-01-01T00:00:00Z')), [{ at: utc('2020-01-01T00:00:00Z'), offset: 9 * 3600 }])
  })
})

describe('a ledger in its own zone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-zone-'))
  before(() => db.openDb(join(dir, 'finance.db')))
  after(() => {
    db.closeDb()
    rmSync(dir, { recursive: true, force: true })
  })

  test('with no zone set, it counts days in the default zone', () => {
    assert.equal(db.zone(), defaultZone())
    assert.equal(timeZone(), defaultZone())
  })

  test('its days, noons and months follow the setting, and an unknown zone is refused', () => {
    setTimeZone('Asia/Seoul')
    assert.equal(db.zone(), 'Asia/Seoul')
    assert.equal(db.dayKey(utc('2026-11-03T15:00:00Z')), '2026-11-04')
    assert.equal(db.noon('2026-11-04'), utc('2026-11-04T03:00:00Z'))
    assert.equal(db.monthStart('2026-11'), utc('2026-10-31T15:00:00Z'))
    assert.throws(() => setTimeZone('Mars/Olympus'), /Unknown time zone/)
    assert.equal(db.zone(), 'Asia/Seoul')
    setTimeZone(null)
    assert.equal(db.zone(), defaultZone())
  })

  test('SQL reads a time on the ledger\'s clock as dayKey does, over the years', () => {
    for (const zone of ['America/Chicago', 'America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata']) {
      setTimeZone(zone)
      // Every 7 hours and 13 minutes lands on both sides of each clock change.
      const rows = db.all<{ t: number; d: string }>(
        `WITH RECURSIVE s(t) AS (SELECT ? UNION ALL SELECT t + ${7 * 3600 + 13 * 60} FROM s WHERE t < ?) SELECT t, date(${db.localSql('t')}) AS d FROM s`,
        utc('1995-01-01T00:00:00Z'),
        utc('2055-01-01T00:00:00Z')
      )
      assert.ok(rows.length > 70_000)
      const wrong = rows.filter((r) => r.d !== db.dayKey(r.t))
      assert.deepEqual(wrong.slice(0, 3), [], zone)
    }
    setTimeZone(null)
  })
})
