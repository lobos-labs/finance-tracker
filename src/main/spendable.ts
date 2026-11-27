import * as db from './db'
import { historyPending, plaidBills, RECENT_DAYS } from './bankHistory'
import { essentialTier } from './budget'
import { categoryRole } from '../shared/categoryRole'
import { gigPay, irregularEarnings, type Earnings } from './earnings'
import { vendorHider } from './privacy'
import { cancelledByNow, renewalMarks } from './renewals'
import { CADENCES, LOAN, nextDate, recurringHistory, type SeriesHistory } from './recurring'
import { occurrences } from '../shared/schedule'
import { addDays, addMonths, dayFrom, daysBetween, weekday } from '../shared/zone'
import { DEFAULT_SPEND_RISK, isDebtType, type Account, type RecurringKind, type SpendAccount, type SpendDay, type SpendItem, type SpendRisk, type Spendable } from '../shared/types'

// What can be spent from a cash account today without dipping below the
// cushion before the second payday from now. Each recurring bill, paycheck
// and transfer is forecast on its day at one amount: a bill that varies (a
// utility, a card payment) at last year's amount for the same season, scaled
// to its level now; a card paid in full at what it owes. Everyday essentials
// paid straight from the account (groceries, gas) land on the days those trips
// usually happen. Pay that keeps no schedule (gig apps, tips) comes a week at a
// time (earnings.ts); with no regular payday the forecast runs two weeks. The
// risk setting says how sure to play it: balanced (Most likely), the default,
// takes the usual amounts and timing; cautious (Worst case) the dearest
// amounts and the worst timing seen, so the number errs low.
// While a bank's history is still arriving (bankHistory.ts) the number is
// provisional: a bill seen once lately is counted again a month on, at the
// cautious margin whatever the risk, since recurring detection hasn't seen it
// enough yet, and irregular pay counts at its floor.

const DAY = 86_400
/** A balance older than this doesn't start a forecast. */
const FRESH_DAYS = 7
const LIST_DAYS = 30
const MIN_DAYS = 14
const MAX_DAYS = 45
/** How far back everyday trips are read, and how many make a habit worth forecasting. */
const TRIP_DAYS = 90
const MIN_TRIPS = 3
/** How much more a varying bill can come to, played cautious. */
const CAUTIOUS_MARGIN = 1.15
/** The most a payment's day moves from its schedule, played cautious. */
const MAX_SHIFT = 5
const MAX_CUSHION = 1_000_000_000

const RISKS: readonly SpendRisk[] = ['cautious', 'balanced', 'tight']

export function spendSettings(): { risk: SpendRisk; cushionCents: number; accountId: string | null } {
  const risk = db.getSetting('spend.risk') as SpendRisk | null
  const cushion = Number(db.getSetting('spend.cushion') ?? 0)
  return {
    risk: risk && RISKS.includes(risk) ? risk : DEFAULT_SPEND_RISK,
    cushionCents: Number.isSafeInteger(cushion) && cushion > 0 ? cushion : 0,
    accountId: db.getSetting('spend.account') || null
  }
}

export function setSpendSettings(patch: { risk?: SpendRisk; cushionCents?: number; accountId?: string | null }): void {
  if (patch.risk !== undefined) {
    if (!RISKS.includes(patch.risk)) throw new Error(`Unknown risk "${String(patch.risk)}"`)
    db.setSetting('spend.risk', patch.risk)
  }
  if (patch.cushionCents !== undefined) {
    const c = Math.round(Number(patch.cushionCents))
    if (!Number.isFinite(c) || c < 0 || c > MAX_CUSHION) throw new Error('The cushion is between $0 and $10,000,000.')
    db.setSetting('spend.cushion', String(c))
  }
  if (patch.accountId !== undefined) db.setSetting('spend.account', patch.accountId || null)
}

// ---------- bank days ----------

