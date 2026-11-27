import * as db from './db'
import { behindAccounts } from './feeds'
import { detectRecurring } from './recurring'
import { billShares, billTest, buildModel, personalSpending, recurringBills, type CategoryModel } from './spendModel'
import { daysAway, tripAt, tripWindows, type TripWindow } from './trips'
import { vendorHider } from './privacy'
import { categoryRole, nameWithRole, type CategoryRole } from '../shared/categoryRole'
import { dayBounds, LAST_30_DAYS, lastDays, WINDOW_DAYS } from '../shared/period'
import { daysInMonth as monthLength, shiftMonth } from '../shared/zone'
import { at } from '../shared/ranges'
import type { BudgetRow, BudgetTier, BudgetView, Habit, HabitOption, HabitProgress, HomePlans, LineQuery, RecurringSeries } from '../shared/types'

// The budget starts from base spending: what a month of essentials and
// lifestyle is likely to cost (spendModel: a range per category from the last
// six full months). One-off purchases (durable goods, travel, gifts, anything
// marked one-time, whatever's bought on a trip) stay out of it and get a budget
// of their own, since they can wait. Lifestyle habits are where to cut: each is
// measured ("about once a day") and offers specific commitments whose limit can
// be counted, and committing sets that budget line's target. Essentials only
// need watching for changes.

const monthStart = (month: string): number => db.monthStart(month)
const shift = shiftMonth
const toTen = (cents: number): number => Math.round(cents / 1000) * 1000
const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`
const exact = (cents: number): string => `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDay = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: db.zone() })

const DELIVERY = /doordash|uber\s*eats|grubhub|postmates|instacart|caviar|seamless|gopuff/i
/** A big meal out: a ticket of $100 or more. */
const BIG_MEAL = 10000
// Stated assumptions, national averages rather than anything measured from the user's data:
// what a meal cooked at home and a cup of coffee brewed at home cost, and how much cheaper the
// grocer the user names (prefs.cheaperStore) runs than the other places they buy groceries.
const HOME_MEAL = 1200
const HOME_COFFEE = 50
const CHEAPER_STORE_SAVES = 0.25
const EVERY: Record<string, string> = { weekly: 'every week', biweekly: 'every 2 weeks', semimonthly: 'twice a month', monthly: 'every month', quarterly: 'every 3 months', annual: 'every year' }

/** Categories' default tiers; any other category is lifestyle. */
const DEFAULT_TIER: Record<string, BudgetTier> = {
  Housing: 'essential',
  Utilities: 'essential',
  Insurance: 'essential',
  Groceries: 'essential',
  'Health & Medical': 'essential',
  'Gas & Fuel': 'essential',
  Transportation: 'essential',
  Taxes: 'essential',
  Pets: 'essential',
  'Fees & Interest': 'essential',
  Shopping: 'oneoff',
  Travel: 'oneoff',
  'Gifts & Donations': 'oneoff',
  Education: 'oneoff',
  Other: 'oneoff'
}

/** The name an uncategorized purchase goes by: it's Unsorted, Home's row of its own, and in no tier until it's categorized. */
const UNSORTED = 'Uncategorized'

/** Tiers by role, for a category the user renamed. */
const ROLE_TIER: Partial<Record<CategoryRole, BudgetTier>> = { housing: 'essential', utilities: 'essential', insurance: 'essential', groceries: 'essential', health: 'essential', taxes: 'essential', fees: 'essential' }
const roleTier = (name: string): BudgetTier | undefined => {
  const role = categoryRole(name)
  return role ? ROLE_TIER[role] : undefined
}

/** The one-off budget line, as a habit's category. */
const ONE_OFFS = 'One-offs'
// Least necessary first: where cutting back starts.
const KIND_ORDER: Habit['kind'][] = ['eat_out', 'big_meals', 'delivery', 'coffee', 'merchant', 'subscription', 'oneoff', 'groceries']
/** What a habit's limit counts, one and many. */
const NOUN: Record<Habit['kind'], [string, string]> = {
  eat_out: ['meal out', 'meals out'],
  big_meals: ['big meal out', 'big meals out'],
  delivery: ['order', 'orders'],
  coffee: ['coffee out', 'coffees out'],
  merchant: ['purchase', 'purchases'],
  subscription: ['charge', 'charges'],
  groceries: ['trip to another grocer', 'trips to other grocers'],
  oneoff: ['purchase', 'purchases']
}

interface Commitment {
  optionId: string
  label: string
  savingsCents: number
  category: string
  /** the habit as it was measured when the commitment was made */
  title?: string
  limit?: HabitOption['limit']
  /** when it was made (unix): the first month counts from that day */
  since?: number
}

interface Prefs {
  tiers: Record<string, BudgetTier>
  /** habit id → the commitment made, already part of that line's target */
  commitments: Record<string, Commitment>
  /** a line's target from before its first commitment, put back when the last one is undone */
  before: Record<string, number | null>
  hidden: string[]
  oneOffTargetCents: number | null
  /** the grocer the groceries habit measures against; null offers no groceries habit */
  cheaperStore: string | null
}

const PREFS_KEY = 'budget.prefs'

// What's stored and not read here stays as it was: the payoff order chosen before the debt plan had a setting of its
// own (debtStrategy), which debts.ts reads until something sets debt.plan.
function loadPrefs(): Prefs {
  const raw = db.getSetting(PREFS_KEY)
  const p = (raw ? JSON.parse(raw) : {}) as Partial<Prefs>
  return { ...p, tiers: p.tiers ?? {}, commitments: p.commitments ?? {}, before: p.before ?? {}, hidden: p.hidden ?? [], oneOffTargetCents: p.oneOffTargetCents ?? null, cheaperStore: p.cheaperStore ?? null }
}

/** Forgets the commitments made for a line (its target was set some other way). */
function dropChoices(prefs: Prefs, category: string): void {
  for (const [id, c] of Object.entries(prefs.commitments)) if (c.category === category) delete prefs.commitments[id]
  delete prefs.before[category]
}

const savePrefs = (p: Prefs): void => db.setSetting(PREFS_KEY, JSON.stringify(p))

const tierOf = (name: string, prefs: Prefs): BudgetTier => prefs.tiers[name] ?? DEFAULT_TIER[name] ?? roleTier(name) ?? 'lifestyle'

/** Whether a category is an essential (the user's tier, or its default). */
export function essentialTier(): (category: string) => boolean {
  const prefs = loadPrefs()
  return (category) => tierOf(category, prefs) === 'essential'
}

