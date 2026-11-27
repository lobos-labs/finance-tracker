import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DESKTOP_SENT, WHATS_SENT } from '../src/shared/whatsSent.ts'
import { AI_ROUTES } from '../src/shared/types.ts'

// Settings → AI → What's sent: every route, each with the fields it sends.

describe("what's sent", () => {
  test("covers every route, each with fields; the key check is the desktop's alone", () => {
    assert.deepEqual(
      WHATS_SENT.map((f) => f.route),
      [...AI_ROUTES]
    )
    assert.deepEqual(
      DESKTOP_SENT.map((f) => f.route),
      ['keyCheck']
    )
    for (const f of [...WHATS_SENT, ...DESKTOP_SENT]) assert.ok(f.fields.length > 0, f.route)
  })
})