/** The nth weekday of a month (0-11; n = -1: the last). */
function nthWeekday(y: number, m: number, day: number, n: number): string {
  if (n > 0) {
    const first = weekday(dayFrom(y, m + 1, 1))
    return dayFrom(y, m + 1, 1 + ((day - first + 7) % 7) + (n - 1) * 7)
  }
  const last = dayFrom(y, m + 2, 0)
  return dayFrom(y, m + 1, Number(last.slice(8)) - ((weekday(last) - day + 7) % 7))
}

/** A fixed-date holiday (month 0-11): on a Sunday the banks close Monday; on a Saturday they don't move it. */
function fixedHoliday(y: number, m: number, d: number): string {
  const date = dayFrom(y, m + 1, d)
  return weekday(date) === 0 ? addDays(date, 1) : date
}

const holidays = new Map<number, Set<string>>()

/** The Federal Reserve's holidays, when ACH doesn't settle. */
function bankHolidays(y: number): Set<string> {
  let set = holidays.get(y)
  if (!set) {
    set = new Set([
      fixedHoliday(y, 0, 1),
      nthWeekday(y, 0, 1, 3),
      nthWeekday(y, 1, 1, 3),
      nthWeekday(y, 4, 1, -1),
      fixedHoliday(y, 5, 19),
      fixedHoliday(y, 6, 4),
      nthWeekday(y, 8, 1, 1),
      nthWeekday(y, 9, 1, 2),
      fixedHoliday(y, 10, 11),
      nthWeekday(y, 10, 4, 4),
      fixedHoliday(y, 11, 25)
    ])
    holidays.set(y, set)
  }
  return set
}

export function isBankDay(day: string): boolean {
  const w = weekday(day)
  return w !== 0 && w !== 6 && !bankHolidays(Number(day.slice(0, 4))).has(day)
}

/** The day itself if banks are open, else the nearest open day before (-1) or after (1). */
export function bankDay(day: string, dir: 1 | -1): string {
  let d = day
  for (let i = 0; i < 10 && !isBankDay(d); i++) d = addDays(d, dir)
  return d
}

// ---------- amounts and timing ----------

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * What a varying payment comes to around `at` (unix), in positive cents: the
 * payment nearest the same day last year, scaled by how its latest payments
 * compare with the same payments a year before; its recent level without
 * a payment from that season.
 */
export function seasonal(points: SeriesHistory['points'], at: number): number {
  const abs = points.map((p) => ({ posted: p.posted, c: Math.abs(p.cents) }))
  const yearBefore = (t: number): { posted: number; c: number } | undefined =>
    abs.filter((p) => Math.abs(p.posted - (t - 365 * DAY)) <= 20 * DAY).sort((a, b) => Math.abs(a.posted - (t - 365 * DAY)) - Math.abs(b.posted - (t - 365 * DAY)))[0]
  const ago = yearBefore(at)
  if (!ago) return Math.round(median(abs.slice(-3).map((p) => p.c)))
  const pairs = abs.slice(-3).flatMap((p) => {
    const was = yearBefore(p.posted)
    return was && was !== p ? [[p.c, was.c]] : []
  })
  const now = pairs.reduce((t, [c]) => t + c, 0)
  const then = pairs.reduce((t, [, c]) => t + c, 0)
  const ratio = then > 0 ? Math.min(1.5, Math.max(0.67, now / then)) : 1
  return Math.round(ago.c * ratio)
}

/** How many days early (negative) or late each recent payment came, against the one before it. */
function drift(h: SeriesHistory): number[] {
  const s = h.series
  if (s.cadence === 'semimonthly') return []
  const days = CADENCES.find((c) => c.id === s.cadence)!.days
  const p = h.points.slice(-7)
  return p.slice(1).map((x, i) => Math.round((x.posted - nextDate(p[i].posted, s.cadence, days)) / DAY))
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

// ---------- the forecast ----------

interface Leg {
  account: Account
  sign: 1 | -1
  name: string
  /** the card this pays, when it's a card payment */
  card: Account | null
}

/** What's bought and then used up: the next trip comes when it runs out. */
const STOCKED = new Set(['fuel', 'groceries'])

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
}

