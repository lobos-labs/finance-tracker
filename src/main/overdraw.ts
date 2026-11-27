import * as db from './db'
import { addDays } from '../shared/zone'
import type { Spendable, SpendItem } from '../shared/types'
import type { Alert, AlertFacts } from './alerts'

// Overdraw tomorrow (the hosted ledger's evening alert, ledgerAlerts.ts): the
// night before a bill would take Spendable's main account under zero, or
// under the cushion, the bills that do it, where they leave it, and one move
// picked here: money from another cash account that can spare it, else asking
// a subscription or a utility to move its date, else nothing. The UK's
// regulator found an alert just before the charge cut overdraft charges by
// about a quarter; an early, general warning didn't.
//
// The shortfall alert (before payday) and this one don't both go out to a
// member on one day: what went out to each member today, and their DONE
// reply, are kept here (lowDays, a partner's beside the owner's).

/** A move is whole tens of dollars, at least the gap. */
const MOVE_STEP = 1000
const LOW_DAYS = 'alerts.lowDays'

export type OverdrawMove = NonNullable<AlertFacts['move']>

export interface Overdraw {
  accountId: string
  account: string
  /** tomorrow, YYYY-MM-DD */
  day: string
  /** the bills going out that day, largest first */
  bills: Array<{ name: string; cents: number }>
  /** the balance they leave (signed) */
  lowCents: number
  /** the line it falls under: the cushion, or zero */
  floorCents: number
  move: OverdrawMove | null
}

/**
 * Tomorrow on Spendable's main account, at the account's risk: its bills (not the everyday trips forecast
 * beside them) taking it under `cushionCents` (null: Spendable's cushion, zero without one). `askable` says
 * which bills could be asked to move their date (a subscription or a utility).
 */
export function overdrawTomorrow(sp: Spendable, today: string, o: { cushionCents: number | null; askable: (item: SpendItem) => boolean }): Overdraw | null {
  const a = sp.accounts.find((x) => x.id === sp.accountId)
  const day = addDays(today, 1)
  const d = a?.days.find((x) => x.day === day)
  if (!a || !d) return null
  const floor = o.cushionCents ?? sp.cushionCents
  if (d.lowCents >= floor) return null
  const out = sp.items.filter((i) => i.accountId === a.id && i.day === day && i.cents < 0 && !i.everyday).sort((x, y) => x.cents - y.cents || x.name.localeCompare(y.name))
  if (!out.length) return null
  // Another cash account that can spare the gap and keep its own forecast above the cushion; the roomiest.
  const cents = Math.ceil((floor - d.lowCents) / MOVE_STEP) * MOVE_STEP
  const from = sp.accounts.filter((x) => x.id !== a.id && x.spendableCents >= cents).sort((x, y) => y.spendableCents - x.spendableCents)[0]
  const ask = out.find(o.askable)
  return {
    accountId: a.id,
    account: a.name,
    day,
    bills: out.map((i) => ({ name: i.name, cents: i.cents })),
    lowCents: d.lowCents,
    floorCents: floor,
    move: from ? { kind: 'transfer', from: from.name, cents } : ask ? { kind: 'ask', name: ask.name } : null
  }
}

/** The alert: once per account and day (its key). */
export const overdrawAlert = (o: Overdraw): Alert => ({
  key: `overdraw:${o.accountId}:${o.day}`,
  kind: 'overdraw',
  title: 'Overdraw tomorrow',
  body: o.account,
  target: { page: 'dashboard' },
  facts: { account: o.account, day: o.day, bills: o.bills, lowCents: o.lowCents, floorCents: o.floorCents, ...(o.move ? { move: o.move } : {}) }
})

// ---------- one low-balance alert a day ----------

/** The last day (the ledger's) a shortfall or an overdraw alert went out, and the day a DONE reply quieted them. */
export interface LowDays {
  shortfall?: string
  overdraw?: string
  done?: string
}

/** Each member keeps their own (a partner's carries their id; the owner's is the key itself). */
export const lowDaysKey = (member?: string | null): string => (member ? `${LOW_DAYS}:${member}` : LOW_DAYS)

export function lowDays(member?: string | null): LowDays {
  try {
    const v = JSON.parse(db.getSetting(lowDaysKey(member)) ?? '{}') as Record<string, unknown>
    const day = (x: unknown): string | undefined => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined)
    return { shortfall: day(v['shortfall']), overdraw: day(v['overdraw']), done: day(v['done']) }
  } catch {
    return {}
  }
}

/** Sets some of a member's days; null clears one. */
export function setLowDays(patch: { [K in keyof LowDays]?: string | null }, member?: string | null): void {
  const cur: Record<string, string | undefined> = { ...lowDays(member) }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) cur[k] = v ?? undefined
  db.setSetting(lowDaysKey(member), JSON.stringify(cur))
}
