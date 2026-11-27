import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { LATEST_SCHEMA_VERSION, openDb, schemaVersion } from './db'
import { configureLicense } from './license'
import { DOC_TOOLS, RESULT_LIMIT, runAssistantTool, setTurnId, TOOLS } from './tools'

// The review assistant's tools as an MCP server (stdio, newline-delimited
// JSON-RPC), for Claude Code to call during a review. Claude Code starts it
// with the app's own Electron binary in Node mode. It shares the database
// with the running app (WAL handles the two connections) and appends each
// change it makes to FINANCE_ACTIONS so the app can show it in the chat.
// When the database is encrypted (a development build with Settings → Data →
// Encrypted on), its key comes in FINANCE_DB_KEY (64 hex characters), in the
// environment the app gives Claude Code, never in a file.

const dbPath = process.env['FINANCE_DB']
const actionsLog = process.env['FINANCE_ACTIONS']
const keyHex = process.env['FINANCE_DB_KEY'] ?? ''
delete process.env['FINANCE_DB_KEY']
if (!dbPath) {
  process.stderr.write('FINANCE_DB is not set\n')
  process.exit(1)
}
if (keyHex && !/^[0-9a-f]{64}$/i.test(keyHex)) {
  process.stderr.write('FINANCE_DB_KEY is not a database key\n')
  process.exit(1)
}
// Only the app upgrades the database (after a backup); a version this build doesn't match is left alone.
try {
  openDb(dbPath, { migrate: false, key: keyHex ? Buffer.from(keyHex, 'hex') : null })
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
if (schemaVersion() !== LATEST_SCHEMA_VERSION) {
  process.stderr.write(`${dbPath} is at schema version ${schemaVersion()}; this build expects ${LATEST_SCHEMA_VERSION}\n`)
  process.exit(1)
}
// Changes made in this review turn are journaled under the turn the app named.
setTurnId(process.env['FINANCE_TURN'] || null)
// Claude Code mode runs in development builds only, so the plan is the development build's (FINANCE_TRACKER_PLAN still applies).
configureLicense({ dev: true })

interface Request {
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

class RpcError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const send = (msg: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
}

function handle(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'finance', version: '1.0.0' }
      }
    case 'ping':
      return {}
    case 'tools/list':
      // Claude Code opens files with its own Read tool; read_document is for the app's loop.
      return { tools: [...TOOLS, ...DOC_TOOLS.filter((t) => t.name !== 'read_document')].map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) }
    case 'tools/call': {
      const name = String(params['name'])
      try {
        const r = runAssistantTool(name, (params['arguments'] ?? {}) as Record<string, unknown>)
        if (r.action && actionsLog) appendFileSync(actionsLog, `${JSON.stringify({ tool: name, action: r.action, ...(r.changeId !== undefined ? { changeId: r.changeId } : {}) })}\n`)
        // A queued destructive call: the app shows it for approval as soon as it reads this.
        if (r.pending !== undefined && actionsLog) appendFileSync(actionsLog, `${JSON.stringify({ tool: name, pending: r.pending })}\n`)
        return { content: [{ type: 'text', text: JSON.stringify(r.result).slice(0, RESULT_LIMIT) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return
    let req: Request
    try {
      req = JSON.parse(line) as Request
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    // Notifications (no id) need no reply.
    if (req.id === undefined || req.id === null) return
    try {
      send({ id: req.id, result: handle(req.method, req.params ?? {}) })
    } catch (err) {
      send({ id: req.id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } })
    }
  })
  .on('close', () => process.exit(0))
