import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import type { BenefitPlan, BenefitsView, CareExpense, CareKind, ContributionSummary, HsaState, HsaYear, PayCheck, RecurringSeries } from '../../../shared/types'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, errorMessage, fmtDay, fmtMoney, fmtMoneyCompact, fmtMoneyRound, onWeb, todayKey } from '../lib'
import { Meter, useWidth, type MeterSegment } from '../Meter'
import { EmptyCard, OpenFolderButton } from '../Empty'
import { Contributions } from './Contributions'
import { PayTable } from './HomeRows'
import { payTablesOf } from './homeView'

// Pay & benefits (waterfall spec section 4, Decision 7): this year's checks in a pay-day table per payroll, the
// paycheck savings plans and their limits, then the HSA, the plans' free care and coverage, and the health costs to
// pay back.

const CARE: Record<CareKind, string> = { medical: 'Medical', dental: 'Dental', vision: 'Vision', pharmacy: 'Pharmacy' }
const HEALTH_PLANS: string[] = ['medical', 'dental', 'vision']

function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T12:00:00`)
  d.setMonth(d.getMonth() + months)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const monthYear = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
const short = (cents: number): string => (Math.abs(cents) >= 100_000 ? fmtMoneyCompact(cents) : fmtMoneyRound(cents))
/** "Receipts/2026-09-24 Dr Example.pdf" → "2026-09-24 Dr Example" */
const fileLabel = (name: string): string => name.split('/').pop()!.replace(/\.[^.]+$/, '')
const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

/** This year's checks, a table per payroll, each figure as its paystub reads; a check's day opens its deposits. */
function PayDays({ checks, series }: { checks: PayCheck[]; series: RecurringSeries[] }): ReactNode {
  const { go } = useApp()
  const today = todayKey()
  const tables = useMemo(() => {
    const names = new Map(series.map((s) => [s.key, s.name]))
    return payTablesOf(checks, { fromDay: `${today.slice(0, 4)}-01-01`, toDay: today }, (key) => names.get(key) ?? key.replace(/\|[+-]$/, ''))
  }, [checks, series, today])
  if (!tables.length) return null
  return (
    <section className="asset-group">
      <div className="asset-group-head">
        <h2>Pay days · {today.slice(0, 4)}</h2>
      </div>
      <div className="card pay-days">
        {tables.map((t) => (
          <PayTable key={t.key} l={t} onDrill={(f) => go('transactions', f)} />
        ))}
      </div>
    </section>
  )
}

export default function Benefits(): ReactNode {
  const { tick, toast } = useApp()
  const [data, setData] = useState<BenefitsView | null>(null)
  const [checks, setChecks] = useState<PayCheck[]>([])
  const [series, setSeries] = useState<RecurringSeries[]>([])
  const [contrib, setContrib] = useState<ContributionSummary | null>(null)
  // The year's checks, the payrolls' names and the savings plans, beside the benefits.
  useEffect(() => {
    const today = todayKey()
    api.listPayChecks(`${today.slice(0, 4)}-01-01`, today).then(setChecks, (e) => toast(errorMessage(e), 'error'))
    api.listRecurring().then(setSeries, () => {})
    api.listContributions().then(setContrib, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])
  const [showSettled, setShowSettled] = useState(false)
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [dropOn, setDropOn] = useState<string | null>(null)

  useEffect(() => {
    api.getBenefits().then((d) => {
      setData(d)
      setPicked((p) => new Set([...p].filter((id) => d.care.some((c) => c.id === id))))
    }, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  const run = (p: Promise<unknown>): void => {
    p.catch((e) => toast(errorMessage(e), 'error'))
  }

  /** Attaches a file (asking for one without a path) to costs; a row that's part of the selection takes the whole selection. */
  const attach = (ids: string[], path?: string): void => {
    api.attachReceipt(ids, path ?? null).then((name) => {
      if (!name) return
      toast(`Receipt added to ${ids.length} cost${ids.length === 1 ? '' : 's'}`)
      setPicked(new Set())
    }, (e) => toast(errorMessage(e), 'error'))
  }
  const forRow = (id: string): string[] => (picked.has(id) ? [...picked] : [id])
  const drop = (e: DragEvent, id: string): void => {
    e.preventDefault()
    setDropOn(null)
    const file = e.dataTransfer.files[0]
    if (file) attach(forRow(id), api.pathForFile(file))
  }
  const toggle = (id: string): void =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (!data) return <PageHeader title="Pay & benefits" />

  const h = data.hsa
  const employer = data.employer ?? 'Employer'
  const health = data.plans.filter((p) => HEALTH_PLANS.includes(p.kind))
  const other = data.plans.filter((p) => !HEALTH_PLANS.includes(p.kind))
  const free = data.plans.flatMap((p) => p.free.map((item) => ({ plan: p, item, key: `${p.name}|${item.what}` })))
  const today = todayKey()
  const nextDue = (key: string, months: number | null): string | null => (data.done[key] && months ? addMonths(data.done[key], months) : null)
  const isDue = (key: string, months: number | null): boolean => months !== null && (!data.done[key] || nextDue(key, months)! <= today)
  const dueCount = free.filter((f) => isDue(f.key, f.item.everyMonths)).length

  const owed = data.care.filter((c) => c.status === 'owed')
  const settled = data.care.filter((c) => c.status !== 'owed')
  const yearTotal = Object.values(data.thisYear).reduce((s, c) => s + c, 0)
  const byKind = (Object.keys(data.thisYear) as CareKind[]).filter((k) => data.thisYear[k] > 0).sort((a, b) => data.thisYear[b] - data.thisYear[a])

  const needsReceipt = (c: CareExpense): boolean => (c.status === 'owed' || c.status === 'reimbursed') && c.cents > 0 && !c.receiptFound
  const listed = (showSettled ? [...owed, ...settled] : owed).filter((c) => !onlyMissing || needsReceipt(c))
  const allPicked = listed.length > 0 && listed.every((c) => picked.has(c.id))
  const pickedCents = data.care.filter((c) => picked.has(c.id)).reduce((s, c) => s + c.cents, 0)

  const setHsa = (ids: string[], to: string): void => {
    const state: HsaState = to === 'reimbursed' ? 'reimbursed' : to === 'not' ? 'not' : 'eligible'
    run(api.setHsa(ids, state).then(() => setPicked(new Set())))
  }

  return (
    <>
      <PageHeader title="Pay & benefits">
        <span className="label-muted">
          {employer} · {data.year}
        </span>
      </PageHeader>
      <div className="page">
        <PayDays checks={checks} series={series} />
        <Contributions summary={contrib} />
        <section className="stat-strip three">
          <div className="tile">
            <div className="label-muted">HSA</div>
            <div className="tile-value">{h.balanceCents === null ? '—' : fmtMoneyRound(h.balanceCents)}</div>
            <div className="delta">{h.accountName ?? 'No HSA account'}</div>
          </div>
          <div className="tile">
            <div className="label-muted">Pay yourself back</div>
            <div className={`tile-value ${h.owedCents > 0 ? 'good' : ''}`}>{fmtMoneyRound(h.owedCents)}</div>
            <div className="delta">
              {owed.length} cost{owed.length === 1 ? '' : 's'}
              {h.startDay ? ` since ${fmtDay(h.startDay)}` : ''} · tax-free
            </div>
          </div>
          <div className="tile">
            <div className="label-muted">Care in {data.year}</div>
            <div className="tile-value">{fmtMoneyRound(yearTotal)}</div>
            <div className="delta">{byKind.map((k) => `${CARE[k]} ${short(data.thisYear[k])}`).join(' · ')}</div>
          </div>
        </section>

        <HsaContributions data={data} />

        {free.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Free care</h2>
              <span className="label-muted">{dueCount ? `${dueCount} due` : 'Nothing due'}</span>
            </div>
            <div className="asset-table" role="table">
              <div className="free-row head" role="row">
                <span>What</span>
                <span>Plan</span>
                <span>How often</span>
                <span>Last done</span>
                <span>Next</span>
                <span />
              </div>
              {free.map(({ plan, item, key }) => {
                const done = data.done[key] ?? null
                const next = nextDue(key, item.everyMonths)
                return (
                  <div className="free-row" role="row" key={key}>
                    <span>{item.what}</span>
                    <span className="muted">{plan.name}</span>
                    <span className="muted">{item.often}</span>
                    <span className={done ? 'mono small' : 'muted'}>{done ? fmtDay(done) : '—'}</span>
                    <span>{isDue(key, item.everyMonths) ? <span className="tag due">Due</span> : next ? <span className="mono small muted">{monthYear(next)}</span> : null}</span>
                    <span className="num">
                      <button className="btn small" onClick={() => run(api.setCareDone(key, done === today ? null : today))}>
                        {done === today ? 'Undo' : 'Done today'}
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {health.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Your coverage</h2>
            </div>
            <div className="plan-grid">
              {health.map((p) => (
                <PlanCard key={p.name} plan={p} employer={employer} last={data.lastVisit[p.kind as CareKind]} />
              ))}
            </div>
          </section>
        )}

        <section className="asset-group">
          <div className="asset-group-head">
            <h2>Pay yourself back</h2>
            <span className="label-muted">
              {owed.length} · {fmtMoney(h.owedCents)}
              {h.needReceipts > 0 && ` · ${h.needReceipts} without receipts`}
            </span>
            <span style={{ flex: 1 }} />
            {picked.size > 0 ? (
              <div className="select-bar">
                <span className="label-muted">
                  {picked.size} selected · {fmtMoney(pickedCents)}
                </span>
                <button className="btn small" onClick={() => attach([...picked])}>
                  <Icon name="paperclip" size={13} /> Attach receipt
                </button>
                <button className="btn small" onClick={() => setHsa([...picked], 'reimbursed')}>
                  Paid back
                </button>
                <button className="btn small" onClick={() => setHsa([...picked], 'not')}>
                  Doesn't qualify
                </button>
                <button className="btn small ghost" onClick={() => setPicked(new Set())}>
                  Clear
                </button>
              </div>
            ) : (
              <div className="select-bar">
                <label className="row small muted">
                  <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Without receipts
                </label>
                {data.care.some((c) => c.receiptFound) && !onWeb() && (
                  <button className="btn small ghost" onClick={() => run(api.openReceipt('Receipts'))}>
                    <Icon name="folder" size={13} /> Receipts
                  </button>
                )}
              </div>
            )}
          </div>
          {data.care.length === 0 ? (
            <EmptyCard label={`No health costs${h.startDay ? ` since ${fmtDay(h.startDay)}` : ''}`}>
              <OpenFolderButton sub="Paystubs">Add paystub</OpenFolderButton>
            </EmptyCard>
          ) : (
            <div className="asset-table" role="table">
              <div className="care-row head" role="row">
                <span>
                  <input type="checkbox" aria-label="Select all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(listed.map((c) => c.id)))} />
                </span>
                <span>Date</span>
                <span>Where</span>
                <span>Kind</span>
                <span>Paid with</span>
                <span className="num">Amount</span>
                <span>Receipt</span>
                <span>HSA</span>
              </div>
              {listed.length === 0 && <div className="care-more muted">Every cost has a receipt</div>}
              {listed.map((c) => (
                <div
                  className={`care-row ${c.status === 'owed' ? '' : 'dim'} ${picked.has(c.id) ? 'picked' : ''} ${dropOn === c.id ? 'drop' : ''}`}
                  role="row"
                  key={c.id}
                  onDragOver={(e) => {
                    if (!hasFiles(e)) return
                    e.preventDefault()
                    if (dropOn !== c.id) setDropOn(c.id)
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((d) => (d === c.id ? null : d))
                  }}
                  onDrop={(e) => drop(e, c.id)}
                >
                  <span>
                    <input type="checkbox" aria-label={`Select ${c.merchant} on ${fmtDay(c.day)}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                  </span>
                  <span className="mono small fade">{fmtDay(c.day)}</span>
                  <span className="truncate fade" title={c.merchant}>
                    {c.merchant}
                  </span>
                  <span className="muted fade">{CARE[c.kind]}</span>
                  <span className="truncate muted fade" title={c.account}>
                    {c.account}
                  </span>
                  <span className="num fade">{fmtMoney(c.cents)}</span>
                  <span className="receipt-cell">
                    {dropOn === c.id ? (
                      <span className="small">Drop to attach{picked.has(c.id) && picked.size > 1 ? ` to ${picked.size}` : ''}</span>
                    ) : c.receipt ? (
                      <>
                        <button className={`receipt-link ${c.receiptFound ? '' : 'gone'}`} title={c.receipt} onClick={() => run(api.openReceipt(c.receipt!))}>
                          <Icon name="paperclip" size={13} />
                          <span className="truncate">{c.receiptFound ? fileLabel(c.receipt) : 'File missing'}</span>
                        </button>
                        <button className="receipt-x" title="Remove receipt" aria-label="Remove receipt" onClick={() => run(api.detachReceipt([c.id]))}>
                          <Icon name="x" size={11} strokeWidth={2.2} />
                        </button>
                      </>
                    ) : c.status === 'not' || c.status === 'before' ? null : (
                      <button className="receipt-add" onClick={() => attach(forRow(c.id))}>
                        <Icon name="plus" size={12} /> Add
                      </button>
                    )}
                  </span>
                  <span>
                    {c.status === 'before' ? (
                      <span className="muted small">Before the HSA</span>
                    ) : (
                      <select className="select small" aria-label="HSA" value={c.status} onChange={(e) => setHsa([c.id], e.target.value)}>
                        <option value="owed">Not paid back</option>
                        <option value="reimbursed">Paid back</option>
                        <option value="not">Doesn't qualify</option>
                      </select>
                    )}
                  </span>
                </div>
              ))}
              {settled.length > 0 && (
                <button className="care-more" onClick={() => setShowSettled(!showSettled)}>
                  {showSettled ? 'Hide' : 'Show'} {settled.length} paid back or not qualifying
                </button>
              )}
            </div>
          )}
        </section>

        {other.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Also covered</h2>
            </div>
            <div className="asset-table" role="table">
              <div className="other-row head" role="row">
                <span>Benefit</span>
                <span>What you get</span>
                <span className="num">You / check</span>
                <span className="num">{employer} / check</span>
              </div>
              {other.map((p) => (
                <div className="other-row" role="row" key={p.name}>
                  <span>{p.name}</span>
                  <span className="muted">{p.notes ?? '—'}</span>
                  <span className="num">{p.perCheckCents === null ? '—' : `${fmtMoney(p.perCheckCents)}${p.taxed === 'post' ? ' after tax' : ''}`}</span>
                  <span className="num">{p.employerPerCheckCents === null ? '—' : fmtMoney(p.employerPerCheckCents)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  )
}

function PlanCard({ plan: p, employer, last }: { plan: BenefitPlan; employer: string; last?: { day: string; merchant: string } }): ReactNode {
  const oon = p.costs.some((c) => c.outOfNetwork)
  const facts = [
    p.kind !== 'medical' && p.deductibleCents !== null ? `Deductible ${fmtMoneyRound(p.deductibleCents)}` : null,
    p.annualMaxCents !== null ? `Plan pays up to ${fmtMoneyRound(p.annualMaxCents)} a year` : null
  ].filter(Boolean)
  return (
    <div className="card plan-card">
      <div>
        <div className="label-muted">{p.name}</div>
        <h2>{p.carrier ? [p.carrier, p.network].filter(Boolean).join(' · ') : [p.name, p.network].filter(Boolean).join(' ')}</h2>
        {(p.coverage || p.perCheckCents !== null || p.employerPerCheckCents !== null) && (
          <div className="plan-terms">
            {p.coverage && (
              <div>
                <span>Covers</span>
                <span>{p.coverage}</span>
              </div>
            )}
            {p.perCheckCents !== null && (
              <div>
                <span>You pay</span>
                <span>
                  <span className="mono">{fmtMoney(p.perCheckCents)}</span> a check{p.taxed === 'pre' ? ', before tax' : p.taxed === 'post' ? ', after tax' : ''}
                </span>
              </div>
            )}
            {p.employerPerCheckCents !== null && (
              <div>
                <span>{employer} pays</span>
                <span>
                  <span className="mono">{fmtMoney(p.employerPerCheckCents)}</span> a check
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      {p.kind === 'medical' && <Stages plan={p} />}
      {facts.length > 0 && <div className="small">{facts.join(' · ')}</div>}
      {p.costs.length > 0 ? (
        <div className="cost-table">
          <div className={`cost-row head ${oon ? 'oon' : ''}`}>
            <span>If you need</span>
            <span>You pay</span>
            {oon && <span>Out of network</span>}
          </div>
          {p.costs.map((c) => (
            <div className={`cost-row ${oon ? 'oon' : ''}`} key={c.what}>
              <span>{c.what}</span>
              <span>{c.inNetwork}</span>
              {oon && <span className="muted">{c.outOfNetwork ?? '—'}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="muted small">No plan details yet</div>
      )}
      {p.notes && <div className="muted small">{p.notes}</div>}
      <div className="plan-foot">
        {p.website && (
          <button className="btn small" onClick={() => void api.openExternal(p.website!)}>
            <Icon name="external" size={13} /> Find care
          </button>
        )}
        {p.phone && <span className="mono small">{p.phone}</span>}
        {last && (
          <span className="muted small">
            Last paid visit {fmtDay(last.day)} · {last.merchant}
          </span>
        )}
      </div>
    </div>
  )
}

/** The year's three stretches on a medical plan: the deductible, the shared part, and nothing after the max. */
function Stages({ plan: p }: { plan: BenefitPlan }): ReactNode {
  const ded = p.deductibleCents
  const max = p.outOfPocketMaxCents
  if (ded === null || max === null) return null
  const shared = max > ded && p.coinsurancePct !== 0
  const dedW = shared ? Math.min(55, Math.max(22, (ded / max) * 75)) : 75
  const midW = shared ? 75 - dedW : 0
  const met = p.metCents
  const at = met === null ? null : shared ? (met <= ded ? (met / ded) * dedW : dedW + (Math.min(met - ded, max - ded) / (max - ded)) * midW) : (Math.min(met, max) / max) * dedW
  return (
    <div className="stages">
      <div className="stage-bar">
        <span className="stage s1" style={{ width: `${dedW}%` }} />
        {shared && <span className="stage s2" style={{ width: `${midW}%` }} />}
        <span className="stage s3" style={{ width: '25%' }} />
        {at !== null && <span className="stage-marker" style={{ left: `${at}%` }} />}
      </div>
      <div className="stage-labels">
        <span style={{ width: `${dedW}%` }}>
          <b>You pay the bill</b>
          <small>first {fmtMoneyRound(ded)} a year</small>
        </span>
        {shared && (
          <span style={{ width: `${midW}%` }}>
            <b>{p.coinsurancePct !== null && p.coinsurancePct !== undefined ? `You pay ${p.coinsurancePct}%` : 'You pay a share'}</b>
            <small>until {fmtMoneyRound(max)} in all</small>
          </span>
        )}
        <span style={{ width: '25%' }}>
          <b>You pay $0</b>
          <small>rest of the year</small>
        </span>
      </div>
      {met !== null && (
        <div className="small muted">
          Paid toward it: {fmtMoney(met)}
          {p.metAsOf ? ` as of ${fmtDay(p.metAsOf)}` : ''}
        </div>
      )}
    </div>
  )
}

// ---------- HSA contributions ----------

/** What goes into the HSA this year against the limit, and every year's contributions. */
function HsaContributions({ data }: { data: BenefitsView }): ReactNode {
  const h = data.hsa
  const projected = h.projectedCents
  const limit = h.limitCents
  if (projected === null) {
    // This year isn't known yet (a new year before its first paystub): earlier years still show.
    return data.hsaYears.length > 1 ? (
      <section className="asset-group">
        <div className="asset-group-head">
          <h2>HSA contributions</h2>
        </div>
        <HsaYearsChart years={data.hsaYears} />
      </section>
    ) : null
  }
  const soFar = Math.min(h.contributedCents ?? 0, projected)
  // Every amount in the legend is what its label says; past the limit, the over part is copper
  // (solid once it's in, lighter while it's still to come).
  const segments: MeterSegment[] =
    limit === null || projected <= limit
      ? [
          { key: 'sofar', cents: soFar, color: 'var(--chart-teal)', label: 'Put in so far' },
          { key: 'tocome', cents: projected - soFar, color: 'var(--chart-teal)', light: true, label: 'Still to come' },
          ...(limit !== null ? [{ key: 'room', cents: limit - projected, color: '', track: true, label: 'Room left' }] : [])
        ]
      : soFar <= limit
        ? [
            { key: 'sofar', cents: soFar, color: 'var(--chart-teal)', label: 'Put in so far' },
            { key: 'tocome', cents: limit - soFar, color: 'var(--chart-teal)', light: true, label: 'Still to come, within the limit' },
            { key: 'over', cents: projected - limit, color: 'var(--chart-copper)', light: true, label: 'Still to come, over the limit' }
          ]
        : [
            { key: 'within', cents: limit, color: 'var(--chart-teal)', label: 'Within the limit' },
            { key: 'overin', cents: soFar - limit, color: 'var(--chart-copper)', label: 'Over the limit, put in' },
            { key: 'over', cents: projected - soFar, color: 'var(--chart-copper)', light: true, label: 'Over the limit, still to come' }
          ]
  const perCheck = [
    h.perCheckCents !== null && `${fmtMoneyRound(h.perCheckCents)} a check${h.nextCents !== null && h.nextFrom ? `, ${fmtMoneyRound(h.nextCents)} from ${fmtDay(h.nextFrom)}` : ''}`,
    h.employerPerCheckCents ? `${data.employer ?? 'Employer'} adds ${fmtMoneyRound(h.employerPerCheckCents)}` : null,
    `${h.checksLeft} check${h.checksLeft === 1 ? '' : 's'} left`
  ].filter(Boolean)
  return (
    <section className="asset-group">
      <div className="asset-group-head">
        <h2>HSA contributions</h2>
      </div>
      <div className="tax-hero">
        <div className="tax-hero-top">
          <div>
            <div className="label-muted">{data.year}</div>
            <div className="tax-hero-value">
              {fmtMoneyRound(projected)}
              <span className="tax-hero-unit">by Dec 31</span>
            </div>
            <div className="tax-hero-sub">{perCheck.join(' · ')}</div>
          </div>
          {limit !== null && (
            <div className="tax-hero-side">
              <div className="label-muted">Limit</div>
              <div className="tax-hero-side-value">
                {fmtMoneyRound(limit)}
                {h.limitProvisional ? ' est.' : ''}
              </div>
              <div className={`delta ${projected > limit ? 'tax-owed' : 'tax-back'}`}>{projected > limit ? `Over by ${fmtMoneyRound(projected - limit)}` : `${fmtMoneyRound(limit - projected)} room · self-only`}</div>
            </div>
          )}
        </div>
        <Meter segments={segments} />
      </div>
      <HsaYearsChart years={data.hsaYears} />
    </section>
  )
}

const YEARS_H = 120
const YEARS_AXIS = 26

/** Each year's contributions as a column, this year's still-to-come part lighter, with that year's limit as a hairline. */
function HsaYearsChart({ years }: { years: HsaYear[] }): ReactNode {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  if (years.length < 2) return null
  const top = 18
  const max = Math.max(...years.map((y) => Math.max(y.cents, y.limitCents ?? 0)))
  const scale = (YEARS_H - top) / (max || 1)
  const band = width / years.length
  const w = Math.min(36, band * 0.45)
  const yOf = (cents: number): number => YEARS_H - cents * scale
  const tip = hover === null ? null : years[hover]
  const tipX = hover === null ? 0 : band * hover + band / 2
  return (
    <div className="refund-chart hsa-years" ref={ref} style={{ height: YEARS_H + YEARS_AXIS }}>
      {width > 0 && (
        <svg width={width} height={YEARS_H + YEARS_AXIS} role="group" aria-label="HSA contributions by year">
          <line x1={0} x2={width} y1={YEARS_H} y2={YEARS_H} stroke="var(--ink-600)" strokeWidth={1} />
          {years.map((y, i) => {
            const cx = band * i + band / 2
            const x = cx - w / 2
            const within = y.limitCents === null ? y.cents : Math.min(y.cents, y.limitCents)
            const done = y.soFarCents === null ? within : Math.min(y.soFarCents, within)
            const est = y.soFarCents !== null
            return (
              <g key={y.year}>
                {hover === i && <rect x={band * i + 2} y={0} width={band - 4} height={YEARS_H} fill="var(--chart-cursor)" />}
                {done > 0 && <rect x={x} y={yOf(done)} width={w} height={done * scale} rx={1} fill="var(--chart-teal)" />}
                {within > done && <rect x={x} y={yOf(within)} width={w} height={Math.max(0, (within - done) * scale - 2)} rx={1} fill="var(--chart-teal)" opacity={0.42} />}
                {y.limitCents !== null && y.cents > y.limitCents && <rect x={x} y={yOf(y.cents)} width={w} height={Math.max(0, (y.cents - y.limitCents) * scale - 2)} rx={1} fill="var(--chart-copper)" />}
                {y.limitCents !== null && <line x1={x - 8} x2={x + w + 8} y1={yOf(y.limitCents)} y2={yOf(y.limitCents)} stroke="var(--ink-300)" strokeWidth={1} />}
                <text x={cx} y={yOf(Math.max(y.cents, y.limitCents ?? 0)) - 6} textAnchor="middle" className="refund-value">
                  {fmtMoneyRound(y.cents)}
                </text>
                <text x={cx} y={YEARS_H + YEARS_AXIS - 8} textAnchor="middle" className={`refund-year ${hover === i ? 'on' : ''}`}>
                  {est ? `${y.year} est.` : y.year}
                </text>
                <rect
                  x={band * i}
                  y={0}
                  width={band}
                  height={YEARS_H + YEARS_AXIS}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${y.year}: ${fmtMoneyRound(y.cents)}${y.limitCents !== null ? ` of ${fmtMoneyRound(y.limitCents)}${y.limitProvisional ? ' est.' : ''}` : ''}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>
      )}
      {tip && hover !== null && (
        <div className="chart-tooltip refund-tip" style={hover < years.length / 2 ? { left: tipX + w / 2 + 12 } : { right: width - (tipX - w / 2) + 12 }}>
          <div className="label-muted">
            {tip.year}
            {tip.soFarCents !== null ? ' · by Dec 31' : ''}
          </div>
          <div className="row">
            <strong className="num">{fmtMoneyRound(tip.cents)}</strong>
            <span className="muted">{tip.limitCents !== null ? `of ${fmtMoneyRound(tip.limitCents)}${tip.limitProvisional ? ' est.' : ''} limit` : 'put in'}</span>
          </div>
          <div className="row small muted">
            {[tip.soFarCents !== null && `${fmtMoneyRound(tip.soFarCents)} so far`, tip.employerCents ? `${fmtMoneyRound(tip.employerCents)} from the employer` : null, tip.source].filter(Boolean).join(' · ')}
          </div>
        </div>
      )}
    </div>
  )
}
