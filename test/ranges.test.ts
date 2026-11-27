import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { QUANTILES, at } from '../src/shared/ranges.ts'

// Every 5th percentile, 0 to 1000: the 50th is 500.
const q = QUANTILES.map((p) => p * 10)

describe('quantiles', () => {
  test('every 5th percentile from 0 to 100', () => {
    assert.equal(QUANTILES.length, 21)
    assert.equal(QUANTILES[0], 0)
    assert.equal(QUANTILES[10], 50)
    assert.equal(QUANTILES[20], 100)
  })

  test('the value at a percentile', () => {
    assert.equal(at(q, 0), 0)
    assert.equal(at(q, 50), 500)
    assert.equal(at(q, 95), 950)
    assert.equal(at(q, 100), 1000)
  })
})
