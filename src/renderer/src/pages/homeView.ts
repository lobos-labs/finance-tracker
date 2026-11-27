import { PAYSTUB_ITEM_KINDS } from '../../../shared/payroll'
import { daysIn, isDay, lastDays } from '../../../shared/period'
import { roundDiv } from '../../../shared/rounding'
import { CADENCE_LABEL } from '../../../shared/schedule'
import { shiftMonth } from '../../../shared/zone'
import { SHEET_GROUP_OF, SPEND_RISKS, TAX_TREATMENTS } from '../../../shared/types'
import type { AccountReturn, CashIdentity, CloseStatus, CommittedGroup, GrowthDrill, HomeOpen, HomePlans, LeakItem, Lever, LeverKind, LineClass, LineCounts, NetWorthBridge, PartFigures, PayCheck, PaystubItemKind, SheetGroup, Span, SpendRisk, StageFigures, StageId, StagePart, StageRow, TaxTreatment, Waterfall } from '../../../shared/types'
import type { Page } from '../App'
import type { FlowData, FlowKind, FlowNode, FlowView, WalkStep } from '../Flow'
import type { NetView } from './NetWorth'
import { drillFilter, type TxnFilter } from './txnFilter'

// Home's figures as it shows them (waterfall spec 1.10, 1.12 and section 5), from one getWaterfall: no React and no
// window here, so the tests read the very lines Home draws. Home shows whole dollars, each rounded half away from
// zero from its own cents, so a subtotal can be $1 off its parts (spec 1.1). A row taken off the one above it
// (Taxes, Benefits, Saved at work, Committed, Everyday, One-offs) is money out, so it shows negative, and so does its
// change when it grew: Committed up 34.50 is -35.

export const MINUS = '−'

/** The rows Home lists, in order. Gross pay is left out when nothing comes off pay (the engine merges it into Take-home). */
export const MAIN_ROWS: StageId[] = ['gross', 'takeHome', 'elective', 'leftOver', 'saved', 'invested', 'growth']

/** The rows that lead into a subtotal, shown under it when it's open. */
export const LEADS_INTO: Partial<Record<StageId, StageId[]>> = {
  takeHome: ['taxes', 'benefits', 'savedAtWork', 'payrollDiff'],
  elective: ['committed'],
  leftOver: ['everyday'],
  saved: ['oneOffs']
}

export const ROW_NAME: Record<StageId, string> = {
  gross: 'Gross pay',
  taxes: 'Taxes',
  benefits: 'Benefits',
  savedAtWork: 'Saved at work',
  payrollDiff: 'Payroll difference',
  takeHome: 'Take-home',
  committed: 'Committed',
  elective: 'Elective',
  everyday: 'Everyday',
  leftOver: 'Left over',
  oneOffs: 'One-offs',
  saved: 'Saved',
  invested: 'Invested',
  growth: 'Growth'
}

/** Money out of the row above: shown negative. The Payroll difference adds to Take-home, so it keeps its sign. */
const OUT = new Set<StageId>(['taxes', 'benefits', 'savedAtWork', 'committed', 'everyday', 'oneOffs'])
/** A row's cents as Home shows them, in the rows, over the Walk's bars and on the Sankey's nodes. */
export const shown = (id: StageId, cents: number): number => (OUT.has(id) ? -cents : cents)

// ---------- figures ----------

/** Whole dollars from cents, rounded half away from zero, with a true minus: 1,544 and −1,431. */
export function dollars(cents: number): string {
  const d = roundDiv(cents, 100)
  return `${d < 0 ? MINUS : ''}${Math.abs(d).toLocaleString('en-US')}`
}