/**
 * Everyday essentials paid straight from an account (groceries, gas): each
 * category's trips over the last 90 days, forecast on the days they tend to
 * happen at what a trip tends to cost. Gas and groceries come back when what
 * was bought runs out, at the rate they've been used; other weekly trips land
 * on their usual weekday; the rest every usual gap from the last one. Cautious takes a
 * dearer trip (the upper quartile) and the shorter gaps.
 */
function everydayTrips(a: Account, billKeys: Set<string>, essential: (c: string) => boolean, risk: SpendRisk, now: number, today: string, through: string): SpendItem[] {
  const rows = db
    .all<{ posted: number; cents: number; category: string | null; key: string }>(
      `SELECT t.posted, t.amount_cents AS cents, c.name AS category, lower(trim(COALESCE(t.merchant, t.desc_key))) || '|-' AS key
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.account_id = ? AND t.posted > ? AND t.posted <= ? AND t.amount_cents < 0 AND t.one_time = 0 AND (c.kind IS NULL OR c.kind != 'transfer')`,
      a.id,
      now - TRIP_DAYS * DAY,
      now
    )
    .filter((r) => r.category !== null && essential(r.category) && !billKeys.has(r.key))
  // One trip a day per category: two stops on a Saturday are one shop.
  const byCategory = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const days = byCategory.get(r.category!) ?? new Map<string, number>()
    const day = db.dayKey(r.posted)
    days.set(day, (days.get(day) ?? 0) - r.cents)
    byCategory.set(r.category!, days)
  }
  const out: SpendItem[] = []
  for (const [category, trips] of byCategory) {
    const days = [...trips.keys()].sort()
    if (days.length < MIN_TRIPS) continue
    const amounts = days.map((d) => trips.get(d)!)
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d))
    const cents = Math.round(risk === 'cautious' ? quantile(amounts, 0.75) : median(amounts))
    const gap = Math.max(1, Math.round(risk === 'cautious' ? quantile(gaps, 0.25) : median(gaps)))
    const weekdays = days.map(weekday)
    const counts = [0, 1, 2, 3, 4, 5, 6].map((w) => weekdays.filter((x) => x === w).length)
    const usual = counts.indexOf(Math.max(...counts))
    const last = days[days.length - 1]
    const dates: string[] = []
    if (STOCKED.has(categoryRole(category) ?? '')) {
      // Gas and groceries last as long as what was bought: a $5 top-up comes back sooner than a full tank, a
      // big shop later than a quick one. The rate is what each trip bought per day until the next (worst case:
      // one of the faster ones).
      const bought = amounts.slice(0, -1)
      const rate = risk === 'cautious' ? quantile(bought.map((c, i) => c / Math.max(1, gaps[i])), 0.75) : bought.reduce((t, c) => t + c, 0) / Math.max(1, daysBetween(days[0], last))
      const lasts = (c: number): number => clamp(Math.round(c / rate), 1, 45)
      let d = addDays(last, lasts(amounts[amounts.length - 1]))
      if (d < today) d = today
      for (; d <= through; d = addDays(d, lasts(cents))) dates.push(d)
    } else if (gap >= 5 && gap <= 9 && counts[usual] / days.length >= 0.4) {
      let d = last > today ? last : today
      d = addDays(d, Math.max(0, daysBetween(d, addDays(last, 4))))
      while (weekday(d) !== usual) d = addDays(d, 1)
      for (; d <= through; d = addDays(d, 7)) dates.push(d)
    } else {
      let d = addDays(last, gap)
      if (d < today) d = today
      for (; d <= through; d = addDays(d, gap)) dates.push(d)
    }
    for (const day of dates) out.push({ key: `everyday:${a.id}:${category}:${day}`, day, name: category, kind: 'other', cents: -cents, accountId: a.id, accountName: a.name, estimated: true, late: false, everyday: true })
  }
  return out
}

