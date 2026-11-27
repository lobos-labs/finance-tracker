import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines, habitEveryday, linesFor, payrollKey, perimeter } from '../src/main/lines.ts'
import { detectRecurring } from '../src/main/recurring.ts'
import { saveTrip } from '../src/main/trips.ts'
import { runTool } from '../src/main/tools.ts'
import { categoryRole } from '../src/shared/categoryRole.ts'
import { addDays, daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { ClassifiedLine, LineClass } from '../src/shared/types.ts'
import { noonOn } from './days.ts'

// The classifier gives every line of the Personal ledger one owner and one
// class: every line on a month's Personal cash and card accounts, and the
// Personal lines on a venture's. Nothing is dropped or counted twice, a home's
// costs stay Personal while the user lived there, and habitual spending in a
// category that's a one-off by default reaches Everyday.

configureLicense({ dev: true })

const CLASSES = new Set<LineClass>(['pay', 'income', 'oneOffIncome', 'tax', 'committed', 'debtCost', 'principal', 'everyday', 'oneOff', 'unsorted', 'venture', 'invested', 'cashReturn', 'capital', 'internal', 'orphan'])
const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const merchantOf = (l: ClassifiedLine): string => {
  const t = db.getTransaction(l.txnId)!
  return t.merchant ?? t.description
}

/** The months from one YYYY-MM to another, inclusive. */
function months(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m)
  return out
}

/** A month's perimeter, worked out here on its own: visible Personal cash and card accounts open on a day of it, an HSA kept as cash left out. */
function perimeterOf(month: string): string[] {
  return db
    .listAccounts()
    .filter((a) => !a.hidden && a.bucketId === null && (a.assetType === 'credit_card' || (a.assetType === 'cash' && db.taxTreatment(a) !== 'hsa')))
    .filter((a) => (!a.openedDay || a.openedDay <= lastDay(month)) && (!a.closedDay || a.closedDay >= `${month}-01`))
    .map((a) => a.id)
    .sort()
}

/**
 * The ledger's lines in a month by SQL over TXN_LINES alone: every line on a perimeter account, and the lines
 * on a venture's cash and card accounts that are Personal (placed in Personal by hand, a split part of
 * Personal's own, or a cost within the venture's residence dates).
 */
function ledgerBySql(month: string): { n: number; cents: number } {
  const inList = (ids: string[]): string => (ids.length ? ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(',') : "''")
  const held = db.listAccounts().filter((a) => !a.hidden && a.bucketId !== null && (a.assetType === 'cash' || a.assetType === 'credit_card')).map((a) => a.id)
  const r = db.get<{ n: number; cents: number | null }>(
    `WITH lines AS (
       SELECT t.amount_cents, t.account_id, date(${db.localSql('t.posted')}) AS day, c.kind,
         CASE WHEN COALESCE(s.own_bucket, 0) = 1 OR t.bucket_id IS NOT NULL THEN t.bucket_id WHEN t.bucket_source IN ('user', 'ai') THEN NULL ELSE a.bucket_id END AS placed
       FROM ${db.TXN_LINES} t JOIN accounts a ON a.id = t.account_id LEFT JOIN transaction_splits s ON s.id = t.split_id LEFT JOIN categories c ON c.id = t.category_id
     )
     SELECT COUNT(*) AS n, SUM(l.amount_cents) AS cents FROM lines l LEFT JOIN buckets b ON b.id = l.placed
     WHERE l.day BETWEEN ? AND ? AND (l.account_id IN (${inList(perimeterOf(month))}) OR (l.account_id IN (${inList(held)})
       AND (l.placed IS NULL OR (b.residence_from IS NOT NULL AND l.day BETWEEN b.residence_from AND COALESCE(b.residence_to, '9999-12-31') AND COALESCE(l.kind, '') <> 'income'))))`,
    `${month}-01`,
    lastDay(month)
  )!
  return { n: r.n, cents: r.cents ?? 0 }
}

/** Every line has one class, each key is once, and the source lines and their sum are TXN_LINES' over the ledger set. */
function assertConserved(month: string): ClassifiedLine[] {
  const lines = classifyLines(`${month}-01`, lastDay(month))
  for (const l of lines) assert.ok(CLASSES.has(l.cls), `${month} ${l.key} ${l.cls}`)
  assert.equal(new Set(lines.map((l) => l.key)).size, lines.length, `${month}: a key twice`)
  const source = new Set(lines.map((l) => `${l.txnId}:${l.splitId}`))
  assert.deepEqual({ n: source.size, cents: lines.reduce((s, l) => s + l.cents, 0) }, ledgerBySql(month), month)
  assert.deepEqual([...perimeter(month)].sort(), perimeterOf(month), month)
  return lines
}

/** Personal's total in a month as personalClause counts it today, over visible accounts. */
function personalClauseTotal(month: string): number {
  return (
    db.get<{ cents: number | null }>(
      `SELECT SUM(t.amount_cents) AS cents FROM ${db.TXN_LINES} t JOIN accounts a ON a.id = t.account_id AND a.hidden = 0 WHERE date(${db.localSql('t.posted')}) BETWEEN ? AND ? AND ${db.personalClause()}`,
      `${month}-01`,
      lastDay(month)
    )!.cents ?? 0
  )
}

