import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// When a downloaded update installs, and when it must not: the wiring that needs Electron's own app, window or
// build settings is read here as text. The rules are in updateFeed.ts (test/update-feed.test.ts), and updater.ts
// and background.ts run over stand-ins for Electron in test/update-notice-windows.test.ts and -mac.test.ts.

const here = dirname(fileURLToPath(import.meta.url))
const source = (file: string): string => readFileSync(join(here, '..', 'src', file), 'utf8')

describe('installing an update', () => {
  const updater = source('main/updater.ts')

  test('a build that cannot install an update downloads nothing and says where the new version is', () => {
    assert.match(updater, /autoUpdater\.autoDownload = installsItself\(\)/)
    assert.match(updater, /autoUpdater\.autoInstallOnAppQuit = installsItself\(\)/)
    assert.match(updater, /if \(!installsItself\(\)\) \{\s+out = \{ version: r\.updateInfo\.version, url: releasesPage\(updateUrl\(\)\) \}\s+return \{ status: 'available', version: out\.version, url: out\.url \}\s+\}/)
    // A Mac build installs its own only when it was compiled saying so.
    assert.match(updater, /installsItself = \(\): boolean => selfUpdating\(process\.platform, typeof __MAC_SELF_UPDATE__ === 'string' \? __MAC_SELF_UPDATE__ : ''\)/)
    assert.match(readFileSync(join(here, '..', 'electron.vite.config.ts'), 'utf8'), /__MAC_SELF_UPDATE__: JSON\.stringify\(process\.env\['FINANCE_TRACKER_MAC_SELF_UPDATE'\] === '1' \? '1' : ''\)/)
  })

  test('Windows ending the session installs nothing: the installer would be cut off half way', () => {
    const background = source('main/background.ts')
    assert.match(background, /w\.on\('session-end', \(\) => \{\s+quitting = true\s+holdUpdate\(\)\s+app\.quit\(\)\s+\}\)/)
    // Holding uses the instance alone, so nothing is built where updates are off.
    assert.match(updater, /export function holdUpdate\(\): void \{\s+if \(instance\) instance\.autoInstallOnAppQuit = false\s+\}/)
  })

  test('the app restarting itself installs nothing either', () => {
    const database = source('main/ipc-database.ts')
    assert.equal(database.match(/holdUpdate\(\)\s+app\.relaunch\(\)/g)?.length, 2)
    assert.match(source('main/ipc.ts'), /holdUpdate\(\)\s+app\.relaunch\(\)\s+app\.exit\(0\)/)
    // Every relaunch in the main process holds first.
    for (const file of ['main/ipc.ts', 'main/ipc-database.ts']) {
      const text = source(file)
      assert.equal(text.match(/app\.relaunch\(\)/g)?.length, text.match(/holdUpdate\(\)\s+app\.relaunch\(\)/g)?.length, file)
    }
  })

  // What is said about an update, when, and what a click does (the notification, the tray's item, the checks and
  // their retries) runs for real in test/update-notice-windows.test.ts and test/update-notice-mac.test.ts. Read
  // here: only what those runs can't reach.
  test('the only page a notification or the tray opens is an https one, and the rule hears whether notifications are held back', () => {
    const background = source('main/background.ts')
    assert.match(background, /return o \? \{ version: o\.version, page: \/\^https:\\\/\\\/\/i\.test\(o\.url\) \? o\.url : '' \} : null/)
    assert.equal(background.match(/shell\.openExternal\(/g)?.length, 2)
    assert.equal(background.match(/shell\.openExternal\(out\.page\)/g)?.length, 2)
    // The stand-in for alerts.ts in those runs only answers held or not: that the real settings are asked is read here.
    assert.match(background, /held: heldBack\(Math\.floor\(now \/ 1000\), notificationSettings\(\)\)/)
  })

  test('Settings says what a check found, and opens the download page where the app cannot install it', () => {
    const settings = source('renderer/src/pages/Settings.tsx')
    assert.match(settings, /case 'available':/)
    assert.match(settings, /if \(r\.status === 'available' && r\.url\) void api\.openExternal\(r\.url\)/)
  })
})
