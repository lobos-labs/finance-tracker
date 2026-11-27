import { useEffect, useState, type ReactNode } from 'react'
import { REPORT_REASONS, type AiReportInput, type ReportReason } from '../../shared/types'
import { useApp } from './App'
import { Icon } from './Icon'
import { api, errorMessage } from './lib'

// Report an AI answer (Review's messages, Home's headline): the answer
// as the user leaves it, a reason and a note. The main process adds the
// version, the feature and its model, and copies it or opens an email to the
// build's support address (src/shared/aiReport.ts); nothing else goes in.

/** The Report control under an answer: a flag and the word, like the chat's action lines. */
export function ReportButton({ onClick, className = '' }: { onClick: () => void; className?: string }): ReactNode {
  return (
    <button className={`link small ${className}`} aria-label="Report this answer" onClick={onClick}>
      <Icon name="flag" size={11} strokeWidth={2} /> Report
    </button>
  )
}

export function ReportDialog({ route, message, onClose }: { route: AiReportInput['route']; message: string; onClose: () => void }): ReactNode {
  const { toast } = useApp()
  const [text, setText] = useState(message)
  const [reason, setReason] = useState<ReportReason>('Wrong')
  const [note, setNote] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void api.getAppInfo().then((i) => alive && setEmail(i.supportEmail ?? ''), () => {})
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose, busy])

  const report = (): AiReportInput => ({ route, message: text, reason, note })
  async function run(fn: () => Promise<unknown>, done: string | null): Promise<void> {
    setBusy(true)
    try {
      await fn()
      if (done) toast(done)
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <h2 id="report-title">Report</h2>
        <label className="field" style={{ marginTop: 16 }}>
          Answer
          <textarea className="textarea report-message" rows={7} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="field-grid" style={{ marginTop: 12 }}>
          <label className="field">
            Reason
            <select className="select" value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
              {REPORT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Note
            <input className="input" value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {email && (
            <button className="btn" disabled={busy || !text.trim()} onClick={() => void run(() => api.emailAiReport(report()), null)}>
              Email
            </button>
          )}
          <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void run(() => api.copyAiReport(report()), 'Report copied')}>
            Copy report
          </button>
        </div>
      </div>
    </div>
  )
}
