import { can, PlanError, requireFeature } from './license'
import { isTaxForm } from './taxes'
import { isCreditReportFile } from './credit'
import { isInsuranceFile } from './insurance'
import { receiptPath } from './receipts'
import { documentProblem } from './files'
import { extraDocsDirs, legacyDocsDir, RECEIPTS } from './paths'
import { packageFamilyName, storeBackupsDir, storeFolderTarget } from './storePaths'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent, type MessageBoxOptions, type MessageBoxReturnValue, type OpenDialogOptions, type OpenDialogReturnValue, type SaveDialogOptions, type SaveDialogReturnValue } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import * as db from './db'
import { dbFiles, keyForBackup, peekSetting, recoveryPending, type DbFiles } from './dbopen'
import { writeFileDurably } from './dbkey'
import { sessionKey, sessionKeyFile } from './dbsession'
import { copyDatabase, flushFile, removeDbFiles } from './sqlite'
import { databaseState, keystore, registerDatabaseIpc } from './ipc-database'
import { transactionsCsv } from './csvExport'
import { deleteAllData } from './wipe'
import { backupBeforeRestore, bulkBackup, checkBackupFile, timeStamp } from './backup'
import * as bank from './bank'
import * as feed from './bankFeed'
import * as simplefin from './simplefin'
import * as csv from './csvImport'
import * as statement from './statementImport'
import { classifyInFlight } from './classifier'
import { apiKeySource, checkApiKey } from './ai/anthropic'
import { keyRemoved, keySaved } from './ai/keyCheck'
import { routeModel } from './ai/backend'
import { getRequest } from './ai/requestLog'
import { HOME_DIR_NAME, SUPPORT_EMAIL } from './build'
import { devEnv } from './devBuild'
import { mcpTools } from './mcp'
import { connectorDir, connectorOffered, connectorStatus, CONNECTOR_INSTRUCTIONS, setConnector, stopConnector, undoConnectorChange } from './connector'
import { writeExtension } from './mcpb'
import { APP_NAME } from '../shared/app'
import { cleanReport, reportMailto, reportText, type AiReport } from '../shared/aiReport'
import * as claudeCode from './claudeCode'
import { reviewState } from './review'
import { docsDir } from './tools'
import { revalueDue } from './valuation'
import { CHECK_AFTER_MS, checkClosed, closeDueMonths, closeSoon, scheduleCheck, type CheckRun, type CloseRun } from './snapshots'
import { errorTag, log } from './log'
import { calendarIcs } from './calendar'
import { appInfo, diagnostics } from './diagnostics'
import { checkForUpdates, holdUpdate } from './updater'
import * as google from './google'
import { deleteSecret, hasSecret, saveSecret } from './secrets'
import { docsDirLocked, registerSetupIpc } from './ipc-setup'
import { holdSync, registerSyncIpc, releaseSync, syncDataChanged } from './ipc-sync'
import { registerAlertsIpc } from './ipc-alerts'
import { registerMoveIpc } from './moveToAccount'
import { keepReminder } from './credit'
import { applyTheme } from './theme'
import type { HandlerContext } from './handlers/context'
import { autoClassifyEnabled, runClassify as classifyFor } from './handlers/data'
import { callHandler, HANDLERS } from './handlers/table'
import type { FeatureId } from '../shared/plans'
import type { ClassifyResult, ConnectorInstall, RestoreResult, SyncResult } from '../shared/types'

// The desktop's IPC: the handler table (handlers/table.ts, shared with the
// hosted ledger) registered with ipcMain, run with the desktop's context, and
// the handlers that need Electron itself: dialogs, the shell, the clipboard,
// the OS keystore, Google sign-in, the bank's browser page, the data folder,
// local backups and the database key, the updater.

type Handler = (...args: never[]) => unknown

