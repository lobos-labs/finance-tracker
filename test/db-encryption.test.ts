import { after, afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as db from '../src/main/db.ts'
import { bulkBackup, checkBackupFile, dailyBackup, writeBackup } from '../src/main/backup.ts'
import { createKeyFile, formatRecoveryCode, KeyFileError, newDbKey, newRecoveryCode, normalizeRecoveryCode, parseKeyFile, readKeyFile, RECOVERY_KDF, safeStorageKeystore, unwrapWithCode, unwrapWithKeystore, withKeystore, withRecovery, wrapWithCode, writeKeyFile, type KdfParams, type Keystore } from '../src/main/dbkey.ts'
import { ConversionError, conversionFiles, convertDatabase, KILL_POINTS, preBackupName, readMarker, type Format } from '../src/main/dbconvert.ts'
import { checkRecoveryCode, confirmRecoveryCode, dbFiles, issueRecoveryCode, keyForBackup, opensWith, prepareDatabase, readEncryptSwitch, recoveryPending, UnlockCancelled, wantedFormat, writeEncryptSwitch, type DbFiles } from '../src/main/dbopen.ts'
import { sessionKey, sessionKeyHex, setSession } from '../src/main/dbsession.ts'
import { copyDatabase, DatabaseSync, fileKind, hasDefaultKey } from '../src/main/sqlite.ts'
import { removeData } from '../src/main/wipeFiles.ts'

// Encryption at rest (src/main/sqlite.ts, dbkey.ts, dbconvert.ts, dbopen.ts):
// the driver's encrypted files, the key file and the recovery code, the
// conversion of a plain install with a crash at every step, the open path of
// a packaged and a development build, backups and restores on this install
// and elsewhere, Delete all data, and the review's tool server with its key.

const here = dirname(fileURLToPath(import.meta.url))
const tsEsm = pathToFileURL(join(here, 'ts-esm.mjs')).href
const root = mkdtempSync(join(tmpdir(), 'finance-encryption-'))
after(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  db.closeDb()
  setSession(null)
})

let n = 0
const folder = (): string => {
  const d = join(root, `case-${n++}`)
  mkdirSync(d, { recursive: true })
  return d
}

/** A stand-in for the OS keystore of one computer and account: what it seals, only it opens. */
function keystoreOf(machine: string, available = true): Keystore {
  const secret = createHash('sha256').update(`keystore ${machine}`).digest()
  return {
    available: () => available,
    seal: (data) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', secret, iv)
      return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()])
    },
    open: (blob) => {
      const d = createDecipheriv('aes-256-gcm', secret, blob.subarray(0, 12))
      d.setAuthTag(blob.subarray(blob.length - 16))
      return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()])
    }
  }
}

/** Light scrypt for the tests; the app's own settings are checked once below. */
const KDF: KdfParams = { N: 2 ** 10, r: 8, p: 1 }
const SECRET = 'SECRET-MERCHANT-7731'

/** A migrated database with a few rows, closed; returns its row count. */
function seed(file: string, key: Buffer | null, rows = 30): void {
  db.openDb(file, { key })
  db.upsertAccount({ id: 'acct:1', source: 'csv', name: 'Checking', institution: 'Test Bank', currency: 'USD', balanceCents: 123_45, availableCents: null, balanceDate: 1_790_000_000 })
  db.inTransaction(() => {
    for (let i = 0; i < rows; i++) db.upsertTransaction({ id: `t${i}`, accountId: 'acct:1', posted: 1_790_000_000 + i * 86_400, amountCents: -(100 + i), description: `${SECRET} #${i}`, pending: false })
  })
  db.addFact('Rent is due on the 1st')
  db.closeDb()
}

