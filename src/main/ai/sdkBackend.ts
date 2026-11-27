import Anthropic from '@anthropic-ai/sdk'
import { allowanceUsed } from '../allowance'
import { devBuild } from '../devBuild'
import { openEdition, planState } from '../license'
import { AiError, currentUsageScope, recordUsage, routeConfig, toAiError, webSearchTool, type AiBackend, type AiUsage, type StructuredRequest } from './backend'
import { endRequest, startRequest, type RequestMeta } from './requestLog'
import type { AiEffort, AiProvider, AiRoute, AiStatus } from '../../shared/types'

// Claude over the Messages API: the request code the user's own key
// (anthropic.ts) and the hosted service (proxy.ts) share, each with its own
// client. Free of Electron, so the tests run it over a fake fetch. Every call
// goes out through send(), which puts it in the request log first.

const MAX_TOKENS = 16000
// Models that support server-side refusal fallback with fallbacks: "default".
export const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])
/**
 * The beta under which a request says what happens to a thinking block that no longer matches its conversation.
 * Anthropic ties each thinking block to the system prompt, the tools and the messages that came before it, and
 * refuses a conversation that sends one back with any of those changed: a 400 on every later message, for every
 * account opened since 2026-08-31. A saved conversation can meet a changed system prompt or tool here (step() says
 * when), so a step asks for such blocks to be left out instead.
 */
export const BINDING_BETA = 'thinking-binding-controls-2026-08-01'
/** The service refused that setting itself (its beta ended, or something on the way dropped the header), not a thinking block. */
const refusesBinding = (err: unknown): boolean => err instanceof Anthropic.BadRequestError && /block_binding|thinking-binding-controls/.test(err.message) && !/Invalid `signature`/.test(err.message)
/** Searches per structured question, and how many times a paused search turn is picked up again. */
const SEARCH_USES = 5
const SEARCH_RESUMES = 3
const NO_KEY = 'Add your Anthropic API key in Settings.'
const NO_KEY_OR_CONNECTOR = 'Add your Anthropic API key, or turn on Claude Desktop, in Settings.'

/**
 * What to do with no API key: add one in Settings, or, where Claude Desktop's connector is offered (a development
 * build or the open edition, as connector.ts connectorOffered has it), turn that on instead. Every other build, as before.
 */
export const noKeyLine = (): string => (devBuild() || openEdition() ? NO_KEY_OR_CONNECTOR : NO_KEY)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The hosted service's 429 (finance-server proxy): { kind: 'quota', resetsAt } once the AI budget is spent,
 * worded as the app's own check words it; { kind: 'rate_limit' } for its per-minute limit.
 */
function serviceRefusal(err: InstanceType<typeof Anthropic.RateLimitError>): AiError | null {
  const body = err.error
  if (!isRecord(body)) return null
  // Every trial's AI together hit the day's ceiling (finance-server TRIAL_AI_DAILY_CEILING_MICROS).
  if (body['kind'] === 'quota' && body['allowance'] === 'trial_pool') return new AiError('quota', 'AI for trials is paused until tomorrow.')
  if (body['kind'] === 'quota') return allowanceUsed(planState().plan, typeof body['resetsAt'] === 'string' ? body['resetsAt'] : null)
  if (body['kind'] === 'rate_limit') return new AiError('quota', 'Too many AI requests this minute. Try again in a minute.')
  return null
}

/** An SDK failure as an AiError, most specific class first. */
export function friendlyError(err: unknown, model: string, provider: AiProvider = 'api'): AiError {
  const credential = provider === 'proxy' ? 'license token' : 'API key'
  if (err instanceof AiError) return err
  if (provider === 'proxy' && err instanceof Anthropic.RateLimitError) {
    const refusal = serviceRefusal(err)
    if (refusal) return refusal
  }
  // Anthropic stopped the service's whole organization (finance-server organizationLimit): nothing the user can do.
  if (provider === 'proxy' && err instanceof Anthropic.APIError && err.status === 503 && isRecord(err.error) && err.error['kind'] === 'ai_unavailable') {
    return new AiError('unavailable', 'AI is unavailable right now.')
  }
  if (err instanceof Anthropic.AuthenticationError) return new AiError('auth', `Your ${credential} was rejected. Check it in Settings.`)
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError('auth', `This ${credential} can't use ${model}. Pick another model in Settings.`)
  if (err instanceof Anthropic.NotFoundError) return new AiError('unavailable', `Model ${model} wasn't found. Pick another model in Settings.`)
  if (err instanceof Anthropic.RateLimitError) return new AiError('quota', 'Anthropic rate limit reached. Try again in a minute.')
  if (err instanceof Anthropic.BadRequestError && /credit|balance|billing|quota/i.test(err.message)) return new AiError('quota', `Anthropic: ${err.message}`)
  if (err instanceof Anthropic.APIConnectionError) return new AiError('offline', 'Anthropic can\'t be reached. Check the internet connection.')
  if (err instanceof Anthropic.APIError) return new AiError('server', `Anthropic API error ${err.status ?? ''}: ${err.message}`)
  if (err instanceof Anthropic.AnthropicError && /api key|authentication/i.test(err.message)) return new AiError('auth', provider === 'api' ? noKeyLine() : NO_KEY)
  return toAiError(err)
}

