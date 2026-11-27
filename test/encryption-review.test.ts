import { after, afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3-multiple-ciphers'
import * as db from '../src/main/db.ts'
import { bulkBackup, checkBackupFile, dailyBackup, listBackups, writeBackup } from '../src/main/backup.ts'
import { createKeyFile, keyId, newDbKey, readKeyFile, unwrapWithCode, unwrapWithKeystore, writeKeyFile, type AccountSeal, type KdfParams, type Keystore } from '../src/main/dbkey.ts'
import { ConversionError, conversionFiles, convertDatabase, KILL_POINTS, readMarker, writeMarker, type KillPoint } from '../src/main/dbconvert.ts'
import { checkRecoveryCode, confirmRecoveryCode, dbFiles, issueRecoveryCode, keyForBackup, keySealScope, opensWith, pendingRecoveryCode, prepareDatabase, recoveryFileProblem, recoveryPending, writeEncryptSwitch, type DbFiles } from '../src/main/dbopen.ts'
import { KEY_COPY_NOTE, sessionKey, setSession } from '../src/main/dbsession.ts'
import { windowsAccountSeal } from '../src/main/dpapi.ts'
import { copyDatabase, DatabaseSync, fileKind } from '../src/main/sqlite.ts'

// The encryption review (docs/security-audit.md, "Encryption review"): one
// or more tests per finding, against scratch folders. The conversion's crash
// points run in a child process that is killed there (fixtures/convert-crash.ts).

const here = dirname(fileURLToPath(import.meta.url))
const tsEsm = pathToFileURL(join(here, 'ts-esm.mjs')).href
const win32 = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'finance-encreview-'))
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

