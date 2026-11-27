// What the included AI costs us, at Anthropic's list prices, and the budget
// each plan gets for it (in place of per-feature caps):
// $5 a month on Plus and $3 for the whole 14-day trial, in micro-dollars
// (millionths of a dollar). The server enforces the budget from each answer's
// usage (finance-server proxy/quota.ts); the app counts the same way for its
// own check and for Settings, which shows only the share used. A Review
// message on Sonnet measured about $0.048 (scripts/review-eval), so Plus's
// budget is about a hundred of them.

export const AI_BUDGET_MICROS = { trial: 3_000_000, plus: 5_000_000 } as const

/** One model call's usage, as the API reports it. */
export interface CallUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** web searches Anthropic ran (usage.server_tool_use.web_search_requests) */
  webSearches?: number
}

/** Dollars per million tokens. A cache write is the five-minute kind: 1.25 times input. */
interface Rates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const rates = (input: number, output: number, cacheRead: number): Rates => ({ input, output, cacheRead, cacheWrite: input * 1.25 })

/** Each model's rates; Haiku 5.5 costs more once a prompt passes 100K tokens. */
const PRICES: Record<string, { base: Rates; long?: { over: number; rates: Rates } }> = {
  'claude-haiku-5-5': { base: rates(0.1, 0.5, 0.01), long: { over: 100_000, rates: rates(0.5, 2.5, 0.05) } },
  'claude-sonnet-5-5': { base: rates(2, 10, 0.2) },
  'claude-opus-5-5': { base: rates(4, 20, 0.2) }
}

/** A model this table doesn't name is charged as Sonnet. */
const FALLBACK = 'claude-sonnet-5-5'

/** $10 per 1,000 searches. */
const WEB_SEARCH_MICROS = 10_000

/** What one call cost, in micro-dollars, rounded up. */
export function callCostMicros(u: CallUsage): number {
  const price = PRICES[u.model] ?? PRICES[FALLBACK]!
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  const r = price.long && prompt > price.long.over ? price.long.rates : price.base
  // Dollars per million tokens is micro-dollars per token.
  const tokens = u.inputTokens * r.input + u.outputTokens * r.output + u.cacheReadTokens * r.cacheRead + u.cacheWriteTokens * r.cacheWrite
  // Rounded to a millionth first, so float noise (0.1 × 3) never rounds a whole number up.
  return Math.ceil(Math.round((tokens + (u.webSearches ?? 0) * WEB_SEARCH_MICROS) * 1e6) / 1e6)
}

/** The share of a budget used, as a whole percent from 0 to 100. */
export const budgetPercent = (used: number, budget: number): number => (budget > 0 ? Math.min(100, Math.floor((used / budget) * 100)) : 100)
