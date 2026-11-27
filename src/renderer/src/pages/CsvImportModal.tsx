import { useState, type ReactNode } from 'react'
import { isBankFed, type Account, type CsvMapping, type CsvPreview } from '../../../shared/types'
import { parseDate, rowAmount } from '../../../shared/parse'
import { classifiedToasts, useApp } from '../App'
import { api, errorMessage, fmtDate, fmtMoney } from '../lib'

function ColumnSelect({ label, headers, value, onChange, optional }: { label: string; headers: string[]; value: number | null; onChange: (v: number | null) => void; optional?: boolean }): ReactNode {
  return (
    <label className="field">
      {label}
      <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        {optional && <option value="">— none —</option>}
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h}
          </option>
        ))}
      </select>
    </label>
  )
}

export default function CsvImportModal({ preview, accounts, onClose }: { preview: CsvPreview; accounts: Account[]; onClose: () => void }): ReactNode {
  const { toast } = useApp()
  const [m, setM] = useState<CsvMapping>(preview.guess)
  const [split, setSplit] = useState(preview.guess.amount === null)
  const [accountId, setAccountId] = useState('')
  const [newName, setNewName] = useState(preview.fileName.replace(/\.(csv|txt)$/i, ''))
  const [busy, setBusy] = useState(false)

  const mapping: CsvMapping = split ? { ...m, amount: null } : { ...m, debit: null, credit: null }
  const set = (patch: Partial<CsvMapping>): void => setM((x) => ({ ...x, ...patch }))

  async function doImport(): Promise<void> {
    setBusy(true)
    try {
      const r = await api.csvImport({ token: preview.token, mapping, accountId: accountId || undefined, newAccountName: accountId ? undefined : newName })
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
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="csv-title">
        <h2 id="csv-title">Import {preview.fileName}</h2>
        <div className="label-muted">
          {preview.rowCount.toLocaleString()} rows{preview.unreadable ? ` · ${preview.unreadable.toLocaleString()} unreadable` : ''}
        </div>

        <div className="mapping-grid">
          <ColumnSelect label="Date column" headers={preview.headers} value={m.date} onChange={(v) => set({ date: v ?? 0 })} />
          <ColumnSelect label="Description column" headers={preview.headers} value={m.description} onChange={(v) => set({ description: v ?? 0 })} />
          {split ? (
            <>
              <ColumnSelect label="Money out (debit)" headers={preview.headers} value={m.debit} onChange={(v) => set({ debit: v })} optional />
              <ColumnSelect label="Money in (credit)" headers={preview.headers} value={m.credit} onChange={(v) => set({ credit: v })} optional />
            </>
          ) : (
            <ColumnSelect label="Amount column" headers={preview.headers} value={m.amount ?? 0} onChange={(v) => set({ amount: v })} />
          )}
          <ColumnSelect label="Balance column" headers={preview.headers} value={m.balance ?? null} onChange={(v) => set({ balance: v })} optional />
        </div>
        <div className="row" style={{ gap: 20, marginBottom: 14 }}>
          <label className="check small">
            <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            Separate debit / credit columns
          </label>
          <label className="check small">
            <input type="checkbox" checked={m.invertSign} onChange={(e) => set({ invertSign: e.target.checked })} />
            Purchases show as positive numbers (typical for credit cards)
          </label>
        </div>

        <table className="preview-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th style={{ textAlign: 'right' }}>Will import as</th>
            </tr>
          </thead>
          <tbody>
            {preview.sample.slice(0, 6).map((r, i) => {
              const d = parseDate(r[mapping.date])
              const a = rowAmount(r, mapping)
              return (
                <tr key={i}>
                  <td>{d ? fmtDate(d) : <span style={{ color: 'var(--bad-text)' }}>can’t read “{r[mapping.date]}”</span>}</td>
                  <td className="truncate" style={{ maxWidth: 380 }}>
                    {r[mapping.description]}
                  </td>
                  <td className={`num ${a !== null && a > 0 ? 'pos' : ''}`}>
                    {a === null ? <span style={{ color: 'var(--bad-text)' }}>no amount</span> : a > 0 ? `${fmtMoney(a)} in` : `${fmtMoney(-a)} out`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <div className="mapping-grid">
          <label className="field">
            Import into
            <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">New account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {isBankFed(a.source) ? ' · older rows only' : ''}
                </option>
              ))}
            </select>
          </label>
          {!accountId && (
            <label className="field">
              New account name
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </label>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void doImport()} disabled={busy || (!accountId && !newName.trim())}>
            {busy ? 'Importing…' : `Import ${preview.rowCount.toLocaleString()} rows`}
          </button>
        </div>
      </div>
    </div>
  )
}