describe('the classifier on the sample household', () => {
  let first = ''
  let current = ''
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
    first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    current = db.today().slice(0, 7)
  })
  after(db.closeDb)

  test('every month: each ledger line has one class, and the count and sum are TXN_LINES over the ledger', () => {
    for (const m of months(first, current)) {
      const lines = assertConserved(m)
      // A full month has plenty; the current one may have a few days in it.
      assert.ok(lines.length > (m < current ? 20 : 0), m)
      // Personal's lines add up to what personalClause counts for Personal.
      assert.equal(lines.filter((l) => l.owner === null).reduce((s, l) => s + l.cents, 0), personalClauseTotal(m), m)
    }
  })

  test('Riverside Food Bank: everyday by the habit rule once it has three months behind it; committed once its series is confirmed', () => {
    const all = classifyLines(`${first}-01`, db.today())
    const riverside = all.filter((l) => merchantOf(l) === 'Riverside Food Bank')
    const series = detectRecurring().find((s) => s.name === 'Riverside Food Bank')!
    assert.deepEqual([series.kind, series.confirmed], ['other', false])
    assert.equal(riverside.length, months(first, current).length - (Number(db.today().slice(8)) < 10 ? 1 : 0))
    // Gifts & Donations is a one-off by default: the first three months have no habit behind them yet.
    for (const l of riverside) assert.equal(l.cls, l.day.slice(0, 7) >= shiftMonth(first, 3) ? 'everyday' : 'oneOff', l.day)
    assert.ok(riverside.every((l) => l.seriesKey === series.key))

    db.setRecurringOverride(series.key, { status: 'confirmed' })
    try {
      assert.deepEqual([...new Set(classifyLines(`${first}-01`, db.today()).filter((l) => merchantOf(l) === 'Riverside Food Bank').map((l) => l.cls))], ['committed'])
    } finally {
      db.setRecurringOverride(series.key, { status: null })
    }
  })

  test('Shopmart.com is everyday by the habit rule; the flagged laptop and Harbor Home Furnishings are one-offs', () => {
    const all = classifyLines(`${first}-01`, db.today())
    const shopping = category('Shopping')
    const shopmart = all.filter((l) => l.categoryId === shopping && merchantOf(l) === 'Shopmart.com')
    const laptop = shopmart.filter((l) => l.cents === -129900)
    assert.equal(laptop.length, 1)
    assert.equal(laptop[0].cls, 'oneOff')
    const harbor = all.filter((l) => merchantOf(l) === 'Harbor Home Furnishings')
    assert.deepEqual(harbor.map((l) => [l.cents, l.cls]), [[-240000, 'oneOff']])

    // The rest, by the rule worked out here: Shopmart's Shopping lines in 3 of the 6 months before, at most twice their median.
    const rest = shopmart.filter((l) => !db.getTransaction(l.txnId)!.oneTime)
    let everyday = 0
    for (const l of rest) {
      const month = l.day.slice(0, 7)
      const prior = shopmart.filter((p) => p.day.slice(0, 7) >= shiftMonth(month, -6) && p.day.slice(0, 7) < month)
      const sizes = prior.map((p) => -p.cents).sort((a, b) => a - b)
      const mid = sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2
      const habit = new Set(prior.map((p) => p.day.slice(0, 7))).size >= 3 && -l.cents <= 2 * mid
      assert.equal(l.cls, habit ? 'everyday' : 'oneOff', `${l.day} ${l.cents}`)
      if (habit) everyday++
    }
    // Habitual Shopping reaches Everyday: most of it is.
    assert.ok(everyday > rest.length / 2, `${everyday} of ${rest.length}`)
  })

  test('Harbor Bank Interest is a cash return; the March IRS refund is tax, money back', () => {
    const all = classifyLines(`${first}-01`, db.today())
    const interest = all.filter((l) => merchantOf(l) === 'Harbor Bank Interest')
    assert.ok(interest.length >= 12)
    assert.ok(interest.every((l) => l.cls === 'cashReturn' && l.cents > 0 && l.accountId === 'demo:savings'))
    const refund = all.filter((l) => merchantOf(l) === 'IRS Tax Refund')
    assert.equal(refund.length, 1)
    assert.equal(refund[0].day.slice(5, 7), '03')
    // A tax line in: Taxes paid go down by it.
    assert.deepEqual([refund[0].cls, refund[0].cents], ['tax', 86000])
  })

  test('the rest of the household: pay, commitments, transfers between its own accounts, and loan payments found by their payment keys', () => {
    const all = classifyLines(`${first}-01`, db.today()).map((l) => ({ ...l, name: merchantOf(l) }))
    const classes = (name: string): LineClass[] => [...new Set(all.filter((l) => l.name === name).map((l) => l.cls))]
    assert.deepEqual(classes('Northwind Logistics Payroll'), ['pay'])
    for (const name of ['Streamly', 'Crestline Insurance', 'FiberOne Internet']) assert.deepEqual(classes(name), ['committed'], name)
    for (const name of ['Transfer to Savings', 'Transfer from Checking', 'Rewards Visa Payment', 'Payment']) assert.deepEqual(classes(name), ['internal'], name)
    assert.deepEqual(classes('Greenfield Market'), ['everyday'])
    assert.deepEqual(classes('VENMO PAYMENT 1023 ALEX R'), ['unsorted'])
    // The mortgage (filed as Housing) and the car loan (a transfer with no leg) split into interest and principal.
    assert.deepEqual(classes('Pinecrest Mortgage'), ['debtCost', 'principal'])
    assert.ok(classes('Lakeside Auto Loan').every((c) => c === 'debtCost' || c === 'principal'))
    assert.ok(classes('Lakeside Auto Loan').includes('principal'))
  })

  test('Bayview Rent is never in the ledger; a Personal grocery on a venture card is everyday and in it', () => {
    const all = classifyLines(`${first}-01`, db.today())
    assert.equal(all.filter((l) => /bayview/i.test(merchantOf(l))).length, 0)
    assert.ok(all.every((l) => l.accountId !== 'demo:rental-checking'))

    const venture = db.bucketByName('Bayview Condo')!.id
    db.upsertAccount({ id: 'csv:bizcard', source: 'csv', name: 'Bayview Business Card', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount('csv:bizcard', { assetType: 'credit_card', bucketId: venture })
    const day = db.today()
    const [y, m, d] = day.split('-').map(Number)
    db.upsertTransaction({ id: 'biz:grocery', accountId: 'csv:bizcard', posted: noonOn(y, m, d), amountCents: -8000, description: 'GREENFIELD MARKET #0412', pending: false })
    db.upsertTransaction({ id: 'biz:supplies', accountId: 'csv:bizcard', posted: noonOn(y, m, d), amountCents: -12000, description: 'HARBOR HARDWARE SUPPLY', pending: false })
    db.setTransactionFields('biz:grocery', { categoryId: category('Groceries'), source: 'user' })
    db.setTransactionFields('biz:supplies', { categoryId: category('Housing'), source: 'user' })
    db.applyBucketRules()
    db.setTransactionsBucket(['biz:grocery'], null)

    const lines = assertConserved(current)
    const grocery = lines.filter((l) => l.txnId === 'biz:grocery')
    assert.deepEqual(
      grocery.map((l) => [l.owner, l.perimeter, l.cls, l.cents]),
      [[null, false, 'everyday', -8000]]
    )
    // The venture's own supplies stay out.
    assert.equal(lines.filter((l) => l.txnId === 'biz:supplies').length, 0)
  })

  test('one payrollKey across recurring series, paycheckDays and the classifier', () => {
    const pay = detectRecurring().find((s) => s.name === 'Northwind Logistics Payroll')!
    assert.equal(pay.key, 'northwind logistics payroll|+')
    const lines = classifyLines(`${first}-01`, db.today()).filter((l) => l.cls === 'pay')
    assert.ok(lines.length >= 26)
    for (const l of lines) {
      const t = db.getTransaction(l.txnId)!
      assert.equal(l.paycheckKey, pay.key)
      assert.equal(payrollKey({ merchant: t.merchant, descKey: db.descKey(t.description) }), pay.key)
    }
    assert.deepEqual(db.paycheckDays(pay.key, `${first}-01`, db.today()), [...new Set(lines.map((l) => l.day))])
    // The same key SQLite's trim and lower make, which keys stored before were made with.
    for (const name of ['  Northwind Logistics Payroll ', 'Café ÉLAN Payroll', 'ACME\tPAYROLL']) {
      assert.equal(payrollKey({ merchant: name, descKey: 'unused' }), db.get<{ k: string }>("SELECT lower(trim(?)) || '|+' AS k", name)!.k, name)
    }
  })

  test('linesFor: a query of classes and owner, newest first, a page at a time, with the total and sum', () => {
    const from = `${shiftMonth(current, -2)}-01`
    const to = db.today()
    const pay = classifyLines(from, to).filter((l) => l.cls === 'pay')
    const page = linesFor({ fromDay: from, toDay: to, cls: ['pay'], owner: null }, { limit: 2 })
    assert.equal(page.total, pay.length)
    assert.equal(page.cents, pay.reduce((s, l) => s + l.cents, 0))
    assert.deepEqual(page.lines, pay.slice(-2).reverse())
    const none = linesFor({ fromDay: from, toDay: to, categoryId: 'none' })
    assert.ok(none.total > 0 && none.lines.every((l) => l.categoryId === null))
    assert.equal(linesFor({ fromDay: from, toDay: to, ids: [pay[0].txnId] }).total, 1)
    assert.throws(() => linesFor({ fromDay: '2026-13-01', toDay: to }), /fromDay and toDay/)
  })

  test("set_account_role: a cash account's role from its name, set by Review and undone", () => {
    const role = (id: string): string | null => db.listAccounts().find((a) => a.id === id)!.cashRole
    assert.deepEqual([role('demo:checking'), role('demo:savings'), role('demo:card-visa')], ['spending', 'saving', null])
    const r = runTool('set_account_role', { account_id: 'demo:savings', role: 'spending' }, 'assistant')
    assert.equal(role('demo:savings'), 'spending')
    const c = db.getChange(r.changeId!)!
    undo(c.tool, c.before, c.after, c.input)
    assert.equal(role('demo:savings'), 'saving')
    assert.throws(() => runTool('set_account_role', { account_id: 'demo:card-visa', role: 'saving' }), /not a cash account/)
  })

  test('classifying every month takes under 300 ms', () => {
    const all = months(first, current)
    classifyLines(`${first}-01`, lastDay(first))
    // CPU time, not the wall clock: npm test runs the test files at once, and
    // a busy machine slows the clock without the work getting any slower.
    const t = process.cpuUsage()
    for (const m of all) classifyLines(`${m}-01`, lastDay(m))
    const used = process.cpuUsage(t)
    const ms = (used.user + used.system) / 1000
    assert.ok(ms < 300, `${all.length} months took ${ms.toFixed(0)} ms of CPU`)
  })
})

