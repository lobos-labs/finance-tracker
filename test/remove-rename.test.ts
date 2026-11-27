import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account } from '../src/shared/types.ts'

// Remove and rename (waterfall spec sub-phase 2e): the Budget, Recurring and Layout pages and the Dashboard's layout
// module are gone, with what only they used; nothing in src/ names a layout or a preset but migration 44's delete
// (the phone's setDashboardLayout went in sub-phase 2h); the sidebar is section 4's nine entries; every write the deleted pages
// offered is a Review tool; Review labels every issue kind; and Accounts shows a cash account's role as data.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The handlers' modules import Electron: the demo dump's stand-in takes its place. The renderer's .tsx load through
// the same transform the app's bundler uses (Vite's Rolldown), so a page's component renders here as it does there.
const viteRequire = createRequire(import.meta.resolve('vite'))
const { transformSync } = (await import(pathToFileURL(viteRequire.resolve('rolldown/utils')).href)) as typeof import('rolldown/utils')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
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
Object.assign(globalThis, { window: { api: {} }, location: new URL('file:///app/index.html') })

const { HANDLERS, methodKind } = await import('../src/main/handlers/table.ts')
const { TOOLS } = await import('../src/main/tools.ts')
const { JOURNAL } = await import('../src/main/journal.ts')
const { AccountFacts, CASH_ROLE_LABEL } = await import('../src/renderer/src/pages/Accounts.tsx')

const source = (path: string): string => readFileSync(join(root, path), 'utf8')
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const rel = (f: string): string => f.slice(root.length + 1).replaceAll('\\', '/')

