import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scrypt as scryptCb, type BinaryLike, type ScryptOptions } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'

// The database key: 32 random bytes (K) made once per install, which
// encrypts finance.db, its write-ahead log and its backups (sqlite.ts). K
// never touches the disk as it is. The key file beside the database
// (finance.key, versioned JSON) holds it sealed three ways:
//
//   dpapi     by the app's OS keystore (Electron's safeStorage: on Windows
//             AES under a key kept DPAPI-sealed in the data folder's
//             "Local State" file; the Keychain on macOS);
//   account   on Windows, by DPAPI itself for this Windows account (dpapi.ts),
//             which doesn't depend on the data folder: it opens after the app
//             is reinstalled, in the beta and the release alike, and when
//             Local State is lost. Null where it couldn't be made;
//   recovery  with AES-256-GCM under a key derived (scrypt) from the recovery
//             code, a random 30-character code the user saves, which opens it
//             anywhere: another computer or Windows account, or after Windows
//             is reinstalled. Null until the user has saved a code.
//
// While a new recovery code waits to take over (it replaced a saved one),
// `next` holds a new key K', sealed the same ways; the database moves to it at
// the next start (dbconvert.ts, 'rekey'), so a copy of the old key file and the
// old code open nothing written after. A copy of the key file goes beside the
// backups. No Electron here: the app hands in safeStorage
// (safeStorageKeystore), the tests a stand-in.

export const KEY_FILE_VERSION = 1

/** scrypt at N = 2^17, r = 8, p = 1 (128 MiB, about half a second): what a new recovery wrap uses. */
export const RECOVERY_KDF = { N: 2 ** 17, r: 8, p: 1 } as const

export interface KdfParams {
  N: number
  r: number
  p: number
}

export interface RecoveryWrap {
  kdf: 'scrypt'
  params: KdfParams
  /** base64: 16 random bytes */
  salt: string
  /** base64: AES-256-GCM's 12-byte nonce */
  nonce: string
  /** base64: K encrypted, then GCM's 16-byte tag */
  wrapped: string
}

/** One key's seals. */
export interface KeySeals {
  /** names the key without revealing it: the first 16 bytes of SHA-256 over a label and the key, hex */
  id: string
  /** base64: the key as the app's OS keystore sealed it; null where there is no keystore */
  dpapi: string | null
  /** base64: the key as DPAPI sealed it for this Windows account (dpapi.ts); null where it couldn't be */
  account: string | null
  recovery: RecoveryWrap | null
}

export interface KeyFile extends KeySeals {
  v: typeof KEY_FILE_VERSION
  /** the database's cipher (SQLite3MultipleCiphers' ChaCha20-Poly1305, raw key) */
  alg: 'chacha20'
  /** the key the database moves to at the next start (a new recovery code replaced a saved one); null otherwise */
  next: KeySeals | null
}

export type KeyFileProblem = 'unreadable' | 'keystore' | 'code' | 'no-recovery'

export class KeyFileError extends Error {
  readonly problem: KeyFileProblem
  constructor(problem: KeyFileProblem, message: string) {
    super(message)
    this.name = 'KeyFileError'
    this.problem = problem
  }
}

/** A seal for this user account that doesn't depend on the app's data folder (Windows: DPAPI, dpapi.ts). */
export interface AccountSeal {
  seal(data: Buffer): Buffer
  /** throws when the blob was sealed for another account or computer */
  open(blob: Buffer): Buffer
}

/** The OS keystore as the key file uses it. */
export interface Keystore {
  /** sealing works here (and isn't a fixed password, as on Linux without a keyring) */
  available(): boolean
  seal(data: Buffer): Buffer
  /** throws when the blob was sealed for another user or computer */
  open(blob: Buffer): Buffer
  /** the account seal, where there is one (Windows) */
  account?: AccountSeal | null
}

/** The parts of Electron's safeStorage the keystore needs. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plain: string): Buffer
  decryptString(blob: Buffer): string
}

/** Electron's safeStorage as a Keystore (with `account` beside it); K goes in as hex text, since safeStorage seals strings. */
export function safeStorageKeystore(s: SafeStorageLike, platform: NodeJS.Platform = process.platform, account: AccountSeal | null = null): Keystore {
  return {
    account,
    available: () => s.isEncryptionAvailable() && !(platform === 'linux' && s.getSelectedStorageBackend?.() === 'basic_text'),
    seal: (data) => s.encryptString(data.toString('hex')),
    open: (blob) => {
      const hex = s.decryptString(blob)
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Not a database key')
      return Buffer.from(hex, 'hex')
    }
  }
}

