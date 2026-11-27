import type Anthropic from '@anthropic-ai/sdk'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as db from '../db'
import { devBuild } from '../devBuild'
import { can, openEdition, serverUrl } from '../license'
import { aiHost } from './host'
import { AI_EFFORTS, MODEL_OPTIONS, ROUTE_DEFAULTS, type AiConsent, type AiEffort, type AiProvider, type AiRoute, type AiStatus, type ModelId, type ReviewItem, type RouteConfig } from '../../shared/types'

// The one interface the app talks to Claude through. Each feature names its
// route; the backend picks the model and effort and reports usage. The
// implementations (anthropic.ts, proxy.ts, claudeCodeDev.ts) are registered
// at startup, so this module stays free of Electron and the pipeline can be
// tested with a fake backend.

const DEFAULT_MODEL: ModelId = 'claude-opus-5-5'

// ---------- errors ----------

/**
 * auth: a key, token or sign-in is missing or rejected. quota: a usage limit
 * or rate limit. offline: the service can't be reached. refused: the model
 * declined this request. server: the service failed this once. unavailable:
 * the backend isn't set up, or can't do what was asked.
 */
export type AiErrorKind = 'auth' | 'quota' | 'offline' | 'refused' | 'server' | 'unavailable'

export class AiError extends Error {
  kind: AiErrorKind
  /** True when retrying won't help until the user does something (sign in, add a key, wait for a limit to reset). */
  fatal: boolean
  constructor(kind: AiErrorKind, message: string, fatal = kind !== 'server' && kind !== 'refused') {
    super(message)
    this.kind = kind
    this.fatal = fatal
  }
}

/** Any failure as an AiError; an unknown error counts as a one-off server failure. */
export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err
  return new AiError('server', err instanceof Error ? err.message : String(err), false)
}

// ---------- requests ----------

export interface AiUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** web searches Anthropic ran for the call */
  webSearches?: number
}

/** One question, one JSON answer matching the schema. */
export interface StructuredRequest {
  route: AiRoute
  system: string
  prompt: string
  schema: Record<string, unknown>
  /** the model may search the web first (only some backends can) */
  webSearch?: boolean
  /** with webSearch: only these sites (a backend that can't keep to a list searches freely) */
  searchDomains?: string[]
}

/** The service-run web search tool: capped per request (max_uses), kept to some sites when given, and placed in the US. */
export function webSearchTool(o: { maxUses: number; allowedDomains?: string[] }): Anthropic.Beta.BetaToolUnion {
  return {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: o.maxUses,
    ...(o.allowedDomains?.length ? { allowed_domains: o.allowedDomains } : {}),
    user_location: { type: 'approximate', country: 'US' }
  }
}

/** One model turn of the app's own agent loop. */
export interface StepRequest {
  route: AiRoute
  system: string
  messages: Anthropic.Beta.BetaMessageParam[]
  tools: Anthropic.Beta.BetaTool[]
  /** tools the service runs itself (web search, say) */
  serverTools?: Anthropic.Beta.BetaToolUnion[]
  /** thinking blocks the caller itself took out of the conversation since its last step that answered: kept with this request in the log */
  thinkingRemoved?: number
}

/** What the model answered, in the Messages API's shape, plus the usage it cost. */
export type StepResponse = Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason'> & {
  usage: AiUsage | null
  /**
   * Thinking blocks of the conversation that the service left out of this step because what came before them had
   * changed, by their paths in the messages as sent ("messages.3.content.0"). The caller takes them out of the
   * conversation it keeps, so each is sent, and left out, once.
   */
  staleThinking?: string[]
}

/** One change a tool made, as the chat shows it; changeId names its journal entry (for Undo). */
export interface ActionLine {
  text: string
  changeId?: number
}

/** Text, tool actions, or a destructive call queued for the user's approval, as a review turn produces them. */
export type AgentEvent = { type: 'text'; text: string } | { type: 'actions'; actions: ActionLine[] } | { type: 'pending' }

/** A whole review turn for a backend that runs its own loop and keeps its own conversation. */
export interface ReviewTurnRequest {
  system: string
  /** the user's message, or what starts a review */
  content: string
  /** the chat before this turn, and how many of its entries the backend's conversation has already seen */
  items: ReviewItem[]
  seen: number
  /** the backend's handle on the conversation from the last turn */
  session: string | undefined
  onEvent: (e: AgentEvent) => void
}

export interface ReviewTurnResult {
  /** the conversation to resume next turn; undefined when nothing was saved */
  session: string | undefined
  error?: AiError
}

export interface AiBackend {
  readonly provider: AiProvider
  readonly capabilities: {
    webSearch: boolean
    /** the model can open files in the documents folder */
    documents: boolean
  }
  /** The parsed JSON answer, or null when the model gave no usable one (cut off, or not JSON). Throws an AiError when the call failed. */
  structured(req: StructuredRequest): Promise<unknown>
  step(req: StepRequest): Promise<StepResponse>
  status(): Promise<AiStatus>
  /** Runs a review turn in its own loop. Absent when the app's loop drives step(). */
  reviewTurn?(req: ReviewTurnRequest): Promise<ReviewTurnResult>
}

