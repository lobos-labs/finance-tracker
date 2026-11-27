import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { configureBuild } from '../src/main/devBuild.ts'
import { moveFinish, moveSendCode, moveStatus } from '../src/main/moveToAccount.ts'

// Settings → Data → Move to an account (moveToAccount.ts) against a stubbed
// server: sign in by emailed code, check the account's ledger, upload the files
// the books point at, send the export with their paths rewritten, sign out.

const root = mkdtempSync(join(tmpdir(), 'finance-move-desktop-'))
const docs = join(root, 'docs')
const SERVER = 'https://app.example.test'

interface Sent {
  method: string
  path: string
  auth: string | null
  json: any
  form: FormData | null
}

let sent: Sent[] = []
let ledgerState = { empty: true, schemaVersion: db.LATEST_SCHEMA_VERSION }
let limitedOnce = false
let n = 0

async function server(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  const headers = new Headers(init?.headers)
  const s: Sent = {
    method: init?.method ?? 'GET',
    path: url.pathname,
    auth: headers.get('authorization'),
    json: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    form: init?.body instanceof FormData ? init.body : null
  }
  sent.push(s)
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } })
  if (url.origin !== SERVER) return reply({ error: 'not_found' }, 404)
  if (s.path === '/v1/auth/email/start') return reply({ sent: true })
  if (s.path === '/v1/auth/email/verify') return s.json.code === '123456' ? reply({ session: 'session-token', user: { id: 'u_1' }, isNew: true }) : reply({ error: 'code_invalid', triesLeft: 4 }, 400)
  if (s.path === '/v1/auth/logout') return reply({ ok: true })
  if (s.path === '/v1/ledger/import-desktop' && s.method === 'GET') return reply(ledgerState)
  if (s.path === '/v1/ledger/import-desktop') return reply({ tables: Object.keys(s.json.tables).length, rows: 99 })
  if (s.path === '/v1/ledger/files') {
    if (!limitedOnce) {
      limitedOnce = true
      return reply({ error: 'rate_limited', limit: 30, resetsAt: new Date(Date.now() + 2000).toISOString() }, 429, { 'retry-after': '2' })
    }
    const file = s.form!.get('file') as File
    return reply({ fileId: `f_upload${String(++n).padStart(12, '0')}`, name: file.name, size: file.size, type: 'application/pdf' }, 201)
  }
  return reply({ error: 'not_found' }, 404)
}

const slept: number[] = []
const deps = { fetch: server as typeof fetch, server: () => SERVER, sleep: async (ms: number) => void slept.push(ms) }

before(() => {
  process.env['FINANCE_TRACKER_DOCS_DIR'] = docs
  for (const f of ['Receipts/visit.pdf', 'Taxes/w2.pdf', 'Notes/plan.docx']) {
    mkdirSync(join(docs, f, '..'), { recursive: true })
    writeFileSync(join(docs, f), `%PDF-1.4 ${f}`)
  }
  db.openDb(join(root, 'finance.db'))
  db.upsertAccount({ id: 'chk', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: 1000, availableCents: null, balanceDate: null })
  db.insertTransactionIfNew({ id: 't1', accountId: 'chk', posted: 1_760_000_000, amountCents: -5000, description: 'DENTIST', pending: false })
  db.insertTransactionIfNew({ id: 't2', accountId: 'chk', posted: 1_760_100_000, amountCents: -900, description: 'PHARMACY', pending: false })
  db.run('UPDATE transactions SET receipt = ? WHERE id = ?', 'Receipts/visit.pdf', 't1')
  db.run('UPDATE transactions SET receipt = ? WHERE id = ?', 'Notes/plan.docx', 't2')
  db.setSetting('taxes', JSON.stringify({ years: [{ year: 2025, forms: [{ kind: 'W-2', file: 'Taxes/w2.pdf' }, { kind: '1099', file: 'Taxes/missing.pdf' }] }] }))
  db.setSetting('secret.licenseToken', 'never-sent')
})

after(() => {
  db.closeDb()
  delete process.env['FINANCE_TRACKER_DOCS_DIR']
  configureBuild({ packaged: false })
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  sent = []
  ledgerState = { empty: true, schemaVersion: db.LATEST_SCHEMA_VERSION }
})

