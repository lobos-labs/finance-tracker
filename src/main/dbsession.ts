import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseKeyFile, writeFileDurably } from './dbkey'

// This process's database key and key file, once dbopen.ts has opened an
// encrypted database: what backups, restores, a new recovery code and the
// review's tool server (its environment, development builds) need. Nothing
// here is written to the disk except the key file's copies, which hold the
// key only sealed, and a note of the folder the copy went to.

export const KEY_FILE_NAME = 'finance.key'
/** Beside the key file: the folder its copy was last put in (a Store build's backups folder is a setting in the database, unreadable before it opens). */
export const KEY_COPY_NOTE = 'finance.key-copy.json'

interface Session {
  key: Buffer
  keyFile: string
}

let session: Session | null = null

export function setSession(s: Session | null): void {
  // The old key's bytes go from memory (a copy handed out earlier lives until it's collected).
  session?.key.fill(0)
  session = s ? { key: Buffer.from(s.key), keyFile: s.keyFile } : null
}

/** The open database's key; null when it's a plain file. */
export const sessionKey = (): Buffer | null => (session ? Buffer.from(session.key) : null)

export const sessionKeyFile = (): string | null => session?.keyFile ?? null

/** The key as the review's tool server takes it (FINANCE_DB_KEY, 64 hex characters); null when the database is plain. */
export const sessionKeyHex = (): string | null => session?.key.toString('hex') ?? null

/** The id inside a key file, or null when it isn't one. */
export function keyFileId(file: string): string | null {
  try {
    return parseKeyFile(readFileSync(file, 'utf8')).id
  } catch {
    return null
  }
}

/** The folder the key file's copy was last put in (KEY_COPY_NOTE), or null. */
export function recordedKeyCopyDir(keyFile: string): string | null {
  try {
    const dir = (JSON.parse(readFileSync(join(dirname(keyFile), KEY_COPY_NOTE), 'utf8')) as { dir?: unknown }).dir
    return typeof dir === 'string' && dir ? dir : null
  } catch {
    return null
  }
}

/**
 * Puts a copy of the key file in `dir` as finance.key (the backups folder),
 * unless the same one is there. A key file there for another key is renamed
 * finance-<id>.key first, so the backups it opens still have it beside them.
 * The folder is noted beside the key file, where it can be read before the database opens.
 */
export function copyKeyFileTo(dir: string, keyFile = session?.keyFile): void {
  if (!keyFile || !existsSync(keyFile)) return
  const dest = join(dir, KEY_FILE_NAME)
  if (resolve(dest) === resolve(keyFile)) return
  const text = readFileSync(keyFile)
  if (!existsSync(dest) || !readFileSync(dest).equals(text)) {
    if (existsSync(dest)) {
      const theirs = keyFileId(dest)
      const mine = keyFileId(keyFile)
      if (theirs && theirs !== mine) renameSync(dest, join(dir, `finance-${theirs.slice(0, 8)}.key`))
    }
    mkdirSync(dir, { recursive: true })
    writeFileDurably(dest, text)
  }
  // Noted once the copy is there.
  if (recordedKeyCopyDir(keyFile) !== resolve(dir)) writeFileDurably(join(dirname(keyFile), KEY_COPY_NOTE), `${JSON.stringify({ dir: resolve(dir) })}\n`)
}
