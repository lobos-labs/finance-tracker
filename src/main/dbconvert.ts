import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { keyId, promoteNext, readKeyFile, writeFileDurably, writeKeyFile } from './dbkey'
import { isBackupName, timeStamp } from './backup'
import { copyKeyFileTo, KEY_FILE_NAME, keyFileId } from './dbsession'
import { copyDatabase, DatabaseSync, fileKind, flushFile, removeDbFiles } from './sqlite'

// Turning finance.db from a plain SQLite file into an encrypted one (or back,
// when a development build's switch is turned off, or onto a new key when a
// new recovery code replaced a saved one), with its backups. Every step is
// recorded in a marker file before the next begins, so a crash, a power cut or
// a full disk at any point leaves the data openable, and the next launch picks
// up where it stopped:
//
//   backup   a copy of the database as it is, beside it in the data folder
//            (finance.convert.pre; never the backups folder, which a Store
//            build keeps in the documents folder, often synced by OneDrive),
//            and a census of it: user_version, the schema and every table's
//            row count
//   copy     the database copied into the new form (finance.enc.tmp or
//            finance.plain.tmp), checked against the census (integrity_check
//            too) and flushed
//   swap     renamed over finance.db; the new file is checked again, and the
//            pre-conversion copy goes
//   backups  a fresh backup of the converted database in the backups folder,
//            then each of the app's backups converted the same way, one at a
//            time: one that can't be is removed when it's plaintext (the fresh
//            backup covers it) or else left and reported, never retried
//   cleanup  what the steps left removed, the marker removed, and last the
//            key file nothing is encrypted under any more (to plain), or the
//            old key's copies beside the backups (a new key)
//
// Until the swap the original is untouched: a failure removes what was made
// and leaves it as it was, and a conversion that stopped before its swap
// starts over at the next launch (the database may have been written in
// between, by a version of the app that ignores the marker). After the swap a
// failure leaves the marker, and the next launch finishes the backups. No
// Electron here (dbopen.ts runs it).

export type Format = 'plain' | 'encrypted'
/** What a conversion makes: a plain database, an encrypted one, or the encrypted one under the key file's waiting key. */
export type Target = Format | 'rekey'
export type Step = 'backup' | 'copy' | 'swap' | 'backups' | 'cleanup'

/** The places a crash is simulated in the tests, in the order they're reached ('key-promoted' only when rekeying). */
export const KILL_POINTS = ['marker-written', 'backup-written', 'copy-written', 'copy-verified', 'marker-swap', 'swapped', 'marker-backups', 'pre-backup-removed', 'fresh-backup', 'backup-file', 'backup-file-swapped', 'backups-done', 'key-promoted', 'marker-removed'] as const
export type KillPoint = (typeof KILL_POINTS)[number]

export interface Census {
  userVersion: number
  /** SHA-256 of sqlite_master, every object and its SQL */
  schema: string
  counts: Record<string, number>
}

export interface Marker {
  v: 1
  to: Target
  step: Step
  /** the database before it was converted (null: a marker rebuilt after damage, from the backups step on) */
  census: Census | null
  /** the fresh backup the backups step wrote first */
  fresh?: string
  /** the app's backups that could be neither converted nor removed */
  left?: string[]
  /** a new key: the old key's id (its copies beside the backups go at the end, unless a backup is left under it) */
  oldId?: string
}

export interface ConvertOptions {
  dbFile: string
  backupsDir: string
  /** the key file: it must hold the key the database is encrypted under (to encrypted, a new key); to plain it goes at the end */
  keyFile: string
  /** the database key: the target's (to encrypted) or the source's (to plain, a new key) */
  key: Uint8Array
  /** a new key: the key file's waiting key, the target's */
  newKey?: Uint8Array
  to: Target
  /** called where a crash could happen (the tests end the process there) */
  hook?: (point: KillPoint) => void
  log?: (line: string) => void
}

export interface ConvertResult {
  /** the backups converted */
  converted: number
  /** the app's backups that could be neither converted nor removed, by name (reported once) */
  left: string[]
}

/** A conversion that failed; `swapped`: finance.db is already in the new form (the backups are left for the next launch). */
export class ConversionError extends Error {
  readonly swapped: boolean
  constructor(cause: unknown, swapped: boolean) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ConversionError'
    this.swapped = swapped
  }
}

