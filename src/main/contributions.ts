import * as db from './db'
import { checksPerYear, latestCheck, payrollChecks } from './paystubs'
import { CADENCES, detectRecurring, nextDate } from './recurring'
import { limitsFor, type Limit } from '../shared/limits'
import { PAYSTUB_ITEMS, planGroup } from '../shared/payroll'
import { isDay } from '../shared/period'
import { roundDiv } from '../shared/rounding'
import { daysInMonth } from '../shared/zone'
import type { Contribution, ContributionKind, ContributionLimit, ContributionSummary, MonthSummary, PayCheck, PaycheckWithholding, Paystub, PaystubItem, WithholdingAmounts, WithholdingCentsKey } from '../shared/types'

const WITHHOLDING_KEYS: WithholdingCentsKey[] = ['federalCents', 'socialSecurityCents', 'medicareCents', 'stateCents', 'insuranceCents', 'otherCents']
const scaled = (w: WithholdingAmounts, times: number): WithholdingAmounts => ({
  ...(Object.fromEntries(WITHHOLDING_KEYS.map((k) => [k, Math.round(w[k] * times)])) as Record<WithholdingCentsKey, number>),
  insurance: w.insurance.map((x) => ({ ...x, cents: Math.round(x.cents * times) }))
})

// Yearly limits come from shared/limits.ts: elective deferrals across every
// 401(k) (pre-tax and Roth together, before any age-50 catch-up), and the HSA
// (self-only coverage). A year not announced yet carries the last one forward
// as provisional.

/** A year's HSA limit for self-only coverage. */
export const hsaLimit = (year: number): Limit => limitsFor(year).hsaSelf

const employerName = (paycheck: string): string => paycheck.replace(/\s+(payroll|direct dep(osit)?|pay)$/i, '').trim()

/** A month's first day, or a day as it is. */
const firstDay = (period: string): string => (isDay(period) ? period : `${period}-01`)
/** A month's last day, or a day as it is. */
function lastDay(period: string): string {
  if (isDay(period)) return period
  const [y, m] = period.split('-').map(Number)
  return `${period}-${String(daysInMonth(y, m)).padStart(2, '0')}`
}

/**
 * The kind a savings line on a stub shows as among the plans: the HSA and the ESPP as themselves, and the other plans
 * by when they come out of pay, a 403(b) or 457 with the pre-tax 401(k) and an after-tax 401(k) with the Roth.
 */
const planKind = (kind: PaystubItem['kind']): ContributionKind => (kind === 'hsa' || kind === 'espp' ? kind : planGroup(kind) === 'posttax' ? 'roth_401k' : '401k')

type Plan = ReturnType<typeof db.listContributionRows>[number]

/**
 * The plan each savings line of a check goes to, by the plan's id: each of its payroll's plans takes the line of its
 * name, else the line of its own kind, else one of a kind it shows with (a 403(b) with the 401(k)), so a Roth plan
 * takes the Roth line before an after-tax one. A line no plan claims isn't here.
 */
export function plansOfCheck(c: Pick<PayCheck, 'paycheckKey' | 'items'>, plans: Plan[]): Map<PaystubItem, number> {
  const mine = plans.filter((p) => p.paycheckKey === c.paycheckKey)
  const lines = c.items.filter((x) => PAYSTUB_ITEMS[x.kind].row === 'savedAtWork')
  const claimed = new Map<PaystubItem, number>()
  const claim = (match: (p: Plan, l: PaystubItem) => boolean): void => {
    for (const p of mine) {
      if ([...claimed.values()].includes(p.id)) continue
      const x = lines.find((l) => !claimed.has(l) && match(p, l))
      if (x) claimed.set(x, p.id)
    }
  }
  claim((p, l) => l.name.trim().toLowerCase() === p.name.trim().toLowerCase())
  claim((p, l) => l.kind === p.kind)
  claim((p, l) => planKind(l.kind) === p.kind)
  return claimed
}