function sealer(secretLabel: string): { seal: (d: Buffer) => Buffer; open: (b: Buffer) => Buffer } {
  const secret = createHash('sha256').update(secretLabel).digest()
  return {
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

/** A Windows account's DPAPI, stood in for: what it seals, only the same account opens. Counts its calls. */
function accountOf(user: string): AccountSeal & { calls: { seal: number; open: number } } {
  const s = sealer(`dpapi ${user}`)
  const calls = { seal: 0, open: 0 }
  return {
    calls,
    seal: (d) => {
      calls.seal++
      return s.seal(d)
    },
    open: (b) => {
      calls.open++
      return s.open(b)
    }
  }
}

/** One installation's safeStorage (its own Local State), with an account seal beside it or not. */
function keystoreOf(install: string, o: { account?: AccountSeal | null; seal?: (d: Buffer) => Buffer } = {}): Keystore {
  const s = sealer(`local state ${install}`)
  return { available: () => true, seal: o.seal ?? s.seal, open: s.open, account: o.account ?? null }
}

const KDF: KdfParams = { N: 2 ** 10, r: 8, p: 1 }
const SECRET = 'SECRET-MERCHANT-4419'
const pc = keystoreOf('pc')
const neverAsk = async (): Promise<void> => {
  throw new Error('asked for a recovery code')
}

interface OpenOpts {
  keystore?: Keystore
  hook?: (p: KillPoint) => void
  askCode?: (tryCode: (code: string) => Promise<void>) => Promise<void>
}
const open = (files: DbFiles, packaged: boolean, o: OpenOpts = {}) => prepareDatabase({ files, packaged, keystore: o.keystore ?? pc, askCode: o.askCode ?? neverAsk, kdf: KDF, hook: o.hook })

function seed(file: string, key: Buffer | null, rows = 30, from = 0): void {
  db.openDb(file, { key })
  db.upsertAccount({ id: 'acct:1', source: 'csv', name: 'Checking', institution: 'Test Bank', currency: 'USD', balanceCents: 100, availableCents: null, balanceDate: 1_790_000_000 })
  db.inTransaction(() => {
    for (let i = from; i < from + rows; i++) db.upsertTransaction({ id: `t${i}`, accountId: 'acct:1', posted: 1_790_000_000 + i * 86_400, amountCents: -(100 + i), description: `${SECRET} #${i}`, pending: false })
  })
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

const holdsPlaintext = (file: string): boolean => readFileSync(file).includes(Buffer.from(SECRET))

function plainInstall(): DbFiles {
  const dir = folder()
  const files = dbFiles(dir, join(dir, 'backups'))
  seed(files.dbFile, null)
  return files
}

/** The app's plain backups, as beta 4 made them: a daily one and one before an upgrade. */
async function plainBackups(files: DbFiles): Promise<string[]> {
  db.openDb(files.dbFile, { key: null })
  const a = await dailyBackup(files.backupsDir, new Date(2026, 9, 20))
  const b = await writeBackup(files.backupsDir, 'pre-v32-20261021-090000.db', 3)
  db.closeDb()
  return [a!, b]
}

/** The app's backups in the folder that are still plaintext. */
const plainBackupsIn = (dir: string): string[] => readdirSync(dir).filter((n) => /\.db$/.test(n) && fileKind(join(dir, n)) === 'plain')

const crash = (files: DbFiles, key: Buffer, to: string, point: string, newKey?: Buffer): void => {
  const r = spawnSync(process.execPath, ['--import', tsEsm, join(here, 'fixtures', 'convert-crash.ts'), files.dbFile, files.backupsDir, files.keyFile, key.toString('hex'), to, point, ...(newKey ? [newKey.toString('hex')] : [])], { encoding: 'utf8' })
  assert.ok(r.stdout.includes(`killed at ${point.split(':')[0]}`) && r.status !== 0, `${point}: the child wasn't stopped there (${r.status} ${r.stdout} ${r.stderr})`)
}

describe('an unfinished conversion to plain never leaves the data under a key no key file holds', () => {
  test('Encrypted off with the backups unfinished, then on again: a new key file, and the data opens at every launch after', async () => {
    const files = plainInstall()
    await plainBackups(files)
    writeEncryptSwitch(files.switchFile, true)
    const first = await open(files, false)
    const k1 = first.key!
    writeEncryptSwitch(files.switchFile, false)
    const off = await open(files, false, { hook: (p) => { if (p === 'fresh-backup') throw new Error('EBUSY: resource busy or locked') } })
    assert.ok(off.conversionError?.swapped)
    assert.equal(fileKind(files.dbFile), 'plain')
    writeEncryptSwitch(files.switchFile, true)
    const on = await open(files, false)
    assert.equal(on.conversionError, null)
    assert.equal(fileKind(files.dbFile), 'other')
    // K1's key file went with the conversion to plain; the database is under a key its key file holds.
    assert.ok(!on.key!.equals(k1))
    assert.equal(readKeyFile(files.keyFile).id, keyId(on.key!))
    setSession(null)
    const again = await open(files, false)
    assert.ok(again.key!.equals(on.key!))
    assert.equal(count(files.dbFile, again.key), 30)
    for (const b of readdirSync(files.backupsDir).filter((x) => x.endsWith('.db'))) checkBackupFile(join(files.backupsDir, b), again.key)
  })

  test('the conversion refuses to encrypt under a key its key file doesn\'t hold', async () => {
    const files = plainInstall()
    const before = readFileSync(files.dbFile)
    const key = newDbKey()
    const run = (): unknown => convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to: 'encrypted' })
    assert.throws(run, (e: unknown) => e instanceof ConversionError && !e.swapped && /doesn't hold the key/.test(e.message))
    writeKeyFile(files.keyFile, await createKeyFile(newDbKey(), pc))
    assert.throws(run, (e: unknown) => e instanceof ConversionError && !e.swapped)
    assert.ok(readFileSync(files.dbFile).equals(before))
    assert.equal(readMarker(conversionFiles(files.dbFile).marker), null)
  })

  test('a development build without the switch file keeps the database as it is: it never decrypts what a packaged build encrypted', async () => {
    const files = plainInstall()
    const packaged = await open(files, true)
    setSession(null)
    const dev = await open(files, false)
    assert.ok(dev.key!.equals(packaged.key!))
    assert.equal(fileKind(files.dbFile), 'other')
    assert.equal(readMarker(conversionFiles(files.dbFile).marker), null)
    // Only the switch turned off decrypts.
    writeEncryptSwitch(files.switchFile, false)
    assert.equal((await open(files, false)).key, null)
    assert.equal(fileKind(files.dbFile), 'plain')
  })

  test('to plain, the key file stays while a backup is still encrypted under it', { skip: !win32 && 'needs Windows file locking' }, async () => {
    const files = plainInstall()
    const backups = await plainBackups(files)
    writeEncryptSwitch(files.switchFile, true)
    const on = await open(files, false)
    writeEncryptSwitch(files.switchFile, false)
    // Another program has one backup open: it can be neither converted nor removed.
    const holder = new DatabaseSync(backups[0], { readOnly: true, key: on.key })
    let off
    try {
      off = await open(files, false)
    } finally {
      holder.close()
    }
    assert.equal(off.conversionError, null)
    assert.deepEqual(off.left, ['daily-20261020.db'])
    assert.equal(fileKind(files.dbFile), 'plain')
    assert.ok(existsSync(files.keyFile))
    const found = await keyForBackup(backups[0], { currentKey: null, keystore: pc })
    assert.ok('key' in found && found.key!.equals(on.key!))
  })
})

describe('one backup that can\'t be converted holds up nothing', () => {
  test('a read-only plaintext backup is converted all the same', async () => {
    const files = plainInstall()
    const backups = await plainBackups(files)
    chmodSync(backups[0], 0o444)
    const p = await open(files, true)
    assert.equal(p.conversionError, null)
    assert.deepEqual(p.left, [])
    for (const b of backups) checkBackupFile(b, p.key)
    assert.deepEqual(plainBackupsIn(files.backupsDir), [])
  })

  test('a damaged plaintext backup is removed, not passed over as another key\'s, and the conversion finishes', async () => {
    const files = plainInstall()
    const backups = await plainBackups(files)
    truncateSync(backups[0], Math.floor(statSync(backups[0]).size / 3))
    const p = await open(files, true)
    assert.equal(p.conversionError, null)
    assert.ok(!existsSync(backups[0]))
    checkBackupFile(backups[1], p.key)
    assert.deepEqual(plainBackupsIn(files.backupsDir), [])
    assert.equal(readMarker(conversionFiles(files.dbFile).marker), null)
    assert.ok(!existsSync(conversionFiles(files.dbFile).pre))
  })

  test('a plaintext backup another program holds open is named once, and the rest finishes without it', { skip: !win32 && 'needs Windows file locking' }, async () => {
    const files = plainInstall()
    const backups = await plainBackups(files)
    const holder = new DatabaseSync(backups[0], { readOnly: true, key: null })
    let p
    try {
      p = await open(files, true)
    } finally {
      holder.close()
    }
    assert.equal(p.conversionError, null)
    assert.deepEqual(p.left, ['daily-20261020.db'])
    checkBackupFile(backups[1], p.key)
    assert.equal(readMarker(conversionFiles(files.dbFile).marker), null)
    assert.ok(!existsSync(conversionFiles(files.dbFile).pre))
    // Said once: the next launch doesn't bring it up again.
    setSession(null)
    assert.deepEqual((await open(files, true)).left, [])
  })

  test('the plaintext copy taken before the conversion is in the data folder, never the backups folder, and goes once the database is checked', async () => {
    const files = plainInstall()
    await plainBackups(files)
    const key = newDbKey()
    writeKeyFile(files.keyFile, await createKeyFile(key, pc))
    const f = conversionFiles(files.dbFile)
    crash(files, key, 'encrypted', 'backup-written')
    assert.equal(dirname(f.pre), dirname(files.dbFile))
    assert.ok(existsSync(f.pre) && holdsPlaintext(f.pre))
    assert.ok(!readdirSync(files.backupsDir).some((x) => x.startsWith('pre-encrypt')))
    rmSync(f.marker)
    rmSync(f.pre)
    crash(files, key, 'encrypted', 'pre-backup-removed')
    assert.ok(!existsSync(f.pre))
    assert.equal(readMarker(f.marker)?.step, 'backups')
    // The first version's copy beside the backups goes too.
    copyFileSync(join(files.backupsDir, 'daily-20261020.db'), join(files.backupsDir, 'pre-encrypt.db'))
    convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to: 'encrypted' })
    assert.ok(!existsSync(join(files.backupsDir, 'pre-encrypt.db')))
    assert.deepEqual(plainBackupsIn(files.backupsDir), [])
  })
})