const fallback = (model: string): { betas: ['server-side-fallback-2026-07-01']; fallbacks: 'default' } | Record<string, never> => (FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {})

const usageOf = (r: Anthropic.Beta.BetaMessage): AiUsage => ({
  model: r.model,
  inputTokens: r.usage.input_tokens,
  outputTokens: r.usage.output_tokens,
  cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0,
  webSearches: r.usage.server_tool_use?.web_search_requests ?? 0
})

/** The system prompt with a cache breakpoint on it (the tool list renders before it, so both are cached together). */
const systemBlocks = (text: string): Anthropic.Beta.BetaTextBlockParam[] => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming

/**
 * Adaptive thinking, with the blocks that no longer match their conversation left out rather than refused. Adaptive
 * is how every model a route can be set to runs with nothing said. A model that a refused request falls back to may
 * not be one of them: Claude Opus 4.8 thinks under this, where with nothing said it would not.
 */
const DROP_STALE_THINKING: NonNullable<CreateParams['thinking']> = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }

/**
 * One call: logged as it goes out, then what came back (its usage, or the error as the user sees it).
 * `again` may answer a failure with the request to send in its place, once; both are logged. `stale` is the
 * thinking blocks the service left out because the conversation before them had changed, by their paths.
 */
async function send(
  c: Anthropic,
  meta: RequestMeta & { route: AiRoute; thinkingRemoved?: number },
  params: CreateParams,
  again?: (err: unknown) => CreateParams | null
): Promise<{ r: Anthropic.Beta.BetaMessage; usage: AiUsage; stale: string[] }> {
  // The body as the SDK posts it: the betas go in a header.
  const { betas: _betas, ...body } = params
  const logged = startRequest(meta, body as unknown as Record<string, unknown>)
  let r: Anthropic.Beta.BetaMessage
  try {
    // The hosted service meters and allowlists by feature, so it needs to know which one is asking,
    // and counts a review message or a value lookup once however many calls its turn makes.
    const turn = currentUsageScope()?.turn
    r = await c.beta.messages.create(params, meta.provider === 'proxy' ? { headers: { 'X-Route': meta.route, ...(turn ? { 'X-Turn': turn } : {}) } } : undefined)
  } catch (err) {
    const e = friendlyError(err, meta.model, meta.provider)
    endRequest(logged, { error: e.message })
    const next = again?.(err)
    if (next) return send(c, meta, next)
    throw e
  }
  const usage = usageOf(r)
  // Thinking blocks the service left out of what the model read (reported under BINDING_BETA only): those tied to
  // a conversation that has changed since, apart from those the answering model may not read at all (another
  // model's, as after a fallback, or another account's), which are no sign of a change.
  const left = (r.input_transformations ?? []).filter((t) => t.type === 'thinking_dropped')
  const stale = left.filter((t) => t.reason === 'prefix_binding_mismatch').map((t) => t.path)
  const unread = left.length - stale.length
  endRequest(logged, {
    usage: {
      ...usage,
      stopReason: r.stop_reason,
      ...(stale.length ? { thinkingDropped: stale.length } : {}),
      ...(unread ? { thinkingUnread: unread } : {}),
      ...(meta.thinkingRemoved ? { thinkingRemoved: meta.thinkingRemoved } : {})
    }
  })
  recordUsage(meta.route, usage)
  return { r, usage, stale }
}

/**
 * A turn with the service's web search tool before a structured answer: what
 * the model found, in its own words with figures and sources, plus the pages
 * it read. The JSON schema goes in a second call (whether the search tool and
 * a schema work in one call is unverified).
 */
