import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { TAX_TREATMENTS, type InvestmentAccount, type Investments as InvestmentData, type PeriodReturn, type ReturnPeriodId, type Returns, type TaxTreatment } from '../../../shared/types'
import { useApp } from '../App'
import { ValueCard } from './ValueCard'
import { api, dateTicks, errorMessage, fmtMoney, fmtMoneyCompact, fmtMoneyRound, fmtSigned } from '../lib'
import { EmptyCard } from '../Empty'

const MONO = "'JetBrains Mono Variable', ui-monospace, monospace"

const COLORS: Record<TaxTreatment, string> = {
  pretax: 'var(--chart-copper)',
  roth: 'var(--chart-teal)',
  hsa: 'var(--chart-slate)',
  taxable: 'var(--ink-300)',
  private: 'var(--chart-plum)'
}

const RANGES = [
  { id: '3M', days: 91 },
  { id: '1Y', days: 366 },
  { id: 'All', days: Infinity }
] as const
type RangeId = (typeof RANGES)[number]['id']

const METRICS = [
  { id: 'twr', label: 'TWR' },
  { id: 'mwr', label: 'MWR' },
  { id: 'gain', label: 'Gain' },
  { id: 'income', label: 'Income' }
] as const
type MetricId = (typeof METRICS)[number]['id']
const PERIOD_IDS: ReturnPeriodId[] = ['1M', '3M', 'YTD', '1Y', 'All']

