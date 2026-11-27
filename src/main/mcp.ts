import * as db from './db'
import { withoutDocumentRoots } from './files'
import { undo } from './journal'
import { requireFeature } from './license'
import { describeCall, runTool, setTurnId, TOOLS, type ToolDef } from './tools'

// The review assistant's tools for apps the user connects over MCP (Claude,
// ChatGPT...): finance-server/src/mcp lists them, and the account's Ledger runs
// a call here (docs/hosted-api.md, "Connected apps"). Reads are always there;
// writes only on a grant with the write scope, which only the Worker sets (from
// the user's consent), never anything in a call or a result. Each write is
// journaled under its grant (origin "mcp:<member>", the person whose app it is,
// owner or partner on shared books; the grant's id as the turn), so the app's
// own undo_change and Settings → Connected apps can put it back. Bank
// descriptions and merchant names in a result are data: nothing here reads them.

/** What MCP's tool annotations say about a tool (every one stays inside the books: openWorldHint false). */
export interface McpAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: false
}

/** A tool as tools/list answers it. */
export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: McpAnnotations
}

/** The grant a call runs under: its id (the journal's turn), whether it may write, and whose it is (the member of the books who connected the app). */
export interface McpGrant {
  id: string
  write: boolean
  member: string
}

/** A tools/call answer: JSON text blocks, the tool's own failure as isError, and whether the books changed. */
export interface McpCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  changed: boolean
}

/** A change a connected app made, as list_changes and Settings → Connected apps show it. */
export interface AppChange {
  id: number
  /** Unix seconds */
  at: number
  tool: string
  summary: string
  undone: boolean
  /** whose app made it: the account that connected it (the owner, or the partner on shared books) */
  member: string | null
}

/** A call the Worker must refuse outright: an unknown tool (JSON-RPC -32602) or a write without the write scope (403 insufficient_scope). */
export class McpRefusal extends Error {
  readonly reason: 'unknown_tool' | 'scope'
  constructor(reason: 'unknown_tool' | 'scope', message: string) {
    super(message)
    this.reason = reason
  }
}

/** The journal's origin for a connected app's changes: this, then the member whose app it is. */
export const MCP_ORIGIN = 'mcp:'
const originOf = (member: string): `mcp:${string}` => `mcp:${member}`
const memberOf = (origin: string): string | null => (origin.startsWith(MCP_ORIGIN) ? origin.slice(MCP_ORIGIN.length) || null : null)

/** The longest result text handed back (Claude takes about 150,000 characters). */
export const MCP_RESULT_LIMIT = 100_000

/** Receipts are files from the app's own uploads, which a connected app can't make; the documents tools are the in-app assistant's inbox. */
const SKIPPED = new Set(['attach_receipt', 'detach_receipt'])

/** Writes that only add a record, never replace or remove one (destructiveHint false). */
const ONLY_ADDS = new Set(['create_category', 'create_bucket', 'create_goal', 'add_asset', 'add_calendar_event', 'remember', 'add_question', 'add_tags', 'record_flows'])

/** Writes that add another record each time they're called (idempotentHint false). */
const ADDS_AGAIN = new Set(['create_goal', 'add_asset', 'add_calendar_event', 'remember', 'add_question', 'record_flows', 'add_trip', 'add_bucket_rule', 'undo_change'])

/**
 * Through MCP nothing waits for approval in the Review chat: the app asks the user itself, and Undo covers the rest.
 * Nor is there the documents folder's list_documents (DOC_TOOLS are the in-app assistant's inbox).
 */
const DESCRIPTIONS: Record<string, (d: string) => string> = {
  create_rule: (d) => d.replace(/; a rule that would change more than \d+ of them waits for the user's approval instead/, ''),
  record_paystub: (d) => d.replace(/ document: the stub's name from list_documents\./, '')
}

const WORDS: Record<string, string> = { hsa: 'HSA' }

/** "set_hsa_year" → "Set HSA year". */
export const titleOf = (name: string): string =>
  name
    .split('_')
    .map((w, i) => WORDS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')

function annotations(name: string, read: boolean): McpAnnotations {
  return { readOnlyHint: read, destructiveHint: !read && !ONLY_ADDS.has(name), idempotentHint: read || !ADDS_AGAIN.has(name), openWorldHint: false }
}

const fromTool = (t: ToolDef): McpTool => ({
  name: t.name,
  title: titleOf(t.name),
  description: DESCRIPTIONS[t.name]?.(t.description ?? '') ?? t.description ?? '',
  inputSchema: t.input_schema as Record<string, unknown>,
  annotations: annotations(t.name, t.risk === 'read')
})

/** This connection's own tools: its recent changes, and Undo on one. */
const OWN: McpTool[] = [
  {
    name: 'list_changes',
    title: 'List changes',
    description: "This connection's recent changes to the books, newest first: each one's id (for undo_change), when it was made (Unix seconds), the tool and its arguments, and whether it was undone. Changes made in the app or by another connection aren't listed.",
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'default 20, at most 50' } } },
    annotations: annotations('list_changes', true)
  },
  {
    name: 'undo_change',
    title: 'Undo change',
    description: "Put back one change this connection made: change_id from list_changes or from a write's result; left out, the most recent one not yet undone. Only this connection's changes can be undone here.",
    inputSchema: { type: 'object', properties: { change_id: { type: 'integer' } } },
    annotations: annotations('undo_change', false)
  }
]