/**
 * What each plan took from the paychecks between two months or days (inclusive), and what the employer added: per
 * check, the plan's line on the paystub the check reads (its own, or the nearest one it's estimated from), or with
 * no stub, its election in force that day. A stub's line goes to the plan of its name, else the payroll's plan of
 * its kind, else a plan it shows with (a 403(b) with the 401(k)); a line no plan claims shows by its own name.
 */
export function monthContributions(month: string, toMonth = month): NonNullable<MonthSummary['contributions']> {
  const checks = payrollChecks(firstDay(month), lastDay(toMonth))
  const plans = db.listContributionRows().filter((p) => p.paycheckKey)
  const sums = new Map<number, { employeeCents: number; matchCents: number }>()
  const extra = new Map<string, { name: string; kind: ContributionKind; paycheckKey: string; employeeCents: number; matchCents: number }>()
  for (const c of checks) {
    const lines = c.items.filter((x) => PAYSTUB_ITEMS[x.kind].row === 'savedAtWork')
    const claimed = plansOfCheck(c, plans)
    for (const x of lines) {
      const id = claimed.get(x)
      const s = id !== undefined ? (sums.get(id) ?? { employeeCents: 0, matchCents: 0 }) : null
      if (s && id !== undefined) {
        s.employeeCents += x.cents
        s.matchCents += x.employerCents ?? 0
        sums.set(id, s)
        continue
      }
      const k = `${c.paycheckKey}\u0000${x.name}`
      const e = extra.get(k) ?? { name: x.name, kind: planKind(x.kind), paycheckKey: c.paycheckKey, employeeCents: 0, matchCents: 0 }
      e.employeeCents += x.cents
      e.matchCents += x.employerCents ?? 0
      extra.set(k, e)
    }
  }
  const out: NonNullable<MonthSummary['contributions']> = []
  for (const p of plans) {
    const s = sums.get(p.id)
    if (s && (s.employeeCents || s.matchCents)) out.push({ name: p.name, kind: p.kind, paycheckKey: p.paycheckKey!, ...s })
  }
  for (const e of extra.values()) if (e.employeeCents || e.matchCents) out.push(e)
  return out
}

/**
 * A stub's taxes and benefits as the money-flow charts read them: federal income tax, Social Security, Medicare, the
 * rest of the taxes with the state's, each premium, benefit or named deduction by its name, and the stub's unnamed
 * other deductions as other.
 */
function withholdingOf(items: PaystubItem[]): WithholdingAmounts {
  const w: WithholdingAmounts = { federalCents: 0, socialSecurityCents: 0, medicareCents: 0, stateCents: 0, insuranceCents: 0, insurance: [], otherCents: 0 }
  for (const x of items) {
    const row = PAYSTUB_ITEMS[x.kind].row
    if (row === 'taxes') {
      const field: WithholdingCentsKey = x.kind === 'federal' ? 'federalCents' : x.kind === 'social_security' ? 'socialSecurityCents' : x.kind === 'medicare' ? 'medicareCents' : 'stateCents'
      w[field] += x.cents
    } else if (x.kind === 'other_deduction' && x.name === PAYSTUB_ITEMS.other_deduction.label) {
      w.otherCents += x.cents
    } else if (row === 'benefits') {
      const same = w.insurance.find((i) => i.name === x.name && i.pretax === x.pretax)
      if (same) same.cents += x.cents
      else w.insurance.push({ name: x.name, cents: x.cents, pretax: x.pretax })
      w.insuranceCents += x.cents
    }
  }
  return w
}

/** Several checks' withholding added up. */
function added(list: WithholdingAmounts[]): WithholdingAmounts {
  const w = withholdingOf([])
  for (const x of list) {
    for (const k of WITHHOLDING_KEYS) w[k] += x[k]
    for (const i of x.insurance) {
      const same = w.insurance.find((y) => y.name === i.name && y.pretax === i.pretax)
      if (same) same.cents += i.cents
      else w.insurance.push({ ...i })
    }
  }
  return w
}

