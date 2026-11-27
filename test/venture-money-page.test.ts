import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OwnerMoney } from '../src/shared/types.ts'
import { budgetRatio, busyMs, paired, within } from './cost.ts'
import { noonOn } from './days.ts'

// The venture's books and the Ventures page (waterfall spec addendum 1.11, sub-phase 1j part 5). A venture's
// operating changes only where money between it and Personal met it: its own leg of a transfer with Personal leaves
// operating for a loan, equity, a reimbursement and the rest, whatever its category; salary and trade count in it
// whatever theirs; a repayment's interest is its cost or its income; and pay the paycheck clause keeps the user's is
// never the venture's. The Ventures page shows each venture's share, basis, stake, position, owner money and boundary
// lines as the addendum draws example B, the list its share and position, and Net worth's Ventures group each
// venture's row. On Kestrel Studio (test/fixtures/venture-money.ts: examples B, E and F), a paycheck account a venture
// holds (example H) and the demo.

const here = dirname(fileURLToPath(import.meta.url))
const stub = pathToFileURL(join(here, '..', 'scripts', 'demo-electron.ts')).href

// The renderer's .tsx load through the same transform the app's bundler uses (Vite's Rolldown), and its pages read
// window.api as the app's window has it, so a component renders here as it does on the page.
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

const db = await import('../src/main/db.ts')
const { configureLicense } = await import('../src/main/license.ts')
const { loadDemoData } = await import('../src/main/demo.ts')
const { getBalanceSheet } = await import('../src/main/netWorth.ts')
const { runAssistantTool, runTool } = await import('../src/main/tools.ts')
const { positionBook, positionsOn } = await import('../src/main/ventureMoney.ts')
const { getVenture, listVentures } = await import('../src/main/ventures.ts')
const { getWaterfall } = await import('../src/main/waterfall.ts')
const view = await import('../src/renderer/src/pages/ventureView.ts')
const { VentureOwner } = await import('../src/renderer/src/pages/VentureOwner.tsx')
// Net worth's page and the app import each other: the app first, as the renderer loads them.
await import('../src/renderer/src/App.tsx')
const { GroupRows } = await import('../src/renderer/src/pages/NetWorth.tsx')
const { daysLabel } = await import('../src/renderer/src/pages/Transactions.tsx')
const { fmtMinus } = await import('../src/renderer/src/lib.ts')
const { lineQuery } = await import('../src/renderer/src/pages/txnFilter.ts')
const { boundaryParts, linesFor } = await import('../src/main/lines.ts')
const { ACCOUNTS, kestrel, kestrelBooks, line, setParts, storeParts, storePart } = await import('./fixtures/venture-money.ts')
const { largeLedger } = await import('./fixtures/large-ledger.ts')

configureLicense({ dev: true })

/**
 * The books with their rules applied, as the app applies them when lines arrive (an import, a sync): the fixture
 * writes lines after Kestrel Checking is the venture's, so its auto rule puts them in the venture only now.
 */
function ruled<T>(x: T): T {
  db.applyBucketRules()
  return x
}
const result = (id: number): ReturnType<typeof getVenture>['result'] => getVenture(id).result
/** A venture's money in, out and operating, as its books and the venture list have them. */
function books(id: number): [number, number, number] {
  const r = result(id)
  const listed = listVentures().find((b) => b.id === id)!
  assert.equal(listed.operatingCents, r.operatingCents, 'the list and the venture agree')
  return [r.inCents, r.outCents, r.operatingCents]
}
const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
/** Markup as text: tags dropped, a space between cells. */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

