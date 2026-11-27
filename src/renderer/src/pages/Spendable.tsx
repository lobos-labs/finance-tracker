import { useEffect, useState, type ReactNode } from 'react'
import { SPEND_RISKS, type SpendAccount, type SpendItem, type SpendRisk, type Spendable } from '../../../shared/types'
import { useApp } from '../App'
import { useWidth } from '../Meter'
import { api, errorMessage, fmtMoneyCompact, fmtMoneyRound, numbersHidden } from '../lib'
import { axisLabels, barsInto, cushionLabel, type Anchor, type Bar } from './spendAxis'
import { amountText, monthDay } from './Upcoming'
import { spendNote } from './homeView'

// What can be spent today without the balance dipping under the cushion, at
// each risk, and a column for each coming day: what's left after the day's
// expected spending (solid), with that spending stacked on top (outlined), so
// each day reads as a short walk from where it starts to what remains.

const DAYS = 14
const CHART_H = 170
/** The day under each column, then what it spends. */
const AXIS_H = 44
const GUTTER = 46
const TOP = 20

const weekday = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
export const signedRound = (cents: number): string => `${cents < 0 ? '−' : ''}${fmtMoneyRound(Math.abs(cents))}`

/** Two or three round values between lo and hi for the gridlines. */
function ticks(lo: number, hi: number): number[] {
  const m = Math.max(hi, -lo) / 2
  if (m <= 0) return []
  const mag = 10 ** Math.floor(Math.log10(m))
  const step = m / mag >= 5 ? 5 * mag : m / mag >= 2 ? 2 * mag : mag
  const out: number[] = []
  for (let k = 1; k <= 3; k++) {
    if (k * step <= hi) out.push(k * step)
    if (-k * step >= lo) out.push(-k * step)
  }
  return out
}

/** A day's walk: where it starts, what goes out (bills and everyday trips), what's left, what comes in. */
const walk = (d: SpendAccount['days'][number]): { start: number; spend: number; left: number; pay: number } => {
  const spend = -d.outCents
  return { start: d.startCents, spend, left: d.startCents - spend, pay: d.inCents }
}

