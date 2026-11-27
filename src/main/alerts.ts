import * as db from './db'
import { addDays, calendarItems } from './calendar'
import { getCredit, nextReminderDay, reminderDay } from './credit'
import { devBuild } from './devBuild'
import { hideNumbersOnOpen, vendorHider } from './privacy'
import { detectRecurring } from './recurring'
import { openIssues } from './tools'
import { NOTIFY_KINDS, type CalendarItem, type NotificationPatch, type NotificationSettings, type NotifyKind, type OpenPageTarget, type RecurringSeries } from '../shared/types'
import { daysBetween, defaultZone, timeOfDay } from '../shared/zone'
import { errorTag } from '../shared/errorTag'

// Desktop notifications: the rules that decide what is worth one (pure, over
// plain inputs), the settings behind Settings → Notifications, and a check
// that gathers the inputs from the database and hands each new alert to a
// sender (background.ts shows them; no Electron here, so the tests run it).
// The hosted ledger runs the same check (collectAlerts) with its own
// preferences and kinds (ledgerAlerts.ts) and sends by push, text and email.
//
// - Each item is notified once: sent keys are kept for SENT_RETENTION_DAYS.
// - Transactions count once: bank-synced rows posted in the last
//   FRESH_WINDOW_DAYS are noted as seen when a check looks at them, hidden
//   accounts' too (unhiding one announces nothing old). The first check, the
//   first sync of a connection, and the first check that sees an account (a
//   bank added to the connection) only note what's there (the first check
//   also notes the month's credit reminder). Without an account (the first
//   run's wizard) nothing is checked.
// - Quiet hours and a pause hold everything back (nothing is noted), so the
//   next check after them catches up.
// - Hide numbers masks amounts as •••; a hidden vendor is never named (its
//   alert isn't sent at all).

const DAY = 86_400
export const SENT_RETENTION_DAYS = 60
/** Bank rows posted this recently are looked at (a card that posts a month late still counts). */
export const FRESH_WINDOW_DAYS = 40
export const FEED_BEHIND_DAYS = 3
export const BILL_DAYS = 3
/** A score recorded this recently means the month's reminder isn't needed. */
export const SCORE_FRESH_DAYS = 20
export const NEW_MERCHANT_MIN_CENTS = 2500
/** One check shows at most this many; the rest count as sent. */
export const MAX_PER_CHECK = 5
export const MASK = '•••'

const K = {
  keepRunning: 'notify.keepRunning',
  openAtLogin: 'notify.openAtLogin',
  kinds: 'notify.kinds',
  quiet: 'notify.quietHours',
  paused: 'notify.pausedUntil',
  sent: 'notify.sent',
  seen: 'notify.seen',
  accounts: 'notify.accounts',
  /** Plaid's rows are looked at too (before, only SimpleFIN's were): set once they've been noted */
  plaid: 'notify.seenPlaid'
}

/** The engine's kinds, and the hosted ledger's own: a coming shortfall, tomorrow's overdraw, a renewal, a bank asking to sign in again. */
export type AlertSource = NotifyKind | 'shortfall' | 'overdraw' | 'renewal' | 'bank_signin'

/** What an alert is about, for a host that words it its own way (the hosted ledger's push, text and email). */
export interface AlertFacts {
  /** the merchant, bill, series or bank */
  name?: string
  /** signed cents (a charge is negative); a shortfall's is how far under */
  cents?: number
  /** a price change's old price */
  previousCents?: number
  account?: string
  /** YYYY-MM-DD: the day it's due, falls short, or was last recorded */
  day?: string
  /** overdraw: the bills going out that day, largest first (negative cents) */
  bills?: Array<{ name: string; cents: number }>
  /** overdraw: the balance they leave (signed) and the line it falls under (zero, or the cushion) */
  lowCents?: number
  floorCents?: number
  /** overdraw: the one thing to do about it */
  move?: { kind: 'transfer'; from: string; cents: number } | { kind: 'ask'; name: string }
  /** renewal: how often it renews */
  cadence?: 'monthly' | 'annual'
}