/** Irregular pay's weeks laid on the coming days: on its payout weekday (that day's bank day, by the risk), else a seventh each day from tomorrow. */
function earnedItems(e: Earnings, a: Account, risk: SpendRisk, today: string, through: string): SpendItem[] {
  const cents = e.weekly[risk]
  if (cents <= 0) return []
  const item = (day: string, scheduled: string, c: number): SpendItem => ({ key: `earnings:${a.id}:${scheduled}`, day, name: e.name, kind: 'income', cents: c, accountId: a.id, accountName: a.name, estimated: true, late: false, irregular: true })
  const out: SpendItem[] = []
  if (e.weekday !== null) {
    // Not again today once today's is in.
    let d = e.last >= today ? addDays(today, 1) : today
    while (weekday(d) !== e.weekday) d = addDays(d, 1)
    for (; d <= through; d = addDays(d, 7)) {
      let day = risk === 'tight' ? d : bankDay(d, risk === 'cautious' ? 1 : -1)
      if (day < today) day = today
      out.push(item(day, d, cents))
    }
  } else {
    // Earned as the week goes; what came today may already be in.
    const daily = Math.floor(cents / 7)
    for (let d = addDays(today, 1); daily > 0 && d <= through; d = addDays(d, 1)) out.push(item(d, d, daily))
  }
  return out
}

/** A bill seen lately that recurring detection hasn't found yet, as it would come again. */
interface Seen {
  key: string
  name: string
  kind: RecurringKind
  /** what it came to, plus the cautious margin (negative) */
  cents: number
  accountId: string
  /** a month after it was last seen */
  next: string
}

/** What the app's own category says a charge is, when it's a bill: housing, utilities and insurance; subscriptions; a lender's payment. */
function billKind(category: string | null, kind: string | null, name: string): RecurringKind | null {
  if (LOAN.test(name)) return 'loan'
  if (kind === 'transfer' || kind === 'income') return null
  const role = categoryRole(category)
  return role === 'housing' || role === 'utilities' || role === 'insurance' ? 'bill' : role === 'subscriptions' ? 'subscription' : null
}

/**
 * While a bank's history is still arriving: each bill paid in the last weeks
 * (by Plaid's category or the app's) whose payee isn't a recurring series yet,
 * expected a month after it was last paid.
 */
function seenOnce(now: number, history: SeriesHistory[], hidden: (name: string) => boolean): Seen[] {
  const plaid = plaidBills()
  const known = new Set(history.map((h) => h.series.key.split('|').slice(0, 2).join('|')))
  const rows = db.all<{ id: string; posted: number; cents: number; name: string; category: string | null; kind: string | null; key: string; accountId: string }>(
    `SELECT t.id, t.posted, t.amount_cents AS cents, COALESCE(t.merchant, t.description) AS name, c.name AS category, c.kind AS kind,
            lower(trim(COALESCE(t.merchant, t.desc_key))) || '|-' AS key, t.account_id AS accountId
     ${db.VISIBLE_TXN_FROM}
     WHERE t.posted > ? AND t.posted <= ? AND t.amount_cents < 0 AND t.one_time = 0 AND COALESCE(t.merchant, t.desc_key) != ''
     ORDER BY t.posted`,
    now - RECENT_DAYS * DAY,
    now
  )
  // The latest of each payee's on each account.
  const latest = new Map<string, Seen>()
  for (const r of rows) {
    if (known.has(r.key)) continue
    const kind = plaid.get(r.id) ?? billKind(r.category, r.kind, r.name)
    if (!kind) continue
    const name = hidden(r.name) ? (r.category ?? 'Bill') : r.name
    latest.set(`${r.key}\u0000${r.accountId}`, { key: r.key, name, kind, cents: -Math.round(-r.cents * CAUTIOUS_MARGIN), accountId: r.accountId, next: addMonths(db.dayKey(r.posted), 1) })
  }
  return [...latest.values()]
}