const count = (file: string, key: Buffer | null): number => {
  const d = new DatabaseSync(file, { readOnly: true, key })
  try {
    return (d.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  } finally {
    d.close()
  }
}

/** No byte of the database's text in the file (or its log). */
function noPlaintext(file: string): void {
  for (const f of [file, `${file}-wal`]) if (existsSync(f)) assert.ok(!readFileSync(f).includes(Buffer.from(SECRET)), `${f} holds plaintext`)
}

const filesIn = (dir: string): string[] => readdirSync(dir).sort()

describe('the driver', () => {
  test('a keyed file is encrypted on disk, write-ahead log included, and opens only with its key', () => {
    const dir = folder()
    const file = join(dir, 'finance.db')
    const key = newDbKey()
    db.openDb(file, { key })
    db.upsertAccount({ id: 'acct:1', source: 'csv', name: 'Checking', institution: 'Test Bank', currency: 'USD', balanceCents: 0, availableCents: null, balanceDate: 1_790_000_000 })
    db.upsertTransaction({ id: 't1', accountId: 'acct:1', posted: 1_790_000_000, amountCents: -500, description: SECRET, pending: false })
    assert.equal(db.dbEncrypted(), true)
    assert.ok(existsSync(`${file}-wal`))
    noPlaintext(file)
    db.closeDb()
    assert.equal(fileKind(file), 'other')
    noPlaintext(file)
    assert.equal(count(file, key), 1)
    assert.throws(() => new DatabaseSync(file, { key: null }), /not a database/)
    assert.throws(() => new DatabaseSync(file, { key: newDbKey() }), /not a database/)
    assert.equal(opensWith(file, key), true)
    assert.equal(opensWith(file, null), false)
  })

  test('a plain file stays plain, and a key on it is refused rather than written in', () => {
    const file = join(folder(), 'plain.db')
    seed(file, null)
    assert.equal(fileKind(file), 'plain')
    assert.throws(() => new DatabaseSync(file, { key: newDbKey() }), /not a database/)
    assert.equal(fileKind(file), 'plain')
  })

  test('the compatibility node:sqlite gave: booleans bind as 1 and 0, and all() and get() run a statement that returns nothing', () => {
    const d = new DatabaseSync(':memory:', { key: newDbKey() })
    try {
      assert.equal(d.encrypted, false)
      d.exec('CREATE TABLE t (x)')
      assert.deepEqual(d.prepare('INSERT INTO t VALUES (?)').all(true), [])
      assert.equal(d.prepare('INSERT INTO t VALUES (?)').get(false), undefined)
      assert.deepEqual(d.prepare('SELECT x FROM t ORDER BY rowid').all(), [{ x: 1 }, { x: 0 }])
    } finally {
      d.close()
    }
  })

  test('copyDatabase moves a database between plain, one key and another, whole', () => {
    const dir = folder()
    const plain = join(dir, 'a.db')
    seed(plain, null)
    const k1 = newDbKey()
    const k2 = newDbKey()
    copyDatabase(plain, null, join(dir, 'b.db'), k1)
    copyDatabase(join(dir, 'b.db'), k1, join(dir, 'c.db'), k2)
    copyDatabase(join(dir, 'c.db'), k2, join(dir, 'd.db'), null)
    assert.equal(count(join(dir, 'b.db'), k1), 30)
    assert.equal(count(join(dir, 'c.db'), k2), 30)
    assert.equal(count(join(dir, 'd.db'), null), 30)
    noPlaintext(join(dir, 'b.db'))
    noPlaintext(join(dir, 'c.db'))
    assert.equal(fileKind(join(dir, 'd.db')), 'plain')
    // No scratch file is left behind.
    assert.deepEqual(filesIn(dir), ['a.db', 'b.db', 'c.db', 'd.db'])
  })

  test('in the encrypted run every database opened without a named key is encrypted', () => {
    const file = join(folder(), 'default.db')
    db.openDb(file)
    db.closeDb()
    assert.equal(fileKind(file), hasDefaultKey() ? 'other' : 'plain')
  })
})

describe('recovery codes', () => {
  test('30 base32 characters in six groups of five, about 150 bits, never the same twice', () => {
    const codes = new Set(Array.from({ length: 200 }, newRecoveryCode))
    assert.equal(codes.size, 200)
    for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/)
  })

  test('typed in any case, with or without dashes and spaces, and with O for 0 and I or L for 1, it reads the same', () => {
    const canonical = '0123456789ABCDEFGHJKMNPQRSTVWX'
    assert.equal(normalizeRecoveryCode(formatRecoveryCode(canonical)), canonical)
    assert.equal(normalizeRecoveryCode('o1234 56789 abcde fghjk mnpqr stvwx'), canonical)
    assert.equal(normalizeRecoveryCode('OI234-56789-ABCDE-FGHJK-MNPQR-STVWX'), canonical)
    assert.equal(normalizeRecoveryCode('0L234_56789.ABCDE fghjk–mnpqr—stvwx'), canonical)
    assert.equal(normalizeRecoveryCode('01234-56789-ABCDE-FGHJK-MNPQR-STVW'), null)
    assert.equal(normalizeRecoveryCode('01234-56789-ABCDE-FGHJK-MNPQR-STVWXY'), null)
    assert.equal(normalizeRecoveryCode('U1234-56789-ABCDE-FGHJK-MNPQR-STVWX'), null)
    assert.equal(normalizeRecoveryCode(''), null)
  })
})

