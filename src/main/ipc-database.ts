import { app, BrowserWindow, dialog, safeStorage, type MessageBoxOptions, type SaveDialogOptions } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as db from './db'
import { safeStorageKeystore, type Keystore } from './dbkey'
import { checkRecoveryCode, confirmRecoveryCode, issueRecoveryCode, keySealScope, pendingRecoveryCode, readEncryptSwitch, recoveryFileProblem, recoveryPending, writeEncryptSwitch, type DbFiles } from './dbopen'
import { windowsAccountSeal } from './dpapi'
import { log } from './log'
import { holdUpdate } from './updater'
import { docsDir, extraDocsDirs } from './paths'
import { APP_NAME, RECOVERY_LINE } from '../shared/app'
import type { DatabaseState } from '../shared/types'

// Settings → Data's encryption rows and the setup wizard's last step: the
// recovery code (shown once, saved as a PDF or written down, then sealed in;
// no Copy, since Windows clipboard history and cloud clipboard would keep it),
// and a development build's Encrypted switch. Registered from ipc.ts.

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void

/** The OS keystore (safeStorage) with, on Windows, the account seal beside it (dpapi.ts). */
export const keystore = (): Keystore => safeStorageKeystore(safeStorage, process.platform, windowsAccountSeal())

export function databaseState(files: DbFiles): DatabaseState {
  const encrypted = db.dbEncrypted()
  return { encrypted, switchable: !app.isPackaged, switchOn: app.isPackaged || (readEncryptSwitch(files.switchFile) ?? encrypted), recoveryPending: encrypted && recoveryPending(), keySeal: keySealScope() }
}

const focused = (): BrowserWindow | null => BrowserWindow.getFocusedWindow()
const ask = (opts: MessageBoxOptions): Promise<number> => {
  const win = focused()
  return (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => r.response)
}
const pickSave = (opts: SaveDialogOptions): Promise<string | null> => {
  const win = focused()
  return (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)).then((r) => (r.canceled || !r.filePath ? null : r.filePath))
}

function shownCode(): string {
  const code = pendingRecoveryCode()
  if (!code) throw new Error('No recovery code is waiting to be saved')
  return code
}

/** The page the PDF is printed from: the code, the day and one line. Nothing in it runs. */
function codePage(code: string): string {
  const day = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(APP_NAME)} recovery code</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:72px;color:#111}h1{font-size:20px;font-weight:600;margin:0 0 28px}
.code{font-family:Consolas,Menlo,monospace;font-size:26px;letter-spacing:2px;border:1px solid #999;padding:18px 22px;display:inline-block}
p{font-size:13px;line-height:1.6;margin:22px 0 0}</style></head><body>
<h1>${esc(APP_NAME)} recovery code</h1><div class="code">${esc(code)}</div>
<p>${esc(day)}</p><p>${esc(RECOVERY_LINE[keySealScope()])} It opens a backup anywhere with the key file (finance.key) beside it.</p></body></html>`
}

async function printCode(files: DbFiles): Promise<string | null> {
  const code = shownCode()
  // Downloads, which OneDrive's folder backup leaves out (it takes Documents, where a Store build keeps the backups and their key file).
  const file = await pickSave({ title: 'Save recovery code', defaultPath: join(app.getPath('downloads'), `${APP_NAME} recovery code.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  if (!file) return null
  const problem = recoveryFileProblem(file, [docsDir(), ...extraDocsDirs(), files.backupsDir, app.getPath('userData')])
  if (problem) throw new Error(problem)
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(codePage(code))}`)
    writeFileSync(file, await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: false }))
  } finally {
    win.destroy()
  }
  return file
}

export function registerDatabaseIpc(handle: Handle, files: () => DbFiles, broadcast: (channel: string) => void): void {
  handle('newRecoveryCode', () => issueRecoveryCode())
  handle('printRecoveryCode', () => printCode(files()))
  handle('confirmRecoveryCode', async () => {
    const { rekey } = await confirmRecoveryCode(files().backupsDir, keystore(), undefined, (line) => log('db', line))
    broadcast('data:changed')
    if (!rekey) return
    // The database moves onto a new key at the next start (dbopen.ts), so the old code and an old key file open nothing after.
    const restart = await ask({ type: 'question', buttons: ['Restart', 'Later'], defaultId: 0, cancelId: 1, title: 'Database', message: 'Restart to change the database key?' })
    if (restart !== 0) return
    // The app is starting again: an update's installer would run over the copy that starts.
    holdUpdate()
    app.relaunch()
    app.quit()
  })
  handle('checkRecoveryCode', (code: string) => checkRecoveryCode(String(code ?? '')))
  // While a recovery code is on screen, screenshots, screen sharing and Recall see the window blank.
  handle('protectWindow', (on: boolean) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setContentProtection(!!on)
  })
  handle('setDbEncryption', async (on: boolean) => {
    if (app.isPackaged) throw new Error('A packaged build is always encrypted')
    writeEncryptSwitch(files().switchFile, !!on)
    broadcast('data:changed')
    if (!!on === db.dbEncrypted()) return
    const restart = await ask({ type: 'question', buttons: ['Restart', 'Later'], defaultId: 0, cancelId: 1, title: 'Database', message: on ? 'Restart to encrypt the database?' : 'Restart to decrypt the database?' })
    if (restart !== 0) return
    // The app is starting again: an update's installer would run over the copy that starts.
    holdUpdate()
    app.relaunch()
    app.quit()
  })
}
