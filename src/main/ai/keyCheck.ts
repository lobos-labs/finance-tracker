import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import * as db from '../db'
import { endRequest, startRequest } from './requestLog'
import { isKeyCheck, keyCheckLine, type KeyCheck } from '../../shared/checks'
import type { ModelId } from '../../shared/types'

// The API key's check: the smallest billed call the Messages API takes (the
// cheapest model, one output token, a one-word message, no system prompt, no
// tools), so a pass means the key works and the account can pay for calls; a
// models lookup passes on an account with no credits. The result is kept in
// settings without the key. Free of Electron, so the tests run it with a fake
// fetch; anthropic.ts builds the client and passes it in.

export const KEY_CHECK_MODEL: ModelId = 'claude-haiku-5-5'
const SETTING = 'ai.keyCheck'
const TIMEOUT_MS = 20_000
/** A check of a key not saved yet counts for that key when it's saved within this long. */
const PENDING_SECONDS = 30 * 60
// "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
const NO_CREDITS = /credit[\s_-]*balance|billing|purchase credits|insufficient credit|out of credits|no credits/i

/** What a failed call says about the key, most specific first (a timeout is a connection error, and both are API errors). */
export function keyCheckResult(err: unknown): Pick<KeyCheck, 'result' | 'status'> {
  if (err instanceof Anthropic.APIConnectionError) return { result: 'offline' }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const status = err.status
    if (status === 401) return { result: 'invalid', status }
    if ((status === 400 || status === 402) && (err.type === 'billing_error' || NO_CREDITS.test(err.message))) return { result: 'no_credits', status }
    if (status === 403) return { result: 'forbidden', status }
    if (status === 429 || status === 529) return { result: 'rate_limited', status }
    return { result: 'error', status }
  }
  return { result: 'error' }
}

/** Makes the check's one call with the client; never throws. No retries, so a limit or an outage answers at once. */
export async function runKeyCheck(client: Anthropic, o: { timeoutMs?: number } = {}): Promise<KeyCheck> {
  const body = { model: KEY_CHECK_MODEL, max_tokens: 1, messages: [{ role: 'user' as const, content: 'Hi' }] }
  // In the request log like every other call (the key goes in a header, never in the log).
  const logged = startRequest({ route: 'keyCheck', provider: 'api', model: KEY_CHECK_MODEL }, body)
  try {
    const r = await client.messages.create(body, { maxRetries: 0, timeout: o.timeoutMs ?? TIMEOUT_MS })
    endRequest(logged, { usage: { model: r.model, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, cacheReadTokens: r.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0, stopReason: r.stop_reason } })
    return { result: 'ok', at: db.now() }
  } catch (err) {
    const found = keyCheckResult(err)
    endRequest(logged, { error: keyCheckLine(found) })
    return { ...found, at: db.now() }
  }
}

// ---------- the last check ----------

export function lastKeyCheck(): KeyCheck | null {
  const raw = db.getSetting(SETTING)
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    return isKeyCheck(v) ? v : null
  } catch {
    return null
  }
}

function store(c: KeyCheck | null): void {
  db.setSetting(SETTING, c ? JSON.stringify({ result: c.result, at: c.at, ...(c.status ? { status: c.status } : {}) }) : null)
}

// The wizard checks a key before it saves it: that check waits here, by the
// key's hash and in memory only, until the same key is saved.
let pending: { hash: string; check: KeyCheck } | null = null
const hashOf = (key: string): string => createHash('sha256').update(key).digest('hex')

/** Records a check: of the key in use at once; of a key not saved yet (`unsaved`), when that key is saved. */
export function recordKeyCheck(check: KeyCheck, unsaved?: string): void {
  if (unsaved) pending = { hash: hashOf(unsaved), check }
  else {
    pending = null
    store(check)
  }
}

/** A key was saved: it keeps its own check when it was just checked; any other key starts unchecked. */
export function keySaved(key: string): void {
  const p = pending
  pending = null
  store(p && p.hash === hashOf(key) && db.now() - p.check.at <= PENDING_SECONDS ? p.check : null)
}

export function keyRemoved(): void {
  pending = null
  store(null)
}
