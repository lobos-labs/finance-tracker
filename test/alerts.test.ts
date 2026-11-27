import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from '../src/main/db.ts'
import { configureBuild } from '../src/main/devBuild.ts'
import { configureLicense } from '../src/main/license.ts'
import { setHiddenVendors, setHideNumbersOnOpen } from '../src/main/privacy.ts'
import { APP_ID, appUserModelId } from '../src/main/build.ts'
import { setReminder } from '../src/main/credit.ts'
import { addDays } from '../src/main/calendar.ts'
import {
  alertsFor,
  billAlerts,
  checkAlerts,
  closeAction,
  creditAlert,
  feedAlert,
  inQuietHours,
  keepRunningDefault,
  loginItemWanted,
  MASK,
  MAX_PER_CHECK,
  notificationSettings,
  noteTransactionsSeen,
  pick,
  pruneSeen,
  pruneSent,
  SENT_RETENTION_DAYS,
  setNotificationSettings,
  setNumbersHidden,
  transactionAlerts,
  type Alert,
  type AlertInputs,
  type FreshTxn,
  type Privacy
} from '../src/main/alerts.ts'
import { NOTIFY_KINDS, type CalendarItem, type NotifyKind } from '../src/shared/types.ts'
import { clockOn, zoned } from './days.ts'

// Desktop notifications: each kind fires once, quiet hours and the pause hold
// them back, hidden numbers are masked, hidden vendors never named, sent keys
// expire; and closing the window hides it to the tray by build type.