describe('the key file', () => {
  const here1 = keystoreOf('this computer')
  const elsewhere = keystoreOf('another computer')

  test('holds the key sealed by the keystore and under the recovery code, and never as it is', async () => {
    const key = newDbKey()
    const code = newRecoveryCode()
    const kf = await createKeyFile(key, here1, code, KDF)
    const file = join(folder(), 'finance.key')
    writeKeyFile(file, kf)
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes(key.toString('hex')) && !text.includes(key.toString('base64')))
    const back = readKeyFile(file)
    assert.deepEqual(back, kf)
    assert.equal(back.v, 1)
    assert.equal(back.alg, 'chacha20')
    assert.deepEqual(Object.keys(back.recovery!), ['kdf', 'params', 'salt', 'nonce', 'wrapped'])
    assert.ok(unwrapWithKeystore(back, here1).equals(key))
    assert.ok((await unwrapWithCode(back, code)).equals(key))
    // As typed: lower case, spaces for dashes.
    assert.ok((await unwrapWithCode(back, code.toLowerCase().replace(/-/g, ' '))).equals(key))
  })

  test('another computer\'s keystore can\'t open it; a wrong code is refused as one', async () => {
    const key = newDbKey()
    const kf = await createKeyFile(key, here1, newRecoveryCode(), KDF)
    assert.throws(() => unwrapWithKeystore(kf, elsewhere), (e: unknown) => e instanceof KeyFileError && e.problem === 'keystore')
    await assert.rejects(unwrapWithCode(kf, newRecoveryCode()), (e: unknown) => e instanceof KeyFileError && e.problem === 'code')
    await assert.rejects(unwrapWithCode(kf, 'not a code'), (e: unknown) => e instanceof KeyFileError && e.problem === 'code')
    const none = await createKeyFile(key, here1, null)
    await assert.rejects(unwrapWithCode(none, newRecoveryCode()), (e: unknown) => e instanceof KeyFileError && e.problem === 'no-recovery')
    // No keystore at all: only the code can seal it.
    assert.equal((await createKeyFile(key, keystoreOf('linux', false), null)).dpapi, null)
  })

  test('a new recovery code replaces the old one; sealing again for another computer keeps the code', async () => {
    const key = newDbKey()
    const oldCode = newRecoveryCode()
    const kf = await createKeyFile(key, here1, oldCode, KDF)
    const newCode = newRecoveryCode()
    const rotated = await withRecovery(kf, key, newCode, KDF)
    assert.equal(rotated.dpapi, kf.dpapi)
    assert.ok((await unwrapWithCode(rotated, newCode)).equals(key))
    await assert.rejects(unwrapWithCode(rotated, oldCode), KeyFileError)
    const moved = withKeystore(rotated, key, elsewhere)
    assert.ok(unwrapWithKeystore(moved, elsewhere).equals(key))
    assert.throws(() => unwrapWithKeystore(moved, here1), KeyFileError)
    assert.ok((await unwrapWithCode(moved, newCode)).equals(key))
    // Not for a different key.
    await assert.rejects(withRecovery(kf, newDbKey(), newCode, KDF), KeyFileError)
  })

  test('a damaged key file, another version, or scrypt settings out of range are refused', async () => {
    const kf = await createKeyFile(newDbKey(), here1, newRecoveryCode(), KDF)
    const text = JSON.stringify(kf)
    assert.throws(() => parseKeyFile('{'), KeyFileError)
    assert.throws(() => parseKeyFile(JSON.stringify({ ...kf, v: 2 })), /version 2/)
    assert.throws(() => parseKeyFile(JSON.stringify({ ...kf, id: 'x' })), KeyFileError)
    assert.throws(() => parseKeyFile(JSON.stringify({ ...kf, recovery: { ...kf.recovery, params: { N: 2 ** 30, r: 8, p: 1 } } })), KeyFileError)
    assert.throws(() => parseKeyFile(JSON.stringify({ ...kf, recovery: { ...kf.recovery, wrapped: 'AAAA' } })), KeyFileError)
    // A flipped byte in the wrapped key fails the code, not silently.
    const w = Buffer.from(kf.recovery!.wrapped, 'base64')
    w[3] ^= 1
    const bad = parseKeyFile(JSON.stringify({ ...kf, recovery: { ...kf.recovery, wrapped: w.toString('base64') } }))
    assert.ok(parseKeyFile(text))
    await assert.rejects(unwrapWithCode(bad, 'x'), KeyFileError)
  })

  test('the app\'s own scrypt settings: N = 2^17, r = 8, p = 1', async () => {
    assert.deepEqual(RECOVERY_KDF, { N: 2 ** 17, r: 8, p: 1 })
    const key = newDbKey()
    const code = newRecoveryCode()
    const wrap = await wrapWithCode(key, code)
    assert.deepEqual(wrap.params, { N: 131072, r: 8, p: 1 })
    assert.ok((await unwrapWithCode({ v: 1, alg: 'chacha20', id: (await createKeyFile(key, null)).id, dpapi: null, recovery: wrap }, code)).equals(key))
  })

  test('safeStorage as the keystore: the key goes in as hex text and comes back as the same 32 bytes', () => {
    const seen: string[] = []
    const fake = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (s: string) => (seen.push(s), Buffer.from(`sealed:${s}`)), decryptString: (b: Buffer) => b.toString().replace(/^sealed:/, '') }
    const ks = safeStorageKeystore(fake, 'win32')
    const key = newDbKey()
    assert.ok(ks.open(ks.seal(key)).equals(key))
    assert.deepEqual(seen, [key.toString('hex')])
    assert.equal(safeStorageKeystore({ ...fake, getSelectedStorageBackend: () => 'basic_text' }, 'linux').available(), false)
    assert.equal(safeStorageKeystore({ ...fake, isEncryptionAvailable: () => false }, 'win32').available(), false)
  })
})

