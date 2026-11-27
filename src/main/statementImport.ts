import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import * as db from './db'
import { feedGuard, importGuard, PREVIEW_TTL_MS, type KeptPreview } from './csvImport'
import { ledgerState } from './ledgerState'
import { decodeText, looksInverted, parseOfx, type ParsedFile, type ParsedStatement } from './ofx'
import { parseQif } from './qif'
import type { StatementImportRequest, StatementImportResult, StatementPreview } from '../shared/types'

// QFX, OFX and QIF files, next to CSV: read on pick, shown as a preview (one
// entry per account in the file), imported into the accounts the user picks.
// A row's id is ofx:<account>:<key> (qif: for QIF), keyed by the bank's FITID
// when the file has one and by day, amount and description when it doesn't,
// so importing the same file again adds nothing. Into a bank-synced account,
// the CSV rule holds (feedGuard); a row another kind of import already added
// (a CSV's) is skipped too (importGuard). A closing balance becomes a balance
// point.

export const STATEMENT_TYPES = ['qfx', 'ofx', 'qif']
/** The largest statement file the app reads. */
export const MAX_BYTES = 20 * 1024 * 1024
/** Which account each file account went into last time: `<format>:<kind>:<bank>:<bank id>:<last 4 or name>` → account id. */
const MATCHES = 'import.statementAccounts'
const MATCHES_MAX = 200

interface Picked {
  fileName: string
  /** QFX, OFX or QIF, from the file's name */
  format: string
  file: ParsedFile
  at: number
}

/** The previews waiting for their import, each ledger's own (ledgerState.ts). */
const pickedNow = ledgerState(() => new Map<string, Picked>())

/** Whether this ledger holds a preview by that token. */
export const hasPreview = (token: string): boolean => pickedNow().has(token)

export const isStatementFile = (path: string): boolean => STATEMENT_TYPES.includes(extname(path).slice(1).toLowerCase())

/** Reads and parses a statement file; throws a one-line message when it can't. */
export function readStatement(path: string): ParsedFile {
  if (statSync(path).size > MAX_BYTES) throw new Error('That file is over 20 MB.')
  return parseStatement(path, readFileSync(path))
}

/** Parses a statement file's bytes; `name` is its file name (or path), which breaks a tie between QIF and OFX. */
function parseStatement(name: string, bytes: Uint8Array): ParsedFile {
  if (bytes.length > MAX_BYTES) throw new Error('That file is over 20 MB.')
  const text = decodeText(bytes)
  if (!text.trim()) throw new Error('That file is empty.')
  // The content decides: a .qfx that holds QIF, or the reverse, still reads.
  const zone = db.zone()
  const file = /<OFX\s*>/i.test(text) ? parseOfx(text, zone) : /^\s*!/.test(text) ? parseQif(text, zone) : extname(name).toLowerCase() === '.qif' ? parseQif(text, zone) : parseOfx(text, zone)
  if (!file.statements.length) throw new Error('No bank or card statement in this file.')
  return file
}

/** Drops previews nobody imported. */
function evict(): void {
  const cutoff = Date.now() - PREVIEW_TTL_MS
  const picked = pickedNow()
  for (const [token, p] of picked) if (p.at < cutoff) picked.delete(token)
}

// The bank's name too: a card statement has no bank id, and two issuers' cards can end in the same 4.
const matchKey = (file: ParsedFile, s: ParsedStatement): string | null => {
  const which = s.last4 ?? s.label?.toLowerCase()
  return which ? `${file.format}:${s.kind}:${file.institution?.toLowerCase() ?? ''}:${s.bankId ?? ''}:${which}` : null
}

