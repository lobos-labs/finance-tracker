// Plaid's personal-finance categories mapped to the app's, for a row the AI
// won't see (no plan, or the AI switched off) that no rule or earlier payment
// covers. The most specific code wins; a primary code covers the rest of its
// family. https://plaid.com/documents/pfc-taxonomy-all.csv

const DETAILED: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  FOOD_AND_DRINK_COFFEE: 'Coffee',
  TRANSPORTATION_GAS: 'Gas & Fuel',
  RENT_AND_UTILITIES_RENT: 'Housing',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'Housing',
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: 'Housing',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Transfers',
  LOAN_PAYMENTS_CAR_PAYMENT: 'Transfers',
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: 'Transfers',
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: 'Education',
  INCOME_WAGES: 'Paycheck',
  TRANSFER_OUT_WITHDRAWAL: 'Cash & ATM',
  GENERAL_SERVICES_INSURANCE: 'Insurance',
  GENERAL_SERVICES_EDUCATION: 'Education',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'Pets',
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'Fitness',
  ENTERTAINMENT_TV_AND_MOVIES: 'Subscriptions',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'Subscriptions',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'Gifts & Donations',
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'Taxes',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'Gifts & Donations',
  MEDICAL_VETERINARY_SERVICES: 'Pets'
}

const PRIMARY: Record<string, string> = {
  INCOME: 'Other Income',
  TRANSFER_IN: 'Transfers',
  TRANSFER_OUT: 'Transfers',
  LOAN_PAYMENTS: 'Transfers',
  BANK_FEES: 'Fees & Interest',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Dining Out',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Housing',
  MEDICAL: 'Health & Medical',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Other',
  GOVERNMENT_AND_NON_PROFIT: 'Other',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Utilities'
}

/** The app's category name for a Plaid category, or null when Plaid gave none. */
export function plaidCategory(pfc: { primary?: string | null; detailed?: string | null } | null | undefined): string | null {
  if (!pfc) return null
  return (pfc.detailed && DETAILED[pfc.detailed]) || (pfc.primary && PRIMARY[pfc.primary]) || null
}

/** Streaming, music and the gym: Plaid's nearest to a subscription. */
const SUBSCRIPTIONS = new Set(['ENTERTAINMENT_TV_AND_MOVIES', 'ENTERTAINMENT_MUSIC_AND_AUDIO', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'])

/**
 * What Plaid's category says a charge is when it's paid every month: rent,
 * utilities and the phone, and insurance are bills; any loan payment (a
 * card's too) a loan; streaming, music and the gym subscriptions. Null for
 * anything else.
 */
export function plaidBill(pfc: { primary?: string | null; detailed?: string | null } | null | undefined): 'bill' | 'loan' | 'subscription' | null {
  const primary = pfc?.primary ?? ''
  const detailed = pfc?.detailed ?? ''
  if (primary === 'RENT_AND_UTILITIES' || detailed.startsWith('RENT_AND_UTILITIES_') || detailed === 'GENERAL_SERVICES_INSURANCE') return 'bill'
  if (primary === 'LOAN_PAYMENTS' || detailed.startsWith('LOAN_PAYMENTS_')) return 'loan'
  return SUBSCRIPTIONS.has(detailed) ? 'subscription' : null
}
