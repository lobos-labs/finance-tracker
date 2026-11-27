import { randomUUID } from 'node:crypto'
import * as db from './db'
import type { InsuranceKind, InsurancePolicy } from '../shared/types'

// The policies the user holds outside work, as they're stored (the 'insurance' setting). insurance.ts builds the
// Insurance page from them; the classifier (lines.ts) reads their match texts to put a home's or a car's
// insurance on it. They live here so the classifier needn't import insurance.ts, which reads the benefits and
// the recurring series in turn.

const KEY = 'insurance'

/** A new policy with nothing but its name and kind. */
export const blankPolicy = (name: string, kind: InsuranceKind): InsurancePolicy => ({
  id: randomUUID(),
  name,
  kind,
  carrier: null,
  policyNumber: null,
  covers: null,
  status: 'active',
  startDay: null,
  renewalDay: null,
  termMonths: null,
  endDay: null,
  premiumCents: null,
  premiumPeriod: null,
  match: null,
  deductibleCents: null,
  coverage: [],
  phone: null,
  claimsPhone: null,
  website: null,
  files: [],
  notes: null,
  source: null
})

/** Every policy as stored, with any field an older one lacks filled in. */
export function loadPolicies(): InsurancePolicy[] {
  const raw = db.getSetting(KEY)
  const s = (raw ? JSON.parse(raw) : {}) as { policies?: InsurancePolicy[] }
  return (s.policies ?? []).map((p) => ({ ...blankPolicy(p.name, p.kind), ...p }))
}

export function savePolicies(policies: InsurancePolicy[]): void {
  db.setSetting(KEY, JSON.stringify({ policies }))
}
