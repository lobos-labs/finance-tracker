import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Account, Bucket, Category, ClassifiedLine, LineAsset, LineQuery, TagCount, Transaction, TxnPage, TxnQuery } from '../../../shared/types'
import { parseAmount } from '../../../shared/parse'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, currentMonth, errorMessage, fmtDate, fmtMoney, monthBounds, monthLabel, shiftMonth, spanLabel, todayKey } from '../lib'
import { dayBounds, daysIn, lastDays } from '../../../shared/period'
import { daysInMonth } from '../../../shared/zone'
import { EmptyCard, ImportCsvButton } from '../Empty'
import { drillRows, lineQuery, type DrillRows, type TxnFilter } from './txnFilter'
import { intentTag } from './ventureView'

const PAGE = 200

/** A row of the list: a transaction, or under a drill one of its classified lines, at the line's own amount. */
interface Shown {
  key: string
  t: Transaction
  cents: number
  line: ClassifiedLine | null
}

/** A drill's days as the list names them: "Oct 2026", "Jan – Oct 2026", "Sep 4 – Oct 3, 2026". */
function drillDays(q: LineQuery): string {
  const whole = q.fromDay.endsWith('-01') && Number(q.toDay.slice(8)) === daysInMonth(Number(q.toDay.slice(0, 4)), Number(q.toDay.slice(5, 7)))
  if (!whole) return daysLabel(q.fromDay, q.toDay)
  const [from, to] = [q.fromDay.slice(0, 7), q.toDay.slice(0, 7)]
  return from === to ? `${monthLabel(from, 'short')} ${from.slice(0, 4)}` : spanLabel(from, to)
}

function rangeToQuery(range: string): Pick<TxnQuery, 'from' | 'to'> {
  if (range.startsWith('m:')) return monthBounds(range.slice(2))
  if (range.startsWith('s:')) {
    const [from, to] = range.slice(2).split(':')
    return { from: monthBounds(from).from, to: monthBounds(to).to }
  }
  if (range.startsWith('d:')) {
    const [from, to] = range.slice(2).split(':')
    return dayBounds(from, to)
  }
  // The last n days are whole days, today included, as Home's 30D is.
  const days = Number(range)
  if (days > 0) return { from: dayBounds(lastDays(days).from, todayKey()).from }
  return {}
}

/** "Sep 4 – Oct 3, 2026"; one day "Nov 2, 2026"; across years "Jan 1, 2016 – Dec 7, 2026". */
export function daysLabel(from: string, to: string): string {
  const short = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (from === to) return `${short(from)}, ${to.slice(0, 4)}`
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${short(from)}, ${from.slice(0, 4)} – ${short(to)}, ${to.slice(0, 4)}`
  return `${short(from)} – ${short(to)}, ${to.slice(0, 4)}`
}

export function CategorySelect({ categories, value, onChange, className, allowNone = true }: { categories: Category[]; value: number | null; onChange: (id: number | null) => void; className?: string; allowNone?: boolean }): ReactNode {
  const groups: Array<[string, Category[]]> = [
    ['Spending', categories.filter((c) => c.kind === 'expense')],
    ['Income', categories.filter((c) => c.kind === 'income')],
    ['Transfers (not counted)', categories.filter((c) => c.kind === 'transfer')]
  ]
  return (
    <select className={`select ${className ?? ''} ${value === null ? 'is-empty' : ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} aria-label="Category">
      {allowNone ? (
        <option value="">Uncategorized</option>
      ) : (
        <option value="" disabled>
          Choose a category…
        </option>
      )}
      {groups.map(([label, cats]) =>
        cats.length ? (
          <optgroup key={label} label={label}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        ) : null
      )}
    </select>
  )
}