describe('the classifier on a house lived in, then rented out (Elm St)', () => {
  const ids = new Map<string, string[]>()
  let n = 0
  /** A settled transaction on the checking account, on a day (YYYY-MM-DD). */
  function txn(day: string, cents: number, description: string, cat?: string): string {
    const [y, m, d] = day.split('-').map(Number)
    const id = `t${++n}`
    db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
    if (cat) db.setTransactionFields(id, { categoryId: category(cat), source: 'user' })
    ids.set(description, [...(ids.get(description) ?? []), id])
    return id
  }
  function monthly(from: string, to: string, day: number, cents: number, description: string): string[] {
    return months(from, to).map((m) => txn(`${m}-${String(day).padStart(2, '0')}`, cents, description))
  }

  before(() => {
    db.openDb(':memory:')
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    // test/ventures-gains.test.ts's sold house: lived in from 2020-06-01 to 2021-06-30, then rented out.
    const bucket = db.saveBucket({ name: 'Elm St', kind: 'rental', residenceFrom: '2020-06-01', residenceTo: '2021-06-30' })
    const house = db.addManualAccount({ name: 'Elm house', assetType: 'property', openedDay: '2020-05-15', closedDay: '2023-03-10', costCents: 30_000_000, points: [{ day: '2020-05-15', cents: 30_000_000 }, { day: '2023-03-10', cents: 36_000_000 }] })
    db.updateAccount(house, { bucketId: bucket, saleCostsCents: 2_700_000 })
    db.addManualAccount({ name: 'Elm St mortgage', assetType: 'mortgage', openedDay: '2020-05-15', linkedAssetId: house, points: [{ day: '2020-05-15', cents: -24_000_000 }, { day: '2023-03-10', cents: -22_500_000 }] })
    const placed = [
      txn('2020-02-01', -30_000, 'HOME INSPECTION'),
      txn('2020-03-01', -1_000_000, 'EARNEST MONEY'),
      txn('2020-05-15', -6_500_000, 'TITLE CO CLOSING'),
      txn('2020-05-20', -100_000, 'TRANSFER TO SAVINGS', 'Transfers'),
      ...monthly('2020-07', '2023-03', 1, -150_000, 'MORTGAGE PMT'),
      ...monthly('2020-07', '2021-06', 12, -20_000, 'CITY UTILITIES'),
      txn('2021-07-15', -80_000, 'PLUMBER'),
      ...monthly('2021-08', '2023-02', 3, 250_000, 'RENT'),
      txn('2023-03-10', 12_000_000, 'TITLE CO PROCEEDS'),
      txn('2023-03-12', -10_000, 'FINAL UTILITIES'),
      txn('2023-03-15', 50_000, 'ESCROW REFUND'),
      txn('2023-03-20', 30_000, 'DEPOSIT RETURNED')
    ]
    db.setTransactionsBucket(placed, bucket)
    // Personal's own groceries alongside, every month.
    for (const m of months('2020-02', '2023-03')) txn(`${m}-20`, -9_500, 'CORNER GROCER', 'Groceries')
  })
  after(db.closeDb)

  test('every month: one class each, and the count and sum are TXN_LINES over the ledger', () => {
    for (const m of months('2020-02', '2023-03')) assertConserved(m)
  })

  test('costs inside the residence dates are Personal; after them, and the rent always, the venture', () => {
    const bucket = db.bucketByName('Elm St')!.id
    const all = classifyLines('2020-01-01', '2023-12-31')
    const of = (description: string): ClassifiedLine[] => all.filter((l) => ids.get(description)!.includes(l.txnId))
    const utilities = of('CITY UTILITIES')
    assert.deepEqual(
      utilities.filter((l) => l.day === '2020-07-12').map((l) => [l.cents, l.owner]),
      [[-20_000, null]]
    )
    assert.ok(utilities.every((l) => l.owner === null && l.cls !== 'venture'))
    assert.deepEqual(
      of('PLUMBER').map((l) => [l.day, l.owner, l.cls]),
      [['2021-07-15', bucket, 'venture']]
    )
    const rent = of('RENT')
    assert.equal(rent.length, 19)
    assert.ok(rent.every((l) => l.owner === bucket && l.cls === 'venture'))
    // The mortgage while they lived there is Personal, after it the venture's.
    for (const l of of('MORTGAGE PMT')) assert.equal(l.owner, l.day <= '2021-06-30' ? null : bucket, l.day)
  })

  test("Personal's total each month equals today's personalClause total", () => {
    for (const m of months('2020-02', '2023-03')) {
      const lines = classifyLines(`${m}-01`, lastDay(m))
      assert.equal(lines.filter((l) => l.owner === null).reduce((s, l) => s + l.cents, 0), personalClauseTotal(m), m)
    }
  })
})