/** Dollars and cents, with a true minus: 3,000.00 and −348.00, as a paystub shows them. */
export function money(cents: number): string {
  return `${cents < 0 ? MINUS : ''}${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Whole dollars with a plus when above zero: +220, −16, 0. */
export const signed = (cents: number): string => (roundDiv(cents, 100) > 0 ? `+${dollars(cents)}` : dollars(cents))

/** A rate, in tenths of a percent: 63.0%; blank with no base. */
export const pct = (rate: number | null): string => (rate === null ? '' : `${rate < 0 ? MINUS : ''}${Math.abs(rate).toFixed(1)}%`)

/** A change in points: +8.7 pts, −0.9 pts, 0.0 pts. */
export const pts = (p: number): string => `${p > 0 ? '+' : p < 0 ? MINUS : ''}${Math.abs(p).toFixed(1)} pts`

/** A rate charged, from basis points: 24.0%, 6.4%, 3.75%. */
export const aprText = (bp: number): string => `${(bp / 100).toFixed(bp % 10 ? 2 : 1)}%`

const monthShort = (month: string): string => new Date(`${month}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short' })
/** "Oct 2026" */
export const monthName = (month: string): string => new Date(`${month}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
/** "Nov 14" */
export const dayName = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

// ---------- spans ----------

/** The span picker's presets (spec 1.12). They move with the date, so Home remembers a preset by its name. */
export const PRESETS = ['30D', 'MTD', 'YTD', '12M', 'All'] as const
export type Preset = (typeof PRESETS)[number]

/** A preset's span on a day (YYYY-MM-DD); All runs from the first month with a line, and is null with none. */
export function presetSpan(id: Preset, today: string, firstMonth: string | null): Span | null {
  const cur = today.slice(0, 7)
  switch (id) {
    case '30D':
      return lastDays(30, today)
    case 'MTD':
      return { from: cur, to: cur }
    case 'YTD':
      return { from: `${cur.slice(0, 4)}-01`, to: cur }
    case '12M':
      return { from: shiftMonth(cur, -11), to: cur }
    case 'All':
      return firstMonth ? { from: firstMonth < cur ? firstMonth : cur, to: cur } : null
  }
}

/** Home's span before one is picked: the last full month, the latest that can close. */
export const defaultSpan = (today: string): Span => {
  const last = shiftMonth(today.slice(0, 7), -1)
  return { from: last, to: last }
}

/** The span as Home keeps it: a preset by its name, or the last full month as 'last', so both move with the date; any other as it was. */
export type KeptSpan = { preset: Preset | 'last'; span: Span } | { span: Span }

/**
 * What to keep for a span picked: the preset clicked, by the name clicked, since two presets can be the same span
 * on a day (YTD and MTD in January, 12M and YTD in December) and differ the next month; the last full month by name;
 * any other span as it is.
 */
export function keptSpan(s: Span, preset: Preset | null, today: string): KeptSpan {
  if (preset) return { preset, span: s }
  const last = defaultSpan(today)
  return last.from === s.from && last.to === s.to ? { preset: 'last', span: s } : { span: s }
}

/**
 * Where this viewer's span is kept (spec 1.12: one choice, remembered per viewer). Home, its drills and Net worth's
 * Overview read and write it, so the Overview opens on the span the Growth drill showed; the Ventures page keeps its own.
 */
export const SPAN_KEY = 'home.span'

/** The span this viewer left, and the preset it was picked by: Home's default when none is kept or the store can't be read. */
export function readSpan(store: () => Pick<Storage, 'getItem'>, today: string): { span: Span; preset: Preset | null } {
  try {
    return spanOf(JSON.parse(store().getItem(SPAN_KEY) ?? 'null'), today)
  } catch {
    return { span: defaultSpan(today), preset: null }
  }
}

/** Keeps a span picked, as readSpan reads it; nothing when the store can't be written, as it's a convenience only. */
export function writeSpan(store: () => Pick<Storage, 'setItem'>, s: Span, preset: Preset | null, today: string): void {
  try {
    store().setItem(SPAN_KEY, JSON.stringify(keptSpan(s, preset, today)))
  } catch {
    /* per-viewer convenience only */
  }
}

/** The span a kept one gives today: a preset's span now (All from where it began), or the span as kept. */
export function spanOf(kept: unknown, today: string): { span: Span; preset: Preset | null } {
  const v = kept as Partial<{ preset: Preset | 'last'; span: Span }> | null
  if (!v || typeof v.span?.from !== 'string' || typeof v.span?.to !== 'string') return { span: defaultSpan(today), preset: null }
  if (v.preset === undefined) return { span: v.span, preset: null }
  if (v.preset === 'last') return { span: defaultSpan(today), preset: null }
  // All starts where it did; it ends this month.
  if (v.preset === 'All') return { span: { from: v.span.from, to: today.slice(0, 7) }, preset: 'All' }
  const s = PRESETS.includes(v.preset) ? presetSpan(v.preset, today, null) : null
  return s ? { span: s, preset: v.preset } : { span: defaultSpan(today), preset: null }
}

/** The amount column's heading: the month (Oct), the months (Jan–Oct, or Nov ’25–Oct ’26), or the days (30 days). */
export function spanHeading(s: Span): string {
  if (isDay(s.from)) return `${daysIn(s.from, s.to)} days`
  if (s.from === s.to) return monthShort(s.from)
  if (s.from.slice(0, 4) === s.to.slice(0, 4)) return `${monthShort(s.from)}–${monthShort(s.to)}`
  return `${monthShort(s.from)} ’${s.from.slice(2, 4)}–${monthShort(s.to)} ’${s.to.slice(2, 4)}`
}

const STATUS_WORD: Record<CloseStatus, string> = { open: 'open', closed: 'closed', gap: 'gap', changed: 'changed' }

/**
 * The span picker's marker for its months (spec 1.12): Δ when a closed month changed since, ! when one closed with a
 * gap, ○ when the span holds the open month, ✓ when every month is closed. The title lists each month's status.
 */
export function spanMark(months: Waterfall['months']): { mark: '✓' | 'Δ' | '!' | '○'; title: string } {
  const has = (s: CloseStatus): boolean => months.some((m) => m.status === s)
  const mark = has('changed') ? 'Δ' : has('gap') ? '!' : has('open') ? '○' : '✓'
  const title = months.map((m) => `${monthName(m.month)} ${STATUS_WORD[m.status]}${m.origin === 'backfill' ? ' (backfill)' : ''}`).join('\n')
  return { mark, title }
}

// ---------- the view ----------

/** Rows, Walk or Sankey (spec Decision 2), in the toggle's order. */
export const HOME_VIEWS: readonly FlowView[] = ['rows', 'walk', 'sankey']
/** Where Home keeps its view, apart from the old Dashboard's chart choice ('flow.view'), so only a view picked here counts as picked. */
export const HOME_VIEW_KEY = 'home.view'
/** What Home shows until a view is picked here (home.view unset): the Sankey. */
export const HOME_DEFAULT_VIEW: FlowView = 'sankey'

/**
 * The view Home arrives on with none picked: the Sankey, or the rows when a row is open on arrival (home.open, the row
 * this viewer left open, or one go() or a notification asks for), since an open row shows only there; Spendable's strip
 * sits above every view. Shown, not kept: a view picked here (home.view) always wins.
 */
export const arrivalView = (open: Opened | undefined): FlowView => (open && open !== 'spendable' ? 'rows' : HOME_DEFAULT_VIEW)

/**
 * What Home draws: the rows without the money flow feature; else its view, but with none picked the Sankey gives way to
 * the rows at a phone's width (shellMenu.ts NARROW: its columns need about 560 px, so it would scroll sideways in its
 * box) and when it has nothing to draw (nothing sorted in the span yet: a first import with no AI), where Unsorted and
 * its drill are. A Sankey picked here stays.
 */
export function shownHomeView(o: { flowOn: boolean; view: FlowView; picked: boolean; flow: FlowData | null; narrow: boolean }): FlowView {
  if (!o.flowOn) return 'rows'
  if (o.view === 'sankey' && !o.picked && (o.narrow || (o.flow && !o.flow.links.some((l) => l.value > 0)))) return 'rows'
  return o.view
}

// ---------- going to Home ----------

/** Pages that are rows of Home now (spec section 4): a call or a notification that still names one lands on Home. */
export type LegacyPage = 'dashboard' | 'budget' | 'recurring'

/**
 * Where go() lands. The Dashboard is Home, opened as home.open has it; Budget's categories are Left over's, and
 * Recurring's bills and subscriptions Elective's. A notification for the Dashboard is a shortfall or an overdraw, so it
 * opens Spendable. `open` left out keeps the row Home has open.
 */
export function routeOf(page: Page | LegacyPage, o: { homeOpen: HomeOpen | null; notification?: boolean }): { page: Page; open?: HomeOpen | null } {
  if (page === 'dashboard') return { page: 'home', open: o.notification ? 'spendable' : o.homeOpen }
  if (page === 'budget') return { page: 'home', open: 'leftOver' }
  if (page === 'recurring') return { page: 'home', open: 'elective' }
  return { page }
}

/**
 * Onboarding's Home step (spec section 4): what comes first for the user, each answer named by that aim, and what Home
 * opens on for it (home.open). Everything opens no row; not overdrawing opens the Spendable strip, paying off debt
 * Saved, growing net worth Growth, and where the money goes Left over. The phone's Home step asks the same.
 */
export const HOME_CHOICES: ReadonlyArray<{ open: HomeOpen | null; label: string }> = [
  { open: null, label: 'Everything' },
  { open: 'spendable', label: 'Not overdrawing' },
  { open: 'saved', label: 'Paying off debt' },
  { open: 'growth', label: 'Growing net worth' },
  { open: 'leftOver', label: 'Where my money goes' }
]

/** A Home choice's name, as the Done step lists it: Everything when none was chosen. */
export const homeChoiceLabel = (open: HomeOpen | null): string => (HOME_CHOICES.find((c) => c.open === open) ?? HOME_CHOICES[0]).label

// ---------- levers ----------

const INTEREST = new Set<LeverKind>(['card_interest', 'loan_interest'])

/** Interest first, the highest rate first and one with no rate after them, then the rest by amount (Decision 19). */
function leverOrder(a: Lever, b: Lever): number {
  const ia = INTEREST.has(a.kind)
  const ib = INTEREST.has(b.kind)
  if (ia !== ib) return ia ? -1 : 1
  if (ia && a.aprBp !== b.aprBp) return a.aprBp === null ? 1 : b.aprBp === null ? -1 : b.aprBp - a.aprBp
  return b.monthlyCents - a.monthlyCents
}

const LEVER_NAME: Record<LeverKind, (l: Lever) => string> = {
  w4: (l) => `${l.name} refund`,
  card_interest: (l) => `${l.name}${l.aprBp === null ? '' : ` ${aprText(l.aprBp)}`} interest`,
  loan_interest: (l) => `${l.name}${l.aprBp === null ? '' : ` ${aprText(l.aprBp)}`} interest`,
  price_change: (l) => `${l.name} price up`,
  utilities_change: (l) => `${l.name} up`,
  over_target: (l) => `${l.name} over target`,
  match_left: (l) => `${l.name} match left`,
  tax_room: (l) => `${l.name} room`,
  cash_above_goals: (l) => `${l.name} above goals`
}

/** A lever as one datum: "Visa 24.0% interest 60/mo +1.6 pts". */
export const leverText = (l: Lever): string => [LEVER_NAME[l.kind](l), `${dollars(l.monthlyCents)}/mo`, ...(l.ratePts === null ? [] : [pts(l.ratePts)])].join(' ')

/** The top one or two levers for a row (spec 1.8), or its `most`, as Home's one line; null with none. */
export function leverLine(levers: Lever[], stage: StageId, most = 2): string | null {
  const top = levers
    .filter((l) => l.stage === stage)
    .sort(leverOrder)
    .slice(0, most)
  return top.length ? top.map(leverText).join(' · ') : null
}

// ---------- the table ----------

/** What Home can have open: a row, the Spendable strip, or Unexplained's items. */
export type Opened = HomeOpen | 'unexplained' | null

export interface RowLine {
  kind: 'row'
  id: StageId
  name: string
  /** a row leading into the open subtotal */
  less: boolean
  amount: string
  perMonth: string | null
  runRate: string
  rate: string
  /** Δ 3 mo; blank for Growth */
  change: string
  /** Δ pts, on the open row */
  pts: string | null
  focus: boolean
  /** the run rates, as shown, oldest first; null on the rows under an open one */
  spark: number[] | null
  open: boolean
  /** a row the open one passes its money to: Saved at work goes to Saved */
  to: HomeOpen | null
}

/** A part of the open row, in the rows' columns. */
export interface PartLine {
  kind: 'part'
  key: string
  name: string
  amount: string
  perMonth: string | null
  runRate: string
  change: string
  /** what the part is beside its figures: a series' cadence and next day, a debt's rate, a price change */
  note: string | null
  /** the Transactions list on exactly its lines */
  drill: TxnFilter | null
  /** under a Committed group, a step further in */
  nested: boolean
  /** an Everyday category's tier: E essential, L lifestyle */
  tag?: 'E' | 'L'
  /**
   * its note goes after its figures, in the last column, as section 5 draws a category's target, or across the
   * figures' columns for a part with none (a habit); under its name in a narrow window
   */
  beside?: boolean
}

/** One item of a data line that goes somewhere: a drill's lines, or a page (with `view`, that view of Net worth). */
export interface DataItem {
  text: string
  drill?: TxnFilter
  page?: Page
  view?: NetView
}

/** A data line under the open row: "Levers  W-4 refund 85/mo +1.4 pts". */
export interface DataLine {
  kind: 'data'
  key: string
  label: string
  text: string
  /** the text as items that open something, when they do */
  items?: DataItem[]
  /** a row it passes its money to: Principal goes to Saved */
  to?: HomeOpen
  /** a view of Net worth it opens, by the name the sidebar gives it: the debt plan's next target opens Debts */
  net?: { view: NetView; label: string }
}

/**
 * One payroll's checks over the span as Take-home's pay-day table (spec 1.3): a column a check, and a row each for
 * gross, every item, net, the deposit and, when any check's deposit isn't its net, the difference.
 */
export interface PayTableLine {
  kind: 'payTable'
  key: string
  /** the payroll, opening its deposits */
  name: string
  drill: TxnFilter
  /** each check's pay day, opening its deposits */
  checks: Array<{ label: string; drill: TxnFilter }>
  rows: Array<{ kind: 'gross' | 'item' | 'net' | 'deposit' | 'difference'; label: string; cells: string[] }>
  /** every check has a stub, and its deposit is its net */
  tied: boolean
}

/**
 * An account's line under Growth (spec 1.7), in the rows' columns: an invested account's return beside how it's
 * taxed, or a Personal asset's revaluation. It opens the view of Net worth that holds it: an investment or retirement
 * account the Investments page, property and vehicles Property; an HSA held as cash, on no page of its own, opens nothing.
 */
export interface AccountLine {
  kind: 'account'
  /** Growth's part for it, return:<id>, or revaluation:<id> */
  key: string
  name: string
  /**
   * an invested account's tax treatment (Pre-tax, Roth, HSA or Taxable), and over days its return can't be measured
   * what its value did and what was put in: "Pre-tax · put in 360"; an asset's "Revaluation"
   */
  note: string
  /** its return, or — where it can't be measured; an asset's revaluation */
  amount: string
  perMonth: string | null
  runRate: string
  /** the view of Net worth it opens */
  view: NetView | null
}

/** A Committed group under Elective (spec 1.4): its amount and run rate as costs, and what's in it as data. */
export interface GroupLine {
  kind: 'group'
  key: CommittedGroup
  name: string
  amount: string
  perMonth: string | null
  runRate: string
  change: string
  label: string
  open: boolean
}

/** Elective's Committed, by group or by date. */
export type ElectiveView = 'groups' | 'byDate'

/** A choice between an open row's views: Elective's Groups or By date. */
export interface SwitchLine {
  kind: 'switch'
  key: 'electiveView'
  value: ElectiveView
  options: Array<{ id: ElectiveView; label: string }>
}

/** Left over's Everyday, by category or by payee (spec 1.5). */
export type LeftOverView = 'categories' | 'payees'

/** Left over's choice between its Categories and its Payees, as Elective's switch draws it. */
export interface LeftOverSwitchLine {
  kind: 'switch'
  key: 'leftOverView'
  value: LeftOverView
  options: Array<{ id: LeftOverView; label: string }>
}

/** Where the page draws what it reads for the open row itself: Take-home's contributions, Elective's next 30 days. */
export interface SlotLine {
  kind: 'slot'
  key: 'contributions' | 'byDate'
}

export interface UnsortedLine {
  kind: 'unsorted'
  count: number
  amount: string
  focus: boolean
  /** the Transactions list on Unsorted's own lines */
  drill: TxnFilter
}

export interface UnexplainedLine {
  kind: 'unexplained'
  amount: string
  focus: boolean
  open: boolean
}

/** A changed month's figure beside its close's (spec 2, On Home): "Everyday run rate  −1,036  closed −1,020  −16". */
export interface ClosedLine {
  kind: 'closed'
  key: string
  name: string
  now: string
  closed: string
  /** now less closed, as the row shows it */
  change: string
  /** a part's, under the part's own line: a step in from it */
  nested?: boolean
}

export type HomeLine = RowLine | PartLine | DataLine | PayTableLine | GroupLine | SwitchLine | LeftOverSwitchLine | SlotLine | UnsortedLine | UnexplainedLine | ClosedLine | AccountLine

export interface HomeTable {
  /** the amount column's heading, and the sparkline's */
  heading: { amount: string; spark: string }
  /** the span is longer than a month: a Per month column */
  perMonth: boolean
  lines: HomeLine[]
}

const rowLine = (w: Waterfall, r: StageRow, o: { less: boolean; open: boolean }): RowLine => ({
  kind: 'row',
  id: r.id,
  name: ROW_NAME[r.id],
  less: o.less,
  amount: dollars(shown(r.id, r.actualCents)),
  perMonth: r.perMonthCents === null ? null : dollars(shown(r.id, r.perMonthCents)),
  runRate: r.runRateCents === null ? '' : dollars(shown(r.id, r.runRateCents)),
  rate: pct(r.rate),
  change: r.changeCents === null ? '' : dollars(shown(r.id, r.changeCents)),
  pts: o.open && r.rateChangePts !== null ? pts(r.rateChangePts) : null,
  focus: w.focus === r.id,
  spark: o.less ? null : r.trend.map((t) => shown(r.id, t.runRateCents ?? 0)),
  open: o.open,
  to: o.less && r.id === 'savedAtWork' ? 'saved' : null
})

// ---------- a changed month's figures beside its close's ----------

/** A figure one side doesn't have: a rate with no base, a Δ pts across pay bases that don't compare. */
const BLANK = '—'

const IDENTITY_NAME: Record<keyof CashIdentity, string> = {
  keptCents: 'Kept',
  venturesCents: 'Ventures',
  cashReturnCents: 'Cash return',
  unsortedCents: 'Unsorted',
  movedCents: 'Moved to savings',
  checkingCents: 'Left in checking',
  debtPaidCents: 'Debt paid down',
  toInvestmentsCents: 'Moved to investments',
  boughtCents: 'Bought assets',
  inTransitCents: 'In transit',
  unexplainedCents: 'Unexplained',
  itemizedCents: 'Unexplained by item',
  engineErrorCents: 'Engine error'
}

const BRIDGE_NAME: Record<Exclude<keyof NetWorthBridge, 'other' | 'ventures'>, string> = {
  startCents: 'Net worth at start',
  endCents: 'Net worth',
  savedCents: 'Saved',
  growthCents: 'Growth',
  revaluationCents: 'Revaluation',
  venturesCents: 'Ventures',
  unsortedCents: 'Unsorted',
  inTransitCents: 'In transit',
  unexplainedCents: 'Unexplained',
  otherCents: 'Other',
  engineErrorCents: 'Engine error'
}

const OTHER_NAME: Record<NetWorthBridge['other'][number]['kind'], string> = { added: 'added', removed: 'removed', outsideFlow: 'outside flow', untrackedSaving: 'untracked saving', debtResidual: 'debt residual' }

/** A row's or a part's figures as closed and now; a part has no Δ pts and no pay basis of its own. */
type Figures = Omit<PartFigures, 'key' | 'name'> & Partial<Pick<StageFigures, 'closedRateChangePts' | 'nowRateChangePts' | 'closedBasis' | 'nowBasis'>>

/**
 * A row's or a part's figures that moved, each beside its close's in the row's own sign (a cost negative): its
 * amount, run rate, rate (a row's alone: a part draws none), Δ 3 mo, Δ pts and, with `basis`, the pay basis, in the
 * columns' order. `path` is the row, or the row and part. A part drawn on a line of its own has them a step in from
 * it (`nested`), as its own.
 */
function figureLines(row: StageId, path: string, name: string, f: Figures, o: { basis?: boolean; part?: boolean; nested?: boolean } = {}): ClosedLine[] {
  const out: ClosedLine[] = []
  const { basis = false, part = false } = o
  const line = (figure: string, label: string, now: string, closed: string, change: string): void => void out.push({ kind: 'closed', key: `closed:${figure}:${path}`, name: label, now, closed, change, ...(o.nested ? { nested: true } : {}) })
  const amount = (figure: string, label: string, now: number | null, closed: number | null): void => {
    if (now === closed) return
    if (now === null || closed === null) line(figure, label, now === null ? BLANK : dollars(shown(row, now)), closed === null ? BLANK : dollars(shown(row, closed)), '')
    else line(figure, label, ...beside(shown(row, now), shown(row, closed)))
  }
  // Rates and Δ pts are tenths: their difference is too, once the float's last bits are rounded off.
  const tenths = (now: number | null, closed: number | null): string => (now === null || closed === null ? '' : pts(Math.round((now - closed) * 10) / 10))
  amount('actual', name, f.nowCents, f.closedCents)
  amount('runRate', `${name} run rate`, f.nowRunRateCents, f.closedRunRateCents)
  // A part draws no rate, so its close's rate isn't drawn either.
  if (!part && f.nowRate !== f.closedRate) line('rate', `${name} rate`, pct(f.nowRate) || BLANK, pct(f.closedRate) || BLANK, tenths(f.nowRate, f.closedRate))
  amount('change', `${name} Δ 3 mo`, f.nowChangeCents, f.closedChangeCents)
  const [nowPts, closedPts] = [f.nowRateChangePts ?? null, f.closedRateChangePts ?? null]
  if (nowPts !== closedPts) line('pts', `${name} Δ pts`, nowPts === null ? BLANK : pts(nowPts), closedPts === null ? BLANK : pts(closedPts), tenths(nowPts, closedPts))
  const [nowBasis, closedBasis] = [f.nowBasis ?? null, f.closedBasis ?? null]
  if (basis && nowBasis !== closedBasis) line('basis', 'Pay basis', nowBasis ?? BLANK, closedBasis ?? BLANK, '')
  return out
}

/**
 * A figure beside its close's and what it moved by, in whole dollars when they move by what it did, else in dollars
 * and cents: a Payroll difference of a few cents a check, or 534.50 against 534.49, whose whole dollars 535 and 534
 * would read as a dollar for a cent's move.
 */
function beside(now: number, closed: number): [string, string, string] {
  const [a, b] = [roundDiv(now, 100), roundDiv(closed, 100)]
  return a !== b && roundDiv(now - closed, 100) === a - b ? [dollars(now), dollars(closed), dollars(now - closed)] : [money(now), money(closed), money(now - closed)]
}

/** A term's figure beside its close's, in its own sign: the identity's and the bridge's. */
const termLine = (key: string, name: string, now: number, closed: number): ClosedLine => {
  const [a, b, change] = beside(now, closed)
  return { kind: 'closed', key, name, now: a, closed: b, change }
}

/**
 * A row's or an identity term's lines beside its close's, where they moved with no figure of its own moving (a line
 * split in two of the same category, a line deleted and brought in again): how many, then how many came and went.
 */
function linesLine(key: string, name: string, l: LineCounts): ClosedLine {
  const change = [l.added ? `+${l.added.toLocaleString('en-US')}` : '', l.removed ? `${MINUS}${l.removed.toLocaleString('en-US')}` : ''].filter(Boolean).join(' ')
  return { kind: 'closed', key, name: `${name} lines`, now: l.nowCount.toLocaleString('en-US'), closed: l.closedCount.toLocaleString('en-US'), change }
}

/** What moved since a changed month's close, by where Home shows it: each row's own figures, each part's, the identity's (Saved's) and the bridge's (Growth's). */
interface ClosedView {
  own: (id: StageId) => ClosedLine[]
  part: (id: StageId, key: string) => ClosedLine[]
  /** a row's parts that moved, but those drawn */
  parts: (id: StageId, drawn: ReadonlySet<string>) => ClosedLine[]
  identity: ClosedLine[]
  bridge: ClosedLine[]
}

const NONE: ReadonlySet<string> = new Set()

function closedView(w: Waterfall, names: ReadonlyMap<string, string>): ClosedView {
  const c = w.closed ?? null
  const stage = new Map((c?.byStage ?? []).map((s) => [s.id, s]))
  const partOf = (id: StageId, p: PartFigures, nested = false): ClosedLine[] => figureLines(id, `${id}:${p.key}`, p.name, p, { part: true, nested })
  // The pay basis is the month's, the same on every row on pay: it shows once, under the first of them Home draws
  // (Gross pay, or Take-home standing for it).
  const basisMoved = (s: StageFigures): boolean => (s.closedBasis ?? null) !== (s.nowBasis ?? null)
  const today = new Set(w.rows.map((r) => r.id))
  const basisRow = (c?.byStage ?? []).find((s) => basisMoved(s) && today.has(s.id))?.id ?? (c?.byStage ?? []).find(basisMoved)?.id ?? null
  // A row's or a term's lines show where they moved and nothing of its own did.
  const counts = c?.lineCounts ?? []
  const termMoved = new Set((c?.identity ?? []).filter((t) => t.closedCents !== t.nowCents).map((t) => t.key))
  return {
    own: (id) => {
      const s = stage.get(id)
      const own = s ? figureLines(id, id, ROW_NAME[id], s, { basis: id === basisRow }) : []
      if (own.length || s?.parts.length) return own
      return counts.filter((l) => l.row === id).map((l) => linesLine(`closed:lines:row:${id}`, ROW_NAME[id], l))
    },
    part: (id, key) => {
      const p = stage.get(id)?.parts.find((x) => x.key === key)
      return p ? partOf(id, p, true) : []
    },
    parts: (id, drawn) => (stage.get(id)?.parts ?? []).filter((p) => !drawn.has(p.key)).flatMap((p) => partOf(id, p)),
    identity: [
      ...(c?.identity ?? []).filter((t) => t.closedCents !== t.nowCents).map((t) => termLine(`closed:identity:${t.key}`, IDENTITY_NAME[t.key] ?? t.key, t.nowCents, t.closedCents)),
      ...counts.filter((l) => l.term && !termMoved.has(l.term)).map((l) => linesLine(`closed:lines:term:${l.term}`, IDENTITY_NAME[l.term!] ?? l.term!, l))
    ],
    bridge: [
      ...(c?.bridge ?? []).filter((t) => t.closedCents !== t.nowCents).map((t) => termLine(`closed:bridge:${t.key}`, BRIDGE_NAME[t.key] ?? t.key, t.nowCents, t.closedCents)),
      ...(c?.other ?? []).map((o) => termLine(`closed:other:${o.kind}:${o.accountId}`, [o.accountId ? (names.get(o.accountId) ?? o.accountId) : null, OTHER_NAME[o.kind]].filter(Boolean).join(' '), o.nowCents, o.closedCents))
    ]
  }
}

/** The parts an open row draws as lines of their own, by row: Gross pay's, Take-home's standing alone, the open Committed group's, Everyday's categories, Saved's, Invested's and Growth's. */
function drawnParts(w: Waterfall, open: Opened, drill: DrillState): Map<StageId, ReadonlySet<string>> {
  const keys = (id: StageId, keep: (p: StagePart) => boolean = () => true): ReadonlySet<string> => new Set((w.rows.find((r) => r.id === id)?.parts ?? []).filter(keep).map((p) => p.key))
  const out = new Map<StageId, ReadonlySet<string>>()
  if (open === 'gross') out.set('gross', keys('gross'))
  if (open === 'takeHome' && !w.rows.some((r) => r.id === 'gross')) out.set('takeHome', keys('takeHome'))
  if (open === 'elective' && (drill.electiveView ?? 'groups') === 'groups' && drill.group) out.set('committed', keys('committed', (p) => (p.group ?? 'other') === drill.group))
  if (open === 'leftOver' && (drill.leftOverView ?? 'categories') === 'categories') out.set('everyday', keys('everyday'))
  if (open === 'saved') out.set('saved', keys('saved'))
  if (open === 'invested') out.set('invested', keys('invested'))
  // Growth draws Cash return in its Returns line, each account's return as a line of its own, and what moved in an
  // account's return its close had and the books no longer do.
  const closedGrowth = (w.closed?.byStage ?? []).find((s) => s.id === 'growth')?.parts ?? []
  if (open === 'growth') out.set('growth', new Set(['cashReturn', ...(w.growth?.accounts ?? []).map((a) => `return:${a.accountId}`), ...closedGrowth.map((p) => p.key)]))
  return out
}

/**
 * Saved's and Invested's parts that come from the paystubs, not from lines (Saved at work, Employer saving): no list
 * of lines adds up to them, so they open none.
 */
const FROM_PAYSTUBS = new Set(['atWork', 'employer'])

/** A part as its row shows it: a cost (a Committed series, say) negative, as the row is; one made of lines opens them. */
const partLine = (row: StageId, p: StagePart, o: { name?: string; note?: string | null; nested?: boolean; tag?: PartLine['tag']; beside?: boolean } = {}): PartLine => {
  const name = o.name ?? p.name
  return {
    kind: 'part',
    key: p.key,
    name,
    amount: dollars(shown(row, p.actualCents)),
    perMonth: p.perMonthCents === null ? null : dollars(shown(row, p.perMonthCents)),
    runRate: p.runRateCents === null ? '' : dollars(shown(row, p.runRateCents)),
    change: p.changeCents === null ? '' : dollars(shown(row, p.changeCents)),
    note: o.note ?? null,
    drill: FROM_PAYSTUBS.has(p.key) ? null : drillFilter(p.drill, `${ROW_NAME[row]} · ${name}`),
    nested: o.nested ?? false,
    ...(o.tag ? { tag: o.tag } : {}),
    ...(o.beside && o.note ? { beside: true } : {})
  }
}

/**
 * Unexplained is above tolerance when any month of the span is above its own (spec 1.10 and section 2): the
 * months' small gaps can add past one month's tolerance, and a gap one way and one back can add to nothing.
 */
export const unexplainedAbove = (w: Waterfall): boolean => w.months.some((m) => Math.abs(m.unexplainedCents) > m.toleranceCents)

const joined = (items: Array<[string, string]>): string => items.map(([n, v]) => `${n} ${v}`).join(' · ')
const nonZero = (items: Array<[string, number]>): Array<[string, number]> => items.filter(([, c]) => roundDiv(c, 100) !== 0)

const LEAK_NAME: Record<LeakItem['kind'], string> = {
  balance_gap: 'Balance gap',
  orphan_transfer: 'One-sided transfer',
  hidden_account: 'To a hidden account',
  month_end_unbracketed: 'No balance after month end',
  late_sync: 'Late sync',
  engine_error: 'Engine error'
}

// ---------- Take-home's and Elective's drills ----------

/** A paystub item's name in the pay-day table: Federal, State, Medical, 401(k), as a paystub's columns read. */
const ITEM_NAME: Record<PaystubItemKind, string> = {
  federal: 'Federal',
  social_security: 'Social Security',
  medicare: 'Medicare',
  state: 'State',
  local: 'Local',
  sdi: 'SDI / PFML',
  other_tax: 'Other tax',
  medical: 'Medical',
  dental: 'Dental',
  vision: 'Vision',
  life: 'Life',
  disability: 'Disability',
  fsa: 'FSA',
  dependent_care: 'Dependent care',
  commuter: 'Commuter',
  other_deduction: 'Other',
  '401k': '401(k)',
  roth_401k: 'Roth 401(k)',
  after_tax_401k: 'After-tax 401(k)',
  '403b': '403(b)',
  '457': '457(b)',
  hsa: 'HSA',
  espp: 'ESPP'
}

/** The span's payrolls by key and name, from Gross pay's parts (Take-home's when it stands alone): the paychecks a contribution plan can come out of. */
export const payrolls = (w: Waterfall): Array<{ key: string; name: string }> =>
  (w.rows.find((r) => r.id === 'gross') ?? w.rows.find((r) => r.id === 'takeHome'))?.parts.filter((p) => p.key.startsWith('pay:')).map((p) => ({ key: p.key.slice(4), name: p.name })) ?? []

/** A payroll as Home names it: its pay part's name (the series'), or its key's payee. */
const payrollName = (w: Waterfall, key: string): string => payrolls(w).find((p) => p.key === key)?.name ?? key.replace(/\|[+-]$/, '')

/** The span's first and last days. */
function spanDays(s: Span): { fromDay: string; toDay: string } {
  if (isDay(s.from)) return { fromDay: s.from, toDay: s.to }
  const last = new Date(Date.UTC(Number(s.to.slice(0, 4)), Number(s.to.slice(5, 7)), 0)).getUTCDate()
  return { fromDay: `${s.from}-01`, toDay: `${s.to}-${String(last).padStart(2, '0')}` }
}

/** A day three days on, as far as a check's deposits land from its first (spec 1.2). */
const threeOn = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10)

/**
 * Take-home's pay-day tables (spec 1.3): one per payroll, a column per check of the span, with its gross, each item
 * taken out (as negatives), net, deposit and, when a check's deposit isn't its net, the difference. The payroll's
 * name opens its deposits over the span, and a check's day opens that check's own deposits.
 */
export const payTables = (w: Waterfall): PayTableLine[] => payTablesOf(w.payChecks, spanDays(w.span), (key) => payrollName(w, key))

/** The pay-day tables of some checks over some days, each payroll named by `nameOf`: Take-home's, and Pay & benefits' for the year. */
export function payTablesOf(all: PayCheck[], days: { fromDay: string; toDay: string }, nameOf: (key: string) => string): PayTableLine[] {
  const byKey = new Map<string, PayCheck[]>()
  for (const c of all) byKey.set(c.paycheckKey, [...(byKey.get(c.paycheckKey) ?? []), c])
  const out: PayTableLine[] = []
  for (const [key, checks] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const name = nameOf(key)
    // Each item kind any check takes out, in the paystub's order: taxes, then benefits, then the savings plans.
    const kinds = PAYSTUB_ITEM_KINDS.filter((k) => checks.some((c) => c.items.some((x) => x.kind === k && x.cents !== 0)))
    const item = (c: PayCheck, k: PaystubItemKind): number => c.items.filter((x) => x.kind === k).reduce((t, x) => t + x.cents, 0)
    // A check on its deposits alone has no stub to tie to: its net is its deposit by definition. So the tie is marked
    // only when every check has a stub, and a payroll whose checks are all deposits with nothing taken out shows them alone.
    const tied = checks.every((c) => c.basis !== 'deposits' && c.differenceCents === 0)
    const depositsAlone = !kinds.length && checks.every((c) => c.basis === 'deposits')
    out.push({
      kind: 'payTable',
      key,
      name,
      drill: drillFilter({ ...days, cls: ['pay'], paycheckKey: key }, `Take-home · ${name}`),
      // A deposit split into regular pay and bonus is two checks on one transaction: each opens its own part of it.
      checks: checks.map((c) => ({
        label: `${dayName(c.day)}${c.kind === 'bonus' ? ' bonus' : ''}${c.basis === 'estimated' ? ' est.' : ''}`,
        drill: drillFilter({ fromDay: c.day, toDay: threeOn(c.day), cls: ['pay'], paycheckKey: key, ids: c.txnIds, bonus: c.kind === 'bonus' }, `${name}${c.kind === 'bonus' ? ' bonus' : ''}`)
      })),
      rows: [
        ...(depositsAlone
          ? []
          : [
              { kind: 'gross' as const, label: 'Gross', cells: checks.map((c) => money(c.grossCents)) },
              ...kinds.map((k) => ({ kind: 'item' as const, label: ITEM_NAME[k], cells: checks.map((c) => money(-item(c, k))) })),
              { kind: 'net' as const, label: 'Net', cells: checks.map((c) => money(c.netCents)) }
            ]),
        { kind: 'deposit', label: 'Deposit', cells: checks.map((c) => money(c.depositCents)) },
        ...(checks.every((c) => c.differenceCents === 0) ? [] : [{ kind: 'difference' as const, label: 'Difference', cells: checks.map((c) => (c.differenceCents > 0 ? `+${money(c.differenceCents)}` : c.differenceCents ? money(c.differenceCents) : '')) }])
      ],
      tied
    })
  }
  return out
}

/** Elective's groups in the order Home lists them: the home and the car, the rates charged, then the bills. */
export const GROUP_ORDER: CommittedGroup[] = ['housing', 'vehicles', 'debtCost', 'utilities', 'insurance', 'subscriptions', 'other']
export const GROUP_NAME: Record<CommittedGroup, string> = { housing: 'Housing', vehicles: 'Vehicles', debtCost: 'Debt cost', utilities: 'Utilities', insurance: 'Insurance', subscriptions: 'Subscriptions', other: 'Other' }

/** A part's run rate as a group's data reads it, a cost as a positive figure: "HOA 232". */
const runText = (p: StagePart): string => dollars(p.runRateCents ?? 0)

/** A debt's rate charged: "24.0%"; null without one. */
const rateText = (p: StagePart): string | null => (p.aprBp === null || p.aprBp === undefined ? null : aprText(p.aprBp))

/** A series' price before and in force: "15.49 > 17.99"; null with no change. */
const priceText = (p: StagePart): string | null => (p.price ? `${money(p.price.fromCents)} > ${money(p.price.toCents)}` : null)

/** A loan's interest and escrow apart, when the loan says what it holds in escrow: "interest 800 · escrow 380"; else the two together. */
const loanSplit = (p: StagePart): string =>
  p.escrowCents ? `interest ${dollars((p.runRateCents ?? 0) - p.escrowCents)} · escrow ${dollars(p.escrowCents)}` : `interest${p.escrowCents === null ? ' + escrow' : ''} ${runText(p)}`

/** Debts by the rate they charge, the highest first (Decision 19), one with no rate after them; a stable sort, so equal rates keep their order. */
const byRate = (parts: StagePart[]): StagePart[] => [...parts].sort((a, b) => (b.aprBp ?? -1) - (a.aprBp ?? -1))

/** The months a year before some months, as Utilities compares with them: "Oct 2025", "Jan–Oct 2025". */
function yearBefore(fromMonth: string, toMonth: string): string {
  const from = shiftMonth(fromMonth, -12)
  const to = shiftMonth(toMonth, -12)
  if (from === to) return monthName(from)
  return from.slice(0, 4) === to.slice(0, 4) ? `${monthShort(from)}–${monthShort(to)} ${to.slice(0, 4)}` : `${monthName(from)}–${monthName(to)}`
}

/**
 * What a Committed group holds, as one line of data (section 5's Elective): Debt cost each rate charged and its run
 * rate, the highest rate first (Decision 19); Utilities over the span's full months against the same months a year
 * before, when the books hold them; Subscriptions their price changes; any other group its parts by run rate, a
 * loan's interest and escrow apart.
 */
function groupLabel(group: CommittedGroup, parts: StagePart[]): string {
  const byRun = [...parts].sort((a, b) => (b.runRateCents ?? 0) - (a.runRateCents ?? 0) || b.actualCents - a.actualCents)
  if (group === 'debtCost') return byRate(byRun).map((p) => [p.name, rateText(p), runText(p)].filter(Boolean).join(' ')).join(' · ')
  const compared = parts[0]?.yearAgo
  if (group === 'utilities' && compared && parts.every((p) => p.yearAgo)) {
    const was = parts.reduce((t, p) => t + p.yearAgo!.wasCents, 0)
    const now = parts.reduce((t, p) => t + p.yearAgo!.cents, 0)
    if (was > 0) {
      const change = roundDiv((now - was) * 100, was)
      return `vs ${yearBefore(compared.fromMonth, compared.toMonth)} ${dollars(was)} ${change > 0 ? '+' : change < 0 ? MINUS : ''}${Math.abs(change)}%`
    }
  }
  if (group === 'subscriptions') {
    const changed = byRun.filter((p) => p.price)
    if (changed.length) return changed.map((p) => `${p.name} ${priceText(p)}`).join(' · ')
  }
  return byRun.map((p) => `${p.name} ${p.key.startsWith('loan:') ? loanSplit(p) : runText(p)}`).join(' · ')
}

/**
 * What a Committed part is, beside its figures (spec 1.4): a series' cadence, next payment (late when it was due and
 * hasn't come), price change and whether it's confirmed; a debt's rate and escrow.
 */
function partNote(p: StagePart, next: NextPayment | undefined): string | null {
  const marker = p.marker === 'unconfirmed' || p.confirmed === false ? 'unconfirmed' : p.marker === 'estimated' ? 'estimated' : null
  const bits = p.key.startsWith('series:')
    ? [p.cadence ? CADENCE_LABEL[p.cadence] : null, next ? (next.late ? 'late' : `next ${dayName(next.day)}`) : null, priceText(p), marker]
    : p.key.startsWith('loan:')
      ? [rateText(p), loanSplit(p), marker]
      : [rateText(p), marker]
  return bits.filter(Boolean).join(' · ') || null
}

/** What Home's open row reads beside the waterfall: Elective's view and open group, and each series' next payment from the one forecast Elective reads. */
export interface DrillState {
  electiveView?: ElectiveView
  /** the Committed group open under Elective */
  group?: CommittedGroup | null
  /** each series' next payment by its key, from getSpendable's items */
  nextDays?: ReadonlyMap<string, NextPayment>
  /** Left over's Everyday by category or by payee */
  leftOverView?: LeftOverView
  /** what Left over and Saved read beside the waterfall (getHomePlans): targets, habits, the one-off budget, goals and the debt plan's next target; null until it comes */
  plans?: HomePlans | null
}

/** A series' next payment in the forecast: its day (YYYY-MM-DD), and whether it was due and hasn't come, held today. */
export interface NextPayment {
  day: string
  late: boolean
}

/** Each series' first payment in the forecast: a series' next day under Elective, from the same list By date shows. */
export function nextDays(items: ReadonlyArray<{ seriesKey?: string; day: string; late?: boolean }>): Map<string, NextPayment> {
  const out = new Map<string, NextPayment>()
  for (const i of items) if (i.seriesKey && (!out.has(i.seriesKey) || i.day < out.get(i.seriesKey)!.day)) out.set(i.seriesKey, { day: i.day, late: !!i.late })
  return out
}

// ---------- Left over's and Saved's drills ----------

/** The payees Left over's Payees names one by one, the largest first; the rest, and any vendor the user hides, are one line. */
export const PAYEES_SHOWN = 12
/** The one-off items Saved names, the largest first; the line ends with all of them. */
export const ONE_OFFS_SHOWN = 5
/** One-offs' lines, and one-off income's: what the One-offs row reads. */
const ONE_OFF_CLASSES: LineClass[] = ['oneOff', 'oneOffIncome']

/**
 * A category's target as Left over shows it beside its figures, a cost negative, and with rollover on what carried
 * into the open month, beside that month alone: "target −400 · rollover +25".
 */
function targetNote(t: HomePlans['targets'][number] | undefined, carried: boolean): string | null {
  if (!t) return null
  return [`target ${dollars(-t.targetCents)}`, carried && t.rollover ? `rollover ${signed(t.rollover.carriedCents)}` : null].filter(Boolean).join(' · ')
}

/**
 * Whether the span's run rate is today's, so today's habits and trips ahead go with it: the habits are measured over
 * the three full months before the open month, the run-rate window of the open month and of the last full one, so
 * they sit under a span whose run rate is taken at either (spec 1.12), and under no earlier one.
 */
const todays = (w: Waterfall, plans: HomePlans | null | undefined): plans is HomePlans => !!plans && (w.endMonth === plans.month || w.endMonth === shiftMonth(plans.month, -1))

/**
 * A habit under its category (spec 1.5): how often, what it costs a month at home, and the commitment made for it
 * with how this month is going, all as data beside its name: a habit is a part of its category's spending, and habits
 * overlap (meals out, and those over $100), so none is a figure in the columns that add up. It opens the purchases it
 * was measured from. The one-offs' habit has no figure of its own: One-offs' row above has the run rate.
 */
const habitLine = (h: HomePlans['habits'][number], row: string): PartLine => {
  const note = [h.often, h.kind !== 'oneoff' && h.monthlyCents > 0 ? `${dollars(h.monthlyCents)}/mo` : null, h.commitment ? (h.progress ? `${h.commitment}: ${h.progress}` : h.commitment) : null].filter(Boolean).join(' · ') || null
  return {
    kind: 'part',
    key: `habit:${h.id}`,
    name: h.name,
    amount: '',
    perMonth: null,
    runRate: '',
    change: '',
    note,
    drill: h.drill ? drillFilter(h.drill, `${row} · ${h.name}`) : null,
    nested: true,
    // With no figures of its own, its data runs across the figures' columns.
    ...(note ? { beside: true } : {})
  }
}

/**
 * Left over's Payees (spec 1.5): Everyday over the span by payee, the largest first, each opening exactly its lines;
 * past the first PAYEES_SHOWN, and for a vendor the user hides, one line of the rest. They add up to Everyday.
 */
function payeeLines(w: Waterfall): PartLine[] {
  const days = spanDays(w.span)
  const line = (key: string, name: string, cents: number, perMonth: number | null, payees: string[]): PartLine => ({
    kind: 'part',
    key,
    name,
    amount: dollars(-cents),
    perMonth: perMonth === null ? null : dollars(-perMonth),
    runRate: '',
    change: '',
    note: null,
    drill: drillFilter({ ...days, cls: ['everyday'], owner: null, payees }, `Everyday · ${name}`),
    nested: false
  })
  const named = w.payees.filter((x) => x.name !== null).slice(0, PAYEES_SHOWN)
  const shownKeys = new Set(named.map((x) => x.key))
  const rest = w.payees.filter((x) => !shownKeys.has(x.key))
  const out = named.map((x) => line(`payee:${x.key}`, x.name!, x.cents, x.perMonthCents, [x.key]))
  if (rest.length) {
    const sum = (f: (x: Waterfall['payees'][number]) => number | null): number => rest.reduce((t, x) => t + (f(x) ?? 0), 0)
    out.push(line('payees:rest', `${rest.length.toLocaleString('en-US')} more`, sum((x) => x.cents), rest[0].perMonthCents === null ? null : sum((x) => x.perMonthCents), rest.map((x) => x.key)))
  }
  return out
}

// ---------- Growth's drill ----------

/** A tax treatment as the Investments page names it: Pre-tax, Roth, HSA, Taxable. */
const TREATMENT_NAME = Object.fromEntries(TAX_TREATMENTS.map((t) => [t.id, t.label])) as Record<TaxTreatment, string>

/** The view of Net worth that holds an account, as its Overview opens it: Investments, Property, or the Overview itself (money lent). */
const NET_VIEW_OF: Partial<Record<SheetGroup, NetView>> = { investments: 'investments', property: 'property' }

/**
 * An invested account's return as Growth's drill draws it (spec 1.7): over the span, as an average month on a longer
 * one, and its run rate, beside how it's taxed; — where it can't be measured, and then what its value did and what was
 * put in over those days, which the bridge's Revaluation holds. Growth has no change over 3 months. An investment or
 * retirement account opens the Investments page; an HSA held as cash is on no page of its own, and no lines add up to
 * its return, so it opens nothing.
 */
function accountLine(a: AccountReturn): AccountLine {
  const u = a.unmeasured
  const moved = u ? nonZero([['value', u.changeCents], ['put in', u.putInCents]]).map(([n, c]) => `${n} ${n === 'value' ? signed(c) : dollars(c)}`) : []
  return {
    kind: 'account',
    key: `return:${a.accountId}`,
    name: a.name,
    note: [TREATMENT_NAME[a.treatment], ...moved].join(' · '),
    amount: a.actualCents === null ? BLANK : dollars(a.actualCents),
    perMonth: a.perMonthCents === null ? null : dollars(a.perMonthCents),
    runRate: a.runRateCents === null ? BLANK : dollars(a.runRateCents),
    view: a.assetType === 'cash' ? null : 'investments'
  }
}

/**
 * A Personal asset's revaluation over the span (spec 1.7): a line of its own, so a name with a · in it reads whole. It
 * has no run rate. It opens the view of Net worth that holds the asset.
 */
const revaluationLine = (x: GrowthDrill['revaluation'][number]): AccountLine => ({
  kind: 'account',
  key: `revaluation:${x.accountId}`,
  name: x.name,
  note: 'Revaluation',
  amount: dollars(x.cents),
  perMonth: null,
  runRate: '',
  view: NET_VIEW_OF[SHEET_GROUP_OF[x.assetType]] ?? 'overview'
})

/**
 * The data lines an open row shows beside its rows (spec 1.10), from the rows and the Waterfall, and what its drill
 * read; under each part it draws, what moved in it since a changed month's close, and under Saved's cash and
 * Growth's net worth, what moved in the identity and the bridge.
 */
function details(w: Waterfall, open: Opened, names: ReadonlyMap<string, string>, drill: DrillState, closed: ClosedView): HomeLine[] {
  const row = (id: StageId): StageRow | undefined => w.rows.find((r) => r.id === id)
  const out: HomeLine[] = []
  const part = (id: StageId, p: StagePart, o?: Parameters<typeof partLine>[2]): void => void out.push(partLine(id, p, o), ...closed.part(id, p.key))
  const data = (key: string, label: string, text: string | null, more: Pick<DataLine, 'items' | 'to' | 'net'> = {}): void => {
    if (text) out.push({ kind: 'data', key, label, text, ...more })
  }
  const levers = (stage: StageId): void => data(`levers:${stage}`, 'Levers', leverLine(w.levers, stage))
  const e = w.employerAdds
  const employer = (): void =>
    data(
      'employer',
      'Employer adds',
      joined(
        nonZero([
          ['Match', e.matchCents],
          ['HSA', e.hsaCents],
          ['Premium share', e.premiumCents]
        ]).map(([n, c]) => [n, dollars(c)])
      )
    )
  switch (open) {
    case 'gross':
      for (const p of row('gross')?.parts ?? []) part('gross', p)
      employer()
      break
    case 'takeHome': {
      // With nothing off pay, Take-home stands for Gross pay, and its parts are where the money came from.
      if (!row('gross')) for (const p of row('takeHome')?.parts ?? []) part('takeHome', p)
      levers('takeHome')
      out.push(...payTables(w))
      data('limits', 'Limits', w.limits.map((l) => `${l.name} ${dollars(l.filledCents)} of ${dollars(l.limitCents)}${l.provisional ? ' est.' : ''}`).join(' · '))
      employer()
      out.push({ kind: 'slot', key: 'contributions' })
      const pages: DataItem[] = [
        { text: 'Pay & benefits', page: 'benefits' },
        { text: 'Taxes', page: 'taxes' }
      ]
      data('pages', '', pages.map((i) => i.text).join(' · '), { items: pages })
      break
    }
    case 'elective': {
      levers('elective')
      const view = drill.electiveView ?? 'groups'
      out.push({
        kind: 'switch',
        key: 'electiveView',
        value: view,
        options: [
          { id: 'groups', label: 'Groups' },
          { id: 'byDate', label: 'By date' }
        ]
      })
      if (view === 'byDate') out.push({ kind: 'slot', key: 'byDate' })
      else {
        const parts = row('committed')?.parts ?? []
        for (const g of GROUP_ORDER) {
          const mine = parts.filter((p) => (p.group ?? 'other') === g)
          if (!mine.length) continue
          const sum = (f: (p: StagePart) => number | null): number => mine.reduce((t, p) => t + (f(p) ?? 0), 0)
          const isOpen = drill.group === g
          out.push({
            kind: 'group',
            key: g,
            name: GROUP_NAME[g],
            amount: dollars(-sum((p) => p.actualCents)),
            perMonth: mine.every((p) => p.perMonthCents === null) ? null : dollars(-sum((p) => p.perMonthCents)),
            runRate: dollars(-sum((p) => p.runRateCents)),
            change: dollars(-sum((p) => p.changeCents)),
            label: groupLabel(g, mine),
            open: isOpen
          })
          // Open, it lists them as its line reads: Debt cost by rate, every other group by run rate.
          if (isOpen) for (const p of g === 'debtCost' ? byRate(mine) : mine) part('committed', p, { note: partNote(p, p.key.startsWith('series:') ? drill.nextDays?.get(p.key.slice(7)) : undefined), nested: true })
        }
      }
      // Each loan's principal, so the cash its payments take is in view beside Committed: it goes to Debt paid down, under Saved.
      const principal: DataItem[] = w.principal.map((d) => ({ text: `${d.name} ${dollars(d.cents)}`, drill: drillFilter(d.drill, `Principal · ${d.name}`) }))
      data('principal', 'Principal', principal.map((i) => i.text).join(' · '), { items: principal, to: 'saved' })
      break
    }
    case 'leftOver': {
      // The open month's Everyday to date, at the pace of the days at home so far, for the whole month (spec 1.5).
      const everyday = row('everyday')
      if (everyday && everyday.paceCents !== null) data('pace', 'Pace', dollars(-everyday.paceCents))
      levers('leftOver')
      const view = drill.leftOverView ?? 'categories'
      // The switch, when there's something to switch between: a span with no Everyday category or payee has neither.
      if (everyday?.parts.length || w.payees.length)
        out.push({
          kind: 'switch',
          key: 'leftOverView',
          value: view,
          options: [
            { id: 'categories', label: 'Categories' },
            { id: 'payees', label: 'Payees' }
          ]
        })
      if (view === 'payees') {
        out.push(...payeeLines(w))
        break
      }
      // Each Everyday category, Lifestyle and Essentials together, its tier a tag, with its target and, beside the open
      // month, its rollover; under it, while the span's run rate is theirs, its habits and the commitments made for them.
      const plans = drill.plans
      const targets = new Map((plans?.targets ?? []).map((t) => [t.categoryId, t]))
      const carried = !!plans && w.endMonth === plans.month
      const habits = todays(w, plans) ? plans.habits : []
      for (const p of everyday?.parts ?? []) {
        const id = p.key.startsWith('cat:') && p.key !== 'cat:none' ? Number(p.key.slice(4)) : null
        part('everyday', p, { tag: p.tag === 'essential' ? 'E' : p.tag === 'lifestyle' ? 'L' : undefined, note: id === null ? null : targetNote(targets.get(id), carried), beside: true })
        if (id !== null) for (const h of habits) if (h.categoryId === id) out.push(habitLine(h, ROW_NAME.leftOver))
      }
      break
    }
    case 'saved': {
      // One-offs (spec 1.6): its largest items and then all of them, the trips they were bought on, the one-off budget
      // and a commitment made for it. The 12-month average is its run rate.
      const days = spanDays(w.span)
      const items: DataItem[] = w.oneOffs.items
        .filter((i) => i.name !== null)
        .slice(0, ONE_OFFS_SHOWN)
        .map((i) => ({ text: `${i.name} ${dollars(i.cents)}`, drill: drillFilter({ ...days, cls: ONE_OFF_CLASSES, owner: null, ids: [i.txnId] }, `One-offs · ${i.name}`) }))
      if (w.oneOffs.count > items.length) items.push({ text: `All ${w.oneOffs.count.toLocaleString('en-US')}`, drill: drillFilter({ ...days, cls: ONE_OFF_CLASSES, owner: null }, ROW_NAME.oneOffs) })
      data('oneOffItems', 'Items', items.map((i) => i.text).join(' · '), { items })
      const trips: DataItem[] = w.oneOffs.trips.map((t) => ({ text: `${t.name} ${dollars(t.cents)}`, drill: drillFilter({ ...days, cls: ONE_OFF_CLASSES, owner: null, ids: t.ids }, `One-offs · ${t.name}`) }))
      // Then, beside a span whose run rate is today's, the trips not over yet that it hasn't listed, with their days
      // and what's been bought on them so far, as Budget's trip list had them.
      if (todays(w, drill.plans)) {
        const listed = new Set(w.oneOffs.trips.map((t) => `${t.name}|${t.fromDay}`))
        for (const t of drill.plans.trips) if (!listed.has(`${t.name}|${t.fromDay}`)) trips.push({ text: [t.name, `${dayName(t.fromDay)}–${dayName(t.toDay)}`, t.spentCents ? dollars(t.spentCents) : null].filter(Boolean).join(' ') })
      }
      data('trips', 'Trips', trips.map((i) => i.text).join(' · '), { items: trips })
      const target = drill.plans?.oneOffTargetCents ?? null
      // In the items' and trips' sign, what they cost as spent.
      if (target !== null) data('oneOffTarget', 'Target', dollars(target))
      if (todays(w, drill.plans)) for (const h of drill.plans.habits) if (h.kind === 'oneoff' && h.commitment) out.push(habitLine(h, ROW_NAME.oneOffs))
      const parts = row('saved')?.parts ?? []
      const name: Record<string, string> = { kept: 'Kept', atWork: 'Saved at work', employer: 'Employer saving' }
      for (const p of parts) part('saved', p, { name: name[p.key] ?? p.name })
      levers('saved')
      const id = w.identity
      data(
        'wentTo',
        'Went to',
        joined(
          nonZero([
            ['Savings', id.movedCents],
            ['Investments', id.toInvestmentsCents],
            ['Debt paid down', id.debtPaidCents],
            ['Bought assets', id.boughtCents],
            ['Checking', id.checkingCents]
          ]).map(([n, c]) => [n, dollars(c)])
        )
      )
      const within = !unexplainedAbove(w)
      const reconciling: Array<[string, string]> = nonZero([
        ['Ventures', id.venturesCents],
        ['Cash return', id.cashReturnCents],
        ['Unsorted', id.unsortedCents],
        ['In transit', id.inTransitCents]
      ]).map(([n, c]) => [n, signed(c)])
      reconciling.push(['Unexplained', `${dollars(id.unexplainedCents)} ${within ? '✓' : '!'}`])
      data('reconciling', 'Reconciling', joined(reconciling))
      out.push(...closed.identity)
      // The goals as goals.ts shows them today, and the debt the payoff plan pays extra on first, which opens Debts.
      const plans = drill.plans
      data('goals', 'Goals', (plans?.goals ?? []).map((g) => `${g.name} ${dollars(g.savedCents)} of ${dollars(g.targetCents)}`).join(' · '))
      const debt = plans?.nextDebt
      if (debt) {
        const rate = debt.aprBp === null ? '' : ` ${aprText(debt.aprBp)}${debt.promoEnds ? ` to ${monthName(debt.promoEnds.slice(0, 7))}` : ''}`
        data('debt', 'Debt', `next ${debt.name}${rate} · ${dollars(debt.owedCents)}`, { net: { view: 'debts', label: 'Debts' } })
      }
      break
    }
    case 'invested':
      for (const p of row('invested')?.parts ?? []) part('invested', p)
      // Invested's drill lists every one of its levers (spec 1.7): each yearly limit's room and savings above the goals.
      data('levers:invested', 'Levers', leverLine(w.levers, 'invested', w.levers.length))
      if (w.retirement) {
        const r = w.retirement
        data('retirement', `Retire at ${r.retireAge} in ${r.year}`, `${dollars(r.projectedCents)} today's dollars · invested ${dollars(r.investedCents)} · ${signed(r.contributionCents)}/mo · ${(r.realReturnBp / 100).toFixed(1)}% real`)
      }
      break
    case 'growth': {
      const parts = row('growth')?.parts ?? []
      // The returns measured over the span; — when none can be, before the month's statements are in.
      const returns = parts.filter((p) => p.key.startsWith('return:')).reduce((s, p) => s + p.actualCents, 0)
      const measured = !w.growth || w.growth.accounts.some((a) => a.actualCents !== null)
      const cash = parts.find((p) => p.key === 'cashReturn')
      // Cash return is the interest and dividends paid to cash: it opens those lines.
      const cashText = `Cash return ${dollars(cash?.actualCents ?? 0)}`
      const totals: DataItem[] = [
        { text: measured ? dollars(returns) : BLANK },
        cash ? { text: cashText, drill: drillFilter(cash.drill, 'Growth · Cash return') } : { text: cashText }
      ]
      data('returns', 'Returns', totals.map((i) => i.text).join(' · '), { items: totals })
      if (cash) out.push(...closed.part('growth', cash.key))
      // Net worth and its bridge, as the wireframe has them under Returns.
      const b = w.bridge
      data(
        'netWorth',
        `Net worth ${dollars(b.endCents)}`,
        `${signed(b.endCents - b.startCents)} = Saved ${dollars(b.savedCents)} + Growth ${dollars(b.growthCents)} + Revaluation ${dollars(b.revaluationCents)} + Ventures ${dollars(b.venturesCents)} + Unsorted ${dollars(b.unsortedCents)} ${MINUS} In transit ${dollars(b.inTransitCents)} ${MINUS} Unexplained ${dollars(b.unexplainedCents)} + Other ${dollars(b.otherCents)}`
      )
      out.push(...closed.bridge)
      // Then what's behind them (spec 1.7): returns by account, each with how it's taxed; by treatment where one
      // holds more than one account, as the account lines already say it otherwise; the 12 months' time-weighted
      // return; and each Personal asset's revaluation.
      const g = w.growth
      for (const a of g?.accounts ?? []) out.push(accountLine(a), ...closed.part('growth', `return:${a.accountId}`))
      // An account whose return a changed month closed with and the books no longer have (hidden, moved into a
      // venture, deleted since): what moved in it, under the accounts, so Growth's move is accounted for.
      out.push(...closed.parts('growth', new Set(['cashReturn', ...(g?.accounts ?? []).map((a) => `return:${a.accountId}`)])))
      if (g) {
        const earning = g.accounts.filter((a) => a.actualCents !== null || a.runRateCents !== null)
        const shared = g.byTreatment.some((t) => earning.filter((a) => a.treatment === t.treatment).length > 1)
        if (shared) data('byTreatment', 'By treatment', g.byTreatment.map((t) => `${TREATMENT_NAME[t.treatment]} ${dollars(t.actualCents)}`).join(' · '))
        if (g.twr.rate !== null) data('twr', 'TWR 12 mo', pct(Math.round(g.twr.rate * 1000) / 10))
        out.push(...g.revaluation.map(revaluationLine))
      }
      const pages: DataItem[] = [
        { text: 'Investments', page: 'networth', view: 'investments' },
        { text: 'Net worth', page: 'networth', view: 'overview' }
      ]
      data('pages', '', pages.map((i) => i.text).join(' · '), { items: pages })
      break
    }
    case 'unexplained':
      w.leaks
        .filter((l) => l.kind !== 'engine_error' || l.cents !== 0)
        .forEach((l, i) => {
          const days = l.fromDay && l.toDay ? `${dayName(l.fromDay)} – ${dayName(l.toDay)}` : null
          data(`leak:${i}`, LEAK_NAME[l.kind], [l.accountId ? (names.get(l.accountId) ?? l.accountId) : null, days, dollars(l.cents)].filter(Boolean).join(' · '))
        })
      break
  }
  return out
}