export function BucketSelect({ buckets, value, onChange }: { buckets: Bucket[]; value: number | null; onChange: (id: number | null) => void }): ReactNode {
  return (
    <select className={`select ${value === null ? 'is-personal' : ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} aria-label="Bucket">
      <option value="">Personal</option>
      {buckets.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  )
}

function SourceTag({ t }: { t: Transaction }): ReactNode {
  if (t.categoryId === null) return null
  if (t.categorySource === 'ai') {
    const low = t.confidence === 'low'
    return (
      <span className={`tag ai ${low ? 'low' : ''}`} title={low ? "The AI wasn't sure about this one — worth a check" : `Categorized by AI (${t.confidence ?? 'unknown'} confidence)`}>
        {low ? 'AI ?' : 'AI'}
      </span>
    )
  }
  if (t.categorySource === 'rule') return <span className="tag rule" title="Matched one of your rules">Rule</span>
  if (t.categorySource === 'assistant') return <span className="tag rule" title="Set in Review">Review</span>
  return null
}

/** What the shown transactions are costs of: a row's label, and each split part's. */
interface AssetLabels {
  /** the line's label, or a split one's assets by name */
  row: string
  parts: Map<number, string>
}

/**
 * "34% · Bayview house" on a line an asset's uses share, Personal's share first; the asset's name alone on a line
 * Personal bears whole. A split transaction's row names its parts' assets, and each part has its own label.
 */
function assetLabels(list: LineAsset[], accounts: Account[]): Map<string, AssetLabels> {
  const names = new Map(accounts.map((a) => [a.id, a.name]))
  const name = (id: string): string => names.get(id) ?? ''
  const label = (l: LineAsset): string => (l.personalBp === 10000 ? name(l.assetId) : `${l.personalBp / 100}% · ${name(l.assetId)}`)
  // Until the accounts are read there are no names to show.
  const byTxn = new Map<string, LineAsset[]>()
  for (const l of list) if (names.has(l.assetId)) byTxn.set(l.txnId, [...(byTxn.get(l.txnId) ?? []), l])
  return new Map(
    [...byTxn].map(([txnId, lines]) => {
      const whole = lines.find((l) => l.splitId === null)
      const parts = new Map(lines.flatMap((l) => (l.splitId === null ? [] : [[l.splitId, label(l)] as const])))
      return [txnId, { row: whole ? label(whole) : [...new Set(lines.map((l) => name(l.assetId)))].join(' · '), parts }]
    })
  )
}

/** A row the user imported or entered can be deleted; a bank-synced one would come back on the next sync. */
const deletable = (t: Transaction): boolean => !t.id.startsWith('sf:') || t.id.includes(':csv:')

/** A part in the Split editor: the amount as typed, without its sign. */
interface DraftPart {
  amount: string
  categoryId: number | null
  bucketId: number | null
  oneTime: boolean
  note: string
}

const SPLIT_MAX = 20
/** Longest tag (db.ts TAG_MAX). */
const TAG_MAX = 40

/** The split as it is, or two parts to start one: the first in the transaction's category. */
const draftOf = (t: Transaction): DraftPart[] =>
  t.splits.length
    ? t.splits.map((s) => ({ amount: (Math.abs(s.amountCents) / 100).toFixed(2), categoryId: s.categoryId, bucketId: s.bucketId, oneTime: s.oneTime, note: s.note ?? '' }))
    : [
        { amount: '', categoryId: t.categoryId, bucketId: t.bucketId, oneTime: false, note: '' },
        { amount: '', categoryId: null, bucketId: t.bucketId, oneTime: false, note: '' }
      ]

/** Typed cents, unsigned; null when it isn't an amount. */
function partCents(s: string): number | null {
  const c = parseAmount(s)
  return c === null ? null : Math.abs(c)
}

/** Parts with an amount, category, venture, note and one-off flag each, and the remainder that has to reach $0.00. */
function SplitEditor({ t, onClose }: { t: Transaction; onClose: () => void }): ReactNode {
  const { categories, buckets, toast } = useApp()
  const [parts, setParts] = useState<DraftPart[]>(() => draftOf(t))
  const [saving, setSaving] = useState(false)
  const sign = t.amountCents < 0 ? -1 : 1
  const amounts = parts.map((p) => partCents(p.amount))
  const remainder = Math.abs(t.amountCents) - amounts.reduce<number>((s, c) => s + (c ?? 0), 0)
  const ready = parts.length >= 2 && amounts.every((c) => c !== null && c > 0) && remainder === 0
  const set = (i: number, patch: Partial<DraftPart>): void => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const addPart = (): void => setParts((ps) => [...ps, { amount: remainder > 0 ? (remainder / 100).toFixed(2) : '', categoryId: null, bucketId: t.bucketId, oneTime: false, note: '' }])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await api.splitTransaction(
        t.id,
        parts.map((p, i) => ({ amountCents: sign * amounts[i]!, categoryId: p.categoryId, bucketId: p.bucketId, oneTime: p.oneTime, note: p.note.trim() || null }))
      )
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="split-editor">
      {parts.map((p, i) => (
        <div className="split-row" key={i}>
          <input className="input split-amount" inputMode="decimal" value={p.amount} placeholder="0.00" aria-label={`Part ${i + 1} amount`} onChange={(e) => set(i, { amount: e.target.value })} />
          <CategorySelect categories={categories} value={p.categoryId} onChange={(id) => set(i, { categoryId: id })} />
          {buckets.length > 0 && <BucketSelect buckets={buckets} value={p.bucketId} onChange={(id) => set(i, { bucketId: id })} />}
          <input className="input split-note" value={p.note} placeholder="Note" aria-label={`Part ${i + 1} note`} onChange={(e) => set(i, { note: e.target.value })} />
          <label className="check small">
            <input type="checkbox" checked={p.oneTime} onChange={(e) => set(i, { oneTime: e.target.checked })} />
            One-off
          </label>
          <button className="btn small ghost icon-btn" aria-label={`Remove part ${i + 1}`} disabled={parts.length <= 2} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <div className="split-foot">
        <button className="btn small ghost" disabled={parts.length >= SPLIT_MAX} onClick={addPart}>
          <Icon name="plus" size={13} /> Add part
        </button>
        <span className={`split-remainder ${remainder === 0 ? 'done' : ''}`}>
          Remainder <span className="num">{fmtMoney(remainder)}</span>
        </span>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn small ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn small primary" disabled={!ready || saving} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}

/** The transaction's tags as chips with a remove each, and a field that adds one on Enter or a comma. */
function TagEditor({ t }: { t: Transaction }): ReactNode {
  const { toast } = useApp()
  const [text, setText] = useState('')
  const run = (p: Promise<void>): void => void p.catch((e: unknown) => toast(errorMessage(e), 'error'))
  function add(): void {
    const tag = text.trim()
    if (!tag) return
    setText('')
    run(api.addTags([t.id], [tag]))
  }
  return (
    <div className="tag-chips">
      {t.tags.map((g) => (
        <span className="tag-chip" key={g}>
          {g}
          <button className="tag-chip-x" aria-label={`Remove tag ${g}`} onClick={() => run(api.removeTags([t.id], [g]))}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      <input
        className="input tag-input"
        value={text}
        placeholder="Add tag"
        aria-label="Add tag"
        list="tag-options"
        maxLength={TAG_MAX}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
      />
    </div>
  )
}

/** Under a row: its tags, and its split (the parts, or the editor), each part with the asset it's a cost of. */
function TxnDetail({ t, assets }: { t: Transaction; assets?: Map<number, string> }): ReactNode {
  const { categories, buckets, toast } = useApp()
  const [editing, setEditing] = useState(false)
  const category = (id: number | null): string => categories.find((c) => c.id === id)?.name ?? 'Uncategorized'
  const venture = (id: number | null): string => (id === null ? 'Personal' : (buckets.find((b) => b.id === id)?.name ?? 'Personal'))
  return (
    <div className="txn-detail-body">
      <div className="detail-field">
        <span className="detail-label">Tags</span>
        <TagEditor t={t} />
      </div>
      <div className="detail-field">
        <span className="detail-label">Split</span>
        {editing ? (
          <SplitEditor t={t} onClose={() => setEditing(false)} />
        ) : t.splits.length ? (
          <div className="split-view">
            {t.splits.map((s) => (
              <div className="split-line" key={s.id}>
                <span className="num">{fmtMoney(s.amountCents)}</span>
                <span className="truncate">{category(s.categoryId)}</span>
                {buckets.length > 0 && <span className="truncate muted">{venture(s.bucketId)}</span>}
                <span className="truncate muted">{[s.note, assets?.get(s.id)].filter(Boolean).join(' · ')}</span>
                <span>{s.oneTime && <span className="tag">One-off</span>}</span>
              </div>
            ))}
            <div className="split-foot">
              <button className="btn small" onClick={() => setEditing(true)}>
                Edit split
              </button>
              <button className="btn small ghost" onClick={() => void api.unsplitTransaction(t.id).catch((e: unknown) => toast(errorMessage(e), 'error'))}>
                Unsplit
              </button>
            </div>
          </div>
        ) : (
          <button className="btn small" disabled={t.pending} onClick={() => setEditing(true)}>
            Split
          </button>
        )}
      </div>
    </div>
  )
}

export default function Transactions({ initialFilter }: { initialFilter: TxnFilter }): ReactNode {
  const { tick, categories, buckets, toast, runClassify, classifying, settings } = useApp()
  const [search, setSearch] = useState(initialFilter.search ?? '')
  const [debounced, setDebounced] = useState(initialFilter.search ?? '')
  const [range, setRange] = useState(() => {
    const { month, toMonth, fromDay, toDay } = initialFilter
    if (fromDay && toDay) {
      // The last 30 or 90 days are in the list already.
      const n = daysIn(fromDay, toDay)
      return toDay === todayKey() && (n === 30 || n === 90) ? String(n) : `d:${fromDay}:${toDay}`
    }
    if (month && toMonth && toMonth !== month) return `s:${month}:${toMonth}`
    return month ? `m:${month}` : 'all'
  })
  const [accountId, setAccountId] = useState(initialFilter.accountId ?? '')
  const [categoryFilter, setCategoryFilter] = useState(initialFilter.categoryId !== undefined ? String(initialFilter.categoryId) : '')
  const [bucketFilter, setBucketFilter] = useState(initialFilter.bucketId !== undefined ? String(initialFilter.bucketId) : '')
  const [tagFilter, setTagFilter] = useState('')
  // A Home drill's lines (linesFor), under its name, until cleared: the list is exactly them, at their own amounts.
  const [drill, setDrill] = useState(() => {
    const q = lineQuery(initialFilter, todayKey())
    return q ? { name: initialFilter.name ?? 'Lines', q } : null
  })
  // The drill's rows read so far, with the drill and the data change they were read at.
  const [linePage, setLinePage] = useState<{ drill: NonNullable<typeof drill>; tick: number; rows: DrillRows } | null>(null)
  const lastPage = useRef(linePage)
  lastPage.current = linePage
  const [tags, setTags] = useState<TagCount[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [remember, setRemember] = useState(true)
  const [limit, setLimit] = useState(PAGE)
  const [data, setData] = useState<TxnPage | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [onAssets, setOnAssets] = useState<LineAsset[]>([])

  useEffect(() => {
    const h = setTimeout(() => setDebounced(search), 250)
    return () => clearTimeout(h)
  }, [search])

  const query = useMemo<TxnQuery>(
    () => ({
      search: debounced || undefined,
      accountId: accountId || undefined,
      categoryId: categoryFilter === 'none' ? 'none' : categoryFilter ? Number(categoryFilter) : undefined,
      bucketId: bucketFilter === 'personal' ? 'personal' : bucketFilter ? Number(bucketFilter) : undefined,
      tag: tagFilter || undefined,
      ...rangeToQuery(range),
      limit
    }),
    [debounced, accountId, categoryFilter, bucketFilter, tagFilter, range, limit]
  )

  useEffect(() => {
    if (drill) return
    api.listTransactions(query).then(setData, (e) => toast(errorMessage(e), 'error'))
  }, [drill, query, tick, toast])

  // A drill's lines, then the transactions they're on, for their payees, categories and accounts: Show more reads on
  // from the lines shown, past linesFor's 1,000 a call, and a new drill or a data change reads them afresh. An answer
  // for an earlier ask is dropped.
  useEffect(() => {
    if (!drill) {
      setLinePage(null)
      return
    }
    let current = true
    const was = lastPage.current
    drillRows(api.linesFor, api.listTransactions, drill.q, was && was.drill === drill && was.tick === tick ? was.rows : null, limit)
      .then((rows) => current && setLinePage({ drill, tick, rows }))
      .catch((e) => current && toast(errorMessage(e), 'error'))
    return () => {
      current = false
    }
  }, [drill, limit, tick, toast])

  // The rows shown: the transactions, or under a drill each line on its transaction, at the line's amount.
  const drilled = drill && linePage?.drill === drill ? linePage.rows : null
  const shown = useMemo<Shown[]>(() => {
    if (drill) return (drilled?.lines ?? []).flatMap((l) => (drilled!.txns.has(l.txnId) ? [{ key: l.key, t: drilled!.txns.get(l.txnId)!, cents: l.cents, line: l }] : []))
    return (data?.rows ?? []).map((t) => ({ key: t.id, t, cents: t.amountCents, line: null }))
  }, [drill, drilled, data])
  const listed = drill ? (drilled ? { total: drilled.total, cents: drilled.cents } : null) : data ? { total: data.total, cents: data.sumCents } : null

  useEffect(() => {
    api.listAccounts().then(setAccounts, () => {})
  }, [tick])

  // Which of the shown lines are an asset's costs, and Personal's share of each; an answer for an earlier page is dropped.
  const shownIds = useMemo(() => [...new Set(shown.map((r) => r.t.id))].join('\n'), [shown])
  useEffect(() => {
    let current = true
    if (!shownIds) setOnAssets([])
    else api.lineAssets(shownIds.split('\n')).then((list) => current && setOnAssets(list), () => current && setOnAssets([]))
    return () => {
      current = false
    }
  }, [shownIds, tick])
  const labels = useMemo(() => assetLabels(onAssets, accounts), [onAssets, accounts])

  useEffect(() => {
    api.listTags().then((list) => {
      setTags(list)
      // A tag that's no longer on anything stops filtering.
      setTagFilter((f) => (f && !list.some((g) => g.tag.toLowerCase() === f.toLowerCase()) ? '' : f))
    }, () => {})
  }, [tick])

  useEffect(() => setLimit(PAGE), [debounced, accountId, categoryFilter, bucketFilter, tagFilter, drill, range])

  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => shiftMonth(currentMonth(), -i)), [])
  // A span or an older month opened from Home gets its own entry.
  const extraRange = useMemo(() => {
    if (range.startsWith('s:')) {
      const [from, to] = range.slice(2).split(':')
      return { value: range, label: spanLabel(from, to) }
    }
    if (range.startsWith('d:')) {
      const [from, to] = range.slice(2).split(':')
      return { value: range, label: daysLabel(from, to) }
    }
    if (range.startsWith('m:') && !months.includes(range.slice(2))) return { value: range, label: monthLabel(range.slice(2)) }
    return null
  }, [range, months])

  /** A change shown at once, on the list's transactions and on a drill's. */
  const patch = (id: string, p: Partial<Transaction>): void => {
    setData((d) => d && { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, ...p } : r)) })
    setLinePage((l) => {
      const t = l?.rows.txns.get(id)
      return l && t ? { ...l, rows: { ...l.rows, txns: new Map(l.rows.txns).set(id, { ...t, ...p }) } } : l
    })
  }

  async function changeCategory(t: Transaction, categoryId: number | null): Promise<void> {
    patch(t.id, { categoryId, categorySource: categoryId === null ? null : 'user', confidence: null })
    try {
      const r = await api.updateTransaction(t.id, { categoryId, remember: remember && categoryId !== null })
      if (r.alsoUpdated > 0) toast(`Saved as a rule — also updated ${r.alsoUpdated} similar transaction${r.alsoUpdated === 1 ? '' : 's'}.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function changeBucket(t: Transaction, bucketId: number | null): Promise<void> {
    patch(t.id, { bucketId })
    try {
      await api.updateTransaction(t.id, { bucketId })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function remove(t: Transaction): Promise<void> {
    if (!confirm(`Delete ${fmtMoney(t.amountCents)} ${t.merchant ?? t.description} on ${fmtDate(t.posted)}?`)) return
    try {
      await api.deleteTransaction(t.id)
      setData((d) => d && { ...d, rows: d.rows.filter((r) => r.id !== t.id), total: d.total - 1, sumCents: d.sumCents - t.amountCents })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function moveShown(value: string): Promise<void> {
    if (!value) return
    const bucketId = value === 'personal' ? null : Number(value)
    const ids = [...new Set(shown.filter((r) => r.t.bucketId !== bucketId).map((r) => r.t.id))]
    if (!ids.length) return
    const name = bucketId === null ? 'Personal' : (buckets.find((b) => b.id === bucketId)?.name ?? '')
    if (!confirm(`Move ${ids.length} shown transaction${ids.length === 1 ? '' : 's'} to ${name}?`)) return
    try {
      await api.setTransactionsBucket(ids, bucketId)
      toast(`Moved ${ids.length} to ${name}`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const filtered = !!(debounced || accountId || categoryFilter || bucketFilter || tagFilter || drill || range !== 'all')
  // Nothing imported yet (as opposed to nothing matching the filters).
  const blank = !drill && data?.total === 0 && !filtered

  return (
    <>
      <PageHeader title="Transactions">
        <button className="btn" onClick={() => api.exportCsv().then((p) => p && toast(`Exported to ${p}`), (e) => toast(errorMessage(e), 'error'))}>
          <Icon name="download" size={15} /> Export CSV
        </button>
        <button className="btn primary" disabled={!!classifying} onClick={() => void runClassify()}>
          <Icon name="sparkle" size={15} /> {classifying ? `Categorizing… ${classifying.total ? `${classifying.done}/${classifying.total}` : ''}` : settings?.aiEnabled === false ? 'Categorize' : 'Categorize with AI'}
        </button>
      </PageHeader>

      <div className="page">
      <div className="toolbar">
        {drill ? (
          // A drill's lines are the list until the chip clears it; its days and category stay as the list's filters.
          <button className="chip active" aria-label={`${drill.name}: show every transaction`} onClick={() => setDrill(null)}>
            {drill.name} · {drillDays(drill.q)} <Icon name="x" size={11} />
          </button>
        ) : (
          <>
        <input className="input" type="search" placeholder="Search merchant, description, notes…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="select" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range">
          <option value="all">All dates</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          {extraRange && <option value={extraRange.value}>{extraRange.label}</option>}
          {months.map((m) => (
            <option key={m} value={`m:${m}`}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
        <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className="select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="Category filter">
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {buckets.length > 0 && (
          <select className="select" value={bucketFilter} onChange={(e) => setBucketFilter(e.target.value)} aria-label="Venture filter">
            <option value="">Personal and ventures</option>
            <option value="personal">Personal</option>
            {buckets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        {tags.length > 0 && (
          <select className="select" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Tag filter">
            <option value="">All tags</option>
            {tags.map((g) => (
              <option key={g.tag} value={g.tag}>
                {g.tag}
              </option>
            ))}
          </select>
        )}
          </>
        )}
        <datalist id="tag-options">
          {tags.map((g) => (
            <option key={g.tag} value={g.tag} />
          ))}
        </datalist>
        <div className="spacer" style={{ flex: 1 }} />
        {buckets.length > 0 && filtered && listed && shown.length > 0 && (
          <select className="select" value="" onChange={(e) => void moveShown(e.target.value)} aria-label="Move shown transactions to a venture">
            <option value="">Move {shown.length < listed.total ? `${shown.length} shown` : 'all'} to…</option>
            <option value="personal">Personal</option>
            {buckets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <label className="check small" title="When you change a category, remember it for this merchant and update similar transactions">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember my changes
        </label>
      </div>

      {listed && !blank && (
        <div className="label-muted" style={{ marginBottom: 12 }}>
          {listed.total.toLocaleString()} {drill ? 'line' : 'transaction'}
          {listed.total === 1 ? '' : 's'} · net {fmtMoney(listed.cents)}
        </div>
      )}

      {blank && (
        <EmptyCard>
          <ImportCsvButton className="btn primary" />
        </EmptyCard>
      )}

      <div className="table-wrap" hidden={blank}>
        <table className="txns">
          {/* Column widths are in styles.css (.txns col), narrower in a narrow window, where the account moves under the merchant. */}
          <colgroup>
            <col className="c-date" />
            <col />
            <col className="c-category" />
            {buckets.length > 0 && <col className="c-bucket" />}
            <col className="c-account" />
            <col className="c-amount" />
            <col className="c-delete" />
          </colgroup>
          <thead>
            <tr>
              <th>Date</th>
              <th>Merchant</th>
              <th>Category</th>
              {buckets.length > 0 && <th>Venture</th>}
              <th className="c-account">Account</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map(({ key, t, cents, line }) => (
              <Fragment key={key}>
                <tr className={open === key ? 'txn-open' : undefined}>
                  <td className="txn-date">{fmtDate(t.posted)}</td>
                  <td>
                    <div className="txn-merchant truncate" title={t.merchant ?? t.description}>
                      {t.merchant ?? t.description}
                    </div>
                    {(t.merchant || t.pending) && (
                      <div className="txn-desc txn-name" title={t.description}>
                        {t.pending && <span className="tag pending">Pending</span>}
                        {t.merchant && <span className="truncate">{t.description}</span>}
                      </div>
                    )}
                    {labels.get(t.id) && (
                      <div className="txn-desc truncate" title={labels.get(t.id)!.row}>
                        {labels.get(t.id)!.row}
                      </div>
                    )}
                    <div className="txn-account txn-account-under truncate">{t.accountName}</div>
                    {/* A part of money with a venture: its intent, so a mixed line's parts tell apart. */}
                    {line && intentTag(line) && (
                      <div className="txn-tags">
                        <span className="tag txn-tag">{intentTag(line)}</span>
                      </div>
                    )}
                    {t.tags.length > 0 && (
                      <div className="txn-tags">
                        {t.tags.map((g) => (
                          <span className="tag txn-tag" key={g}>
                            {g}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    {t.splits.length ? (
                      <button className="btn small ghost split-btn" onClick={() => setOpen(open === key ? null : key)}>
                        Split · {t.splits.length}
                      </button>
                    ) : (
                      <div className="cat-cell">
                        <CategorySelect categories={categories} value={t.categoryId} onChange={(id) => void changeCategory(t, id)} />
                        <SourceTag t={t} />
                      </div>
                    )}
                  </td>
                  {buckets.length > 0 && (
                    <td>
                      {t.splits.length ? (
                        <span className="txn-account">Split</span>
                      ) : (
                        <div className="cat-cell">
                          <BucketSelect buckets={buckets} value={t.bucketId} onChange={(id) => void changeBucket(t, id)} />
                        </div>
                      )}
                    </td>
                  )}
                  <td className="txn-account c-account truncate" title={t.accountName}>
                    {t.accountName}
                  </td>
                  {/* A drill's line at its own amount: a loan payment's interest, a part of a split, an owner's share. */}
                  <td className={`num ${cents > 0 ? 'pos' : ''}`} title={line && line.cents !== t.amountCents ? `of ${fmtMoney(t.amountCents)}` : undefined}>
                    {cents > 0 ? `+${fmtMoney(cents)}` : fmtMoney(cents)}
                  </td>
                  <td>
                    <div className="txn-actions">
                      <button className={`btn small ghost icon-btn txn-expand ${open === key ? 'open' : ''}`} aria-label="Tags and split" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                        <Icon name="chevronRight" size={13} />
                      </button>
                      {deletable(t) && (
                        <button className="btn small ghost icon-btn danger txn-delete" aria-label="Delete transaction" onClick={() => void remove(t)}>
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {open === key && (
                  <tr className="txn-detail">
                    <td colSpan={buckets.length > 0 ? 7 : 6}>
                      <TxnDetail t={t} assets={labels.get(t.id)?.parts} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {listed && shown.length === 0 && (
              <tr>
                <td colSpan={buckets.length > 0 ? 7 : 6} className="empty">
                  No transactions match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {listed && shown.length < listed.total && (
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({(listed.total - shown.length).toLocaleString()} left)
          </button>
        </div>
      )}
    </div>
    </>
  )
}
