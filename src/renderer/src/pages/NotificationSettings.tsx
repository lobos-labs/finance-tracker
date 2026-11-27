import { useEffect, useState, type ReactNode } from 'react'
import { NOTIFY_KIND_LABELS, NOTIFY_KINDS, type NotificationPatch, type NotificationSettings } from '../../../shared/types'
import { useApp } from '../App'
import { api, errorMessage } from '../lib'

// Settings → Notifications: the tray, open at login, each kind's switch, quiet hours and the pause (src/main/alerts.ts).

const QUIET = { start: '22:00', end: '07:00' }

const fmtTime = (unix: number): string => new Date(unix * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

export function Notifications(): ReactNode {
  const { toast, tick } = useApp()
  const [s, setS] = useState<NotificationSettings | null>(null)
  useEffect(() => {
    let alive = true
    void api.getNotificationSettings().then((v) => alive && setS(v), () => {})
    return () => {
      alive = false
    }
  }, [tick])
  if (!s) return null

  const save = (patch: NotificationPatch): void => void api.setNotificationSettings(patch).then(setS, (e) => toast(errorMessage(e), 'error'))
  const quiet = s.quietHours

  return (
    <div className="card">
      <h2>Notifications</h2>
      <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
        <label className="check">
          <input type="checkbox" checked={s.keepRunning} onChange={(e) => save({ keepRunning: e.target.checked })} />
          Keep running in the background
        </label>
        {s.loginOffered && (
          <label className="check">
            <input type="checkbox" checked={s.openAtLogin} onChange={(e) => save({ openAtLogin: e.target.checked })} />
            Open at login
          </label>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 18 }}>
        {NOTIFY_KINDS.map((k) => (
          <label className="check" key={k}>
            <input type="checkbox" checked={s.kinds[k]} onChange={(e) => save({ kinds: { [k]: e.target.checked } })} />
            {NOTIFY_KIND_LABELS[k]}
          </label>
        ))}
      </div>
      <div className="row" style={{ gap: 24, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 18 }}>
        <label className="check" style={{ paddingBottom: 9 }}>
          <input type="checkbox" checked={!!quiet} onChange={(e) => save({ quietHours: e.target.checked ? QUIET : null })} />
          Quiet hours
        </label>
        {quiet && (
          <>
            <label className="field">
              From
              <input className="input" type="time" value={quiet.start} onChange={(e) => e.target.value && save({ quietHours: { ...quiet, start: e.target.value } })} />
            </label>
            <label className="field">
              To
              <input className="input" type="time" value={quiet.end} onChange={(e) => e.target.value && save({ quietHours: { ...quiet, end: e.target.value } })} />
            </label>
          </>
        )}
      </div>
      <div className="row" style={{ gap: 12, marginTop: 18 }}>
        {s.pausedUntil ? (
          <>
            <span>Paused until {fmtTime(s.pausedUntil)}</span>
            <button className="btn small" onClick={() => save({ pauseMinutes: 0 })}>
              Resume
            </button>
          </>
        ) : (
          <button className="btn small" onClick={() => save({ pauseMinutes: 60 })}>
            Pause for 1 hour
          </button>
        )}
      </div>
    </div>
  )
}
