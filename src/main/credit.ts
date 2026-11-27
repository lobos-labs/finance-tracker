import { randomUUID } from 'node:crypto'
import * as db from './db'
import { fileFound } from './files'
import { isLocalDocument } from './receipts'
import { addDays, dayFrom, daysInMonth } from '../shared/zone'
import { CREDIT_BUREAUS, type CalendarEvent, type CreditBureau, type CreditReport, type CreditScore, type CreditTradeline, type CreditView, type TradelineKind } from '../shared/types'

// Credit: scores as the user sees them (a bank's free score page, a bureau's app),
// each bureau's latest report (accounts, hard inquiries, anything negative), and
// card limits. Utilization follows the synced card balances on its own; scores
// and reports come in through the assistant (a screenshot, a report PDF) or the page.

const KEY = 'credit'

interface Limit {
  accountId: string
  cents: number
  source: string | null
  asOf: string | null
}

interface Store {
  scores: CreditScore[]
  reports: CreditReport[]
  limits: Limit[]
}

function load(): Store {
  const raw = db.getSetting(KEY)
  const s = (raw ? JSON.parse(raw) : {}) as Partial<Store>
  return { scores: s.scores ?? [], reports: s.reports ?? [], limits: s.limits ?? [] }
}

function save(s: Store): void {
  db.setSetting(KEY, JSON.stringify(s))
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MONTHISH = /^\d{4}-\d{2}(-\d{2})?$/

function day(v: unknown, what: string): string {
  const s = String(v ?? '').trim()
  if (!DAY.test(s) || Number.isNaN(new Date(`${s}T12:00:00`).getTime())) throw new Error(`${what} must be a date like 2026-10-18`)
  return s
}

function bureau(v: unknown): CreditBureau | null {
  if (v === null || v === undefined || v === '') return null
  const b = CREDIT_BUREAUS.find((x) => x.toLowerCase() === String(v).trim().toLowerCase())
  if (!b) throw new Error(`Bureau must be one of ${CREDIT_BUREAUS.join(', ')}`)
  return b
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Where a score is followed: the same bureau, model and source make one line on the chart. */
export const scoreKey = (s: Pick<CreditScore, 'bureau' | 'model' | 'source'>): string => [s.bureau ?? '', s.model ?? '', s.source ?? ''].join('|')

/** Records a score; the same place on the same day replaces the earlier entry. */
export function recordScore(input: { day: unknown; score: unknown; bureau?: unknown; model?: unknown; source?: unknown; note?: unknown }): CreditScore {
  const score = Math.round(Number(input.score))
  if (!Number.isFinite(score) || score < 250 || score > 900) throw new Error('A credit score is between 250 and 900')
  const s: CreditScore = { id: randomUUID(), day: day(input.day, 'The date'), score, bureau: bureau(input.bureau), model: text(input.model), source: text(input.source), note: text(input.note) }
  const store = load()
  store.scores = store.scores.filter((x) => !(x.day === s.day && scoreKey(x) === scoreKey(s)))
  store.scores.push(s)
  save(store)
  return s
}

export function deleteScore(id: string): void {
  const store = load()
  const kept = store.scores.filter((s) => s.id !== id)
  if (kept.length === store.scores.length) throw new Error(`No score ${id}`)
  save({ ...store, scores: kept })
}

/** A recorded score by id, as it is (for a journal), or null. */
export const findScore = (id: string): CreditScore | null => load().scores.find((s) => s.id === id) ?? null

/** The score that a new one on the same day from the same place would replace, or null. */
export const scoreToReplace = (s: Pick<CreditScore, 'day' | 'bureau' | 'model' | 'source'>): CreditScore | null => load().scores.find((x) => x.day === s.day && scoreKey(x) === scoreKey(s)) ?? null

/** Puts a score back exactly as a journal recorded it, under its old id (an undo). */
export function restoreScore(s: CreditScore): void {
  const store = load()
  store.scores = [...store.scores.filter((x) => x.id !== s.id), s]
  save(store)
}

/** One bureau's report of one day as it is (for a journal), or null. */
export const findReport = (bureau: string, day: string): CreditReport | null => load().reports.find((r) => r.bureau.toLowerCase() === bureau.toLowerCase() && r.day === day) ?? null

/** Puts a bureau's report of a day back as a journal recorded it (null removes it). */
export function restoreReport(bureau: string, day: string, report: CreditReport | null): void {
  const store = load()
  store.reports = store.reports.filter((r) => !(r.bureau.toLowerCase() === bureau.toLowerCase() && r.day === day))
  if (report) store.reports.push(report)
  save(store)
}

/** A card's recorded limit as it is (for a journal), or null. */
export const findLimit = (accountId: string): { cents: number; source: string | null; asOf: string | null } | null => {
  const l = load().limits.find((x) => x.accountId === accountId)
  return l ? { cents: l.cents, source: l.source, asOf: l.asOf } : null
}

/** Every report file path on file. */
export const creditReportPaths = (): string[] => load().reports.flatMap((r) => (r.file ? [r.file] : []))

const KINDS: TradelineKind[] = ['revolving', 'installment', 'mortgage', 'open', 'collection', 'other']
const dollars = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100))
const monthish = (v: unknown): string | null => {
  const s = text(v)
  return s && MONTHISH.test(s) ? s : null
}

