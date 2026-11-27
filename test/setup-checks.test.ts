import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { closeDb, getSetting, openDb, setSetting } from '../src/main/db.ts'
import { KEY_CHECK_MODEL, keyCheckResult, keyRemoved, keySaved, lastKeyCheck, recordKeyCheck, runKeyCheck } from '../src/main/ai/keyCheck.ts'
import { claimSetupToken } from '../src/main/simplefinClaim.ts'
import { KEY_CHECK_RESULTS, keyCheckLine, keyDot, setupTokenClaimUrl, type KeyCheck } from '../src/shared/checks.ts'
import { MODEL_OPTIONS } from '../src/shared/types.ts'
import { aiPrimary, bankPrimary, currentCheck, foundLine } from '../src/renderer/src/pages/wizardFlow.ts'

// The setup wizard's checks: the API key's one billed call (with a fake fetch
// under the real SDK), the SimpleFIN setup token, the stored result, the
// status dot, and the wizard's next step for each state.

const KEY = 'sk-ant-test-0123456789'

/** A fetch that answers every call with `answer` and keeps each request. */
function fakeFetch(answer: (n: number, init: RequestInit) => Response | Promise<Response>): typeof fetch & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return answer(calls.length, init ?? {})
  }) as typeof fetch & { calls: typeof calls }
  f.calls = calls
  return f
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
const apiError = (status: number, type: string, message: string): Response => json(status, { type: 'error', error: { type, message }, request_id: 'req_test' })
const message = (): Response =>
  json(200, { id: 'msg_test', type: 'message', role: 'assistant', model: KEY_CHECK_MODEL, content: [{ type: 'text', text: 'Hi' }], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } })

const client = (f: typeof fetch): Anthropic => new Anthropic({ apiKey: KEY, baseURL: 'https://api.test.invalid', fetch: f })

async function checkWith(answer: (n: number, init: RequestInit) => Response | Promise<Response>, timeoutMs?: number): Promise<KeyCheck & { calls: number }> {
  const f = fakeFetch(answer)
  const c = await runKeyCheck(client(f), { timeoutMs })
  return { ...c, calls: f.calls.length }
}

describe('the API key check', () => {
  test('is one minimal call: Haiku 5.5 from the model list, one token, one word, no system prompt or tools', async () => {
    assert.ok(MODEL_OPTIONS.some((m) => m.id === KEY_CHECK_MODEL))
    assert.equal(KEY_CHECK_MODEL, 'claude-haiku-5-5')
    const f = fakeFetch(() => message())
    const c = await runKeyCheck(client(f))
    assert.equal(c.result, 'ok')
    assert.equal(c.status, undefined)
    assert.ok(Math.abs(c.at - Date.now() / 1000) < 60)
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0].url, /\/v1\/messages$/)
    const body = JSON.parse(String(f.calls[0].init.body)) as Record<string, unknown>
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model'])
    assert.equal(body.model, 'claude-haiku-5-5')
    assert.equal(body.max_tokens, 1)
    const messages = body.messages as Array<{ role: string; content: string }>
    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'user')
    assert.match(messages[0].content, /^\w+$/)
  })

  test('maps each answer to one result, with no retries', async () => {
    const cases: Array<[Response | (() => Response), KeyCheck['result'], number | undefined]> = [
      [apiError(401, 'authentication_error', 'invalid x-api-key'), 'invalid', 401],
      [apiError(403, 'permission_error', 'Access to this model requires an access grant your request does not have.'), 'forbidden', 403],
      [apiError(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'), 'rate_limited', 429],
      [apiError(529, 'overloaded_error', 'Overloaded'), 'rate_limited', 529],
      [apiError(500, 'api_error', 'Internal server error'), 'error', 500],
      [apiError(404, 'not_found_error', 'model: claude-haiku-5-5'), 'error', 404],
      [apiError(400, 'invalid_request_error', 'messages: roles must alternate between "user" and "assistant"'), 'error', 400],
      [new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }), 'error', 502]
    ]
    for (const [res, result, status] of cases) {
      const c = await checkWith(() => (typeof res === 'function' ? res() : res.clone()))
      assert.equal(c.result, result, `${status}`)
      assert.equal(c.status, status)
      assert.equal(c.calls, 1, `${status} is not retried`)
    }
  })

  test('reads the no-credits answers, whichever way the service words them', async () => {
    const variants: Array<[number, string, string]> = [
      [400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'],
      [400, 'invalid_request_error', 'Your credit_balance is too low'],
      [400, 'invalid_request_error', 'This request would exceed your organization’s billing limit.'],
      [402, 'billing_error', 'Payment required'],
      [402, 'invalid_request_error', 'Insufficient credits: purchase credits to continue']
    ]
    for (const [status, type, text] of variants) {
      const c = await checkWith(() => apiError(status, type, text))
      assert.equal(c.result, 'no_credits', text)
      assert.equal(c.status, status)
    }
    // A 402 that says nothing about billing is still an error with its status.
    assert.deepEqual(keyCheckResult(new Anthropic.APIError(402, { type: 'error', error: { type: 'api_error', message: 'Something else' } }, undefined, new Headers())), { result: 'error', status: 402 })
  })

  test('no answer at all is offline: a refused connection and a timeout', async () => {
    const refused = await checkWith(() => {
      throw new TypeError('fetch failed')
    })
    assert.equal(refused.result, 'offline')
    assert.equal(refused.status, undefined)
    assert.equal(refused.calls, 1)
    // Never answers: only the check's own timeout ends the wait.
    const slow = await checkWith(
      (_n, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
        }),
      50
    )
    assert.equal(slow.result, 'offline')
  })

  test('anything that is not an API answer is an error without a status', () => {
    assert.deepEqual(keyCheckResult(new Error('boom')), { result: 'error' })
    assert.deepEqual(keyCheckResult('boom'), { result: 'error' })
  })

  test('each result has its one line', () => {
    assert.deepEqual(
      KEY_CHECK_RESULTS.map((r) => keyCheckLine({ result: r, status: r === 'error' ? 418 : undefined })),
      ['Key works', 'Key rejected', 'No credits on this account', "Key can't use this model", 'Busy, try again', "Can't reach Anthropic", 'Anthropic error 418']
    )
    assert.equal(keyCheckLine({ result: 'error' }), 'Anthropic error')
  })
})

