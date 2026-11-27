import type { ReactNode } from 'react'
import type { PlanInfo } from '../../../shared/types'

// The web app's plan and billing card is not in this edition. Settings shows it
// only on the web (onWeb()), so the desktop never renders it.

export function HostedPlan(_props: { plan: PlanInfo }): ReactNode {
  return null
}
