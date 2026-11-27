// Types shared by the main process, preload bridge, and renderer.
// Money is always integer cents; negative = money leaving the account.
// Timestamps are Unix seconds.

import type { KeyCheck } from './checks'
import type { Strategy } from './debtPlan'

export type CategoryKind = 'expense' | 'income' | 'transfer'
/** Who set a category: Claude's categorizer, a rule, the user, or the review assistant (kept like the user's: never replaced automatically). */
export type CategorySource = 'ai' | 'rule' | 'user' | 'assistant'
export type Confidence = 'high' | 'medium' | 'low'
export type RuleField = 'merchant' | 'key' | 'contains'

export interface Category {
  id: number
  name: string
  kind: CategoryKind
  description: string
}

export type AssetType = 'cash' | 'investment' | 'retirement' | 'property' | 'vehicle' | 'other_asset' | 'venture' | 'receivable' | 'credit_card' | 'loan' | 'mortgage' | 'other_debt'

export const ASSET_TYPES: Array<{ id: AssetType; label: string; debt: boolean }> = [
  { id: 'cash', label: 'Cash', debt: false },
  { id: 'investment', label: 'Investments', debt: false },
  { id: 'retirement', label: 'Retirement', debt: false },
  { id: 'property', label: 'Real estate', debt: false },
  { id: 'vehicle', label: 'Vehicles', debt: false },
  { id: 'other_asset', label: 'Other assets', debt: false },
  { id: 'venture', label: 'Stakes', debt: false },
  { id: 'receivable', label: 'Owed to you', debt: false },
  { id: 'credit_card', label: 'Credit cards', debt: true },
  { id: 'loan', label: 'Loans', debt: true },
  { id: 'mortgage', label: 'Mortgages', debt: true },
  { id: 'other_debt', label: 'Other debts', debt: true }
]

export const isDebtType = (t: AssetType): boolean => ASSET_TYPES.find((x) => x.id === t)?.debt ?? false

export interface Account {
  id: string
  /** manual: an asset or debt with no bank feed (a house, a car, a loan), valued from its balance history */
  source: 'plaid' | 'simplefin' | 'csv' | 'manual'
  name: string
  institution: string | null
  currency: string
  balanceCents: number | null
  availableCents: number | null
  balanceDate: number | null
  hidden: boolean
  txnCount: number
  /** set by the user, or guessed from the name and balance */
  assetType: AssetType
  assetTypeSet: boolean
  /** YYYY-MM-DD; the balance counts as zero before it opened and after it closed */
  openedDay: string | null
  closedDay: string | null
  /** earliest day with a real balance or transaction; before it, history is the earliest known balance held flat */
  historyFrom: string | null
  /** what the asset cost (purchase price plus improvements), for gain/loss */
  costCents: number | null
  /** for a sold asset: what its closing took besides the loan payoff (commission, title, concessions, prorations), for gain/loss */
  saleCostsCents: number | null
  /** for a debt: the asset it's secured by (a mortgage's house, a car loan's car) */
  linkedAssetId: string | null
  /** free text: address, VIN, serial numbers */
  details: string | null
  /** the bucket this account or asset belongs to (null = Personal) */
  bucketId: number | null
  /** for a debt: its rate (percent a year), an intro rate until a date, and the minimum payment */
  apr: number | null
  promoApr: number | null
  promoEnds: string | null
  minPaymentCents: number | null
  /** for a cash account: what it's for, set by Review or the bank's subtype, else guessed from its name; null for other types */
  cashRole: CashRole | null
  /** for a loan or mortgage: the escrow (taxes and insurance) in each payment, which splits its interest from its escrow */
  escrowCents: number | null
  /** for a loan or mortgage: the payee key ('pinecrest mortgage|-') of the payments that pay it, wherever they're filed */
  paymentKey: string | null
}

/** What a cash account is for: spending (checking) or saving (savings, money market, CDs, a reserve). */
export type CashRole = 'spending' | 'saving'

export interface AssetSummary {
  account: Account
  /** current value, or the sale value if sold */
  valueCents: number
  /** linked debts, as positive amounts owed (at the sale date if sold) */
  debts: Array<{ id: string; name: string; owedCents: number }>
  owedCents: number
  equityCents: number
  gainCents: number | null
  sold: boolean
  /** the newest value Claude looked up on the web */
  valuation: Valuation | null
}

/**
 * One owner's use of an asset over dated days: its share of the asset's costs then (rooms rented in a house the user
 * lives in, a car driven partly for a business). bucketId null is Personal. On a day a period covers, the shares
 * add up to 10000; a day no period covers is the asset owner's alone. The owner keeps its value, gain and principal.
 */
export interface AssetUse {
  id: number
  assetId: string
  fromDay: string
  /** null: still in use */
  toDay: string | null
  bucketId: number | null
  shareBp: number
  /** what the share was measured by */
  basis: 'rooms' | 'area' | 'miles' | 'time' | 'other' | null
  source: 'user' | 'review' | 'migrated'
}

/** What one row of an asset's carrying cost is. */
export type CarryingKind = 'interest' | 'escrow' | 'hoa' | 'utilities' | 'insurance' | 'gas' | 'repairs' | 'principal'

/**
 * What an asset costs to keep, a month: its loans' interest, escrow and principal from their latest payments, and
 * its other costs (dues, utilities, insurance, gas, repairs) as their average over the 12 full months before this.
 * Each row is also split by who bears it: the asset's uses share its costs, and its owner pays the principal.
 */
export interface CarryingCost {
  assetId: string
  /** the asset's owner, whose its loans' principal is: a venture's id, or null for Personal */
  owner: number | null
  /** the asset's uses share some of these costs with another owner; each row's cents are then every owner's together */
  shared: boolean
  /** who bears the rows, Personal first and then ventures by id: every owner with a part of one, or the asset's owner when there are none */
  owners: Array<number | null>
  /** the 12 months the averages are over (YYYY-MM-DD, inclusive) */
  fromDay: string
  toDay: string
  /**
   * in this order: interest, escrow, hoa, utilities, insurance, gas, repairs, principal; each positive, none of 0.
   * byOwner has one entry per owner, in owners' order (0 for an owner with none of the row), adding up to cents.
   */
  rows: Array<{ kind: CarryingKind; cents: number; withEscrow: boolean; byOwner: Array<{ owner: number | null; cents: number }> }>
  /** a month's cost, the rows less principal */
  costCents: number
}

/**
 * A transaction, or one part of a split one, that is an asset's cost (the asset a rule, a hand or a loan put it on,
 * or Personal's one house or car), with Personal's share of that cost: its use share of it, 10000 when no use
 * shares the line or Personal uses all of the asset then, 0 when the cost is all another owner's.
 */
export interface LineAsset {
  txnId: string
  splitId: number | null
  assetId: string
  personalBp: number
}

export interface Valuation {
  day: string
  valueCents: number
  lowCents: number | null
  highCents: number | null
  /** what the estimate is based on, in a few sentences */
  basis: string
  sources: string[]
}

export interface CalendarEvent {
  id: number
  day: string
  title: string
  notes: string | null
  amountCents: number | null
  createdBy: 'user' | 'assistant'
  /** local start and end ('HH:MM', 24-hour); null for an all-day reminder */
  startTime: string | null
  endTime: string | null
  /** a to-do to check off (all day); it syncs to Google Tasks */
  task: boolean
  doneAt: number | null
}

/** One day on the calendar: a reminder, or a projected bill, paycheck or transfer. */
export interface CalendarItem {
  /** stable across refreshes; also keys the Google Calendar event */
  key: string
  day: string
  title: string
  amountCents: number | null
  kind: 'reminder' | 'bill' | 'income' | 'transfer'
  notes: string | null
  /** set for reminders, which can be edited */
  eventId: number | null
  /** local start and end ('HH:MM') of a timed reminder; null all day */
  start: string | null
  end: string | null
  /** a reminder that's a to-do, and whether it's checked off */
  task: boolean
  done: boolean
}

export interface GoogleCalendarStatus {
  /** client ID and secret saved */
  configured: boolean
  connected: boolean
  calendarName: string | null
  lastSyncAt: number | null
  lastError: string | null
  /** the sign-in covers Google Tasks, where to-dos go */
  tasks: boolean
  /** to-dos are synced to Google Tasks (a setting; turning it on asks Google for the Tasks scope) */
  tasksOn: boolean
}

export interface AssetHistory {
  points: Array<{ day: string; valueCents: number; owedCents: number }>
}

export interface BalancePoint {
  day: string
  cents: number
  /** sync: reported by the bank or set as the current balance; manual: entered by hand; estimate: looked up by Claude; statement: a QFX/OFX/QIF file's closing balance */
  source: 'sync' | 'manual' | 'estimate' | 'statement'
}

export interface AccountPatch {
  bucketId?: number | null
  name?: string
  hidden?: boolean
  balanceCents?: number
  assetType?: AssetType | null
  openedDay?: string | null
  closedDay?: string | null
  costCents?: number | null
  saleCostsCents?: number | null
  linkedAssetId?: string | null
  details?: string | null
  apr?: number | null
  promoApr?: number | null
  promoEnds?: string | null
  minPaymentCents?: number | null
  escrowCents?: number | null
}

export interface NewAsset {
  name: string
  assetType: AssetType
  institution?: string | null
  openedDay?: string | null
  closedDay?: string | null
  costCents?: number | null
  linkedAssetId?: string | null
  details?: string | null
  /** dated values, debts negative */
  points?: Array<{ day: string; cents: number }>
}

export interface Transaction {
  id: string
  accountId: string
  accountName: string
  posted: number
  amountCents: number
  description: string
  merchant: string | null
  categoryId: number | null
  categorySource: CategorySource | null
  confidence: Confidence | null
  pending: boolean
  notes: string | null
  /** null = Personal */
  bucketId: number | null
  /** a durable one-off (furniture, a laptop): left out of budgets and the debt plan */
  oneTime: boolean
  /** the parts it's split into, adding up to amountCents; empty when it isn't split */
  splits: TxnSplit[]
  /** labels, as first typed */
  tags: string[]
}

export interface TxnQuery {
  search?: string
  accountId?: string
  /** a category id, or 'none' for uncategorized */
  categoryId?: number | 'none'
  /** a bucket id, or 'personal' */
  bucketId?: number | 'personal'
  from?: number
  to?: number
  limit?: number
  offset?: number
  /** transactions carrying this tag (any case) */
  tag?: string
  /** only these transactions: the lines a row of Home is made of */
  ids?: string[]
}

export interface TxnPage {
  rows: Transaction[]
  total: number
  sumCents: number
}

export interface TxnUpdate {
  categoryId?: number | null
  /** null = Personal */
  bucketId?: number | null
  merchant?: string | null
  notes?: string | null
  /** when changing category, also create a rule and apply it to similar transactions */
  remember?: boolean
}

export interface TxnUpdateResult {
  alsoUpdated: number
  ruleCreated: boolean
}

export interface Rule {
  id: number
  field: RuleField
  pattern: string
  categoryId: number
  categoryName: string
  createdAt: number
}

export interface CategorySpend {
  categoryId: number | null
  /** the category's name; Personal's interest on a loan paid by a transfer is under the loan's name, in its line's category */
  name: string
  cents: number
  count: number
}

export interface MonthPoint {
  month: string // YYYY-MM
  incomeCents: number
  spendCents: number
}

export interface MerchantSpend {
  merchant: string
  cents: number
  count: number
}

/**
 * A part of your finances kept apart from everyday personal money: a rental,
 * a business, someone you support. Transactions are Personal unless placed in
 * a bucket; personal views leave buckets out unless you switch them on.
 */
export type BucketKind = 'rental' | 'business' | 'person' | 'other'

export interface Bucket {
  id: number
  name: string
  kind: BucketKind
  description: string
  /**
   * shareBp > 0, read only, for one release (waterfall sub-phase 1j): net worth counts the venture's position by its
   * share, not its accounts by this flag. saveBucket, create_bucket and update_bucket still take it as an alias: true
   * sets the share to 100% from 0000-01-01, false to 0%.
   */
  inNetWorth: boolean
  /** the user's ownership share today, in basis points (10000 is all of it): venture_shares' step function */
  shareBp: number
  /** what the stake is valued by: the venture's books (shareBp of its net assets) or a Stakes account's estimate */
  valueSource: 'books' | 'estimate'
  /** the Personal Stakes account (type venture) that holds the estimate of the user's stake, when one is linked */
  stakeAccountId: string | null
  /** the venture's position today: the user's claims on it (lent less borrowed plus due) and the stake */
  positionCents: number
  /**
   * when this place was the user's home (YYYY-MM-DD; to null = still is), as kept before migration 41 made the dates
   * Personal's use of its house (asset_uses). Only a venture with no house still counts its costs in them as
   * Personal's; the dates stay one release and can't be set.
   */
  residenceFrom: string | null
  residenceTo: string | null
  txnCount: number
  inCents: number
  outCents: number
  firstPosted: number | null
  lastPosted: number | null
  /** the bucket's span: its first activity or purchase, to its last activity or sale (today while anything in it is still owned) */
  fromDay: string | null
  toDay: string | null
  /** its result (VentureResult): operating, its assets' gains realized and on paper together, and the total of the two */
  operatingCents: number
  gainsCents: number
  totalCents: number
}

/**
 * Puts matching transactions in a bucket (bucketId) or on an asset (assetId), never both: on one account, in one
 * category and/or containing text, optionally within dates.
 */
export interface BucketRule {
  id: number
  bucketId: number | null
  /** an asset rule's house, vehicle or other asset: the lines' costs are shared by its uses */
  assetId: string | null
  assetName: string | null
  accountId: string | null
  accountName: string | null
  categoryId: number | null
  categoryName: string | null
  contains: string | null
  /** an exact amount (either direction), for one installment among several */
  amountCents: number | null
  fromDay: string | null
  toDay: string | null
  /** made when the account was put in the venture (its lines default to the venture), and taken away when it leaves */
  auto: boolean
}

export interface BucketDetail {
  bucket: Bucket
  byYear: Array<{ year: string; inCents: number; outCents: number }>
  byCategory: Array<{ name: string; inCents: number; outCents: number; count: number }>
  topPayees: Array<{ name: string; inCents: number; outCents: number; count: number }>
  accounts: Account[]
  rules: BucketRule[]
  result: VentureResult
}

/** An asset in a venture against what it cost: sold (its gain realized) or still owned (its gain on paper). */
export interface VentureAsset {
  id: string
  name: string
  assetType: AssetType
  boughtDay: string | null
  /** null while it's owned */
  soldDay: string | null
  /** what buying it took: the cash paid and the loan */
  costCents: number | null
  /** current value, or the sale value if sold; money owed to you: what's still owed (0 once it's closed) */
  valueCents: number
  saleCostsCents: number | null
  /** money owed to you: what's been paid back of it, from the venture's money in; null for anything else */
  repaidCents: number | null
  /** sold: value less selling costs less cost; owned: value less cost; money owed to you: still owed and paid back less lent; an investment account's from its returns (gainFrom); null without a cost */
  gainCents: number | null
  /** cost: measured against its cost; returns: an investment account's change in value less the money put in, over its span */
  gainFrom: 'cost' | 'returns'
  sold: boolean
  /** linked debts, as a positive amount owed (at the sale date if sold) */
  owedCents: number
  equityCents: number
}

/**
 * A venture's whole picture, in parts that don't overlap: operating (rent or revenue less
 * running costs, repairs, improvements and loan interest) and each asset's gain or loss,
 * realized once it's sold and on paper while it's owned. Operating is the bucket's money in
 * and out without the money that bought and sold its assets, and with the loan principal
 * left out of the payments (it's inside the gains, since an asset's cost includes its loan).
 */
export interface VentureResult {
  inCents: number
  outCents: number
  operatingCents: number
  /** left out of operating: spent on or in the 90 days before an asset's purchase (up to its price, other than for a house) */
  purchaseCents: number
  /** left out of operating: received on a sale day or in the week after (up to what the sale brought, other than for a house) */
  proceedsCents: number
  /** left out of operating: money lent (up to the amount lent) */
  lentCents: number
  /** left out of operating: money lent that's been paid back (the amount lent less what's still owed) */
  repaidCents: number
  /** left out of operating: what the assets' loans went down while the venture's records cover them, up to its spending then (equity paid down, inside the gains) */
  principalCents: number
  /**
   * Personal's use of the venture's places, oldest first: for each use that shares a house, vehicle or other asset the
   * venture owns or uses with Personal (asset_uses), its days (to: the use's end, else the sale or today), Personal's
   * share and Personal's part of the costs it shared then (principal never), which operating leaves out; and for a
   * venture whose residence dates aren't a use yet (no asset: it has no house), those dates' costs. Operating plus
   * these cents is the operating the venture would have if it bore those costs whole.
   */
  personalUse: Array<{ assetId: string | null; fromDay: string; toDay: string; personalBp: number; cents: number }>
  assets: VentureAsset[]
  /** gains and losses of the assets sold */
  realizedCents: number
  /** gains and losses of the assets still owned */
  onPaperCents: number
  /** the assets with no cost, whose gain is unknown and left out of the totals */
  missingCost: string[]
  /** operating plus every known gain or loss, realized and on paper */
  totalCents: number
  /** the money between Personal and the venture: the share, the claims, the basis, the stake and the position */
  owner: OwnerMoney
}

