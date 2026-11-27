import * as db from './db'
import { deletePolicy, listPolicies, restorePolicy } from './insurance'
import { addContribution, deleteGoal, getGoal, saveGoal } from './goals'
import { linkLoanPayments } from './lines'
import { savePaystub } from './paystubs'
import { forgetClosesOf } from './snapshots'
import type { CategorySource, Confidence, DemoResult, DemoStatus, InsurancePolicy } from '../shared/types'
import { addDays, addMonths, daysInMonth, weekday } from '../shared/zone'

// Sample data: a synthetic household so every page has something on it before
// the user has connected anything. Fourteen months ending today, from a fixed
// seed, so two loads on the same day are identical. Every demo account's id
// starts with DEMO_PREFIX (no schema change); transactions, balances, holdings
// and valuations hang off those accounts and go with them. Insurance policies
// carry the prefix in their ids too. The few rows that don't (contributions,
// paystubs, recurring overrides, reminders, facts, the rental's venture, goals)
// are listed in a setting so the remover can take exactly those.

export const DEMO_PREFIX = 'demo:'
export const isDemo = (id: string): boolean => id.startsWith(DEMO_PREFIX)

const LOADED_AT = 'demo.loadedAt'
const ROWS = 'demo.rows'
const SEED = 20261020
const MONTHS = 14

interface DemoRows {
  contributions: number[]
  paystubs: number[]
  /** payroll keys of withholding kept before paystubs (a sample loaded before migration 39, which copied it to a paystub) */
  withholding: string[]
  overrides: string[]
  events: number[]
  facts: number[]
  buckets: number[]
  goals: number[]
}

const ACCOUNTS = {
  checking: `${DEMO_PREFIX}checking`,
  savings: `${DEMO_PREFIX}savings`,
  visa: `${DEMO_PREFIX}card-visa`,
  mastercard: `${DEMO_PREFIX}card-mastercard`,
  retirement: `${DEMO_PREFIX}401k`,
  hsa: `${DEMO_PREFIX}hsa`,
  house: `${DEMO_PREFIX}house`,
  mortgage: `${DEMO_PREFIX}mortgage`,
  car: `${DEMO_PREFIX}car`,
  carLoan: `${DEMO_PREFIX}car-loan`,
  rentalChecking: `${DEMO_PREFIX}rental-checking`,
  condo: `${DEMO_PREFIX}condo`,
  condoMortgage: `${DEMO_PREFIX}condo-mortgage`
} as const

/** The rental condo (a venture): rent comes in and its costs go out through its own checking account. */
const RENTAL = {
  name: 'Bayview Condo',
  /** the month index the unit sat empty between tenants (painted and cleaned), after which the rent went up */
  vacant: 6,
  rentBefore: 215000,
  rentAfter: 225000,
  hoa: 38500,
  /** principal and interest plus the escrow for its taxes and the unit's insurance */
  mortgage: 138000,
  repairs: new Map<number, Array<{ day: number; cents: number; desc: string; name: string }>>([
    [2, [{ day: 14, cents: 28500, desc: 'DRAINRIGHT PLUMBING', name: 'DrainRight Plumbing' }]],
    [
      6,
      [
        { day: 8, cents: 115000, desc: 'PRO COAT PAINTING LLC', name: 'Pro Coat Painting' },
        { day: 19, cents: 24000, desc: 'SPARKLE CLEANING CO', name: 'Sparkle Cleaning' }
      ]
    ],
    [9, [{ day: 22, cents: 21000, desc: 'COASTAL APPLIANCE REPAIR', name: 'Coastal Appliance Repair' }]],
    [12, [{ day: 11, cents: 14500, desc: 'BAYSIDE LOCK AND KEY', name: 'Bayside Lock & Key' }]]
  ])
} as const

const PAYROLL = 'Northwind Logistics Payroll'
const PAYCHECK_KEY = `${PAYROLL.toLowerCase()}|+`
const NET_PAY = 294700

export function demoStatus(): DemoStatus {
  const at = db.getSetting(LOADED_AT)
  return { loaded: at !== null, loadedAt: at }
}

// ---------- deterministic randomness (mulberry32) ----------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- days ----------

