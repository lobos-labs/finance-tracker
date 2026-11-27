import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorTag } from '../src/main/log.ts'

// The log holds nothing from the books. An error's message can name what a call was about (an account, an asset, a
// payee) or carry the model's own words, so a failed call is logged by its channel and the error's kind, and the
// message goes to the window alone.

const here = dirname(fileURLToPath(import.meta.url))
const source = (file: string): string => readFileSync(join(here, '..', 'src', 'main', file), 'utf8')

describe('what a failed call leaves in the log', () => {
  test('its kind, its code or its class, when that is a short identifier, and never its message', () => {
    assert.equal(errorTag(Object.assign(new Error("Couldn't find a value for Lake house: its listing was withdrawn last week"), { kind: 'refused' })), ' (refused)')
    assert.equal(errorTag(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })), ' (SQLITE_BUSY)')
    assert.equal(errorTag(new TypeError("Cannot read properties of undefined (reading 'Joint Checking')")), ' (TypeError)')
    // A plain Error says nothing more, and a code that is not an identifier is not trusted to be one.
    assert.equal(errorTag(new Error('No account named Joint Checking')), '')
    assert.equal(errorTag(Object.assign(new Error('x'), { code: 'Joint Checking at Harbor Bank' })), '')
    assert.equal(errorTag(Object.assign(new Error('x'), { kind: 'a'.repeat(41) })), '')
    for (const odd of ['Joint Checking', null, undefined, 42, { message: 'Lake house' }]) assert.equal(errorTag(odd), '')
  })

  test('a failed window call is logged by its channel and kind; its message goes to the window alone', () => {
    const ipc = source('ipc.ts')
    assert.match(ipc, /console\.error\(`\[ipc\] \$\{channel\} failed\$\{errorTag\(err\)\}`\)\s+return \{ ok: false, error: message\(err\) \}/)
    assert.doesNotMatch(ipc, /\[ipc\][^\n]*message\(err\)/)
  })

  test('a value lookup that fails is logged as a fixed line: its message names the asset and quotes the model', () => {
    for (const file of ['valuation.ts', 'ipc.ts']) {
      const text = source(file)
      assert.match(text, /console\.error\(`\[valuation\] a lookup failed\$\{errorTag\(err\)\}`\)/, file)
      assert.doesNotMatch(text, /\[valuation\]'?,[^\n]*(?:message|String)\(err/, file)
    }
    // The message it throws is the one the window shows.
    assert.match(source('valuation.ts'), /throw new Error\(`Couldn't find a value for \$\{a\.name\}/)
  })
})
