import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { alertPrefs, alertText, forgetAlertMember, ledgerAlertCheck, ledgerEveningCheck, setAlertPrefs, textsStarted, textsStopped } from '../src/main/ledgerAlerts.ts'
import { lowDays, overdrawAlert, overdrawTomorrow } from '../src/main/overdraw.ts'
import { setHiddenVendors } from '../src/main/privacy.ts'
import { cancelledByNow, renewalAlerts, renewalMark, renewalSeriesKey, setRenewalMark } from '../src/main/renewals.ts'
import { getSpendable, setSpendSettings } from '../src/main/spendable.ts'
import { answerTextReply, REPLIES } from '../src/main/textReplies.ts'
import { cancelLine, cancelStepsFor } from '../src/shared/cancelSteps.ts'
import { addDays, addMonths } from '../src/shared/zone.ts'
import { SMS_CONSENT_LINE, type RecurringSeries, type SpendAccount, type SpendItem, type Spendable } from '../src/shared/types.ts'
import { noonOn, zoned } from './days.ts'

// Alerts that arrive at the last useful moment and can be answered by text:
// tomorrow's overdraw with one move, renewal reminders, the replies (HOW,
// KEEP, DONE) journaled so they can be undone, consent to texts, STOP and
// START, and one low-balance alert a day (the shortfall or the overdraw).

configureLicense({ dev: true })
const dir = mkdtempSync(join(tmpdir(), 'finance-alerts-act-'))
let dbs = 0
const open = (): void => {
  db.closeDb()
  db.openDb(join(dir, `${dbs++}.db`))
}
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const TODAY = '2026-11-03' // a Tuesday
const TOMORROW = '2026-11-04'
const minus = '−'

// ---------- the overdraw rule, on a Spendable built by hand ----------

const acct = (id: string, name: string, lows: number[], spendableCents = 0): SpendAccount => ({
  id,
  name,
  startCents: lows[0],
  balanceDate: 0,
  spendableCents,
  lowDay: TODAY,
  nextPayday: null,
  perDayCents: null,
  days: lows.map((low, i) => ({ day: addDays(TODAY, i), startCents: low, endCents: low, lowCents: low, inCents: 0, outCents: 0 })),
  byRisk: { cautious: 0, balanced: 0, tight: 0 }
})
const item = (name: string, cents: number, o: Partial<SpendItem> = {}): SpendItem => ({ key: `${name.toLowerCase()}|-:chk:${TOMORROW}`, day: TOMORROW, name, kind: 'bill', cents, accountId: 'chk', accountName: 'Checking', estimated: false, late: false, ...o })
const sp = (o: { lows?: number[]; items?: SpendItem[]; others?: SpendAccount[]; cushionCents?: number }): Spendable => ({
  risk: 'cautious',
  cushionCents: o.cushionCents ?? 0,
  accountId: 'chk',
  accounts: [acct('chk', 'Checking', o.lows ?? [5200, -3200, -3200]), ...(o.others ?? [])],
  items: o.items ?? [item('AT&T', -8400)]
})
const never = (): boolean => false

