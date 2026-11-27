import * as db from './db'
import { oneOffTarget } from './budget'
import { detectRecurring } from './recurring'
import { planRates } from './waterfall'
import { plannedDebts, rateFor, targetOf } from '../shared/debtPlan'
import { shiftMonth } from '../shared/zone'
import type { AssetType, DebtPlanInputs, DebtView, HomePlans } from '../shared/types'

// The debt plan's inputs (waterfall spec 1.6, from phase 2): what Personal owes, what comes in a month and what a
// month costs before anything goes to debt. Take-home is the Take-home run rate, and spending is the Committed run
// rate without what debts charge in interest, plus the Everyday and One-offs run rates (waterfall.ts planRates), so
// the plan reads the same first derivative Home does. A loan's escrow is spending, not a payment on the loan: a
// minimum is what a payment pays in principal and interest. Beside them, the plan's own inputs in the debt.plan
// setting (spec 7): its order, the debts it leaves out, a take-home of the user's own, a set-aside and a lump sum,
// which Review keeps (set_debt_plan). The plan itself runs in shared/debtPlan.ts runDebtPlan, on Net worth's Debts,
// in the headline's payoff and in Review's answers; Home's Saved shows the debt it pays extra on first.

/** The debts the plan pays down: credit cards, loans, mortgages and other debts. */
const DEBTS = new Set<AssetType>(['credit_card', 'loan', 'mortgage', 'other_debt'])

/**
 * Personal's debts that owe today, each with what it owes as Net worth's balance sheet and the bridge have it (its own
 * balance walked to today by the lines dated after it, or with none of its own yet what its lines and known balances
 * give), its rates and its minimum: the one on file, else a loan's latest payment without its escrow (`payments`),
 * else a recurring amount on the loan itself (`series`, read only when asked). A loan's minimum on file is the payment
 * its statement asks, so the escrow on file comes out of it as it does from a payment: that's the home's taxes and
 * insurance, in the plan's spending already. One no more than its escrow can't hold it, and stands as principal and
 * interest alone.
 */
function personalDebts(payments: Map<string, number>, series?: () => ReturnType<typeof detectRecurring>): DebtView['debts'] {
  const today = db.today()
  const all = db.listAccounts()
  const bucketOf = new Map(all.map((a) => [a.id, a.bucketId]))
  // A debt is a venture's when it or the asset it's linked to is, as the classifier owns a loan (lines.ts debtBook):
  // a house put in a venture takes its mortgage with it.
  const owner = (a: (typeof all)[number]): number | null => a.bucketId ?? (a.linkedAssetId ? (bucketOf.get(a.linkedAssetId) ?? null) : null)
  const accounts = all.filter((a) => !a.hidden && owner(a) === null && DEBTS.has(a.assetType) && !(a.closedDay && a.closedDay <= today))
  // A card spent on after its balance was last read owes that much more today, as the balance sheet shows it.
  const walked = db.balancesOn(
    accounts.map((a) => a.id),
    today
  )
  let recurring: ReturnType<typeof detectRecurring> | null = null
  const out: DebtView['debts'] = []
  for (const a of accounts) {
    const owed = -(walked.get(a.id) ?? 0)
    if (owed <= 0) continue
    const kind = a.assetType === 'credit_card' ? 'card' : 'loan'
    const escrow = kind === 'loan' ? (a.escrowCents ?? 0) : 0
    const onFile = a.minPaymentCents === null ? null : a.minPaymentCents > escrow ? a.minPaymentCents - escrow : a.minPaymentCents
    let minimum = onFile ?? (kind === 'loan' ? (payments.get(a.id) ?? null) : null)
    if (minimum === null && kind === 'loan' && series) {
      // A loan's payment booked on the loan itself shows there as a recurring amount.
      recurring ??= series()
      const s = recurring.find((x) => !x.dismissed && x.accountName === a.name && x.typicalCents < 0 && x.status !== 'stopped')
      minimum = s ? Math.abs(s.typicalCents) : null
    }
    out.push({ id: a.id, name: a.name, kind, balanceCents: owed, apr: a.apr, promoApr: a.promoApr, promoEnds: a.promoEnds, minPaymentCents: minimum })
  }
  return out
}

// ---------- the debt.plan setting ----------

