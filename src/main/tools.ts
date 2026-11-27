import { investments, withoutReturns } from './investments'
import { deleteBenefitPlan, getBenefits, setBenefitPlan, setBenefitSettings, setHsaYear } from './benefits'
import { deleteTaxYear, getTaxes, setTaxYear } from './taxes'
import { deleteScore, getCredit, moveAccount as moveCreditAccount, recordScore, setLimit, setReport } from './credit'
import { deletePolicy, getInsurance, savePolicy } from './insurance'
import { addContribution, archiveGoal, deleteGoal, findGoal, goalViews, listGoals, saveGoal } from './goals'
import type Anthropic from '@anthropic-ai/sdk'
import { mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import * as db from './db'
import { ledgerState } from './ledgerState'
import { getProvider } from './ai/backend'
import { checkAllowance } from './allowance'
import { can, requireFeature } from './license'
import { docsDir } from './paths'
import { documentPath, documentProblem, isDocumentName } from './files'
import { hostedDocuments, readDocument, type DocumentBlock } from './documents'
import { isJournaled, snapshotAfter, snapshotBefore } from './journal'
import { linkReceipt, receiptSummary } from './receipts'
import { detectRecurring, isPersonal } from './recurring'
import { boundariesOf, ledgerLines, personalPart, unlinkedDebts, withPersonalLine, type Boundary, type LedgerLine } from './lines'
import { getNetWorthSeries } from './netWorth'
import { personalSpending } from './spendModel'
import { getSummary, SPENDING, spendingCategories, TAKE_HOME } from './summary'
import { getWaterfall, investedBalance, retirementSettings, setRetirement, type RetirementSettings } from './waterfall'
import { acceptCloseChanges, changedMonths, closeMonth, gapMonths } from './snapshots'
import { attachQuestions, attachToAsset, listUses, saveUses, shareQuestions, USE_BASES, type UseRow } from './uses'
import { contributionSummary, matchLeft } from './contributions'
import { elections, listPaystubs, payrollCheckItems, payrollChecks, savePaystub } from './paystubs'
import { addDays, calendarItems, itemSummary } from './calendar'
import { listTrips, removeTrip, saveTrip } from './trips'
import { commitHabit, getBudget, hiddenHabits, hideHabit, setBudgetRollover, setBudgetTier, setCategoryTarget, setCheaperStore, setOneOffBudget, showHabit } from './budget'
import { getDebts, setDebtPlan } from './debts'
import { minimumIn, runDebtPlan, targetOf, type Strategy } from '../shared/debtPlan'
import { hiddenVendors, setHiddenVendors, vendorHider } from './privacy'
import { getVenture, listVentures } from './ventures'
import { claimsThrough, intentParts, moneyQuestions, shareOn, ventureQuestions } from './ventureMoney'
import { dayFrom, daysBetween, isRealDay, shiftMonth } from '../shared/zone'
import { asPayrollKey, PAYSTUB_ITEM_KINDS, PAYSTUB_ITEMS, payeeKey, premiumKind } from '../shared/payroll'
import { ASSET_TYPES, BUDGET_TIERS, INTENT_DIRECTIONS, isDebtType, VENTURE_INTENTS, type VentureIntent, type AssetType, type BenefitKind, type BucketRule, type CalendarEvent, type BenefitPlan, type BucketKind, type ContributionKind, type FactOrigin, type HsaState, type Paystub, type PaystubItem, type PaystubItemKind, type RecurringKind, type Returns, type TaxYear, type TxnSplit, type WithholdingAmounts, taxReturnYear } from '../shared/types'
import type { DebtPlanInputs, GoalView, Lever, OwnerMoney } from '../shared/types'
import type { FeatureId } from '../shared/plans'
import { errorTag } from '../shared/errorTag'

// The review assistant's tools over the app's data. The in-app assistant, the
// tool server Claude Code runs (mcp-server.ts) and the file bridge all use
// them, so this module stays free of Electron imports.

const DAY = 86_400
/** Longest tool result handed back to Claude, in characters. */
export const RESULT_LIMIT = 15_000

const daySpan = daysBetween

// ---------- documents ----------

export { docsDir }

const IGNORED = /^(\.|~\$|desktop\.ini$|thumbs\.db$|CLAUDE.*\.md$)/i

/**
 * The documents waiting for the assistant: every document-type file in the
 * documents folder, named by its path inside it ("Tax/w2.pdf"). Extra folders
 * are only places stored documents may open from, not inboxes: a folder of
 * papers already entered (a whole filing cabinet) must not turn into a
 * thousand new-document issues. Programs, shortcuts and other non-document
 * files are never listed.
 */
export function listDocuments(): Array<{ name: string; path: string; size: number; modified: string; read: boolean; summary: string | null }> {
  // A hosted ledger's documents are the account's uploads (documents.ts).
  const hosted = hostedDocuments()
  if (hosted) return hosted
  const dir = docsDir()
  mkdirSync(dir, { recursive: true })
  const records = db.documentRecords()
  const out: ReturnType<typeof listDocuments> = []
  const walk = (root: string, rel: string, nameOf: (rel: string) => string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (IGNORED.test(e.name)) continue
      const relName = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(root, relName, nameOf)
      else if (e.isFile() && isDocumentName(e.name)) {
        const st = statSync(join(root, relName))
        const name = nameOf(relName)
        const r = records.get(name)
        out.push({ name, path: join(root, relName), size: st.size, modified: db.dayKey(Math.floor(st.mtimeMs / 1000)), read: !!r && r.size === st.size, summary: r?.summary ?? null })
      }
    }
  }
  walk(dir, '', (rel) => rel)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function documentCounts(): { total: number; unread: number } {
  try {
    const docs = listDocuments()
    return { total: docs.length, unread: docs.filter((d) => !d.read).length }
  } catch {
    return { total: 0, unread: 0 }
  }
}
const P2P = /venmo|zelle|cash ?app|square cash|paypal|apple cash/i

const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const money = (cents: number): string => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const date = (unix: number): string => db.dayKey(unix)
const thisMonth = (): string => db.dayKey(db.now()).slice(0, 7)

// ---------- open issues ----------

type IssueKind =
  | 'new_document'
  | 'question'
  | 'uncategorized'
  | 'person_to_person'
  | 'possible_duplicate'
  | 'price_change'
  | 'low_confidence'
  | 'large_purchase'
  | 'recurring_unconfirmed'
  | 'loan_payment_unlinked'
  | 'paystub_mismatch'
  | 'paystub_missing'
  | 'month_gap'
  | 'month_changed'
  | 'retirement_unset'
  | 'asset_attach'
  | 'share_estimate'
  | 'venture_money'
  | 'share_unset'
  | 'venture_paycheck'
  | 'venture_value'
  | 'missing_balance'
  | 'history_gap'

interface Issue {
  key: string
  kind: IssueKind
  summary: string
  transaction_ids?: string[]
  recurring_key?: string
  account_id?: string
}

const PRIORITY: IssueKind[] = ['new_document', 'question', 'uncategorized', 'person_to_person', 'possible_duplicate', 'price_change', 'low_confidence', 'large_purchase', 'recurring_unconfirmed', 'loan_payment_unlinked', 'paystub_mismatch', 'paystub_missing', 'month_gap', 'month_changed', 'retirement_unset', 'asset_attach', 'share_estimate', 'venture_money', 'share_unset', 'venture_paycheck', 'venture_value', 'missing_balance', 'history_gap']

interface TxRow {
  id: string
  posted: number
  merchant: string | null
  description: string
  desc_key: string
  cents: number
  category: string | null
  source: string | null
  confidence: string | null
  account: string
  notes: string | null
}

function groupedIssues(rows: TxRow[], kind: IssueKind, keyOf: (r: TxRow) => string, describe: (g: TxRow[]) => string): Issue[] {
  const groups = new Map<string, TxRow[]>()
  for (const r of rows) {
    const k = keyOf(r)
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [...groups.entries()].map(([k, g]) => ({ key: `${kind}:${k}`, kind, summary: describe(g), transaction_ids: g.slice(0, 30).map((r) => r.id) }))
}

const span = (g: TxRow[]): string => {
  const ds = g.map((r) => r.posted).sort()
  return ds.length > 1 ? `${date(ds[0])} to ${date(ds[ds.length - 1])}` : date(ds[0])
}
const total = (g: TxRow[]): number => g.reduce((s, r) => s + r.cents, 0)

export function openIssues(): Issue[] {
  const resolved = db.resolvedIssueKeys()
  // Whole transactions. A split one has been gone through already: only a double charge can still come up.
  const tx = (where: string, ...params: Array<number | string>): TxRow[] =>
    db.all<TxRow>(
      `SELECT t.id, t.posted, t.merchant, t.description, t.desc_key, t.amount_cents AS cents, c.name AS category,
              t.category_source AS source, t.confidence, a.name AS account, t.notes
       ${db.VISIBLE_TXN_FROM} WHERE ${where} ORDER BY t.posted DESC`,
      ...params
    )
  const issues: Issue[] = []

  for (const q of db.listOpenQuestions()) issues.push({ key: `question:${q.id}`, kind: 'question', summary: q.text })

  issues.push(
    ...groupedIssues(tx(`t.category_id IS NULL AND ${db.NOT_SPLIT}`), 'uncategorized', (r) => `${r.desc_key}|${Math.sign(r.cents)}`, (g) => `${g.length} uncategorized "${g[0].description}" (${money(total(g))}, ${span(g)}, ${g[0].account})`)
  )

  issues.push(
    ...groupedIssues(
      tx(`t.category_source = 'ai' AND t.notes IS NULL AND ${db.NOT_SPLIT}`).filter((r) => P2P.test(r.description)),
      'person_to_person',
      (r) => `${r.desc_key}|${Math.sign(r.cents)}`,
      (g) => `${g.length} ${g[0].cents < 0 ? 'outgoing' : 'incoming'} "${g[0].description}" (${money(total(g))}, ${span(g)}), currently ${g[0].category ?? 'uncategorized'}`
    )
  )

  issues.push(
    ...groupedIssues(
      tx(`t.category_source = 'ai' AND t.confidence = 'low' AND ${db.NOT_SPLIT}`).filter((r) => !P2P.test(r.description)),
      'low_confidence',
      (r) => (r.merchant ?? r.desc_key).toLowerCase(),
      (g) => `Unsure: ${g[0].merchant ?? g[0].description} put in ${g[0].category} (${g.length} transactions, ${money(total(g))})`
    )
  )

  // Same merchant, same amount, within two days: possible double charge.
  const recent = tx('t.posted >= ? AND t.pending = 0 AND t.amount_cents < 0', db.now() - 90 * DAY)
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length && recent[i].posted - recent[j].posted <= 2 * DAY; j++) {
      const a = recent[i]
      const b = recent[j]
      if (a.cents === b.cents && (a.merchant ?? a.desc_key) === (b.merchant ?? b.desc_key) && a.account === b.account) {
        issues.push({ key: `possible_duplicate:${b.id}:${a.id}`, kind: 'possible_duplicate', summary: `Possible double charge: ${a.merchant ?? a.description} ${money(a.cents)} on ${date(b.posted)} and ${date(a.posted)} (${a.account})`, transaction_ids: [b.id, a.id] })
      }
    }
  }

  // Large purchases: Personal's part of a purchase at least $500 and 3x the category's usual size (measured
  // without the purchase itself; a category with little history always counts), from the classifier's lines
  // (spendModel.personalSpending), so a venture's own spending is the venture's to look at.
  const stats = new Map<string, { total: number; n: number }>()
  const mine = new Map<string, number>()
  for (const p of personalSpending(db.now() - 180 * DAY, db.monthStart(shiftMonth(db.today().slice(0, 7), 1)))) {
    if (p.cents <= 0) continue
    const k = p.cat === null ? '' : p.name
    const st = stats.get(k) ?? { total: 0, n: 0 }
    st.total += p.cents
    st.n++
    stats.set(k, st)
    if (p.splitId === null) mine.set(p.id, p.cents)
  }
  // A Personal payment on a venture's series (its place's loan paid from Personal checking) is scheduled too, so
  // every series exempts its payments; the series issues below are Personal's.
  const every = detectRecurring({ scope: 'all' })
  const series = every.filter(isPersonal)
  const recurringKeys = new Set(every.filter((s) => !s.dismissed).map((s) => s.key))
  for (const r of tx(`t.posted >= ? AND t.amount_cents <= -50000 AND (t.category_source IS NULL OR t.category_source NOT IN ('user', 'assistant')) AND t.notes IS NULL AND (c.kind = 'expense' OR c.id IS NULL) AND ${db.NOT_SPLIT}`, db.now() - 60 * DAY)) {
    // Scheduled payments (rent, loans) aren't surprises.
    if (recurringKeys.has(`${(r.merchant ?? r.desc_key).trim().toLowerCase()}|-`)) continue
    const spent = mine.get(r.id) ?? 0
    if (spent < 50_000) continue
    const st = stats.get(r.category ?? '')
    const others = st ? st.n - 1 : 0
    if (others < 3 || spent >= (3 * (st!.total - spent)) / others) {
      issues.push({ key: `large_purchase:${r.id}`, kind: 'large_purchase', summary: `Large purchase: ${r.merchant ?? r.description} ${money(r.cents)} on ${date(r.posted)} (${r.account}), in ${r.category ?? 'no category'}`, transaction_ids: [r.id] })
    }
  }

  for (const s of series) {
    if (s.dismissed || s.status === 'stopped') continue
    if (s.priceChanged && s.status === 'active') {
      issues.push({ key: `price_change:${s.key}:${s.lastDate}`, kind: 'price_change', summary: `${s.name} changed from ${money(s.previousCents)} to ${money(s.lastCents)} on ${date(s.lastDate)}`, recurring_key: s.key })
    }
    if (!s.confirmed) {
      issues.push({ key: `recurring_unconfirmed:${s.key}`, kind: 'recurring_unconfirmed', summary: `Recurring ${s.kind}? ${s.name}: ${s.cadence} ${money(s.typicalCents)} (${s.count} times, last ${date(s.lastDate)}, next ${date(s.nextDate)}, ${s.categoryName ?? 'uncategorized'})`, recurring_key: s.key })
    }
  }

  // A Personal debt whose payments aren't linked can't have them split into interest and principal.
  for (const d of unlinkedDebts()) {
    issues.push({ key: `loan_payment_unlinked:${d.id}`, kind: 'loan_payment_unlinked', summary: `No payment linked to ${d.name} (${money(-(d.balanceCents ?? 0))} owed), so its payments can't be split into interest and principal (link_loan_payment)`, account_id: d.id })
  }

  // Paystubs that don't explain the deposits, one issue per payroll for each: checks whose own stub's net is more
  // than $1 off what was deposited, and a latest check with no stub of its own whose estimate is that far off.
  const payroll = new Map<string, ReturnType<typeof payrollCheckItems>>()
  for (const x of payrollCheckItems()) {
    const k = `${x.item.kind}\u0000${x.item.paycheckKey}`
    payroll.set(k, [...(payroll.get(k) ?? []), x])
  }
  for (const list of payroll.values()) {
    const { kind, paycheckKey } = list[0].item
    const name = paycheckKey!.replace(/\|\+$/, '')
    const last = list[list.length - 1].check
    const each = list.map(({ check: c }) => `${c.day}: net ${money(c.netCents)}, deposited ${money(c.depositCents)}`).join('; ')
    const summary =
      kind === 'paystub_mismatch'
        ? `${name}: ${list.length === 1 ? 'a paystub differs' : `${list.length} paystubs differ`} from what was deposited by more than $1 (${each}); a line on the stub is missing or mistyped, or a deposit is (record_paystub)`
        : `${name}: the latest check, ${last.day}, has no paystub of its own, and the one it's estimated from (${listPaystubs(paycheckKey!).find((s) => s.id === last.stubId)?.payDay ?? 'unknown'}) gives net ${money(last.netCents)} against ${money(last.depositCents)} deposited (record_paystub)`
    issues.push({ key: `${kind}:${paycheckKey}:${last.day}`, kind: kind as IssueKind, summary, recurring_key: paycheckKey, transaction_ids: list.flatMap((x) => x.check.txnIds).slice(0, 30) })
  }

  // Closed months whose cash doesn't tie: one issue for all of them, the newest three with their items and how many
  // more, so a backfill of years raises one. Its key moves when another month joins, so a skipped one comes back then.
  const gaps = gapMonths()
  if (gaps.length) {
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    const shown = gaps.slice(0, 3).map((s) => {
      const items = s.leaks
        .filter((x) => x.kind === 'balance_gap' || x.kind === 'orphan_transfer' || x.kind === 'hidden_account' || x.kind === 'engine_error')
        .map((x) => `${x.kind} ${x.accountId ? `${names.get(x.accountId) ?? x.accountId} ` : ''}${money(x.cents)}${x.fromDay && x.toDay && x.kind === 'balance_gap' ? ` (${x.fromDay} to ${x.toDay})` : ''}`)
      return `${s.month}: Unexplained ${money(s.unexplainedCents)} against a tolerance of ${money(s.toleranceCents)}${items.length ? ` (${items.join(', ')})` : ''}`
    })
    const more = gaps.length - shown.length
    issues.push({
      key: `month_gap:${gaps[0].month}:${gaps.length}`,
      kind: 'month_gap',
      summary: `${gaps.length === 1 ? 'A closed month has' : `${gaps.length} closed months have`} cash that doesn't tie: ${shown.join('; ')}${more ? `; and ${more} more` : ''}. A missing transaction, a balance or a transfer's other side explains it; then close_month closes the month again`,
      transaction_ids: [...new Set(gaps.slice(0, 3).flatMap((s) => s.leaks.flatMap((x) => x.txnIds ?? [])))].slice(0, 30)
    })
  }

  // Closed months whose figures changed since they were closed: one issue for all of them, the months grouped by the
  // cause that changed them together (a rule that restated 14 months is one line of it). Its key moves when a month
  // joins, so a skipped one comes back then.
  const changed = changedMonths()
  if (changed.length) {
    const batches = new Map<string, typeof changed>()
    for (const c of [...changed].reverse()) {
      const list = batches.get(c.batch)
      if (list) list.push(c)
      else batches.set(c.batch, [c])
    }
    const span = (list: typeof changed): string => {
      const months = list.map((c) => c.month)
      return months.length <= 3 ? months.join(', ') : `${months[0]} to ${months[months.length - 1]}`
    }
    const shown = [...batches.values()].map((list) => `${list[0].label} restated ${list.length === 1 ? '1 month' : `${list.length} months`} (${span(list)})`)
    issues.push({
      key: `month_changed:${changed[0].month}:${changed.length}:${batches.size}`,
      kind: 'month_changed',
      summary: `${changed.length === 1 ? 'A closed month has changed since it closed' : `${changed.length} closed months have changed since they closed`}: ${shown.join('; ')}. accept_close_changes keeps the new figures as each month's next version once the user agrees; to go back, undo the change itself`
    })
  }

  // The retirement line under Invested grows what's invested at the user's own return to their own retirement age;
  // none has a default. With money invested and any of them unset, one issue asks for them.
  const retire = retirementSettings()
  const unset = (
    [
      ['birthYear', 'birth year'],
      ['age', 'retirement age'],
      ['realReturnBp', 'real return']
    ] as Array<[keyof RetirementSettings, string]>
  ).filter(([k]) => retire[k] === null)
  const invested = unset.length ? investedBalance() : 0
  if (invested > 0) {
    const names = unset.map(([, name]) => name)
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
    issues.push({
      key: 'retirement_unset',
      kind: 'retirement_unset',
      summary: `${money(invested)} is invested, and the ${list} the retirement line grows it with ${unset.length > 1 ? "aren't" : "isn't"} set: ask the user for their own (set_retirement, with the inflation they expect for cash above their goals); none is assumed`
    })
  }

  // With more than one house, or vehicle, Personal's costs of that kind can't go on one by themselves.
  for (const q of attachQuestions()) {
    const kind = q.type === 'property' ? 'houses' : 'vehicles'
    const costs = q.type === 'property' ? 'housing, utilities and home insurance' : 'fuel, upkeep and auto insurance'
    issues.push({
      key: `asset_attach:${q.type}`,
      kind: 'asset_attach',
      summary: `Personal has ${q.assets.length} ${kind} (${q.assets.map((a) => `${a.name} [${a.id}]`).join(', ')}): ${q.count} ${costs} costs (${money(q.cents)}, ${q.fromDay} to ${q.toDay}) are on none of them (add_bucket_rule with asset_id, or place_on_asset)`,
      transaction_ids: q.txnIds
    })
  }

  // A use share that's an estimate: one issue per asset until its uses name what they're measured by, and one per
  // venture with residence dates and no house to put Personal's use on.
  for (const q of shareQuestions()) {
    if (q.venture) {
      const v = q.venture
      issues.push({
        key: `share_estimate:venture:${v.id}`,
        kind: 'share_estimate',
        summary: `${v.name} has residence dates (${v.fromDay} to ${v.toDay ?? 'now'}) and no house, so all its costs in them count as Personal's: add the house (add_asset, then update_account with its bucket); when the books next open, the dates become Personal's use of it, to measure by rooms or area (set_asset_use)`
      })
      continue
    }
    const a = q.asset!
    const spans = new Map<string, string[]>()
    for (const u of q.uses) {
      const span = `${u.fromDay} to ${u.toDay ?? 'now'}`
      spans.set(span, [...(spans.get(span) ?? []), `${bucketLabel(u.bucketId)} ${u.shareBp / 100}%`])
    }
    const from = q.uses.every((u) => u.source === 'migrated') ? ", from its venture's residence dates," : ''
    issues.push({
      key: `share_estimate:${a.id}`,
      kind: 'share_estimate',
      summary: `${a.name} [${a.id}]: its use${from} isn't measured (${[...spans].map(([span, owners]) => `${span}: ${owners.join(' · ')}`).join('; ')}): how much of it is each owner's, by rooms, area or miles (set_asset_use with basis), never from the rent`,
      account_id: a.id
    })
  }

  // Each venture's share as net worth counts it (sub-phase 1j): one issue per venture whose share is still the one it
  // had before shares were kept, while money crosses to it, and one per venture the user owns part of with nothing to
  // value its stake by.
  const ventures = ventureQuestions()
  for (const v of ventures.shareUnset) {
    const held = [v.accounts ? `${v.accounts} ${v.accounts === 1 ? 'account' : 'accounts'} it holds` : '', v.crossing ? `${v.crossing} ${v.crossing === 1 ? 'line' : 'lines'} of money between it and Personal` : ''].filter(Boolean).join(' and ')
    issues.push({
      key: `share_unset:${v.id}`,
      kind: 'share_unset',
      summary: `${v.name}: net worth counts ${v.shareBp / 100}% of it, the share it had before shares were kept (${held}): ask what share of it the user owns and from when (set_venture_share), and whether its books or a Stakes account value the stake (set_venture_value)`
    })
  }
  for (const v of ventures.noValue) {
    issues.push({
      key: `venture_value:${v.id}`,
      kind: 'venture_value',
      summary: `${v.name}: the user owns ${v.shareBp / 100}% of it today, and it holds no account and has no Stakes account linked, so its stake counts as 0 (what's lent, borrowed or due still counts): put its accounts in it, or link a Stakes account holding the stake's value (set_venture_value)`
    })
  }
  // A Stakes account a venture holds is counted as the venture's own money, and scaled by the share.
  const held = new Map<number, typeof ventures.heldStakes>()
  for (const s of ventures.heldStakes) held.set(s.id, [...(held.get(s.id) ?? []), s])
  for (const [id, list] of held) {
    const name = list[0].name
    const accts = list.map((s) => `${s.accountName} [${s.accountId}]`).join(', ')
    issues.push({
      key: `venture_value:${id}:${list.map((s) => s.accountId).join(',')}`,
      kind: 'venture_value',
      summary: `${name} holds ${accts}, ${list.length === 1 ? 'a Stakes account' : 'Stakes accounts'}: its books count ${list.length === 1 ? 'it' : 'them'} as ${name}'s own money, so a share below 100% would scale the user's own estimate of their stake. Take ${list.length === 1 ? 'it' : 'them'} out of ${name} (update_account) and link the stake (set_venture_value with source estimate) before recording a share`,
      account_id: list[0].accountId
    })
  }

  // Money between Personal and a venture with no intent stays in the Ventures term until Review says what it is: one
  // issue per pattern (the venture, the kind of line, the way the money went and a transfer's payee), so years of
  // transfers ask once, and one per account a venture holds that pay lands on. Each key moves when a line joins, so
  // a skipped one comes back then.
  const crossings = moneyQuestions()
  for (const p of crossings.patterns) {
    const name = bucketLabel(p.ventureId)
    // A transfer with no merchant is its pattern by the account or debt on its other side.
    const side = p.payeeKey?.startsWith('account:') ? p.payeeKey.slice('account:'.length).replace(/\|[+-]$/, '') : null
    const payee = side !== null ? `with ${db.listAccounts().find((a) => a.id === side)?.name ?? side}` : p.payeeKey ? `"${p.payeeKey.replace(/\|[+-]$/, '')}"` : ''
    const what = {
      T: p.direction === 'out' ? `of transfers to ${name} from the user's accounts (${payee})` : `of transfers from ${name} into the user's accounts (${payee})`,
      C: p.direction === 'out' ? `of ${name}'s costs paid from the user's cash and cards` : `of ${name}'s revenue received in the user's accounts`,
      F: p.direction === 'out' ? `of the user's money received into ${name}'s accounts` : `of Personal costs ${name}'s cash and cards paid`
    }[p.shape]
    const amounts = p.amounts.map((a) => `${money(a.cents)} × ${a.count}`).join(', ')
    issues.push({
      key: `venture_money:${p.ventureId}:${p.shape}:${p.direction}${p.payeeKey ? `:${p.payeeKey}` : ''}:${p.toDay}`,
      kind: 'venture_money',
      summary: `${p.count} ${p.count === 1 ? 'line' : 'lines'} ${what} ${p.count === 1 ? 'has' : 'have'} no intent (${money(Math.abs(p.cents))} ${p.direction === 'out' ? 'out' : 'in'}, ${p.fromDay === p.toDay ? p.fromDay : `${p.fromDay} to ${p.toDay}`}; ${amounts}), so ${p.count === 1 ? 'it stays' : 'they stay'} in the Ventures term: ask the user what ${p.count === 1 ? 'it was' : 'they were'} (set_venture_money, with remember for later lines like ${p.count === 1 ? 'it' : 'them'})`,
      transaction_ids: p.txnIds.slice(0, 30)
    })
  }
  // Intents stored on lines that no longer cross with their venture count nowhere: one issue per venture.
  for (const s of crossings.stale) {
    const name = bucketLabel(s.ventureId)
    issues.push({
      key: `venture_money:${s.ventureId}:stale:${s.count}:${s.toDay}`,
      kind: 'venture_money',
      summary: `${s.count} ${s.count === 1 ? 'line has an intent' : 'lines have intents'} with ${name} that no longer ${s.count === 1 ? 'fits it' : 'fit them'} (${money(Math.abs(s.cents))}, ${s.fromDay === s.toDay ? s.fromDay : `${s.fromDay} to ${s.toDay}`}): an account left ${name}, or a transfer's other side or a line's venture changed, so ${s.count === 1 ? 'it counts' : 'they count'} nowhere. Ask the user: clear ${s.count === 1 ? 'it' : 'them'} (set_venture_money, intent none), or put the account or line back`,
      transaction_ids: s.txnIds.slice(0, 30)
    })
  }
  for (const p of crossings.paychecks) {
    const name = bucketLabel(p.ventureId)
    const acct = db.listAccounts().find((a) => a.id === p.accountId)?.name ?? p.accountId
    issues.push({
      key: `venture_paycheck:${p.accountId}`,
      kind: 'venture_paycheck',
      summary: `${acct} is ${name}'s, and ${p.count} ${p.count === 1 ? 'paycheck lands' : 'paychecks land'} on it (${money(p.cents)}, ${p.fromDay === p.toDay ? p.fromDay : `${p.fromDay} to ${p.toDay}`}): pay stays the user's, and its money into ${name}'s account counts in the Ventures term until Review says what it is. Take the account out of the venture (update_account), or give the paychecks' funding an intent (set_venture_money, such as equity)`,
      account_id: p.accountId,
      transaction_ids: p.txnIds.slice(0, 30)
    })
  }

  const accounts = db.listAccounts()
  for (const a of accounts) {
    if (!a.hidden && a.balanceCents === null) issues.push({ key: `missing_balance:${a.id}`, kind: 'missing_balance', summary: `No balance for ${a.name} (${a.source}), so it's left out of net worth`, account_id: a.id })
  }

  // Accounts whose records start well after the earliest history: before their
  // first record, net worth holds their earliest balance flat.
  const counted = accounts.filter((a) => !a.hidden && a.balanceCents !== null && a.historyFrom)
  const earliest = counted.map((a) => a.historyFrom!).sort()[0]
  const late = counted
    .filter((a) => a.source !== 'manual' && !a.openedDay && Math.abs(a.balanceCents!) >= 50_000 && daySpan(earliest, a.historyFrom!) > 31)
    .sort((a, b) => Math.abs(b.balanceCents!) - Math.abs(a.balanceCents!))
  if (late.length) {
    issues.push({
      key: `history_gap:${earliest}`,
      kind: 'history_gap',
      summary: `Net worth history starts ${earliest}, but these accounts' records start later, so earlier balances are a flat guess: ${late
        .slice(0, 12)
        .map((a) => `${a.name} [${a.id}] ${money(a.balanceCents!)} from ${a.historyFrom}`)
        .join('; ')}. Statement or year-end balances fix this (record_balance), as does an opened date for accounts that didn't exist yet.`
    })
  }

  // By name only: the full path (with the user's name in it) stays on the PC. Reading documents is a Plus feature.
  if (can('documents')) {
    for (const d of listDocuments().filter((x) => !x.read)) {
      issues.push({ key: `new_document:${d.name}|${d.size}`, kind: 'new_document', summary: `New document: ${d.name} (${Math.ceil(d.size / 1024)} KB, modified ${d.modified})` })
    }
  }

  // Hidden vendors stay out of habits, lists and the headline, not out of the review: a charge still gets looked at.
  return issues.filter((i) => !resolved.has(i.key)).sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))
}