/** A store's name without the noise around it: "Harbor Marketplace" is Harbor. */
const brand = (m: string): string => m.replace(/\s+(games|marketplace|store|\.com|online|inc\.?)(\s.*)?$/i, '').trim()
/** Whether a purchase was at the named store: "WHOLEFDS MKT #123" is Whole Foods, "ALDI 71" is Aldi. */
const atStore = (store: string, merchant: string): boolean => merchant.toLowerCase().includes(store.toLowerCase())

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)
/** How often, from times a month: "about once a day", "about 3 times a week", "about twice a month". */
function often(perMonth: number): string {
  const day = perMonth / 30.44
  const week = perMonth / 4.35
  if (day >= 1.75 || (day >= 0.85 && day < 1.25)) return `about ${times(Math.round(day))} a day`
  if (week >= 0.85) return `about ${times(Math.round(week))} a week`
  return `about ${times(Math.max(1, Math.round(perMonth)))} a month`
}

interface Purchase {
  id: string
  account: string
  cat: number | null
  name: string
  m: string
  posted: number
  merchant: string
  key: string
  cents: number
  /** marked one-time */
  marked: boolean
  /** the trip it was bought on (a recurring bill paid while away isn't) */
  trip: string | null
}

/** Personal spending between two unix times, purchase by purchase, at Personal's part of each (spendModel.personalSpending). */
function purchases(from: number, to: number, trips: TripWindow[], isBill: ReturnType<typeof billTest>): Purchase[] {
  return personalSpending(from, to).map((r) => ({
    id: r.id,
    account: r.account,
    cat: r.cat,
    name: r.name,
    m: r.m,
    posted: r.posted,
    merchant: r.merchant,
    key: r.key,
    cents: r.cents,
    marked: r.oneTime,
    trip: isBill(r) ? null : (tripAt(trips, r.posted)?.name ?? null)
  }))
}

type TargetHistory = ReturnType<typeof db.budgetHistory>

/** The target a category had in a month, from its history (oldest first); null with none. */
function targetIn(history: TargetHistory, categoryId: number, month: string): number | null {
  let cents: number | null = null
  for (const h of history.get(categoryId) ?? []) {
    if (h.month > month) break
    cents = h.cents
  }
  return cents
}

/**
 * What carries into `month` for each category with rollover on. From the month it was turned on, each
 * month's target plus what carried into it, less what was spent in it (base spending, as the rows count
 * it), carries into the next: a leftover adds, an overspend takes away. A month with no target carries
 * nothing on. Recounted from the transactions each time, so a charge that posts late still counts.
 */
function carries(month: string, rollovers: Map<number, string>, history: TargetHistory, trips: TripWindow[], isBill: ReturnType<typeof billTest>): Map<number, number> {
  const out = new Map<number, number>()
  const started = [...rollovers].filter(([, from]) => from < month)
  if (!started.length) return out
  const first = started.reduce((a, [, from]) => (from < a ? from : a), month)
  const spent = new Map<string, number>()
  for (const p of purchases(monthStart(first), monthStart(month), trips, isBill)) {
    if (p.marked || p.trip || p.cat === null) continue
    const k = `${p.cat}|${p.m}`
    spent.set(k, (spent.get(k) ?? 0) + p.cents)
  }
  for (const [id, from] of started) {
    let carry = 0
    for (let m = from; m < month; m = shift(m, 1)) {
      const target = targetIn(history, id, m)
      carry = target === null ? 0 : target + carry - Math.max(0, spent.get(`${id}|${m}`) ?? 0)
    }
    out.set(id, carry)
  }
  return out
}

/** What changed in an essential: a bill's new price, or more spent than usual (`when` says over what: "so far", "in 30 days"). */
function alertFor(c: CategoryModel, spent: number, bills: RecurringSeries[], current: boolean, when: string): string | null {
  const changed = bills.find((s) => s.categoryName === c.name && s.priceChanged && db.now() - s.lastDate < 62 * 86_400)
  if (changed) return `${changed.name} went from ${exact(changed.previousCents)} to ${exact(changed.lastCents)}`
  const q = current && c.toDate ? c.toDate : c.month
  if (spent > at(q, 90) && spent - at(q, 90) >= 2500) return `${dollars(spent)} ${when}, usually up to ${dollars(at(q, 90))}${current ? ' by now' : ''}`
  return null
}

/**
 * The budget for a month, or for the last 30 days (LAST_30_DAYS). The last 30 days are a whole
 * month's worth of spending, so they count against the same monthly ranges and targets as a full
 * month does, and read the same on the 2nd as on the 28th; habits and their commitments stay with
 * the current month.
 */
export function getBudget(period: string): BudgetView {
  return budgetOf(period).view
}

/** How a habit was measured, as Home's Left over shows it under its category: a short name, how often, and the purchases it was measured from. */
interface Measured {
  name: string
  often: string | null
  drill: LineQuery
}

