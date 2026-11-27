import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as db from '../src/main/db.ts'

// A bank sync stores every account the bridge sends, on every plan: no plan
// limits accounts. The bridge is a fake fetch; the OS
// keystore is the demo dump's Electron stand-in, its encryption swapped for
// plain bytes so the access URL can be kept.

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'ft-simplefin-'))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})
const electron = (await import('../scripts/demo-electron.ts')) as { safeStorage: Record<string, unknown> }
Object.assign(electron.safeStorage, {
  isEncryptionAvailable: (): boolean => true,
  getSelectedStorageBackend: (): string => 'dpapi',
  encryptString: (s: string): Buffer => Buffer.from(s),
  decryptString: (b: Buffer): string => b.toString()
})
const { saveSecret } = await import('../src/main/secrets.ts')
const { sync } = await import('../src/main/simplefin.ts')
const { planState } = await import('../src/main/license.ts')

const DAY = 86_400
/** The accounts the fake bridge sends, by its ids; each has one coffee three days ago. */
let bank: string[] = []
const realFetch = globalThis.fetch
before(() => {
  db.openDb(join(dir, 'test.db'))
  globalThis.fetch = (async () => {
    const t = db.now()
    const accounts = bank.map((id, i) => ({ id, name: `Account ${i + 1}`, conn_id: 'CON-1', currency: 'USD', balance: '100.00', 'balance-date': t, transactions: [{ id: `${id}-t1`, posted: t - 3 * DAY, amount: '-4.50', description: 'BLUE BOTTLE COFFEE' }] }))
    return new Response(JSON.stringify({ connections: [{ conn_id: 'CON-1', name: 'First Bank' }], accounts }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const fed = (): string[] =>
  db
    .listAccounts()
    .filter((a) => a.source === 'simplefin')
    .map((a) => a.id)
    .sort()

describe('a bank sync on Free', () => {
  test('stores every account the bridge sends: five at the first sync, and a sixth the bank adds later', async () => {
    assert.equal(planState().plan, 'free')
    saveSecret('simplefinAccessUrl', 'https://user:secret@bridge.test.invalid/simplefin')
    bank = ['a1', 'a2', 'a3', 'a4', 'a5']
    const first = await sync()
    assert.deepEqual(fed(), bank.map((id) => `sf:CON-1:${id}`))
    assert.equal(first.accounts, 5)
    assert.deepEqual(first.warnings, [])
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE account_id LIKE 'sf:%'")?.n, 5)
    bank = [...bank, 'a6']
    const again = await sync()
    assert.deepEqual(fed(), bank.map((id) => `sf:CON-1:${id}`))
    assert.equal(again.accounts, 6)
    assert.deepEqual(again.warnings, [])
  })

  test('a feed merged into another account stays gone when the bank still sends it', async () => {
    db.mergeAccounts('sf:CON-1:a1', 'sf:CON-1:a2')
    const r = await sync()
    assert.deepEqual(fed(), bank.slice(1).map((id) => `sf:CON-1:${id}`))
    assert.equal(r.accounts, 5)
    // Both feeds carry the same coffee, kept once.
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE account_id = 'sf:CON-1:a2'")?.n, 1)
  })
})