export function issueCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const i of openIssues()) counts[i.kind] = (counts[i.kind] ?? 0) + 1
  return counts
}

// ---------- tools ----------

/**
 * What a tool does to the data: read, an ordinary write, or destructive
 * (deleting, forgetting, hiding). A destructive call from the review assistant
 * isn't run; it waits for the user's approval in the Review chat.
 */
export type ToolRisk = 'read' | 'write' | 'destructive'
export type ToolDef = Anthropic.Beta.BetaTool & { risk: ToolRisk }

const str = { type: 'string' } as const
const eventFields = {
  start_time: { type: ['string', 'null'], description: 'HH:MM, 24-hour, in the user\'s local time; null or left out: all day' },
  end_time: { type: 'string', description: 'HH:MM, same day' },
  duration_minutes: { type: 'number', description: 'instead of end_time; default 60, or the event\'s current length' },
  task: { type: 'boolean', description: 'a to-do the user checks off (a call, a booking, a payment, a form, papers to get, something to check), synced to Google Tasks; false for what just happens on the day (a purchase or payroll change going through, a renewal) and for appointments. All day only.' }
} as const
/** The kinds a recurring series can be given (update_recurring). */
const RECURRING_KINDS: readonly RecurringKind[] = ['subscription', 'bill', 'loan', 'income', 'transfer', 'other']
export const TOOLS: ToolDef[] = [
  {
    name: 'get_open_issues',
    risk: 'read',
    description: 'List what still needs the user\'s input, highest priority first: new documents, saved questions only the user can answer (kind question; close with answer_question), uncategorized transactions, unexplained person-to-person payments, possible double charges, price changes, low-confidence categories, large purchases, unconfirmed recurring series, debts with no payment linked, closed months whose cash doesn\'t tie (month_gap, one issue for all of them), closed months whose figures changed since they closed (month_changed, one issue grouping them by what changed them; accept_close_changes keeps the new figures), retirement settings not set while money is invested (retirement_unset), costs that could be any of several Personal houses or vehicles (asset_attach), use shares that are estimates (share_estimate), ventures whose share is still the one net worth counted before shares were kept (share_unset), ventures the user owns part of with nothing to value the stake by, or that hold a Stakes account themselves (venture_value), money between the user and a venture with no intent, one issue per pattern, or intents that no longer fit their lines (venture_money; answer with set_venture_money, remember for a pattern\'s later lines), accounts a venture holds that pay lands on (venture_paycheck), and accounts with no balance. Each issue has a key to pass to resolve_issue.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'search_transactions',
    risk: 'read',
    description: 'Search transactions. All filters optional. Amounts are dollars; min_amount/max_amount compare absolute values. Dates are YYYY-MM-DD. Returns at most `limit` rows (default 25, max 100), newest first. A split transaction comes with its parts, and category and bucket match any part.',
    input_schema: {
      type: 'object',
      properties: { query: { ...str, description: 'text in merchant, description or note' }, category: { ...str, description: 'category name, or "Uncategorized"' }, bucket: { ...str, description: 'a bucket name, or "Personal" for everything that\'s Personal\'s: not in a bucket (a line placed in Personal on a bucket\'s account included), plus a bucket\'s costs of a house Personal uses on their day (its use share, set_asset_use)' }, account: { ...str, description: 'part of an account name' }, from: str, to: str, min_amount: { type: 'number' }, max_amount: { type: 'number' }, limit: { type: 'integer' }, tag: str }
    }
  },
  {
    name: 'spending_summary',
    risk: 'read',
    description: 'Totals of spending and income between two dates (YYYY-MM-DD, end exclusive), grouped by category, merchant, month or bucket, as { groups, levers }. Covers Personal money only unless `bucket` says otherwise, like Home. Personal\'s are the waterfall\'s on Home: spending is Committed, Everyday and One-offs (bills and subscriptions, interest and escrow on debts, everyday spending and one-offs, less one-off income such as a reimbursement), and income is Take-home (pay as deposited and other income, less income tax paid from the bank; a refund adds). By category, a loan\'s interest paid by a transfer is under the loan\'s name. Uncategorized money is in neither but shown as unsorted; interest and dividends on cash (Growth), money moved between the user\'s own accounts or to savings, investments or debts, a loan\'s principal and assets bought or sold are in neither. Personal counts its use share of a bucket\'s house costs (set_asset_use). A bucket\'s are its cash in and out by category, transfers left out; "all" is Personal\'s and every bucket\'s together, a cost they share by use counted once, whole. levers: what would move Personal\'s waterfall most at the span\'s end, as Home lists them (monthly dollars, apr_pct, rate_pts).',
    input_schema: { type: 'object', properties: { from: str, to: str, group_by: { type: 'string', enum: ['category', 'merchant', 'month', 'bucket'] }, bucket: { ...str, description: '"Personal" (default), a bucket name, or "all"' } }, required: ['from', 'to', 'group_by'] }
  },
  {
    name: 'categorize',
    risk: 'write',
    description: 'Set the category (and optionally a clean merchant name) on specific transactions, as the user\'s own decision. With remember=true, also save a rule so future transactions from this merchant get the same category. Category "Uncategorized" clears it so the next categorization run decides again.',
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, category: str, merchant: str, remember: { type: 'boolean' } }, required: ['transaction_ids', 'category'] }
  },
  {
    name: 'create_rule',
    risk: 'write',
    description: 'Always categorize matching transactions a certain way, now and in future. field "merchant" matches the clean merchant name exactly; "contains" matches text (at least 3 characters) inside the raw bank description. Applies immediately to existing transactions the user hasn\'t set by hand; a rule that would change more than 200 of them waits for the user\'s approval instead.',
    input_schema: { type: 'object', properties: { field: { type: 'string', enum: ['merchant', 'contains'] }, pattern: str, category: str }, required: ['field', 'pattern', 'category'] }
  },
  {
    name: 'create_category',
    risk: 'write',
    description: 'Add a category. kind: expense (counts as spending), income, or transfer (money moving between the user\'s own accounts; excluded from spending and income).',
    input_schema: { type: 'object', properties: { name: str, kind: { type: 'string', enum: ['expense', 'income', 'transfer'] }, description: { ...str, description: 'what belongs in it' } }, required: ['name', 'kind'] }
  },
  {
    name: 'list_contributions',
    risk: 'read',
    description: "Paycheck contributions into savings plans (each 401(k), Roth 401(k), HSA, ESPP): election %, the user's and the employer's amount per paycheck, the match rule, this year so far and by Dec 31 at current elections, and the yearly limits they count toward (401(k) elective deferrals across all employers, pre-tax and Roth together; HSA self-only). Employer match doesn't count toward the deferral limit.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_contribution',
    risk: 'write',
    description: "Add or update a contribution plan by name (fields left out stay as they are). Amounts are dollars per paycheck. ytd is the user's own contributions so far this year as of ytd_as_of (from a paystub or the plan's statement); paychecks after that date are added automatically at the per-paycheck amount. For an election change that hasn't reached payroll yet, give next_percent, next_per_paycheck and next_from (the first paycheck date it applies to); clear them once the new amount is the per_paycheck. paycheck_key is the recurring key of the paycheck it comes out of (from list_recurring, e.g. 'acme payroll|+'). starts: the first paycheck it came out of (months before it show no contribution). ends: the last paycheck date for a job that ended. match_rate_pct and match_cap_pct are the match as its rule, read from match_note or the plan's documents: 50% of the first 6% is match_rate_pct 50 and match_cap_pct 6; null clears them.",
    input_schema: {
      type: 'object',
      properties: {
        name: str,
        kind: { type: 'string', enum: ['401k', 'roth_401k', 'hsa', 'espp'] },
        account_id: str,
        paycheck_key: str,
        percent: { type: 'number' },
        per_paycheck: { type: 'number' },
        match_per_paycheck: { type: 'number' },
        match_note: str,
        match_rate_pct: { type: ['number', 'null'] },
        match_cap_pct: { type: ['number', 'null'] },
        ytd: { type: 'number' },
        ytd_as_of: str,
        starts: str,
        ends: str,
        next_percent: { type: 'number' },
        next_per_paycheck: { type: 'number' },
        next_from: str,
        notes: str
      },
      required: ['name', 'kind']
    }
  },
  {
    name: 'delete_contribution',
    risk: 'destructive',
    description: 'Remove a contribution plan by name.',
    input_schema: { type: 'object', properties: { name: str }, required: ['name'] }
  },
  {
    name: 'record_paystub',
    risk: 'write',
    description: "Record one paystub, every line as the stub shows it, for Gross pay and the rows into Take-home. paycheck_key: the payroll's key (list_recurring or list_contributions, e.g. 'acme payroll|+'); a paystub can come before its deposit does. pay_day: the stub's pay date. kind: regular (the default), bonus (a bonus or other off-cycle check) or final. gross: gross pay this check. items: one for each line taken out, with kind (taxes: federal, social_security, medicare, state, local, sdi, other_tax; benefits: medical, dental, vision, life, disability, fsa, dependent_care, commuter, other_deduction; savings plans: 401k, roth_401k, after_tax_401k, 403b, 457, hsa, espp), name as the stub prints it, amount this check, ytd when the stub shows the year to date, pretax when it's taken before income tax (a savings plan's is its kind's: roth_401k, after_tax_401k and espp after, the rest before), and employer: what the employer put in beside it this check (the 401(k) match, its HSA money, its share of a premium). net: the stub's net pay, which must equal gross less the items. Dollars. document: the stub's name from list_documents. A stub for the same payroll, pay day and kind is replaced. Checks without a stub of their own are estimated from the payroll's nearest stub, so record the latest stub, and one for each raise or election change.",
    input_schema: {
      type: 'object',
      properties: {
        paycheck_key: str,
        pay_day: str,
        kind: { type: 'string', enum: ['regular', 'bonus', 'final'] },
        period_from: str,
        period_to: str,
        gross: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: PAYSTUB_ITEM_KINDS }, name: str, amount: { type: 'number' }, ytd: { type: 'number' }, pretax: { type: 'boolean' }, employer: { type: 'number' } },
            required: ['kind', 'amount']
          }
        },
        net: { type: 'number' },
        document: str
      },
      required: ['paycheck_key', 'pay_day', 'gross', 'items']
    }
  },
  {
    name: 'set_paycheck_withholding',
    risk: 'write',
    description: "record_paystub's older form, for a paystub's taxes and premiums on its pay date (as_of): federal income tax, Social Security (OASDI), Medicare, state income tax, each insurance premium, and anything else that isn't a savings plan (other). Also gross pay. Dollars per paycheck; fields left out stay as the payroll's stub nearest before has them, insurance replaces the whole list, and the savings plans come from that stub or from list_contributions' elections. Net is gross less every line. Insurance: one entry per premium, named by type ('Medical insurance', 'Dental insurance', 'Vision insurance', 'Disability insurance', 'Life insurance'), pretax true when the paystub lists it under pre-tax deductions. paycheck_key is the payroll's key (as in list_contributions, e.g. 'acme payroll|+'). Prefer record_paystub, which takes every line.",
    input_schema: {
      type: 'object',
      properties: {
        paycheck_key: str,
        as_of: str,
        gross: { type: 'number' },
        federal: { type: 'number' },
        social_security: { type: 'number' },
        medicare: { type: 'number' },
        state: { type: 'number' },
        insurance: {
          type: 'array',
          items: { type: 'object', properties: { type: str, per_paycheck: { type: 'number' }, pretax: { type: 'boolean' } }, required: ['type', 'per_paycheck', 'pretax'] }
        },
        other: { type: 'number' },
        net: { type: 'number' }
      },
      required: ['paycheck_key', 'as_of']
    }
  },
  {
    name: 'delete_paycheck_withholding',
    risk: 'destructive',
    description: "Remove a payroll's latest paystub (one recorded by mistake); its earlier stubs stay. A job that ended keeps its stubs, which explain its past checks.",
    input_schema: { type: 'object', properties: { paycheck_key: str }, required: ['paycheck_key'] }
  },
  {
    name: 'list_buckets',
    risk: 'read',
    description: 'Buckets: parts of the user\'s finances kept apart from everyday Personal money (a rental property, a business, a person they support), each with money in and out, date span, rules, the user\'s share of it today (share_pct), what values their stake (value_source: its books, or the Stakes account stake_account_id), their position in it as net worth counts it (position: what it owes them less what they owe it, plus the stake), and its result (operating, its assets\' gains realized and on paper, and their total; bucket_summary has the detail). A transaction\'s category says what it was; its bucket says which part of life it belongs to. Personal views (Home, its headline, spending_summary) leave buckets out by default. A house the user lives or lived in that a bucket holds or uses (rooms rented while living there, a home later rented out) has use shares (set_asset_use): its costs then are a Personal use share, Personal\'s and not the bucket\'s, and its income stays with the bucket alone.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'bucket_summary',
    risk: 'read',
    description: 'One bucket in detail: money in, out and net by year, by category and by payee, plus its accounts, assets and rules, and its result. Operating: money in and out without the money that bought, sold or lent its assets (left_out_of_operating) and without loan principal (repairs and improvements stay in). Each asset\'s gain or loss: realized once sold (sale price less selling costs less cost), on paper while owned (value less cost); money lent: paid back plus still owed less lent; an investment account\'s is its change in value less the money put in; null without a cost (named in missing_cost, left out of the totals). Total: operating plus gains. equity_paid_down is the loan principal the venture\'s own spending paid, already inside the gains (cost includes the loan), never added again. personal_use: for each use that shares one of its places with Personal, Personal\'s share and Personal\'s part of the costs then, which operating leaves out (operating plus personal_use is its operating bearing those costs whole).',
    input_schema: { type: 'object', properties: { bucket: str }, required: ['bucket'] }
  },
  {
    name: 'create_bucket',
    risk: 'write',
    description: "Add a bucket. kind: rental, business, person or other. in_net_worth (default true) is the user's share of it: true is 100% from the start, false 0% (someone they support, whose money isn't theirs); set a dated share with set_venture_share. A place the user lives or lived in is Personal's use of its house (set_asset_use), not dates on the bucket.",
    input_schema: { type: 'object', properties: { name: str, kind: { type: 'string', enum: ['rental', 'business', 'person', 'other'] }, description: str, in_net_worth: { type: 'boolean' } }, required: ['name', 'kind'] }
  },
  {
    name: 'update_bucket',
    risk: 'write',
    description: "Rename a bucket or change its kind or notes. in_net_worth, when given, replaces its share: true is 100% from the start, false 0%, and any dated shares go (set_venture_share keeps them). When the user lived or lives in its place, set Personal's use of the house with set_asset_use.",
    input_schema: { type: 'object', properties: { bucket: str, name: str, kind: { type: 'string', enum: ['rental', 'business', 'person', 'other'] }, description: str, in_net_worth: { type: 'boolean' } }, required: ['bucket'] }
  },
  {
    name: 'set_venture_share',
    risk: 'write',
    description: "Record the user's ownership share of a venture from a day on (YYYY-MM-DD), in percent with up to two decimals, 0 to 100: it holds until a later row. share_pct null removes the row on that day. Net worth counts the venture as the user's claims on it (money lent, borrowed and due) plus this share of its net assets (its accounts less those claims), or a Stakes account's estimate (set_venture_value). A venture whose share is still the one net worth counted it at before shares were kept (100% or 0%) raises share_unset: ask the user what they own of it and since when.",
    input_schema: { type: 'object', properties: { venture: str, from: str, share_pct: { type: ['number', 'null'] } }, required: ['venture', 'from', 'share_pct'] }
  },
  {
    name: 'set_venture_money',
    risk: 'write',
    description:
      "Say what money between the user and a venture was (its intent), so the waterfall counts it as what it is and not as Ventures. The lines are transfers to or from the venture's accounts, the venture's costs or revenue paid from or into the user's own cash and cards, a Personal cost the venture's cash or card paid (its funding, minus the line), or another Personal line tied to the venture (a share bought from a co-owner). intent: loan (lent to it), loan_repayment (it paid back; interest is the interest, the rest principal), equity (put in, or a share bought), capital_return (capital back, or part of the share sold), gift (no claim and no ownership: support, a starting donation, a gift received), draw (a draw or distribution; regular true for one paid every month), reimbursement (a cost paid for the other side, or paying one back), venture_loan (it lent to the user), venture_loan_repayment (paying its loan back; interest is the interest), salary (pay from it), trade (rent, goods or services bought from or sold to it), other, or none to remove what was set. Out of Personal fits loan, equity, venture_loan_repayment, gift, reimbursement, trade and other; into Personal fits the rest. parts [{intent, amount}] in dollars splits one line among several intents (a transfer that was part loan, part equity); they add up to the line, or to the funding. interest (dollars) is each line's repayment's interest. share_after_pct (one transaction, with equity or capital_return) is the user's share of the venture from that day, as set_venture_share sets it; equity or capital_return needs it while the venture's share is still the one it had before shares were kept. remember true (one intent, no parts, interest or share) has the lines' pattern take this intent from now on. A line marked as capital (mark_capital) or one a capital window takes is refused: that money already counts there.",
    input_schema: {
      type: 'object',
      properties: {
        transaction_ids: { type: 'array', items: str },
        venture: str,
        intent: { type: 'string', enum: [...VENTURE_INTENTS, 'none'] },
        parts: { type: 'array', items: { type: 'object', properties: { intent: { type: 'string', enum: [...VENTURE_INTENTS] }, amount: { type: 'number' } }, required: ['intent', 'amount'] } },
        interest: { type: 'number' },
        share_after_pct: { type: 'number' },
        regular: { type: 'boolean' },
        remember: { type: 'boolean' }
      },
      required: ['transaction_ids', 'venture', 'intent']
    }
  },
  {
    name: 'set_venture_value',
    risk: 'write',
    description: "Say what a venture's stake is valued by. source books: the user's share of its net assets, from the accounts it holds. source estimate: the value of a Personal Stakes account (type venture, from list_accounts) that holds the user's own estimate of the stake. stake_account_id links one (null unlinks it; left out keeps the one linked); an estimate needs one. A linked Stakes account counts only as the stake, never as an account of its own, so it is never counted twice; unmark capital on its lines first (mark_capital). A venture the user owns part of with no account and no Stakes account raises venture_value.",
    input_schema: { type: 'object', properties: { venture: str, source: { type: 'string', enum: ['books', 'estimate'] }, stake_account_id: { type: ['string', 'null'] } }, required: ['venture', 'source'] }
  },
  {
    name: 'mark_one_time',
    risk: 'write',
    description: 'Mark purchases as durable one-offs (furniture, a mattress, a laptop, a bike, a piano: things that last years) or unmark them, and things paid for a trip outside its dates (a deposit, a ticket bought months ahead). They count as one-offs: under Saved on Home and against the one-off budget, not in Everyday (Shopping, Travel, Gifts & Donations, Education and Other count as one-offs already unless bought as a habit, and so does anything bought during a trip). Use one_time false to undo.',
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, one_time: { type: 'boolean' } }, required: ['transaction_ids', 'one_time'] }
  },
  {
    name: 'add_trip',
    risk: 'write',
    description: 'Record time the user is away (a trip abroad, a long visit), past or planned. Everything bought from the first day through a few days after the last (cards post late), except recurring bills, is a one-off for that trip (under Saved on Home), not in Everyday, so meals and rides away don\'t count against eating-out habits or a category\'s target. Pass id to change one.',
    input_schema: { type: 'object', properties: { name: { ...str, description: 'short, e.g. "Iceland"' }, from: { ...str, description: 'first day away, YYYY-MM-DD' }, to: { ...str, description: 'last day away, YYYY-MM-DD' }, id: str }, required: ['name', 'from', 'to'] }
  },
  {
    name: 'list_trips',
    risk: 'read',
    description: 'Trips recorded with add_trip.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'hide_vendor',
    risk: 'destructive',
    description: 'Hide a vendor (a store or merchant name, e.g. "Main St Pharmacy") so the app never calls it out: no habits, top-merchant lists, one-off lists or insights name it, while its spending still counts in every total and the transaction list. hidden false shows it again. Returns the hidden list.',
    input_schema: { type: 'object', properties: { vendor: str, hidden: { type: 'boolean' } }, required: ['vendor'] }
  },
  {
    name: 'list_habits',
    risk: 'read',
    description: "This month's habits, which Home's Left over drill lists under their categories (a commitment for the one-offs under Saved's One-offs): each habit as measured lately, the commitments it offers (specific actions with what each saves a month), and any commitment made with how the month is going against it.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'commit_habit',
    risk: 'write',
    description: 'Record a commitment the user makes about a habit (an id from list_habits, and one of its option ids), so Home\'s Left over drill shows it under the habit\'s category with how the month is going, and its savings become part of that category\'s target. undo true removes the commitment. hide true takes a habit off for good, including one not listed yet (a store habit\'s id is "store:<Category>:<Store>"); hide false shows that hidden habit again, and with habit "all" every hidden one.',
    input_schema: { type: 'object', properties: { habit: str, option: str, undo: { type: 'boolean' }, hide: { type: 'boolean' } }, required: ['habit'] }
  },
  {
    name: 'set_category_target',
    risk: 'write',
    description: "Set a category's monthly budget target (amount in dollars; null goes back to the suggestion from history), replacing whatever habit commitments set it, and/or turn its rollover on or off. Home's Left over drill shows each category's target beside it, with what rolled over into the month. With rollover on, each month's leftover, or overspend, carries into the next month's available, starting from this month; turned off and on again, it starts afresh. A target counts from this month on; earlier months keep theirs.",
    input_schema: { type: 'object', properties: { category: str, amount: { type: ['number', 'null'] }, rollover: { type: 'boolean' } }, required: ['category'] }
  },
  {
    name: 'set_category_tier',
    risk: 'write',
    description:
      "Set what a spending category is: essential, lifestyle or oneoff (null goes back to its default: Shopping, Travel, Gifts & Donations, Education and Other are one-offs, housing, utilities, insurance, groceries, health, gas, transportation, taxes, pets and fees are essentials, the rest lifestyle). Home's Left over drill marks each category E by it, and L otherwise (a one-off tier too); Spendable forecasts an essential's purchases from a cash account; a one-off category's purchases count against the one-off budget and its habit, not a target. Commitments made for the category are dropped. Home's rows and closed months read the default tiers with the habit rule, so none of their figures move.",
    input_schema: { type: 'object', properties: { category: str, tier: { type: ['string', 'null'], enum: [...BUDGET_TIERS.map((t) => t.id), null] } }, required: ['category', 'tier'] }
  },
  {
    name: 'set_cheaper_store',
    risk: 'write',
    description: 'Name the grocer the user could buy groceries at instead (a store name as the bank shows it, e.g. "Aldi"), so the habits offer one measured against it: what other grocers cost a month, and what moving trips there would save. null names none, and that habit goes.',
    input_schema: { type: 'object', properties: { store: { type: ['string', 'null'] } }, required: ['store'] }
  },
  {
    name: 'set_one_off_budget',
    risk: 'write',
    description: "Set the one-off budget a month (amount in dollars; null goes back to the average of the last six months), replacing whatever habit commitments set it. Home's Saved drill shows it beside One-offs, and debt_plan's at_targets reads it.",
    input_schema: { type: 'object', properties: { amount: { type: ['number', 'null'] } }, required: ['amount'] }
  },
  {
    name: 'remove_trip',
    risk: 'write',
    description: 'Remove a trip (by id or name); what was bought then is counted by its category again (Everyday, or a one-off by default).',
    input_schema: { type: 'object', properties: { trip: str }, required: ['trip'] }
  },
  {
    name: 'set_bucket',
    risk: 'write',
    description: 'Put specific transactions in a bucket, or back in Personal (bucket "Personal"), as the user\'s decision. Their categories stay as they are.',
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, bucket: str }, required: ['transaction_ids', 'bucket'] }
  },
  {
    name: 'add_bucket_rule',
    risk: 'write',
    description: "Always put matching transactions in a bucket, or on an asset (asset_id, a house, vehicle or other asset from list_accounts: its costs are then shared by its uses, set_asset_use), one or the other: on one account, in one category and/or with text in the description or merchant, optionally only at an exact amount (dollars, either direction: one installment plan among several) and between two dates (YYYY-MM-DD, inclusive). A line can be in a bucket by one rule and on an asset by another. Applies now and to future transactions, except ones placed by hand; income and transfers never go on an asset.",
    input_schema: { type: 'object', properties: { bucket: str, asset_id: str, account_id: str, category: str, contains: str, amount: { type: 'number' }, from: str, to: str } }
  },
  {
    name: 'delete_bucket_rule',
    risk: 'destructive',
    description: "Delete a bucket rule by id (from list_buckets). Transactions it placed go back to Personal unless another rule matches. An auto rule is an account being in its venture: it can't be deleted, and goes when update_account takes the account out.",
    input_schema: { type: 'object', properties: { rule_id: { type: 'integer' } }, required: ['rule_id'] }
  },
  {
    name: 'set_note',
    risk: 'write',
    description: 'Attach a short note to transactions (what it was, who it was for).',
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, note: str }, required: ['transaction_ids', 'note'] }
  },
  {
    name: 'list_recurring',
    risk: 'read',
    description: "Detected recurring series (subscriptions, bills, loans, income, transfers) with cadence, typical amount, last and next dates, status, and whether the user confirmed or dismissed them. A venture's series (its latest payment is the venture's) names the venture; Personal views leave it out.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'update_recurring',
    risk: 'write',
    description: "Confirm or dismiss a detected recurring series (status null takes either back: a dismissed series comes back), change its kind, or rename it. A bill, loan or subscription, or a confirmed other, is Committed, under Elective on Home; a dismissed series is no series anywhere.",
    input_schema: { type: 'object', properties: { key: str, status: { type: ['string', 'null'], enum: ['confirmed', 'dismissed', null] }, kind: { type: 'string', enum: [...RECURRING_KINDS] }, name: str }, required: ['key'] }
  },
  {
    name: 'list_accounts',
    risk: 'read',
    description: 'The user\'s accounts: institution, balance (negative = owed), source (simplefin = bank-synced, csv = imported, manual = an asset or debt with no feed, valued from its balance history), type, opened/closed dates, history_from (first real record; net worth before it is a flat guess), linked asset, whether hidden from totals, for a cash account its role (spending or saving), and for a house, vehicle or other asset its uses (set_asset_use) and the asset rules that put costs on it.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'update_account',
    risk: 'write',
    description: 'Change an account: rename, hide/show in totals, set its type, opened/closed dates (YYYY-MM-DD; "" clears; the balance counts as zero outside them), cost (dollars, what an asset cost including improvements; for a house in a venture, what buying it took: the cash paid at purchase plus the loan, since its repairs and improvements are the venture\'s spending), sale_costs (dollars, what the closing took from the seller besides the loan payoff: commission, title, concessions, prorations; the sale price less the payoff and the cash received; null clears), details (address, VIN, serial numbers), linked_asset_id (the asset a mortgage or car loan is secured by; "" unlinks), or the current balance of a CSV or manual account (dollars; owed amounts negative), or the bucket it belongs to (an asset or loan of a rental or business), or a debt\'s terms for the payoff plan: apr and promo_apr (percent a year), promo_ends (YYYY-MM-DD, when the intro rate ends), min_payment (dollars a month, the payment the statement asks, escrow included; the payoff plan pays a loan that less its escrow), escrow (dollars of each loan payment held for taxes and insurance; null clears). Bank-synced balances update themselves.',
    input_schema: {
      type: 'object',
      properties: { apr: { type: 'number' }, promo_apr: { type: 'number' }, promo_ends: { type: 'string' }, min_payment: { type: 'number' }, escrow: { type: ['number', 'null'] },
        account_id: str,
        name: str,
        hidden: { type: 'boolean' },
        type: { type: 'string', enum: ASSET_TYPES.map((t) => t.id) },
        opened: str,
        closed: str,
        cost: { type: 'number' },
        sale_costs: { type: ['number', 'null'] },
        details: str,
        linked_asset_id: str,
        bucket: { ...str, description: 'a bucket name, or "Personal"' },
        balance: { type: 'number' }
      },
      required: ['account_id']
    }
  },
  {
    name: 'set_account_role',
    risk: 'write',
    description: "Say what a cash account is for: spending (checking, where pay lands and bills are paid from) or saving (savings, money market, CDs, a reserve). It starts as a guess from the account's name and the bank's subtype; set it when list_accounts shows it wrong.",
    input_schema: { type: 'object', properties: { account_id: str, role: { type: 'string', enum: ['spending', 'saving'] } }, required: ['account_id', 'role'] }
  },
  {
    name: 'link_loan_payment',
    risk: 'write',
    description: "Link a loan, mortgage or other debt to the payments that pay it, wherever they're filed (a mortgage in Housing, a car loan as a transfer with nothing on the other side), so each payment splits into interest with escrow and principal by the debt's balances. Give one payment's transaction_id (its payee is then the debt's) or a recurring series' key from list_recurring (e.g. 'lakeside auto loan|-'); key \"\" unlinks. A transfer to the debt's own account is linked already. Set the escrow in each payment with update_account.",
    input_schema: { type: 'object', properties: { account_id: str, transaction_id: str, key: str }, required: ['account_id'] }
  },
  {
    name: 'mark_capital',
    risk: 'write',
    description: "Mark transactions as buying, selling or lending a Personal asset (a house, a car, valuables, a stake in a business, money lent), so they count as capital and not as spending, income or an unexplained transfer: a down payment, a cashier's check, sale proceeds, money lent and paid back. asset_id is the asset's account id from list_accounts; null unmarks. Large lines near an asset's purchase or sale date are taken as capital on their own; mark what that misses.",
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, asset_id: { type: ['string', 'null'] } }, required: ['transaction_ids', 'asset_id'] }
  },
  {
    name: 'set_asset_use',
    risk: 'write',
    description: "Say who uses a house, vehicle or other asset and how much, by dated periods, so its running costs are shared by use: rooms rented in a house the user lives in, a car driven partly for a business. Each use names an owner (a bucket, or \"Personal\"), its share in percent (two decimals) and from (YYYY-MM-DD) to (inclusive; left out while it goes on), with what the share is measured by (basis: rooms, area, miles, time or other). Owners sharing days share all of them, and their shares add up to 100%. Interest and escrow, dues, utilities, insurance and gas on those days go to each owner by its share; the asset's owner keeps its value, gain and loan principal. Days with no use are the owner's alone. This replaces the asset's uses; an empty list clears them. Measure by rooms, area or miles, never from the rent.",
    input_schema: {
      type: 'object',
      properties: {
        asset_id: str,
        uses: { type: 'array', items: { type: 'object', properties: { owner: str, share_pct: { type: 'number' }, from: str, to: str, basis: { type: 'string', enum: [...USE_BASES] } }, required: ['owner', 'share_pct', 'from'] } }
      },
      required: ['asset_id', 'uses']
    }
  },
  {
    name: 'place_on_asset',
    risk: 'write',
    description: "Put transactions on a house, vehicle or other asset (asset_id from list_accounts) as costs of it, so they're shared by its uses (set_asset_use), or take them off with asset_id null. Rules don't move them after this. Payments on a loan linked to the asset are its own already; income and transfers never go on an asset. split_id puts one part of a split transaction (one id) on it instead; with asset_id null it clears that part's own asset, so the part follows its transaction.",
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, asset_id: { type: ['string', 'null'] }, split_id: { type: 'integer' } }, required: ['transaction_ids', 'asset_id'] }
  },
  {
    name: 'merge_accounts',
    risk: 'destructive',
    description: 'Fold one account into another when they are the same card or bank account on two feeds (a reconnected bank shows up as a new account, and its transactions then count twice). Transactions on both (same amount and description within 3 days) are kept once, on the kept account, with the old one\'s category, venture, notes, one-time, HSA and receipt where those are the user\'s or the assistant\'s; the old account\'s other rows (statement imports the feed lacks, older history) and its entered balances, rules, limits and links move over. The old account is deleted and its feed ignored from then on. Keep the account that is still syncing; name sets the kept one\'s name.',
    input_schema: { type: 'object', properties: { from_account_id: { ...str, description: 'the account to fold in and remove' }, into_account_id: { ...str, description: 'the account to keep (the live feed)' }, name: str }, required: ['from_account_id', 'into_account_id'] }
  },
  {
    name: 'add_asset',
    risk: 'write',
    description: 'Add an asset or debt that has no bank connection: a house, a car, valuables (collectibles, jewelry, instruments), a stake in a business (type venture: opened = started, cost = what the user put in, values = what the stake is worth, closed = shut down or sold), money the user lent someone (type receivable: opened = lent, cost = amount lent, values = what\'s still owed, closed = paid back), a mortgage, a private loan. Amounts are dollars; for debts give amounts owed as positive numbers. `values` are known values on dates: the purchase price on the purchase date, appraisals or estimates, the sale price on the sale date, loan balances from statements. Between values the app draws a straight line. Set closed to the sale or payoff date for something no longer owned. Link a mortgage or car loan to its asset with linked_asset_id.',
    input_schema: {
      type: 'object',
      properties: {
        name: str,
        type: { type: 'string', enum: ASSET_TYPES.map((t) => t.id) },
        institution: { ...str, description: 'lender or where it\'s held, optional' },
        opened: { ...str, description: 'purchase or origination date, YYYY-MM-DD' },
        closed: { ...str, description: 'sale or payoff date, YYYY-MM-DD' },
        cost: { type: 'number', description: 'assets only: purchase price plus improvements' },
        details: str,
        linked_asset_id: str,
        values: { type: 'array', items: { type: 'object', properties: { date: str, amount: { type: 'number' } }, required: ['date', 'amount'] } }
      },
      required: ['name', 'type']
    }
  },
  {
    name: 'record_balance',
    risk: 'write',
    description: 'Record a known balance for any account on a date: a statement\'s ending balance, a year-end balance, an appraisal or estimate. Dollars; for debts (credit cards, loans, mortgages) give the amount owed as a positive number. This is how history before the bank connection gets filled in. Replaces an earlier entry on the same date.',
    input_schema: { type: 'object', properties: { account_id: str, date: str, amount: { type: 'number' } }, required: ['account_id', 'date', 'amount'] }
  },
  {
    name: 'balance_history',
    risk: 'read',
    description: 'Known balances of one account by date (source sync = reported by the bank or the current balance, manual = entered).',
    input_schema: { type: 'object', properties: { account_id: str }, required: ['account_id'] }
  },
  {
    name: 'delete_balance',
    risk: 'destructive',
    description: 'Delete an entered (manual) balance for an account on a date.',
    input_schema: { type: 'object', properties: { account_id: str, date: str }, required: ['account_id', 'date'] }
  },
  {
    name: 'add_calendar_event',
    risk: 'write',
    description: 'Put a dated reminder, deadline or appointment on the user\'s calendar (it also syncs to their Google Calendar when connected): a benefits enrollment window, an ESPP purchase, an estimated tax payment, a loan payoff, a subscription to cancel, a doctor\'s appointment. Give appointments a start_time (and end_time or duration_minutes); without one the reminder is all day. Set task for to-dos, one action each (split a list of calls, bookings or downloads into separate tasks). Recurring bills and paychecks are already projected automatically; don\'t add those.',
    input_schema: { type: 'object', properties: { date: str, title: str, notes: str, amount: { type: 'number', description: 'dollars, optional' }, ...eventFields }, required: ['date', 'title'] }
  },
  {
    name: 'update_calendar_event',
    risk: 'write',
    description: 'Change a reminder by its event id: date, time, title, notes, amount, whether it\'s a task, or check a task off (done). Only the fields given change; a new start_time keeps the event\'s length unless end_time or duration_minutes is given, and start_time null makes it all day.',
    input_schema: {
      type: 'object',
      properties: { event_id: { type: 'integer' }, date: str, title: str, notes: { type: ['string', 'null'] }, amount: { type: ['number', 'null'], description: 'dollars' }, ...eventFields, done: { type: 'boolean', description: 'a task checked off' } },
      required: ['event_id']
    }
  },
  {
    name: 'list_calendar',
    risk: 'read',
    description: 'Calendar items between two dates (default: today through 60 days out): reminders (with event ids, start_time/end_time when timed, and task with done for to-dos, which the user can also check off in Google Calendar) and projected recurring bills, paychecks and transfers.',
    input_schema: { type: 'object', properties: { from: str, to: str } }
  },
  {
    name: 'delete_calendar_event',
    risk: 'destructive',
    description: 'Remove a reminder from the calendar by its event id.',
    input_schema: { type: 'object', properties: { event_id: { type: 'integer' } }, required: ['event_id'] }
  },
  {
    name: 'list_investments',
    risk: 'read',
    description: 'Brokerage, retirement and HSA accounts, and stakes in businesses (treatment private, valued by estimate, cost = what was put in): tax treatment (pretax, roth, hsa, taxable, private), balance, 30-day change, cost basis, and each position (symbol, shares, price, value, cost, gain, share of the account, since_buy: the money-weighted return since its first dated purchase) from the bank sync. cost_estimated: the brokerage reported no cost, so it comes from the fund\'s purchases, or the account\'s contributions and rollovers. inferred: a position the brokerage didn\'t report (an ESPP balance taken as the company\'s stock, or cash beyond the reported positions). returns, per account and for all accounts together and by tax treatment, over 1M, 3M, YTD, 1Y and All (since its flows are known), only the periods the data covers: twr_pct (time-weighted) and mwr_pct (money-weighted, XIRR), yearly when annualized (longer than a year); gain (value change less net contributions), income (dividends and interest), net_contributions. Flows are contributions, the match, rollovers and transfers, from the account\'s transactions and, before its bank history, its contribution plan\'s paychecks, plus flows recorded from statements (record_flows), from the day set as known_from when that\'s earlier; unlabeled money in counts as a contribution where a plan feeds the account and as a dividend elsewhere, and money in under an income category counts as income.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_retirement',
    risk: 'write',
    description: "Set the user's own retirement figures, for the retirement line under Invested: birth_year, retire_age (the age they mean to retire at), real_return_pct (the yearly return after inflation they expect, percent) and inflation_pct (the yearly inflation they expect, percent; with the real return it prices savings held beyond their goals). The line grows what's invested now and the Invested run rate at the real return to that age, in today's dollars, once birth year, age and real return are set. Each figure is the user's: ask for it, and never pick or suggest a return or an inflation rate. Fields left out stay as they are; null clears one.",
    input_schema: { type: 'object', properties: { birth_year: { type: ['integer', 'null'] }, retire_age: { type: ['integer', 'null'] }, real_return_pct: { type: ['number', 'null'] }, inflation_pct: { type: ['number', 'null'] } } }
  },
  {
    name: 'debt_plan',
    risk: 'read',
    description:
      "The debt payoff plan, as Net worth > Debts shows it and Home's Saved names its next debt. Its inputs: strategy (avalanche: extra money to the highest rate first, an intro rate counting while it lasts; snowball: to the smallest balance first), left_out (debts the plan leaves out, each with the minimum it still takes from the same take-home while it owes, never more), take_home (the user's own figure when take_home_set, else the Take-home run rate), take_home_sources (the run rate by payroll, other income and estimated tax), spending (a month's Committed run rate without what debts charge in interest, escrow kept in, plus the Everyday and One-offs run rates) with spending_low and spending_high (the same spending's lowest and highest of the last twelve full months), set_aside (kept back a month) and lump_sum (paid first). Then per_month (take-home less spending, the set-aside and the left-out debts' minimums: what goes to the debts in the plan as it starts) or short_of_minimums (every debt's minimum counted, a left-out one's too), debt_free (YYYY-MM, null past 50 years), interest (null when it never ends), next (the debt it pays extra on first) and each debt in the order it's paid off, with its minimum on file (a loan's less its escrow), minimum_planned (what the plan pays it as it starts: with none on file a card's 1% and interest, at least $35, or 2% of a loan, and never a card's less than that), its paid_off month and interest (null for one it never pays off). at_targets: the same at the spending the category targets and the one-off budget allow, when any is set. Amounts in dollars.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_debt_plan',
    risk: 'write',
    description:
      "Change the debt payoff plan's inputs (debt_plan shows them): strategy (avalanche or snowball), left_out (the account ids of the debts the plan leaves out, the whole list; [] includes every debt), take_home (dollars a month to plan with in place of the Take-home run rate; null goes back to the run rate), set_aside (dollars a month kept back from the debts) and lump_sum (dollars paid toward them in the plan's first month); 0 or null clears either. Each is the user's own choice: ask for it, and never pick one for them. Fields left out stay as they are. A debt's rate, intro rate, minimum payment and escrow are update_account's. The answer is the plan as debt_plan gives it.",
    input_schema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['avalanche', 'snowball'] },
        left_out: { type: 'array', items: { type: 'string' } },
        take_home: { type: ['number', 'null'] },
        set_aside: { type: ['number', 'null'] },
        lump_sum: { type: ['number', 'null'] }
      }
    }
  },
  {
    name: 'close_month',
    risk: 'write',
    description:
      "Close a month that has ended, or close it again: Personal's rows, lines, balances and identities for the month are frozen as its next version (every version is kept). Months close by themselves from the 3rd of the next month once every bank-fed account has a balance after the month and nothing in it is pending, and on the 15th regardless; close one sooner, or again once what made its gap is fixed (a missing transaction added, a balance recorded, a transfer's other side found). The answer has its status: gap when Unexplained is above the tolerance or the identities don't tie, else closed, with Unexplained's items.",
    input_schema: { type: 'object', properties: { month: { ...str, description: 'YYYY-MM' } }, required: ['month'] }
  },
  {
    name: 'accept_close_changes',
    risk: 'write',
    description:
      "Keep the figures closed months have now, after something changed them since they were closed (the month_changed issue): each month named, or every changed month with none named, is closed again as its next version (every version is kept), the oldest first, twelve months a call at most (as few as four where closing them takes long). Use it once the user agrees the change is right (a recategorization, a rule, a paystub, a balance); to go back instead, undo the change itself. The answer has each month's new version and status, and left: how many changed months are still to keep (call it again for them).",
    input_schema: { type: 'object', properties: { months: { type: 'array', items: { ...str, description: 'YYYY-MM' } } } }
  },
  {
    name: 'record_flows',
    risk: 'write',
    description: 'Record money put into or taken out of an investment account that its bank feed doesn\'t show (from statements, 1099-Rs, 5498s): contributions, rollovers, Roth conversions and transfers in as positive dollars; distributions, withdrawals and transfers out as negative. Not dividends, interest, trades or fees, and not paycheck contributions where a contribution plan feeds the account (those are filled in already). Date each flow on the day the account\'s balance shows it. known_from: the first day from which every flow of the account is known (recorded here or in its feed), so its returns reach back to its balance the day before; null clears it. Returns before known_from stay hidden, so set it only once the statements from that day on are all accounted for.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: str,
        flows: { type: 'array', items: { type: 'object', properties: { date: str, amount: { type: 'number', description: 'dollars: positive in, negative out' }, note: str }, required: ['date', 'amount'] } },
        known_from: { type: ['string', 'null'], description: 'YYYY-MM-DD' }
      },
      required: ['account_id']
    }
  },
  {
    name: 'list_flows',
    risk: 'read',
    description: 'Flows recorded with record_flows (with flow ids) and each account\'s known_from day; one account\'s, or every account\'s.',
    input_schema: { type: 'object', properties: { account_id: str } }
  },
  {
    name: 'delete_flows',
    risk: 'destructive',
    description: 'Delete recorded flows by their flow ids (from list_flows).',
    input_schema: { type: 'object', properties: { flow_ids: { type: 'array', items: { type: 'integer' } } }, required: ['flow_ids'] }
  },
  {
    name: 'list_assets',
    risk: 'read',
    description: 'Real estate, vehicles, valuables, stakes in businesses and money owed to the user (receivable), with value, linked debts, equity, cost and gain/loss. Sold or repaid ones are shown as of their closing date.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'list_benefits',
    risk: 'read',
    description: "The user's employer benefits: each plan (medical, dental, vision, life, disability...) with its cost per paycheck, deductible, out-of-pocket max, coinsurance, what common care costs and what's free; the HSA (balance, this year's contributions against the limit, and hsa_start, the day care starts counting); and health costs since then, each owed (can still be paid back from the HSA tax-free), reimbursed, not eligible, or before the HSA.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'set_benefit_plan',
    risk: 'write',
    description: "Add or update one employer benefit by name ('Medical', 'Dental', 'Vision', 'Life insurance', 'Long-term disability'...); fields left out stay as they are, null clears one. Money is dollars; coinsurance is the user's share in percent after the deductible. Fill it from paystubs (per_paycheck, employer_per_paycheck, taxed) and the plan's Summary of Benefits and Coverage. Write costs and free in plain words, as the plan's documents state them, for someone who doesn't know insurance terms: costs [{what: 'Sick visit', in_network: 'Full price until the deductible, then 20%', out_of_network: '...'}], free [{what: 'Checkup', how_often: 'Once a year'}]. met and met_as_of: the deductible met so far this year, from the carrier's site or a claim statement.",
    input_schema: {
      type: 'object',
      properties: {
        name: str,
        kind: { type: 'string', enum: ['medical', 'dental', 'vision', 'life', 'disability', 'other'] },
        carrier: str,
        network: { ...str, description: "the network to pick in the carrier's doctor search" },
        coverage: { ...str, description: "who's covered, e.g. You only" },
        per_paycheck: { type: 'number' },
        employer_per_paycheck: { type: 'number' },
        taxed: { type: 'string', enum: ['pre', 'post'] },
        deductible: { type: 'number' },
        out_of_pocket_max: { type: 'number' },
        coinsurance: { type: 'number' },
        oon_deductible: { type: 'number' },
        oon_out_of_pocket_max: { type: 'number' },
        oon_coinsurance: { type: 'number' },
        annual_max: { type: 'number', description: 'dental: the most the plan pays in a year' },
        met: { type: 'number' },
        met_as_of: str,
        costs: { type: 'array', items: { type: 'object', properties: { what: str, in_network: str, out_of_network: str }, required: ['what', 'in_network'] } },
        free: { type: 'array', items: { type: 'object', properties: { what: str, how_often: str, every_months: { type: 'number', description: '12 for once a year, 6 for twice' } }, required: ['what', 'how_often'] } },
        phone: str,
        website: str,
        notes: str,
        source: { ...str, description: 'where the details came from, e.g. 2026 SBC' }
      },
      required: ['name']
    }
  },
  {
    name: 'delete_benefit_plan',
    risk: 'destructive',
    description: 'Remove an employer benefit by name.',
    input_schema: { type: 'object', properties: { name: str }, required: ['name'] }
  },
  {
    name: 'list_taxes',
    risk: 'read',
    description: "Federal income tax by year as kept on the Taxes page (each return as filed, and this year's estimate) with the forms on file by name, what each current paycheck withholds per check with the checks left this year, and the safe harbor for the year being estimated (100% of the previous year's tax, 110% if its AGI was over $150,000; payments count withholding, estimated payments and refundable credits; 90% of this year's tax, or under $1,000 due, also avoids the penalty). Pass year for that one return in full: its forms with their paths and whether each file is there, and its money in the Taxes category (refund, preparer fees, payments).",
    input_schema: { type: 'object', properties: { year: { type: 'number' } } }
  },
  {
    name: 'set_tax_year',
    risk: 'write',
    description: "Add or update one tax year on the Taxes page; fields left out stay as they are, null clears one. Money is dollars. Fill a filed year from its Form 1040 (wages line 1/1z, total_income line 9, agi line 11, deduction line 12, taxable_income line 15, total_tax line 24, withheld line 25d, total_payments line 33) and set refund to the refund, or negative for the amount owed. For the current year keep an estimate (status estimate, as_of) up to date whenever paystubs, elections or W-4s change: total_tax, withheld by Dec 31, total_payments including refundable credits, refund (negative = due). lines: 2-7 items that explain the year beyond wages, short labels, losses negative ('Capital gains (Schedule D)', 'State refund, taxable', 'Child tax credit'). forms: each document on file (the return, W-2s, 1099s, 1098s) by its name in the documents folder (like Tax/w2.pdf) or its full path, named like 'W-2 · Acme Corp'. issues: open questions for the preparer, one plain sentence each.",
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number' },
        status: { type: 'string', enum: ['filed', 'estimate'] },
        filing_status: str,
        preparer: { ...str, description: 'TurboTax when self-prepared, or the paid preparer' },
        filed_day: { ...str, description: 'YYYY-MM-DD the return was signed or e-filed' },
        wages: { type: 'number' },
        total_income: { type: 'number' },
        agi: { type: 'number' },
        deduction: { type: 'string', enum: ['standard', 'itemized'] },
        deduction_amount: { type: 'number' },
        taxable_income: { type: 'number' },
        total_tax: { type: 'number' },
        withheld: { type: 'number' },
        total_payments: { type: 'number' },
        refund: { type: 'number', description: 'the refund; negative for the amount owed' },
        lines: { type: 'array', items: { type: 'object', properties: { label: str, amount: { type: 'number' } }, required: ['label', 'amount'] } },
        forms: { type: 'array', items: { type: 'object', properties: { name: str, file: { ...str, description: 'its name in the documents folder (like Tax/w2.pdf) or its full path' } }, required: ['name', 'file'] } },
        issues: { type: 'array', items: str },
        as_of: { ...str, description: "an estimate's date, YYYY-MM-DD" },
        source: { ...str, description: 'where the figures came from' }
      },
      required: ['year']
    }
  },
  {
    name: 'delete_tax_year',
    risk: 'destructive',
    description: 'Remove one tax year from the Taxes page.',
    input_schema: { type: 'object', properties: { year: { type: 'number' } }, required: ['year'] }
  },
  {
    name: 'list_credit',
    risk: 'read',
    description: "The Credit page: credit scores (newest first) and the newest from each place they're followed, card utilization from the synced balances and each card's limit, account age, hard inquiries of the last two years with when each drops off, anything negative, and each bureau's latest report with the accounts on it that aren't in the app. With bureau: that report's accounts in full.",
    input_schema: { type: 'object', properties: { bureau: { type: 'string', enum: ['Experian', 'Equifax', 'TransUnion'] } } }
  },
  {
    name: 'record_credit_score',
    risk: 'write',
    description: "Record a credit score the user saw: from a screenshot or document of a bank's free score page (Chase Credit Journey, Capital One CreditWise, Discover, Experian, Credit Karma), or from what the user says. day is the date the score is as of (YYYY-MM-DD). bureau: Experian, Equifax or TransUnion when shown. model: e.g. 'FICO 8' or 'VantageScore 3.0'. source: where it was seen. The same source, bureau and model on the same day replaces the earlier entry.",
    input_schema: { type: 'object', properties: { score: { type: 'number' }, day: str, bureau: { type: 'string', enum: ['Experian', 'Equifax', 'TransUnion'] }, model: str, source: str, note: str }, required: ['score', 'day'] }
  },
  {
    name: 'delete_credit_score',
    risk: 'destructive',
    description: 'Remove a recorded credit score by its id (from list_credit).',
    input_schema: { type: 'object', properties: { id: str }, required: ['id'] }
  },
  {
    name: 'set_credit_report',
    risk: 'write',
    description: "Store one bureau's credit report after reading it (the same bureau and day replaces the earlier one): every account (tradeline) with creditor, last4, kind (revolving, installment, mortgage, open, collection, other), opened and closed (YYYY-MM or YYYY-MM-DD), status as printed, limit and balance in dollars, account_id when it is one of the app's accounts, and late marks like '2023-04: 30 days'; hard inquiries (creditor, day); negatives (collections, charge-offs, public records) in plain words; and file, the report by its name in the documents folder or its full path. Also set each open card's limit with set_credit_limit.",
    input_schema: {
      type: 'object',
      properties: {
        bureau: { type: 'string', enum: ['Experian', 'Equifax', 'TransUnion'] },
        day: str,
        file: str,
        tradelines: { type: 'array', items: { type: 'object', properties: { creditor: str, last4: str, kind: { type: 'string', enum: ['revolving', 'installment', 'mortgage', 'open', 'collection', 'other'] }, opened: str, closed: str, status: str, limit: { type: 'number' }, balance: { type: 'number' }, account_id: str, late: { type: 'array', items: str } }, required: ['creditor', 'kind', 'status'] } },
        inquiries: { type: 'array', items: { type: 'object', properties: { creditor: str, day: str }, required: ['creditor', 'day'] } },
        negatives: { type: 'array', items: str },
        note: str
      },
      required: ['bureau', 'day']
    }
  },
  {
    name: 'set_credit_limit',
    risk: 'write',
    description: "A credit card's limit, for utilization (balance against limit), from a credit report or a statement. limit in dollars; null clears. source: where it came from, e.g. 'TransUnion report' or 'Oct 2026 statement'; as_of YYYY-MM-DD.",
    input_schema: { type: 'object', properties: { account_id: str, limit: { type: ['number', 'null'] }, source: str, as_of: str }, required: ['account_id', 'limit'] }
  },
  {
    name: 'list_insurance',
    risk: 'read',
    description: "The Insurance page: each policy or protection plan (auto, home or renters, umbrella, life, travel...) with its carrier, premium and a year's cost, deductible, next renewal (rolled forward by its term) and what was paid in the last year (transactions matching its match text); plus work plans from the Pay & benefits page with a year's cost. With policy (an id or name): that policy in full, with what its documents say it covers, coverage limits, terms, claims phone, documents and notes.",
    input_schema: { type: 'object', properties: { policy: str } }
  },
  {
    name: 'set_insurance_policy',
    risk: 'write',
    description: "Add or update a policy (found by id, or by name); fields left out stay as they are, null clears. Fill it from declarations pages, contracts, bills and the transactions. kind: auto, renters, home, umbrella, health, dental, vision, life, disability, vehicle (an extended warranty or another add-on plan), device, pet, travel, other. Work benefits stay on the Pay & benefits page (set_benefit_plan). premium in dollars per premium_period (month, quarter, half-year, year, one-time). renewal_day is a known renewal (YYYY-MM-DD) and term_months its length (6 or 12), so it rolls forward. match is text in the bank description of its payments (e.g. 'crestline'), so what was paid is found on its own. coverage: [{what, limit}] in plain words, as the policy documents state them. files: [{name, file}], each file by its name in the documents folder or its full path. status ended for a policy that's over (keep it for the record).",
    input_schema: {
      type: 'object',
      properties: {
        id: str,
        name: str,
        kind: { type: 'string', enum: ['auto', 'renters', 'home', 'umbrella', 'health', 'dental', 'vision', 'life', 'disability', 'vehicle', 'device', 'pet', 'travel', 'other'] },
        carrier: str,
        policy_number: str,
        covers: str,
        status: { type: 'string', enum: ['active', 'ended'] },
        start_day: str,
        renewal_day: str,
        term_months: { type: 'number' },
        end_day: str,
        premium: { type: 'number' },
        premium_period: { type: 'string', enum: ['month', 'quarter', 'half-year', 'year', 'one-time'] },
        match: str,
        deductible: { type: 'number' },
        coverage: { type: 'array', items: { type: 'object', properties: { what: str, limit: str }, required: ['what', 'limit'] } },
        phone: str,
        claims_phone: str,
        website: str,
        files: { type: 'array', items: { type: 'object', properties: { name: str, file: str }, required: ['name', 'file'] } },
        notes: str,
        source: str
      }
    }
  },
  {
    name: 'delete_insurance_policy',
    risk: 'destructive',
    description: 'Remove a policy by id or name (for one entered by mistake; a policy that ended stays with status ended).',
    input_schema: { type: 'object', properties: { policy: str }, required: ['policy'] }
  },
  {
    name: 'set_benefits',
    risk: 'write',
    description: "The employer's name, and hsa_start (YYYY-MM-DD): the day health costs start counting for the HSA, when it was opened. By default it's the first HSA paycheck.",
    input_schema: { type: 'object', properties: { employer: str, hsa_start: str } }
  },
  {
    name: 'set_hsa_year',
    risk: 'write',
    description: "Record what went into an HSA in an earlier year, for the Pay & benefits page's by-year view: total (yours and the employer's together, e.g. W-2 box 12 code W) and the employer's part if known. Each January, record the year just ended from its W-2. The current year comes from the paychecks on its own. total null removes the year.",
    input_schema: { type: 'object', properties: { year: { type: 'number' }, total: { type: 'number' }, employer: { type: 'number' }, source: str }, required: ['year', 'total'] }
  },
  {
    name: 'set_hsa',
    risk: 'write',
    description: "Mark health costs for the HSA as the user decides: eligible (counts though it isn't in Health & Medical), not (doesn't qualify), reimbursed (already paid back from the HSA), or auto (the default: Health & Medical costs on or after hsa_start count).",
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, state: { type: 'string', enum: ['eligible', 'not', 'reimbursed', 'auto'] } }, required: ['transaction_ids', 'state'] }
  },
  {
    name: 'attach_receipt',
    risk: 'write',
    description: "Link a receipt in the documents folder (its name from list_documents) to the health costs it covers, so paying them back from the HSA is backed by records. One document can cover many costs: a provider's itemized statement covers each visit paid that month; match dates and amounts. Replaces a cost's earlier receipt.",
    input_schema: { type: 'object', properties: { document: str, transaction_ids: { type: 'array', items: str } }, required: ['document', 'transaction_ids'] }
  },
  {
    name: 'detach_receipt',
    risk: 'write',
    description: 'Unlink the receipt from costs (the file stays in the documents folder).',
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str } }, required: ['transaction_ids'] }
  },
  {
    name: 'remember',
    risk: 'write',
    description: 'Save a durable fact the user told you (who a payee is, what an account is for, how they want something treated). Facts are shown to future reviews; the short ones are also used when categorizing new transactions, so keep a fact about a payee to a sentence.',
    input_schema: { type: 'object', properties: { fact: str }, required: ['fact'] }
  },
  {
    name: 'forget',
    risk: 'destructive',
    description: 'Delete a remembered fact by id.',
    input_schema: { type: 'object', properties: { fact_id: { type: 'integer' } }, required: ['fact_id'] }
  },
  {
    name: 'resolve_issue',
    risk: 'write',
    description: 'Mark an open issue (a key from get_open_issues) as settled or skipped so it doesn\'t come up again, with an optional note. The user sees it under Resolved and can bring it back.',
    input_schema: { type: 'object', properties: { issue_key: str, note: str }, required: ['issue_key'] }
  },
  {
    name: 'add_question',
    risk: 'write',
    description: 'Save a question only the user can answer, to ask in a review: a loose end found in a document, or something the user wants to come back to later. It is listed under Questions for you until answered.',
    input_schema: { type: 'object', properties: { question: { ...str, description: 'one specific question, with the dates and amounts needed to recognize it' } }, required: ['question'] }
  },
  {
    name: 'answer_question',
    risk: 'write',
    description: 'Close a saved question once the user has answered it, with the answer in a sentence. Act on the answer first (categorize, remember, update an account).',
    input_schema: { type: 'object', properties: { question_id: { type: 'integer' }, answer: str }, required: ['question_id', 'answer'] }
  },
  {
    name: 'split_transaction',
    risk: 'write',
    description: 'Split one transaction into parts, each with its own category, bucket and one-off flag: a Costco or Amazon order of groceries, household goods and a one-off; a bill shared with a bucket. amount_cents is whole cents with the transaction\'s sign (negative for money out); the parts must add up to it exactly, at least two. A part without a bucket stays where the transaction is. Replaces an earlier split. Totals, the budget and buckets then count each part on its own, and rules and categorization leave the parts alone.',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: str,
        parts: {
          type: 'array',
          items: { type: 'object', properties: { amount_cents: { type: 'integer' }, category: str, bucket: { ...str, description: 'a bucket name, or "Personal"' }, one_time: { type: 'boolean' }, note: str }, required: ['amount_cents', 'category'] }
        }
      },
      required: ['transaction_id', 'parts']
    }
  },
  {
    name: 'unsplit_transaction',
    risk: 'write',
    description: 'Undo a split: the transaction counts whole again, in its own category and bucket.',
    input_schema: { type: 'object', properties: { transaction_id: str }, required: ['transaction_id'] }
  },
  {
    name: 'add_tags',
    risk: 'write',
    description: 'Label transactions with free-form tags (vacation, reimbursable, wedding), as many as fit. Tags match in any case, and one already in use keeps its first spelling. search_transactions finds them by tag.',
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, tags: { type: 'array', items: str } }, required: ['transaction_ids', 'tags'] }
  },
  {
    name: 'remove_tags',
    risk: 'write',
    description: 'Take tags off transactions.',
    input_schema: { type: 'object', properties: { transaction_ids: { type: 'array', items: str }, tags: { type: 'array', items: str } }, required: ['transaction_ids', 'tags'] }
  },
  {
    name: 'list_goals',
    risk: 'read',
    description: "Savings goals: each one's target and date, what funds it (linked accounts' combined balance, less their balance on start_day when it counts only what's saved since; or a log of contributions), saved, remaining, percent, months left and what's still needed a month to make the date, the pace (saved a month over the last three months) and status (done, on_track, behind, past_due, or open without a date). With goal (an id or name): that goal with its contributions.",
    input_schema: { type: 'object', properties: { goal: str } }
  },
  {
    name: 'create_goal',
    risk: 'write',
    description: "Add a savings goal the user names (an emergency fund, a trip, a down payment): target in dollars, target_day (YYYY-MM-DD) when it has a date. Fund it from account_ids (accounts that hold money, from list_accounts), with from_now true to count only what's saved from today; or leave account_ids out and log money set aside in contributions (amount in dollars, a withdrawal negative).",
    input_schema: {
      type: 'object',
      properties: {
        name: str,
        target: { type: 'number' },
        target_day: str,
        account_ids: { type: 'array', items: str },
        from_now: { type: 'boolean' },
        contributions: { type: 'array', items: { type: 'object', properties: { amount: { type: 'number' }, day: str, note: str }, required: ['amount', 'day'] } }
      },
      required: ['name', 'target']
    }
  },
  {
    name: 'update_goal',
    risk: 'write',
    description: 'Change a goal (goal: its id or name); fields left out stay as they are, target_day null clears the date. account_ids moves it to those accounts, an empty list to a log of contributions; from_now false counts the whole balance again. add_contribution logs money set aside (a withdrawal negative). archived true puts a goal that is done or dropped away; false brings it back.',
    input_schema: {
      type: 'object',
      properties: {
        goal: str,
        name: str,
        target: { type: 'number' },
        target_day: { type: ['string', 'null'] },
        account_ids: { type: 'array', items: str },
        from_now: { type: 'boolean' },
        archived: { type: 'boolean' },
        add_contribution: { type: 'object', properties: { amount: { type: 'number' }, day: str, note: str }, required: ['amount', 'day'] }
      },
      required: ['goal']
    }
  },
  {
    name: 'delete_goal',
    risk: 'destructive',
    description: 'Remove a goal and its log of contributions (goal: its id or name). A goal that is done or dropped is archived with update_goal instead.',
    input_schema: { type: 'object', properties: { goal: str }, required: ['goal'] }
  }
]