export const newDbKey = (): Buffer => randomBytes(32)

export const keyId = (key: Uint8Array): string => createHash('sha256').update('finance-tracker database key id\0').update(key).digest().subarray(0, 16).toString('hex')

// ---------- recovery codes ----------

/** Crockford's base32: no I, L, O or U, so nothing in it reads as another character. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_GROUPS = 6
export const CODE_GROUP_LENGTH = 5
const CODE_LENGTH = CODE_GROUPS * CODE_GROUP_LENGTH

/** A new recovery code: 30 random base32 characters (150 bits) in six groups of five. */
export function newRecoveryCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return formatRecoveryCode(s)
}

export const formatRecoveryCode = (canonical: string): string => canonical.match(new RegExp(`.{1,${CODE_GROUP_LENGTH}}`, 'g'))!.join('-')

/**
 * A code as typed, in its canonical form (30 characters, no separators), or
 * null when it can't be one: case, spaces, dashes and dots don't matter, and
 * O reads as 0, I and L as 1.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const s = String(input ?? '')
    .toUpperCase()
    .replace(/[\s\-–—_.·]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (s.length !== CODE_LENGTH) return null
  for (const c of s) if (!ALPHABET.includes(c)) return null
  return s
}

// ---------- wrapping ----------

function scrypt(password: BinaryLike, salt: BinaryLike, params: KdfParams): Promise<Buffer> {
  // maxmem above 128 * N * r, which Node's 32 MiB default is below.
  const opts: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 }
  return new Promise((resolve, reject) => scryptCb(password, salt, 32, opts, (err, key) => (err ? reject(err) : resolve(key))))
}

const aad = (id: string): Buffer => Buffer.from(`finance-tracker key file v${KEY_FILE_VERSION} ${id}`)

/** K sealed under the code, with fresh salt and nonce. */
export async function wrapWithCode(key: Uint8Array, code: string, params: KdfParams = RECOVERY_KDF): Promise<RecoveryWrap> {
  const canonical = normalizeRecoveryCode(code)
  if (!canonical) throw new KeyFileError('code', 'Not a recovery code')
  checkKdf(params)
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const kek = await scrypt(canonical, salt, params)
  const c = createCipheriv('aes-256-gcm', kek, nonce)
  c.setAAD(aad(keyId(key)))
  const wrapped = Buffer.concat([c.update(key), c.final(), c.getAuthTag()])
  return { kdf: 'scrypt', params: { N: params.N, r: params.r, p: params.p }, salt: salt.toString('base64'), nonce: nonce.toString('base64'), wrapped: wrapped.toString('base64') }
}

/** Refuses scrypt settings too weak to keep, or so heavy they'd stall the app (a key file is data, not trusted). */
function checkKdf(p: KdfParams): void {
  const ok = Number.isInteger(p.N) && p.N >= 2 ** 10 && p.N <= 2 ** 20 && (p.N & (p.N - 1)) === 0 && Number.isInteger(p.r) && p.r >= 1 && p.r <= 16 && Number.isInteger(p.p) && p.p >= 1 && p.p <= 4
  if (!ok) throw new KeyFileError('unreadable', 'The key file has scrypt settings this app does not use')
}

/** K sealed by the account seal; null where there is none or it fails (a blocked PowerShell, say). */
function accountSealOf(key: Uint8Array, keystore: Keystore | null): string | null {
  if (!keystore?.account) return null
  try {
    return keystore.account.seal(Buffer.from(key)).toString('base64')
  } catch {
    return null
  }
}

/** One key's seals: by the keystore when it's available, by the account seal where there is one, and under `code` when one is given. */
export async function createSeals(key: Uint8Array, keystore: Keystore | null, code: string | null = null, params: KdfParams = RECOVERY_KDF): Promise<KeySeals> {
  if (key.length !== 32) throw new Error('A database key is 32 bytes')
  return {
    id: keyId(key),
    dpapi: keystore?.available() ? keystore.seal(Buffer.from(key)).toString('base64') : null,
    account: accountSealOf(key, keystore),
    recovery: code ? await wrapWithCode(key, code, params) : null
  }
}