// ---------- the off switch ----------

// The AI switch under Settings → AI (and the wizard's "No AI"). Off, no request leaves
// the computer for any route: getBackend() refuses, every request through a
// backend it handed out earlier refuses too (a run under way stops at its
// next call), and the key check refuses (ai/anthropic.ts). A refusal comes
// before the request is built, so the request log records nothing.

const AI_ENABLED = 'ai.enabled'

export const AI_OFF = 'AI is off. Turn it on in Settings → AI.'

// The service's AI sends fields from the books to Anthropic, so a hosted
// ledger runs it only once someone on the account allowed that: the
// disclosure and explicit permission Apple's 5.1.2(i) asks for before personal
// data goes to a third-party AI (docs/legal/app-store-privacy.md A.4). Not now
// is kept too, so the apps ask once; Settings → AI offers it again. The
// desktop, on a key or a subscription of the user's own, doesn't ask.
const AI_CONSENT = 'ai.consent'
/** The words the consent was given to (the apps' consent line); a new version asks again. */
export const AI_CONSENT_VERSION = '2026-11-04'

/** The account's answer to the AI consent line: null until asked. */
export function aiConsent(): AiConsent | null {
  try {
    const v = JSON.parse(db.getSetting(AI_CONSENT) ?? 'null') as Partial<AiConsent> | null
    return v && typeof v.allowed === 'boolean' && typeof v.at === 'string' ? { allowed: v.allowed, at: v.at, version: String(v.version ?? '') } : null
  } catch {
    return null
  }
}

/** Allow (the AI back on) or Not now / Turn off, kept with when and the line's version. */
export function setAiConsent(allowed: boolean): AiConsent {
  const c: AiConsent = { allowed, at: new Date(db.now() * 1000).toISOString(), version: AI_CONSENT_VERSION }
  db.setSetting(AI_CONSENT, JSON.stringify(c))
  if (allowed) setAiEnabled(true)
  return c
}

/** The AI runs when the plan has it (not once the trial ended unpaid), the switch in Settings is on and, hosted, the account allowed it. */
export const aiEnabled = (): boolean => db.getSetting(AI_ENABLED) !== '0' && can('ai') && (!aiHost() || aiConsent()?.allowed === true)
export const setAiEnabled = (on: boolean): void => db.setSetting(AI_ENABLED, on ? null : '0')

/** Throws AiError 'unavailable' while the AI is off. */
export function requireAi(): void {
  if (!aiEnabled()) throw new AiError('unavailable', AI_OFF, true)
}

// ---------- settings ----------

/** The one model Claude Code mode uses for every route. */
export function getModel(): string {
  return db.getSetting('ai.model') ?? DEFAULT_MODEL
}

const isModel = (v: unknown): v is ModelId => MODEL_OPTIONS.some((m) => m.id === v)
const isEffort = (v: unknown): v is AiEffort => (AI_EFFORTS as readonly string[]).includes(String(v))

/**
 * A route's model and effort: chosen per route with a key of the user's own; the service's included AI
 * (hosted mode, the web) runs each route on its set model and effort, which the server holds it to
 * (finance-server/src/config.ts ROUTE_MODELS).
 */
export function routeConfig(route: AiRoute): RouteConfig {
  if (getProvider() === 'proxy') return ROUTE_DEFAULTS[route]
  const model = db.getSetting(`ai.route.${route}.model`)
  const effort = db.getSetting(`ai.route.${route}.effort`)
  return { model: isModel(model) ? model : ROUTE_DEFAULTS[route].model, effort: isEffort(effort) ? effort : ROUTE_DEFAULTS[route].effort }
}

export function setRouteConfig(route: AiRoute, patch: Partial<RouteConfig>): void {
  if (aiHost()) throw new Error('The included AI runs each feature on a set model')
  if (patch.model !== undefined) {
    if (!isModel(patch.model)) throw new Error('Unknown model')
    db.setSetting(`ai.route.${route}.model`, patch.model)
  }
  if (patch.effort !== undefined) {
    if (!isEffort(patch.effort)) throw new Error('Unknown effort')
    db.setSetting(`ai.route.${route}.effort`, patch.effort)
  }
}

/** The model a route runs on under the current provider (for labels and cache keys). */
export function routeModel(route: AiRoute): string {
  return getProvider() === 'claude-code' ? getModel() : routeConfig(route).model
}

/**
 * What the allowance counts a call as: the turn it belongs to (a review
 * message, one value lookup: counted once however many calls it takes) and
 * the units it covers (the transactions in a categorize batch).
 */
export interface UsageScope {
  turn: string
  units?: number
}

