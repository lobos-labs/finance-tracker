import { deflateRawSync, inflateRawSync } from 'node:zlib'
import * as db from '../db'
import type { AiProvider, AiRequestDetail, AiRequestRoute, AiRequestSummary, AiRequestUsage } from '../../shared/types'

// The local log of every request the app sends to an AI service (Settings →
// Claude, under What's sent): the body as it went out, by route, provider and
// model, with what came back. Tool definitions are fixed code, so they're
// kept by name; a document or image block is kept as { type, name, bytes }
// rather than its contents. The log stays in the database on this machine:
// export, diagnostics and the phone leave it out. The newest LOG_KEEP
// requests are kept, none older than LOG_DAYS; ai.requestLog = '0' stops it,
// and Clear or Delete all data empties it. Logging never gets in the way of
// a request: a failure here is noted in the app log (the message alone) and
// the request goes on.

export const LOG_KEEP = 500
export const LOG_DAYS = 30
const SETTING = 'ai.requestLog'

export const requestLogOn = (): boolean => db.getSetting(SETTING) !== '0'
export const setRequestLogOn = (on: boolean): void => db.setSetting(SETTING, on ? null : '0')

export interface RequestMeta {
  route: AiRequestRoute
  provider: AiProvider
  /** the model asked for */
  model: string
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Bytes a content block's source carries: base64 decoded, text as UTF-8. */
function sourceBytes(source: unknown): number {
  if (!isObject(source)) return 0
  const data = source['data']
  if (typeof data !== 'string') return 0
  if (source['type'] === 'base64') return Math.max(0, Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0))
  return Buffer.byteLength(data, 'utf8')
}

const FILE_BLOCKS = new Set(['document', 'image'])

/**
 * A request body as the log keeps it: everything as sent, except each tool
 * definition (one with an input_schema) by its name, and each document or
 * image block as { type, name, bytes }. A block's name is its title, or the
 * name the assistant asked read_document for.
 */
export function redactRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body }
  if (Array.isArray(body['tools'])) out['tools'] = body['tools'].map((t) => (isObject(t) && 'input_schema' in t ? t['name'] : t))
  const messages = body['messages']
  if (!Array.isArray(messages)) return out
  // Which file each tool call opened, for the blocks its result carries.
  const opened = new Map<string, string>()
  for (const m of messages) {
    if (!isObject(m) || !Array.isArray(m['content'])) continue
    for (const b of m['content']) if (isObject(b) && b['type'] === 'tool_use' && isObject(b['input']) && typeof b['input']['name'] === 'string') opened.set(String(b['id']), b['input']['name'])
  }
  const block = (b: unknown, name: string | null): unknown => {
    if (!isObject(b)) return b
    if (FILE_BLOCKS.has(String(b['type']))) return { type: b['type'], name: typeof b['title'] === 'string' ? b['title'] : name, bytes: sourceBytes(b['source']) }
    if (b['type'] === 'tool_result' && Array.isArray(b['content'])) {
      const n = opened.get(String(b['tool_use_id'])) ?? null
      return { ...b, content: b['content'].map((c) => block(c, n)) }
    }
    return b
  }
  out['messages'] = messages.map((m) => (isObject(m) && Array.isArray(m['content']) ? { ...m, content: m['content'].map((b) => block(b, null)) } : m))
  return out
}

/** Records a request as it goes out; the id is for endRequest, null when the log is off or couldn't record it. */
export function startRequest(meta: RequestMeta, body: Record<string, unknown>): number | null {
  try {
    if (!requestLogOn()) return null
    const sent = Buffer.byteLength(JSON.stringify(body), 'utf8')
    const id = db.addAiRequest({ route: meta.route, provider: meta.provider, model: meta.model, bytes: sent, request: deflateRawSync(Buffer.from(JSON.stringify(redactRequest(body)), 'utf8')) })
    db.pruneAiRequests(LOG_KEEP, db.now() - LOG_DAYS * 86_400)
    return id
  } catch (err) {
    console.error('[ai] request not logged:', message(err))
    return null
  }
}

/** What came back: the usage the service reported, or the error. */
export function endRequest(id: number | null, o: { usage?: AiRequestUsage | null; error?: string | null }): void {
  if (id === null) return
  try {
    db.finishAiRequest(id, { status: o.error ? 'error' : 'ok', usage: o.usage ? JSON.stringify(o.usage) : null, error: o.error ?? null })
  } catch (err) {
    console.error('[ai] request outcome not logged:', message(err))
  }
}

const STATUSES = new Set(['sent', 'ok', 'error'])

function summary(r: db.AiRequestRow): AiRequestSummary {
  return { id: r.id, at: r.at, route: r.route as AiRequestRoute, provider: r.provider as AiProvider, model: r.model, bytes: r.bytes, status: (STATUSES.has(r.status) ? r.status : 'sent') as AiRequestSummary['status'] }
}

/** The log, newest first, without the bodies (older requests than the log keeps are dropped first). */
export function listRequests(): AiRequestSummary[] {
  db.pruneAiRequests(LOG_KEEP, db.now() - LOG_DAYS * 86_400)
  return db.listAiRequests().map(summary)
}

/** One request with its body as the log keeps it. */
export function getRequest(id: number): AiRequestDetail | null {
  const r = db.getAiRequest(Math.floor(Number(id)))
  if (!r) return null
  let request: unknown = null
  try {
    request = JSON.parse(inflateRawSync(Buffer.from(r.request)).toString('utf8'))
  } catch {
    request = null
  }
  let usage: AiRequestUsage | null = null
  try {
    usage = r.usage ? (JSON.parse(r.usage) as AiRequestUsage) : null
  } catch {
    usage = null
  }
  return { ...summary(r), request, usage, error: r.error }
}

export function clearRequests(): void {
  db.clearAiRequests()
}