describe('to plain, the key file goes last', () => {
  test('a crash after the marker went and before the key file did leaves a plain database that opens', async () => {
    const files = plainInstall()
    writeEncryptSwitch(files.switchFile, true)
    const on = await open(files, false)
    setSession(null)
    crash(files, on.key!, 'plain', 'marker-removed')
    assert.equal(fileKind(files.dbFile), 'plain')
    writeEncryptSwitch(files.switchFile, false)
    const p = await open(files, false)
    assert.equal(p.key, null)
    assert.equal(p.conversionError, null)
    assert.equal(count(files.dbFile, null), 30)
  })

  test('a marker left with its key file gone, over a plain database: it opens, and the marker is dropped', async () => {
    const files = plainInstall()
    const f = conversionFiles(files.dbFile)
    writeMarker(f.marker, { v: 1, to: 'plain', step: 'cleanup', census: null })
    writeEncryptSwitch(files.switchFile, false)
    const p = await open(files, false)
    assert.equal(p.key, null)
    assert.equal(count(files.dbFile, null), 30)
    assert.ok(!existsSync(f.marker))
  })
})

describe('a failure outside the conversion never stops a database that opens', () => {
  test('the marker can\'t be written right after the swap: the encrypted database opens, and a later launch finishes', async () => {
    const files = plainInstall()
    const backups = await plainBackups(files)
    const blocked = `${conversionFiles(files.dbFile).marker}.tmp`
    const first = await open(files, true, { hook: (p) => { if (p === 'swapped') mkdirSync(blocked) } })
    assert.ok(first.conversionError?.swapped)
    assert.equal(count(files.dbFile, first.key), 30)
    setSession(null)
    const second = await open(files, true)
    assert.ok(second.conversionError?.swapped)
    assert.equal(count(files.dbFile, second.key), 30)
    rmSync(blocked, { recursive: true })
    setSession(null)
    const third = await open(files, true)
    assert.equal(third.conversionError, null)
    for (const b of backups) checkBackupFile(b, third.key)
    assert.deepEqual(plainBackupsIn(files.backupsDir), [])
  })

  test('a key file that can\'t be made at the first launch after the upgrade: the plain database opens as it is, and the next launch converts it', async () => {
    const files = plainInstall()
    const broken = keystoreOf('pc', { seal: () => { throw new Error('safeStorage failed') } })
    const p = await open(files, true, { keystore: broken })
    assert.equal(p.key, null)
    assert.equal(fileKind(files.dbFile), 'plain')
    assert.equal(count(files.dbFile, null), 30)
    const q = await open(files, true)
    assert.equal(fileKind(files.dbFile), 'other')
    assert.equal(count(files.dbFile, q.key), 30)
  })

  test('a damaged marker: the step is read from the database (before the swap: start over; after: finish the backups)', async () => {
    const a = plainInstall()
    writeFileSync(conversionFiles(a.dbFile).marker, '{"v":1,')
    const pa = await open(a, true)
    assert.equal(pa.conversionError, null)
    assert.equal(fileKind(a.dbFile), 'other')
    assert.equal(count(a.dbFile, pa.key), 30)
    assert.equal(readMarker(conversionFiles(a.dbFile).marker), null)
    setSession(null)

    // Converted, with a plaintext backup the backups step never reached.
    const b = plainInstall()
    const pb0 = await open(b, true)
    setSession(null)
    const late = join(b.backupsDir, 'daily-20261001.db')
    mkdirSync(b.backupsDir, { recursive: true })
    seed(late, null)
    writeFileSync(conversionFiles(b.dbFile).marker, 'not json')
    const pb = await open(b, true)
    assert.equal(pb.conversionError, null)
    assert.ok(pb.key!.equals(pb0.key!))
    checkBackupFile(late, pb.key)
    assert.ok(!holdsPlaintext(late))
  })

  test('the key file\'s copy can\'t go beside the backups: the app opens all the same', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const p = await open(files, true)
    db.openDb(files.dbFile, { key: p.key })
    db.closeDb()
    setSession(null)
    // The backups folder is on a drive that's gone: here, a file where the folder should be.
    const gone = dbFiles(dir, join(dir, 'unplugged'))
    writeFileSync(gone.backupsDir, '')
    const q = await open(gone, true)
    assert.ok(q.key!.equals(p.key!))
  })
})