describe("example B: Kestrel Studio's books", () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test('operating 4,000.00 - 1,200.00 - 30.00 = 2,770.00, and E rose 4,770.00, the operating and 2,000.00 of equity', () => {
    const k = ruled(kestrel())
    // Before any intent, the transfers are out of operating by their category and there's no interest.
    assert.deepEqual(books(k.venture), [400_000, 120_000, 280_000])
    storeParts(k)
    // The repayment's 30.00 of interest is Kestrel's cost.
    assert.deepEqual(books(k.venture), [400_000, 123_000, 277_000])
    const book = positionBook('2026-11-30')
    const balances = db.balancesOn([ACCOUNTS.kestrel], '2026-10-31')
    const later = db.balancesOn([ACCOUNTS.kestrel], '2026-11-30')
    const oct = positionsOn(book, '2026-10-31', (id) => balances.get(id) ?? 0).get(k.venture)!
    const nov = positionsOn(book, '2026-11-30', (id) => later.get(id) ?? 0).get(k.venture)!
    assert.deepEqual([oct.equityCents, nov.equityCents], [1_000_000, 1_477_000])
    assert.equal(nov.equityCents - oct.equityCents, result(k.venture).operatingCents + 200_000)
    // 50% of it is November's Ventures(NW).
    assert.equal(getWaterfall({ from: '2026-11', to: '2026-11' }).bridge.venturesCents, 138_500)
  })

  test("owner money: equity out 6,000.00; loan out 3,000.00, in 1,000.00, outstanding 2,000.00, interest 30.00; reimbursement in 100.00, outstanding -100.00; basis 6,000.00; stake less basis 1,385.00", () => {
    const k = ruled(kestrel())
    storeParts(k)
    const owner = result(k.venture).owner
    assert.deepEqual([owner.basisCents, owner.stakeCents - owner.basisCents, owner.lentCents, owner.dueCents, owner.positionCents], [600_000, 138_500, 200_000, -10_000, 928_500])
    const block = view.ownerBlock(owner, (id) => db.listAccounts().find((a) => a.id === id)!.name, '2026-12-07')
    assert.deepEqual(
      block.rows.map((r) => [r.name, r.inCents, r.outCents, r.outstandingCents, r.interestCents]),
      [
        ['Loan', 100_000, 300_000, 200_000, 3_000],
        ['Equity', null, 600_000, null, null],
        ['Reimbursement', 10_000, null, -10_000, null],
        ['Unset', 0, 0, null, null]
      ]
    )
  })

  test("a leg in a category of the venture's own leaves operating all the same, but for what other covers", () => {
    const k = kestrel()
    // Kestrel filed Nov 2's 5,000.00 from Checking as revenue.
    db.setTransactionFields(k.legs.mixed, { categoryId: category('Other Income'), source: 'user' })
    ruled(k)
    assert.deepEqual(books(k.venture), [900_000, 120_000, 780_000])
    storeParts(k)
    assert.deepEqual(books(k.venture), [400_000, 123_000, 277_000])
    // As a loan of 3,000.00 and 2,000.00 of other, the other stays as it was filed.
    db.run("DELETE FROM venture_money WHERE txn_id = ? AND intent = 'equity'", k.mixed)
    storePart(k.venture, k.mixed, 'other', -200_000)
    assert.deepEqual(books(k.venture), [600_000, 123_000, 477_000])
  })
})

