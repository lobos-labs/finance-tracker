import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from '../src/main/db.ts'
import { contributionSummary, matchLeft, monthContributions, monthWithholding } from '../src/main/contributions.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines } from '../src/main/lines.ts'
import { checksPerYear, grossOn, listPaystubs, paystubOn, payrollChecks, payRunRates, payTotals, savePaystub, yearCheck } from '../src/main/paystubs.ts'
import { getTaxes, setTaxYear } from '../src/main/taxes.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { PAYSTUB_ITEMS } from '../src/shared/payroll.ts'
import { ratePct } from '../src/shared/rounding.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'
import type { PayCheck } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { ACME_NET, acmeLines, acmeStub, CHECKING, deposit, FRIDAYS, household, KEY, matchHousehold, TODAY } from './fixtures/paystubs.ts'

// Paystubs (waterfall spec 1.2 and 1.3): each check's gross pay and what came out of it, from its own stub or the
// payroll's nearest one, with Take-home anchored to what was deposited. The run rates here are pay's part of the
// rows into Take-home, as waterfall.ts will read them.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)
before(() => mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 }))
after(() => mock.timers.reset())

const lastDay = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const monthChecks = (month: string): PayCheck[] => payrollChecks(`${month}-01`, lastDay(month))
const undoChange = (changeId: number | undefined): void => {
  const c = db.getChange(changeId!)!
  undo(c.tool, c.before, c.after, c.input)
}

