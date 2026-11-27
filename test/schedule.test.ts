import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, occurrences } from '../src/shared/schedule.ts'

describe('occurrences', () => {
  test('monthly keeps the day, clamped to a short month', () => {
    assert.deepEqual(occurrences('2026-01-31', 'monthly', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })
  test('days step across month ends and years', () => {
    assert.equal(addDays('2026-12-30', 3), '2027-01-02')
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  })
  test('twice a month alternates the two paydays', () => {
    assert.deepEqual(occurrences('2026-11-01', 'semimonthly', '2026-12-01'), ['2026-11-01', '2026-11-16', '2026-12-01'])
  })
})
