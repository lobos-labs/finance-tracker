import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron'
import { join } from 'node:path'
import { checkIntegrity, closeDb, dbOpen, LATEST_SCHEMA_VERSION, migrate, NewerDatabaseError, openDb, schemaVersion } from './db'
import { backupBeforeMigration, keepDailyBackups } from './backup'
import { prepareDatabase, UnlockCancelled } from './dbopen'
import { keystore } from './ipc-database'
import { askRecoveryCode, closeUnlockWindow } from './unlock'
import { backupsDir, backupsDirBeforeOpen, closeMonths, connectorChanged, currentDbFiles, dbFile, externalChanges, keepCreditReminder, onSyncDone, registerIpc, runSync, syncBusy, updateAssetValues } from './ipc'
import { configureConnector, startConnector, stopConnector } from './connector'
import * as google from './google'
import { startBridge } from './bridge'
import { startSync } from './ipc-sync'
import { setupAi } from './ai'
import { cleanWorkDir, forgetTranscripts } from './claudeCode'
import { configureBank } from './bank'
import { configureLicense, refresh, refreshDue } from './license'
import { log, logCrash, openLog } from './log'
import { deleteSecret, readSecret, saveSecret } from './secrets'
import { startUpdates } from './updater'
import { BETA_UNTIL, DATA_DIR_NAME, sourceRunSuffix } from './build'
import { bridgeAllowed, configureBuild, devBuild, devEnv, dropDevVariables } from './devBuild'
import { attachWindow, runAlertCheck, setAppIdentity, showWindow, startBackground, startHidden } from './background'
import { APP_NAME } from '../shared/app'
import { chrome, followTheme, OVERLAY_HEIGHT, themeChoice } from './theme'

// The license token is refreshed online a little after launch and checked again a few times a day.
const LICENSE_REFRESH_DELAY_MS = 30_000
const LICENSE_REFRESH_EVERY_MS = 6 * 3600_000
// A renderer that dies is reloaded once; dying again this soon ends the app instead of looping.
const RELOAD_WINDOW_MS = 30_000
// The months due close this long after launch, once the window has drawn.
const CLOSE_DELAY_MS = 20_000

// Logs carry the message alone, never the error object (it can hold the data it was about).
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// The folder overrides, the claude stand-in, the endpoint overrides and the
// plan switch are for development (devBuild.ts): an unpackaged build, or a
// packaged one made with the dev flag and run with FINANCE_TRACKER_DEV=1. A
// shipped build drops them before anything reads them, so an installed app
// always opens its own data, sends its requests where it was built to, and
// runs on the plan its license gives it.
configureBuild({ packaged: app.isPackaged })
if (!devBuild()) dropDevVariables()

// The data folder is DATA_DIR_NAME (build.ts): "Finance Tracker", or the
// beta's own folder, so a beta installed beside the app never opens its data.
// FINANCE_TRACKER_DATA_DIR points at a throwaway one for testing. A run from source of the open edition has its
// own folder beside the installed app's (sourceRunSuffix).
if (process.env['FINANCE_TRACKER_DATA_DIR']) app.setPath('userData', process.env['FINANCE_TRACKER_DATA_DIR'])
else app.setPath('userData', join(app.getPath('appData'), `${DATA_DIR_NAME}${sourceRunSuffix(app.isPackaged)}`))

openLog(join(app.getPath('userData'), 'logs'))
// Notifications show under the installer's app id.
setAppIdentity()

// Nothing uncaught takes the app down; it goes to the log.
process.on('uncaughtException', (err) => logCrash('main', err))
process.on('unhandledRejection', (reason) => logCrash('main', reason))
app.on('child-process-gone', (_e, d) => log('process', `${d.type}${d.name ? ` ${d.name}` : ''} gone: ${d.reason} (${d.exitCode})`))
// Chromium's spell checker fetches a dictionary from Google's servers for a language the system can't check itself.
// No session keeps a language, the updater's own included, so nothing is fetched (and nothing is underlined).
app.on('session-created', (created) => created.setSpellCheckerLanguages([]))

