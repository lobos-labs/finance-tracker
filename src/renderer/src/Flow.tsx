import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { dollars } from './pages/homeView'

// Home's waterfall drawn as a Sankey or walked as a waterfall (spec Decision 2): where the money came from and where
// it went. Both charts draw what homeView.ts builds from the rows, sankeyFlow and walkSteps, and do no sums of their own.

export type FlowKind = 'job' | 'match' | 'pool' | 'saving' | 'tax' | 'benefit' | 'spend' | 'left' | 'short'

export interface FlowNode {
  name: string
  /** what flows through it, the height of its band */
  cents: number
  kind: FlowKind
  /** its column, counted from where the money starts; every link runs to a later column */
  column: number
  /** the header over the node's column */
  stage?: string
  /** nodes sharing a group stay together in their column, under the group's name */
  group?: string
  /** where the node sits in its column: lower ranks above higher ones; 1 when unset */
  rank?: number
  /** what the node is made of (other income, payer by payer); opened, they stand in its place */
  parts?: Array<{ name: string; cents: number }>
  /** on a part: the key of the node it's part of */
  of?: string
  /** starts open in the chart */
  open?: boolean
  /** the figure its label shows, when that isn't what flows through it: its row as the rows show it */
  shownCents?: number
  /** what tells it from another node of its kind and name: Savings or credit paid back, beside Savings or credit drawn on */
  id?: string
}

export interface FlowData {
  nodes: FlowNode[]
  links: Array<{ source: number; target: number; value: number }>
}

const FLOW_COLOR: Record<FlowKind, string> = {
  job: 'var(--chart-teal)',
  match: 'var(--teal-400)',
  pool: 'var(--chart-teal)',
  saving: 'var(--teal-400)',
  tax: 'var(--chart-slate)',
  benefit: 'var(--chart-plum)',
  spend: 'var(--chart-copper)',
  left: 'var(--chart-muted)',
  short: 'var(--neg)'
}

/** Drops nodes nothing flows through (a row with no amount; they'd break the layout) and sizes each node by its flow. */
function prune(data: FlowData): FlowData {
  const into = new Map<number, number>()
  const out = new Map<number, number>()
  for (const l of data.links) {
    into.set(l.target, (into.get(l.target) ?? 0) + l.value)
    out.set(l.source, (out.get(l.source) ?? 0) + l.value)
  }
  const remap = new Map<number, number>()
  const kept: FlowNode[] = []
  data.nodes.forEach((n, i) => {
    if (!into.has(i) && !out.has(i)) return
    remap.set(i, kept.length)
    kept.push({ ...n, cents: Math.max(into.get(i) ?? 0, out.get(i) ?? 0) })
  })
  return { nodes: kept, links: data.links.map((l) => ({ source: remap.get(l.source)!, target: remap.get(l.target)!, value: l.value })) }
}

// ---------- layout ----------

const NODE_WIDTH = 8
const NODE_PADDING = 16
/** More room between nodes for each one whose label is in two lines, its name above its figure */
const TALL_GAP = 7
/** room for a group's name above its first node */
const GROUP_GAP = 32
const HEADER_H = 30
const MARGIN_Y = 12
const LABEL_GAP = 6
/** Room after a label before the next column's nodes */
const LABEL_END = 4
/** The shortest a band between two columns gets */
const BAND_MIN = 24
/** Widest a name in the outer margins gets, so one long payee can't squeeze the columns between */
const NAME_MAX = 220
/** A figure's width a character: the mono face at 10.5px */
const FIGURE_CHAR = 6.3
/** A hub's open or closed sign beside its label */
const SIGN_WIDTH = 13
/** A column header's width a character: the mono face at 10.5px, spaced 0.18em */
const HEADER_CHAR = 10.5 * 0.78

/** Each node's column, the ones nothing is left in closed up. */
function columnOf(data: FlowData): number[] {
  const used = [...new Set(data.nodes.map((n) => n.column))].sort((a, b) => a - b)
  return data.nodes.map((n) => used.indexOf(n.column))
}

/** True when the node opens a group: the first of its column, or after a node of another group. */
const opensGroup = (data: FlowData, col: number[], k: number): boolean => {
  const g = data.nodes[col[k]].group
  return !!g && (k === 0 || data.nodes[col[k - 1]].group !== g)
}

interface PlacedNode extends FlowNode {
  x: number
  y: number
  h: number
  /** in the first column: labeled on the left */
  first: boolean
}

interface PlacedLink {
  d: string
  width: number
  kind: FlowKind
}

interface Placed {
  nodes: PlacedNode[]
  links: PlacedLink[]
  headers: Array<{ x: number; text: string; first: boolean }>
  /** a group's name over its block; a block of parts names the node they stand in for, and closes it */
  groups: Array<{ x: number; y: number; text: string; first: boolean; of?: string }>
}

/** The header over each column: the stage its money is mostly in. */
function headersOf(data: FlowData, depth: number[]): Array<string | undefined> {
  const last = Math.max(0, ...depth)
  return Array.from({ length: last + 1 }, (_, c) => {
    const cents = new Map<string, number>()
    data.nodes.forEach((n, i) => depth[i] === c && n.stage && cents.set(n.stage, (cents.get(n.stage) ?? 0) + n.cents))
    return [...cents].sort((a, b) => b[1] - a[1])[0]?.[0]
  })
}

