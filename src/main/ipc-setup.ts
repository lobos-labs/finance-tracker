import { app, BrowserWindow, dialog, shell } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import * as db from './db'
import * as csv from './csvImport'
import { isStatementFile, preview as statementPreview } from './statementImport'
import { sourceRunSuffix } from './build'
import { devBuild } from './devBuild'
import { creditReportPaths } from './credit'
import { DOCUMENT_TYPES, documentRoots, folderToAdopt, inDocumentRoots, isLocalPath } from './files'
import { insuranceFilePaths } from './insurance'
import { errorTag, log } from './log'
import { createDocumentFolders, docsDir, extraDocsDirs, legacyDocsDir, OTHER, setExtraDocsDirs } from './paths'
import { taxFormPaths } from './taxes'
import { APP_NAME, DOC_FOLDERS, type DocFolder } from '../shared/app'
import type { DropResult, ImportPreview } from '../shared/types'

// The folder model: the documents folder and the extra folders, and files
// dropped on the window. Registered from ipc.ts. (What the first-run wizard
// shows and records is the handler table's, handlers/data.ts.)

const DIR = 'documents.dir'
const MAX_BYTES = 50 * 1024 * 1024

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void
type Broadcast = (channel: string, payload?: unknown) => void

/** The documents folder is set by FINANCE_TRACKER_DOCS_DIR for this run, so it can't be changed here. */
export const docsDirLocked = (): boolean => !!process.env['FINANCE_TRACKER_DOCS_DIR']
const locked = docsDirLocked

/** A new install gets a visible folder under Documents; an older one keeps its dot-folder. Then the subfolders exist. */
export function ensureDocumentsDir(): void {
  if (!locked() && !db.getSetting(DIR)) db.setSetting(DIR, existsSync(legacyDocsDir()) ? legacyDocsDir() : join(app.getPath('documents'), `${APP_NAME}${sourceRunSuffix(app.isPackaged)}`))
  try {
    createDocumentFolders()
  } catch (err) {
    console.error('[documents]', err)
  }
}

async function setDocumentsDir(path: string | null): Promise<string | null> {
  if (locked()) throw new Error('The documents folder is set by FINANCE_TRACKER_DOCS_DIR for this run')
  let dir = typeof path === 'string' && path.trim() ? path.trim() : null
  if (!dir) {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { title: 'Documents folder', defaultPath: docsDir(), properties: ['openDirectory' as const, 'createDirectory' as const] }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return null
    dir = pick.filePaths[0]
  }
  if (!isAbsolute(dir)) throw new Error('The documents folder needs a full path')
  createDocumentFolders(dir)
  db.setSetting(DIR, dir)
  return dir
}

/** Allows another folder's documents (a dialog asks when no path is given); the list after, or null if cancelled. */
async function addDocumentFolder(path: string | null): Promise<string[] | null> {
  let dir = typeof path === 'string' && path.trim() ? path.trim() : null
  if (!dir) {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { title: 'Allow a document folder', defaultPath: app.getPath('documents'), properties: ['openDirectory' as const] }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return null
    dir = pick.filePaths[0]
  }
  if (!isLocalPath(dir)) throw new Error('A document folder needs a full path on this computer')
  if (!statSync(dir).isDirectory()) throw new Error('Not a folder')
  return setExtraDocsDirs([...extraDocsDirs(), dir])
}

function removeDocumentFolder(path: string): string[] {
  const key = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  return setExtraDocsDirs(extraDocsDirs().filter((d) => key(d) !== key(String(path))))
}

/** Every document path a page keeps: tax forms, credit reports, policy documents and receipts given as full paths. */
function storedDocumentPaths(): string[] {
  const receipts = db.all<{ receipt: string }>('SELECT DISTINCT receipt FROM transactions WHERE receipt IS NOT NULL').map((r) => r.receipt).filter((r) => isAbsolute(r))
  return [...taxFormPaths(), ...creditReportPaths(), ...insuranceFilePaths(), ...receipts]
}

