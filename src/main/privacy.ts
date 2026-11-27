import * as db from './db'

// Privacy: vendors the user doesn't want called out (never named in habits, lists or
// insights; their spending still counts in totals and the transaction list), and whether
// numbers start hidden when the app opens.

const VENDORS = 'privacy.hiddenVendors'
const HIDE_NUMBERS = 'privacy.hideNumbersOnOpen'

/** A hidden name this long or longer may match inside a word ("acme store" in "ACME STORE #12 PAYMENT"); shorter ones match whole words only. */
export const SUBSTRING_MIN = 6

export function hiddenVendors(): string[] {
  try {
    const list = JSON.parse(db.getSetting(VENDORS) ?? '[]') as unknown
    return Array.isArray(list) ? list.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export function setHiddenVendors(list: string[]): string[] {
  const clean = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  db.setSetting(VENDORS, JSON.stringify(clean))
  return clean
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a merchant name is one of the hidden vendors, ignoring case: a short
 * hidden name ("Acme") matches as a whole word, so it can't hide every
 * merchant that happens to contain its letters; a longer one matches anywhere.
 */
export function vendorHider(list = hiddenVendors()): (merchant: string | null | undefined) => boolean {
  const tests = list.map((name) => {
    const n = name.toLowerCase()
    if (n.length >= SUBSTRING_MIN) return (m: string): boolean => m.includes(n)
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(n)}(?=[^a-z0-9]|$)`)
    return (m: string): boolean => re.test(m)
  })
  return (merchant) => !!merchant && tests.length > 0 && tests.some((t) => t(merchant.toLowerCase()))
}

export const hideNumbersOnOpen = (): boolean => db.getSetting(HIDE_NUMBERS) === '1'
export const setHideNumbersOnOpen = (on: boolean): void => db.setSetting(HIDE_NUMBERS, on ? '1' : '0')
