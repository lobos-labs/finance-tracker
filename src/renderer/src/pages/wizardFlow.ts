import { setupTokenClaimUrl, type KeyCheck } from '../../../shared/checks'
import type { AiSetup } from '../../../shared/types'

// What the first-run wizard's AI and bank steps do next, apart from React so
// the tests can walk them (test/setup-checks.test.ts).

/** The last check, with the key as the field had it (an empty key: the environment's). */
export interface CheckedKey {
  key: string
  check: KeyCheck
}

/** The check of the key in the field now; editing the key drops it. */
export const currentCheck = (key: string, checked: CheckedKey | null): KeyCheck | null => (checked && checked.key === key.trim() ? checked.check : null)

/**
 * The AI step's Enter and primary button. blocked: no key to use. check: run
 * the check, then advance if it passes. advance: go on. retry: the key's
 * check failed, so Enter tries again ("Continue anyway" is a click).
 */
export function aiPrimary(o: { ai: AiSetup; key: string; envKey: boolean; checked: CheckedKey | null }): 'blocked' | 'check' | 'advance' | 'retry' {
  if (o.ai !== 'key') return 'advance'
  if (!o.key.trim() && !o.envKey) return 'blocked'
  const c = currentCheck(o.key, o.checked)
  if (!c) return 'check'
  return c.result === 'ok' ? 'advance' : 'retry'
}

/**
 * The bank step's Enter: on once a bank is connected, else Plaid's page. With
 * SimpleFIN (the token field passed): on when the field is empty; invalid when
 * the text isn't a setup token, so nothing is sent; else connect, claiming it.
 */
export function bankPrimary(o: { connected: boolean; token?: string }): 'advance' | 'invalid' | 'connect' {
  if (o.connected) return 'advance'
  if (o.token === undefined) return 'connect'
  if (!o.token.trim()) return 'advance'
  return setupTokenClaimUrl(o.token) ? 'connect' : 'invalid'
}

/** "3 accounts · 1,204 transactions" */
export const foundLine = (accounts: number, transactions: number | null): string =>
  `${accounts} account${accounts === 1 ? '' : 's'}${transactions !== null ? ` · ${transactions.toLocaleString('en-US')} transactions` : ''}`