/** Makes a key file for K: sealed by the keystore when it's available, by the account seal, and under `code` when one is given. */
export async function createKeyFile(key: Uint8Array, keystore: Keystore | null, code: string | null = null, params: KdfParams = RECOVERY_KDF): Promise<KeyFile> {
  const own = await createSeals(key, keystore, code, params)
  return { v: KEY_FILE_VERSION, alg: 'chacha20', ...own, next: null }
}

const sealsOf = (s: KeySeals): KeySeals => ({ id: s.id, dpapi: s.dpapi, account: s.account, recovery: s.recovery })

/** The key file's keys: its own, then the one waiting to take over. */
export const keyEntries = (kf: KeyFile): KeySeals[] => (kf.next ? [sealsOf(kf), sealsOf(kf.next)] : [sealsOf(kf)])

/** The key file with the waiting key in its place (the database moved to it). */
export function promoteNext(kf: KeyFile): KeyFile {
  if (!kf.next) throw new KeyFileError('unreadable', 'No key is waiting in this key file')
  return { v: KEY_FILE_VERSION, alg: 'chacha20', ...sealsOf(kf.next), next: null }
}

function resealEntry(s: KeySeals, key: Uint8Array, keystore: Keystore): KeySeals {
  if (keyId(key) !== s.id) throw new KeyFileError('unreadable', 'That key does not belong to this key file')
  return { ...sealsOf(s), dpapi: keystore.available() ? keystore.seal(Buffer.from(key)).toString('base64') : null, account: keystore.account ? accountSealOf(key, keystore) : s.account }
}

/** The key file with K (and the waiting key, given it) sealed again by this computer's keystore and account (after it was opened with the recovery code here). */
export function withKeystore(kf: KeyFile, key: Uint8Array, keystore: Keystore, nextKey: Uint8Array | null = null): KeyFile {
  const own = resealEntry(kf, key, keystore)
  const next = kf.next && nextKey ? resealEntry(kf.next, nextKey, keystore) : kf.next
  return { v: KEY_FILE_VERSION, alg: 'chacha20', ...own, next }
}

function keystoreOpens(s: KeySeals, keystore: Keystore): boolean {
  if (!s.dpapi || !keystore.available()) return false
  try {
    const k = keystore.open(Buffer.from(s.dpapi, 'base64'))
    return k.length === 32 && keyId(k) === s.id
  } catch {
    return false
  }
}

/**
 * The key file with what's missing or stale here sealed again, or null when nothing is: a keystore seal
 * this keystore doesn't open (the key was opened through the account seal: the app was reinstalled, or
 * its Local State lost), or no account seal yet. Spawns nothing unless an account seal is to be made.
 */
export function resealedHere(kf: KeyFile, key: Uint8Array, keystore: Keystore): KeyFile | null {
  if (keyId(key) !== kf.id) return null
  let out = kf
  if (keystore.available() && !keystoreOpens(kf, keystore)) out = { ...out, dpapi: keystore.seal(Buffer.from(key)).toString('base64') }
  if (keystore.account && !kf.account) {
    const account = accountSealOf(key, keystore)
    if (account) out = { ...out, account }
  }
  return out === kf ? null : out
}

/** The key file with a new recovery code for its own key: the old code no longer opens it (a copy kept elsewhere still opens with the old one). */
export async function withRecovery(kf: KeyFile, key: Uint8Array, code: string, params: KdfParams = RECOVERY_KDF): Promise<KeyFile> {
  if (keyId(key) !== kf.id) throw new KeyFileError('unreadable', 'That key does not belong to this key file')
  return { ...kf, recovery: await wrapWithCode(key, code, params) }
}

/** A key, opened by this computer's keystore, or else by the account seal. */
export function unwrapWithKeystore(s: KeySeals, keystore: Keystore): Buffer {
  const tries: Array<() => Buffer> = []
  const { dpapi, account } = s
  if (dpapi && keystore.available()) tries.push(() => keystore.open(Buffer.from(dpapi, 'base64')))
  const seal = keystore.account
  if (account && seal) tries.push(() => seal.open(Buffer.from(account, 'base64')))
  if (!tries.length) throw new KeyFileError('keystore', 'The key file was not sealed for this computer')
  for (const t of tries) {
    try {
      const key = t()
      if (key.length === 32 && keyId(key) === s.id) return key
    } catch {
      // Sealed elsewhere: the next seal, or the recovery code.
    }
  }
  throw new KeyFileError('keystore', 'The key file was sealed for another computer or Windows account')
}

