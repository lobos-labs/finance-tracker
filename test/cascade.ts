// A small cascade over styles.css for the tests: the declaration that wins for one element, given its ancestors, the
// window's width and its containers' widths. It reads the selectors and at-rules the stylesheet uses (classes, ids,
// attributes, the descendant and child combinators, :is/:where/:not, states such as :hover named on the element,
// @media on widths and preferences, @container on widths, a not of one or several and'ed or or'ed (their keywords, as
// a media query's, in any case), and @supports as
// holding, the app's Chromium having what the stylesheet asks it for), and the shorthands the tests read as their
// longhands, a logical side as its physical one left to right, a length in px, rem or calc(), so a test can say what
// an element looks like at a width whatever form or order the rules take. What it can't tell (a sibling combinator,
// :has, an unknown at-rule or media feature, a container query on anything but a width, an @supports not, which would
// need it to know what Chromium lacks) it treats as not matching, or throws on.

export interface El {
  tag: string
  classes?: string[]
  id?: string
  attrs?: Record<string, string>
  /** Pseudo-classes it is in, as written (":hover", ":focus-visible", ":first-child"). */
  states?: string[]
  /** Its content box's width, for a container query that asks it. */
  width?: number
}

export interface Env {
  /** The window's width, CSS px. */
  width: number
  light?: boolean
  forcedColors?: boolean
  reducedMotion?: boolean
}

interface Rule {
  selectors: string[]
  decls: Array<{ prop: string; value: string; important: boolean }>
  at: string[]
}

/** The stylesheet's style rules in order, each with the at-rules it sits in. */
export function parse(css: string): Rule[] {
  const out: Rule[] = []
  const walk = (text: string, at: string[]): void => {
    let i = 0
    for (;;) {
      const open = text.indexOf('{', i)
      if (open < 0) return
      const prelude = text.slice(i, open).trim()
      let depth = 0
      let end = open
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++
        if (text[end] === '}' && --depth === 0) break
      }
      const body = text.slice(open + 1, end)
      if (/^@(media|container|supports)\b/.test(prelude)) walk(body, [...at, prelude])
      else if (!prelude.startsWith('@')) out.push({ selectors: split(prelude, ','), decls: declarations(body), at })
      i = end + 1
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), [])
  return out
}

/** A list split at a separator outside brackets and parentheses. */
function split(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    if ('(['.includes(text[i])) depth++
    else if (')]'.includes(text[i])) depth--
    else if (depth === 0 && text[i] === sep) {
      parts.push(text.slice(from, i).trim())
      from = i + 1
    }
  }
  parts.push(text.slice(from).trim())
  return parts.filter(Boolean)
}

function declarations(body: string): Rule['decls'] {
  return split(body, ';').flatMap((d) => {
    const colon = d.indexOf(':')
    if (colon < 0) return []
    const raw = d.slice(colon + 1).trim()
    const important = /!important$/.test(raw)
    const value = raw.replace(/\s*!important$/, '')
    return longhands(d.slice(0, colon).trim(), value).map(([prop, v]) => ({ prop, value: v, important }))
  })
}

const SIDES = ['top', 'right', 'bottom', 'left']
/** A logical side as its physical ones, in a left-to-right, top-to-bottom page. */
const LOGICAL: Record<string, string[]> = {
  'block-start': ['top'],
  'block-end': ['bottom'],
  'inline-start': ['left'],
  'inline-end': ['right'],
  block: ['top', 'bottom'],
  inline: ['left', 'right']
}
const STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset', 'auto'])
const isWidth = (t: string): boolean => /^(thin|medium|thick)$/.test(t) || !Number.isNaN(px(t))

/** A width, a style and a colour, each its initial value when left out. */
function line(value: string): [string, string, string] {
  let [width, style, color] = ['medium', 'none', 'currentcolor']
  for (const t of split(value, ' ')) {
    if (isWidth(t)) width = t
    else if (STYLES.has(t)) style = t
    else color = t
  }
  return [width, style, color]
}

/** Four sides' values from one to four. */
const fourSides = (value: string): string[] => {
  const v = split(value, ' ')
  return [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]]
}

/** Two logical sides' values from one or two. */
const twoSides = (value: string): string[] => {
  const v = split(value, ' ')
  return [v[0], v[1] ?? v[0]]
}

