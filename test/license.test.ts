import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { activate, can, clearToken, configureLicense, currentToken, deactivate, LICENSE_PUBLIC_KEY, machineId, planState, refresh, startTrial, tokenState, verifyEntitlement, type Entitlement, type SecretStore } from '../src/main/license.ts'
import { allowance, checkAllowance } from '../src/main/allowance.ts'
import { AiError, configureAi } from '../src/main/ai/backend.ts'
import { configureBuild } from '../src/main/devBuild.ts'
import { runAssistantTool, runTool, toolFeature } from '../src/main/tools.ts'
import { FEATURES, TRIAL_DAYS } from '../src/shared/plans.ts'

// The plan in force and the license behind it: the local trial date, an
// entitlement token signed like the server signs it (a key pair made here),
// the development build, and what each plan lets the tools and the hosted
// AI do. The server is a fake fetch that signs with the same key, at the
// address a shipped build has built in.

const DAY = 86_400_000
const dir = mkdtempSync(join(tmpdir(), 'finance-license-'))

const memory = (): SecretStore => {
  let v: string | null = null
  return { read: () => v, write: (x) => void (v = x), clear: () => void (v = null) }
}

const pair = generateKeyPairSync('ed25519')
const other = generateKeyPairSync('ed25519')
const publicKey = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
const WIRE = FEATURES.map((f) => f.wire)

/** A token as the server issues it; `claims` overrides any field. */
function token(claims: Partial<Entitlement> & { now?: number }, key: KeyObject = pair.privateKey): string {
  const now = claims.now ?? Date.now()
  const iat = Math.floor(now / 1000)
  const full: Entitlement = {
    iss: 'Finance Tracker',
    sub: createHash('sha256').update('key').digest('hex'),
    aud: 'desktop',
    iat,
    exp: iat + 30 * 86_400,
    plan: 'plus',
    features: WIRE,
    paidThrough: new Date(now + 30 * DAY).toISOString(),
    graceDays: 21,
    machineId: machineId(),
    platform: 'test',
    ...claims
  }
  const head = b64url({ alg: 'EdDSA', typ: 'JWT', kid: 'test' })
  const body = b64url(full)
  const sig = sign(null, Buffer.from(`${head}.${body}`, 'ascii'), key).toString('base64url')
  return `${head}.${body}.${sig}`
}

const trialToken = (startedAt: number, now = Date.now()): string => {
  const endsAt = startedAt + TRIAL_DAYS * DAY
  return token({ now, plan: 'trial', sub: `trial:${createHash('sha256').update(machineId()).digest('hex')}`, exp: Math.floor(endsAt / 1000), paidThrough: new Date(endsAt).toISOString(), graceDays: 0, trialStartedAt: new Date(startedAt).toISOString(), trialEndsAt: new Date(endsAt).toISOString() })
}

let tokenStore = memory()
let keyStore = memory()
const reset = (): void => {
  tokenStore = memory()
  keyStore = memory()
  configureLicense({ publicKey, dev: false, proxyUrl: '', betaUntil: '', platform: 'test', token: tokenStore, key: keyStore, fetch: () => Promise.reject(new Error('no server')) })
  delete process.env['FINANCE_TRACKER_PLAN']
  delete process.env['FINANCE_TRACKER_PROXY_URL']
  db.setSetting('plan.trialStartedAt', null)
  db.setSetting('plan.plusUntil', null)
  db.setSetting('ai.proxyUrl', null)
  db.setSetting('ai.provider', null)
}

before(() => {
  db.openDb(join(dir, 'finance.db'))
  configureBuild({ packaged: true })
  configureAi({ backends: {} })
})
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(reset)

