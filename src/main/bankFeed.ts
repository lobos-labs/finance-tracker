import * as bank from './bank'
import { devBuild } from './devBuild'
import { openEdition } from './license'
import * as simplefin from './simplefin'
import { scheduleCheck } from './snapshots'
import type { SyncResult } from '../shared/types'

// The bank data the app syncs: Plaid, through our server. SimpleFIN is gone
// from the paid product; a development build connects and syncs it, and so
// does the open edition (build.ts), which has no server for Plaid. No other
// build offers it.

/** SimpleFIN can be connected: a development build, or the open edition. */
export const simplefinOffered = (): boolean => devBuild() || openEdition()

export const simplefinKept = (): boolean => simplefinOffered() && simplefin.isConnected()

export const connected = (): boolean => bank.isConnected() || simplefinKept()

export function lastSyncAt(): number | null {
  const times = [bank.lastSyncAt(), simplefinKept() ? simplefin.lastSyncAt() : null].filter((t): t is number => t !== null)
  return times.length ? Math.max(...times) : null
}

/** A first SimpleFIN history pull still under way (Plaid fetches history on its own). */
export const historyPending = (): boolean => simplefinKept() && simplefin.deepPullPending()

export function warnings(): string[] {
  return [...bank.lastWarnings(), ...(simplefinKept() ? simplefin.lastWarnings() : [])]
}

/** Syncs every connected source; the counts added together. A sync can bring a late line or a new amount into a closed month, so the closed months are checked a moment after. */
export async function sync(): Promise<SyncResult> {
  const results: SyncResult[] = []
  try {
    if (bank.isConnected()) results.push(await bank.sync())
    if (simplefinKept()) results.push(await simplefin.sync())
  } finally {
    scheduleCheck()
  }
  return results.reduce<SyncResult>(
    (t, r) => ({ ...t, accounts: t.accounts + r.accounts, added: t.added + r.added, updated: t.updated + r.updated, warnings: [...t.warnings, ...r.warnings], historyFrom: r.historyFrom ?? t.historyFrom, historyComplete: r.historyComplete ?? t.historyComplete }),
    { accounts: 0, added: 0, updated: 0, warnings: [] }
  )
}
