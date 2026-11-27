import * as db from './db'
import { contributionSummary, hsaLimit } from './contributions'
import { categoryRole } from '../shared/categoryRole'
import { receiptExists } from './receipts'
import type { BenefitKind, BenefitPlan, BenefitsView, CareExpense, CareKind, HsaState, HsaYear } from '../shared/types'

// Employer benefits: each plan's cost and terms (from paystubs and the plans'
// summaries, entered by the assistant), and the HSA, with health spending
// matched against it so eligible care can be paid back from it tax-free.

interface Store {
  employer: string | null
  /** care on or after this day counts for the HSA; by default the first HSA paycheck */
  hsaStart: string | null
  plans: BenefitPlan[]
  done: Record<string, string>
  /** earlier years' HSA contributions, from W-2s (box 12 code W) and statements */
  hsaYears: Array<{ year: number; cents: number; employerCents: number | null; source: string | null }>
}

const KEY = 'benefits'
/** The health category's ids by role (a renamed one still counts as care). */
const healthIds = (): number[] => db.listCategories().filter((c) => categoryRole(c.name) === 'health').map((c) => c.id)
const ORDER: BenefitKind[] = ['medical', 'dental', 'vision', 'life', 'disability', 'other']

function load(): Store {
  const raw = db.getSetting(KEY)
  const s = (raw ? JSON.parse(raw) : {}) as Partial<Store>
  return { employer: s.employer ?? null, hsaStart: s.hsaStart ?? null, plans: s.plans ?? [], done: s.done ?? {}, hsaYears: s.hsaYears ?? [] }
}

function save(s: Store): void {
  db.setSetting(KEY, JSON.stringify(s))
}

const blank = (name: string, kind: BenefitKind): BenefitPlan => ({
  name,
  kind,
  carrier: null,
  network: null,
  coverage: null,
  perCheckCents: null,
  employerPerCheckCents: null,
  taxed: null,
  deductibleCents: null,
  outOfPocketMaxCents: null,
  coinsurancePct: null,
  oonDeductibleCents: null,
  oonOutOfPocketMaxCents: null,
  oonCoinsurancePct: null,
  annualMaxCents: null,
  metCents: null,
  metAsOf: null,
  costs: [],
  free: [],
  phone: null,
  website: null,
  notes: null,
  source: null
})

// Which plan a cost falls under, from where it was paid. Everything else
// (doctors, therapy, labs, hospitals) is medical.
const KINDS: Array<[CareKind, RegExp]> = [
  ['dental', /dent|\bdds\b|orthodon/i],
  ['vision', /eye|optic|optom|lens|vision|zenni|warby/i],
  ['pharmacy', /pharm|cvs|walgreens|drugs?\b|rite ?aid|apothec/i]
]

export function careKind(text: string): CareKind {
  return KINDS.find(([, re]) => re.test(text))?.[0] ?? 'medical'
}

/** The account the HSA contributions go to, or one named like an HSA. */
function hsaAccount(): { id: string; name: string; balanceCents: number | null; startDay: string | null } | null {
  const plan = db.listContributionRows().find((p) => p.kind === 'hsa')
  const accounts = db.listAccounts()
  const a = accounts.find((x) => x.id === plan?.accountId) ?? accounts.find((x) => /health savings|\bhsa\b/i.test(x.name))
  return a ? { id: a.id, name: a.name, balanceCents: a.balanceCents, startDay: plan?.startsDay ?? a.openedDay } : null
}

interface Row {
  id: string
  posted: number
  cents: number
  description: string
  merchant: string | null
  account_id: string
  account: string
  hsa: HsaState | null
  receipt: string | null
}

