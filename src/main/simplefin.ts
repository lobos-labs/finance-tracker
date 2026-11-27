import * as db from './db'
import { deleteSecret, readSecret, saveSecret } from './secrets'
import { claimSetupToken } from './simplefinClaim'
import { centsOf, isCents } from '../shared/parse'
import type { SyncResult } from '../shared/types'

// A SimpleFIN-compatible bridge (SimpleFIN Bridge, https://beta-bridge.simplefin.org,
// is the usual one; any server that speaks the protocol works) gives read-only
// access to bank accounts. The user creates a one-time "setup token"; we
// exchange it for an access URL with embedded Basic-auth credentials and keep
// that encrypted. The bridge allows ~24 requests/day and at most 90 days per
// request; how far back history goes varies by bank, so older history is
// backfilled a few windows per sync until the banks stop returning any.

const DAY = 86_400
const WINDOW_DAYS = 90
const INITIAL_HISTORY_DAYS = 90
const OVERLAP_DAYS = 10
const DAILY_REQUEST_BUDGET = 20
const BACKFILL_WINDOW_DAYS = 89 // + 1 day of overlap = the bridge's 90-day maximum
const BACKFILL_WINDOWS_PER_SYNC = 6
const BACKFILL_RESERVE = 4 // requests always left for ordinary syncs
const BACKFILL_MAX_DAYS = 10 * 365 // banks run out long before this; the empty-window stop ends it
const BACKFILL_EMPTY_STOP = 2 // consecutive empty windows that mean "no more history"
// The initial pull for a new connection goes as deep as the banks allow,
// using the day's request allowance (the bridge expects <= 24/day) while
// leaving room for an ordinary sync, and continues on later launches until
// done; then syncs fall back to the per-sync pace above.
const DEEP_DAILY_LIMIT = 19
const QUOTA_WARNING = /quota|rate.?limit|too many|limit/i

interface SfTransaction {
  id: string
  posted: number
  amount: string
  description: string
  transacted_at?: number
  pending?: boolean
  payee?: string
}

interface SfAccount {
  id: string
  name: string
  conn_id?: string
  currency: string
  balance: string
  'available-balance'?: string
  'balance-date': number
  transactions?: SfTransaction[]
  org?: { id?: string; name?: string; domain?: string }
  /** positions in a brokerage or retirement account (a bridge extension; not every institution sends them) */
  holdings?: SfHolding[]
}

type SfNumber = string | number | null | undefined

interface SfHolding {
  id?: string
  symbol?: string
  description?: string
  shares?: SfNumber
  quantity?: SfNumber
  market_value?: SfNumber
  current_value?: SfNumber
  cost_basis?: SfNumber
  purchase_price?: SfNumber
}

function num(v: SfNumber): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toHolding(h: SfHolding, i: number): db.HoldingInput | null {
  const value = num(h.market_value) ?? num(h.current_value)
  if (value === null) return null
  const shares = num(h.shares) ?? num(h.quantity)
  const basis = num(h.cost_basis) ?? (num(h.purchase_price) !== null && shares !== null ? num(h.purchase_price)! * shares : null)
  const symbol = h.symbol?.trim() || null
  return {
    id: h.id || symbol || `#${i}`,
    symbol,
    description: h.description?.trim() || symbol || 'Position',
    shares,
    valueCents: Math.round(value * 100),
    // Plans that don't track cost basis report it as 0.
    costCents: basis === null || basis <= 0 ? null : Math.round(basis * 100)
  }
}

interface SfAccountSet {
  accounts: SfAccount[]
  connections?: Array<{ conn_id: string; name: string }>
  errlist?: Array<{ code: string; msg: string }>
  errors?: string[]
}

export function isConnected(): boolean {
  return readSecret('simplefinAccessUrl') !== null
}