export const dbFile = (): string => join(app.getPath('userData'), 'finance.db')
/** The data folder's backups; a Store build keeps them in the documents folder, since uninstalling it deletes the data folder (storePaths.ts). */
export const backupsDir = (): string => (process.windowsStore ? storeBackupsDir(docsDir()) : join(app.getPath('userData'), 'backups'))
/** The database and the files beside it: its key file, the development build's Encrypted switch, the backups folder. */
export const currentDbFiles = (): DbFiles => dbFiles(app.getPath('userData'), backupsDir())
/** The backups folder before the database is open (index.ts), for a database opened with `key`: a Store build's documents folder is a setting in it. */
export const backupsDirBeforeOpen = (key: Buffer | null): string =>
  process.windowsStore ? storeBackupsDir(process.env['FINANCE_TRACKER_DOCS_DIR'] || peekSetting(dbFile(), key, 'documents.dir') || legacyDocsDir()) : join(app.getPath('userData'), 'backups')

/** Opens one of the app's folders in Explorer. A Store build's AppData is redirected into its package, which Explorer doesn't see: the real folder opens, or the path the app sees is shown in its parent. */
async function openAppFolder(dir: string): Promise<void> {
  if (!process.windowsStore) {
    await shell.openPath(dir)
    return
  }
  const t = storeFolderTarget(dir, { appData: app.getPath('appData'), localAppData: process.env['LOCALAPPDATA'] || join(app.getPath('home'), 'AppData', 'Local'), family: packageFamilyName(process.execPath) }, existsSync)
  if ('open' in t && !(await shell.openPath(t.open))) return
  shell.showItemInFolder('show' in t ? t.show : dir)
}

// Logs carry the message alone: an error object can hold the data it was about.
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Looks up house and vehicle values that are a month old or more, in the background. */
export function updateAssetValues(): void {
  revalueDue().then(
    (done) => {
      if (!done.length) return
      broadcast('data:changed')
      broadcast('data:bulk')
      broadcast('notify', done.length === 1 ? `Updated value · ${done[0]}` : `Updated ${done.length} asset values`)
    },
    (err) => console.error(`[valuation] a lookup failed${errorTag(err)}`)
  )
}

/** The monthly "Check credit score" to-do: the next one once the last is checked off (at launch, hourly, after Google sends changes back). */
export function keepCreditReminder(): void {
  try {
    if (!keepReminder()) return
    broadcast('data:changed')
    google.scheduleSync()
  } catch (err) {
    console.error(`[credit] the reminder failed${errorTag(err)}`)
  }
}

/**
 * Closes the past months that are due (snapshots.ts), in the background and a month at a time, so the window's calls
 * are answered between them: at launch, on the background tick, and a moment after a bulk change brings history in
 * (an import, the sample data, a restore). Then the closed months are checked for what changed in them since (in the
 * same queue, after the closes). The window redraws once any closed or changed.
 */
export function closeMonths(): void {
  closeDueMonths().then(monthsClosed, (err) => log('close', `failed: ${message(err)}`))
  checkClosed().then(monthsChecked, (err) => log('check', `failed: ${message(err)}`))
}

/** A bulk change waits this long, so a burst of them closes the months once. */
const CLOSE_AFTER_BULK_MS = 2000

function monthsClosed(run: CloseRun): void {
  for (const f of run.failed) log('close', `${f.month} not closed: ${f.error}`)
  if (!run.closed.length) return
  log('close', `${run.closed.length} ${run.closed.length === 1 ? 'month' : 'months'} closed`)
  broadcast('data:changed')
}

/** What a check of the closed months found: the window redraws when a month changed, re-closed or came back to its close. */
function monthsChecked(run: CheckRun): void {
  for (const f of run.failed) log('check', `${f.month} not checked: ${f.error}`)
  const moved = run.changed.length + run.reclosed.length + run.restored.length
  if (!moved) return
  log('check', `${run.changed.length} changed, ${run.reclosed.length} re-closed, ${run.restored.length} back to their close`)
  broadcast('data:changed')
  broadcast('review:update', reviewState())
}

/** Changes made outside the UI (the file bridge): refresh every view and say what happened. */
export function externalChanges(actions: string[], imported = false): void {
  db.applyBucketRules()
  // Imported transactions get categorized like a sync's.
  if (imported && autoClassifyEnabled()) runClassify(false, true).catch((err) => console.error(`[classify] failed${errorTag(err)}`))
  broadcast('review:update', reviewState())
  broadcast('data:changed')
  broadcast('data:bulk')
  broadcast('notify', actions.length === 1 ? actions[0] : `${actions.length} changes applied from Claude Code`)
  google.scheduleSync()
}

