// Dev only: Claude Desktop's connector end to end on this computer, the way
// Claude Desktop runs it, against throwaway data. Not part of the app build.
//
//   cd finance-tracker && npm run e2e:connector               (builds the open edition into out/ first)
//   npm run e2e:connector -- --no-build --keep                (reuse out/; leave the scratch folder for a look)
//
// It builds the open edition (FINANCE_TRACKER_EDITION=open) unpackaged, starts
// it on a scratch data folder and a scratch home folder (FINANCE_TRACKER_HOME_DIR,
// a development build's only), loads the demo household, and drives the app
// through its own window (the Chrome DevTools protocol, window.api: the same
// calls Settings → Claude Desktop makes): Connector on, Install in Claude
// Desktop (which, on a scratch home, writes the extension without opening it).
// Then it reads the .mcpb back, checks its manifest against MCPB 0.3, unpacks
// it as Claude Desktop installs one, and runs its relay as Claude Desktop runs
// it: `node` with mcp_config's arguments, MCP over stdio, the home folder the
// scratch one. Over the relay: initialize, tools/list, reads checked against the
// app's own figures, a write refused with Allow changes off and journaled with
// it on (then undone in the app), a second connection while one is open, a
// wrong token and a stale one, the app quit, started again and crashed. The
// user's real connection file and extension are checked untouched at the end.
//
// Options: --no-build, --keep, --dir <folder> (the scratch folder; a new temp
// one by default). The app's window shows on screen while it runs (about 15
// seconds; a quit Chromium is slow to finish adds up to a minute). Exit code 0
// when every check passed.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { crc32, inflateRawSync } from 'node:zlib'
import { HOME_DIR_NAME } from '../src/main/build.ts'
import { mcpTools, type McpTool } from '../src/main/mcp.ts'
import { TOOLS } from '../src/main/tools.ts'
import { APP_NAME, NOT_ADVICE } from '../src/shared/app.ts'

const { values: opt } = parseArgs({
  options: {
    'no-build': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    dir: { type: 'string' }
  }
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const t0 = Date.now()
const stamp = (): string => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`
let passed = 0
const pass = (what: string, detail = ''): void => {
  passed++
  console.log(`${stamp()} PASS  ${what}${detail ? ` — ${detail}` : ''}`)
}
const note = (line: string): void => console.log(`${stamp()}       ${line}`)
class CheckFailed extends Error {}
function check(cond: unknown, what: string, detail = ''): asserts cond {
  if (!cond) throw new CheckFailed(`${what}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000, every = 100): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new CheckFailed(`timed out waiting for ${what}`)
    await sleep(every)
  }
}

// ---------- the scratch folders, and what of the user's real ones must stay as it is ----------

const realHome = homedir()
const realConnectorDir = join(realHome, HOME_DIR_NAME)
const forbidden = [process.env['APPDATA'] ? join(process.env['APPDATA'], 'Finance Tracker') : null, realConnectorDir].filter((d): d is string => !!d).map((d) => resolve(d).toLowerCase())
const offLimits = (p: string): boolean => forbidden.some((d) => resolve(p).toLowerCase().startsWith(d))

const work = resolve(opt.dir ?? mkdtempSync(join(tmpdir(), 'finance-connector-e2e-')))
if (offLimits(work)) throw new Error("connector-e2e works in a scratch folder only, never the app's own folders")
const dirs = { data: join(work, 'data'), home: join(work, 'home'), docs: join(work, 'docs'), bridge: join(work, 'bridge'), claudeConfig: join(work, 'claude-config'), claude: join(work, 'Claude Extensions') }
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
const scratchConnectorDir = join(dirs.home, HOME_DIR_NAME)
const connectionFile = join(scratchConnectorDir, 'connector.json')

/** What's at a path of the user's: absent, or its size, time and hash (a folder: its entries'). */
function fingerprint(p: string): string {
  if (!existsSync(p)) return 'absent'
  const s = statSync(p)
  if (s.isDirectory()) return readdirSync(p).sort().map((n) => `${n}:${fingerprint(join(p, n))}`).join('|')
  return `${s.size}:${s.mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`
}
const realPaths = [join(realConnectorDir, 'connector.json'), join(realConnectorDir, `${APP_NAME}.mcpb`), join(realConnectorDir, 'claude-extension')]
const realBefore = realPaths.map(fingerprint)

// ---------- the build ----------

if (!opt['no-build']) {
  note('building the open edition (FINANCE_TRACKER_EDITION=open electron-vite build)')
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, env: { ...process.env, FINANCE_TRACKER_EDITION: 'open' }, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr)
    throw new Error('the build failed')
  }
}

// ---------- the app, driven through its window ----------