let rendererLostAt = 0
app.on('render-process-gone', (_e, contents, d) => {
  log('renderer', `gone: ${d.reason} (${d.exitCode})`)
  if (d.reason === 'clean-exit' || d.reason === 'killed') return
  if (Date.now() - rendererLostAt < RELOAD_WINDOW_MS) {
    dialog.showErrorBox(`${APP_NAME} crashed`, `The window crashed again (${d.reason}).\n\nThe log is in ${join(app.getPath('userData'), 'logs')}.`)
    app.quit()
    return
  }
  rendererLostAt = Date.now()
  contents.reload()
})

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Settings → Display; the page follows it through prefers-color-scheme.
  nativeTheme.themeSource = themeChoice()
  const colors = chrome()
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: join(app.getAppPath(), 'resources', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: colors.color,
    // Frameless look: the page's top bar is the title bar, with Windows'
    // own min/max/close buttons drawn over its right edge.
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...colors, height: OVERLAY_HEIGHT },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  followTheme(mainWindow)
  // Opened at login, it waits in the tray.
  mainWindow.once('ready-to-show', () => {
    if (!startHidden()) mainWindow?.show()
  })
  // Closing hides it to the tray while the app keeps running in the background.
  attachWindow(mainWindow)
  // The title is the product's, not the page's.
  mainWindow.on('page-title-updated', (e) => e.preventDefault())

  // The renderer never navigates; any link opens in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  // The page's errors (a render error the boundary caught, say) reach the log too.
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level === 'error') log('renderer', e.message)
  })

  // The dev server's page is for development; a packaged app always loads its own.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * Opens the database and, when it's behind this build, backs it up and upgrades it; throws when it can't be used.
 * A packaged build's is encrypted (converted once from an older plain one); a development build's only with the
 * switch in Settings → Data (dbopen.ts). A conversion that fails says so and leaves the data as it was.
 */
async function prepareDb(): Promise<void> {
  const prepared = await prepareDatabase({
    files: currentDbFiles(),
    backupsDirFor: backupsDirBeforeOpen,
    packaged: app.isPackaged,
    keystore: keystore(),
    askCode: askRecoveryCode,
    log: (line) => log('db', line)
  })
  if (prepared.conversionError) {
    const e = prepared.conversionError
    dialog.showErrorBox(
      e.swapped ? `${APP_NAME} couldn’t finish converting its backups` : `${APP_NAME} couldn’t convert its data`,
      `${e.swapped ? 'The database is converted; the backups are finished at the next start.' : 'Nothing was changed; it tries again at the next start.'}\n\n${e.message}\n\nBackups are in ${prepared.backupsDir}.`
    )
  }
  // Said once: the conversion is finished and doesn't try these again.
  if (prepared.left.length) dialog.showErrorBox(`${APP_NAME} couldn’t convert every backup`, `These backups in ${prepared.backupsDir} are left as they were; delete them or move them somewhere safe:\n\n${prepared.left.join('\n')}`)
  openDb(dbFile(), { migrate: false, key: prepared.key })
  const from = schemaVersion()
  if (from === LATEST_SCHEMA_VERSION) return
  // A brand-new database (version 0) holds nothing to keep.
  if (from > 0) await backupBeforeMigration(backupsDir(), from)
  migrate()
  const { corruption, foreignKeys } = checkIntegrity()
  if (corruption.length) throw new Error(`The database failed SQLite's integrity check after upgrading: ${corruption.join('; ')}`)
  if (foreignKeys.length) console.error('[db] foreign key problems:', foreignKeys.join('; '))
}

/** Says why the data can't be opened and quits, so the app never runs without its window. */
function quitWithError(err: unknown): void {
  closeDb()
  // Closing the recovery-code window is the user's choice, not a failure.
  if (err instanceof UnlockCancelled) {
    app.quit()
    return
  }
  const why =
    err instanceof NewerDatabaseError
      ? `It was last written by a newer version of the app (schema ${err.fileVersion}; this version knows ${err.latest}). Update the app to open it.`
      : `${err instanceof Error ? err.message : String(err)}\n\nBackups are in ${backupsDir()}.`
  dialog.showErrorBox(`${APP_NAME} can’t open its data`, `${dbFile()}\n\n${why}`)
  app.quit()
}

