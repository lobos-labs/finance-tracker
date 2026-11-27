import type { ReactNode } from 'react'
import type { Spendable, SpendItem } from '../../../shared/types'
import { addDays } from '../../../shared/schedule'
import { fmtMoney } from '../lib'

// The one list of what's coming (waterfall spec 1.4 and section 4): the bills, paychecks and transfers getSpendable
// forecasts, account by account, at the amounts the forecast uses. Elective's By date and Calendar's next 30 days
// are this list over the same days, from the same forecast.

/** How far the list runs: the next 30 days. */
export const UPCOMING_DAYS = 30

/** The list's last day: 30 days on from today (YYYY-MM-DD). */
export const upcomingUntil = (today: string): string => addDays(today, UPCOMING_DAYS)

/** "Nov 14" */
export const monthDay = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Money in with a plus, money out as its size: "+$1,888.50", "$17.99". */
export function amountText(cents: number): string {
  return cents > 0 ? `+${fmtMoney(cents)}` : fmtMoney(Math.abs(cents))
}

/** What the list holds through a day: bills, paychecks and transfers; everyday trips (groceries, gas) and irregular pay are Spendable's. */
export function upcomingItems(spend: Spendable, until: string): SpendItem[] {
  return spend.items.filter((i) => i.day <= until && !i.everyday && !i.irregular)
}

/** What's expected through `until`, account by account (the ones with a current balance first), at the amounts the forecast uses. */
export function UpcomingList({ spend, until }: { spend: Spendable; until: string }): ReactNode {
  const items = upcomingItems(spend, until)
  const ids = [...new Set([...spend.accounts.map((a) => a.id), ...items.map((i) => i.accountId)])].filter((id) => items.some((i) => i.accountId === id))
  if (!items.length) return <div className="muted small">Nothing due</div>
  return (
    <>
      {ids.map((id) => {
        const mine = items.filter((i) => i.accountId === id)
        const balance = spend.accounts.find((a) => a.id === id)?.startCents
        return (
          <section className="up-account" key={id}>
            <div className="up-head">
              <span className="label-muted truncate">{mine[0].accountName}</span>
              {balance !== undefined && <span className="num small">{fmtMoney(balance)}</span>}
            </div>
            {mine.map((i) => (
              <div className="list-row" key={i.key}>
                <div className="mono small muted" style={{ width: 48, flexShrink: 0 }}>
                  {monthDay(i.day)}
                </div>
                <div className="grow clamp-2">{i.name}</div>
                {i.late && <span className="tag low">Late</span>}
                <div className={`num ${i.cents > 0 ? 'pos' : ''}`}>
                  {i.estimated ? '~' : ''}
                  {amountText(i.cents)}
                </div>
              </div>
            ))}
          </section>
        )
      })}
    </>
  )
}