/** What a movement of money between Personal and a venture is (waterfall spec addendum 1.11). */
export type VentureIntent = 'loan' | 'loan_repayment' | 'equity' | 'capital_return' | 'gift' | 'draw' | 'reimbursement' | 'venture_loan' | 'venture_loan_repayment' | 'salary' | 'trade' | 'other'

export const VENTURE_INTENTS: readonly VentureIntent[] = ['loan', 'loan_repayment', 'equity', 'capital_return', 'gift', 'draw', 'reimbursement', 'venture_loan', 'venture_loan_repayment', 'salary', 'trade', 'other']

/**
 * The way each intent's money moves, from Personal's side: out is money Personal sends the venture (a loan, equity,
 * repaying the venture's loan), in is money back (a repayment, a draw, salary); a gift, a reimbursement, trade and
 * other go either way.
 */
export const INTENT_DIRECTIONS: Record<VentureIntent, ReadonlyArray<'out' | 'in'>> = {
  loan: ['out'],
  loan_repayment: ['in'],
  equity: ['out'],
  capital_return: ['in'],
  gift: ['out', 'in'],
  draw: ['in'],
  reimbursement: ['out', 'in'],
  venture_loan: ['in'],
  venture_loan_repayment: ['out'],
  salary: ['in'],
  trade: ['out', 'in'],
  other: ['out', 'in']
}

/**
 * One stored intent part of a boundary line (venture_money): what Review or the user said a line, or for a line a
 * venture's cash or card paid for Personal (face fund) its funding, was. cents is signed as the line, or as the
 * funding (minus the line); interestCents is a repayment's interest, the rest its principal; regular is a draw's.
 */
export interface VentureMoneyPart {
  txnId: string
  splitId: number | null
  face: 'line' | 'fund'
  ventureId: number
  intent: VentureIntent
  cents: number
  interestCents: number
  regular: boolean | null
  source: 'review' | 'user'
}

/** One dated row of a venture's share: the user's share in basis points from fromDay on, until a later row. */
export interface VentureShare {
  fromDay: string
  shareBp: number
  source: 'review' | 'user' | 'migrated'
}

/**
 * The money between Personal and a venture, as the venture's books show it. In and out are from Personal's side:
 * out is money Personal sent the venture. lent, borrowed and due are the claims (positive when the venture owes
 * the user, borrowed what the user owes it); basis is equity put in less capital returned, never below 0, and
 * aboveBasis what returns took beyond it; netAssets is A, the balance of what the venture holds; stake is the
 * share of its net assets (A less the claims) by the books, or the linked Stakes account's estimate; position is
 * lent - borrowed + due + stake.
 */
export interface OwnerMoney {
  shareBp: number
  shares: VentureShare[]
  valueSource: 'books' | 'estimate'
  stakeAccountId: string | null
  basisCents: number
  aboveBasisCents: number
  lentCents: number
  borrowedCents: number
  dueCents: number
  netAssetsCents: number
  stakeCents: number
  positionCents: number
  byIntent: Array<{ intent: VentureIntent | 'unset'; inCents: number; outCents: number; interestCents: number }>
  lines: Array<{
    txnId: string
    splitId: number | null
    face: 'line' | 'fund'
    day: string
    accountId: string
    cents: number
    parts: Array<{ intent: VentureIntent | null; cents: number; interestCents: number; source: 'review' | 'user' | 'rule' | 'inferred' | null }>
  }>
}

/** Which money a personal view includes: 0 = Personal, other numbers are bucket ids. */
export type BucketSelection = number[]

/** How an investment account is taxed; private is a stake in a business, valued by estimate. */
export type TaxTreatment = 'pretax' | 'roth' | 'hsa' | 'taxable' | 'private'

export const TAX_TREATMENTS: Array<{ id: TaxTreatment; label: string }> = [
  { id: 'pretax', label: 'Pre-tax' },
  { id: 'roth', label: 'Roth' },
  { id: 'hsa', label: 'HSA' },
  { id: 'taxable', label: 'Taxable' },
  { id: 'private', label: 'Private' }
]

/** One position in an investment account, as of the last bank sync. */
export interface Holding {
  symbol: string | null
  description: string
  shares: number | null
  priceCents: number | null
  valueCents: number
  /** what was paid for the position: reported by the brokerage, or estimated */
  costCents: number | null
  costEstimated: boolean
  /** not reported by the brokerage: an ESPP balance taken as the company's stock, or cash beyond the reported positions */
  inferred: boolean
  asOf: number
  /** the money-weighted return since the first purchase, when the purchases are dated (yearly once held over a year) */
  sinceBuy?: { day: string; r: number; annualized: boolean } | null
}

export type ReturnPeriodId = '1M' | '3M' | 'YTD' | '1Y' | 'All'

/** Returns over one period, from the values and the money put in or taken out. */
export interface PeriodReturn {
  period: ReturnPeriodId
  from: string
  to: string
  /** twr and mwr are yearly, compounded: the period is longer than a year */
  annualized: boolean
  /** time-weighted: the periods between flows chained together */
  twr: number | null
  /** money-weighted (XIRR) */
  mwr: number | null
  /** the value's change less the money put in */
  gainCents: number
  /** dividends and interest */
  incomeCents: number
  /** money put in less money taken out */
  flowCents: number
}

export interface Returns {
  /** only the periods the values and flows cover */
  periods: PeriodReturn[]
  /** yearly, from the time-weighted series; null until it's long enough */
  volatility: number | null
  maxDrawdown: number | null
}

export interface InvestmentAccount {
  account: Account
  treatment: TaxTreatment
  valueCents: number
  /** the change over the last 30 days, contributions included */
  change30Cents: number | null
  holdings: Holding[]
  /** the positions' cost added up, when every one has a cost */
  costCents: number | null
  costEstimated: boolean
  returns?: Returns | null
}

export interface Investments {
  accounts: InvestmentAccount[]
  /** weekly balances by tax treatment */
  points: Array<{ day: string; pretax: number; roth: number; hsa: number; taxable: number; private: number }>
  /** every account together, then each tax treatment */
  returns?: Array<{ id: 'all' | TaxTreatment; returns: Returns }>
}

/** Where an account sits on the balance sheet; ventures is each venture's position, one row a venture. */
export type SheetGroup = 'cash' | 'investments' | 'property' | 'owed' | 'ventures' | 'cards' | 'loans'

export const SHEET_GROUPS: Array<{ id: SheetGroup; label: string; debt: boolean }> = [
  { id: 'cash', label: 'Cash', debt: false },
  { id: 'investments', label: 'Investments', debt: false },
  { id: 'property', label: 'Property', debt: false },
  { id: 'owed', label: 'Owed to you', debt: false },
  { id: 'ventures', label: 'Ventures', debt: false },
  { id: 'cards', label: 'Cards', debt: true },
  { id: 'loans', label: 'Loans', debt: true }
]

/** The group a Personal account sits in by its type; a venture's accounts are in its position, in ventures. */
export const SHEET_GROUP_OF: Record<AssetType, Exclude<SheetGroup, 'ventures'>> = {
  cash: 'cash',
  investment: 'investments',
  retirement: 'investments',
  venture: 'investments',
  property: 'property',
  vehicle: 'property',
  other_asset: 'property',
  receivable: 'owed',
  credit_card: 'cards',
  loan: 'loans',
  mortgage: 'loans',
  other_debt: 'loans'
}

/** Everything counted in net worth today, by group; amounts are signed (debts negative). */
export interface BalanceSheet {
  netWorthCents: number
  ownCents: number
  oweCents: number
  /** over the last 30 days, from the same daily balances as the net worth chart */
  change30Cents: number
  groups: Array<{
    id: SheetGroup
    cents: number
    change30Cents: number
    /** open accounts with a balance or a change in the last 30 days, largest first */
    accounts: Array<{ account: Account; cents: number; change30Cents: number; linkedAsset: string | null }>
    /** open accounts at $0 all month, left out of the list (in ventures, ventures with no position all month) */
    zeroCount: number
    /** the ventures group alone: each venture with a position or a change in the last 30 days, largest first */
    ventures?: Array<{ bucketId: number; name: string; shareBp: number; cents: number; change30Cents: number }>
  }>
}

/** How necessary a category is: essentials are needs, lifestyle is discretionary, one-offs are purchases that can wait. */
export type BudgetTier = 'essential' | 'lifestyle' | 'oneoff'

export const BUDGET_TIERS: Array<{ id: BudgetTier; label: string }> = [
  { id: 'lifestyle', label: 'Lifestyle' },
  { id: 'essential', label: 'Essential' },
  { id: 'oneoff', label: 'One-off' }
]

/** One category's base spending: ranges are values at every 5th percentile (see shared/ranges). */
export interface BudgetRow {
  categoryId: number | null
  name: string
  tier: 'essential' | 'lifestyle'
  /** expected under the small threshold with nothing much spent this month */
  small: boolean
  /** an essential that changed: a bill's new price, or spending above its usual range */
  alert: string | null
  /** the user's target, if set */
  budgetCents: number | null
  /** the average month, rounded to $10: what an unset target counts as (averages add up across categories) */
  suggestedCents: number
  /** recurring bills in this category, per month */
  fixedCents: number
  month: number[]
  /** through today, for the current month */
  toDate: number[] | null
  confidence: 'high' | 'medium' | 'low'
  /** purchases behind the range (six months) */
  purchases: number
  spentCents: number
  historyCents: number[]
  /** each month's leftover, or overspend, carries into the next (from the month it was turned on) */
  rolloverOn: boolean
  /** what carried into the month: the month before's available less what was spent in it (negative: overspent); 0 with rollover off */
  carriedCents: number
  /** the month's target plus what carried into it (budgetCents with rollover off); null with no target */
  availableCents: number | null
}

/** Time away: what's bought from the first day through a few days past the last (cards post late) is a one-off, not base spending. */
export interface Trip {
  id: string
  name: string
  /** first and last day away, YYYY-MM-DD */
  from: string
  to: string
}

/** A habit as measured lately ("You buy coffee about once a day") and specific commitments to change it; committing sets that budget line's target. */
export interface Habit {
  id: string
  kind: 'eat_out' | 'big_meals' | 'delivery' | 'groceries' | 'coffee' | 'merchant' | 'subscription' | 'oneoff'
  title: string
  /** the budget line a commitment sets: a category, or one-offs (null) */
  categoryId: number | null
  category: string
  /** what it costs: "$9 each · $400 a month" */
  detail: string
  nowCents: number
  /** exclusive commitments, smallest change first */
  options: HabitOption[]
  /** the commitment made (now part of the target), and how the month is going against it */
  committed: { optionId: string; label: string; savingsCents: number; progress: HabitProgress | null } | null
}

/** A specific action with a limit that can be counted each month; extraCents is what it saves beyond the target already set. */
export interface HabitOption {
  id: string
  label: string
  savingsCents: number
  extraCents: number
  /** what keeping it allows a month: so many purchases, or (one-offs) so many cents */
  limit: { count: number } | { cents: number }
}

/** A commitment against the month shown (the current one so far), counted from when it was made, days away left out. */
export interface HabitProgress {
  text: string
  /** kept, ahead of the pace that keeps it, broken for the month, or unknown until a feed that runs behind catches up */
  state: 'good' | 'pace' | 'over' | 'waiting'
}

/** A month's base spending (essentials and lifestyle) as ranges against targets, one-off purchases with their own budget, and habits to cut. */
export interface BudgetView {
  /** the month shown, or for the last 30 days the current one (habits count by month) */
  month: string
  /** set for the last 30 days, both ends included: spending, alerts and one-offs cover these days */
  days: { from: string; to: string } | null
  /** the six full months the ranges come from */
  months: string[]
  rows: BudgetRow[]
  habits: Habit[]
  /** habits set aside as not for the user */
  hiddenHabits: number
  /** the grocer the groceries habit measures against */
  cheaperStore: string | null
  oneOffs: {
    /** categories counted as one-offs */
    categories: string[]
    /** the window's average month, this month so far, and the budget */
    averageCents: number
    spentCents: number
    targetCents: number | null
    historyCents: number[]
    /** this month's one-off purchases, largest first; trip names the trip it was bought on */
    items: Array<{ id: string; day: string; merchant: string; category: string; cents: number; trip: string | null }>
  }
  /** trips that touch the months shown or are still ahead, with what's been bought on each */
  trips: Array<Trip & { spentCents: number }>
  /** base spending (essentials and lifestyle): the whole month, and through today */
  total: number[]
  totalToDate: number[] | null
  smallCents: number
  /** set for the current month */
  dayOfMonth: number | null
  daysInMonth: number
  /** accounts whose bank feed is behind, so this month is missing their charges */
  behind: Array<{ account: string; lastDay: string }>
}

export interface DebtView {
  /** Personal's credit cards, loans, mortgages and other debts that owe today (a mortgage is a loan here); balanceCents is what is owed */
  debts: Array<{ id: string; name: string; kind: 'card' | 'loan'; balanceCents: number; apr: number | null; promoApr: number | null; promoEnds: string | null; minPaymentCents: number | null }>
  /** the Take-home run rate in force (spec 1.6): the last full month's */
  takeHomeCents: number
  /** Take-home's run rate by where it comes from: each payroll, other income by category, and estimated tax paid from the bank (negative); they add up to takeHomeCents */
  incomeSources: Array<{ name: string; monthlyCents: number }>
  /**
   * a month's Personal spending the plan can't put toward debt (spec 1.6): the Committed run rate without what debts
   * charge in interest (the plan pays each debt's minimum and works out its interest), a loan's escrow kept in as the
   * home's taxes and insurance, plus the Everyday and One-offs run rates; and the lowest and highest of the same
   * spending in each of the twelve full months before this one
   */
  spendCents: number
  spendLowCents: number
  spendHighCents: number
  /** the same spending in each of the twelve full months before this one, oldest first */
  spendMonths: Array<{ month: string; cents: number }>
  /** the payoff order the user chose; highest rate first until they pick another (plan.strategy) */
  strategy: Strategy
  /** the debt plan's inputs, as the debt.plan setting holds them (debts.ts debtPlan) */
  plan: DebtPlanInputs
  /** the month the plan is worked out in by the ledger's clock (YYYY-MM); the plan starts the month after */
  month: string
  /**
   * the same spending at the targets set: each Everyday category over its target at its target, and One-offs at the
   * one-off budget when over it, in place of their run rates (a target above its run rate changes nothing); null
   * when neither is set
   */
  targetSpendCents: number | null
}

/**
 * The debt plan's inputs (the debt.plan setting, waterfall spec 7; Review sets them with set_debt_plan): the order
 * extra money goes to the debts in, the debts left out by account id, a take-home a month to plan with in place of the
 * Take-home run rate (null plans with the run rate), money a month kept back from the debts, and a lump sum paid
 * toward them in the plan's first month, in cents.
 */
export interface DebtPlanInputs {
  strategy: Strategy
  leftOut: string[]
  takeHomeCents: number | null
  setAsideCents: number
  lumpCents: number
}

/** A health cost and the HSA: null means it's decided from the category and the HSA's start. */
export type HsaState = 'eligible' | 'not' | 'reimbursed'

export type BenefitKind = 'medical' | 'dental' | 'vision' | 'life' | 'disability' | 'other'

export const BENEFIT_KINDS: Array<{ id: BenefitKind; label: string }> = [
  { id: 'medical', label: 'Medical' },
  { id: 'dental', label: 'Dental' },
  { id: 'vision', label: 'Vision' },
  { id: 'life', label: 'Life' },
  { id: 'disability', label: 'Disability' },
  { id: 'other', label: 'Other' }
]

/** One employer benefit, from paystubs and the plan's own summary. */
export interface BenefitPlan {
  /** unique: "Medical", "Long-term disability" */
  name: string
  kind: BenefitKind
  carrier: string | null
  /** the network to pick in the carrier's doctor search */
  network: string | null
  /** who's covered: "You only" */
  coverage: string | null
  /** what the user pays per paycheck, and the employer */
  perCheckCents: number | null
  employerPerCheckCents: number | null
  /** taken out before or after tax */
  taxed: 'pre' | 'post' | null
  /** in network: what the user pays in full each year before the plan shares costs */
  deductibleCents: number | null
  /** in network: the most the user pays in a year */
  outOfPocketMaxCents: number | null
  /** in network: the user's share after the deductible, in percent */
  coinsurancePct: number | null
  /** the same out of network */
  oonDeductibleCents: number | null
  oonOutOfPocketMaxCents: number | null
  oonCoinsurancePct: number | null
  /** dental: the most the plan pays in a year */
  annualMaxCents: number | null
  /** deductible met so far this plan year, from the carrier */
  metCents: number | null
  metAsOf: string | null
  /** what the user pays, by situation, in plain words */
  costs: Array<{ what: string; inNetwork: string; outOfNetwork: string | null }>
  /** covered in full: how often in words, and in months to know when it's due */
  free: Array<{ what: string; often: string; everyMonths: number | null }>
  phone: string | null
  website: string | null
  /** a line or two: the coverage amount, a waiting period */
  notes: string | null
  /** where the details came from */
  source: string | null
}

export type CareKind = 'medical' | 'dental' | 'vision' | 'pharmacy'

