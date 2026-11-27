import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAGE_CHARS, readDocument, saveAttachment, stripHtml } from '../src/main/documents.ts'

// read_document hands the model a file from the documents folder as the
// Messages API takes it: a PDF as a document block, a picture as an image
// block, text in pages. Nothing outside the folder opens.

const root = mkdtempSync(join(tmpdir(), 'finance-docs-'))
const docs = join(root, 'documents')
const elsewhere = join(root, 'elsewhere')
after(() => rmSync(root, { recursive: true, force: true }))

// A 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
// The smallest PDF that declares two pages.
const PDF = [
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
  '4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF'
].join('\n')

describe('read_document', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = docs
    mkdirSync(join(docs, 'Statements'), { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(docs, 'note.txt'), 'Closing balance 1,234.56 on 2026-09-30')
    writeFileSync(join(docs, 'long.md'), `${'a'.repeat(PAGE_CHARS)}${'b'.repeat(10)}`)
    writeFileSync(join(docs, 'page.html'), '<html><head><style>p { color: red }</style><script>alert(1)</script></head><body><h1>Bill</h1><p>Due &amp; payable: $42</p></body></html>')
    writeFileSync(join(docs, 'Statements', 'scan.png'), PNG)
    writeFileSync(join(docs, 'Statements', 'statement.pdf'), PDF)
    writeFileSync(join(docs, 'sheet.xlsx'), 'x')
    writeFileSync(join(elsewhere, 'secret.pdf'), PDF)
  })

  test('a text file comes back as a text block', () => {
    const r = readDocument('note.txt')
    assert.equal(r.result.kind, 'text')
    assert.deepEqual([r.result.page, r.result.pages], [1, 1])
    assert.deepEqual(r.content, [{ type: 'text', text: 'Closing balance 1,234.56 on 2026-09-30' }])
  })

  test('long text comes in pages', () => {
    const one = readDocument('long.md')
    assert.deepEqual([one.result.page, one.result.pages], [1, 2])
    assert.equal(one.content[0].type, 'text')
    assert.match((one.content[0] as { text: string }).text, /^long\.md, page 1 of 2:\na+$/)
    const two = readDocument('long.md', 2)
    assert.equal(two.result.page, 2)
    assert.match((two.content[0] as { text: string }).text, /^long\.md, page 2 of 2:\nb{10}$/)
    // Past the end is the last page.
    assert.equal(readDocument('long.md', 9).result.page, 2)
  })

  test('html loses its tags, scripts and styles', () => {
    assert.equal(stripHtml('<p>Hello <b>there</b></p><script>x()</script>'), 'Hello there')
    const r = readDocument('page.html')
    assert.deepEqual(r.content, [{ type: 'text', text: 'Bill\nDue & payable: $42' }])
  })

  test('a PNG comes back as an image block', () => {
    const r = readDocument('Statements/scan.png')
    assert.equal(r.result.kind, 'image')
    assert.deepEqual(r.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }])
  })

  test('a PDF comes back as a document block with its page count', () => {
    const r = readDocument('Statements/statement.pdf')
    assert.deepEqual(r.result, { name: 'Statements/statement.pdf', kind: 'pdf', bytes: Buffer.byteLength(PDF), pages: 2 })
    assert.deepEqual(r.content, [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(PDF).toString('base64') }, title: 'Statements/statement.pdf' }])
  })

  test('a full path inside the folder works too', () => {
    assert.equal(readDocument(join(docs, 'note.txt')).result.kind, 'text')
  })

  test('anything outside the documents folder is refused', () => {
    assert.throws(() => readDocument(join(elsewhere, 'secret.pdf')), /inside the documents folder.*outside it/)
    assert.throws(() => readDocument('../elsewhere/secret.pdf'), /outside it/)
    assert.throws(() => readDocument(''), /no path was given/)
    assert.throws(() => readDocument('missing.pdf'), /doesn't exist/)
  })

  test('a kind the model cannot take is refused with a reason', () => {
    assert.throws(() => readDocument('sheet.xlsx'), /can't be read here \(xlsx\)/)
  })
})

describe('chat attachments', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = docs
  })

  test('a pasted image is saved under Chat, named by its content, once', () => {
    const name = saveAttachment('image.png', PNG)
    assert.match(name, /^Chat\/image [0-9a-f]{10}\.png$/)
    assert.ok(existsSync(join(docs, name)))
    assert.equal(saveAttachment('image.png', PNG), name)
    assert.equal(readDocument(name).result.kind, 'image')
  })

  test('a dropped PDF keeps its name', () => {
    const name = saveAttachment('C:\\Users\\someone\\Downloads\\Chase statement.pdf', Buffer.from(PDF))
    assert.match(name, /^Chat\/Chase statement [0-9a-f]{10}\.pdf$/)
    assert.equal(readDocument(name).result.pages, 2)
  })

  test('other kinds and empty files are refused', () => {
    assert.throws(() => saveAttachment('run.exe', PNG), /Attach a PDF/)
    assert.throws(() => saveAttachment('empty.pdf', Buffer.alloc(0)), /empty/)
  })
})