const pad = (n: number): string => String(n).padStart(2, '0')
const key = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`
const daysIn = daysInMonth
const posted = (day: string): number => db.noon(day)
const shiftDays = addDays
/** The same day of the month n months away, clamped to that month's length. */
const shiftMonths = addMonths

// ---------- the dataset ----------

interface Txn {
  account: string
  day: string
  cents: number
  desc: string
  merchant: string | null
  category: string | null
  source: CategorySource | null
  confidence: Confidence | null
  oneTime?: boolean
  tags?: string[]
  /** split into parts by category, adding up to cents */
  split?: Array<{ cents: number; category: string; note?: string; oneTime?: boolean }>
}

interface Merchant {
  name: string
  desc: string
  lo: number
  hi: number
  confidence?: Confidence
}

const GROCERS: Merchant[] = [
  { name: 'Greenfield Market', desc: 'GREENFIELD MARKET #0412', lo: 3200, hi: 14500 },
  { name: 'Greenfield Market', desc: 'GREENFIELD MARKET #0412', lo: 3200, hi: 14500 },
  { name: 'Valley Co-op', desc: 'VALLEY COOP GROCERY', lo: 1800, hi: 7500 },
  { name: 'Costmart Wholesale', desc: 'COSTMART WHSE #221', lo: 9500, hi: 24000 }
]
const DINING: Merchant[] = [
  { name: 'Taqueria Luna', desc: 'TST* TAQUERIA LUNA', lo: 1400, hi: 4200 },
  { name: 'Pho 88', desc: 'PHO 88 RESTAURANT', lo: 1800, hi: 5200 },
  { name: 'The Oak Room', desc: 'THE OAK ROOM', lo: 4800, hi: 9800 },
  { name: 'Slice House Pizza', desc: 'SQ *SLICE HOUSE', lo: 1900, hi: 4100 },
  { name: 'DoorDish', desc: 'DOORDISH*ORDER', lo: 2400, hi: 5200, confidence: 'medium' }
]
const COFFEE: Merchant[] = [
  { name: 'Ember Coffee Roasters', desc: 'SQ *EMBER COFFEE', lo: 425, hi: 850 },
  { name: 'Daily Grind', desc: 'DAILY GRIND CAFE', lo: 375, hi: 725 }
]
const GAS: Merchant[] = [
  { name: 'QuickFuel', desc: 'QUICKFUEL #214', lo: 3800, hi: 7200 },
  { name: 'Summit Gas', desc: 'SUMMIT GAS 1182', lo: 3600, hi: 6900 }
]
const SHOPPING: Merchant[] = [
  { name: 'Shopmart.com', desc: 'SHOPMART.COM*A1B2C3', lo: 1800, hi: 14000 },
  { name: 'Shopmart.com', desc: 'SHOPMART.COM*D4E5F6', lo: 1800, hi: 9000 },
  { name: 'Northgate Hardware', desc: 'NORTHGATE HARDWARE', lo: 2200, hi: 9800, confidence: 'low' },
  { name: 'Thread & Needle', desc: 'THREAD AND NEEDLE CO', lo: 3500, hi: 12000 }
]
const FUN: Merchant[] = [
  { name: 'Cinema 12', desc: 'CINEMA 12 BOX OFFICE', lo: 2800, hi: 4600 },
  { name: 'GameHub', desc: 'GAMEHUB DIGITAL', lo: 1999, hi: 5999 },
  { name: 'City Books', desc: 'CITY BOOKS', lo: 1500, hi: 4200 }
]
const HEALTH: Merchant[] = [
  { name: 'Lakeview Family Medicine', desc: 'LAKEVIEW FAMILY MEDICINE', lo: 2500, hi: 18000 },
  { name: 'Rx Pharmacy', desc: 'RX PHARMACY #88', lo: 1200, hi: 6500 }
]

/** Electricity by calendar month: summer air conditioning, a winter bump. */
const SEASON = [1.1, 1.0, 0.8, 0.7, 0.8, 1.2, 1.5, 1.6, 1.3, 0.9, 0.8, 1.0]

function generate(today: string): { txns: Txn[]; start: Record<string, number>; lastPayday: string; windowStart: string } {
  const r = rng(SEED)
  const between = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]
  const txns: Txn[] = []
  const add = (t: Txn): void => {
    if (t.day <= today) txns.push(t)
  }
  const ai = (account: string, day: string, m: Merchant, category: string): void =>
    add({ account, day, cents: -between(m.lo, m.hi), desc: m.desc, merchant: m.name, category, source: 'ai', confidence: m.confidence ?? 'high' })
  const rule = (account: string, day: string, cents: number, desc: string, merchant: string, category: string): void => add({ account, day, cents, desc, merchant, category, source: 'rule', confidence: null })

  const windowStart = shiftMonths(`${today.slice(0, 7)}-01`, -(MONTHS - 1))
  const months = Array.from({ length: MONTHS }, (_, i) => {
    const [y, m] = shiftMonths(windowStart, i).split('-').map(Number)
    return { i, y, m, on: (d: number) => key(y, m, Math.min(d, daysIn(y, m))) }
  })

  // Card purchases first: each month's payment is the month before's spending.
  const visaSpend = new Map<number, number>([[-1, 118000]])
  for (const { i, y, m, on } of months) {
    const before = txns.length
    const dayIn = (): string => on(between(1, daysIn(y, m)))
    for (let n = between(6, 8); n > 0; n--) ai(ACCOUNTS.visa, dayIn(), pick(GROCERS), 'Groceries')
    for (let n = between(7, 10); n > 0; n--) ai(ACCOUNTS.visa, dayIn(), pick(DINING), 'Dining Out')
    for (let n = between(10, 15); n > 0; n--) ai(ACCOUNTS.visa, dayIn(), pick(COFFEE), 'Coffee')
    for (let n = between(3, 4); n > 0; n--) ai(ACCOUNTS.visa, dayIn(), pick(GAS), 'Gas & Fuel')
    for (let n = between(2, 4); n > 0; n--) ai(ACCOUNTS.visa, dayIn(), pick(SHOPPING), 'Shopping')
    for (let n = between(1, 2); n > 0; n--) ai(ACCOUNTS.visa, dayIn(), pick(FUN), 'Entertainment')
    if (r() < 0.5) ai(ACCOUNTS.visa, dayIn(), pick(HEALTH), 'Health & Medical')
    ai(ACCOUNTS.visa, dayIn(), { name: 'Clip & Co', desc: 'CLIP AND CO SALON', lo: 3500, hi: 6500 }, 'Personal Care')
    // Subscriptions, one of which raised its price.
    rule(ACCOUNTS.visa, on(4), i < 10 ? -1549 : -1799, 'STREAMLY.COM', 'Streamly', 'Subscriptions')
    rule(ACCOUNTS.visa, on(9), -1099, 'AUDIOWAVE USA', 'Audiowave', 'Subscriptions')
    rule(ACCOUNTS.visa, on(16), -299, 'CLOUDBOX STORAGE', 'CloudBox', 'Subscriptions')
    if (m === 12) ai(ACCOUNTS.visa, on(between(8, 20)), { name: 'Thread & Needle', desc: 'THREAD AND NEEDLE CO', lo: 8500, hi: 8500 }, 'Gifts & Donations')
    if (i === 4) {
      const tags = ['vacation']
      add({ account: ACCOUNTS.visa, day: on(6), cents: -41200, desc: 'BLUE HORIZON AIR', merchant: 'Blue Horizon Air', category: 'Travel', source: 'ai', confidence: 'high', tags })
      add({ account: ACCOUNTS.visa, day: on(13), cents: -64000, desc: 'HARBORVIEW HOTEL', merchant: 'Harborview Hotel', category: 'Travel', source: 'ai', confidence: 'high', tags })
      add({ account: ACCOUNTS.visa, day: on(13), cents: -18900, desc: 'RENT-A-RIDE CARS', merchant: 'Rent-A-Ride', category: 'Travel', source: 'ai', confidence: 'high', tags })
      add({ account: ACCOUNTS.visa, day: on(11), cents: -9800, desc: 'SQ *PIER 9 SEAFOOD', merchant: 'Pier 9 Seafood', category: 'Dining Out', source: 'ai', confidence: 'high', tags })
    }
    if (i === 6) add({ account: ACCOUNTS.visa, day: on(19), cents: -3400, desc: 'SQ *HNDMD GOODS 4432', merchant: null, category: null, source: null, confidence: null })
    if (i === 8) add({ account: ACCOUNTS.visa, day: on(21), cents: -129900, desc: 'SHOPMART.COM*LAPTOP', merchant: 'Shopmart.com', category: 'Shopping', source: 'ai', confidence: 'high', oneTime: true, tags: ['reimbursable'] })
    if (i === 10) add({ account: ACCOUNTS.visa, day: on(7), cents: -1999, desc: 'PAYPAL *DIGITALSVC', merchant: null, category: null, source: null, confidence: null })
    if (i === 12) for (let n = 0; n < 2; n++) add({ account: ACCOUNTS.visa, day: on(14), cents: -6420, desc: 'THE OAK ROOM', merchant: 'The Oak Room', category: 'Dining Out', source: 'ai', confidence: 'high' })
    // A warehouse run split three ways: the groceries, household supplies, and a patio heater bought once.
    if (i === MONTHS - 2) {
      const split = [
        { cents: -14862, category: 'Groceries' },
        { cents: -4485, category: 'Shopping', note: 'Household' },
        { cents: -12499, category: 'Shopping', note: 'Patio heater', oneTime: true }
      ]
      add({ account: ACCOUNTS.visa, day: on(18), cents: -31846, desc: 'COSTMART WHSE #221', merchant: 'Costmart Wholesale', category: 'Groceries', source: 'ai', confidence: 'high', split })
    }
    visaSpend.set(
      i,
      txns.slice(before).reduce((s, t) => s + Math.max(0, -t.cents), 0)
    )

    // The promo card: furniture, then the minimum each month.
    if (i === 1) add({ account: ACCOUNTS.mastercard, day: on(9), cents: -240000, desc: 'HARBOR HOME FURNISHINGS', merchant: 'Harbor Home Furnishings', category: 'Shopping', source: 'ai', confidence: 'high', oneTime: true })
    if (i === 7) ai(ACCOUNTS.mastercard, on(23), GROCERS[3], 'Groceries')
  }

  // Checking: the bills, the transfers, the payments.
  for (const { i, m, on } of months) {
    rule(ACCOUNTS.checking, on(1), -198500, 'PINECREST MORTGAGE PMT', 'Pinecrest Mortgage', 'Housing')
    rule(ACCOUNTS.checking, on(5), -54500, 'LAKESIDE AUTO LOAN PMT', 'Lakeside Auto Loan', 'Transfers')
    add({ account: ACCOUNTS.checking, day: on(8), cents: -between(4200, 5600), desc: 'CITY OF LAKESIDE WATER', merchant: 'Lakeside Water', category: 'Utilities', source: 'ai', confidence: 'high' })
    add({ account: ACCOUNTS.checking, day: on(12), cents: -Math.round(9500 * SEASON[m - 1] + between(0, 1500)), desc: 'PRAIRIE ELECTRIC CO ACH', merchant: 'Prairie Electric', category: 'Utilities', source: 'ai', confidence: 'high' })
    rule(ACCOUNTS.checking, on(15), -7999, 'FIBERONE INTERNET', 'FiberOne Internet', 'Utilities')
    rule(ACCOUNTS.checking, on(20), -8500, 'BLUEWAVE MOBILE AUTOPAY', 'Bluewave Mobile', 'Utilities')
    rule(ACCOUNTS.checking, on(17), -14800, 'CRESTLINE INS PREM', 'Crestline Insurance', 'Insurance')
    rule(ACCOUNTS.checking, on(22), -14200, 'HARBORLINE MUTUAL HO PREM', 'Harborline Mutual', 'Insurance')
    add({ account: ACCOUNTS.checking, day: on(3), cents: -4500, desc: 'RIDGE FITNESS MEMBERSHIP', merchant: 'Ridge Fitness', category: 'Fitness', source: 'ai', confidence: 'high' })
    add({ account: ACCOUNTS.checking, day: on(10), cents: -5000, desc: 'RIVERSIDE FOOD BANK', merchant: 'Riverside Food Bank', category: 'Gifts & Donations', source: 'ai', confidence: 'high' })
    rule(ACCOUNTS.checking, on(2), -50000, 'ONLINE TRANSFER TO SAVINGS ...8842', 'Transfer to Savings', 'Transfers')
    rule(ACCOUNTS.savings, on(2), 50000, 'ONLINE TRANSFER FROM CHECKING ...2210', 'Transfer from Checking', 'Transfers')
    // A card payment reaches the card two days after it leaves checking. It is in the sample once both sides have
    // posted: with one side still to come, the household would show money gone from checking and nowhere landed.
    const payment = visaSpend.get(i - 1) ?? 0
    if (payment > 0 && on(27) <= today) {
      rule(ACCOUNTS.checking, on(25), -payment, 'PAYMENT TO MERIDIAN CARD 4411', 'Rewards Visa Payment', 'Transfers')
      rule(ACCOUNTS.visa, on(27), payment, 'PAYMENT - THANK YOU', 'Payment', 'Transfers')
    }
    if (i >= 2 && on(22) <= today) {
      rule(ACCOUNTS.checking, on(20), -7500, 'PAYMENT TO NORTHWIND CARD 7730', 'Cashback Mastercard Payment', 'Transfers')
      rule(ACCOUNTS.mastercard, on(22), 7500, 'PAYMENT - THANK YOU', 'Payment', 'Transfers')
    }
    if (r() < 0.5) add({ account: ACCOUNTS.checking, day: on(between(3, 27)), cents: -6000, desc: 'ATM WITHDRAWAL 1142 MAIN ST', merchant: 'ATM', category: 'Cash & ATM', source: 'ai', confidence: 'high' })
    if (i === 11) add({ account: ACCOUNTS.checking, day: on(16), cents: -8500, desc: 'VENMO PAYMENT 1023 ALEX R', merchant: null, category: null, source: null, confidence: null })
    if (i === 13) add({ account: ACCOUNTS.checking, day: on(6), cents: -12000, desc: 'ZELLE TO JORDAN M', merchant: null, category: null, source: null, confidence: null })
    if (m === 3) add({ account: ACCOUNTS.checking, day: on(18), cents: 86000, desc: 'IRS TREAS 310 TAX REF', merchant: 'IRS Tax Refund', category: 'Taxes', source: 'ai', confidence: 'high' })
  }

  // The rental condo, on its own account: rent, the association's dues, the mortgage, repairs.
  for (const { i, on } of months) {
    if (i !== RENTAL.vacant) rule(ACCOUNTS.rentalChecking, on(1), i < RENTAL.vacant ? RENTAL.rentBefore : RENTAL.rentAfter, 'RENTPAY ACH 220 BAYVIEW CT 4B', 'Bayview Rent', 'Other Income')
    rule(ACCOUNTS.rentalChecking, on(5), -RENTAL.hoa, 'BAYVIEW CONDO ASSN DUES', 'Bayview Condo Association', 'Housing')
    rule(ACCOUNTS.rentalChecking, on(10), -RENTAL.mortgage, 'HARBOR BANK MORTGAGE PMT 4471', 'Bayview Condo Mortgage', 'Housing')
    for (const x of RENTAL.repairs.get(i) ?? []) add({ account: ACCOUNTS.rentalChecking, day: on(x.day), cents: -x.cents, desc: x.desc, merchant: x.name, category: 'Housing', source: 'ai', confidence: 'high' })
  }

  // Paychecks every other Friday.
  let payday = addDays(windowStart, (5 - weekday(windowStart) + 7) % 7)
  let lastPayday = payday
  for (; payday <= today; payday = shiftDays(payday, 14)) {
    rule(ACCOUNTS.checking, payday, NET_PAY, 'NORTHWIND LOGISTICS PAYROLL DIR DEP', PAYROLL, 'Paycheck')
    lastPayday = payday
  }

  // Savings interest on each month's last day, from the running balance.
  const start: Record<string, number> = { [ACCOUNTS.checking]: 420000, [ACCOUNTS.savings]: 1240000, [ACCOUNTS.visa]: -118000, [ACCOUNTS.mastercard]: 0, [ACCOUNTS.rentalChecking]: 480000 }
  let savings = start[ACCOUNTS.savings]
  for (const { y, m } of months) {
    const last = key(y, m, daysIn(y, m))
    savings += txns.filter((t) => t.account === ACCOUNTS.savings && t.day.slice(0, 7) === last.slice(0, 7)).reduce((s, t) => s + t.cents, 0)
    if (last > today) break
    const interest = Math.round((savings * 0.042) / 12)
    add({ account: ACCOUNTS.savings, day: last, cents: interest, desc: 'INTEREST PAID', merchant: 'Harbor Bank Interest', category: 'Other Income', source: 'ai', confidence: 'high' })
    savings += interest
  }

  txns.sort((a, b) => a.day.localeCompare(b.day) || a.account.localeCompare(b.account))
  return { txns, start, lastPayday, windowStart }
}

/** Values of an asset or debt at a few dates, from a starting figure and a monthly rate (compounded) or step. */
function series(fromDay: string, today: string, everyMonths: number, value: (months: number) => number): Array<{ day: string; cents: number }> {
  const out: Array<{ day: string; cents: number }> = []
  for (let n = 0; ; n += everyMonths) {
    const day = shiftMonths(fromDay, n)
    if (day >= today) break
    out.push({ day, cents: Math.round(value(n)) })
  }
  const months = (Date.parse(today) - Date.parse(fromDay)) / (30.44 * 86_400_000)
  out.push({ day: today, cents: Math.round(value(months)) })
  return out
}

/** A manual asset or debt under a demo id, with its dated values. */
function manual(id: string, a: Parameters<typeof db.addManualAccount>[0], points: Array<{ day: string; cents: number }>): void {
  const made = db.addManualAccount(a)
  db.all('UPDATE accounts SET id = ? WHERE id = ?', id, made)
  for (const p of points) db.setBalancePoint(id, p.day, p.cents)
}

export function loadDemoData(): DemoResult {
  if (demoStatus().loaded) clearDemoData()
  const today = db.dayKey(db.now())
  const now = db.now()
  const { txns, start, lastPayday, windowStart } = generate(today)
  const categoryId = new Map(db.listCategories().map((c) => [c.name.toLowerCase(), c.id]))

  const bank: Array<{ id: string; name: string; institution: string }> = [
    { id: ACCOUNTS.checking, name: 'Everyday Checking', institution: 'Harbor Bank' },
    { id: ACCOUNTS.savings, name: 'High-Yield Savings', institution: 'Harbor Bank' },
    { id: ACCOUNTS.visa, name: 'Rewards Visa', institution: 'Meridian Card Services' },
    { id: ACCOUNTS.mastercard, name: 'Cashback Mastercard', institution: 'Northwind Bank' },
    { id: ACCOUNTS.rentalChecking, name: 'Rental Checking', institution: 'Harbor Bank' }
  ]
  for (const a of bank) {
    const total = start[a.id] + txns.filter((t) => t.account === a.id).reduce((s, t) => s + t.cents, 0)
    db.upsertAccount({ ...a, source: 'csv', currency: 'USD', balanceCents: total, availableCents: null, balanceDate: now })
  }
  db.updateAccount(ACCOUNTS.checking, { assetType: 'cash' })
  db.updateAccount(ACCOUNTS.savings, { assetType: 'cash' })
  db.updateAccount(ACCOUNTS.rentalChecking, { assetType: 'cash' })
  db.updateAccount(ACCOUNTS.visa, { assetType: 'credit_card', apr: 24.99, minPaymentCents: 3500 })
  db.updateAccount(ACCOUNTS.mastercard, { assetType: 'credit_card', apr: 27.49, promoApr: 0, promoEnds: shiftMonths(today, 4), minPaymentCents: 7500 })

  // Statement-fed accounts: a balance each quarter, no transactions.
  const quarterly = (id: string, name: string, institution: string, assetType: 'retirement' | 'investment', values: number[]): void => {
    const points = values.map((cents, n) => ({ day: n === values.length - 1 ? today : shiftMonths(windowStart, n * 3), cents }))
    db.upsertAccount({ id, source: 'csv', name, institution, currency: 'USD', balanceCents: points[points.length - 1].cents, availableCents: null, balanceDate: now })
    db.updateAccount(id, { assetType })
    for (const p of points.slice(0, -1)) db.setBalancePoint(id, p.day, p.cents)
  }
  quarterly(ACCOUNTS.retirement, 'Northwind 401(k)', 'Summit Retirement Services', 'retirement', [4820000, 5160000, 5540000, 5880000, 6190000, 6240000])
  quarterly(ACCOUNTS.hsa, 'Health Savings Account', 'Summit Retirement Services', 'investment', [310000, 345000, 372000, 410000, 441000, 465000])

  // Transactions, categorized as the AI and the rules would have left them.
  const oneTime: string[] = []
  db.inTransaction(() => {
    const counts = new Map<string, number>()
    for (const t of txns) {
      const n = (counts.get(t.account) ?? 0) + 1
      counts.set(t.account, n)
      const id = `${t.account}:${String(n).padStart(4, '0')}`
      db.insertTransactionIfNew({ id, accountId: t.account, posted: posted(t.day), amountCents: t.cents, description: t.desc, pending: false })
      const cat = t.category ? (categoryId.get(t.category.toLowerCase()) ?? null) : null
      db.setTransactionFields(id, { categoryId: cat, source: cat === null ? null : t.source, confidence: cat === null ? null : t.confidence, merchant: t.merchant })
      if (t.oneTime) oneTime.push(id)
      if (t.split) db.splitTransaction(id, t.split.map((p) => ({ amountCents: p.cents, categoryId: categoryId.get(p.category.toLowerCase()) ?? null, oneTime: p.oneTime, note: p.note ?? null })))
      if (t.tags) db.addTags([id], t.tags)
    }
  })
  if (oneTime.length) db.setOneTime(oneTime, true)

  // Month-end statement balances, from the same stream, so the history needs no bending.
  for (const a of bank) {
    let running = start[a.id]
    const mine = txns.filter((t) => t.account === a.id)
    for (let n = 0; n < MONTHS - 1; n++) {
      const [y, m] = shiftMonths(windowStart, n).split('-').map(Number)
      const last = key(y, m, daysIn(y, m))
      running += mine.filter((t) => t.day.slice(0, 7) === last.slice(0, 7)).reduce((s, t) => s + t.cents, 0)
      if (last < today) db.setBalancePoint(a.id, last, running)
    }
  }

  // The house and the car, each with its loan.
  const houseDay = shiftMonths(today, -30)
  manual(ACCOUNTS.house, { name: 'Home · 14 Alder Lane', assetType: 'property', openedDay: houseDay, costCents: 38500000, details: '14 Alder Lane · 3 bed, 2 bath' }, series(houseDay, today, 6, (n) => 38500000 * 1.012 ** (n / 6)))
  manual(ACCOUNTS.mortgage, { name: 'Pinecrest Mortgage', assetType: 'mortgage', institution: 'Pinecrest Home Loans', openedDay: houseDay, linkedAssetId: ACCOUNTS.house }, series(houseDay, today, 6, (n) => -30800000 + 43000 * n))
  db.updateAccount(ACCOUNTS.mortgage, { apr: 6.125, minPaymentCents: 198500 })
  const carDay = shiftMonths(today, -20)
  manual(ACCOUNTS.car, { name: '2022 Subaru Outback', assetType: 'vehicle', openedDay: carDay, costCents: 3450000, details: '48,000 miles' }, series(carDay, today, 3, (n) => 3450000 * 0.989 ** n))
  // 545.00 a month at 5.9% pays down about 410.00; the rest is interest.
  manual(ACCOUNTS.carLoan, { name: 'Lakeside Auto Loan', assetType: 'loan', institution: 'Lakeside Credit Union', openedDay: carDay, linkedAssetId: ACCOUNTS.car }, series(carDay, today, 3, (n) => -2950000 + 41000 * n))
  db.updateAccount(ACCOUNTS.carLoan, { apr: 5.9, minPaymentCents: 54500 })
  // The rental condo, bought with 20% down; its mortgage payment includes the escrow.
  const condoDay = shiftMonths(today, -26)
  manual(ACCOUNTS.condo, { name: 'Condo · 220 Bayview Ct #4B', assetType: 'property', openedDay: condoDay, costCents: 21400000, details: '220 Bayview Ct #4B · 2 bed, 1 bath' }, series(condoDay, today, 6, (n) => 21400000 * 1.015 ** (n / 6)))
  manual(ACCOUNTS.condoMortgage, { name: 'Bayview Condo Mortgage', assetType: 'mortgage', institution: 'Harbor Bank', openedDay: condoDay, linkedAssetId: ACCOUNTS.condo }, series(condoDay, today, 6, (n) => -17120000 + 16000 * n))
  db.updateAccount(ACCOUNTS.condoMortgage, { apr: 6.5, minPaymentCents: RENTAL.mortgage })

  // The paycheck's plans and its latest paystub, a few confirmed recurring items, reminders and facts.
  const rows: DemoRows = { contributions: [], paystubs: [], withholding: [], overrides: [], events: [], facts: [], buckets: [], goals: [] }
  rows.contributions.push(db.saveContribution({ name: 'Northwind 401(k)', kind: '401k', accountId: ACCOUNTS.retirement, paycheckKey: PAYCHECK_KEY, percent: 6, employeeCents: 27700, matchCents: 13850, matchNote: '50% of the first 6%', startsDay: windowStart }))
  rows.contributions.push(db.saveContribution({ name: 'HSA', kind: 'hsa', accountId: ACCOUNTS.hsa, paycheckKey: PAYCHECK_KEY, employeeCents: 7500, matchCents: 5000, matchNote: 'Employer seed, per check', startsDay: windowStart }))
  // The stub as migration 39 copies a household's per-check withholding: its taxes and premiums, and the plans in
  // force that day with the employer's part. Its net is gross less every line, 2,947.38, against 2,947.00 deposited.
  rows.paystubs.push(
    savePaystub({
      paycheckKey: PAYCHECK_KEY,
      payDay: lastPayday,
      grossCents: 461538,
      items: [
        { kind: 'federal', cents: 61200 },
        { kind: 'social_security', cents: 28600 },
        { kind: 'medicare', cents: 6700 },
        { kind: 'state', cents: 18500 },
        { kind: 'medical', name: 'Medical insurance', cents: 14200, pretax: true },
        { kind: 'dental', name: 'Dental insurance', cents: 1800, pretax: true },
        { kind: 'vision', name: 'Vision insurance', cents: 600, pretax: true },
        { kind: '401k', name: 'Northwind 401(k)', cents: 27700, employerCents: 13850 },
        { kind: 'hsa', name: 'HSA', cents: 7500, employerCents: 5000 }
      ],
      source: 'snapshot'
    })
  )
  for (const k of [PAYCHECK_KEY, 'pinecrest mortgage|-', 'lakeside auto loan|-', 'bayview rent|+', 'bayview condo mortgage|-', 'bayview condo association|-']) {
    db.setRecurringOverride(k, { status: 'confirmed' })
    rows.overrides.push(k)
  }

  // The rental as a venture: its account, the condo and its mortgage. The account's transactions go with it (its auto rule).
  const bucketId = db.saveBucket({ name: freeBucketName(RENTAL.name), kind: 'rental' })
  rows.buckets.push(bucketId)
  for (const id of [ACCOUNTS.rentalChecking, ACCOUNTS.condo, ACCOUNTS.condoMortgage]) db.updateAccount(id, { bucketId })
  // The mortgage and the car loan are paid by their series, as migration 38 links them for a household of its own.
  linkLoanPayments()

  // Insurance outside work: the car and the house, paid monthly from checking (the Crestline and Harborline charges).
  for (const p of policies(carDay, houseDay)) restorePolicy(p)
  rows.events.push(db.addCalendarEvent({ day: shiftDays(today, 20), title: 'Renew car registration', amountCents: 8150, createdBy: 'user' }))
  rows.events.push(db.addCalendarEvent({ day: shiftDays(today, 41), title: 'Property tax due', amountCents: 420000, createdBy: 'user' }))
  rows.facts.push(db.addFact('Paid every other Friday by Northwind Logistics; 6% goes to the 401(k) with a 50% match'))
  rows.facts.push(db.addFact('The Cashback Mastercard is at 0% until its promo ends; it should be paid off before then'))
  rows.facts.push(db.addFact('Rents out a condo at 220 Bayview Ct #4B; its rent, dues, mortgage and repairs go through Rental Checking'))
  // Two savings goals: an emergency fund that is the savings account, and a trip put aside by hand on the 15th.
  rows.goals.push(saveGoal({ name: 'Emergency fund', targetCents: 2500000, targetDay: null, funding: 'accounts', accountIds: [ACCOUNTS.savings] }))
  const trip = saveGoal({ name: 'Vacation', targetCents: 400000, targetDay: shiftMonths(`${today.slice(0, 7)}-01`, 8), funding: 'manual' })
  rows.goals.push(trip)
  for (let n = 4; n >= 1; n--) addContribution(trip, { day: shiftMonths(`${today.slice(0, 7)}-15`, -n), cents: 30000 })

  db.setSetting(ROWS, JSON.stringify(rows))
  db.setSetting(LOADED_AT, new Date().toISOString())
  db.setSetting('insight.cache', null)
  return { accounts: bank.length + 8, transactions: txns.length }
}

/** The venture's name, or one with a number after it when the user already has a venture by that name. */
function freeBucketName(name: string): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`
    if (!db.bucketByName(candidate)) return candidate
  }
}