/** Stores one bureau's report (dollars in, cents kept); the same bureau and day replaces the earlier one. */
export function setReport(input: Record<string, unknown>): CreditReport {
  const b = bureau(input.bureau)
  if (!b) throw new Error('A report needs its bureau')
  const tradelines = (Array.isArray(input.tradelines) ? input.tradelines : []) as Array<Record<string, unknown>>
  const inquiries = (Array.isArray(input.inquiries) ? input.inquiries : []) as Array<Record<string, unknown>>
  const accountIds = new Set(db.listAccounts().map((a) => a.id))
  const file = text(input.file)
  if (file && !isLocalDocument(file)) throw new Error(`Not a document on this computer: ${file}`)
  const report: CreditReport = {
    bureau: b,
    day: day(input.day, 'The report date'),
    file,
    tradelines: tradelines.map(
      (t): CreditTradeline => ({
        creditor: text(t.creditor) ?? 'Unknown',
        last4: text(t.last4),
        kind: KINDS.includes(t.kind as TradelineKind) ? (t.kind as TradelineKind) : 'other',
        opened: monthish(t.opened),
        closed: monthish(t.closed),
        status: text(t.status) ?? '',
        limitCents: dollars(t.limit),
        balanceCents: dollars(t.balance),
        accountId: typeof t.account_id === 'string' && accountIds.has(t.account_id) ? t.account_id : null,
        late: (Array.isArray(t.late) ? t.late : []).map(String).filter(Boolean)
      })
    ),
    inquiries: inquiries.map((q) => ({ creditor: text(q.creditor) ?? 'Unknown', day: day(q.day, 'An inquiry date') })),
    negatives: (Array.isArray(input.negatives) ? input.negatives : []).map(String).filter(Boolean),
    note: text(input.note)
  }
  const store = load()
  store.reports = store.reports.filter((r) => !(r.bureau === report.bureau && r.day === report.day))
  store.reports.push(report)
  save(store)
  return report
}

/** A card's credit limit (cents); null clears it. */
export function setLimit(accountId: string, cents: number | null, source: string | null = null, asOf: string | null = null): void {
  if (!db.listAccounts().some((a) => a.id === accountId)) throw new Error(`No account ${accountId}`)
  if (cents !== null && (!Number.isInteger(cents) || cents <= 0)) throw new Error('A credit limit is a positive amount')
  const store = load()
  store.limits = store.limits.filter((l) => l.accountId !== accountId)
  if (cents !== null) store.limits.push({ accountId, cents, source: text(source), asOf: asOf ? day(asOf, 'The limit date') : null })
  save(store)
}

/** Points limits and report tradelines at the account another was merged into; the kept account's own limit wins. */
export function moveAccount(fromId: string, intoId: string): void {
  const store = load()
  const kept = store.limits.some((l) => l.accountId === intoId)
  store.limits = store.limits.flatMap((l) => (l.accountId !== fromId ? [l] : kept ? [] : [{ ...l, accountId: intoId }]))
  for (const r of store.reports) for (const t of r.tradelines) if (t.accountId === fromId) t.accountId = intoId
  save(store)
}

export interface AccountRefs {
  limit: Limit | null
  /** bureau, report day and position of each tradeline naming the account */
  lines: Array<[string, string, number]>
}

/** The limit and tradelines that name an account, as they are (for a journal). */
export function accountRefs(id: string): AccountRefs {
  const store = load()
  const lines: Array<[string, string, number]> = []
  for (const r of store.reports) r.tradelines.forEach((t, n) => t.accountId === id && lines.push([r.bureau, r.day, n]))
  return { limit: store.limits.find((l) => l.accountId === id) ?? null, lines }
}

/** Undoes moveAccount: the old account's limit and tradelines back, and the kept one's limit as it was. */
export function restoreAccountRefs(fromId: string, from: AccountRefs, intoId: string, intoLimit: Limit | null): void {
  const store = load()
  store.limits = [...store.limits.filter((l) => l.accountId !== fromId && l.accountId !== intoId), ...(from.limit ? [from.limit] : []), ...(intoLimit ? [intoLimit] : [])]
  for (const [b, d, n] of from.lines) {
    const t = store.reports.find((r) => r.bureau === b && r.day === d)?.tradelines[n]
    if (t?.accountId === intoId) t.accountId = fromId
  }
  save(store)
}

