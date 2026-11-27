'use strict'

// The Claude Desktop extension's server: a relay between Claude Desktop (MCP
// over stdio, one JSON-RPC message per line) and the running app's connector
// (src/main/connector.ts). It answers initialize and ping itself. For
// tools/list and tools/call it reads the connection file the app writes in
// the user's home folder, connects to the pipe or socket named there (only a
// local one, and only while the app that wrote the file is running), sends
// the token, passes on the one request and closes, so the app can restart
// at any time. It never opens the database and never starts the app: on
// Windows a process Claude Desktop starts sees a redirected copy of AppData,
// so the home folder and the pipe are all the two share. Only MCP messages go
// to stdout (Claude Desktop reads every write there as one), and nothing of a
// request is logged.
//
// The app fills in BUILT when it writes the extension (src/main/mcpb.ts).

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const BUILT = /* built */ { app: 'Finance Tracker', homeDir: '.finance-tracker', version: '0.0.0', instructions: '', tools: [] } /* end */

/** Newest first: initialize answers the client's version when it's one of these, else the first. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
/** The longest request passed on; the app refuses a longer line too. */
const MAX_REQUEST = 1024 * 1024
/** The longest answer read back from the app. */
const MAX_ANSWER = 8 * 1024 * 1024
/** How long the app has to answer one request. */
const TIMEOUT_MS = 60_000
/** How often the connection file is looked at, to tell Claude Desktop when the tools change. */
const WATCH_MS = 2000

const connectionFile = () => path.join(os.homedir(), BUILT.homeDir, 'connector.json')
const unreachable = () => `${BUILT.app} isn't answering. Open ${BUILT.app} and turn on Connector in Settings → Claude Desktop.`

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
// Why a request didn't reach the app, as an error code: never the request itself.
const log = (line) => process.stderr.write(`[${BUILT.app}] ${line}\n`)

/** A local named pipe, as the app names one: \\host\pipe\... would reach another machine over SMB. */
const PIPE = /^\\\\\.\\pipe\\[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A pipe or socket on this machine where the app makes one, and nowhere else. */
function local(p) {
  if (process.platform === 'win32') return PIPE.test(p)
  if (!path.isAbsolute(p) || path.normalize(p) !== p || !p.endsWith('.sock')) return false
  const at = path.dirname(p)
  return at === path.join(os.homedir(), BUILT.homeDir) || at === os.tmpdir()
}

/** The app that wrote the file is still running: a crash leaves the file behind, naming a pipe anyone could take since. */
function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH'
  }
}

/** The app's connection file, or null when the connector is off or the app isn't running. */
function readConnection() {
  let c
  try {
    c = JSON.parse(fs.readFileSync(connectionFile(), 'utf8'))
  } catch {
    return null
  }
  return c && c.v === 1 && typeof c.path === 'string' && typeof c.token === 'string' && local(c.path) && running(c.pid) ? c : null
}

/** What the tools depend on: whether the app is there, and whether it allows changes. */
const toolState = (c) => (c ? (c.write ? 'write' : 'read') : 'none')

/** One request on its own connection: the app's answer (a JSON-RPC response), or a rejection with a short reason. */
function ask(request) {
  return new Promise((resolve, reject) => {
    const c = readConnection()
    if (!c) {
      reject(new Error('no connection file'))
      return
    }
    const socket = net.createConnection(c.path)
    let text = ''
    let done = false
    const finish = (err, answer) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(answer)
    }
    const timer = setTimeout(() => finish(new Error('timed out')), TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ auth: c.token })}\n${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      text += chunk
      if (text.length > MAX_ANSWER) return finish(new Error('answer too long'))
      const nl = text.indexOf('\n')
      if (nl < 0) return
      try {
        finish(null, JSON.parse(text.slice(0, nl)))
      } catch {
        finish(new Error('unreadable answer'))
      }
    })
    socket.on('error', (err) => finish(new Error(err.code || 'connection error')))
    socket.on('close', () => finish(new Error('closed')))
  })
}

/** The tool state the last tools/list was answered in; null until there was one. */
let listed = null

async function forward(id, method, params) {
  try {
    const answer = await ask({ jsonrpc: '2.0', id: 1, method, params })
    if (method === 'tools/list') listed = toolState(readConnection())
    if (answer.error) send({ id, error: answer.error })
    else send({ id, result: answer.result })
  } catch (err) {
    log(`${method}: ${err.message}`)
    if (method === 'tools/list') listed = 'none'
    // A call's failure is the model's to read and pass on.
    if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: unreachable() }], isError: true } })
    // The app's reads as this build had them: Claude Desktop may keep the first list it gets, or drop an extension
    // whose list fails, so it gets tools whose every call says to open the app. Without them, the list fails.
    else if (method === 'tools/list' && Array.isArray(BUILT.tools) && BUILT.tools.length) send({ id, result: { tools: BUILT.tools } })
    else send({ id, error: { code: -32000, message: unreachable() } })
  }
}

// The app starting, the connector turned on or Allow changes switched: Claude Desktop is told to list the tools again.
function watch() {
  fs.watchFile(connectionFile(), { interval: WATCH_MS, persistent: false }, () => {
    if (listed === null) return
    const now = toolState(readConnection())
    if (now === 'none' || now === listed) return
    listed = now
    send({ method: 'notifications/tools/list_changed' })
  })
}

function answer(msg) {
  const id = msg.id
  const method = msg.method
  // Notifications (initialized, cancelled) and responses: nothing to answer.
  if (id === undefined || id === null || typeof method !== 'string') return
  const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {}
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion
      send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: BUILT.app, version: BUILT.version },
          instructions: BUILT.instructions
        }
      })
      return
    }
    case 'ping':
      send({ id, result: {} })
      return
    case 'tools/list':
    case 'tools/call':
      void forward(id, method, params)
      return
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return
  if (Buffer.byteLength(line) > MAX_REQUEST) {
    send({ id: null, error: { code: -32600, message: 'Request too large' } })
    return
  }
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    send({ id: null, error: { code: -32600, message: 'Invalid Request' } })
    return
  }
  answer(msg)
})

watch()