/** The two policies, each matching its monthly charge in checking; renewals roll forward from the purchase dates. */
function policies(carDay: string, houseDay: string): InsurancePolicy[] {
  const base: Pick<InsurancePolicy, 'status' | 'endDay' | 'notes' | 'source' | 'website'> = { status: 'active', endDay: null, notes: null, source: null, website: null }
  return [
    {
      ...base,
      id: `${DEMO_PREFIX}policy-auto`,
      name: 'Crestline Auto',
      kind: 'auto',
      carrier: 'Crestline Insurance',
      policyNumber: 'CA-4821',
      covers: '2022 Subaru Outback',
      startDay: carDay,
      renewalDay: shiftMonths(carDay, 6),
      termMonths: 6,
      premiumCents: 14800,
      premiumPeriod: 'month',
      match: 'crestline ins prem',
      deductibleCents: 50000,
      coverage: [
        { what: 'Liability', limit: '$100,000 / $300,000 / $100,000' },
        { what: 'Collision', limit: 'Actual cash value · $500 deductible' },
        { what: 'Comprehensive', limit: 'Actual cash value · $250 deductible' },
        { what: 'Uninsured motorist', limit: '$100,000 / $300,000' },
        { what: 'Rental car', limit: '$40 a day, 30 days' }
      ],
      phone: '800-555-0142',
      claimsPhone: '800-555-0199',
      files: []
    },
    {
      ...base,
      id: `${DEMO_PREFIX}policy-home`,
      name: 'Harborline Homeowners',
      kind: 'home',
      carrier: 'Harborline Mutual',
      policyNumber: 'HO-7712',
      covers: '14 Alder Lane',
      startDay: houseDay,
      renewalDay: shiftMonths(houseDay, 12),
      termMonths: 12,
      premiumCents: 14200,
      premiumPeriod: 'month',
      match: 'harborline mutual',
      deductibleCents: 100000,
      coverage: [
        { what: 'Dwelling', limit: '$395,000' },
        { what: 'Other structures', limit: '$39,500' },
        { what: 'Personal property', limit: '$197,500' },
        { what: 'Loss of use', limit: '$79,000' },
        { what: 'Personal liability', limit: '$300,000' },
        { what: 'Medical payments', limit: '$5,000' }
      ],
      phone: '800-555-0163',
      claimsPhone: '800-555-0177',
      files: []
    }
  ]
}

