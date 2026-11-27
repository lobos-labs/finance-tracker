import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import * as db from './db'
import { fileFound, isDocumentName } from './files'
import { docsDir, RECEIPTS } from './paths'

// Receipts for health costs live in the documents folder's Receipts folder, so
// the assistant can read them too. Picking or dropping a file copies it there
// under a name that says what it covers; the original stays where it was.

export const RECEIPT_TYPES = ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'webp', 'gif', 'tif', 'tiff', 'txt', 'eml', 'htm', 'html', 'doc', 'docx']
const MAX_BYTES = 50 * 1024 * 1024

// Stored document paths (credit reports, policy documents) pass the one rule in files.ts.
export { isOpenableDocument as isLocalDocument } from './files'

/** A documents-folder path ("Receipts/x.pdf") as a full path; nothing outside the folder. */
export function receiptPath(name: string): string {
  const root = resolve(docsDir())
  const full = resolve(root, name)
  if (!full.startsWith(root + sep)) throw new Error('That file is outside the documents folder')
  return full
}

export function receiptExists(name: string): boolean {
  try {
    return fileFound(receiptPath(name))
  } catch {
    return false
  }
}

/** The receipt of each transaction as stored (for a journal). */
export const receiptFields = (ids: string[]): Array<{ id: string; receipt: string | null }> =>
  ids.flatMap((id) => {
    const r = db.get<{ receipt: string | null }>('SELECT receipt FROM transactions WHERE id = ?', id)
    return r ? [{ id, receipt: r.receipt }] : []
  })

const fileSafe = (s: string): string =>
  s
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)

const digest = (file: string): string => createHash('sha1').update(readFileSync(file)).digest('hex')

/** Who and when a set of costs covers: "Dr Example", "2026-08-13 to 2026-08-27". */
function span(rows: Array<{ posted: number; merchant: string | null; description: string }>): { what: string; when: string } {
  const days = rows.map((t) => db.dayKey(t.posted)).sort()
  const payees = [...new Set(rows.map((t) => t.merchant || t.description))]
  return {
    what: payees.length === 1 ? fileSafe(payees[0]) || 'Health cost' : 'Health costs',
    when: days[0] === days[days.length - 1] ? days[0] : `${days[0]} to ${days[days.length - 1]}`
  }
}

/** What a receipt covers, from every cost linked to it. */
export function receiptSummary(name: string): string {
  const rows = db.all<{ posted: number; merchant: string | null; description: string }>('SELECT posted, merchant, description FROM transactions WHERE receipt = ?', name)
  if (!rows.length) return 'Receipt'
  const { what, when } = span(rows)
  return `Receipt for ${rows.length} health cost${rows.length === 1 ? '' : 's'}: ${what}, ${when}`
}

const linkedTo = (ids: string[]): string[] =>
  ids.length ? db.all<{ receipt: string }>(`SELECT DISTINCT receipt FROM transactions WHERE receipt IS NOT NULL AND id IN (${ids.map(() => '?').join(', ')})`, ...ids).map((r) => r.receipt) : []

/** Links costs to a receipt (null unlinks), keeping the summaries of receipts the app filed current. Only a document can be a receipt. */
export function linkReceipt(ids: string[], file: string | null): number {
  if (file !== null && !isDocumentName(file)) throw new Error(`A receipt can be ${RECEIPT_TYPES.join(', ')}`)
  const before = linkedTo(ids)
  const n = db.setReceipt(ids, file)
  for (const f of new Set(file ? [...before, file] : before)) {
    if (f.startsWith(`${RECEIPTS}/`) && receiptExists(f)) db.markDocument(f, statSync(receiptPath(f)).size, receiptSummary(f))
  }
  return n
}

/** Links a receipt to the costs it covers, copying it into the documents folder first; returns its documents-folder path. */
export function importReceipt(ids: string[], source: string): string {
  const rows = ids.map((id) => db.getTransaction(id)).filter((t): t is NonNullable<typeof t> => t !== null)
  if (!rows.length) throw new Error('Pick the costs this receipt covers')
  const ext = extname(source).slice(1).toLowerCase()
  if (!RECEIPT_TYPES.includes(ext)) throw new Error(`A receipt can be ${RECEIPT_TYPES.join(', ')}`)
  const size = statSync(source).size
  if (size > MAX_BYTES) throw new Error('That file is over 50 MB')

  // A file already in the documents folder is linked where it is, and one
  // already copied into Receipts is linked to that copy.
  const root = resolve(docsDir())
  const dir = join(root, RECEIPTS)
  let rel: string
  if (resolve(source).startsWith(root + sep)) rel = relative(root, resolve(source)).split(sep).join('/')
  else {
    mkdirSync(dir, { recursive: true })
    const hash = digest(source)
    const same = readdirSync(dir).find((f) => statSync(join(dir, f)).size === size && digest(join(dir, f)) === hash)
    if (same) rel = `${RECEIPTS}/${same}`
    else {
      const { what, when } = span(rows)
      let file = `${when} ${what}.${ext}`
      for (let i = 2; existsSync(join(dir, file)); i++) file = `${when} ${what} (${i}).${ext}`
      copyFileSync(source, join(dir, file))
      rel = `${RECEIPTS}/${file}`
    }
  }
  linkReceipt(rows.map((t) => t.id), rel)
  // Matched to its costs already, so it doesn't come up as a new document to review.
  db.markDocument(rel, size, receiptSummary(rel))
  return rel
}