/** The budget for a period, and how each habit in it was measured. */
function budgetOf(period: string): { view: BudgetView; measured: Map<string, Measured> } {
  const prefs = loadPrefs()
  const today = db.today()
  const current = today.slice(0, 7)
  const days = period === LAST_30_DAYS ? lastDays(WINDOW_DAYS, today) : null
  const month = days ? current : period
  const bounds = days ? dayBounds(days.from, days.to, db.zone()) : null
  // Ranges come from the six full months before this one (before the current month when looking ahead).
  const anchor = month > current ? current : month
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = monthLength(y, m)
  const dayOfMonth = month === current && !days ? Number(today.slice(8)) : null
  const late = month === current ? behindAccounts(db.now()) : []
  const names = db.listCategories().filter((c) => c.kind === 'expense').map((c) => c.name)
  const oneOffNames = names.filter((n) => tierOf(n, prefs) === 'oneoff')
  const oneOffCategory = new Set(oneOffNames)
  const model = buildModel(anchor, { dayOfMonth, daysInMonth, behind: late.map((a) => a.id), skip: [...oneOffNames, UNSORTED] })
  const months = model.months
  const through = shift(month > anchor ? month : anchor, 1)
  const budgets = db.listBudgets()
  const smallCents = Math.max(10000, Math.round(at(model.total, 50) * 0.01))
  const series = detectRecurring()
  const bills = series.filter((s) => !s.dismissed && s.status !== 'stopped' && s.typicalCents < 0)
  const trips = tripWindows()
  const isBill = billTest(billShares(recurringBills(series)))
  // Uncategorized purchases are Unsorted, in no category row and not one-offs, until they're categorized; one marked
  // one-time or bought on a trip is a one-off all the same, as the classifier counts it in Home's One-offs.
  const all = purchases(monthStart(months[0]), monthStart(through), trips, isBill).filter((p) => p.cat !== null || p.marked || p.trip !== null)
  const isOneOff = (p: Purchase): boolean => p.marked || p.trip !== null || oneOffCategory.has(p.name)
  const hidden = vendorHider()

  // Base spending by category and month: what's left once one-offs are out (marked one-time, or bought away).
  const spend = new Map<string, { cat: number | null; cents: number }>()
  for (const p of all) {
    if (p.marked || p.trip) continue
    const k = `${p.name}|${p.m}`
    const s = spend.get(k) ?? { cat: p.cat, cents: 0 }
    s.cents += p.cents
    spend.set(k, s)
  }
  const spentIn = (name: string, mm: string): number => Math.max(0, spend.get(`${name}|${mm}`)?.cents ?? 0)
  // The period shown: the month, or the last 30 days.
  const inPeriod = (p: Purchase): boolean => (bounds ? p.posted >= bounds.from && p.posted < bounds.to : p.m === month)
  const when = days ? `in ${WINDOW_DAYS} days` : 'so far'
  const shown = new Map<string, { cat: number | null; cents: number }>()
  for (const p of all) {
    if (p.marked || p.trip || !inPeriod(p)) continue
    const s = shown.get(p.name) ?? { cat: p.cat, cents: 0 }
    s.cents += p.cents
    shown.set(p.name, s)
  }
  const spentShown = (name: string): number => Math.max(0, shown.get(name)?.cents ?? 0)

  // Rollover: the month's available is its own target plus what carried into it (for the last 30 days,
  // the current month's). With rollover off it's the target as set.
  const rollovers = db.listRollovers()
  const history: TargetHistory = rollovers.size ? db.budgetHistory() : new Map()
  const carried = carries(month, rollovers, history, trips, isBill)
  const rolled = (id: number | null, budget: number | null): Pick<BudgetRow, 'rolloverOn' | 'carriedCents' | 'availableCents'> => {
    if (id === null || !rollovers.has(id)) return { rolloverOn: false, carriedCents: 0, availableCents: budget }
    const target = targetIn(history, id, month)
    const carry = target === null ? 0 : (carried.get(id) ?? 0)
    return { rolloverOn: true, carriedCents: carry, availableCents: target === null ? null : target + carry }
  }

  const rows: BudgetRow[] = model.categories.map((c) => {
    const tier = tierOf(c.name, prefs) === 'essential' ? 'essential' : 'lifestyle'
    const spent = spentShown(c.name)
    const budget = c.categoryId === null ? null : (budgets.get(c.categoryId) ?? null)
    const mid = at(c.month, 50)
    return {
      categoryId: c.categoryId,
      name: c.name,
      tier,
      small: mid < smallCents && spent < smallCents && budget === null,
      alert: tier === 'essential' ? alertFor(c, spent, bills, dayOfMonth !== null, when) : null,
      budgetCents: budget,
      suggestedCents: toTen(c.meanCents),
      fixedCents: c.fixedCents,
      month: c.month,
      toDate: c.toDate,
      confidence: c.confidence,
      purchases: c.events.filter((e) => e.cents > 0).length,
      spentCents: spent,
      historyCents: months.map((mm) => spentIn(c.name, mm)),
      ...rolled(c.categoryId, budget)
    }
  })
  // Categories with spending in the period but no history still show.
  for (const [name, s] of shown) {
    if (s.cents <= 0 || rows.some((row) => row.name === name) || tierOf(name, prefs) === 'oneoff') continue
    const tier = tierOf(name, prefs) === 'essential' ? 'essential' : 'lifestyle'
    const budget = s.cat === null ? null : (budgets.get(s.cat) ?? null)
    rows.push({
      categoryId: s.cat,
      name,
      tier,
      small: s.cents < smallCents,
      alert: tier === 'essential' ? `${dollars(s.cents)} ${days ? `in ${WINDOW_DAYS} days` : 'this month'}, new for this category` : null,
      budgetCents: budget,
      suggestedCents: 0,
      fixedCents: 0,
      month: Array(21).fill(0),
      toDate: null,
      confidence: 'low',
      purchases: 0,
      spentCents: s.cents,
      historyCents: months.map(() => 0),
      ...rolled(s.cat, budget)
    })
  }
  rows.sort((a, b) => at(b.month, 50) - at(a.month, 50) || b.spentCents - a.spentCents)

  const offs = all.filter(isOneOff)
  const offHistory = months.map((mm) => Math.max(0, offs.filter((o) => o.m === mm).reduce((s, o) => s + o.cents, 0)))
  const thisMonth = offs.filter(inPeriod)
  const oneOffs: BudgetView['oneOffs'] = {
    categories: oneOffNames,
    averageCents: toTen(offHistory.reduce((s, v) => s + v, 0) / months.length),
    spentCents: Math.max(0, thisMonth.reduce((s, o) => s + o.cents, 0)),
    targetCents: prefs.oneOffTargetCents,
    historyCents: offHistory,
    items: thisMonth
      .filter((o) => o.cents > 0 && !hidden(o.merchant))
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 40)
      .map((o) => ({ id: o.id, day: db.dayKey(o.posted), merchant: o.merchant, category: o.name, cents: o.cents, trip: o.trip }))
  }

  const measured = new Map<string, Measured>()
  const { habits: list, hiddenCount } = habits(model, rows, months, prefs, oneOffs, bills, series, trips, hidden, measured)
  for (const h of list) if (h.committed) h.committed.progress = progressOf(h, prefs.commitments[h.id], month, daysInMonth, all, trips, late, isOneOff)

  // Trips still ahead or in the months shown, with what's been bought on each so far.
  const shownFrom = `${months[0]}-01`
  const tripList = trips
    .filter((w) => w.trip.to >= shownFrom)
    .map((w) => ({ ...w.trip, spentCents: Math.max(0, purchases(w.start, w.end, [w], isBill).reduce((s, p) => s + (p.trip ? p.cents : 0), 0)) }))

  return {
    view: {
      month,
      days,
      months,
      rows,
      habits: list,
      hiddenHabits: hiddenCount,
      cheaperStore: prefs.cheaperStore,
      oneOffs,
      trips: tripList,
      total: model.total,
      totalToDate: model.totalToDate,
      smallCents,
      dayOfMonth,
      daysInMonth,
      behind: late.map((a) => ({ account: a.name, lastDay: db.dayKey(a.last) }))
    },
    measured
  }
}

