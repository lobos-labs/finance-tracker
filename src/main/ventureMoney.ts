import * as db from './db'
import { appliedIntentParts, boundaryParts, staleIntentParts } from './lines'
import { REIMBURSE_DAYS } from './windows'
import { shareCents } from '../shared/rounding'
import { INTENT_DIRECTIONS, type BucketKind, type OwnerMoney, type VentureIntent, type VentureShare } from '../shared/types'
import { daysBetween, shiftMonth } from '../shared/zone'

// Money between Personal and a venture (waterfall spec addendum 1.11, sub-phase 1j). Every movement of money between
// the user's own money and a venture's is a boundary line, and each one has intent parts: a loan, equity, a draw, a
// reimbursement and so on, or none yet (unset). Net worth counts what the user has in each venture as its position:
//
//   claims    lent = loans - loan repayments' principal; borrowed = the venture's loans to the user - their
//             repayments' principal; due = reimbursements out - reimbursements in (positive: the venture owes the user)
//   A         the venture's net assets: the balance of the accounts it holds and of the Personal debts linked to an
//             asset it holds (Elm St's mortgage), the accounts net worth counted for it before 1j
//   E         A - lent + borrowed - due: what the venture is worth to all its owners once its claims are settled
//   stake     by the books, the user's share of E, half a cent away from zero and never clamped at 0, so a sole
//             owner's venture in debt lowers net worth as it always has; by an estimate, the linked Stakes
//             account's value; by the books with no account held, the Stakes account's value, or 0
//   V         lent - borrowed + due + stake
//
// Personal net worth is the visible Personal accounts plus every venture's V (netWorth.ts, the bridge in
// waterfall.ts). At 100% on the books V = A whatever the claims, so a ledger whose shares are all migrated (100% or
// 0%) has the net worth it had, to the cent; at 0% V is the claims alone. A Stakes account linked to a venture is
// never in Personal's accounts: it counts only as the stake, and only by an estimate.

/** The share on a day, from rows oldest first: the row with the latest fromDay on or before the day, 0 before the first. */
export function shareOn(rows: readonly VentureShare[], day: string): number {
  let bp = 0
  for (const r of rows) {
    if (r.fromDay > day) break
    bp = r.shareBp
  }
  return bp
}

/**
 * One intent part of a boundary line, with the day and account of its line. intent null is a boundary line no one
 * has given an intent yet (the classifier finds those from sub-phase 1j's part 2); source says who gave it.
 */
export interface IntentPart {
  txnId: string
  splitId: number | null
  face: 'line' | 'fund'
  ventureId: number
  day: string
  accountId: string
  intent: VentureIntent | null
  /** signed as the line, or for a fund part as its funding (minus the line): negative is money out of Personal */
  cents: number
  interestCents: number
  regular: boolean | null
  source: 'review' | 'user' | 'rule' | 'inferred' | null
}

/** The intent parts Review or the user stored (venture_money) on lines dated from one day to another, oldest first. */
export function storedParts(fromDay = '0000-01-01', toDay = '9999-12-31'): IntentPart[] {
  return db
    .all<{ txnId: string; splitId: number | null; face: 'line' | 'fund'; ventureId: number; day: string; accountId: string; intent: VentureIntent; cents: number; interestCents: number; regular: number | null; source: 'review' | 'user' }>(
      `SELECT m.txn_id AS txnId, m.split_id AS splitId, m.face, m.venture_id AS ventureId, date(${db.localSql('t.posted')}) AS day, t.account_id AS accountId,
              m.intent, m.cents, m.interest_cents AS interestCents, m.regular, m.source
       FROM venture_money m JOIN transactions t ON t.id = m.txn_id
       WHERE date(${db.localSql('t.posted')}) BETWEEN ? AND ?
       ORDER BY t.posted, m.txn_id, m.split_id, m.face, m.id`,
      fromDay,
      toDay
    )
    .map((r) => ({ ...r, regular: r.regular === null ? null : r.regular === 1 }))
}

/**
 * Every venture's intent parts on lines dated from one day to another, oldest first: the one function every reader
 * of venture money goes through (the claims, the basis, the positions in net worth and the bridge, the owner block of
 * a venture's books, Review's issues), so they all read the same parts: the parts rule 0 applies (lines.ts
 * appliedIntentParts: on a line in the ledger, a funding's on a Personal line a venture's cash or card paid), the
 * parts the classifier counts. They are the stored parts, and those a remembered answer or an inference gives a
 * boundary line with none stored (inferIntents), read from the classifier's one pass over every day, kept until the
 * data moves; books with no line that could cross to a venture read the stored parts alone, without classifying. With
 * `unset`, the boundary lines with no intent join them, one part each, as the classifier finds them (boundaryParts):
 * they move no claim, so what a position reads doesn't classify, and only the owner block and Review's issues ask.
 */