describe('examples E, F and H', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("E: salary is -5,000.00 of wages in Kestrel's operating, though its legs are in Transfers, and Ventures 0: by I2 before Review answers, and as Review's answer after", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    const pay = ['2026-11-01', '2026-11-15'].map((day) => {
      line(ACCOUNTS.kestrel, day, -250_000, 'PAYROLL', 'Transfers', 'Kestrel Payroll Run')
      return line(ACCOUNTS.checking, day, 250_000, 'KESTREL STUDIO PAYROLL', 'Paycheck', 'Kestrel Studio Payroll')
    })
    db.applyBucketRules()
    // Each check pairs with Kestrel's leg, and its payee is a payroll key, so I2 makes it salary: the wages are
    // Kestrel's cost with nothing stored.
    assert.deepEqual(result(k).owner.lines.map((l) => l.parts.map((p) => [p.intent, p.source])), [[['salary', 'inferred']], [['salary', 'inferred']]])
    assert.deepEqual(books(k), [0, 500_000, -500_000])
    assert.equal(getWaterfall({ from: '2026-11', to: '2026-11' }).identity.venturesCents, 0)
    runAssistantTool('set_venture_money', { transaction_ids: pay, venture: 'Kestrel Studio', intent: 'salary' })
    assert.deepEqual(books(k), [0, 500_000, -500_000])
    assert.equal(getWaterfall({ from: '2026-11', to: '2026-11' }).identity.venturesCents, 0)
    // With the inference set aside (intent other on both), the legs are out of operating by their category.
    runAssistantTool('set_venture_money', { transaction_ids: pay, venture: 'Kestrel Studio', intent: 'other' })
    assert.deepEqual(books(k), [0, 0, 0])
  })

  test('E with the legs filed as a cost of its own: the wages count once', () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    const pay = ['2026-11-01', '2026-11-15'].map((day) => {
      line(ACCOUNTS.kestrel, day, -250_000, 'PAYROLL', 'Other', 'Kestrel Payroll Run')
      return line(ACCOUNTS.checking, day, 250_000, 'KESTREL STUDIO PAYROLL', 'Paycheck', 'Kestrel Studio Payroll')
    })
    db.applyBucketRules()
    assert.deepEqual(books(k), [0, 500_000, -500_000])
    runAssistantTool('set_venture_money', { transaction_ids: pay, venture: 'Kestrel Studio', intent: 'salary' })
    assert.deepEqual(books(k), [0, 500_000, -500_000])
  })

  test("F: the venture loan's 20.00 of interest is income in Kestrel's operating", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = kestrelBooks()
    line(ACCOUNTS.kestrel, '2026-11-06', -300_000, 'LOAN TO OWNER', 'Transfers', 'Owner Transfer')
    const borrowed = line(ACCOUNTS.checking, '2026-11-06', 300_000, 'TRANSFER FROM KESTREL', 'Transfers', 'Kestrel Studio')
    const repaid = line(ACCOUNTS.checking, '2026-11-30', -102_000, 'TRANSFER TO KESTREL', 'Transfers', 'Kestrel Studio')
    line(ACCOUNTS.kestrel, '2026-11-30', 102_000, 'LOAN REPAYMENT', 'Transfers', 'Owner Transfer')
    db.applyBucketRules()
    assert.deepEqual(books(k), [0, 0, 0])
    runAssistantTool('set_venture_money', { transaction_ids: [borrowed], venture: 'Kestrel Studio', intent: 'venture_loan' })
    runAssistantTool('set_venture_money', { transaction_ids: [repaid], venture: 'Kestrel Studio', intent: 'venture_loan_repayment', interest: 20 })
    assert.deepEqual(books(k), [2_000, 0, 2_000])
    const block = view.ownerBlock(result(k).owner, () => '', '2026-12-07')
    assert.deepEqual(block.rows.find((r) => r.key === 'ventureLoan'), { key: 'ventureLoan', name: 'Venture loan', inCents: 300_000, outCents: 100_000, outstandingCents: -200_000, interestCents: 2_000 })
  })

  test("H: Side Shop's operating leaves out the 4,000.00 of pay the paycheck clause keeps the user's, before its fundings have an intent and after", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    db.upsertAccount({ id: ACCOUNTS.checking, source: 'csv', name: 'Checking', institution: null, currency: 'USD', balanceCents: 400_000, availableCents: null, balanceDate: noonOn(2026, 11, 7) })
    db.updateAccount(ACCOUNTS.checking, { assetType: 'cash' })
    const pay = ['2026-10-15', '2026-10-31'].map((day) => line(ACCOUNTS.checking, day, 200_000, 'LANTERN PAYROLL', 'Paycheck', 'Lantern Payroll'))
    const supplies = line(ACCOUNTS.checking, '2026-10-20', -15_000, 'SHOP SUPPLIES', 'Other', 'Shop Supplies')
    const shop = db.saveBucket({ name: 'Side Shop', kind: 'business' })
    db.updateAccount(ACCOUNTS.checking, { bucketId: shop })
    // The pay is in the venture by its auto rule, as the supplies are; only the supplies are its books'.
    assert.deepEqual(db.all<{ id: string }>('SELECT id FROM transactions WHERE bucket_id = ? ORDER BY posted', shop).map((r) => r.id), [pay[0], supplies, pay[1]])
    assert.deepEqual(books(shop), [0, 15_000, -15_000])
    runAssistantTool('set_venture_share', { venture: 'Side Shop', from: '2026-01-01', share_pct: 100 })
    runAssistantTool('set_venture_money', { transaction_ids: pay, venture: 'Side Shop', intent: 'equity' })
    assert.deepEqual(books(shop), [0, 15_000, -15_000])
    // Placed in the venture by hand, the pay is its own: the clause is for what the rules put there.
    db.setTransactionsBucket(pay, shop)
    assert.deepEqual(books(shop), [400_000, 15_000, 385_000])
  })
})

