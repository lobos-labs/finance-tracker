import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import Papa from 'papaparse'
import * as db from './db'
import { ledgerState } from './ledgerState'
import { parseAmount, parseDate, rowAmount } from '../shared/parse'
import { dateString } from '../shared/zone'
import type { CsvImportRequest, CsvMapping, CsvPreview } from '../shared/types'

// Bank CSV exports differ wildly. We find the header row, guess which columns
// hold the date / description / amount, and let the user confirm before import.

interface Parsed {
  fileName: string
  headers: string[]
  rows: string[][]
  /** when the file was picked; a preview nobody imported is dropped after a while */
  at: number
}

/** The largest export the app reads. */
export const MAX_BYTES = 50 * 1024 * 1024
/** A preview that hasn't been imported this long after it was picked is forgotten. */
export const PREVIEW_TTL_MS = 10 * 60_000

/** The previews waiting for their import, each ledger's own (ledgerState.ts). */
const pickedNow = ledgerState(() => new Map<string, Parsed>())

/** Whether this ledger holds a preview by that token (a restarted Ledger holds none until it reads the file again). */
export const hasPreview = (token: string): boolean => pickedNow().has(token)

/** A preview read again under the token and time it was first given (a hosted ledger that restarted in between). */
export interface KeptPreview {
  token: string
  at: number
}

function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => c.toLowerCase())
    if (cells.some((c) => c.includes('date')) && cells.some((c) => /amount|debit|credit|withdrawal|deposit/.test(c))) return i
  }
  return 0
}

function findCol(headers: string[], ...patterns: RegExp[]): number | null {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h.trim().toLowerCase()))
    if (i >= 0) return i
  }
  return null
}

function guessMapping(headers: string[], rows: string[][]): CsvMapping {
  const date = findCol(headers, /^(transaction |trans\.? )?date$/, /^post(ed|ing)? date$/, /date/) ?? 0
  const description = findCol(headers, /^description$/, /description/, /payee|merchant/, /^name$/, /memo|details/) ?? 1
  const amount = findCol(headers, /^amount$/, /amount/)
  const debit = amount === null ? findCol(headers, /debit|withdrawal/) : null
  const credit = amount === null ? findCol(headers, /credit|deposit/) : null
  const found = findCol(headers, /^(running |ledger |current )?balance$/, /balance/)
  const balance = found !== null && ![date, description, amount, debit, credit].includes(found) ? found : null

  // Most rows in a statement are purchases. If they're mostly positive, this
  // export (typical for credit cards) shows charges as positive numbers.
  let invertSign = false
  if (amount !== null) {
    const values = rows.slice(0, 200).map((r) => parseAmount(r[amount])).filter((v): v is number => v !== null && v !== 0)
    invertSign = values.length > 0 && values.filter((v) => v > 0).length / values.length > 0.7
  }
  return { date, description, amount, debit, credit, invertSign, balance }
}

/**
 * The closing balance of the latest day a file's balance column fills: the balance after that day's last row. Exports
 * list oldest or newest first, and some show a card's balance owed as a positive number, so the order and the sign are
 * the pair under which the most neighbouring rows add up (a balance is the one before it plus its row's amount); with
 * nothing to go by, the sign follows the amounts' (invertSign) and the order the dates. Null when no row has one.
 */
export function closingBalance(rows: string[][], m: CsvMapping, zone?: string): { day: string; cents: number } | null {
  if (m.balance === null || m.balance === undefined) return null
  const read: Array<{ posted: number; cents: number; balance: number }> = []
  for (const r of rows) {
    const posted = parseDate(r[m.date], zone)
    const cents = rowAmount(r, m)
    const balance = parseAmount(r[m.balance])
    if (posted !== null && cents !== null && balance !== null) read.push({ posted, cents, balance })
  }
  if (!read.length) return null
  const sign = m.invertSign ? -1 : 1
  const byDates = read[0].posted > read[read.length - 1].posted
  // The default first, so a tie (or nothing that adds up) keeps it.
  let best = { fits: 0, sign, newestFirst: byDates }
  for (const [s, newestFirst] of [[sign, byDates], [sign, !byDates], [-sign, byDates], [-sign, !byDates]] as Array<[number, boolean]>) {
    let fits = 0
    for (let i = 1; i < read.length; i++) {
      const [before, after] = newestFirst ? [read[i], read[i - 1]] : [read[i - 1], read[i]]
      if (s * after.balance === s * before.balance + after.cents) fits++
    }
    if (fits > best.fits) best = { fits, sign: s, newestFirst }
  }
  const day = read.reduce((d, r) => (db.dayKey(r.posted) > d ? db.dayKey(r.posted) : d), '')
  const onDay = read.filter((r) => db.dayKey(r.posted) === day)
  const last = best.newestFirst ? onDay[0] : onDay[onDay.length - 1]
  return { day, cents: best.sign * last.balance }
}

