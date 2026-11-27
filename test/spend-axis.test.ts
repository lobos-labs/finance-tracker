import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Spendable, SpendDay } from '../src/shared/types.ts'
import { axisLabels, cushionLabel, dateAt, DAY_PX, LABEL_GAP, NARROW_BAND, OUT_PX, textWidth, type AxisDay, type AxisLabel, type Bar } from '../src/renderer/src/pages/spendAxis.ts'
import { computed, parse, type El } from './cascade.ts'

// Spendable's chart axis (pages/spendAxis.ts): under each day's column its day and what it spends. At a phone's width
// a column is 12 to 18 px, and side by side two days' figures ran together ("−106" and "−80" read as "−10680") and the
// last one's K was cut at the chart's edge. The amounts here are made up.

/** A label's width as each font draws it: the plain one 0.6 em a character; with numbers hidden (Hidden Digits' own
 * substitutions) a number's first digit 1.2 em and the rest of it, its commas and periods too, nothing, and a comma or
 * period outside a number 0.28 em. */
const FONTS = {
  plain: (text: string, px: number): number => text.length * 0.6 * px,
  hidden: (text: string, px: number): number =>
    text.split(/(\d(?:[\d,.]*\d)?)/).reduce((w, part, i) => w + (i % 2 ? 1.2 : [...part].reduce((x, ch) => x + (ch === ',' || ch === '.' ? 0.28 : 0.6), 0)), 0) * px
}
type Font = keyof typeof FONTS

/** A label's left and right as a font draws it. */
function drawnAt(l: AxisLabel, px: number, font: Font): [number, number] {
  const w = FONTS[font](l.text, px)
  const left = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2
  return [left, left + w]
}

const GUTTER = 46
const name = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** n days from the first, each spending what outs gives it (by index), or nothing. */
function sample(first: string, n: number, outs: Record<number, string>): AxisDay[] {
  return Array.from({ length: n }, (_, i) => {
    const day = addDays(first, i)
    return { day, name: name(day), out: outs[i] ?? null }
  })
}

/** A figure as the chart writes it with numbers hidden: whole, with no K or M to give its size away (lib.ts). */
const unshort = (out: string): string => {
  const m = /^(−\$?)([\d.]+)([KM]?)$/.exec(out)!
  return m[1] + Math.round(Number(m[2]) * (m[3] === 'K' ? 1e3 : m[3] === 'M' ? 1e6 : 1)).toLocaleString('en-US')
}
const hide = (days: AxisDay[]): AxisDay[] => days.map((d) => ({ ...d, out: d.out && unshort(d.out) }))

/** A seeded run of numbers from 0 up to 1 (mulberry32), exact in 32-bit integers, so its windows don't repeat: one
 * multiplied in doubles past 2^53 falls into a short cycle. */
function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A row as the chart draws it: the labels' texts in order, '.' where a day has none, and how each is anchored. */
const drawn = (row: Array<AxisLabel | null>): string => row.map((l) => (l ? l.text + (l.anchor === 'middle' ? '' : `(${l.anchor})`) : '.')).join(' ')

/** The drawing before spendAxis: every day's number, or every other one's under 26 px; a name on the first
 * day and on a 1st; every figure; each centred under its column. */
function before(days: AxisDay[], width: number): { day: Array<AxisLabel | null>; out: Array<AxisLabel | null> } {
  const band = Math.max(0, width - GUTTER) / days.length
  const stride = band < 26 ? 2 : 1
  const cx = (i: number): number => GUTTER + band * i + band / 2
  const day = days.map((d, i) => {
    const text = i === 0 || d.day.endsWith('-01') ? d.name : i % stride ? '' : String(Number(d.day.slice(8)))
    return text ? { text, x: cx(i), anchor: 'middle' as const } : null
  })
  return { day, out: days.map((d, i) => (d.out ? { text: d.out, x: cx(i), anchor: 'middle' as const } : null)) }
}

// Five days that spend, two of them side by side, as the demo's two weeks have.
const twoWeeks = sample('2030-03-14', 17, { 1: '−214', 2: '−65', 6: '−187', 9: '−341', 16: '−4K' })

/** Where a day's label reads as a font draws it: a number's middle, a name's date's. */
function dateOf(l: AxisLabel, font: Font): number {
  const [a, b] = drawnAt(l, DAY_PX, font)
  const date = /\d+$/.exec(l.text)!
  return date.index ? a + FONTS[font](l.text.slice(0, date.index), DAY_PX) + FONTS[font](date[0], DAY_PX) / 2 : (a + b) / 2
}

// The rules, written here apart from the axis's own: TOUCH and NEAR for the drawing before, GAP for the narrower one.
/** Two labels in a row as drawn before read apart from 1 px; touching, they run together. */
const TOUCH = 1
/** A figure reads as its own day's nearer its own reference than any other day's date by more than 2 px. */
const NEAR = 2
/** Laid out narrower, two labels in a row keep 3 px apart. */
const GAP = 3

/** Rule A, whether the drawing before spendAxis reads cleanly as a font draws it: no two labels in the day row, and
 * none in the figure row, within TOUCH of each other; none past the chart's edges; and every figure nearer its own
 * reference than any other day's drawn date by more than NEAR, from its middle, its reference its own date's digits
 * where its day is labelled and its column's centre where not. The same at every width. */
function readsAsBefore(days: AxisDay[], width: number, font: Font): boolean {
  const old = before(days, width)
  const band = Math.max(0, width - GUTTER) / days.length
  for (const [labels, px] of [
    [old.day, DAY_PX],
    [old.out, OUT_PX]
  ] as const) {
    const spans = labels.filter((l) => l !== null).map((l) => drawnAt(l, px, font))
    if (!spans.every(([a, b], i) => a >= -1e-9 && b <= width + 1e-9 && spans.every(([c, d], j) => j <= i || b + TOUCH <= c + 1e-9 || d + TOUCH <= a + 1e-9))) return false
  }
  const dates = old.day.map((l) => (l ? dateOf(l, font) : null))
  return old.out.every((f, i) => {
    if (!f) return true
    const [a, b] = drawnAt(f, OUT_PX, font)
    const mid = (a + b) / 2
    const own = Math.abs(mid - (dates[i] ?? GUTTER + band * i + band / 2))
    return dates.every((c, j) => c === null || j === i || Math.abs(mid - c) - own > NEAR + 1e-9)
  })
}

/** Every rule the axis keeps, checked on one result laid out for the plain font or with numbers hidden, and which way
 * it was laid out. Rule A: where the drawing before reads cleanly, that drawing label for label. Rule B, else: every
 * label inside the chart, GAP clear of the others in its row, a number centred under its column or ended at the
 * chart's edge where centred it would pass it, a name's date over its own column; a figure only under a day whose
 * number or name is drawn, placed as a number is and nearer that day's date than any other's by more than NEAR; and
 * every labelled day that spends showing its figure. Either way a month's 1st keeps its name wherever its column is
 * half as wide as its date. */
