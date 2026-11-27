import { APP_NAME } from './app'
import { AI_ROUTE_LABELS, REPORT_REASONS, type AiReportInput, type ReportReason } from './types'

// A report of one AI answer (Review's messages, Home's headline): the
// app's version, the feature, its model, the reason, the user's note and the
// answer as the user left it. Nothing else goes in: no other transactions, no
// request body, no account or machine details. Copied to the clipboard, or
// emailed to the build's support address (SUPPORT_EMAIL in src/main/build.ts).

/** The longest answer and note a report carries. */
export const REPORT_MESSAGE_MAX = 6000
export const REPORT_NOTE_MAX = 1000
/** An email link holds less: the answer is cut to this in the email (the copied report keeps it all). */
export const MAILTO_MESSAGE_MAX = 1500

export interface AiReport extends AiReportInput {
  version: string
  model: string
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** A report as the renderer sent it, checked: a known feature and reason, text trimmed and cut to size. */
export function cleanReport(input: unknown): AiReportInput {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const route = r['route'] === 'headline' ? 'headline' : r['route'] === 'review' ? 'review' : null
  if (!route) throw new Error('Unknown feature')
  const reason = (REPORT_REASONS as readonly string[]).includes(String(r['reason'])) ? (String(r['reason']) as ReportReason) : null
  if (!reason) throw new Error('Pick a reason')
  const message = clip(typeof r['message'] === 'string' ? r['message'].trim() : '', REPORT_MESSAGE_MAX)
  if (!message) throw new Error('The answer is empty')
  const note = clip(typeof r['note'] === 'string' ? r['note'].trim() : '', REPORT_NOTE_MAX)
  return { route, reason, message, note }
}

export function reportText(r: AiReport): string {
  return [`${APP_NAME} ${r.version}`, `Feature: ${AI_ROUTE_LABELS[r.route]}`, `Model: ${r.model}`, `Reason: ${r.reason}`, ...(r.note ? [`Note: ${r.note}`] : []), '', 'Answer:', r.message].join('\n')
}

export const reportSubject = (r: Pick<AiReport, 'route' | 'reason'>): string => `${APP_NAME} AI report: ${AI_ROUTE_LABELS[r.route]} · ${r.reason}`

/** A plain address, as SUPPORT_EMAIL must be. */
export const isEmail = (s: string): boolean => /^[^\s@<>()[\]\\,;:"?&#%]+@[^\s@<>()[\]\\,;:"?&#%]+\.[A-Za-z]{2,}$/.test(s)

/** The email link: the support address, the subject, and the report with the answer cut to MAILTO_MESSAGE_MAX. */
export function reportMailto(email: string, r: AiReport): string {
  if (!isEmail(email)) throw new Error('No support address in this build')
  const body = reportText({ ...r, message: clip(r.message, MAILTO_MESSAGE_MAX) })
  return `mailto:${email}?subject=${encodeURIComponent(reportSubject(r))}&body=${encodeURIComponent(body)}`
}