/** The files a conversion of `dbFile` uses beside it. */
export function conversionFiles(dbFile: string): { marker: string; encTmp: string; plainTmp: string; scratch: string; pre: string; restoreTmp: string } {
  const stem = dbFile.replace(/\.db$/i, '')
  return { marker: `${stem}.convert.json`, encTmp: `${stem}.enc.tmp`, plainTmp: `${stem}.plain.tmp`, scratch: `${stem}.convert.main`, pre: `${stem}.convert.pre`, restoreTmp: `${stem}.convert.restore` }
}

/** Where the first version of the conversion kept its pre-conversion copy (beside the backups) and its swap-restore copy; removed when found. */
export const preBackupName = (to: Format): string => (to === 'encrypted' ? 'pre-encrypt.db' : 'pre-decrypt.db')
const legacyRestoreTmp = (dbFile: string): string => `${dbFile}.restore.tmp`

const STEPS: readonly Step[] = ['backup', 'copy', 'swap', 'backups', 'cleanup']

export function readMarker(file: string): Marker | null {
  if (!existsSync(file)) return null
  let m: Marker
  try {
    m = JSON.parse(readFileSync(file, 'utf8')) as Marker
  } catch {
    throw new Error(`The conversion record ${file} is damaged; the database itself is untouched until a conversion swaps it`)
  }
  if (m?.v !== 1 || !['plain', 'encrypted', 'rekey'].includes(m.to) || !STEPS.includes(m.step)) throw new Error(`The conversion record ${file} is not one this app wrote`)
  return { v: 1, to: m.to, step: m.step, census: m.census ?? null, ...(typeof m.fresh === 'string' ? { fresh: m.fresh } : {}), ...(Array.isArray(m.left) ? { left: m.left.map(String) } : {}), ...(typeof m.oldId === 'string' && /^[0-9a-f]{32}$/.test(m.oldId) ? { oldId: m.oldId } : {}) }
}

export const writeMarker = (file: string, m: Marker): void => writeFileDurably(file, JSON.stringify(m))

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function census(d: DatabaseSync): Census {
  const objects = d.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  const counts: Record<string, number> = {}
  for (const o of objects) if (o.type === 'table') counts[o.name] = (d.prepare(`SELECT count(*) AS n FROM "${o.name.replace(/"/g, '""')}"`).get() as { n: number }).n
  const userVersion = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  return { userVersion, schema: createHash('sha256').update(JSON.stringify(objects)).digest('hex'), counts }
}

/** Opens `file` under `key`, runs SQLite's integrity check and compares the census (when there is one); throws on any difference. */
export function verifyCopy(file: string, key: Uint8Array | null, expected: Census | null): void {
  const d = new DatabaseSync(file, { readOnly: true, key })
  try {
    const check = (d.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check)
    if (check.length !== 1 || check[0] !== 'ok') throw new Error(`The converted copy fails SQLite's integrity check: ${check.slice(0, 3).join('; ')}`)
    if (!expected) return
    const got = census(d)
    if (got.userVersion !== expected.userVersion) throw new Error(`The converted copy is at schema version ${got.userVersion}, not ${expected.userVersion}`)
    if (got.schema !== expected.schema) throw new Error('The converted copy has a different schema')
    for (const [t, n] of Object.entries(expected.counts)) if (got.counts[t] !== n) throw new Error(`The converted copy has ${got.counts[t] ?? 0} rows in ${t}, not ${n}`)
    if (Object.keys(got.counts).length !== Object.keys(expected.counts).length) throw new Error('The converted copy has different tables')
  } finally {
    d.close()
  }
}

/** The source's write-ahead log folded in (a crashed app can leave one), then its census. Throws when another program has it open mid-transaction. */
function settle(file: string, key: Uint8Array | null): Census {
  const d = new DatabaseSync(file, { key })
  try {
    const r = d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number } | undefined
    if (r && (r.busy !== 0 || r.log !== r.checkpointed)) throw new Error('The database is in use by another program: its write-ahead log could not be folded in')
    return census(d)
  } finally {
    d.close()
  }
}

/** A database file and the rest of what one conversion left: its temporary copy and its scratch connection's file. */
function removeTemp(file: string): void {
  removeDbFiles(file)
  removeDbFiles(`${file}.main`)
}

/** Whether `key` (null: none) opens the file. */
function opens(file: string, key: Uint8Array | null): boolean {
  try {
    new DatabaseSync(file, { readOnly: true, key }).close()
    return true
  } catch {
    return false
  }
}

/** Whether any database file in the folder (a backup, or a copy put there) opens with `key`. */
function anyOpensWith(dir: string, key: Uint8Array): boolean {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  return names.some((n) => /\.db$/i.test(n) && fileKind(join(dir, n)) === 'other' && opens(join(dir, n), key))
}

