// For test/update-notice-*.test.ts: starts the app's real update checks (src/main/updater.ts) and its real
// background (src/main/background.ts) as index.ts does, on a mocked clock, over the stand-ins hooks.mjs puts
// in Electron's place. One start for the process: the modules keep what they found, as the app does, so each
// test file is one run of the app told in order.
import { mock } from 'node:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './hooks.mjs'
import { H } from './state.mjs'

export { H }

export const FEED = 'https://github.com/example-org/finance-app/releases/latest/download'
export const PAGE = 'https://github.com/example-org/finance-app/releases/latest'
export const MINUTE = 60_000
export const HOUR = 3600_000
/** When the app starts, on the mocked clock. */
export const START = Date.UTC(2026, 0, 5, 12, 0, 0)

/** Lets what a timer started finish: the promises, and the stand-ins' answers, which come a moment after. */
export async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((done) => setImmediate(done))
}

/** Moves the clock on by `ms`, a minute at a time at most, settling after each step. */
export async function advance(ms) {
  for (let left = ms; left > 0; ) {
    const step = Math.min(left, MINUTE)
    mock.timers.tick(step)
    await settle()
    left -= step
  }
}

/** Moves the clock on to `offset` milliseconds after the start. */
export const until = (offset) => advance(START + offset - Date.now())

/** What the feed answers: a newer version, nothing newer, or no answer at all. */
export const available = (version) => () => ({ isUpdateAvailable: true, updateInfo: { version } })
export const nothingNewer = () => ({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
export const offline = () => {
  throw new Error('net::ERR_INTERNET_DISCONNECTED')
}

/**
 * Starts the app on `platform` with the feed built in: { updater, background } are the real modules, logLines()
 * reads the app's log, and dir is the log's folder, for the test to remove. console.error goes to the log only.
 */
export async function boot(platform) {
  const dir = mkdtempSync(join(tmpdir(), 'update-notice-'))
  Object.defineProperty(process, 'platform', { value: platform })
  globalThis.__UPDATE_URL__ = FEED
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START })
  mock.method(console, 'error', () => {})
  const { openLog } = await import('../../src/main/log.ts')
  openLog(dir)
  const updater = await import('../../src/main/updater.ts')
  const background = await import('../../src/main/background.ts')
  // index.ts's order.
  updater.startUpdates()
  background.startBackground({ window: () => null, sync: async () => {}, busy: () => false, close: () => {} })
  const file = join(dir, 'app.log')
  const logLines = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
  return { updater, background, logLines, dir }
}
