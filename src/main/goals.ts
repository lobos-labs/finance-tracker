import * as db from './db'
import { GOAL_ACCOUNT_TYPES, type Account, type Goal, type GoalContribution, type GoalFunding, type GoalInput, type GoalStatus, type GoalView } from '../shared/types'
import { addDays, daysBetween, isRealDay } from '../shared/zone'

// Savings goals: a name, a target, an optional date, and what funds it. A goal
// funded by accounts counts their combined balance, less the balance on its
// start day when it counts only what's saved since; a manual one adds up its
// log of contributions. The progress, what's still needed a month to make the
// date and whether the recent pace covers it are worked out here, for the
// Goals page, Home's Saved drill, the review's tools and the phone.

const NAME_MAX = 80
/** The pace is what was saved over this many days, a month at a time. */
export const PACE_DAYS = 90
const MONTH_DAYS = 30.44

const today = (): string => db.today()

function checkDay(v: unknown, what: string): string {
  const s = String(v ?? '').trim()
  if (!isRealDay(s)) throw new Error(`${what} must be a date like 2027-06-01`)
  return s
}

// ---------- the math ----------

/** Whole months from `from` to `to`, at least 1: a date later this month still leaves one to save in. */
export function monthsUntil(from: string, to: string): number {
  const [y, m, d] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.max(1, (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0))
}

export type Progress = Pick<GoalView, 'savedCents' | 'remainingCents' | 'pct' | 'monthsLeft' | 'monthlyNeededCents' | 'paceCents' | 'status'>

/** Progress toward a target from what's saved (never below zero) and the pace a month, as of `on`. */
export function progress(x: { targetCents: number; targetDay: string | null; savedCents: number; paceCents: number }, on: string): Progress {
  const saved = Math.max(0, x.savedCents)
  const remaining = Math.max(0, x.targetCents - saved)
  const base = { savedCents: saved, remainingCents: remaining, pct: x.targetCents > 0 ? saved / x.targetCents : 0, paceCents: x.paceCents }
  const upcoming = x.targetDay !== null && x.targetDay >= on
  const monthsLeft = upcoming ? monthsUntil(on, x.targetDay!) : null
  let status: GoalStatus
  let needed: number | null
  if (remaining === 0) {
    status = 'done'
    needed = x.targetDay === null ? null : 0
  } else if (x.targetDay === null) {
    status = 'open'
    needed = null
  } else if (!upcoming) {
    // The date went by short: all of what's left is due now.
    status = 'past_due'
    needed = remaining
  } else {
    needed = Math.ceil(remaining / monthsLeft!)
    status = x.paceCents >= needed ? 'on_track' : 'behind'
  }
  return { ...base, monthsLeft, monthlyNeededCents: needed, status }
}

/** A manual goal's pace: contributions over the last PACE_DAYS, a month at a time, or since it began when that's sooner (a month at least). */
export function contributionPace(contributions: Array<Pick<GoalContribution, 'day' | 'cents'>>, begun: string, on: string): number {
  const since = addDays(on, -PACE_DAYS)
  const recent = contributions.filter((c) => c.day > since && c.day <= on).reduce((t, c) => t + c.cents, 0)
  const first = [begun, ...contributions.map((c) => c.day)].sort()[0]
  const months = Math.min(PACE_DAYS / MONTH_DAYS, Math.max(1, daysBetween(first, on) / MONTH_DAYS))
  return Math.round(recent / months)
}

/** Linked accounts' pace: how their combined balance moved over the last PACE_DAYS, a month at a time. */
export const balancePace = (nowCents: number, agoCents: number): number => Math.round((nowCents - agoCents) / (PACE_DAYS / MONTH_DAYS))

// ---------- the records ----------

interface GoalRow {
  id: number
  name: string
  target_cents: number
  target_day: string | null
  funding: GoalFunding
  start_cents: number | null
  start_day: string | null
  created_at: number
  archived_at: number | null
}

