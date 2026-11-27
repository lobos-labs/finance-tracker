import type { ReactNode } from 'react'
import { LEGAL_LINKS, NOT_ADVICE } from '../../../shared/app'
import { Logo } from '../PageHeader'

// The first step of the first run: the mark and the name, the not-advice line,
// and what the step holds below them (the desktop's folders; the web's 18+ and
// Terms line). Onboarding draws it on the desktop; on the web it comes before
// the app (web/Agree.tsx), since an account's books stay closed until its
// owner confirms (the hosted API contract, "Sign-in and sessions").

export function WelcomeStep({
  appName,
  line,
  ready = true,
  busy = false,
  onContinue,
  secondary,
  children
}: {
  appName: string
  /** one line under the name */
  line?: string
  /** Continue is enabled */
  ready?: boolean
  busy?: boolean
  /** Continue's action; left out, Continue submits the form the step sits in */
  onContinue?: () => void
  /** an action left of Continue */
  secondary?: ReactNode
  children?: ReactNode
}): ReactNode {
  return (
    <>
      <div className="wizard-brand">
        <Logo />
        <span className="wizard-name" id="wizard-title">
          {appName}
        </span>
      </div>
      {line && <p className="wizard-line">{line}</p>}
      <p className="muted small">{NOT_ADVICE}</p>
      {children}
      <div className="wizard-actions">
        {secondary}
        <div className="spacer" />
        <button type={onContinue ? 'button' : 'submit'} className="btn primary" disabled={!ready || busy} onClick={onContinue}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </>
  )
}

/** The one line an account confirms before its books open: 18 or older, the Terms and the Privacy Policy, both linked. */
export function AgreeLine({ checked, onChange, disabled }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }): ReactNode {
  return (
    <label className="check wizard-agree">
      <input type="checkbox" data-focus checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        I'm 18 or older and agree to the{' '}
        <a href={LEGAL_LINKS.terms} target="_blank" rel="noreferrer">
          Terms
        </a>{' '}
        and{' '}
        <a href={LEGAL_LINKS.privacy} target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        .
      </span>
    </label>
  )
}
