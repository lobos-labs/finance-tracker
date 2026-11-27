import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from '../src/main/db.ts'
import { importCsv, preview as csvPreview } from '../src/main/csvImport.ts'
import { planState } from '../src/main/license.ts'
import { decodeEntities, decodeText, looksInverted, ofxAmount, ofxDay, parseOfx, STATEMENTS_MAX, type ParsedStatement } from '../src/main/ofx.ts'
import { parseQif, qifDate } from '../src/main/qif.ts'
import { importStatement, MAX_BYTES, preview, readStatement } from '../src/main/statementImport.ts'
import type { StatementTarget } from '../src/shared/types.ts'
import { noonOn } from './days.ts'

// QFX/OFX and QIF files: the two parsers over synthetic statements (OFX 1.x
// SGML, OFX 2.x XML, QIF bank and card), then the import: ids that make a
// second import add nothing, the bank-feed rule, closing balances, and files
// built to break the parser.

const fixtures = fileURLToPath(new URL('./fixtures/statements/', import.meta.url))
const fixture = (name: string): string => readFileSync(join(fixtures, name), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'ft-ofx-'))
let files = 0
const file = (text: string | Uint8Array, ext = 'qfx'): string => {
  const p = join(dir, `statement-${files++}.${ext}`)
  writeFileSync(p, text)
  return p
}
const copy = (name: string, transform: (s: string) => string = (s) => s): string => file(transform(fixture(name)), name.split('.').pop())
const noon = noonOn
const crlf = (s: string): string => s.replace(/\n/g, '\r\n')
const rowsOf = (s: ParsedStatement): Array<[number, number, string]> => s.rows.map((r) => [r.posted, r.amountCents, r.description])

before(() => db.openDb(join(dir, 'test.db')))
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const CHECKING_ROWS: Array<[number, number, string]> = [
  [noon(2026, 10, 1), 250000, 'ACME PAYROLL DIRECT DEP'],
  [noon(2026, 10, 3), -450, 'BLUE BOTTLE COFFEE'],
  [noon(2026, 10, 3), -450, 'BLUE BOTTLE COFFEE'],
  [noon(2026, 10, 5), -185000, 'CHECK #1042'],
  // 23:00 Pacific is the 8th in UTC; the day stays as written
  [noon(2026, 10, 7), -20000, 'ONLINE TRANSFER TO SAVINGS ...4321'],
  [noon(2026, 10, 9), -1599, 'NETFLIX.COM 866-579-7172 CA'],
  [noon(2026, 10, 11), -6210, 'AT&T WIRELESS'],
  [noon(2026, 10, 15), 42, 'Interest']
]

const CARD_ROWS: Array<[number, number, string]> = [
  [noon(2026, 10, 2), -5412, "TRADER JOE'S #552"],
  [noon(2026, 10, 3), -4000, 'SHELL OIL 5744'],
  [noon(2026, 10, 4), -2399, 'AMAZON MKTPL*2K4'],
  [noon(2026, 10, 5), -1199, 'SPOTIFY USA'],
  [noon(2026, 10, 6), 50000, 'PAYMENT THANK YOU'],
  [noon(2026, 10, 9), 1250, 'REFUND AMAZON']
]