function categoryId(name: string): number {
  const cats = db.listCategories()
  const c = cats.find((x) => x.name.toLowerCase() === name.trim().toLowerCase())
  if (!c) throw new Error(`Unknown category "${name}". Existing: ${cats.map((x) => x.name).join(', ')}`)
  return c.id
}

/** A bucket by name; "Personal" (or empty) is null. */
function bucketRef(name: unknown): number | null {
  const n = String(name ?? '').trim()
  if (!n || /^personal$/i.test(n)) return null
  const b = db.bucketByName(n)
  if (!b) throw new Error(`Unknown bucket "${n}". Existing: Personal${db.listBuckets().map((x) => `, ${x.name}`).join('')}`)
  return b.id
}

function requireBucket(name: unknown): number {
  const id = bucketRef(name)
  if (id === null) throw new Error('Name a bucket; Personal is everything not in one')
  return id
}

const bucketLabel = (id: number | null): string => (id === null ? 'Personal' : (db.listBuckets().find((b) => b.id === id)?.name ?? 'Personal'))

/** A venture's owner money as Review reads it, in dollars. */
const ownerOut = (o: OwnerMoney): Record<string, unknown> => ({
  share_pct: o.shareBp / 100,
  shares: o.shares.map((s) => ({ from: s.fromDay, share_pct: s.shareBp / 100, source: s.source })),
  value_source: o.valueSource,
  ...(o.stakeAccountId ? { stake_account_id: o.stakeAccountId } : {}),
  basis: o.basisCents / 100,
  ...(o.aboveBasisCents ? { returned_above_basis: o.aboveBasisCents / 100 } : {}),
  lent: o.lentCents / 100,
  borrowed: o.borrowedCents / 100,
  due: o.dueCents / 100,
  net_assets: o.netAssetsCents / 100,
  stake: o.stakeCents / 100,
  position: o.positionCents / 100,
  by_intent: o.byIntent.map((x) => ({ intent: x.intent, in: x.inCents / 100, out: x.outCents / 100, ...(x.interestCents ? { interest: x.interestCents / 100 } : {}) }))
})