export function intentParts(fromDay: string, toDay: string, o: { unset?: boolean } = {}): IntentPart[] {
  const applied = appliedIntentParts(fromDay, toDay)
  if (!o.unset) return applied
  return [...applied, ...unsetParts(fromDay, toDay)].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

/**
 * The boundary lines with no intent from one day to another, as the classifier finds them, one part a line and
 * venture: a transfer with the venture, or its cost or revenue paid from or into Personal's account, at the venture's
 * parts of the line (face line); a Personal line a venture's cash or card paid, at its funding, minus the line (face
 * fund); and what a line's stored parts leave of it after its amount changed. They are the money book's (lines.ts
 * boundaryParts), which its one pass over every day finds and keeps until the data moves, so a venture's page reads
 * them without classifying every day again.
 */
export function unsetParts(fromDay: string, toDay: string): IntentPart[] {
  return boundaryParts()
    .unset.filter((u) => u.day >= fromDay && u.day <= toDay && u.cents !== 0)
    .map((u) => ({ txnId: u.txnId, splitId: u.splitId, face: u.face, ventureId: u.ventureId, day: u.day, accountId: u.accountId, intent: null, cents: u.cents, interestCents: 0, regular: null, source: null }))
}

/** The claims on a venture: what it owes the user on loans, what the user owes it, and what it owes back for costs paid. */
export interface Claims {
  lentCents: number
  borrowedCents: number
  dueCents: number
}

/**
 * A part's move of the claims, as plain sums: a loan lends what left Personal, a repayment takes its principal (the
 * part less its interest) off what's lent, and the same for the venture's loans to the user; a reimbursement out is
 * due from the venture and one in settles it. So removing a loan later leaves a later repayment's principal as a
 * negative lent balance.
 */
function claimMove(p: Pick<IntentPart, 'intent' | 'cents' | 'interestCents'>, c: Claims): void {
  switch (p.intent) {
    case 'loan':
      c.lentCents -= p.cents
      break
    case 'loan_repayment':
      c.lentCents -= p.cents - p.interestCents
      break
    case 'venture_loan':
      c.borrowedCents += p.cents
      break
    case 'venture_loan_repayment':
      c.borrowedCents += p.cents + p.interestCents
      break
    case 'reimbursement':
      c.dueCents -= p.cents
      break
  }
}

/** A venture's claims through a day (YYYY-MM-DD), from its parts. */
export function claimsThrough(parts: readonly IntentPart[], day: string): Claims {
  const c: Claims = { lentCents: 0, borrowedCents: 0, dueCents: 0 }
  for (const p of parts) if (p.day <= day) claimMove(p, c)
  return c
}

/**
 * The user's basis in a venture through a day: its equity and capital returns walked in day order, basis = max(0,
 * basis + equity - capital returned), and what a return took below 0, returned above basis. Gifts, loans and draws
 * never touch it.
 */
export function basisThrough(parts: readonly IntentPart[], day = '9999-12-31'): { basisCents: number; aboveBasisCents: number } {
  let basis = 0
  let above = 0
  for (const p of parts) {
    if (p.day > day) continue
    if (p.intent === 'equity') basis += -p.cents
    else if (p.intent === 'capital_return') {
      const next = basis - p.cents
      if (next < 0) above -= next
      basis = Math.max(0, next)
    }
  }
  return { basisCents: basis, aboveBasisCents: above }
}

// ---------- setting an intent: remembered answers and inferences ----------

// A boundary line with no intent stored takes one when Review remembered the answer for its pattern
// (venture_money_rules: the venture, the shape, the direction and, for a transfer, its payee), or else when one of
// five safe cases says what it is (waterfall spec addendum 1.11, Setting an intent), the first that applies:
//   I1 support: money out to someone the user supports (a venture of kind person) who owns none of it that day is a
//      gift;
//   I2 salary: a transfer in whose line on the user's account is from a payroll is salary;
//   I4 payback: money the other way within REIMBURSE_DAYS after costs the user and the venture paid for each other
//      (reimbursement parts) is a reimbursement when it's exactly one of them not yet paid back, or all of them
//      together, the oldest first, each paid back once;
//   I5 matched cost: a venture's cost paid from the user's cash and cards, or a Personal cost the venture's account
//      paid, and a transfer the other way of the same amount within REIMBURSE_DAYS after it, are both reimbursements
//      (this reads ahead: the first line's month can change when the second comes);
//   I3 draw: money in by transfer from a venture the user owns some of, with nothing lent or borrowed the day before,
//      is a regular draw when the venture sent a transfer within DRAW_MATCH_PCT of it, unset or a draw, in each of the
//      2 calendar months before its own.
// Neither a remembered answer nor an inference ever gives a repayment more principal than is outstanding on its day,
// equity or a return of capital while the venture's share is still the migrated one, or a draw or a return of
// capital on a day the user owns none of it: such a line stays unset. Each venture's lines are walked in posting
// order, so the claims and the paybacks a line reads are those of the lines before it.

/** A draw is one of a run when the draws before it are within this percent of it: 100 × |a - b| ≤ DRAW_MATCH_PCT × |b|. */
export const DRAW_MATCH_PCT = 1

/**
 * One boundary part with one venture, before any intent, as the classifier finds it (lines.ts): a transfer with its
 * accounts (T), its cost or revenue on Personal's cash and cards (C), or a Personal line its cash or card paid, at the
 * funding (F).
 */
export interface BoundaryUnit {
  txnId: string
  splitId: number | null
  face: 'line' | 'fund'
  shape: 'T' | 'C' | 'F'
  ventureId: number
  day: string
  /** unix time, for the order of a day's lines */
  posted: number
  accountId: string
  /** what its intent parts add up to, signed: negative is money out of Personal */
  cents: number
  /** a transfer's payee on the user's account (T): its pattern's; null for any other shape */
  payeeKey: string | null
  /** a transfer in whose line on the user's account is from a payroll (I2) */
  payroll: boolean
  /** pay landing on the venture's account, the user's by the paycheck clause (F): Review's venture_paycheck */
  pay: boolean
}

/** A boundary part's key: its line, face and venture. */
export const unitKey = (u: Pick<BoundaryUnit, 'txnId' | 'splitId' | 'face' | 'ventureId'>): string => `${u.txnId}:${u.splitId ?? ''}:${u.face}:${u.ventureId}`

/** A boundary part's pattern, as a remembered answer keeps one: the venture, the shape, the direction and a transfer's payee. */
export const patternOf = (u: Pick<BoundaryUnit, 'ventureId' | 'shape' | 'cents' | 'payeeKey'>): string => `${u.ventureId}|${u.shape}|${u.cents < 0 ? 'out' : 'in'}|${u.shape === 'T' ? (u.payeeKey ?? '') : ''}`

/** A remembered answer for a pattern of boundary lines (venture_money_rules). */
export interface PatternRule {
  ventureId: number
  shape: 'T' | 'C' | 'F'
  direction: 'out' | 'in'
  payeeKey: string | null
  intent: VentureIntent
  regular: boolean | null
}

/** The intent a remembered answer or an inference gives a boundary part with none stored. */
export interface GivenIntent {
  intent: VentureIntent
  /** a draw's: true for an inferred one, the answer's own for a remembered one */
  regular: boolean | null
  source: 'rule' | 'inferred'
}

/** A venture as the inferences read it: its kind and its share rows, oldest first. */
export interface VentureKind {
  id: number
  kind: BucketKind
  shares: VentureShare[]
}

/** One line of a venture's walk: a boundary part, the parts stored for it, or both. */
interface Step {
  key: string
  ventureId: number
  /** null for a line tied to the venture by hand (R), which has only its stored parts */
  unit: BoundaryUnit | null
  stored: Array<Pick<IntentPart, 'intent' | 'cents' | 'interestCents'>> | null
  day: string
  posted: number
  txnId: string
  splitId: number | null
  /** the boundary part's cents, or what its stored parts add up to */
  cents: number
}

/** A reimbursement part not yet paid back: its walk step, day and amount (positive). */
interface Owed {
  key: string
  day: string
  cents: number
}

/**
 * The intents remembered answers and inferences give the boundary parts with none stored (the order above), by part
 * (unitKey). `units` are every boundary part the classifier finds; `stored` every stored intent part that applies,
 * with its line's posting time, those of lines tied to a venture by hand among them. A part with stored parts keeps
 * them, and they move the claims and the paybacks the parts after it read.
 */
export function inferIntents(units: readonly BoundaryUnit[], stored: ReadonlyArray<IntentPart & { posted: number }>, ventures: readonly VentureKind[], rules: readonly PatternRule[]): Map<string, GivenIntent> {
  const answers = new Map(rules.map((r) => [`${r.ventureId}|${r.shape}|${r.direction}|${r.shape === 'T' ? (r.payeeKey ?? '') : ''}`, r]))
  const steps = new Map<string, Step>()
  for (const u of units) {
    const key = unitKey(u)
    steps.set(key, { key, ventureId: u.ventureId, unit: u, stored: null, day: u.day, posted: u.posted, txnId: u.txnId, splitId: u.splitId, cents: u.cents })
  }
  for (const p of stored) {
    if (p.intent === null) continue
    const key = unitKey(p)
    let s = steps.get(key)
    if (!s) steps.set(key, (s = { key, ventureId: p.ventureId, unit: null, stored: null, day: p.day, posted: p.posted, txnId: p.txnId, splitId: p.splitId, cents: 0 }))
    if (!s.stored) s.stored = []
    s.stored.push({ intent: p.intent, cents: p.cents, interestCents: p.interestCents })
    if (!s.unit) s.cents += p.cents
  }
  const byVenture = new Map<number, Step[]>()
  for (const s of steps.values()) {
    const list = byVenture.get(s.ventureId)
    if (list) list.push(s)
    else byVenture.set(s.ventureId, [s])
  }
  const given = new Map<string, GivenIntent>()
  const kinds = new Map(ventures.map((v) => [v.id, v]))
  // A bank posts a day's lines at no time of their own, so a day is read in a fixed order rather than by its times:
  // the lines whose intents were stored first, then those a remembered answer covers, then costs, revenue and
  // fundings, then transfers, so a cost and its payback on one day match whichever posted first.
  const rank = (s: Step): number => (s.stored ? 0 : s.unit && answers.has(patternOf(s.unit)) ? 1 : s.unit?.shape === 'T' ? 3 : 2)
  for (const [v, list] of byVenture) {
    list.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0) || rank(x) - rank(y) || x.posted - y.posted || (x.txnId < y.txnId ? -1 : x.txnId > y.txnId ? 1 : 0) || (x.splitId ?? 0) - (y.splitId ?? 0))
    walk(list, kinds.get(v) ?? { id: v, kind: 'other', shares: [] }, answers, given)
  }
  return given
}

