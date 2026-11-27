import * as db from './db'
import { AiError, getProvider } from './ai/backend'
import { planState } from './license'
import { AI_BUDGET_MICROS, callCostMicros } from '../shared/aiCost'
import type { Allowance, AiRoute } from '../shared/types'
import type { Plan } from '../shared/plans'

// The included AI's allowance: a budget, not per-feature caps.
// What each call cost is worked out here from the ai_usage table, at the same
// list prices the server meters with (shared/aiCost.ts), over the same window:
// the trial's 14 days, or Plus's UTC calendar month. The server's count is the
// one that's enforced; this one lets a call that would be refused stop before
// anything is sent, and gives Settings its share used. Only the hosted backend
// is budgeted (a hosted ledger's included AI too); the user's own key never is.

/** The period the budget covers at `now`, as unix seconds, or null when the plan has no allowance. */
function windowAt(now: number): { from: number; to: number } | null {
  const p = planState(now)
  if (p.plan === 'trial') {
    const end = Date.parse(p.trialEndsAt ?? '')
    if (!Number.isFinite(end)) return null
    return { from: Math.floor((end - 14 * 86_400_000) / 1000), to: Math.floor(end / 1000) }
  }
  if (p.plan === 'plus') {
    const d = new Date(now)
    return { from: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000), to: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000) }
  }
  return null
}

/** What the window's calls cost and the plan's budget, in micro-dollars. */
export function allowance(now: number = Date.now()): Allowance {
  const plan = planState(now).plan
  const w = windowAt(now)
  const used = w ? db.aiCallsBetween(w.from, w.to).reduce((sum, call) => sum + callCostMicros(call), 0) : 0
  return {
    plan,
    window: w ? { from: new Date(w.from * 1000).toISOString(), to: new Date(w.to * 1000).toISOString() } : null,
    used,
    budget: plan === 'free' ? null : AI_BUDGET_MICROS[plan]
  }
}

/** The refusal once the budget is spent: the trial's for good, Plus's until the 1st (the day in the ledger's zone). */
export function allowanceUsed(plan: Plan, resetsAt: string | null): AiError {
  if (plan === 'trial') return new AiError('quota', 'The trial\'s AI allowance is used up.')
  const t = resetsAt ? Date.parse(resetsAt) : NaN
  const resets = Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: db.zone() }) : ''
  return new AiError('quota', `This month's AI allowance is used up${resets ? ` · resets ${resets}` : ''}.`)
}

/** Refuses a hosted call once the budget is spent, as the server would (an AiError the caller shows). */
export function checkAllowance(_route: AiRoute, now: number = Date.now()): void {
  if (getProvider() !== 'proxy') return
  const a = allowance(now)
  if (a.budget === null || a.used < a.budget) return
  throw allowanceUsed(a.plan, a.window?.to ?? null)
}
