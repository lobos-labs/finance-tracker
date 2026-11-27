import * as db from './db'
import { BILL_DAYS, cleanQuiet, collectAlerts, forgetSent, heldBack, markSent, memberRecordKeys, NEW_MERCHANT_MIN_CENTS, takeUnsent, type Alert, type AlertSource } from './alerts'
import { lowDays, lowDaysKey, overdrawAlert, overdrawTomorrow, setLowDays } from './overdraw'
import { vendorHider } from './privacy'
import { detectRecurring } from './recurring'
import { RENEWAL_DAYS, renewalAlerts, renewalSeries } from './renewals'
import { getSpendable } from './spendable'
import { REPLIES } from './textReplies'
import { categoryRole } from '../shared/categoryRole'
import { addDays, daysBetween } from '../shared/zone'
import {
  ALERT_CHANNELS,
  ALERT_KIND_LABELS,
  ALERT_KINDS,
  SMS_CONSENT_LINE,
  type AlertChannel,
  type AlertKind,
  type AlertKindPrefs,
  type AlertPrefs,
  type AlertPrefsPatch,
  type NotifyKind,
  type OpenPageTarget,
  type Spendable,
  type SpendItem,
  type TextReply
} from '../shared/types'

// The hosted ledger's alerts (finance-server/src/ledger/alerts.ts sends them
// by push, text and email): the account's preferences (each kind on or off,
// its channels and thresholds; amounts in the text off by default; texts only
// once agreed to), the shortfall rule (Spendable's main account dipping under
// the cushion before payday), the wording, and one check that runs the
// desktop's engine (alerts.ts: what's been sent, what's been seen, at most a
// few at once) with them, plus renewal reminders (renewals.ts). The evening
// check is the overdraw alert alone (overdraw.ts); the shortfall and the
// overdraw alert never both go out on one day. No Electron, no network: the
// server delivers what this returns.
//
// A ledger shared with a partner (docs/hosted-api.md, "Household") checks
// once per member: the owner's preferences and record are the settings as
// they always were, a partner's sit beside them under the partner's id
// (`member`), so each is told under their own preferences. Consent to texts,
// STOP and START are each member's own too.

const PREFS = 'alerts.prefs'
const PAUSED = 'alerts.pausedUntil'
/** When texts were agreed to, and the line shown: { at, line } */
const CONSENT = 'alerts.smsConsent'
/** The kinds that had texts when STOP came, for START to put back */
const STOPPED = 'alerts.smsStopped'
/** A member's own copy of a setting: the owner's (null) is the key itself. */
const memberKey = (key: string, member: string | null | undefined): string => (member ? `${key}:${member}` : key)
const MAX_CENTS = 1_000_000_000
/** The longest pause, in minutes: a week. */
const MAX_PAUSE = 7 * 24 * 60

/** The kinds as the engine knows them (alerts.ts), on the wire; feed_behind isn't sent (the ledger syncs its own banks). */
const WIRE: Record<NotifyKind, AlertKind | null> = {
  bill_due: 'bill_due',
  large_purchase: 'large_charge',
  new_merchant: 'new_merchant',
  possible_duplicate: 'double_charge',
  feed_behind: null,
  credit_reminder: 'credit_reminder',
  price_change: 'price_change'
}

export const wireKind = (k: AlertSource): AlertKind | null => (k === 'shortfall' || k === 'overdraw' || k === 'renewal' || k === 'bank_signin' ? k : WIRE[k])

// ---------- preferences ----------

