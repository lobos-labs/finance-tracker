import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { configureLicense } from '../src/main/license.ts'
import { addDays } from '../src/main/calendar.ts'
import { setHiddenVendors } from '../src/main/privacy.ts'
import { checkAlerts, type Alert } from '../src/main/alerts.ts'
import { alertPrefs, alertText, defaultAlertPrefs, forgetAlertMember, ledgerAlertCheck, setAlertPrefs, shortfallAlert, whenSaid, wireKind } from '../src/main/ledgerAlerts.ts'
import { HANDLERS, methodKind } from '../src/main/handlers/table.ts'
import { ALERT_KINDS, SMS_CONSENT_LINE, type SpendAccount, type SpendDay, type Spendable } from '../src/shared/types.ts'
import { clockOn } from './days.ts'

// The hosted ledger's alerts: preferences (each kind on or off, its channels
// and thresholds; amounts off by default), the shortfall rule, the words, and
// the check that runs the desktop's engine with them.

configureLicense({ dev: true })
const dir = mkdtempSync(join(tmpdir(), 'finance-ledger-alerts-'))
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400

describe('preferences', () => {
  before(() => db.openDb(join(dir, 'prefs.db')))
  after(() => db.closeDb())

  test('amounts are off by default; every kind is on, by push, with its thresholds', () => {
    const p = alertPrefs()
    assert.equal(p.showAmounts, false)
    assert.deepEqual(Object.keys(p.kinds).sort(), [...ALERT_KINDS].sort())
    for (const k of ALERT_KINDS) assert.deepEqual([p.kinds[k].on, p.kinds[k].channels], [true, ['push']], k)
    assert.deepEqual(p.kinds.shortfall, { on: true, channels: ['push'], cushionCents: null, days: null })
    assert.equal(p.kinds.bill_due.days, 3)
    assert.equal(p.kinds.large_charge.minCents, null)
    assert.equal(p.kinds.new_merchant.minCents, 2500)
    assert.deepEqual([p.quietHours, p.pausedUntil], [null, null])
    assert.deepEqual(p, defaultAlertPrefs())
  })

  test('each kind keeps its own switch, channels and thresholds', () => {
    const p = setAlertPrefs({
      showAmounts: true,
      kinds: {
        shortfall: { channels: ['sms', 'push', 'email'], cushionCents: 5000, days: 7 },
        large_charge: { minCents: 50000, channels: ['email'] },
        price_change: { on: false }
      },
      quietHours: { start: '22:00', end: '07:00' },
      smsConsent: SMS_CONSENT_LINE
    })
    assert.equal(p.showAmounts, true)
    // Channels come back in one order, whatever order they were given in.
    assert.deepEqual(p.kinds.shortfall, { on: true, channels: ['push', 'sms', 'email'], cushionCents: 5000, days: 7 })
    assert.deepEqual(p.kinds.large_charge, { on: true, channels: ['email'], minCents: 50000 })
    assert.equal(p.kinds.price_change.on, false)
    assert.deepEqual(p.kinds.bill_due, defaultAlertPrefs().kinds.bill_due)
    assert.deepEqual(alertPrefs(), p)
    // A later change leaves the rest alone; null puts a threshold back to its rule.
    const q = setAlertPrefs({ kinds: { large_charge: { minCents: null } } })
    assert.deepEqual(q.kinds.large_charge, { on: true, channels: ['email'], minCents: null })
    assert.deepEqual(q.kinds.shortfall.channels, ['push', 'sms', 'email'])
  })

  test('a wrong value is refused and nothing is saved', () => {
    const before = alertPrefs()
    for (const bad of [
      { kinds: { overdraft: { on: true } } },
      { kinds: { shortfall: { channels: ['pager'] } } },
      { kinds: { shortfall: { days: 0 } } },
      { kinds: { shortfall: { cushionCents: -1 } } },
      { kinds: { bill_due: { days: 30 } } },
      { kinds: { large_charge: { minCents: 1.5 } } },
      { kinds: { double_charge: { minCents: 100 } } },
      { kinds: { bill_due: 'off' } },
      { quietHours: { start: '25:00', end: '07:00' } },
      { showAmounts: 'yes' }
    ]) {
      assert.throws(() => setAlertPrefs(bad as never), Error, JSON.stringify(bad))
    }
    assert.deepEqual(alertPrefs(), before)
  })

  test('a pause lasts its minutes, a week at most; 0 resumes', () => {
    const now = db.now()
    assert.equal(setAlertPrefs({ pauseMinutes: 60 }, now).pausedUntil, now + 3600)
    assert.equal(alertPrefs(now + 3601).pausedUntil, null)
    assert.equal(setAlertPrefs({ pauseMinutes: 99_999 }, now).pausedUntil, now + 7 * DAY)
    assert.equal(setAlertPrefs({ pauseMinutes: 0 }, now).pausedUntil, null)
  })

  test('a stored value gone wrong falls back to its default', () => {
    db.setSetting('alerts.prefs', JSON.stringify({ showAmounts: 1, kinds: { bill_due: { days: 99, channels: ['email'] }, nope: {} }, quietHours: 'x' }))
    const p = alertPrefs()
    assert.equal(p.showAmounts, false)
    assert.deepEqual(p.kinds.bill_due, { on: true, channels: ['email'], days: 3 })
    assert.equal(p.quietHours, null)
  })

  test('the handler table offers them on every host', () => {
    assert.equal(methodKind('getAlertPrefs'), 'hosted')
    assert.equal(methodKind('setAlertPrefs'), 'hosted')
    assert.ok('getAlertPrefs' in HANDLERS && 'setAlertPrefs' in HANDLERS)
  })
})

