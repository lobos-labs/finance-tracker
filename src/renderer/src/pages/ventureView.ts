import type { ClassifiedLine, OwnerMoney, VentureIntent } from '../../../shared/types'
import { dayName, money } from './homeView'

// The money between Personal and a venture, as the Ventures page shows it (waterfall spec addendum 1.11, the Ventures
// page): the user's share, basis, stake and what values it, the stake less the basis and the position; the shares by
// the day each began; the owner money by kind, in and out from Personal's side, with what's still owed and the
// interest; and each boundary line with its parts. Figures only: Review sets every one of them. No React and no
// window here, so the tests read the very block the page draws.

/** A share in basis points, to two decimals: 50.00%. */
export const sharePct = (bp: number): string => `${(bp / 100).toFixed(2)}%`

/** A share as the venture list tags it: 50%, or 33.33%. */
export const shareShort = (bp: number): string => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`

/** Dollars and cents with their sign, a true minus: +100.00, −5,000.00. */
export const signedMoney = (cents: number): string => (cents > 0 ? `+${money(cents)}` : money(cents))

/** Each intent as the page names it. */
export const INTENT_NAMES: Record<VentureIntent, string> = {
  loan: 'Loan',
  loan_repayment: 'Loan repayment',
  equity: 'Equity',
  capital_return: 'Capital return',
  gift: 'Gift',
  draw: 'Draw',
  reimbursement: 'Reimbursement',
  venture_loan: 'Venture loan',
  venture_loan_repayment: 'Venture loan repayment',
  salary: 'Salary',
  trade: 'Trade',
  other: 'Other'
}

/**
 * A drill line's intent, as the Transactions list tags it, so a line's parts tell apart: "Loan", "Equity",
 * "Funding · Reimbursement", "Loan repayment · Interest"; null for a line with none.
 */
export function intentTag(l: Pick<ClassifiedLine, 'key' | 'txnId' | 'splitId' | 'intent'>): string | null {
  if (!l.intent) return null
  const fund = l.key.startsWith(`${l.txnId}:${l.splitId ?? ''}:p:fund`)
  return `${fund ? 'Funding · ' : ''}${INTENT_NAMES[l.intent]}${l.key.endsWith(':int') ? ' · Interest' : ''}`
}

/** One figure of the block's first line: its label (none for the value source) and its value. */
export interface OwnerFigure {
  key: 'share' | 'basis' | 'stake' | 'source' | 'aboveBasis' | 'position'
  label: string
  value: string
  /** the money it is, signed; null for the share and the source */
  cents: number | null
}

/**
 * One row of the owner money: a kind of money with its repayments or returns beside it, in and out from Personal's
 * side, what's outstanding (positive: the venture owes the user, so the column adds up to the claims in the position)
 * and the interest; null where the row has none. Unset is always there, its in and out 0 when it has none.
 */
export interface OwnerRow {
  key: string
  name: string
  inCents: number | null
  outCents: number | null
  outstandingCents: number | null
  interestCents: number | null
}

/** One boundary line: its day, its account, its amount (or its funding's) and its parts, named. */
export interface OwnerLineRow {
  key: string
  txnId: string
  day: string
  /** "Nov 2", or "Mar 3, 2025" in another year */
  dayText: string
  account: string
  cents: number
  /** "Loan 3,000.00 · Equity 2,000.00", "Funding · Reimbursement", "Loan repayment 1,000.00 · Interest 30.00" */
  parts: string
}

export interface OwnerBlock {
  figures: OwnerFigure[]
  /** each share row from the day it began, oldest first; a migrated row from the start of time isn't listed */
  shares: Array<{ day: string; pct: string }>
  rows: OwnerRow[]
  /** the latest boundary lines, oldest first */
  lines: OwnerLineRow[]
  /** the boundary lines older than those listed */
  more: number
}

/** How many boundary lines the block lists, the latest; the rest open on Transactions. */
export const LINES_SHOWN = 12

/** The owner money's rows in the order the block lists them: each kind of money, with the intents that make it up. */
const ROWS: Array<{ key: string; name: string; out: VentureIntent[]; in: VentureIntent[]; interest?: VentureIntent; outstanding?: (o: OwnerMoney) => number }> = [
  { key: 'loan', name: 'Loan', out: ['loan'], in: ['loan_repayment'], interest: 'loan_repayment', outstanding: (o) => o.lentCents },
  { key: 'equity', name: 'Equity', out: ['equity'], in: ['capital_return'] },
  { key: 'reimbursement', name: 'Reimbursement', out: ['reimbursement'], in: ['reimbursement'], outstanding: (o) => o.dueCents },
  { key: 'ventureLoan', name: 'Venture loan', out: ['venture_loan_repayment'], in: ['venture_loan'], interest: 'venture_loan_repayment', outstanding: (o) => -o.borrowedCents },
  { key: 'draw', name: 'Draw', out: [], in: ['draw'] },
  { key: 'salary', name: 'Salary', out: [], in: ['salary'] },
  { key: 'gift', name: 'Gift', out: ['gift'], in: ['gift'] },
  { key: 'trade', name: 'Trade', out: ['trade'], in: ['trade'] },
  { key: 'other', name: 'Other', out: ['other'], in: ['other'] }
]

/** A line's parts as the block names them: each intent, with its amount when there are several or a repayment has interest. */
function partsText(line: OwnerMoney['lines'][number]): string {
  const several = line.parts.length > 1
  const names = line.parts.flatMap((p) => {
    const name = `${p.intent ? INTENT_NAMES[p.intent] : 'Unset'}${p.source === 'rule' ? ' (rule)' : p.source === 'inferred' ? ' (inferred)' : ''}`
    if (p.interestCents) return [`${name} ${money(Math.abs(p.cents) - p.interestCents)}`, `Interest ${money(p.interestCents)}`]
    return [several ? `${name} ${money(Math.abs(p.cents))}` : name]
  })
  return [...(line.face === 'fund' ? ['Funding'] : []), ...names].join(' · ')
}

/** The block for a venture's owner money; `account` names an account by its id, and a line's day has its year when it isn't today's (YYYY-MM-DD). */
export function ownerBlock(o: OwnerMoney, account: (id: string) => string, today: string): OwnerBlock {
  const figures: OwnerFigure[] = [
    { key: 'share', label: 'Share', value: sharePct(o.shareBp), cents: null },
    { key: 'basis', label: 'Basis', value: money(o.basisCents), cents: o.basisCents },
    { key: 'stake', label: 'Stake', value: money(o.stakeCents), cents: o.stakeCents },
    { key: 'source', label: '', value: o.valueSource === 'books' ? 'Books' : `Estimate · ${o.stakeAccountId ? account(o.stakeAccountId) : ''}`, cents: null },
    { key: 'aboveBasis', label: 'Stake less basis', value: money(o.stakeCents - o.basisCents), cents: o.stakeCents - o.basisCents },
    { key: 'position', label: 'Position', value: money(o.positionCents), cents: o.positionCents }
  ]
  const of = (intent: VentureIntent | 'unset'): OwnerMoney['byIntent'][number] => o.byIntent.find((x) => x.intent === intent) ?? { intent, inCents: 0, outCents: 0, interestCents: 0 }
  const rows: OwnerRow[] = []
  for (const r of ROWS) {
    const interest = r.interest ? of(r.interest).interestCents : 0
    // A repayment's money in or out is its principal; its interest has a column of its own.
    const sum = (intents: VentureIntent[], side: 'inCents' | 'outCents'): number => intents.reduce((s, i) => s + of(i)[side] - (i === r.interest ? of(i).interestCents : 0), 0)
    const inCents = sum(r.in, 'inCents')
    const outCents = sum(r.out, 'outCents')
    const outstanding = r.outstanding?.(o) ?? 0
    if (!inCents && !outCents && !outstanding && !interest) continue
    rows.push({ key: r.key, name: r.name, inCents: inCents || null, outCents: outCents || null, outstandingCents: r.outstanding ? outstanding : null, interestCents: interest || null })
  }
  const unset = of('unset')
  rows.push({ key: 'unset', name: 'Unset', inCents: unset.inCents, outCents: unset.outCents, outstandingCents: null, interestCents: null })
  const shown = o.lines.slice(-LINES_SHOWN)
  return {
    figures,
    shares: o.shares.filter((s) => s.fromDay !== '0000-01-01').map((s) => ({ day: s.fromDay, pct: sharePct(s.shareBp) })),
    rows,
    lines: shown.map((l) => ({
      key: `${l.txnId}:${l.splitId ?? ''}:${l.face}`,
      txnId: l.txnId,
      day: l.day,
      dayText: l.day.slice(0, 4) === today.slice(0, 4) ? dayName(l.day) : `${dayName(l.day)}, ${l.day.slice(0, 4)}`,
      account: account(l.accountId),
      cents: l.cents,
      parts: partsText(l)
    })),
    more: o.lines.length - shown.length
  }
}
