import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { addManualAccount, closeDb, get, getSetting, getTransaction, listCategories, openDb, setSetting, setTransactionFields, upsertAccount, upsertRule, upsertTransaction } from '../src/main/db.ts'
import { AI_OFF, AiError, aiEnabled, aiStatus, configureAi, getBackend, setAiEnabled, type AiBackend } from '../src/main/ai/backend.ts'
import { listRequests } from '../src/main/ai/requestLog.ts'
import { sdkBackend } from '../src/main/ai/sdkBackend.ts'
import { classify } from '../src/main/classifier.ts'
import { getInsight } from '../src/main/insights.ts'
import { AI_ROUTES } from '../src/shared/types.ts'

// The AI switch under Settings → AI, off (ai.enabled = '0'): no request leaves the
// computer for any route, the key check included, and nothing reaches the
// request log or the usage counts. Categorization still runs rules and
// history, the headline is the local one, Review shows why, values skip.
// The backend here is the real SDK one over a fetch that records every call,
// so a request that got through would show up both in the fetch and in the log.

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'finance-ai-off-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// Review and the key check import Electron: the demo dump's stand-in takes its place.
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})
// Nothing here reads the real documents folder, and a key check that slipped through would reach no one
// (a development build, the default here, takes the stand-in address; the provider is set to the key below).
process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
process.env['FINANCE_TRACKER_ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:9'
mkdirSync(join(dir, 'docs'), { recursive: true })
const electron = (await import('../scripts/demo-electron.ts')) as { setBase: (d: string, v: string) => void }
electron.setBase(join(dir, 'electron'), '0.0.0-test')
const { checkApiKey } = await import('../src/main/ai/anthropic.ts')
const { reviewSend } = await import('../src/main/review.ts')
const { revalue, revalueDue } = await import('../src/main/valuation.ts')

const HEADLINE = { headline: 'Dining Out is $12 above your usual pace', detail: '$12 so far.', tone: 'negative', category: 'Dining Out', angle: 'category' }

/** Every request body the backend posted. */
const sent: Array<Record<string, unknown>> = []
const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { system?: Array<{ text: string }> }
  sent.push(body)
  const text = JSON.stringify(body.system?.[0]?.text.includes('headline') ? HEADLINE : { results: [] })
  return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' }
  })
}) as typeof fetch
const client = (): Anthropic => new Anthropic({ apiKey: 'sk-ant-test-not-a-key', baseURL: 'https://api.test.invalid', fetch: fakeFetch, maxRetries: 0 })

const isOff = (err: unknown): boolean => err instanceof AiError && err.kind === 'unavailable' && err.message === AI_OFF
const rows = (table: string): number => get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n
const category = (name: string): number => listCategories().find((c) => c.name === name)!.id
let posted = 1_760_000_000
const txn = (id: string, description: string, amountCents = -1234): void => {
  upsertTransaction({ id, accountId: 'manual:a', posted: (posted -= 3600), amountCents, description, pending: false })
}

