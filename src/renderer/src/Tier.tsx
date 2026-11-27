import { useState, type ReactNode } from 'react'
import { featureLabel, PLAN_LABELS, TRIAL_DAYS, type FeatureId } from '../../shared/plans'
import type { Page } from './App'
import { useApp } from './App'
import { Icon } from './Icon'
import { PageHeader } from './PageHeader'
import { api, errorMessage, onWeb } from './lib'

// What a locked feature shows on the desktop: one card with the plan in force,
// the feature's name and the one way forward (the trial while it's never been
// started, else the license key in Settings). The main process refuses the
// calls either way; this is what the page draws instead of asking. The web has
// no locked plan: the trial and Plus include everything, and after the trial
// the app is the trial-ended page (web/TrialEnded.tsx).

/** The pages that are Plus features as a whole. */
export const PAGE_FEATURE: Partial<Record<Page, FeatureId>> = { review: 'ai', networth: 'netWorth', goals: 'netWorth', credit: 'netWorth', buckets: 'ventures', benefits: 'benefits', insurance: 'insurance', taxes: 'taxes' }

const FOCUS = 'settings.focus'
/** Opens Settings at its Plan card (call before go('settings')). */
export function focusPlan(): void {
  try {
    sessionStorage.setItem(FOCUS, 'plan')
  } catch {
    /* it just opens at the top */
  }
}
/** Whether Settings is to open at its Plan card (the app starts there, back from Stripe's checkout); asking leaves it. */
export function planFocused(): boolean {
  try {
    return sessionStorage.getItem(FOCUS) === 'plan'
  } catch {
    return false
  }
}
/** Whether Settings was asked to open at its Plan card; asking clears it. */
export function takePlanFocus(): boolean {
  try {
    const on = sessionStorage.getItem(FOCUS) === 'plan'
    sessionStorage.removeItem(FOCUS)
    return on
  } catch {
    return false
  }
}

/** Starts the trial from wherever the button sits; the settings reload moves every lock. */
export function StartTrialButton({ className = 'btn primary' }: { className?: string }): ReactNode {
  const { toast, reloadSettings } = useApp()
  const [busy, setBusy] = useState(false)
  async function start(): Promise<void> {
    setBusy(true)
    try {
      const p = await api.startTrial()
      await reloadSettings()
      toast(`Trial · ${p.trialDaysLeft} days`)
    } catch (e) {
      toast(errorMessage(e), 'error')
      await reloadSettings()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className={className} disabled={busy} onClick={() => void start()}>
      {busy ? 'Starting…' : `Start ${TRIAL_DAYS}-day trial`}
    </button>
  )
}

/** The lock card: the plan, the feature, and the way forward. */
export function PlanLock({ feature, title, compact }: { feature: FeatureId; title?: string; compact?: boolean }): ReactNode {
  const { settings, go } = useApp()
  const plan = settings?.plan
  if (!plan) return null
  const state = plan.plan === 'trial' ? `${PLAN_LABELS.trial} · ${plan.trialDaysLeft} day${plan.trialDaysLeft === 1 ? '' : 's'} left` : PLAN_LABELS[plan.plan]
  return (
    <div className={`card empty tier-lock ${compact ? 'compact' : ''}`}>
      <div className="eyebrow">{state}</div>
      <h2>
        <Icon name="lock" size={compact ? 16 : 22} strokeWidth={1.6} /> {title ?? featureLabel(feature)}
      </h2>
      <div className="empty-actions">
        {!plan.trialStarted && plan.plan === 'free' ? (
          <StartTrialButton />
        ) : (
          <button
            className="btn primary"
            onClick={() => {
              focusPlan()
              go('settings')
            }}
          >
            {onWeb() ? 'Subscribe' : 'Enter license key'}
          </button>
        )}
      </div>
    </div>
  )
}

/** A whole page behind the plan: its header and the one card. */
export function LockedPage({ feature, title }: { feature: FeatureId; title: string }): ReactNode {
  return (
    <>
      <PageHeader title={title} />
      <div className="page">
        <PlanLock feature={feature} />
      </div>
    </>
  )
}
