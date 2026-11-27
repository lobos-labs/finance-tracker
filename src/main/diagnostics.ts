import { app } from 'electron'
import { release, type } from 'node:os'
import { lastLines, logFile } from './log'
import { updatesOn } from './updater'
import { SUPPORT_EMAIL } from './build'
import { dbEncrypted } from './db'
import { APP_NAME } from '../shared/app'
import type { AppInfo } from '../shared/types'

const LOG_LINES = 200

export function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    os: `${type()} ${release()} ${process.arch}`,
    dataPath: app.getPath('userData'),
    logPath: logFile(),
    updates: updatesOn(),
    supportEmail: SUPPORT_EMAIL,
    platform: 'desktop'
  }
}

/** What "Copy diagnostics" puts on the clipboard: the build, the machine, the folders and the log's tail. */
export function diagnostics(): string {
  const i = appInfo()
  return [
    `${APP_NAME} ${i.version}${app.isPackaged ? '' : ' (unpackaged)'}`,
    `Electron ${i.electron}, Chromium ${i.chromium}, Node ${process.versions.node}`,
    i.os,
    `Data: ${i.dataPath}`,
    `Database: ${dbEncrypted() ? 'encrypted' : 'not encrypted'}`,
    `Log: ${i.logPath ?? 'none'}`,
    `Updates: ${i.updates ? 'on' : 'off'}`,
    '',
    ...lastLines(LOG_LINES)
  ].join('\n')
}
