import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The open edition (FINANCE_TRACKER_EDITION=open, src/main/build.ts): Plus by
// the build, whatever token, trial or FINANCE_TRACKER_PLAN is there, with no
// call to the license server; SimpleFIN connects, syncs and disconnects in a
// packaged copy; the AI runs on the user's own key. Every other build decides
// as before, and a hosted ledger's account scope still wins. The license
// server is a fetch that fails the test when it's called; the IPC runs over
// the demo dump's Electron stand-in, its encryption swapped for plain bytes so
// the bridge's access URL can be kept, with a fake bridge behind fetch. The
// pages offer SimpleFIN's setup token where the main process takes it (the
// open edition, a development build with no server) and nowhere else, so the
// beta and the installer keep Plaid's button.

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'finance-open-edition-'))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})
const electron = await import('../scripts/demo-electron.ts')
Object.assign(electron.safeStorage, {
  isEncryptionAvailable: (): boolean => true,
  getSelectedStorageBackend: (): string => 'dpapi',
  encryptString: (s: string): Buffer => Buffer.from(s),
  decryptString: (b: Buffer): string => b.toString()
})
electron.setBase(dir, '0.0.0-test')

const db = await import('../src/main/db.ts')
const { BUILT_PROXY_URL, OPEN_EDITION } = await import('../src/main/build.ts')
const { configureBuild } = await import('../src/main/devBuild.ts')
const license = await import('../src/main/license.ts')
const { activate, bankToken, can, configureLicense, deactivate, hasToken, LICENSE_PUBLIC_KEY, LicenseError, machineId, openEdition, planState, refresh, refreshDue, serverUrl, startTrial, withPlan } = license
type Entitlement = import('../src/main/license.ts').Entitlement
type SecretStore = import('../src/main/license.ts').SecretStore
const { claudeCodeOffered, configureAi, getProvider, proxyAvailable, storedProvider } = await import('../src/main/ai/backend.ts')
const feed = await import('../src/main/bankFeed.ts')
const { FEATURES, TRIAL_DAYS } = await import('../src/shared/plans.ts')
const { bankPrimary } = await import('../src/renderer/src/pages/wizardFlow.ts')
type AppSettings = import('../src/shared/types.ts').AppSettings
// The renderer's lib reads window.api once, as it loads; a window only for that.
const g = globalThis as Record<string, unknown>
const hadWindow = 'window' in g
if (!hadWindow) g['window'] = {}
const lib = await import('../src/renderer/src/lib.ts')
if (!hadWindow) delete g['window']

const DAY = 86_400_000
const SERVER = 'https://license.test.invalid'

const memory = (): SecretStore => {
  let v: string | null = null
  return { read: () => v, write: (x) => void (v = x), clear: () => void (v = null) }
}

const pair = generateKeyPairSync('ed25519')
const publicKey = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x
const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')

/** A token as the server issues it, for this machine; `claims` overrides any field. */
function token(claims: Partial<Entitlement> = {}): string {
  const now = Date.now()
  const iat = Math.floor(now / 1000)
  const full: Entitlement = {
    iss: 'Finance Tracker',
    sub: createHash('sha256').update('key').digest('hex'),
    aud: 'desktop',
    iat,
    exp: iat + 30 * 86_400,
    plan: 'plus',
    features: FEATURES.map((f) => f.wire),
    paidThrough: new Date(now + 30 * DAY).toISOString(),
    graceDays: 21,
    machineId: machineId(),
    platform: 'test',
    ...claims
  }
  const head = b64url({ alg: 'EdDSA', typ: 'JWT', kid: 'test' })
  const body = b64url(full)
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`, 'ascii'), pair.privateKey).toString('base64url')}`
}

/** Every call the license server got; the test fails at the first. */
let serverCalls: string[] = []
const noServer = (async (url: string | URL | Request) => {
  serverCalls.push(String(url))
  assert.fail(`the open edition called the license server: ${String(url)}`)
}) as typeof fetch