/** Walks one venture's boundary lines oldest first, giving each with no intent stored the first answer that applies. */
function walk(steps: Step[], venture: VentureKind, answers: ReadonlyMap<string, PatternRule>, given: Map<string, GivenIntent>): void {
  const migrated = venture.shares.every((s) => s.source === 'migrated')
  const claims: Claims = { lentCents: 0, borrowedCents: 0, dueCents: 0 }
  /** the claims through the day before the step's own */
  let before: Claims = { ...claims }
  let day = ''
  /** reimbursement parts not yet paid back, by the way their money went */
  const owed: Record<'out' | 'in', Owed[]> = { out: [], in: [] }
  /** the transfers in from the venture so far, by month, and whether each was unset or a draw (I3) */
  const transfersIn: Array<{ month: string; cents: number; open: boolean }> = []
  /** a later step I5 matched to an earlier one, by its key: the earlier step's */
  const matched = new Map<string, string>()
  const within = (from: string, to: string): boolean => to >= from && daysBetween(from, to) <= REIMBURSE_DAYS

  /** The reimbursements not yet paid back that money of these cents on a day pays back: one of them (the oldest), or all of them together. */
  const paysBack = (cents: number, on: string, pool: Owed[]): Owed[] => {
    const open = pool.filter((o) => within(o.day, on))
    const one = open.find((o) => o.cents === Math.abs(cents))
    if (one) return [one]
    return open.length > 1 && open.reduce((s, o) => s + o.cents, 0) === Math.abs(cents) ? open : []
  }
  /** A reimbursement part: it pays back the one I5 matched it to, or those it pays back (I4), or it's owed. */
  const settle = (s: Step, cents: number): void => {
    const pool = owed[cents < 0 ? 'in' : 'out']
    const partner = matched.get(s.key)
    const back = partner && pool.some((o) => o.key === partner) ? pool.filter((o) => o.key === partner) : paysBack(cents, s.day, pool)
    if (back.length) {
      for (const o of back) pool.splice(pool.indexOf(o), 1)
      return
    }
    owed[cents < 0 ? 'out' : 'in'].push({ key: s.key, day: s.day, cents: Math.abs(cents) })
  }
  /** Whether a remembered answer, or an inference, may give a step this intent (the limits above). */
  const allowed = (s: Step, intent: VentureIntent): boolean => {
    const direction = s.cents < 0 ? 'out' : 'in'
    if (!INTENT_DIRECTIONS[intent].includes(direction)) return false
    if (intent === 'loan_repayment' && Math.abs(s.cents) > claims.lentCents) return false
    if (intent === 'venture_loan_repayment' && Math.abs(s.cents) > claims.borrowedCents) return false
    if ((intent === 'equity' || intent === 'capital_return') && migrated) return false
    if ((intent === 'draw' || intent === 'capital_return') && shareOn(venture.shares, s.day) === 0) return false
    return true
  }
  const support = (s: Step): boolean => s.cents < 0 && venture.kind === 'person' && shareOn(venture.shares, s.day) === 0
  const salary = (s: Step): boolean => s.unit?.shape === 'T' && s.cents > 0 && s.unit.payroll
  const answerOf = (s: Step): PatternRule | undefined => (s.unit ? answers.get(patternOf(s.unit)) : undefined)

  const decide = (s: Step, i: number): GivenIntent | null => {
    if (matched.has(s.key)) return { intent: 'reimbursement', regular: null, source: 'inferred' }
    const answer = answerOf(s)
    if (answer) return allowed(s, answer.intent) ? { intent: answer.intent, regular: answer.regular, source: 'rule' } : null
    if (support(s)) return { intent: 'gift', regular: null, source: 'inferred' }
    if (salary(s)) return { intent: 'salary', regular: null, source: 'inferred' }
    if (paysBack(s.cents, s.day, owed[s.cents < 0 ? 'in' : 'out']).length) return { intent: 'reimbursement', regular: null, source: 'inferred' }
    const shape = s.unit!.shape
    // I5 starts from a cost one side paid for the other: the venture's cost paid from Personal's cash and cards (C,
    // out) or a Personal cost the venture's cash or card paid (F, in). The venture's revenue received in Personal's
    // account and pay landing in the venture's are no cost, and a rent the same as the next payment on the rental's
    // mortgage would read as two reimbursements: they stay for Review.
    if ((shape === 'C' && s.cents < 0) || (shape === 'F' && s.cents > 0)) {
      // I5: the first transfer after it the other way, of the same amount, within the days, with no answer of its own.
      // Only a transfer settles a cost: a cost and a revenue of the same amount, or two fundings, are no payback, and
      // a venture that holds no account, whose position is its claims alone, would move net worth by them.
      for (let j = i + 1; j < steps.length && within(s.day, steps[j].day); j++) {
        const t = steps[j]
        if (!t.unit || t.unit.shape !== 'T' || t.stored || matched.has(t.key) || Math.sign(t.cents) === Math.sign(s.cents) || Math.abs(t.cents) !== Math.abs(s.cents)) continue
        if (answerOf(t) || support(t) || salary(t)) continue
        matched.set(t.key, s.key)
        return { intent: 'reimbursement', regular: null, source: 'inferred' }
      }
    }
    if (shape === 'T' && s.cents > 0 && shareOn(venture.shares, s.day) > 0 && before.lentCents === 0 && before.borrowedCents === 0) {
      const month = s.day.slice(0, 7)
      const near = (k: number): boolean => transfersIn.some((t) => t.open && t.month === shiftMonth(month, -k) && 100 * Math.abs(t.cents - s.cents) <= DRAW_MATCH_PCT * Math.abs(s.cents))
      if (near(1) && near(2)) return { intent: 'draw', regular: true, source: 'inferred' }
    }
    return null
  }

  steps.forEach((s, i) => {
    if (s.day !== day) {
      before = { ...claims }
      day = s.day
    }
    let parts = s.stored
    if (!parts) {
      const g = s.unit && s.cents ? decide(s, i) : null
      if (g) given.set(s.key, g)
      parts = g ? [{ intent: g.intent, cents: s.cents, interestCents: 0 }] : []
    }
    for (const p of parts) {
      claimMove(p, claims)
      if (p.intent === 'reimbursement') settle(s, p.cents)
    }
    if (s.unit?.shape === 'T' && s.cents > 0) transfersIn.push({ month: s.day.slice(0, 7), cents: s.cents, open: parts.every((p) => p.intent === 'draw') })
  })
}