describe('a damaged key file comes back from its copy', () => {
  async function encryptedInstall(): Promise<{ files: DbFiles; key: Buffer }> {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const p = await open(files, true)
    db.openDb(files.dbFile, { key: p.key })
    await dailyBackup(files.backupsDir)
    db.closeDb()
    setSession(null)
    return { files, key: p.key! }
  }

  test('the copy beside the backups is put back, and the database opens', async () => {
    const { files, key } = await encryptedInstall()
    writeFileSync(files.keyFile, readFileSync(files.keyFile).subarray(0, 40))
    const p = await open(files, true)
    assert.ok(p.key!.equals(key))
    assert.equal(readKeyFile(files.keyFile).id, keyId(key))
  })

  test('the copy set aside under another name is found by opening the database with it', async () => {
    const { files, key } = await encryptedInstall()
    const copy = join(files.backupsDir, 'finance.key')
    copyFileSync(copy, join(files.backupsDir, 'finance-0badc0de.key'))
    writeKeyFile(copy, await createKeyFile(newDbKey(), pc))
    writeFileSync(files.keyFile, '{')
    const p = await open(files, true)
    assert.ok(p.key!.equals(key))
  })

  test('without a copy that opens it, the error names where the copies were looked for', async () => {
    const { files } = await encryptedInstall()
    rmSync(join(files.backupsDir, 'finance.key'))
    writeFileSync(files.keyFile, '{')
    await assert.rejects(open(files, true), (e: unknown) => e instanceof Error && /damaged/.test(e.message) && e.message.includes(files.backupsDir))
  })
})