export interface CareExpense {
  id: string
  day: string
  /** spent; a refund is negative */
  cents: number
  merchant: string
  account: string
  kind: CareKind
  /** as set by hand; null = automatic */
  hsa: HsaState | null
  /** owed: can still be paid back from the HSA */
  status: 'owed' | 'reimbursed' | 'not' | 'before'
  /** the receipt: a path in the documents folder ("Receipts/…"), and whether the file is still there */
  receipt: string | null
  receiptFound: boolean
}

export interface BenefitsView {
  employer: string | null
  year: number
  plans: BenefitPlan[]
  /** "<plan>|<free item>" → the day it was last done */
  done: Record<string, string>
  hsa: {
    accountId: string | null
    accountName: string | null
    balanceCents: number | null
    /** care on or after this day can be paid back from the HSA */
    startDay: string | null
    /** this year's contributions, by Dec 31 at the current election, and the limit */
    contributedCents: number | null
    projectedCents: number | null
    limitCents: number | null
    /** the limit is last year's carried forward (shown as "est.") */
    limitProvisional: boolean
    owedCents: number
    reimbursedCents: number
    /** costs that count for the HSA but have no receipt on file */
    needReceipts: number
    needReceiptsCents: number
    /** the paycheck it comes out of, what each check puts in now, an election change, and checks left this year */
    paycheck: string | null
    perCheckCents: number | null
    employerPerCheckCents: number | null
    nextCents: number | null
    nextFrom: string | null
    checksLeft: number
  }
  /** what went into an HSA each year, oldest first; this year's is the projection by Dec 31 */
  hsaYears: HsaYear[]
  /** spending on care this year, by kind */
  thisYear: Record<CareKind, number>
  /** the latest paid visit of each kind */
  lastVisit: Partial<Record<CareKind, { day: string; merchant: string }>>
  /** care since the HSA started (this year without one), newest first */
  care: CareExpense[]
}

// ---------- taxes ----------

/** A notable item on a return beyond wages (losses negative). */
export interface TaxLine {
  label: string
  cents: number
}

/** A document on file for a tax year: the return, a W-2, a 1099... */
export interface TaxForm {
  name: string
  /** absolute path */
  file: string
}

/** One year's federal income tax return as filed, or this year's estimate before it's filed. */
export interface TaxYear {
  year: number
  status: 'filed' | 'estimate'
  filingStatus: string | null
  preparer: string | null
  filedDay: string | null
  /** Form 1040 line 1 */
  wagesCents: number | null
  /** line 9 */
  incomeCents: number | null
  /** line 11 */
  agiCents: number | null
  deduction: 'standard' | 'itemized' | null
  deductionCents: number | null
  /** line 15 */
  taxableCents: number | null
  /** total tax, line 24 */
  taxCents: number | null
  /** federal income tax withheld, line 25d */
  withheldCents: number | null
  /** withholding, estimated payments and refundable credits, line 33 */
  paymentsCents: number | null
  /** the refund; negative is the amount owed */
  refundCents: number | null
  lines: TaxLine[]
  forms: TaxForm[]
  /** open questions about the return */
  issues: string[]
  /** an estimate's date */
  asOf: string | null
  source: string | null
}

/** What one current paycheck withholds per check. */
export interface TaxPaycheck {
  employer: string
  paycheckKey: string
  /** the paystub these come from */
  asOf: string
  grossCents: number | null
  federalCents: number
  socialSecurityCents: number
  medicareCents: number
  stateCents: number
  /** paychecks still to come this year */
  checksLeft: number
}

/** The return a Taxes-category payment belongs to: one posted January through October is the previous year's (its refund, its preparer). */
export const taxReturnYear = (day: string): number => {
  const [y, m] = day.split('-').map(Number)
  return m <= 10 ? y - 1 : y
}

/** Money in the Taxes category: refunds (positive), payments and preparation fees. */
export interface TaxMoney {
  id: string
  day: string
  cents: number
  description: string
  account: string
}

export interface TaxesView {
  year: number
  /** newest first */
  years: TaxYear[]
  /** what the estimated year's payments (withholding, estimated payments, refundable credits) have to reach to avoid an underpayment penalty, from the previous year's return */
  safeHarbor: { year: number; fromYear: number; pct: number; cents: number } | null
  paychecks: TaxPaycheck[]
  /** newest first */
  money: TaxMoney[]
  /** whether each form's file is there, by path */
  formFound: Record<string, boolean>
}

/** One year's HSA contributions: yours and the employer's together, against that year's limit. */
export interface HsaYear {
  year: number
  cents: number
  /** the employer's part, when known */
  employerCents: number | null
  limitCents: number | null
  /** the limit is last year's carried forward (shown as "est.") */
  limitProvisional: boolean
  /** this year: put in so far; the rest of `cents` is still to come */
  soFarCents: number | null
  source: string | null
}

export interface MonthSummary {
  /** set when the summary covers a range of months, from this one through `month` */
  fromMonth?: string
  /** set when the summary covers days (the last 30), from this one through toDay, both included */
  fromDay?: string
  toDay?: string
  /** the earliest month with any activity in the selection */
  firstMonth: string | null
  /**
   * money in by where it came from: each paycheck by employer, other income by category. Personal's add up to its
   * income, Take-home, so income tax paid from the bank is one more, under its category: negative, or a refund
   */
  incomeBySource: Array<{ name: string; cents: number; paycheck?: boolean; parts?: Array<{ name: string; cents: number }> }>
  /** paycheck deductions into savings plans this month, and the employer's match (Personal money only) */
  contributions?: Array<{ name: string; kind: ContributionKind; paycheckKey: string; employeeCents: number; matchCents: number }>
  /** taxes and insurance withheld from this month's Personal paychecks, by paycheck */
  withholding?: Array<WithholdingAmounts & { paycheckKey: string }>
  month: string
  /** Personal's is the waterfall's Take-home: pay as deposited and other income, less income tax paid from the bank */
  incomeCents: number
  /** Personal's is the waterfall's Committed, Everyday and One-offs (one-off income nets against One-offs) */
  spendCents: number
  prevSpendCents: number
  byCategory: CategorySpend[]
  trend: MonthPoint[]
  topMerchants: MerchantSpend[]
  /** Personal's uncategorized money in the span, in and out, signed: in neither income nor spending until it's categorized */
  unsortedCents?: number
  uncategorizedCount: number
  txnCount: number
  netWorthCents: number
}

export const MODEL_OPTIONS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most accurate' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest' }
] as const

export type ModelId = (typeof MODEL_OPTIONS)[number]['id']

/** What a model call is for; each route has its own model and effort in API-key mode. */
export const AI_ROUTES = ['categorize', 'headline', 'review', 'valuation', 'documents'] as const
export type AiRoute = (typeof AI_ROUTES)[number]

export const AI_ROUTE_LABELS: Record<AiRoute, string> = {
  categorize: 'Categorize',
  headline: 'Headline',
  review: 'Review',
  valuation: 'Values',
  documents: 'Documents'
}

export const AI_EFFORTS = ['low', 'medium', 'high'] as const
export type AiEffort = (typeof AI_EFFORTS)[number]

export interface RouteConfig {
  model: ModelId
  effort: AiEffort
}

/** The models and efforts each route starts with in API-key mode. */
export const ROUTE_DEFAULTS: Record<AiRoute, RouteConfig> = {
  categorize: { model: 'claude-haiku-5-5', effort: 'low' },
  headline: { model: 'claude-sonnet-5-5', effort: 'low' },
  review: { model: 'claude-sonnet-5-5', effort: 'medium' },
  valuation: { model: 'claude-sonnet-5-5', effort: 'low' },
  documents: { model: 'claude-sonnet-5-5', effort: 'low' }
}

/** What a logged request was for: a route, or the API key's check. */
export type AiRequestRoute = AiRoute | 'keyCheck'

/** One request in the local AI request log, as its table lists it. */
export interface AiRequestSummary {
  id: number
  at: number
  route: AiRequestRoute
  provider: AiProvider
  /** the model asked for */
  model: string
  /** the request's size as sent */
  bytes: number
  /** sent: no answer was recorded (still waiting, or the app closed first) */
  status: 'sent' | 'ok' | 'error'
}

/** What a logged request's answer cost, as the service reported it. */
export interface AiRequestUsage {
  /** the model that answered */
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  stopReason?: string | null
  /** thinking blocks from earlier in the conversation that the service left out of what the model read, because the conversation before them had changed; absent when none */
  thinkingDropped?: number
  /** thinking blocks it left out for another reason (another model's, another account's); absent when none */
  thinkingUnread?: number
  /** thinking blocks the app itself took out of the conversation before this request (after a refusal of them, or with a forgotten fact); absent when none */
  thinkingRemoved?: number
}

export interface AiRequestDetail extends AiRequestSummary {
  /** the body as sent, with tool definitions by name and documents as { type, name, bytes } */
  request: unknown
  usage: AiRequestUsage | null
  error: string | null
}