/** The start of a day in the ledger's zone. */
function dayStart(d: string): number {
  // Read as a local date only to check it and take its parts, which mean the same day anywhere.
  const t = new Date(`${d}T00:00:00`)
  if (Number.isNaN(t.getTime())) throw new Error(`Bad date "${d}", use YYYY-MM-DD`)
  return db.dayStart(dayFrom(t.getFullYear(), t.getMonth() + 1, t.getDate()))
}

function existingIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || !ids.length) throw new Error('transaction_ids must be a non-empty array')
  const found = ids.filter((id): id is string => typeof id === 'string' && db.getTransaction(id) !== null)
  if (!found.length) throw new Error('None of those transaction ids exist')
  return found
}

function account(id: unknown): ReturnType<typeof db.listAccounts>[number] {
  const a = db.listAccounts().find((x) => x.id === String(id))
  if (!a) throw new Error(`No account ${String(id)}. Use list_accounts for ids.`)
  return a
}

/** A house, vehicle or other asset: what has running costs of its own to put lines on and share by use. */
function costedAccount(id: unknown): ReturnType<typeof db.listAccounts>[number] {
  const a = account(id)
  if (!db.COSTED_ASSETS.includes(a.assetType)) throw new Error(`${a.name} is ${typeLabel(a.assetType)}: only a house, a vehicle or another asset has costs to put on it`)
  return a
}

/** A rule as the tools give it back. */
const ruleOut = (r: BucketRule): Record<string, unknown> => ({
  id: r.id,
  account: r.accountName,
  ...(r.categoryName ? { category: r.categoryName } : {}),
  contains: r.contains,
  amount: r.amountCents === null ? null : r.amountCents / 100,
  from: r.fromDay,
  to: r.toDay,
  ...(r.auto ? { auto: true } : {})
})

/** add_bucket_rule's input as a rule: a bucket's or an asset's, with what it matches. */
function ruleInput(i: Record<string, unknown>): db.RuleInput {
  const asset = typeof i.asset_id === 'string' && i.asset_id ? costedAccount(i.asset_id).id : null
  if (asset && typeof i.bucket === 'string' && i.bucket.trim()) throw new Error('A rule puts lines in a bucket or on an asset, not both: give bucket or asset_id')
  return {
    bucketId: asset ? null : requireBucket(i.bucket),
    assetId: asset,
    accountId: typeof i.account_id === 'string' && i.account_id ? account(i.account_id).id : null,
    categoryId: typeof i.category === 'string' && i.category.trim() ? categoryId(i.category) : null,
    contains: typeof i.contains === 'string' ? i.contains : null,
    amountCents: typeof i.amount === 'number' ? Math.round(i.amount * 100) : null,
    fromDay: typeof i.from === 'string' ? i.from : null,
    toDay: typeof i.to === 'string' ? i.to : null
  }
}

function calendarEvent(id: number): CalendarEvent {
  const e = db.listCalendarEvents('0000-01-01').find((x) => x.id === id)
  if (!e) throw new Error(`No calendar event ${id}. Use list_calendar for ids.`)
  return e
}

/** The time fields a calendar tool was given; '' or null start_time means all day. */
function timeInput(i: Record<string, unknown>): db.EventTimes {
  return {
    ...(i.start_time === null || i.start_time === '' ? { startTime: null } : typeof i.start_time === 'string' ? { startTime: i.start_time } : {}),
    ...(typeof i.end_time === 'string' && i.end_time ? { endTime: i.end_time } : {}),
    ...(typeof i.duration_minutes === 'number' ? { durationMinutes: i.duration_minutes } : {})
  }
}

const eventResult = (e: CalendarEvent): Record<string, unknown> => ({
  ...(e.startTime ? { start_time: e.startTime, end_time: e.endTime } : { all_day: true }),
  ...(e.task ? { task: true, done: e.doneAt !== null } : {})
})
const eventWhen = (e: CalendarEvent): string => (e.startTime ? `${e.day} ${e.startTime}–${e.endTime}` : e.day)

function assetType(t: unknown): AssetType {
  const found = ASSET_TYPES.find((x) => x.id === t)
  if (!found) throw new Error(`type must be one of ${ASSET_TYPES.map((x) => x.id).join(', ')}`)
  return found.id
}

const typeLabel = (t: AssetType): string => ASSET_TYPES.find((x) => x.id === t)?.label ?? t

const dollars = (cents: number | null): number | null => (cents === null ? null : cents / 100)
const percent = (r: number | null): number | null => (r === null ? null : Math.round(r * 10_000) / 100)
const returnsOut = (r: Returns | null | undefined): Record<string, unknown> | null =>
  r
    ? {
        periods: r.periods.map((p) => ({
          period: p.period,
          from: p.from,
          to: p.to,
          twr_pct: percent(p.twr),
          mwr_pct: percent(p.mwr),
          annualized: p.annualized,
          gain: p.gainCents / 100,
          income: p.incomeCents / 100,
          net_contributions: p.flowCents / 100
        })),
        volatility_pct: percent(r.volatility),
        max_drawdown_pct: percent(r.maxDrawdown)
      }
    : null

// Optional fields of an update: left out (undefined), cleared (null), or set.
function textField(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  return v === null ? null : String(v).trim() || null
}

function numberField(v: unknown, label: string): number | null | undefined {
  if (v === undefined || v === null) return v as undefined | null
  // A number, or text that reads as one: true, "" or a list is no amount, though Number() would make it 1 or 0.
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`)
  return n
}

function centsField(v: unknown, label: string): number | null | undefined {
  const n = numberField(v, `${label} (dollars)`)
  return typeof n === 'number' ? Math.round(n * 100) : n
}

/** An amount a paystub gives, in dollars, as cents. */
function cents(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new Error(`${JSON.stringify(v) ?? String(v)} isn't an amount in dollars`)
  return Math.round(n * 100)
}

/** A paystub in a line: its payroll and pay day, gross, what each row took and net. */
function stubLine(s: Paystub): string {
  const row = (r: 'taxes' | 'benefits' | 'savedAtWork'): number => s.items.filter((x) => PAYSTUB_ITEMS[x.kind].row === r).reduce((t, x) => t + x.cents, 0)
  return `${s.paycheckKey.replace(/\|\+$/, '')} · ${s.payDay}${s.kind === 'regular' ? '' : ` (${s.kind})`} · gross ${money(s.grossCents)}, taxes ${money(row('taxes'))}, benefits ${money(row('benefits'))}, saved ${money(row('savedAtWork'))}, net ${money(s.netCents)}`
}

const planOut = (p: BenefitPlan): Record<string, unknown> => ({
  name: p.name,
  kind: p.kind,
  carrier: p.carrier,
  network: p.network,
  coverage: p.coverage,
  per_paycheck: dollars(p.perCheckCents),
  employer_per_paycheck: dollars(p.employerPerCheckCents),
  taxed: p.taxed,
  deductible: dollars(p.deductibleCents),
  out_of_pocket_max: dollars(p.outOfPocketMaxCents),
  coinsurance: p.coinsurancePct,
  oon_deductible: dollars(p.oonDeductibleCents),
  oon_out_of_pocket_max: dollars(p.oonOutOfPocketMaxCents),
  oon_coinsurance: p.oonCoinsurancePct,
  annual_max: dollars(p.annualMaxCents),
  met: dollars(p.metCents),
  met_as_of: p.metAsOf,
  costs: p.costs.map((c) => ({ what: c.what, in_network: c.inNetwork, out_of_network: c.outOfNetwork })),
  free: p.free.map((f) => ({ what: f.what, how_often: f.often, every_months: f.everyMonths })),
  phone: p.phone,
  website: p.website,
  notes: p.notes,
  source: p.source
})

const taxYearOut = (y: TaxYear): Record<string, unknown> => ({
  year: y.year,
  status: y.status,
  filing_status: y.filingStatus,
  preparer: y.preparer,
  filed_day: y.filedDay,
  wages: dollars(y.wagesCents),
  total_income: dollars(y.incomeCents),
  agi: dollars(y.agiCents),
  deduction: y.deduction,
  deduction_amount: dollars(y.deductionCents),
  taxable_income: dollars(y.taxableCents),
  total_tax: dollars(y.taxCents),
  withheld: dollars(y.withheldCents),
  total_payments: dollars(y.paymentsCents),
  refund: dollars(y.refundCents),
  lines: y.lines.map((l) => ({ label: l.label, amount: l.cents / 100 })),
  forms: y.forms,
  issues: y.issues,
  as_of: y.asOf,
  source: y.source
})

type Input = Record<string, unknown>
/** `pending`: the call wasn't run; it waits for the user's approval under that id. `content`: the result as content blocks (a document), for a caller that can take them instead of JSON. `changeId`: the journal entry Undo puts back. */
export type ToolResult = { result: unknown; action?: string; pending?: number; content?: DocumentBlock[]; changeId?: number }
/** Who is calling: the review assistant, the file bridge, or the user (approving a queued call). */
interface ToolContext {
  origin: FactOrigin
}
type Impl = (i: Input, ctx: ToolContext) => ToolResult

/** A stored document path is checked at write time, so the pages never hold one they can't open. */
/** A stored document: its name in the documents folder or its full path, checked, as the full path the pages open. */
function checkDocument(file: string): string {
  return documentPath(file)
}

/** A website a tool records: https, with a host, no credentials in it; returns it as given. */
function checkWebsite(v: unknown): string | null | undefined {
  const s = textField(v)
  if (!s) return s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('website must be a full https address')
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) throw new Error('website must be a full https address')
  return s
}

/** A new rule that would rewrite more transactions than this waits for the user's approval. */
export const RULE_LIMIT = 200

/** How many transactions a create_rule call would change right now (0 when the call is malformed). */
function ruleMatchCount(i: Input): number {
  try {
    return db.countRuleMatches(i.field === 'contains' ? 'contains' : 'merchant', String(i.pattern ?? ''), categoryId(String(i.category)))
  } catch {
    return 0
  }
}

/** How many transactions an add_bucket_rule call would move right now (0 when the call is malformed). */
function bucketRuleMatchCount(i: Input): number {
  try {
    return db.countBucketRuleMatches({ bucketId: requireBucket(i.bucket), accountId: typeof i.account_id === 'string' && i.account_id ? account(i.account_id).id : null, contains: typeof i.contains === 'string' ? i.contains : null, amountCents: typeof i.amount === 'number' ? Math.round(i.amount * 100) : null, fromDay: typeof i.from === 'string' ? i.from : null, toDay: typeof i.to === 'string' ? i.to : null })
  } catch {
    return 0
  }
}

/**
 * The debt plan as Net worth's Debts runs it (debtPlan.ts runDebtPlan on getDebts and the debt.plan inputs), in
 * dollars: its inputs, what goes to the debts a month or how far that falls short of the minimums, when they're gone
 * and what they cost in interest, the debt it pays extra on first and each debt in the order it's paid off; and the
 * same at the spending the targets allow, when any is set.
 */
function debtPlanAnswer(): Record<string, unknown> {
  const view = getDebts()
  const dollars = (cents: number): number => cents / 100
  const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
  const run = runDebtPlan(view)
  const r = run.result
  const own = new Map(view.debts.map((d) => [d.id, d]))
  const start = shiftMonth(view.month, 1)
  const first = targetOf(run.debts, run.debts.map((d) => d.balanceCents), view.plan.strategy, start)
  // Paid off soonest first; one the plan doesn't clear last, in getDebts' order.
  const order = r.debts.map((d, k) => ({ ...d, k })).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.k - b.k)
  const outcome = (x: typeof run): Record<string, unknown> => ({
    per_month: dollars(x.monthlyCents),
    ...(x.result.shortfallCents ? { short_of_minimums: dollars(x.result.shortfallCents) } : {}),
    debt_free: x.debts.length ? x.result.debtFree : null,
    // A plan that never ends has no interest to give: fifty years of it is no figure.
    interest: x.result.debtFree ? dollars(x.result.interestCents) : null
  })
  const targets = view.targetSpendCents === null ? null : runDebtPlan(view, view.targetSpendCents)
  return {
    strategy: view.plan.strategy,
    // A debt left out that owes still takes its minimum from the same take-home; one that owes nothing takes none.
    left_out: view.plan.leftOut.map((id) => {
      const d = run.leftOut.find((x) => x.id === id)
      return { account_id: id, name: names.get(id) ?? null, minimum: d ? dollars(minimumIn(d, start)) : 0 }
    }),
    take_home: dollars(run.takeHomeCents),
    take_home_set: view.plan.takeHomeCents !== null,
    ...(view.plan.takeHomeCents !== null ? { take_home_run_rate: dollars(view.takeHomeCents) } : {}),
    take_home_sources: view.incomeSources.map((s) => ({ name: s.name, monthly: dollars(s.monthlyCents) })),
    spending: dollars(view.spendCents),
    spending_low: dollars(view.spendLowCents),
    spending_high: dollars(view.spendHighCents),
    set_aside: dollars(view.plan.setAsideCents),
    lump_sum: dollars(view.plan.lumpCents),
    ...outcome(run),
    next: first < 0 ? null : { account_id: run.debts[first].id, name: run.debts[first].name },
    debts: order.map((d) => {
      const x = own.get(d.id)!
      return { account_id: d.id, name: x.name, owed: dollars(x.balanceCents), apr: x.apr, ...(x.promoApr !== null ? { promo_apr: x.promoApr, promo_ends: x.promoEnds } : {}), minimum: x.minPaymentCents === null ? null : dollars(x.minPaymentCents), minimum_planned: dollars(minimumIn(run.debts.find((p) => p.id === d.id)!, start)), paid_off: d.paidOff, interest: d.paidOff ? dollars(d.interestCents) : null }
    }),
    ...(targets ? { at_targets: { spending: dollars(targets.spendCents), ...outcome(targets) } } : {})
  }
}