/** Renames `from` over `to`; a read-only `to` (a backup copied back from a USB stick or OneDrive) is made writable and tried once more. */
function replaceFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') throw err
    chmodSync(to, 0o666)
    renameSync(from, to)
  }
}

/** Removes a database file (read-only or not) and its journal files; false when it can't be. */
function drop(file: string): boolean {
  try {
    if (existsSync(file)) chmodSync(file, 0o666)
    removeDbFiles(file)
    return !existsSync(file)
  } catch {
    return false
  }
}

/**
 * Converts the database (and the app's backups) to `to`, or finishes a
 * conversion the marker says was under way. Throws ConversionError; the
 * database stays openable either way (in the old form unless `swapped`).
 */
export function convertDatabase(o: ConvertOptions): ConvertResult {
  const f = conversionFiles(o.dbFile)
  const hook = o.hook ?? ((): void => {})
  const log = o.log ?? ((): void => {})
  const key = Buffer.from(o.key)
  const srcKey = o.to === 'encrypted' ? null : key
  const dstKey = o.to === 'plain' ? null : o.to === 'rekey' ? (o.newKey ? Buffer.from(o.newKey) : null) : key
  if (o.to === 'rekey' && !dstKey) throw new ConversionError('A new key is needed to move the database onto it', false)
  const tmp = dstKey ? f.encTmp : f.plainTmp
  const pres = [f.pre, ...(o.to === 'rekey' ? [] : [join(o.backupsDir, preBackupName(o.to))])]
  const started = Date.now()

  // In the form it's converted from, or to.
  const inSource = (file: string): boolean => (srcKey ? fileKind(file) === 'other' && opens(file, srcKey) : fileKind(file) === 'plain')
  const inTarget = (file: string): boolean => (dstKey ? fileKind(file) === 'other' && opens(file, dstKey) : fileKind(file) === 'plain')

  let m: Marker | null
  try {
    m = readMarker(f.marker)
  } catch (err) {
    throw new ConversionError(err, false)
  }
  if (m && m.to !== o.to) throw new ConversionError(`A conversion to ${m.to} is unfinished`, false)
  // Never encrypt under a key that no key file holds: nothing could open the data again.
  if (dstKey) {
    const id = keyId(dstKey)
    let held = false
    try {
      const kf = readKeyFile(o.keyFile)
      held = kf.id === id || kf.next?.id === id
    } catch {
      held = false
    }
    if (!held) throw new ConversionError(`The key file ${o.keyFile} doesn't hold the key the database would be encrypted under; nothing was changed`, false)
  }

  const removePre = (): void => {
    for (const p of pres) {
      removeDbFiles(p)
      removeTemp(`${p}.tmp`)
    }
    removeDbFiles(f.restoreTmp)
    removeDbFiles(legacyRestoreTmp(o.dbFile))
  }
  // Before the swap: on any failure, what was made goes and the original stays as it was.
  const rollBack = (): void => {
    removeTemp(tmp)
    removeDbFiles(f.scratch)
    removePre()
    rmSync(f.marker, { force: true })
  }

  // Stopped before the swap: the original is as it was then, or newer (written in between). Start over from it.
  if (m && (m.step === 'backup' || m.step === 'copy' || (m.step === 'swap' && inSource(o.dbFile)))) {
    log(`conversion to ${o.to} stopped at ${m.step}; starting over`)
    rollBack()
    m = null
  }
  const resumed = m?.step
  if (!m && !inSource(o.dbFile)) throw new ConversionError(`${o.dbFile} is not ${srcKey ? 'encrypted under this key' : 'a plain database'}`, false)

  try {
    if (!m) {
      m = { v: 1, to: o.to, step: 'backup', census: null, ...(o.to === 'rekey' ? { oldId: keyId(key) } : {}) }
      writeMarker(f.marker, m)
      hook('marker-written')
      removeTemp(tmp)
      const c = settle(o.dbFile, srcKey)
      copyDatabase(o.dbFile, srcKey, `${f.pre}.tmp`, srcKey, f.scratch)
      verifyCopy(`${f.pre}.tmp`, srcKey, c)
      flushFile(`${f.pre}.tmp`)
      renameSync(`${f.pre}.tmp`, f.pre)
      hook('backup-written')
      m = { ...m, step: 'copy', census: c }
      writeMarker(f.marker, m)
      copyDatabase(o.dbFile, srcKey, tmp, dstKey, f.scratch)
      hook('copy-written')
      verifyCopy(tmp, dstKey, c)
      flushFile(tmp)
      hook('copy-verified')
      m = { ...m, step: 'swap' }
      writeMarker(f.marker, m)
      hook('marker-swap')
    }
  } catch (err) {
    rollBack()
    log(`conversion to ${o.to} failed before the swap, nothing changed: ${message(err)}`)
    throw new ConversionError(err, false)
  }

  if (m.step === 'swap') {
    try {
      if (!inTarget(o.dbFile)) {
        if (!existsSync(tmp)) throw new Error('The converted copy is missing')
        if (resumed === 'swap') verifyCopy(tmp, dstKey, m.census)
        // The source's log was folded in and it was closed: its -wal and -shm (if any) hold nothing.
        rmSync(`${o.dbFile}-wal`, { force: true })
        rmSync(`${o.dbFile}-shm`, { force: true })
        renameSync(tmp, o.dbFile)
      }
      hook('swapped')
      verifyCopy(o.dbFile, dstKey, m.census)
    } catch (err) {
      // The original is either still in place (the rename didn't happen) or comes back from the pre-conversion copy.
      try {
        if (!inSource(o.dbFile)) {
          const pre = pres.find((p) => existsSync(p))
          if (!pre) throw new Error('The pre-conversion copy is missing')
          verifyCopy(pre, srcKey, m.census)
          removeDbFiles(f.restoreTmp)
          copyDatabase(pre, srcKey, f.restoreTmp, srcKey, f.scratch)
          flushFile(f.restoreTmp)
          rmSync(`${o.dbFile}-wal`, { force: true })
          rmSync(`${o.dbFile}-shm`, { force: true })
          renameSync(f.restoreTmp, o.dbFile)
        }
      } catch (restoreErr) {
        // Neither the original nor its copy could be put back: keep everything as it is for a person to look at.
        log(`conversion to ${o.to}: the swap failed and the original could not be put back: ${message(restoreErr)}`)
        throw new ConversionError(err, false)
      }
      rollBack()
      log(`conversion to ${o.to} failed at the swap; the original is in place: ${message(err)}`)
      throw new ConversionError(err, false)
    }
  }

  // After the swap: a failure leaves the marker, and the next launch carries on.
  let converted = 0
  let left: string[] = []
  try {
    if (m.step === 'swap') {
      m = { ...m, step: 'backups' }
      writeMarker(f.marker, m)
      hook('marker-backups')
    }
    if (m.step === 'backups') {
      // finance.db is checked in its new form: the copy of it as it was (plaintext, converting to encrypted) goes now.
      removePre()
      hook('pre-backup-removed')
      if (m.fresh === undefined) {
        let fresh = ''
        try {
          fresh = freshBackup(o.dbFile, dstKey, o.backupsDir, m.census, f.scratch)
        } catch (err) {
          log(`conversion to ${o.to}: no fresh backup (${message(err)})`)
        }
        m = { ...m, fresh }
        writeMarker(f.marker, m)
        hook('fresh-backup')
      }
      const r = convertBackups(o.backupsDir, srcKey, dstKey, hook, log)
      converted = r.converted
      m = { ...m, step: 'cleanup', left: r.left }
      writeMarker(f.marker, m)
      hook('backups-done')
      log(`converted ${converted} backup${converted === 1 ? '' : 's'} to ${o.to}${r.left.length ? `; left as they were: ${r.left.join(', ')}` : ''}`)
    }
    if (m.step === 'cleanup') {
      removePre()
      removeTemp(f.encTmp)
      removeTemp(f.plainTmp)
      removeDbFiles(f.scratch)
      sweepBackups(o.backupsDir)
      if (o.to === 'rekey' && dstKey) {
        // The database and its backups are under the new key: it takes the old one's place in the key file.
        const kf = readKeyFile(o.keyFile)
        if (kf.next?.id === keyId(dstKey)) {
          writeKeyFile(o.keyFile, promoteNext(kf))
          hook('key-promoted')
        }
        // The old key's copies beside the backups go with it, unless a backup is left under it.
        const oldId = m.oldId ?? keyId(key)
        if (!(m.left ?? []).length && oldId !== keyId(dstKey)) removeKeyFilesFor(o.backupsDir, oldId)
      }
      if (dstKey) copyKeyFileTo(o.backupsDir, o.keyFile)
      left = m.left ?? []
      rmSync(f.marker, { force: true })
      hook('marker-removed')
      if (o.to === 'plain') {
        // Last, once the marker is gone (a key file missing under a marker reads as an encrypted database without its key):
        // nothing is encrypted under the key any more, so its key file goes, here and beside the backups.
        try {
          if (!anyOpensWith(o.backupsDir, key)) {
            removeKeyFilesFor(o.backupsDir, keyId(key))
            if (keyFileId(o.keyFile) === keyId(key)) rmSync(o.keyFile, { force: true })
          }
        } catch (err) {
          log(`conversion to plain: the key file stays (${message(err)})`)
        }
      }
    }
  } catch (err) {
    log(`conversion to ${o.to}: finishing the backups failed, the next launch carries on: ${message(err)}`)
    throw new ConversionError(err, true)
  }
  log(`database converted to ${o.to} in ${Date.now() - started} ms`)
  return { converted, left }
}

