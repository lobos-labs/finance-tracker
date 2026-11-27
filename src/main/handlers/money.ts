import * as db from '../db'
import { classifyInFlight } from '../classifier'
import { contributionSummary, monthContributions, monthWithholding } from '../contributions'
import { getInsight } from '../insights'
import { getSummary } from '../summary'
import { linesFor } from '../lines'
import { getNetWorthSeries } from '../netWorth'
import { payrollChecks } from '../paystubs'
import { vendorHider } from '../privacy'
import { detectRecurring } from '../recurring'
import { diffSnapshot, listSnapshots } from '../snapshots'
import { getSpendable, setSpendSettings, spendableStrip } from '../spendable'
import { carryingCost, lineAssets, listUses } from '../uses'
import { getWaterfall } from '../waterfall'
import { isRealDay } from '../../shared/zone'
import type { BucketSelection, ContributionInput, LineQuery, MonthSummary, Span } from '../../shared/types'
import { changed, hosted, plus, strings } from './context'

// Spending, net worth and the headline; the ledger's classified lines, the Personal waterfall and the months'
// closes, an asset's carrying cost, uses and rules, and which lines are its costs; Spendable and recurring money;
// paycheck contributions and each payroll's checks. Review confirms, dismisses and renames a series
// (update_recurring); there's no save for one here.

/** Hidden vendors aren't named among the top merchants or an income's payers (their money stays in every total). */
function unnamed<T extends { topMerchants: Array<{ merchant: string }>; incomeBySource: MonthSummary['incomeBySource'] }>(s: T): T {
  const hidden = vendorHider()
  const payers = (parts: Array<{ name: string; cents: number }>): Array<{ name: string; cents: number }> | undefined => {
    const named = parts.filter((p) => !hidden(p.name)).slice(0, 6)
    const rest = parts.length - named.length
    const out = rest ? [...named, { name: `${rest} more`, cents: parts.reduce((t, p) => t + p.cents, 0) - named.reduce((t, p) => t + p.cents, 0) }] : named
    return out.length > 1 ? out : undefined
  }
  return {
    ...s,
    topMerchants: s.topMerchants.filter((m) => !hidden(m.merchant)).slice(0, 8),
    incomeBySource: s.incomeBySource.map(({ parts, ...x }) => {
      const p = parts && payers(parts)
      return p ? { ...x, parts: p } : x
    })
  }
}

const selection = (buckets?: BucketSelection): number[] => (Array.isArray(buckets) && buckets.length ? buckets : [0])

export const moneyHandlers = {
  getSummary: hosted((_c, month: string, buckets?: BucketSelection) => {
    const sel = selection(buckets)
    // Contributions, taxes and insurance come out of Personal paychecks.
    const personal = sel.includes(0)
    return { ...unnamed(getSummary(month, sel)), contributions: personal ? monthContributions(month) : [], withholding: personal ? monthWithholding(month) : [] }
  }),
  getNetWorth: plus('netWorth', (_c, buckets?: BucketSelection) => getNetWorthSeries(Array.isArray(buckets) ? buckets : undefined)),
  // Written from settled numbers: any sync or categorization finishes first.
  getInsight: hosted(async (ctx, opts: { force?: boolean }) => {
    await ctx.syncIdle()
    await classifyInFlight()?.catch(() => {})
    return getInsight(!!opts?.force)
  }),

  // Every series, each with its owner (a venture's id, or null for Personal).
  listRecurring: hosted(() => detectRecurring({ scope: 'all' })),
  // The ledger's lines with their owners and classes (lines.ts), for a drill into any part of the waterfall.
  linesFor: hosted((_c, q: LineQuery, page?: { offset?: number; limit?: number }) => linesFor(q, page ?? {})),
  // What a house, vehicle or other asset costs to keep a month, and each owner's part (uses.ts); null for any other account.
  carryingCost: hosted((_c, assetId: string) => carryingCost(String(assetId))),
  // Who uses an asset over which days, and their shares (every asset's with none named). Review sets them: there's no save here.
  listUses: hosted((_c, assetId?: string) => listUses(typeof assetId === 'string' ? assetId : undefined)),
  // The asset rules that put lines on an asset as its costs.
  listAssetRules: hosted((_c, assetId: string) => db.listBucketRules(undefined, String(assetId))),
  // Which transactions (all, with none named) are an asset's costs, and Personal's share of each, for the Transactions page.
  lineAssets: hosted((_c, ids?: string[]) => lineAssets(Array.isArray(ids) ? strings(ids) : undefined)),
  // The Personal waterfall over a span of months or days (waterfall.ts): its rows, run rates, rates and changes, with
  // Home's Spendable strip, so Home reads everything it shows in one call.
  getWaterfall: hosted((_c, span: Span) => ({ ...getWaterfall(span), spendable: spendableStrip() })),
  listSnapshots: hosted((_c, limit?: number) => listSnapshots(typeof limit === 'number' ? limit : undefined)),
  // How a closed month differs today from its latest close, line by line and input by input, with each change's cause.
  snapshotDiff: hosted((_c, month: string) => diffSnapshot(String(month ?? ''))),
  getSpendable: hosted(() => getSpendable()),
  setSpendSettings: hosted((ctx, patch: Parameters<typeof setSpendSettings>[0]) => changed(ctx, setSpendSettings(patch ?? {}))),
  listContributions: hosted(() => contributionSummary()),
  // Each payroll's checks between two days, as the waterfall reads them: gross, every item, net, deposit and the
  // difference, for the pay-day table on Pay & benefits. Every calendar year asked is classified, so a call reads at
  // most three, and never holds the ledger for a century of empty years.
  listPayChecks: hosted((_c, fromDay: string, toDay: string) => {
    if (!isRealDay(String(fromDay)) || !isRealDay(String(toDay))) throw new Error('fromDay and toDay must be dates like 2026-10-01')
    if (Number(String(toDay).slice(0, 4)) - Number(String(fromDay).slice(0, 4)) > 2) throw new Error('fromDay and toDay must be within 3 calendar years')
    return payrollChecks(String(fromDay), String(toDay))
  }),
  saveContribution: hosted((ctx, c: ContributionInput) => changed(ctx, db.saveContribution(c))),
  deleteContribution: hosted((ctx, id: number) => changed(ctx, db.deleteContribution(id)))
}