export function defaultAlertPrefs(): AlertPrefs {
  // Push only until the account picks more (sign-up and Settings offer text and email).
  const push = (): AlertChannel[] => ['push']
  return {
    showAmounts: false,
    kinds: {
      shortfall: { on: true, channels: push(), cushionCents: null, days: null },
      overdraw: { on: true, channels: push(), cushionCents: null },
      bill_due: { on: true, channels: push(), days: BILL_DAYS },
      renewal: { on: true, channels: push(), days: RENEWAL_DAYS, monthly: false },
      large_charge: { on: true, channels: push(), minCents: null },
      new_merchant: { on: true, channels: push(), minCents: NEW_MERCHANT_MIN_CENTS },
      double_charge: { on: true, channels: push() },
      price_change: { on: true, channels: push() },
      credit_reminder: { on: true, channels: push() },
      bank_signin: { on: true, channels: push() }
    },
    quietHours: null,
    pausedUntil: null,
    smsConsent: null,
    smsConsentLine: SMS_CONSENT_LINE
  }
}

const BAD = Symbol('bad')
type Parse = (v: unknown) => unknown

const bool: Parse = (v) => (typeof v === 'boolean' ? v : BAD)
const intIn = (lo: number, hi: number): Parse => (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : BAD)
const orNull = (p: Parse): Parse => (v) => (v === null ? null : p(v))
const channels: Parse = (v) => (Array.isArray(v) && v.every((c) => (ALERT_CHANNELS as readonly unknown[]).includes(c)) ? ALERT_CHANNELS.filter((c) => v.includes(c)) : BAD)

/** Each kind's fields: how to read one, and what to say when a change is wrong. */
const FIELDS: Record<AlertKind, Record<string, [Parse, string]>> = {
  shortfall: { cushionCents: [orNull(intIn(0, MAX_CENTS)), 'the cushion is $0 to $10,000,000, or none'], days: [orNull(intIn(1, 45)), 'days ahead are 1 to 45, or none'] },
  overdraw: { cushionCents: [orNull(intIn(0, MAX_CENTS)), 'the cushion is $0 to $10,000,000, or none'] },
  bill_due: { days: [intIn(0, 14), 'days ahead are 0 to 14'] },
  renewal: { days: [intIn(1, 14), 'days ahead are 1 to 14'], monthly: [bool, 'monthly is true or false'] },
  large_charge: { minCents: [orNull(intIn(100, MAX_CENTS)), 'the amount is $1 to $10,000,000, or none'] },
  new_merchant: { minCents: [intIn(0, MAX_CENTS), 'the amount is $0 to $10,000,000'] },
  double_charge: {},
  price_change: {},
  credit_reminder: {},
  bank_signin: {}
}
const COMMON: Record<string, [Parse, string]> = { on: [bool, 'on is true or false'], channels: [channels, 'the channels are push, sms and email'] }

/** A kind's preferences with `v`'s fields over `base`: a stored one keeps the base where a field is wrong; a change (strict) throws. */
function mergeKind<K extends AlertKind>(k: K, base: AlertKindPrefs<K>, v: unknown, strict: boolean): AlertKindPrefs<K> {
  if (strict && (v === null || typeof v !== 'object' || Array.isArray(v))) throw new Error(`${ALERT_KIND_LABELS[k]}: expected an object`)
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Record<string, unknown> = { ...base, channels: [...base.channels] }
  const fields = { ...COMMON, ...FIELDS[k] }
  for (const field of Object.keys(o)) {
    if (o[field] === undefined) continue
    if (!(field in fields)) {
      if (strict) throw new Error(`${ALERT_KIND_LABELS[k]}: no setting "${field}"`)
      continue
    }
    const [parse, wrong] = fields[field]
    const r = parse(o[field])
    if (r === BAD) {
      if (strict) throw new Error(`${ALERT_KIND_LABELS[k]}: ${wrong}`)
      continue
    }
    out[field] = r
  }
  return out as unknown as AlertKindPrefs<K>
}

const kindsOf = (v: unknown, base: AlertPrefs['kinds']): AlertPrefs['kinds'] => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return Object.fromEntries(ALERT_KINDS.map((k) => [k, mergeKind(k, base[k], o[k], false)])) as AlertPrefs['kinds']
}

