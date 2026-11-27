import { useEffect, useState, type ReactNode } from 'react'
import { RECOVERY_LINE } from '../../shared/app'
import type { RestoreResult } from '../../shared/types'
import { useApp } from './App'
import { Icon } from './Icon'
import { api, errorMessage } from './lib'

// The database's recovery code (src/main/dbopen.ts): a new one shown once,
// with Print, and Saved to tick before it's sealed in (no Copy: Windows
// clipboard history and cloud clipboard would keep it); and the one field a
// code is typed into (restoring a backup made elsewhere, checking the saved
// code, and the window before the database opens). While either is on screen
// the window is kept out of screenshots and screen sharing.

let protecting = 0

/** Keeps the window out of screenshots, screen sharing and Recall while the calling component is mounted. */
function useProtectedWindow(): void {
  useEffect(() => {
    if (protecting++ === 0) api.protectWindow(true).catch(() => {})
    return () => {
      if (--protecting === 0) api.protectWindow(false).catch(() => {})
    }
  }, [])
}

/** A new code, Print and the Saved box; the caller's Done waits for `saved`. */
export function RecoveryCodeBlock({ saved, onSaved }: { saved: boolean; onSaved: (saved: boolean) => void }): ReactNode {
  const { toast, settings } = useApp()
  const [code, setCode] = useState<string | null>(null)
  useProtectedWindow()
  useEffect(() => {
    let alive = true
    void api.newRecoveryCode().then(
      (c) => alive && setCode(c),
      (e) => alive && toast(errorMessage(e), 'error')
    )
    return () => {
      alive = false
    }
  }, [toast])
  const print = (): void => void api.printRecoveryCode().then((p) => p && toast(`Saved to ${p}`), (e) => toast(errorMessage(e), 'error'))
  return (
    <div className="recovery">
      <div className="recovery-code" aria-label="Recovery code">
        {code ?? '·····-·····-·····-·····-·····-·····'}
      </div>
      <div className="recovery-actions">
        <button className="btn" disabled={!code} onClick={print}>
          <Icon name="download" size={14} /> Print
        </button>
        <label className="check">
          <input type="checkbox" checked={saved} disabled={!code} onChange={(e) => onSaved(e.target.checked)} />
          Saved
        </label>
      </div>
      <div className="muted small recovery-line">{RECOVERY_LINE[settings?.database?.keySeal ?? 'install']}</div>
    </div>
  )
}

/** A new code in a window: Done (once Saved is ticked) seals it in; Cancel, where offered, keeps the old one. */
export function RecoveryCodeModal({ onClose, cancel = true }: { onClose: () => void; cancel?: boolean }): ReactNode {
  const { toast, reloadSettings } = useApp()
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const done = (): void => {
    setBusy(true)
    void api.confirmRecoveryCode().then(
      () => {
        void reloadSettings()
        onClose()
      },
      (e) => {
        setBusy(false)
        toast(errorMessage(e), 'error')
      }
    )
  }
  return (
    <div className="modal-backdrop">
      <div className="modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <h2 id="recovery-title">Recovery code</h2>
        <RecoveryCodeBlock saved={saved} onSaved={setSaved} />
        <div className="modal-actions">
          {cancel && (
            <button className="btn ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="btn primary" disabled={!saved || busy} onClick={done}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/** One field for a recovery code; `submit` throws to show why it didn't work. */
export function CodeField({ submit, label = 'Open', autoFocus = true }: { submit: (code: string) => Promise<void>; label?: string; autoFocus?: boolean }): ReactNode {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useProtectedWindow()
  const go = (): void => {
    if (!code.trim() || busy) return
    setBusy(true)
    setError(null)
    submit(code).then(
      () => setBusy(false),
      (e) => {
        setBusy(false)
        setError(errorMessage(e))
      }
    )
  }
  return (
    <>
      <div className="recovery-field">
        <input
          className="input recovery-input"
          aria-label="Recovery code"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <button className="btn primary" disabled={!code.trim() || busy} onClick={go}>
          {busy ? '…' : label}
        </button>
      </div>
      <div className="neg small recovery-error" role="alert">
        {error ?? ''}
      </div>
    </>
  )
}

/** Restoring a backup encrypted on another computer: its recovery code, then the restore carries on (and the app restarts). */
export function RestoreCodeModal({ file, onClose }: { file: string; onClose: () => void }): ReactNode {
  const submit = async (code: string): Promise<void> => {
    const r: RestoreResult = await api.restoreBackupCode(code)
    if (r === null || typeof r === 'string') onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="restore-code-title">
        <h2 id="restore-code-title">Recovery code</h2>
        <div className="mono small muted recovery-file">{file}</div>
        <CodeField submit={submit} label="Restore" />
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/** Checks a code against the saved one. */
export function CheckCodeModal({ onClose }: { onClose: () => void }): ReactNode {
  const [result, setResult] = useState<boolean | null>(null)
  const submit = async (code: string): Promise<void> => {
    setResult(null)
    setResult(await api.checkRecoveryCode(code))
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="check-code-title">
        <h2 id="check-code-title">Check recovery code</h2>
        <CodeField submit={submit} label="Check" />
        {result !== null && <div className={`small ${result ? 'pos' : 'neg'}`}>{result ? 'Correct' : 'Not the saved code'}</div>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** The page shown before the database opens (index.html#unlock): the key file was sealed for another computer or account. */
export function UnlockPage(): ReactNode {
  return (
    <div className="unlock">
      <h2>Recovery code</h2>
      <CodeField
        submit={async (code) => {
          await api.unlockDatabase(code)
        }}
      />
    </div>
  )
}
