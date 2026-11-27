// The product's name, kept in one place until the real one is chosen. Nothing
// else spells it out: folders, titles and the wizard all read this constant.

export const APP_NAME = 'Finance Tracker'

/** Said at onboarding, in Settings and beside payoff plans (docs/legal/disclaimer.md has the full text). */
export const NOT_ADVICE = `${APP_NAME} analyzes your own data. It is not financial, tax, investment or legal advice.`
/**
 * The terms and the privacy notice, linked from Welcome, onboarding and Settings: the public repository's LICENSE
 * (AGPL-3.0-or-later) and PRIVACY.md, until the app has its own domain, which will redirect.
 */
export const PUBLIC_REPO = 'https://github.com/lobos-labs/finance-tracker'
export const LEGAL_LINKS = { terms: `${PUBLIC_REPO}/blob/main/LICENSE`, privacy: `${PUBLIC_REPO}/blob/main/PRIVACY.md` } as const

/**
 * The consent line the hosted apps show before the service's AI first runs for an account (Apple's 5.1.2(i):
 * name the third-party AI and ask; docs/legal/app-store-privacy.md A.4), with Allow and Not now. The phone keeps
 * the same words (finance-mobile/lib/ui/settings/ai_consent.dart); a new wording bumps AI_CONSENT_VERSION.
 */
export const AI_CONSENT_LINE = "The AI features send what each task needs from your books to Anthropic, which runs the AI. Anthropic doesn't train on it."

/** Said under the Review chat (Anthropic's Commercial Terms D.3: users are told to check factual statements before relying on them). */
export const AI_NOT_ADVICE = 'AI analysis of your own data, not financial advice. Check its facts independently before relying on them.'

/** The documents folder's subfolders, in the order they're listed. The index walks the whole folder; these are for people. */
export const DOC_FOLDERS = ['Statements', 'Paystubs', 'Tax', 'Insurance', 'Credit', 'Receipts', 'Other'] as const
export type DocFolder = (typeof DOC_FOLDERS)[number]

/** The one line said beside the recovery code: how far the key file opens without it (src/main/dbopen.ts keySealScope). */
export const RECOVERY_LINE = {
  account: 'Without it, a backup opens only on this computer, in this user account.',
  install: 'Without it, a backup opens only in this installation of the app.'
} as const