export interface Alert {
  key: string
  kind: AlertSource
  title: string
  body: string
  target: OpenPageTarget
  facts?: AlertFacts
}

// ---------- the window and the tray ----------

/** The argument the login item starts the app with: it opens in the tray. */
export const HIDDEN_ARG = '--hidden'

/** Keep running in the background, before the user sets it: on in a shipped build, off in a development build (it quits on close as it always did). */
export const keepRunningDefault = (dev: boolean): boolean => !dev

/** What closing the window does: hides it to the tray, or closes it (and the app quits). Quit from the tray or the menu always closes. */
export const closeAction = (o: { quitting: boolean; keepRunning: boolean }): 'hide' | 'close' => (!o.quitting && o.keepRunning ? 'hide' : 'close')

// ---------- settings ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function json<T>(key: string, fallback: T): T {
  try {
    const raw = db.getSetting(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export const cleanQuiet = (q: unknown): { start: string; end: string } | null => {
  const v = q as { start?: unknown; end?: unknown } | null
  return v && typeof v.start === 'string' && typeof v.end === 'string' && HHMM.test(v.start) && HHMM.test(v.end) ? { start: v.start, end: v.end } : null
}

/** Open at login is offered by a packaged build that isn't a development build, outside the Store (a Store app needs a startup task of its own). */
// (windowsStore is Electron's; the hosted ledger, which loads this module too, has no Electron types.)
export const loginOffered = (): boolean => !devBuild() && !(process as { windowsStore?: boolean }).windowsStore

/** What the login item should be at launch: on or off as the setting says, or left alone (null) where it isn't offered. */
export const loginItemWanted = (s: Pick<NotificationSettings, 'loginOffered' | 'openAtLogin'>): boolean | null => (s.loginOffered ? s.openAtLogin : null)

export function notificationSettings(): NotificationSettings {
  const keep = db.getSetting(K.keepRunning)
  const kinds = json<Partial<Record<NotifyKind, boolean>>>(K.kinds, {})
  const paused = Number(db.getSetting(K.paused) ?? 0)
  return {
    keepRunning: keep === null ? keepRunningDefault(devBuild()) : keep === '1',
    openAtLogin: db.getSetting(K.openAtLogin) === '1',
    loginOffered: loginOffered(),
    kinds: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, kinds[k] !== false])) as Record<NotifyKind, boolean>,
    quietHours: cleanQuiet(json<unknown>(K.quiet, null)),
    pausedUntil: paused > db.now() ? paused : null
  }
}

/** Saves a change from Settings → Notifications or the tray; the login item itself is the caller's (Electron). */
export function setNotificationSettings(p: NotificationPatch, now = db.now()): NotificationSettings {
  if (p.keepRunning !== undefined) db.setSetting(K.keepRunning, p.keepRunning ? '1' : '0')
  if (p.openAtLogin !== undefined) {
    if (p.openAtLogin && !notificationSettings().loginOffered) throw new Error('Open at login is for the installed app')
    db.setSetting(K.openAtLogin, p.openAtLogin ? '1' : '0')
  }
  if (p.kinds && typeof p.kinds === 'object') {
    const cur = notificationSettings().kinds
    for (const k of NOTIFY_KINDS) if (typeof p.kinds[k] === 'boolean') cur[k] = p.kinds[k]!
    db.setSetting(K.kinds, JSON.stringify(cur))
  }
  if (p.quietHours !== undefined) {
    const q = p.quietHours === null ? null : cleanQuiet(p.quietHours)
    if (p.quietHours !== null && !q) throw new Error('Quiet hours are two times like 22:00')
    db.setSetting(K.quiet, q ? JSON.stringify(q) : null)
  }
  if (p.pauseMinutes !== undefined) {
    const m = Math.max(0, Math.round(Number(p.pauseMinutes)) || 0)
    db.setSetting(K.paused, m ? String(now + m * 60) : null)
  }
  return notificationSettings()
}

/** The sidebar's eye, as the window last reported it (the setting starts it). */
let eyeHidden: boolean | null = null
export const setNumbersHidden = (on: boolean): void => {
  eyeHidden = !!on
}
export const numbersHidden = (): boolean => eyeHidden ?? hideNumbersOnOpen()

