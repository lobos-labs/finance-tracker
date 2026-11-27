import * as db from './db'
import { getBenefits } from './benefits'
import { fileFound } from './files'
import { blankPolicy as blank, loadPolicies as load, savePolicies as save } from './policies'
import { detectRecurring } from './recurring'
import { isLocalDocument } from './receipts'
import { INSURANCE_KINDS, type InsuranceKind, type InsurancePolicy, type InsuranceView, type PremiumPeriod } from '../shared/types'
import { addMonths } from '../shared/zone'

// Insurance and protection plans held outside work: each policy as entered by the
// assistant (from declarations pages, contracts, bills) or on the page. What was
// paid comes from the transactions that match the policy's text, renewals roll
// forward on their own, and work plans come from the Benefits page. The policies
// are stored by policies.ts.

const PERIODS: PremiumPeriod[] = ['month', 'quarter', 'half-year', 'year', 'one-time']
const PER_YEAR: Record<PremiumPeriod, number | null> = { month: 12, quarter: 4, 'half-year': 2, year: 1, 'one-time': null }

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Adds a policy, or updates one found by id (or by name); fields left out stay as they are. */
export function savePolicy(patch: Partial<InsurancePolicy> & { name?: string; kind?: InsuranceKind }): InsurancePolicy {
  const policies = load()
  const i = patch.id ? policies.findIndex((p) => p.id === patch.id) : policies.findIndex((p) => p.name.toLowerCase() === (patch.name ?? '').trim().toLowerCase())
  if (patch.id && i < 0) throw new Error(`No policy ${patch.id}`)
  const name = (patch.name ?? (i >= 0 ? policies[i].name : '')).trim()
  if (!name) throw new Error('A policy needs a name')
  const kind = patch.kind ?? (i >= 0 ? policies[i].kind : undefined)
  if (!kind || !INSURANCE_KINDS.includes(kind)) throw new Error(`Kind must be one of ${INSURANCE_KINDS.join(', ')}`)
  for (const d of [patch.startDay, patch.renewalDay, patch.endDay]) if (d && !DAY.test(d)) throw new Error('Dates are YYYY-MM-DD')
  if (patch.premiumPeriod && !PERIODS.includes(patch.premiumPeriod)) throw new Error(`Premium period must be one of ${PERIODS.join(', ')}`)
  if (patch.status && patch.status !== 'active' && patch.status !== 'ended') throw new Error('Status is active or ended')
  for (const c of [patch.premiumCents, patch.deductibleCents]) if (c !== undefined && c !== null && (!Number.isInteger(c) || c < 0)) throw new Error('Amounts must be positive')
  if (patch.termMonths !== undefined && patch.termMonths !== null && (!Number.isInteger(patch.termMonths) || patch.termMonths < 1 || patch.termMonths > 120)) throw new Error('The term is 1 to 120 months')
  for (const f of patch.files ?? []) if (!isLocalDocument(f.file)) throw new Error(`Not a document on this computer: ${f.file}`)
  const base = i >= 0 ? policies[i] : blank(name, kind)
  const p: InsurancePolicy = {
    ...base,
    ...patch,
    id: base.id,
    name,
    kind,
    // A policy is always active or ended: no status leaves it as it was.
    status: patch.status || base.status,
    match: patch.match === undefined ? base.match : patch.match?.trim().toLowerCase() || null
  }
  if (i >= 0) policies[i] = p
  else policies.push(p)
  save(policies)
  return p
}

export function deletePolicy(idOrName: string): InsurancePolicy {
  const policies = load()
  const p = policies.find((x) => x.id === idOrName) ?? policies.find((x) => x.name.toLowerCase() === idOrName.trim().toLowerCase())
  if (!p) throw new Error(`No policy ${idOrName}`)
  save(policies.filter((x) => x !== p))
  return p
}

/** Puts a policy back exactly as a journal recorded it, under its old id (an undo). */
export function restorePolicy(p: InsurancePolicy): void {
  const policies = load().filter((x) => x.id !== p.id)
  policies.push({ ...blank(p.name, p.kind), ...p })
  save(policies)
}

/** A policy by id or name as it is (for a journal), or null. */
export function findPolicy(idOrName: string): InsurancePolicy | null {
  const policies = load()
  return policies.find((x) => x.id === idOrName) ?? policies.find((x) => x.name.toLowerCase() === idOrName.trim().toLowerCase()) ?? null
}

export function listPolicies(): InsurancePolicy[] {
  return load()
}

/** Every policy document path on file. */
export const insuranceFilePaths = (): string[] => load().flatMap((p) => p.files.map((f) => f.file))

/** Whether a path is one of the policy documents on file, so only those can be opened from the page. */
export function isInsuranceFile(file: string): boolean {
  return load().some((p) => p.files.some((f) => f.file === file))
}

/**
 * Renewals from `from` through `to`: the known renewal, then every term after it, each counted from the
 * known date (so a renewal on the 31st comes back to the 31st after a short month). None on or after
 * the day the policy ends, since it doesn't renew then.
 */
