import * as db from '../db'
import { investments, withoutReturns } from '../investments'
import { getBalanceSheet } from '../netWorth'
import { can } from '../license'
import { assetLookup, revalue, setAssetLookup } from '../valuation'
import { getVenture, listVentures } from '../ventures'
import type { AccountPatch, NewAsset } from '../../shared/types'
import { changed, hosted, plus, refreshed } from './context'

// Accounts and assets, balances and their history, investments, live values,
// and ventures (reading what's there is free; every write is Plus).

type BucketRule = { bucketId: number; accountId?: string | null; contains?: string | null; amountCents?: number | null; fromDay?: string | null; toDay?: string | null }

export const accountHandlers = {
  listAccounts: hosted(() => db.listAccounts()),
  // Putting an account in a venture, or taking it out, moves its lines too.
  updateAccount: hosted((ctx, id: string, patch: AccountPatch) => (patch?.bucketId !== undefined ? refreshed : changed)(ctx, db.updateAccount(id, patch))),
  addAsset: hosted((ctx, a: NewAsset) => changed(ctx, db.addManualAccount(a))),
  deleteAccount: hosted((ctx, id: string) => changed(ctx, db.deleteAccount(id))),
  listAssets: plus('netWorth', () => db.listAssets()),
  // Holdings and balances come with net worth; the returns table is its own feature.
  getInvestments: plus('netWorth', () => (can('investmentReturns') ? investments() : withoutReturns(investments()))),
  getBalanceSheet: plus('netWorth', () => getBalanceSheet()),
  getAssetHistory: hosted((_c, id: string) => db.getAssetHistory(id)),
  revalueAsset: plus('liveValues', async (ctx, id: string) => refreshed(ctx, await revalue(id))),
  getValueLookup: hosted((_c, id: string) => assetLookup(String(id))),
  setValueLookup: plus('liveValues', (_c, id: string, enabled: boolean) => setAssetLookup(String(id), !!enabled)),
  listBalancePoints: hosted((_c, id: string) => db.listBalancePoints(id)),
  setBalancePoint: hosted((ctx, id: string, day: string, cents: number) => changed(ctx, db.setBalancePoint(id, day, cents))),
  deleteBalancePoint: hosted((ctx, id: string, day: string) => changed(ctx, db.deleteBalancePoint(id, day))),

  listBuckets: hosted(() => listVentures()),
  getBucket: hosted((_c, id: number) => getVenture(id)),
  saveBucket: plus('ventures', (ctx, b: db.BucketInput) => {
    // Residence dates aren't set any more: a home the user lives in is Personal's use of its house (asset_uses). The
    // venture form no longer sends inNetWorth (the share is Review's, since sub-phase 1j); a client that still sends it
    // with every save replaces the share on an edit only when it differs from whether the user owns any of it today,
    // so a rename keeps the shares Review set.
    const was = b.id ? db.listBuckets().find((x) => x.id === b.id) : undefined
    const inNetWorth = b.inNetWorth === undefined || (was && was.inNetWorth === !!b.inNetWorth) ? undefined : !!b.inNetWorth
    const id = db.saveBucket({ id: b.id, name: b.name, kind: b.kind, description: b.description, inNetWorth })
    ctx.broadcast('data:bulk')
    return changed(ctx, id)
  }),
  deleteBucket: plus('ventures', (ctx, id: number) => {
    db.deleteBucket(id)
    ctx.broadcast('data:bulk')
    return changed(ctx, undefined)
  }),
  setTransactionsBucket: plus('ventures', (ctx, ids: string[], bucketId: number | null) => {
    db.setTransactionsBucket(ids, bucketId)
    if (ids.length > 1) ctx.broadcast('data:bulk')
    return changed(ctx, undefined)
  }),
  addBucketRule: plus('ventures', (ctx, r: BucketRule) => {
    const id = db.addBucketRule(r)
    db.applyBucketRules()
    ctx.broadcast('data:bulk')
    return changed(ctx, id)
  }),
  deleteBucketRule: plus('ventures', (ctx, id: number) => {
    db.deleteBucketRule(id)
    db.applyBucketRules()
    ctx.broadcast('data:bulk')
    return changed(ctx, undefined)
  })
}
