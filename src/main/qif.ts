import { parseAmount, parseDate } from '../shared/parse'
import { dayIn, defaultZone } from '../shared/zone'
import { describe, STATEMENTS_MAX, TOO_MANY_STATEMENTS, type ParsedFile, type ParsedStatement } from './ofx'

// QIF (Quicken Interchange Format), read only. A file is sections opened by
// !Type:Bank, !Type:Cash or !Type:CCard, each a run of records: one field per
// line keyed by its first letter (D date, T or U amount, P payee, M memo,
// N check number, L category), ended by ^. An !Account record before a
// section names it. Investment, category, class and memorized lists are
// skipped. Pure: no Electron, no database.

const DATE = /^(\d{1,2})\s*[/-]\s*(\d{1,2})\s*([/'-])\s*(\d{1,4})$/

/**
 * A QIF date as noon in `zone` (the default zone when left out): 10/15/2026, 10/15/26, 10/15'26 and Quicken's
 * space-padded 1/ 5' 5. An apostrophe means a year after 1999; a two-digit
 * year after a slash is this century unless that's more than a year ahead
 * (10/15/98 is 1998). ISO dates are read too. Month first: US only for now.
 */
export function qifDate(raw: string, thisYear = new Date().getFullYear(), zone = defaultZone()): number | null {
  const s = raw.trim()
  const m = s.match(DATE)
  if (!m) return parseDate(s, zone)
  if (m[4].length === 3) return null
  let year = +m[4]
  if (m[4].length <= 2) year = m[3] === "'" || 2000 + year <= thisYear + 1 ? 2000 + year : 1900 + year
  return parseDate(`${year}-${m[1]}-${m[2]}`, zone)
}

// Any amount the app can store fits in 40 characters; a longer one isn't worth reading.
const amountOf = (v: string | undefined): number | null => (v === undefined || v.length > 40 ? null : parseAmount(v))

interface Section {
  stmt: ParsedStatement
  /** Quicken's first record: the balance the register started from, as [posted, cents] */
  opening: [number, number] | null
}

/** Ends a section: an opening balance (when the account record gave none) becomes the balance at the end of its day. An empty one is left out. */
function endSection(sec: Section | null, out: ParsedStatement[], zone: string): void {
  if (!sec) return
  const s = sec.stmt
  if (sec.opening && s.balanceCents === null) {
    const [posted, cents] = sec.opening
    const total = cents + s.rows.filter((r) => r.posted === posted).reduce((sum, r) => sum + r.amountCents, 0)
    if (Number.isSafeInteger(total)) {
      s.balanceCents = total
      s.balanceDay = dayIn(posted, zone)
    }
  }
  if (!s.rows.length && !s.invalid && s.balanceCents === null) return
  if (out.length >= STATEMENTS_MAX) throw new Error(TOO_MANY_STATEMENTS)
  out.push(s)
}

/** The bank and card registers in a QIF file, dated noon in `zone` (the default zone when left out). Throws a one-line message when the text has no QIF header. */
export function parseQif(text: string, zone = defaultZone()): ParsedFile {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  if (!lines.some((l) => /^!(type|account|option|clear)\b/i.test(l.trim()))) throw new Error('Not a QIF file.')
  const thisYear = Number(dayIn(Date.now() / 1000, zone).slice(0, 4))
  // Any date the app can store fits in 40 characters; a longer one isn't worth reading.
  const dateOf = (v: string | undefined): number | null => (v === undefined || v.length > 40 ? null : qifDate(v, thisYear, zone))

  const statements: ParsedStatement[] = []
  let mode: 'none' | 'account' | 'txn' | 'skip' = 'none'
  let section: Section | null = null
  /** the last !Account record: it names the next section */
  let named: Record<string, string> | null = null
  let rec: Record<string, string> = {}

  const endRecord = (): void => {
    const r = rec
    rec = {}
    if (mode === 'account') {
      if (r['N'] !== undefined || r['T'] !== undefined) named = r
      return
    }
    if (mode !== 'txn' || !section || !Object.keys(r).length) return
    const s = section.stmt
    const posted = dateOf(r['D'])
    const amountCents = amountOf(r['T'] ?? r['U'])
    if (posted === null || amountCents === null) {
      s.invalid++
      return
    }
    // Quicken starts a register with its balance, filed against the account itself: a balance, not a transaction.
    if (/^opening balance$/i.test(r['P'] ?? '') && /^\[.*\]$/.test(r['L'] ?? '')) {
      section.opening ??= [posted, amountCents]
      return
    }
    s.rows.push({ posted, amountCents, description: describe(r['P'], r['M'], r['N']), fitId: null, type: null })
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line[0] === '!') {
      if (Object.keys(rec).length) endRecord()
      endSection(section, statements, zone)
      section = null
      const header = line.slice(1).toLowerCase().replace(/\s+/g, ' ')
      const type = header.startsWith('type:') ? header.slice(5).trim() : null
      if (header === 'account') mode = 'account'
      else if (type === 'bank' || type === 'cash' || type === 'ccard') {
        mode = 'txn'
        const acct: Record<string, string> = named ?? {}
        const balanceDay = dateOf(acct['/'])
        const balanceCents = amountOf(acct['$'])
        const balanced = balanceDay !== null && balanceCents !== null
        section = {
          stmt: {
            kind: type === 'ccard' ? 'card' : 'bank',
            bankId: null,
            last4: null,
            label: (acct['N'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null,
            balanceCents: balanced ? balanceCents : null,
            balanceDay: balanced ? dayIn(balanceDay, zone) : null,
            rows: [],
            invalid: 0
          },
          opening: null
        }
        named = null
      } else mode = type === null ? 'none' : 'skip'
      continue
    }
    if (line === '^') {
      endRecord()
      continue
    }
    if (mode === 'none' || mode === 'skip') continue
    // The first of each field counts; split lines (S, E, $) and addresses (A) repeat and are left out of a transaction.
    const code = line[0].toUpperCase()
    if ((mode === 'account' ? 'NTD$/' : 'DTUPMNL').includes(code)) rec[code] ??= line.slice(1).trim().slice(0, 1000)
  }
  // A last record without its ^.
  if (Object.keys(rec).length) endRecord()
  endSection(section, statements, zone)
  return { format: 'qif', institution: null, statements }
}