/**
 * Home's table over a Waterfall, with `open` open (spec 1.10): its rows; the rows leading into the open subtotal with
 * its Δ pts, its parts and its data lines; Unsorted when it isn't 0, and Unexplained above tolerance. `names` names
 * the accounts Unexplained's items are on; `drill` is what the open row's drill read beside the waterfall.
 *
 * While a month of the span is changed since its close, every figure that moved shows beside its close's (spec 2, On
 * Home): under its row, or under its part where the part is drawn. What isn't drawn (a row leading into a closed
 * subtotal, a part no drill draws, the identity under a closed Saved, the bridge under a closed Growth) shows under the
 * row it goes into when that row's own figures didn't move; where they did, they stand for it until it's opened.
 */
export function homeTable(w: Waterfall, open: Opened, names: ReadonlyMap<string, string> = new Map(), drill: DrillState = {}): HomeTable {
  const lines: HomeLine[] = []
  const closed = closedView(w, names)
  // The rows leading into a subtotal, and Gross pay into Take-home when Take-home stands for it today.
  const lessOf = (id: StageId): StageId[] => [...(LEADS_INTO[id] ?? []), ...(id === 'takeHome' && !w.rows.some((r) => r.id === 'gross') ? (['gross'] as StageId[]) : [])]
  const under = (id: StageId, drawn: ReadonlyMap<StageId, ReadonlySet<string>>): ClosedLine[] => {
    const own = closed.own(id)
    return own.length ? own : closed.parts(id, drawn.get(id) ?? NONE)
  }
  for (const id of MAIN_ROWS) {
    const r = w.rows.find((x) => x.id === id)
    if (!r) continue
    const isOpen = open === id
    const own = closed.own(id)
    lines.push(rowLine(w, r, { less: false, open: isOpen }), ...own)
    if (!isOpen) {
      if (!own.length) lines.push(...lessOf(id).flatMap((l) => under(l, new Map())), ...closed.parts(id, NONE), ...(id === 'saved' ? closed.identity : id === 'growth' ? closed.bridge : []))
      continue
    }
    const drawn = drawnParts(w, open, drill)
    for (const lessId of lessOf(id)) {
      // A row the close had and today hasn't (a Payroll difference gone back to 0) shows where it would be.
      const l = lessId === 'gross' ? undefined : w.rows.find((x) => x.id === lessId)
      if (l) lines.push(rowLine(w, l, { less: true, open: false }))
      lines.push(...under(lessId, drawn))
    }
    lines.push(...details(w, open, names, drill, closed))
    if (!own.length) lines.push(...closed.parts(id, drawn.get(id) ?? NONE))
  }
  if (w.unsorted.cents !== 0) lines.push({ kind: 'unsorted', count: w.unsorted.count, amount: dollars(w.unsorted.cents), focus: w.focus === 'unsorted', drill: unsortedFilter(w) })
  if (unexplainedAbove(w) || w.focus === 'unexplained') {
    lines.push({ kind: 'unexplained', amount: dollars(w.identity.unexplainedCents), focus: w.focus === 'unexplained', open: open === 'unexplained' })
    if (open === 'unexplained') lines.push(...details(w, open, names, drill, closed))
  }
  const trend = w.rows[0]?.trend.length ?? 12
  return { heading: { amount: spanHeading(w.span), spark: `${trend} mo` }, perMonth: w.rows.some((r) => r.perMonthCents !== null), lines }
}

