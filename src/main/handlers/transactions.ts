import * as db from '../db'
import { requireFeature } from '../license'
import type { RuleField, SplitPart, TxnQuery, TxnUpdate, TxnUpdateResult } from '../../shared/types'
import { changed, hosted, strings, type HandlerContext } from './context'

// Transactions, their splits and tags (every plan; a part put in another
// venture is a ventures write, like moving the transaction), categories and
// rules.

async function updateTransaction(ctx: HandlerContext, id: string, u: TxnUpdate): Promise<TxnUpdateResult> {
  const t = db.getTransaction(id)
  if (!t) throw new Error('Transaction not found')
  // A split transaction's categories are its parts'.
  if (u.categoryId !== undefined && t.splits.length) throw new Error('Split · unsplit it first')
  let alsoUpdated = 0
  let ruleCreated = false
  if (u.bucketId !== undefined) db.setTransactionsBucket([id], u.bucketId)
  if (u.merchant !== undefined) db.setTransactionFields(id, { merchant: u.merchant })
  if (u.notes !== undefined) db.setTransactionFields(id, { notes: u.notes })
  if (u.categoryId !== undefined) {
    db.setTransactionFields(id, { categoryId: u.categoryId, source: 'user' })
    if (u.remember && u.categoryId !== null) {
      const merchant = (u.merchant !== undefined ? u.merchant : t.merchant)?.trim()
      const key = db.getDescKey(id)
      if (merchant) {
        db.upsertRule('merchant', merchant, u.categoryId)
        ruleCreated = true
      } else if (key) {
        db.upsertRule('key', key, u.categoryId)
        ruleCreated = true
      }
      // A backup first: the rewrite touches rows across the whole history.
      if (ruleCreated) {
        await ctx.backup()
        alsoUpdated = db.applyRulesToAll()
      }
    }
    db.applyBucketRules()
  }
  return { alsoUpdated, ruleCreated }
}

export const transactionHandlers = {
  listTransactions: hosted((_c, q: TxnQuery) => db.listTransactions(q)),
  updateTransaction: hosted(async (ctx, id: string, u: TxnUpdate) => changed(ctx, await updateTransaction(ctx, id, u))),
  deleteTransaction: hosted((ctx, id: string) => {
    if (!db.deleteTransaction(String(id))) throw new Error('Transaction not found')
    return changed(ctx, undefined)
  }),
  setOneTime: hosted((ctx, ids: string[], oneTime: boolean) => changed(ctx, db.setOneTime(Array.isArray(ids) ? ids.map(String) : [], !!oneTime))),

  splitTransaction: hosted((ctx, id: string, parts: SplitPart[]) => {
    const t = db.getTransaction(String(id))
    if (!t) throw new Error('Transaction not found')
    const given = (Array.isArray(parts) ? parts : []).map((p) => ({
      amountCents: Number(p?.amountCents),
      categoryId: typeof p?.categoryId === 'number' ? p.categoryId : null,
      bucketId: p?.bucketId === undefined ? undefined : typeof p.bucketId === 'number' ? p.bucketId : null,
      oneTime: !!p?.oneTime,
      note: typeof p?.note === 'string' ? p.note : null
    }))
    // Only a venture that changes is a ventures write: a split saved again as it was isn't.
    if (db.splitMovesVentures(t, given)) requireFeature('ventures')
    db.splitTransaction(t.id, given)
    ctx.broadcast('data:changed')
  }),
  unsplitTransaction: hosted((ctx, id: string) => {
    db.unsplitTransaction(String(id))
    ctx.broadcast('data:changed')
  }),
  listTags: hosted(() => db.listTags()),
  addTags: hosted((ctx, ids: string[], tags: string[]) => {
    db.addTags(strings(ids), strings(tags))
    ctx.broadcast('data:changed')
  }),
  removeTags: hosted((ctx, ids: string[], tags: string[]) => {
    db.removeTags(strings(ids), strings(tags))
    ctx.broadcast('data:changed')
  }),

  listCategories: hosted(() => db.listCategories()),
  // A category's name and kind decide its lines' classes: the views redraw, and the closed months are checked.
  saveCategory: hosted((ctx, c: Parameters<typeof db.saveCategory>[0]) => changed(ctx, db.saveCategory(c))),
  deleteCategory: hosted((ctx, id: number) => changed(ctx, db.deleteCategory(id))),

  listRules: hosted(() => db.listRules()),
  addRule: hosted(async (ctx, r: { field: RuleField; pattern: string; categoryId: number }) => {
    await ctx.backup()
    const id = db.upsertRule(r.field, r.pattern, r.categoryId)
    db.applyRulesToAll()
    db.applyBucketRules()
    return changed(ctx, id)
  }),
  deleteRule: hosted((_c, id: number) => db.deleteRule(id))
}