const kindOf = (id: string): Habit['kind'] =>
  id === 'eat_out' || id === 'big_meals' || id === 'delivery' || id === 'coffee' ? id : id === 'oneoffs' ? 'oneoff' : id.startsWith('sub:') ? 'subscription' : id.startsWith('groceries:') ? 'groceries' : 'merchant'

/** Lifestyle habits as measured lately, each with exclusive commitments (smallest change first), least necessary first. */
function habits(
  model: ReturnType<typeof buildModel>,
  rows: BudgetRow[],
  months: string[],
  prefs: Prefs,
  oneOffs: BudgetView['oneOffs'],
  bills: RecurringSeries[],
  series: RecurringSeries[],
  trips: TripWindow[],
  hidden: (merchant: string) => boolean,
  measured: Map<string, Measured>
): { habits: Habit[]; hiddenCount: number } {
  const out: Habit[] = []
  // Current habits: the last three full months at home, net of friends paying their share back.
  const since = monthStart(months[3])
  const [lastY, lastM] = months[5].split('-').map(Number)
  const recentDays = { fromDay: `${months[3]}-01`, toDay: `${months[5]}-${String(monthLength(lastY, lastM)).padStart(2, '0')}` }
  const homeMonths = Math.max(1, 3 - daysAway(trips, since, monthStart(shift(months[5], 1))) / 30.44)
  const recent = (name: string): CategoryModel['events'] => (model.categories.find((c) => c.name === name)?.events ?? []).filter((e) => e.posted >= since)
  const idOf = (name: string): number | null => rows.find((r) => r.name === name)?.categoryId ?? null
  const lifestyle = (name: string): boolean => rows.some((r) => r.name === name && r.tier === 'lifestyle')
  // The categories the habits are about, as the user named them.
  const byRole = (role: CategoryRole): string | null => nameWithRole(model.categories.map((c) => c.name), role) ?? nameWithRole(rows.map((r) => r.name), role)
  const DINING = byRole('dining')
  const COFFEE = byRole('coffee')
  const GROCERIES = byRole('groceries')
  const per = (n: number): number => n / homeMonths
  const option = (id: string, label: string, savings: number, limit: HabitOption['limit']): HabitOption => ({ id, label, savingsCents: Math.round(savings), extraCents: Math.round(savings), limit })
  const add = (h: Omit<Habit, 'committed'>): void => {
    out.push({ ...h, options: h.options.filter((o) => o.savingsCents >= 1000), committed: null })
  }
  /** How a habit was measured, as Home shows it: a short name, how often, and its lines over the three months. */
  const measure = (id: string, name: string, how: string | null, lines: Omit<LineQuery, 'fromDay' | 'toDay'>): void => void measured.set(id, { name, often: how, drill: { ...recentDays, ...lines } })
  /** The purchases in a category a habit was measured from: Personal's lines of their transactions in that category. */
  const bought = (categoryId: number | null, events: CategoryModel['events']): Omit<LineQuery, 'fromDay' | 'toDay'> => ({ categoryId: categoryId ?? 'none', owner: null, ids: [...new Set(events.map((e) => e.id))].sort() })
  /** The places bought from most often. */
  const places = (events: CategoryModel['events']): string => {
    const count = new Map<string, number>()
    for (const e of events) if (e.cents > 0 && !hidden(e.merchant)) count.set(brand(e.merchant), (count.get(brand(e.merchant)) ?? 0) + 1)
    return [...count]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([name]) => name)
      .join(', ')
  }

  // Eating out: meals out a month and what each costs after paybacks; the rest cooked at home.
  if (DINING && lifestyle(DINING)) {
    const dining = recent(DINING)
    const sitDown = dining.filter((e) => !DELIVERY.test(e.merchant))
    const meals = per(sitDown.filter((e) => e.cents > 0).length)
    const net = per(sitDown.reduce((s, e) => s + e.cents, 0))
    const paidBack = per(-sitDown.filter((e) => e.cents < 0).reduce((s, e) => s + e.cents, 0))
    // Big meals out, and what one costs over a regular meal out (under $100), which takes its place.
    const big = sitDown.filter((e) => e.cents >= BIG_MEAL)
    const regular = sitDown.filter((e) => e.cents > 0 && e.cents < BIG_MEAL)
    const bigs = per(big.length)
    const bigCents = big.reduce((s, e) => s + e.cents, 0)
    const regularEach = regular.length ? regular.reduce((s, e) => s + e.cents, 0) / regular.length : HOME_MEAL
    const premium = big.length ? Math.max(0, bigCents / big.length - regularEach) : 0
    // Committed together, the two count each dollar once. Eating out less keeps the mix, so a meal limit
    // gives up some big meals on its own; a big-meal limit saves only on the big ones still over it at
    // that many meals. Whichever is committed second leaves out what the two share (an undo gives it
    // back), so the pair saves the same in either order.
    const limitOf = (id: string): number | null => {
      const l = prefs.commitments[id]?.limit
      return l && 'count' in l ? l.count : null
    }
    const bigOver = (n: number, limit: number): number => (meals ? Math.max(0, (bigs * Math.min(n, meals)) / meals - limit) : 0)
    const mealLimit = limitOf('eat_out') ?? meals
    const bigLimit = limitOf('big_meals')
    if (meals > 6 && net > 0) {
      const each = net / meals
      const shared = (n: number): number => (bigLimit === null ? 0 : (bigOver(meals, bigLimit) - bigOver(n, bigLimit)) * premium)
      const levels: Array<[number, string]> = [
        [30.4, 'once a day'],
        [21.7, '5 times a week'],
        [13, '3 times a week'],
        [8.7, 'twice a week'],
        [4.3, 'once a week']
      ]
      add({
        id: 'eat_out',
        kind: 'eat_out',
        title: `You eat out ${often(meals)}`,
        categoryId: idOf(DINING),
        category: DINING,
        detail: `${dollars(each)} a meal · ${dollars(net)} a month${paidBack >= 1000 ? ` after ${dollars(paidBack)} paid back` : ''}`,
        nowCents: Math.round(net),
        options: levels.filter(([n]) => n < meals - 1).map(([n, how]) => option(how, `Eat out ${how}`, Math.max(0, (meals - n) * Math.max(0, each - HOME_MEAL) - shared(n)), { count: n }))
      })
      measure('eat_out', 'Meals out', often(meals), bought(idOf(DINING), sitDown))
    }

    // Big meals: a regular meal out instead.
    if (bigs > 3) {
      const tickets = big.map((e) => e.cents).sort((a, b) => a - b)
      const median = (tickets[(tickets.length - 1) >> 1] + tickets[tickets.length >> 1]) / 2
      const levels: Array<[number, string, string]> = [
        [4.3, 'one a week', `One ${dollars(BIG_MEAL)}+ meal out a week`],
        [2, 'two a month', `Two ${dollars(BIG_MEAL)}+ meals out a month`]
      ]
      add({
        id: 'big_meals',
        kind: 'big_meals',
        title: `You have about ${Math.round(bigs)} meals out over ${dollars(BIG_MEAL)} a month`,
        categoryId: idOf(DINING),
        category: DINING,
        detail: `${places(big)} · ${dollars(median)} a meal · ${dollars(per(bigCents))} a month`,
        nowCents: Math.round(per(bigCents)),
        options: levels.filter(([n]) => n < bigs - 1).map(([n, id, label]) => option(id, label, bigOver(mealLimit, n) * premium, { count: n }))
      })
      measure('big_meals', `Meals out over ${dollars(BIG_MEAL)}`, `about ${Math.round(bigs)} a month`, bought(idOf(DINING), big))
    }

    // Delivery: the same meals cooked instead.
    const orders = dining.filter((e) => DELIVERY.test(e.merchant) && e.cents > 0 && !hidden(e.merchant))
    if (orders.length >= 2) {
      const n = per(orders.length)
      const each = orders.reduce((s, e) => s + e.cents, 0) / orders.length
      const saves = Math.max(0, each - HOME_MEAL)
      const apps = [...new Set(orders.map((e) => brand(e.merchant)))].join(' or ')
      const fewer = Math.floor(n / 2)
      add({
        id: 'delivery',
        kind: 'delivery',
        title: `You order ${apps} ${often(n)}`,
        categoryId: idOf(DINING),
        category: DINING,
        detail: `${dollars(each)} an order · ${dollars(n * each)} a month`,
        nowCents: Math.round(n * each),
        options: [...(fewer >= 1 ? [option('fewer', `${apps} ${times(fewer)} a month`, (n - fewer) * saves, { count: fewer })] : []), option('none', `No ${apps}`, n * saves, { count: 0 })]
      })
      measure('delivery', apps, often(n), bought(idOf(DINING), orders))
    }
  }

  // Coffee bought out, against brewing it at home.
  if (COFFEE && lifestyle(COFFEE)) {
    const coffee = recent(COFFEE).filter((e) => e.cents > 0)
    const n = per(coffee.length)
    const monthly = per(coffee.reduce((s, e) => s + e.cents, 0))
    if (monthly >= 3000 && coffee.length >= 3) {
      const each = monthly / n
      add({
        id: 'coffee',
        kind: 'coffee',
        title: `You buy coffee ${often(n)}`,
        categoryId: idOf(COFFEE),
        category: COFFEE,
        detail: `${places(coffee)} · ${dollars(each)} each · ${dollars(monthly)} a month`,
        nowCents: Math.round(monthly),
        options: [
          ...(n > 13 ? [option('twice', 'Coffee out twice a week', (n - 8.7) * Math.max(0, each - HOME_COFFEE), { count: 8.7 })] : []),
          option('home', 'Brew coffee at home', n * Math.max(0, each - HOME_COFFEE), { count: 0 })
        ]
      })
      measure('coffee', 'Coffee out', often(n), bought(idOf(COFFEE), coffee))
    }
  }

  // Specific places in the other lifestyle categories (a bookshop, a barber, a gym), bought from regularly.
  const ownHabit = (name: string): boolean => ['dining', 'coffee', 'subscriptions', 'cash'].includes(categoryRole(name) ?? '')
  // Not stores to give up: places with a recurring charge (a subscription is offered on its own,
  // a bill is essential, an ended one is done) and general retailers bought from for essentials.
  const recurringAt = (name: string): boolean => series.some((s) => s.key.startsWith(name.toLowerCase()) || s.name.toLowerCase().startsWith(name.toLowerCase()))
  const RETAILER = /amazon|target|walmart|costco|sam'?s club|cvs|walgreens|whole foods|kroger|trader joe|safeway|home depot|lowe'?s/i
  for (const r of rows.filter((x) => x.tier === 'lifestyle' && !ownHabit(x.name))) {
    const byBrand = new Map<string, { n: number; cents: number; events: CategoryModel['events'] }>()
    for (const e of recent(r.name)) {
      if (e.cents <= 0) continue
      const x = byBrand.get(brand(e.merchant)) ?? { n: 0, cents: 0, events: [] }
      x.n++
      x.cents += e.cents
      x.events.push(e)
      byBrand.set(brand(e.merchant), x)
    }
    for (const [name, x] of byBrand) {
      const n = per(x.n)
      const monthly = per(x.cents)
      if (n < 1 || monthly < 3000 || RETAILER.test(name) || recurringAt(name)) continue
      add({
        id: `store:${r.name}:${name}`,
        kind: 'merchant',
        title: `You buy from ${name} ${often(n)}`,
        categoryId: r.categoryId,
        category: r.name,
        detail: `${dollars(monthly / n)} each · ${dollars(monthly)} a month`,
        nowCents: Math.round(monthly),
        options: [...(n >= 2 ? [option('one', `One ${name} purchase a month`, monthly - monthly / n, { count: 1 })] : []), option('none', `No ${name} purchases`, monthly, { count: 0 })]
      })
      measure(`store:${r.name}:${name}`, name, often(n), bought(r.categoryId, x.events))
    }
  }

  // Subscriptions in lifestyle categories (essential ones are bills, never offered).
  for (const s of bills) {
    if (s.kind !== 'subscription' || s.status !== 'active' || !s.categoryName || !lifestyle(s.categoryName)) continue
    const monthly = Math.abs(s.monthlyCents)
    add({
      id: `sub:${s.key}`,
      kind: 'subscription',
      title: `You pay for ${s.name} ${EVERY[s.cadence] ?? 'regularly'}`,
      categoryId: idOf(s.categoryName),
      category: s.categoryName,
      detail: s.cadence === 'monthly' ? exact(s.typicalCents) : `${exact(s.typicalCents)} · ${dollars(monthly)} a month`,
      nowCents: monthly,
      options: [option('cancel', `Cancel ${s.name}`, monthly, { count: 0 })]
    })
    measure(`sub:${s.key}`, s.name, EVERY[s.cadence] ?? null, { cls: ['committed'], seriesKey: s.key })
  }

  // One-offs: durable goods and the like can wait.
  if (oneOffs.averageCents >= 10000) {
    const avg = oneOffs.averageCents
    const cap = (share: number): number => Math.round((avg * share) / 5000) * 5000
    add({
      id: 'oneoffs',
      kind: 'oneoff',
      title: `You spend about ${dollars(avg)} a month on one-offs`,
      categoryId: null,
      category: ONE_OFFS,
      detail: `${oneOffs.categories.join(', ')}, trips and anything marked one-time`,
      nowCents: avg,
      options: [0.5, 0.25].map((share) => option(`cap${Math.round(share * 100)}`, `Keep one-offs under ${dollars(cap(share))} a month`, avg - cap(share), { cents: cap(share) }))
    })
  }

  // Groceries: the cheaper grocer the user named, against everywhere else they buy them.
  const store = prefs.cheaperStore
  const elsewhere = new Map<string, { n: number; cents: number }>()
  const elsewhereBought: CategoryModel['events'] = []
  if (store && GROCERIES) {
    for (const e of recent(GROCERIES)) {
      if (e.cents <= 0 || atStore(store, e.merchant)) continue
      const x = elsewhere.get(brand(e.merchant)) ?? { n: 0, cents: 0 }
      x.n++
      x.cents += e.cents
      elsewhere.set(brand(e.merchant), x)
      elsewhereBought.push(e)
    }
  }
  const elsewhereTotal = per([...elsewhere.values()].reduce((s, v) => s + v.cents, 0))
  if (store && GROCERIES && elsewhereTotal >= 5000) {
    const visits = per([...elsewhere.values()].reduce((s, v) => s + v.n, 0))
    const top = [...elsewhere]
      .filter(([name]) => !hidden(name))
      .sort((a, b) => b[1].cents - a[1].cents)
      .slice(0, 3)
      .map(([name, v]) => `${name} ${dollars(per(v.cents))}`)
      .join(', ')
    add({
      id: `groceries:${store.toLowerCase()}`,
      kind: 'groceries',
      title: `You buy groceries outside ${store} ${often(visits)}`,
      categoryId: idOf(GROCERIES),
      category: GROCERIES,
      detail: `${top} a month`,
      nowCents: Math.round(elsewhereTotal),
      options: [option('store', `Buy groceries only at ${store}`, elsewhereTotal * CHEAPER_STORE_SAVES, { count: 0 })]
    })
    measure(`groceries:${store.toLowerCase()}`, 'Other grocers', often(visits), bought(idOf(GROCERIES), elsewhereBought))
  }

  // A commitment already made stays listed as made, even if the habit has since changed, under its own category
  // when that has had no spending in the six months.
  const categoryIds = new Map(db.listCategories().map((c) => [c.name, c.id]))
  for (const [id, c] of Object.entries(prefs.commitments)) {
    const h = out.find((x) => x.id === id)
    const committed = { optionId: c.optionId, label: c.label, savingsCents: c.savingsCents, progress: null }
    if (h) h.committed = committed
    else out.push({ id, kind: kindOf(id), title: c.title ?? c.category, categoryId: idOf(c.category) ?? (c.category === ONE_OFFS ? null : (categoryIds.get(c.category) ?? null)), category: c.category, detail: '', nowCents: 0, options: [], committed })
  }

  // Against the targets as they stand: a category target already below the usual month covers part
  // of each commitment. It still shows its whole saving; extraCents is what it adds to the target.
  for (const h of out) {
    if (h.committed) continue
    const usual = h.category === ONE_OFFS ? oneOffs.averageCents : (rows.find((r) => r.name === h.category)?.suggestedCents ?? 0)
    const target = h.category === ONE_OFFS ? oneOffs.targetCents : (rows.find((r) => r.name === h.category)?.budgetCents ?? null)
    if (target === null) continue
    const chosen = Object.values(prefs.commitments)
      .filter((c) => c.category === h.category)
      .reduce((s, c) => s + c.savingsCents, 0)
    const covered = Math.max(0, usual - target - chosen)
    h.options = h.options.map((o) => ({ ...o, extraCents: Math.max(0, o.savingsCents - covered) }))
  }
  const best = (h: Habit): number => Math.max(0, ...h.options.map((o) => o.savingsCents))
  // A hidden vendor's store or subscription never shows, and doesn't count as hidden by the user.
  const named = (h: Habit): string => (h.id.startsWith('store:') ? h.id.split(':').slice(2).join(':') : h.id.startsWith('sub:') ? h.title : '')
  const shown = out.filter((h) => !hidden(named(h)))
  return {
    habits: shown.filter((h) => h.committed || (h.options.length && !prefs.hidden.includes(h.id))).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || best(b) - best(a)),
    hiddenCount: shown.filter((h) => !h.committed && h.options.length && prefs.hidden.includes(h.id)).length
  }
}

