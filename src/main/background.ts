import { app, Menu, nativeImage, Notification, shell, Tray, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { checkAlerts, closeAction, heldBack, HIDDEN_ARG, loginItemWanted, notificationSettings, noteTransactionsSeen, setNotificationSettings, type Alert } from './alerts'
import { applyLoginItem } from './ipc-alerts'
import { appUserModelId } from './build'
import { errorTag, log } from './log'
import { tellsOfUpdate } from './updateFeed'
import { holdUpdate, installUpdate, onUpdateNews, updateOut, updateReady } from './updater'
import * as feed from './bankFeed'
import * as simplefin from './simplefin'
import { APP_NAME } from '../shared/app'
import type { OpenPageTarget } from '../shared/types'

// Running in the background: the tray icon and its menu, closing the window
// to the tray, the bank sync's schedule, the alert checks and the months'
// closes while the app runs (in the window or the tray), and showing the
// notifications alerts.ts decides on. Started from index.ts.

// Bank data older than this is synced again, after launch and while the app keeps running.
const AUTO_SYNC_AFTER_HOURS = 12
// The bridge asks apps to fetch at a random minute rather than on launch or
// on the hour, so a sync waits up to this long first.
const SYNC_DELAY_MS = 10 * 60_000
const BANK_CHECK_EVERY_MS = 3600_000
// An automatic sync that failed (offline, the bridge down) waits this long before the next try.
const RETRY_AFTER_FAILURE_MS = 3 * 3600_000
const FIRST_ALERT_CHECK_MS = 15_000
const ALERT_CHECK_EVERY_MS = 3600_000
const CLOSE_CHECK_EVERY_MS = 3600_000
const PAUSE_MINUTES = 60
/** Notifications kept referenced, so a click still reaches its handler. */
const LIVE_MAX = 50

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

let quitting = false
let tray: Tray | null = null
let getWindow: () => BrowserWindow | null = () => null
let syncBank: () => Promise<unknown> = () => Promise.resolve()
let busy: () => boolean = () => false
const live: Notification[] = []
/** The update the person was last told of, and when; and the notification that said it. */
let toldUpdate: { version: string; at: number } | null = null
let updateNote: Notification | null = null

/** Windows shows a desktop app's notifications under its AppUserModelID (build.ts); a Store package has its own identity. */
export function setAppIdentity(): void {
  if (process.platform === 'win32' && !process.windowsStore) app.setAppUserModelId(appUserModelId(app.isPackaged, process.execPath))
}

const keepRunning = (): boolean => {
  try {
    return notificationSettings().keepRunning
  } catch {
    // The database is gone (Delete all data): closing quits.
    return false
  }
}

/** Opened at login: the window stays in the tray until it's opened. */
export const startHidden = (): boolean => process.argv.includes(HIDDEN_ARG) && keepRunning()

/** The close button hides the window to the tray when the app keeps running in the background; otherwise it closes, and the app quits. */
export function attachWindow(w: BrowserWindow): void {
  w.on('close', (e) => {
    if (closeAction({ quitting, keepRunning: keepRunning() }) === 'hide') {
      e.preventDefault()
      w.hide()
    }
  })
  // Windows signing out or shutting down: quit properly, so the database is closed. A downloaded update is not
  // installed on this quit: Windows would end the installer half way, leaving no app.
  w.on('session-end', () => {
    quitting = true
    holdUpdate()
    app.quit()
  })
}

export function showWindow(): void {
  const w = getWindow()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

const iconFile = (): string => join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

function openPage(target: OpenPageTarget): void {
  showWindow()
  getWindow()?.webContents.send('open:page', target)
}

function show(a: Alert): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: a.title, body: a.body, icon: iconFile() })
  n.on('click', () => openPage(a.target))
  n.on('failed', (_e, err) => log('alerts', `failed: ${err}`))
  live.push(n)
  if (live.length > LIVE_MAX) live.shift()
  n.show()
  // The kind only: the log never holds what the alert was about.
  log('alerts', `shown: ${a.kind}`)
}

