import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closeDb, openDb } from '../src/main/db.ts'
import { bridgeAllowed, configureBuild, DEV_VARIABLES, devBuild, devEnv, dropDevVariables, droppedInShippedBuild } from '../src/main/devBuild.ts'

// Which build is running, and the variables only a development build honors.
// Unpackaged is a development build. Packaged is a shipped build, and
// FINANCE_TRACKER_DEV=1 makes it a development one only when it was made with
// the dev flag (FINANCE_TRACKER_ALLOW_DEV=1). A shipped build reads none of the
// development-only variables and drops them, with every ANTHROPIC_* one, at
// startup. API-key mode is checked here end to end: where its client sends.

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'finance-dev-build-'))
// The key's client reads the secrets, which import Electron: the demo dump's stand-in takes its place.
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})
const { API_BASE_URL, apiKeySource, makeClient } = await import('../src/main/ai/anthropic.ts')

const TOUCHED = ['FINANCE_TRACKER_DEV', 'FINANCE_TRACKER_BRIDGE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...DEV_VARIABLES]
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]))

before(() => openDb(join(dir, 'finance.db')))
beforeEach(() => {
  for (const k of TOUCHED) delete process.env[k]
})
afterEach(() => configureBuild({ packaged: false }))
after(() => {
  closeDb()
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('the kind of build', () => {
  test('unpackaged is a development build, FINANCE_TRACKER_DEV or not', () => {
    configureBuild({ packaged: false })
    assert.equal(devBuild(), true)
    process.env['FINANCE_TRACKER_DEV'] = '1'
    assert.equal(devBuild(), true)
  })

  test('packaged is a shipped build; FINANCE_TRACKER_DEV=1 changes that only in a build made with the dev flag', () => {
    configureBuild({ packaged: true })
    assert.equal(devBuild(), false)
    process.env['FINANCE_TRACKER_DEV'] = '1'
    assert.equal(devBuild(), false)
    configureBuild({ packaged: true, allowDev: true })
    assert.equal(devBuild(), true)
    process.env['FINANCE_TRACKER_DEV'] = 'true'
    assert.equal(devBuild(), false)
    delete process.env['FINANCE_TRACKER_DEV']
    assert.equal(devBuild(), false)
  })

  test('the file bridge: a development build, or FINANCE_TRACKER_BRIDGE=1 alone in a packaged build made with the dev flag', () => {
    configureBuild({ packaged: false })
    assert.equal(bridgeAllowed(), true)
    configureBuild({ packaged: true })
    assert.equal(bridgeAllowed(), false)
    process.env['FINANCE_TRACKER_BRIDGE'] = '1'
    assert.equal(bridgeAllowed(), false)
    configureBuild({ packaged: true, allowDev: true })
    assert.equal(bridgeAllowed(), true)
    // The bridge without the rest.
    assert.equal(devBuild(), false)
  })
})

describe('the development-only variables', () => {
  test('each one is read in a development build and never in a shipped one', () => {
    for (const name of DEV_VARIABLES) process.env[name] = `set-${name}`
    configureBuild({ packaged: false })
    for (const name of DEV_VARIABLES) assert.equal(devEnv(name), `set-${name}`, name)
    configureBuild({ packaged: true })
    for (const name of DEV_VARIABLES) assert.equal(devEnv(name), undefined, name)
    process.env['FINANCE_TRACKER_DEV'] = '1'
    for (const name of DEV_VARIABLES) assert.equal(devEnv(name), undefined, name)
    configureBuild({ packaged: true, allowDev: true })
    for (const name of DEV_VARIABLES) assert.equal(devEnv(name), `set-${name}`, name)
    process.env['FINANCE_TRACKER_PLAN'] = ''
    assert.equal(devEnv('FINANCE_TRACKER_PLAN'), undefined)
  })

  test('the list: what moves the data, redirects the traffic or changes the plan', () => {
    for (const name of ['FINANCE_TRACKER_DATA_DIR', 'FINANCE_TRACKER_DOCS_DIR', 'FINANCE_TRACKER_BRIDGE_DIR', 'FINANCE_TRACKER_CLAUDE', 'FINANCE_TRACKER_ANTHROPIC_BASE_URL', 'FINANCE_TRACKER_PROXY_URL', 'FINANCE_TRACKER_RELAY_URL', 'FINANCE_TRACKER_VIEWER_URL', 'FINANCE_TRACKER_GOOGLE_AUTH', 'FINANCE_TRACKER_GOOGLE_TOKEN', 'FINANCE_TRACKER_GOOGLE_API', 'FINANCE_TRACKER_GOOGLE_TASKS', 'FINANCE_TRACKER_PLAN', 'ELECTRON_RENDERER_URL']) {
      assert.ok(droppedInShippedBuild(name), name)
    }
  })

  test('a shipped build drops them and every ANTHROPIC_* variable, whatever their case, and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = {
      FINANCE_TRACKER_PLAN: 'trial',
      finance_tracker_proxy_url: 'https://proxy.example.test',
      FINANCE_TRACKER_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      FINANCE_TRACKER_RELAY_URL: 'https://relay.example.test',
      FINANCE_TRACKER_DATA_DIR: 'C:/elsewhere',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_CUSTOM_HEADERS: 'x-a: b',
      anthropic_log: 'debug',
      ANTHROPIC_PROFILE: 'work',
      FINANCE_TRACKER_DEV: '1',
      FINANCE_TRACKER_BRIDGE: '1',
      CLAUDE_CONFIG_DIR: 'C:/claude',
      LOCALAPPDATA: 'C:/local',
      PATH: 'C:/bin'
    }
    dropDevVariables(env)
    assert.deepEqual(env, { FINANCE_TRACKER_DEV: '1', FINANCE_TRACKER_BRIDGE: '1', CLAUDE_CONFIG_DIR: 'C:/claude', LOCALAPPDATA: 'C:/local', PATH: 'C:/bin' })
  })
})

