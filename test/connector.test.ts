import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'
import * as db from '../src/main/db.ts'
import { HOME_DIR_NAME } from '../src/main/build.ts'
import { configureBuild } from '../src/main/devBuild.ts'
import { configureLicense } from '../src/main/license.ts'
import { mcpTools } from '../src/main/mcp.ts'
import { CONNECTOR_GRANT, CONNECTOR_INSTRUCTIONS, configureConnector, connectionFile, connectorDir, connectorEndpoint, connectorOffered, connectorStatus, endpointFor, MAX_LINE, setConnector, SOCKET_PATH_MAX, startConnector, stopConnector, undoConnectorChange } from '../src/main/connector.ts'
import { EXTENSION_AUTHOR, EXTENSION_ENTRY, extensionFiles, extensionManifest, MANIFEST_VERSION, shimSource, UNPACKED_DIR, writeExtension, zip } from '../src/main/mcpb.ts'
import { APP_NAME, NOT_ADVICE } from '../src/shared/app.ts'

// Claude Desktop's connector (src/main/connector.ts) and its extension
// (src/main/mcpb.ts, resources/claude-extension). The pipe answers only the
// holder of the token, lists the reads until Allow changes is on, journals a
// change under its own grant so Settings can undo it, refuses an oversize line
// and a flood of requests, and is gone with its connection file once turned
// off; at launch it starts again with a new token and endpoint, and a file a
// run that's gone left behind is deleted; it's offered in the open edition and
// a development build only. The manifest is checked against what manifest
// version 0.3 requires and allows, the .mcpb is read back as a zip, and the
// relay runs under plain Node, as Claude Desktop runs it, against the real
// server, and follows a connection file only to a local endpoint of a running
// app. The home directory is a temp folder throughout: nothing here touches
// the real one.

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'finance-connector-'))
const home = join(dir, 'home')
const dataDir = join(dir, 'data')
assert.notEqual(resolve(home).toLowerCase(), resolve(homedir()).toLowerCase())
const template = readFileSync(join(here, '..', 'resources', 'claude-extension', 'server', 'index.cjs'), 'utf8')
const VERSION = '0.0.0-test'
// As Settings writes it (ipc.ts installConnector): the reads go in, for the relay to list while the app isn't answering.
const extension = { appName: APP_NAME, version: VERSION, homeDirName: HOME_DIR_NAME, instructions: CONNECTOR_INSTRUCTIONS, template, tools: mcpTools(false) }

let changed = 0
configureBuild({ packaged: false })
configureLicense({ dev: true, openEdition: false })
configureConnector({ home, dataDir, changed: () => void changed++ })