describe('the entitlement token', () => {
  test('a good token verifies and reads back its claims', () => {
    const v = verifyEntitlement(token({}), Date.now(), publicKey)
    assert.ok(v.ok)
    assert.equal(v.claims.plan, 'plus')
    assert.equal(v.claims.graceDays, 21)
  })
  test('a token signed with another key, or tampered with, is refused', () => {
    assert.deepEqual(verifyEntitlement(token({}, other.privateKey), Date.now(), publicKey), { ok: false, reason: 'bad_signature' })
    const [h, p, s] = token({}).split('.')
    const forged = `${h}.${b64url({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), plan: 'plus', features: WIRE, paidThrough: '2099-01-01T00:00:00.000Z' })}.${s}`
    assert.equal(verifyEntitlement(forged, Date.now(), publicKey).ok, false)
    assert.deepEqual(verifyEntitlement('not.a.token', Date.now(), publicKey), { ok: false, reason: 'malformed' })
    assert.deepEqual(verifyEntitlement('', Date.now(), publicKey), { ok: false, reason: 'malformed' })
  })
  test('a token past exp is expired, one from the future not yet valid', () => {
    const now = Date.now()
    assert.deepEqual(verifyEntitlement(token({ now: now - 31 * DAY }), now, publicKey), { ok: false, reason: 'expired' })
    assert.deepEqual(verifyEntitlement(token({ now: now + 2 * DAY }), now, publicKey), { ok: false, reason: 'not_yet_valid' })
  })
  test('the embedded placeholder key is a 32-byte Ed25519 public key', () => {
    assert.equal(Buffer.from(LICENSE_PUBLIC_KEY, 'base64url').length, 32)
    assert.equal(verifyEntitlement(token({}), Date.now(), LICENSE_PUBLIC_KEY).ok, false)
  })
  test('tokenState: paid through plus the grace keeps features on; past that, off; another machine, nothing', () => {
    const now = Date.now()
    const live = tokenState(token({ now }), now, publicKey)!
    assert.equal(live.usable, true)
    assert.equal(live.entitled, true)
    // Issued 40 days ago: exp (30 days) has passed, paidThrough (30 days) too, but 21 days of grace have not.
    const inGrace = tokenState(token({ now: now - 40 * DAY }), now, publicKey)!
    assert.equal(inGrace.usable, false)
    assert.equal(inGrace.entitled, true)
    const beyond = tokenState(token({ now: now - 60 * DAY }), now, publicKey)!
    assert.equal(beyond.entitled, false)
    assert.equal(tokenState(token({ machineId: 'someone-else' }), now, publicKey), null)
    assert.equal(tokenState(token({}, other.privateKey), now, publicKey), null)
  })
  test('the machine id is stable across calls and changes with the salt', () => {
    const a = machineId()
    assert.equal(machineId(), a)
    assert.match(a, /^[0-9a-f]{32}$/)
    db.setSetting('license.machineSalt', 'other')
    assert.notEqual(machineId(), a)
  })
})

describe('planState', () => {
  test('nothing set: free, never started', () => {
    const p = planState()
    assert.equal(p.plan, 'free')
    assert.equal(p.trialStarted, false)
    assert.equal(p.licensed, false)
    assert.equal(p.trialDaysLeft, 0)
  })
  test('a trial started today has the whole 14 days; fifteen days on it is free, and counted as started', () => {
    db.setSetting('plan.trialStartedAt', new Date().toISOString())
    assert.equal(planState().plan, 'trial')
    assert.equal(planState().trialDaysLeft, TRIAL_DAYS)
    db.setSetting('plan.trialStartedAt', new Date(Date.now() - 15 * DAY).toISOString())
    const p = planState()
    assert.equal(p.plan, 'free')
    assert.equal(p.trialStarted, true)
  })
  test('a Plus token: plus while paid, still plus in the grace, free beyond it', () => {
    const now = Date.now()
    tokenStore.write(token({ now }))
    configureLicense({})
    let p = planState(now)
    assert.equal(p.plan, 'plus')
    assert.equal(p.licensed, true)
    assert.ok(p.paidThrough && p.graceUntil)
    tokenStore.write(token({ now: now - 40 * DAY }))
    configureLicense({})
    assert.equal(planState(now).plan, 'plus')
    tokenStore.write(token({ now: now - 60 * DAY }))
    configureLicense({})
    p = planState(now)
    assert.equal(p.plan, 'free')
    assert.equal(p.licensed, false)
  })
  test('a trial token from the server sets the days left by its own window', () => {
    const now = Date.now()
    tokenStore.write(trialToken(now - 10 * DAY, now))
    configureLicense({})
    const p = planState(now)
    assert.equal(p.plan, 'trial')
    assert.equal(p.trialDaysLeft, 4)
    assert.equal(planState(now + 5 * DAY).plan, 'free')
  })
  test('a badly signed token counts for nothing', () => {
    tokenStore.write(token({}, other.privateKey))
    configureLicense({})
    assert.equal(planState().plan, 'free')
    assert.equal(currentToken(), null)
  })
  test('a development build is Plus, unless FINANCE_TRACKER_PLAN says free or trial', () => {
    configureLicense({ dev: true })
    assert.equal(planState().plan, 'plus')
    assert.equal(planState().dev, true)
    process.env['FINANCE_TRACKER_PLAN'] = 'free'
    assert.equal(planState().plan, 'free')
    assert.equal(planState().dev, false)
    db.setSetting('plan.trialStartedAt', new Date().toISOString())
    assert.equal(planState().plan, 'trial')
    db.setSetting('plan.trialStartedAt', null)
    process.env['FINANCE_TRACKER_PLAN'] = 'trial'
    assert.equal(planState().plan, 'trial')
    assert.equal(planState().trialDaysLeft, TRIAL_DAYS)
  })
  test('a shipped build ignores FINANCE_TRACKER_PLAN: trial never unlocks a trial that was not started, and free never locks a license', () => {
    process.env['FINANCE_TRACKER_PLAN'] = 'trial'
    assert.equal(planState().plan, 'free')
    assert.ok(!can('taxes'))
    db.setSetting('plan.trialStartedAt', new Date(Date.now() - (TRIAL_DAYS + 1) * DAY).toISOString())
    assert.equal(planState().plan, 'free')
    process.env['FINANCE_TRACKER_PLAN'] = 'free'
    tokenStore.write(token({}))
    configureLicense({})
    assert.equal(planState().plan, 'plus')
    assert.equal(planState().licensed, true)
  })
})