describe('run rates from paystubs', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test("a raise: September's run rates are Gross pay 6,370.00, Taxes 1,527.50, Benefits 208.00, Saved at work 509.60, Payroll difference 0 and Take-home 4,124.90 (64.8%)", () => {
    // Six biweekly checks, three at 2,880.00 and three at 3,000.00; a stub at the first of each, the rest estimated from it.
    const days = FRIDAYS.slice(0, 6)
    days.forEach((day, i) => deposit(day, i < 3 ? ACME_NET[288_000] : ACME_NET[300_000]))
    acmeStub(days[0], 288_000)
    acmeStub(days[3], 300_000)
    const checks = payrollChecks('2026-07-01', '2026-09-30')
    assert.deepEqual(
      checks.map((c) => [c.day, c.basis, c.grossCents, c.taxesCents, c.benefitsCents, c.savedAtWorkCents, c.netCents, c.differenceCents]),
      days.map((day, i) => [day, i % 3 === 0 ? 'paystub' : 'estimated', i < 3 ? 288_000 : 300_000, i < 3 ? 69_000 : 72_000, 9_600, i < 3 ? 23_040 : 24_000, i < 3 ? 186_360 : 194_400, 0])
    )
    assert.equal(checksPerYear(KEY), 26)
    const r = payRunRates('2026-09')
    assert.deepEqual([r.fromMonth, r.toMonth, r.basis], ['2026-07', '2026-09', 'estimated'])
    const { grossCents, taxesCents, benefitsCents, savedAtWorkCents, payrollDiffCents, takeHomeCents, depositCents } = r.totals
    assert.deepEqual([grossCents, taxesCents, benefitsCents, savedAtWorkCents, payrollDiffCents, takeHomeCents], [637_000, 152_750, 20_800, 50_960, 0, 412_490])
    // The deposits' 11,422.80 times 26 checks a year, over 72.
    assert.equal(checks.reduce((s, c) => s + c.depositCents, 0), 1_142_280)
    assert.equal(depositCents, 412_490)
    assert.equal(Math.round((1_142_280 * 26) / 72), 412_490)
    assert.equal(ratePct(takeHomeCents, grossCents), 64.8)
  })

  test('a three-check month: seven checks of 3,000.00 in the window give 21,000.00 x 26 / 84 = 6,500.00, while October is 9,000.00', () => {
    for (const day of FRIDAYS.slice(2)) deposit(day, ACME_NET[300_000])
    acmeStub(FRIDAYS[2], 300_000)
    const r = payRunRates('2026-10')
    assert.equal(r.keys[0].checks, 7)
    assert.equal(r.totals.grossCents, 650_000)
    assert.equal(payTotals(monthChecks('2026-10')).grossCents, 900_000)
    assert.equal(monthChecks('2026-10').length, 3)
    // The open month's run rate is the last full month's.
    assert.deepEqual(payRunRates('2026-11'), { ...r, month: '2026-11' })
  })

  test("a payroll that stopped is no part of the run rate: Acme's checks end Aug 21 and Newco's 2,000.00 run from Sep 4, so October's run rate is Newco's alone, 4,333.33", () => {
    for (const day of FRIDAYS.slice(0, 4)) deposit(day, ACME_NET[300_000])
    for (const day of FRIDAYS.slice(4)) deposit(day, 200_000, 'Newco Payroll')
    // August's window ends ten days after Acme's last check, so Acme is still paying then.
    assert.deepEqual(payRunRates('2026-08').keys.map((k) => k.paycheckKey), [KEY])
    // By September's end it's 40 days, more than two biweekly periods and their grace (33).
    assert.deepEqual(payRunRates('2026-09').keys.map((k) => k.paycheckKey), ['newco payroll|+'])
    const r = payRunRates('2026-10')
    assert.deepEqual(r.keys.map((k) => [k.paycheckKey, k.checks]), [['newco payroll|+', 5]])
    assert.equal(r.totals.takeHomeCents, 433_333)
  })

  test("a payroll that ended years ago keeps the checks a year it paid: Acme's 2,000.00 on the 15th and the 28th through 2023 is 4,000.00 a month in August 2023, while Newco's monthly 2,500.00 since is 2,500.00", () => {
    for (let m = 1; m <= 12; m++) for (const d of [15, 28]) deposit(`2023-${String(m).padStart(2, '0')}-${d}`, 200_000)
    for (let m = '2024-01'; m <= '2026-10'; m = shiftMonth(m, 1)) deposit(`${m}-01`, 250_000, 'Newco Payroll')
    assert.deepEqual([checksPerYear(KEY, '2023-08'), checksPerYear(KEY, '2023-12'), checksPerYear('newco payroll|+', '2025-08')], [24, 24, 12])
    const august = payRunRates('2023-08')
    assert.deepEqual(august.keys.map((k) => [k.paycheckKey, k.checksPerYear, k.checks]), [[KEY, 24, 6]])
    assert.equal(august.totals.takeHomeCents, 400_000)
    assert.equal(payRunRates('2025-08').totals.takeHomeCents, 250_000)
    // A month's answer reads only checks up to it, so it's the same two years on.
    mock.timers.setTime(noonOn(2028, 11, 7) * 1000)
    try {
      assert.deepEqual(payRunRates('2023-08'), august)
    } finally {
      mock.timers.setTime(noonOn(Y, M, D) * 1000)
    }
  })

  test('an estimated stub with net 1,944.00 against a deposit of 1,960.00 gives a Payroll difference of +16.00, and the chain still ties', () => {
    deposit('2026-09-04', 194_400)
    deposit('2026-09-18', 196_000)
    acmeStub('2026-09-04', 300_000)
    const [own, later] = monthChecks('2026-09')
    assert.deepEqual([own.basis, own.differenceCents], ['paystub', 0])
    assert.deepEqual([later.basis, later.stubId, later.netCents, later.differenceCents], ['estimated', own.stubId, 194_400, 1_600])
    const t = payTotals(monthChecks('2026-09'))
    assert.equal(t.payrollDiffCents, 1_600)
    assert.equal(t.grossCents - t.taxesCents - t.benefitsCents - t.savedAtWorkCents + t.payrollDiffCents, t.takeHomeCents)
    assert.equal(t.takeHomeCents, 194_400 + 196_000)
  })

  test("a check's own stub that differs from its deposit by 2.00 raises paystub_mismatch; 1.00 doesn't", () => {
    acmeStub('2026-09-04', 300_000)
    acmeStub('2026-09-18', 300_000)
    deposit('2026-09-04', 194_500)
    const off = deposit('2026-09-18', 194_600)
    const issues = openIssues().filter((i) => i.kind === 'paystub_mismatch')
    assert.equal(issues.length, 1)
    assert.equal(issues[0].recurring_key, KEY)
    assert.deepEqual(issues[0].transaction_ids, [off])
    assert.match(issues[0].summary, /2026-09-18: net \$1,944\.00, deposited \$1,946\.00/)
    assert.doesNotMatch(issues[0].summary, /2026-09-04/)
    assert.equal(openIssues().filter((i) => i.kind === 'paystub_missing').length, 0)
  })

  test("a latest check with no stub of its own whose estimate is more than $1 off raises paystub_missing", () => {
    acmeStub('2026-09-04', 300_000)
    deposit('2026-09-04', 194_400)
    deposit('2026-09-18', 194_400)
    assert.deepEqual(openIssues().filter((i) => i.kind.startsWith('paystub_')), [])
    // A raise the stub doesn't know about.
    deposit('2026-10-02', 201_000)
    const issues = openIssues().filter((i) => i.kind.startsWith('paystub_'))
    assert.deepEqual(issues.map((i) => i.kind), ['paystub_missing'])
    assert.match(issues[0].summary, /latest check, 2026-10-02, has no paystub of its own, and the one it's estimated from \(2026-09-04\) gives net \$1,944\.00 against \$2,010\.00 deposited/)
  })

  test("a bonus stub counts in October's actuals and in no run rate; yearCheck includes it", () => {
    // Seven regular checks, each with its stub, and a bonus paid on Oct 9 with its own.
    for (const day of FRIDAYS.slice(2)) {
      deposit(day, ACME_NET[300_000])
      acmeStub(day, 300_000)
    }
    const bonus = deposit('2026-10-09', 351_750)
    savePaystub({
      paycheckKey: KEY,
      payDay: '2026-10-09',
      kind: 'bonus',
      grossCents: 500_000,
      items: [
        { kind: 'federal', cents: 110_000 },
        { kind: 'social_security', cents: 31_000 },
        { kind: 'medicare', cents: 7_250 }
      ]
    })
    // The classifier takes the whole deposit as bonus, by its stub.
    assert.deepEqual(
      classifyLines('2026-10-09', '2026-10-09').map((l) => [l.key, l.cls, l.cents]),
      [[`${bonus}::p:bonus`, 'pay', 351_750]]
    )
    const october = monthChecks('2026-10')
    assert.deepEqual(october.map((c) => [c.day, c.kind, c.basis]), [['2026-10-02', 'regular', 'paystub'], ['2026-10-09', 'bonus', 'paystub'], ['2026-10-16', 'regular', 'paystub'], ['2026-10-30', 'regular', 'paystub']])
    const t = payTotals(october)
    assert.deepEqual([t.grossCents, t.taxesCents, t.payrollDiffCents, t.takeHomeCents], [1_400_000, 3 * 72_000 + 148_250, 0, 3 * 194_400 + 351_750])
    // The run rate reads the seven regular checks alone.
    const r = payRunRates('2026-10')
    assert.deepEqual([r.keys[0].checks, r.totals.grossCents, r.totals.taxesCents], [7, 650_000, 156_000])
    // Wages are gross less pre-tax lines over every stub: 7 x (3,000.00 - 96.00 - 240.00) + 5,000.00.
    const y = yearCheck(2026)
    assert.deepEqual([y.complete, y.wagesCents, y.federalCents, y.checks], [true, 7 * 266_400 + 500_000, 7 * 36_000 + 110_000, []])
    setTaxYear(2026, { status: 'filed', wagesCents: 2_364_800, withheldCents: 362_000 })
    assert.deepEqual(yearCheck(2026).checks, [])
    // A return whose wages leave the bonus out is 5,000.00 short.
    setTaxYear(2026, { wagesCents: 1_864_800 })
    assert.deepEqual(yearCheck(2026).checks, [{ kind: 'w2_mismatch', cents: 500_000, year: 2026 }])
    // A check with no stub of its own leaves the year incomplete, and nothing is compared.
    deposit('2026-11-06', ACME_NET[300_000])
    assert.deepEqual([yearCheck(2026).complete, yearCheck(2026).checks], [false, []])
  })

  test("grossOn a bonus pay day is its bonus stub's gross, so Gross pay is grossOn summed over the month's pay days", () => {
    for (const day of ['2026-10-02', '2026-10-16']) {
      deposit(day, ACME_NET[300_000])
      acmeStub(day, 300_000)
    }
    deposit('2026-10-09', 351_750)
    savePaystub({ paycheckKey: KEY, payDay: '2026-10-09', kind: 'bonus', grossCents: 500_000, items: [{ kind: 'federal', cents: 110_000 }, { kind: 'social_security', cents: 31_000 }, { kind: 'medicare', cents: 7_250 }] })
    assert.deepEqual(grossOn(KEY, '2026-10-09'), { cents: 500_000, basis: 'paystub' })
    assert.deepEqual(grossOn(KEY, '2026-10-02'), { cents: 300_000, basis: 'paystub' })
    const october = monthChecks('2026-10')
    assert.equal([...new Set(october.map((c) => c.day))].reduce((s, d) => s + grossOn(KEY, d).cents, 0), payTotals(october).grossCents)
    assert.equal(payTotals(october).grossCents, 1_100_000)
  })

  test('an estimate stops the 401(k) at the deferral limit through the year so far, and Social Security at the wage base', () => {
    savePaystub({
      paycheckKey: KEY,
      payDay: '2026-09-04',
      grossCents: 1_000_000,
      items: [
        { kind: 'federal', cents: 200_000 },
        { kind: 'social_security', cents: 62_000, ytdCents: 1_116_000 },
        { kind: 'medicare', cents: 14_500 },
        { kind: 'state', cents: 50_000 },
        { kind: '401k', cents: 150_000, ytdCents: 2_400_000, employerCents: 50_000 }
      ]
    })
    // 24,500.00 less 24,000.00 leaves 500.00 of 401(k); 11,439.00 (6.2% of 184,500.00) less 11,160.00 leaves 279.00.
    for (const [day, cents] of [['2026-09-04', 523_500], ['2026-09-18', 657_600], ['2026-10-02', 735_500]] as const) deposit(day, cents)
    const line = (c: PayCheck, kind: string): [number, number | null] => {
      const x = c.items.find((i) => i.kind === kind)!
      return [x.cents, x.employerCents]
    }
    const [sep4, sep18, oct2] = payrollChecks('2026-09-01', '2026-10-31')
    assert.deepEqual([line(sep4, '401k'), line(sep4, 'social_security')], [[150_000, 50_000], [62_000, null]])
    assert.deepEqual([sep18.basis, line(sep18, '401k'), line(sep18, 'social_security')], ['estimated', [50_000, 16_667], [27_900, null]])
    assert.deepEqual([line(oct2, '401k'), line(oct2, 'social_security'), line(oct2, 'medicare')], [[0, 0], [0, null], [14_500, null]])
    assert.deepEqual([sep4, sep18, oct2].map((c) => [c.netCents, c.differenceCents]), [[523_500, 0], [657_600, 0], [735_500, 0]])
  })
})