// ---------- the rules ----------

/** Whether a time falls in quiet hours ('HH:MM' to 'HH:MM', across midnight when the end comes first) on a clock in `zone` (the default zone when left out). */
export function inQuietHours(at: Date, q: { start: string; end: string } | null, zone = defaultZone()): boolean {
  if (!q) return false
  const mins = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  const clock = timeOfDay(at.getTime() / 1000, zone)
  const m = clock.hour * 60 + clock.minute
  const s = mins(q.start)
  const e = mins(q.end)
  if (s === e) return false
  return s < e ? m >= s && m < e : m >= s || m < e
}

export interface Privacy {
  numbersHidden: boolean
  /** a hidden vendor (privacy.ts) */
  hidden: (name: string | null | undefined) => boolean
}

/** A bank-synced transaction no check has looked at yet. */
export interface FreshTxn {
  id: string
  posted: number
  cents: number
  merchant: string | null
  description: string
  account: string
  /** the recurring series it belongs to, as recurring.ts keys them */
  seriesKey: string
  /** an expense, or not categorized */
  spending: boolean
  /** no earlier transaction at this merchant */
  firstAtMerchant: boolean
}

export interface AlertInputs {
  now: number
  /** YYYY-MM-DD, local */
  today: string
  /** the calendar from today through BILL_DAYS ahead */
  calendar: CalendarItem[]
  fresh: FreshTxn[]
  issues: Array<{ key: string; kind: string; transaction_ids?: string[]; recurring_key?: string }>
  series: Array<Pick<RecurringSeries, 'key' | 'name' | 'lastCents' | 'previousCents'>>
  /** the bank feed; null: "feed behind" isn't checked (the hosted ledger syncs its banks itself) */
  bank: { connected: boolean; lastSyncAt: number | null } | null
  /** the Credit page's reminder day of the month (1-31); null while it's off */
  creditDay: number | null
  /** the newest score's day; null with none; undefined when not looked up */
  lastScoreDay?: string | null
}

/** The thresholds a host can change (the hosted ledger's preferences); left out, the desktop's. */
export interface Thresholds {
  /** bill_due: from this many days ahead (BILL_DAYS) */
  billDays?: number
  /** large_purchase: every charge of at least this many cents; unset or null: the review's large-purchase rule */
  largeMinCents?: number | null
  /** new_merchant: charges of at least this many cents (NEW_MERCHANT_MIN_CENTS) */
  newMerchantMinCents?: number
}