function holds(days: AxisDay[], width: number, why: string, hidden = false): 'clean' | 'narrow' {
  const { day, out } = axisLabels(days, { width, gutter: GUTTER, hidden })
  const font: Font = hidden ? 'hidden' : 'plain'
  const at = `${why}, ${font}`
  const band = (width - GUTTER) / days.length
  for (let i = 1; i < days.length; i++) if (days[i].day.endsWith('-01') && band >= FONTS[font]('1', DAY_PX) / 2) assert.equal(day[i]?.text, days[i].name, `${at}: ${days[i].name} lost its name`)
  if (readsAsBefore(days, width, font)) {
    assert.deepEqual({ day, out }, before(days, width), `${at}: not drawn as before`)
    return 'clean'
  }
  const [left, right] = [(i: number): number => GUTTER + band * i, (i: number): number => GUTTER + band * (i + 1)]
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9
  for (const [labels, px] of [
    [day, DAY_PX],
    [out, OUT_PX]
  ] as const) {
    const spans = labels.map((l, i) => (l ? { i, at: drawnAt(l, px, font) } : null)).filter((s) => s !== null)
    for (const s of spans) {
      const l = labels[s.i]!
      // Inside the chart; a number or a figure centred under its own column, or ended at the chart's edge where
      // centred it would pass it. A name is placed by where its date reads, below.
      assert.ok(s.at[0] >= -1e-9 && s.at[1] <= width + 1e-9, `${at}: ${l.text} at ${s.at} in ${width}`)
      if (labels === day && /\D/.test(l.text)) continue
      const cx = left(s.i) + band / 2
      const w = s.at[1] - s.at[0]
      const placed = l.anchor === 'middle' ? near(l.x, cx) : l.anchor === 'end' ? near(l.x, width) && cx + w / 2 > width : near(l.x, 0) && cx - w / 2 < 0
      assert.ok(placed, `${at}: ${l.text} (${l.anchor} at ${l.x}) neither centred under its column ${cx} nor at the chart's edge`)
    }
    for (let a = 0; a < spans.length; a++)
      for (let b = a + 1; b < spans.length; b++) {
        const [x, y] = [spans[a].at, spans[b].at]
        assert.ok(x[1] + GAP <= y[0] + 1e-9 || y[1] + GAP <= x[0] + 1e-9, `${at}: ${labels[spans[a].i]!.text} and ${labels[spans[b].i]!.text} closer than ${GAP} px`)
      }
  }
  // Where each label's date reads, as the font draws it: a name's date over its own column, however narrow.
  const dates = day.map((l, i) => {
    if (!l) return null
    const c = dateOf(l, font)
    if (/\D/.test(l.text)) assert.ok(c >= left(i) - 1e-9 && c <= right(i) + 1e-9, `${at}: ${l.text}'s date at ${c}, its column ${left(i)}-${right(i)}`)
    return c
  })
  for (let i = 0; i < days.length; i++) {
    // A figure only for a day that spends, as it spends, only under its own drawn label, and under every one that spends.
    if (out[i]) assert.equal(out[i]!.text, days[i].out, at)
    if (!days[i].out) assert.equal(out[i], null, at)
    if (out[i]) assert.ok(day[i], `${at}: ${days[i].out} drawn on ${days[i].day}, which has no label`)
    if (days[i].out && day[i]) assert.ok(out[i], `${at}: ${day[i]!.text} drawn without its ${days[i].out}`)
    if (!out[i]) continue
    // Nearer its own date than any other drawn, by more than NEAR.
    const [a, b] = drawnAt(out[i]!, OUT_PX, font)
    const mid = (a + b) / 2
    const own = Math.abs(mid - dates[i]!)
    dates.forEach((c, j) => j !== i && c !== null && assert.ok(Math.abs(mid - c) - own > NEAR, `${at}: ${days[i].out} ${Math.abs(mid - c)} from ${day[j]!.text}, ${own} from its own ${day[i]!.text}`))
  }
  return 'narrow'
}

