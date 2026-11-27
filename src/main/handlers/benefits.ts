import * as db from '../db'
import { getBenefits, setCareDone } from '../benefits'
import { creditReportPaths, getCredit } from '../credit'
import { probeFiles } from '../files'
import { getInsurance, insuranceFilePaths } from '../insurance'
import { importReceipt, linkReceipt, RECEIPT_TYPES } from '../receipts'
import { getTaxes, taxFormPaths } from '../taxes'
import type { HsaState } from '../../shared/types'
import { changed, hosted, plus, strings } from './context'
import { extOf, uploadRef } from './files'

// Benefits and the HSA, taxes, insurance (Plus), and the Credit page (its
// scores, utilization and ages are free; reading reports is a Plus tool).
// Opening a form, report, policy or receipt is the desktop's (ipc.ts).

export const benefitHandlers = {
  getBenefits: plus('benefits', () => getBenefits()),
  // Whether the files are still there is checked off the main thread before the page is built.
  getTaxes: plus('taxes', async () => {
    await probeFiles(taxFormPaths())
    return getTaxes()
  }),
  getCredit: hosted(async () => {
    await probeFiles(creditReportPaths())
    return getCredit()
  }),
  getInsurance: plus('insurance', async () => {
    await probeFiles(insuranceFilePaths())
    return getInsurance()
  }),
  setHsa: plus('benefits', (ctx, ids: string[], state: HsaState | null) => changed(ctx, db.setHsa(strings(ids), state ?? null))),
  setCareDone: plus('benefits', (ctx, key: string, day: string | null) => changed(ctx, setCareDone(String(key), day ?? null))),
  /**
   * The desktop copies a picked (or given) file into the documents folder's Receipts; the web links the
   * costs to a file already uploaded to the account, kept where it was uploaded.
   */
  attachReceipt: plus('benefits', async (ctx, ids: string | string[], ref?: string | null) => {
    const list = typeof ids === 'string' ? [ids] : strings(ids)
    if (ctx.platform === 'web') {
      if (typeof ref !== 'string' || !ref) throw new Error('Upload the receipt first')
      const file = await ctx.file(ref)
      if (!RECEIPT_TYPES.includes(extOf(file.name))) throw new Error(`A receipt can be ${RECEIPT_TYPES.join(', ')}`)
      const stored = uploadRef(file)
      linkReceipt(list, stored)
      return changed(ctx, stored)
    }
    const source = typeof ref === 'string' && ref ? ref : await ctx.pickFile({ title: 'Attach a receipt', name: 'Receipts', extensions: RECEIPT_TYPES })
    if (!source) return null
    return changed(ctx, importReceipt(list, source))
  }),
  detachReceipt: plus('benefits', (ctx, ids: string[]) => changed(ctx, linkReceipt(strings(ids), null)))
}
