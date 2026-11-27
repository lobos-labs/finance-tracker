import type { Cadence } from './types'
import { addDays, addMonths, dayFrom } from './zone'

// The days a recurring series falls on, from YYYY-MM-DD days (calendar
// arithmetic, the same in any time zone).

export { addDays }

/** A cadence as the pages name it. */
export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Yearly'
}

/** A Date's local day as YYYY-MM-DD. */
export const dayOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Occurrence dates of a series from its next expected date through `to`. */
export function occurrences(first: string, cadence: Cadence, to: string): string[] {
  const out: string[] = []
  if (cadence === 'semimonthly') {
    // Paydays like the 1st and 16th, or the 15th and the end of the month.
    let d = first
    while (d <= to && out.length < 60) {
      out.push(d)
      const [y, m, day] = d.split('-').map(Number)
      d = day <= 15 ? addDays(d, 15) : dayFrom(y, m + 1, Math.max(1, day - 15))
    }
    return out
  }
  for (let n = 0; out.length < 400; n++) {
    const d =
      cadence === 'weekly' ? addDays(first, 7 * n)
      : cadence === 'biweekly' ? addDays(first, 14 * n)
      : addMonths(first, n * (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12))
    if (d > to) break
    out.push(d)
  }
  return out
}
