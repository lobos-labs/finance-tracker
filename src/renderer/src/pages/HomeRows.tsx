import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import type { CommittedGroup, HomeOpen, StageId } from '../../../shared/types'
import type { Page } from '../App'
import { Icon } from '../Icon'
import { ROW_NAME, type DataLine, type ElectiveView, type HomeTable, type LeftOverView, type PartLine, type PayTableLine, type SlotLine } from './homeView'
import type { NetView } from './NetWorth'
import type { TxnFilter } from './txnFilter'

// Home's rows as homeView lays them out: a subtotal a line, the open one with the rows that lead into it, its Δ
// pts, its parts and its data lines, Take-home's pay-day tables, Elective's groups and Left over's categories with their
// tier tag and habits (or its payees), then Unsorted and Unexplained
// when they show. Every part opens the Transactions list on exactly its lines. React and the icons only, so the
// tests render it as the page does; what the page reads for an open row itself it hands in as a slot.

const SPARK_W = 72
const SPARK_H = 16
/** Up to two years of months each get a bar; past that a bar is under 3 px a month, so the months are one line. */
const SPARK_BARS = 24

/** A row's run rates over the months, a bar each, the latest last; a bar below zero hangs under the line. */
function Spark({ values }: { values: number[] }): ReactNode {
  if (!values.length) return null
  const hi = Math.max(0, ...values)
  const lo = Math.min(0, ...values)
  const range = hi - lo || 1
  const zero = (hi / range) * SPARK_H
  const slot = SPARK_W / values.length
  if (values.length > SPARK_BARS) {
    // A long span, All over years of months: a line through each month's run rate, the latest marked.
    const at = (v: number, i: number): [number, number] => [(i + 0.5) * slot, zero - (v / range) * SPARK_H]
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${at(v, i).map((n) => n.toFixed(1)).join(',')}`).join('')
    const [x, y] = at(values[values.length - 1], values.length - 1)
    return (
      <svg className="spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden>
        <path d={d} className="spark-line" />
        <circle cx={x} cy={y} r={1.75} className={`spark-bar last${values[values.length - 1] < 0 ? ' neg' : ''}`} />
      </svg>
    )
  }
  return (
    <svg className="spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden>
      {values.map((v, i) => {
        const h = Math.max((Math.abs(v) / range) * SPARK_H, v ? 1 : 0)
        return <rect key={i} x={i * slot + 0.5} y={v >= 0 ? zero - h : zero} width={Math.max(slot - 1.5, 1)} height={h} className={`spark-bar${v < 0 ? ' neg' : ''}${i === values.length - 1 ? ' last' : ''}`} />
      })}
    </svg>
  )
}

/** What a Home row's lines open: a row, the Transactions list on a drill's lines, a page, a Committed group, Elective's view. */
export interface HomeRowsProps {
  table: HomeTable
  onOpen: (id: HomeOpen | 'unexplained') => void
  /** the Transactions list on exactly a part's lines */
  onDrill: (f: TxnFilter) => void
  /** a page, or with `view` that view of Net worth */
  onPage?: (p: Page, view?: NetView) => void
  onGroup?: (g: CommittedGroup) => void
  onView?: (v: ElectiveView) => void
  /** Left over's Categories or Payees */
  onLeftOverView?: (v: LeftOverView) => void
  /** a view of Net worth: the debt plan's next target opens Debts */
  onNet?: (v: NetView) => void
  /** what the page draws itself under the open row: Take-home's contributions, Elective's next 30 days */
  slots?: Partial<Record<SlotLine['key'], ReactNode>>
}

/** An Everyday category's tier, as its tag is read out. */
const TAG_NAME: Record<NonNullable<PartLine['tag']>, string> = { E: 'Essential', L: 'Lifestyle' }

/** A data line's text: its items as links where they open something, and the row or the view of Net worth it passes its money to. */
function DataText({ l, onOpen, onDrill, onPage, onNet }: { l: DataLine } & Pick<HomeRowsProps, 'onOpen' | 'onDrill' | 'onPage' | 'onNet'>): ReactNode {
  const items = l.items
  return (
    <span className="data-text">
      {items
        ? items.map((i, n) => (
            // Two items can read the same (two purchases of one amount at one store), so each is keyed by its place too.
            <Fragment key={`${n}:${i.text}`}>
              {n > 0 && ' · '}
              {i.drill ? (
                <button className="link-quiet" onClick={() => onDrill(i.drill!)}>
                  {i.text}
                </button>
              ) : i.page && onPage ? (
                <button className="link small" onClick={() => onPage(i.page!, i.view)}>
                  › {i.text}
                </button>
              ) : (
                i.text
              )}
            </Fragment>
          ))
        : l.text}
      {l.to && (
        <button className="link small data-to" onClick={() => onOpen(l.to!)}>
          › {ROW_NAME[l.to as StageId]}
        </button>
      )}
      {l.net && onNet && (
        <button className="link small data-to" onClick={() => onNet(l.net!.view)}>
          › {l.net.label}
        </button>
      )}
    </span>
  )
}

/** A payroll's checks as a table of their own, scrolling sideways when the span holds more than fit: Take-home's, and Pay & benefits'. */
export function PayTable({ l, onDrill }: { l: PayTableLine; onDrill: (f: TxnFilter) => void }): ReactNode {
  // The latest checks are the ones in view: a year's table opens scrolled to its end.
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (wrap.current) wrap.current.scrollLeft = wrap.current.scrollWidth
  }, [])
  return (
    <div className="pay-table-wrap" ref={wrap}>
      <table className="pay-table">
        <thead>
          <tr>
            <th scope="col" className="pay-name">
              <button className="link-quiet" onClick={() => onDrill(l.drill)}>
                {l.name}
              </button>
            </th>
            {l.checks.map((c, i) => (
              <th scope="col" key={i}>
                <button className="link-quiet" onClick={() => onDrill(c.drill)}>
                  {c.label}
                </button>
              </th>
            ))}
            <th className="pay-tie" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {l.rows.map((r) => (
            <tr key={r.label} className={`pay-${r.kind}`}>
              <th scope="row">{r.label}</th>
              {r.cells.map((c, i) => (
                <td key={i} className="num">
                  {c}
                </td>
              ))}
              <td className="pay-tie">{r.kind === 'deposit' && l.tied ? '✓' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function HomeRows({ table, onOpen, onDrill, onPage, onGroup, onView, onLeftOverView, onNet, slots = {} }: HomeRowsProps): ReactNode {
  const cols = table.perMonth ? 7 : 6
  return (
    <div className="home-table">
      <table className="home-rows">
        <thead>
          <tr>
            <th scope="col" className="name" />
            <th scope="col">{table.heading.amount}</th>
            {table.perMonth && (
              <th scope="col" className="per-month">
                Per month
              </th>
            )}
            <th scope="col">Run rate</th>
            <th scope="col">Rate</th>
            <th scope="col">Δ 3 mo</th>
            <th scope="col" className="spark-col">
              {table.heading.spark}
            </th>
          </tr>
        </thead>
        <tbody>
          {table.lines.map((l) => {
            switch (l.kind) {
              case 'row':
                return (
                  // Home's own rows open; the rows under an open one are its figures.
                  <tr key={l.id} className={`waterfall-row${l.less ? ' less' : ''}${l.open ? ' open' : ''}`} onClick={l.less ? undefined : () => onOpen(l.id as HomeOpen)}>
                    <th scope="row" className="name">
                      {l.less ? (
                        <span>{l.name}</span>
                      ) : (
                        <button className="row-name" aria-expanded={l.open}>
                          {l.name}
                        </button>
                      )}
                    </th>
                    <td className="num">{l.amount}</td>
                    {table.perMonth && <td className="num per-month">{l.perMonth}</td>}
                    <td className="num">{l.runRate}</td>
                    <td className="num rate">
                      {l.rate}
                      {l.focus && <span className="focus-dot" role="img" aria-label="Focus" />}
                      {l.pts && <span className="pts">{l.pts}</span>}
                    </td>
                    <td className="num">{l.change}</td>
                    <td className="spark-col">
                      {l.spark ? (
                        <Spark values={l.spark} />
                      ) : l.to ? (
                        <button
                          className="link small"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpen(l.to!)
                          }}
                        >
                          › Saved
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              case 'part':
                return (
                  // A part opens the Transactions list on exactly its lines.
                  // A long name (a payee's bank description) is cut short to the column, whole in its title; the tag
                  // keeps the column's right edge.
                  <tr key={l.key} className={`part${l.drill ? ' drill' : ''}${l.nested ? ' nested' : ''}`} onClick={l.drill ? () => onDrill(l.drill!) : undefined}>
                    <th scope="row" className="name">
                      <span className="part-name">
                        {l.drill ? (
                          <button className="row-name" title={l.name}>
                            {l.name}
                          </button>
                        ) : (
                          <span title={l.name}>{l.name}</span>
                        )}
                        {l.tag && (
                          <abbr className="part-tag" title={TAG_NAME[l.tag]}>
                            {l.tag}
                          </abbr>
                        )}
                      </span>
                      {l.note && <span className={`part-note${l.beside ? ' beside' : ''}`}>{l.note}</span>}
                    </th>
                    {l.beside && !l.amount && !l.runRate && !l.change && l.perMonth === null ? (
                      // A part with no figures of its own (a habit) has its data across the figures' columns.
                      <td colSpan={cols - 1} className="beside-span">
                        <span className="part-beside">{l.note}</span>
                      </td>
                    ) : (
                      <>
                        <td className="num">{l.amount}</td>
                        {table.perMonth && <td className="num per-month">{l.perMonth}</td>}
                        <td className="num">{l.runRate}</td>
                        <td />
                        <td className="num">{l.change}</td>
                        <td className="spark-col">{l.beside && <span className="part-beside">{l.note}</span>}</td>
                      </>
                    )}
                  </tr>
                )
              case 'account': {
                // An account opens the view of Net worth that holds it. Past a width its name wraps, as a bank's long
                // one would otherwise widen the table past the window.
                const go = l.view && onPage ? () => onPage('networth', l.view!) : undefined
                const name = <span className="account-name">{l.name}</span>
                return (
                  <tr key={l.key} className={`part account${go ? ' drill' : ''}`} onClick={go}>
                    <th scope="row" className="name">
                      {go ? <button className="row-name">{name}</button> : name}
                      <span className="part-note">{l.note}</span>
                    </th>
                    <td className="num">{l.amount}</td>
                    {table.perMonth && <td className="num per-month">{l.perMonth}</td>}
                    <td className="num">{l.runRate}</td>
                    <td />
                    <td />
                    <td className="spark-col" />
                  </tr>
                )
              }
              case 'closed':
                return (
                  <tr key={l.key} className={`closed${l.nested ? ' nested' : ''}`}>
                    <th scope="row" className="name">
                      {l.name}
                    </th>
                    <td className="num">{l.now}</td>
                    {table.perMonth && <td className="per-month" />}
                    <td className="num">
                      <span className="label-muted">closed</span> {l.closed}
                    </td>
                    <td />
                    <td className="num">{l.change}</td>
                    <td className="spark-col" />
                  </tr>
                )
              case 'data':
                return (
                  <tr key={l.key} className="data">
                    <td colSpan={cols}>
                      {l.label && <span className="label-muted">{l.label}</span>}
                      <DataText l={l} onOpen={onOpen} onDrill={onDrill} onPage={onPage} onNet={onNet} />
                    </td>
                  </tr>
                )
              case 'payTable':
                return (
                  // Keyed apart from the pay parts beside it, which are keyed pay:<paycheck key> too.
                  <tr key={`paytable:${l.key}`} className="data pay">
                    <td colSpan={cols}>
                      <PayTable l={l} onDrill={onDrill} />
                    </td>
                  </tr>
                )
              case 'group':
                return (
                  // A group opens into its series, loans and cards.
                  <tr key={`group:${l.key}`} className={`group${l.open ? ' open-group' : ''}`} onClick={() => onGroup?.(l.key)}>
                    <th scope="row" className="name">
                      <button className="row-name" aria-expanded={l.open}>
                        {l.name}
                      </button>
                      {/* Its data, which a narrow window shows here in place of beside the figures. */}
                      <span className="part-note">{l.label}</span>
                    </th>
                    <td className="num">{l.amount}</td>
                    {table.perMonth && <td className="num per-month">{l.perMonth}</td>}
                    <td className="num">{l.runRate}</td>
                    <td colSpan={3} className="group-label">
                      {l.label}
                    </td>
                  </tr>
                )
              case 'switch':
                return l.key === 'leftOverView' ? (
                  <tr key={l.key} className="data switch">
                    <td colSpan={cols}>
                      <div className="segmented" role="group" aria-label="Everyday by">
                        {l.options.map((o) => (
                          <button key={o.id} className={l.value === o.id ? 'active' : ''} aria-pressed={l.value === o.id} onClick={() => onLeftOverView?.(o.id)}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={l.key} className="data switch">
                    <td colSpan={cols}>
                      <div className="segmented" role="group" aria-label="Committed by">
                        {l.options.map((o) => (
                          <button key={o.id} className={l.value === o.id ? 'active' : ''} aria-pressed={l.value === o.id} onClick={() => onView?.(o.id)}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                )
              case 'slot':
                return slots[l.key] ? (
                  <tr key={`slot:${l.key}`} className="data slot">
                    <td colSpan={cols}>{slots[l.key]}</td>
                  </tr>
                ) : null
              case 'unsorted':
                return (
                  <tr key="unsorted" className="waterfall-row extra" onClick={() => onDrill(l.drill)}>
                    <th scope="row" className="name">
                      <button className="row-name">
                        Unsorted <span className="muted">{l.count}</span>
                      </button>
                    </th>
                    <td className="num">{l.amount}</td>
                    {table.perMonth && <td className="per-month" />}
                    <td />
                    <td className="num rate">{l.focus && <span className="focus-dot" role="img" aria-label="Focus" />}</td>
                    <td />
                    <td className="spark-col">
                      <Icon name="chevronRight" size={13} />
                    </td>
                  </tr>
                )
              case 'unexplained':
                return (
                  <tr key="unexplained" className={`waterfall-row extra${l.open ? ' open' : ''}`} onClick={() => onOpen('unexplained')}>
                    <th scope="row" className="name">
                      <button className="row-name" aria-expanded={l.open}>
                        Unexplained
                      </button>
                    </th>
                    <td className="num">{l.amount}</td>
                    {table.perMonth && <td className="per-month" />}
                    <td />
                    <td className="num rate">{l.focus && <span className="focus-dot" role="img" aria-label="Focus" />}</td>
                    <td />
                    <td className="spark-col" />
                  </tr>
                )
            }
          })}
        </tbody>
      </table>
    </div>
  )
}