const TOOL_IMPL: Record<string, Impl> = {
  get_open_issues: () => ({ result: openIssues().slice(0, 60) }),

  search_transactions: (i) => {
    const where = ['1 = 1']
    const p: Array<string | number> = []
    const likePattern = (s: string): string => `%${s.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    if (typeof i.query === 'string' && i.query.trim()) {
      const like = likePattern(i.query)
      where.push("(t.description LIKE ? ESCAPE '\\' OR t.merchant LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')")
      p.push(like, like, like)
    }
    // Category and bucket match any part of a split transaction, the same part. Personal's parts are found by the
    // owner rule (lines.ts), and with them the costs of a place Personal uses that the rule puts in a venture.
    const line: string[] = []
    const lineParams: Array<string | number> = []
    if (typeof i.category === 'string') {
      if (i.category.toLowerCase() === 'uncategorized') line.push('t.category_id IS NULL')
      else {
        line.push('t.category_id = ?')
        lineParams.push(categoryId(i.category))
      }
    }
    const bucket = typeof i.bucket === 'string' ? bucketRef(i.bucket) : undefined
    const personal = bucket === null
    if (bucket !== undefined && bucket !== null) {
      line.push('t.bucket_id = ?')
      lineParams.push(bucket)
    }
    if (line.length) {
      where.push(`t.id IN (SELECT t.id FROM ${db.TXN_LINES} t WHERE ${line.join(' AND ')})`)
      p.push(...lineParams)
    }
    if (typeof i.tag === 'string' && i.tag.trim()) {
      where.push('EXISTS (SELECT 1 FROM transaction_tags g WHERE g.transaction_id = t.id AND g.tag = ?)')
      p.push(db.tagKey(i.tag))
    }
    if (typeof i.account === 'string') {
      where.push("a.name LIKE ? ESCAPE '\\'")
      p.push(likePattern(i.account))
    }
    if (typeof i.from === 'string') {
      where.push('t.posted >= ?')
      p.push(dayStart(i.from))
    }
    if (typeof i.to === 'string') {
      where.push('t.posted < ?')
      p.push(dayStart(i.to) + DAY)
    }
    if (typeof i.min_amount === 'number') {
      where.push('ABS(t.amount_cents) >= ?')
      p.push(Math.round(i.min_amount * 100))
    }
    if (typeof i.max_amount === 'number') {
      where.push('ABS(t.amount_cents) <= ?')
      p.push(Math.round(i.max_amount * 100))
    }
    const limit = Math.min(Math.max(Number(i.limit) || 25, 1), 100)
    const page = (n: number, offset: number) =>
      db.all<{ id: string; posted: number; merchant: string | null; description: string; cents: number; category: string | null; source: string | null; account: string; notes: string | null; pending: number; bucket: string | null; one_time: number }>(
        `SELECT t.id, t.posted, t.merchant, t.description, t.amount_cents AS cents, c.name AS category, t.category_source AS source, a.name AS account, t.notes, t.pending, b.name AS bucket, t.one_time
         FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN buckets b ON b.id = t.bucket_id
         WHERE ${where.join(' AND ')} ORDER BY t.posted DESC, t.id LIMIT ? OFFSET ?`,
        ...p,
        n,
        offset
      )
    let rows = personal ? [] : page(limit, 0)
    // Personal's: newest first, a page at a time, until there are enough.
    for (let offset = 0, more = personal; more && rows.length < limit; offset += 200) {
      const next = page(200, offset)
      const mine = withPersonalLine(
        next.map((r) => r.id),
        line.length ? line.join(' AND ') : '1 = 1',
        lineParams,
        typeof i.from === 'string' ? i.from : '0000-01-01',
        typeof i.to === 'string' ? i.to : '9999-12-31'
      )
      rows = [...rows, ...next.filter((r) => mine.has(r.id))]
      more = next.length === 200
    }
    rows = rows.slice(0, limit)
    const hidden = vendorHider()
    const shown = rows.filter((r) => !hidden(r.merchant) && !hidden(r.description))
    const full = new Map(shown.map((r) => [r.id, db.getTransaction(r.id)]))
    return {
      result: shown.map((r) => {
        const t = full.get(r.id)
        const parts = t?.splits.length ? { category: 'Split', parts: t.splits.map(partOut) } : {}
        return { id: r.id, date: date(r.posted), merchant: r.merchant, description: r.description, amount: r.cents / 100, category: r.category ?? 'Uncategorized', bucket: r.bucket ?? 'Personal', set_by: r.source, account: r.account, note: r.notes, pending: !!r.pending, ...(r.one_time ? { one_time: true } : {}), ...parts, ...(t?.tags.length ? { tags: t.tags } : {}) }
      })
    }
  },

  spending_summary: (i) => {
    const from = dayStart(String(i.from))
    const to = dayStart(String(i.to))
    const groupBy = i.group_by === 'merchant' || i.group_by === 'month' || i.group_by === 'bucket' ? i.group_by : 'category'
    const all = String(i.bucket ?? '').trim().toLowerCase() === 'all'
    const venture = all ? null : bucketRef(i.bucket)
    const groups = new Map<string, { spend: number; income: number; unsorted: number; ids: Set<string>; n: number }>()
    const group = (k: string): { spend: number; income: number; unsorted: number; ids: Set<string>; n: number } => {
      let g = groups.get(k)
      if (!g) groups.set(k, (g = { spend: 0, income: 0, unsorted: 0, ids: new Set(), n: 0 }))
      return g
    }
    let levers: Lever[] = []
    if (all || venture === null) {
      // Personal's money is the classifier's, read as the waterfall's rows read it (summary.ts): spending is
      // Committed, Everyday and One-offs, income is Take-home, and uncategorized money is in neither. With every
      // venture asked for too, a line placed in one is counted there whole, not again here, and a venture's use share
      // of a cost placed elsewhere (rooms rented in a house Personal holds) is the venture's cash out beside
      // Personal's share, so the cost counts once, whole.
      const [fromDay, toDay] = [db.dayKey(from), db.dayKey(to - 1)]
      // Read first: the waterfall's lines are kept (lines.ts), and Personal's below are the same days'.
      if (toDay >= fromDay) levers = getWaterfall({ from: fromDay, to: toDay }).levers
      const names = new Map<number, string>()
      // Personal's spending by category as getSummary groups it: a loan's interest paid by a transfer under the loan.
      const spentAs = spendingCategories()
      const keyOf = (l: LedgerLine, bucket: string, category = l.category ?? 'Uncategorized'): string =>
        groupBy === 'merchant' ? (l.merchant ?? l.description) : groupBy === 'month' ? l.day.slice(0, 7) : groupBy === 'bucket' ? bucket : category
      for (const l of ledgerLines(fromDay, toDay)) {
        if (all && l.bucketId !== null) continue
        // A venture's line, unless its intent gives it a class of Personal's (a gift that paid the venture's cost).
        if (l.owner !== null && !personalPart(l)) {
          const out = l.kind === 'expense' || (l.categoryId === null && l.cents < 0)
          // Money into a venture with no category is in neither, as a venture's books in db.ts leave it out.
          if (!all || !(out || l.kind === 'income')) continue
          if (!names.has(l.owner)) names.set(l.owner, bucketName(l.owner))
          const g = group(keyOf(l, names.get(l.owner)!))
          if (out) g.spend -= l.cents
          else g.income += l.cents
          g.ids.add(l.txnId)
          continue
        }
        const spend = SPENDING.has(l.cls)
        if (!spend && !TAKE_HOME.has(l.cls) && l.cls !== 'unsorted') continue
        const g = group(keyOf(l, 'Personal', spentAs(l).name))
        if (spend) g.spend -= l.cents
        else if (l.cls === 'unsorted') g.unsorted += l.cents
        else g.income += l.cents
        g.ids.add(l.txnId)
      }
    }
    // A venture's money is cash in and out by category, as its books read it.
    if (all || venture !== null) {
      for (const r of db.bucketSpending(all ? 'all' : [venture!], from, to, groupBy)) {
        const g = group(r.k)
        g.spend += r.spend
        g.income += r.income
        g.n += r.n
      }
    }
    const hidden = vendorHider()
    const rows = [...groups]
      .filter(([k]) => groupBy !== 'merchant' || !hidden(k))
      .sort((a, b) => b[1].spend - a[1].spend)
      .slice(0, 60)
      .map(([k, g]) => ({ [String(i.group_by)]: k, spending: g.spend / 100, income: g.income / 100, ...(g.unsorted ? { unsorted: g.unsorted / 100 } : {}), transactions: g.ids.size + g.n }))
    // With Personal's money, what would move its waterfall most at the span's end, as Home lists them.
    return { result: { groups: rows, levers: leversOut(levers, hidden) } }
  },

  categorize: (i, ctx) => {
    // A split transaction's categories are its parts' (split_transaction changes them).
    const given = existingIds(i.transaction_ids)
    const ids = given.filter((id) => !db.getTransaction(id)?.splits.length)
    if (!ids.length) throw new Error('Those transactions are split; change their parts with split_transaction')
    const cat = /^uncategorized$/i.test(String(i.category).trim()) ? null : categoryId(String(i.category))
    const merchant = typeof i.merchant === 'string' && i.merchant.trim() ? i.merchant.trim() : undefined
    // The assistant's own categorizations are marked as its: kept like the user's, but never mistaken for a hand edit.
    const source = ctx.origin === 'assistant' ? 'assistant' : 'user'
    db.inTransaction(() => {
      for (const id of ids) db.setTransactionFields(id, { categoryId: cat, source, ...(merchant ? { merchant } : {}) })
    })
    let alsoUpdated = 0
    if (i.remember === true && cat !== null) {
      const m = merchant ?? db.getTransaction(ids[0])?.merchant
      if (m) {
        db.upsertRule('merchant', m, cat)
        alsoUpdated = db.applyRulesToAll()
      }
    }
    db.applyBucketRules()
    const skipped = given.length - ids.length
    return { result: { updated: ids.length, rule_applied_to_others: alsoUpdated, ...(skipped ? { skipped_split: skipped } : {}) }, action: `Categorized ${ids.length} transaction${ids.length === 1 ? '' : 's'} as ${i.category}${merchant ? ` (${merchant})` : ''}${i.remember === true ? ', saved as a rule' : ''}` }
  },

  create_rule: (i) => {
    const field = i.field === 'contains' ? 'contains' : 'merchant'
    const pattern = String(i.pattern ?? '').trim()
    const cat = categoryId(String(i.category))
    const matches = db.countRuleMatches(field, pattern, cat)
    db.upsertRule(field, pattern, cat)
    const applied = db.applyRulesToAll()
    db.applyBucketRules()
    return { result: { matched: matches, applied_to: applied }, action: `Rule: ${field === 'merchant' ? 'merchant is' : 'description contains'} "${pattern}" → ${i.category}${applied ? ` (updated ${applied})` : ''}` }
  },

  create_category: (i) => {
    const c = db.saveCategory({ name: String(i.name), kind: (i.kind as 'expense' | 'income' | 'transfer') ?? 'expense', description: typeof i.description === 'string' ? i.description : '' })
    return { result: c, action: `New category: ${c.name} (${c.kind})` }
  },

  list_contributions: () => {
    const s = contributionSummary()
    const usd = (c: number | null): number | null => (c === null ? null : c / 100)
    return {
      result: {
        year: s.year,
        plans: s.plans.map((p) => ({
          name: p.name,
          kind: p.kind,
          employer: p.employer,
          paycheck_key: p.paycheckKey,
          cadence: p.cadence,
          percent: p.percent,
          per_paycheck: usd(p.employeeCents),
          match_per_paycheck: usd(p.matchCents),
          match_note: p.matchNote,
          match_rate_pct: p.matchRateBp === null ? null : p.matchRateBp / 100,
          match_cap_pct: p.matchCapBp === null ? null : p.matchCapBp / 100,
          ...(() => {
            const m = matchLeft(p)
            return m ? { match_left: { per_paycheck: m.leftCents / 100, per_month: m.leftPerMonthCents / 100, on_gross: m.grossCents / 100 } } : {}
          })(),
          ytd: usd(p.ytdCents),
          ytd_as_of: p.ytdAsOf,
          so_far: usd(p.soFarCents),
          checks_left: p.checksLeft,
          by_dec_31: usd(p.projectedCents),
          starts: p.startsDay,
          ends: p.endsDay,
          change: p.nextFrom ? { percent: p.nextPercent, per_paycheck: usd(p.nextEmployeeCents), from: p.nextFrom } : null,
          notes: p.notes
        })),
        limits: s.limits.map((l) => ({ ...l, limitCents: undefined, ytdCents: undefined, projectedCents: undefined, limitProvisional: undefined, limit: l.limitCents / 100, limit_estimated: l.limitProvisional || undefined, so_far: l.ytdCents / 100, by_dec_31: l.projectedCents / 100, room_left: (l.limitCents - l.projectedCents) / 100 })),
        withholding: s.withholding.map((w) => {
          const amounts = (a: WithholdingAmounts): Record<string, unknown> => ({
            federal: a.federalCents / 100,
            social_security: a.socialSecurityCents / 100,
            medicare: a.medicareCents / 100,
            state: a.stateCents / 100,
            insurance: a.insurance.map((x) => ({ type: x.name, amount: x.cents / 100, pretax: x.pretax })),
            other: a.otherCents / 100
          })
          return { paycheck_key: w.paycheckKey, employer: w.employer, cadence: w.cadence, as_of: w.asOf, gross: usd(w.grossCents), net: usd(w.netCents), per_paycheck: amounts(w), per_month: amounts(w.perMonth) }
        }),
        // The pay-day table: each payroll's last six checks this year and last, and the stub each one reads.
        pay_days: (() => {
          const today = db.today()
          const checks = payrollChecks(`${Number(today.slice(0, 4)) - 1}-01-01`, today)
          const stubDay = new Map(listPaystubs().map((st) => [st.id, st.payDay]))
          const keys = [...new Set(checks.map((c) => c.paycheckKey))]
          return keys.flatMap((k) =>
            checks
              .filter((c) => c.paycheckKey === k)
              .slice(-6)
              .map((c) => ({ paycheck_key: k, day: c.day, kind: c.kind, basis: c.basis, stub: c.stubId === null ? null : stubDay.get(c.stubId) ?? null, gross: c.grossCents / 100, taxes: c.taxesCents / 100, benefits: c.benefitsCents / 100, saved_at_work: c.savedAtWorkCents / 100, net: c.netCents / 100, deposit: c.depositCents / 100, difference: c.differenceCents / 100 }))
          )
        })()
      }
    }
  },

  record_paystub: (i) => {
    if (!Array.isArray(i.items)) throw new Error('items is a list: [{ kind, name, amount, ytd, pretax, employer }]')
    const items = (i.items as Array<Record<string, unknown>>).map((x) => ({
      kind: String(x.kind) as PaystubItemKind,
      name: typeof x.name === 'string' ? x.name : null,
      cents: cents(x.amount),
      ytdCents: x.ytd === undefined || x.ytd === null ? null : cents(x.ytd),
      pretax: typeof x.pretax === 'boolean' ? x.pretax : null,
      employerCents: x.employer === undefined || x.employer === null ? null : cents(x.employer)
    }))
    const id = savePaystub({
      paycheckKey: String(i.paycheck_key ?? ''),
      payDay: String(i.pay_day ?? ''),
      kind: typeof i.kind === 'string' && i.kind ? (i.kind as Paystub['kind']) : 'regular',
      periodFrom: typeof i.period_from === 'string' && i.period_from ? i.period_from : null,
      periodTo: typeof i.period_to === 'string' && i.period_to ? i.period_to : null,
      grossCents: cents(i.gross),
      netCents: i.net === undefined || i.net === null ? null : cents(i.net),
      items,
      documentId: typeof i.document === 'string' && i.document ? db.documentId(i.document) : null
    })
    return { result: { ok: true, id }, action: `Paystub: ${stubLine(db.getPaystub(id)!)}` }
  },

  // record_paystub's older form: a check's taxes and premiums, with the rest from the payroll's nearest stub before.
  set_paycheck_withholding: (i) => {
    const key = asPayrollKey(String(i.paycheck_key ?? ''))
    const day = String(i.as_of ?? '')
    if (!isRealDay(day)) throw new Error("as_of is the paystub's pay date, like 2026-10-02")
    if (i.insurance !== undefined && !Array.isArray(i.insurance)) throw new Error('insurance is a list: [{ type, per_paycheck, pretax }]')
    const stubs = listPaystubs(key).filter((s) => s.kind === 'regular')
    const base = stubs.find((s) => s.payDay === day) ?? stubs.filter((s) => s.payDay <= day).at(-1) ?? stubs.at(-1) ?? null
    let items: PaystubItem[] = base ? base.items.map((x) => ({ ...x, ytdCents: base.payDay === day ? x.ytdCents : null })) : []
    const line = (kind: PaystubItemKind, name: string, amount: number, pretax = PAYSTUB_ITEMS[kind].pretax): PaystubItem => ({ kind, name, cents: amount, ytdCents: null, pretax, employerCents: null })
    // other is the stub's unnamed other deductions; a deduction with a name of its own (a premium of no known type,
    // like Accident insurance) is one of the premiums, as the money-flow charts read them.
    const isOther = (x: PaystubItem): boolean => x.kind === 'other_deduction' && x.name === PAYSTUB_ITEMS.other_deduction.label
    const fields: Array<[string, PaystubItemKind, (x: PaystubItem) => boolean]> = [
      ['federal', 'federal', (x) => x.kind === 'federal'],
      ['social_security', 'social_security', (x) => x.kind === 'social_security'],
      ['medicare', 'medicare', (x) => x.kind === 'medicare'],
      ['state', 'state', (x) => x.kind === 'state'],
      ['other', 'other_deduction', isOther]
    ]
    // A tax given takes the place (and the name) of the stub's line of that kind.
    for (const [field, kind, mine] of fields) {
      if (i[field] === undefined) continue
      const at = items.findIndex(mine)
      const amount = i[field] === null ? 0 : cents(i[field])
      const fresh = amount ? [line(kind, at < 0 ? PAYSTUB_ITEMS[kind].label : items[at].name, amount)] : []
      items = at < 0 ? [...items, ...fresh] : [...items.slice(0, at), ...fresh, ...items.slice(at + 1).filter((x) => !mine(x))]
    }
    if (Array.isArray(i.insurance)) {
      items = items.filter((x) => PAYSTUB_ITEMS[x.kind].row !== 'benefits' || isOther(x))
      for (const x of i.insurance as Array<Record<string, unknown>>) {
        const name = String(x.type ?? x.name ?? '').trim()
        if (!name) throw new Error('Each insurance premium needs a type, like Medical insurance')
        items.push(line(premiumKind(name), name, cents(x.per_paycheck ?? x.amount), x.pretax === true))
      }
    }
    if (!items.some((x) => PAYSTUB_ITEMS[x.kind].row === 'savedAtWork')) items.push(...elections(key, day))
    // Taxes, then benefits, then savings plans, each in the order given.
    const ROWS = ['taxes', 'benefits', 'savedAtWork']
    items = items.map((x, n) => ({ x, n })).sort((a, b) => ROWS.indexOf(PAYSTUB_ITEMS[a.x.kind].row) - ROWS.indexOf(PAYSTUB_ITEMS[b.x.kind].row) || a.n - b.n).map(({ x }) => x)
    const taken = items.reduce((s, x) => s + x.cents, 0)
    const same = base && base.payDay === day ? base : null
    // That day's stub, when its gross wasn't on record, keeps the net pay it was given, and its gross stays net plus the lines.
    const given = i.gross === undefined || i.gross === null ? (same && !same.estimated ? same.grossCents : null) : cents(i.gross)
    const net = i.net === undefined || i.net === null ? (same?.estimated && given === null ? same.netCents : null) : cents(i.net)
    if (given === null && net === null) throw new Error('Give gross (or net) pay from the paystub')
    const id = savePaystub({ paycheckKey: key, payDay: day, grossCents: given ?? net! + taken, items, source: same ? same.source : 'paystub', estimated: given === null })
    return { result: { ok: true, id }, action: `Paystub: ${stubLine(db.getPaystub(id)!)}` }
  },

  // It removes the payroll's latest paystub.
  delete_paycheck_withholding: (i) => {
    const key = asPayrollKey(String(i.paycheck_key ?? ''))
    const latest = listPaystubs(key).at(-1)
    if (!latest) throw new Error(`No paystub recorded for ${key}`)
    db.deletePaystub(latest.id)
    return { result: { ok: true, pay_day: latest.payDay }, action: `Removed paystub: ${key.replace(/\|\+$/, '')} · ${latest.payDay}` }
  },

  set_contribution: (i) => {
    const d = (v: unknown): number | null | undefined => (v === undefined ? undefined : v === null ? null : Math.round(Number(v) * 100))
    const id = db.saveContribution({
      name: String(i.name ?? ''),
      kind: String(i.kind) as ContributionKind,
      ...(typeof i.account_id === 'string' ? { accountId: i.account_id ? account(i.account_id).id : null } : {}),
      ...(typeof i.paycheck_key === 'string' ? { paycheckKey: i.paycheck_key } : {}),
      ...(i.percent !== undefined ? { percent: i.percent === null ? null : Number(i.percent) } : {}),
      ...(i.per_paycheck !== undefined ? { employeeCents: d(i.per_paycheck) } : {}),
      ...(i.match_per_paycheck !== undefined ? { matchCents: d(i.match_per_paycheck) } : {}),
      ...(typeof i.match_note === 'string' ? { matchNote: i.match_note } : {}),
      ...(i.match_rate_pct !== undefined ? { matchRateBp: i.match_rate_pct === null ? null : Math.round(Number(i.match_rate_pct) * 100) } : {}),
      ...(i.match_cap_pct !== undefined ? { matchCapBp: i.match_cap_pct === null ? null : Math.round(Number(i.match_cap_pct) * 100) } : {}),
      ...(i.ytd !== undefined ? { ytdCents: d(i.ytd) } : {}),
      ...(typeof i.ytd_as_of === 'string' ? { ytdAsOf: i.ytd_as_of || null } : {}),
      ...(typeof i.starts === 'string' ? { startsDay: i.starts || null } : {}),
      ...(typeof i.ends === 'string' ? { endsDay: i.ends || null } : {}),
      ...(i.next_percent !== undefined ? { nextPercent: i.next_percent === null ? null : Number(i.next_percent) } : {}),
      ...(i.next_per_paycheck !== undefined ? { nextEmployeeCents: d(i.next_per_paycheck) } : {}),
      ...(i.next_from !== undefined ? { nextFrom: typeof i.next_from === 'string' && i.next_from ? i.next_from : null } : {}),
      ...(typeof i.notes === 'string' ? { notes: i.notes } : {})
    })
    const what = [typeof i.percent === 'number' ? `${i.percent}%` : null, typeof i.next_percent === 'number' ? `→ ${i.next_percent}% from ${String(i.next_from ?? '')}` : null, i.per_paycheck !== undefined ? `$${Number(i.per_paycheck).toFixed(2)}/check` : null, i.match_per_paycheck !== undefined ? `match $${Number(i.match_per_paycheck).toFixed(2)}` : null, typeof i.match_rate_pct === 'number' && typeof i.match_cap_pct === 'number' ? `match ${i.match_rate_pct}% of the first ${i.match_cap_pct}%` : null, i.ytd !== undefined ? `$${Number(i.ytd).toFixed(2)} so far (${String(i.ytd_as_of ?? '')})` : null].filter(Boolean).join(', ')
    return { result: { ok: true, id }, action: `Contribution: ${String(i.name).trim()}${what ? ` · ${what}` : ''}` }
  },

  delete_contribution: (i) => {
    const row = db.listContributionRows().find((r) => r.name.toLowerCase() === String(i.name ?? '').trim().toLowerCase())
    if (!row) throw new Error(`No contribution named ${String(i.name)}`)
    db.deleteContribution(row.id)
    return { result: { ok: true }, action: `Removed contribution: ${row.name}` }
  },

  list_buckets: () => ({
    result: listVentures().map((b) => ({
      name: b.name,
      kind: b.kind,
      description: b.description || undefined,
      in_net_worth: b.inNetWorth,
      share_pct: b.shareBp / 100,
      value_source: b.valueSource,
      ...(b.stakeAccountId ? { stake_account_id: b.stakeAccountId } : {}),
      position: b.positionCents / 100,
      transactions: b.txnCount,
      money_in: b.inCents / 100,
      money_out: b.outCents / 100,
      operating: b.operatingCents / 100,
      gains: b.gainsCents / 100,
      total: b.totalCents / 100,
      first: b.firstPosted === null ? null : date(b.firstPosted),
      last: b.lastPosted === null ? null : date(b.lastPosted),
      rules: db.listBucketRules(b.id).map(ruleOut)
    }))
  }),

  bucket_summary: (i) => {
    const d = getVenture(requireBucket(i.bucket))
    const v = d.result
    const hidden = vendorHider()
    const usd = (x: { inCents: number; outCents: number }): { in: number; out: number; net: number } => ({ in: x.inCents / 100, out: x.outCents / 100, net: (x.inCents - x.outCents) / 100 })
    const dollars = (c: number | null): number | null => (c === null ? null : c / 100)
    return {
      result: {
        name: d.bucket.name,
        kind: d.bucket.kind,
        in_net_worth: d.bucket.inNetWorth,
        // The money between Personal and it: its shares, claims, basis, stake and position (set_venture_share, set_venture_value).
        owner: ownerOut(v.owner),
        total: usd(d.bucket),
        by_year: d.byYear.map((r) => ({ year: r.year, ...usd(r) })),
        by_category: d.byCategory.map((r) => ({ category: r.name, transactions: r.count, ...usd(r) })),
        top_payees: d.topPayees.filter((r) => !hidden(r.name)).map((r) => ({ payee: r.name, transactions: r.count, ...usd(r) })),
        accounts: d.accounts.map((a) => ({ id: a.id, name: a.name, type: a.assetType, balance: a.balanceCents === null ? null : a.balanceCents / 100 })),
        rules: d.rules.map(ruleOut),
        result: {
          operating: usd(v),
          ...(v.personalUse.length ? { personal_use: v.personalUse.map((u) => ({ ...(u.assetId ? { asset: account(u.assetId).name } : { residence: true }), from: u.fromDay, to: u.toDay, personal_pct: u.personalBp / 100, net: u.cents / 100 })) } : {}),
          left_out_of_operating: { purchase: v.purchaseCents / 100, sale_proceeds: v.proceedsCents / 100, lent: v.lentCents / 100, paid_back: v.repaidCents / 100 },
          equity_paid_down: v.principalCents / 100,
          assets: v.assets.map((a) => ({
            name: a.name,
            type: a.assetType,
            bought: a.boughtDay,
            sold: a.soldDay,
            cost: dollars(a.costCents),
            ...(a.repaidCents !== null
              ? { still_owed: a.valueCents / 100, paid_back: a.repaidCents / 100 }
              : a.sold
                ? { sale_price: a.valueCents / 100, selling_costs: dollars(a.saleCostsCents) }
                : { value: a.valueCents / 100 }),
            gain: dollars(a.gainCents),
            ...(a.gainFrom === 'returns' ? { gain_from: 'returns' } : {}),
            realized: a.sold,
            ...(a.owedCents ? { owed: a.owedCents / 100 } : {}),
            equity: a.equityCents / 100
          })),
          gains: { realized: v.realizedCents / 100, on_paper: v.onPaperCents / 100 },
          ...(v.missingCost.length ? { missing_cost: v.missingCost } : {}),
          total: v.totalCents / 100
        }
      }
    }
  },

  create_bucket: (i) => {
    const kind = String(i.kind) as BucketKind
    const id = db.saveBucket({ name: String(i.name ?? ''), kind, description: typeof i.description === 'string' ? i.description : '', inNetWorth: i.in_net_worth !== false })
    return { result: { ok: true, id }, action: `New venture: ${String(i.name).trim()} (${kind})` }
  },

  update_bucket: (i) => {
    const id = requireBucket(i.bucket)
    const b = db.listBuckets().find((x) => x.id === id)!
    db.saveBucket({
      id,
      name: typeof i.name === 'string' && i.name.trim() ? i.name : b.name,
      kind: typeof i.kind === 'string' ? (i.kind as BucketKind) : b.kind,
      ...(typeof i.description === 'string' ? { description: i.description } : {}),
      ...(typeof i.in_net_worth === 'boolean' ? { inNetWorth: i.in_net_worth } : {})
    })
    const what = [
      typeof i.name === 'string' ? `renamed "${i.name}"` : null,
      typeof i.kind === 'string' ? `kind ${i.kind}` : null,
      typeof i.description === 'string' ? 'notes updated' : null,
      typeof i.in_net_worth === 'boolean' ? (i.in_net_worth ? 'share 100%' : 'share 0%') : null
    ]
      .filter(Boolean)
      .join(', ')
    return { result: { ok: true }, action: `${b.name}: ${what}` }
  },

  set_venture_share: (i) => {
    const id = requireBucket(i.venture)
    const name = bucketLabel(id)
    const from = String(i.from ?? '').trim()
    if (!isRealDay(from)) throw new Error('from is the day the share starts, like 2026-01-15')
    const pct = i.share_pct
    if (pct !== null && (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100)) throw new Error('share_pct is a percent from 0 to 100, or null to remove the row')
    const bp = pct === null ? null : Math.round(pct * 100)
    if (bp !== null && Math.abs(pct! * 100 - bp) > 1e-6) throw new Error('share_pct has at most two decimals')
    if (bp === null && !db.ventureShareRows(id).some((r) => r.fromDay === from)) throw new Error(`${name} has no share from ${from}`)
    db.setVentureShare(id, from, bp, 'review')
    const shares = db.ventureShareRows(id).map((r) => ({ from: r.fromDay, share_pct: r.shareBp / 100, source: r.source }))
    return { result: { ok: true, shares }, action: `${name}: ${bp === null ? `share from ${from} removed` : `share ${bp / 100}% from ${from}`}` }
  },

  set_venture_money: (i, ctx) => {
    const v = requireBucket(i.venture)
    const name = bucketLabel(v)
    const ids = existingIds(i.transaction_ids)
    const intent = String(i.intent ?? '').trim()
    const none = intent === 'none'
    if (!none && !VENTURE_INTENTS.includes(intent as VentureIntent)) throw new Error(`intent is one of ${VENTURE_INTENTS.join(', ')}, or none to remove what was set`)
    const given = (k: string): boolean => i[k] !== undefined && i[k] !== null
    // What each line is made of, as asked: one intent for all of it, or parts with their amounts.
    const asked: Array<{ intent: VentureIntent; cents: number | null }> = []
    if (given('parts')) {
      if (none) throw new Error('intent none removes what was set: it takes no parts')
      if (!Array.isArray(i.parts) || !i.parts.length) throw new Error('parts is a list of {intent, amount} in dollars')
      for (const p of i.parts as Input[]) {
        const pi = String(p?.intent ?? '')
        if (!VENTURE_INTENTS.includes(pi as VentureIntent)) throw new Error(`each part's intent is one of ${VENTURE_INTENTS.join(', ')}`)
        const c = Math.abs(cents(p.amount))
        if (!c) throw new Error("each part's amount is above 0")
        asked.push({ intent: pi as VentureIntent, cents: c })
      }
      if (new Set(asked.map((p) => p.intent)).size !== asked.length) throw new Error('one part an intent: add up the amounts of the same intent')
    } else if (!none) asked.push({ intent: intent as VentureIntent, cents: null })
    const intents = new Set(asked.map((p) => p.intent))
    const interest = given('interest') ? cents(i.interest) : 0
    if (interest < 0) throw new Error('interest is dollars, 0 or more')
    if (interest && !intents.has('loan_repayment') && !intents.has('venture_loan_repayment')) throw new Error("interest is a repayment's: loan_repayment or venture_loan_repayment")
    const share = given('share_after_pct') ? Number(i.share_after_pct) : null
    if (share !== null) {
      if (!Number.isFinite(share) || share < 0 || share > 100) throw new Error('share_after_pct is a percent from 0 to 100')
      if (Math.abs(share * 100 - Math.round(share * 100)) > 1e-6) throw new Error('share_after_pct has at most two decimals')
      if (ids.length !== 1) throw new Error("share_after_pct is the share from one transaction's day: give one transaction")
      if (!intents.has('equity') && !intents.has('capital_return')) throw new Error('share_after_pct goes with equity or capital_return, the money that changes the share')
    }
    if (given('regular') && typeof i.regular !== 'boolean') throw new Error('regular is true or false')
    if (given('regular') && !intents.has('draw')) throw new Error("regular is a draw's: whether the venture pays it every month")
    const regular = given('regular') ? i.regular === true : null
    const remember = i.remember === true
    if (remember && (none || given('parts') || interest || share !== null)) throw new Error('remember takes one intent, with no parts, interest or share')

    // Each transaction's boundary with the venture: a transfer, its cost or revenue, a funding, or a Personal line to tie to it.
    const found = boundariesOf(ids)
    const label = (b: Boundary): string => `${db.getTransaction(b.txnId)?.description ?? b.txnId} on ${b.day}`
    const lines: Boundary[] = []
    for (const id of ids) {
      const mine = found.filter((b) => b.txnId === id)
      const t = db.getTransaction(id)!
      // intent none clears what was stored with the venture, whether it still fits the line or not.
      if (none) {
        const kept = [...new Map(db.ventureMoneyRows([id]).filter((r) => r.venture_id === v).map((r) => [`${r.split_id ?? ''}:${r.face}`, r])).values()]
        for (const r of kept) lines.push({ txnId: id, splitId: r.split_id, day: date(t.posted), accountId: t.accountId, lineCents: t.amountCents, shape: null, ventureId: v, face: r.face, cents: 0, payeeKey: '', capitalAssetId: null, capital: false, heldAs: null })
        if (kept.length) continue
      }
      const held = mine.find((b) => b.heldAs !== null)?.heldAs
      if (!mine.some((b) => b.shape !== null) && held) {
        const where = { internal: "another of the user's cash and cards", invested: 'an investment account', principal: 'a debt', debt: 'a debt', capital: 'an asset', transfer: "the line on the user's side of this transfer" }[held as string] ?? "another of the user's accounts"
        throw new Error(
          held === 'transfer'
            ? `${t.description} on ${date(t.posted)} is the venture's own leg of a transfer with the user's cash and cards: give the intent to ${where}`
            : `${t.description} on ${date(t.posted)} moves money to or from ${where}, which holds it already: tied to ${name}, it would count twice`
        )
      }
      if (!mine.some((b) => b.shape !== null)) throw new Error(`${t.description} on ${date(t.posted)} isn't in Personal's books: money between the user and a venture is on their own cash and cards, or a Personal line a venture's cash or card paid`)
      const withIt = mine.filter((b) => b.ventureId === v)
      const pick = withIt.length ? withIt : mine.filter((b) => b.shape === 'R')
      if (!pick.length) throw new Error(`${t.description} on ${date(t.posted)} is money with ${bucketLabel(mine.find((b) => b.ventureId !== null)?.ventureId ?? null)}, not ${name}`)
      if (pick.length > 1) throw new Error(`${t.description} on ${date(t.posted)} is split into parts: split transactions take no intent yet`)
      lines.push(pick[0])
    }
    lines.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0))
    if (remember) {
      if (lines.some((b) => b.shape === 'R')) throw new Error('A line tied to a venture by hand has no pattern to remember: give each its intent')
      const patterns = new Set(lines.map((b) => `${b.shape}|${b.cents < 0 ? 'out' : 'in'}|${b.shape === 'T' ? b.payeeKey : ''}`))
      if (patterns.size !== 1) throw new Error('remember is for one pattern: lines of one kind (transfers from one payee, costs and revenue, or fundings) and one direction')
    }

    // Each line's parts, checked in day order against the venture's claims and share then.
    const shares = db.ventureShareRows(v)
    const migrated = shares.every((s) => s.source === 'migrated')
    const earlier = intentParts('0000-01-01', '9999-12-31').filter((p) => p.ventureId === v && !ids.includes(p.txnId))
    const planned: Array<{ b: Boundary; parts: Array<{ intent: VentureIntent; cents: number; interestCents: number }> }> = []
    for (const b of lines) {
      if (none) {
        planned.push({ b, parts: [] })
        continue
      }
      if (b.capitalAssetId) throw new Error(`${label(b)} is marked as capital (mark_capital): its money counts there; unmark it first`)
      if (b.capital) throw new Error(`${label(b)} is capital already: an asset's purchase, sale or a loan's window takes it, so its money counts there`)
      if (!b.cents) throw new Error(`${label(b)} moves no money with ${name}`)
      const direction = b.cents < 0 ? 'out' : 'in'
      const whole = Math.abs(b.cents)
      const parts = asked.map((p) => ({ intent: p.intent, cents: Math.sign(b.cents) * (p.cents ?? whole), interestCents: 0 }))
      const sum = parts.reduce((s, p) => s + Math.abs(p.cents), 0)
      if (sum !== whole) throw new Error(`the parts add up to ${money(sum)}, and ${label(b)} is ${money(whole)}${b.face === 'fund' ? ' of funding' : ''}: they add up to it`)
      for (const p of parts) {
        if (!INTENT_DIRECTIONS[p.intent].includes(direction)) throw new Error(`${p.intent} is money ${INTENT_DIRECTIONS[p.intent][0] === 'out' ? 'out to' : 'back from'} a venture, and ${label(b)} is money ${direction === 'out' ? `out to ${name}` : `back from ${name}`}${b.face === 'fund' ? ' (its funding)' : ''}`)
      }
      const repayment = parts.find((p) => p.intent === 'loan_repayment' || p.intent === 'venture_loan_repayment')
      if (interest && repayment) {
        if (interest > Math.abs(repayment.cents)) throw new Error(`interest of ${money(interest)} is above ${label(b)}'s ${money(Math.abs(repayment.cents))}`)
        repayment.interestCents = interest
      }
      const shareBp = shareOn(shares, b.day)
      for (const p of parts) {
        if ((p.intent === 'equity' || p.intent === 'capital_return') && migrated && share === null)
          throw new Error(`${name}'s share is still the one net worth counted it at before shares were kept: give the share after this (share_after_pct), or record the user's share first (set_venture_share)`)
        if ((p.intent === 'draw' || p.intent === 'capital_return') && shareBp === 0) throw new Error(`the user owns none of ${name} on ${b.day}: ${p.intent === 'draw' ? 'a draw' : 'a return of capital'} needs a share (set_venture_share); with none it's a gift, a reimbursement or a repayment`)
      }
      // A repayment's principal can't be more than is owed on its day.
      const claims = claimsThrough([...earlier, ...planned.flatMap((x) => x.parts.map((p) => ({ ...x.b, ventureId: v, ...p, regular: null, source: null })))], b.day)
      for (const p of parts) {
        const principal = Math.abs(p.cents) - p.interestCents
        if (p.intent === 'loan_repayment' && principal > claims.lentCents) throw new Error(`${label(b)} pays back ${money(principal)} of principal, and ${money(Math.max(0, claims.lentCents))} is lent to ${name} that day: the rest is interest (interest), or another intent`)
        if (p.intent === 'venture_loan_repayment' && principal > claims.borrowedCents) throw new Error(`${label(b)} pays back ${money(principal)} of principal, and ${money(Math.max(0, claims.borrowedCents))} is borrowed from ${name} that day: the rest is interest (interest), or another intent`)
      }
      planned.push({ b, parts })
    }

    const source = ctx.origin === 'user' ? 'user' : 'review'
    const rule = db.inTransaction(() => {
      for (const { b, parts } of planned) db.setVentureMoney(b.txnId, b.splitId, b.face, parts.map((p) => ({ ventureId: v, ...p, regular: p.intent === 'draw' ? regular : null, source })))
      if (share !== null) db.setVentureShare(v, lines[0].day, Math.round(share * 100), source)
      if (!remember) return null
      const b = lines[0]
      return db.rememberVentureMoney({ venture_id: v, shape: b.shape as 'T' | 'C' | 'F', direction: b.cents < 0 ? 'out' : 'in', payee_key: b.shape === 'T' ? b.payeeKey : null, intent, regular: regular === null ? null : regular ? 1 : 0 })
    })
    const n = planned.length
    const what = none ? 'unset' : asked.length > 1 ? asked.map((p) => `${p.intent} ${money(p.cents!)}`).join(' and ') : intent
    return {
      result: { ok: true, lines: n, ...(share !== null ? { share_pct: share } : {}), ...(rule !== null ? { rule_id: rule } : {}) },
      action: `${name}: ${n} ${n === 1 ? 'line' : 'lines'} ${what}${interest ? `, interest ${money(interest)}` : ''}${share !== null ? `, share ${share}% after` : ''}${remember ? ', remembered for its pattern' : ''}`
    }
  },

  set_venture_value: (i) => {
    const id = requireBucket(i.venture)
    const name = bucketLabel(id)
    if (i.source !== 'books' && i.source !== 'estimate') throw new Error('source is books (its share of the net assets) or estimate (a Stakes account)')
    const was = db.ventureValueFields(id)!
    const stake = i.stake_account_id === undefined ? was.stakeAccountId : i.stake_account_id === null || i.stake_account_id === '' ? null : String(i.stake_account_id)
    if (stake !== null) {
      // Money a capital line put in the Stakes account would count twice: as Bought assets and in the stake.
      const marked = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE capital_asset_id = ?', stake)?.n ?? 0
      if (marked) throw new Error(`${marked} ${marked === 1 ? 'transaction is' : 'transactions are'} marked as capital for ${account(stake).name}: unmark ${marked === 1 ? 'it' : 'them'} first (mark_capital with asset_id null)`)
    }
    db.setVentureValue(id, i.source, stake)
    const linked = stake ? `, stake ${account(stake).name}` : ''
    return { result: { ok: true, value_source: i.source, stake_account_id: stake }, action: `${name}: valued by ${i.source === 'books' ? 'its books' : 'an estimate'}${linked}` }
  },

  mark_one_time: (i) => {
    const ids = (Array.isArray(i.transaction_ids) ? i.transaction_ids : []).map(String)
    if (!ids.length) throw new Error('transaction_ids is required')
    const on = i.one_time !== false
    const n = db.setOneTime(ids, on)
    return { result: { updated: n }, action: `${n} ${n === 1 ? 'purchase' : 'purchases'} ${on ? 'marked one-time (budgeted as one-offs)' : 'no longer one-time (counted by category again)'}` }
  },

  add_trip: (i) => {
    const t = saveTrip({ id: typeof i.id === 'string' ? i.id : null, name: String(i.name ?? ''), from: String(i.from ?? ''), to: String(i.to ?? '') })
    return { result: t, action: `Trip: ${t.name}, ${t.from} to ${t.to} (budgeted as one-offs)` }
  },

  list_trips: () => ({ result: listTrips() }),

  hide_vendor: (i) => {
    const vendor = String(i.vendor ?? '').trim()
    // Hiding matches any merchant that contains the text, so a short one would hide too much.
    if (vendor.length < 3) throw new Error('vendor must be at least 3 characters')
    const now = hiddenVendors()
    setHiddenVendors(i.hidden === false ? now.filter((v) => v.toLowerCase() !== vendor.toLowerCase()) : [...now, vendor])
    // The list itself stays on the PC.
    return { result: { ok: true }, action: i.hidden === false ? `Vendor shown again: ${vendor}` : `Vendor hidden: ${vendor}` }
  },

  list_habits: () => {
    const hidden = vendorHider()
    return {
      result: getBudget(thisMonth())
        .habits.filter((h) => !hidden(h.title) && !hidden(h.detail))
        .map((h) => ({
          id: h.id,
          habit: h.title,
          detail: h.detail || undefined,
          committed: h.committed ? { commitment: h.committed.label, saves_per_month: money(h.committed.savingsCents), this_month: h.committed.progress?.text ?? null } : null,
          options: h.options.map((o) => ({ id: o.id, commitment: o.label, saves_per_month: money(o.savingsCents) }))
        }))
    }
  },

  commit_habit: (i) => {
    const month = thisMonth()
    const id = String(i.habit ?? '').trim()
    if (!id) throw new Error('habit is required')
    // A hidden habit back by its id, the others staying hidden; "all" brings every one back.
    if (i.hide === false) {
      if (id === 'all') {
        hideHabit(null)
        return { result: { ok: true }, action: 'Hidden habits shown again' }
      }
      if (!showHabit(id)) {
        const hidden = hiddenHabits()
        throw new Error(`${id} isn't hidden; ${hidden.length ? `the hidden habits are ${hidden.join(', ')}` : 'no habit is hidden'} (habit "all" shows every one)`)
      }
      return { result: { ok: true }, action: `Habit shown again: ${id.replace(/^store:[^:]+:/, '')}` }
    }
    if (i.hide === true) {
      hideHabit(id)
      return { result: { ok: true }, action: `Habit hidden: ${id.replace(/^store:[^:]+:/, '')}` }
    }
    const h = getBudget(month).habits.find((x) => x.id === id)
    if (!h) throw new Error('No such habit this month; list_habits has the ids')
    if (i.undo === true) {
      commitHabit(month, h.id, null)
      return { result: { ok: true }, action: `Commitment undone: ${h.committed?.label ?? h.title}` }
    }
    const o = h.options.find((x) => x.id === String(i.option ?? ''))
    if (!o) throw new Error(`option must be one of: ${h.options.map((x) => x.id).join(', ')}`)
    commitHabit(month, h.id, o.id)
    return { result: { ok: true }, action: `Committed: ${o.label} (${money(o.savingsCents)} a month)` }
  },

  set_category_target: (i) => {
    const id = categoryId(String(i.category ?? ''))
    const c = db.listCategories().find((x) => x.id === id)!
    if (c.kind !== 'expense') throw new Error(`${c.name} isn't a spending category`)
    const amount = centsField(i.amount, 'amount')
    if (amount === undefined && typeof i.rollover !== 'boolean') throw new Error('Nothing to change: give amount, rollover or both')
    if (amount !== undefined && amount !== null && amount < 0) throw new Error('amount must be zero or more')
    const what: string[] = []
    if (amount !== undefined) {
      setCategoryTarget(id, amount)
      what.push(amount === null ? 'target back to the suggestion' : `${money(amount)} a month`)
    }
    if (typeof i.rollover === 'boolean') {
      setBudgetRollover(id, i.rollover)
      what.push(i.rollover ? 'rollover on' : 'rollover off')
    }
    return { result: { ok: true }, action: `${c.name}: ${what.join(', ')}` }
  },

  // Tiers are kept by the category's name, as the budget reads them.
  set_category_tier: (i) => {
    const id = categoryId(String(i.category ?? ''))
    const c = db.listCategories().find((x) => x.id === id)!
    if (c.kind !== 'expense') throw new Error(`${c.name} isn't a spending category`)
    const tier = i.tier === null ? null : BUDGET_TIERS.find((t) => t.id === i.tier)
    if (tier === undefined) throw new Error(`tier must be one of ${BUDGET_TIERS.map((t) => t.id).join(', ')}, or null for its default`)
    setBudgetTier(c.name, tier?.id ?? null)
    return { result: { ok: true }, action: tier ? `${c.name}: ${tier.label}` : `${c.name}: back to its default tier` }
  },

  set_cheaper_store: (i) => {
    if (i.store !== null && typeof i.store !== 'string') throw new Error('store is a store name, or null for none')
    const store = typeof i.store === 'string' ? i.store.trim() : ''
    // A store is found by the text in a purchase's merchant, so a short one would match too much, and one longer than
    // a merchant's name could never match at all.
    if (store && store.length < 3) throw new Error('store must be at least 3 characters')
    if (store.length > db.MERCHANT_MAX) throw new Error(`store must be at most ${db.MERCHANT_MAX} characters, as a merchant's name is`)
    setCheaperStore(store || null)
    return { result: { ok: true }, action: store ? `Cheaper grocer: ${store}` : 'No cheaper grocer' }
  },

  set_one_off_budget: (i) => {
    const amount = centsField(i.amount, 'amount')
    if (amount === undefined) throw new Error('amount is dollars a month, or null for the average')
    if (amount !== null && amount < 0) throw new Error('amount must be zero or more')
    setOneOffBudget(amount)
    return { result: { ok: true }, action: amount === null ? 'One-off budget back to the average' : `One-off budget: ${money(amount)} a month` }
  },

  remove_trip: (i) => {
    const t = removeTrip(String(i.trip ?? ''))
    return { result: { ok: true }, action: `Removed the ${t.name} trip` }
  },

  set_bucket: (i) => {
    const ids = existingIds(i.transaction_ids)
    const bucketId = bucketRef(i.bucket)
    db.setTransactionsBucket(ids, bucketId)
    return { result: { updated: ids.length }, action: `Moved ${ids.length} transaction${ids.length === 1 ? '' : 's'} to ${bucketLabel(bucketId)}` }
  },

  add_bucket_rule: (i) => {
    const r = ruleInput(i)
    const ruleId = db.addBucketRule(r)
    const moved = db.applyBucketRules()
    const what = [r.accountId ? account(r.accountId).name : null, typeof i.category === 'string' && i.category.trim() ? i.category.trim() : null, typeof i.contains === 'string' && i.contains.trim() ? `"${i.contains.trim()}"` : null, typeof i.amount === 'number' ? money(Math.round(i.amount * 100)) : null, i.from || i.to ? `${String(i.from ?? '…')} to ${String(i.to ?? '…')}` : null].filter(Boolean).join(', ')
    if (r.assetId) return { result: { ok: true, rule_id: ruleId, moved }, action: `Asset rule: ${what} → ${account(r.assetId).name}${moved ? ` (put ${moved} on it)` : ''}` }
    return { result: { ok: true, rule_id: ruleId, moved }, action: `Venture rule: ${what} → ${bucketLabel(r.bucketId!)}${moved ? ` (moved ${moved})` : ''}` }
  },

  delete_bucket_rule: (i) => {
    const id = Number(i.rule_id)
    const r = db.listBucketRules().find((x) => x.id === id)
    if (!r) throw new Error(`No bucket rule ${id}`)
    db.deleteBucketRule(id)
    const moved = db.applyBucketRules()
    if (r.assetId) return { result: { ok: true, moved }, action: `Removed a ${r.assetName ?? r.assetId} asset rule${moved ? ` (${moved} off it)` : ''}` }
    return { result: { ok: true, moved }, action: `Removed a ${bucketLabel(r.bucketId)} venture rule${moved ? ` (${moved} back to Personal)` : ''}` }
  },

  set_asset_use: (i) => {
    const a = costedAccount(i.asset_id)
    if (!Array.isArray(i.uses)) throw new Error('uses is a list of { owner, share_pct, from, to?, basis? }; an empty list clears them')
    const rows: UseRow[] = (i.uses as Array<Record<string, unknown>>).map((u) => {
      const pct = Number(u.share_pct)
      if (!Number.isFinite(pct)) throw new Error('Each use needs share_pct, a percent like 66 or 34.5')
      const basis = typeof u.basis === 'string' && u.basis ? u.basis : null
      if (basis !== null && !(USE_BASES as readonly string[]).includes(basis)) throw new Error(`basis is one of ${USE_BASES.join(', ')}`)
      return { fromDay: String(u.from ?? ''), toDay: typeof u.to === 'string' && u.to ? u.to : null, bucketId: bucketRef(u.owner), shareBp: Math.round(pct * 100), basis: basis as UseRow['basis'], source: 'review' }
    })
    saveUses(a.id, rows)
    const spans = new Map<string, string[]>()
    for (const r of rows) {
      const span = `${r.fromDay} to ${r.toDay ?? 'now'}`
      spans.set(span, [...(spans.get(span) ?? []), `${bucketLabel(r.bucketId)} ${r.shareBp / 100}%${r.basis ? ` by ${r.basis}` : ''}`])
    }
    return { result: { ok: true, uses: listUses(a.id).length }, action: rows.length ? `${a.name}: ${[...spans].map(([span, owners]) => `${span}, ${owners.join(' · ')}`).join('; ')}` : `${a.name}: no uses, its own alone` }
  },

  place_on_asset: (i) => {
    const ids = existingIds(i.transaction_ids)
    const asset = typeof i.asset_id === 'string' && i.asset_id ? costedAccount(i.asset_id) : null
    if (!asset && i.asset_id !== null && i.asset_id !== '') throw new Error('asset_id is a house, vehicle or other asset from list_accounts, or null to take them off')
    if (i.split_id !== undefined && ids.length !== 1) throw new Error('split_id names a part of one transaction: give that one id')
    if (i.split_id !== undefined && !asset) {
      // A part off its own asset follows its transaction, so while the transaction is on one the part stays on it.
      const on = db.get<{ asset_id: string | null; own_bucket: number }>('SELECT t.asset_id, s.own_bucket FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE s.id = ?', Number(i.split_id))
      if (on?.asset_id && !on.own_bucket) throw new Error(`That part follows its transaction, which is on ${account(on.asset_id).name}: take the transaction off (no split_id), then put its other parts on by split_id`)
    }
    const n = attachToAsset(ids, asset?.id ?? null, 'ai', i.split_id === undefined ? undefined : Number(i.split_id))
    const what = i.split_id !== undefined ? 'part' : `${n} ${n === 1 ? 'transaction' : 'transactions'}`
    return { result: { updated: n }, action: asset ? `${what} put on ${asset.name}` : `${what} taken off any asset` }
  },

  set_note: (i) => {
    const ids = existingIds(i.transaction_ids)
    const note = String(i.note ?? '').trim()
    db.inTransaction(() => {
      for (const id of ids) db.setTransactionFields(id, { notes: note })
    })
    return { result: { updated: ids.length }, action: `Noted on ${ids.length} transaction${ids.length === 1 ? '' : 's'}: "${note}"` }
  },

  list_recurring: () => {
    const hidden = vendorHider()
    const series = detectRecurring({ scope: 'all' })
    const ventures = series.some((s) => s.owner !== null) ? new Map(db.listBuckets().map((b) => [b.id, b.name])) : new Map<number, string>()
    return {
      result: series
        .filter((s) => !hidden(s.name))
        .map((s) => ({ key: s.key, name: s.name, kind: s.kind, cadence: s.cadence, amount: s.typicalCents / 100, last: date(s.lastDate), next: date(s.nextDate), status: s.status, times: s.count, confirmed: s.confirmed, dismissed: s.dismissed, price_changed: s.priceChanged ? { from: s.previousCents / 100, to: s.lastCents / 100 } : null, ...(s.owner !== null ? { venture: ventures.get(s.owner) ?? null } : {}) }))
    }
  },

  update_recurring: (i) => {
    const key = String(i.key)
    // Any series list_recurring shows, a venture's included.
    const s = detectRecurring({ scope: 'all' }).find((x) => x.key === key)
    if (!s) throw new Error(`No recurring series with key ${key}`)
    if (i.status !== undefined && i.status !== null && i.status !== 'confirmed' && i.status !== 'dismissed') throw new Error('status must be confirmed, dismissed, or null to take either back')
    if (typeof i.kind === 'string' && !(RECURRING_KINDS as readonly string[]).includes(i.kind)) throw new Error(`kind must be one of ${RECURRING_KINDS.join(', ')}`)
    db.setRecurringOverride(key, {
      ...(i.status === 'confirmed' || i.status === 'dismissed' || i.status === null ? { status: i.status } : {}),
      ...(typeof i.kind === 'string' ? { kind: i.kind as RecurringKind } : {}),
      ...(typeof i.name === 'string' ? { name: i.name } : {})
    })
    const what = [i.status === null ? `no longer ${s.dismissed ? 'dismissed' : s.confirmed ? 'confirmed' : 'marked'}` : i.status, typeof i.kind === 'string' ? `as ${i.kind}` : null, typeof i.name === 'string' ? `renamed "${i.name}"` : null].filter(Boolean).join(', ')
    return { result: { ok: true }, action: `${s.name}: ${what}` }
  },

  list_accounts: () => {
    const uses = listUses()
    const rules = db.listBucketRules().filter((r) => r.assetId !== null)
    return {
      result: db.listAccounts().map((a) => {
        const own = uses.filter((u) => u.assetId === a.id)
        const onIt = rules.filter((r) => r.assetId === a.id)
        return {
          id: a.id,
          name: a.name,
          institution: a.institution,
          source: a.source,
          type: a.assetType,
          balance: a.balanceCents === null ? null : a.balanceCents / 100,
          hidden: a.hidden,
          ...(a.cashRole ? { role: a.cashRole } : {}),
          transactions: a.txnCount,
          history_from: a.historyFrom,
          opened: a.openedDay,
          closed: a.closedDay,
          ...(a.costCents !== null ? { cost: a.costCents / 100 } : {}),
          ...(a.saleCostsCents !== null ? { sale_costs: a.saleCostsCents / 100 } : {}),
          ...(a.linkedAssetId ? { linked_asset_id: a.linkedAssetId } : {}),
          ...(a.details ? { details: a.details } : {}),
          ...(a.bucketId !== null ? { bucket: bucketLabel(a.bucketId) } : {}),
          ...(a.apr !== null ? { apr: a.apr } : {}),
          ...(a.promoApr !== null ? { promo_apr: a.promoApr, promo_ends: a.promoEnds } : {}),
          ...(a.minPaymentCents !== null ? { min_payment: a.minPaymentCents / 100 } : {}),
          ...(a.escrowCents !== null ? { escrow: a.escrowCents / 100 } : {}),
          ...(a.paymentKey ? { payment_key: a.paymentKey } : {}),
          ...(own.length ? { uses: own.map((u) => ({ owner: bucketLabel(u.bucketId), share_pct: u.shareBp / 100, from: u.fromDay, to: u.toDay, ...(u.basis ? { basis: u.basis } : {}) })) } : {}),
          ...(onIt.length ? { rules: onIt.map(ruleOut) } : {})
        }
      })
    }
  },

  update_account: (i) => {
    const a = account(i.account_id)
    const type = typeof i.type === 'string' ? assetType(i.type) : undefined
    db.updateAccount(a.id, {
      ...(typeof i.name === 'string' ? { name: i.name } : {}),
      ...(typeof i.hidden === 'boolean' ? { hidden: i.hidden } : {}),
      ...(type ? { assetType: type } : {}),
      ...(typeof i.opened === 'string' ? { openedDay: i.opened || null } : {}),
      ...(typeof i.closed === 'string' ? { closedDay: i.closed || null } : {}),
      ...(typeof i.cost === 'number' ? { costCents: Math.round(i.cost * 100) } : {}),
      ...(typeof i.sale_costs === 'number' || i.sale_costs === null ? { saleCostsCents: typeof i.sale_costs === 'number' ? Math.round(Math.abs(i.sale_costs) * 100) : null } : {}),
      ...(typeof i.details === 'string' ? { details: i.details } : {}),
      ...(typeof i.linked_asset_id === 'string' ? { linkedAssetId: i.linked_asset_id || null } : {}),
      ...(typeof i.balance === 'number' ? { balanceCents: Math.round(i.balance * 100) } : {}),
      ...(typeof i.bucket === 'string' ? { bucketId: bucketRef(i.bucket) } : {}),
      ...(typeof i.apr === 'number' || i.apr === null ? { apr: i.apr as number | null } : {}),
      ...(typeof i.promo_apr === 'number' || i.promo_apr === null ? { promoApr: i.promo_apr as number | null } : {}),
      ...(typeof i.promo_ends === 'string' ? { promoEnds: i.promo_ends || null } : {}),
      ...(typeof i.min_payment === 'number' ? { minPaymentCents: Math.round(i.min_payment * 100) } : {}),
      ...(typeof i.escrow === 'number' || i.escrow === null ? { escrowCents: typeof i.escrow === 'number' ? Math.round(Math.abs(i.escrow) * 100) : null } : {})
    })
    const what = [
      typeof i.name === 'string' ? `renamed "${i.name}"` : null,
      typeof i.hidden === 'boolean' ? (i.hidden ? 'hidden from totals' : 'shown in totals') : null,
      type ? `type ${typeLabel(type)}` : null,
      typeof i.opened === 'string' ? (i.opened ? `opened ${i.opened}` : 'no opened date') : null,
      typeof i.closed === 'string' ? (i.closed ? `closed ${i.closed}` : 'not closed') : null,
      typeof i.cost === 'number' ? `cost ${money(Math.round(i.cost * 100))}` : null,
      typeof i.sale_costs === 'number' ? `selling costs ${money(Math.round(Math.abs(i.sale_costs) * 100))}` : i.sale_costs === null ? 'no selling costs' : null,
      typeof i.details === 'string' ? 'details updated' : null,
      typeof i.linked_asset_id === 'string' ? (i.linked_asset_id ? `linked to ${account(i.linked_asset_id).name}` : 'unlinked') : null,
      typeof i.balance === 'number' ? `balance ${money(Math.round(i.balance * 100))}` : null,
      typeof i.bucket === 'string' ? `bucket ${bucketLabel(bucketRef(i.bucket))}` : null,
      typeof i.apr === 'number' ? `APR ${i.apr}%` : null,
      typeof i.promo_apr === 'number' ? `intro APR ${i.promo_apr}%${typeof i.promo_ends === 'string' && i.promo_ends ? ` until ${i.promo_ends}` : ''}` : null,
      typeof i.min_payment === 'number' ? `minimum ${money(Math.round(i.min_payment * 100))}` : null,
      typeof i.escrow === 'number' ? `escrow ${money(Math.round(Math.abs(i.escrow) * 100))}` : i.escrow === null ? 'no escrow' : null
    ]
      .filter(Boolean)
      .join(', ')
    return { result: { ok: true }, action: `${a.name}: ${what}` }
  },

  set_account_role: (i) => {
    const a = account(i.account_id)
    if (a.assetType !== 'cash') throw new Error(`${a.name} is ${typeLabel(a.assetType)}, not a cash account: only cash accounts are for spending or saving`)
    if (i.role !== 'spending' && i.role !== 'saving') throw new Error('role must be spending or saving')
    db.setCashRole(a.id, i.role)
    return { result: { ok: true }, action: `${a.name}: for ${i.role}` }
  },

  link_loan_payment: (i) => {
    const a = account(i.account_id)
    if (!['loan', 'mortgage', 'other_debt'].includes(a.assetType)) throw new Error(`${a.name} is ${typeLabel(a.assetType)}: only a loan, mortgage or other debt has payments to link`)
    let key: string | null
    if (typeof i.transaction_id === 'string' && i.transaction_id) {
      const t = db.getTransaction(i.transaction_id)
      if (!t) throw new Error(`No transaction ${i.transaction_id}`)
      if (t.amountCents >= 0) throw new Error(`${t.description} is money in: a payment is money out`)
      if (t.accountId === a.id) throw new Error(`${t.description} is on ${a.name} itself: link a payment from a bank account or card`)
      key = payeeKey({ merchant: t.merchant, descKey: db.descKey(t.description), cents: t.amountCents })
    } else if (typeof i.key === 'string') {
      const k = i.key.trim()
      if (k && !k.endsWith('|-')) throw new Error("key is a recurring series' key for money out, ending in |- (list_recurring)")
      // Spaces and capitals as a series' key has them, so a key typed by hand still matches.
      key = k ? payeeKey({ merchant: k.slice(0, -2), descKey: '', cents: -1 }) : null
    } else throw new Error('Give transaction_id (a payment of it) or key (a recurring series key; "" unlinks)')
    db.setPaymentKey(a.id, key)
    return { result: { ok: true, payment_key: key }, action: key ? `${a.name}: paid by ${key.slice(0, -2)}` : `${a.name}: no payment linked` }
  },

  mark_capital: (i) => {
    const ids = existingIds(i.transaction_ids)
    let asset: ReturnType<typeof account> | null = null
    if (typeof i.asset_id === 'string' && i.asset_id) {
      asset = account(i.asset_id)
      if (!['property', 'vehicle', 'other_asset', 'receivable', 'venture'].includes(asset.assetType)) throw new Error(`${asset.name} is ${typeLabel(asset.assetType)}: capital buys, sells or lends a house, a vehicle, another asset, a stake or money lent`)
      if (asset.bucketId !== null) throw new Error(`${asset.name} is ${bucketLabel(asset.bucketId)}'s: money for a venture's asset is the venture's`)
      const stakeOf = db.linkedStakes().get(asset.id)
      if (stakeOf !== undefined) throw new Error(`${asset.name} is ${bucketLabel(stakeOf)}'s stake (set_venture_value): money to or from it is money with the venture, never capital`)
      // Money with a venture that has an intent counts as its intent says; as capital too it would count twice.
      const intended = [...new Set(db.ventureMoneyRows(ids).map((r) => r.txn_id))]
      if (intended.length) {
        const t = db.getTransaction(intended[0])!
        throw new Error(`${t.description} on ${date(t.posted)} has an intent with ${bucketLabel(db.ventureMoneyRows([intended[0]])[0].venture_id)} (set_venture_money): remove it first (intent none)`)
      }
    } else if (i.asset_id !== null && i.asset_id !== '') throw new Error('asset_id is an asset account id from list_accounts, or null to unmark')
    const n = db.setCapitalAsset(ids, asset?.id ?? null)
    const what = `${n} ${n === 1 ? 'transaction' : 'transactions'}`
    return { result: { updated: n }, action: asset ? `${what} marked as capital for ${asset.name}` : `${what} no longer marked as capital` }
  },

  merge_accounts: (i) => {
    const from = account(i.from_account_id)
    const into = account(i.into_account_id)
    const name = typeof i.name === 'string' && i.name.trim() ? i.name.trim() : undefined
    const r = db.inTransaction(() => {
      const r = db.mergeAccounts(from.id, into.id, name)
      moveCreditAccount(from.id, into.id)
      return r
    })
    return {
      result: r,
      action: `Merged ${from.name} into ${into.name}${name && name !== into.name ? `, now ${name}` : ''}: ${r.matched} on both kept once, ${r.moved} moved over${r.dropped ? `, ${r.dropped} stale pending removed` : ''}`
    }
  },

  add_asset: (i) => {
    const type = assetType(i.type)
    const sign = isDebtType(type) ? -1 : 1
    const values = Array.isArray(i.values) ? (i.values as Array<{ date?: unknown; amount?: unknown }>) : []
    const id = db.addManualAccount({
      name: String(i.name ?? ''),
      assetType: type,
      institution: typeof i.institution === 'string' ? i.institution : null,
      openedDay: typeof i.opened === 'string' ? i.opened || null : null,
      closedDay: typeof i.closed === 'string' ? i.closed || null : null,
      costCents: typeof i.cost === 'number' ? Math.round(i.cost * 100) : null,
      details: typeof i.details === 'string' ? i.details : null,
      linkedAssetId: typeof i.linked_asset_id === 'string' && i.linked_asset_id ? account(i.linked_asset_id).id : null,
      points: values.map((v) => ({ day: String(v.date), cents: sign * Math.abs(Math.round(Number(v.amount) * 100)) }))
    })
    return { result: { account_id: id }, action: `Added ${typeLabel(type).toLowerCase().replace(/s$/, '')}: ${String(i.name).trim()}` }
  },

  record_balance: (i) => {
    const a = account(i.account_id)
    const amount = Number(i.amount)
    if (!Number.isFinite(amount)) throw new Error('amount must be a number')
    const cents = (isDebtType(a.assetType) ? -1 : 1) * Math.abs(Math.round(amount * 100))
    db.setBalancePoint(a.id, String(i.date), cents)
    return { result: { ok: true, stored_as: cents / 100 }, action: `${a.name}: ${money(cents)} on ${i.date}` }
  },

  balance_history: (i) => ({ result: db.listBalancePoints(account(i.account_id).id).map((p) => ({ date: p.day, balance: p.cents / 100, source: p.source })) }),

  delete_balance: (i) => {
    const a = account(i.account_id)
    db.deleteBalancePoint(a.id, String(i.date))
    return { result: { ok: true }, action: `${a.name}: removed the ${i.date} balance` }
  },

  add_calendar_event: (i) => {
    const amount = typeof i.amount === 'number' ? Math.round(i.amount * 100) : null
    const id = db.addCalendarEvent({ day: String(i.date), title: String(i.title ?? ''), notes: typeof i.notes === 'string' ? i.notes : null, amountCents: amount, createdBy: 'assistant', task: i.task === true, ...timeInput(i) })
    const e = calendarEvent(id)
    return { result: { event_id: id, ...eventResult(e) }, action: `On the calendar: ${e.title} · ${eventWhen(e)}` }
  },

  update_calendar_event: (i) => {
    const id = calendarEvent(Number(i.event_id)).id
    db.updateCalendarEvent(id, {
      ...(typeof i.date === 'string' ? { day: i.date } : {}),
      ...(typeof i.title === 'string' ? { title: i.title } : {}),
      ...(i.notes === null || typeof i.notes === 'string' ? { notes: i.notes } : {}),
      ...(i.amount === null || typeof i.amount === 'number' ? { amountCents: typeof i.amount === 'number' ? Math.round(i.amount * 100) : null } : {}),
      ...(typeof i.task === 'boolean' ? { task: i.task } : {}),
      ...(typeof i.done === 'boolean' ? { done: i.done } : {}),
      ...timeInput(i)
    })
    const e = calendarEvent(id)
    return { result: { event_id: id, date: e.day, title: e.title, ...eventResult(e) }, action: `Calendar: ${e.title} · ${eventWhen(e)}${e.doneAt !== null ? ' · done' : ''}` }
  },

  list_calendar: (i) => {
    const today = db.dayKey(db.now())
    const from = typeof i.from === 'string' ? i.from : today
    const to = typeof i.to === 'string' ? i.to : addDays(today, 60)
    const hidden = vendorHider()
    return {
      result: calendarItems(from, to).filter((c) => !hidden(c.title)).map((c) => ({
        date: c.day,
        ...(c.start ? { start_time: c.start, end_time: c.end } : {}),
        title: itemSummary(c),
        kind: c.kind,
        ...(c.task ? { task: true, done: c.done } : {}),
        ...(c.eventId !== null ? { event_id: c.eventId } : {}),
        ...(c.notes ? { notes: c.notes } : {})
      }))
    }
  },

  delete_calendar_event: (i) => {
    const e = calendarEvent(Number(i.event_id))
    db.deleteCalendarEvent(e.id)
    return { result: { ok: true }, action: `Removed from the calendar: ${e.title}` }
  },

  set_retirement: (i) => {
    // Years stay as given, so a part year is refused; a percent is kept in basis points.
    const fields: Array<[keyof RetirementSettings, string, boolean]> = [
      ['birthYear', 'birth_year', false],
      ['age', 'retire_age', false],
      ['realReturnBp', 'real_return_pct', true],
      ['inflationBp', 'inflation_pct', true]
    ]
    const patch: Partial<RetirementSettings> = {}
    for (const [field, input, percent] of fields) {
      const v = i[input]
      if (v === undefined) continue
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${input} is a number, or null to clear it`)
      patch[field] = v === null ? null : percent ? Math.round(v * 100) : v
    }
    if (!Object.keys(patch).length) throw new Error('Give birth_year, retire_age, real_return_pct or inflation_pct')
    const s = setRetirement(patch)
    const pct = (bp: number | null): string | null => (bp === null ? null : `${(bp / 100).toFixed(2)}%`)
    const what = [s.birthYear === null ? null : `born ${s.birthYear}`, s.age === null ? null : `retiring at ${s.age}`, s.realReturnBp === null ? null : `real return ${pct(s.realReturnBp)}`, s.inflationBp === null ? null : `inflation ${pct(s.inflationBp)}`].filter(Boolean)
    return {
      result: { ok: true, birth_year: s.birthYear, retire_age: s.age, real_return_pct: s.realReturnBp === null ? null : s.realReturnBp / 100, inflation_pct: s.inflationBp === null ? null : s.inflationBp / 100 },
      action: `Retirement: ${what.length ? what.join(', ') : 'nothing set'}`
    }
  },

  debt_plan: () => ({ result: debtPlanAnswer() }),

  set_debt_plan: (i) => {
    // Dollars are kept in cents; a set-aside or lump sum of null is none, a take-home of null the run rate.
    const patch: Partial<DebtPlanInputs> = {}
    if (i.strategy !== undefined) patch.strategy = i.strategy as Strategy
    if (i.left_out !== undefined) patch.leftOut = i.left_out as string[]
    const dollars = (input: string, v: unknown): number | null => {
      if (v === null) return null
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${input} is dollars of zero or more, or null`)
      return Math.round(v * 100)
    }
    if (i.take_home !== undefined) patch.takeHomeCents = dollars('take_home', i.take_home)
    if (i.set_aside !== undefined) patch.setAsideCents = dollars('set_aside', i.set_aside) ?? 0
    if (i.lump_sum !== undefined) patch.lumpCents = dollars('lump_sum', i.lump_sum) ?? 0
    if (!Object.keys(patch).length) throw new Error('Give strategy, left_out, take_home, set_aside or lump_sum')
    const p = setDebtPlan(patch)
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    const what = [
      p.strategy === 'snowball' ? 'smallest balance first' : 'highest rate first',
      p.leftOut.length ? `${p.leftOut.map((id) => names.get(id) ?? id).join(', ')} left out` : null,
      p.takeHomeCents === null ? null : `take-home ${money(p.takeHomeCents)}`,
      p.setAsideCents ? `${money(p.setAsideCents)} set aside` : null,
      p.lumpCents ? `${money(p.lumpCents)} lump sum` : null
    ].filter(Boolean)
    return { result: { ok: true, ...debtPlanAnswer() }, action: `Debt plan: ${what.join(', ')}` }
  },

  close_month: (i) => {
    const s = closeMonth(String(i.month ?? '').trim(), 'review')!
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    return {
      result: {
        ok: true,
        month: s.month,
        version: s.version,
        status: s.status,
        unexplained: s.unexplainedCents / 100,
        tolerance: s.toleranceCents / 100,
        items: s.leaks.map((x) => ({ kind: x.kind, amount: x.cents / 100, ...(x.accountId ? { account: names.get(x.accountId) ?? x.accountId } : {}), ...(x.fromDay ? { from: x.fromDay } : {}), ...(x.toDay ? { to: x.toDay } : {}), ...(x.txnIds ? { transaction_ids: x.txnIds } : {}) }))
      },
      action: `Closed ${s.month} (version ${s.version}): ${s.status === 'gap' ? `a gap, ${money(s.unexplainedCents)} unexplained` : 'it ties'}`
    }
  },

  accept_close_changes: (i) => {
    const months = Array.isArray(i.months) ? i.months.map((m) => String(m).trim()).filter(Boolean) : []
    const { kept: closed, left } = acceptCloseChanges(months)
    return {
      result: { ok: true, months: closed.map((s) => ({ month: s.month, version: s.version, status: s.status, unexplained: s.unexplainedCents / 100 })), left },
      action: `${closed.length === 1 ? `Kept ${closed[0].month}'s new figures (version ${closed[0].version})` : `Kept the new figures of ${closed.length} months (${closed[0].month} to ${closed[closed.length - 1].month})`}${left ? `; ${left} changed month${left === 1 ? '' : 's'} left` : ''}`
    }
  },

  list_investments: () => {
    const inv = can('investmentReturns') ? investments() : withoutReturns(investments())
    return {
      result: {
        accounts: inv.accounts.map((x) => ({
          id: x.account.id,
          name: x.account.name,
          institution: x.account.institution,
          tax: x.treatment,
          balance: x.valueCents / 100,
          change_30d: x.change30Cents === null ? null : x.change30Cents / 100,
          cost: x.costCents === null ? null : x.costCents / 100,
          cost_estimated: x.costEstimated,
          returns: returnsOut(x.returns),
          holdings: x.holdings.map((h) => ({
            symbol: h.symbol,
            name: h.description,
            shares: h.shares,
            price: h.priceCents === null ? null : h.priceCents / 100,
            value: h.valueCents / 100,
            cost: h.costCents === null ? null : h.costCents / 100,
            cost_estimated: h.costEstimated,
            gain_pct: h.costCents ? percent((h.valueCents - h.costCents) / h.costCents) : null,
            share_of_account_pct: x.valueCents > 0 ? percent(h.valueCents / x.valueCents) : null,
            since_buy: h.sinceBuy ? { from: h.sinceBuy.day, return_pct: percent(h.sinceBuy.r), annualized: h.sinceBuy.annualized } : null,
            inferred: h.inferred,
            as_of: db.dayKey(h.asOf)
          }))
        })),
        returns: Object.fromEntries((inv.returns ?? []).map((g) => [g.id, returnsOut(g.returns)]))
      }
    }
  },

  record_flows: (i) => {
    const a = account(i.account_id)
    const rows = (Array.isArray(i.flows) ? i.flows : []) as Array<{ date?: unknown; amount?: unknown; note?: unknown }>
    if (!rows.length && i.known_from === undefined) throw new Error('Give flows, known_from, or both')
    const ids = db.inTransaction(() => {
      const out = rows.map((r) => {
        const cents = Math.round(Number(r.amount) * 100)
        if (!Number.isFinite(cents) || cents === 0) throw new Error(`Bad amount ${String(r.amount)} on ${String(r.date)}`)
        return db.addRecordedFlow(a.id, String(r.date), cents, textField(r.note) ?? null)
      })
      if (i.known_from !== undefined) db.setFlowsKnownFrom(a.id, i.known_from === null ? null : String(i.known_from))
      return out
    })
    const net = rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0)
    const parts = [
      ...(rows.length ? [`${rows.length} flow${rows.length === 1 ? '' : 's'}, net ${money(net)}`] : []),
      ...(i.known_from !== undefined ? [i.known_from === null ? 'flows known from: cleared' : `flows known from ${String(i.known_from)}`] : [])
    ]
    return { result: { flow_ids: ids }, action: `${a.name}: ${parts.join('; ')}` }
  },

  list_flows: (i) => {
    const one = i.account_id === undefined ? undefined : account(i.account_id).id
    const known = db.flowsKnownFrom()
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    const ids = one ? [one] : [...new Set([...db.listRecordedFlows().map((f) => f.accountId), ...known.keys()])]
    return {
      result: ids.map((id) => ({
        account_id: id,
        name: names.get(id) ?? id,
        known_from: known.get(id) ?? null,
        flows: db.listRecordedFlows(id).map((f) => ({ flow_id: f.id, date: f.day, amount: f.cents / 100, note: f.note }))
      }))
    }
  },

  delete_flows: (i) => {
    const ids = (Array.isArray(i.flow_ids) ? i.flow_ids : []).map(Number)
    if (!ids.length) throw new Error('flow_ids must be a non-empty array')
    const gone = db.inTransaction(() => ids.map((id) => db.deleteRecordedFlow(id)).filter((f): f is db.RecordedFlow => f !== null))
    return { result: { deleted: gone.length }, action: `Removed ${gone.length} recorded flow${gone.length === 1 ? '' : 's'}` }
  },

  list_assets: () => ({
    result: db.listAssets().map((s) => ({
      id: s.account.id,
      name: s.account.name,
      type: s.account.assetType,
      purchased: s.account.openedDay,
      sold: s.sold ? s.account.closedDay : null,
      value: s.valueCents / 100,
      owed: s.owedCents / 100,
      equity: s.equityCents / 100,
      cost: s.account.costCents === null ? null : s.account.costCents / 100,
      ...(s.account.saleCostsCents !== null ? { selling_costs: s.account.saleCostsCents / 100 } : {}),
      gain: s.gainCents === null ? null : s.gainCents / 100,
      debts: s.debts.map((d) => ({ id: d.id, name: d.name, owed: d.owedCents / 100 })),
      details: s.account.details
    }))
  }),

  list_benefits: () => {
    const b = getBenefits()
    return {
      result: {
        employer: b.employer,
        plans: b.plans.map(planOut),
        free_care_last_done: b.done,
        hsa: {
          account: b.hsa.accountName,
          balance: dollars(b.hsa.balanceCents),
          hsa_start: b.hsa.startDay,
          contributed_this_year: dollars(b.hsa.contributedCents),
          by_dec_31: dollars(b.hsa.projectedCents),
          limit: dollars(b.hsa.limitCents),
          limit_estimated: b.hsa.limitProvisional || undefined,
          owed: b.hsa.owedCents / 100,
          reimbursed: b.hsa.reimbursedCents / 100,
          by_year: b.hsaYears.map((y) => ({ year: y.year, total: y.cents / 100, employer: dollars(y.employerCents), limit: dollars(y.limitCents), limit_estimated: y.limitProvisional || undefined, so_far: dollars(y.soFarCents), source: y.source }))
        },
        spent_on_care_this_year: Object.fromEntries(Object.entries(b.thisYear).map(([k, v]) => [k, v / 100])),
        need_receipts: b.hsa.needReceipts,
        care: b.care.slice(0, 150).map((c) => ({ id: c.id, date: c.day, amount: c.cents / 100, merchant: c.merchant, account: c.account, kind: c.kind, hsa: c.status, set_by_hand: c.hsa !== null, receipt: c.receipt ? (c.receiptFound ? c.receipt : `${c.receipt} (file missing)`) : null }))
      }
    }
  },

  set_benefit_plan: (i) => {
    const patch: Partial<Omit<BenefitPlan, 'name'>> = {}
    const put = <K extends keyof Omit<BenefitPlan, 'name'>>(k: K, v: Omit<BenefitPlan, 'name'>[K] | undefined): void => {
      if (v !== undefined) patch[k] = v
    }
    if (i.kind !== undefined) put('kind', String(i.kind) as BenefitKind)
    put('carrier', textField(i.carrier))
    put('network', textField(i.network))
    put('coverage', textField(i.coverage))
    put('perCheckCents', centsField(i.per_paycheck, 'per_paycheck'))
    put('employerPerCheckCents', centsField(i.employer_per_paycheck, 'employer_per_paycheck'))
    if (i.taxed !== undefined) put('taxed', i.taxed === 'pre' || i.taxed === 'post' ? i.taxed : null)
    put('deductibleCents', centsField(i.deductible, 'deductible'))
    put('outOfPocketMaxCents', centsField(i.out_of_pocket_max, 'out_of_pocket_max'))
    put('coinsurancePct', numberField(i.coinsurance, 'coinsurance'))
    put('oonDeductibleCents', centsField(i.oon_deductible, 'oon_deductible'))
    put('oonOutOfPocketMaxCents', centsField(i.oon_out_of_pocket_max, 'oon_out_of_pocket_max'))
    put('oonCoinsurancePct', numberField(i.oon_coinsurance, 'oon_coinsurance'))
    put('annualMaxCents', centsField(i.annual_max, 'annual_max'))
    put('metCents', centsField(i.met, 'met'))
    put('metAsOf', textField(i.met_as_of))
    if (Array.isArray(i.costs)) {
      put('costs', (i.costs as Input[]).map((c) => ({ what: String(c.what ?? '').trim(), inNetwork: String(c.in_network ?? '').trim(), outOfNetwork: textField(c.out_of_network) ?? null })).filter((c) => c.what && c.inNetwork))
    }
    if (Array.isArray(i.free)) {
      put('free', (i.free as Input[]).map((f) => ({ what: String(f.what ?? '').trim(), often: String(f.how_often ?? '').trim(), everyMonths: numberField(f.every_months, 'every_months') ?? null })).filter((f) => f.what))
    }
    put('phone', textField(i.phone))
    put('website', checkWebsite(i.website))
    put('notes', textField(i.notes))
    put('source', textField(i.source))
    const { plan, added } = setBenefitPlan(String(i.name ?? ''), patch)
    return { result: { ok: true, plan: planOut(plan) }, action: `Benefits: ${added ? 'added' : 'updated'} ${plan.name}` }
  },

  delete_benefit_plan: (i) => {
    deleteBenefitPlan(String(i.name ?? ''))
    return { result: { ok: true }, action: `Benefits: removed ${String(i.name)}` }
  },

  list_taxes: (i) => {
    const t = getTaxes()
    if (i.year !== undefined && i.year !== null) {
      const y = t.years.find((x) => x.year === Number(i.year))
      if (!y) throw new Error(`No tax year ${String(i.year)}; years on file: ${t.years.map((x) => x.year).join(', ') || 'none'}`)
      const own = t.money.filter((m) => taxReturnYear(m.day) === y.year)
      return {
        result: {
          ...taxYearOut(y),
          forms: y.forms.map((f) => ({ ...f, found: t.formFound[f.file] ?? false })),
          taxes_category: own.map((m) => ({ id: m.id, date: m.day, amount: m.cents / 100, description: m.description, account: m.account }))
        }
      }
    }
    return {
      result: {
        years: t.years.map((y) => ({ ...taxYearOut(y), forms: y.forms.map((f) => f.name) })),
        safe_harbor: t.safeHarbor && { year: t.safeHarbor.year, percent_of_last_year: t.safeHarbor.pct, from_year: t.safeHarbor.fromYear, payments_needed: dollars(t.safeHarbor.cents) },
        paychecks: t.paychecks.map((p) => ({
          employer: p.employer,
          paycheck_key: p.paycheckKey,
          paystub: p.asOf,
          gross: dollars(p.grossCents),
          federal: dollars(p.federalCents),
          social_security: dollars(p.socialSecurityCents),
          medicare: dollars(p.medicareCents),
          state: dollars(p.stateCents),
          checks_left_this_year: p.checksLeft
        })),
        missing_form_files: Object.entries(t.formFound).filter(([, found]) => !found).map(([file]) => file)
      }
    }
  },

  set_tax_year: (i) => {
    const year = Number(i.year)
    const patch: Partial<Omit<TaxYear, 'year'>> = {}
    const put = <K extends keyof Omit<TaxYear, 'year'>>(k: K, v: Omit<TaxYear, 'year'>[K] | undefined): void => {
      if (v !== undefined) patch[k] = v
    }
    if (i.status !== undefined) put('status', String(i.status) as TaxYear['status'])
    put('filingStatus', textField(i.filing_status))
    put('preparer', textField(i.preparer))
    put('filedDay', textField(i.filed_day))
    put('wagesCents', centsField(i.wages, 'wages'))
    put('incomeCents', centsField(i.total_income, 'total_income'))
    put('agiCents', centsField(i.agi, 'agi'))
    if (i.deduction !== undefined) put('deduction', i.deduction === null ? null : (String(i.deduction) as TaxYear['deduction']))
    put('deductionCents', centsField(i.deduction_amount, 'deduction_amount'))
    put('taxableCents', centsField(i.taxable_income, 'taxable_income'))
    put('taxCents', centsField(i.total_tax, 'total_tax'))
    put('withheldCents', centsField(i.withheld, 'withheld'))
    put('paymentsCents', centsField(i.total_payments, 'total_payments'))
    put('refundCents', centsField(i.refund, 'refund'))
    if (i.lines !== undefined) {
      if (!Array.isArray(i.lines)) throw new Error('lines is a list: [{ label, amount }]')
      put('lines', (i.lines as Input[]).map((l) => ({ label: String(l.label ?? '').trim(), cents: centsField(l.amount, `amount of ${String(l.label)}`) ?? 0 })).filter((l) => l.label))
    }
    if (i.forms !== undefined) {
      if (!Array.isArray(i.forms)) throw new Error('forms is a list: [{ name, file }]')
      put('forms', (i.forms as Input[]).map((f) => ({ name: String(f.name ?? '').trim(), file: String(f.file ?? '').trim() })).filter((f) => f.name && f.file).map((f) => ({ ...f, file: checkDocument(f.file) })))
    }
    if (i.issues !== undefined) {
      if (!Array.isArray(i.issues)) throw new Error('issues is a list of sentences')
      put('issues', (i.issues as unknown[]).map((x) => String(x).trim()).filter(Boolean))
    }
    put('asOf', textField(i.as_of))
    put('source', textField(i.source))
    const { taxYear, added } = setTaxYear(year, patch)
    return { result: { ok: true, year: taxYearOut(taxYear) }, action: `Taxes: ${added ? 'added' : 'updated'} ${taxYear.year}${taxYear.status === 'estimate' ? ' estimate' : ''}` }
  },

  delete_tax_year: (i) => {
    deleteTaxYear(Number(i.year))
    return { result: { ok: true }, action: `Taxes: removed ${String(i.year)}` }
  },

  list_credit: (i) => {
    const c = getCredit()
    const usd = (cents: number | null): number | null => (cents === null ? null : cents / 100)
    const report = (r: (typeof c.reports)[number]): Record<string, unknown> => ({ bureau: r.bureau, date: r.day, file: r.file, found: r.found, open: r.open, closed: r.closed, inquiries: r.inquiries, negatives: r.negatives, note: r.note })
    if (i.bureau !== undefined && i.bureau !== null) {
      const r = c.reports.find((x) => x.bureau.toLowerCase() === String(i.bureau).toLowerCase())
      if (!r) throw new Error(`No ${String(i.bureau)} report; reports on file: ${c.reports.map((x) => x.bureau).join(', ') || 'none'}`)
      return {
        result: {
          ...report(r),
          accounts: r.tradelines.map((t) => ({ creditor: t.creditor, last4: t.last4, kind: t.kind, opened: t.opened, closed: t.closed, status: t.status, limit: usd(t.limitCents), balance: usd(t.balanceCents), account_id: t.accountId, account: t.accountName, late: t.late }))
        }
      }
    }
    return {
      result: {
        latest: c.latest.map((l) => ({ ...l.score, previous: l.previous ? { day: l.previous.day, score: l.previous.score } : null })),
        scores: c.scores.slice(0, 40),
        ...(c.scores.length > 40 ? { older_scores: c.scores.length - 40 } : {}),
        utilization: { pct: c.utilization.pct === null ? null : Math.round(c.utilization.pct * 1000) / 10, balance: c.utilization.balanceCents / 100, limit: c.utilization.limitCents / 100, cards: c.utilization.cards.map((x) => ({ account_id: x.accountId, name: x.name, balance: x.balanceCents / 100, limit: usd(x.limitCents), pct: x.pct === null ? null : Math.round(x.pct * 1000) / 10, limit_source: x.limitSource })) },
        age: c.age,
        inquiries: c.inquiries,
        negatives: c.negatives,
        reports: c.reports.map((r) => ({ ...report(r), not_in_app: r.tradelines.filter((t) => !t.accountId).map((t) => `${t.creditor}${t.last4 ? ` ${t.last4}` : ''}`) }))
      }
    }
  },

  record_credit_score: (i) => {
    const s = recordScore({ day: i.day, score: i.score, bureau: i.bureau, model: i.model, source: i.source, note: i.note })
    return { result: { ok: true, id: s.id }, action: `Credit score: ${s.score}${[s.bureau, s.model, s.source].some(Boolean) ? ` (${[s.bureau, s.model, s.source].filter(Boolean).join(', ')})` : ''} on ${s.day}` }
  },

  delete_credit_score: (i) => {
    deleteScore(String(i.id))
    return { result: { ok: true }, action: 'Credit score removed' }
  },

  set_credit_report: (i) => {
    const file = typeof i.file === 'string' && i.file.trim() ? checkDocument(i.file.trim()) : null
    const r = setReport(file ? { ...i, file } : i)
    return { result: { ok: true, accounts: r.tradelines.length, inquiries: r.inquiries.length, negatives: r.negatives.length }, action: `Credit: ${r.bureau} report of ${r.day} (${r.tradelines.length} accounts, ${r.inquiries.length} inquiries)` }
  },

  set_credit_limit: (i) => {
    const a = account(i.account_id)
    if (i.limit === undefined) throw new Error('limit is required (null clears it)')
    const cents = i.limit === null ? null : centsField(i.limit, 'limit') ?? null
    setLimit(a.id, cents, textField(i.source) ?? null, textField(i.as_of) ?? null)
    return { result: { ok: true }, action: cents === null ? `${a.name}: credit limit cleared` : `${a.name}: credit limit ${money(cents)}` }
  },

  list_insurance: (i) => {
    const v = getInsurance()
    const usd = (cents: number | null): number | null => (cents === null ? null : cents / 100)
    const brief = (p: (typeof v.policies)[number]): Record<string, unknown> => ({ id: p.id, name: p.name, kind: p.kind, carrier: p.carrier, status: p.status, premium: usd(p.premiumCents), premium_period: p.premiumPeriod, yearly: usd(p.yearlyCents), paid_last_year: p.paidLastYearCents / 100, deductible: usd(p.deductibleCents), next_renewal: p.nextRenewal, end_day: p.endDay, match: p.match })
    if (typeof i.policy === 'string' && i.policy.trim()) {
      const want = i.policy.trim().toLowerCase()
      const p = v.policies.find((x) => x.id === i.policy) ?? v.policies.find((x) => x.name.toLowerCase() === want)
      if (!p) throw new Error(`No policy ${i.policy}; policies: ${v.policies.map((x) => x.name).join(', ') || 'none'}`)
      return {
        result: {
          ...brief(p),
          policy_number: p.policyNumber,
          covers: p.covers,
          coverage: p.coverage,
          start_day: p.startDay,
          renewal_day: p.renewalDay,
          term_months: p.termMonths,
          last_paid: p.lastPaid ? { day: p.lastPaid.day, amount: p.lastPaid.cents / 100 } : null,
          phone: p.phone,
          claims_phone: p.claimsPhone,
          website: p.website,
          files: p.files.map((f) => ({ ...f, found: v.fileFound[f.file] ?? false })),
          notes: p.notes,
          source: p.source
        }
      }
    }
    return {
      result: {
        policies: v.policies.map(brief),
        employer: { name: v.employer.name, plans: v.employer.plans.map((p) => ({ name: p.name, kind: p.kind, carrier: p.carrier, per_check: usd(p.perCheckCents), employer_per_check: usd(p.employerPerCheckCents), yearly: usd(p.yearlyCents) })) },
        totals: { yearly: v.totals.yearlyCents / 100, active: v.totals.active, next_renewal: v.totals.nextRenewal }
      }
    }
  },

  set_insurance_policy: (i) => {
    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(i, k)
    const patch: Record<string, unknown> = {}
    if (has('id')) patch.id = String(i.id)
    if (has('name')) patch.name = String(i.name ?? '')
    if (has('kind')) patch.kind = i.kind
    const texts: Array<[string, string]> = [['carrier', 'carrier'], ['policy_number', 'policyNumber'], ['covers', 'covers'], ['start_day', 'startDay'], ['renewal_day', 'renewalDay'], ['end_day', 'endDay'], ['match', 'match'], ['phone', 'phone'], ['claims_phone', 'claimsPhone'], ['website', 'website'], ['notes', 'notes'], ['source', 'source'], ['premium_period', 'premiumPeriod'], ['status', 'status']]
    for (const [k, to] of texts) if (has(k)) patch[to] = textField(i[k]) ?? null
    if (has('website')) patch.website = checkWebsite(i.website) ?? null
    if (has('premium')) patch.premiumCents = centsField(i.premium, 'premium') ?? null
    if (has('deductible')) patch.deductibleCents = centsField(i.deductible, 'deductible') ?? null
    if (has('term_months')) patch.termMonths = i.term_months === null ? null : Math.round(Number(i.term_months))
    if (has('coverage')) patch.coverage = (Array.isArray(i.coverage) ? i.coverage : []).map((c) => ({ what: String((c as Input).what ?? '').trim(), limit: String((c as Input).limit ?? '').trim() })).filter((c) => c.what)
    if (has('files')) patch.files = (Array.isArray(i.files) ? i.files : []).map((x) => ({ name: String((x as Input).name ?? '').trim(), file: String((x as Input).file ?? '').trim() })).filter((x) => x.name && x.file).map((x) => ({ ...x, file: checkDocument(x.file) }))
    const p = savePolicy(patch as Parameters<typeof savePolicy>[0])
    return { result: { ok: true, id: p.id }, action: `Insurance: ${p.name}${p.carrier ? ` (${p.carrier})` : ''} saved` }
  },

  delete_insurance_policy: (i) => {
    const p = deletePolicy(String(i.policy ?? ''))
    return { result: { ok: true }, action: `Insurance: removed ${p.name}` }
  },

  set_benefits: (i) => {
    const employer = textField(i.employer)
    const hsaStart = textField(i.hsa_start)
    setBenefitSettings({ ...(employer !== undefined ? { employer } : {}), ...(hsaStart !== undefined ? { hsaStart } : {}) })
    const what = [employer !== undefined ? `employer ${employer ?? 'cleared'}` : null, hsaStart !== undefined ? `HSA counts from ${hsaStart ?? 'the first HSA paycheck'}` : null].filter(Boolean)
    if (!what.length) throw new Error('Give employer and/or hsa_start')
    return { result: { ok: true }, action: `Benefits: ${what.join(', ')}` }
  },

  set_hsa_year: (i) => {
    const year = Number(i.year)
    const total = centsField(i.total, 'total')
    if (total === undefined) throw new Error('total is required (null removes the year)')
    setHsaYear(year, total, centsField(i.employer, 'employer') ?? null, textField(i.source) ?? null)
    return { result: { ok: true }, action: total === null ? `HSA: removed ${year}` : `HSA: ${year} contributions ${money(total)}` }
  },

  set_hsa: (i) => {
    const ids = existingIds(i.transaction_ids)
    const state = String(i.state ?? '')
    const label: Record<string, string> = { eligible: 'HSA-eligible', not: 'not HSA-eligible', reimbursed: 'paid back from the HSA', auto: 'automatic for the HSA' }
    if (!label[state]) throw new Error('state must be eligible, not, reimbursed or auto')
    const n = db.setHsa(ids, state === 'auto' ? null : (state as HsaState))
    return { result: { updated: n }, action: `${n} health cost${n === 1 ? '' : 's'} marked ${label[state]}` }
  },

  attach_receipt: (i) => {
    const ids = existingIds(i.transaction_ids)
    const doc = listDocuments().find((d) => d.name === String(i.document ?? ''))
    if (!doc) throw new Error(`No document named ${String(i.document)}. Use list_documents for names.`)
    checkDocument(doc.path)
    const n = linkReceipt(ids, doc.name)
    // Linked means gone through; a summary written with mark_document_read stays.
    if (!doc.read) db.markDocument(doc.name, doc.size, receiptSummary(doc.name))
    return { result: { linked: n }, action: `Receipt ${doc.name} linked to ${n} cost${n === 1 ? '' : 's'}` }
  },

  detach_receipt: (i) => {
    const n = linkReceipt(existingIds(i.transaction_ids), null)
    return { result: { unlinked: n }, action: `Receipt unlinked from ${n} cost${n === 1 ? '' : 's'}` }
  },

  remember: (i, ctx) => {
    const fact = String(i.fact ?? '')
    const id = db.addFact(fact, ctx.origin)
    return { result: { fact_id: id }, action: `Remembered: ${clip(fact.trim())}` }
  },

  forget: (i) => {
    const id = Number(i.fact_id)
    const f = db.listFacts().find((x) => x.id === id)
    if (!f) throw new Error(`No fact ${id}`)
    db.deleteFact(id)
    return { result: { ok: true }, action: `Forgot: ${clip(f.text)}` }
  },

  resolve_issue: (i) => {
    const key = String(i.issue_key ?? '').trim()
    const issue = openIssues().find((x) => x.key === key)
    if (!issue) throw new Error(`No open issue with key ${key}; use a key from get_open_issues`)
    const note = typeof i.note === 'string' && i.note.trim() ? clip(i.note.trim(), 500) : null
    db.resolveIssue(key, note, clip(issue.summary, 300))
    return { result: { ok: true, resolved: issue.summary }, action: `Skipped: ${clip(issue.summary)}${note ? ` (${clip(note, 80)})` : ''}` }
  },

  add_question: (i) => {
    const question = String(i.question ?? '')
    const id = db.addQuestion(question)
    return { result: { question_id: id, issue_key: `question:${id}` }, action: `Question saved: ${clip(question.trim())}` }
  },

  answer_question: (i) => {
    const id = Number(i.question_id)
    const answer = String(i.answer ?? '')
    db.answerQuestion(id, answer)
    return { result: { ok: true }, action: `Answered: ${clip(answer.trim())}` }
  },

  split_transaction: (i) => {
    const t = db.getTransaction(String(i.transaction_id ?? ''))
    if (!t) throw new Error(`No transaction ${String(i.transaction_id)}`)
    if (!Array.isArray(i.parts)) throw new Error('parts is a list: [{ amount_cents, category, bucket }]')
    const given = i.parts as Array<Record<string, unknown>>
    // Amounts given without the minus of money out are read as money out.
    const sign = t.amountCents < 0 && given.every((p) => Number(p.amount_cents) > 0) ? -1 : 1
    const parts = given.map((p) => ({
      amountCents: Number(p.amount_cents) * sign,
      categoryId: /^uncategorized$/i.test(String(p.category ?? '').trim()) ? null : categoryId(String(p.category ?? '')),
      bucketId: p.bucket === undefined || p.bucket === null || p.bucket === '' ? undefined : bucketRef(p.bucket),
      oneTime: p.one_time === true,
      note: typeof p.note === 'string' ? p.note : null
    }))
    // Putting a part in another bucket is a ventures write, like set_bucket; keeping the ones it has isn't.
    if (db.splitMovesVentures(t, parts)) requireFeature('ventures')
    const saved = db.splitTransaction(t.id, parts)
    return { result: { parts: saved.map(partOut) }, action: `Split ${t.merchant ?? t.description} ${money(t.amountCents)}: ${saved.map((s) => `${categoryName(s.categoryId)} ${money(s.amountCents)}`).join(', ')}` }
  },

  unsplit_transaction: (i) => {
    const t = db.getTransaction(String(i.transaction_id ?? ''))
    if (!t) throw new Error(`No transaction ${String(i.transaction_id)}`)
    if (!t.splits.length) throw new Error('That transaction isn\'t split')
    db.unsplitTransaction(t.id)
    return { result: { ok: true }, action: `Unsplit ${t.merchant ?? t.description} ${money(t.amountCents)}` }
  },

  add_tags: (i) => {
    const ids = existingIds(i.transaction_ids)
    const tags = tagList(i.tags)
    const added = db.addTags(ids, tags)
    return { result: { added }, action: `Tagged ${ids.length} transaction${ids.length === 1 ? '' : 's'} ${tags.join(', ')}` }
  },

  remove_tags: (i) => {
    const ids = existingIds(i.transaction_ids)
    const tags = tagList(i.tags)
    const removed = db.removeTags(ids, tags)
    return { result: { removed }, action: `Untagged ${ids.length} transaction${ids.length === 1 ? '' : 's'}: ${tags.join(', ')}` }
  },

  list_goals: (i) => {
    const out = (g: GoalView, full: boolean): Record<string, unknown> => ({
      id: g.id,
      name: g.name,
      target: g.targetCents / 100,
      target_day: g.targetDay,
      funding: g.funding,
      accounts: g.accounts.map((a) => ({ id: a.id, name: a.name, balance: dollars(a.balanceCents) })),
      ...(g.startDay ? { start: dollars(g.startCents), start_day: g.startDay } : {}),
      saved: g.savedCents / 100,
      remaining: g.remainingCents / 100,
      pct: Math.round(g.pct * 1000) / 10,
      months_left: g.monthsLeft,
      monthly_needed: dollars(g.monthlyNeededCents),
      pace: g.paceCents / 100,
      status: g.status,
      archived: g.archivedAt !== null,
      contributions: full ? g.contributions.slice(0, 100).map((c) => ({ id: c.id, day: c.day, amount: c.cents / 100, note: c.note })) : g.contributions.length
    })
    const views = goalViews()
    if (typeof i.goal === 'string' || typeof i.goal === 'number') {
      const g = findGoal(i.goal)
      if (!g) throw new Error(`No goal ${String(i.goal)}; goals: ${views.map((x) => x.name).join(', ') || 'none'}`)
      return { result: out(views.find((v) => v.id === g.id)!, true) }
    }
    return { result: { goals: views.map((g) => out(g, false)) } }
  },

  create_goal: (i) => {
    const ids = Array.isArray(i.account_ids) ? i.account_ids.map(String) : []
    const target = centsField(i.target, 'target')
    if (target === undefined || target === null) throw new Error('target is required (dollars)')
    const targetDay = textField(i.target_day) ?? null
    const logged = Array.isArray(i.contributions) ? (i.contributions as Input[]) : []
    if (ids.length && logged.length) throw new Error('A goal counts its accounts or a log of contributions, not both')
    const id = db.inTransaction(() => {
      const made = saveGoal({ name: String(i.name ?? ''), targetCents: target, targetDay, funding: ids.length ? 'accounts' : 'manual', accountIds: ids, fromNow: i.from_now === true })
      for (const c of logged) addContribution(made, { day: c.day, cents: centsField(c.amount, 'amount'), note: c.note })
      return made
    })
    const g = findGoal(id)!
    return { result: { ok: true, goal_id: id }, action: `Goal: ${g.name} · ${money(g.targetCents)}${g.targetDay ? ` by ${g.targetDay}` : ''}` }
  },

  update_goal: (i) => {
    const g = findGoal(i.goal)
    if (!g) throw new Error(`No goal ${String(i.goal)}; goals: ${listGoals().map((x) => x.name).join(', ') || 'none'}`)
    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(i, k)
    const what: string[] = []
    db.inTransaction(() => {
      if (['name', 'target', 'target_day', 'account_ids', 'from_now'].some(has)) {
        const ids = has('account_ids') ? (Array.isArray(i.account_ids) ? i.account_ids.map(String) : []) : g.accountIds
        const target = has('target') ? centsField(i.target, 'target') : g.targetCents
        if (target === undefined || target === null) throw new Error('target must be an amount (dollars)')
        saveGoal({
          id: g.id,
          name: has('name') ? String(i.name ?? '') : g.name,
          targetCents: target,
          targetDay: has('target_day') ? (textField(i.target_day) ?? null) : g.targetDay,
          funding: has('account_ids') ? (ids.length ? 'accounts' : 'manual') : g.funding,
          accountIds: ids,
          fromNow: has('from_now') ? i.from_now === true : undefined
        })
        what.push('updated')
      }
      if (i.add_contribution && typeof i.add_contribution === 'object') {
        const c = i.add_contribution as Input
        const cents = centsField(c.amount, 'amount')
        addContribution(g.id, { day: c.day, cents, note: c.note })
        what.push(`${money(cents ?? 0)} on ${String(c.day)}`)
      }
      if (typeof i.archived === 'boolean') {
        archiveGoal(g.id, i.archived)
        what.push(i.archived ? 'archived' : 'back from the archive')
      }
    })
    if (!what.length) throw new Error('Nothing to change: give name, target, target_day, account_ids, from_now, add_contribution or archived')
    return { result: { ok: true, goal_id: g.id }, action: `Goal: ${findGoal(g.id)?.name ?? g.name} ${what.join(', ')}` }
  },

  delete_goal: (i) => {
    const g = findGoal(i.goal)
    if (!g) throw new Error(`No goal ${String(i.goal)}`)
    deleteGoal(g.id)
    return { result: { ok: true }, action: `Goal removed: ${g.name}` }
  }
}

