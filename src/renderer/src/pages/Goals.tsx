import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { GOAL_ACCOUNT_TYPES, type Account, type GoalFunding, type GoalStatus, type GoalView } from '../../../shared/types'
import { parseAmount } from '../../../shared/parse'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { EmptyCard } from '../Empty'
import { api, errorMessage, fmtDay, fmtMoneyRound, todayKey } from '../lib'

const money = (cents: number | null): string => (cents === null ? '—' : fmtMoneyRound(cents))
export const STATUS: Record<GoalStatus, string> = { done: 'Done', on_track: 'On track', behind: 'Behind', past_due: 'Past due', open: '' }
export const pctText = (p: number): string => `${Math.floor(p * 100)}%`

/** A goal's progress as a thin bar, full at the target. */
export function GoalBar({ g }: { g: GoalView }): ReactNode {
  return (
    <div className={`goal-bar ${g.status}`} role="img" aria-label={pctText(g.pct)}>
      <div style={{ width: `${Math.min(100, g.pct * 100)}%` }} />
    </div>
  )
}

export function StatusTag({ status }: { status: GoalStatus }): ReactNode {
  return STATUS[status] ? <span className={`tag goal-${status}`}>{STATUS[status]}</span> : null
}

const fundedBy = (g: GoalView): string => (g.funding === 'accounts' ? g.accounts.map((a) => a.name).join(', ') : 'Contributions')