/** Whether a path is a report on file, so only those can be opened from the page. */
export function isCreditReportFile(file: string): boolean {
  return load().reports.some((r) => r.file === file)
}

const addMonths = (d: string, n: number): string => {
  const [y, m, dd] = d.split('-').map(Number)
  const [ty, tm] = dayFrom(y, m + n, 1).split('-').map(Number)
  return dayFrom(ty, tm, Math.min(dd || 1, daysInMonth(ty, tm)))
}
/** Closed: a closed date, or the bureau's words for it ("Paid, Closed", "Transferred", "Charge off"); "paid or paying as agreed" is an open account. */
export const isClosed = (t: CreditTradeline): boolean => !!t.closed || /\bclosed\b|transferred|charged?[- ]?off|paid off/i.test(t.status)

const monthsBetween = (from: string, to: string): number => {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}

// ---------- the monthly reminder ----------

const REMINDER = 'credit.reminder'
export const REMINDER_TITLE = 'Check credit score'

interface Reminder {
  /** day of the month, 1-31 */
  day: number
  /** the to-do on the calendar now */
  eventId: number | null
}

function readReminder(): Reminder | null {
  try {
    const r = JSON.parse(db.getSetting(REMINDER) ?? 'null') as Partial<Reminder> | null
    return r && Number.isInteger(r.day) ? { day: r.day!, eventId: typeof r.eventId === 'number' ? r.eventId : null } : null
  } catch {
    return null
  }
}

const writeReminder = (r: Reminder | null): void => db.setSetting(REMINDER, r ? JSON.stringify(r) : null)

/** The first date on or after `from` that falls on day `dom` of its month (the month's last day when it's shorter). */
export function nextReminderDay(from: string, dom: number): string {
  const [y, m] = from.split('-').map(Number)
  const on = (yy: number, mm: number): string => {
    const [ty, tm] = dayFrom(yy, mm, 1).split('-').map(Number)
    return dayFrom(ty, tm, Math.min(dom, daysInMonth(ty, tm)))
  }
  const here = on(y, m)
  return here >= from ? here : on(y, m + 1)
}

const nextDay = (d: string): string => addDays(d, 1)

const reminderEvent = (id: number | null): CalendarEvent | null => (id === null ? null : (db.listCalendarEvents('0000-01-01').find((e) => e.id === id) ?? null))

/**
 * Keeps one "Check credit score" to-do ahead on the calendar while the
 * reminder is on: once it's checked off the next month's is added; one left
 * unchecked past its day moves to the next. Returns whether anything changed.
 */
export function keepReminder(today = db.dayKey(db.now()), moved = false): boolean {
  const r = readReminder()
  if (!r) return false
  const e = reminderEvent(r.eventId)
  if (e && e.doneAt === null) {
    if (e.day >= today && !moved) return false
    const day = nextReminderDay(today, r.day)
    if (day === e.day) return false
    db.updateCalendarEvent(e.id, { day })
    return true
  }
  // Checked off (or deleted): the next one comes after its day.
  const from = e && e.day >= today ? nextDay(e.day) : today
  const id = db.addCalendarEvent({ day: nextReminderDay(from, r.day), title: REMINDER_TITLE, task: true, createdBy: 'user' })
  writeReminder({ day: r.day, eventId: id })
  return true
}

