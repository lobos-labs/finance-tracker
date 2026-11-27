import { registerHooks } from 'node:module'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

// db.ts imports '../shared/types' without an extension (the bundler resolves
// it); for the test, Node gets the same help. The hook runs before the dynamic
// imports below, which is why those are not static.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw err
    }
  }
})
const db = await import('../src/main/db.ts')
const { clearDemoData, demoStatus, isDemo, loadDemoData } = await import('../src/main/demo.ts')
const { getInsurance, listPolicies, savePolicy } = await import('../src/main/insurance.ts')
const { getVenture } = await import('../src/main/ventures.ts')
const { getSummary } = await import('../src/main/summary.ts')

db.openDb(':memory:')

const count = (table: string): number => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n
const ACCOUNTS = 13

describe('sample data', () => {
  // The user's own rows, from before the sample set: they must come through untouched.
  const house = db.addManualAccount({ name: 'My house', assetType: 'property', openedDay: '2021-05-01', costCents: 30000000, points: [{ day: '2024-01-01', cents: 35000000 }] })
  const fact = db.addFact('Mine')
  const event = db.addCalendarEvent({ day: '2030-01-01', title: 'Mine', createdBy: 'user' })
  const policy = savePolicy({ name: 'My umbrella', kind: 'umbrella', premiumCents: 30000, premiumPeriod: 'year' }).id
  const bucket = db.saveBucket({ name: 'My business', kind: 'business' })

  test('loads a household every page can show', () => {
    const r = loadDemoData()
    assert.equal(r.accounts, ACCOUNTS)
    assert.ok(r.transactions > 500, `only ${r.transactions} transactions`)
    assert.equal(count('transactions'), r.transactions)
    assert.equal(demoStatus().loaded, true)
    const accounts = db.listAccounts()
    assert.equal(accounts.filter((a) => isDemo(a.id)).length, ACCOUNTS)
    assert.ok(accounts.some((a) => a.assetType === 'credit_card' && a.promoApr === 0 && a.promoEnds), 'a promo card')
    assert.ok(accounts.some((a) => a.assetType === 'property' && isDemo(a.id)), 'a house')
    assert.ok(accounts.some((a) => a.assetType === 'loan' && isDemo(a.id)), 'a car loan')
    assert.ok(accounts.every((a) => !isDemo(a.id) || a.balanceCents !== null), 'every demo account has a balance')
    // Categorized as the AI and the rules would have left it, with a few rows for Review.
    const uncategorized = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL')!.n
    assert.ok(uncategorized >= 2 && uncategorized <= 8, `${uncategorized} uncategorized`)
    assert.ok(count('paystubs') >= 1)
    assert.ok(count('contributions') >= 2)
    assert.ok(db.listFacts().length >= 3)
  })

  test('two policies, each matching its monthly charge, with renewals, coverage and deductibles', () => {
    loadDemoData()
    const today = db.dayKey(db.now())
    const view = getInsurance()
    const demo = view.policies.filter((p) => isDemo(p.id))
    assert.deepEqual(demo.map((p) => p.kind).sort(), ['auto', 'home'])
    for (const p of demo) {
      assert.equal(p.status, 'active')
      assert.equal(p.premiumPeriod, 'month')
      assert.ok(p.nextRenewal && p.nextRenewal >= today, `${p.name} renews ${p.nextRenewal}`)
      assert.ok(p.deductibleCents && p.deductibleCents > 0, `${p.name} deductible`)
      assert.ok(p.coverage.length >= 4, `${p.name} coverage`)
      // What was paid comes from the sample's own charges: the premium, every month of the last year.
      assert.equal(p.lastPaid?.cents, p.premiumCents, `${p.name} last paid`)
      assert.ok(p.paidLastYearCents >= p.premiumCents! * 11 && p.paidLastYearCents <= p.premiumCents! * 13, `${p.name} paid ${p.paidLastYearCents}`)
      assert.equal(p.yearlyCents, p.premiumCents! * 12)
    }
    // The user's policy is still there, beside them.
    assert.ok(view.policies.some((p) => p.id === policy))
  })

  test('a rental condo venture: rent in, dues, mortgage and repairs out, kept out of Personal', () => {
    loadDemoData()
    const rental = db.listBuckets().find((b) => b.kind === 'rental')
    assert.ok(rental, 'a rental venture')
    const detail = db.getBucket(rental.id)
    assert.deepEqual(detail.accounts.map((a) => a.id).sort(), ['demo:condo', 'demo:condo-mortgage', 'demo:rental-checking'])
    assert.ok(detail.accounts.some((a) => a.assetType === 'property' && (a.balanceCents ?? 0) > 20_000_000), 'the condo')
    assert.ok(detail.accounts.some((a) => a.assetType === 'mortgage' && (a.balanceCents ?? 0) < -15_000_000), 'its mortgage')
    const payees = new Map(detail.topPayees.map((p) => [p.name, p]))
    assert.ok((payees.get('Bayview Rent')?.inCents ?? 0) > 2_500_000, 'a year of rent')
    for (const name of ['Bayview Condo Association', 'Bayview Condo Mortgage', 'Pro Coat Painting']) assert.ok((payees.get(name)?.outCents ?? 0) > 0, name)
    // Cash flow a landlord with a mortgage would recognize: a little ahead, not a second salary.
    const net = rental.inCents - rental.outCents
    assert.ok(net > 0 && net < 1_000_000, `net ${net}`)
    // Its whole picture: the condo's gain on paper against its cost, and the loan's principal out of operating.
    const { result } = getVenture(rental.id)
    assert.deepEqual(result.assets.map((a) => [a.id, a.sold, a.gainFrom]), [['demo:condo', false, 'cost']])
    const condo = result.assets[0]
    assert.ok(condo.gainCents! > 0 && condo.gainCents === condo.valueCents - condo.costCents!, `gain ${condo.gainCents}`)
    assert.ok(condo.owedCents > 0 && condo.equityCents === condo.valueCents - condo.owedCents)
    assert.ok(result.principalCents > 0 && result.operatingCents === net + result.principalCents, `operating ${result.operatingCents}`)
    assert.deepEqual([result.realizedCents, result.onPaperCents, result.totalCents, result.missingCost], [0, condo.gainCents, result.operatingCents + condo.gainCents!, []])
    // Every transaction of the rental's account is in the venture, and Personal leaves them out.
    const loose = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE account_id = 'demo:rental-checking' AND (bucket_id IS NULL OR bucket_id != ?)", rental.id)!.n
    assert.equal(loose, 0)
    const month = db.dayKey(db.now()).slice(0, 7)
    const rentIn = db.get<{ n: number }>("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM transactions WHERE account_id = 'demo:rental-checking' AND amount_cents > 0 AND strftime('%Y-%m', posted, 'unixepoch', 'localtime') = ?", month)!.n
    assert.equal(getSummary(month, [0, rental.id]).incomeCents - getSummary(month).incomeCents, rentIn)
  })

  test('loading again replaces the set instead of doubling it', () => {
    const first = loadDemoData()
    const again = loadDemoData()
    assert.deepEqual(again, first)
    assert.equal(count('transactions'), first.transactions)
    assert.equal(db.listAccounts().filter((a) => isDemo(a.id)).length, ACCOUNTS)
    assert.equal(listPolicies().filter((p) => isDemo(p.id)).length, 2)
    assert.equal(db.listBuckets().filter((b) => b.kind === 'rental').length, 1)
  })

  test('removing takes every demo row and nothing else', () => {
    loadDemoData()
    assert.equal(clearDemoData(), ACCOUNTS)
    assert.equal(demoStatus().loaded, false)
    assert.equal(count('transactions'), 0)
    assert.equal(count('contributions'), 0)
    assert.equal(count('paystubs'), 0)
    assert.equal(count('paystub_items'), 0)
    assert.equal(count('recurring_overrides'), 0)
    assert.equal(count('bucket_rules'), 0)
    assert.deepEqual(db.listAccounts().map((a) => a.id), [house])
    assert.equal(db.listBalancePoints(house).length, 1)
    assert.deepEqual(db.listFacts().map((f) => f.id), [fact])
    assert.deepEqual(db.listCalendarEvents('2000-01-01').map((e) => e.id), [event])
    assert.deepEqual(listPolicies().map((p) => p.id), [policy])
    assert.deepEqual(db.listBuckets().map((b) => b.id), [bucket])
    assert.equal(db.getSetting('demo.rows'), null)
    assert.equal(db.getSetting('demo.loadedAt'), null)
  })

  test('removing with nothing loaded is a no-op', () => {
    assert.equal(clearDemoData(), 0)
    assert.deepEqual(db.listAccounts().map((a) => a.id), [house])
    assert.deepEqual(listPolicies().map((p) => p.id), [policy])
  })
})
