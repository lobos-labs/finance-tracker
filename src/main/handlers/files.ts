import * as db from '../db'
import * as csv from '../csvImport'
import { DOCUMENT_TYPES, isDocumentName } from '../files'
import * as statement from '../statementImport'
import { hosted, plus, type HandlerContext, type LedgerFile } from './context'

// Files the web uploads to the account (POST /v1/ledger/files), taken by id
// where the desktop takes a path: an import's preview and a document for the
// AI. (A receipt is attachReceipt's, in benefits.ts.)

/** The uploaded documents the AI may read, newest last: a setting, so no schema change comes with them. */
const UPLOADED = 'documents.uploaded'
const UPLOADED_MAX = 500

export interface UploadedDocument {
  fileId: string
  name: string
  type: string
  size: number
  addedAt: number
}

/** A file name's extension, lower case, without the dot. */
export const extOf = (name: string): string => {
  const m = /\.([^./\\]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/** How an uploaded file is named where a documents-folder path would be: "<fileId>/<name>" (GET /v1/ledger/files/ takes it). */
export const uploadRef = (f: Pick<LedgerFile, 'fileId' | 'name'>): string => `${f.fileId}/${f.name.replace(/[/\\]+/g, '_')}`

export function uploadedDocuments(): UploadedDocument[] {
  try {
    const list = JSON.parse(db.getSetting(UPLOADED) ?? '[]') as unknown
    return Array.isArray(list) ? (list as UploadedDocument[]) : []
  } catch {
    return []
  }
}

function addUploadedDocument(f: LedgerFile): void {
  const list = uploadedDocuments().filter((d) => d.fileId !== f.fileId)
  list.push({ fileId: f.fileId, name: f.name, type: f.type, size: f.size, addedAt: db.now() })
  db.setSetting(UPLOADED, JSON.stringify(list.slice(-UPLOADED_MAX)))
}

/** An upload's import preview: a statement file's or a CSV's; `kept` reads it again under the token it was first given. */
async function readPreview(f: LedgerFile, kept?: csv.KeptPreview): Promise<ReturnType<typeof csv.previewText> | ReturnType<typeof statement.previewBytes>> {
  const ext = extOf(f.name)
  if (statement.STATEMENT_TYPES.includes(ext)) return statement.previewBytes(f.name, await f.bytes(), kept)
  if (ext === 'csv' || ext === 'txt') return csv.previewText(f.name, new TextDecoder().decode(await f.bytes()), kept)
  throw new Error('Not a CSV, QFX, OFX or QIF file')
}

/**
 * Before an import by token: a preview this ledger no longer holds (its Durable Object restarted since
 * the preview) is read again from the upload the host kept for it, under the same token and time, so
 * it still expires ten minutes after it was first picked. With nothing kept, the import says to pick
 * the file again.
 */
export async function heldPreview(ctx: HandlerContext, token: unknown): Promise<void> {
  const t = typeof token === 'string' ? token : ''
  if (!t || !ctx.previews || csv.hasPreview(t) || statement.hasPreview(t)) return
  const kept = ctx.previews.find(t)
  if (!kept || Date.now() - kept.at > csv.PREVIEW_TTL_MS) return
  try {
    await readPreview(await ctx.file(kept.fileId), { token: t, at: kept.at })
  } catch {
    // The upload is gone or no longer reads: the import asks for the file again.
  }
}

export const fileHandlers = {
  importPreview: hosted(async (ctx, fileId: string) => {
    const f = await ctx.file(String(fileId))
    const preview = await readPreview(f)
    ctx.previews?.keep(preview.token, f.fileId, Date.now())
    return preview
  }),
  addDocument: plus('documents', async (ctx, fileId: string) => {
    const f = await ctx.file(String(fileId))
    if (!isDocumentName(f.name)) throw new Error(`A document can be ${DOCUMENT_TYPES.join(', ')}`)
    addUploadedDocument(f)
    ctx.broadcast('data:changed')
    return { ok: true as const }
  })
}
