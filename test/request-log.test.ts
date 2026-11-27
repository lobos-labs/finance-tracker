import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { addAiRequest, closeDb, exportAll, getSetting, now, openDb, setSetting } from '../src/main/db.ts'
import { webSearchTool, type AiBackend } from '../src/main/ai/backend.ts'
import { clearRequests, getRequest, LOG_DAYS, LOG_KEEP, listRequests, redactRequest, setRequestLogOn, startRequest } from '../src/main/ai/requestLog.ts'
import { sdkBackend } from '../src/main/ai/sdkBackend.ts'
import { runKeyCheck } from '../src/main/ai/keyCheck.ts'
import { removeData } from '../src/main/wipeFiles.ts'
import { cleanReport, MAILTO_MESSAGE_MAX, reportMailto, reportText } from '../src/shared/aiReport.ts'
import type { AiRequestDetail, ReviewItem } from '../src/shared/types.ts'

// The local log of AI requests (src/main/ai/requestLog.ts): every route, in
// API-key, hosted and Claude Code mode, with tool definitions by name and
// documents as { type, name, bytes }; the newest 500 within 30 days; the off
// switch; Clear and Delete all data. And a report of an AI answer carries the
// fields it names and nothing else.

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'finance-requests-'))
const dbFile = join(dir, 'finance.db')
after(() => rmSync(dir, { recursive: true, force: true }))

// Claude Code mode's modules import Electron: the demo dump's stand-in takes its place here.
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})

/** A fetch that answers every call with `answer` and keeps each request body. */
function fakeFetch(answer: (n: number, body: Record<string, unknown>) => Response): typeof fetch & { bodies: Array<Record<string, unknown>>; raw: string[] } {
  const bodies: Array<Record<string, unknown>> = []
  const raw: string[] = []
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    raw.push(String(init?.body ?? ''))
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return answer(bodies.length, bodies[bodies.length - 1])
  }) as typeof fetch & { bodies: typeof bodies; raw: typeof raw }
  f.bodies = bodies
  f.raw = raw
  return f
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
const answer = (model: string, text: string, stop = 'end_turn'): Response =>
  json(200, { id: 'msg_test', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 9, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 } })
const rejected = (): Response => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_test' })

const client = (f: typeof fetch): Anthropic => new Anthropic({ apiKey: 'sk-ant-test-not-a-key', baseURL: 'https://api.test.invalid', fetch: f, maxRetries: 0 })
const backend = (provider: 'api' | 'proxy', f: typeof fetch): AiBackend => sdkBackend(provider, () => client(f), async () => ({ ready: true, provider }))