/**
 * Lays the flow out below a header row, each column at its x. Every column is stacked in order and centered on the
 * box's middle, so all columns share one midline. Each column is ordered by rank, then so links cross as little as
 * possible and run as straight as they can (the barycenter heuristic for layered graphs): sweep left to right and
 * back, sorting each column by the value-weighted height of what its nodes connect to, and keep the order with the
 * least vertical travel. Ties keep the order the nodes were built in: spending stays biggest first, with what's left
 * over last. A node whose label is in two lines (`tall`) keeps more room from its neighbors.
 */
function layout(data: FlowData, depth: number[], xs: number[], height: number, tall: boolean[]): Placed {
  const n = data.nodes.length
  const none: Placed = { nodes: [], links: [], headers: [], groups: [] }
  if (!n) return none
  type Edge = { other: number; w: number }
  const ins: Edge[][] = data.nodes.map(() => [])
  const outs: Edge[][] = data.nodes.map(() => [])
  for (const l of data.links) {
    outs[l.source].push({ other: l.target, w: l.value })
    ins[l.target].push({ other: l.source, w: l.value })
  }
  const last = Math.max(...depth)
  let columns: number[][] = Array.from({ length: last + 1 }, () => [])
  data.nodes.forEach((_, i) => columns[depth[i]].push(i))

  // The space above each node in its column: a group's name needs more than the usual padding, and so does a label in
  // two lines on either side.
  const gap = (col: number[], k: number): number => (opensGroup(data, col, k) ? GROUP_GAP : k ? NODE_PADDING + (tall[col[k - 1]] ? TALL_GAP : 0) + (tall[col[k]] ? TALL_GAP : 0) : 0)
  const gaps = (col: number[]): number => col.reduce((t, _, k) => t + gap(col, k), 0)

  // One scale for every column, set by the one that needs the most room.
  const top0 = HEADER_H + MARGIN_Y
  const inner = height - top0 - MARGIN_Y
  const fit = columns.map((c) => (c.length ? (inner - gaps(c)) / (c.reduce((t, i) => t + data.nodes[i].cents, 0) || 1) : Infinity))
  const scale = Math.min(...fit)
  /** the column that fills the box; the others settle around it */
  const anchor = fit.indexOf(scale)
  const h = data.nodes.map((node) => node.cents * scale)
  const top: number[] = new Array(n).fill(0)
  const mid = (i: number): number => top[i] + h[i] / 2
  const stack = (col: number[]): void => {
    let y = top0 + (inner - (col.reduce((t, i) => t + h[i], 0) + gaps(col))) / 2
    col.forEach((i, k) => {
      y += gap(col, k)
      top[i] = y
      y += h[i]
    })
  }
  columns.forEach(stack)

  if (n > 2) {
    const travel = (): number => data.links.reduce((t, l) => t + l.value * Math.abs(mid(l.source) - mid(l.target)), 0)
    const rank = (i: number): number => data.nodes[i].rank ?? 1
    // Within rounding, it's a tie: (w·y)/w isn't always exactly y.
    const byAt = (a: { at: number; k: number }, b: { at: number; k: number }): number => (Math.abs(a.at - b.at) > 1e-6 ? a.at - b.at : a.k - b.k)
    const sortBy = (c: number, side: Edge[][]): void => {
      const keyed = columns[c].map((i, k) => {
        const w = side[i].reduce((t, e) => t + e.w, 0)
        return { i, k, at: w ? side[i].reduce((t, e) => t + e.w * mid(e.other), 0) / w : mid(i) }
      })
      // A group moves as one block, at its members' value-weighted height; inside, members keep their own order.
      const units = new Map<string, { rank: number; at: number; k: number; members: typeof keyed }>()
      for (const x of keyed) {
        const key = data.nodes[x.i].group ? `group:${data.nodes[x.i].group}` : `node:${x.i}`
        const u = units.get(key) ?? { rank: rank(x.i), at: 0, k: x.k, members: [] }
        u.members.push(x)
        units.set(key, u)
      }
      for (const u of units.values()) {
        const w = u.members.reduce((t, x) => t + data.nodes[x.i].cents, 0)
        u.at = w ? u.members.reduce((t, x) => t + data.nodes[x.i].cents * x.at, 0) / w : u.members[0].at
        u.k = Math.min(...u.members.map((x) => x.k))
        u.members.sort(byAt)
      }
      columns[c] = [...units.values()].sort((a, b) => a.rank - b.rank || byAt(a, b)).flatMap((u) => u.members.map((x) => x.i))
      stack(columns[c])
    }
    let best = { travel: travel(), columns: columns.map((c) => [...c]) }
    for (let sweep = 0; sweep < 12; sweep++) {
      for (let c = 1; c <= last; c++) sortBy(c, ins)
      for (let c = last - 1; c >= 0; c--) sortBy(c, outs)
      const t = travel()
      if (t < best.travel - 1e-6) best = { travel: t, columns: columns.map((c) => [...c]) }
    }
    columns = best.columns
    columns.forEach(stack)
  }

  // A node's links leave and arrive stacked in the order of the nodes at their other ends, so they don't cross at the node.
  const w = data.links.map((l) => l.value * scale)
  const leaving: number[][] = data.nodes.map(() => [])
  const arriving: number[][] = data.nodes.map(() => [])
  data.links.forEach((l, k) => {
    leaving[l.source].push(k)
    arriving[l.target].push(k)
  })
  const reorder = (): void =>
    data.nodes.forEach((_, i) => {
      leaving[i].sort((a, b) => mid(data.links[a].target) - mid(data.links[b].target))
      arriving[i].sort((a, b) => mid(data.links[a].source) - mid(data.links[b].source))
    })

  // The column that fills the box holds still. Columns to its left settle toward where their money goes,
  // columns to its right toward where it comes from: each node moves to where its links would run flat,
  // measured where they leave or reach the node at the other end (d3-sankey's relaxation, with its
  // targetTop and sourceTop). When nodes then overlap, the heaviest holds its place and the lighter ones
  // move around it, so a small node can't push the main flow aside.
  const targetTop = (k: number): number => {
    const { source: s, target: t } = data.links[k]
    let y = top[s] - ((leaving[s].length - 1) * NODE_PADDING) / 2
    for (const j of leaving[s]) {
      if (j === k) break
      y += w[j] + NODE_PADDING
    }
    for (const j of arriving[t]) {
      if (j === k) break
      y -= w[j]
    }
    return y
  }
  const sourceTop = (k: number): number => {
    const { source: s, target: t } = data.links[k]
    let y = top[t] - ((arriving[t].length - 1) * NODE_PADDING) / 2
    for (const j of arriving[t]) {
      if (j === k) break
      y += w[j] + NODE_PADDING
    }
    for (const j of leaving[s]) {
      if (j === k) break
      y -= w[j]
    }
    return y
  }
  const resolve = (col: number[]): void => {
    if (!col.length) return
    let a = 0
    col.forEach((i, k) => h[i] > h[col[a]] && (a = k))
    for (let k = a - 1; k >= 0; k--) top[col[k]] = Math.min(top[col[k]], top[col[k + 1]] - gap(col, k + 1) - h[col[k]])
    for (let k = a + 1; k < col.length; k++) top[col[k]] = Math.max(top[col[k]], top[col[k - 1]] + h[col[k - 1]] + gap(col, k))
    // Then keep the column inside the box.
    let y = top0
    col.forEach((i, k) => {
      top[i] = Math.max(top[i], y + gap(col, k))
      y = top[i] + h[i]
    })
    y = height - MARGIN_Y
    for (let k = col.length - 1; k >= 0; k--) {
      top[col[k]] = Math.min(top[col[k]], y - h[col[k]])
      y = top[col[k]] - gap(col, k)
    }
  }
  const settle = (c: number, alpha: number): void => {
    for (const i of columns[c]) {
      const toSources: [number[], (k: number) => number] = [arriving[i], targetTop]
      const toTargets: [number[], (k: number) => number] = [leaving[i], sourceTop]
      const [ks, at] = c < anchor ? (leaving[i].length ? toTargets : toSources) : arriving[i].length ? toSources : toTargets
      const total = ks.reduce((t, k) => t + w[k], 0)
      if (total) top[i] += (ks.reduce((t, k) => t + w[k] * at(k), 0) / total - top[i]) * alpha
    }
    resolve(columns[c])
    reorder()
  }
  reorder()
  for (let pass = 0, alpha = 1; pass < 32; pass++, alpha *= 0.94) {
    for (let c = anchor - 1; c >= 0; c--) settle(c, alpha)
    for (let c = anchor + 1; c <= last; c++) settle(c, alpha)
  }

  // Only the first column is labeled on the left; a source placed further in is labeled on its right like its neighbors.
  const nodes: PlacedNode[] = data.nodes.map((node, i) => ({ ...node, x: xs[depth[i]], y: top[i], h: h[i], first: depth[i] === 0 }))

  const headers: Placed['headers'] = []
  headersOf(data, depth).forEach((text, c) => text && headers.push({ x: xs[c], text, first: c === 0 }))
  const groups: Placed['groups'] = []
  for (const col of columns)
    col.forEach((i, k) => opensGroup(data, col, k) && groups.push({ x: xs[depth[i]], y: top[i] - 9, text: data.nodes[i].group!, first: depth[i] === 0, of: data.nodes[i].of }))

  const y0: number[] = new Array(data.links.length).fill(0)
  const y1: number[] = new Array(data.links.length).fill(0)
  reorder()
  data.nodes.forEach((_, i) => {
    let y = top[i]
    for (const k of leaving[i]) {
      y0[k] = y + w[k] / 2
      y += w[k]
    }
    y = top[i]
    for (const k of arriving[i]) {
      y1[k] = y + w[k] / 2
      y += w[k]
    }
  })
  const links = data.links.map((l, k) => {
    const from = nodes[l.source].x + NODE_WIDTH
    const to = nodes[l.target].x
    const bend = (from + to) / 2
    const kind = data.nodes[l.source].kind === 'short' ? 'short' : data.nodes[l.target].kind
    return { d: `M${from},${y0[k]}C${bend},${y0[k]} ${bend},${y1[k]} ${to},${y1[k]}`, width: w[k], kind }
  })
  return { nodes, links, headers, groups }
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

const MONO = "'JetBrains Mono Variable', ui-monospace, monospace"

/** A node's identity across redraws; a part is known by what it's part of. */
const keyOf = (n: FlowNode): string => (n.of ? `${n.of}>${n.name}` : `${n.kind}:${n.id ?? n.name}`)

const opens = (n: FlowNode): boolean => !!n.parts && n.parts.length > 1

/** An opened node with parts gives way to them, in the same column, each carrying its share of the node's flow and labeled its own amount. */
function expand(data: FlowData, open: ReadonlySet<string>): FlowData {
  const nodes = [...data.nodes]
  let links = data.links
  data.nodes.forEach((n, i) => {
    if (!opens(n) || !open.has(keyOf(n))) return
    const total = n.parts!.reduce((t, p) => t + p.cents, 0) || 1
    const mine = links.filter((l) => l.source === i)
    links = links.filter((l) => l.source !== i)
    for (const p of n.parts!) {
      const j = nodes.push({ name: p.name, cents: 0, kind: n.kind, column: n.column, stage: n.stage, rank: n.rank, group: n.name, of: keyOf(n), shownCents: p.cents }) - 1
      links = [...links, ...mine.map((l) => ({ source: j, target: l.target, value: (l.value * p.cents) / total }))]
    }
  })
  return { nodes, links }
}

/**
 * The flow as drawn: a node money flows through (a hub) shows what's past it only once opened, so a closed hub ends
 * its flow, and an opened node with parts shows them instead. Returns the visible flow, with what each visible node
 * opens (its key, or null) and whether it's open. Each node keeps the figure sankeyFlow gave it, so a node a closed hub
 * leaves partly fed still reads its whole row.
 */
function drill(full: FlowData, open: ReadonlySet<string>): { data: FlowData; toggle: Array<string | null>; open: boolean[] } {
  const data = expand(full, open)
  const hasIn = new Set(data.links.map((l) => l.target))
  const hasOut = new Set(data.links.map((l) => l.source))
  const hubOf = (i: number): boolean => hasIn.has(i) && hasOut.has(i)
  const isOpen = (i: number): boolean => open.has(keyOf(data.nodes[i]))
  // Closing a hub hides what's past it, and what's past that, until nothing flows in any more. Savings or credit only
  // adds to what the chain brings: what it meets shows while the rest of what pays for it does, and none of it while
  // Take-home is closed.
  const pool = data.nodes.findIndex((n) => n.kind === 'pool')
  const shut = (i: number): boolean => (hubOf(i) && !isOpen(i)) || (data.nodes[i].kind === 'short' && pool >= 0 && !isOpen(pool))
  const hidden = new Set<number>()
  const live = (i: number): boolean => !hidden.has(i) && !shut(i)
  for (let changed = true; changed; ) {
    changed = false
    data.nodes.forEach((_, t) => {
      if (hidden.has(t)) return
      const from = data.links.filter((l) => l.target === t).map((l) => l.source)
      const chain = from.filter((s) => data.nodes[s].kind !== 'short')
      if (!from.length || (chain.length ? chain : from).some(live)) return
      hidden.add(t)
      changed = true
    })
  }
  const links = data.links.filter((l) => live(l.source) && !hidden.has(l.target))
  const shown = prune({ nodes: data.nodes, links })
  const index = new Map(data.nodes.map((n, i) => [keyOf(n), i]))
  const back = shown.nodes.map((n) => index.get(keyOf(n))!)
  return { data: shown, toggle: back.map((i) => (hubOf(i) || opens(data.nodes[i]) ? keyOf(data.nodes[i]) : null)), open: back.map(isOpen) }
}

/** The narrowest the Sankey is drawn: its columns with their labels between. */
const SANKEY_MIN = 560

/** A node's label as drawn: its name (cut short only when nothing else gives it room), its figure and a hub's sign, beside each other or the name above. */
export interface SankeyLabel {
  x: number
  /** the middle of the node it labels */
  y: number
  anchor: 'start' | 'end'
  name: string
  figure: string
  sign: '+' | '−' | null
  /** the name above the figure */
  stacked: boolean
  /** its box, for keeping labels apart */
  box: { x: number; y: number; w: number; h: number }
}

/** The Sankey as drawn in a box of a width, from the flow and the nodes open in it. */
export interface DrawnSankey {
  width: number
  height: number
  nodes: Array<PlacedNode & { key: string; toggle: string | null; open: boolean; label: SankeyLabel }>
  links: PlacedLink[]
  headers: Placed['headers']
  groups: Array<Placed['groups'][number] & { figure: string; box: SankeyLabel['box'] }>
}

/**
 * The Sankey laid out in a box of a width: which nodes show (drill), each column's x, and each label. The outer
 * margins hold the first and last columns' labels; the room between columns goes where the labels need it, a band
 * at least BAND_MIN long. When it all won't fit on one line each, the widest labels put their names above their
 * figures, and their nodes keep more room from their neighbors; only in a box too narrow even for that is a name cut.
 */
export function drawSankey(full: FlowData, open: ReadonlySet<string>, box: number): DrawnSankey {
  const shown = drill(full, open)
  const data = shown.data
  const n = data.nodes.length
  const width = Math.max(box, SANKEY_MIN)
  const depth = columnOf(data)
  const last = Math.max(0, ...depth)
  const headers = headersOf(data, depth)
  const fullOf = new Map(full.nodes.map((nd) => [keyOf(nd), nd]))
  const figure = (nd: FlowNode | undefined): string => (nd ? dollars(nd.shownCents ?? nd.cents) : '')
  const sign = shown.toggle.map((t, i) => (t ? (shown.open[i] ? '−' : '+') : null))
  const nameW = data.nodes.map((nd) => Math.min(textWidth(nd.name, 12), NAME_MAX))
  const figureW = data.nodes.map((nd) => figure(nd).length * FIGURE_CHAR)
  const signW = sign.map((s) => (s ? SIGN_WIDTH : 0))
  const plain = data.nodes.map((_, i) => nameW[i] + 6 + figureW[i] + signW[i])
  const stackedW = data.nodes.map((_, i) => Math.max(nameW[i] + signW[i], figureW[i]))
  // A group's name carries the figure of the node its parts stand in for, and the sign that closes it.
  const groupW = (nd: FlowNode): number => (nd.group ? Math.min(textWidth(nd.group, 11), NAME_MAX) + 6 + figure(nd.of ? fullOf.get(nd.of) : undefined).length * FIGURE_CHAR + (nd.of ? SIGN_WIDTH : 0) : 0)
  const headerW = (c: number): number => (headers[c]?.length ?? 0) * HEADER_CHAR
  const inColumn = (c: number): number[] => data.nodes.flatMap((_, i) => (depth[i] === c ? [i] : []))
  // The margins hold the first and last columns' labels; between column c and the next go its labels (the first
  // column's are in the margin), its header, and a band.
  const tall: boolean[] = new Array(n).fill(false)
  const labelW = (i: number): number => (tall[i] ? stackedW[i] : plain[i])
  const outer = (c: number): number => Math.max(headerW(c), ...inColumn(c).map((i) => Math.max(labelW(i), groupW(data.nodes[i])))) + LABEL_GAP + 4
  const between = (c: number): number => (c ? Math.max(BAND_MIN, headerW(c), ...inColumn(c).map(labelW)) + LABEL_GAP + LABEL_END : BAND_MIN) + NODE_WIDTH
  const gapsNeeded = (): number[] => Array.from({ length: last }, (_, c) => between(c))
  const total = (): number => outer(0) + (last ? outer(last) : 0) + NODE_WIDTH + gapsNeeded().reduce((t, g) => t + g, 0)
  while (total() > width) {
    let widest = -1
    data.nodes.forEach((_, i) => !tall[i] && plain[i] > stackedW[i] && (widest < 0 || plain[i] > plain[widest]) && (widest = i))
    if (widest < 0) break
    tall[widest] = true
  }
  const left = outer(0)
  const right = last ? outer(last) : 0
  const avail = width - left - right - NODE_WIDTH
  const needs = gapsNeeded()
  const sum = needs.reduce((t, g) => t + g, 0)
  // What's left over widens every gap alike; a box too narrow for even the shortest labels squeezes them alike.
  const gaps = needs.map((g) => (sum <= avail ? g + (avail - sum) / last : (g * avail) / sum))
  const xs = [left]
  for (const g of gaps) xs.push(xs[xs.length - 1] + g)
  const room = (i: number): number => (depth[i] === 0 ? left : depth[i] === last ? right : gaps[depth[i]] - NODE_WIDTH - LABEL_END) - LABEL_GAP
  // With the gaps set, a name goes above its figure only where it still won't fit beside it.
  data.nodes.forEach((_, i) => (tall[i] = plain[i] > room(i)))
  // Tall enough for the busiest column to keep its labels apart: a line a node, half again for one in two lines, and
  // one for each group's name.
  const rowsIn = (c: number): number => inColumn(c).reduce((t, i) => t + (tall[i] ? 1.5 : 1), 0) + new Set(inColumn(c).flatMap((i) => data.nodes[i].group ?? [])).size
  const height = HEADER_H + Math.max(300, ...Array.from({ length: last + 1 }, (_, c) => rowsIn(c) * 30))
  const placed = layout(data, depth, xs, height, tall)

  const nodes = placed.nodes.map((nd, i) => {
    const x = nd.first ? nd.x - LABEL_GAP : nd.x + NODE_WIDTH + LABEL_GAP
    const y = nd.y + nd.h / 2
    const anchor = nd.first ? ('end' as const) : ('start' as const)
    const name = fit(nd.name, tall[i] ? room(i) - signW[i] : room(i) - 6 - figureW[i] - signW[i], 12)
    const w = tall[i] ? Math.max(textWidth(name, 12) + signW[i], figureW[i]) : textWidth(name, 12) + 6 + figureW[i] + signW[i]
    const label: SankeyLabel = { x, y, anchor, name, figure: figure(nd), sign: sign[i], stacked: tall[i], box: { x: nd.first ? x - w : x, y: tall[i] ? y - 15 : y - 8, w, h: tall[i] ? 28 : 15 } }
    return { ...nd, key: keyOf(nd), toggle: shown.toggle[i], open: shown.open[i], label }
  })
  const groups = placed.groups.map((g) => {
    const f = figure(g.of ? fullOf.get(g.of) : undefined)
    const w = Math.min(textWidth(g.text, 11), NAME_MAX) + 6 + f.length * FIGURE_CHAR + (g.of ? SIGN_WIDTH : 0)
    const x = g.first ? g.x - LABEL_GAP : g.x + NODE_WIDTH + LABEL_GAP
    return { ...g, figure: f, box: { x: g.first ? x - w : x, y: g.y - 9, w, h: 12 } }
  })
  return { width, height, nodes, links: placed.links, headers: placed.headers, groups }
}

/** The nodes the Sankey opens with: the subtotals, showing where the money went, and Take-home's sources when it stands alone. */
export const opensWith = (data: FlowData): string[] => data.nodes.filter((n) => n.open).map(keyOf)

/** The open nodes after a hub or a node with parts is clicked: opened, or closed with everything past it it opened. */
export function toggled(data: FlowData, open: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(open)
  const i = data.nodes.findIndex((n) => keyOf(n) === key)
  if (!next.has(key)) next.add(key)
  else if (i < 0 || opens(data.nodes[i])) next.delete(key)
  else {
    const past = new Set([i])
    for (let changed = true; changed; ) {
      changed = false
      for (const l of data.links) if (past.has(l.source) && !past.has(l.target)) (past.add(l.target), (changed = true))
    }
    for (const j of past) next.delete(keyOf(data.nodes[j]))
  }
  return next
}

/** What makes a hub a button, by mouse or keyboard (Enter or Space), named for what it is and its figure. */
export function hubProps(key: string, expanded: boolean, label: string, toggle: (key: string) => void): Record<string, unknown> {
  return {
    className: 'flow-hub',
    role: 'button',
    tabIndex: 0,
    'aria-expanded': expanded,
    'aria-label': label,
    onClick: () => toggle(key),
    onKeyDown: (e: Pick<KeyboardEvent, 'key' | 'preventDefault'>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      toggle(key)
    }
  }
}

/** Home's Sankey: the nodes and links sankeyFlow gives, laid out; a hub opens and closes what's past it, by mouse or keyboard. */
export function FlowChart({ data }: { data: FlowData }): ReactNode {
  const [ref, box] = useWidth()
  // Nodes that turn up later, in another span, open too.
  const starts = opensWith(data)
  const [open, setOpen] = useState<Set<string>>(() => new Set(starts))
  const [seen, setSeen] = useState(starts.join('|'))
  if (starts.join('|') !== seen) {
    setSeen(starts.join('|'))
    setOpen(new Set([...open, ...starts]))
  }
  const toggle = (key: string): void => setOpen(toggled(data, open, key))
  const drawn = useMemo(() => (box > 0 ? drawSankey(data, open, box) : null), [data, open, box])
  const hub = (key: string, expanded: boolean, label: string): Record<string, unknown> => hubProps(key, expanded, label, toggle)
  return (
    <div ref={ref} style={{ minHeight: drawn?.height ?? HEADER_H + 300, overflowX: 'auto', overflowY: 'hidden' }}>
      {drawn && (
        <svg width={drawn.width} height={drawn.height} role="group" aria-label="Money flow">
          {drawn.headers.map((hd) => (
            <text key={hd.text} x={hd.first ? hd.x - LABEL_GAP : hd.x + NODE_WIDTH + LABEL_GAP} y={12} textAnchor={hd.first ? 'end' : 'start'} fontFamily={MONO} fontSize={10.5} letterSpacing="0.18em" fill="var(--ink-400)" aria-hidden>
              {hd.text.toUpperCase()}
            </text>
          ))}
          {drawn.links.map((l, k) => (
            <path key={k} d={l.d} fill="none" stroke={FLOW_COLOR[l.kind]} strokeOpacity={0.28} strokeWidth={Math.max(l.width, 1)} />
          ))}
          {drawn.groups.map((g) => (
            <g key={`${g.x}:${g.text}`} {...(g.of ? hub(g.of, true, `${g.text} ${g.figure}`) : {})}>
              <text x={g.first ? g.x - LABEL_GAP : g.x + NODE_WIDTH + LABEL_GAP} y={g.y} textAnchor={g.first ? 'end' : 'start'} fontSize={11} fill="var(--ink-400)">
                {g.text}
                {g.figure && (
                  <tspan dx={6} fontFamily={MONO} fontSize={10.5}>
                    {g.figure}
                  </tspan>
                )}
                {g.of && (
                  <tspan dx={6} fontFamily={MONO} fill="var(--ink-500)">
                    −
                  </tspan>
                )}
              </text>
            </g>
          ))}
          {drawn.nodes.map((nd) => {
            const { label: l } = nd
            const sign = l.sign && (
              <tspan dx={6} fontSize={11} fontFamily={MONO} fill="var(--ink-500)">
                {l.sign}
              </tspan>
            )
            const figure = (
              <tspan {...(l.stacked ? { x: l.x, dy: 13 } : { dx: 6 })} fontSize={10.5} fontFamily={MONO} fill="var(--ink-400)">
                {l.figure}
              </tspan>
            )
            return (
              <g key={nd.key} {...(nd.toggle ? hub(nd.toggle, nd.open, `${nd.name} ${l.figure}`) : {})}>
                <title>{`${nd.name} ${l.figure}`}</title>
                <rect x={nd.x} y={nd.y} width={NODE_WIDTH} height={Math.max(nd.h, 1)} fill={FLOW_COLOR[nd.kind]} rx={1} />
                {/* A halo in the card's color keeps a label readable where it sits over a band. */}
                <text x={l.x} y={l.y} dy={l.stacked ? -3 : 4} textAnchor={l.anchor} fontSize={12} fill="var(--ink-100)" stroke="var(--card-solid)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">
                  {l.name}
                  {l.stacked ? (
                    <>
                      {sign}
                      {figure}
                    </>
                  ) : (
                    <>
                      {figure}
                      {sign}
                    </>
                  )}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

// ---------- walk ----------

interface Bar {
  name: string
  kind: FlowKind
  cents: number
  /** add and sub move the running total; total stands on zero at it */
  type: 'add' | 'sub' | 'total'
  /** the bar's span, and the running total after it */
  a: number
  b: number
  at: number
}

const SANS = "'Inter Variable', system-ui, 'Segoe UI', sans-serif"
let measurer: CanvasRenderingContext2D | null | undefined
/**
 * A text's width in the sans face. Where there's no canvas to measure with (a test), a little over half its size a
 * character, as Inter's letters in these names average (Saved at work is 80.6 px at 12 px, 13 characters).
 */
const textWidth = (s: string, size: number, weight = 400, face = SANS): number => {
  if (measurer === undefined) measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  // The mono face's characters are all 0.6 of its size.
  if (!measurer) return s.length * size * (face === MONO ? 0.6 : weight > 400 ? 0.56 : 0.52)
  measurer.font = `${weight} ${size}px ${face}`
  return measurer.measureText(s).width
}
const fit = (s: string, max: number, size: number, weight?: number): string => {
  if (textWidth(s, size, weight) <= max) return s
  let t = s
  while (t.length > 1 && textWidth(`${t}…`, size, weight) > max) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}
/** Up to two lines within max, word by word; what still doesn't fit is cut short. */
const wrap = (s: string, max: number, size: number, weight?: number): string[] => {
  const lines: string[] = []
  for (const word of s.split(' ')) {
    const last = lines.at(-1)
    if (last !== undefined && textWidth(`${last} ${word}`, size, weight) <= max) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return (lines.length > 2 ? [lines[0], lines.slice(1).join(' ')] : lines).map((l) => fit(l, max, size, weight))
}

const BRIDGE_PLOT = 230
const BRIDGE_AMOUNT = 20
const BRIDGE_NAME = 40
/** How far every other name drops when the bars are too close for names side by side: below its neighbors' two lines */
const BRIDGE_DROP = 30
const NAME_SIZE = 11.5
/** The narrowest a bar's slot gets, so its figure stays apart from the next one's. */
const WALK_SLOT_MIN = 36
/** A box this narrow is a phone's (the rows' own narrow width, styles.css's @container (max-width: 560px)). */
const WALK_PHONE_BOX = 560
/** The room a phone's walk keeps between one bar's figure and the next one's. */
const WALK_FIGURE_GAP = 6

/** A step's figure as the walk draws it over its bar: a total's in 11 px semibold, a step's in 10.5 px. */
const figureWidth = (s: Pick<WalkStep, 'cents' | 'type'>): number => textWidth(walkFigure(s), s.type === 'total' ? 11 : 10.5, s.type === 'total' ? 600 : 400, MONO)

/**
 * How wide a walk is drawn in its box: the box's width, unless its bars' slots would be narrower than WALK_SLOT_MIN,
 * when it keeps that and the box scrolls sideways. In a phone's box each slot is also wide enough for its figure and
 * the next one's to stand WALK_FIGURE_GAP apart, as at 36 px a total and the step after it ran into each other.
 */
export function walkWidth(steps: ReadonlyArray<Pick<WalkStep, 'cents' | 'type'>>, box: number): number {
  if (box <= 0) return 0
  let slot = WALK_SLOT_MIN
  if (box < WALK_PHONE_BOX) for (let k = 1; k < steps.length; k++) slot = Math.max(slot, (figureWidth(steps[k - 1]) + figureWidth(steps[k])) / 2 + WALK_FIGURE_GAP)
  return Math.max(box, Math.ceil(steps.length * slot))
}

/**
 * The names under a walk's bars, each in up to two lines under its bar. When a name won't fit its bar's slot that way,
 * every other name drops below its neighbors' and each gets twice the room, still in two lines.
 */
export function walkNames(steps: ReadonlyArray<Pick<WalkStep, 'name' | 'type'>>, width: number): { tight: boolean; names: string[][] } {
  const slot = width / Math.max(1, steps.length)
  const weightOf = (s: Pick<WalkStep, 'type'>): number => (s.type === 'total' ? 600 : 400)
  const tight = steps.some((s) => wrap(s.name, slot - 8, NAME_SIZE, weightOf(s)).some((l) => l.endsWith('…')))
  return { tight, names: steps.map((s) => wrap(s.name, tight ? 2 * slot - 10 : slot - 8, NAME_SIZE, weightOf(s))) }
}

function Walk({ bars, width }: { bars: Bar[]; width: number }): ReactNode {
  if (!bars.length) return null
  const top = BRIDGE_AMOUNT
  const base = top + BRIDGE_PLOT
  const lo = Math.min(0, ...bars.map((b) => b.a))
  const hi = Math.max(1, ...bars.map((b) => b.b))
  const y = (cents: number): number => top + ((hi - cents) / (hi - lo)) * BRIDGE_PLOT
  const slot = width / bars.length
  const bw = Math.min(56, slot * 0.58)
  const cx = (k: number): number => slot * (k + 0.5)
  const weightOf = (b: Bar): number => (b.type === 'total' ? 600 : 400)
  const { tight, names } = walkNames(bars, width)
  const height = base + 14 + BRIDGE_NAME + (tight ? BRIDGE_DROP : 0)
  /** a name's center, kept inside the chart */
  const nameX = (k: number): number => {
    const half = Math.max(...names[k].map((l) => textWidth(l, NAME_SIZE, weightOf(bars[k])))) / 2
    return Math.min(Math.max(cx(k), half + 1), width - half - 1)
  }
  // A group, not one picture, so a screen reader reads each bar's figure and name in turn.
  return (
    <svg width={width} height={height} role="group" aria-label="Money walk">
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--ink-700)" />
      {bars.slice(1).map((b, j) => (
        <line key={j} x1={cx(j) + bw / 2} x2={cx(j + 1) - bw / 2} y1={y(bars[j].at)} y2={y(bars[j].at)} stroke="var(--ink-500)" strokeDasharray="2 3" />
      ))}
      {bars.map((b, k) => {
        const total = b.type === 'total'
        const amount = walkFigure(b)
        return (
          <g key={k}>
            <rect x={cx(k) - bw / 2} y={y(b.b)} width={bw} height={Math.max(y(b.a) - y(b.b), 1)} fill={FLOW_COLOR[b.kind]} rx={1} />
            <text x={cx(k)} y={y(b.b) - 6} textAnchor="middle" fontFamily={MONO} fontSize={total ? 11 : 10.5} fontWeight={total ? 600 : 400} fill={total ? (b.cents < 0 ? 'var(--neg)' : 'var(--ink-100)') : 'var(--ink-400)'}>
              {amount}
            </text>
            <text x={nameX(k)} y={base + 18} textAnchor="middle" fontSize={NAME_SIZE} fontWeight={weightOf(b)} fill={total ? 'var(--ink-50)' : 'var(--ink-200)'}>
              {names[k].map((l, j) => (
                <tspan key={j} x={nameX(k)} dy={j ? 14 : tight && k % 2 ? BRIDGE_DROP : 0}>
                  {l}
                </tspan>
              ))}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ---------- view ----------

/** Home's rows, the walk or the Sankey: one waterfall, three ways to see it (spec Decision 2). */
export type FlowView = 'rows' | 'walk' | 'sankey'
const VIEW_NAME: Record<FlowView, string> = { rows: 'Rows', walk: 'Walk', sankey: 'Sankey' }

/** The view kept under `key`, while it's one the page offers; null when none is (or the store can't be read). */
function keptView(views: readonly FlowView[], key: string): FlowView | null {
  try {
    const v = localStorage.getItem(key) as FlowView | null
    return v && views.includes(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The view picked last, of the ones a page offers, remembered across restarts under `key` in this viewer's
 * localStorage; with none picked, `fallback` (its first when not given). Switching it draws the figures the page has;
 * it asks for nothing. pick changes the view and keeps it; show changes it for now only, keeping nothing (Home's row
 * asked for, which only its rows show); picked says whether a view was kept or picked here.
 */
export function useFlowView(views: readonly FlowView[], key: string, fallback?: () => FlowView): [view: FlowView, pick: (v: FlowView) => void, show: (v: FlowView) => void, picked: boolean] {
  const [picked, setPicked] = useState(() => keptView(views, key) !== null)
  const [view, setView] = useState<FlowView>(() => keptView(views, key) ?? fallback?.() ?? views[0])
  const pick = useCallback(
    (v: FlowView): void => {
      setView(v)
      setPicked(true)
      try {
        localStorage.setItem(key, v)
      } catch {
        /* per-viewer convenience only */
      }
    },
    [key]
  )
  return [views.includes(view) ? view : views[0], pick, setView, picked]
}

export function FlowViewToggle({ view, onChange, views }: { view: FlowView; onChange: (v: FlowView) => void; views: readonly FlowView[] }): ReactNode {
  return (
    <div className="segmented" role="group" aria-label="Flow view">
      {views.map((v) => (
        <button key={v} className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => onChange(v)}>
          {VIEW_NAME[v]}
        </button>
      ))}
    </div>
  )
}

// ---------- a walk of steps ----------

/** A step of a walk: a subtotal standing on zero, or money added or taken off on the way to the next one. */
export interface WalkStep {
  name: string
  kind: FlowKind
  cents: number
  type: 'add' | 'sub' | 'total'
}

/**
 * A step's figure over its bar, in whole dollars as the rows show them, so Rows, Walk and Sankey read the same figures:
 * what it takes off below zero, rounded first, so a step under 50 cents is 0 as its row is, never −0.
 */
export const walkFigure = (s: Pick<WalkStep, 'cents' | 'type'>): string => dollars(s.type === 'sub' ? -s.cents : s.cents)

/**
 * A walk drawn straight from its steps, each bar the step's own amount: a total stands on zero at its figure, and
 * the bars between move the running total from one to the next. Home draws its rows this way.
 */
export function StepWalk({ steps }: { steps: WalkStep[] }): ReactNode {
  const [ref, box] = useWidth()
  // In a box too narrow for its bars, the walk keeps a width they can be read at and the box scrolls sideways.
  const width = walkWidth(steps, box)
  const bars = useMemo(() => {
    let run = 0
    return steps.map((s): Bar => {
      const before = run
      run = s.type === 'total' ? s.cents : s.type === 'add' ? run + s.cents : run - s.cents
      const [a, b] = s.type === 'total' ? [Math.min(0, run), Math.max(0, run)] : [Math.min(before, run), Math.max(before, run)]
      return { name: s.name, kind: s.kind, cents: s.cents, type: s.type, a, b, at: run }
    })
  }, [steps])
  return (
    <div ref={ref} style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      {width > 0 && <Walk bars={bars} width={width} />}
    </div>
  )
}
