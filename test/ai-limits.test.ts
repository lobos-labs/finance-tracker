import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closeDb, openDb, setSetting, upsertAccount, upsertTransaction } from '../src/main/db.ts'
import { AI_OFF, useBackend, type AiBackend, type StepRequest, type StructuredRequest } from '../src/main/ai/backend.ts'
import { getInsight } from '../src/main/insights.ts'
import { mcpTools } from '../src/main/mcp.ts'
import { DOC_TOOLS, TOOLS } from '../src/main/tools.ts'
import { AI_NOT_ADVICE } from '../src/shared/app.ts'
import { FEATURES } from '../src/shared/plans.ts'

// What Anthropic asks of a consumer product on its API. Its Usage Policy
// (effective 2026-11-12) treats a personalized buy/sell/hold or allocation
// recommendation, advice on someone's own taxes and preparing a tax return,
// like legal advice, as needing a qualified person to check each answer before
// it's delivered, which a live chat can't have: Review's and the headline's
// instructions rule them out, and no tool description asks for one. Review
// says it's an AI and that its facts need checking (Commercial Terms D.3), and
// the product's own screens say "AI", not "Claude" (the trademark is
// Anthropic's; the desktop's own-account choices, and the connector to the
// user's own Claude Desktop, may name it).

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'finance-ai-limits-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// Review imports Electron: the demo dump's stand-in takes its place.
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})
process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
mkdirSync(join(dir, 'docs'), { recursive: true })
const electron = (await import('../scripts/demo-electron.ts')) as { setBase: (d: string, v: string) => void }
electron.setBase(join(dir, 'electron'), '0.0.0-test')
const { reviewSend } = await import('../src/main/review.ts')

/** A backend that answers at once and keeps every system prompt it was given. */
function recorder(): AiBackend & { systems: string[] } {
  const systems: string[] = []
  return {
    provider: 'api',
    capabilities: { webSearch: false, documents: false },
    systems,
    async structured(req: StructuredRequest) {
      systems.push(req.system)
      return { headline: 'Groceries are $12 this month', detail: 'One trip so far.', tone: 'neutral', category: '', angle: 'other' }
    },
    async step(req: StepRequest) {
      systems.push(req.system)
      return { content: [{ type: 'text', text: 'Nothing to review.', citations: null }], stop_reason: 'end_turn', usage: null }
    },
    async status() {
      return { ready: true, provider: 'api' }
    }
  }
}

const flat = (s: string): string => s.replace(/\s+/g, ' ')

/** Every description a tool hands the model: its own and its parameters', at any depth. */
function descriptions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) descriptions(n, out)
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') out.push(v)
      else descriptions(v, out)
    }
  }
  return out
}

/** Wording that would ask the model for a recommendation, or for advice on the user's own taxes, investments or rights. */
const ASKS_FOR_ADVICE = [/\brecommend/i, /\badvi[cs]e\b/i, /\badviser\b/i, /\bshould (deduct|claim|report|file|invest|buy|sell|hold|allocate|rebalance|contribute|withdraw)\b/i, /\b(best|right) (fund|stock|investment|allocation)/i, /\bentitled\b/i]

/** The renderer's source files, with comments taken out. */
function rendererSources(): Array<{ file: string; text: string }> {
  const root = join(here, '..', 'src', 'renderer', 'src')
  const out: Array<{ file: string; text: string }> = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name)) {
        const text = readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|\s)\/\/.*$/gm, '$1')
        out.push({ file: p.slice(root.length + 1), text })
      }
    }
  }
  walk(root)
  return out
}

