import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { PendingAction, ReviewItem, ReviewState } from '../../../shared/types'
import { AI_NOT_ADVICE } from '../../../shared/app'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, errorMessage, onWeb, scrollMotion } from '../lib'
import { ReportButton, ReportDialog } from '../ReportDialog'
import { UploadButton } from '../Empty'

const ISSUE_LABEL: Record<string, string> = {
  new_document: 'New documents',
  question: 'Questions for you',
  uncategorized: 'Uncategorized',
  person_to_person: 'Person-to-person payments',
  possible_duplicate: 'Possible double charges',
  price_change: 'Price changes',
  low_confidence: 'Unsure categories',
  large_purchase: 'Large purchases',
  recurring_unconfirmed: 'Recurring to confirm',
  loan_payment_unlinked: 'Loans with no payment',
  paystub_mismatch: "Paystubs that don't match",
  paystub_missing: 'Paystubs to enter',
  retirement_unset: 'Retirement figures',
  month_gap: "Months that don't tie",
  month_changed: 'Months changed since closing',
  asset_attach: 'Costs to put on an asset',
  share_estimate: 'Use shares to confirm',
  venture_money: 'Venture money to sort',
  share_unset: 'Venture shares',
  venture_paycheck: 'Pay into a venture account',
  venture_value: 'Ventures to value',
  missing_balance: 'Missing balances',
  history_gap: 'History to fill in'
}

/** Minimal, safe rendering of the assistant's text: paragraphs, "- " bullets, **bold**. */
function RichText({ text }: { text: string }): ReactNode {
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>))
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split('\n')
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s/, ''))}</li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </>
  )
}

function Item({ item, disabled, onUndo, onReport }: { item: ReviewItem; disabled: boolean; onUndo: (changeId: number) => void; onReport: (text: string) => void }): ReactNode {
  if (item.role === 'action') {
    return (
      <div className={`chat-action ${item.ok ? '' : 'error'} ${item.undone ? 'undone' : ''}`}>
        <Icon name={item.ok ? 'check' : 'x'} size={12} strokeWidth={2.4} />
        <span>{item.text}</span>
        {item.changeId !== undefined && !item.undone && (
          <button className="link small" disabled={disabled} onClick={() => onUndo(item.changeId!)}>
            Undo
          </button>
        )}
      </div>
    )
  }
  // A message posted through the file bridge: shown like the assistant's, but labelled as the bridge's.
  if (item.role === 'bridge') {
    return (
      <div className="chat-msg assistant">
        <div className="label-muted" style={{ marginBottom: 6 }}>
          File bridge
        </div>
        <RichText text={item.text} />
      </div>
    )
  }
  if (item.role === 'assistant') {
    return (
      <div className="chat-msg-wrap">
        <div className="chat-msg assistant">
          <RichText text={item.text} />
        </div>
        <div className="chat-action chat-report">
          <ReportButton onClick={() => onReport(item.text)} />
        </div>
      </div>
    )
  }
  return (
    <div className={`chat-msg ${item.role}`}>
      <RichText text={item.text} />
    </div>
  )
}

/** A destructive change the assistant asked for; nothing happens until Approve. */
function Pending({ action, disabled, onDecide }: { action: PendingAction; disabled: boolean; onDecide: (approve: boolean) => void }): ReactNode {
  const prefix = `${action.tool} · `
  const args = action.summary.startsWith(prefix) ? action.summary.slice(prefix.length) : action.summary
  return (
    <div className="chat-msg assistant" style={{ display: 'flex', alignItems: 'center', gap: 14, maxWidth: '100%' }}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="mono small">{action.tool}</div>
        {args !== action.tool && (
          <div className="muted small truncate" title={args}>
            {args}
          </div>
        )}
      </div>
      <button className="btn small primary" disabled={disabled} onClick={() => onDecide(true)}>
        Approve
      </button>
      <button className="btn small ghost" disabled={disabled} onClick={() => onDecide(false)}>
        Discard
      </button>
    </div>
  )
}

const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

/** Always beside the title: the user is talking to an AI. */
const AI_TAG = (
  <span className="tag ai" title="AI assistant">
    AI
  </span>
)