before(() => {
  process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
  db.openDb(join(dir, 'finance.db'))
  db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  db.upsertTransaction({ id: 't1', accountId: 'manual:a', posted: 1_760_000_000, amountCents: -1234, description: 'COSTCO WHSE #123', pending: false })
})
after(() => {
  stopConnector()
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const file = (): string => connectionFile(home)
const token = (): string => (JSON.parse(readFileSync(file(), 'utf8')) as { token: string }).token
const auth = (t = token()): string => JSON.stringify({ auth: t })
const req = (id: number, method: string, params?: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
const toolNames = (tools: Array<{ name: string }>): string[] => tools.map((t) => t.name)
/** The relay's built values (mcpb.ts BUILT), kept on one line. */
const BUILT_LINE = /\/\* built \*\/ ([^\n]*?) \/\* end \*\//
/** This test's endpoint for a start with this nonce, as the connector names it. */
const ownEndpoint = (nonce: string): string => endpointFor({ platform: process.platform, home, dataDir, user: userInfo().username, tmp: tmpdir(), nonce })
/** A process id no process has any more. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!

interface Talk {
  answers: any[]
  /** the server closed the connection */
  closed: boolean
}

/** Writes the lines on a new connection and reads answers until `want` have come or the server closes it. */
function talk(lines: string[], want: number, path = connectorEndpoint()): Promise<Talk> {
  assert.ok(path, 'the connector is listening')
  return new Promise((done) => {
    const s = connect(path)
    const answers: any[] = []
    let text = ''
    let over = false
    const finish = (closed: boolean): void => {
      if (over) return
      over = true
      clearTimeout(timer)
      s.destroy()
      done({ answers, closed })
    }
    const timer = setTimeout(() => finish(false), 10_000)
    s.setEncoding('utf8')
    s.on('connect', () => s.write(lines.map((l) => `${l}\n`).join('')))
    s.on('data', (d: string) => {
      text += d
      for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) {
        answers.push(JSON.parse(text.slice(0, nl)))
        text = text.slice(nl + 1)
      }
      if (answers.length >= want) finish(false)
    })
    // The server closing on a refused connection can reset a write still under way.
    s.on('error', () => {})
    s.on('close', () => finish(true))
  })
}

describe('where it is offered', () => {
  test('the open edition and a development build; every other build has none', async () => {
    try {
      configureBuild({ packaged: true })
      configureLicense({ dev: false, openEdition: false })
      assert.equal(connectorOffered(), false)
      assert.deepEqual(connectorStatus(), { offered: false, on: false, allowChanges: false, running: false, error: null, changes: [] })
      await assert.rejects(setConnector({ on: true }), /isn't in this build/)
      assert.throws(() => undoConnectorChange(1), /isn't in this build/)
      assert.equal(connectorEndpoint(), null)
      assert.equal(existsSync(file()), false)

      configureLicense({ openEdition: true })
      assert.equal(connectorOffered(), true)
      configureLicense({ openEdition: false })
      // A packaged copy made with the dev flag and run with FINANCE_TRACKER_DEV=1 is a development build.
      configureBuild({ packaged: true, allowDev: true })
      process.env['FINANCE_TRACKER_DEV'] = '1'
      assert.equal(connectorOffered(), true)
    } finally {
      delete process.env['FINANCE_TRACKER_DEV']
      configureBuild({ packaged: false })
      configureLicense({ dev: true, openEdition: false })
    }
    assert.equal(connectorOffered(), true)
  })

  test('at launch, a build that does not offer it starts nothing and touches nothing, even with the setting left on', async () => {
    try {
      db.setSetting('connector.on', '1')
      configureBuild({ packaged: true })
      configureLicense({ dev: false, openEdition: false })
      await startConnector()
      assert.equal(connectorEndpoint(), null)
      assert.equal(existsSync(file()), false)
      assert.equal(existsSync(connectorDir(home)), false, 'not even the hidden folder')
    } finally {
      db.setSetting('connector.on', '0')
      configureBuild({ packaged: false })
      configureLicense({ dev: true, openEdition: false })
    }
  })
})

describe('the server', () => {
  test('off by default: nothing listens and there is no connection file', () => {
    const s = connectorStatus()
    assert.deepEqual([s.offered, s.on, s.allowChanges, s.running, s.error], [true, false, false, false, null])
    assert.equal(connectorEndpoint(), null)
    assert.equal(existsSync(file()), false)
  })

  test('turned on, it listens and writes the connection file: the endpoint and a new 32-byte token', async () => {
    const s = await setConnector({ on: true })
    assert.equal(s.running, true, s.error ?? '')
    assert.equal(s.on, true)
    const c = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(c).sort(), ['app', 'path', 'pid', 'token', 'v', 'write'])
    assert.equal(c['v'], 1)
    assert.equal(c['app'], APP_NAME)
    assert.equal(c['path'], connectorEndpoint())
    assert.match(String(c['token']), /^[0-9a-f]{64}$/)
    assert.equal(c['write'], false)
    assert.equal(c['pid'], process.pid)
    assert.equal(dirname(file()), join(home, HOME_DIR_NAME))
    if (process.platform === 'win32') assert.match(String(c['path']), new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\${HOME_DIR_NAME.slice(1)}-[0-9a-f]{16}-[0-9a-f]{16}$`))
    else assert.equal(statSync(file()).mode & 0o777, 0o600)
  })

  test('a connection without the token is closed unanswered', async () => {
    assert.deepEqual(await talk([req(1, 'tools/list')], 1), { answers: [], closed: true })
    assert.deepEqual(await talk([auth('0'.repeat(64)), req(1, 'ping')], 1), { answers: [], closed: true })
    assert.deepEqual(await talk([auth(token().toUpperCase()), req(1, 'ping')], 1), { answers: [], closed: true })
    assert.deepEqual(await talk([JSON.stringify({ token: token() }), req(1, 'ping')], 1), { answers: [], closed: true })
    const ok = await talk([auth(), req(1, 'ping')], 1)
    assert.deepEqual(ok.answers, [{ jsonrpc: '2.0', id: 1, result: {} }])
  })

  test('tools/list has the reads only, until Allow changes is on', async () => {
    const reads = (await talk([auth(), req(1, 'tools/list')], 1)).answers[0].result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>
    assert.deepEqual(toolNames(reads), toolNames(mcpTools(false)))
    assert.ok(reads.every((t) => t.annotations.readOnlyHint))

    const before = token()
    await setConnector({ allowChanges: true })
    assert.equal(token(), before, 'the same token')
    assert.equal((JSON.parse(readFileSync(file(), 'utf8')) as { write: boolean }).write, true)
    const all = (await talk([auth(), req(1, 'tools/list')], 1)).answers[0].result.tools as Array<{ name: string }>
    assert.deepEqual(toolNames(all), toolNames(mcpTools(true)))
    assert.ok(toolNames(all).includes('categorize') && toolNames(all).includes('undo_change'))

    await setConnector({ allowChanges: false })
    assert.deepEqual(toolNames((await talk([auth(), req(1, 'tools/list')], 1)).answers[0].result.tools), toolNames(mcpTools(false)))
  })

  test('a change is refused without Allow changes; with it, journaled under the connector and undone from Settings', async () => {
    const categorize = req(1, 'tools/call', { name: 'categorize', arguments: { transaction_ids: ['t1'], category: 'Groceries' } })
    const seen = changed

    const refused = (await talk([auth(), categorize], 1)).answers[0]
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /Allow changes is off/)
    assert.equal(db.getTransaction('t1')!.categoryId, null)
    assert.equal(changed, seen)

    await setConnector({ allowChanges: true })
    const done = (await talk([auth(), categorize], 1)).answers[0]
    assert.equal(done.result.isError, false)
    const { change_id } = JSON.parse(done.result.content[1].text) as { change_id: number }
    assert.equal(db.getTransaction('t1')!.categoryId, category('Groceries'))
    assert.equal(db.getChange(change_id)!.origin, 'mcp:owner')
    assert.equal(db.getChange(change_id)!.turnId, CONNECTOR_GRANT)
    assert.equal(changed, seen + 1, 'the views were told')

    // Claude sees it in list_changes; Settings lists it with Undo.
    const listed = JSON.parse((await talk([auth(), req(2, 'tools/call', { name: 'list_changes', arguments: {} })], 1)).answers[0].result.content[0].text) as Array<{ id: number }>
    assert.deepEqual(listed.map((c) => c.id), [change_id])
    const s = connectorStatus()
    assert.deepEqual(s.changes.map((c) => [c.id, c.tool, c.undone]), [[change_id, 'categorize', false]])

    const after = undoConnectorChange(change_id)
    assert.equal(after.changes[0]!.undone, true)
    assert.equal(db.getTransaction('t1')!.categoryId, null)
    assert.equal(changed, seen + 2)
    assert.throws(() => undoConnectorChange(change_id), /already undone/)

    await setConnector({ allowChanges: false })
  })

  test('an oversize line is refused and the connection closed; the server goes on', async () => {
    const big = await talk([auth(), `"${'x'.repeat(MAX_LINE)}"`], 2)
    assert.equal(big.closed, true)
    assert.deepEqual(big.answers, [{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }])
    // Before the token: closed with no answer.
    assert.deepEqual(await talk(['x'.repeat(MAX_LINE + 1)], 1), { answers: [], closed: true })
    assert.deepEqual((await talk([auth(), req(1, 'ping')], 1)).answers, [{ jsonrpc: '2.0', id: 1, result: {} }])
  })

  test('a flood of requests on one connection is refused', async () => {
    const flood = await talk([auth(), ...Array.from({ length: 200 }, (_, i) => req(i + 1, 'ping'))], 201)
    assert.equal(flood.closed, true)
    assert.ok(flood.answers.length < 200)
    assert.deepEqual(flood.answers.at(-1), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Too many requests' } })
  })

  test('JSON-RPC: notifications go unanswered; bad lines, other methods and unknown tools get errors, in order', async () => {
    const r = await talk(
      [
        auth(),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        'not json',
        JSON.stringify({ id: 1, method: 'ping' }),
        req(2, 'initialize', { protocolVersion: '2025-11-25' }),
        req(3, 'tools/call', { name: 'drop_everything', arguments: {} }),
        req(4, 'tools/call', { name: 'search_transactions', arguments: 'all' }),
        req(5, 'ping')
      ],
      6
    )
    assert.deepEqual(
      r.answers.map((a) => [a.id, a.error?.code ?? 'ok']),
      [
        [null, -32700],
        [null, -32600],
        [2, -32601],
        [3, -32602],
        [4, -32602],
        [5, 'ok']
      ]
    )
  })

  test('a read answers from the books; bank text in it is only data', async () => {
    const r = (await talk([auth(), req(1, 'tools/call', { name: 'search_transactions', arguments: { query: 'COSTCO' } })], 1)).answers[0]
    assert.equal(r.result.isError, false)
    assert.deepEqual((JSON.parse(r.result.content[0].text) as Array<{ id: string }>).map((t) => t.id), ['t1'])
  })

  test('turned on again: a new token on a new endpoint, and the old token no longer opens it', async () => {
    const old = token()
    const oldPath = connectorEndpoint()!
    await setConnector({ on: true })
    assert.notEqual(token(), old)
    assert.notEqual(connectorEndpoint(), oldPath)
    assert.deepEqual(await talk([auth(old), req(1, 'ping')], 1), { answers: [], closed: true })
    assert.equal((await talk([auth(), req(1, 'ping')], 1)).answers.length, 1)
  })

  test('turned off: the server stops and the connection file is gone', async () => {
    const path = connectorEndpoint()!
    const s = await setConnector({ on: false })
    assert.deepEqual([s.on, s.running], [false, false])
    assert.equal(existsSync(file()), false)
    assert.equal(connectorEndpoint(), null)
    const reached = await new Promise<string>((done) => {
      const c = connect(path)
      c.on('connect', () => {
        c.destroy()
        done('connected')
      })
      c.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'))
    })
    assert.notEqual(reached, 'connected')
  })

  test("turned off, it leaves a connection file that isn't its own (another copy of the app wrote it since)", async () => {
    await setConnector({ on: true })
    const theirs = JSON.stringify({ v: 1, app: APP_NAME, path: 'elsewhere', token: 'f'.repeat(64), write: false, pid: 1 })
    writeFileSync(file(), theirs)
    await setConnector({ on: false })
    assert.equal(readFileSync(file(), 'utf8'), theirs)
    rmSync(file())
  })
})

describe('at launch', () => {
  /** A connection file as a run that's gone left it: this data folder's endpoint, unless `path` says otherwise. */
  const leftBehind = (o: { path?: string; pid?: number } = {}): string => {
    const c = { v: 1, app: APP_NAME, path: o.path ?? ownEndpoint('a'.repeat(16)), token: 'e'.repeat(64), write: false, pid: o.pid ?? process.pid }
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(c))
    return c.path
  }
  after(() => {
    db.setSetting('connector.on', '0')
    stopConnector()
    rmSync(file(), { force: true })
  })

  test('left on: it starts again with a new token and a new endpoint, over the file from before', async () => {
    const before = leftBehind()
    db.setSetting('connector.on', '1')
    await startConnector()
    assert.equal(connectorStatus().running, true, connectorStatus().error ?? '')
    const c = JSON.parse(readFileSync(file(), 'utf8')) as { path: string; token: string }
    assert.notEqual(c.token, 'e'.repeat(64))
    assert.notEqual(c.path, before)
    assert.equal(c.path, connectorEndpoint())
    assert.deepEqual((await talk([auth(), req(1, 'ping')], 1)).answers, [{ jsonrpc: '2.0', id: 1, result: {} }])
    stopConnector()
    assert.equal(existsSync(file()), false)
    assert.equal(connectorEndpoint(), null)
  })

  test("left off: a file from this data folder's earlier run, or from a copy that's gone, is deleted; a running copy's stays", async () => {
    db.setSetting('connector.on', '0')

    const socket = leftBehind()
    // A crash leaves a socket file behind too (a pipe goes with its server).
    if (process.platform !== 'win32') {
      mkdirSync(dirname(socket), { recursive: true })
      writeFileSync(socket, '')
    }
    await startConnector()
    assert.equal(existsSync(file()), false)
    assert.equal(existsSync(socket), false)
    assert.equal(connectorEndpoint(), null)

    leftBehind({ path: 'elsewhere', pid: deadPid() })
    await startConnector()
    assert.equal(existsSync(file()), false)

    const theirs = { path: process.platform === 'win32' ? '\\\\.\\pipe\\another-copy' : join(dir, 'another.sock') }
    leftBehind({ ...theirs, pid: process.pid })
    await startConnector()
    assert.equal((JSON.parse(readFileSync(file(), 'utf8')) as { path: string }).path, theirs.path)
    rmSync(file())
  })
})

describe('endpoints', () => {
  const slug = HOME_DIR_NAME.slice(1)
  const nonce = '0123456789abcdef'
  const base = { home: '/Users/sam', dataDir: '/Users/sam/Library/Application Support/Finance Tracker', user: 'sam', tmp: '/var/folders/xy/T', nonce }

  test('Windows: a pipe named for the user, the data folder and the start', () => {
    const win = { ...base, platform: 'win32' as const, home: 'C:\\Users\\sam', dataDir: 'C:\\Users\\sam\\AppData\\Roaming\\Finance Tracker', tmp: 'C:\\Temp' }
    const pipe = endpointFor(win)
    assert.match(pipe, new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\${slug}-[0-9a-f]{16}-${nonce}$`))
    assert.equal(endpointFor(win), pipe)
    assert.notEqual(endpointFor({ ...win, user: 'alex' }), pipe)
    assert.notEqual(endpointFor({ ...win, dataDir: 'D:\\scratch' }), pipe)
    assert.notEqual(endpointFor({ ...win, nonce: 'fedcba9876543210' }), pipe)
  })

  test('macOS and Linux: a socket in the hidden folder, or in the temp folder when that path is too long', () => {
    const mac = endpointFor({ ...base, platform: 'darwin' })
    assert.match(mac, new RegExp(`^/Users/sam/\\.${slug}/connector-[0-9a-f]{8}-${nonce}\\.sock$`))
    assert.ok(Buffer.byteLength(mac) <= SOCKET_PATH_MAX)
    assert.notEqual(endpointFor({ ...base, platform: 'darwin', user: 'alex' }), mac)
    assert.notEqual(endpointFor({ ...base, platform: 'darwin', nonce: 'fedcba9876543210' }), mac)

    const long = endpointFor({ ...base, platform: 'linux', home: `/home/${'a'.repeat(90)}` })
    assert.match(long, new RegExp(`^/var/folders/xy/T/${slug}-[0-9a-f]{12}-${nonce}\\.sock$`))
    assert.ok(Buffer.byteLength(long) <= SOCKET_PATH_MAX)
    // 103 bytes is macOS's limit: one more byte in the hidden folder's path moves it to the temp folder.
    const fits = `/h/${'b'.repeat(SOCKET_PATH_MAX - `/h//${HOME_DIR_NAME}/connector-00000000-${nonce}.sock`.length)}`
    assert.equal(Buffer.byteLength(endpointFor({ ...base, platform: 'darwin', home: fits })), SOCKET_PATH_MAX)
    assert.ok(endpointFor({ ...base, platform: 'darwin', home: `${fits}b` }).startsWith('/var/folders/xy/T/'))
  })
})

/** Reads a zip back: each entry's bytes (inflated, CRC checked), method and Unix mode, after checking the headers agree. */
function unzip(buf: Buffer): Map<string, { data: Buffer; method: number; mode: number }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'an end of central directory record')
  assert.equal(end + 22, buf.length)
  const count = buf.readUInt16LE(end + 10)
  const size = buf.readUInt32LE(end + 12)
  let p = buf.readUInt32LE(end + 16)
  assert.equal(p + size, end)
  const out = new Map<string, { data: Buffer; method: number; mode: number }>()
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const packed = buf.readUInt32LE(p + 20)
    const length = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
    const mode = buf.readUInt32LE(p + 38) >>> 16
    const at = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8')
    assert.equal(buf.readUInt32LE(at), 0x04034b50)
    assert.equal(buf.readUInt16LE(at + 6) & 0x0800, 0x0800, 'UTF-8 names')
    assert.equal(buf.readUInt16LE(at + 8), method)
    assert.equal(buf.readUInt32LE(at + 14), crc)
    const localName = buf.readUInt16LE(at + 26)
    assert.equal(buf.subarray(at + 30, at + 30 + localName).toString('utf8'), name)
    const from = at + 30 + localName + buf.readUInt16LE(at + 28)
    const body = buf.subarray(from, from + packed)
    assert.ok(method === 0 || method === 8, `${name}: stored or deflated`)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    assert.equal(data.length, length)
    assert.equal(crc32(data), crc, `${name}: CRC`)
    out.set(name, { data, method, mode })
    p += 46 + nameLength + skip
  }
  return out
}