/** Looks for new alerts now (after a sync, and on the schedule). After a connection's first sync, its history is only noted. */
export function runAlertCheck(firstSync = false): void {
  try {
    if (firstSync) noteTransactionsSeen()
    checkAlerts({ bank: { connected: feed.connected(), lastSyncAt: feed.lastSyncAt() }, busy: busy(), show })
  } catch (err) {
    console.error(`[alerts] the check failed${errorTag(err)}`)
  }
}

/** A version this build can't install itself, and its download page: an https address, or '' when there is none to open. */
function outPage(): { version: string; page: string } | null {
  const o = updateOut()
  return o ? { version: o.version, page: /^https:\/\//i.test(o.url) ? o.url : '' } : null
}

/**
 * Says in a notification that there is an update. A downloaded one installs only when the person quits, and an app
 * kept in the tray rarely is quit (a PC that is only ever shut down never installs one): a click on the notification
 * restarts into the new version. A build that can't install an update itself says a newer version is out, and a
 * click opens its download page. Said when it is found and once a day while it waits (and again after each start:
 * nothing of this is kept between runs). Paused notifications and quiet hours hold it back like any other, and the
 * hourly look says it once they end.
 */
function tellUpdate(): void {
  try {
    const ready = updateReady()
    const out = ready ? null : outPage()
    const version = ready ?? out?.version ?? null
    if (!version || !Notification.isSupported()) return
    const now = Date.now()
    if (!tellsOfUpdate({ version, told: toldUpdate, now, held: heldBack(Math.floor(now / 1000), notificationSettings()) })) return
    const kind = ready ? 'ready' : 'out'
    const n = new Notification({
      title: `${APP_NAME} ${version} is ${kind}`,
      body: ready ? 'Click to restart and install it' : out?.page ? 'Click to open its download page' : "This build can't install it itself",
      icon: iconFile()
    })
    n.on('click', () => {
      if (ready) void installUpdate()
      else if (out?.page) void shell.openExternal(out.page)
      else showWindow()
    })
    // "shown" is the system's word that it showed it; "asked" (below) is the app's that it asked.
    n.on('show', () => log('updater', `${kind} notification shown: ${version}`))
    n.on('failed', (_e, err) => log('updater', `notification failed: ${err}`))
    // One at a time: yesterday's reminder leaves the notification center as today's arrives. The variable also keeps
    // the notification referenced, so a click still reaches its handler.
    try {
      updateNote?.close()
    } catch {
      /* already gone */
    }
    updateNote = n
    n.show()
    // Noted once it is asked for: one that could not be made (the catch below) is tried again at the next hourly look.
    toldUpdate = { version, at: now }
    log('updater', `${kind} notification asked: ${version}`)
  } catch (err) {
    console.error(`[updater] the update notification failed${errorTag(err)}`)
  }
}

function syncFromTray(): void {
  syncBank().catch((err) => log('tray', `sync failed: ${message(err)}`))
}

function trayMenu(): Menu {
  let paused: number | null = null
  let connected = false
  try {
    paused = notificationSettings().pausedUntil
    connected = feed.connected()
  } catch {
    /* the database is closing */
  }
  const at = (unix: number): string => new Date(unix * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const pause: MenuItemConstructorOptions[] = paused
    ? [
        { label: `Paused until ${at(paused)}`, enabled: false },
        { label: 'Resume notifications', click: () => void setNotificationSettings({ pauseMinutes: 0 }) }
      ]
    : [{ label: 'Pause notifications for 1 hour', click: () => void setNotificationSettings({ pauseMinutes: PAUSE_MINUTES }) }]
  // An app kept in the tray is rarely quit: a downloaded update is offered here, and so is the download page of a
  // version this build can't install itself.
  const ready = updateReady()
  const out = ready ? null : outPage()
  const update: MenuItemConstructorOptions[] = ready
    ? [{ label: `Restart to update to ${ready}`, click: () => void installUpdate() }]
    : out?.page
      ? [{ label: `Download version ${out.version}`, click: () => void shell.openExternal(out.page) }]
      : []
  return Menu.buildFromTemplate([
    { label: 'Open', click: showWindow },
    { label: 'Sync now', enabled: connected && !busy(), click: syncFromTray },
    ...pause,
    ...update,
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
}

function createTray(): void {
  // Windows picks the .ico's size for the screen's scale; elsewhere the png is scaled down.
  tray = new Tray(process.platform === 'win32' ? iconFile() : nativeImage.createFromPath(iconFile()).resize({ width: 16, height: 16 }))
  tray.setToolTip(APP_NAME)
  tray.on('click', showWindow)
  // Built when it opens, so Sync now and the pause read as they are now (Linux shows only a menu set ahead).
  if (process.platform === 'linux') tray.setContextMenu(trayMenu())
  else tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()))
  log('tray', 'created')
}

/** Bank data: synced when it's 12 hours old or a first SimpleFIN history pull is unfinished, checked after launch and every hour. */
function startBankSchedule(): void {
  simplefin.migrateDeepPull()
  let timer: NodeJS.Timeout | null = null
  let failedAt = 0
  const plan = (): void => {
    if (timer || !feed.connected() || Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return
    const last = feed.lastSyncAt()
    const stale = !last || Date.now() / 1000 - last > AUTO_SYNC_AFTER_HOURS * 3600
    if (!stale && !feed.historyPending()) return
    timer = setTimeout(() => {
      timer = null
      // Not again if a sync ran while waiting (the user's, or the tray's).
      if (feed.lastSyncAt() !== last && !feed.historyPending()) return
      syncBank().catch((err) => {
        failedAt = Date.now()
        console.error(`[background sync] failed${errorTag(err)}`)
      })
    }, Math.floor(Math.random() * SYNC_DELAY_MS))
  }
  const safe = (): void => {
    try {
      plan()
    } catch (err) {
      console.error(`[background sync] failed${errorTag(err)}`)
    }
  }
  safe()
  setInterval(safe, BANK_CHECK_EVERY_MS)
}

/**
 * The tray, the bank sync's schedule, the alert checks and the months' closes; the phone's sync steps and Google's
 * run on their own schedules (index.ts), window or not.
 */
export function startBackground(o: { window: () => BrowserWindow | null; sync: () => Promise<unknown>; busy: () => boolean; close: () => void }): void {
  getWindow = o.window
  syncBank = o.sync
  busy = o.busy
  // Quit from the tray, the menu, an update or Delete all data really quits.
  app.on('before-quit', () => {
    quitting = true
  })
  try {
    createTray()
  } catch (err) {
    console.error('[tray]', message(err))
  }
  // The login item follows the exe (an update can move it), and the setting both ways: one left behind
  // (by a database restored from before it was on, or a fresh one) comes off.
  try {
    const want = loginItemWanted(notificationSettings())
    if (want !== null) applyLoginItem(want)
  } catch (err) {
    console.error('[login item]', message(err))
  }
  startBankSchedule()
  setTimeout(() => runAlertCheck(), FIRST_ALERT_CHECK_MS)
  setInterval(() => runAlertCheck(), ALERT_CHECK_EVERY_MS)
  // An update: said when it is found, and looked at again every hour (the daily reminder, and one held back).
  onUpdateNews(tellUpdate)
  setInterval(tellUpdate, ALERT_CHECK_EVERY_MS)
  // A month falls due on a day (the 3rd, or the 15th) and once its banks report after it: looked for every hour
  // while the app runs, so one comes due within the hour wherever the day began. A look with nothing due is a query.
  // The same tick checks the closed months for what changed in them (snapshots.ts checkClosed), a write from Review's
  // tool server in its own process among them.
  setInterval(o.close, CLOSE_CHECK_EVERY_MS)
}
