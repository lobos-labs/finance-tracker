import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, parseDate, rowAmount } from '../src/shared/parse.ts'
import type { CsvMapping } from '../src/shared/types.ts'
import { noonOn as noon } from './days.ts'

describe('parseDate', () => {
  test('MM/DD/YYYY', () => {
    assert.equal(parseDate('10/14/2026'), noon(2026, 10, 14))
    assert.equal(parseDate('01/05/2026'), noon(2026, 1, 5))
  })

  test('M/D/YY is this century', () => {
    assert.equal(parseDate('1/5/26'), noon(2026, 1, 5))
    assert.equal(parseDate('12/31/99'), noon(2099, 12, 31))
  })

  test('ISO, with or without a time', () => {
    assert.equal(parseDate('2026-10-14'), noon(2026, 10, 14))
    assert.equal(parseDate('2026-1-5'), noon(2026, 1, 5))
    assert.equal(parseDate('2026-10-14T23:30:00Z'), noon(2026, 10, 14))
  })

  test('dots and dashes between US-style parts', () => {
    assert.equal(parseDate('10.14.2026'), noon(2026, 10, 14))
    assert.equal(parseDate('10-14-26'), noon(2026, 10, 14))
  })

  test('surrounding whitespace', () => {
    assert.equal(parseDate('  10/14/2026 '), noon(2026, 10, 14))
  })

  test('a written-out date falls back to the platform parser', () => {
    const t = parseDate('Oct 14, 2026')
    assert.ok(t !== null)
    const d = new Date(t * 1000)
    assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate()], [2026, 10, 14])
  })

  test('blank and nonsense are null', () => {
    assert.equal(parseDate(undefined), null)
    assert.equal(parseDate(''), null)
    assert.equal(parseDate('   '), null)
    assert.equal(parseDate('not a date'), null)
    assert.equal(parseDate('yesterday'), null)
  })
})

describe('parseAmount', () => {
  test('dollars, commas and plain numbers are cents', () => {
    assert.equal(parseAmount('$1,234.56'), 123456)
    assert.equal(parseAmount('1234.56'), 123456)
    assert.equal(parseAmount('1,234'), 123400)
    assert.equal(parseAmount('.5'), 50)
    assert.equal(parseAmount('0'), 0)
    assert.equal(parseAmount('0.00'), 0)
  })

  test('rounds to whole cents', () => {
    assert.equal(parseAmount('19.99'), 1999)
    assert.equal(parseAmount('4.35'), 435)
  })

  test('parentheses mean negative', () => {
    assert.equal(parseAmount('(12.00)'), -1200)
    assert.equal(parseAmount('($1,234.56)'), -123456)
  })

  test('a leading minus, anywhere before the digits', () => {
    assert.equal(parseAmount('-5'), -500)
    assert.equal(parseAmount('-$1,234.56'), -123456)
    assert.equal(parseAmount('$-5'), -500)
  })

  test('DR and CR suffixes', () => {
    assert.equal(parseAmount('12.00 DR'), -1200)
    assert.equal(parseAmount('12.00DR'), -1200)
    assert.equal(parseAmount('12.00 dr'), -1200)
    assert.equal(parseAmount('12.00 CR'), 1200)
  })

  test('whitespace inside and around', () => {
    assert.equal(parseAmount('  $ 1,234.56  '), 123456)
  })

  test('blank and bad input are null', () => {
    assert.equal(parseAmount(undefined), null)
    assert.equal(parseAmount(''), null)
    assert.equal(parseAmount('   '), null)
    assert.equal(parseAmount('abc'), null)
    assert.equal(parseAmount('12abc'), null)
    assert.equal(parseAmount('1.2.3'), null)
    assert.equal(parseAmount('5.'), null)
    assert.equal(parseAmount('$'), null)
  })
})

describe('rowAmount', () => {
  const mapping = (m: Partial<CsvMapping>): CsvMapping => ({ date: 0, description: 1, amount: null, debit: null, credit: null, invertSign: false, ...m })

  test('one signed amount column', () => {
    const m = mapping({ amount: 2 })
    assert.equal(rowAmount(['10/14/2026', 'Coffee', '-4.50'], m), -450)
    assert.equal(rowAmount(['10/14/2026', 'Paycheck', '2,500.00'], m), 250000)
    assert.equal(rowAmount(['10/14/2026', 'Blank', ''], m), null)
  })

  test('invertSign flips a card export that lists charges as positive', () => {
    const m = mapping({ amount: 2, invertSign: true })
    assert.equal(rowAmount(['10/14/2026', 'Coffee', '4.50'], m), -450)
    assert.equal(rowAmount(['10/14/2026', 'Payment', '-100.00'], m), 10000)
  })

  test('debit and credit columns: money out is negative, money in positive', () => {
    const m = mapping({ debit: 2, credit: 3 })
    assert.equal(rowAmount(['d', 'x', '12.00', ''], m), -1200)
    assert.equal(rowAmount(['d', 'x', '', '50.00'], m), 5000)
    assert.equal(rowAmount(['d', 'x', '10.00', '25.00'], m), 1500)
  })

  test('debit and credit columns ignore the sign the bank wrote', () => {
    const m = mapping({ debit: 2, credit: 3 })
    assert.equal(rowAmount(['d', 'x', '-12.00', ''], m), -1200)
    assert.equal(rowAmount(['d', 'x', '', '-50.00'], m), 5000)
  })

  test('debit and credit columns both blank is no amount', () => {
    assert.equal(rowAmount(['d', 'x', '', ''], mapping({ debit: 2, credit: 3 })), null)
    assert.equal(rowAmount(['d', 'x'], mapping({ debit: 2, credit: 3 })), null)
  })

  test('only a debit column', () => {
    assert.equal(rowAmount(['d', 'x', '12.00'], mapping({ debit: 2 })), -1200)
    assert.equal(rowAmount(['d', 'x', '12.00'], mapping({ debit: 2, invertSign: true })), 1200)
  })

  test('a row shorter than the mapping has no amount', () => {
    assert.equal(rowAmount(['10/14/2026', 'Coffee'], mapping({ amount: 2 })), null)
  })
})