describe('the Ventures page', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("example B's block as the addendum draws it, data only", () => {
    const k = ruled(kestrel())
    storeParts(k)
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    const block = view.ownerBlock(result(k.venture).owner, (id) => names.get(id) ?? '', '2026-12-07')
    assert.deepEqual(
      block.figures.map((f) => [f.label, f.value]),
      [
        ['Share', '50.00%'],
        ['Basis', '6,000.00'],
        ['Stake', '7,385.00'],
        ['', 'Books'],
        ['Stake less basis', '1,385.00'],
        ['Position', '9,285.00']
      ]
    )
    assert.deepEqual(block.shares, [
      { day: '2026-01-15', pct: '40.00%' },
      { day: '2026-11-02', pct: '50.00%' }
    ])
    // Every boundary line, oldest first: January's equity, then the three of November the addendum draws.
    assert.deepEqual(
      block.lines.map((l) => [l.dayText, l.account, view.signedMoney(l.cents), l.parts]),
      [
        ['Jan 15', 'Checking', '−4,000.00', 'Equity'],
        ['Nov 2', 'Checking', '−5,000.00', 'Loan 3,000.00 · Equity 2,000.00'],
        ['Nov 12', 'Kestrel Checking', '+100.00', 'Funding · Reimbursement'],
        ['Nov 20', 'Checking', '+1,030.00', 'Loan repayment 1,000.00 · Interest 30.00']
      ]
    )
    assert.equal(block.more, 0)
    const html = renderToStaticMarkup(createElement(VentureOwner, { block }))
    const drawn = text(html)
    for (const s of [
      'Share 50.00% Basis 6,000.00 Stake 7,385.00 Books Stake less basis 1,385.00 Position 9,285.00',
      'Shares 2026-01-15 40.00% 2026-11-02 50.00%',
      'Owner money In Out Outstanding Interest',
      'Loan 1,000.00 3,000.00 2,000.00 30.00',
      'Equity 6,000.00',
      'Reimbursement 100.00 −100.00',
      'Unset 0 0',
      'Nov 2 Checking −5,000.00 Loan 3,000.00 · Equity 2,000.00',
      'Nov 12 Kestrel Checking +100.00 Funding · Reimbursement',
      'Nov 20 Checking +1,030.00 Loan repayment 1,000.00 · Interest 30.00'
    ])
      assert.ok(drawn.includes(s), `${s} in: ${drawn}`)
    // No field to fill and no button but the lines, each a link to Transactions on its own parts.
    assert.doesNotMatch(html, /<(input|select|textarea)\b/)
    assert.equal((html.match(/<button/g) ?? []).length, block.lines.length)
  })

  test('a line opens Transactions on its own parts, Unset on the parts with no intent, and the count of older lines on them all', () => {
    const k = ruled(kestrel())
    storeParts(k)
    runTool('set_venture_money', { transaction_ids: [k.mixed], venture: 'Kestrel Studio', intent: 'none' }, 'assistant')
    const owner = result(k.venture).owner
    const block = view.ownerBlock(owner, () => '', '2026-12-07')
    assert.deepEqual(block.rows.find((r) => r.key === 'unset'), { key: 'unset', name: 'Unset', inCents: 0, outCents: 500_000, outstandingCents: null, interestCents: null })
    const today = '2026-12-07'
    const lines = (f: Parameters<typeof lineQuery>[0]): string[] => linesFor(lineQuery(f, today)!).lines.map((l) => `${l.txnId}${l.key.slice(l.txnId.length)}`)
    assert.deepEqual(lines({ ventureId: k.venture, intent: 'unset' }), [`${k.mixed}::p`])
    assert.deepEqual(lines({ ventureId: k.venture, ids: [k.groceries] }), [`${k.groceries}::p:fund`])
    assert.equal(linesFor(lineQuery({ ventureId: k.venture }, today)!).total, 5)
    // A venture with more lines than the block lists shows the latest, and the count of the rest.
    const many: OwnerMoney = { ...owner, lines: Array.from({ length: view.LINES_SHOWN + 3 }, (_, i) => ({ ...owner.lines[0], txnId: `t${i}`, day: `2025-${String((i % 12) + 1).padStart(2, '0')}-01` })) }
    const listed = view.ownerBlock(many, () => 'Checking', today)
    assert.deepEqual([listed.lines.length, listed.more, listed.lines[0].txnId, listed.lines[0].dayText], [view.LINES_SHOWN, 3, 't3', 'Apr 1, 2025'])
    assert.match(text(renderToStaticMarkup(createElement(VentureOwner, { block: listed }))), /^.*3 more/)
  })

  test("the venture list tags each venture's share where it said it was left out of net worth, and shows its position; the venture modal has no net worth checkbox", () => {
    const k = ruled(kestrel())
    storeParts(k)
    const listed = listVentures().find((b) => b.id === k.venture)!
    assert.deepEqual([view.shareShort(listed.shareBp), listed.positionCents], ['50%', 928_500])
    assert.deepEqual([view.shareShort(3333), view.shareShort(0), view.sharePct(10000)], ['33.33%', '0%', '100.00%'])
    const page = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'pages', 'Buckets.tsx'), 'utf8')
    assert.doesNotMatch(page, /type="checkbox"|inNetWorth|in net worth/i)
    assert.match(page, /shareShort\(b\.shareBp\)/)
    assert.match(page, /fmtMinus\(b\.positionCents\)/)
    // A venture in debt shows its position with a true minus, as the page's other signed figures do.
    assert.deepEqual([fmtMinus(-500_000), fmtMinus(500_000), fmtMinus(-49), fmtMinus(-50)], ['−$5,000', '$5,000', '$0', '−$1'])
  })

  test("a venture's line opened on Transactions tags each of its parts with its intent: the loan and the equity of Nov 2, the funding's reimbursement, the repayment's interest", () => {
    const k = ruled(kestrel())
    storeParts(k)
    const tags = (txnId: string): Array<string | null> => linesFor({ fromDay: '2026-01-01', toDay: '2026-12-07', ventureId: k.venture, ids: [txnId] }).lines.map((l) => view.intentTag(l)).sort()
    assert.deepEqual(tags(k.mixed), ['Equity', 'Loan'])
    assert.deepEqual(tags(k.groceries), ['Funding · Reimbursement'])
    assert.deepEqual(tags(k.repayment), ['Loan repayment', 'Loan repayment · Interest'])
  })

  test("the Transactions chip names the days a venture's links open on: one line's day once, and both years of the ten years Unset reads", () => {
    assert.deepEqual(
      [daysLabel('2026-11-02', '2026-11-02'), daysLabel('2016-01-01', '2026-12-07'), daysLabel('2026-09-04', '2026-10-03')],
      ['Nov 2, 2026', 'Jan 1, 2016 – Dec 7, 2026', 'Sep 4 – Oct 3, 2026']
    )
  })
})