/** The shorthands the tests read, as their longhands. */
function longhands(prop: string, value: string): Array<[string, string]> {
  // A logical side or pair, or its own width, style or colour, as the physical sides.
  const logical = /^(border|padding|margin|inset)-(block|inline)(-start|-end)?(-width|-style|-color)?$/.exec(prop)
  if (logical) {
    const [, box, axis, end = '', part = ''] = logical
    const sides = LOGICAL[axis + end]
    const each = (i: number): string => (end || (box === 'border' && !part) ? value : twoSides(value)[i])
    if (box === 'border' && !part) return sides.flatMap((s) => longhands(`border-${s}`, value))
    return sides.map((s, i) => [box === 'inset' ? s : `${box}-${s}${part}`, each(i)])
  }
  if (prop === 'padding' || prop === 'margin') return fourSides(value).map((v, i) => [`${prop}-${SIDES[i]}`, v])
  if (prop === 'gap') {
    const [row, column] = twoSides(value)
    return [
      ['row-gap', row],
      ['column-gap', column]
    ]
  }
  // Only a background's colour: one with no colour of its own, a gradient's or an image's, is transparent.
  if (prop === 'background') {
    const color = split(value, ' ').find((t) => !/(gradient|url|image-set)\(/.test(t) && !/^(no-repeat|repeat(-x|-y)?|center|top|bottom|left|right|fixed|scroll|local|cover|contain|auto|[\d.]+(px|%)?|\/)$/.test(t))
    return [['background-color', color ?? 'transparent']]
  }
  if (prop === 'border') return SIDES.flatMap((s) => longhands(`border-${s}`, value))
  const side = /^border-(top|right|bottom|left)$/.exec(prop)
  if (side) {
    const [w, s, c] = line(value)
    return [
      [`${prop}-width`, w],
      [`${prop}-style`, s],
      [`${prop}-color`, c]
    ]
  }
  const all = /^border-(width|style|color)$/.exec(prop)
  if (all) return fourSides(value).map((v, i) => [`border-${SIDES[i]}-${all[1]}`, v])
  if (prop === 'outline') {
    const [w, s, c] = line(value)
    return [
      ['outline-width', w],
      ['outline-style', s],
      ['outline-color', c]
    ]
  }
  if (prop === 'container') {
    const [name, type] = value.split('/').map((x) => x.trim())
    return [
      ['container-name', name],
      ['container-type', type ?? 'normal']
    ]
  }
  return [[prop, value]]
}

/** A complex selector as compounds and the combinators between them. */
function parts(selector: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if ('(['.includes(ch)) depth++
    if (')]'.includes(ch)) depth--
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      let j = i
      while (j < selector.length && /\s/.test(selector[j])) j++
      const comb = '>+~'.includes(selector[j]) ? selector[j++] : ' '
      while (j < selector.length && /\s/.test(selector[j])) j++
      if (cur) out.push(cur, comb)
      cur = ''
      i = j - 1
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** A compound's simple selectors: a type, .class, #id, [attr], :pseudo(arg) or ::pseudo. */
function simples(compound: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < compound.length) {
    let j = i + 1
    if (compound[i] === '[') j = compound.indexOf(']', i) + 1
    else {
      if (compound[i] === ':' && compound[j] === ':') j++
      let depth = 0
      for (; j < compound.length; j++) {
        const ch = compound[j]
        if (ch === '(') depth++
        else if (ch === ')') depth--
        else if (depth === 0 && '.#[:'.includes(ch)) break
      }
    }
    out.push(compound.slice(i, j))
    i = j
  }
  return out
}

const arg = (simple: string): string => simple.slice(simple.indexOf('(') + 1, -1)

function simpleMatches(s: string, chain: El[], at: number): boolean {
  const el = chain[at]
  if (s === '*') return true
  if (s.startsWith('::')) return false
  if (s.startsWith('.')) return !!el.classes?.includes(s.slice(1))
  if (s.startsWith('#')) return el.id === s.slice(1)
  if (s.startsWith('[')) {
    const m = /^\[([\w-]+)(?:([~^$*|]?=)["']?([^"'\]]*)["']?)?\]$/.exec(s)
    const v = m ? el.attrs?.[m[1]] : undefined
    if (!m || v === undefined) return false
    if (!m[2]) return true
    return m[2] === '=' ? v === m[3] : m[2] === '^=' ? v.startsWith(m[3]) : m[2] === '$=' ? v.endsWith(m[3]) : m[2] === '*=' ? v.includes(m[3]) : v.split(/\s+/).includes(m[3])
  }
  if (s.startsWith(':is(') || s.startsWith(':where(')) return split(arg(s), ',').some((x) => matchesAt(x, chain, at))
  if (s.startsWith(':not(')) return !split(arg(s), ',').some((x) => matchesAt(x, chain, at))
  if (s === ':root') return at === 0
  // An element focused from the keyboard is focused, and it and its ancestors have focus within.
  if (s === ':focus') return !!el.states?.some((x) => x === ':focus' || x === ':focus-visible')
  if (s === ':focus-within') return chain.slice(at).some((e) => e.states?.some((x) => [':focus', ':focus-visible', ':focus-within'].includes(x)))
  if (s.startsWith(':')) return !!el.states?.includes(s)
  return el.tag === s
}

/** Whether a complex selector matches chain[at], its ancestors being chain[0..at). */
function matchesAt(selector: string, chain: El[], at: number): boolean {
  const p = parts(selector)
  const from = (pi: number, ci: number): boolean => {
    if (!simples(p[pi]).every((s) => simpleMatches(s, chain, ci))) return false
    if (pi === 0) return true
    if (p[pi - 1] === '>') return ci > 0 && from(pi - 2, ci - 1)
    if (p[pi - 1] === ' ') {
      for (let j = ci - 1; j >= 0; j--) if (from(pi - 2, j)) return true
    }
    return false
  }
  return from(p.length - 1, at)
}

/** A selector's specificity as one number: ids, then classes, attributes and pseudo-classes, then types. */
export function specificity(selector: string): number {
  let n = 0
  for (const c of parts(selector).filter((x, i) => i % 2 === 0))
    for (const s of simples(c)) {
      if (s.startsWith(':where(') || s === '*') continue
      if (s.startsWith(':is(') || s.startsWith(':not(')) n += Math.max(...split(arg(s), ',').map(specificity))
      else if (s.startsWith('#')) n += 10_000
      else if (s.startsWith('::')) n += 1
      else if (/^[.[:]/.test(s)) n += 100
      else n += 1
    }
  return n
}

/** A length in px: px, or rem or em at the page's 16 px, or calc() of those added, taken away, or multiplied or divided
 * by a number. NaN when it isn't one. */
export function px(value: string): number {
  const text = value.trim().replace(/^calc\(([\s\S]*)\)$/, '$1')
  const tokens = text.match(/\d*\.?\d+(?:px|rem|em)?|[-+*/()]/g) ?? []
  if (tokens.join('') !== text.replace(/\s+/g, '')) return NaN
  let i = 0
  // Each term its value and whether it is a length.
  const atom = (): [number, boolean] => {
    const t = tokens[i++]
    if (t === '-') {
      const [v, len] = atom()
      return [-v, len]
    }
    if (t === '(') {
      const v = sum()
      return tokens[i++] === ')' ? v : [NaN, false]
    }
    const m = /^(\d*\.?\d+)(px|rem|em)?$/.exec(t ?? '')
    if (!m) return [NaN, false]
    return [Number(m[1]) * (m[2] && m[2] !== 'px' ? 16 : 1), !!m[2] || Number(m[1]) === 0]
  }
  const product = (): [number, boolean] => {
    let [v, len] = atom()
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++]
      const [w, wLen] = atom()
      v = op === '*' ? v * w : v / w
      len = len || wLen
    }
    return [v, len]
  }
  const sum = (): [number, boolean] => {
    let [v, len] = product()
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++]
      const [w, wLen] = product()
      v = op === '+' ? v + w : v - w
      len = len || wLen
    }
    return [v, len]
  }
  const [v, len] = sum()
  return i === tokens.length && len ? v : NaN
}