/** The setting that holds the debt plan's inputs, in one row of JSON (spec 7). */
export const DEBT_PLAN_KEY = 'debt.plan'
/** Where the payoff order was kept before the plan had a setting of its own: the Budget page's prefs (budget.ts). */
const EARLIER_ORDER_KEY = 'budget.prefs'

/** A setting's JSON as an object; null when it's unset or holds anything else. */
function stored(key: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(db.getSetting(key) ?? 'null') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whole cents of zero or more; null for anything else. */
const wholeCents = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

/**
 * The debt plan's inputs, and the one place that decides the plan's order: the debt.plan setting as stored. Until
 * something sets it, the order chosen on the Budget page before the plan had a setting of its own, else the highest
 * rate first, with no debt left out, the Take-home run rate, nothing set aside and no lump sum.
 */
export function debtPlan(): DebtPlanInputs {
  const p = stored(DEBT_PLAN_KEY)
  const order = p ? p.strategy : stored(EARLIER_ORDER_KEY)?.debtStrategy
  return {
    strategy: order === 'snowball' ? 'snowball' : 'avalanche',
    leftOut: Array.isArray(p?.leftOut) ? [...new Set(p.leftOut.filter((x): x is string => typeof x === 'string'))] : [],
    takeHomeCents: wholeCents(p?.takeHomeCents),
    setAsideCents: wholeCents(p?.setAsideCents) ?? 0,
    lumpCents: wholeCents(p?.lumpCents) ?? 0
  }
}

/** Every debt account on the books, by id: what the plan may leave out. */
const debtAccounts = (): Map<string, string> => new Map(db.listAccounts().flatMap((a) => (DEBTS.has(a.assetType) ? [[a.id, a.name] as const] : [])))

/**
 * Sets the inputs given and keeps the rest; every one is checked before any is written. The debts left out are the
 * whole list, each a debt account's id; the take-home is null to plan with the Take-home run rate.
 */
export function setDebtPlan(patch: Partial<DebtPlanInputs>): DebtPlanInputs {
  const next = { ...debtPlan() }
  if (patch.strategy !== undefined) {
    if (patch.strategy !== 'avalanche' && patch.strategy !== 'snowball') throw new Error('The order is avalanche (the highest rate first) or snowball (the smallest balance first)')
    next.strategy = patch.strategy
  }
  if (patch.leftOut !== undefined) {
    if (!Array.isArray(patch.leftOut) || patch.leftOut.some((x) => typeof x !== 'string')) throw new Error('The debts left out are a list of account ids')
    const debts = debtAccounts()
    const unknown = patch.leftOut.filter((id) => !debts.has(id))
    if (unknown.length) throw new Error(`Not a debt account: ${unknown.join(', ')}`)
    next.leftOut = [...new Set(patch.leftOut)]
  }
  const amount = (v: unknown, what: string): number => {
    const c = wholeCents(v)
    if (c === null) throw new Error(`${what} is whole cents of zero or more`)
    return c
  }
  if (patch.takeHomeCents !== undefined) next.takeHomeCents = patch.takeHomeCents === null ? null : amount(patch.takeHomeCents, 'The take-home')
  if (patch.setAsideCents !== undefined) next.setAsideCents = amount(patch.setAsideCents, 'The set-aside')
  if (patch.lumpCents !== undefined) next.lumpCents = amount(patch.lumpCents, 'The lump sum')
  db.setSetting(DEBT_PLAN_KEY, JSON.stringify(next))
  return debtPlan()
}

/**
 * Dollars as a viewer typed them ("$1,200", "250.5"), in cents; null for none typed, and for anything that isn't
 * dollars of zero or more, which the Budget page planned with as none too ("1.2k").
 */
function typedDollars(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.replace(/[$,\s]/g, '') !== '' ? Number(v.replace(/[$,\s]/g, '')) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

/** A kept key's JSON; null for none kept or text that isn't JSON, which the Budget page read as nothing kept. */
function keptJson(v: unknown): unknown {
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v) as unknown
  } catch {
    return null
  }
}

/**
 * The inputs a viewer's own storage held before the plan had its setting (the renderer's debt.skip and debt.inputs
 * keys, as their text): the debts left out, and the take-home, set-aside and lump sum typed in dollars. They fill
 * debt.plan only while nothing has set it, with the order debtPlan has, the debts left out that are still on the books
 * and none typed meaning the run rate, nothing set aside and no lump sum. Each is read as the Budget page read it,
 * so the plan is the one the viewer saw: a key that isn't JSON or a list that isn't one of ids leaves nothing out, and
 * a figure that isn't dollars of zero or more is none, the others arriving all the same. Nothing is written when
 * debt.plan is set already, or when neither key was kept.
 */
