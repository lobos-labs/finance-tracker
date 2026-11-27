import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db.ts'
import { getSummary } from '../src/main/summary.ts'
import { getBenefits } from '../src/main/benefits.ts'
import { getBudget } from '../src/main/budget.ts'
import { transactionsCsv } from '../src/main/csvExport.ts'
import { clearDemoData, loadDemoData } from '../src/main/demo.ts'
import { undo } from '../src/main/journal.ts'
import { configureLicense } from '../src/main/license.ts'
import { buildDigest } from '../src/main/insights.ts'
import { detectRecurring } from '../src/main/recurring.ts'
import { buildModel } from '../src/main/spendModel.ts'
import { openIssues, runAssistantTool, toolRisk } from '../src/main/tools.ts'
import { dayOn, noonOn } from './days.ts'

// A split transaction counts as its parts wherever money is summed by
// category or venture, and stays whole everywhere it's a transaction (the
// list, recurring series, the bank's own amount). Tags are labels on the
// transaction, matched in any case.

configureLicense({ dev: true })

const dir = mkdtempSync(join(tmpdir(), 'finance-splits-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const category = (name: string): number => db.listCategories().find((c) => c.name === name)!.id
const month = dayOn(new Date()).slice(0, 7)
/** Noon on a day of this month, `back` months ago. */
const day = (d: number, back = 0): number => noonOn(Number(month.slice(0, 4)), Number(month.slice(5)) - back, d)
const txn = (id: string, description: string, cents: number, posted = day(1), cat?: string): void => {
  db.upsertTransaction({ id, accountId: 'manual:a', posted, amountCents: cents, description, pending: false })
  if (cat) db.setTransactionFields(id, { categoryId: category(cat), source: 'ai', confidence: 'high', merchant: description === 'COSTCO WHSE #123' ? 'Costco' : null })
}
const spent = (name: string, buckets?: number[]): number => getSummary(month, buckets).byCategory.find((c) => c.name === name)?.cents ?? 0
const revert = (changeId: number): void => {
  const c = db.getChange(changeId)!
  undo(c.tool, c.before, c.after, c.input)
  db.markChangeUndone(changeId)
}

let rental = 0

describe('split transactions', () => {
  before(() => {
    process.env['FINANCE_TRACKER_DOCS_DIR'] = join(dir, 'docs')
    db.openDb(join(dir, 'finance.db'))
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    rental = db.saveBucket({ name: 'Rental', kind: 'rental' })
    txn('costco', 'COSTCO WHSE #123', -10000, day(1), 'Groceries')
    txn('market', 'GREEN MARKET', -2000, day(1), 'Groceries')
  })
  after(db.closeDb)

  test('a split needs two or more parts, each with the transaction\'s sign, adding up to it exactly', () => {
    const g = category('Groceries')
    assert.throws(() => db.splitTransaction('costco', [{ amountCents: -10000, categoryId: g }]), /at least two parts/)
    assert.throws(() => db.splitTransaction('costco', [{ amountCents: -6000, categoryId: g }, { amountCents: -3000, categoryId: g }]), /add up to -90\.00, not -100\.00/)
    assert.throws(() => db.splitTransaction('costco', [{ amountCents: -12000, categoryId: g }, { amountCents: 2000, categoryId: g }]), /Part 2 must be negative/)
    assert.throws(() => db.splitTransaction('costco', [{ amountCents: -10000, categoryId: g }, { amountCents: 0, categoryId: g }]), /Part 2 must be negative/)
    assert.throws(() => db.splitTransaction('costco', [{ amountCents: -50.5, categoryId: g }, { amountCents: -9949.5, categoryId: g }]), /whole number of cents/)
    assert.throws(() => db.splitTransaction('costco', [{ amountCents: -5000, categoryId: 9999 }, { amountCents: -5000, categoryId: g }]), /No category 9999/)
    assert.throws(() => db.splitTransaction('nope', [{ amountCents: -5000, categoryId: g }, { amountCents: -5000, categoryId: g }]), /No transaction/)
    assert.deepEqual(db.splitParts('costco'), [])
  })

  test('totals, the summary, top merchants and buckets count each part in its own category and venture', () => {
    const before = getSummary(month)
    assert.equal(spent('Groceries'), 12000)
    db.splitTransaction('costco', [
      { amountCents: -6000, categoryId: category('Groceries') },
      { amountCents: -2500, categoryId: category('Dining Out'), note: '  food court ' },
      { amountCents: -1500, categoryId: category('Shopping'), bucketId: rental }
    ])
    const t = db.getTransaction('costco')!
    assert.equal(t.amountCents, -10000, 'the transaction keeps the bank\'s amount')
    assert.equal(t.categoryId, category('Groceries'), 'and its own category, for unsplitting')
    assert.deepEqual(t.splits.map((s) => [s.amountCents, s.categoryId, s.bucketId, s.note]), [
      [-6000, category('Groceries'), null, null],
      [-2500, category('Dining Out'), null, 'food court'],
      [-1500, category('Shopping'), rental, null]
    ])
    // Personal leaves the part in the rental out; with the rental switched on it's back.
    assert.equal(spent('Groceries'), 8000)
    assert.equal(spent('Dining Out'), 2500)
    assert.equal(spent('Shopping'), 0)
    assert.equal(spent('Shopping', [0, rental]), 1500)
    const s = getSummary(month)
    assert.equal(s.spendCents, before.spendCents - 1500)
    assert.equal(s.txnCount, 2, 'a split transaction is still one transaction')
    const costco = getSummary(month, [0, rental]).topMerchants.find((m) => m.merchant === 'Costco')!
    assert.deepEqual([costco.cents, costco.count], [10000, 1])
    // The venture gets its part, and only its part.
    const b = db.listBuckets().find((x) => x.id === rental)!
    assert.deepEqual([b.outCents, b.txnCount], [1500, 1])
    assert.deepEqual(db.getBucket(rental).byCategory.map((c) => [c.name, c.outCents]), [['Shopping', 1500]])
  })

  test('the transaction list shows it once, and a category filter sums the parts it matches', () => {
    const all = db.listTransactions({})
    assert.equal(all.rows.filter((r) => r.id === 'costco').length, 1)
    assert.equal(all.sumCents, -12000)
    const dining = db.listTransactions({ categoryId: category('Dining Out') })
    assert.deepEqual([dining.rows.map((r) => r.id), dining.total, dining.sumCents], [['costco'], 1, -2500])
    const groceries = db.listTransactions({ categoryId: category('Groceries') })
    assert.deepEqual([groceries.rows.map((r) => r.id).sort(), groceries.total, groceries.sumCents], [['costco', 'market'], 2, -8000])
    assert.deepEqual(db.listTransactions({ bucketId: rental }).sumCents, -1500)
    assert.equal(db.listTransactions({ bucketId: 'personal' }).sumCents, -10500)
    // The Review assistant's search reads the parts too.
    const found = runAssistantTool('search_transactions', { category: 'Dining Out' }).result as Array<{ id: string; category: string; parts?: Array<{ amount: number; category: string; bucket: string }> }>
    assert.deepEqual(found.map((r) => r.id), ['costco'])
    assert.equal(found[0].category, 'Split')
    assert.deepEqual(found[0].parts!.map((p) => [p.amount, p.category, p.bucket]), [
      [-60, 'Groceries', 'Personal'],
      [-25, 'Dining Out', 'Personal'],
      [-15, 'Shopping', 'Rental']
    ])
  })

  test('the budget counts the parts, a one-off part apart from base spending', () => {
    txn('bulk', 'WAREHOUSE CLUB', -4000, day(1), 'Groceries')
    db.splitTransaction('bulk', [
      { amountCents: -3000, categoryId: category('Groceries') },
      { amountCents: -1000, categoryId: category('Groceries'), oneTime: true }
    ])
    const view = getBudget(month)
    assert.equal(view.rows.find((r) => r.name === 'Groceries')?.spentCents, 6000 + 2000 + 3000)
    assert.equal(view.rows.find((r) => r.name === 'Dining Out')?.spentCents, 2500)
    assert.equal(view.oneOffs.spentCents, 1000, 'the one-off part, and not the rental\'s Shopping part')
    assert.deepEqual(view.oneOffs.items.map((o) => [o.id, o.cents]), [['bulk', 1000]])
    db.unsplitTransaction('bulk')
    db.deleteTransaction('bulk')
  })

  test('rules, history and Claude leave a split transaction\'s parts alone', () => {
    const parts = db.splitParts('costco')
    db.upsertRule('merchant', 'Costco', category('Shopping'))
    assert.equal(db.countRuleMatches('merchant', 'Costco', category('Shopping')), 0)
    assert.equal(db.applyRulesToAll(), 0)
    db.setTransactionFields('costco', { categoryId: category('Transfers'), source: 'ai', confidence: 'high' })
    db.setTransactionFields('costco', { categoryId: category('Transfers'), source: 'rule' })
    assert.equal(db.getTransaction('costco')!.categoryId, category('Groceries'))
    assert.deepEqual(db.splitParts('costco'), parts)
    assert.ok(!db.listUncategorized(true).some((t) => t.id === 'costco'), 'never offered to Claude')
    assert.equal(db.findHistoryMatch(db.getDescKey('costco')!, -1), null, 'and never used as history')
    assert.ok(!openIssues().some((i) => i.transaction_ids?.includes('costco') && i.kind !== 'possible_duplicate'))
    // The assistant's categorize skips it; split_transaction is how its parts change.
    assert.throws(() => runAssistantTool('categorize', { transaction_ids: ['costco'], category: 'Shopping' }), /split/)
    const r = runAssistantTool('categorize', { transaction_ids: ['costco', 'market'], category: 'Groceries' }).result as { updated: number; skipped_split: number }
    assert.deepEqual([r.updated, r.skipped_split], [1, 1])
    assert.deepEqual(db.splitParts('costco'), parts)
  })

  test('a bank changing the amount moves the difference to the largest part, or ends the split', () => {
    db.upsertTransaction({ id: 'costco', accountId: 'manual:a', posted: day(1), amountCents: -11000, description: 'COSTCO WHSE #123', pending: false })
    assert.deepEqual(db.splitParts('costco').map((s) => s.amountCents), [-7000, -2500, -1500])
    db.upsertTransaction({ id: 'costco', accountId: 'manual:a', posted: day(1), amountCents: -10000, description: 'COSTCO WHSE #123', pending: false })
    assert.deepEqual(db.splitParts('costco').map((s) => s.amountCents), [-6000, -2500, -1500])
    // A refund in its place can't keep the parts.
    txn('flip', 'FLIP', -3000)
    db.splitTransaction('flip', [{ amountCents: -2000, categoryId: null }, { amountCents: -1000, categoryId: null }])
    db.upsertTransaction({ id: 'flip', accountId: 'manual:a', posted: day(1), amountCents: 3000, description: 'FLIP', pending: false })
    assert.deepEqual(db.splitParts('flip'), [])
    db.deleteTransaction('flip')
  })

  test('the CSV has a row per part under the transaction\'s id, and the tags', () => {
    db.addTags(['costco'], ['Reimbursable'])
    const rows = db.allTransactionsForExport().filter((r) => r.id === 'costco')
    assert.deepEqual(rows.map((r) => [r.amountCents, r.categoryName, r.bucketName, r.notes]), [
      [-6000, 'Groceries', null, null],
      [-2500, 'Dining Out', null, 'food court'],
      [-1500, 'Shopping', 'Rental', null]
    ])
    const lines = transactionsCsv(rows).split(/\r?\n/)
    assert.equal(lines.length, 4)
    assert.ok(lines.slice(1).every((l) => l.endsWith(',Reimbursable,costco')), lines.join('\n'))
    assert.match(lines[3], /,Shopping,Rental,-15\.00,/)
    db.removeTags(['costco'], ['reimbursable'])
  })

  test('unsplit puts the transaction back whole, in its own category', () => {
    const had = db.unsplitTransaction('costco')
    assert.equal(had.length, 3)
    assert.deepEqual(db.getTransaction('costco')!.splits, [])
    assert.equal(spent('Groceries'), 12000)
    assert.equal(spent('Dining Out'), 0)
    assert.equal(db.listBuckets().find((x) => x.id === rental)!.outCents, 0)
    assert.equal(db.listTransactions({ categoryId: category('Groceries') }).sumCents, -12000)
  })

  test('recurring series see the whole transaction', () => {
    for (let back = 4; back >= 1; back--) txn(`phone${back}`, 'BLUEWAVE MOBILE', -8000, day(5, back), 'Utilities')
    db.splitTransaction('phone1', [
      { amountCents: -5000, categoryId: category('Utilities') },
      { amountCents: -3000, categoryId: category('Utilities'), bucketId: rental }
    ])
    const s = detectRecurring().find((x) => x.name.toLowerCase().includes('bluewave'))!
    assert.ok(s, 'the phone bill is still a series')
    assert.deepEqual([s.lastCents, s.priceChanged], [-8000, false])
  })

  test('the Review tools split, unsplit and tag, each journaled with Undo', () => {
    for (const name of ['split_transaction', 'unsplit_transaction', 'add_tags', 'remove_tags']) assert.equal(toolRisk(name, {}), 'write', name)
    // Amounts given as positive cents on money out are read as money out.
    const split = runAssistantTool('split_transaction', { transaction_id: 'market', parts: [{ amount_cents: 1500, category: 'Groceries' }, { amount_cents: 500, category: 'Personal Care', one_time: true }] })
    assert.match(split.action!, /^Split GREEN MARKET -\$20\.00: Groceries -\$15\.00, Personal Care -\$5\.00/)
    assert.deepEqual(db.splitParts('market').map((s) => [s.amountCents, s.oneTime]), [[-1500, false], [-500, true]])
    assert.throws(() => runAssistantTool('split_transaction', { transaction_id: 'market', parts: [{ amount_cents: -1500, category: 'Groceries' }, { amount_cents: 400, category: 'Groceries' }] }), /must be negative/)
    const unsplit = runAssistantTool('unsplit_transaction', { transaction_id: 'market' })
    assert.deepEqual(db.splitParts('market'), [])
    revert(unsplit.changeId!)
    assert.deepEqual(db.splitParts('market').map((s) => s.amountCents), [-1500, -500])
    revert(split.changeId!)
    assert.deepEqual(db.splitParts('market'), [])

    const tag = runAssistantTool('add_tags', { transaction_ids: ['market', 'costco'], tags: ['Vacation', 'vacation ', 'Work trip'] })
    assert.equal(tag.action, 'Tagged 2 transactions Vacation, Work trip')
    assert.deepEqual(db.getTransaction('market')!.tags, ['Vacation', 'Work trip'])
    const untag = runAssistantTool('remove_tags', { transaction_ids: ['market'], tags: ['WORK TRIP'] })
    assert.deepEqual(db.getTransaction('market')!.tags, ['Vacation'])
    revert(untag.changeId!)
    assert.deepEqual(db.getTransaction('market')!.tags, ['Vacation', 'Work trip'])
    revert(tag.changeId!)
    assert.deepEqual([db.getTransaction('market')!.tags, db.getTransaction('costco')!.tags], [[], []])
  })
})

describe('a split transaction that moves, waits to post, or is saved again', () => {
  let rental = 0
  const ventures = (id: string): Array<number | null> => db.splitParts(id).map((s) => s.bucketId)
  const venture = (): { outCents: number; txnCount: number } => db.listBuckets().find((b) => b.id === rental)!
  before(() => {
    db.openDb(join(dir, 'moves.db'))
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    rental = db.saveBucket({ name: 'Rental', kind: 'rental' })
  })
  after(() => {
    delete process.env['FINANCE_TRACKER_PLAN']
    configureLicense({ dev: true })
    db.closeDb()
  })

  test('moved to a venture and back, its parts go with it; one put in a venture of its own stays', () => {
    txn('hd', 'HOME DEPOT', -20000, day(2), 'Housing')
    db.splitTransaction('hd', [{ amountCents: -5000, categoryId: category('Housing') }, { amountCents: -15000, categoryId: category('Shopping') }])
    const personal = getSummary(month).spendCents
    assert.equal(db.setTransactionsBucket(['hd'], rental), 1)
    assert.deepEqual(ventures('hd'), [rental, rental])
    assert.equal(getSummary(month).spendCents, personal - 20000)
    assert.deepEqual([venture().outCents, venture().txnCount], [20000, 1])
    db.setTransactionsBucket(['hd'], null)
    assert.deepEqual(ventures('hd'), [null, null])
    assert.equal(getSummary(month).spendCents, personal)
    // A part the user put in the rental stays there; the other follows the transaction.
    db.splitTransaction('hd', [{ amountCents: -5000, categoryId: category('Housing'), bucketId: rental }, { amountCents: -15000, categoryId: category('Shopping') }])
    const before = db.bucketFields(['hd'])
    db.setTransactionsBucket(['hd'], rental)
    assert.deepEqual(ventures('hd'), [rental, rental])
    db.restoreBucketFields(before)
    assert.deepEqual(ventures('hd'), [rental, null], 'an undo puts the parts back with the transaction')
    assert.equal(venture().outCents, 5000)
    db.unsplitTransaction('hd')
    db.deleteTransaction('hd')
  })

  test('a venture rule moves a split transaction\'s parts in, and out again when the rule goes', () => {
    txn('lowes', 'LOWES #42', -9000, day(2), 'Housing')
    db.splitTransaction('lowes', [{ amountCents: -3000, categoryId: category('Housing') }, { amountCents: -6000, categoryId: category('Shopping') }])
    const rule = db.addBucketRule({ bucketId: rental, contains: 'lowes' })
    db.applyBucketRules()
    assert.equal(db.getTransaction('lowes')!.bucketId, rental)
    assert.deepEqual(ventures('lowes'), [rental, rental])
    assert.equal(venture().outCents, 9000)
    db.deleteBucketRule(rule)
    db.applyBucketRules()
    assert.deepEqual(ventures('lowes'), [null, null])
    assert.equal(venture().outCents, 0)
    db.unsplitTransaction('lowes')
    db.deleteTransaction('lowes')
  })

  test('a split saved before parts could follow keeps a venture that differs as its own', () => {
    txn('old', 'OLD SPLIT', -4000, day(2), 'Shopping')
    db.splitTransaction('old', [{ amountCents: -1000, categoryId: null, bucketId: rental }, { amountCents: -3000, categoryId: null }])
    // As the step that added own_bucket found it: the venture written on each part, own_bucket set from it.
    db.all('UPDATE transaction_splits SET own_bucket = 0')
    db.all('UPDATE transaction_splits SET own_bucket = 1 WHERE bucket_id IS NOT (SELECT t.bucket_id FROM transactions t WHERE t.id = transaction_splits.transaction_id)')
    db.setTransactionsBucket(['old'], rental)
    db.setTransactionsBucket(['old'], null)
    assert.deepEqual(ventures('old'), [rental, null])
    db.unsplitTransaction('old')
    db.deleteTransaction('old')
  })

  test('a pending row is split once it posts', () => {
    db.upsertTransaction({ id: 'target', accountId: 'manual:a', posted: day(2), amountCents: -9000, description: 'TARGET 555', pending: true })
    const parts = [{ amountCents: -3000, categoryId: category('Groceries') }, { amountCents: -6000, categoryId: category('Shopping') }]
    assert.throws(() => db.splitTransaction('target', parts), /Split it once it posts/)
    assert.throws(() => runAssistantTool('split_transaction', { transaction_id: 'target', parts: [{ amount_cents: 3000, category: 'Groceries' }, { amount_cents: 6000, category: 'Shopping' }] }), /once it posts/)
    db.upsertTransaction({ id: 'target', accountId: 'manual:a', posted: day(2), amountCents: -9000, description: 'TARGET 555', pending: false })
    assert.equal(db.splitTransaction('target', parts).length, 2)
    db.unsplitTransaction('target')
    db.deleteTransaction('target')
  })

  test('on Free, a split saved again as it was needs no Ventures; moving a part does', () => {
    txn('depot', 'HOME DEPOT', -10000, day(2), 'Housing')
    db.splitTransaction('depot', [{ amountCents: -6000, categoryId: category('Housing'), bucketId: rental }, { amountCents: -4000, categoryId: category('Shopping') }])
    const t = db.getTransaction('depot')!
    assert.equal(db.splitMovesVentures(t, t.splits.map((s) => ({ bucketId: s.bucketId }))), false)
    assert.equal(db.splitMovesVentures(t, [{ bucketId: rental }, { bucketId: null }, { bucketId: null }]), false, 'a part added in the transaction\'s venture')
    assert.equal(db.splitMovesVentures(t, [{ bucketId: null }, { bucketId: null }]), true)
    assert.equal(db.splitMovesVentures(t, [{ bucketId: rental }, { bucketId: rental }]), true)
    process.env['FINANCE_TRACKER_PLAN'] = 'free'
    configureLicense({ dev: true })
    const r = runAssistantTool('split_transaction', { transaction_id: 'depot', parts: [{ amount_cents: 6000, category: 'Housing', bucket: 'Rental' }, { amount_cents: 4000, category: 'Groceries', bucket: 'Personal' }] })
    assert.match(r.action!, /Groceries -\$40\.00/)
    assert.throws(() => runAssistantTool('split_transaction', { transaction_id: 'depot', parts: [{ amount_cents: 6000, category: 'Housing', bucket: 'Personal' }, { amount_cents: 4000, category: 'Groceries' }] }), /Plus/)
    delete process.env['FINANCE_TRACKER_PLAN']
    configureLicense({ dev: true })
    db.unsplitTransaction('depot')
    db.deleteTransaction('depot')
  })

  test('marked for the HSA, a split purchase counts only its health part', () => {
    txn('costco', 'COSTCO WHSE #9', -31800, day(2), 'Groceries')
    db.splitTransaction('costco', [{ amountCents: -4000, categoryId: category('Health & Medical') }, { amountCents: -27800, categoryId: category('Groceries') }])
    const care = (): { cents: number; status: string } | undefined => getBenefits().care.find((c) => c.id === 'costco')
    assert.equal(care()!.cents, 4000)
    db.setHsa(['costco'], 'reimbursed')
    assert.deepEqual([care()!.cents, care()!.status], [4000, 'reimbursed'])
    db.setHsa(['costco'], 'eligible')
    assert.equal(care()!.cents, 4000)
    // Unsplit, the whole purchase is what was marked.
    db.unsplitTransaction('costco')
    assert.equal(care()!.cents, 31800)
    db.setHsa(['costco'], null)
    db.deleteTransaction('costco')
  })

  test('the uncategorized count leaves out split transactions, as the queue does', () => {
    txn('amazon', 'AMAZON MKTPL', -5000, day(2))
    const n = getSummary(month).uncategorizedCount
    assert.equal(n, db.listUncategorized(false).length)
    const digest = buildDigest()!.uncategorizedThisMonth
    db.splitTransaction('amazon', [{ amountCents: -2000, categoryId: category('Shopping') }, { amountCents: -3000, categoryId: null }])
    assert.equal(getSummary(month).uncategorizedCount, n - 1)
    assert.equal(getSummary(month).uncategorizedCount, db.listUncategorized(false).length)
    assert.equal(buildDigest()!.uncategorizedThisMonth, digest - 1)
    db.unsplitTransaction('amazon')
    db.deleteTransaction('amazon')
  })

  test('the digest lists a split purchase once, at its personal parts\' total', () => {
    txn('warehouse', 'WAREHOUSE RUN', -31846, day(2), 'Groceries')
    db.splitTransaction('warehouse', [
      { amountCents: -14862, categoryId: category('Groceries') },
      { amountCents: -4485, categoryId: category('Shopping') },
      { amountCents: -12499, categoryId: category('Shopping'), bucketId: rental }
    ])
    const largest = buildDigest()!.largestThisMonth.filter((r) => r.merchant === 'WAREHOUSE RUN')
    assert.deepEqual(largest.map((r) => [r.amount, r.category]), [[193, 'Groceries']])
    db.unsplitTransaction('warehouse')
    db.deleteTransaction('warehouse')
  })

  test('a split recurring bill is fixed spending by its parts\' categories, without the venture\'s part', () => {
    for (let back = 6; back >= 1; back--) {
      const id = `comcast${back}`
      txn(id, 'COMCAST CABLE', -15000, day(5, back), 'Utilities')
      db.splitTransaction(id, [
        { amountCents: -8000, categoryId: category('Utilities') },
        { amountCents: -4000, categoryId: category('Subscriptions') },
        { amountCents: -3000, categoryId: category('Utilities'), bucketId: rental }
      ])
    }
    const s = detectRecurring().find((x) => x.name === 'COMCAST CABLE')!
    assert.deepEqual([s.typicalCents, s.categoryName], [-15000, 'Utilities'])
    const model = buildModel(month)
    const cat = (name: string): { fixedCents: number; events: unknown[] } | undefined => model.categories.find((c) => c.name === name)
    assert.deepEqual([cat('Utilities')!.fixedCents, cat('Utilities')!.events.length], [8000, 0])
    assert.deepEqual([cat('Subscriptions')!.fixedCents, cat('Subscriptions')!.events.length], [4000, 0])
    assert.equal(getBudget(month).rows.find((r) => r.name === 'Utilities')!.fixedCents, 8000)
    for (let back = 6; back >= 1; back--) {
      db.unsplitTransaction(`comcast${back}`)
      db.deleteTransaction(`comcast${back}`)
    }
  })
})

describe('tags', () => {
  before(() => {
    db.openDb(join(dir, 'tags.db'))
    db.upsertAccount({ id: 'manual:a', source: 'manual', name: 'Checking', institution: null, currency: 'USD', balanceCents: null, availableCents: null, balanceDate: null })
    for (const id of ['a', 'b', 'c']) txn(id, `SHOP ${id.toUpperCase()}`, -1000)
  })
  after(db.closeDb)

  test('a tag is trimmed and matched in any case, and shows as it was first typed', () => {
    assert.equal(db.addTags(['a', 'b'], ['  Vacation  ', 'reimbursable']), 4)
    assert.equal(db.addTags(['c'], ['VACATION']), 1)
    assert.equal(db.addTags(['a'], ['vacation']), 0, 'a pair is there once')
    assert.deepEqual(db.getTransaction('c')!.tags, ['Vacation'])
    assert.deepEqual(db.listTags(), [
      { tag: 'Vacation', count: 3 },
      { tag: 'reimbursable', count: 2 }
    ])
    assert.throws(() => db.addTags(['a'], ['  ', ',']), /Name a tag/)
    assert.equal(db.tagLabel('a,b;  c'), 'a b c')
    // A long tag is refused, not cut (two cut alike would merge into one).
    assert.throws(() => db.addTags(['a'], ['Reimbursable expenses for client project Alpha']), /at most 40 characters/)
    assert.throws(() => runAssistantTool('add_tags', { transaction_ids: ['a'], tags: ['x'.repeat(41)] }), /at most 40 characters/)
    assert.equal(db.addTags(['a'], ['😀'.repeat(db.TAG_MAX)]), 1)
    assert.ok(db.getTransaction('a')!.tags.includes('😀'.repeat(db.TAG_MAX)))
    db.removeTags(['a'], ['😀'.repeat(db.TAG_MAX)])
  })

  test('the tag filter finds them, and removing takes them off', () => {
    assert.deepEqual(db.listTransactions({ tag: 'VACATION' }).rows.map((r) => r.id).sort(), ['a', 'b', 'c'])
    assert.equal(db.listTransactions({ tag: 'reimbursable' }).sumCents, -2000)
    assert.equal(db.listTransactions({ tag: 'nothing' }).total, 0)
    const found = runAssistantTool('search_transactions', { tag: 'Reimbursable' }).result as Array<{ id: string; tags: string[] }>
    assert.deepEqual(found.map((r) => [r.id, r.tags]).sort(), [['a', ['Vacation', 'reimbursable']], ['b', ['Vacation', 'reimbursable']]])
    assert.equal(db.removeTags(['a', 'b'], ['Reimbursable']), 2)
    assert.deepEqual(db.listTags(), [{ tag: 'Vacation', count: 3 }])
    // A transaction that goes takes its tags with it.
    db.deleteTransaction('c')
    assert.deepEqual(db.listTags(), [{ tag: 'Vacation', count: 2 }])
  })
})

describe('sample data', () => {
  before(() => db.openDb(join(dir, 'demo.db')))
  after(db.closeDb)

  test('a warehouse run split three ways, and a few tagged transactions, removed with the rest', () => {
    loadDemoData()
    const ids = db.all<{ id: string }>('SELECT DISTINCT transaction_id AS id FROM transaction_splits').map((r) => r.id)
    assert.equal(ids.length, 1)
    const t = db.getTransaction(ids[0])!
    const name = (id: number | null): string | undefined => db.listCategories().find((c) => c.id === id)?.name
    assert.equal(t.merchant, 'Costmart Wholesale')
    assert.deepEqual(t.splits.map((s) => [name(s.categoryId), s.note, s.oneTime]), [['Groceries', null, false], ['Shopping', 'Household', false], ['Shopping', 'Patio heater', true]])
    assert.equal(t.splits.reduce((s, p) => s + p.amountCents, 0), t.amountCents)
    assert.deepEqual(db.listTags(), [{ tag: 'vacation', count: 4 }, { tag: 'reimbursable', count: 1 }])
    clearDemoData()
    assert.equal(db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM transaction_splits) + (SELECT COUNT(*) FROM transaction_tags) AS n')!.n, 0)
  })
})