describe('AI off', () => {
  /** a backend handed out while the AI was on */
  let early: AiBackend
  let house: string

  before(() => {
    openDb(join(dir, 'finance.db'))
    // The AI is a Plus feature (Free has none), whatever kind of build runs the tests.
    setSetting('plan.plusUntil', '2099-12-31T00:00:00.000Z')
    configureAi({ backends: { api: () => sdkBackend('api', client, async () => ({ ready: true, provider: 'api' })) } })
    setSetting('ai.provider', 'api')
    upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: 100_000, availableCents: null, balanceDate: posted })
    house = addManualAccount({ name: 'My house', assetType: 'property', openedDay: '2021-05-01', costCents: 30000000, points: [{ day: '2024-01-01', cents: 35000000 }] })
  })
  after(() => {
    configureAi({ backends: {} })
    closeDb()
  })

  test('it is on until switched off, and off is ai.enabled = 0', async () => {
    assert.equal(aiEnabled(), true)
    assert.equal(getSetting('ai.enabled'), null)
    early = getBackend()
    setAiEnabled(false)
    assert.equal(getSetting('ai.enabled'), '0')
    assert.equal(aiEnabled(), false)
    assert.deepEqual(await aiStatus(), { ready: false, provider: 'api', problem: AI_OFF })
    setAiEnabled(true)
    assert.equal(getSetting('ai.enabled'), null)
    assert.equal((await aiStatus()).ready, true)
  })

  test('categorization still applies rules and history and leaves the rest uncategorized', async () => {
    setAiEnabled(false)
    const bodies = sent.length
    const requests = rows('ai_requests')
    upsertRule('contains', 'costco', category('Groceries'))
    txn('t-rule', 'COSTCO WHSE #123')
    txn('t-seen-before', 'NETFLIX.COM')
    setTransactionFields('t-seen-before', { categoryId: category('Subscriptions'), source: 'ai', confidence: 'high', merchant: 'Netflix' })
    txn('t-history', 'NETFLIX.COM')
    txn('t-new', 'SQ *BLUE BOTTLE COFFEE #12 OAKLAND CA')

    const r = await classify({}, () => {})
    assert.deepEqual([r.total, r.fromRules, r.fromHistory, r.fromAi, r.failed], [3, 1, 1, 0, 0])
    // Off is a choice, not a failure: no error toast after every sync.
    assert.equal(r.error, undefined)
    assert.equal(getTransaction('t-rule')!.categoryId, category('Groceries'))
    assert.deepEqual([getTransaction('t-history')!.categoryId, getTransaction('t-history')!.merchant], [category('Subscriptions'), 'Netflix'])
    assert.equal(getTransaction('t-new')!.categoryId, null)
    assert.equal(sent.length, bodies)
    assert.equal(rows('ai_requests'), requests)
  })

  test('the headline is Claude\'s while on, and the local one once off, cached one or not', async () => {
    setAiEnabled(true)
    const ai = await getInsight(true)
    assert.equal(ai?.source, 'ai')
    const bodies = sent.length
    setAiEnabled(false)
    for (const force of [false, true]) {
      const local = await getInsight(force)
      assert.ok(local)
      assert.equal(local.source, 'local')
      assert.equal(local.error, AI_OFF)
    }
    assert.equal(sent.length, bodies)
  })

  test('every route refuses while off, and nothing is sent, logged or counted', async () => {
    setAiEnabled(false)
    const bodies = sent.length
    const logged = listRequests().length
    const requests = rows('ai_requests')
    const usage = rows('ai_usage')

    assert.throws(() => getBackend(), isOff)
    // A backend taken before the switch went off refuses each request it's asked for.
    for (const route of AI_ROUTES) {
      await assert.rejects(early.structured({ route, system: 'You answer.', prompt: 'Anything', schema: { type: 'object' } }), isOff)
      await assert.rejects(early.step({ route, system: 'You answer.', messages: [{ role: 'user', content: 'Anything' }], tools: [] }), isOff)
    }
    // The key check, of a key being entered and of the one in use.
    await assert.rejects(checkApiKey('sk-ant-test-not-a-key'), isOff)
    await assert.rejects(checkApiKey(), isOff)
    // Values: a lookup says why; the monthly ones skip.
    await assert.rejects(revalue(house), isOff)
    assert.deepEqual(await revalueDue(), [])
    // Review: the reason in the chat, and no conversation saved.
    const { state } = await reviewSend(null, () => {})
    const last = state.items[state.items.length - 1]
    assert.deepEqual([last?.role, last?.text, last?.ok], ['action', AI_OFF, false])
    assert.equal(getSetting('review.session'), null)

    assert.equal(sent.length, bodies)
    assert.equal(listRequests().length, logged)
    assert.equal(rows('ai_requests'), requests)
    assert.equal(rows('ai_usage'), usage)
  })

  test('switched back on, the same backend sends again and the log records it', async () => {
    setAiEnabled(true)
    const bodies = sent.length
    const requests = rows('ai_requests')
    assert.deepEqual(await early.structured({ route: 'categorize', system: 'You categorize.', prompt: 'Categorize these transactions', schema: { type: 'object' } }), { results: [] })
    assert.equal(sent.length, bodies + 1)
    assert.equal(rows('ai_requests'), requests + 1)
    // And categorization asks Claude for what's left.
    await classify({}, () => {})
    assert.equal(sent.length, bodies + 2)
  })
})
