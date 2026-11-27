import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { CREDIT_BUREAUS, SCORE_MODELS, type CreditBureau, type CreditScore, type CreditView } from '../../../shared/types'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, errorMessage, fmtDay, fmtMoneyRound, todayKey } from '../lib'
import { Meter, useWidth } from '../Meter'
import { EmptyCard } from '../Empty'

const money = (cents: number | null): string => (cents === null ? '—' : fmtMoneyRound(cents))
const pct = (p: number | null): string => (p === null ? '—' : `${Math.round(p * 100)}%`)
/** Utilization above 30% weighs on a score; under 10% helps it. */
const usedClass = (p: number | null): string => (p === null ? '' : p >= 0.3 ? 'tax-owed' : p < 0.1 ? 'tax-back' : '')
const span = (months: number): string => {
  const y = Math.floor(months / 12)
  const m = months % 12
  return y ? (m ? `${y} yr ${m} mo` : `${y} yr`) : `${m} mo`
}
const monthsSince = (day: string, today: string): number => (Number(today.slice(0, 4)) - Number(day.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(day.slice(5, 7))
const month = (d: string | null): string => (d ? new Date(`${d.slice(0, 7)}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—')

export const scoreKey = (s: Pick<CreditScore, 'bureau' | 'model' | 'source'>): string => [s.bureau ?? '', s.model ?? '', s.source ?? ''].join('|')
const place = (s: CreditScore): string => [s.source, s.bureau, s.model].filter(Boolean).join(' · ') || 'Score'
/** FICO's ranges. */
const band = (score: number): string => (score >= 800 ? 'Exceptional' : score >= 740 ? 'Very good' : score >= 670 ? 'Good' : score >= 580 ? 'Fair' : 'Poor')
const COLORS = ['var(--chart-teal)', 'var(--chart-copper)', 'var(--chart-slate)', 'var(--chart-plum)', 'var(--chart-blue)']
const BUREAU_SHORT: Record<CreditBureau, string> = { Experian: 'EX', Equifax: 'EQ', TransUnion: 'TU' }

export default function Credit(): ReactNode {
  const { tick, toast } = useApp()
  const [data, setData] = useState<CreditView | null>(null)
  const [open, setOpen] = useState<CreditBureau | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    api.getCredit().then(setData, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  if (!data) return <PageHeader title="Credit" />

  const fail = (e: unknown): void => toast(errorMessage(e), 'error')
  const today = todayKey()
  const head = data.latest[0] ?? null
  const change = head?.previous ? head.score.score - head.previous.score : null
  const keys = data.latest.map((l) => l.key)
  const color = (s: CreditScore): string => COLORS[keys.indexOf(scoreKey(s)) % COLORS.length]
  const u = data.utilization
  const noLimit = u.cards.filter((c) => c.limitCents === null).length
  const nextOff = [...data.inquiries].sort((a, b) => a.dropsOff.localeCompare(b.dropsOff))[0]
  // Each score's change from the one before it in the same place.
  const prior = new Map<string, number>()
  for (let i = 0; i < data.scores.length; i++) {
    const s = data.scores[i]
    const before = data.scores.slice(i + 1).find((x) => scoreKey(x) === scoreKey(s))
    if (before) prior.set(s.id, s.score - before.score)
  }

  return (
    <>
      <PageHeader title="Credit">
        <label className="check">
          Reminder
          <select
            className="select"
            aria-label="Reminder"
            value={data.reminderDay ?? ''}
            onChange={(e) => {
              const day = e.target.value ? Number(e.target.value) : null
              setData({ ...data, reminderDay: day })
              api.setCreditReminder(day).catch(fail)
            }}
          >
            <option value="">Off</option>
            {Array.from({ length: 28 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                Day {i + 1}
              </option>
            ))}
            <option value={31}>Last day</option>
          </select>
        </label>
        {data.scores.length > 0 && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} /> Add score
          </button>
        )}
      </PageHeader>
      <div className="page">
        <div className="stat-strip five">
          <div className="tile">
            <div className="label-muted">Score</div>
            <div className="tile-value">{head ? head.score.score : '—'}</div>
            {head && (
              <div className="tile-sub" title={place(head.score)}>
                {band(head.score.score)} · {fmtDay(head.score.day).replace(`, ${today.slice(0, 4)}`, '')}
                {change !== null && change !== 0 && <span className={change > 0 ? 'tax-back' : 'tax-owed'}>{`${change > 0 ? '+' : '−'}${Math.abs(change)}`}</span>}
              </div>
            )}
          </div>
          <div className="tile">
            <div className="label-muted">Utilization</div>
            <div className={`tile-value ${u.pct !== null && u.pct >= 0.3 ? 'bad' : ''}`}>{pct(u.pct)}</div>
            <div className="tile-sub">
              {u.limitCents > 0 ? `${fmtMoneyRound(u.balanceCents)} of ${fmtMoneyRound(u.limitCents)}` : 'No limits'}
              {noLimit > 0 && u.limitCents > 0 && ` · ${noLimit} without a limit`}
            </div>
          </div>
          <div className="tile">
            <div className="label-muted">Average age</div>
            <div className="tile-value">{data.age.averageMonths === null ? '—' : span(data.age.averageMonths)}</div>
            {data.age.oldest && (
              <div className="tile-sub" title={`${data.age.oldest.name} · ${data.age.accounts} accounts`}>
                Oldest {span(monthsSince(data.age.oldest.day, today))}
              </div>
            )}
          </div>
          <div className="tile">
            <div className="label-muted">Hard inquiries</div>
            <div className="tile-value">{data.reports.length ? data.inquiries.length : '—'}</div>
            {nextOff && <div className="tile-sub">Next off {fmtDay(nextOff.dropsOff)}</div>}
          </div>
          <div className="tile">
            <div className="label-muted">Negative</div>
            <div className={`tile-value ${data.negatives.length ? 'bad' : ''}`}>{data.reports.length ? data.negatives.length : '—'}</div>
            {data.reports.length > 0 && <div className="tile-sub">{data.reports.map((r) => BUREAU_SHORT[r.bureau]).join(' · ')}</div>}
          </div>
        </div>

        {data.scores.length === 0 ? (
          <EmptyCard style={{ marginTop: 30 }}>
            <button className="btn primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={15} /> Add score
            </button>
          </EmptyCard>
        ) : (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Scores</h2>
              {data.latest.length > 1 && (
                <div className="pay-legend returns-legend">
                  {data.latest.map((l) => (
                    <div className="pay-key" key={l.key}>
                      <span className="pay-swatch" style={{ background: color(l.score) }} />
                      <span>{place(l.score)}</span>
                      <span className="pay-key-value">{l.score.score}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {data.scores.length > 1 && <ScoreChart scores={data.scores} color={color} />}
            <div className="asset-table" role="table">
              <div className="credit-score-row head" role="row">
                <span>Date</span>
                <span className="num">Score</span>
                <span className="num">Change</span>
                <span>Bureau</span>
                <span>Model</span>
                <span>Source</span>
                <span />
              </div>
              {data.scores.map((s) => {
                const d = prior.get(s.id) ?? null
                return (
                  <div className="credit-score-row" role="row" key={s.id} title={s.note ?? undefined}>
                    <span className="mono small">{fmtDay(s.day)}</span>
                    <span className="num">
                      <span className="credit-dot" style={{ background: color(s) }} />
                      {s.score}
                    </span>
                    <span className={`num ${d === null || d === 0 ? 'muted' : d > 0 ? 'tax-back' : 'tax-owed'}`}>{d === null ? '—' : d === 0 ? '0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`}</span>
                    <span className="truncate">{s.bureau ?? '—'}</span>
                    <span className="truncate muted">{s.model ?? '—'}</span>
                    <span className="truncate muted">{s.source ?? '—'}</span>
                    <button className="btn small ghost icon-btn" aria-label={`Delete the ${s.score} of ${fmtDay(s.day)}`} onClick={() => api.deleteCreditScore(s.id).catch(fail)}>
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {u.cards.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Utilization</h2>
              <span className="label-muted">
                {u.cards.length} card{u.cards.length === 1 ? '' : 's'}
              </span>
            </div>
            {u.limitCents > 0 && (
              <div className="credit-meter">
                <Meter
                  segments={[
                    { key: 'used', cents: u.balanceCents, color: u.pct !== null && u.pct >= 0.3 ? 'var(--chart-copper)' : 'var(--chart-teal)', label: 'Balance' },
                    { key: 'room', cents: Math.max(0, u.limitCents - u.balanceCents), color: '', track: true, label: 'Available' }
                  ]}
                />
              </div>
            )}
            <div className="asset-table" role="table">
              <div className="credit-card-row head" role="row">
                <span>Card</span>
                <span className="num">Balance</span>
                <span className="num">Limit</span>
                <span className="num">Used</span>
                <span>Limit from</span>
              </div>
              {u.cards.map((c) => (
                <div className="credit-card-row" role="row" key={c.accountId}>
                  <span className="truncate">{c.name}</span>
                  <span className="num">{fmtMoneyRound(c.balanceCents)}</span>
                  <span className="num">{money(c.limitCents)}</span>
                  <span className={`num ${usedClass(c.pct)}`}>{pct(c.pct)}</span>
                  <span className="truncate muted small">{[c.limitSource, c.limitAsOf && fmtDay(c.limitAsOf)].filter(Boolean).join(' · ') || '—'}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {data.negatives.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Negative</h2>
            </div>
            <ul className="tax-issues">
              {data.negatives.map((n, i) => (
                <li key={i}>
                  <span className="mono small muted">{n.bureau}</span> {n.text}
                </li>
              ))}
            </ul>
          </section>
        )}

        {data.inquiries.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Hard inquiries</h2>
              <span className="label-muted">Last 2 years</span>
            </div>
            <div className="asset-table" role="table">
              <div className="credit-inquiry-row head" role="row">
                <span>Lender</span>
                <span>Date</span>
                <span>Bureaus</span>
                <span>Drops off</span>
              </div>
              {data.inquiries.map((q) => (
                <div className="credit-inquiry-row" role="row" key={`${q.creditor}|${q.day}`}>
                  <span className="truncate">{q.creditor}</span>
                  <span className="mono small">{fmtDay(q.day)}</span>
                  <span className="muted">{q.bureaus.join(', ')}</span>
                  <span className="mono small">{fmtDay(q.dropsOff)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {data.reports.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Reports</h2>
            </div>
            <div className="asset-table" role="table">
              <div className="asset-row credit-report-row head" role="row">
                <span>Bureau</span>
                <span>Pulled</span>
                <span className="num">Open</span>
                <span className="num">Closed</span>
                <span className="num">Inquiries</span>
                <span className="num">Negative</span>
              </div>
              {data.reports.map((r) => (
                <Fragment key={r.bureau}>
                  <button className={`asset-row credit-report-row ${open === r.bureau ? 'open' : ''}`} aria-expanded={open === r.bureau} onClick={() => setOpen(open === r.bureau ? null : r.bureau)}>
                    <span>{r.bureau}</span>
                    <span className="mono small">{fmtDay(r.day)}</span>
                    <span className="num">{r.open}</span>
                    <span className="num muted">{r.closed}</span>
                    <span className="num">{r.inquiries}</span>
                    <span className={`num ${r.negatives ? 'tax-owed' : ''}`}>{r.negatives}</span>
                  </button>
                  {open === r.bureau && <ReportDetail r={r} />}
                </Fragment>
              ))}
            </div>
          </section>
        )}
      </div>
      {adding && <ScoreModal last={data.scores[0] ?? null} onClose={() => setAdding(false)} />}
    </>
  )
}

/** A score typed in from a bank's or a bureau's free score page; the last one's bureau and model come preset. */
function ScoreModal({ last, onClose }: { last: CreditScore | null; onClose: () => void }): ReactNode {
  const { toast } = useApp()
  const [f, setF] = useState({
    score: '',
    day: todayKey(),
    bureau: (last?.bureau ?? 'Experian') as CreditBureau,
    model: SCORE_MODELS.find((m) => m === last?.model) ?? SCORE_MODELS[0],
    source: last?.source ?? ''
  })
  const n = Number(f.score)
  const ok = /^\d{3}$/.test(f.score.trim()) && n >= 250 && n <= 900 && !!f.day

  async function save(): Promise<void> {
    try {
      await api.addCreditScore({ day: f.day, score: n, bureau: f.bureau, model: f.model, source: f.source.trim() || null })
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="score-title">
        <h2 id="score-title">Add score</h2>
        <div className="field-grid" style={{ marginTop: 16 }}>
          <label className="field">
            Score
            <input className="input num" autoFocus inputMode="numeric" value={f.score} onChange={(e) => setF({ ...f, score: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && ok && void save()} />
          </label>
          <label className="field">
            Date
            <input className="input" type="date" value={f.day} max={todayKey()} onChange={(e) => setF({ ...f, day: e.target.value })} />
          </label>
          <label className="field">
            Bureau
            <select className="select" value={f.bureau} onChange={(e) => setF({ ...f, bureau: e.target.value as CreditBureau })}>
              {CREDIT_BUREAUS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Model
            <select className="select" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value as (typeof SCORE_MODELS)[number] })}>
              {SCORE_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Source
            <input className="input" value={f.source} placeholder="Optional" onChange={(e) => setF({ ...f, source: e.target.value })} />
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function ReportDetail({ r }: { r: CreditView['reports'][number] }): ReactNode {
  const { toast } = useApp()
  return (
    <div className="tax-detail">
      {r.note && <div className="small muted credit-note">{r.note}</div>}
      <div className="credit-trade-row head">
        <span>Account</span>
        <span>Kind</span>
        <span>Opened</span>
        <span>Status</span>
        <span className="num">Limit</span>
        <span className="num">Balance</span>
        <span>In the app</span>
      </div>
      {r.tradelines.map((t, i) => (
        <div className={`credit-trade-row ${t.closed ? 'closed' : ''}`} key={`${t.creditor}|${t.last4}|${i}`} title={t.late.length ? `Late ${t.late.join(', ')}` : undefined}>
          <span className="truncate" title={t.creditor}>
            {t.creditor}
            {t.last4 && <span className="mono small muted"> {t.last4}</span>}
          </span>
          <span className="muted">{t.kind}</span>
          <span className="mono small">
            {month(t.opened)}
            {t.closed && <span className="muted"> – {month(t.closed)}</span>}
          </span>
          <span className={`truncate ${t.late.length || t.kind === 'collection' ? 'tax-owed' : ''}`} title={t.status || undefined}>{t.status || '—'}</span>
          <span className="num">{money(t.limitCents)}</span>
          <span className="num">{money(t.balanceCents)}</span>
          <span className={`truncate ${t.accountName ? '' : 'muted'}`} title={t.accountName ?? undefined}>{t.accountName ?? '—'}</span>
        </div>
      ))}
      {r.file && (
        <button className={`tax-form credit-file ${r.found ? '' : 'gone'}`} title={r.file} disabled={!r.found} onClick={() => api.openCreditReport(r.file!).catch((e) => toast(errorMessage(e), 'error'))}>
          <Icon name="paperclip" size={12} />
          <span className="truncate">{r.file.split(/[\\/]/).pop()}</span>
        </button>
      )}
    </div>
  )
}

// ---------- chart ----------

const CHART_H = 180
const AXIS_H = 26
const GUTTER = 40
const PAD = 14

/** Every score over time, one line per place it's followed. */
function ScoreChart({ scores, color }: { scores: CreditScore[]; color: (s: CreditScore) => string }): ReactNode {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<string | null>(null)
  const asc = [...scores].sort((a, b) => a.day.localeCompare(b.day))
  const t0 = Date.parse(asc[0].day)
  const t1 = Date.parse(asc[asc.length - 1].day)
  const values = asc.map((s) => s.score)
  const lo = Math.floor((Math.min(...values) - 15) / 50) * 50
  const hi = Math.ceil((Math.max(...values) + 15) / 50) * 50
  const top = 12
  const bottom = 12
  const plot = Math.max(0, width - GUTTER - PAD * 2)
  const x = (day: string): number => GUTTER + PAD + (t1 === t0 ? plot / 2 : ((Date.parse(day) - t0) / (t1 - t0)) * plot)
  const y = (score: number): number => top + ((hi - score) / (hi - lo || 1)) * (CHART_H - top - bottom)
  const grid: number[] = []
  for (let g = lo; g <= hi; g += 50) grid.push(g)
  // Year marks once the scores span more than a year; the first and last dates otherwise.
  const firstYear = Number(asc[0].day.slice(0, 4))
  const lastYear = Number(asc[asc.length - 1].day.slice(0, 4))
  const marks =
    t1 - t0 > 400 * 86_400_000
      ? Array.from({ length: lastYear - firstYear }, (_, i) => ({ day: `${firstYear + i + 1}-01-01`, label: String(firstYear + i + 1) }))
      : [...new Set([asc[0].day, asc[asc.length - 1].day])].map((d) => ({ day: d, label: month(d) }))
  const lines = new Map<string, CreditScore[]>()
  for (const s of asc) lines.set(scoreKey(s), [...(lines.get(scoreKey(s)) ?? []), s])
  const tip = hover ? asc.find((s) => s.id === hover) : undefined
  const tipX = tip ? x(tip.day) : 0
  return (
    <div className="refund-chart" ref={ref} style={{ height: CHART_H + AXIS_H }}>
      {width > 0 && (
        <svg width={width} height={CHART_H + AXIS_H} role="img" aria-label="Credit scores over time">
          {grid.map((g) => (
            <g key={g}>
              <line x1={GUTTER} x2={width} y1={y(g)} y2={y(g)} stroke="var(--ink-800)" strokeWidth={1} />
              <text x={0} y={y(g) + 3.5} className="refund-tick">
                {g}
              </text>
            </g>
          ))}
          {marks.map((m) => (
            <text key={m.day} x={x(m.day)} y={CHART_H + AXIS_H - 8} textAnchor={x(m.day) < GUTTER + 40 ? 'start' : x(m.day) > width - 40 ? 'end' : 'middle'} className="refund-year">
              {m.label}
            </text>
          ))}
          {[...lines.values()].map((pts) => (
            <polyline key={scoreKey(pts[0])} points={pts.map((s) => `${x(s.day)},${y(s.score)}`).join(' ')} fill="none" stroke={color(pts[0])} strokeWidth={1.6} strokeLinejoin="round" />
          ))}
          {asc.map((s) => (
            <circle
              key={s.id}
              cx={x(s.day)}
              cy={y(s.score)}
              r={hover === s.id ? 5 : 3.5}
              fill={color(s)}
              stroke="var(--card-solid)"
              strokeWidth={1.5}
              onPointerEnter={() => setHover(s.id)}
              onPointerLeave={() => setHover(null)}
            />
          ))}
        </svg>
      )}
      {tip && (
        <div className="chart-tooltip refund-tip" style={tipX < width / 2 ? { left: tipX + 14 } : { right: width - tipX + 14 }}>
          <div className="label-muted">{fmtDay(tip.day)}</div>
          <div className="row">
            <strong className="num">{tip.score}</strong>
            <span className="muted">{band(tip.score)}</span>
          </div>
          <div className="row small muted">{place(tip)}</div>
        </div>
      )}
    </div>
  )
}