const categoryName = (id: number | null): string => (id === null ? 'Uncategorized' : (db.get<{ name: string }>('SELECT name FROM categories WHERE id = ?', id)?.name ?? 'Uncategorized'))
const bucketName = (id: number | null): string => (id === null ? 'Personal' : (db.get<{ name: string }>('SELECT name FROM buckets WHERE id = ?', id)?.name ?? 'Personal'))

/** A lever as the assistant reads it: dollars a month, its rate in percent, and how far its stage's rate would move, in points. */
const leverOut = (l: Lever): Record<string, unknown> => ({
  stage: l.stage,
  kind: l.kind,
  name: l.name,
  monthly: l.monthlyCents / 100,
  ...(l.aprBp !== null ? { apr_pct: l.aprBp / 100 } : {}),
  ...(l.ratePts !== null ? { rate_pts: l.ratePts } : {}),
  ...(l.estimated ? { estimated: true } : {})
})

/** The levers as the assistant reads them, leaving out one named for a hidden vendor (a series whose price went up): its money stays in every row. */
const leversOut = (levers: Lever[], hidden = vendorHider()): Array<Record<string, unknown>> => levers.filter((l) => !hidden(l.name)).map(leverOut)

/** A split part as the assistant reads it. */
const partOut = (s: TxnSplit): Record<string, unknown> => ({ amount: s.amountCents / 100, category: categoryName(s.categoryId), bucket: bucketName(s.bucketId), ...(s.oneTime ? { one_time: true } : {}), ...(s.note ? { note: s.note } : {}) })