describe('the account seal: the key opens for this Windows account, not only this data folder', () => {
  test('after a reinstall (a new Local State), the database and its backups open without the code', async () => {
    const me = accountOf('alex')
    const first = keystoreOf('install 1', { account: me })
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const p = await open(files, true, { keystore: first })
    db.openDb(files.dbFile, { key: p.key })
    const backup = await bulkBackup(files.backupsDir, new Date(2026, 9, 22, 9))
    db.closeDb()
    setSession(null)
    assert.ok(readKeyFile(files.keyFile).account)
    // Reinstalled: safeStorage has a new key; the same Windows account.
    const second = keystoreOf('install 2', { account: me })
    const q = await open(files, true, { keystore: second })
    assert.ok(q.key!.equals(p.key!))
    // Sealed again for the new install, so the account seal isn't needed next time.
    assert.ok(unwrapWithKeystore(readKeyFile(files.keyFile), keystoreOf('install 2')).equals(p.key!))
    // A backup kept from before the reinstall, with its key file copy beside it.
    const kept = join(folder(), 'bulk-20261022-090000.db')
    copyFileSync(backup, kept)
    copyFileSync(join(files.backupsDir, 'finance.key'), join(dirname(kept), 'finance.key'))
    const found = await keyForBackup(kept, { currentKey: null, keystore: keystoreOf('install 3', { account: me }) })
    assert.ok('key' in found && found.key!.equals(p.key!))
    // Another Windows account: only the recovery code.
    await assert.rejects(keyForBackup(kept, { currentKey: null, keystore: keystoreOf('install 4', { account: accountOf('someone else') }) }), /no recovery code/)
  })

  test('a key file from before the account seal gets one at the next launch, and later launches spawn nothing', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    const p = await open(files, true)
    setSession(null)
    assert.equal(readKeyFile(files.keyFile).account, null)
    const me = accountOf('alex')
    const ks = keystoreOf('pc', { account: me })
    await open(files, true, { keystore: ks })
    assert.ok(readKeyFile(files.keyFile).account)
    assert.deepEqual(me.calls, { seal: 1, open: 0 })
    setSession(null)
    const again = await open(files, true, { keystore: ks })
    assert.ok(again.key!.equals(p.key!))
    assert.deepEqual(me.calls, { seal: 1, open: 0 })
  })

  test('the line beside the code says how far the key file reaches', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    await open(files, true)
    assert.equal(keySealScope('win32'), 'install')
    assert.equal(keySealScope('darwin'), 'account')
    setSession(null)
    await open(files, true, { keystore: keystoreOf('pc', { account: accountOf('alex') }) })
    assert.equal(keySealScope('win32'), 'account')
  })

  test('DPAPI for this Windows account seals a key and opens it, and refuses a changed blob', { skip: !win32 && 'Windows only' }, () => {
    const seal = windowsAccountSeal('win32')!
    const key = newDbKey()
    const blob = seal.seal(key)
    assert.ok(!blob.includes(key))
    assert.ok(seal.open(blob).equals(key))
    blob[blob.length - 5] ^= 1
    assert.throws(() => seal.open(blob), /DPAPI unprotect failed/)
    assert.equal(windowsAccountSeal('darwin'), null)
  })
})