const fmtShares = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 10 ? 4 : 2 })
const pct = (part: number, whole: number): string => (whole ? `${Math.round((part / whole) * 100)}%` : '—')
const shortDay = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
/** "+4.2%" or "−0.8%", to a tenth of a percent. */
const fmtPct = (r: number, signed = true): string => {
  const v = Math.round(r * 1000) / 10
  return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}${Math.abs(v).toFixed(1)}%`
}
const tonePct = (r: number | null): string => (r === null || Math.abs(r) < 0.0005 ? '' : r > 0 ? 'pos' : 'neg')
const gainPct = (valueCents: number, costCents: number | null): number | null => (costCents ? (valueCents - costCents) / costCents : null)

/** The Net worth tab's Investments view. A stake has no positions, so its row opens the asset instead. */
export default function Investments({ layout, onOpen }: { layout: 'cards' | 'list'; onOpen: (id: string) => void }): ReactNode {
  const { tick, toast, go } = useApp()
  const [data, setData] = useState<InvestmentData | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [range, setRange] = useState<RangeId>(() => {
    try {
      return (localStorage.getItem('invest.range') as RangeId) || '1Y'
    } catch {
      return '1Y'
    }
  })
  const pickRange = (id: RangeId): void => {
    setRange(id)
    try {
      localStorage.setItem('invest.range', id)
    } catch {
      /* per-viewer convenience only */
    }
  }

  useEffect(() => {
    api.getInvestments().then(setData, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  // An account holding under a dollar is empty.
  const accounts = (data?.accounts ?? []).filter((a) => a.valueCents >= 100)
  const total = accounts.reduce((s, a) => s + a.valueCents, 0)
  const groups = TAX_TREATMENTS.map((t) => {
    const items = accounts.filter((a) => a.treatment === t.id)
    return { ...t, items, cents: items.reduce((s, a) => s + a.valueCents, 0) }
  }).filter((g) => g.items.length)
  const changes = accounts.filter((a) => a.change30Cents !== null)
  const change30 = changes.length ? changes.reduce((s, a) => s + a.change30Cents!, 0) : null
  const costed = accounts.filter((a) => a.costCents !== null)
  const gain = costed.length ? costed.reduce((s, a) => s + a.valueCents - a.costCents!, 0) : null
  const cost = costed.reduce((s, a) => s + a.costCents!, 0)

  return (
    <>
      <div className="page">
        {data && !accounts.length && (
          <EmptyCard label="No investment accounts">
            <button className="btn primary" onClick={() => go('accounts')}>
              Connect
            </button>
          </EmptyCard>
        )}
        {accounts.length > 0 && (
          <>
            <section className="stat-strip" style={{ gridTemplateColumns: `minmax(0, 1.5fr) repeat(${groups.length}, minmax(0, 1fr))` }}>
              <div className="tile">
                <div className="label-muted">Invested</div>
                <div className="tile-value">{fmtMoneyRound(total)}</div>
                {change30 !== null && <div className={`delta ${change30 >= 0 ? 'good' : 'bad'}`}>{fmtSigned(change30)} · 30d</div>}
                {gain !== null && (
                  <div className={`delta est ${gain >= 0 ? 'good' : 'bad'}`} style={{ display: 'flex' }}>
                    {fmtSigned(gain)} gain{cost > 0 && ` · ${fmtPct(gain / cost)}`}
                  </div>
                )}
              </div>
              {groups.map((g) => (
                <div className="tile" key={g.id}>
                  <div className="label-muted">
                    <span className="treat-dot" style={{ background: COLORS[g.id] }} />
                    {g.label}
                  </div>
                  <div className="tile-value">{fmtMoneyRound(g.cents)}</div>
                  <div className="delta">{pct(g.cents, total)}</div>
                </div>
              ))}
            </section>

            <BalanceChart data={data!} range={range} onRange={pickRange} present={groups.map((g) => g.id)} />

            <ReturnsTable data={data!} groups={groups} />

            {groups.map((g) => (
              <section className="asset-group" key={g.id}>
                <div className="asset-group-head">
                  <h2>
                    <span className="treat-dot" style={{ background: COLORS[g.id] }} />
                    {g.label}
                  </h2>
                  <span className="label-muted">
                    {g.items.length} · {fmtMoneyRound(g.cents)}
                  </span>
                </div>
                {layout === 'cards' ? (
                  <div className="asset-grid">
                    {g.items.map((a) => (
                      <AccountCard key={a.account.id} a={a} onOpen={a.treatment === 'private' ? () => onOpen(a.account.id) : undefined} />
                    ))}
                  </div>
                ) : (
                <div className="asset-table" role="table">
                  <div className="asset-row invest-row head" role="row">
                    <span>Account</span>
                    <span>Institution</span>
                    <span className="num">Value</span>
                    <span className="num">30 days</span>
                    <span className="num">Cost</span>
                    <span className="num">Gain</span>
                    <span className="num">Gain %</span>
                  </div>
                  {g.items.map((a) => (
                    <AccountRow key={a.account.id} a={a} open={open === a.account.id} onToggle={() => (a.treatment === 'private' ? onOpen(a.account.id) : setOpen(open === a.account.id ? null : a.account.id))} />
                  ))}
                </div>
                )}
              </section>
            ))}

            <AllPositions accounts={accounts} total={total} />
          </>
        )}
      </div>
    </>
  )
}

/** Estimates are set in italics. */
const Est = ({ cents, estimated, signed = false }: { cents: number; estimated: boolean; signed?: boolean }): ReactNode => (
  <span className={estimated ? 'est' : undefined} title={estimated ? 'Estimated' : undefined}>
    {signed ? fmtSigned(cents) : fmtMoney(cents)}
  </span>
)
const tone = (cents: number | null): string => (cents === null || Math.abs(cents) < 50 ? '' : cents > 0 ? 'pos' : 'neg')
const EstPct = ({ r, estimated }: { r: number | null; estimated: boolean }): ReactNode => (
  <span className={`num ${tonePct(r)}`}>
    {r === null ? (
      '—'
    ) : (
      <span className={estimated ? 'est' : undefined} title={estimated ? 'Estimated' : undefined}>
        {fmtPct(r)}
      </span>
    )}
  </span>
)

/** One period's figure: a return (yearly once the period is over a year), the gain, or the income. */
function PeriodCell({ p, metric }: { p: PeriodReturn | undefined; metric: MetricId }): ReactNode {
  if (!p) return <span className="num muted">—</span>
  const title = `${shortDay(p.from)} – ${shortDay(p.to)}`
  if (metric === 'gain')
    return (
      <span className={`num ${tone(p.gainCents)}`} title={title}>
        {fmtSigned(p.gainCents)}
      </span>
    )
  if (metric === 'income')
    return (
      <span className="num" title={title}>
        {p.incomeCents ? fmtMoneyRound(p.incomeCents) : '—'}
      </span>
    )
  const r = metric === 'twr' ? p.twr : p.mwr
  return (
    <span className={`num ${tonePct(r)}`} title={title}>
      {r === null ? '—' : fmtPct(r)}
      {r !== null && p.annualized && <span className="yr">/yr</span>}
    </span>
  )
}

/** Returns for every account together, each tax treatment, and each account under it; only the periods some row covers. */
function ReturnsTable({ data, groups }: { data: InvestmentData; groups: Array<{ id: TaxTreatment; label: string; items: InvestmentAccount[] }> }): ReactNode {
  const [metric, setMetric] = useState<MetricId>(() => {
    try {
      return (localStorage.getItem('invest.metric') as MetricId) || 'twr'
    } catch {
      return 'twr'
    }
  })
  const pick = (id: MetricId): void => {
    setMetric(id)
    try {
      localStorage.setItem('invest.metric', id)
    } catch {
      /* per-viewer convenience only */
    }
  }
  const byGroup = new Map((data.returns ?? []).map((g) => [g.id, g.returns]))
  const rows: Array<{ key: string; label: ReactNode; returns: Returns | null | undefined; kind: string }> = [{ key: 'all', label: 'Total', returns: byGroup.get('all'), kind: 'total' }]
  for (const g of groups) {
    if (g.id === 'private') continue
    const members = g.items
    const dot = <span className="treat-dot" style={{ background: COLORS[g.id] }} />
    if (members.length === 1) {
      rows.push({
        key: g.id,
        label: (
          <>
            {dot}
            {g.label} <span className="muted">· {members[0].account.name}</span>
          </>
        ),
        returns: byGroup.get(g.id),
        kind: 'group'
      })
      continue
    }
    rows.push({ key: g.id, label: <>{dot}{g.label}</>, returns: byGroup.get(g.id), kind: 'group' })
    for (const a of members) rows.push({ key: a.account.id, label: a.account.name, returns: a.returns, kind: 'member' })
  }
  const periods = PERIOD_IDS.filter((id) => rows.some((r) => r.returns?.periods.some((p) => p.period === id)))
  if (!periods.length) return null
  const risk = rows.some((r) => r.returns && (r.returns.volatility !== null || r.returns.maxDrawdown !== null))
  const columns = `minmax(0, 2.6fr) repeat(${periods.length}, minmax(70px, 1fr)) minmax(100px, 1fr)${risk ? ' repeat(2, minmax(70px, 1fr))' : ''}`
  return (
    <div className="card networth">
      <div className="networth-head">
        <h2>Returns</h2>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="Measure">
          {METRICS.map((m) => (
            <button key={m.id} className={metric === m.id ? 'active' : ''} aria-pressed={metric === m.id} onClick={() => pick(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="asset-table" role="table">
        <div className="returns-row head" role="row" style={{ gridTemplateColumns: columns }}>
          <span />
          {periods.map((id) => (
            <span key={id} className="num">
              {id}
            </span>
          ))}
          <span className="num">From</span>
          {risk && (
            <>
              <span className="num">Volatility</span>
              <span className="num">Max drawdown</span>
            </>
          )}
        </div>
        {rows.map((r) => {
          const all = r.returns?.periods.find((p) => p.period === 'All')
          return (
            <div key={r.key} className={`returns-row ${r.kind}`} role="row" style={{ gridTemplateColumns: columns }}>
              <span className="truncate">{r.label}</span>
              {periods.map((id) => (
                <PeriodCell key={id} p={r.returns?.periods.find((p) => p.period === id)} metric={metric} />
              ))}
              <span className="num muted">{all ? shortDay(all.from) : '—'}</span>
              {risk && (
                <>
                  <span className="num">{r.returns?.volatility == null ? '—' : fmtPct(r.returns.volatility, false)}</span>
                  <span className={`num ${tonePct(r.returns?.maxDrawdown ?? null)}`}>{r.returns?.maxDrawdown == null ? '—' : fmtPct(r.returns.maxDrawdown)}</span>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Rounded for the small figures on a card; estimates in italics. */
const estRound = (cents: number, estimated: boolean, signed = false): ReactNode => (
  <span className={estimated ? 'est' : undefined} title={estimated ? 'Estimated' : undefined}>
    {signed ? fmtSigned(cents) : fmtMoneyRound(cents)}
  </span>
)

function AccountCard({ a, onOpen }: { a: InvestmentAccount; onOpen?: () => void }): ReactNode {
  const gain = a.costCents === null ? null : a.valueCents - a.costCents
  const top = a.holdings.slice(0, 3).map((h) => `${h.symbol ?? h.description} ${fmtMoneyCompact(h.valueCents)}`)
  return (
    <ValueCard
      name={a.account.name}
      sub={a.account.institution ?? ''}
      value={fmtMoneyRound(a.valueCents)}
      figs={[
        { label: '30 days', value: a.change30Cents === null || Math.abs(a.change30Cents) < 50 ? '—' : fmtSigned(a.change30Cents), tone: tone(a.change30Cents) },
        { label: 'Cost', value: a.costCents === null ? '—' : estRound(a.costCents, a.costEstimated) },
        { label: 'Gain', value: gain === null ? '—' : <span title={fmtPct(gainPct(a.valueCents, a.costCents) ?? 0)}>{estRound(gain, a.costEstimated, true)}</span>, tone: tone(gain) }
      ]}
      footer={top.length ? `${top.join(' · ')}${a.holdings.length > 3 ? ` · +${a.holdings.length - 3} more` : ''}` : undefined}
      onOpen={onOpen}
    />
  )
}

function AccountRow({ a, open, onToggle }: { a: InvestmentAccount; open: boolean; onToggle: () => void }): ReactNode {
  const has = a.holdings.length > 0 || a.treatment === 'private'
  const gain = a.costCents === null ? null : a.valueCents - a.costCents
  return (
    <>
      <button className={`asset-row invest-row ${open ? 'open' : ''}`} role="row" onClick={has ? onToggle : undefined} style={has ? undefined : { cursor: 'default' }}>
        <span className="truncate">
          <span className="chev">{has ? '›' : ''}</span>
          {a.account.name}
        </span>
        <span className="truncate muted">{a.account.institution ?? '—'}</span>
        <span className="num">{fmtMoney(a.valueCents)}</span>
        <span className={`num ${tone(a.change30Cents)}`}>{a.change30Cents === null || Math.abs(a.change30Cents) < 50 ? '—' : fmtSigned(a.change30Cents)}</span>
        <span className="num muted">{a.costCents === null ? '—' : <Est cents={a.costCents} estimated={a.costEstimated} />}</span>
        <span className={`num ${tone(gain)}`}>{gain === null ? '—' : <Est cents={gain} estimated={a.costEstimated} signed />}</span>
        <EstPct r={gainPct(a.valueCents, a.costCents)} estimated={a.costEstimated} />
      </button>
      {open && a.holdings.length > 0 && (
        <div role="rowgroup">
          <div className="holding-row head">
            <span>Symbol</span>
            <span>As of {shortDay(new Date(a.holdings[0].asOf * 1000).toISOString().slice(0, 10))}</span>
            <span className="num">Shares</span>
            <span className="num">Price</span>
            <span className="num">Value</span>
            <span className="num">Cost</span>
            <span className="num">Gain</span>
            <span className="num">Gain %</span>
            <span className="num">Since buy</span>
            <span className="num">Share</span>
          </div>
          {a.holdings.map((h, i) => {
            const gain = h.costCents === null ? null : h.valueCents - h.costCents
            const since = h.sinceBuy
            return (
              <div className="holding-row" key={`${h.symbol ?? h.description}-${i}`}>
                <span className="sym truncate">{h.symbol ?? '—'}</span>
                <span className="truncate">
                  {h.description}
                  {h.inferred && <span className="tag" style={{ marginLeft: 8 }}>Inferred</span>}
                </span>
                <span className="num">{h.shares === null ? '—' : fmtShares(h.shares)}</span>
                <span className="num">{h.priceCents === null ? '—' : fmtMoney(h.priceCents)}</span>
                <span className="num">{fmtMoney(h.valueCents)}</span>
                <span className="num muted">{h.costCents === null ? '—' : <Est cents={h.costCents} estimated={h.costEstimated} />}</span>
                <span className={`num ${tone(gain)}`}>{gain === null ? '—' : <Est cents={gain} estimated={h.costEstimated} signed />}</span>
                <EstPct r={gainPct(h.valueCents, h.costCents)} estimated={h.costEstimated} />
                <span className={`num ${tonePct(since?.r ?? null)}`} title={since ? `Since ${shortDay(since.day)}` : undefined}>
                  {since ? fmtPct(since.r) : '—'}
                  {since?.annualized && <span className="yr">/yr</span>}
                </span>
                <span className="num">{pct(h.valueCents, a.valueCents)}</span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/** Every position across accounts, combined by symbol. */
function AllPositions({ accounts, total }: { accounts: InvestmentAccount[]; total: number }): ReactNode {
  const rows = useMemo(() => {
    const by = new Map<string, { symbol: string | null; description: string; shares: number | null; valueCents: number; costCents: number | null; estimated: boolean; accounts: Set<string> }>()
    for (const a of accounts) {
      for (const h of a.holdings) {
        const key = (h.symbol ?? h.description).toUpperCase()
        const r = by.get(key) ?? { symbol: h.symbol, description: h.description, shares: 0, valueCents: 0, costCents: 0, estimated: false, accounts: new Set<string>() }
        r.shares = r.shares === null || h.shares === null ? null : r.shares + h.shares
        r.valueCents += h.valueCents
        r.costCents = r.costCents === null || h.costCents === null ? null : r.costCents + h.costCents
        r.estimated ||= h.costEstimated
        r.accounts.add(a.account.id)
        by.set(key, r)
      }
    }
    return [...by.values()].sort((a, b) => b.valueCents - a.valueCents)
  }, [accounts])
  if (!rows.length) return null
  return (
    <section className="asset-group">
      <div className="asset-group-head">
        <h2>Positions</h2>
        <span className="label-muted">{rows.length}</span>
      </div>
      <div className="asset-table">
        <div className="holding-row all head">
          <span>Symbol</span>
          <span>Name</span>
          <span className="num">Shares</span>
          <span className="num">Value</span>
          <span className="num">Cost</span>
          <span className="num">Gain</span>
          <span className="num">Gain %</span>
          <span className="num">Accounts</span>
          <span className="num">Share</span>
        </div>
        {rows.map((r) => (
          <div className="holding-row all" key={(r.symbol ?? r.description).toUpperCase()}>
            <span className="sym truncate">{r.symbol ?? '—'}</span>
            <span className="truncate">{r.description}</span>
            <span className="num">{r.shares === null ? '—' : fmtShares(r.shares)}</span>
            <span className="num">{fmtMoney(r.valueCents)}</span>
            <span className="num muted">{r.costCents === null ? '—' : <Est cents={r.costCents} estimated={r.estimated} />}</span>
            <span className={`num ${tone(r.costCents === null ? null : r.valueCents - r.costCents)}`}>{r.costCents === null ? '—' : <Est cents={r.valueCents - r.costCents} estimated={r.estimated} signed />}</span>
            <EstPct r={gainPct(r.valueCents, r.costCents)} estimated={r.estimated} />
            <span className="num">{r.accounts.size}</span>
            <span className="num">{pct(r.valueCents, total)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function BalanceTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }): ReactNode {
  if (!active || !payload?.length) return null
  const p = payload[0].payload as InvestmentData['points'][number]
  const rows = TAX_TREATMENTS.filter((t) => p[t.id])
  return (
    <div className="chart-tooltip" style={{ minWidth: 170 }}>
      <div className="label-muted">{shortDay(p.day)}</div>
      {rows.map((t) => (
        <div className="row" key={t.id}>
          <span className="swatch" style={{ background: COLORS[t.id] }} /> {t.label}
          <span className="num" style={{ marginLeft: 'auto', paddingLeft: 14 }}>
            {fmtMoneyRound(p[t.id])}
          </span>
        </div>
      ))}
      <div className="row">
        Total
        <span className="num" style={{ marginLeft: 'auto', paddingLeft: 14 }}>
          {fmtMoneyRound(rows.reduce((s, t) => s + p[t.id], 0))}
        </span>
      </div>
    </div>
  )
}

function BalanceChart({ data, range, onRange, present }: { data: InvestmentData; range: RangeId; onRange: (r: RangeId) => void; present: TaxTreatment[] }): ReactNode {
  const points = useMemo(() => {
    const days = RANGES.find((r) => r.id === range)!.days
    if (!Number.isFinite(days)) return data.points
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    return data.points.filter((p) => p.day >= cutoff)
  }, [data, range])
  if (points.length < 2) return null
  const axis = dateTicks(points.map((p) => p.day))
  const sum = (p: (typeof points)[number]): number => p.pretax + p.roth + p.hsa + p.taxable + p.private
  const change = sum(points[points.length - 1]) - sum(points[0])
  return (
    <div className="card networth">
      <div className="networth-head">
        <h2>Balance</h2>
        <div className={`delta ${change >= 0 ? 'good' : 'bad'}`}>
          {fmtSigned(change)} · since {shortDay(points[0].day)}
        </div>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} className={range === r.id ? 'active' : ''} aria-pressed={range === r.id} onClick={() => onRange(r.id)}>
              {r.id}
            </button>
          ))}
        </div>
      </div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--ink-700)" />
            <XAxis dataKey="day" ticks={axis.ticks} tickFormatter={axis.format} tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }} axisLine={{ stroke: 'var(--ink-600)' }} tickLine={false} />
            <YAxis tickFormatter={(v: number) => fmtMoneyCompact(v)} tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }} axisLine={false} tickLine={false} width={60} />
            <Tooltip content={BalanceTooltip} cursor={{ stroke: 'var(--ink-500)', strokeWidth: 1 }} />
            {present.map((t) => (
              <Area key={t} type="linear" dataKey={t} stackId="1" stroke={COLORS[t]} strokeWidth={1.5} fill={COLORS[t]} fillOpacity={0.14} isAnimationActive={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