/** A change Claude Desktop made through the connector, or one put back in Settings (connector.ts): every view redraws, and Google follows. */
export function connectorChanged(): void {
  broadcast('review:update', reviewState())
  broadcast('data:changed')
  broadcast('data:bulk')
  google.scheduleSync()
}

/**
 * Opens the extension in Claude Desktop, which shows its install dialog. On
 * Windows that's the command Claude's Store package registers, since the
 * package claims no file type and opening the file would ask which app to
 * use; on macOS, `open -a Claude`. Otherwise, or when that fails, the file is
 * shown in its folder. True when Claude Desktop was asked to open it.
 */
async function openInClaude(file: string): Promise<boolean> {
  if (process.platform === 'win32') {
    const claude = join(process.env['LOCALAPPDATA'] || join(app.getPath('home'), 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'claude-desktop.exe')
    // An app execution alias: stat can't open one, lstat sees it.
    let found = true
    try {
      lstatSync(claude)
    } catch {
      found = false
    }
    if (found) {
      const started = await new Promise<boolean>((resolve) => {
        // Claude Desktop is an Electron app too: none of this app's Electron or Node switches go with it.
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|NODE_OPTIONS$)/i.test(k)))
        const child = spawn(claude, [file], { detached: true, stdio: 'ignore', env })
        child.once('spawn', () => resolve(true))
        child.once('error', () => resolve(false))
        child.unref()
      })
      if (started) return true
    }
  } else if (process.platform === 'darwin') {
    if (await new Promise<boolean>((resolve) => execFile('open', ['-a', 'Claude', file], (err) => resolve(!err)))) return true
  } else if (!(await shell.openPath(file))) return true
  shell.showItemInFolder(file)
  return false
}

/** Settings → Claude Desktop → Install in Claude Desktop: the extension written to the home folder (mcpb.ts) and opened in Claude Desktop. */
async function installConnector(): Promise<ConnectorInstall> {
  if (!connectorOffered()) throw new Error('The Claude Desktop connector isn\'t in this build')
  const resources = join(app.getAppPath(), 'resources')
  const template = readFileSync(join(resources, 'claude-extension', 'server', 'index.cjs'), 'utf8')
  let icon: Buffer | null = null
  try {
    icon = readFileSync(join(resources, 'icon.png'))
  } catch {
    icon = null
  }
  // The reads go in too: the relay lists them when the app isn't running, so Claude can tell the user to open it.
  const { file } = writeExtension(connectorDir(), { appName: APP_NAME, version: app.getVersion(), homeDirName: HOME_DIR_NAME, instructions: CONNECTOR_INSTRUCTIONS, template, icon, tools: mcpTools(false) })
  // A scratch home's extension (FINANCE_TRACKER_HOME_DIR) is never opened: Claude Desktop's extensions read the real home folder.
  if (devEnv('FINANCE_TRACKER_HOME_DIR')) return { file, opened: false }
  return { file, opened: await openInClaude(file) }
}

function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
  if (channel === 'data:changed') {
    // The phone's snapshot follows the data.
    syncDataChanged()
    // A write can move a closed month: the months are checked a moment after the last one, off the window's calls.
    scheduleCheck(CHECK_AFTER_MS, monthsChecked)
  }
  // History brought in by a bulk change has months to close.
  if (channel === 'data:bulk') closeSoon(CLOSE_AFTER_BULK_MS, monthsClosed)
}

const focused = (): BrowserWindow | null => BrowserWindow.getFocusedWindow()
const pickSave = (opts: SaveDialogOptions): Promise<SaveDialogReturnValue> => {
  const win = focused()
  return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)
}
const pickOpen = (opts: OpenDialogOptions): Promise<OpenDialogReturnValue> => {
  const win = focused()
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)
}
const ask = (opts: MessageBoxOptions): Promise<MessageBoxReturnValue> => {
  const win = focused()
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
}

