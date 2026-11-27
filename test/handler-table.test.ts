import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The one handler table (src/main/handlers/table.ts) that the desktop's IPC
// and the hosted Ledger both run: the desktop registers every entry and its
// own Electron handlers, each method exactly once; a hosted call runs with the
// account's plan in force (license.ts withPlan), refuses what the web can't
// do, and answers the desktop's envelope.

const here = dirname(fileURLToPath(import.meta.url))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater') return { url: stub, format: 'module-typescript', shortCircuit: true }
    return next(specifier, context)
  }
})

const electron = await import('../scripts/demo-electron.ts')
const db = await import('../src/main/db.ts')
const { configureBuild } = await import('../src/main/devBuild.ts')
const { can, configureLicense, planState, withPlan } = await import('../src/main/license.ts')
const { aiEnabled } = await import('../src/main/ai/backend.ts')
const { answer, DESKTOP_ONLY, HANDLERS, methodKind, NOT_ON_WEB, PRELOAD_ONLY } = await import('../src/main/handlers/table.ts')
type HandlerContext = import('../src/main/handlers/context.ts').HandlerContext

const root = mkdtempSync(join(tmpdir(), 'finance-handlers-'))
after(() => {
  db.closeDb()
  rmSync(root, { recursive: true, force: true })
})
electron.setBase(root, '0.0.0-test')
configureBuild({ packaged: true })
configureLicense({ dev: true })
mkdirSync(electron.app.getPath('userData'), { recursive: true })
db.openDb(join(electron.app.getPath('userData'), 'finance.db'))

const events: Array<{ event: string; payload: unknown }> = []
const web = (plan: 'free' | 'trial' | 'plus'): HandlerContext => ({
  platform: 'web',
  plan: { plan, features: plan === 'free' ? [] : undefined },
  broadcast: (event, payload) => void events.push({ event, payload }),
  file: async (fileId) => {
    if (fileId !== 'f_test') throw new Error('File not found')
    return { fileId, name: 'bank.csv', type: 'text/csv', size: 40, bytes: async () => new TextEncoder().encode('Date,Description,Amount\n2026-10-01,TEA,-3.00\n') }
  },
  pickFile: async () => null,
  backup: async () => {},
  calendarChanged: () => {},
  syncIdle: async () => {},
  syncBanks: async () => ({ accounts: 0, added: 0, updated: 0, warnings: [] }),
  reviewCleared: () => {},
  themeChanged: () => {},
  appInfo: () => ({ version: '1', electron: '', chromium: '', os: '', dataPath: '', logPath: null, updates: false, supportEmail: '', platform: 'web' }),
  settings: () => ({ licenseTokenSaved: false, apiKeySource: 'none', simplefinConnected: false, bank: { available: true, connections: [] }, lastSyncAt: null, syncsLast24h: 0, historyFrom: null, historyComplete: false, syncWarnings: [], dataPath: '', database: { encrypted: false, switchable: false, switchOn: false, recoveryPending: false, keySeal: 'install' } }),
  folders: () => ({ dataDir: '', docsDir: '', docsDirLocked: true, extraDirs: [], recoveryPending: false })
})

describe('the handler table', () => {
  test('the desktop registers every entry and its own handlers, each once', async () => {
    const { registerIpc } = await import('../src/main/ipc.ts')
    registerIpc()
    const registered = [...electron.handlers.keys()].sort()
    // unlockDatabase is unlock.ts's, registered only while the database waits for its recovery code.
    const expected = [...Object.keys(HANDLERS), ...DESKTOP_ONLY.filter((m) => m !== 'unlockDatabase')].sort()
    assert.deepEqual(registered, expected)
    for (const m of PRELOAD_ONLY) assert.equal(methodKind(m), null)
  })

  test('the desktop answers through the table as before', async () => {
    const invoke = electron.handlers.get('listCategories')!
    const r = (await invoke({ senderFrame: { url: 'file:///app/index.html' } })) as { ok: boolean; data: Array<{ name: string }> }
    assert.equal(r.ok, true)
    assert.ok(r.data.some((c) => c.name === 'Groceries'))
    const info = (await electron.handlers.get('getAppInfo')!({ senderFrame: { url: 'file:///app/index.html' } })) as { data: { platform: string } }
    assert.equal(info.data.platform, 'desktop')
  })

  test('every entry says whether the web has it, and the plan feature it needs is a real one', async () => {
    const { FEATURES } = await import('../src/shared/plans.ts')
    const ids = new Set<string>(FEATURES.map((f) => f.id))
    for (const [name, def] of Object.entries(HANDLERS)) {
      assert.equal(typeof def.hosted, 'boolean', name)
      if ('feature' in def && def.feature) assert.ok(ids.has(def.feature), `${name}: ${def.feature}`)
    }
    assert.equal(methodKind('getSpendable'), 'hosted')
    assert.equal(methodKind('setCalendarTimeZone'), 'desktop')
    assert.equal(methodKind('csvPick'), 'desktop')
    assert.equal(methodKind('constructor'), null)
  })
})