/** The tags a call names, cleaned, each once; at least one. */
function tagList(v: unknown): string[] {
  const tags = db.tagLabels((Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map(String))
  if (!tags.length) throw new Error('tags must name at least one tag')
  return tags
}

// Read-only extras for the file bridge (not offered to the in-app assistant,
// which is told the saved facts unasked and doesn't need Home's views).
const BRIDGE_RISK: Record<string, ToolRisk> = {
  post_to_review: 'write',
  record_balances: 'write',
  rename_transactions: 'destructive',
  list_facts: 'read',
  list_categories: 'read',
  list_rules: 'read',
  month_summary: 'read',
  delete_category: 'destructive',
  net_worth: 'read'
}
const BRIDGE_ONLY: Record<string, Impl> = {
  // Shows a message in the in-app Review chat, as the assistant (the bridge
  // adds it to the transcript in request order).
  post_to_review: (i) => {
    if (!String(i.text ?? '').trim()) throw new Error('text is required')
    return { result: { ok: true } }
  },
  // Many dated balances for one account at once (a folder of statements),
  // with one line in the chat instead of one per statement. Signed dollars:
  // negative = owed.
  record_balances: (i) => {
    const a = account(i.account_id)
    const rows = (Array.isArray(i.balances) ? i.balances : []) as Array<{ date?: unknown; balance?: unknown }>
    if (!rows.length) throw new Error('balances must be a non-empty array of {date, balance}')
    db.inTransaction(() => {
      for (const r of rows) {
        const cents = Math.round(Number(r.balance) * 100)
        if (!Number.isFinite(cents)) throw new Error(`Bad balance ${String(r.balance)} on ${String(r.date)}`)
        db.setBalancePoint(a.id, String(r.date), cents)
      }
    })
    const days = rows.map((r) => String(r.date)).sort()
    return { result: { recorded: rows.length }, action: `${a.name}: ${rows.length} statement balances, ${days[0]} to ${days[days.length - 1]}` }
  },
  // Rewrites the description of imported or manual transactions (a bank sync
  // puts its own back on synced ones). Category, merchant and note stay.
  rename_transactions: (i) => {
    const ids = existingIds(i.transaction_ids)
    const description = String(i.description ?? '').trim()
    db.inTransaction(() => {
      for (const id of ids) db.setTransactionFields(id, { description })
    })
    return { result: { updated: ids.length }, action: `Renamed ${ids.length} transaction${ids.length === 1 ? '' : 's'} to "${description}"` }
  },
  list_facts: () => ({ result: db.listFacts() }),
  list_categories: () => ({ result: db.listCategories() }),
  list_rules: () => ({ result: db.listRules() }),
  // getSummary's month (summary.ts); with Personal in it, the levers in force at the month's end too.
  month_summary: (i) => {
    const buckets = Array.isArray(i.buckets) ? (i.buckets as number[]) : undefined
    // The summary first, so a month that's no month is refused as one.
    const summary = getSummary(String(i.month), buckets)
    // Personal is in it unless it names ventures alone, as getSummary reads the selection.
    const ids = (buckets ?? []).filter((n) => Number.isInteger(n) && n >= 0)
    const personal = ids.includes(0) || !ids.some((n) => n > 0)
    const levers = personal ? leversOut(getWaterfall({ from: summary.month, to: summary.month }).levers) : []
    return { result: { ...summary, levers } }
  },
  // Removes a category; its transactions become uncategorized.
  delete_category: (i) => {
    const id = categoryId(String(i.category))
    const n = db.get<{ n: number }>(`SELECT COUNT(DISTINCT t.id) AS n FROM ${db.TXN_LINES} t WHERE t.category_id = ?`, id)?.n ?? 0
    if (n > 0 && i.even_if_used !== true) throw new Error(`${n} transactions still use ${String(i.category)}; move them first or pass even_if_used`)
    db.deleteCategory(id)
    return { result: { ok: true }, action: `Deleted category ${String(i.category)}` }
  },
  net_worth: () => {
    const { landed: _landed, ahead: _ahead, ...s } = getNetWorthSeries()
    // Weekly points to today keep the payload small; the days a transfer was between accounts, and the days ahead, are the chart's alone.
    return { result: { ...s, points: s.points.filter((_, idx) => idx % 7 === 0 || idx === s.points.length - 1) } }
  }
}

/** Who runs a tool, as the journal records it: besides the in-app callers, a paired phone (acting as the user) and an app connected over MCP by a member of the books ("mcp:<member>", an assistant, mcp.ts). */
export type ToolOrigin = FactOrigin | 'phone' | `mcp:${string}`

// The turn a change belongs to (a review turn, a bridge request, a connected app's grant), for the journal: each ledger's own (ledgerState.ts).
const turn = ledgerState(() => ({ id: null as string | null }))

export function setTurnId(id: string | null): void {
  turn().id = id
}

/** Runs a tool and, when it's one the journal covers, records what it replaced so the Review chat can undo it. */
function journaled(name: string, input: Input, origin: ToolOrigin, run: () => ToolResult): ToolResult {
  if (!isJournaled(name)) return run()
  let before: unknown
  try {
    before = snapshotBefore(name, input)
  } catch {
    // A malformed call: let the tool say what's wrong.
    return run()
  }
  const r = run()
  if (r.pending !== undefined) return r
  try {
    r.changeId = db.addChange({ turnId: turn().id, origin, tool: name, input, before, after: snapshotAfter(name, input, r.result, before) })
  } catch (err) {
    console.error(`[journal] an entry could not be written${errorTag(err)}`)
  }
  return r
}

/**
 * Runs one tool by name, as the file bridge or the user approving a queued
 * call: everything the in-app assistant can do, plus the bridge-only tools.
 * Nothing waits for approval here; the bridge confirms each destructive op itself.
 */
export function runTool(name: string, input: Record<string, unknown>, origin: ToolOrigin = 'bridge'): ToolResult {
  const impl = TOOL_IMPL[name] ?? DOC_IMPL[name] ?? BRIDGE_ONLY[name]
  if (!impl) throw new Error(`Unknown tool ${name}. Available: ${[...Object.keys(TOOL_IMPL), ...Object.keys(DOC_IMPL), ...Object.keys(BRIDGE_ONLY)].join(', ')}`)
  requirePlanFor(name)
  // A paired phone acts as the user and a connected app as an assistant; the journal records where it came from.
  return journaled(name, input, origin, () => impl(input, { origin: origin === 'phone' ? 'user' : origin.startsWith('mcp:') ? 'assistant' : (origin as FactOrigin) }))
}

/** The Plus feature a tool writes to (reading what's there is free); a call on a plan without it fails with "Plus: <feature>". */
const FEATURE_OF_TOOL: Record<string, FeatureId> = {
  create_bucket: 'ventures',
  update_bucket: 'ventures',
  set_venture_share: 'ventures',
  set_venture_value: 'ventures',
  set_venture_money: 'ventures',
  set_bucket: 'ventures',
  add_bucket_rule: 'ventures',
  delete_bucket_rule: 'ventures',
  set_tax_year: 'taxes',
  delete_tax_year: 'taxes',
  set_benefit_plan: 'benefits',
  delete_benefit_plan: 'benefits',
  set_benefits: 'benefits',
  set_hsa_year: 'benefits',
  set_hsa: 'benefits',
  set_paycheck_withholding: 'benefits',
  delete_paycheck_withholding: 'benefits',
  attach_receipt: 'benefits',
  detach_receipt: 'benefits',
  set_insurance_policy: 'insurance',
  delete_insurance_policy: 'insurance',
  set_credit_report: 'credit',
  read_document: 'documents',
  mark_document_read: 'documents'
}

export const toolFeature = (name: string): FeatureId | undefined => FEATURE_OF_TOOL[name]

function requirePlanFor(name: string): void {
  const f = FEATURE_OF_TOOL[name]
  if (f) requireFeature(f)
}

/**
 * What one call does, given its input: update_account is destructive only
 * when it hides or closes; hide_vendor only when it hides; a new rule only
 * when it would rewrite more than RULE_LIMIT transactions at once.
 */
export function toolRisk(name: string, input: Record<string, unknown>): ToolRisk {
  if (name === 'update_account') return input.hidden === true || (typeof input.closed === 'string' && input.closed.trim() !== '') ? 'destructive' : 'write'
  if (name === 'hide_vendor') return input.hidden === false ? 'write' : 'destructive'
  if (name === 'create_rule') return ruleMatchCount(input) > RULE_LIMIT ? 'destructive' : 'write'
  if (name === 'add_bucket_rule') return bucketRuleMatchCount(input) > RULE_LIMIT ? 'destructive' : 'write'
  return [...TOOLS, ...DOC_TOOLS].find((t) => t.name === name)?.risk ?? BRIDGE_RISK[name] ?? 'write'
}

/** The tool definitions as the API takes them (the risk label is the app's own). */
export const apiTools = (defs: ToolDef[]): Anthropic.Beta.BetaTool[] => defs.map(({ risk: _risk, ...t }) => t)

/** A call in one line for the approval card: the tool, then each argument. */
export function describeCall(name: string, input: Record<string, unknown>): string {
  const value = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v))
  const args = Object.entries(input).map(([k, v]) => `${k} ${clip(value(v), 60)}`)
  return clip(args.length ? `${name} · ${args.join(', ')}` : name, 200)
}