/** The key files in `dir` for the key `id`: finance.key, and one set aside as finance-<id>.key. */
function removeKeyFilesFor(dir: string, id: string): void {
  for (const p of [join(dir, KEY_FILE_NAME), join(dir, `finance-${id.slice(0, 8)}.key`)]) if (keyFileId(p) === id) rmSync(p, { force: true })
}

/** A backup of the converted database, in its new form, before the old backups are touched; its name. */
function freshBackup(dbFile: string, key: Uint8Array | null, dir: string, expected: Census | null, scratch: string): string {
  mkdirSync(dir, { recursive: true })
  const name = `bulk-${timeStamp(new Date())}.db`
  const file = join(dir, name)
  const tmp = `${file}.tmp`
  try {
    copyDatabase(dbFile, key, tmp, key, scratch)
    verifyCopy(tmp, key, expected)
    flushFile(tmp)
    renameSync(tmp, file)
  } catch (err) {
    removeDbFiles(tmp)
    throw err
  }
  return name
}

/** One backup converted from `from` to `to` (null: plain), checked against its own census, flushed and swapped in. */
function convertFile(file: string, from: Uint8Array | null, to: Uint8Array | null, hook: (p: KillPoint) => void): void {
  const tmp = `${file}.convert.tmp`
  const d = new DatabaseSync(file, { readOnly: true, key: from })
  let c: Census
  try {
    c = census(d)
  } finally {
    d.close()
  }
  copyDatabase(file, from, tmp, to, `${tmp}.main`)
  verifyCopy(tmp, to, c)
  flushFile(tmp)
  hook('backup-file')
  replaceFile(tmp, file)
  hook('backup-file-swapped')
}