describe("Spendable's chart axis", () => {
  test('a desktop column draws every day and every figure centred under it, as it always did', () => {
    // 612 px is the chart in a 900 px window, 924 px in a 1280 px one.
    for (const width of [612, 924]) {
      const { day, out } = axisLabels(twoWeeks, { width, gutter: GUTTER })
      const band = (width - GUTTER) / twoWeeks.length
      assert.ok(band >= NARROW_BAND)
      twoWeeks.forEach((d, i) => {
        const cx = GUTTER + band * i + band / 2
        assert.deepEqual(day[i], { text: i === 0 ? 'Mar 14' : String(Number(d.day.slice(8))), x: cx, anchor: 'middle' })
        assert.deepEqual(out[i], d.out ? { text: d.out, x: cx, anchor: 'middle' } : null)
      })
    }
    // Three weeks in a 900 px window, a one-digit day and figure, a 1st, a first day of one digit: as before, the
    // first day's name 1.75 px from the next number where it has two digits.
    for (const days of [sample('2030-11-10', 21, { 5: '−7', 6: '−1.5K' }), sample('2030-11-20', 21, { 11: '−1.5K', 13: '−65' }), sample('2030-11-05', 21, { 3: '−48' })]) {
      assert.deepEqual(axisLabels(days, { width: 612, gutter: GUTTER }), before(days, 612), days[0].day)
      for (const hidden of [false, true]) assert.equal(holds(hidden ? hide(days) : days, 612, days[0].day, hidden), 'clean')
    }
    // A name and the next number under 1 px apart, as in a column 26.1 px wide: laid out narrower, the name ended at
    // its column's edge; from 1 px apart, at 26.2, as before.
    const touching = sample('2030-11-10', 21, { 6: '−1.5K' })
    for (const [band, how] of [
      [26.1, 'narrow'],
      [26.2, 'clean']
    ] as const) {
      const width = GUTTER + 21 * band
      const old = before(touching, width)
      assert.ok(Math.abs(drawnAt(old.day[1]!, DAY_PX, 'plain')[0] - drawnAt(old.day[0]!, DAY_PX, 'plain')[1] - (band - 25.2)) < 1e-9)
      assert.equal(holds(touching, width, `Nov 10 ×21 at ${band}`), how)
      if (how === 'narrow') assert.deepEqual(axisLabels(touching, { width, gutter: GUTTER }).day[0], { text: 'Nov 10', x: GUTTER + band, anchor: 'end' })
    }
    // Two figures side by side under 3 px apart, neither within 1 px of the other: each reads as its own, so as before.
    // Sixteen days in a 900 px window, −5.4K and −11.6K 2.4 px apart; 23 in a 1280 px one, −$739 and −$13.7K 2.2 px apart.
    for (const [days, width] of [
      [sample('2030-12-03', 16, { 8: '−5.4K', 9: '−11.6K', 15: '−103' }), 612],
      [sample('2030-04-06', 23, { 4: '−$48', 11: '−$739', 12: '−$13.7K', 22: '−$310' }), 924]
    ] as const) {
      const old = before(days, width)
      const [, b] = drawnAt(old.out.find((l) => l?.text === '−5.4K' || l?.text === '−$739')!, OUT_PX, 'plain')
      const [c] = drawnAt(old.out.find((l) => l?.text === '−11.6K' || l?.text === '−$13.7K')!, OUT_PX, 'plain')
      assert.ok(c - b >= TOUCH && c - b < GAP, `${width}: ${c - b}`)
      assert.deepEqual(axisLabels(days, { width, gutter: GUTTER }), old, String(width))
      for (const hidden of [false, true]) holds(hidden ? hide(days) : days, width, `${days[0].day} ×${days.length}`, hidden)
    }
    // Whatever the days, from two weeks to the forty-five the card draws at most, in a 900 or a 1280 px window, with
    // numbers shown and hidden: wherever the drawing before reads cleanly, that drawing, two figures from 1 to 3 px
    // apart included.
    const rand = random(11)
    const figures = ['−7', '−65', '−214', '−999', '−1.5K', '−12K', '−1.2M', '−4K', '−$48', '−$1.5K', '−11.6K', '−$13.7K']
    const compared = { plain: 0, hidden: 0, close: 0 }
    for (let run = 0; run < 3000; run++) {
      const width = rand() < 0.5 ? 612 : 924
      const n = 14 + Math.floor(rand() * 32)
      const outs: Record<number, string> = {}
      const often = rand()
      for (let i = 0; i < n; i++) if (rand() < often) outs[i] = figures[Math.floor(rand() * figures.length)]
      const plain = sample(addDays('2030-01-01', Math.floor(rand() * 365)), n, outs)
      for (const font of ['plain', 'hidden'] as const) {
        const days = font === 'hidden' ? hide(plain) : plain
        if (!readsAsBefore(days, width, font)) continue
        compared[font]++
        const old = before(days, width)
        const spans = old.out.filter((l) => l !== null).map((l) => drawnAt(l, OUT_PX, font))
        if (spans.some(([, b], i) => i + 1 < spans.length && spans[i + 1][0] - b < GAP)) compared.close++
        assert.deepEqual(axisLabels(days, { width, gutter: GUTTER, hidden: font === 'hidden' }), old, `run ${run}: ${days[0].day} ×${n} at ${width}, ${font}`)
      }
    }
    assert.ok(compared.plain > 850 && compared.hidden > 1350 && compared.close > 150, JSON.stringify(compared))
  })

  test('a window long enough for every other day’s number draws as it always did wherever that reads cleanly, and else shows only its labelled days’ figures', () => {
    // Four weeks from Nov 15 in a 900 px window, figures on days with no number, the last day's too, each centred in
    // its column, more than 2 px from every date: as before. So too six weeks in a 1280 px one.
    const band = (612 - GUTTER) / 28
    const fourWeeks = sample('2030-11-15', 28, { 3: '−48', 9: '−214', 20: '−65', 27: '−80' })
    const r = axisLabels(fourWeeks, { width: 612, gutter: GUTTER })
    assert.deepEqual(r, before(fourWeeks, 612))
    assert.deepEqual(
      r.out.flatMap((l) => (l ? [[l.text, l.x]] : [])),
      [3, 9, 20, 27].map((i) => [fourWeeks[i].out, GUTTER + band * i + band / 2])
    )
    const sixWeeks = sample('2030-11-11', 40, { 5: '−1.5K', 17: '−214', 39: '−65' })
    for (const hidden of [false, true]) {
      const days = hidden ? hide(sixWeeks) : sixWeeks
      assert.deepEqual(axisLabels(days, { width: 924, gutter: GUTTER, hidden }), before(days, 924), String(hidden))
      assert.equal(holds(days, 924, 'Nov 11 ×40', hidden), 'clean')
    }
    // Thirty days from Nov 16 in a 900 px window, where the 30 ran into Dec 1 and Dec 1 into the 2: the 30 goes and
    // Dec 1 ends at its column, and every day that spends has no number, so no figure shows.
    const thirty = sample('2030-11-16', 30, { 3: '−48', 9: '−214', 21: '−65', 27: '−302', 29: '−19' })
    for (const hidden of [false, true]) {
      const days = hidden ? hide(thirty) : thirty
      const r = axisLabels(days, { width: 612, gutter: GUTTER, hidden })
      assert.equal(drawn(r.day.slice(12, 17)), '28 . . Dec 1(end) 2', String(hidden))
      assert.deepEqual(r.out, Array(30).fill(null), String(hidden))
      assert.equal(holds(days, 612, 'Nov 16 ×30', hidden), 'narrow')
    }
    // The last day spending, laid out narrower at a phone's width: its figure only under its own number, ended at the
    // chart's edge, never under the day before's date or midway between two earlier days' (a month's last days from
    // Nov 3, the last spending $1,500 to $11,600; six weeks and a half with numbers hidden, Jan 1 two days before it).
    for (const [days, from, to, hidden] of [
      [sample('2030-11-03', 32, { 31: '−11.6K' }), 254, 320, false],
      [sample('2030-11-03', 28, { 27: '−1.5K' }), 300, 360, false],
      [sample('2030-11-03', 26, { 25: '−302' }), 254, 300, false],
      [sample('2030-11-03', 35, { 34: '−11.6K' }), 254, 300, false],
      [sample('2027-01-27', 38, { 0: '−25', 4: '−48', 5: '−7', 9: '−214', 16: '−65', 22: '−999', 31: '−4K', 33: '−80', 37: '−310' }), 330, 370, false],
      [hide(sample('2030-11-20', 45, { 0: '−25', 26: '−2.2K', 44: '−1.5K' })), 254, 290, true]
    ] as const)
      for (let width = from; width <= to; width++) {
        holds(days, width, `${days[0].day} ×${days.length} at ${width}`, hidden)
        const r = axisLabels(days, { width, gutter: GUTTER, hidden })
        if (!r.day.at(-1)) assert.equal(r.out.at(-1), null, `${days[0].day} ×${days.length} at ${width}`)
      }
    // At 350 px, 38 days from Jan 27, the last day's −310 ended at the chart's edge, its middle on Mar 4's date: no
    // number of its own, so it isn't drawn; and none where it would sit under Dec 1's date at 279 or the 29th's at 326.
    assert.deepEqual(axisLabels(sample('2027-01-27', 38, { 37: '−310' }), { width: 350, gutter: GUTTER }).out.at(-1), null)
    assert.equal(axisLabels(sample('2030-11-03', 32, { 31: '−11.6K' }), { width: 279, gutter: GUTTER }).out[31], null)
    assert.equal(axisLabels(sample('2030-11-03', 28, { 27: '−1.5K' }), { width: 326, gutter: GUTTER }).out[27], null)
    // Whatever the days, from one to the forty-five the card draws at most (half of them more than a column of
    // NARROW_BAND has room for), in a 900 or a 1280 px window and at every width from 560 to 1300: the drawing before,
    // where it reads cleanly, label for label, its figures on days with no number too, and else only labelled days'
    // figures (holds()).
    const rand = random(29)
    const figures = ['−7', '−65', '−214', '−999', '−1.5K', '−12K', '−1.2M', '−4K']
    /** A window of one to 45 days, or of more than a column of NARROW_BAND has room for. */
    const window = (width: number, long = false): AxisDay[] => {
      const least = long ? Math.floor((width - GUTTER) / NARROW_BAND) + 1 : 1
      const n = least + Math.floor(rand() * (46 - least))
      const dollar = (width - GUTTER) / n >= 38
      const often = rand() ** 2
      const outs: Record<number, string> = {}
      for (let i = 0; i < n; i++) if (rand() < often) outs[i] = figures[Math.floor(rand() * figures.length)].replace('−', dollar ? '−$' : '−')
      return sample(addDays('2030-01-01', Math.floor(rand() * 365)), n, outs)
    }
    const compared = { 612: 0, 924: 0, long: 0, loose: 0, last: 0 }
    const run = (days: AxisDay[], width: number, why: string): void => {
      for (const hidden of [false, true]) {
        const d = hidden ? hide(days) : days
        holds(d, width, why, hidden)
        if (!readsAsBefore(d, width, hidden ? 'hidden' : 'plain')) continue
        if (width === 612 || width === 924) compared[width]++
        const band = (width - GUTTER) / days.length
        if (band >= NARROW_BAND) continue
        // Long enough for every other day's number only: its figures on days with no number, the last day's too.
        compared.long++
        if (days.some((x, i) => x.out && i % 2 && i !== days.length - 1)) compared.loose++
        if (days.length % 2 === 0 && days.at(-1)!.out) compared.last++
      }
    }
    for (let i = 0; i < 4000; i++) {
      const width = rand() < 0.5 ? 612 : 924
      run(window(width, i % 2 === 1), width, `run ${i} at ${width}`)
    }
    for (let width = 560; width <= 1300; width++) for (let i = 0; i < 3; i++) run(window(width), width, `sweep ${i} at ${width}`)
    assert.ok(compared[612] > 1500 && compared[924] > 2000 && compared.long > 1700 && compared.loose > 1000 && compared.last > 150, JSON.stringify(compared))
  })

  test("at a phone's width every other day is numbered, each number's figure under it, and the last kept inside the chart", () => {
    // The chart is 254 px at 320, 309 at 375 and 348 at 414.
    assert.equal(drawn(axisLabels(twoWeeks, { width: 254, gutter: GUTTER }).day), 'Mar 14(end) . 16 . 18 . 20 . 22 . 24 . 26 . 28 . 30(end)')
    for (const width of [254, 309, 348]) {
      // −214 and −341, on days with no number, don't show; each numbered day's figure does, under its number.
      assert.equal(drawn(axisLabels(twoWeeks, { width, gutter: GUTTER }).out), '. . −65 . . . −187 . . . . . . . . . −4K(end)', String(width))
      assert.equal(holds(twoWeeks, width, String(width)), 'narrow')
      assert.equal(holds(hide(twoWeeks), width, String(width), true), 'narrow')
    }
    // From 1 px between −214 and −65, at 420, every figure as before, centred in its column; 0.9 px apart, at 418.3,
    // laid out narrower.
    assert.equal(drawn(axisLabels(twoWeeks, { width: 420, gutter: GUTTER }).out), '. −214 −65 . . . −187 . . −341 . . . . . . −4K')
    assert.equal(holds(twoWeeks, 420, '420'), 'clean')
    assert.equal(drawn(axisLabels(twoWeeks, { width: 418.3, gutter: GUTTER }).out), '. . −65 . . . −187 . . . . . . . . . −4K')
    assert.equal(holds(twoWeeks, 418.3, '418.3'), 'narrow')
    assert.equal(drawn(axisLabels(twoWeeks, { width: 500, gutter: GUTTER }).out), '. −214 −65 . . . −187 . . −341 . . . . . . −4K')
    // Two figures touching, −1.5K and −48 side by side in columns 24 px wide, or 0.5 px apart at 24.5, or −302 and −19
    // in a 469 px window's 21 px columns: laid out narrower, never as before; −1.5K and −48 1 px apart at 25, as before.
    const pair = sample('2030-03-05', 17, { 3: '−1.5K', 4: '−48' })
    const t17 = sample('2030-03-05', 17, { 3: '−302', 4: '−19', 16: '−65' })
    for (const [days, band, gap, how] of [
      [pair, 24, 0, 'narrow'],
      [pair, 24.5, 0.5, 'narrow'],
      [t17, 21, 0, 'narrow'],
      [pair, 25, 1, 'clean']
    ] as const) {
      const width = GUTTER + 17 * band
      const old = before(days, width)
      assert.ok(Math.abs(drawnAt(old.out[4]!, OUT_PX, 'plain')[0] - drawnAt(old.out[3]!, OUT_PX, 'plain')[1] - gap) < 1e-9, String(width))
      assert.equal(holds(days, width, `Mar 5 ×17 at ${width}`), how, String(width))
      if (how === 'narrow') assert.notDeepEqual(axisLabels(days, { width, gutter: GUTTER }), old, String(width))
    }
  })

  test('the first day ends at its column’s edge, out over the gutter, where centred its date would be over the next column or it would run into the next number', () => {
    const { day } = axisLabels(twoWeeks, { width: 254, gutter: GUTTER })
    const band = (254 - GUTTER) / twoWeeks.length
    assert.deepEqual(day[0], { text: 'Mar 14', x: GUTTER + band, anchor: 'end' })
    assert.equal(axisLabels(twoWeeks, { width: 348, gutter: GUTTER }).day[0]!.anchor, 'end')
    // A column wider than the name's month, it is centred.
    assert.equal(axisLabels(twoWeeks, { width: GUTTER + 25.4 * 17, gutter: GUTTER }).day[0]!.anchor, 'middle')
    // Six weeks and a half at 320, a column narrower than half its date: its date centred on the column, not over the
    // gutter.
    const sixWeeks = sample('2030-11-20', 45, {})
    for (const hidden of [false, true]) {
      const band = (254 - GUTTER) / 45
      assert.deepEqual(axisLabels(sixWeeks, { width: 254, gutter: GUTTER, hidden }).day[0], { text: 'Nov 20', x: GUTTER + band / 2 + textWidth('20', DAY_PX, hidden) / 2, anchor: 'end' })
      for (let width = 254; width <= 320; width++) holds(sixWeeks, width, `Nov 20 ×45 ${width}`, hidden)
    }
  })

  test('a day every day spends: every other day, or every third, with its own figure under its number', () => {
    const daily = sample('2030-03-04', 17, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i, i % 3 ? '−48' : '−1.5K'])))
    for (const width of [254, 309, 348, 413, 454, 480]) {
      const { day, out } = axisLabels(daily, { width, gutter: GUTTER })
      // At 480 −1.5K and −48 sit 1.5 px apart, so as before, every figure in its column.
      assert.equal(holds(daily, width, `daily ${width}`), width === 480 ? 'clean' : 'narrow', String(width))
      holds(hide(daily), width, `daily ${width}`, true)
      if (width === 480) continue
      const numbered = day.map((l, i) => (l ? i : -1)).filter((i) => i > 0)
      const stride = numbered[1] - numbered[0]
      assert.ok(stride >= 2, `${width}: stride ${stride}`)
      // Each numbered day shows its figure; the days between show theirs in their columns' bars and tips only.
      for (const i of numbered) assert.ok(out[i], `${width}: day ${i}'s figure`)
      for (let i = 1; i < daily.length; i++) if (!day[i]) assert.equal(out[i], null, `${width}: day ${i}`)
    }
    // At 320 every other day's −1.5K would run into the next numbered day's −48: every third day, each figure under it.
    const r = axisLabels(daily, { width: 254, gutter: GUTTER })
    assert.deepEqual([drawn(r.day), drawn(r.out)], ['Mar 4(end) . . 7 . . 10 . . 13 . . 16 . . 19 .', '−1.5K . . −1.5K . . −1.5K . . −1.5K . . −1.5K . . −1.5K .'])
  })

  test('a figure on a day with no number shows only as before, its column’s centre more than 2 px from every date, so it can’t read as another day’s', () => {
    // The demo's two weeks: the 12th's −106 beside the first day's name (the 11th, which spends nothing), at every chart
    // width a phone, a phone on its side or a window over 700 px gives it.
    const demo = sample('2030-11-11', 17, { 1: '−106', 2: '−80', 6: '−148', 9: '−302', 16: '−3K' })
    // Every day spending; a first day that spends nothing beside one that does; a month's end, a 1st two days on.
    const everyday = sample('2030-11-11', 17, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i, ['−42', '−19', '−80', '−7', '−23', '−$120', '−148'][i % 7]])))
    const quiet = sample('2030-11-14', 17, { 1: '−25', 6: '−148', 16: '−3K' })
    const monthEnd = sample('2030-11-27', 17, { 2: '−54', 4: '−1.5K', 6: '−1.2K', 9: '−25', 13: '−80', 16: '−400' })
    for (const days of [demo, everyday, quiet, monthEnd])
      for (let width = 200; width <= 800; width++) {
        holds(days, width, `${days[0].day} ${width}`)
        holds(hide(days), width, `${days[0].day} ${width}`, true)
      }
    // At a phone's width −106 and −302 have no number, so they don't show; in a 520 to 553 px window, 11.4 px and more
    // from the 11's date, every figure as before.
    for (const width of [254, 309, 348]) assert.deepEqual([1, 9].map((i) => axisLabels(demo, { width, gutter: GUTTER }).out[i]), [null, null], String(width))
    for (const width of [454, 470, 487]) assert.deepEqual(axisLabels(demo, { width, gutter: GUTTER }), before(demo, width), String(width))
    // Dec 2's −48 with no number, Dec 1 centred the day before, its date exactly 2 px from the figure's middle (20 days
    // from Nov 15 in a 338 px chart): laid out narrower, where it doesn't show; 2.001 px from it, at 338.02, and 2.1, at
    // 340, as before. So too Nov 12's −7 beside the first day's name, its date 2.047 px from the figure's middle in a
    // 361 px window's 295 px chart, and 1.988 px at 294, laid out narrower.
    const dec = sample('2030-11-15', 20, { 17: '−48' })
    const nov = sample('2030-11-11', 17, { 1: '−7' })
    for (const [days, i, width, lean, how] of [
      [dec, 17, 338, 2, 'narrow'],
      [dec, 17, 338.02, 2.001, 'clean'],
      [dec, 17, 340, 2.1, 'clean'],
      [nov, 1, 294, 1.988, 'narrow'],
      [nov, 1, 295, 2.047, 'clean']
    ] as const) {
      const old = before(days, width)
      const why = `${days[0].day} ×${days.length} at ${width}`
      for (const hidden of [false, true]) {
        const font: Font = hidden ? 'hidden' : 'plain'
        const [a, b] = drawnAt(old.out[i]!, OUT_PX, font)
        assert.ok(Math.abs((a + b) / 2 - dateOf(old.day[i - 1]!, font) - lean) < 5e-4, `${why}, ${font}`)
        assert.equal(holds(hidden ? hide(days) : days, width, why, hidden), how, `${why}, ${font}`)
      }
      assert.equal(axisLabels(days, { width, gutter: GUTTER }).out[i]?.text, how === 'clean' ? days[i].out : undefined, why)
    }
  })

  test('a month’s 1st keeps its name, its date over its own column, and the numbers beside it give way', () => {
    // Twenty days across the end of a month, from the day before a 1st, and from a 1st four days in.
    for (const days of [sample('2030-04-30', 20, { 0: '−90', 1: '−2.4K', 3: '−18' }), sample('2030-01-28', 20, { 4: '−300', 5: '−75' })]) {
      for (let width = 200; width <= 1300; width += 7) {
        const first = days.findIndex((d, i) => i > 0 && d.day.endsWith('-01'))
        for (const hidden of [false, true]) {
          const { day } = axisLabels(hidden ? hide(days) : days, { width, gutter: GUTTER, hidden })
          assert.equal(day[first]?.text, days[first].name, `${days[0].day} ${width}`)
          holds(hidden ? hide(days) : days, width, `${days[0].day} ${width}`, hidden)
        }
      }
    }
    // A 1st in the next-to-last column, the last day's figure left out beside its: the 1st ends at its own column's
    // edge, never at the chart's, so its date isn't over the last day's column.
    const days = sample('2030-11-14', 19, { 1: '−25', 17: '−1.5K', 18: '−1.2K' })
    for (let width = 230; width <= 320; width++)
      for (const hidden of [false, true]) {
        const l = axisLabels(hidden ? hide(days) : days, { width, gutter: GUTTER, hidden }).day[17]!
        const band = (width - GUTTER) / 19
        assert.ok(l.anchor === 'middle' || l.x <= GUTTER + band * 18 + 1e-9, `${width}: Dec 1 ${l.anchor} at ${l.x}`)
        holds(hidden ? hide(days) : days, width, `Dec 1 ${width}`, hidden)
      }
    // A 1st in the next-to-last column, which spends nothing, and the last day's −1.5K, ended at the chart's edge, no
    // nearer the last day's 2 than the 1st's date: the 2 and its figure go, never the 1st's name, though a number over
    // no figure nearer it would.
    const late = sample('2030-11-02', 31, { 30: '−1.5K' })
    for (const hidden of [false, true]) {
      const days = hidden ? hide(late) : late
      const r = axisLabels(days, { width: 431, gutter: GUTTER, hidden })
      assert.deepEqual([drawn(r.day.slice(-3)), r.out[30]], ['. Dec 1(end) .', null], String(hidden))
      holds(days, 431, 'Nov 2 ×31', hidden)
    }
    // A 1st as the last day at a phone's width, 38 days from Nov 25, Jan 1 spending the most: its name ended at the
    // chart's edge and its figure under it, with numbers shown at every width, and hidden wherever its column is half
    // as wide as its date (from a 286 px chart). Narrower, no place keeps that date both over its column and inside
    // the chart.
    const lastFirst = sample('2030-11-25', 38, { 3: '−48', 20: '−214', 37: '−2.5K' })
    for (let width = 254; width <= 330; width++)
      for (const hidden of [false, true]) {
        const days = hidden ? hide(lastFirst) : lastFirst
        const why = `Nov 25 ×38 at ${width}${hidden ? ', hidden' : ''}`
        holds(days, width, why, hidden)
        if (hidden && (width - GUTTER) / 38 < FONTS.hidden('1', DAY_PX) / 2) continue
        const { day, out } = axisLabels(days, { width, gutter: GUTTER, hidden })
        assert.deepEqual([day[37]?.text, day[37]?.anchor, out[37]?.text], ['Jan 1', 'end', days[37].out], why)
        assert.ok(Math.abs(day[37]!.x - width) < 1e-9, why)
      }
    // A 1st two days in at a phone's width: the first day keeps its name, out over the gutter as far as its date's
    // middle on its column's left edge, clear of the 1st's, rather than leave today unlabelled.
    for (const [width, n] of [
      [309, 17],
      [254, 14]
    ] as const) {
      const { day } = axisLabels(sample('2030-01-30', n, {}), { width, gutter: GUTTER })
      assert.deepEqual([day[0], day[2]?.text], [{ text: 'Jan 30', x: GUTTER + textWidth('30', DAY_PX) / 2, anchor: 'end' }, 'Feb 1'], String(width))
      for (const hidden of [false, true]) holds(sample('2030-01-30', n, {}), width, `Jan 30 ${width}`, hidden)
    }
    // From any day of a year, two weeks or the demo's seventeen days from a phone's width up: today is labelled
    // unless tomorrow is a 1st. With numbers hidden a 1st's date is twice as wide, so from a little wider.
    for (const [n, width, hiddenToo] of [
      [14, 254, false],
      [14, 309, true],
      [14, 348, true],
      [14, 413, true],
      [17, 309, false],
      [17, 348, true],
      [17, 413, true],
      [17, 482, true]
    ] as const)
      for (let s = 0; s < 365; s++) {
        const days = sample(addDays('2030-01-01', s), n, {})
        for (const hidden of hiddenToo ? [false, true] : [false]) assert.ok(axisLabels(days, { width, gutter: GUTTER, hidden }).day[0] || days[1].day.endsWith('-01'), `${days[0].day} ×${n} at ${width}${hidden ? ', hidden' : ''}`)
      }
  })

  test('a day labelled shows its figure, and where that figure would crowd a name’s the day’s label goes with it', () => {
    // A 1st and the day labelled two later, both spending (a phone's chart); the first day and the day labelled two
    // later; a 1st and the next day on the desktop, its column 31 px.
    for (const [days, width] of [
      [sample('2030-11-27', 17, { 4: '−1.5K', 6: '−1.2K' }), 309],
      [sample('2030-11-11', 17, { 0: '−1.5K', 2: '−80' }), 254],
      [sample('2030-11-28', 18, { 3: '−1.5K', 4: '−1.2K' }), 612],
      [sample('2030-04-30', 17, { 0: '−2.4K', 1: '−1.5K' }), 309]
    ] as const) {
      holds(days, width, `${days[0].day} ${width}`)
      holds(hide(days), width, `${days[0].day} ${width}`, true)
      const { day, out } = axisLabels(days, { width, gutter: GUTTER })
      // The 1st keeps its name and its figure.
      const first = days.findIndex((d, i) => i > 0 && d.day.endsWith('-01'))
      if (days[first]?.out) assert.deepEqual([day[first]?.text, out[first]?.text], [days[first].name, days[first].out])
      // The day beside it that can't show its figure shows no label either.
      days.forEach((d, i) => d.out && !out[i] && assert.equal(day[i], null, `${days[0].day} ${width}: ${d.day}`))
    }
    // The first day's figure, centred under its column, 2.7 px from a 1st's two days on: the first day goes, its name
    // and its figure, never the 1st's.
    const { day, out } = axisLabels(sample('2030-04-29', 17, { 0: '−1.5K', 2: '−2.4K' }), { width: 324, gutter: GUTTER })
    assert.deepEqual([day[0], out[0], day[2]?.text, out[2]], [null, null, 'May 1', { text: '−2.4K', x: GUTTER + ((324 - GUTTER) / 17) * 2.5, anchor: 'middle' }])
  })

  test('a figure that would pass the chart’s edge ends at it, nearer its own date than any other, and a number nearer it over no figure goes', () => {
    // Four weeks at 320, $1,500 on Dec 7: the next-to-last day, the last spending $300 or nothing, and the last day.
    // Ended at its own column's edge it sat under the 4th's date; at the chart's, beside the 7th's in the last column,
    // as near the 4th's, which spends nothing.
    const band = (n: number): number => (254 - GUTTER) / n
    for (const [n, outs, tail] of [
      [29, { 27: '−1.5K', 28: '−300' }, 'Dec 1(end) . . 4 . . 7 .'],
      [29, { 27: '−1.5K' }, 'Dec 1(end) . . 4 . . 7 .'],
      [28, { 27: '−1.5K' }, 'Dec 1(end) . . . . . 7']
    ] as const) {
      const days = sample('2030-11-10', n, outs)
      const { day, out } = axisLabels(days, { width: 254, gutter: GUTTER })
      assert.equal(drawn(day).slice(-tail.length), tail, String(n))
      assert.deepEqual(out[27], { text: '−1.5K', x: 254, anchor: 'end' }, String(n))
      assert.equal(out[28] ?? null, null, String(n))
      assert.ok(GUTTER + band(n) * 27.5 + textWidth('−1.5K', OUT_PX) / 2 > 254)
      holds(days, 254, `Nov 10 ×${n}`)
      holds(hide(days), 254, `Nov 10 ×${n}`, true)
    }
    // Three weeks, $1,500 on the last day: its figure's middle 8.7 px from its own 30's and 9.8 px from the 28th's,
    // which spends nothing, reads as either day's, so the 28th's number goes.
    const threeWeeks = sample('2030-11-10', 21, { 20: '−1.5K' })
    const r = axisLabels(threeWeeks, { width: 254, gutter: GUTTER })
    assert.deepEqual([drawn(r.day.slice(-7)), r.out[20]], ['24 . 26 . . . 30(end)', { text: '−1.5K', x: 254, anchor: 'end' }])
    for (let width = 254; width <= 300; width++) for (const hidden of [false, true]) holds(hidden ? hide(threeWeeks) : threeWeeks, width, `Nov 10 ×21 ${width}`, hidden)
    // A 1st in the last column, 18 days from Nov 14 in a 536 px chart: its −$13.7K, ended at the chart's edge, 19.8 px
    // from the 30's date and 17.85 from its own, so the 30 goes, whether it spends nothing or $7, never Dec 1's name.
    for (const outs of [{ 17: '−$13.7K' }, { 16: '−$7', 17: '−$13.7K' }]) {
      const days = sample('2030-11-14', 18, outs)
      const r = axisLabels(days, { width: 536, gutter: GUTTER })
      assert.deepEqual([drawn(r.day.slice(-3)), drawn(r.out.slice(-3))], ['29 . Dec 1(end)', '. . −$13.7K(end)'], JSON.stringify(outs))
      for (let width = 530; width <= 545; width += 0.5) for (const hidden of [false, true]) holds(hidden ? hide(days) : days, width, `Nov 14 ×18 ${width}`, hidden)
    }
  })

  test('each label is placed as wide as it draws: with numbers hidden a number is one glyph twice a digit wide, and with them shown it is not', () => {
    for (const text of ['−3K', '−7', '9', 'Mar 1', '−$1.5K', '−214', '−3,012', 'Nov 11'])
      for (const px of [DAY_PX, OUT_PX]) {
        assert.ok(Math.abs(textWidth(text, px) - FONTS.plain(text, px)) < 1e-9, text)
        assert.ok(textWidth(text, px, true) >= FONTS.hidden(text, px) - 1e-9 && textWidth(text, px, true) <= FONTS.plain(text, px) + 1.2 * px, text)
      }
    // A name's date: its number's middle.
    assert.equal(dateAt({ text: 'Nov 11', x: 100, anchor: 'end' }, DAY_PX), 100 - 0.6 * DAY_PX)
    assert.equal(dateAt({ text: 'Dec 1', x: 100, anchor: 'end' }, DAY_PX, true), 100 - 0.6 * DAY_PX)
    assert.equal(dateAt({ text: '27', x: 100, anchor: 'middle' }, DAY_PX), 100)
    // The last day spending $7 or $3,000, the first a month's 1st: at a phone's width, with numbers hidden, the last
    // figure and number still end inside the chart, and the first day's name clears the next number.
    for (const days of [sample('2030-03-18', 17, { 16: '−7' }), sample('2030-05-01', 17, { 16: '−7', 2: '−3K' }), sample('2030-11-11', 17, { 2: '−80', 16: '−3K' })])
      for (let width = 254; width <= 720; width += 2) {
        holds(hide(days), width, `${days[0].day} ${width}`, true)
        holds(days, width, `${days[0].day} ${width}`)
      }
  })

  test('the cushion line’s name sits at the line’s right end, else its left, where neither the low day’s figure nor a bar is on it, else over the bars, and goes where the figure takes both ends', () => {
    // A phone's chart, 309 px, the low day its last column: its figure ends over that column's middle, on the line.
    const at = { width: 309, gutter: GUTTER }
    const low = { text: '$12,824', x: 46 + (263 / 17) * 16.5, anchor: 'end' as const, y: 17.7 }
    const band = 263 / 17
    /** A bar in each column, rising to `tops[i]`. */
    const columns = (tops: number[]): Bar[] => tops.map((top, i) => ({ left: GUTTER + band * i + band * 0.225, right: GUTTER + band * i + band * 0.775, top }))
    const flat = columns(Array(17).fill(150))
    const right = { text: 'Cushion', x: 309, anchor: 'end', over: false }
    const left = { text: 'Cushion', x: GUTTER, anchor: 'start', over: false }
    // Nothing on it: at its right end, as ever.
    assert.deepEqual(cushionLabel('Cushion', 40, null, flat, at), right)
    for (const y of [low.y - 14, low.y + 14]) assert.deepEqual(cushionLabel('Cushion', y, low, flat, at), right)
    // The low day's figure on its right end: its left.
    assert.deepEqual(cushionLabel('Cushion', low.y + 5, low, flat, at), left)
    assert.deepEqual(cushionLabel('Cushion', low.y - 13, low, flat, at), left)
    // The bars falling from the left, rising into it there: still clear at the right; with the low figure there too,
    // drawn over the bars at the left.
    const falling = columns(Array.from({ length: 17 }, (_, i) => 10 + i * 8))
    assert.deepEqual(cushionLabel('Cushion', 60, null, falling, at), right)
    assert.deepEqual(cushionLabel('Cushion', low.y + 5, low, falling, at), { ...left, over: true })
    // The bars rising to the right: at its left; bars into both ends: over them at the right.
    const rising = columns(Array.from({ length: 17 }, (_, i) => 150 - i * 8))
    assert.deepEqual(cushionLabel('Cushion', 60, null, rising, at), left)
    assert.deepEqual(cushionLabel('Cushion', 60, null, columns(Array(17).fill(10)), at), { ...right, over: true })
    // The low day in the first column, its figure from there: the right end is clear.
    assert.equal(cushionLabel('Cushion', low.y, { ...low, x: 46 + 263 / 34, anchor: 'start' }, flat, at)!.x, 309)
    // A figure across the whole line leaves it no name.
    assert.equal(cushionLabel('Cushion', low.y, { text: '−$1,234,567,890', x: 77, anchor: 'middle', y: low.y }, flat, { width: 140, gutter: GUTTER }), null)
    // Wherever it goes, in either font, it keeps LABEL_GAP from the low figure.
    for (const hidden of [false, true]) {
      const font: Font = hidden ? 'hidden' : 'plain'
      const c = drawnAt(cushionLabel('Cushion', low.y, low, flat, { ...at, hidden })!, DAY_PX, font)
      const f = drawnAt(low, DAY_PX, font)
      assert.ok(c[1] + LABEL_GAP <= f[0] || f[1] + LABEL_GAP <= c[0], font)
    }
  })

  test('for any days and any width, the drawing before where it reads cleanly, else no two labels in a row within 3 px, none past the chart’s edge, and a figure only under its own day’s label', () => {
    const rand = random(7)
    const figures = ['−7', '−65', '−214', '−999', '−1.5K', '−12K', '−1.2M', '−4K']
    const tiers = { clean: 0, narrow: 0, phoneClean: 0, phoneNarrow: 0 }
    for (let run = 0; run < 400; run++) {
      const n = 14 + Math.floor(rand() * 32)
      const first = addDays('2030-01-01', Math.floor(rand() * 365))
      const often = rand()
      const outs: Record<number, string> = {}
      for (let i = 0; i < n; i++) if (rand() < often) outs[i] = figures[Math.floor(rand() * figures.length)]
      const days = sample(first, n, outs)
      const width = Math.round(GUTTER + 60 + rand() * 1200)
      tiers[holds(days, width, `run ${run}: ${first} ×${n} at ${width}`)]++
      tiers[holds(hide(days), width, `run ${run}: ${first} ×${n} at ${width}`, true)]++
    }
    // Most where columns are narrowest: two weeks to six and a half at a phone's width or a window just over 700 px.
    for (let run = 0; run < 1600; run++) {
      const n = 14 + Math.floor(rand() * 32)
      const first = addDays('2030-01-01', Math.floor(rand() * 365))
      const often = rand()
      const outs: Record<number, string> = {}
      for (let i = 0; i < n; i++) if (rand() < often) outs[i] = figures[Math.floor(rand() * figures.length)]
      const days = sample(first, n, outs)
      const width = 254 + Math.floor(rand() * 229)
      for (const hidden of [false, true]) {
        const how = holds(hidden ? hide(days) : days, width, `phone run ${run}: ${first} ×${n} at ${width}`, hidden)
        tiers[how === 'clean' ? 'phoneClean' : 'phoneNarrow']++
      }
    }
    assert.ok(tiers.clean > 250 && tiers.narrow > 350 && tiers.phoneClean > 180 && tiers.phoneNarrow > 2500, JSON.stringify(tiers))
  })
})