/**
 * Tools for the documents folder. The app's own loop (API-key and hosted
 * mode) reads files with read_document; Claude Code reads them with its Read
 * tool, so its tool server leaves read_document out.
 */
export const DOC_TOOLS: ToolDef[] = [
  {
    name: 'list_documents',
    risk: 'read',
    description: 'Files in the user\'s documents folder (statements, paystubs, closing papers, tax forms, files attached in the chat): the name to pass to read_document (in Claude Code, the full path for the Read tool), and whether you\'ve already gone through each one.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'read_document',
    risk: 'read',
    description: 'Read a document by its name from list_documents. A PDF or an image is shown to you as it is; a text file (txt, md, csv, eml, html) comes in pages of about 12,000 characters, so ask for page 2 and on when there are more. Word, Excel and HEIC files can\'t be read: ask for a PDF or an image of them.',
    input_schema: { type: 'object', properties: { name: str, page: { type: 'integer', description: 'text files only; 1 unless given' } }, required: ['name'] }
  },
  {
    name: 'mark_document_read',
    risk: 'write',
    description: 'Record that you\'ve gone through a document and entered what it shows, with a one-line summary (what it is, period, key figures). It then stops showing as new.',
    input_schema: { type: 'object', properties: { name: { ...str, description: 'the name from list_documents' }, summary: str }, required: ['name', 'summary'] }
  }
]

const DOC_IMPL: Record<string, Impl> = {
  // Claude Code's Read tool needs full paths; the app's loop reads by name, so the paths (with the user's name in them) stay on the PC.
  list_documents: () => {
    const docs = listDocuments()
    return getProvider() === 'claude-code' ? { result: { folder: docsDir(), documents: docs } } : { result: { documents: docs.map(({ path: _path, ...d }) => d) } }
  },
  read_document: (i) => {
    // A spent AI allowance stops here, before the file is opened.
    checkAllowance('documents')
    return readDocument(String(i.name ?? ''), Number(i.page) || 1)
  },
  mark_document_read: (i) => {
    const d = listDocuments().find((x) => x.name === String(i.name))
    if (!d) throw new Error(`No document named ${String(i.name)}`)
    const summary = String(i.summary ?? '').trim()
    db.markDocument(d.name, d.size, summary || null)
    return { result: { ok: true }, action: `Read ${d.name}${summary ? `: ${clip(summary)}` : ''}` }
  }
}

/**
 * Runs one of the tools offered to the assistant (TOOLS and DOC_TOOLS). A
 * destructive call is queued for the user instead of run; the result says so,
 * and the Review chat shows it with Approve and Discard.
 */
export function runAssistantTool(name: string, input: Record<string, unknown>): ToolResult {
  const impl = TOOL_IMPL[name] ?? DOC_IMPL[name]
  if (!impl) throw new Error(`Unknown tool ${name}`)
  requirePlanFor(name)
  if (toolRisk(name, input) === 'destructive') {
    const id = db.addPendingAction(name, input)
    const matches = name === 'create_rule' ? ruleMatchCount(input) : name === 'add_bucket_rule' ? bucketRuleMatchCount(input) : undefined
    return {
      result: { queued_for_approval: true, pending_id: id, ...(matches !== undefined ? { would_change: matches } : {}), note: 'Not done yet: this change needs the user\'s approval. It is shown in the chat with Approve and Discard buttons; carry on and don\'t ask for it again.' },
      pending: id
    }
  }
  return journaled(name, input, 'assistant', () => impl(input, { origin: 'assistant' }))
}
