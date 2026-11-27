import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { taxReturnYear, type TaxYear, type TaxesView } from '../../../shared/types'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, errorMessage, fmtDay, fmtMoneyCompact, fmtMoneyRound } from '../lib'
import { Meter, useWidth, type MeterSegment } from '../Meter'
import { EmptyCard, OpenFolderButton } from '../Empty'

const money = (cents: number | null): string => (cents === null ? '—' : fmtMoneyRound(cents))
const signed = (cents: number | null): string => (cents === null ? '—' : `${cents < 0 ? '−' : ''}${fmtMoneyRound(Math.abs(cents))}`)
const rate = (tax: number | null, of: number | null): string => (tax === null || !of ? '—' : `${((tax / of) * 100).toFixed(1)}%`)

export default function Taxes(): ReactNode {
  const { tick, toast } = useApp()
  const [data, setData] = useState<TaxesView | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    api.getTaxes().then(setData, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  if (!data) return <PageHeader title="Taxes" />

  const head = data.years[0] ?? null
  const estimate = head?.status === 'estimate'
  const harbor = head && data.safeHarbor?.year === head.year ? data.safeHarbor : null
  // What counts toward the safe harbor: withholding, estimated payments and refundable credits.
  const paid = head ? (head.paymentsCents ?? head.withheldCents) : null
  // Met by last year's tax, by 90% of this year's, or by owing under $1,000.
  const met = harbor && head && paid !== null ? paid >= harbor.cents || (head.taxCents !== null && (paid >= head.taxCents * 0.9 || head.taxCents - paid < 100_000)) : null
  // When it isn't met, the least that would meet one of the three.
  const need = harbor && head ? (head.taxCents === null ? harbor.cents : Math.min(harbor.cents, Math.ceil(head.taxCents * 0.9), head.taxCents - 99_999)) : null
  const charted = [...data.years].filter((y) => y.refundCents !== null).sort((a, b) => a.year - b.year)
  // The refund's deposit: the largest Taxes-category deposit for that return that isn't more than the refund (preparer fees come out of it).
  const deposit =
    head && !estimate && head.refundCents !== null && head.refundCents > 0
      ? data.money.filter((m) => m.cents > 0 && m.cents <= head.refundCents! && taxReturnYear(m.day) === head.year).sort((a, b) => b.cents - a.cents)[0]
      : undefined
  const left = data.paychecks.reduce((t, p) => t + p.checksLeft, 0)
  const toDec = data.paychecks.reduce((t, p) => t + p.federalCents * p.checksLeft, 0)
  const sum = (k: 'grossCents' | 'federalCents' | 'socialSecurityCents' | 'medicareCents'): string =>
    data.paychecks.some((p) => p[k] === null) ? '—' : fmtMoneyRound(data.paychecks.reduce((t, p) => t + (p[k] ?? 0), 0))

  return (
    <>
      <PageHeader title="Taxes" />
      <div className="page">
        {head ? (
          <section className="tax-hero">
            <div className="tax-hero-top">
              <div>
                <div className="label-muted">
                  {head.year}
                  {estimate ? ` · estimate${head.asOf ? ` ${fmtDay(head.asOf)}` : ''}` : head.preparer ? ` · ${head.preparer}` : ''}
                </div>
                <div className="tax-hero-value">
                  {head.refundCents === null ? money(head.taxCents) : fmtMoneyRound(Math.abs(head.refundCents))}
                  <span className="tax-hero-unit">{head.refundCents === null ? 'tax' : head.refundCents < 0 ? (estimate ? 'due' : 'owed') : 'refund'}</span>
                </div>
                <div className="tax-hero-sub">
                  {[
                    estimate && head.refundCents !== null && head.refundCents < 0 ? `Apr 15, ${head.year + 1}` : deposit ? `Deposited ${fmtDay(deposit.day)}` : null,
                    head.refundCents !== null && head.taxCents !== null ? `${fmtMoneyRound(head.taxCents)} tax` : null,
                    head.agiCents ? `${rate(head.taxCents, head.agiCents)} of AGI` : null
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {harbor && (
                <div className="tax-hero-side">
                  <div className="label-muted">Safe harbor</div>
                  <div className="tax-hero-side-value">{fmtMoneyRound(harbor.cents)}</div>
                  <div className={`delta ${met === null ? '' : met ? 'tax-back' : 'tax-owed'}`}>
                    {harbor.pct}% of {harbor.fromYear} tax
                    {met !== null && paid !== null && (met ? ' · met' : ` · short ${fmtMoneyRound((need ?? harbor.cents) - paid)}`)}
                  </div>
                </div>
              )}
            </div>
            <PaymentBar y={head} toComeCents={estimate && head.year === data.year ? toDec : null} />
          </section>
        ) : (
          <EmptyCard label="No returns yet">
            <OpenFolderButton sub="Tax">Add tax forms</OpenFolderButton>
          </EmptyCard>
        )}

        {data.paychecks.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Withholding per check</h2>
              <span className="label-muted">
                {left} check{left === 1 ? '' : 's'} left · {fmtMoneyRound(toDec)} federal by Dec 31
              </span>
            </div>
            <div className="asset-table" role="table">
              <div className="tax-check-row head" role="row">
                <span>Paycheck</span>
                <span className="num">Gross</span>
                <span className="num">Federal</span>
                <span className="num">Social Security</span>
                <span className="num">Medicare</span>
                <span className="num">Left</span>
                <span className="num">Federal to Dec 31</span>
              </div>
              {data.paychecks.map((p) => (
                <div className="tax-check-row" role="row" key={p.paycheckKey} title={`${fmtDay(p.asOf)} paystub`}>
                  <span className="truncate">{p.employer}</span>
                  <span className="num">{money(p.grossCents)}</span>
                  <span className="num">{fmtMoneyRound(p.federalCents)}</span>
                  <span className="num">{fmtMoneyRound(p.socialSecurityCents)}</span>
                  <span className="num">{fmtMoneyRound(p.medicareCents)}</span>
                  <span className="num">{p.checksLeft}</span>
                  <span className="num">{fmtMoneyRound(p.federalCents * p.checksLeft)}</span>
                </div>
              ))}
              {data.paychecks.length > 1 && (
                <div className="tax-check-row total" role="row">
                  <span>All</span>
                  <span className="num">{sum('grossCents')}</span>
                  <span className="num">{sum('federalCents')}</span>
                  <span className="num">{sum('socialSecurityCents')}</span>
                  <span className="num">{sum('medicareCents')}</span>
                  <span className="num">{left}</span>
                  <span className="num">{fmtMoneyRound(toDec)}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {data.years.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Returns</h2>
              {charted.length > 1 && (
                <div className="pay-legend returns-legend">
                  {charted.some((y) => y.refundCents! >= 0) && (
                    <div className="pay-key">
                      <span className="pay-swatch" style={{ background: 'var(--chart-teal)' }} />
                      <span>Refund</span>
                    </div>
                  )}
                  {charted.some((y) => y.refundCents! < 0) && (
                    <div className="pay-key">
                      <span className="pay-swatch" style={{ background: 'var(--chart-copper)' }} />
                      <span>Due</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {charted.length > 1 && <RefundChart rows={charted} open={open} onPick={(year) => setOpen(open === year ? null : year)} />}
            <div className="asset-table" role="table">
              <div className="asset-row tax-row head" role="row">
                <span>Year</span>
                <span className="num">Wages</span>
                <span className="num">AGI</span>
                <span className="num">Tax</span>
                <span className="num">Rate</span>
                <span className="num">Withheld</span>
                <span className="num">Refund</span>
                <span>Prepared by</span>
              </div>
              {data.years.map((y) => (
                <Fragment key={y.year}>
                  <button className={`asset-row tax-row ${open === y.year ? 'open' : ''}`} aria-expanded={open === y.year} onClick={() => setOpen(open === y.year ? null : y.year)}>
                    <span className="tax-year">
                      {y.year}
                      {y.status === 'estimate' && <span className="tag">Est.</span>}
                      {y.issues.length > 0 && <span className="tax-flag" title={`${y.issues.length} open question${y.issues.length === 1 ? '' : 's'}`} />}
                    </span>
                    <span className="num">{money(y.wagesCents)}</span>
                    <span className="num">{money(y.agiCents)}</span>
                    <span className="num">{money(y.taxCents)}</span>
                    <span className="num muted">{rate(y.taxCents, y.agiCents)}</span>
                    <span className="num">{money(y.withheldCents)}</span>
                    <span className={`num ${y.refundCents !== null && y.refundCents < 0 ? 'tax-owed' : ''}`}>{signed(y.refundCents)}</span>
                    <span className="truncate muted">{y.preparer ?? ''}</span>
                  </button>
                  {open === y.year && <YearDetail y={y} data={data} />}
                </Fragment>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  )
}

function YearDetail({ y, data }: { y: TaxYear; data: TaxesView }): ReactNode {
  const { toast } = useApp()
  const paid = data.money.filter((m) => taxReturnYear(m.day) === y.year)
  const flow: Array<[string, number | null, boolean?]> = [
    ['Wages', y.wagesCents],
    ['Total income', y.incomeCents],
    ['AGI', y.agiCents, true],
    [y.deduction === 'itemized' ? 'Itemized deductions' : 'Standard deduction', y.deductionCents],
    ['Taxable income', y.taxableCents],
    ['Total tax', y.taxCents, true],
    ['Withheld', y.withheldCents],
    ['Payments and credits', y.paymentsCents]
  ]
  const shown = flow.filter(([, c], i) => c !== null && !(i === 7 && c === y.withheldCents))
  return (
    <div className="tax-detail">
      {y.issues.length > 0 && (
        <ul className="tax-issues">
          {y.issues.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      )}
      <div className="tax-detail-cols">
        <div>
          <div className="label-muted">Return</div>
          {shown.map(([label, cents, strong]) => (
            <div className={`tax-kv ${strong ? 'strong' : ''}`} key={label}>
              <span>{label}</span>
              <span className="num">{money(cents)}</span>
            </div>
          ))}
          {y.refundCents !== null && (
            <div className={`tax-kv strong ${y.refundCents < 0 ? 'tax-owed' : 'tax-back'}`}>
              <span>{y.refundCents < 0 ? (y.status === 'estimate' ? 'Due' : 'Owed') : 'Refund'}</span>
              <span className="num">{fmtMoneyRound(Math.abs(y.refundCents))}</span>
            </div>
          )}
        </div>
        <div>
          {y.lines.length > 0 && (
            <>
              <div className="label-muted">Items</div>
              {y.lines.map((l) => (
                <div className="tax-kv" key={l.label}>
                  <span>{l.label}</span>
                  <span className="num">{signed(l.cents)}</span>
                </div>
              ))}
            </>
          )}
          {paid.length > 0 && (
            <>
              <div className={`label-muted ${y.lines.length ? 'tax-sub' : ''}`}>Money</div>
              {paid.map((m) => (
                <div className="tax-kv" key={m.id} title={m.account}>
                  <span className="truncate">
                    <span className="mono small muted">{fmtDay(m.day)}</span> {m.description}
                  </span>
                  <span className={`num ${m.cents > 0 ? 'tax-back' : ''}`}>{signed(m.cents)}</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div>
          {y.forms.length > 0 && (
            <>
              <div className="label-muted">On file</div>
              {y.forms.map((f) => {
                const found = data.formFound[f.file] ?? false
                return (
                  <button key={f.file} className={`tax-form ${found ? '' : 'gone'}`} title={f.file} disabled={!found} onClick={() => api.openTaxForm(f.file).catch((e) => toast(errorMessage(e), 'error'))}>
                    <Icon name="paperclip" size={12} />
                    <span className="truncate">{f.name}</span>
                  </button>
                )
              })}
            </>
          )}
          {(y.preparer || y.filedDay) && (
            <div className={`small muted ${y.forms.length ? 'tax-sub' : ''}`}>
              {[y.preparer, y.filedDay && `filed ${fmtDay(y.filedDay)}`].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- visuals ----------

/**
 * How the year's tax gets paid, as one bar that adds up to the tax: what's been withheld, what the
 * paychecks left this year will withhold, credits, and what's still due; or, when more was paid than
 * owed, the tax and the refund.
 */
function PaymentBar({ y, toComeCents }: { y: TaxYear; toComeCents: number | null }): ReactNode {
  const tax = y.taxCents
  const withheld = y.withheldCents ?? 0
  const paid = y.paymentsCents ?? y.withheldCents
  if (tax === null || paid === null || (tax <= 0 && paid <= 0)) return null
  const credits = Math.max(0, paid - withheld)
  const segments: MeterSegment[] = []
  if (paid <= tax) {
    const toCome = toComeCents === null ? 0 : Math.min(toComeCents, withheld)
    if (withheld - toCome > 0) segments.push({ key: 'withheld', cents: withheld - toCome, color: 'var(--chart-teal)', label: 'Withheld' })
    if (toCome > 0) segments.push({ key: 'tocome', cents: toCome, color: 'var(--chart-teal)', light: true, label: 'Still to withhold' })
    if (credits > 0) segments.push({ key: 'credits', cents: credits, color: 'var(--chart-blue)', label: 'Credits' })
    if (tax - paid > 0) segments.push({ key: 'due', cents: tax - paid, color: 'var(--chart-copper)', label: y.status === 'estimate' ? 'Due' : 'Owed' })
  } else {
    if (tax > 0) segments.push({ key: 'tax', cents: tax, color: 'var(--chart-teal)', label: 'Tax' })
    segments.push({ key: 'refund', cents: paid - tax, color: 'var(--chart-teal)', light: true, label: 'Refund' })
  }
  return <Meter segments={segments} />
}

const CHART_H = 160
const AXIS_H = 26
const GUTTER = 40

/** Two or fewer clean gridline values on each side of zero, e.g. ±$10K. */
function ticks(lo: number, hi: number): number[] {
  const m = Math.max(hi, -lo)
  if (m <= 0) return []
  const mag = 10 ** Math.floor(Math.log10(m))
  const step = m / mag >= 5 ? 5 * mag : m / mag >= 2 ? 2 * mag : mag
  const out: number[] = []
  for (let k = 1; k <= 2; k++) {
    if (k * step <= hi) out.push(k * step)
    if (-k * step >= lo) out.push(-k * step)
  }
  return out
}

/** Each year's refund (up) or amount due (down) from one baseline. A column opens its year below. */
function RefundChart({ rows, open, onPick }: { rows: TaxYear[]; open: number | null; onPick: (year: number) => void }): ReactNode {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const values = rows.map((y) => y.refundCents!)
  const hi = Math.max(0, ...values)
  const lo = Math.min(0, ...values)
  // Room above and below for the value labels.
  const top = 20
  const bottom = 20
  const scale = (CHART_H - top - bottom) / (hi - lo || 1)
  const zero = top + hi * scale
  const band = Math.max(0, width - GUTTER) / rows.length
  const w = Math.min(36, band * 0.45)
  const labeled = new Set([rows.length - 1, hi > 0 ? values.indexOf(hi) : -1, lo < 0 ? values.indexOf(lo) : -1])
  const tip = hover === null ? null : rows[hover]
  const tipX = hover === null ? 0 : GUTTER + band * hover + band / 2
  return (
    <div className="refund-chart" ref={ref} style={{ height: CHART_H + AXIS_H }}>
      {width > 0 && (
        <svg width={width} height={CHART_H + AXIS_H} role="group" aria-label="Refund or amount due by year">
          {ticks(lo, hi).map((t) => (
            <g key={t}>
              <line x1={GUTTER} x2={width} y1={zero - t * scale} y2={zero - t * scale} stroke="var(--ink-800)" strokeWidth={1} />
              <text x={0} y={zero - t * scale + 3.5} className="refund-tick">
                {t < 0 ? '−' : ''}
                {fmtMoneyCompact(Math.abs(t))}
              </text>
            </g>
          ))}
          <line x1={GUTTER} x2={width} y1={zero} y2={zero} stroke="var(--ink-600)" strokeWidth={1} />
          {rows.map((y, i) => {
            const v = y.refundCents!
            const cx = GUTTER + band * i + band / 2
            const h = Math.max(Math.abs(v) * scale, 1)
            const color = v >= 0 ? 'var(--chart-teal)' : 'var(--chart-copper)'
            const est = y.status === 'estimate'
            const on = hover === i || open === y.year
            return (
              <g key={y.year}>
                {on && <rect x={GUTTER + band * i + 2} y={0} width={band - 4} height={CHART_H} fill="var(--chart-cursor)" />}
                {/* An estimate is drawn like the app's other projections: outlined, lightly filled. */}
                <rect
                  x={cx - w / 2 + (est ? 0.5 : 0)}
                  y={v >= 0 ? zero - h : zero}
                  width={w - (est ? 1 : 0)}
                  height={h}
                  rx={1}
                  fill={color}
                  fillOpacity={est ? 0.16 : 1}
                  stroke={est ? color : 'none'}
                  strokeWidth={1}
                />
                {labeled.has(i) && v !== 0 && (
                  <text x={cx} y={v >= 0 ? zero - h - 7 : zero + h + 14} textAnchor="middle" className="refund-value">
                    {signed(v)}
                  </text>
                )}
                <text x={cx} y={CHART_H + AXIS_H - 8} textAnchor="middle" className={`refund-year ${on ? 'on' : ''}`}>
                  {est ? `${y.year} est.` : y.year}
                </text>
                <rect
                  x={GUTTER + band * i}
                  y={0}
                  width={band}
                  height={CHART_H + AXIS_H}
                  fill="transparent"
                  role="button"
                  tabIndex={0}
                  aria-label={`${y.year}: ${v >= 0 ? 'refund' : 'due'} ${fmtMoneyRound(Math.abs(v))}`}
                  aria-pressed={open === y.year}
                  style={{ cursor: 'pointer' }}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={() => onPick(y.year)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onPick(y.year)
                    }
                  }}
                />
              </g>
            )
          })}
        </svg>
      )}
      {tip && hover !== null && (
        // Beside the column, on whichever side has room, so it never covers the bar.
        <div className="chart-tooltip refund-tip" style={hover < rows.length / 2 ? { left: tipX + w / 2 + 12 } : { right: width - (tipX - w / 2) + 12 }}>
          <div className="label-muted">
            {tip.year}
            {tip.status === 'estimate' ? ' · estimate' : ''}
          </div>
          <div className="row">
            <strong className="num">{fmtMoneyRound(Math.abs(tip.refundCents!))}</strong>
            <span className="muted">{tip.refundCents! < 0 ? (tip.status === 'estimate' ? 'due' : 'owed') : 'refund'}</span>
          </div>
          <div className="row small muted">
            {[
              tip.taxCents !== null && `${fmtMoneyRound(tip.taxCents)} tax`,
              tip.withheldCents !== null && `${fmtMoneyRound(tip.withheldCents)} withheld`,
              tip.paymentsCents !== null && tip.paymentsCents > (tip.withheldCents ?? 0) && `${fmtMoneyRound(tip.paymentsCents - (tip.withheldCents ?? 0))} credits`
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      )}
    </div>
  )
}