/** A venture's position on a day, with what it's made of. */
export interface Position extends Claims {
  shareBp: number
  /** A: what its accounts hold, when its stake reads them (by the books); 0 otherwise */
  netAssetsCents: number
  /** E: A less the claims */
  equityCents: number
  stakeCents: number
  /** V: lent - borrowed + due + stake */
  positionCents: number
}

/**
 * A venture's position on a day from its claims then and its accounts' balances (`balance`, by account id). By the
 * books the stake is the share of A less the claims, read only while the share is above 0; an estimate, or the books
 * with no account held, is the Stakes account's value.
 */
export function positionOf(v: db.VentureHolding, claims: Claims, day: string, balance: (id: string) => number): Position {
  const shareBp = shareOn(v.shares, day)
  const books = v.valueSource === 'books' && v.accounts.length > 0
  const netAssets = books && shareBp > 0 ? v.accounts.reduce((s, id) => s + balance(id), 0) : 0
  const equity = netAssets - claims.lentCents + claims.borrowedCents - claims.dueCents
  const stake = books ? shareCents(equity, shareBp) : v.stakeAccountId ? balance(v.stakeAccountId) : 0
  return { ...claims, shareBp, netAssetsCents: netAssets, equityCents: equity, stakeCents: stake, positionCents: claims.lentCents - claims.borrowedCents + claims.dueCents + stake }
}

