import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { getBudget } from '../src/main/budget.ts'
import { setTimeZone } from '../src/main/calendar.ts'
import { exportFileRefs, ImportRefused, ledgerEmpty, readExport, restoreExport, rewriteFileRefs, type FullExport } from '../src/main/ledgerImport.ts'
import { getSpendable } from '../src/main/spendable.ts'

// Moving the desktop's books into a hosted account (ledgerImport.ts): the full
// export restored into an empty ledger answers as the books it came from; the
// files the books point at are rewritten to uploads. The Ledger runs the same
// restore on a Durable Object (finance-server/test/ledger-move.test.ts).

const dir = mkdtempSync(join(tmpdir(), 'finance-move-'))
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400
const ZONE = 'America/Chicago'
const at = (n: number): number => {
  const d = new Date()
  d.setUTCHours(12, 0, 0, 0)
  return Math.floor(d.getTime() / 1000) + n * DAY
}
const cat = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const month = (): string => db.today().slice(0, 7)

/** A desktop database, filled the way the app fills it. */
function seed(): void {
  setTimeZone(ZONE)
  db.upsertAccount({ id: 'chk', source: 'plaid', name: 'Checking', institution: 'Test Bank', currency: 'USD', balanceCents: 312_000, availableCents: null, balanceDate: at(0) - 3600 })
  db.upsertAccount({ id: 'card', source: 'plaid', name: 'Card', institution: 'Test Bank', currency: 'USD', balanceCents: -45_000, availableCents: null, balanceDate: at(0) - 3600 })
  for (let m = 0; m < 4; m++) {
    db.insertTransactionIfNew({ id: `rent-${m}`, accountId: 'chk', posted: at(6 - Math.round((m + 1) * 30.44)), amountCents: -150_000, description: 'RENT LLC', pending: false })
    db.setTransactionFields(`rent-${m}`, { categoryId: cat('Housing'), source: 'user' })
  }
  for (let w = 0; w < 8; w++) {
    db.insertTransactionIfNew({ id: `pay-${w}`, accountId: 'chk', posted: at(4 - 14 * (w + 1)), amountCents: 240_000, description: 'ACME PAYROLL', pending: false })
    db.setTransactionFields(`pay-${w}`, { categoryId: cat('Paycheck'), source: 'user' })
  }
  for (let d = 1; d <= 40; d += 3) {
    db.insertTransactionIfNew({ id: `groc-${d}`, accountId: 'card', posted: at(-d), amountCents: -(4_000 + d * 37), description: 'FRESH GROCER #12', pending: false })
    db.setTransactionFields(`groc-${d}`, { categoryId: cat('Groceries'), source: 'ai', confidence: 'high' })
  }
  const venture = db.saveBucket({ name: 'Side gig', kind: 'business' })
  db.splitTransaction('groc-1', [
    { amountCents: -3_000, categoryId: cat('Groceries') },
    { amountCents: -(4_000 + 37 - 3_000), categoryId: cat('Shopping'), bucketId: venture }
  ])
  db.addTags(['groc-4'], ['treat'])
  db.saveCategory({ name: 'Llamas', kind: 'expense', description: 'Feed and shearing' })
  db.setBudget(cat('Groceries'), 60_000)
  db.setBudget(cat('Llamas'), 9_000)
  db.addFact('Rent is due on the 1st')
  db.setSetting('spend.cushionCents', '25000')
  db.setSetting('secret.simplefinAccessUrl', 'c2VjcmV0')
  db.setSetting('sync.mailbox', 'mb_desktop')
}

const answers = () => ({ spendable: getSpendable(), transactions: db.listTransactions({}), budget: getBudget(month()) })

describe('restoring the full export into an empty ledger', () => {
  let exported: FullExport
  let before: ReturnType<typeof answers>

  test('the export of a seeded desktop database, restored into a new one, answers the same', () => {
    db.openDb(join(dir, 'desktop.db'))
    seed()
    before = answers()
    assert.ok(before.transactions.rows.length > 20)
    exported = JSON.parse(JSON.stringify(db.exportAll())) as FullExport
    assert.ok(!ledgerEmpty())
    db.closeDb()

    db.openDb(join(dir, 'account.db'))
    setTimeZone(ZONE)
    assert.ok(ledgerEmpty())
    const out = restoreExport(readExport(exported))
    assert.equal(out.tables, Object.keys(exported.tables).length)
    assert.deepEqual(answers(), before)
    assert.ok(db.listCategories().some((c) => c.name === 'Llamas'))
    // Never written: secrets (not exported either) and the desktop's relay pairing.
    assert.equal(db.getSetting('secret.simplefinAccessUrl'), null)
    assert.equal(db.getSetting('sync.mailbox'), null)
    assert.equal(db.getSetting('spend.cushionCents'), '25000')
    assert.deepEqual(db.checkIntegrity(), { corruption: [], foreignKeys: [] })
  })

  test('a ledger with books refuses; so does another schema version', () => {
    assert.throws(() => restoreExport(exported), (e: unknown) => e instanceof ImportRefused && e.problem === 'not_empty')
    db.closeDb()
    db.openDb(join(dir, 'fresh.db'))
    assert.throws(() => restoreExport({ ...exported, schemaVersion: db.LATEST_SCHEMA_VERSION - 1 }), (e: unknown) => e instanceof ImportRefused && e.problem === 'schema' && e.details.exportVersion === db.LATEST_SCHEMA_VERSION - 1)
    assert.throws(() => restoreExport({ ...exported, tables: { ...exported.tables, llamas: [{ id: 1 }] } }), (e: unknown) => e instanceof ImportRefused && e.problem === 'shape')
    assert.throws(() => readExport({ tables: [] }), ImportRefused)
    // Nothing was written by a refusal.
    assert.ok(ledgerEmpty())
    assert.equal(db.listTransactions({}).rows.length, 0)
  })

  test('the logs and the default categories don\'t count as books', () => {
    db.addFact('A fact is books')
    assert.ok(!ledgerEmpty())
    db.closeDb()
    db.openDb(join(dir, 'fresh-2.db'))
    db.setSetting('calendar.timeZone', ZONE)
    db.saveCategory({ name: 'Mine', kind: 'expense', description: '' })
    assert.ok(ledgerEmpty())
  })
})