/** A plain install as beta 4 left it: finance.db with data (closed). */
function plainInstall(): { files: DbFiles } {
  const dir = folder()
  const files = dbFiles(dir, join(dir, 'backups'))
  seed(files.dbFile, null)
  return { files }
}

/** Its backups, as the app made them (a daily one and one before an upgrade), and a copy the user put there. */
async function withPlainBackups(files: DbFiles): Promise<string[]> {
  db.openDb(files.dbFile, { key: null })
  const a = await dailyBackup(files.backupsDir, new Date(2026, 9, 20))
  const b = await writeBackup(files.backupsDir, 'pre-v32-20261021-090000.db', 3)
  db.closeDb()
  // A copy the user put there themselves is theirs, and left alone.
  copyFileSync(b, join(files.backupsDir, 'mine.db'))
  return [a!, b]
}

function convertIn(files: DbFiles, key: Buffer, to: Format): void {
  convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to })
}

/** What the database is once a conversion is done: openable in its new form with every row, nothing in the old form left beside it. */
function assertConverted(files: DbFiles, key: Buffer, backups: string[], to: Format = 'encrypted'): void {
  const k = to === 'encrypted' ? key : null
  assert.equal(fileKind(files.dbFile), to === 'encrypted' ? 'other' : 'plain')
  assert.equal(count(files.dbFile, k), 30)
  db.openDb(files.dbFile, { key: k })
  assert.deepEqual(db.checkIntegrity(), { corruption: [], foreignKeys: [] })
  assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
  db.closeDb()
  for (const b of backups) {
    assert.equal(fileKind(b), to === 'encrypted' ? 'other' : 'plain', b)
    checkBackupFile(b, k)
  }
  if (to === 'encrypted') {
    noPlaintext(files.dbFile)
    for (const b of backups) noPlaintext(b)
  }
  const f = conversionFiles(files.dbFile)
  for (const p of [f.marker, f.encTmp, f.plainTmp, f.scratch, f.pre, f.restoreTmp, join(files.backupsDir, preBackupName(to))]) assert.ok(!existsSync(p), `${p} left behind`)
  for (const name of filesIn(files.backupsDir)) assert.ok(!name.includes('.convert.tmp') && !name.endsWith('.db.tmp'), name)
  // A fresh backup of the converted database was written before the old ones were touched.
  const fresh = filesIn(files.backupsDir).filter((n) => /^bulk-\d{8}-\d{6}\.db$/.test(n))
  assert.ok(fresh.length >= 1, 'no fresh backup')
  for (const name of fresh) checkBackupFile(join(files.backupsDir, name), k)
  // The user's own copy in the folder is untouched.
  assert.equal(fileKind(join(files.backupsDir, 'mine.db')), 'plain')
}