/**
 * Converts each of the app's backups that's still in the old form, each on its own: one that fails
 * doesn't stop the others. A plaintext one that can't be encrypted (damaged, read-only, in use) is
 * removed once a backup in the new form is there; what can be neither converted nor removed is left
 * and named.
 */
function convertBackups(dir: string, srcKey: Buffer | null, dstKey: Buffer | null, hook: (p: KillPoint) => void, log: (line: string) => void): ConvertResult {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { converted: 0, left: [] }
  }
  let converted = 0
  let inNewForm = 0
  const failed: Array<{ name: string; plain: boolean }> = []
  for (const name of names.filter(isBackupName).sort()) {
    const file = join(dir, name)
    let plain = false
    try {
      if (!statSync(file).isFile()) continue
      const kind = fileKind(file)
      if (kind === 'missing') continue
      plain = kind === 'plain'
      if (dstKey ? !plain && opens(file, dstKey) : plain) {
        inNewForm++
        continue
      }
      // A plain one is encrypted (or moved onto the new key) as it is; an encrypted one opens with this install's key or isn't this install's.
      if (!plain && (!srcKey || !opens(file, srcKey))) {
        log(`backup ${name} is encrypted under another key; left as it is`)
        continue
      }
      convertFile(file, plain ? null : srcKey, dstKey, hook)
      converted++
      inNewForm++
    } catch (err) {
      removeTemp(`${file}.convert.tmp`)
      log(`backup ${name} could not be converted: ${message(err)}`)
      failed.push({ name, plain })
    }
  }
  const left: string[] = []
  for (const { name, plain } of failed) {
    if (plain && dstKey && inNewForm > 0 && drop(join(dir, name))) {
      log(`backup ${name} removed: a plaintext copy that could not be encrypted`)
      continue
    }
    left.push(name)
  }
  return { converted, left }
}

/** Leftovers of a backup conversion a crash interrupted, and of a backup a crash cut short (the app's own names only). */
function sweepBackups(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) if (/\.convert\.tmp(\.main)?(-wal|-shm|-journal)?$/.test(name) || /^(pre-v\d+|daily|bulk)-\d{8}(-\d{6})?\.db\.tmp(-wal|-shm|-journal)?$/.test(name)) drop(join(dir, name))
}
