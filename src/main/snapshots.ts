import { createHash } from 'node:crypto'
import * as db from './db'
import { ledgerState } from './ledgerState'
import { boundaryParts, ENGINE_VERSION, firstLedgerDay, isFundPart, ledgerLines, perimeter, seriesByKey, withPersonalLine } from './lines'
import { yearCheck } from './paystubs'
import { claimsThrough, positionBook, shareOn } from './ventureMoney'
import { closedFigures, closingStatus, monthClose, type KeptFigures } from './waterfall'
import { LEG_DAYS } from './windows'
import { addDays, daysInMonth, shiftMonth } from '../shared/zone'
import type { Account, AssetType, ChangeCause, ChangedMonth, CheckItem, ClassifiedLine, ClosedFigures, CloseOrigin, LeakItem, LineClass, MonthSnapshot, NetWorthBridge, RecurringSeries, SnapshotDiff, Waterfall } from '../shared/types'
import { errorTag } from '../shared/errorTag'

// Closing a month (spec 2, sub-phase 1h): once a month has ended and its banks have caught up, what Personal's books
// say about it is frozen, so its figures can't drift later without anyone seeing it. A close keeps every row and
// part (actual, run rate, rate, its change in points and where the pay came from), the month's ledger line by line,
// each perimeter account's balances, the cash identity, the net worth bridge, the leak and check items, and five
// sha-256 digests: of the lines, of the source rows and the dated inputs behind them, of the balances, of the rows,
// and of the undated inputs every month reads (the inputs stamp). Sub-phase 1i recomputes closed months and compares
// them with these; nothing here changes a close once it is written. Every version of a month is kept.
//
// When: a month is due from the 3rd of the next month (close.earliestDay) in the ledger's zone, once every perimeter
// account a bank feeds has a balance dated after the month's end and nothing in the month is still pending. On the
// 15th (close.forceDay) it closes anyway, and each account it waited for is a late_sync item. Any perimeter account
// with no balance after the month's end is a month_end_unbracketed item. A month closes with status gap when
// Unexplained is above the tolerance or either identity doesn't tie, else closed. The current month never closes;
// Review's close_month can close a past month sooner, or again. The first time the books are closed, every past
// month that is due is (origin backfill, version 1); so is a month closed only after the month it fell due in (history
// imported since, or a month missed while the app wasn't open). A month closed as it falls due is origin auto.
//
// Closing a month costs about what Home's waterfall for it costs (a third of a second of CPU on a ledger of 16,000
// transactions), so closing many runs one month at a time and gives the event loop back between them: the desktop's
// main process answers the window meanwhile. Each month is written in one transaction, so a run cut short resumes
// with the first month it didn't close, and never closes one twice. A hosted ledger closes a few months per event.

/** The scope closes are kept for: Personal's. Venture months are not frozen. */
const SCOPE = 'personal'
/** Accounts a bank feed keeps up to date: a month waits for each to report a balance after it ends. */
const FEEDS = new Set(['plaid', 'simplefin'])
const CASH_AND_CARDS = new Set<AssetType>(['cash', 'credit_card'])
/** close.earliestDay and close.forceDay when they aren't set (spec 7, Decision 6). */
const EARLIEST_DAY = 3
const FORCE_DAY = 15
/** The last month the books' first close (the backfill) took in: a setting no month's figures read. */
const BACKFILL_TO = 'snapshots.backfillTo'

