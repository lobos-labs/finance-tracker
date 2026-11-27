import { after, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { advance, available, boot, H, HOUR, MINUTE, offline, settle, until } from './update-notice/drive.mjs'
import { APP_NAME } from '../src/shared/app.ts'

// An update on a build that installs its own, as a Windows build does: one run of the app, told in order, with
// the real src/main/updater.ts and src/main/background.ts over stand-ins for Electron and electron-updater
// (test/update-notice). What a packaged build does with the real ones is installer-test/self-update.mjs's.

const app = await boot('win32')
const logged = (text: string): number => app.logLines().filter((line: string) => line.includes(text)).length
const READY = [`${APP_NAME} 0.1.1 is ready`, 'Click to restart and install it']

describe('an update on a build that installs its own', () => {
  after(() => {
    mock.timers.reset()
    mock.restoreAll()
    rmSync(app.dir, { recursive: true, force: true })
  })

  test('the feed is asked 30 seconds after the start, and a check that fails is tried again ten minutes later', async () => {
    H.feed = offline
    await until(29_000)
    assert.equal(H.checks.length, 0)
    await until(30_000)
    assert.equal(H.checks.length, 1)
    await until(10 * MINUTE + 29_000)
    assert.equal(H.checks.length, 1)
    await until(10 * MINUTE + 30_000)
    assert.equal(H.checks.length, 2)
    assert.equal(H.shown.length, 0)
  })

  test('the next try finds the update, which downloads: nothing is said before the download ends', async () => {
    H.feed = available('0.1.1')
    await until(20 * MINUTE + 30_000)
    assert.equal(H.checks.length, 3)
    assert.equal(H.updater.autoDownload, true)
    assert.equal(H.updater.autoInstallOnAppQuit, true)
    assert.equal(H.updater.feedUrl, 'https://github.com/example-org/finance-app/releases/latest/download')
    assert.equal(app.updater.updateReady(), null)
    assert.equal(app.updater.updateOut(), null)
    // That check did not fail, so nothing is tried again before the next scheduled one.
    await until(50 * MINUTE)
    assert.equal(H.checks.length, 3)
    assert.equal(H.shown.length, 0)
    assert.equal(H.sent.length, 0)
  })

  test('when the download ends a notification says it is ready, and a click on it restarts into the new version', async () => {
    H.updater.emit('update-downloaded', { version: '0.1.1' })
    await settle()
    assert.deepEqual(
      H.shown.map((s: { title: string; body: string }) => [s.title, s.body]),
      [READY]
    )
    assert.equal(app.updater.updateReady(), '0.1.1')
    assert.equal(logged('info [updater] ready notification asked: 0.1.1'), 1)
    assert.equal(logged('info [updater] ready notification shown: 0.1.1'), 1)
    assert.deepEqual(H.installs, [])
    H.shown[0].n.emit('click', {})
    assert.deepEqual(H.installs, [{ silent: true, runAfter: true, installOnQuit: true }])
    assert.deepEqual(H.opened, [])
  })

  test('it is said once however often the download is announced, and again once a day while it waits', async () => {
    // electron-updater announces a kept download again after every start, and could at any check.
    H.updater.emit('update-downloaded', { version: '0.1.1' })
    await settle()
    assert.equal(H.shown.length, 1)
    await until(24 * HOUR + 49 * MINUTE)
    assert.equal(H.shown.length, 1)
    // The hourly look a day after the first.
    await until(25 * HOUR)
    assert.equal(H.shown.length, 2)
    assert.deepEqual([H.shown[1].title, H.shown[1].body], READY)
    // The day's reminder takes the place of the one before in the notification center.
    assert.equal(H.shown[0].n.closed, true)
    assert.equal(H.shown[1].n.closed, false)
  })

  test('paused notifications and quiet hours hold it back, and the hourly look after they end says it', async () => {
    H.held = true
    await until(50 * HOUR + 30 * MINUTE)
    assert.equal(H.shown.length, 2)
    H.held = false
    await until(50 * HOUR + 59 * MINUTE)
    assert.equal(H.shown.length, 2)
    await until(51 * HOUR)
    assert.equal(H.shown.length, 3)
  })

  test('a notification that could not be made is tried again at the next hourly look, and nothing is thrown at the updater', async () => {
    H.notificationThrows = true
    await until(75 * HOUR + 30 * MINUTE)
    assert.equal(H.shown.length, 3)
    assert.ok(logged('error [updater] the update notification failed') >= 1)
    // The same event the updater sends: its listener returns.
    assert.doesNotThrow(() => H.updater.emit('update-downloaded', { version: '0.1.1' }))
    H.notificationThrows = false
    await until(76 * HOUR)
    assert.equal(H.shown.length, 4)
  })

  test('one the system refuses is logged as failed and not as shown', async () => {
    const shownBefore = logged('ready notification shown: 0.1.1')
    assert.equal(shownBefore, 4)
    H.systemRefuses = true
    await until(100 * HOUR)
    H.systemRefuses = false
    assert.equal(H.shown.length, 5)
    assert.equal(logged('ready notification asked: 0.1.1'), 5)
    assert.equal(logged('ready notification shown: 0.1.1'), shownBefore)
    assert.equal(logged('info [updater] notification failed: the system refused it'), 1)
  })

  test("Settings' check answers ready, and the feed is not asked again while the update waits", async () => {
    assert.deepEqual(await app.updater.checkForUpdates(), { status: 'ready', version: '0.1.1' })
    // Sixteen scheduled checks have gone by since the download.
    assert.equal(H.checks.length, 3)
    assert.equal(H.sent.length, 0)
  })

  test('the tray offers Restart to update, which installs it', () => {
    H.trayHandlers['right-click']()
    const menu = H.menus.at(-1)
    assert.deepEqual(
      menu.map((item: { label?: string; type?: string }) => item.label ?? item.type),
      ['Open', 'Sync now', 'Pause notifications for 1 hour', 'Restart to update to 0.1.1', 'separator', 'Quit']
    )
    menu.find((item: { label?: string }) => item.label === 'Restart to update to 0.1.1').click()
    assert.equal(H.installs.length, 2)
    assert.deepEqual(H.installs[1], { silent: true, runAfter: true, installOnQuit: true })
  })

  test('held for a quit the person did not make, the update installs at the next one they do', () => {
    app.updater.holdUpdate()
    assert.equal(H.updater.autoInstallOnAppQuit, false)
    assert.equal(app.updater.installUpdate(), true)
    assert.deepEqual(H.installs[2], { silent: true, runAfter: true, installOnQuit: true })
  })

  test('where updates are off, a check says so and asks nothing', async () => {
    H.packaged = false
    assert.equal(app.updater.updatesOn(), false)
    assert.deepEqual(await app.updater.checkForUpdates(), { status: 'off', version: null })
    assert.equal(H.checks.length, 3)
    H.packaged = true
  })
})
