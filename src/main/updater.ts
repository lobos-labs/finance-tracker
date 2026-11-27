import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { log, logCrash } from './log'
import { releasesPage, retryAfter, selfUpdating } from './updateFeed'
import type { UpdateCheck } from '../shared/types'

// Updates come from a generic electron-updater feed (latest.yml and the
// installer under one https URL) fixed at build time: FINANCE_TRACKER_UPDATE_URL
// becomes __UPDATE_URL__ in electron.vite.config.ts. The open edition's can
// only be its GitHub releases, .../releases/latest/download (updateFeed.ts).
// Without a URL, or in an unpackaged build, nothing is ever checked.
//
// Where the app can install an update itself, one that is found downloads in
// the background and installs when the person quits (the tray's Quit, or its
// Restart to update, which installs now). It is not installed when Windows
// ends the session, where the installer would be cut off half way, nor when
// the app restarts itself. background.ts is told when one has downloaded, and
// says so in a notification. macOS installs an update only for an app signed
// with a Developer ID: a Mac build without one checks, downloads nothing, and
// says a new version is out and where it is, in a notification too and in a
// line in the window.

declare const __UPDATE_URL__: string
declare const __MAC_SELF_UPDATE__: string

const FIRST_CHECK_MS = 30_000
const CHECK_EVERY_MS = 6 * 3600_000

const updateUrl = (): string => (typeof __UPDATE_URL__ === 'string' ? __UPDATE_URL__ : '')

/** A feed is built in and this is the packaged app, not a Microsoft Store install (the Store updates those itself). */
export const updatesOn = (): boolean => app.isPackaged && !process.windowsStore && updateUrl() !== ''

/** Whether this build installs its updates itself (scripts/dist-open.cjs says how a Mac build was signed). */
export const installsItself = (): boolean => selfUpdating(process.platform, typeof __MAC_SELF_UPDATE__ === 'string' ? __MAC_SELF_UPDATE__ : '')

let instance: typeof autoUpdater | null = null
let downloaded: string | null = null
let out: { version: string; url: string } | null = null
let onNews: () => void = () => {}

/**
 * Who to tell when there is an update to mention: one has downloaded and waits to be installed, or the scheduled
 * check found one this build can't install itself (background.ts, which shows the notification).
 */
export function onUpdateNews(tell: () => void): void {
  onNews = tell
}

/** electron-updater, set up on first use (its autoUpdater is built when first touched). */
function updater(): typeof autoUpdater {
  if (instance) return instance
  const line = (m: unknown): void => log('updater', String(m))
  autoUpdater.logger = { info: line, warn: line, error: line }
  autoUpdater.autoDownload = installsItself()
  autoUpdater.autoInstallOnAppQuit = installsItself()
  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl() })
  // Without a listener, an error event would be thrown at the emitter.
  autoUpdater.on('error', (err) => logCrash('updater', err))
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info.version
    onNews()
  })
  instance = autoUpdater
  return instance
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The version that is downloaded and waiting to be installed, or null. */
export const updateReady = (): string | null => downloaded

/** A newer version a check found that this build can't install itself, and the page to download it from ('' when the feed has none); null when none was found. */
export const updateOut = (): { version: string; url: string } | null => out

/**
 * Not on this quit: Windows is ending the session, or the app is restarting itself. An installer started then is
 * cut off half way, or runs over the copy that is starting. The update stays downloaded and installs at the next
 * quit the person makes. Uses the instance alone, so nothing is built where updates are off.
 */
export function holdUpdate(): void {
  if (instance) instance.autoInstallOnAppQuit = false
}

/** Quits, installs the downloaded update and starts the app again. False when none is ready. */
export function installUpdate(): boolean {
  if (!instance || !downloaded) return false
  instance.autoInstallOnAppQuit = true
  instance.quitAndInstall(true, true)
  return true
}

/** Asks the feed now, for the Settings button. */
export async function checkForUpdates(): Promise<UpdateCheck> {
  if (!updatesOn()) return { status: 'off', version: null }
  if (downloaded) return { status: 'ready', version: downloaded }
  try {
    const r = await updater().checkForUpdates()
    if (!r?.isUpdateAvailable) {
      // Nothing newer any more (a release withdrawn, say): what was out is forgotten, so nothing goes on naming it.
      out = null
      return { status: 'current', version: null }
    }
    if (!installsItself()) {
      out = { version: r.updateInfo.version, url: releasesPage(updateUrl()) }
      return { status: 'available', version: out.version, url: out.url }
    }
    return { status: 'downloading', version: r.updateInfo.version }
  } catch (err) {
    return { status: 'failed', version: null, error: message(err) }
  }
}

/**
 * Checks shortly after launch and every six hours while the app is open; failures only reach the log. A check
 * that failed is tried again soon, a few times (updateFeed.ts retryAfter): an app started before the network was
 * up would otherwise not look again for six hours. Where the app can't install an update itself, each check that
 * finds a new version says so to background.ts, for its notification, and the window is told once about each new
 * version.
 */
export function startUpdates(): void {
  if (!updatesOn()) return
  const told = new Set<string>()
  let failures = 0
  const check = (): void =>
    void checkForUpdates().then((r) => {
      failures = r.status === 'failed' ? failures + 1 : 0
      const again = retryAfter(failures)
      if (again !== null) setTimeout(check, again)
      if (r.status !== 'available' || !r.version) return
      onNews()
      if (told.has(r.version)) return
      told.add(r.version)
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('notify', `Version ${r.version} is out · Settings → Data → Check for updates opens the download`)
    })
  setTimeout(check, FIRST_CHECK_MS)
  setInterval(check, CHECK_EVERY_MS)
}
