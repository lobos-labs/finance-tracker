import * as db from './db'

// Moving the desktop's books into a hosted account (docs/hosted-api.md, "Moving
// desktop books"): the desktop's full export (db.exportAll, the same JSON as
// Settings → Export all data) restored table by table into an empty ledger.
// The export never carries secrets or the AI request log; a schema other than
// this engine's is refused rather than guessed at. The files the books point
// at (receipts, tax forms, credit reports, policy documents, the documents the
// AI read) travel as uploads: the desktop rewrites each path to the upload's
// "<fileId>/<name>" before sending (moveToAccount.ts), with the helpers here.

export interface FullExport {
  schemaVersion: number
  exportedAt: string
  tables: Record<string, Array<Record<string, unknown>>>
}

export type ImportProblem = 'schema' | 'not_empty' | 'shape'

/** A refusal: the export's schema isn't this engine's, the ledger already holds books, or the export is malformed. */
export class ImportRefused extends Error {
  readonly problem: ImportProblem
  readonly details: Record<string, unknown>
  constructor(problem: ImportProblem, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ImportRefused'
    this.problem = problem
    this.details = details
  }
}

/** Tables a new ledger fills by itself or keeps logs in; anything else holding a row means books were recorded. */
const NOT_BOOKS = new Set(['categories', 'settings', 'ai_requests', 'ai_usage', 'bridge_requests'])

/** Settings an import never writes: secrets (never exported anyway) and the desktop's relay pairing. */
const DROPPED_SETTING = /^(secret|sync)\./
/** Settings the ledger keeps as they are: its days are counted in the account's zone. */
const KEPT_SETTINGS = new Set(['calendar.timeZone'])

/** The uploaded documents the AI may read (handlers/files.ts). */
export const UPLOADED_DOCUMENTS = 'documents.uploaded'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether the ledger holds no books: no row in any table but the seeded ones and the logs. */
export function ledgerEmpty(): boolean {
  return db.engineTables().every((t) => NOT_BOOKS.has(t) || !db.get(`SELECT 1 AS x FROM "${t}" LIMIT 1`))
}

/** The parsed export, its shape checked; throws ImportRefused('shape') otherwise. */
export function readExport(body: unknown): FullExport {
  if (!isRecord(body) || typeof body.schemaVersion !== 'number' || !isRecord(body.tables)) throw new ImportRefused('shape', 'Not a full export: schemaVersion and tables expected')
  for (const [name, rows] of Object.entries(body.tables)) {
    if (!Array.isArray(rows) || !rows.every(isRecord)) throw new ImportRefused('shape', `Table ${name} is not a list of rows`, { table: name })
  }
  return { schemaVersion: body.schemaVersion, exportedAt: typeof body.exportedAt === 'string' ? body.exportedAt : '', tables: body.tables as FullExport['tables'] }
}

/** Tables in an order that inserts every row after the rows it refers to (foreign keys), names otherwise. */
function insertOrder(tables: string[]): string[] {
  const deps = new Map<string, Set<string>>()
  for (const t of tables) {
    let refs: string[] = []
    try {
      refs = db.all<{ table: string }>(`PRAGMA foreign_key_list("${t}")`).map((r) => r.table)
    } catch {
      // A store without the pragma: name order, as the tables come.
    }
    deps.set(t, new Set(refs.filter((r) => r !== t && tables.includes(r))))
  }
  const out: string[] = []
  const left = [...tables].sort()
  while (left.length) {
    const i = left.findIndex((t) => [...deps.get(t)!].every((d) => out.includes(d)))
    out.push(...left.splice(i < 0 ? 0 : i, 1))
  }
  return out
}

const columnsOf = (table: string): Set<string> => new Set(db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name))

/** A JSON value as SQLite takes it: numbers, text and null; anything else is malformed. */
function cell(table: string, column: string, v: unknown): string | number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  throw new ImportRefused('shape', `${table}.${column} holds a value no column takes`, { table, column })
}

/**
 * Restores an export into the ledger in scope, all of it or nothing: the ledger must hold no books
 * and run this export's schema version. Every exported table replaces the ledger's (its default
 * categories and settings too), but secrets and relay settings are never written and the ledger's
 * own time zone stays. A table or column this schema doesn't have is refused.
 */