describe('the classifier on small fixtures', () => {
  let n = 0
  function txn(account: string, day: string, cents: number, description: string, o: { cat?: string; merchant?: string } = {}): string {
    const [y, m, d] = day.split('-').map(Number)
    const id = `f${++n}`
    db.upsertTransaction({ id, accountId: account, posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
    if (o.cat || o.merchant) db.setTransactionFields(id, { ...(o.cat ? { categoryId: category(o.cat), source: 'user' as const } : {}), ...(o.merchant ? { merchant: o.merchant } : {}) })
    return id
  }
  const lineOf = (lines: ClassifiedLine[], id: string): ClassifiedLine[] => lines.filter((l) => l.txnId === id)

  before(() => {
    db.openDb(':memory:')
    for (const [id, name] of [
      ['csv:main', 'Checking'],
      ['csv:old', 'Old Checking']
    ]) {
      db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    }
    db.updateAccount('csv:old', { closedDay: '2025-06-30' })
  })
  after(db.closeDb)

  test('a checking account closed on 2025-06-30 is in June\'s perimeter and not July\'s; a transfer to it in June is internal', () => {
    assert.deepEqual(perimeter('2025-06').sort(), ['csv:main', 'csv:old'])
    assert.deepEqual(perimeter('2025-07'), ['csv:main'])
    const out = txn('csv:main', '2025-06-20', -50_000, 'TRANSFER TO OLD CHECKING', { cat: 'Transfers' })
    const leg = txn('csv:old', '2025-06-22', 50_000, 'TRANSFER FROM CHECKING', { cat: 'Transfers' })
    // An uncategorized deposit of the same amount, nearer in time: the transfer's own leg pairs first.
    const stray = txn('csv:old', '2025-06-20', 50_000, 'MOBILE DEPOSIT')
    const fee = txn('csv:old', '2025-07-02', -300, 'CLOSING FEE', { cat: 'Fees & Interest' })
    const pairs = db.transferPairs('2025-06-01', '2025-06-30')
    assert.deepEqual(pairs.pairOf.get(out), { id: leg, accountId: 'csv:old', day: '2025-06-22' })
    assert.equal(pairs.pairOf.has(stray), false)
    assert.deepEqual(pairs.unmatched, [])
    const june = assertConserved('2025-06')
    assert.deepEqual([...lineOf(june, out), ...lineOf(june, leg)].map((l) => l.cls), ['internal', 'internal'])
    assert.deepEqual(lineOf(june, stray).map((l) => l.cls), ['unsorted'])
    // Closed, the old account is out of July's ledger.
    assert.equal(lineOf(assertConserved('2025-07'), fee).length, 0)
  })

  test('an uncategorized inflow and an uncategorized outflow are both unsorted', () => {
    const inflow = txn('csv:main', '2025-05-07', 12_345, 'DEPOSIT REF 88213')
    const outflow = txn('csv:main', '2025-05-09', -2_500, 'SQ *ODDS AND ENDS')
    const may = assertConserved('2025-05')
    assert.deepEqual([...lineOf(may, inflow), ...lineOf(may, outflow)].map((l) => [l.cls, l.cents]), [['unsorted', 12_345], ['unsorted', -2_500]])
  })

  test('a payee in 3 of the 6 months before with a median of 40.00: 75.00 is everyday, 85.00 is a one-off', () => {
    for (const [day, cents] of [['2025-03-05', -3_500], ['2025-05-05', -4_000], ['2025-07-05', -4_500]] as const) txn('csv:main', day, cents, 'CORNER BOOKS', { cat: 'Shopping', merchant: 'Corner Books' })
    const small = txn('csv:main', '2025-08-10', -7_500, 'CORNER BOOKS', { cat: 'Shopping', merchant: 'Corner Books' })
    const large = txn('csv:main', '2025-08-20', -8_500, 'CORNER BOOKS', { cat: 'Shopping', merchant: 'Corner Books' })
    const aug = classifyLines('2025-08-01', '2025-08-31')
    assert.deepEqual([...lineOf(aug, small), ...lineOf(aug, large)].map((l) => l.cls), ['everyday', 'oneOff'])
    // The first of them had no months behind it.
    assert.deepEqual(classifyLines('2025-03-01', '2025-03-31').filter((l) => l.cents === -3_500).map((l) => l.cls), ['oneOff'])
    // The rule itself: two months are not a habit, and only earlier months count.
    const earlier = [{ month: '2025-03', cents: -3_500 }, { month: '2025-05', cents: -4_000 }, { month: '2025-07', cents: -4_500 }]
    assert.equal(habitEveryday(-8_000, '2025-08', earlier), true)
    assert.equal(habitEveryday(-8_001, '2025-08', earlier), false)
    assert.equal(habitEveryday(-4_000, '2025-08', earlier.slice(1)), false)
    assert.equal(habitEveryday(-4_000, '2025-07', earlier), false)
  })

  test('pay: a check above 1.5 times the usual is bonus beyond that, an off-schedule check all bonus, a split deposit one check', () => {
    const pay = { cat: 'Paycheck', merchant: 'Acme Payroll' }
    const days = ['2025-01-03', '2025-01-17', '2025-01-31', '2025-02-14', '2025-02-28', '2025-03-14', '2025-03-28', '2025-04-11', '2025-04-25', '2025-05-09', '2025-05-23', '2025-06-06', '2025-06-20']
    const ids = new Map<string, string>()
    for (const day of days) ids.set(day, txn('csv:main', day, day === '2025-03-14' ? 600_000 : day === '2025-02-14' ? 200_000 : 300_000, 'ACME PAYROLL DIR DEP', pay))
    const split = txn('csv:old', '2025-02-14', 100_000, 'ACME PAYROLL DIR DEP', pay)
    const extra = txn('csv:main', '2025-03-18', 100_000, 'ACME PAYROLL DIR DEP', pay)
    const key = payrollKey({ merchant: 'Acme Payroll', descKey: '' })
    assert.equal(key, 'acme payroll|+')
    assert.equal(detectRecurring({ lookbackDays: 2000 }).find((s) => s.key === key)?.cadence, 'biweekly')

    const lines = classifyLines('2025-01-01', '2025-06-30').filter((l) => l.cls === 'pay')
    assert.ok(lines.every((l) => l.paycheckKey === key))
    const parts = (id: string): Array<[string, number]> => lineOf(lines, id).map((l) => [l.key.slice(l.txnId.length), l.cents])
    assert.deepEqual(parts(ids.get('2025-03-14')!), [['::p', 450_000], ['::p:bonus', 150_000]])
    assert.deepEqual(parts(extra), [['::p:bonus', 100_000]])
    assert.deepEqual(parts(ids.get('2025-02-14')!), [['::p', 200_000]])
    assert.deepEqual(parts(split), [['::p', 100_000]])
    assert.deepEqual(parts(ids.get('2025-03-28')!), [['::p', 300_000]])
    // Asked for March alone, the same answer: the checks before it are read from before the span.
    assert.deepEqual(
      classifyLines('2025-03-01', '2025-03-31').filter((l) => l.cls === 'pay').map((l) => [l.key, l.cents]),
      lines.filter((l) => l.day.startsWith('2025-03')).map((l) => [l.key, l.cents])
    )
  })

  test("'returns' is the role of interest and dividend categories", () => {
    assert.deepEqual(['Interest Income', 'Interest Earned', 'Dividends'].map(categoryRole), ['returns', 'returns', 'returns'])
    assert.equal(categoryRole('Interest'), 'fees')
  })
})

describe('the classifier, rule by rule', () => {
  let n = 0
  function txn(account: string, day: string, cents: number, description: string, o: { cat?: string; merchant?: string } = {}): string {
    const [y, m, d] = day.split('-').map(Number)
    const id = `r${++n}`
    db.upsertTransaction({ id, accountId: account, posted: noonOn(y, m, d), amountCents: cents, description, pending: false })
    if (o.cat || o.merchant) db.setTransactionFields(id, { ...(o.cat ? { categoryId: category(o.cat), source: 'user' as const } : {}), ...(o.merchant ? { merchant: o.merchant } : {}) })
    return id
  }
  /** Each transaction's lines in a month, as [class, cents], after checking the month is conserved. */
  function classes(month: string, ids: Record<string, string>): Record<string, Array<[LineClass, number]>> {
    const lines = assertConserved(month)
    return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, lines.filter((l) => l.txnId === id).map((l): [LineClass, number] => [l.cls, l.cents])]))
  }
  // The classes that reach a Personal row: Gross pay to Saved, Invested (money moved in from cash) and Growth (cash returns).
  const PERSONAL_ROWS = new Set<LineClass>(['pay', 'income', 'oneOffIncome', 'tax', 'committed', 'debtCost', 'everyday', 'oneOff', 'invested', 'cashReturn'])

  before(() => {
    db.openDb(':memory:')
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    const accounts: Array<[string, string, Parameters<typeof db.updateAccount>[1]]> = [
      ['csv:chk', 'Checking', {}],
      ['csv:visa', 'Visa', { assetType: 'credit_card' }],
      ['csv:brk', 'Brokerage', { assetType: 'investment' }],
      ['csv:hsa', 'HSA Cash', { assetType: 'cash' }],
      ['csv:hid', 'Spare Checking', { hidden: true }],
      ['csv:biz', 'Shop Checking', { bucketId: shop }],
      ['csv:loan', 'Personal Loan', { assetType: 'loan' }],
      ['csv:car', 'Car', { assetType: 'vehicle' }]
    ]
    for (const [id, name, patch] of accounts) {
      db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
      if (Object.keys(patch).length) db.updateAccount(id, patch)
    }
  })
  after(db.closeDb)

  test('a transfer takes its class from the other leg; money moved to a venture is venture and in no Personal row', () => {
    // An HSA kept as cash is out of the perimeter, like the hidden account, the venture's and those that aren't cash or cards.
    assert.deepEqual(perimeter('2025-05').sort(), ['csv:chk', 'csv:visa'])
    const t = { cat: 'Transfers' }
    const ids = {
      toBrokerage: txn('csv:chk', '2025-05-02', -30_000, 'TO BROKERAGE', t),
      toHsa: txn('csv:chk', '2025-05-04', -20_000, 'TO HSA', t),
      toHidden: txn('csv:chk', '2025-05-05', -11_100, 'TO SPARE', t),
      toShop: txn('csv:chk', '2025-05-06', -40_000, 'TO SHOP', t),
      borrowed: txn('csv:chk', '2025-05-07', 500_000, 'LOAN PROCEEDS', t),
      loanPaid: txn('csv:chk', '2025-05-08', -25_000, 'LOAN PMT', t),
      toCar: txn('csv:chk', '2025-05-09', -77_700, 'TO DEALER', t),
      // Placed in Personal by hand on the venture's account, its leg on checking.
      shopToMe: txn('csv:biz', '2025-05-14', -15_000, 'TO OWNER', t),
      meFromShop: txn('csv:chk', '2025-05-14', 15_000, 'FROM SHOP', t)
    }
    const legs = {
      brokerage: txn('csv:brk', '2025-05-03', 30_000, 'FROM CHECKING', t),
      hsa: txn('csv:hsa', '2025-05-04', 20_000, 'FROM CHECKING', t),
      hidden: txn('csv:hid', '2025-05-05', 11_100, 'FROM CHECKING', t),
      shop: txn('csv:biz', '2025-05-06', 40_000, 'FROM OWNER', t),
      loanOut: txn('csv:loan', '2025-05-07', -500_000, 'DISBURSEMENT', t),
      loanIn: txn('csv:loan', '2025-05-08', 25_000, 'PAYMENT', t),
      car: txn('csv:car', '2025-05-09', 77_700, 'PURCHASE', t)
    }
    db.applyBucketRules()
    db.setTransactionsBucket([ids.shopToMe], null)

    const got = classes('2025-05', { ...ids, ...legs })
    const { shopToMe, ...rest } = got
    assert.deepEqual(rest, {
      toBrokerage: [['invested', -30_000]],
      toHsa: [['invested', -20_000]],
      toHidden: [['orphan', -11_100]],
      toShop: [['venture', -40_000]],
      borrowed: [['principal', 500_000]],
      loanPaid: [['principal', -25_000]],
      toCar: [['capital', -77_700]],
      meFromShop: [['venture', 15_000]],
      // Off the perimeter, or the venture's own side: none of them is in the ledger.
      brokerage: [],
      hsa: [],
      hidden: [],
      shop: [],
      loanOut: [],
      loanIn: [],
      car: []
    })
    // Money between the user and a venture reaches no Personal row on either side, however the Ventures term nets it.
    assert.equal(shopToMe.length, 1)
    for (const [cls] of [...got.toShop, ...shopToMe, ...got.meFromShop]) assert.ok(!PERSONAL_ROWS.has(cls), cls)
    // A payment is all principal until loans are split, so it's estimated; money borrowed is principal as it is.
    const lines = classifyLines('2025-05-01', '2025-05-31')
    assert.deepEqual([ids.borrowed, ids.loanPaid].map((id) => lines.find((l) => l.txnId === id)!.estimated), [false, true])
  })

  test('money in and out by its category: income, a one-off gift, reimbursement or sale, tax paid, card interest', () => {
    const reimbursed = db.saveCategory({ name: 'Reimbursements', kind: 'income', description: '' })
    const ids = {
      side: txn('csv:chk', '2025-06-03', 20_000, 'ETSY PAYOUT', { cat: 'Other Income' }),
      gift: txn('csv:chk', '2025-06-04', 10_000, 'ZELLE FROM MOM', { cat: 'Other Income' }),
      expenses: txn('csv:chk', '2025-06-05', 4_200, 'EMPLOYER EXPENSES'),
      sold: txn('csv:chk', '2025-06-06', 35_000, 'MARKETPLACE PAYOUT', { cat: 'Other Income' }),
      taxPaid: txn('csv:chk', '2025-06-11', -90_000, 'IRS USATAXPYMT', { cat: 'Taxes' }),
      cardInterest: txn('csv:visa', '2025-06-12', -1_234, 'INTEREST CHARGE', { cat: 'Fees & Interest' }),
      checkingFee: txn('csv:chk', '2025-06-12', -500, 'MONTHLY FEE', { cat: 'Fees & Interest' })
    }
    db.setOneTime([ids.gift], true)
    db.setTransactionFields(ids.expenses, { categoryId: reimbursed.id, source: 'user' })
    db.addTags([ids.sold], ['sale'])
    assert.deepEqual(classes('2025-06', ids), {
      side: [['income', 20_000]],
      gift: [['oneOffIncome', 10_000]],
      expenses: [['oneOffIncome', 4_200]],
      sold: [['oneOffIncome', 35_000]],
      taxPaid: [['tax', -90_000]],
      // Fees & Interest on a card is the card's interest; on checking it falls through to Everyday.
      cardInterest: [['debtCost', -1_234]],
      checkingFee: [['everyday', -500]]
    })
  })

  test('bought on a trip is a one-off; a deposit or a refund during it is still unsorted, or its category', () => {
    saveTrip({ name: 'Coast', from: '2025-07-01', to: '2025-07-10' })
    const ids = {
      dinner: txn('csv:visa', '2025-07-03', -6_000, 'HARBOR GRILL', { cat: 'Dining Out' }),
      unnamed: txn('csv:visa', '2025-07-04', -3_000, 'SQ *SOMETHING'),
      deposit: txn('csv:chk', '2025-07-05', 45_000, 'DEPOSIT REF 1234'),
      refund: txn('csv:visa', '2025-07-06', 2_000, 'GREENFIELD REFUND', { cat: 'Groceries' }),
      after: txn('csv:visa', '2025-07-25', -6_000, 'HARBOR GRILL', { cat: 'Dining Out' })
    }
    assert.deepEqual(classes('2025-07', ids), {
      dinner: [['oneOff', -6_000]],
      unnamed: [['oneOff', -3_000]],
      deposit: [['unsorted', 45_000]],
      refund: [['everyday', 2_000]],
      after: [['everyday', -6_000]]
    })
  })

  test('a purchase never pairs with an unrelated transfer; a transfer from a venture is venture though its side was filed as income', () => {
    const ids = {
      // From an account that isn't tracked: no leg, so an orphan, and the purchase two days later is still spending.
      zelleIn: txn('csv:chk', '2025-08-10', 10_000, 'ZELLE FROM SAM', { cat: 'Transfers' }),
      purchase: txn('csv:visa', '2025-08-12', -10_000, 'GREENFIELD MARKET', { cat: 'Groceries' }),
      // A card payment whose card side has no category is still one transfer.
      payment: txn('csv:chk', '2025-08-15', -20_000, 'PAYMENT TO VISA', { cat: 'Transfers' }),
      paid: txn('csv:visa', '2025-08-16', 20_000, 'PAYMENT RECEIVED'),
      // The owner paid from the venture's account, filed as income on checking: Ventures, not Gross pay.
      draw: txn('csv:biz', '2025-08-20', -50_000, 'OWNER DRAW', { cat: 'Transfers' }),
      drawIn: txn('csv:chk', '2025-08-21', 50_000, 'SHOP LLC', { cat: 'Other Income' })
    }
    db.applyBucketRules()
    const pairs = db.transferPairs('2025-08-01', '2025-08-31')
    assert.equal(pairs.pairOf.has(ids.zelleIn), false)
    assert.equal(pairs.pairOf.has(ids.purchase), false)
    assert.ok(pairs.unmatched.includes(ids.zelleIn))
    assert.equal(pairs.pairOf.get(ids.drawIn)?.id, ids.draw)
    assert.deepEqual(classes('2025-08', ids), {
      zelleIn: [['orphan', 10_000]],
      purchase: [['everyday', -10_000]],
      payment: [['internal', -20_000]],
      paid: [['internal', 20_000]],
      draw: [],
      drawIn: [['venture', 50_000]]
    })
  })
})