describe('recording paystubs', () => {
  beforeEach(household)
  afterEach(db.closeDb)

  test('a paystub saved before the third deposit, with no recurring series yet, matches its deposit when it comes', () => {
    deposit('2026-08-21', ACME_NET[300_000])
    deposit('2026-09-04', ACME_NET[300_000])
    const items = acmeLines(300_000).map((x) => ({ kind: x.kind, name: x.name, amount: x.cents / 100 }))
    const r = runTool('record_paystub', { paycheck_key: 'Acme Corp Payroll', pay_day: '2026-09-18', gross: 3000, items, net: 1944 }, 'assistant')
    const [stub] = listPaystubs(KEY)
    assert.deepEqual([r.result, stub.payDay, stub.netCents, stub.source], [{ ok: true, id: stub.id }, '2026-09-18', 194_400, 'paystub'])
    assert.match(r.action!, /^Paystub: acme corp payroll · 2026-09-18 · gross \$3,000\.00, taxes \$720\.00, benefits \$96\.00, saved \$240\.00, net \$1,944\.00$/)
    // The checks before it read it from later in the year; its own deposit isn't here yet.
    assert.deepEqual(payrollChecks('2026-08-01', '2026-09-30').map((c) => [c.day, c.basis]), [['2026-08-21', 'estimated'], ['2026-09-04', 'estimated']])
    const third = deposit('2026-09-18', ACME_NET[300_000])
    const own = payrollChecks('2026-09-18', '2026-09-18')[0]
    assert.deepEqual([own.basis, own.stubId, own.grossCents, own.txnIds], ['paystub', stub.id, 300_000, [third]])
    assert.deepEqual(paystubOn(KEY, '2026-09-19'), { stub, basis: 'paystub' })
    assert.deepEqual(grossOn(KEY, '2026-09-18'), { cents: 300_000, basis: 'paystub' })
    // Undone, the stub goes, and the checks have only their deposits.
    undoChange(r.changeId)
    assert.deepEqual(listPaystubs(KEY), [])
    assert.deepEqual(payrollChecks('2026-09-18', '2026-09-18').map((c) => [c.basis, c.grossCents]), [['deposits', 194_400]])
  })

  test("net must be gross less the items, and a stub for the same pay day and kind is replaced, which Undo puts back", () => {
    deposit('2026-09-04', ACME_NET[300_000])
    const items = acmeLines(300_000).map((x) => ({ kind: x.kind, name: x.name, amount: x.cents / 100 }))
    assert.throws(() => runTool('record_paystub', { paycheck_key: KEY, pay_day: '2026-09-04', gross: 3000, items, net: 1950 }, 'assistant'), /Gross less the lines taken out is 1944\.00, not the net pay of 1950\.00/)
    assert.throws(() => runTool('record_paystub', { paycheck_key: KEY, pay_day: '2026-09-04', gross: 3000, items: [{ kind: 'tips', amount: 1 }] }, 'assistant'), /Unknown paystub line tips/)
    const first = runTool('record_paystub', { paycheck_key: KEY, pay_day: '2026-09-04', gross: 3000, items }, 'assistant')
    const id = listPaystubs(KEY)[0].id
    // A 401(k) of 250.00 in place of 240.00, on the same check.
    const again = runTool('record_paystub', { paycheck_key: KEY, pay_day: '2026-09-04', gross: 3000, items: items.map((x) => (x.kind === '401k' ? { ...x, amount: 250 } : x)) }, 'assistant')
    assert.deepEqual(listPaystubs(KEY).map((s) => [s.id, s.netCents]), [[id, 193_400]])
    assert.equal(payrollChecks('2026-09-04', '2026-09-04')[0].differenceCents, 1_000)
    undoChange(again.changeId)
    assert.deepEqual(listPaystubs(KEY).map((s) => [s.id, s.netCents, s.items.find((x) => x.kind === '401k')!.cents]), [[id, 194_400, 24_000]])
    undoChange(first.changeId)
    assert.deepEqual(listPaystubs(KEY), [])
  })

  test("set_paycheck_withholding, record_paystub's older form, needs no series and keeps the stub's other lines; Undo puts it back", () => {
    deposit('2026-09-04', ACME_NET[300_000])
    db.saveContribution({ name: 'Acme 401(k)', kind: '401k', paycheckKey: KEY, percent: 8, employeeCents: 24_000, matchCents: 12_000 })
    const r = runTool('set_paycheck_withholding', { paycheck_key: KEY, as_of: '2026-09-04', gross: 3000, federal: 360, social_security: 186, medicare: 43.5, state: 130.5, insurance: [{ type: 'Medical insurance', per_paycheck: 96, pretax: true }], net: 1944 }, 'assistant')
    const [stub] = listPaystubs(KEY)
    // The plan's election comes in as its line, so net is gross less every line.
    assert.deepEqual(
      stub.items.map((x) => [x.kind, x.name, x.cents, x.employerCents]),
      [['federal', 'Federal income tax', 36_000, null], ['social_security', 'Social Security', 18_600, null], ['medicare', 'Medicare', 4_350, null], ['state', 'State income tax', 13_050, null], ['medical', 'Medical insurance', 9_600, null], ['401k', 'Acme 401(k)', 24_000, 12_000]]
    )
    assert.equal(stub.netCents, 194_400)
    // A later call that changes one tax keeps the rest.
    const next = runTool('set_paycheck_withholding', { paycheck_key: KEY, as_of: '2026-09-04', federal: 380 }, 'assistant')
    assert.deepEqual([listPaystubs(KEY)[0].items.find((x) => x.kind === 'federal')!.cents, listPaystubs(KEY)[0].netCents, listPaystubs(KEY)[0].items.length], [38_000, 192_400, 6])
    undoChange(next.changeId)
    assert.equal(listPaystubs(KEY)[0].netCents, 194_400)
    undoChange(r.changeId)
    assert.deepEqual(listPaystubs(KEY), [])
  })

  test('set_paycheck_withholding keeps a premium of no known type apart from other deductions, and a stub with no gross on record keeps its net', () => {
    deposit('2026-09-04', 165_000)
    // As migration 39 copies withholding with no gross: the net of 1,650.00 plus the lines, marked estimated.
    const taxes = acmeLines(300_000).filter((x) => PAYSTUB_ITEMS[x.kind].row === 'taxes')
    savePaystub({ paycheckKey: KEY, payDay: '2026-09-04', grossCents: 165_000 + 73_500, items: [...taxes, { kind: 'other_deduction', name: 'Accident insurance', cents: 500 }, { kind: 'other_deduction', cents: 1_000 }], source: 'snapshot', estimated: true })
    const original = listPaystubs(KEY)
    const lines = (): Array<[string, string, number]> => listPaystubs(KEY)[0].items.filter((x) => PAYSTUB_ITEMS[x.kind].row === 'benefits').map((x) => [x.kind, x.name, x.cents])
    const r = runTool('set_paycheck_withholding', { paycheck_key: KEY, as_of: '2026-09-04', insurance: [{ type: 'Medical insurance', per_paycheck: 96, pretax: true }, { type: 'Accident insurance', per_paycheck: 5 }] }, 'assistant')
    assert.deepEqual(lines(), [['other_deduction', 'Other deductions', 1_000], ['medical', 'Medical insurance', 9_600], ['other_deduction', 'Accident insurance', 500]])
    // 1,650.00 plus taxes 720.00, other deductions 10.00 and premiums 101.00.
    assert.deepEqual([listPaystubs(KEY)[0].grossCents, listPaystubs(KEY)[0].netCents, listPaystubs(KEY)[0].estimated], [248_100, 165_000, true])
    assert.equal(payrollChecks('2026-09-04', '2026-09-04')[0].differenceCents, 0)
    const other = runTool('set_paycheck_withholding', { paycheck_key: KEY, as_of: '2026-09-04', other: 20 }, 'assistant')
    assert.deepEqual(lines(), [['other_deduction', 'Other deductions', 2_000], ['medical', 'Medical insurance', 9_600], ['other_deduction', 'Accident insurance', 500]])
    assert.deepEqual([listPaystubs(KEY)[0].grossCents, listPaystubs(KEY)[0].netCents], [249_100, 165_000])
    undoChange(other.changeId)
    undoChange(r.changeId)
    assert.deepEqual(listPaystubs(KEY), original)
  })

  test("a plan keyed by hand ('Acme Corp Payroll') is kept in the payroll's form, so its paystub line and its match reach it", () => {
    for (const day of ['2026-10-02', '2026-10-16']) deposit(day, ACME_NET[300_000])
    runTool('set_contribution', { name: 'Acme 401(k)', kind: '401k', paycheck_key: 'Acme Corp Payroll', percent: 8, per_paycheck: 240, match_rate_pct: 50, match_cap_pct: 6 }, 'assistant')
    acmeStub('2026-10-16', 300_000, { items: acmeLines(300_000).map((x) => (x.kind === '401k' ? { ...x, name: '401K PRE-TAX' } : x)) })
    const plan = db.listContributionRows()[0]
    assert.equal(plan.paycheckKey, KEY)
    assert.deepEqual(monthContributions('2026-10'), [{ name: 'Acme 401(k)', kind: '401k', paycheckKey: KEY, employeeCents: 48_000, matchCents: 0 }])
    // An 8% election is past the 6% the match covers: 50% of 6% of 3,000.00 is 90.00, and none is left.
    assert.deepEqual([matchLeft(plan)?.matchCents, matchLeft(plan)?.leftCents], [9_000, 0])
  })

  test("a Roth plan takes the stub's Roth line before an after-tax one, which shows by its own name", () => {
    deposit('2026-09-04', 184_400)
    db.saveContribution({ name: 'Acme Roth', kind: 'roth_401k', paycheckKey: KEY, employeeCents: 5_000 })
    acmeStub('2026-09-04', 300_000, { items: [...acmeLines(300_000), { kind: 'after_tax_401k', name: 'After-tax 401(k)', cents: 5_000 }, { kind: 'roth_401k', name: 'Roth 401K', cents: 5_000 }] })
    assert.deepEqual(monthContributions('2026-09'), [
      { name: 'Acme Roth', kind: 'roth_401k', paycheckKey: KEY, employeeCents: 5_000, matchCents: 0 },
      { name: 'Acme 401(k)', kind: '401k', paycheckKey: KEY, employeeCents: 24_000, matchCents: 0 },
      { name: 'After-tax 401(k)', kind: 'roth_401k', paycheckKey: KEY, employeeCents: 5_000, matchCents: 0 }
    ])
  })

  test("delete_paycheck_withholding deletes the payroll's latest paystub and is journaled", () => {
    acmeStub('2026-08-21', 300_000)
    const later = acmeStub('2026-09-04', 300_000)
    const before = listPaystubs(KEY)
    const r = runTool('delete_paycheck_withholding', { paycheck_key: KEY }, 'assistant')
    assert.deepEqual(r.result, { ok: true, pay_day: '2026-09-04' })
    assert.deepEqual(listPaystubs(KEY).map((s) => s.payDay), ['2026-08-21'])
    assert.equal(db.getChange(r.changeId!)!.tool, 'delete_paycheck_withholding')
    undoChange(r.changeId)
    assert.deepEqual(listPaystubs(KEY), before)
    assert.equal(listPaystubs(KEY)[1].id, later)
  })
})