describe('the extension', () => {
  // MANIFEST.md and schemas/mcpb-manifest-v0.3.schema.json (github.com/modelcontextprotocol/mcpb, read 2026-11-05): no other keys are allowed.
  const TOP = ['$schema', 'dxt_version', 'manifest_version', 'name', 'display_name', 'version', 'description', 'long_description', 'author', 'repository', 'homepage', 'documentation', 'support', 'icon', 'icons', 'screenshots', 'localization', 'server', 'tools', 'tools_generated', 'prompts', 'prompts_generated', 'keywords', 'license', 'privacy_policies', 'compatibility', 'user_config', '_meta']
  const within = (o: unknown, keys: string[], what: string): void => {
    assert.ok(o && typeof o === 'object' && !Array.isArray(o), `${what} is an object`)
    for (const k of Object.keys(o as object)) assert.ok(keys.includes(k), `${what}.${k} isn't in manifest 0.3`)
  }

  test('the manifest has what version 0.3 requires and nothing it refuses', () => {
    for (const icon of [true, false]) {
      const m = extensionManifest({ appName: APP_NAME, version: '0.1.0-beta.5', homeDirName: HOME_DIR_NAME, icon }) as Record<string, any>
      within(m, TOP, 'manifest')
      for (const k of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) assert.ok(k in m, k)
      assert.equal(m['manifest_version'], MANIFEST_VERSION)
      assert.equal(MANIFEST_VERSION, '0.3')
      for (const k of ['name', 'display_name', 'version', 'description']) assert.ok(typeof m[k] === 'string' && m[k].length > 0, k)
      assert.equal(m['display_name'], APP_NAME)
      within(m['author'], ['name', 'email', 'url'], 'author')
      assert.equal(m['author'].name, EXTENSION_AUTHOR)
      within(m['server'], ['type', 'entry_point', 'mcp_config'], 'server')
      assert.equal(m['server'].type, 'node')
      assert.equal(m['server'].entry_point, EXTENSION_ENTRY)
      within(m['server'].mcp_config, ['command', 'args', 'env', 'platform_overrides'], 'mcp_config')
      assert.deepEqual(m['server'].mcp_config, { command: 'node', args: ['${__dirname}/server/index.cjs'] })
      within(m['compatibility'], ['claude_desktop', 'platforms', 'runtimes'], 'compatibility')
      assert.ok(!('claude_desktop' in m['compatibility']), 'no Claude Desktop range: its versions moved from 1.x to 4.x')
      for (const p of m['compatibility'].platforms) assert.ok(['darwin', 'win32', 'linux'].includes(p), p)
      within(m['compatibility'].runtimes, ['python', 'node'], 'runtimes')
      assert.equal(m['tools_generated'], true)
      assert.ok(!('user_config' in m), 'Allow changes lives in the app, not in Claude Desktop')
      assert.equal(m['icon'], icon ? 'icon.png' : undefined)
    }
  })

  test("its identity stays put: Claude Desktop's id is local.mcpb.<author>.<name>, and the name follows the home folder, not the product", () => {
    const m = extensionManifest({ appName: 'Another Name', version: '9.9.9', homeDirName: HOME_DIR_NAME, icon: false }) as { name: string; author: { name: string } }
    assert.equal(m.name, HOME_DIR_NAME.slice(1))
    assert.equal(m.author.name, 'Lobos Labs')
  })

  test('the .mcpb is a zip Claude Desktop reads: manifest.json at its root beside the relay and the icon', () => {
    const icon = randomBytes(2048)
    const files = extensionFiles({ ...extension, icon })
    const z = unzip(zip(files))
    assert.deepEqual([...z.keys()], ['manifest.json', EXTENSION_ENTRY, 'icon.png'])
    for (const f of files) assert.ok(z.get(f.name)!.data.equals(f.data), f.name)
    for (const [name, e] of z) {
      assert.ok(!name.includes(':') && !name.includes('\\') && !name.startsWith('/'), name)
      assert.equal(e.mode, 0o100644, name)
    }
    assert.equal(new Set([...z.keys()].map((n) => n.toLowerCase())).size, z.size, 'no names that differ only in case')
    assert.equal(z.get('manifest.json')!.method, 8, 'text deflates')
    assert.equal(z.get('icon.png')!.method, 0, 'random bytes are stored')
    assert.deepEqual(JSON.parse(z.get('manifest.json')!.data.toString('utf8')), extensionManifest({ appName: APP_NAME, version: VERSION, homeDirName: HOME_DIR_NAME, icon: true }))
    // An empty file, and no icon: the manifest names none.
    assert.equal(unzip(zip([{ name: 'empty.txt', data: Buffer.alloc(0) }])).get('empty.txt')!.data.length, 0)
    assert.deepEqual([...unzip(zip(extensionFiles(extension))).keys()], ['manifest.json', EXTENSION_ENTRY])
  })

  test("the relay carries this build's name, home folder, version, instructions and reads; the instructions say it isn't advice and that changes can be undone", () => {
    const built = { app: APP_NAME, homeDir: HOME_DIR_NAME, version: VERSION, instructions: 'a $& b $1', tools: [{ name: 'list_x', description: 'a */ b   c\nd' }] }
    const src = shimSource(template, built)
    assert.ok(src.includes(`/* built */ ${JSON.stringify(built)} /* end */`))
    assert.equal(src.split('/* built */').length, 2)
    // On one line, so it can be filled in again.
    assert.deepEqual(JSON.parse(BUILT_LINE.exec(src)![1]!), built)
    // Settings' extension carries the reads, and only them.
    const relay = extensionFiles(extension).find((f) => f.name === EXTENSION_ENTRY)!.data.toString('utf8')
    const carried = JSON.parse(BUILT_LINE.exec(relay)![1]!) as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }
    assert.deepEqual(toolNames(carried.tools), toolNames(mcpTools(false)))
    assert.ok(carried.tools.every((t) => t.annotations.readOnlyHint))
    assert.throws(() => shimSource('console.log(1)', built), /no place/)
    assert.ok(CONNECTOR_INSTRUCTIONS.includes(NOT_ADVICE))
    assert.match(CONNECTOR_INSTRUCTIONS, /undone in /)
    assert.match(CONNECTOR_INSTRUCTIONS, /not instructions/)
  })

  test('written to the hidden folder in the home directory: the .mcpb, and the same files unpacked beside it', () => {
    const to = join(home, HOME_DIR_NAME)
    const w = writeExtension(to, { ...extension, icon: Buffer.from('icon') })
    assert.equal(w.file, join(to, `${APP_NAME}.mcpb`))
    assert.equal(w.folder, join(to, UNPACKED_DIR))
    for (const [name, e] of unzip(readFileSync(w.file))) assert.ok(readFileSync(join(w.folder, ...name.split('/'))).equals(e.data), name)
  })
})