describe('the stored check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-keycheck-'))
  before(() => openDb(join(dir, 'finance.db')))
  after(() => {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  })

  test('keeps the result and the time, never the key', () => {
    assert.equal(lastKeyCheck(), null)
    recordKeyCheck({ result: 'invalid', at: 1_760_000_000, status: 401 })
    assert.deepEqual(lastKeyCheck(), { result: 'invalid', at: 1_760_000_000, status: 401 })
    const raw = getSetting('ai.keyCheck') ?? ''
    assert.deepEqual(JSON.parse(raw), { result: 'invalid', at: 1_760_000_000, status: 401 })
    assert.doesNotMatch(raw, /sk-ant/)
  })

  test('saving a new key clears it; saving the key just checked keeps that key\'s check', () => {
    const now = Math.floor(Date.now() / 1000)
    recordKeyCheck({ result: 'ok', at: now })
    keySaved('sk-ant-another-key')
    assert.equal(lastKeyCheck(), null)

    // The wizard checks before it saves: the check waits for that very key.
    recordKeyCheck({ result: 'no_credits', at: now, status: 400 }, KEY)
    assert.equal(lastKeyCheck(), null)
    keySaved(KEY)
    assert.deepEqual(lastKeyCheck(), { result: 'no_credits', at: now, status: 400 })
    assert.doesNotMatch(getSetting('ai.keyCheck') ?? '', /sk-ant/)

    // A different key saved after a wizard check starts unchecked.
    recordKeyCheck({ result: 'ok', at: now }, KEY)
    keySaved('sk-ant-yet-another')
    assert.equal(lastKeyCheck(), null)

    // An old wizard check doesn't count for a key saved much later.
    recordKeyCheck({ result: 'ok', at: now - 3 * 3600 }, KEY)
    keySaved(KEY)
    assert.equal(lastKeyCheck(), null)
  })

  test('removing the key clears it, and a damaged value reads as never checked', () => {
    recordKeyCheck({ result: 'ok', at: 1_760_000_000 })
    keyRemoved()
    assert.equal(lastKeyCheck(), null)
    setSetting('ai.keyCheck', '{"result":"maybe","at":1}')
    assert.equal(lastKeyCheck(), null)
    setSetting('ai.keyCheck', 'not json')
    assert.equal(lastKeyCheck(), null)
  })
})

describe('the status dot', () => {
  test('green only after a pass, amber while never checked, red otherwise', () => {
    const at = 1_760_000_000
    assert.equal(keyDot('saved', { result: 'ok', at }), 'on')
    assert.equal(keyDot('env', { result: 'ok', at }), 'on')
    assert.equal(keyDot('saved', null), 'warn')
    assert.equal(keyDot('env', null), 'warn')
    assert.equal(keyDot('none', null), 'bad')
    assert.equal(keyDot('none', { result: 'ok', at }), 'bad')
    for (const r of KEY_CHECK_RESULTS.filter((x) => x !== 'ok')) assert.equal(keyDot('saved', { result: r, at }), 'bad', r)
  })
})