/** Whether a width condition, (max-width: 700px) or (width < 31.25rem), holds for a width; null when it isn't one. */
function widthTest(feature: string, width: number): boolean | null {
  const named = /^\(\s*(max|min)-(?:width|inline-size)\s*:\s*([^)]+?)\s*\)$/.exec(feature)
  const range = /^\(\s*(?:width|inline-size)\s*(<=|>=|<|>)\s*([^)]+?)\s*\)$/.exec(feature)
  const at = px((named ?? range)?.[2] ?? '')
  if (Number.isNaN(at)) return null
  if (named) return named[1] === 'max' ? width <= at : width >= at
  const op = range![1]
  return op === '<' ? width < at : op === '<=' ? width <= at : op === '>' ? width > at : width >= at
}

/** Whether a container's condition holds for its width: a width condition in brackets, not one, or several all and'ed
 * or all or'ed, each of those in brackets again too; null when it is anything else. */
function containerCondition(text: string, width: number): boolean | null {
  const t = text.trim()
  /** One condition in brackets: a width's, or another condition. */
  const inBrackets = (group: string): boolean | null => widthTest(group, width) ?? containerCondition(group.slice(1, -1), width)
  const not = /^not\s+(\([\s\S]*\))$/i.exec(t)
  if (not && /^\((?:[^()]|\([^()]*\))*\)$/.test(not[1])) {
    const r = inBrackets(not[1])
    return r === null ? null : !r
  }
  const groups: string[] = []
  const ops = new Set<string>()
  let rest = t
  for (;;) {
    const group = /^\((?:[^()]|\([^()]*\))*\)/.exec(rest)
    if (!group) return null
    groups.push(group[0])
    rest = rest.slice(group[0].length).trim()
    if (!rest) break
    const op = /^(and|or)\s+/i.exec(rest)
    if (!op) return null
    ops.add(op[1].toLowerCase())
    rest = rest.slice(op[0].length)
  }
  // An and beside an or, without brackets to say which comes first, is no condition.
  if (ops.size > 1) return null
  const results = groups.map(inBrackets)
  if (results.includes(null)) return null
  return ops.has('or') ? results.some(Boolean) : results.every(Boolean)
}

