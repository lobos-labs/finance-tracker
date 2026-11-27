// What the engine needs from a SQLite connection: the desktop's encrypted file
// (sqlite.ts) and a hosted ledger's Durable Object storage both provide it.
// Nothing here imports a database library, so the engine can run where the
// native one can't.

export interface SqlStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

export interface SqlDriver {
  prepare(sql: string): SqlStatement
  /** One or more statements, no parameters. */
  exec(sql: string): void
  readonly isOpen: boolean
  /** What it writes is encrypted (the desktop's keyed file); a hosted store says false and encrypts below this layer. */
  readonly encrypted: boolean
  close(): void
  /**
   * Runs `fn` as one transaction, for a store that has its own way to (a
   * Durable Object takes no BEGIN or COMMIT). Without it, the engine issues
   * BEGIN, SAVEPOINT and COMMIT itself.
   */
  transaction?<T>(fn: () => T): T
}
