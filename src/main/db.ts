import { backup, checkCopy, DatabaseSync, type SQLInputValue } from './sqlite'
import type { SqlDriver } from './sqlDriver'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { categoryRole } from '../shared/categoryRole'
import { isCents, MAX_CENTS } from '../shared/parse'
import { addDays, dayIn, daysBetween, defaultZone, isRealDay, isZone, monthStartIn, noonIn, offsetChanges, shiftMonth, startIn } from '../shared/zone'
import { asPayrollKey, descKey, payeeKey, PAYSTUB_ITEMS, payrollKey, planGroup, premiumKind, type Payee } from '../shared/payroll'
import type {
  Account,
  AccountPatch,
  CashRole,
  AiRoute,
  AiUsageTotals,
  AssetHistory,
  AssetSummary,
  AssetType,
  AssetUse,
  BalancePoint,
  Bucket,
  BucketDetail,
  BucketKind,
  BucketRule,
  BucketSelection,
  CalendarEvent,
  ContributionInput,
  ContributionKind,
  InsuranceItem,
  LineClass,
  Paystub,
  PaystubItem,
  PaystubItemKind,
  PayBasis,
  StageId,
  Valuation,
  NewAsset,
  Category,
  CategoryKind,
  CategorySource,
  CategorySpend,
  Confidence,
  MonthPoint,
  MonthSummary,
  NetWorthSeries,
  Fact,
  FactOrigin,
  HsaState,
  RecurringKind,
  ResolvedIssue,
  Rule,
  RuleField,
  Transaction,
  TxnPage,
  TxnQuery,
  InvestmentAccount,
  Investments,
  TaxTreatment,
  SplitPart,
  TagCount,
  TxnSplit,
  VentureMoneyPart,
  VentureShare
} from '../shared/types'

// The connection every query below goes through: the one a hosted ledger's
// request runs under (withDriver), else the desktop's open file. A Durable
// Object isolate can host several ledgers at once, so the engine never keeps
// one ledger's connection outside its request's scope.
let opened: DatabaseSync | null = null
const scope = new AsyncLocalStorage<SqlDriver>()

function conn(): SqlDriver {
  const d = scope.getStore() ?? opened
  if (!d) throw new Error('No database is open')
  return d
}

const db = {
  prepare: (sql: string) => conn().prepare(sql),
  exec: (sql: string): void => conn().exec(sql)
}

/** Runs `fn` with every query going to `driver` (a hosted ledger's store). */
export function withDriver<T>(driver: SqlDriver, fn: () => T): T {
  return scope.run(driver, fn)
}

/** The connection queries go to now (a hosted ledger's, else the desktop's open file); null with none. ledgerState.ts keys state by it. */
export const currentConnection = (): SqlDriver | null => scope.getStore() ?? opened

/** Brings the connection in scope up to date, as openDb does a file. One newer than this build is refused. */
export function prepareLedger(): void {
  const version = schemaVersion()
  if (version > LATEST_SCHEMA_VERSION) throw new NewerDatabaseError(version, LATEST_SCHEMA_VERSION)
  migrate()
}

const DEFAULT_CATEGORIES: Array<[string, CategoryKind, string]> = [
  ['Groceries', 'expense', 'Supermarkets, grocery delivery, warehouse clubs, farmers markets'],
  ['Dining Out', 'expense', 'Restaurants, fast food, bars, food delivery apps'],
  ['Coffee', 'expense', 'Coffee shops and cafés'],
  ['Gas & Fuel', 'expense', 'Gas stations and EV charging'],
  ['Transportation', 'expense', 'Rideshare, public transit, parking, tolls, car service and repairs'],
  ['Shopping', 'expense', 'General retail, online marketplaces, clothing, electronics, household goods'],
  ['Subscriptions', 'expense', 'Streaming, software, apps, memberships and other recurring digital services'],
  ['Utilities', 'expense', 'Electricity, water, natural gas, internet, mobile phone'],
  ['Housing', 'expense', 'Rent, mortgage, HOA fees, home repairs and improvement'],
  ['Insurance', 'expense', 'Auto, home, renters, life and health insurance premiums'],
  ['Health & Medical', 'expense', 'Doctors, dentists, pharmacies, vision, therapy'],
  ['Fitness', 'expense', 'Gyms, classes, sports and outdoor gear'],
  ['Entertainment', 'expense', 'Movies, concerts, events, games, hobbies, books'],
  ['Travel', 'expense', 'Flights, hotels, vacation rentals, rental cars'],
  ['Personal Care', 'expense', 'Hair, beauty, spa, toiletries'],
  ['Education', 'expense', 'Tuition, courses, school supplies, student loans'],
  ['Gifts & Donations', 'expense', 'Presents and charitable giving'],
  ['Pets', 'expense', 'Pet food, vet, grooming, pet supplies'],
  ['Fees & Interest', 'expense', 'Bank fees, ATM fees, late fees, interest charges'],
  ['Taxes', 'expense', 'Income and property tax payments'],
  ['Cash & ATM', 'expense', 'Cash withdrawals'],
  ['Other', 'expense', 'Anything that fits nowhere else'],
  ['Paycheck', 'income', 'Salary, wages, direct deposit from an employer'],
  ['Other Income', 'income', 'Interest earned, dividends, side income, reimbursements'],
  ['Transfers', 'transfer', 'Moving money between your own accounts: credit card payments, savings, investment contributions']
]

export class NewerDatabaseError extends Error {
  fileVersion: number
  latest: number
  constructor(fileVersion: number, latest: number) {
    super(`The database is at schema version ${fileVersion}, newer than this version of the app knows (${latest})`)
    this.name = 'NewerDatabaseError'
    this.fileVersion = fileVersion
    this.latest = latest
  }
}

/**
 * Opens the database and, unless `migrate` is false, brings it up to date. One newer than this build is refused.
 * `key` (32 bytes) opens an encrypted file, or makes a new one encrypted; null a plain one (dbopen.ts decides which).
 */
export function openDb(file: string, opts: { migrate?: boolean; key?: Uint8Array | null } = {}): void {
  opened = new DatabaseSync(file, { key: opts.key })
  // The review's tool server (mcp-server.ts) opens the same file from another process.
  // secure_delete overwrites deleted rows, so they don't linger in free pages and backups.
  // The page cache can hold the whole file (it grows only as pages are read), so an encrypted page is decrypted once.
  opened.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA cache_size = -131072;')
  const version = schemaVersion()
  if (version > LATEST_SCHEMA_VERSION) {
    closeDb()
    throw new NewerDatabaseError(version, LATEST_SCHEMA_VERSION)
  }
  if (opts.migrate !== false) migrate()
}

export function closeDb(): void {
  if (opened?.isOpen) opened.close()
}

/** The open database is encrypted (its backups are too). */
export const dbEncrypted = (): boolean => !!opened?.isOpen && opened.encrypted
/** Whether a database is open (not before it opens, and not after Delete all data has closed it). */
export const dbOpen = (): boolean => !!opened?.isOpen

/** Folds the write-ahead log into the main file, so a copy of finance.db alone is complete. */
export function checkpoint(): void {
  if (opened?.isOpen) opened.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

/** The desktop's open file, for what only a file can do (a backup copy). */
function openFile(): DatabaseSync {
  if (!opened?.isOpen) throw new Error('No database file is open')
  return opened
}

export function schemaVersion(): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

/**
 * Writes a copy of the open database to `file`, safe while the app and the review's tool server use it:
 * SQLite's online backup for a plain database, VACUUM INTO (under the same key) for an encrypted one.
 */
export async function backupTo(file: string): Promise<void> {
  await backup(openFile(), file)
}

/** Reads a copy backupTo wrote back through the open database's own connection (its key): the schema, and with `full` the integrity check. Throws when it isn't sound. */
export function checkBackupCopy(file: string, full: boolean): void {
  checkCopy(openFile(), file, full)
}

/** What SQLite's integrity and foreign-key checks find; both empty when the file is sound. */
export function checkIntegrity(): { corruption: string[]; foreignKeys: string[] } {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  const corruption = rows.map((r) => r.integrity_check).filter((s) => s !== 'ok')
  const fks = db.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string; rowid: number; parent: string }>
  return { corruption, foreignKeys: fks.map((fk) => `${fk.table} row ${fk.rowid} refers to a missing ${fk.parent} row`) }
}

/** Tables an export leaves out: the AI request log never leaves this machine (Settings → AI shows it). */
export const NOT_EXPORTED = new Set(['ai_requests'])

/** The engine's own tables: not SQLite's, nor a host's (a Durable Object's _cf_ tables, a Ledger's _ledger_ ones start with "_"). */
export function engineTables(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
}

/** Every table's rows, readable, with secrets and the AI request log left out. */
export function exportAll(): { schemaVersion: number; exportedAt: string; tables: Record<string, Array<Record<string, unknown>>> } {
  const names = engineTables().filter((n) => !NOT_EXPORTED.has(n))
  const tables: Record<string, Array<Record<string, unknown>>> = {}
  for (const name of names) {
    tables[name] = (name === 'settings' ? db.prepare("SELECT * FROM settings WHERE key NOT LIKE 'secret.%' ORDER BY key") : db.prepare(`SELECT * FROM "${name}"`)).all() as Array<Record<string, unknown>>
  }
  return { schemaVersion: schemaVersion(), exportedAt: new Date().toISOString(), tables }
}

// ---------- schema ----------

export interface MigrationStep {
  version: number
  run: (db: SqlDriver) => void
  /**
   * Runs once every step is in, outside the steps' transactions, for work that needs the whole engine (re-applying
   * rules). The step notes it as owed in its own transaction, so one cut short runs again on the next migrate().
   * Returning false says it couldn't run yet, and it stays owed.
   */
  after?: () => void | boolean
}

/** The settings key that notes a step's follow-up as owed until it has run. */
const owedKey = (version: number): string => `migrate.after.${version}`

function hasColumn(db: SqlDriver, table: string, name: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === name)
}

