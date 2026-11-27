import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, fileKind, flushFile, removeDbFiles } from './sqlite'
import { backupTo, checkBackupCopy, dbEncrypted, LATEST_SCHEMA_VERSION } from './db'
import { copyKeyFileTo } from './dbsession'

// Copies of finance.db in the backups folder, consistent while the app and
// the review's tool server have the database open (sqlite.ts: SQLite's online
// backup for a plain database, VACUUM INTO for an encrypted one, which stays
// encrypted under the same key): before a schema upgrade, once a day, and
// before a bulk rewrite. An encrypted install keeps a copy of its key file
// (finance.key, which holds the key only sealed) beside them (dbopen.ts).

export const KEEP = { pre: 3, daily: 7, bulk: 3 } as const
export type BackupFamily = keyof typeof KEEP

const BACKUP_FILE = /^(pre-v\d+|daily|bulk)-(\d{8})(?:-(\d{6}))?\.db$/

const pad = (n: number): string => String(n).padStart(2, '0')
export const dayStamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
export const timeStamp = (d: Date): string => `${dayStamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/** One of the app's own backup files (not a copy the user put in the folder). */
export const isBackupName = (name: string): boolean => BACKUP_FILE.test(name)

function familyOf(name: string): BackupFamily | null {
  const m = BACKUP_FILE.exec(name)
  if (!m) return null
  return m[1].startsWith('pre-v') ? 'pre' : (m[1] as BackupFamily)
}

const stampOf = (name: string): string => {
  const m = BACKUP_FILE.exec(name)!
  return m[2] + (m[3] ?? '')
}

/** One family's backups in the folder, oldest first (by the time in the name). */
export function listBackups(dir: string, family: BackupFamily): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => familyOf(n) === family).sort((a, b) => stampOf(a).localeCompare(stampOf(b)))
}

/** Writes the open database to <dir>/<name>, then drops the oldest of its family beyond `keep` (null: drops nothing). Returns the path. */
export async function writeBackup(dir: string, name: string, keep: number | null): Promise<string> {
  const family = familyOf(name)
  if (!family) throw new Error(`Not a backup name: ${name}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  const tmp = `${path}.tmp`
  // Written beside its final name, flushed (VACUUM INTO never syncs), read back, and only then renamed and
  // the oldest dropped: a crash or a power cut can't leave a torn copy in place of a good one.
  try {
    await backupTo(tmp)
    flushFile(tmp)
    // A copy made before a schema upgrade or a bulk rewrite (a restore's safety copy among them) is checked whole.
    checkBackupCopy(tmp, family !== 'daily')
    renameSync(tmp, path)
  } catch (err) {
    removeDbFiles(tmp)
    throw err
  }
  // An encrypted backup opens elsewhere only with the key file (and the recovery code).
  if (dbEncrypted()) copyKeyFileTo(dir)
  if (keep !== null) for (const old of listBackups(dir, family).slice(0, -keep)) rmSync(join(dir, old), { force: true })
  return path
}

export function backupBeforeMigration(dir: string, fromVersion: number, at = new Date()): Promise<string> {
  return writeBackup(dir, `pre-v${fromVersion}-${timeStamp(at)}.db`, KEEP.pre)
}

/** Today's backup, once a day; null when it's already there. */
export function dailyBackup(dir: string, at = new Date()): Promise<string | null> {
  const name = `daily-${dayStamp(at)}.db`
  if (listBackups(dir, 'daily').includes(name)) return Promise.resolve(null)
  return writeBackup(dir, name, KEEP.daily)
}

/** How often a running app looks whether today's backup is there. */
export const DAILY_CHECK_EVERY_MS = 3600_000

/**
 * Makes today's backup now, and looks again every hour: the app stays running for days (in the window or the tray),
 * so a look at launch alone is not once a day. `ready` says the database is open (after Delete all data it is not,
 * and a look then would make the folder again); `failed` hears each failure, `first` when the look before it had
 * worked. An idle look is one folder listing. Returns what stops it.
 */
export function keepDailyBackups(o: { dir: () => string; ready: () => boolean; failed: (err: unknown, first: boolean) => void; now?: () => Date }): () => void {
  let failing = false
  const look = (): void => {
    if (!o.ready()) return
    Promise.resolve()
      .then(() => dailyBackup(o.dir(), o.now?.()))
      .then(
        () => {
          failing = false
        },
        (err) => {
          const first = !failing
          failing = true
          o.failed(err, first)
        }
      )
  }
  look()
  const timer = setInterval(look, DAILY_CHECK_EVERY_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function bulkBackup(dir: string, at = new Date()): Promise<string> {
  return writeBackup(dir, `bulk-${timeStamp(at)}.db`, KEEP.bulk)
}

/**
 * The safety copy made before a backup is restored. It drops nothing: the backup being restored may be the oldest
 * in this folder, and it is still to be read. The next bulk backup brings the family back to KEEP.bulk.
 */
export function backupBeforeRestore(dir: string, at = new Date()): Promise<string> {
  return writeBackup(dir, `bulk-${timeStamp(at)}.db`, null)
}

/**
 * Throws unless the file is a sound SQLite database this version of the app can open: a plain one, or
 * one encrypted under `key` (null: plain only; left out: the test run's default, sqlite.ts).
 */
export function checkBackupFile(file: string, key?: Uint8Array | null): void {
  const kind = fileKind(file)
  if (kind === 'missing') throw new Error('Not a SQLite database file')
  let d: DatabaseSync
  try {
    d = new DatabaseSync(file, { readOnly: true, key: kind === 'plain' ? null : key })
  } catch {
    throw new Error(kind === 'plain' ? 'Not a SQLite database file' : 'Not a SQLite database file, or encrypted under another key')
  }
  try {
    const version = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > LATEST_SCHEMA_VERSION) throw new Error(`The backup is at schema version ${version}, newer than this version of the app knows (${LATEST_SCHEMA_VERSION})`)
    const check = (d.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    if (check !== 'ok') throw new Error(`The backup fails SQLite's integrity check: ${check}`)
  } finally {
    d.close()
  }
}