export function SpendableCard({ spend }: { spend: Spendable }): ReactNode {
  const { toast } = useApp()
  const a = spend.accounts.find((x) => x.id === spend.accountId) ?? spend.accounts[0]
  const save = (patch: { risk?: SpendRisk; cushionCents?: number; accountId?: string | null }): void => {
    api.setSpendSettings(patch).catch((e) => toast(errorMessage(e), 'error'))
  }
  const risk = SPEND_RISKS.find((r) => r.id === spend.risk)!
  // Most likely and Best case can overestimate: an asterisk on the chosen figure and its one line under the card.
  const note = spendNote(spend.risk)
  return (
    <div className="card spend-card">
      <div className="spend-top">
        <h2>Spendable</h2>
        <div className="spacer" />
        {a && spend.accounts.length > 1 && (
          <select className="select" value={a.id} aria-label="Account" onChange={(e) => save({ accountId: e.target.value })}>
            {spend.accounts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        <Cushion cents={spend.cushionCents} onSave={(cushionCents) => save({ cushionCents })} />
      </div>
      {a ? (
        <>
          <div className="spend-risks" role="radiogroup" aria-label="Risk">
            {SPEND_RISKS.map((r) => (
              <button key={r.id} role="radio" aria-checked={spend.risk === r.id} className={`spend-risk ${spend.risk === r.id ? 'on' : ''}`} onClick={() => spend.risk !== r.id && save({ risk: r.id })}>
                <span className="label-muted">{r.label}</span>
                <span className={`spend-risk-value ${a.byRisk[r.id] < 0 ? 'neg' : ''}`}>
                  {signedRound(a.byRisk[r.id])}
                  {spend.risk === r.id && note && <span className="spend-mark">*</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="spend-sub">
            {[risk.assumes, a.perDayCents !== null && a.nextPayday ? `${signedRound(a.perDayCents)}/day until ${monthDay(a.nextPayday)}` : null, `low ${monthDay(a.lowDay)}`, spend.accounts.length === 1 ? a.name : null].filter(Boolean).join(' · ')}
          </div>
          <SpendChart account={a} items={spend.items.filter((i) => i.accountId === a.id)} cushionCents={spend.cushionCents} />
          {note && <div className="spend-note muted small">{note}</div>}
        </>
      ) : (
        <div className="muted small">No current balance</div>
      )}
    </div>
  )
}

function Cushion({ cents, onSave }: { cents: number; onSave: (cents: number) => void }): ReactNode {
  const [text, setText] = useState(cents ? String(Math.round(cents / 100)) : '')
  useEffect(() => setText(cents ? String(Math.round(cents / 100)) : ''), [cents])
  const commit = (): void => {
    const n = Math.round(Number(text.replace(/[$,\s]/g, '') || 0) * 100)
    if (Number.isFinite(n) && n >= 0 && n !== cents) onSave(n)
    else setText(cents ? String(Math.round(cents / 100)) : '')
  }
  return (
    <label className="spend-cushion">
      <span className="label-muted">Cushion</span>
      <input className="input num" inputMode="decimal" placeholder="$0" value={text} aria-label="Cushion" onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  )
}

/** A column a day from one baseline: what's left solid, the day's spending outlined above it, the cushion as a line. */
function SpendChart({ account, items, cushionCents }: { account: SpendAccount; items: SpendItem[]; cushionCents: number }): ReactNode {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  // Two weeks, or through the low day when it comes later.
  const days = account.days.slice(0, Math.max(DAYS, account.days.findIndex((d) => d.day === account.lowDay) + 1))
  const walks = days.map(walk)
  const hi = Math.max(0, cushionCents, ...walks.map((w) => Math.max(w.start, w.left)))
  const lo = Math.min(0, ...walks.map((w) => w.left))
  const scale = (CHART_H - TOP - 4) / (hi - lo || 1)
  const zero = TOP + hi * scale
  const y = (cents: number): number => zero - cents * scale
  const band = Math.max(0, width - GUTTER) / days.length
  const w = Math.min(24, band * 0.55)
  const lefts = walks.map((x) => x.left)
  const low = lefts.indexOf(Math.min(...lefts))
  const tip = hover === null ? null : days[hover]
  const tipWalk = hover === null ? null : walks[hover]
  const tipX = hover === null ? 0 : GUTTER + band * hover + band / 2
  // A day's spending in as few characters as the column allows.
  const short = (cents: number): string => {
    const text = cents < 100_000 ? fmtMoneyRound(cents) : fmtMoneyCompact(cents).replace(/\.0(?=[KM])/, '')
    return `−${band < 38 ? text.replace('$', '') : text}`
  }
  // Under each column its day and what it spends, as many as fit as they draw (spendAxis).
  const at = { width, gutter: GUTTER, hidden: numbersHidden() }
  const axis = axisLabels(
    days.map((d, i) => ({ day: d.day, name: monthDay(d.day), out: walks[i].spend > 0 ? short(walks[i].spend) : null })),
    at
  )
  // The low day's figure over its column, and the cushion line's name where neither that figure nor a bar is on it,
  // else over the bars.
  const lowX = GUTTER + band * low + band / 2
  const lowAnchor: Anchor = lowX > width - 40 ? 'end' : lowX < GUTTER + 40 ? 'start' : 'middle'
  const lowLabel = low < 0 ? null : { text: signedRound(lefts[low]), x: lowX, anchor: lowAnchor, y: Math.min(y(Math.max(lefts[low], 0)), y(Math.max(walks[low].start, 0))) - 6 }
  // Each column's bars as drawn below: what's left solid, the day's spending outlined (its 1 px stroke half outside).
  const columns = walks.map(({ start, spend, left }, i): Bar | null => {
    const cx = GUTTER + band * i + band / 2
    const tops = [...(left !== 0 ? [y(Math.max(left, 0))] : []), ...(spend > 0 && y(Math.max(left, 0)) - y(Math.max(start, 0)) > 0.5 ? [y(Math.max(start, 0)) - 0.5] : [])]
    return tops.length ? { left: cx - w / 2, right: cx + w / 2, top: Math.min(...tops) } : null
  })
  const bars = columns.filter((b): b is Bar => b !== null)
  // Where a later column's bar rises into the low day's figure, it is drawn over the columns, as the cushion's name is.
  const lowOver = !!lowLabel && barsInto(lowLabel, columns.slice(low + 1).filter((b): b is Bar => b !== null), at.hidden)
  const cushionY = y(cushionCents) - 4
  const cushion = cushionCents > 0 ? cushionLabel('Cushion', cushionY, lowLabel, bars, at) : null
  return (
    <div className="spend-chart" ref={ref} style={{ height: CHART_H + AXIS_H }}>
      {width > 0 && (
        <svg width={width} height={CHART_H + AXIS_H} role="group" aria-label={`What's left each day after its spending, ${account.name}`}>
          {ticks(lo, hi).map((t) => (
            <g key={t}>
              <line x1={GUTTER} x2={width} y1={y(t)} y2={y(t)} stroke="var(--ink-800)" strokeWidth={1} />
              <text x={0} y={y(t) + 3.5} className="spend-tick">
                {t < 0 ? '−' : ''}
                {fmtMoneyCompact(Math.abs(t))}
              </text>
            </g>
          ))}
          <line x1={GUTTER} x2={width} y1={zero} y2={zero} stroke="var(--ink-600)" strokeWidth={1} />
          {cushionCents > 0 && (
            <g>
              <line x1={GUTTER} x2={width} y1={y(cushionCents)} y2={y(cushionCents)} stroke="var(--ink-400)" strokeWidth={1} />
              {cushion && !cushion.over && (
                <text x={cushion.x} y={cushionY} textAnchor={cushion.anchor} className="spend-tick">
                  {cushion.text}
                </text>
              )}
            </g>
          )}
          {days.map((d, i) => {
            const { start, spend, left } = walks[i]
            const cx = GUTTER + band * i + band / 2
            const under = left < cushionCents || left < 0
            const weekend = [0, 6].includes(new Date(`${d.day}T12:00:00`).getDay())
            // The solid part is what's left (down from zero when it's below); the outlined part, what the day spends.
            const solidTop = y(Math.max(left, 0))
            const solidBottom = y(Math.min(left, 0))
            const spendTop = y(Math.max(start, 0))
            const spendBottom = y(Math.max(left, 0))
            const dayLabel = axis.day[i]
            const outLabel = axis.out[i]
            return (
              <g key={d.day}>
                {hover === i && <rect x={GUTTER + band * i + 2} y={0} width={band - 4} height={CHART_H} fill="var(--chart-cursor)" />}
                {left !== 0 && <rect x={cx - w / 2} y={solidTop} width={w} height={Math.max(solidBottom - solidTop, 1)} rx={1} fill={under ? 'var(--neg)' : 'var(--chart-teal)'} />}
                {spend > 0 && spendBottom - spendTop > 0.5 && (
                  <rect x={cx - w / 2 + 0.5} y={spendTop} width={w - 1} height={Math.max(spendBottom - spendTop - 1, 1)} rx={1} fill="var(--chart-copper)" fillOpacity={0.18} stroke="var(--chart-copper)" strokeWidth={1} />
                )}
                {i === low && lowLabel && !lowOver && (
                  <text x={lowLabel.x} y={lowLabel.y} textAnchor={lowLabel.anchor} className="spend-value">
                    {lowLabel.text}
                  </text>
                )}
                {d.inCents > 0 && <circle cx={cx} cy={CHART_H + 6} r={3} fill="var(--chart-teal)" />}
                <text x={dayLabel?.x ?? cx} y={CHART_H + 22} textAnchor={dayLabel?.anchor ?? 'middle'} className={`spend-day ${weekend ? 'weekend' : ''} ${hover === i ? 'on' : ''}`}>
                  {dayLabel?.text ?? ''}
                </text>
                {outLabel && (
                  <text x={outLabel.x} y={CHART_H + 38} textAnchor={outLabel.anchor} className={`spend-out ${hover === i ? 'on' : ''}`}>
                    {outLabel.text}
                  </text>
                )}
                <rect
                  x={GUTTER + band * i}
                  y={0}
                  width={band}
                  height={CHART_H + AXIS_H}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${weekday(d.day)}: starts ${signedRound(start)}, spends ${signedRound(spend)}, leaves ${signedRound(left)}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            )
          })}
          {/* Over the bars where they rise into it, a halo in the card's color keeps each readable. */}
          {lowLabel && lowOver && (
            <text x={lowLabel.x} y={lowLabel.y} textAnchor={lowLabel.anchor} className="spend-value" stroke="var(--card-solid)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" pointerEvents="none">
              {lowLabel.text}
            </text>
          )}
          {cushion?.over && (
            <text x={cushion.x} y={cushionY} textAnchor={cushion.anchor} className="spend-tick" stroke="var(--card-solid)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" pointerEvents="none">
              {cushion.text}
            </text>
          )}
        </svg>
      )}
      {tip && tipWalk && hover !== null && (
        <div className="chart-tooltip spend-tip" style={hover < days.length / 2 ? { left: tipX + w / 2 + 12 } : { right: width - (tipX - w / 2) + 12 }}>
          <div className="label-muted">{weekday(tip.day)}</div>
          <div className="spend-tip-row muted">
            <span>Starts</span>
            <span className="num">{signedRound(tipWalk.start)}</span>
          </div>
          {items
            .filter((i) => i.day === tip.day && i.cents < 0)
            .map((i) => (
              <div className="spend-tip-row" key={i.key}>
                <span className="truncate">{i.name}</span>
                <span className="num">
                  {i.estimated ? '~' : ''}
                  {amountText(i.cents)}
                </span>
              </div>
            ))}
          <div className="spend-tip-row spend-tip-left">
            <span>Left</span>
            <strong className={`num ${tipWalk.left < 0 ? 'neg' : ''}`}>{signedRound(tipWalk.left)}</strong>
          </div>
          {items
            .filter((i) => i.day === tip.day && i.cents > 0)
            .map((i) => (
              <div className="spend-tip-row" key={i.key}>
                <span className="truncate">{i.name}</span>
                <span className="num pos">
                  {i.estimated ? '~' : ''}
                  {amountText(i.cents)}
                </span>
              </div>
            ))}
          {tipWalk.pay > 0 && (
            <div className="spend-tip-row muted">
              <span>Ends</span>
              <span className="num">{signedRound(tip.endCents)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