configureLicense({ dev: true })
const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'finance-alerts-'))
after(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400
const TODAY = '2026-10-21'
const open: Privacy = { numbersHidden: false, hidden: () => false }
const allOn = Object.fromEntries(NOTIFY_KINDS.map((k) => [k, true])) as Record<NotifyKind, boolean>

const item = (o: Partial<CalendarItem>): CalendarItem => ({ key: 'event:1', day: TODAY, title: 'Rent', amountCents: -150000, kind: 'reminder', notes: null, eventId: 1, start: null, end: null, task: false, done: false, ...o })
const txn = (o: Partial<FreshTxn>): FreshTxn => ({ id: 'sf:c:a:1', posted: 1_792_000_000, cents: -4500, merchant: null, description: 'BLUE BOTTLE', account: 'Checking', seriesKey: 'blue bottle|-', spending: true, firstAtMerchant: false, ...o })

describe('the close button', () => {
  test('keeps running by default in a shipped build, quits in a development build', () => {
    assert.equal(keepRunningDefault(false), true)
    assert.equal(keepRunningDefault(true), false)
  })
  test('hides to the tray only while keep running is on and the app is not quitting', () => {
    assert.equal(closeAction({ quitting: false, keepRunning: true }), 'hide')
    assert.equal(closeAction({ quitting: false, keepRunning: false }), 'close')
    assert.equal(closeAction({ quitting: true, keepRunning: true }), 'close')
  })
  test('Windows shows the notifications under the installer app id', () => {
    const appId = (file: string): string => /^appId:\s*(\S+)/m.exec(readFileSync(join(here, '..', file), 'utf8'))![1]
    assert.equal(APP_ID, appId('electron-builder.yml'))
    // An unpackaged build's shortcut carries no id: it goes by its exe.
    const exe = join('C:', 'repo', 'node_modules', 'electron', 'dist', 'electron.exe')
    assert.equal(appUserModelId(true, exe), APP_ID)
    assert.equal(appUserModelId(false, exe), exe)
  })
  test('the login item follows the setting both ways where it is offered, and is left alone where not', () => {
    assert.equal(loginItemWanted({ loginOffered: true, openAtLogin: true }), true)
    assert.equal(loginItemWanted({ loginOffered: true, openAtLogin: false }), false)
    assert.equal(loginItemWanted({ loginOffered: false, openAtLogin: true }), null)
    // Electron's side: each launch applies it, and Delete all data turns it off before quitting.
    const source = (file: string): string => readFileSync(join(here, '..', 'src', 'main', file), 'utf8')
    assert.match(source('background.ts'), /const want = loginItemWanted\(notificationSettings\(\)\)\s+if \(want !== null\) applyLoginItem\(want\)/)
    const wipe = source('wipe.ts')
    assert.ok(wipe.includes('applyLoginItem(false)') && wipe.indexOf('applyLoginItem(false)') < wipe.lastIndexOf('app.quit()'))
  })
  test('a hidden window comes back: a second launch on Windows, the Dock icon or a second open on macOS', () => {
    const index = readFileSync(join(here, '..', 'src', 'main', 'index.ts'), 'utf8')
    assert.match(index, /app\.on\('second-instance', showWindow\)/)
    assert.match(index, /app\.on\('activate', showWindow\)/)
  })
  test('no session keeps a spell-check language, so no dictionary is ever fetched', () => {
    const index = readFileSync(join(here, '..', 'src', 'main', 'index.ts'), 'utf8')
    assert.match(index, /app\.on\('session-created', \(created\) => created\.setSpellCheckerLanguages\(\[\]\)\)/)
    // Before the app is ready: the first session is made after it.
    assert.ok(index.indexOf("app.on('session-created'") < index.indexOf('app.whenReady()'))
  })
})

describe('the rules', () => {
  test('a bill fires from three days ahead, with its amount and day', () => {
    const items = [item({ day: '2026-10-24', key: 'recurring:rent|-:2026-10-24', kind: 'bill' }), item({ day: '2026-10-25', key: 'event:2' }), item({ day: TODAY, key: 'event:3', title: 'Water' })]
    const a = billAlerts(items, TODAY, open)
    assert.deepEqual(
      a.map((x) => [x.title, x.body]),
      [
        ['Due in 3 days', 'Rent · $1,500.00 · Oct 24'],
        ['Due today', 'Water · $1,500.00 · Oct 21']
      ]
    )
    assert.deepEqual(a[0].target, { page: 'calendar' })
  })
  test('paydays, transfers, reminders without an amount and done to-dos are not bills', () => {
    const items = [item({ kind: 'income', amountCents: 300000 }), item({ kind: 'transfer' }), item({ amountCents: null }), item({ task: true, done: true })]
    assert.deepEqual(billAlerts(items, TODAY, open), [])
  })
  test('hidden numbers are masked and a hidden vendor is never named', () => {
    const p: Privacy = { numbersHidden: true, hidden: (n) => !!n && /acme/i.test(n) }
    assert.deepEqual(
      billAlerts([item({}), item({ key: 'event:2', title: 'Acme Gym' })], TODAY, p).map((a) => a.body),
      [`Rent · ${MASK} · Oct 21`]
    )
    const fresh = [txn({ id: 'a', firstAtMerchant: true }), txn({ id: 'b', firstAtMerchant: true, description: 'ACME STORE #12' })]
    const t = transactionAlerts({ fresh, issues: [], series: [] }, p)
    assert.deepEqual(
      t.map((a) => a.body),
      [`BLUE BOTTLE · ${MASK} · Checking`]
    )
  })
  test('a transaction is named in one alert at most: a double charge, then a large purchase, then a new merchant', () => {
    const fresh = [txn({ id: 'd1', cents: -1199, description: 'SPOTIFY' }), txn({ id: 'd2', cents: -1199, description: 'SPOTIFY' }), txn({ id: 'big', cents: -90000, description: 'BEST BUY', firstAtMerchant: true }), txn({ id: 'nm', firstAtMerchant: true }), txn({ id: 'small', cents: -1200, firstAtMerchant: true }), txn({ id: 'netflix', cents: -1799, seriesKey: 'netflix|-', description: 'NETFLIX' })]
    const issues = [
      { key: 'possible_duplicate:d1:d2', kind: 'possible_duplicate', transaction_ids: ['d1', 'd2'] },
      { key: 'large_purchase:big', kind: 'large_purchase', transaction_ids: ['big'] },
      { key: 'large_purchase:old', kind: 'large_purchase', transaction_ids: ['old'] },
      { key: 'price_change:netflix|-:1', kind: 'price_change', recurring_key: 'netflix|-' },
      { key: 'price_change:hulu|-:1', kind: 'price_change', recurring_key: 'hulu|-' }
    ]
    const series = [{ key: 'netflix|-', name: 'Netflix', lastCents: -1799, previousCents: -1549 }]
    const a = transactionAlerts({ fresh, issues, series }, open)
    assert.deepEqual(
      a.map((x) => [x.kind, x.body]),
      [
        ['possible_duplicate', 'SPOTIFY · $11.99 twice · Checking'],
        ['large_purchase', 'BEST BUY · $900.00 · Checking'],
        ['new_merchant', 'BLUE BOTTLE · $45.00 · Checking'],
        ['price_change', 'Netflix · $15.49 → $17.99']
      ]
    )
    assert.deepEqual(a[1].target, { page: 'transactions', search: 'BEST BUY', month: db.dayKey(1_792_000_000).slice(0, 7) })
    assert.deepEqual(a[3].target, { page: 'recurring' })
  })
  test('the bank feed is behind after three days without a sync, while connected', () => {
    const now = 1_792_000_000
    assert.equal(feedAlert({ connected: true, lastSyncAt: now - 2 * DAY }, now).length, 0)
    assert.equal(feedAlert({ connected: false, lastSyncAt: now - 9 * DAY }, now).length, 0)
    assert.equal(feedAlert({ connected: true, lastSyncAt: null }, now).length, 0)
    const [a] = feedAlert({ connected: true, lastSyncAt: now - 3 * DAY }, now)
    assert.equal(a.key, `feed_behind:${now - 3 * DAY}`)
    assert.deepEqual(a.target, { page: 'accounts' })
  })
  test('the credit reminder comes once a month from its day on, unless a score is recent', () => {
    assert.deepEqual(creditAlert('2026-10-04', 5, null), [])
    assert.equal(creditAlert('2026-10-05', 5, null)[0].key, 'credit_reminder:2026-10')
    assert.equal(creditAlert('2026-10-05', 5, null)[0].body, 'None recorded')
    assert.deepEqual(creditAlert('2026-10-21', 5, '2026-10-10'), [])
    assert.equal(creditAlert('2026-10-21', 5, '2026-09-10')[0].body, 'Last recorded Sep 10')
    assert.deepEqual(creditAlert('2026-10-21', 5, undefined), [])
    // The Credit page's reminder day; none while it's off, the month's last day when it's shorter.
    assert.deepEqual(creditAlert('2026-10-21', null, null), [])
    assert.deepEqual(creditAlert('2026-10-30', 31, null), [])
    assert.equal(creditAlert('2026-09-30', 31, null).length, 1)
  })
  test('quiet hours, within a day and across midnight', () => {
    const at = (h: number, m = 0): Date => zoned(2026, 9, 21, h, m)
    const night = { start: '22:00', end: '07:00' }
    assert.equal(inQuietHours(at(23), night), true)
    assert.equal(inQuietHours(at(6, 59), night), true)
    assert.equal(inQuietHours(at(7), night), false)
    assert.equal(inQuietHours(at(12), night), false)
    const lunch = { start: '12:00', end: '13:30' }
    assert.equal(inQuietHours(at(12, 45), lunch), true)
    assert.equal(inQuietHours(at(13, 30), lunch), false)
    assert.equal(inQuietHours(at(3), null), false)
    assert.equal(inQuietHours(at(3), { start: '09:00', end: '09:00' }), false)
  })
  test('only switched-on kinds not sent before, at most a few at once', () => {
    const alert = (key: string, kind: NotifyKind = 'bill_due'): Alert => ({ key, kind, title: '', body: '', target: { page: 'calendar' } })
    const list = [alert('a'), alert('a'), alert('b', 'new_merchant'), alert('c'), ...Array.from({ length: 8 }, (_, i) => alert(`x${i}`))]
    const { show, drop } = pick(list, { ...allOn, new_merchant: false }, { c: 1 })
    assert.deepEqual(
      show.map((a) => a.key),
      ['a', 'x0', 'x1', 'x2', 'x3']
    )
    assert.equal(show.length, MAX_PER_CHECK)
    assert.deepEqual(
      drop.map((a) => a.key),
      ['x4', 'x5', 'x6', 'x7']
    )
  })
  test('sent keys expire after the retention window; seen transactions after the fresh window', () => {
    const now = 1_792_000_000
    const kept = pruneSent({ old: now - SENT_RETENTION_DAYS * DAY, recent: now - (SENT_RETENTION_DAYS - 1) * DAY }, now)
    assert.deepEqual(Object.keys(kept), ['recent'])
    assert.deepEqual(Object.keys(pruneSeen({ a: now - 41 * DAY, b: now - 5 * DAY }, now)), ['b'])
  })
  test('the alerts come most pressing first', () => {
    const now = Math.floor(new Date(`${TODAY}T12:00:00`).getTime() / 1000)
    const inp: AlertInputs = { now, today: TODAY, calendar: [item({})], fresh: [txn({ firstAtMerchant: true })], issues: [], series: [], bank: { connected: true, lastSyncAt: now - 5 * DAY }, creditDay: 1, lastScoreDay: null }
    assert.deepEqual(
      alertsFor(inp, open).map((a) => a.kind),
      ['feed_behind', 'bill_due', 'new_merchant', 'credit_reminder']
    )
  })
})

describe('the check', () => {
  const ACCOUNT = 'sf:c1:chk'
  let seq = 0
  const now = (): number => db.now()
  const bankTxn = (description: string, cents: number, daysAgo: number): string => {
    const id = `${ACCOUNT}:t${++seq}`
    db.upsertTransaction({ id, accountId: ACCOUNT, posted: now() - daysAgo * DAY, amountCents: cents, description, pending: false })
    return id
  }
  const shown: Alert[] = []
  const bank = { connected: true, lastSyncAt: 0 }
  const check = (): Alert[] => checkAlerts({ bank, show: (a) => shown.push(a) })
  const kinds = (list: Alert[]): string[] => list.map((a) => a.kind).sort()
  // Tomorrow by the calendar: a day of seconds on can be today or two days on around a clock change.
  let rentDay = ''

  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
    db.openDb(join(dir, 'finance.db'))
    rentDay = addDays(db.dayKey(now()), 1)
    db.addCalendarEvent({ day: rentDay, title: 'Rent', amountCents: -150000, createdBy: 'user' })
    bank.lastSyncAt = now() - 4 * DAY
  })
  beforeEach(() => {
    shown.length = 0
  })

  test('nothing is checked before the app has an account', () => {
    assert.deepEqual(check(), [])
    assert.equal(db.getSetting('notify.sent'), null)
    db.upsertAccount({ id: ACCOUNT, source: 'simplefin', name: 'Checking', institution: null, currency: 'USD', balanceCents: 100000, availableCents: null, balanceDate: now() })
    // History: a monthly Netflix, and an older big purchase the first check must not announce.
    // Netflix's last charge is 33 days back (32 by the calendar across a clock change), so its next one,
    // a month on (28 to 31 days), is past on any date: no Netflix bill is due in the window.
    for (let m = 6; m >= 1; m--) bankTxn('NETFLIX.COM', -1549, m * 30 + 3)
    bankTxn('APPLE STORE', -120000, 10)
  })

  test('the first check notes the transactions there and the credit reminder of the month, and sends the rest once', () => {
    const first = check()
    assert.deepEqual(kinds(first), ['bill_due', 'feed_behind'])
    assert.equal(first.find((a) => a.kind === 'bill_due')!.body, `Rent · $1,500.00 · ${new Date(`${rentDay}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
    assert.equal(first.find((a) => a.kind === 'bill_due')!.title, 'Due tomorrow')
    assert.deepEqual(check(), [])
    assert.equal(shown.length, 2)
  })

  test('the credit reminder comes once in a month it was not noted for', () => {
    const sent = JSON.parse(db.getSetting('notify.sent')!) as Record<string, number>
    const month = db.dayKey(now()).slice(0, 7)
    assert.ok(`credit_reminder:${month}` in sent)
    delete sent[`credit_reminder:${month}`]
    db.setSetting('notify.sent', JSON.stringify(sent))
    // It follows the Credit page's reminder: nothing while that's off.
    assert.deepEqual(check(), [])
    setReminder(1)
    const [a, ...rest] = check()
    assert.deepEqual([a.kind, a.body, rest.length], ['credit_reminder', 'None recorded', 0])
    assert.deepEqual(a.target, { page: 'credit' })
    assert.deepEqual(check(), [])
  })

  test('new bank transactions fire each kind once', () => {
    bankTxn('NETFLIX.COM', -1799, 1)
    bankTxn('BEST BUY #12', -90000, 1)
    bankTxn('BLUE BOTTLE COFFEE', -4500, 1)
    bankTxn('SPOTIFY USA', -1199, 1)
    bankTxn('SPOTIFY USA', -1199, 1)
    // An import, a pending charge and a small one at a new place are not announced.
    db.upsertTransaction({ id: `${ACCOUNT}:csv:x1`, accountId: ACCOUNT, posted: now() - DAY, amountCents: -70000, description: 'CSV THING', pending: false })
    db.upsertTransaction({ id: `${ACCOUNT}:p1`, accountId: ACCOUNT, posted: now(), amountCents: -80000, description: 'PENDING THING', pending: true })
    bankTxn('CORNER SHOP', -900, 1)
    const second = check()
    assert.deepEqual(kinds(second), ['large_purchase', 'new_merchant', 'possible_duplicate', 'price_change'])
    assert.equal(second.find((a) => a.kind === 'large_purchase')!.body, 'BEST BUY #12 · $900.00 · Checking')
    assert.equal(second.find((a) => a.kind === 'price_change')!.body, 'NETFLIX.COM · $15.49 → $17.99')
    assert.deepEqual(check(), [])
  })

  test('quiet hours and a pause hold alerts back until they end', () => {
    const t = new Date()
    setNotificationSettings({ quietHours: { start: clockOn(new Date(t.getTime() - 3600_000)), end: clockOn(new Date(t.getTime() + 3600_000)) } })
    bankTxn('TACO PLACE', -3000, 0)
    assert.deepEqual(check(), [])
    setNotificationSettings({ quietHours: null, pauseMinutes: 60 })
    assert.ok(notificationSettings().pausedUntil! > now())
    assert.deepEqual(check(), [])
    setNotificationSettings({ pauseMinutes: 0 })
    assert.equal(notificationSettings().pausedUntil, null)
    assert.deepEqual(kinds(check()), ['new_merchant'])
  })

  test('a switched-off kind stays quiet; hidden numbers mask; a hidden vendor is skipped', () => {
    setNotificationSettings({ kinds: { new_merchant: false } })
    bankTxn('BAGEL SHOP', -3000, 0)
    assert.deepEqual(check(), [])
    setNotificationSettings({ kinds: { new_merchant: true } })

    setHideNumbersOnOpen(true)
    bankTxn('RAMEN BAR', -3000, 0)
    assert.equal(check()[0].body, `RAMEN BAR · ${MASK} · Checking`)
    setHideNumbersOnOpen(false)
    // The sidebar's eye counts as well.
    setNumbersHidden(true)
    bankTxn('PHO HOUSE', -3000, 0)
    assert.equal(check()[0].body, `PHO HOUSE · ${MASK} · Checking`)
    setNumbersHidden(false)

    setHiddenVendors(['Sushi Spot'])
    bankTxn('SUSHI SPOT 44', -3000, 0)
    assert.deepEqual(check(), [])
  })

  test('a split purchase is one alert, at its whole amount', () => {
    const id = bankTxn('COSTMART #9', -4200, 0)
    db.splitTransaction(id, [{ amountCents: -3000, categoryId: null }, { amountCents: -1200, categoryId: null }])
    const [a, ...rest] = check()
    assert.deepEqual([a.kind, a.body, rest.length], ['new_merchant', 'COSTMART #9 · $42.00 · Checking', 0])
  })

  test('a busy app leaves new transactions for the next check; a first sync is only noted', () => {
    bankTxn('PIZZA PALACE', -3000, 0)
    assert.deepEqual(checkAlerts({ bank, busy: true, show: () => {} }), [])
    assert.deepEqual(kinds(check()), ['new_merchant'])
    bankTxn('NEW BANK HISTORY', -60000, 2)
    noteTransactionsSeen()
    assert.deepEqual(check(), [])
  })

  test('a hidden account\'s rows are noted, so unhiding it announces nothing old', () => {
    const CARD = 'sf:c1:card'
    db.upsertAccount({ id: CARD, source: 'simplefin', name: 'Card', institution: null, currency: 'USD', balanceCents: -96000, availableCents: null, balanceDate: now() })
    check()
    db.updateAccount(CARD, { hidden: true })
    db.upsertTransaction({ id: `${CARD}:f1`, accountId: CARD, posted: now() - 25 * DAY, amountCents: -90000, description: 'FURNITURE BARN', pending: false })
    db.upsertTransaction({ id: `${CARD}:g1`, accountId: CARD, posted: now() - 20 * DAY, amountCents: -6000, description: 'GARDEN STORE', pending: false })
    assert.deepEqual(check(), [])
    db.updateAccount(CARD, { hidden: false })
    assert.deepEqual(check(), [])
    db.upsertTransaction({ id: `${CARD}:n1`, accountId: CARD, posted: now(), amountCents: -3000, description: 'NOODLE BAR', pending: false })
    assert.deepEqual(kinds(check()), ['new_merchant'])
  })

  test('an account seen for the first time (a bank added) brings its history quietly', () => {
    const LOAN = 'sf:c2:chk'
    db.upsertAccount({ id: LOAN, source: 'simplefin', name: 'Second bank', institution: null, currency: 'USD', balanceCents: 10000, availableCents: null, balanceDate: now() })
    db.upsertTransaction({ id: `${LOAN}:t1`, accountId: LOAN, posted: now() - 35 * DAY, amountCents: -45000, description: 'OLD TUITION PAYMENT', pending: false })
    db.upsertTransaction({ id: `${LOAN}:t2`, accountId: LOAN, posted: now() - 3 * DAY, amountCents: -95000, description: 'BIG OLD THING', pending: false })
    assert.deepEqual(check(), [])
    db.upsertTransaction({ id: `${LOAN}:t3`, accountId: LOAN, posted: now(), amountCents: -4000, description: 'BOOK SHOP', pending: false })
    assert.deepEqual(kinds(check()), ['new_merchant'])
  })

  test('old sent keys are dropped from the store', () => {
    db.setSetting('notify.sent', JSON.stringify({ ancient: now() - (SENT_RETENTION_DAYS + 1) * DAY, fresh: now() }))
    check()
    const sent = JSON.parse(db.getSetting('notify.sent')!) as Record<string, number>
    assert.ok(!('ancient' in sent))
    assert.ok('fresh' in sent)
  })

  test('keep running and open at login by build type', () => {
    db.setSetting('notify.keepRunning', null)
    configureBuild({ packaged: false })
    assert.equal(notificationSettings().keepRunning, false)
    assert.equal(notificationSettings().loginOffered, false)
    assert.throws(() => setNotificationSettings({ openAtLogin: true }), /installed app/)
    assert.equal(setNotificationSettings({ keepRunning: true }).keepRunning, true)
    db.setSetting('notify.keepRunning', null)
    configureBuild({ packaged: true })
    assert.equal(notificationSettings().keepRunning, true)
    assert.equal(notificationSettings().loginOffered, true)
    assert.equal(setNotificationSettings({ openAtLogin: true }).openAtLogin, true)
    assert.equal(setNotificationSettings({ keepRunning: false }).keepRunning, false)
    configureBuild({ packaged: false })
  })

  test('settings are checked: times, unknown kinds', () => {
    assert.throws(() => setNotificationSettings({ quietHours: { start: '25:00', end: '07:00' } }), /Quiet hours/)
    const s = setNotificationSettings({ kinds: { bogus: false } as never })
    assert.deepEqual(Object.keys(s.kinds), [...NOTIFY_KINDS])
  })
})