/** The purchases a habit's limit counts. */
function measured(h: Habit): (p: Purchase) => boolean {
  switch (h.kind) {
    case 'eat_out':
      return (p) => categoryRole(p.name) === 'dining' && !DELIVERY.test(p.merchant)
    case 'big_meals':
      return (p) => categoryRole(p.name) === 'dining' && !DELIVERY.test(p.merchant) && p.cents >= BIG_MEAL
    case 'delivery':
      return (p) => categoryRole(p.name) === 'dining' && DELIVERY.test(p.merchant)
    case 'coffee':
      return (p) => categoryRole(p.name) === 'coffee'
    case 'groceries': {
      // The store is in the id, so a commitment outlives a change of the named grocer.
      const store = h.id.slice('groceries:'.length)
      return (p) => categoryRole(p.name) === 'groceries' && !atStore(store, p.merchant)
    }
    case 'subscription': {
      const key = h.id.slice(4).split('|').slice(0, 2).join('|')
      return (p) => p.key === key
    }
    case 'merchant': {
      const [, category, ...name] = h.id.split(':')
      return (p) => p.name === category && brand(p.merchant) === name.join(':')
    }
    case 'oneoff':
      return () => false
  }
}

/**
 * How the month is going against a commitment: purchases counted from the later of the
 * month's start and the day it was made, with the month's limit shared out over the days at
 * home (days away aren't the habit). Null before it was made. While a feed that runs weeks
 * behind and usually carries these purchases catches up, a kept limit is unknown.
 */
