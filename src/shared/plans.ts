// Plans, the features each unlocks, the trial and the AI allowances: pure data
// and pure functions. The main process enforces them (src/main/license.ts,
// which also holds the license token) and the renderer reads the same table
// for its locks, so the two can't drift. There is one paid plan, Plus, after
// a 14-day trial that the server starts when an account first agrees to the
// Terms (there is no free tier). `free` is the id of no plan at
// all: the trial ended and nobody has paid. A hosted account there sees only
// the trial-ended page (Subscribe, its export, Delete account); its books
// answer 403 trial_over otherwise. The features below still lock on the
// desktop, which reads the same table. The phone and the desktop's relay
// pairing (Settings → Devices) are no plan feature.

export type Plan = 'free' | 'trial' | 'plus'

export const PLAN_LABELS: Record<Plan, string> = { free: 'Trial ended', trial: 'Trial', plus: 'Plus' }

export type FeatureId = 'ai' | 'netWorth' | 'moneyFlow' | 'multiBank' | 'ventures' | 'investmentReturns' | 'taxes' | 'benefits' | 'insurance' | 'credit' | 'documents' | 'liveValues' | 'googleSync' | 'includedAi' | 'partner' | 'mcp'

export interface Feature {
  id: FeatureId
  label: string
  /** the lowest plan that includes it; a trial counts as plus */
  plan: 'free' | 'plus'
  /** the feature's name in an entitlement token (the server's wire format) */
  wire: string
}

export const FEATURES: Feature[] = [
  { id: 'ai', label: 'AI: categorizing, the headline and Review', plan: 'plus', wire: 'ai' },
  { id: 'netWorth', label: 'Net worth, investments and goals', plan: 'plus', wire: 'net_worth' },
  { id: 'moneyFlow', label: 'Money flow', plan: 'plus', wire: 'money_flow' },
  { id: 'multiBank', label: 'More than one bank', plan: 'plus', wire: 'multi_bank' },
  { id: 'ventures', label: 'Ventures', plan: 'plus', wire: 'ventures' },
  { id: 'investmentReturns', label: 'Investment returns', plan: 'plus', wire: 'investment_returns' },
  { id: 'taxes', label: 'Taxes', plan: 'plus', wire: 'taxes' },
  { id: 'benefits', label: 'Benefits & HSA', plan: 'plus', wire: 'benefits_hsa' },
  { id: 'insurance', label: 'Insurance', plan: 'plus', wire: 'insurance' },
  { id: 'credit', label: 'Credit reports', plan: 'plus', wire: 'credit' },
  { id: 'documents', label: 'Documents read by the AI', plan: 'plus', wire: 'documents' },
  { id: 'liveValues', label: 'Live house and vehicle values', plan: 'plus', wire: 'live_values' },
  { id: 'googleSync', label: 'Google Calendar and Tasks sync', plan: 'plus', wire: 'google_sync' },
  { id: 'includedAi', label: 'Included AI allowance', plan: 'plus', wire: 'ai_allowance' },
  // A second person with their own sign-in on the same books (the hosted ledger's household).
  { id: 'partner', label: 'A partner on your books', plan: 'plus', wire: 'partner' },
  { id: 'mcp', label: 'Connected AI apps', plan: 'plus', wire: 'mcp' }
]

export const featureLabel = (id: FeatureId): string => FEATURES.find((f) => f.id === id)?.label ?? id

export const TRIAL_DAYS = 14

/** Plus: $99 a year, or $12.99 a month. */
export const PRICES = { plusYearCents: 9900, plusMonthCents: 1299 }

/** The settings rows the plan is read from (ISO timestamps). */
export interface PlanSettings {
  trialStartedAt?: string | null
  plusUntil?: string | null
}

export interface PlanState {
  plan: Plan
  /** whole days of trial left (0 once it has ended or never started) */
  trialDaysLeft: number
  trialEndsAt: string | null
}

const DAY = 86_400_000

const parse = (s: string | null | undefined): number | null => {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** Whole days from `t` to an end time, capped at the trial length (0 once it has passed). */
export const daysLeft = (endsAt: number | null, t: number): number => (endsAt === null ? 0 : Math.min(TRIAL_DAYS, Math.max(0, Math.ceil((endsAt - t) / DAY))))

/** The plan in force at `now` by the local settings alone: Plus while paid for, else the trial while it has days left, else free. */
export function planState(s: PlanSettings, now: number | Date = Date.now()): PlanState {
  const t = typeof now === 'number' ? now : now.getTime()
  const started = parse(s.trialStartedAt)
  const trialEnd = started === null ? null : started + TRIAL_DAYS * DAY
  const trialDaysLeft = daysLeft(trialEnd, t)
  const plusUntil = parse(s.plusUntil)
  const plan: Plan = plusUntil !== null && plusUntil > t ? 'plus' : trialDaysLeft > 0 ? 'trial' : 'free'
  return { plan, trialDaysLeft, trialEndsAt: trialEnd === null ? null : new Date(trialEnd).toISOString() }
}

/** When a beta whose last day is `until` (YYYY-MM-DD) ends: the local midnight after that day; null for no beta or a malformed day. */
export function betaEndsAt(until: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until ?? '')
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(y, mo - 1, d)
  if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return null
  return new Date(y, mo - 1, d + 1).getTime()
}

export const hasFeature = (plan: Plan, id: FeatureId): boolean => plan !== 'free' || FEATURES.find((f) => f.id === id)?.plan === 'free'

