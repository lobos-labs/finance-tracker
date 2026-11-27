import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import * as db from '../src/main/db.ts'
import { documentProblem, documentRoots, fileFound, folderToAdopt, isLocalPath, isOpenableDocument, probeFiles } from '../src/main/files.ts'
import { extraDocsDirs, setExtraDocsDirs } from '../src/main/paths.ts'
import { linkReceipt } from '../src/main/receipts.ts'
import { listDocuments } from '../src/main/tools.ts'

// Extra document folders: the user's own forms can live outside the documents
// folder once their folder is allowed. Paths are never probed outside the
// allowed folders, and never on a share.

const root = mkdtempSync(join(tmpdir(), 'finance-folders-'))
const docs = join(root, 'documents')
const extra = join(root, 'Paperwork')
const elsewhere = join(root, 'elsewhere')
after(() => rmSync(root, { recursive: true, force: true }))

describe('extra document folders', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = docs
    db.openDb(':memory:')
    mkdirSync(join(docs, 'Receipts'), { recursive: true })
    mkdirSync(join(extra, '2025'), { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(docs, 'statement.pdf'), 'x')
    writeFileSync(join(docs, 'run.exe'), 'x')
    writeFileSync(join(docs, 'open.lnk'), 'x')
    writeFileSync(join(docs, 'CLAUDE.md'), 'x')
    writeFileSync(join(extra, '2025', 'w2.pdf'), 'x')
    writeFileSync(join(extra, 'setup.exe'), 'x')
    writeFileSync(join(elsewhere, 'secret.pdf'), 'x')
  })
  after(db.closeDb)

  test('the list is stored once each, as full paths', () => {
    assert.deepEqual(extraDocsDirs(), [])
    assert.deepEqual(setExtraDocsDirs([extra, extra, 'relative/path', '']), [extra])
    assert.deepEqual(extraDocsDirs(), [extra])
    assert.deepEqual(documentRoots(), [docs, extra])
  })

  test('a document in an extra folder opens; one outside every folder still does not', () => {
    assert.equal(isOpenableDocument(join(extra, '2025', 'w2.pdf')), true)
    assert.equal(isOpenableDocument(join(extra, 'setup.exe')), false)
    assert.equal(isOpenableDocument(join(elsewhere, 'secret.pdf')), false)
    assert.match(documentProblem(join(elsewhere, 'secret.pdf'))!, /extra document folder/)
    assert.match(documentProblem(join(elsewhere, 'secret.pdf'))!, /outside it/)
  })

  test('a share is never a document path', () => {
    assert.equal(isLocalPath(`${sep}${sep}server${sep}share${sep}w2.pdf`), process.platform !== 'win32' && sep === '/' ? false : false)
    if (process.platform === 'win32') {
      assert.equal(isLocalPath('\\\\server\\share\\w2.pdf'), false)
      assert.equal(isLocalPath('C:\\Users\\x\\w2.pdf'), true)
      assert.match(documentProblem('\\\\server\\share\\w2.pdf')!, /on this computer/)
    } else {
      assert.equal(isLocalPath('//server/share/w2.pdf'), false)
      assert.equal(isLocalPath('/home/x/w2.pdf'), true)
    }
    assert.equal(isLocalPath('w2.pdf'), false)
  })

  test('only the documents folder is watched for new documents, and only documents are listed', () => {
    const names = listDocuments().map((d) => d.name)
    assert.deepEqual(names, ['statement.pdf'])
    assert.ok(!names.some((n) => /\.(exe|lnk)$|CLAUDE/.test(n)))
  })

  test('whether a file is there is checked only inside the allowed folders', async () => {
    assert.equal(fileFound(join(elsewhere, 'secret.pdf')), false)
    assert.equal(fileFound(join(extra, '2025', 'w2.pdf')), true)
    assert.equal(fileFound(join(extra, '2025', 'missing.pdf')), false)
    await probeFiles([join(extra, '2025', 'w2.pdf'), join(elsewhere, 'secret.pdf'), '\\\\server\\share\\w2.pdf'])
    assert.equal(fileFound(join(extra, '2025', 'w2.pdf')), true)
    assert.equal(fileFound(join(elsewhere, 'secret.pdf')), false)
    assert.equal(fileFound('\\\\server\\share\\w2.pdf'), false)
  })

  test('the folder to adopt for an old path is the first folder below the nearest base', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\x' : '/home/x'
    const desktop = join(home, 'OneDrive', 'Desktop')
    const bases = [desktop, join(home, 'Documents'), home]
    assert.equal(folderToAdopt(join(desktop, 'Paperwork', '2024', 'w2.pdf'), bases), join(desktop, 'Paperwork'))
    assert.equal(folderToAdopt(join(home, 'Documents', 'Tax', 'w2.pdf'), bases), join(home, 'Documents', 'Tax'))
    // A file right on the Desktop falls through to the home folder's first folder: the Desktop's parent.
    assert.equal(folderToAdopt(join(desktop, 'w2.pdf'), bases), join(home, 'OneDrive'))
    assert.equal(folderToAdopt(join(home, 'w2.pdf'), bases), null)
    assert.equal(folderToAdopt(process.platform === 'win32' ? 'D:\\other\\w2.pdf' : '/other/w2.pdf', bases), null)
    assert.equal(folderToAdopt('\\\\server\\share\\w2.pdf', bases), null)
  })

  test('only a document can be linked as a receipt', () => {
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.upsertTransaction({ id: 't1', accountId: 'manual:a', posted: 1_760_000_000, amountCents: -1234, description: 'DR SMITH', pending: false })
    assert.throws(() => linkReceipt(['t1'], 'Receipts/visit.lnk'), /receipt can be/)
    assert.equal(linkReceipt(['t1'], 'Receipts/visit.pdf'), 1)
    assert.equal(linkReceipt(['t1'], null), 1)
  })
})