/** A minimal OFX 1.x bank statement around the given STMTTRN blocks. */
const sgml = (txns: string, extra = ''): string =>
  `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD${extra}<BANKACCTFROM><BANKID>1<ACCTID>55554444<ACCTTYPE>SAVINGS</BANKACCTFROM><BANKTRANLIST>${txns}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
const trn = (fitid: string, day: string, amount: string, name: string, type = 'DEBIT'): string => `<STMTTRN><TRNTYPE>${type}<DTPOSTED>${day}<TRNAMT>${amount}<FITID>${fitid}<NAME>${name}</STMTTRN>`

describe('OFX', () => {
  test('a 1.x SGML bank statement: rows, account, balance, institution', () => {
    const f = parseOfx(fixture('checking-ofx1.qfx'))
    assert.equal(f.format, 'ofx')
    assert.equal(f.institution, 'Synthetic Savings & Loan')
    assert.equal(f.statements.length, 1)
    const s = f.statements[0]
    assert.deepEqual({ kind: s.kind, bankId: s.bankId, last4: s.last4, label: s.label, balanceCents: s.balanceCents, balanceDay: s.balanceDay, invalid: s.invalid }, { kind: 'bank', bankId: '011000015', last4: '6789', label: 'Checking', balanceCents: 432187, balanceDay: '2026-10-15', invalid: 1 })
    assert.deepEqual(rowsOf(s), CHECKING_ROWS)
    assert.deepEqual(s.rows.map((r) => r.fitId).slice(0, 2), ['2026100101', '2026100301'])
    assert.equal(s.rows[3].type, 'CHECK')
    // the transfer's BANKACCTTO is not the statement's account
    assert.ok(!JSON.stringify(f).includes('999988884321') && !JSON.stringify(f).includes('000123456789'))
    assert.equal(looksInverted(s), false)
  })

  test('CRLF, CR and a byte-order mark read the same', () => {
    const plain = parseOfx(fixture('checking-ofx1.qfx'))
    assert.deepEqual(parseOfx(crlf(fixture('checking-ofx1.qfx'))), plain)
    assert.deepEqual(parseOfx(fixture('checking-ofx1.qfx').replace(/\n/g, '\r')), plain)
    assert.deepEqual(parseOfx(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(fixture('checking-ofx1.qfx'))]))), plain)
  })

  test('a 2.x XML card statement: payee aggregate, empty memos, a foreign-currency row left out', () => {
    const f = parseOfx(fixture('card-ofx2.ofx'))
    assert.equal(f.institution, 'Example Card Services')
    const s = f.statements[0]
    assert.deepEqual({ kind: s.kind, bankId: s.bankId, last4: s.last4, label: s.label, balanceCents: s.balanceCents, balanceDay: s.balanceDay, invalid: s.invalid }, { kind: 'card', bankId: null, last4: '9876', label: 'Credit card', balanceCents: -123456, balanceDay: '2026-10-15', invalid: 1 })
    assert.deepEqual(rowsOf(s), CARD_ROWS)
    // OFX signs a card from the holder's view: purchases negative, the payment positive
    assert.equal(looksInverted(s), false)
  })

  test('dates in every form the spec allows, as the day written', () => {
    for (const raw of ['20261015', '202610151200', '20261015120000', '20261015120000.000', '20261015120000.000[-5:EST]', '20261015235959[-8:PST]', '20261015120000[+5.30:IST]', '20261015000000[0:GMT]', ' 20261015 ']) assert.equal(ofxDay(raw), '2026-10-15', raw)
    for (const raw of ['2026-10-15', '20261345', '20260230', '2026101', '20261015120000.000[-5:EST', 'x', '', undefined]) assert.equal(ofxDay(raw), null, String(raw))
  })

  test('amounts: signs, a decimal comma, and nothing past the cap', () => {
    assert.equal(ofxAmount('-12.34'), -1234)
    assert.equal(ofxAmount('+5'), 500)
    assert.equal(ofxAmount('12.'), 1200)
    assert.equal(ofxAmount('.5'), 50)
    assert.equal(ofxAmount('12,34'), 1234)
    assert.equal(ofxAmount('-0,5'), -50)
    assert.equal(ofxAmount('12.345'), 1235)
    // a comma before three digits is a thousands separator OFX doesn't allow: unreadable, not $1.23
    assert.equal(ofxAmount('1,234'), null)
    assert.equal(ofxAmount('-1,234'), null)
    assert.equal(ofxAmount('-1,2345'), null)
    for (const raw of ['1,234.56', '1e5', '$5', '--5', '5-', 'NaN', 'Infinity', '9'.repeat(30), '99999999999999.99', '', undefined]) assert.equal(ofxAmount(raw), null, String(raw))
  })

  test('entities, including numbers that are not characters', () => {
    assert.equal(decodeEntities('AT&amp;T &lt;b&gt; &quot;x&quot; &#38; &#x26; &#0;&#xD800;&#x110000; &bogus; & &amp'), 'AT&T <b> "x" & &  &bogus; & &amp')
  })

  test('Windows-1252 text is read as such', () => {
    // é is one byte (0xE9) in Windows-1252, which isn't valid UTF-8
    const bytes = Buffer.from(sgml(trn('1', '20261001', '-3.00', 'CAF~'))).map((b) => (b === 0x7e ? 0xe9 : b))
    assert.equal(parseOfx(decodeText(bytes)).statements[0].rows[0].description, 'CAFé')
    assert.equal(parseOfx(decodeText(Buffer.from(sgml(trn('1', '20261001', '-3.00', 'CAFé'))))).statements[0].rows[0].description, 'CAFé')
  })

  test('another currency is refused in one line', () => {
    assert.throws(() => parseOfx(sgml(trn('1', '20261001', '-3.00', 'X')).replace('<CURDEF>USD', '<CURDEF>EUR')), /^Error: This file is in EUR; only US dollars can be imported\.$/)
    assert.throws(() => parseOfx(sgml('').replace('<CURDEF>USD', `<CURDEF>\u0007${'Z'.repeat(5000)}`)), /^Error: This file is in ZZZ; only US dollars can be imported\.$/)
  })

  test('a bank and a card statement in one file', () => {
    const card = '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>1111222233334444</CCACCTFROM><BANKTRANLIST>' + trn('c1', '20261002', '-9.99', 'CARD ROW') + '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>'
    const f = parseOfx(sgml(trn('b1', '20261001', '-1.00', 'BANK ROW')).replace('</OFX>', card))
    assert.deepEqual(f.statements.map((s) => [s.kind, s.last4, s.rows.length]), [['bank', '4444', 1], ['card', '4444', 1]])
  })

  test('empty SGML leaves (<NAME>, <MEMO>, <BRANCHID>, <CHECKNUM> with no value) are leaves, not aggregates', () => {
    const f = parseOfx(fixture('empty-leaves-ofx1.qfx'))
    assert.equal(f.institution, 'Synthetic Credit Union')
    const s = f.statements[0]
    assert.deepEqual([s.kind, s.bankId, s.last4, s.label, s.invalid, s.balanceCents, s.balanceDay], ['bank', '011000015', '1234', 'Checking', 0, 100000, '2026-10-10'])
    assert.deepEqual(rowsOf(s), [
      [noon(2026, 10, 6), -5000, 'HARDWARE STORE'],
      [noon(2026, 10, 7), -1234, 'BLUE BOTTLE'],
      [noon(2026, 10, 8), -100000, 'RENT']
    ])
    assert.deepEqual(s.rows.map((r) => r.fitId), ['A2', 'A3', 'A4'])
    // the probe's shapes: a leaf left empty before its siblings
    const probe = parseOfx(sgml('<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<NAME>\n<TRNAMT>-50.00<FITID>A2<MEMO>x</STMTTRN>').replace('<BANKID>1<', '<BANKID>1<BRANCHID>\n<')).statements[0]
    assert.deepEqual([probe.last4, probe.label, probe.invalid, rowsOf(probe)], ['4444', 'Savings', 0, [[noon(2026, 10, 6), -5000, 'x']]])
  })

  test('a statement with nothing in it is left out; a file of too many is refused', () => {
    const empty = '<STMTRS><CURDEF>USD</STMTRS>'
    assert.equal(parseOfx(`<OFX>${empty.repeat(10_000)}</OFX>`).statements.length, 0)
    assert.throws(() => readStatement(file(`<OFX>${empty.repeat(10_000)}</OFX>`)), /No bank or card statement/)
    assert.equal(parseQif('!Type:Bank\n^\n'.repeat(10_000)).statements.length, 0)
    const one = (n: number): string => `<STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>${1000 + n}</BANKACCTFROM><BANKTRANLIST>${trn(String(n), '20261001', '-1.00', 'X')}</BANKTRANLIST></STMTRS>`
    assert.equal(parseOfx(`<OFX>${Array.from({ length: STATEMENTS_MAX }, (_, i) => one(i)).join('')}</OFX>`).statements.length, STATEMENTS_MAX)
    assert.throws(() => parseOfx(`<OFX>${Array.from({ length: STATEMENTS_MAX + 1 }, (_, i) => one(i)).join('')}</OFX>`), /^Error: That file holds too many statements\.$/)
    assert.throws(() => parseQif('!Type:Bank\nD10/1/26\nT-1\n^\n'.repeat(STATEMENTS_MAX + 1)), /too many statements/)
    // a statement with only a closing balance still counts
    assert.equal(parseOfx(sgml('').replace('</BANKTRANLIST>', '</BANKTRANLIST><LEDGERBAL><BALAMT>5.00<DTASOF>20261001</LEDGERBAL>')).statements.length, 1)
  })

  test('an investment statement is left out', () => {
    const f = parseOfx('<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD<INVTRANLIST><INVBANKTRAN><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>5.00<FITID>1</STMTTRN></INVBANKTRAN></INVTRANLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>')
    assert.equal(f.statements.length, 0)
  })

  test('reversed signs are noticed: typed rows that contradict their type, or a card that is mostly positive', () => {
    const reversed = parseOfx(sgml(trn('1', '20261001', '5.00', 'A') + trn('2', '20261002', '6.00', 'B') + trn('3', '20261003', '-100.00', 'PAY', 'CREDIT') + trn('4', '20261004', '7.00', 'C'))).statements[0]
    assert.equal(looksInverted(reversed), true)
    const untyped = (amounts: number[]): ParsedStatement => ({ kind: 'card', bankId: null, last4: null, label: null, balanceCents: null, balanceDay: null, invalid: 0, rows: amounts.map((a, i) => ({ posted: noon(2026, 10, i + 1), amountCents: a, description: 'x', fitId: null, type: 'POS' })) })
    assert.equal(looksInverted(untyped([100, 200, 300, -500])), true)
    assert.equal(looksInverted(untyped([-100, -200, -300, 500])), false)
    assert.equal(looksInverted({ ...untyped([100, 200, 300, -500]), kind: 'bank' }), false)
  })

  test('hostile and broken input: not OFX, nesting, garbage, absurd values', () => {
    assert.throws(() => parseOfx('Date,Description,Amount\n10/01/2026,x,1\n'), /Not an OFX or QFX file/)
    assert.throws(() => parseOfx(`<OFX>${'<A>'.repeat(100_000)}</A>`), /nests too deeply/)
    assert.throws(() => parseOfx(`<OFX>${'<STMTTRN>'.repeat(100_000)}`), /nests too deeply/)
    // a tag never closed isn't an aggregate, so it can't nest
    assert.equal(parseOfx(`<OFX>${'<A>'.repeat(100_000)}`).statements.length, 0)
    // a tag soup after <OFX> reads as nothing
    assert.equal(parseOfx(`<OFX><<<>>><STMTRS <x="1"> </ <\u0000 ${'<B'.repeat(1000)} &#99999999;`).statements.length, 0)
    const huge = parseOfx(sgml(trn('1', '20261001', '9'.repeat(5000), 'X') + trn('2', '20261001', '1e309', 'Y') + trn('3', '20261001', '-1.00', 'Z'.repeat(200_000)) + '<STMTTRN><TRNTYPE>DEBIT</STMTTRN>')).statements[0]
    assert.equal(huge.invalid, 3)
    assert.equal(huge.rows.length, 1)
    assert.equal(huge.rows[0].description.length, 300)
    // an empty SGML leaf is a leaf: the row keeps its name
    const loose = parseOfx(sgml('<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>-1.00<FITID>9<MEMO><NAME>X</STMTTRN>' + trn('10', '20261002', '-2.00', 'NEXT'))).statements[0]
    assert.deepEqual(loose.rows.map((r) => [r.amountCents, r.description]), [[-100, 'X'], [-200, 'NEXT']])
    // inputs built to make a scanner go quadratic stay linear: unclosed comments and declarations, a sea of "<", long amounts
    const big = (unit: string): string => unit.repeat(Math.floor(5_000_000 / unit.length))
    for (const body of [big('<!--'), big('<!'), big('<') + '>', big('<A' + 'B'.repeat(500)), big('<![CDATA['), big(`<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>${'9'.repeat(60)}x<FITID>1</STMTTRN>`)]) {
      const t0 = Date.now()
      parseOfx(`<OFX>${body}`)
      assert.ok(Date.now() - t0 < 5000, `${body.slice(0, 20)}… took ${Date.now() - t0} ms`)
    }
    const t0 = Date.now()
    parseQif(`!Type:Bank\n${big(`D10/1/26\nT${'9'.repeat(60)}x\n^\n`)}`)
    assert.ok(Date.now() - t0 < 5000)
    // a truncated file still yields what it had
    const cut = sgml(trn('1', '20261001', '-1.00', 'A') + trn('2', '20261002', '-2.00', 'B'))
    const short = parseOfx(cut.slice(0, cut.indexOf('<TRNAMT>-2.00'))).statements[0]
    assert.deepEqual([short.rows.length, short.invalid], [1, 1])
  })
})

