import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ASSET_TYPES, isBankFed, isDebtType, type Account, type AssetType, type BalancePoint, type CashRole, type ImportPreview } from '../../../shared/types'
import { classifiedToasts, useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { parseAmount } from '../../../shared/parse'
import { api, errorMessage, fmtAgo, fmtDate, fmtDay, fmtMoney, fmtMoneyRound, SIMPLEFIN_BRIDGE_URL, simplefinOffered } from '../lib'
import { ValueHistory } from './Assets'
import { ImportModal } from './StatementImportModal'

export default function Accounts(): ReactNode {
  const { tick, settings, toast, runSync, syncing, reloadSettings, go, can } = useApp()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [connecting, setConnecting] = useState(false)
  const [token, setToken] = useState('')
  const tokenRef = useRef<HTMLTextAreaElement>(null)
  const [csv, setCsv] = useState<ImportPreview | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [balanceEdit, setBalanceEdit] = useState<{ id: string; text: string } | null>(null)
  const [historyOf, setHistoryOf] = useState<string | null>(null)

  useEffect(() => {
    api.listAccounts().then(setAccounts, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  // Plaid's page opens in the browser; the call returns once it's finished, closed, or Cancel is pressed.
  async function connect(reconnect?: string): Promise<void> {
    setConnecting(true)
    try {
      const r = reconnect ? await api.bankReconnect(reconnect) : await api.bankConnect()
      if (r) {
        toast(`${r.accounts} account${r.accounts === 1 ? '' : 's'} · ${r.added} transactions`)
        for (const [text, kind] of classifiedToasts(r.classified)) toast(text, kind)
        for (const w of r.warnings) toast(w, 'error')
      }
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setConnecting(false)
      void reloadSettings()
    }
  }

  // SimpleFIN (the open edition, or a development build without a server): the setup token is claimed, then a first sync.
  async function connectSimplefin(): Promise<void> {
    setConnecting(true)
    try {
      const r = await api.simplefinConnect(token.trim())
      setToken('')
      toast(`${r.accounts} account${r.accounts === 1 ? '' : 's'} · ${r.added} transactions`)
      for (const [text, kind] of classifiedToasts(r.classified)) toast(text, kind)
      for (const w of r.warnings) toast(`Bank connection: ${w}`, 'error')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setConnecting(false)
      void reloadSettings()
    }
  }

  async function disconnect(itemId: string, name: string): Promise<void> {
    if (!confirm(`Disconnect ${name}? Its transactions are kept.`)) return
    await api.bankDisconnect(itemId).catch((e) => toast(errorMessage(e), 'error'))
    void reloadSettings()
  }

  async function disconnectSimplefin(): Promise<void> {
    if (!confirm('Disconnect SimpleFIN? Its transactions are kept.')) return
    await api.simplefinDisconnect()
    void reloadSettings()
  }

  async function pickCsv(): Promise<void> {
    try {
      const p = await api.csvPick()
      if (p) setCsv(p)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  // Electron has no window.prompt, so renaming happens inline.
  async function saveName(a: Account): Promise<void> {
    const name = editing?.name.trim()
    setEditing(null)
    if (name && name !== a.name) await api.updateAccount(a.id, { name }).catch((e) => toast(errorMessage(e), 'error'))
  }

  async function saveBalance(a: Account): Promise<void> {
    const text = balanceEdit?.text.trim() ?? ''
    setBalanceEdit(null)
    if (!text) return
    const cents = parseAmount(text)
    if (cents === null) return toast(`Couldn't read "${text}" as an amount`, 'error')
    if (cents !== a.balanceCents) await api.updateAccount(a.id, { balanceCents: cents }).catch((e) => toast(errorMessage(e), 'error'))
  }

  async function remove(a: Account): Promise<void> {
    if (!confirm(a.source === 'manual' ? `Delete "${a.name}" and its balance history? This can't be undone.` : `Delete "${a.name}" and its ${a.txnCount} transactions? This can't be undone.`)) return
    await api.deleteAccount(a.id).catch((e) => toast(errorMessage(e), 'error'))
  }

  const banks = settings?.bank?.connections ?? []
  // SimpleFIN's setup token stands where Plaid's Connect bank would.
  const sfin = simplefinOffered(settings)
  // Without Plus (or its trial), one bank.
  const atLimit = banks.length > 0 && !can('multiBank')
  const totals = accounts
    .filter((a) => !a.hidden && a.balanceCents !== null)
    .reduce((t, a) => (a.balanceCents! < 0 || isDebtType(a.assetType) ? { ...t, debts: t.debts + a.balanceCents! } : { ...t, assets: t.assets + a.balanceCents! }), { assets: 0, debts: 0 })

  return (
    <>
      <PageHeader title="Accounts" />
      <div className="page">
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0, marginRight: 'auto' }}>Banks</h2>
            {settings?.lastSyncAt && <span className="label-muted">Synced {fmtAgo(settings.lastSyncAt)}</span>}
            {(banks.length > 0 || settings?.simplefinConnected) && (
              <button className="btn" disabled={syncing || connecting} onClick={() => void runSync()}>
                <Icon name="refresh" size={15} className={syncing ? 'spin' : ''} /> {syncing ? 'Syncing…' : 'Sync now'}
              </button>
            )}
            {!sfin &&
              (connecting ? (
                <button className="btn" onClick={() => void api.bankCancel()}>
                  Cancel
                </button>
              ) : (
                <button className="btn primary" disabled={!settings?.bank?.available || atLimit} title={atLimit ? 'Plus connects more banks' : undefined} onClick={() => void connect()}>
                  {atLimit ? <Icon name="lock" size={14} /> : <Icon name="plus" size={15} />} Connect bank
                </button>
              ))}
          </div>
          {connecting && !sfin && <div className="label-muted bank-wait">Waiting for Plaid in your browser…</div>}
          {sfin && !settings?.simplefinConnected && (
            <div className="row" style={{ alignItems: 'flex-start', marginTop: 12 }}>
              <textarea ref={tokenRef} className="textarea" rows={2} style={{ flex: 1 }} placeholder="Setup token" aria-label="Setup token" value={token} onChange={(e) => setToken(e.target.value)} />
              <button className="btn" onClick={() => void api.openExternal(SIMPLEFIN_BRIDGE_URL)}>
                <Icon name="external" size={15} /> Get token
              </button>
              <button className="btn primary" disabled={!token.trim() || connecting} onClick={() => void connectSimplefin()}>
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          )}
          {banks.map((b) => (
            <div className="list-row" key={b.itemId}>
              <div className="grow truncate">{b.institution ?? 'Bank'}</div>
              {b.status !== 'ok' && <span className="tag low">{b.status === 'login_required' ? 'Sign in again' : b.status === 'paused' ? 'Plus' : 'Expiring'}</span>}
              <span className="label-muted">{b.lastSyncAt ? fmtAgo(b.lastSyncAt) : 'Not synced'}</span>
              {(b.status === 'login_required' || b.status === 'expiring') && (
                <button className="btn small" disabled={connecting} onClick={() => void connect(b.itemId)}>
                  Reconnect
                </button>
              )}
              <button className="btn small ghost danger" disabled={connecting} onClick={() => void disconnect(b.itemId, b.institution ?? 'this bank')}>
                Disconnect
              </button>
            </div>
          ))}
          {settings?.simplefinConnected && (
            <div className="list-row">
              <div className="grow truncate">SimpleFIN</div>
              <span className="label-muted">
                {settings.syncsLast24h}/24 today
                {settings.historyFrom ? ` · from ${fmtDate(settings.historyFrom)}${settings.historyComplete ? '' : ' (loading older)'}` : ''}
              </span>
              {sfin && (
                <button className="btn small" onClick={() => void api.openExternal(SIMPLEFIN_BRIDGE_URL)}>
                  <Icon name="external" size={14} /> Bridge
                </button>
              )}
              <button className="btn small ghost danger" onClick={() => void disconnectSimplefin()}>
                Disconnect
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0, marginRight: 'auto' }}>Import</h2>
            <span className="label-muted">CSV · QFX · OFX · QIF</span>
            <button className="btn" onClick={() => void pickCsv()}>
              <Icon name="upload" size={15} /> Choose file…
            </button>
          </div>
        </div>

        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0, marginRight: 'auto' }}>All accounts</h2>
            <span className="label-muted">
              Assets {fmtMoneyRound(totals.assets)} · Debts {fmtMoneyRound(-totals.debts)}
            </span>
          </div>
          {accounts.length === 0 && (
            <div className="empty compact">
              <div className="empty-actions">
                {sfin ? (
                  <button className="btn primary" disabled={connecting} onClick={() => (settings?.simplefinConnected ? void runSync() : tokenRef.current?.focus())}>
                    <Icon name="bank" size={15} /> Connect bank
                  </button>
                ) : (
                  <button className="btn primary" disabled={connecting || !settings?.bank?.available} onClick={() => void (banks.length ? runSync() : connect())}>
                    <Icon name="bank" size={15} /> Connect bank
                  </button>
                )}
                <button className="btn" onClick={() => void pickCsv()}>
                  <Icon name="upload" size={15} /> Import file
                </button>
              </div>
            </div>
          )}
          {ASSET_TYPES.map((t) => {
            const items = accounts.filter((a) => a.assetType === t.id)
            if (!items.length) return null
            return (
              <Fragment key={t.id}>
                <div className="acct-group-head">
                  <span className="label-muted">{t.label}</span>
                  <span className="num">{fmtMoneyRound(items.filter((a) => !a.hidden).reduce((sum, a) => sum + (a.balanceCents ?? 0), 0))}</span>
                </div>
                {items.map((a) => (
                  <Fragment key={a.id}>
            <div className="list-row acct-row" style={a.hidden ? { opacity: 0.55 } : undefined}>
              <div className="grow">
                {editing?.id === a.id ? (
                  <input
                    className="input"
                    autoFocus
                    value={editing.name}
                    aria-label="Account name"
                    onChange={(e) => setEditing({ id: a.id, name: e.target.value })}
                    onBlur={() => void saveName(a)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveName(a)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <div className="truncate" style={{ fontWeight: 500 }}>
                    {a.name}
                  </div>
                )}
                <AccountFacts account={a} />
              </div>
              {balanceEdit?.id === a.id ? (
                <input
                  className="input balance-input"
                  autoFocus
                  value={balanceEdit.text}
                  placeholder="-1,250.00"
                  aria-label="Current balance (negative for money owed)"
                  title="Negative for money owed (credit cards, loans)"
                  onChange={(e) => setBalanceEdit({ id: a.id, text: e.target.value })}
                  onBlur={() => void saveBalance(a)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveBalance(a)
                    if (e.key === 'Escape') setBalanceEdit(null)
                  }}
                />
              ) : a.source === 'csv' || a.source === 'manual' ? (
                <button className="btn small ghost num acct-balance" title="Set current balance" onClick={() => setBalanceEdit({ id: a.id, text: a.balanceCents !== null ? (a.balanceCents / 100).toFixed(2) : '' })}>
                  {a.balanceCents !== null ? fmtMoney(a.balanceCents) : 'Set balance'}
                </button>
              ) : (
                <div className="num acct-balance" style={{ fontWeight: 600 }}>
                  {a.balanceCents !== null ? fmtMoney(a.balanceCents) : <span className="muted">—</span>}
                </div>
              )}
              <button className={`btn small ghost ${historyOf === a.id ? 'active' : ''}`} aria-expanded={historyOf === a.id} onClick={() => setHistoryOf(historyOf === a.id ? null : a.id)}>
                History
              </button>
              {a.source !== 'manual' && (
                <button className="btn small ghost" onClick={() => go('transactions', { accountId: a.id })}>
                  View
                </button>
              )}
              <button className="btn small ghost" onClick={() => setEditing({ id: a.id, name: a.name })}>
                Rename
              </button>
              <button className="btn small ghost icon-btn" title={a.hidden ? 'Show in totals' : 'Hide from totals'} aria-label={a.hidden ? 'Show account' : 'Hide account'} onClick={() => void api.updateAccount(a.id, { hidden: !a.hidden })}>
                <Icon name={a.hidden ? 'eyeOff' : 'eye'} size={15} />
              </button>
              {!isBankFed(a.source) ? (
                <button className="btn small ghost icon-btn danger" title="Delete account" aria-label="Delete account" onClick={() => void remove(a)}>
                  <Icon name="trash" size={15} />
                </button>
              ) : (
                // Bank-synced accounts come back on the next sync, so they can only be hidden.
                <span style={{ width: 28, flex: 'none' }} />
              )}
            </div>
                    {historyOf === a.id && <AccountHistory account={a} />}
                  </Fragment>
                ))}
              </Fragment>
            )
          })}
        </div>
        {settings?.syncWarnings.length ? (
          <div className="label-muted" style={{ marginTop: 12 }}>
            {settings.syncWarnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        ) : null}

        {csv && <ImportModal preview={csv} accounts={accounts.filter((a) => a.source !== 'manual')} onClose={() => setCsv(null)} />}
      </div>
    </>
  )
}

/** What a cash account is for, as Review set it, the bank's subtype says or its name suggests (Account.cashRole). */
export const CASH_ROLE_LABEL: Record<CashRole, string> = { spending: 'Checking', saving: 'Savings' }

/**
 * An account's facts under its name: a cash account's role first, so a narrow window that cuts the line short still
 * shows it, then where it's from, its transactions and its dates.
 */
export function AccountFacts({ account: a }: { account: Account }): ReactNode {
  return (
    <div className="label-muted truncate" style={{ marginTop: 3 }}>
      {a.cashRole ? `${CASH_ROLE_LABEL[a.cashRole]} · ` : ''}
      {a.institution ?? (a.source === 'csv' ? 'CSV' : a.source === 'manual' ? 'Manual' : 'Bank')}
      {a.source !== 'manual' ? ` · ${a.txnCount.toLocaleString('en-US')} txns` : ''}
      {a.historyFrom ? ` · since ${fmtDay(a.historyFrom)}` : ''}
      {a.closedDay ? ` · closed ${fmtDay(a.closedDay)}` : ''}
    </div>
  )
}

/** Type, open and close dates, and dated balances for one account. */
function AccountHistory({ account: a }: { account: Account }): ReactNode {
  const { tick, toast } = useApp()
  const [points, setPoints] = useState<BalancePoint[]>([])

  useEffect(() => {
    api.listBalancePoints(a.id).then(setPoints, (e) => toast(errorMessage(e), 'error'))
  }, [a.id, tick, toast])

  const save = (patch: Parameters<typeof api.updateAccount>[1]): void => {
    api.updateAccount(a.id, patch).catch((e) => toast(errorMessage(e), 'error'))
  }

  return (
    <div className="acct-history">
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        <label className="field">
          Type
          <select className="select" value={a.assetType} onChange={(e) => save({ assetType: e.target.value as AssetType })}>
            {ASSET_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label.replace(/s$/, '')}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Opened
          <input className="input" type="date" defaultValue={a.openedDay ?? ''} onBlur={(e) => e.target.value !== (a.openedDay ?? '') && save({ openedDay: e.target.value || null })} />
        </label>
        <label className="field">
          Closed
          <input className="input" type="date" defaultValue={a.closedDay ?? ''} onBlur={(e) => e.target.value !== (a.closedDay ?? '') && save({ closedDay: e.target.value || null })} />
        </label>
      </div>
      <ValueHistory account={a} points={points} title="Balances" />
    </div>
  )
}