/** Whether a media feature other than a width holds, (forced-colors: active) or a bare (forced-colors). */
function preference(feature: string, env: Env): boolean {
  const m = /^\(\s*([\w-]+)\s*(?::\s*([^)]+?)\s*)?\)$/.exec(feature)
  if (!m) throw new Error(`cascade: media query ${feature}`)
  const [, name, v] = m
  // A bare feature holds where its value isn't none, and a colour scheme always has one.
  if (name === 'prefers-color-scheme') return v === undefined || (v === 'light') === !!env.light
  if (name === 'prefers-reduced-motion') return (v === undefined || v === 'reduce') === !!env.reducedMotion
  if (name === 'forced-colors') return (v === undefined || v === 'active') === !!env.forcedColors
  throw new Error(`cascade: media feature ${name}`)
}

/** Whether one query of a media list holds: an optional not or only and a media type, then its features and'ed, its
 * keywords in any case. */
function mediaQuery(query: string, env: Env): boolean {
  const [, prefix, type, rest] = /^(?:(not|only)\s+)?(?:(all|screen|print)(?:\s+and\s+|$))?([\s\S]*)$/i.exec(query.trim())!
  const features = rest.trim() ? rest.split(/\s+and\s+/i) : []
  const result = type?.toLowerCase() !== 'print' && features.every((f) => widthTest(f.trim(), env.width) ?? preference(f.trim(), env))
  return prefix?.toLowerCase() === 'not' ? !result : result
}

/** Whether an at-rule's condition holds for chain[at]. */
function holds(prelude: string, chain: El[], at: number, env: Env, rules: Rule[]): boolean {
  const media = /^@media\s+(.*)$/.exec(prelude)
  if (media) return split(media[1], ',').some((q) => mediaQuery(q, env))
  // The app's Chromium has what the stylesheet asks it for; what it lacks, which a not would ask, isn't known here.
  if (/^@supports\s/.test(prelude)) {
    if (/\bnot\b/i.test(prelude)) throw new Error(`cascade: ${prelude}`)
    return true
  }
  // A container's name is never not, and, or or none, in any case, so a condition can start with one of those.
  const container = /^@container\s+(?:((?!(?:not|and|or|none)(?![\w-]))[\w-]+)\s+)?(\S[\s\S]*)$/i.exec(prelude)
  if (container) {
    const [, name, condition] = container
    for (let j = at - 1; j >= 0; j--) {
      const c = computed(rules, chain.slice(0, j + 1), env)
      if ((c['container-type'] ?? 'normal') === 'normal') continue
      if (name && !(c['container-name'] ?? '').split(/\s+/).includes(name)) continue
      const width = chain[j].width
      if (width === undefined) throw new Error(`cascade: ${prelude} asks the width of ${chain[j].tag}.${chain[j].classes?.join('.')}`)
      const result = containerCondition(condition, width)
      if (result === null) throw new Error(`cascade: container query ${prelude}`)
      return result
    }
    return false
  }
  throw new Error(`cascade: at-rule ${prelude}`)
}

/** The winning value of every property set on chain's last element (no inheritance), as written. */
export function computed(rules: Rule[], chain: El[], env: Env): Record<string, string> {
  const at = chain.length - 1
  // Rules are read in order, so a declaration that ranks the same as the one before it (importance, then
  // specificity) comes later and wins.
  const won = new Map<string, { rank: [number, number]; value: string }>()
  for (const r of rules) {
    const hits = r.selectors.filter((s) => matchesAt(s, chain, at))
    if (!hits.length || !r.at.every((p) => holds(p, chain, at, env, rules))) continue
    const spec = Math.max(...hits.map(specificity))
    for (const d of r.decls) {
      const rank: [number, number] = [d.important ? 1 : 0, spec]
      const was = won.get(d.prop)
      if (!was || rank[0] > was.rank[0] || (rank[0] === was.rank[0] && rank[1] >= was.rank[1])) won.set(d.prop, { rank, value: d.value })
    }
  }
  return Object.fromEntries([...won].map(([k, v]) => [k, v.value]))
}