const electron = process.env['FINANCE_TRACKER_TEST_ELECTRON'] || (createRequire(import.meta.url)('electron') as string)

const appEnv: NodeJS.ProcessEnv = { ...process.env }
for (const k of Object.keys(appEnv)) if (/^(ELECTRON_|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/i.test(k)) delete appEnv[k]
Object.assign(appEnv, {
  FINANCE_TRACKER_DATA_DIR: dirs.data,
  FINANCE_TRACKER_HOME_DIR: dirs.home,
  FINANCE_TRACKER_DOCS_DIR: dirs.docs,
  FINANCE_TRACKER_BRIDGE_DIR: dirs.bridge,
  CLAUDE_CONFIG_DIR: dirs.claudeConfig,
  // Nothing here calls the AI; if anything tried, it finds no CLI.
  FINANCE_TRACKER_CLAUDE: join(work, 'no-claude.exe')
})

interface Cdp {
  eval<T = unknown>(expr: string): Promise<T>
  close(): void
}

/** A page's DevTools connection: Runtime.evaluate, awaited, by value. */
async function cdp(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok(), { once: true })
    ws.addEventListener('error', () => fail(new Error('DevTools connection failed')), { once: true })
  })
  let next = 1
  const waiting = new Map<number, (m: any) => void>()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id !== undefined) waiting.get(m.id)?.(m)
  })
  ws.addEventListener('close', () => {
    for (const w of waiting.values()) w({ error: { message: 'the window closed' } })
    waiting.clear()
  })
  return {
    eval: <T>(expr: string): Promise<T> =>
      new Promise((ok, fail) => {
        const id = next++
        waiting.set(id, (m) => {
          waiting.delete(id)
          if (m.error) return fail(new Error(m.error.message))
          const r = m.result
          if (r.exceptionDetails) return fail(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
          ok(r.result.value as T)
        })
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true } }))
      }),
    close: () => ws.close()
  }
}

interface RunningApp {
  child: ChildProcess
  pid: number
  page: Cdp
  /** resolves with the exit code once the process is gone */
  exited: Promise<number | null>
  log: () => string
}

async function launchApp(): Promise<RunningApp> {
  const child = spawn(electron, [root, '--remote-debugging-port=0'], { cwd: root, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout!.setEncoding('utf8').on('data', (d: string) => void (out += d))
  child.stderr!.setEncoding('utf8').on('data', (d: string) => void (out += d))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  const port = await until('DevTools to listen', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1], 30_000)
  const page = await until(
    'the window',
    async () => {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>
        return list.find((t) => t.type === 'page' && t.url.startsWith('file:'))?.webSocketDebuggerUrl
      } catch {
        return undefined
      }
    },
    30_000,
    250
  )
  const c = await cdp(page)
  await until('window.api', () => c.eval<string>('typeof window.api').then((t) => t === 'object', () => false), 30_000, 250)
  return { child, pid: child.pid!, page: c, exited, log: () => out }
}

