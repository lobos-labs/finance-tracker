import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getTransaction, listCategories, openDb, setSetting, setTransactionFields, upsertAccount, upsertRule, upsertTransaction } from '../src/main/db.ts'
import { AiError, aiEnabled, configureAi, useBackend, type AiBackend } from '../src/main/ai/backend.ts'
import { classify } from '../src/main/classifier.ts'
import type { AiProvider, ClassifyResult } from '../src/shared/types.ts'

// No API key (the AI set to Later, or a key never added): after an import or a sync (`auto`), what rules and
// history didn't cover waits uncategorized for Review, with no error and no request, in every build, as with the AI
// off. The Categorize button (no `auto`) still says why. The hosted service's refusals (a trial ended, a token to
// refresh) keep their error after a sync too. The pages toast only what was categorized and what failed
// (lib.ts classifiedToasts), so a run that did nothing says nothing.

const dir = mkdtempSync(join(tmpdir(), 'finance-classify-no-key-'))
const NO_KEY = 'Add your Anthropic API key in Settings.'

/** A backend that isn't ready (no key, or the service refusing) and refuses every request, counting them. */
function refusing(provider: AiProvider, problem: string, message: string): AiBackend & { asked: number } {
  const b = {
    asked: 0,
    provider,
    capabilities: { webSearch: false, documents: false },
    async structured(): Promise<unknown> {
      b.asked++
      throw new AiError('auth', message)
    },
    async step(): Promise<never> {
      b.asked++
      throw new AiError('auth', message)
    },
    status: async () => ({ ready: false, provider, problem })
  }
  return b
}

const category = (name: string): number => listCategories().find((c) => c.name === name)!.id
let posted = 1_760_000_000
let n = 0
/** Four new transactions: one a rule takes, one an earlier answer takes, two only the AI could. */
function fourNew(): void {
  const k = ++n
  const add = (id: string, description: string): void => upsertTransaction({ id: `${id}-${k}`, accountId: 'manual:a', posted: (posted -= 3600), amountCents: -1234, description, pending: false })
  add('rule', 'COSTCO WHSE #123')
  add('history', 'NETFLIX.COM')
  add('new-a', `SQ *BLUE BOTTLE COFFEE #${k} OAKLAND CA`)
  add('new-b', `TST* CORNER TACOS ${k}`)
}

before(() => {
  openDb(join(dir, 'finance.db'))
  // The AI is a Plus feature (Free has none), whatever kind of build runs the tests; on, as after AI set to Later.
  setSetting('plan.plusUntil', '2099-12-31T00:00:00.000Z')
  upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: 100_000, availableCents: null, balanceDate: posted })
  upsertRule('contains', 'costco', category('Groceries'))
  upsertTransaction({ id: 'seen', accountId: 'manual:a', posted: posted - 90 * 86_400, amountCents: -1234, description: 'NETFLIX.COM', pending: false })
  setTransactionFields('seen', { categoryId: category('Subscriptions'), source: 'ai', confidence: 'high', merchant: 'Netflix' })
  configureAi({ backends: {} })
})
after(() => {
  useBackend(null)
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('categorizing with no API key', () => {
  let key: ReturnType<typeof refusing>
  beforeEach(() => {
    key = refusing('api', 'No API key', NO_KEY)
    useBackend(key)
  })

  test('after an import or a sync: rules and history, then the rest wait for Review, with no error and nothing asked', async () => {
    assert.equal(aiEnabled(), true)
    fourNew()
    const r = await classify({ auto: true }, () => {})
    assert.deepEqual([r.total, r.fromRules, r.fromHistory, r.fromAi, r.failed, r.error], [4, 1, 1, 0, 0, undefined])
    assert.equal(key.asked, 0)
    assert.equal(getTransaction(`rule-${n}`)!.categoryId, category('Groceries'))
    assert.equal(getTransaction(`history-${n}`)!.categoryId, category('Subscriptions'))
    assert.equal(getTransaction(`new-a-${n}`)!.categoryId, null)
  })

  test('the Categorize button still asks and says why', async () => {
    const r = await classify({}, () => {})
    // The two from the last test are still waiting.
    assert.equal(r.total, 2)
    assert.equal(r.error, NO_KEY)
    assert.equal(r.failed, 2)
    assert.ok(key.asked > 0)
  })

  test('the hosted service\'s refusal keeps its error after a sync', async () => {
    const hosted = refusing('proxy', 'Trial ended', 'The trial has ended.')
    useBackend(hosted)
    const r = await classify({ auto: true }, () => {})
    assert.equal(r.error, 'The trial has ended.')
    assert.ok(hosted.asked > 0)
  })
})

describe('the toasts after an import or a sync', async () => {
  // The renderer's lib reads window.api once, as it loads; a window only for that.
  const g = globalThis as Record<string, unknown>
  const hadWindow = 'window' in g
  if (!hadWindow) g['window'] = {}
  const { classifiedToasts, describeClassify } = await import('../src/renderer/src/lib.ts')
  if (!hadWindow) delete g['window']
  const result = (o: Partial<ClassifyResult>): ClassifyResult => ({ total: 49, fromRules: 0, fromHistory: 0, fromAi: 0, failed: 0, ...o })

  test('nothing when nothing was categorized and nothing failed: no "Categorized 0 of 49"', () => {
    assert.deepEqual(classifiedToasts(result({})), [])
    assert.deepEqual(classifiedToasts(result({ total: 0 })), [])
    assert.deepEqual(classifiedToasts(undefined), [])
  })

  test('what was categorized, and a failure as an error', () => {
    assert.deepEqual(classifiedToasts(result({ fromRules: 3 })), [['Categorized 3 of 49 transactions (3 by your rules).', 'info']])
    assert.deepEqual(classifiedToasts(result({ failed: 49, error: 'Anthropic can\'t be reached. Check the internet connection.' })), [['Anthropic can\'t be reached. Check the internet connection.', 'error']])
    assert.equal(describeClassify(result({ fromAi: 40, fromHistory: 9 })), 'Categorized 49 of 49 transactions (40 by AI, 9 from earlier matches).')
  })
})