function progressOf(
  h: Habit,
  c: Commitment,
  month: string,
  daysInMonth: number,
  all: Purchase[],
  trips: TripWindow[],
  late: Array<{ id: string; name: string; last: number }>,
  isOneOff: (p: Purchase) => boolean
): HabitProgress | null {
  const limit = c.limit ?? h.options.find((o) => o.id === c.optionId)?.limit
  if (!limit) return null
  const start = monthStart(month)
  const end = monthStart(shift(month, 1))
  const from = Math.max(start, c.since ?? start)
  const until = Math.min(end, db.now())
  if (from >= until) return null
  const open = until < end
  const tail = from > start ? ` since ${fmtDay(from)}` : open ? ' so far' : ''
  const counts = 'cents' in limit ? isOneOff : measured(h)
  const usual = all.filter((p) => p.posted >= start - 92 * 86_400 && p.posted < start && p.cents > 0 && counts(p))
  const slow = open && usual.length ? late.find((a) => a.last + 86_400 < until && usual.filter((p) => p.account === a.id).length * 4 >= usual.length) : undefined
  const waiting = (known: string | null): HabitProgress => ({ text: known ? `${known}, waiting on ${slow!.name}` : `Waiting on ${slow!.name}`, state: 'waiting' })
  const hits = all.filter((p) => p.posted >= from && p.posted < until && counts(p) && ('cents' in limit || (p.cents > 0 && !p.marked && !p.trip)))

  if ('cents' in limit) {
    // One-offs: the month's cap from the day it was made; a trip's spending counts too.
    const spent = Math.max(0, hits.reduce((s, p) => s + p.cents, 0))
    const allowed = toTen((limit.cents * (end - from)) / (end - start))
    const text = `${dollars(spent)} of ${dollars(allowed)}`
    return spent > allowed ? { text, state: 'over' } : slow ? waiting(text) : { text: `${text}${tail}`, state: 'good' }
  }

  const n = hits.length
  const cents = hits.reduce((s, p) => s + p.cents, 0)
  if (h.kind === 'subscription') {
    const last = hits.at(-1)
    return last ? { text: `Charged ${exact(last.cents)} ${fmtDay(last.posted)}`, state: 'over' } : slow ? waiting(null) : { text: `No charge${tail}`, state: 'good' }
  }
  if (h.kind === 'groceries') return n ? { text: `${dollars(cents)} at other grocers${tail}`, state: 'over' } : slow ? waiting(null) : { text: `No other grocers${tail}`, state: 'good' }
  const [one, many] = NOUN[h.kind]
  // The share of the month at home: from when it was made to the month's end, and so far.
  const home = (a: number, b: number): number => Math.max(0, (b - a) / 86_400 - daysAway(trips, a, b)) / daysInMonth
  const allowed = Math.round(limit.count * home(from, end))
  if (allowed === 0) return n ? { text: `${n} ${n === 1 ? one : many}, ${dollars(cents)}`, state: 'over' } : slow ? waiting(null) : { text: `No ${many}${tail}`, state: 'good' }
  const counted = `${n} of ${allowed} ${allowed === 1 ? one : many}`
  if (n > allowed) return { text: counted, state: 'over' }
  if (slow) return waiting(n ? counted : null)
  return { text: `${counted}${tail}`, state: open && n > Math.ceil(limit.count * home(from, until)) ? 'pace' : 'good' }
}

