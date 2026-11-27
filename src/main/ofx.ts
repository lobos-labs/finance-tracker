import { parseAmount, parseDate } from '../shared/parse'
import { defaultZone } from '../shared/zone'

// QFX/OFX statement files: what banks export for Quicken (Web Connect) and
// what most still offer next to CSV. OFX 1.x is SGML: KEY:VALUE header lines,
// then tags, with leaf elements left unclosed (<NAME>Blue Bottle). OFX 2.x is
// XML. One pass over the tags reads both: it keeps the path of open
// aggregates, and a tag followed by text is a leaf. A tag followed by another
// tag is an aggregate when OFX names it one or the file closes it somewhere,
// and an empty leaf otherwise (SGML's <MEMO> with nothing after it). Pure: no
// Electron, no database. qif.ts produces the same shapes.

/** One transaction as a statement file lists it. */
export interface StatementRow {
  /** noon of the day as written, in the ledger's zone */
  posted: number
  /** signed cents as the file has them (negative = money out, from the holder's view) */
  amountCents: number
  description: string
  /** the bank's own id for the row (OFX FITID); null in QIF */
  fitId: string | null
  /** OFX TRNTYPE (DEBIT, CHECK…), uppercased */
  type: string | null
}

export interface ParsedStatement {
  kind: 'bank' | 'card'
  /** the routing number (BANKID), when the file has one */
  bankId: string | null
  /** the account number's last 4; the rest is never kept */
  last4: string | null
  /** Checking, Savings, Credit card, or a QIF account's name */
  label: string | null
  /** the closing balance (OFX LEDGERBAL) as signed cents, and its day (YYYY-MM-DD) */
  balanceCents: number | null
  balanceDay: string | null
  rows: StatementRow[]
  /** rows with no readable date or amount, or in another currency */
  invalid: number
}

export interface ParsedFile {
  format: 'ofx' | 'qif'
  /** the bank's name (OFX FI ORG) */
  institution: string | null
  statements: ParsedStatement[]
}

/** Aggregates nested deeper than this aren't a statement; a file built to exhaust the parser stops here. */
const MAX_DEPTH = 40
/** Text kept from one value: descriptions are stored at 300 characters anyway. */
const VALUE_MAX = 1000
/** Statements one file may hold (a household's accounts at one bank); a file past it is refused. */
export const STATEMENTS_MAX = 50
export const TOO_MANY_STATEMENTS = 'That file holds too many statements.'

// The OFX aggregates a bank or card statement file has. Any other tag is an
// aggregate only when the file closes it; the leaves the parser reads never are.
const AGGREGATES = new Set(
  'OFX SIGNONMSGSRSV1 SONRS STATUS FI BANKMSGSRSV1 CREDITCARDMSGSRSV1 INVSTMTMSGSRSV1 STMTTRNRS CCSTMTTRNRS INVSTMTTRNRS STMTRS CCSTMTRS INVSTMTRS BANKACCTFROM CCACCTFROM BANKACCTTO CCACCTTO BANKTRANLIST STMTTRN PAYEE CURRENCY ORIGCURRENCY LEDGERBAL AVAILBAL BALLIST BAL MKTGINFO'.split(' ')
)
const LEAVES = new Set(
  'TRNTYPE DTPOSTED DTUSER DTAVAIL TRNAMT FITID CORRECTFITID CORRECTACTION SRVRTID CHECKNUM REFNUM SIC PAYEEID NAME EXTDNAME MEMO CURSYM CURRATE CURDEF BANKID BRANCHID ACCTID ACCTTYPE ACCTKEY BALAMT DTASOF DTSTART DTEND ORG FID CODE SEVERITY MESSAGE DTSERVER LANGUAGE TRNUID'.split(' ')
)

/** Text from a file's bytes: UTF-8 when it is valid UTF-8, else Windows-1252 (OFX 1.x's CHARSET:1252). */
export function decodeText(buf: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
  } catch {
    try {
      text = new TextDecoder('windows-1252').decode(buf)
    } catch {
      text = Buffer.from(buf).toString('latin1')
    }
  }
  return text.replace(/^﻿/, '')
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** &amp; &lt; &#38; &#x26; and the like; a number that isn't a character is dropped. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : ''
  })
}

/** Runs of whitespace collapsed, cut at `max`. */
const tidy = (s: string | undefined, max = VALUE_MAX): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