export function restoreExport(x: FullExport): { tables: number; rows: number } {
  if (x.schemaVersion !== db.LATEST_SCHEMA_VERSION) {
    const which = x.schemaVersion > db.LATEST_SCHEMA_VERSION ? 'newer' : 'older'
    throw new ImportRefused('schema', `The export is schema version ${x.schemaVersion}, ${which} than this ledger's ${db.LATEST_SCHEMA_VERSION}: export again from a build at version ${db.LATEST_SCHEMA_VERSION}`, { exportVersion: x.schemaVersion, ledgerVersion: db.LATEST_SCHEMA_VERSION })
  }
  if (!ledgerEmpty()) throw new ImportRefused('not_empty', 'This account already has books: an import goes into an empty one')
  const known = new Set(db.engineTables())
  const names = Object.keys(x.tables).filter((t) => !db.NOT_EXPORTED.has(t))
  for (const t of names) if (!known.has(t)) throw new ImportRefused('shape', `No table ${t} in this ledger`, { table: t })
  const cols = new Map(names.map((t) => [t, columnsOf(t)]))
  for (const t of names) {
    for (const row of x.tables[t]) for (const c of Object.keys(row)) if (!cols.get(t)!.has(c)) throw new ImportRefused('shape', `No column ${t}.${c} in this ledger`, { table: t, column: c })
  }

  const order = insertOrder(names)
  let rows = 0
  db.inTransaction(() => {
    const kept = db.all<{ key: string; value: string }>('SELECT key, value FROM settings').filter((s) => KEPT_SETTINGS.has(s.key))
    for (const t of [...order].reverse()) db.run(`DELETE FROM "${t}"`)
    for (const t of order) {
      for (const row of x.tables[t]) {
        if (t === 'settings' && (DROPPED_SETTING.test(String(row.key)) || KEPT_SETTINGS.has(String(row.key)))) continue
        const keys = Object.keys(row)
        if (!keys.length) continue
        db.run(`INSERT INTO "${t}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => cell(t, k, row[k])))
        rows++
      }
    }
    for (const s of kept) db.setSetting(s.key, s.value)
  })
  return { tables: order.length, rows }
}

// ---------- the files the books point at ----------

type Json = Record<string, unknown>

const settingRow = (x: FullExport, key: string): Json | undefined => x.tables.settings?.find((r) => r.key === key)

function settingJson(x: FullExport, key: string): unknown {
  const row = settingRow(x, key)
  try {
    return typeof row?.value === 'string' ? (JSON.parse(row.value) as unknown) : null
  } catch {
    return null
  }
}

const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : [])

/** Every { file } entry a page keeps in a setting: tax forms, credit reports, policy documents. */
function fileHolders(x: FullExport): Array<{ key: string; value: unknown; holders: Json[] }> {
  const taxes = settingJson(x, 'taxes')
  const credit = settingJson(x, 'credit')
  const insurance = settingJson(x, 'insurance')
  return [
    { key: 'taxes', value: taxes, holders: list(isRecord(taxes) ? taxes.years : null).flatMap((y) => list(y.forms)) },
    { key: 'credit', value: credit, holders: list(isRecord(credit) ? credit.reports : null) },
    { key: 'insurance', value: insurance, holders: list(isRecord(insurance) ? insurance.policies : null).flatMap((p) => list(p.files)) }
  ]
}

/** The file paths (or documents-folder names) the export's books point at, each once. */
export function exportFileRefs(x: FullExport): string[] {
  const out = new Set<string>()
  for (const t of x.tables.transactions ?? []) if (typeof t.receipt === 'string' && t.receipt) out.add(t.receipt)
  for (const h of fileHolders(x)) for (const f of h.holders) if (typeof f.file === 'string' && f.file) out.add(f.file)
  for (const d of x.tables.documents ?? []) if (typeof d.name === 'string' && d.name) out.add(d.name)
  return [...out]
}

/** An upload as the server answered it (POST /v1/ledger/files). */
export interface UploadedFile {
  fileId: string
  name: string
  size: number
  type: string
}

/** How the ledger names an upload where the desktop kept a path: "<fileId>/<name>" (handlers/files.ts uploadRef). */
export const uploadRefOf = (f: Pick<UploadedFile, 'fileId' | 'name'>): string => `${f.fileId}/${f.name.replace(/[/\\]+/g, '_')}`

/**
 * The export with every path that was uploaded replaced by its upload's reference, and the documents
 * the AI had read listed for the hosted AI (the documents.uploaded setting). A path that wasn't
 * uploaded is left as it was.
 */
export function rewriteFileRefs(x: FullExport, uploads: Map<string, UploadedFile>, now = Math.floor(Date.now() / 1000)): FullExport {
  const out: FullExport = { ...x, tables: { ...x.tables } }
  const ref = (p: unknown): unknown => (typeof p === 'string' && uploads.has(p) ? uploadRefOf(uploads.get(p)!) : p)
  if (out.tables.transactions) out.tables.transactions = out.tables.transactions.map((t) => (typeof t.receipt === 'string' && uploads.has(t.receipt) ? { ...t, receipt: ref(t.receipt) } : t))

  const settings = [...(out.tables.settings ?? [])]
  const put = (key: string, value: string): void => {
    const i = settings.findIndex((r) => r.key === key)
    if (i >= 0) settings[i] = { ...settings[i], value }
    else settings.push({ key, value })
  }
  const holders = fileHolders(out)
  for (const h of holders) {
    let changed = false
    for (const f of h.holders) {
      if (typeof f.file === 'string' && uploads.has(f.file)) {
        f.file = ref(f.file)
        changed = true
      }
    }
    if (changed) put(h.key, JSON.stringify(h.value))
  }

  const read: Array<{ fileId: string; name: string; type: string; size: number; addedAt: number }> = []
  if (out.tables.documents) {
    out.tables.documents = out.tables.documents.map((d) => {
      const up = typeof d.name === 'string' ? uploads.get(d.name) : undefined
      if (!up) return d
      read.push({ fileId: up.fileId, name: up.name, type: up.type, size: up.size, addedAt: typeof d.processed_at === 'number' ? d.processed_at : now })
      return { ...d, name: uploadRefOf(up) }
    })
  }
  if (read.length) {
    const prior = settingJson(out, UPLOADED_DOCUMENTS)
    const already = Array.isArray(prior) ? prior.filter(isRecord) : []
    put(UPLOADED_DOCUMENTS, JSON.stringify([...already, ...read.filter((r) => !already.some((a) => a.fileId === r.fileId))]))
  }
  out.tables.settings = settings
  return out
}