describe('the classifier on pay checks', () => {
  /** Paychecks into a new household's checking on each day (3,000.00 unless `cents` says); the days of its bonus parts. */
  function bonusDays(days: string[], cents: (day: string) => number = () => 300_000): string[] {
    db.openDb(':memory:')
    try {
      db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
      days.forEach((day, i) => {
        const [y, m, d] = day.split('-').map(Number)
        db.upsertTransaction({ id: `p${i}`, accountId: 'csv:chk', posted: noonOn(y, m, d), amountCents: cents(day), description: 'ACME PAYROLL DIR DEP', pending: false })
        db.setTransactionFields(`p${i}`, { categoryId: category('Paycheck'), source: 'user', merchant: 'Acme Payroll' })
      })
      const lines = classifyLines(days[0], days[days.length - 1])
      assert.equal(lines.filter((l) => l.cls === 'pay').reduce((s, l) => s + l.cents, 0), days.reduce((s, d) => s + cents(d), 0))
      return lines.filter((l) => l.key.endsWith(':bonus')).map((l) => l.day)
    } finally {
      db.closeDb()
    }
  }

  test('a payday moved for a weekend or a holiday is a regular check, not bonus', () => {
    // The 15th and the last weekday: February 2021 ends on a Sunday, so it pays on Friday the 26th, 11 days after the 15th.
    const semimonthly = ['2020-11-13', '2020-11-30', '2020-12-15', '2020-12-31', '2021-01-15', '2021-01-29', '2021-02-15', '2021-02-26', '2021-03-15', '2021-03-31', '2021-04-15', '2021-04-30']
    assert.deepEqual(bonusDays(semimonthly), [])
    // Every other Monday, paid the Friday before Memorial Day.
    const biweekly = ['2021-03-08', '2021-03-22', '2021-04-05', '2021-04-19', '2021-05-03', '2021-05-17', '2021-05-28', '2021-06-14', '2021-06-28', '2021-07-12']
    assert.deepEqual(bonusDays(biweekly), [])
    // A check in the middle of a cycle is still off schedule.
    assert.deepEqual(bonusDays([...Array.from({ length: 12 }, (_, i) => addDays('2021-03-08', 14 * i)), '2021-05-10'].sort()), ['2021-05-10'])
  })

  test('a payroll that changed cadence keeps its old checks regular, either way', () => {
    // Every other Friday at 2,000.00, then monthly at 4,333.00: the series is monthly now.
    const slower = [...Array.from({ length: 9 }, (_, i) => addDays('2024-01-05', 14 * i)), ...months('2024-06', '2026-10').map((m) => `${m}-01`)]
    assert.deepEqual(
      bonusDays(slower, (d) => (d < '2024-06-01' ? 200_000 : 433_300)).filter((d) => d < '2024-06-01'),
      []
    )
    // Monthly, then every other week: the new checks come half as far apart. The first, Aug 15, two weeks after the
    // monthly Aug 1, is off the schedule the checks kept when it came, so it is bonus as it was then, and a later
    // check never makes it regular. Once the checks keep every other week (Aug 1, 15 and 29 and Sep 12 are
    // Thursdays two weeks apart), the rest are regular.
    const faster = [...months('2024-01', '2024-08').map((m) => `${m}-01`), ...Array.from({ length: 20 }, (_, i) => addDays('2024-08-15', 14 * i))]
    assert.deepEqual(bonusDays(faster, (d) => (d < '2024-08-10' ? 400_000 : 200_000)), ['2024-08-15'])
    assert.deepEqual(bonusDays(faster.slice(0, 9), (d) => (d < '2024-08-10' ? 400_000 : 200_000)), ['2024-08-15'])
  })
})