describe('the structured match', () => {
  beforeEach(matchHousehold)
  afterEach(db.closeDb)

  test('50% of the first 6% with a 4% election on 3,000.00 semimonthly leaves 30.00 a check, which is 60.00 a month', () => {
    const r = runTool('set_contribution', { name: 'Acme 401(k)', kind: '401k', match_rate_pct: 50, match_cap_pct: 6 }, 'assistant')
    const plan = db.listContributionRows()[0]
    assert.deepEqual([plan.matchRateBp, plan.matchCapBp, plan.percent, plan.employeeCents], [5_000, 600, 4, 12_000])
    assert.equal(checksPerYear(KEY), 24)
    assert.deepEqual(matchLeft(plan), { electionBp: 400, matchCents: 6_000, leftCents: 3_000, leftPerMonthCents: 6_000, grossCents: 300_000, checksPerYear: 24 })
    const listed = runTool('list_contributions', {}).result as { plans: Array<Record<string, unknown>> }
    assert.deepEqual([listed.plans[0].match_rate_pct, listed.plans[0].match_cap_pct, listed.plans[0].match_left], [50, 6, { per_paycheck: 30, per_month: 60, on_gross: 3000 }])
    // Undone, the plan has no rule again.
    undoChange(r.changeId)
    const back = db.listContributionRows()[0]
    assert.deepEqual([back.matchRateBp, back.matchCapBp, matchLeft(back)], [null, null, null])
  })
})