export default function Goals(): ReactNode {
  const { tick, toast } = useApp()
  const [goals, setGoals] = useState<GoalView[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [editing, setEditing] = useState<GoalView | 'new' | null>(null)

  useEffect(() => {
    api.listGoals().then(setGoals, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  if (!goals) return <PageHeader title="Goals" />

  const active = goals.filter((g) => g.archivedAt === null)
  const archived = goals.filter((g) => g.archivedAt !== null)
  const saved = active.reduce((t, g) => t + g.savedCents, 0)
  const target = active.reduce((t, g) => t + g.targetCents, 0)
  const needed = active.reduce((t, g) => t + (g.status === 'done' ? 0 : (g.monthlyNeededCents ?? 0)), 0)
  const behind = active.filter((g) => g.status === 'behind' || g.status === 'past_due').length
  const head = (
    <div className="asset-row goal-row head" role="row">
      <span>Goal</span>
      <span>Progress</span>
      <span className="num">Saved</span>
      <span className="num">Target</span>
      <span>By</span>
      <span className="num">Needed /mo</span>
      <span>Status</span>
    </div>
  )
  const rows = (list: GoalView[]): ReactNode =>
    list.map((g) => (
      <Fragment key={g.id}>
        <button className={`asset-row goal-row ${open === g.id ? 'open' : ''} ${g.archivedAt !== null ? 'archived' : ''}`} aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>
          <span className="truncate" title={fundedBy(g)}>
            {g.name}
            <span className="muted small"> · {fundedBy(g)}</span>
          </span>
          <span className="goal-progress">
            <GoalBar g={g} />
            <span className="mono small">{pctText(g.pct)}</span>
          </span>
          <span className="num">{fmtMoneyRound(g.savedCents)}</span>
          <span className="num">{fmtMoneyRound(g.targetCents)}</span>
          <span className="mono small">{g.targetDay ? fmtDay(g.targetDay) : '—'}</span>
          <span className="num">{g.status === 'done' ? '—' : money(g.monthlyNeededCents)}</span>
          <span>
            <StatusTag status={g.status} />
          </span>
        </button>
        {open === g.id && <GoalDetail g={g} onEdit={() => setEditing(g)} />}
      </Fragment>
    ))

  return (
    <>
      <PageHeader title="Goals">
        {goals.length > 0 && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={15} /> Goal
          </button>
        )}
      </PageHeader>
      <div className="page">
        {goals.length === 0 ? (
          <EmptyCard>
            <button className="btn primary" onClick={() => setEditing('new')}>
              <Icon name="plus" size={15} /> Add goal
            </button>
          </EmptyCard>
        ) : (
          <>
            <div className="stat-strip even">
              <div className="tile">
                <div className="label-muted">Saved</div>
                <div className="tile-value">{fmtMoneyRound(saved)}</div>
                {target > 0 && <div className="tile-sub">{pctText(saved / target)} of {fmtMoneyRound(target)}</div>}
              </div>
              <div className="tile">
                <div className="label-muted">To go</div>
                <div className="tile-value">{fmtMoneyRound(active.reduce((t, g) => t + g.remainingCents, 0))}</div>
              </div>
              <div className="tile">
                <div className="label-muted">Needed a month</div>
                <div className="tile-value">{needed ? fmtMoneyRound(needed) : '—'}</div>
              </div>
              <div className="tile">
                <div className="label-muted">Goals</div>
                <div className="tile-value">{active.length}</div>
                {behind > 0 && <div className="tile-sub tax-owed">{behind} behind</div>}
              </div>
            </div>

            {active.length > 0 && (
              <section className="asset-group">
                <div className="asset-group-head">
                  <h2>Goals</h2>
                </div>
                <div className="asset-table" role="table">
                  {head}
                  {rows(active)}
                </div>
              </section>
            )}

            {archived.length > 0 && (
              <section className="asset-group">
                <div className="asset-group-head">
                  <h2>Archived</h2>
                </div>
                <div className="asset-table" role="table">
                  {head}
                  {rows(archived)}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      {editing && <GoalModal goal={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function GoalDetail({ g, onEdit }: { g: GoalView; onEdit: () => void }): ReactNode {
  const { toast } = useApp()
  const [day, setDay] = useState(todayKey())
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const fail = (e: unknown): void => toast(errorMessage(e), 'error')

  async function add(): Promise<void> {
    const cents = parseAmount(amount)
    if (cents === null || cents === 0) return toast(`Couldn't read "${amount}" as an amount`, 'error')
    try {
      await api.addGoalContribution(g.id, { day, cents, note: note.trim() || null })
      setAmount('')
      setNote('')
    } catch (e) {
      fail(e)
    }
  }

  async function remove(): Promise<void> {
    if (!confirm(`Delete "${g.name}"${g.contributions.length ? ` and its ${g.contributions.length} contributions` : ''}?`)) return
    await api.deleteGoal(g.id).catch(fail)
  }

  return (
    <div className="tax-detail">
      <div className="tax-detail-cols goal-detail-cols">
        <div>
          <div className="label-muted">{g.funding === 'accounts' ? 'Accounts' : 'Contributions'}</div>
          {g.funding === 'accounts' ? (
            <>
              {g.accounts.map((a) => (
                <div className="tax-kv" key={a.id}>
                  <span className="truncate">{a.name}</span>
                  <span className="num">{money(a.balanceCents)}</span>
                </div>
              ))}
              {g.startDay && (
                <div className="tax-kv">
                  <span>Start · {fmtDay(g.startDay)}</span>
                  <span className="num">−{money(g.startCents)}</span>
                </div>
              )}
            </>
          ) : (
            <>
              {g.contributions.map((c) => (
                <div className="tax-kv goal-log" key={c.id} title={c.note ?? undefined}>
                  <span className="mono small">{fmtDay(c.day)}</span>
                  <span className="truncate muted">{c.note ?? ''}</span>
                  <span className={`num ${c.cents < 0 ? 'tax-owed' : ''}`}>{fmtMoneyRound(c.cents)}</span>
                  <button className="btn small ghost icon-btn" aria-label="Delete contribution" onClick={() => api.deleteGoalContribution(c.id).catch(fail)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
              <div className="goal-add">
                <input className="input" type="date" aria-label="Date" value={day} max={todayKey()} onChange={(e) => setDay(e.target.value)} />
                <input className="input num" aria-label="Amount" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
                <input className="input" aria-label="Note" placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
                <button className="btn" disabled={!amount.trim() || !day} onClick={() => void add()}>
                  Add
                </button>
              </div>
            </>
          )}
        </div>
        <div>
          <div className="label-muted">Progress</div>
          <div className="tax-kv">
            <span>Remaining</span>
            <span className="num">{fmtMoneyRound(g.remainingCents)}</span>
          </div>
          {g.monthsLeft !== null && (
            <div className="tax-kv">
              <span>Months left</span>
              <span className="num">{g.monthsLeft}</span>
            </div>
          )}
          {g.monthlyNeededCents !== null && g.status !== 'done' && (
            <div className="tax-kv">
              <span>Needed /mo</span>
              <span className="num">{fmtMoneyRound(g.monthlyNeededCents)}</span>
            </div>
          )}
          <div className="tax-kv">
            <span>Pace /mo</span>
            <span className={`num ${g.paceCents < 0 ? 'tax-owed' : ''}`}>{fmtMoneyRound(g.paceCents)}</span>
          </div>
        </div>
        <div className="goal-actions">
          <button className="btn" onClick={onEdit}>
            Edit
          </button>
          <button className="btn" onClick={() => api.archiveGoal(g.id, g.archivedAt === null).catch(fail)}>
            {g.archivedAt === null ? 'Archive' : 'Unarchive'}
          </button>
          <button className="btn ghost danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

function GoalModal({ goal, onClose }: { goal: GoalView | null; onClose: () => void }): ReactNode {
  const { toast } = useApp()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [f, setF] = useState({
    name: goal?.name ?? '',
    target: goal ? (goal.targetCents / 100).toFixed(2) : '',
    day: goal?.targetDay ?? '',
    funding: (goal?.funding ?? 'accounts') as GoalFunding,
    accountIds: goal?.accountIds ?? [],
    fromNow: goal ? goal.startDay !== null : false
  })
  const today = todayKey()

  useEffect(() => {
    api.listAccounts().then(setAccounts, () => {})
  }, [])
  // Accounts that hold money; one already linked stays listed.
  const choices = accounts.filter((a) => f.accountIds.includes(a.id) || (GOAL_ACCOUNT_TYPES.includes(a.assetType) && !a.hidden && (!a.closedDay || a.closedDay > today)))
  const toggle = (id: string, on: boolean): void => setF({ ...f, accountIds: on ? [...f.accountIds, id] : f.accountIds.filter((x) => x !== id) })

  async function save(): Promise<void> {
    const target = parseAmount(f.target)
    if (target === null || target <= 0) return toast(`Couldn't read "${f.target}" as an amount`, 'error')
    try {
      await api.saveGoal({ ...(goal ? { id: goal.id } : {}), name: f.name, targetCents: target, targetDay: f.day || null, funding: f.funding, accountIds: f.funding === 'accounts' ? f.accountIds : [], fromNow: f.funding === 'accounts' && f.fromNow })
      onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const ready = f.name.trim() && f.target.trim() && (f.funding === 'manual' || f.accountIds.length > 0)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-labelledby="goal-title">
        <h2 id="goal-title">{goal ? goal.name : 'New goal'}</h2>
        <div className="field-grid" style={{ marginTop: 16 }}>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Name
            <input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            Target
            <input className="input num" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
          </label>
          <label className="field">
            By
            <input className="input" type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Funded by
            <select className="select" value={f.funding} onChange={(e) => setF({ ...f, funding: e.target.value as GoalFunding })}>
              <option value="accounts">Accounts</option>
              <option value="manual">Contributions</option>
            </select>
          </label>
        </div>
        {f.funding === 'accounts' && (
          <div className="goal-accounts">
            {choices.map((a) => (
              <label className="check" key={a.id}>
                <input type="checkbox" checked={f.accountIds.includes(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} />
                <span className="truncate grow">{a.name}</span>
                <span className="num muted">{money(a.balanceCents)}</span>
              </label>
            ))}
            <label className="check goal-from">
              <input type="checkbox" checked={f.fromNow} onChange={(e) => setF({ ...f, fromNow: e.target.checked })} />
              {goal?.startDay && f.fromNow ? `From ${fmtDay(goal.startDay)}` : 'From today'}
            </label>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
