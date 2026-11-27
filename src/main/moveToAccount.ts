import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import * as db from './db'
import { devBuild } from './devBuild'
import { documentPath } from './files'
import { serverUrl } from './license'
import { exportFileRefs, rewriteFileRefs, type FullExport, type UploadedFile } from './ledgerImport'
import type { MoveAccountResult, MoveAccountStatus } from '../shared/types'

// Settings → Data → Move to an account (development builds only for now): the
// desktop's books into a hosted account on the configured server
// (docs/hosted-api.md, "Moving desktop books"). Signs in by emailed code, checks
// the account's ledger is empty and runs this schema, uploads every file the
// books point at (receipts, tax forms, credit reports, policy documents, the
// documents the AI read) and rewrites each path to the upload, then sends the
// full export to POST /v1/ledger/import-desktop and signs the session out. The
// session lives in this call only; nothing here is saved.

/** What the server takes as an upload (finance-server/src/ledger/files.ts), and its size cap. */
const UPLOAD_TYPES = new Set(['csv', 'qfx', 'ofx', 'qif', 'pdf', 'png', 'jpg', 'jpeg', 'heic'])
const UPLOAD_MAX = 30 * 1024 * 1024
/** An upload refused for its rate is tried again after the server's Retry-After, when it is at most this long. */
const RETRY_MAX_SECONDS = 90

export interface MoveDeps {
  fetch: typeof fetch
  /** the server's origin, or null when none is configured */
  server: () => string | null
  /** a stored path's bytes and name; null when it isn't a document the app may open */
  readFile: (path: string) => { name: string; bytes: Uint8Array } | null
  /** waits between upload retries */
  sleep: (ms: number) => Promise<void>
}

const realDeps: MoveDeps = {
  fetch: (input, init) => fetch(input, init),
  server: serverUrl,
  readFile: (p) => {
    let full: string
    try {
      full = documentPath(p)
    } catch {
      return null
    }
    if (statSync(full).size > UPLOAD_MAX) return null
    return { name: basename(full), bytes: readFileSync(full) }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
}

class ServerError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>
  constructor(status: number, body: Record<string, unknown>) {
    super(describe(status, body))
    this.status = status
    this.body = body
  }
}

function describe(status: number, body: Record<string, unknown>): string {
  const code = typeof body.error === 'string' ? body.error : ''
  if (code === 'code_invalid') return 'Wrong code'
  if (code === 'code_expired') return 'Code expired: send a new one'
  if (code === 'rate_limited') return 'Too many tries: wait a little'
  if (code === 'not_empty') return 'That account already has books: move into an empty one'
  if (code === 'schema') return typeof body.message === 'string' ? body.message : 'The server runs another schema version'
  if (typeof body.message === 'string') return body.message
  return `The server answered ${status}${code ? ` (${code})` : ''}`
}

async function send<T>(deps: MoveDeps, url: string, init: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  let res: Response
  try {
    res = await deps.fetch(url, init)
  } catch {
    throw new Error("The server can't be reached")
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const retry = res.headers.get('retry-after')
  if (!res.ok) throw new ServerError(res.status, retry ? { ...body, retryAfter: Number(retry) } : body)
  return { status: res.status, body: body as T, headers: res.headers }
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

function base(deps: MoveDeps): string {
  if (!devBuild()) throw new Error('Moving to an account is in development builds only')
  const server = deps.server()
  if (!server) throw new Error('No server is configured')
  return server
}

const cleanEmail = (email: unknown): string => {
  const e = typeof email === 'string' ? email.trim() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Enter an email address')
  return e
}

const withDeps = (deps: Partial<MoveDeps>): MoveDeps => ({ ...realDeps, ...deps })

export function moveStatus(deps: Partial<MoveDeps> = {}): MoveAccountStatus {
  const server = withDeps(deps).server()
  return { available: devBuild() && !!server, server }
}

/** Emails a sign-in code for the account to move into (a new email makes a new account). */
export async function moveSendCode(email: unknown, partial: Partial<MoveDeps> = {}): Promise<void> {
  const deps = withDeps(partial)
  await send(deps, `${base(deps)}/v1/auth/email/start`, json({ email: cleanEmail(email), timeZone: db.zone() }))
}

/** Uploads one file, waiting out a short rate limit. */
async function upload(deps: MoveDeps, server: string, auth: Record<string, string>, file: { name: string; bytes: Uint8Array }): Promise<UploadedFile> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData()
    form.append('file', new Blob([file.bytes as Uint8Array<ArrayBuffer>]), file.name)
    try {
      return (await send<UploadedFile>(deps, `${server}/v1/ledger/files`, { method: 'POST', headers: auth, body: form })).body
    } catch (e) {
      const wait = e instanceof ServerError && e.status === 429 ? Number(e.body.retryAfter ?? NaN) : NaN
      if (attempt < 3 && Number.isFinite(wait) && wait <= RETRY_MAX_SECONDS) {
        await deps.sleep(Math.max(1, wait) * 1000)
        continue
      }
      throw e
    }
  }
}

/** Signs in with the code, then moves every table and file into the account; the session is signed out after. */
export async function moveFinish(email: unknown, code: unknown, partial: Partial<MoveDeps> = {}): Promise<MoveAccountResult> {
  const deps = withDeps(partial)
  const server = base(deps)
  const c = typeof code === 'string' ? code.trim() : ''
  if (!/^\d{6}$/.test(c)) throw new Error('Enter the 6-digit code')
  const signed = await send<{ session: string }>(deps, `${server}/v1/auth/email/verify`, json({ email: cleanEmail(email), code: c, deviceName: 'Desktop move', timeZone: db.zone() }))
  const auth = { authorization: `Bearer ${signed.body.session}` }
  try {
    const ledger = await send<{ empty: boolean; schemaVersion: number }>(deps, `${server}/v1/ledger/import-desktop`, { method: 'GET', headers: auth })
    if (!ledger.body.empty) throw new Error('That account already has books: move into an empty one')
    if (ledger.body.schemaVersion !== db.LATEST_SCHEMA_VERSION) throw new Error(`The server's books are schema version ${ledger.body.schemaVersion} and these are ${db.LATEST_SCHEMA_VERSION}: run the same build on both`)

    const x = db.exportAll() as FullExport
    const uploads = new Map<string, UploadedFile>()
    const skipped: string[] = []
    for (const ref of exportFileRefs(x)) {
      const ext = /\.([^./\\]+)$/.exec(ref)?.[1]?.toLowerCase() ?? ''
      const file = UPLOAD_TYPES.has(ext) ? deps.readFile(ref) : null
      if (!file || !file.bytes.length) {
        skipped.push(ref)
        continue
      }
      uploads.set(ref, await upload(deps, server, auth, file))
    }
    const moved = rewriteFileRefs(x, uploads)
    const done = await send<{ tables: number; rows: number }>(deps, `${server}/v1/ledger/import-desktop`, json(moved, auth))
    return { tables: done.body.tables, rows: done.body.rows, files: uploads.size, skipped }
  } finally {
    await deps.fetch(`${server}/v1/auth/logout`, { method: 'POST', headers: auth }).catch(() => undefined)
  }
}

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void

/** The three IPC calls Settings → Data uses (ipc.ts registers them). */
export function registerMoveIpc(handle: Handle): void {
  handle('moveAccountStatus', () => moveStatus())
  handle('moveAccountSendCode', (email: string) => moveSendCode(email))
  handle('moveAccountFinish', (email: string, code: string) => moveFinish(email, code))
}