const usageScope = new AsyncLocalStorage<UsageScope>()

/** Runs `fn` with every call it makes recorded under one turn. */
export const inUsageScope = <T>(scope: UsageScope, fn: () => T): T => usageScope.run(scope, fn)

export const currentUsageScope = (): UsageScope | undefined => usageScope.getStore()

/** Records what a call cost against its route. */
export function recordUsage(route: AiRoute, usage: AiUsage | null): void {
  if (!usage) return
  try {
    db.addAiUsage(route, usage, usageScope.getStore())
  } catch (err) {
    console.error('[ai] usage not recorded:', err instanceof Error ? err.message : String(err))
  }
}

// ---------- providers ----------

let factories: Partial<Record<AiProvider, () => AiBackend>> = {}
const instances: Partial<Record<AiProvider, AiBackend>> = {}
let override: AiBackend | null = null

/** Wires up the backends at startup (which ones this build offers is devBuild.ts's). */
export function configureAi(o: { backends: Partial<Record<AiProvider, () => AiBackend>> }): void {
  factories = o.backends
  for (const k of Object.keys(instances) as AiProvider[]) delete instances[k]
}

/** Puts one backend in front of the registered ones (tests); null takes it away again. */
export function useBackend(b: AiBackend | null): void {
  override = b
}

/** Claude Code mode is for a development build of another edition; the open edition offers the user's own key and Claude Desktop. */
export const claudeCodeOffered = (): boolean => devBuild() && !openEdition()

/** The hosted service's origin, the license server's (license.ts; the SDK adds /v1/messages). */
export const proxyUrl = (): string | null => serverUrl()

/** A hosted ledger is the service itself (ai/host.ts). */
export const proxyAvailable = (): boolean => !!aiHost() || proxyUrl() !== null

/** The hosted service runs the included AI: a plan with that allowance (a trial or Plus token, or a development build). */
export const proxyIncluded = (): boolean => proxyAvailable() && can('includedAi')

/** The provider as saved, before the build decides whether it can be offered. Nothing saved means Claude Code where it's offered (a development build, as before), else the API key. */
export function storedProvider(): AiProvider {
  const v = db.getSetting('ai.provider')
  if (v === 'claude-code' || v === 'proxy' || v === 'api') return v
  return claudeCodeOffered() ? 'claude-code' : 'api'
}

/**
 * The provider in use: a saved choice this build can't offer (or a plan without the included AI) falls back to the API key.
 * In a hosted ledger, always the service's included AI.
 */
export function getProvider(): AiProvider {
  if (aiHost()) return 'proxy'
  const stored = storedProvider()
  if (stored === 'claude-code' && !claudeCodeOffered()) return 'api'
  if (stored === 'proxy' && !proxyIncluded()) return 'api'
  return stored
}

const guards = new WeakMap<AiBackend, AiBackend>()

/** The backend with the off switch checked again before each request it sends. */
function guarded(b: AiBackend): AiBackend {
  let g = guards.get(b)
  if (!g) {
    const turn = b.reviewTurn
    g = {
      get provider() {
        return b.provider
      },
      get capabilities() {
        return b.capabilities
      },
      async structured(req) {
        requireAi()
        return b.structured(req)
      },
      async step(req) {
        requireAi()
        return b.step(req)
      },
      status: () => b.status(),
      ...(turn
        ? {
            async reviewTurn(req: ReviewTurnRequest) {
              requireAi()
              return turn.call(b, req)
            }
          }
        : {})
    }
    guards.set(b, g)
  }
  return g
}

/** The backend in use (a hosted ledger's own, else the registered one); throws AiError 'unavailable' while the AI is off or when none is set up. */
export function getBackend(): AiBackend {
  requireAi()
  const host = aiHost()
  if (host) return guarded(host.backend)
  if (override) return guarded(override)
  const provider = getProvider()
  const make = factories[provider]
  if (!make) throw new AiError('unavailable', 'The AI backend isn\'t set up.', true)
  return guarded((instances[provider] ??= make()))
}

/** The backend's own status, noting when a saved choice couldn't be offered. */
export async function aiStatus(): Promise<AiStatus> {
  if (!aiEnabled()) return { ready: false, provider: getProvider(), problem: AI_OFF }
  const stored = storedProvider()
  let status: AiStatus
  try {
    status = await getBackend().status()
  } catch (err) {
    status = { ready: false, provider: getProvider(), problem: toAiError(err).message }
  }
  if (aiHost()) return status
  const note =
    stored === 'claude-code' && !claudeCodeOffered()
      ? 'Claude Code mode is for development builds; using the API key.'
      : stored === 'proxy' && !proxyAvailable()
        ? 'No hosted service is set up; using the API key.'
        : stored === 'proxy' && !proxyIncluded()
          ? 'The included AI needs Plus or the trial; using the API key.'
          : null
  return note ? { ...status, problem: [note, status.problem].filter(Boolean).join(' ') } : status
}