function links(): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const r of db.all<{ goal_id: number; account_id: string }>('SELECT goal_id, account_id FROM goal_accounts ORDER BY rowid')) out.set(r.goal_id, [...(out.get(r.goal_id) ?? []), r.account_id])
  return out
}

const toGoal = (r: GoalRow, accountIds: string[]): Goal => ({
  id: r.id,
  name: r.name,
  targetCents: r.target_cents,
  targetDay: r.target_day,
  funding: r.funding,
  accountIds,
  startCents: r.start_cents,
  startDay: r.start_day,
  createdAt: r.created_at,
  archivedAt: r.archived_at
})

/** Every goal: the open ones first, oldest first. */
export function listGoals(): Goal[] {
  const l = links()
  return db.all<GoalRow>('SELECT * FROM goals ORDER BY archived_at IS NOT NULL, created_at, id').map((r) => toGoal(r, l.get(r.id) ?? []))
}

export function getGoal(id: number): Goal | null {
  const r = db.get<GoalRow>('SELECT * FROM goals WHERE id = ?', id)
  return r ? toGoal(r, db.all<{ account_id: string }>('SELECT account_id FROM goal_accounts WHERE goal_id = ? ORDER BY rowid', id).map((x) => x.account_id)) : null
}

/** A goal by its id, or by its name (any case). */
export function findGoal(ref: unknown): Goal | null {
  const n = typeof ref === 'number' ? ref : /^\d+$/.test(String(ref ?? '').trim()) ? Number(String(ref).trim()) : null
  const byId = n !== null ? getGoal(n) : null
  if (byId) return byId
  const name = String(ref ?? '').trim().toLowerCase()
  return name ? (listGoals().find((g) => g.name.toLowerCase() === name) ?? null) : null
}

export function listContributions(goalId?: number): GoalContribution[] {
  const rows = db.all<{ id: number; goal_id: number; day: string; cents: number; note: string | null }>(
    `SELECT id, goal_id, day, cents, note FROM goal_contributions ${goalId === undefined ? '' : 'WHERE goal_id = ?'} ORDER BY day DESC, id DESC`,
    ...(goalId === undefined ? [] : [goalId])
  )
  return rows.map((r) => ({ id: r.id, goalId: r.goal_id, day: r.day, cents: r.cents, note: r.note }))
}

/** The accounts a goal can count: cash, investments and retirement, not a house, a card or a loan. */
function checkAccounts(ids: string[]): string[] {
  const accounts = new Map(db.listAccounts().map((a) => [a.id, a]))
  const out = [...new Set(ids.map(String))]
  for (const id of out) {
    const a = accounts.get(id)
    if (!a) throw new Error(`No account ${id}`)
    if (!GOAL_ACCOUNT_TYPES.includes(a.assetType)) throw new Error(`${a.name} doesn't hold money a goal can count (cash, investments or retirement)`)
  }
  return out
}

/** Whether a linked account is still a kind a goal can count (its type can change after it's linked). */
const goalKind = (a: Pick<Account, 'assetType'> | undefined): boolean => !!a && GOAL_ACCOUNT_TYPES.includes(a.assetType)
/** Whether a linked account counts on a day: a goal kind, and open (a closed one holds nothing, as on the Balance sheet). */
const counts = (a: Pick<Account, 'assetType' | 'closedDay'> | undefined, on: string): boolean => goalKind(a) && !(a!.closedDay && a!.closedDay <= on)

/** The accounts' combined balance as the Accounts page shows it, those that still count. */
const balanceNow = (ids: string[]): number => {
  const want = new Set(ids)
  const on = today()
  return db.listAccounts().reduce((t, a) => t + (want.has(a.id) && counts(a, on) ? (a.balanceCents ?? 0) : 0), 0)
}
const balanceOn = (ids: string[], day: string): number => [...db.balancesOn(ids, day).values()].reduce((t, c) => t + c, 0)

