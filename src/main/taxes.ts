import * as db from './db'
import { fileFound } from './files'
import { CADENCES, detectRecurring, nextDate } from './recurring'
import { categoryRole } from '../shared/categoryRole'
import type { Paystub, PaystubItemKind, TaxMoney, TaxPaycheck, TaxYear, TaxesView } from '../shared/types'

// Federal income tax, year by year: each return as filed (and this year's
// estimate before it's filed), entered by the assistant from the returns and
// forms; what each paycheck withholds now; and money in the Taxes category.

const KEY = 'taxes'

function load(): TaxYear[] {
  const raw = db.getSetting(KEY)
  const s = (raw ? JSON.parse(raw) : {}) as { years?: TaxYear[] }
  return (s.years ?? []).map((y) => ({ ...blank(y.year), ...y }))
}

function save(years: TaxYear[]): void {
  db.setSetting(KEY, JSON.stringify({ years: [...years].sort((a, b) => a.year - b.year) }))
}

const blank = (year: number): TaxYear => ({
  year,
  status: 'filed',
  filingStatus: null,
  preparer: null,
  filedDay: null,
  wagesCents: null,
  incomeCents: null,
  agiCents: null,
  deduction: null,
  deductionCents: null,
  taxableCents: null,
  taxCents: null,
  withheldCents: null,
  paymentsCents: null,
  refundCents: null,
  lines: [],
  forms: [],
  issues: [],
  asOf: null,
  source: null
})

export function listTaxYears(): TaxYear[] {
  return load().sort((a, b) => b.year - a.year)
}

/** Adds or updates one year; fields left out stay as they are. */
export function setTaxYear(year: number, patch: Partial<Omit<TaxYear, 'year'>>): { taxYear: TaxYear; added: boolean } {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new Error('year must be a four-digit tax year')
  if (patch.status !== undefined && patch.status !== 'filed' && patch.status !== 'estimate') throw new Error('status must be filed or estimate')
  if (patch.deduction !== undefined && patch.deduction !== null && patch.deduction !== 'standard' && patch.deduction !== 'itemized') throw new Error('deduction must be standard or itemized')
  for (const day of [patch.filedDay, patch.asOf]) if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Dates are YYYY-MM-DD')
  const years = load()
  const i = years.findIndex((y) => y.year === year)
  const taxYear: TaxYear = { ...blank(year), ...(i >= 0 ? years[i] : {}), ...patch, year }
  if (i >= 0) years[i] = taxYear
  else years.push(taxYear)
  save(years)
  return { taxYear, added: i < 0 }
}

export function deleteTaxYear(year: number): void {
  const years = load()
  const kept = years.filter((y) => y.year !== year)
  if (kept.length === years.length) throw new Error(`No tax year ${year}`)
  save(kept)
}

/** Whether a path is one of the forms on file, so only those can be opened from the page. */
export function isTaxForm(file: string): boolean {
  return load().some((y) => y.forms.some((f) => f.file === file))
}

/** Every form path on file. */
export const taxFormPaths = (): string[] => load().flatMap((y) => y.forms.map((f) => f.file))

/** One year as stored (for a journal), or null. */
export const findTaxYear = (year: number): TaxYear | null => load().find((y) => y.year === year) ?? null

const employerName = (paycheck: string): string => paycheck.replace(/\s+(group\s+)?(payroll|direct dep(osit)?|pay)$/i, '').trim()

/** What each current paycheck withholds per check, from its payroll's latest regular paystub, and how many checks are left this year. */
function paychecks(year: number): TaxPaycheck[] {
  const series = new Map(detectRecurring().map((s) => [s.key, s]))
  const yearEnd = `${year}-12-31`
  const latest = new Map<string, Paystub>()
  for (const s of db.listPaystubs()) if (s.kind === 'regular') latest.set(s.paycheckKey, s)
  const out: TaxPaycheck[] = []
  for (const s of [...latest.values()].sort((a, b) => a.paycheckKey.localeCompare(b.paycheckKey))) {
    const pay = series.get(s.paycheckKey)
    if (!pay || pay.status === 'stopped') continue
    const c = CADENCES.find((x) => x.id === pay.cadence)
    let left = 0
    if (c) for (let d = pay.nextDate; db.dayKey(d) <= yearEnd; d = nextDate(d, pay.cadence, c.days)) left++
    const tax = (kind: PaystubItemKind): number => s.items.filter((x) => x.kind === kind).reduce((t, x) => t + x.cents, 0)
    out.push({
      employer: employerName(pay.name),
      paycheckKey: s.paycheckKey,
      asOf: s.payDay,
      grossCents: s.grossCents,
      federalCents: tax('federal'),
      socialSecurityCents: tax('social_security'),
      medicareCents: tax('medicare'),
      stateCents: tax('state'),
      checksLeft: left
    })
  }
  return out.sort((a, b) => (b.grossCents ?? 0) - (a.grossCents ?? 0))
}

/** Refunds, payments and preparation fees: everything in the Taxes category, newest first. */
function money(): TaxMoney[] {
  const ids = db.listCategories().filter((c) => categoryRole(c.name) === 'taxes').map((c) => c.id)
  if (!ids.length) return []
  return db
    .all<{ id: string; posted: number; cents: number; description: string; merchant: string | null; account: string }>(
      // By line, so a split payment counts only its tax parts.
      `SELECT t.id, t.posted, SUM(t.amount_cents) AS cents, t.description, t.merchant, a.name AS account
       FROM ${db.TXN_LINES} t
       JOIN accounts a ON a.id = t.account_id
       JOIN categories c ON c.id = t.category_id
       WHERE c.id IN (${ids.join(',')}) AND t.pending = 0
       GROUP BY t.id ORDER BY t.posted DESC, t.id`
    )
    .map((r) => ({ id: r.id, day: db.dayKey(r.posted), cents: r.cents, description: r.merchant || r.description, account: r.account }))
}

export function getTaxes(): TaxesView {
  const year = Number(db.today().slice(0, 4))
  const years = listTaxYears()
  // Payments avoid an underpayment penalty when they reach 100% of the previous year's tax (110% when
  // its AGI was over $150,000, $75,000 married filing separately). It's for the year being estimated,
  // which stays the newest year until its return is filed, even into the next calendar year.
  const target = years[0]?.status === 'estimate' ? years[0].year : year
  const last = years.find((y) => y.year === target - 1 && y.status === 'filed' && y.taxCents !== null)
  const over = last && /separate/i.test(last.filingStatus ?? '') ? 7_500_000 : 15_000_000
  const pct = last && (last.agiCents ?? 0) > over ? 110 : 100
  const formFound: Record<string, boolean> = {}
  for (const y of years) for (const f of y.forms) if (!(f.file in formFound)) formFound[f.file] = fileFound(f.file)
  return {
    year,
    years,
    safeHarbor: last ? { year: target, fromYear: last.year, pct, cents: Math.round((last.taxCents! * pct) / 100) } : null,
    paychecks: paychecks(year),
    money: money(),
    formFound
  }
}
