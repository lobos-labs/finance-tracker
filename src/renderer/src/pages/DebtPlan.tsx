import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { NOT_ADVICE } from '../../../shared/app'
import { CARD_APR, LOAN_APR, likelyDebtFree, minimumIn, monthsBetween, runDebtPlan, shiftMonth, targetOf, type DebtPlanRun, type PlanResult, type Strategy } from '../../../shared/debtPlan'
import type { DebtView } from '../../../shared/types'
import { useApp } from '../App'
import { api, errorMessage, fmtMoneyCompact, fmtMoneyRound, monthLabel } from '../lib'
import { takePayoffFocus } from '../plan'
import { aprText } from './homeView'

// Net worth > Debts' payoff plan, the only one in the app (waterfall spec section 4): the plan shared/debtPlan.ts
// runs on getDebts and the debt.plan inputs, as data. What goes to the debts a month, when they're gone and what they
// cost, each debt's order and payoff month, and the balances month by month; beside it, the same plan at the spending
// the targets allow and at the ends of the likely spending, as the Budget page had them. The inputs are Review's
// (set_debt_plan), and so are each debt's rate, intro rate, minimum and escrow (update_account): nothing here sets one.

const MONO = "'JetBrains Mono Variable', ui-monospace, monospace"
const COLORS = ['var(--chart-copper)', 'var(--chart-teal)', 'var(--chart-slate)', 'var(--chart-plum)', 'var(--chart-blue)', 'var(--ink-300)']

/** The order's data name. */
export const STRATEGY_NAME: Record<Strategy, string> = { avalanche: 'Highest rate first', snowball: 'Smallest balance first' }

const monthShort = (m: string): string => `${monthLabel(m, 'short')} ${m.slice(0, 4)}`
const months = (n: number): string => `${n} ${n === 1 ? 'month' : 'months'}`
/** A rate a year as Home's Saved writes the next debt's (homeView.ts aprText): 24.0%, 24.99%, 0.0%. */
const pct = (apr: number): string => aprText(Math.round(apr * 100))
/** What a plan pays in interest; none to show for one that never ends, as fifty years of it is no figure. */
const interest = (r: PlanResult): string => (r.debtFree ? fmtMoneyRound(r.interestCents) : '—')

/**
 * The chart's points: what each debt the plan pays down owes as it starts and at each month's end, to the month it's
 * paid off and no further, so its layer ends there and the top of the stack is the debts still owing.
 */
export function planChart(month: string, run: Pick<DebtPlanRun, 'debts' | 'result'>): Array<Record<string, string | number | null> & { month: string }> {
  let was = run.debts.map((d) => d.balanceCents)
  const points = run.result.months.map((m) => {
    const point = { month: m.month, ...Object.fromEntries(run.debts.map((d, i) => [d.id, m.balances[i] > 0 || was[i] > 0 ? m.balances[i] : null])) }
    was = m.balances
    return point
  })
  return [{ month, ...Object.fromEntries(run.debts.map((d) => [d.id, d.balanceCents])) }, ...points]
}