/** What the handler table gets from the desktop. */
const desktop: HandlerContext = {
  platform: 'desktop',
  broadcast,
  file: async () => {
    throw new Error('Uploads are for the web; the desktop picks a file')
  },
  pickFile: async ({ title, name, extensions }) => {
    const pick = await pickOpen({ title, filters: [{ name, extensions }], properties: ['openFile'] })
    return pick.canceled || !pick.filePaths[0] ? null : pick.filePaths[0]
  },
  backup: async () => {
    await bulkBackup(backupsDir())
  },
  calendarChanged: () => google.scheduleSync(),
  syncIdle: async () => {
    await syncing?.catch(() => {})
  },
  syncBanks: () => runSync(),
  // Claude Code's own copy of the conversation goes with it.
  reviewCleared: () => claudeCode.forgetTranscripts(),
  themeChanged: applyTheme,
  appInfo,
  settings: () => ({
    licenseTokenSaved: hasSecret('licenseToken'),
    apiKeySource: apiKeySource(),
    simplefinConnected: feed.simplefinKept(),
    bank: { available: bank.available(), connections: bank.connections() },
    lastSyncAt: feed.lastSyncAt(),
    syncsLast24h: simplefin.requestsLast24h(),
    historyFrom: simplefin.historyStatus().from,
    historyComplete: simplefin.historyStatus().complete,
    syncWarnings: feed.warnings(),
    dataPath: app.getPath('userData'),
    database: databaseState(currentDbFiles())
  }),
  folders: () => ({
    dataDir: app.getPath('userData'),
    docsDir: docsDir(),
    docsDirLocked: docsDirLocked(),
    extraDirs: extraDocsDirs(),
    recoveryPending: db.dbEncrypted() && recoveryPending()
  })
}

/** The backup that asked for its recovery code (restoreBackupCode carries on with it). */
let restoreWaiting: string | null = null

const sameKey = (a: Uint8Array | null, b: Uint8Array | null): boolean => (!a && !b) || (!!a && !!b && Buffer.from(a).equals(Buffer.from(b)))

/**
 * Replaces the database with a backup and restarts the app; the database as it is now is backed up first.
 * The backup goes in in this install's form: an encrypted install encrypts a plain backup (or re-encrypts
 * one from another install, which asks for that backup's recovery code), a plain one decrypts.
 */
async function restore(file: string, code?: string): Promise<RestoreResult> {
  const target = dbFile()
  if (resolve(file) === resolve(target)) throw new Error('That is the current database')
  if (syncing || classifyInFlight()) throw new Error('Wait for the sync or categorization to finish')
  const mine = db.dbEncrypted() ? sessionKey() : null
  const found = await keyForBackup(file, { currentKey: mine, keystore: keystore(), code })
  if ('needsCode' in found) {
    restoreWaiting = file
    return { needsCode: basename(file) }
  }
  restoreWaiting = null
  checkBackupFile(file, found.key)
  const { response } = await ask({ type: 'question', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Restore backup', message: `Replace the current data with ${basename(file)} and restart?` })
  if (response !== 0) return null
  const safety = await backupBeforeRestore(backupsDir())
  const staged = `${target.replace(/\.db$/i, '')}.restore.tmp`
  try {
    if (sameKey(found.key, mine)) {
      removeDbFiles(staged)
      copyFileSync(file, staged)
    } else copyDatabase(file, found.key, staged, mine)
    checkBackupFile(staged, mine)
  } catch (err) {
    removeDbFiles(staged)
    throw err
  }
  // Flushed, then renamed over the database (one step on the same volume): a crash, a power cut or a full
  // disk leaves the old file or the new one, never part of each. The database is closed, so its -wal and
  // -shm hold nothing (another program still holding it makes the removal, and so the swap, fail first).
  const swap = (from: string): void => {
    flushFile(from)
    rmSync(`${target}-wal`, { force: true })
    rmSync(`${target}-shm`, { force: true })
    renameSync(from, target)
  }
  // Sync stays as it is now: the phone and the viewer keep their pairing across a restore.
  const keep = await holdSync()
  db.closeDb()
  let swapped = false
  try {
    swap(staged)
    swapped = true
    db.openDb(target, { key: mine })
  } catch (err) {
    // Back to the database of a moment ago (when the swap happened): the safety copy, copied beside it first, then swapped in the same way.
    const back = `${target.replace(/\.db$/i, '')}.restore.back`
    try {
      if (swapped) {
        removeDbFiles(back)
        copyFileSync(safety, back)
        swap(back)
      }
      db.openDb(target, { key: mine })
    } finally {
      removeDbFiles(back)
      releaseSync(null)
    }
    throw err
  } finally {
    removeDbFiles(staged)
  }
  releaseSync(keep)
  // app.exit skips will-quit: Claude Desktop's connector is closed and its connection file deleted here.
  stopConnector()
  db.closeDb()
  // The app is starting again: an update's installer would run over the copy that starts.
  holdUpdate()
  app.relaunch()
  app.exit(0)
  return file
}

export function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  // The dev server's page counts only in a development build (index.ts loads it only then).
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  return url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl))
}