const money = (cents: number): string => `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDay = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const daysApart = daysBetween
const nameOf = (t: FreshTxn): string => t.merchant ?? t.description
const txTarget = (t: FreshTxn): OpenPageTarget => ({ page: 'transactions', search: nameOf(t), month: db.dayKey(t.posted).slice(0, 7) })

export function billAlerts(items: CalendarItem[], today: string, p: Privacy, days = BILL_DAYS): Alert[] {
  const last = addDays(today, days)
  const amount = (c: number): string => (p.numbersHidden ? MASK : money(c))
  return items
    .filter((i) => i.day >= today && i.day <= last && !i.done && (i.kind === 'bill' || (i.kind === 'reminder' && i.amountCents !== null)) && !p.hidden(i.title))
    .map((i) => {
      const n = daysApart(today, i.day)
      return {
        key: `bill_due:${i.key}:${i.day}`,
        kind: 'bill_due' as const,
        title: n === 0 ? 'Due today' : n === 1 ? 'Due tomorrow' : `Due in ${n} days`,
        body: [i.title, i.amountCents !== null ? amount(i.amountCents) : null, fmtDay(i.day)].filter(Boolean).join(' · '),
        target: { page: 'calendar' as const },
        facts: { name: i.title, day: i.day, ...(i.amountCents !== null ? { cents: i.amountCents } : {}) }
      }
    })
}

/**
 * Double charges, large purchases, new merchants and price changes among the fresh transactions; a transaction
 * is named in one alert at most. A large purchase is the review's rule (large for you), or with `largeMinCents`
 * any charge of at least that.
 */
export function transactionAlerts(inp: Pick<AlertInputs, 'fresh' | 'issues' | 'series'>, p: Privacy, o: Thresholds = {}): Alert[] {
  const amount = (c: number): string => (p.numbersHidden ? MASK : money(c))
  const fresh = new Map(inp.fresh.map((t) => [t.id, t]))
  const hiddenTx = (t: FreshTxn): boolean => p.hidden(t.merchant) || p.hidden(t.description)
  const facts = (t: FreshTxn): AlertFacts => ({ name: nameOf(t), cents: t.cents, account: t.account })
  const used = new Set<string>()
  const out: Alert[] = []
  for (const i of inp.issues.filter((x) => x.kind === 'possible_duplicate')) {
    const ids = i.transaction_ids ?? []
    const t = ids.map((id) => fresh.get(id)).find((x) => !!x)
    if (!t) continue
    for (const id of ids) used.add(id)
    if (!hiddenTx(t)) out.push({ key: i.key, kind: 'possible_duplicate', title: 'Possible double charge', body: `${nameOf(t)} · ${amount(t.cents)} twice · ${t.account}`, target: txTarget(t), facts: facts(t) })
  }
  const minLarge = o.largeMinCents ?? null
  const large =
    minLarge === null
      ? inp.issues.filter((x) => x.kind === 'large_purchase').flatMap((i) => fresh.get(i.transaction_ids?.[0] ?? '') ?? [])
      : inp.fresh.filter((t) => t.spending && t.cents < 0 && -t.cents >= minLarge)
  for (const t of large) {
    if (used.has(t.id)) continue
    used.add(t.id)
    if (!hiddenTx(t)) out.push({ key: `large_purchase:${t.id}`, kind: 'large_purchase', title: 'Large purchase', body: `${nameOf(t)} · ${amount(t.cents)} · ${t.account}`, target: txTarget(t), facts: facts(t) })
  }
  const minNew = o.newMerchantMinCents ?? NEW_MERCHANT_MIN_CENTS
  for (const t of inp.fresh) {
    if (!t.firstAtMerchant || !t.spending || t.cents > -minNew || used.has(t.id)) continue
    used.add(t.id)
    if (!hiddenTx(t)) out.push({ key: `new_merchant:${t.id}`, kind: 'new_merchant', title: 'New merchant', body: `${nameOf(t)} · ${amount(t.cents)} · ${t.account}`, target: txTarget(t), facts: facts(t) })
  }
  for (const i of inp.issues.filter((x) => x.kind === 'price_change' && x.recurring_key)) {
    const t = inp.fresh.find((f) => f.seriesKey === i.recurring_key)
    const s = inp.series.find((x) => x.key === i.recurring_key)
    if (!t || !s || p.hidden(s.name) || hiddenTx(t)) continue
    out.push({ key: i.key, kind: 'price_change', title: 'Price change', body: `${s.name} · ${amount(s.previousCents)} → ${amount(s.lastCents)}`, target: { page: 'recurring' }, facts: { name: s.name, cents: s.lastCents, previousCents: s.previousCents } })
  }
  return out
}

export function feedAlert(bank: AlertInputs['bank'], now: number): Alert[] {
  if (!bank || !bank.connected || bank.lastSyncAt === null || now - bank.lastSyncAt < FEED_BEHIND_DAYS * DAY) return []
  const day = db.dayKey(bank.lastSyncAt)
  return [{ key: `feed_behind:${bank.lastSyncAt}`, kind: 'feed_behind', title: 'Bank feed behind', body: `Last synced ${fmtDay(day)}`, target: { page: 'accounts' }, facts: { day } }]
}

/** The Credit page's reminder day has come this month (its last day when the month is shorter). */
const creditDue = (today: string, creditDay: number | null): boolean => creditDay !== null && today >= nextReminderDay(`${today.slice(0, 7)}-01`, creditDay)

/** Once a month, from the Credit page's reminder day on, unless a score was recorded lately. */
export function creditAlert(today: string, creditDay: number | null, lastScoreDay: string | null | undefined): Alert[] {
  if (lastScoreDay === undefined || !creditDue(today, creditDay)) return []
  if (lastScoreDay && daysApart(lastScoreDay, today) < SCORE_FRESH_DAYS) return []
  return [{ key: `credit_reminder:${today.slice(0, 7)}`, kind: 'credit_reminder', title: 'Credit score', body: lastScoreDay ? `Last recorded ${fmtDay(lastScoreDay)}` : 'None recorded', target: { page: 'credit' }, facts: lastScoreDay ? { day: lastScoreDay } : {} }]
}

/** Everything worth a notification now, before the switches, the sent list and the cap; most pressing first. */
export function alertsFor(inp: AlertInputs, p: Privacy, o: Thresholds = {}): Alert[] {
  return [...feedAlert(inp.bank, inp.now), ...billAlerts(inp.calendar, inp.today, p, o.billDays), ...transactionAlerts(inp, p, o), ...creditAlert(inp.today, inp.creditDay, inp.lastScoreDay)]
}

/** The ones to show: switched on (a kind the switches don't name is the caller's, on) and not sent before, at most MAX_PER_CHECK; the rest of those are counted as sent. */
export function pick(alerts: Alert[], kinds: Partial<Record<AlertSource, boolean>>, sent: Record<string, number>): { show: Alert[]; drop: Alert[] } {
  const due = alerts.filter((a, i) => kinds[a.kind] !== false && !(a.key in sent) && alerts.findIndex((b) => b.key === a.key) === i)
  return { show: due.slice(0, MAX_PER_CHECK), drop: due.slice(MAX_PER_CHECK) }
}

/** Sent keys newer than the retention window. */
export const pruneSent = (sent: Record<string, number>, now: number): Record<string, number> => Object.fromEntries(Object.entries(sent).filter(([, at]) => now - at < SENT_RETENTION_DAYS * DAY))

/** Seen transactions still inside the window (by their posted time). */
export const pruneSeen = (seen: Record<string, number>, now: number): Record<string, number> => Object.fromEntries(Object.entries(seen).filter(([, posted]) => posted >= now - FRESH_WINDOW_DAYS * DAY))

// ---------- the check ----------

interface BankRow {
  id: string
  accountId: string
  hidden: number
  posted: number
  cents: number
  merchant: string | null
  description: string
  account: string
  seriesKey: string
  spending: number
  mkey: string
}

/** Bank-synced rows (SimpleFIN's and Plaid's; not CSV, not pending) posted inside the window, on every account (hidden ones are noted, never announced). */
function bankRows(now: number): BankRow[] {
  return db.all<BankRow>(
    `SELECT t.id, t.account_id AS accountId, a.hidden, t.posted, t.amount_cents AS cents, t.merchant, t.description, a.name AS account,
            lower(trim(COALESCE(t.merchant, t.desc_key))) || CASE WHEN t.amount_cents < 0 THEN '|-' ELSE '|+' END AS seriesKey,
            CASE WHEN c.id IS NULL OR c.kind = 'expense' THEN 1 ELSE 0 END AS spending, COALESCE(t.merchant, t.desc_key) AS mkey
     FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.posted >= ? AND t.pending = 0 AND (t.id LIKE 'sf:%' OR t.id LIKE 'plaid:%') AND t.id NOT LIKE '%:csv:%'
     ORDER BY t.posted DESC`,
    now - FRESH_WINDOW_DAYS * DAY
  )
}

/**
 * Where a check keeps what it has sent and seen. The desktop's, and a hosted ledger's owner's, are the
 * settings above; a partner on a hosted ledger keeps their own beside them (the key and their id), so each
 * member is told everything once, under their own preferences.
 */
interface AlertRecord {
  sent: string
  seen: string
  accounts: string
  plaid: string
}

const recordOf = (member?: string | null): AlertRecord => {
  const at = (key: string): string => (member ? `${key}:${member}` : key)
  return { sent: at(K.sent), seen: at(K.seen), accounts: at(K.accounts), plaid: at(K.plaid) }
}

/** A partner's record (sent, seen, the accounts looked at): the settings dropped when they leave the ledger. */
export const memberRecordKeys = (member: string): string[] => Object.values(recordOf(member))

const accountIds = (): string[] => db.all<{ id: string }>('SELECT id FROM accounts').map((r) => r.id)
/** The accounts a check has looked at; before they were kept, every account here counts as looked at. */
const knownAccounts = (r: AlertRecord): Set<string> => new Set(json<string[] | null>(r.accounts, null) ?? accountIds())
const saveAccounts = (r: AlertRecord): void => db.setSetting(r.accounts, JSON.stringify(accountIds()))

const firstAtMerchant = (r: BankRow): boolean =>
  !db.get(`SELECT 1 AS x FROM transactions WHERE id != ? AND COALESCE(merchant, desc_key) = ? AND (posted < ? OR (posted = ? AND id < ?)) LIMIT 1`, r.id, r.mkey, r.posted, r.posted, r.id)

function saveSeen(r: AlertRecord, seen: Record<string, number>, now: number): void {
  db.setSetting(r.seen, JSON.stringify(pruneSeen(seen, now)))
  db.setSetting(r.plaid, '1')
}

/** The first sync of a connection brings months of history: its rows are noted as seen, not notified. */
export function noteTransactionsSeen(now = db.now()): void {
  const r = recordOf()
  const seen = json<Record<string, number>>(r.seen, {})
  for (const row of bankRows(now)) seen[row.id] = row.posted
  saveSeen(r, seen, now)
  saveAccounts(r)
}

/** Notes keys as sent (an alert another one already covered), in a partner's own record with `member`; one sent before keeps its time. */
export function markSent(keys: string[], now: number, member?: string | null): void {
  if (!keys.length) return
  const r = recordOf(member)
  const sent = pruneSent(json<Record<string, number>>(r.sent, {}), now)
  for (const k of keys) sent[k] ??= now
  db.setSetting(r.sent, JSON.stringify(sent))
}

/** Of `alerts`, the ones not sent before, each noted as sent now (the hosted ledger's evening check, outside a full check); a partner's own with `member`. */
export function takeUnsent(alerts: Alert[], now: number, member?: string | null): Alert[] {
  const sent = pruneSent(json<Record<string, number>>(recordOf(member).sent, {}), now)
  const fresh = alerts.filter((a, i) => !(a.key in sent) && alerts.findIndex((b) => b.key === a.key) === i)
  markSent(fresh.map((a) => a.key), now, member)
  return fresh
}

/** Drops the sent keys `drop` picks, so they can come again (the hosted ledger: a bank that asked to sign in, then was fixed); a partner's own with `member`. */
export function forgetSent(drop: (key: string) => boolean, member?: string | null): void {
  const r = recordOf(member)
  if (db.getSetting(r.sent) === null) return
  const sent = json<Record<string, number>>(r.sent, {})
  const keep = Object.fromEntries(Object.entries(sent).filter(([k]) => !drop(k)))
  if (Object.keys(keep).length !== Object.keys(sent).length) db.setSetting(r.sent, JSON.stringify(keep))
}

/** Paused, or in quiet hours on the ledger's clock (its zone): everything waits, and nothing is noted. */
export const heldBack = (now: number, s: { pausedUntil: number | null; quietHours: { start: string; end: string } | null }): boolean =>
  (s.pausedUntil ?? 0) > now || inQuietHours(new Date(now * 1000), s.quietHours, db.zone())

export interface CollectContext {
  now: number
  /** the bank feed, for "feed behind"; null: not checked */
  bank: AlertInputs['bank']
  /** a sync or a categorization is running: new transactions wait for the next check */
  busy?: boolean
  /** the engine's kinds to look for */
  kinds: Record<NotifyKind, boolean>
  privacy: Privacy
  thresholds?: Thresholds
  /** the host's own alerts (the hosted ledger's shortfall and bank sign-in), switched on already; they come first */
  more?: Alert[]
  /** a partner on a hosted ledger: their own record of what's been sent and seen; left out, the owner's (the desktop's) */
  member?: string | null
}

/**
 * The check, past quiet hours and a pause: what's new, each noted as sent (and the bank rows as seen). At
 * most MAX_PER_CHECK come back; the rest count as sent. Nothing before the ledger has an account.
 */
export function collectAlerts(c: CollectContext): Alert[] {
  const { now, kinds: on } = c
  // Nothing before the app has an account (the first run's wizard).
  if (!db.get('SELECT 1 AS x FROM accounts LIMIT 1')) return []
  const today = db.dayKey(now)
  const t = c.thresholds ?? {}
  const rec = recordOf(c.member)
  const sent = pruneSent(json<Record<string, number>>(rec.sent, {}), now)
  // The first check notes this month's credit reminder too: it comes from next month on.
  if (db.getSetting(rec.sent) === null) sent[`credit_reminder:${today.slice(0, 7)}`] = now

  const minNew = t.newMerchantMinCents ?? NEW_MERCHANT_MIN_CENTS
  let fresh: FreshTxn[] = []
  let seen: Record<string, number> | null = null
  if (!c.busy) {
    const first = db.getSetting(rec.seen) === null
    // Plaid's rows weren't looked at before: the first check that does only notes them.
    const plaidFirst = db.getSetting(rec.plaid) === null
    seen = json<Record<string, number>>(rec.seen, {})
    // An account seen for the first time brings its history: noted, like a first sync.
    const known = knownAccounts(rec)
    const rows = bankRows(now)
    const unseen = first ? [] : rows.filter((r) => !r.hidden && known.has(r.accountId) && !(r.id in seen!) && !(plaidFirst && r.id.startsWith('plaid:')))
    for (const r of rows) seen[r.id] = r.posted
    fresh = unseen.map((r) => ({ id: r.id, posted: r.posted, cents: r.cents, merchant: r.merchant, description: r.description, account: r.account, seriesKey: r.seriesKey, spending: r.spending === 1, firstAtMerchant: on.new_merchant && r.cents <= -minNew && firstAtMerchant(r) }))
  }
  const byRule = (t.largeMinCents ?? null) === null
  const txKinds = fresh.length > 0 && ((on.large_purchase && byRule) || on.possible_duplicate || on.price_change)
  const billDays = t.billDays ?? BILL_DAYS
  const creditDay = reminderDay()
  const inputs: AlertInputs = {
    now,
    today,
    calendar: on.bill_due ? calendarItems(today, addDays(today, billDays)) : [],
    fresh,
    issues: txKinds ? openIssues() : [],
    series: txKinds && on.price_change ? detectRecurring() : [],
    bank: c.bank,
    creditDay,
    lastScoreDay: on.credit_reminder && creditDue(today, creditDay) ? (getCredit().scores[0]?.day ?? null) : undefined
  }
  const { show, drop } = pick([...(c.more ?? []), ...alertsFor(inputs, c.privacy, { ...t, billDays })], on, sent)
  for (const a of [...show, ...drop]) sent[a.key] = now
  db.setSetting(rec.sent, JSON.stringify(sent))
  if (seen) {
    saveSeen(rec, seen, now)
    saveAccounts(rec)
  }
  return show
}

export interface CheckContext {
  now?: number
  bank: { connected: boolean; lastSyncAt: number | null }
  /** a sync or a categorization is running: new transactions wait for the next check */
  busy?: boolean
  show: (a: Alert) => void
}

/** The desktop's check: looks for new alerts and hands each to `show`; returns the ones shown. */
export function checkAlerts(ctx: CheckContext): Alert[] {
  const now = ctx.now ?? db.now()
  const s = notificationSettings()
  if (heldBack(now, s)) return []
  const show = collectAlerts({ now, bank: ctx.bank, busy: ctx.busy, kinds: s.kinds, privacy: { numbersHidden: numbersHidden(), hidden: vendorHider() } })
  for (const a of show) {
    try {
      ctx.show(a)
    } catch (err) {
      console.error(`[alerts] a notification could not be shown${errorTag(err)}`)
    }
  }
  return show
}
