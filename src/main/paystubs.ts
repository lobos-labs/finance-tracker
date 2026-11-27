import * as db from './db'
import { byTwoWeekGaps, cadenceOf, CHECKS_A_YEAR, latestRun, periodCadence, settledCadence, type PayCadence } from './cadence'
import { classifyLines } from './lines'
import { CADENCES } from './recurring'
import { findTaxYear } from './taxes'
import { limitsFor } from '../shared/limits'
import { asPayrollKey, PAYSTUB_ITEMS, planGroup } from '../shared/payroll'
import { roundDiv } from '../shared/rounding'
import { addDays, daysBetween, daysInMonth, isRealDay, shiftMonth } from '../shared/zone'
import type { CheckItem, ClassifiedLine, PayBasis, PayCheck, PayRunRate, PayRunRates, Paystub, PaystubInput, PaystubItem, YearCheck } from '../shared/types'

// Paystubs and the checks they explain, for Gross pay and the rows into Take-home (spec 1.2 and 1.3).
//
// A check is a payroll's pay lines (lines.ts) within 3 days of its first, across the perimeter's accounts, so a
// deposit split between checking and savings adds up. Its gross pay and what came out of it come from the first of:
//   1. its own paystub, a stub of the same payroll dated within 3 days of it: basis paystub
//   2. the latest regular stub of the payroll on or before it: basis estimated
//   3. the earliest regular stub after it in the same year: basis estimated, so a stub from March explains January
//   4. the deposits, plus the elections entered for the payroll's plans: basis deposits, with no taxes or benefits
// An estimate takes the stub's lines as they are, except that a 401(k) stops at the year's deferral limit and Social
// Security at the wage base, through the year so far. Net pay is always gross less the items, and what the deposits
// differ from it by is the Payroll difference, so Gross pay - Taxes - Benefits - Saved at work + Payroll difference
// is what was deposited. A bonus check is its bonus stub, or its deposits; it counts in every actual and in no run
// rate. The Review assistant enters stubs with record_paystub.

const DAY_LIMIT = 3
/** Social Security's rate, 6.2%, in tenths of a percent: it stops at the wage base times this. */
const SOCIAL_SECURITY_PER_MILLE = 62

const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const near = (a: string, b: string): boolean => Math.abs(daysBetween(a, b)) <= DAY_LIMIT

// ---------- the stubs ----------

