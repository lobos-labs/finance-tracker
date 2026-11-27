import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BETA_UNTIL, DATA_DIR_NAME, HOME_DIR_NAME } from '../src/main/build.ts'
import { legacyDocsDir } from '../src/main/paths.ts'
import { bridgeDir } from '../src/main/bridge.ts'

// The build-time switches (electron.vite.config.ts) don't exist outside a
// build: the source then behaves as a normal build, with the default folders.

describe('build switches', () => {
  test('unset: no beta, the default data folder and the default hidden folder', () => {
    assert.equal(BETA_UNTIL, '')
    assert.equal(DATA_DIR_NAME, 'Finance Tracker')
    assert.equal(HOME_DIR_NAME, '.finance-tracker')
    assert.equal(legacyDocsDir(), join(homedir(), '.finance-tracker', 'documents'))
    const saved = process.env['FINANCE_TRACKER_BRIDGE_DIR']
    delete process.env['FINANCE_TRACKER_BRIDGE_DIR']
    try {
      assert.equal(bridgeDir(), join(homedir(), '.finance-tracker', 'bridge'))
    } finally {
      if (saved !== undefined) process.env['FINANCE_TRACKER_BRIDGE_DIR'] = saved
    }
  })
})