/** What every venture's position reads, read once: the ventures as net worth reads them, Personal's accounts, and each venture's parts. */
export interface PositionBook {
  personal: string[]
  ventures: db.VentureHolding[]
  /** each venture's intent parts, oldest first */
  parts: Map<number, IntentPart[]>
  /** every account a position reads: the ventures' net assets by the books and their Stakes accounts by an estimate */
  reads: string[]
}

/**
 * The position book, with each venture's parts through a day. With `values`, for what net worth reads alone (the
 * series, the balance sheet, net worth now): a venture all the user's by its books on every day is worth what its
 * accounts hold, whatever its claims (the stake takes back what they add); and one with no account, no Stakes account,
 * no stored part and no remembered answer has no claim (no transfer with it can be, so no inference pays a cost of it
 * back), so its value is its stake alone. When every venture is one of those, no part is read.
 */
export function positionBook(throughDay: string, o: { values?: boolean } = {}): PositionBook {
  const { personal, ventures } = db.ventureHoldings()
  const parts = new Map<number, IntentPart[]>(ventures.map((v) => [v.id, []]))
  const whole = (v: db.VentureHolding): boolean => v.valueSource === 'books' && v.accounts.length > 0 && v.shares.length > 0 && v.shares.every((s) => s.shareBp === 10000)
  const answered = (): Set<number> => new Set(db.all<{ v: number }>('SELECT venture_id AS v FROM venture_money UNION SELECT venture_id FROM venture_money_rules').map((r) => r.v))
  let given: Set<number> | null = null
  const claimless = (v: db.VentureHolding): boolean => !v.accounts.length && !v.stakeAccountId && !(given ??= answered()).has(v.id)
  if (!o.values || !ventures.every((v) => whole(v) || claimless(v))) for (const p of intentParts('0000-01-01', throughDay)) parts.get(p.ventureId)?.push(p)
  return { personal, ventures, parts, reads: [...new Set(ventures.flatMap((v) => v.reads))] }
}