/** Checks a paystub and saves it, over the one for the same payroll, pay day and kind. Net, when given, must be gross less the items. Returns its id. */
export function savePaystub(p: PaystubInput): number {
  const key = asPayrollKey(String(p.paycheckKey ?? ''))
  if (key === '|+') throw new Error("A paycheck key is required, like 'acme payroll|+' (list_recurring)")
  if (!isRealDay(String(p.payDay))) throw new Error('The pay date must be a date like 2026-10-02')
  const kind = p.kind ?? 'regular'
  if (!['regular', 'bonus', 'final'].includes(kind)) throw new Error('kind must be regular, bonus or final')
  for (const d of [p.periodFrom, p.periodTo]) if (d !== undefined && d !== null && !isRealDay(d)) throw new Error('Pay period dates are like 2026-09-14')
  const cents = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${what} must be a whole number of cents, 0 or more`)
    return v
  }
  const orNull = (v: unknown, what: string): number | null => (v === undefined || v === null ? null : cents(v, what))
  const gross = cents(p.grossCents, 'Gross pay')
  if (!Array.isArray(p.items)) throw new Error('items is a list of the lines taken out')
  const items: PaystubItem[] = []
  for (const x of p.items) {
    const info = PAYSTUB_ITEMS[x?.kind]
    if (!info) throw new Error(`Unknown paystub line ${String(x?.kind)}: ${Object.keys(PAYSTUB_ITEMS).join(', ')}`)
    const name = String(x.name ?? '').trim() || info.label
    // A savings plan comes out before income tax or after it by its kind (spec section 6), so a Roth line recorded as
    // pre-tax still counts in the year's wages; a premium keeps the flag the stub prints.
    const pretax = info.row === 'savedAtWork' ? planGroup(x.kind) === 'pretax' : (x.pretax ?? info.pretax)
    const item: PaystubItem = { kind: x.kind, name, cents: cents(x.cents, name), ytdCents: orNull(x.ytdCents, `${name} year to date`), pretax, employerCents: orNull(x.employerCents, `${name} from the employer`) }
    if (item.cents || item.employerCents || item.ytdCents) items.push(item)
  }
  const net = gross - items.reduce((s, x) => s + x.cents, 0)
  if (p.netCents !== undefined && p.netCents !== null && p.netCents !== net) {
    throw new Error(`Gross less the lines taken out is ${(net / 100).toFixed(2)}, not the net pay of ${(p.netCents / 100).toFixed(2)}: a line is missing or mistyped`)
  }
  return db.writePaystub({
    paycheckKey: key,
    payDay: p.payDay,
    periodFrom: p.periodFrom ?? null,
    periodTo: p.periodTo ?? null,
    kind,
    grossCents: gross,
    netCents: net,
    items,
    documentId: p.documentId ?? null,
    source: p.source ?? 'paystub',
    estimated: p.estimated ?? false
  })
}

/** Every paystub, or one payroll's, with pay days from one day to another (inclusive), oldest first. */
export const listPaystubs = (key?: string, from?: string, to?: string): Paystub[] => db.listPaystubs(key === undefined ? undefined : asPayrollKey(key), from, to)

/** A regular stub's place in the order a check reads them: its own first, then the latest on or before it, then the earliest after it that year. */
function stubFor(stubs: Paystub[], day: string): { stub: Paystub; basis: 'paystub' | 'estimated' } | null {
  const own = stubs.filter((s) => s.kind !== 'bonus' && near(s.payDay, day)).sort((a, b) => Math.abs(daysBetween(a.payDay, day)) - Math.abs(daysBetween(b.payDay, day)))
  if (own.length) return { stub: own[0], basis: 'paystub' }
  const regular = stubs.filter((s) => s.kind === 'regular')
  const before = regular.filter((s) => s.payDay <= day).at(-1)
  if (before) return { stub: before, basis: 'estimated' }
  const after = regular.find((s) => s.payDay > day && s.payDay.slice(0, 4) === day.slice(0, 4))
  return after ? { stub: after, basis: 'estimated' } : null
}

/** The stub a payroll's regular check on a day reads (spec 1.2): its own, else one it's estimated from; null when only the deposits say. */
export function paystubOn(key: string, day: string): { stub: Paystub; basis: 'paystub' | 'estimated' } | null {
  return stubFor(listPaystubs(key), day)
}

/**
 * A payroll's gross pay on its pay day nearest a day (within 3 days), regular and bonus together, as Gross pay sums
 * it (spec 1.2), and where it comes from: the least exact of that day's checks. With no deposit there, the stub's
 * gross a regular check would read, else the elections alone.
 */
export function grossOn(key: string, day: string): { cents: number; basis: PayBasis } {
  const k = asPayrollKey(key)
  const around = payrollChecks(addDays(day, -DAY_LIMIT), addDays(day, DAY_LIMIT)).filter((c) => c.paycheckKey === k)
  if (around.length) {
    const payDay = around.reduce((a, c) => (Math.abs(daysBetween(c.day, day)) < Math.abs(daysBetween(a.day, day)) ? c : a)).day
    const checks = around.filter((c) => c.day === payDay)
    return { cents: checks.reduce((s, c) => s + c.grossCents, 0), basis: leastExact(checks.map((c) => c.basis))! }
  }
  const s = paystubOn(k, day)
  if (s) return { cents: s.stub.grossCents, basis: s.basis }
  return { cents: elections(k, day).reduce((t, x) => t + x.cents, 0), basis: 'deposits' }
}

// ---------- the checks ----------

/** The elections entered for a payroll's plans in force on a day, as paystub lines: the employee's amount, the match as the employer's. */
export function elections(key: string, day: string): PaystubItem[] {
  const out: PaystubItem[] = []
  for (const p of db.listContributionRows()) {
    if (p.paycheckKey !== key || (p.startsDay && day < p.startsDay) || (p.endsDay && day > p.endsDay)) continue
    // An election change applies from the first paycheck on or after its date.
    const cents = p.nextFrom && p.nextEmployeeCents !== null && day >= p.nextFrom ? p.nextEmployeeCents : (p.employeeCents ?? 0)
    if (cents || p.matchCents) out.push({ kind: p.kind, name: p.name, cents, ytdCents: null, pretax: planGroup(p.kind) === 'pretax', employerCents: p.matchCents })
  }
  return out
}

/** The yearly caps an estimate stops at: elective deferrals across a payroll's 401(k), 403(b) and Roth 401(k), a 457 on its own, and Social Security. */
type Cap = 'deferral' | '457' | 'socialSecurity'
const capOf = (kind: PaystubItem['kind']): Cap | null => (kind === '401k' || kind === 'roth_401k' || kind === '403b' ? 'deferral' : kind === '457' ? '457' : kind === 'social_security' ? 'socialSecurity' : null)

/** One check's figures from its gross and items. */
function figures(c: Pick<PayCheck, 'grossCents' | 'items' | 'depositCents'>): Pick<PayCheck, 'taxesCents' | 'benefitsCents' | 'savedAtWorkCents' | 'netCents' | 'differenceCents' | 'employerSavingCents' | 'employerPremiumCents'> {
  const sum = (row: 'taxes' | 'benefits' | 'savedAtWork', f: (x: PaystubItem) => number): number => c.items.filter((x) => PAYSTUB_ITEMS[x.kind].row === row).reduce((s, x) => s + f(x), 0)
  const taxes = sum('taxes', (x) => x.cents)
  const benefits = sum('benefits', (x) => x.cents)
  const saved = sum('savedAtWork', (x) => x.cents)
  const net = c.grossCents - taxes - benefits - saved
  return {
    taxesCents: taxes,
    benefitsCents: benefits,
    savedAtWorkCents: saved,
    netCents: net,
    differenceCents: c.depositCents - net,
    employerSavingCents: sum('savedAtWork', (x) => x.employerCents ?? 0),
    employerPremiumCents: sum('benefits', (x) => x.employerCents ?? 0)
  }
}

/** Several bonus stubs paid with one check, as one. */
function together(stubs: Paystub[]): Paystub {
  if (stubs.length === 1) return stubs[0]
  return { ...stubs[0], grossCents: stubs.reduce((s, x) => s + x.grossCents, 0), netCents: stubs.reduce((s, x) => s + x.netCents, 0), items: stubs.flatMap((x) => x.items) }
}

/** Every check of one calendar year, oldest first. */
function checksOf(year: number): PayCheck[] {
  const pay = classifyLines(`${year}-01-01`, `${year}-12-31`).filter((l) => l.cls === 'pay' && l.paycheckKey)
  const byKey = new Map<string, ClassifiedLine[]>()
  for (const l of pay) {
    const list = byKey.get(l.paycheckKey!)
    if (list) list.push(l)
    else byKey.set(l.paycheckKey!, [l])
  }
  const limits = limitsFor(year)
  const caps: Record<Cap, number> = { deferral: limits.deferral.cents, '457': limits.deferral.cents, socialSecurity: Math.round((limits.ssWageBase.cents * SOCIAL_SECURITY_PER_MILLE) / 1000) }
  const out: PayCheck[] = []
  for (const [key, lines] of byKey) {
    const stubs = listPaystubs(key)
    const groups: ClassifiedLine[][] = []
    for (const l of lines) {
      const g = groups[groups.length - 1]
      if (g && daysBetween(g[0].day, l.day) <= DAY_LIMIT) g.push(l)
      else groups.push([l])
    }
    /** what each cap has taken so far this year */
    const ran: Record<Cap, number> = { deferral: 0, '457': 0, socialSecurity: 0 }
    const ytdOf = (items: PaystubItem[], cap: Cap): number | null => {
      const mine = items.filter((x) => capOf(x.kind) === cap)
      return mine.length && mine.every((x) => x.ytdCents !== null) ? mine.reduce((s, x) => s + x.ytdCents!, 0) : null
    }
    /** An estimate's lines: each cap takes what's left of its year, and the employer's part goes down with it. */
    const capped = (items: PaystubItem[]): PaystubItem[] => {
      const left: Record<Cap, number> = { deferral: Math.max(0, caps.deferral - ran.deferral), '457': Math.max(0, caps['457'] - ran['457']), socialSecurity: Math.max(0, caps.socialSecurity - ran.socialSecurity) }
      return items.map((x) => {
        const cap = capOf(x.kind)
        const take = cap ? Math.min(x.cents, left[cap]) : x.cents
        if (cap) left[cap] -= take
        const employer = x.employerCents === null || take === x.cents ? x.employerCents : x.cents ? roundDiv(x.employerCents * take, x.cents) : x.employerCents
        return { ...x, cents: take, employerCents: employer, ytdCents: null }
      })
    }
    const run = (items: PaystubItem[], exact: boolean): void => {
      for (const cap of ['deferral', '457', 'socialSecurity'] as Cap[]) {
        const ytd = exact ? ytdOf(items, cap) : null
        ran[cap] = ytd ?? ran[cap] + items.filter((x) => capOf(x.kind) === cap).reduce((s, x) => s + x.cents, 0)
      }
    }
    for (const g of groups) {
      const day = g[0].day
      const bonus = g.filter((l) => l.key.endsWith(':bonus'))
      const regular = g.filter((l) => !l.key.endsWith(':bonus'))
      const ids = (ls: ClassifiedLine[]): string[] => [...new Set(ls.map((l) => l.txnId))]
      const deposit = (ls: ClassifiedLine[]): number => ls.reduce((s, l) => s + l.cents, 0)
      if (regular.length) {
        const depositCents = deposit(regular)
        const found = stubFor(stubs, day)
        let check: Omit<PayCheck, keyof ReturnType<typeof figures>>
        if (found?.basis === 'paystub') {
          check = { paycheckKey: key, day, kind: found.stub.kind, basis: 'paystub', stubId: found.stub.id, grossCents: found.stub.grossCents, items: found.stub.items, depositCents, txnIds: ids(regular) }
          run(found.stub.items, true)
        } else {
          // A stub earlier this year says how far the caps had got by then, though its own deposit isn't here.
          if (found && found.stub.payDay <= day && found.stub.payDay.startsWith(String(year))) {
            for (const cap of ['deferral', '457', 'socialSecurity'] as Cap[]) ran[cap] = Math.max(ran[cap], ytdOf(found.stub.items, cap) ?? 0)
          }
          const items = capped(found ? found.stub.items : elections(key, day))
          const gross = found ? found.stub.grossCents : depositCents + items.reduce((s, x) => s + x.cents, 0)
          check = { paycheckKey: key, day, kind: 'regular', basis: found ? 'estimated' : 'deposits', stubId: found?.stub.id ?? null, grossCents: gross, items, depositCents, txnIds: ids(regular) }
          run(items, false)
        }
        out.push({ ...check, ...figures(check) })
      }
      if (bonus.length) {
        const depositCents = deposit(bonus)
        const own = stubs.filter((s) => s.kind === 'bonus' && near(s.payDay, day))
        const stub = own.length ? together(own) : null
        const check = { paycheckKey: key, day, kind: 'bonus' as const, basis: (stub ? 'paystub' : 'deposits') as PayBasis, stubId: stub?.id ?? null, grossCents: stub?.grossCents ?? depositCents, items: stub?.items ?? [], depositCents, txnIds: ids(bonus) }
        if (stub) run(stub.items, true)
        out.push({ ...check, ...figures(check) })
      }
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.paycheckKey.localeCompare(b.paycheckKey) || (a.kind === 'bonus' ? 1 : 0) - (b.kind === 'bonus' ? 1 : 0))
}

/**
 * Each ledger's checks by year, kept until its data moves (db.dataStamp), as lines.ts keeps its series: a month's
 * withholding, its contributions and its run rates all read the same year. Read only; never changed by a caller.
 */
const kept = new WeakMap<object, { stamp: string; years: Map<number, PayCheck[]> }>()

function yearChecks(year: number): PayCheck[] {
  const stamp = db.dataStamp()
  const owner = db.currentConnection()
  if (stamp === null || !owner) return checksOf(year)
  let k = kept.get(owner)
  if (k?.stamp !== stamp) {
    k = { stamp, years: new Map() }
    kept.set(owner, k)
  }
  let checks = k.years.get(year)
  if (!checks) {
    checks = checksOf(year)
    k.years.set(year, checks)
  }
  return checks
}

/** Every payroll's checks from one day to another (inclusive, by each check's first deposit), oldest first: the pay-day table. */
export function payrollChecks(from: string, to: string): PayCheck[] {
  if (to < from) return []
  const out: PayCheck[] = []
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) for (const c of yearChecks(y)) if (c.day >= from && c.day <= to) out.push(c)
  return out
}

/** Pay's actuals over checks: every kind, bonus included. Take-home is what was deposited, which the chain to it reaches. */
export function payTotals(checks: PayCheck[]): PayRunRates['totals'] {
  const sum = (f: (c: PayCheck) => number): number => checks.reduce((s, c) => s + f(c), 0)
  return {
    grossCents: sum((c) => c.grossCents),
    taxesCents: sum((c) => c.taxesCents),
    benefitsCents: sum((c) => c.benefitsCents),
    savedAtWorkCents: sum((c) => c.savedAtWorkCents),
    payrollDiffCents: sum((c) => c.differenceCents),
    takeHomeCents: sum((c) => c.depositCents),
    depositCents: sum((c) => c.depositCents),
    employerSavingCents: sum((c) => c.employerSavingCents),
    employerPremiumCents: sum((c) => c.employerPremiumCents)
  }
}

// ---------- run rates ----------

const PER_YEAR: Partial<Record<string, PayRunRate['checksPerYear']>> = CHECKS_A_YEAR

/** The middle of some numbers, or the mean of the two middle ones. */
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}

/**
 * The days of a payroll's checks over the twelve months ending with a month, oldest first: what its checks a year
 * are read from. Its regular checks, and its checks off the schedule its checks kept when they came: the first check
 * on a faster schedule is one, and the days after it say which (the reading allows the odd check off the schedule).
 * Not a check its own stubs say is bonus.
 */
const checkDays = (key: string, toMonth: string): string[] =>
  [...new Set(payrollChecks(`${shiftMonth(toMonth, -11)}-01`, lastDayOf(toMonth)).filter((c) => c.paycheckKey === key && (c.kind !== 'bonus' || c.basis === 'deposits')).map((c) => c.day))]

/**
 * How many checks a payroll pays a year as of a month (`toMonth`, the last of a run-rate window; the last full month
 * by default), from the best evidence dated up to the month's end over the twelve months ending with it:
 *   1. its latest paystub whose pay period says (7 days weekly, 14 every other week, half a month twice a month, a
 *      whole month monthly), so a stub decides a new job's first check, unless four or more checks after it settle on
 *      another schedule (cadence.ts): the payroll changed it since
 *   2. its regular checks, by the days they land on (cadence.ts), as a series' cadence is told (recurring.ts)
 *   3. when the days can't tell, the median gap between them, and between a week and three weeks every other week
 *      when nearly every gap is two weeks, else twice a month
 * One check alone is taken as monthly. A contribution plan's cadence isn't evidence: it is today's series', read as
 * the plans are listed, and is neither kept with the plan nor dated. Only evidence up to the month counts, so a past
 * month's pay run rates stay the same as time passes and later checks and stubs come in: a job that ended years ago
 * keeps the checks a year it paid.
 */
export function checksPerYear(key: string, toMonth = shiftMonth(db.today().slice(0, 7), -1)): PayRunRate['checksPerYear'] {
  return scheduleOf(key, toMonth).perYear
}

/** A payroll's schedule as of a month: its checks a year, where the latest run on it began, and its first check day in the twelve months. */
interface Schedule {
  perYear: PayRunRate['checksPerYear']
  /** the day the latest run of checks on the schedule began, when the schedule changed over the twelve months; null when it didn't, or the evidence can't tell */
  from: string | null
  first: string
}

/**
 * A payroll's checks a year as of a month (checksPerYear), and where the latest run of its checks on that schedule
 * began. A stub's pay period that decides the checks a year says where the run began too: after the latest check
 * whose own stub states a period paying a different number of checks a year. The days the checks land on say it
 * otherwise, or as well (cadence.ts latestRun), and the later of the two counts: when every other Friday becomes
 * every Friday, the last check every other week lands on the weekly days, and only its stub tells it apart.
 */
function scheduleOf(key: string, toMonth: string): Schedule {
  const from = `${shiftMonth(toMonth, -11)}-01`
  const end = lastDayOf(toMonth)
  const days = checkDays(key, toMonth)
  const first = days[0] ?? end
  const byDays = (perYear: PayRunRate['checksPerYear']): string | null => {
    const run = latestRun(days)
    return run && CHECKS_A_YEAR[run.cadence] === perYear ? run.from : null
  }
  const stubs = listPaystubs(key, from, end).filter((s) => s.kind !== 'bonus')
  const periodOf = (s: Paystub): PayCadence | null => (s.periodFrom && s.periodTo ? periodCadence(s.periodFrom, s.periodTo) : null)
  for (let i = stubs.length - 1; i >= 0; i--) {
    const period = periodOf(stubs[i])
    if (!period) continue
    const settled = settledCadence(days.filter((d) => d > stubs[i].payDay))
    const perYear = CHECKS_A_YEAR[settled ?? period]
    if (settled) return { perYear, from: byDays(perYear), first }
    const old = stubs
      .slice(0, i)
      .reverse()
      .find((s) => {
        const p = periodOf(s)
        return p !== null && CHECKS_A_YEAR[p] !== perYear
      })
    const after = old ? (days.find((d) => daysBetween(old.payDay, d) > DAY_LIMIT) ?? null) : null
    const told = byDays(perYear)
    return { perYear, from: after && told ? (after > told ? after : told) : (after ?? told), first }
  }
  const told = cadenceOf(days)
  if (told) return { perYear: CHECKS_A_YEAR[told], from: byDays(CHECKS_A_YEAR[told]), first }
  // Days that keep no schedule have no run on one either.
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d))
  if (!gaps.length) return { perYear: 12, from: null, first }
  const m = median(gaps)
  return { perYear: m <= 10 ? 52 : m <= 20 ? CHECKS_A_YEAR[byTwoWeekGaps(gaps)] : 12, from: null, first }
}

/**
 * How many checks after a run's first say what its typical check is: two at least, as one could be odd itself, and at
 * most the 6 the bonus rule reads (lines.ts).
 */
const TYPICAL_FROM = 2
const TYPICAL_OF = 6

/**
 * The window's regular checks a payroll's run rate reads (spec 1.1 and 1.2), oldest first:
 *   - For a payroll whose checks settled on a new schedule inside the window, one paying a different number of
 *     checks a year (cadence.ts), only the checks from the first of the latest schedule's run: a check on the old
 *     schedule pays a different period, so a mean with it times the new checks a year is wrong (every other week at
 *     3,000.00 then weekly at 1,500.00 isn't 2,250.00 a week). The new schedule takes over when the checks a year
 *     read it: at once when a stub states its pay period, else once its days settle, the latest four checks keeping
 *     it with one miss at most (three on it and the old schedule's last) and clearly better than the old one. The
 *     first check on a faster schedule comes off the old one, so it is bonus (lines.ts), and its day is among the
 *     three. Before that, the checks a year are still the old schedule's and every check in the window counts, as
 *     one or two checks on new days can't be told from checks off the schedule.
 *   - Not the first check of a run that started inside the window, a payroll's first (none in the nine months
 *     before the window) or its first on the new schedule, when it is two thirds of the typical check after it or
 *     less, or 1.5 times it or more: the median of the next ones, two to six. A check that small pays part of a
 *     period. One that large is the old schedule's last, landing on the new one's days (monthly on Thursday the 1st,
 *     then every other Thursday from the 15th), or a check with a bonus in it. Like a bonus, it counts in every
 *     actual and in no run rate. It is judged only by checks dated up to the window's end, so a month's run rate is
 *     the same once its checks are in: the month of the first check alone still reads it.
 * A raise on the same schedule changes no check's period, so every check in the window still counts.
 */
function runChecks(list: PayCheck[], schedule: Schedule, fromMonth: string): PayCheck[] {
  const start = schedule.from ?? schedule.first
  const mine = list.filter((c) => c.day >= start)
  if (start < `${fromMonth}-01`) return mine
  const later = mine.filter((c) => c.day > start).slice(0, TYPICAL_OF)
  if (later.length < TYPICAL_FROM) return mine
  // A bonus is the part above 1.5 times the typical check, so a check pays part of a period the same distance below
  // it: the typical check is 1.5 times it or more.
  const typical = median(later.map((c) => c.depositCents))
  return mine.filter((c) => c.day !== start || (3 * c.depositCents > 2 * typical && 2 * c.depositCents < 3 * typical))
}

const BASIS_ORDER: PayBasis[] = ['paystub', 'estimated', 'deposits']
const leastExact = (bases: PayBasis[]): PayBasis | null => (bases.length ? BASIS_ORDER[Math.max(...bases.map((b) => BASIS_ORDER.indexOf(b)))] : null)

/**
 * A month's pay run rates (spec 1.1). The window is the three months ending with the month, or for the open month
 * (and any after it) the three full months before it. Per payroll, each figure is its mean over the window's regular
 * checks times the checks it pays a year, over 12, rounded once; Take-home is the difference of the rounded figures,
 * so the chain ties. Bonus checks are left out, and so is a payroll that stopped (a job left, or one an acquirer's
 * payroll took over): its latest check more than two periods and their grace before the window's end, as a series
 * stops (recurring.ts), and for weekly pay that skips weeks, two of its usual gaps between checks in the window.
 */
export function payRunRates(month: string): PayRunRates {
  const current = db.today().slice(0, 7)
  const toMonth = month >= current ? shiftMonth(current, -1) : month
  const fromMonth = shiftMonth(toMonth, -2)
  const end = lastDayOf(toMonth)
  const checks = payrollChecks(`${fromMonth}-01`, end).filter((c) => c.kind !== 'bonus')
  const byKey = new Map<string, PayCheck[]>()
  for (const c of checks) byKey.set(c.paycheckKey, [...(byKey.get(c.paycheckKey) ?? []), c])
  const keys: PayRunRate[] = [...byKey].flatMap(([paycheckKey, list]) => {
    const schedule = scheduleOf(paycheckKey, toMonth)
    const perYear = schedule.perYear
    const cadence = CADENCES.find((c) => PER_YEAR[c.id] === perYear)!
    const last = list.reduce((day, c) => (c.day > day ? c.day : day), '')
    // A weekly payroll ramping up skips weeks, so its period is its usual gap over the window when that's longer.
    const days = [...new Set(list.map((c) => c.day))].sort()
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d))
    const period = cadence.id === 'weekly' && gaps.length ? Math.max(cadence.days, median(gaps)) : cadence.days
    if (daysBetween(last, end) > 2 * period + cadence.grace) return []
    const counted = runChecks(list, schedule, fromMonth)
    const rate = (f: (c: PayCheck) => number): number => roundDiv(counted.reduce((s, c) => s + f(c), 0) * perYear, counted.length * 12)
    const gross = rate((c) => c.grossCents)
    const taxes = rate((c) => c.taxesCents)
    const benefits = rate((c) => c.benefitsCents)
    const saved = rate((c) => c.savedAtWorkCents)
    const diff = rate((c) => c.differenceCents)
    return {
      paycheckKey,
      checksPerYear: perYear,
      checks: counted.length,
      days: counted.map((c) => c.day),
      basis: leastExact(counted.map((c) => c.basis))!,
      grossCents: gross,
      taxesCents: taxes,
      benefitsCents: benefits,
      savedAtWorkCents: saved,
      payrollDiffCents: diff,
      takeHomeCents: gross - taxes - benefits - saved + diff,
      depositCents: rate((c) => c.depositCents),
      employerSavingCents: rate((c) => c.employerSavingCents),
      employerPremiumCents: rate((c) => c.employerPremiumCents)
    }
  })
  const total = (f: (r: PayRunRate) => number): number => keys.reduce((s, r) => s + f(r), 0)
  return {
    month,
    fromMonth,
    toMonth,
    basis: leastExact(keys.map((k) => k.basis)),
    keys: keys.sort((a, b) => a.paycheckKey.localeCompare(b.paycheckKey)),
    totals: {
      grossCents: total((r) => r.grossCents),
      taxesCents: total((r) => r.taxesCents),
      benefitsCents: total((r) => r.benefitsCents),
      savedAtWorkCents: total((r) => r.savedAtWorkCents),
      payrollDiffCents: total((r) => r.payrollDiffCents),
      takeHomeCents: total((r) => r.takeHomeCents),
      depositCents: total((r) => r.depositCents),
      employerSavingCents: total((r) => r.employerSavingCents),
      employerPremiumCents: total((r) => r.employerPremiumCents)
    }
  }
}

/** A payroll's latest regular check on or before a day (today by default), this year or last; null with none. */
export function latestCheck(key: string, day = db.today()): PayCheck | null {
  return payrollChecks(`${Number(day.slice(0, 4)) - 1}-01-01`, day).filter((c) => c.paycheckKey === key && c.kind !== 'bonus').at(-1) ?? null
}

// ---------- checks ----------

/** A difference above this between a stub and its deposit, or the stubs and the return, is a check item. */
const TOLERANCE = 100

/**
 * The year's paystubs against its filed return (spec 2, identity 5): wages, gross less pre-tax lines, and federal
 * withholding over every stub of every kind, bonus included. Only when every check of the year has its own stub is a
 * difference above $1 from the return's wages or withholding a w2_mismatch.
 */
export function yearCheck(year: number): YearCheck {
  const checks = yearChecks(year)
  const complete = checks.length > 0 && checks.every((c) => c.basis === 'paystub')
  const stubs = listPaystubs(undefined, `${year}-01-01`, `${year}-12-31`)
  const wagesCents = stubs.reduce((s, p) => s + p.grossCents - p.items.filter((x) => x.pretax).reduce((t, x) => t + x.cents, 0), 0)
  const federalCents = stubs.reduce((s, p) => s + p.items.filter((x) => x.kind === 'federal').reduce((t, x) => t + x.cents, 0), 0)
  const out: CheckItem[] = []
  const filed = complete ? findTaxYear(year) : null
  if (filed?.wagesCents !== null && filed?.wagesCents !== undefined && Math.abs(wagesCents - filed.wagesCents) > TOLERANCE) out.push({ kind: 'w2_mismatch', cents: wagesCents - filed.wagesCents, year })
  if (filed?.withheldCents !== null && filed?.withheldCents !== undefined && Math.abs(federalCents - filed.withheldCents) > TOLERANCE) out.push({ kind: 'w2_mismatch', cents: federalCents - filed.withheldCents, year })
  return { year, complete, wagesCents, federalCents, checks: out }
}

/**
 * Payroll check items this year and last (spec 1.2 and identity 4): paystub_mismatch for each check whose own stub's
 * net differs from its deposits by more than $1, and paystub_missing for a payroll whose latest check has no stub of
 * its own and whose estimated net differs from its deposits by more than $1. Cents are deposit less net.
 */
export function payrollCheckItems(): Array<{ item: CheckItem; check: PayCheck }> {
  if (!db.get('SELECT 1 FROM paystubs LIMIT 1')) return []
  const today = db.today()
  const checks = payrollChecks(`${Number(today.slice(0, 4)) - 1}-01-01`, today)
  const out: Array<{ item: CheckItem; check: PayCheck }> = []
  for (const c of checks) if (c.basis === 'paystub' && Math.abs(c.differenceCents) > TOLERANCE) out.push({ item: { kind: 'paystub_mismatch', cents: c.differenceCents, paycheckKey: c.paycheckKey, payDay: c.day }, check: c })
  const latest = new Map<string, PayCheck>()
  for (const c of checks) if (c.kind !== 'bonus') latest.set(c.paycheckKey, c)
  for (const c of latest.values()) if (c.basis === 'estimated' && Math.abs(c.differenceCents) > TOLERANCE) out.push({ item: { kind: 'paystub_missing', cents: c.differenceCents, paycheckKey: c.paycheckKey, payDay: c.day }, check: c })
  return out
}
