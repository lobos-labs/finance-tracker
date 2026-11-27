import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '../src/main/sqlite.ts'
import { addFact, closeDb, LATEST_SCHEMA_VERSION, openDb } from '../src/main/db.ts'
import { backupBeforeMigration, backupBeforeRestore, bulkBackup, checkBackupFile, DAILY_CHECK_EVERY_MS, dailyBackup, KEEP, keepDailyBackups, listBackups, writeBackup } from '../src/main/backup.ts'

const dir = mkdtempSync(join(tmpdir(), 'finance-backup-'))
after(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
const folder = (): string => join(dir, `backups-${n++}`)
const at = (day: number, second = 0): Date => new Date(2026, 9, day, 21, 30, second)

describe('backups', () => {
  before(() => {
    openDb(join(dir, 'finance.db'))
    addFact('Rent is due on the 1st')
  })
  after(closeDb)

  test('a backup is a working copy of the open database', async () => {
    const dest = folder()
    const path = await bulkBackup(dest, at(20))
    assert.equal(path, join(dest, 'bulk-20261020-213000.db'))
    assert.ok(existsSync(path))
    assert.deepEqual(readdirSync(dest), ['bulk-20261020-213000.db'])
    const copy = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, LATEST_SCHEMA_VERSION)
      assert.deepEqual((copy.prepare('SELECT text FROM facts').all() as Array<{ text: string }>).map((r) => r.text), ['Rent is due on the 1st'])
    } finally {
      copy.close()
    }
    checkBackupFile(path)
  })

  test('rotation keeps exactly the configured count of a family, newest first to go last', async () => {
    const dest = folder()
    await dailyBackup(dest, at(1))
    for (let i = 1; i <= 5; i++) await writeBackup(dest, `bulk-20260101-00000${i}.db`, 3)
    assert.deepEqual(listBackups(dest, 'bulk'), ['bulk-20260101-000003.db', 'bulk-20260101-000004.db', 'bulk-20260101-000005.db'])
    assert.deepEqual(listBackups(dest, 'daily'), ['daily-20261001.db'])
    assert.equal(readdirSync(dest).length, 4)
    assert.deepEqual(KEEP, { pre: 3, daily: 7, bulk: 3 })
  })

  test('the safety copy before a restore drops nothing: the backup being restored may be the oldest of the three kept', async () => {
    const dest = folder()
    const chosen = await bulkBackup(dest, at(1))
    await bulkBackup(dest, at(2))
    await bulkBackup(dest, at(3))
    assert.equal(listBackups(dest, 'bulk').length, KEEP.bulk)
    // A fourth bulk backup would rotate the oldest away; the one made before a restore leaves it to be read.
    await backupBeforeRestore(dest, at(4))
    assert.ok(existsSync(chosen))
    assert.equal(listBackups(dest, 'bulk').length, KEEP.bulk + 1)
    // The next bulk backup brings the family back to its count.
    await bulkBackup(dest, at(5))
    assert.equal(listBackups(dest, 'bulk').length, KEEP.bulk)
  })

  test('backups before an upgrade rotate by time, not by version number', async () => {
    const dest = folder()
    for (const [version, day] of [[9, 1], [10, 2], [11, 3], [12, 4]] as const) await backupBeforeMigration(dest, version, at(day))
    assert.deepEqual(listBackups(dest, 'pre'), ['pre-v10-20261002-213000.db', 'pre-v11-20261003-213000.db', 'pre-v12-20261004-213000.db'])
  })

  test('the daily backup is made once a day and keeps a week', async () => {
    const dest = folder()
    assert.equal(await dailyBackup(dest, at(1)), join(dest, 'daily-20261001.db'))
    assert.equal(await dailyBackup(dest, at(1, 5)), null)
    for (let day = 2; day <= 9; day++) assert.ok(await dailyBackup(dest, at(day)))
    assert.deepEqual(
      listBackups(dest, 'daily'),
      [3, 4, 5, 6, 7, 8, 9].map((d) => `daily-2026100${d}.db`)
    )
  })

  test('a running app makes each day its backup: it looks at launch and every hour after, until stopped, and never with no database open', async () => {
    const dest = folder()
    const until = async (f: () => boolean): Promise<void> => {
      for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
    }
    const daily = (): string[] => (existsSync(dest) ? listBackups(dest, 'daily') : [])
    let today = at(10)
    let open = false
    const failures: unknown[] = []
    mock.timers.enable({ apis: ['setInterval'] })
    try {
      const stop = keepDailyBackups({ dir: () => dest, ready: () => open, failed: (err) => failures.push(err), now: () => today })
      // No database is open yet: nothing is written, and no folder is made.
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(existsSync(dest), false)
      open = true
      mock.timers.tick(DAILY_CHECK_EVERY_MS)
      await until(() => daily().length === 1)
      assert.deepEqual(daily(), ['daily-20261010.db'])
      // The same day an hour on: it is there already.
      mock.timers.tick(DAILY_CHECK_EVERY_MS)
      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(daily(), ['daily-20261010.db'])
      // The app was never closed: the next day has its own.
      today = at(11)
      mock.timers.tick(DAILY_CHECK_EVERY_MS)
      await until(() => daily().length === 2)
      assert.deepEqual(daily(), ['daily-20261010.db', 'daily-20261011.db'])
      stop()
      today = at(12)
      mock.timers.tick(DAILY_CHECK_EVERY_MS)
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(daily().length, 2)
      assert.deepEqual(failures, [])
    } finally {
      mock.timers.reset()
    }
  })

  test('a file that is not a sound database of this version is refused', () => {
    const text = join(dir, 'notes.db')
    writeFileSync(text, 'just some text that is long enough')
    assert.throws(() => checkBackupFile(text), /Not a SQLite database/)
    const newer = join(dir, 'newer.db')
    const d = new DatabaseSync(newer)
    d.exec(`CREATE TABLE t (x); PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`)
    d.close()
    assert.throws(() => checkBackupFile(newer), /newer than this version/)
  })

  afterEach(() => {
    // Nothing half-written is left beside the backups.
    for (const f of readdirSync(dir, { recursive: true }) as string[]) assert.ok(!f.endsWith('.tmp'), f)
  })
})
