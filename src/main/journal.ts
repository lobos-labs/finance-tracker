import * as db from './db'
import { benefitSettings, deleteBenefitPlan, findBenefitPlan, findHsaYear, setBenefitPlan, setBenefitSettings, setHsaYear } from './benefits'
import { accountRefs, deleteScore, findLimit, findReport, findScore, restoreAccountRefs, restoreReport, restoreScore, scoreToReplace, setLimit, type AccountRefs } from './credit'
import { deletePolicy, findPolicy, restorePolicy } from './insurance'
import { deleteGoal, getGoal, goalRecord, restoreGoal, type GoalRecord } from './goals'
import { restoreTargetRecord, targetRecord, type TargetRecord } from './budget'
import { linkReceipt, receiptFields } from './receipts'
import { deleteTaxYear, findTaxYear, setTaxYear } from './taxes'
import { listTrips, removeTrip, restoreTrip } from './trips'
import { hiddenVendors, setHiddenVendors } from './privacy'
import { lowDays, setLowDays } from './overdraw'
import { renewalMark, renewalSeriesKey, setRenewalMark, type RenewalMark } from './renewals'
import { RETIRE_KEYS } from './waterfall'
import { DEBT_PLAN_KEY } from './debts'
import { changedMonths, checkedStates, deleteClose, restoreCheckedStates } from './snapshots'
import { asPayrollKey } from '../shared/payroll'
import { CREDIT_BUREAUS, type AccountPatch, type AssetUse, type CashRole, type BenefitPlan, type BucketRule, type CalendarEvent, type CreditReport, type CreditScore, type Fact, type InsurancePolicy, type Paystub, type TaxYear, type Trip, type TxnSplit, type VentureShare } from '../shared/types'

// The changes journal: for each tool that writes, what to keep before the
// call (the rows it will replace) and how to put that back. tools.ts records
// an entry for every journaled call; the Review chat's Undo restores it.
// Nothing here runs a tool: a tool's own checks happen in tools.ts.

type Input = Record<string, unknown>

interface Journaled {
  /** the state the call replaces, taken before it runs; undefined when nothing needs keeping (a plain insert) */
  before?: (i: Input) => unknown
  /** what the call left, from its result (ids it made) */
  after?: (i: Input, result: unknown, before: unknown) => unknown
  /** puts `before` back, removing what `after` names */
  undo: (before: unknown, after: unknown, i: Input) => void
}

const ids = (i: Input, key = 'transaction_ids'): string[] => (Array.isArray(i[key]) ? i[key].map(String) : [])
const str = (v: unknown): string => String(v ?? '').trim()
const today = (): string => db.dayKey(db.now())

/** One column's value for each of a set of transactions, as rows of {id, <column>}. */
function column<T>(column: string, list: string[]): Array<Record<string, T | string>> {
  return list.flatMap((id) => {
    const r = db.get<Record<string, T>>(`SELECT ${column} FROM transactions WHERE id = ?`, id)
    return r ? [{ ...r, id }] : []
  })
}

const event = (id: number): CalendarEvent | null => db.listCalendarEvents('0000-01-01').find((e) => e.id === id) ?? null
const override = (key: string): db.RecurringOverride | null => db.recurringOverrides().get(key) ?? null
const trip = (idOrName: string): Trip | null => listTrips().find((t) => t.id === idOrName) ?? listTrips().find((t) => t.name.toLowerCase() === idOrName.toLowerCase()) ?? null
const account = (id: string): ReturnType<typeof db.listAccounts>[number] | null => db.listAccounts().find((a) => a.id === id) ?? null

/** The paystub a call writes over: its payroll's stub for that pay day and kind, as it is; null when there's none. */
const stubAt = (key: unknown, day: unknown, kind: unknown = 'regular'): Paystub | null => {
  const want = str(kind) || 'regular'
  return db.listPaystubs(asPayrollKey(str(key)), str(day), str(day)).find((s) => s.kind === want) ?? null
}

/** Puts back the stub a call wrote over, under its own id, or removes the one it added. */
function putStubBack(before: Paystub | null, after: { id: number }): void {
  if (before) db.writePaystub(before)
  else db.deletePaystub(after.id)
}