describe('migration 39', () => {
  afterEach(db.closeDb)

  test("each paycheck's withholding becomes a paystub with its plans' lines; keys take the payroll's form and keep their elections; a key that matches nothing raises one question", () => {
    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 38 })
    db.upsertAccount({ id: CHECKING, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    db.updateAccount(CHECKING, { assetType: 'cash' })
    for (const day of ['2026-08-21', '2026-09-04', '2026-09-18']) deposit(day, 165_000, 'Acme Payroll')
    // A plan keyed by hand, a plan keyed as a series, and one for a job with no deposits.
    const handKeyed = db.saveContribution({ name: 'Acme 401(k)', kind: '401k', paycheckKey: 'Acme Payroll', percent: 8, employeeCents: 24_000, matchCents: 12_000, matchNote: '50% of the first 8%', startsDay: '2026-01-01' })
    // As a build before migration 39 kept a key typed by hand.
    db.all("UPDATE contributions SET paycheck_key = 'Acme Payroll' WHERE id = ?", handKeyed)
    db.saveContribution({ name: 'Acme HSA', kind: 'hsa', paycheckKey: 'acme payroll|+', employeeCents: 5_000 })
    db.saveContribution({ name: 'Initech 401(k)', kind: '401k', paycheckKey: 'initech payroll|+', employeeCents: 10_000, endsDay: '2025-12-31' })
    db.all(
      `INSERT INTO paycheck_withholding (paycheck_key, as_of, gross_cents, federal_cents, social_security_cents, medicare_cents, state_cents, insurance_cents, other_cents, net_cents, updated_at, insurance_items)
       VALUES ('acme payroll|+', '2026-09-18', 300000, 36000, 18600, 4350, 13050, 9600, 0, 165000, 1790000000, '[{"name":"Medical insurance","cents":9600,"pretax":true}]')`
    )
    db.all("INSERT INTO paycheck_withholding (paycheck_key, as_of, federal_cents, updated_at) VALUES ('initech payroll|+', '2025-12-19', 30000, 1790000000)")
    db.migrate()
    assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
    const plans = db.listContributionRows()
    assert.deepEqual(
      plans.map((p) => [p.name, p.paycheckKey, p.percent, p.employeeCents, p.matchCents, p.matchNote, p.matchRateBp, p.matchCapBp]),
      [
        ['Acme 401(k)', 'acme payroll|+', 8, 24_000, 12_000, '50% of the first 8%', null, null],
        ['Initech 401(k)', 'initech payroll|+', null, 10_000, null, null, null, null],
        ['Acme HSA', 'acme payroll|+', null, 5_000, null, null, null, null]
      ]
    )
    const stubs = listPaystubs()
    assert.deepEqual(stubs.map((s) => [s.paycheckKey, s.payDay, s.kind, s.source, s.estimated, s.grossCents, s.netCents]), [['acme payroll|+', '2026-09-18', 'regular', 'snapshot', false, 300_000, 300_000 - 110_600]])
    assert.deepEqual(
      stubs[0].items.map((x) => [x.kind, x.name, x.cents, x.pretax, x.employerCents]),
      [
        ['federal', 'Federal income tax', 36_000, false, null],
        ['social_security', 'Social Security', 18_600, false, null],
        ['medicare', 'Medicare', 4_350, false, null],
        ['state', 'State income tax', 13_050, false, null],
        ['medical', 'Medical insurance', 9_600, true, null],
        ['401k', 'Acme 401(k)', 24_000, true, 12_000],
        ['hsa', 'Acme HSA', 5_000, true, null]
      ]
    )
    // The elections still reach the checks, through the copied stub.
    assert.deepEqual(monthContributions('2026-09'), [
      { name: 'Acme 401(k)', kind: '401k', paycheckKey: 'acme payroll|+', employeeCents: 48_000, matchCents: 24_000 },
      { name: 'Acme HSA', kind: 'hsa', paycheckKey: 'acme payroll|+', employeeCents: 10_000, matchCents: 0 }
    ])
    const questions = db.listOpenQuestions()
    assert.equal(questions.length, 1)
    assert.match(questions[0].text, /match no deposit: 'initech payroll\|\+'/)
    assert.match(questions[0].text, /withholding kept for 'initech payroll\|\+' had neither gross nor net pay/)
    assert.deepEqual(db.checkIntegrity(), { corruption: [], foreignKeys: [] })
  })
})

