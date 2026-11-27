// electron-updater's autoUpdater, as src/main/updater.ts uses it. What the feed answers is the test's
// (state.mjs feed), a download ends when the test emits 'update-downloaded', and every use is noted.
import { EventEmitter } from 'node:events'
import { H } from './state.mjs'

class StandIn extends EventEmitter {
  constructor() {
    super()
    this.autoDownload = true
    this.autoInstallOnAppQuit = true
    this.logger = null
    this.feedUrl = null
  }
  setFeedURL(options) {
    this.feedUrl = options.url
  }
  async checkForUpdates() {
    H.checks.push(Date.now())
    return H.feed()
  }
  quitAndInstall(silent, runAfter) {
    H.installs.push({ silent, runAfter, installOnQuit: this.autoInstallOnAppQuit })
  }
}

export const autoUpdater = new StandIn()
H.updater = autoUpdater
