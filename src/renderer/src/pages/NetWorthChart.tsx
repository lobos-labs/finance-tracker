import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { NetWorthPoint, NetWorthSeries, Span, Waterfall } from '../../../shared/types'
import { useApp } from '../App'
import { api, dateTicks, errorMessage, fmtMoney, fmtMoneyCompact, todayKey } from '../lib'
import { readSpan, spanMark, writeSpan, type Preset } from './homeView'
import { BridgeTable } from './NetWorthBridge'
import { axisDays, bridgeLines, chartPoints } from './netWorthView'
import { SpanPicker } from './SpanPicker'

// Net worth's Overview over a span (waterfall spec 2d; section 4: the Dashboard's net worth chart moves here): the
// span picker, the net worth line and the monthly bridge, all over the span picked. The line is the net worth
// series (getNetWorth) and the bridge getWaterfall's months, one walk of the balances, so each month's end on the
// line is the month's bridge end. The span is this viewer's one choice, Home's (spec 1.12), kept in localStorage, so
// Growth's › Net worth opens on the span the drill showed.

const MONO = "'JetBrains Mono Variable', ui-monospace, monospace"

const shortDay = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** The span this viewer left, Home's and its drills' too, and the preset it was picked by. */
const loadSpan = (): { span: Span; preset: Preset | null } => readSpan(() => localStorage, todayKey())

const keepSpan = (s: Span, preset: Preset | null): void => writeSpan(() => localStorage, s, preset, todayKey())

/** The span picker, the net worth line and the monthly bridge, over one span. */
export function NetWorthOverTime(): ReactNode {
  const { tick, toast } = useApp()
  const [picked, setPicked] = useState(loadSpan)
  const span = picked.span
  // The latest answer, with the span it answers: until the span picked has its own, the figures shown are dimmed.
  const [answer, setAnswer] = useState<{ span: Span; w: Waterfall } | null>(null)
  const [series, setSeries] = useState<NetWorthSeries | null>(null)
  const w = answer?.w ?? null
  const stale = !!answer && (answer.span.from !== span.from || answer.span.to !== span.to)

  // One getWaterfall per span, and again when the data changes; a slower answer for an older span is dropped.
  const asked = useRef(0)
  useEffect(() => {
    const n = ++asked.current
    api.getWaterfall(span).then(
      (x) => n === asked.current && setAnswer({ span, w: x }),
      (e) => n === asked.current && toast(errorMessage(e), 'error')
    )
  }, [span, tick, toast])
  // The series is every day's, whatever the span: read once a data change.
  useEffect(() => {
    api.getNetWorth([0]).then(setSeries, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  const pickSpan = (s: Span, preset: Preset | null): void => {
    setPicked({ span: s, preset })
    keepSpan(s, preset)
  }
  // The line and the bridge draw the span the waterfall answered, so they always show the same days.
  const points = useMemo(() => (w ? chartPoints(series, w.span, todayKey()) : []), [series, w])
  const lines = useMemo(() => (w ? bridgeLines(w) : []), [w])

  return (
    <section className="nw-time">
      <div className="nw-time-bar">
        <SpanPicker span={span} preset={picked.preset} firstMonth={w?.firstMonth ?? null} mark={w && !stale ? spanMark(w.months) : null} onChange={pickSpan} />
      </div>
      {!w ? (
        <div className="skeleton" style={{ height: 240 }} />
      ) : (
        <div className={stale ? 'home-stale' : undefined} aria-busy={stale}>
          <NetWorthChart points={points} />
          <BridgeTable lines={lines} />
        </div>
      )}
    </section>
  )
}

function NetWorthTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }): ReactNode {
  if (!active || !payload?.length) return null
  const p = payload[0].payload as NetWorthPoint
  return (
    <div className="chart-tooltip" style={{ minWidth: 150 }}>
      <div className="label-muted">{shortDay(p.day)}</div>
      <div className="num" style={{ textAlign: 'left', fontSize: 14, color: 'var(--ink-50)' }}>
        {fmtMoney(p.cents)}
      </div>
    </div>
  )
}

/** Net worth each day of the span; nothing with no figures to draw. */
export function NetWorthChart({ points }: { points: NetWorthPoint[] }): ReactNode {
  if (points.length < 2) return null
  const last = points[points.length - 1]
  const axis = dateTicks(axisDays(points))
  return (
    <div className="card networth nw-chart">
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-copper)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--chart-copper)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--ink-700)" />
            <XAxis
              dataKey="day"
              ticks={axis.ticks}
              tickFormatter={axis.format}
              tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }}
              axisLine={{ stroke: 'var(--ink-600)' }}
              tickLine={false}
            />
            <YAxis
              domain={['auto', 'auto']}
              tickFormatter={(v: number) => fmtMoneyCompact(v)}
              tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip content={NetWorthTooltip} cursor={{ stroke: 'var(--ink-500)', strokeWidth: 1 }} />
            <Area type="linear" dataKey="cents" stroke="var(--chart-copper)" strokeWidth={2} fill="url(#nw-fill)" baseValue="dataMin" isAnimationActive={false} activeDot={{ r: 4, fill: 'var(--chart-copper)', stroke: 'var(--card-solid)', strokeWidth: 2 }} />
            <ReferenceDot x={last.day} y={last.cents} r={4} fill="var(--chart-copper)" stroke="var(--card-solid)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
