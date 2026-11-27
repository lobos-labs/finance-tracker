import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { HOME_DIR_NAME } from './build'
import { getSetting, setSetting } from './db'
import { DOC_FOLDERS } from '../shared/app'

// Statements, paystubs, receipts and the like that the user drops in for the
// assistant to read. New installs get a visible folder under Documents (chosen
// and recorded by setup, see ipc-setup.ts); installs from before that keep the
// old dot-folder in the home directory, outside OneDrive. The user can allow
// other folders too (documents.extraDirs): stored documents there open, but
// only the documents folder is watched for new ones.

/** The documents folder before it had a setting: hidden in the home folder (a build with its own data folder has its own, which never existed). */
export function legacyDocsDir(): string {
  return join(homedir(), HOME_DIR_NAME, 'documents')
}

/** The setting is read only when the database is open; the review's tool server gets the path by environment instead. */
function savedDocsDir(): string | null {
  try {
    return getSetting('documents.dir')
  } catch {
    return null
  }
}

/** This run's override, else the folder the user chose, else the old folder. */
export function docsDir(): string {
  return process.env['FINANCE_TRACKER_DOCS_DIR'] || savedDocsDir() || legacyDocsDir()
}

const EXTRA = 'documents.extraDirs'

/** Folders besides the documents folder whose documents the app may open and index. */
export function extraDocsDirs(): string[] {
  try {
    const list = JSON.parse(getSetting(EXTRA) ?? '[]') as unknown
    return Array.isArray(list) ? list.map(String).filter((d) => d && isAbsolute(d)) : []
  } catch {
    return []
  }
}

/** Replaces the list of extra folders (full paths, each once); returns it as stored. */
export function setExtraDocsDirs(dirs: string[]): string[] {
  const seen = new Set<string>()
  const clean: string[] = []
  for (const d of dirs) {
    const given = String(d).trim()
    if (!given || !isAbsolute(given)) continue
    const full = resolve(given)
    const key = process.platform === 'win32' ? full.toLowerCase() : full
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(full)
  }
  setSetting(EXTRA, JSON.stringify(clean))
  return clean
}

/** Receipts attached to health costs, inside the documents folder. */
export const RECEIPTS = 'Receipts'

/** Where dropped files land until they're filed. */
export const OTHER = 'Other'

/** Makes the documents folder and its subfolders (safe to call again). */
export function createDocumentFolders(dir = docsDir()): void {
  for (const sub of DOC_FOLDERS) mkdirSync(join(dir, sub), { recursive: true })
}
