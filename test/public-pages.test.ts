import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_SENT, WHATS_SENT } from '../src/shared/whatsSent.ts'

// The public repository's README.md and PRIVACY.md repeat Settings → AI → What's sent: every field of
// src/shared/whatsSent.ts, word for word, the key check included (the open edition runs on the user's own key).
// In the public tree the two pages are at its root; where this app sits in the repository that tree is written
// from, they are that export's (tools/public-export/overlay).

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overlay = join(root, '..', 'tools', 'public-export', 'overlay')
const folder = existsSync(join(overlay, 'PRIVACY.md')) ? overlay : root

const flat = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase()

describe("the public pages and what's sent", () => {
  for (const page of ['README.md', 'PRIVACY.md']) {
    test(`${page} repeats every field of every feature, and no line only a development build sends`, () => {
      const text = flat(readFileSync(join(folder, page), 'utf8'))
      for (const feature of [...WHATS_SENT, ...DESKTOP_SENT]) {
        assert.ok(text.includes(flat(`**${feature.label}**`)), `${page} has no entry for ${feature.label}`)
        for (const field of feature.fields) assert.ok(text.includes(flat(field)), `${page}, ${feature.label}: "${field}"`)
        for (const field of feature.claudeCode ?? []) assert.ok(!text.includes(flat(field)), `${page}, ${feature.label}: "${field}"`)
      }
    })
  }
})