function matches(): Record<string, string> {
  try {
    const m = JSON.parse(db.getSetting(MATCHES) ?? '{}') as unknown
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function suggestedName(p: { fileName: string; file: ParsedFile }, s: ParsedStatement): string {
  const stem = p.fileName.replace(/\.(qfx|ofx|qif)$/i, '')
  const label = s.label && s.label !== p.file.institution ? s.label : null
  return [p.file.institution ?? (label ? null : stem), label, s.last4 && `····${s.last4}`].filter(Boolean).join(' ').slice(0, db.MERCHANT_MAX) || stem
}

export function preview(filePath: string): StatementPreview {
  evict()
  return previewParsed(basename(filePath), readStatement(filePath))
}

/** The same preview from a file's bytes (a hosted ledger's upload has no path); `kept` reads it again under its first token. */
export function previewBytes(fileName: string, bytes: Uint8Array, kept?: KeptPreview): StatementPreview {
  evict()
  return previewParsed(fileName, parseStatement(fileName, bytes), kept)
}

function previewParsed(fileName: string, file: ParsedFile, kept?: KeptPreview): StatementPreview {
  const token = kept?.token ?? randomUUID()
  const p: Picked = { fileName, format: extname(fileName).slice(1).toUpperCase() || file.format.toUpperCase(), file, at: kept?.at ?? Date.now() }
  pickedNow().set(token, p)
  const known = matches()
  const ids = new Set(db.listAccounts().filter((a) => a.source !== 'manual').map((a) => a.id))
  return {
    kind: 'statement',
    token,
    fileName,
    format: p.format,
    institution: file.institution,
    accounts: file.statements.map((s) => {
      const key = matchKey(file, s)
      const match = key ? known[key] : undefined
      return {
        kind: s.kind,
        last4: s.last4,
        label: s.label,
        rowCount: s.rows.length,
        from: s.rows.length ? s.rows.reduce((m, r) => Math.min(m, r.posted), Infinity) : null,
        to: s.rows.length ? s.rows.reduce((m, r) => Math.max(m, r.posted), 0) : null,
        balanceCents: s.balanceCents,
        balanceDay: s.balanceDay,
        unreadable: s.invalid,
        invertSign: looksInverted(s),
        matchId: match && ids.has(match) ? match : null,
        suggestedName: suggestedName(p, s),
        sample: s.rows.slice(0, 8).map((r) => ({ posted: r.posted, description: r.description, amountCents: r.amountCents }))
      }
    })
  }
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 20)

export function importStatement(req: StatementImportRequest): Omit<StatementImportResult, 'classified'> {
  const p = pickedNow().get(String(req?.token))
  if (!p) throw new Error('Pick the file again — this import expired.')
  const statements = p.file.statements
  const targets = Array.isArray(req.targets) ? req.targets : []
  if (targets.length !== statements.length) throw new Error('Choose an account for each statement.')
  const accounts = db.listAccounts()
  for (const t of targets) {
    if (!t?.accountId) continue
    const a = accounts.find((x) => x.id === t.accountId)
    if (!a) throw new Error('That account no longer exists.')
    if (a.source === 'manual') throw new Error('Choose a bank or imported account.')
  }
  const prefix = p.file.format === 'qif' ? 'qif' : 'ofx'
  const known = matches()
  const out = { accountIds: [] as string[], imported: 0, skipped: 0, invalid: 0, balances: 0 }
  // Row keys taken so far, by account: two statements of one file put in the same account number their repeats.
  const taken = new Map<string, Map<string, number>>()
  db.inTransaction(() => {
    statements.forEach((s, i) => {
      const t = targets[i]
      if (!t) return
      let accountId = t.accountId
      if (!accountId) {
        accountId = `csv:${randomUUID()}`
        const name = db.cleanText(String(t.newAccountName ?? ''), db.MERCHANT_MAX) || suggestedName(p, s)
        db.upsertAccount({ id: accountId, source: 'csv', name, institution: p.file.institution ?? `Imported ${p.format}`, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
        // The statement says what it is; a name guess would make "Savings & Loan" a loan.
        db.updateAccount(accountId, { assetType: s.kind === 'card' ? 'credit_card' : s.label === 'Credit line' ? 'loan' : 'cash' })
      }
      out.accountIds.push(accountId)
      out.invalid += s.invalid
      const flip = t.invertSign === true
      const guard = feedGuard(accountId, req.merge === true)
      const other = importGuard(accountId, `${prefix}:${accountId}:`)
      // A FITID names one row at the bank; a bank that repeats one in a file
      // gets the repeats numbered. Without FITIDs, identical rows on a day are
      // real (two coffees) and numbered too. The file's own sign goes into
      // the key, so flipping on a second import still finds the first. The
      // account number isn't in the key: a replacement card keeps the FITIDs.
      const seen = taken.get(accountId) ?? new Map<string, number>()
      taken.set(accountId, seen)
      const nth = (k: string): number => {
        const n = (seen.get(k) ?? 0) + 1
        seen.set(k, n)
        return n
      }
      for (const r of s.rows) {
        const cents = flip ? -r.amountCents : r.amountCents
        if (guard.skip(r.posted, cents)) {
          out.skipped++
          continue
        }
        let key: string
        // Keyed with the last 4 before (the first build of this import): a row imported then is still found.
        let was: string | null = null
        if (r.fitId) {
          const n = nth(`f|${r.fitId}`)
          const at = (base: string): string => `f${sha1(n === 1 ? base : `${base}|${n}`)}`
          key = at(`${s.kind}|${r.fitId}`)
          was = at(`${s.kind}|${s.last4 ?? ''}|${r.fitId}`)
        } else {
          const base = `${db.dayKey(r.posted)}|${r.amountCents}|${r.description.toLowerCase()}`
          key = `h${sha1(`${base}|${nth(`h|${base}`)}`)}`
        }
        const id = `${prefix}:${accountId}:${key}`
        // Already here from this kind of file, or from another import (a CSV of the same days).
        if (db.get('SELECT 1 AS x FROM transactions WHERE id IN (?, ?)', id, was ? `${prefix}:${accountId}:${was}` : id) || other(r.posted, cents)) {
          out.skipped++
          continue
        }
        if (db.insertTransactionIfNew({ id, accountId, posted: r.posted, amountCents: cents, description: r.description, pending: false })) out.imported++
        else out.skipped++
      }
      // The closing balance, unless the feed already knows that day.
      if (s.balanceCents !== null && s.balanceDay && (guard.cutoff === null || s.balanceDay < db.dayKey(guard.cutoff))) {
        const last = s.rows.reduce((m, r) => Math.max(m, r.posted), 0)
        if (db.setStatementBalance(accountId, s.balanceDay, flip ? -s.balanceCents : s.balanceCents, !last || s.balanceDay >= db.dayKey(last))) out.balances++
      }
      const key = matchKey(p.file, s)
      if (key) {
        delete known[key]
        known[key] = accountId
      }
    })
    const keys = Object.keys(known)
    for (const k of keys.slice(0, Math.max(0, keys.length - MATCHES_MAX))) delete known[k]
    db.setSetting(MATCHES, JSON.stringify(known))
  })
  pickedNow().delete(req.token)
  return out
}
