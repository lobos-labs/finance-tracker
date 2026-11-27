import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { createKeyFile, createSeals, KeyFileError, keyEntries, keyId, newDbKey, newRecoveryCode, readKeyFile, resealedHere, unwrapWithCode, unwrapWithKeystore, withKeystore, withRecovery, writeFileDurably, writeKeyFile, type KdfParams, type KeyFile, type KeySeals, type Keystore } from './dbkey'
import { ConversionError, conversionFiles, convertDatabase, readMarker, writeMarker, type Format, type KillPoint, type Marker, type Target } from './dbconvert'
import { copyKeyFileTo, KEY_FILE_NAME, recordedKeyCopyDir, sessionKey, sessionKeyFile, setSession } from './dbsession'
import { DatabaseSync, fileKind, removeDbFiles } from './sqlite'

// Which form finance.db is opened in, and getting its key. A packaged build
// keeps it encrypted: a new install from the first launch, an older plain one
// converted once at startup (dbconvert.ts). A development build (the
// unpackaged app, whose review tool server opens the same file) keeps it plain
// unless Settings → Data → Encrypted is on; that switch lives in a small file
// beside the database (encryption.json), since it's read before the database
// opens, and only a switch set off decrypts (without the file, the database
// stays in whatever form it is). The key comes from the key file through the
// OS keystore or the account seal, or, on another computer or account,
// through the recovery code. A key file holding a waiting key (a new recovery
// code replaced a saved one) moves the database onto it. No Electron here.

export const SWITCH_FILE_NAME = 'encryption.json'

export interface DbFiles {
  dbFile: string
  keyFile: string
  switchFile: string
  backupsDir: string
}

export function dbFiles(dataDir: string, backupsDir: string): DbFiles {
  return { dbFile: join(dataDir, 'finance.db'), keyFile: join(dataDir, KEY_FILE_NAME), switchFile: join(dataDir, SWITCH_FILE_NAME), backupsDir }
}

/** A development build's "Encrypted" switch: on or off as set; null when it was never set (or can't be read). */
export function readEncryptSwitch(file: string): boolean | null {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { encrypt?: unknown }).encrypt
    return v === true ? true : v === false ? false : null
  } catch {
    return null
  }
}

export function writeEncryptSwitch(file: string, on: boolean): void {
  writeFileDurably(file, `${JSON.stringify({ encrypt: on })}\n`)
}

/** A packaged build is always encrypted; a development build as its switch says, and null (as it is) when the switch was never set. */
export const wantedFormat = (packaged: boolean, switchOn: boolean | null): Format | null => (packaged || switchOn === true ? 'encrypted' : switchOn === false ? 'plain' : null)

/** The user closed the recovery-code window instead of entering a code. */
export class UnlockCancelled extends Error {
  constructor() {
    super('No recovery code was entered')
    this.name = 'UnlockCancelled'
  }
}

export interface PrepareOptions {
  files: DbFiles
  packaged: boolean
  keystore: Keystore
  /**
   * Asks for the recovery code (the key file was sealed for another computer
   * or account): resolves once `tryCode` accepts one, and rejects with
   * UnlockCancelled when the user gives up. `tryCode` throws on a wrong code.
   */
  askCode: (tryCode: (code: string) => Promise<void>) => Promise<void>
  /**
   * The backups folder once the key is known, when it can't be named before the database opens (a Store
   * build keeps it in the documents folder, whose path is a setting in the database: peekSetting). Without
   * it, files.backupsDir.
   */
  backupsDirFor?: (key: Buffer | null) => string
  /** scrypt settings for a new key file's recovery wrap (the tests make them light) */
  kdf?: KdfParams
  hook?: (point: KillPoint) => void
  log?: (line: string) => void
}

export interface Prepared {
  /** the key to open finance.db with; null: it's a plain file */
  key: Buffer | null
  /** a conversion that failed this time (the database opens as it was, or the backups wait for the next launch) */
  conversionError: ConversionError | null
  /** the app's backups a conversion could neither convert nor remove (said once) */
  left: string[]
  /** the backups folder the conversion used */
  backupsDir: string
}

const formatOf = (kind: ReturnType<typeof fileKind>): Format | null => (kind === 'missing' ? null : kind === 'plain' ? 'plain' : 'encrypted')
const formatTo = (to: Target): Format => (to === 'plain' ? 'plain' : 'encrypted')
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What a conversion leaves beside the database (not the database), removed: a conversion that can't go on starts over later. */
function clearConversion(dbFile: string): void {
  const f = conversionFiles(dbFile)
  for (const p of [f.encTmp, f.plainTmp, f.scratch, f.pre, f.restoreTmp, `${f.encTmp}.main`, `${f.plainTmp}.main`, `${f.pre}.tmp`]) removeDbFiles(p)
  rmSync(f.marker, { force: true })
}