describe('moving the books to an account', () => {
  test('a development build with a server offers it; a shipped build doesn\'t', async () => {
    assert.deepEqual(moveStatus(deps), { available: true, server: SERVER })
    assert.deepEqual(moveStatus({ ...deps, server: () => null }), { available: false, server: null })
    configureBuild({ packaged: true })
    try {
      assert.equal(moveStatus(deps).available, false)
      await assert.rejects(moveSendCode('me@example.com', deps), /development builds only/)
    } finally {
      configureBuild({ packaged: false })
    }
    assert.equal(sent.length, 0)
  })

  test('the code goes to the email on the configured server', async () => {
    await moveSendCode(' me@example.com ', deps)
    assert.deepEqual(sent.map((s) => [s.method, s.path]), [['POST', '/v1/auth/email/start']])
    assert.equal(sent[0].json.email, 'me@example.com')
    await assert.rejects(moveSendCode('not an email', deps), /Enter an email/)
  })

  test('signs in, uploads the files the books point at, sends the export with their paths rewritten, signs out', async () => {
    const r = await moveFinish('me@example.com', '123456', deps)
    assert.deepEqual(
      sent.map((s) => [s.method, s.path]),
      [
        ['POST', '/v1/auth/email/verify'],
        ['GET', '/v1/ledger/import-desktop'],
        ['POST', '/v1/ledger/files'],
        ['POST', '/v1/ledger/files'],
        ['POST', '/v1/ledger/files'],
        ['POST', '/v1/ledger/import-desktop'],
        ['POST', '/v1/auth/logout']
      ]
    )
    // Every call after the sign-in carries the session.
    for (const s of sent.slice(1)) assert.equal(s.auth, 'Bearer session-token')
    // The one upload refused for its rate waited out the Retry-After and went again.
    assert.deepEqual(slept, [2000])

    const moved = sent.find((s) => s.path === '/v1/ledger/import-desktop' && s.method === 'POST')!.json
    assert.equal(moved.schemaVersion, db.LATEST_SCHEMA_VERSION)
    const receipt = (id: string) => moved.tables.transactions.find((t: { id: string }) => t.id === id).receipt
    assert.match(receipt('t1'), /^f_upload\d{12}\/visit\.pdf$/)
    // A type the server doesn't take stays as it was, and is reported.
    assert.equal(receipt('t2'), 'Notes/plan.docx')
    const forms = JSON.parse(moved.tables.settings.find((s: { key: string }) => s.key === 'taxes').value).years[0].forms.map((f: { file: string }) => f.file)
    assert.match(forms[0], /^f_upload\d{12}\/w2\.pdf$/)
    assert.equal(forms[1], 'Taxes/missing.pdf')
    // No secrets, ever.
    assert.ok(!JSON.stringify(moved).includes('never-sent'))

    assert.deepEqual(r, { tables: Object.keys(moved.tables).length, rows: 99, files: 2, skipped: ['Notes/plan.docx', 'Taxes/missing.pdf'] })
  })

  test('an account with books, or another schema, stops before any upload; the session is signed out either way', async () => {
    ledgerState = { empty: false, schemaVersion: db.LATEST_SCHEMA_VERSION }
    await assert.rejects(moveFinish('me@example.com', '123456', deps), /already has books/)
    assert.deepEqual(sent.map((s) => s.path), ['/v1/auth/email/verify', '/v1/ledger/import-desktop', '/v1/auth/logout'])

    sent = []
    ledgerState = { empty: true, schemaVersion: db.LATEST_SCHEMA_VERSION + 1 }
    await assert.rejects(moveFinish('me@example.com', '123456', deps), /schema version/)
    assert.ok(!sent.some((s) => s.path === '/v1/ledger/files'))
    assert.equal(sent.at(-1)!.path, '/v1/auth/logout')
  })

  test('a wrong code is the server\'s answer; a malformed one never leaves', async () => {
    await assert.rejects(moveFinish('me@example.com', '000000', deps), /Wrong code/)
    assert.equal(sent.length, 1)
    sent = []
    await assert.rejects(moveFinish('me@example.com', '12', deps), /6-digit code/)
    assert.equal(sent.length, 0)
  })
})