/** Every venture's position on a day, by id, from its accounts' balances that day. */
export function positionsOn(book: PositionBook, day: string, balance: (id: string) => number): Map<number, Position> {
  return new Map(book.ventures.map((v) => [v.id, positionOf(v, claimsThrough(book.parts.get(v.id) ?? [], day), day, balance)]))
}

/**
 * Each venture's position on each of some days (YYYY-MM-DD, oldest first), from the balances of the accounts its
 * position reads on those days (`byId`, aligned with `days`, as db.balancesOver gives them), so a daily series costs
 * the one walk of balances the caller made: its claims and share are stepped through the days once.
 */
export function valuesOver(book: PositionBook, days: readonly string[], byId: ReadonlyMap<string, readonly number[]>): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const v of book.ventures) {
    const parts = book.parts.get(v.id) ?? []
    const claims: Claims = { lentCents: 0, borrowedCents: 0, dueCents: 0 }
    let k = 0
    const values = new Array<number>(days.length)
    for (let i = 0; i < days.length; i++) {
      while (k < parts.length && parts[k].day <= days[i]) claimMove(parts[k++], claims)
      values[i] = positionOf(v, claims, days[i], (id) => byId.get(id)?.[i] ?? 0).positionCents
    }
    out.set(v.id, values)
  }
  return out
}

/** Each venture's position on each of some days (oldest first), from one walk of the balances its position reads. */
export function ventureValues(days: readonly string[]): Map<number, number[]> {
  if (!days.length) return new Map()
  const book = positionBook(days[days.length - 1])
  const all = db.balancesOver(book.reads, days[0], days[days.length - 1])
  const at = new Map(all.days.map((d, i) => [d, i]))
  const byId = new Map(book.reads.map((id) => [id, days.map((d) => all.byId.get(id)?.[at.get(d) ?? -1] ?? 0)]))
  return valuesOver(book, days, byId)
}

/**
 * What Review asks about the ventures' shares and values (waterfall spec addendum 1.11, Review issues), one question
 * per venture. shareUnset: every share row is still the one migration 43 gave it (100% or 0%, as net worth counted it
 * before), and the venture holds an account or has lines placed in it on Personal's cash and cards (its money crosses
 * the boundary, so its share decides what of it is the user's). noValue: the user owns part of it today, and the
 * books have nothing to value it by (no account held) and no Stakes account is linked, so its stake counts as 0.
 * heldStakes: a Stakes account (type venture, the user's own estimate of a stake) with a balance that the venture
 * holds, which its books count as the venture's own money, so a share below 100% would scale that estimate: it
 * belongs out of the venture, linked as the stake.
 */