async function start(): Promise<void> {
  log('app', `${app.getVersion()} ${app.isPackaged ? 'packaged' : 'unpackaged'}`)
  try {
    await prepareDb()
  } catch (err) {
    quitWithError(err)
    return
  }
  // The plan: the token lives in the OS-encrypted secrets; a development build is Plus unless FINANCE_TRACKER_PLAN says otherwise, and a packaged beta build until the beta ends.
  const secret = (name: 'licenseToken' | 'licenseKey' | 'freeToken' | 'bankInstallKey'): { read(): string | null; write(v: string): void; clear(): void } => ({ read: () => readSecret(name), write: (v) => saveSecret(name, v), clear: () => deleteSecret(name) })
  configureLicense({ dev: devBuild(), betaUntil: app.isPackaged ? BETA_UNTIL : '', platform: process.platform, token: secret('licenseToken'), key: secret('licenseKey'), freeToken: secret('freeToken') })
  configureBank({ installKey: secret('bankInstallKey') })
  setupAi()
  // The page never needs the camera, microphone, location, notifications or any other permission.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // Claude Desktop's connector writes its connection file to the home folder, the one Claude Desktop's extension sees
  // too; a development build's FINANCE_TRACKER_HOME_DIR moves it to a scratch one (scripts/connector-e2e.ts).
  configureConnector({ home: devEnv('FINANCE_TRACKER_HOME_DIR') ?? app.getPath('home'), dataDir: app.getPath('userData'), changed: connectorChanged })
  registerIpc()
  try {
    cleanWorkDir()
  } catch (err) {
    console.error('[claude-code]', message(err))
  }
  // The file bridge is a development tool (no authentication).
  if (bridgeAllowed()) {
    try {
      startBridge(externalChanges)
    } catch (err) {
      console.error('[bridge]', message(err))
    }
  }
  // Claude Desktop's connector (open edition and development builds): on again with a new token when the user left
  // it on, and a connection file a crash left behind deleted.
  void startConnector()
  createWindow()
  closeUnlockWindow()
  startUpdates()
  // The phone and the web viewer: a step shortly after launch, after data changes and every minute (Plus, once paired).
  startSync()
  // Today's backup now, and again each day the app stays running.
  keepDailyBackups({ dir: backupsDir, ready: dbOpen, failed: (err) => console.error('[backup]', message(err)) })
  // Past months that are due close in the background once the window is up: on the first launch, every one of them.
  // Then every closed month is checked for what changed in it while the app was closed (a sync, Review's tool server).
  setTimeout(closeMonths, CLOSE_DELAY_MS)

  // The tray; bank data refreshed when it's stale, or an unfinished initial
  // history pull kept going, after launch and while the app runs (both inside
  // the bridge's daily quota); alerts checked after each sync and hourly.
  onSyncDone(runAlertCheck)
  startBackground({ window: () => mainWindow, sync: runSync, busy: syncBusy, close: closeMonths })

  // House and vehicle values are looked up about monthly; check shortly after
  // launch and a few times a day while the app stays open.
  setTimeout(updateAssetValues, 45_000)
  setInterval(updateAssetValues, 6 * 3600_000)
  // Keep the Google calendar's projections rolling forward, and bring back
  // tasks checked off there.
  google.scheduleSync()
  setInterval(google.scheduleSync, 3600_000)
  // The monthly credit-score to-do rolls on once it's checked off.
  keepCreditReminder()
  setInterval(keepCreditReminder, 3600_000)

  // A held license is re-validated online about daily; offline, the token's grace carries it.
  const refreshLicense = (): void => {
    if (!refreshDue()) return
    refresh().then(
      (p) => log('license', `refreshed: ${p.plan}`),
      (err) => log('license', `refresh failed: ${message(err)}`)
    )
  }
  setTimeout(refreshLicense, LICENSE_REFRESH_DELAY_MS)
  setInterval(refreshLicense, LICENSE_REFRESH_EVERY_MS)
}

// A second copy of the app hands over to the first and leaves the database alone.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // It may be waiting in the tray.
  app.on('second-instance', showWindow)
  // macOS starts no second copy: the Dock icon, or opening the app again, sends activate instead.
  app.on('activate', showWindow)

  app.whenReady().then(start)

  app.on('window-all-closed', () => {
    // No call from Claude Desktop arrives once the database is closed.
    stopConnector()
    closeDb()
    app.quit()
  })

  // Claude Code's transcripts of the reviews (tool results, document contents) don't outlive the app.
  app.on('will-quit', () => {
    // Claude Desktop's connector: the pipe closed and its connection file, with the token, deleted.
    try {
      stopConnector()
    } catch (err) {
      console.error('[connector]', message(err))
    }
    try {
      forgetTranscripts()
    } catch (err) {
      console.error('[claude-code]', message(err))
    }
    // Quit from the tray or the menu skips window-all-closed.
    closeDb()
  })
}
