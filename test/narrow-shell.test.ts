import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NARROW, openMenu, type MenuParts } from '../src/renderer/src/shellMenu.ts'
import { computed, parse, px, type El, type Env } from './cascade.ts'

// The web app at a phone's width (waterfall spec 2h): under 700 px the sidebar gives way to a top bar whose menu
// control opens the sidebar over the page, and every page keeps 16 px a side. The rules for it live in one
// @media (max-width: 700px) block at the end of styles.css, so a window 900 wide or more draws exactly what it did.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(join(root, path), 'utf8')
const css = source('src/renderer/src/styles.css')

/** The stylesheet with every block of a given at-rule (its whole braces) taken out. */
function without(text: string, prelude: string): string {
  let out = text
  for (let at = out.indexOf(prelude); at >= 0; at = out.indexOf(prelude)) {
    let depth = 0
    let end = out.indexOf('{', at)
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++
      if (out[end] === '}' && --depth === 0) break
    }
    out = out.slice(0, at) + out.slice(end + 1)
  }
  return out
}

/** The bodies of every block of a given at-rule, in order. */
function blocks(text: string, prelude: string): string[] {
  const found: string[] = []
  for (let at = text.indexOf(prelude); at >= 0; at = text.indexOf(prelude, at + 1)) {
    let depth = 0
    const open = text.indexOf('{', at)
    let end = open
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++
      if (text[end] === '}' && --depth === 0) break
    }
    found.push(text.slice(open + 1, end))
  }
  return found
}