async function searchTurn(c: Anthropic, model: string, effort: AiEffort, req: StructuredRequest, provider: AiProvider): Promise<string> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.prompt }]
  const notes: string[] = []
  const urls = new Set<string>()
  for (let i = 0; i <= SEARCH_RESUMES; i++) {
    const { r } = await send(c, { route: req.route, provider, model }, {
      model,
      max_tokens: MAX_TOKENS,
      ...fallback(model),
      output_config: { effort },
      system: systemBlocks(`${req.system}\n\nIn this step, search and write down what you found: the figures and the URL of each page they came from. The answer in the required form comes in a later step.`),
      tools: [webSearchTool({ maxUses: SEARCH_USES, allowedDomains: req.searchDomains })],
      messages
    })
    if (r.stop_reason === 'refusal') throw new AiError('refused', 'The AI declined this request.')
    for (const b of r.content) {
      if (b.type === 'text') notes.push(b.text)
      else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const page of b.content) urls.add(page.url)
    }
    messages.push({ role: 'assistant', content: r.content })
    // The service stops a long search turn (pause_turn); the model carries on from its own content.
    if (r.stop_reason !== 'pause_turn') break
  }
  return `What a web search found:\n${notes.join('\n').trim() || '(nothing)'}\n\nPages read:\n${[...urls].slice(0, 12).join('\n') || '(none)'}`
}

/**
 * A backend over the SDK. The system prompt carries a cache breakpoint, which
 * (tools render before it) caches the tool list and system prompt together;
 * a step also caches the conversation so far. Documents reach the model as
 * content blocks in tool results, and the service's web search tool goes
 * in with the tools, so both capabilities are there.
 */
export function sdkBackend(provider: 'api' | 'proxy', client: () => Anthropic, status: () => Promise<AiStatus>): AiBackend {
  /** Whether a step asks for stale thinking to be left out: until the service refuses the setting itself, then not again while the app runs. */
  let binding = true
  return {
    provider,
    capabilities: { webSearch: true, documents: true },
    async structured(req) {
      const { model, effort } = routeConfig(req.route)
      const c = client()
      const findings = req.webSearch ? await searchTurn(c, model, effort, req, provider) : null
      const { r } = await send(c, { route: req.route, provider, model }, {
        model,
        max_tokens: MAX_TOKENS,
        ...fallback(model),
        output_config: { effort, format: { type: 'json_schema', schema: req.schema } },
        system: systemBlocks(req.system),
        messages: [{ role: 'user', content: findings ? `${req.prompt}\n\n${findings}\n\nAnswer from these findings.` : req.prompt }]
      })
      if (r.stop_reason === 'refusal') throw new AiError('refused', 'The AI declined this request.')
      if (r.stop_reason === 'max_tokens') return null
      const text = r.content.find((b) => b.type === 'text')
      if (!text || text.type !== 'text') return null
      try {
        return JSON.parse(text.text)
      } catch {
        return null
      }
    },
    async step(req) {
      const { model, effort } = routeConfig(req.route)
      const c = client()
      const refusal = fallback(model)
      // A conversation outlives what its thinking blocks are tied to: an update of the app rewords the caller's
      // instructions or a tool under a conversation saved before it. (What changes with the books is no part of
      // the system prompt: the caller tells it in messages it only ever adds, review.ts.) Bound, a step has the
      // blocks from before such a change left out and answers; unbound it is the 400 above, which the caller
      // answers by taking the thinking out of the conversation itself (review.ts).
      // The setting goes with every step, on every account. Left unsaid, what the service does with such a block
      // goes by when the account was opened: refused on a newer one, read all the same on an older one. Said, it
      // is one behaviour for all of them, and the one the tests hold. What the service leaves out it reports, and
      // the caller takes those blocks out of the conversation it keeps, so they are sent and left out once.
      const params = (bound: boolean): CreateParams => ({
        model,
        max_tokens: MAX_TOKENS,
        ...refusal,
        ...(bound ? { betas: [...(refusal.betas ?? []), BINDING_BETA], thinking: DROP_STALE_THINKING } : {}),
        output_config: { effort },
        cache_control: { type: 'ephemeral' },
        system: systemBlocks(req.system),
        tools: [...req.tools, ...(req.serverTools ?? [])],
        messages: req.messages
      })
      const { r, usage, stale } = await send(c, { route: req.route, provider, model, thinkingRemoved: req.thinkingRemoved }, params(binding), (err) => {
        // A service that doesn't take the setting gets the step as it was before the setting existed.
        if (!binding || !refusesBinding(err)) return null
        binding = false
        return params(false)
      })
      return { content: r.content, stop_reason: r.stop_reason, usage, staleThinking: stale }
    },
    status
  }
}
