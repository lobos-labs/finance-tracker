import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { UnlockCancelled } from './dbopen'
import { isTrustedSender } from './ipc'
import { chrome } from './theme'
import { APP_NAME } from '../shared/app'

// The one window shown before the database opens: the recovery code, asked
// for when the key file beside the database was sealed for another computer or
// Windows account (a data folder brought over, or Windows reinstalled). It's
// the app's own page (index.html#unlock) with one field.

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

let shown: BrowserWindow | null = null

/** Closes the window once the main window is up (closing it sooner would leave no window, which quits the app). */
export function closeUnlockWindow(): void {
  shown?.destroy()
  shown = null
}

/** Shows the window until `tryCode` accepts a code (resolves; the window waits hidden for closeUnlockWindow) or the window is closed (UnlockCancelled). */
export function askRecoveryCode(tryCode: (code: string) => Promise<void>): Promise<void> {
  // The theme setting is in the database, which isn't open yet: the window follows the system's.
  const win = new BrowserWindow({
    width: 520,
    height: 340,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: APP_NAME,
    icon: join(app.getAppPath(), 'resources', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: chrome().color,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  // The code typed in stays out of screenshots, screen sharing and Recall.
  win.setContentProtection(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#unlock`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'unlock' })

  return new Promise((resolve, reject) => {
    let done = false
    ipcMain.handle('unlockDatabase', async (e, code: unknown) => {
      if (!isTrustedSender(e) || e.sender !== win.webContents) return { ok: false, error: 'Untrusted sender' }
      try {
        await tryCode(String(code ?? ''))
      } catch (err) {
        return { ok: false, error: message(err) }
      }
      done = true
      ipcMain.removeHandler('unlockDatabase')
      shown = win
      win.hide()
      resolve()
      return { ok: true, data: true }
    })
    win.on('closed', () => {
      if (done) return
      ipcMain.removeHandler('unlockDatabase')
      reject(new UnlockCancelled())
    })
  })
}