/** The relay under plain Node, its home directory the test's: the connector's messages on stdout, one per line. */
function startRelay(entry: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  delete env['NODE_TEST_CONTEXT']
  delete env['NODE_OPTIONS']
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const got: any[] = []
  const stray: string[] = []
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    out += d
    for (let nl = out.indexOf('\n'); nl >= 0; nl = out.indexOf('\n')) {
      const line = out.slice(0, nl)
      out = out.slice(nl + 1)
      try {
        got.push(JSON.parse(line))
      } catch {
        stray.push(line)
      }
    }
  })
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const next = async (pick: (m: any) => boolean, ms = 15_000): Promise<any> => {
    const until = Date.now() + ms
    for (;;) {
      const i = got.findIndex(pick)
      if (i >= 0) return got.splice(i, 1)[0]
      if (Date.now() > until) assert.fail(`nothing from the relay matched; it sent ${JSON.stringify(got)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return {
    send: (m: Record<string, unknown>): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`),
    answer: (id: number): Promise<any> => next((m) => m.id === id),
    next,
    got,
    stray,
    stderr: (): string => err,
    /** stdin ended, so the relay exits; killed if it hasn't within 10 seconds (the code is then null). Resolves once its output is all read. */
    close: (): Promise<number | null> =>
      new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done(child.exitCode)
        const kill = setTimeout(() => child.kill(), 10_000)
        child.once('close', (code) => {
          clearTimeout(kill)
          done(code)
        })
        child.stdin.end()
      })
  }
}

