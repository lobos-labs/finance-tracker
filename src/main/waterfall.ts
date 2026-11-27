import * as db from './db'
import { essentialTier } from './budget'
import { hsaLimit, plansOfCheck, structuredMatch } from './contributions'
import { listGoals } from './goals'
import { gainsOn, investedTrack, planFor, returnsByTreatment, twrTogether } from './investments'
import { capitalWindows, firstLedgerDay, isFundPart, ledgerLines, perimeter, personalPart, seriesByKey, type CapitalWindow, type LedgerLine } from './lines'
import { payrollChecks, payRunRates } from './paystubs'
import { vendorHider } from './privacy'
import { CADENCES } from './recurring'
import { listTaxYears } from './taxes'
import { daysAway, tripAt, tripWindows, type TripWindow } from './trips'
import { positionBook, positionsOn, type Position, type PositionBook } from './ventureMoney'
import { categoryRole } from '../shared/categoryRole'
import { limitsFor, type Limit } from '../shared/limits'
import { PAYSTUB_ITEMS, payeeName } from '../shared/payroll'
import type { Track } from '../shared/returns'
import { ratePct, roundDiv, shareCents } from '../shared/rounding'
import { addDays, daysBetween, daysInMonth, isRealDay, shiftMonth } from '../shared/zone'
import type {
  Account,
  AccountReturn,
  AssetType,
  Cadence,
  CashIdentity,
  CheckItem,
  ClassifiedLine,
  ClosedFigures,
  CloseStatus,
  CommittedGroup,
  GrowthDrill,
  LeakItem,
  Lever,
  LeverKind,
  LineClass,
  LineCounts,
  LineQuery,
  NetWorthBridge,
  PartFigures,
  PayBasis,
  PayCheck,
  PaystubItem,
  PaystubItemKind,
  PayRunRates,
  RateFrom,
  RecurringSeries,
  Retirement,
  Span,
  StageFigures,
  StageId,
  StagePart,
  StageRow,
  TrendPoint,
  Waterfall
} from '../shared/types'

// The Personal waterfall (spec 1.1 to 1.12): what was earned, what came off it at work, what was committed, what
// went day to day and once, and what was kept, saved and invested, over a span of months or days. Every line it
// reads comes from the classifier (lines.ts) and every check from paystubs.ts; ventures never enter a row.
//
// Each row has an amount (its sum over the span), a run rate (monthly, in force at the span's end), a rate (its
// share of the money it came from) and their changes over 3 months. The subtotals are differences, so the chain
// ties to the cent in every month and every span:
//   Gross pay - Taxes - Benefits - Saved at work + Payroll difference = Take-home
//   Take-home - Committed = Elective, Elective - Everyday = Left over, Left over - One-offs = Kept
//   Kept + Saved at work + employer saving = Saved
//   Saved at work + employer saving + money moved in from cash = Invested
// Take-home is what was deposited: pay deposits, plus other income, less income tax paid from the bank. The Payroll
// difference is what the deposits differ from the checks' net pay by.
//
// A month's run-rate window is the three months ending with it, or for the open month the three full months before
// it, so the open month's run rate is the latest full month's; its 12-month window is the twelve months ending the
// same way. The run rates:
//   - pay: each payroll's mean over the window's regular checks, times its checks a year, over 12 (paystubs.ts);
//     bonus checks count in every amount and in no run rate
//   - other income: its sum over the window, over 3; income tax paid from the bank as estimates: over 12 months,
//     over 12 (a refund, and a balance due from the year before, are left out)
//   - Committed: what is in force at the window's end: each live series at its latest price, each loan's interest
//     and escrow from its latest payment, and each card charged interest in the window's last month at what it
//     owed then times its rate, over 12; a card paid in full is charged nothing and adds nothing
//   - Everyday: its sum over the window, over the months spent at home
//   - One-offs, money moved to investments and Growth: their sums over 12 months, over 12
// A part's run rate (a payroll, a category, a series, a loan) is rounded once, and a row's is the sum of its
// parts'. A rate is the run rate's share of the run rate of the money it came from; over any span but one month,
// a span of days included, it is the share of the span's amounts. Growth is never trended month to month.
//
// The levers (spec 1.8) are money a row could gain a month, read from the same run rates at the span's end: a refund
// withheld all year, card and loan interest, prices and utilities up on a year before, categories over target, a
// match not taken, yearly limits not used and savings beyond the goals. The retirement line (spec 1.7) grows what is
// invested and the Invested run rate at the user's own real return to the age they retire at; it and the savings
// lever wait for the user's settings, which have no default.

/** Cadences a year, as a run rate counts them: an annual bill is a twelfth a month. */
const PER_YEAR: Record<Cadence, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, annual: 1 }
const MONTHLY = CADENCES.find((c) => c.id === 'monthly')!
/** How far back a series' price is read, as detectRecurring reads it. */
const LOOKBACK_DAYS = 400
const DEBTS = new Set<AssetType>(['loan', 'mortgage', 'other_debt'])
const INVESTED = new Set<AssetType>(['investment', 'retirement'])
/** Assets bought and sold with cash, as the classifier's capital windows have them: property, vehicles, other assets, money lent and stakes. */
const ASSETS = new Set<AssetType>(['property', 'vehicle', 'other_asset', 'receivable', 'venture'])
/** The classes Kept is made of: the ledger's lines Take-home, Committed, Everyday and One-offs read. */
const KEPT: LineClass[] = ['pay', 'income', 'tax', 'committed', 'debtCost', 'everyday', 'oneOff', 'oneOffIncome']
/** close.tolerance and focus.points when they aren't set (spec 7). */
const TOLERANCE = { cents: 500, bp: 50 }
const FOCUS_POINTS = 1
/** A balance due paid within $1 of what last year's return owed is that, not an estimate. */
const DUE_WITHIN = 100

/** The rows whose parts carry figures of their own; the subtotals between them are differences. */
type PartRow = 'gross' | 'taxes' | 'benefits' | 'savedAtWork' | 'payrollDiff' | 'committed' | 'everyday' | 'oneOffs' | 'saved' | 'invested' | 'growth'
/** A row's parts and their cents, positive as the row reads them: a cost is positive in Taxes, Committed, Everyday and One-offs. */
type Parts = Map<string, number>

/** The money each row came from (spec 1.1). */
const RATE_FROM: Record<StageId, RateFrom | null> = {
  gross: null,
  taxes: 'gross',
  benefits: 'gross',
  savedAtWork: 'gross',
  payrollDiff: 'gross',
  takeHome: 'gross',
  committed: 'takeHome',
  elective: 'takeHome',
  everyday: 'elective',
  leftOver: 'elective',
  oneOffs: 'leftOver',
  saved: 'earned',
  invested: 'saved',
  growth: 'investedBalance'
}
const ROLE: Record<StageId, StageRow['role']> = {
  gross: 'subtotal',
  taxes: 'less',
  benefits: 'less',
  savedAtWork: 'less',
  payrollDiff: 'less',
  takeHome: 'subtotal',
  committed: 'less',
  elective: 'subtotal',
  everyday: 'less',
  leftOver: 'subtotal',
  oneOffs: 'less',
  saved: 'subtotal',
  invested: 'subtotal',
  growth: 'subtotal'
}
const ORDER: StageId[] = ['gross', 'taxes', 'benefits', 'savedAtWork', 'payrollDiff', 'takeHome', 'committed', 'elective', 'everyday', 'leftOver', 'oneOffs', 'saved', 'invested', 'growth']
/** The rows whose rate reads pay, which carry where their pay comes from (spec 1.1, pay basis). */
const PAY_BASED = new Set<StageId>(['gross', 'taxes', 'benefits', 'savedAtWork', 'payrollDiff', 'takeHome', 'saved', 'invested'])
/** The rows the focus dot can go to for a falling rate: every subtotal but Gross pay and Growth. */
const FOCUSABLE: StageId[] = ['takeHome', 'elective', 'leftOver', 'saved', 'invested']
const PART_ROWS: PartRow[] = ['gross', 'taxes', 'benefits', 'savedAtWork', 'payrollDiff', 'committed', 'everyday', 'oneOffs', 'saved', 'invested', 'growth']

// ---------- months ----------

const isMonth = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const before = (day: string): string => addDays(day, -1)

/** The months from one to another (YYYY-MM), both included. */
function monthsFrom(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m)
  return out
}

/** A month's run-rate window: the three months ending with it, or for the open month (and any after it) the three full months before it. */
function windowOf(month: string, current: string): { from: string; to: string } {
  const to = month >= current ? shiftMonth(current, -1) : month
  return { from: shiftMonth(to, -2), to }
}

/** A month's 12-month window, ending as its run-rate window does. */
function yearOf(month: string, current: string): { from: string; to: string } {
  const to = windowOf(month, current).to
  return { from: shiftMonth(to, -11), to }
}

/** Twice the median of whole cents, which is whole: the middle one doubled, or the middle two added. */
const twiceMedian = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? 2 * s[m] : s[m - 1] + s[m]
}

const add = (p: Parts, key: string, cents: number): void => {
  if (cents) p.set(key, (p.get(key) ?? 0) + cents)
  else if (!p.has(key)) p.set(key, 0)
}
const total = (p: Parts): number => {
  let s = 0
  for (const c of p.values()) s += c
  return s
}

// ---------- what the ledger says ----------

/** A run of ledger lines tallied by the parts the rows read, each positive as its row reads it. */
interface Tally {
  /** income:<category> */
  income: Parts
  /** tax:estimated, tax:due and tax:refund, paid from the bank: a refund is negative */
  tax: Parts
  /** series:<key>, loan:<debt>, card:<card> and committed:other */
  committed: Parts
  /** cat:<category> */
  everyday: Parts
  /** cat:<category or none>: one-offs less one-off income */
  oneOffs: Parts
  /** pay:<payroll>: what its pay lines deposited */
  deposits: Parts
  /** <debt>: the principal paid on each debt, less what was borrowed on it */
  principal: Parts
  /** money moved in from cash to the Personal investment, retirement and HSA accounts */
  movedIn: number
  /** interest and dividends paid to the perimeter's accounts */
  cashReturn: number
  /** the Kept classes' lines summed as signed */
  kept: number
  unsorted: number
  unsortedCount: number
  /** the transactions behind each part, for drills that name them */
  ids: Map<string, Set<string>>
}

const emptyTally = (): Tally => ({ income: new Map(), tax: new Map(), committed: new Map(), everyday: new Map(), oneOffs: new Map(), deposits: new Map(), principal: new Map(), movedIn: 0, cashReturn: 0, kept: 0, unsorted: 0, unsortedCount: 0, ids: new Map() })

/** Several tallies as one. */
function sumTallies(list: Tally[]): Tally {
  const out = emptyTally()
  for (const t of list) {
    for (const k of ['income', 'tax', 'committed', 'everyday', 'oneOffs', 'deposits', 'principal'] as const) for (const [key, c] of t[k]) add(out[k], key, c)
    out.movedIn += t.movedIn
    out.cashReturn += t.cashReturn
    out.kept += t.kept
    out.unsorted += t.unsorted
    out.unsortedCount += t.unsortedCount
  }
  return out
}

/** A payroll's checks summed: gross, what came out, net and the employer's part beside them. */
interface PayTally {
  gross: number
  taxes: number
  benefits: number
  saved: number
  net: number
  employerSaving: number
  match: number
  hsa: number
  premium: number
}

function tallyChecks(checks: PayCheck[]): Map<string, PayTally> {
  const out = new Map<string, PayTally>()
  for (const c of checks) {
    let t = out.get(c.paycheckKey)
    if (!t) out.set(c.paycheckKey, (t = { gross: 0, taxes: 0, benefits: 0, saved: 0, net: 0, employerSaving: 0, match: 0, hsa: 0, premium: 0 }))
    t.gross += c.grossCents
    t.taxes += c.taxesCents
    t.benefits += c.benefitsCents
    t.saved += c.savedAtWorkCents
    t.net += c.netCents
    t.employerSaving += c.employerSavingCents
    t.premium += c.employerPremiumCents
    for (const x of c.items) {
      if (PAYSTUB_ITEMS[x.kind].row !== 'savedAtWork' || !x.employerCents) continue
      if (x.kind === 'hsa') t.hsa += x.employerCents
      else t.match += x.employerCents
    }
  }
  return out
}

/** The Personal investment, retirement and HSA accounts: what Invested goes into and Growth is earned on. */
export const investedAccounts = (accounts: Iterable<Account>): Account[] =>
  [...accounts].filter((a) => !a.hidden && a.bucketId === null && (INVESTED.has(a.assetType) || (a.assetType === 'cash' && db.taxTreatment(a) === 'hsa')))

/** Everything a waterfall reads, once: the lines and checks over the days it needs, and what's in force. */
interface Book {
  current: string
  /** the first day its lines are read from */
  fromDay: string
  lines: LedgerLine[]
  byMonth: Map<string, LedgerLine[]>
  checks: PayCheck[]
  accounts: Map<string, Account>
  categories: Map<number, string>
  /** each venture's name, for its draws and its loans to the user */
  ventures: Map<number, string>
  series: Map<string, RecurringSeries>
  trips: TripWindow[]
  essential: (category: string) => boolean
  /** each Personal series' committed payments: its days and Personal's cents, positive */
  points: Map<string, Array<{ day: string; cents: number }>>
  /** each Personal debt's payments: their interest and escrow (Personal's, positive, at Personal's use share), oldest first */
  loanPays: Map<string, Array<{ day: string; txnId: string; cents: number; seriesKey: string | null; estimated: boolean; shareBp: number }>>
  /** each card's months with interest or fees charged on it */
  cardMonths: Map<string, Set<string>>
  /** a card's balance at a day's end (owed is negative), for the days the run rates ask */
  cardBalance: (id: string, day: string) => number
  /** the Personal investment, retirement and HSA accounts, and what they held together at a day's end */
  invested: Account[]
  investedOn: (day: string) => number
  /** an invested account's values and flows as its returns measure them, read once: its gains and its time-weighted return read it */
  track: (id: string) => Track | null
  /** each invested account's gain by month */
  gains: Map<string, Map<string, number>>
  taxKind: (l: ClassifiedLine) => 'estimated' | 'due' | 'refund'
  tallies: Map<string, Tally>
  pay: Map<string, PayRunRates>
}

/**
 * Reads what the months asked for need: lines from `fromDay` to `toDay`, checks over them, card and invested
 * balances at the days the run rates read, and each invested account's gains over `gainMonths`.
 */
