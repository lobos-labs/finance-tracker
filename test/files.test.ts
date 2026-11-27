import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { documentProblem, isOpenableDocument } from '../src/main/files.ts'

const root = mkdtempSync(join(tmpdir(), 'finance-files-'))
const docs = join(root, 'documents')
const elsewhere = join(root, 'elsewhere')
after(() => rmSync(root, { recursive: true, force: true }))

describe('a stored path opens only as a document inside the documents folder', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = docs
    mkdirSync(join(docs, 'Receipts'), { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    for (const f of ['statement.pdf', 'SCAN.PDF', 'Receipts/visit.jpg', 'run.exe', 'open.lnk', 'odd.xyz', 'script.ps1', 'page.html', 'noext']) writeFileSync(join(docs, f), 'x')
    writeFileSync(join(elsewhere, 'secret.pdf'), 'x')
  })

  test('documents inside the folder, in any case', () => {
    assert.equal(isOpenableDocument(join(docs, 'statement.pdf')), true)
    assert.equal(isOpenableDocument(join(docs, 'SCAN.PDF')), true)
    assert.equal(isOpenableDocument(join(docs, 'Receipts', 'visit.jpg')), true)
    assert.equal(isOpenableDocument(join(docs, 'page.html')), true)
  })

  test('programs, shortcuts, scripts and unknown types are refused, even inside the folder', () => {
    for (const f of ['run.exe', 'open.lnk', 'odd.xyz', 'script.ps1', 'noext']) assert.equal(isOpenableDocument(join(docs, f)), false, f)
    assert.match(documentProblem(join(docs, 'run.exe'))!, /documents folder.*be a document/)
  })

  test('a document outside the folder is refused, and the reason names the rule', () => {
    const p = documentProblem(join(elsewhere, 'secret.pdf'))
    assert.match(p!, /inside the documents folder/)
    assert.match(p!, /outside it/)
  })

  test('relative paths are refused', () => {
    assert.equal(isOpenableDocument('statement.pdf'), false)
    assert.equal(isOpenableDocument(''), false)
    // Run from inside the folder, so each relative path names a document that is there. (From
    // another drive, as on GitHub's runners, relative() can only give back the full path.)
    const was = process.cwd()
    process.chdir(docs)
    try {
      for (const p of ['statement.pdf', join('Receipts', 'visit.jpg'), relative(docs, join(docs, 'SCAN.PDF'))]) assert.equal(isOpenableDocument(p), false, p)
    } finally {
      process.chdir(was)
    }
  })

  test('".." can neither escape nor is needed', () => {
    assert.equal(isOpenableDocument(join(docs, '..', 'elsewhere', 'secret.pdf')), false)
    assert.equal(isOpenableDocument(`${docs}${process.platform === 'win32' ? '\\' : '/'}..${process.platform === 'win32' ? '\\' : '/'}elsewhere${process.platform === 'win32' ? '\\' : '/'}secret.pdf`), false)
    assert.equal(isOpenableDocument(join(docs, 'Receipts', '..', 'statement.pdf')), true)
  })

  test('a missing file is refused', () => {
    assert.equal(isOpenableDocument(join(docs, 'missing.pdf')), false)
    assert.match(documentProblem(join(docs, 'missing.pdf'))!, /doesn't exist/)
  })

  test('a junction inside the folder that leads out is refused', () => {
    symlinkSync(elsewhere, join(docs, 'link'), 'junction')
    assert.equal(isOpenableDocument(join(docs, 'link', 'secret.pdf')), false)
    assert.match(documentProblem(join(docs, 'link', 'secret.pdf'))!, /outside it/)
  })

  test('a file link inside the folder that leads out is refused', (t) => {
    try {
      symlinkSync(join(elsewhere, 'secret.pdf'), join(docs, 'alias.pdf'), 'file')
    } catch {
      // Windows allows file links only to administrators or in developer mode.
      t.skip('file links need privileges here')
      return
    }
    assert.equal(isOpenableDocument(join(docs, 'alias.pdf')), false)
  })

  test('a link whose target is a different kind of file is refused', (t) => {
    try {
      symlinkSync(join(docs, 'run.exe'), join(docs, 'looks-fine.pdf'), 'file')
    } catch {
      t.skip('file links need privileges here')
      return
    }
    assert.equal(isOpenableDocument(join(docs, 'looks-fine.pdf')), false)
  })
})