/** Creates a goal (no id) or updates one; returns its id. */
export function saveGoal(input: GoalInput): number {
  const name = db.cleanText(String(input.name ?? ''), NAME_MAX)
  if (!name) throw new Error('A goal needs a name')
  const target = db.checkCents(input.targetCents, 'The target')
  if (target <= 0) throw new Error('The target must be more than zero')
  const targetDay = input.targetDay ? checkDay(input.targetDay, 'The target date') : null
  if (input.funding !== 'accounts' && input.funding !== 'manual') throw new Error('A goal is funded by accounts or by contributions')
  const accountIds = input.funding === 'accounts' ? checkAccounts(Array.isArray(input.accountIds) ? input.accountIds : []) : []
  if (input.funding === 'accounts' && !accountIds.length) throw new Error('Pick at least one account')
  const day = today()

  return db.inTransaction(() => {
    const had = input.id !== undefined ? getGoal(Number(input.id)) : null
    if (input.id !== undefined && !had) throw new Error(`No goal ${input.id}`)
    // What the progress leaves out: the accounts' balance on the start day, when it counts only what's saved since.
    let start: { cents: number | null; day: string | null } = { cents: null, day: null }
    if (input.funding === 'accounts') {
      const keep = input.fromNow !== false && had?.funding === 'accounts' && had.startDay !== null
      const same = keep && had!.accountIds.length === accountIds.length && accountIds.every((id) => had!.accountIds.includes(id))
      if (keep) start = same ? { cents: had!.startCents, day: had!.startDay } : { cents: balanceOn(accountIds, had!.startDay!), day: had!.startDay }
      else if (input.fromNow) start = { cents: balanceNow(accountIds), day }
    }
    let id: number
    if (had) {
      id = had.id
      db.all('UPDATE goals SET name = ?, target_cents = ?, target_day = ?, funding = ?, start_cents = ?, start_day = ? WHERE id = ?', name, target, targetDay, input.funding, start.cents, start.day, id)
      db.all('DELETE FROM goal_accounts WHERE goal_id = ?', id)
    } else {
      id = db.all<{ id: number }>('INSERT INTO goals (name, target_cents, target_day, funding, start_cents, start_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id', name, target, targetDay, input.funding, start.cents, start.day, db.now())[0].id
    }
    for (const a of accountIds) db.all('INSERT INTO goal_accounts (goal_id, account_id) VALUES (?, ?)', id, a)
    return id
  })
}

export function archiveGoal(id: number, archived: boolean): void {
  if (!getGoal(id)) throw new Error(`No goal ${id}`)
  db.all('UPDATE goals SET archived_at = ? WHERE id = ?', archived ? db.now() : null, id)
}

/** Removes a goal with its links and its log of contributions. */
export function deleteGoal(id: number): void {
  if (!getGoal(id)) throw new Error(`No goal ${id}`)
  db.inTransaction(() => {
    db.all('DELETE FROM goal_contributions WHERE goal_id = ?', id)
    db.all('DELETE FROM goal_accounts WHERE goal_id = ?', id)
    db.all('DELETE FROM goals WHERE id = ?', id)
  })
}

/** Logs money put toward a manual goal, on a day up to today (what's saved can't be ahead of the money). */
export function addContribution(goalId: number, c: { day: unknown; cents: unknown; note?: unknown }): number {
  if (!getGoal(goalId)) throw new Error(`No goal ${goalId}`)
  const cents = db.checkCents(c.cents, 'The amount')
  if (cents === 0) throw new Error('The amount must not be zero')
  const day = checkDay(c.day, 'The date')
  if (day > today()) throw new Error('The date is in the future')
  const note = typeof c.note === 'string' ? db.cleanText(c.note, db.NOTES_MAX) || null : null
  return db.all<{ id: number }>('INSERT INTO goal_contributions (goal_id, day, cents, note, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id', goalId, day, cents, note, db.now())[0].id
}

export function deleteContribution(id: number): void {
  if (!db.get('SELECT 1 FROM goal_contributions WHERE id = ?', id)) throw new Error(`No contribution ${id}`)
  db.all('DELETE FROM goal_contributions WHERE id = ?', id)
}

/** A goal with its log, as it is (for the journal). */
export interface GoalRecord {
  goal: Goal
  contributions: GoalContribution[]
}

