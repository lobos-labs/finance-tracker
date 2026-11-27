import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceRunSuffix } from '../src/main/build.ts'

// A run from source of the open edition keeps its own data folder and its own documents folder, so it never opens,
// upgrades or deletes the books of an installed copy.

const here = dirname(fileURLToPath(import.meta.url))
const source = (file: string): string => readFileSync(join(here, '..', 'src', 'main', file), 'utf8')

describe('a run from source', () => {
  test("has its own folders in the open edition, and an installed app or another edition's build has the usual ones", () => {
    assert.equal(sourceRunSuffix(false, true), ' Dev')
    assert.equal(sourceRunSuffix(true, true), '')
    assert.equal(sourceRunSuffix(false, false), '')
    assert.equal(sourceRunSuffix(true, false), '')
  })

  test('the data folder and a new documents folder both carry it, and a folder named in the environment still wins', () => {
    const index = source('index.ts')
    assert.match(index, /if \(process\.env\['FINANCE_TRACKER_DATA_DIR'\]\) app\.setPath\('userData', process\.env\['FINANCE_TRACKER_DATA_DIR'\]\)\s+else app\.setPath\('userData', join\(app\.getPath\('appData'\), `\$\{DATA_DIR_NAME\}\$\{sourceRunSuffix\(app\.isPackaged\)\}`\)\)/)
    assert.match(source('ipc-setup.ts'), /join\(app\.getPath\('documents'\), `\$\{APP_NAME\}\$\{sourceRunSuffix\(app\.isPackaged\)\}`\)/)
  })
})