/** The one way a stored path is opened: a document inside the documents folder, and nothing else. */
async function openDocument(path: string): Promise<void> {
  const problem = documentProblem(path)
  if (problem) throw new Error(problem)
  const err = await shell.openPath(path)
  if (err) throw new Error(err)
}

/** Opens a file only when it's one the app keeps on record (a tax form, a report, a policy document). */
async function openOnFile(path: string, onFile: (p: string) => boolean, notOnFile: string): Promise<void> {
  if (!onFile(path)) throw new Error(notOnFile)
  await openDocument(path)
}

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (e, ...args: unknown[]) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'Untrusted sender' }
    try {
      return { ok: true, data: await (fn as (...a: unknown[]) => unknown)(...args) }
    } catch (err) {
      // A call the plan doesn't include: the renderer shows the lock, not an error.
      if (err instanceof PlanError) return { ok: false, error: 'plan', feature: err.feature }
      // The window gets the message; the log gets the channel and the error's kind, since a message can name
      // what the call was about (an account, an asset, a payee).
      console.error(`[ipc] ${channel} failed${errorTag(err)}`)
      return { ok: false, error: message(err) }
    }
  })
}

/** A handler for a Plus feature: the plan is checked before it runs. */
const gated =
  (feature: FeatureId, fn: Handler): Handler =>
  (...args) => {
    requireFeature(feature)
    return (fn as (...a: unknown[]) => unknown)(...args)
  }

export function runClassify(redoAi = false, auto = false): Promise<ClassifyResult> {
  return classifyFor(desktop, redoAi, auto)
}

let syncing: Promise<SyncResult> | null = null
/** After every bank sync, told whether it was the connection's first (background.ts checks for alerts). */
let afterSync: (first: boolean) => void = () => {}
export const onSyncDone = (fn: (first: boolean) => void): void => {
  afterSync = fn
}
/** A bank sync or a categorization is running. */
export const syncBusy = (): boolean => syncing !== null || !!classifyInFlight()

export function runSync(): Promise<SyncResult> {
  if (syncing) return syncing
  const first = feed.lastSyncAt() === null
  syncing = (async () => {
    const result = await feed.sync()
    if (result.added > 0) db.applyBucketRules()
    broadcast('data:changed')
    if (autoClassifyEnabled() && result.added > 0) result.classified = await runClassify(false, true)
    return result
  })().catch((err: unknown) => {
    // The Accounts page shows why it failed (the sync remembers it), so refresh it.
    broadcast('data:changed')
    throw err
  }).finally(() => {
    syncing = null
    broadcast('data:bulk')
    google.scheduleSync()
    afterSync(first)
  })
  return syncing
}