/**
 * Development builds only: a document recorded before paths were confined
 * (forms kept in a folder on the Desktop, say) would now refuse to
 * open, so its folder is allowed once, automatically, and noted in the log.
 */
export function adoptDocumentFolders(): void {
  if (!devBuild()) return
  const bases = [app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads'), homedir()]
  const extra = extraDocsDirs()
  const added: string[] = []
  for (const p of storedDocumentPaths()) {
    if (!isLocalPath(p) || inDocumentRoots(resolve(p), [...documentRoots(), ...added])) continue
    const folder = folderToAdopt(p, bases)
    if (!folder) {
      log('documents', `${p} is outside the document folders and no folder of it could be adopted`)
      continue
    }
    added.push(folder)
    log('documents', `allowed ${folder} as a document folder, for ${p}`)
  }
  if (added.length) setExtraDocsDirs([...extra, ...added])
}

async function openDocumentFolder(sub?: string): Promise<void> {
  if (sub !== undefined && !(DOC_FOLDERS as readonly string[]).includes(sub)) throw new Error('Not a documents folder')
  createDocumentFolders()
  const err = await shell.openPath(sub ? join(docsDir(), sub as DocFolder) : docsDir())
  if (err) throw new Error(err)
}

const sha1 = (file: string): string => createHash('sha1').update(readFileSync(file)).digest('hex')

/** Copies dropped files into Other (originals stay put); a CSV, QFX, OFX or QIF becomes an import preview instead. */
function importDocuments(paths: string[]): DropResult {
  const out: DropResult = { saved: [], skipped: [], rejected: [], csv: null }
  const root = resolve(docsDir())
  const dir = join(root, OTHER)
  let preview: ImportPreview | null = null
  for (const p of Array.isArray(paths) ? paths.map(String) : []) {
    const name = basename(p)
    let size: number
    try {
      if (!isAbsolute(p) || !statSync(p).isFile()) throw new Error('not a file')
      size = statSync(p).size
    } catch {
      out.rejected.push(name)
      continue
    }
    const ext = extname(p).slice(1).toLowerCase()
    if (ext === 'csv' || isStatementFile(p)) {
      if (preview) out.rejected.push(name)
      else preview = ext === 'csv' ? csv.preview(p) : statementPreview(p)
      continue
    }
    if (!DOCUMENT_TYPES.includes(ext) || size > MAX_BYTES) {
      out.rejected.push(name)
      continue
    }
    if (resolve(p).startsWith(root + sep)) {
      out.skipped.push(name)
      continue
    }
    mkdirSync(dir, { recursive: true })
    const hash = sha1(p)
    const same = readdirSync(dir).find((f) => {
      const st = statSync(join(dir, f))
      return st.isFile() && st.size === size && sha1(join(dir, f)) === hash
    })
    if (same) {
      out.skipped.push(name)
      continue
    }
    const stem = name.slice(0, name.length - extname(name).length)
    const target = existsSync(join(dir, name)) ? `${stem}-${hash.slice(0, 8)}${extname(name)}` : name
    copyFileSync(p, join(dir, target))
    out.saved.push(`${OTHER}/${target}`)
  }
  out.csv = preview
  return out
}

export function registerSetupIpc(handle: Handle, broadcast: Broadcast): void {
  ensureDocumentsDir()
  try {
    adoptDocumentFolders()
  } catch (err) {
    console.error(`[documents] failed${errorTag(err)}`)
  }
  handle('setDocumentsDir', (path: string | null) => setDocumentsDir(path))
  handle('openDocumentFolder', (sub?: string) => openDocumentFolder(sub))
  handle('addDocumentFolder', async (path: string | null) => {
    const r = await addDocumentFolder(path)
    if (r) broadcast('data:changed')
    return r
  })
  handle('removeDocumentFolder', (path: string) => {
    const r = removeDocumentFolder(path)
    broadcast('data:changed')
    return r
  })
  handle('importDocuments', (paths: string[]) => {
    const r = importDocuments(paths)
    if (r.saved.length) broadcast('data:changed')
    return r
  })
}