const isMonth = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))).padStart(2, '0')}`
const dayOf = (month: string, day: number): string => `${month}-${String(day).padStart(2, '0')}`
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The days of the next month a month closes from and closes by regardless: close.earliestDay and close.forceDay, whole days from 1 to 28. */
function closeDays(): { earliest: number; force: number } {
  const read = (key: string, fallback: number): number => {
    try {
      const v = JSON.parse(db.getSetting(key) ?? 'null') as unknown
      return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 28 ? v : fallback
    } catch {
      return fallback
    }
  }
  const earliest = read('close.earliestDay', EARLIEST_DAY)
  return { earliest, force: Math.max(earliest, read('close.forceDay', FORCE_DAY)) }
}

/**
 * The next day after `today` (YYYY-MM-DD, the ledger's today by default) a month can fall due on: this month's or
 * the next one's close.earliestDay or close.forceDay. A hosted ledger with no bank to sync daily wakes then.
 */
export function nextCloseDay(today = db.today()): string {
  const days = closeDays()
  const month = today.slice(0, 7)
  return [month, shiftMonth(month, 1)].flatMap((m) => [dayOf(m, days.earliest), dayOf(m, days.force)]).filter((d) => d > today).sort()[0]
}

// ---------- digests ----------

/** The lines digest: sha-256 over each line's key|class|cents, sorted, one to a line of text. */
export function linesDigest(lines: ReadonlyArray<Pick<ClassifiedLine, 'key' | 'cls' | 'cents'>>): string {
  return sha256(lines.map((l) => `${l.key}|${l.cls}|${l.cents}`).sort().join('\n'))
}

/** The engine version whose closes freeze each venture's position (NetWorthBridge.ventures) in the rows digest. */
const POSITIONS_FROM = 3

/**
 * The rows digest: sha-256 over every row's actual, run rate, rate and pay basis, every part's actual, run rate and
 * rate, the cash identity's terms and the bridge's terms and Other items, sorted. A row or part whose figures moved,
 * though not one of the month's lines did (a paystub, an election, a balance, a rate), moves it. Δ 3 mo and Δ pts are
 * frozen beside them but not read here, so a month whose changes over 3 months moved alone stays as it closed; a row
 * or part there only for its change over 3 months (a Payroll difference the month 3 before holds) is read for being
 * there, so it moves the digest when it comes or goes, and its Δ 3 mo shows what moved (closedFigures, waterfall.ts).
 * From engine version 3 (sub-phase 1j) it reads each venture's position at the bridge's start and end too, those
 * not 0 at both (so a new venture with nothing in it leaves a month as it closed); a month closed under an earlier
 * version, which froze no positions, is digested as that version did (`version`).
 */
export function rowsDigest(w: Pick<Waterfall, 'rows' | 'identity' | 'bridge'>, version = ENGINE_VERSION): string {
  const out = rowLines(w.rows)
  for (const [k, x] of Object.entries(w.identity)) out.push(`identity|${k}|${x}`)
  // The bridge's figures; a list added to it later (1j's ventures) is read under the engine version that adds it.
  for (const [k, x] of Object.entries(w.bridge)) if (typeof x === 'number') out.push(`bridge|${k}|${x}`)
  for (const o of w.bridge.other) out.push(`other|${o.kind}|${o.accountId}|${o.cents}`)
  if (version >= POSITIONS_FROM) out.push(...positionLines(w.bridge.ventures))
  return sha256(out.sort().join('\n'))
}

/** What the rows digest reads of the rows: every row's actual, run rate, rate and pay basis, and every part's actual, run rate and rate. */
function rowLines(rows: ReadonlyArray<Pick<db.ClosedRow, 'id' | 'actualCents' | 'runRateCents' | 'rate' | 'basis'> & { parts: ReadonlyArray<Pick<db.ClosedRow['parts'][number], 'key' | 'actualCents' | 'runRateCents' | 'rate'>> }>): string[] {
  const v = (x: number | string | null | undefined): string => (x === null || x === undefined ? '' : String(x))
  const out: string[] = []
  for (const r of rows) {
    out.push(`row|${r.id}|${v(r.actualCents)}|${v(r.runRateCents)}|${v(r.rate)}|${v(r.basis)}`)
    for (const p of r.parts) out.push(`part|${r.id}|${p.key}|${v(p.actualCents)}|${v(p.runRateCents)}|${v(p.rate)}`)
  }
  return out
}

/** What the rows digest reads of the ventures' positions from engine version 3: each one's at the bridge's start and end, those not 0 at both. */
const positionLines = (ventures: NetWorthBridge['ventures'] | undefined): string[] => (ventures ?? []).filter((p) => p.startCents || p.endCents).map((p) => `venture|${p.bucketId}|${p.startCents}|${p.endCents}`)

/**
 * The balances digest: sha-256 over each account's id|start|end, sorted. An account that held nothing at either end
 * (one opened since, say) is left out, so linking an account later leaves a month's digest as it was.
 */
export function balancesDigest(balances: ReadonlyMap<string, { startCents: number; endCents: number }>): string {
  return sha256(
    [...balances]
      .filter(([, b]) => b.startCents !== 0 || b.endCents !== 0)
      .map(([id, b]) => `${id}|${b.startCents}|${b.endCents}`)
      .sort()
      .join('\n')
  )
}

/**
 * The raw digest of a month, in one pass over what it holds: sha-256 over its source rows (each line of a
 * transaction, a split's parts each, with what decides its owner and class: account, day, amount, category, venture
 * and how it was placed there, its own part's venture, the one-time flag, the asset it bought or is a cost of, pending,
 * payee, tags, and the intent parts stored for it as money between Personal and a venture), and the dated inputs that
 * aren't lines, on `accounts` (the ones the bridge reads): every known
 * balance, valuation and recorded flow dated in the month, and each account's known balances nearest before its
 * first day and after its last, the account's own balance among them when it is the nearest. What comes after the
 * month and still decides it is read too: every source row up to LEG_DAYS after it (the other side of money moved
 * between accounts, which makes a line In transit rather than an orphan), and on each account the rows up to its
 * nearest balance after the month (its month-end balance is walked back from that one, and its gap is split
 * across the months by days). An account opened after the month, or closed before it began, holds nothing in it,
 * so its balances and later rows aren't read. A change to any of them is a reason to classify the month again.
 */
export function rawDigest(month: string, accounts: string[]): string {
  return rawRead(month, accounts).digest
}

/**
 * The raw digest with its parts: a short digest of each kind of what it reads, by account for the dated inputs
 * (`balance:<id>`, `valuation:<id>`, `flow:<id>`, and `near:<id>` for the balances either side of the month), and
 * `lines` and `later` for the source rows in the month and after it. A change found later names its inputs by them.
 */
function rawRead(month: string, accounts: string[]): { digest: string; parts: Record<string, string> } {
  const first = `${month}-01`
  const last = lastDayOf(month)
  const out: string[] = []
  const parts = new Map<string, string[]>()
  const note = (part: string, text: string): void => {
    out.push(text)
    const list = parts.get(part)
    if (list) list.push(text)
    else parts.set(part, [text])
  }
  const ids = accounts.map(() => '?').join(',')
  // The balances either side of the month: the nearest known one before it and after it, and the account's own.
  const near = accounts.length
    ? db
        .all<{ a: string; before: string | null; after: string | null; own: number | null; at: number | null; opened: string | null; closed: string | null }>(
          `SELECT a.id AS a, (SELECT MAX(day) FROM balance_snapshots WHERE account_id = a.id AND day < ?) AS before,
                  (SELECT MIN(day) FROM balance_snapshots WHERE account_id = a.id AND day > ?) AS after, a.balance_cents AS own, a.balance_date AS at,
                  COALESCE(a.opened_day, l.opened_day) AS opened, COALESCE(a.closed_day, l.closed_day) AS closed
           FROM accounts a LEFT JOIN accounts l ON l.id = a.linked_asset_id WHERE a.id IN (${ids})`,
          first,
          last,
          ...accounts
        )
        .filter((r) => !(r.opened && r.opened > last) && !(r.closed && r.closed < first))
    : []
  // Each account's nearest balance after the month: a known one, or its own when that comes first.
  const nextOf = new Map<string, string>()
  for (const r of near) {
    const own = r.own !== null && r.at !== null ? db.dayKey(r.at) : null
    const next = [r.after, own !== null && own > last ? own : null].filter((d): d is string => d !== null).sort()[0]
    if (next) nextOf.set(r.a, next)
  }
  // The rows after the month that still decide it: every account's for LEG_DAYS, and each account's further on up to its next balance.
  const legs = addDays(last, LEG_DAYS)
  const further = [...nextOf].filter(([, day]) => day > legs)
  const within = `t.posted >= ? AND (t.posted < ?${further.map(() => ' OR (t.account_id = ? AND t.posted < ?)').join('')})`
  const bounds = [db.monthStart(month), db.dayStart(addDays(legs, 1)), ...further.flatMap(([id, day]) => [id, db.dayStart(addDays(day, 1))])]
  // Each source row's stored intent parts (sub-phase 1j), read with it: a row with none reads as it did before them.
  const intents = new Map<string, string[]>()
  for (const p of db.all<{ k: string; x: string }>(
    `SELECT m.txn_id || ':' || COALESCE(m.split_id, '') AS k, m.face || ',' || m.venture_id || ',' || m.intent || ',' || m.cents || ',' || m.interest_cents || ',' || COALESCE(m.regular, '') || ',' || m.source AS x
     FROM venture_money m JOIN transactions t ON t.id = m.txn_id WHERE ${within} ORDER BY m.face, m.intent, m.id`,
    ...bounds
  )) {
    const list = intents.get(p.k)
    if (list) list.push(p.x)
    else intents.set(p.k, [p.x])
  }
  for (const r of db.all<Record<string, string | number | null>>(
    `SELECT t.id, t.split_id, date(${db.localSql('t.posted')}) AS day, t.amount_cents, t.category_id, t.bucket_id, t.bucket_source,
            COALESCE(s.own_bucket, 0) AS own_bucket, t.one_time, t.account_id, t.capital_asset_id, t.asset_id, t.asset_source, t.pending,
            t.merchant, t.desc_key, (SELECT group_concat(g.tag, ',') FROM (SELECT tag FROM transaction_tags WHERE transaction_id = t.id ORDER BY tag) g) AS tags
     FROM ${db.TXN_LINES} t LEFT JOIN transaction_splits s ON s.id = t.split_id
     WHERE ${within}`,
    ...bounds
  )) {
    const later = String(r.day) > last
    const parts = intents.get(`${String(r.id)}:${r.split_id ?? ''}`)
    note(later ? 'later' : 'lines', `${later ? 'later' : 'line'}|${JSON.stringify(parts ? [...Object.values(r), parts.join(';')] : Object.values(r))}`)
  }
  if (accounts.length) {
    for (const r of db.all<{ a: string; d: string; c: number; s: string }>(`SELECT account_id AS a, day AS d, balance_cents AS c, source AS s FROM balance_snapshots WHERE account_id IN (${ids}) AND day >= ? AND day <= ?`, ...accounts, first, last)) note(`balance:${r.a}`, `balance|${r.a}|${r.d}|${r.c}|${r.s}`)
    for (const r of db.all<{ a: string; d: string; c: number; lo: number | null; hi: number | null; b: string }>(`SELECT account_id AS a, day AS d, value_cents AS c, low_cents AS lo, high_cents AS hi, basis AS b FROM valuations WHERE account_id IN (${ids}) AND day >= ? AND day <= ?`, ...accounts, first, last)) {
      note(`valuation:${r.a}`, `valuation|${r.a}|${r.d}|${r.c}|${r.lo ?? ''}|${r.hi ?? ''}|${r.b}`)
    }
    for (const r of db.all<{ a: string; d: string; c: number }>(`SELECT account_id AS a, day AS d, cents AS c FROM recorded_flows WHERE account_id IN (${ids}) AND day >= ? AND day <= ?`, ...accounts, first, last)) note(`flow:${r.a}`, `flow|${r.a}|${r.d}|${r.c}`)
    const point = (id: string, day: string): string => {
      const p = db.get<{ c: number; s: string }>('SELECT balance_cents AS c, source AS s FROM balance_snapshots WHERE account_id = ? AND day = ?', id, day)
      return p ? `${p.c}|${p.s}` : ''
    }
    for (const r of near) {
      const own = r.own !== null && r.at !== null ? db.dayKey(r.at) : null
      if (r.before) note(`near:${r.a}`, `before|${r.a}|${r.before}|${point(r.a, r.before)}`)
      if (r.after) note(`near:${r.a}`, `after|${r.a}|${r.after}|${point(r.a, r.after)}`)
      // The account's own balance moves with every sync, so it counts only when it is the nearest after the month.
      if (own !== null && own > last && (!r.after || own < r.after)) note(`near:${r.a}`, `own|${r.a}|${own}|${r.own}`)
    }
  }
  return { digest: sha256(out.sort().join('\n')), parts: Object.fromEntries([...parts].map(([k, list]) => [k, short(list.sort().join('\n'))])) }
}

/** A part's digest, short: it only tells one part from another. */
const short = (text: string): string => sha256(text).slice(0, 16)

/**
 * The inputs stamp: sha-256 over what every month reads that isn't dated in one: the categories, rules and venture
 * and asset rules, the recurring series' overrides, each account's name (a plan finds its account by it), source,
 * type, venture, hidden flag, tax treatment, cash role, payment key, rates, escrow, linked asset, dates, cost and sale
 * costs, the day its flows are known from (its Growth starts there), the contribution plans (elections, match,
 * dates), the paystubs, the tax years (they mark a balance due), the trips, the insurance policies, the assets' uses,
 * the residence dates, each venture's kind, value source and Stakes account, its dated shares and its remembered
 * answers for boundary lines, the waterfall's and the close's settings, the ledger's zone and ENGINE_VERSION. Not the
 * retirement settings or the focus threshold: a close keeps no retirement line and no focus, so they move nothing it
 * keeps.
 */
export function inputsStamp(): string {
  return stampRead().stamp
}

/**
 * The inputs stamp with its parts: a short digest of each row it reads, keyed by its section and the row's first
 * column (`accounts:<id>`, `paystubs:<id>`, `settings:<key>`), and `engine`. A change found later names the inputs
 * that moved by them.
 */
function stampRead(): { stamp: string; parts: Record<string, string> } {
  // Read once per data stamp: a check reads it for every month it recomputes.
  const data = db.dataStamp()
  const owner = db.currentConnection()
  const kept = owner ? stamps.get(owner) : undefined
  if (data !== null && kept?.data === data) return kept.read
  const read = readStamp()
  if (data !== null && owner) stamps.set(owner, { data, read })
  return read
}

/** Each ledger's inputs stamp, kept until its data stamp moves. */
const stamps = new WeakMap<object, { data: string; read: { stamp: string; parts: Record<string, string> } }>()

/** The account fields the inputs stamp reads, in its order after the id. */
const ACCOUNT_FIELDS = ['name', 'source', 'assetType', 'bucketId', 'hidden', 'taxTreatment', 'cashRole', 'paymentKey', 'apr', 'promoApr', 'promoEnds', 'escrowCents', 'linkedAssetId', 'openedDay', 'closedDay', 'costCents', 'saleCostsCents'] as const

function readStamp(): { stamp: string; parts: Record<string, string> } {
  const sections: Array<[string, string]> = [
    ['categories', 'SELECT id, name, kind FROM categories ORDER BY id'],
    ['rules', 'SELECT id, field, pattern, category_id FROM rules ORDER BY id'],
    ['bucket_rules', 'SELECT id, bucket_id, asset_id, account_id, category_id, contains, amount_cents, from_day, to_day, auto FROM bucket_rules ORDER BY id'],
    ['recurring_overrides', 'SELECT key, status, kind, name FROM recurring_overrides ORDER BY key'],
    ['contributions', 'SELECT id, name, kind, account_id, paycheck_key, percent, employee_cents, match_cents, match_rate_bp, match_cap_bp, next_percent, next_employee_cents, next_from, starts_day, ends_day FROM contributions ORDER BY id'],
    ['paystubs', 'SELECT id, paycheck_key, pay_day, period_from, period_to, kind, gross_cents, net_cents, estimated FROM paystubs ORDER BY id'],
    ['paystub_items', 'SELECT paystub_id, position, kind, name, cents, ytd_cents, pretax, employer_cents FROM paystub_items ORDER BY paystub_id, position'],
    ['asset_uses', 'SELECT id, asset_id, from_day, to_day, bucket_id, share_bp, basis FROM asset_uses ORDER BY id'],
    ['buckets', 'SELECT id, residence_from, residence_to, residence_converted, kind, value_source, stake_account_id FROM buckets ORDER BY id'],
    // Each venture's share, by day, and the remembered answers for its boundary lines (sub-phase 1j): every month's
    // net worth reads its positions.
    ['venture_shares', "SELECT bucket_id || ':' || from_day, share_bp, source FROM venture_shares ORDER BY bucket_id, from_day"],
    ['venture_money_rules', 'SELECT id, venture_id, shape, direction, payee_key, intent, regular FROM venture_money_rules ORDER BY id'],
    ['flows_known_from', 'SELECT account_id, day FROM flows_known_from ORDER BY account_id'],
    [
      'settings',
      "SELECT key, value FROM settings WHERE key IN ('taxes', 'budget.trips', 'insurance', 'calendar.timeZone') OR key LIKE 'waterfall.%' OR key LIKE 'close.%' ORDER BY key"
    ]
  ]
  const rows = new Map<string, unknown[]>()
  const out = sections.map(([name, sql]) => {
    const list = db.all<Record<string, unknown>>(sql).map((r) => Object.values(r))
    for (const r of list) {
      const key = `${name}:${String(r[0])}`
      rows.set(key, [...(rows.get(key) ?? []), r])
    }
    return `${name}|${JSON.stringify(list)}`
  })
  // Accounts as the engine reads them: a type or role left to the app is the one it gives them.
  const accounts = db.listAccounts().map((a) => [a.id, a.name, a.source, a.assetType, a.bucketId, a.hidden, db.taxTreatment(a), a.cashRole, a.paymentKey, a.apr, a.promoApr, a.promoEnds, a.escrowCents, a.linkedAssetId, a.openedDay, a.closedDay, a.costCents, a.saleCostsCents])
  out.push(`accounts|${JSON.stringify(accounts)}`, `engine|${ENGINE_VERSION}`)
  const parts: Record<string, string> = { engine: String(ENGINE_VERSION) }
  for (const [key, list] of rows) parts[key] = short(JSON.stringify(list))
  // An account's part is each field's, so a change is put down to what wrote that field.
  for (const a of accounts) ACCOUNT_FIELDS.forEach((f, i) => (parts[`accounts:${String(a[0])}:${f}`] = short(JSON.stringify(a[i + 1]))))
  return { stamp: sha256(out.join('\n')), parts }
}

// ---------- what other months decide of a month ----------

// The classifier reads more of the books than a month's own rows and the six months before it: whether a payee is a
// series (committed, not everyday) reads every payment it has, later ones too; a purchase's capital window takes
// the lines nearest the day an asset opened, up to PURCHASE_DAYS later; a loan payment's split reads the balances
// and payments either side of it; a deposit is pay once its payee is paid into a paycheck category anywhere; a
// transfer's other leg is found over every day. So every closed month is classified at once, by one classification
// of the books kept per data stamp (lines.ts), and each month's lines are compared with its close's: what
// snapshot_lines keeps of each line. A Committed run rate reads, too, each series it sums at its cadence and whether
// its amount varies, which every payment of the series decides: those are the month's series digest.

/** A line as the change check compares it with its close: what snapshot_lines keeps of it that the rows read. */
const lineFacts = (l: { key: string; cls: string; cents: number; owner: number | null; seriesKey: string | null; paycheckKey: string | null; assetId: string | null }): string =>
  `${l.key}|${l.cls}|${l.cents}|${l.owner ?? ''}|${l.seriesKey ?? ''}|${l.paycheckKey ?? ''}|${l.assetId ?? ''}`

/** Months of series payments a Committed run rate reads back from its month: its 400 days, whole. */
const SERIES_MONTHS = 13

/** The series digest of a month: each series its own and the 13 months before it pay, with what its run rate reads of it. */
function seriesDigest(keys: Iterable<string>, series: Map<string, RecurringSeries>): string {
  return sha256(
    [...new Set(keys)]
      .sort()
      .map((k) => {
        const s = series.get(k)
        return s ? `${k}|${s.kind}|${s.cadence}|${s.variable ? 1 : 0}|${s.confirmed ? 1 : 0}` : `${k}|`
      })
      .join('\n')
  )
}

/** The days one classification of the closed months from one to another reads: from 13 months before the first, through the last. */
const surveySpan = (fromMonth: string, toMonth: string): [string, string] => [`${shiftMonth(fromMonth, -SERIES_MONTHS)}-01`, lastDayOf(toMonth)]

/** A month as one classification of the books reads it (survey). */
interface Look {
  /** the digest of its lines' facts */
  lines: string
  /** its series digest */
  series: string
  /** it holds a part a line in the days after it can still give an intent, or take one from (looseAhead) */
  loose: boolean
}

/**
 * Every month from one to another (YYYY-MM) as one classification reads it: the digest of its lines' facts, its
 * series digest, and whether it holds a part a later line can still give an intent. `lines` are that
 * classification's, over surveySpan's days, and `series` the series they pay, read with them.
 */
function survey(fromMonth: string, toMonth: string, lines: Iterable<ClassifiedLine>, series: Map<string, RecurringSeries>): Map<string, Look> {
  const out = new Map<string, Look>()
  if (toMonth < fromMonth) return out
  const facts = new Map<string, string[]>()
  const keys = new Map<string, Set<string>>()
  const loose = new Set<string>()
  for (const l of lines) {
    const m = l.day.slice(0, 7)
    if (m >= fromMonth) {
      const list = facts.get(m)
      if (list) list.push(lineFacts(l))
      else facts.set(m, [lineFacts(l)])
      if (looseAhead(l)) loose.add(m)
    }
    if (l.seriesKey) {
      const set = keys.get(m)
      if (set) set.add(l.seriesKey)
      else keys.set(m, new Set([l.seriesKey]))
    }
  }
  for (let m = fromMonth; m <= toMonth; m = shiftMonth(m, 1)) {
    const read: string[] = []
    for (let k = SERIES_MONTHS; k >= 0; k--) read.push(...(keys.get(shiftMonth(m, -k)) ?? []))
    out.set(m, { lines: sha256((facts.get(m) ?? []).sort().join('\n')), series: seriesDigest(read, series), loose: loose.has(m) })
  }
  return out
}

// ---------- what later days and earlier claims decide of a month (sub-phase 1j) ----------

// Money between Personal and a venture reaches a closed month from outside it in two ways. Matching a venture's cost
// paid from Personal's cash, or a Personal cost its card paid, to a payback in the other direction reads the 30 days
// after the cost (inference I5 of the venture-money addendum), so a line arriving next month can make this month's
// cost a reimbursement, and one removed can take that away: a closed month holding such a part is classified again
// whenever a month holding any of the 30 days after its last day changes (the month after; for January, March too).
// And what a venture owes Personal or is owed (its claims: lent, borrowed, due) is a running sum over every intent
// part before a day, which a position reads at every later month's start and end: below 100% by the books, or by an
// estimate, a claim set on a line years back moves the net worth of every month since, past the eleven months whose
// run rates read it. So each closed month keeps the claims its positions read, and is recomputed when they move.

/** The days after a month's last day a line can still decide its parts' intents in: I5's 30 (REIMBURSE_DAYS). */
const AHEAD_DAYS = 30

/** The months holding any of the AHEAD_DAYS days after a month's last day: the month after, and for January March too (Mar 2, or Mar 1 in a leap year). */
export function monthsAhead(month: string): string[] {
  const out: string[] = []
  const end = addDays(lastDayOf(month), AHEAD_DAYS).slice(0, 7)
  for (let m = shiftMonth(month, 1); m <= end; m = shiftMonth(m, 1)) out.push(m)
  return out
}

/**
 * A part a line in the days after its month can still give an intent, or take one from: a venture's cost or revenue on
 * Personal's cash or cards (a C part), or a Personal cost a venture's cash or card paid (an F line, or its funding),
 * with no intent yet or with one an inference gave it. A transfer with a venture (T) is matched only to earlier parts.
 */
const looseAhead = (l: Pick<ClassifiedLine, 'ventureId' | 'intent' | 'intentSource' | 'owner' | 'perimeter'>): boolean =>
  l.ventureId !== null && (l.intent === null || l.intentSource === 'inferred') && (l.owner !== null || !l.perimeter)

/** A month's months ahead as one digest: each one's source rows (the raw digest's `lines` part), by `rowsOf`. */
const aheadOf = (month: string, rowsOf: (month: string) => string): string => short(monthsAhead(month).map((m) => `${m}|${rowsOf(m)}`).join('\n'))

/** A month's own source rows, as its raw digest's `lines` part reads them: '' for a month with none. */
const rowsIn = (month: string): string => rawRead(month, []).parts.lines ?? ''

/**
 * What each of some months' positions read of the ventures' claims (lent, borrowed and due) at its start (the day
 * before its first) and its end, by venture id: a short digest for each venture whose claims move its position on
 * either day and aren't all 0 there. A position by the books at 100% is the venture's accounts whatever they're owed,
 * so it reads no claim; below 100%, at 0%, by an estimate, or by the books with no account held, it does.
 */
function claimsRead(months: readonly string[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>(months.map((m) => [m, {}]))
  if (!months.length) return out
  const book = positionBook(lastDayOf([...months].sort().at(-1)!))
  for (const v of book.ventures) {
    const counts = (day: string): boolean => !(v.valueSource === 'books' && v.accounts.length > 0 && shareOn(v.shares, day) === 10000)
    const parts = book.parts.get(v.id) ?? []
    if (!parts.length) continue
    for (const m of months) {
      const read: string[] = []
      for (const day of [addDays(`${m}-01`, -1), lastDayOf(m)]) {
        if (!counts(day)) continue
        const c = claimsThrough(parts, day)
        if (c.lentCents || c.borrowedCents || c.dueCents) read.push(`${day}|${c.lentCents}|${c.borrowedCents}|${c.dueCents}`)
      }
      if (read.length) out.get(m)![String(v.id)] = short(read.join('\n'))
    }
  }
  return out
}

/** The ventures whose claims a month's positions read differ between two reads of them; a read kept from before claims were is none. */
function claimsMoved(was: Record<string, string> | undefined, now: Record<string, string>): string[] {
  const a = was ?? {}
  return [...new Set([...Object.keys(a), ...Object.keys(now)])].filter((v) => a[v] !== now[v]).sort((x, y) => Number(x) - Number(y))
}

/** A close's lines' facts digest, from snapshot_lines: what survey gives for the month when nothing has moved. */
function closedLinesDigest(month: string, version: number): string {
  const rows = db.all<{ key: string; cls: string; cents: number; owner: number | null; seriesKey: string | null; paycheckKey: string | null; assetId: string | null }>(
    'SELECT line_key AS key, class AS cls, cents, owner, series_key AS seriesKey, paycheck_key AS paycheckKey, asset_id AS assetId FROM snapshot_lines WHERE scope = ? AND month = ? AND version = ?',
    SCOPE,
    month,
    version
  )
  return sha256(rows.map(lineFacts).sort().join('\n'))
}

// ---------- when a month is due ----------

/** What a month waits for, read once for every account: each one's newest known balance, and the ledger's accounts. */
interface Waits {
  accounts: Account[]
  /** each account's newest known balance's day (a known balance, or its own balance's day), null with none */
  newest: Map<string, string | null>
}

function waits(): Waits {
  const accounts = db.listAccounts()
  const newest = new Map<string, string | null>()
  for (const r of db.all<{ id: string; own: number | null; at: number | null; latest: string | null }>(
    'SELECT a.id, a.balance_cents AS own, a.balance_date AS at, (SELECT MAX(day) FROM balance_snapshots WHERE account_id = a.id) AS latest FROM accounts a'
  )) {
    const own = r.own !== null && r.at !== null ? db.dayKey(r.at) : null
    newest.set(r.id, [r.latest, own].filter((d): d is string => d !== null).sort().at(-1) ?? null)
  }
  return { accounts, newest }
}

/** Whether a month may close on `today`, and the items what it waited for gives it. */
interface Readiness {
  /** its earliest day has come and nothing holds it back, or its force day has come */
  due: boolean
  /** a perimeter account with no balance dated after the month's end: one month_end_unbracketed each, with the newest balance's day */
  unbracketed: Array<{ accountId: string; newest: string | null }>
  /** what the month waited for: each feed-backed perimeter account with no balance after it, and each account with lines in it still pending */
  late: Array<{ accountId: string; pending: Array<{ id: string; cents: number }> }>
}

function readiness(month: string, today: string, w: Waits, days = closeDays()): Readiness {
  const next = shiftMonth(month, 1)
  const last = lastDayOf(month)
  const byId = new Map(w.accounts.map((a) => [a.id, a]))
  const per = perimeter(month, w.accounts)
  // An account closed by the month's end holds nothing from its closing: its month-end balance is known without one after.
  const unbracketed = per
    .filter((id) => !((byId.get(id)?.closedDay ?? '9999-12-31') <= last) && !((w.newest.get(id) ?? '') > last))
    .map((accountId) => ({ accountId, newest: w.newest.get(accountId) ?? null }))
  const late = new Map<string, Readiness['late'][number]>()
  for (const u of unbracketed) if (FEEDS.has(byId.get(u.accountId)?.source ?? '')) late.set(u.accountId, { accountId: u.accountId, pending: [] })
  // Lines still pending in the ledger: any on the perimeter, and on a venture's cash and cards, the ones Personal's.
  const held = new Set(w.accounts.filter((a) => !a.hidden && a.bucketId !== null && CASH_AND_CARDS.has(a.assetType)).map((a) => a.id))
  const ledger = [...per, ...held]
  if (ledger.length) {
    const pending = db.all<{ id: string; accountId: string; cents: number }>(
      `SELECT id, account_id AS accountId, amount_cents AS cents FROM transactions WHERE pending = 1 AND posted >= ? AND posted < ? AND account_id IN (${ledger.map(() => '?').join(',')}) ORDER BY posted, id`,
      db.monthStart(month),
      db.monthStart(next),
      ...ledger
    )
    const onHeld = pending.filter((r) => held.has(r.accountId)).map((r) => r.id)
    const personal = onHeld.length ? withPersonalLine(onHeld, 't.pending = 1', [], `${month}-01`, last) : new Set<string>()
    for (const r of pending) {
      // A venture's own charge on its card is no line of the ledger, so the month doesn't wait for it.
      if (held.has(r.accountId) && !personal.has(r.id)) continue
      let x = late.get(r.accountId)
      if (!x) late.set(r.accountId, (x = { accountId: r.accountId, pending: [] }))
      x.pending.push({ id: r.id, cents: r.cents })
    }
  }
  const earliest = today >= dayOf(next, days.earliest)
  const forced = today >= dayOf(next, days.force)
  return { due: earliest && (forced || late.size === 0), unbracketed, late: [...late.values()] }
}

// ---------- closing ----------

/** A close as it's stored, read back. */
interface SnapshotRow {
  month: string
  version: number
  origin: CloseOrigin
  closed_at: number
  engine_version: number
  status: MonthSnapshot['status']
  checks: string
  identity: string
  line_digest: string
  line_count: number
  line_sum: number
  raw_digest: string
  balance_digest: string
  rows_digest: string
  inputs_stamp: string
}

const SNAPSHOT_COLUMNS = 'month, version, origin, closed_at, engine_version, status, checks, identity, line_digest, line_count, line_sum, raw_digest, balance_digest, rows_digest, inputs_stamp'

function snapshotOf(r: SnapshotRow): MonthSnapshot {
  const checks = JSON.parse(r.checks) as { leaks: LeakItem[]; checks: CheckItem[] }
  const identity = JSON.parse(r.identity) as { unexplainedCents: number; toleranceCents: number }
  return {
    month: r.month,
    version: r.version,
    origin: r.origin,
    closedAt: r.closed_at,
    engineVersion: r.engine_version,
    status: r.status,
    lineCount: r.line_count,
    lineSumCents: r.line_sum,
    unexplainedCents: identity.unexplainedCents,
    toleranceCents: identity.toleranceCents,
    leaks: checks.leaks,
    checks: checks.checks,
    digests: { lines: r.line_digest, raw: r.raw_digest, balances: r.balance_digest, rows: r.rows_digest, inputs: r.inputs_stamp }
  }
}

/** Where a perimeter account's month-end balance came from: a known balance that day (by its source) or the account's own, its closing (nothing from then), walked back from a later one, or carried on from an earlier one with none after. */
function balanceSource(id: string, last: string, newest: string | null, own: string | null, closedDay: string | null): string {
  const p = db.get<{ s: string }>('SELECT source AS s FROM balance_snapshots WHERE account_id = ? AND day = ?', id, last)
  if (p) return p.s
  if (own === last) return 'account'
  if (closedDay !== null && closedDay <= last) return 'closed'
  return newest !== null && newest > last ? 'walked' : 'unbracketed'
}

/**
 * Closes a month that has ended, as its next version (spec 2): its rows, lines, balances, identities, items and
 * digests, read and written in one transaction. `origin` says who closed it. With `once`, a month that has a close already
 * is left as it is and null comes back: a run on a schedule never closes a month twice. Throws for a month that
 * hasn't ended by `now` (unix seconds), or one before the books' first line.
 */
export function closeMonth(month: string, origin: CloseOrigin, now = db.now(), o: { once?: boolean } = {}): MonthSnapshot | null {
  if (!isMonth(String(month))) throw new Error('A month is like 2026-10')
  const today = db.dayKey(now)
  if (month >= today.slice(0, 7)) throw new Error(`${month} hasn't ended: only a month that has can be closed`)
  const first = firstLedgerDay()
  if (!first || month < first.slice(0, 7)) throw new Error(first ? `Personal's books start in ${first.slice(0, 7)}` : 'Personal has no lines to close yet')
  if (o.once && closedVersion(month) > 0) return null

  // Everything a close holds is read as of one moment, in the transaction that writes it: a write another process
  // (Review's tool server) commits meanwhile fails the close (SQLITE_BUSY_SNAPSHOT), and the month closes on the next
  // run, rather than freezing figures and digests that disagree.
  return db.inTransaction(() => {
    const w = waits()
    const ready = readiness(month, today, w)
    const close = monthClose(month)
    const wf = close.waterfall
    const last = lastDayOf(month)
    const byId = new Map(w.accounts.map((a) => [a.id, a]))

    // The items what the month waited for gives it, beside Unexplained's and the identities'.
    const leaks: LeakItem[] = [...wf.leaks]
    for (const u of ready.unbracketed) leaks.push({ kind: 'month_end_unbracketed', cents: close.balances.get(u.accountId)?.endCents ?? 0, accountId: u.accountId, ...(u.newest ? { fromDay: u.newest } : {}) })
    for (const x of ready.late) leaks.push({ kind: 'late_sync', cents: x.pending.reduce((s, p) => s + p.cents, 0), accountId: x.accountId, ...(x.pending.length ? { txnIds: x.pending.map((p) => p.id) } : {}) })

    // The check items: the month's paychecks against their stubs, and on the December close the year's stubs against
    // its return (spec 2, identity 5).
    const checks: CheckItem[] = [...wf.checks, ...(month.endsWith('-12') ? yearCheck(Number(month.slice(0, 4))).checks : [])]

    const lines = close.lines
    const status = closingStatus(wf)
    const rows = wf.rows.map((r) => ({
      id: r.id,
      actualCents: r.actualCents,
      runRateCents: r.runRateCents,
      changeCents: r.changeCents,
      rate: r.rate,
      rateFrom: r.rateFrom,
      rateChangePts: r.rateChangePts,
      basis: r.basis,
      parts: r.parts.map((p) => ({ key: p.key, name: p.name, actualCents: p.actualCents, runRateCents: p.runRateCents, changeCents: p.changeCents, rate: p.rate }))
    }))
    const raw = rawRead(month, [...close.balances.keys()])
    const stamp = stampRead()
    const record = {
      line_digest: linesDigest(lines),
      line_count: lines.length,
      line_sum: lines.reduce((s, l) => s + l.cents, 0),
      raw_digest: raw.digest,
      balance_digest: balancesDigest(close.balances),
      rows_digest: rowsDigest(wf),
      inputs_stamp: stamp.stamp
    }
    // What a later check names a change by: the series the run rates read, and the raw digest's and the stamp's parts.
    const series = seriesDigest(
      ledgerLines(`${shiftMonth(month, -SERIES_MONTHS)}-01`, last).flatMap((l) => (l.seriesKey ? [l.seriesKey] : [])),
      seriesByKey()
    )
    // And what reaches it from outside: the source rows of the months ahead of it, and the claims its positions read.
    const ahead = aheadOf(month, rowsIn)
    const claims = claimsRead([month]).get(month) ?? {}
    const gapOf = new Map<string, number>()
    for (const g of close.gaps) gapOf.set(g.accountId, (gapOf.get(g.accountId) ?? 0) + g.cents)

    const closedAt = db.now()
    const version = db.writingCloses(() => {
      const v = closedVersion(month) + 1
      if (o.once && v > 1) return 0
      db.run(
        `INSERT INTO month_snapshots (scope, month, version, origin, closed_at, engine_version, status, "rows", checks, identity, bridge, line_digest, line_count, line_sum, raw_digest, balance_digest, rows_digest, inputs_stamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        SCOPE,
        month,
        v,
        origin,
        closedAt,
        ENGINE_VERSION,
        status,
        JSON.stringify({ rows, employerAdds: wf.employerAdds, unsorted: wf.unsorted, series, raw: raw.parts, ahead, claims }),
        JSON.stringify({ leaks, checks }),
        JSON.stringify({ ...wf.identity, toleranceCents: wf.toleranceCents }),
        JSON.stringify(wf.bridge),
        record.line_digest,
        record.line_count,
        record.line_sum,
        record.raw_digest,
        record.balance_digest,
        record.rows_digest,
        record.inputs_stamp
      )
      for (const l of lines) {
        db.run(
          'INSERT INTO snapshot_lines (scope, month, version, line_key, txn_id, split_id, owner, class, cents, category_id, series_key, paycheck_key, account_id, asset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          SCOPE,
          month,
          v,
          l.key,
          l.txnId,
          l.splitId,
          l.owner,
          l.cls,
          l.cents,
          l.categoryId,
          l.seriesKey,
          l.paycheckKey,
          l.accountId,
          l.assetId
        )
      }
      for (const id of close.perimeter) {
        const b = close.balances.get(id) ?? { startCents: 0, endCents: 0 }
        const a = byId.get(id)
        const own = a?.balanceCents !== null && a?.balanceDate ? db.dayKey(a.balanceDate) : null
        db.run(
          'INSERT INTO snapshot_balances (scope, month, version, account_id, start_cents, end_cents, source, gap_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          SCOPE,
          month,
          v,
          id,
          b.startCents,
          b.endCents,
          balanceSource(id, last, w.newest.get(id) ?? null, own, a?.closedDay ?? null),
          gapOf.get(id) ?? 0
        )
      }
      return v
    })
    if (!version) return null
    keepStampParts(stamp.stamp, stamp.parts)
    return snapshotOf({ month, version, origin, closed_at: closedAt, engine_version: ENGINE_VERSION, status, checks: JSON.stringify({ leaks, checks }), identity: JSON.stringify({ unexplainedCents: wf.identity.unexplainedCents, toleranceCents: wf.toleranceCents }), ...record })
  })
}

/** A month's latest version, 0 when it has never been closed. */
function closedVersion(month: string): number {
  return db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM month_snapshots WHERE scope = ? AND month = ?', SCOPE, month)?.v ?? 0
}

/** Removes one version of a month's close, its lines and balances with it: undoing the close_month that wrote it. */
export function deleteClose(month: string, version: number): void {
  db.writingCloses(() =>
    db.inTransaction(() => {
      for (const table of ['month_snapshots', 'snapshot_lines', 'snapshot_balances']) db.run(`DELETE FROM ${table} WHERE scope = ? AND month = ? AND version = ?`, SCOPE, month, version)
    })
  )
}

/**
 * Forgets every close of each month whose closes read any of these accounts (a line or a balance of one): the
 * sample data's months when it's cleared, so they close again from what's left. Returns how many months.
 */
export function forgetClosesOf(accountIds: string[]): number {
  if (!accountIds.length || !db.upToDate()) return 0
  const ids = accountIds.map(() => '?').join(',')
  const months = db.all<{ month: string }>(
    `SELECT month FROM snapshot_lines WHERE scope = ? AND account_id IN (${ids}) UNION SELECT month FROM snapshot_balances WHERE scope = ? AND account_id IN (${ids})`,
    SCOPE,
    ...accountIds,
    SCOPE,
    ...accountIds
  ).map((r) => r.month)
  if (!months.length) return 0
  db.writingCloses(() =>
    db.inTransaction(() => {
      for (const table of ['month_snapshots', 'snapshot_lines', 'snapshot_balances']) db.run(`DELETE FROM ${table} WHERE scope = ? AND month IN (${months.map(() => '?').join(',')})`, SCOPE, ...months)
      // What their checks kept goes with them.
      for (const m of months) db.setSetting(`${CHECKED}${m}`, null)
    })
  )
  return months.length
}

/** What a run of closeDueMonths did. */
export interface CloseRun {
  /** the months it closed, oldest first */
  closed: Array<{ month: string; version: number; status: MonthSnapshot['status']; origin: CloseOrigin }>
  /** months that couldn't be closed, with why; they're tried again on the next run */
  failed: Array<{ month: string; error: string }>
  /** months due that `limit` left for a later run */
  left: number
}

/** Gives the event loop back between months, so whatever waits (the window's calls, a request) is answered. */
const breather = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * One run at a time per ledger, closing months or checking them, so a check never reads a month a close is writing:
 * a run asked for while one runs follows it, once for each kind, so every check asked for meanwhile is one.
 */
const runs = ledgerState(() => ({ running: null as Promise<unknown> | null, next: new Map<'close' | 'check', Promise<unknown>>() }))

function queued<T>(kind: 'close' | 'check', start: () => Promise<T>): Promise<T> {
  const s = runs()
  if (s.running) {
    let next = s.next.get(kind) as Promise<T> | undefined
    if (!next) {
      next = s.running
        .catch(() => {})
        .then(() => {
          s.next.delete(kind)
          return queued(kind, start)
        })
      s.next.set(kind, next)
    }
    return next
  }
  const run = start().finally(() => {
    if (s.running === run) s.running = null
  })
  s.running = run
  return run
}

/**
 * Closes every month that is due by `now` (unix seconds) and has no close, oldest first, one at a time with the event
 * loop free between them, at most `limit` of them. The first close of the books is a backfill of every past month
 * due then, carried on by later runs when one is cut short; after that a month closes as auto when it falls due, and
 * as backfill when it closes only after the month it fell due in.
 */
export function closeDueMonths(now?: number, o: { limit?: number } = {}): Promise<CloseRun> {
  return queued('close', () => closing(now, o.limit, null))
}

/** Closes every past month that is due and has no close, as origin backfill (version 1): the first launch's run. */
export function backfillSnapshots(now?: number, o: { limit?: number } = {}): Promise<CloseRun> {
  return queued('close', () => closing(now, o.limit, 'backfill'))
}

async function closing(now: number | undefined, limit: number | undefined, origin: CloseOrigin | null): Promise<CloseRun> {
  const out: CloseRun = { closed: [], failed: [], left: 0 }
  if (!db.upToDate()) return out
  const at = now ?? db.now()
  const today = db.dayKey(at)
  const first = firstLedgerDay()
  if (!first) return out
  const closed = new Set(db.all<{ month: string }>('SELECT DISTINCT month FROM month_snapshots WHERE scope = ?', SCOPE).map((r) => r.month))
  const days = closeDays()
  const current = today.slice(0, 7)
  const books = db.currentConnection()
  let w = waits()
  // The books' first close is a backfill of every month due then. Its last month is kept, so a backfill cut short
  // carries on as one; a month closed after the month it fell due in (a month imported since, or missed while the
  // app wasn't open) is one too. A month Review closed sooner doesn't make the first run any less the first.
  if (!db.get('SELECT 1 AS x FROM month_snapshots WHERE scope = ? AND origin != ? LIMIT 1', SCOPE, 'review')) {
    let to: string | null = null
    for (let m = first.slice(0, 7); m < current && readiness(m, today, w, days).due; m = shiftMonth(m, 1)) to = m
    if (to) db.writingCloses(() => db.setSetting(BACKFILL_TO, to))
  }
  const backfillTo = db.getSetting(BACKFILL_TO) ?? ''
  const lastFull = shiftMonth(current, -1)
  for (let m = first.slice(0, 7); m < current; m = shiftMonth(m, 1)) {
    if (closed.has(m)) continue
    // A month not due holds the ones after it back too: theirs come later still.
    if (!readiness(m, today, w, days).due) break
    // The limit counts the months tried, so a failure that repeats on every month still costs one run only its limit.
    if (limit !== undefined && out.closed.length + out.failed.length >= limit) {
      out.left++
      continue
    }
    try {
      const s = closeMonth(m, origin ?? (m <= backfillTo || m < lastFull ? 'backfill' : 'auto'), at, { once: true })
      if (s) out.closed.push({ month: s.month, version: s.version, status: s.status, origin: s.origin })
    } catch (err) {
      out.failed.push({ month: m, error: message(err) })
    }
    await breather()
    // Books closed or replaced meanwhile (quitting, Delete all data, a restore) close their months on their next run.
    if (db.currentConnection() !== books || !books?.isOpen) break
    // What the window did meanwhile (a balance, an account) is read again for the next month.
    w = waits()
  }
  return out
}

/** A run of closeDueMonths a moment after the last bulk change (an import, the demo, a restore), so new history closes without waiting for the next tick. */
let soon: ReturnType<typeof setTimeout> | null = null
export function closeSoon(delayMs = 2000, done?: (run: CloseRun) => void): void {
  if (soon) clearTimeout(soon)
  soon = setTimeout(() => {
    soon = null
    // The books may have closed meanwhile (quitting, Delete all data).
    if (!db.currentConnection()?.isOpen) return
    closeDueMonths().then(
      (run) => done?.(run),
      (err) => console.error(`[close] failed${errorTag(err)}`)
    )
  }, delayMs)
  // A pending run never keeps the process alive.
  ;(soon as { unref?: () => void }).unref?.()
}

// ---------- reading closes ----------

/** The months' closes, the newest month first and each month's newest version first, at most `limit` (100 by default, up to 1,000). */
export function listSnapshots(limit = 100): MonthSnapshot[] {
  if (!db.upToDate()) return []
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100
  return db.all<SnapshotRow>(`SELECT ${SNAPSHOT_COLUMNS} FROM month_snapshots WHERE scope = ? ORDER BY month DESC, version DESC LIMIT ?`, SCOPE, n).map(snapshotOf)
}

/** Each month whose latest close has status gap, the newest first. */
export function gapMonths(): MonthSnapshot[] {
  if (!db.upToDate()) return []
  return db
    .all<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM month_snapshots s WHERE s.scope = ? AND s.status = 'gap'
       AND s.version = (SELECT MAX(x.version) FROM month_snapshots x WHERE x.scope = s.scope AND x.month = s.month) ORDER BY s.month DESC`,
      SCOPE
    )
    .map(snapshotOf)
}

// ---------- checking closed months (sub-phase 1i) ----------

// A closed month's figures can move after it closes: a line recategorized on the Transactions page, a rule that
// rewrites history, a sync that brings a late line or a new amount, a paystub entered for a past check, a rate
// edited on the Accounts page, a statement dated in it, or a later payment that makes an old payee a series. A
// check finds every month a change may have moved, recomputes it as its close computed it, and compares the two
// (spec 2, Silent rewrites). What it looks at is cheap: each month's raw digest, every month's lines and series from
// one classification of the books (above), and the inputs stamp. A month is recomputed when any of those moved
// since it was last found equal to its close, and so are the eleven closed months after one whose own lines or
// dated inputs moved, since their run rates read it. A recomputed month whose line count, sum, lines, balances or
// rows differ from its latest close's is changed: it says so (status changed), with what moved and why (its
// diff), until Review accepts the new figures as its next version or the change is undone. Four changes re-close a
// month by themselves as a new version, with nothing for Review: a line that fills a balance gap of its amount, an
// Unsorted line given a category, a loan payment's split refined by a new balance with its total unchanged, and money
// with a venture moved between Ventures, Bought assets and Debt paid down with no other figure moving (sub-phase 1j);
// so does a month whose only change is one of those in an earlier month. Money with a venture reaches a month from
// outside it too (above, what later days and earlier claims decide of a month): a month ahead of it, and the claims
// its positions read.
//
// A change to the inputs stamp (a category renamed, a rule, a setting) recomputes every closed month, a third of a
// second each on a ledger of 16,000 transactions: a run checks one month at a time, giving the event loop back
// between months, and remembers each month as it goes, so a run cut short (quitting, a hosted event's limit)
// carries on where it stopped. Runs share the closes' queue, so a check never reads a month a close is writing,
// and the checks asked for while one runs are one more run after it. The look itself takes about two months'
// recomputing on those books, so it is taken a step at a time too, each shorter than one month's: a check holds
// the window's process no longer than recomputing one month does. And since every write asks for a check, one that
// touches nothing a closed month reads (a goal, the chat, a setting no month reads) is found by a digest of the books
// (booksDigest) and costs about a tenth of a look.

/** The digests a month was read with: its raw digest and parts, its lines' and series digests, and the inputs stamp. */
interface Digests {
  raw: string
  /** null for a close from before its parts were kept */
  parts: Record<string, string> | null
  lines: string
  /** null for a close from before its series were kept */
  series: string | null
  stamp: string
  /** the engine's version it was read under; a check kept from before it was kept reads its close's */
  engine?: number
  /** the source rows of the months ahead of it (aheadOf); none for a close or check from before they were kept */
  ahead?: string
  /** the claims its positions read, by venture (claimsRead); none for a close or check from before they were kept */
  claims?: Record<string, string>
}

/** What a closed month was last checked against, kept per month in a setting no figure reads. */
interface Checked {
  /** the latest close it was compared with; kept for an earlier one, it's read again only when that one is latest again */
  v: number
  /** what it was read with when its figures last equaled that close's: what a change since is named against */
  same: Digests
  /** what it was read with when found changed, so a check that finds nothing moved since leaves it as it is */
  seen?: Digests
  /** its figures differ from the close's: why, and the batch it's in */
  changed?: { cause: ChangeCause; batch: string; label: string; at: number }
  /**
   * each closed month of the eleven before it as it was read when this month last equaled its close: an earlier
   * month's change that waits for Review reaches this month's figures only if that month moved since
   */
  earlier?: Record<string, string>
}

const CHECKED = 'snapshots.checked:'
/** Each inputs stamp's parts, by the stamp: the ones a close or a month's check reads. */
const STAMP_PARTS = 'snapshots.stamp:'
/** A check under way: what it finds with the same cause is one batch, and the months it re-closed lead their followers. */
const SWEEP = 'snapshots.sweep'
/** The closed months after a month whose run rates read it: the 3-month and the 12-month windows. */
const FOLLOWERS = 11

function checkedOf(month: string): Checked | null {
  try {
    const v = db.getSetting(`${CHECKED}${month}`)
    return v ? (JSON.parse(v) as Checked) : null
  } catch {
    return null
  }
}

function allChecked(): Map<string, Checked> {
  const out = new Map<string, Checked>()
  for (const r of db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'snapshots.checked:%'")) {
    try {
      out.set(r.key.slice(CHECKED.length), JSON.parse(r.value) as Checked)
    } catch {
      // One that doesn't read is checked again.
    }
  }
  return out
}

const keepChecked = (month: string, c: Checked | null): void => db.writingCloses(() => db.setSetting(`${CHECKED}${month}`, c ? JSON.stringify(c) : null))

/**
 * A month as its check last read it, short: the close it was compared with, its own lines and dated inputs, and the
 * claims its positions read when there are any (a claim set on an earlier line moves every month after it, so a
 * month it moved leads the months after it into its batch).
 */
function stateOf(c: Checked | null): string {
  if (!c) return ''
  const d = c.seen ?? c.same
  const claims = d.claims && Object.keys(d.claims).length ? `|${JSON.stringify(d.claims)}` : ''
  return short(`${c.v}|${d.raw}|${d.lines}${claims}`)
}

/** The closed months of the eleven before a month, as their checks last read them. */
function earlierOf(month: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (let k = 1; k <= FOLLOWERS; k++) {
    const m = shiftMonth(month, -k)
    const c = checkedOf(m)
    if (c) out[m] = stateOf(c)
  }
  return out
}

/** A month's change that waits for Review, as its check keeps it: null unless its latest close is the changed one. */
function changeOf(month: string, c = checkedOf(month)): Checked['changed'] | null {
  if (!c?.changed) return null
  const s = db.get<{ v: number; status: string }>('SELECT version AS v, status FROM month_snapshots WHERE scope = ? AND month = ? ORDER BY version DESC LIMIT 1', SCOPE, month)
  return s && s.v === c.v && s.status === 'changed' ? c.changed : null
}

/**
 * The earlier months whose change waiting for Review reaches a month's figures, the nearest first: each of the eleven
 * before it that is changed and has moved since the month last equaled its close (by `mine`, the month's check), and
 * each this run couldn't check. With no check of the month's own to go by, every changed one does.
 */
function reaching(month: string, mine: Checked | null, failed: ReadonlySet<string> = new Set()): Array<{ month: string; changed: Checked['changed'] | null }> {
  const out: Array<{ month: string; changed: Checked['changed'] | null }> = []
  for (let k = 1; k <= FOLLOWERS; k++) {
    const m = shiftMonth(month, -k)
    if (failed.has(m)) {
      out.push({ month: m, changed: null })
      continue
    }
    const c = checkedOf(m)
    const changed = changeOf(m, c)
    if (!changed || (mine?.earlier && mine.earlier[m] === stateOf(c))) continue
    out.push({ month: m, changed })
  }
  return out
}

function stampPartsOf(stamp: string): Record<string, string> | null {
  try {
    const v = db.getSetting(`${STAMP_PARTS}${stamp}`)
    return v ? (JSON.parse(v) as Record<string, string>) : null
  } catch {
    return null
  }
}

function keepStampParts(stamp: string, parts: Record<string, string>): void {
  if (db.getSetting(`${STAMP_PARTS}${stamp}`) !== null) return
  db.writingCloses(() => db.setSetting(`${STAMP_PARTS}${stamp}`, JSON.stringify(parts)))
}

/** Drops the stamps' parts that no close and no month's check reads any more. */
function forgetStampParts(): void {
  const kept = new Set(db.all<{ s: string }>('SELECT DISTINCT inputs_stamp AS s FROM month_snapshots WHERE scope = ?', SCOPE).map((r) => r.s))
  for (const c of allChecked().values()) kept.add(c.same.stamp)
  const stale = db.all<{ key: string }>("SELECT key FROM settings WHERE key LIKE 'snapshots.stamp:%'").filter((r) => !kept.has(r.key.slice(STAMP_PARTS.length)))
  if (stale.length) db.writingCloses(() => stale.forEach((r) => db.setSetting(r.key, null)))
}

interface Sweep {
  id: string
  /** months this check re-closed by themselves: a month whose only change follows one re-closes too */
  reclosed: string[]
  /**
   * the months it has still to recompute: a month whose own figures moved is found equal to what it reads once it's
   * recomputed, so the months after it that its run rates move are known only from here when a run is cut short
   * (its limit, quitting, a month that couldn't be checked)
   */
  pending?: string[]
}

function sweepOf(): Sweep | null {
  try {
    const v = db.getSetting(SWEEP)
    return v ? (JSON.parse(v) as Sweep) : null
  } catch {
    return null
  }
}

const keepSweep = (s: Sweep | null): void => db.writingCloses(() => db.setSetting(SWEEP, s ? JSON.stringify(s) : null))

/** A month's latest close as the check reads it: the stored row with its rows and bridge. */
interface LatestRow extends SnapshotRow {
  rows: string
  bridge: string
}

const LATEST = `SELECT ${SNAPSHOT_COLUMNS}, "rows", bridge FROM month_snapshots s WHERE s.scope = ?
  AND s.version = (SELECT MAX(x.version) FROM month_snapshots x WHERE x.scope = s.scope AND x.month = s.month)`

const latestRows = (): LatestRow[] => db.all<LatestRow>(`${LATEST} ORDER BY s.month`, SCOPE)
const latestRow = (month: string): LatestRow | undefined => db.get<LatestRow>(`${LATEST} AND s.month = ?`, SCOPE, month)

/** A row as a close keeps it. */
type FrozenRow = db.ClosedRow

function frozenOf(r: Pick<LatestRow, 'rows'>): { rows: FrozenRow[]; series: string | null; raw: Record<string, string> | null; ahead?: string; claims?: Record<string, string> } {
  try {
    const x = JSON.parse(r.rows) as { rows?: FrozenRow[]; series?: string; raw?: Record<string, string>; ahead?: string; claims?: Record<string, string> }
    return { rows: x.rows ?? [], series: x.series ?? null, raw: x.raw ?? null, ...(x.ahead !== undefined ? { ahead: x.ahead } : {}), ...(x.claims ? { claims: x.claims } : {}) }
  } catch {
    return { rows: [], series: null, raw: null }
  }
}

/** What a month is compared against: what its check kept when it last read this close, else the close's own digests. */
function referenceOf(r: LatestRow, c: Checked | null): { same: Digests; seen: Digests; changed: Checked['changed'] | null; checked: boolean } {
  if (c && c.v === r.version) return { same: c.same, seen: c.seen ?? c.same, changed: c.changed ?? null, checked: true }
  const x = frozenOf(r)
  const same: Digests = {
    raw: r.raw_digest,
    parts: x.raw,
    lines: closedLinesDigest(r.month, r.version),
    series: x.series,
    stamp: r.inputs_stamp,
    engine: r.engine_version,
    ...(x.ahead !== undefined ? { ahead: x.ahead } : {}),
    ...(x.claims ? { claims: x.claims } : {})
  }
  return { same, seen: same, changed: null, checked: false }
}

/** The accounts a month's close reads the balances of: the month's perimeter and every account net worth counts, as monthClose has them. */
const bridgeAccounts = (month: string, accounts: Account[], counted: string[]): string[] => [...new Set([...perimeter(month, accounts), ...counted])]

/** The status a close was written with: closed, or gap when Unexplained is above its tolerance or an identity doesn't tie. */
function closedStatus(r: Pick<LatestRow, 'identity' | 'bridge'>): 'closed' | 'gap' {
  const identity = JSON.parse(r.identity) as Waterfall['identity'] & { toleranceCents: number }
  return closingStatus({ identity, bridge: JSON.parse(r.bridge) as Waterfall['bridge'], toleranceCents: identity.toleranceCents })
}

const setStatus = (month: string, version: number, status: MonthSnapshot['status']): void =>
  db.writingCloses(() => db.run('UPDATE month_snapshots SET status = ? WHERE scope = ? AND month = ? AND version = ?', status, SCOPE, month, version))

/** Every closed month's lines and series from one classification, kept until the data stamp moves. */
const surveys = new WeakMap<object, { stamp: string; from: string; to: string; months: Map<string, Look> }>()

/**
 * A check's pause between two steps of its work: the event loop is free meanwhile, so the window's calls are
 * answered, and false comes back when the books closed or were replaced (quitting, Delete all data, a restore).
 */
type Pause = (next: string) => Promise<boolean>

/**
 * Every closed month from one to another as one classification of the books reads it (survey), a step at a time with
 * the event loop free between them: the series every payee pays, then the classification that reads them, then
 * each month's digests. Each is shorter than recomputing one month. Kept until the data stamp moves, when nothing was
 * written while it was taken; null when the books closed meanwhile. `stamp` is the data stamp the classification
 * read the books at.
 */
async function surveyed(from: string, to: string, pause: Pause): Promise<{ months: Map<string, Look>; stamp: string | null } | null> {
  const stamp = db.dataStamp()
  const owner = db.currentConnection()
  const kept = owner ? surveys.get(owner) : undefined
  if (stamp !== null && kept && kept.stamp === stamp && kept.from === from && kept.to === to) return { months: kept.months, stamp }
  // The series first, kept for the classification after it while nothing is written: they read every payee's history.
  // Where nothing is kept per data stamp, the classification finds them itself.
  if (stamp !== null) {
    seriesByKey()
    if (!(await pause('lines'))) return null
  }
  const read = db.dataStamp()
  const lines = ledgerLines(...surveySpan(from, to))
  const series = seriesByKey()
  if (!(await pause('survey'))) return null
  const months = survey(from, to, lines, series)
  // A write since the classification is the next look's to read.
  if (read !== null && owner && db.dataStamp() === read) surveys.set(owner, { stamp: read, from, to, months })
  return { months, stamp: read }
}

/**
 * The tables a check's look reads beside what the inputs stamp reads of them: every row of each is in the books'
 * digest. test/check-responsive.test.ts names why each other table is left out, so a new table is placed in one or
 * the other.
 */
export const BOOKS_TABLES = [
  'transactions',
  'transaction_splits',
  'transaction_tags',
  'accounts',
  'balance_snapshots',
  'valuations',
  'recorded_flows',
  'categories',
  'rules',
  'bucket_rules',
  'buckets',
  'recurring_overrides',
  'contributions',
  'paystubs',
  'paystub_items',
  'asset_uses',
  'flows_known_from',
  'venture_money',
  'venture_shares',
  'venture_money_rules'
] as const

/**
 * Everything a check's look reads, as one digest: today (a capital window for money lent reaches to it), the inputs
 * stamp (the settings a month reads among it) and every row of BOOKS_TABLES. A write that leaves it as it was (a goal,
 * a note on the calendar, the chat, a setting no month reads, a value written as it was) can't move a closed month,
 * so a check after it has nothing to look at.
 */
function booksDigest(): string {
  const out = [db.today(), stampRead().stamp]
  for (const t of BOOKS_TABLES) out.push(t, JSON.stringify(db.all<Record<string, unknown>>(`SELECT * FROM ${t}`).map((r) => Object.values(r))))
  return sha256(out.join('\n'))
}

/** What a check keeps and compares with, as one digest: each month's latest close and its status, what each month's check kept, and the sweep. */
function checkState(): string {
  const closes = db.all<{ month: string; version: number; status: string }>(
    `SELECT s.month, s.version, s.status FROM month_snapshots s WHERE s.scope = ?
     AND s.version = (SELECT MAX(x.version) FROM month_snapshots x WHERE x.scope = s.scope AND x.month = s.month) ORDER BY s.month`,
    SCOPE
  )
  const kept = db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'snapshots.checked:%' OR key = 'snapshots.sweep' ORDER BY key")
  return sha256(JSON.stringify([closes, kept]))
}

/**
 * Each ledger's books and check state when a check last looked at every closed month and found none to recompute,
 * with nothing written while it looked: a check that finds both as they were has nothing to recompute either.
 */
const quiets = new WeakMap<object, { books: string; state: string }>()

/** What a run of checkClosed did. */
export interface CheckRun {
  /** the months recomputed and compared with their closes, oldest first */
  checked: string[]
  /** months found changed since their close */
  changed: ChangedMonth[]
  /** months that re-closed by themselves as their next version, and why */
  reclosed: Array<{ month: string; version: number; status: 'closed' | 'gap'; why: NonNullable<SnapshotDiff['autoReclose']> | 'follower' }>
  /** changed months whose figures are their close's again: the change was undone */
  restored: string[]
  /** months that couldn't be checked, with why; they're checked again on the next run */
  failed: Array<{ month: string; error: string }>
  /** months to recompute that `limit` left for a later run */
  left: number
}

/**
 * Recomputes every closed month that what it reads may have moved in, and compares it with its latest close (spec
 * 2): one month at a time with the event loop free between them, at most `limit` of them (the rest wait for the
 * next run), in the queue the closes run in. Its look at the books is taken a step at a time too. `between` is told
 * at each pause what comes next: a write there lands mid-run, as one from the window can.
 */
export function checkClosed(o: { limit?: number; between?: (next: string) => void } = {}): Promise<CheckRun> {
  return queued('check', () => checking(o.limit, o.between))
}

/** What a check recomputes, oldest first, and every closed month's lines and series as its look at the books read them. */
interface Plan {
  todo: string[]
  look: Map<string, Look>
}

/** Closed months whose raw digests one step of a check's look reads: a few milliseconds each. */
const RAW_PER_STEP = 12

/**
 * The months a check recomputes, oldest first, and every closed month's lines and series: each month what it
 * reads moved in (a month ahead of it among them, when it holds a part a later line can give an intent, and the
 * claims its positions read), the eleven after each one whose own lines or dated inputs moved, and `pending`, the
 * months a run cut short hadn't recomputed yet. The look at the books is taken a step at a time (the months' raw digests
 * RAW_PER_STEP at a time, then surveyed), and the months' closes and checks are read after it, as they are then: a
 * close Review wrote or undid meanwhile is compared as it stands. What was written while it looked is read by this
 * check or by the one the write asks for. A month's raw digest and its lines are read on the same side of a write,
 * so a month the write moves is recomputed once, by this check or the next, and its eleven followers with it: the raw
 * digests come first, and are read again after the classification when a write landed before it. Null when the books
 * closed meanwhile.
 */
async function planCheck(pending: string[], pause: Pause): Promise<Plan | null> {
  const months = db.all<{ month: string }>('SELECT DISTINCT month FROM month_snapshots WHERE scope = ? ORDER BY month', SCOPE).map((r) => r.month)
  if (!months.length) return { todo: [], look: new Map() }
  const raws = new Map<string, { digest: string; parts: Record<string, string> }>()
  /** The months' raw digests, RAW_PER_STEP at a time, with the inputs stamp and the data stamp as the first step read them. */
  const readRaws = async (): Promise<{ began: string | null; inputs: ReturnType<typeof stampRead> } | null> => {
    const accounts = db.listAccounts()
    const counted = db.countedAccounts()
    let first: { began: string | null; inputs: ReturnType<typeof stampRead> } | null = null
    for (let i = 0; i < months.length; i += RAW_PER_STEP) {
      if (!(await pause(`raw:${months[i]}`))) return null
      first ??= { began: db.dataStamp(), inputs: stampRead() }
      for (const m of months.slice(i, i + RAW_PER_STEP)) raws.set(m, rawRead(m, bridgeAccounts(m, accounts, counted)))
    }
    return first
  }
  let read = await readRaws()
  if (!read) return null
  if (!(await pause('series'))) return null
  const surveyedNow = await surveyed(months[0], months[months.length - 1], pause)
  if (!surveyedNow) return null
  const look = surveyedNow.months
  // A write between the raw digests and the classification: the classification read it, so the raw digests and the
  // inputs stamp read it too.
  if (read.began !== surveyedNow.stamp && !(read = await readRaws())) return null
  if (!(await pause('plan'))) return null
  const latest = latestRows()
  const checked = allChecked()
  const { stamp, parts } = read.inputs
  const accounts = db.listAccounts()
  const counted = db.countedAccounts()
  const closed = new Set(latest.map((r) => r.month))
  const moved: string[] = []
  const todo = new Set<string>(pending.filter((m) => closed.has(m)))
  const fresh: Array<{ r: LatestRow; same: Digests }> = []
  // The source rows of the months ahead of each closed month (a closed one's as its raw digest read them), and the
  // claims every closed month's positions read.
  const others = new Map<string, string>()
  const rowsOf = (m: string): string => raws.get(m)?.parts.lines ?? others.get(m) ?? others.set(m, rowsIn(m)).get(m)!
  const claims = claimsRead(latest.map((r) => r.month))
  for (const r of latest) {
    const ref = referenceOf(r, checked.get(r.month) ?? null)
    const raw = raws.get(r.month) ?? rawRead(r.month, bridgeAccounts(r.month, accounts, counted))
    const l = look.get(r.month)
    // A month closed while the look was taken, outside the months it read, is recomputed.
    if (!l) {
      todo.add(r.month)
      continue
    }
    const own = raw.digest !== ref.seen.raw || l.lines !== ref.seen.lines
    if (own) moved.push(r.month)
    // A month holding a part a later line can give an intent is classified again when a month ahead of it changed,
    // and every month whose positions read claims that moved is recomputed, however far after the line that moved them.
    const ahead = aheadOf(r.month, rowsOf)
    const owed = claims.get(r.month) ?? {}
    const reaches = (l.loose && ahead !== ref.seen.ahead) || claimsMoved(ref.seen.claims, owed).length > 0
    if (own || reaches || stamp !== ref.seen.stamp || (ref.seen.series !== null && l.series !== ref.seen.series) || (r.status === 'changed' && !ref.changed)) todo.add(r.month)
    else if (!ref.checked) fresh.push({ r, same: { raw: raw.digest, parts: raw.parts, lines: l.lines, series: l.series, stamp, engine: ENGINE_VERSION, ahead, claims: owed } })
  }
  for (const m of moved) for (let k = 1; k <= FOLLOWERS; k++) if (closed.has(shiftMonth(m, k))) todo.add(shiftMonth(m, k))
  // A month nothing it reads has moved in since its close is its close's still, and is checked from here on against
  // what it reads now. A close from before series were kept takes today's as its own.
  for (const { r, same } of fresh) {
    if (todo.has(r.month)) continue
    keepStampParts(stamp, parts)
    keepChecked(r.month, { v: r.version, same, earlier: earlierOf(r.month) })
  }
  return { todo: [...todo].sort(), look }
}

async function checking(limit: number | undefined, between: ((next: string) => void) | undefined): Promise<CheckRun> {
  const out: CheckRun = { checked: [], changed: [], reclosed: [], restored: [], failed: [], left: 0 }
  if (!db.upToDate()) return out
  const books = db.currentConnection()
  const kept = sweepOf()
  const digest = booksDigest()
  // Nothing a closed month reads has moved, and nothing a check keeps, since a look that found nothing to recompute.
  const quiet = books ? quiets.get(books) : undefined
  if (!kept && quiet && quiet.books === digest && quiet.state === checkState()) return out
  // Books closed or replaced meanwhile (quitting, Delete all data, a restore) are checked on their next run.
  const pause: Pause = async (next) => {
    await breather()
    between?.(next)
    return db.currentConnection() === books && !!books?.isOpen
  }
  const plan = await planCheck(kept?.pending ?? [], pause)
  if (!plan) return out
  if (!plan.todo.length) {
    if (kept) keepSweep(null)
    forgetStampParts()
    // Kept only when nothing was written while it looked: a write meanwhile is the next check's to read.
    if (books && booksDigest() === digest) quiets.set(books, { books: digest, state: checkState() })
    return out
  }
  // A check carries on the sweep a run cut short began: what they find with the same cause is one batch. What it has
  // to recompute is kept before it starts, and each month leaves it once it's checked.
  const sweep: Sweep = { ...(kept ?? { id: String(db.now()), reclosed: [] }), pending: plan.todo }
  keepSweep(sweep)
  // Each month recomputed, with the event loop free between them.
  for (const month of plan.todo) {
    if (limit !== undefined && out.checked.length + out.failed.length >= limit) {
      out.left++
      continue
    }
    if (!(await pause(`month:${month}`))) return out
    try {
      checkMonth(month, plan, sweep, out, new Set(out.failed.map((f) => f.month)))
      sweep.pending = (sweep.pending ?? []).filter((m) => m !== month)
    } catch (err) {
      out.failed.push({ month, error: message(err) })
    }
    keepSweep(sweep)
  }
  await breather()
  if (db.currentConnection() !== books || !books?.isOpen) return out
  if (!out.left && !out.failed.length) {
    keepSweep(null)
    forgetStampParts()
  }
  return out
}

/**
 * Recomputes one closed month and compares it with its latest close, in one read of the books. `failed` are the
 * months this run couldn't check: what moved in them may reach this one.
 */
function checkMonth(month: string, plan: Plan, sweep: Sweep, out: CheckRun, failed: ReadonlySet<string>): void {
  db.inTransaction(() => {
    const r = latestRow(month)
    if (!r) return
    const c = checkedOf(month)
    const ref = referenceOf(r, c)
    const mine = c && c.v === r.version ? c : null
    const now = monthClose(month)
    const raw = rawRead(month, [...now.balances.keys()])
    // The run's look at the books, not a new one: a minute passing mid-run would classify every month again here. A
    // month Review closed while the look was taken, outside the months it read, is read as a look that ends with it
    // reads it: the lines monthClose just classified (kept per data stamp) and the series they pay. The next check's
    // look ends with it when it's the newest closed month, so that check finds it as this one kept it.
    const look = plan.look.get(month) ?? survey(month, month, ledgerLines(...surveySpan(month, month)), seriesByKey()).get(month)!
    const { stamp, parts } = stampRead()
    keepStampParts(stamp, parts)
    const seen: Digests = { raw: raw.digest, parts: raw.parts, lines: look.lines, series: look.series, stamp, engine: ENGINE_VERSION, ahead: aheadOf(month, rowsIn), claims: claimsRead([month]).get(month) ?? {} }
    out.checked.push(month)
    if (sameAsClose(r, now)) {
      if (r.status === 'changed') {
        setStatus(month, r.version, closedStatus(r))
        out.restored.push(month)
      }
      keepChecked(month, { v: r.version, same: seen, earlier: earlierOf(month) })
      return
    }
    // Changed already: it stays so, in its batch, and is read again once something moves.
    if (ref.changed) {
      keepChecked(month, { v: r.version, same: ref.same, seen, changed: ref.changed, ...(mine?.earlier ? { earlier: mine.earlier } : {}) })
      return
    }
    const reach = reaching(month, mine, failed)
    const d = diffing(r, ref.same, now, raw, { stamp, parts }, reach, seen.claims!)
    const follows = followed(month, d.diff, sweep, reach)
    // A month re-closes by itself only when nothing else moved it: not an earlier month's change that waits for Review
    // (re-closing would keep that change as though Review had), and not the series its Committed run rate reads.
    const series = ref.same.series !== null && look.series !== ref.same.series
    const why = reach.length || series ? null : (d.diff.autoReclose ?? (follows?.auto ? 'follower' : null))
    if (why) {
      const s = closeMonth(month, 'auto')!
      keepChecked(month, { v: s.version, same: seen, earlier: earlierOf(month) })
      sweep.reclosed.push(month)
      out.reclosed.push({ month, version: s.version, status: s.status === 'gap' ? 'gap' : 'closed', why })
      return
    }
    const batch = batchOf(d, follows, r, sweep)
    setStatus(month, r.version, 'changed')
    const at = db.now()
    keepChecked(month, { v: r.version, same: ref.same, seen, changed: { ...batch, at }, ...(mine?.earlier ? { earlier: mine.earlier } : {}) })
    out.changed.push({ month, version: r.version, ...batch, since: at })
  })
}

/**
 * A month's figures now are its close's: the same lines (count, sum and digest), balances and rows. A close from an
 * earlier engine has its rows digested as that engine did (one before 1j froze no positions), so a month whose figures
 * are unchanged stays as it closed under a new one; a close whose digest is this engine's (one it re-closed, or put
 * down to an earlier version since) is compared as this engine digests.
 */
function sameAsClose(r: LatestRow, now: ReturnType<typeof monthClose>): boolean {
  const rows = rowsDigest(now.waterfall, r.engine_version)
  return (
    now.lines.length === r.line_count &&
    now.lines.reduce((s, l) => s + l.cents, 0) === r.line_sum &&
    linesDigest(now.lines) === r.line_digest &&
    balancesDigest(now.balances) === r.balance_digest &&
    (rows === r.rows_digest || (r.engine_version < ENGINE_VERSION && rowsDigest(now.waterfall) === r.rows_digest))
  )
}

/**
 * The earlier month a month's change comes from, when it has none of its own: the nearest of the eleven before it
 * whose change waiting for Review reaches it (`reach`), with its batch, else the nearest this check re-closed by
 * itself. Null when the month has changes of its own.
 */
function followed(month: string, diff: SnapshotDiff, sweep: Sweep, reach: ReturnType<typeof reaching>): { month: string; auto: boolean; changed: Checked['changed'] | null } | null {
  if (diff.lines.length || diff.inputs.some((i) => i.kind !== 'earlierMonth')) return null
  if (reach.length) return { month: reach[0].month, auto: false, changed: reach[0].changed }
  for (let k = 1; k <= FOLLOWERS; k++) {
    const m = shiftMonth(month, -k)
    if (sweep.reclosed.includes(m)) return { month: m, auto: true, changed: null }
  }
  return null
}

/** What each cause's batch is called when no journal entry names it. */
const CAUSE_LABEL: Record<ChangeCause, string> = {
  sync: 'A sync or import',
  user: 'Your edits',
  rule: 'A series, rule or setting',
  ai: 'Review',
  engine: `The engine's version ${ENGINE_VERSION}`
}

/**
 * The batch a newly changed month joins: the journal entry its changes came from, else the earlier month it follows,
 * else its first change's cause in this check (carried on by a run a limit cut short). An engine update is one batch.
 */
function batchOf(d: Diffed, follows: ReturnType<typeof followed>, r: LatestRow, sweep: Sweep): { cause: ChangeCause; batch: string; label: string } {
  if (d.journal) return { cause: d.journal.cause, batch: `change:${d.journal.id}`, label: d.journal.label }
  if (follows?.changed) return { cause: follows.changed.cause, batch: follows.changed.batch, label: follows.changed.label }
  const first = [...d.diff.lines, ...d.diff.inputs][0]
  const cause: ChangeCause = first?.cause ?? d.unnamed
  return { cause, batch: cause === 'engine' ? `engine:${ENGINE_VERSION}` : `${cause}:${sweep.id}`, label: CAUSE_LABEL[cause] }
}

// ---------- what changed, and why ----------

/** A change in the journal (tools.ts): a tool Review or the user ran, with what it was given and kept. */
interface Entry {
  id: number
  tool: string
  /** unix time it was made */
  at: number
  cause: ChangeCause
  input: Record<string, unknown>
  /** what it kept before and after, as the journal has them */
  before: unknown
  after: unknown
  /** its input and what it kept, as text, to find the transactions it names */
  text: string
}

/** Review, the file bridge and a connected app are the assistant; the user approving on the phone or replying to a text is the user. */
const originCause = (origin: string): ChangeCause => (origin === 'assistant' || origin === 'bridge' || origin.startsWith('mcp:') ? 'ai' : 'user')

/** The journal's changes from a moment on that weren't undone, the newest first. */
function journalSince(at: number): Entry[] {
  return db
    .all<{ id: number; tool: string; at: number; origin: string; input: string; before: string | null; after: string | null }>('SELECT id, tool, created_at AS at, origin, input, before, after FROM changes WHERE created_at >= ? AND undone_at IS NULL ORDER BY id DESC', at)
    .map((r) => {
      const read = (text: string | null): unknown => {
        try {
          return text === null ? null : (JSON.parse(text) as unknown)
        } catch {
          return null
        }
      }
      const input = read(r.input)
      return {
        id: r.id,
        tool: r.tool,
        at: r.at,
        cause: originCause(r.origin),
        input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
        before: read(r.before),
        after: read(r.after),
        text: `${r.input}\n${r.before ?? ''}\n${r.after ?? ''}`
      }
    })
}

const field = (x: unknown, key: string): unknown => (x && typeof x === 'object' ? (x as Record<string, unknown>)[key] : undefined)
const lower = (v: unknown): string => String(v ?? '').trim().toLowerCase()
const sameId = (v: unknown, id: string): boolean => v !== undefined && v !== null && String(v) === id

/** The merchant a categorize remembered as a rule, as its journal entry kept it. */
const ruleMerchant = (e: Entry): string | null => {
  const m = field(e.before, 'ruleMerchant')
  return e.tool === 'categorize' && e.input.remember === true && typeof m === 'string' && m ? m : null
}

/** The tools that write each setting the inputs stamp reads; the others are written on a page. */
const SETTING_TOOLS: Array<[RegExp, string[]]> = [
  [/^taxes$/, ['set_tax_year', 'delete_tax_year']],
  [/^budget\.trips$/, ['add_trip', 'remove_trip']],
  [/^insurance$/, ['set_insurance_policy', 'delete_insurance_policy']]
]

/** Each account field the inputs stamp reads, with the tool that writes it and, for update_account, the input that does. */
const ACCOUNT_TOOLS: Partial<Record<(typeof ACCOUNT_FIELDS)[number], { tool: string; input?: string[] }>> = {
  name: { tool: 'update_account', input: ['name'] },
  assetType: { tool: 'update_account', input: ['type'] },
  bucketId: { tool: 'update_account', input: ['bucket'] },
  hidden: { tool: 'update_account', input: ['hidden'] },
  taxTreatment: { tool: 'update_account', input: ['name', 'type'] },
  cashRole: { tool: 'set_account_role' },
  paymentKey: { tool: 'link_loan_payment' },
  apr: { tool: 'update_account', input: ['apr'] },
  promoApr: { tool: 'update_account', input: ['promo_apr'] },
  promoEnds: { tool: 'update_account', input: ['promo_ends'] },
  escrowCents: { tool: 'update_account', input: ['escrow'] },
  linkedAssetId: { tool: 'update_account', input: ['linked_asset_id'] },
  openedDay: { tool: 'update_account', input: ['opened'] },
  closedDay: { tool: 'update_account', input: ['closed'] },
  costCents: { tool: 'update_account', input: ['cost'] },
  saleCostsCents: { tool: 'update_account', input: ['sale_costs'] }
}

/**
 * The newest journal entry that wrote one of the inputs stamp's parts (`<section>:<row>`, or an account's
 * `accounts:<id>:<field>`), or none: a change made on a page has no entry, and one Review made to something else
 * since the month closed isn't this one's.
 */
function stampEntry(key: string, entries: Entry[]): Entry | undefined {
  const at = key.indexOf(':')
  const [section, id] = [key.slice(0, at), key.slice(at + 1)]
  switch (section) {
    case 'categories':
      return entries.find((e) => e.tool === 'create_category' && sameId(field(e.after, 'id'), id))
    case 'rules': {
      const rule = db.get<{ field: string; pattern: string }>('SELECT field, pattern FROM rules WHERE id = ?', Number(id))
      if (!rule) return undefined
      return entries.find(
        (e) =>
          (e.tool === 'create_rule' && (e.input.field === 'contains' ? 'contains' : 'merchant') === rule.field && lower(e.input.pattern) === lower(rule.pattern)) ||
          (rule.field === 'merchant' && lower(ruleMerchant(e)) === lower(rule.pattern))
      )
    }
    case 'bucket_rules':
      return entries.find((e) => (e.tool === 'add_bucket_rule' && sameId(field(e.after, 'rule_id'), id)) || (e.tool === 'delete_bucket_rule' && sameId(e.input.rule_id, id)))
    case 'recurring_overrides':
      return entries.find((e) => e.tool === 'update_recurring' && String(e.input.key ?? '') === id)
    case 'contributions': {
      const name = db.get<{ name: string }>('SELECT name FROM contributions WHERE id = ?', Number(id))?.name
      return entries.find(
        (e) =>
          (e.tool === 'set_contribution' || e.tool === 'delete_contribution') &&
          (sameId(field(e.after, 'id'), id) || sameId(field(e.before, 'id'), id) || (name !== undefined && lower(e.input.name) === lower(name)))
      )
    }
    case 'paystubs':
    case 'paystub_items':
      return entries.find((e) => ['record_paystub', 'set_paycheck_withholding', 'delete_paycheck_withholding'].includes(e.tool) && (sameId(field(e.after, 'id'), id) || sameId(field(e.before, 'id'), id)))
    case 'asset_uses': {
      const asset = db.get<{ a: string }>('SELECT asset_id AS a FROM asset_uses WHERE id = ?', Number(id))?.a
      return entries.find((e) => e.tool === 'set_asset_use' && ((asset !== undefined && e.input.asset_id === asset) || (Array.isArray(e.before) && e.before.some((u) => sameId(field(u, 'id'), id)))))
    }
    case 'buckets':
      return entries.find((e) => (e.tool === 'create_bucket' && sameId(field(e.after, 'id'), id)) || ((e.tool === 'update_bucket' || e.tool === 'set_venture_value') && sameId(field(e.before, 'id'), id)))
    case 'venture_shares': {
      // A share row's part is keyed by its venture and day; update_bucket's in_net_worth rewrites them too.
      const venture = id.slice(0, id.indexOf(':'))
      return entries.find(
        (e) =>
          (e.tool === 'create_bucket' && sameId(field(e.after, 'id'), venture)) ||
          ((e.tool === 'update_bucket' || e.tool === 'set_venture_share') && sameId(field(e.before, 'id'), venture)) ||
          (e.tool === 'set_venture_money' && e.input.share_after_pct !== undefined && sameId(field(e.before, 'id'), venture))
      )
    }
    case 'venture_money_rules':
      return entries.find((e) => e.tool === 'set_venture_money' && sameId(field(e.after, 'rule_id'), id))
    case 'flows_known_from':
      return entries.find((e) => e.tool === 'record_flows' && e.input.account_id === id && e.input.known_from !== undefined)
    case 'settings': {
      const tools = SETTING_TOOLS.find(([re]) => re.test(id))?.[1] ?? []
      return entries.find((e) => tools.includes(e.tool))
    }
    case 'accounts': {
      const cut = id.lastIndexOf(':')
      const [account, name] = [id.slice(0, cut), id.slice(cut + 1)]
      const w = ACCOUNT_TOOLS[name as (typeof ACCOUNT_FIELDS)[number]]
      return entries.find(
        (e) =>
          (e.tool === 'add_asset' && field(e.after, 'account_id') === account) ||
          (e.tool === 'merge_accounts' && (e.input.from_account_id === account || e.input.into_account_id === account)) ||
          (!!w && e.tool === w.tool && e.input.account_id === account && (!w.input || w.input.some((k) => e.input[k] !== undefined)))
      )
    }
    default:
      return undefined
  }
}

/**
 * Whether an inputs stamp's part (`<section>:<row>`, `was` as the close had it) moved only because this engine reads
 * more of a row than the one a month closed under (`engine`): before version 3 the stamp read none of a venture's
 * kind, value source and Stakes account, and no share rows, so a venture's row with neither set, and the share row
 * migration 43 gave it (from 0000-01-01), are new to the stamp and not to the books. One a journal entry wrote since
 * the close is that entry's.
 */
function engineOnly(key: string, was: string | undefined, engine: number): boolean {
  if (engine >= 3) return false
  const at = key.indexOf(':')
  const [section, id] = [key.slice(0, at), key.slice(at + 1)]
  if (section === 'buckets') {
    const b = db.get<{ id: number; from: string | null; to: string | null; converted: number; source: string | null; stake: string | null }>(
      'SELECT id, residence_from AS "from", residence_to AS "to", residence_converted AS converted, value_source AS source, stake_account_id AS stake FROM buckets WHERE id = ?',
      Number(id)
    )
    return !!b && b.source === null && b.stake === null && was === short(JSON.stringify([[b.id, b.from, b.to, b.converted]]))
  }
  if (section === 'venture_shares' && was === undefined) {
    const cut = id.indexOf(':')
    return id.slice(cut + 1) === '0000-01-01' && db.get<{ source: string }>('SELECT source FROM venture_shares WHERE bucket_id = ? AND from_day = ?', Number(id.slice(0, cut)), '0000-01-01')?.source === 'migrated'
  }
  return false
}

/** The newest journal entry that wrote one of an account's dated inputs: a balance, a valuation or a recorded flow. */
function rawEntry(kind: 'balance' | 'valuation' | 'flow', account: string, entries: Entry[]): Entry | undefined {
  return entries.find((e) => {
    if (e.tool === 'add_asset') return field(e.after, 'account_id') === account
    if (e.tool === 'merge_accounts') return e.input.from_account_id === account || e.input.into_account_id === account
    if (kind === 'flow') return (e.tool === 'record_flows' && e.input.account_id === account) || (e.tool === 'delete_flows' && Array.isArray(e.before) && e.before.some((f) => field(f, 'accountId') === account))
    return e.input.account_id === account && (['record_balance', 'delete_balance', 'record_balances'].includes(e.tool) || (e.tool === 'update_account' && e.input.balance !== undefined))
  })
}

/**
 * Where an account's dated inputs that moved came from when no journal entry wrote them: a bank feed's account, or a
 * balance the month reads that came from a sync, a statement file or a value looked up since the month closed, is a
 * sync; one typed in on a page is the user's.
 */
function rawCause(kind: 'balance' | 'valuation' | 'flow', account: string, month: string, closedAt: number): ChangeCause {
  const a = db.listAccounts().find((x) => x.id === account)
  if (FEEDS.has(a?.source ?? '')) return 'sync'
  if (kind === 'flow') return 'user'
  // A value looked up since the close writes an estimate: the month's own points and the ones either side of it.
  const first = `${month}-01`
  const last = lastDayOf(month)
  const looked = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM valuations WHERE account_id = ? AND created_at >= ?', account, closedAt)?.n ?? 0
  if (kind === 'valuation') return looked ? 'sync' : 'user'
  const points = db.all<{ s: string }>(
    `SELECT source AS s FROM balance_snapshots WHERE account_id = ? AND (day BETWEEN ? AND ? OR day = (SELECT MAX(day) FROM balance_snapshots WHERE account_id = ? AND day < ?) OR day = (SELECT MIN(day) FROM balance_snapshots WHERE account_id = ? AND day > ?))`,
    account,
    first,
    last,
    account,
    first,
    account,
    last
  )
  return points.some((p) => p.s === 'manual') && !looked ? 'user' : 'sync'
}

/** A journal entry in a few words, for the batch it leads: "Rule Shopmart > Shopping". */
function entryLabel(e: Entry): string {
  const s = (v: unknown): string => String(v ?? '').trim()
  switch (e.tool) {
    case 'create_rule':
      return `Rule ${s(e.input.pattern)} > ${s(e.input.category)}`
    case 'categorize':
      return e.input.remember === true && (s(e.input.merchant) || ruleMerchant(e)) ? `Rule ${s(e.input.merchant) || ruleMerchant(e)} > ${s(e.input.category)}` : `Categorized as ${s(e.input.category)}`
    case 'record_paystub':
    case 'set_paycheck_withholding':
      return `Paystub ${s(e.input.paycheck_key).replace(/\|[+-]$/, '')} ${s(e.input.pay_day)}`.trim()
    case 'set_contribution':
      return `Contribution ${s(e.input.name)}`
    case 'add_bucket_rule':
      return `Venture rule ${s(e.input.contains || e.input.account_id)} > ${s(e.input.bucket)}`
    default:
      return e.tool.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
  }
}

/** Where a transaction's category or venture came from, as a cause: by hand, by Review, a rule; null when nothing set it. */
const sourceCause = (source: string | null): ChangeCause | null => (source === null ? null : source === 'user' ? 'user' : source === 'ai' || source === 'assistant' ? 'ai' : 'rule')

/** A line as its close kept it. */
interface FrozenLine {
  key: string
  txnId: string
  splitId: number | null
  owner: number | null
  cls: LineClass
  cents: number
  categoryId: number | null
  accountId: string
}

/** A month's diff, with the journal entry its changes came from when one did. */
interface Diffed {
  diff: SnapshotDiff
  journal: { id: number; cause: ChangeCause; label: string } | null
  /** the cause of a change nothing names: engine when the classifier is not the one the month last equaled its close under, else rule */
  unnamed: ChangeCause
}

/**
 * How a closed month now differs from its latest close (spec 2): its lines line by line, the inputs that moved
 * with no line moving, each with its cause, every row as closed and now, and whether it's one of the changes that
 * re-close a month by themselves. `same` is what the month was read with when its figures last equaled the close's,
 * and `claims` the claims on the ventures its positions read now (claimsRead).
 */
function diffing(r: LatestRow, same: Digests, now: ReturnType<typeof monthClose>, raw: { digest: string; parts: Record<string, string> }, stamp: { stamp: string; parts: Record<string, string> }, reach: ReturnType<typeof reaching>, claims: Record<string, string>): Diffed {
  const entries = journalSince(r.closed_at)
  // A change nothing names is the classifier's when it isn't the one the month last equaled its close under: a later
  // series or setting that moves a month closed under an earlier classifier, once found equal under this one, is not.
  const newEngine = (same.engine ?? r.engine_version) !== ENGINE_VERSION
  const engine: ChangeCause = newEngine ? 'engine' : 'rule'
  let journal: Diffed['journal'] = null
  const named = (e: Entry | undefined): ChangeCause | null => {
    if (!e) return null
    journal ??= { id: e.id, cause: e.cause, label: entryLabel(e) }
    return e.cause
  }
  const idOf = (l: { txnId: string; splitId: number | null }): string => `${l.txnId}:${l.splitId ?? ''}`
  const group = <T extends { txnId: string; splitId: number | null }>(list: T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>()
    for (const l of list) {
      const k = idOf(l)
      const g = out.get(k)
      if (g) g.push(l)
      else out.set(k, [l])
    }
    return out
  }
  const frozen = db.all<FrozenLine>(
    'SELECT line_key AS key, txn_id AS txnId, split_id AS splitId, owner, class AS cls, cents, category_id AS categoryId, account_id AS accountId FROM snapshot_lines WHERE scope = ? AND month = ? AND version = ?',
    SCOPE,
    r.month,
    r.version
  )
  const before = group(frozen)
  const after = group(now.lines)
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort()
  const txns = new Map<string, { createdAt: number; categoryId: number | null; categorySource: string | null; bucketSource: string | null; oneTime: number }>()
  const txnIds = [...new Set(ids.map((k) => k.slice(0, k.lastIndexOf(':'))))]
  for (let i = 0; i < txnIds.length; i += 500) {
    const chunk = txnIds.slice(i, i + 500)
    for (const t of db.all<{ id: string; createdAt: number; categoryId: number | null; categorySource: string | null; bucketSource: string | null; oneTime: number }>(
      `SELECT id, created_at AS createdAt, category_id AS categoryId, category_source AS categorySource, bucket_source AS bucketSource, one_time AS oneTime FROM transactions WHERE id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk
    ))
      txns.set(t.id, t)
  }
  const splitCategory = new Map<number, number | null>()
  for (const l of now.lines) if (l.splitId !== null) splitCategory.set(l.splitId, l.categoryId)

  // The inputs first: a line that moved with no field of its own changing takes the cause of an input that moved.
  const inputs: SnapshotDiff['inputs'] = []
  if (same.stamp !== stamp.stamp) {
    const was = stampPartsOf(same.stamp)
    // With the stamp's parts gone, what moved is named only when the classifier is the same: a new one moves the stamp itself.
    if (!was) {
      if (!newEngine) inputs.push({ kind: 'setting', ref: '', cause: 'user' })
    } else {
      // Each input that moved once, put down to the newest entry that wrote any of its parts.
      const moved = new Map<string, { kind: SnapshotDiff['inputs'][number]['kind']; ref: string; entry: Entry | undefined }>()
      for (const key of [...new Set([...Object.keys(was), ...Object.keys(stamp.parts)])].sort()) {
        if (key === 'engine' || was[key] === stamp.parts[key]) continue
        // What this engine reads of the books that the month's didn't is the engine's, not an input that moved.
        if (engineOnly(key, was[key], same.engine ?? r.engine_version) && !stampEntry(key, entries)) continue
        const at = key.indexOf(':')
        const [section, id] = [key.slice(0, at), key.slice(at + 1)]
        const kind = section === 'paystubs' || section === 'paystub_items' ? 'paystub' : section === 'contributions' ? 'contribution' : section === 'accounts' ? 'account' : 'setting'
        let ref = key
        if (kind === 'paystub') {
          const p = db.get<{ key: string; day: string }>('SELECT paycheck_key AS key, pay_day AS day FROM paystubs WHERE id = ?', Number(id))
          ref = p ? `${p.key} ${p.day}` : `paystub ${id}`
        } else if (kind === 'contribution') ref = db.get<{ name: string }>('SELECT name FROM contributions WHERE id = ?', Number(id))?.name ?? `contribution ${id}`
        else if (kind === 'account') ref = id.includes(':') && ACCOUNT_FIELDS.includes(id.slice(id.lastIndexOf(':') + 1) as (typeof ACCOUNT_FIELDS)[number]) ? id.slice(0, id.lastIndexOf(':')) : id
        const entry = stampEntry(key, entries)
        const x = moved.get(`${kind}|${ref}`)
        if (!x) moved.set(`${kind}|${ref}`, { kind, ref, entry })
        else if (entry && (!x.entry || entry.id > x.entry.id)) x.entry = entry
      }
      for (const x of moved.values()) inputs.push({ kind: x.kind, ref: x.ref, cause: named(x.entry) ?? 'user' })
    }
  }
  if (same.raw !== raw.digest) {
    if (same.parts) {
      const seen = new Set<string>()
      for (const key of [...new Set([...Object.keys(same.parts), ...Object.keys(raw.parts)])].sort()) {
        if (key === 'lines' || key === 'later' || same.parts[key] === raw.parts[key]) continue
        const at = key.indexOf(':')
        const [part, accountId] = [key.slice(0, at), key.slice(at + 1)]
        const kind = part === 'valuation' ? 'valuation' : part === 'flow' ? 'flow' : 'balance'
        if (seen.has(`${kind}|${accountId}`)) continue
        seen.add(`${kind}|${accountId}`)
        inputs.push({ kind, ref: accountId, cause: named(rawEntry(kind, accountId, entries)) ?? rawCause(kind, accountId, r.month, r.closed_at) })
      }
    }
  }

  const lines: SnapshotDiff['lines'] = []
  const largest = <T extends { cents: number }>(xs: T[]): T => xs.reduce((a, x) => (Math.abs(x.cents) > Math.abs(a.cents) ? x : a))
  const total = (xs: Array<{ cents: number }>): number => xs.reduce((s, x) => s + x.cents, 0)
  const inputCause = (): ChangeCause | null => inputs.find((i) => i.kind !== 'earlierMonth')?.cause ?? null
  const sourceOf = new Map(db.listAccounts().map((a) => [a.id, a.source]))
  // A venture's money read again with no field of a line changing: the newest answer Review or the user gave for the
  // venture's lines since the close moved it (an answer on one line takes an inferred draw or payback from another),
  // unless a line of the venture's came after that answer, which the inferences read. A share, a value source or a
  // kind given since moved the inputs stamp, and is named there.
  const answers = new Map<number, Entry | null>()
  const answerFor = (v: number): Entry | null => {
    if (answers.has(v)) return answers.get(v)!
    const e = entries.find((x) => x.tool === 'set_venture_money' && sameId(field(x.before, 'id'), String(v))) ?? null
    let out = e
    if (e) {
      const ids = [...new Set(boundaryParts().units.filter((u) => u.ventureId === v).map((u) => u.txnId))]
      for (let i = 0; out && i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500)
        if (db.get(`SELECT 1 FROM transactions WHERE created_at > ? AND id IN (${chunk.map(() => '?').join(',')}) LIMIT 1`, e.at, ...chunk)) out = null
      }
    }
    answers.set(v, out)
    return out
  }
  // The month's own source rows moved: a line's own field (its one-time flag, its split) may be what moved it.
  const rowsMoved = !same.parts || same.parts.lines !== raw.parts.lines
  const splitNow = new Set(now.lines.filter((l) => l.splitId !== null).map((l) => l.txnId))
  const splitThen = new Set(frozen.filter((l) => l.splitId !== null).map((l) => l.txnId))
  for (const id of ids) {
    const F = before.get(id) ?? []
    const C = after.get(id) ?? []
    const txnId = id.slice(0, id.lastIndexOf(':'))
    const t = txns.get(txnId)
    const entry = entries.find((e) => e.text.includes(`"${txnId}"`))
    /**
     * What changed a line, the first that applies (spec 2): a journal entry; the bank (a line added since the close,
     * a new amount, a line gone from a bank feed's account); the field's own source; a field of its own edited on a
     * page (its one-time flag, a split, a line deleted from an account no bank feeds); else what it reads.
     */
    const cause = (change: SnapshotDiff['lines'][number]['change'], o: { category?: boolean; owner?: boolean; amount?: boolean; fromCls?: LineClass; toCls?: LineClass } = {}): ChangeCause => {
      const byJournal = named(entry)
      if (byJournal) return byJournal
      if (change === 'removed' && !t) return FEEDS.has(sourceOf.get(F[0]?.accountId ?? '') ?? '') ? 'sync' : 'user'
      // A bank never splits a line: its parts are the user's, though they are lines the close didn't have.
      if (t && rowsMoved && splitNow.has(txnId) !== splitThen.has(txnId)) return 'user'
      if ((change === 'added' && t && t.createdAt >= r.closed_at) || o.amount) return 'sync'
      const bySource = t && o.category ? sourceCause(t.categorySource) : t && o.owner ? sourceCause(t.bucketSource) : null
      if (bySource) return bySource
      if (t && rowsMoved && o.fromCls !== undefined && (o.fromCls === 'oneOff') !== (o.toCls === 'oneOff') && (t.oneTime === 1) === (o.toCls === 'oneOff')) return 'user'
      // Money with a venture whose intent a remembered answer or an inference gave it, or took away (sub-phase 1j): an
      // answer Review or the user remembered since is theirs, by the journal; then the newest answer about the
      // venture's money since the close; else a rule's, as is a new line that made it one of a pattern's or the payback
      // of a cost (the classifier's, under a new one).
      const given = C.find((x) => x.intentSource === 'rule' || x.intentSource === 'inferred')
      const remembered = given?.intentSource === 'rule' ? inputs.find((i) => i.kind === 'setting' && i.ref.startsWith('venture_money_rules:'))?.cause : undefined
      if (remembered) return remembered
      // An intent moved when a part left the Ventures term or joined it, or a funding's parts came or went.
      const intentMoved = F.some((x) => x.cls === 'venture') !== C.some((x) => x.cls === 'venture') || F.some((x) => isFundPart(x)) !== C.some((x) => isFundPart(x)) || !!given
      const v = C.find((x) => x.ventureId !== null)?.ventureId ?? null
      const answer = v !== null && intentMoved ? answerFor(v) : null
      if (answer) return named(answer)!
      return inputCause() ?? engine
    }
    if (!F.length) {
      for (const c of C) lines.push({ key: c.key, change: 'added', toCls: c.cls, toCents: c.cents, cause: cause('added') })
      continue
    }
    if (!C.length) {
      for (const f of F) lines.push({ key: f.key, change: 'removed', fromCls: f.cls, fromCents: f.cents, cause: cause('removed', { category: !!t && (t.categoryId ?? null) !== (f.categoryId ?? null), owner: !!t }) })
      continue
    }
    const nowCategory = C[0].splitId !== null ? (splitCategory.get(C[0].splitId) ?? null) : (t?.categoryId ?? C[0].categoryId)
    const category = (F[0].categoryId ?? null) !== (nowCategory ?? null)
    const owners = (xs: Array<{ owner: number | null }>): string => [...new Set(xs.map((x) => String(x.owner ?? 'p')))].sort().join()
    const [f, c] = [largest(F), largest(C)]
    if (owners(F) !== owners(C)) {
      lines.push({ key: c.key, change: 'owner', fromCls: f.cls, toCls: c.cls, fromCents: total(F), toCents: total(C), cause: cause('owner', { category, owner: true }) })
      continue
    }
    const byKey = new Map(C.map((x) => [x.key, x]))
    // A line in another category is restaged though its class is the same: its row's parts move.
    if (category || F.length !== C.length || F.some((x) => byKey.get(x.key)?.cls !== x.cls)) {
      lines.push({ key: c.key, change: 'restaged', fromCls: f.cls, toCls: c.cls, fromCents: total(F), toCents: total(C), cause: cause('restaged', { category, fromCls: f.cls, toCls: c.cls }) })
      continue
    }
    const amount = total(F) !== total(C)
    for (const x of F) {
      const y = byKey.get(x.key)!
      if (y.cents !== x.cents) lines.push({ key: x.key, change: 'reamounted', fromCls: x.cls, toCls: y.cls, fromCents: x.cents, toCents: y.cents, cause: cause('reamounted', { amount, category }) })
    }
  }

  // A close from before the raw digest's parts were kept names a dated input that moved by its month alone.
  if (same.raw !== raw.digest && !same.parts && !lines.length) inputs.push({ kind: 'balance', ref: '', cause: 'user' })
  // A month whose own lines and inputs didn't move, and whose figures did, follows the earlier month its run rates
  // read whose change reaches it.
  const follows = reach.find((x) => x.changed)
  if (!lines.length && !inputs.length && follows?.changed && !sameAsClose(r, now)) inputs.push({ kind: 'earlierMonth', ref: follows.month, cause: follows.changed.cause })
  // Else, one whose positions read claims on a venture that moved since (a loan, a reimbursement or a repayment on an
  // earlier line, more than eleven months back, or before months whose figures didn't move): each venture's, put down
  // to the newest of Review's or the user's answers for its money since the close, else to a rule (an inference).
  if (!lines.length && !inputs.length && !follows?.changed && !sameAsClose(r, now)) {
    for (const v of claimsMoved(same.claims, claims)) inputs.push({ kind: 'claims', ref: v, cause: named(entries.find((e) => e.tool === 'set_venture_money' && sameId(field(e.before, 'id'), v))) ?? 'rule' })
  }

  // Every figure the close froze beside today's: each row's and part's, the identity's and the bridge's terms, and
  // the lines of each row and term.
  const figures = closedFigures({ ...frozenFiguresOf(r), lines: frozen }, { rows: now.waterfall.rows, identity: now.waterfall.identity, bridge: now.waterfall.bridge, lines: now.lines })

  const lineOf = new Map<string, string>([...frozen, ...now.lines].map((l) => [l.key, idOf(l)]))
  return { diff: { month: r.month, version: r.version, lines, inputs, ...figures, autoReclose: autoReclose(r, lines, inputs, lineOf, frozen, now, figures) }, journal, unnamed: engine }
}

/** A close's figures as it froze them: its rows and their parts, the cash identity's terms (its tolerance is none) and the bridge. */
function frozenFiguresOf(r: Pick<LatestRow, 'rows' | 'identity' | 'bridge'>): KeptFigures {
  const read = (text: string): object => {
    try {
      return JSON.parse(text) as object
    } catch {
      return {}
    }
  }
  return { rows: frozenOf(r).rows, identity: read(r.identity), bridge: read(r.bridge) }
}

/**
 * Which of the four changes that re-close a month by themselves this is (spec 2, and the venture-money addendum's
 * fourth), if any: lines added on accounts that each fill that account's balance gap to the cent; Unsorted lines given
 * a category; a loan payment's interest and principal moved by a new balance on its debt, with the payment's total the
 * same; and money with a venture moved between Ventures, Bought assets and Debt paid down with no other figure moving
 * (boundaryMoved). Nothing else may have moved.
 */
function autoReclose(r: LatestRow, lines: SnapshotDiff['lines'], inputs: SnapshotDiff['inputs'], lineOf: Map<string, string>, frozen: FrozenLine[], now: ReturnType<typeof monthClose>, figures: ClosedFigures): SnapshotDiff['autoReclose'] {
  if (!lines.length) return null
  const own = inputs.filter((i) => i.kind !== 'earlierMonth')
  const idOf = (l: { txnId: string; splitId: number | null }): string => `${l.txnId}:${l.splitId ?? ''}`
  if (!own.length && lines.every((l) => l.change === 'added')) {
    const keys = new Set(lines.map((l) => l.key))
    const added = new Map<string, number>()
    for (const l of now.lines) if (keys.has(l.key)) added.set(l.accountId, (added.get(l.accountId) ?? 0) + l.cents)
    const was = new Map(db.all<{ a: string; g: number }>('SELECT account_id AS a, gap_cents AS g FROM snapshot_balances WHERE scope = ? AND month = ? AND version = ?', SCOPE, r.month, r.version).map((x) => [x.a, x.g]))
    const gapNow = (id: string): number => now.gaps.filter((g) => g.accountId === id).reduce((s, g) => s + g.cents, 0)
    if ([...added].every(([id, cents]) => (was.get(id) ?? 0) !== 0 && cents === was.get(id) && gapNow(id) === 0)) return 'gapFill'
  }
  if (!own.length && lines.every((l) => l.change === 'restaged' && l.fromCls === 'unsorted')) {
    const moved = new Set(lines.map((l) => lineOf.get(l.key)))
    const uncategorized = frozen.filter((f) => moved.has(idOf(f))).every((f) => f.categoryId === null)
    const categorized = now.lines.filter((l) => moved.has(idOf(l))).every((l) => l.categoryId !== null)
    if (uncategorized && categorized) return 'unsortedCategorized'
  }
  const debts = new Set(db.listAccounts().filter((a) => a.assetType === 'loan' || a.assetType === 'mortgage' || a.assetType === 'other_debt').map((a) => a.id))
  if (lines.every((l) => l.change === 'reamounted' && /:(int|prin)$/.test(l.key)) && own.every((i) => i.kind === 'balance' && debts.has(i.ref))) {
    const moved = new Map<string, number>()
    for (const l of lines) moved.set(lineOf.get(l.key) ?? l.key, (moved.get(lineOf.get(l.key) ?? l.key) ?? 0) + (l.toCents ?? 0) - (l.fromCents ?? 0))
    if ([...moved.values()].every((c) => c === 0)) return 'loanRefined'
  }
  if (boundaryMoved(r, lines, inputs, lineOf, frozen, now, figures)) return 'boundaryMoved'
  return null
}

/** The cash identity's terms money with a venture moves between in the fourth change, and their lines' classes. */
const BOUNDARY_TERMS = new Set<string>(['venturesCents', 'boughtCents', 'debtPaidCents'])
const BOUNDARY_CLASSES = new Set<LineClass>(['venture', 'capital', 'principal'])

/**
 * The fourth change that re-closes a month by itself (venture-money addendum, Frozen data): parts of boundary lines
 * moved between Ventures, Bought assets and Debt paid down, and nothing else moved. At 100% by the books a loan,
 * equity or a reimbursement given to a line that had no intent is one: the money leaves Ventures for Bought assets,
 * the position is the venture's accounts as before, and so is net worth. Every part of a line that moved and isn't as
 * it closed is a boundary part in one of the three terms (a part with no intent was class venture; a funding's, or
 * one with a venture now); every row's and part's actual, run rate, rate and pay basis, the identity's other terms,
 * every figure of the bridge (Ventures(NW), and net worth at both ends, so ΔNW), each venture's position and the
 * balances are as the close has them. Its inputs may be a remembered answer for a venture's lines and balances that
 * leave the month's as they closed.
 */
function boundaryMoved(r: LatestRow, lines: SnapshotDiff['lines'], inputs: SnapshotDiff['inputs'], lineOf: Map<string, string>, frozen: FrozenLine[], now: ReturnType<typeof monthClose>, figures: ClosedFigures): boolean {
  // An intent never moves a line to another owner (a venture's cost keeps its venture): a line placed elsewhere is no such change.
  if (!lines.length || lines.some((l) => l.change === 'owner')) return false
  // A share row (share_after_pct on the line's equity, or set_venture_share) may move with it: every position below is
  // then as the close froze it, so it moved nothing else.
  if (!inputs.every((i) => i.kind === 'balance' || (i.kind === 'setting' && (i.ref.startsWith('venture_money_rules:') || i.ref.startsWith('venture_shares:'))))) return false
  if (balancesDigest(now.balances) !== r.balance_digest) return false
  const idOf = (l: { txnId: string; splitId: number | null }): string => `${l.txnId}:${l.splitId ?? ''}`
  const asClosed = (a: { key: string; cls: LineClass; cents: number }, b: { key: string; cls: LineClass; cents: number }): boolean => a.key === b.key && a.cls === b.cls && a.cents === b.cents
  for (const id of new Set(lines.map((l) => lineOf.get(l.key) ?? l.key))) {
    const was = frozen.filter((f) => idOf(f) === id)
    const is = now.lines.filter((l) => idOf(l) === id)
    const boundary = is.some((l) => l.ventureId !== null)
    for (const f of was) if (!is.some((l) => asClosed(f, l)) && !(BOUNDARY_CLASSES.has(f.cls) && (f.cls === 'venture' || isFundPart(f) || boundary))) return false
    for (const l of is) if (!was.some((f) => asClosed(f, l)) && !(BOUNDARY_CLASSES.has(l.cls) && l.ventureId !== null)) return false
  }
  const kept = (x: { closedCents: number; nowCents: number }): boolean => x.closedCents === x.nowCents
  for (const s of figures.byStage) {
    if (!kept(s) || s.closedRunRateCents !== s.nowRunRateCents || s.closedRate !== s.nowRate || s.closedBasis !== s.nowBasis) return false
    if (!s.parts.every((p) => kept(p) && p.closedRunRateCents === p.nowRunRateCents && p.closedRate === p.nowRate)) return false
  }
  if (!figures.identity.every((t) => BOUNDARY_TERMS.has(t.key) || kept(t)) || !figures.bridge.every(kept) || figures.other.length) return false
  // The rows as the rows digest reads them (a row or part that came or went among them), and each venture's position
  // where the close froze them (from engine version 3).
  const same = (a: string[], b: string[]): boolean => a.sort().join('\n') === b.sort().join('\n')
  if (!same(rowLines(frozenOf(r).rows), rowLines(now.waterfall.rows))) return false
  const closedPositions = (JSON.parse(r.bridge) as Partial<NetWorthBridge>).ventures
  return !closedPositions || same(positionLines(closedPositions), positionLines(now.waterfall.bridge.ventures))
}

// ---------- what Review reads and does ----------

/** How a closed month differs today from its latest close, and why (spec 2 and 6); null for a month not closed. */
export function diffSnapshot(month: string): SnapshotDiff | null {
  if (!db.upToDate() || !isMonth(String(month))) return null
  return db.inTransaction(() => {
    const r = latestRow(month)
    if (!r) return null
    const now = monthClose(month)
    const c = checkedOf(month)
    return diffing(r, referenceOf(r, c).same, now, rawRead(month, [...now.balances.keys()]), stampRead(), reaching(month, c && c.v === r.version ? c : null), claimsRead([month]).get(month) ?? {}).diff
  })
}

/** Every closed month whose figures changed since its latest close, the newest first, with why and its batch. */
export function changedMonths(): ChangedMonth[] {
  if (!db.upToDate()) return []
  return latestRows()
    .filter((r) => r.status === 'changed')
    .map((r) => {
      const c = checkedOf(r.month)
      const x = c && c.v === r.version ? c.changed : undefined
      return { month: r.month, version: r.version, cause: x?.cause ?? 'rule', batch: x?.batch ?? 'unknown', label: x?.label ?? CAUSE_LABEL.rule, since: x?.at ?? r.closed_at }
    })
    .reverse()
}

/** Changed months kept in one call at most: each is closed again, which costs what its waterfall does. */
export const ACCEPT_PER_CALL = 12

/**
 * Changed months a call keeps at least in the process the app's window runs in (Electron's main process), where
 * Review's tools run synchronously when Review is the app's own loop (with an API key) or the file bridge. Four
 * months hold the window 1.1 to 1.4 seconds on 95 months of 24,800 transactions (test/fixtures/large-ledger.ts): the
 * first classifies the books afresh (each call follows a write, the last call's journal entry among them) and the
 * three after it read the series it found. So a call makes headway on large books: the 60 months a new engine version
 * restates on that ledger's shorter form are 15 calls, each one journal entry, within the 16 steps of a turn of Review's own
 * loop.
 */
export const ACCEPT_AT_LEAST = 4

/**
 * How long a call in the window's process goes on past ACCEPT_AT_LEAST months, in milliseconds: another month while
 * the time so far and the last month's stay within it, so small books keep ACCEPT_PER_CALL a call. Review's tool
 * server for Claude Code is a process of its own, and a hosted ledger has no window: both keep ACCEPT_PER_CALL a call.
 */
export const ACCEPT_HOLD_MS = 1000

/** How long a call of acceptCloseChanges goes on past ACCEPT_AT_LEAST months by default: ACCEPT_HOLD_MS in the window's process, no limit elsewhere. */
const acceptHold = (): number => ((globalThis as { process?: { type?: string } }).process?.type === 'browser' ? ACCEPT_HOLD_MS : Infinity)

/**
 * Keeps the figures of changed months (all of them, with none named) as each one's next version, origin review,
 * the oldest first, since a month's run rates read the months before it: ACCEPT_PER_CALL of them at most, and past
 * ACCEPT_AT_LEAST only while the time so far and the last month's stay within `holdMs` (the last month, not the
 * first: the first finds the series the others read), so one call stays short (on a ledger of 16,000 transactions a
 * third of a second a month); `left` says how many changed months are still to keep. They're written in one
 * transaction, so a call cut off part way keeps none, never some with no journal entry to undo them by. A month that
 * hasn't changed is refused.
 */
export function acceptCloseChanges(months?: string[], holdMs = acceptHold()): { kept: MonthSnapshot[]; left: number } {
  const changed = new Set(changedMonths().map((c) => c.month))
  const asked = months?.length ? [...new Set(months.map((m) => String(m).trim()))] : [...changed]
  if (!asked.length) throw new Error('No closed month has changed since its close')
  for (const m of asked) if (!changed.has(m)) throw new Error(isMonth(m) ? `${m} hasn't changed since its close` : 'A month is like 2026-10')
  const pick = asked.sort().slice(0, ACCEPT_PER_CALL)
  const kept = db.inTransaction(() => {
    const out: MonthSnapshot[] = []
    const start = performance.now()
    let last = 0
    for (const m of pick) {
      if (out.length >= ACCEPT_AT_LEAST && performance.now() - start + last > holdMs) break
      const t = performance.now()
      out.push(closeMonth(m, 'review')!)
      last = performance.now() - t
    }
    return out
  })
  return { kept, left: changed.size - kept.length }
}

/** What each month's check kept, as it is, to put back when accepting is undone (journal.ts). */
export const checkedStates = (months: string[]): Record<string, string | null> => Object.fromEntries(months.map((m) => [m, db.getSetting(`${CHECKED}${m}`)]))

/** Puts each month's check back as checkedStates read it. */
export const restoreCheckedStates = (states: Record<string, string | null>): void =>
  db.writingCloses(() => {
    for (const [m, v] of Object.entries(states)) db.setSetting(`${CHECKED}${m}`, v)
  })

/** A check a moment after the last write, so a burst of them is one check, off the window's calls. */
let checkSoon: ReturnType<typeof setTimeout> | null = null
let checkDone: ((run: CheckRun) => void) | undefined
export const CHECK_AFTER_MS = 2000

/** Checks the closed months `delayMs` after the last call (2 seconds by default), and tells `done` (the last one given) what it found. */
export function scheduleCheck(delayMs = CHECK_AFTER_MS, done?: (run: CheckRun) => void): void {
  if (done) checkDone = done
  if (checkSoon) clearTimeout(checkSoon)
  checkSoon = setTimeout(() => {
    checkSoon = null
    // The books may have closed meanwhile (quitting, Delete all data).
    if (!db.currentConnection()?.isOpen) return
    checkClosed().then(
      (run) => checkDone?.(run),
      (err) => console.error(`[check] failed${errorTag(err)}`)
    )
  }, delayMs)
  // A pending check never keeps the process alive.
  ;(checkSoon as { unref?: () => void }).unref?.()
}