describe('the beta', () => {
  const UNTIL = '2027-03-31'
  /** A moment on the computer's clock (the beta runs through its last day there). */
  const at = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime()
  const plus = FEATURES.filter((f) => f.plan === 'plus').map((f) => f.id)

  test('no beta date: the plan is decided as before', () => {
    const now = at(2027, 1, 15)
    const p = planState(now)
    assert.equal(p.plan, 'free')
    assert.equal(p.beta, false)
    assert.equal(p.betaUntil, null)
    assert.ok(plus.every((f) => !can(f, now)))
    db.setSetting('plan.trialStartedAt', new Date(now).toISOString())
    assert.equal(planState(now).plan, 'trial')
    assert.equal(planState(now).beta, false)
  })
  test('before its last day: Plus with every feature, as the beta and its date, not a license or a trial', () => {
    configureLicense({ betaUntil: UNTIL })
    const now = at(2026, 10, 21)
    const p = planState(now)
    assert.equal(p.plan, 'plus')
    assert.equal(p.beta, true)
    assert.equal(p.betaUntil, UNTIL)
    assert.equal(p.dev, false)
    assert.equal(p.licensed, false)
    assert.equal(p.trialStarted, false)
    assert.ok(plus.every((f) => can(f, now)))
  })
  test('on its last day, to the end of the day', () => {
    configureLicense({ betaUntil: UNTIL })
    for (const now of [at(2027, 3, 31, 0, 0), at(2027, 3, 31, 23, 59)]) {
      assert.equal(planState(now).plan, 'plus')
      assert.equal(planState(now).beta, true)
      assert.ok(plus.every((f) => can(f, now)))
    }
  })
  test('after it: the normal rules — free with the trial still to start, a trial then runs its days, and one started earlier has ended', () => {
    configureLicense({ betaUntil: UNTIL })
    const after = at(2027, 4, 1, 0, 0)
    let p = planState(after)
    assert.equal(p.plan, 'free')
    assert.equal(p.beta, false)
    assert.equal(p.betaUntil, null)
    assert.equal(p.trialStarted, false)
    assert.ok(plus.every((f) => !can(f, after)))
    db.setSetting('plan.trialStartedAt', new Date(after).toISOString())
    assert.equal(planState(after + DAY).plan, 'trial')
    assert.equal(planState(after + DAY).trialDaysLeft, TRIAL_DAYS - 1)
    db.setSetting('plan.trialStartedAt', new Date(at(2026, 11, 1)).toISOString())
    p = planState(after)
    assert.equal(p.plan, 'free')
    assert.equal(p.trialStarted, true)
  })
  test('a held license token still wins, features and all', () => {
    configureLicense({ betaUntil: UNTIL })
    const now = at(2027, 1, 15)
    tokenStore.write(token({ now, features: WIRE.filter((w) => w !== 'taxes') }))
    configureLicense({})
    const p = planState(now)
    assert.equal(p.plan, 'plus')
    assert.equal(p.beta, false)
    assert.equal(p.licensed, true)
    assert.ok(p.paidThrough)
    assert.equal(can('taxes', now), false)
    assert.equal(can('credit', now), true)
    tokenStore.write(trialToken(now - 3 * DAY, now))
    configureLicense({})
    assert.equal(planState(now).plan, 'trial')
    assert.equal(planState(now).beta, false)
  })
  test('a token past its grace falls back to the beta', () => {
    configureLicense({ betaUntil: UNTIL })
    const now = at(2027, 1, 15)
    tokenStore.write(token({ now: now - 60 * DAY }))
    configureLicense({})
    assert.equal(planState(now).plan, 'plus')
    assert.equal(planState(now).beta, true)
  })
  test('a shipped beta ignores FINANCE_TRACKER_PLAN; in a development build it turns the beta off, as it does the built-in Plus', () => {
    configureLicense({ betaUntil: UNTIL })
    process.env['FINANCE_TRACKER_PLAN'] = 'free'
    let p = planState(at(2027, 1, 15))
    assert.equal(p.plan, 'plus')
    assert.equal(p.beta, true)
    configureLicense({ dev: true })
    p = planState(at(2027, 1, 15))
    assert.equal(p.plan, 'free')
    assert.equal(p.beta, false)
  })
  test('a malformed date is no beta', () => {
    for (const bad of ['2027-02-30', '31/03/2027', '2027-3-31', 'soon']) {
      configureLicense({ betaUntil: bad })
      assert.equal(planState(at(2026, 10, 21)).plan, 'free', bad)
      assert.equal(planState(at(2026, 10, 21)).beta, false, bad)
    }
  })
})