/** A key, opened with the recovery code; a wrong code is KeyFileError 'code'. */
export async function unwrapWithCode(s: KeySeals, code: string): Promise<Buffer> {
  if (!s.recovery) throw new KeyFileError('no-recovery', 'No recovery code was saved for this key file')
  const canonical = normalizeRecoveryCode(code)
  if (!canonical) throw new KeyFileError('code', 'That is not a recovery code: 30 letters and digits')
  const r = s.recovery
  checkKdf(r.params)
  const kek = await scrypt(canonical, Buffer.from(r.salt, 'base64'), r.params)
  const blob = Buffer.from(r.wrapped, 'base64')
  if (blob.length !== 48) throw new KeyFileError('unreadable', 'The key file is damaged')
  try {
    const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(r.nonce, 'base64'))
    d.setAAD(aad(s.id))
    d.setAuthTag(blob.subarray(32))
    const key = Buffer.concat([d.update(blob.subarray(0, 32)), d.final()])
    if (keyId(key) !== s.id) throw new Error('id')
    return key
  } catch {
    throw new KeyFileError('code', 'That recovery code does not open this key file')
  }
}

// ---------- the file ----------

const b64 = (v: unknown, bytes?: number): boolean => typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && (bytes === undefined || Buffer.from(v, 'base64').length === bytes)

const damaged = (): KeyFileError => new KeyFileError('unreadable', 'The key file is damaged')

/** One key's seals as parsed; throws when they aren't ones this app wrote. */
function parseSeals(o: Record<string, unknown>): KeySeals {
  if (typeof o['id'] !== 'string' || !/^[0-9a-f]{32}$/.test(o['id'])) throw damaged()
  if (o['dpapi'] !== null && !b64(o['dpapi'])) throw damaged()
  // Key files from before the account seal have none.
  const account = o['account'] ?? null
  if (account !== null && !b64(account)) throw damaged()
  const r = o['recovery'] as Record<string, unknown> | null
  if (r === null) return { id: o['id'], dpapi: (o['dpapi'] as string | null) ?? null, account: account as string | null, recovery: null }
  const p = r?.['params'] as Record<string, unknown> | undefined
  if (!r || r['kdf'] !== 'scrypt' || !p || typeof p['N'] !== 'number' || typeof p['r'] !== 'number' || typeof p['p'] !== 'number' || !b64(r['salt'], 16) || !b64(r['nonce'], 12) || !b64(r['wrapped'], 48)) throw damaged()
  const params: KdfParams = { N: p['N'], r: p['r'], p: p['p'] }
  checkKdf(params)
  return { id: o['id'], dpapi: (o['dpapi'] as string | null) ?? null, account: account as string | null, recovery: { kdf: 'scrypt', params, salt: r['salt'] as string, nonce: r['nonce'] as string, wrapped: r['wrapped'] as string } }
}

/** Checks the shape of a parsed key file; throws KeyFileError 'unreadable' when it isn't one this app wrote. */
export function parseKeyFile(text: string): KeyFile {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw damaged()
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw damaged()
  if (o['v'] !== KEY_FILE_VERSION) throw new KeyFileError('unreadable', `The key file is version ${String(o['v'])}; this app reads version ${KEY_FILE_VERSION}`)
  if (o['alg'] !== 'chacha20') throw damaged()
  const own = parseSeals(o)
  const n = (o['next'] ?? null) as Record<string, unknown> | null
  if (n !== null && (typeof n !== 'object' || Array.isArray(n))) throw damaged()
  const next = n === null ? null : parseSeals(n)
  if (next && next.id === own.id) throw damaged()
  return { v: KEY_FILE_VERSION, alg: 'chacha20', ...own, next }
}

export function readKeyFile(path: string): KeyFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new KeyFileError('unreadable', `The key file ${path} can't be read`)
  }
  return parseKeyFile(text)
}

/** Writes `data` to `path` whole or not at all: beside it first, flushed to the disk, then renamed over it. */
export function writeFileDurably(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function writeKeyFile(path: string, kf: KeyFile): void {
  writeFileDurably(path, `${JSON.stringify(kf, null, 1)}\n`)
}