describe('the files the books point at', () => {
  const x = (): FullExport => ({
    schemaVersion: db.LATEST_SCHEMA_VERSION,
    exportedAt: '2026-11-03T00:00:00.000Z',
    tables: {
      transactions: [
        { id: 'a', receipt: 'Receipts/visit.pdf' },
        { id: 'b', receipt: 'C:\\Users\\me\\Documents\\Finance Tracker\\Receipts\\visit.pdf' },
        { id: 'c', receipt: null }
      ],
      settings: [
        { key: 'taxes', value: JSON.stringify({ years: [{ year: 2025, forms: [{ kind: 'W-2', file: 'Taxes/w2.pdf' }, { kind: '1099', file: 'Taxes/missing.pdf' }] }] }) },
        { key: 'credit', value: JSON.stringify({ scores: [], reports: [{ bureau: 'Equifax', file: 'Credit/eq.pdf' }], limits: [] }) },
        { key: 'insurance', value: JSON.stringify({ policies: [{ name: 'Auto', files: [{ file: 'Insurance/auto.pdf' }] }] }) },
        { key: 'ai.model', value: 'claude-opus-5-5' }
      ],
      documents: [{ name: 'Statements/oct.pdf', size: 10, summary: 'October', processed_at: 1_760_000_000 }]
    }
  })

  test('every path, once: receipts, tax forms, credit reports, policy documents and the documents the AI read', () => {
    assert.deepEqual(exportFileRefs(x()).sort(), ['C:\\Users\\me\\Documents\\Finance Tracker\\Receipts\\visit.pdf', 'Credit/eq.pdf', 'Insurance/auto.pdf', 'Receipts/visit.pdf', 'Statements/oct.pdf', 'Taxes/missing.pdf', 'Taxes/w2.pdf'])
  })

  test('each uploaded path becomes "<fileId>/<name>"; a path not uploaded stays; the AI\'s documents are listed for it', () => {
    const up = (fileId: string, name: string) => ({ fileId, name, size: 10, type: 'application/pdf' })
    const uploads = new Map([
      ['Receipts/visit.pdf', up('f_receipt0000000000', 'visit.pdf')],
      ['Taxes/w2.pdf', up('f_w2000000000000000', 'w2.pdf')],
      ['Credit/eq.pdf', up('f_eq000000000000000', 'eq.pdf')],
      ['Insurance/auto.pdf', up('f_auto0000000000000', 'auto.pdf')],
      ['Statements/oct.pdf', up('f_oct00000000000000', 'oct.pdf')]
    ])
    const out = rewriteFileRefs(x(), uploads, 1_770_000_000)
    assert.deepEqual(out.tables.transactions.map((t) => t.receipt), ['f_receipt0000000000/visit.pdf', 'C:\\Users\\me\\Documents\\Finance Tracker\\Receipts\\visit.pdf', null])
    const setting = (key: string) => JSON.parse(String(out.tables.settings.find((r) => r.key === key)!.value))
    assert.deepEqual(setting('taxes').years[0].forms.map((f: { file: string }) => f.file), ['f_w2000000000000000/w2.pdf', 'Taxes/missing.pdf'])
    assert.equal(setting('credit').reports[0].file, 'f_eq000000000000000/eq.pdf')
    assert.equal(setting('insurance').policies[0].files[0].file, 'f_auto0000000000000/auto.pdf')
    assert.equal(out.tables.documents[0].name, 'f_oct00000000000000/oct.pdf')
    assert.deepEqual(setting('documents.uploaded'), [{ fileId: 'f_oct00000000000000', name: 'oct.pdf', type: 'application/pdf', size: 10, addedAt: 1_760_000_000 }])
    assert.equal(out.tables.settings.find((r) => r.key === 'ai.model')!.value, 'claude-opus-5-5')
    // The export it came from is untouched.
    assert.equal(x().tables.transactions[0].receipt, 'Receipts/visit.pdf')
  })
})