const CATALOGUE: McpTool[] = [...TOOLS.filter((t) => !SKIPPED.has(t.name)).map(fromTool), ...OWN]
const BY_NAME = new Map(CATALOGUE.map((t) => [t.name, t]))

/** The tools a grant sees: every read, and the writes when it has the write scope. */
export const mcpTools = (write: boolean): McpTool[] => CATALOGUE.filter((t) => write || t.annotations.readOnlyHint)

/** A tool by name; nothing for a name the catalogue doesn't hold. */
export const mcpTool = (name: string): McpTool | undefined => BY_NAME.get(name)

/** The tool a call names, or the refusal: unknown, or a write the grant may not make. */
export function checkMcpCall(name: string, grant: Pick<McpGrant, 'write'>): McpTool {
  const tool = mcpTool(name)
  if (!tool) throw new McpRefusal('unknown_tool', `Unknown tool ${name}`)
  if (!tool.annotations.readOnlyHint && !grant.write) throw new McpRefusal('scope', `${name} changes the books: this connection may only read them`)
  return tool
}

/** A result as text for the connected app, the document folders' own paths taken out: a stored file is named as it is in the folder. */
const text = (v: unknown): { type: 'text'; text: string } => ({ type: 'text', text: withoutDocumentRoots(JSON.stringify(v) ?? 'null').slice(0, MCP_RESULT_LIMIT) })

const changeOf = (c: db.ChangeRow): AppChange => ({ id: c.id, at: c.createdAt, tool: c.tool, summary: describeCall(c.tool, c.input), undone: c.undoneAt !== null, member: memberOf(c.origin) })

/** A grant's newest changes, newest first. */
export function appChanges(grantId: string, limit = 20): AppChange[] {
  return db.listChanges({ originPrefix: MCP_ORIGIN, turnId: grantId, limit: Math.max(1, Math.min(50, Math.floor(limit) || 20)) }).map(changeOf)
}

/**
 * Puts back one change a connected app made: by its id, or the grant's most
 * recent one not yet undone. With a grant, only that grant's changes; without
 * (the user, in Settings → Connected apps), any connected app's.
 */
export function undoAppChange(id: number | null, grantId?: string): AppChange {
  const c = id === null ? (grantId ? db.listChanges({ originPrefix: MCP_ORIGIN, turnId: grantId, limit: 50 }).find((x) => x.undoneAt === null) : undefined) : db.getChange(id)
  if (!c || !c.origin.startsWith(MCP_ORIGIN) || (grantId !== undefined && c.turnId !== grantId)) throw new Error(id === null ? 'Nothing to undo' : `No change ${id} from this connection`)
  if (c.undoneAt !== null) throw new Error(`Change ${c.id} was already undone`)
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(c.id)
  return changeOf({ ...c, undoneAt: db.now() })
}

/**
 * Runs one call for a grant, in the account's plan scope (connected apps are
 * Plus). A refusal (unknown tool, no write scope) throws McpRefusal; the tool's
 * own failure is the result, isError, with its message. A write's result
 * carries its change_id for undo_change.
 */
export function runMcpTool(name: string, input: Record<string, unknown>, grant: McpGrant): McpCallResult {
  const tool = checkMcpCall(name, grant)
  const write = !tool.annotations.readOnlyHint
  try {
    requireFeature('mcp')
    if (name === 'list_changes') return { content: [text(appChanges(grant.id, Number(input['limit']) || 20))], changed: false }
    if (name === 'undo_change') {
      const id = input['change_id'] === undefined || input['change_id'] === null ? null : Number(input['change_id'])
      if (id !== null && !Number.isInteger(id)) throw new Error('change_id must be an integer')
      return { content: [text({ undone: undoAppChange(id, grant.id) })], changed: true }
    }
    // Every change this call makes is journaled under the grant.
    setTurnId(grant.id)
    try {
      const r = runTool(name, input, originOf(grant.member))
      const content = [text(r.result)]
      if (r.changeId !== undefined) content.push(text({ change_id: r.changeId, ...(r.action ? { done: r.action } : {}) }))
      return { content, changed: write }
    } finally {
      setTurnId(null)
    }
  } catch (err) {
    return { content: [{ type: 'text', text: withoutDocumentRoots(err instanceof Error ? err.message : String(err)) }], isError: true, changed: false }
  }
}