// ---------- the rules ----------

const TODAY = '2026-11-03' // a Tuesday
const days = (lows: number[], from = TODAY): SpendDay[] => lows.map((low, i) => ({ day: addDays(from, i), startCents: low, endCents: low, lowCents: low, inCents: 0, outCents: 0 }))
const spendable = (o: { lows: number[]; nextPayday?: string | null; cushionCents?: number; accountId?: string | null }): Spendable => {
  const account: SpendAccount = {
    id: 'chk',
    name: 'Checking',
    startCents: o.lows[0],
    balanceDate: 0,
    spendableCents: 0,
    lowDay: TODAY,
    nextPayday: o.nextPayday ?? null,
    perDayCents: null,
    days: days(o.lows),
    byRisk: { cautious: 0, balanced: 0, tight: 0 }
  }
  return { risk: 'cautious', cushionCents: o.cushionCents ?? 0, accountId: o.accountId === undefined ? 'chk' : o.accountId, accounts: [account], items: [] }
}

describe('the shortfall', () => {
  const none = { cushionCents: null, days: null }

  test('under zero before payday: how far under, on the lowest day, keyed by the payday', () => {
    const [a] = shortfallAlert(spendable({ lows: [5000, 2000, -4000, -1000, 90000], nextPayday: addDays(TODAY, 4) }), TODAY, none)
    assert.equal(a.key, `shortfall:chk:${addDays(TODAY, 4)}`)
    assert.equal(a.kind, 'shortfall')
    assert.deepEqual(a.facts, { cents: 4000, account: 'Checking', day: addDays(TODAY, 2) })
    assert.deepEqual(a.target, { page: 'dashboard' })
  })

  test('a low after the payday is the next window\'s', () => {
    assert.deepEqual(shortfallAlert(spendable({ lows: [5000, 2000, 3000, -1000], nextPayday: addDays(TODAY, 2) }), TODAY, none), [])
  })

  test('under the cushion counts as short; its own cushion overrides Spendable\'s', () => {
    const sp = spendable({ lows: [5000, 2000, 3000], cushionCents: 2500 })
    assert.equal(shortfallAlert(sp, TODAY, none)[0].facts?.cents, 500)
    assert.deepEqual(shortfallAlert(sp, TODAY, { cushionCents: 1000, days: null }), [])
    assert.equal(shortfallAlert(sp, TODAY, { cushionCents: 10000, days: null })[0].facts?.cents, 8000)
  })

  test('days ahead limits how far it looks; with no payday the key is the lowest day', () => {
    const sp = spendable({ lows: [5000, 4000, 3000, -100] })
    assert.deepEqual(shortfallAlert(sp, TODAY, { cushionCents: null, days: 2 }), [])
    assert.equal(shortfallAlert(sp, TODAY, { cushionCents: null, days: 3 })[0].key, `shortfall:chk:${addDays(TODAY, 3)}`)
  })

  test('nothing without a main account', () => {
    assert.deepEqual(shortfallAlert(spendable({ lows: [-100], accountId: null }), TODAY, none), [])
  })
})