/** Adds a column unless the table has it: these steps once ran unnumbered, so a database may already carry them. */
function addColumn(db: SqlDriver, table: string, name: string, definition: string): void {
  if (!hasColumn(db, table, name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}

/**
 * The schema, one numbered step after another. A step runs in its own
 * transaction together with its version number, so a step that fails leaves
 * the database exactly as it was.
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    run: (db) => {
      db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          institution TEXT,
          currency TEXT NOT NULL DEFAULT 'USD',
          balance_cents INTEGER,
          available_cents INTEGER,
          balance_date INTEGER,
          hidden INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          kind TEXT NOT NULL DEFAULT 'expense',
          description TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE transactions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          posted INTEGER NOT NULL,
          amount_cents INTEGER NOT NULL,
          description TEXT NOT NULL,
          desc_key TEXT NOT NULL,
          merchant TEXT,
          category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          category_source TEXT,
          confidence TEXT,
          pending INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_txn_posted ON transactions(posted);
        CREATE INDEX idx_txn_account ON transactions(account_id);
        CREATE INDEX idx_txn_category ON transactions(category_id);
        CREATE INDEX idx_txn_desc_key ON transactions(desc_key);
        CREATE TABLE rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          field TEXT NOT NULL,
          pattern TEXT NOT NULL,
          category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          UNIQUE(field, pattern)
        );
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
      const insert = db.prepare('INSERT INTO categories (name, kind, description) VALUES (?, ?, ?)')
      for (const [name, kind, description] of DEFAULT_CATEGORIES) insert.run(name, kind, description)
    }
  },
  {
    version: 2,
    run: (db) =>
      // One reported balance per account per day; anchors for net worth history.
      db.exec(`
        CREATE TABLE balance_snapshots (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          balance_cents INTEGER NOT NULL,
          PRIMARY KEY (account_id, day)
        );
        INSERT OR IGNORE INTO balance_snapshots (account_id, day, balance_cents)
          SELECT id, date(${localSql('COALESCE(balance_date, created_at)')}), balance_cents
          FROM accounts WHERE balance_cents IS NOT NULL;
      `)
  },
  {
    version: 3,
    run: (db) =>
      db.exec(`
        -- User decisions about detected recurring series, keyed by merchant + direction.
        CREATE TABLE recurring_overrides (
          key TEXT PRIMARY KEY,
          status TEXT,
          kind TEXT,
          name TEXT,
          updated_at INTEGER NOT NULL
        );
        -- Durable things the assistant has learned about the user.
        CREATE TABLE facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        -- Review items the user has settled or asked to skip.
        CREATE TABLE resolved_issues (
          key TEXT PRIMARY KEY,
          note TEXT,
          created_at INTEGER NOT NULL
        );
      `)
  },
  {
    version: 4,
    run: (db) =>
      db.exec(`
        -- Assets and debts without a bank feed, and history further back than the feeds go.
        ALTER TABLE accounts ADD COLUMN asset_type TEXT;
        ALTER TABLE accounts ADD COLUMN opened_day TEXT;
        ALTER TABLE accounts ADD COLUMN closed_day TEXT;
        ALTER TABLE accounts ADD COLUMN cost_cents INTEGER;
        ALTER TABLE accounts ADD COLUMN linked_asset_id TEXT;
        ALTER TABLE accounts ADD COLUMN details TEXT;
        ALTER TABLE balance_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'sync';
        -- Files in the documents folder the assistant has gone through.
        CREATE TABLE documents (
          name TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          summary TEXT,
          processed_at INTEGER NOT NULL
        );
      `)
  },
  {
    version: 5,
    run: (db) =>
      db.exec(`
        -- Values Claude looked up on the web, with what they're based on.
        CREATE TABLE valuations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          value_cents INTEGER NOT NULL,
          low_cents INTEGER,
          high_cents INTEGER,
          basis TEXT NOT NULL,
          sources TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        -- Dated reminders and deadlines, from the user or the assistant.
        CREATE TABLE calendar_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          day TEXT NOT NULL,
          title TEXT NOT NULL,
          notes TEXT,
          amount_cents INTEGER,
          created_by TEXT NOT NULL DEFAULT 'user',
          created_at INTEGER NOT NULL
        );
      `)
  },
  {
    version: 6,
    run: (db) =>
      db.exec(`
        -- Parts of your finances kept apart from everyday personal money (a
        -- rental, a business, someone you support). NULL bucket = Personal.
        CREATE TABLE buckets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          kind TEXT NOT NULL DEFAULT 'other',
          description TEXT NOT NULL DEFAULT '',
          in_net_worth INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        ALTER TABLE transactions ADD COLUMN bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL;
        ALTER TABLE transactions ADD COLUMN bucket_source TEXT;
        ALTER TABLE accounts ADD COLUMN bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL;
        CREATE INDEX idx_txn_bucket ON transactions(bucket_id);
        -- Puts matching transactions in a bucket: an account and/or text, within optional dates.
        CREATE TABLE bucket_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
          account_id TEXT,
          contains TEXT,
          from_day TEXT,
          to_day TEXT,
          created_at INTEGER NOT NULL
        );
      `)
  },
  {
    version: 7,
    run: (db) =>
      db.exec(`
        -- Paycheck deductions into savings plans: 401(k)s, HSA, ESPP.
        CREATE TABLE contributions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          kind TEXT NOT NULL,
          account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          paycheck_key TEXT,
          percent REAL,
          employee_cents INTEGER,
          match_cents INTEGER,
          match_note TEXT,
          ytd_cents INTEGER,
          ytd_as_of TEXT,
          ends_day TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL
        );
      `)
  },
  {
    version: 8,
    // A rule can pick one installment out of several by its exact amount.
    run: (db) => db.exec('ALTER TABLE bucket_rules ADD COLUMN amount_cents INTEGER')
  },
  {
    version: 9,
    run: (db) =>
      db.exec(`
        -- An election change that takes effect from a paycheck date.
        ALTER TABLE contributions ADD COLUMN next_percent REAL;
        ALTER TABLE contributions ADD COLUMN next_employee_cents INTEGER;
        ALTER TABLE contributions ADD COLUMN next_from TEXT;
      `)
  },
  {
    version: 10,
    // The first paycheck a contribution came out of.
    run: (db) => db.exec('ALTER TABLE contributions ADD COLUMN starts_day TEXT')
  },
  {
    version: 11,
    run: (db) =>
      db.exec(`
        -- Positions in investment accounts, replaced on each bank sync.
        CREATE TABLE holdings (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          holding_id TEXT NOT NULL,
          symbol TEXT,
          description TEXT NOT NULL,
          shares REAL,
          value_cents INTEGER NOT NULL,
          cost_cents INTEGER,
          as_of INTEGER NOT NULL,
          PRIMARY KEY (account_id, holding_id)
        );
      `)
  },
  {
    version: 12,
    run: (db) =>
      db.exec(`
        -- Monthly budgets by category; categories without one use their history.
        CREATE TABLE budgets (
          category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
          cents INTEGER NOT NULL
        );
        -- Debt terms for the payoff plan.
        ALTER TABLE accounts ADD COLUMN apr REAL;
        ALTER TABLE accounts ADD COLUMN promo_apr REAL;
        ALTER TABLE accounts ADD COLUMN promo_ends TEXT;
        ALTER TABLE accounts ADD COLUMN min_payment_cents INTEGER;
      `)
  },
  {
    version: 13,
    // A durable one-off (furniture, a laptop): real spending, but left out of budgets and the debt plan.
    run: (db) => db.exec('ALTER TABLE transactions ADD COLUMN one_time INTEGER NOT NULL DEFAULT 0')
  },
  {
    version: 14,
    // A health cost and the HSA, when set by hand: eligible, not, or reimbursed (paid back from it).
    run: (db) => db.exec('ALTER TABLE transactions ADD COLUMN hsa TEXT')
  },
  {
    version: 15,
    // The receipt for a cost: a file in the documents folder (one statement can cover many visits).
    run: (db) => db.exec('ALTER TABLE transactions ADD COLUMN receipt TEXT')
  },
  {
    version: 16,
    run: (db) =>
      db.exec(`
        -- What one paycheck withholds besides savings plans, per check, from its latest paystub.
        CREATE TABLE paycheck_withholding (
          paycheck_key TEXT PRIMARY KEY,
          as_of TEXT NOT NULL,
          gross_cents INTEGER,
          federal_cents INTEGER NOT NULL DEFAULT 0,
          social_security_cents INTEGER NOT NULL DEFAULT 0,
          medicare_cents INTEGER NOT NULL DEFAULT 0,
          state_cents INTEGER NOT NULL DEFAULT 0,
          insurance_cents INTEGER NOT NULL DEFAULT 0,
          other_cents INTEGER NOT NULL DEFAULT 0,
          net_cents INTEGER,
          updated_at INTEGER NOT NULL
        );
      `)
  },
  {
    version: 17,
    // A paycheck's insurance premiums one by one (JSON: name, cents, pretax); insurance_cents stays their total.
    run: (db) => db.exec('ALTER TABLE paycheck_withholding ADD COLUMN insurance_items TEXT')
  },
  {
    version: 18,
    run: (db) =>
      db.exec(`
        -- Questions only the user can answer, asked in a review until answered.
        CREATE TABLE questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          answered_at INTEGER,
          answer TEXT
        );
      `)
  },
  {
    version: 19,
    run: (db) =>
      db.exec(`
        -- When a place was the user's home (YYYY-MM-DD; to NULL = still): its costs in that span are their housing too.
        ALTER TABLE buckets ADD COLUMN residence_from TEXT;
        ALTER TABLE buckets ADD COLUMN residence_to TEXT;
      `)
  },
  {
    version: 20,
    // What a sold asset's closing took besides the payoff (commission, title, concessions, prorations), for gain/loss.
    run: (db) => db.exec('ALTER TABLE accounts ADD COLUMN sale_costs_cents INTEGER')
  },
  {
    version: 21,
    run: (db) =>
      db.exec(`
        -- Money put into or taken out of an investment account that its bank feed doesn't carry
        -- (from statements): cents positive in, negative out.
        CREATE TABLE IF NOT EXISTS recorded_flows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          cents INTEGER NOT NULL,
          note TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS recorded_flows_account ON recorded_flows (account_id, day);
        -- The day from which every flow of an account is known (its feed's and the recorded ones), for returns.
        CREATE TABLE IF NOT EXISTS flows_known_from (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          day TEXT NOT NULL
        );
      `)
  },
  {
    version: 22,
    run: (db) => {
      // A reminder's local start and end ('HH:MM', 24-hour); NULL is all day.
      addColumn(db, 'calendar_events', 'start_time', 'TEXT')
      addColumn(db, 'calendar_events', 'end_time', 'TEXT')
    }
  },
  {
    version: 23,
    run: (db) => {
      // A to-do the user checks off (synced to Google Tasks), when it was checked off, and its Google task.
      addColumn(db, 'calendar_events', 'task', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'calendar_events', 'done_at', 'INTEGER')
      addColumn(db, 'calendar_events', 'google_task', 'TEXT')
    }
  },
  {
    version: 24,
    run: (db) =>
      db.exec(`
        -- A destructive tool call the assistant asked for, waiting for the user's approval in the Review chat.
        CREATE TABLE pending_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          tool TEXT NOT NULL,
          input TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
      `)
  },
  {
    version: 25,
    // Who saved a fact: the user, the review assistant, or the file bridge.
    run: (db) => db.exec('ALTER TABLE facts ADD COLUMN origin TEXT')
  },
  {
    version: 26,
    run: (db) =>
      db.exec(`
        -- One model call: the route it served, the model, and the token counts the API reported.
        CREATE TABLE ai_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          route TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX ai_usage_at ON ai_usage(at);
      `)
  },
  {
    version: 27,
    run: (db) =>
      db.exec(`
        -- A write a tool made, with the rows as they were before and after, so it can be undone.
        CREATE TABLE changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          turn_id TEXT,
          origin TEXT NOT NULL,
          tool TEXT NOT NULL,
          input TEXT NOT NULL,
          before TEXT,
          after TEXT,
          undone_at INTEGER
        );
        -- File-bridge requests already applied (by content hash), so a request found again isn't applied twice.
        CREATE TABLE bridge_requests (
          hash TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          processed_at INTEGER NOT NULL
        );
        -- What a skipped issue was about, for the Resolved list.
        ALTER TABLE resolved_issues ADD COLUMN summary TEXT;
      `)
  },
  {
    version: 28,
    run: (db) =>
      db.exec(`
        -- The allowance counts turns (a review message, one value lookup) and units (transactions in a
        -- categorize batch), not model calls: the turn the call belonged to, and the units it covered.
        ALTER TABLE ai_usage ADD COLUMN turn_id TEXT;
        ALTER TABLE ai_usage ADD COLUMN units INTEGER NOT NULL DEFAULT 1;
      `)
  },
  {
    version: 29,
    run: (db) =>
      db.exec(`
        -- Every request sent to an AI service, kept on this machine for the user to read (src/main/ai/requestLog.ts):
        -- the body as sent (deflated JSON; tool definitions by name, documents by name and size), its size as sent,
        -- and what came back: usage, or the error. The last 500, at most 30 days.
        CREATE TABLE ai_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          route TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          request BLOB NOT NULL,
          status TEXT NOT NULL DEFAULT 'sent',
          usage TEXT,
          error TEXT
        );
        CREATE INDEX ai_requests_at ON ai_requests(at);
      `)
  },
  {
    version: 30,
    run: (db) =>
      db.exec(`
        -- The parts of a split transaction, each with its own amount, category, venture and one-off flag; they add up
        -- to the transaction's amount. The transaction itself (its id, amount and category) stays as the bank sent it.
        CREATE TABLE transaction_splits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          amount_cents INTEGER NOT NULL,
          category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL,
          one_time INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          position INTEGER NOT NULL
        );
        CREATE INDEX idx_split_txn ON transaction_splits(transaction_id);
        CREATE INDEX idx_split_category ON transaction_splits(category_id);
      `)
  },
  {
    version: 31,
    run: (db) =>
      db.exec(`
        -- Free-form labels on transactions: tag is the key (trimmed, lower-case), label as the tag was first typed.
        CREATE TABLE transaction_tags (
          transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (transaction_id, tag)
        );
        CREATE INDEX idx_txn_tags_tag ON transaction_tags(tag);
      `)
  },
  {
    version: 32,
    run: (db) =>
      db.exec(`
        -- A savings goal (src/main/goals.ts): funded by linked accounts' balances (less start_cents, the balance
        -- on start_day, when it counts only what's saved since), or by a log of contributions.
        CREATE TABLE goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          target_cents INTEGER NOT NULL,
          target_day TEXT,
          funding TEXT NOT NULL,
          start_cents INTEGER,
          start_day TEXT,
          created_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        CREATE TABLE goal_accounts (
          goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          PRIMARY KEY (goal_id, account_id)
        );
        CREATE TABLE goal_contributions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          cents INTEGER NOT NULL,
          note TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX goal_contributions_goal ON goal_contributions(goal_id, day);
      `)
  },
  {
    version: 33,
    run: (db) =>
      db.exec(`
        -- own_bucket: the part was put in a venture of its own. One that wasn't follows its transaction's
        -- venture when the transaction moves (bucket_id is then read from the transaction).
        ALTER TABLE transaction_splits ADD COLUMN own_bucket INTEGER NOT NULL DEFAULT 0;
        UPDATE transaction_splits SET own_bucket = 1
          WHERE bucket_id IS NOT (SELECT t.bucket_id FROM transactions t WHERE t.id = transaction_splits.transaction_id);
      `)
  },
  {
    version: 34,
    run: (db) =>
      db.exec(`
        -- Budget rollover (src/main/budget.ts): a category's leftover or overspend carries into the next month, from
        -- from_month (YYYY-MM, the month it was turned on, in the ledger's zone). No row: off.
        CREATE TABLE budget_rollover (
          category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
          from_month TEXT NOT NULL
        );
        -- Each category's target from a month on (cents null: none from then), so a month long past is carried
        -- against the target it had. The latest change in a month counts for the whole month. Targets set before
        -- this was kept count from the start.
        CREATE TABLE budget_targets (
          category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          month TEXT NOT NULL,
          cents INTEGER,
          PRIMARY KEY (category_id, month)
        );
        INSERT INTO budget_targets (category_id, month, cents) SELECT category_id, '0000-01', cents FROM budgets;
      `)
  },
  {
    version: 35,
    run: (db) =>
      db.exec(`
        -- The web searches each call ran, so what it cost (shared/aiCost.ts) includes them: the included AI's
        -- allowance is a budget now (src/main/allowance.ts).
        ALTER TABLE ai_usage ADD COLUMN web_searches INTEGER NOT NULL DEFAULT 0;
      `)
  },
  {
    version: 36,
    run: (db) =>
      db.exec(`
        -- auto: the rule an account gets when it's put in a venture, so its lines default to the venture; it goes
        -- when the account leaves (setAccountBucket). Every account a venture holds gets one now, unless a rule
        -- already puts all of its lines in that venture.
        ALTER TABLE bucket_rules ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
        INSERT INTO bucket_rules (bucket_id, account_id, auto, created_at)
          SELECT a.bucket_id, a.id, 1, CAST(strftime('%s', 'now') AS INTEGER) FROM accounts a
          WHERE a.bucket_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bucket_rules r WHERE r.account_id = a.id AND r.bucket_id = a.bucket_id AND ${ACCOUNT_ONLY_RULE});
      `),
    // The new rules move the lines they match. Today's applyBucketRules reads the asset columns the uses step adds,
    // so a database taken only this far waits for them (by the column, whatever that step's number).
    after: () => {
      if (!hasColumn(conn(), 'bucket_rules', 'asset_id')) return false
      applyBucketRules()
    }
  },
  {
    version: 37,
    run: (db) => {
      db.exec(`
        -- cash_role: what a cash account is for, 'spending' (checking) or 'saving' (savings, money market, CDs, a
        -- reserve), for the waterfall's Moved to savings and Left in checking. Null is a guess from the account's
        -- name (listAccounts makes it); the bank's subtype (plaid_subtype, filled by the next Plaid sync) or Review
        -- sets it, and the subtype never replaces a role Review set.
        ALTER TABLE accounts ADD COLUMN cash_role TEXT;
        ALTER TABLE accounts ADD COLUMN plaid_subtype TEXT;
      `)
    }
  },
  {
    version: 38,
    run: (db) =>
      db.exec(`
        -- escrow_cents: a loan's escrow in each payment, which splits its interest from its escrow. payment_key: the
        -- payee key ('pinecrest mortgage|-') of the payments that pay a loan, however they're filed (a mortgage paid
        -- as Housing, a car loan as a transfer with no other side). capital_asset_id: the asset a transaction bought,
        -- sold or lent, as Review marks it (mark_capital).
        ALTER TABLE accounts ADD COLUMN escrow_cents INTEGER;
        ALTER TABLE accounts ADD COLUMN payment_key TEXT;
        ALTER TABLE transactions ADD COLUMN capital_asset_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
      `),
    // Each Personal debt's payments are found from its recurring series (lines.ts supplies this, as db.ts can't read
    // the series). With no debt to link there's nothing owed.
    after: () => runSupplied(38) || !get("SELECT 1 FROM accounts WHERE asset_type IN ('loan', 'mortgage', 'other_debt') AND payment_key IS NULL")
  },
  {
    version: 39,
    run: (db) => {
      db.exec(`
        -- Paystubs, one per payroll, pay day and kind (regular, bonus or final): gross, and net, which is always gross
        -- less the items. paycheck_key is the payroll's key as the classifier names pay (shared/payroll.ts payrollKey).
        -- source: 'paystub' when entered from the stub, 'snapshot' when copied below from paycheck_withholding, which
        -- stays as it was and is no longer written. estimated: its gross wasn't on record, so it's the net plus the items.
        CREATE TABLE paystubs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          paycheck_key TEXT NOT NULL,
          pay_day TEXT NOT NULL,
          period_from TEXT,
          period_to TEXT,
          kind TEXT NOT NULL DEFAULT 'regular',
          gross_cents INTEGER NOT NULL,
          net_cents INTEGER NOT NULL,
          document_id INTEGER,
          source TEXT NOT NULL DEFAULT 'paystub',
          estimated INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE (paycheck_key, pay_day, kind)
        );
        -- Each line a stub takes out, in its order: a tax, a premium or other deduction, or a savings plan, with what
        -- the employer put in beside it (the match, its HSA money, its share of a premium) and the year so far.
        CREATE TABLE paystub_items (
          paystub_id INTEGER NOT NULL REFERENCES paystubs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          cents INTEGER NOT NULL,
          ytd_cents INTEGER,
          pretax INTEGER NOT NULL DEFAULT 0,
          employer_cents INTEGER,
          position INTEGER NOT NULL,
          PRIMARY KEY (paystub_id, position)
        );
        -- A plan's match as a rule, in basis points of pay: 50% of the first 6% is 5000 and 600. Review sets them from
        -- match_note; until then they're null and match_cents is the match.
        ALTER TABLE contributions ADD COLUMN match_rate_bp INTEGER;
        ALTER TABLE contributions ADD COLUMN match_cap_bp INTEGER;
      `)
      copyWithholding(db)
    }
  },
  {
    version: 40,
    run: (db) =>
      db.exec(`
        -- asset_uses: who uses an asset, in dated periods, so its costs are shared by use (lines.ts): rooms rented in a
        -- house the user lives in, a car driven partly for a business. bucket_id null is Personal. On a day a period
        -- covers, the shares add up to 10000; a day no period covers is the asset owner's alone. basis is what the
        -- share was measured by (rooms, area, miles, time, other) and source who set it (user, review, migrated).
        CREATE TABLE asset_uses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          from_day TEXT NOT NULL,
          to_day TEXT,
          bucket_id INTEGER REFERENCES buckets(id) ON DELETE CASCADE,
          share_bp INTEGER NOT NULL CHECK (share_bp > 0 AND share_bp <= 10000),
          basis TEXT,
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_asset_uses ON asset_uses(asset_id, from_day);
        -- asset_id: the asset a cost is for (a house's dues, a car's gas), set by an asset rule (asset_source 'rule')
        -- or by hand ('user', 'ai'); rules never move one set by hand. A split part's own asset_id beats its
        -- transaction's.
        ALTER TABLE transactions ADD COLUMN asset_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
        ALTER TABLE transactions ADD COLUMN asset_source TEXT;
        ALTER TABLE transaction_splits ADD COLUMN asset_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
        -- A rule now puts matching lines in a venture (bucket_id) or on an asset (asset_id), exactly one of them, and
        -- can match a category. Migration 36's auto column comes along, and every rule keeps its id.
        CREATE TABLE bucket_rules_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bucket_id INTEGER REFERENCES buckets(id) ON DELETE CASCADE,
          asset_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          account_id TEXT,
          category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
          contains TEXT,
          amount_cents INTEGER,
          from_day TEXT,
          to_day TEXT,
          auto INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          CHECK ((bucket_id IS NULL) <> (asset_id IS NULL))
        );
        INSERT INTO bucket_rules_next (id, bucket_id, account_id, contains, amount_cents, from_day, to_day, auto, created_at)
          SELECT id, bucket_id, account_id, contains, amount_cents, from_day, to_day, auto, created_at FROM bucket_rules;
        -- A deleted rule's id is never given to a new one (an undo puts a rule back under its id, and would replace
        -- the new one), so the ids go on from the old table's last, not from the last rule left.
        DELETE FROM sqlite_sequence WHERE name = 'bucket_rules_next';
        INSERT INTO sqlite_sequence (name, seq) SELECT 'bucket_rules_next', seq FROM sqlite_sequence WHERE name = 'bucket_rules';
        DROP TABLE bucket_rules;
        ALTER TABLE bucket_rules_next RENAME TO bucket_rules;
      `)
  },
  {
    version: 41,
    run: (db) =>
      db.exec(`
        -- residence_converted: 1 once a venture's residence dates (when one of its places was the user's home) are
        -- Personal's use of its house (asset_uses, source migrated), with its costs in those dates put on the house
        -- (convertResidences). Until then, as for a venture with no house, the dates themselves keep its costs in
        -- them Personal. The dates stay, unread once converted, for one release.
        ALTER TABLE buckets ADD COLUMN residence_converted INTEGER NOT NULL DEFAULT 0;
      `)
  },
  {
    version: 42,
    run: (db) =>
      db.exec(`
        -- A month's close (snapshots.ts): what Personal's books said about a past month when it was closed, one row
        -- per version, every version kept. scope is 'personal'. origin: auto (closed as it fell due), review
        -- (close_month) or backfill (the first close of a month long past). status: closed, gap (Unexplained above
        -- the tolerance, or an identity that doesn't tie) or changed (sub-phase 1i). rows, checks, identity and
        -- bridge are JSON: every row and part, the leak and check items, the cash identity and the net worth bridge.
        -- The digests are sha-256 in hex, so a later check can tell whether anything that made the month has moved.
        CREATE TABLE month_snapshots (
          scope TEXT NOT NULL,
          month TEXT NOT NULL,
          version INTEGER NOT NULL,
          origin TEXT NOT NULL,
          closed_at INTEGER NOT NULL,
          engine_version INTEGER NOT NULL,
          status TEXT NOT NULL,
          "rows" TEXT NOT NULL,
          checks TEXT NOT NULL,
          identity TEXT NOT NULL,
          bridge TEXT NOT NULL,
          line_digest TEXT NOT NULL,
          line_count INTEGER NOT NULL,
          line_sum INTEGER NOT NULL,
          raw_digest TEXT NOT NULL,
          balance_digest TEXT NOT NULL,
          rows_digest TEXT NOT NULL,
          inputs_stamp TEXT NOT NULL,
          PRIMARY KEY (scope, month, version)
        );
        -- The month's ledger as it was closed, line by line. No foreign keys: a transaction deleted since still
        -- shows here, as removed.
        CREATE TABLE snapshot_lines (
          scope TEXT NOT NULL,
          month TEXT NOT NULL,
          version INTEGER NOT NULL,
          line_key TEXT NOT NULL,
          txn_id TEXT NOT NULL,
          split_id INTEGER,
          owner INTEGER,
          class TEXT NOT NULL,
          cents INTEGER NOT NULL,
          category_id INTEGER,
          series_key TEXT,
          paycheck_key TEXT,
          account_id TEXT NOT NULL,
          asset_id TEXT
        );
        CREATE INDEX idx_snapshot_lines ON snapshot_lines(scope, month, version);
        CREATE INDEX idx_snapshot_lines_txn ON snapshot_lines(txn_id);
        -- Each perimeter account's balance at the end of the day before the month and of its last day, where the
        -- month-end balance came from, and its balance gap in the month (the later known balance less the earlier
        -- one and the lines between them, so a missing purchase is negative).
        CREATE TABLE snapshot_balances (
          scope TEXT NOT NULL,
          month TEXT NOT NULL,
          version INTEGER NOT NULL,
          account_id TEXT NOT NULL,
          start_cents INTEGER NOT NULL,
          end_cents INTEGER NOT NULL,
          source TEXT NOT NULL,
          gap_cents INTEGER NOT NULL,
          PRIMARY KEY (scope, month, version, account_id)
        );
      `)
  },
  {
    version: 43,
    run: (db) =>
      db.exec(`
        -- Money between Personal and a venture (waterfall spec addendum 1.11, sub-phase 1j). venture_money: what Review
        -- or the user said a boundary line was, in parts that add up to the line (face 'line') or, for a Personal line a
        -- venture's cash or card paid, to its funding, minus the line (face 'fund'). cents is signed as the line or the
        -- funding, interest_cents a repayment's interest (the rest is principal), regular a draw's, source 'review' or
        -- 'user'.
        CREATE TABLE venture_money (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          txn_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          split_id INTEGER,
          face TEXT NOT NULL CHECK (face IN ('line', 'fund')),
          venture_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
          intent TEXT NOT NULL,
          cents INTEGER NOT NULL,
          interest_cents INTEGER NOT NULL DEFAULT 0,
          regular INTEGER,
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_venture_money_txn ON venture_money(txn_id);
        CREATE UNIQUE INDEX idx_venture_money_part ON venture_money(txn_id, COALESCE(split_id, -1), face, intent);
        -- The user's share of each venture, dated: the row with the latest from_day on or before a day is the share
        -- that day, in basis points (10000 is all of it), and before the first row it is 0. source: review, user or
        -- migrated.
        CREATE TABLE venture_shares (
          bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
          from_day TEXT NOT NULL,
          share_bp INTEGER NOT NULL CHECK (share_bp >= 0 AND share_bp <= 10000),
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (bucket_id, from_day)
        );
        -- A remembered answer for one pattern of boundary lines: a venture, a shape (T, C or F), a direction (out or
        -- in) and, for T, the Personal leg's payee key; later lines of the pattern take its intent.
        CREATE TABLE venture_money_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          venture_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
          shape TEXT NOT NULL CHECK (shape IN ('T', 'C', 'F')),
          direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
          payee_key TEXT,
          intent TEXT NOT NULL,
          regular INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_venture_money_rules ON venture_money_rules(venture_id);
        -- What a venture's stake is valued by: 'books' (the share of its net assets), 'estimate' (a Personal Stakes
        -- account's value, stake_account_id) or null (an estimate when a Stakes account is linked, else the books).
        -- No foreign key: accounts name their buckets, so one back would make a loop an import couldn't order;
        -- deleteAccount clears it.
        ALTER TABLE buckets ADD COLUMN value_source TEXT;
        ALTER TABLE buckets ADD COLUMN stake_account_id TEXT;
        -- Every venture as net worth counted it until now: all of it while in_net_worth was 1, none of it while 0.
        -- in_net_worth stays one release, read by nothing that counts net worth.
        INSERT INTO venture_shares (bucket_id, from_day, share_bp, source, created_at)
          SELECT id, '0000-01-01', CASE WHEN in_net_worth = 1 THEN 10000 ELSE 0 END, 'migrated', created_at FROM buckets;
      `)
  },
  {
    version: 44,
    run: (db) =>
      db.exec(`
        -- The Dashboard's cards, their order and which were hidden (sub-phase 2e): Home took its place, and nothing reads
        -- them now. What the onboarding answer chose is home.open, which stays; the budget's preferences, targets and
        -- rollover (budget.prefs, budgets, budget_targets, budget_rollover) stay as they are, read by Home's Left over
        -- and Saved, Spendable, Review and the phone.
        DELETE FROM settings WHERE key = 'dashboard.layout';
      `)
  }
]

/**
 * Migration 39's copy. Each paycheck's withholding (taxes and premiums per check, from its latest paystub) becomes a
 * paystub on that paystub's date, with source snapshot, and the plans on the same payroll in force that day become
 * its savings items: the employee's amount, with the match as the employer's. Its net is gross less every item, so
 * the chain to Take-home ties; with no gross on record, gross is the recorded net plus the items, marked estimated.
 * Payroll keys on paystubs and plans take payrollKey's form ('acme payroll|+'). A key that names no deposit keeps
 * that form, and one Review question lists those, with any withholding that had neither gross nor net to start from.
 */
function copyWithholding(d: SqlDriver): void {
  const deposits = new Set((d.prepare('SELECT DISTINCT merchant, desc_key AS descKey FROM transactions WHERE amount_cents > 0').all() as Array<{ merchant: string | null; descKey: string }>).map(payrollKey))
  const unmatched = new Set<string>()
  const remap = (key: string): string => {
    if (deposits.has(key)) return key
    const k = asPayrollKey(key)
    if (!deposits.has(k)) unmatched.add(k)
    return k
  }
  type Plan = { id: number; name: string; kind: ContributionKind; key: string; employee: number | null; match: number | null; starts: string | null; ends: string | null; nextEmployee: number | null; nextFrom: string | null }
  const plans = d
    .prepare('SELECT id, name, kind, paycheck_key AS key, employee_cents AS employee, match_cents AS match, starts_day AS starts, ends_day AS ends, next_employee_cents AS nextEmployee, next_from AS nextFrom FROM contributions WHERE paycheck_key IS NOT NULL ORDER BY kind, name')
    .all() as Plan[]
  for (const p of plans) {
    const k = remap(p.key)
    if (k !== p.key) d.prepare('UPDATE contributions SET paycheck_key = ? WHERE id = ?').run(k, p.id)
    p.key = k
  }
  const insertStub = d.prepare("INSERT OR IGNORE INTO paystubs (paycheck_key, pay_day, kind, gross_cents, net_cents, source, estimated, created_at) VALUES (?, ?, 'regular', ?, ?, 'snapshot', ?, ?)")
  const insertItem = d.prepare('INSERT INTO paystub_items (paystub_id, kind, name, cents, ytd_cents, pretax, employer_cents, position) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
  const blank: string[] = []
  for (const w of d.prepare('SELECT * FROM paycheck_withholding ORDER BY paycheck_key').all() as Array<Record<string, SQLInputValue>>) {
    const key = remap(w.paycheck_key as string)
    const day = w.as_of as string
    const items: Array<{ kind: PaystubItemKind; name: string; cents: number; pretax: boolean; employer: number | null }> = []
    const taxes: Array<[PaystubItemKind, string]> = [['federal', 'federal_cents'], ['social_security', 'social_security_cents'], ['medicare', 'medicare_cents'], ['state', 'state_cents']]
    for (const [kind, col] of taxes) {
      const cents = (w[col] as number | null) ?? 0
      if (cents) items.push({ kind, name: PAYSTUB_ITEMS[kind].label, cents, pretax: false, employer: null })
    }
    let premiums: InsuranceItem[] = []
    try {
      premiums = w.insurance_items ? (JSON.parse(w.insurance_items as string) as InsuranceItem[]) : []
    } catch {
      premiums = []
    }
    // A total recorded before premiums were kept one by one.
    if (!premiums.length && w.insurance_cents) premiums = [{ name: 'Insurance premiums', cents: w.insurance_cents as number, pretax: true }]
    for (const x of premiums) if (x.cents) items.push({ kind: premiumKind(x.name), name: x.name, cents: x.cents, pretax: !!x.pretax, employer: null })
    if (w.other_cents) items.push({ kind: 'other_deduction', name: PAYSTUB_ITEMS.other_deduction.label, cents: w.other_cents as number, pretax: false, employer: null })
    for (const p of plans) {
      if (p.key !== key || (p.starts && p.starts > day) || (p.ends && p.ends < day)) continue
      // An election change applies from the first paycheck on or after its date.
      const cents = p.nextFrom && p.nextEmployee !== null && day >= p.nextFrom ? p.nextEmployee : (p.employee ?? 0)
      if (cents || p.match) items.push({ kind: p.kind, name: p.name, cents, pretax: planGroup(p.kind) === 'pretax', employer: p.match })
    }
    const taken = items.reduce((s, x) => s + x.cents, 0)
    const recordedGross = w.gross_cents as number | null
    const recordedNet = w.net_cents as number | null
    if (recordedGross === null && recordedNet === null) {
      blank.push(key)
      continue
    }
    const gross = recordedGross ?? recordedNet! + taken
    const r = insertStub.run(key, day, gross, gross - taken, recordedGross === null ? 1 : 0, (w.updated_at as number | null) ?? now())
    if (!Number(r.changes)) continue
    items.forEach((x, i) => insertItem.run(r.lastInsertRowid, x.kind, x.name, x.cents, x.pretax ? 1 : 0, x.employer, i))
  }
  if (!unmatched.size && !blank.length) return
  const list = (keys: Iterable<string>): string => [...keys].slice(0, 20).map((k) => `'${k}'`).join(', ')
  const asks = [
    unmatched.size ? `These payroll keys on paystubs or contribution plans match no deposit: ${list(unmatched)}. Which paycheck is each one (list_recurring has the keys), or has that job ended?` : '',
    blank.length ? `The withholding kept for ${list(blank)} had neither gross nor net pay, so it wasn't made a paystub; record the latest one with record_paystub.` : ''
  ]
  d.prepare('INSERT INTO questions (text, created_at) VALUES (?, ?)').run(asks.filter(Boolean).join(' '), now())
}

/** Follow-ups a step owes that need more of the engine than db.ts can import, supplied by the module that has it. */
const supplied = new Map<number, () => void>()

/** Supplies a step's follow-up from a module db.ts can't import (lines.ts reads the recurring series). */
export function supplyFollowUp(version: number, fn: () => void): void {
  supplied.set(version, fn)
}

/** Runs a supplied follow-up; false when none is supplied yet, so it stays owed for the next migrate(). */
function runSupplied(version: number): boolean {
  const fn = supplied.get(version)
  if (!fn) return false
  fn()
  return true
}

MIGRATIONS.forEach((step, i) => {
  if (step.version !== i + 1) throw new Error(`Migration steps must be numbered 1, 2, 3…: step ${i + 1} is ${step.version}`)
})

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/** Runs the steps the database hasn't had yet, up to `target` (the latest by default). Returns how many ran. */
export function migrate(opts: { target?: number; steps?: readonly MigrationStep[] } = {}): number {
  const steps = opts.steps ?? MIGRATIONS
  const target = opts.target ?? LATEST_SCHEMA_VERSION
  const version = schemaVersion()
  let ran = 0
  for (const step of steps) {
    if (step.version <= version || step.version > target) continue
    const d = conn()
    const apply = (): void => {
      step.run(d)
      if (step.after) d.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${owedKey(step.version)}', '1')`)
      d.exec(`PRAGMA user_version = ${step.version}`)
    }
    try {
      if (d.transaction) d.transaction(apply)
      else {
        d.exec('BEGIN IMMEDIATE')
        try {
          apply()
          d.exec('COMMIT')
        } catch (err) {
          try {
            d.exec('ROLLBACK')
          } catch {
            // The failure already ended the transaction.
          }
          throw err
        }
      }
    } catch (err) {
      throw new Error(`Migration step ${step.version} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    ran++
  }
  // The follow-ups owed, in step order: this run's, and any an earlier run was cut short of.
  const reached = schemaVersion()
  for (const step of steps) {
    if (!step.after || step.version > reached || getSetting(owedKey(step.version)) === null) continue
    try {
      if (step.after() === false) continue
    } catch (err) {
      throw new Error(`Migration step ${step.version}'s follow-up failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    setSetting(owedKey(step.version), null)
  }
  // Each venture's residence dates become Personal's use of its house, the first time the books open with a house in
  // it: on the residence step, and for a venture given its house since.
  if (upToDate()) convertResidences()
  return ran
}

/** Connections whose books have every step of this build; one opened step by step (a target) may not yet. */
const complete = new WeakSet<SqlDriver>()

/**
 * Whether the open books are at this build's schema. What a later step's tables and columns hold (a converted
 * residence, an asset's uses) is read only then; books part way through their steps read as the steps before left them.
 */
export function upToDate(): boolean {
  const d = conn()
  if (complete.has(d)) return true
  if (schemaVersion() < LATEST_SCHEMA_VERSION) return false
  complete.add(d)
  return true
}

/** Links a receipt (a documents-folder path) to transactions, or unlinks with null. */
export function setReceipt(ids: string[], file: string | null): number {
  let n = 0
  const stmt = db.prepare('UPDATE transactions SET receipt = ? WHERE id = ?')
  inTransaction(() => {
    for (const id of ids) n += Number(stmt.run(file, id).changes)
  })
  return n
}

/** Sets what health costs mean for the HSA; null goes back to automatic. */
export function setHsa(ids: string[], state: HsaState | null): number {
  if (state !== null && !['eligible', 'not', 'reimbursed'].includes(state)) throw new Error(`Unknown HSA state ${String(state)}`)
  let n = 0
  const stmt = db.prepare('UPDATE transactions SET hsa = ? WHERE id = ?')
  inTransaction(() => {
    for (const id of ids) n += Number(stmt.run(state, id).changes)
  })
  return n
}

/** Marks purchases as durable one-offs (or not); budgets and the debt plan leave them out. */
export function setOneTime(ids: string[], oneTime: boolean): number {
  let n = 0
  const stmt = db.prepare('UPDATE transactions SET one_time = ? WHERE id = ?')
  inTransaction(() => {
    for (const id of ids) n += Number(stmt.run(oneTime ? 1 : 0, id).changes)
  })
  return n
}

// ---------- budgets ----------

export function listBudgets(): Map<number, number> {
  const rows = db.prepare('SELECT category_id, cents FROM budgets').all() as Array<{ category_id: number; cents: number }>
  return new Map(rows.map((r) => [r.category_id, r.cents]))
}

/** A category's target from this month on (null: none, the suggestion from history); earlier months keep theirs. */
export function setBudget(categoryId: number, cents: number | null): void {
  if (!get('SELECT 1 FROM categories WHERE id = ?', categoryId)) throw new Error(`No category ${categoryId}`)
  if (cents !== null && (!Number.isInteger(cents) || cents < 0)) throw new Error('Invalid budget')
  inTransaction(() => {
    if (cents === null) db.prepare('DELETE FROM budgets WHERE category_id = ?').run(categoryId)
    else db.prepare('INSERT INTO budgets (category_id, cents) VALUES (?, ?) ON CONFLICT(category_id) DO UPDATE SET cents = excluded.cents').run(categoryId, cents)
    writeTargetMonth(categoryId, today().slice(0, 7), cents)
  })
}

function writeTargetMonth(categoryId: number, month: string, cents: number | null): void {
  db.prepare('INSERT INTO budget_targets (category_id, month, cents) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET cents = excluded.cents').run(categoryId, month, cents)
}

/** Each category's targets over time, oldest first: from `month` on, `cents` (null: none). */
export function budgetHistory(): Map<number, Array<{ month: string; cents: number | null }>> {
  const out = new Map<number, Array<{ month: string; cents: number | null }>>()
  for (const r of all<{ category_id: number; month: string; cents: number | null }>('SELECT category_id, month, cents FROM budget_targets ORDER BY category_id, month')) {
    const list = out.get(r.category_id) ?? []
    list.push({ month: r.month, cents: r.cents })
    out.set(r.category_id, list)
  }
  return out
}

/** Categories whose leftover or overspend carries into the next month, each with the month it was turned on. */
export function listRollovers(): Map<number, string> {
  return new Map(all<{ category_id: number; from_month: string }>('SELECT category_id, from_month FROM budget_rollover').map((r) => [r.category_id, r.from_month]))
}

/** Turns a category's rollover on from this month (already on, it keeps its month), or off; on again later starts afresh. */
export function setRollover(categoryId: number, on: boolean): void {
  if (!get('SELECT 1 FROM categories WHERE id = ?', categoryId)) throw new Error(`No category ${categoryId}`)
  if (on) db.prepare('INSERT INTO budget_rollover (category_id, from_month) VALUES (?, ?) ON CONFLICT(category_id) DO NOTHING').run(categoryId, today().slice(0, 7))
  else db.prepare('DELETE FROM budget_rollover WHERE category_id = ?').run(categoryId)
}

/** A category's budget as it is, for the journal: its target, this month's line in the history, its rollover. */
export interface BudgetRecord {
  categoryId: number
  cents: number | null
  month: string
  /** this month's row in the history; null when it has none */
  monthRow: { cents: number | null } | null
  rolloverFrom: string | null
}

export function budgetRecord(categoryId: number): BudgetRecord {
  const month = today().slice(0, 7)
  const row = get<{ cents: number | null }>('SELECT cents FROM budget_targets WHERE category_id = ? AND month = ?', categoryId, month)
  return {
    categoryId,
    cents: get<{ cents: number }>('SELECT cents FROM budgets WHERE category_id = ?', categoryId)?.cents ?? null,
    month,
    monthRow: row ? { cents: row.cents } : null,
    rolloverFrom: get<{ from_month: string }>('SELECT from_month FROM budget_rollover WHERE category_id = ?', categoryId)?.from_month ?? null
  }
}

/** Puts a category's budget back exactly as budgetRecord found it, whatever month it is now. */
export function restoreBudgetRecord(r: BudgetRecord): void {
  inTransaction(() => {
    db.prepare('DELETE FROM budgets WHERE category_id = ?').run(r.categoryId)
    if (r.cents !== null) db.prepare('INSERT INTO budgets (category_id, cents) VALUES (?, ?)').run(r.categoryId, r.cents)
    db.prepare('DELETE FROM budget_targets WHERE category_id = ? AND month = ?').run(r.categoryId, r.month)
    if (r.monthRow) writeTargetMonth(r.categoryId, r.month, r.monthRow.cents)
    db.prepare('DELETE FROM budget_rollover WHERE category_id = ?').run(r.categoryId)
    if (r.rolloverFrom !== null) db.prepare('INSERT INTO budget_rollover (category_id, from_month) VALUES (?, ?)').run(r.categoryId, r.rolloverFrom)
  })
}

// ---------- facts, recurring overrides, resolved review items ----------

/** Categorization and headline prompts carry only this many characters of facts; a review sees them all. */
export const PROMPT_FACTS_LIMIT = 20_000
/** A ceiling on what's saved, so a runaway assistant can't grow every review prompt without end. */
export const FACTS_LIMIT = 400_000

export function listFacts(): Fact[] {
  return db.prepare('SELECT id, text, created_at AS createdAt, origin FROM facts ORDER BY id').all() as unknown as Fact[]
}

/**
 * The facts for categorization and headline prompts: the shortest ones that fit
 * in PROMPT_FACTS_LIMIT (who a payee is, how to treat something; the long ones
 * are document notes and the to-do list), in id order so the prompt stays
 * byte-identical between saves and the prefix cache can hit.
 */
export function promptFacts(): Fact[] {
  const all = listFacts()
  const fit = new Set<number>()
  let used = 0
  for (const f of [...all].sort((a, b) => a.text.length - b.text.length || a.id - b.id)) {
    if (used + f.text.length > PROMPT_FACTS_LIMIT) break
    used += f.text.length
    fit.add(f.id)
  }
  return all.filter((f) => fit.has(f.id))
}

export function addFact(text: string, origin: FactOrigin | null = null): number {
  const t = text.trim()
  if (!t) throw new Error('Empty fact')
  if (t.length > 2000) throw new Error('Fact is too long (max 2000 characters); split it into smaller facts')
  const total = get<{ n: number }>('SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM facts')?.n ?? 0
  if (total + t.length > FACTS_LIMIT) throw new Error(`The saved facts are full (${FACTS_LIMIT.toLocaleString('en-US')} characters); forget one that no longer matters first`)
  return Number(db.prepare('INSERT INTO facts (text, created_at, origin) VALUES (?, ?, ?)').run(t, now(), origin).lastInsertRowid)
}

export function deleteFact(id: number): void {
  db.prepare('DELETE FROM facts WHERE id = ?').run(id)
}

/** Puts a forgotten fact back under its old id (an undo). */
export function restoreFact(f: Fact): void {
  db.prepare('INSERT OR REPLACE INTO facts (id, text, created_at, origin) VALUES (?, ?, ?, ?)').run(f.id, f.text, f.createdAt, f.origin)
}

// ---------- pending actions ----------

export interface PendingActionRow {
  id: number
  createdAt: number
  tool: string
  input: string
  status: 'pending' | 'done'
}

/** Queues a destructive tool call for the user's approval; returns its id. */
export function addPendingAction(tool: string, input: Record<string, unknown>): number {
  return Number(db.prepare("INSERT INTO pending_actions (created_at, tool, input, status) VALUES (?, ?, ?, 'pending')").run(now(), tool, JSON.stringify(input)).lastInsertRowid)
}

export function listPendingActions(): PendingActionRow[] {
  return db.prepare("SELECT id, created_at AS createdAt, tool, input, status FROM pending_actions WHERE status = 'pending' ORDER BY id").all() as unknown as PendingActionRow[]
}

export function getPendingAction(id: number): PendingActionRow | undefined {
  return db.prepare("SELECT id, created_at AS createdAt, tool, input, status FROM pending_actions WHERE id = ? AND status = 'pending'").get(id) as PendingActionRow | undefined
}

/** An approved action stays as a record of what ran; a discarded one goes. */
export function finishPendingAction(id: number, outcome: 'done' | 'discarded'): void {
  if (outcome === 'discarded') db.prepare('DELETE FROM pending_actions WHERE id = ?').run(id)
  else db.prepare("UPDATE pending_actions SET status = 'done' WHERE id = ?").run(id)
}

// ---------- AI usage ----------

export interface UsageCounts {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  webSearches?: number
}

/** Records one model call's token counts against its route, and the turn and units the allowance counts it as. */
export function addAiUsage(route: AiRoute, u: UsageCounts, scope?: { turn?: string | null; units?: number }): void {
  db.prepare('INSERT INTO ai_usage (at, route, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, turn_id, units) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    now(),
    route,
    u.model,
    Math.round(u.inputTokens),
    Math.round(u.outputTokens),
    Math.round(u.cacheReadTokens),
    Math.round(u.cacheWriteTokens),
    Math.max(0, Math.round(u.webSearches ?? 0)),
    scope?.turn ?? null,
    Math.max(1, Math.round(scope?.units ?? 1))
  )
}

/** Each model call between two times (unix seconds, from inclusive, to exclusive), as its cost is worked out from. */
export function aiCallsBetween(from: number, to: number): UsageCounts[] {
  return db
    .prepare(
      `SELECT model, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
              cache_write_tokens AS cacheWriteTokens, web_searches AS webSearches
       FROM ai_usage WHERE at >= ? AND at < ?`
    )
    .all(from, to) as unknown as UsageCounts[]
}

/** This calendar month's calls and tokens, by route and model. */
export function aiUsageThisMonth(): AiUsageTotals[] {
  const from = monthStart(today().slice(0, 7))
  return db
    .prepare(
      `SELECT route, model, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_write_tokens) AS cacheWriteTokens
       FROM ai_usage WHERE at >= ? GROUP BY route, model ORDER BY route, model`
    )
    .all(from) as unknown as AiUsageTotals[]
}

export function listOpenQuestions(): Array<{ id: number; text: string; createdAt: number }> {
  return db.prepare('SELECT id, text, created_at AS createdAt FROM questions WHERE answered_at IS NULL ORDER BY id').all() as unknown as Array<{ id: number; text: string; createdAt: number }>
}

/** Saves a question for a review; the same open question twice is saved once. */
export function addQuestion(text: string): number {
  const t = text.trim()
  if (!t) throw new Error('Empty question')
  if (t.length > 1500) throw new Error('Question is too long (max 1500 characters)')
  const open = get<{ id: number }>('SELECT id FROM questions WHERE text = ? AND answered_at IS NULL', t)
  if (open) return open.id
  return Number(db.prepare('INSERT INTO questions (text, created_at) VALUES (?, ?)').run(t, now()).lastInsertRowid)
}

export function answerQuestion(id: number, answer: string | null): void {
  if (!get('SELECT 1 FROM questions WHERE id = ? AND answered_at IS NULL', id)) throw new Error(`No open question ${id}`)
  db.prepare('UPDATE questions SET answered_at = ?, answer = ? WHERE id = ?').run(now(), answer?.trim() || null, id)
}

/** Opens an answered question again (an undone answer_question). */
export function reopenQuestion(id: number): void {
  db.prepare('UPDATE questions SET answered_at = NULL, answer = NULL WHERE id = ?').run(id)
}

export function deleteQuestion(id: number): void {
  db.prepare('DELETE FROM questions WHERE id = ?').run(id)
}

export interface RecurringOverride {
  key: string
  status: 'confirmed' | 'dismissed' | null
  kind: RecurringKind | null
  name: string | null
}

export function recurringOverrides(): Map<string, RecurringOverride> {
  const rows = db.prepare('SELECT key, status, kind, name FROM recurring_overrides').all() as unknown as RecurringOverride[]
  return new Map(rows.map((r) => [r.key, r]))
}

export function setRecurringOverride(key: string, patch: { status?: RecurringOverride['status']; kind?: RecurringKind | null; name?: string | null }): void {
  const cur = recurringOverrides().get(key) ?? { key, status: null, kind: null, name: null }
  const next = { ...cur, ...patch }
  db.prepare(`
    INSERT INTO recurring_overrides (key, status, kind, name, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET status = excluded.status, kind = excluded.kind, name = excluded.name, updated_at = excluded.updated_at
  `).run(key, next.status, next.kind, next.name?.trim() || null, now())
}

export function deleteRecurringOverride(key: string): void {
  db.prepare('DELETE FROM recurring_overrides WHERE key = ?').run(key)
}

export function resolvedIssueKeys(): Set<string> {
  return new Set((db.prepare('SELECT key FROM resolved_issues').all() as Array<{ key: string }>).map((r) => r.key))
}

export function resolveIssue(key: string, note: string | null, summary: string | null = null): void {
  db.prepare('INSERT INTO resolved_issues (key, note, summary, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET note = excluded.note, summary = COALESCE(excluded.summary, resolved_issues.summary)').run(key, note, summary, now())
}

export function listResolvedIssues(): ResolvedIssue[] {
  return db.prepare('SELECT key, summary, note, created_at AS createdAt FROM resolved_issues ORDER BY created_at DESC, key').all() as unknown as ResolvedIssue[]
}

/** Brings a skipped issue back; true when it was on the list. */
export function unresolveIssue(key: string): boolean {
  return Number(db.prepare('DELETE FROM resolved_issues WHERE key = ?').run(key).changes) > 0
}

// ---------- the changes journal ----------

export interface ChangeRow {
  id: number
  createdAt: number
  turnId: string | null
  origin: string
  tool: string
  input: Record<string, unknown>
  before: unknown
  after: unknown
  undoneAt: number | null
}

/** Records a write a tool made, with the state it replaced (before) and what it left (after); returns the entry's id. */
export function addChange(c: { turnId: string | null; origin: string; tool: string; input: Record<string, unknown>; before: unknown; after: unknown }): number {
  const r = db
    .prepare('INSERT INTO changes (created_at, turn_id, origin, tool, input, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(now(), c.turnId, c.origin, c.tool, JSON.stringify(c.input), c.before === undefined ? null : JSON.stringify(c.before), c.after === undefined ? null : JSON.stringify(c.after))
  return Number(r.lastInsertRowid)
}

export function getChange(id: number): ChangeRow | null {
  const r = db.prepare('SELECT id, created_at, turn_id, origin, tool, input, before, after, undone_at FROM changes WHERE id = ?').get(id) as Record<string, SQLInputValue> | undefined
  if (!r) return null
  const json = (v: SQLInputValue): unknown => (typeof v === 'string' ? JSON.parse(v) : null)
  return {
    id: r.id as number,
    createdAt: r.created_at as number,
    turnId: (r.turn_id as string | null) ?? null,
    origin: r.origin as string,
    tool: r.tool as string,
    input: (json(r.input) ?? {}) as Record<string, unknown>,
    before: json(r.before),
    after: json(r.after),
    undoneAt: (r.undone_at as number | null) ?? null
  }
}

export function markChangeUndone(id: number): void {
  db.prepare('UPDATE changes SET undone_at = ? WHERE id = ?').run(now(), id)
}

/** The newest changes whose origin starts with `originPrefix` (and of one turn, when given), newest first. */
export function listChanges(o: { originPrefix: string; turnId?: string; limit: number }): ChangeRow[] {
  const prefix = 'substr(origin, 1, length(?)) = ?'
  const rows = (o.turnId === undefined
    ? db.prepare(`SELECT id FROM changes WHERE ${prefix} ORDER BY id DESC LIMIT ?`).all(o.originPrefix, o.originPrefix, o.limit)
    : db.prepare(`SELECT id FROM changes WHERE ${prefix} AND turn_id = ? ORDER BY id DESC LIMIT ?`).all(o.originPrefix, o.originPrefix, o.turnId, o.limit)) as Array<{ id: number }>
  return rows.map((r) => getChange(r.id)).filter((c): c is ChangeRow => c !== null)
}

// ---------- AI request log ----------

/** A logged request without its body. */
export interface AiRequestRow {
  id: number
  at: number
  route: string
  provider: string
  model: string
  bytes: number
  status: string
  usage: string | null
  error: string | null
}

/** Records a request as it goes out (status sent); returns its id. */
export function addAiRequest(r: { route: string; provider: string; model: string; bytes: number; request: Uint8Array; at?: number }): number {
  const res = db.prepare('INSERT INTO ai_requests (at, route, provider, model, bytes, request) VALUES (?, ?, ?, ?, ?, ?)').run(r.at ?? now(), r.route, r.provider, r.model, Math.max(0, Math.round(r.bytes)), r.request)
  return Number(res.lastInsertRowid)
}

/** What came back for a logged request: ok with the usage, or error with the message. */
export function finishAiRequest(id: number, o: { status: 'ok' | 'error'; usage: string | null; error: string | null }): void {
  db.prepare('UPDATE ai_requests SET status = ?, usage = ?, error = ? WHERE id = ?').run(o.status, o.usage, o.error, id)
}

/** Keeps the newest `keep` requests made at or after `since` (unix seconds); the rest go. */
export function pruneAiRequests(keep: number, since: number): void {
  db.prepare('DELETE FROM ai_requests WHERE at < ? OR id <= (SELECT id FROM ai_requests ORDER BY id DESC LIMIT 1 OFFSET ?)').run(since, Math.max(0, Math.floor(keep)))
}

/** The log, newest first, without the bodies. */
export function listAiRequests(): AiRequestRow[] {
  return db.prepare('SELECT id, at, route, provider, model, bytes, status, usage, error FROM ai_requests ORDER BY id DESC').all() as unknown as AiRequestRow[]
}

export function getAiRequest(id: number): (AiRequestRow & { request: Uint8Array }) | null {
  return (db.prepare('SELECT id, at, route, provider, model, bytes, status, usage, error, request FROM ai_requests WHERE id = ?').get(id) as unknown as (AiRequestRow & { request: Uint8Array }) | undefined) ?? null
}

/** Empties the log; returns how many requests it held. */
export function clearAiRequests(): number {
  return Number(db.prepare('DELETE FROM ai_requests').run().changes)
}

// ---------- file-bridge requests ----------

/** Whether a request with this content hash was applied before. */
export function bridgeRequestDone(hash: string): boolean {
  return !!get('SELECT 1 FROM bridge_requests WHERE hash = ?', hash)
}

export function recordBridgeRequest(hash: string, name: string): void {
  db.prepare('INSERT OR IGNORE INTO bridge_requests (hash, name, processed_at) VALUES (?, ?, ?)').run(hash, name, now())
}

/** Forgets requests older than `days` (a request that old is never re-dropped by accident). */
export function pruneBridgeRequests(days = 30): void {
  db.prepare('DELETE FROM bridge_requests WHERE processed_at < ?').run(now() - days * 86_400)
}

/** Read-only query helpers for modules that build reports (insights). */
export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

/** One write, for a module that moves whole tables (ledgerImport.ts). */
export function run(sql: string, ...params: SQLInputValue[]): void {
  db.prepare(sql).run(...params)
}

// ---------- days ----------

// Every day the engine counts is in the ledger's time zone (shared/zone.ts),
// wherever it runs: a hosted ledger's clock is UTC.

/** Each connection's calendar.timeZone setting, read once ('' for none or one this runtime doesn't know). */
const zoneSettings = new WeakMap<SqlDriver, string>()

/** The ledger's time zone: its calendar.timeZone setting, else the default zone (the system's); with no ledger open, the default. */
export function zone(): string {
  const d = scope.getStore() ?? opened
  if (!d?.isOpen) return defaultZone()
  let set = zoneSettings.get(d)
  if (set === undefined) {
    const v = getSetting('calendar.timeZone')
    set = v && isZone(v) ? v : ''
    zoneSettings.set(d, set)
  }
  return set || defaultZone()
}

/** The ledger's calendar day ('YYYY-MM-DD') for a Unix timestamp. */
export function dayKey(unix: number): string {
  return dayIn(unix, zone())
}

/** Noon of a day in the ledger's zone: the time a dated row with no time of its own gets. */
export const noon = (day: string): number => noonIn(day, zone())

/** The start of a day in the ledger's zone. */
export const dayStart = (day: string): number => startIn(day, zone())

/** The start of a month (YYYY-MM) in the ledger's zone. */
export const monthStart = (month: string): number => monthStartIn(month, zone())

/** Today in the ledger's zone. */
export const today = (): string => dayKey(now())

// SQL reads a zone by its offsets over these years; before or after them, the nearest one.
const SQL_FROM = Date.UTC(1990, 0, 1) / 1000
const SQL_TO = Date.UTC(2060, 0, 1) / 1000
const sqlOffsets = new Map<string, string>()

/**
 * Arguments for SQLite's date functions that read the unix time `col` on the ledger's clock:
 * `date(${localSql('t.posted')})` is the day it falls on. The zone's offset at that time comes from
 * its changes over the years, never SQLite's 'localtime': a Durable Object's is UTC whatever the
 * zone, and on Windows it reads years before 2007 by today's daylight-saving rules.
 */
export function localSql(col: string): string {
  const z = zone()
  let offset = sqlOffsets.get(z)
  if (offset === undefined) {
    const changes = offsetChanges(z, SQL_FROM, SQL_TO)
    offset = changes.length === 1 ? String(changes[0].offset) : `CASE ${changes.slice(1).reverse().map((c) => `WHEN $ >= ${c.at} THEN ${c.offset}`).join(' ')} ELSE ${changes[0].offset} END`
    sqlOffsets.set(z, offset)
  }
  return `${col} + ${offset.replaceAll('$', col)}, 'unixepoch'`
}

function recordSnapshot(accountId: string, balanceCents: number, at: number): void {
  writePoint(accountId, dayKey(at), balanceCents, 'sync')
}

/** Throws unless `v` is an amount the app can store (a safe integer of cents within MAX_CENTS). */
export function checkCents(v: unknown, what = 'Amount'): number {
  if (!isCents(v)) throw new Error(`${what} must be a whole number of cents up to ${(MAX_CENTS / 100).toLocaleString('en-US')} dollars`)
  return v
}

/** Text as it's stored: control and invisible characters out, runs of spaces collapsed (line breaks kept, at most one blank line), cut at `max` characters. */
export function cleanText(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

export const DESCRIPTION_MAX = 300
export const MERCHANT_MAX = 120
export const NOTES_MAX = 2000

/** A point written by a sync (or an estimate) never replaces one the user entered on that day. */
function writePoint(accountId: string, day: string, cents: number, source: BalancePoint['source']): void {
  checkCents(cents, 'Balance')
  db.prepare(`
    INSERT INTO balance_snapshots (account_id, day, balance_cents, source) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET balance_cents = excluded.balance_cents, source = excluded.source
    WHERE balance_snapshots.source != 'manual' OR excluded.source = 'manual'
  `).run(accountId, day, cents, source)
}

/** The point on one day as it is (for a journal), or null. */
export function getBalancePoint(accountId: string, day: string): BalancePoint | null {
  return get<BalancePoint>('SELECT day, balance_cents AS cents, source FROM balance_snapshots WHERE account_id = ? AND day = ?', accountId, day) ?? null
}

/** Puts a day's point back exactly as a journal recorded it (null removes it), whatever its source. */
export function restoreBalancePoint(accountId: string, day: string, point: BalancePoint | null): void {
  db.prepare('DELETE FROM balance_snapshots WHERE account_id = ? AND day = ?').run(accountId, day)
  if (point) db.prepare('INSERT INTO balance_snapshots (account_id, day, balance_cents, source) VALUES (?, ?, ?, ?)').run(accountId, day, checkCents(point.cents, 'Balance'), point.source)
  refreshManualBalance(accountId)
}

let transactionDepth = 0

/** Runs `fn` in a transaction; inside one already, in a savepoint, so a failure inside undoes only its own work. */
export function inTransaction<T>(fn: () => T): T {
  const d = conn()
  if (d.transaction) {
    try {
      return d.transaction(fn)
    } catch (err) {
      // A time zone set inside is undone too.
      zoneSettings.delete(d)
      throw err
    }
  }
  const nested = transactionDepth > 0
  const sp = `sp${transactionDepth}`
  db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
  transactionDepth++
  try {
    const result = fn()
    db.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
    return result
  } catch (err) {
    db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK')
    zoneSettings.delete(d)
    throw err
  } finally {
    transactionDepth--
  }
}

export const now = (): number => Math.floor(Date.now() / 1000)

/**
 * A stamp that changes whenever what the open ledger holds may have: a row written on this connection
 * (total_changes, rolled back or not), a commit by another connection (data_version), and the minute, for what
 * reads the clock. A module can keep work it derives from the data until the stamp moves. Null where the
 * connection can't tell (a hosted store that refuses the pragma): nothing is kept there.
 */
export function dataStamp(): string | null {
  try {
    const c = db.prepare('SELECT total_changes() AS c').get() as { c: number }
    const v = db.prepare('PRAGMA data_version').get() as { data_version: number } | undefined
    if (!v) return null
    return `${c.c - (closeWrites.get(conn()) ?? 0)}:${v.data_version}:${Math.floor(now() / 60)}`
  } catch {
    return null
  }
}

/** Rows each connection wrote that hold only the months' closes: nothing the engine keeps per data stamp reads them. */
const closeWrites = new WeakMap<SqlDriver, number>()

/**
 * Runs `fn`, whose writes are only the months' closes (snapshots.ts), so the data stamp doesn't move for them: the
 * classified lines and series kept per stamp stay good, and a backfill of month after month classifies each month's
 * history without finding every series again.
 */
export function writingCloses<T>(fn: () => T): T {
  const d = conn()
  // A store that can't count its changes keeps nothing per stamp either.
  const count = (): number | null => {
    try {
      return (db.prepare('SELECT total_changes() AS c').get() as { c: number }).c
    } catch {
      return null
    }
  }
  const start = count()
  try {
    return fn()
  } finally {
    const end = count()
    if (start !== null && end !== null) closeWrites.set(d, (closeWrites.get(d) ?? 0) + end - start)
  }
}

/** Each of Personal's months from one to another (YYYY-MM, inclusive) that has a close: its latest version, with that version's status and origin. Empty on books part way through their steps. */
export function latestCloses(fromMonth: string, toMonth: string): Map<string, { version: number; status: 'closed' | 'gap' | 'changed'; origin: 'auto' | 'review' | 'backfill' }> {
  if (!upToDate() || toMonth < fromMonth) return new Map()
  const rows = db
    .prepare(
      `SELECT s.month, s.version, s.status, s.origin FROM month_snapshots s
       WHERE s.scope = 'personal' AND s.month >= ? AND s.month <= ?
         AND s.version = (SELECT MAX(x.version) FROM month_snapshots x WHERE x.scope = s.scope AND x.month = s.month)`
    )
    .all(fromMonth, toMonth) as Array<{ month: string; version: number; status: 'closed' | 'gap' | 'changed'; origin: 'auto' | 'review' | 'backfill' }>
  return new Map(rows.map((r) => [r.month, { version: r.version, status: r.status, origin: r.origin }]))
}

/** A row of the waterfall as a month's close froze it: its actual, run rate, Δ 3 mo, rate, Δ pts and pay basis, and each part's actual, run rate, Δ 3 mo and rate. */
export interface ClosedRow {
  id: StageId
  actualCents: number
  runRateCents: number | null
  changeCents: number | null
  rate: number | null
  rateChangePts: number | null
  basis: PayBasis | null
  parts: Array<{ key: string; name?: string; actualCents: number; runRateCents: number | null; changeCents?: number | null; rate?: number | null }>
}

/** Each of Personal's months from one to another (YYYY-MM, inclusive) that has a close: its latest version's frozen rows. Empty on books part way through their steps. */
export function latestCloseRows(fromMonth: string, toMonth: string): Map<string, ClosedRow[]> {
  if (!upToDate() || toMonth < fromMonth) return new Map()
  const rows = db
    .prepare(
      `SELECT s.month, s."rows" AS r FROM month_snapshots s
       WHERE s.scope = 'personal' AND s.month >= ? AND s.month <= ?
         AND s.version = (SELECT MAX(x.version) FROM month_snapshots x WHERE x.scope = s.scope AND x.month = s.month)`
    )
    .all(fromMonth, toMonth) as Array<{ month: string; r: string }>
  const out = new Map<string, ClosedRow[]>()
  for (const x of rows) {
    try {
      out.set(x.month, (JSON.parse(x.r) as { rows?: ClosedRow[] }).rows ?? [])
    } catch {
      // A close whose rows don't read is read live.
    }
  }
  return out
}

/**
 * Each of some months that has a close: its latest version's cash identity terms and net worth bridge as frozen, the
 * identity without its tolerance. A close whose identity or bridge doesn't read is left out.
 */
export function latestCloseIdentities(months: string[]): Map<string, { identity: Record<string, number>; bridge: Record<string, unknown> }> {
  const out = new Map<string, { identity: Record<string, number>; bridge: Record<string, unknown> }>()
  if (!upToDate() || !months.length) return out
  const rows = db
    .prepare(
      `SELECT s.month, s.identity AS i, s.bridge AS b FROM month_snapshots s
       WHERE s.scope = 'personal' AND s.month IN (${months.map(() => '?').join(',')})
         AND s.version = (SELECT MAX(x.version) FROM month_snapshots x WHERE x.scope = s.scope AND x.month = s.month)`
    )
    .all(...months) as Array<{ month: string; i: string; b: string }>
  for (const x of rows) {
    try {
      const identity = Object.fromEntries(Object.entries(JSON.parse(x.i) as Record<string, number>).filter(([k]) => k !== 'toleranceCents'))
      out.set(x.month, { identity, bridge: JSON.parse(x.b) as Record<string, unknown> })
    } catch {
      // A close whose identity doesn't read shows no closed identity.
    }
  }
  return out
}

/** Each of some months that has a close: its latest version's ledger lines as frozen (snapshot_lines), by key, class, amount and owner. */
export function latestCloseLines(months: string[]): Map<string, Array<{ key: string; cls: LineClass; cents: number; owner: number | null }>> {
  const out = new Map<string, Array<{ key: string; cls: LineClass; cents: number; owner: number | null }>>()
  if (!upToDate() || !months.length) return out
  const latest = db
    .prepare(
      `SELECT s.month, MAX(s.version) AS version FROM month_snapshots s
       WHERE s.scope = 'personal' AND s.month IN (${months.map(() => '?').join(',')}) GROUP BY s.month`
    )
    .all(...months) as Array<{ month: string; version: number }>
  const lines = db.prepare(`SELECT line_key AS key, class AS cls, cents, owner FROM snapshot_lines WHERE scope = 'personal' AND month = ? AND version = ?`)
  for (const x of latest) out.set(x.month, lines.all(x.month, x.version) as Array<{ key: string; cls: LineClass; cents: number; owner: number | null }>)
  return out
}

/** A raw bank description's stable key (shared/payroll.ts), so the browser demo names payees as the ledger does. */
export { descKey }

// ---------- settings ----------

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string | null): void {
  if (key === 'calendar.timeZone') zoneSettings.delete(conn())
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ---------- categories ----------

interface CategoryRow {
  id: number
  name: string
  kind: CategoryKind
  description: string
}

export function listCategories(): Category[] {
  return db.prepare('SELECT id, name, kind, description FROM categories ORDER BY kind = \'transfer\', kind = \'income\', name').all() as unknown as CategoryRow[]
}

export function saveCategory(c: Omit<Category, 'id'> & { id?: number }): Category {
  const name = c.name.trim()
  if (!name) throw new Error('Category name is required')
  if (!['expense', 'income', 'transfer'].includes(c.kind)) throw new Error('Invalid category kind')
  if (c.id) {
    db.prepare('UPDATE categories SET name = ?, kind = ?, description = ? WHERE id = ?').run(name, c.kind, c.description.trim(), c.id)
    return { id: c.id, name, kind: c.kind, description: c.description.trim() }
  }
  const r = db.prepare('INSERT INTO categories (name, kind, description) VALUES (?, ?, ?)').run(name, c.kind, c.description.trim())
  return { id: Number(r.lastInsertRowid), name, kind: c.kind, description: c.description.trim() }
}

export function deleteCategory(id: number): void {
  // Transactions fall back to uncategorized (ON DELETE SET NULL); rules cascade.
  inTransaction(() => {
    db.prepare('UPDATE transactions SET category_source = NULL, confidence = NULL WHERE category_id = ?').run(id)
    db.prepare('DELETE FROM categories WHERE id = ?').run(id)
  })
}

// ---------- accounts ----------

/** A best guess at what kind of account this is, for accounts the user hasn't typed. */
function guessType(name: string, institution: string | null, balanceCents: number | null): AssetType {
  const text = `${name} ${institution ?? ''}`
  if (/401\s*\(?k|403\s*\(?b|457|\bira\b|roth|retire|pension|contributory/i.test(text)) return 'retirement'
  if (/espp|brokerage|individual|stock|invest|\bhsa\b|health savings/i.test(text)) return 'investment'
  if (/mortgage|heloc/i.test(text)) return 'mortgage'
  // Card product names from the big issuers, for feeds that leave the type out of the name.
  if (/card|credit|visa|mastercard|amex|discover|sapphire|freedom|slate|savor|quicksilver|venture|simplicity|double cash|custom cash|blue cash|cash rewards/i.test(text)) return 'credit_card'
  if (/loan|auto|toyota|honda|ford|tesla|nissan|hyundai|kia|subaru|gm financial|lease/i.test(text) || (balanceCents !== null && balanceCents < 0)) return 'loan'
  return 'cash'
}

/** What a cash account is for, from its name: savings, a money market, a CD or a reserve is saving; the rest is spending. */
function roleFromName(name: string): CashRole {
  return /saving|money market|\bcd\b|reserve/i.test(name) ? 'saving' : 'spending'
}

/** Plaid's depository subtypes by what the account is for. Others (an HSA) don't say. */
const SUBTYPE_ROLE: Record<string, CashRole> = { savings: 'saving', cd: 'saving', 'money market': 'saving', checking: 'spending', 'cash management': 'spending', paypal: 'spending', prepaid: 'spending', ebt: 'spending' }

/**
 * Keeps the bank's subtype of an account (Plaid's checking, savings, cd, money market...). It says what a cash
 * account is for when nothing has yet (the role is still guessed from the name); a role Review set, or an earlier
 * subtype's, stays.
 */
export function setPlaidSubtype(id: string, subtype: string | null): void {
  if (!subtype) return
  const was = get<{ plaid_subtype: string | null }>('SELECT plaid_subtype FROM accounts WHERE id = ?', id)
  if (!was || was.plaid_subtype === subtype) return
  db.prepare('UPDATE accounts SET plaid_subtype = ? WHERE id = ?').run(subtype, id)
  const role = SUBTYPE_ROLE[subtype.toLowerCase()]
  if (role) db.prepare('UPDATE accounts SET cash_role = ? WHERE id = ? AND cash_role IS NULL').run(role, id)
}

/** What a cash account is for as stored; null when it's still guessed from the name (set_account_role and its undo). */
export function cashRoleRaw(id: string): CashRole | null {
  return get<{ cash_role: CashRole | null }>('SELECT cash_role FROM accounts WHERE id = ?', id)?.cash_role ?? null
}

/** Sets what a cash account is for; null goes back to the guess from its name. */
export function setCashRole(id: string, role: CashRole | null): void {
  if (role !== null && role !== 'spending' && role !== 'saving') throw new Error(`Unknown role ${String(role)}: spending or saving`)
  if (!Number(db.prepare('UPDATE accounts SET cash_role = ? WHERE id = ?').run(role, id).changes)) throw new Error(`No account ${id}`)
}

/** The payee key of the payments that pay a debt, as stored (link_loan_payment and its undo). */
export function paymentKeyRaw(id: string): string | null {
  return get<{ payment_key: string | null }>('SELECT payment_key FROM accounts WHERE id = ?', id)?.payment_key ?? null
}

/** Links a debt to the payments that pay it by their payee key ('lakeside auto loan|-'), or unlinks it with null. */
export function setPaymentKey(id: string, key: string | null): void {
  if (key !== null && !/^.+\|-$/.test(key)) throw new Error(`A payment key is a payee and a minus, like 'lakeside auto loan|-', not ${key}`)
  if (!Number(db.prepare('UPDATE accounts SET payment_key = ? WHERE id = ?').run(key, id).changes)) throw new Error(`No account ${id}`)
}

/** Each transaction's asset as marked capital, by id (mark_capital and its undo). */
export function capitalAssets(ids: string[]): Array<{ id: string; assetId: string | null }> {
  return ids.flatMap((id) => {
    const r = get<{ capital_asset_id: string | null }>('SELECT capital_asset_id FROM transactions WHERE id = ?', id)
    return r ? [{ id, assetId: r.capital_asset_id }] : []
  })
}

/** Marks transactions as buying, selling or lending an asset (capital, out of spending and income), or unmarks them with null. */
export function setCapitalAsset(ids: string[], assetId: string | null): number {
  let n = 0
  const stmt = db.prepare('UPDATE transactions SET capital_asset_id = ? WHERE id = ?')
  inTransaction(() => {
    for (const id of ids) n += Number(stmt.run(assetId, id).changes)
  })
  return n
}

export function listAccounts(): Account[] {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txn_count,
      (SELECT MIN(posted) FROM transactions t WHERE t.account_id = a.id AND t.pending = 0) AS first_posted,
      (SELECT MIN(day) FROM balance_snapshots s WHERE s.account_id = a.id) AS first_point
    FROM accounts a ORDER BY a.hidden, a.institution, a.name
  `).all() as Array<Record<string, SQLInputValue>>
  return rows.map((r) => {
    const balanceCents = (r.balance_cents as number | null) ?? null
    const stored = (r.asset_type as AssetType | null) ?? null
    const assetType = stored ?? guessType(r.name as string, (r.institution as string | null) ?? null, balanceCents)
    const firstPosted = r.first_posted === null ? null : dayKey(r.first_posted as number)
    const known = [r.opened_day as string | null, firstPosted, r.first_point as string | null].filter((d): d is string => !!d)
    return {
      id: r.id as string,
      source: r.source as Account['source'],
      name: r.name as string,
      institution: (r.institution as string | null) ?? null,
      currency: r.currency as string,
      balanceCents,
      availableCents: (r.available_cents as number | null) ?? null,
      balanceDate: (r.balance_date as number | null) ?? null,
      hidden: r.hidden === 1,
      txnCount: r.txn_count as number,
      assetType,
      assetTypeSet: stored !== null,
      openedDay: (r.opened_day as string | null) ?? null,
      closedDay: (r.closed_day as string | null) ?? null,
      historyFrom: known.length ? known.sort()[0] : null,
      costCents: (r.cost_cents as number | null) ?? null,
      saleCostsCents: (r.sale_costs_cents as number | null) ?? null,
      linkedAssetId: (r.linked_asset_id as string | null) ?? null,
      details: (r.details as string | null) ?? null,
      bucketId: (r.bucket_id as number | null) ?? null,
      apr: (r.apr as number | null) ?? null,
      promoApr: (r.promo_apr as number | null) ?? null,
      promoEnds: (r.promo_ends as string | null) ?? null,
      minPaymentCents: (r.min_payment_cents as number | null) ?? null,
      cashRole: assetType === 'cash' ? ((r.cash_role as CashRole | null) ?? roleFromName(r.name as string)) : null,
      escrowCents: (r.escrow_cents as number | null) ?? null,
      paymentKey: (r.payment_key as string | null) ?? null
    }
  })
}

/** A real calendar day as YYYY-MM-DD (2026-02-30 is refused, not rolled into March). */
function checkDay(day: string | null | undefined, what: string): string | null {
  if (day === null || day === undefined || day === '') return null
  if (!isRealDay(day)) throw new Error(`${what} must be a date like 2024-06-30`)
  return day
}

/** checkDay for other modules. */
export const validDay = (day: string, what: string): string => checkDay(day, what)!

/** Adds an asset or debt that has no bank feed, with any known values. Returns its id. */
export function addManualAccount(a: NewAsset): string {
  const name = a.name.trim()
  if (!name) throw new Error('A name is required')
  const id = `manual:${randomUUID()}`
  inTransaction(() => {
    db.prepare(`
      INSERT INTO accounts (id, source, name, institution, currency, created_at, asset_type, opened_day, closed_day, cost_cents, linked_asset_id, details)
      VALUES (?, 'manual', ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, a.institution?.trim() || null, now(), a.assetType, checkDay(a.openedDay, 'Purchase date'), checkDay(a.closedDay, 'Sale date'), a.costCents == null ? null : checkCents(a.costCents, 'Cost'), a.linkedAssetId ?? null, a.details?.trim() || null)
    for (const p of a.points ?? []) writePoint(id, checkDay(p.day, 'Date')!, Math.round(p.cents), 'manual')
    refreshManualBalance(id)
  })
  return id
}

export function listBalancePoints(accountId: string): BalancePoint[] {
  return db.prepare('SELECT day, balance_cents AS cents, source FROM balance_snapshots WHERE account_id = ? ORDER BY day').all(accountId) as unknown as BalancePoint[]
}

/** Records a known balance on a date (a statement balance, an appraisal); debts are negative. */
export function setBalancePoint(accountId: string, day: string, cents: number): void {
  if (!get('SELECT 1 FROM accounts WHERE id = ?', accountId)) throw new Error(`No account ${accountId}`)
  writePoint(accountId, checkDay(day, 'Date')!, checkCents(cents), 'manual')
  refreshManualBalance(accountId)
}

export function deleteBalancePoint(accountId: string, day: string): void {
  db.prepare("DELETE FROM balance_snapshots WHERE account_id = ? AND day = ? AND source IN ('manual', 'estimate', 'statement')").run(accountId, day)
  refreshManualBalance(accountId)
}

/**
 * A closing balance from a statement file (QFX, OFX, QIF) on its day; it never
 * replaces one the user entered. With `current` (the balance is as of the
 * file's last row), an imported account's balance becomes it unless the
 * account has a newer one. Whether the day's point is new or changed.
 */
export function setStatementBalance(accountId: string, day: string, cents: number, current: boolean): boolean {
  const a = get<{ source: string; balance_date: number | null }>('SELECT source, balance_date FROM accounts WHERE id = ?', accountId)
  if (!a) throw new Error(`No account ${accountId}`)
  const before = getBalancePoint(accountId, checkDay(day, 'Date')!)
  writePoint(accountId, day, checkCents(cents, 'Balance'), 'statement')
  if (getBalancePoint(accountId, day)?.source !== 'statement') return false
  if (current && a.source === 'csv' && (a.balance_date === null || dayKey(a.balance_date) <= day)) {
    db.prepare('UPDATE accounts SET balance_cents = ?, balance_date = ? WHERE id = ?').run(cents, noon(day), accountId)
  }
  return before?.source !== 'statement' || before.cents !== cents
}

// ---------- recorded flows ----------

export interface RecordedFlow {
  id: number
  accountId: string
  day: string
  cents: number
  note: string | null
}

/** Recorded flows, oldest first: one account's, or every account's. */
export function listRecordedFlows(accountId?: string): RecordedFlow[] {
  const cols = 'SELECT id, account_id AS accountId, day, cents, note FROM recorded_flows'
  return accountId === undefined ? all<RecordedFlow>(`${cols} ORDER BY account_id, day, id`) : all<RecordedFlow>(`${cols} WHERE account_id = ? ORDER BY day, id`, accountId)
}

/** Records money put in (positive) or taken out (negative) on a day. Returns its id. */
export function addRecordedFlow(accountId: string, day: string, cents: number, note: string | null): number {
  if (!get('SELECT 1 FROM accounts WHERE id = ?', accountId)) throw new Error(`No account ${accountId}`)
  if (checkCents(cents) === 0) throw new Error('Invalid amount')
  const r = db.prepare('INSERT INTO recorded_flows (account_id, day, cents, note, created_at) VALUES (?, ?, ?, ?, ?)').run(accountId, checkDay(day, 'Date')!, cents, note, now())
  return Number(r.lastInsertRowid)
}

export function deleteRecordedFlow(id: number): RecordedFlow | null {
  const f = get<RecordedFlow>('SELECT id, account_id AS accountId, day, cents, note FROM recorded_flows WHERE id = ?', id) ?? null
  if (f) db.prepare('DELETE FROM recorded_flows WHERE id = ?').run(id)
  return f
}

/** Puts a deleted flow back under its old id (an undo). */
export function restoreRecordedFlow(f: RecordedFlow): void {
  db.prepare('INSERT OR REPLACE INTO recorded_flows (id, account_id, day, cents, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, f.accountId, f.day, checkCents(f.cents), f.note, now())
}

/** Each account's day from which all its flows are known, by account id. */
export function flowsKnownFrom(): Map<string, string> {
  return new Map(all<{ id: string; day: string }>('SELECT account_id AS id, day FROM flows_known_from').map((r) => [r.id, r.day]))
}

/** Sets (or with null clears) the day from which all an account's flows are known. */
export function setFlowsKnownFrom(accountId: string, day: string | null): void {
  if (!get('SELECT 1 FROM accounts WHERE id = ?', accountId)) throw new Error(`No account ${accountId}`)
  const d = checkDay(day, 'Date')
  if (d === null) db.prepare('DELETE FROM flows_known_from WHERE account_id = ?').run(accountId)
  else db.prepare('INSERT INTO flows_known_from (account_id, day) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET day = excluded.day').run(accountId, d)
}

// ---------- valuations ----------

/** Stores a looked-up value and records it as the day's balance, unless the user entered one that day. */
export function addValuation(accountId: string, v: Valuation): void {
  inTransaction(() => {
    db.prepare('INSERT INTO valuations (account_id, day, value_cents, low_cents, high_cents, basis, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      accountId,
      v.day,
      v.valueCents,
      v.lowCents,
      v.highCents,
      v.basis,
      JSON.stringify(v.sources),
      now()
    )
    if (get<{ source: string }>('SELECT source FROM balance_snapshots WHERE account_id = ? AND day = ?', accountId, v.day)?.source !== 'manual') writePoint(accountId, v.day, v.valueCents, 'estimate')
    refreshManualBalance(accountId)
  })
}

/** The newest valuation of each account that has one. */
export function latestValuations(): Map<string, Valuation> {
  const rows = db.prepare('SELECT * FROM valuations v WHERE id = (SELECT MAX(id) FROM valuations x WHERE x.account_id = v.account_id)').all() as Array<Record<string, SQLInputValue>>
  return new Map(
    rows.map((r) => [
      r.account_id as string,
      {
        day: r.day as string,
        valueCents: r.value_cents as number,
        lowCents: (r.low_cents as number | null) ?? null,
        highCents: (r.high_cents as number | null) ?? null,
        basis: r.basis as string,
        sources: JSON.parse(r.sources as string) as string[]
      }
    ])
  )
}

// ---------- calendar ----------

export function listCalendarEvents(from: string): CalendarEvent[] {
  const rows = db.prepare('SELECT * FROM calendar_events WHERE day >= ? ORDER BY day, id').all(from) as Array<Record<string, SQLInputValue>>
  return rows.map((r) => ({
    id: r.id as number,
    day: r.day as string,
    title: r.title as string,
    notes: (r.notes as string | null) ?? null,
    amountCents: (r.amount_cents as number | null) ?? null,
    createdBy: r.created_by as CalendarEvent['createdBy'],
    startTime: (r.start_time as string | null) ?? null,
    endTime: (r.end_time as string | null) ?? null,
    task: r.task === 1,
    doneAt: (r.done_at as number | null) ?? null
  }))
}

/** A reminder's task in Google Tasks, with its date and status as last synced, to tell which side changed. */
export interface GoogleTaskLink {
  list: string
  id: string
  due: string
  status: 'needsAction' | 'completed'
}

export function googleTaskLinks(): Map<number, GoogleTaskLink> {
  const rows = db.prepare('SELECT id, google_task FROM calendar_events WHERE google_task IS NOT NULL').all() as Array<{ id: number; google_task: string }>
  return new Map(rows.map((r) => [r.id, JSON.parse(r.google_task) as GoogleTaskLink]))
}

export function setGoogleTaskLink(id: number, link: GoogleTaskLink | null): void {
  db.prepare('UPDATE calendar_events SET google_task = ? WHERE id = ?').run(link ? JSON.stringify(link) : null, id)
}

/** A time of day given as 'H:MM' or 'HH:MM' (24-hour), as 'HH:MM'. */
function checkTime(t: string, what: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t.trim())
  if (!m) throw new Error(`${what} must be HH:MM, 24-hour (got "${t}")`)
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

const minuteOfDay = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
const clockTime = (n: number): string => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

export interface EventTimes {
  /** 'HH:MM', local; null makes the reminder all day */
  startTime?: string | null
  endTime?: string | null
  /** instead of an end time */
  durationMinutes?: number | null
}

/** A reminder's start and end after `t`, from what it had: a new start keeps the old length (an hour when there was none), ending by midnight. */
function eventTimes(t: EventTimes, had: { start: string | null; end: string | null }): { start: string | null; end: string | null } {
  if (t.startTime === null) return { start: null, end: null }
  const start = t.startTime !== undefined ? checkTime(t.startTime, 'Start time') : had.start
  if (!start) {
    if (t.endTime != null || t.durationMinutes != null) throw new Error('An end time needs a start time')
    return { start: null, end: null }
  }
  const from = minuteOfDay(start)
  const end =
    t.endTime != null ? minuteOfDay(checkTime(t.endTime, 'End time'))
    : t.durationMinutes != null ? from + Math.round(t.durationMinutes)
    : from + (had.start && had.end ? minuteOfDay(had.end) - minuteOfDay(had.start) : 60)
  if (end <= from) throw new Error('The end time must be after the start time')
  return { start, end: clockTime(Math.min(end, 23 * 60 + 59)) }
}

const TIMED_TASK = 'A task is all day: leave out the time, or make it an event'

export function addCalendarEvent(e: { day: string; title: string; notes?: string | null; amountCents?: number | null; createdBy?: CalendarEvent['createdBy']; task?: boolean } & EventTimes): number {
  const title = cleanText(e.title, MERCHANT_MAX)
  if (!title) throw new Error('A title is required')
  const t = eventTimes(e, { start: null, end: null })
  if (e.task && t.start) throw new Error(TIMED_TASK)
  const r = db
    .prepare('INSERT INTO calendar_events (day, title, notes, amount_cents, created_by, created_at, start_time, end_time, task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(checkDay(e.day, 'Date')!, title, e.notes ? cleanText(e.notes, NOTES_MAX) || null : null, e.amountCents == null ? null : checkCents(e.amountCents), e.createdBy ?? 'user', now(), t.start, t.end, e.task ? 1 : 0)
  return Number(r.lastInsertRowid)
}

export function updateCalendarEvent(id: number, patch: { day?: string; title?: string; notes?: string | null; amountCents?: number | null; task?: boolean; done?: boolean } & EventTimes): void {
  const had = get<{ start_time: string | null; end_time: string | null; task: number; done_at: number | null }>('SELECT start_time, end_time, task, done_at FROM calendar_events WHERE id = ?', id)
  if (!had) throw new Error(`No calendar event ${id}`)
  const retimed = patch.startTime !== undefined || patch.endTime !== undefined || patch.durationMinutes !== undefined
  const t = retimed ? eventTimes(patch, { start: had.start_time, end: had.end_time }) : null
  if ((patch.task ?? had.task === 1) && (t ? t.start : had.start_time)) throw new Error(TIMED_TASK)
  const title = patch.title !== undefined ? cleanText(patch.title, MERCHANT_MAX) : undefined
  if (title !== undefined && !title) throw new Error('A title is required')
  const day = patch.day !== undefined ? checkDay(patch.day, 'Date')! : undefined
  if (patch.amountCents != null) checkCents(patch.amountCents)
  if (patch.task !== undefined) db.prepare('UPDATE calendar_events SET task = ? WHERE id = ?').run(patch.task ? 1 : 0, id)
  if (patch.done !== undefined && patch.done !== (had.done_at !== null)) db.prepare('UPDATE calendar_events SET done_at = ? WHERE id = ?').run(patch.done ? now() : null, id)
  if (t) db.prepare('UPDATE calendar_events SET start_time = ?, end_time = ? WHERE id = ?').run(t.start, t.end, id)
  if (day !== undefined) db.prepare('UPDATE calendar_events SET day = ? WHERE id = ?').run(day, id)
  if (title !== undefined) db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?').run(title, id)
  if (patch.notes !== undefined) db.prepare('UPDATE calendar_events SET notes = ? WHERE id = ?').run(patch.notes ? cleanText(patch.notes, NOTES_MAX) || null : null, id)
  if (patch.amountCents !== undefined) db.prepare('UPDATE calendar_events SET amount_cents = ? WHERE id = ?').run(patch.amountCents, id)
}

export function deleteCalendarEvent(id: number): void {
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
}

/** Puts a reminder back exactly as a journal recorded it, under its old id. */
export function restoreCalendarEvent(e: CalendarEvent): void {
  db.prepare('INSERT OR REPLACE INTO calendar_events (id, day, title, notes, amount_cents, created_by, created_at, start_time, end_time, task, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    e.id,
    e.day,
    e.title,
    e.notes,
    e.amountCents,
    e.createdBy,
    now(),
    e.startTime,
    e.endTime,
    e.task ? 1 : 0,
    e.doneAt
  )
}

/** A manual account's balance is its value today, from its history. */
function refreshManualBalance(id: string): void {
  const a = get<{ source: string; opened_day: string | null; closed_day: string | null }>('SELECT source, opened_day, closed_day FROM accounts WHERE id = ?', id)
  if (a?.source !== 'manual') return
  const points = listBalancePoints(id)
  const value = points.length ? manualValue(points, dayKey(now()), a.opened_day, a.closed_day) : null
  db.prepare('UPDATE accounts SET balance_cents = ?, balance_date = ? WHERE id = ?').run(value, now(), id)
}

/** A manual account's value on a day: straight-line between known values, held after the last, zero outside its open dates. */
function manualValue(points: Array<{ day: string; cents: number }>, day: string, opened: string | null, closed: string | null): number {
  if ((opened && day < opened) || (closed && day > closed) || !points.length) return 0
  if (!opened && day < points[0].day) return 0
  if (day <= points[0].day) return points[0].cents
  const last = points[points.length - 1]
  if (day >= last.day) return last.cents
  const i = points.findIndex((p) => p.day > day)
  const a = points[i - 1]
  const b = points[i]
  const span = daysBetween(a.day, b.day)
  return Math.round(a.cents + ((b.cents - a.cents) * daysBetween(a.day, day)) / span)
}

export function upsertAccount(a: {
  id: string
  source: Account['source']
  name: string
  institution: string | null
  currency: string
  balanceCents: number | null
  availableCents: number | null
  balanceDate: number | null
}): void {
  // Keep a user-edited name: only the balance fields refresh on conflict.
  db.prepare(`
    INSERT INTO accounts (id, source, name, institution, currency, balance_cents, available_cents, balance_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      institution = excluded.institution,
      currency = excluded.currency,
      balance_cents = excluded.balance_cents,
      available_cents = excluded.available_cents,
      balance_date = excluded.balance_date
  `).run(a.id, a.source, a.name, a.institution, a.currency, a.balanceCents, a.availableCents, a.balanceDate, now())
  if (a.balanceCents !== null) recordSnapshot(a.id, a.balanceCents, a.balanceDate ?? now())
}

/** The account's type as the bank gives it, unless one is set already (by the user or an earlier sync). */
export function setAccountTypeIfUnset(id: string, type: AssetType): void {
  db.prepare('UPDATE accounts SET asset_type = ? WHERE id = ? AND asset_type IS NULL').run(type, id)
}

export function updateAccount(id: string, patch: AccountPatch): void {
  const source = get<{ source: string }>('SELECT source FROM accounts WHERE id = ?', id)?.source
  if (!source) throw new Error(`No account ${id}`)
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('Account name is required')
    db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id)
  }
  if (patch.hidden !== undefined) db.prepare('UPDATE accounts SET hidden = ? WHERE id = ?').run(patch.hidden ? 1 : 0, id)
  if (patch.assetType !== undefined) db.prepare('UPDATE accounts SET asset_type = ? WHERE id = ?').run(patch.assetType, id)
  if (patch.openedDay !== undefined) db.prepare('UPDATE accounts SET opened_day = ? WHERE id = ?').run(checkDay(patch.openedDay, 'Opened date'), id)
  if (patch.closedDay !== undefined) db.prepare('UPDATE accounts SET closed_day = ? WHERE id = ?').run(checkDay(patch.closedDay, 'Closed date'), id)
  if (patch.costCents !== undefined) {
    if (patch.costCents !== null) checkCents(patch.costCents, 'Cost')
    db.prepare('UPDATE accounts SET cost_cents = ? WHERE id = ?').run(patch.costCents, id)
  }
  if (patch.saleCostsCents !== undefined) {
    if (patch.saleCostsCents !== null && checkCents(patch.saleCostsCents, 'Selling costs') < 0) throw new Error('Invalid selling costs')
    db.prepare('UPDATE accounts SET sale_costs_cents = ? WHERE id = ?').run(patch.saleCostsCents, id)
  }
  if (patch.linkedAssetId !== undefined) {
    if (patch.linkedAssetId === id) throw new Error('An account can\'t be linked to itself')
    if (patch.linkedAssetId !== null && !get('SELECT 1 FROM accounts WHERE id = ?', patch.linkedAssetId)) throw new Error(`No account ${patch.linkedAssetId}`)
    db.prepare('UPDATE accounts SET linked_asset_id = ? WHERE id = ?').run(patch.linkedAssetId, id)
  }
  if (patch.details !== undefined) db.prepare('UPDATE accounts SET details = ? WHERE id = ?').run(patch.details?.trim() || null, id)
  if (patch.bucketId !== undefined) setAccountBucket(id, patch.bucketId)
  for (const [key, column] of [['apr', 'apr'], ['promoApr', 'promo_apr']] as const) {
    const v = patch[key]
    if (v === undefined) continue
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) throw new Error('Rates are percent a year, 0 to 100')
    db.prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(v, id)
  }
  if (patch.promoEnds !== undefined) db.prepare('UPDATE accounts SET promo_ends = ? WHERE id = ?').run(checkDay(patch.promoEnds, 'Intro rate end'), id)
  if (patch.minPaymentCents !== undefined) {
    if (patch.minPaymentCents !== null && checkCents(patch.minPaymentCents, 'Minimum payment') < 0) throw new Error('Invalid minimum payment')
    db.prepare('UPDATE accounts SET min_payment_cents = ? WHERE id = ?').run(patch.minPaymentCents, id)
  }
  if (patch.escrowCents !== undefined) {
    if (patch.escrowCents !== null && checkCents(patch.escrowCents, 'Escrow') < 0) throw new Error('Invalid escrow')
    db.prepare('UPDATE accounts SET escrow_cents = ? WHERE id = ?').run(patch.escrowCents, id)
  }
  if (patch.balanceCents !== undefined) {
    checkCents(patch.balanceCents, 'Balance')
    if (source === 'simplefin' || source === 'plaid') throw new Error('Bank-synced balances update themselves')
    if (source === 'manual') writePoint(id, dayKey(now()), patch.balanceCents, 'manual')
    else {
      const at = now()
      db.prepare('UPDATE accounts SET balance_cents = ?, balance_date = ? WHERE id = ?').run(patch.balanceCents, at, id)
      recordSnapshot(id, patch.balanceCents, at)
    }
  }
  refreshManualBalance(id)
}

// ---------- net worth and assets ----------

interface BalanceAccount {
  id: string
  source: string
  balance_cents: number | null
  at: number
  opened_day: string | null
  closed_day: string | null
}

interface BalanceInputs {
  a: BalanceAccount
  /** the day a fed or imported account's walk starts from, and its balance then */
  anchor: string
  anchorCents: number
  changes: Map<string, number>
  points: Array<{ day: string; cents: number }>
}

// A loan linked to an asset, with no dates of its own, runs from the asset's purchase to its sale.
const BALANCE_ACCOUNT_SQL = `SELECT a.id, a.source, a.balance_cents, COALESCE(a.balance_date, a.created_at) AS at,
  COALESCE(a.opened_day, l.opened_day) AS opened_day, COALESCE(a.closed_day, l.closed_day) AS closed_day
  FROM accounts a LEFT JOIN accounts l ON l.id = a.linked_asset_id`

function balanceInputs(a: BalanceAccount, today: string, landed?: Map<string, string>): BalanceInputs {
  const changes = new Map<string, number>()
  if (a.source !== 'manual') {
    for (const t of db.prepare('SELECT id, posted, amount_cents FROM transactions WHERE account_id = ? AND pending = 0').all(a.id) as Array<{ id: string; posted: number; amount_cents: number }>) {
      const k = landed?.get(t.id) ?? dayKey(t.posted)
      changes.set(k, (changes.get(k) ?? 0) + t.amount_cents)
    }
  }
  const points = db.prepare('SELECT day, balance_cents AS cents FROM balance_snapshots WHERE account_id = ? ORDER BY day').all(a.id) as Array<{ day: string; cents: number }>
  // An account with a balance of its own walks from it. One without (a file imported with no balance) walks from
  // its latest known balance, a statement Review recorded, so it isn't taken to hold nothing on the day it was
  // added; with none known, its lines alone move it from 0 then.
  const latest = a.balance_cents === null ? points.filter((p) => p.day <= today).pop() : undefined
  if (latest) return { a, anchor: latest.day, anchorCents: latest.cents, changes, points }
  return { a, anchor: dayKey(a.at) > today ? today : dayKey(a.at), anchorCents: a.balance_cents ?? 0, changes, points }
}

/** The first day anything is known about an account. */
function firstDay(x: BalanceInputs): string {
  const candidates = [...x.points.map((p) => p.day), ...(x.a.opened_day ? [x.a.opened_day] : [])]
  if (x.a.source !== 'manual') candidates.push(x.anchor, ...x.changes.keys())
  return candidates.sort()[0] ?? x.anchor
}

function dayRange(start: string, end: string): string[] {
  const days: string[] = []
  for (let k = start; ; k = addDays(k, 1)) {
    days.push(k)
    if (k >= end) break
  }
  return days
}

/**
 * One account's balance at the end of each of `days`.
 *
 * A manual account (a house, a loan) is valued from its known values, in a
 * straight line between them. Any other account starts from its latest
 * balance (with none of its own, its latest known one) and walks its posted
 * transactions backward and forward. Between two
 * known balances, whatever the transactions don't explain (market moves,
 * missing history) is spread evenly across the gap so the line meets both.
 * Before the earliest known balance or transaction the balance is held flat.
 * Every account is zero before it opened and from the day it closed.
 */
function dailyBalances(x: BalanceInputs, days: string[], throughClose = false): number[] {
  const { a, anchor, anchorCents, changes, points } = x
  const bal = new Array<number>(days.length).fill(0)
  // Gone on its closing day: a sale's proceeds or a refinance's new loan land
  // that day, so counting the old house or loan too would double it. A sold
  // asset's own history still ends on its sale value (throughClose).
  const gone = (day: string): boolean => !!a.closed_day && (throughClose ? day > a.closed_day : day >= a.closed_day)
  if (a.source === 'manual') {
    // The days run in order, so the known values beside them are walked once, each day's place found as it comes:
    // manualValue day by day, without searching the values and reading the days again for each one.
    const dayNo = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000
    const at = points.map((p) => dayNo(p.day))
    let k = 0
    for (let i = 0; i < days.length; i++) {
      const day = days[i]
      if (i > 0 && day < days[i - 1]) k = 0
      while (k < points.length && points[k].day <= day) k++
      if (gone(day) || (a.opened_day && day < a.opened_day) || (a.closed_day && day > a.closed_day) || !points.length || (!a.opened_day && day < points[0].day)) bal[i] = 0
      else if (k === 0) bal[i] = points[0].cents
      else if (k === points.length) bal[i] = points[k - 1].cents
      else {
        const [p, q] = [points[k - 1], points[k]]
        bal[i] = p.day === day ? p.cents : Math.round(p.cents + ((q.cents - p.cents) * (dayNo(day) - at[k - 1])) / (at[k] - at[k - 1]))
      }
    }
    return bal
  }

  const known = new Map(points.map((p) => [p.day, p.cents]))
  known.set(anchor, anchorCents)
  const change = (i: number): number => changes.get(days[i]) ?? 0
  const at = days.indexOf(anchor)
  bal[at] = anchorCents
  for (let i = at + 1; i < days.length; i++) bal[i] = known.get(days[i]) ?? bal[i - 1] + change(i)

  let later = at
  for (let i = at - 1; i >= 0; i--) {
    const walked = bal[i + 1] - change(i + 1)
    const k = known.get(days[i])
    if (k === undefined) {
      bal[i] = walked
      continue
    }
    // Days since the later known balance were walked from it; bend them to meet this one.
    const err = k - walked
    for (let j = i + 1; j < later; j++) bal[j] += Math.round((err * (later - j)) / (later - i))
    bal[i] = k
    later = i
  }

  for (let i = 0; i < days.length; i++) {
    if ((a.opened_day && days[i] < a.opened_day) || gone(days[i])) bal[i] = 0
  }
  return bal
}

/** One leg of money moved between the user's own accounts: its line, account, day and amount. */
export interface LandingLeg {
  id: string
  accountId: string
  day: string
  cents: number
}

/**
 * Money moved between the user's own accounts posts on different days at each
 * bank (a card payment leaves checking a day before the card shows it), so for a
 * day or two it would count in neither account or in both. Pairs each transfer
 * with the opposite one of the same amount in another account within five days,
 * and returns each pair whose legs post on different days, the leg out first.
 */
export function transfersApart(): Array<[LandingLeg, LandingLeg]> {
  const rows = db.prepare(`SELECT t.id, t.account_id, t.posted, t.amount_cents FROM transactions t
    JOIN categories c ON c.id = t.category_id WHERE c.kind = 'transfer' AND t.pending = 0 AND t.amount_cents <> 0`).all() as Array<{ id: string; account_id: string; posted: number; amount_cents: number }>
  type Leg = LandingLeg & { used: boolean }
  const ins = new Map<number, Leg[]>()
  for (const r of rows) {
    if (r.amount_cents <= 0) continue
    const list = ins.get(r.amount_cents) ?? []
    list.push({ id: r.id, accountId: r.account_id, day: dayKey(r.posted), cents: r.amount_cents, used: false })
    ins.set(r.amount_cents, list)
  }
  const pairs: Array<[LandingLeg, LandingLeg]> = []
  for (const out of rows.filter((r) => r.amount_cents < 0).sort((x, y) => x.posted - y.posted)) {
    const day = dayKey(out.posted)
    let best: Leg | undefined
    let bestGap = 6
    for (const leg of ins.get(-out.amount_cents) ?? []) {
      if (leg.used || leg.accountId === out.account_id) continue
      const gap = Math.abs(daysBetween(day, leg.day))
      if (gap < bestGap) {
        best = leg
        bestGap = gap
      }
    }
    if (!best) continue
    best.used = true
    if (best.day === day) continue
    pairs.push([{ id: out.id, accountId: out.account_id, day, cents: out.amount_cents }, { id: best.id, accountId: best.accountId, day: best.day, cents: best.cents }])
  }
  return pairs
}

/** The day both legs of each pair transfersApart finds count: the later of the two. */
function transfersLanded(): Map<string, string> {
  const landed = new Map<string, string>()
  for (const [out, into] of transfersApart()) {
    const later = into.day > out.day ? into.day : out.day
    landed.set(out.id, later)
    landed.set(into.id, later)
  }
  return landed
}

/** A transfer's other leg: its transaction, account and day. */
export interface TransferLeg {
  id: string
  accountId: string
  day: string
}

/**
 * Each transfer's other leg: the line of the opposite amount on another account within five days, nearest
 * first (then the earlier). Transfers pair with transfers first, so a stray line of the same amount can't take a
 * real leg's place. Then a line in a transfer category pairs with a line in no category (an uncategorized card
 * payment), with any line off the user's own cash and cards (a brokerage's, a loan's, a venture's side filed as
 * income), and, when the transfer is on a venture's account, with any line at all: money moved to or from a
 * venture is that, whatever the user's side was filed under. A purchase or a paycheck on the user's own cash and
 * cards (visible and in no venture, or placed in Personal on a venture's) never pairs with an unrelated transfer
 * of the same amount, and lines that aren't transfers never pair with each other.
 * Pay is only the leg of a transfer out of a venture's account: a venture's payroll paying the user (salary, waterfall
 * spec addendum 1.11, I2), last of all, once every other line had its chance, and only when the payroll is the
 * venture's own: every check from it on the user's accounts lands within the days of such a transfer of the same
 * amount. So an employer's paycheck the same as an unrelated transfer from a venture stays pay, as it always was. A
 * paycheck pairs with nothing else, and pay landing on a venture's account is nobody's leg.
 * Split transactions don't pair (their parts have categories of their own). Legs are
 * found over every day, hidden accounts and pending rows included, so a line's leg is the same whatever span is
 * asked for. Returns each line dated from `from` to `to` (YYYY-MM-DD, inclusive) that has a leg, with the leg,
 * and the lines in a transfer category there that have none.
 */
export function transferPairs(from: string, to: string): { pairOf: Map<string, TransferLeg>; unmatched: string[] } {
  const pay = new Set(listCategories().filter((c) => categoryRole(c.name) === 'paycheck').map((c) => c.id))
  const accts = new Map(listAccounts().map((a) => [a.id, a]))
  const rows = (
    db.prepare(`
    SELECT t.id, t.account_id, date(${localSql('t.posted')}) AS day, t.amount_cents, c.kind = 'transfer' AS transfer,
      t.category_id, t.bucket_id, t.bucket_source, t.merchant, t.desc_key AS descKey FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.amount_cents <> 0 AND ${NOT_SPLIT}
      AND (c.kind = 'transfer' OR -t.amount_cents IN (SELECT x.amount_cents FROM transactions x JOIN categories xc ON xc.id = x.category_id WHERE xc.kind = 'transfer'))
    ORDER BY t.posted, t.id
  `).all() as Array<{ id: string; account_id: string; day: string; amount_cents: number; transfer: number | null; category_id: number | null; bucket_id: number | null; bucket_source: string | null } & Payee>
  ).filter((r) => r.category_id === null || !pay.has(r.category_id) || (r.amount_cents > 0 && (accts.get(r.account_id)?.bucketId ?? null) === null))
  /** A line of the user's own cash and cards: Personal spending or income when it's in a category. */
  const own = (r: (typeof rows)[number]): boolean => {
    const a = accts.get(r.account_id)
    return !!a && !a.hidden && (a.assetType === 'cash' || a.assetType === 'credit_card') && (a.bucketId === null || (r.bucket_id === null && (r.bucket_source === 'user' || r.bucket_source === 'ai')))
  }
  // free: a line that may be a transfer's leg though it isn't one. venture: on a venture's account. pay: a paycheck's
  // payroll key, null for any other line.
  type Leg = { id: string; accountId: string; day: string; cents: number; transfer: boolean; free: boolean; venture: boolean; pay: string | null; leg: Leg | null }
  const legs: Leg[] = rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    day: r.day,
    cents: r.amount_cents,
    transfer: r.transfer === 1,
    free: r.category_id === null || !own(r),
    venture: (accts.get(r.account_id)?.bucketId ?? null) !== null,
    pay: r.category_id !== null && pay.has(r.category_id) ? payrollKey(r) : null,
    leg: null
  }))
  const ins = new Map<number, Leg[]>()
  for (const l of legs) {
    if (l.cents < 0) continue
    const list = ins.get(l.cents)
    if (list) list.push(l)
    else ins.set(l.cents, [l])
  }
  // Both legs transfers, then one of them.
  for (const both of [true, false]) {
    for (const out of legs) {
      if (out.cents > 0 || out.leg || (both && !out.transfer)) continue
      let best: Leg | null = null
      let bestGap = 6
      for (const leg of ins.get(-out.cents) ?? []) {
        if (leg.leg || leg.pay !== null || leg.accountId === out.accountId || (both ? !leg.transfer : leg.transfer === out.transfer)) continue
        const [transfer, other] = out.transfer ? [out, leg] : [leg, out]
        if (!both && !other.free && !transfer.venture) continue
        const gap = Math.abs(daysBetween(out.day, leg.day))
        if (gap < bestGap) {
          best = leg
          bestGap = gap
        }
      }
      if (!best) continue
      best.leg = out
      out.leg = best
    }
  }
  // Last, a venture's payroll: each check of a payroll key takes the nearest transfer out of a venture's account of
  // its amount still with no leg, when every check of that key on the user's accounts finds one.
  const checks = new Map<string, Leg[]>()
  for (const l of legs) if (l.pay !== null && !l.leg) checks.set(l.pay, [...(checks.get(l.pay) ?? []), l])
  if (checks.size) {
    const all = new Map<string, number>()
    const ids = [...pay]
    for (const r of db.prepare(`SELECT t.account_id, t.merchant, t.desc_key AS descKey FROM transactions t WHERE t.amount_cents > 0 AND ${NOT_SPLIT} AND t.category_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ account_id: string } & Payee>) {
      if ((accts.get(r.account_id)?.bucketId ?? null) !== null) continue
      const k = payrollKey(r)
      if (checks.has(k)) all.set(k, (all.get(k) ?? 0) + 1)
    }
    const outs = legs.filter((l) => l.cents < 0 && l.transfer && l.venture && !l.leg)
    for (const [k, list] of checks) {
      if (list.length !== all.get(k)) continue
      const taken: Array<[Leg, Leg]> = []
      for (const c of list) {
        let best: Leg | null = null
        let bestGap = 6
        for (const out of outs) {
          if (out.leg || out.cents !== -c.cents || out.accountId === c.accountId) continue
          const gap = Math.abs(daysBetween(out.day, c.day))
          if (gap < bestGap) {
            best = out
            bestGap = gap
          }
        }
        if (!best) break
        best.leg = c
        c.leg = best
        taken.push([best, c])
      }
      // One check with no such transfer: the payroll is someone else's, and none of its checks is a leg.
      if (taken.length !== list.length) for (const [out, c] of taken) out.leg = c.leg = null
    }
  }
  const pairOf = new Map<string, TransferLeg>()
  const unmatched: string[] = []
  for (const l of legs) {
    if (l.day < from || l.day > to) continue
    if (l.leg) pairOf.set(l.id, { id: l.leg.id, accountId: l.leg.accountId, day: l.leg.day })
    else if (l.transfer) unmatched.push(l.id)
  }
  return { pairOf, unmatched }
}

/**
 * A venture's daily net worth, named on its own or beside Personal (netWorth.ts has Personal's), from the earliest
 * thing known about its accounts to today: the accounts of the ventures named, with a balance of their own, each
 * transfer's legs counted on the later of their days. Beside Personal (0 among `buckets`), Personal's accounts and
 * every other venture whose share today is above 0 count whole too, as they did when net worth counted a venture's
 * accounts in place of its position; a Stakes account linked to a venture is never one of them.
 */
export function ventureNetWorthSeries(buckets: BucketSelection): NetWorthSeries {
  const ids = buckets.filter((id) => Number.isInteger(id) && id > 0)
  if (!ids.length) return { points: [], accountsIncluded: 0, accountsMissing: 0, landed: [], ahead: [] }
  const today = dayKey(now())
  const inBuckets = `COALESCE(a.bucket_id, l.bucket_id) IN (${ids.join(',')})`
  const stake = 'NOT EXISTS (SELECT 1 FROM buckets sb WHERE sb.stake_account_id = a.id)'
  const counted = `(${VENTURE_OF} IS NULL OR EXISTS (SELECT 1 FROM buckets b WHERE b.id = ${VENTURE_OF} AND ${SHARE_ON} > 0))`
  const withPersonal = buckets.includes(0)
  const scope = withPersonal ? `((${counted} AND ${stake}) OR ${inBuckets})` : inBuckets
  const params = withPersonal ? [today] : []
  const accounts = db.prepare(`${BALANCE_ACCOUNT_SQL} WHERE a.hidden = 0 AND a.balance_cents IS NOT NULL AND ${scope}`).all(...params) as unknown as BalanceAccount[]
  const missing = (db.prepare(`SELECT COUNT(*) AS n FROM accounts a LEFT JOIN accounts l ON l.id = a.linked_asset_id WHERE a.hidden = 0 AND a.balance_cents IS NULL AND ${scope}`).get(...params) as { n: number }).n
  if (!accounts.length) return { points: [], accountsIncluded: 0, accountsMissing: missing, landed: [], ahead: [] }

  const landed = transfersLanded()
  const inputs = accounts.map((a) => balanceInputs(a, today, landed))
  const days = dayRange(inputs.map(firstDay).sort()[0], today)
  const totals = new Array<number>(days.length).fill(0)
  for (const x of inputs) dailyBalances(x, days).forEach((b, i) => (totals[i] += b))
  return { points: days.map((day, i) => ({ day, cents: totals[i] })), accountsIncluded: accounts.length, accountsMissing: missing, landed: [], ahead: [] }
}

/**
 * Every visible account net worth reads: each Personal one, and the accounts each venture's position reads (its net
 * assets while any of its share rows is above 0, or its Stakes account by an estimate). An account with no balance of
 * its own yet is here too, at what its lines and known values give, so what its lines moved is in net worth's change.
 * With every share migrated these are the accounts net worth counted before 1j.
 */
export function countedAccounts(): string[] {
  const { personal, ventures } = ventureHoldings()
  const read = new Set([...personal, ...ventures.flatMap((v) => v.reads)])
  return all<{ id: string }>('SELECT a.id FROM accounts a WHERE a.hidden = 0 ORDER BY a.rowid')
    .map((r) => r.id)
    .filter((id) => read.has(id))
}

/** Each account's balance on one day (debts negative). */
export function balancesOn(ids: string[], day: string): Map<string, number> {
  if (!ids.length) return new Map()
  const { byId } = balancesOver(ids, day, day)
  return new Map([...byId].map(([id, v]) => [id, v[0] ?? 0]))
}

/** One account's balance at the end of each of some days, as balancesOver has it; a manual account's is read from its known values alone. */
export function balancesOnDays(id: string, days: string[]): number[] {
  if (!days.length) return []
  const a = db.prepare(`${BALANCE_ACCOUNT_SQL} WHERE a.id = ?`).get(id) as BalanceAccount | undefined
  if (!a) return days.map(() => 0)
  if (a.source === 'manual') {
    const points = db.prepare('SELECT day, balance_cents AS cents FROM balance_snapshots WHERE account_id = ? ORDER BY day').all(id) as Array<{ day: string; cents: number }>
    return days.map((d) => (a.closed_day && d >= a.closed_day ? 0 : manualValue(points, d, a.opened_day, a.closed_day)))
  }
  const sorted = [...days].sort()
  const { days: all, byId } = balancesOver([id], sorted[0], sorted[sorted.length - 1])
  const series = byId.get(id) ?? []
  return days.map((d) => series[all.indexOf(d)] ?? 0)
}

/**
 * Balances of the given accounts on each day from `start` to `end`; with `start` null, from the day before the
 * earliest thing known about any of them (the net worth series' first point).
 */
export function balancesOver(ids: string[], start: string | null, end: string, throughClose = false): { days: string[]; byId: Map<string, number[]> } {
  const rows = ids.length ? (db.prepare(`${BALANCE_ACCOUNT_SQL} WHERE a.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as BalanceAccount[]) : []
  return walkBalances(rows, start, end, throughClose)
}

/**
 * The one walk of balances: each account's balance at the end of each day from `start` to `end`, walked over every
 * day anything is known about it. With `start` null, from the day before the earliest thing known about any of them,
 * when each held what it had before anything was known. balancesOver (and through it the bridge and the balance
 * sheet) and the net worth series read it, so they agree to the cent.
 */
function walkBalances(rows: BalanceAccount[], start: string | null, end: string, throughClose = false): { days: string[]; byId: Map<string, number[]> } {
  const today = dayKey(now())
  const inputs = rows.map((a) => balanceInputs(a, today))
  const known = inputs.map(firstDay).sort()[0]
  const first = start ?? (known ? addDays(known, -1) : end)
  // Walks need to cover every known balance, so compute over the full span and trim.
  const from = [first, ...(known ? [known] : [])].sort()[0]
  const full = dayRange(from, end > today ? end : today)
  const lo = full.indexOf(first)
  const hi = full.indexOf(end)
  const byId = new Map(inputs.map((x) => [x.a.id, dailyBalances(x, full, throughClose).slice(lo, hi + 1)]))
  return { days: full.slice(lo, hi + 1), byId }
}

/** One account's balance gap in one month: what its balances say it holds beyond what its lines explain, between two of its known balances. */
export interface BalanceGap {
  accountId: string
  /** YYYY-MM */
  month: string
  /** the known balances it's between: the earlier one's day (null before the account's first) and the later one's (null after its last) */
  fromDay: string | null
  toDay: string | null
  /** the gap's part in the month's days asked for: positive when the balance ended above what the lines say */
  cents: number
}

/**
 * What each account's balances don't explain by its lines, from `from` to `to` (YYYY-MM-DD, inclusive): per account,
 * pair of known balances and month, the gap, the later balance less the earlier one and the lines between them,
 * split across the days as dailyBalances bends it. dailyBalances walks back from the later balance and takes
 * err = earlier - walked, so a gap is -err. A day's part is what the balance moved by beyond the day's lines: its
 * share of a gap bent across the days, a jump to a known balance, an opening or a closing. The lines are every line
 * of the account, pending ones too, as the ledger counts them, so a pending line the balance doesn't show yet is in
 * the gap until it settles. Balances are balancesOver's, so the parts add up to its changes less the lines.
 */
export function balanceGaps(ids: string[], from: string, to: string): BalanceGap[] {
  if (!ids.length || to < from) return []
  const today = dayKey(now())
  const rows = db.prepare(`${BALANCE_ACCOUNT_SQL} WHERE a.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as BalanceAccount[]
  const byDay = db.prepare(`SELECT date(${localSql('t.posted')}) AS day, SUM(t.amount_cents) AS cents FROM ${TXN_LINES} t WHERE t.account_id = ? AND t.posted >= ? AND t.posted < ? GROUP BY day`)
  const out: BalanceGap[] = []
  for (const a of rows) {
    const x = balanceInputs(a, today)
    const days = dayRange([addDays(from, -1), firstDay(x)].sort()[0], to > today ? to : today)
    const bal = dailyBalances(x, days)
    const lines = new Map((byDay.all(a.id, dayStart(from), dayStart(addDays(to, 1))) as Array<{ day: string; cents: number }>).map((r) => [r.day, r.cents]))
    // The balances dailyBalances holds to: every known one, and a fed account's own.
    const known = [...new Set([...x.points.map((p) => p.day), ...(a.source === 'manual' ? [] : [x.anchor])])].sort()
    let k = 0
    let last: BalanceGap | undefined
    for (let i = days.indexOf(from); i < days.length && days[i] <= to; i++) {
      const cents = bal[i] - bal[i - 1] - (lines.get(days[i]) ?? 0)
      if (!cents) continue
      while (k < known.length && known[k] < days[i]) k++
      const gap: BalanceGap = { accountId: a.id, month: days[i].slice(0, 7), fromDay: k > 0 ? known[k - 1] : null, toDay: k < known.length ? known[k] : null, cents }
      if (last && last.month === gap.month && last.fromDay === gap.fromDay && last.toDay === gap.toDay) last.cents += cents
      else out.push((last = gap))
    }
  }
  return out.filter((g) => g.cents !== 0)
}

// ---------- investments ----------

/** An account's settled transactions, oldest first, with the payee and the bank's description together for matching. */
export function accountActivity(accountId: string): Array<{ day: string; cents: number; text: string }> {
  return db.prepare(`
    SELECT date(${localSql('posted')}) AS day, amount_cents AS cents, COALESCE(merchant, '') || ' | ' || description AS text
    FROM transactions WHERE account_id = ? AND pending = 0 ORDER BY posted
  `).all(accountId) as Array<{ day: string; cents: number; text: string }>
}

export interface HoldingInput {
  id: string
  symbol: string | null
  description: string
  shares: number | null
  valueCents: number
  costCents: number | null
}

/** Replaces an account's positions with the ones the bank just reported. */
export function replaceHoldings(accountId: string, holdings: HoldingInput[], asOf: number): void {
  db.prepare('DELETE FROM holdings WHERE account_id = ?').run(accountId)
  const insert = db.prepare('INSERT OR REPLACE INTO holdings (account_id, holding_id, symbol, description, shares, value_cents, cost_cents, as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const h of holdings) insert.run(accountId, h.id, h.symbol, h.description, h.shares, h.valueCents, h.costCents, asOf)
}

/** Pre-tax, Roth, HSA or taxable, from the account's name and type. */
export function taxTreatment(a: Pick<Account, 'name' | 'assetType'>): TaxTreatment {
  if (a.assetType === 'venture') return 'private'
  if (/\broth\b/i.test(a.name)) return 'roth'
  if (/\bhsa\b|health savings/i.test(a.name)) return 'hsa'
  if (a.assetType === 'retirement' || /401\s*\(?k|403\s*\(?b|\bira\b|457|pension/i.test(a.name)) return 'pretax'
  return 'taxable'
}

/** Investment and retirement accounts and stakes in businesses, with positions and balances over time by tax treatment. */
export function getInvestments(): Investments {
  const today = dayKey(now())
  const accounts = listAccounts().filter((a) => ['investment', 'retirement', 'venture'].includes(a.assetType) && !a.hidden && !(a.closedDay && a.closedDay <= today))
  const rows = db.prepare('SELECT * FROM holdings ORDER BY value_cents DESC').all() as Array<{ account_id: string; symbol: string | null; description: string; shares: number | null; value_cents: number; cost_cents: number | null; as_of: number }>
  const start = accounts.map((a) => a.historyFrom ?? a.openedDay ?? today).sort()[0] ?? today
  const { days, byId } = balancesOver(accounts.map((a) => a.id), start, today)
  const at = (id: string, i: number): number => byId.get(id)?.[i] ?? 0
  const last = days.length - 1
  const list = accounts
    .map((a): InvestmentAccount => ({
      account: a,
      treatment: taxTreatment(a),
      valueCents: a.balanceCents ?? 0,
      change30Cents: last >= 30 && (a.historyFrom ?? today) <= days[last - 30] ? at(a.id, last) - at(a.id, last - 30) : null,
      holdings: rows
        .filter((r) => r.account_id === a.id)
        .map((r) => ({ symbol: r.symbol, description: r.description, shares: r.shares, priceCents: r.shares ? Math.round(r.value_cents / r.shares) : null, valueCents: r.value_cents, costCents: r.cost_cents && r.cost_cents > 0 ? r.cost_cents : null, costEstimated: false, inferred: false, asOf: r.as_of })),
      costCents: null,
      costEstimated: false
    }))
    .sort((a, b) => b.valueCents - a.valueCents)
  const points: Investments['points'] = []
  for (let i = 0; i < days.length; i++) {
    if (i % 7 !== (last % 7) && i !== last) continue
    const p = { day: days[i], pretax: 0, roth: 0, hsa: 0, taxable: 0, private: 0 }
    for (const x of list) p[x.treatment] += at(x.account.id, i)
    points.push(p)
  }
  return { accounts: list, points }
}

const ASSET_TYPES_ON_PAGE: AssetType[] = ['property', 'vehicle', 'other_asset', 'venture', 'receivable']

/** Real estate, vehicles, stakes, money owed to the user and other assets, each with its linked debts, equity and gain or loss. */
export function listAssets(): AssetSummary[] {
  const accounts = listAccounts()
  const today = dayKey(now())
  const valuations = latestValuations()
  return accounts
    .filter((a) => ASSET_TYPES_ON_PAGE.includes(a.assetType))
    .map((asset) => {
      const linked = accounts.filter((d) => d.linkedAssetId === asset.id)
      const sold = !!asset.closedDay && asset.closedDay <= today
      // A sold asset is shown as of its sale: sale value, debt paid off at closing.
      const on = sold ? asset.closedDay! : today
      const { byId } = balancesOver([asset.id, ...linked.map((d) => d.id)], on, on, true)
      const valueCents = byId.get(asset.id)?.[0] ?? 0
      const debts = linked.map((d) => ({ id: d.id, name: d.name, owedCents: Math.max(0, -(byId.get(d.id)?.[0] ?? 0)) }))
      const owedCents = debts.reduce((s, d) => s + d.owedCents, 0)
      return {
        account: asset,
        valueCents,
        debts,
        owedCents,
        equityCents: valueCents - owedCents,
        gainCents: asset.costCents === null ? null : valueCents - (sold ? (asset.saleCostsCents ?? 0) : 0) - asset.costCents,
        sold,
        valuation: valuations.get(asset.id) ?? null
      }
    })
}

/** Weekly value and amount owed for one asset, from purchase to sale (or today). */
export function getAssetHistory(id: string): AssetHistory {
  const asset = listAccounts().find((a) => a.id === id)
  if (!asset) throw new Error(`No asset ${id}`)
  const today = dayKey(now())
  const debtIds = (db.prepare('SELECT id FROM accounts WHERE linked_asset_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id)
  const start = asset.openedDay ?? asset.historyFrom ?? today
  const end = asset.closedDay && asset.closedDay < today ? asset.closedDay : today
  if (start > end) return { points: [] }
  const { days, byId } = balancesOver([id, ...debtIds], start, end, true)
  const value = byId.get(id) ?? []
  const points: AssetHistory['points'] = []
  for (let i = 0; i < days.length; i++) {
    if (i % 7 !== 0 && i !== days.length - 1) continue
    const owed = debtIds.reduce((s, d) => s + Math.max(0, -(byId.get(d)?.[i] ?? 0)), 0)
    points.push({ day: days[i], valueCents: value[i] ?? 0, owedCents: owed })
  }
  return { points }
}

export function deleteAccount(id: string): void {
  inTransaction(() => {
    db.prepare('UPDATE accounts SET linked_asset_id = NULL WHERE linked_asset_id = ?').run(id)
    // Its venture's auto rule goes with it (a rule made on purpose stays, as it always has), and a venture whose stake
    // it held is valued by its books again.
    db.prepare('DELETE FROM bucket_rules WHERE auto = 1 AND account_id = ?').run(id)
    if (upToDate()) db.prepare('UPDATE buckets SET stake_account_id = NULL WHERE stake_account_id = ?').run(id)
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  })
}

// ---------- merging accounts ----------

const MERGED_KEY = 'accounts.merged'

/** Accounts folded into another (old id to kept id). A sync skips their feeds, which would bring the rows back twice. */
export function mergedAccounts(): Record<string, string> {
  try {
    const v = JSON.parse(getSetting(MERGED_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

type Row = Record<string, SQLInputValue>

/** What a merge replaces, for the journal: both accounts and every row it moves, edits or removes. */
export interface MergeSnapshot {
  from: Row
  into: Row
  fromTxns: Row[]
  intoTxns: Row[]
  splits: Row[]
  tags: Row[]
  /** both accounts' rows' intents with a venture (venture_money); absent from a merge journaled before they moved with it */
  ventureMoney?: Row[]
  fromPoints: Row[]
  intoPoints: Row[]
  fromFlowsKnown: Row | null
  intoFlowsKnown: Row | null
  holdings: Row[]
  fromGoals: number[]
  intoGoals: number[]
  refs: Record<'linked' | 'bucket_rules' | 'contributions' | 'valuations' | 'recorded_flows', Array<string | number>>
  merged: string | null
}

export interface MergeResult {
  matched: number
  moved: number
  dropped: number
  points: number
}

const MATCH_SECONDS = 3 * 86_400
// The user's and the assistant's choices outrank a rule's, and a rule's outranks Claude's guess.
const SOURCE_RANK: Record<string, number> = { user: 3, assistant: 3, rule: 2, ai: 1 }
const sourceRank = (s: SQLInputValue): number => SOURCE_RANK[String(s)] ?? 0

/** The other account's rows a merge can pair with: those within the match window of the old account's. */
function mergeWindow(fromId: string, intoId: string): Row[] {
  const span = get<{ lo: number | null; hi: number | null }>('SELECT MIN(posted) AS lo, MAX(posted) AS hi FROM transactions WHERE account_id = ?', fromId)
  if (span?.lo == null || span.hi == null) return []
  return all<Row>('SELECT * FROM transactions WHERE account_id = ? AND posted BETWEEN ? AND ? ORDER BY posted, id', intoId, span.lo - MATCH_SECONDS, span.hi + MATCH_SECONDS)
}

const idsOf = (sql: string, id: string): Array<string | number> => all<{ id: string | number }>(sql, id).map((r) => r.id)

export function accountMergeSnapshot(fromId: string, intoId: string): MergeSnapshot {
  const from = get<Row>('SELECT * FROM accounts WHERE id = ?', fromId)
  const into = get<Row>('SELECT * FROM accounts WHERE id = ?', intoId)
  if (!from) throw new Error(`No account ${fromId}`)
  if (!into) throw new Error(`No account ${intoId}`)
  const fromTxns = all<Row>('SELECT * FROM transactions WHERE account_id = ? ORDER BY posted, id', fromId)
  const intoTxns = mergeWindow(fromId, intoId)
  const txnIds = [...fromTxns, ...intoTxns].map((t) => t.id as string)
  const rowsFor = (table: string, column = 'transaction_id'): Row[] => {
    const out: Row[] = []
    for (let i = 0; i < txnIds.length; i += 500) {
      const chunk = txnIds.slice(i, i + 500)
      out.push(...all<Row>(`SELECT * FROM ${table} WHERE ${column} IN (${chunk.map(() => '?').join(',')})`, ...chunk))
    }
    return out
  }
  const fromPoints = all<Row>('SELECT * FROM balance_snapshots WHERE account_id = ?', fromId)
  const days = new Set(fromPoints.map((p) => p.day as string))
  return {
    from,
    into,
    fromTxns,
    intoTxns,
    splits: rowsFor('transaction_splits'),
    tags: rowsFor('transaction_tags'),
    ventureMoney: upToDate() ? rowsFor('venture_money', 'txn_id') : [],
    fromPoints,
    intoPoints: all<Row>('SELECT * FROM balance_snapshots WHERE account_id = ?', intoId).filter((p) => days.has(p.day as string)),
    fromFlowsKnown: get<Row>('SELECT * FROM flows_known_from WHERE account_id = ?', fromId) ?? null,
    intoFlowsKnown: get<Row>('SELECT * FROM flows_known_from WHERE account_id = ?', intoId) ?? null,
    holdings: all<Row>('SELECT * FROM holdings WHERE account_id = ?', fromId),
    fromGoals: all<{ goal_id: number }>('SELECT goal_id FROM goal_accounts WHERE account_id = ?', fromId).map((g) => g.goal_id),
    intoGoals: all<{ goal_id: number }>('SELECT goal_id FROM goal_accounts WHERE account_id = ?', intoId).map((g) => g.goal_id),
    refs: {
      linked: idsOf('SELECT id FROM accounts WHERE linked_asset_id = ?', fromId),
      bucket_rules: idsOf('SELECT id FROM bucket_rules WHERE account_id = ?', fromId),
      contributions: idsOf('SELECT id FROM contributions WHERE account_id = ?', fromId),
      valuations: idsOf('SELECT id FROM valuations WHERE account_id = ?', fromId),
      recorded_flows: idsOf('SELECT id FROM recorded_flows WHERE account_id = ?', fromId)
    },
    merged: getSetting(MERGED_KEY)
  }
}

/**
 * Folds one account into another: the same card or bank account on two
 * feeds, as a reconnected bank makes a new account. A transaction on both
 * (same amount and description, within three days) keeps the kept account's
 * row, with what was set on the old one where that outranks it: category,
 * venture, an asset put on by hand, notes, one-time, HSA, receipt, splits and
 * tags. The old account's other rows move over as they are, except pending
 * ones the kept feed already covers (they posted there, or never will). Known
 * balances move too: entered
 * ones always, synced ones from before the kept feed starts. Rules,
 * contributions, flows, goals and links follow, the old account is deleted,
 * and its feed is ignored from then on.
 */
export function mergeAccounts(fromId: string, intoId: string, name?: string): MergeResult {
  if (fromId === intoId) throw new Error('An account can\'t be merged into itself')
  return inTransaction(() => {
    const from = get<Row>('SELECT * FROM accounts WHERE id = ?', fromId)
    const into = get<Row>('SELECT * FROM accounts WHERE id = ?', intoId)
    if (!from) throw new Error(`No account ${fromId}`)
    if (!into) throw new Error(`No account ${intoId}`)
    if (from.source === 'manual' || into.source === 'manual') throw new Error('Only bank-synced or imported accounts can be merged; a manual one is valued from its balances, not transactions')
    const intoRows = mergeWindow(fromId, intoId)
    const byKey = new Map<string, Row[]>()
    for (const t of intoRows) {
      const k = `${t.amount_cents}|${t.desc_key}`
      byKey.set(k, [...(byKey.get(k) ?? []), t])
    }
    const intoStart = get<{ p: number | null }>('SELECT MIN(posted) AS p FROM transactions WHERE account_id = ?', intoId)?.p ?? null
    const used = new Set<string>()
    const result: MergeResult = { matched: 0, moved: 0, dropped: 0, points: 0 }
    const setFields = db.prepare(`UPDATE transactions SET category_id = ?, category_source = ?, confidence = ?, merchant = ?, bucket_id = ?, bucket_source = ?,
      asset_id = ?, asset_source = ?, notes = ?, one_time = ?, hsa = ?, receipt = ? WHERE id = ?`)
    // An asset set by hand on the old row stays (the rules run again after, for the rest).
    const byHand = (source: SQLInputValue): boolean => source !== null && source !== 'rule'
    for (const f of all<Row>('SELECT * FROM transactions WHERE account_id = ? ORDER BY posted, id', fromId)) {
      let pair: Row | null = null
      for (const t of byKey.get(`${f.amount_cents}|${f.desc_key}`) ?? []) {
        const gap = Math.abs((t.posted as number) - (f.posted as number))
        if (used.has(t.id as string) || gap > MATCH_SECONDS) continue
        if (!pair || gap < Math.abs((pair.posted as number) - (f.posted as number))) pair = t
      }
      if (!pair) {
        if (f.pending === 1 && intoStart !== null && (f.posted as number) >= intoStart) {
          db.prepare('DELETE FROM transactions WHERE id = ?').run(f.id)
          result.dropped++
        } else {
          db.prepare('UPDATE transactions SET account_id = ? WHERE id = ?').run(intoId, f.id)
          result.moved++
        }
        continue
      }
      used.add(pair.id as string)
      const cat = f.category_id !== null && sourceRank(f.category_source) >= sourceRank(pair.category_source) ? f : pair
      const bucket = (f.bucket_id !== null || f.bucket_source !== null) && sourceRank(f.bucket_source) >= sourceRank(pair.bucket_source) ? f : pair
      const asset = byHand(f.asset_source) && !byHand(pair.asset_source) ? f : pair
      const notes = [...new Set([f.notes, pair.notes].filter((n): n is string => typeof n === 'string' && n.trim() !== ''))].join('\n').slice(0, NOTES_MAX) || null
      setFields.run(cat.category_id, cat.category_source, cat.confidence, cat.merchant ?? (cat === f ? pair : f).merchant, bucket.bucket_id, bucket.bucket_source,
        asset.asset_id, asset.asset_source, notes, Math.max(Number(f.one_time), Number(pair.one_time)), f.hsa ?? pair.hsa, f.receipt ?? pair.receipt, pair.id)
      if (!get('SELECT 1 FROM transaction_splits WHERE transaction_id = ?', pair.id)) db.prepare('UPDATE transaction_splits SET transaction_id = ? WHERE transaction_id = ?').run(pair.id, f.id)
      // What Review said the old row's money is (marked as an asset's capital, or its intents with a venture) goes to
      // the row it matched when that row has neither, so the claim, the basis or the capital counts as before.
      const marked = pair.capital_asset_id !== null || (upToDate() && !!get('SELECT 1 FROM venture_money WHERE txn_id = ?', pair.id))
      if (!marked) {
        if (f.capital_asset_id !== null) db.prepare('UPDATE transactions SET capital_asset_id = ? WHERE id = ?').run(f.capital_asset_id, pair.id)
        if (upToDate()) db.prepare('UPDATE venture_money SET txn_id = ? WHERE txn_id = ?').run(pair.id, f.id)
      }
      db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag, label, created_at) SELECT ?, tag, label, created_at FROM transaction_tags WHERE transaction_id = ?').run(pair.id, f.id)
      db.prepare('DELETE FROM transactions WHERE id = ?').run(f.id)
      result.matched++
    }

    // A synced balance from the old feed's later days is the bank's word on what the kept feed now reports.
    const firstPoint = get<{ d: string | null }>('SELECT MIN(day) AS d FROM balance_snapshots WHERE account_id = ?', intoId)?.d ?? null
    const intoFirst = [firstPoint, intoStart === null ? null : dayKey(intoStart)].filter((d): d is string => d !== null).sort()[0] ?? null
    for (const p of all<{ day: string; balance_cents: number; source: BalancePoint['source'] }>('SELECT day, balance_cents, source FROM balance_snapshots WHERE account_id = ?', fromId)) {
      if (p.source === 'sync' && intoFirst !== null && p.day >= intoFirst) continue
      writePoint(intoId, p.day, p.balance_cents, p.source)
      result.points++
    }

    const opened = from.opened_day === null ? null : into.opened_day === null || (from.opened_day as string) < (into.opened_day as string) ? from.opened_day : into.opened_day
    db.prepare(`UPDATE accounts SET name = ?, opened_day = ?, asset_type = COALESCE(asset_type, ?), cost_cents = COALESCE(cost_cents, ?), linked_asset_id = COALESCE(linked_asset_id, ?),
      details = COALESCE(details, ?), bucket_id = COALESCE(bucket_id, ?), apr = COALESCE(apr, ?), promo_apr = COALESCE(promo_apr, ?), promo_ends = COALESCE(promo_ends, ?),
      min_payment_cents = COALESCE(min_payment_cents, ?), sale_costs_cents = COALESCE(sale_costs_cents, ?), cash_role = COALESCE(cash_role, ?), plaid_subtype = COALESCE(plaid_subtype, ?),
      escrow_cents = COALESCE(escrow_cents, ?), payment_key = COALESCE(payment_key, ?) WHERE id = ?`)
      .run(name?.trim() || (into.name as string), opened, from.asset_type, from.cost_cents, from.linked_asset_id === intoId ? null : from.linked_asset_id, from.details, from.bucket_id,
        from.apr, from.promo_apr, from.promo_ends, from.min_payment_cents, from.sale_costs_cents, from.cash_role, from.plaid_subtype, from.escrow_cents, from.payment_key, intoId)
    for (const table of ['bucket_rules', 'contributions', 'valuations', 'recorded_flows']) db.prepare(`UPDATE ${table} SET account_id = ? WHERE account_id = ?`).run(intoId, fromId)
    db.prepare('UPDATE accounts SET linked_asset_id = ? WHERE linked_asset_id = ? AND id != ?').run(intoId, fromId, intoId)
    db.prepare('INSERT OR IGNORE INTO flows_known_from (account_id, day) SELECT ?, day FROM flows_known_from WHERE account_id = ?').run(intoId, fromId)
    db.prepare('INSERT OR IGNORE INTO goal_accounts (goal_id, account_id) SELECT goal_id, ? FROM goal_accounts WHERE account_id = ?').run(intoId, fromId)

    const merged = mergedAccounts()
    for (const [k, v] of Object.entries(merged)) if (v === fromId) merged[k] = intoId
    merged[fromId] = intoId
    setSetting(MERGED_KEY, JSON.stringify(merged))
    deleteAccount(fromId)
    // The kept account can be in the old one's venture now, with its rules, and holds the old one's lines:
    // the rules run again, so every line on it is where they put it.
    applyBucketRules()
    return result
  })
}

/** Inserts a row as a journal kept it, with only the table's own columns. */
function insertRow(table: string, row: Row): void {
  const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
  const keys = Object.keys(row).filter((k) => cols.has(k))
  db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]))
}

/** Puts both accounts back as they were before a merge. Rows synced to the kept account since then stay. */
export function undoAccountMerge(s: MergeSnapshot): void {
  inTransaction(() => {
    const fromId = s.from.id as string
    const intoId = s.into.id as string
    insertRow('accounts', s.from)
    // The old account's splits and tags went to the rows they matched; clear both sides and put back what was kept.
    for (const t of [...s.fromTxns, ...s.intoTxns]) {
      db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(t.id)
      db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(t.id)
    }
    for (const t of s.fromTxns) insertRow('transactions', t)
    const cols = Object.keys(s.intoTxns[0] ?? {}).filter((k) => k !== 'id')
    for (const t of s.intoTxns) {
      if (!get('SELECT 1 FROM transactions WHERE id = ?', t.id)) continue
      db.prepare(`UPDATE transactions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => t[c]), t.id)
    }
    for (const r of s.splits) if (get('SELECT 1 FROM transactions WHERE id = ?', r.transaction_id)) insertRow('transaction_splits', r)
    for (const r of s.tags) if (get('SELECT 1 FROM transactions WHERE id = ?', r.transaction_id)) insertRow('transaction_tags', r)
    // The intents with a venture go back to the rows they were on.
    if (s.ventureMoney) {
      for (const t of [...s.fromTxns, ...s.intoTxns]) db.prepare('DELETE FROM venture_money WHERE txn_id = ?').run(t.id)
      for (const r of s.ventureMoney) if (get('SELECT 1 FROM transactions WHERE id = ?', r.txn_id)) insertRow('venture_money', r)
    }
    for (const p of s.fromPoints) {
      db.prepare('DELETE FROM balance_snapshots WHERE account_id = ? AND day = ?').run(intoId, p.day)
      insertRow('balance_snapshots', p)
    }
    for (const p of s.intoPoints) insertRow('balance_snapshots', p)
    // A merge recorded before an account had a column (cash_role, escrow_cents) leaves that column as it is.
    const fields = ['name', 'opened_day', 'asset_type', 'cost_cents', 'linked_asset_id', 'details', 'bucket_id', 'apr', 'promo_apr', 'promo_ends', 'min_payment_cents', 'sale_costs_cents', 'cash_role', 'plaid_subtype', 'escrow_cents', 'payment_key'].filter((c) => c in s.into)
    db.prepare(`UPDATE accounts SET ${fields.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((c) => s.into[c]), intoId)
    for (const id of s.refs.linked) db.prepare('UPDATE accounts SET linked_asset_id = ? WHERE id = ?').run(fromId, id)
    for (const table of ['bucket_rules', 'contributions', 'valuations', 'recorded_flows'] as const) {
      for (const id of s.refs[table]) db.prepare(`UPDATE ${table} SET account_id = ? WHERE id = ?`).run(fromId, id)
    }
    db.prepare('DELETE FROM flows_known_from WHERE account_id = ?').run(intoId)
    for (const r of [s.fromFlowsKnown, s.intoFlowsKnown]) if (r) insertRow('flows_known_from', r)
    for (const g of s.fromGoals) {
      insertRow('goal_accounts', { goal_id: g, account_id: fromId })
      if (!s.intoGoals.includes(g)) db.prepare('DELETE FROM goal_accounts WHERE goal_id = ? AND account_id = ?').run(g, intoId)
    }
    for (const h of s.holdings) insertRow('holdings', h)
    setSetting(MERGED_KEY, s.merged)
    // Lines the merge's rules moved go back with the rules and the venture each account had.
    applyBucketRules()
  })
}

// ---------- documents ----------

/** Documents the assistant has gone through, by file name. */
export function documentRecords(): Map<string, { size: number; summary: string | null; processedAt: number }> {
  const rows = db.prepare('SELECT name, size, summary, processed_at FROM documents').all() as Array<{ name: string; size: number; summary: string | null; processed_at: number }>
  return new Map(rows.map((r) => [r.name, { size: r.size, summary: r.summary, processedAt: r.processed_at }]))
}

export function markDocument(name: string, size: number, summary: string | null): void {
  db.prepare(`
    INSERT INTO documents (name, size, summary, processed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET size = excluded.size, summary = excluded.summary, processed_at = excluded.processed_at
  `).run(name, size, summary, now())
}

/** Forgets that a document was gone through (it shows as new again). */
export function deleteDocumentRecord(name: string): void {
  db.prepare('DELETE FROM documents WHERE name = ?').run(name)
}

/** An account's stored balance and its date as they are (for a journal). */
export function accountBalanceRaw(id: string): { balanceCents: number | null; balanceDate: number | null } {
  const r = get<{ balance_cents: number | null; balance_date: number | null }>('SELECT balance_cents, balance_date FROM accounts WHERE id = ?', id)
  return { balanceCents: r?.balance_cents ?? null, balanceDate: r?.balance_date ?? null }
}

/** Puts an account's stored balance back exactly as a journal recorded it. */
export function restoreAccountBalanceRaw(id: string, b: { balanceCents: number | null; balanceDate: number | null }): void {
  db.prepare('UPDATE accounts SET balance_cents = ?, balance_date = ? WHERE id = ?').run(b.balanceCents, b.balanceDate, id)
  refreshManualBalance(id)
}

export function deleteAccountsBySource(source: Account['source']): void {
  db.prepare('DELETE FROM accounts WHERE source = ?').run(source)
}

// ---------- transactions ----------

export interface TxnInput {
  id: string
  accountId: string
  posted: number
  amountCents: number
  description: string
  pending: boolean
}

/** A transaction as it's stored: a bounded amount, a sane date and a cleaned, capped description. */
function checkTxn(t: TxnInput): TxnInput {
  checkCents(t.amountCents)
  if (!Number.isSafeInteger(t.posted) || t.posted < 0 || t.posted > 4_102_444_800) throw new Error('Invalid date')
  const description = cleanText(t.description, DESCRIPTION_MAX) || '(no description)'
  return { ...t, description }
}

/** Inserts or refreshes a transaction, preserving its category. Returns true if it was new. */
export function upsertTransaction(input: TxnInput): boolean {
  const t = checkTxn(input)
  const exists = db.prepare('SELECT amount_cents, desc_key, category_source FROM transactions WHERE id = ?').get(t.id) as { amount_cents: number; desc_key: string; category_source: string | null } | undefined
  if (exists && exists.amount_cents !== t.amountCents) refitSplit(t.id, exists.amount_cents, t.amountCents)
  db.prepare(`
    INSERT INTO transactions (id, account_id, posted, amount_cents, description, desc_key, pending, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      posted = excluded.posted,
      amount_cents = excluded.amount_cents,
      description = excluded.description,
      desc_key = excluded.desc_key,
      pending = excluded.pending
  `).run(t.id, t.accountId, t.posted, t.amountCents, t.description, descKey(t.description), t.pending ? 1 : 0, now())
  // A pending row the bank posts under new text (a raw ACH line becoming "NORTHWIND CORP PAYROLL")
  // takes what its earlier payments had, rather than keeping Claude's guess at the raw text.
  const key = descKey(t.description)
  if (exists?.category_source === 'ai' && exists.desc_key !== key) {
    const seen = findHistoryMatch(key, t.amountCents, t.id)
    if (seen) setTransactionFields(t.id, { categoryId: seen.categoryId, source: seen.source === 'ai' ? 'ai' : 'rule', confidence: seen.confidence, merchant: seen.merchant })
  }
  return !exists
}

/** Inserts only if the id is unseen (CSV re-imports). Returns true if inserted. */
export function insertTransactionIfNew(input: TxnInput): boolean {
  const t = checkTxn(input)
  const r = db.prepare(`
    INSERT OR IGNORE INTO transactions (id, account_id, posted, amount_cents, description, desc_key, pending, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.id, t.accountId, t.posted, t.amountCents, t.description, descKey(t.description), t.pending ? 1 : 0, now())
  return Number(r.changes) > 0
}

/** Whether a transaction can be deleted by hand: one the user imported or entered, not a bank-synced row (it would come back on the next sync). */
export const isDeletableTransaction = (id: string): boolean => !(id.startsWith('sf:') || id.startsWith('plaid:')) || id.includes(':csv:')

/** Rows the bank says are gone (a pending charge that posted under a new id, or one voided). */
export function removeBankRows(ids: string[]): number {
  const del = db.prepare("DELETE FROM transactions WHERE id = ? AND id LIKE 'plaid:%'")
  let n = 0
  for (const id of ids) n += Number(del.run(id).changes)
  return n
}

/** A pending row that posted under a new id: the posted one keeps what was set on the pending one (its category, name, note, venture, asset, one-off). */
export function carryPending(fromId: string, toId: string): void {
  const p = db.prepare('SELECT category_id, category_source, confidence, merchant, notes, bucket_id, bucket_source, asset_id, asset_source, one_time FROM transactions WHERE id = ?').get(fromId) as Record<string, SQLInputValue> | undefined
  if (!p) return
  db.prepare(`
    UPDATE transactions SET
      category_id = COALESCE(category_id, ?), category_source = CASE WHEN category_id IS NULL THEN ? ELSE category_source END,
      confidence = CASE WHEN category_id IS NULL THEN ? ELSE confidence END,
      merchant = COALESCE(merchant, ?), notes = COALESCE(notes, ?),
      bucket_id = COALESCE(bucket_id, ?), bucket_source = COALESCE(bucket_source, ?),
      asset_id = CASE WHEN asset_source IS NULL THEN ? ELSE asset_id END, asset_source = COALESCE(asset_source, ?), one_time = MAX(one_time, ?)
    WHERE id = ?
  `).run(p.category_id, p.category_source, p.confidence, p.merchant, p.notes, p.bucket_id, p.bucket_source, p.asset_id, p.asset_source, p.one_time ?? 0, toId)
}

/** Removes an imported or manual transaction; returns the row as it was, or null. */
export function deleteTransaction(id: string): Transaction | null {
  const t = getTransaction(id)
  if (!t) return null
  if (!isDeletableTransaction(id)) throw new Error('A bank-synced transaction can\'t be deleted; it would come back on the next sync')
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id)
  return t
}

/** Drops pending rows in a window that the bank no longer reports (they posted under a new id or were voided). */
export function prunePending(accountId: string, from: number, to: number, keepIds: Set<string>): void {
  const rows = db.prepare('SELECT id FROM transactions WHERE account_id = ? AND pending = 1 AND posted >= ? AND posted < ?').all(accountId, from, to) as Array<{ id: string }>
  const del = db.prepare('DELETE FROM transactions WHERE id = ?')
  for (const r of rows) if (!keepIds.has(r.id)) del.run(r.id)
}

const TXN_SELECT = `
  SELECT t.id, t.account_id, a.name AS account_name, t.posted, t.amount_cents, t.description, t.merchant,
         t.category_id, t.category_source, t.confidence, t.pending, t.notes, t.bucket_id, t.one_time
  FROM transactions t JOIN accounts a ON a.id = t.account_id
`

function toTxn(r: Record<string, SQLInputValue>): Transaction {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    accountName: r.account_name as string,
    posted: r.posted as number,
    amountCents: r.amount_cents as number,
    description: r.description as string,
    merchant: (r.merchant as string | null) ?? null,
    categoryId: (r.category_id as number | null) ?? null,
    categorySource: (r.category_source as CategorySource | null) ?? null,
    confidence: (r.confidence as Confidence | null) ?? null,
    pending: r.pending === 1,
    notes: (r.notes as string | null) ?? null,
    bucketId: (r.bucket_id as number | null) ?? null,
    oneTime: r.one_time === 1,
    splits: [],
    tags: []
  }
}

/** Fills in each transaction's split parts and tags; `all` reads the whole tables instead of the rows' ids. */
function withParts(rows: Transaction[], all = false): Transaction[] {
  if (!rows.length) return rows
  const byId = new Map(rows.map((t) => [t.id, t]))
  const ids = [...byId.keys()]
  const chunks = all ? [null] : Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, i * 500 + 500))
  for (const chunk of chunks) {
    const where = chunk ? ` WHERE transaction_id IN (${chunk.map(() => '?').join(',')})` : ''
    const args = chunk ?? []
    const splits = db.prepare(`SELECT ${PART_COLS}${where.replace('transaction_id', 's.transaction_id')} ORDER BY s.position, s.id`).all(...args) as Array<Record<string, SQLInputValue>>
    for (const s of splits) byId.get(s.transaction_id as string)?.splits.push(toSplit(s))
    const tags = db.prepare(`SELECT transaction_id, label FROM transaction_tags${where} ORDER BY created_at, rowid`).all(...args) as Array<{ transaction_id: string; label: string }>
    for (const g of tags) byId.get(g.transaction_id)?.tags.push(g.label)
  }
  return rows
}

export function listTransactions(q: TxnQuery): TxnPage {
  const where: string[] = []
  const params: SQLInputValue[] = []
  if (q.search?.trim()) {
    const like = `%${q.search.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`
    where.push(`(t.description LIKE ? ESCAPE '\\' OR t.merchant LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')`)
    params.push(like, like, like)
  }
  if (q.accountId) {
    where.push('t.account_id = ?')
    params.push(q.accountId)
  }
  if (q.categoryId === 'none') where.push('t.category_id IS NULL')
  else if (typeof q.categoryId === 'number') {
    where.push('t.category_id = ?')
    params.push(q.categoryId)
  }
  if (q.bucketId === 'personal') where.push(personalClause())
  else if (typeof q.bucketId === 'number') {
    where.push('t.bucket_id = ?')
    params.push(q.bucketId)
  }
  if (q.from !== undefined) {
    where.push('t.posted >= ?')
    params.push(q.from)
  }
  if (q.to !== undefined) {
    where.push('t.posted < ?')
    params.push(q.to)
  }
  if (q.tag?.trim()) {
    where.push('EXISTS (SELECT 1 FROM transaction_tags g WHERE g.transaction_id = t.id AND g.tag = ?)')
    params.push(tagKey(q.tag))
  }
  // The transactions named, as one parameter, so a long list is one statement; none named is none listed.
  if (Array.isArray(q.ids)) {
    where.push('t.id IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(q.ids.map(String)))
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000)
  const offset = Math.max(q.offset ?? 0, 0)
  // A category or venture filter looks at each part of a split transaction, and the sum is of the parts it matches.
  const byLine = q.categoryId !== undefined || q.bucketId !== undefined
  const rows = db.prepare(`${TXN_SELECT} ${byLine ? `WHERE t.id IN (SELECT t.id FROM ${TXN_LINES} t ${whereSql})` : whereSql} ORDER BY t.posted DESC, t.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, SQLInputValue>>
  const agg = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n, COALESCE(SUM(t.amount_cents), 0) AS s FROM ${byLine ? TXN_LINES : 'transactions'} t ${whereSql}`).get(...params) as { n: number; s: number }
  return { rows: withParts(rows.map(toTxn)), total: agg.n, sumCents: agg.s }
}

export function getTransaction(id: string): Transaction | null {
  const r = db.prepare(`${TXN_SELECT} WHERE t.id = ?`).get(id) as Record<string, SQLInputValue> | undefined
  return r ? withParts([toTxn(r)])[0] : null
}

export function getDescKey(id: string): string | null {
  const r = db.prepare('SELECT desc_key FROM transactions WHERE id = ?').get(id) as { desc_key: string } | undefined
  return r?.desc_key ?? null
}

export function setTransactionFields(
  id: string,
  f: { categoryId?: number | null; source?: CategorySource | null; confidence?: Confidence | null; merchant?: string | null; notes?: string | null; description?: string }
): void {
  const sets: string[] = []
  const params: SQLInputValue[] = []
  if (f.description !== undefined) {
    const d = cleanText(f.description, DESCRIPTION_MAX)
    if (!d) throw new Error('A description cannot be empty')
    sets.push('description = ?', 'desc_key = ?')
    params.push(d, descKey(d))
  }
  if (f.categoryId !== undefined) {
    sets.push('category_id = ?', 'category_source = ?', 'confidence = ?')
    params.push(f.categoryId, f.categoryId === null ? null : (f.source ?? null), f.confidence ?? null)
  }
  if (f.merchant !== undefined) {
    sets.push('merchant = ?')
    params.push(f.merchant ? cleanText(f.merchant, MERCHANT_MAX) || null : null)
  }
  if (f.notes !== undefined) {
    sets.push('notes = ?')
    params.push(f.notes ? cleanText(f.notes, NOTES_MAX) || null : null)
  }
  if (!sets.length) return
  // A category from a rule or Claude never replaces one the user set (or set through the review assistant), even one set while Claude was still answering, nor touches a split transaction.
  const guard = f.categoryId !== undefined && !OWN_SOURCES.includes(f.source ?? 'ai') ? ` AND ${NOT_USER_CATEGORY} AND NOT ${splitOf('transactions.id')}` : ''
  db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?${guard}`).run(...params, id)
}

/** Sources that count as the user's own decision: set by hand, or by the review assistant on the user's say-so. */
const OWN_SOURCES: Array<CategorySource | null> = ['user', 'assistant']

/** SQL condition for a transaction whose category wasn't set by the user (and so may be set automatically). */
export const NOT_USER_CATEGORY = "(category_source IS NULL OR category_source IN ('ai', 'rule'))"

/** The transactions a new rule would change right now (rows the user didn't set by hand, matched, in another category); a pattern the rule couldn't have throws. */
export function ruleMatches(field: RuleField, pattern: string, categoryId: number): string[] {
  const p = checkPattern(field, pattern)
  const rule: Rule = { id: 0, field, pattern: p, categoryId, categoryName: '', createdAt: 0 }
  const rows = db.prepare(`SELECT id, merchant, desc_key, description, category_id FROM transactions t WHERE ${NOT_USER_CATEGORY} AND ${NOT_SPLIT}`).all() as Array<Record<string, SQLInputValue>>
  const out: string[] = []
  for (const r of rows) {
    if (r.category_id !== categoryId && matchRule([rule], { merchant: r.merchant as string | null, descKey: r.desc_key as string, description: r.description as string })) out.push(r.id as string)
  }
  return out
}

export const countRuleMatches = (field: RuleField, pattern: string, categoryId: number): number => ruleMatches(field, pattern, categoryId).length

/** The rule with this field and pattern as it is (for a journal), or null. */
export function ruleFor(field: RuleField, pattern: string): Rule | null {
  return listRules().find((r) => r.field === field && r.pattern === pattern.trim().toLowerCase()) ?? null
}

/** The category fields of transactions, as they are (for a journal). */
export function categoryFields(ids: string[]): Array<{ id: string; categoryId: number | null; source: CategorySource | null; confidence: Confidence | null; merchant: string | null }> {
  return ids.flatMap((id) => {
    const t = getTransaction(id)
    return t ? [{ id, categoryId: t.categoryId, source: t.categorySource, confidence: t.confidence, merchant: t.merchant }] : []
  })
}

/** Puts category fields back exactly as a journal recorded them (an undo), whatever guard would apply. */
export function restoreCategoryFields(rows: ReturnType<typeof categoryFields>): void {
  const stmt = db.prepare('UPDATE transactions SET category_id = ?, category_source = ?, confidence = ?, merchant = ? WHERE id = ?')
  inTransaction(() => {
    for (const r of rows) stmt.run(r.categoryId, r.source, r.confidence, r.merchant, r.id)
  })
}

/** Transactions that still need a category (never overwrites a user's choice; a split transaction's parts have theirs). */
export function listUncategorized(includeAi: boolean): Array<{ id: string; description: string; descKey: string; amountCents: number; accountName: string; merchant: string | null }> {
  const cond = includeAi ? "(t.category_id IS NULL OR t.category_source = 'ai')" : 't.category_id IS NULL'
  const rows = db.prepare(`
    SELECT t.id, t.description, t.desc_key, t.amount_cents, a.name AS account_name, t.merchant
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE ${cond} AND ${NOT_SPLIT} ORDER BY t.posted DESC
  `).all() as Array<Record<string, SQLInputValue>>
  return rows.map((r) => ({
    id: r.id as string,
    description: r.description as string,
    descKey: r.desc_key as string,
    amountCents: r.amount_cents as number,
    accountName: r.account_name as string,
    merchant: (r.merchant as string | null) ?? null
  }))
}

/** Most recent categorized transaction with this description key that isn't in the given set. */
export function findHistoryMatch(key: string, sign: number, exceptId = ''): { merchant: string | null; categoryId: number; source: CategorySource; confidence: Confidence | null } | null {
  if (!key) return null
  const r = db.prepare(`
    SELECT merchant, category_id, category_source, confidence FROM transactions
    WHERE desc_key = ? AND id != ? AND category_id IS NOT NULL AND category_source IS NOT NULL
      AND ((amount_cents < 0) = (? < 0)) AND NOT ${splitOf('transactions.id')}
    ORDER BY CASE category_source WHEN 'user' THEN 0 WHEN 'assistant' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END, posted DESC
    LIMIT 1
  `).get(key, exceptId, sign) as Record<string, SQLInputValue> | undefined
  if (!r) return null
  return {
    merchant: (r.merchant as string | null) ?? null,
    categoryId: r.category_id as number,
    source: r.category_source as CategorySource,
    confidence: (r.confidence as Confidence | null) ?? null
  }
}

// ---------- rules ----------

export function listRules(): Rule[] {
  const rows = db.prepare(`
    SELECT r.id, r.field, r.pattern, r.category_id, c.name AS category_name, r.created_at
    FROM rules r JOIN categories c ON c.id = r.category_id ORDER BY r.created_at DESC
  `).all() as Array<Record<string, SQLInputValue>>
  return rows.map((r) => ({
    id: r.id as number,
    field: r.field as RuleField,
    pattern: r.pattern as string,
    categoryId: r.category_id as number,
    categoryName: r.category_name as string,
    createdAt: r.created_at as number
  }))
}

/** Shortest text a "contains" rule may match: one or two characters would rewrite nearly everything. */
export const CONTAINS_MIN = 3

/** A rule's pattern as stored; throws when it's empty or, for "contains", too short to be safe. */
function checkPattern(field: RuleField, pattern: string): string {
  const p = pattern.trim().toLowerCase()
  if (!p) throw new Error('Rule pattern is required')
  if (field === 'contains' && p.replace(/\s/g, '').length < CONTAINS_MIN) throw new Error(`A "contains" rule needs at least ${CONTAINS_MIN} characters`)
  return p
}

export function upsertRule(field: RuleField, pattern: string, categoryId: number): number {
  const p = checkPattern(field, pattern)
  db.prepare(`
    INSERT INTO rules (field, pattern, category_id, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(field, pattern) DO UPDATE SET category_id = excluded.category_id, created_at = excluded.created_at
  `).run(field, p, categoryId, now())
  return (db.prepare('SELECT id FROM rules WHERE field = ? AND pattern = ?').get(field, p) as { id: number }).id
}

export function deleteRule(id: number): void {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id)
}

/** Finds the rule that applies to a transaction. Merchant rules beat exact-key rules beat "contains" rules. */
/**
 * A name for a row a rule categorized: what the named payments the same rule matches, the same way
 * in or out, are called. Only when they all share one name; a rule like "venmo payment" covers many
 * payees, and none of theirs belongs on the row.
 */
export function ruleMerchant(rule: Rule, sign: number, exceptId = ''): string | null {
  const where = rule.field === 'key' ? 'desc_key = ?' : rule.field === 'contains' ? 'instr(lower(description), ?) > 0' : 'lower(trim(merchant)) = ?'
  const names = all<{ merchant: string }>(
    `SELECT DISTINCT merchant FROM transactions WHERE merchant IS NOT NULL AND id != ? AND ((amount_cents < 0) = (? < 0)) AND ${where} LIMIT 2`,
    exceptId,
    sign,
    rule.pattern
  )
  return names.length === 1 ? names[0].merchant : null
}

export function matchRule(rules: Rule[], t: { merchant: string | null; descKey: string; description: string }): Rule | null {
  const merchant = t.merchant?.toLowerCase().trim()
  const desc = t.description.toLowerCase()
  return (
    (merchant && rules.find((r) => r.field === 'merchant' && r.pattern === merchant)) ||
    rules.find((r) => r.field === 'key' && r.pattern === t.descKey) ||
    rules.find((r) => r.field === 'contains' && desc.includes(r.pattern)) ||
    null
  )
}

/**
 * Applies rules to every transaction the user hasn't set by hand; a split
 * transaction keeps its parts. Returns how many rows changed.
 */
export function applyRulesToAll(): number {
  const rules = listRules()
  if (!rules.length) return 0
  const rows = db.prepare(`SELECT id, merchant, desc_key, description, category_id FROM transactions t WHERE ${NOT_USER_CATEGORY} AND ${NOT_SPLIT}`).all() as Array<Record<string, SQLInputValue>>
  const update = db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'rule', confidence = NULL WHERE id = ? AND ${NOT_USER_CATEGORY} AND NOT ${splitOf('transactions.id')}`)
  let changed = 0
  inTransaction(() => {
    for (const r of rows) {
      const rule = matchRule(rules, { merchant: r.merchant as string | null, descKey: r.desc_key as string, description: r.description as string })
      if (rule && rule.categoryId !== r.category_id) {
        update.run(rule.categoryId, r.id as string)
        changed++
      }
    }
  })
  return changed
}

// ---------- buckets ----------

const BUCKET_KINDS: BucketKind[] = ['rental', 'business', 'person', 'other']

// Personal's totals read the classifier (lines.ts, summary.ts), which gives Personal its part of every line: its
// own, and its use share of a place's costs a venture holds or shares (rooms rented while living there, a home later
// rented out). What's left of Personal in SQL is the transactions list's filter: money in no venture, and, for a
// venture whose residence dates aren't Personal's use of a house yet (it has no house: the legacy clause), its costs
// in those dates, though its income (a roommate's rent) stays with it alone.
const residenceCost = (): string => {
  const day = `date(${localSql('t.posted')})`
  const dated = `EXISTS (SELECT 1 FROM buckets rb WHERE rb.id = t.bucket_id AND rb.residence_from IS NOT NULL${upToDate() ? ' AND rb.residence_converted = 0' : ''}
    AND ${day} BETWEEN rb.residence_from AND COALESCE(rb.residence_to, '9999-12-31'))`
  const notIncome = "NOT EXISTS (SELECT 1 FROM categories rc WHERE rc.id = t.category_id AND rc.kind = 'income')"
  return `(${dated} AND ${notIncome})`
}

/** SQL condition on `t` for money in no venture, plus a venture's costs in residence dates no use has replaced (the legacy clause). */
export const personalClause = (): string => `(t.bucket_id IS NULL OR ${residenceCost()})`

/**
 * Migration 41 (section 3 of the waterfall spec): each venture's residence dates become Personal's whole use of its
 * house over those days, so its costs then are Personal's by use, as the classifier shares an asset's costs, and no
 * longer by the dates. The costs in those dates that the venture's rules or a hand put in it are put on its house
 * (source migrated), so one placed in it by hand is shared by the use too: a payment on a loan linked to one of its
 * houses on that house, and any other on the first it held that day (the earliest bought), else on the home, the
 * first it held in the dates. A house sold before the dates or bought after them was never the home then. Its income,
 * its transfers but loan payments, and a line already put on an asset by hand stay as they are. Each house a line
 * goes to or a hand put one on, and the home, gets a use of 100% Personal over the dates' days no use of it covers
 * already. A venture with no house keeps its dates until one is put in it, then converts the next time the books open
 * (migrate). Returns how many converted.
 */
export function convertResidences(): number {
  const ventures = all<{ id: number; from: string; to: string | null }>(`
    SELECT b.id, b.residence_from AS "from", b.residence_to AS "to" FROM buckets b
    WHERE b.residence_from IS NOT NULL AND b.residence_converted = 0 AND EXISTS (SELECT 1 FROM accounts h WHERE h.bucket_id = b.id AND h.asset_type = 'property')
    ORDER BY b.id`)
  if (!ventures.length) return 0
  const legs = transferPairs('0000-01-01', '9999-12-31').pairOf
  inTransaction(() => {
    for (const v of ventures) convertResidence(v, legs)
  })
  return ventures.length
}

function convertResidence(v: { id: number; from: string; to: string | null }, legs: Map<string, TransferLeg>): void {
  const owned = all<{ id: string; opened: string | null; closed: string | null }>(
    "SELECT id, opened_day AS opened, closed_day AS closed FROM accounts WHERE bucket_id = ? AND asset_type = 'property' ORDER BY COALESCE(opened_day, '9999-12-31'), created_at, id",
    v.id
  )
  const houses = owned.map((h) => h.id)
  /** The first house bought that the venture held on a day from one day to another, if it held one then. */
  const heldIn = (from: string, to: string | null): string | undefined => owned.find((h) => (!h.opened || h.opened <= (to ?? '9999-12-31')) && (!h.closed || h.closed >= from))?.id
  const home = heldIn(v.from, v.to) ?? houses[0]
  // The loans on its houses, by their own account (a transfer's other leg) and by the payee key of their payments.
  const loans = all<{ id: string; asset: string; key: string | null }>(
    `SELECT id, linked_asset_id AS asset, payment_key AS key FROM accounts WHERE asset_type IN ('loan', 'mortgage', 'other_debt') AND linked_asset_id IN (${houses.map(() => '?').join(',')})`,
    ...houses
  )
  const byAccount = new Map(loans.map((l) => [l.id, l.asset]))
  const byKey = new Map(loans.filter((l) => l.key).map((l) => [l.key!, l.asset]))
  const lines = all<{ id: string; day: string; merchant: string | null; descKey: string; cents: number; transfer: number | null; assetId: string | null; assetSource: string | null }>(
    `SELECT t.id, date(${localSql('t.posted')}) AS day, t.merchant, t.desc_key AS descKey, t.amount_cents AS cents, c.kind = 'transfer' AS transfer, t.asset_id AS assetId, t.asset_source AS assetSource
     FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
     WHERE COALESCE(t.bucket_id, CASE WHEN t.bucket_source IN ('user', 'ai') THEN NULL ELSE a.bucket_id END) = ?
       AND date(${localSql('t.posted')}) BETWEEN ? AND COALESCE(?, '9999-12-31')
       AND (c.kind IS NULL OR c.kind <> 'income')
     ORDER BY t.posted, t.id`,
    v.id,
    v.from,
    v.to
  )
  const attach = db.prepare("UPDATE transactions SET asset_id = ?, asset_source = 'migrated' WHERE id = ?")
  const used = new Set([home])
  for (const l of lines) {
    // A line a hand already put on an asset stays there; when that's one of the houses, the house gets the use too.
    if (l.assetSource !== null && l.assetSource !== 'rule') {
      if (l.assetId && houses.includes(l.assetId)) used.add(l.assetId)
      continue
    }
    const leg = legs.get(l.id)
    const loan = (leg ? byAccount.get(leg.accountId) : undefined) ?? (l.cents < 0 ? byKey.get(payeeKey(l)) : undefined)
    // A transfer is money moved, not a cost, unless it pays one of the houses' loans.
    if (l.transfer === 1 && !loan) continue
    const house = loan ?? heldIn(l.day, l.day) ?? home
    attach.run(house, l.id)
    used.add(house)
  }
  const insert = db.prepare("INSERT INTO asset_uses (asset_id, from_day, to_day, bucket_id, share_bp, basis, source, created_at) VALUES (?, ?, ?, NULL, 10000, NULL, 'migrated', ?)")
  for (const house of used) for (const [from, to] of uncovered(house, v.from, v.to)) insert.run(house, from, to, now())
  db.prepare('UPDATE buckets SET residence_converted = 1 WHERE id = ?').run(v.id)
}

/** The days from one day to another (null: on from then) that no use of an asset covers, as spans (null: on from then). */
function uncovered(assetId: string, from: string, to: string | null): Array<[string, string | null]> {
  const END = '9999-12-31'
  const last = to ?? END
  const out: Array<[string, string | null]> = []
  let start: string | null = from
  for (const u of all<{ from: string; to: string | null }>('SELECT DISTINCT from_day AS "from", to_day AS "to" FROM asset_uses WHERE asset_id = ? ORDER BY from_day', assetId)) {
    if (start === null || u.from > last) break
    const end = u.to ?? END
    if (end < start) continue
    if (u.from > start) out.push([start, addDays(u.from, -1)])
    start = end >= last ? null : addDays(end, 1)
  }
  if (start !== null) out.push([start, to])
  return out
}

/**
 * SQL condition on `t` for the money a view of ventures alone includes: the lines placed in them, whole, as their
 * books read them. Personal's money, alone or beside ventures, is the classifier's (lines.ts, summary.ts).
 */
export function bucketClause(ids: number[]): string {
  const ventures = ids.filter((n) => Number.isInteger(n) && n > 0)
  if (!ventures.length) throw new Error('Name a venture')
  return `(t.bucket_id IN (${ventures.join(',')}))`
}

// ---------- what net worth reads of a venture (waterfall spec addendum 1.11, sub-phase 1j) ----------

// Personal net worth on a day is the visible Personal accounts (in no venture, not linked to a venture's asset, and
// not a Stakes account linked to a venture) plus every venture's position: the user's claims on it and the stake,
// which is the share of its net assets by its books, or a Stakes account's estimate (ventureMoney.ts). A venture's
// net assets are the accounts it holds and the Personal debts linked to an asset it holds: the accounts net worth
// counted for it until 1j, all of them while in_net_worth was 1. So with every share migrated (100% where it was
// counted, 0% where it wasn't) and no claims, net worth is what it was, to the cent.

/** SQL for the venture an account `a` is in: its own, else its linked asset's (a loan goes with what secures it). */
const VENTURE_OF = '(SELECT b.id FROM buckets b WHERE b.id = COALESCE(a.bucket_id, (SELECT x.bucket_id FROM accounts x WHERE x.id = a.linked_asset_id)))'

/** SQL for a bucket `b`'s share on a day (its one parameter): the row with the latest from_day on or before it, 0 before the first. */
const SHARE_ON = 'COALESCE((SELECT vs.share_bp FROM venture_shares vs WHERE vs.bucket_id = b.id AND vs.from_day <= ? ORDER BY vs.from_day DESC LIMIT 1), 0)'

/** A venture's stored value source and Stakes account, as the stake reads them: an estimate needs the Stakes account. */
export const valueSourceOf = (stored: string | null, stakeAccountId: string | null): 'books' | 'estimate' => (stakeAccountId !== null && stored !== 'books' ? 'estimate' : 'books')

/** One venture as net worth reads it. */
export interface VentureHolding {
  id: number
  name: string
  kind: BucketKind
  /** its share rows, oldest first */
  shares: VentureShare[]
  /** value_source as stored: null is an estimate when a Stakes account is linked, else the books */
  storedSource: 'books' | 'estimate' | null
  valueSource: 'books' | 'estimate'
  /** the visible Personal Stakes account linked to it, when there is one */
  stakeAccountId: string | null
  /** its net assets: the visible accounts it holds, and the visible Personal ones linked to an asset it holds */
  accounts: string[]
  /**
   * the accounts its position reads: its net assets, by the books, once any share row is above 0; the Stakes
   * account by an estimate, or by the books when it holds no account
   */
  reads: string[]
}

/**
 * The visible Personal accounts net worth counts, and each venture as its position reads it, by id. A Stakes account
 * linked to a venture is never one of Personal's: it counts only as that venture's stake, by an estimate.
 */
export function ventureHoldings(): { personal: string[]; ventures: VentureHolding[] } {
  // In the order the accounts were added, as net worth has always read them (the bridge lists its Other items so).
  const accounts = all<{ id: string; own: number | null; venture: number | null }>(`SELECT a.id, a.bucket_id AS own, ${VENTURE_OF} AS venture FROM accounts a WHERE a.hidden = 0 ORDER BY a.rowid`)
  const buckets = all<{ id: number; name: string; kind: BucketKind; value_source: string | null; stake_account_id: string | null }>('SELECT id, name, kind, value_source, stake_account_id FROM buckets ORDER BY id')
  const shares = new Map<number, VentureShare[]>()
  for (const r of ventureShareRows()) shares.set(r.bucketId, [...(shares.get(r.bucketId) ?? []), { fromDay: r.fromDay, shareBp: r.shareBp, source: r.source }])
  // A linked Stakes account is the stake only while it's visible and still Personal's.
  const personal = new Set(accounts.filter((a) => a.own === null).map((a) => a.id))
  const stakes = new Set(buckets.flatMap((b) => (b.stake_account_id !== null && personal.has(b.stake_account_id) ? [b.stake_account_id] : [])))
  const held = new Map<number, string[]>()
  for (const a of accounts) if (a.venture !== null && !stakes.has(a.id)) held.set(a.venture, [...(held.get(a.venture) ?? []), a.id])
  const ventures = buckets.map((b): VentureHolding => {
    const stake = b.stake_account_id !== null && stakes.has(b.stake_account_id) ? b.stake_account_id : null
    const valueSource = valueSourceOf(b.value_source, stake)
    const own = held.get(b.id) ?? []
    const rows = shares.get(b.id) ?? []
    const books = valueSource === 'books' && own.length > 0
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      shares: rows,
      storedSource: b.value_source === 'books' || b.value_source === 'estimate' ? b.value_source : null,
      valueSource,
      stakeAccountId: stake,
      accounts: own,
      reads: books ? (rows.some((s) => s.shareBp > 0) ? own : []) : stake ? [stake] : []
    }
  })
  return { personal: accounts.filter((a) => a.venture === null && !stakes.has(a.id)).map((a) => a.id), ventures }
}

/** Each venture's share rows, oldest first (every venture's with none named). */
export function ventureShareRows(bucketId?: number): Array<VentureShare & { bucketId: number }> {
  const where = bucketId === undefined ? '' : 'WHERE bucket_id = ?'
  return all<{ bucketId: number; fromDay: string; shareBp: number; source: VentureShare['source'] }>(
    `SELECT bucket_id AS bucketId, from_day AS fromDay, share_bp AS shareBp, source FROM venture_shares ${where} ORDER BY bucket_id, from_day`,
    ...(bucketId === undefined ? [] : [bucketId])
  )
}

/** Replaces a venture's share rows with these (an alias of in_net_worth, or an undo putting them back). */
export function replaceVentureShares(bucketId: number, rows: VentureShare[]): void {
  inTransaction(() => {
    db.prepare('DELETE FROM venture_shares WHERE bucket_id = ?').run(bucketId)
    const insert = db.prepare('INSERT INTO venture_shares (bucket_id, from_day, share_bp, source, created_at) VALUES (?, ?, ?, ?, ?)')
    for (const r of rows) insert.run(bucketId, r.fromDay, r.shareBp, r.source, now())
  })
}

/** Writes or replaces a venture's share row on a day; null removes the row there. */
export function setVentureShare(bucketId: number, fromDay: string, shareBp: number | null, source: VentureShare['source']): void {
  if (!get('SELECT 1 FROM buckets WHERE id = ?', bucketId)) throw new Error(`No bucket ${bucketId}`)
  if (shareBp === null) {
    db.prepare('DELETE FROM venture_shares WHERE bucket_id = ? AND from_day = ?').run(bucketId, fromDay)
    return
  }
  if (!Number.isInteger(shareBp) || shareBp < 0 || shareBp > 10000) throw new Error('A share is 0 to 100%')
  db.prepare('INSERT OR REPLACE INTO venture_shares (bucket_id, from_day, share_bp, source, created_at) VALUES (?, ?, ?, ?, ?)').run(bucketId, fromDay, shareBp, source, now())
}

/** A venture's value source and Stakes account, as stored (null source: an estimate when a Stakes account is linked). */
export function ventureValueFields(bucketId: number): { valueSource: 'books' | 'estimate' | null; stakeAccountId: string | null } | null {
  const r = get<{ value_source: string | null; stake_account_id: string | null }>('SELECT value_source, stake_account_id FROM buckets WHERE id = ?', bucketId)
  if (!r) return null
  return { valueSource: r.value_source === 'books' || r.value_source === 'estimate' ? r.value_source : null, stakeAccountId: r.stake_account_id }
}

/**
 * Sets what a venture's stake is valued by. An estimate reads a visible Personal Stakes account (type venture), which
 * then counts only as the stake: it leaves Personal's accounts and the bridge's Revaluation, and no capital line
 * attaches to it. A Stakes account is linked to one venture at most.
 */
export function setVentureValue(bucketId: number, source: 'books' | 'estimate' | null, stakeAccountId: string | null): void {
  if (!get('SELECT 1 FROM buckets WHERE id = ?', bucketId)) throw new Error(`No bucket ${bucketId}`)
  if (stakeAccountId !== null) {
    const a = get<{ asset_type: string | null; bucket_id: number | null; hidden: number; name: string }>('SELECT asset_type, bucket_id, hidden, name FROM accounts WHERE id = ?', stakeAccountId)
    if (!a) throw new Error(`No account ${stakeAccountId}`)
    if (a.asset_type === 'venture' && a.bucket_id !== null && !a.hidden) throw new Error(`${a.name} is in a venture, which counts it as the venture's own money: take it out of the venture first (update_account), then link it`)
    if (a.asset_type !== 'venture' || a.bucket_id !== null || a.hidden) throw new Error(`${a.name} isn't a visible Personal Stakes account`)
    const other = get<{ name: string }>('SELECT name FROM buckets WHERE stake_account_id = ? AND id != ?', stakeAccountId, bucketId)
    if (other) throw new Error(`${a.name} is ${other.name}'s stake already`)
  }
  if (source === 'estimate' && stakeAccountId === null) throw new Error('An estimate needs a Personal Stakes account')
  db.prepare('UPDATE buckets SET value_source = ?, stake_account_id = ? WHERE id = ?').run(source, stakeAccountId, bucketId)
}

/** Puts a venture's value source and Stakes account back exactly as a journal kept them (an undo). */
export function restoreVentureValue(bucketId: number, source: 'books' | 'estimate' | null, stakeAccountId: string | null): void {
  db.prepare('UPDATE buckets SET value_source = ?, stake_account_id = ? WHERE id = ?').run(source, stakeAccountId, bucketId)
}

/** Each Stakes account linked to a venture, by its id: rule 2 reads a leg on one as a leg on its venture's account. */
export function linkedStakes(): Map<string, number> {
  const rows = all<{ a: string; b: number }>('SELECT b.stake_account_id AS a, b.id AS b FROM buckets b JOIN accounts x ON x.id = b.stake_account_id AND x.hidden = 0 AND x.bucket_id IS NULL')
  return new Map(rows.map((r) => [r.a, r.b]))
}

/** A stored intent part as venture_money keeps it, its id and stamp included, for the journal to put back. */
export interface VentureMoneyRow {
  id: number
  txn_id: string
  split_id: number | null
  face: 'line' | 'fund'
  venture_id: number
  intent: string
  cents: number
  interest_cents: number
  regular: number | null
  source: string
  created_at: number
}

/** The intent parts stored on some transactions, in the order they were stored. */
export function ventureMoneyRows(txnIds: string[]): VentureMoneyRow[] {
  if (!txnIds.length) return []
  return all<VentureMoneyRow>(`SELECT * FROM venture_money WHERE txn_id IN (${txnIds.map(() => '?').join(',')}) ORDER BY id`, ...txnIds)
}

/**
 * Replaces the intent parts of one boundary line's face (its own, or its funding's) with these, in order; none
 * removes them, so the line goes back to unset.
 */
export function setVentureMoney(txnId: string, splitId: number | null, face: 'line' | 'fund', parts: Array<Pick<VentureMoneyPart, 'ventureId' | 'intent' | 'cents' | 'interestCents' | 'regular' | 'source'>>): void {
  inTransaction(() => {
    db.prepare('DELETE FROM venture_money WHERE txn_id = ? AND COALESCE(split_id, -1) = ? AND face = ?').run(txnId, splitId ?? -1, face)
    const insert = db.prepare('INSERT INTO venture_money (txn_id, split_id, face, venture_id, intent, cents, interest_cents, regular, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const p of parts) insert.run(txnId, splitId, face, p.ventureId, p.intent, p.cents, p.interestCents, p.regular === null ? null : p.regular ? 1 : 0, p.source, now())
  })
}

/** Puts back some transactions' stored intent parts exactly as a journal kept them (an undo): theirs are replaced. */
export function restoreVentureMoney(txnIds: string[], rows: VentureMoneyRow[]): void {
  inTransaction(() => {
    if (txnIds.length) db.prepare(`DELETE FROM venture_money WHERE txn_id IN (${txnIds.map(() => '?').join(',')})`).run(...txnIds)
    const insert = db.prepare('INSERT INTO venture_money (id, txn_id, split_id, face, venture_id, intent, cents, interest_cents, regular, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const r of rows) insert.run(r.id, r.txn_id, r.split_id, r.face, r.venture_id, r.intent, r.cents, r.interest_cents, r.regular, r.source, r.created_at)
  })
}

/** A remembered answer for one pattern of a venture's boundary lines (venture_money_rules), as stored. */
export interface VentureMoneyRule {
  id: number
  venture_id: number
  shape: 'T' | 'C' | 'F'
  direction: 'out' | 'in'
  payee_key: string | null
  intent: string
  regular: number | null
  created_at: number
}

/** Each remembered answer for a venture's boundary lines, oldest first. */
export function ventureMoneyRules(ventureId: number): VentureMoneyRule[] {
  return all<VentureMoneyRule>('SELECT * FROM venture_money_rules WHERE venture_id = ? ORDER BY id', ventureId)
}

/** Remembers an intent for one pattern of a venture's boundary lines, in place of an answer for the same pattern; returns its id. */
export function rememberVentureMoney(r: Omit<VentureMoneyRule, 'id' | 'created_at'>): number {
  return inTransaction(() => {
    db.prepare('DELETE FROM venture_money_rules WHERE venture_id = ? AND shape = ? AND direction = ? AND COALESCE(payee_key, \'\') = ?').run(r.venture_id, r.shape, r.direction, r.payee_key ?? '')
    const x = db.prepare('INSERT INTO venture_money_rules (venture_id, shape, direction, payee_key, intent, regular, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.venture_id, r.shape, r.direction, r.payee_key, r.intent, r.regular, now())
    return Number(x.lastInsertRowid)
  })
}

/** Puts back a venture's remembered answers exactly as a journal kept them (an undo). */
export function restoreVentureMoneyRules(ventureId: number, rows: VentureMoneyRule[]): void {
  inTransaction(() => {
    db.prepare('DELETE FROM venture_money_rules WHERE venture_id = ?').run(ventureId)
    const insert = db.prepare('INSERT INTO venture_money_rules (id, venture_id, shape, direction, payee_key, intent, regular, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const r of rows) insert.run(r.id, r.venture_id, r.shape, r.direction, r.payee_key, r.intent, r.regular, r.created_at)
  })
}

// A bucket's money in and out is cash flow, leaving out transfers between the user's own accounts.
const NOT_TRANSFER = "(c.kind IS NULL OR c.kind != 'transfer')"
const IN_CENTS = 'COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0)'
const OUT_CENTS = 'COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0)'

/** A bucket's own fields and its cash flow: a venture before its result and its position (ventures.ts adds them). */
export type BucketCash = Omit<Bucket, 'operatingCents' | 'gainsCents' | 'totalCents' | 'positionCents'>

/** A bucket's cash flow by year, category and payee, with its accounts and rules: a venture's detail before its result. */
export type BucketCashDetail = Omit<BucketDetail, 'bucket' | 'result'> & { bucket: BucketCash }

function toBucket(r: Record<string, SQLInputValue>): BucketCash {
  const shareBp = (r.share_today as number | null) ?? 0
  const stakeAccountId = (r.stake_linked as string | null) ?? null
  return {
    id: r.id as number,
    name: r.name as string,
    kind: r.kind as BucketKind,
    description: r.description as string,
    inNetWorth: shareBp > 0,
    shareBp,
    valueSource: valueSourceOf((r.value_source as string | null) ?? null, stakeAccountId),
    stakeAccountId,
    residenceFrom: (r.residence_from as string | null) ?? null,
    residenceTo: (r.residence_to as string | null) ?? null,
    txnCount: (r.txn_count as number | null) ?? 0,
    inCents: (r.in_cents as number | null) ?? 0,
    outCents: (r.out_cents as number | null) ?? 0,
    firstPosted: (r.first_posted as number | null) ?? null,
    lastPosted: (r.last_posted as number | null) ?? null,
    fromDay: null,
    toDay: null
  }
}

/** Every bucket with its money in and out (cash flow, whatever the category); ventures.ts adds each one's result. */
export function listBuckets(): BucketCash[] {
  // A Stakes account linked to a venture is its stake only while it's visible and still Personal's.
  const rows = db.prepare(`
    SELECT b.*, s.txn_count, s.in_cents, s.out_cents, s.first_posted, s.last_posted, ${SHARE_ON} AS share_today,
           (SELECT x.id FROM accounts x WHERE x.id = b.stake_account_id AND x.hidden = 0 AND x.bucket_id IS NULL) AS stake_linked
    FROM buckets b LEFT JOIN (
      SELECT t.bucket_id, COUNT(DISTINCT t.id) AS txn_count, ${IN_CENTS} AS in_cents, ${OUT_CENTS} AS out_cents,
             MIN(t.posted) AS first_posted, MAX(t.posted) AS last_posted
      ${VISIBLE_FROM} WHERE t.bucket_id IS NOT NULL AND t.pending = 0 AND ${NOT_TRANSFER} GROUP BY t.bucket_id
    ) s ON s.bucket_id = b.id
    ORDER BY b.name
  `).all(dayKey(now())) as Array<Record<string, SQLInputValue>>
  // A bucket spans its accounts' and assets' dates (a house from purchase to sale) and its own activity.
  // Something still owned runs to today; a venture written down to nothing ends with its last activity.
  const accounts = db.prepare(`
    SELECT COALESCE(a.bucket_id, l.bucket_id) AS bucket_id, COALESCE(a.opened_day, l.opened_day) AS opened, COALESCE(a.closed_day, l.closed_day) AS closed,
           COALESCE(a.balance_cents, 0) <> 0 AS held
    FROM accounts a LEFT JOIN accounts l ON l.id = a.linked_asset_id
    WHERE COALESCE(a.bucket_id, l.bucket_id) IS NOT NULL
  `).all() as Array<{ bucket_id: number; opened: string | null; closed: string | null; held: number }>
  const today = dayKey(now())
  return rows.map(toBucket).map((b) => {
    const own = accounts.filter((a) => a.bucket_id === b.id)
    const starts = [...own.map((a) => a.opened), b.firstPosted === null ? null : dayKey(b.firstPosted)].filter((d): d is string => !!d)
    const ends = [...own.map((a) => a.closed ?? (a.held ? today : null)), b.lastPosted === null ? null : dayKey(b.lastPosted)].filter((d): d is string => !!d)
    return { ...b, fromDay: starts.length ? starts.sort()[0] : null, toDay: ends.length ? ends.sort().at(-1)! : starts.length ? today : null }
  })
}

export function bucketByName(name: string): BucketCash | undefined {
  return listBuckets().find((b) => b.name.toLowerCase() === name.trim().toLowerCase())
}

/** SQL condition on a bucket rule `r` with no text, amount or dates, as migration 36 read it (rules had no category then). */
const ACCOUNT_ONLY_RULE = 'r.contains IS NULL AND r.amount_cents IS NULL AND r.from_day IS NULL AND r.to_day IS NULL'
/** SQL condition on a bucket rule `r` that puts every line of its account in its venture: no text, amount, dates or category. */
const WHOLE_ACCOUNT_RULE = `${ACCOUNT_ONLY_RULE} AND r.category_id IS NULL`

/**
 * Keeps an account's auto rule in step with the venture that holds it: one for that venture, unless a rule
 * already puts all of its lines there, and none for any other. Returns whether a rule was added or removed.
 */
function syncAutoRule(id: string): boolean {
  const held = get<{ bucket_id: number | null }>('SELECT bucket_id FROM accounts WHERE id = ?', id)?.bucket_id ?? null
  let changed = Number(db.prepare('DELETE FROM bucket_rules WHERE auto = 1 AND account_id = ? AND bucket_id IS NOT ?').run(id, held).changes) > 0
  if (held !== null && !get(`SELECT 1 FROM bucket_rules r WHERE r.account_id = ? AND r.bucket_id = ? AND ${WHOLE_ACCOUNT_RULE}`, id, held)) {
    db.prepare('INSERT INTO bucket_rules (bucket_id, account_id, auto, created_at) VALUES (?, ?, 1, ?)').run(held, id, now())
    changed = true
  }
  return changed
}

/**
 * Puts an account in a venture (null: back in Personal). Its lines then default to the venture by an auto rule
 * (unless a rule already puts all of them there), and the auto rule from a venture it was in goes; the rules are
 * applied again, so its lines move with it. Lines the user or Review placed by hand stay where they were put.
 * Setting the venture it's already in puts back an auto rule that's missing.
 */
function setAccountBucket(id: string, bucketId: number | null): void {
  const was = get<{ bucket_id: number | null }>('SELECT bucket_id FROM accounts WHERE id = ?', id)?.bucket_id ?? null
  const rules = inTransaction(() => {
    if (was !== bucketId) db.prepare('UPDATE accounts SET bucket_id = ? WHERE id = ?').run(bucketId, id)
    return syncAutoRule(id)
  })
  if (was !== bucketId || rules) applyBucketRules()
}

/** The rules, oldest first: a venture's (bucketId), an asset's (assetId), or every one. */
export function listBucketRules(bucketId?: number, assetId?: string): BucketRule[] {
  const where = bucketId !== undefined ? 'WHERE r.bucket_id = ?' : assetId !== undefined ? 'WHERE r.asset_id = ?' : ''
  const rows = db.prepare(`
    SELECT r.id, r.bucket_id, r.asset_id, x.name AS asset_name, r.account_id, a.name AS account_name, r.category_id, c.name AS category_name,
           r.contains, r.amount_cents, r.from_day, r.to_day, r.auto
    FROM bucket_rules r LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts x ON x.id = r.asset_id LEFT JOIN categories c ON c.id = r.category_id
    ${where} ORDER BY r.id
  `).all(...(bucketId !== undefined ? [bucketId] : assetId !== undefined ? [assetId] : [])) as Array<Record<string, SQLInputValue>>
  return rows.map((r) => ({
    id: r.id as number,
    bucketId: (r.bucket_id as number | null) ?? null,
    assetId: (r.asset_id as string | null) ?? null,
    assetName: (r.asset_name as string | null) ?? null,
    accountId: (r.account_id as string | null) ?? null,
    accountName: (r.account_name as string | null) ?? null,
    categoryId: (r.category_id as number | null) ?? null,
    categoryName: (r.category_name as string | null) ?? null,
    contains: (r.contains as string | null) ?? null,
    amountCents: (r.amount_cents as number | null) ?? null,
    fromDay: (r.from_day as string | null) ?? null,
    toDay: (r.to_day as string | null) ?? null,
    auto: r.auto === 1
  }))
}

/** One bucket: in and out by year, by category and by payee, plus its accounts and rules (ventures.ts adds its result). */
export function getBucket(id: number): BucketCashDetail {
  const bucket = listBuckets().find((b) => b.id === id)
  if (!bucket) throw new Error(`No bucket ${id}`)
  const where = `WHERE t.bucket_id = ? AND t.pending = 0 AND ${NOT_TRANSFER}`
  const byYear = db.prepare(`
    SELECT strftime('%Y', ${localSql('t.posted')}) AS year, ${IN_CENTS} AS in_cents, ${OUT_CENTS} AS out_cents
    ${VISIBLE_FROM} ${where} GROUP BY year ORDER BY year
  `).all(id) as Array<{ year: string; in_cents: number; out_cents: number }>
  const byCategory = db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorized') AS name, ${IN_CENTS} AS in_cents, ${OUT_CENTS} AS out_cents, COUNT(DISTINCT t.id) AS count
    ${VISIBLE_FROM} ${where} GROUP BY c.id ORDER BY out_cents + in_cents DESC
  `).all(id) as Array<{ name: string; in_cents: number; out_cents: number; count: number }>
  const topPayees = db.prepare(`
    SELECT COALESCE(t.merchant, t.description) AS name, ${IN_CENTS} AS in_cents, ${OUT_CENTS} AS out_cents, COUNT(DISTINCT t.id) AS count
    ${VISIBLE_FROM} ${where} GROUP BY COALESCE(t.merchant, t.desc_key) ORDER BY out_cents + in_cents DESC LIMIT 12
  `).all(id) as Array<{ name: string; in_cents: number; out_cents: number; count: number }>
  const all = listAccounts()
  const own = new Set(all.filter((a) => a.bucketId === id).map((a) => a.id))
  const accounts = all.filter((a) => own.has(a.id) || (a.linkedAssetId !== null && own.has(a.linkedAssetId)))
  const money = (r: { in_cents: number; out_cents: number }): { inCents: number; outCents: number } => ({ inCents: r.in_cents, outCents: r.out_cents })
  return {
    bucket,
    byYear: byYear.map((r) => ({ year: r.year, ...money(r) })),
    byCategory: byCategory.map((r) => ({ name: r.name, count: r.count, ...money(r) })),
    topPayees: topPayees.map((r) => ({ name: r.name, count: r.count, ...money(r) })),
    accounts,
    rules: listBucketRules(id)
  }
}

/** One line of a venture's settled cash flow, as db.bucketFlows reads it. */
export interface BucketFlow extends Payee {
  bucketId: number
  accountId: string
  day: string
  cents: number
  txnId: string
  splitId: number | null
  /** in an income category */
  income: boolean
  /** in no category */
  uncategorized: boolean
  /** how the line came to be in the venture: 'user' or 'ai' by hand, 'rule' or null by the rules */
  bucketSource: string | null
  /** a split part put in the venture of its own */
  ownBucket: boolean
}

/**
 * The buckets' settled cash flow, line by line (a split's part in its own venture, by its transaction and part), with
 * transfers left out, whether each is in an income category or none, its payee and how it was put in the venture:
 * what their results are worked out from, and what the paycheck clause reads (ventures.ts).
 */
export function bucketFlows(ids: number[]): BucketFlow[] {
  if (!ids.length) return []
  return (
    db.prepare(`
    SELECT t.bucket_id AS bucketId, t.account_id AS accountId, date(${localSql('t.posted')}) AS day, t.amount_cents AS cents, t.id AS txnId, t.split_id AS splitId, c.kind = 'income' AS income,
           t.category_id IS NULL AS uncategorized, t.merchant, t.desc_key AS descKey, t.bucket_source AS bucketSource, COALESCE(s.own_bucket, 0) AS ownBucket
    ${VISIBLE_FROM} LEFT JOIN transaction_splits s ON s.id = t.split_id WHERE t.bucket_id IN (${ids.map(() => '?').join(',')}) AND t.pending = 0 AND ${NOT_TRANSFER}
  `).all(...ids) as Array<Omit<BucketFlow, 'income' | 'uncategorized' | 'ownBucket'> & { income: number | null; uncategorized: number; ownBucket: number }>
  ).map((f) => ({ ...f, income: f.income === 1, uncategorized: f.uncategorized === 1, ownBucket: f.ownBucket === 1 }))
}

export interface BucketInput {
  id?: number
  name: string
  kind: BucketKind
  description?: string
  /**
   * an alias of the share, kept one release: true makes it 100% from 0000-01-01, false 0%, both source migrated.
   * A new venture is 100% unless it's false; an edit changes the share only when it's given.
   */
  inNetWorth?: boolean
  /** YYYY-MM-DD; undefined leaves it as it is, null or '' clears it */
  residenceFrom?: string | null
  residenceTo?: string | null
}

export function saveBucket(b: BucketInput): number {
  const name = b.name.trim()
  if (!name) throw new Error('Bucket name is required')
  if (/^personal$/i.test(name)) throw new Error('"Personal" is everything not in a bucket')
  if (!BUCKET_KINDS.includes(b.kind)) throw new Error(`Bucket kind must be one of ${BUCKET_KINDS.join(', ')}`)
  const old = b.id ? get<{ residence_from: string | null; residence_to: string | null }>('SELECT residence_from, residence_to FROM buckets WHERE id = ?', b.id) : undefined
  if (b.id && !old) throw new Error(`No bucket ${b.id}`)
  const residenceFrom = b.residenceFrom === undefined ? (old?.residence_from ?? null) : checkDay(b.residenceFrom, 'Residence start')
  const residenceTo = b.residenceTo === undefined ? (old?.residence_to ?? null) : checkDay(b.residenceTo, 'Residence end')
  if (residenceTo && !residenceFrom) throw new Error('A residence needs a start date')
  if (residenceFrom && residenceTo && residenceFrom > residenceTo) throw new Error('The residence starts after it ends')
  // in_net_worth stays as the alias last set it, for one release; net worth reads the share rows. Books not yet at
  // migration 43 have none: it makes them from in_net_worth.
  const share = (id: number, counted: boolean): void => {
    if (upToDate()) replaceVentureShares(id, [{ fromDay: '0000-01-01', shareBp: counted ? 10000 : 0, source: 'migrated' }])
  }
  if (b.id) {
    const id = b.id
    inTransaction(() => {
      db.prepare('UPDATE buckets SET name = ?, kind = ?, residence_from = ?, residence_to = ? WHERE id = ?').run(name, b.kind, residenceFrom, residenceTo, id)
      if (b.description !== undefined) db.prepare('UPDATE buckets SET description = ? WHERE id = ?').run(b.description.trim(), id)
      if (b.inNetWorth !== undefined) {
        db.prepare('UPDATE buckets SET in_net_worth = ? WHERE id = ?').run(b.inNetWorth ? 1 : 0, id)
        share(id, b.inNetWorth)
      }
    })
    return id
  }
  return inTransaction(() => {
    const r = db
      .prepare('INSERT INTO buckets (name, kind, description, in_net_worth, residence_from, residence_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, b.kind, b.description?.trim() ?? '', b.inNetWorth === false ? 0 : 1, residenceFrom, residenceTo, now())
    const id = Number(r.lastInsertRowid)
    share(id, b.inNetWorth !== false)
    return id
  })
}

/** Removes a bucket; its transactions and accounts go back to Personal, and its shares, venture money and remembered answers go with it. */
export function deleteBucket(id: number): void {
  inTransaction(() => {
    if (upToDate()) for (const [table, column] of [['venture_money', 'venture_id'], ['venture_shares', 'bucket_id'], ['venture_money_rules', 'venture_id']]) db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id)
    db.prepare('UPDATE transactions SET bucket_id = NULL, bucket_source = NULL WHERE bucket_id = ?').run(id)
    db.prepare('UPDATE accounts SET bucket_id = NULL WHERE bucket_id = ?').run(id)
    // Its share of an asset's use goes to Personal, as its lines do, so the shares on each period's days still add
    // up to 100%: onto Personal's share of the same days, or as Personal's own.
    const same = 'v.asset_id = asset_uses.asset_id AND v.from_day = asset_uses.from_day AND v.to_day IS asset_uses.to_day'
    db.prepare(`UPDATE asset_uses SET share_bp = share_bp + (SELECT v.share_bp FROM asset_uses v WHERE v.bucket_id = ? AND ${same})
      WHERE bucket_id IS NULL AND EXISTS (SELECT 1 FROM asset_uses v WHERE v.bucket_id = ? AND ${same})`).run(id, id)
    db.prepare(`UPDATE asset_uses SET bucket_id = NULL WHERE bucket_id = ? AND NOT EXISTS (SELECT 1 FROM asset_uses v WHERE v.bucket_id IS NULL AND ${same})`).run(id)
    db.prepare('DELETE FROM asset_uses WHERE bucket_id = ?').run(id)
    db.prepare('DELETE FROM buckets WHERE id = ?').run(id)
  })
}

/** Puts transactions in a bucket by hand (null = Personal); rules won't move them after this. */
export function setTransactionsBucket(ids: string[], bucketId: number | null, source: 'user' | 'ai' = 'user'): number {
  if (bucketId !== null && !get('SELECT 1 FROM buckets WHERE id = ?', bucketId)) throw new Error(`No bucket ${bucketId}`)
  const update = db.prepare('UPDATE transactions SET bucket_id = ?, bucket_source = ? WHERE id = ?')
  let n = 0
  inTransaction(() => {
    for (const id of ids) n += Number(update.run(bucketId, source, id).changes)
  })
  return n
}

/** What a rule matches and where it puts the lines: a venture (bucketId) or an asset (assetId), one of the two. */
export interface RuleInput {
  bucketId?: number | null
  assetId?: string | null
  accountId?: string | null
  categoryId?: number | null
  contains?: string | null
  amountCents?: number | null
  fromDay?: string | null
  toDay?: string | null
}

/** Asset types an asset rule or a use can name: what has costs of its own to share. */
export const COSTED_ASSETS: readonly AssetType[] = ['property', 'vehicle', 'other_asset']

export function addBucketRule(r: RuleInput): number {
  const bucketId = r.bucketId ?? null
  const assetId = r.assetId || null
  if ((bucketId === null) === (assetId === null)) throw new Error('A rule puts lines in a venture or on an asset: name one of them')
  if (bucketId !== null && !get('SELECT 1 FROM buckets WHERE id = ?', bucketId)) throw new Error(`No bucket ${bucketId}`)
  if (assetId !== null) {
    const a = get<{ asset_type: string | null }>('SELECT asset_type FROM accounts WHERE id = ?', assetId)
    if (!a) throw new Error(`No account ${assetId}`)
    if (!COSTED_ASSETS.includes(a.asset_type as AssetType)) throw new Error('An asset rule puts lines on a house, a vehicle or another asset')
  }
  const accountId = r.accountId || null
  const categoryId = r.categoryId ?? null
  const contains = r.contains?.trim().toLowerCase() || null
  const amountCents = r.amountCents === undefined || r.amountCents === null ? null : Math.abs(checkCents(Math.round(r.amountCents)))
  if (!accountId && !contains && categoryId === null) throw new Error('A rule needs an account, a category, some text to match, or more than one of them')
  if (contains && contains.replace(/\s/g, '').length < CONTAINS_MIN) throw new Error(`The text to match needs at least ${CONTAINS_MIN} characters`)
  if (accountId && !get('SELECT 1 FROM accounts WHERE id = ?', accountId)) throw new Error(`No account ${accountId}`)
  if (categoryId !== null && !get('SELECT 1 FROM categories WHERE id = ?', categoryId)) throw new Error(`No category ${categoryId}`)
  const fromDay = checkDay(r.fromDay, 'From date')
  const toDay = checkDay(r.toDay, 'To date')
  if (fromDay && toDay && fromDay > toDay) throw new Error('From date is after to date')
  const res = db
    .prepare('INSERT INTO bucket_rules (bucket_id, asset_id, account_id, category_id, contains, amount_cents, from_day, to_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(bucketId, assetId, accountId, categoryId, contains, amountCents, fromDay, toDay, now())
  return Number(res.lastInsertRowid)
}

/**
 * Deletes a rule made on purpose. An auto rule is an account being in its venture: it goes when the account
 * leaves. An account still in its venture keeps its lines there, so its auto rule takes over from a rule that
 * put all of them there. The caller re-applies the rules.
 */
export function deleteBucketRule(id: number): void {
  const r = get<{ account_id: string | null; auto: number; name: string | null }>('SELECT r.account_id, r.auto, a.name FROM bucket_rules r LEFT JOIN accounts a ON a.id = r.account_id WHERE r.id = ?', id)
  if (r?.auto) throw new Error(`Rule ${id} is ${r.name ?? 'an account'} being in its venture; take the account out of the venture to remove it`)
  inTransaction(() => {
    db.prepare('DELETE FROM bucket_rules WHERE id = ?').run(id)
    if (r?.account_id) syncAutoRule(r.account_id)
  })
}

/** A transaction as the rules read it. */
interface RuleRow {
  id: string
  account_id: string
  posted: number
  amount_cents: number
  description: string
  merchant: string | null
  category_id: number | null
  bucket_id: number | null
  bucket_source: string | null
  asset_id: string | null
  asset_source: string | null
  transfer: number | null
}

/** A rule's fields as matching reads them: text in lower case, an amount either way. */
type Matcher = Pick<BucketRule, 'accountId' | 'categoryId' | 'contains' | 'amountCents' | 'fromDay' | 'toDay'>

/** Whether a rule matches a transaction: its account, category, text, exact amount (either way) and dates, each when the rule has it. */
function bucketRuleFits(r: Matcher, t: RuleRow, day: string, text: string): boolean {
  return (
    (!r.accountId || r.accountId === t.account_id) &&
    (r.categoryId === null || r.categoryId === t.category_id) &&
    (!r.contains || text.includes(r.contains)) &&
    (r.amountCents === null || Math.abs(t.amount_cents) === r.amountCents) &&
    (!r.fromDay || day >= r.fromDay) &&
    (!r.toDay || day <= r.toDay)
  )
}

const RULE_ROWS = `SELECT t.id, t.account_id, t.posted, t.amount_cents, t.description, t.merchant, t.category_id, t.bucket_id, t.bucket_source, t.asset_id, t.asset_source,
    c.kind = 'transfer' AS transfer
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id`

/** The transactions a new rule would move right now: rows not placed (or put on an asset) by hand that it matches and that aren't in its venture or on its asset. */
export function bucketRuleMatches(r: RuleInput): string[] {
  const m: Matcher = {
    accountId: r.accountId || null,
    categoryId: r.categoryId ?? null,
    contains: r.contains?.trim().toLowerCase() || null,
    amountCents: r.amountCents == null ? null : Math.abs(Math.round(r.amountCents)),
    fromDay: r.fromDay || null,
    toDay: r.toDay || null
  }
  const asset = r.assetId || null
  const rows = asset
    ? (db.prepare(`${RULE_ROWS} WHERE (t.asset_source IS NULL OR t.asset_source = 'rule') AND t.asset_id IS NOT ?`).all(asset) as unknown as RuleRow[])
    : (db.prepare(`${RULE_ROWS} WHERE (t.bucket_source IS NULL OR t.bucket_source = 'rule') AND t.bucket_id IS NOT ?`).all(r.bucketId ?? null) as unknown as RuleRow[])
  const income = asset ? incomeCategories() : new Set<number>()
  const out: string[] = []
  for (const t of rows) {
    if (t.transfer || (t.category_id !== null && income.has(t.category_id))) continue
    if (bucketRuleFits(m, t, dayKey(t.posted), `${t.description} ${t.merchant ?? ''}`.toLowerCase())) out.push(t.id)
  }
  return out
}

export const countBucketRuleMatches = (r: Parameters<typeof bucketRuleMatches>[0]): number => bucketRuleMatches(r).length

/** Puts a deleted rule back under its old id (an undo); the caller re-applies the rules. */
export function restoreBucketRule(r: BucketRule): void {
  db.prepare('INSERT OR REPLACE INTO bucket_rules (id, bucket_id, asset_id, account_id, category_id, contains, amount_cents, from_day, to_day, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    r.id,
    r.bucketId,
    r.assetId ?? null,
    r.accountId,
    r.categoryId ?? null,
    r.contains,
    r.amountCents,
    r.fromDay,
    r.toDay,
    r.auto ? 1 : 0,
    now()
  )
}

/** The categories that are income, by id: an asset never takes income (rent goes to its venture whole). */
function incomeCategories(): Set<number> {
  return new Set(all<{ id: number }>("SELECT id FROM categories WHERE kind = 'income'").map((c) => c.id))
}

/** The bucket fields of transactions, as they are (for a journal). */
export function bucketFields(ids: string[]): Array<{ id: string; bucketId: number | null; source: string | null }> {
  return ids.flatMap((id) => {
    const r = get<{ bucket_id: number | null; bucket_source: string | null }>('SELECT bucket_id, bucket_source FROM transactions WHERE id = ?', id)
    return r ? [{ id, bucketId: r.bucket_id, source: r.bucket_source }] : []
  })
}

/** Puts bucket fields back exactly as a journal recorded them. */
export function restoreBucketFields(rows: ReturnType<typeof bucketFields>): void {
  const stmt = db.prepare('UPDATE transactions SET bucket_id = ?, bucket_source = ? WHERE id = ?')
  inTransaction(() => {
    for (const r of rows) stmt.run(r.bucketId, r.source, r.id)
  })
}

/**
 * Applies the rules to every transaction, venture rules and asset rules apart, so a line can be in a venture and
 * on an asset at once. Venture rules move the lines not placed in a venture by hand: the newest matching rule
 * wins, and an account's auto rule (its venture's default, which counts only while that venture holds the
 * account) gives way to any rule made on purpose; a transaction a rule no longer matches goes back to Personal.
 * Asset rules put the lines not put on an asset by hand on the newest matching rule's asset, and take a line off
 * when none matches; income never goes on an asset. Transfers between the user's own accounts (card payments)
 * stay Personal and on no asset. Returns how many transactions changed.
 */
export function applyBucketRules(): number {
  const newest = listBucketRules().reverse()
  const held = new Map(all<{ id: string; bucket_id: number }>('SELECT id, bucket_id FROM accounts WHERE bucket_id IS NOT NULL').map((a) => [a.id, a.bucket_id]))
  const ventureRules = [...newest.filter((r) => r.bucketId !== null && !r.auto), ...newest.filter((r) => r.bucketId !== null && r.auto && r.accountId !== null && held.get(r.accountId) === r.bucketId)]
  const assetRules = newest.filter((r) => r.assetId !== null)
  const income = assetRules.length ? incomeCategories() : new Set<number>()
  const rows = db.prepare(`${RULE_ROWS} WHERE t.bucket_source IS NULL OR t.bucket_source = 'rule' OR t.asset_source IS NULL OR t.asset_source = 'rule'`).all() as unknown as RuleRow[]
  const toVenture = db.prepare('UPDATE transactions SET bucket_id = ?, bucket_source = ? WHERE id = ?')
  const toAsset = db.prepare('UPDATE transactions SET asset_id = ?, asset_source = ? WHERE id = ?')
  let changed = 0
  inTransaction(() => {
    for (const t of rows) {
      const day = dayKey(t.posted)
      const text = `${t.description} ${t.merchant ?? ''}`.toLowerCase()
      let moved = false
      if (t.bucket_source === null || t.bucket_source === 'rule') {
        const want = t.transfer ? null : (ventureRules.find((r) => bucketRuleFits(r, t, day, text))?.bucketId ?? null)
        if (want !== t.bucket_id) {
          toVenture.run(want, want === null ? null : 'rule', t.id)
          moved = true
        }
      }
      if (t.asset_source === null || t.asset_source === 'rule') {
        const want = t.transfer || (t.category_id !== null && income.has(t.category_id)) ? null : (assetRules.find((r) => bucketRuleFits(r, t, day, text))?.assetId ?? null)
        if (want !== t.asset_id) {
          toAsset.run(want, want === null ? null : 'rule', t.id)
          moved = true
        }
      }
      if (moved) changed++
    }
  })
  return changed
}

// ---------- asset uses ----------

/** An asset's use periods (every asset's when none is named), by asset and then by day, ventures by id and Personal last on each. */
export function listAssetUses(assetId?: string): AssetUse[] {
  const rows = db
    .prepare(`SELECT id, asset_id, from_day, to_day, bucket_id, share_bp, basis, source FROM asset_uses ${assetId === undefined ? '' : 'WHERE asset_id = ?'} ORDER BY asset_id, from_day, bucket_id IS NULL, bucket_id, id`)
    .all(...(assetId === undefined ? [] : [assetId])) as Array<Record<string, SQLInputValue>>
  return rows.map((r) => ({
    id: r.id as number,
    assetId: r.asset_id as string,
    fromDay: r.from_day as string,
    toDay: (r.to_day as string | null) ?? null,
    bucketId: (r.bucket_id as number | null) ?? null,
    shareBp: r.share_bp as number,
    basis: (r.basis as AssetUse['basis']) ?? null,
    source: r.source as AssetUse['source']
  }))
}

/** Replaces an asset's use periods with these rows as they are (uses.ts checks them first; an undo puts back what was). */
export function replaceAssetUses(assetId: string, rows: Array<Omit<AssetUse, 'id' | 'assetId'>>): void {
  const insert = db.prepare('INSERT INTO asset_uses (asset_id, from_day, to_day, bucket_id, share_bp, basis, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  inTransaction(() => {
    db.prepare('DELETE FROM asset_uses WHERE asset_id = ?').run(assetId)
    for (const r of rows) insert.run(assetId, r.fromDay, r.toDay, r.bucketId, r.shareBp, r.basis, r.source, now())
  })
}

/** The asset fields of transactions and split parts, as they are (for a journal). */
export function assetFields(ids: string[], splitId?: number): Array<{ id: string; splitId: number | null; assetId: string | null; source: string | null }> {
  if (splitId !== undefined) {
    const r = get<{ transaction_id: string; asset_id: string | null }>('SELECT transaction_id, asset_id FROM transaction_splits WHERE id = ?', splitId)
    return r ? [{ id: r.transaction_id, splitId, assetId: r.asset_id, source: null }] : []
  }
  return ids.flatMap((id) => {
    const r = get<{ asset_id: string | null; asset_source: string | null }>('SELECT asset_id, asset_source FROM transactions WHERE id = ?', id)
    return r ? [{ id, splitId: null, assetId: r.asset_id, source: r.asset_source }] : []
  })
}

/** Puts asset fields back exactly as a journal recorded them. */
export function restoreAssetFields(rows: ReturnType<typeof assetFields>): void {
  const whole = db.prepare('UPDATE transactions SET asset_id = ?, asset_source = ? WHERE id = ?')
  const part = db.prepare('UPDATE transaction_splits SET asset_id = ? WHERE id = ?')
  inTransaction(() => {
    for (const r of rows) {
      if (r.splitId === null) whole.run(r.assetId, r.source, r.id)
      else part.run(r.assetId, r.splitId)
    }
  })
}

/**
 * Puts transactions on an asset by hand, so its costs are shared by its uses, or takes them off with null; rules
 * won't move them after this either way. With a split part's id, the one part (of one of the transactions) instead.
 */
export function setTransactionsAsset(ids: string[], assetId: string | null, source: 'user' | 'ai' | 'migrated', splitId?: number): number {
  if (assetId !== null && !get('SELECT 1 FROM accounts WHERE id = ?', assetId)) throw new Error(`No account ${assetId}`)
  if (splitId !== undefined) {
    const owner = get<{ transaction_id: string }>('SELECT transaction_id FROM transaction_splits WHERE id = ?', splitId)
    if (!owner || !ids.includes(owner.transaction_id)) throw new Error(`No part ${splitId} of ${ids.join(', ')}`)
    return Number(db.prepare('UPDATE transaction_splits SET asset_id = ? WHERE id = ?').run(assetId, splitId).changes)
  }
  const update = db.prepare('UPDATE transactions SET asset_id = ?, asset_source = ? WHERE id = ?')
  let n = 0
  inTransaction(() => {
    for (const id of ids) n += Number(update.run(assetId, source, id).changes)
  })
  return n
}

// ---------- contributions ----------

const CONTRIBUTION_KIND_IDS: ContributionKind[] = ['401k', 'roth_401k', 'hsa', 'espp']

export function listContributionRows(): Array<Required<Omit<ContributionInput, 'id'>> & { id: number }> {
  const rows = db.prepare('SELECT * FROM contributions ORDER BY kind, name').all() as Array<Record<string, SQLInputValue>>
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    kind: r.kind as ContributionKind,
    accountId: (r.account_id as string | null) ?? null,
    paycheckKey: (r.paycheck_key as string | null) ?? null,
    percent: (r.percent as number | null) ?? null,
    employeeCents: (r.employee_cents as number | null) ?? null,
    matchCents: (r.match_cents as number | null) ?? null,
    matchNote: (r.match_note as string | null) ?? null,
    matchRateBp: (r.match_rate_bp as number | null) ?? null,
    matchCapBp: (r.match_cap_bp as number | null) ?? null,
    ytdCents: (r.ytd_cents as number | null) ?? null,
    ytdAsOf: (r.ytd_as_of as string | null) ?? null,
    startsDay: (r.starts_day as string | null) ?? null,
    endsDay: (r.ends_day as string | null) ?? null,
    nextPercent: (r.next_percent as number | null) ?? null,
    nextEmployeeCents: (r.next_employee_cents as number | null) ?? null,
    nextFrom: (r.next_from as string | null) ?? null,
    notes: (r.notes as string | null) ?? null
  }))
}

/** Adds a plan, or updates the one with this id (or this name). Fields left out stay as they are. */
export function saveContribution(c: ContributionInput): number {
  const name = c.name?.trim()
  if (!name) throw new Error('A name is required')
  if (!CONTRIBUTION_KIND_IDS.includes(c.kind)) throw new Error(`kind must be one of ${CONTRIBUTION_KIND_IDS.join(', ')}`)
  const existing = c.id ? get<{ id: number }>('SELECT id FROM contributions WHERE id = ?', c.id) : get<{ id: number }>('SELECT id FROM contributions WHERE name = ?', name)
  if (c.id && !existing) throw new Error(`No contribution ${c.id}`)
  if (c.accountId && !get('SELECT 1 FROM accounts WHERE id = ?', c.accountId)) throw new Error(`No account ${c.accountId}`)
  const cents = (v: number | null | undefined, what: string): number | null | undefined => {
    if (v === undefined || v === null) return v
    if (!Number.isInteger(v) || v < 0) throw new Error(`${what} must be a whole number of cents, 0 or more`)
    return v
  }
  const bp = (v: number | null | undefined, what: string): number | null | undefined => {
    if (v === undefined || v === null) return v
    if (!Number.isInteger(v) || v < 0 || v > 10000) throw new Error(`${what} must be a whole number of basis points, 0 to 10000`)
    return v
  }
  // A payroll keyed by hand ('Acme Payroll') is kept in payrollKey's form, as migration 39 left every key, so the
  // plan's elections and its paystubs' lines reach the checks the classifier finds.
  const fields: Record<string, SQLInputValue | undefined> = {
    name,
    kind: c.kind,
    account_id: c.accountId,
    paycheck_key: c.paycheckKey === undefined ? undefined : c.paycheckKey?.trim() ? asPayrollKey(c.paycheckKey) : null,
    percent: c.percent,
    employee_cents: cents(c.employeeCents, 'Per paycheck'),
    match_cents: cents(c.matchCents, 'Match'),
    match_note: c.matchNote === undefined ? undefined : c.matchNote?.trim() || null,
    match_rate_bp: bp(c.matchRateBp, 'Match rate'),
    match_cap_bp: bp(c.matchCapBp, 'Match cap'),
    ytd_cents: cents(c.ytdCents, 'Year to date'),
    ytd_as_of: c.ytdAsOf === undefined ? undefined : checkDay(c.ytdAsOf, 'Year-to-date date'),
    starts_day: c.startsDay === undefined ? undefined : checkDay(c.startsDay, 'Start date'),
    ends_day: c.endsDay === undefined ? undefined : checkDay(c.endsDay, 'End date'),
    next_percent: c.nextPercent,
    next_employee_cents: cents(c.nextEmployeeCents, 'New per paycheck'),
    next_from: c.nextFrom === undefined ? undefined : checkDay(c.nextFrom, 'Change date'),
    notes: c.notes === undefined ? undefined : c.notes?.trim() || null
  }
  const set = Object.entries(fields).filter(([, v]) => v !== undefined) as Array<[string, SQLInputValue]>
  if (existing) {
    db.prepare(`UPDATE contributions SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...set.map(([, v]) => v), existing.id)
    return existing.id
  }
  const r = db.prepare(`INSERT INTO contributions (${set.map(([k]) => k).join(', ')}, created_at) VALUES (${set.map(() => '?').join(', ')}, ?)`).run(...set.map(([, v]) => v), now())
  return Number(r.lastInsertRowid)
}

export function deleteContribution(id: number): void {
  db.prepare('DELETE FROM contributions WHERE id = ?').run(id)
}

// ---------- paystubs ----------

/** Every paystub, or one payroll's, with pay days from one day to another (inclusive), oldest first, each with its items in order. */
export function listPaystubs(key?: string, from?: string, to?: string): Paystub[] {
  const where: string[] = []
  const params: string[] = []
  if (key !== undefined) {
    where.push('paycheck_key = ?')
    params.push(key)
  }
  if (from !== undefined) {
    where.push('pay_day >= ?')
    params.push(from)
  }
  if (to !== undefined) {
    where.push('pay_day <= ?')
    params.push(to)
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const stubs = all<Record<string, SQLInputValue>>(`SELECT * FROM paystubs ${cond} ORDER BY pay_day, kind, id`, ...params)
  if (!stubs.length) return []
  const items = new Map<number, PaystubItem[]>()
  for (const r of all<Record<string, SQLInputValue>>(`SELECT * FROM paystub_items WHERE paystub_id IN (SELECT id FROM paystubs ${cond}) ORDER BY paystub_id, position`, ...params)) {
    const list = items.get(r.paystub_id as number) ?? []
    list.push({ kind: r.kind as PaystubItemKind, name: r.name as string, cents: r.cents as number, ytdCents: (r.ytd_cents as number | null) ?? null, pretax: r.pretax === 1, employerCents: (r.employer_cents as number | null) ?? null })
    items.set(r.paystub_id as number, list)
  }
  return stubs.map((r) => ({
    id: r.id as number,
    paycheckKey: r.paycheck_key as string,
    payDay: r.pay_day as string,
    periodFrom: (r.period_from as string | null) ?? null,
    periodTo: (r.period_to as string | null) ?? null,
    kind: r.kind as Paystub['kind'],
    grossCents: r.gross_cents as number,
    netCents: r.net_cents as number,
    items: items.get(r.id as number) ?? [],
    documentId: (r.document_id as number | null) ?? null,
    source: r.source as Paystub['source'],
    estimated: r.estimated === 1
  }))
}

/** One paystub by id, or null. */
export const getPaystub = (id: number): Paystub | null => listPaystubs().find((p) => p.id === id) ?? null

/**
 * Writes a paystub as given, checked already (paystubs.ts savePaystub): over the one with the same payroll, pay day
 * and kind, which keeps its id, or as a new one, under `id` when one removed is being put back. Returns its id.
 */
export function writePaystub(p: Omit<Paystub, 'id'> & { id?: number }): number {
  return inTransaction(() => {
    const same = get<{ id: number }>('SELECT id FROM paystubs WHERE paycheck_key = ? AND pay_day = ? AND kind = ?', p.paycheckKey, p.payDay, p.kind)
    const fields: Array<[string, SQLInputValue]> = [
      ['paycheck_key', p.paycheckKey],
      ['pay_day', p.payDay],
      ['period_from', p.periodFrom],
      ['period_to', p.periodTo],
      ['kind', p.kind],
      ['gross_cents', p.grossCents],
      ['net_cents', p.netCents],
      ['document_id', p.documentId],
      ['source', p.source],
      ['estimated', p.estimated ? 1 : 0]
    ]
    let id: number
    if (same && (p.id === undefined || p.id === same.id)) {
      id = same.id
      db.prepare(`UPDATE paystubs SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map(([, v]) => v), id)
      db.prepare('DELETE FROM paystub_items WHERE paystub_id = ?').run(id)
    } else {
      if (same) deletePaystub(same.id)
      const cols = [...(p.id !== undefined ? [['id', p.id] as [string, SQLInputValue]] : []), ...fields, ['created_at', now()] as [string, SQLInputValue]]
      id = Number(db.prepare(`INSERT INTO paystubs (${cols.map(([k]) => k).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(([, v]) => v)).lastInsertRowid)
    }
    const item = db.prepare('INSERT INTO paystub_items (paystub_id, kind, name, cents, ytd_cents, pretax, employer_cents, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    p.items.forEach((x, i) => item.run(id, x.kind, x.name, x.cents, x.ytdCents, x.pretax ? 1 : 0, x.employerCents, i))
    return id
  })
}

export function deletePaystub(id: number): boolean {
  return inTransaction(() => {
    db.prepare('DELETE FROM paystub_items WHERE paystub_id = ?').run(id)
    return Number(db.prepare('DELETE FROM paystubs WHERE id = ?').run(id).changes) > 0
  })
}

/** The documents folder's record of a file, by name, as a paystub names it; null when it hasn't been gone through. */
export const documentId = (name: string): number | null => get<{ id: number }>('SELECT rowid AS id FROM documents WHERE name = ?', name)?.id ?? null

/** Removes withholding kept before paystubs, for the sample household's own rows (paycheck_withholding is otherwise read only, by migration 39). */
export function deleteWithholding(paycheckKey: string): boolean {
  return Number(db.prepare('DELETE FROM paycheck_withholding WHERE paycheck_key = ?').run(paycheckKey.trim().toLowerCase()).changes) > 0
}

/** Days of paycheck deposits from one payroll (its payrollKey, shared/payroll.ts) posted after a day (pending included), oldest first. */
export function paychecksAfter(key: string, day: string, until?: string | null): string[] {
  const rows = db.prepare(`SELECT DISTINCT date(${localSql('t.posted')}) AS d, t.merchant, t.desc_key FROM transactions t WHERE t.amount_cents > 0`).all() as Array<{ d: string; merchant: string | null; desc_key: string }>
  const days = new Set(rows.filter((r) => r.d > day && (!until || r.d <= until) && payrollKey({ merchant: r.merchant, descKey: r.desc_key }) === key).map((r) => r.d))
  return [...days].sort()
}

/** Days of paycheck deposits from one payroll (its payrollKey) between two days, inclusive. */
export function paycheckDays(key: string, from: string, to: string): string[] {
  return paychecksAfter(key, '0000-00-00', to).filter((d) => d >= from)
}

// ---------- months: the summary and the headline ----------

function monthRange(month: string): [number, number] {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid month: ${month}`)
  return [monthStart(shiftMonth(month, 0)), monthStart(shiftMonth(month, 1))]
}

/** SQL condition: the transaction with this id column is split into parts. */
const splitOf = (id: string): string => `EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = ${id})`
export const IS_SPLIT = splitOf('t.id')
export const NOT_SPLIT = `NOT ${IS_SPLIT}`

/**
 * Every transaction as the lines it counts as, under the transactions table's own column names: one
 * line for a transaction that isn't split, one per part for one that is, with the part's amount,
 * category, venture and one-off flag (a transaction marked one-off makes every part one; a part not
 * put in a venture of its own is in the transaction's). A part's asset is its own, else its
 * transaction's when it follows the transaction's venture; one placed by hand on the part is the
 * user's. A line's id is its transaction's; split_id is the part's.
 */
export const TXN_LINES = `(SELECT t.id, t.account_id, t.posted, COALESCE(s.amount_cents, t.amount_cents) AS amount_cents, t.description, t.desc_key, t.merchant,
    CASE WHEN s.id IS NULL THEN t.category_id ELSE s.category_id END AS category_id,
    CASE WHEN s.id IS NULL THEN t.category_source ELSE 'user' END AS category_source,
    CASE WHEN s.id IS NULL THEN t.confidence END AS confidence, t.pending, t.notes, t.created_at,
    CASE WHEN s.id IS NULL OR s.own_bucket = 0 THEN t.bucket_id ELSE s.bucket_id END AS bucket_id, t.bucket_source,
    CASE WHEN s.id IS NULL THEN t.one_time ELSE MAX(t.one_time, s.one_time) END AS one_time, t.hsa, t.receipt, t.capital_asset_id,
    CASE WHEN s.asset_id IS NOT NULL THEN s.asset_id WHEN s.id IS NULL OR s.own_bucket = 0 THEN t.asset_id END AS asset_id,
    CASE WHEN s.asset_id IS NOT NULL THEN 'user' WHEN s.id IS NULL OR s.own_bucket = 0 THEN t.asset_source END AS asset_source, s.id AS split_id
  FROM transactions t LEFT JOIN transaction_splits s ON s.transaction_id = t.id)`

// Spending = money out of expense categories (net of refunds) + uncategorized outflows.
// Income = income categories only: money in with no category is Unsorted until it's categorized (waterfall spec
// Decision 13), so a transfer in or a refund nobody filed never reads as earned. Transfers count as neither.
export const SPEND_EXPR = `CASE WHEN c.kind = 'expense' THEN -t.amount_cents WHEN c.id IS NULL AND t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END`
export const INCOME_EXPR = `CASE WHEN c.kind = 'income' THEN t.amount_cents ELSE 0 END`
/** Visible money by line (a split transaction's parts each in their own category and venture): what every total sums over. */
export const VISIBLE_FROM = `FROM ${TXN_LINES} t JOIN accounts a ON a.id = t.account_id AND a.hidden = 0 LEFT JOIN categories c ON c.id = t.category_id`
/** Visible transactions whole, one row each in their own category: for lists, payees and recurring series. */
export const VISIBLE_TXN_FROM = `FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.hidden = 0 LEFT JOIN categories c ON c.id = t.category_id`

/** A summary's figures without the span it covers. */
export type SummaryFigures = Omit<MonthSummary, 'month' | 'fromMonth' | 'fromDay' | 'toDay'>

/**
 * Ventures' money between two times (unix, end exclusive), against an earlier span, with a trend over months: cash
 * in and out of their lines by category, as a venture's books read them. It's the summary of a view of ventures
 * alone; Personal's, and Personal's with ventures added, are summary.ts's, from the classifier, which adds net
 * worth (netWorth.ts) to each.
 */
export function bucketSummary(ids: number[], from: number, to: number, prevSpan: [number, number] | null, trendMonths: string[]): Omit<SummaryFigures, 'netWorthCents'> {
  return summarize(bucketClause(ids), from, to, prevSpan, trendMonths)
}

/** A venture's line as a summary reads it. */
export interface BucketLine {
  txnId: string
  day: string
  cents: number
  categoryId: number | null
  category: string | null
  /** its category's kind: 'expense', 'income' or 'transfer'; null when it has none */
  kind: string | null
  merchant: string | null
  descKey: string
  description: string
}

/**
 * Ventures' lines between two times (unix, end exclusive), on visible accounts, oldest first, with the first month
 * they have any line in: what a view adding ventures to Personal reads of theirs.
 */
export function bucketLines(ids: number[], from: number, to: number): { lines: BucketLine[]; firstMonth: string | null } {
  const B = bucketClause(ids)
  const lines = all<BucketLine>(
    `SELECT t.id AS txnId, date(${localSql('t.posted')}) AS day, t.amount_cents AS cents, t.category_id AS categoryId, c.name AS category, c.kind, t.merchant, t.desc_key AS descKey, t.description
     ${VISIBLE_FROM} WHERE t.posted >= ? AND t.posted < ? AND ${B} ORDER BY t.posted, t.id, t.split_id`,
    from,
    to
  )
  const first = get<{ m: string | null }>(`SELECT strftime('%Y-%m', ${localSql('p')}) AS m FROM (SELECT MIN(t.posted) AS p ${VISIBLE_FROM} WHERE ${B})`)
  return { lines, firstMonth: first?.m ?? null }
}

/** What categorizing can clear, as listUncategorized and Review count it: a split transaction's parts have theirs. */
export const uncategorizedCount = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE t.category_id IS NULL AND ${NOT_SPLIT}`).get() as { n: number }).n

/**
 * Ventures' money in and out between two times (unix, end exclusive), leaving out transfers, grouped by category,
 * payee, month or venture: Review's spending_summary for ventures. `ids` are the ventures, or 'all' for every one.
 */
export function bucketSpending(ids: number[] | 'all', from: number, to: number, groupBy: 'category' | 'merchant' | 'month' | 'bucket'): Array<{ k: string; spend: number; income: number; n: number }> {
  const group =
    groupBy === 'merchant'
      ? 'COALESCE(t.merchant, t.description)'
      : groupBy === 'month'
        ? `strftime('%Y-%m', ${localSql('t.posted')})`
        : groupBy === 'bucket'
          ? "COALESCE((SELECT name FROM buckets WHERE id = t.bucket_id), 'Personal')"
          : "COALESCE(c.name, 'Uncategorized')"
  const which = ids === 'all' ? 't.bucket_id IS NOT NULL' : bucketClause(ids)
  return all<{ k: string; spend: number; income: number; n: number }>(
    `SELECT ${group} AS k, SUM(${SPEND_EXPR}) AS spend, SUM(${INCOME_EXPR}) AS income, COUNT(DISTINCT t.id) AS n
     ${VISIBLE_FROM} WHERE t.posted >= ? AND t.posted < ? AND ${which} AND ${NOT_TRANSFER} GROUP BY k`,
    from,
    to
  )
}

function summarize(B: string, from: number, to: number, prevSpan: [number, number] | null, trendMonths: string[]): Omit<SummaryFigures, 'netWorthCents'> {
  const [prevFrom, prevTo] = prevSpan ?? [0, 0]

  const totals = db.prepare(`SELECT COALESCE(SUM(${SPEND_EXPR}), 0) AS spend, COALESCE(SUM(${INCOME_EXPR}), 0) AS income, COUNT(DISTINCT t.id) AS n ${VISIBLE_FROM} WHERE t.posted >= ? AND t.posted < ? AND ${B}`).get(from, to) as { spend: number; income: number; n: number }
  const prev = db.prepare(`SELECT COALESCE(SUM(${SPEND_EXPR}), 0) AS spend ${VISIBLE_FROM} WHERE t.posted >= ? AND t.posted < ? AND ${B}`).get(prevFrom, prevTo) as { spend: number }

  const byCategory = (db.prepare(`
    SELECT c.id AS category_id, COALESCE(c.name, 'Uncategorized') AS name, SUM(${SPEND_EXPR}) AS cents, COUNT(DISTINCT t.id) AS count
    ${VISIBLE_FROM}
    WHERE t.posted >= ? AND t.posted < ? AND ${B} AND (c.kind = 'expense' OR (c.id IS NULL AND t.amount_cents < 0))
    GROUP BY c.id ORDER BY cents DESC
  `).all(from, to) as Array<Record<string, SQLInputValue>>)
    .map((r): CategorySpend => ({ categoryId: (r.category_id as number | null) ?? null, name: r.name as string, cents: r.cents as number, count: r.count as number }))
    .filter((c) => c.cents > 0)

  const trendStart = monthRange(trendMonths[0])[0]
  const trendRows = db.prepare(`
    SELECT strftime('%Y-%m', ${localSql('t.posted')}) AS month,
           SUM(${INCOME_EXPR}) AS income, SUM(${SPEND_EXPR}) AS spend
    ${VISIBLE_FROM}
    WHERE t.posted >= ? AND t.posted < ? AND ${B} GROUP BY month
  `).all(trendStart, monthRange(trendMonths.at(-1)!)[1]) as Array<{ month: string; income: number; spend: number }>
  const trendMap = new Map(trendRows.map((r) => [r.month, r]))
  const trend: MonthPoint[] = []
  for (const m of trendMonths) {
    const r = trendMap.get(m)
    trend.push({ month: m, incomeCents: r?.income ?? 0, spendCents: r?.spend ?? 0 })
  }
  // Drop leading empty months so a new install doesn't show a year of zeros.
  while (trend.length > 1 && trend[0].incomeCents === 0 && trend[0].spendCents === 0) trend.shift()

  // Net of refunds, same as the category totals, so the two views always agree.
  const topMerchants = (db.prepare(`
    SELECT COALESCE(t.merchant, t.description) AS merchant, SUM(${SPEND_EXPR}) AS cents,
           COUNT(DISTINCT CASE WHEN t.amount_cents < 0 THEN t.id END) AS count
    ${VISIBLE_FROM}
    WHERE t.posted >= ? AND t.posted < ? AND ${B} AND (c.kind = 'expense' OR (c.id IS NULL AND t.amount_cents < 0))
    GROUP BY COALESCE(t.merchant, t.desc_key) HAVING cents > 0 ORDER BY cents DESC LIMIT 12
  `).all(from, to) as Array<{ merchant: string; cents: number; count: number }>)

  // The paycheck category by role, so a renamed one still splits pay by employer.
  const payIds = listCategories().filter((c) => categoryRole(c.name) === 'paycheck').map((c) => c.id)
  const isPay = payIds.length ? `c.id IN (${payIds.join(',')})` : '0'
  const notPay = payIds.length ? `(c.id IS NULL OR c.id NOT IN (${payIds.join(',')}))` : '1'
  const incomeBySource = (db.prepare(`
    SELECT CASE WHEN ${isPay} THEN COALESCE(t.merchant, t.description) ELSE COALESCE(c.name, 'Uncategorized') END AS income_source, SUM(${INCOME_EXPR}) AS cents,
      MAX(${isPay}) AS paycheck
    ${VISIBLE_FROM}
    WHERE t.posted >= ? AND t.posted < ? AND ${B} AND c.kind = 'income'
    GROUP BY income_source HAVING cents > 0 ORDER BY cents DESC
  `).all(from, to) as Array<{ income_source: string; cents: number; paycheck: number | null }>).map((r) => ({ name: r.income_source, cents: r.cents, paycheck: r.paycheck === 1 }))
  // Income that isn't pay, payer by payer, so a category can be opened into who paid it.
  const payers = db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorized') AS income_source, COALESCE(t.merchant, t.description) AS name, SUM(${INCOME_EXPR}) AS cents
    ${VISIBLE_FROM}
    WHERE t.posted >= ? AND t.posted < ? AND ${B} AND c.kind = 'income' AND ${notPay}
    GROUP BY income_source, COALESCE(t.merchant, t.desc_key) HAVING cents > 0 ORDER BY cents DESC
  `).all(from, to) as Array<{ income_source: string; name: string; cents: number }>
  for (const s of incomeBySource) {
    const parts = s.paycheck ? [] : payers.filter((p) => p.income_source === s.name).map((p) => ({ name: p.name, cents: p.cents }))
    if (parts.length > 1) Object.assign(s, { parts })
  }

  const first = db.prepare(`SELECT strftime('%Y-%m', ${localSql('p')}) AS m FROM (SELECT MIN(t.posted) AS p ${VISIBLE_FROM} WHERE ${B})`).get() as { m: string | null }

  return {
    firstMonth: first.m ?? null,
    incomeBySource,
    incomeCents: totals.income,
    spendCents: totals.spend,
    prevSpendCents: prev.spend,
    byCategory,
    trend,
    topMerchants,
    uncategorizedCount: uncategorizedCount(),
    txnCount: totals.n
  }
}

/** Every transaction for the CSV, newest first; a split one is a row per part, each under the transaction's id. */
export function allTransactionsForExport(): Array<Transaction & { categoryName: string | null; bucketName: string | null }> {
  const rows = db.prepare(`${TXN_SELECT.replace('FROM transactions t', ', c.name AS category_name, b.name AS bucket_name FROM transactions t')} LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN buckets b ON b.id = t.bucket_id ORDER BY t.posted DESC`).all() as Array<Record<string, SQLInputValue>>
  const txns = withParts(rows.map(toTxn), true)
  const categories = new Map(listCategories().map((c) => [c.id, c.name]))
  const buckets = new Map((db.prepare('SELECT id, name FROM buckets').all() as Array<{ id: number; name: string }>).map((b) => [b.id, b.name]))
  return txns.flatMap((t, i) => {
    const whole = { ...t, categoryName: (rows[i].category_name as string | null) ?? null, bucketName: (rows[i].bucket_name as string | null) ?? null }
    return t.splits.length
      ? t.splits.map((s) => ({
          ...whole,
          amountCents: s.amountCents,
          categoryId: s.categoryId,
          bucketId: s.bucketId,
          oneTime: t.oneTime || s.oneTime,
          notes: s.note ?? t.notes,
          categoryName: s.categoryId === null ? null : (categories.get(s.categoryId) ?? null),
          bucketName: s.bucketId === null ? null : (buckets.get(s.bucketId) ?? null)
        }))
      : [whole]
  })
}

// ---------- splits and tags ----------

/** Most parts one transaction can be split into. */
export const SPLIT_MAX = 20
/** Longest tag, and longest note on a part. */
export const TAG_MAX = 40
export const SPLIT_NOTE_MAX = 200

/** A part's columns, from transaction_splits s joined to its transaction t: its venture is the transaction's unless it has one of its own. */
const PART_COLS = `s.id, s.transaction_id, s.amount_cents, s.category_id, CASE WHEN s.own_bucket = 1 THEN s.bucket_id ELSE t.bucket_id END AS bucket_id, s.one_time, s.note
  FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id`

function toSplit(r: Record<string, SQLInputValue>): TxnSplit {
  return {
    id: r.id as number,
    amountCents: r.amount_cents as number,
    categoryId: (r.category_id as number | null) ?? null,
    bucketId: (r.bucket_id as number | null) ?? null,
    oneTime: r.one_time === 1,
    note: (r.note as string | null) ?? null
  }
}

/** A transaction's parts, in order (empty when it isn't split). */
export function splitParts(id: string): TxnSplit[] {
  return (db.prepare(`SELECT ${PART_COLS} WHERE s.transaction_id = ? ORDER BY s.position, s.id`).all(id) as Array<Record<string, SQLInputValue>>).map(toSplit)
}

/** Whether saving these parts changes a venture: a part given one other than the part's at its place has now (the transaction's, for a part added). */
export function splitMovesVentures(t: Pick<Transaction, 'bucketId' | 'splits'>, parts: Array<{ bucketId?: number | null }>): boolean {
  return parts.some((p, i) => p.bucketId !== undefined && p.bucketId !== (i < t.splits.length ? t.splits[i].bucketId : t.bucketId))
}

/**
 * Splits a transaction into parts, replacing any earlier split: at least two, each a whole number of
 * cents with the transaction's sign, adding up to its amount exactly. A part without a venture, or in
 * the transaction's, stays where the transaction is, also when it moves later. The transaction's own
 * category, venture and amount are left as they are, so unsplitting puts it back. A pending row isn't
 * split: the bank posts it under a new id, and the pending one (with its parts) goes.
 */
export function splitTransaction(id: string, parts: SplitPart[]): TxnSplit[] {
  const t = get<{ amount_cents: number; bucket_id: number | null; pending: number }>('SELECT amount_cents, bucket_id, pending FROM transactions WHERE id = ?', id)
  if (!t) throw new Error(`No transaction ${id}`)
  if (t.pending) throw new Error('Split it once it posts')
  if (!Array.isArray(parts) || parts.length < 2) throw new Error('A split needs at least two parts')
  if (parts.length > SPLIT_MAX) throw new Error(`A split has at most ${SPLIT_MAX} parts`)
  if (t.amount_cents === 0) throw new Error('A transaction of $0.00 can\'t be split')
  const sign = Math.sign(t.amount_cents)
  const rows = parts.map((p, i) => {
    const cents = checkCents(p.amountCents, `Part ${i + 1}`)
    if (Math.sign(cents) !== sign) throw new Error(`Part ${i + 1} must be ${sign < 0 ? 'negative' : 'positive'}, like the transaction`)
    const categoryId = p.categoryId ?? null
    if (categoryId !== null && !get('SELECT 1 FROM categories WHERE id = ?', categoryId)) throw new Error(`No category ${categoryId}`)
    const bucketId = p.bucketId === undefined ? t.bucket_id : p.bucketId
    if (bucketId !== null && !get('SELECT 1 FROM buckets WHERE id = ?', bucketId)) throw new Error(`No bucket ${bucketId}`)
    const note = p.note ? cleanText(p.note, SPLIT_NOTE_MAX) || null : null
    return { cents, categoryId, bucketId, oneTime: p.oneTime ? 1 : 0, note }
  })
  const sum = rows.reduce((s, r) => s + r.cents, 0)
  if (sum !== t.amount_cents) throw new Error(`The parts add up to ${(sum / 100).toFixed(2)}, not ${(t.amount_cents / 100).toFixed(2)}`)
  const insert = db.prepare('INSERT INTO transaction_splits (transaction_id, amount_cents, category_id, bucket_id, own_bucket, one_time, note, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  inTransaction(() => {
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(id)
    rows.forEach((r, i) => insert.run(id, r.cents, r.categoryId, r.bucketId, r.bucketId === t.bucket_id ? 0 : 1, r.oneTime, r.note, i))
  })
  return splitParts(id)
}

/** Back to one transaction in its own category; returns the parts it had. */
export function unsplitTransaction(id: string): TxnSplit[] {
  const had = splitParts(id)
  db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(id)
  return had
}

/** Puts a split back as a journal recorded it (empty unsplits). */
export function restoreSplit(id: string, parts: TxnSplit[]): void {
  if (parts.length) splitTransaction(id, parts)
  else unsplitTransaction(id)
}

/**
 * When the bank changes a split transaction's amount (a tip added once it posts), the largest part
 * takes the difference; when that part would cross zero or the sign flips, the split goes and the
 * transaction counts whole again.
 */
function refitSplit(id: string, was: number, is: number): void {
  const parts = splitParts(id)
  if (!parts.length) return
  const largest = parts.reduce((a, b) => (Math.abs(b.amountCents) > Math.abs(a.amountCents) ? b : a))
  const cents = largest.amountCents + is - was
  if (Math.sign(was) === Math.sign(is) && Math.sign(cents) === Math.sign(is)) db.prepare('UPDATE transaction_splits SET amount_cents = ? WHERE id = ?').run(cents, largest.id)
  else unsplitTransaction(id)
}

/** A tag as typed, cleaned (no commas, one space between words); '' when nothing is left. Never cut: two long tags must not become one. */
export const tagLabel = (s: string): string => cleanText(String(s ?? '').replace(/[,;\n]+/g, ' '), 200).replace(/\s+/g, ' ').trim()
/** A tag's key: its label, lower-case. */
export const tagKey = (s: string): string => tagLabel(s).toLowerCase()

/** The tags in use, as first typed, most used first. */
export function listTags(): TagCount[] {
  const rows = db
    .prepare(
      `SELECT (SELECT g2.label FROM transaction_tags g2 WHERE g2.tag = g.tag ORDER BY g2.created_at, g2.rowid LIMIT 1) AS tag, COUNT(*) AS count
       FROM transaction_tags g GROUP BY g.tag ORDER BY count DESC, g.tag`
    )
    .all() as unknown as TagCount[]
  return rows.map((r) => ({ tag: r.tag, count: r.count }))
}

/** Tags as typed, cleaned, each once (in any case: the first spelling stays); throws for one over TAG_MAX characters. */
export function tagLabels(tags: string[]): string[] {
  const out = new Map<string, string>()
  for (const label of tags.map(tagLabel)) {
    if ([...label].length > TAG_MAX) throw new Error(`A tag is at most ${TAG_MAX} characters`)
    if (label && !out.has(label.toLowerCase())) out.set(label.toLowerCase(), label)
  }
  return [...out.values()]
}

/** Adds tags to transactions; a tag already in use keeps the spelling it was first typed with. Returns how many tags were added. */
export function addTags(ids: string[], tags: string[]): number {
  const labels = tagLabels(tags)
  if (!labels.length) throw new Error('Name a tag')
  const first = db.prepare('SELECT label FROM transaction_tags WHERE tag = ? ORDER BY created_at, rowid LIMIT 1')
  const insert = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag, label, created_at) SELECT id, ?, ?, ? FROM transactions WHERE id = ?')
  let n = 0
  inTransaction(() => {
    for (const label of labels) {
      const key = label.toLowerCase()
      const shown = (first.get(key) as { label: string } | undefined)?.label ?? label
      for (const id of ids) n += Number(insert.run(key, shown, now(), id).changes)
    }
  })
  return n
}

/** Takes tags off transactions (in any case). Returns how many came off. */
export function removeTags(ids: string[], tags: string[]): number {
  const keys = [...new Set(tags.map(tagKey).filter(Boolean))]
  const del = db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ? AND tag = ?')
  let n = 0
  inTransaction(() => {
    for (const id of ids) for (const key of keys) n += Number(del.run(id, key).changes)
  })
  return n
}

/** The tag rows of transactions, as they are (for a journal). */
export function tagRows(ids: string[]): Array<{ id: string; tag: string; label: string; createdAt: number }> {
  return ids.flatMap((id) => db.prepare('SELECT transaction_id AS id, tag, label, created_at AS createdAt FROM transaction_tags WHERE transaction_id = ? ORDER BY created_at, rowid').all(id) as Array<{ id: string; tag: string; label: string; createdAt: number }>)
}

/** Puts these transactions' tags back exactly as a journal recorded them. */
export function restoreTagRows(ids: string[], rows: ReturnType<typeof tagRows>): void {
  inTransaction(() => {
    for (const id of ids) db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(id)
    const insert = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag, label, created_at) SELECT id, ?, ?, ? FROM transactions WHERE id = ?')
    for (const r of rows) insert.run(r.tag, r.label, r.createdAt, r.id)
  })
}