export function goalRecord(ref: unknown): GoalRecord | null {
  const goal = findGoal(ref)
  return goal ? { goal, contributions: listContributions(goal.id) } : null
}

/** Puts a goal back exactly as a journal recorded it, under its old id, with its links (to accounts still here) and its log. */
export function restoreGoal(r: GoalRecord): void {
  const g = r.goal
  db.inTransaction(() => {
    db.all(
      `INSERT INTO goals (id, name, target_cents, target_day, funding, start_cents, start_day, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, target_cents = excluded.target_cents, target_day = excluded.target_day, funding = excluded.funding,
         start_cents = excluded.start_cents, start_day = excluded.start_day, created_at = excluded.created_at, archived_at = excluded.archived_at`,
      g.id, g.name, g.targetCents, g.targetDay, g.funding, g.startCents, g.startDay, g.createdAt, g.archivedAt
    )
    db.all('DELETE FROM goal_accounts WHERE goal_id = ?', g.id)
    const here = new Set(db.listAccounts().map((a) => a.id))
    for (const a of g.accountIds) if (here.has(a)) db.all('INSERT INTO goal_accounts (goal_id, account_id) VALUES (?, ?)', g.id, a)
    db.all('DELETE FROM goal_contributions WHERE goal_id = ?', g.id)
    for (const c of r.contributions) db.all('INSERT INTO goal_contributions (id, goal_id, day, cents, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', c.id, g.id, c.day, c.cents, c.note, db.now())
  })
}

// ---------- progress ----------

/** Every goal with its progress as of today. */
export function goalViews(on = today()): GoalView[] {
  const goals = listGoals()
  if (!goals.length) return []
  const accounts = new Map(db.listAccounts().map((a) => [a.id, a]))
  const log = listContributions()
  // The linked accounts' balances today and PACE_DAYS ago, walked once for every goal.
  const linked = [...new Set(goals.flatMap((g) => (g.funding === 'accounts' ? g.accountIds : [])))]
  const walkNow = linked.length ? db.balancesOn(linked, on) : new Map<string, number>()
  const walkAgo = linked.length ? db.balancesOn(linked, addDays(on, -PACE_DAYS)) : new Map<string, number>()
  const sum = (ids: string[], m: Map<string, number>): number => ids.reduce((t, id) => t + (m.get(id) ?? 0), 0)

  return goals.map((g) => {
    const contributions = log.filter((c) => c.goalId === g.id)
    // A closed account, or one no longer a goal kind, holds nothing toward it; the walk behind the pace has a closed one at 0 from its closing day.
    const saved =
      g.funding === 'accounts'
        ? g.accountIds.reduce((t, id) => t + (counts(accounts.get(id), on) ? (accounts.get(id)!.balanceCents ?? 0) : 0), 0) - (g.startCents ?? 0)
        : contributions.filter((c) => c.day <= on).reduce((t, c) => t + c.cents, 0)
    const kinds = g.accountIds.filter((id) => goalKind(accounts.get(id)))
    const pace = g.funding === 'accounts' ? balancePace(sum(kinds, walkNow), sum(kinds, walkAgo)) : contributionPace(contributions, db.dayKey(g.createdAt), on)
    return {
      ...g,
      accounts: g.accountIds.map((id) => ({ id, name: accounts.get(id)?.name ?? id, balanceCents: accounts.get(id)?.balanceCents ?? null })),
      contributions,
      ...progress({ targetCents: g.targetCents, targetDay: g.targetDay, savedCents: saved, paceCents: pace }, on)
    }
  })
}

/** The phone's copy (docs/sync-protocol.md, snapshot `goals`): the goals not archived. */
export function snapshotGoals(on = today()): Array<{ name: string; targetCents: number; savedCents: number; targetDay: string | null }> {
  return goalViews(on)
    .filter((g) => g.archivedAt === null)
    .map((g) => ({ name: g.name, targetCents: g.targetCents, savedCents: g.savedCents, targetDay: g.targetDay }))
}