describe("Net worth's Ventures group", () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("Kestrel's row: its name and share, its position and its 30-day change, drawn as the other groups' rows are", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 })
    const k = ruled(kestrel())
    storeParts(k)
    const sheet = getBalanceSheet()
    const g = sheet.groups.find((x) => x.id === 'ventures')!
    assert.deepEqual(g.ventures, [{ bucketId: k.venture, name: 'Kestrel Studio', shareBp: 5000, cents: 928_500, change30Cents: 28_500 }])
    const opened: string[] = []
    const html = renderToStaticMarkup(createElement(GroupRows, { g, onView: () => {}, onOpen: () => {}, onVenture: () => void opened.push('ventures') }))
    assert.match(text(html), /^Ventures \$9,285 \+\$285 Kestrel Studio · 50% \$9,285 \+\$285$/)
    // Each row is a link, as the other groups' accounts are: the group's to the Ventures list, Kestrel's to its own page.
    assert.equal((html.match(/<button class="sheet-row/g) ?? []).length, 2)
    const asked: Array<number | undefined> = []
    const buttons: Array<{ key: string | null; props: { onClick?: () => void } }> = []
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object' || !('props' in n)) return
      const e = n as { type: unknown; key: string | null; props: { onClick?: () => void; children?: unknown } }
      if (e.type === 'button') buttons.push(e)
      walk(e.props.children)
    }
    walk(GroupRows({ g, onView: () => {}, onOpen: () => {}, onVenture: (id?: number) => void asked.push(id) }))
    for (const b of buttons) b.props.onClick?.()
    assert.deepEqual([buttons.map((b) => b.key), asked], [[null, `venture:${k.venture}`], [undefined, k.venture]])
  })

  test("the demo: Bayview Condo's accounts leave cash, property and loans for one Ventures row at what they hold, so net worth is as it was", () => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    loadDemoData()
    const condo = listVentures().find((b) => b.name === 'Bayview Condo')!
    const held = db.listAccounts().filter((a) => a.bucketId === condo.id || (a.linkedAssetId !== null && db.listAccounts().find((x) => x.id === a.linkedAssetId)?.bucketId === condo.id))
    assert.equal(held.length, 3)
    const sheet = getBalanceSheet()
    const today = db.today()
    const balances = db.balancesOn(held.map((a) => a.id), today)
    const a = held.reduce((s, x) => s + (balances.get(x.id) ?? 0), 0)
    const ventures = sheet.groups.find((x) => x.id === 'ventures')!
    assert.deepEqual(ventures.ventures!.map((v) => [v.name, v.shareBp, v.cents]), [['Bayview Condo', 10000, a]])
    assert.ok(!sheet.groups.some((x) => x.accounts.some((r) => held.some((h) => h.id === r.account.id))))
    assert.equal(sheet.netWorthCents, sheet.groups.reduce((s, x) => s + x.cents, 0))
    // Own counts the condo's position, its value less the mortgage, and Owe leaves the mortgage out.
    const mortgage = held.find((x) => x.assetType === 'mortgage')!
    assert.ok((balances.get(mortgage.id) ?? 0) < 0)
    assert.equal(sheet.oweCents, -sheet.groups.filter((x) => x.id === 'cards' || x.id === 'loans').reduce((s, x) => s + x.cents, 0))
    assert.equal(condo.positionCents, a)
  })
})

