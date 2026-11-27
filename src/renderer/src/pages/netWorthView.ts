import { isDay } from '../../../shared/period'
import { addDays, daysInMonth } from '../../../shared/zone'
import type { NetWorthBridge, NetWorthPoint, NetWorthSeries, Span, Waterfall } from '../../../shared/types'
import { dayName, dollars, MINUS, monthName, spanHeading, spanMark } from './homeView'

// Net worth's Overview over a span (waterfall spec 2d and section 4): the net worth line and the monthly bridge, from
// one getWaterfall and the net worth series, which read one walk of the balances, so at every month's end the line
// is the month's bridge end, to the cent. The span is Home's (homeView readSpan), the viewer's one choice. No React
// and no window here, so the tests read the very lines the Overview draws. Figures are whole dollars, as Home shows
// them; each line ties in cents.

const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`

/** A span's first and last days: the bridge starts at the end of the day before the first and ends at the last. */
export function spanDays(s: Span): { fromDay: string; toDay: string } {
  return isDay(s.from) ? { fromDay: s.from, toDay: s.to } : { fromDay: `${s.from}-01`, toDay: lastDayOf(s.to) }
}

/**
 * The net worth line over a span: each day's net worth from the end of the day before its first (the bridge's start)
 * to its last day, or today when that's later; to the open month's last day when a line is already dated after
 * today, as the bridge ends there. The series starts the day before anything was known, when every account held what
 * it held on any earlier day, so a span that begins before it starts at that figure. Money between two accounts counts
 * on the day it lands, except where it is on its way at the line's first or last day: there it is in neither account,
 * as the bridge has it (its In transit), so the line starts and ends where the bridge does.
 */
export function chartPoints(series: NetWorthSeries | null, s: Span, today: string): NetWorthPoint[] {
  const all = [...(series?.points ?? []), ...(series?.ahead ?? [])]
  if (!all.length) return []
  const days = spanDays(s)
  const start = addDays(days.fromDay, -1)
  const known = all[all.length - 1].day > today ? all[all.length - 1].day : today
  const end = days.toDay < known ? days.toDay : known
  if (end < start) return []
  const holds = (x: NetWorthSeries['landed'][number], day: string): boolean => x.fromDay <= day && day <= x.toDay
  const away = (series?.landed ?? []).filter((x) => holds(x, start) || holds(x, end))
  const inSpan = all.filter((p) => p.day >= start && p.day <= end).map((p) => (away.some((x) => holds(x, p.day)) ? { day: p.day, cents: away.reduce((c, x) => c - (holds(x, p.day) ? x.cents : 0), p.cents) } : p))
  const first = all[0]
  if (first.day <= start) return inSpan
  const before = { day: start, cents: first.cents }
  return first.day > end ? [before, { day: end, cents: first.cents }] : [before, ...inSpan]
}

/** The days the line's axis labels: the span's own, from its first day, though the line starts the day before it. */
export const axisDays = (points: NetWorthPoint[]): string[] => points.slice(1).map((p) => p.day)

/**
 * The bridge's terms in the order the Overview lists them, each with its own sign, as Home's Growth drill and Review
 * show it (spec 2): In transit and Unexplained are taken away, so their headings say so and a line reads Start +
 * Saved + Growth + Revaluation + Ventures + Unsorted − In transit − Unexplained + Other = End.
 */
export const BRIDGE_TERMS = [
  { key: 'saved', name: 'Saved', sign: 1, cents: (b: NetWorthBridge): number => b.savedCents },
  { key: 'growth', name: 'Growth', sign: 1, cents: (b: NetWorthBridge): number => b.growthCents },
  { key: 'revaluation', name: 'Revaluation', sign: 1, cents: (b: NetWorthBridge): number => b.revaluationCents },
  { key: 'ventures', name: 'Ventures', sign: 1, cents: (b: NetWorthBridge): number => b.venturesCents },
  { key: 'unsorted', name: 'Unsorted', sign: 1, cents: (b: NetWorthBridge): number => b.unsortedCents },
  // The minus stays with its word when a heading takes two lines.
  { key: 'inTransit', name: `${MINUS} In transit`, sign: -1, cents: (b: NetWorthBridge): number => b.inTransitCents },
  { key: 'unexplained', name: `${MINUS} Unexplained`, sign: -1, cents: (b: NetWorthBridge): number => b.unexplainedCents },
  { key: 'other', name: 'Other', sign: 1, cents: (b: NetWorthBridge): number => b.otherCents }
] as const

export type BridgeTerm = (typeof BRIDGE_TERMS)[number]['key']

/** What a line's terms move net worth by: start plus it is end. */
export const termsTotal = (terms: Record<BridgeTerm, number>): number => BRIDGE_TERMS.reduce((s, t) => s + t.sign * terms[t.key], 0)

/** One line of the monthly bridge: a month (or the whole span), its close marker, its start, terms and end. */
export interface BridgeLine {
  key: string
  /** "Oct 2026", the days of a month a span of days holds part of ("Oct 9 – Oct 31"), or the span's heading */
  name: string
  /** the span picker's marker for the month, or for the span's months: ✓ closed, Δ changed, ! a gap, ○ open */
  mark: '✓' | 'Δ' | '!' | '○'
  /** the marker's words: the month's status, a line a month for the span */
  title: string
  /** the line for the whole span */
  span: boolean
  /** a changed month's bridge as its close froze it, under the month's line, where any figure differs (Home's drills show them the same way) */
  closed: boolean
  startCents: number
  /** each term with its own sign, as drawn: start plus termsTotal (In transit and Unexplained taken away) is end */
  terms: Record<BridgeTerm, number>
  endCents: number
  /** the figures as drawn: start, each term, end */
  cells: string[]
}

function lineOf(key: string, name: string, mark: { mark: BridgeLine['mark']; title: string }, b: NetWorthBridge, span: boolean, closed = false): BridgeLine {
  const terms = Object.fromEntries(BRIDGE_TERMS.map((t) => [t.key, t.cents(b)])) as Record<BridgeTerm, number>
  return {
    key,
    name,
    mark: mark.mark,
    title: mark.title,
    span,
    closed,
    startCents: b.startCents,
    terms,
    endCents: b.endCents,
    cells: [dollars(b.startCents), ...BRIDGE_TERMS.map((t) => dollars(terms[t.key])), dollars(b.endCents)]
  }
}

/** Whether anything moved net worth in a bridge: its end isn't its start, or a term isn't 0. */
const moved = (b: NetWorthBridge): boolean => b.endCents !== b.startCents || BRIDGE_TERMS.some((t) => t.cents(b) !== 0)

/** Whether two bridges show different figures: their start, a term or their end. */
const differs = (a: NetWorthBridge, b: NetWorthBridge): boolean => a.startCents !== b.startCents || a.endCents !== b.endCents || BRIDGE_TERMS.some((t) => t.cents(a) !== t.cents(b))

/**
 * The monthly bridge as the Overview lists it: the whole span first, from the end of the day before its first day to
 * its last, then each month of the span, the newest first, each with its close marker as Home's picker shows it. Each
 * month's end is the next one's start, and the span's terms are the months' added up. Under a month changed since its
 * close, its bridge as the close froze it, where a figure moved. A month before the books begin (firstMonth) that
 * nothing moved in is left out, as All starts there, and with no month left there is no bridge. A span of one month
 * is that month's line alone, with its closed line.
 */
export function bridgeLines(w: Waterfall): BridgeLine[] {
  const days = isDay(w.span.from) ? spanDays(w.span) : null
  const month = (m: Waterfall['months'][number], key = m.month, span = false): BridgeLine[] => {
    // A span of days holds part of its first and last months: the line names its days.
    const from = days && days.fromDay > `${m.month}-01` ? days.fromDay : `${m.month}-01`
    const to = days && days.toDay < lastDayOf(m.month) ? days.toDay : lastDayOf(m.month)
    const name = days ? `${dayName(from)} – ${dayName(to)}` : monthName(m.month)
    const mark = spanMark([m])
    const closed = m.closedBridge && differs(m.closedBridge, m.bridge) ? [lineOf(`${m.month}:closed`, 'Closed', mark, m.closedBridge, false, true)] : []
    return [lineOf(key, name, mark, m.bridge, span), ...closed]
  }
  const listed = w.months.filter((m) => (w.firstMonth !== null && m.month >= w.firstMonth) || moved(m.bridge))
  if (!listed.length) return []
  if (w.months.length === 1) return month(w.months[0], 'span', true)
  return [lineOf('span', spanHeading(w.span), spanMark(w.months), w.bridge, true), ...[...listed].reverse().flatMap((m) => month(m))]
}
