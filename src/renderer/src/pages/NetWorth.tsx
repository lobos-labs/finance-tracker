import { useEffect, useState, type ReactNode } from 'react'
import { SHEET_GROUP_OF, SHEET_GROUPS, type Account, type AssetSummary, type BalanceSheet, type SheetGroup } from '../../../shared/types'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, errorMessage, fmtDay, fmtMinus, fmtMoney, fmtMoneyRound, fmtSigned } from '../lib'
import Property, { AddAssetModal, AssetDetail } from './Assets'
import Investments from './Investments'
import { DebtPlan } from './DebtPlan'
import { NetWorthOverTime } from './NetWorthChart'
import { ValueCard } from './ValueCard'

// Everything owned and owed in one place: the overview is the balance sheet,
// and each kind of thing has its own view. Every view shares one header (the
// views on the left, Add asset and the cards/list switch on the right), so
// nothing moves when switching between them.

export type NetView = 'overview' | 'investments' | 'property' | 'debts'
type View = NetView
type Layout = 'cards' | 'list'
type Group = BalanceSheet['groups'][number]

/** The views, picked from the sidebar under Net worth. */
export const NET_VIEWS: Array<{ id: NetView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'investments', label: 'Investments' },
  { id: 'property', label: 'Property' },
  { id: 'debts', label: 'Debts' }
]

const LAYOUT_KEY = 'networth.layout'

const COLORS: Record<SheetGroup, string> = {
  cash: 'var(--chart-teal)',
  investments: 'var(--chart-copper)',
  property: 'var(--chart-slate)',
  owed: 'var(--chart-plum)',
  ventures: 'var(--chart-blue)',
  cards: 'var(--neg)',
  loans: 'var(--neg)'
}