const DT = /^(\d{4})(\d{2})(\d{2})(?:\d{2}(?:\d{2}(?:\d{2}(?:[.,]\d{1,6})?)?)?)?\s*(?:\[[^\]]{0,24}\])?$/

/**
 * An OFX date (20261015, 20261015120000.000[-5:EST]) as the day it names,
 * YYYY-MM-DD. The day is taken as written: a bank's posting date is a
 * calendar day where the bank is, and shifting it by the offset would move a
 * late-evening row into the next day.
 */
export function ofxDay(raw: string | undefined): string | null {
  const m = raw?.trim().match(DT)
  if (!m) return null
  const day = `${m[1]}-${m[2]}-${m[3]}`
  return parseDate(day) === null ? null : day
}

/**
 * An OFX amount (-12.34, +5, 1234.5, or -12,34 with the decimal comma OFX allows) as cents; null when
 * unreadable or past the cap. A comma before three digits (-1,234) is a thousands separator, which OFX
 * doesn't allow, so the row is unreadable rather than $1.23.
 */
export function ofxAmount(raw: string | undefined): number | null {
  let s = (raw ?? '').trim()
  // Any amount the app can store fits in 40 characters; a longer one isn't worth reading.
  if (s.length > 40) return null
  if (/^[+-]?\d*,\d{1,2}$/.test(s)) s = s.replace(',', '.')
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null
  return parseAmount(s.replace(/^\+/, '').replace(/\.$/, ''))
}

/** A description from a payee and a memo: the longer when one holds the other, else both; a check number when it adds one. */
export function describe(name: string | undefined, memo: string | undefined, checkNum?: string): string {
  const n = tidy(name, 300)
  const m = tidy(memo, 300)
  let d = !n ? m : !m || n.toLowerCase().includes(m.toLowerCase()) ? n : m.toLowerCase().includes(n.toLowerCase()) ? m : `${n} ${m}`
  const check = tidy(checkNum, 20)
  if (/^\d+$/.test(check) && !d.includes(check)) d = d ? `${d} #${check}` : `Check ${check}`
  return d.slice(0, 300)
}

const TYPE_LABEL: Record<string, string> = {
  CREDIT: 'Credit',
  DEBIT: 'Debit',
  INT: 'Interest',
  DIV: 'Dividend',
  FEE: 'Fee',
  SRVCHG: 'Service charge',
  DEP: 'Deposit',
  ATM: 'ATM',
  POS: 'Point of sale',
  XFER: 'Transfer',
  CHECK: 'Check',
  PAYMENT: 'Payment',
  CASH: 'Cash withdrawal',
  DIRECTDEP: 'Direct deposit',
  DIRECTDEBIT: 'Direct debit',
  REPEATPMT: 'Repeating payment',
  HOLD: 'Hold',
  OTHER: 'Other'
}

const ACCOUNT_LABEL: Record<string, string> = { CHECKING: 'Checking', SAVINGS: 'Savings', MONEYMRKT: 'Money market', CREDITLINE: 'Credit line', CD: 'CD' }

/** The last 4 letters and digits of an account number; null when it has none. */
export const lastFour = (acct: string | undefined): string | null => (acct ?? '').replace(/[^0-9A-Za-z]/g, '').slice(-4) || null

type Token = { tag: string; close: boolean; self: boolean } | { text: string }

const TAG = /<(\/?)([A-Za-z][\w.]*)\s*(\/?)>/y

/**
 * Tags and text, in one forward pass: comments, CDATA, declarations and
 * processing instructions are skipped (CDATA is text), and a "<" that starts
 * none of them is a stray character. Every search moves forward, so a file
 * built from unclosed comments or a sea of "<" stays linear.
 */
function* tokens(body: string): Generator<Token> {
  const n = body.length
  let gt = -1
  const nextGt = (from: number): number => {
    if (gt < from) {
      const g = body.indexOf('>', from)
      gt = g < 0 ? n : g
    }
    return gt
  }
  const text = function* (from: number, to: number): Generator<Token> {
    const t = to > from ? decodeEntities(body.slice(from, to)).trim() : ''
    if (t) yield { text: t }
  }
  let i = 0
  while (i < n) {
    const lt = body.indexOf('<', i)
    if (lt < 0) {
      yield* text(i, n)
      return
    }
    yield* text(i, lt)
    if (body.startsWith('<!--', lt)) {
      const c = body.indexOf('-->', lt + 4)
      i = c < 0 ? n : c + 3
    } else if (body.startsWith('<![CDATA[', lt)) {
      const c = body.indexOf(']]>', lt + 9)
      yield* text(lt + 9, c < 0 ? n : c)
      i = c < 0 ? n : c + 3
    } else if (body[lt + 1] === '?' || body[lt + 1] === '!') {
      i = nextGt(lt + 1) + 1
    } else {
      TAG.lastIndex = lt
      const m = TAG.exec(body)
      if (m) {
        yield { tag: m[2].toUpperCase(), close: m[1] === '/', self: m[3] === '/' }
        i = TAG.lastIndex
      } else i = lt + 1
    }
  }
}

