// What a category is for, from its name. Logic that needs "the dining
// category" or "the paycheck category" asks for the role instead of comparing
// names, so a renamed category keeps working. Names match case-insensitively
// with a few synonyms per role; a real role column is a later change.

export type CategoryRole =
  | 'dining'
  | 'coffee'
  | 'groceries'
  | 'fuel'
  | 'auto'
  | 'housing'
  | 'utilities'
  | 'insurance'
  | 'health'
  | 'subscriptions'
  | 'cash'
  | 'fees'
  | 'taxes'
  | 'paycheck'
  | 'returns'
  | 'transfers'

const SYNONYMS: Record<CategoryRole, string[]> = {
  dining: ['Dining Out', 'Dining', 'Restaurants', 'Eating Out', 'Food & Drink', 'Takeout'],
  coffee: ['Coffee', 'Coffee Shops', 'Cafes', 'Coffee & Tea'],
  groceries: ['Groceries', 'Grocery', 'Supermarket', 'Food'],
  fuel: ['Gas & Fuel', 'Gas', 'Fuel', 'Gas Stations', 'EV Charging'],
  // Keeping a car: its service and repairs (Transportation, which also holds rides and transit, isn't one).
  auto: ['Auto & Transport', 'Auto Maintenance', 'Car Maintenance', 'Auto Repair'],
  housing: ['Housing', 'Rent', 'Mortgage', 'Rent & Mortgage', 'Home'],
  utilities: ['Utilities', 'Utility', 'Bills & Utilities'],
  insurance: ['Insurance'],
  health: ['Health & Medical', 'Health', 'Medical', 'Healthcare', 'Doctor'],
  subscriptions: ['Subscriptions', 'Subscription', 'Memberships', 'Streaming'],
  cash: ['Cash & ATM', 'Cash', 'ATM'],
  fees: ['Fees & Interest', 'Fees', 'Interest', 'Bank Fees'],
  taxes: ['Taxes', 'Tax', 'Income Tax'],
  paycheck: ['Paycheck', 'Paychecks', 'Salary', 'Wages', 'Payroll', 'Pay'],
  // Interest and dividends paid on cash: a return on money kept, not pay.
  returns: ['Interest Income', 'Interest Earned', 'Dividends'],
  transfers: ['Transfers', 'Transfer']
}

/** "Fees & Interest", "fees and interest" and "Fees/Interest" all become "fees interest". */
const normalize = (name: string): string =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== 'and')
    .join(' ')

const BY_NAME = new Map<string, CategoryRole>()
for (const [role, names] of Object.entries(SYNONYMS) as Array<[CategoryRole, string[]]>) for (const n of names) BY_NAME.set(normalize(n), role)

/** The role a category name plays, or null for a category the app has no special logic for. */
export function categoryRole(name: string | null | undefined): CategoryRole | null {
  if (!name) return null
  return BY_NAME.get(normalize(name)) ?? null
}

/** The first of `names` with the role, or null. */
export function nameWithRole(names: Iterable<string>, role: CategoryRole): string | null {
  for (const n of names) if (categoryRole(n) === role) return n
  return null
}