export function ventureQuestions(today = db.today()): {
  shareUnset: Array<{ id: number; name: string; shareBp: number; accounts: number; crossing: number }>
  noValue: Array<{ id: number; name: string; shareBp: number }>
  heldStakes: Array<{ id: number; name: string; accountId: string; accountName: string }>
} {
  const { ventures } = db.ventureHoldings()
  // Its boundary lines: the classifier's, an intent or not, and those tied to it by hand.
  const crossing = new Map<number, Set<string>>()
  const cross = (v: number, line: string): void => {
    const set = crossing.get(v)
    if (set) set.add(line)
    else crossing.set(v, new Set([line]))
  }
  for (const u of boundaryParts().units) cross(u.ventureId, `${u.txnId}:${u.splitId ?? ''}`)
  for (const p of intentParts('0000-01-01', '9999-12-31')) cross(p.ventureId, `${p.txnId}:${p.splitId ?? ''}`)
  const shareUnset: Array<{ id: number; name: string; shareBp: number; accounts: number; crossing: number }> = []
  const noValue: Array<{ id: number; name: string; shareBp: number }> = []
  for (const v of ventures) {
    const shareBp = shareOn(v.shares, today)
    const n = crossing.get(v.id)?.size ?? 0
    if (v.shares.every((s) => s.source === 'migrated') && (v.accounts.length || n)) shareUnset.push({ id: v.id, name: v.name, shareBp, accounts: v.accounts.length, crossing: n })
    if (shareBp > 0 && !v.accounts.length && !v.stakeAccountId) noValue.push({ id: v.id, name: v.name, shareBp })
  }
  const names = new Map(ventures.map((v) => [v.id, v.name]))
  const heldStakes = db
    .all<{ id: string; name: string; bucket: number }>("SELECT id, name, bucket_id AS bucket FROM accounts WHERE hidden = 0 AND asset_type = 'venture' AND bucket_id IS NOT NULL AND COALESCE(balance_cents, 0) != 0 ORDER BY rowid")
    .filter((a) => names.has(a.bucket))
    .map((a) => ({ id: a.bucket, name: names.get(a.bucket)!, accountId: a.id, accountName: a.name }))
  return { shareUnset, noValue, heldStakes }
}

/** One pattern of a venture's boundary lines with no intent, as Review asks about it: venture_money. */
export interface MoneyPattern {
  ventureId: number
  shape: 'T' | 'C' | 'F'
  direction: 'out' | 'in'
  /** a transfer's payee on the user's account (T); null for any other shape */
  payeeKey: string | null
  count: number
  /** signed: negative is money out of Personal */
  cents: number
  fromDay: string
  toDay: string
  /** up to 5 of its amounts (positive), the most lines first, each with how many lines have it */
  amounts: Array<{ cents: number; count: number }>
  /** its lines' transactions, the newest first */
  txnIds: string[]
}

/** One account a venture holds that pay lands on, with the paychecks whose funding has no intent: venture_paycheck. */
export interface PayIntoVenture {
  accountId: string
  ventureId: number
  count: number
  cents: number
  fromDay: string
  toDay: string
  txnIds: string[]
}

/** A venture's stored intents that no longer fit their lines, which count nowhere: venture_money's stale question. */
export interface StaleMoney {
  ventureId: number
  count: number
  /** signed: negative is money out of Personal */
  cents: number
  fromDay: string
  toDay: string
  /** its lines' transactions, the newest first */
  txnIds: string[]
}

/**
 * What Review asks about the money between Personal and the ventures (waterfall spec addendum 1.11, Review issues):
 * one question per pattern of boundary lines with no intent (a venture, its shape, its direction and, for a
 * transfer, the payee on the user's account), so a backfill of years of transfers asks once a pattern; one per
 * account a venture holds that pay lands on while a paycheck's funding has no intent (a paycheck's funding is that
 * account's question, not its pattern's); and one per venture whose stored intents no longer fit their lines (an
 * account left the venture, a transfer's leg or a line's venture changed), which count nowhere until Review clears
 * them or the lines change back.
 */
export function moneyQuestions(): { patterns: MoneyPattern[]; paychecks: PayIntoVenture[]; stale: StaleMoney[] } {
  const stale = new Map<number, StaleMoney>()
  for (const s of staleIntentParts()) {
    const x = stale.get(s.ventureId) ?? { ventureId: s.ventureId, count: 0, cents: 0, fromDay: s.day, toDay: s.day, txnIds: [] }
    x.count++
    x.cents += s.cents
    x.toDay = s.day
    if (!x.txnIds.includes(s.txnId)) x.txnIds.unshift(s.txnId)
    stale.set(s.ventureId, x)
  }
  const patterns = new Map<string, MoneyPattern & { by: Map<number, number> }>()
  const paychecks = new Map<string, PayIntoVenture>()
  for (const u of boundaryParts().unset) {
    if (u.pay) {
      const p = paychecks.get(u.accountId) ?? { accountId: u.accountId, ventureId: u.ventureId, count: 0, cents: 0, fromDay: u.day, toDay: u.day, txnIds: [] }
      p.count++
      p.cents -= u.cents
      p.toDay = u.day
      p.txnIds.unshift(u.txnId)
      paychecks.set(u.accountId, p)
      continue
    }
    const key = patternOf(u)
    const p: MoneyPattern & { by: Map<number, number> } = patterns.get(key) ?? { ventureId: u.ventureId, shape: u.shape, direction: u.cents < 0 ? 'out' : 'in', payeeKey: u.shape === 'T' ? u.payeeKey : null, count: 0, cents: 0, fromDay: u.day, toDay: u.day, amounts: [], txnIds: [], by: new Map() }
    p.count++
    p.cents += u.cents
    p.toDay = u.day
    p.by.set(Math.abs(u.cents), (p.by.get(Math.abs(u.cents)) ?? 0) + 1)
    if (!p.txnIds.includes(u.txnId)) p.txnIds.unshift(u.txnId)
    patterns.set(key, p)
  }
  return {
    patterns: [...patterns.values()].map(({ by, ...p }) => ({ ...p, amounts: [...by].map(([cents, count]) => ({ cents, count })).sort((a, b) => b.count - a.count || b.cents - a.cents).slice(0, 5) })),
    paychecks: [...paychecks.values()],
    stale: [...stale.values()]
  }
}

