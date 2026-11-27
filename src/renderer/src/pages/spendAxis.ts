// Spendable's chart (SpendChart), under each day's column: the day, then what it spends, each label measured as its
// font draws it (plain, or with numbers hidden). Two ways to lay them out, the same test choosing at every width:
//
// As it always drew them: every day's number, or every other day's in a column under NARROW_BAND, a month's
// name on the first day and on the 1st, every figure, each centred under its column. Kept unchanged where all three
// hold: no two labels in the day row, and no two in the figure row, within CLEAN_GAP of each other (touching fails);
// none past the chart's left or right edge; and every figure nearer its own reference than any other day's drawn date
// by more than LEAN, from the figure's middle, its own reference its date's digits where its day is labelled and its
// column's centre where not (a date is where its digits are: a name's, "Nov 11", right of its middle).
//
// Else narrower: every day's number, else every other day's, every third's and so on, LABEL_GAP apart; a month's 1st
// and the first day by name, the name's date over its own column; nothing past the chart's edges. A figure shows only
// under a day whose number or name is drawn, centred under its column or ended at the chart's edge where centred it
// would pass it, never on a day with no label. Every labelled day that spends shows its figure: two numbers' figures
// within LABEL_GAP widen the stride, and a day whose figure would crowd a name's, or read as another labelled day's,
// loses its label. No React and no window here, so the tests place the very labels the chart draws.

export type Anchor = 'start' | 'middle' | 'end'

export interface AxisLabel {
  text: string
  x: number
  anchor: Anchor
}

export interface AxisDay {
  /** YYYY-MM-DD */
  day: string
  /** Its month and date ("Nov 11"), drawn on the first day and on a month's 1st. */
  name: string
  /** What it spends as drawn, or null when it spends nothing. */
  out: string | null
}

/** The chart's width, its gutter, and whether numbers are hidden (lib.ts numbersHidden()). */
export interface AxisAt {
  width: number
  gutter: number
  hidden?: boolean
}

/** Under this a column shows every other day's number at most. */
export const NARROW_BAND = 26
/** The least space between two labels in a row where the chart lays them out narrower. */
export const LABEL_GAP = 3
/** The least space between two labels in a row where the chart draws as it always did. */
export const CLEAN_GAP = 1
/** A figure reads as its own day's only nearer its own reference than any other day's date by more than this. */
export const LEAN = 2
/** The font sizes of a day and of what it spends (styles.css .spend-day, .spend-out). */
export const DAY_PX = 10.5
export const OUT_PX = 10
/** A character's width in the axis's monospace font, as a share of its size. */
const CHAR = 0.6
/** With numbers hidden (styles.css, Hidden Digits) a number, its commas and periods too, draws as one "•••" this wide. */
const HIDDEN_RUN = 1.2
const NUMBER = /(\d(?:[\d,.]*\d)?)/

/** A label's width as it draws: every character 0.6 em, or with numbers hidden each number one 1.2 em glyph. */
export const textWidth = (text: string, px: number, hidden = false): number =>
  (hidden ? text.split(NUMBER).reduce((w, part, i) => w + (i % 2 ? HIDDEN_RUN : part.length * CHAR), 0) : text.length * CHAR) * px

/** A label's left and right. */
export function extent(l: AxisLabel, px: number, hidden = false): [number, number] {
  const w = textWidth(l.text, px, hidden)
  const left = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2
  return [left, left + w]
}

/** Where a day's label reads: a number's middle, a name's date's ("Nov 11", its 11). */
export function dateAt(l: AxisLabel, px: number, hidden = false): number {
  const [left, right] = extent(l, px, hidden)
  const date = /\d+$/.exec(l.text)
  if (!date || date.index === 0) return (left + right) / 2
  return left + textWidth(l.text.slice(0, date.index), px, hidden) + textWidth(date[0], px, hidden) / 2
}

/** Whether a figure this far from another day's date (other) as from its own reference (own) reads as its own: further
 * by more than LEAN, a hair over it too, never exactly. */