/** Whether the key file names this key (as its own or its waiting one). */
function keyFileHolds(keyFile: string, key: Uint8Array | null): boolean {
  if (!key) return false
  try {
    return keyEntries(readKeyFile(keyFile)).some((s) => s.id === keyId(key))
  } catch {
    return false
  }
}

/** Gets the database ready to open: the key found (or made), an unfinished conversion finished, and a conversion run when the build wants the other form. */
export async function prepareDatabase(o: PrepareOptions): Promise<Prepared> {
  const { dbFile, keyFile } = o.files
  const log = o.log ?? ((): void => {})
  const f = conversionFiles(dbFile)
  let have = formatOf(fileKind(dbFile))
  const desired = wantedFormat(o.packaged, readEncryptSwitch(o.files.switchFile))
  let marker: Marker | null = null
  let markerDamaged = false
  try {
    marker = readMarker(f.marker)
  } catch (err) {
    markerDamaged = true
    log(message(err))
  }
  let want: Format = desired ?? (marker ? formatTo(marker.to) : have) ?? 'plain'
  if (markerDamaged) {
    // The step is read from the database itself: already in the form wanted, only its backups may be left;
    // otherwise the swap never happened, and the conversion starts over (a waiting key decides for itself below).
    let waiting = false
    try {
      waiting = !!readKeyFile(keyFile).next
    } catch {
      waiting = false
    }
    if (!waiting && have !== null && have === want) {
      marker = { v: 1, to: want, step: 'backups', census: null }
      writeMarker(f.marker, marker)
    } else clearConversion(dbFile)
  }
  if (want === 'encrypted' && have !== 'encrypted' && !marker && !o.keystore.available()) {
    // A key only the recovery code opens would be asked for at every launch.
    log('no OS keystore: the database stays plain')
    want = 'plain'
  }
  const existed = have !== null

  let key: Buffer | null = null
  let next: Buffer | null = null
  if (want === 'encrypted' || have === 'encrypted' || marker) {
    try {
      const got = await obtainKey(o, { have, marker: !!marker, create: want === 'encrypted' && have !== 'encrypted' && !marker })
      key = got?.key ?? null
      next = got?.next ?? null
    } catch (err) {
      if (err instanceof UnlockCancelled || have === 'encrypted') throw err
      // A plain database opens without a key: as it is for this launch (a conversion it was in the middle of
      // waits: before its swap nothing changed; after it, finance.db is checked plain).
      log(`no database key, the database opens as it is: ${message(err)}`)
      if (marker) clearConversion(dbFile)
      marker = null
      want = 'plain'
    }
  }
  const opening = have === 'encrypted' ? ([key, next].find((k) => k && opensWith(dbFile, k)) ?? key) : null
  const backupsDir = o.backupsDirFor ? o.backupsDirFor(opening) : o.files.backupsDir

  let conversionError: ConversionError | null = null
  const left: string[] = []
  const run = (to: Target, from: Buffer | null, onto?: Buffer | null): void => {
    if (!from) throw new ConversionError(`${dbFile} can't be converted without its key`, false)
    left.push(...convertDatabase({ dbFile, backupsDir, keyFile, key: from, newKey: onto ?? undefined, to, hook: o.hook, log }).left)
  }
  try {
    if (marker && marker.to !== 'rekey') run(marker.to, key)
    if (marker?.to === 'rekey' || (next && formatOf(fileKind(dbFile)) === 'encrypted')) {
      // A waiting key (a new recovery code replaced the saved one): the database and its backups move onto it.
      // Already under it without a marker (one rebuilt after damage): only its backups and the key file are left.
      if (!marker && key && next && !opensWith(dbFile, key) && opensWith(dbFile, next)) writeMarker(f.marker, { v: 1, to: 'rekey', step: 'backups', census: null, oldId: keyId(key) })
      run('rekey', key, next ?? key)
      if (next) key = next
      next = null
    }
    have = formatOf(fileKind(dbFile))
    if (have && have !== want) {
      if (want === 'encrypted' && !keyFileHolds(keyFile, key)) {
        // The key file went with an earlier conversion to plain: a new key, in a new key file, never one held nowhere.
        try {
          key = (await obtainKey(o, { have, marker: false, create: true }))?.key ?? null
        } catch (err) {
          throw new ConversionError(err, false)
        }
      }
      run(want, key)
    }
  } catch (err) {
    if (!(err instanceof ConversionError)) throw err
    conversionError = err
  }
  have = formatOf(fileKind(dbFile)) ?? want
  if (have === 'encrypted') {
    const k = [key, next].find((c) => c && opensWith(dbFile, c)) ?? key
    if (!k) throw new Error(`${dbFile} is encrypted and its key file is missing`)
    setSession({ key: k, keyFile })
    // A new install's first backup puts it there (its backups folder may be a setting it doesn't have yet).
    if (existed) {
      try {
        copyKeyFileTo(backupsDir, keyFile)
      } catch (err) {
        log(`the key file's copy beside the backups waits for the next backup: ${message(err)}`)
      }
    }
    return { key: k, conversionError, left, backupsDir }
  }
  setSession(null)
  return { key: null, conversionError, left, backupsDir }
}