/** A member's preferences (`member`: a partner's id; null or left out, the owner's). */
export function alertPrefs(now = db.now(), member: string | null = null): AlertPrefs {
  const base = defaultAlertPrefs()
  let stored: Record<string, unknown> = {}
  try {
    const v = JSON.parse(db.getSetting(memberKey(PREFS, member)) ?? '{}') as unknown
    if (v && typeof v === 'object') stored = v as Record<string, unknown>
  } catch {
    // Unreadable: the defaults.
  }
  const paused = Number(db.getSetting(memberKey(PAUSED, member)) ?? 0)
  return {
    showAmounts: stored['showAmounts'] === true,
    kinds: kindsOf(stored['kinds'], base.kinds),
    quietHours: cleanQuiet(stored['quietHours'] ?? null),
    pausedUntil: paused > now ? paused : null,
    smsConsent: smsConsent(member),
    smsConsentLine: SMS_CONSENT_LINE
  }
}

function smsConsent(member: string | null): AlertPrefs['smsConsent'] {
  try {
    const v = JSON.parse(db.getSetting(memberKey(CONSENT, member)) ?? 'null') as { at?: unknown; line?: unknown } | null
    return v && typeof v.at === 'number' && typeof v.line === 'string' ? { at: v.at, line: v.line } : null
  } catch {
    return null
  }
}

/** A member's preferences as stored (the pause and consent are their own settings). */
const savePrefs = (p: Pick<AlertPrefs, 'showAmounts' | 'kinds' | 'quietHours'>, member: string | null): void =>
  db.setSetting(memberKey(PREFS, member), JSON.stringify({ showAmounts: p.showAmounts, kinds: p.kinds, quietHours: p.quietHours }))

/**
 * Saves a change from Settings (the web or the phone), the caller's own; a wrong value throws and nothing is
 * saved. Texts on any kind need the member's consent: the change that turns them on carries the line shown at
 * the switch (smsConsent, SMS_CONSENT_LINE), and it's recorded with the time.
 */
export function setAlertPrefs(patch: AlertPrefsPatch, now = db.now(), member: string | null = null): AlertPrefs {
  const p = (patch && typeof patch === 'object' ? patch : {}) as AlertPrefsPatch
  const cur = alertPrefs(now, member)
  const was = cur.kinds
  if (p.smsConsent !== undefined && p.smsConsent !== SMS_CONSENT_LINE) throw new Error('smsConsent is the line shown at the text-message switch')
  if (p.showAmounts !== undefined) {
    if (typeof p.showAmounts !== 'boolean') throw new Error('showAmounts is true or false')
    cur.showAmounts = p.showAmounts
  }
  if (p.kinds !== undefined) {
    if (!p.kinds || typeof p.kinds !== 'object') throw new Error('kinds is an object of alert kinds')
    for (const k of Object.keys(p.kinds)) if (!(ALERT_KINDS as readonly string[]).includes(k)) throw new Error(`Unknown alert kind "${k}"`)
    const next = { ...cur.kinds } as Record<AlertKind, AlertKindPrefs>
    for (const k of ALERT_KINDS) if (p.kinds[k] !== undefined) next[k] = mergeKind(k, cur.kinds[k] as AlertKindPrefs, p.kinds[k], true)
    cur.kinds = next as AlertPrefs['kinds']
  }
  if (p.quietHours !== undefined) {
    const q = p.quietHours === null ? null : cleanQuiet(p.quietHours)
    if (p.quietHours !== null && !q) throw new Error('Quiet hours are two times like 22:00')
    cur.quietHours = q
  }
  let pause: string | null | undefined
  if (p.pauseMinutes !== undefined) {
    const m = Math.min(MAX_PAUSE, Math.max(0, Math.round(Number(p.pauseMinutes)) || 0))
    pause = m ? String(now + m * 60) : null
  }
  const textsAdded = ALERT_KINDS.some((k) => cur.kinds[k].channels.includes('sms') && !was[k].channels.includes('sms'))
  if (textsAdded && !cur.smsConsent && p.smsConsent === undefined) throw new Error('Texts need the line shown at the switch agreed to (smsConsent)')
  db.inTransaction(() => {
    savePrefs(cur, member)
    if (pause !== undefined) db.setSetting(memberKey(PAUSED, member), pause)
    if (p.smsConsent !== undefined) {
      db.setSetting(memberKey(CONSENT, member), JSON.stringify({ at: now, line: p.smsConsent }))
      db.setSetting(memberKey(STOPPED, member), null)
    }
  })
  return alertPrefs(now, member)
}

