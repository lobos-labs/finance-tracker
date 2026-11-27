import type { Api } from '../../shared/types'

// The debt plan's inputs live in the debt.plan setting, which Review keeps (waterfall spec 7); before that, each
// viewer kept them in its own storage. What a viewer kept is sent once, to fill the setting while nothing has set it,
// and then cleared. And Net worth's Debts opening at its payoff plan.

/** The keys a viewer kept the plan's inputs under: the debts left out, and the take-home, set-aside and lump sum typed in dollars. */
export const KEPT = { skip: 'debt.skip', inputs: 'debt.inputs' } as const

/**
 * Sends the plan's inputs this viewer kept, as they were stored, and clears them once answered, whether they filled
 * debt.plan or not (it takes them only while nothing has set it). With none kept nothing is sent; a call that fails
 * keeps them for the next time the app opens.
 */
export async function sendDebtPlan(api: Pick<Api, 'adoptDebtPlan'>): Promise<void> {
  let saved: { skip: string | null; inputs: string | null }
  try {
    saved = { skip: localStorage.getItem(KEPT.skip), inputs: localStorage.getItem(KEPT.inputs) }
  } catch {
    return
  }
  if (saved.skip === null && saved.inputs === null) return
  try {
    await api.adoptDebtPlan(saved)
  } catch {
    return
  }
  try {
    localStorage.removeItem(KEPT.skip)
    localStorage.removeItem(KEPT.inputs)
  } catch {
    /* nothing left to clear */
  }
}

const FOCUS = 'debts.focus'
/** Opens Net worth's Debts at its payoff plan (call before going there). */
export function focusPayoff(): void {
  try {
    sessionStorage.setItem(FOCUS, 'payoff')
  } catch {
    /* it just opens at the top */
  }
}
/** Whether Debts was asked to open at its payoff plan; asking clears it. */
export function takePayoffFocus(): boolean {
  try {
    const on = sessionStorage.getItem(FOCUS) === 'payoff'
    sessionStorage.removeItem(FOCUS)
    return on
  } catch {
    return false
  }
}