describe('the words', () => {
  const alert = (o: Partial<Alert>): Alert => ({ key: 'k', kind: 'large_purchase', title: 'Large purchase', body: 'Costco · $500.00 · Checking', target: { page: 'transactions' }, ...o })
  const both = (a: Alert): [string, string] => [alertText(a, { showAmounts: false, today: TODAY }).title, alertText(a, { showAmounts: true, today: TODAY }).title]

  test('the day: today, tomorrow, its weekday within the week, its date past it', () => {
    assert.deepEqual([0, 1, 3, 6, 7].map((n) => whenSaid(TODAY, addDays(TODAY, n))), ['today', 'tomorrow', 'on Friday', 'on Monday', 'on Nov 10'])
  })

  test('amounts appear only when the account shows them', () => {
    assert.deepEqual(both(alert({ kind: 'shortfall', facts: { cents: 4000, account: 'Checking', day: addDays(TODAY, 3) } })), ["You'll be short on Friday", "You'll be $40.00 short on Friday"])
    assert.deepEqual(both(alert({ facts: { name: 'Costco', cents: -50000, account: 'Checking' } })), ['A large charge at Costco', 'A $500.00 charge at Costco'])
    assert.deepEqual(both(alert({ kind: 'new_merchant', facts: { name: 'Blue Bottle', cents: -4500, account: 'Checking' } })), ['A first charge at Blue Bottle', 'A $45.00 first charge at Blue Bottle'])
    assert.deepEqual(both(alert({ kind: 'price_change', facts: { name: 'Netflix', cents: -1799, previousCents: -1549 } })), ['Netflix changed its price', 'Netflix went from $15.49 to $17.99'])
    assert.deepEqual(both(alert({ kind: 'bill_due', facts: { name: 'Rent', cents: -150000, day: addDays(TODAY, 1) } })), ['Rent is due tomorrow', 'Rent is due tomorrow'])
    const bill = alert({ kind: 'bill_due', facts: { name: 'Rent', cents: -150000, day: addDays(TODAY, 1) } })
    assert.equal(alertText(bill, { showAmounts: false, today: TODAY }).body, 'Nov 4')
    assert.equal(alertText(bill, { showAmounts: true, today: TODAY }).body, '$1,500.00 · Nov 4')
    const dup = alert({ kind: 'possible_duplicate', facts: { name: 'Costco', cents: -4500, account: 'Checking' } })
    assert.deepEqual(alertText(dup, { showAmounts: false, today: TODAY }), { title: 'A possible double charge at Costco', body: 'Checking' })
    assert.equal(alertText(dup, { showAmounts: true, today: TODAY }).body, '$45.00 twice · Checking')
    assert.equal(alertText(alert({ kind: 'bank_signin', facts: { name: 'Chase' } }), { showAmounts: false, today: TODAY }).title, 'Chase asks you to sign in again')
  })

  test('the wire kinds; the feed check stays on the desktop', () => {
    assert.deepEqual(['large_purchase', 'possible_duplicate', 'bill_due', 'shortfall', 'feed_behind'].map((k) => wireKind(k as Alert['kind'])), ['large_charge', 'double_charge', 'bill_due', 'shortfall', null])
  })
})

// ---------- the check ----------