/** What the forecast reads once and runs at each risk. */
interface Context {
  now: number
  today: string
  accounts: Account[]
  history: SeriesHistory[]
  hidden: (name: string) => boolean
  essential: (category: string) => boolean
  /** bills seen once, while the bank's history arrives */
  seen: Seen[]
  /** irregular pay, by account */
  earnings: Earnings[]
  /** asked to cancel by text, and past its date with no charge (renewals.ts) */
  cancelled: (s: SeriesHistory['series']) => boolean
}

/** What can be spent from each cash account, at each risk; the details at the one picked. */
export function getSpendable(): Spendable {
  const { risk, cushionCents, accountId: picked } = spendSettings()
  const now = db.now()
  const today = db.dayKey(now)
  const provisional = historyPending()
  const marks = renewalMarks()
  const accounts = db.listAccounts()
  const history = recurringHistory()
  const hidden = vendorHider()
  // Personal cash only: an account a venture holds is the venture's money.
  const cash = new Set(accounts.filter((a) => a.assetType === 'cash' && a.bucketId === null && !a.hidden && !(a.closedDay && a.closedDay <= today)).map((a) => a.id))
  const ctx: Context = {
    now,
    today,
    accounts,
    history,
    hidden,
    essential: essentialTier(),
    seen: provisional ? seenOnce(now, history, hidden) : [],
    earnings: irregularEarnings({ now, today, cash: (id) => cash.has(id), history, hidden, provisional }),
    cancelled: (s) => cancelledByNow(s, today, marks[s.key])
  }
  const runs = Object.fromEntries(RISKS.map((r) => [r, forecast(r, cushionCents, ctx)])) as Record<SpendRisk, ReturnType<typeof forecast>>
  const { accounts: out, items } = runs[risk]
  for (const a of out) a.byRisk = Object.fromEntries(RISKS.map((r) => [r, runs[r].accounts.find((x) => x.id === a.id)?.spendableCents ?? a.spendableCents])) as Record<SpendRisk, number>
  return { risk, cushionCents, accountId: out.find((a) => a.id === picked)?.id ?? out[0]?.id ?? null, accounts: out, items, provisional }
}

/**
 * Home's Spendable strip (spec section 4): what the account shown first can spend today at the risk chosen, and the
 * last day its forecast keeps the cushion through, and the risk it plays (an asterisk unless Worst case). Null when no
 * cash account has a current balance.
 */
export function spendableStrip(s: Spendable = getSpendable()): { cents: number; untilDay: string; risk: SpendRisk } | null {
  const a = s.accounts.find((x) => x.id === s.accountId) ?? s.accounts[0]
  const last = a?.days.at(-1)
  return a && last ? { cents: a.spendableCents, untilDay: last.day, risk: s.risk } : null
}