export function registerIpc(): void {
  // The handler table, as the hosted ledger runs it, with the desktop's context.
  for (const [method, def] of Object.entries(HANDLERS)) handle(method, (...args: unknown[]) => callHandler(def, desktop, args))

  // Opening what's on file: only a document the app keeps on record, inside the documents folder.
  handle('openTaxForm', gated('taxes', (file: string) => openOnFile(String(file), isTaxForm, 'Not a tax form on file')))
  handle('openCreditReport', (file: string) => openOnFile(String(file), isCreditReportFile, 'Not a credit report on file'))
  handle('openInsuranceFile', gated('insurance', (file: string) => openOnFile(String(file), isInsuranceFile, 'Not a policy document on file')))
  handle('openReceipt', async (name: string) => {
    const full = receiptPath(String(name))
    // The Receipts folder itself opens as a folder; anything else is a document.
    if (String(name) === RECEIPTS) {
      mkdirSync(full, { recursive: true })
      const err = await shell.openPath(full)
      if (err) throw new Error(err)
      return
    }
    if (!existsSync(full)) throw new Error('That receipt file is gone')
    await openDocument(full)
  })
  handle('exportCalendar', async () => {
    const r = await pickSave({ defaultPath: 'Finance Tracker.ics', filters: [{ name: 'Calendar', extensions: ['ics'] }] })
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, calendarIcs())
    return r.filePath
  })

  google.setOnPulled(() => {
    keepCreditReminder()
    broadcast('data:changed')
  })
  handle('googleStatus', google.status)
  handle('googleSetCredentials', gated('googleSync', (clientId: string, clientSecret: string) => google.setCredentials(clientId, clientSecret)))
  handle('googleConnect', gated('googleSync', google.connect))
  handle('googleDisconnect', google.disconnect)
  handle('googleSync', gated('googleSync', google.sync))
  handle('googleSetTasks', gated('googleSync', (on: boolean) => google.setTasks(!!on)))

  handle('setApiKey', (key: string) => {
    const k = key.trim()
    if (!k) throw new Error('Paste your API key first.')
    saveSecret('anthropicApiKey', k)
    keySaved(k)
  })
  handle('clearApiKey', () => {
    deleteSecret('anthropicApiKey')
    keyRemoved()
  })
  handle('checkApiKey', (key?: string) => checkApiKey(typeof key === 'string' ? key : undefined))
  // The request log stays on this machine: read in the table, copied to the clipboard on request, never sent.
  handle('copyAiRequest', (id: number) => {
    const r = getRequest(Number(id))
    if (!r) throw new Error('That request is no longer in the log')
    clipboard.writeText(JSON.stringify(r.request, null, 2))
  })
  // A report of an AI answer carries the version, the feature and its model, the reason, the note and the answer: nothing else.
  const report = (input: unknown): AiReport => {
    const r = cleanReport(input)
    return { ...r, version: app.getVersion(), model: routeModel(r.route) }
  }
  handle('copyAiReport', (r: unknown) => {
    const text = reportText(report(r))
    clipboard.writeText(text)
    return text
  })
  handle('emailAiReport', async (r: unknown) => {
    if (!SUPPORT_EMAIL) throw new Error('No support address in this build')
    await shell.openExternal(reportMailto(SUPPORT_EMAIL, report(r)))
  })
  handle('claudeCodeStatus', (opts: { force?: boolean }) => claudeCode.status(!!opts?.force))
  handle('claudeCodeSignIn', claudeCode.signIn)
  // Claude Desktop's connector: the open edition's and a development build's (connector.ts refuses the rest).
  handle('connectorStatus', connectorStatus)
  handle('setConnector', (patch: { on?: unknown; allowChanges?: unknown } | null) =>
    setConnector({ ...(patch?.on !== undefined ? { on: !!patch.on } : {}), ...(patch?.allowChanges !== undefined ? { allowChanges: !!patch.allowChanges } : {}) })
  )
  handle('installConnector', installConnector)
  handle('undoConnectorChange', (id: number) => undoConnectorChange(Number(id)))

  // Connecting a bank: Plaid's page opens in the browser; the call waits for it to finish (or Cancel), then syncs.
  const linked = async (reconnect?: string): Promise<SyncResult | null> => {
    const { linkToken, url } = await bank.linkUrl(reconnect)
    await shell.openExternal(url)
    const added = await bank.awaitLink(linkToken, reconnect)
    if (!added && !reconnect) return null
    broadcast('data:changed')
    try {
      return await runSync()
    } catch (err) {
      return { accounts: 0, added: 0, updated: 0, warnings: [message(err)] }
    }
  }
  handle('bankConnect', () => {
    // Without Plus (or its trial), one bank; the server holds the line too.
    if (bank.isConnected() && !can('multiBank')) throw new PlanError('multiBank')
    return linked()
  })
  handle('bankReconnect', (itemId: string) => linked(String(itemId)))
  handle('bankCancel', () => bank.cancelLink())
  handle('bankDisconnect', async (itemId: string) => {
    await bank.disconnect(String(itemId))
    broadcast('data:changed')
  })
  // SimpleFIN only in a development build and the open edition (no server for Plaid); other shipped builds have none.
  handle('simplefinConnect', async (token: string): Promise<SyncResult> => {
    if (!feed.simplefinOffered()) throw new Error('SimpleFIN isn\'t available.')
    await simplefin.connect(token)
    // The token is spent once claimed, so a first sync that fails still leaves a connection: it says why, and later syncs retry.
    try {
      return await runSync()
    } catch (err) {
      return { accounts: 0, added: 0, updated: 0, warnings: [message(err)] }
    }
  })
  handle('simplefinDisconnect', () => {
    simplefin.disconnect()
    broadcast('data:changed')
  })
  handle('sync', runSync)

  handle('csvPick', async () => {
    const pick = await pickOpen({ title: 'Import transactions', filters: [{ name: 'CSV, QFX, OFX, QIF', extensions: ['csv', 'txt', ...statement.STATEMENT_TYPES] }], properties: ['openFile'] })
    if (pick.canceled || !pick.filePaths[0]) return null
    return statement.isStatementFile(pick.filePaths[0]) ? statement.preview(pick.filePaths[0]) : csv.preview(pick.filePaths[0])
  })
  handle('exportCsv', async () => {
    const pick = await pickSave({ title: 'Export transactions', defaultPath: `transactions-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (pick.canceled || !pick.filePath) return null
    writeFileSync(pick.filePath, transactionsCsv(db.allTransactionsForExport()), 'utf8')
    return pick.filePath
  })
  handle('openDocumentsFolder', async () => {
    mkdirSync(docsDir(), { recursive: true })
    await shell.openPath(docsDir())
  })
  handle('openDataFolder', async () => {
    // A copy of finance.db taken by hand is complete only once the write-ahead log is folded in.
    db.checkpoint()
    await openAppFolder(app.getPath('userData'))
  })
  handle('deleteAllData', () => deleteAllData(currentDbFiles()))
  handle('backupNow', async () => {
    // Not Documents by default: OneDrive's folder backup takes it, and an encrypted copy's key file goes beside it.
    const pick = await pickSave({ title: 'Back up now', defaultPath: join(app.getPath('downloads'), `finance-${timeStamp(new Date())}.db`), filters: [{ name: 'Database', extensions: ['db'] }] })
    if (pick.canceled || !pick.filePath) return null
    if (resolve(pick.filePath) === resolve(dbFile())) throw new Error('That is the current database')
    await db.backupTo(pick.filePath)
    // An encrypted copy opens elsewhere with its key file (sealed: the recovery code opens it) beside it.
    const keyFile = sessionKeyFile()
    if (db.dbEncrypted() && keyFile) writeFileDurably(join(dirname(pick.filePath), `${basename(pick.filePath, extname(pick.filePath))}.key`), readFileSync(keyFile))
    return pick.filePath
  })
  handle('restoreBackup', async () => {
    mkdirSync(backupsDir(), { recursive: true })
    const pick = await pickOpen({ title: 'Restore backup', defaultPath: backupsDir(), filters: [{ name: 'Database', extensions: ['db'] }], properties: ['openFile'] })
    if (pick.canceled || !pick.filePaths[0]) return null
    return restore(pick.filePaths[0])
  })
  handle('restoreBackupCode', (code: string) => {
    if (!restoreWaiting) throw new Error('No restore is waiting for a recovery code')
    return restore(restoreWaiting, String(code ?? ''))
  })
  handle('exportAll', async () => {
    const pick = await pickSave({ title: 'Export all data', defaultPath: `finance-tracker-${timeStamp(new Date())}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (pick.canceled || !pick.filePath) return null
    writeFileSync(pick.filePath, JSON.stringify(db.exportAll(), null, 1), 'utf8')
    return pick.filePath
  })
  handle('openBackupsFolder', async () => {
    mkdirSync(backupsDir(), { recursive: true })
    await openAppFolder(backupsDir())
  })
  handle('openExternal', async (url: string) => {
    if (!/^https:\/\//i.test(url)) throw new Error('Only https links can be opened.')
    await shell.openExternal(url)
  })
  handle('checkForUpdates', checkForUpdates)
  handle('copyDiagnostics', () => clipboard.writeText(diagnostics()))

  registerSetupIpc(handle, broadcast)
  registerSyncIpc(handle, broadcast)
  registerAlertsIpc(handle)
  registerMoveIpc(handle)
  registerDatabaseIpc(handle, currentDbFiles, broadcast)
}