/**
 * A budget line's target: its usual month less every commitment made for it (savings two of them share
 * count once, see OVERLAPS), never looser than the target it had before the first one; with none left,
 * that earlier target comes back.
 */
function applyTarget(prefs: Prefs, category: string, view: BudgetView): void {
  const cut = Object.values(prefs.commitments)
    .filter((c) => c.category === category)
    .reduce((s, c) => s + c.savingsCents, 0)
  const row = category === ONE_OFFS ? null : view.rows.find((r) => r.name === category)
  const usual = category === ONE_OFFS ? view.oneOffs.averageCents : (row?.suggestedCents ?? 0)
  const before = prefs.before[category] ?? null
  const target = cut ? Math.min(before ?? Infinity, Math.max(0, toTen(usual - cut))) : before
  if (!cut) delete prefs.before[category]
  if (category === ONE_OFFS) prefs.oneOffTargetCents = target
  else if (row?.categoryId != null) db.setBudget(row.categoryId, target)
}

/** Habits whose commitments share savings, so the second one made saves only the rest (see habits()). */
const OVERLAPS: Record<string, string> = { eat_out: 'big_meals', big_meals: 'eat_out' }

/** Makes a habit's commitment part of its line's target, or with null undoes it. */
export function commitHabit(month: string, habitId: string, optionId: string | null): void {
  const prefs = loadPrefs()
  let view = getBudget(month)
  const habit = view.habits.find((h) => h.id === habitId)
  const category = habit?.category ?? prefs.commitments[habitId]?.category
  if (!category) throw new Error('That habit is no longer listed')
  if (optionId === null) {
    delete prefs.commitments[habitId]
    // The one it shared savings with, if kept, saves its whole amount again.
    const pair = OVERLAPS[habitId]
    const kept = pair ? prefs.commitments[pair] : undefined
    if (kept) {
      savePrefs(prefs)
      view = getBudget(month)
      const o = view.habits.find((h) => h.id === pair)?.options.find((x) => x.id === kept.optionId)
      if (o) kept.savingsCents = o.savingsCents
    }
  } else {
    const option = habit?.options.find((o) => o.id === optionId)
    if (!habit || !option) throw new Error('That commitment is no longer offered')
    const target = category === ONE_OFFS ? view.oneOffs.targetCents : (view.rows.find((r) => r.name === category)?.budgetCents ?? null)
    // The first commitment for a line remembers its target, to put back on undo.
    if (!Object.values(prefs.commitments).some((c) => c.category === category)) prefs.before[category] = target
    // It counts from the start of today: bank dates have no time of day.
    const since = db.dayStart(db.today())
    prefs.commitments[habitId] = { optionId, label: option.label, savingsCents: option.savingsCents, category, title: habit.title, limit: option.limit, since }
  }
  applyTarget(prefs, category, view)
  savePrefs(prefs)
}