export function renewals(p: InsurancePolicy, from: string, to: string, limit = 60): string[] {
  if (p.status === 'ended' || !p.renewalDay) return []
  const out: string[] = []
  for (let k = 0; k < 2400 && out.length < limit; k++) {
    const d = k === 0 ? p.renewalDay : addMonths(p.renewalDay, k * (p.termMonths ?? 0))
    if (d > to || (p.endDay && d >= p.endDay)) break
    if (d >= from) out.push(d)
    if (!p.termMonths) break
  }
  return out
}

/** The renewal on or after today. */
export const nextRenewal = (p: InsurancePolicy, today: string): string | null => renewals(p, today, '9999-12-31', 1)[0] ?? null

const CHECKS_PER_YEAR: Record<string, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }
const likeText = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export function getInsurance(): InsuranceView {
  const today = db.dayKey(db.now())
  const yearAgo = db.now() - 365 * 86_400
  const all = load()

  // Payments: charges whose description matches a policy's text, in accounts counted in totals. When two
  // policies' texts both match a charge (two policies with one insurer), it goes to the one whose dates it falls
  // in, then to the longer text, so no charge counts twice.
  type Paid = { id: string; posted: number; cents: number }
  const found = new Map<string, Paid[]>()
  const owner = new Map<string, { policy: string; score: number }>()
  for (const p of all) {
    if (!p.match) continue
    const rows = db.all<Paid>(
      `SELECT t.id, t.posted, -t.amount_cents AS cents ${db.VISIBLE_TXN_FROM}
       WHERE t.pending = 0 AND t.amount_cents < 0 AND (c.kind IS NULL OR c.kind != 'transfer')
         AND (LOWER(t.description) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.merchant, '')) LIKE ? ESCAPE '\\')
       ORDER BY t.posted DESC LIMIT 400`,
      likeText(p.match),
      likeText(p.match)
    )
    found.set(p.id, rows)
    for (const r of rows) {
      const day = db.dayKey(r.posted)
      const score = ((!p.startDay || day >= p.startDay) && (!p.endDay || day <= p.endDay) ? 1000 : 0) + p.match.length
      const o = owner.get(r.id)
      if (!o || score > o.score) owner.set(r.id, { policy: p.id, score })
    }
  }

  const policies = all.map((p) => {
    const paid = (found.get(p.id) ?? []).filter((r) => owner.get(r.id)?.policy === p.id)
    const paidLastYearCents = paid.filter((r) => r.posted >= yearAgo).reduce((t, r) => t + r.cents, 0)
    const per = p.premiumPeriod ? PER_YEAR[p.premiumPeriod] : null
    // A year's cost: the premium at its period; without a premium, what was paid in the last year. A one-time price isn't yearly.
    const yearlyCents = p.status === 'ended' ? null : p.premiumCents !== null ? (per ? p.premiumCents * per : null) : paidLastYearCents || null
    return { ...p, nextRenewal: nextRenewal(p, today), yearlyCents, paidLastYearCents, lastPaid: paid[0] ? { day: db.dayKey(paid[0].posted), cents: paid[0].cents } : null }
  })
  policies.sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || INSURANCE_KINDS.indexOf(a.kind) - INSURANCE_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name))

  // Work insurance: what each plan costs per check, and a year at the employer's pay schedule.
  const benefits = getBenefits()
  const employer = benefits.employer
  const payday = employer ? detectRecurring().find((s) => s.kind === 'income' && s.name.toLowerCase().includes(employer.toLowerCase()) && !s.dismissed) : undefined
  const checks = payday ? (CHECKS_PER_YEAR[payday.cadence] ?? null) : null
  // Insurance only: retirement, stock and time-off plans stay on the Benefits page.
  const plans = benefits.plans
    .filter((p) => p.kind !== 'other')
    .map((p) => ({
      name: p.name,
      kind: p.kind,
      carrier: p.carrier,
      perCheckCents: p.perCheckCents,
      employerPerCheckCents: p.employerPerCheckCents,
      yearlyCents: p.perCheckCents !== null && checks ? p.perCheckCents * checks : null
    }))

  const onDisk: Record<string, boolean> = {}
  for (const p of policies) for (const f of p.files) if (!(f.file in onDisk)) onDisk[f.file] = fileFound(f.file)
  const active = policies.filter((p) => p.status === 'active')
  const upcoming = active.filter((p) => p.nextRenewal).sort((a, b) => a.nextRenewal!.localeCompare(b.nextRenewal!))[0]
  return {
    policies,
    employer: { name: employer, plans },
    fileFound: onDisk,
    totals: {
      yearlyCents: active.reduce((t, p) => t + (p.yearlyCents ?? 0), 0) + plans.reduce((t, p) => t + (p.yearlyCents ?? 0), 0),
      active: active.length,
      nextRenewal: upcoming ? { name: upcoming.name, day: upcoming.nextRenewal! } : null
    }
  }
}
