import { closeSync, existsSync, fsyncSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'

// The slice of node:sqlite's API the app uses (DatabaseSync, prepared
// statements, backup), over better-sqlite3-multiple-ciphers (SQLite with
// SQLite3MultipleCiphers), which can encrypt the file. Every process that opens
// finance.db goes through here: the app, the review's tool server, the tests
// and the scripts. node:sqlite isn't loaded beside it, since two SQLite
// libraries in one process must not open the same file.
//
// An encrypted database uses ChaCha20-Poly1305 with a raw 256-bit key (the
// key file in dbkey.ts holds it wrapped), so no KDF runs when it opens. A key
// of null opens a plain SQLite file; a key left out takes the default, which
// is null except in the encrypted test run (test/encrypted.mjs).

export type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView
export type SQLOutputValue = null | number | bigint | string | Uint8Array

/** The cipher every encrypted file uses: ChaCha20-Poly1305 (32 bytes per page for its nonce and tag). */
export const CIPHER = 'chacha20'

let defaultKey: Buffer | null = null

/** The key a connection gets when its caller passes none: null (plain) unless a test run sets one. */
export function setDefaultKey(key: Uint8Array | null): void {
  if (key && key.length !== 32) throw new Error('A database key is 32 bytes')
  defaultKey = key ? Buffer.from(key) : null
}

/** Whether connections opened without a named key are encrypted (the encrypted test run). */
export const hasDefaultKey = (): boolean => defaultKey !== null

/**
 * The raw-key form SQLite3MultipleCiphers takes without running its KDF: "raw:" and the 32 bytes, as
 * bytes, so no JavaScript string ever holds the key. The caller zeroes it once SQLite has it.
 */
function rawKey(key: Uint8Array): Buffer {
  const b = Buffer.alloc(4 + key.length)
  b.write('raw:', 0, 'latin1')
  b.set(key, 4)
  return b
}

const isMemory = (path: string): boolean => path === '' || path === ':memory:'

// node:sqlite binds true and false as 1 and 0; better-sqlite3 refuses booleans.
function bindable(params: unknown[]): unknown[] {
  for (let i = 0; i < params.length; i++) if (typeof params[i] === 'boolean') params[i] = params[i] ? 1 : 0
  return params
}

export class StatementSync {
  readonly #s: Database.Statement
  constructor(s: Database.Statement) {
    this.#s = s
  }
  // node:sqlite allows all() and get() on a statement that returns nothing (an INSERT, say); better-sqlite3 throws.
  all(...params: unknown[]): unknown[] {
    if (!this.#s.reader) {
      this.#s.run(...bindable(params))
      return []
    }
    return this.#s.all(...bindable(params))
  }
  get(...params: unknown[]): unknown {
    if (!this.#s.reader) {
      this.#s.run(...bindable(params))
      return undefined
    }
    return this.#s.get(...bindable(params))
  }
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const r = this.#s.run(...bindable(params))
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
  }
}

export interface OpenOptions {
  readOnly?: boolean
  /** 32 bytes: the file is (or becomes) encrypted with it; null: a plain file; left out: the default (setDefaultKey). */
  key?: Uint8Array | null
}

/** How many compiled statements a connection keeps; past it, the one used longest ago goes. */
const STATEMENT_CACHE = 500
/** What exec runs for a transaction, which leaves compiled statements as they are. */
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i