/** The app's processes as Windows lists them (for a quit that's slow), one line each. */
const processTree = (pid: number): string =>
  process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${pid} -or $_.ParentProcessId -eq ${pid} } | ForEach-Object { "$($_.ProcessId) " + $_.CommandLine.Substring(0, [Math]::Min(140, $_.CommandLine.Length)) }`], { encoding: 'utf8' }).stdout.trim()
    : ''

/**
 * Quits as the user does with Keep running in the background off: the window closed, then window-all-closed
 * closes the connector (its file deleted) and the database and quits. The connector's part has 10 seconds; the
 * process may take longer to be gone (it's noted when it takes over 5), up to a minute.
 */
async function quitApp(a: RunningApp): Promise<{ code: number | null; seconds: number }> {
  const s = await a.page.eval<{ keepRunning: boolean }>('window.api.setNotificationSettings({ keepRunning: false })')
  check(s.keepRunning === false, 'Keep running in the background is off')
  const closedAt = Date.now()
  // The page goes with the window, so the evaluation may not come back.
  await Promise.race([a.page.eval('window.close()').catch(() => null), sleep(2000)])
  a.page.close()
  await until('the connection file to go once the window closed', () => !existsSync(connectionFile), 10_000)
  const soon = await Promise.race([a.exited, sleep(5000).then(() => 'slow' as const)])
  if (soon !== 'slow') return { code: soon, seconds: (Date.now() - closedAt) / 1000 }
  note(`the app is still running 5 s after its window closed (its connector already closed); its processes: ${processTree(a.pid).replace(/\s*\n\s*/g, ' | ')}`)
  const late = await Promise.race([a.exited, sleep(55_000).then(() => 'timeout' as const)])
  if (late === 'timeout') {
    const appLog = existsSync(join(dirs.data, 'logs', 'app.log')) ? readFileSync(join(dirs.data, 'logs', 'app.log'), 'utf8').slice(-1500) : ''
    throw new CheckFailed(`the app did not exit within a minute of its window closing; its processes: ${processTree(a.pid)}; its log ends: ${appLog}; its output ends: ${a.log().slice(-1500)}`)
  }
  return { code: late, seconds: (Date.now() - closedAt) / 1000 }
}

// ---------- the extension, read back as Claude Desktop reads it ----------

/** A zip's entries (inflated, CRC checked), after checking the central directory and local headers agree. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  check(end >= 0 && end + 22 === buf.length, 'the .mcpb ends in a zip directory')
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    check(buf.readUInt32LE(p) === 0x02014b50, 'a central directory entry')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const packed = buf.readUInt32LE(p + 20)
    const length = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
    const at = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8')
    check(buf.readUInt32LE(at) === 0x04034b50, `${name}: a local header`)
    const from = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
    const body = buf.subarray(from, from + packed)
    check(method === 0 || method === 8, `${name}: stored or deflated`, `method ${method}`)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    check(data.length === length && crc32(data) === crc, `${name}: length and CRC`)
    check(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'), `${name}: a safe path`)
    out.set(name, data)
    p += 46 + nameLength + skip
  }
  return out
}

// MCPB's manifest 0.3 (github.com/modelcontextprotocol/mcpb, MANIFEST.md and schemas/mcpb-manifest-v0.3.schema.json,
// read 2026-11-12): draft-07, additionalProperties false at the top and in author, server, mcp_config and compatibility.
const TOP = ['$schema', 'dxt_version', 'manifest_version', 'name', 'display_name', 'version', 'description', 'long_description', 'author', 'repository', 'homepage', 'documentation', 'support', 'icon', 'icons', 'screenshots', 'localization', 'server', 'tools', 'tools_generated', 'prompts', 'prompts_generated', 'keywords', 'license', 'privacy_policies', 'compatibility', 'user_config', '_meta']
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
function onlyKeys(o: unknown, keys: string[], what: string): void {
  check(o !== null && typeof o === 'object' && !Array.isArray(o), `${what} is an object`)
  const extra = Object.keys(o as object).filter((k) => !keys.includes(k))
  check(extra.length === 0, `${what} has only keys manifest 0.3 allows`, extra.join(', '))
}
/** Whether Node `version` (x.y.z) meets a ">=x.y.z" range, the only form the manifest uses. */
const meets = (version: string, range: string): boolean => {
  const want = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range)
  const have = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!want || !have) return false
  for (let i = 1; i <= 3; i++) if (Number(have[i]) !== Number(want[i])) return Number(have[i]) > Number(want[i])
  return true
}

// ---------- the relay, as Claude Desktop runs it ----------

interface Relay {
  send(m: Record<string, unknown>): void
  request(method: string, params?: Record<string, unknown>, ms?: number): Promise<any>
  /** waits for a message the relay sent on its own (a notification) */
  next(pick: (m: any) => boolean, ms?: number): Promise<any>
  stray: string[]
  stderr(): string
  close(): Promise<number | null>
}

function startRelay(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Relay {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (/^(ELECTRON_|NODE_OPTIONS$|NODE_TEST_CONTEXT$|FINANCE_TRACKER_)/i.test(k)) delete env[k]
  // The relay finds the connection file under os.homedir(): USERPROFILE on Windows, HOME elsewhere.
  Object.assign(env, { HOME: dirs.home, USERPROFILE: dirs.home }, extraEnv)
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const got: any[] = []
  const stray: string[] = []
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    out += d
    for (let nl = out.indexOf('\n'); nl >= 0; nl = out.indexOf('\n')) {
      const line = out.slice(0, nl)
      out = out.slice(nl + 1)
      try {
        const m = JSON.parse(line)
        if (m?.jsonrpc !== '2.0') stray.push(line)
        got.push(m)
      } catch {
        stray.push(line)
      }
    }
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => void (err += d))
  let id = 100
  const next = (pick: (m: any) => boolean, ms = 15_000): Promise<any> =>
    until(
      'the relay',
      () => {
        const i = got.findIndex(pick)
        return i >= 0 ? got.splice(i, 1)[0] : undefined
      },
      ms,
      25
    )
  const send = (m: Record<string, unknown>): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  return {
    send,
    request: (method, params, ms) => {
      const n = id++
      send({ id: n, method, ...(params ? { params } : {}) })
      return next((m) => m.id === n, ms)
    },
    next,
    stray,
    stderr: () => err,
    close: () =>
      new Promise((done) => {
        if (child.exitCode !== null) return done(child.exitCode)
        const kill = setTimeout(() => child.kill(), 10_000)
        child.once('close', (code) => {
          clearTimeout(kill)
          done(code)
        })
        child.stdin.end()
      })
  }
}

/** A tool's answer: its text blocks parsed where they're JSON. */
const call = async (relay: Relay, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: any[] }> => {
  const a = await relay.request('tools/call', { name, arguments: args })
  if (a.error) throw new CheckFailed(`tools/call ${name}: JSON-RPC error ${a.error.code} ${a.error.message}`)
  const blocks = (a.result.content as Array<{ type: string; text: string }>).map((b) => b.text)
  return {
    isError: a.result.isError === true,
    text: blocks.join('\n'),
    json: blocks.map((t) => {
      try {
        return JSON.parse(t)
      } catch {
        return undefined
      }
    })
  }
}

/** One raw connection to the app's pipe: writes the lines and reads answers until `want` came or the app closed it. */
function rawTalk(path: string, lines: string[], want: number, holdMs = 10_000): Promise<{ answers: any[]; closed: boolean; socket: ReturnType<typeof connect> }> {
  return new Promise((done) => {
    const s = connect(path)
    const answers: any[] = []
    let text = ''
    let over = false
    const finish = (closed: boolean): void => {
      if (over) return
      over = true
      clearTimeout(timer)
      done({ answers, closed, socket: s })
    }
    const timer = setTimeout(() => finish(false), holdMs)
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
    s.on('error', () => {})
    s.on('close', () => finish(true))
  })
}

interface ConnectionFile {
  v: number
  app: string
  path: string
  token: string
  write: boolean
  pid: number
}
const readConnection = (): ConnectionFile | null => (existsSync(connectionFile) ? (JSON.parse(readFileSync(connectionFile, 'utf8')) as ConnectionFile) : null)
const names = (tools: Array<{ name: string }>): string[] => tools.map((t) => t.name).sort()
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const OPEN_APP = new RegExp(`Open ${APP_NAME} and turn on Connector`)

// ---------- the run ----------

let app: RunningApp | null = null
const relays: Relay[] = []
let failed: string | null = null

try {
  note(`scratch folder ${work}`)
  // 1. The app, the demo household, the connector.
  app = await launchApp()
  const plan = await app.page.eval<{ openEdition: boolean }>('window.api.getPlan()')
  check(plan.openEdition === true, 'the app is the open edition', JSON.stringify(plan))
  pass('the open edition starts on a scratch data folder and home folder', `pid ${app.pid}`)
  const demo = await app.page.eval<{ accounts: number; transactions: number }>('window.api.loadDemoData()')
  check(demo.accounts > 0 && demo.transactions > 0, 'the demo household loads', JSON.stringify(demo))
  pass('the demo household loads', `${demo.accounts} accounts, ${demo.transactions} transactions`)

  const off = await app.page.eval<any>('window.api.connectorStatus()')
  check(off.offered === true && off.on === false && off.running === false, 'Settings → Claude Desktop is offered, off', JSON.stringify(off))
  check(!existsSync(connectionFile), 'off: no connection file')
  pass('Settings → Claude Desktop is offered and off by default; no connection file')

  const on = await app.page.eval<any>('window.api.setConnector({ on: true })')
  check(on.on && on.running && on.error === null, 'Connector turned on: running', JSON.stringify(on))
  const c1 = readConnection()
  check(c1 && c1.v === 1 && c1.app === APP_NAME && /^[0-9a-f]{64}$/.test(c1.token) && c1.write === false && c1.pid === app.pid, 'the connection file: v1, the app, a 32-byte token, write off, the app\'s pid', JSON.stringify({ ...c1, token: '…' }))
  check(process.platform !== 'win32' || /^\\\\\.\\pipe\\[a-z0-9-]+-[0-9a-f]{16}-[0-9a-f]{16}$/.test(c1.path), 'a local named pipe', c1.path)
  pass('Connector on: the server runs and the connection file is in the scratch home folder', c1.path)

  // 2. Install in Claude Desktop: the app writes the extension (and, on a scratch home, opens nothing).
  const install = await app.page.eval<{ file: string; opened: boolean }>('window.api.installConnector()')
  check(resolve(install.file) === resolve(join(scratchConnectorDir, `${APP_NAME}.mcpb`)), 'the .mcpb is written to the scratch home folder', install.file)
  check(install.opened === false, 'a scratch home\'s extension is not opened in Claude Desktop')
  pass('Install in Claude Desktop writes the .mcpb (not opened: the home folder is a scratch one)', install.file)

  const files = unzip(readFileSync(install.file))
  check(files.has('manifest.json') && files.has('server/index.cjs'), 'the .mcpb holds manifest.json and server/index.cjs', [...files.keys()].join(', '))
  for (const [name, data] of files) check(readFileSync(join(scratchConnectorDir, 'claude-extension', ...name.split('/'))).equals(data), `the unpacked copy's ${name} is the .mcpb's`)
  pass('the .mcpb is a sound zip; the unpacked copy beside it matches', [...files.keys()].join(', '))

  // 3. The manifest against MCPB 0.3.
  const m = JSON.parse(files.get('manifest.json')!.toString('utf8'))
  onlyKeys(m, TOP, 'manifest')
  for (const k of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) check(k in m, `manifest.${k} is there (required)`)
  check(m.manifest_version === '0.3', 'manifest_version is "0.3"', m.manifest_version)
  check(SEMVER.test(m.version), 'version is semver', m.version)
  for (const k of ['name', 'display_name', 'description']) check(typeof m[k] === 'string' && m[k].length > 0, `${k} is a string`)
  onlyKeys(m.author, ['name', 'email', 'url'], 'author')
  check(typeof m.author.name === 'string' && m.author.name, 'author.name')
  onlyKeys(m.server, ['type', 'entry_point', 'mcp_config'], 'server')
  check(m.server.type === 'node' && files.has(m.server.entry_point), 'server: node, its entry_point in the .mcpb', m.server.entry_point)
  onlyKeys(m.server.mcp_config, ['command', 'args', 'env', 'platform_overrides'], 'mcp_config')
  check(m.server.mcp_config.command === 'node' && Array.isArray(m.server.mcp_config.args) && m.server.mcp_config.args.every((a: unknown) => typeof a === 'string'), 'mcp_config: node with string args')
  onlyKeys(m.compatibility, ['claude_desktop', 'platforms', 'runtimes'], 'compatibility')
  check(m.compatibility.platforms.includes(process.platform), `compatibility.platforms has ${process.platform}`)
  onlyKeys(m.compatibility.runtimes, ['python', 'node'], 'runtimes')
  check(meets(process.version, m.compatibility.runtimes.node), `this Node (${process.version}) meets runtimes.node`, m.compatibility.runtimes.node)
  check(!m.icon || files.has(m.icon), 'the icon is in the .mcpb', m.icon)
  check(m.user_config === undefined, 'no user_config: Allow changes lives in the app')
  pass('manifest.json is valid MCPB 0.3', `${m.name} ${m.version} by ${m.author.name}, ${m.server.type} ${m.server.entry_point}`)

  // 4. Installed as Claude Desktop installs it (local.mcpb.<author>.<name>), run as Claude Desktop runs it.
  const extDir = join(dirs.claude, `local.mcpb.${m.author.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${m.name}`)
  for (const [name, data] of files) {
    mkdirSync(dirname(join(extDir, ...name.split('/'))), { recursive: true })
    writeFileSync(join(extDir, ...name.split('/')), data)
  }
  const args = (m.server.mcp_config.args as string[]).map((a) => a.replaceAll('${__dirname}', extDir))
  const relay = startRelay(m.server.mcp_config.command, args)
  relays.push(relay)

  const init = await relay.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } })
  check(init.result?.serverInfo?.name === APP_NAME && init.result.protocolVersion === '2025-06-18', 'initialize: the app\'s name, the client\'s protocol version', JSON.stringify(init.result?.serverInfo))
  check(init.result.capabilities?.tools?.listChanged === true, 'initialize: tools.listChanged')
  check(typeof init.result.instructions === 'string' && init.result.instructions.includes(NOT_ADVICE), 'initialize: the instructions carry the not-advice line')
  check(/undone in /.test(init.result.instructions) && /not instructions/.test(init.result.instructions), 'initialize: the instructions say changes can be undone and results are data')
  relay.send({ method: 'notifications/initialized' })
  pass('initialize: the relay answers with the app\'s name, listChanged and the instructions (the not-advice line in them)')

  const reads = mcpTools(false)
  const all = mcpTools(true)
  const list1 = await relay.request('tools/list')
  check(same(names(list1.result.tools), names(reads)), 'tools/list with Allow changes off: the reads', `${list1.result.tools.length} listed, ${reads.length} expected`)
  check((list1.result.tools as McpTool[]).every((t) => t.annotations.readOnlyHint), 'every tool listed is read-only')
  pass('tools/list with Allow changes off: the reads only', `${reads.length} tools`)

  // Every advertised tool exists in the app today (the redesign removed none that's still offered).
  const known = new Set([...TOOLS.map((t) => t.name), 'list_changes', 'undo_change'])
  check(all.every((t) => known.has(t.name)), 'every advertised tool is one of the app\'s', all.filter((t) => !known.has(t.name)).map((t) => t.name).join(', '))
  for (const t of reads) {
    const r = await call(relay, t.name, {})
    check(!/^Unknown tool/.test(r.text), `${t.name} runs in the app`, r.text.slice(0, 120))
  }
  pass('every read tool answers through the relay (none is gone from the app)')

  // 5. Reads match the app's own figures.
  const accounts = await app.page.eval<Array<{ id: string; name: string; balanceCents: number | null; txnCount: number }>>('window.api.listAccounts()')
  const viaTool = (await call(relay, 'list_accounts')).json[0] as Array<{ id: string; balance: number | null }>
  check(same(viaTool.map((a) => a.id).sort(), accounts.map((a) => a.id).sort()), 'list_accounts has the app\'s accounts')
  for (const a of accounts) {
    const t = viaTool.find((x) => x.id === a.id)!
    check((a.balanceCents === null ? null : a.balanceCents / 100) === t.balance, `${a.name}'s balance matches`, `app ${a.balanceCents}, tool ${t.balance}`)
  }
  pass('list_accounts matches Accounts in the app', `${accounts.length} accounts, ${accounts.map((a) => `${a.name} ${a.balanceCents === null ? '—' : (a.balanceCents / 100).toFixed(2)}`).slice(0, 3).join(', ')}…`)

  const lower = (s: string): string => s.toLowerCase()
  const pick = accounts.filter((a) => a.txnCount > 0 && a.txnCount <= 100 && !accounts.some((b) => b.id !== a.id && lower(b.name).includes(lower(a.name)))).sort((a, b) => b.txnCount - a.txnCount)[0]
  check(pick, 'an account with 1 to 100 transactions and a name of its own')
  const page = await app.page.eval<{ rows: Array<{ id: string; amountCents: number; categoryId: number | null }>; total: number }>(`window.api.listTransactions({ accountId: ${JSON.stringify(pick.id)}, limit: 500 })`)
  const found = (await call(relay, 'search_transactions', { account: pick.name, limit: 100 })).json[0] as Array<{ id: string; amount: number }>
  check(same(found.map((t) => t.id).sort(), page.rows.map((t) => t.id).sort()), `search_transactions on ${pick.name} has the app's transactions`, `${found.length} vs ${page.rows.length}`)
  for (const r of page.rows) check(found.find((t) => t.id === r.id)!.amount === r.amountCents / 100, `transaction ${r.id}'s amount matches`)
  const sum = (cents: number[]): string => (cents.reduce((s, x) => s + x, 0) / 100).toFixed(2)
  pass(`search_transactions matches Transactions in the app for ${pick.name}`, `${page.rows.length} transactions, ${sum(page.rows.map((r) => r.amountCents))} both ways`)

  // 6. A write with Allow changes off is refused, and nothing changes.
  const cats = await app.page.eval<Array<{ id: number; name: string; kind: string }>>('window.api.listCategories()')
  const target = page.rows.find((r) => r.categoryId !== null) ?? page.rows[0]!
  const fromCat = target.categoryId
  const toCat = cats.find((c) => c.kind === 'expense' && c.id !== fromCat && c.name !== 'Groceries') ?? cats.find((c) => c.id !== fromCat)!
  const categorizeArgs = { transaction_ids: [target.id], category: toCat.name }
  const categoryNow = async (): Promise<number | null> => (await app!.page.eval<{ rows: Array<{ categoryId: number | null }> }>(`window.api.listTransactions({ ids: [${JSON.stringify(target.id)}] })`)).rows[0]!.categoryId
  const refused = await call(relay, 'categorize', categorizeArgs)
  check(refused.isError && /Allow changes is off/.test(refused.text), 'categorize with Allow changes off is refused', refused.text)
  check((await categoryNow()) === fromCat, 'the transaction is as it was')
  pass('a write with Allow changes off is refused, saying why; the books are unchanged', refused.text)

  // 7. Allow changes on: Claude Desktop is told, the writes are listed, a change is journaled, Undo in the app restores it.
  await app.page.eval('window.api.setConnector({ allowChanges: true })')
  await relay.next((x) => x.method === 'notifications/tools/list_changed', 10_000)
  const list2 = await relay.request('tools/list')
  check(same(names(list2.result.tools), names(all)), 'tools/list with Allow changes on: every tool', `${list2.result.tools.length} listed`)
  const writes = (list2.result.tools as McpTool[]).filter((t) => !t.annotations.readOnlyHint)
  const adds = writes.filter((t) => !t.annotations.destructiveHint).map((t) => t.name)
  check(adds.every((n) => /^(create|add|remember|record_flows)/.test(n)), 'the only writes not marked destructive add a record', adds.join(', '))
  pass('Allow changes on: list_changed sent; tools/list has the writes, every one that replaces or removes marked destructive', `${writes.length} writes; only-adds: ${adds.join(', ')}`)

  const done = await call(relay, 'categorize', categorizeArgs)
  check(!done.isError, 'categorize with Allow changes on succeeds', done.text)
  const changeId = done.json.find((j) => j && typeof j.change_id === 'number')?.change_id as number
  check(Number.isInteger(changeId), 'the result carries a change_id', done.text)
  check((await categoryNow()) === toCat.id, `the transaction is now ${toCat.name} in the app`)
  const status1 = await app.page.eval<any>('window.api.connectorStatus()')
  check(status1.changes[0]?.id === changeId && status1.changes[0].tool === 'categorize' && !status1.changes[0].undone, 'Settings → Claude Desktop lists the change', JSON.stringify(status1.changes[0]))
  const listed = (await call(relay, 'list_changes')).json[0] as Array<{ id: number; undone: boolean }>
  check(listed.some((x) => x.id === changeId && !x.undone), 'list_changes shows it')
  pass('a write with Allow changes on is made and journaled under the connector', `change ${changeId}: ${status1.changes[0].summary}`)

  await app.page.eval(`window.api.undoConnectorChange(${changeId})`)
  check((await categoryNow()) === fromCat, 'Undo in Settings puts the category back')
  const listed2 = (await call(relay, 'list_changes')).json[0] as Array<{ id: number; undone: boolean }>
  check(listed2.some((x) => x.id === changeId && x.undone), 'list_changes shows it undone')
  pass('Undo in Settings → Claude Desktop restores it; Claude sees it undone')

  // 8. A second connection while one is open, and two calls at once.
  const c2 = readConnection()!
  const held = await rawTalk(c2.path, [JSON.stringify({ auth: c2.token })], 1, 300)
  check(!held.closed, 'a connection that has sent its token stays open')
  const ids = [relay.request('tools/call', { name: 'list_goals', arguments: {} }), relay.request('tools/call', { name: 'list_accounts', arguments: {} })]
  const both = await Promise.all(ids)
  check(both.every((a) => a.result && a.result.isError === false), 'two calls at once are both answered')
  const pong = await new Promise<any>((ok) => {
    held.socket.once('data', (d) => ok(JSON.parse(String(d).split('\n')[0]!)))
    held.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`)
  })
  check(pong.id === 7 && pong.result, 'the held connection still answers', JSON.stringify(pong))
  held.socket.destroy()
  pass('a second connection while one is open: both served, and two relay calls at once both answered')

  // 9. A wrong token, and a stale one.
  const wrong = await rawTalk(c2.path, [JSON.stringify({ auth: 'f'.repeat(64) }), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })], 1)
  check(wrong.closed && wrong.answers.length === 0, 'a wrong token is closed unanswered')
  const good = readFileSync(connectionFile, 'utf8')
  writeFileSync(connectionFile, JSON.stringify({ ...c2, token: '0'.repeat(64) }))
  const wrongFile = await call(relay, 'list_accounts')
  check(wrongFile.isError && OPEN_APP.test(wrongFile.text), 'a connection file with a wrong token: the call says to open the app', wrongFile.text)
  writeFileSync(connectionFile, good)
  check(!(await call(relay, 'list_accounts')).isError, 'the right file again: the call works')
  pass('a wrong token is shut out at the pipe; the relay says to open the app and turn the connector on', wrongFile.text)

  await app.page.eval('window.api.setConnector({ on: false })')
  check(!existsSync(connectionFile), 'Connector off: the connection file is gone')
  const offCall = await call(relay, 'list_accounts')
  check(offCall.isError && OPEN_APP.test(offCall.text), 'Connector off: the call says to turn it on', offCall.text)
  await app.page.eval('window.api.setConnector({ on: true })')
  const c3 = readConnection()!
  check(c3.token !== c2.token && c3.path !== c2.path && c3.write === true, 'on again: a new token on a new pipe, Allow changes kept')
  const stale = await rawTalk(c3.path, [JSON.stringify({ auth: c2.token }), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })], 1)
  check(stale.closed && stale.answers.length === 0, 'the old token no longer opens it')
  check(!(await call(relay, 'list_accounts')).isError, 'the relay follows the new file without a restart')
  pass('Connector off and on: the old token is stale and refused; the relay picks up the new one by itself')

  // 10. The app closed: every call says to open it; the list is the reads this build had, so Claude has tools to say so with.
  const quit1 = await quitApp(app)
  app = null
  check(!existsSync(connectionFile), 'quitting deletes the connection file')
  pass('the app quits (window closed, Keep running off); the connection file is gone', `exit ${quit1.code} after ${quit1.seconds.toFixed(1)} s`)
  const closedCall = await call(relay, 'list_accounts')
  check(closedCall.isError && OPEN_APP.test(closedCall.text), 'app closed: the call says to open the app', closedCall.text)
  const closedList = await relay.request('tools/list')
  check(closedList.result && same(names(closedList.result.tools), names(reads)), 'app closed: tools/list answers the reads', JSON.stringify(closedList.error ?? closedList.result?.tools?.length))
  pass('app closed: tools/call says to open it; tools/list still has the reads (from the extension)', closedCall.text)

  // 11. Started again (the connector was left on): a new token, and Claude Desktop is told.
  app = await launchApp()
  const c4 = await until('the connection file at launch', () => readConnection(), 15_000)
  check(c4.pid === app.pid && c4.token !== c3.token && c4.write === true, 'at launch the connector is on again with a new token', JSON.stringify({ pid: c4.pid }))
  await relay.next((x) => x.method === 'notifications/tools/list_changed', 10_000)
  const list3 = await relay.request('tools/list')
  check(same(names(list3.result.tools), names(all)), 'started again: tools/list has every tool (Allow changes kept)')
  check(!(await call(relay, 'list_accounts')).isError, 'started again: the call works')
  pass('the app started again: the connector is back on by itself, the relay tells Claude Desktop, calls work')

  // 12. A crash leaves the file behind: the relay won't follow it, and the next launch clears it.
  app.page.close()
  app.child.kill()
  await app.exited
  app = null
  const left = readConnection()
  check(left && left.pid === c4.pid, 'a crash leaves the connection file behind')
  const crashed = await call(relay, 'list_accounts')
  check(crashed.isError && OPEN_APP.test(crashed.text), "after a crash the relay won't follow the file (its pid is gone)", crashed.text)
  app = await launchApp()
  const c5 = await until('a new connection file', () => {
    const c = readConnection()
    return c && c.pid !== c4.pid ? c : null
  })
  check(c5.pid === app.pid, 'the next launch replaces it')
  check(!(await call(relay, 'list_accounts')).isError, 'and calls work again')
  await quitApp(app)
  app = null
  check(!existsSync(connectionFile), 'quit: no connection file left')
  pass('after a crash the relay ignores the file left behind; the next launch replaces it; quitting removes it')

  // 13. Claude Desktop's built-in Node is Electron's: the relay under it too.
  const builtIn = startRelay(electron, args, { ELECTRON_RUN_AS_NODE: '1' })
  relays.push(builtIn)
  const init2 = await builtIn.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } })
  const closed2 = await call(builtIn, 'list_accounts')
  check(init2.result?.serverInfo?.name === APP_NAME && closed2.isError && OPEN_APP.test(closed2.text), "under Electron's Node (as Claude Desktop's built-in Node runs it) the relay answers too")
  pass("the relay runs under Electron's own Node too", `Node ${spawnSync(electron, ['-p', 'process.version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).stdout.trim()}`)

  // 14. Only MCP on stdout; nothing of a request on stderr.
  for (const r of relays) {
    check(r.stray.length === 0, 'nothing but MCP messages on the relay\'s stdout', r.stray.slice(0, 2).join(' | '))
    check(!r.stderr().includes(target.id) && !r.stderr().includes(toCat.name) && !r.stderr().includes(pick.name), "the relay's stderr has no request contents", r.stderr().slice(0, 200))
  }
  pass("the relay wrote only MCP messages to stdout, and nothing of a request to stderr", relay.stderr().trim().split('\n').slice(0, 2).join(' | '))
} catch (err) {
  failed = err instanceof Error ? err.message : String(err)
  if (!(err instanceof CheckFailed) && err instanceof Error && err.stack) console.error(err.stack)
} finally {
  for (const r of relays) await r.close().catch(() => null)
  if (app) {
    app.page.close()
    app.child.kill()
    await app.exited
  }
}

// 15. The user's own connection file and extension: as they were.
const realAfter = realPaths.map(fingerprint)
const touched = realPaths.filter((_, i) => realBefore[i] !== realAfter[i])
if (!failed && touched.length) failed = `the user's real files changed: ${touched.join(', ')}`
if (!failed) pass(`the user's own ${HOME_DIR_NAME} connection file and extension are untouched`, realPaths.map((p, i) => `${p.slice(realConnectorDir.length + 1)} ${realAfter[i] === 'absent' ? 'absent' : 'kept'}`).join(', '))

// A failed run's folder stays, for the app's log (data/logs/app.log).
if (!opt.keep && !failed) rmSync(work, { recursive: true, force: true })
else note(`left ${work}`)
if (failed) {
  console.log(`${stamp()} FAIL  ${failed}`)
  console.log(`\n${passed} passed, 1 failed`)
  process.exit(1)
}
console.log(`\n${passed} checks passed`)
