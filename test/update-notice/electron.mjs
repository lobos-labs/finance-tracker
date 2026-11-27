// Electron, as src/main/updater.ts and src/main/background.ts use it: every use is noted in state.mjs.
import { EventEmitter } from 'node:events'
import { H } from './state.mjs'

export const app = {
  get isPackaged() {
    return H.packaged
  },
  getAppPath: () => 'X:/app',
  getVersion: () => '0.1.0',
  quit() {},
  on() {},
  setAppUserModelId() {}
}

export class BrowserWindow {
  static getAllWindows() {
    return [{ webContents: { send: (channel, text) => H.sent.push({ at: Date.now(), channel, text }) } }]
  }
}

/** A notification is noted when it is asked for; the system's answer ('show', or 'failed') comes a moment later, as Electron's does. */
export class Notification extends EventEmitter {
  static isSupported() {
    return H.supported
  }
  constructor(options) {
    super()
    if (H.notificationThrows) throw new Error('the notification could not be made')
    this.options = options
    this.closed = false
  }
  show() {
    H.shown.push({ at: Date.now(), title: this.options.title, body: this.options.body, n: this })
    const refused = H.systemRefuses
    setImmediate(() => (refused ? this.emit('failed', {}, 'the system refused it') : this.emit('show', {})))
  }
  close() {
    this.closed = true
  }
}

export const shell = {
  openExternal: async (url) => {
    H.opened.push(url)
  }
}

/** A menu is its template: the tests read the labels and call the clicks. */
export const Menu = { buildFromTemplate: (template) => template }

export const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) }

export class Tray {
  setToolTip() {}
  on(event, handler) {
    H.trayHandlers[event] = handler
  }
  setContextMenu() {}
  popUpContextMenu(menu) {
    H.menus.push(menu)
  }
}