describe('QIF', () => {
  test('dates: slash, apostrophe, padded, four-digit and ISO', () => {
    const y = 2026
    assert.equal(qifDate('10/15/26', y), noon(2026, 10, 15))
    assert.equal(qifDate("10/15'26", y), noon(2026, 10, 15))
    assert.equal(qifDate("10/15' 6", y), noon(2006, 10, 15))
    assert.equal(qifDate(" 1/ 5' 5", y), noon(2005, 1, 5))
    assert.equal(qifDate('10/15/2026', y), noon(2026, 10, 15))
    assert.equal(qifDate('10/15/98', y), noon(1998, 10, 15))
    assert.equal(qifDate('10/15/27', y), noon(2027, 10, 15))
    assert.equal(qifDate('10-15-26', y), noon(2026, 10, 15))
    assert.equal(qifDate('2026-10-15', y), noon(2026, 10, 15))
    for (const raw of ['13/01/26', '02/30/2026', '10/15/026', '10/15', 'yesterday', '']) assert.equal(qifDate(raw, y), null, raw)
  })

  test('a bank register: the opening balance is a balance, splits and addresses are left out', () => {
    const f = parseQif(fixture('checking.qif'))
    assert.equal(f.format, 'qif')
    assert.equal(f.statements.length, 1)
    const s = f.statements[0]
    assert.deepEqual({ kind: s.kind, last4: s.last4, label: s.label, balanceCents: s.balanceCents, balanceDay: s.balanceDay, invalid: s.invalid }, { kind: 'bank', last4: null, label: null, balanceCents: 100000, balanceDay: '2026-09-30', invalid: 2 })
    assert.deepEqual(rowsOf(s), [
      [noon(2026, 10, 1), 250000, 'ACME PAYROLL'],
      [noon(2026, 10, 3), -450, 'Blue Bottle Coffee'],
      [noon(2026, 10, 3), -450, 'Blue Bottle Coffee'],
      [noon(2026, 10, 5), -185000, 'Riverside Apartments #1042'],
      [noon(2026, 10, 7), -12000, 'Costco'],
      [noon(2026, 10, 11), -1599, 'Netflix']
    ])
    assert.equal(looksInverted(s), false)
  })

  test('CRLF and CR line endings read the same', () => {
    const plain = parseQif(fixture('checking.qif'))
    assert.deepEqual(parseQif(crlf(fixture('checking.qif'))), plain)
    assert.deepEqual(parseQif(fixture('checking.qif').replace(/\n/g, '\r')), plain)
  })

  test('card registers named by their account records; a category list is skipped', () => {
    const f = parseQif(fixture('cards.qif'))
    assert.deepEqual(
      f.statements.map((s) => [s.kind, s.label, s.balanceCents, s.balanceDay, s.rows.map((r) => r.amountCents), looksInverted(s)]),
      [
        ['card', 'Visa Rewards', -123456, '2026-10-15', [-5412, -4000, -2399, 50000], false],
        ['card', 'Store Card', null, null, [1999, 3500, 1249, -5000], true]
      ]
    )
  })

  test('not QIF, and hostile input', () => {
    assert.throws(() => parseQif('D10/1/26\nT5\n^\n'), /Not a QIF file/)
    const s = parseQif(`!Type:Bank\nD10/1/26\nT${'9'.repeat(400)}\nPHuge\n^\nD10/2/26\nT-1.00\nP${'x'.repeat(100_000)}\n^\nnonsense line\n^\n^\n!Type:Invst\nD10/3/26\nT5\n^\n`).statements
    assert.equal(s.length, 1)
    assert.equal(s[0].invalid, 2)
    assert.equal(s[0].rows.length, 1)
    assert.equal(s[0].rows[0].description.length, 300)
  })
})

