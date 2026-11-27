import type { CsvMapping } from './types'
import { defaultZone, isRealDay, noonIn } from './zone'

// Parsing helpers shared by the CSV importer (main) and its preview (renderer),
// so the preview shows exactly what will be imported.

/**
 * The largest amount the app stores, in cents (a hundred billion dollars).
 * Anything past 2^53 cents can't be read back exactly as a JavaScript number
 * (the SQLite driver, src/main/sqlite.ts, would round it); this cap stays far
 * below that, and every write checks it.
 */
export const MAX_CENTS = 10_000_000_000_000

/** Whether a value is an amount the app can store: a safe integer of cents within the cap. */
export const isCents = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= MAX_CENTS

/** A dollar amount from a feed (a number, or a number as text) as cents, or null when it isn't one the app can store. */
export function centsOf(amount: unknown): number | null {
  if (amount === undefined || amount === null || amount === '') return null
  if (typeof amount !== 'string' && typeof amount !== 'number') return null
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  const cents = Math.round(n * 100)
  return isCents(cents) ? cents : null
}

/** "$1,234.56", "(12.00)", "12.00 DR", "-5" -> integer cents; null when unreadable or past the cap. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null
  let s = raw.trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (/DR$/i.test(s)) negative = true
  s = s.replace(/(CR|DR)$/i, '').replace(/[$,\s]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (!/^\d*\.?\d+$/.test(s)) return null
  const cents = Math.round(Number(s) * 100) * (negative ? -1 : 1)
  return isCents(cents) ? cents : null
}

const MONTH_WORD = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i

/** Noon of a calendar date in `zone`, or null when the month or day doesn't exist (13/01, 02/30). */
function noon(year: number, month: number, day: number, zone: string): number | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return isRealDay(key) ? noonIn(key, zone) : null
}

/** ISO (2026-10-14) or US-style (10/14/2026, 10/14/26) dates -> Unix seconds at noon in `zone` (the default zone when left out); null for anything that isn't a real date. */
export function parseDate(raw: string | undefined, zone = defaultZone()): number | null {
  if (!raw) return null
  const s = raw.trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return noon(+m[1], +m[2], +m[3], zone)
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return noon(year, +m[1], +m[2], zone)
  }
  // Written-out dates ("Oct 14, 2026") go to the platform parser; bare numbers and codes don't.
  if (!MONTH_WORD.test(s)) return null
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return noon(d.getFullYear(), d.getMonth() + 1, d.getDate(), zone)
}

/** Signed cents for a CSV row under a mapping (negative = money out). */
export function rowAmount(r: string[], m: CsvMapping): number | null {
  let cents: number | null
  if (m.amount !== null) {
    cents = parseAmount(r[m.amount])
  } else {
    const out = m.debit !== null ? parseAmount(r[m.debit]) : null
    const inn = m.credit !== null ? parseAmount(r[m.credit]) : null
    if (out === null && inn === null) return null
    cents = (inn ? Math.abs(inn) : 0) - (out ? Math.abs(out) : 0)
  }
  if (cents === null) return null
  const signed = m.invertSign ? -cents : cents
  return isCents(signed) ? signed : null
}