const latest = (): AiRequestDetail => {
  const [row] = listRequests()
  assert.ok(row, 'a request is in the log')
  return getRequest(row.id)!
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n'.repeat(40))
const PNG = Buffer.alloc(3001, 7)

describe('the AI request log', () => {
  before(() => openDb(dbFile))
  after(() => closeDb())

  test('a categorize call is kept exactly as it was sent, with what it cost', async () => {
    const f = fakeFetch(() => answer('claude-haiku-5-5', '{"results":[]}'))
    const schema = { type: 'object', properties: { results: { type: 'array' } }, required: ['results'], additionalProperties: false }
    const r = await backend('api', f).structured({ route: 'categorize', system: 'You categorize.', prompt: 'Categorize these transactions:\n{"id":1,"description":"BLUE BOTTLE","amount":"-4.50","account_type":"credit_card"}', schema })
    assert.deepEqual(r, { results: [] })
    const d = latest()
    assert.equal(d.route, 'categorize')
    assert.equal(d.provider, 'api')
    assert.equal(d.model, 'claude-haiku-5-5')
    assert.equal(d.status, 'ok')
    assert.equal(d.error, null)
    // No tools and no documents: the log holds the very body the service got, and its size.
    assert.deepEqual(d.request, f.bodies[0])
    assert.equal(d.bytes, Buffer.byteLength(f.raw[0]))
    assert.deepEqual(d.usage, { model: 'claude-haiku-5-5', inputTokens: 120, outputTokens: 9, cacheReadTokens: 40, cacheWriteTokens: 0, webSearches: 0, stopReason: 'end_turn' })
    // The API key travels in a header and never reaches the log.
    assert.ok(!JSON.stringify(d).includes('sk-ant-test'))
  })

  test('a review step keeps its tools by name and its documents as type, name and size', async () => {
    const f = fakeFetch(() => answer('claude-sonnet-5-5', 'The statement shows $1,240.'))
    const pdf = PDF.toString('base64')
    const png = PNG.toString('base64')
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'Start my review.' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read_document', input: { name: 'Statements/chase-2026-09.pdf' } },
          { type: 'tool_use', id: 'tu_2', name: 'read_document', input: { name: 'Chat/credit score 3f2a.png' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf }, title: 'Statements/chase-2026-09.pdf' }] },
          { type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }
        ]
      }
    ]
    const tools: Anthropic.Beta.BetaTool[] = [
      { name: 'get_open_issues', description: 'Open items', input_schema: { type: 'object', properties: {} } },
      { name: 'read_document', description: 'Read a document', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
    ]
    await backend('api', f).step({ route: 'review', system: 'You review.', tools, serverTools: [webSearchTool({ maxUses: 5 })], messages })
    // The service got the files themselves.
    assert.ok(f.raw[0].includes(pdf) && f.raw[0].includes(png))
    const d = latest()
    assert.equal(d.route, 'review')
    assert.equal(d.model, 'claude-sonnet-5-5')
    assert.equal(d.bytes, Buffer.byteLength(f.raw[0]))
    const req = d.request as { tools: unknown[]; messages: Array<{ content: unknown }>; system: unknown }
    assert.deepEqual(req.tools, ['get_open_issues', 'read_document', { type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'US' } }])
    assert.deepEqual(req.system, f.bodies[0].system)
    const results = req.messages[2].content as Array<{ content: unknown[] }>
    assert.deepEqual(results[0].content, [{ type: 'document', name: 'Statements/chase-2026-09.pdf', bytes: PDF.length }])
    assert.deepEqual(results[1].content, [{ type: 'image', name: 'Chat/credit score 3f2a.png', bytes: PNG.length }])
    // Everything else is as sent.
    assert.deepEqual(req.messages[0], (f.bodies[0].messages as unknown[])[0])
    assert.deepEqual(req.messages[1], (f.bodies[0].messages as unknown[])[1])
    const stored = JSON.stringify(d.request)
    assert.ok(!stored.includes(pdf.slice(0, 200)) && !stored.includes(png.slice(0, 200)) && !stored.includes('input_schema'))
  })

  test('a failed call is kept as an error with the message the user saw', async () => {
    const f = fakeFetch(() => rejected())
    await assert.rejects(backend('api', f).structured({ route: 'headline', system: 'You write the headline.', prompt: 'Data digest:\n{}', schema: { type: 'object' } }), /API key was rejected/)
    const d = latest()
    assert.equal(d.route, 'headline')
    assert.equal(d.status, 'error')
    assert.equal(d.usage, null)
    assert.match(d.error ?? '', /API key was rejected/)
    assert.deepEqual(d.request, f.bodies[0])
  })

  test('the hosted service\'s calls are kept under its name, and a value lookup keeps its search turn', async () => {
    const f = fakeFetch((n) => (n === 1 ? answer('claude-sonnet-5-5', 'Zillow: $412,000 (https://www.zillow.com/x)') : answer('claude-sonnet-5-5', '{"value":412000,"low":400000,"high":425000,"basis":"Zillow.","sources":["https://www.zillow.com/x"]}')))
    const count = listRequests().length
    const r = await backend('proxy', f).structured({ route: 'valuation', system: 'You estimate.', prompt: 'Asset: 14 Alder Lane\nKind: House', schema: { type: 'object' }, webSearch: true, searchDomains: ['zillow.com', 'redfin.com'] })
    assert.equal((r as { value: number }).value, 412000)
    const rows = listRequests()
    assert.equal(rows.length, count + 2)
    const [answerRow, searchRow] = rows.map((x) => getRequest(x.id)!)
    for (const x of [answerRow, searchRow]) {
      assert.equal(x.route, 'valuation')
      assert.equal(x.provider, 'proxy')
      assert.equal(x.status, 'ok')
    }
    assert.deepEqual((searchRow.request as { tools: unknown[] }).tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5, allowed_domains: ['zillow.com', 'redfin.com'], user_location: { type: 'approximate', country: 'US' } }])
    assert.deepEqual(answerRow.request, f.bodies[1])
  })

  test('the API key\'s check is kept too, as the one word it sends', async () => {
    const f = fakeFetch(() => rejected())
    const c = await runKeyCheck(client(f))
    assert.equal(c.result, 'invalid')
    const d = latest()
    assert.equal(d.route, 'keyCheck')
    assert.equal(d.model, 'claude-haiku-5-5')
    assert.equal(d.status, 'error')
    assert.deepEqual(d.request, { model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
    assert.deepEqual(d.request, f.bodies[0])
  })

  test('a document block is kept as its type, name and size wherever it sits', () => {
    const out = redactRequest({
      system: 'S',
      tools: [{ name: 'x', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'héllo' }, title: 'notes.txt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]
    })
    assert.deepEqual(out, {
      system: 'S',
      tools: ['x'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'document', name: 'notes.txt', bytes: 6 }, { type: 'image', name: null, bytes: 3 }] }]
    })
  })

  test('keeps the newest 500, none older than 30 days', () => {
    clearRequests()
    const t = now()
    const old = addAiRequest({ route: 'categorize', provider: 'api', model: 'm', bytes: 1, request: new Uint8Array(), at: t - (LOG_DAYS + 1) * 86_400 })
    const kept = addAiRequest({ route: 'categorize', provider: 'api', model: 'm', bytes: 1, request: new Uint8Array(), at: t - (LOG_DAYS - 1) * 86_400 })
    for (let i = 0; i < LOG_KEEP - 2; i++) addAiRequest({ route: 'headline', provider: 'api', model: 'm', bytes: 1, request: new Uint8Array(), at: t })
    let rows = listRequests()
    assert.equal(rows.length, LOG_KEEP - 1, 'the month-old request is gone')
    assert.ok(!rows.some((r) => r.id === old))
    assert.ok(rows.some((r) => r.id === kept))
    // Two more go out: the oldest one left makes room, and the log stays at 500.
    startRequest({ route: 'review', provider: 'api', model: 'm' }, { messages: [] })
    startRequest({ route: 'review', provider: 'api', model: 'm' }, { messages: [] })
    rows = listRequests()
    assert.equal(rows.length, LOG_KEEP)
    assert.ok(!rows.some((r) => r.id === kept))
    assert.equal(rows[0].route, 'review')
    assert.equal(rows[0].status, 'sent')
    assert.ok(rows.every((r) => r.at >= t - LOG_DAYS * 86_400))
  })

  test('turned off, nothing is kept; Clear empties it', async () => {
    clearRequests()
    setRequestLogOn(false)
    assert.equal(getSetting('ai.requestLog'), '0')
    const f = fakeFetch(() => answer('claude-haiku-5-5', '{"results":[]}'))
    await backend('api', f).structured({ route: 'categorize', system: 'S', prompt: 'P', schema: { type: 'object' } })
    assert.equal(f.bodies.length, 1, 'the call itself goes out')
    assert.equal(listRequests().length, 0)
    assert.equal(startRequest({ route: 'review', provider: 'api', model: 'm' }, {}), null)
    setRequestLogOn(true)
    assert.equal(getSetting('ai.requestLog'), null)
    await backend('api', f).structured({ route: 'categorize', system: 'S', prompt: 'P', schema: { type: 'object' } })
    assert.equal(listRequests().length, 1)
    clearRequests()
    assert.equal(listRequests().length, 0)
  })

  test('an export of all data leaves the log out', async () => {
    const f = fakeFetch(() => answer('claude-haiku-5-5', '{"results":[]}'))
    await backend('api', f).structured({ route: 'categorize', system: 'S', prompt: 'P', schema: { type: 'object' } })
    assert.ok(listRequests().length > 0)
    const out = exportAll()
    assert.ok(!('ai_requests' in out.tables))
    assert.ok('ai_usage' in out.tables)
  })

  test('Delete all data empties the log and removes the database', async () => {
    const f = fakeFetch(() => answer('claude-haiku-5-5', '{"results":[]}'))
    await backend('api', f).structured({ route: 'categorize', system: 'S', prompt: 'P', schema: { type: 'object' } })
    setSetting('ai.model', 'claude-sonnet-5-5')
    // The log is emptied first, so it's gone even where the file stays (a file held open elsewhere).
    removeData(dbFile, [])
    openDb(dbFile)
    assert.equal(listRequests().length, 0)
    assert.equal(getSetting('ai.model'), 'claude-sonnet-5-5')
    await backend('api', f).structured({ route: 'categorize', system: 'S', prompt: 'P', schema: { type: 'object' } })
    assert.equal(listRequests().length, 1)
    removeData(dbFile, [dbFile])
    assert.ok(!existsSync(dbFile) && !existsSync(`${dbFile}-wal`) && !existsSync(`${dbFile}-shm`))
    openDb(dbFile)
    assert.equal(listRequests().length, 0)
    assert.equal(getSetting('ai.model'), null)
  })
})

