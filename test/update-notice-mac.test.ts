import { after, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { available, boot, H, HOUR, MINUTE, nothingNewer, offline, PAGE, settle, until } from './update-notice/drive.mjs'
import { APP_NAME } from '../src/shared/app.ts'

// A newer version on a build that can't install one itself, as a Mac build without a Developer ID can't: one run
// of the app, told in order, with the real src/main/updater.ts and src/main/background.ts over stand-ins for
// Electron and electron-updater (test/update-notice). Whether macOS shows a notification from such a build is
// not something a test here can tell: the window's line and the tray's item don't depend on it.

const app = await boot('darwin')
const logged = (text: string): number => app.logLines().filter((line: string) => line.includes(text)).length
const said = (): string[][] => H.shown.map((s: { title: string; body: string }) => [s.title, s.body])
const windowLines = (): string[] => H.sent.map((s: { channel: string; text: string }) => `${s.channel}: ${s.text}`)
const trayLabels = (): string[] => {
  H.trayHandlers['right-click']()
  return H.menus.at(-1).map((item: { label?: string; type?: string }) => item.label ?? item.type)
}
const OUT = (version: string): string[] => [`${APP_NAME} ${version} is out`, 'Click to open its download page']
const LINE = (version: string): string => `notify: Version ${version} is out · Settings → Data → Check for updates opens the download`

describe("a newer version on a build that can't install it itself", () => {
  after(() => {
    mock.timers.reset()
    mock.restoreAll()
    rmSync(app.dir, { recursive: true, force: true })
  })

  test('a check that fails is tried again three times, ten minutes apart, then left to the next scheduled check', async () => {
    H.feed = offline
    await until(30_000)
    assert.equal(H.checks.length, 1)
    await until(10 * MINUTE + 30_000)
    assert.equal(H.checks.length, 2)
    await until(20 * MINUTE + 30_000)
    assert.equal(H.checks.length, 3)
    await until(30 * MINUTE + 30_000)
    assert.equal(H.checks.length, 4)
    await until(6 * HOUR - MINUTE)
    assert.equal(H.checks.length, 4)
    // The scheduled check, six hours in: it fails too, and is not tried again.
    await until(6 * HOUR)
    assert.equal(H.checks.length, 5)
    await until(7 * HOUR)
    assert.equal(H.checks.length, 5)
    assert.equal(H.shown.length, 0)
    assert.equal(H.sent.length, 0)
  })

  test('the build downloads nothing and installs nothing at a quit', () => {
    assert.equal(app.updater.installsItself(), false)
    assert.equal(H.updater.autoDownload, false)
    assert.equal(H.updater.autoInstallOnAppQuit, false)
  })

  test('the next scheduled check finds a newer version: a notification says it is out, and the window gets its line', async () => {
    H.feed = available('0.1.1')
    await until(12 * HOUR)
    assert.equal(H.checks.length, 6)
    assert.deepEqual(said(), [OUT('0.1.1')])
    assert.deepEqual(windowLines(), [LINE('0.1.1')])
    assert.deepEqual(app.updater.updateOut(), { version: '0.1.1', url: PAGE })
    assert.equal(app.updater.updateReady(), null)
    assert.equal(logged('info [updater] out notification asked: 0.1.1'), 1)
    assert.equal(logged('info [updater] out notification shown: 0.1.1'), 1)
  })

  test('a click on it opens the download page, and nothing is installed', async () => {
    H.shown[0].n.emit('click', {})
    await settle()
    assert.deepEqual(H.opened, [PAGE])
    assert.deepEqual(H.installs, [])
    assert.equal(app.updater.installUpdate(), false)
  })

  test('the tray offers the download page', async () => {
    assert.deepEqual(trayLabels(), ['Open', 'Sync now', 'Pause notifications for 1 hour', 'Download version 0.1.1', 'separator', 'Quit'])
    H.menus.at(-1).find((item: { label?: string }) => item.label === 'Download version 0.1.1').click()
    await settle()
    assert.deepEqual(H.opened, [PAGE, PAGE])
  })

  test('later checks that day say nothing more, and the next day brings one reminder in place of the first', async () => {
    await until(35 * HOUR + 59 * MINUTE)
    // Checks at 18, 24 and 30 hours found it again.
    assert.equal(H.checks.length, 9)
    assert.equal(H.shown.length, 1)
    assert.deepEqual(windowLines(), [LINE('0.1.1')])
    await until(36 * HOUR)
    assert.deepEqual(said(), [OUT('0.1.1'), OUT('0.1.1')])
    assert.equal(H.shown[0].n.closed, true)
    assert.equal(H.shown[1].n.closed, false)
    assert.deepEqual(windowLines(), [LINE('0.1.1')])
  })

  test("Settings' check finds it too, with the page to open", async () => {
    assert.deepEqual(await app.updater.checkForUpdates(), { status: 'available', version: '0.1.1', url: PAGE })
    assert.equal(H.shown.length, 2)
  })

  test('a version that is withdrawn is forgotten: no more reminders, and nothing in the tray', async () => {
    H.feed = nothingNewer
    await until(42 * HOUR)
    assert.equal(app.updater.updateOut(), null)
    assert.deepEqual(await app.updater.checkForUpdates(), { status: 'current', version: null })
    await until(90 * HOUR)
    assert.equal(H.shown.length, 2)
    assert.deepEqual(trayLabels(), ['Open', 'Sync now', 'Pause notifications for 1 hour', 'separator', 'Quit'])
  })

  test('a check that fails forgets nothing: the version found before is still out', async () => {
    H.feed = available('0.1.2')
    await until(96 * HOUR)
    assert.deepEqual(said().at(-1), OUT('0.1.2'))
    assert.equal(H.shown.length, 3)
    assert.deepEqual(windowLines(), [LINE('0.1.1'), LINE('0.1.2')])
    H.feed = offline
    await until(102 * HOUR)
    assert.deepEqual(app.updater.updateOut(), { version: '0.1.2', url: PAGE })
    assert.deepEqual(trayLabels(), ['Open', 'Sync now', 'Pause notifications for 1 hour', 'Download version 0.1.2', 'separator', 'Quit'])
  })

  test('where notifications are not supported the window still gets its line, and the notification comes once they are', async () => {
    H.supported = false
    H.feed = available('0.1.3')
    // The failed check at 102 hours is tried again ten minutes later, and finds the next version.
    await until(102 * HOUR + 10 * MINUTE)
    assert.equal(H.shown.length, 3)
    assert.deepEqual(windowLines(), [LINE('0.1.1'), LINE('0.1.2'), LINE('0.1.3')])
    H.supported = true
    await until(103 * HOUR)
    assert.deepEqual(said().at(-1), OUT('0.1.3'))
    assert.equal(H.shown.length, 4)
  })
})