describe('acceptance: example B through Review', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 12, 7) * 1000 }))
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  /** November's two identities: the cash identity's sides and engine error, and the bridge's terms against its ΔNW. */
  function november(): { left: number; right: number; cashError: number; delta: number; terms: number; bridgeError: number; venturesNW: number } {
    const w = getWaterfall({ from: '2026-11', to: '2026-11' })
    const x = w.identity
    const b = w.bridge
    return {
      left: x.keptCents + x.venturesCents + x.cashReturnCents + x.unsortedCents,
      right: x.movedCents + x.checkingCents + x.debtPaidCents + x.toInvestmentsCents + x.boughtCents + x.inTransitCents + x.unexplainedCents,
      cashError: x.engineErrorCents,
      delta: b.endCents - b.startCents,
      terms: b.savedCents + b.growthCents + b.revaluationCents + b.venturesCents + b.unsortedCents - b.inTransitCents - b.unexplainedCents + b.otherCents,
      bridgeError: b.engineErrorCents,
      venturesNW: b.venturesCents
    }
  }
  const drawn = (k: { venture: number }): string => {
    const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
    return renderToStaticMarkup(createElement(VentureOwner, { block: view.ownerBlock(result(k.venture).owner, (id) => names.get(id) ?? '', '2026-12-07') }))
  }

  test("both identities tie to the cent in November by the books and by the estimate, and the Ventures page shows example B's share, basis, stake, position and owner money, data only", () => {
    const k = ruled(kestrel({ shares: false, stake: true }))
    setParts(k, (name, input) => runAssistantTool(name, input))
    // By the books, with Kestrel stake linked, so it's never counted beside the position: both sides 1,330.00, ΔNW
    // 2,715.00, Ventures(NW) 1,385.00.
    runAssistantTool('set_venture_value', { venture: 'Kestrel Studio', source: 'books', stake_account_id: k.stake })
    assert.deepEqual(november(),{ left: 133_000, right: 133_000, cashError: 0, delta: 271_500, terms: 271_500, bridgeError: 0, venturesNW: 138_500 })
    const html = drawn(k)
    assert.equal(
      text(html),
      'Share 50.00% Basis 6,000.00 Stake 7,385.00 Books Stake less basis 1,385.00 Position 9,285.00 Shares 2026-01-15 40.00% 2026-11-02 50.00% Owner money In Out Outstanding Interest Loan 1,000.00 3,000.00 2,000.00 30.00 Equity 6,000.00 Reimbursement 100.00 −100.00 Unset 0 0 Jan 15 Checking −4,000.00 Equity Nov 2 Checking −5,000.00 Loan 3,000.00 · Equity 2,000.00 Nov 12 Kestrel Checking +100.00 Funding · Reimbursement Nov 20 Checking +1,030.00 Loan repayment 1,000.00 · Interest 30.00'
    )
    // No field, no button but the lines' links to Transactions.
    assert.doesNotMatch(html, /<(input|select|textarea)\b/)
    assert.equal((html.match(/<button/g) ?? []).length, 4)
    // By the estimate, Kestrel stake worth 8,000.00 on Oct 31 and 9,000.00 on Nov 30: ΔNW 330.00, Ventures(NW) -1,000.00.
    runAssistantTool('set_venture_value', { venture: 'Kestrel Studio', source: 'estimate', stake_account_id: k.stake })
    assert.deepEqual(november(), { left: 133_000, right: 133_000, cashError: 0, delta: 33_000, terms: 33_000, bridgeError: 0, venturesNW: -100_000 })
    assert.match(text(drawn(k)), /^Share 50\.00% Basis 6,000\.00 Stake 9,000\.00 Estimate · Kestrel stake Stake less basis 3,000\.00 Position 10,900\.00 Shares /)
  })
})