export class DatabaseSync {
  readonly raw: Database.Database
  /** Opened with a key: what it writes, and its backups, are encrypted. */
  readonly encrypted: boolean
  /** Compiled statements by their SQL, most recently used last, so a query run again isn't compiled again. */
  readonly #statements = new Map<string, StatementSync>()
  constructor(path: string, opts: OpenOptions = {}) {
    this.raw = new Database(path, { readonly: !!opts.readOnly, fileMustExist: !!opts.readOnly })
    // An in-memory database can't take a key (SQL logic error), and never reaches the disk anyway.
    const key = isMemory(path) ? null : opts.key === undefined ? defaultKey : opts.key
    this.encrypted = !!key
    try {
      if (key) {
        if (key.length !== 32) throw new Error('A database key is 32 bytes')
        this.raw.pragma(`cipher = '${CIPHER}'`)
        const raw = rawKey(key)
        try {
          this.raw.key(raw)
        } finally {
          raw.fill(0)
        }
      }
      // The key is checked only on the first read: a wrong key, a missing one, or a key on a plain file is SQLITE_NOTADB here.
      this.raw.prepare('SELECT count(*) FROM sqlite_master').get()
      // node:sqlite's build runs synchronous FULL; this one reopens a WAL file as NORMAL.
      if (!opts.readOnly) this.raw.pragma('synchronous = FULL')
      // Temporary files (big sorts, a VACUUM) stay in memory: this SQLite3MultipleCiphers doesn't encrypt them.
      this.raw.pragma('temp_store = MEMORY')
    } catch (err) {
      this.raw.close()
      throw err
    }
  }
  get isOpen(): boolean {
    return this.raw.open
  }
  get isTransaction(): boolean {
    return this.raw.inTransaction
  }
  exec(sql: string): void {
    // A schema change (a migration's) starts the statements afresh. SQLite recompiles a statement whose tables
    // changed by itself; this keeps that from being the only guard.
    if (!TRANSACTION_CONTROL.test(sql)) this.#statements.clear()
    this.raw.exec(sql)
  }
  prepare(sql: string): StatementSync {
    const kept = this.#statements.get(sql)
    if (kept) {
      this.#statements.delete(sql)
      this.#statements.set(sql, kept)
      return kept
    }
    const s = new StatementSync(this.raw.prepare(sql))
    this.#statements.set(sql, s)
    if (this.#statements.size > STATEMENT_CACHE) this.#statements.delete(this.#statements.keys().next().value!)
    return s
  }
  close(): void {
    this.#statements.clear()
    if (this.raw.open) this.raw.close()
  }
}

/**
 * Writes a copy of the open database to `file`, in its own format: SQLite's
 * online backup for a plain one; VACUUM INTO for an encrypted one, which
 * writes the copy under the connection's key (the online backup refuses an
 * encrypted source with an unkeyed target). VACUUM INTO runs in one go and
 * needs the target gone first.
 */
export async function backup(db: DatabaseSync, file: string): Promise<void> {
  if (!db.encrypted) {
    await db.raw.backup(file)
    return
  }
  removeDbFiles(file)
  db.raw.prepare('VACUUM INTO ?').run(file)
}

/**
 * Opens the copy at `file` from `db`'s own connection (attached, so under the connection's key without
 * the key passing through here) and reads it: its schema, and with `full` SQLite's integrity check.
 * Throws when it doesn't open or isn't sound.
 */
export function checkCopy(db: DatabaseSync, file: string, full: boolean): void {
  db.raw.prepare('ATTACH ? AS copy_check').run(file)
  try {
    db.raw.prepare('SELECT count(*) FROM copy_check.sqlite_master').get()
    if (!full) return
    const rows = db.raw.prepare('PRAGMA copy_check.integrity_check').all() as Array<{ integrity_check: string }>
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error(`The copy fails SQLite's integrity check: ${rows.slice(0, 3).map((r) => r.integrity_check).join('; ')}`)
  } finally {
    db.raw.exec('DETACH copy_check')
  }
}

/** The file's bytes flushed to the disk, so a rename that follows can't land before them (VACUUM INTO never syncs). */
export function flushFile(file: string): void {
  const fd = openSync(file, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** A database file and the journal files beside it, removed. */
export function removeDbFiles(file: string): void {
  for (const s of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${s}`, { force: true })
}

export type FileKind = 'missing' | 'plain' | 'other'

/** What the first bytes say: a plain SQLite file, nothing (missing or empty), or anything else (encrypted, or not a database). */
export function fileKind(file: string): FileKind {
  if (!existsSync(file) || statSync(file).size === 0) return 'missing'
  const header = Buffer.alloc(16)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, header, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  return header.toString('latin1') === 'SQLite format 3\0' ? 'plain' : 'other'
}

/**
 * Copies the database at `src` (opened with `srcKey`; null for a plain file)
 * to a new file `out` encrypted with `outKey` (null: plain), whole and
 * consistent: VACUUM INTO from a connection keyed for the target, with the
 * source attached under its own key. `scratch` is that connection's own,
 * never-written file. The target and the scratch file must not be in use.
 */
export function copyDatabase(src: string, srcKey: Uint8Array | null, out: string, outKey: Uint8Array | null, scratch = `${out}.main`): void {
  removeDbFiles(out)
  removeDbFiles(scratch)
  // An unkeyed connection can be in memory; a keyed one needs a file (an in-memory one can't take a key).
  const main = new Database(outKey ? scratch : ':memory:')
  try {
    if (outKey) {
      main.pragma(`cipher = '${CIPHER}'`)
      const raw = rawKey(outKey)
      try {
        main.key(raw)
      } finally {
        raw.fill(0)
      }
    }
    main.pragma('temp_store = MEMORY')
    const srcRaw = srcKey ? rawKey(srcKey) : null
    try {
      main.prepare('ATTACH ? AS src KEY ?').run(src, srcRaw ?? '')
    } finally {
      srcRaw?.fill(0)
    }
    try {
      // The target is attached by VACUUM itself, with no key of its own, so it takes the connection's.
      main.prepare('VACUUM src INTO ?').run(out)
    } finally {
      main.exec('DETACH src')
    }
  } finally {
    main.close()
    removeDbFiles(scratch)
  }
}