describe('what the AI never does', () => {
  const backend = recorder()

  before(() => {
    openDb(join(dir, 'finance.db'))
    // The AI is a Plus feature (Free has none), whatever kind of build runs the tests.
    setSetting('plan.plusUntil', '2099-12-31T00:00:00.000Z')
    setSetting('ai.provider', 'api')
    upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: 100_000, availableCents: null, balanceDate: 1_760_000_000 })
    upsertTransaction({ id: 't1', accountId: 'manual:a', posted: 1_760_000_000, amountCents: -1200, description: 'FRESH GROCER', pending: false })
    useBackend(backend)
  })
  after(() => {
    useBackend(null)
    closeDb()
  })

  test("Review's instructions rule out investment picks, tax advice, tax returns and legal or coverage calls", async () => {
    backend.systems.length = 0
    await reviewSend(null, () => {})
    assert.ok(backend.systems.length > 0, 'Review asked the model')
    const system = flat(backend.systems[0])
    for (const rule of [
      'no qualified person checks your replies before the user reads them',
      'no recommendation to buy, sell, hold or allocate among specific investments',
      'no 401(k) percentage to pick',
      'no pick between investing and paying down debt',
      'no advice on the user\'s own taxes (what to report, deduct or claim',
      'never preparing or filling in a tax return',
      'never what the user is entitled to or obliged to do, or whether a claim is covered',
      'Say what the policy or plan document states',
      'Whether a particular cost qualifies is for the user and their HSA administrator to decide',
      'name who can help (a financial adviser, a CPA or enrolled agent, an attorney, the insurer)',
      'Still yours to give: facts from the user\'s records',
      'how something works in general without applying it to their situation'
    ]) {
      assert.ok(system.includes(rule), rule)
    }
  })

  test("the headline's instructions rule out investment and tax recommendations", async () => {
    backend.systems.length = 0
    const insight = await getInsight(true)
    assert.equal(insight?.source, 'ai')
    const system = flat(backend.systems[0])
    assert.ok(system.includes('Never a recommendation to buy, sell, hold or move investments'))
    assert.ok(system.includes('nothing about what to report, deduct or claim on taxes'))
    assert.ok(system.includes('the investments angle states the value and its move, nothing more'))
  })

  test('no tool description, in Review or for a connected app, asks for a recommendation or advice', () => {
    const tools = [...TOOLS, ...DOC_TOOLS, ...mcpTools(true)]
    assert.ok(tools.length > 60)
    for (const t of tools) {
      for (const d of descriptions(t)) {
        for (const re of ASKS_FOR_ADVICE) assert.doesNotMatch(d, re, `${t.name}: ${d}`)
      }
    }
  })

  test('HSA eligibility and coverage come from the user and the documents, not the model', () => {
    const description = (name: string): string => TOOLS.find((t) => t.name === name)!.description!
    assert.match(description('set_hsa'), /^Mark health costs for the HSA as the user decides:/)
    assert.doesNotMatch(description('set_hsa'), /supplements|gym|cosmetic/)
    assert.match(description('set_benefit_plan'), /as the plan's documents state them/)
    assert.match(description('set_insurance_policy'), /as the policy documents state them/)
    assert.match(description('list_insurance'), /what its documents say it covers/)
  })
})

describe('what Review says about itself', () => {
  const review = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'pages', 'Review.tsx'), 'utf8')

  test('an AI tag sits beside the title whatever the page is showing', () => {
    const headers = review.match(/<PageHeader title="Review"[^>]*>/g) ?? []
    assert.ok(headers.length >= 2)
    for (const h of headers) assert.match(h, /tag=\{AI_TAG\}/)
    assert.match(review, /const AI_TAG = \(\s*<span className="tag ai"[^>]*>\s*AI\s*<\/span>/)
  })

  test('the line under the chat says to check its facts before relying on them', () => {
    assert.match(AI_NOT_ADVICE, /^AI analysis of your own data, not financial advice\. Check its facts independently before relying on them\.$/)
    assert.ok(review.includes('{AI_NOT_ADVICE}'))
  })
})

describe('the product says AI, not Claude', () => {
  test('the AI-off message points at Settings → AI', () => {
    assert.equal(AI_OFF, 'AI is off. Turn it on in Settings → AI.')
  })

  test('no screen names Claude but the desktop\'s own-account choices (Claude Code, a Claude subscription, Claude Desktop)', () => {
    for (const { file, text } of rendererSources()) {
      const hits = text.match(/.{0,40}\bClaude(?!Code| Code| subscription| Desktop\b).{0,40}/g) ?? []
      assert.deepEqual(hits, [], file)
    }
  })

  test('no plan feature is named for Claude', () => {
    for (const f of FEATURES) assert.doesNotMatch(f.label, /Claude/, f.id)
  })
})