/** Turns the monthly to-do on for a day of the month, or off with null: the one waiting on the calendar goes (checked-off ones stay). */
export function setReminder(day: number | null, today = db.dayKey(db.now())): void {
  const had = readReminder()
  if (day === null) {
    const e = reminderEvent(had?.eventId ?? null)
    if (e && e.doneAt === null) db.deleteCalendarEvent(e.id)
    writeReminder(null)
    return
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('The reminder day is 1 to 31')
  writeReminder({ day, eventId: had?.eventId ?? null })
  keepReminder(today, !!had && had.day !== day)
}

export const reminderDay = (): number | null => readReminder()?.day ?? null

export function getCredit(): CreditView {
  const store = load()
  const today = db.dayKey(db.now())
  const accounts = db.listAccounts()
  const names = new Map(accounts.map((a) => [a.id, a.name]))

  const scores = [...store.scores].sort((a, b) => b.day.localeCompare(a.day) || a.id.localeCompare(b.id))
  const latest: CreditView['latest'] = []
  const seen = new Set<string>()
  for (const s of scores) {
    const k = scoreKey(s)
    if (seen.has(k)) continue
    seen.add(k)
    latest.push({ key: k, score: s, previous: scores.find((x) => x !== s && scoreKey(x) === k && x.day < s.day) ?? null })
  }

  // Open cards against their limits, from the balances the banks sync.
  const limits = new Map(store.limits.map((l) => [l.accountId, l]))
  const cards = accounts
    .filter((a) => a.assetType === 'credit_card' && !a.hidden && (!a.closedDay || a.closedDay > today))
    .map((a) => {
      const balanceCents = Math.max(0, -(a.balanceCents ?? 0))
      const l = limits.get(a.id) ?? null
      return { accountId: a.id, name: a.name, balanceCents, limitCents: l?.cents ?? null, pct: l ? balanceCents / l.cents : null, limitSource: l?.source ?? null, limitAsOf: l?.asOf ?? null }
    })
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.balanceCents - a.balanceCents)
  const limited = cards.filter((c) => c.limitCents !== null)
  const balanceCents = limited.reduce((t, c) => t + c.balanceCents, 0)
  const limitCents = limited.reduce((t, c) => t + (c.limitCents ?? 0), 0)

  // The newest report from each bureau.
  const newest = new Map<CreditBureau, CreditReport>()
  for (const r of [...store.reports].sort((a, b) => b.day.localeCompare(a.day))) if (!newest.has(r.bureau)) newest.set(r.bureau, r)
  const reports = [...newest.values()]

  // Age, from every account on the reports (closed ones still count), each once across bureaus.
  const opened = new Map<string, { name: string; day: string }>()
  for (const r of reports)
    for (const t of r.tradelines) {
      if (!t.opened || t.kind === 'collection') continue
      const k = `${t.creditor.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8)}|${t.last4 ?? ''}|${t.opened.slice(0, 7)}`
      if (!opened.has(k)) opened.set(k, { name: t.creditor, day: t.opened.length === 7 ? `${t.opened}-01` : t.opened })
    }
  if (!opened.size)
    for (const a of accounts) if ((a.assetType === 'credit_card' || a.assetType === 'loan' || a.assetType === 'mortgage') && a.openedDay) opened.set(a.id, { name: a.name, day: a.openedDay })
  const ages = [...opened.values()]
  const oldest = ages.length ? ages.reduce((o, x) => (x.day < o.day ? x : o)) : null
  const averageMonths = ages.length ? Math.round(ages.reduce((t, x) => t + monthsBetween(x.day, today), 0) / ages.length) : null

  // Hard inquiries stay two years; the same lender within a week counts once.
  const since = addMonths(today, -24)
  const inquiries: CreditView['inquiries'] = []
  for (const r of reports)
    for (const q of r.inquiries) {
      if (q.day < since) continue
      const same = inquiries.find((x) => x.creditor.toLowerCase().slice(0, 10) === q.creditor.toLowerCase().slice(0, 10) && Math.abs(new Date(x.day).getTime() - new Date(q.day).getTime()) <= 7 * 86_400_000)
      if (same) {
        if (!same.bureaus.includes(r.bureau)) same.bureaus.push(r.bureau)
      } else inquiries.push({ creditor: q.creditor, day: q.day, bureaus: [r.bureau], dropsOff: addMonths(q.day, 24) })
    }
  inquiries.sort((a, b) => b.day.localeCompare(a.day))

  const negatives = reports.flatMap((r) => [
    ...r.negatives.map((text) => ({ bureau: r.bureau, text })),
    ...r.tradelines.filter((t) => t.late.length).map((t) => ({ bureau: r.bureau, text: `${t.creditor}${t.last4 ? ` ${t.last4}` : ''}: late ${t.late.join(', ')}` }))
  ])

  return {
    scores,
    latest,
    utilization: { balanceCents, limitCents, pct: limitCents > 0 ? balanceCents / limitCents : null, cards },
    age: { oldest, averageMonths, accounts: ages.length },
    inquiries,
    negatives,
    reports: CREDIT_BUREAUS.map((b) => newest.get(b))
      .filter((r): r is CreditReport => !!r)
      .map((r) => ({
        bureau: r.bureau,
        day: r.day,
        file: r.file,
        found: !!r.file && fileFound(r.file),
        open: r.tradelines.filter((t) => !isClosed(t) && t.kind !== 'collection').length,
        closed: r.tradelines.filter(isClosed).length,
        inquiries: r.inquiries.length,
        negatives: r.negatives.length + r.tradelines.filter((t) => t.late.length).length,
        note: r.note,
        tradelines: [...r.tradelines]
          .sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || (b.opened ?? '').localeCompare(a.opened ?? ''))
          .map((t) => ({ ...t, accountName: t.accountId ? (names.get(t.accountId) ?? null) : null }))
      })),
    reminderDay: reminderDay()
  }
}