describe('the deleted pages and the Dashboard layout', () => {
  test('the files are gone, and nothing in src/ names a layout or a preset', () => {
    // Recurring's money flow went with sub-phase 2d (test/flow.test.ts), which keeps its name out of every file.
    for (const f of ['pages/Budget.tsx', 'pages/Recurring.tsx', 'pages/LayoutEditor.tsx', 'pages/Dashboard.tsx', 'pages/DebtCard.tsx']) assert.equal(existsSync(join(root, 'src/renderer/src', f)), false, f)
    assert.equal(existsSync(join(root, 'src/shared/dashboard.ts')), false)
    const LAYOUT = /\b(DashboardLayout|DASHBOARD_PRESETS|DASHBOARD_CARDS|DashboardPreset|DashboardCard|normalizeLayout|layoutRows|LayoutEditor|DEFAULT_LAYOUT|dashboardLayout)\b|shared\/dashboard|pages\/Budget|pages\/Recurring|\.\/(Budget|Recurring|LayoutEditor)'/
    const files = walk(join(root, 'src'))
    assert.ok(files.length > 200, `only ${files.length} files in src/`)
    const named = files.flatMap((f) => source(rel(f)).split('\n').flatMap((l, i) => (LAYOUT.test(l) ? [`${rel(f)}:${i + 1}`] : [])))
    assert.deepEqual(named, [])
    // dashboard.layout is named once, by migration 44's delete.
    const setting = files.flatMap((f) => source(rel(f)).split('\n').flatMap((l) => (l.includes('dashboard.layout') ? [`${rel(f)}: ${l.trim()}`] : [])))
    assert.deepEqual(setting, ["src/main/db.ts: DELETE FROM settings WHERE key = 'dashboard.layout';"])
    // The phone's one leftover, setDashboardLayout, went with its lead step and preset picker (sub-phase 2h).
    assert.deepEqual(files.filter((f) => source(rel(f)).includes('setDashboardLayout')).map(rel), [])
  })

  test('what only the deleted pages and the Dashboard used is gone with them', () => {
    // The Layout and Recurring pages' up and down arrows, the Budget page's hidden-numbers check and its ranges
    // shifted by a saving. The check is exported again only while something asks it (now Spendable's chart, which
    // places its labels as wide as they draw), and gone with it is fine too.
    assert.doesNotMatch(source('src/renderer/src/Icon.tsx'), /\barrow(Up|Down):/)
    const askers = walk(join(root, 'src/renderer')).filter((f) => /import \{[^}]*\bnumbersHidden\b[^}]*\} from '(\.\.?\/)+lib'/.test(readFileSync(f, 'utf8'))).map(rel)
    if (/export const numbersHidden\b/.test(source('src/renderer/src/lib.ts'))) assert.ok(askers.length > 0, 'lib exports numbersHidden with nothing importing it')
    assert.doesNotMatch(source('src/shared/ranges.ts'), /\bshifted\b/)
    // The Dashboard's headline block, its hero figure and its net worth figure: Home's headline is .home-headline.
    const css = source('src/renderer/src/styles.css')
    for (const selector of ['.headline', '.headline-text', '.headline-detail', '.headline-meta', '.tile-value.hero', '.networth-value']) {
      assert.doesNotMatch(css, new RegExp(`(^|[\\s,])${selector.replaceAll('.', '\\.')}(?![\\w-])`, 'm'), selector)
    }
    assert.doesNotMatch(css, /dashboard/i)
  })

  test("the sidebar is section 4's nine entries, with Net worth's six and Records' three", () => {
    const app = source('src/renderer/src/App.tsx')
    const nav = /const NAV: NavItem\[\] = \[([\s\S]*?)\n\]\n/.exec(app)![1]
    assert.deepEqual(
      [...nav.matchAll(/\{\s*id: '(\w+)',\s+label: '([^']+)'/g)].map((m) => m[2]),
      ['Home', 'Review', 'Transactions', 'Calendar', 'Net worth', 'Records', 'Ventures', 'Accounts', 'Settings']
    )
    const views = [.../export const NET_VIEWS[^=]*= \[([\s\S]*?)\]/.exec(source('src/renderer/src/pages/NetWorth.tsx'))![1].matchAll(/label: '([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(views, ['Overview', 'Investments', 'Property', 'Debts'])
    assert.match(nav, /label: 'Net worth', [^\n]*children: \[\.\.\.NET_VIEWS\.map\([^\n]*\), \{ label: 'Goals', page: 'goals' \}, \{ label: 'Credit', page: 'credit' \}\] \},\n/)
    assert.deepEqual([.../id: 'records'[\s\S]*?children: \[([\s\S]*?)\]/.exec(nav)![1].matchAll(/label: '([^']+)'/g)].map((m) => m[1]), ['Pay & benefits', 'Insurance', 'Taxes'])
    // Review and Transactions carry their badges.
    assert.match(app, /p === 'review' && openItems > 0 && <span className="nav-badge"/)
    assert.match(app, /p === 'transactions' && uncategorized > 0 && <span className="nav-badge"/)
  })

  test('every write the Budget and Recurring pages offered is a Review tool, journaled; the ones only they called are out of the table', () => {
    const tools = new Map(TOOLS.map((t) => [t.name, t]))
    const props = (name: string): string[] => Object.keys((tools.get(name)!.input_schema as { properties: Record<string, unknown> }).properties)
    // Each page write (Api method) and the tool, with the field, that does it now.
    const WRITES: Array<[string, string, string]> = [
      ['setBudget', 'set_category_target', 'amount'],
      ['setBudgetRollover', 'set_category_target', 'rollover'],
      ['setBudgetTier', 'set_category_tier', 'tier'],
      ['commitHabit', 'commit_habit', 'option'],
      ['hideHabit', 'commit_habit', 'hide'],
      ['setOneOffBudget', 'set_one_off_budget', 'amount'],
      ['setCheaperStore', 'set_cheaper_store', 'store'],
      ['updateRecurring', 'update_recurring', 'status'],
      ['updateRecurring', 'update_recurring', 'kind']
    ]
    for (const [method, tool, field] of WRITES) {
      assert.ok(tools.has(tool), `${method}: ${tool}`)
      assert.equal(tools.get(tool)!.risk, 'write', tool)
      assert.ok(props(tool).includes(field), `${tool}.${field}`)
      assert.ok(tool in JOURNAL, `${tool} is journaled`)
    }
    // A confirm or a dismiss taken back, as the page's toggles did: status null.
    assert.deepEqual((tools.get('update_recurring')!.input_schema as { properties: { status: { enum: unknown[] } } }).properties.status.enum, ['confirmed', 'dismissed', null])
    // No caller is left for these, so they're gone: the pages' own writes here, and the five the phone's budget screen
    // kept and its setDashboardLayout with its Budget tab in sub-phase 2h (test/handler-table.test.ts). getSpendable,
    // listContributions and listRecurring stay for Home, Calendar, Pay & benefits and the next 30 days.
    // The browser demo's key list, where this tree has the demo (the public export's leaves it out).
    const demoKeys = existsSync(join(root, 'src/renderer/src/demo/keys.ts')) ? source('src/renderer/src/demo/keys.ts') : ''
    for (const m of ['setBudgetTier', 'setCheaperStore', 'setOneOffBudget', 'updateRecurring', 'getBudget', 'setBudget', 'setBudgetRollover', 'commitHabit', 'hideHabit', 'setDashboardLayout']) {
      assert.equal(methodKind(m), null, m)
      assert.ok(!(m in HANDLERS), m)
      assert.doesNotMatch(source('src/preload/index.ts'), new RegExp(`\\b${m}\\b`), m)
      assert.doesNotMatch(demoKeys, new RegExp(`'${m}'`), m)
    }
    for (const m of ['getSpendable', 'listContributions', 'listRecurring', 'getHomePlans']) assert.equal(methodKind(m), 'hosted', m)
  })

  test("Review's issue list has a label for every kind of issue", () => {
    const tools = source('src/main/tools.ts')
    const kinds = [.../type IssueKind =([\s\S]*?)\n\n/.exec(tools)![1].matchAll(/'(\w+)'/g)].map((m) => m[1])
    assert.ok(kinds.length >= 23, kinds.join(', '))
    for (const k of ['paystub_mismatch', 'paystub_missing', 'loan_payment_unlinked', 'asset_attach']) assert.ok(kinds.includes(k), k)
    const page = source('src/renderer/src/pages/Review.tsx')
    const block = /const ISSUE_LABEL[^{]*\{([^}]*)\}/.exec(page)![1]
    const labels = new Map([...block.matchAll(/^\s*(\w+): (['"])(.+)\2,?$/gm)].map((m) => [m[1], m[3]]))
    assert.deepEqual(kinds.filter((k) => !labels.has(k)), [])
    // Each is the kind in words, and no two read alike.
    assert.equal(new Set(labels.values()).size, labels.size)
    for (const [k, label] of labels) assert.ok(label.length > 3 && !label.includes('_'), `${k}: ${label}`)
  })
})

describe("Accounts: a cash account's role", () => {
  const account = (o: Partial<Account>): Account =>
    ({ id: 'a', source: 'csv', name: 'Main', institution: 'Harbor Bank', currency: 'USD', balanceCents: 0, availableCents: null, balanceDate: null, assetType: 'cash', txnCount: 1204, historyFrom: null, closedDay: null, cashRole: null, ...o }) as Account

  test('Checking or Savings on each cash account, as data ahead of where it comes from; nothing on any other account', () => {
    assert.deepEqual(CASH_ROLE_LABEL, { spending: 'Checking', saving: 'Savings' })
    const facts = (a: Account): string => renderToStaticMarkup(createElement(AccountFacts, { account: a }))
    assert.equal(facts(account({ cashRole: 'spending' })), '<div class="label-muted truncate" style="margin-top:3px">Checking · Harbor Bank · 1,204 txns</div>')
    assert.equal(facts(account({ cashRole: 'saving', source: 'manual', institution: null })), '<div class="label-muted truncate" style="margin-top:3px">Savings · Manual</div>')
    // A card, a loan or an investment has no role (db.ts gives one only to cash).
    assert.equal(facts(account({ assetType: 'credit_card', cashRole: null })), '<div class="label-muted truncate" style="margin-top:3px">Harbor Bank · 1,204 txns</div>')
    // Data only: Review sets the role (set_account_role), so the page has nothing to set it with.
    for (const html of [facts(account({ cashRole: 'spending' })), facts(account({ cashRole: 'saving' }))]) assert.doesNotMatch(html, /<input|<select|<button/)
    const page = source('src/renderer/src/pages/Accounts.tsx')
    assert.match(page, /<AccountFacts account=\{a\} \/>/)
    // At a phone's width the name and its facts take the row, so the role is never squeezed out by the buttons.
    assert.match(page, /<div className="list-row acct-row"/)
    assert.match(source('src/renderer/src/styles.css'), /@media \(max-width: 700px\) \{[^@]*\.list-row\.acct-row \{\s*flex-wrap: wrap;\s*\}\s*\.list-row\.acct-row > \.grow \{\s*flex-basis: 100%;/)
    // The balance is a column of its own on the right; at a phone's width it starts the next line, under the name, as
    // wide as its figure (so it lines up with the name, not in the middle of the row).
    assert.doesNotMatch(page, /width: 140/)
    assert.equal([...page.matchAll(/className="[^"]*\bacct-balance\b/g)].length, 2)
    assert.match(source('src/renderer/src/styles.css'), /@media \(max-width: 700px\) \{[^@]*\.list-row\.acct-row > \.acct-balance \{\s*width: auto;\s*justify-content: flex-start;\s*text-align: left;/)
    assert.doesNotMatch(page, /cashRole:|cash_role|setCashRole/)
  })
})