/**
 * The Transactions list the Unsorted row opens: its own lines over the span, through linesFor, so the list's count
 * and sum are the row's. Uncategorized lines the ledger leaves out (a 401(k)'s, a transfer's other leg) or counts in
 * another row (pay, a bill, a one-off) aren't among them.
 */
export function unsortedFilter(w: Waterfall): TxnFilter {
  const s = w.span
  return { ...(isDay(s.from) ? { fromDay: s.from, toDay: s.to } : { month: s.from, toMonth: s.to }), cls: ['unsorted'], owner: null, name: 'Unsorted' }
}

/** The Spendable strip's figures: "1,240 through Nov 14". */
export const spendableText = (s: NonNullable<Waterfall['spendable']>): string => `${dollars(s.cents)} through ${dayName(s.untilDay)}`

/** The strip's figure and its last day apart, so its asterisk (spendNote) sits on the figure: "1,240", "Nov 14". */
export const spendableParts = (s: NonNullable<Waterfall['spendable']>): { figure: string; until: string } => ({ figure: dollars(s.cents), until: dayName(s.untilDay) })

/**
 * The one line behind the asterisk on Spendable's figure (Home's strip, its card, the first run's), at a risk that
 * can overestimate what's safe to spend: Most likely and Best case. None at Worst case.
 */