interface Txn {
  [field: string]: string | undefined
}

interface Statement {
  tag: 'STMTRS' | 'CCSTMTRS'
  fields: Record<string, string>
  rows: StatementRow[]
  invalid: number
}

/** A currency code fit for a one-line message. */
const currencyCode = (raw: string): string => raw.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'another currency'

/**
 * The bank and card statements in an OFX or QFX file. Throws a one-line
 * message when the text isn't OFX, nests absurdly, or a statement isn't in
 * US dollars (the app is US-only for now). Investment statements are left
 * out. Rows are dated noon in `zone` (the default zone when left out).
 */
export function parseOfx(text: string, zone = defaultZone()): ParsedFile {
  const start = text.search(/<OFX\s*>/i)
  if (start < 0) throw new Error('Not an OFX or QFX file.')
  const it = tokens(text.slice(start))
  let ahead: Token | undefined
  const next = (): Token | undefined => {
    if (ahead) {
      const t = ahead
      ahead = undefined
      return t
    }
    const r = it.next()
    return r.done ? undefined : r.value
  }
  const peek = (): Token | undefined => (ahead ??= next())

  const statements: ParsedStatement[] = []
  const stack: string[] = []
  // Tags the file closes somewhere: in SGML only aggregates are closed.
  const closed = new Set<string>()
  for (const m of text.slice(start).matchAll(/<\/([A-Za-z][\w.]*)\s*>/g)) closed.add(m[1].toUpperCase())
  const aggregate = (tag: string): boolean => !LEAVES.has(tag) && (AGGREGATES.has(tag) || closed.has(tag))
  let institution: string | null = null
  let stmt: Statement | null = null
  let txn: Txn | null = null

  const open = (tag: string): void => {
    if ((tag === 'STMTRS' || tag === 'CCSTMTRS') && !stmt) stmt = { tag, fields: {}, rows: [], invalid: 0 }
    else if (tag === 'STMTTRN' && stmt && !txn) txn = {}
  }

  const endTxn = (s: Statement, t: Txn): void => {
    const day = ofxDay(t['DTPOSTED']) ?? ofxDay(t['DTUSER'])
    const posted = day === null ? null : parseDate(day, zone)
    const amountCents = ofxAmount(t['TRNAMT'])
    // A row in another currency carries its amount in that currency.
    const foreign = t['CURSYM'] !== undefined && t['CURSYM'].toUpperCase() !== 'USD'
    if (posted === null || amountCents === null || foreign) {
      s.invalid++
      return
    }
    const type = tidy(t['TRNTYPE'], 20).toUpperCase() || null
    const description = describe(t['NAME'] || t['PAYEE.NAME'], t['MEMO'], t['CHECKNUM']) || (type && TYPE_LABEL[type]) || type || ''
    s.rows.push({ posted, amountCents, description, fitId: tidy(t['FITID'], 255) || null, type })
  }

  const endStatement = (s: Statement): void => {
    const f = s.fields
    const cur = f['CURDEF']
    if (cur && cur.trim().toUpperCase() !== 'USD') throw new Error(`This file is in ${currencyCode(cur)}; only US dollars can be imported.`)
    const kind = s.tag === 'CCSTMTRS' ? 'card' : 'bank'
    const balanceCents = ofxAmount(f['BALAMT'])
    const balanceDay = ofxDay(f['DTASOF'])
    const bankId = (f['BANKID'] ?? '').replace(/[^0-9A-Za-z]/g, '').slice(0, 20) || null
    const acctType = tidy(f['ACCTTYPE'], 20).toUpperCase()
    // A statement with nothing in it (no rows, no balance) is left out; a file of thousands of them is refused.
    if (!s.rows.length && !s.invalid && (balanceCents === null || !balanceDay)) return
    if (statements.length >= STATEMENTS_MAX) throw new Error(TOO_MANY_STATEMENTS)
    statements.push({
      kind,
      bankId,
      last4: lastFour(f['ACCTID']),
      label: kind === 'card' ? 'Credit card' : (ACCOUNT_LABEL[acctType] ?? (acctType ? acctType[0] + acctType.slice(1).toLowerCase() : null)),
      balanceCents: balanceCents !== null && balanceDay ? balanceCents : null,
      balanceDay: balanceCents !== null && balanceDay ? balanceDay : null,
      rows: s.rows,
      invalid: s.invalid
    })
  }

  const close = (tag: string): void => {
    if (tag === 'STMTTRN' && txn && stmt) {
      endTxn(stmt, txn)
      txn = null
    } else if (stmt && tag === stmt.tag) {
      endStatement(stmt)
      stmt = null
    }
  }

  const leaf = (tag: string, value: string): void => {
    const parent = stack[stack.length - 1]
    if (txn && stack.includes('STMTTRN')) {
      if (parent === 'STMTTRN') txn[tag] ??= value
      else if (parent === 'PAYEE' && tag === 'NAME') txn['PAYEE.NAME'] ??= value
      else if (parent === 'CURRENCY' && tag === 'CURSYM') txn['CURSYM'] ??= value
    } else if (stmt) {
      if (parent === stmt.tag && tag === 'CURDEF') stmt.fields['CURDEF'] ??= value
      else if ((parent === 'BANKACCTFROM' || parent === 'CCACCTFROM') && (tag === 'ACCTID' || tag === 'BANKID' || tag === 'ACCTTYPE')) stmt.fields[tag] ??= value
      else if (parent === 'LEDGERBAL' && (tag === 'BALAMT' || tag === 'DTASOF')) stmt.fields[tag] ??= value
    } else if (parent === 'FI' && tag === 'ORG' && institution === null) institution = tidy(value, 120) || null
  }

  for (let t = next(); t; t = next()) {
    if ('text' in t) continue
    if (t.close) {
      const i = stack.lastIndexOf(t.tag)
      if (i >= 0) while (stack.length > i) close(stack.pop()!)
      continue
    }
    if (t.self) {
      leaf(t.tag, '')
      continue
    }
    const n = peek()
    if (n && 'text' in n) {
      // A leaf: its text, then (in XML) its closing tag.
      next()
      const after = peek()
      if (after && !('text' in after) && after.close && after.tag === t.tag) next()
      leaf(t.tag, n.text.slice(0, VALUE_MAX))
      continue
    }
    if (n && !('text' in n) && n.close && n.tag === t.tag) {
      next()
      leaf(t.tag, '')
      continue
    }
    if (!aggregate(t.tag)) {
      // An empty SGML leaf: the next tag is its sibling, not its child.
      leaf(t.tag, '')
      continue
    }
    if (stack.length >= MAX_DEPTH) throw new Error('That file nests too deeply to be a statement.')
    stack.push(t.tag)
    open(t.tag)
  }
  while (stack.length) close(stack.pop()!)
  return { format: 'ofx', institution, statements }
}

