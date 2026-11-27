import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, LIMIT_FIELDS, limitsFor } from '../src/shared/limits.ts'

describe('yearly limits', () => {
  test('every year 2023..2027 has every field', () => {
    for (let year = 2023; year <= 2027; year++) {
      const l = LIMITS.find((x) => x.year === year)
      assert.ok(l, `${year} is in the table`)
      for (const f of LIMIT_FIELDS) {
        assert.ok(Number.isInteger(l[f].cents) && l[f].cents > 0, `${year} ${f} is a positive whole number of cents`)
        assert.equal(typeof l[f].provisional, 'boolean', `${year} ${f} says whether it is provisional`)
      }
    }
  })
  test('announced values', () => {
    assert.equal(limitsFor(2026).deferral.cents, 2_450_000)
    assert.equal(limitsFor(2026).deferral.provisional, false)
    assert.equal(limitsFor(2026).hsaSelf.cents, 440_000)
    assert.equal(limitsFor(2027).hsaSelf.cents, 450_000)
    assert.equal(limitsFor(2027).hsaSelf.provisional, false)
    assert.equal(limitsFor(2027).ssWageBase.cents, 19_230_000)
  })
  test('2027 carries unannounced figures forward as provisional', () => {
    assert.equal(limitsFor(2027).deferral.cents, limitsFor(2026).deferral.cents)
    assert.equal(limitsFor(2027).deferral.provisional, true)
    assert.equal(limitsFor(2027).fsa.provisional, true)
  })
  test('a year past the table gets the latest values, all provisional', () => {
    const l = limitsFor(2030)
    assert.equal(l.year, 2030)
    assert.equal(l.hsaSelf.cents, limitsFor(2027).hsaSelf.cents)
    for (const f of LIMIT_FIELDS) assert.equal(l[f].provisional, true, `${f} is provisional`)
  })
  test('a year before the table gets the earliest values, all provisional', () => {
    const l = limitsFor(2020)
    assert.equal(l.deferral.cents, limitsFor(2023).deferral.cents)
    assert.equal(l.deferral.provisional, true)
  })
  test('the HSA limit is never missing', () => {
    for (let year = 2020; year <= 2035; year++) assert.ok(limitsFor(year).hsaSelf.cents > 0)
  })
})
