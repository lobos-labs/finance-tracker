// The setup checks, as the wizard and Settings show them: what the API key's
// check found (src/main/ai/keyCheck.ts runs it), the status dot it gives, and
// whether a pasted SimpleFIN setup token is one at all. Shared so the window
// can say "Not a setup token" before anything goes over the network.

/**
 * ok: the key made a billed call. invalid: the key was rejected (401).
 * no_credits: billing refused the call. forbidden: the key can't use the
 * model (403). rate_limited: 429 or 529. offline: no answer from the service.
 * error: anything else.
 */
export const KEY_CHECK_RESULTS = ['ok', 'invalid', 'no_credits', 'forbidden', 'rate_limited', 'offline', 'error'] as const
export type KeyCheckResult = (typeof KEY_CHECK_RESULTS)[number]

/** The last check of the API key, as settings keep it (ai.keyCheck): never the key. */
export interface KeyCheck {
  result: KeyCheckResult
  /** when it ran, Unix seconds */
  at: number
  /** the HTTP status, when the service answered with an error */
  status?: number
}

const LINES: Record<Exclude<KeyCheckResult, 'error'>, string> = {
  ok: 'Key works',
  invalid: 'Key rejected',
  no_credits: 'No credits on this account',
  forbidden: "Key can't use this model",
  rate_limited: 'Busy, try again',
  offline: "Can't reach Anthropic"
}

/** A check's one-line result. */
export const keyCheckLine = (c: Pick<KeyCheck, 'result' | 'status'>): string => (c.result === 'error' ? `Anthropic error${c.status ? ` ${c.status}` : ''}` : LINES[c.result])

export const isKeyCheck = (v: unknown): v is KeyCheck => {
  const c = v as KeyCheck | null
  return !!c && typeof c === 'object' && (KEY_CHECK_RESULTS as readonly string[]).includes(c.result) && Number.isFinite(c.at) && (c.status === undefined || Number.isInteger(c.status))
}

/** on: green. warn: amber. bad: red. */
export type DotState = 'on' | 'warn' | 'bad'

/** The API key's status dot: green only after a check passed, amber while a key was never checked, red otherwise (no key, or a failed check). */
export function keyDot(source: 'saved' | 'env' | 'none', check: KeyCheck | null): DotState {
  if (source === 'none') return 'bad'
  if (!check) return 'warn'
  return check.result === 'ok' ? 'on' : 'bad'
}

/**
 * The claim URL inside a SimpleFIN setup token, or null when the text isn't
 * one: a setup token is base64 (pasted line breaks and the URL-safe alphabet
 * are accepted) of an https URL.
 */
export function setupTokenClaimUrl(token: string): string | null {
  const t = String(token ?? '').replace(/\s+/g, '')
  if (!t || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null
  let text: string
  try {
    const bin = atob(t.replace(/-/g, '+').replace(/_/g, '/'))
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))).trim()
  } catch {
    return null
  }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  return u.protocol === 'https:' && u.hostname ? text : null
}