describe('converting a plain install', () => {
  test('the database and the app\'s backups are encrypted, checked, and the plain copies removed', async () => {
    const { files } = plainInstall()
    const backups = await withPlainBackups(files)
    const key = newDbKey()
    writeKeyFile(files.keyFile, await createKeyFile(key, keystoreOf('pc'), null))
    convertIn(files, key, 'encrypted')
    assertConverted(files, key, backups)
    assert.ok(existsSync(join(files.backupsDir, 'finance.key')))
  })

  test('a crash at any step leaves data that opens, and the next launch finishes the conversion', async () => {
    const points = [...KILL_POINTS.filter((p) => p !== 'key-promoted'), 'backup-file:2', 'backup-file-swapped:2'] as string[]
    for (const point of points) {
      const { files } = plainInstall()
      const backups = await withPlainBackups(files)
      const key = newDbKey()
      writeKeyFile(files.keyFile, await createKeyFile(key, keystoreOf('pc'), null))
      const r = spawnSync(process.execPath, ['--import', tsEsm, join(here, 'fixtures', 'convert-crash.ts'), files.dbFile, files.backupsDir, files.keyFile, key.toString('hex'), 'encrypted', point], { encoding: 'utf8' })
      assert.ok(r.stdout.includes(`killed at ${point.split(':')[0]}`) && r.status !== 0, `${point}: the child wasn't stopped there (${r.status} ${r.stdout} ${r.stderr})`)
      // Whatever the crash left, the database opens now: in the old form or the new.
      const kind = fileKind(files.dbFile)
      assert.equal(count(files.dbFile, kind === 'plain' ? null : key), 30, point)
      // The next launch picks up where it stopped (after the marker went, there's nothing left to do).
      if (point !== 'marker-removed') {
        assert.ok(readMarker(conversionFiles(files.dbFile).marker), `${point}: no marker to resume from`)
        convertIn(files, key, 'encrypted')
      }
      assertConverted(files, key, backups)
    }
  })

  test('a full disk (or any failure) before the swap removes what was made and leaves the original as it was', async () => {
    for (const point of ['marker-written', 'backup-written', 'copy-written', 'copy-verified', 'marker-swap'] as const) {
      const { files } = plainInstall()
      await withPlainBackups(files)
      const before = readFileSync(files.dbFile)
      const key = newDbKey()
      writeKeyFile(files.keyFile, await createKeyFile(key, keystoreOf('pc'), null))
      const full = (): never => {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      assert.throws(
        () => convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to: 'encrypted', hook: (p) => p === point && full() }),
        (e: unknown) => e instanceof ConversionError && !e.swapped && /ENOSPC/.test(e.message),
        point
      )
      assert.ok(readFileSync(files.dbFile).equals(before), `${point}: the original changed`)
      const f = conversionFiles(files.dbFile)
      for (const p of [f.marker, f.encTmp, f.scratch, f.pre, join(files.backupsDir, preBackupName('encrypted'))]) assert.ok(!existsSync(p), `${point}: ${p} left behind`)
      // And with room again, it goes through.
      convertIn(files, key, 'encrypted')
      assert.equal(count(files.dbFile, key), 30)
    }
  })

  test('a failure after the swap keeps the new database and leaves the backups for the next launch', async () => {
    const { files } = plainInstall()
    const backups = await withPlainBackups(files)
    const key = newDbKey()
    writeKeyFile(files.keyFile, await createKeyFile(key, keystoreOf('pc'), null))
    assert.throws(() => convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to: 'encrypted', hook: (p) => { if (p === 'fresh-backup') throw new Error('EIO: i/o error, write') } }), (e: unknown) => e instanceof ConversionError && e.swapped)
    assert.equal(count(files.dbFile, key), 30)
    assert.equal(readMarker(conversionFiles(files.dbFile).marker)?.step, 'backups')
    // The plaintext copy of the database as it was went as soon as the encrypted one was checked.
    assert.ok(!existsSync(conversionFiles(files.dbFile).pre))
    convertIn(files, key, 'encrypted')
    assertConverted(files, key, backups)
  })

  test('a converted copy the disk lost after it was checked is never swapped in: a conversion stopped before its swap starts over', async () => {
    const { files } = plainInstall()
    const backups = await withPlainBackups(files)
    const key = newDbKey()
    writeKeyFile(files.keyFile, await createKeyFile(key, keystoreOf('pc'), null))
    const r = spawnSync(process.execPath, ['--import', tsEsm, join(here, 'fixtures', 'convert-crash.ts'), files.dbFile, files.backupsDir, files.keyFile, key.toString('hex'), 'encrypted', 'marker-swap'], { encoding: 'utf8' })
    assert.ok(r.stdout.includes('killed at marker-swap'), r.stderr)
    const tmp = conversionFiles(files.dbFile).encTmp
    truncateSync(tmp, Math.floor(statSync(tmp).size / 2))
    convertIn(files, key, 'encrypted')
    assertConverted(files, key, backups)
  })

  test('back to plain (a development build\'s switch turned off): the backups too, and the key file goes', async () => {
    const { files } = plainInstall()
    const backups = await withPlainBackups(files)
    const key = newDbKey()
    writeKeyFile(files.keyFile, await createKeyFile(key, keystoreOf('pc'), null))
    convertIn(files, key, 'encrypted')
    convertIn(files, key, 'plain')
    assertConverted(files, key, backups, 'plain')
    assert.ok(!existsSync(files.keyFile) && !existsSync(join(files.backupsDir, 'finance.key')))
  })
})

