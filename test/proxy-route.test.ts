import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { closeDb, openDb } from '../src/main/db.ts'
import { sdkBackend } from '../src/main/ai/sdkBackend.ts'

// The hosted service refuses a request without an X-Route header (it meters
// and allowlists by feature), so every hosted call names its route. Calls with
// the user's own key go straight to Anthropic and carry no such header.

const dir = mkdtempSync(join(tmpdir(), 'finance-proxy-route-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const seen: Array<string | null> = []
const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  seen.push(new Headers(init?.headers).get('x-route'))
  return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' }
  })
}) as typeof fetch
const client = (): Anthropic => new Anthropic({ apiKey: 'sk-ant-test-not-a-key', baseURL: 'https://proxy.test.invalid', fetch: fakeFetch, maxRetries: 0 })
const ready = async () => ({ ready: true, provider: 'proxy' as const })
const ask = { system: 'Answer.', prompt: 'Hi', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }

describe('the route header', () => {
  before(() => openDb(join(dir, 'finance.db')))
  after(closeDb)

  test('hosted calls name their route', async () => {
    seen.length = 0
    await sdkBackend('proxy', client, ready).structured({ route: 'headline', ...ask })
    await sdkBackend('proxy', client, ready).step({ route: 'review', system: 'Help.', messages: [{ role: 'user', content: 'Hi' }], tools: [] })
    assert.deepEqual(seen, ['headline', 'review'])
  })

  test('calls with the user\'s own key carry no route header', async () => {
    seen.length = 0
    await sdkBackend('api', client, async () => ({ ready: true, provider: 'api' })).structured({ route: 'categorize', ...ask })
    assert.deepEqual(seen, [null])
  })
})