function forecast(risk: SpendRisk, cushionCents: number, { now, today, accounts, history, hidden, essential, seen, earnings, cancelled }: Context): { accounts: SpendAccount[]; items: SpendItem[] } {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const open = (a: Account): boolean => !a.hidden && !(a.closedDay && a.closedDay <= today)
  const isCash = (a: Account): boolean => a.assetType === 'cash' && a.bucketId === null && open(a)
  const to = addDays(today, MAX_DAYS)
  const items: SpendItem[] = []

  for (const h of history) {
    const s = h.series
    if (s.dismissed || s.status === 'stopped' || cancelled(s)) continue
    // A gig app's pay comes as irregular earnings, however steady it's been lately.
    if (gigPay(s)) continue
    const own = s.accountId ? byId.get(s.accountId) : undefined
    if (!own || !open(own)) continue
    const pair = s.pairAccountId ? byId.get(s.pairAccountId) : undefined
    const name = hidden(s.name) ? (s.categoryName ?? 'Bill') : s.name

    const legs: Leg[] = []
    if (isCash(own)) legs.push({ account: own, sign: 1, name, card: pair?.assetType === 'credit_card' && s.typicalCents < 0 ? pair : null })
    if (pair && pair.id !== own.id && isCash(pair)) {
      const other = isDebtType(own.assetType) ? `${own.name} payment` : s.typicalCents > 0 ? `To ${own.name}` : `From ${own.name}`
      legs.push({ account: pair, sign: -1, name: other, card: own.assetType === 'credit_card' && s.typicalCents > 0 ? own : null })
    }
    // Charged to a card or another account: listed, with no balance to run. The receiving side of a debt payment isn't.
    if (!legs.length && s.kind !== 'transfer' && !(s.typicalCents > 0 && isDebtType(own.assetType))) legs.push({ account: own, sign: 1, name, card: null })

    // A card paid the same each month is paid that; one paid in full is paid what it owes.
    const near = (c: number): boolean => Math.abs(Math.abs(c) - Math.abs(s.typicalCents)) <= Math.abs(s.typicalCents) * 0.02
    const fixed = near(s.lastCents) && near(s.previousCents)
    const shifts = drift(h)

    // Dates already past haven't posted: they're expected today, once.
    const dates = occurrences(db.dayKey(s.nextDate), s.cadence, to)
    const when = dates.filter((d) => d >= today)
    const overdue = dates.length > when.length
    if (overdue && when[0] !== today) when.unshift(today)

    for (const leg of legs) {
      const into = leg.sign * s.typicalCents > 0
      // A late paycheck may not come: played cautious, it isn't counted.
      const late = (d: string): boolean => overdue && d === today
      when.forEach((scheduled, i) => {
        if (into && late(scheduled) && risk === 'cautious') return
        let day = scheduled
        if (risk === 'cautious' && !late(scheduled) && shifts.length) day = addDays(day, into ? clamp(Math.max(0, ...shifts), 0, MAX_SHIFT) : clamp(Math.min(0, ...shifts), -MAX_SHIFT, 0))
        // Money in lands on the bank day before a weekend or holiday and money out on the one after, or the other way round, played cautious.
        if (risk !== 'tight') day = bankDay(day, into === (risk === 'cautious') ? 1 : -1)
        if (day < today) day = today

        const at = db.noon(scheduled)
        let cents: number
        let estimated = true
        if (leg.card && !fixed) {
          const est = seasonal(h.points, at)
          if (i === 0 && leg.card.balanceCents !== null) {
            const owed = Math.max(0, -leg.card.balanceCents)
            if (!owed) return
            cents = risk === 'cautious' ? Math.max(owed, est) : owed
          } else cents = risk === 'cautious' ? Math.round(est * CAUTIOUS_MARGIN) : est
        } else if (!s.variable || fixed) {
          cents = Math.abs(s.typicalCents)
          estimated = false
        } else {
          const est = seasonal(h.points, at)
          // Money in that varies is never counted above its usual, played cautious; money out a margin above.
          cents = risk !== 'cautious' ? est : into ? Math.min(est, Math.abs(s.typicalCents)) : Math.round(Math.max(est, Math.abs(s.lastCents)) * CAUTIOUS_MARGIN)
        }
        items.push({ key: `${s.key}:${leg.account.id}:${scheduled}`, day, name: leg.name, kind: s.kind, cents: into ? cents : -cents, accountId: leg.account.id, accountName: leg.account.name, estimated, late: late(scheduled), seriesKey: s.key })
      })
    }
  }
  // A bill seen once while the history arrives: a month on, played cautious whatever the risk (out on the bank day before).
  for (const b of seen) {
    const own = byId.get(b.accountId)
    if (!own || !isCash(own)) continue
    const dates = occurrences(b.next, 'monthly', to)
    const when = dates.filter((d) => d >= today)
    if (dates.length > when.length && when[0] !== today) when.unshift(today)
    for (const scheduled of when) {
      const day = bankDay(scheduled, -1)
      items.push({ key: `seen:${b.key}:${own.id}:${scheduled}`, day: day < today ? today : day, name: b.name, kind: b.kind, cents: b.cents, accountId: own.id, accountName: own.name, estimated: true, late: false, provisional: true })
    }
  }

  // On a day with money in and out, the money out goes first.
  items.sort((a, b) => a.day.localeCompare(b.day) || Number(a.cents > 0) - Number(b.cents > 0) || a.cents - b.cents || a.name.localeCompare(b.name))

  const billKeys = new Set([...history.filter((h) => h.series.typicalCents < 0).map((h) => h.series.key.split('|').slice(0, 2).join('|')), ...seen.map((b) => b.key)])
  const out: SpendAccount[] = []
  const everyday: SpendItem[] = []
  for (const a of accounts) {
    if (!isCash(a) || a.balanceDate === null || now - a.balanceDate > FRESH_DAYS * DAY) continue
    const known = [a.balanceCents, a.availableCents].filter((c): c is number => c !== null)
    if (!known.length) continue
    const bills = items.filter((i) => i.accountId === a.id)
    const paydays = [...new Set(bills.filter((i) => i.kind === 'income' && i.cents > 0).map((i) => i.day))]
    const earning = earnings.find((e) => e.accountId === a.id)
    // Paid irregularly with no payday to run to: two weeks.
    const last = clamp(paydays.length >= 2 ? daysBetween(today, paydays[1]) : earning && !paydays.length ? MIN_DAYS : LIST_DAYS, MIN_DAYS, MAX_DAYS)
    const trips = everydayTrips(a, billKeys, essential, risk, now, today, addDays(today, last))
    const earned = earning ? earnedItems(earning, a, risk, today, addDays(today, last)) : []
    everyday.push(...trips, ...earned)
    const mine = [...bills, ...trips, ...earned]
    const start = Math.min(...known)
    const days: SpendDay[] = []
    let bal = start
    for (let n = 0; n <= last; n++) {
      const day = addDays(today, n)
      const that = mine.filter((i) => i.day === day)
      const inCents = that.filter((i) => i.cents > 0).reduce((t, i) => t + i.cents, 0)
      const outCents = that.filter((i) => i.cents < 0).reduce((t, i) => t + i.cents, 0)
      const end = bal + inCents + outCents
      days.push({ day, startCents: bal, endCents: end, lowCents: risk === 'tight' ? end : bal + outCents, inCents, outCents })
      bal = end
    }
    const low = days.reduce((m, d) => (d.lowCents < m.lowCents ? d : m), days[0])
    const spendableCents = Math.min(start, low.lowCents) - cushionCents
    const nextPayday = paydays[0] ?? null
    out.push({
      id: a.id,
      name: a.name,
      startCents: start,
      balanceDate: a.balanceDate,
      spendableCents,
      lowDay: low.day,
      nextPayday,
      perDayCents: nextPayday ? Math.floor(spendableCents / Math.max(1, daysBetween(today, nextPayday))) : null,
      days,
      byRisk: { cautious: spendableCents, balanced: spendableCents, tight: spendableCents }
    })
  }
  // Paychecks (and irregular pay) land in the main account; the most of them first.
  const pay = (id: string): number => [...items, ...everyday].filter((i) => i.accountId === id && i.kind === 'income' && i.cents > 0).reduce((t, i) => t + i.cents, 0)
  out.sort((x, y) => pay(y.id) - pay(x.id) || y.startCents - x.startCents)
  const horizon = addDays(today, Math.max(LIST_DAYS, ...out.map((a) => a.days.length - 1)))
  const all = [...items, ...everyday].sort((a, b) => a.day.localeCompare(b.day) || Number(a.cents > 0) - Number(b.cents > 0) || a.cents - b.cents || a.name.localeCompare(b.name))
  return { accounts: out, items: all.filter((i) => i.day <= horizon) }
}