// TRNTYPEs whose sign the spec fixes. INT, ATM, POS, XFER and PAYMENT go
// either way, so they say nothing.
const OUT_TYPES = new Set(['DEBIT', 'CHECK', 'FEE', 'SRVCHG', 'DIRECTDEBIT'])
const IN_TYPES = new Set(['CREDIT', 'DEP', 'DIRECTDEP', 'DIV'])

/**
 * Whether a statement's signs look backwards. OFX signs amounts from the
 * holder's view (a card purchase is negative), and most banks follow it; a
 * file whose typed rows mostly contradict their type has them reversed. A
 * card with no typed rows to go by (QIF, or all POS) is reversed when most
 * rows are positive, since purchases outnumber payments.
 */
export function looksInverted(s: ParsedStatement): boolean {
  let agree = 0
  let disagree = 0
  for (const r of s.rows) {
    const want = OUT_TYPES.has(r.type ?? '') ? -1 : IN_TYPES.has(r.type ?? '') ? 1 : 0
    if (!want || !r.amountCents) continue
    if (Math.sign(r.amountCents) === want) agree++
    else disagree++
  }
  if (agree + disagree >= 3) return disagree > 2 * agree
  if (s.kind !== 'card') return false
  const nonzero = s.rows.filter((r) => r.amountCents !== 0)
  return nonzero.length >= 3 && nonzero.filter((r) => r.amountCents > 0).length / nonzero.length > 0.7
}
