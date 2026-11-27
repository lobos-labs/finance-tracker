import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Back up now and Restore backup as Settings → Data runs them (ipc.ts), over
// the demo dump's Electron stand-in: dialogs answer what the test says, and
// the stand-in's keystore is unavailable, as on a computer where the
// backup's key file wasn't sealed. A backup from another install asks for
// its recovery code; a wrong one is refused; the right one restores it,
// re-encrypted under this install's key. An old plain backup restores
// encrypted.

const here = dirname(fileURLToPath(import.meta.url))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})

const electron = await import('../scripts/demo-electron.ts')
const db = await import('../src/main/db.ts')
const { bulkBackup } = await import('../src/main/backup.ts')
const { configureBuild } = await import('../src/main/devBuild.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { confirmRecoveryCode, dbFiles, issueRecoveryCode, prepareDatabase } = await import('../src/main/dbopen.ts')
const { setSession } = await import('../src/main/dbsession.ts')
const { DatabaseSync, fileKind } = await import('../src/main/sqlite.ts')
type Keystore = import('../src/main/dbkey.ts').Keystore

const root = mkdtempSync(join(tmpdir(), 'finance-restore-'))
after(() => {
  db.closeDb()
  rmSync(root, { recursive: true, force: true })
})

function keystoreOf(machine: string): Keystore {
  const secret = createHash('sha256').update(`keystore ${machine}`).digest()
  return {
    available: () => true,
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
const KDF = { N: 2 ** 10, r: 8, p: 1 }
const neverAsk = async (): Promise<void> => {
  throw new Error('asked for a recovery code')
}

// The first computer: an encrypted install with a fact, a saved recovery code and a backup.
const dirA = join(root, 'a')
mkdirSync(dirA, { recursive: true })
const filesA = dbFiles(dirA, join(dirA, 'backups'))
const a = await prepareDatabase({ files: filesA, packaged: true, keystore: keystoreOf('first computer'), askCode: neverAsk, kdf: KDF })
db.openDb(filesA.dbFile, { key: a.key })
db.addFact('Written on the first computer')
const codeA = issueRecoveryCode()
await confirmRecoveryCode(filesA.backupsDir, keystoreOf('first computer'), KDF)
const backupA = await bulkBackup(filesA.backupsDir, new Date(2026, 9, 21, 8))
db.closeDb()
setSession(null)

// This computer: the app as registerIpc runs it, on its own encrypted database.
electron.setBase(join(root, 'b'), '0.0.0-test')
configureBuild({ packaged: true })
configureLicense({ dev: true })
const userData = electron.app.getPath('userData')
mkdirSync(userData, { recursive: true })
const filesB = dbFiles(userData, join(userData, 'backups'))
const b = await prepareDatabase({ files: filesB, packaged: true, keystore: keystoreOf('this computer'), askCode: neverAsk, kdf: KDF })
db.openDb(filesB.dbFile, { key: b.key })
db.addFact('Written on this computer')
const { registerIpc } = await import('../src/main/ipc.ts')
registerIpc()

const event = { senderFrame: { url: 'file:///app/index.html' } }
type Envelope = { ok: true; data: unknown } | { ok: false; error: string }
const invoke = async (channel: string, ...args: unknown[]): Promise<Envelope> => (await electron.handlers.get(channel)!(event, ...args)) as Envelope
const pick = (file: string): void => {
  electron.dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof electron.dialog.showOpenDialog
}
electron.dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof electron.dialog.showMessageBox

/** The facts in this install's database, opened with its own key. */
function facts(): string[] {
  db.closeDb()
  db.openDb(filesB.dbFile, { key: b.key })
  return db.listFacts().map((f) => f.text)
}

describe('Settings → Data on an encrypted install', () => {
  test('Back up now writes an encrypted copy with its key file beside it', async () => {
    const out = join(root, 'elsewhere', 'finance-copy.db')
    mkdirSync(dirname(out), { recursive: true })
    electron.dialog.showSaveDialog = (async () => ({ canceled: false, filePath: out })) as unknown as typeof electron.dialog.showSaveDialog
    const r = await invoke('backupNow')
    assert.deepEqual(r, { ok: true, data: out })
    assert.equal(fileKind(out), 'other')
    assert.ok(readFileSync(join(dirname(out), 'finance-copy.key')).equals(readFileSync(filesB.keyFile)))
  })

  test('a backup from another computer asks for its recovery code, refuses a wrong one, and restores with the right one', async () => {
    pick(backupA)
    const asked = await invoke('restoreBackup')
    assert.deepEqual(asked, { ok: true, data: { needsCode: 'bulk-20261021-080000.db' } })
    const wrong = await invoke('restoreBackupCode', 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA')
    assert.equal(wrong.ok, false)
    assert.match((wrong as { error: string }).error, /does not open this backup/)
    assert.deepEqual(facts(), ['Written on this computer'])
    const done = await invoke('restoreBackupCode', codeA.toLowerCase())
    assert.deepEqual(done, { ok: true, data: backupA })
    // Restored, and re-encrypted under this install's key: the first computer's key doesn't open it.
    assert.equal(fileKind(filesB.dbFile), 'other')
    assert.deepEqual(facts(), ['Written on the first computer'])
    db.closeDb()
    assert.throws(() => new DatabaseSync(filesB.dbFile, { readOnly: true, key: a.key }), /not a database/)
    db.openDb(filesB.dbFile, { key: b.key })
    // The database of a moment before was kept as a bulk backup.
    assert.ok(existsSync(filesB.backupsDir))
  })

  test('an old plain backup restores, encrypted on the way in', async () => {
    const plain = join(root, 'old', 'daily-20260901.db')
    mkdirSync(dirname(plain), { recursive: true })
    db.closeDb()
    db.openDb(plain, { key: null })
    db.addFact('From a plain backup')
    db.closeDb()
    db.openDb(filesB.dbFile, { key: b.key })
    pick(plain)
    const r = await invoke('restoreBackup')
    assert.deepEqual(r, { ok: true, data: plain })
    assert.equal(fileKind(filesB.dbFile), 'other')
    assert.ok(!readFileSync(filesB.dbFile).includes(Buffer.from('From a plain backup')))
    assert.deepEqual(facts(), ['From a plain backup'])
  })

  test('a restore that can\'t replace the database leaves it whole as it was, and nothing beside it', { skip: process.platform !== 'win32' && 'needs Windows file locking' }, async () => {
    const before = facts()
    const plain = join(root, 'old', 'daily-20260902.db')
    db.closeDb()
    db.openDb(plain, { key: null })
    db.addFact('Never restored')
    db.closeDb()
    db.openDb(filesB.dbFile, { key: b.key })
    // Another program has the database open (a review's tool server left running, say): the swap can't happen.
    const holder = new DatabaseSync(filesB.dbFile, { key: b.key })
    let r: Envelope
    try {
      pick(plain)
      r = await invoke('restoreBackup')
    } finally {
      holder.close()
      // A restore that fails goes on syncing; the test stops it again.
      await (await import('../src/main/ipc-sync.ts')).holdSync()
    }
    assert.equal(r.ok, false)
    assert.deepEqual(facts(), before)
    assert.deepEqual(readdirSync(userData).filter((n) => n.includes('.restore')), [])
  })
})