function readRows(): DemoRows {
  try {
    const r = JSON.parse(db.getSetting(ROWS) ?? '{}') as Partial<DemoRows>
    return { contributions: r.contributions ?? [], paystubs: r.paystubs ?? [], withholding: r.withholding ?? [], overrides: r.overrides ?? [], events: r.events ?? [], facts: r.facts ?? [], buckets: r.buckets ?? [], goals: r.goals ?? [] }
  } catch {
    return { contributions: [], paystubs: [], withholding: [], overrides: [], events: [], facts: [], buckets: [], goals: [] }
  }
}

/** Removes every demo row and nothing else. Returns how many accounts went. */
export function clearDemoData(): number {
  const rows = readRows()
  for (const id of rows.contributions) db.deleteContribution(id)
  for (const id of rows.paystubs) db.deletePaystub(id)
  // A sample loaded before paystubs: its withholding, and the paystub migration 39 made of it.
  for (const k of rows.withholding) {
    db.deleteWithholding(k)
    for (const s of db.listPaystubs(k)) db.deletePaystub(s.id)
  }
  for (const k of rows.overrides) db.all('DELETE FROM recurring_overrides WHERE key = ?', k)
  for (const id of rows.events) db.deleteCalendarEvent(id)
  for (const id of rows.facts) db.deleteFact(id)
  for (const id of rows.goals) if (getGoal(id)) deleteGoal(id)
  // The venture goes with its rules; the accounts it held go below.
  for (const id of rows.buckets) if (db.get('SELECT 1 FROM buckets WHERE id = ?', id)) db.deleteBucket(id)
  for (const p of listPolicies()) if (isDemo(p.id)) deletePolicy(p.id)
  const ids = db.all<{ id: string }>('SELECT id FROM accounts WHERE id LIKE ?', `${DEMO_PREFIX}%`)
  // The months closed while the sample was in are its; they close again from what's left.
  forgetClosesOf(ids.map((r) => r.id))
  for (const { id } of ids) db.deleteAccount(id)
  db.setSetting(ROWS, null)
  db.setSetting(LOADED_AT, null)
  db.setSetting('insight.cache', null)
  return ids.length
}