/** Why an AI answer is reported. */
export const REPORT_REASONS = ['Wrong', 'Unsafe', 'Other'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

/** A report of one AI answer: the feature that gave it, the answer as the user left it, why, and an optional note. */
export interface AiReportInput {
  route: 'review' | 'headline'
  message: string
  reason: ReportReason
  note: string
}

/** Whether the AI backend can take calls: installed and signed in, or a key or token present. */
export interface AiStatus {
  ready: boolean
  provider: AiProvider
  problem?: string
}

/** This month's model usage for one route, from the API's own counts. */
export interface AiUsageTotals {
  route: AiRoute
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Who saved a fact: the user, the review assistant, or the file bridge (null for facts from before this was recorded). */
export type FactOrigin = 'user' | 'assistant' | 'bridge'

export interface Fact {
  id: number
  text: string
  createdAt: number
  origin: FactOrigin | null
}

export type RecurringKind = 'subscription' | 'bill' | 'loan' | 'income' | 'transfer' | 'other'
export type Cadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'annual'

export interface RecurringSeries {
  key: string
  name: string
  kind: RecurringKind
  cadence: Cadence
  /** signed; negative = money out */
  typicalCents: number
  lastCents: number
  previousCents: number
  priceChanged: boolean
  variable: boolean
  monthlyCents: number
  lastDate: number
  nextDate: number
  count: number
  status: 'active' | 'late' | 'stopped'
  confirmed: boolean
  dismissed: boolean
  categoryName: string | null
  accountName: string
  /** optional only for demo dumps taken before it existed */
  accountId?: string
  /** a transfer's other side (where the money came from or went), when both sides were found */
  pairAccountId?: string | null
  pairAccountName?: string | null
  /** the venture (bucket id) its latest payment belongs to, null for Personal */
  owner: number | null
  /** Personal's share of its latest payment, in basis points (10000 is all of it) */
  personalBp: number
}

/** What a line's money did, for the Personal waterfall (src/main/lines.ts). */
export type LineClass =
  | 'pay'
  | 'income'
  | 'oneOffIncome'
  | 'tax'
  | 'committed'
  | 'debtCost'
  | 'principal'
  | 'everyday'
  | 'oneOff'
  | 'unsorted'
  | 'venture'
  | 'invested'
  | 'cashReturn'
  | 'capital'
  | 'internal'
  | 'orphan'

/** One line of the ledger with its owner and class: a transaction, or one part of a split one, or a part derived from either. */
export interface ClassifiedLine {
  /**
   * txnId:splitId:owner, owner p or the venture's id, plus :bonus on the part of a paycheck that is bonus, :int and
   * :prin on a loan payment's interest (with escrow) and principal, and :cap on the part of a line that is capital.
   * A cost shared by an asset's uses is one line per owner, each keyed by its owner.
   */
  key: string
  txnId: string
  splitId: number | null
  /** the venture (bucket id) the line belongs to; null is Personal */
  owner: number | null
  /** YYYY-MM-DD in the ledger's zone */
  day: string
  accountId: string
  /** the account is one of the month's Personal cash and card accounts */
  perimeter: boolean
  /** signed, as the account saw it: negative is money out */
  cents: number
  cls: LineClass
  categoryId: number | null
  seriesKey: string | null
  paycheckKey: string | null
  /** for capital: the asset bought, sold or lent; for any other line: the asset it's a cost of (a loan payment's, the asset its loan is linked to) */
  assetId: string | null
  /** for debt cost and principal: the debt the interest or principal is on (a card's own interest names the card) */
  debtId: string | null
  /** the owner's share of the line, in basis points: its use share of a cost an asset's uses share, else 10000 */
  shareBp: number
  estimated: boolean
  /** the venture money crosses to or from on a boundary part (waterfall spec addendum 1.11); null on any other line */
  ventureId: number | null
  /** what the boundary part is; null when it is unset or the line is no boundary part */
  intent: VentureIntent | null
  /** who set the intent: Review, the user, a remembered rule or an inference; null with none */
  intentSource: 'review' | 'user' | 'rule' | 'inferred' | null
}

/** Which classified lines to list: days inclusive; every other field narrows. */
export interface LineQuery {
  fromDay: string
  toDay: string
  cls?: LineClass[]
  categoryId?: number | 'none'
  seriesKey?: string
  paycheckKey?: string
  accountId?: string
  assetId?: string
  /** a venture's id, or null for Personal */
  owner?: number | null
  /** transaction ids */
  ids?: string[]
  /** a paycheck's bonus part alone (its key ends :bonus), or with false every line but those: one check of a deposit split into regular pay and bonus */
  bonus?: boolean
  /** payee keys (payeeName: the merchant, else the description's key, lowered): the lines paid to any of them, as Left over's Payees name them */
  payees?: string[]
  /** the boundary parts with or to one venture (ClassifiedLine.ventureId) */
  ventureId?: number
  /** the boundary parts of one intent, or unset ones */
  intent?: VentureIntent | 'unset'
}

/** A page of classified lines, newest first, with how many matched and their sum. */
export interface LinePage {
  lines: ClassifiedLine[]
  total: number
  cents: number
}

/** Where a pay figure comes from: the check's own paystub, a paystub of the same payroll near it (estimated), or the deposits and the entered elections alone. */
export type PayBasis = 'paystub' | 'estimated' | 'deposits'

/** One line taken out of a paycheck: a tax (Taxes), a premium or other deduction (Benefits), or a savings plan (Saved at work). */
export type PaystubItemKind =
  | 'federal'
  | 'social_security'
  | 'medicare'
  | 'state'
  | 'local'
  | 'sdi'
  | 'other_tax'
  | 'medical'
  | 'dental'
  | 'vision'
  | 'life'
  | 'disability'
  | 'fsa'
  | 'dependent_care'
  | 'commuter'
  | 'other_deduction'
  | '401k'
  | 'roth_401k'
  | 'after_tax_401k'
  | '403b'
  | '457'
  | 'hsa'
  | 'espp'

export interface PaystubItem {
  kind: PaystubItemKind
  /** as the stub names it */
  name: string
  /** taken out of this check */
  cents: number
  /** this year so far, this check included, when the stub shows it */
  ytdCents: number | null
  /** taken out before income tax */
  pretax: boolean
  /** what the employer put in beside it this check: the match, the employer's HSA money, its share of a premium */
  employerCents: number | null
}

/** One paystub: gross pay, every line taken out, and net pay, which is always gross less the items. */
export interface Paystub {
  id: number
  /** the payroll's key, as the classifier names pay (shared/payroll.ts payrollKey): 'acme payroll|+' */
  paycheckKey: string
  /** the stub's pay date */
  payDay: string
  periodFrom: string | null
  periodTo: string | null
  kind: 'regular' | 'bonus' | 'final'
  grossCents: number
  netCents: number
  items: PaystubItem[]
  /** the document it was read from (the documents table's row), when known */
  documentId: number | null
  /** paystub: entered from a stub; snapshot: copied from the per-check withholding kept before paystubs (migration 39) */
  source: 'paystub' | 'snapshot'
  /** its gross wasn't on record, so it's the net plus the items */
  estimated: boolean
}

export interface PaystubInput {
  paycheckKey: string
  payDay: string
  kind?: Paystub['kind']
  periodFrom?: string | null
  periodTo?: string | null
  grossCents: number
  /** when given, it must be gross less the items */
  netCents?: number | null
  items: Array<{ kind: PaystubItemKind; cents: number; name?: string | null; ytdCents?: number | null; pretax?: boolean | null; employerCents?: number | null }>
  documentId?: number | null
  source?: Paystub['source']
  estimated?: boolean
}

/** One check of a payroll as the waterfall reads it: the deposits within 3 days of its first, and the paystub that explains them. */
export interface PayCheck {
  paycheckKey: string
  /** its first deposit's day */
  day: string
  /** bonus: off schedule, its stub's kind, or the part above 1.5 times the payroll's usual check */
  kind: Paystub['kind']
  basis: PayBasis
  /** the stub it reads: its own (basis paystub) or the one it's estimated from */
  stubId: number | null
  grossCents: number
  /** as taken out of this check: an estimate stops a 401(k) at the deferral limit and Social Security at the wage base, through the year so far */
  items: PaystubItem[]
  taxesCents: number
  benefitsCents: number
  savedAtWorkCents: number
  /** gross less the items */
  netCents: number
  depositCents: number
  /** deposit less net: the Payroll difference, 0 on deposits alone */
  differenceCents: number
  /** the employer's match and HSA money */
  employerSavingCents: number
  /** the employer's share of premiums */
  employerPremiumCents: number
  txnIds: string[]
}

/** A month's pay run rates: per payroll, each figure's mean over the regular checks in the window, times checks a year, over 12. */
export interface PayRunRates {
  month: string
  /** the window: the three months ending with the month, or for the open month the three full months before it */
  fromMonth: string
  toMonth: string
  /** the least exact basis among the window's checks; null with no checks */
  basis: PayBasis | null
  keys: PayRunRate[]
  totals: Omit<PayRunRate, 'paycheckKey' | 'checksPerYear' | 'checks' | 'days' | 'basis'>
}

export interface PayRunRate {
  paycheckKey: string
  checksPerYear: 52 | 26 | 24 | 12
  /** regular checks in the window it reads: since a new schedule began, and not a run's first check that pays part of a period (paystubs.ts) */
  checks: number
  /** those checks' days, oldest first */
  days: string[]
  basis: PayBasis
  grossCents: number
  taxesCents: number
  benefitsCents: number
  savedAtWorkCents: number
  payrollDiffCents: number
  /** gross less taxes, benefits and saved at work, plus the payroll difference */
  takeHomeCents: number
  depositCents: number
  employerSavingCents: number
  employerPremiumCents: number
}

export type CheckKind = 'paystub_mismatch' | 'paystub_missing' | 'w2_mismatch' | 'loan_payment_unlinked'

/** Payroll and debt data that doesn't tie, with the exact figure. */
export interface CheckItem {
  kind: CheckKind
  cents: number
  paycheckKey?: string
  payDay?: string
  accountId?: string
  year?: number
}

/** A year's paystubs against its return: wages (gross less pre-tax items) and federal withholding over every stub of every kind. */
export interface YearCheck {
  year: number
  /** every check of the year has its own paystub; only then are wages compared */
  complete: boolean
  wagesCents: number
  federalCents: number
  checks: CheckItem[]
}

// ---------- the Personal waterfall (src/main/waterfall.ts) ----------

/** A span of months (YYYY-MM) or of days (YYYY-MM-DD), both ends included: what Home, its drills and its charts read. */
export interface Span {
  from: string
  to: string
}

/** A row of the waterfall: the subtotals (Gross pay, Take-home, Elective, Left over, Saved), the rows taken off them, then Invested and Growth. */
export type StageId = 'gross' | 'taxes' | 'benefits' | 'savedAtWork' | 'payrollDiff' | 'takeHome' | 'committed' | 'elective' | 'everyday' | 'leftOver' | 'oneOffs' | 'saved' | 'invested' | 'growth'

/** The money a row's rate is a share of: another row, Gross pay plus employer saving (earned), or the invested balance at the month's start. */
export type RateFrom = StageId | 'earned' | 'investedBalance'

/** A month's close: open until it is closed (snapshots.ts), then closed, closed with a gap, or changed since (sub-phase 1i). */
export type CloseStatus = 'open' | 'closed' | 'gap' | 'changed'

/** Who closed a month: the schedule as it fell due (auto), Review's close_month, or the first close of a month long past (backfill). */
export type CloseOrigin = 'auto' | 'review' | 'backfill'

/** A row's run rate in one month, for its sparkline and Δ 3 mo. */
export interface TrendPoint {
  month: string
  runRateCents: number | null
  /** tenths of a percent; null with no base */
  rate: number | null
  /** for the rows whose rate reads pay: where that month's pay run rate comes from */
  basis: PayBasis | null
  status: CloseStatus
}

/** The groups Elective's Committed is drawn in. */
export type CommittedGroup = 'housing' | 'vehicles' | 'utilities' | 'insurance' | 'subscriptions' | 'debtCost' | 'other'

/** One part of a row: a payroll, a category, a series, a loan, a card, an account. Its figures are signed as the row's. */
export interface StagePart {
  key: string
  name: string
  actualCents: number
  /** the span's amount over its months (days over 30.44 for a day span), when it is longer than one month */
  perMonthCents: number | null
  runRateCents: number | null
  /** run rate now less 3 months before; null for Growth's parts */
  changeCents: number | null
  rate: number | null
  /** an Everyday category's tier */
  tag?: 'essential' | 'lifestyle'
  marker?: 'unconfirmed' | 'priceChange' | 'estimated'
  label?: string
  /** a Committed part's group */
  group?: CommittedGroup
  /** a Committed series' cadence */
  cadence?: Cadence
  /** a Committed series the user has confirmed (false: the classifier's guess), whatever its marker */
  confirmed?: boolean
  /** a Committed loan's escrow in its run rate, the rest being interest; null when a loan on a home doesn't say what it holds in escrow (any other loan holds none) */
  escrowCents?: number | null
  /** a Committed loan's or card's rate, in basis points; null when the account has none */
  aprBp?: number | null
  /** a Committed series whose price changed at its latest payment: a payment's price before and the price in force */
  price?: { fromCents: number; toCents: number }
  /**
   * a Committed part over the span's full months (the open month left out), and over the same months a year before;
   * null for a span of days, one with no full month or more than twelve, or one whose year before reaches back past
   * the first month of the books
   */
  yearAgo?: { fromMonth: string; toMonth: string; cents: number; wasCents: number } | null
  /** its lines over the span (linesFor) */
  drill: LineQuery
}

export interface StageRow {
  id: StageId
  role: 'subtotal' | 'less'
  /** the sum over the span: a cost (Taxes, Committed, Everyday, One-offs) is positive */
  actualCents: number
  /** Everyday in the open month: to date, at the pace of the days at home so far, for the whole month */
  paceCents: number | null
  /** the span's amount over its months (days over 30.44 for a day span), when it is longer than one month */
  perMonthCents: number | null
  /** monthly, in force at the span's end */
  runRateCents: number | null
  /** the run rate less the run rate 3 months before; null for Growth */
  changeCents: number | null
  /** tenths of a percent of the money it came from (rateFrom); null with no base */
  rate: number | null
  rateFrom: RateFrom | null
  /** the rate's change over 3 months, in points, to tenths; null when either base is zero or the pay bases can't be compared */
  rateChangePts: number | null
  basis: PayBasis | null
  /** the twelve months ending at the span's end, or every month of a longer span, oldest first */
  trend: TrendPoint[]
  /** the closed actual and run rate when the month is changed (sub-phase 1i) */
  closedCents: number | null
  closedRunRateCents: number | null
  parts: StagePart[]
}

/**
 * What a lever is (spec 1.8): w4, a refund withheld all year; card_interest and loan_interest, the interest a card or
 * a debt charges; price_change, a series that costs more than a year before; utilities_change, a utility that runs
 * higher than a year before; over_target, a category above its target; match_left, an employer match not taken;
 * tax_room, a yearly limit not used; cash_above_goals, savings beyond what the goals hold, earning less than invested.
 */
export type LeverKind = 'w4' | 'card_interest' | 'loan_interest' | 'price_change' | 'utilities_change' | 'over_target' | 'match_left' | 'tax_room' | 'cash_above_goals'

/** Money a row could gain a month, as data: what it is, how much, and what pulling it in full does to its row's rate. */
export interface Lever {
  /** the row it moves: Take-home, Elective, Left over, Saved or Invested */
  stage: StageId
  kind: LeverKind
  /** the account, series, category, plan or limit it is about */
  name: string
  /** what it is worth a month, at the run rates in force at the span's end */
  monthlyCents: number
  /** the rate charged, for card and loan interest, in basis points; null without one */
  aprBp: number | null
  /** the change in its row's rate, in points to tenths, if it were pulled in full and nothing else moved; null for the Invested levers, which move money between rows */
  ratePts: number | null
  /** the lines behind it (linesFor); null when no line is */
  drill: LineQuery | null
  /** read from an estimate: a loan split no balances measured, pay from a stub not its own, a limit not announced yet */
  estimated: boolean
}

/**
 * The retirement line (spec 1.7): what is invested now and the Invested run rate, grown at the user's own real
 * return to the age they retire at, in today's dollars. Null until Review sets the birth year, the age and the return.
 */
export interface Retirement {
  birthYear: number
  retireAge: number
  realReturnBp: number
  /** years to go from the month's year, never below 0 */
  years: number
  /** the year it comes: the month's year plus years */
  year: number
  /** the Personal investment, retirement and HSA balance at the month's end (the last full month's, in the open month) */
  investedCents: number
  /** the Invested run rate, a month; the projection adds 12 times it each year */
  contributionCents: number
  projectedCents: number
}

/** An invested account's return in Growth's drill (spec 1.7), as Growth's part for it (return:<id>) has it, with how the account is taxed. */
export interface AccountReturn {
  accountId: string
  name: string
  /** investment, retirement, or cash for an HSA held as cash: what it opens (the Investments page, or nothing) */
  assetType: AssetType
  treatment: TaxTreatment
  /** over the span; null when none of its return over the span can be measured */
  actualCents: number | null
  /** the span's amount over its months, when it is longer than one month */
  perMonthCents: number | null
  /** over the 12-month window at the span's end, over 12; null when none of it can be measured */
  runRateCents: number | null
  /**
   * over the span's days whose return can't be measured (a statement not in yet, or values and flows that make no
   * track): the change in its value and the money put in, from cash and from pay. The bridge's Revaluation holds the
   * change less the money put in. Null when neither moved.
   */
  unmeasured: { changeCents: number; putInCents: number } | null
}

/**
 * What Growth's drill shows beside its row (spec 1.7), over the span as the rows are (1.12): each Personal investment,
 * retirement and HSA account whose return over the span or its 12-month window can be measured (a return of 0
 * included), or whose value or money put in moved over days its return can't be measured; the measured returns by
 * tax treatment (with Cash return they add up to Growth to the cent); the accounts' time-weighted return together over
 * the 12 months Growth's run rate reads; and the bridge's Revaluation of each Personal asset. None of it is frozen with
 * a month's close.
 */
export interface GrowthDrill {
  /** the largest run rate first, then the largest return */
  accounts: AccountReturn[]
  /** in the order TAX_TREATMENTS lists them, of the accounts with a measured return */
  byTreatment: Array<{ treatment: TaxTreatment; actualCents: number; perMonthCents: number | null; runRateCents: number }>
  /**
   * over (fromDay, toDay]: the 12-month window Growth's run rate reads at the span's end; rate a fraction (0.05 is
   * 5%), null when the accounts' values don't cover it as the Investments page's 1Y needs (they hold under nine
   * tenths of the money at its start, or stop before nine tenths of the year)
   */
  twr: { fromDay: string; toDay: string; rate: number | null }
  /**
   * the bridge's Revaluation by Personal asset (property, a vehicle, another asset, money lent, a stake) over the span,
   * each that moved, the largest change first: its change less what was bought or sold of it and what its loans
   * financed. With each account's unmeasured change less its money put in, they add up to bridge.revaluationCents.
   */
  revaluation: Array<{ accountId: string; name: string; assetType: AssetType; cents: number }>
}

/**
 * Where Kept went (spec 2, the cash identity): Kept + Ventures + Cash return + Unsorted = Moved to savings + Left in
 * checking + Debt paid down + Moved to investments + Bought assets + In transit + Unexplained. Positive is money kept.
 */
export interface CashIdentity {
  keptCents: number
  /** the venture lines in the ledger less every Personal line on a venture's own cash and cards */
  venturesCents: number
  cashReturnCents: number
  unsortedCents: number
  /** what the perimeter's saving cash accounts went up by */
  movedCents: number
  /** what the perimeter's spending cash accounts went up by */
  checkingCents: number
  /** minus the principal lines, plus what the perimeter's cards went down by: money borrowed makes it negative */
  debtPaidCents: number
  /** minus the invested lines */
  toInvestmentsCents: number
  /** minus the capital lines: purchases and money lent, less sales and repayments */
  boughtCents: number
  /** minus the internal lines: money that left a perimeter account and lands in another later */
  inTransitCents: number
  /** what the other terms leave over */
  unexplainedCents: number
  /** Unexplained as its items add up: the balance gaps, orphan transfers and money sent to hidden accounts */
  itemizedCents: number
  /** Unexplained less its items */
  engineErrorCents: number
}

/**
 * How net worth moved (spec 2, the bridge): end - start = Saved + Growth + Revaluation + Ventures(NW) + Unsorted - In
 * transit - Unexplained + Other, over every visible account net worth counts, from the day before the first day to
 * the last.
 */
export interface NetWorthBridge {
  startCents: number
  endCents: number
  savedCents: number
  growthCents: number
  /** Personal assets' change less what was bought of them and what their loans financed, and the change of invested accounts whose return can't be measured, less their flows */
  revaluationCents: number
  /**
   * Ventures(NW): the cash identity's Ventures plus, for each venture, the change in its position less what Bought
   * assets and Debt paid down moved of its claims and stake (its capital and principal parts). With every share at
   * 100% on the books and no claims, a venture's position is its accounts, so this is the change of the venture
   * accounts net worth counts.
   */
  venturesCents: number
  unsortedCents: number
  inTransitCents: number
  unexplainedCents: number
  otherCents: number
  /**
   * added: the first value of a manual account first valued then, with no opening day; outsideFlow: money into or
   * out of an invested account from neither the perimeter nor payroll then; untrackedSaving: minus saving at work
   * that went to a plan with no tracked account (accountId '' when the plan names none); debtResidual: a Personal
   * debt's change in what it owes that no principal line or financing explains. removed is never given: every account
   * holds its last known value until it closes.
   */
  other: Array<{ kind: 'added' | 'removed' | 'outsideFlow' | 'untrackedSaving' | 'debtResidual'; accountId: string; cents: number }>
  /** the change in net worth less the terms */
  engineErrorCents: number
  /** each venture's position at the start and the end, by bucket id: the part of start and end net worth that is the user's money in ventures */
  ventures: Array<{ bucketId: number; startCents: number; endCents: number }>
}

export type LeakKind = 'balance_gap' | 'orphan_transfer' | 'hidden_account' | 'month_end_unbracketed' | 'late_sync' | 'engine_error'

/**
 * Data in a month's close (spec 2, Leak and check items), with its exact figure: a balance gap (fromDay and toDay are
 * the known balances it's between), an orphan transfer (by the account it left), money sent to a hidden account (by
 * that account), an engine error (over its days). balance_gap, orphan_transfer and hidden_account are Unexplained's
 * items, in its sign.
 */
export interface LeakItem {
  kind: LeakKind
  cents: number
  accountId?: string
  txnIds?: string[]
  fromDay?: string
  toDay?: string
}

/** The Personal waterfall over a span: its rows, what reconciles them, and where to look first. */
export interface Waterfall {
  span: Span
  /** the month the run rates, Δ 3 mo and Δ pts are taken at: the span's last, or the last full month when the span ends inside a closed month */
  endMonth: string
  /** the span ends in the open month or inside a month */
  partial: boolean
  rows: StageRow[]
  /** what the employer put in beside Gross pay over the span: the match, its HSA money and its share of premiums */
  employerAdds: { matchCents: number; hsaCents: number; premiumCents: number }
  /** the span's checks, oldest first: each payroll's pay days with their gross, items, net and deposit, Take-home's pay-day table */
  payChecks: PayCheck[]
  /**
   * the yearly limits at the span's last day (today, for a span that runs to it): what the year's checks have put
   * toward the 401(k) deferral limit (the employee's) and the self-only HSA limit (the employee's and the
   * employer's), beside each limit; provisional when the year's limit isn't announced yet
   */
  limits: Array<{ name: string; filledCents: number; limitCents: number; provisional: boolean }>
  /**
   * each debt's principal over the span, the largest first: what its payments paid off, less what was borrowed on
   * it (negative when more was borrowed), with the lines behind it. Principal goes to Debt paid down, never to a row.
   */
  principal: Array<{ debtId: string; name: string; cents: number; drill: LineQuery }>
  /** Uncategorized money in the ledger over the span, in and out: signed, how many lines, and the transactions they're on */
  unsorted: { cents: number; count: number; ids: string[] }
  /**
   * Everyday over the span by payee (spec 1.5, Left over's Payees), the largest first: each payee's key (payeeName,
   * what LineQuery.payees takes), its name (null for a vendor the user hides, which is never named in a list), what
   * it took as Everyday reads it (a refund less), over the span's months when the span is longer than a month, and
   * how many lines. They add up to Everyday.
   */
  payees: Array<{ key: string; name: string | null; cents: number; perMonthCents: number | null; count: number }>
  /**
   * One-offs over the span (spec 1.6, Saved's drill): each transaction's one-off lines as one item, the 40 largest,
   * named by its payee (null for a hidden vendor) with the trip it was bought on, and how many there are in all; and
   * each trip with one-offs bought on it in the span, with the transactions they're on. A cost is positive and
   * one-off income negative, as One-offs reads them; every item together is One-offs.
   */
  oneOffs: {
    items: Array<{ txnId: string; day: string; name: string | null; categoryId: number | null; cents: number; trip: string | null }>
    count: number
    trips: Array<{ name: string; fromDay: string; toDay: string; cents: number; ids: string[] }>
  }
  /** at the span's end: card and loan interest first, highest rate first (one with no rate after them), then the rest by amount */
  levers: Lever[]
  retirement: Retirement | null
  /** Growth's drill: returns by account and by tax treatment, the 12-month TWR and Revaluation by account; null for a month's close */
  growth: GrowthDrill | null
  /** the span's months' identities added up */
  identity: CashIdentity
  bridge: NetWorthBridge
  /** the span's balance gaps, orphan transfers, money sent to hidden accounts and engine errors */
  leaks: LeakItem[]
  checks: CheckItem[]
  /** the larger of close.tolerance's cents and its share of the Take-home run rate */
  toleranceCents: number
  focus: StageId | 'unsorted' | 'unexplained' | null
  /** the span's months as one marker: changed when any is, else gap when any is, else open when any is (the open month, or one not closed yet), else closed */
  status: CloseStatus
  /** a span of one month (or days in one): its latest close's version; null for a longer span or a month not closed */
  version: number | null
  /**
   * each month of the span: its latest close's status and origin, or open with no origin, with its Unexplained (over
   * the span's days in it) and its own tolerance, and its net worth bridge over those days, live: the span's bridge is
   * these added up, and each one's end is the next one's start (Net worth's Overview lists them, spec 2d); a month
   * changed since its close, in a span of months, has closedBridge, its bridge as that close froze it (null otherwise)
   */
  months: Array<{ month: string; status: CloseStatus; origin: CloseOrigin | null; unexplainedCents: number; toleranceCents: number; bridge: NetWorthBridge; closedBridge: NetWorthBridge | null }>
  /**
   * while a month of a span of months is changed since its close (spec 2, On Home): every figure its close froze, as
   * closed and as the books have it now, over the span as the rows are: its amounts with the changed months' closed
   * amounts in place of today's, and its run rates, Δ 3 mo, Δ pts and pay basis as its last month closed with them,
   * when that month is changed; the figures now are what closing the span's months again would freeze. Null otherwise.
   */
  closed: ClosedFigures | null
  /** the first month Personal's cash and cards have a line in, where the span picker's All starts; null with none */
  firstMonth: string | null
  /**
   * Home's Spendable strip, as the getWaterfall handler fills it (null from the engine alone): what the account
   * Spendable shows first can spend today at the risk chosen, keeping the cushion through untilDay, the last day its
   * forecast runs to. Null with no current balance.
   */
  spendable: { cents: number; untilDay: string; risk: SpendRisk } | null
}

/** What Home opens on (the home.open setting): one of its rows, or the Spendable strip at the top. */
export const HOME_OPEN = ['gross', 'takeHome', 'elective', 'leftOver', 'saved', 'invested', 'growth', 'spendable'] as const satisfies readonly (StageId | 'spendable')[]
export type HomeOpen = (typeof HOME_OPEN)[number]

/**
 * What Home's Left over and Saved drills read beside the waterfall (spec 1.5 and 1.6), all as they stand today and
 * none of it the span's: the plans Review keeps, as data.
 */
export interface HomePlans {
  /**
   * the month they're of, the open one (YYYY-MM): the rollover is what carried into it, and the habits are measured
   * over the three full months before it, the run-rate window of this month and of the last full one
   */
  month: string
  /** each category with a target: the target as set, and with rollover on what carried into this month and the target with it */
  targets: Array<{ categoryId: number; targetCents: number; rollover: { carriedCents: number; availableCents: number | null } | null }>
  /**
   * the habits measured over the last three full months at home, each under its category (null: One-offs), with how
   * often, what it costs a month and the commitment made for it with how this month is going; drill is the purchases
   * it was measured from, null when there are none to open: a commitment whose habit is no longer measured, and the
   * one-offs', which the budget averages over six months of its own
   */
  habits: Array<{ id: string; kind: Habit['kind']; categoryId: number | null; name: string; often: string | null; monthlyCents: number; commitment: string | null; progress: string | null; drill: LineQuery | null }>
  /** the one-off budget, when one is set */
  oneOffTargetCents: number | null
  /** the trips not over yet, as Budget's trip list had them: their first and last days away, and what's been bought on each so far */
  trips: Array<{ name: string; fromDay: string; toDay: string; spentCents: number }>
  /** the goals not archived, as goals.ts shows them today */
  goals: Array<{ id: number; name: string; savedCents: number; targetCents: number }>
  /**
   * the debt the payoff plan pays extra on first, among the debts it doesn't leave out and in the order it pays them
   * (debtPlan.ts, debt.plan), what it owes today and the rate the plan ranks it by next month (an intro rate while it
   * lasts, with the day it ends; null with no rate on file); null when the plan owes nothing
   */
  nextDebt: { id: string; name: string; aprBp: number | null; promoEnds: string | null; owedCents: number } | null
}

/**
 * One version of a month's close (spec 2, snapshots.ts): what Personal's books said about the month when it was
 * closed. Its rows, lines and balances are kept with it; these are the figures and the digests that later checks
 * compare against.
 */
export interface MonthSnapshot {
  /** YYYY-MM */
  month: string
  /** 1 for its first close; every later close of the month is the next number, and every version is kept */
  version: number
  origin: CloseOrigin
  /** unix seconds */
  closedAt: number
  /** the engine's version it was closed under (lines.ts ENGINE_VERSION) */
  engineVersion: number
  /** closed when Unexplained is within the tolerance and neither identity has an engine error, else gap */
  status: 'closed' | 'gap' | 'changed'
  /** the month's ledger lines: how many, and their cents added up */
  lineCount: number
  lineSumCents: number
  unexplainedCents: number
  toleranceCents: number
  /** Unexplained's items, months closed without every balance (month_end_unbracketed, late_sync) and engine errors */
  leaks: LeakItem[]
  checks: CheckItem[]
  /** sha-256 in hex: the lines (key|class|cents), the source rows and dated inputs, the balances, the rows, and the undated inputs */
  digests: { lines: string; raw: string; balances: string; rows: string; inputs: string }
}

/**
 * Why a closed month's figures moved after it was closed (spec 2, Silent rewrites): a bank sync, the user, a rule or
 * a series or a setting the classifier reads, the review assistant, or a new version of the classifier itself.
 */
export type ChangeCause = 'sync' | 'user' | 'rule' | 'ai' | 'engine'

/** A part of a row as a month's close froze it and as the books have it now: its actual, run rate, Δ 3 mo and rate. */
export interface PartFigures {
  key: string
  name: string
  closedCents: number
  nowCents: number
  closedRunRateCents: number | null
  nowRunRateCents: number | null
  /** Δ 3 mo; null for Growth's parts */
  closedChangeCents: number | null
  nowChangeCents: number | null
  closedRate: number | null
  nowRate: number | null
}

/** A row as a month's close froze it and as the books have it now: its actual, run rate, Δ 3 mo, rate, Δ pts and pay basis, and each of its parts whose figures moved. */
export interface StageFigures {
  id: StageId
  closedCents: number
  nowCents: number
  closedRunRateCents: number | null
  nowRunRateCents: number | null
  /** Δ 3 mo; null for Growth */
  closedChangeCents: number | null
  nowChangeCents: number | null
  closedRate: number | null
  nowRate: number | null
  /** Δ pts */
  closedRateChangePts: number | null
  nowRateChangePts: number | null
  closedBasis: PayBasis | null
  nowBasis: PayBasis | null
  parts: PartFigures[]
}

/**
 * The ledger lines that go into a row, or into a term of the cash identity, as a month's close froze them and as the
 * books have them now: how many, and how many are on one side only, by key, class and amount as the lines digest reads
 * them. A split of one line into two of the same category is one removed and two added, with no figure moving.
 */
export interface LineCounts {
  /** the row the lines go into: Take-home's deposits, Gross pay's other income, Taxes, Committed, Everyday, One-offs */
  row: StageId | null
  /** else the cash identity's term they go into: Debt paid down, Moved to investments, Ventures, Unsorted and the rest */
  term: keyof CashIdentity | null
  closedCount: number
  nowCount: number
  /** the lines now that the close hadn't */
  added: number
  /** the close's lines that aren't there now */
  removed: number
}

/**
 * Every figure a month's close freezes, as it closed and as the books have it now (spec 2, What is frozen): each row
 * (byStage) and each of its parts whose figures moved, each term of the cash identity and of the net worth bridge, and
 * each of the bridge's Other items that moved; and the lines of each row and identity term whose lines moved
 * (lineCounts). Each figure the rows digest reads is among them: a month whose rows digest moved has at least one
 * that differs, and one whose lines moved has a row's or a term's lines. A row or part on one side only was nothing
 * on the other: 0, no Δ pts, a rate of 0 where the other side has one, and the other side's pay basis.
 */
export interface ClosedFigures {
  byStage: StageFigures[]
  identity: Array<{ key: keyof CashIdentity; closedCents: number; nowCents: number }>
  bridge: Array<{ key: Exclude<keyof NetWorthBridge, 'other' | 'ventures'>; closedCents: number; nowCents: number }>
  other: Array<{ kind: NetWorthBridge['other'][number]['kind']; accountId: string; closedCents: number; nowCents: number }>
  lineCounts: LineCounts[]
}

/**
 * How a closed month differs today from its latest close (spec 2 and 6, sub-phase 1i): each line added, removed, put
 * in another class (restaged), changed in amount (reamounted) or moved to another owner; each input that changed with
 * no line changing (a paystub, a contribution plan, an account's settings, a balance, a valuation, a recorded flow, a
 * setting, or an earlier month the run rates read); every figure the close froze, as closed and now (ClosedFigures);
 * and which of the changes that re-close a month by themselves it is, if any. From sub-phase 1j an input can be the
 * claims on a venture its positions read (kind claims, ref the venture's id), moved by an earlier line's intent, and
 * the fourth such change is money with a venture moved between Ventures, Bought assets and Debt paid down alone
 * (boundaryMoved).
 */
export interface SnapshotDiff extends ClosedFigures {
  month: string
  version: number
  lines: Array<{ key: string; change: 'added' | 'removed' | 'restaged' | 'reamounted' | 'owner'; fromCls?: LineClass; toCls?: LineClass; fromCents?: number; toCents?: number; cause: ChangeCause }>
  inputs: Array<{ kind: 'paystub' | 'contribution' | 'account' | 'balance' | 'valuation' | 'flow' | 'setting' | 'earlierMonth' | 'claims'; ref: string; cause: ChangeCause }>
  autoReclose: 'gapFill' | 'unsortedCategorized' | 'loanRefined' | 'boundaryMoved' | null
}

/** A closed month whose figures changed since its latest close, waiting for Review: why, and the months that changed with it (its batch). */
export interface ChangedMonth {
  month: string
  /** the latest close it differs from */
  version: number
  cause: ChangeCause
  /** months found changed by one cause together share a batch */
  batch: string
  /** the batch's cause in a few words: "Rule Shopmart > Shopping", "A sync or import" */
  label: string
  /** unix seconds it was found changed */
  since: number
}

/** How sure "spendable" plays it: cautious (Worst case) takes the worst amounts and timing seen, balanced (Most likely) the usual ones, tight (Best case) the schedule. */
export type SpendRisk = 'cautious' | 'balanced' | 'tight'

/** Each risk's name and what it assumes, in a line. */
export const SPEND_RISKS: Array<{ id: SpendRisk; label: string; assumes: string }> = [
  { id: 'cautious', label: 'Worst case', assumes: 'Bills at their highest +15% · pay on its latest day, a late check not counted · dearer shops, more often' },
  { id: 'balanced', label: 'Most likely', assumes: 'Bills, pay and shops as they usually go' },
  { id: 'tight', label: 'Best case', assumes: 'Bills and pay on schedule · pay counted before same-day bills' }
]

/** The risk Spendable plays with none chosen (spend.risk unset): Most likely. */
export const DEFAULT_SPEND_RISK: SpendRisk = 'balanced'

/** A recurring bill, paycheck or transfer expected on a day, at the amount forecast for it. */
export interface SpendItem {
  key: string
  day: string
  name: string
  kind: RecurringKind
  /** signed; negative = money out */
  cents: number
  accountId: string
  accountName: string
  /** a forecast (the amount varies, or it's a card's balance), not a fixed charge */
  estimated: boolean
  /** it was due and hasn't posted */
  late: boolean
  /** an everyday trip (groceries, gas) forecast from the account's own, not a bill */
  everyday?: boolean
  /** pay that keeps no schedule (gig apps, tips, freelance): a week of it at the risk's figure, not a payday */
  irregular?: boolean
  /** a bill seen once while the bank's history is still arriving, counted again a month on at the worst case's margin */
  provisional?: boolean
  /** the recurring series it's a payment of (RecurringSeries.key), for a bill, paycheck or transfer */
  seriesKey?: string
}

export interface SpendDay {
  day: string
  /** the balance as the day starts (the day before's end) */
  startCents: number
  /** the balance at the end of the day */
  endCents: number
  /** the day's lowest point: before its money in, unless the risk is tight */
  lowCents: number
  inCents: number
  /** bills and everyday trips going out (negative) */
  outCents: number
}

/** A cash account's coming days and what can be spent from it today. */
export interface SpendAccount {
  id: string
  name: string
  /** the lower of the bank's balance and its available balance */
  startCents: number
  balanceDate: number
  /** the most that can go out today and still keep the cushion through the last day: negative when even nothing falls short */
  spendableCents: number
  /** the day the balance is lowest */
  lowDay: string
  nextPayday: string | null
  /** spendable spread over the days until the next payday */
  perDayCents: number | null
  /** today through the second payday from now (14 to 45 days) */
  days: SpendDay[]
  /** what's spendable at each risk, to compare them */
  byRisk: Record<SpendRisk, number>
}

export interface Spendable {
  risk: SpendRisk
  cushionCents: number
  /** the account shown first: the one picked, or the one paychecks land in */
  accountId: string | null
  /** cash accounts with a balance from the last week */
  accounts: SpendAccount[]
  /** everything expected in the next 30 days (or to the last account's last day), on every account */
  items: SpendItem[]
  /** a bank's history is still arriving: bills seen once are counted again, and irregular pay at its floor, whatever the risk */
  provisional?: boolean
}

/** Money taken out of a paycheck into a savings plan. */
export type ContributionKind = '401k' | 'roth_401k' | 'hsa' | 'espp'

export const CONTRIBUTION_KINDS: Array<{ id: ContributionKind; label: string }> = [
  { id: '401k', label: '401(k)' },
  { id: 'roth_401k', label: 'Roth 401(k)' },
  { id: 'hsa', label: 'HSA' },
  { id: 'espp', label: 'ESPP' }
]

export interface ContributionInput {
  id?: number
  name: string
  kind: ContributionKind
  /** the plan's account */
  accountId?: string | null
  /** the recurring paycheck it comes out of */
  paycheckKey?: string | null
  /** election, percent of pay */
  percent?: number | null
  /** yours, per paycheck */
  employeeCents?: number | null
  /** employer's, per paycheck */
  matchCents?: number | null
  matchNote?: string | null
  /** the match as a rule, in basis points: matchRateBp of pay up to matchCapBp of pay (50% of the first 6% is 5000 and 600); null until Review reads it from matchNote */
  matchRateBp?: number | null
  matchCapBp?: number | null
  /** your contributions this year as of ytdAsOf (from a paystub or the plan) */
  ytdCents?: number | null
  ytdAsOf?: string | null
  /** the first paycheck it came out of */
  startsDay?: string | null
  /** the last paycheck it came out of, for a job that ended */
  endsDay?: string | null
  /** an election change: the new percent and per-paycheck amount, from the first paycheck on or after this date */
  nextPercent?: number | null
  nextEmployeeCents?: number | null
  nextFrom?: string | null
  notes?: string | null
}

export interface Contribution extends Required<Omit<ContributionInput, 'id'>> {
  id: number
  employer: string | null
  cadence: Cadence | null
  /** monthly equivalents; 0 once it has ended */
  perMonthCents: number
  matchPerMonthCents: number
  /** paychecks still to come this year */
  checksLeft: number
  /** this year so far: the known total plus paychecks since; null when unknown */
  soFarCents: number | null
  /** this year's total by Dec 31 at the current election; null when this year's total so far is unknown */
  projectedCents: number | null
}

export interface ContributionLimit {
  label: string
  limitCents: number
  /** the year's figure isn't announced yet: last year's carried forward (shown as "est.") */
  limitProvisional: boolean
  /** known so far this year, and by Dec 31 at current elections */
  ytdCents: number
  projectedCents: number
  /** plans whose total this year is unknown */
  unknown: string[]
}

export interface ContributionSummary {
  year: number
  plans: Contribution[]
  /** the elective deferral limit across every 401(k), and the HSA limit */
  limits: ContributionLimit[]
  /** what each paycheck withholds besides savings plans: taxes and insurance */
  withholding: PaycheckWithholding[]
}

/** One insurance premium out of a paycheck: medical, dental, vision, life, disability... */
export interface InsuranceItem {
  /** e.g. 'Medical insurance' */
  name: string
  cents: number
  /** taken out before taxes (on the paystub's pre-tax deductions) */
  pretax: boolean
}

/** Taxes and benefits taken out of paychecks, from their paystubs, as the money-flow charts read them. */
export interface WithholdingAmounts {
  federalCents: number
  socialSecurityCents: number
  medicareCents: number
  /** state income tax, with the other taxes below the federal ones: local, SDI or PFML, any other */
  stateCents: number
  /** every premium and benefit (FSA, commuter) together */
  insuranceCents: number
  /** the premiums and benefits one by one; they add up to insuranceCents */
  insurance: InsuranceItem[]
  /** other deductions: anything else taken out that isn't a tax, a benefit or a savings plan */
  otherCents: number
}

/** The amounts in WithholdingAmounts (everything but the premium list). */
export type WithholdingCentsKey = Exclude<keyof WithholdingAmounts, 'insurance'>

/** What one payroll withholds per check, from its latest regular paystub. */
export interface PaycheckWithholding extends WithholdingAmounts {
  paycheckKey: string
  asOf: string
  grossCents: number | null
  netCents: number | null
  employer: string | null
  cadence: Cadence | null
  /** monthly equivalents at the paycheck's cadence; all 0 once the paycheck has stopped */
  perMonth: WithholdingAmounts
}

export type ReviewItem =
  | { id: string; role: 'user' | 'assistant'; text: string }
  /** a message posted through the file bridge (a Claude Code session), never the assistant's own words */
  | { id: string; role: 'bridge'; text: string }
  /** a change made by a tool; changeId names its journal entry, which Undo puts back, and undone says it was */
  | { id: string; role: 'action'; text: string; ok: boolean; changeId?: number; undone?: boolean }

/** An issue the user or the assistant marked as settled, so it stays out of the review until un-skipped. */
export interface ResolvedIssue {
  key: string
  summary: string | null
  note: string | null
  createdAt: number
}

/** A destructive change the assistant asked for, waiting for Approve or Discard. */
export interface PendingAction {
  id: number
  createdAt: number
  tool: string
  input: Record<string, unknown>
  /** the tool and its arguments in one short line */
  summary: string
}

export interface ReviewState {
  items: ReviewItem[]
  busy: boolean
  openIssues: Record<string, number>
  facts: Fact[]
  /** files in the documents folder, and how many the assistant hasn't gone through */
  documents: { total: number; unread: number }
  pending: PendingAction[]
  /** issues skipped with resolve_issue, newest first */
  resolved: ResolvedIssue[]
}

export interface NetWorthPoint {
  day: string // YYYY-MM-DD
  cents: number
}

export interface NetWorthSeries {
  points: NetWorthPoint[]
  accountsIncluded: number
  /** visible accounts with no balance of their own, left out of a venture's series (Personal's counts each at what its lines and known balances give, so 0) */
  accountsMissing: number
  /**
   * Personal's money between two of its accounts whose legs post on different days of one month, oldest first: from
   * fromDay to toDay (the day before the later leg) the points count it as landed, `cents` more than the balances as
   * the banks had them. No month's last day is in one, so every month's end is the bridge's; a chart whose first or
   * last day is in one takes its `cents` back over its days to start or end where the bridge does. Empty for a venture.
   */
  landed: Array<{ fromDay: string; toDay: string; cents: number }>
  /**
   * Personal's net worth on each day from tomorrow to the open month's last day, where its bridge ends, when a line
   * already dated after today moves it; empty otherwise, and for a venture. `points` ends today.
   */
  ahead: NetWorthPoint[]
}

export interface Insight {
  headline: string
  detail: string
  tone: 'positive' | 'negative' | 'neutral'
  categoryId: number | null
  source: 'ai' | 'local'
  generatedAt: number
  /** set when Claude was unavailable and the local fallback was used */
  error?: string
}

/**
 * api: the user's own Anthropic API key. proxy: the app's hosted service, with a license token.
 * claude-code: the Claude Code CLI on the user's Claude subscription (development builds only).
 */
export type AiProvider = 'claude-code' | 'api' | 'proxy'

export interface ClaudeCodeStatus {
  installed: boolean
  loggedIn: boolean
  account: string | null
  /** subscription type or sign-in method, as Claude Code reports it */
  method: string | null
  error?: string
}

/** A change made from Claude Desktop through the connector, as Settings lists it. */
export interface ConnectorChange {
  id: number
  /** Unix seconds */
  at: number
  tool: string
  summary: string
  undone: boolean
}

/** Claude Desktop's connector (src/main/connector.ts): the open edition's and a development build's; offered false in every other build. */
export interface ConnectorStatus {
  offered: boolean
  on: boolean
  allowChanges: boolean
  /** listening for the extension */
  running: boolean
  /** why it couldn't start */
  error: string | null
  /** its newest changes, newest first */
  changes: ConnectorChange[]
}

/** The extension written to the home folder, and whether Claude Desktop was asked to open it (else it was shown in its folder). */
export interface ConnectorInstall {
  file: string
  opened: boolean
}

/** The account's answer to the AI consent line (hosted): when, and the line's version. */
export interface AiConsent {
  allowed: boolean
  at: string
  version: string
}

export interface AppSettings {
  provider: AiProvider
  /** the one model Claude Code mode uses for everything */
  model: string
  /** the model and effort of each route in API-key and hosted mode */
  routes: Record<AiRoute, RouteConfig>
  /** Claude Code mode can be picked (a development build) */
  claudeCodeOffered: boolean
  /** the hosted service is set up (a proxy URL is known) */
  proxyAvailable: boolean
  licenseTokenSaved: boolean
  autoClassify: boolean
  apiKeySource: 'saved' | 'env' | 'none'
  /** the last check of the key in use (cleared when another key is saved) */
  keyCheck: KeyCheck | null
  /** a development build still syncing SimpleFIN (shipped builds have none) */
  simplefinConnected: boolean
  /** Plaid through the server: whether this build has one, and the banks connected */
  bank: { available: boolean; connections: BankConnection[] }
  lastSyncAt: number | null
  syncsLast24h: number
  historyFrom: number | null
  historyComplete: boolean
  /** the bridge's warnings from the last sync, or why it failed */
  syncWarnings: string[]
  dataPath: string
  /** numbers start hidden when the app opens (the eye in the sidebar shows them) */
  hideNumbersOnOpen: boolean
  /** vendors never called out by name (their spending still counts) */
  hiddenVendors: string[]
  /** houses and vehicles are looked up on the web about monthly (each asset can opt out) */
  lookupValues: boolean
  /** every AI request is kept in the local log (Settings → AI) */
  requestLog: boolean
  /** The AI switch under Settings → AI: off, nothing is sent to an AI service (ai.enabled = '0') */
  aiEnabled: boolean
  /** hosted: the account's answer to the AI consent line (null until asked); the service's AI waits for allowed */
  aiConsent: AiConsent | null
  /** the plan in force, for the locks */
  plan: PlanInfo
  /** Settings → Display: the window's theme (system follows the OS) */
  theme: ThemeChoice
  /** Settings → Data: the database's encryption at rest */
  database: DatabaseState
  /** what Home opens on (the home.open setting, from onboarding's answer): a row or the Spendable strip; null opens none */
  homeOpen: HomeOpen | null
  /** how sure Spendable plays it (spend.risk, which its card's risks set too): Most likely until one is chosen */
  spendRisk: SpendRisk
}

/** The database's encryption at rest (src/main/dbopen.ts). */
export interface DatabaseState {
  /** the database, its write-ahead log and its backups are encrypted */
  encrypted: boolean
  /** a development build: Settings → Data has the Encrypted switch (a packaged build is always encrypted) */
  switchable: boolean
  /** the switch as set (always on in a packaged build); differs from `encrypted` until the restart */
  switchOn: boolean
  /** encrypted, and no recovery code saved for the key yet */
  recoveryPending: boolean
  /** how far the key file opens without the recovery code: this computer and user account, or only this installation of the app */
  keySeal: 'account' | 'install'
}

/** A restore: the file restored, null when cancelled, or the backup's file name when it needs its recovery code. */
export type RestoreResult = string | null | { needsCode: string }

/** Settings → Data → Move to an account: offered in a development build with a server configured. */
export interface MoveAccountStatus {
  available: boolean
  server: string | null
}

/** What a move put in the account: tables and rows restored, files uploaded, and the paths that weren't (missing, outside the document folders, or a type the server doesn't take). */
export interface MoveAccountResult {
  tables: number
  rows: number
  files: number
  skipped: string[]
}

/** The plan in force and the license behind it (src/main/license.ts). */
export interface PlanInfo {
  plan: 'free' | 'trial' | 'plus'
  trialDaysLeft: number
  trialEndsAt: string | null
  /** a trial was started on this install (so it isn't offered again) */
  trialStarted: boolean
  /** a license token is held and still entitles (a trial token counts) */
  licensed: boolean
  /** a Plus license: paid through, and the day the offline grace runs out */
  paidThrough: string | null
  graceUntil: string | null
  machineId: string
  /** a server is set to activate with and run the included AI */
  serverAvailable: boolean
  /** Plus by the development build, not by a license */
  dev: boolean
  /** Plus by the beta, not by a license: a packaged beta build before its end */
  beta: boolean
  /** the beta's last day (YYYY-MM-DD) while it's in force */
  betaUntil: string | null
  /** the free, open-source desktop build: everything included, no license */
  openEdition: boolean
}

/** The included AI's allowance: a budget over the plan's window (shared/aiCost.ts), in micro-dollars. */
export interface Allowance {
  plan: 'free' | 'trial' | 'plus'
  /** the trial's window, or the current UTC month; null once the trial ended unpaid */
  window: { from: string; to: string } | null
  /** what the window's calls cost so far */
  used: number
  /** null: no AI on this plan */
  budget: number | null
}

/** Whether an asset's value is looked up on the web, and the day of the last attempt. */
export interface ValueLookup {
  enabled: boolean
  lastLookup: string | null
}

/** The build, for Settings → Data and diagnostics. */
export interface AppInfo {
  version: string
  electron: string
  chromium: string
  os: string
  dataPath: string
  logPath: string | null
  /** an update feed is built in and the app is packaged */
  updates: boolean
  /** where Report sends an email of an AI answer (fixed at build time); empty when the build has none */
  supportEmail: string
  /** the web app (docs/hosted-api.md) leaves out the desktop's folders, backups, updater, tray and window; absent is the desktop */
  platform?: 'desktop' | 'web'
}

/**
 * What an update check found: 'off' when there's no feed, 'ready' once a download waits for the next quit, and
 * 'available' where the app can't install an update itself (a Mac build with no Developer ID): `url` is then the
 * page to download it from.
 */
export interface UpdateCheck {
  status: 'off' | 'current' | 'downloading' | 'ready' | 'available' | 'failed'
  /** the newer version, when there is one */
  version: string | null
  /** where to download it, when the app can't install it itself; '' when the feed has no page */
  url?: string
  error?: string
}

export interface ClassifyResult {
  total: number
  fromRules: number
  fromHistory: number
  fromAi: number
  failed: number
  error?: string
}

export interface ClassifyProgress {
  done: number
  total: number
  stage: string
}

/** A bank connected through Plaid (one login; it brings every account there). */
export interface BankConnection {
  itemId: string
  institution: string | null
  /** login_required: the bank asks for a new sign-in (Reconnect); expiring: it will soon; paused: past the plan's banks (waits for Plus) */
  status: 'ok' | 'login_required' | 'expiring' | 'paused'
  lastSyncAt: number | null
}

/** Whether an account is fed by a bank connection (its rows come back on every sync). */
export const isBankFed = (source: Account['source']): boolean => source === 'plaid' || source === 'simplefin'

export interface SyncResult {
  accounts: number
  added: number
  updated: number
  warnings: string[]
  classified?: ClassifyResult
  /** oldest date SimpleFIN history has been fetched back to */
  historyFrom?: number | null
  historyComplete?: boolean
}

export interface CsvMapping {
  date: number
  description: number
  amount: number | null
  debit: number | null
  credit: number | null
  invertSign: boolean
  /** the running balance's column: the latest day's closing balance becomes the account's balance (csvImport.ts) */
  balance?: number | null
}

export interface CsvPreview {
  token: string
  fileName: string
  headers: string[]
  sample: string[][]
  rowCount: number
  guess: CsvMapping
  /** rows the guessed mapping can't read (no date, no description, or an amount that's unreadable or past the cap) */
  unreadable: number
}

export interface CsvImportRequest {
  token: string
  mapping: CsvMapping
  accountId?: string
  newAccountName?: string
  /** into a bank-synced account, also add rows from synced days that the feed is missing */
  merge?: boolean
}

export interface CsvImportResult {
  accountId: string
  imported: number
  skipped: number
  invalid: number
  /** 1 when the file's balance column gave the account a balance, else 0 */
  balances?: number
  classified?: ClassifyResult
}

// ---------- credit ----------

export const CREDIT_BUREAUS = ['Experian', 'Equifax', 'TransUnion'] as const
export type CreditBureau = (typeof CREDIT_BUREAUS)[number]

/** A credit score as seen somewhere (a bank's free score page, a bureau's app), on a day. */
export interface CreditScore {
  id: string
  day: string
  score: number
  bureau: CreditBureau | null
  /** the scoring model: "FICO 8", "VantageScore 3.0" */
  model: string | null
  /** where it was seen: "Chase Credit Journey", "Capital One CreditWise" */
  source: string | null
  note: string | null
}

export type TradelineKind = 'revolving' | 'installment' | 'mortgage' | 'open' | 'collection' | 'other'

/** One account as a bureau reports it. */
export interface CreditTradeline {
  creditor: string
  last4: string | null
  kind: TradelineKind
  opened: string | null
  closed: string | null
  /** as reported: "Open", "Paid, closed", "Transferred" */
  status: string
  limitCents: number | null
  balanceCents: number | null
  /** the app account it is, when there is one */
  accountId: string | null
  /** late marks, e.g. "2023-04: 30 days" */
  late: string[]
}

/** One bureau's report on a day: its accounts, hard inquiries and anything negative. */
export interface CreditReport {
  bureau: CreditBureau
  day: string
  /** the report's file, for opening it */
  file: string | null
  tradelines: CreditTradeline[]
  inquiries: Array<{ creditor: string; day: string }>
  negatives: string[]
  note: string | null
}

export interface CreditView {
  /** newest first */
  scores: CreditScore[]
  /** the newest score from each place a score is followed, and the one before it */
  latest: Array<{ key: string; score: CreditScore; previous: CreditScore | null }>
  /** card balances against their limits, from the synced balances; limits come from reports and statements */
  utilization: {
    balanceCents: number
    limitCents: number
    pct: number | null
    cards: Array<{ accountId: string; name: string; balanceCents: number; limitCents: number | null; pct: number | null; limitSource: string | null; limitAsOf: string | null }>
  }
  /** from the reports' accounts (closed ones count for age), or the app's open dates without a report */
  age: { oldest: { name: string; day: string } | null; averageMonths: number | null; accounts: number }
  /** hard inquiries of the last two years, across bureaus, with the day each stops showing */
  inquiries: Array<{ creditor: string; day: string; bureaus: CreditBureau[]; dropsOff: string }>
  negatives: Array<{ bureau: CreditBureau; text: string }>
  reports: Array<{ bureau: CreditBureau; day: string; file: string | null; found: boolean; open: number; closed: number; inquiries: number; negatives: number; note: string | null; tradelines: Array<CreditTradeline & { accountName: string | null }> }>
  /** the day of the month of the "Check credit score" to-do; null when it's off */
  reminderDay: number | null
}

/** The Credit page's presets for a score typed in. */
export const SCORE_MODELS = ['FICO 8', 'FICO 9', 'VantageScore 3.0', 'VantageScore 4.0'] as const

// ---------- insurance ----------

export const INSURANCE_KINDS = ['auto', 'renters', 'home', 'umbrella', 'health', 'dental', 'vision', 'life', 'disability', 'vehicle', 'device', 'pet', 'travel', 'other'] as const
export type InsuranceKind = (typeof INSURANCE_KINDS)[number]
export type PremiumPeriod = 'month' | 'quarter' | 'half-year' | 'year' | 'one-time'

/** A policy or protection plan the user holds outside work benefits. */
export interface InsurancePolicy {
  id: string
  name: string
  kind: InsuranceKind
  carrier: string | null
  /** a short or partial policy or contract number */
  policyNumber: string | null
  /** what or who it covers: "the car", "Main St apartment" */
  covers: string | null
  status: 'active' | 'ended'
  startDay: string | null
  /** the next (or last known) renewal; it rolls forward by termMonths */
  renewalDay: string | null
  termMonths: number | null
  endDay: string | null
  premiumCents: number | null
  premiumPeriod: PremiumPeriod | null
  /** text in the bank description of its payments, to find them: "crestline" */
  match: string | null
  deductibleCents: number | null
  /** coverages and their limits, in plain words */
  coverage: Array<{ what: string; limit: string }>
  phone: string | null
  claimsPhone: string | null
  website: string | null
  files: Array<{ name: string; file: string }>
  notes: string | null
  source: string | null
}

export interface InsuranceView {
  policies: Array<
    InsurancePolicy & {
      /** the renewal rolled forward to today */
      nextRenewal: string | null
      /** the premium for a year, or what was paid in the last year when the premium isn't known */
      yearlyCents: number | null
      paidLastYearCents: number
      lastPaid: { day: string; cents: number } | null
    }
  >
  /** work benefits from the Benefits page: what each costs per check and a year */
  employer: { name: string | null; plans: Array<{ name: string; kind: BenefitKind; carrier: string | null; perCheckCents: number | null; employerPerCheckCents: number | null; yearlyCents: number | null }> }
  fileFound: Record<string, boolean>
  totals: { yearlyCents: number; active: number; nextRenewal: { name: string; day: string } | null }
}

/** The surface the preload script exposes to the renderer as `window.api`. */
export interface Api {
  getSummary(month: string, buckets?: BucketSelection): Promise<MonthSummary>
  /** Personal (the default) is all of net worth; buckets on their own, just their accounts and assets */
  getNetWorth(buckets?: BucketSelection): Promise<NetWorthSeries>
  /** Home's headline; cached until the underlying numbers change */
  getInsight(opts: { force?: boolean }): Promise<Insight | null>
  listTransactions(q: TxnQuery): Promise<TxnPage>
  updateTransaction(id: string, update: TxnUpdate): Promise<TxnUpdateResult>
  /** removes an imported or manual transaction (a bank-synced row would come back on the next sync) */
  deleteTransaction(id: string): Promise<void>

  listAccounts(): Promise<Account[]>
  updateAccount(id: string, patch: AccountPatch): Promise<void>
  deleteAccount(id: string): Promise<void>
  addAsset(a: NewAsset): Promise<string>

  listBuckets(): Promise<Bucket[]>
  getBucket(id: number): Promise<BucketDetail>
  /** residence dates are no longer set: a home the user lives in is Personal's use of its house (Review's set_asset_use) */
  saveBucket(b: { id?: number; name: string; kind: BucketKind; description?: string; inNetWorth?: boolean }): Promise<number>
  deleteBucket(id: number): Promise<void>
  setTransactionsBucket(ids: string[], bucketId: number | null): Promise<void>
  addBucketRule(r: { bucketId: number; accountId?: string | null; contains?: string | null; amountCents?: number | null; fromDay?: string | null; toDay?: string | null }): Promise<number>
  deleteBucketRule(id: number): Promise<void>
  /** real estate, vehicles and other assets, with linked debts, equity and gain/loss */
  listAssets(): Promise<AssetSummary[]>
  getInvestments(): Promise<Investments>
  /** what's counted in net worth today, grouped: cash, investments, property, owed to you, cards, loans */
  getBalanceSheet(): Promise<BalanceSheet>
  getDebts(): Promise<DebtView>
  getHomePlans(): Promise<HomePlans>
  /**
   * the debt plan's inputs a viewer kept in its own storage before they moved to the debt.plan setting, as stored:
   * the text of its debt.skip and debt.inputs keys, null for a key it doesn't have. They fill debt.plan only while
   * nothing has set it; adopted says whether they did
   */
  adoptDebtPlan(saved: { skip: string | null; inputs: string | null }): Promise<{ adopted: boolean }>
  setOneTime(ids: string[], oneTime: boolean): Promise<void>
  getBenefits(): Promise<BenefitsView>
  getTaxes(): Promise<TaxesView>
  /** opens one of the tax forms on file in its default app */
  openTaxForm(file: string): Promise<void>
  getCredit(): Promise<CreditView>
  /** opens a credit report on file */
  openCreditReport(file: string): Promise<void>
  getInsurance(): Promise<InsuranceView>
  /** opens a policy document on file */
  openInsuranceFile(file: string): Promise<void>
  /** null goes back to automatic */
  setHsa(ids: string[], state: HsaState | null): Promise<void>
  /** key is "<plan>|<free item>"; null clears it */
  setCareDone(key: string, day: string | null): Promise<void>
  /**
   * links a receipt to costs (asking for the file when no path is given); its documents-folder path, or null
   * if cancelled. On the web, path is a fileId from POST /v1/ledger/files, and the answer is the receipt as
   * stored ("<fileId>/<name>", which GET /v1/ledger/files/ opens).
   */
  attachReceipt(ids: string[], path?: string | null): Promise<string | null>
  detachReceipt(ids: string[]): Promise<void>
  /** opens a documents-folder file in its default app */
  openReceipt(name: string): Promise<void>
  /** the path of a file dropped on the page */
  pathForFile(file: File): string
  getAssetHistory(id: string): Promise<AssetHistory>
  /** looks up the asset's current value on the web */
  revalueAsset(id: string): Promise<Valuation>
  getValueLookup(id: string): Promise<ValueLookup>
  /** whether the monthly lookup covers this asset */
  setValueLookup(id: string, enabled: boolean): Promise<void>

  /** reminders plus projected recurring items between two days */
  listCalendar(from: string, to: string): Promise<CalendarItem[]>
  /** whether transfers between your own accounts appear on the calendar (and in Google) */
  getCalendarTransfers(): Promise<boolean>
  setCalendarTransfers(on: boolean): Promise<void>
  /** the calendar's time zone (IANA name); null goes back to the system's */
  getCalendarTimeZone(): Promise<string>
  setCalendarTimeZone(zone: string | null): Promise<void>
  addCalendarEvent(e: { day: string; title: string; notes?: string | null; amountCents?: number | null }): Promise<number>
  updateCalendarEvent(id: number, patch: { day?: string; title?: string; notes?: string | null; amountCents?: number | null }): Promise<void>
  deleteCalendarEvent(id: number): Promise<void>
  /** saves an .ics file of the calendar; returns the path, or null if cancelled */
  exportCalendar(): Promise<string | null>
  googleStatus(): Promise<GoogleCalendarStatus>
  googleSetCredentials(clientId: string, clientSecret: string): Promise<void>
  /** opens Google sign-in in the browser and waits for it */
  googleConnect(): Promise<GoogleCalendarStatus>
  googleDisconnect(): Promise<void>
  googleSync(): Promise<GoogleCalendarStatus>
  /** whether to-dos go to Google Tasks; turning it on without the Tasks scope opens Google sign-in for it */
  googleSetTasks(on: boolean): Promise<GoogleCalendarStatus>
  listBalancePoints(accountId: string): Promise<BalancePoint[]>
  setBalancePoint(accountId: string, day: string, cents: number): Promise<void>
  deleteBalancePoint(accountId: string, day: string): Promise<void>
  /** opens the folder of statements and documents the review assistant can read */
  openDocumentsFolder(): Promise<void>

  listCategories(): Promise<Category[]>
  saveCategory(c: Omit<Category, 'id'> & { id?: number }): Promise<Category>
  deleteCategory(id: number): Promise<void>

  listRules(): Promise<Rule[]>
  addRule(r: { field: RuleField; pattern: string; categoryId: number }): Promise<number>
  deleteRule(id: number): Promise<void>

  getSettings(): Promise<AppSettings>
  setSettings(patch: { provider?: AiProvider; model?: string; routes?: Partial<Record<AiRoute, Partial<RouteConfig>>>; autoClassify?: boolean; hideNumbersOnOpen?: boolean; hiddenVendors?: string[]; lookupValues?: boolean; requestLog?: boolean; aiEnabled?: boolean; aiConsent?: boolean; homeOpen?: HomeOpen | null }): Promise<void>
  setApiKey(key: string): Promise<void>
  clearApiKey(): Promise<void>
  /** one billed call with `key` (before it's saved) or the key in use; kept as the key's last check */
  checkApiKey(key?: string): Promise<KeyCheck>
  /** stores a pasted entitlement token after checking its signature (a server's activate does this itself) */
  setLicenseToken(token: string): Promise<void>
  clearLicenseToken(): Promise<void>
  /** the plan in force */
  getPlan(): Promise<PlanInfo>
  /** starts the 14-day trial: locally at once, and at the server when one is set (its window wins) */
  startTrial(): Promise<PlanInfo>
  /** activates a license key for this computer at the server and keeps the token */
  activateLicense(key: string): Promise<PlanInfo>
  /** frees this computer's activation and drops the token */
  deactivateLicense(): Promise<PlanInfo>
  /** the included AI's allowance, used vs cap, over the plan's window */
  getAllowance(): Promise<Allowance>
  /** whether the chosen AI backend can take calls right now */
  aiStatus(): Promise<AiStatus>
  /** this month's model usage by route */
  getAiUsage(): Promise<AiUsageTotals[]>
  /** the local log of AI requests, newest first, without their bodies */
  listAiRequests(): Promise<AiRequestSummary[]>
  /** one logged request with its body as sent; null when it's gone */
  getAiRequest(id: number): Promise<AiRequestDetail | null>
  /** puts a logged request's body, pretty-printed, on the clipboard */
  copyAiRequest(id: number): Promise<void>
  /** empties the request log */
  clearAiRequests(): Promise<void>
  /** puts a report of an AI answer on the clipboard (the app's version, the feature, its model, the reason, the note and the answer, nothing else); returns its text */
  copyAiReport(report: AiReportInput): Promise<string>
  /** opens an email of the same report to the build's support address (AppInfo.supportEmail) */
  emailAiReport(report: AiReportInput): Promise<void>
  claudeCodeStatus(opts: { force?: boolean }): Promise<ClaudeCodeStatus>
  /** opens a console window running `claude auth login` */
  claudeCodeSignIn(): Promise<void>

  // ---------- Claude Desktop's connector (the open edition and a development build) ----------
  connectorStatus(): Promise<ConnectorStatus>
  /** turns the connector or Allow changes on or off; on again means a new token */
  setConnector(patch: { on?: boolean; allowChanges?: boolean }): Promise<ConnectorStatus>
  /** writes the extension to the home folder and opens it in Claude Desktop, or shows it in its folder */
  installConnector(): Promise<ConnectorInstall>
  /** puts back one change made through the connector */
  undoConnectorChange(id: number): Promise<ConnectorStatus>

  /** opens Plaid's page in the browser and waits for it; null when it closed without a bank */
  bankConnect(): Promise<SyncResult | null>
  bankReconnect(itemId: string): Promise<SyncResult | null>
  bankCancel(): Promise<void>
  bankDisconnect(itemId: string): Promise<void>
  simplefinConnect(setupToken: string): Promise<SyncResult>
  simplefinDisconnect(): Promise<void>
  sync(): Promise<SyncResult>

  classify(opts: { redoAi?: boolean }): Promise<ClassifyResult>
  onClassifyProgress(cb: (p: ClassifyProgress) => void): () => void
  onDataChanged(cb: () => void): () => void
  /** after a sync, import or categorization run finishes (not single edits) */
  onBulkChange(cb: () => void): () => void

  listRecurring(): Promise<RecurringSeries[]>
  /** the ledger's lines over some days with their owners and classes, filtered, newest first */
  linesFor(q: LineQuery, page?: { offset?: number; limit?: number }): Promise<LinePage>
  /** what a house, vehicle or other asset costs to keep a month, by owner; null for any other account */
  carryingCost(assetId: string): Promise<CarryingCost | null>
  /** an asset's use periods (every asset's when none is named): who uses it over which days, and their shares */
  listUses(assetId?: string): Promise<AssetUse[]>
  /** the asset rules that put lines on an asset as its costs */
  listAssetRules(assetId: string): Promise<BucketRule[]>
  /** the transactions (all when none are named) that are an asset's costs, with Personal's share of each */
  lineAssets(ids?: string[]): Promise<LineAsset[]>
  /** the Personal waterfall over a span of months or days: rows, run rates, rates and their changes */
  getWaterfall(span: Span): Promise<Waterfall>
  /** the months' closes, the newest month first and each month's newest version first */
  listSnapshots(limit?: number): Promise<MonthSnapshot[]>
  /** how a closed month differs today from its latest close, and why; null for a month not closed */
  snapshotDiff(month: string): Promise<SnapshotDiff | null>
  /** what can be spent today from each cash account, and the recurring money expected */
  getSpendable(): Promise<Spendable>
  setSpendSettings(patch: { risk?: SpendRisk; cushionCents?: number; accountId?: string | null }): Promise<void>
  listContributions(): Promise<ContributionSummary>
  /** each payroll's checks between two days (YYYY-MM-DD, both included), oldest first: the pay-day table */
  listPayChecks(fromDay: string, toDay: string): Promise<PayCheck[]>
  saveContribution(c: ContributionInput): Promise<number>
  deleteContribution(id: number): Promise<void>

  getReview(): Promise<ReviewState>
  /** null starts a fresh review; attachments are documents-folder names from reviewAttach */
  reviewSend(text: string | null, attachments?: string[]): Promise<ReviewState>
  /** saves a file pasted or dropped into the chat in the documents folder; its documents-folder name */
  reviewAttach(name: string, data: Uint8Array): Promise<string>
  reviewReset(): Promise<void>
  /** runs a queued destructive change; the chat gets its action line */
  approveAction(id: number): Promise<ReviewState>
  discardAction(id: number): Promise<ReviewState>
  /** puts back what a journaled change did (the Undo on an action line) */
  undoChange(id: number): Promise<ReviewState>
  /** brings a skipped issue back into the review */
  unresolveIssue(key: string): Promise<ReviewState>
  deleteFact(id: number): Promise<void>
  onReviewUpdate(cb: (s: ReviewState) => void): () => void
  /** messages from outside the UI, e.g. changes applied through the file bridge */
  onNotify(cb: (text: string) => void): () => void

  /** a CSV, QFX, OFX or QIF file; a statement file comes back as a StatementPreview */
  csvPick(): Promise<ImportPreview | null>
  csvImport(req: CsvImportRequest): Promise<CsvImportResult>
  exportCsv(): Promise<string | null>
  openDataFolder(): Promise<void>
  /** saves a copy of the database where the user chooses; its path, or null if cancelled */
  backupNow(): Promise<string | null>
  /** replaces the database with a chosen backup (the current one is backed up first) and restarts; null if cancelled; needsCode when it was encrypted elsewhere */
  restoreBackup(): Promise<RestoreResult>
  /** carries on the restore that asked for the backup's recovery code; throws on a wrong code */
  restoreBackupCode(code: string): Promise<RestoreResult>
  /** a new recovery code to show; it takes the place of the saved one only once confirmed */
  newRecoveryCode(): Promise<string>
  /** the code just shown, as a PDF where the user chooses; its path, or null if cancelled */
  printRecoveryCode(): Promise<string | null>
  /** the user saved the code just shown: the key is sealed under it, and the old code stops opening it (a code saved before: the key itself changes at the next start, which it offers) */
  confirmRecoveryCode(): Promise<void>
  /** keeps the window out of screenshots, screen sharing and Recall while a recovery code is on it */
  protectWindow(on: boolean): Promise<void>
  /** whether the code is the saved one */
  checkRecoveryCode(code: string): Promise<boolean>
  /** a development build's Encrypted switch; it takes effect when the app restarts (it offers to) */
  setDbEncryption(on: boolean): Promise<void>
  /** the window before the database opens: the recovery code for a key file sealed elsewhere; throws on a wrong code */
  unlockDatabase(code: string): Promise<boolean>
  /** saves every table as one JSON file, secrets left out; its path, or null if cancelled */
  exportAll(): Promise<string | null>
  /** development builds: whether the books can move to an account on the configured server */
  moveAccountStatus(): Promise<MoveAccountStatus>
  /** emails a sign-in code for the account to move into */
  moveAccountSendCode(email: string): Promise<void>
  /** signs in with the code and moves every table and file into the account, which must be empty */
  moveAccountFinish(email: string, code: string): Promise<MoveAccountResult>
  openBackupsFolder(): Promise<void>
  openExternal(url: string): Promise<void>
  getAppInfo(): Promise<AppInfo>
  /** asks the update feed now; 'off' when the build has none */
  checkForUpdates(): Promise<UpdateCheck>
  /** the version, platform, folders and last log lines, to the clipboard */
  copyDiagnostics(): Promise<void>
  /** after two confirmations, deletes the database, backups, logs, transcripts and app-made files, then quits; false if cancelled */
  deleteAllData(): Promise<boolean>

  // ---------- first run, folders, sample data ----------
  /** whether the first-run wizard shows, and what it shows */
  getOnboarding(): Promise<OnboardingState>
  /** records the AI choice made on first run; never calls a model */
  setupAi(mode: AiSetup): Promise<void>
  finishOnboarding(): Promise<void>
  /** sets the documents folder (a dialog asks when null); the folder in use, or null if cancelled */
  setDocumentsDir(path: string | null): Promise<string | null>
  /** opens the documents folder, or one of its subfolders ("Tax") */
  openDocumentFolder(sub?: string): Promise<void>
  /** adds a folder whose documents the app may open and index (a dialog asks when null); the list after, or null if cancelled */
  addDocumentFolder(path: string | null): Promise<string[] | null>
  removeDocumentFolder(path: string): Promise<string[]>
  /** copies files dropped on the window into the documents folder's Other; a CSV comes back as an import preview instead */
  importDocuments(paths: string[]): Promise<DropResult>
  demoStatus(): Promise<DemoStatus>
  loadDemoData(): Promise<DemoResult>
  /** removes the sample data; how many accounts went */
  clearDemoData(): Promise<number>

  // ---------- phone and web viewer (Plus; the status, the device list, Remove and Reset on any plan) ----------
  getSyncStatus(): Promise<SyncStatusView>
  /** a development build's field (a shipped build refuses it); null or empty goes back to FINANCE_TRACKER_RELAY_URL, the build's relay or the hosted service; once paired, a new relay resets the pairing (after a confirmation; null if cancelled) */
  setRelayUrl(url: string | null): Promise<SyncStatusView | null>
  /** a development build's field (a shipped build refuses it) */
  setViewerUrl(url: string | null): Promise<SyncStatusView>
  /** creates the mailbox at the relay when there is none; a one-time code (ten minutes, one device) for a phone, or the viewer link */
  startPairing(which: 'phone' | 'viewer'): Promise<SyncPairing>
  /** puts the viewer link showing now on the clipboard, cleared again after a minute */
  copySyncPairing(which: 'viewer'): Promise<void>
  /** the phones and viewers the relay lists for the mailbox */
  listSyncDevices(): Promise<SyncDeviceView[]>
  /** the row as the table showed it: the relay must still list that key and role */
  approveSyncDevice(device: { deviceId: string; devicePub: string; role: string }): Promise<SyncDeviceView[]>
  /** removes it here at once; one that held the keys gives the rest new ones */
  removeSyncDevice(deviceId: string): Promise<SyncDeviceView[]>
  /** after a confirmation: a new mailbox and keys; null if cancelled */
  resetSync(): Promise<SyncStatusView | null>
  /** takes the phone's commands and publishes now */
  syncNow(): Promise<SyncStatusView>

  // ---------- splits and tags ----------
  /** splits a transaction into two or more parts that add up to it exactly; replaces an earlier split */
  splitTransaction(id: string, parts: SplitPart[]): Promise<void>
  /** back to one part in the transaction's own category */
  unsplitTransaction(id: string): Promise<void>
  /** the tags in use, as first typed, most used first */
  listTags(): Promise<TagCount[]>
  addTags(ids: string[], tags: string[]): Promise<void>
  removeTags(ids: string[], tags: string[]): Promise<void>

  // ---------- savings goals ----------
  /** every goal with its progress, archived ones too */
  listGoals(): Promise<GoalView[]>
  /** creates (no id) or updates a goal; its id */
  saveGoal(g: GoalInput): Promise<number>
  archiveGoal(id: number, archived: boolean): Promise<void>
  deleteGoal(id: number): Promise<void>
  addGoalContribution(goalId: number, c: { day: string; cents: number; note?: string | null }): Promise<number>
  deleteGoalContribution(id: number): Promise<void>

  // ---------- credit scores ----------
  /** records a score typed on the Credit page; the same bureau, model and source on the same day replaces it */
  addCreditScore(s: { day: string; score: number; bureau: CreditBureau; model: string; source?: string | null }): Promise<CreditScore>
  deleteCreditScore(id: string): Promise<void>
  /** the monthly "Check credit score" to-do on that day of the month (1-31, the month's last day when shorter); null removes it */
  setCreditReminder(day: number | null): Promise<void>

  // ---------- statement files (QFX, OFX, QIF) ----------
  /** imports a previewed QFX, OFX or QIF file, one target per statement in it */
  statementImport(req: StatementImportRequest): Promise<StatementImportResult>

  // ---------- the hosted ledger (docs/hosted-api.md): files come in by upload, POST /v1/ledger/files ----------
  /** an uploaded CSV, QFX, OFX or QIF, ready for the import dialog (what csvPick answers after its dialog) */
  importPreview(fileId: string): Promise<ImportPreview>
  /** keeps an uploaded file as a document for the AI to read (Plus) */
  addDocument(fileId: string): Promise<{ ok: true }>
  /** asks the account's Ledger to sync its banks now */
  bankSync(): Promise<SyncResult>

  // ---------- notifications and the tray (every plan) ----------
  getNotificationSettings(): Promise<NotificationSettings>
  setNotificationSettings(patch: NotificationPatch): Promise<NotificationSettings>
  /** the sidebar's eye: while it's on, notifications mask their amounts */
  setNumbersHidden(on: boolean): Promise<void>
  /** a notification was clicked: the page it is about */
  onOpenPage(cb: (target: OpenPageTarget) => void): () => void

  // ---------- alerts: the hosted ledger's push, text and email (every plan) ----------
  getAlertPrefs(): Promise<AlertPrefs>
  setAlertPrefs(patch: AlertPrefsPatch): Promise<AlertPrefs>

  // ---------- display ----------
  /** saves the theme and applies it to the window (nativeTheme) */
  setTheme(theme: ThemeChoice): Promise<void>
}

// ---------- phone and web viewer ----------

/** setting: Settings → Devices (a development build) or the paired mailbox's; env: the variable as the app runs; build: the variable as the app was built; server: the hosted service */
export type SyncUrlSource = 'setting' | 'env' | 'build' | 'server'

export interface SyncStatusView {
  paired: boolean
  /** the 6 digits the web viewer shows for this desktop before it pairs with a new link */
  desktopCode: string | null
  /** the paired mailbox's relay, else the one pairing would use */
  relayUrl: string | null
  relayFrom: SyncUrlSource | null
  viewerUrl: string | null
  viewerFrom: SyncUrlSource | null
  /** a development build: the Relay and Web viewer fields show, and what's saved in them comes first */
  urlsEditable: boolean
  lastPublishedAt: string | null
  /** the last snapshot envelope's size */
  lastBytes: number | null
  /** the last command from the phone that ran: when, and its line in the Review chat */
  lastCommand: { at: string; text: string } | null
  lastError: { at: string; text: string } | null
  /** a sync step is running */
  running: boolean
}

export interface SyncPairing {
  which: 'phone' | 'viewer'
  /** the QR code: the one-time code, or the viewer link (<viewerUrl>/#pair=…) */
  svg: string
  /** ISO; the code pairs one device until then */
  expiresAt: string
}

export interface SyncDeviceView {
  deviceId: string
  name: string
  role: 'phone' | 'viewer' | string
  /** raw Ed25519 key, base64url: sent back with Approve */
  devicePub: string
  /** the 6 digits the device itself shows while it waits */
  code: string
  /**
   * approved: by this desktop, with the key the relay lists; waiting: it holds a code shown here in the last ten minutes;
   * nocode: it doesn't (expired, or never shown here); twice: two devices used one code; changed: the relay lists another key or role than the one approved
   */
  state: 'approved' | 'waiting' | 'nocode' | 'twice' | 'changed'
  createdAt: string | null
  lastSeen: string | null
}

// ---------- first run, folders, sample data ----------

/** The AI choice on first run: the included trial, the user's own key, the Claude Code CLI (dev builds), no AI at all, or none yet. */
export type AiSetup = 'trial' | 'key' | 'claude-code' | 'none' | 'later'

export interface OnboardingState {
  /** show the wizard: not finished, and no accounts */
  needed: boolean
  appName: string
  /** database, backups and logs */
  dataDir: string
  /** statements, paystubs and the rest; indexed for the AI */
  docsDir: string
  /** set by the environment for this run, so it can't be changed here */
  docsDirLocked: boolean
  folders: string[]
  /** other folders whose documents the app may open and index */
  extraDirs: string[]
  accounts: number
  ai: AiSetup | null
  plan: PlanInfo
  demo: DemoStatus
  /** encrypted, and no recovery code saved yet: the last step (or, after the wizard, a window) shows one */
  recoveryPending: boolean
}

export interface DropResult {
  /** documents-folder paths of the copies ("Other/x.pdf") */
  saved: string[]
  /** already in the folder (same content, or inside it already) */
  skipped: string[]
  /** not a document type the app opens, too big, or unreadable */
  rejected: string[]
  /** the first dropped CSV, QFX, OFX or QIF, ready for the import dialog */
  csv: ImportPreview | null
}

export interface DemoStatus {
  loaded: boolean
  loadedAt: string | null
}

export interface DemoResult {
  accounts: number
  transactions: number
}

// ---------- splits and tags ----------

/** One part of a split transaction: its own amount (signed like the transaction), category, venture and one-off flag. */
export interface TxnSplit {
  id: number
  amountCents: number
  categoryId: number | null
  /** null = Personal */
  bucketId: number | null
  oneTime: boolean
  note: string | null
}

/** A part as the Split editor saves it. */
export interface SplitPart {
  amountCents: number
  categoryId: number | null
  /** null = Personal */
  bucketId?: number | null
  oneTime?: boolean
  note?: string | null
}

export interface TagCount {
  tag: string
  count: number
}

// ---------- savings goals ----------

/** accounts: the linked accounts' combined balance (less a start); manual: a log of contributions */
export type GoalFunding = 'accounts' | 'manual'

/** The accounts a goal can count: ones that hold money. */
export const GOAL_ACCOUNT_TYPES: readonly AssetType[] = ['cash', 'investment', 'retirement']

export interface Goal {
  id: number
  name: string
  targetCents: number
  /** YYYY-MM-DD to reach it by; null for none */
  targetDay: string | null
  funding: GoalFunding
  accountIds: string[]
  /** the linked accounts' balance on startDay, left out of the progress; null counts the whole balance */
  startCents: number | null
  startDay: string | null
  createdAt: number
  archivedAt: number | null
}

export interface GoalContribution {
  id: number
  goalId: number
  day: string
  /** money in positive, a withdrawal negative */
  cents: number
  note: string | null
}

/** done: reached; on_track: the pace covers what's needed a month; behind: it doesn't; past_due: the date went by short; open: no date */
export type GoalStatus = 'done' | 'on_track' | 'behind' | 'past_due' | 'open'

export interface GoalView extends Goal {
  accounts: Array<{ id: string; name: string; balanceCents: number | null }>
  /** newest first */
  contributions: GoalContribution[]
  savedCents: number
  remainingCents: number
  /** saved / target, not capped */
  pct: number
  /** whole months to the date (at least 1); null without a date or once it's past */
  monthsLeft: number | null
  /** what's still needed a month to make the date; all of it once past; null without a date */
  monthlyNeededCents: number | null
  /** saved a month over the last three months */
  paceCents: number
  status: GoalStatus
}

export interface GoalInput {
  id?: number
  name: string
  targetCents: number
  targetDay: string | null
  funding: GoalFunding
  accountIds?: string[]
  /** accounts: count only what's saved from today (a goal that already counts from a day keeps that day) */
  fromNow?: boolean
}

// ---------- statement files (QFX, OFX, QIF) ----------

/** One account's statement in a file. */
export interface StatementAccountPreview {
  kind: 'bank' | 'card'
  /** the account number's last 4 (OFX); QIF has none */
  last4: string | null
  /** Checking, Savings, Credit card, or a QIF account's name */
  label: string | null
  rowCount: number
  /** first and last posted, Unix seconds */
  from: number | null
  to: number | null
  /** the closing balance as the file signs it, and its day (YYYY-MM-DD) */
  balanceCents: number | null
  balanceDay: string | null
  /** rows with no readable date or amount, or in another currency */
  unreadable: number
  /** the signs look reversed (charges positive); the dialog's flip starts on */
  invertSign: boolean
  /** the account this statement went into last time, if it's still here */
  matchId: string | null
  /** a name for a new account */
  suggestedName: string
  /** the first rows, signed as the file has them */
  sample: Array<{ posted: number; description: string; amountCents: number }>
}

export interface StatementPreview {
  kind: 'statement'
  token: string
  fileName: string
  /** QFX, OFX or QIF */
  format: string
  institution: string | null
  accounts: StatementAccountPreview[]
}

export type ImportPreview = CsvPreview | StatementPreview

export const isStatementPreview = (p: ImportPreview): p is StatementPreview => 'kind' in p && p.kind === 'statement'

/** Where one statement goes: an account, a new one (no accountId), or nowhere (null). */
export interface StatementTarget {
  accountId?: string
  newAccountName?: string
  invertSign?: boolean
}

export interface StatementImportRequest {
  token: string
  /** one per statement in the file, in its order */
  targets: Array<StatementTarget | null>
  /** into a bank-synced account, also add rows from synced days that the feed is missing */
  merge?: boolean
}

export interface StatementImportResult {
  accountIds: string[]
  imported: number
  skipped: number
  invalid: number
  /** closing balances recorded */
  balances: number
  classified?: ClassifyResult
}

// ---------- notifications and the tray ----------

/** What the desktop notifies about, each with its own switch in Settings → Notifications. */
export const NOTIFY_KINDS = ['bill_due', 'large_purchase', 'new_merchant', 'possible_duplicate', 'feed_behind', 'credit_reminder', 'price_change'] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]

export const NOTIFY_KIND_LABELS: Record<NotifyKind, string> = {
  bill_due: 'Bill due in 3 days',
  large_purchase: 'Large purchase',
  new_merchant: 'New merchant',
  possible_duplicate: 'Possible double charge',
  feed_behind: 'Bank feed behind',
  credit_reminder: 'Credit score reminder',
  price_change: 'Price change'
}

export interface NotificationSettings {
  /** closing the window leaves the app in the tray (default on in a shipped build, off in a development build) */
  keepRunning: boolean
  /** starts at sign-in, in the tray (a shipped build outside the Store) */
  openAtLogin: boolean
  loginOffered: boolean
  kinds: Record<NotifyKind, boolean>
  /** local 'HH:MM'; null when off */
  quietHours: { start: string; end: string } | null
  /** unix seconds; null when not paused */
  pausedUntil: number | null
}

export interface NotificationPatch {
  keepRunning?: boolean
  openAtLogin?: boolean
  kinds?: Partial<Record<NotifyKind, boolean>>
  quietHours?: { start: string; end: string } | null
  /** minutes from now; 0 resumes */
  pauseMinutes?: number
}

/** Where a clicked notification opens the window. */
export interface OpenPageTarget {
  page: 'transactions' | 'calendar' | 'credit' | 'accounts' | 'recurring' | 'dashboard'
  /** transactions: the search box and the month */
  search?: string
  month?: string
}

// ---------- alerts (the hosted ledger: push, text and email) ----------

/** What the hosted ledger alerts on; `kind` on the wire (docs/hosted-api.md, "Push"). */
export const ALERT_KINDS = ['shortfall', 'overdraw', 'bill_due', 'renewal', 'large_charge', 'new_merchant', 'double_charge', 'price_change', 'credit_reminder', 'bank_signin'] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  shortfall: 'Short before payday',
  overdraw: 'Overdraw tomorrow',
  bill_due: 'Bill due',
  renewal: 'Subscription renews',
  large_charge: 'Large charge',
  new_merchant: 'New merchant',
  double_charge: 'Possible double charge',
  price_change: 'Price change',
  credit_reminder: 'Credit score reminder',
  bank_signin: 'Bank asks you to sign in'
}