const clearOf = (own: number, other: number): boolean => other - own > LEAN + 1e-9

/** The labels a row has drawn so far, so each new one keeps a gap (LABEL_GAP or CLEAN_GAP) from every one of them. */
function row(px: number, hidden: boolean, gap = LABEL_GAP): { fits: (l: AxisLabel) => boolean; take: (l: AxisLabel) => void } {
  const taken: Array<[number, number]> = []
  return {
    fits: (l) => {
      const [a, b] = extent(l, px, hidden)
      return taken.every(([c, d]) => b + gap <= c + 1e-9 || d + gap <= a + 1e-9)
    },
    take: (l) => void taken.push(extent(l, px, hidden))
  }
}

type Axis = { day: Array<AxisLabel | null>; out: Array<AxisLabel | null> }

/** Each day's label and figure, null where it draws none: as the chart always drew them where that reads cleanly, else
 * as many as fit. */
export function axisLabels(days: AxisDay[], { width, gutter, hidden = false }: AxisAt): Axis {
  if (!days.length) return { day: [], out: [] }
  const band = Math.max(0, width - gutter) / days.length
  const old = asEver(days, band, gutter)
  if (readsCleanly(old, { band, width, gutter, hidden })) return old
  let k = band < NARROW_BAND ? 2 : 1
  let r = every(days, k, { band, width, gutter, hidden })
  while (r.crowded && k < days.length) r = every(days, ++k, { band, width, gutter, hidden })
  return { day: r.day, out: r.out }
}

/** The labels as the chart always drew them: every day's number, or every other day's in a column under NARROW_BAND, a
 * month's name on the first day and the 1st, and every figure, each centred under its column. */
function asEver(days: AxisDay[], band: number, gutter: number): Axis {
  const every = band < NARROW_BAND ? 2 : 1
  const cx = (i: number): number => gutter + band * i + band / 2
  return {
    day: days.map((d, i) => (i === 0 || d.day.endsWith('-01') ? { text: d.name, x: cx(i), anchor: 'middle' as const } : i % every ? null : { text: String(Number(d.day.slice(8))), x: cx(i), anchor: 'middle' as const })),
    out: days.map((d, i) => (d.out ? { text: d.out, x: cx(i), anchor: 'middle' as const } : null))
  }
}

/** Whether the labels as the chart always drew them read cleanly: no two in a row within CLEAN_GAP, none past the
 * chart's edges, and every figure nearer its own reference, its date where its day is labelled and else its column's
 * centre, than any other day's date by more than LEAN. */
function readsCleanly({ day, out }: Axis, { band, width, gutter, hidden }: Required<AxisAt> & { band: number }): boolean {
  for (const [labels, px] of [
    [day, DAY_PX],
    [out, OUT_PX]
  ] as const) {
    const r = row(px, hidden, CLEAN_GAP)
    for (const l of labels) {
      if (!l) continue
      const [a, b] = extent(l, px, hidden)
      if (a < -1e-9 || b > width + 1e-9 || !r.fits(l)) return false
      r.take(l)
    }
  }
  const dates = day.map((l) => (l ? dateAt(l, DAY_PX, hidden) : null))
  return out.every((f, i) => {
    if (!f) return true
    const [a, b] = extent(f, OUT_PX, hidden)
    const mid = (a + b) / 2
    const own = Math.abs(mid - (dates[i] ?? gutter + band * i + band / 2))
    return dates.every((x, j) => x === null || j === i || clearOf(own, Math.abs(mid - x)))
  })
}