describe('the shell at a phone width', () => {
  test("the narrow width is the one the stylesheet's phone rules use, and the shell's rules are all under it", () => {
    assert.equal(NARROW, '(max-width: 700px)')
    const phone = blocks(css, `@media ${NARROW}`)
    assert.ok(phone.length >= 1)
    const shell = phone.find((b) => b.includes('.shell-bar'))!
    assert.ok(shell, 'a phone block draws the top bar')
    // The top bar shows, the sidebar sits over the page and out of sight until the menu opens it, and the rest dims.
    assert.match(shell, /\.app \{[^}]*grid-template-columns: minmax\(0, 1fr\);\s*grid-template-rows: auto minmax\(0, 1fr\);/)
    assert.match(shell, /\.shell-bar \{\s*display: flex;/)
    assert.match(shell, /\.sidebar \{\s*position: absolute;[^}]*transform: translateX\(-100%\);\s*visibility: hidden;\s*\}/)
    assert.match(shell, /\.app\.menu-open \.sidebar \{\s*transform: none;\s*visibility: visible;/)
    assert.match(shell, /\.app\.menu-open::after \{[^}]*inset: 0;[^}]*background: var\(--scrim\);/)
    // Every page keeps 16 px at each side of the screen, its own bar and the review's columns too: a desktop browser's
    // scrollbar (100vw less the main column's 100cqw) comes out of the right padding, so the page doesn't end 26 px in.
    assert.match(shell, /\.app \{\s*--page-end: max\(6px, calc\(16px - \(100vw - 100cqw\)\)\);/)
    assert.match(shell, /\.page \{\s*padding: 20px var\(--page-end\) 48px 16px;\s*\}/)
    assert.match(shell, /\.app > \.main \.topbar \{[^}]*padding: 12px var\(--page-end\) 12px 16px;/)
    assert.match(shell, /\.chat-scroll \{\s*padding: 20px var\(--page-end\) 20px 16px;\s*\}/)
    assert.match(shell, /\.chat-composer \{\s*padding: 10px var\(--page-end\) 12px 16px;\s*\}/)
    assert.match(shell, /\.review-side \{[^}]*padding: 20px var\(--page-end\) 48px 16px;/)
    // The main column is the size container that 100cqw measures.
    assert.match(shell, /\.main \{\s*container-type: size;\s*\}/)
    assert.doesNotMatch(shell, /padding: 20px 16px 48px|padding: 12px 16px;/)

    // Outside the phone blocks the top bar is never drawn and nothing names the open menu, so a desktop window is as it was.
    const wide = without(css, `@media ${NARROW}`)
    assert.match(wide, /\.shell-bar \{\s*display: none;\s*\}/)
    assert.equal([...wide.matchAll(/\.shell-bar\b/g)].length, 1)
    assert.doesNotMatch(wide, /menu-open|\.shell-page|\.shell-menu/)
  })

  test('the phone rules are one block at the end of the stylesheet, and only that block uses !important outside reduced motion', () => {
    const at = css.indexOf("/* ---------- a phone's width")
    assert.ok(at > 0)
    const tail = css.slice(at).replace(/\/\*[\s\S]*?\*\//g, '').trim()
    assert.ok(tail.startsWith(`@media ${NARROW} {`), 'the section is the media block')
    assert.equal(without(tail, `@media ${NARROW}`).trim(), '', 'nothing after it is outside the block')
    // !important outranks the strips' and the returns' inline columns, a value's inline width and a field's inline flex,
    // at a phone's width only.
    const rest = without(without(css, `@media ${NARROW}`), '@media (prefers-reduced-motion: reduce)')
    assert.doesNotMatch(rest, /!important/)
  })

  test("what broke at 375 wide has its rule: Left over's drill, Debts' bar, Net worth's tiles and the contributions", () => {
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    // Left over's drill was 12 px too wide: the rows' headings wrap, so the figures' columns fit the page.
    assert.match(phone, /\.home-rows thead th \{\s*white-space: normal;/)
    // A page's bar taller than --topbar-h hid what stuck under it: it scrolls with the page, and the debt plan opens 8 px down.
    assert.match(phone, /\.app > \.main \.topbar \{\s*position: static;/)
    assert.match(phone, /#payoff \{\s*scroll-margin-top: 8px;\s*\}/)
    // Net worth's three tiles overlapped: two to a line, the lead figure across when the count is odd.
    assert.match(phone, /\.stat-strip:not\(\.plan-strip\) \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/)
    assert.match(phone, /\.stat-strip\[style\] > :first-child:nth-last-child\(odd\),/)
    // Every strip's figures are one size, the five-tile strip's too (its own 28 px outranked the plain .tile-value).
    assert.match(css, /\.stat-strip\.five \.tile-value \{\s*font-size: 28px;\s*\}/)
    assert.match(phone, /\.tile-value,\s*\.stat-strip\.five \.tile-value \{\s*font-size: 26px;\s*\}/)
    // The contributions' five columns fell apart: the plan on its line, its four figures two to a line.
    assert.match(phone, /\.contrib-row \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
    assert.match(phone, /\.contrib-row > :first-child \{\s*grid-column: 1 \/ -1;/)
  })

  test('every declaration in the phone block is the one that applies: none restated, none drawn for nothing', () => {
    let phone = blocks(css, `@media ${NARROW}`).join('\n')
    for (const at of ['@container', '@media']) phone = without(phone, at)
    phone = phone.replace(/\/\*[\s\S]*?\*\//g, '')
    // One selector setting one property twice in the block: the first never applies (a holding's padding did).
    const seen = new Set<string>()
    const twice: string[] = []
    for (const m of phone.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const props = [...m[2].matchAll(/(^|;)\s*(-?-?[a-z][a-z-]*)\s*:/g)].map((p) => p[2])
      for (const s of m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')))
        for (const p of props) {
          if (seen.has(`${s} ${p}`)) twice.push(`${s} ${p}`)
          seen.add(`${s} ${p}`)
        }
    }
    assert.deepEqual(twice, [])
    // A venture's assets took their gap from the money rows' rule, which outranks the wide lists', so only their padding
    // is theirs; and Transactions' head row is hidden here, so nothing sets where its cells stick.
    assert.equal([...phone.matchAll(/\.money-row\.venture-asset\b/g)].length, 1)
    assert.match(phone, /\.money-row\.venture-asset \{\s*padding-left: 14px;\s*padding-right: 14px;\s*\}/)
    assert.match(phone, /\.txns colgroup,\s*\.txns thead,/)
    assert.doesNotMatch(phone, /\.txns th\b/)
  })

  test("in a desktop window zoomed under 700 px the top bar is the title bar: it drags the window and keeps clear of the caption buttons", () => {
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    // The page's name sat under the caption buttons, and nothing dragged the window once the page's own bar scrolled away.
    assert.match(phone, /\.shell-bar \{[^}]*padding: 0 max\(16px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\) \+ 8px\)\) 0 max\(8px, env\(titlebar-area-x, 0px\)\);[^}]*-webkit-app-region: drag;/)
    assert.match(phone, /\.shell-bar button \{\s*-webkit-app-region: no-drag;\s*\}/)
    // With the menu open, a press on the scrim over either bar closes the menu rather than drag the window.
    assert.match(phone, /\.app\.menu-open \.shell-bar,\s*\.app\.menu-open > \.main \.topbar \{\s*-webkit-app-region: no-drag;\s*\}/)
    // A browser tab has no window to drag: the web app and the demo take the drag off, as for their other bars (the public
    // edition has neither).
    for (const [file, body] of [['src/renderer/src/web/web.css', 'body.web'], ['src/renderer/src/demo/demo.css', 'body.demo']]) {
      if (!existsSync(join(root, file))) continue
      const sheet = source(file)
      assert.match(sheet, new RegExp(`${body.replace('.', '\\.')} \\.topbar,\\s*${body.replace('.', '\\.')} \\.shell-bar,\\s*${body.replace('.', '\\.')} \\.wizard-drag \\{\\s*-webkit-app-region: no-drag;`), file)
    }
  })

  test('at 320 wide the span picker, the rows, the names and Spendable stay inside the page', () => {
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    // The months narrowed past their content (333 px) and put Later past the right edge, or Earlier past the left.
    assert.match(phone, /\.span-picker \.month-switch \{\s*flex: 1 1 260px;\s*min-width: 0;\s*\}/)
    const small = blocks(phone, '@media (max-width: 340px)').join('\n')
    assert.match(small, /\.span-picker \.month-input \{\s*padding-left: 4px;\s*font-size: 10px;\s*\}/)
    // Left over's and Elective's drills ran 39 px past a 278 px table: under 300 px of rows the figures tighten and a
    // category's tier goes under its name.
    const rows = blocks(phone, '@container (max-width: 300px)').join('\n')
    assert.match(rows, /\.home-rows \{\s*font-size: 12px;\s*\}/)
    assert.match(rows, /\.home-rows th,\s*\.home-rows td \{\s*padding: 0 3px;\s*\}/)
    assert.match(rows, /\.home-rows \.part-name \{\s*flex-wrap: wrap;/)
    // A policy's, a venture's and a cost's names, and a debt's and a property's line, were cut short with an ellipsis.
    assert.match(phone, /\.asset-row\.insurance-row > \.truncate,\s*\.asset-card > \.label-muted\.truncate,\s*\.bucket-name > \.truncate,\s*\.care-row > \.truncate \{\s*white-space: normal;\s*overflow-wrap: anywhere;\s*\}/)
    // Spendable's figure ran past its strip, with the chevron outside it, and its card's cushion field past the page.
    assert.match(phone, /\.home-strip \.num \{\s*min-width: 0;\s*white-space: normal;\s*\}/)
    // Its card's head, and its three risks side by side that cut a five-figure amount short: Spendable's card, below.
  })

  test("the calendar's bars are 12 px press targets that touch, each drawn 6 px tall in its kind's color", () => {
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    // They were 38 by 6, 3 px apart, so a press a few pixels off one landed on the day and started a reminder.
    assert.match(phone, /\.cal-cell \{\s*min-height: 58px;\s*padding: 4px 3px 6px;\s*gap: 0;\s*\}/)
    assert.match(phone, /\.cal-chip \{\s*height: 12px;\s*padding: 3px 0;\s*border-left: 0;\s*background: var\(--ink-500\) content-box;\s*\}/)
    for (const [kind, color] of [['reminder', 'copper'], ['income', 'pos'], ['bill', 'neg'], ['transfer', 'ink-400']])
      assert.match(phone, new RegExp(`\\.cal-chip\\.${kind} \\{\\s*background: var\\(--${color}\\) content-box;\\s*\\}`), kind)
    // The day's own press still starts a reminder, as on the desktop.
    assert.match(source('src/renderer/src/pages/Calendar.tsx'), /onClick=\{\(e\) => e\.target === e\.currentTarget && setDraft\(/)
  })

  test("a Committed group's fill and line run the row's whole width once its data is under its name", () => {
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    // Rows 560 px and narrower hide the data's cell beside the figures (the stylesheet's own container rule), and a
    // row paints only behind its cells: the fill stopped after Run rate. The cell stays, empty, in its place.
    assert.match(css, /@container \(max-width: 560px\) \{[^@]*\.home-rows \.group-label \{\s*display: none;\s*\}/)
    const groups = blocks(phone, '@container (max-width: 560px)').join('\n')
    assert.match(groups, /\.home-rows tr\.group > \.group-label \{\s*display: table-cell;\s*padding: 0;\s*font-size: 0;\s*\}/)
    assert.doesNotMatch(phone, /\.home-rows tr\.group \{\s*background:/)
    assert.match(source('src/renderer/src/pages/HomeRows.tsx'), /<td colSpan=\{3\} className="group-label">/)
  })

  test("a line's fields and paths take what their line leaves, and a table's choices are read whole", () => {
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    // The API key and license fields and a value's figure set flex: 1 inline, which beat the line's rule: the key field
    // was 70 px with its placeholder cut, and the Value field 46 px. The Documents path, flex: 1, was one letter wide.
    assert.match(phone, /\.main \.row > \.input,\s*\.main \.row > \.data-path \{\s*flex: 1 1 160px;\s*min-width: 0;\s*\}/)
    assert.match(phone, /\.main \.row > \.input\[style\] \{\s*flex: 1 1 160px !important;\s*\}/)
    const settings = source('src/renderer/src/pages/Settings.tsx')
    assert.match(settings, /placeholder=\{settings\.apiKeySource === 'saved' \? 'Paste a new key to replace it' : 'Paste your Anthropic API key \(sk-ant-…\)'\}[^\n]*style=\{\{ flex: 1, maxWidth: 420 \}\}/)
    assert.match(source('src/renderer/src/pages/Assets.tsx'), /onKeyDown=\{\(e\) => e\.key === 'Enter' && void add\(\)\}\s*style=\{\{ flex: 1 \}\}/)
    // The models showed as "Claude |" in a table that scrolls anyway; the plan's table stopped short of its card.
    assert.match(phone, /\.cat-table:not\(\.categories\) \.select \{\s*min-width: max-content;\s*\}/)
    assert.match(phone, /\.cat-table:not\(:has\(> thead\)\) > tbody \{\s*display: table;\s*width: 100%;\s*\}/)
  })

  test("a conversation under way takes the column's height below Review's own bar, so its reply box is in view", () => {
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    // The column holds the page's bar and the layout; the layout takes what the bar leaves and scrolls what's under the
    // conversation, and the conversation is that box's height (it was the column's whole height, under a 72 px bar).
    assert.match(phone, /\.main:has\(> \.review-layout \.chat-thread\) \{\s*display: flex;\s*flex-direction: column;\s*overflow-y: hidden;/)
    assert.match(phone, /\.main:has\(> \.review-layout \.chat-thread\) > \.topbar \{\s*flex: none;\s*\}/)
    assert.match(phone, /\.main:has\(> \.review-layout \.chat-thread\) > \.review-layout \{\s*flex: 1 1 0;\s*min-height: 0;\s*overflow-y: auto;\s*scrollbar-gutter: stable;\s*container-type: size;\s*\}/)
    assert.match(phone, /\.chat:has\(\.chat-thread\) \{\s*height: 100cqh;\s*\}/)
    assert.doesNotMatch(phone, /\.chat:not\(:has\(\.chat-empty\)\)/)
    // Review draws its bar and its layout straight in the main column, and a conversation as its thread.
    const review = source('src/renderer/src/pages/Review.tsx')
    assert.match(review, /<\/PageHeader>\s*<div className="review-layout">/)
    assert.match(review, /<div className="chat-thread">/)
  })

  test('the app draws the top bar, its menu control and the sidebar it opens, and every way to a page closes the menu', () => {
    const app = source('src/renderer/src/App.tsx')
    assert.match(app, /<header className="shell-bar" ref=\{shellBar\}>/)
    assert.match(app, /<button ref=\{menuControl\} className="btn ghost icon-btn shell-menu" aria-expanded=\{menu\} aria-controls="shell-nav" aria-label="Menu" onClick=\{\(\) => setMenu\(\(m\) => !m\)\}>/)
    assert.match(app, /<span className="shell-page">\{pageName\(page, netView\)\}<\/span>/)
    // Review's count, the one next action, is on the menu control with the menu closed, as on the sidebar's Review.
    assert.match(app, /<Icon name="menu" size=\{18\} \/>\s*\{\/\*[^*]*\*\/\}\s*\{openItems > 0 && \(\s*<span className="nav-badge shell-badge" title="Open items to review">\s*\{openItems\}\s*<\/span>\s*\)\}\s*<\/button>/)
    assert.match(app, /\{p === 'review' && openItems > 0 && <span className="nav-badge" title="Open items to review">\{openItems\}<\/span>\}/)
    const phone = blocks(css, `@media ${NARROW}`).join('\n')
    assert.match(phone, /\.shell-menu \{\s*position: relative;\s*\}/)
    assert.match(phone, /\.shell-badge \{\s*position: absolute;/)
    assert.doesNotMatch(without(css, `@media ${NARROW}`), /\.shell-badge/)
    assert.match(app, /<nav className="sidebar" id="shell-nav" aria-label="Main" ref=\{sidebar\}>/)
    assert.match(app, /<div className=\{`app \$\{menu \? 'menu-open' : ''\}`\}>/)
    // While it's open the top bar and the page behind it are inert, so Tab stays in the menu.
    assert.match(app, /useEffect\(\(\) => \(menu \? openMenu\(\{ doc: document, control: menuControl\.current, panel: sidebar\.current, behind: \[shellBar\.current, mainRef\.current\] \}, \(\) => setMenu\(false\)\) : undefined\), \[menu\]\)/)
    assert.match(app, /<main className="main" ref=\{mainRef\}>/)
    // A page chosen from the menu (or opened by go(), a notification or Net worth's views) closes it.
    assert.match(app, /setPage\(to\.page\)\s*\/\/[^\n]*\n\s*setMenu\(false\)/)
    assert.match(app, /setPage\('networth'\)\s*setMenu\(false\)/)
    // Widened past a phone's width, the menu closes.
    assert.match(app, /const narrow = matchMedia\(NARROW\)/)
    // The bar names the page as its own title does: Net worth's Overview as Net worth, its other views by their names.
    assert.match(app, /if \(p === 'networth'\) return view === 'overview' \? 'Net worth' : /)
  })
})

const rules = parse(css)
const asked = new Map<string, Record<string, string>>()
/** What the stylesheet draws chain's last element with, asked once for each chain and window. */
function style(chain: El[], env: Env): Record<string, string> {
  const key = JSON.stringify([chain, env])
  if (!asked.has(key)) asked.set(key, computed(rules, chain, env))
  return asked.get(key)!
}

type Part = 'card' | 'top' | 'risks' | 'tile' | 'on' | 'label' | 'value' | 'onLabel' | 'onValue'
/** The parts whose drawing the tests ask: a risk, the chosen risk, and each one's name and figure. */
type Drawable = 'tile' | 'on' | 'label' | 'value' | 'onLabel' | 'onValue'

/** Spendable's card on Home in a window `window` px wide, its content box `card` px: what the stylesheet draws the card,
 * its head, its risks, a risk, the chosen risk, and a risk's and the chosen risk's name and figure with, and whether a
 * risk, the chosen risk and their names and figures are drawn at all. */
function risks(window: number, card: number, env: Omit<Env, 'width'> = {}, states: string[] = []): Record<Part, Record<string, string>> & { shown: Record<Drawable, boolean> } {
  // A risk hovered or focused: every element it is in is hovered too, or has focus within.
  const within = [...new Set(states.flatMap((x) => (x === ':hover' ? [x] : /^:focus/.test(x) ? [':focus-within'] : [])))]
  const home: El[] = [
    { tag: 'html', states: within },
    { tag: 'body', states: within },
    { tag: 'div', id: 'root', states: within },
    { tag: 'div', classes: ['app'], states: within },
    { tag: 'main', classes: ['main'], width: window > 700 ? window - 232 : window, states: within },
    { tag: 'div', classes: ['page', 'home'], states: within },
    { tag: 'div', classes: ['card', 'spend-card'], width: card, states: within }
  ]
  const above: El[] = [...home, { tag: 'div', classes: ['spend-risks'], attrs: { role: 'radiogroup', 'aria-label': 'Risk' }, states: within }]
  const tile = (on: boolean): El => ({ tag: 'button', classes: on ? ['spend-risk', 'on'] : ['spend-risk'], attrs: { role: 'radio', 'aria-checked': String(on) }, states })
  const chains: Record<Part, El[]> = {
    card: home,
    top: [...home, { tag: 'div', classes: ['spend-top'] }],
    risks: above,
    tile: [...above, tile(false)],
    on: [...above, tile(true)],
    label: [...above, tile(false), { tag: 'span', classes: ['label-muted'] }],
    value: [...above, tile(false), { tag: 'span', classes: ['spend-risk-value'] }],
    onLabel: [...above, tile(true), { tag: 'span', classes: ['label-muted'] }],
    onValue: [...above, tile(true), { tag: 'span', classes: ['spend-risk-value'] }]
  }
  const e = { width: window, ...env }
  // In a contrast theme Chromium draws a colour that isn't one of the theme's own as its own stylesheet's: a button's
  // fill ButtonFace, its text and borders ButtonText, a focus ring Highlight.
  const drawn = (s: Record<string, string>): Record<string, string> =>
    !env.forcedColors
      ? s
      : Object.fromEntries(Object.entries(s).map(([k, v]) => [k, SYSTEM.test(v) ? v : k === 'background-color' ? 'ButtonFace' : k === 'outline-color' ? 'Highlight' : /^(color|border-\w+-color)$/.test(k) ? 'ButtonText' : v]))
  const styles = Object.fromEntries(Object.entries(chains).map(([k, c]) => [k, style(c, e)])) as Record<Part, Record<string, string>>
  const shown = Object.fromEntries((['tile', 'on', 'label', 'value', 'onLabel', 'onValue'] as const).map((k) => [k, drawnAll(chains[k], e)])) as Record<Drawable, boolean>
  return { ...styles, tile: drawn(styles.tile), on: drawn(styles.on), shown }
}

/** A colour's alpha from 0 to 1 as written (transparent, rgb()/hsl() and the like with a / or a fourth argument,
 * #rgba or #rrggbbaa), 1 where it names none, and null for a colour a test can't read (a var() or a mix). */
function alpha(color: string): number | null {
  const v = color.trim().toLowerCase()
  if (v === 'transparent') return 0
  if (/^(var|color-mix)\(/.test(v)) return null
  const hex = /^#([\da-f]{3,8})$/.exec(v)
  if (hex) return hex[1].length === 4 ? parseInt(hex[1][3].repeat(2), 16) / 255 : hex[1].length === 8 ? parseInt(hex[1].slice(6), 16) / 255 : 1
  const fn = /^[a-z-]+\(([\s\S]*)\)$/.exec(v)
  if (!fn) return 1
  const slash = fn[1].split('/')
  const commas = fn[1].split(',')
  const a = slash.length === 2 ? slash[1] : commas.length === 4 ? commas[3] : null
  return a === null ? 1 : share(a)
}

/** A number or a percentage as a share of 1. */
const share = (value: string): number => (/%\s*$/.test(value) ? Number.parseFloat(value) / 100 : Number.parseFloat(value))

/** What a filter leaves of an element's opacity: the amounts of its opacity() functions, each at most 1 and with none
 * given 1, multiplied; 1 where it has none. */
const filtered = (filter = 'none'): number => [...filter.matchAll(/\bopacity\(\s*([^)]*?)\s*\)/gi)].reduce((left, m) => left * (m[1] ? Math.min(1, share(m[1])) : 1), 1)

/** Whether an element and its text are drawn at all, read from it and every ancestor (the cascade has no inheritance):
 * none of them out of the layout or wholly transparent, by its opacity or a filter's, and the nearest of them to set
 * each its visibility visible, its text's colour not transparent and its font size not 0. */
function drawnAll(chain: El[], env: Env): boolean {
  const styles = chain.map((_, i) => style(chain.slice(0, i + 1), env))
  const nearest = (prop: string): string | undefined => styles.map((s) => s[prop]).filter((v) => v !== undefined && !['inherit', 'unset', 'currentcolor'].includes(v.toLowerCase())).at(-1)
  if (styles.some((s) => s.display === 'none' || (s.opacity !== undefined && share(s.opacity) <= 0) || filtered(s.filter) <= 0)) return false
  if (['hidden', 'collapse'].includes(nearest('visibility') ?? 'visible')) return false
  const color = nearest('color')
  return (color === undefined || (alpha(color) ?? 1) > 0) && px(nearest('font-size') ?? '1px') !== 0
}

/** A contrast theme's own colours. */
const SYSTEM = /^(Canvas|CanvasText|LinkText|VisitedText|ActiveText|ButtonFace|ButtonText|ButtonBorder|Field|FieldText|Highlight|HighlightText|SelectedItem|SelectedItemText|Mark|MarkText|GrayText|AccentColor|AccentColorText)$/i

/** A side's border as drawn: nothing, or its width, style and colour. */
function side(s: Record<string, string>, which: string): string {
  const [w, style, color] = ['width', 'style', 'color'].map((p) => s[`border-${which}-${p}`])
  return !w || px(w) === 0 || !style || ['none', 'hidden'].includes(style) ? 'nothing' : `${px(w)}px ${style} ${color}`
}

/** How many columns a list lays its children out in: one under another is one. */
function columns(s: Record<string, string>): number {
  const display = s.display ?? 'block'
  if (/flex/.test(display)) return /^column/.test(s['flex-direction'] ?? 'row') ? 1 : 3
  if (!/grid/.test(display)) return 1
  const template = s['grid-template-columns'] ?? 'none'
  if (template === 'none') return 1
  let n = 0
  for (const track of template.replace(/\[[^\]]*\]/g, ' ').match(/repeat\(\s*\d+\s*,(?:[^()]|\([^()]*\))*\)|\S+\([^()]*\)|\S+/g) ?? []) {
    const repeat = /^repeat\(\s*(\d+)\s*,([\s\S]*)\)$/.exec(track)
    n += repeat ? Number(repeat[1]) * columns({ display: 'grid', 'grid-template-columns': repeat[2].trim() }) : 1
  }
  return n
}

// Window widths and Spendable's card's content box in them: a phone's, a window just over 700 px beside the sidebar,
// a phone on its side, and the desktop's. Side by side, −$128,240 at 30 px needs a card of 483 px.
const STACKED = [
  [320, 254],
  [375, 309],
  [414, 348],
  [701, 413],
  [720, 432],
  [740, 452],
  [768, 480],
  [770, 482]
]
const SIDE_BY_SIDE = [
  [566, 500],
  [667, 601],
  [900, 612],
  [1100, 812],
  [1280, 924]
]

describe("Spendable's card", () => {
  test('its width alone decides how its head and its risks lay out', () => {
    // A size container on its width only, so its height is still its content's.
    for (const [window, card] of [...STACKED, ...SIDE_BY_SIDE]) assert.equal(risks(window, card).card['container-type'], 'inline-size', String(window))
  })

  test("too narrow for them side by side, its account and cushion go under its title where they don't fit beside it, and its risks one under another, each its name and its figure on a line, the chosen one marked at its left", () => {
    // Just over 700 px the account's name was cut; side by side a third of the card broke −$12,824 after its minus, or
    // ran −$123,456 under the next risk. At a phone's width they are drawn as they were before.
    for (const [window, card] of STACKED) {
      const s = risks(window, card)
      const at = `${window} wide, card ${card}`
      assert.deepEqual([s.top['flex-wrap'], px(s.top['row-gap'])], ['wrap', 8], at)
      assert.equal(columns(s.risks), 1, at)
      assert.deepEqual([s.tile.display, s.tile['flex-direction'], s.tile['align-items'], s.tile['justify-content']], ['flex', 'row', 'baseline', 'space-between'], at)
      assert.deepEqual([px(s.tile['column-gap']), ...['top', 'right', 'bottom', 'left'].map((p) => px(s.tile[`padding-${p}`]))], [12, 10, 14, 10, 12], at)
      assert.deepEqual([side(s.tile, 'top'), side(s.tile, 'left')], ['nothing', '2px solid transparent'], at)
      assert.deepEqual([side(s.on, 'top'), side(s.on, 'left')], ['nothing', '2px solid var(--copper)'], at)
      assert.ok(s.shown.label && s.shown.value, at)
      assert.equal(px(s.value['font-size']), 24, at)
    }
  })

  test('wide enough, its risks sit side by side as they always have on the desktop, the chosen one marked along its top', () => {
    for (const [window, card] of SIDE_BY_SIDE) {
      const s = risks(window, card)
      const at = `${window} wide, card ${card}`
      assert.equal(columns(s.risks), 3, at)
      assert.deepEqual([s.tile['flex-direction'], s.tile['align-items']], ['column', 'flex-start'], at)
      assert.deepEqual([px(s.tile['column-gap']), ...['top', 'right', 'bottom', 'left'].map((p) => px(s.tile[`padding-${p}`]))], [6, 12, 16, 14, 16], at)
      assert.deepEqual([side(s.tile, 'top'), side(s.tile, 'left')], ['2px solid transparent', 'nothing'], at)
      assert.deepEqual([side(s.on, 'top'), side(s.on, 'left')], ['2px solid var(--copper)', 'nothing'], at)
      assert.ok(s.shown.label && s.shown.value, at)
      assert.equal(px(s.value['font-size']), 30, at)
    }
  })

  test("a risk focused from the keyboard draws its ring inside itself, a pixel inside its mark, where neither the next risk's fill, the risks' clipped edge nor the ring covers anything, and the chosen risk's mark stays", () => {
    const SIDES = ['top', 'right', 'bottom', 'left']
    for (const [window, card] of [...STACKED, ...SIDE_BY_SIDE])
      for (const env of [{}, { light: true }, { forcedColors: true }, { forcedColors: true, light: true }]) {
        const s = risks(window, card, env, [':focus-visible'])
        const still = risks(window, card, env)
        for (const t of [s.tile, s.on]) {
          const at = `${window} wide ${JSON.stringify(env)}${t === s.on ? ', chosen' : ''}`
          const mark = Math.max(...SIDES.map((p) => px(t[`border-${p}-width`] ?? '0')))
          const ring = px(t['outline-width'])
          assert.deepEqual([ring, t['outline-style']], [2, 'solid'], at)
          // Drawn from -offset px inside the edge outward: its outer edge a pixel inside the mark's inner one, so the two
          // don't run together where they are one colour (in light, the focus colour is the mark's copper), its inner
          // edge inside the risk's padding.
          const offset = px(t['outline-offset'])
          assert.equal(offset, -(ring + mark) - 1, `${at}: offset ${t['outline-offset']} by a ${mark} px mark`)
          for (const p of SIDES) assert.ok(px(t[`border-${p}-width`] ?? '0') + px(t[`padding-${p}`] ?? '0') >= -offset, `${at}: the ring into the name or figure at its ${p}`)
          // In a contrast theme the ring is the risk's text's colour, unlike the chosen one's mark.
          assert.ok(env.forcedColors ? ['ButtonText', 'CanvasText'].includes(t['outline-color']) : t['outline-color'] === 'var(--focus)', `${at}: ${t['outline-color']}`)
          // Nothing else drawn over the mark.
          assert.ok([undefined, 'none'].includes(t['box-shadow']), `${at}: ${t['box-shadow']}`)
        }
        // Focused, either risk is still drawn, and its name and its figure.
        assert.deepEqual(Object.entries(s.shown).filter(([, v]) => !v).map(([k]) => k), [], `${window} wide ${JSON.stringify(env)}: a focused risk or its name or figure not drawn`)
        // Focused, the chosen risk is marked as it is unfocused: copper, or the theme's highlight.
        const at = `${window} wide ${JSON.stringify(env)}, chosen`
        assert.deepEqual(SIDES.map((p) => side(s.on, p)), SIDES.map((p) => side(still.on, p)), at)
        assert.ok(SIDES.some((p) => side(s.on, p) === `2px solid ${env.forcedColors ? 'Highlight' : 'var(--copper)'}`), at)
      }
    assert.equal(risks(375, 309).tile['outline-style'], undefined)
  })

  test("in a contrast theme, where every border takes the theme's one colour, the chosen risk's mark is the highlight and the others' marks take their fill", () => {
    for (const [stack, mark, plain] of [
      [STACKED, 'left', 'top'],
      [SIDE_BY_SIDE, 'top', 'left']
    ] as const)
      for (const [window, card] of stack)
        for (const light of [false, true])
          for (const states of [[], [':hover'], [':focus-visible'], [':hover', ':focus-visible']]) {
            const s = risks(window, card, { forcedColors: true, light }, states)
            const at = `${window} wide${light ? ', light' : ''} ${states}`
            assert.deepEqual([side(s.on, mark), side(s.on, plain)], ['2px solid Highlight', 'nothing'], at)
            // The others' marks the colour of their fill, as the chosen one's is.
            assert.deepEqual([side(s.tile, mark), side(s.tile, plain), s.on['background-color']], [`2px solid ${s.tile['background-color']}`, 'nothing', s.tile['background-color']], at)
          }
  })
})

/** A stand-in for the document, the menu control, the panel and what's behind it: what was focused, and the listeners now attached. */
function parts(current: boolean): { parts: MenuParts; focused: string[]; listeners: Map<string, (e: Event) => void>; inPanel: object; inControl: object; elsewhere: object; bar: { inert: boolean }; page: { inert: boolean } } {
  const focused: string[] = []
  const bar = { inert: false }
  const page = { inert: false }
  const listeners = new Map<string, (e: Event) => void>()
  const inPanel = {}
  const inControl = {}
  const elsewhere = {}
  const doc = {
    addEventListener: (type: string, fn: (e: Event) => void) => void listeners.set(type, fn),
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      if (listeners.get(type) === fn) listeners.delete(type)
    }
  } as unknown as MenuParts['doc']
  return {
    focused,
    listeners,
    inPanel,
    inControl,
    elsewhere,
    bar,
    page,
    parts: {
      doc,
      behind: [bar, page, null],
      // The control can only take focus once the top bar it sits on is no longer inert.
      control: { focus: () => void focused.push(bar.inert ? 'control (inert)' : 'control'), contains: (n) => n === (inControl as unknown) },
      panel: {
        contains: (n) => n === (inPanel as unknown),
        querySelector: (s) => (s === '[aria-current="page"]' ? (current ? { focus: () => void focused.push('current page') } : null) : s === 'button' ? { focus: () => void focused.push('first entry') } : null)
      }
    }
  }
}

/** An event as the listeners read it, which says whether its default was prevented. */
function event(fields: Record<string, unknown>): Event & { prevented: boolean } {
  const e = {
    prevented: false,
    ...fields,
    preventDefault: (): void => {
      e.prevented = true
    }
  }
  return e as unknown as Event & { prevented: boolean }
}

describe('the menu', () => {
  test('opening it moves focus to the page it marks as current, or to its first entry', () => {
    const a = parts(true)
    openMenu(a.parts, () => {})
    assert.deepEqual(a.focused, ['current page'])
    const b = parts(false)
    openMenu(b.parts, () => {})
    assert.deepEqual(b.focused, ['first entry'])
  })

  test('Escape closes it; another key does not', () => {
    const p = parts(true)
    let closed = 0
    openMenu(p.parts, () => closed++)
    const enter = event({ key: 'Enter' })
    p.listeners.get('keydown')!(enter)
    assert.equal(closed, 0)
    assert.equal(enter.prevented, false)
    const escape = event({ key: 'Escape' })
    p.listeners.get('keydown')!(escape)
    assert.equal(closed, 1)
    assert.equal(escape.prevented, true)
  })

  test('a tap outside closes it; a tap on an entry or on the control leaves the closing to them', () => {
    const p = parts(true)
    let closed = 0
    openMenu(p.parts, () => closed++)
    p.listeners.get('click')!(event({ target: p.inPanel }))
    p.listeners.get('click')!(event({ target: p.inControl }))
    assert.equal(closed, 0)
    p.listeners.get('click')!(event({ target: p.elsewhere }))
    assert.equal(closed, 1)
  })

  test('while it is open the top bar and the page behind it are inert, so Tab and Enter never reach what the scrim covers', () => {
    const p = parts(true)
    assert.equal(p.bar.inert, false)
    assert.equal(p.page.inert, false)
    const cleanup = openMenu(p.parts, () => {})
    assert.equal(p.bar.inert, true)
    assert.equal(p.page.inert, true)
    cleanup()
    assert.equal(p.bar.inert, false)
    assert.equal(p.page.inert, false)
  })

  test('as it closes it stops listening, gives the top bar and the page back, and puts focus back on the control', () => {
    const p = parts(true)
    const cleanup = openMenu(p.parts, () => {})
    assert.deepEqual([...p.listeners.keys()].sort(), ['click', 'keydown'])
    cleanup()
    assert.equal(p.listeners.size, 0)
    assert.deepEqual(p.focused, ['current page', 'control'])
  })
})