describe('the check', () => {
  const CHK = 'plaid:chk'
  let now = 0
  let rentDay = ''
  const titles = (r: ReturnType<typeof ledgerAlertCheck>): string[] => r.alerts.map((a) => `${a.kind}: ${a.title}`).sort()

  before(() => {
    db.openDb(join(dir, 'ledger.db'))
    now = db.now()
    const today = db.dayKey(now)
    db.upsertAccount({ id: CHK, source: 'plaid', name: 'Checking', institution: 'Test Bank', currency: 'USD', balanceCents: 10000, availableCents: null, balanceDate: now - 3600 })
    const housing = db.listCategories().find((c) => c.name === 'Housing')!.id
    // Rent each month, the next about ten days out: more than the $100 in checking.
    for (let m = 1; m <= 4; m++) {
      db.insertTransactionIfNew({ id: `rent-${m}`, accountId: CHK, posted: db.noon(addDays(today, 10)) - Math.round(m * 30.44) * DAY, amountCents: -150000, description: 'RENT LLC', pending: false })
      db.setTransactionFields(`rent-${m}`, { categoryId: housing, source: 'user' })
    }
    rentDay = addDays(today, 1)
    db.addCalendarEvent({ day: rentDay, title: 'Phone bill', amountCents: -5000, createdBy: 'user' })
  })
  after(() => db.closeDb())

  test('the first check sends the shortfall and the bill once, with no amounts', () => {
    const first = ledgerAlertCheck({ now })
    assert.equal(first.held, false)
    assert.deepEqual(titles(first).map((t) => t.replace(/ (today|tomorrow|on .+)$/, ' <day>')), ['bill_due: Phone bill is due <day>', "shortfall: You'll be short <day>"])
    assert.ok(first.alerts.every((a) => a.channels.join() === 'push' && !/\$/.test(a.title + a.body)))
    assert.deepEqual(ledgerAlertCheck({ now: now + 60 }).alerts, [])
  })

  test('quiet hours on the ledger\'s clock and a pause hold alerts back without noting them', () => {
    const clock = clockOn(new Date(now * 1000))
    const hour = Number(clock.slice(0, 2))
    const next = `${String((hour + 1) % 24).padStart(2, '0')}:00`
    setAlertPrefs({ quietHours: { start: `${String(hour).padStart(2, '0')}:00`, end: next }, kinds: { shortfall: { cushionCents: 1_000_000 } } }, now)
    assert.deepEqual(ledgerAlertCheck({ now }), { held: true, alerts: [] })
    setAlertPrefs({ quietHours: null, pauseMinutes: 30 }, now)
    assert.equal(ledgerAlertCheck({ now }).held, true)
    setAlertPrefs({ pauseMinutes: 0 }, now)
    // Same payday window: the shortfall isn't sent again, whatever the cushion.
    assert.deepEqual(ledgerAlertCheck({ now }).alerts, [])
  })

  test('large charges at the account\'s threshold, with amounts when it shows them; a switched-off kind stays quiet', () => {
    setAlertPrefs({ showAmounts: true, kinds: { large_charge: { minCents: 50000, channels: ['push', 'email'] }, new_merchant: { on: false } } }, now)
    db.upsertTransaction({ id: 'plaid:big', accountId: CHK, posted: now - 60, amountCents: -90000, description: 'BEST BUY', pending: false })
    db.upsertTransaction({ id: 'plaid:small', accountId: CHK, posted: now - 60, amountCents: -3000, description: 'CORNER CAFE', pending: false })
    const r = ledgerAlertCheck({ now })
    assert.deepEqual(
      r.alerts.map((a) => [a.kind, a.title, a.body, a.channels]),
      [['large_charge', 'A $900.00 charge at BEST BUY', 'Checking', ['push', 'email']]]
    )
    assert.deepEqual(ledgerAlertCheck({ now }).alerts, [])
  })

  test('a hidden vendor is never named', () => {
    setHiddenVendors(['Secret Shop'])
    db.upsertTransaction({ id: 'plaid:secret', accountId: CHK, posted: now - 30, amountCents: -99000, description: 'SECRET SHOP', pending: false })
    assert.deepEqual(ledgerAlertCheck({ now }).alerts, [])
    setHiddenVendors([])
  })

  test('a bank asking to sign in: once, again only after it was fixed', () => {
    const chase = [{ itemId: 'item-1', institution: 'Chase' }]
    assert.deepEqual(titles(ledgerAlertCheck({ now, signin: chase })), ['bank_signin: Chase asks you to sign in again'])
    assert.deepEqual(ledgerAlertCheck({ now, signin: chase }).alerts, [])
    assert.deepEqual(ledgerAlertCheck({ now, signin: [] }).alerts, [])
    assert.deepEqual(titles(ledgerAlertCheck({ now, signin: chase })), ['bank_signin: Chase asks you to sign in again'])
  })

  test('a kind with no channels sends nothing', () => {
    setAlertPrefs({ kinds: { bank_signin: { channels: [] } } }, now)
    assert.deepEqual(ledgerAlertCheck({ now, signin: [{ itemId: 'item-2', institution: 'Ally' }] }).alerts, [])
  })
})

