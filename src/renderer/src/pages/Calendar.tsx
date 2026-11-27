import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CalendarItem, GoogleCalendarStatus, Spendable } from '../../../shared/types'
import { parseAmount } from '../../../shared/parse'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { PlanLock } from '../Tier'
import { api, currentMonth, errorMessage, fmtAgo, fmtMoneyRound, monthLabel, shiftMonth, todayKey } from '../lib'
import { UpcomingList, upcomingUntil } from './Upcoming'

// The calendar: the month's reminders, bills, paychecks and renewals on a grid, and beside it the next 30 days, the
// one upcoming list (waterfall spec section 4), from the same forecast as Elective's By date on Home.

const CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const plusDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}

function amountText(i: CalendarItem): string {
  if (i.amountCents === null) return ''
  return `${i.kind === 'income' ? '+' : ''}${fmtMoneyRound(Math.abs(i.amountCents))}`
}

/** '15:20' as '3:20 PM', or '3:20p' short. */
function clock(t: string, short = false): string {
  const [h, m] = t.split(':').map(Number)
  const half = h < 12 ? 'AM' : 'PM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${short ? half[0].toLowerCase() : ` ${half}`}`
}

const timeRange = (i: CalendarItem): string => (i.start && i.end ? `${clock(i.start)}–${clock(i.end)}` : '')

type Draft = { id: number | null; day: string; title: string; amount: string; notes: string }