/**
 * The money between Personal and one venture today, for its books (VentureResult.owner): its shares, value source and
 * Stakes account, its basis, claims, net assets (every account it holds, whatever its stake reads), stake and
 * position, and its intent parts by intent and by line. In and out are from Personal's side: out is money Personal
 * sent. A repayment's interest is in its intent's interest. byIntent and lines hold every boundary line with the
 * venture: the parts intentParts gives, and the boundary lines with no intent yet (unset), as the classifier finds them.
 */
export function ownerMoney(ventureId: number, today = db.today()): OwnerMoney {
  return ownerMoneys([ventureId], today, { unset: true }).get(ventureId)!
}

/**
 * Each of some ventures' owner money today (ownerMoney), from one read of what their positions read, by id. Its
 * lines and intents hold the boundary lines with an intent, and with `unset` every boundary line with the venture,
 * those with no intent yet among them, read from the classifier over every day there are lines. `book` is the
 * position book through today when the caller has read it already (a venture's books read its parts too).
 */
export function ownerMoneys(ventureIds: number[], today = db.today(), o: { unset?: boolean; book?: PositionBook } = {}): Map<number, OwnerMoney> {
  const book = o.book ?? positionBook(today)
  const want = new Set(ventureIds)
  const held = book.ventures.filter((v) => want.has(v.id))
  const balances = db.balancesOn([...new Set(held.flatMap((v) => [...v.accounts, ...(v.stakeAccountId ? [v.stakeAccountId] : [])]))], today)
  const first = db.get<{ p: number | null }>('SELECT MIN(posted) AS p FROM transactions')?.p ?? null
  const unset = new Map<number, IntentPart[]>()
  if (o.unset && held.length && first !== null) for (const x of unsetParts(db.dayKey(first), today)) if (want.has(x.ventureId)) unset.set(x.ventureId, [...(unset.get(x.ventureId) ?? []), x])
  const out = new Map<number, OwnerMoney>()
  for (const id of ventureIds) {
    const v = held.find((x) => x.id === id)
    out.set(id, v ? ownerMoneyOf(v, book.parts.get(id) ?? [], unset.get(id) ?? [], today, (a) => balances.get(a) ?? 0) : { shareBp: 0, shares: [], valueSource: 'books', stakeAccountId: null, basisCents: 0, aboveBasisCents: 0, lentCents: 0, borrowedCents: 0, dueCents: 0, netAssetsCents: 0, stakeCents: 0, positionCents: 0, byIntent: [], lines: [] })
  }
  return out
}

function ownerMoneyOf(v: db.VentureHolding, applied: readonly IntentPart[], unset: readonly IntentPart[], today: string, balance: (id: string) => number): OwnerMoney {
  const shares = v.shares
  const p = positionOf(v, claimsThrough(applied, today), today, balance)
  const parts = [...applied, ...unset].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const byIntent = new Map<VentureIntent | 'unset', { intent: VentureIntent | 'unset'; inCents: number; outCents: number; interestCents: number }>()
  const lines = new Map<string, OwnerMoney['lines'][number]>()
  for (const x of parts) {
    const key = x.intent ?? 'unset'
    const row = byIntent.get(key) ?? { intent: key, inCents: 0, outCents: 0, interestCents: 0 }
    if (x.cents > 0) row.inCents += x.cents
    else row.outCents -= x.cents
    row.interestCents += x.interestCents
    byIntent.set(key, row)
    const lineKey = `${x.txnId}:${x.splitId ?? ''}:${x.face}`
    const line = lines.get(lineKey) ?? { txnId: x.txnId, splitId: x.splitId, face: x.face, day: x.day, accountId: x.accountId, cents: 0, parts: [] }
    line.cents += x.cents
    line.parts.push({ intent: x.intent, cents: x.cents, interestCents: x.interestCents, source: x.source })
    lines.set(lineKey, line)
  }
  return {
    shareBp: p.shareBp,
    shares,
    valueSource: v.valueSource,
    stakeAccountId: v.stakeAccountId,
    ...basisThrough(parts, today),
    lentCents: p.lentCents,
    borrowedCents: p.borrowedCents,
    dueCents: p.dueCents,
    netAssetsCents: v.accounts.reduce((s, id) => s + balance(id), 0),
    stakeCents: p.stakeCents,
    positionCents: p.positionCents,
    byIntent: [...byIntent.values()],
    lines: [...lines.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  }
}