/** The labels with every k-th day's number; crowded when two of those days' numbers or figures don't fit. */
function every(days: AxisDay[], k: number, { band, width, gutter, hidden }: Required<AxisAt> & { band: number }): Axis & { crowded: boolean } {
  const n = days.length
  const left = (i: number): number => gutter + band * i
  const right = (i: number): number => gutter + band * (i + 1)
  const cx = (i: number): number => left(i) + band / 2
  const isFirst = (i: number): boolean => i > 0 && days[i].day.endsWith('-01')
  const number = (i: number): string => String(Number(days[i].day.slice(8)))
  const day: Array<AxisLabel | null> = Array(n).fill(null)
  const out: Array<AxisLabel | null> = Array(n).fill(null)
  let crowded = false

  /** Centred under its column, or against the chart's edge where centred it would pass it. */
  const under = (text: string, px: number, i: number): AxisLabel => {
    const half = textWidth(text, px, hidden) / 2
    if (cx(i) + half > width) return { text, x: width, anchor: 'end' }
    if (cx(i) - half < 0) return { text, x: 0, anchor: 'start' }
    return { text, x: cx(i), anchor: 'middle' }
  }
  /** A name where its date stays over its column, inside the chart: centred, else ending at the column's right edge,
   * else with its date centred on the column, else with its date's middle on the column's left edge (out over the
   * gutter on the first day, over the days before on a 1st). */
  const named = (i: number): AxisLabel[] => {
    const text = days[i].name
    const date = textWidth(/\d+$/.exec(text)?.[0] ?? '', DAY_PX, hidden)
    const options: AxisLabel[] = [
      { text, x: cx(i), anchor: 'middle' },
      { text, x: right(i), anchor: 'end' },
      { text, x: cx(i) + date / 2, anchor: 'end' },
      { text, x: left(i) + date / 2, anchor: 'end' }
    ]
    return options.filter((l) => {
      const [a, b] = extent(l, DAY_PX, hidden)
      const at = dateAt(l, DAY_PX, hidden)
      return a >= -1e-9 && b <= width + 1e-9 && at >= left(i) - 1e-9 && at <= right(i) + 1e-9
    })
  }

  // A month's 1st by name, then the first day's (where centred it would crowd the next number, out over the gutter as
  // far as its date allows, so a 1st two days on leaves it room; else its number, else nothing), then every k-th day's
  // number: a number that crowds a name goes, one that crowds a number means the stride is too short.
  const names = row(DAY_PX, hidden)
  const numbers = row(DAY_PX, hidden)
  for (let i = 1; i < n; i++)
    if (isFirst(i)) {
      const l = named(i).find((o) => names.fits(o))
      if (l) {
        names.take(l)
        day[i] = l
      }
    }
  const next = Array.from({ length: Math.ceil(n / k) }, (_, j) => j * k).find((i) => i > 0 && !isFirst(i))
  const nextLabel = next === undefined ? null : under(number(next), DAY_PX, next)
  const firstOptions = [...named(0), under(number(0), DAY_PX, 0)]
  const clearOfNext = (l: AxisLabel): boolean => {
    if (!nextLabel || !names.fits(nextLabel)) return true
    const [a, b] = extent(l, DAY_PX, hidden)
    const [c] = extent(nextLabel, DAY_PX, hidden)
    return b + LABEL_GAP <= c && a >= 0
  }
  const first = firstOptions.find((l) => names.fits(l) && clearOfNext(l)) ?? firstOptions.find((l) => names.fits(l) && extent(l, DAY_PX, hidden)[0] >= 0)
  if (first) {
    names.take(first)
    day[0] = first
  }
  for (let i = k; i < n; i += k) {
    if (isFirst(i)) continue
    const l = under(number(i), DAY_PX, i)
    if (!numbers.fits(l)) crowded = true
    else if (names.fits(l)) {
      numbers.take(l)
      day[i] = l
    }
  }

  // Figures, each only under its own day's drawn label, centred under its column or ended at the chart's edge where
  // centred it would pass it: a name's first, a month's 1st's then the first day's, then a number's (one that crowds
  // another number's means the stride is too short). A figure reads as its day's only nearer its date than any other
  // label's by more than LEAN, as one ended at the chart's edge may not be: a label nearer a name's figure goes, a
  // number as one crowding a name does and the first day's beside a 1st's, and one nearer a number's figure goes where
  // it is a number over no figure. A day whose figure doesn't fit, or would read as another labelled day's, loses its
  // label too, as a label over no figure reads as spending nothing. A day with no label shows no figure.
  /** The other labels whose dates a figure under day i is no further from than LEAN past its own date. */
  const nearer = (l: AxisLabel, i: number): number[] => {
    const [a, b] = extent(l, OUT_PX, hidden)
    const mid = (a + b) / 2
    const own = Math.abs(mid - dateAt(day[i]!, DAY_PX, hidden))
    return day.flatMap((d, j) => (d && j !== i && !clearOf(own, Math.abs(mid - dateAt(d, DAY_PX, hidden))) ? [j] : []))
  }
  /** A number over no figure: a day after the first, not a 1st, that spends nothing. */
  const bare = (j: number): boolean => j > 0 && !isFirst(j) && !days[j].out
  const inside = (l: AxisLabel): boolean => {
    const [a, b] = extent(l, OUT_PX, hidden)
    return a >= -1e-9 && b <= width + 1e-9
  }
  const atNames = row(OUT_PX, hidden)
  const withNames = [...days.keys()].filter((i) => i > 0 && isFirst(i)).concat(0)
  for (const i of withNames)
    if (days[i].out && day[i]) {
      const l = under(days[i].out!, OUT_PX, i)
      const near = nearer(l, i)
      if (inside(l) && atNames.fits(l) && (i > 0 || !near.some(isFirst))) {
        for (const j of near) day[j] = null
        atNames.take(l)
        out[i] = l
      } else day[i] = null
    }
  const atNumbers = row(OUT_PX, hidden)
  for (let i = 1; i < n; i++)
    if (days[i].out && day[i] && !isFirst(i)) {
      const l = under(days[i].out!, OUT_PX, i)
      const near = nearer(l, i)
      if (!atNumbers.fits(l)) crowded = true
      else if (inside(l) && atNames.fits(l) && near.every(bare)) {
        for (const j of near) day[j] = null
        atNumbers.take(l)
        out[i] = l
      } else day[i] = null
    }
  return { day, out, crowded }
}