export default function Review(): ReactNode {
  const { toast } = useApp()
  const [state, setState] = useState<ReviewState | null>(null)
  const [draft, setDraft] = useState('')
  /** documents-folder names of files pasted or dropped in, going with the next message */
  const [attachments, setAttachments] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  /** the assistant's answer being reported */
  const [reporting, setReporting] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getReview().then(setState, (e) => toast(errorMessage(e), 'error'))
    return api.onReviewUpdate(setState)
  }, [toast])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: scrollMotion(), block: 'end' })
  }, [state?.items.length, state?.pending.length, state?.busy])

  async function send(text: string | null, files: string[] = []): Promise<void> {
    setSending(true)
    try {
      setState(await api.reviewSend(text, files))
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setSending(false)
    }
  }

  /** Saves pasted or dropped files in the documents folder and lines them up for the next message. */
  async function attach(files: FileList): Promise<void> {
    for (const f of Array.from(files)) {
      try {
        const name = await api.reviewAttach(f.name || 'image.png', new Uint8Array(await f.arrayBuffer()))
        setAttachments((a) => (a.includes(name) ? a : [...a, name]))
      } catch (e) {
        toast(errorMessage(e), 'error')
      }
    }
  }

  async function startOver(): Promise<void> {
    if (state?.items.length && !confirm('Start a new review? This conversation is cleared; changes already made stay.')) return
    try {
      await api.reviewReset()
      setState(await api.getReview())
      void send(null)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  function submit(): void {
    const t = draft.trim()
    if ((!t && !attachments.length) || busy) return
    const files = attachments
    setDraft('')
    setAttachments([])
    void send(t, files)
  }

  async function decide(id: number, approve: boolean): Promise<void> {
    try {
      setState(await (approve ? api.approveAction(id) : api.discardAction(id)))
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function undo(changeId: number): Promise<void> {
    try {
      setState(await api.undoChange(changeId))
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function unresolve(key: string): Promise<void> {
    try {
      setState(await api.unresolveIssue(key))
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  if (!state) return <PageHeader title="Review" tag={AI_TAG} />
  const busy = state.busy || sending
  const open = Object.entries(state.openIssues).filter(([, n]) => n > 0)
  const openTotal = open.reduce((t, [, n]) => t + n, 0)
  const composer = state.items.length > 0
  const drop = (e: DragEvent): void => {
    if (!hasFiles(e) || !composer) return
    e.preventDefault()
    void attach(e.dataTransfer.files)
  }

  return (
    <>
      <PageHeader title="Review" tag={AI_TAG}>
        {state.items.length > 0 && (
          <button className="btn" disabled={busy} onClick={() => void startOver()}>
            <Icon name="refresh" size={14} /> New review
          </button>
        )}
      </PageHeader>
      <div className="review-layout">
        <div className="chat" onDragOver={(e) => hasFiles(e) && composer && e.preventDefault()} onDrop={drop}>
          <div className="chat-scroll">
            {state.items.length === 0 && state.pending.length === 0 && !busy ? (
              <div className="chat-empty">
                <div className="tile-value">{openTotal}</div>
                <div className="label-muted" style={{ margin: '6px 0 22px' }}>
                  open item{openTotal === 1 ? '' : 's'}
                </div>
                <button className="btn primary" onClick={() => void send(null)}>
                  <Icon name="chat" size={15} /> Start review
                </button>
              </div>
            ) : (
              <div className="chat-thread">
                {state.items.map((i) => (
                  <Item key={i.id} item={i} disabled={busy} onUndo={(id) => void undo(id)} onReport={setReporting} />
                ))}
                {state.pending.map((p) => (
                  <Pending key={p.id} action={p} disabled={busy} onDecide={(approve) => void decide(p.id, approve)} />
                ))}
                {busy && (
                  <div className="chat-msg assistant typing" aria-label="The AI is working">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>
          {composer && (
            <div className="chat-composer">
              <div className="chat-composer-body">
                {attachments.length > 0 && (
                  <div className="chat-attachments">
                    {attachments.map((name) => (
                      <span className="vendor-chip" key={name}>
                        {name.split('/').pop()}
                        <button className="btn ghost icon-btn small" aria-label={`Remove ${name}`} onClick={() => setAttachments((a) => a.filter((x) => x !== name))}>
                          <Icon name="x" size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  className="textarea"
                  rows={2}
                  value={draft}
                  placeholder="Reply or ask anything about your money"
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    if (!e.clipboardData.files.length) return
                    e.preventDefault()
                    void attach(e.clipboardData.files)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submit()
                    }
                  }}
                />
                <div className="muted small">{AI_NOT_ADVICE}</div>
              </div>
              <button className="btn primary icon-btn" aria-label="Send" disabled={busy || (!draft.trim() && !attachments.length)} onClick={submit}>
                <Icon name="send" size={16} />
              </button>
            </div>
          )}
        </div>

        <aside className="review-side">
          <div className="label-muted">Open items</div>
          {open.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>None</div>}
          {open.map(([kind, n]) => (
            <div className="list-row small" key={kind}>
              <div className="grow">{ISSUE_LABEL[kind] ?? kind}</div>
              <div className="mono">{n}</div>
            </div>
          ))}

          {state.resolved.length > 0 && (
            <>
              <div className="label-muted" style={{ marginTop: 28 }}>
                Resolved
              </div>
              {state.resolved.map((r) => (
                <div className="list-row small fact" key={r.key} title={r.note ?? undefined}>
                  <div className="grow clamp-2">{r.summary ?? r.key}</div>
                  <button className="btn small ghost icon-btn" aria-label="Bring back" title="Bring back" disabled={busy} onClick={() => void unresolve(r.key)}>
                    <Icon name="refresh" size={12} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="label-muted" style={{ marginTop: 28 }}>
            Documents
          </div>
          <div className="list-row small">
            <div className="grow">
              {state.documents.total ? `${state.documents.total} file${state.documents.total === 1 ? '' : 's'}${state.documents.unread ? ` · ${state.documents.unread} new` : ''}` : 'None'}
            </div>
            {onWeb() ? (
              <UploadButton className="btn small ghost">Upload</UploadButton>
            ) : (
              <button className="btn small ghost" onClick={() => void api.openDocumentsFolder()}>
                <Icon name="folder" size={13} /> Open folder
              </button>
            )}
          </div>

          <div className="label-muted" style={{ marginTop: 28 }}>
            Remembered
          </div>
          {state.facts.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>Nothing yet</div>}
          {state.facts.map((f) => (
            <div className="list-row small fact" key={f.id}>
              <div className="grow">{f.text}</div>
              <button className="btn small ghost icon-btn" aria-label="Forget" title="Forget" onClick={() => void api.deleteFact(f.id).then(() => api.getReview().then(setState))}>
                <Icon name="x" size={12} strokeWidth={2.2} />
              </button>
            </div>
          ))}
        </aside>
      </div>
      {reporting !== null && <ReportDialog route="review" message={reporting} onClose={() => setReporting(null)} />}
    </>
  )
}