describe('overdraw tomorrow', () => {
  test('tomorrow\'s bills taking the main account under zero: the bills, the balance, a move from savings in tens of dollars', () => {
    const o = overdrawTomorrow(sp({ others: [acct('sav', 'Savings', [50000], 50000), acct('cash2', 'Joint', [3000], 3000)] }), TODAY, { cushionCents: null, askable: never })!
    assert.deepEqual(o, { accountId: 'chk', account: 'Checking', day: TOMORROW, bills: [{ name: 'AT&T', cents: -8400 }], lowCents: -3200, floorCents: 0, move: { kind: 'transfer', from: 'Savings', cents: 4000 } })
    assert.equal(overdrawAlert(o).key, `overdraw:chk:${TOMORROW}`)
  })

  test('without an account that can spare it, a subscription or a utility can be asked to move its date; otherwise no move', () => {
    const items = [item('Rent', -150000, { kind: 'bill' }), item('AT&T', -8400)]
    const poor = [acct('sav', 'Savings', [1000], 1000)]
    const low = [5200, -153200]
    const ask = overdrawTomorrow(sp({ lows: low, items, others: poor }), TODAY, { cushionCents: null, askable: (i) => i.name === 'AT&T' })!
    assert.deepEqual(ask.bills.map((b) => b.name), ['Rent', 'AT&T'])
    assert.deepEqual(ask.move, { kind: 'ask', name: 'AT&T' })
    assert.equal(overdrawTomorrow(sp({ lows: low, items, others: poor }), TODAY, { cushionCents: null, askable: never })!.move, null)
  })

  test('under the cushion counts; above it, everyday trips alone, or no main account: nothing', () => {
    assert.equal(overdrawTomorrow(sp({ lows: [12000, 3600] }), TODAY, { cushionCents: null, askable: never }), null)
    const under = overdrawTomorrow(sp({ lows: [12000, 3600], cushionCents: 5000 }), TODAY, { cushionCents: null, askable: never })!
    assert.deepEqual([under.lowCents, under.floorCents], [3600, 5000])
    // Its own cushion overrides Spendable's.
    assert.equal(overdrawTomorrow(sp({ lows: [12000, 3600], cushionCents: 5000 }), TODAY, { cushionCents: 1000, askable: never }), null)
    assert.equal(overdrawTomorrow(sp({ items: [item('Groceries', -8400, { everyday: true, kind: 'other' })] }), TODAY, { cushionCents: null, askable: never }), null)
    assert.equal(overdrawTomorrow({ ...sp({}), accountId: null }, TODAY, { cushionCents: null, askable: never }), null)
  })

  test('the words: amounts only when the account shows them', () => {
    const words = (o: Parameters<typeof overdrawTomorrow>[0], show: boolean): { title: string; body: string } =>
      alertText(overdrawAlert(overdrawTomorrow(o, TODAY, { cushionCents: null, askable: (i) => i.name === 'AT&T' })!), { showAmounts: show, today: TODAY })
    const save = sp({ others: [acct('sav', 'Savings', [50000], 50000)] })
    assert.deepEqual(words(save, true), { title: `AT&T $84 tomorrow takes Checking to ${minus}$32`, body: 'Move $40 from Savings tonight' })
    assert.deepEqual(words(save, false), { title: 'AT&T tomorrow would overdraw Checking', body: 'Move money from Savings tonight' })
    assert.deepEqual(words(sp({}), false), { title: 'AT&T tomorrow would overdraw Checking', body: 'Ask AT&T to move the date' })
    const three = sp({ lows: [5200, -12017], items: [item('AT&T', -8400), item('Netflix', -1549), item('Gym', -7268)] })
    assert.equal(words(three, true).title, `AT&T $84, Gym $72.68 and 1 more tomorrow take Checking to ${minus}$120.17`)
    assert.equal(words(sp({ lows: [12000, 3600], cushionCents: 5000 }), true).title, 'AT&T $84 tomorrow takes Checking to $36 (under $50)')
    assert.equal(words(sp({ lows: [12000, 3600], cushionCents: 5000 }), false).title, 'AT&T tomorrow would take Checking under your cushion')
  })
})

// ---------- renewals ----------

const series = (o: Partial<RecurringSeries> & { key: string; name: string; next: string }): RecurringSeries => ({
  kind: 'subscription',
  cadence: 'annual',
  typicalCents: -13900,
  lastCents: -13900,
  previousCents: -13900,
  priceChanged: false,
  variable: false,
  monthlyCents: -1158,
  lastDate: db.noon(addDays(o.next, -365)),
  nextDate: db.noon(o.next),
  count: 2,
  status: 'active',
  confirmed: false,
  dismissed: false,
  categoryName: 'Subscriptions',
  accountName: 'Checking',
  owner: null,
  personalBp: 10000,
  ...o
})