let tokenStore = memory()
let keyStore = memory()
/** A packaged, shipped build (no development flag, no beta), with a server built in and a license server that must never be called. */
function reset(o: { openEdition: boolean }): void {
  tokenStore = memory()
  keyStore = memory()
  serverCalls = []
  configureBuild({ packaged: true })
  configureLicense({ publicKey, dev: false, proxyUrl: SERVER, betaUntil: '', platform: 'test', token: tokenStore, key: keyStore, freeToken: memory(), openEdition: o.openEdition, fetch: noServer })
  delete process.env['FINANCE_TRACKER_PLAN']
  for (const k of ['plan.trialStartedAt', 'plan.plusUntil', 'license.checkedAt', 'ai.provider']) db.setSetting(k, null)
}

before(() => {
  db.openDb(join(dir, 'finance.db'))
  configureAi({ backends: {} })
})
after(() => {
  // The module's own config again, as it loaded: nothing of this file's server, key pair or fetch stays.
  configureLicense({ publicKey: LICENSE_PUBLIC_KEY, dev: false, proxyUrl: BUILT_PROXY_URL, betaUntil: '', platform: process.platform, token: memory(), key: memory(), freeToken: memory(), openEdition: OPEN_EDITION, fetch: (...a) => fetch(...a) })
  configureBuild({ packaged: false })
  delete process.env['FINANCE_TRACKER_PLAN']
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('the open edition: the plan', () => {
  beforeEach(() => reset({ openEdition: true }))

  test('Plus with no license, trial, beta, development build or machine behind it, and every feature', () => {
    assert.equal(openEdition(), true)
    const { serverAvailable: _computed, ...p } = planState()
    assert.deepEqual(p, {
      plan: 'plus',
      openEdition: true,
      licensed: false,
      paidThrough: null,
      graceUntil: null,
      trialStarted: false,
      trialDaysLeft: 0,
      trialEndsAt: null,
      beta: false,
      betaUntil: null,
      dev: false,
      machineId: ''
    })
    for (const f of FEATURES) assert.equal(can(f.id), true, f.id)
  })

  test('no server, even one built in or set for a development run (any other build takes it)', () => {
    assert.equal(planState().serverAvailable, false)
    assert.equal(serverUrl(), null)
    const before = process.env['FINANCE_TRACKER_PROXY_URL']
    process.env['FINANCE_TRACKER_PROXY_URL'] = 'https://dev-server.test.invalid'
    try {
      configureLicense({ dev: true })
      assert.equal(serverUrl(), null)
      configureLicense({ openEdition: false })
      assert.equal(serverUrl(), 'https://dev-server.test.invalid')
      configureLicense({ dev: false })
      assert.equal(serverUrl(), SERVER)
    } finally {
      if (before === undefined) delete process.env['FINANCE_TRACKER_PROXY_URL']
      else process.env['FINANCE_TRACKER_PROXY_URL'] = before
    }
  })

  test('a held token that names fewer features cannot lower it (it does in any other build)', () => {
    tokenStore.write(token({ features: ['ai'] }))
    assert.equal(planState().plan, 'plus')
    assert.equal(planState().licensed, false)
    for (const f of FEATURES) assert.equal(can(f.id), true, f.id)
    configureLicense({ openEdition: false })
    assert.equal(planState().licensed, true)
    assert.equal(can('netWorth'), false)
  })

  test('a trial, running or ended, cannot lower it', () => {
    const started = Date.now() - 2 * DAY
    tokenStore.write(token({ plan: 'trial', sub: `trial:${createHash('sha256').update(machineId()).digest('hex')}`, exp: Math.floor((started + TRIAL_DAYS * DAY) / 1000), paidThrough: new Date(started + TRIAL_DAYS * DAY).toISOString(), graceDays: 0, trialStartedAt: new Date(started).toISOString(), trialEndsAt: new Date(started + TRIAL_DAYS * DAY).toISOString() }))
    let p = planState()
    assert.equal(p.plan, 'plus')
    assert.equal(p.trialStarted, false)
    assert.equal(p.trialDaysLeft, 0)
    tokenStore.clear()
    db.setSetting('plan.trialStartedAt', new Date(Date.now() - 30 * DAY).toISOString())
    p = planState()
    assert.equal(p.plan, 'plus')
    assert.equal(p.trialEndsAt, null)
    for (const f of FEATURES) assert.equal(can(f.id), true, f.id)
    // The same ended trial anywhere else: free.
    configureLicense({ openEdition: false })
    assert.equal(planState().plan, 'free')
  })

  test('FINANCE_TRACKER_PLAN cannot lower it, even where a development build reads it', () => {
    configureLicense({ dev: true })
    for (const v of ['free', 'trial']) {
      process.env['FINANCE_TRACKER_PLAN'] = v
      const p = planState()
      assert.equal(p.plan, 'plus', v)
      assert.equal(p.dev, false)
      assert.equal(can('ai'), true)
    }
    configureLicense({ openEdition: false })
    process.env['FINANCE_TRACKER_PLAN'] = 'free'
    assert.equal(planState().plan, 'free')
  })

  test('a hosted ledger\'s account scope still wins', () => {
    const p = withPlan({ plan: 'free' }, () => planState())
    assert.equal(p.plan, 'free')
    assert.equal(p.openEdition, false)
    assert.equal(withPlan({ plan: 'free' }, () => can('netWorth')), false)
    assert.equal(withPlan({ plan: 'plus', features: ['ai'] }, () => can('netWorth')), false)
    assert.equal(withPlan({ plan: 'plus' }, () => can('netWorth')), true)
    assert.equal(planState().openEdition, true)
  })
})

describe('the open edition: no license call', () => {
  beforeEach(() => reset({ openEdition: true }))

  test('refresh, startTrial, activate, deactivate and the bank token never reach the server', async () => {
    tokenStore.write(token())
    keyStore.write('KEY-1234')
    // Held, with a server and never checked: due anywhere else, never here.
    assert.equal(refreshDue(), false)
    assert.equal((await refresh()).plan, 'plus')
    await assert.rejects(startTrial(), (err: unknown) => err instanceof LicenseError && err.kind === 'unavailable')
    assert.equal(db.getSetting('plan.trialStartedAt'), null)
    await assert.rejects(activate('KEY-5678'), (err: unknown) => err instanceof LicenseError && err.kind === 'unavailable')
    assert.equal((await deactivate()).plan, 'plus')
    // Nothing changed here either: the token and the key stay as they were.
    assert.equal(hasToken(), true)
    assert.equal(keyStore.read(), 'KEY-1234')
    await assert.rejects(bankToken(), (err: unknown) => err instanceof LicenseError && err.kind === 'unavailable')
    assert.deepEqual(serverCalls, [])
    // The same install anywhere else: the refresh is due.
    configureLicense({ openEdition: false })
    assert.equal(refreshDue(), true)
  })
})

describe('any other build', () => {
  beforeEach(() => reset({ openEdition: false }))

  test('decides as before: a packaged, shipped build with no token is free; a development build is Plus by the build', () => {
    assert.equal(openEdition(), false)
    let p = planState()
    assert.equal(p.plan, 'free')
    assert.equal(p.openEdition, false)
    assert.equal(p.trialStarted, false)
    assert.match(p.machineId, /^[0-9a-f]{32}$/)
    assert.equal(can('netWorth'), false)
    configureLicense({ dev: true })
    p = planState()
    assert.equal(p.plan, 'plus')
    assert.equal(p.dev, true)
    assert.equal(p.openEdition, false)
  })
})

describe('the open edition: the AI', () => {
  beforeEach(() => reset({ openEdition: true }))

  test('a shipped open build with nothing saved runs on the user\'s own key, and offers neither Claude Code nor the included AI', () => {
    configureLicense({ proxyUrl: '' })
    assert.equal(storedProvider(), 'api')
    assert.equal(getProvider(), 'api')
    assert.equal(claudeCodeOffered(), false)
    assert.equal(proxyAvailable(), false)
    // A proxy choice saved by an earlier install falls back to the key.
    db.setSetting('ai.provider', 'proxy')
    assert.equal(getProvider(), 'api')
  })

  test('with no key, a request says to add one or turn on Claude Desktop where the connector is offered; any other shipped build, the key alone', async () => {
    const { makeClient } = await import('../src/main/ai/anthropic.ts')
    const { noKeyLine } = await import('../src/main/ai/sdkBackend.ts')
    const { connectorOffered } = await import('../src/main/connector.ts')
    const refused = (): string => {
      try {
        makeClient()
      } catch (err) {
        return (err as Error).message
      }
      return 'no refusal'
    }
    assert.equal(connectorOffered(), true)
    assert.equal(refused(), 'Add your Anthropic API key, or turn on Claude Desktop, in Settings.')
    configureLicense({ openEdition: false })
    assert.equal(connectorOffered(), false)
    assert.equal(refused(), 'Add your Anthropic API key in Settings.')
    // A development build offers the connector too, and its line says so.
    configureBuild({ packaged: false })
    try {
      assert.equal(connectorOffered(), true)
      assert.equal(noKeyLine(), 'Add your Anthropic API key, or turn on Claude Desktop, in Settings.')
    } finally {
      configureBuild({ packaged: true })
    }
  })
})

describe('SimpleFIN in a packaged build', () => {
  const ACCESS = 'https://user:secret@bridge.test.invalid/simplefin'
  const CLAIM = 'https://bridge.test.invalid/simplefin/claim/abc123'
  const SETUP = Buffer.from(CLAIM).toString('base64')
  /** What the fake bridge was asked, by path. */
  let asked: string[] = []
  /** The fetch in place when these tests start, put back when they end. */
  let realFetch: typeof fetch
  const event = { senderFrame: { url: 'file:///app/index.html' } }
  type Envelope = { ok: true; data: unknown } | { ok: false; error: string }
  let invoke: (channel: string, ...args: unknown[]) => Promise<Envelope>

  before(async () => {
    realFetch = globalThis.fetch
    const { registerIpc } = await import('../src/main/ipc.ts')
    registerIpc()
    invoke = async (channel, ...args) => (await electron.handlers.get(channel)!(event, ...args)) as Envelope
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input))
      asked.push(`${init?.method ?? 'GET'} ${u.pathname}`)
      if (u.href === CLAIM && init?.method === 'POST') return new Response(ACCESS, { status: 200 })
      if (u.pathname === '/simplefin/accounts') {
        const t = db.now()
        const from = Number(u.searchParams.get('start-date'))
        const to = Number(u.searchParams.get('end-date'))
        const posted = t - 3 * 86_400
        const transactions = posted >= from && posted < to ? [{ id: 'chk-t1', posted, amount: '-4.50', description: 'BLUE BOTTLE COFFEE' }] : []
        return new Response(JSON.stringify({ connections: [{ conn_id: 'CON-1', name: 'First Bank' }], accounts: [{ id: 'chk', name: 'Checking', conn_id: 'CON-1', currency: 'USD', balance: '100.00', 'balance-date': t, transactions }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch
  })
  after(() => {
    globalThis.fetch = realFetch
  })
  beforeEach(() => {
    asked = []
    db.setSetting('ai.autoClassify', '0')
  })

  test('the open edition connects it, keeps it for the background sync, shows it in Settings, and disconnects it', async () => {
    reset({ openEdition: true })
    configureLicense({ proxyUrl: '' })
    const r = await invoke('simplefinConnect', SETUP)
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    assert.equal((r as { data: { accounts: number } }).data.accounts, 1)
    assert.equal(asked[0], 'POST /simplefin/claim/abc123')
    assert.ok(asked.includes('GET /simplefin/accounts'))
    assert.deepEqual(db.listAccounts().filter((a) => a.source === 'simplefin').map((a) => a.id), ['sf:CON-1:chk'])
    // The background schedule and Sync now go by these.
    assert.equal(feed.simplefinKept(), true)
    assert.equal(feed.connected(), true)
    assert.notEqual(feed.lastSyncAt(), null)
    const s = await invoke('getSettings')
    assert.equal(s.ok, true)
    const settings = (s as { data: { simplefinConnected: boolean; plan: { plan: string; openEdition: boolean; serverAvailable: boolean } } }).data
    assert.equal(settings.simplefinConnected, true)
    assert.deepEqual([settings.plan.plan, settings.plan.openEdition, settings.plan.serverAvailable], ['plus', true, false])
    // The pages show its setup token where Plaid's Connect bank would be.
    assert.equal(lib.simplefinOffered((s as { data: AppSettings }).data), true)
    asked = []
    const again = await invoke('sync')
    assert.equal(again.ok, true, again.ok ? '' : again.error)
    assert.ok(asked.includes('GET /simplefin/accounts'))
    assert.deepEqual(await invoke('simplefinDisconnect'), { ok: true, data: undefined })
    assert.equal(feed.connected(), false)
  })

  test('any other packaged build refuses it, before anything is sent, and keeps no connection it finds', async () => {
    reset({ openEdition: false })
    configureLicense({ proxyUrl: '' })
    assert.deepEqual(await invoke('simplefinConnect', SETUP), { ok: false, error: 'SimpleFIN isn\'t available.' })
    assert.deepEqual(asked, [])
    // So the pages keep Plaid's button: the installer with no server, and the friends' beta.
    const settings = async (): Promise<AppSettings> => ((await invoke('getSettings')) as { data: AppSettings }).data
    assert.equal(lib.simplefinOffered(await settings()), false)
    configureLicense({ betaUntil: '2099-12-31' })
    try {
      const beta = await settings()
      assert.deepEqual([beta.plan.beta, beta.plan.serverAvailable, beta.claudeCodeOffered], [true, false, false])
      assert.equal(lib.simplefinOffered(beta), false)
    } finally {
      configureLicense({ betaUntil: '' })
    }
    // An access URL left from a development build: not synced here.
    const { saveSecret, deleteSecret } = await import('../src/main/secrets.ts')
    saveSecret('simplefinAccessUrl', ACCESS)
    try {
      assert.equal(feed.simplefinKept(), false)
      assert.equal(feed.connected(), false)
    } finally {
      deleteSecret('simplefinAccessUrl')
    }
  })
})

describe('Delete all data: what the confirmation names', () => {
  const locations = ['/data/finance.db', '/data/backups', '/data/claude', '/home/.finance-tracker/bridge/inbox', '/home/.finance-tracker/bridge/outbox', '/docs/Chat']
  const there = new Set(['/data/finance.db', '/data/backups', '/docs/Chat'])
  const base = { locations, exists: (p: string) => there.has(p), google: false, paired: false, plaid: false, bridge: null }

  test('the open edition: only the locations that are there, and no Claude Code transcripts it never makes', async () => {
    const { deleteList } = await import('../src/main/wipe.ts')
    assert.deepEqual(deleteList({ ...base, openEdition: true }), ['/data/finance.db', '/data/backups', '/docs/Chat'])
    // A SimpleFIN bridge to revoke and Google's access are still named.
    assert.deepEqual(deleteList({ ...base, openEdition: true, google: true, bridge: 'https://bridge.test.invalid' }), ['/data/finance.db', '/data/backups', '/docs/Chat', 'Google Calendar access (revoked)', 'Bank access: revoke it at https://bridge.test.invalid (opens after)'])
  })

  test('any other build names every location and the transcripts, as before', async () => {
    const { deleteList } = await import('../src/main/wipe.ts')
    assert.deepEqual(deleteList({ ...base, openEdition: false, paired: true, plaid: true }), [...locations, 'Claude Code transcripts of reviews', 'Phone and web viewer pairing (wiped at the relay)', 'Bank connections (removed at Plaid)'])
  })
})

describe('the pages: SimpleFIN or Plaid', () => {
  /** The settings the pages read, with only what decides this. */
  const settingsFor = (o: { openEdition: boolean; claudeCodeOffered: boolean; serverAvailable: boolean }): AppSettings =>
    ({ claudeCodeOffered: o.claudeCodeOffered, plan: { openEdition: o.openEdition, serverAvailable: o.serverAvailable } }) as unknown as AppSettings

  test('the setup token in the open edition and a development build with no server; Plaid everywhere else, and never on the web', () => {
    const cases: Array<[string, { openEdition: boolean; claudeCodeOffered: boolean; serverAvailable: boolean }, boolean]> = [
      ['the open edition', { openEdition: true, claudeCodeOffered: false, serverAvailable: false }, true],
      ['a development build with no server', { openEdition: false, claudeCodeOffered: true, serverAvailable: false }, true],
      ['a development build with a server', { openEdition: false, claudeCodeOffered: true, serverAvailable: true }, false],
      ['the friends\' beta', { openEdition: false, claudeCodeOffered: false, serverAvailable: false }, false],
      ['the installer with a server', { openEdition: false, claudeCodeOffered: false, serverAvailable: true }, false]
    ]
    for (const [name, o, offered] of cases) assert.equal(lib.simplefinOffered(settingsFor(o)), offered, name)
    assert.equal(lib.simplefinOffered(null), false)
    lib.setPlatform('web')
    try {
      for (const [name, o] of cases) assert.equal(lib.simplefinOffered(settingsFor(o)), false, `${name} on the web`)
    } finally {
      lib.setPlatform('desktop')
    }
  })

  test('the wizard\'s bank step: Enter goes on with the field empty, sends nothing that isn\'t a setup token, and claims one that is', () => {
    const setup = Buffer.from('https://bridge.test.invalid/simplefin/claim/abc123').toString('base64')
    assert.equal(bankPrimary({ connected: false, token: '' }), 'advance')
    assert.equal(bankPrimary({ connected: false, token: '  \n' }), 'advance')
    assert.equal(bankPrimary({ connected: false, token: 'garbage' }), 'invalid')
    assert.equal(bankPrimary({ connected: false, token: Buffer.from('http://bridge.test.invalid/claim').toString('base64') }), 'invalid')
    assert.equal(bankPrimary({ connected: false, token: setup }), 'connect')
    assert.equal(bankPrimary({ connected: false, token: `${setup.slice(0, 20)}\n${setup.slice(20)}` }), 'connect')
    assert.equal(bankPrimary({ connected: true, token: setup }), 'advance')
    // Plaid's step, no token field: as before.
    assert.equal(bankPrimary({ connected: false }), 'connect')
    assert.equal(bankPrimary({ connected: true }), 'advance')
  })
})

describe('Settings: the Plan card', () => {
  const settingsFor = (o: { openEdition: boolean; beta?: boolean }): AppSettings => ({ plan: { openEdition: o.openEdition, beta: !!o.beta, plan: 'plus' } }) as unknown as AppSettings

  test('none in the open edition on the desktop; every other build, and the web, keep it', () => {
    assert.equal(lib.planCardShown(settingsFor({ openEdition: true })), false)
    assert.equal(lib.planCardShown(settingsFor({ openEdition: false })), true)
    assert.equal(lib.planCardShown(settingsFor({ openEdition: false, beta: true })), true)
    assert.equal(lib.planCardShown(null), false)
    lib.setPlatform('web')
    try {
      assert.equal(lib.planCardShown(settingsFor({ openEdition: false })), true)
    } finally {
      lib.setPlatform('desktop')
    }
  })

  test('the page draws no "Open edition" line or plan copy in its place', () => {
    const page = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'pages', 'Settings.tsx'), 'utf8')
    assert.doesNotMatch(page, /Open edition|Free and open source/)
  })
})
