import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { HandlerContext } from '../src/main/handlers/context.ts'
import type { ContributionSummary, HomePlans, Spendable, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { household, TODAY } from './fixtures/waterfall-household.ts'

// The phone's household contract (waterfall spec sub-phase 2h, in place of the spec's sync vectors, which went with
// the phone's relay companion): what the hosted ledger answers the phone's Home and drills for section 5's household,
// on its day and over its closed month, as POST /v1/ledger/rpc sends it, is finance-mobile's
// test/fixtures/household_waterfall.json, which the phone's tests render Home from through their fake API. Beside it,
// household_home.json holds every line the desktop's Home draws from the same answers, each open row and view, which
// the phone's port of homeView.ts (finance-mobile/lib/domain/home_view.dart) has to draw the same. household_more.json
// holds the same for the paths the household doesn't take: the household with no paystub and with Unsorted at 86.00
// (the ledger's answers), and its own answer with Unexplained beyond tolerance and Growth below zero. This test fails
// when the engine's answer or the desktop's lines move from the files. Rewrite them with:
//   HOUSEHOLD_FIXTURE=write node --import ./test/ts-esm.mjs --test test/household-contract.test.ts

const here = dirname(fileURLToPath(import.meta.url))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})

const db = await import('../src/main/db.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { answer } = await import('../src/main/handlers/table.ts')
const view = await import('../src/renderer/src/pages/homeView.ts')
type HomeLine = import('../src/renderer/src/pages/homeView.ts').HomeLine

configureLicense({ dev: true })

const PHONE = join(here, '..', '..', 'finance-mobile')
const ANSWERS = join(PHONE, 'test', 'fixtures', 'household_waterfall.json')
const LINES = join(PHONE, 'test', 'fixtures', 'household_home.json')
const MORE = join(PHONE, 'test', 'fixtures', 'household_more.json')
const write = process.env.HOUSEHOLD_FIXTURE === 'write'
const REWRITE = 'rewrite it with: HOUSEHOLD_FIXTURE=write node --import ./test/ts-esm.mjs --test test/household-contract.test.ts'

/** The household's span: its closed month, Home's default on its day. */
const SPAN = view.defaultSpan(TODAY)

const web = (): HandlerContext =>
  ({
    platform: 'web',
    plan: { plan: 'plus' },
    broadcast: () => {},
    syncIdle: async () => {},
    settings: () => ({ licenseTokenSaved: false, apiKeySource: 'none', simplefinConnected: false, bank: { available: true, connections: [] }, lastSyncAt: null, syncsLast24h: 0, historyFrom: null, historyComplete: false, syncWarnings: [], dataPath: '', database: { encrypted: false, switchable: false, switchOn: false, recoveryPending: false, keySeal: 'install' } })
  }) as unknown as HandlerContext

/** A method's data as the ledger's route sends it: the envelope's data, through JSON. */
async function sent(method: string, ...args: unknown[]): Promise<unknown> {
  const r = await answer(method, args, web())
  assert.ok(r.ok, `${method}: ${!r.ok && r.error}`)
  return JSON.parse(JSON.stringify(r.data ?? null))
}

/**
 * A line of the desktop's Home as text, in the order the phone's HomeLine.cells writes its own. The phone draws all
 * of Home's lines but the links to the desktop's own pages (Pay & benefits, Taxes, Investments, Net worth), so those
 * are left out here. Take-home's Contributions is a slot both draw from listContributions beside the lines. A changed
 * month's closed figures (the closed lines) don't arise here: the household's October is open.
 */
function cells(l: HomeLine): string[] | null {
  switch (l.kind) {
    case 'row':
      return ['row', l.name, l.less ? 'less' : '', l.amount, l.perMonth ?? '', l.runRate, l.rate, l.change, l.pts ?? '', l.focus ? 'focus' : '', l.open ? 'open' : '', l.to ?? '', (l.spark ?? []).join(',')]
    case 'part':
      return ['part', l.name, l.tag ?? '', l.amount, l.perMonth ?? '', l.runRate, l.change, l.note ?? '', l.nested ? 'nested' : '']
    case 'data':
      return l.key === 'pages' ? null : ['data', l.label, l.text, l.to ?? '']
    case 'payTable':
      return ['payTable', l.name, l.checks.map((c) => c.label).join(' | '), ...l.rows.map((r) => `${r.label}: ${r.cells.join(' | ')}`), l.tied ? 'tied' : '']
    case 'group':
      return ['group', l.name, l.amount, l.perMonth ?? '', l.runRate, l.change, l.label, l.open ? 'open' : '']
    case 'switch':
      return ['switch', l.key, l.value]
    case 'slot':
      return ['slot', l.key]
    case 'account':
      return ['account', l.name, l.note, l.amount, l.perMonth ?? '', l.runRate]
    case 'unsorted':
      return ['unsorted', String(l.count), l.amount, l.focus ? 'focus' : '']
    case 'unexplained':
      return ['unexplained', l.amount, l.focus ? 'focus' : '']
    case 'closed':
      return ['closed', l.name, l.now, l.closed, l.change]
  }
}

/**
 * Every view the phone draws: no row open, each row open, Unexplained open when it shows, and with [toggles] each
 * Committed group open, By date and the payees.
 */
function views(w: Waterfall, plans: HomePlans, spend: Spendable, toggles = true): Record<string, string[][]> {
  const nextDays = view.nextDays(spend.items)
  const lines = (open: (typeof view.MAIN_ROWS)[number] | 'unexplained' | null, o: Parameters<typeof view.homeTable>[3] = {}): string[][] =>
    view
      .homeTable(w, open, new Map(), { plans, nextDays, ...o })
      .lines.map(cells)
      .filter((c): c is string[] => c !== null)
  const groups = view.GROUP_ORDER.filter((g) => (w.rows.find((r) => r.id === 'committed')?.parts ?? []).some((p) => (p.group ?? 'other') === g))
  return {
    none: lines(null),
    ...Object.fromEntries(view.MAIN_ROWS.map((id) => [id, lines(id)])),
    ...(toggles
      ? {
          ...Object.fromEntries(groups.map((g) => [`elective:${g}`, lines('elective', { group: g })])),
          'elective:byDate': lines('elective', { electiveView: 'byDate' }),
          'leftOver:payees': lines('leftOver', { leftOverView: 'payees' })
        }
      : {}),
    ...(view.unexplainedAbove(w) || w.focus === 'unexplained' ? { unexplained: lines('unexplained') } : {})
  }
}

/** The household on a new ledger, a manual account's random id numbered so the answer is the same each run. */
function build(o: Parameters<typeof household>[0] = {}): void {
  const crypto = createRequire(import.meta.url)('node:crypto') as { randomUUID: () => string }
  const random = crypto.randomUUID
  let n = 0
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  syncBuiltinESMExports()
  try {
    household(o)
  } finally {
    crypto.randomUUID = random
    syncBuiltinESMExports()
  }
}

/**
 * Section 5's household with Unexplained beyond its tolerance (below zero) and holding the focus, with its items (a
 * balance gap, a one-sided transfer, an engine error with nothing in it), Growth below zero and Invested with no
 * rate: the paths the household itself doesn't take, on the same answer.
 */
function unexplained(w: Waterfall): Waterfall {
  const x = structuredClone(w)
  x.identity.unexplainedCents = -6_249
  x.months = x.months.map((m) => ({ ...m, unexplainedCents: -6_249 }))
  x.leaks = [
    { kind: 'balance_gap', cents: -5_049, accountId: 'csv:chk', fromDay: '2026-10-03', toDay: '2026-10-17' },
    { kind: 'orphan_transfer', cents: -1_200, accountId: 'csv:sav', txnIds: ['wf1'] },
    { kind: 'engine_error', cents: 0 }
  ]
  x.focus = 'unexplained'
  const growth = x.rows.find((r) => r.id === 'growth')!
  Object.assign(growth, { actualCents: -1_234_500, runRateCents: -98_750, trend: growth.trend.map((t) => ({ ...t, runRateCents: t.runRateCents === null ? null : 0 - t.runRateCents })) })
  Object.assign(x.rows.find((r) => r.id === 'invested')!, { rate: null, rateChangePts: null })
  return x
}

/** What the ledger answers Home for a household made by [make], over its closed month, and its lines. */
type Case = { getWaterfall: Waterfall; getHomePlans: HomePlans; views: Record<string, string[][]> }
const NO_SPEND = { items: [] } as unknown as Spendable

describe("the phone's household contract", () => {
  let answers: { today: string; span: { from: string; to: string }; getWaterfall: Waterfall; getHomePlans: HomePlans; getSpendable: Spendable; listContributions: ContributionSummary; getSettings: { homeOpen: string | null } }
  let lines: Record<string, string[][]>
  let more: Record<string, Case>
  before(async () => {
    const [Y, M, D] = TODAY.split('-').map(Number)
    mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
    // A manual account's id is random (db.ts addManualAccount): numbered, so the answer is the same each run.
    build()
    // The phone's widget test opens Home on Left over, as setup's Home step's Where my money goes does.
    await sent('setSettings', { homeOpen: 'leftOver' })
    const settings = (await sent('getSettings')) as { homeOpen: string | null }
    answers = {
      today: TODAY,
      span: SPAN,
      getWaterfall: (await sent('getWaterfall', SPAN)) as Waterfall,
      getHomePlans: (await sent('getHomePlans')) as HomePlans,
      getSpendable: (await sent('getSpendable')) as Spendable,
      listContributions: (await sent('listContributions')) as ContributionSummary,
      getSettings: { homeOpen: settings.homeOpen }
    }
    lines = views(answers.getWaterfall, answers.getHomePlans, answers.getSpendable)
    // The paths the household doesn't take, each over the same October: no paystub (Gross pay its deposits alone, so
    // no Gross pay row and Take-home standing for it), Unsorted at 86.00 with the focus, and Unexplained beyond
    // tolerance with Growth below zero (on the household's own answer). Their drills read no forecast.
    const of = (w: Waterfall, plans: HomePlans): Case => ({ getWaterfall: w, getHomePlans: plans, views: views(w, plans, NO_SPEND, false) })
    const at = async (o: Parameters<typeof household>[0]): Promise<Case> => {
      build(o)
      return of((await sent('getWaterfall', SPAN)) as Waterfall, (await sent('getHomePlans')) as HomePlans)
    }
    more = {
      deposits: await at({ paystubs: false }),
      unsorted86: await at({ unsorted86: true }),
      unexplained: of(unexplained(answers.getWaterfall), answers.getHomePlans)
    }
    if (write && existsSync(PHONE)) {
      mkdirSync(dirname(ANSWERS), { recursive: true })
      writeFileSync(ANSWERS, `${JSON.stringify(answers, null, 1)}\n`)
      writeFileSync(LINES, `${JSON.stringify(lines, null, 1)}\n`)
      writeFileSync(MORE, `${JSON.stringify(more, null, 1)}\n`)
    }
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("the ledger's answers are the phone's fixture, as the hosted ledger sends them", (t) => {
    if (!existsSync(PHONE)) return t.skip('finance-mobile is not in this tree')
    assert.deepStrictEqual(JSON.parse(readFileSync(ANSWERS, 'utf8')), answers, `finance-mobile/test/fixtures/household_waterfall.json is not what the ledger answers: ${REWRITE}`)
  })

  test("the desktop's Home lines are the phone's fixture, each open row and view", (t) => {
    if (!existsSync(PHONE)) return t.skip('finance-mobile is not in this tree')
    assert.deepStrictEqual(JSON.parse(readFileSync(LINES, 'utf8')), lines, `finance-mobile/test/fixtures/household_home.json is not what the desktop's Home draws: ${REWRITE}`)
  })

  test("the paths the household doesn't take are the phone's fixture too, each view as the desktop's Home draws it", (t) => {
    if (!existsSync(PHONE)) return t.skip('finance-mobile is not in this tree')
    assert.deepStrictEqual(JSON.parse(readFileSync(MORE, 'utf8')), more, `finance-mobile/test/fixtures/household_more.json is not what the desktop answers and draws: ${REWRITE}`)
  })

  test('each of them takes its own path: no Gross pay, Unsorted with the focus, Unexplained open with its items and Growth below zero', () => {
    const rowsOf = (c: Case): string[] => c.views.none.filter((l) => l[0] === 'row').map((l) => l[1])
    assert.deepEqual(rowsOf(more.deposits), ['Take-home', 'Elective', 'Left over', 'Saved', 'Invested', 'Growth'])
    // Take-home stands for Gross pay: its drill lists where the money came from, and the pay-day table its deposits.
    const takeHome = more.deposits.views.takeHome
    assert.deepEqual(takeHome[1].slice(0, 2), ['part', 'Brightline Payroll'])
    assert.deepEqual(takeHome.find((l) => l[0] === 'payTable')?.slice(2, 4), ['Oct 15 | Oct 31', 'Deposit: 1,888.50 | 1,888.50'])
    assert.deepEqual(more.unsorted86.views.none.find((l) => l[0] === 'unsorted'), ['unsorted', '3', '−86', 'focus'])
    const u = more.unexplained.views
    assert.deepEqual(u.none.find((l) => l[0] === 'unexplained'), ['unexplained', '−62', 'focus'])
    assert.deepEqual(
      u.unexplained.filter((l) => l[0] === 'data'),
      [
        ['data', 'Balance gap', 'csv:chk · Oct 3 – Oct 17 · −50', ''],
        ['data', 'One-sided transfer', 'csv:sav · −12', '']
      ]
    )
    assert.deepEqual(u.none.find((l) => l[1] === 'Growth')?.slice(3, 8), ['−12,345', '', '−988', '0.5%', ''])
    assert.deepEqual(u.none.find((l) => l[1] === 'Invested')?.[6], '')
  })

  test("the answers are section 5's household: its rows, Left over's month, Δ pts and top lever, and the phone opens it", () => {
    const w = answers.getWaterfall
    assert.deepEqual([w.span, w.endMonth, w.focus, answers.getSettings.homeOpen], [{ from: '2026-10', to: '2026-10' }, '2026-10', 'leftOver', 'leftOver'])
    const t = view.homeTable(w, 'leftOver', new Map(), { plans: answers.getHomePlans })
    const rows = t.lines.filter((l) => l.kind === 'row' && !l.less).map((l) => l.kind === 'row' && [l.name, l.runRate, l.rate, l.change])
    assert.deepEqual(rows, [
      ['Gross pay', '6,000', '', '0'],
      ['Take-home', '3,777', '63.0%', '0'],
      ['Elective', '1,571', '41.6%', '−35'],
      ['Left over', '551', '35.1%', '−105'],
      ['Saved', '1,189', '18.9%', '−120'],
      ['Invested', '1,138', '95.8%', '0'],
      ['Growth', '1,200', '0.5%', '']
    ])
    const left = t.lines.find((l) => l.kind === 'row' && l.id === 'leftOver')
    assert.ok(left?.kind === 'row')
    assert.deepEqual([left.amount, left.pts, view.leverLine(w.levers, 'leftOver', 1)], ['438', '−5.8 pts', 'Dining Out over target 78/mo +5.0 pts'])
  })

  test("the phone's Home step and Settings' Home choice are the desktop wizard's, aim for aim (where the phone's source is in the tree)", (t) => {
    const dart = join(PHONE, 'lib', 'domain', 'home_view.dart')
    if (!existsSync(dart)) return t.skip('finance-mobile is not in this tree')
    const choices = [...readFileSync(dart, 'utf8').matchAll(/\(open: (null|'(\w+)'), label: '([^']+)'\)/g)].map((m) => ({ open: m[2] ?? null, label: m[3] }))
    assert.deepEqual(choices, view.HOME_CHOICES)
  })
})