describe('a new recovery code moves the database onto a new key', () => {
  /** An encrypted install with data, a recovery code saved, and backups. */
  async function install(): Promise<{ files: DbFiles; key: Buffer; code: string; backups: string[] }> {
    const files = plainInstall()
    const backups = await plainBackups(files)
    const p = await open(files, true)
    const code = issueRecoveryCode()
    await confirmRecoveryCode(files.backupsDir, pc, KDF)
    db.openDb(files.dbFile, { key: p.key })
    backups.push(await bulkBackup(files.backupsDir, new Date(2026, 9, 22, 9)))
    db.closeDb()
    return { files, key: p.key!, code, backups }
  }

  test('the old key file and the old code open nothing written after; the new code opens everything', async () => {
    const { files, key, code, backups } = await install()
    // What someone may hold: a copy of the key file from before (a USB stick, OneDrive's version history) and the old code.
    const old = readKeyFile(files.keyFile)
    const code2 = issueRecoveryCode()
    assert.deepEqual(await confirmRecoveryCode(files.backupsDir, pc, KDF), { rekey: true })
    setSession(null)
    const p = await open(files, true)
    assert.equal(p.conversionError, null)
    assert.ok(!p.key!.equals(key))
    const kf = readKeyFile(files.keyFile)
    assert.equal(kf.id, keyId(p.key!))
    assert.equal(kf.next, null)
    assert.equal(count(files.dbFile, p.key), 30)
    const stolen = await unwrapWithCode(old, code)
    assert.ok(stolen.equals(key))
    assert.equal(opensWith(files.dbFile, stolen), false)
    for (const b of backups) {
      assert.equal(opensWith(b, stolen), false, b)
      checkBackupFile(b, p.key)
    }
    db.openDb(files.dbFile, { key: p.key })
    const later = await bulkBackup(files.backupsDir, new Date(2026, 9, 23, 9))
    db.closeDb()
    assert.equal(opensWith(later, stolen), false)
    assert.ok((await unwrapWithCode(kf, code2)).equals(p.key!))
    await assert.rejects(unwrapWithCode(kf, code))
    // Beside the backups: the new key file only.
    const keys = readdirSync(files.backupsDir).filter((x) => x.endsWith('.key'))
    assert.deepEqual(keys, ['finance.key'])
    assert.equal(readKeyFile(join(files.backupsDir, 'finance.key')).id, keyId(p.key!))
  })

  test('until the restart the new code opens the current key and the waiting one', async () => {
    const { files, key } = await install()
    const code2 = issueRecoveryCode()
    await confirmRecoveryCode(files.backupsDir, pc, KDF)
    const kf = readKeyFile(files.keyFile)
    assert.ok((await unwrapWithCode(kf, code2)).equals(key))
    const next = await unwrapWithCode(kf.next!, code2)
    assert.ok(unwrapWithKeystore(kf.next!, pc).equals(next))
    assert.equal(await checkRecoveryCode(code2), true)
  })

  test('a crash at any step of the move leaves data that opens with its key file, and the next launch finishes it', async () => {
    const points = [...KILL_POINTS, 'backup-file:2', 'backup-file-swapped:2'] as string[]
    for (const point of points) {
      const { files, key } = await install()
      issueRecoveryCode()
      await confirmRecoveryCode(files.backupsDir, pc, KDF)
      setSession(null)
      const next = unwrapWithKeystore(readKeyFile(files.keyFile).next!, pc)
      crash(files, key, 'rekey', point, next)
      // Whatever the crash left, a key in the key file opens the database.
      const kf = readKeyFile(files.keyFile)
      const held = [kf, ...(kf.next ? [kf.next] : [])].map((s) => unwrapWithKeystore(s, pc))
      assert.ok(held.some((k) => opensWith(files.dbFile, k)), `${point}: nothing in the key file opens the database`)
      const p = await open(files, true)
      assert.equal(p.conversionError, null, point)
      assert.ok(p.key!.equals(next), point)
      assert.equal(readKeyFile(files.keyFile).id, keyId(next), point)
      assert.equal(readKeyFile(files.keyFile).next, null, point)
      assert.equal(count(files.dbFile, next), 30, point)
      for (const b of readdirSync(files.backupsDir).filter((x) => x.endsWith('.db'))) assert.ok(opensWith(join(files.backupsDir, b), next), `${point}: ${b}`)
      setSession(null)
    }
  })

  test('a backup with a waiting key in the key file beside it opens with that key', async () => {
    const { files } = await install()
    issueRecoveryCode()
    await confirmRecoveryCode(files.backupsDir, pc, KDF)
    const next = unwrapWithKeystore(readKeyFile(files.keyFile).next!, pc)
    const out = join(folder(), 'moved.db')
    copyDatabase(files.dbFile, sessionKey(), out, next)
    copyFileSync(files.keyFile, join(dirname(out), 'moved.key'))
    const found = await keyForBackup(out, { currentKey: null, keystore: pc })
    assert.ok('key' in found && found.key!.equals(next))
  })
})