/** STOP from a member's phone: their texts off on every kind (the kinds are kept for START) and their consent ends. Not journaled: it's the carrier's rule. */
export function textsStopped(now = db.now(), member: string | null = null): AlertPrefs {
  const cur = alertPrefs(now, member)
  const had = ALERT_KINDS.filter((k) => cur.kinds[k].channels.includes('sms'))
  const kinds = Object.fromEntries(ALERT_KINDS.map((k) => [k, { ...cur.kinds[k], channels: cur.kinds[k].channels.filter((c) => c !== 'sms') }])) as AlertPrefs['kinds']
  db.inTransaction(() => {
    savePrefs({ ...cur, kinds }, member)
    db.setSetting(memberKey(CONSENT, member), null)
    if (had.length) db.setSetting(memberKey(STOPPED, member), JSON.stringify(had))
  })
  return alertPrefs(now, member)
}

/** START from a member's phone: the kinds that had texts before STOP get them back, and the reply is the consent. */
export function textsStarted(now = db.now(), member: string | null = null): AlertPrefs {
  const cur = alertPrefs(now, member)
  let had: AlertKind[] = []
  try {
    const v = JSON.parse(db.getSetting(memberKey(STOPPED, member)) ?? '[]') as unknown
    if (Array.isArray(v)) had = ALERT_KINDS.filter((k) => v.includes(k))
  } catch {
    // Unreadable: nothing to put back.
  }
  const kinds = Object.fromEntries(ALERT_KINDS.map((k) => [k, had.includes(k) ? { ...cur.kinds[k], channels: ALERT_CHANNELS.filter((c) => c === 'sms' || cur.kinds[k].channels.includes(c)) } : cur.kinds[k]])) as AlertPrefs['kinds']
  db.inTransaction(() => {
    savePrefs({ ...cur, kinds }, member)
    db.setSetting(memberKey(CONSENT, member), JSON.stringify({ at: now, line: 'START' }))
    db.setSetting(memberKey(STOPPED, member), null)
  })
  return alertPrefs(now, member)
}

/** A partner left the ledger: their preferences, consent and record of what they were sent go (`more`: the host's own keys for them). */
export function forgetAlertMember(member: string, more: string[] = []): void {
  if (!member) return
  db.inTransaction(() => {
    for (const key of [memberKey(PREFS, member), memberKey(PAUSED, member), memberKey(CONSENT, member), memberKey(STOPPED, member), lowDaysKey(member), ...memberRecordKeys(member), ...more]) db.setSetting(key, null)
  })
}

// ---------- the rules ----------

/**
 * A coming shortfall: Spendable's main account (the one picked, else the one paychecks land in), at the
 * account's chosen risk, dipping under the cushion (or under zero without one) on any day through the next
 * payday, or through `days` ahead when that's sooner. Keyed by the payday, so it comes once per payday window.
 */
export function shortfallAlert(sp: Spendable, today: string, o: { cushionCents: number | null; days: number | null }): Alert[] {
  const a = sp.accounts.find((x) => x.id === sp.accountId)
  if (!a || !a.days.length) return []
  const cushion = o.cushionCents ?? sp.cushionCents
  const ends = [a.nextPayday, o.days !== null ? addDays(today, o.days) : null].filter((d): d is string => d !== null).sort()
  const window = ends.length ? a.days.filter((d) => d.day <= ends[0]) : a.days
  if (!window.length) return []
  const low = window.reduce((m, d) => (d.lowCents < m.lowCents ? d : m), window[0])
  const short = cushion - low.lowCents
  if (short <= 0) return []
  return [
    {
      key: `shortfall:${a.id}:${a.nextPayday ?? low.day}`,
      kind: 'shortfall',
      title: 'Short before payday',
      body: `${a.name} · ${low.day}`,
      target: { page: 'dashboard' },
      facts: { cents: short, account: a.name, day: low.day }
    }
  ]
}

