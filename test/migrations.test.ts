import { after, afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '../src/main/sqlite.ts'
import * as db from '../src/main/db.ts'
import { checkIntegrity, closeDb, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, NewerDatabaseError, openDb, schemaVersion, type MigrationStep } from '../src/main/db.ts'

const dir = mkdtempSync(join(tmpdir(), 'finance-migrations-'))
after(() => rmSync(dir, { recursive: true, force: true }))
afterEach(closeDb)

let n = 0
const fresh = (): string => join(dir, `db-${n++}.db`)

/** Reads the closed file on its own connection. */
function inspect<T>(file: string, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(file)
  try {
    return fn(d)
  } finally {
    d.close()
  }
}
const tables = (d: DatabaseSync): string[] => (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
const columns = (d: DatabaseSync, table: string): string[] => (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
const userVersion = (d: DatabaseSync): number => (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

// What the last steps added before they were numbered, as an older build left it.
const ONCE_UNNUMBERED = `
  CREATE TABLE IF NOT EXISTS recorded_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    cents INTEGER NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS recorded_flows_account ON recorded_flows (account_id, day);
  CREATE TABLE IF NOT EXISTS flows_known_from (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    day TEXT NOT NULL
  );
  ALTER TABLE calendar_events ADD COLUMN start_time TEXT;
  ALTER TABLE calendar_events ADD COLUMN end_time TEXT;
  ALTER TABLE calendar_events ADD COLUMN task INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE calendar_events ADD COLUMN done_at INTEGER;
  ALTER TABLE calendar_events ADD COLUMN google_task TEXT;
`

describe('migrations', () => {
  test('the steps are numbered 1, 2, 3… up to the latest version', () => {
    MIGRATIONS.forEach((s, i) => assert.equal(s.version, i + 1))
    assert.equal(LATEST_SCHEMA_VERSION, MIGRATIONS.length)
    assert.ok(LATEST_SCHEMA_VERSION >= 23)
  })

  test('a fresh database reaches the latest version and is sound', () => {
    const file = fresh()
    openDb(file)
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
    assert.deepEqual(checkIntegrity(), { corruption: [], foreignKeys: [] })
    closeDb()
    inspect(file, (d) => {
      assert.ok(tables(d).includes('recorded_flows'))
      assert.ok(tables(d).includes('flows_known_from'))
      for (const c of ['start_time', 'end_time', 'task', 'done_at', 'google_task']) assert.ok(columns(d, 'calendar_events').includes(c), c)
      assert.equal((d.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n, 25)
    })
  })

  test('a database taken to version 5 and migrated again ends where a fresh one does', () => {
    const file = fresh()
    openDb(file, { migrate: false })
    assert.equal(migrate({ target: 5 }), 5)
    assert.equal(schemaVersion(), 5)
    closeDb()
    inspect(file, (d) => {
      assert.equal(userVersion(d), 5)
      assert.ok(!tables(d).includes('buckets'))
    })
    openDb(file)
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
    closeDb()
    const whole = fresh()
    openDb(whole)
    closeDb()
    assert.deepEqual(inspect(file, tables), inspect(whole, tables))
    assert.deepEqual(inspect(file, (d) => columns(d, 'calendar_events')), inspect(whole, (d) => columns(d, 'calendar_events')))
  })

  test('a database at the latest version runs no steps', () => {
    const file = fresh()
    openDb(file)
    closeDb()
    openDb(file, { migrate: false })
    assert.equal(migrate(), 0)
  })

  test('a database that already has the once-unnumbered tables and columns migrates cleanly', () => {
    const file = fresh()
    openDb(file, { migrate: false })
    migrate({ target: 20 })
    closeDb()
    inspect(file, (d) => d.exec(ONCE_UNNUMBERED))
    openDb(file)
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
    assert.deepEqual(checkIntegrity(), { corruption: [], foreignKeys: [] })
    closeDb()
    assert.equal(inspect(file, (d) => columns(d, 'calendar_events').filter((c) => c === 'task').length), 1)
  })

  test('split parts saved before they could follow their transaction keep a venture that differs as their own', () => {
    const file = fresh()
    openDb(file, { migrate: false })
    migrate({ target: 32 })
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    const rental = db.saveBucket({ name: 'Rental', kind: 'rental' })
    db.upsertTransaction({ id: 't1', accountId: 'manual:a', posted: 1_790_000_000, amountCents: -10000, description: 'HOME DEPOT', pending: false })
    const part = 'INSERT INTO transaction_splits (transaction_id, amount_cents, category_id, bucket_id, one_time, note, position) VALUES (?, ?, NULL, ?, 0, NULL, ?)'
    db.all(part, 't1', -6000, rental, 0)
    db.all(part, 't1', -4000, null, 1)
    closeDb()
    openDb(file)
    assert.deepEqual(db.all<{ own: number }>('SELECT own_bucket AS own FROM transaction_splits ORDER BY position').map((r) => r.own), [1, 0])
    db.setTransactionsBucket(['t1'], rental)
    db.setTransactionsBucket(['t1'], null)
    assert.deepEqual(db.splitParts('t1').map((s) => s.bucketId), [rental, null])
    db.setTransactionsBucket(['t1'], rental)
    assert.deepEqual(db.splitParts('t1').map((s) => s.bucketId), [rental, rental])
  })

  test('a calendar step that was left half-done gets its missing columns', () => {
    const file = fresh()
    openDb(file, { migrate: false })
    migrate({ target: 22 })
    closeDb()
    inspect(file, (d) => d.exec('ALTER TABLE calendar_events ADD COLUMN task INTEGER NOT NULL DEFAULT 0'))
    openDb(file)
    closeDb()
    inspect(file, (d) => {
      const cols = columns(d, 'calendar_events')
      assert.ok(cols.includes('done_at'))
      assert.ok(cols.includes('google_task'))
      assert.equal(userVersion(d), LATEST_SCHEMA_VERSION)
    })
  })

  test('a step that fails halfway leaves the version and the schema as they were', () => {
    const file = fresh()
    openDb(file, { migrate: false })
    migrate({ target: 3 })
    const broken: MigrationStep[] = [
      ...MIGRATIONS.slice(0, 3),
      {
        version: 4,
        run: (d) => {
          d.exec('CREATE TABLE half (x)')
          d.exec('ALTER TABLE accounts ADD COLUMN asset_type TEXT')
          throw new Error('boom')
        }
      }
    ]
    assert.throws(() => migrate({ steps: broken }), /Migration step 4 failed: boom/)
    assert.equal(schemaVersion(), 3)
    closeDb()
    inspect(file, (d) => {
      assert.equal(userVersion(d), 3)
      assert.ok(!tables(d).includes('half'))
      assert.ok(!columns(d, 'accounts').includes('asset_type'))
    })
    // The real step 4 adds asset_type, so it only runs if the rollback was complete.
    openDb(file)
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
  })

  test('a step whose SQL fails is rolled back too', () => {
    const file = fresh()
    openDb(file, { migrate: false })
    migrate({ target: 2 })
    const broken: MigrationStep[] = [...MIGRATIONS.slice(0, 2), { version: 3, run: (d) => d.exec('CREATE TABLE half (x); ALTER TABLE accounts ADD COLUMN name TEXT;') }]
    assert.throws(() => migrate({ steps: broken }), /Migration step 3 failed: duplicate column name/)
    assert.equal(schemaVersion(), 2)
    closeDb()
    assert.ok(!inspect(file, tables).includes('half'))
  })

  test('a newer database is refused and left untouched', () => {
    const file = fresh()
    openDb(file)
    closeDb()
    inspect(file, (d) => d.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`))
    for (const opts of [undefined, { migrate: false }]) {
      assert.throws(
        () => openDb(file, opts),
        (err: unknown) => err instanceof NewerDatabaseError && err.fileVersion === LATEST_SCHEMA_VERSION + 1 && err.latest === LATEST_SCHEMA_VERSION
      )
    }
    assert.equal(inspect(file, userVersion), LATEST_SCHEMA_VERSION + 1)
  })
})

describe('migration 44: the Dashboard layout goes, the budget stays', () => {
  // A layout as the Dashboard or the phone saved it, and the Budget page's preferences as they've been kept: tiers,
  // commitments with the targets they replaced, hidden habits, the one-off budget, the cheaper grocer and the payoff
  // order chosen before debt.plan.
  const LAYOUT = JSON.stringify({ order: ['spendable', 'upcoming', 'headline', 'tiles'], hidden: ['debt', 'networth'] })
  const PREFS = JSON.stringify({
    tiers: { 'Dining Out': 'essential', Shopping: 'lifestyle' },
    commitments: { coffee: { optionId: 'half', label: 'Coffee out half as often', savingsCents: 4_000, category: 'Coffee', limit: { count: 8 } } },
    before: { Coffee: null },
    hidden: ['store:Groceries:Costco'],
    oneOffTargetCents: 30_000,
    cheaperStore: 'Aldi',
    debtStrategy: 'snowball'
  })
  const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
  /** Every setting but the layout, as stored. */
  const settings = (): Array<{ key: string; value: string }> => db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key != 'dashboard.layout' ORDER BY key")
  /** The budget's own tables, as stored. */
  const budgetRows = (): unknown[] => ['budgets', 'budget_targets', 'budget_rollover'].map((t) => db.all(`SELECT * FROM ${t} ORDER BY 1, 2`))
  /** A ledger at 43 with a layout and the budget's settings, as an older build left it. */
  function before44(file: string): { settings: ReturnType<typeof settings>; budget: unknown[] } {
    openDb(file, { migrate: false })
    migrate({ target: 43 })
    db.setSetting('dashboard.layout', LAYOUT)
    db.setSetting('budget.prefs', PREFS)
    db.setSetting('home.open', 'spendable')
    db.setSetting('budget.trips', JSON.stringify([{ id: 'iceland', name: 'Iceland', from: '2027-02-11', to: '2027-02-19' }]))
    db.setBudget(category('Coffee'), 12_000)
    db.setBudget(category('Dining Out'), 40_000)
    db.setRollover(category('Dining Out'), true)
    return { settings: settings(), budget: budgetRows() }
  }
  /** What reads the budget's settings, read through the budget. */
  async function readBack(): Promise<unknown> {
    const { essentialTier, getBudget, oneOffTarget } = await import('../src/main/budget.ts')
    const { debtPlan } = await import('../src/main/debts.ts')
    const b = getBudget(db.dayKey(db.now()).slice(0, 7))
    const essential = essentialTier()
    return { dining: essential('Dining Out'), shopping: essential('Shopping'), store: b.cheaperStore, oneOff: [oneOffTarget(), b.oneOffs.targetCents], order: debtPlan().strategy, home: db.getSetting('home.open') }
  }

  test('a ledger built before it: dashboard.layout is gone, and every other setting and the budget read the same', async () => {
    const file = fresh()
    const was = before44(file)
    assert.equal(schemaVersion(), 43)
    assert.equal(db.getSetting('dashboard.layout'), LAYOUT)
    const read = await readBack()
    assert.deepEqual(read, { dining: true, shopping: false, store: 'Aldi', oneOff: [30_000, 30_000], order: 'snowball', home: 'spendable' })
    assert.equal(migrate(), LATEST_SCHEMA_VERSION - 43)
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
    assert.equal(db.getSetting('dashboard.layout'), null)
    assert.deepEqual(settings(), was.settings)
    assert.equal(db.getSetting('budget.prefs'), PREFS)
    assert.deepEqual(budgetRows(), was.budget)
    assert.deepEqual(await readBack(), read)
    assert.deepEqual(checkIntegrity(), { corruption: [], foreignKeys: [] })
  })

  test('a fresh ledger has no layout, and nothing writes one', () => {
    openDb(fresh())
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'dashboard.%'")!.n, 0)
    assert.equal(migrate(), 0)
  })

  test('a backup made before it restores and migrates: the layout goes, the budget comes back whole', async () => {
    const { bulkBackup, checkBackupFile } = await import('../src/main/backup.ts')
    const file = fresh()
    const was = before44(file)
    const kept = await bulkBackup(join(dir, `backups-${n++}`))
    closeDb()
    // The backup is a sound copy of a ledger at 43, as Restore checks it before putting it in place.
    checkBackupFile(kept)
    assert.equal(inspect(kept, userVersion), 43)
    assert.equal(inspect(kept, (d) => (d.prepare("SELECT value FROM settings WHERE key = 'dashboard.layout'").get() as { value: string }).value), LAYOUT)
    // Restored, it opens as the ledger: every step runs on the way in.
    openDb(kept)
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
    assert.equal(db.getSetting('dashboard.layout'), null)
    assert.deepEqual(settings(), was.settings)
    assert.deepEqual(budgetRows(), was.budget)
    // And its export, as a move to a hosted ledger reads it, has the budget's settings and no layout.
    const exported = db.exportAll().tables as Record<string, Array<{ key?: string }>>
    const keys = exported.settings.map((r) => r.key)
    assert.ok(keys.includes('budget.prefs'))
    assert.ok(!keys.includes('dashboard.layout'))
  })

  test('a ledger at 33, as an older build keeps it: every step runs, the layout goes and the budget reads what it held', async () => {
    const file = fresh()
    openDb(file, { migrate: false })
    migrate({ target: 33 })
    // At 33 a target is one row in budgets: targets by month and rollover came at 34, and home.open after that.
    db.setSetting('dashboard.layout', LAYOUT)
    db.setSetting('budget.prefs', PREFS)
    db.setSetting('budget.trips', JSON.stringify([{ id: 'iceland', name: 'Iceland', from: '2027-02-11', to: '2027-02-19' }]))
    const coffee = category('Coffee')
    const dining = category('Dining Out')
    db.all('INSERT INTO budgets (category_id, cents) VALUES (?, ?), (?, ?)', coffee, 12_000, dining, 40_000)
    const was = settings()
    assert.equal(schemaVersion(), 33)
    assert.equal(migrate(), LATEST_SCHEMA_VERSION - 33)
    assert.equal(schemaVersion(), LATEST_SCHEMA_VERSION)
    assert.equal(db.getSetting('dashboard.layout'), null)
    assert.deepEqual(settings(), was)
    assert.equal(db.getSetting('budget.prefs'), PREFS)
    // Each target counts from the start, as targets set before they were kept by month do, and no rollover is on.
    assert.deepEqual([...db.listBudgets()].sort(([a], [b]) => a - b), [[coffee, 12_000], [dining, 40_000]].sort(([a], [b]) => a - b))
    assert.deepEqual(db.budgetHistory().get(coffee), [{ month: '0000-01', cents: 12_000 }])
    assert.deepEqual(db.budgetHistory().get(dining), [{ month: '0000-01', cents: 40_000 }])
    assert.equal(db.listRollovers().size, 0)
    // The layout's lead is not carried into home.open: Home opens on what onboarding's answer chose, and this ledger
    // has none.
    assert.deepEqual(await readBack(), { dining: true, shopping: false, store: 'Aldi', oneOff: [30_000, 30_000], order: 'snowball', home: null })
    assert.deepEqual(checkIntegrity(), { corruption: [], foreignKeys: [] })
  })
})