function readBook(fromDay: string, toDay: string, current: string, balanceDays: string[], gainMonths: string[]): Book {
  // Kept per data stamp (lines.ts), so Personal's totals over the same days read the same lines without classifying them again.
  const lines = ledgerLines(fromDay, toDay)
  const byMonth = new Map<string, LedgerLine[]>()
  for (const l of lines) {
    const m = l.day.slice(0, 7)
    const list = byMonth.get(m)
    if (list) list.push(l)
    else byMonth.set(m, [l])
  }
  const accounts = new Map(db.listAccounts().map((a) => [a.id, a]))
  const series = seriesByKey()

  const points = new Map<string, Array<{ day: string; cents: number }>>()
  const loanPays: Book['loanPays'] = new Map()
  const cardMonths = new Map<string, Set<string>>()
  for (const l of lines) {
    if (!personalPart(l)) continue
    if (l.cls === 'committed' && l.seriesKey) {
      let list = points.get(l.seriesKey)
      if (!list) points.set(l.seriesKey, (list = []))
      const last = list[list.length - 1]
      if (last?.day === l.day) last.cents -= l.cents
      else list.push({ day: l.day, cents: -l.cents })
    } else if (l.cls === 'debtCost' && l.debtId) {
      const debt = accounts.get(l.debtId)
      if (debt && DEBTS.has(debt.assetType)) {
        let list = loanPays.get(l.debtId)
        if (!list) loanPays.set(l.debtId, (list = []))
        const last = list[list.length - 1]
        if (last?.txnId === l.txnId) last.cents -= l.cents
        else list.push({ day: l.day, txnId: l.txnId, cents: -l.cents, seriesKey: l.seriesKey, estimated: l.estimated, shareBp: l.shareBp })
      } else if (debt?.assetType === 'credit_card') {
        let months = cardMonths.get(l.debtId)
        if (!months) cardMonths.set(l.debtId, (months = new Set()))
        months.add(l.day.slice(0, 7))
      }
    }
  }

  // Balances, read once over the days asked for.
  const days = [...new Set(balanceDays)].sort()
  const cards = [...cardMonths.keys()]
  const invested = investedAccounts(accounts.values())
  const ids = [...cards, ...invested.map((a) => a.id)]
  const balances = days.length && ids.length ? db.balancesOver(ids, days[0], days[days.length - 1]) : { days: [] as string[], byId: new Map<string, number[]>() }
  const at = new Map(balances.days.map((d, i) => [d, i]))
  const balance = (id: string, day: string): number => {
    const i = at.get(day)
    return i === undefined ? 0 : (balances.byId.get(id)?.[i] ?? 0)
  }

  // Each invested account's track, read the first time it's asked for and kept: its gains month by month, over a
  // span's days and its time-weighted return all read the same one.
  const tracks = new Map<string, Track | null>()
  const track = (id: string): Track | null => {
    if (!tracks.has(id)) {
      const a = accounts.get(id)
      tracks.set(id, a ? investedTrack(a) : null)
    }
    return tracks.get(id)!
  }
  // Each invested account's gain month by month, from its track.
  const gains = new Map<string, Map<string, number>>()
  if (gainMonths.length) {
    const bounds = [before(`${gainMonths[0]}-01`), ...gainMonths.map(lastDayOf)]
    for (const a of invested) {
      const g = gainsOn(track(a.id), bounds)
      gainMonths.forEach((m, i) => {
        if (g[i] === null) return
        let byAccount = gains.get(m)
        if (!byAccount) gains.set(m, (byAccount = new Map()))
        byAccount.set(a.id, g[i]!)
      })
    }
  }

  // Income tax paid from the bank: a balance due is flagged one-time, or paid by Oct 15 within $1 of what the year
  // before's filed return owed; a refund is money in; anything else is an estimate.
  const owed = new Map<number, number>()
  for (const y of listTaxYears()) if (y.status === 'filed' && y.refundCents !== null && y.refundCents < 0) owed.set(y.year, -y.refundCents)
  const taxIds = [...new Set(lines.filter((l) => l.cls === 'tax').map((l) => l.txnId))]
  const oneTime = new Set<string>()
  for (let i = 0; i < taxIds.length; i += 500) {
    const chunk = taxIds.slice(i, i + 500)
    for (const r of db.all<{ id: string; split: number | null }>(`SELECT t.id, t.split_id AS split FROM ${db.TXN_LINES} t WHERE t.one_time = 1 AND t.id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) oneTime.add(`${r.id}:${r.split ?? ''}`)
  }
  const taxKind = (l: ClassifiedLine): 'estimated' | 'due' | 'refund' => {
    if (l.cents > 0) return 'refund'
    if (oneTime.has(`${l.txnId}:${l.splitId ?? ''}`)) return 'due'
    const due = owed.get(Number(l.day.slice(0, 4)) - 1)
    return due !== undefined && l.day.slice(5) <= '10-15' && Math.abs(-l.cents - due) <= DUE_WITHIN ? 'due' : 'estimated'
  }

  const checks = payrollChecks(fromDay, toDay)
  return {
    current,
    fromDay,
    lines,
    byMonth,
    checks,
    accounts,
    categories: new Map(db.listCategories().map((c) => [c.id, c.name])),
    ventures: new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM buckets').map((b) => [b.id, b.name])),
    series,
    trips: tripWindows(),
    essential: essentialTier(),
    points,
    loanPays,
    cardMonths,
    cardBalance: balance,
    invested,
    investedOn: (day) => invested.reduce((s, a) => s + balance(a.id, day), 0),
    track,
    gains,
    taxKind,
    tallies: new Map(),
    pay: new Map()
  }
}

/** The ledger's lines tallied by part. */
function tally(book: Book, lines: ClassifiedLine[]): Tally {
  const t = emptyTally()
  const note = (key: string, id: string): void => {
    let s = t.ids.get(key)
    if (!s) t.ids.set(key, (s = new Set()))
    s.add(id)
  }
  for (const l of lines) {
    if (!personalPart(l)) continue
    if (KEPT.includes(l.cls)) t.kept += l.cents
    switch (l.cls) {
      case 'pay':
        add(t.deposits, `pay:${l.paycheckKey}`, l.cents)
        break
      case 'income':
        // A regular draw from a venture is a part of Gross pay of its own, beside other income by category.
        add(t.income, l.intent === 'draw' && l.ventureId !== null ? `draw:${l.ventureId}` : `income:${l.categoryId ?? 'none'}`, l.cents)
        break
      case 'tax': {
        const key = `tax:${book.taxKind(l)}`
        add(t.tax, key, -l.cents)
        note(key, l.txnId)
        break
      }
      case 'committed':
      case 'debtCost': {
        const key = committedKey(book, l)
        add(t.committed, key, -l.cents)
        note(key, l.txnId)
        break
      }
      case 'everyday':
        add(t.everyday, `cat:${l.categoryId ?? 'none'}`, -l.cents)
        break
      case 'oneOff':
      case 'oneOffIncome':
        // An irregular draw is a One-off of its venture's, as a regular one is a part of Gross pay.
        add(t.oneOffs, l.intent === 'draw' && l.ventureId !== null ? `draw:${l.ventureId}` : `cat:${l.categoryId ?? 'none'}`, -l.cents)
        break
      case 'principal':
        if (l.debtId) {
          add(t.principal, l.debtId, -l.cents)
          note(`principal:${l.debtId}`, l.txnId)
        }
        break
      case 'invested':
        t.movedIn -= l.cents
        break
      case 'cashReturn':
        t.cashReturn += l.cents
        break
      case 'unsorted':
        t.unsorted += l.cents
        t.unsortedCount++
        note('unsorted', l.txnId)
        break
    }
  }
  return t
}

/** The Committed part a line is in: its series, the loan its interest is on (a venture's loan to the user by the venture), the card charged, or other. */
function committedKey(book: Book, l: ClassifiedLine): string {
  if (l.cls === 'committed') return l.seriesKey ? `series:${l.seriesKey}` : 'committed:other'
  if (l.intent === 'venture_loan_repayment' && l.ventureId !== null) return `ventureLoan:${l.ventureId}`
  const debt = l.debtId ? book.accounts.get(l.debtId) : undefined
  if (debt && DEBTS.has(debt.assetType)) return `loan:${debt.id}`
  if (debt?.assetType === 'credit_card') return `card:${debt.id}`
  return 'committed:other'
}

const monthTally = (book: Book, month: string): Tally => {
  let t = book.tallies.get(month)
  if (!t) book.tallies.set(month, (t = tally(book, book.byMonth.get(month) ?? [])))
  return t
}
const windowTally = (book: Book, w: { from: string; to: string }): Tally => sumTallies(monthsFrom(w.from, w.to).map((m) => monthTally(book, m)))

// ---------- figures ----------

/** A span's or a month's figures: each row's parts, the rows, and the bases the rates read. */
interface Figures {
  parts: Record<PartRow, Parts>
  rows: Record<StageId, number>
  employerSaving: number
  investedBalance: number
  basis: PayBasis | null
  markers: Map<string, NonNullable<StagePart['marker']>>
  /** what's in force behind Committed's parts: a series' price before and after a change, a loan's escrow */
  force: Pick<InForce, 'prices' | 'escrow' | 'aprs'>
}

const NO_FORCE: Figures['force'] = { prices: new Map(), escrow: new Map(), aprs: new Map() }

const emptyParts = (): Record<PartRow, Parts> => Object.fromEntries(PART_ROWS.map((r) => [r, new Map()])) as Record<PartRow, Parts>

/** The subtotals from the parts: each a difference, so the chain ties. Saved's parts are filled in here. */
function withRows(parts: Record<PartRow, Parts>, employerSaving: number, investedBalance: number, basis: PayBasis | null, markers: Figures['markers'], force: Figures['force'] = NO_FORCE): Figures {
  const gross = total(parts.gross)
  const taxes = total(parts.taxes)
  const benefits = total(parts.benefits)
  const savedAtWork = total(parts.savedAtWork)
  const payrollDiff = total(parts.payrollDiff)
  const takeHome = gross - taxes - benefits - savedAtWork + payrollDiff
  const committed = total(parts.committed)
  const elective = takeHome - committed
  const everyday = total(parts.everyday)
  const leftOver = elective - everyday
  const oneOffs = total(parts.oneOffs)
  const kept = leftOver - oneOffs
  parts.saved = new Map([
    ['kept', kept],
    ['atWork', savedAtWork],
    ['employer', employerSaving]
  ])
  const saved = kept + savedAtWork + employerSaving
  const rows: Record<StageId, number> = { gross, taxes, benefits, savedAtWork, payrollDiff, takeHome, committed, elective, everyday, leftOver, oneOffs, saved, invested: total(parts.invested), growth: total(parts.growth) }
  return { parts, rows, employerSaving, investedBalance, basis, markers, force }
}

/** The figures over a span: the sums of its lines, its checks and its accounts' gains. */
function spanFigures(book: Book, fromDay: string, toDay: string, months: string[] | null): { figures: Figures; tally: Tally; checks: PayCheck[]; employer: Waterfall['employerAdds']; lines: LedgerLine[] } {
  const lines = months ? months.flatMap((m) => book.byMonth.get(m) ?? []) : book.lines.filter((l) => l.day >= fromDay && l.day <= toDay)
  const t = tally(book, lines)
  const checks = book.checks.filter((c) => c.day >= fromDay && c.day <= toDay)
  const pay = tallyChecks(checks)
  const parts = emptyParts()
  const keys = new Set([...pay.keys(), ...[...t.deposits.keys()].map((k) => k.slice(4))])
  let employerSaving = 0
  const employer = { matchCents: 0, hsaCents: 0, premiumCents: 0 }
  for (const key of [...keys].sort()) {
    const p = pay.get(key)
    const k = `pay:${key}`
    add(parts.gross, k, p?.gross ?? 0)
    add(parts.taxes, k, p?.taxes ?? 0)
    add(parts.benefits, k, p?.benefits ?? 0)
    add(parts.savedAtWork, k, p?.saved ?? 0)
    add(parts.payrollDiff, k, (t.deposits.get(k) ?? 0) - (p?.net ?? 0))
    employerSaving += p?.employerSaving ?? 0
    employer.matchCents += p?.match ?? 0
    employer.hsaCents += p?.hsa ?? 0
    employer.premiumCents += p?.premium ?? 0
  }
  for (const [k, c] of t.income) add(parts.gross, k, c)
  for (const [k, c] of t.tax) add(parts.taxes, k, c)
  for (const [k, c] of t.committed) add(parts.committed, k, c)
  for (const [k, c] of t.everyday) add(parts.everyday, k, c)
  for (const [k, c] of t.oneOffs) add(parts.oneOffs, k, c)
  const savedAtWork = total(parts.savedAtWork)
  parts.invested = new Map([
    ['atWork', savedAtWork],
    ['employer', employerSaving],
    ['fromCash', t.movedIn]
  ])
  // Returns: each month's, or for a span of days, the gain over those days.
  const returns = new Map<string, number>()
  if (months) {
    for (const m of months) for (const [id, c] of book.gains.get(m) ?? []) add(returns, `return:${id}`, c)
  } else {
    for (const a of book.invested) {
      const [g] = gainsOn(book.track(a.id), [before(fromDay), toDay])
      if (g !== null && g !== undefined) add(returns, `return:${a.id}`, g)
    }
  }
  for (const [k, c] of returns) add(parts.growth, k, c)
  add(parts.growth, 'cashReturn', t.cashReturn)
  const balanceDay = before(fromDay)
  const figures = withRows(parts, employerSaving, book.investedOn(balanceDay), leastExact(checks.map((c) => c.basis)), new Map())
  return { figures, tally: t, checks, employer, lines }
}

const BASIS_ORDER: PayBasis[] = ['paystub', 'estimated', 'deposits']
const leastExact = (bases: PayBasis[]): PayBasis | null => (bases.length ? BASIS_ORDER[Math.max(...bases.map((b) => BASIS_ORDER.indexOf(b)))] : null)

/** A month's pay run rates, read once. */
function payRates(book: Book, month: string): PayRunRates {
  let r = book.pay.get(month)
  if (!r) book.pay.set(month, (r = payRunRates(month)))
  return r
}

/** How live a payment still is at a day: no more than two of its periods and its grace late, as a series stops (recurring.ts). */
const liveAt = (cadence: (typeof CADENCES)[number], last: string, day: string): boolean => daysBetween(last, day) <= 2 * cadence.days + cadence.grace

/** What's committed in force at a month: each part's run rate and marker, and what the Elective drill shows beside them. */
interface InForce {
  parts: Parts
  markers: Figures['markers']
  /** each loan's interest alone, without its escrow, and its latest payment */
  interest: Map<string, { cents: number; txnId: string }>
  /** a series whose price changed at its latest payment: a payment's price before and the price in force */
  prices: Map<string, { fromCents: number; toCents: number }>
  /** each loan's escrow in its run rate; null when the loan doesn't say what it holds in escrow */
  escrow: Map<string, number | null>
  /** each card's rate in force, in basis points: the promo rate until it ends */
  aprs: Map<string, number>
}

/**
 * What's committed in force at a month's run-rate window's end (spec 1.1, Committed), and each loan's interest
 * alone in it, without its escrow: what paying the loan off or refinancing it would cut (spec 1.8).
 */
function inForce(book: Book, month: string): InForce {
  const w = windowOf(month, book.current)
  const end = lastDayOf(w.to)
  const parts: Parts = new Map()
  const markers: Figures['markers'] = new Map()
  const interest = new Map<string, { cents: number; txnId: string }>()
  const prices: InForce['prices'] = new Map()
  const escrowOf: InForce['escrow'] = new Map()
  const aprs: InForce['aprs'] = new Map()
  // Each live series at its latest price: the median of its latest six payments (recurring.ts), or, when its price
  // changed among them, of the payments since, so a new price stays in force after the payment that brought it.
  // A series whose amount varies has no price change.
  for (const [key, all] of book.points) {
    const s = book.series.get(key)
    const cadence = CADENCES.find((c) => c.id === s?.cadence) ?? MONTHLY
    const pts = all.filter((p) => p.day <= end && daysBetween(p.day, end) < LOOKBACK_DAYS)
    const last = pts[pts.length - 1]
    if (!last || !liveAt(cadence, last.day, end)) continue
    const recent = pts.slice(-6).map((p) => p.cents)
    let since = 0
    if (!s?.variable) for (let i = recent.length - 1; i > 0 && !since; i--) if (Math.abs(recent[i] - recent[i - 1]) >= Math.max(50, Math.abs(recent[i - 1]) * 0.02)) since = i
    // The median doubled, so it stays whole and the run rate is rounded once.
    parts.set(`series:${key}`, roundDiv(twiceMedian(recent.slice(since)) * PER_YEAR[cadence.id], 24))
    if (since && since === recent.length - 1) {
      markers.set(`series:${key}`, 'priceChange')
      prices.set(`series:${key}`, { fromCents: recent[since - 1], toCents: recent[since] })
    }
  }
  // Each loan's interest and escrow from its latest payment, times its payments a year, over 12.
  for (const [debtId, pays] of book.loanPays) {
    let last: (typeof pays)[number] | undefined
    for (const p of pays) if (p.day <= end) last = p
    if (!last) continue
    const s = last.seriesKey ? book.series.get(last.seriesKey) : undefined
    const cadence = CADENCES.find((c) => c.id === s?.cadence) ?? MONTHLY
    if (!liveAt(cadence, last.day, end)) continue
    parts.set(`loan:${debtId}`, roundDiv(last.cents * PER_YEAR[cadence.id], 12))
    if (last.estimated) markers.set(`loan:${debtId}`, 'estimated')
    // The escrow in the payment is what the debt says it holds, at Personal's share, never more than Personal paid.
    const debt = book.accounts.get(debtId)
    const held = debt?.escrowCents ?? null
    const escrow = Math.min(last.cents, shareCents(held ?? 0, last.shareBp))
    interest.set(debtId, { cents: roundDiv((last.cents - escrow) * PER_YEAR[cadence.id], 12), txnId: last.txnId })
    // Its run rate's escrow is what's left of it beside the interest, so the two add up to the part. A loan on a home
    // (a mortgage, or a loan on a property) may hold escrow it doesn't say; any other loan, a car's or a student
    // loan, holds none.
    const home = debt?.assetType === 'mortgage' || (!!debt?.linkedAssetId && book.accounts.get(debt.linkedAssetId)?.assetType === 'property')
    escrowOf.set(debtId, held === null && home ? null : parts.get(`loan:${debtId}`)! - interest.get(debtId)!.cents)
  }
  // Each card charged interest in the window's last month: what it owed at that month's end times the rate in force
  // then (the promo rate until it ends), over 12.
  for (const [cardId, months] of book.cardMonths) {
    if (!months.has(w.to)) continue
    const a = book.accounts.get(cardId)!
    const apr = a.promoEnds && end <= a.promoEnds && a.promoApr !== null ? a.promoApr : a.apr
    if (apr === null) continue
    const owed = Math.max(0, -book.cardBalance(cardId, end))
    parts.set(`card:${cardId}`, roundDiv(owed * Math.round(apr * 100), 120_000))
    aprs.set(cardId, Math.round(apr * 100))
  }
  return { parts, markers, interest, prices, escrow: escrowOf, aprs }
}

/** An account's rate, in basis points; null without one. */
const aprBpOf = (a: Account | undefined): number | null => (a?.apr === null || a?.apr === undefined ? null : Math.round(a.apr * 100))

/** The days spent away (on a trip) over some months, whole. */
const awayOver = (book: Book, from: string, to: string): number => Math.round(daysAway(book.trips, db.dayStart(`${from}-01`), db.dayStart(`${shiftMonth(to, 1)}-01`)))

/** A month's run rates: every part's, and the rows from them. */
function monthRates(book: Book, month: string): Figures {
  const w = windowOf(month, book.current)
  const y = yearOf(month, book.current)
  const tw = windowTally(book, w)
  const ty = windowTally(book, y)
  const pay = payRates(book, month)
  const parts = emptyParts()
  for (const k of pay.keys) {
    const key = `pay:${k.paycheckKey}`
    add(parts.gross, key, k.grossCents)
    add(parts.taxes, key, k.taxesCents)
    add(parts.benefits, key, k.benefitsCents)
    add(parts.savedAtWork, key, k.savedAtWorkCents)
    add(parts.payrollDiff, key, k.payrollDiffCents)
  }
  for (const [k, c] of tw.income) add(parts.gross, k, roundDiv(c, 3))
  const estimated = ty.tax.get('tax:estimated')
  if (estimated !== undefined) add(parts.taxes, 'tax:estimated', roundDiv(estimated, 12))
  const committed = inForce(book, month)
  parts.committed = committed.parts
  // Interest on a venture's loan to the user has no balances to price it in force: its sum over the 12-month window, over 12.
  for (const [k, c] of ty.committed) if (k.startsWith('ventureLoan:')) add(parts.committed, k, roundDiv(c, 12))
  // Everyday over the months spent at home: three, less the days away over 30.44 (spendModel.ts), at least one.
  const homeHundredths = Math.max(3044, 9132 - 100 * awayOver(book, w.from, w.to))
  for (const [k, c] of tw.everyday) add(parts.everyday, k, roundDiv(c * 3044, homeHundredths))
  for (const [k, c] of ty.oneOffs) add(parts.oneOffs, k, roundDiv(c, 12))
  const savedAtWork = pay.totals.savedAtWorkCents
  const employerSaving = pay.totals.employerSavingCents
  parts.invested = new Map([
    ['atWork', savedAtWork],
    ['employer', employerSaving],
    ['fromCash', roundDiv(ty.movedIn, 12)]
  ])
  const returns = new Map<string, number>()
  for (const m of monthsFrom(y.from, y.to)) for (const [id, c] of book.gains.get(m) ?? []) add(returns, `return:${id}`, c)
  for (const [k, c] of returns) add(parts.growth, k, roundDiv(c, 12))
  add(parts.growth, 'cashReturn', roundDiv(ty.cashReturn, 12))
  // Growth's base is what was invested when the window's last month began.
  return withRows(parts, employerSaving, book.investedOn(before(`${w.to}-01`)), pay.basis, committed.markers, { prices: committed.prices, escrow: committed.escrow, aprs: committed.aprs })
}

// ---------- rates ----------

const baseOf = (f: Figures, from: RateFrom): number => (from === 'earned' ? f.rows.gross + f.employerSaving : from === 'investedBalance' ? f.investedBalance : f.rows[from])

/** Paystub and estimated pay compare; pay on deposits alone compares only with itself. */
const comparable = (a: PayBasis | null, b: PayBasis | null): boolean => a === null || b === null || (a === 'deposits') === (b === 'deposits')

/**
 * How far a rate a / b moved from an earlier a0 / b0, in tenths of a point: 1000 times the difference of the exact
 * ratios, rounded half away from zero (spec 1.1), and whether it fell by at least `points`. Integer arithmetic
 * throughout, so the answer is the same on every machine. Null when either base is zero or less.
 */
function rateChange(a: number, b: number, a0: number, b0: number, points: number): { tenths: number; fell: boolean } | null {
  if (b <= 0 || b0 <= 0) return null
  const num = BigInt(a) * BigInt(b0) - BigInt(a0) * BigInt(b)
  const den = BigInt(b) * BigInt(b0)
  const mag = num < 0n ? -num : num
  const q = (2000n * mag + den) / (2n * den)
  const tenths = Number(num < 0n ? -q : q)
  // Fell by points or more, unrounded: 100 (a0 / b0 - a / b) >= points, with points in thousandths.
  const fell = -num * 100_000n >= BigInt(Math.round(points * 1000)) * den
  return { tenths, fell }
}

// ---------- the waterfall ----------

interface ParsedSpan {
  span: Span
  days: boolean
  fromDay: string
  toDay: string
  /** the span's months, first to last */
  months: string[]
}

/**
 * A span's amount as an average month (spec 1.12): over its months, or its days over 30.44, and only when the span is
 * longer than one month; null otherwise.
 */
function perMonth(cents: number, p: ParsedSpan): number | null {
  const days = daysBetween(p.fromDay, p.toDay) + 1
  if (p.days ? days <= 30.44 : p.months.length <= 1) return null
  return p.days ? roundDiv(cents * 3044, days * 100) : roundDiv(cents, p.months.length)
}

/** A span as asked, cut at the current month (a span of months) or at today (a span of days), as nothing after has happened. */
function parseSpan(span: Span, today: string): ParsedSpan {
  const from = String(span?.from ?? '')
  const to = String(span?.to ?? '')
  if (isMonth(from) && isMonth(to)) {
    if (to < from) throw new Error('A span runs from an earlier month to a later one')
    const current = today.slice(0, 7)
    const last = to > current ? current : to
    const first = from > last ? last : from
    return { span: { from: first, to: last }, days: false, fromDay: `${first}-01`, toDay: lastDayOf(last), months: monthsFrom(first, last) }
  }
  if (isRealDay(from) && isRealDay(to)) {
    if (to < from) throw new Error('A span runs from an earlier day to a later one')
    const last = to > today ? today : to
    const first = from > last ? last : from
    return { span: { from: first, to: last }, days: true, fromDay: first, toDay: last, months: monthsFrom(first.slice(0, 7), last.slice(0, 7)) }
  }
  throw new Error('A span is two months like 2026-10, or two days like 2026-10-01')
}

function setting<T>(key: string, fallback: T): T {
  try {
    const v = db.getSetting(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

/**
 * The Personal waterfall over a span of months (YYYY-MM) or days (YYYY-MM-DD), both ends included (spec 1.12), cut
 * at the current month or at today. Amounts are the span's sums; run rates are monthly and in force at its end, the
 * last full month's when it ends in the open month or inside a month; Δ 3 mo, Δ pts and the focus dot are taken
 * there too. Rates are shares of run rates for a span of one month, and of the span's amounts for any other span, a
 * span of days included. The sparkline is the twelve months ending at the span's end, or every month of a longer
 * span. Each month's status is its latest close's (snapshots.ts), or open while it has none.
 */
export function getWaterfall(span: Span): Waterfall {
  return build(span).waterfall
}

/**
 * What a month's close freezes (snapshots.ts): the month's waterfall; its ledger's lines; the balance at the end of
 * the day before it and of its last day of every account the bridge reads (the perimeter, the invested accounts,
 * Personal's assets and debts and the venture accounts net worth counts); and the perimeter's balance gaps in it.
 * All read once, as getWaterfall reads them, so the close holds what Home showed for the month.
 */
export function monthClose(month: string): { waterfall: Waterfall; lines: ClassifiedLine[]; perimeter: string[]; balances: Map<string, { startCents: number; endCents: number }>; gaps: db.BalanceGap[] } {
  if (!isMonth(String(month))) throw new Error('A month is like 2026-10')
  // As the books have it now, a month changed since its close too: what a close freezes, and what a check compares.
  const { waterfall, book, r } = build({ from: month, to: month }, { close: true })
  const start = before(`${month}-01`)
  const end = lastDayOf(month)
  const per = perimeter(month, r.accounts)
  const balances = new Map([...new Set([...per, ...r.counted])].map((id) => [id, { startCents: r.balance(id, start), endCents: r.balance(id, end) }]))
  return { waterfall, lines: book.byMonth.get(month) ?? [], perimeter: per, balances, gaps: r.gaps.filter((g) => g.month === month) }
}

/**
 * The waterfall over a span, with the book of lines and checks it read and its identities' balances. With `close`,
 * what a month's close freezes and a check compares with it: the month as the books have it now (a month changed
 * since its close reads no closed figures), with no sparkline beyond the month itself, no levers and no retirement
 * line, which a close doesn't keep.
 */
function build(span: Span, o: { close?: boolean } = {}): { waterfall: Waterfall; book: Book; r: Reckoning } {
  const today = db.today()
  const current = today.slice(0, 7)
  const p = parseSpan(span, today)
  const lastMonth = p.months[p.months.length - 1]
  const insideMonth = p.days && p.toDay !== lastDayOf(lastMonth)
  const endMonth = insideMonth && lastMonth < current ? shiftMonth(lastMonth, -1) : lastMonth
  const partial = lastMonth >= current || insideMonth
  const trendMonths = o.close ? [lastMonth] : p.months.length > 12 ? p.months : monthsFrom(shiftMonth(lastMonth, -11), lastMonth)
  const asked = [...new Set([...trendMonths, endMonth, shiftMonth(endMonth, -3)])].sort()

  // What the months asked need: their 12-month windows, and 400 days of each series' payments before their windows'
  // ends, the levers' prices a year before the end's window included.
  const ends = asked.map((m) => lastDayOf(windowOf(m, current).to))
  const yearAgo = lastDayOf(shiftMonth(windowOf(endMonth, current).to, -12))
  const fromDay = [p.fromDay, `${yearOf(asked[0], current).from}-01`, addDays(ends[0], 1 - LOOKBACK_DAYS), addDays(yearAgo, 1 - LOOKBACK_DAYS)].sort()[0]
  const toDay = [p.toDay, ...ends].sort().at(-1)!
  const gainMonths = monthsFrom([p.months[0], yearOf(asked[0], current).from].sort()[0], [lastMonth, ...asked.map((m) => windowOf(m, current).to)].sort().at(-1)!)
  const balanceDays = [...asked.flatMap((m) => [lastDayOf(windowOf(m, current).to), before(`${windowOf(m, current).to}-01`)]), before(p.fromDay)]
  const book = readBook(fromDay, toDay, current, balanceDays, gainMonths)

  const rates = new Map(asked.map((m) => [m, monthRates(book, m)]))
  const now = rates.get(endMonth)!
  const then = rates.get(shiftMonth(endMonth, -3))!
  const single = !p.days && p.months.length === 1
  const { figures: actual, tally: spanTally, checks, employer, lines: spanLines } = spanFigures(book, p.fromDay, p.toDay, p.days ? null : p.months)

  // Gross pay and Take-home are one row when nothing comes off pay: no taxes, benefits or saving at work.
  const merged = ['taxes', 'benefits', 'savedAtWork'].every((id) => now.rows[id as StageId] === 0 && actual.rows[id as StageId] === 0)
  // The Payroll difference shows only when it isn't 0: its amount, its run rate or its change over 3 months.
  const shownDiff = actual.rows.payrollDiff !== 0 || now.rows.payrollDiff !== 0 || then.rows.payrollDiff !== 0
  const ids = ORDER.filter((id) => !(merged && ['gross', 'taxes', 'benefits', 'savedAtWork'].includes(id)) && (id !== 'payrollDiff' || (shownDiff && !merged)))
  const rateFrom = (id: StageId): RateFrom | null => (merged && id === 'takeHome' ? null : RATE_FROM[id])
  const points = setting('focus.points', FOCUS_POINTS)
  const fallen = new Map<StageId, boolean>()
  // Each month's latest close, for the months the span and the sparklines show.
  const firstShown = [trendMonths[0], p.months[0], shiftMonth(endMonth, -3)].sort()[0]
  const closes = db.latestCloses(firstShown, lastMonth)
  const statusOf = (month: string): CloseStatus => closes.get(month)?.status ?? 'open'
  // A month changed since its close reads its close's run rates and pay basis in its trend, Δ 3 mo and Δ pts until
  // Review accepts the change (spec 2, Trends), so the first derivative doesn't drift; every other closed month is
  // its close's already, and the open month is live.
  const frozen = o.close ? new Map<string, db.ClosedRow[]>() : db.latestCloseRows(firstShown, lastMonth)
  const asClosed = (m: string): Figures => {
    const live = rates.get(m)!
    const rows = statusOf(m) === 'changed' ? frozen.get(m) : undefined
    return rows?.length ? closedRates(rows, live) : live
  }
  const nowAt = asClosed(endMonth)
  const thenAt = asClosed(shiftMonth(endMonth, -3))

  const rowOf = (id: StageId): StageRow => {
    const from = rateFrom(id)
    const payBased = PAY_BASED.has(id)
    const rr = now.rows[id]
    const ratio = (f: Figures, cents: number): number | null => (from ? ratePct(cents, baseOf(f, from)) : null)
    const rate = from ? (single ? ratio(now, rr) : ratio(actual, actual.rows[id])) : null
    const change = from && id !== 'growth' && (!payBased || comparable(nowAt.basis, thenAt.basis)) ? rateChange(nowAt.rows[id], baseOf(nowAt, from), thenAt.rows[id], baseOf(thenAt, from), points) : null
    if (change) fallen.set(id, change.fell)
    const trend: TrendPoint[] = trendMonths.map((m) => {
      // A span that ends inside a past month ends its trend at the run rate in force on its last day, as the open
      // month's point is the last full month's.
      const r = asClosed(m === lastMonth ? endMonth : m)
      return { month: m, runRateCents: r.rows[id], rate: from ? ratePct(r.rows[id], baseOf(r, from)) : null, basis: payBased ? r.basis : null, status: statusOf(m) }
    })
    return {
      id,
      role: ROLE[id],
      actualCents: actual.rows[id],
      paceCents: id === 'everyday' && single && lastMonth === current ? paceOf(book, actual.rows.everyday, current) : null,
      perMonthCents: perMonth(actual.rows[id], p),
      runRateCents: rr,
      changeCents: id === 'growth' ? null : nowAt.rows[id] - thenAt.rows[id],
      rate,
      rateFrom: from,
      rateChangePts: change ? change.tenths / 10 : null,
      basis: payBased ? now.basis : null,
      trend,
      closedCents: null,
      closedRunRateCents: null,
      // Take-home standing alone holds what Gross pay would have: each payroll's deposits and other income.
      parts:
        merged && id === 'takeHome'
          ? partsOf(book, 'gross', paidIn(actual), paidIn(now), paidIn(thenAt), spanTally, from, single, p, paidIn(nowAt))
          : id in actual.parts
            ? partsOf(book, id as PartRow, actual, now, thenAt, spanTally, from, single, p, nowAt)
            : []
    }
  }
  const rows = ids.map(rowOf)

  // The identities, month by month over the span's days, and added up.
  const r = reckon(book, p.fromDay, p.toDay)
  const each = p.months.map((m) => {
    const piece = { month: m, fromDay: [p.fromDay, `${m}-01`].sort()[1], toDay: [p.toDay, lastDayOf(m)].sort()[0] }
    const whole = piece.fromDay === `${m}-01` && piece.toDay === lastDayOf(m)
    const lines = whole ? (book.byMonth.get(m) ?? []) : (book.byMonth.get(m) ?? []).filter((l) => l.day >= piece.fromDay && l.day <= piece.toDay)
    return identitiesOf(book, r, piece, lines, whole ? gainsOf(book, m) : gainsOver(book, piece.fromDay, piece.toDay))
  })
  const reconciled = together(each)

  // A month changed since its close shows every figure its close froze beside today's (spec 2, On Home): over the
  // span, its amounts with the changed months' closed amounts in place of today's, and what its last month closed with
  // when that month is changed. Today's figures are what closing the months again would freeze: each change over 3
  // months reads the month 3 before as the books have it now, not as it closed, as a close reads it.
  const changed = p.days ? [] : p.months.filter((m) => statusOf(m) === 'changed' && frozen.get(m)?.length)
  const kept = db.latestCloseIdentities(changed)
  let closed: ClosedFigures | null = null
  if (changed.length) {
    const liveRow = (row: StageRow): KeptRow => {
      const id = row.id
      const from = rateFrom(id)
      const change = from && id !== 'growth' && (!PAY_BASED.has(id) || comparable(now.basis, then.basis)) ? rateChange(now.rows[id], baseOf(now, from), then.rows[id], baseOf(then, from), points) : null
      const parts =
        merged && id === 'takeHome'
          ? partsOf(book, 'gross', paidIn(actual), paidIn(now), paidIn(then), spanTally, from, single, p)
          : id in actual.parts
            ? partsOf(book, id as PartRow, actual, now, then, spanTally, from, single, p)
            : []
      return { id, actualCents: row.actualCents, runRateCents: row.runRateCents, changeCents: id === 'growth' ? null : now.rows[id] - then.rows[id], rate: row.rate, rateChangePts: change ? change.tenths / 10 : null, basis: row.basis, parts }
    }
    // The span's lines, and as closed: the changed months' as their closes froze them.
    const frozenLines = db.latestCloseLines(changed)
    const linesOf = (m: string): ReadonlyArray<KeptLine> => book.byMonth.get(m) ?? []
    const live: KeptFigures = { rows: rows.map(liveRow), identity: reconciled.identity, bridge: reconciled.bridge, lines: p.months.flatMap(linesOf) }
    const keptLines = p.months.flatMap((m) => frozenLines.get(m) ?? linesOf(m))
    // One month is its close as it is; a close whose identity doesn't read leaves today's in its place.
    const one = kept.get(lastMonth) ?? live
    closed = closedFigures({ ...(single ? { rows: frozen.get(lastMonth)!, identity: one.identity, bridge: one.bridge } : closedOver(book, p, changed, frozen, kept, live, each, actual, merged)), lines: keptLines }, live)
    for (const row of rows) {
      const s = closed.byStage.find((x) => x.id === row.id)!
      row.closedCents = s.closedCents
      row.closedRunRateCents = s.closedRunRateCents
    }
  }

  // Where to look first: Unsorted or Unexplained above tolerance, then the subtotal whose rate fell most, by at least
  // focus.points.
  const tolerance = setting('close.tolerance', TOLERANCE)
  const toleranceOf = (f: Figures): number => Math.max(tolerance.cents, shareCents(f.rows.takeHome, tolerance.bp))
  const toleranceCents = toleranceOf(now)
  const unsortedAtEnd = p.days ? spanTally.unsorted : monthTally(book, lastMonth).unsorted
  const unexplainedAtEnd = p.days ? reconciled.identity.unexplainedCents : each[each.length - 1].identity.unexplainedCents
  let focus: Waterfall['focus'] = null
  if (Math.abs(unsortedAtEnd) > toleranceCents) focus = 'unsorted'
  else if (Math.abs(unexplainedAtEnd) > toleranceCents) focus = 'unexplained'
  else {
    let worst = 0
    for (const r of rows) {
      if (!FOCUSABLE.includes(r.id) || !fallen.get(r.id) || r.rateChangePts === null) continue
      const pts = exactPts(nowAt, thenAt, r.id, rateFrom(r.id)!)
      if (pts < worst) {
        worst = pts
        focus = r.id
      }
    }
  }

  // Each month's latest close, and its Unexplained against its own tolerance, so a span shows a month's gap that
  // others hide or add to. The span's months as one marker: a change is the first thing to see, then a gap, then a
  // month still open. Each month's bridge too, as the span's adds them up, and a changed month's as its close froze it:
  // Net worth's Overview lists them.
  const months = p.months.map((month, i) => ({
    month,
    status: statusOf(month),
    origin: closes.get(month)?.origin ?? null,
    unexplainedCents: each[i].identity.unexplainedCents,
    toleranceCents: toleranceOf(rates.get(month) ?? now),
    bridge: each[i].bridge,
    closedBridge: (kept.get(month)?.bridge as NetWorthBridge | undefined) ?? null
  }))
  const marker = (['changed', 'gap', 'open'] as CloseStatus[]).find((s) => months.some((m) => m.status === s)) ?? 'closed'
  const waterfall: Waterfall = {
    span: p.span,
    endMonth,
    partial,
    rows,
    employerAdds: employer,
    payChecks: checks,
    limits: limitsAt(book, p.toDay < today ? p.toDay : today),
    principal: [...spanTally.principal]
      .filter(([, cents]) => cents !== 0)
      .map(([debtId, cents]) => ({ debtId, name: book.accounts.get(debtId)?.name ?? debtId, cents, drill: { fromDay: p.fromDay, toDay: p.toDay, cls: ['principal'] as LineClass[], ids: [...(spanTally.ids.get(`principal:${debtId}`) ?? [])].sort() } }))
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name)),
    unsorted: { cents: spanTally.unsorted, count: spanTally.unsortedCount, ids: [...(spanTally.ids.get('unsorted') ?? [])].sort() },
    // Left over's Payees and Saved's one-offs, which a close doesn't keep.
    payees: o.close ? [] : payeesOf(spanLines, p),
    oneOffs: o.close ? { items: [], count: 0, trips: [] } : oneOffsOf(book, spanLines),
    levers: o.close ? [] : leversOf(book, endMonth, now, merged),
    retirement: o.close ? null : retirementOf(book, endMonth, now),
    growth: o.close ? null : growthDrill(book, p, endMonth, actual, now, reconciled),
    identity: reconciled.identity,
    bridge: reconciled.bridge,
    leaks: [...reconciled.cashLeaks, ...reconciled.bridgeLeaks],
    checks: payrollItems(checks),
    toleranceCents,
    focus,
    status: marker,
    version: p.months.length === 1 ? (closes.get(p.months[0])?.version ?? null) : null,
    months,
    closed,
    firstMonth: firstLedgerDay()?.slice(0, 7) ?? null,
    spendable: null
  }
  return { waterfall, book, r }
}

/** A row as a close keeps it, and as the books have it now in the same shape: its figures and its parts'. */
type KeptRow = Pick<db.ClosedRow, 'id' | 'actualCents' | 'runRateCents' | 'changeCents' | 'rate' | 'rateChangePts' | 'basis'> & { parts: ReadonlyArray<db.ClosedRow['parts'][number]> }

/** A ledger line as a close keeps it (snapshot_lines): its key, class, amount and owner. */
type KeptLine = Pick<ClassifiedLine, 'key' | 'cls' | 'cents' | 'owner'>

/**
 * A month's or a span's figures as a close keeps them (snapshots.ts): its rows with their parts, the cash identity's
 * terms and the bridge's, and its ledger lines when they're read.
 */
export interface KeptFigures {
  rows: ReadonlyArray<KeptRow>
  identity: object
  bridge: object
  lines?: ReadonlyArray<KeptLine>
}

/**
 * Where a Personal line goes, by its class: into a row (pay deposits into Take-home, other income into Gross pay), or
 * into a term of the cash identity. A line a venture owns is venture, and goes into Ventures, unless its intent gives
 * it a class of Personal's (rule 0: a gift that paid the venture's cost is a One-off).
 */
const LINE_INTO: Record<LineClass, { row: StageId } | { term: keyof CashIdentity }> = {
  pay: { row: 'takeHome' },
  income: { row: 'gross' },
  tax: { row: 'taxes' },
  committed: { row: 'committed' },
  debtCost: { row: 'committed' },
  everyday: { row: 'everyday' },
  oneOff: { row: 'oneOffs' },
  oneOffIncome: { row: 'oneOffs' },
  venture: { term: 'venturesCents' },
  cashReturn: { term: 'cashReturnCents' },
  unsorted: { term: 'unsortedCents' },
  principal: { term: 'debtPaidCents' },
  invested: { term: 'toInvestmentsCents' },
  capital: { term: 'boughtCents' },
  internal: { term: 'inTransitCents' },
  orphan: { term: 'unexplainedCents' }
}
const LINE_TERMS: Array<keyof CashIdentity> = ['venturesCents', 'cashReturnCents', 'unsortedCents', 'debtPaidCents', 'toInvestmentsCents', 'boughtCents', 'inTransitCents', 'unexplainedCents']

/**
 * The lines of each row and identity term whose lines differ between a close and now, by key, class and amount as the
 * lines digest reads them: how many each side has, and how many are on one side only. In the rows' order, then the
 * identity's.
 */
function lineCountsOf(closed: ReadonlyArray<KeptLine>, now: ReadonlyArray<KeptLine>): LineCounts[] {
  const into = (l: KeptLine): { row: StageId } | { term: keyof CashIdentity } => LINE_INTO[l.cls]
  const groups = new Map<string, { closed: number; now: number; seen: Map<string, number> }>()
  const count = (l: KeptLine, side: 'closed' | 'now'): void => {
    const to = into(l)
    const k = 'row' in to ? `row:${to.row}` : `term:${to.term}`
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { closed: 0, now: 0, seen: new Map() }))
    g[side]++
    const line = `${l.key}|${l.cls}|${l.cents}`
    g.seen.set(line, (g.seen.get(line) ?? 0) + (side === 'closed' ? 1 : -1))
  }
  for (const l of closed) count(l, 'closed')
  for (const l of now) count(l, 'now')
  const out: LineCounts[] = []
  const push = (row: StageId | null, term: keyof CashIdentity | null): void => {
    const g = groups.get(row ? `row:${row}` : `term:${term}`)
    if (!g) return
    let added = 0
    let removed = 0
    for (const n of g.seen.values()) {
      if (n > 0) removed += n
      else added -= n
    }
    if (added || removed) out.push({ row, term, closedCount: g.closed, nowCount: g.now, added, removed })
  }
  for (const id of ORDER) push(id, null)
  for (const t of LINE_TERMS) push(null, t)
  return out
}

/**
 * A span of months' figures as its changed months closed them: each row's and part's amount with the changed months'
 * closed amounts in place of today's (each read as its own month alone), its rate the share of those amounts (none for
 * Take-home when it stood for Gross pay on the books as closed), and its run rate, Δ 3 mo, Δ pts and pay basis, and
 * its parts', as the span's last month closed with them when it is changed, else today's; the identity's and the
 * bridge's terms the same way, the bridge's start as the first month closed with it and its end as the last did,
 * when those are changed. A close whose identity doesn't read leaves today's in its place.
 */
function closedOver(
  book: Book,
  p: ParsedSpan,
  changed: string[],
  frozen: Map<string, db.ClosedRow[]>,
  kept: ReturnType<typeof db.latestCloseIdentities>,
  live: KeptFigures,
  each: Identities[],
  actual: Figures,
  merged: boolean
): KeptFigures {
  const end = p.months[p.months.length - 1]
  const byId = (m: string): Map<StageId, db.ClosedRow> => new Map(frozen.get(m)!.map((x) => [x.id, x]))
  const closes = new Map(changed.map((m) => [m, byId(m)]))
  const today = new Map(changed.map((m) => [m, spanFigures(book, `${m}-01`, lastDayOf(m), [m]).figures]))
  const last = closes.get(end) ?? null
  const liveRows = new Map(live.rows.map((x) => [x.id, x]))
  // A row a close left out was nothing then, but Gross pay it merged into Take-home was Take-home's.
  const closedRow = (c: Map<StageId, db.ClosedRow>, id: StageId): db.ClosedRow | undefined => c.get(id) ?? (id === 'gross' ? c.get('takeHome') : undefined)
  const partsIn = (f: Figures, id: StageId): Parts => (merged && id === 'takeHome' ? paidIn(f).parts.gross : (f.parts[id as PartRow] ?? new Map()))
  const amount = (id: StageId): number => actual.rows[id] + changed.reduce((s, m) => s + (closedRow(closes.get(m)!, id)?.actualCents ?? 0) - today.get(m)!.rows[id], 0)
  const partAmount = (id: StageId, key: string): number =>
    (liveRows.get(id)?.parts.find((x) => x.key === key)?.actualCents ?? 0) +
    changed.reduce((s, m) => s + (closedRow(closes.get(m)!, id)?.parts.find((x) => x.key === key)?.actualCents ?? 0) - (partsIn(today.get(m)!, id).get(key) ?? 0), 0)
  const employer = actual.employerSaving + changed.reduce((s, m) => s + (closes.get(m)!.get('saved')?.parts.find((x) => x.key === 'employer')?.actualCents ?? 0) - today.get(m)!.employerSaving, 0)
  const base = (from: RateFrom): number => (from === 'earned' ? amount('gross') + employer : from === 'investedBalance' ? actual.investedBalance : amount(from))
  // Gross pay and Take-home were one row on the books as closed when nothing came off pay in the span's closed
  // amounts nor in the run rates its last month closed with, as build decides it today: Take-home had no rate then.
  const closedRunRate = (id: StageId): number => (last ? (closedRow(last, id)?.runRateCents ?? 0) : (liveRows.get(id)?.runRateCents ?? 0))
  const mergedThen = (['taxes', 'benefits', 'savedAtWork'] as StageId[]).every((id) => amount(id) === 0 && closedRunRate(id) === 0)
  const ids = ORDER.filter((id) => liveRows.has(id) || changed.some((m) => closes.get(m)!.has(id)))
  const rows = ids.map((id): KeptRow => {
    const now = liveRows.get(id)
    const was = last ? closedRow(last, id) : undefined
    const from = mergedThen && id === 'takeHome' ? null : RATE_FROM[id]
    const keys = [...new Set([...(now?.parts ?? []).map((x) => x.key), ...changed.flatMap((m) => (closedRow(closes.get(m)!, id)?.parts ?? []).map((x) => x.key))])]
    const parts = keys.map((key) => {
      const is = now?.parts.find((x) => x.key === key)
      const at = was?.parts.find((x) => x.key === key)
      const cents = partAmount(id, key)
      return {
        key,
        name: is?.name ?? at?.name ?? key,
        actualCents: cents,
        runRateCents: last ? (at?.runRateCents ?? 0) : (is?.runRateCents ?? 0),
        changeCents: id === 'growth' ? null : last ? (at?.changeCents ?? 0) : (is?.changeCents ?? 0),
        rate: from ? ratePct(cents, base(from)) : null
      }
    })
    const cents = amount(id)
    if (!last) return { id, actualCents: cents, runRateCents: now?.runRateCents ?? 0, changeCents: now?.changeCents ?? (id === 'growth' ? null : 0), rate: from ? ratePct(cents, base(from)) : null, rateChangePts: now?.rateChangePts ?? null, basis: now?.basis ?? null, parts }
    return { id, actualCents: cents, runRateCents: was?.runRateCents ?? 0, changeCents: was ? was.changeCents : id === 'growth' ? null : 0, rate: from ? ratePct(cents, base(from)) : null, rateChangePts: was?.rateChangePts ?? null, basis: was?.basis ?? now?.basis ?? null, parts }
  })

  // The identity's terms and the bridge's, each month's closed figures in place of today's.
  const monthOf = new Map(p.months.map((m, i) => [m, each[i]]))
  const num = (o: object, k: string): number => {
    const v = (o as Record<string, unknown>)[k]
    return typeof v === 'number' ? v : 0
  }
  const sum = (side: 'identity' | 'bridge', k: string, now: number): number =>
    now +
    changed.reduce((s, m) => {
      const c = kept.get(m)
      return c ? s + num(c[side], k) - num(monthOf.get(m)![side], k) : s
    }, 0)
  const identity: Record<string, number> = {}
  for (const [k, v] of Object.entries(live.identity)) if (typeof v === 'number') identity[k] = sum('identity', k, v)
  // Net worth at the span's start is its first month's and at its end its last month's, each as that month closed with
  // it when it's changed, else today's: a changed month between them moves neither, though its own start and end did.
  const ends = new Set(['startCents', 'endCents'])
  const bridge: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(live.bridge)) if (typeof v === 'number') bridge[k] = ends.has(k) ? v : sum('bridge', k, v)
  const first = kept.get(p.months[0])
  const final = kept.get(end)
  if (changed.includes(p.months[0]) && first) bridge['startCents'] = num(first.bridge, 'startCents')
  if (changed.includes(end) && final) bridge['endCents'] = num(final.bridge, 'endCents')
  // The Other items by kind and account.
  const items = (o: object): NetWorthBridge['other'] => ((o as { other?: NetWorthBridge['other'] }).other ?? [])
  const other = new Map<string, NetWorthBridge['other'][number]>()
  const add = (x: NetWorthBridge['other'][number], sign: number): void => {
    const k = `${x.kind}\u0000${x.accountId}`
    const was = other.get(k)
    if (was) was.cents += sign * x.cents
    else other.set(k, { kind: x.kind, accountId: x.accountId, cents: sign * x.cents })
  }
  for (const x of items(live.bridge)) add(x, 1)
  for (const m of changed) {
    const c = kept.get(m)
    if (!c) continue
    for (const x of items(c.bridge)) add(x, 1)
    for (const x of items(monthOf.get(m)!.bridge)) add(x, -1)
  }
  bridge['other'] = [...other.values()].filter((x) => x.cents !== 0)
  return { rows, identity, bridge }
}

/**
 * Every figure a close froze beside the same figure now (spec 2, What is frozen): each row, in the waterfall's order,
 * with each of its parts whose actual, run rate, Δ 3 mo or rate moved; each term of the cash identity and of the
 * bridge; and each Other item of the bridge that moved. A row or part on one side alone was nothing on the other: 0,
 * no Δ pts, a rate of 0 where the other side has one, and the other side's pay basis; but Gross pay a close merged
 * into Take-home was Take-home's.
 */
export function closedFigures(closed: KeptFigures, now: KeptFigures): ClosedFigures {
  const by = (rows: ReadonlyArray<KeptRow>): Map<StageId, KeptRow> => new Map(rows.map((x) => [x.id, x]))
  const was = by(closed.rows)
  const is = by(now.rows)
  const alone = (id: StageId, side: Map<StageId, KeptRow>, other: KeptRow): KeptRow => {
    const merged = id === 'gross' ? side.get('takeHome') : undefined
    if (merged) return { ...merged, id, rate: null, rateChangePts: null }
    return { id, actualCents: 0, runRateCents: 0, changeCents: other.changeCents === null ? null : 0, rate: other.rate === null ? null : 0, rateChangePts: null, basis: other.basis, parts: [] }
  }
  type Part = KeptRow['parts'][number]
  const nothing = (other: Part): Part => ({ key: other.key, actualCents: 0, runRateCents: 0, changeCents: (other.changeCents ?? null) === null ? null : 0, rate: (other.rate ?? null) === null ? null : 0 })
  const partsOf = (c: KeptRow, n: KeptRow): PartFigures[] => {
    const before = new Map(c.parts.map((x) => [x.key, x]))
    const after = new Map(n.parts.map((x) => [x.key, x]))
    const out: PartFigures[] = []
    for (const key of new Set([...after.keys(), ...before.keys()])) {
      const x = before.get(key) ?? nothing(after.get(key)!)
      const y = after.get(key) ?? nothing(before.get(key)!)
      const f: PartFigures = {
        key,
        name: after.get(key)?.name ?? before.get(key)?.name ?? key,
        closedCents: x.actualCents,
        nowCents: y.actualCents,
        closedRunRateCents: x.runRateCents ?? null,
        nowRunRateCents: y.runRateCents ?? null,
        closedChangeCents: x.changeCents ?? null,
        nowChangeCents: y.changeCents ?? null,
        closedRate: x.rate ?? null,
        nowRate: y.rate ?? null
      }
      if (f.closedCents !== f.nowCents || f.closedRunRateCents !== f.nowRunRateCents || f.closedChangeCents !== f.nowChangeCents || f.closedRate !== f.nowRate) out.push(f)
    }
    return out
  }
  const byStage: StageFigures[] = []
  for (const id of ORDER) {
    const x = was.get(id)
    const y = is.get(id)
    if (!x && !y) continue
    const c = x ?? alone(id, was, y!)
    const n = y ?? alone(id, is, x!)
    byStage.push({
      id,
      closedCents: c.actualCents,
      nowCents: n.actualCents,
      closedRunRateCents: c.runRateCents,
      nowRunRateCents: n.runRateCents,
      closedChangeCents: c.changeCents,
      nowChangeCents: n.changeCents,
      closedRate: c.rate,
      nowRate: n.rate,
      closedRateChangePts: c.rateChangePts,
      nowRateChangePts: n.rateChangePts,
      closedBasis: c.basis,
      nowBasis: n.basis,
      parts: partsOf(c, n)
    })
  }
  // The terms by name, each side's figure or 0 where it has none; the identity's tolerance is no term of it.
  const numbers = (o: object): Map<string, number> => new Map(Object.entries(o).filter((e): e is [string, number] => typeof e[1] === 'number' && e[0] !== 'toleranceCents'))
  const terms = <K extends string>(c: object, n: object): Array<{ key: K; closedCents: number; nowCents: number }> => {
    const a = numbers(c)
    const b = numbers(n)
    return [...new Set([...b.keys(), ...a.keys()])].map((key) => ({ key: key as K, closedCents: a.get(key) ?? 0, nowCents: b.get(key) ?? 0 }))
  }
  const items = (o: object): Map<string, NetWorthBridge['other'][number]> => {
    const out = new Map<string, NetWorthBridge['other'][number]>()
    for (const x of (o as { other?: NetWorthBridge['other'] }).other ?? []) {
      const k = `${x.kind}\u0000${x.accountId}`
      out.set(k, { ...x, cents: (out.get(k)?.cents ?? 0) + x.cents })
    }
    return out
  }
  const a = items(closed.bridge)
  const b = items(now.bridge)
  const other: ClosedFigures['other'] = []
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(k) ?? a.get(k)!
    const f = { kind: x.kind, accountId: x.accountId, closedCents: a.get(k)?.cents ?? 0, nowCents: b.get(k)?.cents ?? 0 }
    if (f.closedCents !== f.nowCents) other.push(f)
  }
  return {
    byStage,
    identity: terms<keyof CashIdentity>(closed.identity, now.identity),
    bridge: terms<Exclude<keyof NetWorthBridge, 'other' | 'ventures'>>(closed.bridge, now.bridge),
    other,
    lineCounts: closed.lines && now.lines ? lineCountsOf(closed.lines, now.lines) : []
  }
}

/**
 * A month's run rates as its latest close froze them (db.latestCloseRows), in today's shape: each row's and part's
 * run rate, the pay basis and employer saving. A row the close left out was nothing then: Gross pay standing as
 * Take-home, or a row off pay with nothing on it.
 */
function closedRates(rows: db.ClosedRow[], live: Figures): Figures {
  const by = new Map(rows.map((r) => [r.id, r]))
  const rr = (id: StageId): number => by.get(id)?.runRateCents ?? (id === 'gross' ? (by.get('takeHome')?.runRateCents ?? 0) : 0)
  const parts = Object.fromEntries(PART_ROWS.map((row) => [row, new Map((by.get(row)?.parts ?? []).map((x) => [x.key, x.runRateCents ?? 0]))])) as Record<PartRow, Parts>
  // With no Gross pay row, Take-home held its parts.
  if (!by.has('gross') && by.has('takeHome')) parts.gross = new Map((by.get('takeHome')!.parts ?? []).map((x) => [x.key, x.runRateCents ?? 0]))
  return {
    ...live,
    parts,
    rows: Object.fromEntries(ORDER.map((id) => [id, rr(id)])) as Record<StageId, number>,
    employerSaving: by.get('saved')?.parts.find((x) => x.key === 'employer')?.runRateCents ?? 0,
    basis: rows.find((r) => r.basis !== null)?.basis ?? null
  }
}

/** Figures whose Gross pay parts hold the Payroll difference too: Take-home's sources when nothing comes off pay. */
function paidIn(f: Figures): Figures {
  const gross: Parts = new Map(f.parts.gross)
  for (const [k, c] of f.parts.payrollDiff) add(gross, k, c)
  return { ...f, parts: { ...f.parts, gross } }
}

/** The unrounded change of a row's rate over 3 months, in points, for ranking the falls. */
const exactPts = (now: Figures, then: Figures, id: StageId, from: RateFrom): number => 100 * (now.rows[id] / baseOf(now, from) - then.rows[id] / baseOf(then, from))

/** Everyday to date in the open month, at the pace of the days spent at home so far, for the whole month (spec 1.5). */
function paceOf(book: Book, toDate: number, month: string): number {
  const today = db.today()
  const length = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))
  const elapsed = daysBetween(`${month}-01`, today) + 1
  const awaySoFar = Math.round(daysAway(book.trips, db.dayStart(`${month}-01`), db.dayStart(addDays(today, 1))))
  const awayAll = awayOver(book, month, month)
  return roundDiv(toDate * Math.max(1, length - awayAll), Math.max(1, elapsed - awaySoFar))
}

// ---------- Left over's payees and Saved's one-offs ----------

/** Whether a line is paid to a vendor the user hides: never named in a list, though its money counts. */
const hiddenLine = (hidden: (name: string | null) => boolean, l: LedgerLine): boolean => hidden(l.merchant) || hidden(l.description)

/**
 * Everyday over the span by payee (spec 1.5, Left over's Payees): Personal's everyday lines by their payee's key, each
 * payee what it took as Everyday reads it (a cost positive, a refund less), named as its first line names it, the
 * largest first. They add up to Everyday, as the categories do. A vendor the user hides keeps its money here with no
 * name.
 */
function payeesOf(lines: LedgerLine[], p: ParsedSpan): Waterfall['payees'] {
  const hidden = vendorHider()
  const by = new Map<string, { key: string; name: string | null; cents: number; count: number }>()
  for (const l of lines) {
    if (!personalPart(l) || l.cls !== 'everyday') continue
    const key = payeeName(l)
    let x = by.get(key)
    if (!x) by.set(key, (x = { key, name: hiddenLine(hidden, l) ? null : (l.merchant ?? l.description), cents: 0, count: 0 }))
    x.cents -= l.cents
    x.count++
  }
  return [...by.values()].map((x) => ({ ...x, perMonthCents: perMonth(x.cents, p) })).sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key))
}

/** How many of the span's one-off items the waterfall names: Home shows the largest few, then opens them all. */
const ONE_OFF_ITEMS = 40

/**
 * One-offs over the span (spec 1.6, Saved's drill): each transaction's one-off lines and one-off income as one item,
 * a cost positive as One-offs reads it, the ONE_OFF_ITEMS largest, named by its payee and the trip it was bought on,
 * with how many there are; and each trip with one-offs bought on it in the span, with their transactions. A vendor
 * the user hides is never named.
 */
function oneOffsOf(book: Book, lines: LedgerLine[]): Waterfall['oneOffs'] {
  const hidden = vendorHider()
  const items = new Map<string, Waterfall['oneOffs']['items'][number]>()
  const trips = new Map<string, { name: string; fromDay: string; toDay: string; cents: number; ids: Set<string> }>()
  for (const l of lines) {
    if (!personalPart(l) || (l.cls !== 'oneOff' && l.cls !== 'oneOffIncome')) continue
    const trip = tripAt(book.trips, l.posted)
    let item = items.get(l.txnId)
    if (!item) items.set(l.txnId, (item = { txnId: l.txnId, day: l.day, name: hiddenLine(hidden, l) ? null : (l.merchant ?? l.description), categoryId: l.categoryId, cents: 0, trip: trip?.name ?? null }))
    item.cents -= l.cents
    if (!trip) continue
    let t = trips.get(trip.id)
    if (!t) trips.set(trip.id, (t = { name: trip.name, fromDay: trip.from, toDay: trip.to, cents: 0, ids: new Set() }))
    t.cents -= l.cents
    t.ids.add(l.txnId)
  }
  return {
    items: [...items.values()].sort((a, b) => b.cents - a.cents || a.day.localeCompare(b.day) || a.txnId.localeCompare(b.txnId)).slice(0, ONE_OFF_ITEMS),
    count: items.size,
    trips: [...trips.values()].sort((a, b) => a.fromDay.localeCompare(b.fromDay)).map((t) => ({ ...t, ids: [...t.ids].sort() }))
  }
}

/** Payroll check items over the span's checks: a check's own stub off its deposit by more than $1, and each payroll's latest check estimated that far off. */
function payrollItems(checks: PayCheck[]): CheckItem[] {
  const out: CheckItem[] = []
  for (const c of checks) if (c.basis === 'paystub' && Math.abs(c.differenceCents) > DUE_WITHIN) out.push({ kind: 'paystub_mismatch', cents: c.differenceCents, paycheckKey: c.paycheckKey, payDay: c.day })
  const latest = new Map<string, PayCheck>()
  for (const c of checks) if (c.kind !== 'bonus') latest.set(c.paycheckKey, c)
  for (const c of latest.values()) if (c.basis === 'estimated' && Math.abs(c.differenceCents) > DUE_WITHIN) out.push({ kind: 'paystub_missing', cents: c.differenceCents, paycheckKey: c.paycheckKey, payDay: c.day })
  return out
}

// ---------- levers ----------

/** What a check's item puts toward the yearly 401(k) deferral limit: the employee's own deferral. */
const toDeferral = (x: PaystubItem): number => (DEFERRALS.has(x.kind) ? x.cents : 0)
/** What a check's item puts toward the HSA's limit: the employee's money and the employer's. */
const toHsa = (x: PaystubItem): number => (x.kind === 'hsa' ? x.cents + (x.employerCents ?? 0) : 0)

/** What a year's checks, a bonus's included, have put toward a limit through a day. */
function filledToward(book: Book, year: number, day: string, f: (x: PaystubItem) => number): number {
  let cents = 0
  for (const c of book.checks) if (c.day >= `${year}-01-01` && c.day <= day) for (const x of c.items) cents += f(x)
  return cents
}

/**
 * The year's limits at a day (spec 1.3, Take-home's drill): what its checks have put toward the 401(k) deferral
 * limit and the HSA's by then, beside each limit, for a limit the checks have put money toward or a plan in force
 * then counts toward.
 */
function limitsAt(book: Book, day: string): Waterfall['limits'] {
  const year = Number(day.slice(0, 4))
  const kinds = new Set(
    db
      .listContributionRows()
      .filter((x) => (!x.startsDay || x.startsDay <= day) && (!x.endsDay || x.endsDay >= day))
      .map((x) => x.kind)
  )
  const out: Waterfall['limits'] = []
  const deferral = filledToward(book, year, day, toDeferral)
  if (deferral > 0 || kinds.has('401k') || kinds.has('roth_401k')) {
    const l = limitsFor(year).deferral
    out.push({ name: '401(k)', filledCents: deferral, limitCents: l.cents, provisional: l.provisional })
  }
  const hsa = filledToward(book, year, day, toHsa)
  if (hsa > 0 || kinds.has('hsa')) {
    const l = hsaLimit(year)
    out.push({ name: 'HSA', filledCents: hsa, limitCents: l.cents, provisional: l.provisional })
  }
  return out
}

/** The levers that cut what a debt charges: they come first, the highest rate first, as the debt plan pays. */
const INTEREST_LEVERS = new Set<LeverKind>(['card_interest', 'loan_interest'])
/** What counts toward the yearly elective deferral limit: pre-tax and Roth 401(k)s and a 403(b). A 457 has a limit of its own. */
const DEFERRALS = new Set<PaystubItemKind>(['401k', 'roth_401k', '403b'])

/**
 * The levers in force at a month (spec 1.8), from its run rates (`now`): money a row could gain a month, each with
 * the change in its row's rate were it pulled in full and nothing else moved. `merged` says Take-home has no rate of
 * its own, as nothing comes off pay. Interest first, the highest rate first and one with no rate after them; then
 * the rest, the largest first.
 */
function leversOf(book: Book, month: string, now: Figures, merged: boolean): Lever[] {
  const w = windowOf(month, book.current)
  const fromDay = `${w.from}-01`
  const end = lastDayOf(w.to)
  const out: Lever[] = []
  // A row's rate with `cents` more a month. Saved's base is pay plus employer saving, so a match taken grows both.
  const pts = (stage: StageId, cents: number): number | null => {
    const from = merged && stage === 'takeHome' ? null : RATE_FROM[stage]
    if (!from) return null
    const base = baseOf(now, from)
    const c = rateChange(now.rows[stage] + cents, base + (stage === 'saved' ? cents : 0), now.rows[stage], base, 0)
    return c ? c.tenths / 10 : null
  }
  const lever = (stage: StageId, kind: LeverKind, name: string, cents: number, o: { aprBp?: number | null; drill?: LineQuery | null; estimated?: boolean } = {}): void => {
    out.push({ stage, kind, name, monthlyCents: cents, aprBp: o.aprBp ?? null, ratePts: stage === 'invested' ? null : pts(stage, cents), drill: o.drill ?? null, estimated: o.estimated ?? false })
  }
  // Take-home: a refund on the latest return filed is tax withheld all year that a new W-4 would pay as it goes.
  const filed = listTaxYears().find((y) => y.status === 'filed' && y.year < Number(month.slice(0, 4)))
  if (filed?.refundCents && filed.refundCents > 0) lever('takeHome', 'w4', 'W-4', roundDiv(filed.refundCents, 12))

  // Elective: what each card charged in the window's last month costs at its rate, unless an intro rate is what it
  // charges now; what each debt's latest payment pays in interest, its escrow left out; and each series that costs
  // more than it did in force a year before. A utility's amount varies, so it is a utility's change, not a price's.
  const force = inForce(book, month)
  for (const [key, cents] of force.parts) {
    if (!key.startsWith('card:') || cents <= 0) continue
    const a = book.accounts.get(key.slice(5))!
    if (a.promoEnds && end <= a.promoEnds && a.promoApr !== null) continue
    // Its drill is the card's own interest charges that month, not a loan's interest paid with the card.
    const charged = [...(monthTally(book, w.to).ids.get(key) ?? [])].sort()
    lever('elective', 'card_interest', a.name, cents, { aprBp: aprBpOf(a), drill: { fromDay: `${w.to}-01`, toDay: end, cls: ['debtCost'], ids: charged } })
  }
  for (const [debtId, i] of force.interest) {
    if (i.cents <= 0) continue
    const ids = new Set((book.loanPays.get(debtId) ?? []).filter((x) => x.day >= fromDay && x.day <= end).map((x) => x.txnId))
    ids.add(i.txnId)
    const a = book.accounts.get(debtId)
    lever('elective', 'loan_interest', a?.name ?? debtId, i.cents, { aprBp: aprBpOf(a), drill: { fromDay, toDay: end, cls: ['debtCost'], ids: [...ids] }, estimated: force.markers.get(`loan:${debtId}`) === 'estimated' })
  }
  const ago = shiftMonth(w.to, -12)
  const yearBefore = inForce(book, ago).parts
  for (const [key, cents] of force.parts) {
    const was = yearBefore.get(key)
    if (!key.startsWith('series:') || was === undefined || cents <= was) continue
    const s = book.series.get(key.slice(7))
    const utility = categoryRole(s?.categoryName) === 'utilities'
    if (s?.variable && !utility) continue
    lever('elective', utility ? 'utilities_change' : 'price_change', s?.name ?? key.slice(7), cents - was, { drill: { fromDay: `${ago}-01`, toDay: end, cls: ['committed'], seriesKey: key.slice(7) } })
  }

  // Left over: each Everyday category whose run rate is above the target set for it (set_category_target).
  const targets = db.listBudgets()
  for (const [key, cents] of now.parts.everyday) {
    const id = key.slice(4)
    const target = id === 'none' ? undefined : targets.get(Number(id))
    if (target === undefined || cents <= target) continue
    lever('leftOver', 'over_target', book.categories.get(Number(id)) ?? id, cents - target, { drill: { fromDay, toDay: end, cls: ['everyday'], categoryId: Number(id) } })
  }

  // Saved: the match each plan's rule would add on the latest check's gross were the election up to its cap. A plan
  // is in force at the window's end, or it isn't: one that has ended, or hasn't started, has no election now, so a
  // plan another has replaced on the same payroll leaves no match.
  const pay = payRates(book, month)
  const checks = book.checks.filter((c) => c.kind !== 'bonus' && c.day >= fromDay && c.day <= end)
  const plans = db.listContributionRows().filter((x) => (!x.startsDay || x.startsDay <= end) && (!x.endsDay || x.endsDay >= end))
  for (const plan of plans) {
    const key = pay.keys.find((k) => k.paycheckKey === plan.paycheckKey)
    const check = checks.filter((c) => c.paycheckKey === plan.paycheckKey).at(-1)
    const m = key && check ? structuredMatch(plan, check.grossCents, key.checksPerYear) : null
    if (!m || m.leftPerMonthCents <= 0) continue
    lever('saved', 'match_left', plan.name, m.leftPerMonthCents, { drill: { fromDay, toDay: end, cls: ['pay'], paycheckKey: plan.paycheckKey! }, estimated: check!.basis !== 'paystub' })
  }

  // Invested: each yearly limit's twelfth less what goes in a month now, at the per-check basis: the employee's
  // deferrals against the 401(k) limit, and the employee's and the employer's HSA money together against the HSA's.
  let deferral = 0
  let hsa = 0
  for (const key of pay.keys) {
    // Only the checks the payroll's run rate reads: none on a schedule it has left, nor a first check paying part of a period.
    const mine = checks.filter((c) => c.paycheckKey === key.paycheckKey && key.days.includes(c.day))
    if (!mine.length) continue
    const rate = (f: (x: PaystubItem) => number): number => roundDiv(mine.reduce((s, c) => s + c.items.reduce((t, x) => t + f(x), 0), 0) * key.checksPerYear, mine.length * 12)
    deferral += rate(toDeferral)
    hsa += rate(toHsa)
  }
  const year = Number(month.slice(0, 4))
  // A limit takes no more in a year than what's left of it: what the year's checks, a bonus's included, haven't put
  // toward it by the window's end, over the months of the year still to come. So a limit the year has filled has no
  // room, and a closed December none either. In January the window ends in the year before, and the year is all left.
  const filled = (f: (x: PaystubItem) => number): number => filledToward(book, year, end, f)
  const monthsLeft = Number(end.slice(0, 4)) === year ? 12 - Number(end.slice(5, 7)) : 12
  // A plan is held while it's in force at the window's end: one that has ended, or hasn't started, takes nothing now.
  const kinds = new Set(plans.map((x) => x.kind))
  const limits: Array<{ name: string; limit: Limit; cents: number; filled: number; held: boolean }> = [
    { name: '401(k)', limit: limitsFor(year).deferral, cents: deferral, filled: filled(toDeferral), held: deferral > 0 || kinds.has('401k') || kinds.has('roth_401k') },
    { name: 'HSA', limit: hsaLimit(year), cents: hsa, filled: filled(toHsa), held: hsa > 0 || kinds.has('hsa') || book.invested.some((a) => db.taxTreatment(a) === 'hsa') }
  ]
  for (const l of limits) {
    const left = monthsLeft > 0 ? roundDiv(Math.max(0, l.limit.cents - l.filled), monthsLeft) : 0
    const room = Math.min(roundDiv(l.limit.cents, 12) - l.cents, left)
    if (l.held && room > 0) lever('invested', 'tax_room', l.name, room, { drill: { fromDay, toDay: end, cls: ['pay'] }, estimated: l.limit.provisional || (pay.basis !== null && pay.basis !== 'paystub') })
  }
  const cash = cashAboveGoals(book, month)
  if (cash) lever('invested', 'cash_above_goals', cash.name, cash.cents, { drill: cash.drill })

  return out.sort((a, b) => {
    const [ia, ib] = [INTEREST_LEVERS.has(a.kind), INTEREST_LEVERS.has(b.kind)]
    if (ia !== ib) return ia ? -1 : 1
    if (ia && a.aprBp !== b.aprBp) return a.aprBp === null ? 1 : b.aprBp === null ? -1 : b.aprBp - a.aprBp
    return b.monthlyCents - a.monthlyCents || a.name.localeCompare(b.name)
  })
}

/**
 * Savings beyond what the goals hold, and what it would earn more a month invested (spec 1.8, cash_above_goals): the
 * Personal saving-role cash at the window's end, less what each goal linked to it holds (its target, up to what it
 * has saved), times the return the user expects (their real return and inflation, so nominal like the cash's) less
 * the cash's own yield, over 12. The yield is the cash's interest over the 12-month window on its average balance
 * then. Null until both settings are set, or with nothing above the goals or nothing to gain.
 */
function cashAboveGoals(book: Book, month: string): { name: string; cents: number; drill: LineQuery } | null {
  const s = retirementSettings()
  if (s.realReturnBp === null || s.inflationBp === null) return null
  const w = windowOf(month, book.current)
  const y = yearOf(month, book.current)
  const end = lastDayOf(w.to)
  const saving = perimeter(w.to).map((id) => book.accounts.get(id)).filter((a): a is Account => a?.assetType === 'cash' && a.cashRole === 'saving')
  if (!saving.length) return null
  const ids = saving.map((a) => a.id)
  const want = new Set(ids)
  // Each day's closing balances over the 12 months: their last day is what's held, and their average what earned.
  const daily = db.balancesOver(ids, `${y.from}-01`, end)
  const held = ids.reduce((t, id) => t + (daily.byId.get(id)?.at(-1) ?? 0), 0)
  // Each linked goal holds its target from this cash, up to what it has saved over all its accounts.
  const goals = listGoals().filter((g) => g.archivedAt === null && g.funding === 'accounts' && g.accountIds.some((id) => want.has(id)))
  let claimed = 0
  if (goals.length) {
    const all = db.balancesOn([...new Set(goals.flatMap((g) => g.accountIds))], end)
    for (const g of goals) {
      const saved = g.accountIds.reduce((t, id) => t + (all.get(id) ?? 0), 0) - (g.startCents ?? 0)
      const cash = g.accountIds.filter((id) => want.has(id)).reduce((t, id) => t + (all.get(id) ?? 0), 0)
      claimed += Math.max(0, Math.min(g.targetCents, saved, cash))
    }
  }
  const above = held - claimed
  if (above <= 0) return null
  // The interest that set the yield is the drill: one account's, or with several, those lines by their ids, so the
  // spending accounts' interest stays out of it.
  let interest = 0
  const paid = new Set<string>()
  for (const m of monthsFrom(y.from, y.to)) {
    for (const l of book.byMonth.get(m) ?? []) {
      if (!personalPart(l) || l.cls !== 'cashReturn' || !want.has(l.accountId)) continue
      interest += l.cents
      paid.add(l.txnId)
    }
  }
  const summed = ids.reduce((t, id) => t + (daily.byId.get(id) ?? []).reduce((u, c) => u + c, 0), 0)
  const yieldBp = summed > 0 ? roundDiv(interest * 10000 * daily.days.length, summed) : 0
  const cents = roundDiv(above * (s.realReturnBp + s.inflationBp - yieldBp), 120_000)
  if (cents <= 0) return null
  return { name: saving.length === 1 ? saving[0].name : 'Savings', cents, drill: { fromDay: `${y.from}-01`, toDay: end, cls: ['cashReturn'], ...(saving.length === 1 ? { accountId: saving[0].id } : { ids: [...paid] }) } }
}

// ---------- retirement ----------

/** The retire.* settings (spec 7): whole numbers, each unset until Review sets it. None has a default (Decision 9). */
export const RETIRE_KEYS = { birthYear: 'retire.birthYear', age: 'retire.age', realReturnBp: 'retire.realReturnBp', inflationBp: 'retire.inflationBp' } as const
export type RetirementSettings = Record<keyof typeof RETIRE_KEYS, number | null>

export function retirementSettings(): RetirementSettings {
  const read = (key: string): number | null => {
    const v = setting<unknown>(key, null)
    return typeof v === 'number' && Number.isInteger(v) ? v : null
  }
  return { birthYear: read(RETIRE_KEYS.birthYear), age: read(RETIRE_KEYS.age), realReturnBp: read(RETIRE_KEYS.realReturnBp), inflationBp: read(RETIRE_KEYS.inflationBp) }
}

/** Sets the settings given, or clears those given as null; the rest stay. Every one is checked before any is written. */
export function setRetirement(patch: Partial<RetirementSettings>): RetirementSettings {
  const thisYear = Number(db.today().slice(0, 4))
  const within = (v: number | null | undefined, lo: number, hi: number, problem: string): void => {
    if (v !== null && v !== undefined && !(Number.isInteger(v) && v >= lo && v <= hi)) throw new Error(problem)
  }
  within(patch.birthYear, 1900, thisYear, `The birth year is a year from 1900 to ${thisYear}`)
  within(patch.age, 18, 100, 'The retirement age is whole years from 18 to 100')
  within(patch.realReturnBp, -1000, 2000, 'The real return is a percent a year from -10 to 20')
  within(patch.inflationBp, -500, 2000, 'Inflation is a percent a year from -5 to 20')
  db.inTransaction(() => {
    for (const [field, key] of Object.entries(RETIRE_KEYS) as Array<[keyof RetirementSettings, string]>) {
      const v = patch[field]
      if (v !== undefined) db.setSetting(key, v === null ? null : String(v))
    }
  })
  return retirementSettings()
}

/** What the Personal investment, retirement and HSA accounts held at the last full month's end: what the open month's retirement line grows. */
export function investedBalance(): number {
  const ids = investedAccounts(db.listAccounts()).map((a) => a.id)
  return [...db.balancesOn(ids, before(`${db.today().slice(0, 7)}-01`)).values()].reduce((s, c) => s + c, 0)
}

/**
 * The retirement line at a month (spec 1.7): B, what is invested at the end of the month's run-rate window (the
 * month's own end, or for the open month the last full month's, as its run rates are), and A, 12 times the month's
 * Invested run rate, grown n years at the real return r: B (1 + r)^n + A ((1 + r)^n - 1) / r, or B + A n when r is
 * 0, in floating point and rounded to cents at the end. In today's dollars, as r is real. n is the retirement age
 * less the age reached in the month's year, never below 0. Null until the birth year, the age and the return are set.
 */
function retirementOf(book: Book, month: string, now: Figures): Retirement | null {
  const s = retirementSettings()
  if (s.birthYear === null || s.age === null || s.realReturnBp === null) return null
  const year = Number(month.slice(0, 4))
  const years = Math.max(0, s.age - (year - s.birthYear))
  const b = book.investedOn(lastDayOf(windowOf(month, book.current).to))
  const a = 12 * now.rows.invested
  const r = s.realReturnBp / 10000
  const g = (1 + r) ** years
  const projected = r === 0 ? b + a * years : b * g + (a * (g - 1)) / r
  return { birthYear: s.birthYear, retireAge: s.age, realReturnBp: s.realReturnBp, years, year: year + years, investedCents: b, contributionCents: now.rows.invested, projectedCents: Math.round(projected) }
}

// ---------- Growth's drill ----------

/**
 * What Growth's drill shows beside its row over a span (spec 1.7 and 1.12). Each invested account's return as its
 * Growth part has it, over the span (`actual`) and as its run rate at the span's end (`now`), a return of 0 included
 * so an account that earned nothing shows it did, and null where it can't be measured (no part): a statement not in
 * yet, or values and flows that make no track. Over the days it can't be measured, what its value did and what was put
 * in (`unmeasured`), which the bridge's Revaluation holds as the change less the money put in: never a return, and
 * never a revaluation of the account. The measured returns by tax treatment, so the treatments, the accounts and Cash
 * return all add up to Growth to the cent. The accounts' time-weighted return together over the 12-month window of the
 * span's end (spec 1.1 and 1.12: the twelve months ending with it, or the full months before the open month), the
 * months Growth's run rate beside it reads, as the Investments page measures every account together, from the same
 * tracks the returns came from. And the bridge's Revaluation of each Personal asset over the span (`revalued`), each
 * that moved.
 */
function growthDrill(book: Book, p: ParsedSpan, endMonth: string, actual: Figures, now: Figures, identities: Pick<Identities, 'revalued' | 'unmeasured'>): GrowthDrill {
  const accounts: AccountReturn[] = []
  for (const a of book.invested) {
    const key = `return:${a.id}`
    const cents = actual.parts.growth.get(key)
    const rate = now.parts.growth.get(key)
    const off = identities.unmeasured.get(a.id) ?? null
    if (cents === undefined && rate === undefined && !off) continue
    accounts.push({
      accountId: a.id,
      name: a.name,
      assetType: a.assetType,
      treatment: db.taxTreatment(a),
      actualCents: cents ?? null,
      perMonthCents: cents === undefined ? null : perMonth(cents, p),
      runRateCents: rate ?? null,
      unmeasured: off
    })
  }
  // In the order Growth's parts are in: the largest run rate first, then the largest return.
  const size = (c: number | null): number => Math.abs(c ?? 0)
  accounts.sort((x, y) => size(y.runRateCents) - size(x.runRateCents) || size(y.actualCents) - size(x.actualCents) || x.accountId.localeCompare(y.accountId))
  // The year's time-weighted return over the months Growth's run rate reads, with what each account held as they began.
  const year = yearOf(endMonth, book.current)
  const fromDay = before(`${year.from}-01`)
  const toDay = lastDayOf(year.to)
  const held = db.balancesOn(
    book.invested.map((a) => a.id),
    fromDay
  )
  const twr = twrTogether(
    book.invested.map((a) => ({ track: book.track(a.id), cents: held.get(a.id) ?? 0 })),
    fromDay,
    toDay
  )
  const revaluation = [...identities.revalued]
    .filter(([, cents]) => cents !== 0)
    .map(([id, cents]) => {
      const a = book.accounts.get(id)
      return { accountId: id, name: a?.name ?? id, assetType: a?.assetType ?? 'other_asset', cents }
    })
    .sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents) || x.name.localeCompare(y.name))
  const measured = accounts.filter((a) => a.actualCents !== null || a.runRateCents !== null)
  return {
    accounts,
    byTreatment: returnsByTreatment(measured).map((t) => ({ ...t, perMonthCents: perMonth(t.actualCents, p) })),
    twr: { fromDay, toDay, rate: twr },
    revaluation
  }
}

// ---------- the identities ----------

// Two identities reconcile the rows with the balances, month by month (spec 2); a span's are its months' added up,
// each month cut to the span's days. Positive is money kept.
//
// Cash: Kept + Ventures + Cash return + Unsorted = Moved to savings + Left in checking + Debt paid down + Moved to
// investments + Bought assets + In transit + Unexplained.
//   - Ventures is the venture lines in the ledger less every Personal line on a venture's own cash and cards whose
//     funding has no intent: a Personal grocery on the business card adds back what the venture paid for it, and a
//     venture's repair paid from checking takes it away. A Personal line on a venture's account that moved money to
//     another of a venture's accounts is in both, so it nets to nothing. Money between Personal and a venture that
//     has an intent (rule 0) is in the term its class reads instead: a draw or a gift in Kept, a repayment's
//     interest in Cash return, a claim in Bought assets, a venture's loan in Debt paid down; a funding with an intent
//     is its intent parts', so its line leaves the term. With no intent set, this is the Ventures of before, line
//     for line.
//   - Moved to savings and Left in checking are what the perimeter's saving and spending cash accounts went up by.
//   - Debt paid down is minus the principal lines plus what the perimeter's cards went down by; money borrowed
//     makes it negative.
//   - Moved to investments, Bought assets and In transit are minus the invested, capital and internal lines.
//   - Unexplained is what is left over. It is measured a second time as its items: each balance gap (db.balanceGaps,
//     in the sign of dailyBalances' err) and minus each orphan line, so a missing purchase and money sent to an
//     account that isn't tracked are both positive. A difference between the two is an engine error, so a line the
//     classifier lost can't hide in a gap.
//
// Net worth: its change = Saved + Growth + Revaluation + Ventures(NW) + Unsorted - In transit - Unexplained + Other,
// over every visible account net worth counts, each in one group.
//   - The perimeter changes by the cash identity.
//   - A Personal investment, retirement or HSA account changes by its return (in Growth), what came in from the
//     perimeter and from payroll, and money from outside or across a month's end (an item). One whose return can't
//     be measured has its change less those flows in Revaluation.
//   - A Personal asset changes by what was bought or sold of it, what its loans financed without touching the
//     perimeter, and its revaluation.
//   - A Personal debt changes by minus its principal lines, less what was financed on it, and a residual (an item):
//     what it owes moving with no payment or borrowing behind it.
//   - A venture's accounts' change joins the Ventures term in Ventures(NW).
//   - A manual account first valued in the month with no opening day is added (an item), and saving at work that went
//     to a plan with no tracked account is an item too.
// What the terms don't add up to is an engine error.

/** What the identities read over some days besides the ledger's lines, read once: the accounts and their balances, the perimeter's gaps, the transfers' legs, the capital windows and the paycheck plans. */
interface Reckoning {
  accounts: Account[]
  byId: Map<string, Account>
  /** every visible account net worth reads: Personal's, and the accounts the ventures' positions read */
  counted: string[]
  /** the visible Personal accounts: in no venture, not linked to a venture's asset, and no Stakes account linked to one */
  personal: Set<string>
  /** what the ventures' positions read, and each venture's position at a day's end, for the days `balance` has */
  ventures: PositionBook
  positionsAt: (day: string) => Map<number, Position>
  /** an account's balance at a day's end, for the days from the one before the first to the last */
  balance: (id: string, day: string) => number
  gaps: db.BalanceGap[]
  pairOf: Map<string, db.TransferLeg>
  windows: CapitalWindow[]
  plans: ReturnType<typeof db.listContributionRows>
  /** the invested account each plan's saving lands in, by the plan's id */
  planAccount: Map<number, string>
}

function reckon(book: Book, fromDay: string, toDay: string): Reckoning {
  const accounts = [...book.accounts.values()]
  const counted = db.countedAccounts()
  const months = monthsFrom(fromDay.slice(0, 7), toDay.slice(0, 7))
  const perimeters = [...new Set(months.flatMap((m) => perimeter(m, accounts)))]
  const balances = db.balancesOver([...new Set([...counted, ...perimeters])], before(fromDay), toDay)
  const at = new Map(balances.days.map((d, i) => [d, i]))
  // A capital window moves what was financed on its own day alone: read them only when an asset opened or closed then.
  const dated = accounts.some((a) => ASSETS.has(a.assetType) && [a.openedDay, a.closedDay].some((d) => !!d && d >= fromDay && d <= toDay))
  const plans = db.listContributionRows()
  const planAccount = new Map<number, string>()
  for (const a of book.invested) {
    const plan = planFor(a, db.taxTreatment(a), plans)
    if (plan && !planAccount.has(plan.id)) planAccount.set(plan.id, a.id)
  }
  for (const plan of plans) if (plan.accountId) planAccount.set(plan.id, plan.accountId)
  const balance = (id: string, day: string): number => {
    const i = at.get(day)
    return i === undefined ? 0 : (balances.byId.get(id)?.[i] ?? 0)
  }
  const ventures = positionBook(toDay)
  const positions = new Map<string, Map<number, Position>>()
  return {
    accounts,
    byId: book.accounts,
    counted,
    personal: new Set(ventures.personal),
    ventures,
    positionsAt: (day) => {
      if (!positions.has(day)) positions.set(day, positionsOn(ventures, day, (id) => balance(id, day)))
      return positions.get(day)!
    },
    balance,
    gaps: db.balanceGaps(perimeters, fromDay, toDay),
    pairOf: db.transferPairs(fromDay, toDay).pairOf,
    windows: dated ? capitalWindows() : [],
    plans,
    planAccount
  }
}

/** A month's identities over some of its days, and their leak items. */
interface Identities {
  identity: CashIdentity
  bridge: NetWorthBridge
  /** the itemized parts of Unexplained, and the cash identity's engine error */
  cashLeaks: LeakItem[]
  /** the bridge's engine error */
  bridgeLeaks: LeakItem[]
  /** the bridge's Revaluation by Personal asset (property, a vehicle, another asset, money lent, a stake) */
  revalued: Map<string, number>
  /**
   * each invested account whose return over some of these days can't be measured: its value's change and the money
   * put in over them, from cash and from pay. The bridge's Revaluation holds the change less the money put in.
   */
  unmeasured: Map<string, Unmeasured>
}

/** An invested account's value change and the money put in over days its return can't be measured. */
interface Unmeasured {
  changeCents: number
  putInCents: number
}

/** Each invested account's return over a month, as Growth reads it; null when it can't be measured. */
const gainsOf = (book: Book, month: string): Map<string, number | null> => new Map(book.invested.map((a) => [a.id, book.gains.get(month)?.get(a.id) ?? null]))

/** Each invested account's return over some days. */
const gainsOver = (book: Book, fromDay: string, toDay: string): Map<string, number | null> => new Map(book.invested.map((a) => [a.id, gainsOn(book.track(a.id), [before(fromDay), toDay])[0] ?? null]))

/**
 * Both identities over some days of one month: `lines` are the ledger's lines then, and `gains` each invested
 * account's return over them.
 */
function identitiesOf(book: Book, r: Reckoning, piece: { month: string; fromDay: string; toDay: string }, lines: ClassifiedLine[], gains: Map<string, number | null>): Identities {
  const start = before(piece.fromDay)
  const change = (id: string): number => r.balance(id, piece.toDay) - r.balance(id, start)
  const sum = (f: (l: ClassifiedLine) => boolean): number => lines.reduce((s, l) => (f(l) ? s + l.cents : s), 0)
  /** Minus some lines' sum: what they took from the perimeter (0, not -0, for none). */
  const minus = (f: (l: ClassifiedLine) => boolean): number => -sum(f) || 0
  const legOf = (l: ClassifiedLine): db.TransferLeg | undefined => (l.splitId === null ? r.pairOf.get(l.txnId) : undefined)
  const t = tally(book, lines)

  // The cash identity.
  const per = perimeter(piece.month, r.accounts)
  const inPerimeter = new Set(per)
  let moved = 0
  let checking = 0
  let cards = 0
  for (const id of per) {
    const a = r.byId.get(id)!
    if (a.assetType === 'credit_card') cards += change(id)
    else if (a.cashRole === 'saving') moved += change(id)
    else checking += change(id)
  }
  // The Personal lines a venture's cash or card paid whose funding has intent parts.
  const funded = new Set(lines.filter((l) => isFundPart(l)).map((l) => `${l.txnId}:${l.splitId ?? ''}`))
  const identity: CashIdentity = {
    keptCents: t.kept,
    venturesCents: sum((l) => l.cls === 'venture') - sum((l) => !l.perimeter && !isFundPart(l) && !funded.has(`${l.txnId}:${l.splitId ?? ''}`)),
    cashReturnCents: t.cashReturn,
    unsortedCents: t.unsorted,
    movedCents: moved,
    checkingCents: checking,
    debtPaidCents: minus((l) => l.cls === 'principal') + cards,
    toInvestmentsCents: minus((l) => l.cls === 'invested'),
    boughtCents: minus((l) => l.cls === 'capital'),
    inTransitCents: minus((l) => l.cls === 'internal'),
    unexplainedCents: 0,
    itemizedCents: 0,
    engineErrorCents: 0
  }
  const left = identity.keptCents + identity.venturesCents + identity.cashReturnCents + identity.unsortedCents
  identity.unexplainedCents = left - (moved + checking + identity.debtPaidCents + identity.toInvestmentsCents + identity.boughtCents + identity.inTransitCents)

  // Unexplained, item by item: each gap on a perimeter account, and the orphan lines, by the account they left (or
  // the hidden account they went to).
  const cashLeaks: LeakItem[] = []
  for (const g of r.gaps) {
    if (g.month !== piece.month || !inPerimeter.has(g.accountId)) continue
    cashLeaks.push({ kind: 'balance_gap', cents: -g.cents, accountId: g.accountId, ...(g.fromDay ? { fromDay: g.fromDay } : {}), ...(g.toDay ? { toDay: g.toDay } : {}) })
  }
  const orphans = new Map<string, LeakItem>()
  for (const l of lines) {
    if (l.cls !== 'orphan') continue
    const leg = legOf(l)
    const hidden = !!leg && r.byId.get(leg.accountId)?.hidden !== false
    const kind = hidden ? 'hidden_account' : 'orphan_transfer'
    const accountId = hidden ? leg!.accountId : l.accountId
    let item = orphans.get(`${kind}:${accountId}`)
    if (!item) orphans.set(`${kind}:${accountId}`, (item = { kind, cents: 0, accountId, txnIds: [] }))
    item.cents -= l.cents
    if (!item.txnIds!.includes(l.txnId)) item.txnIds!.push(l.txnId)
  }
  cashLeaks.push(...[...orphans.values()].filter((x) => x.cents !== 0))
  identity.itemizedCents = cashLeaks.reduce((s, x) => s + x.cents, 0)
  identity.engineErrorCents = identity.unexplainedCents - identity.itemizedCents
  if (identity.engineErrorCents) cashLeaks.push({ kind: 'engine_error', cents: identity.engineErrorCents, fromDay: piece.fromDay, toDay: piece.toDay })

  // The bridge. Saved and Growth are the rows' own amounts over these days.
  const checks = book.checks.filter((c) => c.day >= piece.fromDay && c.day <= piece.toDay)
  const saved = t.kept + checks.reduce((s, c) => s + c.savedAtWorkCents + c.employerSavingCents, 0)
  let growth = t.cashReturn
  for (const g of gains.values()) growth += g ?? 0
  const other = new Map<string, NetWorthBridge['other'][number]>()
  const item = (kind: NetWorthBridge['other'][number]['kind'], accountId: string, cents: number): void => {
    if (!cents) return
    const x = other.get(`${kind}\u0000${accountId}`)
    if (x) x.cents += cents
    else other.set(`${kind}\u0000${accountId}`, { kind, accountId, cents })
  }
  // Saving at work, by the account its plan pays into; a plan with no tracked account is saving net worth can't see.
  const invested = new Set(book.invested.map((a) => a.id))
  const fromPay = new Map<string, number>()
  for (const c of checks) {
    const claimed = plansOfCheck(c, r.plans)
    for (const x of c.items) {
      if (PAYSTUB_ITEMS[x.kind].row !== 'savedAtWork') continue
      const plan = claimed.get(x)
      const account = plan === undefined ? undefined : r.planAccount.get(plan)
      const cents = x.cents + (x.employerCents ?? 0)
      if (account && invested.has(account)) fromPay.set(account, (fromPay.get(account) ?? 0) + cents)
      else item('untrackedSaving', account ?? '', -cents)
    }
  }
  const financedOf = (assetId: string): number => r.windows.filter((w) => w.assetId === assetId && w.day >= piece.fromDay && w.day <= piece.toDay).reduce((s, w) => s + w.financedCents, 0)
  const financedOn = (debtId: string): number =>
    r.windows.filter((w) => w.day >= piece.fromDay && w.day <= piece.toDay).reduce((s, w) => s + w.loans.filter((x) => x.debtId === debtId).reduce((t, x) => t + x.cents, 0), 0)
  /** A manual account first valued in these days with no opening day of its own: its first known value. */
  const added = (a: Account): number => (a.source === 'manual' && !a.openedDay && !!a.historyFrom && a.historyFrom > start && a.historyFrom <= piece.toDay && r.balance(a.id, start) === 0 ? r.balance(a.id, a.historyFrom) : 0)
  let revaluation = 0
  const revalued = new Map<string, number>()
  const revalue = (id: string, cents: number): void => {
    revaluation += cents
    revalued.set(id, (revalued.get(id) ?? 0) + cents)
  }
  const unmeasured = new Map<string, Unmeasured>()
  let startCents = 0
  let endCents = 0
  // Personal's accounts. A venture's are in its position, and so is a Stakes account linked to one: Revaluation and
  // the debt residual read none of them.
  for (const id of r.counted) {
    if (!r.personal.has(id)) continue
    startCents += r.balance(id, start)
    endCents += r.balance(id, piece.toDay)
    const a = r.byId.get(id)
    if (!a || inPerimeter.has(id)) continue
    const moves = change(id)
    const first = added(a)
    item('added', id, first)
    const rest = moves - first
    if (invested.has(id)) {
      const flows = minus((l) => l.cls === 'invested' && legOf(l)?.accountId === id) + (fromPay.get(id) ?? 0)
      const gain = gains.get(id) ?? null
      if (gain === null) {
        // Its return can't be measured (its statement isn't in yet, or its values make no track): Revaluation holds
        // its change less what was put in, which is not a return and not a revaluation of its own.
        revaluation += rest - flows
        if (rest || flows) unmeasured.set(id, { changeCents: rest, putInCents: flows })
      } else item('outsideFlow', id, rest - gain - flows)
    } else if (ASSETS.has(a.assetType)) {
      revalue(id, rest + sum((l) => l.cls === 'capital' && l.assetId === id) - financedOf(id))
    } else if (DEBTS.has(a.assetType)) {
      item('debtResidual', id, rest + sum((l) => l.cls === 'principal' && l.debtId === id) + financedOn(id))
    }
  }
  // Each venture's position at the start and the end (ventureMoney.ts). Ventures(NW) is the cash identity's Ventures
  // plus each one's change in position, less what Bought assets and Debt paid down already hold of it: the capital
  // and principal parts with an intent (rule 0) that moved its claims or its stake, which no Personal account absorbs.
  const from = r.positionsAt(start)
  const to = r.positionsAt(piece.toDay)
  const ventures = r.ventures.ventures.map((v) => ({ bucketId: v.id, startCents: from.get(v.id)?.positionCents ?? 0, endCents: to.get(v.id)?.positionCents ?? 0 }))
  let positionMoves = 0
  for (const v of ventures) {
    startCents += v.startCents
    endCents += v.endCents
    positionMoves += v.endCents - v.startCents
  }
  const boughtOfVentures = minus((l) => l.cls === 'capital' && l.ventureId !== null && l.intent !== null)
  const principalOfVentures = minus((l) => l.cls === 'principal' && l.ventureId !== null && l.intent !== null)
  const items = [...other.values()].filter((x) => x.cents !== 0)
  const bridge: NetWorthBridge = {
    startCents,
    endCents,
    savedCents: saved,
    growthCents: growth,
    revaluationCents: revaluation,
    venturesCents: identity.venturesCents + positionMoves - boughtOfVentures - principalOfVentures,
    unsortedCents: identity.unsortedCents,
    inTransitCents: identity.inTransitCents,
    unexplainedCents: identity.unexplainedCents,
    otherCents: items.reduce((s, x) => s + x.cents, 0),
    other: items,
    engineErrorCents: 0,
    ventures
  }
  const terms = bridge.savedCents + bridge.growthCents + bridge.revaluationCents + bridge.venturesCents + bridge.unsortedCents - bridge.inTransitCents - bridge.unexplainedCents + bridge.otherCents
  bridge.engineErrorCents = endCents - startCents - terms
  const bridgeLeaks: LeakItem[] = bridge.engineErrorCents ? [{ kind: 'engine_error', cents: bridge.engineErrorCents, fromDay: piece.fromDay, toDay: piece.toDay }] : []
  return { identity, bridge, cashLeaks, bridgeLeaks, revalued, unmeasured }
}

/** Months' identities added up, in order: the bridge runs from the first one's start to the last one's end. */
function together(list: Identities[]): Identities {
  if (list.length === 1) return list[0]
  const identity = { ...list[0].identity }
  for (const x of list.slice(1)) for (const k of Object.keys(identity) as Array<keyof CashIdentity>) identity[k] += x.identity[k]
  // Each venture's position from the first month's start to the last month's end.
  const ends = new Map(list[list.length - 1].bridge.ventures.map((v) => [v.bucketId, v.endCents]))
  const ventures = list[0].bridge.ventures.map((v) => ({ ...v, endCents: ends.get(v.bucketId) ?? 0 }))
  const bridge: NetWorthBridge = { ...list[0].bridge, endCents: list[list.length - 1].bridge.endCents, other: [], ventures }
  const numbers = ['savedCents', 'growthCents', 'revaluationCents', 'venturesCents', 'unsortedCents', 'inTransitCents', 'unexplainedCents', 'otherCents', 'engineErrorCents'] as const
  for (const x of list.slice(1)) for (const k of numbers) bridge[k] += x.bridge[k]
  const other = new Map<string, NetWorthBridge['other'][number]>()
  for (const x of list.flatMap((y) => y.bridge.other)) {
    const k = `${x.kind}\u0000${x.accountId}`
    const was = other.get(k)
    if (was) was.cents += x.cents
    else other.set(k, { ...x })
  }
  bridge.other = [...other.values()].filter((x) => x.cents !== 0)
  // A gap or an orphan's items over several months are one each, by account (and for a gap, its pair of balances).
  const leaks = new Map<string, LeakItem>()
  const cashLeaks: LeakItem[] = []
  for (const x of list.flatMap((y) => y.cashLeaks)) {
    if (x.kind === 'engine_error') {
      cashLeaks.push(x)
      continue
    }
    const k = [x.kind, x.accountId, x.fromDay, x.toDay].join('\u0000')
    const was = leaks.get(k)
    if (!was) {
      const copy = { ...x, ...(x.txnIds ? { txnIds: [...x.txnIds] } : {}) }
      leaks.set(k, copy)
      cashLeaks.push(copy)
      continue
    }
    was.cents += x.cents
    for (const id of x.txnIds ?? []) if (!was.txnIds!.includes(id)) was.txnIds!.push(id)
  }
  // Revaluation by asset, and what the accounts whose return can't be measured did, each month's added up, as the
  // bridge's Revaluation is.
  const revalued = new Map<string, number>()
  for (const x of list) for (const [id, cents] of x.revalued) revalued.set(id, (revalued.get(id) ?? 0) + cents)
  const unmeasured = new Map<string, Unmeasured>()
  for (const x of list)
    for (const [id, u] of x.unmeasured) {
      const was = unmeasured.get(id)
      unmeasured.set(id, was ? { changeCents: was.changeCents + u.changeCents, putInCents: was.putInCents + u.putInCents } : { ...u })
    }
  return { identity, bridge, cashLeaks: cashLeaks.filter((x) => x.cents !== 0), bridgeLeaks: list.flatMap((y) => y.bridgeLeaks), revalued, unmeasured }
}

/** A month's identities, from what it reads alone; `lines` replaces the classifier's when given. */
function monthIdentities(month: string, lines?: ClassifiedLine[]): Identities {
  if (!isMonth(String(month))) throw new Error('A month is like 2026-10')
  const fromDay = `${month}-01`
  const toDay = lastDayOf(month)
  const book = readBook(fromDay, toDay, db.today().slice(0, 7), [], [month])
  return identitiesOf(book, reckon(book, fromDay, toDay), { month, fromDay, toDay }, lines ?? (book.byMonth.get(month) ?? []), gainsOf(book, month))
}

/**
 * A month's cash identity (spec 2, identity 3) and its leak items: the balance gaps, orphan transfers and money
 * sent to hidden accounts that make up Unexplained, and an engine_error item when they don't add up to it.
 * `lines` is the month's ledger, as classifyLines gives it, when the caller has it.
 */
export function cashIdentity(month: string, lines?: ClassifiedLine[]): { identity: CashIdentity; leaks: LeakItem[] } {
  const x = monthIdentities(month, lines)
  return { identity: x.identity, leaks: x.cashLeaks }
}

/** A month's net worth bridge (spec 2, identity 6), with an engine_error item when its terms don't add up to the change in net worth. */
export function netWorthBridge(month: string): { bridge: NetWorthBridge; leaks: LeakItem[] } {
  const x = monthIdentities(month)
  return { bridge: x.bridge, leaks: x.bridgeLeaks }
}

/** The status a month's close gives it (spec 2, When): closed when Unexplained is within the tolerance and neither identity has an engine error, else gap. */
export function closingStatus(w: Pick<Waterfall, 'identity' | 'bridge' | 'toleranceCents'>): 'closed' | 'gap' {
  return Math.abs(w.identity.unexplainedCents) <= w.toleranceCents && !w.identity.engineErrorCents && !w.bridge.engineErrorCents ? 'closed' : 'gap'
}

// ---------- parts ----------

const GROUP_OF: Partial<Record<string, CommittedGroup>> = { housing: 'housing', utilities: 'utilities', insurance: 'insurance', subscriptions: 'subscriptions', fuel: 'vehicles', auto: 'vehicles' }

/** A part's name, drill and group or tag, from its key. */
function partInfo(book: Book, row: PartRow, key: string, t: Tally): Pick<StagePart, 'name' | 'tag' | 'group'> & { drill: Omit<LineQuery, 'fromDay' | 'toDay'> } {
  const [kind, ...rest] = key.split(':')
  const ref = rest.join(':')
  const ids = [...(t.ids.get(key) ?? [])]
  const category = (id: string): string => (id === 'none' ? 'Uncategorized' : (book.categories.get(Number(id)) ?? 'Uncategorized'))
  const categoryId = (id: string): number | 'none' => (id === 'none' ? 'none' : Number(id))
  switch (kind) {
    case 'pay':
      return { name: book.series.get(ref)?.name ?? ref.replace(/\|[+-]$/, ''), drill: { cls: ['pay'], paycheckKey: ref } }
    case 'income':
      return { name: category(ref), drill: { cls: ['income'], categoryId: categoryId(ref) } }
    // A venture's draws: regular ones in Gross pay, the rest in One-offs.
    case 'draw':
      return { name: `Draws · ${book.ventures.get(Number(ref)) ?? ref}`, drill: { cls: row === 'gross' ? ['income'] : ['oneOffIncome'], ventureId: Number(ref), intent: 'draw' } }
    case 'tax':
      return { name: ref === 'estimated' ? 'Estimated tax' : ref === 'due' ? 'Balance due' : 'Refund', drill: { cls: ['tax'], ids } }
    case 'series': {
      const s = book.series.get(ref)
      const role = categoryRole(s?.categoryName)
      const group = (role && GROUP_OF[role]) ?? ((s?.categoryName ?? '').toLowerCase() === 'transportation' ? 'vehicles' : 'other')
      return { name: s?.name ?? ref.replace(/\|[+-]$/, ''), group, drill: { cls: ['committed'], seriesKey: ref } }
    }
    case 'loan': {
      const a = book.accounts.get(ref)
      const asset = a?.linkedAssetId ? book.accounts.get(a.linkedAssetId) : undefined
      return { name: a?.name ?? ref, group: asset?.assetType === 'property' ? 'housing' : 'debtCost', drill: { cls: ['debtCost'], ids } }
    }
    // A card's interest charges, by their transactions: a loan's interest paid with the card is on the card too, and
    // it's the loan's.
    case 'card':
      return { name: book.accounts.get(ref)?.name ?? ref, group: 'debtCost', drill: { cls: ['debtCost'], ids } }
    case 'committed':
      return { name: 'Other', group: 'other', drill: { cls: ['committed', 'debtCost'], ids } }
    // The interest on a venture's loan to the user.
    case 'ventureLoan':
      return { name: book.ventures.get(Number(ref)) ?? ref, group: 'debtCost', drill: { cls: ['debtCost'], ventureId: Number(ref), intent: 'venture_loan_repayment' } }
    case 'cat':
      return row === 'everyday'
        ? { name: category(ref), tag: book.essential(category(ref)) ? 'essential' : 'lifestyle', drill: { cls: ['everyday'], categoryId: categoryId(ref) } }
        : { name: category(ref), drill: { cls: ['oneOff', 'oneOffIncome'], categoryId: categoryId(ref) } }
    case 'kept':
      return { name: 'Kept', drill: { cls: KEPT } }
    case 'atWork':
      return { name: 'Saved at work', drill: { cls: ['pay'] } }
    case 'employer':
      return { name: 'Employer saving', drill: { cls: ['pay'] } }
    case 'fromCash':
      return { name: 'From cash', drill: { cls: ['invested'] } }
    case 'return':
      return { name: book.accounts.get(ref)?.name ?? ref, drill: { accountId: ref } }
    case 'cashReturn':
      return { name: 'Cash return', drill: { cls: ['cashReturn'] } }
    default:
      return { name: key, drill: { ids } }
  }
}

/**
 * A row's parts over the span, with their run rates and changes: largest first. A part gone since 3 months before
 * stays, at nothing now, so the parts' changes add up to the row's (Growth has no change). Committed's parts also
 * carry what the Elective drill shows beside them: a series' cadence and price change, whether it's confirmed, a
 * debt's rate and a loan's escrow, and the part over the span's full months beside the same months a year before.
 */
function partsOf(book: Book, row: PartRow, actual: Figures, now: Figures, then: Figures, t: Tally, from: RateFrom | null, single: boolean, p: ParsedSpan, changeFrom: Figures = now): StagePart[] {
  const keys = new Set([...actual.parts[row].keys(), ...now.parts[row].keys(), ...(row === 'growth' ? [] : [...then.parts[row].keys(), ...changeFrom.parts[row].keys()])])
  // The span's full months, the open month left out, beside the same months a year before: like with like, so a bill
  // not yet paid this month isn't a fall. Only for twelve months or fewer, so the year before doesn't overlap them,
  // and only when every month a year before is in the books (from Personal's first line), as a month before they
  // begin isn't a month of 0. A span of days has none.
  const full = row === 'committed' && !p.days ? p.months.filter((m) => m < book.current) : []
  const first = full.length && full.length <= 12 ? (firstLedgerDay()?.slice(0, 7) ?? null) : null
  const compared = first !== null && shiftMonth(full[0], -12) >= first && `${shiftMonth(full[0], -12)}-01` >= book.fromDay ? full : null
  const sameMonths = compared ? sumTallies(compared.map((m) => monthTally(book, m))).committed : null
  const yearAgo = compared ? sumTallies(compared.map((m) => monthTally(book, shiftMonth(m, -12)))).committed : null
  const out: StagePart[] = []
  for (const key of keys) {
    const a = actual.parts[row].get(key) ?? 0
    const rr = now.parts[row].get(key) ?? 0
    if (!a && !rr && !then.parts[row].get(key) && !changeFrom.parts[row].get(key) && row !== 'saved' && row !== 'invested') continue
    const info = partInfo(book, row, key, t)
    const part: StagePart = {
      key,
      name: info.name,
      actualCents: a,
      perMonthCents: perMonth(a, p),
      runRateCents: rr,
      // The change over 3 months, from the run rates the row's own change reads (a changed month's closed ones).
      changeCents: row === 'growth' ? null : (changeFrom.parts[row].get(key) ?? 0) - (then.parts[row].get(key) ?? 0),
      rate: from ? (single ? ratePct(rr, baseOf(now, from)) : ratePct(a, baseOf(actual, from))) : null,
      drill: { fromDay: p.fromDay, toDay: p.toDay, ...info.drill }
    }
    if (info.tag) part.tag = info.tag
    if (info.group) part.group = info.group
    const marker = now.markers.get(key)
    if (marker) part.marker = marker
    if (row === 'committed') {
      const [kind, ...rest] = key.split(':')
      const ref = rest.join(':')
      if (kind === 'series') {
        const s = book.series.get(ref)
        if (s) part.cadence = s.cadence
        const price = now.force.prices.get(key)
        if (price) part.price = price
        // A series the user hasn't confirmed is the classifier's guess; Review asks about it (recurring_unconfirmed).
        // It says so beside a price change too, which holds the marker.
        if (s) part.confirmed = s.confirmed
        if (!marker && s && !s.confirmed) part.marker = 'unconfirmed'
      } else if (kind === 'loan') {
        part.aprBp = aprBpOf(book.accounts.get(ref))
        part.escrowCents = now.force.escrow.get(ref) ?? null
      } else if (kind === 'card') part.aprBp = now.force.aprs.get(ref) ?? aprBpOf(book.accounts.get(ref))
      part.yearAgo = compared && sameMonths && yearAgo ? { fromMonth: compared[0], toMonth: compared[compared.length - 1], cents: sameMonths.get(key) ?? 0, wasCents: yearAgo.get(key) ?? 0 } : null
    }
    out.push(part)
  }
  if (row === 'saved' || row === 'invested') return out
  return out.sort((x, y) => Math.abs(y.runRateCents ?? 0) - Math.abs(x.runRateCents ?? 0) || Math.abs(y.actualCents) - Math.abs(x.actualCents) || x.key.localeCompare(y.key))
}

/** A month's run rates by row (spec 1.1), with the window they're over and where the pay figures come from. */
export function runRates(month: string): { month: string; fromMonth: string; toMonth: string; basis: PayBasis | null; rows: Record<StageId, number>; employerSavingCents: number } {
  if (!isMonth(String(month))) throw new Error('A month is like 2026-10')
  const current = db.today().slice(0, 7)
  const w = windowOf(month, current)
  const end = lastDayOf(w.to)
  const fromDay = [`${yearOf(month, current).from}-01`, addDays(end, 1 - LOOKBACK_DAYS)].sort()[0]
  const book = readBook(fromDay, end, current, [end, before(`${w.to}-01`)], monthsFrom(yearOf(month, current).from, w.to))
  const r = monthRates(book, month)
  return { month, fromMonth: w.from, toMonth: w.to, basis: r.basis, rows: r.rows, employerSavingCents: r.employerSaving }
}

/** The classes the debt plan's spending reads in a month: Committed without what debts charge, Everyday and One-offs. */
const PLAN_SPENDING = new Set<LineClass>(['committed', 'everyday', 'oneOff', 'oneOffIncome'])

/**
 * What the debt plan reads of the run rates in force at a month (spec 1.6, from phase 2), the last full month's for
 * the open month. Take-home is the Take-home run rate, by where it comes from: each payroll as its checks deposit it,
 * other income by category, and estimated tax paid from the bank, less. Spending is the Committed run rate without
 * what debts charge (the plan pays each debt's minimum and works out its interest itself), plus the Everyday and
 * One-offs run rates: one-offs count, as a month the plan can keep to has to pay for them too. A loan's escrow is
 * spending too: it pays the home's taxes and insurance, which a month costs whatever the plan does, and never brings
 * the loan down. Beside them, the same spending in each month of the 12-month window, and each Personal debt's latest
 * payment without its escrow, its principal and interest together, at Personal's part of it: what the plan pays
 * toward the debt each month at the least. And Everyday's run rate by category with One-offs', so the plan can ask
 * what a month would cost at the targets set.
 */
export function planRates(month: string): { takeHomeCents: number; sources: Array<{ name: string; cents: number }>; spendCents: number; months: Array<{ month: string; cents: number }>; payments: Map<string, number>; everyday: Map<string, number>; oneOffsCents: number } {
  if (!isMonth(String(month))) throw new Error('A month is like 2026-10')
  const current = db.today().slice(0, 7)
  const w = windowOf(month, current)
  const y = yearOf(month, current)
  const end = lastDayOf(w.to)
  const fromDay = [`${y.from}-01`, addDays(end, 1 - LOOKBACK_DAYS)].sort()[0]
  const book = readBook(fromDay, end, current, [end, before(`${w.to}-01`)], [])
  const r = monthRates(book, month)
  // Take-home by source: a payroll's gross less what comes off it plus its Payroll difference, other income, and the bank's estimated tax.
  const of = (row: PartRow, key: string): number => r.parts[row].get(key) ?? 0
  const keys = new Set([...r.parts.gross.keys(), ...r.parts.taxes.keys(), ...r.parts.benefits.keys(), ...r.parts.savedAtWork.keys(), ...r.parts.payrollDiff.keys()])
  const sources = [...keys]
    .map((key) => ({ name: partInfo(book, key.startsWith('tax:') ? 'taxes' : 'gross', key, emptyTally()).name, cents: of('gross', key) - of('taxes', key) - of('benefits', key) - of('savedAtWork', key) + of('payrollDiff', key) }))
    .filter((s) => s.cents !== 0)
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
  // Committed in force without debts' interest and card interest: the series, and each loan's escrow in force.
  let series = 0
  for (const [key, cents] of r.parts.committed) if (key.startsWith('series:')) series += cents
  let escrow = 0
  for (const cents of r.force.escrow.values()) escrow += cents ?? 0
  // What a payment holds in escrow: what its debt says it holds, at Personal's share, never more than its interest and escrow.
  const escrowIn = (debtId: string, p: { cents: number; shareBp: number }): number => Math.min(p.cents, shareCents(book.accounts.get(debtId)?.escrowCents ?? 0, p.shareBp))
  const escrowBy = new Map<string, number>()
  for (const [debtId, pays] of book.loanPays) for (const p of pays) escrowBy.set(p.day.slice(0, 7), (escrowBy.get(p.day.slice(0, 7)) ?? 0) + escrowIn(debtId, p))
  const months = monthsFrom(y.from, y.to).map((m) => ({ month: m, cents: (book.byMonth.get(m) ?? []).reduce((s, l) => s + (personalPart(l) && PLAN_SPENDING.has(l.cls) ? -l.cents : 0), 0) + (escrowBy.get(m) ?? 0) }))
  // Each debt's latest payment: the money out of one transaction to it, principal and interest and escrow.
  const latest = new Map<string, { day: string; txnId: string; cents: number }>()
  for (const l of book.lines) {
    if (!personalPart(l) || !l.debtId || (l.cls !== 'principal' && l.cls !== 'debtCost') || l.cents >= 0) continue
    const debt = book.accounts.get(l.debtId)
    if (!debt || !DEBTS.has(debt.assetType)) continue
    const was = latest.get(l.debtId)
    if (was?.txnId === l.txnId) was.cents -= l.cents
    else if (!was || l.day >= was.day) latest.set(l.debtId, { day: l.day, txnId: l.txnId, cents: -l.cents })
  }
  // Its escrow left out: that money is spending above, and the debt owes none of it.
  const payments = new Map(
    [...latest].map(([id, p]) => {
      const pay = book.loanPays.get(id)?.find((x) => x.txnId === p.txnId)
      return [id, p.cents - (pay ? escrowIn(id, pay) : 0)]
    })
  )
  // Everyday's run rate by category (cat:<id>, or cat:none) and One-offs', which the debt plan puts at their targets.
  return { takeHomeCents: r.rows.takeHome, sources, spendCents: series + escrow + r.rows.everyday + r.rows.oneOffs, months, payments, everyday: r.parts.everyday, oneOffsCents: r.rows.oneOffs }
}