export function adoptDebtPlan(saved: { skip?: unknown; inputs?: unknown } | null | undefined): { adopted: boolean } {
  if (db.getSetting(DEBT_PLAN_KEY) !== null) return { adopted: false }
  if (typeof saved?.skip !== 'string' && typeof saved?.inputs !== 'string') return { adopted: false }
  const ids = keptJson(saved.skip)
  const typed = keptJson(saved.inputs)
  const t = typed && typeof typed === 'object' && !Array.isArray(typed) ? (typed as Record<string, unknown>) : {}
  const debts = debtAccounts()
  const leftOut = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && debts.has(id)))] : []
  const plan: DebtPlanInputs = { strategy: debtPlan().strategy, leftOut, takeHomeCents: typedDollars(t.takeHome), setAsideCents: typedDollars(t.setAside) ?? 0, lumpCents: typedDollars(t.lump) ?? 0 }
  db.setSetting(DEBT_PLAN_KEY, JSON.stringify(plan))
  return { adopted: true }
}

// ---------- the plan's inputs ----------

/**
 * What a month would cost at the targets set: the plan's spending with each Everyday category over its target at its
 * target, and One-offs at the one-off budget when over it, in place of their run rates. A target above its run rate
 * saves nothing and spends nothing more, as the over_target lever counts it (spec 1.8). Null when neither is set.
 */
function targetSpend(rates: ReturnType<typeof planRates>): number | null {
  const targets = db.listBudgets()
  let set = false
  let saved = 0
  for (const [key, cents] of rates.everyday) {
    const id = key.slice(4)
    const target = id === 'none' ? undefined : targets.get(Number(id))
    if (target === undefined) continue
    set = true
    saved += Math.max(0, cents - target)
  }
  const oneOffs = oneOffTarget()
  if (oneOffs !== null) {
    set = true
    saved += Math.max(0, rates.oneOffsCents - oneOffs)
  }
  return set ? rates.spendCents - saved : null
}

/**
 * The debt plan's inputs: Personal's debts that owe today, the Take-home run rate in force with where it comes from,
 * and a month's spending the plan can't put toward them, with the same spending in each of the last twelve full
 * months and the lowest and highest of them, and at the targets set; and the plan's own inputs (debt.plan).
 */
export function getDebts(): DebtView {
  const month = db.today().slice(0, 7)
  const rates = planRates(month)
  const spent = rates.months.map((m) => m.cents)
  const plan = debtPlan()
  return {
    debts: personalDebts(rates.payments, () => detectRecurring()),
    takeHomeCents: rates.takeHomeCents,
    incomeSources: rates.sources.map((s) => ({ name: s.name, monthlyCents: s.cents })),
    spendCents: rates.spendCents,
    spendLowCents: spent.length ? Math.min(...spent) : rates.spendCents,
    spendHighCents: spent.length ? Math.max(...spent) : rates.spendCents,
    spendMonths: rates.months,
    strategy: plan.strategy,
    plan,
    month,
    targetSpendCents: targetSpend(rates)
  }
}

/**
 * The debt the plan pays extra on first, from next month as the plan starts (debtPlan.ts targetOf): among the debts
 * it doesn't leave out, by its order, a debt with no rate on file planned at a typical one. Its rate is the one the
 * plan ranks it by, an intro rate while it lasts, with the day that rate ends. Null when the plan owes nothing.
 */
export function nextDebt(): HomePlans['nextDebt'] {
  const plan = debtPlan()
  const debts = personalDebts(new Map())
  const planned = plannedDebts({ debts, plan })
  const start = shiftMonth(db.today().slice(0, 7), 1)
  const k = targetOf(
    planned,
    planned.map((d) => d.balanceCents),
    plan.strategy,
    start
  )
  if (k < 0) return null
  const d = debts.find((x) => x.id === planned[k].id)!
  const promo = d.promoEnds !== null && start < d.promoEnds.slice(0, 7)
  return {
    id: d.id,
    name: d.name,
    aprBp: d.apr === null && !promo ? null : Math.round(rateFor(planned[k], start) * 100),
    promoEnds: promo ? d.promoEnds : null,
    owedCents: d.balanceCents
  }
}