describe('resuming and settling', () => {
  test('rows written to the plain database after a crash before the swap (an older version ignores the marker) are kept', async () => {
    const files = plainInstall()
    const key = newDbKey()
    writeKeyFile(files.keyFile, await createKeyFile(key, pc))
    crash(files, key, 'encrypted', 'marker-swap')
    seed(files.dbFile, null, 10, 100)
    assert.equal(count(files.dbFile, null), 40)
    convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to: 'encrypted' })
    assert.equal(count(files.dbFile, key), 40)
  })

  test('a database another program is reading mid-transaction is not converted', async () => {
    const files = plainInstall()
    const key = newDbKey()
    writeKeyFile(files.keyFile, await createKeyFile(key, pc))
    const writer = new DatabaseSync(files.dbFile, { key: null })
    const reader = new DatabaseSync(files.dbFile, { key: null })
    try {
      writer.exec('PRAGMA journal_mode = WAL')
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM transactions').get()
      writer.exec('CREATE TABLE written_while_read (x); INSERT INTO written_while_read VALUES (1)')
      assert.throws(() => convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to: 'encrypted' }), (e: unknown) => e instanceof ConversionError && !e.swapped && /in use by another program/.test(e.message))
      assert.equal(fileKind(files.dbFile), 'plain')
      reader.exec('COMMIT')
    } finally {
      reader.close()
      writer.close()
    }
    convertDatabase({ dbFile: files.dbFile, backupsDir: files.backupsDir, keyFile: files.keyFile, key, to: 'encrypted' })
    assert.equal(count(files.dbFile, key), 30)
  })

  test('a backup an older version cut short (daily-….db.tmp, plaintext) is swept by the conversion', async () => {
    const files = plainInstall()
    await plainBackups(files)
    const cut = join(files.backupsDir, 'daily-20261019.db.tmp')
    copyFileSync(files.dbFile, cut)
    await open(files, true)
    assert.ok(!existsSync(cut))
    assert.deepEqual(plainBackupsIn(files.backupsDir), [])
  })
})

describe('backups', () => {
  test('a backup that fails leaves the older ones of its family in place and nothing half-written', async () => {
    const dir = folder()
    const key = newDbKey()
    seed(join(dir, 'k.db'), key)
    db.openDb(join(dir, 'k.db'), { key })
    for (let h = 1; h <= 3; h++) await bulkBackup(join(dir, 'backups'), new Date(2026, 9, 22, h))
    // The fourth can't be written: something sits where its temporary file goes.
    mkdirSync(join(dir, 'backups', 'bulk-20261022-040000.db.tmp'))
    await assert.rejects(bulkBackup(join(dir, 'backups'), new Date(2026, 9, 22, 4)))
    assert.deepEqual(listBackups(join(dir, 'backups'), 'bulk'), ['bulk-20261022-010000.db', 'bulk-20261022-020000.db', 'bulk-20261022-030000.db'])
    db.closeDb()
  })
})