export function getBenefits(): BenefitsView {
  const store = load()
  const year = Number(db.today().slice(0, 4))
  const account = hsaAccount()
  const startDay = store.hsaStart ?? account?.startDay ?? null
  const health = healthIds()
  // By line, so a split purchase counts only its health parts, flagged or not (the flag is the whole transaction's).
  const rows = db.all<Row>(
    `SELECT t.id, t.posted, SUM(-t.amount_cents) AS cents, t.description, t.merchant, t.account_id, a.name AS account, t.hsa, t.receipt
     FROM ${db.TXN_LINES} t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.pending = 0 AND (${health.length ? `c.id IN (${health.join(',')})` : '0'} OR (t.split_id IS NULL AND t.hsa IN ('eligible', 'reimbursed')))
     GROUP BY t.id ORDER BY t.posted DESC, t.id`
  )

  const status = (r: Row, day: string): CareExpense['status'] => {
    if (r.hsa === 'not') return 'not'
    // Paid with the HSA's own card: nothing to pay back.
    if (r.hsa === 'reimbursed' || r.account_id === account?.id) return 'reimbursed'
    return startDay && day >= startDay ? 'owed' : 'before'
  }
  const found = new Map<string, boolean>()
  const exists = (file: string): boolean => {
    if (!found.has(file)) found.set(file, receiptExists(file))
    return found.get(file)!
  }
  const care: CareExpense[] = rows.map((r) => {
    const day = db.dayKey(r.posted)
    const merchant = r.merchant || r.description
    return {
      id: r.id,
      day,
      cents: r.cents,
      merchant,
      account: r.account,
      kind: careKind(`${merchant} ${r.description}`),
      hsa: r.hsa,
      status: status(r, day),
      receipt: r.receipt,
      receiptFound: r.receipt !== null && exists(r.receipt)
    }
  })

  const thisYear: Record<CareKind, number> = { medical: 0, dental: 0, vision: 0, pharmacy: 0 }
  const lastVisit: BenefitsView['lastVisit'] = {}
  for (const c of care) {
    if (c.day.startsWith(String(year))) thisYear[c.kind] += c.cents
    if (c.cents > 0 && !lastVisit[c.kind]) lastVisit[c.kind] = { day: c.day, merchant: c.merchant }
  }

  const contributions = contributionSummary()
  // The limit covers every HSA plan this year (after a job change there are two) and the employer's
  // money too; the per-check figures come from the one still being paid into.
  const hsaPlans = contributions.plans.filter((p) => p.kind === 'hsa')
  const plan = hsaPlans.find((p) => p.checksLeft > 0) ?? hsaPlans[0]
  const today = db.dayKey(db.now())
  const known = hsaPlans.length > 0 && hsaPlans.every((p) => p.projectedCents !== null)
  const employerSoFar = hsaPlans.reduce((t, p) => {
    if (!p.matchCents || !p.paycheckKey) return t
    const from = [p.startsDay, `${year}-01-01`].filter((d): d is string => !!d).sort().at(-1)!
    return t + p.matchCents * db.paycheckDays(p.paycheckKey, from, p.endsDay && p.endsDay < today ? p.endsDay : today).length
  }, 0)
  const employerAll = employerSoFar + hsaPlans.reduce((t, p) => t + (p.matchCents ?? 0) * p.checksLeft, 0)
  const soFarAll = known ? hsaPlans.reduce((t, p) => t + p.soFarCents!, 0) + employerSoFar : null
  const projectedAll = known ? hsaPlans.reduce((t, p) => t + p.projectedCents!, 0) + employerAll : null
  const hsaLimitNow = hsaLimit(year)
  // Each year's contributions: earlier years as recorded, this year as projected by Dec 31.
  const hsaYears: HsaYear[] = store.hsaYears
    .filter((y) => y.year < year)
    .map((y) => ({ ...y, limitCents: hsaLimit(y.year).cents, limitProvisional: hsaLimit(y.year).provisional, soFarCents: null }))
  if (projectedAll !== null) hsaYears.push({ year, cents: projectedAll, employerCents: employerAll, limitCents: hsaLimitNow.cents, limitProvisional: hsaLimitNow.provisional, soFarCents: soFarAll, source: null })
  hsaYears.sort((a, b) => a.year - b.year)
  const from = startDay ?? `${year}-01-01`
  const shown = care.filter((c) => c.day >= from)
  const sum = (s: CareExpense['status']): number => shown.filter((c) => c.status === s).reduce((t, c) => t + c.cents, 0)
  // Anything paid or to be paid from the HSA needs its record.
  const missing = shown.filter((c) => (c.status === 'owed' || c.status === 'reimbursed') && c.cents > 0 && !c.receiptFound)

  return {
    employer: store.employer,
    year,
    plans: [...store.plans].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)),
    done: store.done,
    hsa: {
      accountId: account?.id ?? null,
      accountName: account?.name ?? null,
      balanceCents: account?.balanceCents ?? null,
      startDay,
      contributedCents: soFarAll,
      projectedCents: projectedAll,
      limitCents: hsaLimitNow.cents,
      limitProvisional: hsaLimitNow.provisional,
      owedCents: sum('owed'),
      reimbursedCents: sum('reimbursed'),
      needReceipts: missing.length,
      needReceiptsCents: missing.reduce((t, c) => t + c.cents, 0),
      paycheck: plan?.employer ?? null,
      perCheckCents: plan ? (plan.nextFrom && plan.nextEmployeeCents !== null && db.dayKey(db.now()) >= plan.nextFrom ? plan.nextEmployeeCents : plan.employeeCents) : null,
      employerPerCheckCents: plan?.matchCents ?? null,
      nextCents: plan?.nextFrom && plan.nextEmployeeCents !== null && db.dayKey(db.now()) < plan.nextFrom ? plan.nextEmployeeCents : null,
      nextFrom: plan?.nextFrom && plan.nextEmployeeCents !== null && db.dayKey(db.now()) < plan.nextFrom ? plan.nextFrom : null,
      checksLeft: plan?.checksLeft ?? 0
    },
    hsaYears,
    thisYear,
    lastVisit,
    care: shown
  }
}