describe('renewal reminders', () => {
  beforeEach(open)

  test('a yearly subscription 3 days before by default; monthly ones only when turned on', () => {
    const p = alertPrefs()
    assert.deepEqual(p.kinds.renewal, { on: true, channels: ['push'], days: 3, monthly: false })
    const all = [
      series({ key: 'prime|-', name: 'Amazon Prime', next: addDays(TODAY, 3) }),
      series({ key: 'adobe|-', name: 'Adobe', next: addDays(TODAY, 4) }),
      series({ key: 'netflix|-', name: 'Netflix', cadence: 'monthly', typicalCents: -1549, next: addDays(TODAY, 2) }),
      series({ key: 'gas|-', name: 'City Gas', kind: 'bill', next: addDays(TODAY, 1) }),
      series({ key: 'old|-', name: 'Old Thing', status: 'stopped', next: addDays(TODAY, 1) })
    ]
    const keys = (o: { days: number; monthly: boolean }): string[] => renewalAlerts(all, TODAY, { ...o, hidden: () => false }).map((a) => a.key)
    assert.deepEqual(keys(p.kinds.renewal), [`renewal:prime|-:${addDays(TODAY, 3)}`])
    assert.deepEqual(keys({ days: 3, monthly: true }), [`renewal:prime|-:${addDays(TODAY, 3)}`, `renewal:netflix|-:${addDays(TODAY, 2)}`])
    assert.deepEqual(keys({ days: 4, monthly: false }).length, 2)
    assert.deepEqual(renewalAlerts(all, TODAY, { days: 3, monthly: false, hidden: (n) => n === 'Amazon Prime' }), [])
    const [a] = renewalAlerts(all, TODAY, { days: 3, monthly: false, hidden: () => false })
    assert.deepEqual(alertText(a, { showAmounts: false, today: TODAY }), { title: 'Amazon Prime renews on Friday', body: '' })
    assert.deepEqual(alertText(a, { showAmounts: true, today: TODAY }), { title: 'Amazon Prime renews on Friday', body: '$139 a year' })
    assert.equal(renewalSeriesKey(a.key), 'prime|-')
    assert.equal(renewalSeriesKey('renewal:at&t: wireless|-:2026-11-06'), 'at&t: wireless|-')
  })

  test('KEEP ends a series\' reminders; a cancel request holds them until it charges again', () => {
    const s = series({ key: 'prime|-', name: 'Amazon Prime', next: addDays(TODAY, 2) })
    const n = (x: RecurringSeries): number => renewalAlerts([x], TODAY, { days: 3, monthly: false, hidden: () => false }).length
    assert.equal(n(s), 1)
    setRenewalMark(s.key, { keep: true })
    assert.equal(n(s), 0)
    setRenewalMark(s.key, { cancelAt: db.noon(TODAY) })
    assert.equal(n(s), 0)
    // Charged after the request: it wasn't cancelled, and next year's reminder comes.
    assert.equal(n({ ...s, lastDate: db.noon(TODAY) + 3600 }), 1)
  })

  test('Spendable keeps counting a series asked to cancel until its date passes with no charge (and a short grace)', () => {
    const s = series({ key: 'prime|-', name: 'Amazon Prime', next: addDays(TODAY, -2) })
    const asked = { cancelAt: db.noon(addDays(TODAY, -5)) }
    assert.equal(cancelledByNow(s, TODAY, asked), false)
    assert.equal(cancelledByNow(s, addDays(TODAY, 2), asked), true)
    assert.equal(cancelledByNow({ ...s, lastDate: db.noon(addDays(TODAY, -2)) }, addDays(TODAY, 2), asked), false)
    assert.equal(cancelledByNow(s, addDays(TODAY, 2), null), false)
  })

  test('the cancel steps: the company\'s own page for a known one, the generic line otherwise', () => {
    assert.equal(cancelLine('NETFLIX.COM'), 'Netflix: https://www.netflix.com/cancelplan')
    assert.equal(cancelStepsFor('Apple.com/bill')?.name, 'Apple')
    assert.match(cancelLine('Gym Co'), /^Gym Co: cancel in its app or on its website/)
  })
})

// ---------- the replies, journaled ----------

