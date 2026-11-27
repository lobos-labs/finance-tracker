import { app, BrowserWindow, dialog, session, shell, type MessageBoxOptions } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bridgeDir } from './bridge'
import { forgetTranscripts, forgetWorkDir } from './claudeCode'
import { CHAT_FOLDER } from './documents'
import * as google from './google'
import { applyLoginItem } from './ipc-alerts'
import { openEdition } from './license'
import { forgetSync, syncPaired } from './ipc-sync'
import { docsDir } from './paths'
import { removeData } from './wipeFiles'
import type { DbFiles } from './dbopen'
import * as bank from './bank'
import * as simplefin from './simplefin'

// Delete all data: the books and what the app keeps beside them (dataLocations),
// named first, then removed, then the app quits. The documents folder is the
// user's own (they put the files there), so it goes only on a second, separate
// confirmation. Electron's own files in the data folder, the updater's cache
// and Claude Desktop's extension stay (PRIVACY.md in the public tree lists them).

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function ask(opts: MessageBoxOptions): Promise<number> {
  const win = BrowserWindow.getFocusedWindow()
  return (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => r.response)
}

const remove = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (err) {
    console.error(`[wipe] ${path}: ${message(err)}`)
  }
}

/** What goes, as paths, in the order it's deleted: the database's key file and the Encrypted switch with it, where they exist. */
export function dataLocations(files: DbFiles): string[] {
  const data = app.getPath('userData')
  return [files.dbFile, ...[files.keyFile, files.switchFile].filter((p) => existsSync(p)), files.backupsDir, join(data, 'logs'), join(data, 'claude'), join(bridgeDir(), 'inbox'), join(bridgeDir(), 'outbox'), join(docsDir(), CHAT_FOLDER)]
}

/**
 * The first confirmation's list: the locations, then what goes elsewhere. The open edition names only the locations
 * that are there (a shipped one never starts the file bridge or Claude Code, so their folders are only ever left by
 * another build) and no Claude Code transcripts, which it never makes (its public tree's forgetTranscripts does
 * nothing). Every other build names them all, as before.
 */
export function deleteList(o: { locations: string[]; openEdition: boolean; exists: (path: string) => boolean; google: boolean; paired: boolean; plaid: boolean; bridge: string | null }): string[] {
  return [
    ...(o.openEdition ? o.locations.filter((p) => o.exists(p)) : o.locations),
    o.openEdition ? null : 'Claude Code transcripts of reviews',
    o.google ? 'Google Calendar access (revoked)' : null,
    o.paired ? 'Phone and web viewer pairing (wiped at the relay)' : null,
    o.plaid ? 'Bank connections (removed at Plaid)' : null,
    o.bridge ? `Bank access: revoke it at ${o.bridge} (opens after)` : null
  ].filter((x): x is string => !!x)
}

/** Asks twice, removes the bank connections at Plaid, deletes, opens a SimpleFIN bridge's site (a development build's or the open edition's) for the user to revoke it there, and quits. False when cancelled. */
export async function deleteAllData(files: DbFiles): Promise<boolean> {
  const dbFile = files.dbFile
  const locations = dataLocations(files)
  // The documents folder's path is a setting in the database, which is closed before anything is removed.
  const docsPath = docsDir()
  const bridge = simplefin.bridgeOrigin()
  const first = await ask({
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete all data',
    message: 'Delete all data and quit?',
    detail: deleteList({ locations, openEdition: openEdition(), exists: existsSync, google: google.status().connected, paired: syncPaired(), plaid: bank.isConnected(), bridge }).join('\n')
  })
  if (first !== 0) return false
  const docs = await ask({
    type: 'warning',
    buttons: ['Delete folder', 'Keep folder'],
    defaultId: 1,
    cancelId: 1,
    title: 'Documents folder',
    message: 'Also delete the documents folder?',
    detail: docsPath
  })

  await forgetSync()
  await bank.disconnectAll().catch((err) => console.error('[wipe] bank:', message(err)))
  try {
    await google.disconnect()
  } catch (err) {
    console.error('[wipe] google:', message(err))
  }
  removeData(dbFile, locations)
  try {
    forgetWorkDir()
    forgetTranscripts()
  } catch (err) {
    console.error('[wipe] claude:', message(err))
  }
  if (docs === 0) remove(docsPath)
  // Off at login too: started hidden there, the app would make a fresh data folder at every sign-in.
  try {
    applyLoginItem(false)
  } catch (err) {
    console.error('[wipe] login item:', message(err))
  }
  await session.defaultSession.clearStorageData().catch(() => {})
  if (bridge) await shell.openExternal(bridge).catch(() => {})
  app.quit()
  return true
}
