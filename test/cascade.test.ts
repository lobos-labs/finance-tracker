import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { computed, parse, px, specificity, type El, type Env } from './cascade.ts'

// The small cascade the stylesheet's tests ask (test/cascade.ts): what it answers for a rule set here is what Chromium
// draws, so a test that asks it what an element looks like can't pass on an engine that ranks or reads rules wrongly.

const at = (css: string, chain: El[], env: Env = { width: 1000 }): Record<string, string> => computed(parse(css), chain, env)
const button = (states: string[] = []): El[] => [{ tag: 'html' }, { tag: 'div', classes: ['card'], width: 400 }, { tag: 'button', classes: ['risk', 'on'], states }]

describe("the tests' cascade", () => {
  test('ranks as the browser does: importance, then ids, classes and pseudo-classes, types, then order', () => {
    assert.equal(specificity('.risk:hover'), specificity('.risk.on'))
    assert.equal(specificity('[role="radio"]'), specificity('.on'))
    assert.ok(specificity('.on') > specificity('div button'))
    assert.ok(specificity('#a') > specificity('.a.b.c'))
    assert.equal(specificity(':where(.a, #b) .c'), specificity('.c'))
    assert.equal(specificity(':is(.a, #b)'), specificity('#b'))
    assert.equal(specificity(':not(.a.b)'), specificity('.a.b'))
    // A state wins over an earlier class, a later rule of the same rank over an earlier, !important over both.
    assert.equal(at('.risk:hover { color: red } .risk { color: blue }', button([':hover'])).color, 'red')
    assert.equal(at('.risk.on { color: red } .on.risk { color: blue }', button()).color, 'blue')
    assert.equal(at('.card .risk { color: red } .risk:hover { color: blue }', button([':hover'])).color, 'blue')
    assert.equal(at('.risk { color: red !important } .card .risk.on:hover { color: blue }', button([':hover'])).color, 'red')
    // Focus from the keyboard is focus, and within its ancestors.
    assert.equal(at('.risk:focus { color: red }', button([':focus-visible'])).color, 'red')
    assert.equal(at('.card:focus-within .risk { color: red }', button([':focus-visible'])).color, 'red')
    assert.equal(at('.risk:hover { color: red }', button()).color, undefined)
  })

  test('reads widths, sides and lengths in whatever form they are written', () => {
    for (const rule of ['outline: calc(1px + 1px) solid red', 'outline: 0.125rem solid red', 'outline: red solid 2px', 'outline-width: 2px; outline-style: solid; outline-color: red'])
      assert.deepEqual([px(at(`.risk { ${rule} }`, button())['outline-width']), at(`.risk { ${rule} }`, button())['outline-color']], [2, 'red'], rule)
    assert.equal(at('.risk { border-block-start: 2px solid red }', button())['border-top-color'], 'red')
    assert.equal(at('.risk { border-inline-start-color: red }', button())['border-left-color'], 'red')
    assert.deepEqual(['top', 'right', 'bottom', 'left'].map((p) => at('.risk { padding-block: 10px; padding-inline: 12px 14px }', button())[`padding-${p}`]), ['10px', '14px', '10px', '12px'])
    assert.equal(px('calc(-2px - 2px)'), -4)
    assert.equal(px('-0.25rem'), -4)
  })

  test('answers media, container and supports queries as Chromium would, and throws on one it can’t', () => {
    const css = '@media (max-width: 700px) { .risk { color: red } } @container (width < 500px) { .risk { color: blue } } @media (forced-colors) { .risk { color: Highlight } }'
    assert.equal(at(css, button(), { width: 600 }).color, 'red')
    assert.equal(at(css, button(), { width: 900 }).color, undefined)
    assert.equal(at(`.card { container-type: inline-size } ${css}`, button(), { width: 900 }).color, 'blue')
    assert.equal(at(css, button(), { width: 900, forcedColors: true }).color, 'Highlight')
    assert.equal(at('@supports (container-type: inline-size) { .risk { color: red } }', button()).color, 'red')
    assert.throws(() => at('@supports not (display: frobnicate) { .risk { color: red } }', button()), /cascade:/)
    assert.throws(() => at('@supports NOT (display: frobnicate) { .risk { color: red } }', button()), /cascade:/)
    // A media query's keywords in any case.
    for (const [query, holds] of [
      ['NOT all AND (max-width: 700px)', [false, true]],
      ['Only Screen And (max-width: 700px)', [true, false]],
      ['PRINT', [false, false]]
    ] as const)
      assert.deepEqual([600, 900].map((width) => at(`@media ${query} { .risk { color: red } }`, button(), { width }).color === 'red'), holds, query)
    assert.throws(() => at('@media (hover: hover) { .risk { color: red } }', button()), /cascade:/)
  })

  test("answers a container's condition negated, and'ed or or'ed, named or not, and throws on one it can't", () => {
    const within = (width: number): El[] => [{ tag: 'html' }, { tag: 'div', classes: ['card'], width }, { tag: 'button', classes: ['risk'] }]
    const red = (query: string, width: number): boolean => at(`.card { container: spend / inline-size } @container ${query} { .risk { color: red } }`, within(width)).color === 'red'
    // Not, and and or, in any case, are never a container's name, so each starts a condition, after a name or with none.
    for (const query of ['not (min-width: 500px)', 'spend not (min-width: 500px)', 'not (width >= 500px)', '(max-width: 499px)', 'spend (width < 31.25rem)', 'NOT (min-width: 500px)', 'spend Not (min-width: 500px)'])
      assert.deepEqual([red(query, 400), red(query, 499), red(query, 500)], [true, true, false], query)
    for (const [query, holds] of [
      ['(min-width: 300px) and (max-width: 499px)', [false, true, false]],
      ['(min-width: 300px) AND (max-width: 499px)', [false, true, false]],
      ['spend (max-width: 299px) or (min-width: 500px)', [true, false, true]],
      ['spend (max-width: 299px) OR (min-width: 500px)', [true, false, true]],
      ['NOT ((min-width: 300px) And (max-width: 499px))', [true, false, true]],
      ['not ((min-width: 300px) and (max-width: 499px))', [true, false, true]],
      ['((max-width: 299px) or (min-width: 500px)) and (min-width: 200px)', [true, false, true]],
      ['(not (min-width: 300px)) or (min-width: 500px)', [true, false, true]],
      ['notes (max-width: 499px)', [false, false, false]],
      ['other (max-width: 499px)', [false, false, false]]
    ] as const)
      assert.deepEqual([200, 400, 600].map((w) => red(query, w)), holds, query)
    // A condition on something but a width, an and beside an or with no brackets, or a not of more than one.
    // None is no name either, so a condition can't start with it.
    for (const query of ['(orientation: portrait)', 'not (aspect-ratio > 1)', '(min-width: 300px) and (max-width: 499px) or (min-width: 600px)', 'not (min-width: 300px) and (max-width: 499px)', 'style(--wide: 1)', 'none (max-width: 499px)', 'NONE (max-width: 499px)', 'AND (max-width: 499px)'])
      assert.throws(() => red(query, 400), /cascade: container query/, query)
  })
})
