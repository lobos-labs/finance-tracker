import { app } from 'electron'
import { HIDDEN_ARG, loginOffered, notificationSettings, setNotificationSettings, setNumbersHidden } from './alerts'
import type { NotificationPatch } from '../shared/types'

// Settings → Notifications (every plan): the switches, quiet hours, the pause,
// keep running in the background and open at login. Registered from ipc.ts;
// the tray and the notifications themselves are background.ts's.

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void

/** Starts the app at sign-in, in the tray, or stops it; a shipped build outside the Store only (alerts.ts, loginOffered). Needs no database (Delete all data turns it off). */
export function applyLoginItem(on: boolean): void {
  if (!loginOffered()) return
  app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] })
}

export function registerAlertsIpc(handle: Handle): void {
  handle('getNotificationSettings', notificationSettings)
  handle('setNotificationSettings', (patch: NotificationPatch) => {
    const before = notificationSettings().openAtLogin
    const s = setNotificationSettings(patch && typeof patch === 'object' ? patch : {})
    if (s.openAtLogin !== before) applyLoginItem(s.openAtLogin)
    return s
  })
  handle('setNumbersHidden', (on: boolean) => setNumbersHidden(!!on))
}
