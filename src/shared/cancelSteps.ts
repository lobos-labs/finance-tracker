// How to cancel common subscriptions, for the answer to a renewal text's
// HOW (finance-server/src/sms) and anywhere else a series is named. Only
// the company's own page or its own steps: never a third-party "cancel for
// you" service. A name not on the list gets the generic line. Checked
// 2026-11-03; a page that moves is fixed here.

export interface CancelSteps {
  /** the subscription as people say it */
  name: string
  /** matched against a recurring series' name (the merchant), case-insensitively */
  match: RegExp
  /** the company's own cancel or membership page */
  url?: string
  /** the steps, where the company has no page that cancels on the web */
  steps?: string
}

export const CANCEL_STEPS: CancelSteps[] = [
  { name: 'Netflix', match: /netflix/i, url: 'https://www.netflix.com/cancelplan' },
  { name: 'Spotify', match: /spotify/i, url: 'https://www.spotify.com/account/' },
  { name: 'Hulu', match: /hulu/i, url: 'https://secure.hulu.com/account' },
  { name: 'Disney+', match: /disney\s*(\+|plus)/i, url: 'https://www.disneyplus.com/account' },
  { name: 'YouTube Premium', match: /youtube|google\s*\*?\s*youtube/i, url: 'https://www.youtube.com/paid_memberships' },
  { name: 'Google Play', match: /google\s*\*?\s*(play|one|storage)/i, url: 'https://play.google.com/store/account/subscriptions' },
  { name: 'Amazon Prime', match: /amazon\s*prime|prime\s*video|amzn\s*prime/i, url: 'https://www.amazon.com/mc' },
  { name: 'Apple', match: /apple\.com\/bill|apple\s*(music|tv|one|arcade|icloud)|itunes|icloud/i, steps: 'iPhone: Settings > your name > Subscriptions, then the subscription > Cancel' },
  { name: 'Microsoft', match: /microsoft|xbox|msft\s*\*|office\s*365|m365/i, url: 'https://account.microsoft.com/services' },
  { name: 'Adobe', match: /adobe/i, url: 'https://account.adobe.com/plans' },
  { name: 'Dropbox', match: /dropbox/i, url: 'https://www.dropbox.com/account/plan' },
  { name: 'Paramount+', match: /paramount/i, url: 'https://www.paramountplus.com/account/' },
  { name: 'Walmart+', match: /walmart\s*(\+|plus)/i, url: 'https://www.walmart.com/plus/account' },
  { name: 'PlayStation Plus', match: /playstation|sony\s*interactive|psn/i, steps: 'PlayStation: Settings > Users and Accounts > Account > Payment and Subscriptions > Subscriptions' },
  { name: 'DoorDash DashPass', match: /dashpass|doordash/i, steps: 'DoorDash app: Account > DashPass > End subscription' },
  { name: 'Uber One', match: /uber\s*one/i, steps: 'Uber app: Account > Uber One > Manage membership > End membership' }
]

/** The known subscription a series' name is, or null. */
export const cancelStepsFor = (name: string): CancelSteps | null => CANCEL_STEPS.find((c) => c.match.test(name)) ?? null

/** One line: where or how to cancel `name`; the generic line for one not on the list. */
export function cancelLine(name: string): string {
  const c = cancelStepsFor(name)
  if (!c) return `${name}: cancel in its app or on its website under Account or Billing, or call the number on your statement.`
  return `${c.name}: ${c.url ?? c.steps}`
}
