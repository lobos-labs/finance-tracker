import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from '../src/main/db.ts'
import { getBudget } from '../src/main/budget.ts'
import { calendarItems } from '../src/main/calendar.ts'
import { getDebts } from '../src/main/debts.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { buildDigest } from '../src/main/insights.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { lineOwner, residences, type OwnerLine } from '../src/main/lines.ts'
import { detectRecurring, recurringHistory } from '../src/main/recurring.ts'
import { renewalSeries } from '../src/main/renewals.ts'
import { getSpendable } from '../src/main/spendable.ts'
import { billShares, recurringBills } from '../src/main/spendModel.ts'
import { openIssues, runTool } from '../src/main/tools.ts'
import { addDays } from '../src/shared/zone.ts'
import { noonOn } from './days.ts'

// Personal views are Personal: a rental's mortgage, dues and rent stay with the
// rental (the sample household's Bayview Condo) and out of the budget, the debt
// plan's take-home, Spendable and every other reader of Personal recurring
// series. An account put in a venture takes its lines along by an auto rule, and
// a line the user places in Personal stays there.

configureLicense({ dev: true })

const root = fileURLToPath(new URL('..', import.meta.url))
const BAYVIEW = /bayview/i
const RENTAL = 'demo:rental-checking'
const venture = (): number => db.bucketByName('Bayview Condo')!.id

