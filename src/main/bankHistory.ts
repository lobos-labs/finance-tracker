import * as db from './db'
import type { RecurringKind } from '../shared/types'

// Whether a bank's history is still arriving. Plaid's first pull after a link
// is the last few weeks; the rest (up to two years) comes later, and until it
// does a monthly bill has been seen once at most, too few for recurring
// detection. A hosted Ledger's sync (finance-server src/ledger/sync.ts) keeps
// this on from a new bank's first pull until Plaid says every bank's history
// is in; meanwhile applyPage (bankPage.ts) notes the recent rows Plaid called
// bills, and Spendable counts a bill seen once as coming again (spendable.ts).
// Two settings, so no schema of its own; the desktop never sets them.

const PENDING = 'bank.historyPending'
const BILLS = 'bank.plaidBills'

/** How far back a bill seen once is looked for: Plaid's first pull is about the last 30 days. */
export const RECENT_DAYS = 35

export const historyPending = (): boolean => db.getSetting(PENDING) !== null

/** On while a bank's history is arriving; off forgets the bills it noted. */
export function setHistoryPending(on: boolean): void {
  if (on === historyPending()) return
  db.setSetting(PENDING, on ? '1' : null)
  if (!on) db.setSetting(BILLS, null)
}

/** The recent rows Plaid called bills, by transaction id, while the history arrives. */
export function plaidBills(): Map<string, RecurringKind> {
  try {
    const v = JSON.parse(db.getSetting(BILLS) ?? '{}') as unknown
    return new Map(v && typeof v === 'object' ? Object.entries(v as Record<string, RecurringKind>) : [])
  } catch {
    return new Map()
  }
}

/** Notes more of them (applyPage, within its transaction). */
export function notePlaidBills(found: Map<string, RecurringKind>): void {
  if (!found.size) return
  const all = plaidBills()
  for (const [id, kind] of found) all.set(id, kind)
  db.setSetting(BILLS, JSON.stringify(Object.fromEntries(all)))
}
