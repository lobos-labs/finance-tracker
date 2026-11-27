import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentPath, documentProblem, withoutDocumentRoots } from '../src/main/files.ts'

// A stored document goes to a model by its name in the documents folder, never by the folder's own path, which
// carries the computer's user name. Names come back the same way and are resolved here.

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'finance-names-'))
const docs = join(root, 'home', 'someone', 'Documents', 'Finance Tracker')
const extra = join(root, 'home', 'someone', 'Desktop', 'Paperwork')
after(() => rmSync(root, { recursive: true, force: true }))

describe('document names, not paths', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = docs
    mkdirSync(join(docs, 'Tax'), { recursive: true })
    mkdirSync(join(extra, '2025'), { recursive: true })
    writeFileSync(join(docs, 'Tax', 'w2.pdf'), 'x')
    writeFileSync(join(extra, '2025', 'return.pdf'), 'x')
  })

  test("a tool's answer loses the documents folder's own path, as text and inside JSON, with either separator", () => {
    const file = join(docs, 'Tax', 'w2.pdf')
    const json = JSON.stringify({ forms: [{ name: 'W-2', file }], folder: docs })
    const out = withoutDocumentRoots(json, [docs, extra])
    assert.doesNotMatch(out, /someone/)
    assert.deepEqual(JSON.parse(out).forms[0].name, 'W-2')
    assert.match(JSON.parse(out).forms[0].file, /^Tax[\\/]w2\.pdf$/)
    assert.equal(JSON.parse(out).folder, 'the documents folder')
    // Plain text, as an error says it, and a path written with forward slashes.
    assert.equal(withoutDocumentRoots(`${file} doesn't exist`, [docs]).replace(/\\/g, '/'), "Tax/w2.pdf doesn't exist")
    assert.equal(withoutDocumentRoots(`open ${docs.split('\\').join('/')}/Tax/w2.pdf`, [docs]), 'open Tax/w2.pdf')
  })

  test("a file in an extra folder reads under that folder's own name", () => {
    const out = withoutDocumentRoots(JSON.stringify({ file: join(extra, '2025', 'return.pdf') }), [docs, extra])
    assert.doesNotMatch(out, /someone/)
    assert.match(JSON.parse(out).file, /^Paperwork\/2025[\\/]return\.pdf$/)
  })

  test('text with no path in it is left as it is', () => {
    const text = JSON.stringify({ ok: true, note: 'Documents are in the documents folder' })
    assert.equal(withoutDocumentRoots(text, [docs, extra]), text)
  })

  test('a name in the documents folder comes back as its full path, with either separator', () => {
    assert.equal(documentPath('Tax/w2.pdf'), join(docs, 'Tax', 'w2.pdf'))
    assert.equal(documentPath('Tax\\w2.pdf'.split('\\').join(process.platform === 'win32' ? '\\' : '/')), join(docs, 'Tax', 'w2.pdf'))
    assert.equal(documentPath(join(docs, 'Tax', 'w2.pdf')), join(docs, 'Tax', 'w2.pdf'))
  })

  test('a problem names the file as it was given, never the folder it resolved to', () => {
    assert.throws(() => documentPath('Tax/missing.pdf'), (err: Error) => /Tax\/missing\.pdf doesn't exist/.test(err.message) && !/someone/.test(err.message))
    const problem = documentProblem(join(docs, 'Tax', 'missing.pdf'), 'Tax/missing.pdf')
    assert.match(problem ?? '', /^File paths must be inside the documents folder; Tax\/missing\.pdf doesn't exist$/)
    // The rule itself no longer spells the folder's path out.
    assert.doesNotMatch(documentProblem('') ?? '', /someone|Finance Tracker/)
  })

  test('every answer and every error a model gets passes through it: Review on a key, and the connector', () => {
    const source = (file: string): string => readFileSync(join(here, '..', 'src', 'main', file), 'utf8')
    const review = source('review.ts')
    assert.match(review, /content: r\.content \?\? withoutDocumentRoots\(JSON\.stringify\(r\.result\)\)\.slice\(0, RESULT_LIMIT\)/)
    assert.match(review, /content: withoutDocumentRoots\(err instanceof Error \? err\.message : String\(err\)\), is_error: true/)
    const mcp = source('mcp.ts')
    assert.match(mcp, /text: withoutDocumentRoots\(JSON\.stringify\(v\) \?\? 'null'\)\.slice\(0, MCP_RESULT_LIMIT\)/)
    assert.match(mcp, /text: withoutDocumentRoots\(err instanceof Error \? err\.message : String\(err\)\) \}\], isError: true/)
  })
})