describe('Personal scope on the sample household', () => {
  before(() => {
    db.openDb(':memory:')
    loadDemoData()
  })
  after(db.closeDb)

  test("Budget's Housing holds the household's own mortgage, not the rental's mortgage and dues", () => {
    const housing = getBudget(db.today().slice(0, 7)).rows.find((r) => r.name === 'Housing')!
    // Pinecrest's 1,985.00 alone; with Bayview's 1,380.00 mortgage and 385.00 dues it was 3,750.00.
    assert.equal(housing.fixedCents, 198500)
  })

  test("the debt plan's take-home leaves out Bayview Rent", () => {
    // Since 2c it is the Take-home run rate (spec 1.6), Personal's pay alone: the savings interest is Growth's.
    const debts = getDebts()
    assert.deepEqual(debts.incomeSources.map((s) => s.name).sort(), ['Northwind Logistics Payroll'])
    assert.equal(debts.takeHomeCents, debts.incomeSources.reduce((t, s) => t + s.monthlyCents, 0))
    // The rent is an income series of the venture's, active, and nothing of it is in the plan.
    const rent = detectRecurring({ scope: 'all' }).filter((s) => s.kind === 'income' && s.status === 'active' && s.typicalCents > 0 && !s.dismissed && s.owner !== null)
    assert.equal(rent.reduce((t, s) => t + s.monthlyCents, 0), 225000)
    assert.ok(rent.every((s) => BAYVIEW.test(s.name) && !debts.incomeSources.some((x) => x.name === s.name)))
  })

  test('Spendable has no Rental Checking, and none of its bills', () => {
    const spend = getSpendable()
    assert.deepEqual(spend.accounts.map((a) => a.id).sort(), ['demo:checking', 'demo:savings'])
    assert.ok(spend.items.length > 0)
    assert.equal(spend.items.filter((i) => i.accountId === RENTAL || BAYVIEW.test(i.name)).length, 0)
  })

  test('every Personal reader of recurring series sees no Bayview series', () => {
    const all = detectRecurring({ scope: 'all' })
    const bayview = all.filter((s) => BAYVIEW.test(s.name))
    assert.deepEqual(bayview.map((s) => s.key).sort(), ['bayview condo association|-', 'bayview condo mortgage|-', 'bayview rent|+'])
    for (const s of bayview) assert.deepEqual([s.owner, s.personalBp], [venture(), 0], s.key)
    for (const s of all.filter((x) => !BAYVIEW.test(x.name))) assert.deepEqual([s.owner, s.personalBp], [null, 10000], s.key)

    const personal = detectRecurring()
    assert.equal(personal.length, all.length - 3)
    assert.equal(personal.filter((s) => BAYVIEW.test(s.name)).length, 0)
    // The same series keep the same keys in both scopes.
    assert.deepEqual(personal.map((s) => s.key).sort(), all.filter((s) => !BAYVIEW.test(s.name)).map((s) => s.key).sort())
    assert.equal(recurringHistory().filter((h) => BAYVIEW.test(h.series.name)).length, 0)

    const today = db.today()
    const calendar = calendarItems(today, addDays(today, 60))
    assert.ok(calendar.some((i) => i.key.startsWith('recurring:pinecrest mortgage')))
    assert.equal(calendar.filter((i) => BAYVIEW.test(i.title)).length, 0)
    assert.equal(renewalSeries().filter((s) => BAYVIEW.test(s.name)).length, 0)
    assert.equal(recurringBills().filter((s) => BAYVIEW.test(s.name)).length, 0)
    // Given every series, the budget's bills still leave the venture's out.
    assert.equal(billShares(all).filter((b) => BAYVIEW.test(b.series.name)).length, 0)
    const digest = buildDigest()!
    assert.equal(digest.recurringCharges.filter((r) => BAYVIEW.test(r.merchant)).length, 0)
    assert.equal(digest.upcoming.filter((r) => BAYVIEW.test(r.merchant)).length, 0)
  })

  test("only listRecurring, list_recurring, the two update_recurring checks and the large-purchase scan's exemption read every series", () => {
    const calls: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          for (const m of readFileSync(p, 'utf8').matchAll(/\b(?:detectRecurring|recurringHistory)\(([^)]*)\)/g)) {
            if (/scope/.test(m[1]) && !/scope\?:/.test(m[1])) calls.push(`${relative(join(root, 'src/main'), p).replace(/\\/g, '/')} ${m[1].trim()}`)
          }
        }
      }
    }
    walk(join(root, 'src/main'))
    // tools.ts: list_recurring, update_recurring, and the issue scan, whose series issues read Personal's alone.
    assert.deepEqual(calls.sort(), ["handlers/money.ts { scope: 'all' }", "tools.ts { scope: 'all' }", "tools.ts { scope: 'all' }", "tools.ts { scope: 'all' }"])
  })

  test('update_recurring finds a venture series that list_recurring shows', () => {
    const key = 'bayview condo association|-'
    const listed = (runTool('list_recurring', {}).result as Array<{ key: string; venture?: string }>).find((s) => s.key === key)
    assert.deepEqual(listed && [listed.key, listed.venture], [key, 'Bayview Condo'])
    runTool('update_recurring', { key, name: 'Condo dues' })
    assert.equal(db.recurringOverrides().get(key)?.name, 'Condo dues')
    assert.equal(detectRecurring({ scope: 'all' }).find((s) => s.key === key)?.name, 'Condo dues')
    // Still the venture's, and still out of Personal.
    assert.equal(detectRecurring().filter((s) => s.key === key).length, 0)
    db.setRecurringOverride(key, { name: null })
  })

  test('a line placed in Personal on a venture-held account stays Personal after the rules run', () => {
    const latest = (name: string): { id: string; posted: number } =>
      db.get<{ id: string; posted: number }>('SELECT id, posted FROM transactions WHERE account_id = ? AND merchant = ? ORDER BY posted DESC LIMIT 1', RENTAL, name)!
    const dues = latest('Bayview Condo Association')
    const before = db.bucketFields([dues.id])
    assert.deepEqual(before, [{ id: dues.id, bucketId: venture(), source: 'rule' }])
    db.setTransactionsBucket([dues.id], null)
    db.applyBucketRules()
    assert.deepEqual(db.bucketFields([dues.id]), [{ id: dues.id, bucketId: null, source: 'user' }])
    // Its latest payment is Personal now, so the series is too.
    const s = detectRecurring().find((x) => x.key === 'bayview condo association|-')
    assert.deepEqual(s && [s.owner, s.personalBp], [null, 10000])
    db.restoreBucketFields(before)
    db.applyBucketRules()
    assert.equal(detectRecurring().filter((x) => BAYVIEW.test(x.name)).length, 0)
  })

  test('putting an account in a venture makes an auto rule and moves its lines; taking it out removes both', () => {
    const studio = db.saveBucket({ name: 'Studio', kind: 'business' })
    const visa = 'demo:card-visa'
    const lines = (): Array<{ id: string; bucket_id: number | null; bucket_source: string | null; transfer: number | null; text: string }> =>
      db.all(
        `SELECT t.id, t.bucket_id, t.bucket_source, c.kind = 'transfer' AS transfer, lower(t.description || ' ' || COALESCE(t.merchant, '')) AS text
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.account_id = ?`,
        visa
      )
    assert.ok(lines().every((l) => l.bucket_id === null))
    // One purchase the user put in Personal by hand stays there.
    const [kept, picked] = lines().filter((l) => !l.transfer)
    db.setTransactionsBucket([kept.id], null)
    // A rule made on purpose before the account went in still wins over the account's newer auto rule.
    const text = db.getTransaction(picked.id)!.description.toLowerCase()
    const rule = db.addBucketRule({ bucketId: venture(), accountId: visa, contains: text })

    db.updateAccount(visa, { bucketId: studio })
    assert.deepEqual(
      db.listBucketRules(studio).map((r) => [r.accountId, r.contains, r.amountCents, r.fromDay, r.toDay, r.auto]),
      [[visa, null, null, null, null, true]]
    )
    const purchases = (): ReturnType<typeof lines> => lines().filter((l) => !l.transfer && l.id !== kept.id)
    const byRule = purchases().filter((l) => l.text.includes(text))
    assert.ok(byRule.length > 0 && byRule.every((l) => l.bucket_id === venture() && l.bucket_source === 'rule'))
    const moved = purchases().filter((l) => !l.text.includes(text))
    assert.ok(moved.length > 20, `${moved.length} purchases`)
    assert.ok(moved.every((l) => l.bucket_id === studio && l.bucket_source === 'rule'))
    // The card's payments are money moved between the user's own accounts.
    assert.ok(lines().filter((l) => l.transfer).every((l) => l.bucket_id === null))
    assert.deepEqual(db.bucketFields([kept.id]), [{ id: kept.id, bucketId: null, source: 'user' }])
    db.deleteBucketRule(rule)
    db.applyBucketRules()
    assert.ok(purchases().every((l) => l.bucket_id === studio))

    // The auto rule goes only with the account. One that's gone anyway comes back when the venture is set again.
    const auto = db.listBucketRules(studio)[0]
    assert.throws(() => db.deleteBucketRule(auto.id), /take the account out of the venture/)
    assert.throws(() => runTool('delete_bucket_rule', { rule_id: auto.id }), /take the account out of the venture/)
    db.all('DELETE FROM bucket_rules WHERE id = ?', auto.id)
    db.applyBucketRules()
    assert.ok(purchases().every((l) => l.bucket_id === null))
    db.updateAccount(visa, { bucketId: studio })
    assert.deepEqual(db.listBucketRules(studio).map((r) => [r.accountId, r.auto]), [[visa, true]])
    assert.ok(purchases().every((l) => l.bucket_id === studio))

    db.updateAccount(visa, { bucketId: null })
    assert.deepEqual(db.listBucketRules(studio), [])
    assert.ok(lines().every((l) => l.bucket_id === null))
    // An auto rule for an account its venture no longer holds (one an undo put back) moves nothing.
    db.restoreBucketRule(auto)
    db.applyBucketRules()
    assert.ok(lines().every((l) => l.bucket_id === null))
    db.deleteBucket(studio)
  })

  test("deleting a rule that put all of a venture's account in it leaves the account's lines there", () => {
    const rules = db.listBucketRules(venture()).filter((r) => r.accountId === RENTAL)
    const auto = rules[0]
    db.all('DELETE FROM bucket_rules WHERE id = ?', auto.id)
    const own = db.addBucketRule({ bucketId: venture(), accountId: RENTAL })
    db.deleteBucketRule(own)
    db.applyBucketRules()
    assert.deepEqual(db.listBucketRules(venture()).filter((r) => r.accountId === RENTAL).map((r) => r.auto), [true])
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND bucket_id IS NOT ?', RENTAL, venture())!.n, 0)
  })

  test("the sample's rental needs no rule of its own: its account's auto rule moves every line", () => {
    const rules = db.listBucketRules(venture())
    assert.deepEqual(rules.map((r) => [r.accountId, r.auto]).sort(), [['demo:condo', true], ['demo:condo-mortgage', true], [RENTAL, true]])
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND (bucket_id IS NOT ? OR bucket_source IS NOT ?)', RENTAL, venture(), 'rule')!.n, 0)
  })
})

