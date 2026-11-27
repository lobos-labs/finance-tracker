import * as db from '../db'
import { aiStatus } from '../ai/backend'
import { clearRequests, getRequest, listRequests } from '../ai/requestLog'
import { allowance } from '../allowance'
import { saveAttachment } from '../documents'
import { approvePendingAction, discardPendingAction, resetReview, reviewSend, reviewState, undoChange, unresolveIssue } from '../review'
import { changed, desktopOnly, hosted, refreshed } from './context'

// Review with the AI, its pending actions and undo, and what the AI has used:
// the allowance, its status, usage and the request log (read here; copying a
// request or a report to the clipboard is the desktop's, ipc.ts).

export const reviewHandlers = {
  getReview: hosted(() => reviewState()),
  reviewSend: hosted(async (ctx, text: string | null, attachments?: string[]) => {
    const r = await reviewSend(typeof text === 'string' ? text : null, (s) => ctx.broadcast('review:update', s), Array.isArray(attachments) ? attachments.map(String) : [])
    if (r.changed) {
      refreshed(ctx, undefined)
      ctx.calendarChanged()
    }
    return r.state
  }),
  // A file saved in the desktop's documents folder (the web uploads one and calls addDocument).
  reviewAttach: desktopOnly((ctx, name: string, data: Uint8Array) => {
    const saved = saveAttachment(String(name), Buffer.from(data instanceof Uint8Array ? data : []))
    // A new file in the documents folder: the Review page's document count moves.
    ctx.broadcast('review:update', reviewState())
    return saved
  }, 'documents'),
  reviewReset: hosted((ctx) => {
    resetReview()
    ctx.reviewCleared()
  }),
  approveAction: hosted((ctx, id: number) => {
    const r = refreshed(ctx, approvePendingAction(Number(id)))
    ctx.calendarChanged()
    return r
  }),
  discardAction: hosted((_c, id: number) => discardPendingAction(Number(id))),
  undoChange: hosted((ctx, id: number) => {
    const r = refreshed(ctx, undoChange(Number(id)))
    ctx.calendarChanged()
    return r
  }),
  unresolveIssue: hosted((ctx, key: string) => changed(ctx, unresolveIssue(String(key)))),
  deleteFact: hosted((ctx, id: number) => changed(ctx, db.deleteFact(id))),

  getAllowance: hosted(() => allowance()),
  aiStatus: hosted(() => aiStatus()),
  getAiUsage: hosted(() => db.aiUsageThisMonth()),
  listAiRequests: hosted(() => listRequests()),
  getAiRequest: hosted((_c, id: number) => getRequest(Number(id))),
  clearAiRequests: hosted(() => clearRequests())
}