describe('API-key mode', () => {
  test('a shipped build sends to api.anthropic.com whatever FINANCE_TRACKER_ANTHROPIC_BASE_URL says, with the saved key alone', () => {
    process.env['FINANCE_TRACKER_ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:9'
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'token-from-the-environment'
    configureBuild({ packaged: true })
    const c = makeClient('sk-ant-test-not-a-key')
    assert.equal(c.baseURL, API_BASE_URL)
    assert.equal(c.apiKey, 'sk-ant-test-not-a-key')
    assert.equal(c.authToken, null)
    process.env['FINANCE_TRACKER_DEV'] = '1'
    assert.equal(makeClient('sk-ant-test-not-a-key').baseURL, API_BASE_URL)
  })

  test('a development build takes the stand-in address, and a packaged one made with the dev flag does with FINANCE_TRACKER_DEV=1', () => {
    process.env['FINANCE_TRACKER_ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:9'
    configureBuild({ packaged: false })
    assert.equal(makeClient('sk-ant-test-not-a-key').baseURL, 'http://127.0.0.1:9')
    configureBuild({ packaged: true, allowDev: true })
    assert.equal(makeClient('sk-ant-test-not-a-key').baseURL, API_BASE_URL)
    process.env['FINANCE_TRACKER_DEV'] = '1'
    assert.equal(makeClient('sk-ant-test-not-a-key').baseURL, 'http://127.0.0.1:9')
  })

  test('ANTHROPIC_API_KEY stands in for a saved key in a development build only', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-the-environment'
    configureBuild({ packaged: false })
    assert.equal(apiKeySource(), 'env')
    configureBuild({ packaged: true })
    assert.equal(apiKeySource(), 'none')
    assert.throws(() => makeClient(), (e: unknown) => (e as { kind?: string }).kind === 'auth')
  })
})
