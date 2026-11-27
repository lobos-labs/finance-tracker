import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isRateLimited, MAX_TRIES, retryDelay } from '../src/main/googleRetry.ts'

// Google's "slow down" answers are tried again after a pause; its refusals
// stand. A first sync after a few days' gap can die on
// "removing an event failed (403: Rate Limit Exceeded)".

const calendar403 = (reason: string): Record<string, unknown> => ({ error: { code: 403, message: 'x', errors: [{ domain: 'usageLimits', reason }] } })

describe('Google retries', () => {
  test('rate limits are retried', () => {
    assert.ok(isRateLimited(403, calendar403('rateLimitExceeded')))
    assert.ok(isRateLimited(403, calendar403('userRateLimitExceeded')))
    assert.ok(isRateLimited(403, { error: { code: 403, status: 'RESOURCE_EXHAUSTED' } }))
    assert.ok(isRateLimited(429, {}))
  })

  test('refusals and successes are not', () => {
    assert.equal(isRateLimited(403, calendar403('forbidden')), false)
    // A daily quota won't lift in seconds.
    assert.equal(isRateLimited(403, calendar403('quotaExceeded')), false)
    assert.equal(isRateLimited(403, {}), false)
    for (const status of [200, 204, 400, 401, 404, 409, 410, 500]) assert.equal(isRateLimited(status, calendar403('rateLimitExceeded')), false, String(status))
  })

  test('waits double from a second, with under a second of jitter', () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => retryDelay(n, null, () => 0)), [1000, 2000, 4000, 8000])
    assert.equal(retryDelay(1, null, () => 0.999), 1999)
    assert.ok(MAX_TRIES >= 4)
  })

  test('Google\'s Retry-After wins, capped at a minute', () => {
    assert.equal(retryDelay(1, '7', () => 0.5), 7000)
    assert.equal(retryDelay(3, '0', () => 0.5), 0)
    assert.equal(retryDelay(1, '3600'), 60_000)
    // Not a number of seconds: fall back to doubling.
    assert.equal(retryDelay(2, 'Sat, 31 Oct 2026 16:00:00 GMT', () => 0), 2000)
    assert.equal(retryDelay(2, '', () => 0), 2000)
  })
})