describe('the desktop\'s check and Plaid', () => {
  before(() => db.openDb(join(dir, 'desktop.db')))

  test('Plaid rows are looked at; the first check that does only notes the ones already there', () => {
    const now = db.now()
    db.upsertAccount({ id: 'sf:c1:chk', source: 'simplefin', name: 'Checking', institution: null, currency: 'USD', balanceCents: 100000, availableCents: null, balanceDate: now })
    db.upsertAccount({ id: 'plaid:card', source: 'plaid', name: 'Card', institution: null, currency: 'USD', balanceCents: -1000, availableCents: null, balanceDate: now })
    const bank = { connected: true, lastSyncAt: now }
    const shown: string[] = []
    const show = (a: Alert): void => void shown.push(a.key)
    checkAlerts({ now, bank, show })
    // A store before Plaid's rows were looked at: seen holds SimpleFIN's only.
    db.setSetting('notify.seenPlaid', null)
    db.upsertTransaction({ id: 'plaid:old', accountId: 'plaid:card', posted: now - 5 * DAY, amountCents: -400000, description: 'OLD TV', pending: false })
    checkAlerts({ now, bank, show })
    assert.deepEqual(shown, [])
    db.upsertTransaction({ id: 'plaid:new', accountId: 'plaid:card', posted: now - 60, amountCents: -9900, description: 'NEW PLACE', pending: false })
    checkAlerts({ now, bank, show })
    assert.deepEqual(shown, ['new_merchant:plaid:new'])
  })
})

// ---------- a partner on the books (docs/hosted-api.md, "Household") ----------

