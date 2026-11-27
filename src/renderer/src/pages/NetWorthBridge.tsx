import type { ReactNode } from 'react'
import { BRIDGE_TERMS, type BridgeLine } from './netWorthView'

// Net worth's monthly bridge as the Overview draws it (waterfall spec 2d): the span's line, then each month's, the
// newest first, each with its close marker, its start, the terms that moved it and its end, and under a changed month
// the figures its close froze. React alone, so the tests render it as the page does.

/** A line's name breaks only after its dash, "Dec ’25–" over "Nov ’26" or "Oct 12 –" over "Oct 31", where its column is narrower than it. */
function lineName(name: string): ReactNode {
  const whole = (s: string): string => s.replace(/ /g, ' ')
  const at = name.indexOf('–')
  if (at < 0) return whole(name)
  const [from, to] = [whole(name.slice(0, at + 1)), name.slice(at + 1)]
  return to.startsWith(' ') ? (
    `${from} ${whole(to.slice(1))}`
  ) : (
    <>
      {from}
      <wbr />
      {whole(to)}
    </>
  )
}

/** The monthly bridge: the span's line, then each month's, the newest first, with its close marker; a changed month's closed figures under it. */
export function BridgeTable({ lines }: { lines: BridgeLine[] }): ReactNode {
  if (!lines.length) return null
  return (
    <div className="card nw-bridge-card">
      <table className="nw-bridge">
        <thead>
          <tr>
            <th className="name" />
            <th>Start</th>
            {BRIDGE_TERMS.map((t) => (
              <th key={t.key}>{t.name}</th>
            ))}
            <th>End</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className={l.span ? 'span' : l.closed ? 'closed' : undefined}>
              <th className="name" scope="row">
                {lineName(l.name)}
                {l.closed ? null : (
                  <span className="span-mark mono" title={l.title} aria-label={l.title}>
                    {l.mark}
                  </span>
                )}
              </th>
              {l.cells.map((c, i) => (
                <td key={i} className="num">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