const account = (id: string, source: 'csv' | 'simplefin' = 'csv'): string => {
  db.upsertAccount({ id, source, name: id, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
  return id
}
const rows = (accountId: string): Array<[number, number, string]> =>
  db.all<{ posted: number; cents: number; description: string }>('SELECT posted, amount_cents AS cents, description FROM transactions WHERE account_id = ? ORDER BY posted, amount_cents DESC, description', accountId).map((r) => [r.posted, r.cents, r.description])
const points = (accountId: string): Array<Record<string, unknown>> => db.listBalancePoints(accountId).map((p) => ({ ...p }))
const run = (path: string, targets: Array<StatementTarget | null> = [{}]): ReturnType<typeof importStatement> => importStatement({ token: preview(path).token, targets })
/** A card statement from one bank (FI ORG) for one card number, a dollar a row a day from Oct 1. */
const cardFile = (org: string, acct: string, fitIds: string[]): string =>
  `<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>${org}</FI></SONRS></SIGNONMSGSRSV1><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>${acct}</CCACCTFROM><BANKTRANLIST>${fitIds.map((f, i) => trn(f, `202610${String(i + 1).padStart(2, '0')}`, `-${i + 1}.00`, f)).join('')}</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`

describe('import', () => {
  test('a QFX into a new account: its name, the rows, and the closing balance as a statement point', () => {
    const p = preview(copy('checking-ofx1.qfx'))
    assert.equal(p.kind, 'statement')
    assert.equal(p.format, 'QFX')
    assert.equal(p.institution, 'Synthetic Savings & Loan')
    assert.deepEqual(
      p.accounts.map((s) => [s.kind, s.last4, s.rowCount, s.from, s.to, s.balanceCents, s.balanceDay, s.unreadable, s.invertSign, s.matchId, s.suggestedName]),
      [['bank', '6789', 8, noon(2026, 10, 1), noon(2026, 10, 15), 432187, '2026-10-15', 1, false, null, 'Synthetic Savings & Loan Checking ····6789']]
    )
    // no account number beyond its last 4 leaves the parser
    assert.ok(!JSON.stringify(p).includes('123456789'))
    const r = importStatement({ token: p.token, targets: [{ newAccountName: p.accounts[0].suggestedName }] })
    assert.deepEqual([r.imported, r.skipped, r.invalid, r.balances], [8, 0, 1, 1])
    const id = r.accountIds[0]
    const a = db.listAccounts().find((x) => x.id === id)!
    assert.deepEqual([a.source, a.name, a.institution, a.balanceCents, a.assetType], ['csv', 'Synthetic Savings & Loan Checking ····6789', 'Synthetic Savings & Loan', 432187, 'cash'])
    assert.deepEqual(points(id), [{ day: '2026-10-15', cents: 432187, source: 'statement' }])
    assert.deepEqual(
      rows(id),
      [...CHECKING_ROWS].sort((x, y) => x[0] - y[0] || y[1] - x[1] || x[2].localeCompare(y[2]))
    )
    assert.ok(db.all<{ id: string }>('SELECT id FROM transactions WHERE account_id = ?', id).every((t) => /^ofx:csv:[0-9a-f-]+:f[0-9a-f]{20}$/.test(t.id)))
    assert.ok(db.all<{ id: string }>('SELECT id FROM transactions WHERE account_id = ?', id).every((t) => db.isDeletableTransaction(t.id)))

    // the same file again adds nothing, and the preview names the account it went into
    const again = preview(copy('checking-ofx1.qfx'))
    assert.equal(again.accounts[0].matchId, id)
    const r2 = importStatement({ token: again.token, targets: [{ accountId: id }] })
    assert.deepEqual([r2.imported, r2.skipped, r2.balances], [0, 8, 0])
    // a FITID keys the row whatever its sign, so flipping on a later import still finds it
    assert.equal(run(copy('checking-ofx1.qfx'), [{ accountId: id, invertSign: true }]).imported, 0)
    assert.equal(rows(id).length, 8)
  })

  test('an overlapping download adds only its new rows', () => {
    const id = account('csv:overlap')
    run(copy('checking-ofx1.qfx'), [{ accountId: id }])
    const later = sgml(trn('2026101501', '20261015', '0.42', 'INTEREST', 'INT') + trn('2026101601', '20261016', '-8.00', 'NEW ROW')).replace('<ACCTID>55554444<ACCTTYPE>SAVINGS', '<ACCTID>000123456789<ACCTTYPE>CHECKING').replace('<BANKID>1<', '<BANKID>011000015<')
    const r = run(file(later), [{ accountId: id }])
    assert.deepEqual([r.imported, r.skipped], [1, 1])
  })

  test('a replacement card number adds nothing twice: the FITID keys leave out the last 4', () => {
    const id = account('csv:replaced')
    assert.equal(run(file(cardFile('Synthetic Card Co', '4111111111111111', ['FIT1', 'FIT2', 'FIT3'])), [{ accountId: id }]).imported, 3)
    const r = run(file(cardFile('Synthetic Card Co', '4111111111112222', ['FIT1', 'FIT2', 'FIT3', 'FIT4'])), [{ accountId: id }])
    assert.deepEqual([r.imported, r.skipped], [1, 3])
    assert.equal(rows(id).length, 4)
    // a row keyed with the last 4, as the first build of this import did, is still found
    const old = `ofx:${id}:f${createHash('sha1').update('card|2222|FIT5').digest('hex').slice(0, 20)}`
    db.insertTransactionIfNew({ id: old, accountId: id, posted: noon(2026, 10, 5), amountCents: -500, description: 'E', pending: false })
    assert.deepEqual([run(file(cardFile('Synthetic Card Co', '4111111111112222', ['FIT5'])), [{ accountId: id }]).imported], [0])
    assert.equal(rows(id).length, 5)
  })

  test('two issuers\' cards ending in the same 4 are told apart', () => {
    const chase = run(file(cardFile('Chase', '55554321', ['ch1']))).accountIds[0]
    assert.equal(preview(file(cardFile('Chase', '55554321', ['ch2']))).accounts[0].matchId, chase)
    assert.equal(preview(file(cardFile('Citi', '66664321', ['ci1']))).accounts[0].matchId, null)
  })

  test('a CSV and a statement file of the same days count each row once, in either order', () => {
    const csv = (text: string): string => {
      const p = join(dir, `both-${files++}.csv`)
      writeFileSync(p, `Date,Description,Amount\n${text}`)
      return p
    }
    const importInto = (path: string, accountId: string): number => {
      const c = csvPreview(path)
      return importCsv({ token: c.token, mapping: c.guess, accountId }).imported
    }
    const days = '10/05/2026,BLUE BOTTLE,-12.34\n10/06/2026,PAYROLL,2500.00\n10/07/2026,WHOLE FOODS,-88.10\n'
    const ofx = sgml(trn('q1', '20261005', '-12.34', 'BLUE BOTTLE COFFEE') + trn('q2', '20261006', '2500.00', 'ACME PAYROLL', 'CREDIT') + trn('q3', '20261008', '-88.10', 'WHOLE FOODS MKT') + trn('q4', '20261009', '-5.00', 'NEW ROW'))
    // The CSV first: the QFX adds only its new row (a posted date a day later is the same row).
    const a = account('csv:both-a')
    assert.equal(importInto(csv(days), a), 3)
    assert.deepEqual([run(file(ofx), [{ accountId: a }]).imported, rows(a).length], [1, 4])
    assert.equal(run(file(ofx), [{ accountId: a }]).imported, 0)
    // The QFX first: the CSV adds nothing; a second coffee that day is a real one.
    const b = account('csv:both-b')
    run(file(ofx), [{ accountId: b }])
    assert.equal(importInto(csv(days), b), 0)
    assert.equal(importInto(csv(`${days}10/05/2026,BLUE BOTTLE,-12.34\n`), b), 1)
    assert.equal(rows(b).length, 5)
    // QIF the same way.
    const c = account('csv:both-c')
    assert.equal(importInto(csv(days), c), 3)
    assert.equal(run(file('!Type:Bank\nD10/5/26\nT-12.34\nPBLUE BOTTLE\n^\nD10/7/26\nT-88.10\nPWHOLE FOODS\n^\nD10/20/26\nT-1.00\nPLATER\n^\n', 'qif'), [{ accountId: c }]).imported, 1)
    assert.equal(rows(c).length, 4)
  })

  test('an OFX 2.x card into a new account is a credit card that owes its balance', () => {
    const r = run(copy('card-ofx2.ofx'))
    const a = db.listAccounts().find((x) => x.id === r.accountIds[0])!
    assert.deepEqual([a.assetType, a.balanceCents, a.name, r.imported, r.invalid], ['credit_card', -123456, 'Example Card Services Credit card ····9876', 6, 1])
    assert.deepEqual(rows(a.id).map((x) => x[1]), [-5412, -4000, -2399, -1199, 50000, 1250])
  })

  test('a QIF bank register: hashed ids, the opening balance as an older point, the same file twice', () => {
    const r = run(copy('checking.qif'), [{ newAccountName: 'Old Checking' }])
    const id = r.accountIds[0]
    assert.deepEqual([r.imported, r.skipped, r.invalid, r.balances], [6, 0, 2, 1])
    assert.deepEqual(points(id), [{ day: '2026-09-30', cents: 100000, source: 'statement' }])
    // an opening balance is history, not the current balance
    assert.equal(db.listAccounts().find((x) => x.id === id)!.balanceCents, null)
    assert.ok(db.all<{ id: string }>('SELECT id FROM transactions WHERE account_id = ?', id).every((t) => /^qif:csv:[0-9a-f-]+:h[0-9a-f]{20}$/.test(t.id)))
    assert.equal(rows(id).filter((x) => x[2] === 'Blue Bottle Coffee').length, 2)
    const again = run(copy('checking.qif'), [{ accountId: id, invertSign: true }])
    assert.deepEqual([again.imported, again.skipped], [0, 6])
    assert.equal(preview(copy('checking.qif')).format, 'QIF')
  })

  test('QIF cards: one statement skipped, the reversed one flipped', () => {
    const p = preview(copy('cards.qif'))
    assert.deepEqual(p.accounts.map((s) => [s.label, s.invertSign, s.suggestedName]), [['Visa Rewards', false, 'Visa Rewards'], ['Store Card', true, 'Store Card']])
    const r = importStatement({ token: p.token, targets: [null, { invertSign: p.accounts[1].invertSign }] })
    assert.equal(r.accountIds.length, 1)
    assert.deepEqual(rows(r.accountIds[0]).map((x) => x[1]), [-1999, -3500, -1249, 5000])
    assert.equal(db.listAccounts().find((x) => x.id === r.accountIds[0])!.assetType, 'credit_card')
    assert.throws(() => importStatement({ token: p.token, targets: [null, {}] }), /expired/)
  })

  test('into a bank-synced account: only rows older than the feed, rows the feed lists a few days later skipped, no balance on fed days', () => {
    const id = account('sf:c:chk', 'simplefin')
    // The feed starts with the check, posted a day after the statement's date.
    const feed: Array<[string, number, number, string]> = [
      ['sf:c:chk:1', noon(2026, 10, 6), -185000, 'CHECK 1042'],
      ['sf:c:chk:2', noon(2026, 10, 9), -1599, 'NETFLIX'],
      ['sf:c:chk:3', noon(2026, 10, 11), -6210, 'AT&T'],
      ['sf:c:chk:4', noon(2026, 10, 15), 42, 'INTEREST']
    ]
    for (const [tid, posted, amountCents, description] of feed) db.upsertTransaction({ id: tid, accountId: id, posted, amountCents, description, pending: false })
    const r = run(copy('checking-ofx1.qfx'), [{ accountId: id }])
    // Oct 1 and the two coffees are older than the feed; the check is the feed's (a day apart); Oct 7 on is fed
    assert.deepEqual([r.imported, r.skipped, r.balances], [3, 5, 0])
    assert.deepEqual(points(id), [])
    // The imported rows don't move the feed's first day: the same file and a CSV of it still add nothing.
    assert.deepEqual([run(copy('checking-ofx1.qfx'), [{ accountId: id }]).imported], [0])
    const csvFile = join(dir, 'feed.csv')
    writeFileSync(csvFile, 'Date,Description,Amount\n10/02/2026,EARLIER,-3.00\n10/07/2026,ONLINE TRANSFER,-200.00\n')
    const c = csvPreview(csvFile)
    assert.deepEqual([importCsv({ token: c.token, mapping: c.guess, accountId: id }).imported], [1])
    // A statement whose closing balance is older than the feed records it.
    const old = sgml(trn('o1', '20260901', '-5.00', 'OLD'), '').replace('</BANKTRANLIST>', '</BANKTRANLIST><LEDGERBAL><BALAMT>900.00<DTASOF>20260930</LEDGERBAL>')
    const r2 = run(file(old), [{ accountId: id }])
    assert.deepEqual([r2.imported, r2.balances], [1, 1])
    assert.deepEqual(points(id), [{ day: '2026-09-30', cents: 90000, source: 'statement' }])
    // a bank-synced balance stays the feed's
    assert.equal(db.listAccounts().find((x) => x.id === id)!.balanceCents, null)
  })

  test('a statement balance never replaces one the user entered, and the newest balance wins', () => {
    const id = account('csv:entered')
    db.setBalancePoint(id, '2026-10-15', 111)
    const r = run(copy('checking-ofx1.qfx'), [{ accountId: id }])
    assert.equal(r.balances, 0)
    assert.deepEqual(points(id), [{ day: '2026-10-15', cents: 111, source: 'manual' }])
    db.deleteBalancePoint(id, '2026-10-15')
    // a point from a statement can be deleted like an entered one
    const other = account('csv:deletable')
    run(copy('checking-ofx1.qfx'), [{ accountId: other }])
    db.deleteBalancePoint(other, '2026-10-15')
    assert.deepEqual(points(other), [])

    // A balance set later than the statement stays; a newer statement takes over.
    const kept = account('csv:newer')
    db.updateAccount(kept, { balanceCents: 777 })
    run(copy('checking-ofx1.qfx'), [{ accountId: kept }])
    assert.equal(db.listAccounts().find((x) => x.id === kept)!.balanceCents, 777)
    const future = sgml(trn('n1', '20991230', '-1.00', 'LATER')).replace('</BANKTRANLIST>', '</BANKTRANLIST><LEDGERBAL><BALAMT>5000.00<DTASOF>20991231</LEDGERBAL>')
    run(file(future), [{ accountId: kept }])
    assert.equal(db.listAccounts().find((x) => x.id === kept)!.balanceCents, 500000)
  })

  test('targets are checked: one per statement, accounts that exist and are not manual', () => {
    const p = preview(copy('checking-ofx1.qfx'))
    assert.throws(() => importStatement({ token: p.token, targets: [] }), /each statement/)
    assert.throws(() => importStatement({ token: p.token, targets: [{ accountId: 'nope' }] }), /no longer exists/)
    db.upsertAccount({ id: 'manual:house', source: 'manual', name: 'House', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    assert.throws(() => importStatement({ token: p.token, targets: [{ accountId: 'manual:house' }] }), /bank or imported/)
    assert.throws(() => importStatement({ token: 'nope', targets: [{}] }), /expired/)
  })

  test('Free takes any number of new accounts', () => {
    assert.equal(planState().plan, 'free')
    for (const n of [1, 2, 3, 4]) account(`sf:free:${n}`, 'simplefin')
    const before = db.listAccounts().length
    const p = preview(file(parseable2()))
    const r = importStatement({ token: p.token, targets: [{}, {}] })
    assert.equal(r.accountIds.length, 2)
    assert.equal(db.listAccounts().length, before + 2)
  })

  test('files the importer refuses, each in one line', () => {
    assert.throws(() => readStatement(file('')), /That file is empty/)
    assert.throws(() => readStatement(file('just some text')), /Not an OFX or QFX file/)
    assert.throws(() => readStatement(file('just some text', 'qif')), /Not a QIF file/)
    assert.throws(() => readStatement(file('<OFX></OFX>')), /No bank or card statement/)
    assert.throws(() => readStatement(file(sgml('').replace('<CURDEF>USD', '<CURDEF>CAD'))), /This file is in CAD; only US dollars can be imported\./)
    assert.throws(() => readStatement(file(Buffer.alloc(MAX_BYTES + 1, 0x20))), /over 20 MB/)
    // a QIF saved as .qfx (and the reverse) is read for what it is
    assert.equal(readStatement(file(fixture('checking.qif'), 'qfx')).format, 'qif')
    assert.equal(readStatement(file(fixture('card-ofx2.ofx'), 'qif')).format, 'ofx')
  })
})

/** A file with two statements (a bank account and a card), for the plan limit. */
function parseable2(): string {
  const card = '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>9999</CCACCTFROM><BANKTRANLIST>' + trn('c1', '20261002', '-9.99', 'CARD ROW') + '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>'
  return sgml(trn('b1', '20261001', '-1.00', 'BANK ROW')).replace('</OFX>', card)
}