/** What a text alert can be answered with (POST /v1/sms/inbound): renewal reminders take HOW (how to cancel) and KEEP, the overdraw alert DONE. Not CANCEL: carriers read it as STOP. */
export const TEXT_REPLIES = ['HOW', 'KEEP', 'DONE'] as const
export type TextReply = (typeof TEXT_REPLIES)[number]

/** The line shown at the text-message switch; turning texts on records it with the time (setAlertPrefs' smsConsent). */
export const SMS_CONSENT_LINE = 'Texts are account alerts. Frequency varies. Message and data rates may apply. Reply STOP to end.'

/** Where an alert goes: the account's devices, a text to its verified phone, an email to its address. */
export const ALERT_CHANNELS = ['push', 'sms', 'email'] as const
export type AlertChannel = (typeof ALERT_CHANNELS)[number]

/** Each kind's own thresholds, where one makes sense. */
export interface AlertThresholds {
  /** under this balance before payday counts as short; null: Spendable's cushion */
  shortfall: { cushionCents: number | null; days: number | null }
  /** tomorrow's bills taking the main account under this; null: Spendable's cushion (zero without one) */
  overdraw: { cushionCents: number | null }
  /** from this many days ahead (0-14) */
  bill_due: { days: number }
  /** yearly subscriptions this many days before they renew (1-14); monthly ones too when `monthly` */
  renewal: { days: number; monthly: boolean }
  /** a charge of at least this; null: the review's rule (large for you) */
  large_charge: { minCents: number | null }
  /** a first charge at a merchant of at least this */
  new_merchant: { minCents: number }
  double_charge: Record<never, never>
  price_change: Record<never, never>
  credit_reminder: Record<never, never>
  bank_signin: Record<never, never>
}