describe('the cost of the venture list', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("the large ledger's venture list, with and without a transfer to its venture that has an intent, against the reference", async (t) => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
    largeLedger({ from: '2018-12', invested: true })
    getWaterfall({ from: '2026-10', to: '2026-10' })
    const timed = async (what: string, budget: number, work: () => unknown, ready?: () => unknown): Promise<void> => {
      const r = await paired(6, () => busyMs(work), (k) => {
        db.setSetting('test.ventureListRound', `${what} ${k}`)
        ready?.()
      })
      t.diagnostic(within(what, budget, r))
      assert.ok(r.ratio <= budgetRatio(budget), within(what, budget, r))
    }
    await timed('the venture list', LIST_MS, () => listVentures())
    // Money from Personal's checking to the rental's account, a loan: the list reads the transfers' legs once.
    const venture = listVentures()[0].id
    const out = line('csv:chk', '2026-10-02', -50_000, 'TRANSFER TO RENTAL', 'Transfers', 'Rental Transfer')
    line('csv:rent', '2026-10-02', 50_000, 'TRANSFER FROM CHECKING', 'Transfers', 'Owner Transfer')
    storePart(venture, out, 'loan', -50_000)
    assert.equal(result(venture).owner.lentCents, 50_000)
    // Once money can cross to a venture, the first read after a change, whichever it is, reads the money book: one
    // pass of the classifier over every day there are lines, for what the remembered answers and inferences give.
    // The list's own work is timed after it, and the money book on its own.
    await timed('the venture list with an intent', LIST_INTENT_MS, () => listVentures(), () => boundaryParts())
    // A venture's own page lists its lines with no intent from the money book too, without classifying every day again.
    await timed("the venture's page with its lines", PAGE_MS, () => getVenture(venture), () => boundaryParts())
    await timed('the money book with a transfer to a venture', MONEY_BOOK_MS, () => boundaryParts())
  })
})

/**
 * The budgets, each about twice what it costs alone against the reference on the reference machine (the
 * venture list about 17 ms on the large ledger, and 33 ms once a transfer with its venture has an
 * intent, when it reads the transfers' legs; the venture's page about 47 ms; the money book about 210 ms once a line
 * can cross to a venture), so a run under the whole suite doesn't fail it with nothing slower.
 */
const LIST_MS = 40
const LIST_INTENT_MS = 80
const PAGE_MS = 100
const MONEY_BOOK_MS = 450