describe('a ledger shared with a partner', () => {
  const CHK = 'plaid:chk'
  const PARTNER = 'u_partner'
  let now = 0
  const kinds = (r: ReturnType<typeof ledgerAlertCheck>): string[] => r.alerts.map((a) => a.kind).sort()

  before(() => {
    // The desktop's suite above leaves its store open.
    db.closeDb()
    db.openDb(join(dir, 'shared.db'))
    now = db.now()
    const today = db.dayKey(now)
    db.upsertAccount({ id: CHK, source: 'plaid', name: 'Checking', institution: 'Test Bank', currency: 'USD', balanceCents: 10000, availableCents: null, balanceDate: now - 3600 })
    db.addCalendarEvent({ day: addDays(today, 1), title: 'Phone bill', amountCents: -5000, createdBy: 'user' })
  })
  after(() => db.closeDb())

  test('each member keeps their own preferences; the owner\'s are the setting as it always was', () => {
    setAlertPrefs({ showAmounts: true, kinds: { bill_due: { channels: ['email'] } } }, now, PARTNER)
    assert.equal(alertPrefs(now, PARTNER).showAmounts, true)
    assert.deepEqual(alertPrefs(now, PARTNER).kinds.bill_due.channels, ['email'])
    assert.deepEqual(alertPrefs(now), defaultAlertPrefs())
    assert.ok(db.getSetting(`alerts.prefs:${PARTNER}`))
    // The handlers read and write the caller's own.
    const run = (method: 'getAlertPrefs' | 'setAlertPrefs', member: string | null, ...args: unknown[]) =>
      (HANDLERS[method].run as (ctx: unknown, ...a: unknown[]) => ReturnType<typeof alertPrefs>)({ member }, ...args)
    assert.equal(run('getAlertPrefs', PARTNER).showAmounts, true)
    assert.equal(run('getAlertPrefs', null).showAmounts, false)
    run('setAlertPrefs', null, { kinds: { bill_due: { on: false } } })
    assert.equal(alertPrefs(now).kinds.bill_due.on, false)
    assert.equal(alertPrefs(now, PARTNER).kinds.bill_due.on, true)
  })

  test('each member is checked under their own preferences, and told each thing once', () => {
    // The owner has bills off (above); the partner hears of the bill, by email.
    const owner = ledgerAlertCheck({ now })
    const partner = ledgerAlertCheck({ now, member: PARTNER })
    assert.deepEqual(kinds(owner), [])
    assert.deepEqual(kinds(partner), ['bill_due'])
    assert.deepEqual(partner.alerts[0].channels, ['email'])
    assert.deepEqual(ledgerAlertCheck({ now, member: PARTNER }).alerts, [])

    // A large charge: both look at it, each by their own threshold; seeing it for one isn't seeing it for the other.
    setAlertPrefs({ kinds: { large_charge: { minCents: 50000 }, new_merchant: { on: false } } }, now)
    setAlertPrefs({ kinds: { large_charge: { minCents: 100000 }, new_merchant: { on: false } } }, now, PARTNER)
    db.upsertTransaction({ id: 'plaid:tv', accountId: CHK, posted: now - 60, amountCents: -90000, description: 'BEST BUY', pending: false })
    assert.deepEqual(kinds(ledgerAlertCheck({ now })), ['large_charge'])
    assert.deepEqual(kinds(ledgerAlertCheck({ now, member: PARTNER })), [])
    db.upsertTransaction({ id: 'plaid:sofa', accountId: CHK, posted: now - 30, amountCents: -150000, description: 'SOFA CO', pending: false })
    assert.deepEqual(kinds(ledgerAlertCheck({ now, member: PARTNER })), ['large_charge'])
    assert.deepEqual(kinds(ledgerAlertCheck({ now })), ['large_charge'])

    // A bank asking to sign in reaches each once, and each again once it was fixed and asks again.
    const ally = [{ itemId: 'item-9', institution: 'Ally' }]
    assert.deepEqual(kinds(ledgerAlertCheck({ now, signin: ally })), ['bank_signin'])
    assert.deepEqual(kinds(ledgerAlertCheck({ now, signin: ally, member: PARTNER })), ['bank_signin'])
    ledgerAlertCheck({ now, signin: [], member: PARTNER })
    assert.deepEqual(kinds(ledgerAlertCheck({ now, signin: ally, member: PARTNER })), ['bank_signin'])
    assert.deepEqual(ledgerAlertCheck({ now, signin: ally }).alerts, [])
  })

  test('a partner\'s quiet hours and pause hold only them', () => {
    setAlertPrefs({ pauseMinutes: 60 }, now, PARTNER)
    assert.equal(ledgerAlertCheck({ now, member: PARTNER }).held, true)
    assert.equal(ledgerAlertCheck({ now }).held, false)
  })

  test('a partner who leaves takes their settings with them', () => {
    forgetAlertMember(PARTNER, ['alerts.morningDay:u_partner'])
    db.setSetting('alerts.morningDay', '2026-11-03')
    assert.equal(db.getSetting(`alerts.prefs:${PARTNER}`), null)
    assert.equal(db.getSetting(`alerts.pausedUntil:${PARTNER}`), null)
    assert.equal(db.getSetting(`notify.sent:${PARTNER}`), null)
    assert.equal(db.getSetting(`notify.seen:${PARTNER}`), null)
    assert.deepEqual(alertPrefs(now, PARTNER), defaultAlertPrefs())
    // The owner's are untouched.
    assert.ok(db.getSetting('alerts.prefs'))
    assert.ok(db.getSetting('notify.sent'))
  })
})