/** A label's top and bottom about its baseline, as shares of its size (the axis font's ascent and descent). */
const ASCENT = 1.02
const DESCENT = 0.3

/** A column's bars: their left, right and top. */
export interface Bar {
  left: number
  right: number
  top: number
}

/** Whether a bar rises into a label (DAY_PX; y its baseline): one across it whose top is over the label's foot. */
export function barsInto(l: AxisLabel & { y: number }, bars: Bar[], hidden = false): boolean {
  const [a, b] = extent(l, DAY_PX, hidden)
  return bars.some((bar) => bar.top < l.y + DESCENT * DAY_PX && bar.right > a && bar.left < b)
}

/** Where the cushion line's name goes (both DAY_PX; y is a label's baseline): over the line's right end as ever, else
 * its left past the gutter, where neither the low day's figure sits on it nor a bar drawn after it rises into it; else
 * the first of those the figure leaves clear, drawn over the bars (over); else none. */
export function cushionLabel(text: string, y: number, low: (AxisLabel & { y: number }) | null, bars: Bar[], { width, gutter, hidden = false }: AxisAt): (AxisLabel & { over: boolean }) | null {
  const options: AxisLabel[] = [
    { text, x: width, anchor: 'end' },
    { text, x: gutter, anchor: 'start' }
  ]
  const clearOfLow = (l: AxisLabel): boolean => {
    if (!low || Math.abs(low.y - y) >= (ASCENT + DESCENT) * DAY_PX) return true
    const [a, b] = extent(l, DAY_PX, hidden)
    const [c, d] = extent(low, DAY_PX, hidden)
    return b + LABEL_GAP <= c || d + LABEL_GAP <= a
  }
  const clearOfBars = (l: AxisLabel): boolean => {
    const [a, b] = extent(l, DAY_PX, hidden)
    return bars.every((bar) => bar.top >= y || bar.right <= a || bar.left >= b)
  }
  const clear = options.find((l) => clearOfLow(l) && clearOfBars(l))
  if (clear) return { ...clear, over: false }
  const over = options.find(clearOfLow)
  return over ? { ...over, over: true } : null
}