describe('the account\'s plan in a hosted call', () => {
  test('planState and can read the scoped plan; outside it, the install\'s license as before', () => {
    assert.equal(planState().plan, 'plus')
    assert.equal(planState().dev, true)
    withPlan({ plan: 'free' }, () => {
      assert.equal(planState().plan, 'free')
      assert.equal(planState().dev, false)
      assert.equal(can('netWorth'), false)
      assert.equal(aiEnabled(), false)
    })
    withPlan({ plan: 'plus', features: ['net_worth'] }, () => {
      assert.equal(can('netWorth'), true)
      // A feature the account's list leaves out stays locked.
      assert.equal(can('ai'), false)
    })
    withPlan({ plan: 'trial', trialEndsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }, () => {
      assert.equal(planState().plan, 'trial')
      assert.equal(planState().trialDaysLeft, 3)
      assert.equal(can('taxes'), true)
    })
    assert.equal(can('netWorth'), true)
  })

  test('answer: the envelope, a plan refusal with its feature, desktop-only refused on the web', async () => {
    const r = await answer('listCategories', [], web('free'))
    assert.equal(r.ok, true)
    assert.deepEqual(await answer('getNetWorth', [], web('free')), { ok: false, error: 'plan', feature: 'netWorth' })
    assert.equal((await answer('getNetWorth', [], web('plus'))).ok, true)
    assert.deepEqual(await answer('setCalendarTimeZone', ['Europe/Paris'], web('plus')), { ok: false, error: NOT_ON_WEB })
    assert.deepEqual(await answer('csvPick', [], web('plus')), { ok: false, error: NOT_ON_WEB })
    const plan = await answer('getPlan', [], web('free'))
    assert.equal(plan.ok && (plan.data as { plan: string }).plan, 'free')
  })

  test('a write broadcasts through the context; an upload previews by its id', async () => {
    events.length = 0
    assert.equal((await answer('setSpendSettings', [{ cushionCents: 2500 }], web('free'))).ok, true)
    assert.deepEqual(events, [{ event: 'data:changed', payload: undefined }])
    const p = await answer('importPreview', ['f_test'], web('free'))
    assert.equal(p.ok, true)
    assert.deepEqual((p as { data: { headers: string[]; rowCount: number } }).data.headers, ['Date', 'Description', 'Amount'])
    assert.deepEqual(await answer('importPreview', ['f_nope'], web('free')), { ok: false, error: 'File not found' })
  })
})

describe("the phone's methods (sub-phase 2h)", () => {
  const month = db.dayKey(db.now()).slice(0, 7)
  // Every ledger method the phone calls (finance-mobile/lib/api/hosted.dart), with arguments as it sends them.
  const PHONE: ReadonlyArray<[method: string, args: unknown[]]> = [
    ['bankSync', []],
    ['finishOnboarding', []],
    ['getAlertPrefs', []],
    ['getHomePlans', []],
    ['getInsight', [{ force: false }]],
    ['getOnboarding', []],
    ['getSettings', []],
    ['getSpendable', []],
    ['getWaterfall', [{ from: month, to: month }]],
    ['listAccounts', []],
    ['listCategories', []],
    ['listContributions', []],
    ['listTransactions', [{ ids: [], limit: 50, offset: 0 }]],
    ['setAlertPrefs', [{ showAmounts: false }]],
    ['setSettings', [{ homeOpen: 'leftOver' }]],
    ['setSpendSettings', [{ cushionCents: 0 }]],
    ['updateTransaction', ['no-such-transaction', { categoryId: null, remember: false }]]
  ]
  // What only the phone's budget screen, lead step, preset picker and Spending by category called, gone with them.
  const REMOVED = ['getBudget', 'setBudget', 'setBudgetRollover', 'commitHabit', 'hideHabit', 'setDashboardLayout', 'getRangeSummary']

  test("the list is the phone's own (where the phone's source is in the tree)", (t) => {
    const dart = join(here, '..', '..', 'finance-mobile', 'lib', 'api', 'hosted.dart')
    if (!existsSync(dart)) return t.skip('finance-mobile is not in this tree')
    const called = [...new Set([...readFileSync(dart, 'utf8').matchAll(/call\('(\w+)'/g)].map((m) => m[1]))].sort()
    assert.deepEqual(called, PHONE.map(([m]) => m).sort())
  })

  test('each answers on the free plan and on Plus: hosted, and none refused by the plan', async () => {
    for (const plan of ['free', 'plus'] as const) {
      for (const [m, args] of PHONE) {
        assert.equal(methodKind(m), 'hosted', m)
        const r = await answer(m, args, web(plan))
        // A transaction that isn't there is the handler's own refusal, as the phone's list never sends one.
        if (m === 'updateTransaction') assert.deepEqual(r, { ok: false, error: 'Transaction not found' }, plan)
        else assert.equal(r.ok, true, `${m} on ${plan}: ${JSON.stringify(r)}`)
      }
    }
    // What Home opens on is the books' setting, set the one way, and read back by the next settings read.
    const s = await answer('getSettings', [], web('free'))
    assert.ok(s.ok)
    assert.equal((s.data as { homeOpen: unknown }).homeOpen, 'leftOver')
    assert.equal('dashboardLayout' in (s.data as object), false)
    db.setSetting('home.open', null)
  })

  test('what only the phone called is gone: no entry in the table, the Api or the preload, and a call to one is an unknown method', async () => {
    for (const m of REMOVED) {
      assert.equal(methodKind(m), null, m)
      assert.ok(!(m in HANDLERS), m)
      assert.deepEqual(await answer(m, [], web('free')), { ok: false, error: NOT_ON_WEB }, m)
    }
    // Review sets what they set: a target and its rollover, a habit's commitment, and hiding one (tools.ts).
    const { TOOLS } = await import('../src/main/tools.ts')
    const tools = new Set(TOOLS.map((t) => t.name))
    for (const tool of ['set_category_target', 'commit_habit']) assert.ok(tools.has(tool), tool)
  })
})
