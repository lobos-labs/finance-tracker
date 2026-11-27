// Payees and payrolls, by key. Recurring series, paycheckDays and the classifier all name a payee the
// same way, so they live here, with no app module behind them: db.ts, recurring.ts and lines.ts can each
// import them without importing one another. The kinds of paystub line are here too, for the same reason.

import type { PaystubItemKind } from './types'

/**
 * Normalizes a raw bank description into a stable key so the same merchant
 * matches across store numbers, dates and processor prefixes.
 * "SQ *BLUE BOTTLE #12 OAKLAND CA" -> "blue bottle oakland ca"
 */
export function descKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/purchase authorized on \d{1,2}\/\d{1,2}/g, ' ')
    .replace(/\b(sq|tst|sp|pp|paypal|pos|dd|bt|ic|fsp|pmt)\s?\*/g, ' ')
    .replace(/\b(pos|debit card|checkcard|recurring|purchase|ach)\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z&' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** What names a line's payee: its merchant, else its description's key. */
export interface Payee {
  merchant: string | null
  descKey: string
}

/** The payee, with spaces trimmed and ASCII letters lowered the way SQLite's trim and lower leave them, so keys stored before keep matching. */
export const payeeName = (row: Payee): string => (row.merchant ?? row.descKey).replace(/^ +| +$/g, '').replace(/[A-Z]+/g, (c) => c.toLowerCase())

/** A recurring series' key: the payee and which way the money went. */
export const payeeKey = (row: Payee & { cents: number }): string => `${payeeName(row)}|${row.cents < 0 ? '-' : '+'}`

/** The payroll a deposit comes from: its payee's key for money in. Recurring series, paycheckDays and the classifier all name pay by it. */
export const payrollKey = (row: Payee): string => `${payeeName(row)}|+`

/** A payroll key as given by hand ('Acme Payroll', 'acme payroll|+'), as payrollKey names it. */
export const asPayrollKey = (key: string): string => {
  const k = key.trim()
  return payrollKey({ merchant: k.endsWith('|+') ? k.slice(0, -2) : k, descKey: '' })
}

// ---------- paystub lines ----------

/** Which row each kind of paystub line leads into on its way to Take-home (Taxes, Benefits or Saved at work), its name, and whether it's usually taken before income tax. */
export const PAYSTUB_ITEMS: Record<PaystubItemKind, { row: 'taxes' | 'benefits' | 'savedAtWork'; label: string; pretax: boolean }> = {
  federal: { row: 'taxes', label: 'Federal income tax', pretax: false },
  social_security: { row: 'taxes', label: 'Social Security', pretax: false },
  medicare: { row: 'taxes', label: 'Medicare', pretax: false },
  state: { row: 'taxes', label: 'State income tax', pretax: false },
  local: { row: 'taxes', label: 'Local income tax', pretax: false },
  sdi: { row: 'taxes', label: 'SDI / PFML', pretax: false },
  other_tax: { row: 'taxes', label: 'Other tax', pretax: false },
  medical: { row: 'benefits', label: 'Medical insurance', pretax: true },
  dental: { row: 'benefits', label: 'Dental insurance', pretax: true },
  vision: { row: 'benefits', label: 'Vision insurance', pretax: true },
  life: { row: 'benefits', label: 'Life insurance', pretax: false },
  disability: { row: 'benefits', label: 'Disability insurance', pretax: false },
  fsa: { row: 'benefits', label: 'FSA', pretax: true },
  dependent_care: { row: 'benefits', label: 'Dependent care FSA', pretax: true },
  commuter: { row: 'benefits', label: 'Commuter benefit', pretax: true },
  other_deduction: { row: 'benefits', label: 'Other deductions', pretax: false },
  // Roth, after-tax and the ESPP come out after income tax; the other plans before it.
  '401k': { row: 'savedAtWork', label: '401(k)', pretax: true },
  roth_401k: { row: 'savedAtWork', label: 'Roth 401(k)', pretax: false },
  after_tax_401k: { row: 'savedAtWork', label: 'After-tax 401(k)', pretax: false },
  '403b': { row: 'savedAtWork', label: '403(b)', pretax: true },
  '457': { row: 'savedAtWork', label: '457(b)', pretax: true },
  hsa: { row: 'savedAtWork', label: 'HSA', pretax: true },
  espp: { row: 'savedAtWork', label: 'ESPP', pretax: false }
}

export const PAYSTUB_ITEM_KINDS = Object.keys(PAYSTUB_ITEMS) as PaystubItemKind[]

/** A savings plan taken out of pay before income tax or after it. */
export type PlanGroup = 'pretax' | 'posttax'

/**
 * Whether a savings plan comes out of pay before income tax or after it, by its paystub line's kind (spec section 6):
 * the 401(k), 403(b), 457(b) and HSA before, so they lower taxable wages; a Roth 401(k), an after-tax 401(k) and the
 * ESPP after.
 */
export const planGroup = (kind: PaystubItemKind): PlanGroup => (PAYSTUB_ITEMS[kind].pretax ? 'pretax' : 'posttax')

/** A premium's kind by its name ('Dental insurance' is dental), for withholding kept before paystubs had kinds; other_deduction when it names none. */
export function premiumKind(name: string): PaystubItemKind {
  if (/medical|health/i.test(name)) return 'medical'
  if (/dental/i.test(name)) return 'dental'
  if (/vision/i.test(name)) return 'vision'
  if (/\blife\b/i.test(name)) return 'life'
  if (/disab/i.test(name)) return 'disability'
  return 'other_deduction'
}
