// Electron (and electron-updater) as the tests need them: enough for the main
// process's modules to load under plain Node and for ipc.ts to register its
// handlers, which a test then calls. Folders point at a temp folder; dialogs
// cancel; nothing opens, encrypts or goes online.

import { join } from 'node:path'

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** What ipc.ts registered, by channel. */
export const handlers = new Map<string, Handler>()

let base = ''
const paths: Record<string, string> = {}

/** Points every app folder into one temp folder. */
export function setBase(dir: string, version: string): void {
  base = dir
  appVersion = version
  for (const name of ['userData', 'appData', 'documents', 'desktop', 'downloads', 'home', 'temp', 'logs']) paths[name] = join(dir, name)
}

let appVersion = '0.0.0'

const refused = (what: string) => (): never => {
  throw new Error(`${what} is not available in the demo dump`)
}

export const app = {
  isPackaged: true,
  getPath: (name: string): string => {
    if (!base) throw new Error('demo-electron: setBase first')
    return paths[name] ?? join(base, name)
  },
  setPath: (name: string, value: string): void => {
    paths[name] = value
  },
  getVersion: (): string => appVersion,
  getAppPath: (): string => join(base, 'app'),
  getName: (): string => 'Finance Tracker',
  on: (): void => {},
  once: (): void => {},
  whenReady: (): Promise<void> => Promise.resolve(),
  quit: (): void => {},
  exit: (): void => {},
  relaunch: (): void => {},
  requestSingleInstanceLock: (): boolean => true
}

export const ipcMain = {
  handle: (channel: string, fn: Handler): void => void handlers.set(channel, fn),
  removeHandler: (channel: string): void => void handlers.delete(channel),
  on: (): void => {}
}

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  getFocusedWindow: (): null => null
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: true; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async (): Promise<{ canceled: true; filePath: undefined }> => ({ canceled: true, filePath: undefined }),
  showMessageBox: async (): Promise<{ response: number; checkboxChecked: boolean }> => ({ response: 1, checkboxChecked: false }),
  showErrorBox: (): void => {}
}

export const shell = {
  openPath: async (): Promise<string> => 'Not in the demo dump',
  openExternal: refused('shell.openExternal'),
  showItemInFolder: (): void => {}
}

export const clipboard = { writeText: (): void => {}, readText: (): string => '', clear: (): void => {} }

/** No OS keystore: secrets can't be saved, and none are read. */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  getSelectedStorageBackend: (): string => 'basic_text',
  encryptString: refused('safeStorage.encryptString'),
  decryptString: refused('safeStorage.decryptString')
}

export const nativeTheme = { themeSource: 'dark' }

export const session = {
  defaultSession: { setPermissionRequestHandler: (): void => {}, setPermissionCheckHandler: (): void => {}, on: (): void => {} }
}

export const net = { fetch: refused('net.fetch'), request: refused('net.request') }

export const webUtils = { getPathForFile: (): string => '' }

/** electron-updater: never checks (the dump's build has no feed). */
export const autoUpdater = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: (): void => {},
  setFeedURL: (): void => {},
  checkForUpdates: refused('autoUpdater.checkForUpdates'),
  quitAndInstall: (): void => {}
}

export default { app, ipcMain, BrowserWindow, dialog, shell, clipboard, safeStorage, nativeTheme, session, net, webUtils, autoUpdater }
