// The theme's contrast, measured from the tokens at the top of src/renderer/src/styles.css:
// each text color against the surfaces it sits on (WCAG 4.5:1), and the marks, icons, field
// edges and focus ring against theirs (3:1), in the dark theme and the light one. A see-through
// token is laid over what it sits on first (a card over the page, a wash over a card).
//
//   node --import ./test/ts-esm.mjs scripts/contrast.ts      prints the pairs
//
// test/theme-contrast.test.ts holds every pair to its floor.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Rgba = [number, number, number, number]
export type Theme = 'dark' | 'light'

export interface Pair {
  theme: Theme
  fg: string
  bg: string
  ratio: number
  /** 4.5 for text and figures, 3 for large text, marks and controls */
  floor: number
}

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/styles.css')

/** The custom properties of one `:root { … }` block. */
function props(block: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

/** The block after `start`, to its closing brace (no braces nest inside a :root). */
function blockAfter(css: string, start: number): string {
  const open = css.indexOf('{', start)
  return css.slice(open + 1, css.indexOf('}', open))
}

/** Dark is the first :root; light is it with the prefers-color-scheme: light block's :root on top. */
export function tokens(css: string): Record<Theme, Map<string, string>> {
  const dark = props(blockAfter(css, css.indexOf(':root {')))
  const media = css.indexOf('@media (prefers-color-scheme: light)')
  if (media < 0) throw new Error('styles.css has no light block')
  const light = new Map([...dark, ...props(blockAfter(css, css.indexOf(':root {', media)))])
  return { dark, light }
}

function parse(value: string, vars: Map<string, string>, depth = 0): Rgba {
  if (depth > 10) throw new Error(`too deep: ${value}`)
  const v = value.trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) {
    const next = vars.get(ref[1])
    if (!next) throw new Error(`no ${ref[1]}`)
    return parse(next, vars, depth + 1)
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v)
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(',').map(Number)
    return [r, g, b, a]
  }
  // color-mix(in srgb, A n%, B): B is transparent (A at n% alpha) or a second color.
  const mix = /^color-mix\(in srgb, (.+) (\d+(?:\.\d+)?)%, (.+)\)$/.exec(v)
  if (mix) {
    const a = parse(mix[1], vars, depth + 1)
    const share = Number(mix[2]) / 100
    if (mix[3] === 'transparent') return [a[0], a[1], a[2], a[3] * share]
    const b = parse(mix[3], vars, depth + 1)
    return [0, 1, 2].map((i) => a[i] * share + b[i] * (1 - share)).concat(1) as Rgba
  }
  throw new Error(`can't read the color ${v}`)
}

/** fg laid over an opaque bg. */
const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba

const lum = ([r, g, b]: Rgba): number => {
  const lin = (c: number): number => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
export const ratio = (a: Rgba, b: Rgba): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** Text tokens, the surfaces each sits on; then the marks and controls at 3:1. */
const TEXT: Array<[string, string[]]> = [
  ['--ink-50', ['page', 'card', 'raised', 'button', 'field', 'pop', 'page hover']],
  ['--ink-100', ['page', 'card', 'raised', 'button', 'field', 'pop']],
  ['--ink-200', ['page', 'card', 'raised', 'button', 'pop', 'page well']],
  ['--ink-300', ['page', 'card', 'raised', 'button', 'pop', 'page wash', 'page hover']],
  ['--ink-400', ['page', 'card', 'raised', 'button', 'field', 'pop', 'well', 'page well', 'page wash', 'page hover']],
  ['--copper', ['page', 'card', 'raised', 'button', 'copper wash', 'page wash']],
  ['--copper-300', ['card', 'copper 12%']],
  ['--teal-400', ['page', 'card', 'button', 'teal wash']],
  ['--pos', ['page', 'card', 'raised', 'button', 'pop']],
  ['--neg', ['page', 'card', 'raised', 'button', 'pop']],
  ['--on-copper', ['--copper', '--copper-300']]
]
const MARKS: Array<[string, string[]]> = [
  // Home's sparkline bars are --ink-500 on the page; on the open and hovered rows they're --ink-400, as text is there.
  ['--ink-500', ['page', 'card']],
  ['--ink-400', ['page wash', 'page hover']],
  ['--field-line', ['card', 'field', 'raised']],
  ['--focus', ['page', 'card']],
  ['--copper', ['page', 'card']],
  ['--warn', ['page', 'card']],
  ['--chart-copper', ['page', 'card']],
  ['--chart-teal', ['page', 'card']],
  ['--chart-slate', ['page', 'card']],
  ['--chart-plum', ['page', 'card']],
  ['--chart-blue', ['page', 'card']],
  // Kept's bar in Home's Walk and its node in the Sankey.
  ['--chart-muted', ['page', 'card']]
]

export function measure(css = readFileSync(STYLES, 'utf8')): Pair[] {
  const out: Pair[] = []
  for (const [theme, vars] of Object.entries(tokens(css)) as Array<[Theme, Map<string, string>]>) {
    const color = (name: string): Rgba => parse(`var(${name})`, vars)
    const page = color('--ink-950')
    // The card is a gradient over the page: both ends count.
    const cards = [over(color('--card-1'), page), over(color('--card-2'), page)]
    const surfaces: Record<string, Rgba[]> = {
      page: [page],
      card: cards,
      raised: [color('--ink-900')],
      button: [color('--ink-800')],
      field: [over(color('--field'), cards[0])],
      pop: [color('--pop'), color('--toast')],
      well: cards.map((c) => over(color('--well'), c)),
      'copper wash': cards.map((c) => over(color('--copper-wash'), c)),
      'copper 12%': cards.map((c) => over(parse('color-mix(in srgb, var(--copper) 12%, transparent)', vars), c)),
      'teal wash': cards.map((c) => over(parse('color-mix(in srgb, var(--teal) 6%, transparent)', vars), c)),
      // Home's rows sit on the page, not a card: the open row's wash, a hovered row, and the rows under an open one.
      'page wash': [over(color('--copper-wash'), page)],
      'page hover': [over(color('--row-hover'), page)],
      'page well': [over(color('--well'), page)]
    }
    const bgOf = (name: string): Rgba[] => surfaces[name] ?? [color(name)]
    for (const [list, floor] of [
      [TEXT, 4.5],
      [MARKS, 3]
    ] as const) {
      for (const [fg, bgs] of list) {
        for (const bg of bgs) {
          const r = Math.min(...bgOf(bg).map((b) => ratio(over(color(fg), b), b)))
          out.push({ theme, fg, bg, ratio: r, floor })
        }
      }
    }
  }
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pairs = measure()
  for (const theme of ['dark', 'light'] as const) {
    console.log(`\n${theme}`)
    for (const p of pairs.filter((x) => x.theme === theme)) console.log(`  ${p.ratio >= p.floor ? 'ok  ' : 'LOW '} ${p.fg.padEnd(15)} on ${p.bg.padEnd(12)} ${p.ratio.toFixed(2).padStart(6)}  (${p.floor})`)
  }
  const low = pairs.filter((p) => p.ratio < p.floor)
  console.log(low.length ? `\n${low.length} under the floor` : '\nevery pair clears its floor')
  process.exitCode = low.length ? 1 : 0
}
