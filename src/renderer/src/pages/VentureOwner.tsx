import type { ReactNode } from 'react'
import { money } from './homeView'
import { signedMoney, type OwnerBlock, type OwnerLineRow, type OwnerRow } from './ventureView'

// A venture's owner money as its page draws it (waterfall spec addendum 1.11, the Ventures page): the figures line,
// the shares, the owner money table and the boundary lines, from ventureView's block. Data only: Review sets the
// share, the value source and every intent. A line opens Transactions on its own parts, Unset on the parts with no
// intent yet, and the count of older lines on all of them. React alone, so the tests render it as the page does.

/** A cell of the owner money: blank where the row has none; Unset's in and out read 0 when they're nothing. */
const cell = (cents: number | null, zero = false): string => (cents === null ? '' : cents === 0 && zero ? '0' : money(cents))
const tone = (cents: number | null): string => (cents === null || cents === 0 ? '' : cents > 0 ? 'pos' : 'neg')

export function VentureOwner({ block, onLine, onUnset, onMore }: { block: OwnerBlock; onLine?: (line: OwnerLineRow) => void; onUnset?: () => void; onMore?: () => void }): ReactNode {
  const row = (r: OwnerRow): ReactNode => {
    const unset = r.key === 'unset'
    const cells = (
      <>
        <span className="truncate">{r.name}</span>
        <span className="num">{cell(r.inCents, unset)}</span>
        <span className="num">{cell(r.outCents, unset)}</span>
        <span className={`num ${tone(r.outstandingCents)}`}>{cell(r.outstandingCents)}</span>
        <span className="num">{cell(r.interestCents)}</span>
      </>
    )
    // Unset opens Transactions on its parts, when it has some.
    return unset && onUnset && (r.inCents || r.outCents) ? (
      <button className="money-row owner-money link-row" key={r.key} onClick={onUnset}>
        {cells}
      </button>
    ) : (
      <div className="money-row owner-money" key={r.key}>
        {cells}
      </div>
    )
  }
  return (
    <div className="card venture-owner">
      <div className="owner-figures">
        {block.figures.map((f) => (
          <span className="owner-figure" key={f.key}>
            {f.label && <span className="label-muted">{f.label}</span>}
            {f.key === 'source' ? <span className="tag">{f.value}</span> : <span className={`num ${f.key === 'aboveBasis' || f.key === 'position' ? tone(f.cents) : ''}`}>{f.value}</span>}
          </span>
        ))}
      </div>
      {block.shares.length > 0 && (
        <div className="owner-shares">
          <span className="label-muted">Shares</span>
          {block.shares.map((s) => (
            <span className="owner-figure" key={s.day}>
              <span className="mono small muted">{s.day}</span>
              <span className="num">{s.pct}</span>
            </span>
          ))}
        </div>
      )}
      <div className="money-table owner-table">
        <div className="money-row owner-money head">
          <span>Owner money</span>
          <span className="num">In</span>
          <span className="num">Out</span>
          <span className="num">Outstanding</span>
          <span className="num">Interest</span>
        </div>
        {block.rows.map(row)}
      </div>
      {block.lines.length > 0 && (
        <div className="owner-lines">
          {block.more > 0 && (
            <button className="money-row owner-line link-row" onClick={onMore}>
              <span className="muted">{block.more.toLocaleString()} more</span>
            </button>
          )}
          {block.lines.map((l) => (
            <button className="money-row owner-line link-row" key={l.key} onClick={() => onLine?.(l)}>
              <span className="mono small">{l.dayText}</span>
              <span className="truncate" title={l.account}>
                {l.account}
              </span>
              <span className={`num ${tone(l.cents)}`}>{signedMoney(l.cents)}</span>
              <span className="owner-parts">{l.parts}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
