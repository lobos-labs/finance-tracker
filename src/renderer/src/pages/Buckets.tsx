import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Account, Bucket, BucketDetail, BucketKind, BucketRule, VentureResult } from '../../../shared/types'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, errorMessage, fmtDay, fmtMinus, fmtMoney, fmtMoneyRound, fmtSigned, todayKey } from '../lib'
import { parseAmount } from '../../../shared/parse'
import { VentureOwner } from './VentureOwner'
import { ownerBlock, shareShort } from './ventureView'

export const BUCKET_KINDS: Array<{ id: BucketKind; label: string }> = [
  { id: 'rental', label: 'Rental' },
  { id: 'business', label: 'Business' },
  { id: 'person', label: 'Person' },
  { id: 'other', label: 'Other' }
]

const kindLabel = (k: BucketKind): string => BUCKET_KINDS.find((x) => x.id === k)?.label ?? k

const tone = (cents: number | null): string => (cents === null ? '' : cents >= 0 ? 'pos' : 'neg')

function span(b: Bucket): string {
  if (b.firstPosted === null || b.lastPosted === null) return '—'
  const y = (u: number): string => new Date(u * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  return `${y(b.firstPosted)} – ${y(b.lastPosted)}`
}

/** `request`: a venture to open on, as a venture's row on Net worth asks for it. */
export default function Buckets({ request }: { request?: { id: number; n: number } | null }): ReactNode {
  const { buckets } = useApp()
  const [selected, setSelected] = useState<number | null>(request?.id ?? null)
  useEffect(() => {
    if (request) setSelected(request.id)
  }, [request])
  const [adding, setAdding] = useState(false)

  if (selected !== null && buckets.some((b) => b.id === selected)) return <BucketPage id={selected} onBack={() => setSelected(null)} />

  return (
    <>
      <PageHeader title="Ventures">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> New venture
        </button>
      </PageHeader>
      <div className="page">
        {buckets.length === 0 ? (
          <div className="card empty">
            <div className="muted">No ventures</div>
          </div>
        ) : (
          <div className="asset-table bucket-table" role="table">
            <div className="asset-row head" role="row">
              <span>Venture</span>
              <span>Dates</span>
              <span className="num">Transactions</span>
              <span className="num">Operating</span>
              <span className="num">Gains</span>
              <span className="num">Total</span>
              <span className="num">Position</span>
            </div>
            {buckets.map((b) => (
              <button key={b.id} className="asset-row" role="row" onClick={() => setSelected(b.id)}>
                <span className="bucket-name" title={b.name}>
                  <span className="truncate">{b.name}</span>
                  <span className="tag">{kindLabel(b.kind)}</span>
                  <span className="tag">{shareShort(b.shareBp)}</span>
                </span>
                <span className="mono small muted">{span(b)}</span>
                <span className="num">{b.txnCount.toLocaleString()}</span>
                <span className={`num ${tone(b.operatingCents)}`}>{fmtSigned(b.operatingCents)}</span>
                <span className={`num ${b.gainsCents ? tone(b.gainsCents) : ''}`}>{b.gainsCents ? fmtSigned(b.gainsCents) : '—'}</span>
                <span className={`num ${tone(b.totalCents)}`}>{fmtSigned(b.totalCents)}</span>
                <span className="num">{fmtMinus(b.positionCents)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {adding && (
        <BucketModal
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false)
            setSelected(id)
          }}
        />
      )}
    </>
  )
}

// ---------- one bucket ----------

function BucketPage({ id, onBack }: { id: number; onBack: () => void }): ReactNode {
  const { tick, toast, go } = useApp()
  const [d, setD] = useState<BucketDetail | null>(null)
  const [editing, setEditing] = useState(false)
  // Every account, read once for the page: the owner money's and Personal use's names, and what can be added.
  const [accounts, setAccounts] = useState<Account[]>([])

  useEffect(() => {
    api.getBucket(id).then(setD, (e) => toast(errorMessage(e), 'error'))
  }, [id, tick, toast])
  useEffect(() => {
    api.listAccounts().then(setAccounts, () => {})
  }, [tick])

  if (!d) return <PageHeader title="Venture" />
  const b = d.bucket
  const r = d.result
  const known = r.assets.filter((a) => a.gainCents !== null)
  const gainsCents = r.realizedCents + r.onPaperCents
  const gainParts = [known.some((a) => a.sold) && `${fmtSigned(r.realizedCents)} realized`, known.some((a) => !a.sold) && `${fmtSigned(r.onPaperCents)} on paper`].filter(Boolean).join(' · ')

  async function remove(): Promise<void> {
    if (!confirm(`Delete the "${b.name}" venture? Its ${b.txnCount} transactions go back to Personal.`)) return
    try {
      await api.deleteBucket(b.id)
      onBack()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <>
      <PageHeader title={b.name}>
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevronLeft" size={15} /> Ventures
        </button>
        <button className="btn" onClick={() => go('transactions', { bucketId: b.id })}>
          <Icon name="list" size={15} /> Transactions
        </button>
        <button className="btn" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="btn ghost danger icon-btn" title="Delete venture" aria-label="Delete venture" onClick={() => void remove()}>
          <Icon name="trash" size={15} />
        </button>
      </PageHeader>
      <div className="page">
        {b.description && <p className="muted bucket-desc">{b.description}</p>}
        <OwnerMoney detail={d} accounts={accounts} />
        <section className="stat-strip even">
          <Tile label="Operating" value={fmtSigned(r.operatingCents)} tone={r.operatingCents >= 0 ? 'good' : 'bad'} sub={`${fmtMoneyRound(r.inCents)} in · ${fmtMoneyRound(r.outCents)} out`} />
          <Tile label="Gains" value={known.length ? fmtSigned(gainsCents) : '—'} tone={known.length ? (gainsCents >= 0 ? 'good' : 'bad') : undefined} sub={gainParts || undefined} />
          <Tile label="Total" value={fmtSigned(r.totalCents)} tone={r.totalCents >= 0 ? 'good' : 'bad'} />
          <Tile label="Transactions" value={b.txnCount.toLocaleString()} sub={span(b)} />
        </section>

        {r.assets.length > 0 && <VentureAssets r={r} />}
        {r.personalUse.length > 0 && <PersonalUse r={r} accounts={accounts} />}

        <div className="grid-2" style={{ marginTop: 16 }}>
          <Operating r={r} />
          <div className="card">
            <h2>By year</h2>
            <MoneyTable rows={d.byYear.map((r) => ({ key: r.year, label: r.year, ...r }))} total />
          </div>
        </div>

        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="card">
            <h2>Top payees</h2>
            <MoneyTable rows={d.topPayees.map((r) => ({ key: r.name, label: r.name, ...r }))} />
          </div>
          <div className="card">
            <h2>By category</h2>
            <MoneyTable rows={d.byCategory.map((r) => ({ key: r.name, label: r.name, ...r }))} />
          </div>
        </div>

        <div className="grid-2" style={{ marginTop: 16 }}>
          <BucketAccounts detail={d} all={accounts} />
          <BucketRules detail={d} accounts={accounts} />
        </div>
      </div>
      {editing && <BucketModal bucket={b} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
    </>
  )
}

/**
 * The money between Personal and the venture (waterfall spec addendum 1.11): the share, basis, stake and position,
 * the shares, the owner money and the boundary lines, each line opening Transactions on its own parts.
 */
function OwnerMoney({ detail, accounts }: { detail: BucketDetail; accounts: Account[] }): ReactNode {
  const { go } = useApp()
  const b = detail.bucket
  const name = (id: string): string => accounts.find((a) => a.id === id)?.name ?? ''
  const block = ownerBlock(detail.result.owner, name, todayKey())
  return (
    <VentureOwner
      block={block}
      onLine={(l) => go('transactions', { ventureId: b.id, ids: [l.txnId], fromDay: l.day, toDay: l.day, name: b.name })}
      onUnset={() => go('transactions', { ventureId: b.id, intent: 'unset', name: `${b.name} · Unset` })}
      onMore={() => go('transactions', { ventureId: b.id, name: b.name })}
    />
  )
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }): ReactNode {
  return (
    <div className="tile">
      <div className="label-muted">{label}</div>
      <div className={`tile-value ${tone ?? ''}`}>{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  )
}

/** "Mar 5 – Dec 21, 2022", or "Dec 18, 2020 – Mar 8, 2022" across years. */
function dayRange(from: string, to: string): string {
  const short = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return from.slice(0, 4) === to.slice(0, 4) ? `${short(from)} – ${fmtDay(to)}` : `${fmtDay(from)} – ${fmtDay(to)}`
}

function Line({ label, value, cls = '', cents }: { label: string; value: string; cls?: string; cents?: number | null }): ReactNode {
  const tone = cents === undefined || cents === null ? '' : cents >= 0 ? 'pos' : 'neg'
  return (
    <div className={`money-row pair ${cls}`}>
      <span className="truncate">{label}</span>
      <span className={`num ${tone}`}>{value}</span>
    </div>
  )
}

function Operating({ r }: { r: VentureResult }): ReactNode {
  const leftOut = [
    ['Purchase', r.purchaseCents],
    ['Sale proceeds', r.proceedsCents],
    ['Lent', r.lentCents],
    ['Paid back', r.repaidCents],
    ['Equity paid down', r.principalCents]
  ] as const
  return (
    <div className="card">
      <h2>Operating</h2>
      <div className="money-table">
        <Line label="Money in" value={fmtMoneyRound(r.inCents)} />
        <Line label="Money out" value={fmtMoneyRound(r.outCents)} />
        <Line label="Operating" value={fmtSigned(r.operatingCents)} cls="total" cents={r.operatingCents} />
        {leftOut.some(([, c]) => c !== 0) && <div className="money-row pair head">Left out</div>}
        {leftOut
          .filter(([, c]) => c !== 0)
          .map(([label, c]) => (
            <Line key={label} label={label} value={fmtMoneyRound(c)} cls="muted" />
          ))}
      </div>
    </div>
  )
}

/**
 * Personal's use of the places the venture owns or uses with Personal, a line per use: the place (a venture's
 * residence dates with no house yet have none), its days, Personal's share, and Personal's part of the costs the
 * use shared then, which operating leaves out.
 */
function PersonalUse({ r, accounts }: { r: VentureResult; accounts: Account[] }): ReactNode {
  const place = (id: string | null): string => (id === null ? 'Residence' : (accounts.find((a) => a.id === id)?.name ?? ''))
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Personal use</h2>
      <div className="money-table">
        <div className="money-row personal-use head">
          <span />
          <span>Dates</span>
          <span className="num">Share</span>
          <span className="num">Personal</span>
        </div>
        {r.personalUse.map((u) => (
          <div className="money-row personal-use" key={`${u.assetId ?? ''}|${u.fromDay}`}>
            <span className="truncate" title={place(u.assetId)}>
              {place(u.assetId)}
            </span>
            <span className="mono small">{dayRange(u.fromDay, u.toDay)}</span>
            <span className="num">{u.personalBp / 100}%</span>
            <span className={`num ${tone(u.cents)}`}>{fmtSigned(u.cents)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Each asset in the venture against its cost: realized once sold, on paper while owned. */
function VentureAssets({ r }: { r: VentureResult }): ReactNode {
  const amount = (c: number | null): string => (c === null ? '—' : fmtMoneyRound(c))
  const known = r.assets.filter((a) => a.gainCents !== null)
  const gains = r.realizedCents + r.onPaperCents
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Assets</h2>
      <div className="money-table">
        <div className="money-row venture-asset head">
          <span />
          <span>Bought</span>
          <span>Sold</span>
          <span className="num">Cost</span>
          <span className="num">Value</span>
          <span className="num">Selling costs</span>
          <span className="num">Gain</span>
        </div>
        {r.assets.map((a) => (
          <div className="money-row venture-asset" key={a.id}>
            <span className="truncate" title={a.name}>
              {a.name}
            </span>
            <span className="mono small">{a.boughtDay ? fmtDay(a.boughtDay) : '—'}</span>
            <span className="mono small">{a.soldDay ? fmtDay(a.soldDay) : 'Owned'}</span>
            <span className="num">{amount(a.costCents)}</span>
            <span className="num">
              {fmtMoneyRound(a.valueCents)}
              {!!a.repaidCents && <span className="label-muted venture-gain-kind">{fmtMoneyRound(a.repaidCents)} paid back</span>}
            </span>
            <span className="num">{a.sold ? amount(a.saleCostsCents) : '—'}</span>
            <span className="num">
              <span className={tone(a.gainCents)}>{a.gainCents === null ? '—' : fmtSigned(a.gainCents)}</span>
              <span className="label-muted venture-gain-kind">{a.sold ? 'Realized' : 'On paper'}</span>
            </span>
          </div>
        ))}
        {r.assets.length > 1 && (
          <div className="money-row venture-asset total">
            <span>Gains</span>
            <span />
            <span />
            <span />
            <span />
            <span />
            <span className={`num ${known.length ? tone(gains) : ''}`}>{known.length ? fmtSigned(gains) : '—'}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function MoneyTable({ rows, total }: { rows: Array<{ key: string; label: string; inCents: number; outCents: number; count?: number }>; total?: boolean }): ReactNode {
  if (!rows.length) return <div className="muted small">None</div>
  const sum = rows.reduce((s, r) => ({ inCents: s.inCents + r.inCents, outCents: s.outCents + r.outCents }), { inCents: 0, outCents: 0 })
  const line = (key: string, label: ReactNode, r: { inCents: number; outCents: number; count?: number }, cls = ''): ReactNode => {
    const net = r.inCents - r.outCents
    return (
      <div className={`money-row ${cls}`} key={key}>
        <span className="truncate" title={typeof label === 'string' ? label : undefined}>
          {label}
          {r.count !== undefined && <span className="mono muted small"> · {r.count}</span>}
        </span>
        <span className="num">{r.inCents ? fmtMoneyRound(r.inCents) : '—'}</span>
        <span className="num">{r.outCents ? fmtMoneyRound(r.outCents) : '—'}</span>
        <span className={`num ${net >= 0 ? 'pos' : 'neg'}`}>{fmtSigned(net)}</span>
      </div>
    )
  }
  return (
    <div className="money-table">
      <div className="money-row head">
        <span />
        <span className="num">In</span>
        <span className="num">Out</span>
        <span className="num">Net</span>
      </div>
      {rows.map((r) => line(r.key, r.label, r))}
      {total && rows.length > 1 && line('total', 'Total', sum, 'total')}
    </div>
  )
}

function BucketAccounts({ detail, all }: { detail: BucketDetail; all: Account[] }): ReactNode {
  const { toast } = useApp()
  const [pick, setPick] = useState('')
  const own = new Set(detail.accounts.map((a) => a.id))
  const choices = all.filter((a) => !own.has(a.id) && a.bucketId === null && !a.linkedAssetId)

  async function set(accountId: string, bucketId: number | null): Promise<void> {
    try {
      await api.updateAccount(accountId, { bucketId })
      setPick('')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="card">
      <h2>Accounts and assets</h2>
      {detail.accounts.length === 0 && <div className="muted small">None</div>}
      {detail.accounts.map((a) => (
        <div className="list-row small" key={a.id}>
          <div className="grow truncate">
            {a.name}
            {a.linkedAssetId && <span className="muted"> · loan</span>}
            {a.closedDay && <span className="muted"> · closed {a.closedDay.slice(0, 4)}</span>}
          </div>
          <div className="num">{a.balanceCents === null ? '—' : fmtMoneyRound(a.balanceCents)}</div>
          {a.bucketId === detail.bucket.id ? (
            <button className="btn small ghost" onClick={() => void set(a.id, null)}>
              Remove
            </button>
          ) : (
            <span style={{ width: 66, flex: 'none' }} />
          )}
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <select className="select" value={pick} aria-label="Account to add" onChange={(e) => setPick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
          <option value="">Add an account or asset…</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!pick} onClick={() => void set(pick, detail.bucket.id)}>
          Add
        </button>
      </div>
    </div>
  )
}

function BucketRules({ detail, accounts }: { detail: BucketDetail; accounts: Account[] }): ReactNode {
  const { toast } = useApp()
  const [f, setF] = useState({ accountId: '', contains: '', amount: '', fromDay: '', toDay: '' })
  // An account's auto rule is the account being in the venture: it shows under Accounts and assets.
  const rules = detail.rules.filter((r) => !r.auto)

  async function add(): Promise<void> {
    try {
      const amount = f.amount.trim() ? parseAmount(f.amount) : null
      if (f.amount.trim() && amount === null) throw new Error(`Couldn't read "${f.amount}" as an amount`)
      await api.addBucketRule({ bucketId: detail.bucket.id, accountId: f.accountId || null, contains: f.contains || null, amountCents: amount === null ? null : Math.abs(amount), fromDay: f.fromDay || null, toDay: f.toDay || null })
      setF({ accountId: '', contains: '', amount: '', fromDay: '', toDay: '' })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="card">
      <h2>Rules</h2>
      {rules.length === 0 && <div className="muted small">None</div>}
      {rules.map((r) => (
        <div className="list-row small" key={r.id}>
          <div className="grow truncate">
            <RuleText rule={r} />
          </div>
          <button className="btn small ghost icon-btn" title="Delete rule" aria-label="Delete rule" onClick={() => void api.deleteBucketRule(r.id).catch((e) => toast(errorMessage(e), 'error'))}>
            <Icon name="x" size={12} strokeWidth={2.2} />
          </button>
        </div>
      ))}
      <div className="field-grid" style={{ marginTop: 12 }}>
        <label className="field">
          Account
          <select className="select" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
            <option value="">Any</option>
            {accounts
              .filter((a) => a.txnCount > 0)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Description contains
          <input className="input" value={f.contains} onChange={(e) => setF({ ...f, contains: e.target.value })} />
        </label>
        <label className="field">
          Exact amount
          <input className="input num" value={f.amount} placeholder="Any" onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          From
          <input className="input" type="date" value={f.fromDay} onChange={(e) => setF({ ...f, fromDay: e.target.value })} />
        </label>
        <label className="field">
          To
          <input className="input" type="date" value={f.toDay} onChange={(e) => setF({ ...f, toDay: e.target.value })} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn" disabled={!f.accountId && !f.contains.trim()} onClick={() => void add()}>
          Add rule
        </button>
      </div>
    </div>
  )
}

/** What a rule matches: its account, category, text and amount, and its dates. */
export function RuleText({ rule: r }: { rule: BucketRule }): ReactNode {
  return (
    <>
      {[r.accountName, r.categoryName, r.contains && `“${r.contains}”`, r.amountCents !== null && fmtMoney(r.amountCents)].filter(Boolean).join(' · ')}
      {(r.fromDay || r.toDay) && (
        <span className="mono muted">
          {' '}
          · {r.fromDay ?? '…'} → {r.toDay ?? '…'}
        </span>
      )}
    </>
  )
}

// ---------- add / edit ----------

function BucketModal({ bucket, onClose, onSaved }: { bucket?: Bucket; onClose: () => void; onSaved: (id: number) => void }): ReactNode {
  const { toast } = useApp()
  const initial = useMemo(
    () => ({
      name: bucket?.name ?? '',
      kind: bucket?.kind ?? ('business' as BucketKind),
      description: bucket?.description ?? ''
    }),
    [bucket]
  )
  const [f, setF] = useState(initial)
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      onSaved(await api.saveBucket({ id: bucket?.id, ...f }))
    } catch (e) {
      toast(errorMessage(e), 'error')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="bucket-title">
        <h2 id="bucket-title">{bucket ? 'Edit venture' : 'New venture'}</h2>
        <div className="field-grid" style={{ marginTop: 16 }}>
          <label className="field">
            Name
            <input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            Kind
            <select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as BucketKind })}>
              {BUCKET_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field" style={{ marginTop: 14 }}>
          Notes
          <textarea className="textarea" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <div className="modal-actions">
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={() => void submit()}>
            {bucket ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** "Personal" or the bucket's name. */
export function bucketName(buckets: Bucket[], id: number | null): string {
  return id === null ? 'Personal' : (buckets.find((b) => b.id === id)?.name ?? 'Personal')
}
