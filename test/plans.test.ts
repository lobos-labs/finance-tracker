import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as plans from '../src/shared/plans.ts'
import { betaEndsAt, FEATURES, hasFeature, planState, TRIAL_DAYS } from '../src/shared/plans.ts'
import { AI_BUDGET_MICROS, budgetPercent, callCostMicros } from '../src/shared/aiCost.ts'

const DAY = 86_400_000
const now = Date.parse('2026-10-20T15:00:00Z')
const ago = (days: number): string => new Date(now - days * DAY).toISOString()

describe('planState', () => {
  test('nothing set: free, no trial', () => {
    assert.deepEqual(planState({}, now), { plan: 'free', trialDaysLeft: 0, trialEndsAt: null })
  })
  test('a trial started just now has the whole 14 days', () => {
    const s = planState({ trialStartedAt: ago(0) }, now)
    assert.equal(s.plan, 'trial')
    assert.equal(s.trialDaysLeft, TRIAL_DAYS)
    assert.equal(s.trialEndsAt, new Date(now + TRIAL_DAYS * DAY).toISOString())
  })
  test('the last half day still counts as a day', () => {
    assert.deepEqual(planState({ trialStartedAt: ago(13.5) }, now).trialDaysLeft, 1)
  })
  test('fourteen days on, the trial is over', () => {
    assert.equal(planState({ trialStartedAt: ago(14) }, now).plan, 'free')
    assert.equal(planState({ trialStartedAt: ago(40) }, now).trialDaysLeft, 0)
  })
  test('a start date in the future is capped at the trial length', () => {
    assert.equal(planState({ trialStartedAt: ago(-3) }, now).trialDaysLeft, TRIAL_DAYS)
  })
  test('paid Plus beats the trial, and lapses', () => {
    assert.equal(planState({ trialStartedAt: ago(2), plusUntil: ago(-30) }, now).plan, 'plus')
    assert.equal(planState({ trialStartedAt: ago(2), plusUntil: ago(1) }, now).plan, 'trial')
    assert.equal(planState({ plusUntil: ago(1) }, now).plan, 'free')
  })
  test('unreadable dates count as unset', () => {
    assert.equal(planState({ trialStartedAt: 'soon', plusUntil: '' }, now).plan, 'free')
  })
  test('accepts a Date for now', () => {
    assert.equal(planState({ trialStartedAt: ago(1) }, new Date(now)).plan, 'trial')
  })
})

describe('features and caps', () => {
  test('every feature in the brief is listed, and all of them are Plus', () => {
    const ids = FEATURES.map((f) => f.id).sort()
    // partner: one partner on the books (the hosted ledger's household, 2026-11-03); mcp: connected AI apps (the same day).
    assert.deepEqual(ids, ['ai', 'benefits', 'credit', 'documents', 'googleSync', 'includedAi', 'insurance', 'investmentReturns', 'liveValues', 'mcp', 'moneyFlow', 'multiBank', 'netWorth', 'partner', 'taxes', 'ventures'])
    assert.ok(FEATURES.every((f) => f.plan === 'plus'))
  })
  test('the phone is no plan feature: it is the main app on Free', () => {
    assert.ok(!FEATURES.some((f) => (f.id as string) === 'phone' || f.wire === 'companion'))
  })
  test('a trial unlocks what Plus does; free unlocks none of them', () => {
    assert.equal(hasFeature('trial', 'ventures'), true)
    assert.equal(hasFeature('plus', 'ventures'), true)
    assert.equal(hasFeature('free', 'ventures'), false)
  })
  test('the AI allowance is a budget: $3 for the trial, $5 a month on Plus', () => {
    assert.deepEqual(AI_BUDGET_MICROS, { trial: 3_000_000, plus: 5_000_000 })
  })
  test('a call costs its list price in micro-dollars, rounded up', () => {
    const call = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 2000 }
    // Sonnet: $2 in, $10 out, $0.20 cache reads, $2.50 cache writes per million.
    assert.equal(callCostMicros({ model: 'claude-sonnet-5-5', ...call }), 2000 + 1000 + 2000 + 5000)
    // Haiku: a tenth of a micro-dollar per input token.
    assert.equal(callCostMicros({ model: 'claude-haiku-5-5', ...call }), Math.ceil(100 + 50 + 100 + 250))
    // Haiku past a 100K-token prompt takes its long-context rates.
    assert.equal(callCostMicros({ model: 'claude-haiku-5-5', inputTokens: 200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 100_000)
    // A web search is a cent; a model the table doesn't name is charged as Sonnet.
    assert.equal(callCostMicros({ model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 3 }), 30_000)
    assert.equal(callCostMicros({ model: 'something-else', ...call }), callCostMicros({ model: 'claude-sonnet-5-5', ...call }))
  })
  test('the share used is a whole percent, never past 100', () => {
    assert.equal(budgetPercent(0, 5_000_000), 0)
    assert.equal(budgetPercent(1_249_999, 5_000_000), 24)
    assert.equal(budgetPercent(9_000_000, 5_000_000), 100)
    assert.equal(budgetPercent(1, 0), 100)
  })
  test('every feature has a wire name the server can put in a token', () => {
    const wires = FEATURES.map((f) => f.wire)
    assert.equal(new Set(wires).size, wires.length)
    assert.ok(wires.every((w) => /^[a-z_]+$/.test(w)))
    assert.ok(wires.includes('ai_allowance'))
  })
  test('no plan limits accounts: there is no account feature and no account limit', () => {
    assert.ok(!FEATURES.some((f) => /account/i.test(f.id) || /account/i.test(f.wire)))
    assert.ok(!('FREE_ACCOUNT_LIMIT' in plans) && !('accountsAllowed' in plans))
  })
})

describe('betaEndsAt', () => {
  test('the beta ends at the local midnight after its last day', () => {
    assert.equal(betaEndsAt('2027-03-31'), new Date(2027, 3, 1).getTime())
    assert.equal(betaEndsAt('2026-12-31'), new Date(2027, 0, 1).getTime())
    assert.equal(betaEndsAt('2028-02-29'), new Date(2028, 2, 1).getTime())
  })
  test('no date, or not a real day as YYYY-MM-DD, is no beta', () => {
    for (const bad of ['', null, undefined, '2027-02-30', '2027-13-01', '2027-3-31', '31/03/2027', '2027-03-31T00:00:00Z']) assert.equal(betaEndsAt(bad), null, String(bad))
  })
})
