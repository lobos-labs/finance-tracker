import * as db from './db'
import { aiEnabled } from './ai/backend'
import { historyPending, notePlaidBills, RECENT_DAYS } from './bankHistory'
import { plaidBill, plaidCategory } from './plaidCategories'
import type { AssetType, RecurringKind, SyncResult } from '../shared/types'

// One page of Plaid's /transactions/sync turned into the ledger's rows: its
// accounts and balances (debts negative), new and changed transactions (a
// posted charge takes over what was set on its pending one), removed ones,
// and Plaid's own category when the AI is off and no rule or earlier payment
// covers a row. No transport here: the desktop fetches pages through the
// server's relay (bank.ts), a hosted Ledger fetches them from Plaid itself
// (finance-server/src/ledger/sync.ts), and both apply them with applyPage.
// Plaid's amounts are positive for money out; the ledger's are negative.

export interface PlaidTxn {
  transaction_id: string
  account_id: string
  amount: number
  date: string
  name: string | null
  merchant_name: string | null
  pending: boolean
  pending_transaction_id: string | null
  personal_finance_category: { primary?: string | null; detailed?: string | null } | null
}

export interface PlaidAccount {
  account_id: string
  name: string
  official_name: string | null
  mask: string | null
  type: string
  subtype: string | null
  balances: { current: number | null; available: number | null; limit: number | null; iso_currency_code: string | null }
}

/** A /transactions/sync page as the server trims it (finance-server src/bank/pull.ts). */
export interface SyncPage {
  added: PlaidTxn[]
  modified: PlaidTxn[]
  removed: Array<{ transaction_id: string }>
  accounts: PlaidAccount[]
  nextCursor: string
  hasMore: boolean
}

const TYPE: Record<string, AssetType> = { depository: 'cash', credit: 'credit_card', loan: 'loan', investment: 'investment', other: 'other_asset' }
const RETIREMENT = /401|403|457|ira|roth|pension|retirement|keogh|sep|simple|tsp|hsa/i

function typeOf(a: PlaidAccount): AssetType {
  if (a.type === 'loan' && a.subtype === 'mortgage') return 'mortgage'
  if (a.type === 'investment' && RETIREMENT.test(a.subtype ?? '')) return 'retirement'
  return TYPE[a.type] ?? 'other_asset'
}

const cents = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null)

/** Noon on the day in the ledger's zone, like every other dated row. */
const posted = (day: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? db.noon(day) : null)

const accountId = (a: { account_id: string }): string => `plaid:${a.account_id}`
const txnId = (t: { transaction_id: string }): string => `plaid:${t.transaction_id}`

/** Applies one page of Plaid's changes to the ledger in scope, adding to the counts in `result`. */
export function applyPage(page: SyncPage, institution: string | null, result: SyncResult): void {
  const now = db.now()
  const ai = aiEnabled()
  const categories = new Map(db.listCategories().map((c) => [c.name, c.id]))
  const rules = ai ? [] : db.listRules()
  const merged = db.mergedAccounts()
  // While the bank's history arrives, the recent charges Plaid calls bills are noted for Spendable (bankHistory.ts).
  const bills = historyPending() ? new Map<string, RecurringKind>() : null
  const recent = now - RECENT_DAYS * 86_400
  db.inTransaction(() => {
    for (const a of page.accounts) {
      const id = accountId(a)
      if (merged[id]) continue
      const type = typeOf(a)
      const debt = type === 'credit_card' || type === 'loan' || type === 'mortgage'
      // Plaid gives what's owed on a card or loan as a positive balance; the ledger keeps debts negative.
      const current = cents(a.balances.current)
      db.upsertAccount({
        id,
        source: 'plaid',
        name: db.cleanText(a.mask ? `${a.name} (${a.mask})` : a.name, db.MERCHANT_MAX) || 'Account',
        institution,
        currency: a.balances.iso_currency_code?.slice(0, 8) ?? 'USD',
        balanceCents: current === null ? null : debt ? -current : current,
        availableCents: debt ? null : cents(a.balances.available),
        balanceDate: now
      })
      db.setAccountTypeIfUnset(id, type)
      // Checking, savings, a CD: the first one known corrects what a cash account is for.
      db.setPlaidSubtype(id, a.subtype)
    }
    for (const t of [...page.added, ...page.modified]) {
      const amount = cents(t.amount)
      const day = posted(t.date)
      const account = `plaid:${t.account_id}`
      if (amount === null || day === null || merged[account]) continue
      const id = txnId(t)
      const isNew = db.upsertTransaction({ id, accountId: account, posted: day, amountCents: -amount, description: (t.name || t.merchant_name || 'Transaction').trim(), pending: t.pending })
      if (!isNew) {
        result.updated++
        continue
      }
      result.added++
      if (t.pending_transaction_id) db.carryPending(`plaid:${t.pending_transaction_id}`, id)
      const bill = bills && amount > 0 && day > recent ? plaidBill(t.personal_finance_category) : null
      if (bill) bills!.set(id, bill)
      const row = db.getTransaction(id)
      if (!row || row.categoryId !== null) continue
      if (t.merchant_name && !row.merchant) db.setTransactionFields(id, { merchant: t.merchant_name })
      // Without the AI, the bank's own category stands in when no rule or earlier payment covers the row.
      if (ai) continue
      const named = { merchant: t.merchant_name ?? row.merchant, descKey: db.descKey(row.description), description: row.description }
      if (db.matchRule(rules, named) || db.findHistoryMatch(named.descKey, -amount, id)) continue
      const category = plaidCategory(t.personal_finance_category)
      const categoryId = category ? categories.get(category) : undefined
      if (categoryId !== undefined) db.setTransactionFields(id, { categoryId, source: 'rule', confidence: 'medium' })
    }
    db.removeBankRows(page.removed.map(txnId))
    if (bills) notePlaidBills(bills)
  })
  result.accounts = Math.max(result.accounts, page.accounts.length)
}