/** One kind: on or off, its channels (none: nowhere) and its thresholds. shortfall's `days`: only when the short day is that close (1-45); null: anywhere before the next payday. */
export type AlertKindPrefs<K extends AlertKind = AlertKind> = { on: boolean; channels: AlertChannel[] } & AlertThresholds[K]

export interface AlertPrefs {
  /** dollar amounts in the text (off by default: the services that carry an alert can read it) */
  showAmounts: boolean
  kinds: { [K in AlertKind]: AlertKindPrefs<K> }
  /** 'HH:MM' on the account's clock (across midnight when the end comes first); null when off */
  quietHours: { start: string; end: string } | null
  /** unix seconds; null when not paused */
  pausedUntil: number | null
  /** when texts were agreed to (unix seconds) and the line shown, or the START reply; null until then, and again after STOP */
  smsConsent: { at: number; line: string } | null
  /** the line to show at the text-message switch (SMS_CONSENT_LINE) */
  smsConsentLine: string
}

export interface AlertPrefsPatch {
  showAmounts?: boolean
  kinds?: { [K in AlertKind]?: Partial<AlertKindPrefs<K>> }
  quietHours?: { start: string; end: string } | null
  /** minutes from now; 0 resumes */
  pauseMinutes?: number
  /** the consent line shown at the switch, sent with the change that turns texts on (needed while smsConsent is null) */
  smsConsent?: string
}

// ---------- display ----------

export const THEMES = ['system', 'light', 'dark'] as const
export type ThemeChoice = (typeof THEMES)[number]