describe('paystubs on the sample household', () => {
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
  })
  after(db.closeDb)

  test('its stub has 401(k) 277.00 and HSA 75.00 lines with employer 138.50 and 50.00: Saved at work is 352.00 a check and the Payroll difference -0.38, with no paystub_mismatch', () => {
    const [stub] = listPaystubs()
    assert.equal(stub.source, 'snapshot')
    assert.deepEqual(
      stub.items.filter((x) => x.kind === '401k' || x.kind === 'hsa').map((x) => [x.kind, x.cents, x.employerCents]),
      [['401k', 27_700, 13_850], ['hsa', 7_500, 5_000]]
    )
    // Gross 4,615.38 less taxes 1,150.00, insurance 166.00, 401(k) 277.00 and HSA 75.00.
    assert.deepEqual([stub.grossCents, stub.netCents], [461_538, 294_738])
    const year = stub.payDay.slice(0, 4)
    const checks = payrollChecks(`${year}-01-01`, `${year}-12-31`)
    assert.ok(checks.length >= 1)
    for (const c of checks) {
      assert.deepEqual([c.savedAtWorkCents, c.employerSavingCents, c.taxesCents, c.benefitsCents, c.depositCents, c.differenceCents], [35_200, 18_850, 115_000, 16_600, 294_700, -38], c.day)
      assert.equal(c.basis, c.day === stub.payDay ? 'paystub' : 'estimated')
    }
    assert.deepEqual(openIssues().filter((i) => i.kind === 'paystub_mismatch' || i.kind === 'paystub_missing'), [])
  })

  test("the tax estimate's paychecks are as the withholding had them", () => {
    const [stub] = listPaystubs()
    const [p] = getTaxes().paychecks
    assert.deepEqual(
      { ...p, checksLeft: undefined },
      { employer: 'Northwind Logistics', paycheckKey: 'northwind logistics payroll|+', asOf: stub.payDay, grossCents: 461_538, federalCents: 61_200, socialSecurityCents: 28_600, medicareCents: 6_700, stateCents: 18_500, checksLeft: undefined }
    )
    const [w] = contributionSummary().withholding
    assert.deepEqual([w.asOf, w.grossCents, w.netCents, w.federalCents, w.insuranceCents, w.insurance.map((x) => x.name)], [stub.payDay, 461_538, 294_738, 61_200, 16_600, ['Medical insurance', 'Dental insurance', 'Vision insurance']])
  })

  test("acceptance: the Money flow's contributions and withholding are each month's checks times the per-check figures, as before paystubs", () => {
    const [stub] = listPaystubs()
    const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
    for (let m = first; m <= db.today().slice(0, 7); m = shiftMonth(m, 1)) {
      const days = db.paycheckDays('northwind logistics payroll|+', `${m}-01`, lastDay(m))
      const withheld = days.filter((d) => d.slice(0, 4) >= stub.payDay.slice(0, 4)).length
      assert.deepEqual(
        monthContributions(m),
        days.length
          ? [
              { name: 'Northwind 401(k)', kind: '401k', paycheckKey: 'northwind logistics payroll|+', employeeCents: 27_700 * days.length, matchCents: 13_850 * days.length },
              { name: 'HSA', kind: 'hsa', paycheckKey: 'northwind logistics payroll|+', employeeCents: 7_500 * days.length, matchCents: 5_000 * days.length }
            ]
          : [],
        m
      )
      assert.deepEqual(
        monthWithholding(m),
        withheld
          ? [
              {
                paycheckKey: 'northwind logistics payroll|+',
                federalCents: 61_200 * withheld,
                socialSecurityCents: 28_600 * withheld,
                medicareCents: 6_700 * withheld,
                stateCents: 18_500 * withheld,
                insuranceCents: 16_600 * withheld,
                insurance: [
                  { name: 'Medical insurance', cents: 14_200 * withheld, pretax: true },
                  { name: 'Dental insurance', cents: 1_800 * withheld, pretax: true },
                  { name: 'Vision insurance', cents: 600 * withheld, pretax: true }
                ],
                otherCents: 0
              }
            ]
          : [],
        m
      )
    }
  })
})