/** Hides a habit that isn't for the user; null shows hidden ones again. */
export function hideHabit(habitId: string | null): void {
  const prefs = loadPrefs()
  prefs.hidden = habitId === null ? [] : [...new Set([...prefs.hidden, habitId])]
  savePrefs(prefs)
}

/** The habits the user hid, by id, in the order they were hidden. */
export const hiddenHabits = (): string[] => loadPrefs().hidden

/** Shows one hidden habit again, leaving the others hidden; false when it wasn't hidden. */
export function showHabit(habitId: string): boolean {
  const prefs = loadPrefs()
  if (!prefs.hidden.includes(habitId)) return false
  prefs.hidden = prefs.hidden.filter((h) => h !== habitId)
  savePrefs(prefs)
  return true
}

/** Moves a category between essential, lifestyle and one-off (null: its default); commitments made for it are dropped. */
export function setBudgetTier(category: string, tier: BudgetTier | null): void {
  const prefs = loadPrefs()
  if (tier === null) delete prefs.tiers[category]
  else prefs.tiers[category] = tier
  dropChoices(prefs, category)
  savePrefs(prefs)
}

/** A category target typed by hand: it replaces whatever commitments set it. */
export function setCategoryTarget(categoryId: number, cents: number | null): void {
  db.setBudget(categoryId, cents)
  const name = db.listCategories().find((c) => c.id === categoryId)?.name
  if (!name) return
  const prefs = loadPrefs()
  dropChoices(prefs, name)
  savePrefs(prefs)
}

/** Turns a category's rollover on from this month, or off (on again later starts afresh, nothing carried from before). */
export function setBudgetRollover(categoryId: number, on: boolean): void {
  db.setRollover(categoryId, on)
}

/** A budget line as it is, for the journal: its target, history and rollover, and the commitments that set it. */
export interface TargetRecord {
  budget: db.BudgetRecord
  category: string | null
  commitments: Record<string, Commitment>
  /** prefs.before for the line, when it has one */
  before: { cents: number | null } | null
}

export function targetRecord(categoryId: number): TargetRecord {
  const category = db.listCategories().find((c) => c.id === categoryId)?.name ?? null
  const prefs = loadPrefs()
  const mine = Object.entries(prefs.commitments).filter(([, c]) => c.category === category)
  return { budget: db.budgetRecord(categoryId), category, commitments: Object.fromEntries(mine), before: category !== null && category in prefs.before ? { cents: prefs.before[category] } : null }
}

/** Puts a budget line back as targetRecord found it. */
export function restoreTargetRecord(r: TargetRecord): void {
  db.restoreBudgetRecord(r.budget)
  if (r.category === null) return
  const prefs = loadPrefs()
  dropChoices(prefs, r.category)
  Object.assign(prefs.commitments, r.commitments)
  if (r.before) prefs.before[r.category] = r.before.cents
  savePrefs(prefs)
}

/** The one-off budget typed by hand (null: back to the average); it replaces whatever commitments set it. */
export function setOneOffBudget(cents: number | null): void {
  if (cents !== null && (!Number.isInteger(cents) || cents < 0)) throw new Error('Invalid budget')
  const prefs = loadPrefs()
  prefs.oneOffTargetCents = cents
  dropChoices(prefs, ONE_OFFS)
  savePrefs(prefs)
}

/** Names the grocer the groceries habit measures against; null offers no groceries habit. */
export function setCheaperStore(store: string | null): void {
  const prefs = loadPrefs()
  prefs.cheaperStore = store?.trim() || null
  savePrefs(prefs)
}

/** The one-off budget a month, when one is set: the debt plan asks what a month would cost at it (debts.ts). */
export const oneOffTarget = (): number | null => loadPrefs().oneOffTargetCents

/** A habit's short name by its kind, for a commitment whose habit is no longer measured. */
const HABIT_NAME: Record<Habit['kind'], string> = { eat_out: 'Meals out', big_meals: `Meals out over ${dollars(BIG_MEAL)}`, delivery: 'Delivery', coffee: 'Coffee out', merchant: 'Purchases', subscription: 'Subscription', groceries: 'Other grocers', oneoff: ONE_OFFS }

/**
 * What Home's Left over and Saved drills read of this month's budget (spec 1.5 and 1.6): each category's target as
 * set, with what carried into it when rollover is on; the habits measured over the last three full months at home,
 * each under its category with how often, what it costs a month, the commitment made for it and how this month is
 * going, and the purchases it was measured from; and the one-off budget. A commitment whose habit is no longer
 * measured opens no lines, and neither does the one-offs' habit, whose average is the budget's six months of what it
 * counts as one-offs, not lines Home's One-offs reads.
 */
export function leftOverPlans(): Pick<HomePlans, 'month' | 'targets' | 'habits' | 'oneOffTargetCents' | 'trips'> {
  const month = db.today().slice(0, 7)
  const { view, measured } = budgetOf(month)
  const rows = new Map(view.rows.flatMap((r) => (r.categoryId === null ? [] : [[r.categoryId, r] as const])))
  const targets = [...db.listBudgets()].map(([categoryId, targetCents]) => {
    const r = rows.get(categoryId)
    return { categoryId, targetCents, rollover: r?.rolloverOn ? { carriedCents: r.carriedCents, availableCents: r.availableCents } : null }
  })
  const habits = view.habits.map((h) => {
    const how = measured.get(h.id)
    const name = how?.name ?? (h.kind === 'merchant' ? h.id.split(':').slice(2).join(':') : h.kind === 'subscription' ? h.category : HABIT_NAME[h.kind])
    return { id: h.id, kind: h.kind, categoryId: h.categoryId, name, often: how?.often ?? null, monthlyCents: h.nowCents, commitment: h.committed?.label ?? null, progress: h.committed?.progress?.text ?? null, drill: how?.drill ?? null }
  })
  // The trips not over yet, with what's been bought on each so far.
  const today = db.today()
  const trips = view.trips.filter((t) => t.to >= today).map((t) => ({ name: t.name, fromDay: t.from, toDay: t.to, spentCents: t.spentCents }))
  return { month, targets, habits, oneOffTargetCents: view.oneOffs.targetCents, trips }
}