export function spendNote(risk: SpendRisk): string | null {
  if (risk === 'cautious') return null
  const label = (id: SpendRisk): string => SPEND_RISKS.find((r) => r.id === id)!.label
  return `* ${label(risk)} can overestimate; ${label('cautious')} errs low.`
}

// ---------- Walk and Sankey, from the rows ----------

/**
 * The span's chain as a walk (spec Decision 2), its bars the rows' own amounts: Gross pay, what comes off it at
 * work, Take-home, Committed off it, Elective, Everyday, Left over, One-offs, Kept, then Saved at work and employer
 * saving added, Saved. A step that would take off a negative amount adds it instead.
 */
export function walkSteps(w: Waterfall): WalkStep[] {
  const at = (id: StageId): StageRow | undefined => w.rows.find((r) => r.id === id)
  const part = (key: string): number => at('saved')?.parts.find((p) => p.key === key)?.actualCents ?? 0
  const out: WalkStep[] = []
  const total = (name: string, kind: FlowKind, cents: number): void => void out.push({ name, kind, cents, type: 'total' })
  const off = (name: string, kind: FlowKind, cents: number): void => {
    if (cents) out.push(cents > 0 ? { name, kind, cents, type: 'sub' } : { name, kind, cents: -cents, type: 'add' })
  }
  const on = (name: string, kind: FlowKind, cents: number): void => off(name, kind, -cents)
  const gross = at('gross')
  if (gross) {
    total('Gross pay', 'job', gross.actualCents)
    off('Taxes', 'tax', at('taxes')?.actualCents ?? 0)
    off('Benefits', 'benefit', at('benefits')?.actualCents ?? 0)
    off('Saved at work', 'saving', at('savedAtWork')?.actualCents ?? 0)
    on('Payroll difference', 'match', at('payrollDiff')?.actualCents ?? 0)
  }
  total('Take-home', 'pool', at('takeHome')?.actualCents ?? 0)
  off('Committed', 'spend', at('committed')?.actualCents ?? 0)
  total('Elective', 'pool', at('elective')?.actualCents ?? 0)
  off('Everyday', 'spend', at('everyday')?.actualCents ?? 0)
  total('Left over', 'pool', at('leftOver')?.actualCents ?? 0)
  off('One-offs', 'spend', at('oneOffs')?.actualCents ?? 0)
  total('Kept', 'left', part('kept'))
  on('Saved at work', 'saving', part('atWork'))
  on('Employer saving', 'match', part('employer'))
  total('Saved', 'saving', at('saved')?.actualCents ?? 0)
  return out
}

