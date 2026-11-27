import { useEffect, useState, type ReactNode } from 'react'
import { fmtMoneyRound } from './lib'

// Shared pieces of the money visuals (Taxes, Benefits): a one-row meter that
// adds up to a total, and an element's live width for drawing charts.

export interface MeterSegment {
  key: string
  cents: number
  color: string
  /** a lighter step of the same color: money still to come, or coming back */
  light?: boolean
  /** an empty stretch, like room left under a limit */
  track?: boolean
  label: string
}

/** Segments side by side, each as wide as its share, with a legend that names and totals each one. */
export function Meter({ segments }: { segments: MeterSegment[] }): ReactNode {
  const shown = segments.filter((s) => s.cents > 0)
  if (!shown.length) return null
  return (
    <div className="pay-bar-wrap">
      <div className="pay-bar" role="img" aria-label={shown.map((s) => `${s.label} ${fmtMoneyRound(s.cents)}`).join(', ')}>
        {shown.map((s) => (
          <div key={s.key} className={`pay-seg ${s.light ? 'light' : ''} ${s.track ? 'track' : ''}`} style={{ flexGrow: s.cents, background: s.track ? undefined : s.color }} title={`${s.label} ${fmtMoneyRound(s.cents)}`} />
        ))}
      </div>
      <div className="pay-legend">
        {shown.map((s) => (
          <div key={s.key} className="pay-key">
            <span className={`pay-swatch ${s.light ? 'light' : ''} ${s.track ? 'track' : ''}`} style={{ background: s.track ? undefined : s.color }} />
            <span>{s.label}</span>
            <span className="pay-key-value">{fmtMoneyRound(s.cents)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Width of an element, kept current as it resizes. */
export function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width]
}
