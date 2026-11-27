import Anthropic from '@anthropic-ai/sdk'
import { devBuild, devEnv } from '../devBuild'
import { readSecret } from '../secrets'
import { AiError, requireAi, type AiBackend } from './backend'
import { recordKeyCheck, runKeyCheck } from './keyCheck'
import { noKeyLine, sdkBackend } from './sdkBackend'
import type { KeyCheck } from '../../shared/checks'

// Claude over the Messages API with the user's own key. The request code is
// sdkBackend.ts, which the hosted service (proxy.ts) shares with a different client.

// Named here so an ANTHROPIC_BASE_URL in the environment can't send the data
// elsewhere; a development build may point it at a local stand-in instead.
export const API_BASE_URL = 'https://api.anthropic.com'

export function apiKeySource(): 'saved' | 'env' | 'none' {
  if (readSecret('anthropicApiKey')) return 'saved'
  if (devBuild() && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) return 'env'
  return 'none'
}

/** A client on the saved key, or on `key` (a key being checked before it's saved). */
export function makeClient(key?: string): Anthropic {
  const saved = key || readSecret('anthropicApiKey')
  const baseURL = devEnv('FINANCE_TRACKER_ANTHROPIC_BASE_URL') || API_BASE_URL
  // The product uses the saved key only, and no bearer token from ANTHROPIC_AUTH_TOKEN
  // beside it; a development build may fall back to the SDK's own resolution
  // (environment variables or an `ant auth login` profile).
  if (!saved && !devBuild()) throw new AiError('auth', noKeyLine())
  try {
    return saved ? new Anthropic({ apiKey: saved, authToken: null, baseURL }) : new Anthropic({ baseURL })
  } catch {
    throw new AiError('auth', noKeyLine())
  }
}

export const anthropicBackend = (): AiBackend =>
  sdkBackend('api', makeClient, async () => (apiKeySource() === 'none' ? { ready: false, provider: 'api', problem: 'No API key' } : { ready: true, provider: 'api' }))

/**
 * Checks a key with one billed call (keyCheck.ts): `key` when given (the
 * wizard checks before it saves), else the key in use. The result is kept
 * for the key in use, or for `key` once it's saved; the key never is. While
 * the AI is off it refuses, before anything is sent or logged.
 */
export async function checkApiKey(key?: string): Promise<KeyCheck> {
  requireAi()
  const given = typeof key === 'string' ? key.trim() : ''
  if (!given && apiKeySource() === 'none') throw new AiError('auth', noKeyLine())
  const check = await runKeyCheck(makeClient(given || undefined))
  recordKeyCheck(check, given && given !== readSecret('anthropicApiKey') ? given : undefined)
  console.info(`[ai] key check: ${check.result}${check.status ? ` (${check.status})` : ''}`)
  return check
}
