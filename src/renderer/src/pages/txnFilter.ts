import { daysInMonth } from '../../../shared/zone'
import type { LineClass, LinePage, LineQuery, Transaction, TxnPage, TxnQuery, VentureIntent } from '../../../shared/types'

// What the Transactions page opens on (waterfall spec section 4): the list's own filters, or a Home drill's
// classified lines through linesFor (lines.ts), so a part of a row opens on exactly its lines, its count and sum the
// part's. No React and no window here, so Home's figures and the tests read the same filters the page does.

export interface TxnFilter {
  categoryId?: number | 'none'
  month?: string
  /** with month, a span of months through this one */
  toMonth?: string
  /** days, both included (YYYY-MM-DD): Home's last 30 days or a window before them */
  fromDay?: string
  toDay?: string
  accountId?: string
  /** a bucket id, or 'personal' */
  bucketId?: number | 'personal'
  /** the search box, as a notification opens it */
  search?: string
  // A drill's classified lines (LineQuery): any of these makes the list the lines linesFor picks, until cleared.
  cls?: LineClass[]
  seriesKey?: string
  paycheckKey?: string
  assetId?: string
  /** a venture's id, or null for Personal */
  owner?: number | null
  /** transaction ids */
  ids?: string[]
  /** a paycheck's bonus part alone, or with false every line but those */
  bonus?: boolean
  /** payee keys: the lines paid to any of them */
  payees?: string[]
  /** a venture's id: its boundary lines' parts, the money between it and Personal (the Ventures page) */
  ventureId?: number
  /** with ventureId, the parts of one intent, or 'unset' for those with none yet */
  intent?: VentureIntent | 'unset'
  /** what the drill's lines make up, as Home names them: "Everyday · Gas & Fuel" */
  name?: string
}

const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

/** The filter's line fields: a drill when any is set. */
export const isDrill = (f: TxnFilter): boolean =>
  f.cls !== undefined || f.seriesKey !== undefined || f.paycheckKey !== undefined || f.assetId !== undefined || f.owner !== undefined || f.ids !== undefined || f.bonus !== undefined || f.payees !== undefined || f.ventureId !== undefined || f.intent !== undefined

/**
 * The linesFor query a drill filter asks (spec section 6): its days (a month or months, or days; ten years back to
 * today with none) and every line field it names; null for a filter with no line field, which lists transactions.
 */
export function lineQuery(f: TxnFilter, today: string): LineQuery | null {
  if (!isDrill(f)) return null
  const days = f.month ? { fromDay: `${f.month}-01`, toDay: lastDayOf(f.toMonth ?? f.month) } : f.fromDay && f.toDay ? { fromDay: f.fromDay, toDay: f.toDay } : { fromDay: `${Number(today.slice(0, 4)) - 10}-01-01`, toDay: today }
  const q: LineQuery = { ...days }
  if (f.cls !== undefined) q.cls = f.cls
  if (f.categoryId !== undefined) q.categoryId = f.categoryId
  if (f.seriesKey !== undefined) q.seriesKey = f.seriesKey
  if (f.paycheckKey !== undefined) q.paycheckKey = f.paycheckKey
  if (f.accountId !== undefined) q.accountId = f.accountId
  if (f.assetId !== undefined) q.assetId = f.assetId
  if (f.owner !== undefined) q.owner = f.owner
  if (f.ids !== undefined) q.ids = f.ids
  if (f.bonus !== undefined) q.bonus = f.bonus
  if (f.payees !== undefined) q.payees = f.payees
  if (f.ventureId !== undefined) q.ventureId = f.ventureId
  if (f.intent !== undefined) q.intent = f.intent
  return q
}

/** A drill's lines as the list shows them: the ones read so far, how many it has and their sum, and the transactions they're on. */
export interface DrillRows extends LinePage {
  txns: Map<string, Transaction>
}

/** The most lines linesFor gives a call, and the most transactions listTransactions does. */
const MOST = 1000

/**
 * A drill's first `want` lines, read on from the ones already shown (`have`; null to start over, as a new drill or a
 * data change does): linesFor's pages from where they end, at most 1,000 a call, then the transactions of the lines
 * new to the list, 1,000 a call. So Show more past 1,000 keeps going, and asks only for what it adds.
 */
export async function drillRows(
  read: (q: LineQuery, page: { offset: number; limit: number }) => Promise<LinePage>,
  list: (q: TxnQuery) => Promise<TxnPage>,
  q: LineQuery,
  have: DrillRows | null,
  want: number
): Promise<DrillRows> {
  const lines = have ? [...have.lines] : []
  let total = have ? have.total : null
  let cents = have ? have.cents : 0
  while (total === null || lines.length < Math.min(want, total)) {
    const page = await read(q, { offset: lines.length, limit: Math.min(MOST, Math.max(1, want - lines.length)) })
    total = page.total
    cents = page.cents
    lines.push(...page.lines)
    if (!page.lines.length) break
  }
  const txns = new Map(have?.txns ?? [])
  const missing = [...new Set(lines.map((l) => l.txnId))].filter((id) => !txns.has(id))
  for (let i = 0; i < missing.length; i += MOST) {
    const ids = missing.slice(i, i + MOST)
    for (const t of (await list({ ids, limit: ids.length })).rows) txns.set(t.id, t)
  }
  return { lines, total, cents, txns }
}

/** The Transactions filter that opens on a drill's lines, under its name: whole months as months, any other days as days. */
export function drillFilter(q: LineQuery, name: string): TxnFilter {
  const whole = q.fromDay.endsWith('-01') && q.toDay === lastDayOf(q.toDay.slice(0, 7))
  const f: TxnFilter = whole ? { month: q.fromDay.slice(0, 7), toMonth: q.toDay.slice(0, 7) } : { fromDay: q.fromDay, toDay: q.toDay }
  for (const k of ['cls', 'categoryId', 'seriesKey', 'paycheckKey', 'accountId', 'assetId', 'owner', 'ids', 'bonus', 'payees', 'ventureId', 'intent'] as const) if (q[k] !== undefined) Object.assign(f, { [k]: q[k] })
  f.name = name
  return f
}