describe('opening the database', () => {
  const pc = keystoreOf('pc')
  const neverAsk = async (): Promise<void> => {
    throw new Error('asked for a recovery code')
  }
  const open = (files: DbFiles, packaged: boolean, o: { keystore?: Keystore; askCode?: (tryCode: (code: string) => Promise<void>) => Promise<void> } = {}) =>
    prepareDatabase({ files, packaged, keystore: o.keystore ?? pc, askCode: o.askCode ?? neverAsk, kdf: KDF })

  test('which form a build wants: packaged encrypted; development plain unless switched on', () => {
    assert.equal(wantedFormat(true, false), 'encrypted')
    assert.equal(wantedFormat(false, false), 'plain')
    assert.equal(wantedFormat(false, true), 'encrypted')
    // Never set: as it is (only a switch turned off decrypts).
    assert.equal(wantedFormat(false, null), null)
    assert.equal(wantedFormat(true, null), 'encrypted')
  })

  test('a development build stays plain by default: nothing is converted, no key file is made, the file is not touched', async () => {
    const { files } = plainInstall()
    const before = readFileSync(files.dbFile)
    const p = await open(files, false)
    assert.equal(p.key, null)
    assert.equal(p.conversionError, null)
    assert.ok(readFileSync(files.dbFile).equals(before))
    assert.ok(!existsSync(files.keyFile) && !existsSync(files.switchFile))
    assert.equal(sessionKey(), null)
    // A new development install too.
    const fresh = dbFiles(folder(), join(root, `bk-${n++}`))
    assert.equal((await open(fresh, false)).key, null)
    db.openDb(fresh.dbFile, { key: null })
    db.closeDb()
    assert.equal(fileKind(fresh.dbFile), 'plain')
    assert.ok(!existsSync(fresh.keyFile))
  })

  test('a new packaged install is encrypted from the first launch, its key file beside it and, from the first backup, beside the backups', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const p = await open(files, true)
    assert.ok(p.key && p.key.length === 32)
    db.openDb(files.dbFile, { key: p.key })
    db.addFact(SECRET)
    assert.ok(!existsSync(join(files.backupsDir, 'finance.key')))
    await dailyBackup(files.backupsDir)
    db.closeDb()
    assert.equal(fileKind(files.dbFile), 'other')
    noPlaintext(files.dbFile)
    const kf = readKeyFile(files.keyFile)
    assert.ok(kf.dpapi && kf.recovery === null)
    assert.ok(readFileSync(join(files.backupsDir, 'finance.key')).equals(readFileSync(files.keyFile)))
    // The next launch opens it with the keystore, asking nothing.
    assert.ok((await open(files, true)).key!.equals(p.key))
  })

  test('a packaged install from before encryption (beta 4) is converted at its first launch, backups and all', async () => {
    const { files } = plainInstall()
    const backups = await withPlainBackups(files)
    const p = await open(files, true)
    assert.equal(p.conversionError, null)
    assertConverted(files, p.key!, backups)
    assert.ok(sessionKey()!.equals(p.key!))
  })

  test('the development switch encrypts at the next launch, and turned off again decrypts', async () => {
    const { files } = plainInstall()
    const backups = await withPlainBackups(files)
    writeEncryptSwitch(files.switchFile, true)
    assert.equal(readEncryptSwitch(files.switchFile), true)
    const on = await open(files, false)
    assertConverted(files, on.key!, backups)
    assert.equal(sessionKeyHex(), on.key!.toString('hex'))
    writeEncryptSwitch(files.switchFile, false)
    const off = await open(files, false)
    assert.equal(off.key, null)
    assertConverted(files, on.key!, backups, 'plain')
    assert.ok(!existsSync(files.keyFile))
    assert.equal(sessionKey(), null)
  })

  test('a conversion that fails says so and the app opens the data as it was', async () => {
    const { files } = plainInstall()
    const p = await prepareDatabase({ files, packaged: true, keystore: pc, askCode: neverAsk, hook: (pt) => { if (pt === 'copy-written') throw new Error('ENOSPC: no space left on device') } })
    assert.ok(p.conversionError && !p.conversionError.swapped)
    assert.equal(p.key, null)
    assert.equal(count(files.dbFile, null), 30)
    // It tries again at the next launch, with the same key file.
    const again = await open(files, true)
    assert.equal(again.conversionError, null)
    assert.equal(count(files.dbFile, again.key), 30)
  })

  test('on another computer or account the recovery code opens it, once: the key is sealed again for this one', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const first = await open(files, true)
    db.openDb(files.dbFile, { key: first.key })
    db.closeDb()
    // The code saved on the first computer.
    issueRecoveryCode()
    const code = (await import('../src/main/dbopen.ts')).pendingRecoveryCode()!
    await confirmRecoveryCode(files.backupsDir, pc, KDF)
    setSession(null)

    const other = keystoreOf('new laptop')
    const tries: string[] = []
    const p = await open(files, true, {
      keystore: other,
      askCode: async (tryCode) => {
        for (const c of [newRecoveryCode(), code]) {
          tries.push(c)
          try {
            await tryCode(c)
            return
          } catch (err) {
            assert.ok(err instanceof KeyFileError && err.problem === 'code')
          }
        }
      }
    })
    assert.equal(tries.length, 2)
    assert.ok(p.key!.equals(first.key!))
    assert.ok(unwrapWithKeystore(readKeyFile(files.keyFile), other).equals(first.key!))
    // Asked once: the next launch there needs no code.
    assert.ok((await open(files, true, { keystore: other })).key!.equals(first.key!))
    // Closing the window instead of entering the code quits.
    await assert.rejects(open(files, true, { keystore: keystoreOf('third'), askCode: async () => Promise.reject(new UnlockCancelled()) }), UnlockCancelled)
  })

  test('an encrypted database whose key file is gone gets it back from beside the backups, or says where it is kept', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const first = await open(files, true)
    db.openDb(files.dbFile, { key: first.key })
    await dailyBackup(files.backupsDir)
    db.closeDb()
    rmSync(files.keyFile)
    assert.ok((await open(files, true)).key!.equals(first.key!))
    assert.ok(existsSync(files.keyFile))
    rmSync(files.keyFile)
    rmSync(join(files.backupsDir, 'finance.key'))
    await assert.rejects(open(files, true), /key file is missing/)
  })

  test('without an OS keystore a plain database stays plain rather than asking for a code at every launch', async () => {
    const { files } = plainInstall()
    const p = await open(files, true, { keystore: keystoreOf('no keyring', false) })
    assert.equal(p.key, null)
    assert.equal(fileKind(files.dbFile), 'plain')
  })

  test('the recovery code: pending until one is saved, then checked, then replaced', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    await open(files, true)
    assert.equal(recoveryPending(), true)
    const shown = issueRecoveryCode()
    // Not sealed in until confirmed: a second one shown replaces the first.
    const second = issueRecoveryCode()
    assert.notEqual(shown, second)
    assert.equal(recoveryPending(), true)
    // The first code saved: sealed in, nothing else changes.
    assert.deepEqual(await confirmRecoveryCode(files.backupsDir, pc, KDF), { rekey: false })
    assert.equal(recoveryPending(), false)
    assert.equal(await checkRecoveryCode(second), true)
    assert.equal(await checkRecoveryCode(shown), false)
    assert.ok(readFileSync(join(files.backupsDir, 'finance.key')).equals(readFileSync(files.keyFile)))
    assert.equal(readKeyFile(files.keyFile).next, null)
    issueRecoveryCode()
    // Shown but not confirmed: the saved code still works.
    assert.equal(await checkRecoveryCode(second), true)
    // A code replacing a saved one: the old one stops opening the key file, and a new key waits for the next start.
    assert.deepEqual(await confirmRecoveryCode(files.backupsDir, pc, KDF), { rekey: true })
    assert.equal(await checkRecoveryCode(second), false)
    assert.ok(readKeyFile(files.keyFile).next)
  })
})