/** The bridge's site (its origin), where the user revokes the app's access; null when not connected. */
export function bridgeOrigin(): string | null {
  const url = readSecret('simplefinAccessUrl')
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** A bridge amount as cents, or null when it isn't a number the app can store. */
const toCents = centsOf

// A bridge's dates are Unix seconds; one before 1990 or more than two days ahead is no date.
const EARLIEST = Date.UTC(1990, 0, 1) / 1000
const toTime = (v: unknown, latest: number): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= EARLIEST && v <= latest ? v : null)
const toText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** Claims the setup token (simplefinClaim.ts) and keeps the access URL; throws a one-line reason. */
export async function connect(setupToken: string): Promise<void> {
  const accessUrl = await claimSetupToken(setupToken)
  saveSecret('simplefinAccessUrl', accessUrl)
  db.setSetting('simplefin.lastSyncAt', null)
  db.setSetting('simplefin.lastWarnings', null)
  resetHistory()
  db.setSetting('simplefin.historyDeep', '1')
}

function resetHistory(): void {
  for (const k of ['simplefin.historyFrom', 'simplefin.historyDone', 'simplefin.historyEmpty', 'simplefin.historyDeep']) db.setSetting(k, null)
}

/** Connections made before the deep initial pull existed get it once. */
export function migrateDeepPull(): void {
  if (db.getSetting('simplefin.deepMigrated')) return
  if (isConnected() && db.getSetting('simplefin.historyDone') !== '1') db.setSetting('simplefin.historyDeep', '1')
  db.setSetting('simplefin.deepMigrated', '1')
}

/** True while the initial deep pull still has history left to fetch and requests left today. */
export function deepPullPending(): boolean {
  return isConnected() && db.getSetting('simplefin.historyDeep') === '1' && db.getSetting('simplefin.historyDone') !== '1' && requestsLast24h() < DEEP_DAILY_LIMIT - 2
}

export function disconnect(): void {
  deleteSecret('simplefinAccessUrl')
  db.setSetting('simplefin.lastSyncAt', null)
  db.setSetting('simplefin.lastWarnings', null)
  resetHistory()
}

/** The bridge's warnings from the last sync (it asks apps to show them), or why the last sync failed. */
export function lastWarnings(): string[] {
  const raw = db.getSetting('simplefin.lastWarnings')
  return raw ? (JSON.parse(raw) as string[]) : []
}

const rememberWarnings = (warnings: string[]): void => db.setSetting('simplefin.lastWarnings', warnings.length ? JSON.stringify(warnings) : null)

function recentRequests(): number[] {
  const raw = db.getSetting('simplefin.requests')
  const cutoff = db.now() - DAY
  return raw ? (JSON.parse(raw) as number[]).filter((t) => t > cutoff) : []
}

export function requestsLast24h(): number {
  return recentRequests().length
}

function recordRequest(): void {
  db.setSetting('simplefin.requests', JSON.stringify([...recentRequests(), db.now()]))
}

async function fetchAccounts(accessUrl: string, start: number, end: number): Promise<SfAccountSet> {
  // fetch() refuses URLs with embedded credentials, so move them to a header.
  const u = new URL(accessUrl)
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
  u.username = ''
  u.password = ''
  const base = u.toString().replace(/\/$/, '')
  const qs = new URLSearchParams({ version: '2', 'start-date': String(start), 'end-date': String(end), pending: '1' })

  recordRequest()
  const res = await fetch(`${base}/accounts?${qs}`, { headers: { Authorization: `Basic ${auth}` } })
  if (res.status === 403) throw new Error('Bank access was revoked or is invalid. Reconnect on the Accounts page.')
  if (res.status === 402) throw new Error('The bridge says payment is required. Check your subscription.')
  if (!res.ok) throw new Error(`The bridge request failed (HTTP ${res.status}).`)
  return (await res.json()) as SfAccountSet
}

/**
 * Fetches one date window, stores accounts and transactions, and returns how
 * many transactions came back. The bridge's answer is checked field by field
 * before anything is written: a row with an unreadable id, date, description
 * or amount is skipped and counted, never stored.
 */