/** One setting from the database before it's opened for use (read-only); null when there's no file, no such setting, or it can't be read with `key`. */
export function peekSetting(file: string, key: Uint8Array | null, name: string): string | null {
  const kind = fileKind(file)
  if (kind === 'missing') return null
  try {
    const d = new DatabaseSync(file, { readOnly: true, key: kind === 'plain' ? null : key })
    try {
      return (d.prepare('SELECT value FROM settings WHERE key = ?').get(name) as { value: string | null } | undefined)?.value ?? null
    } finally {
      d.close()
    }
  } catch {
    return null
  }
}

/** The folders a copy of the key file may be in: the backups folder as known before the database opens, and the one the copy was last put in. */
function keyCopyDirs(o: PrepareOptions): string[] {
  return [...new Set([o.files.backupsDir, recordedKeyCopyDir(o.files.keyFile)].filter((d): d is string => !!d).map((d) => resolve(d)))]
}

/**
 * A copy of the key file beside the backups to put back: the first whose key (through this computer's
 * keystore) opens the database, else, for the recovery code to open, the folder's finance.key.
 */
function findKeyCopy(o: PrepareOptions): { path: string; kf: KeyFile } | null {
  const dirs = keyCopyDirs(o)
  const found: Array<{ path: string; kf: KeyFile }> = []
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.key') && n !== KEY_FILE_NAME)
        .sort()
    } catch {
      continue
    }
    for (const path of [join(dir, KEY_FILE_NAME), ...names.map((n) => join(dir, n))]) {
      try {
        found.push({ path, kf: readKeyFile(path) })
      } catch {
        // Missing, or not a key file this app wrote.
      }
    }
  }
  if (fileKind(o.files.dbFile) === 'other') {
    for (const c of found) {
      for (const s of keyEntries(c.kf)) {
        try {
          if (opensWith(o.files.dbFile, unwrapWithKeystore(s, o.keystore))) return c
        } catch {
          // Sealed elsewhere.
        }
      }
    }
  }
  return found.find((c) => basename(c.path) === KEY_FILE_NAME) ?? null
}

/** Moves a key file out of the way as finance-<8 hex>.key (its id, or a hash of a damaged one's bytes). */
function setAside(keyFile: string, id: string | null): void {
  const tag = id ?? createHash('sha256').update(readFileSync(keyFile)).digest('hex')
  renameSync(keyFile, join(dirname(keyFile), `finance-${tag.slice(0, 8)}.key`))
}