/** Taxes and benefits withheld from the paychecks between two months or days (inclusive), by payroll: per check, from the paystub it reads. A check with no stub to read (deposits alone) withheld nothing known. */
export function monthWithholding(month: string, toMonth = month): NonNullable<MonthSummary['withholding']> {
  const byKey = new Map<string, PayCheck[]>()
  for (const c of payrollChecks(firstDay(month), lastDay(toMonth))) if (c.basis !== 'deposits') byKey.set(c.paycheckKey, [...(byKey.get(c.paycheckKey) ?? []), c])
  return [...byKey.keys()].sort().map((paycheckKey) => ({ paycheckKey, ...added(byKey.get(paycheckKey)!.map((c) => withholdingOf(c.items))) }))
}

/** Each payroll's latest regular paystub, by key. */
function latestStubs(): Map<string, Paystub> {
  const out = new Map<string, Paystub>()
  for (const s of db.listPaystubs()) if (s.kind === 'regular') out.set(s.paycheckKey, s)
  return out
}

/**
 * A plan's match by its rule (match_rate_bp of pay up to match_cap_bp of pay) on a check of `grossCents`: what its
 * election earns, and what's left, the match on the rest of the cap the election doesn't reach, per check and per
 * month at the payroll's checks a year. The election is the plan's percent, else its amount over gross. Null without
 * a rule or a gross.
 */
export function structuredMatch(p: Pick<Contribution, 'percent' | 'employeeCents' | 'matchRateBp' | 'matchCapBp'>, grossCents: number, perYear: number): { electionBp: number; matchCents: number; leftCents: number; leftPerMonthCents: number } | null {
  if (p.matchRateBp === null || p.matchCapBp === null || grossCents <= 0) return null
  const electionBp = p.percent !== null ? Math.round(p.percent * 100) : roundDiv((p.employeeCents ?? 0) * 10000, grossCents)
  const matchCents = roundDiv(grossCents * p.matchRateBp * Math.min(electionBp, p.matchCapBp), 100_000_000)
  const leftCents = roundDiv(grossCents * p.matchRateBp * Math.max(0, p.matchCapBp - electionBp), 100_000_000)
  return { electionBp, matchCents, leftCents, leftPerMonthCents: roundDiv(leftCents * perYear, 12) }
}

/** A plan's match left on the table at its payroll's latest check: the structured match on that check's gross, at the checks the payroll pays a year. */
export function matchLeft(p: Pick<Contribution, 'paycheckKey' | 'percent' | 'employeeCents' | 'matchRateBp' | 'matchCapBp'>): (NonNullable<ReturnType<typeof structuredMatch>> & { grossCents: number; checksPerYear: number }) | null {
  if (!p.paycheckKey || p.matchRateBp === null || p.matchCapBp === null) return null
  const check = latestCheck(p.paycheckKey)
  if (!check) return null
  const perYear = checksPerYear(p.paycheckKey)
  const m = structuredMatch(p, check.grossCents, perYear)
  return m ? { ...m, grossCents: check.grossCents, checksPerYear: perYear } : null
}