describe('backups and restores', () => {
  const pc = keystoreOf('pc')
  const neverAsk = async (): Promise<void> => {
    throw new Error('asked for a recovery code')
  }

  /** An encrypted install with its data open and a recovery code saved. */
  async function install(machine: Keystore): Promise<{ files: DbFiles; key: Buffer; code: string }> {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const p = await prepareDatabase({ files, packaged: true, keystore: machine, askCode: neverAsk, kdf: KDF })
    const code = issueRecoveryCode()
    await confirmRecoveryCode(files.backupsDir, machine, KDF)
    db.closeDb()
    seed(files.dbFile, p.key)
    db.openDb(files.dbFile, { key: p.key })
    return { files, key: p.key!, code }
  }

  test('an encrypted install\'s backups are encrypted under its key, with its key file beside them', async () => {
    const { files, key } = await install(pc)
    const path = await bulkBackup(files.backupsDir, new Date(2026, 9, 22, 9))
    assert.equal(fileKind(path), 'other')
    noPlaintext(path)
    checkBackupFile(path, key)
    assert.throws(() => checkBackupFile(path, null), /another key/)
    assert.throws(() => checkBackupFile(path, newDbKey()), /another key/)
    assert.ok(readFileSync(join(files.backupsDir, 'finance.key')).equals(readFileSync(files.keyFile)))
  })

  test('restored on the same install, a backup opens with the install\'s own key', async () => {
    const { files, key } = await install(pc)
    const path = await bulkBackup(files.backupsDir, new Date(2026, 9, 22, 9))
    assert.deepEqual(await keyForBackup(path, { currentKey: key, keystore: pc }), { key })
    // Moved elsewhere on this computer without the install open: the key file beside it, through the keystore.
    const moved = join(folder(), 'finance-20261022-090000.db')
    copyFileSync(path, moved)
    copyFileSync(files.keyFile, moved.replace(/\.db$/, '.key'))
    const found = await keyForBackup(moved, { currentKey: null, keystore: pc })
    assert.ok('key' in found && found.key!.equals(key))
  })

  test('on another computer only the recovery code opens it, and the restore re-encrypts it under that install\'s key', async () => {
    const a = await install(pc)
    const path = await bulkBackup(a.files.backupsDir, new Date(2026, 9, 22, 9))
    db.closeDb()
    setSession(null)
    const laptop = keystoreOf('laptop')
    const b = await install(laptop)
    // The backup folder copied over from the first computer.
    const there = join(folder(), 'bulk-20261022-090000.db')
    copyFileSync(path, there)
    copyFileSync(join(a.files.backupsDir, 'finance.key'), join(dirname(there), 'finance.key'))
    assert.deepEqual(await keyForBackup(there, { currentKey: b.key, keystore: laptop }), { needsCode: true })
    await assert.rejects(keyForBackup(there, { currentKey: b.key, keystore: laptop, code: newRecoveryCode() }), (e: unknown) => e instanceof KeyFileError && e.problem === 'code')
    const found = await keyForBackup(there, { currentKey: b.key, keystore: laptop, code: a.code.toLowerCase() })
    assert.ok('key' in found && found.key!.equals(a.key))
    // What restore does: the backup in this install's form, checked, then opened.
    const staged = join(dirname(b.files.dbFile), 'finance.restore.tmp')
    copyDatabase(there, found.key, staged, b.key)
    checkBackupFile(staged, b.key)
    db.closeDb()
    copyFileSync(staged, b.files.dbFile)
    db.openDb(b.files.dbFile, { key: b.key })
    assert.equal(db.listFacts().map((f) => f.text).includes('Rent is due on the 1st'), true)
    assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM transactions')!.n, 30)
  })

  test('a backup without its key file beside it is refused with what to put there', async () => {
    const a = await install(pc)
    const path = await bulkBackup(a.files.backupsDir, new Date(2026, 9, 22, 9))
    const alone = join(folder(), 'lonely.db')
    copyFileSync(path, alone)
    await assert.rejects(keyForBackup(alone, { currentKey: newDbKey(), keystore: keystoreOf('elsewhere') }), /key file/)
    // And a file that isn't a database at all.
    const empty = join(folder(), 'x.db')
    writeFileSync(empty, '')
    await assert.rejects(keyForBackup(empty, { currentKey: null, keystore: pc }), /Not a SQLite database/)
  })

  test('an old plain backup still restores, and is encrypted on the way in', async () => {
    const plain = join(folder(), 'daily-20261001.db')
    seed(plain, null)
    const { files, key } = await install(pc)
    assert.deepEqual(await keyForBackup(plain, { currentKey: key, keystore: pc }), { key: null })
    checkBackupFile(plain, null)
    const staged = join(dirname(files.dbFile), 'finance.restore.tmp')
    copyDatabase(plain, null, staged, key)
    assert.equal(fileKind(staged), 'other')
    noPlaintext(staged)
    checkBackupFile(staged, key)
    assert.equal(count(staged, key), 30)
  })

  test('Delete all data removes the key file, the switch and whatever a conversion left, with the database', async () => {
    const { files } = await install(pc)
    await bulkBackup(files.backupsDir, new Date(2026, 9, 22, 9))
    writeEncryptSwitch(files.switchFile, true)
    const f = conversionFiles(files.dbFile)
    const leftovers = [f.marker, f.encTmp, f.pre, f.restoreTmp, `${files.dbFile}.restore.tmp`, join(dirname(files.dbFile), 'finance.restore.back'), `${files.keyFile}.tmp`, `${f.marker}.tmp`, `${files.switchFile}.tmp`, join(dirname(files.dbFile), 'finance-0123abcd.key')]
    for (const p of leftovers) writeFileSync(p, 'x')
    assert.ok(existsSync(join(dirname(files.dbFile), 'finance.key-copy.json')))
    removeData(files.dbFile, [files.dbFile, files.keyFile, files.switchFile, files.backupsDir])
    assert.deepEqual(filesIn(dirname(files.dbFile)), [])
    assert.equal(sessionKey(), null)
  })
})

describe('the review\'s tool server', () => {
  /** Starts mcp-server.ts on the file and asks it for the accounts. */
  function ask(file: string, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', tsEsm, join(here, '..', 'src', 'main', 'mcp-server.ts')], { env: { ...process.env, FINANCE_DB: file, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        if (out.includes('"id":2')) child.stdin.end()
      })
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('close', (code) => resolve({ code, out, err }))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } })}\n`)
    })
  }

  test('opens an encrypted database with the key from its environment, and nothing without it', async () => {
    const file = join(folder(), 'finance.db')
    const key = newDbKey()
    seed(file, key)
    const ok = await ask(file, { FINANCE_DB_KEY: key.toString('hex') })
    assert.match(ok.out, /Checking/, ok.err)
    const none = await ask(file, {})
    assert.notEqual(none.code, 0)
    assert.match(none.err, /not a database/)
    const bad = await ask(file, { FINANCE_DB_KEY: 'abc' })
    assert.match(bad.err, /FINANCE_DB_KEY is not a database key/)
  })
})