describe('can(feature)', () => {
  test('free has none of the Plus features; a trial and Plus have all of them; the dev build too', () => {
    const plus = FEATURES.filter((f) => f.plan === 'plus').map((f) => f.id)
    assert.ok(plus.every((f) => !can(f)))
    db.setSetting('plan.trialStartedAt', new Date().toISOString())
    assert.ok(plus.every((f) => can(f)))
    db.setSetting('plan.trialStartedAt', null)
    tokenStore.write(token({}))
    configureLicense({})
    assert.ok(plus.every((f) => can(f)))
    reset()
    configureLicense({ dev: true })
    assert.ok(plus.every((f) => can(f)))
  })
  test('a token that names fewer features unlocks only those', () => {
    tokenStore.write(token({ features: ['ventures', 'taxes'] }))
    configureLicense({})
    assert.equal(planState().plan, 'plus')
    assert.equal(can('ventures'), true)
    assert.equal(can('taxes'), true)
    assert.equal(can('insurance'), false)
    assert.equal(can('includedAi'), false)
  })
  test('a token from before accounts were unlimited on Free still lists unlimited_accounts: it verifies, and the name unlocks nothing', () => {
    const old = token({ features: ['unlimited_accounts', ...WIRE] })
    const v = verifyEntitlement(old, Date.now(), publicKey)
    assert.ok(v.ok && v.claims.features.includes('unlimited_accounts'))
    tokenStore.write(old)
    configureLicense({})
    assert.equal(planState().plan, 'plus')
    assert.ok(FEATURES.every((f) => can(f.id)))
    tokenStore.write(token({ features: ['unlimited_accounts'] }))
    configureLicense({})
    assert.equal(planState().plan, 'plus')
    assert.ok(FEATURES.every((f) => !can(f.id)))
  })
  test('the tools refuse a Plus write on Free and run it on a trial', () => {
    assert.equal(toolFeature('create_bucket'), 'ventures')
    assert.equal(toolFeature('set_tax_year'), 'taxes')
    assert.equal(toolFeature('read_document'), 'documents')
    assert.equal(toolFeature('search_transactions'), undefined)
    assert.throws(() => runAssistantTool('create_bucket', { name: 'Rental', kind: 'rental' }), /Plus: Ventures/)
    assert.throws(() => runTool('set_tax_year', { year: 2025 }), /Plus: Taxes/)
    db.setSetting('plan.trialStartedAt', new Date().toISOString())
    const r = runAssistantTool('create_bucket', { name: 'Rental', kind: 'rental' })
    assert.equal(r.pending, undefined)
  })
})