/** Every contribution plan with its monthly amounts, this year's totals and the limits they count toward. */
export function contributionSummary(): ContributionSummary {
  const today = db.today()
  const year = Number(today.slice(0, 4))
  const yearEnd = `${year}-12-31`
  const series = new Map(detectRecurring().map((s) => [s.key, s]))
  const rows = db.listContributionRows()
  // What each plan's line on this year's checks so far adds up to, as the waterfall's limits read them: the stub a
  // check reads, or with none the election in force that day. A plan no check's line went to isn't here.
  const fromChecks = new Map<number, number>()
  for (const c of payrollChecks(`${year}-01-01`, today)) for (const [x, id] of plansOfCheck(c, rows)) fromChecks.set(id, (fromChecks.get(id) ?? 0) + x.cents)

  const plans: Contribution[] = rows.map((p) => {
    const pay = p.paycheckKey ? series.get(p.paycheckKey) : undefined
    const cadence = pay?.cadence ?? null
    const ended = !!p.endsDay && p.endsDay < today
    // An election change applies from the first paycheck on or after its date.
    const changed = p.nextFrom !== null && p.nextEmployeeCents !== null
    const amountOn = (day: string): number => (changed && day >= p.nextFrom! ? p.nextEmployeeCents! : (p.employeeCents ?? 0))
    const current = changed && today >= p.nextFrom! ? p.nextEmployeeCents : p.employeeCents
    const perMonth = (cents: number | null): number => {
      const c = CADENCES.find((x) => x.id === cadence)
      return !ended && c && cents ? Math.round((cents * 30.44) / c.days) : 0
    }
    // Paychecks still to come this year, stepping from the next expected one.
    const future: string[] = []
    if (pay && pay.status !== 'stopped' && !ended) {
      const c = CADENCES.find((x) => x.id === pay.cadence)!
      for (let d = pay.nextDate; db.dayKey(d) <= yearEnd && (!p.endsDay || db.dayKey(d) <= p.endsDay); d = nextDate(d, pay.cadence, c.days)) future.push(db.dayKey(d))
    }
    const sinceYtd = p.ytdAsOf && p.paycheckKey ? db.paychecksAfter(p.paycheckKey, p.ytdAsOf, p.endsDay) : []
    const thisYear = p.ytdCents !== null && !!p.ytdAsOf?.startsWith(String(year))
    // A total entered for this year is the plan's word, with the paychecks since; without one, this year's checks.
    const soFarCents = thisYear ? p.ytdCents! + sinceYtd.reduce((s, d) => s + amountOn(d), 0) : (fromChecks.get(p.id) ?? null)
    return {
      ...p,
      employer: pay ? employerName(pay.name) : null,
      cadence,
      perMonthCents: perMonth(current),
      matchPerMonthCents: perMonth(p.matchCents),
      checksLeft: future.length,
      soFarCents,
      projectedCents: soFarCents === null ? null : soFarCents + future.reduce((s, d) => s + amountOn(d), 0)
    }
  })

  const limit = (label: string, l: Limit, match: (p: Contribution) => boolean): ContributionLimit => {
    const own = plans.filter(match)
    const known = own.filter((p) => p.projectedCents !== null)
    return {
      label,
      limitCents: l.cents,
      limitProvisional: l.provisional,
      ytdCents: known.reduce((s, p) => s + p.soFarCents!, 0),
      projectedCents: known.reduce((s, p) => s + p.projectedCents!, 0),
      unknown: own.filter((p) => p.projectedCents === null).map((p) => p.name)
    }
  }
  const l = limitsFor(year)
  const limits: ContributionLimit[] = []
  if (plans.some((p) => p.kind === '401k' || p.kind === 'roth_401k')) limits.push(limit(`401(k) elective deferrals, all employers`, l.deferral, (p) => p.kind === '401k' || p.kind === 'roth_401k'))
  if (plans.some((p) => p.kind === 'hsa')) limits.push(limit('HSA, self-only', l.hsaSelf, (p) => p.kind === 'hsa'))

  // What each payroll withholds per check, from its latest regular paystub.
  const withholding: PaycheckWithholding[] = [...latestStubs().values()].sort((a, b) => a.paycheckKey.localeCompare(b.paycheckKey)).map((s) => {
    const pay = series.get(s.paycheckKey)
    const c = pay && pay.status !== 'stopped' ? CADENCES.find((x) => x.id === pay.cadence) : undefined
    const w = withholdingOf(s.items)
    return { paycheckKey: s.paycheckKey, asOf: s.payDay, grossCents: s.grossCents, netCents: s.netCents, ...w, employer: pay ? employerName(pay.name) : null, cadence: pay?.cadence ?? null, perMonth: scaled(w, c ? 30.44 / c.days : 0) }
  })
  return { year, plans, limits, withholding }
}
