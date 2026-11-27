import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { packageFamilyName, redirectedPath, storeBackupsDir, storeFolderTarget, underAppData, type StoreFolders } from '../src/main/storePaths.ts'

// A Microsoft Store build's folders: AppData writes land in the package's own
// LocalCache, which Explorer can't see through the app's eyes, so the app
// opens the real folder (or shows the one it sees, when the real one can't be
// found); backups go to the documents folder, which an uninstall leaves.

const EXE = 'C:\\Program Files\\WindowsApps\\Placeholder.FinanceTracker_0.1.0.0_x64__8wekyb3d8bbwe\\app\\Finance Tracker.exe'
const FOLDERS: StoreFolders = {
  appData: 'C:\\Users\\you\\AppData\\Roaming',
  localAppData: 'C:\\Users\\you\\AppData\\Local',
  family: 'Placeholder.FinanceTracker_8wekyb3d8bbwe'
}
const PKG = 'C:\\Users\\you\\AppData\\Local\\Packages\\Placeholder.FinanceTracker_8wekyb3d8bbwe'

describe('the package family name', () => {
  test('from the install folder under WindowsApps: <Name>_<PublisherId>', () => {
    assert.equal(packageFamilyName(EXE), 'Placeholder.FinanceTracker_8wekyb3d8bbwe')
    assert.equal(packageFamilyName('C:/Program Files/WindowsApps/Contoso.Ledger-App_2.10.3.0_arm64_en-us_1a2b3c4d5e6f7/app/x.exe'), 'Contoso.Ledger-App_1a2b3c4d5e6f7')
    assert.equal(packageFamilyName('D:\\WINDOWSAPPS\\FinanceTracker_1.0.0.0_neutral__abcdefghjkmnp\\app\\FinanceTracker.exe'), 'FinanceTracker_abcdefghjkmnp')
  })

  test('none outside a package, or from a folder that isn\'t a package\'s', () => {
    for (const p of [
      'C:\\Users\\you\\AppData\\Local\\Programs\\finance-tracker\\Finance Tracker.exe',
      'C:\\Users\\you\\code\\finance-tracker\\node_modules\\electron\\dist\\electron.exe',
      'C:\\Program Files\\WindowsApps\\',
      'C:\\Program Files\\WindowsApps\\FinanceTracker\\app\\FinanceTracker.exe',
      'C:\\Program Files\\WindowsApps\\FinanceTracker_1.0_x64__8wekyb3d8bbwe\\app\\FinanceTracker.exe',
      'C:\\Program Files\\WindowsApps\\FinanceTracker_1.0.0.0_x64__short\\app\\FinanceTracker.exe',
      'C:\\Program Files\\WindowsApps\\Finance_Tracker_1.0.0.0_x64__8wekyb3d8bbwe\\app\\FinanceTracker.exe',
      ''
    ])
      assert.equal(packageFamilyName(p), null, p)
  })
})

describe('the redirected folders', () => {
  test('%APPDATA% lands in LocalCache\\Roaming, %LOCALAPPDATA% in LocalCache\\Local', () => {
    assert.equal(redirectedPath('C:\\Users\\you\\AppData\\Roaming\\Finance Tracker', FOLDERS), `${PKG}\\LocalCache\\Roaming\\Finance Tracker`)
    assert.equal(redirectedPath('C:\\Users\\you\\AppData\\Roaming\\Finance Tracker\\backups', FOLDERS), `${PKG}\\LocalCache\\Roaming\\Finance Tracker\\backups`)
    assert.equal(redirectedPath('C:\\Users\\you\\AppData\\Local\\Finance Tracker\\cache', FOLDERS), `${PKG}\\LocalCache\\Local\\Finance Tracker\\cache`)
    // Windows paths compare without case, and a trailing slash changes nothing.
    assert.equal(redirectedPath('c:\\users\\YOU\\appdata\\roaming\\Finance Tracker\\', FOLDERS), `${PKG}\\LocalCache\\Roaming\\Finance Tracker`)
  })

  test('the package\'s own folder is itself; anything outside AppData, or an unknown family, is none', () => {
    assert.equal(redirectedPath(`${PKG}\\LocalCache\\Roaming\\Finance Tracker`, FOLDERS), `${PKG}\\LocalCache\\Roaming\\Finance Tracker`)
    assert.equal(redirectedPath('C:\\Users\\you\\Documents\\Finance Tracker\\Backups', FOLDERS), null)
    assert.equal(redirectedPath('C:\\Users\\you\\AppData\\RoamingX\\Finance Tracker', FOLDERS), null)
    assert.equal(redirectedPath('C:\\Users\\you\\AppData\\Roaming\\Finance Tracker', { ...FOLDERS, family: null }), null)
    assert.ok(underAppData('C:\\Users\\you\\AppData\\Roaming\\Finance Tracker', FOLDERS))
    assert.ok(!underAppData('C:\\Users\\you\\Documents\\Finance Tracker', FOLDERS))
  })

  test('what a Store build opens: the real folder when it\'s there, else the one it sees, shown in its parent', () => {
    const data = 'C:\\Users\\you\\AppData\\Roaming\\Finance Tracker'
    const real = `${PKG}\\LocalCache\\Roaming\\Finance Tracker`
    const seen: string[] = []
    const exists = (p: string): boolean => (seen.push(p), p === real)
    assert.deepEqual(storeFolderTarget(data, FOLDERS, exists), { open: real })
    assert.deepEqual(seen, [real])
    // Not created yet, or the family unknown: Explorer is shown the path the app sees.
    assert.deepEqual(storeFolderTarget(data, FOLDERS, () => false), { show: data })
    assert.deepEqual(storeFolderTarget(data, { ...FOLDERS, family: null }, () => true), { show: data })
    // The documents folder isn't redirected: it opens as it is, without a look.
    assert.deepEqual(
      storeFolderTarget('C:\\Users\\you\\Documents\\Finance Tracker\\Backups', FOLDERS, () => {
        throw new Error('not asked')
      }),
      { open: 'C:\\Users\\you\\Documents\\Finance Tracker\\Backups' }
    )
  })

  test('backups go to the documents folder, which an uninstall leaves', () => {
    assert.equal(storeBackupsDir('C:\\Users\\you\\Documents\\Finance Tracker'), 'C:\\Users\\you\\Documents\\Finance Tracker\\Backups')
  })
})
