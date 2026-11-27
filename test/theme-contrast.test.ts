import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { measure, tokens } from '../scripts/contrast.ts'

// Both themes' token pairs at their WCAG floors: text and figures 4.5:1, marks, icons,
// field edges and the focus ring 3:1 (scripts/contrast.ts prints them).

const css = readFileSync(fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)), 'utf8')

describe('theme contrast', () => {
  const pairs = measure(css)

  test('measures both themes', () => {
    assert.ok(pairs.filter((p) => p.theme === 'dark').length > 50)
    assert.equal(pairs.filter((p) => p.theme === 'light').length, pairs.filter((p) => p.theme === 'dark').length)
  })

  test('every pair clears its floor', () => {
    const low = pairs.filter((p) => p.ratio < p.floor).map((p) => `${p.theme} ${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)} < ${p.floor}`)
    assert.deepEqual(low, [])
  })

  test('the light theme sets its own value for every color the dark one does', () => {
    const { dark } = tokens(css)
    const open = css.indexOf('{', css.indexOf(':root {', css.indexOf('@media (prefers-color-scheme: light)')))
    const own = new Set([...css.slice(open, css.indexOf('}', open)).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
    // Fonts, sizes and the tokens built from others (copper-wash, well, card-bg…) follow by themselves.
    const colors = [...dark].filter(([, v]) => /^(#|rgba?\()/.test(v) || /^var\(--ink-\d+\)$/.test(v)).map(([k]) => k)
    assert.deepEqual(
      colors.filter((k) => !own.has(k)),
      []
    )
  })
})