const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const cash = (id: string, name: string, cents: number): void => {
  db.upsertAccount({ id, source: 'csv', name, institution: null, currency: 'USD', balanceCents: cents, availableCents: null, balanceDate: db.now() })
  db.updateAccount(id, { assetType: 'cash' })
}
const line = (id: string, accountId: string, posted: number, cents: number, description: string, categoryName: string | null, source: 'user' | 'rule' = 'user'): void => {
  db.insertTransactionIfNew({ id, accountId, posted, amountCents: cents, description, pending: false })
  if (categoryName) db.setTransactionFields(id, { categoryId: category(categoryName), source })
}
const where = (id: string): [number | null, string | null] => {
  const t = db.bucketFields([id])[0]
  return [t.bucketId, t.source]
}

describe('money moved between the user and a venture', () => {
  afterEach(db.closeDb)

  /** The owner tops up the shop's account each month: filed as a transfer on checking, and as `shopSide` on the shop's account. */
  const topUps = (shopSide: string | null): void => {
    db.openDb(':memory:')
    cash('csv:chk', 'Checking', 900_000)
    cash('csv:biz', 'Shop Checking', 200_000)
    db.updateAccount('csv:biz', { bucketId: db.saveBucket({ name: 'Shop', kind: 'business' }) })
    for (let k = 1; k <= 6; k++) {
      const posted = db.now() - k * 30 * 86_400
      line(`out${k}`, 'csv:chk', posted, -50_000, 'TRANSFER TO SHOP', 'Transfers')
      line(`in${k}`, 'csv:biz', posted, 50_000, 'TRANSFER FROM CHECKING', shopSide)
    }
    db.applyBucketRules()
  }

  for (const [shopSide, label] of [
    ['Transfers', 'filed as a transfer'],
    [null, 'uncategorized'],
    ['Other Income', 'filed as income']
  ] as const) {
    test(`is Personal's on the user's side, with the shop's side ${label}: Spendable still sees it leave checking`, () => {
      topUps(shopSide)
      const all = detectRecurring({ scope: 'all' })
      assert.deepEqual(all.map((s) => [s.accountId, s.pairAccountId, s.typicalCents, s.owner, s.personalBp]), [['csv:chk', 'csv:biz', -50_000, null, 10000]])
      assert.deepEqual(detectRecurring().map((s) => s.key), all.map((s) => s.key))
      const spend = getSpendable()
      assert.deepEqual(spend.accounts.map((a) => a.id), ['csv:chk'])
      assert.ok(spend.items.length > 0 && spend.items.every((i) => i.accountId === 'csv:chk' && i.cents === -50_000))
    })
  }

  test("keeps what the user chose on the shop's side, which was the side kept before, until the user's side has a choice of its own", () => {
    topUps('Transfers')
    const [plain] = detectRecurring({ scope: 'all' })
    assert.equal(plain.key, 'transfer to shop|-')
    // Not its kind: a venture's bill must not become a Personal one.
    db.setRecurringOverride('transfer from checking|+', { status: 'dismissed', name: 'Shop top-up', kind: 'bill' })
    const [s] = detectRecurring({ scope: 'all' })
    assert.deepEqual([s.key, s.dismissed, s.confirmed, s.name, s.kind], [plain.key, true, false, 'Shop top-up', plain.kind])
    db.setRecurringOverride(s.key, { status: 'confirmed' })
    const [own] = detectRecurring({ scope: 'all' })
    assert.deepEqual([own.dismissed, own.confirmed, own.name], [false, true, plain.name])
  })
})