async function ingestWindow(accessUrl: string, from: number, to: number, result: SyncResult, seenAccounts: Set<string>): Promise<number> {
  const set = await fetchAccounts(accessUrl, from, to)
  if (!set || typeof set !== 'object') throw new Error('The bridge returned no account data.')
  for (const e of Array.isArray(set.errlist) ? set.errlist : []) if (toText(e?.msg)) result.warnings.push(String(e.msg))
  for (const e of Array.isArray(set.errors) ? set.errors : []) if (toText(e)) result.warnings.push(String(e))
  const connNames = new Map((Array.isArray(set.connections) ? set.connections : []).filter((c) => c && toText(c.conn_id) && toText(c.name)).map((c) => [c.conn_id, c.name]))
  const latest = db.now() + 2 * DAY
  const merged = db.mergedAccounts()
  let received = 0
  let skipped = 0

  db.inTransaction(() => {
    for (const a of Array.isArray(set.accounts) ? set.accounts : []) {
      // An account the app can't name or key is left alone.
      if (!a || typeof a !== 'object' || !toText(a.id) || !toText(a.name) || /[:\s]/.test(String(a.id))) {
        skipped++
        continue
      }
      const connId = toText(a.conn_id) ?? toText(a.org?.id) ?? toText(a.org?.domain) ?? toText(a.org?.name) ?? 'default'
      const accountId = `sf:${connId}:${a.id}`
      // A feed merged into another account would bring its rows back a second time.
      if (merged[accountId]) continue
      seenAccounts.add(accountId)
      const balanceDate = toTime(a['balance-date'], latest)
      // Balances are always current, whatever the window.
      db.upsertAccount({
        id: accountId,
        source: 'simplefin',
        name: db.cleanText(a.name, db.MERCHANT_MAX) || 'Account',
        institution: (toText(a.conn_id) && connNames.get(a.conn_id!)) || toText(a.org?.name) || null,
        currency: toText(a.currency)?.slice(0, 8) ?? 'USD',
        balanceCents: toCents(a.balance),
        availableCents: toCents(a['available-balance']),
        balanceDate
      })
      // Positions are current, like balances.
      if (Array.isArray(a.holdings)) db.replaceHoldings(accountId, a.holdings.filter((h) => h && typeof h === 'object').map(toHolding).filter((h): h is db.HoldingInput => h !== null && isCents(h.valueCents) && (h.costCents === null || isCents(h.costCents))), balanceDate ?? db.now())
      const keep = new Set<string>()
      for (const t of Array.isArray(a.transactions) ? a.transactions : []) {
        const amountCents = t && typeof t === 'object' ? toCents(t.amount) : null
        const posted = t && typeof t === 'object' ? (toTime(t.posted, latest) ?? toTime(t.transacted_at, latest)) : null
        const description = t && typeof t === 'object' ? (toText(t.description) ?? toText(t.payee)) : null
        if (amountCents === null || posted === null || !toText(t?.id) || description === null) {
          skipped++
          continue
        }
        received++
        const id = `${accountId}:${String(t.id)}`
        keep.add(id)
        const isNew = db.upsertTransaction({ id, accountId, posted, amountCents, description: description.trim(), pending: t.pending === true })
        if (isNew) result.added++
        else result.updated++
      }
      db.prunePending(accountId, from, to, keep)
    }
  })
  if (skipped) {
    console.warn(`[simplefin] ${skipped} row${skipped === 1 ? '' : 's'} skipped: unreadable id, date, name or amount`)
    result.warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} from the bridge couldn't be read and ${skipped === 1 ? 'was' : 'were'} skipped`)
  }
  return received
}

/** Oldest date already requested; derived from stored transactions for connections made before backfill existed. */
function historyFrom(fallback: number): number {
  const saved = Number(db.getSetting('simplefin.historyFrom') ?? 0)
  if (saved) return saved
  const oldest = db.get<{ p: number | null }>("SELECT MIN(posted) AS p FROM transactions WHERE account_id LIKE 'sf:%'")?.p
  return Math.min(oldest ?? fallback, fallback)
}

export function historyStatus(): { from: number | null; complete: boolean } {
  const from = Number(db.getSetting('simplefin.historyFrom') ?? 0)
  return { from: from || null, complete: db.getSetting('simplefin.historyDone') === '1' }
}

/**
 * Walks backward from the oldest window fetched so far until the banks stop
 * returning transactions. The initial (deep) pull uses the day's request
 * allowance; afterwards it's a few windows per sync.
 */