/** Whether a row can be imported under a mapping: a real date, some description, a readable amount within the cap. */
export const readable = (r: string[], m: CsvMapping): boolean => parseDate(r[m.date]) !== null && rowAmount(r, m) !== null && !!(r[m.description] ?? '').trim()

/** Drops previews nobody imported. */
function evict(): void {
  const cutoff = Date.now() - PREVIEW_TTL_MS
  const picked = pickedNow()
  for (const [token, p] of picked) if (p.at < cutoff) picked.delete(token)
}

export function preview(filePath: string): CsvPreview {
  evict()
  if (statSync(filePath).size > MAX_BYTES) throw new Error('That file is over 50 MB.')
  return previewText(basename(filePath), readFileSync(filePath, 'utf8'))
}

/** The same preview from a file's text (a hosted ledger's upload has no path); `kept` reads it again under its first token. */
export function previewText(fileName: string, raw: string, kept?: KeptPreview): CsvPreview {
  evict()
  if (raw.length > MAX_BYTES) throw new Error('That file is over 50 MB.')
  const text = raw.replace(/^﻿/, '')
  const all = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' }).data
  if (!all.length) throw new Error('That file is empty.')
  const h = findHeaderRow(all)
  const headers = all[h].map((c, i) => c.trim() || `Column ${i + 1}`)
  const rows = all.slice(h + 1).filter((r) => r.some((c) => c.trim()))
  const token = kept?.token ?? randomUUID()
  pickedNow().set(token, { fileName, headers, rows, at: kept?.at ?? Date.now() })
  const guess = guessMapping(headers, rows)
  return { token, fileName, headers, sample: rows.slice(0, 8), rowCount: rows.length, guess, unreadable: rows.filter((r) => !readable(r, guess)).length }
}

/** Rows an import added rather than the bank feed: CSV rows, and statement files' (statementImport.ts). */
export const IMPORTED_ROW = "(id LIKE '%:csv:%' OR id LIKE 'ofx:%' OR id LIKE 'qif:%')"

/**
 * Into a bank-synced account, an import only adds history from before the
 * bank's first synced day, so nothing is counted twice. `skip` says which
 * rows to leave out (call it once per row, in order); `cutoff` is that first
 * day's local midnight, or null when the account has no feed rows.
 */
export function feedGuard(accountId: string, merge = false): { cutoff: number | null; skip: (posted: number, cents: number) => boolean } {
  const source = db.get<{ source: string }>('SELECT source FROM accounts WHERE id = ?', accountId)?.source
  const syncedFrom = source === 'simplefin' || source === 'plaid' ? (db.get<{ p: number | null }>(`SELECT MIN(posted) AS p FROM transactions WHERE account_id = ? AND NOT ${IMPORTED_ROW}`, accountId)?.p ?? null) : null
  if (syncedFrom === null) return { cutoff: null, skip: () => false }
  const cutoff = db.dayStart(db.dayKey(syncedFrom))

  // The bank lists a charge by its posted date, which can be a few days after
  // the date in an export. A row is the feed's own if the feed has the same
  // amount within a few days (each feed row matches once).
  const WINDOW = 5 * 86_400
  const feed = db.all<{ posted: number; cents: number }>(`SELECT posted, amount_cents AS cents FROM transactions WHERE account_id = ? AND pending = 0 AND NOT ${IMPORTED_ROW}`, accountId).map((r) => ({ ...r, used: false }))
  const feedLast = feed.reduce((m, f) => Math.max(m, f.posted), 0)
  const inFeed = (posted: number, cents: number): boolean => {
    const f = feed.find((x) => !x.used && x.cents === cents && Math.abs(x.posted - posted) <= WINDOW)
    if (f) f.used = true
    return !!f
  }
  return {
    cutoff,
    skip: (posted, cents) => {
      // The feed covers these days. A merge adds only what the feed is
      // missing (a card's installment rows, say), up to the feed's latest day.
      if (posted >= cutoff) return !merge || posted > feedLast || inFeed(posted, cents)
      return posted >= cutoff - WINDOW && inFeed(posted, cents)
    }
  }
}

