import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ASSET_TYPES, isDebtType, type Account, type AssetHistory, type AssetSummary, type AssetType, type AssetUse, type BalancePoint, type BucketRule, type CarryingCost, type ValueLookup } from '../../../shared/types'
import { parseAmount } from '../../../shared/parse'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, dateTicks, errorMessage, fmtDay, fmtMoney, fmtMoneyCompact, fmtMoneyRound, fmtSigned, todayKey } from '../lib'
import { EmptyCard } from '../Empty'
import { bucketName, RuleText } from './Buckets'

const MONO = "'JetBrains Mono Variable', ui-monospace, monospace"

/** What a manually valued asset can be. */
const CATEGORIES: Array<{ type: AssetType; label: string }> = [
  { type: 'property', label: 'Real estate' },
  { type: 'vehicle', label: 'Vehicle' },
  { type: 'other_asset', label: 'Valuables and other' },
  { type: 'venture', label: 'Stake in a business' },
  { type: 'receivable', label: 'Money owed to you' }
]

/** The Property view's groups: stakes sit with investments, money owed to you on the overview. */
const GROUPS: Array<{ type: AssetType; label: string }> = [
  { type: 'property', label: 'Real estate' },
  { type: 'vehicle', label: 'Vehicles' },
  { type: 'other_asset', label: 'Other' }
]

/** How an asset's dates and cost are worded: businesses start and close rather than being bought and sold. */
function words(t: AssetType): { opened: string; closed: string; cost: string; costHint: string; notesHint: string } {
  if (t === 'venture') return { opened: 'Started', closed: 'Closed', cost: 'Put in', costHint: 'Money put into it', notesHint: 'Ownership, partners' }
  if (t === 'receivable') return { opened: 'Lent', closed: 'Repaid', cost: 'Amount lent', costHint: 'Total lent', notesHint: 'Who, terms, payments' }
  return { opened: 'Purchased', closed: 'Sold', cost: 'Cost', costHint: 'Purchase price + improvements', notesHint: 'Address, VIN, serial numbers' }
}

/** What closing an asset brought: its sale price, a stake's value at close, what a loan was paid back. */
const closeLabel = (t: AssetType): string => (t === 'venture' ? 'Value at close' : t === 'receivable' ? 'Paid back' : 'Sale price')

/** Assets valued by estimate that the web lookup and linked loans don't apply to. */
const notProperty = (t: AssetType): boolean => t === 'venture' || t === 'receivable'

const gainPct = (gain: number, cost: number): string => `${gain >= 0 ? '+' : '−'}${Math.abs((gain / cost) * 100).toFixed(1)}%`

