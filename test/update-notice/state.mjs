// What the stand-ins beside this file record, and the switches the tests set. One object for the process:
// each test file runs in its own.

export const H = {
  /** app.isPackaged */
  packaged: true,
  /** Notification.isSupported() */
  supported: true,
  /** making a notification throws */
  notificationThrows: false,
  /** the system refuses a notification it was asked to show: 'failed' comes instead of 'show' */
  systemRefuses: false,
  /** paused, or in quiet hours (alerts.mjs heldBack) */
  held: false,
  /** what the feed answers a check with; a function, so it can throw */
  feed: () => null,

  /** every notification asked for: { at, title, body, n } */
  shown: [],
  /** addresses opened in the browser */
  opened: [],
  /** lines sent to the window: { at, channel, text } */
  sent: [],
  /** the times the feed was asked */
  checks: [],
  /** quitAndInstall calls: { silent, runAfter, installOnQuit } */
  installs: [],
  /** the tray's event handlers by name, and the menus it popped up */
  trayHandlers: {},
  menus: [],
  /** electron-updater's stand-in, once it is made */
  updater: null
}