/** How far apart two imports may date the same row (a transaction date in one, the posted date in the other). */
const IMPORT_WINDOW_DAYS = 3

/**
 * Rows another kind of import already put in this account: a CSV's for a
 * statement file, a statement file's for a CSV (the ids never match). A row
 * with the same amount within a few days of one of them is that row; each
 * matches once. `own` is the id prefix of this kind of import, whose rows
 * are found by id instead. Call it once per row that isn't already here by id.
 */
export function importGuard(accountId: string, own: string): (posted: number, cents: number) => boolean {
  const rows = db
    .all<{ posted: number; cents: number }>(`SELECT posted, amount_cents AS cents FROM transactions WHERE account_id = ? AND ${IMPORTED_ROW} AND substr(id, 1, ?) != ?`, accountId, own.length, own)
    .map((r) => ({ ...r, used: false }))
  return (posted, cents) => {
    const r = rows.find((x) => !x.used && x.cents === cents && Math.abs(x.posted - posted) <= IMPORT_WINDOW_DAYS * 86_400)
    if (r) r.used = true
    return !!r
  }
}

export function importCsv(req: CsvImportRequest): { accountId: string; imported: number; skipped: number; invalid: number; balances: number } {
  const file = pickedNow().get(req.token)
  if (!file) throw new Error('Pick the file again — this import expired.')
  const m = req.mapping
  const cols = file.headers.length
  for (const c of [m.date, m.description, m.amount, m.debit, m.credit, m.balance ?? null]) {
    if (c !== null && (c < 0 || c >= cols)) throw new Error('Column mapping is out of range.')
  }
  if (m.amount === null && m.debit === null && m.credit === null) throw new Error('Choose an amount column (or debit/credit columns).')

  let accountId = req.accountId
  if (!accountId) {
    const name = req.newAccountName?.trim() || file.fileName.replace(/\.csv$/i, '')
    accountId = `csv:${randomUUID()}`
    db.upsertAccount({ id: accountId, source: 'csv', name, institution: 'Imported CSV', currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  }

  if (!db.listAccounts().some((a) => a.id === accountId)) throw new Error('That account no longer exists.')
  const guard = feedGuard(accountId, req.merge === true)
  const other = importGuard(accountId, `${accountId}:csv:`)

  let imported = 0
  let skipped = 0
  let invalid = 0
  let balances = 0
  // Identical rows on the same day are real (two coffees); number them so
  // re-importing the same or an overlapping file never duplicates.
  const occurrences = new Map<string, number>()
  const zone = db.zone()
  db.inTransaction(() => {
    for (const r of file.rows) {
      const posted = parseDate(r[m.date], zone)
      const amountCents = rowAmount(r, m)
      const description = (r[m.description] ?? '').trim()
      if (posted === null || amountCents === null || !description) {
        invalid++
        continue
      }
      if (guard.skip(posted, amountCents)) {
        skipped++
        continue
      }
      const base = `${dateString(db.dayKey(posted))}|${amountCents}|${description.toLowerCase()}`
      const n = (occurrences.get(base) ?? 0) + 1
      occurrences.set(base, n)
      const id = `${accountId}:csv:${createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 20)}`
      // Here already, from this kind of file or from a statement file of the same days.
      if (db.get('SELECT 1 AS x FROM transactions WHERE id = ?', id) || other(posted, amountCents)) {
        skipped++
        continue
      }
      if (db.insertTransactionIfNew({ id, accountId: accountId!, posted, amountCents, description, pending: false })) imported++
      else skipped++
    }
    // The balance column's closing balance, as a statement file's (statementImport.ts), unless the feed already knows that day.
    const closing = closingBalance(file.rows, m, zone)
    if (closing && (guard.cutoff === null || closing.day < db.dayKey(guard.cutoff)) && db.setStatementBalance(accountId!, closing.day, closing.cents, true)) balances++
  })
  pickedNow().delete(req.token)
  return { accountId, imported, skipped, invalid, balances }
}