/** A venture's share: 50%, or 33.33%. */
const sharePct = (bp: number): string => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`
/** A group's total as its rows show it: a venture's position can be below 0, so the ventures group keeps its sign. */
const groupCents = (g: Group): number => (g.id === 'ventures' ? g.cents : Math.abs(g.cents))
/** A group's figure: the ventures' with its sign, as a venture in debt lowers it below 0, and the others' whole. */
const groupText = (g: Group): string => fmtMinus(groupCents(g))

/** Where each group's detail lives. */
const VIEW_OF: Partial<Record<SheetGroup, View>> = { investments: 'investments', property: 'property', cards: 'debts', loans: 'debts' }

const label = (g: SheetGroup): string => SHEET_GROUPS.find((x) => x.id === g)!.label
const isDebt = (g: SheetGroup): boolean => SHEET_GROUPS.find((x) => x.id === g)!.debt
/** "+$1,200" for a change, with what's good for a debt (owing less) shown as good. */
const changeTone = (cents: number, debt: boolean): string => (Math.abs(cents) < 100 ? 'muted' : (cents > 0) !== debt ? 'pos' : 'neg')
const changeText = (cents: number): string => (Math.abs(cents) < 100 ? '—' : fmtSigned(cents))

export default function NetWorth({ view, picks = 0, onView }: { view: View; picks?: number; onView: (v: View) => void }): ReactNode {
  const { tick, toast } = useApp()
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return (localStorage.getItem(LAYOUT_KEY) ?? localStorage.getItem('assets.view')) === 'list' ? 'list' : 'cards'
    } catch {
      return 'cards'
    }
  })
  const [assetId, setAssetId] = useState<string | null>(null)
  const [assets, setAssets] = useState<AssetSummary[] | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (assetId) api.listAssets().then(setAssets, (e) => toast(errorMessage(e), 'error'))
  }, [assetId, tick, toast])

  // Picking a view, here or in the sidebar, leaves an open asset.
  useEffect(() => setAssetId(null), [view, picks])
  const pick = (v: View): void => {
    onView(v)
    setAssetId(null)
  }
  const pickLayout = (l: Layout): void => {
    setLayout(l)
    try {
      localStorage.setItem(LAYOUT_KEY, l)
    } catch {
      /* per-viewer convenience only */
    }
  }

  const summary = assetId ? assets?.find((a) => a.account.id === assetId) : undefined
  if (summary) return <AssetDetail summary={summary} onBack={() => setAssetId(null)} />

  return (
    <>
      <PageHeader title={view === 'overview' ? 'Net worth' : NET_VIEWS.find((v) => v.id === view)!.label}>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> Add asset
        </button>
        <div className="segmented" role="group" aria-label="Layout">
          {(['cards', 'list'] as const).map((l) => (
            <button key={l} className={layout === l ? 'active' : ''} aria-pressed={layout === l} onClick={() => pickLayout(l)}>
              {l === 'cards' ? 'Cards' : 'List'}
            </button>
          ))}
        </div>
      </PageHeader>
      {view === 'investments' ? (
        <Investments layout={layout} onOpen={setAssetId} />
      ) : view === 'property' ? (
        <Property layout={layout} onOpen={setAssetId} onAdd={() => setAdding(true)} />
      ) : view === 'debts' ? (
        <Debts layout={layout} onAsset={setAssetId} />
      ) : (
        <Overview layout={layout} onView={pick} onAsset={setAssetId} />
      )}
      {adding && (
        <AddAssetModal
          initialType={view === 'investments' ? 'venture' : 'property'}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false)
            setAssetId(id)
          }}
        />
      )}
    </>
  )
}

function useSheet(): BalanceSheet | null {
  const { tick, toast } = useApp()
  const [sheet, setSheet] = useState<BalanceSheet | null>(null)
  useEffect(() => {
    api.getBalanceSheet().then(setSheet, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])
  return sheet
}

// ---------- overview ----------

function Overview({ layout, onView, onAsset }: { layout: Layout; onView: (v: View) => void; onAsset: (id: string) => void }): ReactNode {
  const { go, goVenture } = useApp()
  const sheet = useSheet()
  if (!sheet) return <div className="page" />

  /** Where an account's detail lives. */
  const open = (a: Account): void => {
    const g = SHEET_GROUP_OF[a.assetType]
    if (a.assetType === 'investment' || a.assetType === 'retirement') onView('investments')
    else if (g === 'cards' || g === 'loans') onView('debts')
    else if (g === 'cash') go('transactions', { accountId: a.id })
    else onAsset(a.id)
  }
  const shown = (g: Group): boolean => g.accounts.length > 0 || (g.ventures?.length ?? 0) > 0 || g.zeroCount > 0 || g.cents !== 0
  // The Ventures group opens the list, and a venture's row its own page.
  const onVenture = (id?: number): void => (id === undefined ? go('buckets') : goVenture(id))
  const own = sheet.groups.filter((g) => !isDebt(g.id) && shown(g))
  const owe = sheet.groups.filter((g) => isDebt(g.id) && shown(g))
  const ownChange = own.reduce((s, g) => s + g.change30Cents, 0)
  const oweChange = -owe.reduce((s, g) => s + g.change30Cents, 0)

  const head = (title: string): ReactNode => <div className="sheet-col-head label-muted">{title}</div>

  return (
    <div className="page">
      <section className="stat-strip" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) repeat(2, minmax(0, 1fr))' }}>
        <div className="tile">
          <div className="label-muted">Net worth</div>
          <div className="tile-value">{fmtMoneyRound(sheet.netWorthCents)}</div>
          <div className={`delta ${sheet.change30Cents >= 0 ? 'good' : 'bad'}`}>{fmtSigned(sheet.change30Cents)} · 30 days</div>
        </div>
        <div className="tile">
          <div className="label-muted">You own</div>
          <div className="tile-value">{fmtMoneyRound(sheet.ownCents)}</div>
          <div className={`delta ${ownChange >= 0 ? 'good' : 'bad'}`}>{fmtSigned(ownChange)} · 30 days</div>
        </div>
        <div className="tile">
          <div className="label-muted">You owe</div>
          <div className="tile-value">{fmtMoneyRound(sheet.oweCents)}</div>
          <div className={`delta ${oweChange <= 0 ? 'good' : 'bad'}`}>{fmtSigned(oweChange)} · 30 days</div>
        </div>
      </section>

      <NetWorthOverTime />

      <Composition sheet={sheet} />

      {layout === 'cards' ? (
        <>
          <section className="asset-group">
            {head('What you own')}
            <div className="asset-grid">
              {own.map((g) => (
                <GroupCard key={g.id} g={g} total={sheet.ownCents} onOpen={VIEW_OF[g.id] ? () => onView(VIEW_OF[g.id]!) : g.id === 'ventures' ? () => onVenture() : undefined} />
              ))}
            </div>
          </section>
          <section className="asset-group">
            {head('What you owe')}
            <div className="asset-grid">
              {owe.map((g) => (
                <GroupCard key={g.id} g={g} total={sheet.oweCents} onOpen={VIEW_OF[g.id] ? () => onView(VIEW_OF[g.id]!) : undefined} />
              ))}
            </div>
          </section>
        </>
      ) : (
        <div className="sheet-cols">
          <section>
            {head('What you own')}
            <SheetLegend />
            {own.map((g) => (
              <GroupRows key={g.id} g={g} onView={onView} onOpen={open} onVenture={onVenture} />
            ))}
          </section>
          <section>
            {head('What you owe')}
            <SheetLegend />
            {owe.map((g) => (
              <GroupRows key={g.id} g={g} onView={onView} onOpen={open} onVenture={onVenture} />
            ))}
          </section>
        </div>
      )}
    </div>
  )
}

/** A group as a card: its total, change, share and biggest accounts. */
function GroupCard({ g, total, onOpen }: { g: Group; total: number; onOpen?: () => void }): ReactNode {
  const debt = isDebt(g.id)
  const change = debt ? -g.change30Cents : g.change30Cents
  // The ventures group lists ventures, each at its position, where the others list accounts.
  const ventures = g.id === 'ventures'
  const owing = ventures ? (g.ventures ?? []).map((v) => ({ name: v.name, cents: v.cents })) : g.accounts.filter((x) => Math.abs(x.cents) >= 1).map((x) => ({ name: x.account.name, cents: x.cents }))
  // A venture keeps its position's sign: one in debt is below 0.
  const money = (cents: number): string => (ventures ? fmtMinus(cents) : fmtMoneyRound(Math.abs(cents)))
  const top = owing.slice(0, 3).map((x) => `${x.name} ${money(x.cents)}`)
  return (
    <ValueCard
      name={label(g.id)}
      tag={<span className="treat-dot" style={{ background: COLORS[g.id], opacity: g.id === 'loans' ? 0.55 : 1 }} />}
      sub={`${owing.length} ${ventures ? 'venture' : 'account'}${owing.length === 1 ? '' : 's'}`}
      value={groupText(g)}
      figs={[
        { label: '30 days', value: changeText(change), tone: changeTone(change, debt) },
        // The ventures below 0 own no share of what the user owns.
        { label: 'Share', value: total && !(ventures && g.cents < 0) ? `${Math.round((Math.abs(g.cents) / total) * 100)}%` : '—' },
        { label: 'Largest', value: owing[0] ? money(owing[0].cents) : '—' }
      ]}
      footer={top.length ? `${top.join(' · ')}${owing.length > 3 ? ` · +${owing.length - 3} more` : ''}` : undefined}
      onOpen={onOpen}
    />
  )
}

/** A group as rows: its header, then each account with its balance and change (in ventures, each venture with its share and position). */
export function GroupRows({ g, onView, onOpen, onVenture }: { g: Group; onView: (v: View) => void; onOpen: (a: Account) => void; onVenture: (id?: number) => void }): ReactNode {
  const debt = isDebt(g.id)
  const target = VIEW_OF[g.id]
  const change = debt ? -g.change30Cents : g.change30Cents
  const open = target ? () => onView(target) : g.id === 'ventures' ? () => onVenture() : undefined
  return (
    <div className="sheet-group">
      <button className="sheet-row sheet-head" onClick={open} style={open ? undefined : { cursor: 'default' }}>
        <span className="sheet-name">
          <span className="treat-dot" style={{ background: COLORS[g.id] }} />
          {label(g.id)}
          {open && <Icon name="chevronRight" size={13} />}
        </span>
        <span className="num">{groupText(g)}</span>
        <span className={`num ${changeTone(change, debt)}`}>{changeText(change)}</span>
      </button>
      {(g.ventures ?? []).map((v) => (
        <button className="sheet-row" key={`venture:${v.bucketId}`} onClick={() => onVenture(v.bucketId)}>
          {/* The share goes under the name when the column is narrow, so neither is cut short. */}
          <span className="sheet-venture" title={v.name}>
            <span className="truncate">{v.name}</span>
            <span className="muted"> · {sharePct(v.shareBp)}</span>
          </span>
          <span className="num">{fmtMinus(v.cents)}</span>
          <span className={`num ${changeTone(v.change30Cents, false)}`}>{changeText(v.change30Cents)}</span>
        </button>
      ))}
      {g.accounts.map((x) => {
        const moved = debt ? -x.change30Cents : x.change30Cents
        return (
          <button className="sheet-row" key={x.account.id} onClick={() => onOpen(x.account)}>
            <span className="truncate" title={x.account.name}>
              {x.account.name}
              {x.linkedAsset && <span className="muted"> · {x.linkedAsset}</span>}
            </span>
            <span className="num">{fmtMoneyRound(Math.abs(x.cents))}</span>
            <span className={`num ${changeTone(moved, debt)}`}>{changeText(moved)}</span>
          </button>
        )
      })}
      {g.zeroCount > 0 && (
        <div className="sheet-row sheet-more">
          <span className="muted">{g.zeroCount} more at $0</span>
        </div>
      )}
    </div>
  )
}

/** Column names over the groups' rows. */
function SheetLegend(): ReactNode {
  return (
    <div className="sheet-row sheet-legend">
      <span />
      <span className="num">Balance</span>
      <span className="num">30-day change</span>
    </div>
  )
}

/** Own and owe as two bars on one scale, each split by group. */
function Composition({ sheet }: { sheet: BalanceSheet }): ReactNode {
  const scale = Math.max(sheet.ownCents, sheet.oweCents, 1)
  const bar = (debt: boolean): ReactNode => {
    const parts = sheet.groups.filter((g) => isDebt(g.id) === debt && Math.abs(g.cents) > 0)
    const total = debt ? sheet.oweCents : sheet.ownCents
    return (
      <div className="comp-line">
        <span className="label-muted">{debt ? 'Owe' : 'Own'}</span>
        <div className="comp-track">
          <div className="comp-bar" style={{ width: `${(Math.max(total, 0) / scale) * 100}%` }}>
            {parts.map((g) => (
              <span
                key={g.id}
                title={`${label(g.id)} ${fmtMoneyRound(Math.abs(g.cents))}`}
                style={{ flexGrow: Math.abs(g.cents), background: COLORS[g.id], opacity: g.id === 'loans' ? 0.55 : 1 }}
              />
            ))}
          </div>
        </div>
        <span className="num">{fmtMoneyRound(total)}</span>
      </div>
    )
  }
  return (
    <div className="card comp">
      {bar(false)}
      {bar(true)}
      <div className="comp-legend">
        {sheet.groups
          .filter((g) => Math.abs(g.cents) > 0)
          .map((g) => (
            <span key={g.id}>
              <span className="treat-dot" style={{ background: COLORS[g.id], opacity: g.id === 'loans' ? 0.55 : 1 }} />
              {label(g.id)} <span className="num">{fmtMoneyRound(Math.abs(g.cents))}</span>
            </span>
          ))}
      </div>
    </div>
  )
}

// ---------- debts ----------

const promo = (a: Account): string | null => (a.promoApr === null ? null : a.promoEnds ? `${a.promoApr}% until ${fmtDay(a.promoEnds)}` : `${a.promoApr}% intro rate`)

function Debts({ layout, onAsset }: { layout: Layout; onAsset: (id: string) => void }): ReactNode {
  const sheet = useSheet()
  if (!sheet) return <div className="page" />
  const groups = sheet.groups.filter((g) => isDebt(g.id))
  const owing = (g: Group): Group['accounts'] => g.accounts.filter((x) => Math.abs(x.cents) >= 1)
  const rows = groups.flatMap(owing)
  const minimums = rows.filter((x) => x.account.minPaymentCents !== null)
  const change = -groups.reduce((s, g) => s + g.change30Cents, 0)
  const listed = groups.filter((g) => g.accounts.length)

  return (
    <div className="page">
      <section className="stat-strip even">
        <div className="tile">
          <div className="label-muted">You owe</div>
          <div className="tile-value">{fmtMoneyRound(sheet.oweCents)}</div>
          <div className={`delta ${change <= 0 ? 'good' : 'bad'}`}>{fmtSigned(change)} · 30 days</div>
        </div>
        {groups.map((g) => (
          <div className="tile" key={g.id}>
            <div className="label-muted">{label(g.id)}</div>
            <div className="tile-value">{fmtMoneyRound(Math.abs(g.cents))}</div>
            <div className="delta">
              {owing(g).length} with a balance{g.accounts.length - owing(g).length + g.zeroCount ? ` · ${g.accounts.length - owing(g).length + g.zeroCount} at $0` : ''}
            </div>
          </div>
        ))}
        <div className="tile">
          <div className="label-muted">Minimums a month</div>
          <div className="tile-value">{fmtMoneyRound(minimums.reduce((s, x) => s + x.account.minPaymentCents!, 0))}</div>
          <div className="delta">{minimums.length < rows.length ? `${rows.length - minimums.length} without a minimum on file` : 'All on file'}</div>
        </div>
      </section>

      <DebtPlan />

      {listed.map((g) => (
        <section className="asset-group" key={g.id}>
          <div className="asset-group-head">
            <h2>{label(g.id)}</h2>
            <span className="label-muted">
              {owing(g).length} · {fmtMoneyRound(Math.abs(g.cents))}
            </span>
          </div>
          {layout === 'cards' ? (
            <div className="asset-grid">
              {g.accounts.map((x) => {
                const a = x.account
                const moved = -x.change30Cents
                return (
                  <ValueCard
                    key={a.id}
                    name={a.name}
                    sub={promo(a) ?? (x.linkedAsset ? `Secured by ${x.linkedAsset}` : g.id === 'cards' ? 'Credit card' : 'Loan')}
                    value={fmtMoneyRound(Math.abs(x.cents))}
                    dim={Math.abs(x.cents) < 1}
                    figs={[
                      { label: 'APR', value: a.apr === null ? '—' : `${a.apr}%` },
                      { label: 'Minimum', value: a.minPaymentCents === null ? '—' : fmtMoneyRound(a.minPaymentCents) },
                      { label: '30 days', value: changeText(moved), tone: changeTone(moved, true) }
                    ]}
                    onOpen={a.linkedAssetId ? () => onAsset(a.linkedAssetId!) : undefined}
                  />
                )
              })}
            </div>
          ) : (
            <div className="asset-table" role="table">
              <div className="debtlist-row head" role="row">
                <span>{g.id === 'cards' ? 'Card' : 'Loan'}</span>
                <span className="num">Balance</span>
                <span className="num">30 days</span>
                <span className="num">APR</span>
                <span>Intro rate</span>
                <span className="num">Minimum</span>
                <span>Secured by</span>
              </div>
              {g.accounts.map((x) => {
                const a = x.account
                const moved = -x.change30Cents
                return (
                  <div className="debtlist-row" role="row" key={a.id}>
                    <span className="truncate" title={a.name}>
                      {a.name}
                    </span>
                    <span className="num">{fmtMoney(Math.abs(x.cents))}</span>
                    <span className={`num ${changeTone(moved, true)}`}>{changeText(moved)}</span>
                    <span className="num">{a.apr === null ? '—' : `${a.apr}%`}</span>
                    <span className={a.promoApr === null ? 'muted' : ''}>{a.promoApr === null ? '—' : `${a.promoApr}%${a.promoEnds ? ` until ${fmtDay(a.promoEnds)}` : ''}`}</span>
                    <span className="num">{a.minPaymentCents === null ? '—' : fmtMoney(a.minPaymentCents)}</span>
                    <span className="truncate">
                      {x.linkedAsset && a.linkedAssetId ? (
                        <button className="link" onClick={() => onAsset(a.linkedAssetId!)}>
                          {x.linkedAsset}
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ))}
      {!rows.length && (
        <div className="card empty" style={{ marginTop: 24 }}>
          <div className="muted">No debts</div>
        </div>
      )}
    </div>
  )
}