describe('the SimpleFIN setup token', () => {
  const claim = 'https://beta-bridge.simplefin.org/simplefin/claim/DEMO-1234'
  const token = Buffer.from(claim).toString('base64')

  test('is base64 of an https claim URL', () => {
    assert.equal(setupTokenClaimUrl(token), claim)
    assert.equal(setupTokenClaimUrl(`  ${token}\n`), claim)
    // Pasted with a line break in the middle, or in the URL-safe alphabet without padding.
    assert.equal(setupTokenClaimUrl(`${token.slice(0, 20)}\n${token.slice(20)}`), claim)
    const odd = 'https://bridge.example/claim/??>>'
    assert.equal(setupTokenClaimUrl(Buffer.from(odd).toString('base64url')), odd)
  })

  test('anything else is not a setup token', () => {
    for (const t of ['', '   ', 'hello world', claim, Buffer.from('http://beta-bridge.simplefin.org/claim/x').toString('base64'), Buffer.from('not a url').toString('base64'), Buffer.from('javascript:alert(1)').toString('base64'), 'abc!def', '%%%', Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), 'a']) {
      assert.equal(setupTokenClaimUrl(t), null, JSON.stringify(t))
    }
  })

  test('a claim maps each failure to one line', async () => {
    const access = 'https://user:secret@beta-bridge.simplefin.org/simplefin'
    const ok = fakeFetch(() => new Response(`${access}\n`, { status: 200 }))
    assert.equal(await claimSetupToken(token, ok), access)
    assert.equal(ok.calls[0].url, claim)
    assert.equal(ok.calls[0].init.method, 'POST')

    const none = fakeFetch(() => new Response('', { status: 200 }))
    await assert.rejects(claimSetupToken('not a token', none), { message: 'Not a setup token' })
    assert.equal(none.calls.length, 0, 'nothing is sent for text that is not a token')

    await assert.rejects(claimSetupToken(token, fakeFetch(() => new Response('Forbidden', { status: 403 }))), { message: 'Token already used' })
    await assert.rejects(claimSetupToken(token, fakeFetch(() => new Response('', { status: 500 }))), { message: 'Bridge error 500' })
    await assert.rejects(claimSetupToken(token, fakeFetch(() => new Response('', { status: 404 }))), { message: 'Bridge error 404' })
    await assert.rejects(
      claimSetupToken(
        token,
        fakeFetch(() => {
          throw new TypeError('fetch failed')
        })
      ),
      { message: "Can't reach the bridge" }
    )
    await assert.rejects(claimSetupToken(token, fakeFetch(() => new Response('http://user:pw@bridge.example/x', { status: 200 }))), { message: 'Bridge error: no access URL' })
    await assert.rejects(claimSetupToken(token, fakeFetch(() => new Response('https://bridge.example/x', { status: 200 }))), { message: 'Bridge error: no access URL' })
    await assert.rejects(claimSetupToken(token, fakeFetch(() => new Response('<html>ok</html>', { status: 200 }))), { message: 'Bridge error: no access URL' })
  })
})

describe('the wizard steps', () => {
  const at = 1_760_000_000
  const ok: KeyCheck = { result: 'ok', at }
  const rejected: KeyCheck = { result: 'invalid', at, status: 401 }

  test('the AI step: check, then advance on a pass; a failure waits for Try again or Continue anyway', () => {
    assert.equal(aiPrimary({ ai: 'trial', key: '', envKey: false, checked: null }), 'advance')
    assert.equal(aiPrimary({ ai: 'claude-code', key: '', envKey: false, checked: null }), 'advance')
    assert.equal(aiPrimary({ ai: 'key', key: '  ', envKey: false, checked: null }), 'blocked')
    assert.equal(aiPrimary({ ai: 'key', key: '', envKey: true, checked: null }), 'check')
    assert.equal(aiPrimary({ ai: 'key', key: KEY, envKey: false, checked: null }), 'check')
    assert.equal(aiPrimary({ ai: 'key', key: KEY, envKey: false, checked: { key: KEY, check: ok } }), 'advance')
    assert.equal(aiPrimary({ ai: 'key', key: KEY, envKey: false, checked: { key: KEY, check: rejected } }), 'retry')
    // Editing the key drops its check, so Enter checks the new one.
    assert.equal(aiPrimary({ ai: 'key', key: `${KEY}x`, envKey: false, checked: { key: KEY, check: rejected } }), 'check')
    assert.equal(currentCheck(` ${KEY} `, { key: KEY, check: rejected }), rejected)
    assert.equal(currentCheck(`${KEY}x`, { key: KEY, check: rejected }), null)
    assert.equal(currentCheck('', { key: '', check: ok }), ok)
  })

  test('the bank step: Enter opens Plaid until a bank is connected, then moves on', () => {
    assert.equal(bankPrimary({ connected: false }), 'connect')
    assert.equal(bankPrimary({ connected: true }), 'advance')
    assert.equal(foundLine(1, null), '1 account')
    assert.equal(foundLine(3, 1204), '3 accounts · 1,204 transactions')
  })
})