/** The payoff plan on Debts: it reads getDebts once a data change, and opens in view when Saved's next debt asked for it. */
export function DebtPlan(): ReactNode {
  const { tick, toast } = useApp()
  const [view, setView] = useState<DebtView | null>(null)
  useEffect(() => {
    api.getDebts().then(setView, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])
  // Opened from Saved's next debt (goNet('debts')): the plan in view once it's in, below the top bar as tall as it
  // stands (on a phone its title, buttons and toggle stack past --topbar-h), and the keyboard's place with it, so
  // the next Tab goes on from the plan rather than from the top of the page.
  useEffect(() => {
    if (!view) return
    if (takePayoffFocus() && view.debts.length)
      requestAnimationFrame(() => {
        const plan = document.getElementById('payoff')
        const bar = document.querySelector('.topbar')?.getBoundingClientRect().height
        if (plan && bar) plan.style.scrollMarginTop = `${Math.ceil(bar) + 8}px`
        plan?.scrollIntoView({ block: 'start' })
        document.getElementById('payoff-head')?.focus({ preventScroll: true })
      })
  }, [view])
  return view ? <PayoffPlan view={view} /> : null
}

/** The plan drawn from its inputs; nothing at all with no debt to pay. */
export function PayoffPlan({ view }: { view: DebtView }): ReactNode {
  const run = useMemo(() => runDebtPlan(view), [view])
  const atTargets = useMemo(() => (view.targetSpendCents === null ? null : runDebtPlan(view, view.targetSpendCents)), [view])
  const likely = useMemo(() => likelyDebtFree(view, run), [view, run])
  const planned = run.debts
  const r = run.result
  const chart = useMemo(() => planChart(view.month, run), [run, view.month])
  if (!view.debts.length) return null

  // Each debt keeps its colour whichever debts are left out.
  const color = (id: string): string => COLORS[Math.max(0, view.debts.findIndex((d) => d.id === id)) % COLORS.length]
  const result = new Map(r.debts.map((d) => [d.id, d]))
  const orderOf = (id: string): number => result.get(id)?.order ?? 999
  // The debt paid off first sits on top of the stack, so the layers under it hold still as it clears.
  const stack = [...planned].sort((a, b) => orderOf(b.id) - orderOf(a.id))
  const start = shiftMonth(view.month, 1)
  const first = targetOf(planned, planned.map((d) => d.balanceCents), view.plan.strategy, start)
  const owed = planned.reduce((s, d) => s + d.balanceCents, 0)
  const leftOut = view.debts.filter((d) => view.plan.leftOut.includes(d.id))
  // Each debt's minimum as the plan pays it the month it starts, a debt left out's too.
  const minimum = new Map([...planned, ...run.leftOut].map((d) => [d.id, minimumIn(d, start)]))
  // Paid off soonest first, a debt the plan doesn't clear after them, and the debts left out last.
  const rows = [...view.debts].sort((a, b) => Number(leftOut.includes(a)) - Number(leftOut.includes(b)) || orderOf(a.id) - orderOf(b.id) || b.balanceCents - a.balanceCents)
  const sooner = atTargets?.result.debtFree && r.debtFree ? monthsBetween(atTargets.result.debtFree, r.debtFree) : null
  // A plan of more than two years is marked by year, at each January, as many as fit.
  const yearly = chart.length > 24
  const next = first >= 0 ? `${STRATEGY_NAME[view.plan.strategy]} · next ${planned[first].name}` : STRATEGY_NAME[view.plan.strategy]
  const input = (label: string, value: ReactNode, title?: string): ReactNode => (
    <span className="plan-input" key={label}>
      <span className="label-muted">{label}</span>{' '}
      <span className="num" title={title}>
        {value}
      </span>
    </span>
  )
  // Beside the take-home and the spending, as the Budget page had them: the run rate by where it comes from, and the
  // spending's lowest and highest month with each of the twelve.
  const sources = view.incomeSources.map((s) => `${s.name} ${fmtMoneyRound(s.monthlyCents)}`).join('\n')
  const spent = [`${fmtMoneyRound(view.spendLowCents)} – ${fmtMoneyRound(view.spendHighCents)}`, ...view.spendMonths.map((m) => `${monthShort(m.month)} ${fmtMoneyRound(m.cents)}`)].join('\n')

  return (
    <section className="asset-group" id="payoff">
      <div className="asset-group-head plan-head">
        <h2 id="payoff-head" tabIndex={-1}>
          Payoff plan
        </h2>
        <span className="label-muted" title={next}>
          {next}
        </span>
      </div>
      <section className={`stat-strip ${atTargets ? 'even' : 'three'} plan-strip`}>
        <div className="tile">
          <div className="label-muted">Debt-free</div>
          <div className="tile-value">{r.debtFree && planned.length ? monthShort(r.debtFree) : '—'}</div>
          {likely && <div className="delta">{`${monthShort(likely.early)} – ${monthShort(likely.late)}`}</div>}
        </div>
        <div className="tile">
          <div className="label-muted">To debts a month</div>
          <div className="tile-value">{planned.length ? fmtMoneyRound(run.monthlyCents) : '—'}</div>
          {r.shortfallCents > 0 ? (
            <div className="delta bad">{fmtMoneyRound(r.shortfallCents)} short of the minimums</div>
          ) : (
            planned.length > 0 && <div className="delta">{`${planned.length} ${planned.length === 1 ? 'debt' : 'debts'} · ${fmtMoneyRound(owed)}`}</div>
          )}
        </div>
        <div className="tile">
          <div className="label-muted">Interest</div>
          <div className="tile-value">{planned.length ? interest(r) : '—'}</div>
        </div>
        {atTargets && (
          <div className="tile">
            <div className="label-muted">At targets</div>
            <div className="tile-value">{atTargets.result.debtFree && planned.length ? monthShort(atTargets.result.debtFree) : '—'}</div>
            <div className={`delta ${sooner !== null && sooner > 0 ? 'good' : sooner !== null && sooner < 0 ? 'bad' : ''}`}>
              {[sooner ? `${months(Math.abs(sooner))} ${sooner > 0 ? 'sooner' : 'later'}` : null, atTargets.result.debtFree ? `${interest(atTargets.result)} interest` : null].filter(Boolean).join(' · ')}
            </div>
          </div>
        )}
      </section>
      <div className="plan-inputs">
        {input('Take-home', view.plan.takeHomeCents === null ? fmtMoneyRound(run.takeHomeCents) : `${fmtMoneyRound(run.takeHomeCents)} · run rate ${fmtMoneyRound(view.takeHomeCents)}`, sources || undefined)}
        {input('Spending', atTargets ? `${fmtMoneyRound(view.spendCents)} · at targets ${fmtMoneyRound(atTargets.spendCents)}` : fmtMoneyRound(view.spendCents), spent)}
        {input('Set aside', fmtMoneyRound(view.plan.setAsideCents))}
        {input('Lump sum', fmtMoneyRound(view.plan.lumpCents))}
        {input('Left out', run.leftOut.length ? run.leftOut.map((d) => `${d.name} ${fmtMoneyRound(minimumIn(d, start))}`).join(' · ') : '—')}
      </div>
      <div className="muted small">{NOT_ADVICE}</div>

      {chart.length > 1 && (
        <div className="card plan-chart">
          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart} margin={{ top: 10, right: 10, bottom: 0, left: 0 }} aria-label={`What ${planned.length === 1 ? 'the debt owes' : 'the debts owe'}, ${monthShort(view.month)} to ${monthShort(chart[chart.length - 1].month)}`}>
                <CartesianGrid vertical={false} stroke="var(--ink-700)" />
                <XAxis
                  dataKey="month"
                  ticks={yearly ? chart.filter((p) => p.month.endsWith('-01')).map((p) => p.month) : undefined}
                  tickFormatter={(m: string) => (yearly ? m.slice(0, 4) : monthLabel(m, 'short').toUpperCase())}
                  interval="preserveStartEnd"
                  minTickGap={10}
                  tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }}
                  axisLine={{ stroke: 'var(--ink-600)' }}
                  tickLine={false}
                />
                <YAxis tickFormatter={(v: number) => fmtMoneyCompact(v)} tick={{ fontSize: 10.5, fill: 'var(--ink-400)', fontFamily: MONO }} axisLine={false} tickLine={false} width={60} />
                <Tooltip
                  cursor={{ stroke: 'var(--ink-500)', strokeWidth: 1 }}
                  content={({ active, payload, label }) =>
                    active && payload?.length ? (
                      <div className="chart-tooltip" style={{ minWidth: 190 }}>
                        <div className="label-muted">{monthShort(String(label))}</div>
                        {/* Top of the stack first, as the chart and the table below read. */}
                        {[...payload]
                          .reverse()
                          .filter((p) => Number(p.value) > 0)
                          .map((p) => (
                            <div className="row" key={String(p.dataKey)}>
                              <span className="swatch" style={{ background: String(p.color) }} /> {planned.find((d) => d.id === p.dataKey)?.name}
                              <span className="num" style={{ marginLeft: 'auto', paddingLeft: 14 }}>
                                {fmtMoneyRound(Number(p.value))}
                              </span>
                            </div>
                          ))}
                      </div>
                    ) : null
                  }
                />
                {stack.map((d) => (
                  <Area key={d.id} type="linear" dataKey={d.id} stackId="1" stroke={color(d.id)} strokeWidth={1.5} fill={color(d.id)} fillOpacity={0.16} isAnimationActive={false} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="plan-table">
        <div className="asset-table" role="table">
          <div className="debt-row head" role="row">
            <span role="columnheader">Debt</span>
            <span className="num" role="columnheader">
              Owed
            </span>
            <span className="num" role="columnheader">
              Rate
            </span>
            <span className="num" role="columnheader">
              Minimum
            </span>
            <span className="num" role="columnheader">
              #
            </span>
            <span className="num" role="columnheader">
              Paid off
            </span>
            <span className="num" role="columnheader">
              Interest
            </span>
          </div>
          {rows.map((d) => {
            const x = result.get(d.id)
            const off = leftOut.includes(d)
            const promo = d.promoEnds !== null && start < d.promoEnds.slice(0, 7)
            return (
              <div className={`debt-row ${off ? 'off' : ''}`} role="row" key={d.id}>
                <span className="debt-name clamp-2" role="cell" title={d.name}>
                  {!off && <span className="treat-dot" style={{ background: color(d.id) }} />}
                  {d.name}
                </span>
                <span className="num" role="cell">
                  {fmtMoneyRound(d.balanceCents)}
                </span>
                <span className={`num ${d.apr === null && !promo ? 'muted' : ''}`} role="cell" title={promo && d.apr !== null ? `${pct(d.apr)} from ${monthShort(d.promoEnds!.slice(0, 7))}` : undefined}>
                  {promo ? `${pct(d.promoApr ?? 0)} to ${monthShort(d.promoEnds!.slice(0, 7))}` : d.apr === null ? `≈${pct(d.kind === 'card' ? CARD_APR : LOAN_APR)}` : pct(d.apr)}
                </span>
                {/* The plan's minimum; one it assumes, with none on file or a card's usual above the one on file, marked ≈. */}
                <span className={`num ${minimum.get(d.id) !== d.minPaymentCents ? 'muted' : ''}`} role="cell">{`${minimum.get(d.id) !== d.minPaymentCents ? '≈' : ''}${fmtMoneyRound(minimum.get(d.id) ?? 0)}`}</span>
                <span className="num" role="cell">
                  {off ? '—' : (x?.order ?? '—')}
                </span>
                <span className="num" role="cell">
                  {off ? 'Left out' : x?.paidOff ? monthShort(x.paidOff) : '—'}
                </span>
                <span className="num muted" role="cell">
                  {off || !x?.paidOff ? '—' : fmtMoneyRound(x.interestCents)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