describe('the server', () => {
  /** A fake license server: records the calls, signs tokens with the test key, and answers as told. */
  function server(answer: (path: string, body: Record<string, unknown>) => { status: number; body: unknown }): { calls: Array<{ path: string; body: Record<string, unknown> }> } {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    configureLicense({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        calls.push({ path, body })
        const a = answer(path, body)
        return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
    })
    configureLicense({ proxyUrl: 'https://example.test/' })
    return { calls }
  }

  test('a shipped build talks to the server built in only: FINANCE_TRACKER_PROXY_URL and ai.proxyUrl don\'t count', async () => {
    const hosts: string[] = []
    configureLicense({
      fetch: (async (url: string | URL | Request) => {
        hosts.push(new URL(String(url)).host)
        return new Response(JSON.stringify({ token: token({}) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
    })
    process.env['FINANCE_TRACKER_PROXY_URL'] = 'https://elsewhere.example.test'
    db.setSetting('ai.proxyUrl', 'https://saved.example.test')
    assert.equal(planState().serverAvailable, false)
    await assert.rejects(activate('k'), /No license server/)
    await startTrial()
    assert.deepEqual(hosts, [])
    configureLicense({ proxyUrl: 'https://built.example.test/v1/' })
    await activate('k')
    assert.deepEqual(hosts, ['built.example.test'])
  })

  test('a development build takes FINANCE_TRACKER_PROXY_URL, then ai.proxyUrl, before the server built in', async () => {
    const hosts: string[] = []
    configureLicense({
      dev: true,
      proxyUrl: 'https://built.example.test',
      fetch: (async (url: string | URL | Request) => {
        hosts.push(new URL(String(url)).host)
        return new Response(JSON.stringify({ token: token({}) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
    })
    process.env['FINANCE_TRACKER_PROXY_URL'] = 'https://env.example.test/'
    db.setSetting('ai.proxyUrl', 'https://saved.example.test')
    await activate('k')
    delete process.env['FINANCE_TRACKER_PROXY_URL']
    await activate('k')
    db.setSetting('ai.proxyUrl', null)
    await activate('k')
    assert.deepEqual(hosts, ['env.example.test', 'saved.example.test', 'built.example.test'])
  })

  test('activate sends the key and this machine, keeps the token, and switches the AI to the hosted service', async () => {
    const s = server((path) => (path === '/v1/license/activate' ? { status: 200, body: { token: token({}), plan: 'plus' } } : { status: 404, body: {} }))
    const p = await activate(' ABC-123 ')
    assert.equal(p.plan, 'plus')
    assert.equal(p.licensed, true)
    assert.deepEqual(s.calls[0], { path: '/v1/license/activate', body: { key: 'ABC-123', machineId: machineId(), platform: 'test' } })
    assert.equal(keyStore.read(), 'ABC-123')
    assert.equal(db.getSetting('ai.provider'), 'proxy')
  })
  test('a token the server signs with another key is refused and nothing is kept', async () => {
    server(() => ({ status: 200, body: { token: token({}, other.privateKey) } }))
    await assert.rejects(activate('k'), /isn't a license token/)
    assert.equal(tokenStore.read(), null)
    assert.equal(planState().plan, 'free')
  })
  test('the server\'s refusals come back as plain sentences', async () => {
    server((_p, body) => (body.key === 'bad' ? { status: 403, body: { error: 'invalid_key' } } : { status: 409, body: { kind: 'activation_limit', limit: 3 } }))
    await assert.rejects(activate('bad'), /isn't valid/)
    await assert.rejects(activate('full'), /3 computers/)
    configureLicense({ fetch: () => Promise.reject(new Error('down')) })
    await assert.rejects(activate('k'), (e: unknown) => (e as { kind?: string }).kind === 'offline')
  })
  test('deactivate frees the slot and drops the token; the AI goes back to the key', async () => {
    const s = server((path) => ({ status: 200, body: path === '/v1/license/activate' ? { token: token({}) } : { ok: true } }))
    await activate('k')
    const p = await deactivate()
    assert.equal(p.plan, 'free')
    assert.equal(s.calls[1].path, '/v1/license/deactivate')
    assert.deepEqual(s.calls[1].body, { key: 'k', machineId: machineId() })
    assert.equal(tokenStore.read(), null)
    assert.equal(db.getSetting('ai.provider'), 'api')
  })
  test('startTrial without a server unlocks the trial locally', async () => {
    const p = await startTrial()
    assert.equal(p.plan, 'trial')
    assert.equal(p.trialDaysLeft, TRIAL_DAYS)
    assert.equal(p.licensed, false)
  })
  test('startTrial with a server takes its token and its window', async () => {
    const started = Date.now() - 3 * DAY
    server((path) => (path === '/v1/license/trial' ? { status: 200, body: { token: trialToken(started), plan: 'trial' } } : { status: 404, body: {} }))
    const p = await startTrial()
    assert.equal(p.plan, 'trial')
    assert.equal(p.licensed, true)
    assert.equal(p.trialDaysLeft, 11)
    assert.equal(db.getSetting('plan.trialStartedAt'), new Date(started).toISOString())
    assert.equal(db.getSetting('ai.provider'), 'proxy')
  })
  test('a trial the server says is over ends here too', async () => {
    const started = new Date(Date.now() - 20 * DAY).toISOString()
    server(() => ({ status: 403, body: { error: 'trial_over', kind: 'trial_over', trialStartedAt: started, trialEndsAt: new Date(Date.now() - 6 * DAY).toISOString() } }))
    await assert.rejects(startTrial(), /has ended/)
    const p = planState()
    assert.equal(p.plan, 'free')
    assert.equal(p.trialStarted, true)
    assert.equal(db.getSetting('plan.trialStartedAt'), started)
  })
  test('refresh validates a held key and drops a license the server says is gone', async () => {
    let gone = false
    const s = server((path) => (gone ? { status: 403, body: { error: 'license_revoked' } } : { status: 200, body: { token: token({}) } }))
    await activate('k')
    await refresh()
    assert.equal(s.calls[1].path, '/v1/license/validate')
    assert.equal(planState().plan, 'plus')
    gone = true
    await assert.rejects(refresh(), /revoked/)
    assert.equal(planState().plan, 'free')
    clearToken()
  })
})

describe('the included AI\'s allowance', () => {
  /** A call at list price: Sonnet input is two micro-dollars a token, Haiku's a tenth of one. */
  const call = (inputTokens: number, model = 'claude-sonnet-5-5', webSearches = 0): void =>
    db.addAiUsage('review', { model, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches })

  beforeEach(() => {
    db.all('DELETE FROM ai_usage')
    db.setSetting('plan.trialStartedAt', new Date(Date.now() - 2 * DAY).toISOString())
    configureLicense({ proxyUrl: 'https://example.test' })
    tokenStore.write(trialToken(Date.now() - 2 * DAY))
    configureLicense({})
    db.setSetting('ai.provider', 'proxy')
  })
  afterEach(() => db.all('DELETE FROM ai_usage'))

  test('what the window\'s calls cost at list prices, against the trial\'s $3', () => {
    call(10_000)
    call(10_000)
    call(10_000, 'claude-haiku-5-5')
    call(0, 'claude-sonnet-5-5', 2)
    const a = allowance()
    assert.equal(a.plan, 'trial')
    assert.equal(a.used, 20_000 + 20_000 + 1_000 + 20_000)
    assert.equal(a.budget, 3_000_000)
    assert.ok(a.window && Date.parse(a.window.to) - Date.parse(a.window.from) === TRIAL_DAYS * DAY)
  })
  test('the hosted backend is refused once the budget is spent; the user\'s own key never is', () => {
    call(1_499_999)
    assert.doesNotThrow(() => checkAllowance('review'))
    call(1)
    assert.throws(() => checkAllowance('headline'), (e: unknown) => e instanceof AiError && e.kind === 'quota' && e.message === 'The trial\'s AI allowance is used up.')
    db.setSetting('ai.provider', 'api')
    assert.doesNotThrow(() => checkAllowance('review'))
  })
  test('Plus counts the UTC month against $5, and says when it resets', () => {
    db.setSetting('plan.trialStartedAt', null)
    tokenStore.write(token({}))
    configureLicense({})
    call(2_499_999)
    const a = allowance()
    assert.equal(a.plan, 'plus')
    assert.ok(a.window?.from.endsWith('-01T00:00:00.000Z'))
    assert.deepEqual([a.used, a.budget], [4_999_998, 5_000_000])
    assert.doesNotThrow(() => checkAllowance('categorize'))
    call(1)
    assert.throws(() => checkAllowance('categorize'), (e: unknown) => e instanceof AiError && /^This month's AI allowance is used up · resets [A-Z][a-z]{2} \d{1,2}\.$/.test(e.message))
  })
  test('with no plan there is no window and nothing to spend', () => {
    db.setSetting('plan.trialStartedAt', null)
    tokenStore.clear()
    configureLicense({})
    const a = allowance()
    assert.deepEqual([a.window, a.budget], [null, null])
    assert.doesNotThrow(() => checkAllowance('review'))
  })
})