// The card itself, rendered as the app renders it: the renderer's .tsx through the transform the app's bundler uses
// (Vite's Rolldown), its chart's width and the app's toast stood in for, so what the chart draws is checked, not only
// the module it asks.
const viteRequire = createRequire(import.meta.resolve('vite'))
const { transformSync } = (await import(pathToFileURL(viteRequire.resolve('rolldown/utils')).href)) as typeof import('rolldown/utils')
const stand = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`
const METER = stand('export let width = 0; export const setWidth = (w) => { width = w }; export const useWidth = () => [() => {}, width]')
const APP = stand('export const useApp = () => ({ toast() {} })')
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/pages/Spendable.tsx') && specifier === '../Meter') return { url: METER, shortCircuit: true }
    if (context.parentURL?.endsWith('/pages/Spendable.tsx') && specifier === '../App') return { url: APP, shortCircuit: true }
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL && existsSync(`${fileURLToPath(new URL(specifier, context.parentURL))}.tsx`)) return next(`${specifier}.tsx`, context)
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.endsWith('.tsx')) return next(url, context)
    const file = fileURLToPath(url)
    const { code, errors } = transformSync(file, readFileSync(file, 'utf8'), { lang: 'tsx', jsx: { runtime: 'automatic' } })
    if (errors.length) throw new Error(`${file}: ${errors.map((e) => e.message).join('; ')}`)
    return { format: 'module', source: code, shortCircuit: true }
  }
})
Object.assign(globalThis, { window: { api: {} }, document: { documentElement: { classList: { toggle: () => true } } } })
const { setWidth } = (await import(METER)) as { setWidth: (w: number) => void }
const { SpendableCard } = await import('../src/renderer/src/pages/Spendable.tsx')
const { setNumbersHidden } = await import('../src/renderer/src/lib.ts')

/** An account's days from a balance, each day's spending in dollars, and what comes in on a day. */
function account(from: string, start: number, spends: number[], pay: Record<number, number> = {}): Spendable {
  let balance = start * 100
  const days: SpendDay[] = spends.map((s, i) => {
    const d = { day: addDays(from, i), startCents: balance, outCents: -s * 100, inCents: (pay[i] ?? 0) * 100, endCents: balance - s * 100 + (pay[i] ?? 0) * 100, lowCents: balance - s * 100 }
    balance = d.endCents
    return d
  })
  const low = days.reduce((a, d) => (d.endCents < a.endCents ? d : a))
  const a = { id: 'chk', name: 'Checking', startCents: start * 100, balanceDate: 0, spendableCents: 0, lowDay: low.day, nextPayday: null, perDayCents: null, days, byRisk: { cautious: 0, balanced: 0, tight: 0 } }
  return { risk: 'balanced', cushionCents: 0, accountId: 'chk', accounts: [a], items: [] }
}

type Drawn = { tag: string; at: Record<string, string>; text: string }
/** The chart's svg as the card draws it at a width: its texts and rects in order, each with its attributes. */
function chart(spend: Spendable, width: number): Drawn[] {
  setWidth(width)
  const svg = /<svg[\s\S]*<\/svg>/.exec(renderToStaticMarkup(createElement(SpendableCard, { spend })))![0]
  return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>|<rect\b([^>]*?)\/?>/g)].map((m) => ({
    tag: m[1] === undefined ? 'rect' : 'text',
    at: Object.fromEntries([...(m[1] ?? m[3]).matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
    text: (m[2] ?? '').replace(/<!-- -->/g, '')
  }))
}
const label = (e: Drawn): AxisLabel => ({ text: e.text, x: Number(e.at.x), anchor: (e.at['text-anchor'] ?? 'start') as AxisLabel['anchor'] })
const sheet = parse(readFileSync(fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)), 'utf8'))
/** The window a chart this wide is drawn in (Home's Spendable card, as test/narrow-shell.test.ts has it). */
const WINDOW: Record<number, number> = { 254: 320, 309: 375, 348: 414, 413: 701, 612: 900, 924: 1280 }
/** What one of the chart's texts is painted with, however it is written: its style attribute's, else the stylesheet's,
 * else its own presentation attribute's. */
function painted(e: Drawn, width: number, prop: string): string | undefined {
  const style = Object.fromEntries((e.at.style ?? '').split(';').flatMap((d) => (d.includes(':') ? [[d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]] : [])))
  const chain: El[] = [
    { tag: 'html' },
    { tag: 'body' },
    { tag: 'div', id: 'root' },
    { tag: 'div', classes: ['app'] },
    { tag: 'main', classes: ['main'] },
    { tag: 'div', classes: ['page', 'home'] },
    { tag: 'div', classes: ['card', 'spend-card'], width },
    { tag: 'div', classes: ['spend-chart'] },
    { tag: 'svg', attrs: { role: 'group' } },
    { tag: 'text', classes: (e.at.class ?? '').split(/\s+/).filter(Boolean) }
  ]
  return style[prop] ?? computed(sheet, chain, { width: WINDOW[width] })[prop] ?? e.at[prop]
}
/** Whether a paint-order paints the stroke before the fill, however it is written: what it leaves out follows in the
 * order fill, stroke, markers. */
const strokeFirst = (order = 'normal'): boolean => {
  const named = order.trim().split(/\s+/).filter((t) => t !== 'normal')
  const all = [...named, ...['fill', 'stroke', 'markers'].filter((t) => !named.includes(t))]
  return all.indexOf('stroke') < all.indexOf('fill')
}
/** How one of the chart's texts is painted over the bars: a halo (a stroke in the card's colour, at least 2 px wide, a
 * pixel each side of its glyphs, painted under its fill) and no pointer, as it covers the columns' own. */
const halo = (e: Drawn, width: number): string => {
  const stroke = painted(e, width, 'stroke')
  const wide = Number.parseFloat(painted(e, width, 'stroke-width') ?? '1')
  return `${stroke === 'var(--card-solid)' && wide >= 2 && strokeFirst(painted(e, width, 'paint-order')) ? 'halo' : `no halo (${stroke}, ${wide}, ${painted(e, width, 'paint-order')})`}, pointer ${painted(e, width, 'pointer-events') ?? 'auto'}`
}
const classed = (els: Drawn[], name: string): Drawn[] => els.filter((e) => e.tag === 'text' && new RegExp(`\\b${name}\\b`).test(e.at.class ?? ''))

describe("Spendable's chart as the card draws it", () => {
  // Two weeks and a half from $20,000, $300 a day, the last day $3,000 (or $7) and the lowest.
  const falling = (last: number): number[] => [0, ...Array<number>(15).fill(300), last]
  const outs = (last: string, width: number): AxisDay[] => {
    const dollar = (width - GUTTER) / 17 >= 38 ? '−$' : '−'
    return sample('2030-11-11', 17, Object.fromEntries([...Array.from({ length: 15 }, (_, i) => [i + 1, `${dollar}300`]), [16, `${dollar}${last}`]]))
  }

  test('its days and figures are the axis’s, measured as they draw, with numbers shown and hidden', () => {
    for (const [hidden, last, text] of [
      [false, 3000, '3K'],
      [true, 3000, '3,000'],
      [false, 7, '7'],
      [true, 7, '7']
    ] as const) {
      setNumbersHidden(hidden)
      try {
        for (const width of [254, 309, 348, 413, 612]) {
          const els = chart(account('2030-11-11', 20_000, falling(last)), width)
          const axis = axisLabels(outs(text, width), { width, gutter: GUTTER, hidden })
          const band = (width - GUTTER) / 17
          const at = `${width}${hidden ? ', hidden' : ''}`
          assert.deepEqual(classed(els, 'spend-day').map(label), axis.day.map((l, i) => l ?? { text: '', x: GUTTER + band * i + band / 2, anchor: 'middle' }), at)
          assert.deepEqual(classed(els, 'spend-out').map(label), axis.out.filter((l) => l !== null), at)
        }
      } finally {
        setNumbersHidden(false)
      }
    }
    // The last day's −7 at a phone's width: centred with numbers shown, against the chart's edge with them hidden,
    // where it draws as wide as −3K.
    for (const [hidden, anchor] of [
      [false, 'middle'],
      [true, 'end']
    ] as const) {
      setNumbersHidden(hidden)
      try {
        assert.equal(classed(chart(account('2030-11-11', 20_000, falling(7)), 309), 'spend-out').at(-1)!.at['text-anchor'], anchor)
      } finally {
        setNumbersHidden(false)
      }
    }
  })

  test("the cushion's name keeps off the low day's figure, and no bar drawn after it rises into it", () => {
    // A paycheck on the ninth day lifting the balance from $5,000 to $15,000 over the cushion.
    const rising = account('2030-11-11', 5_000, Array<number>(17).fill(40), { 8: 10_000 })
    // The low day the fourth, a paycheck the next day, and two weeks' last day spending $3,000 from $18,000.
    const stepped = account('2030-11-11', 20_000, [0, 0, 0, 10_000, ...Array<number>(9).fill(0), 3_000], { 4: 8_000 })
    for (const [spend, cushion, where] of [
      // At or under the last day's start, by the low figure: at the line's left, where the bars rise into it, over them.
      [account('2030-11-11', 20_000, falling(3000)), 15_500, 'left over'],
      [account('2030-11-11', 20_000, falling(3000)), 15_000, 'left over'],
      // Over every bar: at its right end, before the columns, as ever.
      [account('2030-11-11', 20_000, falling(3000)), 19_500, 'right'],
      // Under the low day: at its right end, where the bars rise into it, over them.
      [account('2030-11-11', 20_000, falling(3000)), 5_000, 'right over'],
      // Over the balance before the paycheck and under it after: at its left, before the columns.
      [rising, 8_000, 'left'],
      // Under the first days' bars at its left, and at its right under the last day's spending outlined above its
      // solid part: over them at its right end, where the outline alone rises into it on the desktop.
      [stepped, 16_000, 'right over']
    ] as const)
      for (const width of [254, 309, 348, 413, 612, 924]) {
        const els = chart({ ...spend, cushionCents: cushion * 100 }, width)
        const at = `$${cushion} at ${width}`
        const i = els.findIndex((e) => e.tag === 'text' && e.text === 'Cushion')
        const name = els[i]
        const [a, b] = drawnAt(label(name), DAY_PX, 'plain')
        const baseline = Number(name.at.y)
        // LABEL_GAP to the side of the low day's figure where the two share a line.
        const low = classed(els, 'spend-value')[0]
        const [c, d] = drawnAt(label(low), DAY_PX, 'plain')
        if (Math.abs(Number(low.at.y) - baseline) < 1.32 * DAY_PX) assert.ok(b + LABEL_GAP <= c || d + LABEL_GAP <= a, `${at}: on ${low.text}`)
        // No bar drawn after it rises into it; drawn after the columns, over the bars, it has a halo in the card's colour.
        for (const e of els.slice(i + 1))
          if (e.tag === 'rect' && !('aria-label' in e.at)) assert.ok(Number(e.at.y) - Number(e.at['stroke-width'] ?? 0) / 2 >= baseline || Number(e.at.x) + Number(e.at.width) <= a || Number(e.at.x) >= b, `${at}: under a bar at ${e.at.x}`)
        const over = i > els.findLastIndex((e) => e.tag === 'rect' && 'aria-label' in e.at)
        if (over) assert.equal(halo(name, width), 'halo, pointer none', at)
        else assert.ok([undefined, 'none'].includes(painted(name, width, 'stroke')), at)
        const side = name.at.x === String(width) && name.at['text-anchor'] === 'end' ? 'right' : name.at.x === String(GUTTER) && name.at['text-anchor'] === 'start' ? 'left' : `${name.at['text-anchor']} at ${name.at.x}`
        assert.equal(`${side}${over ? ' over' : ''}`, where, at)
      }
  })

  test("the low day's figure is drawn over the later columns where one's bar rises into it, with a halo, and else in its own column as ever", () => {
    // The balance lowest today, a paycheck lifting every later bar, the figure running on over the next column at a
    // phone's width; lowest the third day, a paycheck the day after lifting the bars from the fifth, which its figure
    // reaches at 320 only; the same with nothing more spent, no later bar higher; the demo's shape, the lowest its last
    // day; lowest today again, a paycheck lifting the next days' bars to $274 over where today starts, their tops 2.1 px
    // under the figure's baseline, into its descent. The chart draws two weeks, or through the low day; with numbers
    // hidden a figure draws narrower.
    const early = [0, 2_000, 6_000, ...Array<number>(14).fill(0)]
    for (const [spend, lowest, plain, hiddenToo, descent] of [
      [account('2030-11-11', 3_000, [2_500, ...Array<number>(16).fill(0)], { 0: 20_000 }), 0, [254, 309, 348, 413], [254, 309, 348], false],
      [account('2030-11-11', 10_000, early, { 3: 20_000 }), 2, [254], [], false],
      [account('2030-11-11', 10_000, early), 2, [], [], false],
      [account('2030-11-11', 20_000, falling(3000)), 16, [], [], false],
      [account('2030-11-11', 10_000, [2_500, ...Array<number>(16).fill(0)], { 0: 2_774 }), 0, [254, 309, 348, 413, 612], [254, 309, 348], true]
    ] as const)
      for (const hidden of [false, true]) {
        setNumbersHidden(hidden)
        try {
          for (const width of [254, 309, 348, 413, 612, 924]) {
            const els = chart(spend, width)
            const at = `low on day ${lowest} at ${width}${hidden ? ', hidden' : ''}`
            const i = els.indexOf(classed(els, 'spend-value')[0])
            const low = els[i]
            const [a, b] = drawnAt(label(low), DAY_PX, hidden ? 'hidden' : 'plain')
            const foot = Number(low.at.y) + 0.3 * DAY_PX
            // Each column's elements end with its tab stop; a bar rises into the figure across it, over its foot.
            const ends = els.flatMap((e, j) => (e.tag === 'rect' && 'aria-label' in e.at ? [j] : []))
            const into = (e: Drawn): boolean => e.tag === 'rect' && !('aria-label' in e.at) && e.at.fill !== 'var(--chart-cursor)' && Number(e.at.y) - Number(e.at['stroke-width'] ?? 0) / 2 < foot && Number(e.at.x) + Number(e.at.width) > a && Number(e.at.x) < b
            const reached = els.some((e, j) => j > ends[lowest] && into(e))
            assert.equal(reached, ((hidden ? hiddenToo : plain) as readonly number[]).includes(width), `${at}: a later bar into ${low.text}`)
            // Where the bars reach only its descent: their tops under its baseline, by 1 to 3 px.
            if (descent && reached)
              for (const e of els.slice(ends[lowest] + 1).filter(into)) {
                const under = Number(e.at.y) - Number(e.at['stroke-width'] ?? 0) / 2 - Number(low.at.y)
                assert.ok(under > 1 && under < 3, `${at}: a bar's top ${under} px under ${low.text}'s baseline`)
              }
            // Nothing drawn after it covers it.
            assert.ok(!els.slice(i + 1).some(into), `${at}: a bar over ${low.text}`)
            if (reached) assert.ok(i > ends.at(-1)! && halo(low, width) === 'halo, pointer none', `${at}: ${low.text} at ${i}, ${halo(low, width)}`)
            else {
              assert.ok(i > (ends[lowest - 1] ?? -1) && i < ends[lowest], `${at}: ${low.text} at ${i}, out of its column`)
              assert.ok([undefined, 'none'].includes(painted(low, width, 'stroke')), at)
            }
          }
        } finally {
          setNumbersHidden(false)
        }
      }
  })
})