export default function Calendar(): ReactNode {
  const { tick, toast } = useApp()
  const [month, setMonth] = useState(currentMonth())
  const [items, setItems] = useState<CalendarItem[]>([])
  const [spend, setSpend] = useState<Spendable | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [transfers, setTransfers] = useState(false)
  const [zone, setZone] = useState('')
  const today = todayKey()

  // Whole weeks covering the month, Sunday first.
  const days = useMemo(() => {
    const first = new Date(`${month}-01T12:00:00`)
    const start = plusDays(dayKey(first), -first.getDay())
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12)
    const count = Math.ceil((first.getDay() + last.getDate()) / 7) * 7
    return Array.from({ length: count }, (_, i) => plusDays(start, i))
  }, [month])

  const load = useCallback(() => {
    api.listCalendar(days[0], days[days.length - 1]).then(setItems, (e) => toast(errorMessage(e), 'error'))
  }, [days, toast])

  useEffect(load, [load, tick])
  // The next 30 days don't move with the month shown: read again only when the data changes.
  useEffect(() => {
    api.getSpendable().then(setSpend, () => {})
  }, [tick])
  useEffect(() => {
    api.getCalendarTransfers().then(setTransfers, () => {})
    api.getCalendarTimeZone().then(setZone, () => {})
  }, [tick])

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>()
    for (const i of items) m.set(i.day, [...(m.get(i.day) ?? []), i])
    return m
  }, [items])

  async function exportIcs(): Promise<void> {
    try {
      const path = await api.exportCalendar()
      if (path) toast(`Saved ${path}`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const open = (i: CalendarItem): void => {
    if (i.eventId !== null) setDraft({ id: i.eventId, day: i.day, title: i.title, amount: i.amountCents === null ? '' : (i.amountCents / 100).toFixed(2), notes: i.notes ?? '' })
  }

  return (
    <>
      <PageHeader title="Calendar">
        <div className="month-switch">
          <button className="btn icon-btn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            <Icon name="chevronLeft" size={15} />
          </button>
          <div className="month-label">{monthLabel(month)}</div>
          <button className="btn icon-btn" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
            <Icon name="chevronRight" size={15} />
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={transfers} onChange={(e) => void api.setCalendarTransfers(e.target.checked)} />
          Transfers
        </label>
        <label className="check" style={{ whiteSpace: 'nowrap' }}>
          Time zone
          <input
            className="input"
            style={{ width: 190 }}
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            onBlur={() => void api.setCalendarTimeZone(zone.trim() || null).catch((e) => toast(errorMessage(e), 'error'))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </label>
        <button className="btn" onClick={() => void exportIcs()}>
          <Icon name="download" size={15} /> .ics
        </button>
        <button className="btn primary" onClick={() => setDraft({ id: null, day: today, title: '', amount: '', notes: '' })}>
          <Icon name="plus" size={15} /> Reminder
        </button>
      </PageHeader>
      <div className="page">
        <div className="cal-layout">
          <div className="card cal-card">
            <div className="cal-grid">
              {WEEKDAYS.map((w) => (
                <div key={w} className="cal-weekday label-muted">
                  {w}
                </div>
              ))}
              {days.map((d) => {
                const list = byDay.get(d) ?? []
                const inMonth = d.startsWith(month)
                return (
                  <div
                    key={d}
                    className={`cal-cell ${inMonth ? '' : 'out'} ${d === today ? 'today' : ''}`}
                    onClick={(e) => e.target === e.currentTarget && setDraft({ id: null, day: d, title: '', amount: '', notes: '' })}
                  >
                    <div className="cal-daynum">{Number(d.slice(8))}</div>
                    {list.slice(0, 3).map((i) => (
                      <button key={i.key} className={`cal-chip ${i.kind}`} title={[timeRange(i), i.title, amountText(i), i.notes].filter(Boolean).join(' · ')} onClick={() => open(i)}>
                        {i.start && <span className="cal-time">{clock(i.start, true)}</span>}
                        <span className={`truncate ${i.done ? 'cal-done' : ''}`}>{i.title}</span>
                      </button>
                    ))}
                    {list.length > 3 && <div className="cal-more">+{list.length - 3}</div>}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="cal-side">
            <div className="card">
              <h2>Next 30 days</h2>
              {spend ? <UpcomingList spend={spend} until={upcomingUntil(today)} /> : <div className="skeleton" style={{ height: 120 }} />}
            </div>
            <GoogleCard />
          </div>
        </div>
      </div>
      {draft && <ReminderModal draft={draft} onClose={() => setDraft(null)} />}
    </>
  )
}

function ReminderModal({ draft, onClose }: { draft: Draft; onClose: () => void }): ReactNode {
  const { toast } = useApp()
  const [f, setF] = useState(draft)

  async function save(): Promise<void> {
    const amount = f.amount.trim() ? parseAmount(f.amount) : null
    if (f.amount.trim() && amount === null) return toast(`Couldn't read "${f.amount}" as an amount`, 'error')
    try {
      const fields = { day: f.day, title: f.title, notes: f.notes || null, amountCents: amount === null ? null : Math.abs(amount) }
      if (f.id === null) await api.addCalendarEvent(fields)
      else await api.updateCalendarEvent(f.id, fields)
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function remove(): Promise<void> {
    if (f.id === null) return
    try {
      await api.deleteCalendarEvent(f.id)
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="reminder-title">
        <h2 id="reminder-title">{f.id === null ? 'New reminder' : 'Reminder'}</h2>
        <div className="field-grid" style={{ marginTop: 16 }}>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Title
            <input className="input" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void save()} />
          </label>
          <label className="field">
            Date
            <input className="input" type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
          </label>
          <label className="field">
            Amount
            <input className="input num" value={f.amount} placeholder="Optional" onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </label>
        </div>
        <label className="field" style={{ marginTop: 12 }}>
          Notes
          <textarea className="textarea" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <div className="modal-actions">
          {f.id !== null && (
            <button className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={() => void remove()}>
              Delete
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!f.title.trim() || !f.day} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function GoogleCard(): ReactNode {
  const { can } = useApp()
  if (!can('googleSync')) return <PlanLock feature="googleSync" title="Google Calendar" compact />
  return <GoogleSync />
}

function GoogleSync(): ReactNode {
  const { toast, tick } = useApp()
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<'connect' | 'sync' | null>(null)

  useEffect(() => {
    api.googleStatus().then(setStatus, () => {})
  }, [tick])

  async function run(kind: 'connect' | 'sync', fn: () => Promise<GoogleCalendarStatus>): Promise<void> {
    setBusy(kind)
    try {
      setStatus(await fn())
      toast(kind === 'connect' ? 'Google Calendar connected' : 'Google Calendar updated')
    } catch (e) {
      toast(errorMessage(e), 'error')
      setStatus(await api.googleStatus())
    } finally {
      setBusy(null)
    }
  }

  // Turning Tasks on without the scope opens Google sign-in, so it waits like Connect does.
  async function setTasks(on: boolean): Promise<void> {
    setBusy('connect')
    try {
      setStatus(await api.googleSetTasks(on))
    } catch (e) {
      toast(errorMessage(e), 'error')
      setStatus(await api.googleStatus())
    } finally {
      setBusy(null)
    }
  }

  async function saveCredentials(): Promise<void> {
    try {
      await api.googleSetCredentials(clientId, secret)
      setClientId('')
      setSecret('')
      setEditing(false)
      setStatus(await api.googleStatus())
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  if (!status) return null
  const needsCredentials = !status.configured || editing

  return (
    <div className="card">
      <h2>Google Calendar</h2>
      {needsCredentials ? (
        <>
          <div className="muted small" style={{ marginBottom: 12 }}>
            OAuth client (Desktop app) with the Google Calendar API enabled
          </div>
          <label className="field">
            Client ID
            <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </label>
          <label className="field" style={{ marginTop: 10 }}>
            Client secret
            <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="link small" style={{ marginRight: 'auto' }} onClick={() => void api.openExternal(CREDENTIALS_URL)}>
              Google Cloud credentials
            </button>
            {editing && (
              <button className="btn ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            <button className="btn primary" disabled={!clientId.trim() || !secret.trim()} onClick={() => void saveCredentials()}>
              Save
            </button>
          </div>
        </>
      ) : status.connected ? (
        <>
          <div className="row small">
            <span className="status-dot on" aria-hidden />
            {status.calendarName ?? 'Finance Tracker'} · synced {fmtAgo(status.lastSyncAt)}
          </div>
          {status.lastError && (
            <div className="small" style={{ color: 'var(--neg)', marginTop: 8 }}>
              {status.lastError}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={() => void api.googleDisconnect().then(() => api.googleStatus().then(setStatus))}>
              Disconnect
            </button>
            <label className="check small">
              <input type="checkbox" checked={status.tasksOn} disabled={busy !== null} onChange={(e) => void setTasks(e.target.checked)} />
              Google Tasks{busy === 'connect' ? ' · waiting for Google…' : status.tasksOn && !status.tasks ? ' · not granted' : ''}
            </label>
            <button className="btn" disabled={busy !== null} onClick={() => void run('sync', api.googleSync)}>
              <Icon name="refresh" size={14} className={busy === 'sync' ? 'spin' : ''} /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row small">
            <span className="status-dot" aria-hidden />
            Not connected
          </div>
          {status.lastError && (
            <div className="small" style={{ color: 'var(--neg)', marginTop: 8 }}>
              {status.lastError}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="link small" style={{ marginRight: 'auto' }} onClick={() => setEditing(true)}>
              Change client
            </button>
            <button className="btn primary" disabled={busy === 'sync'} onClick={() => void run('connect', api.googleConnect)}>
              {busy === 'connect' ? 'Waiting for Google… (retry)' : 'Connect'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
