import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectorStatus } from '../../../shared/types'
import { useApp } from '../App'
import { api, errorMessage } from '../lib'

// Settings → Claude Desktop (src/main/connector.ts): the connector and Allow
// changes, the extension's install, and each change made through it with
// Undo. The open edition's and a development build's: every other build's
// status says it isn't offered, and the card isn't there.

const fmtWhen = (unix: number): string => new Date(unix * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function Connector(): ReactNode {
  const { toast, tick } = useApp()
  const [s, setS] = useState<ConnectorStatus | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.connectorStatus().then((v) => alive && setS(v), () => {})
    return () => {
      alive = false
    }
  }, [tick])
  if (!s?.offered) return null

  const run = (what: string, fn: () => Promise<ConnectorStatus>): void => {
    setBusy(what)
    void fn()
      .then(setS, (e) => toast(errorMessage(e), 'error'))
      .finally(() => setBusy(null))
  }
  const install = (): void => {
    setBusy('install')
    void api
      .installConnector()
      .then((r) => setFile(r.file), (e) => toast(errorMessage(e), 'error'))
      .finally(() => setBusy(null))
  }

  return (
    <div className="card">
      <h2>Claude Desktop</h2>
      <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
        <label className="check">
          <input
            type="checkbox"
            checked={s.on}
            disabled={busy !== null}
            onChange={(e) => {
              const on = e.target.checked
              run('on', () => api.setConnector({ on }))
            }}
          />
          Connector
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.allowChanges}
            disabled={busy !== null}
            onChange={(e) => {
              const allowChanges = e.target.checked
              run('write', () => api.setConnector({ allowChanges }))
            }}
          />
          Allow changes
        </label>
        {s.on && (
          <span className="row small" style={{ gap: 8 }}>
            <span className={`status-dot ${s.running ? 'on' : 'bad'}`} aria-hidden />
            {s.running ? 'Running' : (s.error ?? 'Stopped')}
          </span>
        )}
      </div>
      <div className="row" style={{ gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn small" disabled={busy !== null} onClick={install}>
          {busy === 'install' ? 'Writing…' : 'Install in Claude Desktop'}
        </button>
        {file && <code className="mono small connector-file">{file}</code>}
      </div>
      {s.changes.length > 0 && (
        <table className="cat-table connector-changes" style={{ marginTop: 16 }}>
          <tbody>
            {s.changes.map((c) => (
              <tr key={c.id}>
                <td className="mono small">{c.summary}</td>
                <td className="mono small">{fmtWhen(c.at)}</td>
                <td className="num">
                  {c.undone ? (
                    <span className="label-muted">Undone</span>
                  ) : (
                    <button className="btn small ghost" disabled={busy !== null} onClick={() => run(`undo-${c.id}`, () => api.undoConnectorChange(c.id))}>
                      {busy === `undo-${c.id}` ? 'Undoing…' : 'Undo'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