describe('migration 36', () => {
  afterEach(db.closeDb)

  /** A database at 35 with a shop and a rental, each holding an account, and an account of the user's own. */
  const at35 = (): { shop: number; rental: number } => {
    db.openDb(':memory:', { migrate: false })
    db.migrate({ target: 35 })
    const account = (id: string): void => db.upsertAccount({ id, source: 'csv', name: id, institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    for (const id of ['csv:shop', 'csv:rent', 'csv:mine']) account(id)
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    const rental = db.saveBucket({ name: 'Rental', kind: 'rental' })
    db.all('UPDATE accounts SET bucket_id = ? WHERE id = ?', shop, 'csv:shop')
    db.all('UPDATE accounts SET bucket_id = ? WHERE id = ?', rental, 'csv:rent')
    const txn = (id: string, accountId: string): void => db.insertTransactionIfNew({ id, accountId, posted: 1_760_000_000, amountCents: -2_500, description: `SUPPLIES ${id}`, pending: false })
    for (const [id, a] of [['s1', 'csv:shop'], ['s2', 'csv:shop'], ['s3', 'csv:shop'], ['r1', 'csv:rent'], ['m1', 'csv:mine']]) txn(id, a)
    return { shop, rental }
  }

  test('every account a venture holds gets an auto rule unless a rule already takes all its lines, and the rules run', () => {
    const { shop, rental } = at35()
    // The rental's account already has a rule for all of it, as the sample used to. One of the shop's lines
    // goes to the rental by an older rule of the user's, which the shop's newer auto rule doesn't override.
    db.all('INSERT INTO bucket_rules (bucket_id, account_id, created_at) VALUES (?, ?, 0)', rental, 'csv:rent')
    db.all('INSERT INTO bucket_rules (bucket_id, account_id, contains, created_at) VALUES (?, ?, ?, 0)', rental, 'csv:shop', 'supplies s3')
    db.setTransactionsBucket(['s2'], null)

    db.migrate()
    assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
    assert.deepEqual(
      db.listBucketRules().map((r) => [r.bucketId, r.accountId, r.contains, r.auto]),
      [
        [rental, 'csv:rent', null, false],
        [rental, 'csv:shop', 'supplies s3', false],
        [shop, 'csv:shop', null, true]
      ]
    )
    assert.deepEqual([where('s1'), where('s2'), where('s3'), where('r1'), where('m1')], [[shop, 'rule'], [null, 'user'], [rental, 'rule'], [rental, 'rule'], [null, null]])
    assert.equal(db.getSetting('migrate.after.36'), null)
  })

  test('a follow-up that was cut short runs on the next migrate', () => {
    const { shop } = at35()
    const cut = db.MIGRATIONS.map((s) => (s.after ? { ...s, after: (): void => { throw new Error('power cut') } } : s))
    assert.throws(() => db.migrate({ steps: cut }), /Migration step 36's follow-up failed: power cut/)
    assert.equal(db.schemaVersion(), db.LATEST_SCHEMA_VERSION)
    assert.deepEqual(where('s1'), [null, null])
    assert.equal(db.migrate(), 0)
    assert.deepEqual(where('s1'), [shop, 'rule'])
    assert.equal(db.getSetting('migrate.after.36'), null)
  })
})

describe('a series partly Personal', () => {
  // November 7, 2026: the latest paycheck, 15 days back, is in October, the last full month.
  before(() => {
    mock.timers.enable({ apis: ['Date'], now: noonOn(2026, 11, 7) * 1000 })
    db.openDb(':memory:')
  })
  after(() => {
    db.closeDb()
    mock.timers.reset()
  })

  test("counts at Personal's share in the take-home and in the budget's bills", () => {
    cash('csv:chk', 'Checking', 500_000)
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    for (let k = 1; k <= 6; k++) {
      const posted = db.now() - (k * 30 - 15) * 86_400
      line(`pay${k}`, 'csv:chk', posted, 400_000, 'ACME PAYROLL', 'Paycheck')
      // The water bill comes as two charges on one day.
      line(`water${k}a`, 'csv:chk', posted + 3_600, -6_000, 'CITY WATER', 'Utilities')
      line(`water${k}b`, 'csv:chk', posted + 3_600, -4_000, 'CITY WATER', 'Utilities')
    }
    // The latest paycheck is split half and half with the shop, and the latest water bill's smaller charge is the shop's.
    db.splitTransaction('pay1', [{ amountCents: 200_000, categoryId: category('Paycheck') }, { amountCents: 200_000, categoryId: category('Paycheck'), bucketId: shop }])
    db.setTransactionsBucket(['water1b'], shop)

    const all = detectRecurring({ scope: 'all' })
    const pay = all.find((s) => /acme/i.test(s.name))!
    const water = all.find((s) => /water/i.test(s.name))!
    assert.deepEqual([pay.kind, pay.owner, pay.personalBp], ['income', null, 5000])
    assert.deepEqual([water.owner, water.personalBp], [null, 6000])
    // The debt plan's take-home is the Take-home run rate (spec 1.6): the mean of the checks in the three full months
    // before this one (October 23, September 23 and August 24), each at what Personal was paid, so the latest at its
    // half: (4,000 + 4,000 + 2,000) / 3.
    const debts = getDebts()
    assert.deepEqual(debts.incomeSources, [{ name: pay.name, monthlyCents: 333_333 }])
    assert.equal(debts.takeHomeCents, 333_333)
    const bills = billShares().filter((b) => b.series.key === water.key)
    assert.deepEqual(bills.map((b) => [b.split, b.monthly]), [[false, Math.round(Math.abs(water.monthlyCents) * 0.6)]])
  })
})

describe("a venture's own money in Review's issue scan", () => {
  before(() => db.openDb(':memory:'))
  after(db.closeDb)

  test("a venture's scheduled payment is no large purchase", () => {
    cash('csv:rent', 'Rental Checking', 900_000)
    db.updateAccount('csv:rent', { bucketId: db.saveBucket({ name: 'Rental', kind: 'rental' }) })
    // Three monthly payments, the category's only lines: a large purchase if it weren't scheduled.
    for (let k = 0; k < 3; k++) line(`loan${k}`, 'csv:rent', db.now() - (k * 30 + 5) * 86_400, -200_000, 'HARBOR LENDING', 'Housing', 'rule')
    assert.deepEqual(detectRecurring().map((s) => s.name), [])
    assert.equal(detectRecurring({ scope: 'all' }).filter((s) => /harbor/i.test(s.name)).length, 1)
    assert.deepEqual(openIssues().filter((i) => i.kind === 'large_purchase'), [])
  })
})

describe('merging accounts', () => {
  before(() => db.openDb(':memory:'))
  after(db.closeDb)

  test("the kept account's lines go where its venture's rules put them, and back on undo", () => {
    cash('csv:old', 'Shop Checking', 100_000)
    cash('csv:new', 'Shop Checking (new feed)', 120_000)
    const shop = db.saveBucket({ name: 'Shop', kind: 'business' })
    db.updateAccount('csv:old', { bucketId: shop })
    line('o1', 'csv:old', db.now() - 10 * 86_400, -2_500, 'SUPPLIES', 'Shopping', 'rule')
    // The kept account's own line, well before the old one's, outside what the merge pairs up.
    line('n1', 'csv:new', db.now() - 200 * 86_400, -900, 'PRINTER INK', 'Shopping', 'rule')
    db.applyBucketRules()
    assert.deepEqual([where('o1'), where('n1')], [[shop, 'rule'], [null, null]])

    runTool('merge_accounts', { from_account_id: 'csv:old', into_account_id: 'csv:new' })
    assert.equal(db.listAccounts().find((a) => a.id === 'csv:new')!.bucketId, shop)
    assert.deepEqual(db.listBucketRules(shop).map((r) => [r.accountId, r.auto]), [['csv:new', true]])
    assert.deepEqual([where('o1'), where('n1')], [[shop, 'rule'], [shop, 'rule']])

    const c = db.getChange(db.get<{ id: number }>("SELECT MAX(id) AS id FROM changes WHERE tool = 'merge_accounts'")!.id)!
    undo(c.tool, c.before, c.after, c.input)
    assert.equal(db.listAccounts().find((a) => a.id === 'csv:new')!.bucketId, null)
    assert.deepEqual(db.listBucketRules(shop).map((r) => [r.accountId, r.auto]), [['csv:old', true]])
    assert.deepEqual([where('o1'), where('n1')], [[shop, 'rule'], [null, null]])
  })
})

describe('the owner rule', () => {
  before(() => {
    db.openDb(':memory:')
    db.saveBucket({ name: 'Elm St', kind: 'rental', residenceFrom: '2020-06-01', residenceTo: '2021-06-30' })
  })
  after(db.closeDb)

  const line = (o: Partial<OwnerLine>): OwnerLine => ({ ownBucket: false, bucketId: null, bucketSource: null, accountBucketId: null, day: '2022-01-10', income: false, ...o })

  test("a split part's own venture, then the transaction's, then the account's unless placed by hand, then Personal", () => {
    const homes = residences()
    assert.equal(lineOwner(line({}), homes), null)
    assert.equal(lineOwner(line({ bucketId: 7 }), homes), 7)
    assert.equal(lineOwner(line({ accountBucketId: 7 }), homes), 7)
    assert.equal(lineOwner(line({ accountBucketId: 7, bucketSource: 'rule' }), homes), 7)
    assert.equal(lineOwner(line({ accountBucketId: 7, bucketSource: 'user' }), homes), null)
    assert.equal(lineOwner(line({ accountBucketId: 7, bucketSource: 'ai' }), homes), null)
    assert.equal(lineOwner(line({ ownBucket: true, bucketId: null, accountBucketId: 7 }), homes), null)
    assert.equal(lineOwner(line({ ownBucket: true, bucketId: 8, accountBucketId: 7 }), homes), 8)
  })

  test("a home's costs while the user lived there are Personal; its income and later costs are the venture's", () => {
    const homes = residences()
    const elm = db.bucketByName('Elm St')!.id
    assert.equal(lineOwner(line({ bucketId: elm, day: '2020-07-12' }), homes), null)
    assert.equal(lineOwner(line({ bucketId: elm, day: '2020-07-12', income: true }), homes), elm)
    assert.equal(lineOwner(line({ bucketId: elm, day: '2021-07-15' }), homes), elm)
    assert.equal(lineOwner(line({ accountBucketId: elm, day: '2021-06-30' }), homes), null)
  })
})