/** The Sankey's columns, left to right, each under the subtotal the chain reaches there. */
const SANKEY_COLUMNS = ['Gross pay', 'Take-home', 'Elective', 'Left over', 'Kept', 'Saved'] as const

/**
 * The span's chain as a Sankey, its nodes the rows: Gross pay into what comes off it at work and Take-home, Take-home
 * into Committed and Elective, Elective into Everyday and Left over, Left over into One-offs and Kept, and Kept, Saved
 * at work and employer saving into Saved. Each subtotal has its own column, in that order, with the rows that come off
 * the one before it, so every band runs left to right. A Sankey has no negative band: a subtotal at or below zero has
 * nothing flowing through it and no node, and a row that comes off below zero (refunds beyond what it took) gives
 * instead, from the column before. A cost beyond what's left is met from Savings or credit, drawn on in the column
 * before the first cost it meets; money coming back while a subtotal is below zero pays it back, after the last refund
 * that does. Every node's label is its row as the rows show it: what comes off pay or a subtotal below zero, Saved its
 * row though what flows into it is more by what Savings or credit met.
 */
export function sankeyFlow(w: Waterfall): FlowData {
  const row = (id: StageId): StageRow | undefined => w.rows.find((r) => r.id === id)
  const at = (id: StageId): number => row(id)?.actualCents ?? 0
  const savedPart = (key: string): number => row('saved')?.parts.find((p) => p.key === key)?.actualCents ?? 0
  const nodes: FlowNode[] = []
  const links: FlowData['links'] = []
  const index = new Map<string, number>()
  /** A node, once by its kind and name (or id), with the figure its label shows; its column is set where the chain reaches it. */
  const node = (name: string, kind: FlowKind, shownCents: number, opts: Partial<FlowNode> = {}): number => {
    const k = `${kind}:${opts.id ?? name}`
    if (!index.has(k)) index.set(k, nodes.push({ name, cents: 0, kind, column: -1, shownCents, ...opts }) - 1)
    return index.get(k)!
  }
  /** A row that comes off the one before it, labeled as the rows show it. */
  const less = (id: StageId, kind: FlowKind, opts: Partial<FlowNode> = {}): number => node(ROW_NAME[id], kind, shown(id, at(id)), opts)
  const place = (n: number, column: number): void => void (nodes[n].column < 0 && (nodes[n].column = column))
  const flow = (from: number, to: number, cents: number): void => void (cents > 0 && links.push({ source: from, target: to, value: cents }))
  const drawnOn = (): number => node('Savings or credit', 'short', 0, { rank: 9 })
  const paidBack = (): number => node('Savings or credit', 'short', 0, { rank: 9, id: 'Savings or credit paid back' })
  // One step of the chain, from a subtotal in one column to the next in the column after, through the rows between,
  // each a cost that takes money above zero and gives it below. What the subtotal holds pays the costs in order and
  // the rest goes on; what a cost below zero gives goes on after it. Savings or credit meets what the money in doesn't
  // reach, or is paid back what's beyond the next subtotal while the one before was below zero.
  const step = (column: number, from: number | null, fromCents: number, costs: Array<[node: number, cents: number]>, to: number, toCents: number): void => {
    const givers: Array<[number, number]> = from === null ? [] : [[from, Math.max(0, fromCents)]]
    const takers: Array<[number, number]> = []
    for (const [n, cents] of costs) {
      place(n, cents < 0 ? column : column + 1)
      ;(cents < 0 ? givers : takers).push([n, Math.abs(cents)])
    }
    place(to, column + 1)
    takers.push([to, Math.max(0, toCents)])
    const gap = takers.reduce((t, [, c]) => t + c, 0) - givers.reduce((t, [, c]) => t + c, 0)
    if (gap > 0) givers.push([drawnOn(), gap])
    if (gap < 0) takers.push([paidBack(), -gap])
    // Each giver pays each taker in turn, as far as it reaches.
    for (let i = 0, j = 0, g = givers[0]?.[1] ?? 0, t = takers[0][1]; i < givers.length && j < takers.length; ) {
      const cents = Math.min(g, t)
      flow(givers[i][0], takers[j][0], cents)
      g -= cents
      t -= cents
      if (!g) g = givers[++i]?.[1] ?? 0
      if (!t) t = takers[++j]?.[1] ?? 0
    }
  }
  const [GROSS, TAKE, ELECTIVE, LEFT, KEPT, SAVED] = SANKEY_COLUMNS.map((_, c) => c)
  const take = node('Take-home', 'pool', at('takeHome'), { open: true })
  if (row('gross')) {
    const payParts = (row('gross')?.parts ?? []).filter((p) => p.actualCents > 0).map((p) => ({ name: p.name, cents: p.actualCents }))
    const gross = node('Gross pay', 'job', at('gross'), payParts.length > 1 ? { parts: payParts } : {})
    // Gross pay heads the chain, below zero too, when Savings or credit stands before it.
    place(gross, GROSS)
    // Pay gives, what comes off it at work takes, and a Payroll difference above zero adds to Take-home.
    const diff = at('payrollDiff')
    const off: Array<[number, number]> = [
      [gross, -at('gross')],
      [less('taxes', 'tax'), at('taxes')],
      [less('benefits', 'benefit'), at('benefits')],
      [less('savedAtWork', 'saving', { open: true }), at('savedAtWork')],
      [less('payrollDiff', diff < 0 ? 'tax' : 'match'), -diff]
    ]
    step(GROSS, null, 0, off, take, at('takeHome'))
  } else {
    // Nothing comes off pay: Take-home is where the money starts, opening into its sources. Below zero, more went back
    // than came in, and Savings or credit met it.
    place(take, TAKE)
    const parts = (row('takeHome')?.parts ?? []).filter((p) => p.actualCents > 0).map((p) => ({ name: p.name, cents: p.actualCents }))
    if (parts.length > 1) Object.assign(nodes[take], { parts })
    flow(drawnOn(), take, -at('takeHome'))
  }
  const elective = node('Elective', 'pool', at('elective'), { open: true })
  step(TAKE, take, at('takeHome'), [[less('committed', 'spend'), at('committed')]], elective, at('elective'))
  const leftOver = node('Left over', 'pool', at('leftOver'), { open: true })
  step(ELECTIVE, elective, at('elective'), [[less('everyday', 'spend'), at('everyday')]], leftOver, at('leftOver'))
  const kept = node('Kept', 'left', savedPart('kept'), { open: true })
  step(LEFT, leftOver, at('leftOver'), [[less('oneOffs', 'spend'), at('oneOffs')]], kept, savedPart('kept'))
  // Saved is Kept, saving at work and the employer's saving, each that is above zero; what's below zero, and what
  // Savings or credit met beyond what was left, is why its row is less than what flows into it.
  const saved = node('Saved', 'saving', at('saved'))
  place(saved, SAVED)
  const atWork = less('savedAtWork', 'saving', { open: true })
  const employer = node('Employer saving', 'match', savedPart('employer'))
  for (const n of [atWork, employer]) place(n, KEPT)
  flow(kept, saved, savedPart('kept'))
  flow(atWork, saved, savedPart('atWork'))
  flow(employer, saved, savedPart('employer'))
  // Savings or credit stands just before the first cost it meets and just after the last refund that pays it back,
  // labeled what it gave and what it was given back.
  const into = new Map<number, number>()
  const outOf = new Map<number, number>()
  for (const l of links) {
    into.set(l.target, (into.get(l.target) ?? 0) + l.value)
    outOf.set(l.source, (outOf.get(l.source) ?? 0) + l.value)
  }
  for (const [n, side] of [
    [drawnOn(), -1],
    [paidBack(), 1]
  ] as const) {
    const ends = links.filter((l) => (side < 0 ? l.source : l.target) === n).map((l) => nodes[side < 0 ? l.target : l.source].column)
    if (!ends.length) continue
    nodes[n].column = side < 0 ? Math.min(...ends) - 1 : Math.max(...ends) + 1
    nodes[n].shownCents = side < 0 ? (outOf.get(n) ?? 0) : -(into.get(n) ?? 0)
  }
  // Each node is as large as what flows through it, under its column's subtotal (none over pay's column when there's
  // no Gross pay); one nothing flows through is dropped, and a column with nothing left in it closes up.
  const live = nodes.flatMap((_, i) => (into.has(i) || outOf.has(i) ? [i] : []))
  const columns = [...new Set(live.map((i) => nodes[i].column))].sort((a, b) => a - b)
  const stageOf = (column: number): string | undefined => (column === GROSS && !row('gross') ? undefined : SANKEY_COLUMNS[column])
  const placed = new Map(live.map((i, k) => [i, k]))
  const sized = live.map((i): FlowNode => ({ ...nodes[i], cents: Math.max(into.get(i) ?? 0, outOf.get(i) ?? 0), stage: stageOf(nodes[i].column), column: columns.indexOf(nodes[i].column) }))
  return { nodes: sized, links: links.map((l) => ({ source: placed.get(l.source)!, target: placed.get(l.target)!, value: l.value })) }
}
