import type { Api, AppSettings, ClassifyResult } from '../../shared/types'
import { featureLabel, FEATURES, hasFeature, type FeatureId } from '../../shared/plans'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api

let platform: 'desktop' | 'web' = 'desktop'
/** The web app (getAppInfo().platform, set by its entry before the app loads): the desktop's folders, backups, updater, tray and window aren't there. */
export const onWeb = (): boolean => platform === 'web'
export function setPlatform(p: 'desktop' | 'web'): void {
  platform = p
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const moneyRound = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const moneyCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

let hidden = false
/** Numbers hidden (the eye in the sidebar): every number draws as "•••" (styles.css), and amounts drop the K or M that would give their size away. */
export function setNumbersHidden(on: boolean): void {
  hidden = on
  document.documentElement.classList.toggle('numbers-hidden', on)
}
/** Whether numbers are hidden now, for a chart that places its labels as wide as they draw. */
export const numbersHidden = (): boolean => hidden

export const fmtMoney = (cents: number): string => money.format(cents / 100)
export const fmtMoneyRound = (cents: number): string => moneyRound.format(Math.round(cents / 100))
export const fmtMoneyCompact = (cents: number): string => (hidden ? fmtMoneyRound(cents) : moneyCompact.format(cents / 100))

export function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtAgo(unix: number | null): string {
  if (!unix) return 'never'
  const s = Math.max(0, Date.now() / 1000 - unix)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(month: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', style === 'long' ? { month: 'long', year: 'numeric' } : { month: 'short' })
}

/** "October 2026", or "Jan 2022 – Jun 2025" for a span of months. */
export function spanLabel(from: string, to: string): string {
  if (from === to) return monthLabel(from)
  const short = (m: string): string => `${monthLabel(m, 'short')} ${m.slice(0, 4)}`
  return from.slice(0, 4) === to.slice(0, 4) ? `${monthLabel(from, 'short')} – ${short(to)}` : `${short(from)} – ${short(to)}`
}

export function monthBounds(month: string): { from: number; to: number } {
  const [y, m] = month.split('-').map(Number)
  return { from: new Date(y, m - 1, 1).getTime() / 1000, to: new Date(y, m, 1).getTime() / 1000 }
}

/** The feature a call was refused for by the plan (the main process answers {error:'plan'}; the preload spells it plan:<feature>), or null. */
export function planLock(err: unknown): FeatureId | null {
  const m = err instanceof Error ? err.message : String(err)
  if (!m.startsWith('plan:')) return null
  const id = m.slice(5)
  return FEATURES.some((f) => f.id === id) ? (id as FeatureId) : null
}

/** An error as the toast shows it; a plan refusal reads "Plus · <feature>". */
export function errorMessage(err: unknown): string {
  const lock = planLock(err)
  if (lock) return `Plus · ${featureLabel(lock)}`
  return err instanceof Error ? err.message : String(err)
}

/** Whether the plan in force includes a feature (the main process decides; this mirrors it for the locks). */
export const canUse = (settings: AppSettings | null, id: FeatureId): boolean => !!settings && hasFeature(settings.plan.plan, id)

/** Where a SimpleFIN setup token is made and the bridge's banks are managed. */
export const SIMPLEFIN_BRIDGE_URL = 'https://beta-bridge.simplefin.org'

/**
 * SimpleFIN's setup token in place of Plaid's Connect bank: the open edition, or a development
 * build (claudeCodeOffered says which) with no server for Plaid. The main process refuses it in
 * every other build (src/main/bankFeed.ts), so the beta and the installer keep Plaid's button.
 */
export const simplefinOffered = (settings: AppSettings | null): boolean =>
  !!settings && !onWeb() && (settings.plan.openEdition || (settings.claudeCodeOffered && !settings.plan.serverAvailable))

/** What a categorization did: "Categorized 12 of 40 transactions (8 by AI, 4 from earlier matches)." */
export function describeClassify(r: ClassifyResult): string {
  const done = r.fromAi + r.fromHistory + r.fromRules
  if (!r.total) return 'Everything is already categorized.'
  const parts = [r.fromAi && `${r.fromAi} by AI`, r.fromHistory && `${r.fromHistory} from earlier matches`, r.fromRules && `${r.fromRules} by your rules`].filter(Boolean)
  return `Categorized ${done} of ${r.total} transaction${r.total === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}.`
}

/**
 * The toasts after an import or a sync: what was categorized, and why the AI failed. Nothing when nothing was and
 * nothing failed (no API key, the AI off, nothing new): those wait uncategorized for Review. Categorize's own button
 * says what it did either way (App.tsx runClassify).
 */
export function classifiedToasts(r: ClassifyResult | undefined): Array<[string, 'info' | 'error']> {
  if (!r) return []
  const out: Array<[string, 'info' | 'error']> = []
  if (r.fromAi + r.fromHistory + r.fromRules > 0) out.push([describeClassify(r), 'info'])
  if (r.error) out.push([r.error, 'error'])
  return out
}

/** Settings' Plan card: every build but the open edition on the desktop, which has every feature by the build and no plan to show. */
export const planCardShown = (settings: AppSettings | null): boolean => !!settings && !(settings.plan.openEdition && !onWeb())

/** Today as YYYY-MM-DD, local time. */
export function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A YYYY-MM-DD day as "Jun 15, 2021". */
export function fmtDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "+$1,200" or "−$350", rounded to dollars. */
export function fmtSigned(cents: number): string {
  return `${cents >= 0 ? '+' : '−'}${fmtMoneyRound(Math.abs(cents))}`
}

/** "$1,200" or "−$350" with a true minus, rounded to dollars: a figure that can fall below 0, as a venture's position. */
export function fmtMinus(cents: number): string {
  return cents < 0 && Math.round(-cents / 100) !== 0 ? `−${fmtMoneyRound(-cents)}` : fmtMoneyRound(Math.abs(cents))
}

/**
 * Axis ticks for a date series: the first day of each month, or of each year
 * once the series spans more than about 16 months, thinned to at most 12.
 */
export function dateTicks(days: string[]): { ticks: string[]; format: (day: string) => string } {
  if (!days.length) return { ticks: [], format: (d) => d }
  const length = Date.parse(days[days.length - 1]) - Date.parse(days[0])
  // A month or two: a tick a week.
  if (length < 62 * 86_400_000) {
    return { ticks: days.filter((_, i) => i % 7 === 0), format: (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase() }
  }
  const yearly = length > 490 * 86_400_000
  const ticks = [days[0]]
  for (let i = 1; i < days.length; i++) {
    if (days[i].slice(0, yearly ? 4 : 7) !== days[i - 1].slice(0, yearly ? 4 : 7)) ticks.push(days[i])
  }
  const step = Math.ceil(ticks.length / 12)
  return {
    ticks: ticks.filter((_, i) => i % step === 0),
    format: (d) => (yearly ? d.slice(0, 4) : new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short' }).toUpperCase())
  }
}

/** How a scroll the app starts moves: smooth, unless the system asks for reduced motion. */
export const scrollMotion = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