async function backfill(accessUrl: string, result: SyncResult, seenAccounts: Set<string>, start: number): Promise<void> {
  if (db.getSetting('simplefin.historyDone') === '1') return
  const deep = db.getSetting('simplefin.historyDeep') === '1'
  let from = historyFrom(start)
  let empty = Number(db.getSetting('simplefin.historyEmpty') ?? 0)
  const floor = db.now() - BACKFILL_MAX_DAYS * DAY
  const allowed = deep ? DEEP_DAILY_LIMIT - requestsLast24h() : Math.min(BACKFILL_WINDOWS_PER_SYNC, DAILY_REQUEST_BUDGET - BACKFILL_RESERVE - requestsLast24h())

  for (let i = 0; i < allowed; i++) {
    if (from <= floor || empty >= BACKFILL_EMPTY_STOP) break
    const windowStart = Math.max(from - BACKFILL_WINDOW_DAYS * DAY, floor)
    const warningsBefore = result.warnings.length
    const received = await ingestWindow(accessUrl, windowStart, from + DAY, result, seenAccounts)
    empty = received === 0 ? empty + 1 : 0
    from = windowStart
    db.setSetting('simplefin.historyFrom', String(from))
    db.setSetting('simplefin.historyEmpty', String(empty))
    // Back off at the first sign of quota trouble; the rest continues on a later sync.
    if (result.warnings.slice(warningsBefore).some((w) => QUOTA_WARNING.test(w))) break
  }
  if (from <= floor || empty >= BACKFILL_EMPTY_STOP) {
    db.setSetting('simplefin.historyDone', '1')
    db.setSetting('simplefin.historyDeep', null) // back to the default pace
  }
}

/** Pulls balances and transactions since the last sync (90 days on first run), then backfills older history. */
export async function sync(): Promise<SyncResult> {
  try {
    return await syncOnce()
  } catch (err) {
    // The Accounts page shows why, since a sync at launch has no one watching it.
    rememberWarnings([err instanceof Error ? err.message : String(err)])
    throw err
  }
}

async function syncOnce(): Promise<SyncResult> {
  const accessUrl = readSecret('simplefinAccessUrl')
  if (!accessUrl) throw new Error('No bank connection yet. Connect a bridge on the Accounts page.')

  const end = db.now() + DAY
  const last = Number(db.getSetting('simplefin.lastSyncAt') ?? 0)
  const start = last ? last - OVERLAP_DAYS * DAY : end - (INITIAL_HISTORY_DAYS + 1) * DAY

  const windows: Array<[number, number]> = []
  for (let s = start; s < end; s += WINDOW_DAYS * DAY) windows.push([s, Math.min(s + WINDOW_DAYS * DAY, end)])
  if (requestsLast24h() + windows.length > DAILY_REQUEST_BUDGET) {
    throw new Error('The bridge allows about 24 requests a day and this app has used most of them. Try again in a few hours.')
  }

  const known = new Set(db.listAccounts().filter((a) => a.source === 'simplefin').map((a) => a.id))
  const result: SyncResult = { accounts: 0, added: 0, updated: 0, warnings: [] }
  const seenAccounts = new Set<string>()
  for (const [from, to] of windows) await ingestWindow(accessUrl, from, to, result, seenAccounts)
  if (!last) {
    db.setSetting('simplefin.historyFrom', String(start))
  } else if ([...seenAccounts].some((id) => !known.has(id))) {
    // A bank was added in SimpleFIN since the last sync: walk history back again so it gets its past too.
    resetHistory()
    db.setSetting('simplefin.historyFrom', String(start))
    db.setSetting('simplefin.historyDeep', '1')
  }
  db.setSetting('simplefin.lastSyncAt', String(db.now()))

  try {
    await backfill(accessUrl, result, seenAccounts, start)
  } catch (err) {
    // Older history is a bonus; never fail the sync over it.
    result.warnings.push(`Older history: ${err instanceof Error ? err.message : String(err)}`)
  }

  const h = historyStatus()
  result.historyFrom = h.from
  result.historyComplete = h.complete
  result.accounts = seenAccounts.size
  result.warnings = [...new Set(result.warnings)]
  rememberWarnings(result.warnings)
  return result
}

export function lastSyncAt(): number | null {
  const v = db.getSetting('simplefin.lastSyncAt')
  return v ? Number(v) : null
}