async function obtainKey(o: PrepareOptions, ctx: { have: Format | null; marker: boolean; create: boolean }): Promise<{ key: Buffer; next: Buffer | null } | null> {
  const { keyFile } = o.files
  const log = o.log ?? ((): void => {})
  const encryptedHere = ctx.have === 'encrypted' || ctx.marker
  const make = async (): Promise<{ key: Buffer; next: null }> => {
    const key = newDbKey()
    writeKeyFile(keyFile, await createKeyFile(key, o.keystore, null, o.kdf))
    log('made a new database key')
    return { key, next: null }
  }
  let kf: KeyFile | null = null
  let damage: string | null = null
  if (existsSync(keyFile)) {
    try {
      kf = readKeyFile(keyFile)
    } catch (err) {
      damage = message(err)
    }
  }
  if (!kf) {
    const copy = encryptedHere ? findKeyCopy(o) : null
    if (copy) {
      // The copy beside the backups holds the same sealed key.
      writeFileDurably(keyFile, readFileSync(copy.path))
      kf = copy.kf
      log(`key file ${damage ? 'damaged' : 'missing'}; put back from ${copy.path}`)
    } else if (encryptedHere) {
      const where = keyCopyDirs(o).map((d) => join(d, KEY_FILE_NAME))
      throw new Error(
        damage
          ? `The database's key file is damaged (${keyFile}: ${damage}), and no copy beside the backups opens the database. Put a good copy of finance.key back beside the database (looked in ${where.join(', ')}).`
          : `The database is encrypted and its key file is missing: ${keyFile}. A copy is kept beside the backups (${where.join(', ')}); put it back beside the database.`
      )
    } else if (ctx.create) {
      if (damage) setAside(keyFile, null)
      return make()
    } else {
      return null
    }
  }
  try {
    const key = unwrapWithKeystore(kf, o.keystore)
    const next = kf.next ? tryKeystore(kf.next, o.keystore) : null
    // Sealed again where this install's seal no longer opens it (the account seal did), or the account seal is missing.
    try {
      const fresh = resealedHere(kf, key, o.keystore)
      if (fresh) {
        writeKeyFile(keyFile, fresh)
        log('key file sealed again for this install')
      }
    } catch (err) {
      log(`key file not sealed again: ${message(err)}`)
    }
    return { key, next }
  } catch (err) {
    if (!(err instanceof KeyFileError) || err.problem !== 'keystore') throw err
  }
  if (!encryptedHere && ctx.create) {
    // Sealed for another computer, and nothing here is encrypted with it: set aside, and a new key made.
    setAside(keyFile, kf.id)
    log('the key file was sealed elsewhere and nothing here used it; set aside')
    return make()
  }
  if (!kf.recovery) throw new Error(`This computer or Windows account can't open the database's key file (${keyFile}), and no recovery code was saved for it. Open the app where it was made.`)
  const sealed = kf
  let key: Buffer | null = null
  let next: Buffer | null = null
  await o.askCode(async (code) => {
    key = await unwrapWithCode(sealed, code)
    next = sealed.next ? await unwrapWithCode(sealed.next, code).catch(() => null) : null
  })
  if (!key) throw new UnlockCancelled()
  // Sealed again for this computer, so the code isn't asked for next time.
  try {
    if (o.keystore.available() || o.keystore.account) writeKeyFile(keyFile, withKeystore(sealed, key, o.keystore, next))
  } catch (err) {
    log(`key file not sealed again for this computer: ${message(err)}`)
  }
  log('database key opened with the recovery code')
  return { key, next }
}

function tryKeystore(s: KeySeals, keystore: Keystore): Buffer | null {
  try {
    return unwrapWithKeystore(s, keystore)
  } catch {
    return null
  }
}

// ---------- the recovery code, while the app runs ----------

let pending: string | null = null

function sessionKeyFileOrThrow(): { key: Buffer; keyFile: string } {
  const key = sessionKey()
  const keyFile = sessionKeyFile()
  if (!key || !keyFile) throw new Error('The database is not encrypted')
  return { key, keyFile }
}

/** The database is encrypted and no recovery code has been saved for its key yet. */
export function recoveryPending(): boolean {
  const keyFile = sessionKeyFile()
  if (!keyFile) return false
  try {
    return readKeyFile(keyFile).recovery === null
  } catch {
    return false
  }
}

/** How far the key file's seals reach without the recovery code: this user account (the account seal, or a Mac's Keychain), or only this installation of the app. */
export function keySealScope(platform: NodeJS.Platform = process.platform): 'account' | 'install' {
  if (platform === 'darwin') return 'account'
  const keyFile = sessionKeyFile()
  try {
    return keyFile && readKeyFile(keyFile).account ? 'account' : 'install'
  } catch {
    return 'install'
  }
}

/** A new code to show; it takes the place of the current one only once confirmed (confirmRecoveryCode). */
export function issueRecoveryCode(): string {
  sessionKeyFileOrThrow()
  pending = newRecoveryCode()
  return pending
}

export const pendingRecoveryCode = (): string | null => pending

/**
 * Seals the key under the code just shown (the user saved it) and writes the key file, then its copy
 * beside the backups (best effort: the next backup puts it there). When a code was saved before, a new
 * key waits in the key file under the same code and the keystore, and `rekey` says so: at the next start
 * the database and its backups move onto it, so an old key file with the old code opens nothing written
 * after. Until then the new code opens the current key too.
 */
