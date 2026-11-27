import type { ReactNode } from 'react'
import { CONTRIBUTION_KINDS, type ContributionKind, type ContributionSummary } from '../../../shared/types'
import { CADENCE_LABEL } from '../../../shared/schedule'
import { fmtDay, fmtMoney, fmtMoneyRound } from '../lib'

// The paycheck savings plans and their IRS limits (waterfall spec 1.3), as data: Take-home's drill on Home lists the
// plans, and Pay & benefits the plans with the year's limits. Review adds, changes and removes a plan
// (set_contribution, delete_contribution), so the list has no form of its own.

const kindLabel = (k: ContributionKind): string => CONTRIBUTION_KINDS.find((x) => x.id === k)?.label ?? k

/**
 * Each plan's election, what it takes a paycheck, this year so far and by Dec 31, and the limits with a bar each. In
 * `compact` form (Home's Take-home drill, whose Limits line holds the limits as data) it lists the plans alone.
 */
export function Contributions({ summary, compact = false }: { summary: ContributionSummary | null; compact?: boolean }): ReactNode {
  if (!summary) return null
  return (
    <section className={compact ? 'contrib compact' : 'card contrib'}>
      <h2 style={{ margin: 0, marginBottom: 8 }}>Contributions · {summary.year}</h2>
      {summary.plans.length === 0 && <div className="muted small">None</div>}
      {summary.plans.length > 0 && (
        <div className="contrib-table">
          <div className="contrib-row head">
            <span>Plan</span>
            <span>Election</span>
            <span className="num">Per paycheck</span>
            <span className="num">So far</span>
            <span className="num">By Dec 31</span>
          </div>
          {summary.plans.map((p) => {
            const ended = !!p.endsDay && p.endsDay < new Date().toISOString().slice(0, 10)
            return (
              <div className={`contrib-row ${ended ? 'ended' : ''}`} key={p.id}>
                <span className="truncate">
                  <span className="txn-merchant">{p.name}</span>
                  <span className="txn-desc truncate">{[kindLabel(p.kind), p.cadence ? CADENCE_LABEL[p.cadence] : null, ended ? `ended ${fmtDay(p.endsDay!)}` : null].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="truncate">
                  {p.percent !== null ? `${p.percent}%` : '—'}
                  {p.nextFrom && p.nextPercent !== null && ` → ${p.nextPercent}% from ${fmtDay(p.nextFrom)}`}
                  {p.matchNote && <span className="txn-desc truncate">{p.matchNote}</span>}
                </span>
                <span className="num">
                  {p.employeeCents !== null ? fmtMoney(p.employeeCents) : '—'}
                  {p.nextFrom && p.nextEmployeeCents !== null && <span className="txn-desc">then {fmtMoney(p.nextEmployeeCents)}</span>}
                  {p.matchCents ? <span className="txn-desc">+ {fmtMoney(p.matchCents)} match</span> : null}
                </span>
                <span className="num">
                  {p.soFarCents !== null ? fmtMoneyRound(p.soFarCents) : <span className="muted">—</span>}
                  {p.ytdAsOf && (
                    <span className="txn-desc">
                      {p.soFarCents !== null && p.soFarCents !== p.ytdCents ? 'incl. paychecks since ' : 'as of '}
                      {fmtDay(p.ytdAsOf)}
                    </span>
                  )}
                </span>
                <span className="num">
                  {p.projectedCents !== null ? fmtMoneyRound(p.projectedCents) : <span className="muted">—</span>}
                  {p.checksLeft > 0 && <span className="txn-desc">{p.checksLeft} checks left</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {!compact &&
        summary.limits.map((l) => {
          const room = l.limitCents - l.projectedCents
          const pct = Math.min(100, (l.projectedCents / l.limitCents) * 100)
          return (
            <div className="contrib-limit" key={l.label}>
              <div className="row">
                <span className="label-muted" style={{ marginRight: 'auto' }}>
                  {l.label} · limit {fmtMoneyRound(l.limitCents)}
                  {l.limitProvisional ? ' est.' : ''}
                </span>
                {l.projectedCents === 0 && l.unknown.length ? (
                  <span className="muted small">Needs this year's total</span>
                ) : (
                  <span className={`num ${room < 0 ? 'neg' : ''}`}>
                    {fmtMoneyRound(l.projectedCents)} by Dec 31 · {room < 0 ? `over by ${fmtMoneyRound(-room)}` : `${fmtMoneyRound(room)} room`}
                  </span>
                )}
              </div>
              <div className="contrib-bar">
                <div style={{ width: `${(Math.min(l.ytdCents, l.limitCents) / l.limitCents) * 100}%` }} className="so-far" />
                <div style={{ width: `${Math.max(0, pct - (Math.min(l.ytdCents, l.limitCents) / l.limitCents) * 100)}%` }} className={room < 0 ? 'over' : 'planned'} />
              </div>
              {l.unknown.length > 0 && (
                <div className="label-muted" style={{ marginTop: 6 }}>
                  Not counted yet: {l.unknown.join(', ')}
                </div>
              )}
            </div>
          )
        })}
    </section>
  )
}
