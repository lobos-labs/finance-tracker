import type { DebtView } from './types'

// Month-by-month debt payoff: every debt accrues interest and gets its minimum,
// and whatever is left of the monthly amount goes to one debt at a time:
// the highest rate first (avalanche) or the smallest balance first (snowball).
// A debt the plan leaves out still gets its minimum from the same money while
// it owes, and never anything more.
// runDebtPlan is the one plan the app runs, on getDebts and the debt.plan
// inputs: the Debts page, Saved's next debt, the headline's payoff and Review
// all read it.

export interface PlanDebt {
  id: string
  name: string
  kind: 'card' | 'loan'
  balanceCents: number
  /** percent a year */
  apr: number
  /** an intro rate (often 0%) until promoEnds (YYYY-MM-DD) */
  promoApr: number | null
  promoEnds: string | null
  /** the minimum on file, a card's never below its usual one; null: a card's usual minimum (1% plus interest, at least $35), or 2% of a loan's balance */
  minPaymentCents: number | null
}

export type Strategy = 'avalanche' | 'snowball'

export interface PlanResult {
  months: Array<{ month: string; balances: number[] }>
  debts: Array<{ id: string; paidOff: string | null; interestCents: number; order: number | null }>
  debtFree: string | null
  interestCents: number
  /** how much a month falls short of the minimums, at worst */
  shortfallCents: number
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * A debt's minimum in a month, on what it owes after that month's interest, never more than that: a loan's on file,
 * else 2% of what it owes; a card's usual minimum, 1% plus the interest and at least $35, or the one on file when
 * that's more. A statement's minimum is figured on the balance it closed at, so as a card's balance grows it asks at
 * least the interest and some of what's owed, however low the minimum on file: a card is never left to compound.
 */
export function minimumFor(d: PlanDebt, balance: number, interest: number): number {
  if (d.kind === 'loan') return Math.min(balance, d.minPaymentCents ?? Math.round(balance * 0.02))
  return Math.min(balance, Math.max(d.minPaymentCents ?? 0, 3500, Math.round(balance * 0.01) + interest))
}

export function rateFor(d: PlanDebt, month: string): number {
  const promo = d.promoEnds && month < d.promoEnds.slice(0, 7)
  return promo ? (d.promoApr ?? 0) : d.apr
}

/** A card or loan without a known rate is planned at a typical rate until one is entered. */
export const CARD_APR = 24
export const LOAN_APR = 10

/**
 * The debt the plan pays extra on in a month, by its index, among those still owing: the highest rate in force first,
 * an intro rate counting while it lasts and the smaller balance first at one rate (avalanche), or the smallest balance
 * first (snowball); -1 when none owes.
 */
export function targetOf(debts: PlanDebt[], balances: number[], strategy: Strategy, month: string): number {
  let best = -1
  for (let k = 0; k < debts.length; k++) {
    if (balances[k] <= 0) continue
    if (best < 0) {
      best = k
      continue
    }
    const better =
      strategy === 'snowball'
        ? balances[k] < balances[best]
        : rateFor(debts[k], month) > rateFor(debts[best], month) || (rateFor(debts[k], month) === rateFor(debts[best], month) && balances[k] < balances[best])
    if (better) best = k
  }
  return best
}

/**
 * The plan month by month. `kept` are the debts it leaves out: each month, while they owe, their minimums come out of
 * the monthly amount before the plan's own debts get theirs, and they never get more; what they owe and the interest
 * they charge aren't the plan's.
 */
export function simulate(debts: PlanDebt[], monthlyCents: number, strategy: Strategy, startMonth: string, lumpCents = 0, kept: PlanDebt[] = []): PlanResult {
  const bal = debts.map((d) => Math.max(0, d.balanceCents))
  const interest = debts.map(() => 0)
  const paidOff: Array<string | null> = debts.map(() => null)
  const order: Array<number | null> = debts.map(() => null)
  let paidCount = 0
  let shortfall = 0
  const months: PlanResult['months'] = []
  const keptBal = kept.map((d) => Math.max(0, d.balanceCents))
  /** What the debts left out take in a month: each one's minimum after its interest, while it owes. */
  const keepUp = (month: string): number => {
    let paid = 0
    for (let k = 0; k < kept.length; k++) {
      if (keptBal[k] <= 0) continue
      const accrued = Math.round((keptBal[k] * rateFor(kept[k], month)) / 1200)
      const pay = minimumFor(kept[k], keptBal[k] + accrued, accrued)
      keptBal[k] += accrued - pay
      paid += pay
    }
    return paid
  }

  const target = (month: string): number => targetOf(debts, bal, strategy, month)
  const extra = (pool: number, month: string): void => {
    for (let k = target(month); pool > 0 && k >= 0; k = target(month)) {
      const pay = Math.min(pool, bal[k])
      bal[k] -= pay
      pool -= pay
    }
  }
  const markPaid = (month: string): void => {
    for (let k = 0; k < debts.length; k++) {
      if (bal[k] <= 0 && paidOff[k] === null && debts[k].balanceCents > 0) {
        paidOff[k] = month
        order[k] = ++paidCount
      }
    }
  }

  extra(lumpCents, startMonth)
  markPaid(startMonth)
  let month = startMonth
  for (let i = 0; i < 600 && bal.some((b) => b > 0); i++) {
    month = i === 0 ? startMonth : shiftMonth(month, 1)
    const accrued = bal.map((b, k) => (b > 0 ? Math.round((b * rateFor(debts[k], month)) / 1200) : 0))
    accrued.forEach((x, k) => {
      bal[k] += x
      interest[k] += x
    })
    let pool = monthlyCents - keepUp(month)
    for (let k = 0; k < debts.length; k++) {
      if (bal[k] <= 0) continue
      const pay = minimumFor(debts[k], bal[k], accrued[k])
      bal[k] -= pay
      pool -= pay
    }
    if (pool < 0) {
      shortfall = Math.max(shortfall, -pool)
      pool = 0
    }
    extra(pool, month)
    markPaid(month)
    months.push({ month, balances: [...bal] })
  }
  // With nothing of its own to pay, the plan still falls short when the debts left out take more than there is.
  if (!months.length && kept.length) shortfall = Math.max(0, keepUp(startMonth) - monthlyCents)
  return {
    months,
    debts: debts.map((d, k) => ({ id: d.id, paidOff: paidOff[k], interestCents: interest[k], order: order[k] })),
    debtFree: bal.every((b) => b <= 0) ? (months.at(-1)?.month ?? startMonth) : null,
    interestCents: interest.reduce((s, x) => s + x, 0),
    shortfallCents: shortfall
  }
}

/** Months between two YYYY-MM months. */
export const monthsBetween = (a: string, b: string): number => {
  const [ay, am] = a.split('-').map(Number)
  const [by, bm] = b.split('-').map(Number)
  return (by - ay) * 12 + (bm - am)
}

/** A debt as the plan reads it: one with no rate on file at a typical rate. */
const planDebt = (d: DebtView['debts'][number]): PlanDebt => ({ id: d.id, name: d.name, kind: d.kind, balanceCents: d.balanceCents, apr: d.apr ?? (d.kind === 'card' ? CARD_APR : LOAN_APR), promoApr: d.promoApr, promoEnds: d.promoEnds, minPaymentCents: d.minPaymentCents })

/** The debts the plan pays down: every debt the plan doesn't leave out, one with no rate on file planned at a typical rate. */
export function plannedDebts(view: Pick<DebtView, 'debts' | 'plan'>): PlanDebt[] {
  return view.debts.filter((d) => !view.plan.leftOut.includes(d.id)).map(planDebt)
}

/** The debts the plan leaves out, which still take their minimums from the same money. */
export function leftOutDebts(view: Pick<DebtView, 'debts' | 'plan'>): PlanDebt[] {
  return view.debts.filter((d) => view.plan.leftOut.includes(d.id)).map(planDebt)
}

/** A debt's minimum in the month it owes its balance, after that month's interest, as simulate pays it. */
export function minimumIn(d: PlanDebt, month: string): number {
  const accrued = Math.round((Math.max(0, d.balanceCents) * rateFor(d, month)) / 1200)
  return minimumFor(d, Math.max(0, d.balanceCents) + accrued, accrued)
}

/** The payoff plan as it runs on the debt plan's inputs. */
export interface DebtPlanRun {
  /** the debts it pays down, in getDebts' order */
  debts: PlanDebt[]
  /** the debts it leaves out, in getDebts' order */
  leftOut: PlanDebt[]
  /** the take-home it plans with: the debt plan's own, else the Take-home run rate */
  takeHomeCents: number
  /** a month's spending it can't put toward the debts */
  spendCents: number
  /** the minimums the debts left out take in the plan's first month, from the same take-home */
  leftOutCents: number
  /**
   * what goes to the debts it pays down in its first month: the take-home less the spending, the set-aside and the
   * minimums of the debts left out; none when that's below zero or it pays down no debt
   */
  monthlyCents: number
  result: PlanResult
}

/**
 * The payoff plan (waterfall spec 1.6): from the month after the plan's month, what's left of the take-home after a
 * month's spending (getDebts' run rates, unless another spending is asked about) and the set-aside pays each debt its
 * minimum, a debt left out included while it owes, and the rest goes to the debts not left out by the plan's order,
 * with the lump sum paid first.
 */
export function runDebtPlan(view: DebtView, spendCents = view.spendCents): DebtPlanRun {
  const takeHomeCents = view.plan.takeHomeCents ?? view.takeHomeCents
  const available = Math.max(0, takeHomeCents - spendCents - view.plan.setAsideCents)
  const debts = plannedDebts(view)
  const leftOut = leftOutDebts(view)
  const start = shiftMonth(view.month, 1)
  const leftOutCents = leftOut.reduce((s, d) => s + minimumIn(d, start), 0)
  const monthlyCents = debts.length ? Math.max(0, available - leftOutCents) : 0
  return { debts, leftOut, takeHomeCents, spendCents, leftOutCents, monthlyCents, result: simulate(debts, available, view.plan.strategy, start, view.plan.lumpCents, leftOut) }
}

/**
 * The debt-free months at the low and high ends of the likely spending, as the Budget page gave them: the plan at its
 * spending less, and more, the twelve months' spread below and above it over the square root of the plan's months.
 * Null when either never comes or they're the same month.
 */
export function likelyDebtFree(view: DebtView, run: DebtPlanRun): { early: string; late: string } | null {
  const n = Math.sqrt(Math.max(1, run.result.months.length))
  const early = runDebtPlan(view, Math.round(run.spendCents - (view.spendCents - view.spendLowCents) / n)).result.debtFree
  const late = runDebtPlan(view, Math.round(run.spendCents + (view.spendHighCents - view.spendCents) / n)).result.debtFree
  return early && late && early !== late ? { early, late } : null
}