export async function confirmRecoveryCode(backupsDir: string, keystore: Keystore, kdf?: KdfParams, log: (line: string) => void = () => {}): Promise<{ rekey: boolean }> {
  const { key, keyFile } = sessionKeyFileOrThrow()
  const code = pending
  if (!code) throw new Error('No recovery code is waiting to be saved')
  const kf = readKeyFile(keyFile)
  let out = await withRecovery(kf, key, code, kdf)
  const rekey = kf.recovery !== null || kf.next !== null
  if (rekey) {
    const nextKey = newDbKey()
    try {
      out = { ...out, next: await createSeals(nextKey, keystore, code, kdf) }
    } finally {
      nextKey.fill(0)
    }
  }
  key.fill(0)
  writeKeyFile(keyFile, out)
  try {
    copyKeyFileTo(backupsDir, keyFile)
  } catch (err) {
    log(`the key file's copy beside the backups waits for the next backup: ${message(err)}`)
  }
  pending = null
  return { rekey }
}

/** Whether `code` is the saved recovery code. */
export async function checkRecoveryCode(code: string): Promise<boolean> {
  const { keyFile } = sessionKeyFileOrThrow()
  try {
    await unwrapWithCode(readKeyFile(keyFile), code)
    return true
  } catch (err) {
    if (err instanceof KeyFileError && (err.problem === 'code' || err.problem === 'no-recovery')) return false
    throw err
  }
}

// ---------- a backup's key ----------

/** Whether `key` (null: none) opens the database file. */
export function opensWith(file: string, key: Uint8Array | null): boolean {
  try {
    new DatabaseSync(file, { readOnly: true, key }).close()
    return true
  } catch {
    return false
  }
}

/** The key files a backup may have beside it: its own (<name>.key), the folder's finance.key, then any other. */
export function keyFilesBeside(file: string): string[] {
  const dir = dirname(file)
  const own = join(dir, `${basename(file, extname(file))}.key`)
  const folder = join(dir, KEY_FILE_NAME)
  let others: string[] = []
  try {
    others = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.key'))
      .sort()
      .map((n) => join(dir, n))
  } catch {
    // An unreadable folder has no key files to offer.
  }
  return [...new Set([own, folder, ...others])].filter((p) => existsSync(p))
}

export type BackupKey = { key: Buffer | null } | { needsCode: true }

/**
 * The key a backup opens with: none for a plain file; this install's key; a
 * key file beside it this computer's keystore or account seal opens; or,
 * given `code`, a key file beside it the recovery code opens. Without a code
 * where one is needed: needsCode. Throws when nothing can open it.
 */
export async function keyForBackup(file: string, o: { currentKey: Buffer | null; keystore: Keystore; code?: string }): Promise<BackupKey> {
  const kind = fileKind(file)
  if (kind === 'missing') throw new Error('Not a SQLite database file')
  if (kind === 'plain') return { key: null }
  if (o.currentKey && opensWith(file, o.currentKey)) return { key: o.currentKey }
  const candidates: KeySeals[] = []
  for (const p of keyFilesBeside(file)) {
    try {
      candidates.push(...keyEntries(readKeyFile(p)))
    } catch {
      // Not a key file this app wrote.
    }
  }
  if (!candidates.length) throw new Error(`Not a SQLite database file, or an encrypted backup without its key file: put ${KEY_FILE_NAME} (or ${basename(file, extname(file))}.key) beside it`)
  for (const s of candidates) {
    try {
      const key = unwrapWithKeystore(s, o.keystore)
      if (opensWith(file, key)) return { key }
    } catch {
      // Sealed for another computer: the recovery code may open it.
    }
  }
  const coded = candidates.filter((s) => s.recovery)
  if (!coded.length) throw new Error('This backup was encrypted on another computer or Windows account (or in another installation of the app), and its key file has no recovery code')
  if (o.code === undefined) return { needsCode: true }
  for (const s of coded) {
    try {
      const key = await unwrapWithCode(s, o.code)
      if (opensWith(file, key)) return { key }
    } catch (err) {
      if (!(err instanceof KeyFileError)) throw err
    }
  }
  throw new KeyFileError('code', 'That recovery code does not open this backup')
}

// ---------- where the recovery code is saved ----------

/**
 * Why the recovery code shouldn't be saved as `file`, or null: inside one of `places` (the documents and
 * backups folders, which a Store build and OneDrive keep together), or in a folder with a key file, where
 * whoever has the folder would have a backup's key file and its code together.
 */
export function recoveryFileProblem(file: string, places: readonly string[]): string | null {
  const dir = resolve(dirname(file))
  const inside = (p: string): boolean => {
    const r = relative(resolve(p), dir)
    return r === '' || (!r.startsWith('..') && !isAbsolute(r))
  }
  if (places.some(inside)) return 'Save the recovery code away from the backups and the documents folder'
  try {
    if (readdirSync(dir).some((n) => n.toLowerCase().endsWith('.key'))) return 'Save the recovery code away from the key file in that folder'
  } catch {
    // A folder that can't be listed holds no key file the app can see.
  }
  return null
}