/** A bank asking to sign in again: once until it's fixed (the server drops the key when the Item is back to ok). */
export const signinAlert = (s: { itemId: string; institution: string | null }): Alert => ({
  key: `bank_signin:${s.itemId}`,
  kind: 'bank_signin',
  title: 'Sign in to your bank again',
  body: s.institution ?? '',
  target: { page: 'accounts' },
  facts: s.institution ? { name: s.institution } : {}
})

// ---------- the words ----------

const money = (cents: number): string => `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** Short, for a text: "$84", "$84.17"; signed, "−$32". */
const dollars = (cents: number): string => {
  const d = Math.abs(cents) % 100 === 0 ? 0 : 2
  return `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
}
/** "AT&T", "AT&T and Netflix", "AT&T, Netflix and 2 more"; each with its amount when `amt` gives one. */
function billList(bills: Array<{ name: string; cents: number }>, amt: (c: number) => string | null): string {
  const one = (b: { name: string; cents: number }): string => [b.name, amt(b.cents)].filter(Boolean).join(' ')
  if (bills.length <= 2) return bills.map(one).join(' and ')
  return `${bills.slice(0, 2).map(one).join(', ')} and ${bills.length - 2} more`
}
const atNoon = (day: string): Date => new Date(`${day}T12:00:00Z`)
const fmtDay = (day: string): string => atNoon(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "today", "tomorrow", "on Friday" within the week, "on Nov 14" past it. */
export function whenSaid(today: string, day: string): string {
  const n = daysBetween(today, day)
  if (n <= 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n < 7) return `on ${atNoon(day).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`
  return `on ${fmtDay(day)}`
}

/** An alert in the hosted ledger's words, with amounts only when the account shows them. */
export function alertText(a: Alert, o: { showAmounts: boolean; today: string }): { title: string; body: string } {
  const f = a.facts ?? {}
  const amt = (c: number | undefined): string | null => (o.showAmounts && c !== undefined ? money(c) : null)
  const name = f.name ?? ''
  const join = (...parts: Array<string | null | undefined>): string => parts.filter(Boolean).join(' · ')
  switch (a.kind) {
    case 'shortfall': {
      const when = f.day ? whenSaid(o.today, f.day) : 'before payday'
      const x = amt(f.cents)
      return { title: x ? `You'll be ${x} short ${when}` : `You'll be short ${when}`, body: f.account ?? '' }
    }
    case 'overdraw': {
      // "AT&T $84 tomorrow takes Checking to −$32"; without amounts, "AT&T tomorrow would overdraw Checking".
      const bills = f.bills ?? []
      const account = f.account ?? 'your account'
      const low = f.lowCents ?? 0
      const under = low < 0
      const title = o.showAmounts
        ? `${billList(bills, (c) => dollars(Math.abs(c)))} tomorrow ${bills.length === 1 ? 'takes' : 'take'} ${account} to ${dollars(low)}${under ? '' : ` (under ${dollars(f.floorCents ?? 0)})`}`
        : `${billList(bills, () => null)} tomorrow would ${under ? `overdraw ${account}` : `take ${account} under your cushion`}`
      const m = f.move
      const body = !m ? '' : m.kind === 'transfer' ? `Move ${o.showAmounts ? dollars(m.cents) : 'money'} from ${m.from} tonight` : `Ask ${m.name} to move the date`
      return { title, body }
    }
    case 'renewal': {
      const x = o.showAmounts && f.cents !== undefined ? `${dollars(Math.abs(f.cents))} a ${f.cadence === 'annual' ? 'year' : 'month'}` : ''
      return { title: `${name} renews ${f.day ? whenSaid(o.today, f.day) : 'soon'}`, body: x }
    }
    case 'bill_due':
      return { title: `${name} is due ${f.day ? whenSaid(o.today, f.day) : 'soon'}`, body: join(amt(f.cents), f.day ? fmtDay(f.day) : null) }
    case 'large_purchase': {
      const x = amt(f.cents)
      return { title: x ? `A ${x} charge at ${name}` : `A large charge at ${name}`, body: f.account ?? '' }
    }
    case 'new_merchant': {
      const x = amt(f.cents)
      return { title: x ? `A ${x} first charge at ${name}` : `A first charge at ${name}`, body: f.account ?? '' }
    }
    case 'possible_duplicate': {
      const x = amt(f.cents)
      return { title: `A possible double charge at ${name}`, body: join(x ? `${x} twice` : null, f.account) }
    }
    case 'price_change': {
      const from = amt(f.previousCents)
      const to = amt(f.cents)
      return { title: from && to ? `${name} went from ${from} to ${to}` : `${name} changed its price`, body: '' }
    }
    case 'credit_reminder':
      return { title: 'Check your credit score', body: f.day ? `Last recorded ${fmtDay(f.day)}` : 'None recorded' }
    case 'bank_signin':
      return { title: `${name || 'Your bank'} asks you to sign in again`, body: '' }
    default:
      return { title: a.title, body: o.showAmounts ? a.body : '' }
  }
}

// ---------- the check ----------

/** One alert to deliver: its wire kind, words and channels; a text offers `replies` in its last line. */
export interface LedgerAlert {
  key: string
  kind: AlertKind
  title: string
  body: string
  channels: AlertChannel[]
  target: OpenPageTarget
  /** what a text of it can be answered with (textReplies.ts), and the line that says so */
  replies?: TextReply[]
  replyLine?: string
}

export interface LedgerCheck {
  now?: number
  /** the account's bank logins asking to sign in again (D1's bank_items); left out: not looked up */
  signin?: Array<{ itemId: string; institution: string | null }>
  /** whose check: a partner's id, with their preferences and record; null or left out, the owner's */
  member?: string | null
  /** the member's evening check is still to run today: a shortfall that tonight's overdraw alert would cover waits for it */
  eveningAhead?: boolean
}

/** A subscription, or a bill in the utilities category: a biller that can be asked to move its date. */
function askableBills(): (item: SpendItem) => boolean {
  const utilities = detectRecurring().filter((s) => categoryRole(s.categoryName) === 'utilities').map((s) => `${s.key}:`)
  return (i) => i.kind === 'subscription' || utilities.some((k) => i.key.startsWith(k))
}

function toLedgerAlert(a: Alert, p: AlertPrefs, today: string): LedgerAlert[] {
  const kind = wireKind(a.kind)
  if (!kind) return []
  const r = kind === 'renewal' || kind === 'overdraw' ? REPLIES[kind] : null
  return [{ key: a.key, kind, ...alertText(a, { showAmounts: p.showAmounts, today }), channels: p.kinds[kind].channels, target: a.target, ...(r ? { replies: r.replies, replyLine: r.line } : {}) }]
}

/**
 * The hosted ledger's check: the engine's kinds (bill due, large charge, new merchant, double charge, price
 * change, credit reminder) plus a coming shortfall, renewals and banks asking to sign in, each as the
 * member's preferences say. Paused or in quiet hours (on the ledger's clock), it's held: nothing is noted, the
 * next check catches up. Every alert returned is noted as sent. The shortfall waits on a day the member's
 * overdraw alert went out or they replied DONE, and for tonight's overdraw alert when that will cover it.
 */
export function ledgerAlertCheck(o: LedgerCheck = {}): { held: boolean; alerts: LedgerAlert[] } {
  const now = o.now ?? db.now()
  const member = o.member ?? null
  const p = alertPrefs(now, member)
  if (heldBack(now, p)) return { held: true, alerts: [] }
  const live = (k: AlertKind): boolean => p.kinds[k].on && p.kinds[k].channels.length > 0
  if (o.signin) {
    const open = new Set(o.signin.map((s) => `bank_signin:${s.itemId}`))
    forgetSent((key) => key.startsWith('bank_signin:') && !open.has(key), member)
  }
  const today = db.dayKey(now)
  let shortfall: Alert[] = []
  if (live('shortfall')) {
    const low = lowDays(member)
    const sp = getSpendable()
    shortfall = shortfallAlert(sp, today, p.kinds.shortfall)
    const tonight = (): boolean => !!o.eveningAhead && live('overdraw') && !!overdrawTomorrow(sp, today, { cushionCents: p.kinds.overdraw.cushionCents, askable: () => false })
    if (shortfall.length && (low.overdraw === today || low.done === today || tonight())) shortfall = []
  }
  const renewals = live('renewal') ? renewalAlerts(renewalSeries(), today, { ...p.kinds.renewal, hidden: vendorHider() }) : []
  const more = [...shortfall, ...renewals, ...(live('bank_signin') ? (o.signin ?? []).map(signinAlert) : [])]
  const found = collectAlerts({
    now,
    bank: null,
    kinds: {
      bill_due: live('bill_due'),
      large_purchase: live('large_charge'),
      new_merchant: live('new_merchant'),
      possible_duplicate: live('double_charge'),
      feed_behind: false,
      credit_reminder: live('credit_reminder'),
      price_change: live('price_change')
    },
    privacy: { numbersHidden: !p.showAmounts, hidden: vendorHider() },
    thresholds: { billDays: p.kinds.bill_due.days, largeMinCents: p.kinds.large_charge.minCents, newMerchantMinCents: p.kinds.new_merchant.minCents },
    more,
    member
  })
  if (found.some((a) => a.kind === 'shortfall')) setLowDays({ shortfall: today }, member)
  return { held: false, alerts: found.flatMap((a) => toLedgerAlert(a, p, today)) }
}

/**
 * The evening check (about 19:00 on the account's clock, finance-server/src/ledger/alerts.ts): tomorrow's
 * bills taking the main account under, with one move, once per member and day, under the member's own
 * preferences and record. Held like the full check. Not on a day the member's shortfall alert went out or they
 * replied DONE; once sent, a shortfall about the same dip is noted as sent to them too.
 */
export function ledgerEveningCheck(o: { now?: number; member?: string | null } = {}): { held: boolean; alerts: LedgerAlert[] } {
  const now = o.now ?? db.now()
  const member = o.member ?? null
  const p = alertPrefs(now, member)
  if (heldBack(now, p)) return { held: true, alerts: [] }
  const k = p.kinds.overdraw
  const today = db.dayKey(now)
  const low = lowDays(member)
  if (!k.on || !k.channels.length || low.shortfall === today || low.done === today) return { held: false, alerts: [] }
  // Nothing before the ledger has an account (the first run).
  if (!db.get('SELECT 1 AS x FROM accounts LIMIT 1')) return { held: false, alerts: [] }
  const sp = getSpendable()
  const found = overdrawTomorrow(sp, today, { cushionCents: k.cushionCents, askable: askableBills() })
  const sent = found ? takeUnsent([overdrawAlert(found)], now, member) : []
  if (!sent.length) return { held: false, alerts: [] }
  setLowDays({ overdraw: today }, member)
  const dip = shortfallAlert(sp, today, p.kinds.shortfall)[0]
  if (dip && dip.facts?.day && dip.facts.day <= addDays(today, 1)) markSent([dip.key], now, member)
  return { held: false, alerts: sent.flatMap((a) => toLedgerAlert(a, p, today)) }
}