describe('the classifier on a bill whose pattern changed over 400 days ago', () => {
  before(() => db.openDb(':memory:'))
  after(db.closeDb)

  test('its recent lines pay the live series detectRecurring shows, under the same key', () => {
    db.upsertAccount({ id: 'csv:chk', source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    // Monthly for the last 13 months; before a six-month break, quarterly for two years. Over the whole history
    // the gaps fit no cadence; over detectRecurring's 400 days they're monthly.
    const today = db.today()
    const last = Number(today.slice(8)) >= 8 ? today.slice(0, 7) : shiftMonth(today.slice(0, 7), -1)
    const monthly = months(shiftMonth(last, -12), last)
    const quarterly = Array.from({ length: 8 }, (_, i) => shiftMonth(monthly[0], -6 - 3 * (7 - i)))
    let n = 0
    for (const [m, cents] of [...quarterly.map((m) => [m, -15_000] as const), ...monthly.map((m) => [m, -5_000] as const)]) {
      const id = `w${++n}`
      db.upsertTransaction({ id, accountId: 'csv:chk', posted: noonOn(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 8), amountCents: cents, description: 'CITY WATER', pending: false })
      db.setTransactionFields(id, { categoryId: category('Utilities'), source: 'user', merchant: 'City Water' })
    }
    const series = detectRecurring().find((s) => s.name === 'City Water')!
    assert.deepEqual([series.key, series.kind, series.cadence], ['city water|-', 'bill', 'monthly'])
    const lines = classifyLines(`${monthly[0]}-01`, lastDay(last))
    assert.equal(lines.length, 13)
    assert.ok(lines.every((l) => l.cls === 'committed' && l.seriesKey === series.key))
  })
})

describe('migration 37 and cash roles', () => {
  after(db.closeDb)

  test("a cash account's role is guessed from its name until the bank's subtype or Review says; the subtype never replaces Review's", () => {
    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 36 })
    const names = ['Everyday Checking', 'High-Yield Savings', 'Money Market', '12-Month CD', 'Emergency Reserve', 'Rewards Visa', 'Cdn Dollar Account']
    names.forEach((name, i) => db.upsertAccount({ id: `a${i}`, source: 'csv', name, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null }))
    db.migrate()
    assert.deepEqual(db.get('SELECT COUNT(*) AS n FROM accounts WHERE cash_role IS NOT NULL OR plaid_subtype IS NOT NULL'), { n: 0 })
    const roles = (): Array<[string, string | null]> => db.listAccounts().sort((x, y) => x.id.localeCompare(y.id)).map((a) => [a.name, a.cashRole])
    assert.deepEqual(roles(), [
      ['Everyday Checking', 'spending'],
      ['High-Yield Savings', 'saving'],
      ['Money Market', 'saving'],
      ['12-Month CD', 'saving'],
      ['Emergency Reserve', 'saving'],
      ['Rewards Visa', null],
      ['Cdn Dollar Account', 'spending']
    ])
    // The bank's subtype says what a guessed account is for; a later one doesn't change it.
    db.setPlaidSubtype('a0', 'savings')
    db.setPlaidSubtype('a0', 'checking')
    assert.deepEqual(db.get('SELECT cash_role, plaid_subtype FROM accounts WHERE id = ?', 'a0'), { cash_role: 'saving', plaid_subtype: 'checking' })
    // Review set it before the first sync: the subtype is kept, and the role stays.
    db.setCashRole('a1', 'spending')
    db.setPlaidSubtype('a1', 'savings')
    assert.deepEqual(db.get('SELECT cash_role, plaid_subtype FROM accounts WHERE id = ?', 'a1'), { cash_role: 'spending', plaid_subtype: 'savings' })
    assert.equal(db.cashRoleRaw('a2'), null)
  })
})