/** The account fields update_account can change, as they are. */
function accountFields(id: string): Record<string, unknown> | null {
  const a = account(id)
  if (!a) return null
  return {
    name: a.name,
    hidden: a.hidden,
    assetType: a.assetTypeSet ? a.assetType : null,
    openedDay: a.openedDay,
    closedDay: a.closedDay,
    costCents: a.costCents,
    saleCostsCents: a.saleCostsCents,
    linkedAssetId: a.linkedAssetId,
    details: a.details,
    bucketId: a.bucketId,
    apr: a.apr,
    promoApr: a.promoApr,
    promoEnds: a.promoEnds,
    minPaymentCents: a.minPaymentCents,
    escrowCents: a.escrowCents
  }
}

/** A call that writes only the budget's preferences (budget.ts budget.prefs): they're kept whole, and put back whole. */
function budgetPrefs(): Journaled {
  return {
    before: () => db.getSetting('budget.prefs'),
    undo: (before) => db.setSetting('budget.prefs', before as string | null)
  }
}

export const JOURNAL: Record<string, Journaled> = {
  categorize: {
    before: (i) => {
      const list = ids(i)
      // The merchant the tool will use: the call's own, else the first named transaction's that is there and not split.
      const first = list.map((id) => db.getTransaction(id)).find((t) => t && !t.splits.length)
      const merchant = typeof i.merchant === 'string' && i.merchant.trim() ? i.merchant.trim() : (first?.merchant ?? null)
      const cat = i.remember === true && !/^uncategorized$/i.test(str(i.category)) ? db.listCategories().find((c) => c.name.toLowerCase() === str(i.category).toLowerCase()) : undefined
      // The rows the new rule will move besides the named ones: undo puts them back too.
      const ruled = cat && merchant ? db.ruleMatches('merchant', merchant, cat.id).filter((id) => !list.includes(id)) : []
      return { rows: db.categoryFields([...list, ...ruled]), ruleMerchant: cat && merchant ? merchant : null, rule: cat && merchant ? db.ruleFor('merchant', merchant) : null }
    },
    undo: (before) => {
      const b = before as { rows: ReturnType<typeof db.categoryFields>; ruleMerchant: string | null; rule: { field: 'merchant'; pattern: string; categoryId: number } | null }
      db.restoreCategoryFields(b.rows)
      if (b.ruleMerchant) {
        const now = db.ruleFor('merchant', b.ruleMerchant)
        if (b.rule) db.upsertRule('merchant', b.rule.pattern, b.rule.categoryId)
        else if (now) db.deleteRule(now.id)
      }
      db.applyBucketRules()
    }
  },
  create_rule: {
    before: (i) => {
      const field = i.field === 'contains' ? 'contains' : 'merchant'
      const pattern = str(i.pattern)
      const cat = db.listCategories().find((c) => c.name.toLowerCase() === str(i.category).toLowerCase())
      return { rule: db.ruleFor(field, pattern), rows: cat ? db.categoryFields(db.ruleMatches(field, pattern, cat.id)) : [] }
    },
    undo: (before, _after, i) => {
      const b = before as { rule: { field: 'merchant' | 'contains'; pattern: string; categoryId: number } | null; rows: ReturnType<typeof db.categoryFields> }
      const field = i.field === 'contains' ? 'contains' : 'merchant'
      const now = db.ruleFor(field, str(i.pattern))
      if (b.rule) db.upsertRule(b.rule.field, b.rule.pattern, b.rule.categoryId)
      else if (now) db.deleteRule(now.id)
      db.restoreCategoryFields(b.rows)
      db.applyBucketRules()
    }
  },
  set_note: {
    before: (i) => column<string | null>('notes', ids(i)),
    undo: (before) => {
      for (const r of before as Array<{ id: string; notes: string | null }>) db.setTransactionFields(r.id, { notes: r.notes })
    }
  },
  mark_one_time: {
    before: (i) => column<number>('one_time', ids(i)),
    undo: (before) => {
      const rows = before as Array<{ id: string; one_time: number }>
      db.setOneTime(rows.filter((r) => r.one_time === 1).map((r) => r.id), true)
      db.setOneTime(rows.filter((r) => r.one_time !== 1).map((r) => r.id), false)
    }
  },
  set_hsa: {
    before: (i) => column<string | null>('hsa', ids(i)),
    undo: (before) => {
      for (const r of before as Array<{ id: string; hsa: 'eligible' | 'not' | 'reimbursed' | null }>) db.setHsa([r.id], r.hsa)
    }
  },
  set_bucket: {
    before: (i) => db.bucketFields(ids(i)),
    undo: (before) => db.restoreBucketFields(before as ReturnType<typeof db.bucketFields>)
  },
  // A venture rule moves lines' ventures and an asset rule their assets: each keeps the fields it will move.
  add_bucket_rule: {
    before: (i) => {
      const assetId = typeof i.asset_id === 'string' && i.asset_id ? i.asset_id : null
      const bucket = assetId ? null : db.bucketByName(str(i.bucket))
      if (!assetId && !bucket) return { rows: [], assets: [] }
      const category = typeof i.category === 'string' && i.category.trim() ? db.listCategories().find((c) => c.name.toLowerCase() === str(i.category).toLowerCase()) : undefined
      const r = {
        bucketId: bucket?.id ?? null,
        assetId,
        accountId: typeof i.account_id === 'string' ? i.account_id : null,
        categoryId: category?.id ?? null,
        contains: typeof i.contains === 'string' ? i.contains : null,
        amountCents: typeof i.amount === 'number' ? Math.round(i.amount * 100) : null,
        fromDay: typeof i.from === 'string' ? i.from : null,
        toDay: typeof i.to === 'string' ? i.to : null
      }
      const ids = db.bucketRuleMatches(r)
      return assetId ? { rows: [], assets: db.assetFields(ids) } : { rows: db.bucketFields(ids), assets: [] }
    },
    after: (_i, result) => ({ rule_id: (result as { rule_id?: number }).rule_id ?? null }),
    undo: (before, after) => {
      const id = (after as { rule_id: number | null }).rule_id
      const b = before as { rows: ReturnType<typeof db.bucketFields>; assets?: ReturnType<typeof db.assetFields> }
      if (id !== null) db.deleteBucketRule(id)
      db.applyBucketRules()
      db.restoreBucketFields(b.rows)
      db.restoreAssetFields(b.assets ?? [])
    }
  },
  delete_bucket_rule: {
    before: (i) => {
      const rule = db.listBucketRules().find((r) => r.id === Number(i.rule_id)) ?? null
      const placed = (sql: string, ...params: Array<string | number>): string[] => db.all<{ id: string }>(sql, ...params).map((r) => r.id)
      if (rule?.assetId) return { rule, rows: [], assets: db.assetFields(placed("SELECT id FROM transactions WHERE asset_id = ? AND asset_source = 'rule'", rule.assetId)) }
      const rows = rule ? db.bucketFields(placed("SELECT id FROM transactions WHERE bucket_id = ? AND bucket_source = 'rule'", rule.bucketId!)) : []
      return { rule, rows, assets: [] }
    },
    undo: (before) => {
      const b = before as { rule: BucketRule | null; rows: ReturnType<typeof db.bucketFields>; assets?: ReturnType<typeof db.assetFields> }
      if (b.rule) db.restoreBucketRule(b.rule)
      db.applyBucketRules()
      db.restoreBucketFields(b.rows)
      db.restoreAssetFields(b.assets ?? [])
    }
  },
  // The asset's uses as they were, sources and all.
  set_asset_use: {
    before: (i) => db.listAssetUses(str(i.asset_id)),
    undo: (before, _after, i) => db.replaceAssetUses(str(i.asset_id), (before as AssetUse[]).map(({ fromDay, toDay, bucketId, shareBp, basis, source }) => ({ fromDay, toDay, bucketId, shareBp, basis, source })))
  },
  place_on_asset: {
    before: (i) => db.assetFields(ids(i), i.split_id === undefined ? undefined : Number(i.split_id)),
    undo: (before) => db.restoreAssetFields(before as ReturnType<typeof db.assetFields>)
  },
  attach_receipt: {
    before: (i) => receiptFields(ids(i)),
    undo: (before) => {
      for (const r of before as Array<{ id: string; receipt: string | null }>) linkReceipt([r.id], r.receipt)
    }
  },
  detach_receipt: {
    before: (i) => receiptFields(ids(i)),
    undo: (before) => {
      for (const r of before as Array<{ id: string; receipt: string | null }>) linkReceipt([r.id], r.receipt)
    }
  },
  rename_transactions: {
    before: (i) => column<string>('description', ids(i)),
    undo: (before) => {
      for (const r of before as Array<{ id: string; description: string }>) db.setTransactionFields(r.id, { description: r.description })
    }
  },
  remember: {
    after: (_i, result) => ({ fact_id: (result as { fact_id: number }).fact_id }),
    undo: (_before, after) => db.deleteFact((after as { fact_id: number }).fact_id)
  },
  forget: {
    before: (i) => db.listFacts().find((f) => f.id === Number(i.fact_id)) ?? null,
    undo: (before) => {
      if (before) db.restoreFact(before as Fact)
    }
  },
  resolve_issue: {
    before: (i) => db.listResolvedIssues().find((r) => r.key === str(i.issue_key)) ?? null,
    undo: (before, _after, i) => {
      const key = str(i.issue_key)
      const b = before as { note: string | null; summary: string | null } | null
      if (b) db.resolveIssue(key, b.note, b.summary)
      else db.unresolveIssue(key)
    }
  },
  add_question: {
    after: (_i, result) => ({ question_id: (result as { question_id: number }).question_id }),
    undo: (_before, after) => db.deleteQuestion((after as { question_id: number }).question_id)
  },
  answer_question: {
    undo: (_before, _after, i) => db.reopenQuestion(Number(i.question_id))
  },
  update_recurring: {
    before: (i) => override(str(i.key)),
    undo: (before, _after, i) => {
      const key = str(i.key)
      const b = before as db.RecurringOverride | null
      if (b) db.setRecurringOverride(key, { status: b.status, kind: b.kind, name: b.name })
      else db.deleteRecurringOverride(key)
    }
  },
  merge_accounts: {
    before: (i) => {
      const from = str(i.from_account_id)
      const into = str(i.into_account_id)
      return { merge: db.accountMergeSnapshot(from, into), credit: accountRefs(from), intoLimit: accountRefs(into).limit }
    },
    undo: (before) => {
      const b = before as { merge: db.MergeSnapshot; credit: AccountRefs; intoLimit: AccountRefs['limit'] }
      db.inTransaction(() => {
        db.undoAccountMerge(b.merge)
        restoreAccountRefs(String(b.merge.from.id), b.credit, String(b.merge.into.id), b.intoLimit)
      })
    }
  },
  update_account: {
    before: (i) => {
      const id = str(i.account_id)
      const a = account(id)
      return { fields: accountFields(id), point: typeof i.balance === 'number' ? db.getBalancePoint(id, today()) : undefined, raw: typeof i.balance === 'number' && a?.source !== 'manual' ? db.accountBalanceRaw(id) : undefined }
    },
    undo: (before, _after, i) => {
      const id = str(i.account_id)
      const b = before as { fields: Record<string, unknown> | null; point?: ReturnType<typeof db.getBalancePoint>; raw?: ReturnType<typeof db.accountBalanceRaw> }
      if (!b.fields) return
      const keys: Array<[string, string]> = [['name', 'name'], ['hidden', 'hidden'], ['type', 'assetType'], ['opened', 'openedDay'], ['closed', 'closedDay'], ['cost', 'costCents'], ['sale_costs', 'saleCostsCents'], ['details', 'details'], ['linked_asset_id', 'linkedAssetId'], ['bucket', 'bucketId'], ['apr', 'apr'], ['promo_apr', 'promoApr'], ['promo_ends', 'promoEnds'], ['min_payment', 'minPaymentCents'], ['escrow', 'escrowCents']]
      const patch: Record<string, unknown> = {}
      for (const [input, field] of keys) if (i[input] !== undefined) patch[field] = b.fields[field]
      if (Object.keys(patch).length) db.updateAccount(id, patch as AccountPatch)
      if (b.point !== undefined) db.restoreBalancePoint(id, today(), b.point)
      if (b.raw !== undefined) db.restoreAccountBalanceRaw(id, b.raw)
    }
  },
  set_account_role: {
    // The role as stored: null was a guess from the name, and goes back to being one.
    before: (i) => db.cashRoleRaw(str(i.account_id)),
    undo: (before, _after, i) => db.setCashRole(str(i.account_id), before as CashRole | null)
  },
  link_loan_payment: {
    before: (i) => db.paymentKeyRaw(str(i.account_id)),
    undo: (before, _after, i) => db.setPaymentKey(str(i.account_id), before as string | null)
  },
  mark_capital: {
    before: (i) => db.capitalAssets(ids(i)),
    undo: (before) => {
      for (const r of before as ReturnType<typeof db.capitalAssets>) db.setCapitalAsset([r.id], r.assetId)
    }
  },
  add_asset: {
    after: (_i, result) => ({ account_id: (result as { account_id: string }).account_id }),
    undo: (_before, after) => db.deleteAccount((after as { account_id: string }).account_id)
  },
  record_balance: {
    before: (i) => db.getBalancePoint(str(i.account_id), str(i.date)),
    undo: (before, _after, i) => db.restoreBalancePoint(str(i.account_id), str(i.date), before as ReturnType<typeof db.getBalancePoint>)
  },
  delete_balance: {
    before: (i) => db.getBalancePoint(str(i.account_id), str(i.date)),
    undo: (before, _after, i) => db.restoreBalancePoint(str(i.account_id), str(i.date), before as ReturnType<typeof db.getBalancePoint>)
  },
  record_flows: {
    before: (i) => ({ knownFrom: db.flowsKnownFrom().get(str(i.account_id)) ?? null }),
    after: (_i, result) => ({ flow_ids: (result as { flow_ids: number[] }).flow_ids }),
    undo: (before, after, i) => {
      for (const id of (after as { flow_ids: number[] }).flow_ids) db.deleteRecordedFlow(id)
      if (i.known_from !== undefined) db.setFlowsKnownFrom(str(i.account_id), (before as { knownFrom: string | null }).knownFrom)
    }
  },
  delete_flows: {
    before: (i) => {
      const want = new Set((Array.isArray(i.flow_ids) ? i.flow_ids : []).map(Number))
      return db.listRecordedFlows().filter((f) => want.has(f.id))
    },
    undo: (before) => {
      for (const f of before as db.RecordedFlow[]) db.restoreRecordedFlow(f)
    }
  },
  add_calendar_event: {
    after: (_i, result) => ({ event_id: (result as { event_id: number }).event_id }),
    undo: (_before, after) => db.deleteCalendarEvent((after as { event_id: number }).event_id)
  },
  update_calendar_event: {
    before: (i) => event(Number(i.event_id)),
    undo: (before) => {
      if (before) db.restoreCalendarEvent(before as CalendarEvent)
    }
  },
  delete_calendar_event: {
    before: (i) => event(Number(i.event_id)),
    undo: (before) => {
      if (before) db.restoreCalendarEvent(before as CalendarEvent)
    }
  },
  set_tax_year: {
    before: (i) => findTaxYear(Number(i.year)),
    undo: (before, _after, i) => {
      const b = before as TaxYear | null
      if (b) setTaxYear(b.year, b)
      else deleteTaxYear(Number(i.year))
    }
  },
  delete_tax_year: {
    before: (i) => findTaxYear(Number(i.year)),
    undo: (before) => {
      const b = before as TaxYear | null
      if (b) setTaxYear(b.year, b)
    }
  },
  set_benefit_plan: {
    before: (i) => findBenefitPlan(str(i.name)),
    undo: (before, _after, i) => {
      const b = before as BenefitPlan | null
      if (b) setBenefitPlan(b.name, b)
      else deleteBenefitPlan(str(i.name))
    }
  },
  delete_benefit_plan: {
    before: (i) => findBenefitPlan(str(i.name)),
    undo: (before) => {
      const b = before as BenefitPlan | null
      if (b) setBenefitPlan(b.name, b)
    }
  },
  set_benefits: {
    before: () => benefitSettings(),
    undo: (before) => setBenefitSettings(before as ReturnType<typeof benefitSettings>)
  },
  set_hsa_year: {
    before: (i) => findHsaYear(Number(i.year)),
    undo: (before, _after, i) => {
      const b = before as ReturnType<typeof findHsaYear>
      setHsaYear(Number(i.year), b?.cents ?? null, b?.employerCents ?? null, b?.source ?? null)
    }
  },
  set_insurance_policy: {
    before: (i) => findPolicy(typeof i.id === 'string' ? i.id : str(i.name)),
    after: (_i, result) => ({ id: (result as { id: string }).id }),
    undo: (before, after) => {
      const b = before as InsurancePolicy | null
      if (b) restorePolicy(b)
      else deletePolicy((after as { id: string }).id)
    }
  },
  delete_insurance_policy: {
    before: (i) => findPolicy(str(i.policy)),
    undo: (before) => {
      if (before) restorePolicy(before as InsurancePolicy)
    }
  },
  record_credit_score: {
    before: (i) => {
      const bureau = CREDIT_BUREAUS.find((b) => b.toLowerCase() === str(i.bureau).toLowerCase()) ?? null
      return scoreToReplace({ day: str(i.day), bureau, model: str(i.model) || null, source: str(i.source) || null })
    },
    after: (_i, result) => ({ id: (result as { id: string }).id }),
    undo: (before, after) => {
      try {
        deleteScore((after as { id: string }).id)
      } catch {
        // already gone
      }
      if (before) restoreScore(before as CreditScore)
    }
  },
  delete_credit_score: {
    before: (i) => findScore(str(i.id)),
    undo: (before) => {
      if (before) restoreScore(before as CreditScore)
    }
  },
  set_credit_report: {
    before: (i) => findReport(str(i.bureau), str(i.day)),
    undo: (before, _after, i) => restoreReport(str(i.bureau), str(i.day), before as CreditReport | null)
  },
  set_credit_limit: {
    before: (i) => findLimit(str(i.account_id)),
    undo: (before, _after, i) => {
      const b = before as ReturnType<typeof findLimit>
      setLimit(str(i.account_id), b?.cents ?? null, b?.source ?? null, b?.asOf ?? null)
    }
  },
  // The retirement settings as stored, unset ones as null, so undo writes each back or clears it.
  set_retirement: {
    before: () => Object.fromEntries(Object.values(RETIRE_KEYS).map((key) => [key, db.getSetting(key)])),
    undo: (before) => {
      for (const [key, value] of Object.entries(before as Record<string, string | null>)) db.setSetting(key, value)
    }
  },
  // The debt plan's inputs as stored, null when nothing had set them, so undo writes them back or clears them.
  set_debt_plan: {
    before: () => db.getSetting(DEBT_PLAN_KEY),
    undo: (before) => db.setSetting(DEBT_PLAN_KEY, before as string | null)
  },
  // A close is a new version of its month; undo removes that version, and the ones before it stand as they were.
  close_month: {
    after: (_i, result) => ({ month: (result as { month: string }).month, version: (result as { version: number }).version }),
    undo: (_before, after) => {
      const a = after as { month: string; version: number }
      deleteClose(a.month, a.version)
    }
  },
  // Accepting closes each changed month again as its next version; undo removes those versions, so each month is its
  // earlier close's again, changed as it was, with what its check kept of why.
  accept_close_changes: {
    before: () => {
      const months = changedMonths().map((c) => c.month)
      return { states: checkedStates(months) }
    },
    after: (_i, result) => ({ versions: (result as { months: Array<{ month: string; version: number }> }).months.map((m) => ({ month: m.month, version: m.version })) }),
    undo: (before, after) => {
      for (const v of [...(after as { versions: Array<{ month: string; version: number }> }).versions].reverse()) deleteClose(v.month, v.version)
      restoreCheckedStates((before as { states: Record<string, string | null> }).states)
    }
  },
  set_contribution: {
    before: (i) => db.listContributionRows().find((r) => r.name.toLowerCase() === str(i.name).toLowerCase()) ?? null,
    after: (_i, result) => ({ id: (result as { id: number }).id }),
    undo: (before, after) => {
      const b = before as ReturnType<typeof db.listContributionRows>[number] | null
      if (b) db.saveContribution(b)
      else db.deleteContribution((after as { id: number }).id)
    }
  },
  delete_contribution: {
    before: (i) => db.listContributionRows().find((r) => r.name.toLowerCase() === str(i.name).toLowerCase()) ?? null,
    undo: (before) => {
      const b = before as ReturnType<typeof db.listContributionRows>[number] | null
      if (b) db.saveContribution({ ...b, id: undefined })
    }
  },
  record_paystub: {
    before: (i) => stubAt(i.paycheck_key, i.pay_day, i.kind),
    after: (_i, result) => ({ id: (result as { id: number }).id }),
    undo: (before, after) => putStubBack(before as Paystub | null, after as { id: number })
  },
  // record_paystub's old name, for a check's taxes and premiums on its pay date.
  set_paycheck_withholding: {
    before: (i) => stubAt(i.paycheck_key, i.as_of),
    after: (_i, result) => ({ id: (result as { id: number }).id }),
    undo: (before, after) => putStubBack(before as Paystub | null, after as { id: number })
  },
  // It removes the payroll's latest paystub.
  delete_paycheck_withholding: {
    before: (i) => db.listPaystubs(asPayrollKey(str(i.paycheck_key))).at(-1) ?? null,
    undo: (before) => {
      if (before) db.writePaystub(before as Paystub)
    }
  },
  // A commitment (or a hidden habit) lives in the budget's preferences and moves its line's target.
  commit_habit: {
    before: () => ({ prefs: db.getSetting('budget.prefs'), budgets: [...db.listBudgets()] }),
    undo: (before) => {
      const b = before as { prefs: string | null; budgets: Array<[number, number]> }
      db.setSetting('budget.prefs', b.prefs)
      const was = new Map(b.budgets)
      for (const id of db.listBudgets().keys()) if (!was.has(id)) db.setBudget(id, null)
      for (const [id, cents] of was) db.setBudget(id, cents)
    }
  },
  // A category's tier, the cheaper grocer and the one-off budget live in the budget's preferences too, with the
  // commitments a tier or a one-off budget drops: putting the preferences back brings those back as well.
  set_category_tier: budgetPrefs(),
  set_cheaper_store: budgetPrefs(),
  set_one_off_budget: budgetPrefs(),
  hide_vendor: {
    before: () => hiddenVendors(),
    undo: (before) => {
      setHiddenVendors(before as string[])
    }
  },
  add_trip: {
    before: (i) => (typeof i.id === 'string' && i.id ? trip(i.id) : null),
    after: (_i, result) => ({ id: (result as { id: string }).id }),
    undo: (before, after) => {
      const b = before as Trip | null
      if (b) restoreTrip(b)
      else removeTrip((after as { id: string }).id)
    }
  },
  remove_trip: {
    before: (i) => trip(str(i.trip)),
    undo: (before) => {
      if (before) restoreTrip(before as Trip)
    }
  },
  mark_document_read: {
    before: (i) => db.documentRecords().get(str(i.name)) ?? null,
    undo: (before, _after, i) => {
      const b = before as { size: number; summary: string | null } | null
      if (b) db.markDocument(str(i.name), b.size, b.summary)
      else db.deleteDocumentRecord(str(i.name))
    }
  },
  create_category: {
    after: (_i, result) => ({ id: (result as { id: number }).id }),
    undo: (_before, after) => db.deleteCategory((after as { id: number }).id)
  },
  create_bucket: {
    after: (_i, result) => ({ id: (result as { id: number }).id }),
    undo: (_before, after) => db.deleteBucket((after as { id: number }).id)
  },
  // The bucket's fields, and its share rows as they were: in_net_worth replaces them (an alias since sub-phase 1j),
  // so they're put back as kept, not from the flag.
  update_bucket: {
    before: (i) => {
      const b = db.bucketByName(str(i.bucket))
      if (!b) return null
      return { ...b, shares: db.ventureShareRows(b.id).map(({ fromDay, shareBp, source }) => ({ fromDay, shareBp, source })), inNetWorthFlag: db.get<{ f: number }>('SELECT in_net_worth AS f FROM buckets WHERE id = ?', b.id)?.f ?? 1 }
    },
    undo: (before) => {
      const b = before as { id: number; name: string; kind: 'rental' | 'business' | 'person' | 'other'; description: string; inNetWorth: boolean; residenceFrom: string | null; residenceTo: string | null; shares?: VentureShare[]; inNetWorthFlag?: number } | null
      if (!b) return
      // An entry kept before shares were: the flag is all it has.
      if (!b.shares) return void db.saveBucket({ id: b.id, name: b.name, kind: b.kind, description: b.description, inNetWorth: b.inNetWorth, residenceFrom: b.residenceFrom, residenceTo: b.residenceTo })
      db.inTransaction(() => {
        db.saveBucket({ id: b.id, name: b.name, kind: b.kind, description: b.description, residenceFrom: b.residenceFrom, residenceTo: b.residenceTo })
        db.replaceVentureShares(b.id, b.shares!)
        db.run('UPDATE buckets SET in_net_worth = ? WHERE id = ?', b.inNetWorthFlag ?? (b.inNetWorth ? 1 : 0), b.id)
      })
    }
  },
  set_venture_share: {
    before: (i) => {
      const b = db.bucketByName(str(i.venture))
      return b ? { id: b.id, shares: db.ventureShareRows(b.id).map(({ fromDay, shareBp, source }) => ({ fromDay, shareBp, source })) } : null
    },
    undo: (before) => {
      const b = before as { id: number; shares: VentureShare[] } | null
      if (b) db.replaceVentureShares(b.id, b.shares)
    }
  },
  // The lines' stored intent parts, the venture's share rows (share_after_pct writes one) and its remembered answers
  // (remember writes one), each put back as kept.
  set_venture_money: {
    before: (i) => {
      const b = db.bucketByName(str(i.venture))
      return b ? { id: b.id, parts: db.ventureMoneyRows(ids(i)), shares: db.ventureShareRows(b.id).map(({ fromDay, shareBp, source }) => ({ fromDay, shareBp, source })), rules: db.ventureMoneyRules(b.id) } : null
    },
    after: (_i, result) => ({ rule_id: (result as { rule_id?: number }).rule_id ?? null }),
    undo: (before, _after, i) => {
      const b = before as { id: number; parts: db.VentureMoneyRow[]; shares: VentureShare[]; rules: db.VentureMoneyRule[] } | null
      if (!b) return
      db.inTransaction(() => {
        db.restoreVentureMoney(ids(i), b.parts)
        db.replaceVentureShares(b.id, b.shares)
        db.restoreVentureMoneyRules(b.id, b.rules)
      })
    }
  },
  set_venture_value: {
    before: (i) => {
      const b = db.bucketByName(str(i.venture))
      return b ? { id: b.id, ...db.ventureValueFields(b.id) } : null
    },
    undo: (before) => {
      const b = before as { id: number; valueSource: 'books' | 'estimate' | null; stakeAccountId: string | null } | null
      if (b) db.restoreVentureValue(b.id, b.valueSource, b.stakeAccountId)
    }
  },
  record_balances: {
    before: (i) => {
      const id = str(i.account_id)
      const rows = (Array.isArray(i.balances) ? i.balances : []) as Array<{ date?: unknown }>
      return rows.map((r) => ({ day: str(r.date), point: db.getBalancePoint(id, str(r.date)) }))
    },
    undo: (before, _after, i) => {
      for (const r of before as Array<{ day: string; point: ReturnType<typeof db.getBalancePoint> }>) db.restoreBalancePoint(str(i.account_id), r.day, r.point)
    }
  },
  split_transaction: {
    before: (i) => db.splitParts(str(i.transaction_id)),
    undo: (before, _after, i) => db.restoreSplit(str(i.transaction_id), before as TxnSplit[])
  },
  unsplit_transaction: {
    before: (i) => db.splitParts(str(i.transaction_id)),
    undo: (before, _after, i) => db.restoreSplit(str(i.transaction_id), before as TxnSplit[])
  },
  add_tags: {
    before: (i) => db.tagRows(ids(i)),
    undo: (before, _after, i) => db.restoreTagRows(ids(i), before as ReturnType<typeof db.tagRows>)
  },
  remove_tags: {
    before: (i) => db.tagRows(ids(i)),
    undo: (before, _after, i) => db.restoreTagRows(ids(i), before as ReturnType<typeof db.tagRows>)
  },
  set_category_target: {
    before: (i) => {
      const cat = db.listCategories().find((c) => c.name.toLowerCase() === str(i.category).toLowerCase())
      return cat ? targetRecord(cat.id) : null
    },
    undo: (before) => {
      if (before) restoreTargetRecord(before as TargetRecord)
    }
  },
  create_goal: {
    after: (_i, result) => ({ goal_id: (result as { goal_id: number }).goal_id }),
    undo: (_before, after) => {
      const id = (after as { goal_id: number }).goal_id
      if (getGoal(id)) deleteGoal(id)
    }
  },
  update_goal: {
    before: (i) => goalRecord(i.goal),
    undo: (before) => {
      if (before) restoreGoal(before as GoalRecord)
    }
  },
  delete_goal: {
    before: (i) => goalRecord(i.goal),
    undo: (before) => {
      if (before) restoreGoal(before as GoalRecord)
    }
  },
  // A reply to a text alert (textReplies.ts): a renewal's KEEP or HOW marks its series; DONE quiets today's low-balance alerts for the one who replied (a partner: member).
  text_reply: {
    before: (i) => (str(i.reply) === 'DONE' ? { done: lowDays(str(i.member) || null).done ?? null } : { mark: renewalMark(renewalSeriesKey(str(i.key)) ?? '') }),
    undo: (before, _after, i) => {
      const b = before as { done?: string | null; mark?: RenewalMark | null }
      if (str(i.reply) === 'DONE') return setLowDays({ done: b.done ?? null }, str(i.member) || null)
      const key = renewalSeriesKey(str(i.key))
      if (key) setRenewalMark(key, b.mark ?? null)
    }
  }
}

export const isJournaled = (tool: string): boolean => tool in JOURNAL

/** The state a call will replace; null when the tool keeps nothing beforehand. */
export function snapshotBefore(tool: string, input: Input): unknown {
  return JOURNAL[tool]?.before?.(input) ?? null
}

/** What a call left, from its result. */
export function snapshotAfter(tool: string, input: Input, result: unknown, before: unknown): unknown {
  return JOURNAL[tool]?.after?.(input, result, before) ?? null
}

/** Puts back what a journaled call did. */
export function undo(tool: string, before: unknown, after: unknown, input: Input): void {
  const j = JOURNAL[tool]
  if (!j) throw new Error(`${tool} can't be undone`)
  db.inTransaction(() => j.undo(before, after, input))
}
