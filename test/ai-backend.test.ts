import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addFact, closeDb, getSetting, getTransaction, listCategories, openDb, setSetting, setTransactionFields, upsertAccount, upsertRule, upsertTransaction } from '../src/main/db.ts'
import { AiError, aiStatus, configureAi, getBackend, getProvider, routeModel, useBackend, type AiBackend, type StepRequest, type StructuredRequest } from '../src/main/ai/backend.ts'
import { configureBuild } from '../src/main/devBuild.ts'
import { classify, stripDigitRuns } from '../src/main/classifier.ts'
import { getInsight } from '../src/main/insights.ts'

// The categorization pipeline and the headline reach Claude only through the
// AiBackend interface: a fake backend stands in for the API here.

const dir = mkdtempSync(join(tmpdir(), 'finance-ai-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** A backend that answers from a function and remembers every request. */
function fake(answer: (req: StructuredRequest) => unknown): AiBackend & { requests: StructuredRequest[] } {
  const requests: StructuredRequest[] = []
  return {
    provider: 'api',
    capabilities: { webSearch: false, documents: false },
    requests,
    async structured(req) {
      requests.push(req)
      return answer(req)
    },
    async step(_req: StepRequest) {
      throw new AiError('unavailable', 'not in this test')
    },
    async status() {
      return { ready: true, provider: 'api' }
    }
  }
}

const category = (name: string): number => listCategories().find((c) => c.name === name)!.id
let posted = 1_760_000_000
const txn = (id: string, description: string, amountCents = -1234): void => {
  upsertTransaction({ id, accountId: 'manual:a', posted: (posted -= 3600), amountCents, description, pending: false })
}

describe('the AI backend interface', () => {
  before(() => {
    openDb(join(dir, 'finance.db'))
    // The AI is a Plus feature (Free has none), whatever kind of build runs the tests.
    setSetting('plan.plusUntil', '2099-12-31T00:00:00.000Z')
    upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: 100_000, availableCents: null, balanceDate: posted })
  })
  after(() => {
    useBackend(null)
    closeDb()
  })

  test('the provider setting resolves, and the route model follows it', () => {
    // Nothing saved: an unpackaged build (the default here) keeps Claude Code mode, with its one model.
    assert.equal(getProvider(), 'claude-code')
    assert.equal(routeModel('categorize'), 'claude-opus-5-5')
    setSetting('ai.provider', 'api')
    assert.equal(getProvider(), 'api')
    assert.equal(routeModel('categorize'), 'claude-haiku-5-5')
    assert.equal(routeModel('review'), 'claude-sonnet-5-5')
    setSetting('ai.route.categorize.model', 'claude-opus-5-5')
    assert.equal(routeModel('categorize'), 'claude-opus-5-5')
    setSetting('ai.route.categorize.model', null)
    setSetting('ai.provider', 'proxy')
    // No hosted service is set up, so a saved choice of it falls back to the key.
    assert.equal(getProvider(), 'api')
    setSetting('ai.provider', 'api')
  })

  test('a packaged build resolves a saved Claude Code choice to the key and says so', async () => {
    const apiBackend = fake(() => null)
    useBackend(null)
    configureBuild({ packaged: true })
    configureAi({ backends: { api: () => apiBackend } })
    try {
      setSetting('ai.provider', 'claude-code')
      assert.equal(getProvider(), 'api')
      // The backend comes wrapped in the off switch's check; its calls reach the key's backend.
      assert.equal(getBackend().provider, 'api')
      await getBackend().structured({ route: 'categorize', system: '', prompt: '', schema: {} })
      assert.equal(apiBackend.requests.length, 1)
      assert.equal(routeModel('categorize'), 'claude-haiku-5-5')
      const s = await aiStatus()
      assert.equal(s.provider, 'api')
      assert.match(s.problem ?? '', /development builds/)
      // Nothing saved in a packaged build means the key too.
      setSetting('ai.provider', null)
      assert.equal(getProvider(), 'api')
    } finally {
      configureBuild({ packaged: false })
      configureAi({ backends: {} })
      setSetting('ai.provider', 'api')
    }
  })

  test('categorization goes rules, then history, then the backend', async () => {
    upsertRule('contains', 'costco', category('Groceries'))
    txn('t-costco-gas', 'COSTCO GAS #77')
    setTransactionFields('t-costco-gas', { categoryId: category('Gas & Fuel'), source: 'user', merchant: 'Costco' })
    // A refund the other way, under its own name, doesn't make the name unclear.
    txn('t-costco-refund', 'COSTCO RETURN #77', 500)
    setTransactionFields('t-costco-refund', { categoryId: category('Groceries'), source: 'user', merchant: 'Costco Return' })
    txn('t-rule', 'COSTCO WHSE #123')
    // A rule over many payees names none of them.
    upsertRule('contains', 'venmo payment', category('Other'))
    for (const [id, who] of [['t-venmo-a', 'Pat & Lee'], ['t-venmo-b', 'Robin Okafor']]) {
      txn(id, `VENMO PAYMENT ${id}`)
      setTransactionFields(id, { categoryId: category('Other'), source: 'user', merchant: who })
    }
    txn('t-venmo-new', 'VENMO PAYMENT 1000000017 WEB ID: 9000000001')
    txn('t-seen-before', 'NETFLIX.COM')
    setTransactionFields('t-seen-before', { categoryId: category('Subscriptions'), source: 'ai', confidence: 'high', merchant: 'Netflix' })
    txn('t-history', 'NETFLIX.COM')
    txn('t-new', 'SQ *BLUE BOTTLE COFFEE #12 OAKLAND CA')
    txn('t-digits', 'ACH DEBIT 4417123456789 WEB PMT ID 00042')

    const backend = fake((req) => {
      const items = req.prompt.split('\n').slice(1).map((l) => JSON.parse(l) as { id: number; description: string })
      return { results: items.map((i) => ({ id: i.id, merchant: 'Blue Bottle Coffee', category: 'Dining Out', confidence: 'high' })) }
    })
    useBackend(backend)
    const r = await classify({}, () => {})
    assert.deepEqual([r.total, r.fromRules, r.fromHistory, r.fromAi, r.failed], [5, 2, 1, 2, 0])
    assert.equal(r.error, undefined)

    assert.equal(backend.requests.length, 1)
    const [req] = backend.requests
    assert.equal(req.route, 'categorize')
    assert.match(req.prompt, /BLUE BOTTLE/)
    assert.doesNotMatch(req.prompt, /COSTCO|NETFLIX/)
    assert.match(req.system, /Groceries/)
    // The account's kind goes, not its name; runs of digits stay home.
    assert.match(req.prompt, /"account_type":"cash"/)
    assert.doesNotMatch(req.prompt, /Checking|4417123456789|00042/)
    assert.match(req.prompt, /"ACH DEBIT WEB PMT ID"/)
    const schema = req.schema as { properties: { results: { items: { properties: { category: { enum: string[] } } } } } }
    assert.ok(schema.properties.results.items.properties.category.enum.includes('Dining Out'))

    const rule = getTransaction('t-rule')!
    // The rule's category, and the name of the latest payment the same rule matches, never Claude's.
    assert.deepEqual([rule.categoryId, rule.categorySource, rule.merchant], [category('Groceries'), 'rule', 'Costco'])
    assert.deepEqual([getTransaction('t-venmo-new')!.categorySource, getTransaction('t-venmo-new')!.merchant], ['rule', null])
    const seen = getTransaction('t-history')!
    assert.deepEqual([seen.categoryId, seen.merchant], [category('Subscriptions'), 'Netflix'])
    const fresh = getTransaction('t-new')!
    assert.deepEqual([fresh.categoryId, fresh.categorySource, fresh.merchant, fresh.confidence], [category('Dining Out'), 'ai', 'Blue Bottle Coffee', 'high'])
  })

  test('the headline goes through the backend, and falls back locally when it fails', async () => {
    const backend = fake(() => ({ headline: 'Dining Out is $12 above your usual pace', detail: '$12 so far.', tone: 'negative', category: 'Dining Out', angle: 'category' }))
    useBackend(backend)
    const insight = await getInsight(true)
    assert.ok(insight)
    assert.equal(insight.source, 'ai')
    assert.equal(insight.headline, 'Dining Out is $12 above your usual pace')
    assert.equal(insight.categoryId, category('Dining Out'))
    assert.equal(backend.requests.length, 1)
    assert.equal(backend.requests[0].route, 'headline')
    assert.match(backend.requests[0].prompt, /^Data digest:/)

    useBackend(
      fake(() => {
        throw new AiError('auth', 'Add your Anthropic API key in Settings.')
      })
    )
    const local = await getInsight(true)
    assert.ok(local)
    assert.equal(local.source, 'local')
    assert.equal(local.error, 'Add your Anthropic API key in Settings.')
  })

  test('runs of four or more digits leave a description', () => {
    assert.equal(stripDigitRuns('ACH DEBIT 4417123456789 WEB PMT ID 00042'), 'ACH DEBIT WEB PMT ID')
    assert.equal(stripDigitRuns('SQ *BLUE BOTTLE COFFEE #12 OAKLAND CA'), 'SQ *BLUE BOTTLE COFFEE #12 OAKLAND CA')
    assert.equal(stripDigitRuns('CHECK 1042'), 'CHECK')
    assert.equal(stripDigitRuns('UBER   *TRIP 10/01'), 'UBER *TRIP 10/01')
  })

  test('in API mode the headline is written at most once a day, and only when the numbers change', async () => {
    const backend = fake(() => ({ headline: 'Card balances are down $120 in 30 days', detail: '$900 owed now.', tone: 'positive', category: '', angle: 'debt' }))
    useBackend(backend)
    assert.equal(getProvider(), 'api')
    await getInsight(true)
    assert.equal(backend.requests.length, 1)
    // Nothing changed: the cached one.
    await getInsight()
    assert.equal(backend.requests.length, 1)
    // The numbers changed, but one was written today already.
    addFact('Rent is $850 on the 1st', 'user')
    await getInsight()
    assert.equal(backend.requests.length, 1)
    // Yesterday's headline, and the numbers changed since: a new one.
    const cache = (): { key: string; undated?: string; insight: { generatedAt: number } } => JSON.parse(getSetting('insight.cache')!) as { key: string; undated?: string; insight: { generatedAt: number } }
    const old = cache()
    old.insight.generatedAt -= 86_400
    setSetting('insight.cache', JSON.stringify(old))
    await getInsight()
    assert.equal(backend.requests.length, 2)
    // Yesterday's headline and only the date moved since: it stays.
    const dated = cache()
    dated.key = 'some other day'
    dated.insight.generatedAt -= 86_400
    setSetting('insight.cache', JSON.stringify(dated))
    await getInsight()
    assert.equal(backend.requests.length, 2)
    // The button always asks.
    await getInsight(true)
    assert.equal(backend.requests.length, 3)
  })

  // Descriptions are keyed with their digits stripped, so each needs its own word to stay distinct.
  const word = (i: number): string => `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}STORE`

  test('a quota error stops the queue instead of asking batch after batch', async () => {
    // Five batches of 40: more than run at once, so the later ones can be skipped.
    for (let i = 0; i < 170; i++) txn(`t-many-${i}`, `MERCHANT ${word(i)} ${1000 + i}`)
    const backend = fake(() => {
      throw new AiError('quota', 'Anthropic rate limit reached. Try again in a minute.')
    })
    useBackend(backend)
    const r = await classify({}, () => {})
    assert.equal(r.total, 170)
    assert.equal(r.failed, 170)
    assert.equal(r.fromAi, 0)
    assert.match(r.error ?? '', /rate limit/)
    // Three batches start together; the two after them see the fatal error and never ask.
    assert.equal(backend.requests.length, 3)
    assert.equal(getTransaction('t-many-0')!.categoryId, null)
  })

  test('a one-off server error fails only its own batch', async () => {
    let calls = 0
    const backend = fake((req) => {
      if (calls++ === 0) throw new AiError('server', 'Anthropic API error 500: overloaded')
      const items = req.prompt.split('\n').slice(1).map((l) => JSON.parse(l) as { id: number })
      return { results: items.map((i) => ({ id: i.id, merchant: 'Store', category: 'Shopping', confidence: 'medium' })) }
    })
    useBackend(backend)
    const r = await classify({}, () => {})
    assert.equal(r.total, 170)
    assert.equal(r.failed, 40)
    assert.equal(r.fromAi, 130)
    assert.equal(backend.requests.length, 5)
    assert.match(r.error ?? '', /overloaded/)
  })
})