/** The Net worth tab's Property view; opening an asset shows its detail (onOpen). */
export default function Property({ layout, onOpen, onAdd }: { layout: 'cards' | 'list'; onOpen: (id: string) => void; onAdd: () => void }): ReactNode {
  const { tick, toast } = useApp()
  const [assets, setAssets] = useState<AssetSummary[] | null>(null)

  useEffect(() => {
    api.listAssets().then(setAssets, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  const property = (assets ?? []).filter((a) => GROUPS.some((g) => g.type === a.account.assetType))
  const owned = property.filter((a) => !a.sold && !a.account.hidden)
  const totals = owned.reduce(
    (t, a) => ({ value: t.value + a.valueCents, owed: t.owed + a.owedCents, gain: t.gain + (a.gainCents ?? 0), hasGain: t.hasGain || a.gainCents !== null }),
    { value: 0, owed: 0, gain: 0, hasGain: false }
  )

  return (
    <div className="page">
      {assets && property.length === 0 && (
        <EmptyCard label="No property">
          <button className="btn primary" onClick={onAdd}>
            <Icon name="plus" size={15} /> Add
          </button>
        </EmptyCard>
      )}
      {owned.length > 0 && (
        <section className="stat-strip even">
          <Tile label="Value" value={fmtMoneyRound(totals.value)} />
          <Tile label="Owed against" value={totals.owed ? fmtMoneyRound(totals.owed) : '—'} />
          <Tile label="Equity" value={fmtMoneyRound(totals.value - totals.owed)} />
          <Tile label="Gain / loss" value={totals.hasGain ? fmtSigned(totals.gain) : '—'} tone={totals.hasGain ? (totals.gain >= 0 ? 'good' : 'bad') : undefined} />
        </section>
      )}
      {GROUPS.map((g) => {
        const items = property.filter((a) => a.account.assetType === g.type).sort((a, b) => Number(a.sold) - Number(b.sold) || b.valueCents - a.valueCents)
        if (!items.length) return null
        const held = items.filter((a) => !a.sold)
        const soldCount = items.length - held.length
        const equity = held.reduce((s, a) => s + a.equityCents, 0)
        return (
          <section className="asset-group" key={g.type}>
            <div className="asset-group-head">
              <h2>{g.label}</h2>
              <span className="label-muted">{[held.length ? `${held.length} · equity ${fmtMoneyRound(equity)}` : null, soldCount ? `${soldCount} ${words(g.type).closed.toLowerCase()}` : null].filter(Boolean).join(' · ')}</span>
            </div>
            {layout === 'cards' ? (
              <div className="asset-grid">
                {items.map((a) => (
                  <AssetCard key={a.account.id} a={a} onOpen={() => onOpen(a.account.id)} />
                ))}
              </div>
            ) : (
              <div className="asset-table" role="table">
                <div className="asset-row head" role="row">
                  <span>Name</span>
                  <span className="num">Value</span>
                  <span className="num">Owed</span>
                  <span className="num">Equity</span>
                  <span className="num">Cost</span>
                  <span className="num">Gain</span>
                </div>
                {items.map((a) => (
                  <button key={a.account.id} className={`asset-row ${a.sold ? 'sold' : ''}`} role="row" onClick={() => onOpen(a.account.id)} style={a.account.hidden ? { opacity: 0.55 } : undefined}>
                    <span className="truncate">
                      {a.account.name}
                      {a.sold && <span className="tag" style={{ marginLeft: 8 }}>{words(a.account.assetType).closed} {a.account.closedDay!.slice(0, 4)}</span>}
                    </span>
                    <span className="num">{fmtMoneyRound(a.valueCents)}</span>
                    <span className="num">{a.owedCents ? fmtMoneyRound(a.owedCents) : '—'}</span>
                    <span className="num">{fmtMoneyRound(a.equityCents)}</span>
                    <span className="num">{a.account.costCents === null ? '—' : fmtMoneyRound(a.account.costCents)}</span>
                    <span className={`num ${a.gainCents === null ? '' : a.gainCents >= 0 ? 'pos' : 'neg'}`}>{a.gainCents === null ? '—' : fmtSigned(a.gainCents)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
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

function AssetCard({ a, onOpen }: { a: AssetSummary; onOpen: () => void }): ReactNode {
  const sub = a.account.details?.split('\n')[0] || a.account.institution || (a.account.openedDay ? `Since ${fmtDay(a.account.openedDay)}` : '')
  return (
    <button className={`asset-card ${a.sold ? 'sold' : ''}`} onClick={onOpen} style={a.account.hidden ? { opacity: 0.55 } : undefined}>
      <div className="asset-card-top">
        <span className="asset-name truncate">{a.account.name}</span>
        {a.sold && <span className="tag">{words(a.account.assetType).closed} {a.account.closedDay!.slice(0, 4)}</span>}
      </div>
      <div className="label-muted truncate">{sub || ' '}</div>
      <div className="asset-value">{fmtMoneyRound(a.valueCents)}</div>
      <div className="asset-figs">
        <Fig label="Owed" value={a.owedCents ? fmtMoneyRound(a.owedCents) : '—'} />
        <Fig label="Equity" value={fmtMoneyRound(a.equityCents)} />
        <Fig label="Gain" value={a.gainCents === null ? '—' : fmtSigned(a.gainCents)} tone={a.gainCents === null ? undefined : a.gainCents >= 0 ? 'pos' : 'neg'} />
      </div>
    </button>
  )
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }): ReactNode {
  return (
    <div>
      <div className="label-muted">{label}</div>
      <div className={`num ${tone ?? ''}`}>{value}</div>
    </div>
  )
}

// ---------- detail ----------

/** One asset: value and debt over time, its details, value history and loans. */
export function AssetDetail({ summary, onBack }: { summary: AssetSummary; onBack: () => void }): ReactNode {
  const { tick, toast } = useApp()
  const [valuing, setValuing] = useState(false)
  const a = summary.account
  const [history, setHistory] = useState<AssetHistory | null>(null)
  const [points, setPoints] = useState<BalancePoint[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [lookup, setLookup] = useState<ValueLookup | null>(null)
  const [cost, setCost] = useState<CarryingCost | null>(null)
  const [uses, setUses] = useState<AssetUse[]>([])
  const [rules, setRules] = useState<BucketRule[]>([])

  useEffect(() => {
    api.getAssetHistory(a.id).then(setHistory, (e) => toast(errorMessage(e), 'error'))
    api.listBalancePoints(a.id).then(setPoints, () => {})
    api.listAccounts().then(setAccounts, () => {})
    api.getValueLookup(a.id).then(setLookup, () => {})
    api.carryingCost(a.id).then(setCost, () => setCost(null))
    api.listUses(a.id).then(setUses, () => setUses([]))
    api.listAssetRules(a.id).then(setRules, () => setRules([]))
  }, [a.id, tick, toast])

  /** Whether the monthly web lookup covers this asset. */
  async function setLookupOn(on: boolean): Promise<void> {
    try {
      await api.setValueLookup(a.id, on)
      setLookup((l) => ({ enabled: on, lastLookup: l?.lastLookup ?? null }))
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function remove(): Promise<void> {
    if (!confirm(`Delete "${a.name}" and its value history? Linked loans are kept but unlinked.`)) return
    try {
      await api.deleteAccount(a.id)
      onBack()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function updateValue(): Promise<void> {
    setValuing(true)
    try {
      const v = await api.revalueAsset(a.id)
      toast(`${a.name}: ${fmtMoneyRound(v.valueCents)}`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setValuing(false)
    }
  }

  const held = a.openedDay ? yearsBetween(a.openedDay, summary.sold ? a.closedDay! : todayKey()) : null
  const w = words(a.assetType)

  return (
    <>
      <PageHeader title={a.name}>
        <button className="btn ghost" onClick={onBack}>
          <Icon name="chevronLeft" size={15} /> Net worth
        </button>
        {!summary.sold && !notProperty(a.assetType) && (
          <>
            <label className="check">
              <input type="checkbox" checked={lookup?.enabled ?? true} onChange={(e) => void setLookupOn(e.target.checked)} />
              Look up values
            </label>
            <button className="btn" disabled={valuing} onClick={() => void updateValue()}>
              <Icon name="refresh" size={15} className={valuing ? 'spin' : ''} /> {valuing ? 'Looking up…' : 'Update value'}
            </button>
          </>
        )}
        <button className="btn ghost danger icon-btn" title="Delete asset" aria-label="Delete asset" onClick={() => void remove()}>
          <Icon name="trash" size={15} />
        </button>
      </PageHeader>
      <div className="page">
        {a.assetType === 'receivable' ? (
          <section className="stat-strip" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <Tile label={summary.sold ? `${w.closed} · ${fmtDay(a.closedDay!)}` : 'Still owed to you'} value={fmtMoneyRound(summary.valueCents)} />
            <Tile label={w.cost} value={a.costCents === null ? '—' : fmtMoneyRound(a.costCents)} sub={a.openedDay ? `${w.opened} ${fmtDay(a.openedDay)}` : undefined} />
          </section>
        ) : (
        <section className="stat-strip five">
          <Tile label={summary.sold ? `${w.closed} · ${fmtDay(a.closedDay!)}` : 'Value'} value={fmtMoneyRound(summary.valueCents)} />
          <Tile label={summary.sold ? 'Paid off at sale' : 'Owed'} value={summary.owedCents ? fmtMoneyRound(summary.owedCents) : '—'} />
          <Tile label="Equity" value={fmtMoneyRound(summary.equityCents)} />
          <Tile label={w.cost} value={a.costCents === null ? '—' : fmtMoneyRound(a.costCents)} sub={a.openedDay ? `${w.opened} ${fmtDay(a.openedDay)}` : undefined} />
          <Tile
            label="Gain / loss"
            value={summary.gainCents === null ? '—' : fmtSigned(summary.gainCents)}
            sub={[summary.gainCents !== null && a.costCents ? gainPct(summary.gainCents, a.costCents) : null, held].filter(Boolean).join(' · ') || undefined}
            tone={summary.gainCents === null ? undefined : summary.gainCents >= 0 ? 'good' : 'bad'}
          />
        </section>
        )}

        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="card">
            <h2>Value and debt</h2>
            <HistoryChart history={history} />
            {summary.valuation && <ValuationNote v={summary.valuation} />}
          </div>
          <AssetFields account={a} points={points} />
        </div>

        <div className="grid-2" style={{ marginTop: 16 }}>
          <ValueHistory account={a} points={points} />
          {!notProperty(a.assetType) && <Loans summary={summary} accounts={accounts} />}
        </div>

        {((cost && cost.rows.length > 0) || uses.length > 0 || rules.length > 0) && (
          <div className="grid-2" style={{ marginTop: 16 }}>
            {cost && cost.rows.length > 0 ? <CarryingCostCard cost={cost} assetType={a.assetType} /> : <div />}
            {(uses.length > 0 || rules.length > 0) && (
              <div>
                {uses.length > 0 && <Uses uses={uses} />}
                {rules.length > 0 && <AssetRules rules={rules} />}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** A row's name: a mortgage's interest holds its escrow until the escrow is set; a car loan has none to speak of. */
function costLabel(r: CarryingCost['rows'][number], assetType: AssetType): string {
  if (r.kind === 'interest') return r.withEscrow && assetType === 'property' ? 'Interest + escrow' : 'Interest'
  return { escrow: 'Escrow', hoa: 'HOA', utilities: 'Utilities', insurance: 'Insurance', gas: 'Gas', repairs: 'Repairs', principal: 'Principal' }[r.kind]
}

/** A month's cost by row; with more than one owner bearing it, the total and then each owner's part, Personal first. */
function CarryingCostCard({ cost, assetType }: { cost: CarryingCost; assetType: AssetType }): ReactNode {
  const { buckets } = useApp()
  if (cost.owners.length < 2)
    return (
      <div className="card">
        <h2>Carrying cost / mo</h2>
        {cost.rows.map((r) => (
          <div className="list-row small" key={r.kind}>
            <div className="grow">{costLabel(r, assetType)}</div>
            <div className="num">{fmtMoneyRound(r.cents)}</div>
          </div>
        ))}
      </div>
    )
  const columns = `minmax(0, 1fr) repeat(${cost.owners.length + 1}, minmax(62px, 96px))`
  return (
    <div className="card">
      <h2>Carrying cost / mo</h2>
      <div className="money-table">
        <div className="money-row head carry-head" style={{ gridTemplateColumns: columns }}>
          <span />
          <span className="num">Total</span>
          {cost.owners.map((o) => (
            <span className="num" key={o ?? 'personal'}>
              {bucketName(buckets, o)}
            </span>
          ))}
        </div>
        {cost.rows.map((r) => (
          <div className="money-row" key={r.kind} style={{ gridTemplateColumns: columns }}>
            <span className="truncate">{costLabel(r, assetType)}</span>
            <span className="num">{fmtMoneyRound(r.cents)}</span>
            {r.byOwner.map((o) => (
              <span className="num" key={o.owner ?? 'personal'}>
                {fmtMoneyRound(o.cents)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Who uses the asset, a line per period: its days, each owner's share (ventures, then Personal) and what the shares were measured by. */
function Uses({ uses }: { uses: AssetUse[] }): ReactNode {
  const { buckets } = useApp()
  const periods: Array<{ key: string; fromDay: string; toDay: string | null; rows: AssetUse[] }> = []
  for (const u of uses) {
    const key = `${u.fromDay}|${u.toDay ?? ''}`
    const p = periods.find((x) => x.key === key)
    if (p) p.rows.push(u)
    else periods.push({ key, fromDay: u.fromDay, toDay: u.toDay, rows: [u] })
  }
  return (
    <div className="card">
      <h2>Uses</h2>
      {periods.map((p) => (
        <div className="list-row small use-row" key={p.key}>
          <span className="mono">
            {fmtDay(p.fromDay)} → {p.toDay ? fmtDay(p.toDay) : 'now'}
          </span>
          <span className="grow">{p.rows.map((u) => `${bucketName(buckets, u.bucketId)} ${u.shareBp / 100}%`).join(' · ')}</span>
          <span className="muted">{[...new Set(p.rows.map((u) => u.basis ?? '—'))].join(' · ')}</span>
        </div>
      ))}
    </div>
  )
}

/** The asset rules that put lines on it as its costs; Review adds and removes them. */
function AssetRules({ rules }: { rules: BucketRule[] }): ReactNode {
  return (
    <div className="card">
      <h2>Rules</h2>
      {rules.map((r) => (
        <div className="list-row small" key={r.id}>
          <div className="grow truncate">
            <RuleText rule={r} />
          </div>
        </div>
      ))}
    </div>
  )
}

function ValuationNote({ v }: { v: NonNullable<AssetSummary['valuation']> }): ReactNode {
  return (
    <div className="valuation">
      <div className="label-muted">
        Estimate · {fmtDay(v.day)} · {fmtMoneyRound(v.valueCents)}
        {v.lowCents !== null && v.highCents !== null ? ` (${fmtMoneyRound(v.lowCents)}–${fmtMoneyRound(v.highCents)})` : ''}
      </div>
      <p className="small">{v.basis}</p>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {v.sources.map((s) => (
          <button key={s} className="link small" onClick={() => void api.openExternal(s)}>
            {new URL(s).hostname.replace(/^www\./, '')}
          </button>
        ))}
      </div>
    </div>
  )
}

function yearsBetween(a: string, b: string): string {
  const months = Math.round((Date.parse(b) - Date.parse(a)) / (30.44 * 86_400_000))
  if (months < 12) return `${months} mo`
  const y = months / 12
  return `${y >= 10 ? Math.round(y) : y.toFixed(1)} yr`
}

function HistoryChart({ history }: { history: AssetHistory | null }): ReactNode {
  const data = useMemo(() => (history?.points ?? []).map((p) => ({ ...p, equity: p.valueCents - p.owedCents })), [history])
  if (!history) return null
  if (data.length < 2) return <div className="muted small">Add values on more than one date to see a history.</div>
  const axis = dateTicks(data.map((p) => p.day))
  const hasDebt = data.some((p) => p.owedCents > 0)
  return (
    <div style={{ height: 240, marginTop: 8 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="asset-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-copper)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--chart-copper)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--ink-700)" />
          <XAxis dataKey="day" ticks={axis.ticks} tickFormatter={axis.format} tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }} axisLine={{ stroke: 'var(--ink-600)' }} tickLine={false} />
          <YAxis tickFormatter={(v: number) => fmtMoneyCompact(v)} tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }} axisLine={false} tickLine={false} width={60} />
          <Tooltip content={HistoryTooltip} cursor={{ stroke: 'var(--ink-500)', strokeWidth: 1 }} />
          <Area type="linear" dataKey="valueCents" stroke="var(--chart-copper)" strokeWidth={2} fill="url(#asset-fill)" isAnimationActive={false} />
          {hasDebt && <Area type="linear" dataKey="owedCents" stroke="var(--neg)" strokeWidth={1.5} strokeDasharray="4 3" fill="none" isAnimationActive={false} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function HistoryTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }): ReactNode {
  if (!active || !payload?.length) return null
  const p = payload[0].payload as AssetHistory['points'][number] & { equity: number }
  return (
    <div className="chart-tooltip" style={{ minWidth: 170 }}>
      <div className="label-muted">{fmtDay(p.day)}</div>
      <div className="num small">Value {fmtMoneyRound(p.valueCents)}</div>
      {p.owedCents > 0 && <div className="num small">Owed {fmtMoneyRound(p.owedCents)}</div>}
      {p.owedCents > 0 && <div className="num small">Equity {fmtMoneyRound(p.equity)}</div>}
    </div>
  )
}

function AssetFields({ account: a, points }: { account: Account; points: BalancePoint[] }): ReactNode {
  const { toast, buckets } = useApp()
  const initial = useMemo(
    () => ({ name: a.name, type: a.assetType, opened: a.openedDay ?? '', closed: a.closedDay ?? '', cost: a.costCents === null ? '' : (a.costCents / 100).toFixed(2), details: a.details ?? '', bucket: a.bucketId === null ? '' : String(a.bucketId) }),
    [a]
  )
  const [f, setF] = useState(initial)
  const [closeValue, setCloseValue] = useState('')
  useEffect(() => {
    setF(initial)
    setCloseValue('')
  }, [initial])
  const dirty = JSON.stringify(f) !== JSON.stringify(initial)
  const w = words(f.type)
  // A close date newly set with no value on that day: what it closed for (0 writes it off), or its last value carries on.
  const askClose = !!f.closed && f.closed !== initial.closed && !points.some((p) => p.day === f.closed)

  async function save(): Promise<void> {
    const cost = f.cost.trim() ? parseAmount(f.cost) : null
    if (f.cost.trim() && cost === null) return toast(`Couldn't read "${f.cost}" as an amount`, 'error')
    const close = askClose && closeValue.trim() ? parseAmount(closeValue) : null
    if (askClose && closeValue.trim() && close === null) return toast(`Couldn't read "${closeValue}" as an amount`, 'error')
    try {
      await api.updateAccount(a.id, { name: f.name, assetType: f.type, openedDay: f.opened || null, closedDay: f.closed || null, costCents: cost === null ? null : Math.abs(cost), details: f.details, bucketId: f.bucket ? Number(f.bucket) : null })
      if (close !== null) await api.setBalancePoint(a.id, f.closed, Math.abs(close))
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="card asset-fields">
      <h2>Details</h2>
      <div className="field-grid">
        <label className="field">
          Name
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">
          Category
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as AssetType })}>
            {CATEGORIES.map((g) => (
              <option key={g.type} value={g.type}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {w.opened}
          <input className="input" type="date" value={f.opened} onChange={(e) => setF({ ...f, opened: e.target.value })} />
        </label>
        <label className="field">
          {w.closed}
          <input className="input" type="date" value={f.closed} onChange={(e) => setF({ ...f, closed: e.target.value })} />
        </label>
        {askClose && (
          <label className="field">
            {closeLabel(f.type)}
            <input className="input num" value={closeValue} onChange={(e) => setCloseValue(e.target.value)} />
          </label>
        )}
        <label className="field">
          {w.cost}
          <input className="input num" value={f.cost} placeholder={w.costHint} onChange={(e) => setF({ ...f, cost: e.target.value })} />
        </label>
        {buckets.length > 0 && (
          <label className="field">
            Owner
            <select className="select" value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })}>
              <option value="">Personal</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        Notes
        <textarea className="textarea" rows={3} value={f.details} placeholder={w.notesHint} onChange={(e) => setF({ ...f, details: e.target.value })} />
      </label>
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn ghost" disabled={!dirty} onClick={() => setF(initial)}>
          Reset
        </button>
        <button className="btn primary" disabled={!dirty || !f.name.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}

/** Dated balances for one account, with a row to add another. Debts are entered as positive amounts owed. */
export function ValueHistory({ account: a, points, title = 'Value history' }: { account: Account; points: BalancePoint[]; title?: string }): ReactNode {
  const { toast } = useApp()
  const [day, setDay] = useState(todayKey())
  const [amount, setAmount] = useState('')
  const debt = isDebtType(a.assetType)

  async function add(): Promise<void> {
    const cents = parseAmount(amount)
    if (cents === null) return toast(`Couldn't read "${amount}" as an amount`, 'error')
    try {
      await api.setBalancePoint(a.id, day, debt ? -Math.abs(cents) : cents)
      setAmount('')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="point-list">
        {[...points].reverse().map((p) => (
          <div className="list-row small" key={p.day}>
            <div className="grow mono">{fmtDay(p.day)}</div>
            <div className="num" style={{ width: 130 }}>
              {fmtMoney(debt ? -p.cents : p.cents)}
            </div>
            <span className="label-muted" style={{ width: 64 }}>
              {p.source === 'manual' ? 'entered' : p.source === 'estimate' ? 'estimate' : p.source === 'statement' ? 'statement' : 'synced'}
            </span>
            {p.source !== 'sync' ? (
              <button className="btn small ghost icon-btn" title="Delete" aria-label={`Delete the ${p.day} value`} onClick={() => void api.deleteBalancePoint(a.id, p.day).catch((e) => toast(errorMessage(e), 'error'))}>
                <Icon name="x" size={12} strokeWidth={2.2} />
              </button>
            ) : (
              <span style={{ width: 28, flex: 'none' }} />
            )}
          </div>
        ))}
        {points.length === 0 && <div className="muted small">None</div>}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <input className="input" type="date" value={day} aria-label="Date" onChange={(e) => setDay(e.target.value)} style={{ width: 160 }} />
        <input
          className="input num"
          value={amount}
          placeholder={debt ? 'Amount owed' : 'Value'}
          aria-label={debt ? 'Amount owed' : 'Value'}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          style={{ flex: 1 }}
        />
        <button className="btn" disabled={!day || !amount.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
    </div>
  )
}

function Loans({ summary, accounts }: { summary: AssetSummary; accounts: Account[] }): ReactNode {
  const { toast } = useApp()
  const a = summary.account
  const debtAccounts = accounts.filter((x) => isDebtType(x.assetType) && x.linkedAssetId !== a.id)
  const [linkId, setLinkId] = useState('')
  const [form, setForm] = useState<{ name: string; type: AssetType; start: string; original: string; current: string } | null>(null)

  async function link(id: string | null, accountId: string): Promise<void> {
    try {
      await api.updateAccount(accountId, { linkedAssetId: id })
      setLinkId('')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function addLoan(): Promise<void> {
    if (!form) return
    const original = parseAmount(form.original)
    const current = form.current.trim() ? parseAmount(form.current) : null
    if (original === null || (form.current.trim() && current === null)) return toast('Enter amounts like 250,000', 'error')
    const points = [{ day: form.start, cents: -Math.abs(original) }]
    if (current !== null && !summary.sold) points.push({ day: todayKey(), cents: -Math.abs(current) })
    try {
      await api.addAsset({ name: form.name, assetType: form.type, openedDay: form.start, closedDay: summary.sold ? a.closedDay : null, linkedAssetId: a.id, points })
      setForm(null)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="card">
      <h2>Loans</h2>
      {summary.debts.length === 0 && <div className="muted small">None linked</div>}
      {summary.debts.map((d) => (
        <div className="list-row small" key={d.id}>
          <div className="grow truncate">{d.name}</div>
          <div className="num">{fmtMoney(d.owedCents)}</div>
          <button className="btn small ghost" onClick={() => void link(null, d.id)}>
            Unlink
          </button>
        </div>
      ))}
      {form ? (
        <div className="loan-form">
          <div className="field-grid">
            <label className="field">
              Name
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="field">
              Type
              <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AssetType })}>
                {ASSET_TYPES.filter((t) => t.debt && t.id !== 'credit_card').map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label.replace(/s$/, '')}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Started
              <input className="input" type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </label>
            <label className="field">
              Original amount
              <input className="input num" value={form.original} onChange={(e) => setForm({ ...form, original: e.target.value })} />
            </label>
            {!summary.sold && (
              <label className="field">
                Owed today
                <input className="input num" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
              </label>
            )}
          </div>
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!form.name.trim() || !form.start || !form.original.trim()} onClick={() => void addLoan()}>
              Add loan
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          {debtAccounts.length > 0 && (
            <>
              <select className="select" value={linkId} aria-label="Debt account to link" onChange={(e) => setLinkId(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                <option value="">Link an existing debt…</option>
                {debtAccounts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.balanceCents !== null ? ` · ${fmtMoneyRound(Math.abs(d.balanceCents))}` : ''}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!linkId} onClick={() => void link(a.id, linkId)}>
                Link
              </button>
            </>
          )}
          <button className="btn" onClick={() => setForm({ name: a.assetType === 'property' ? 'Mortgage' : 'Loan', type: a.assetType === 'property' ? 'mortgage' : 'loan', start: a.openedDay ?? todayKey(), original: '', current: '' })}>
            <Icon name="plus" size={14} /> New loan
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- add ----------

export function AddAssetModal({ onClose, onAdded, initialType = 'property' }: { onClose: () => void; onAdded: (id: string) => void; initialType?: AssetType }): ReactNode {
  const { toast } = useApp()
  const [f, setF] = useState({ name: '', type: initialType, bought: '', price: '', value: '', sold: false, soldOn: '', salePrice: '', details: '' })
  const [busy, setBusy] = useState(false)
  const w = words(f.type)

  async function submit(): Promise<void> {
    const price = f.price.trim() ? parseAmount(f.price) : null
    const value = f.value.trim() ? parseAmount(f.value) : null
    const sale = f.sold && f.salePrice.trim() ? parseAmount(f.salePrice) : null
    if ((f.price.trim() && price === null) || (f.value.trim() && value === null) || (f.sold && f.salePrice.trim() && sale === null)) return toast('Enter amounts like 325,000', 'error')
    const points: Array<{ day: string; cents: number }> = []
    if (price !== null && f.bought) points.push({ day: f.bought, cents: Math.abs(price) })
    if (f.sold && sale !== null && f.soldOn) points.push({ day: f.soldOn, cents: Math.abs(sale) })
    if (!f.sold && value !== null) points.push({ day: todayKey(), cents: Math.abs(value) })
    if (!points.length && price !== null) points.push({ day: todayKey(), cents: Math.abs(price) })
    setBusy(true)
    try {
      const id = await api.addAsset({
        name: f.name,
        assetType: f.type,
        openedDay: f.bought || null,
        closedDay: f.sold ? f.soldOn || null : null,
        costCents: price === null ? null : Math.abs(price),
        details: f.details,
        points
      })
      onAdded(id)
    } catch (e) {
      toast(errorMessage(e), 'error')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="asset-title">
        <h2 id="asset-title">Add asset</h2>
        <div className="field-grid" style={{ marginTop: 16 }}>
          <label className="field">
            Name
            <input className="input" autoFocus value={f.name} placeholder="Main St house" onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            Category
            <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as AssetType })}>
              {CATEGORIES.map((g) => (
                <option key={g.type} value={g.type}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {w.opened}
            <input className="input" type="date" value={f.bought} onChange={(e) => setF({ ...f, bought: e.target.value })} />
          </label>
          <label className="field">
            {f.type === 'venture' ? 'Put in' : f.type === 'receivable' ? 'Amount lent' : 'Purchase price'}
            <input className="input num" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
          </label>
          {!f.sold && (
            <label className="field">
              {f.type === 'receivable' ? 'Still owed' : 'Value today'}
              <input className="input num" value={f.value} placeholder={f.type === 'receivable' ? 'Amount' : 'Estimate'} onChange={(e) => setF({ ...f, value: e.target.value })} />
            </label>
          )}
          {f.sold && (
            <>
              <label className="field">
                {w.closed}
                <input className="input" type="date" value={f.soldOn} onChange={(e) => setF({ ...f, soldOn: e.target.value })} />
              </label>
              <label className="field">
                {closeLabel(f.type)}
                <input className="input num" value={f.salePrice} onChange={(e) => setF({ ...f, salePrice: e.target.value })} />
              </label>
            </>
          )}
        </div>
        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={f.sold} onChange={(e) => setF({ ...f, sold: e.target.checked })} />
          {w.closed}
        </label>
        <label className="field" style={{ marginTop: 14 }}>
          Notes
          <textarea className="textarea" rows={2} value={f.details} placeholder={w.notesHint} onChange={(e) => setF({ ...f, details: e.target.value })} />
        </label>
        <div className="modal-actions">
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim() || (f.sold && !f.soldOn)} onClick={() => void submit()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