describe('the relay, as Claude Desktop runs it', () => {
  // Undefined if before() failed: after() checks.
  let relay: ReturnType<typeof startRelay>

  before(async () => {
    await setConnector({ on: false })
    const { folder } = writeExtension(join(dir, 'extension'), extension)
    relay = startRelay(join(folder, ...EXTENSION_ENTRY.split('/')))
  })
  // The relay is closed and the settings put back whatever failed, so a failure is reported instead of the run hanging.
  after(async () => {
    try {
      if (relay) assert.equal(await relay.close(), 0)
    } finally {
      await setConnector({ on: false, allowChanges: false })
    }
    assert.deepEqual(relay?.stray ?? [], [], 'nothing but MCP messages on stdout')
  })

  test('it answers initialize itself, with the instructions, before the app is even open', async () => {
    assert.equal(existsSync(file()), false)
    relay.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
    const init = (await relay.answer(1)).result
    assert.equal(init.protocolVersion, '2025-11-25')
    assert.deepEqual(init.serverInfo, { name: APP_NAME, version: VERSION })
    assert.deepEqual(init.capabilities, { tools: { listChanged: true } })
    assert.equal(init.instructions, CONNECTOR_INSTRUCTIONS)
    assert.ok(init.instructions.includes(NOT_ADVICE))
    relay.send({ method: 'notifications/initialized' })
    relay.send({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    assert.equal((await relay.answer(2)).result.protocolVersion, '2025-11-25')
    relay.send({ id: 3, method: 'ping' })
    assert.deepEqual((await relay.answer(3)).result, {})
    relay.send({ id: 4, method: 'resources/list' })
    assert.equal((await relay.answer(4)).error.code, -32601)
  })

  test('with no connection file, tools/list is the reads the extension carries and a call says to open the app and turn the connector on; nothing of the call is logged', async () => {
    // Claude Desktop may keep the first list it gets: it gets tools, whose calls say what to do.
    relay.send({ id: 5, method: 'tools/list' })
    const list = await relay.answer(5)
    assert.deepEqual(toolNames(list.result.tools), toolNames(mcpTools(false)))
    relay.send({ id: 6, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'PRIVATE-WORDS' } } })
    const call = (await relay.answer(6)).result
    assert.equal(call.isError, true)
    assert.match(call.content[0].text, new RegExp(`Open ${APP_NAME}`))
    assert.ok(!relay.stderr().includes('PRIVATE-WORDS'))
    assert.ok(!relay.stderr().includes('search_transactions'))
  })

  test('once the connector is on, Claude Desktop is told the tools changed, and tools/list and tools/call reach the app', async () => {
    await setConnector({ on: true })
    await relay.next((m) => m.method === 'notifications/tools/list_changed')
    relay.send({ id: 7, method: 'tools/list' })
    assert.deepEqual(toolNames((await relay.answer(7)).result.tools), toolNames(mcpTools(false)))
    relay.send({ id: 8, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'COSTCO' } } })
    const r = (await relay.answer(8)).result
    assert.equal(r.isError, false)
    assert.deepEqual((JSON.parse(r.content[0].text) as Array<{ id: string }>).map((t) => t.id), ['t1'])
    // A write without Allow changes: the app's refusal, passed on.
    relay.send({ id: 9, method: 'tools/call', params: { name: 'delete_goal', arguments: { goal: 'any' } } })
    assert.equal((await relay.answer(9)).result.isError, true)
  })

  test('Allow changes turned on: told again, and the writes are listed', async () => {
    await setConnector({ allowChanges: true })
    await relay.next((m) => m.method === 'notifications/tools/list_changed')
    relay.send({ id: 10, method: 'tools/list' })
    assert.deepEqual(toolNames((await relay.answer(10)).result.tools), toolNames(mcpTools(true)))
  })

  test('the app restarting (a new token) is nothing to the relay: each request reads the file again', async () => {
    await setConnector({ on: true })
    relay.send({ id: 11, method: 'tools/call', params: { name: 'list_changes', arguments: {} } })
    assert.equal((await relay.answer(11)).result.isError, false)
  })

  test("it follows the file only to a local endpoint of a running app: never another host's pipe, a path dressed up, or a crashed run's name", async () => {
    const good = readFileSync(file(), 'utf8')
    const c = JSON.parse(good) as { path: string; pid: number }
    // Each of these reaches the app's own server if followed (\\localhost\pipe over SMB, the socket through "..").
    const offMachine =
      process.platform === 'win32' ? c.path.replace(/^\\\\\.\\/, '\\\\localhost\\') : `${dirname(c.path)}/../${basename(dirname(c.path))}/${basename(c.path)}`
    let id = 12
    for (const bad of [{ path: offMachine }, { pid: deadPid() }, { pid: undefined }]) {
      writeFileSync(file(), JSON.stringify({ ...c, ...bad }))
      relay.send({ id, method: 'tools/call', params: { name: 'list_changes', arguments: {} } })
      const a = (await relay.answer(id++)).result
      assert.equal(a.isError, true, JSON.stringify(bad))
      assert.match(a.content[0].text, new RegExp(`Open ${APP_NAME}`))
    }
    writeFileSync(file(), good)
    relay.send({ id, method: 'tools/call', params: { name: 'list_changes', arguments: {} } })
    assert.equal((await relay.answer(id)).result.isError, false)
  })

  test('the app gone again (the connector off, or quit): tools/list is the carried reads once more, and a call says to open it', async () => {
    await setConnector({ on: false })
    relay.send({ id: 30, method: 'tools/list' })
    assert.deepEqual(toolNames((await relay.answer(30)).result.tools), toolNames(mcpTools(false)))
    relay.send({ id: 31, method: 'tools/call', params: { name: 'categorize', arguments: { transaction_ids: ['t1'], category: 'Groceries' } } })
    const r = (await relay.answer(31)).result
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, new RegExp(`Open ${APP_NAME} and turn on Connector`))
  })

  test('an extension that carries no tools (an older one) says to open the app when tools/list finds it closed', async () => {
    const { folder } = writeExtension(join(dir, 'extension-without-tools'), { ...extension, tools: [] })
    const old = startRelay(join(folder, ...EXTENSION_ENTRY.split('/')))
    try {
      old.send({ id: 1, method: 'tools/list' })
      assert.match((await old.answer(1)).error.message, new RegExp(`Open ${APP_NAME} and turn on Connector`))
    } finally {
      assert.equal(await old.close(), 0)
    }
    assert.deepEqual(old.stray, [])
  })
})