/** Adds or updates a plan by name; fields left out stay as they are. */
export function setBenefitPlan(name: string, patch: Partial<Omit<BenefitPlan, 'name'>>): { plan: BenefitPlan; added: boolean } {
  const n = name.trim()
  if (!n) throw new Error('A plan needs a name')
  const s = load()
  const i = s.plans.findIndex((p) => p.name.toLowerCase() === n.toLowerCase())
  const kind = patch.kind ?? s.plans[i]?.kind
  if (!kind || !ORDER.includes(kind)) throw new Error(`kind must be one of ${ORDER.join(', ')}`)
  const plan: BenefitPlan = { ...blank(n, kind), ...(i >= 0 ? s.plans[i] : {}), ...patch, name: i >= 0 ? s.plans[i].name : n, kind }
  if (i >= 0) s.plans[i] = plan
  else s.plans.push(plan)
  save(s)
  return { plan, added: i < 0 }
}

export function deleteBenefitPlan(name: string): void {
  const s = load()
  const kept = s.plans.filter((p) => p.name.toLowerCase() !== name.trim().toLowerCase())
  if (kept.length === s.plans.length) throw new Error(`No benefit named ${name}`)
  save({ ...s, plans: kept })
}

/** A plan by name as it is (for a journal), or null. */
export const findBenefitPlan = (name: string): BenefitPlan | null => load().plans.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) ?? null

/** The employer and HSA start as stored (for a journal). */
export const benefitSettings = (): { employer: string | null; hsaStart: string | null } => {
  const s = load()
  return { employer: s.employer, hsaStart: s.hsaStart }
}

/** An earlier year's recorded HSA contributions as stored (for a journal), or null. */
export const findHsaYear = (year: number): { cents: number; employerCents: number | null; source: string | null } | null => {
  const y = load().hsaYears.find((x) => x.year === year)
  return y ? { cents: y.cents, employerCents: y.employerCents, source: y.source } : null
}

export function setBenefitSettings(patch: { employer?: string | null; hsaStart?: string | null }): void {
  const s = load()
  if (patch.employer !== undefined) s.employer = patch.employer?.trim() || null
  if (patch.hsaStart !== undefined) {
    if (patch.hsaStart !== null && !/^\d{4}-\d{2}-\d{2}$/.test(patch.hsaStart)) throw new Error('hsa_start must be YYYY-MM-DD')
    s.hsaStart = patch.hsaStart
  }
  save(s)
}

/** Records an earlier year's HSA contributions (yours and the employer's together); null cents removes the year. */
export function setHsaYear(year: number, cents: number | null, employerCents: number | null, source: string | null): void {
  if (!Number.isInteger(year) || year < 2004 || year >= Number(db.today().slice(0, 4))) throw new Error('year must be an earlier year; this year comes from the paychecks')
  const s = load()
  const kept = s.hsaYears.filter((y) => y.year !== year)
  save({ ...s, hsaYears: cents === null ? kept : [...kept, { year, cents, employerCents, source }].sort((a, b) => a.year - b.year) })
}

/** Records when free care (a checkup, a cleaning) was last done; null clears it. */
export function setCareDone(key: string, day: string | null): void {
  if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Use YYYY-MM-DD')
  const s = load()
  if (day === null) delete s.done[key]
  else s.done[key] = day
  save(s)
}
