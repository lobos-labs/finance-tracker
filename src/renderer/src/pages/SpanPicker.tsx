import type { ReactNode } from 'react'
import type { Span } from '../../../shared/types'
import { daysIn, isDay, lastDays, shiftDay } from '../../../shared/period'
import { Icon } from '../Icon'
import { currentMonth, shiftMonth, todayKey } from '../lib'
import { presetSpan, PRESETS, type Preset } from './homeView'

// The span Home and its drills read (waterfall spec 1.12), as the Dashboard picked it: presets 30D, MTD, YTD, 12M
// and All, from and to months for any range, and arrows that step a whole span at a time and never run past today.
// A marker after it gives the span's months' close status, each month's in its title.

const monthsIn = (s: Span): number => {
  const [fy, fm] = s.from.split('-').map(Number)
  const [ty, tm] = s.to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm) + 1
}

/**
 * `preset` is the one picked, when the span came from one: two can be the same span on a day (YTD and MTD in
 * January), and only the one picked shows pressed. onChange names the preset clicked, or null for any other span.
 */
export function SpanPicker({ span, preset, firstMonth, mark, onChange }: { span: Span; preset: Preset | null; firstMonth: string | null; mark: { mark: string; title: string } | null; onChange: (s: Span, preset: Preset | null) => void }): ReactNode {
  const cur = currentMonth()
  const today = todayKey()
  const days = isDay(span.from)
  // The month inputs show the months a window of days touches.
  const months = days ? { from: span.from.slice(0, 7), to: span.to.slice(0, 7) } : span
  const presets = PRESETS.flatMap((id) => {
    const s = presetSpan(id, today, firstMonth)
    return s ? [{ id, span: s }] : []
  })
  // The arrows step a whole span at a time.
  const step = (d: number): void => {
    if (days) {
      const n = daysIn(span.from, span.to)
      const to = shiftDay(span.to, d * n)
      onChange(to > today ? lastDays(n, today) : { from: shiftDay(span.from, d * n), to }, null)
      return
    }
    const n = monthsIn(span)
    const to = shiftMonth(span.to, d * n)
    onChange(to > cur ? { from: shiftMonth(cur, 1 - n), to: cur } : { from: shiftMonth(span.from, d * n), to }, null)
  }
  const set = (key: keyof Span, m: string): void => {
    if (!/^\d{4}-\d{2}$/.test(m)) return
    const next = { ...months, [key]: m > cur ? cur : m }
    if (next.from > next.to) next[key === 'from' ? 'to' : 'from'] = next[key]
    onChange(next, null)
  }
  return (
    <div className="span-picker">
      <div className="segmented" role="group" aria-label="Span">
        {presets.map((p) => {
          const on = preset ? p.id === preset : p.span.from === span.from && p.span.to === span.to
          return (
            <button key={p.id} className={on ? 'active' : ''} aria-pressed={on} onClick={() => onChange(p.span, p.id)}>
              {p.id}
            </button>
          )
        })}
      </div>
      <div className="month-switch">
        <button className="btn icon-btn" aria-label="Earlier" onClick={() => step(-1)}>
          <Icon name="chevronLeft" size={15} />
        </button>
        <input className="month-input" type="month" aria-label="From" value={months.from} max={cur} onChange={(e) => set('from', e.target.value)} />
        <span className="month-dash">–</span>
        <input className="month-input" type="month" aria-label="To" value={months.to} max={cur} onChange={(e) => set('to', e.target.value)} />
        <button className="btn icon-btn" aria-label="Later" disabled={span.to >= (days ? today : cur)} onClick={() => step(1)}>
          <Icon name="chevronRight" size={15} />
        </button>
      </div>
      {mark && (
        <span className="span-mark mono" title={mark.title} aria-label={mark.title}>
          {mark.mark}
        </span>
      )}
    </div>
  )
}
