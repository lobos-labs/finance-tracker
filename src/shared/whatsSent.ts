import { AI_ROUTE_LABELS, type AiRequestRoute } from './types'

// What each AI feature sends, field by field: the one list Settings → AI
// → What's sent shows, and that README.md ("What each feature sends") and
// docs/legal/privacy-policy.md (2.1, and the website's copy) repeat word for
// word (test/whats-sent.test.ts holds them to it). When a prompt changes what
// it sends (classifier.ts, insights.ts, review.ts and tools.ts, valuation.ts,
// documents.ts, ai/keyCheck.ts), change it here and in those documents too.
// Each field is written to read after the feature's name; the panel
// capitalizes the first letter. claudeCode lists are for development builds
// and stay out of the documents. The key check of an Anthropic key of the
// user's own is the desktop's alone (DESKTOP_SENT: the
// product's AI runs on the service's key only), so it stays out of them too.

export interface SentFeature {
  route: AiRequestRoute
  label: string
  fields: readonly string[]
  /** what Claude Code mode (development builds only) sends besides; the panel shows it where that mode is offered */
  claudeCode?: readonly string[]
}

export const WHATS_SENT: readonly SentFeature[] = [
  {
    route: 'categorize',
    label: AI_ROUTE_LABELS.categorize,
    fields: [
      'up to 40 transactions at a time that no rule or earlier answer covers',
      "each one's description, with runs of four or more digits taken out",
      'its signed amount',
      "the kind of account it's in (cash, credit card, loan), not the account's name",
      'your category names, kinds and hints',
      'up to 80 of your rules, as examples',
      'your remembered facts'
    ]
  },
  {
    route: 'headline',
    label: AI_ROUTE_LABELS.headline,
    fields: [
      "today's date and how many months of history there are",
      "this month's spending and income by category, and your usual pace by this day",
      "the last three months' spending and income",
      "this month's largest purchases, new merchants and most frequent merchants, leaving out hidden vendors",
      'recurring charges, and bills due in the next 10 days',
      'net worth and its 30, 90 and 365-day change',
      "what's owed on each card and loan, by account name, and a payoff plan",
      'the investment total and its 30-day change',
      'accounts whose bank feed is behind, by name',
      'trips within six weeks of today',
      "how many of this month's transactions are uncategorized",
      'your remembered facts',
      'the last few headlines'
    ]
  },
  {
    route: 'review',
    label: AI_ROUTE_LABELS.review,
    fields: [
      'your messages, and the names of files you attach',
      "today's date, your category names, your ventures' names, kinds and residence dates, and your remembered facts",
      'what its tools look up as it works: open items, transactions with their notes and tags, spending totals, recurring items, accounts with their names and balances, assets and loans, investments, taxes, benefits, insurance, credit, trips, habits, goals and calendar entries',
      'the names of files in the documents folder, not their full paths',
      'web searches the model runs, up to 5 per request; answering one message can take several requests'
    ],
    claudeCode: ['the full paths of files in the documents folder, which the CLI opens itself']
  },
  {
    route: 'valuation',
    label: AI_ROUTE_LABELS.valuation,
    fields: [
      "the asset's name and kind, where it is or who holds it, and its notes (an address, mileage or VIN, say)",
      'when it was bought and for how much, and its last six values',
      'web searches: only home-value sites for a house, only listing sites for a vehicle, and the whole web for any other asset you look up'
    ]
  },
  {
    route: 'documents',
    label: AI_ROUTE_LABELS.documents,
    fields: ['a file the assistant opens: a PDF as a document, a picture as an image, a text file in pages of 12,000 characters', 'its name in the documents folder']
  },
]

/** What the desktop (on the user's own computer, with its own API key) sends besides; its panel shows these, the web's doesn't. */
export const DESKTOP_SENT: readonly SentFeature[] = [
  {
    route: 'keyCheck',
    label: 'Key check',
    fields: ['the word "Hi" to Claude Haiku 5.5, for one output token']
  }
]

/** A logged request's feature, as the log's table names it. */
export const requestLabel = (route: string): string => [...WHATS_SENT, ...DESKTOP_SENT].find((f) => f.route === route)?.label ?? route