describe('a report of an AI answer', () => {
  const answerText = 'Your Netflix price went up from $15.49 to $17.99.'

  test('carries the version, the feature, the model, the reason, the note and the answer, and nothing else', () => {
    const input = cleanReport({ route: 'review', reason: 'Wrong', note: '  It went down  ', message: `  ${answerText}  `, transactions: [{ id: 't1', description: 'SECRET' }], request: { system: 'SECRET' }, accountNumber: '1234567890' })
    assert.deepEqual(input, { route: 'review', reason: 'Wrong', message: answerText, note: 'It went down' })
    const text = reportText({ ...input, version: '0.1.0-beta.2', model: 'claude-sonnet-5-5' })
    assert.deepEqual(text.split('\n'), ['Finance Tracker 0.1.0-beta.2', 'Feature: Review', 'Model: claude-sonnet-5-5', 'Reason: Wrong', 'Note: It went down', '', 'Answer:', answerText])
    assert.ok(!text.includes('SECRET') && !text.includes('1234567890'))
    // No note, no note line.
    const bare = reportText({ ...cleanReport({ route: 'headline', reason: 'Unsafe', message: 'Spending is up 40%.' }), version: '1.0.0', model: 'claude-haiku-5-5' })
    assert.deepEqual(bare.split('\n'), ['Finance Tracker 1.0.0', 'Feature: Headline', 'Model: claude-haiku-5-5', 'Reason: Unsafe', '', 'Answer:', 'Spending is up 40%.'])
  })

  test('refuses an unknown feature or reason and an empty answer', () => {
    assert.throws(() => cleanReport({ route: 'categorize', reason: 'Wrong', message: 'x' }), /Unknown feature/)
    assert.throws(() => cleanReport({ route: 'review', reason: 'Spam', message: 'x' }), /reason/)
    assert.throws(() => cleanReport({ route: 'review', reason: 'Other', message: '   ' }), /empty/)
    assert.throws(() => cleanReport(null), /Unknown feature/)
  })

  test('the email goes to the support address with the same report, the answer cut to fit a link', () => {
    const long = 'x'.repeat(MAILTO_MESSAGE_MAX + 500)
    const r = { ...cleanReport({ route: 'review', reason: 'Other', message: long, note: 'n' }), version: '1.0.0', model: 'm' }
    const url = reportMailto('support@example.com', r)
    assert.ok(url.startsWith('mailto:support@example.com?subject='))
    const body = decodeURIComponent(url.slice(url.indexOf('&body=') + 6))
    assert.deepEqual(body.split('\n').slice(0, 7), ['Finance Tracker 1.0.0', 'Feature: Review', 'Model: m', 'Reason: Other', 'Note: n', '', 'Answer:'])
    assert.equal(body.split('\n')[7].length, MAILTO_MESSAGE_MAX)
    assert.throws(() => reportMailto('', r), /No support address/)
    assert.throws(() => reportMailto('not an address', r), /No support address/)
  })
})
