// npm run test:electron: the encrypted run of the suite (npm run test:encrypted)
// on Electron's own Node, where the app loads the SQLite driver. The binary is
// the development one (node_modules/electron), or FINANCE_TRACKER_TEST_ELECTRON
// when that one can't run here (Windows Smart App Control blocks an unsigned
// electron.exe; a copy electron-builder made, dist/win-unpacked, isn't blocked,
// but a packaged app's fuses turn Node mode off, so it has to be an unfused one).
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.join(__dirname, '..')
const exe = process.env['FINANCE_TRACKER_TEST_ELECTRON'] || require('electron')
const r = spawnSync(exe, ['--import', './test/ts-esm.mjs', '--import', './test/encrypted.mjs', '--test', 'test/*.test.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
if (r.error) {
  console.error(`test:electron: ${exe} didn't start: ${r.error.message}`)
  process.exit(1)
}
process.exit(r.status ?? 1)
