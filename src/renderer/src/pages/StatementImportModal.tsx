import { useState, type ReactNode } from 'react'
import { isBankFed, isStatementPreview, type Account, type ImportPreview, type StatementPreview } from '../../../shared/types'
import { classifiedToasts, useApp } from '../App'
import { api, errorMessage, fmtDate, fmtDay, fmtMoney } from '../lib'
import CsvImportModal from './CsvImportModal'

// The import dialog for QFX, OFX and QIF files: one block per account in the
// file (its last 4, rows, dates, closing balance and first rows), each with
// the account it goes into. ImportModal picks this or the CSV dialog.

interface Choice {
  /** an account id, '' for a new account, 'skip' to leave the statement out */
  target: string
  name: string
  flip: boolean
}

export function StatementImportModal({ preview, accounts, onClose }: { preview: StatementPreview; accounts: Account[]; onClose: () => void }): ReactNode {
  const { toast } = useApp()
  const [choices, setChoices] = useState<Choice[]>(preview.accounts.map((s) => ({ target: s.matchId ?? '', name: s.suggestedName, flip: s.invertSign })))
  const [busy, setBusy] = useState(false)
  const set = (i: number, patch: Partial<Choice>): void => setChoices((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  const rows = preview.accounts.reduce((n, s, i) => n + (choices[i].target === 'skip' ? 0 : s.rowCount), 0)
  const ready = choices.some((c) => c.target !== 'skip') && choices.every((c) => c.target !== '' || c.name.trim())

  async function doImport(): Promise<void> {
    setBusy(true)
    try {
      const targets = choices.map((c) => (c.target === 'skip' ? null : { accountId: c.target || undefined, newAccountName: c.target ? undefined : c.name, invertSign: c.flip }))
      const r = await api.statementImport({ token: preview.token, targets })
      toast(`Imported ${r.imported} · skipped ${r.skipped} already present${r.invalid ? ` · ${r.invalid} unreadable` : ''}${r.balances ? ` · ${r.balances} balance${r.balances === 1 ? '' : 's'}` : ''}`)
      for (const [text, kind] of classifiedToasts(r.classified)) toast(text, kind)
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="stmt-title">
        <h2 id="stmt-title">Import {preview.fileName}</h2>
        <div className="label-muted">
          {preview.format}
          {preview.institution ? ` · ${preview.institution}` : ''}
        </div>

        {preview.accounts.map((s, i) => {
          const c = choices[i]
          const sign = c.flip ? -1 : 1
          return (
            <section key={i} style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--ink-700)' }} aria-label={`Statement ${i + 1}`}>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <strong style={{ marginRight: 'auto' }}>
                  {s.label ?? (s.kind === 'card' ? 'Credit card' : 'Account')}
                  {s.last4 ? ` ····${s.last4}` : ''}
                </strong>
                <span className="label-muted">
                  {s.rowCount.toLocaleString()} rows
                  {s.from !== null && s.to !== null ? ` · ${fmtDate(s.from)} – ${fmtDate(s.to)}` : ''}
                  {s.unreadable ? ` · ${s.unreadable.toLocaleString()} unreadable` : ''}
                </span>
                {s.balanceCents !== null && s.balanceDay && (
                  <span className="label-muted">
                    Balance <span className="num">{fmtMoney(sign * s.balanceCents)}</span> · {fmtDay(s.balanceDay)}
                  </span>
                )}
              </div>

              {s.sample.length > 0 && (
                <table className="preview-table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Will import as</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.sample.slice(0, 5).map((r, k) => {
                      const a = sign * r.amountCents
                      return (
                        <tr key={k}>
                          <td>{fmtDate(r.posted)}</td>
                          <td className="truncate" style={{ maxWidth: 380 }}>
                            {r.description}
                          </td>
                          <td className={`num ${a > 0 ? 'pos' : ''}`}>{a > 0 ? `${fmtMoney(a)} in` : `${fmtMoney(-a)} out`}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}

              <div className="mapping-grid" style={{ marginBottom: 10 }}>
                <label className="field">
                  Import into
                  <select className="select" value={c.target} onChange={(e) => set(i, { target: e.target.value })}>
                    {preview.accounts.length > 1 && <option value="skip">Skip</option>}
                    <option value="">New account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {isBankFed(a.source) ? ' · older rows only' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {c.target === '' && (
                  <label className="field">
                    New account name
                    <input className="input" value={c.name} onChange={(e) => set(i, { name: e.target.value })} />
                  </label>
                )}
              </div>
              <label className="check small">
                <input type="checkbox" checked={c.flip} onChange={(e) => set(i, { flip: e.target.checked })} />
                Flip signs
              </label>
            </section>
          )
        })}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void doImport()} disabled={busy || !ready}>
            {busy ? 'Importing…' : `Import ${rows.toLocaleString()} rows`}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The import dialog for whatever was picked: a CSV's column mapping, or a statement file's accounts. */
export function ImportModal({ preview, accounts, onClose }: { preview: ImportPreview; accounts: Account[]; onClose: () => void }): ReactNode {
  return isStatementPreview(preview) ? <StatementImportModal preview={preview} accounts={accounts} onClose={onClose} /> : <CsvImportModal preview={preview} accounts={accounts} onClose={onClose} />
}