describe('the key file\'s copy, before the database opens', () => {
  test('a missing key file is found in the folder its copy was last put in, though the backups folder isn\'t known yet', async () => {
    const dir = folder()
    const real = join(dir, 'Documents', 'Finance Tracker', 'Backups')
    const files = dbFiles(dir, real)
    const p = await open(files, true)
    db.openDb(files.dbFile, { key: p.key })
    await dailyBackup(real)
    db.closeDb()
    setSession(null)
    assert.ok(existsSync(join(dir, KEY_COPY_NOTE)))
    rmSync(files.keyFile)
    // A Store build names the legacy folder until the database is open.
    const before = dbFiles(dir, join(dir, 'legacy', 'documents', 'Backups'))
    const q = await open(before, true)
    assert.ok(q.key!.equals(p.key!))
    assert.ok(existsSync(files.keyFile))
  })
})

describe('saving the recovery code', () => {
  test('not in the documents or backups folder, nor beside a key file; anywhere else is fine', () => {
    const dir = folder()
    const docs = join(dir, 'Documents', 'Finance Tracker')
    const backups = join(docs, 'Backups')
    mkdirSync(backups, { recursive: true })
    const elsewhere = join(dir, 'Downloads')
    mkdirSync(elsewhere)
    const withKey = join(dir, 'usb')
    mkdirSync(withKey)
    writeFileSync(join(withKey, 'finance-20261022.key'), '{}')
    const places = [docs, backups]
    assert.match(recoveryFileProblem(join(docs, 'code.pdf'), places)!, /documents folder/)
    assert.match(recoveryFileProblem(join(backups, 'Tax', 'code.pdf'), places)!, /backups/)
    assert.match(recoveryFileProblem(join(withKey, 'code.pdf'), places)!, /key file/)
    assert.equal(recoveryFileProblem(join(elsewhere, 'Finance Tracker recovery code.pdf'), places), null)
    assert.equal(recoveryFileProblem(join(dir, 'code.pdf'), places), null)
  })

  test('a copy beside the backups that can\'t be written doesn\'t undo the save', async () => {
    const dir = folder()
    const files = dbFiles(dir, join(dir, 'backups'))
    await open(files, true)
    const code = issueRecoveryCode()
    const notAFolder = join(dir, 'gone')
    writeFileSync(notAFolder, '')
    assert.deepEqual(await confirmRecoveryCode(notAFolder, pc, KDF), { rekey: false })
    assert.equal(pendingRecoveryCode(), null)
    assert.equal(recoveryPending(), false)
    assert.equal(await checkRecoveryCode(code), true)
  })
})

describe('the key in memory', () => {
  test('a database keyed in the hex form (the first version) opens with the key given as bytes', () => {
    const file = join(folder(), 'hex.db')
    const key = newDbKey()
    const d = new Database(file)
    d.pragma("cipher = 'chacha20'")
    d.key(Buffer.from(`x'${key.toString('hex')}'`))
    d.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('hex keyed')")
    d.close()
    const o = new DatabaseSync(file, { readOnly: true, key })
    try {
      assert.deepEqual(o.prepare('SELECT x FROM t').get(), { x: 'hex keyed' })
    } finally {
      o.close()
    }
    const out = join(dirname(file), 'bytes.db')
    copyDatabase(file, key, out, key)
    assert.equal(opensWith(out, key), true)
    assert.equal(opensWith(out, newDbKey()), false)
  })
})

describe('what the app shows and removes', () => {
  const read = (p: string): string => readFileSync(join(here, '..', p), 'utf8')

  test('no Copy for the recovery code; the window is kept out of captures while a code is on it', () => {
    assert.doesNotMatch(read('src/main/ipc-database.ts'), /\bclipboard\.|import \{[^}]*\bclipboard\b[^}]*\} from 'electron'/)
    assert.doesNotMatch(read('src/preload/index.ts'), /copyRecoveryCode/)
    assert.match(read('src/main/unlock.ts'), /setContentProtection\(true\)/)
    assert.match(read('src/renderer/src/RecoveryCode.tsx'), /api\.protectWindow\(true\)/)
  })

  test('Delete all data takes the documents folder\'s path before the database closes', () => {
    const src = read('src/main/wipe.ts')
    assert.ok(src.indexOf('const docsPath = docsDir()') > 0 && src.indexOf('const docsPath = docsDir()') < src.indexOf('removeData('))
    assert.match(src, /remove\(docsPath\)/)
    assert.doesNotMatch(src, /remove\(docsDir\(\)\)/)
  })
})
