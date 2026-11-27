// When Google gets calls faster than it wants them (a sync after a few days
// away has a backlog), it answers "slow down": 429, or a 403 whose reason is a
// rate limit. Those calls are tried again after a pause instead of failing the
// whole sync. A 403 for anything else (a calendar that isn't the app's, a
// daily quota) is a real answer and isn't retried. No Electron here, so the
// tests read it plain.

/** How many times one call is tried before its answer stands. */
export const MAX_TRIES = 5

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])
const MAX_WAIT_MS = 60_000

/** Whether Google's answer says to slow down, as opposed to a refusal. */
export function isRateLimited(status: number, json: Record<string, unknown>): boolean {
  if (status === 429) return true
  if (status !== 403) return false
  const error = (json['error'] ?? {}) as { status?: string; errors?: Array<{ reason?: string }> }
  return error.status === 'RESOURCE_EXHAUSTED' || (error.errors ?? []).some((e) => RATE_REASONS.has(e.reason ?? ''))
}

/** How long to wait after the `attempt`th try was told to slow down: Google's Retry-After seconds when it gives them, else 1, 2, 4, 8 s plus up to a second of jitter so parallel calls don't come back together. */
export function retryDelay(attempt: number, retryAfter: string | null, random: () => number = Math.random): number {
  const seconds = Number(retryAfter)
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS)
  return Math.min(1000 * 2 ** (attempt - 1) + Math.floor(random() * 1000), MAX_WAIT_MS)
}