describe('text replies', () => {
  beforeEach(open)
  const revert = (id: number): void => {
    const c = db.getChange(id)!
    assert.equal(c.origin, 'text')
    undo(c.tool, c.before, c.after, c.input)
    db.markChangeUndone(id)
  }

  test('each text names its replies', () => {
    assert.deepEqual(REPLIES.renewal, { replies: ['HOW', 'KEEP'], line: 'Reply HOW for how to cancel, KEEP to stop these.' })
    assert.deepEqual(REPLIES.overdraw.replies, ['DONE'])
  })

  test('HOW answers with how to cancel and marks the series; undo takes the mark back', () => {
    const r = answerTextReply('renewal:netflix|-:2026-11-06', 'HOW', 1_000)
    assert.equal(r.text, 'Netflix: https://www.netflix.com/cancelplan')
    assert.deepEqual(renewalMark('netflix|-'), { cancelAt: 1_000 })
    revert(r.changeId)
    assert.equal(renewalMark('netflix|-'), null)
  })

  test('KEEP ends the reminders for that series; undo brings them back as they were', () => {
    setRenewalMark('gym co|-', { cancelAt: 500 })
    const r = answerTextReply('renewal:gym co|-:2026-11-06', 'KEEP', 1_000)
    assert.equal(r.text, 'No more renewal reminders for gym co.')
    assert.deepEqual(renewalMark('gym co|-'), { keep: true })
    revert(r.changeId)
    assert.deepEqual(renewalMark('gym co|-'), { cancelAt: 500 })
  })

  test('DONE quiets today\'s low-balance alerts; a reply the text didn\'t offer is refused', () => {
    const now = noonOn(2026, 11, 3)
    const r = answerTextReply(`overdraw:chk:${TOMORROW}`, 'DONE', now)
    assert.equal(lowDays().done, TODAY)
    revert(r.changeId)
    assert.equal(lowDays().done, undefined)
    assert.throws(() => answerTextReply(`overdraw:chk:${TOMORROW}`, 'HOW', now), /doesn't answer/)
    assert.throws(() => answerTextReply('shortfall:chk:2026-11-13', 'DONE', now), /doesn't answer/)
  })

  test('on shared books a partner\'s DONE is theirs alone, journaled with them as the member; their KEEP marks the books\' series', () => {
    const now = noonOn(2026, 11, 3)
    const done = answerTextReply(`overdraw:chk:${TOMORROW}`, 'DONE', now, 'u_partner', 'u_partner')
    assert.deepEqual([lowDays('u_partner').done, lowDays().done], [TODAY, undefined])
    const c = db.getChange(done.changeId)!
    assert.deepEqual([c.origin, c.input], ['text:u_partner', { key: `overdraw:chk:${TOMORROW}`, reply: 'DONE', member: 'u_partner' }])
    undo(c.tool, c.before, c.after, c.input)
    assert.equal(lowDays('u_partner').done, undefined)
    answerTextReply('renewal:netflix|-:2026-11-06', 'KEEP', now, 'u_partner')
    assert.deepEqual(renewalMark('netflix|-'), { keep: true })
  })
})

// ---------- consent, STOP and START ----------

describe('texts need consent', () => {
  beforeEach(open)

  test('turning texts on needs the line shown at the switch; it is kept with the time', () => {
    assert.throws(() => setAlertPrefs({ kinds: { overdraw: { channels: ['push', 'sms'] } } }), /smsConsent/)
    assert.throws(() => setAlertPrefs({ kinds: { overdraw: { channels: ['sms'] } }, smsConsent: 'I agree' }), /smsConsent/)
    assert.equal(alertPrefs().kinds.overdraw.channels.includes('sms'), false)
    const p = setAlertPrefs({ kinds: { overdraw: { channels: ['push', 'sms'] } }, smsConsent: SMS_CONSENT_LINE }, 1_000)
    assert.deepEqual(p.smsConsent, { at: 1_000, line: SMS_CONSENT_LINE })
    assert.equal(p.smsConsentLine, SMS_CONSENT_LINE)
    // Once agreed, more kinds by text need nothing more.
    assert.deepEqual(setAlertPrefs({ kinds: { renewal: { channels: ['sms'] } } }, 2_000).kinds.renewal.channels, ['sms'])
  })

  test('STOP turns texts off on every kind and ends the consent; START puts them back', () => {
    setAlertPrefs({ kinds: { overdraw: { channels: ['push', 'sms'] }, renewal: { channels: ['sms'] } }, smsConsent: SMS_CONSENT_LINE }, 1_000)
    const off = textsStopped(2_000)
    assert.deepEqual([off.kinds.overdraw.channels, off.kinds.renewal.channels, off.smsConsent], [['push'], [], null])
    assert.throws(() => setAlertPrefs({ kinds: { overdraw: { channels: ['sms'] } } }), /smsConsent/)
    const on = textsStarted(3_000)
    assert.deepEqual([on.kinds.overdraw.channels, on.kinds.renewal.channels, on.smsConsent], [['push', 'sms'], ['sms'], { at: 3_000, line: 'START' }])
  })

  test('consent, STOP and START are each member\'s own on shared books', () => {
    setAlertPrefs({ kinds: { overdraw: { channels: ['sms'] } }, smsConsent: SMS_CONSENT_LINE }, 1_000)
    assert.equal(alertPrefs(1_000, 'u_partner').smsConsent, null)
    assert.throws(() => setAlertPrefs({ kinds: { overdraw: { channels: ['sms'] } } }, 1_000, 'u_partner'), /smsConsent/)
    setAlertPrefs({ kinds: { renewal: { channels: ['sms'] } }, smsConsent: SMS_CONSENT_LINE }, 2_000, 'u_partner')
    textsStopped(3_000, 'u_partner')
    assert.deepEqual([alertPrefs(3_000, 'u_partner').kinds.renewal.channels, alertPrefs(3_000, 'u_partner').smsConsent], [[], null])
    assert.deepEqual([alertPrefs(3_000).kinds.overdraw.channels, alertPrefs(3_000).smsConsent?.at], [['sms'], 1_000])
    assert.deepEqual(textsStarted(4_000, 'u_partner').kinds.renewal.channels, ['sms'])
    forgetAlertMember('u_partner')
    assert.equal(alertPrefs(4_000, 'u_partner').smsConsent, null)
  })
})

// ---------- the checks on a ledger ----------

describe('the evening check and the shortfall', () => {
  let seq = 0
  const charge = (accountId: string, day: string, description: string, cents: number, category: string): void => {
    const id = `plaid:t${seq++}`
    db.insertTransactionIfNew({ id, accountId, posted: db.noon(day), amountCents: cents, description, pending: false })
    db.setTransactionFields(id, { categoryId: db.listCategories().find((c) => c.name === category)!.id, source: 'user' })
  }
  const evening = zoned(2026, 10, 3, 19, 7)
  const morning = zoned(2026, 10, 3, 8, 7)
  const at = (d: Date): number => Math.floor(d.getTime() / 1000)

  /** Checking with $52, an AT&T bill of $84 due tomorrow, rent of $1,500 in ten days, savings with $500. */
  function ledger(o: { savings?: boolean } = {}): void {
    open()
    const now = at(evening)
    db.upsertAccount({ id: 'plaid:chk', source: 'plaid', name: 'Checking', institution: 'First Platypus Bank', currency: 'USD', balanceCents: 5200, availableCents: null, balanceDate: now - 3600 })
    if (o.savings !== false) db.upsertAccount({ id: 'plaid:sav', source: 'plaid', name: 'Savings', institution: 'First Platypus Bank', currency: 'USD', balanceCents: 50000, availableCents: null, balanceDate: now - 3600 })
    for (let m = 1; m <= 4; m++) {
      charge('plaid:chk', addMonths(TOMORROW, -m), 'AT&T', -8400, 'Utilities')
      charge('plaid:chk', addMonths(addDays(TODAY, 10), -m), 'RENT LLC', -150000, 'Housing')
    }
    // No paychecks: checking is picked as the main account (else the one with more in it leads).
    setSpendSettings({ risk: 'balanced', accountId: 'plaid:chk' })
  }

  before(() => mock.timers.enable({ apis: ['Date'], now: evening.getTime() }))
  after(() => mock.timers.reset())

  test('fires once in the evening, names the bill, picks the move and hides amounts by default', () => {
    ledger()
    const now = at(evening)
    assert.ok(getSpendable().items.some((i) => i.name === 'AT&T' && i.day === TOMORROW), 'AT&T is forecast for tomorrow')
    const r = ledgerEveningCheck({ now })
    assert.equal(r.held, false)
    assert.deepEqual(
      r.alerts.map((a) => [a.kind, a.title, a.body, a.channels, a.replies]),
      [['overdraw', 'AT&T tomorrow would overdraw Checking', 'Move money from Savings tonight', ['push'], ['DONE']]]
    )
    assert.equal(r.alerts[0].replyLine, "Reply DONE once it's handled.")
    assert.deepEqual(ledgerEveningCheck({ now: now + 3600 }).alerts, [])
    // The shortfall (rent, before payday) doesn't come the same day.
    assert.deepEqual(ledgerAlertCheck({ now: now + 7200 }).alerts.filter((a) => a.kind === 'shortfall'), [])
  })

  test('on shared books each member gets it once, under their own preferences', () => {
    ledger()
    const now = at(evening)
    setAlertPrefs({ showAmounts: true, kinds: { overdraw: { channels: ['email'] } } }, now, 'u_partner')
    const owner = ledgerEveningCheck({ now })
    const partner = ledgerEveningCheck({ now, member: 'u_partner' })
    assert.deepEqual(owner.alerts.map((a) => [a.title, a.channels]), [['AT&T tomorrow would overdraw Checking', ['push']]])
    assert.deepEqual(partner.alerts.map((a) => [a.title, a.body, a.channels]), [[`AT&T $84 tomorrow takes Checking to ${minus}$32`, 'Move $40 from Savings tonight', ['email']]])
    assert.deepEqual(ledgerEveningCheck({ now, member: 'u_partner' }).alerts, [])
    // A member who turned it off isn't told; the others still were.
    setAlertPrefs({ kinds: { overdraw: { on: false } } }, now, 'u_other')
    assert.deepEqual(ledgerEveningCheck({ now, member: 'u_other' }).alerts, [])
  })

  test('with amounts on, the words carry them; without savings, the biller is asked', () => {
    ledger({ savings: false })
    setAlertPrefs({ showAmounts: true })
    const [a] = ledgerEveningCheck({ now: at(evening) }).alerts
    assert.equal(a.title, `AT&T $84 tomorrow takes Checking to ${minus}$32`)
    assert.equal(a.body, 'Ask AT&T to move the date')
  })

  test('a shortfall sent this morning means no overdraw alert tonight', () => {
    ledger()
    setAlertPrefs({ kinds: { overdraw: { on: false } } })
    assert.deepEqual(ledgerAlertCheck({ now: at(morning) }).alerts.filter((a) => a.kind === 'shortfall').length, 1)
    setAlertPrefs({ kinds: { overdraw: { on: true } } })
    assert.deepEqual(ledgerEveningCheck({ now: at(evening) }).alerts, [])
  })

  test('the morning shortfall waits for tonight\'s overdraw alert when that covers it; DONE quiets both', () => {
    ledger()
    assert.deepEqual(ledgerAlertCheck({ now: at(morning), eveningAhead: true }).alerts.filter((a) => a.kind === 'shortfall'), [])
    answerTextReply(`overdraw:plaid:chk:${TOMORROW}`, 'DONE', at(morning))
    assert.deepEqual(ledgerEveningCheck({ now: at(evening) }).alerts, [])
    assert.deepEqual(ledgerAlertCheck({ now: at(evening) }).alerts.filter((a) => a.kind === 'shortfall'), [])
  })

  test('a yearly subscription is found from two years of payments and reminded once, in the morning check', () => {
    ledger()
    for (const n of [1, 2]) charge('plaid:chk', addMonths(addDays(TODAY, 2), -12 * n), 'Amazon Prime', -13900, 'Subscriptions')
    const renewals = (now: number): string[] => ledgerAlertCheck({ now }).alerts.filter((a) => a.kind === 'renewal').map((a) => `${a.title} | ${a.replyLine}`)
    assert.deepEqual(renewals(at(morning)), ['Amazon Prime renews on Thursday | Reply HOW for how to cancel, KEEP to stop these.'])
    assert.deepEqual(renewals(at(evening)), [])
  })

  test('Spendable keeps a subscription asked to cancel until its date (and the grace) passes with no charge', () => {
    ledger()
    // Netflix, last charged Sep 28: due Oct 28, not charged since, so still expected (today, as overdue).
    for (let m = 0; m < 4; m++) charge('plaid:chk', addMonths('2026-09-28', -m), 'Netflix', -1549, 'Subscriptions')
    const counted = (): boolean => getSpendable().items.some((i) => i.name === 'Netflix')
    assert.equal(counted(), true)
    setRenewalMark('netflix|-', { cancelAt: db.noon('2026-10-20') })
    assert.equal(counted(), false)
    // Asked after the last date it was due: still counted.
    setRenewalMark('netflix|-', { cancelAt: db.noon('2026-11-01') })
    assert.equal(counted(), true)
  })

  test('quiet hours hold it for the next hour; a hidden vendor is never named', () => {
    ledger()
    setAlertPrefs({ quietHours: { start: '19:00', end: '20:00' } })
    assert.equal(ledgerEveningCheck({ now: at(evening) }).held, true)
    setAlertPrefs({ quietHours: null })
    setHiddenVendors(['AT&T'])
    const [a] = ledgerEveningCheck({ now: at(evening) }).alerts
    assert.equal(a.title, 'Utilities tomorrow would overdraw Checking')
    setHiddenVendors([])
  })
})
