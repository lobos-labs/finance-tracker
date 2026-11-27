import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AI_EFFORTS, AI_ROUTE_LABELS, AI_ROUTES, MODEL_OPTIONS, type AiConsent, type AiEffort, type AiProvider, type AiRequestDetail, type AiRequestSummary, type AiStatus, type AiUsageTotals, type Allowance, type AppInfo, type Category, type CategoryKind, type ClaudeCodeStatus, type ModelId, type MoveAccountStatus, type Rule, type RuleField, SPEND_RISKS, type SpendRisk, type SyncDeviceView, type SyncPairing, type SyncStatusView, type UpdateCheck, THEMES, type ThemeChoice } from '../../../shared/types'
import { PLAN_LABELS } from '../../../shared/plans'
import { budgetPercent } from '../../../shared/aiCost'
import { AI_CONSENT_LINE, LEGAL_LINKS, NOT_ADVICE } from '../../../shared/app'
import { keyCheckLine, keyDot } from '../../../shared/checks'
import { DESKTOP_SENT, requestLabel, WHATS_SENT } from '../../../shared/whatsSent'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { StartTrialButton, takePlanFocus } from '../Tier'
import { api, errorMessage, fmtAgo, fmtDay, onWeb, planCardShown } from '../lib'
import { CategorySelect } from './Transactions'
import { DataFolders } from '../Empty'
import { Notifications } from './NotificationSettings'
import { Connector } from './Connector'
import { CheckCodeModal, RecoveryCodeModal, RestoreCodeModal } from '../RecoveryCode'
import { AccountCard } from '../web/AccountCard'
import { AlertSettings } from '../web/AlertSettings'
import { PartnerCard } from '../web/PartnerCard'
import { ConnectedApps } from '../web/ConnectedApps'
import { HostedPlan } from '../web/HostedPlan'
import { CalendarCard } from '../web/CalendarCard'

const KEYS_URL = 'https://platform.claude.com/settings/keys'
const INSTALL_URL = 'https://claude.com/claude-code'

const FIELD_LABEL: Record<RuleField, string> = {
  merchant: 'Merchant is',
  key: 'Description matches',
  contains: 'Description contains'
}

export default function Settings(): ReactNode {
  // The web app has the account instead of the desktop's tray, window theme and paired devices.
  const web = onWeb()
  return (
    <>
      <PageHeader title="Settings" />
      <div className="page">
        <PlanSettings />
        {web && <AccountCard />}
        {web && <PartnerCard />}
        {web && <ConnectedApps />}
        <AiSettings />
        {!web && <Connector />}
        <Privacy />
        <SpendSettings />
        {web ? <AlertSettings /> : <Notifications />}
        {web && <CalendarCard />}
        {!web && <Display />}
        {!web && <Devices />}
        <Categories />
        <Rules />
        <DataSettings />
      </div>
    </>
  )
}

const EFFORT_LABEL: Record<AiEffort, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** The plan in force, the license key and this computer's id (the web: Plus through Stripe, HostedPlan) and the included AI's allowance; nothing in the open edition. */
function PlanSettings(): ReactNode {
  const { settings, reloadSettings, toast, tick } = useApp()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'activate' | 'deactivate' | null>(null)
  const [allowance, setAllowance] = useState<Allowance | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const plan = settings?.plan

  const shown = planCardShown(settings)
  useEffect(() => {
    if (!shown) return
    let alive = true
    void api.getAllowance().then((a) => alive && setAllowance(a), () => {})
    return () => {
      alive = false
    }
  }, [tick, plan?.plan, shown])

  // Opened from a lock card: the key field is where the eye lands.
  useEffect(() => {
    if (!takePlanFocus()) return
    card.current?.scrollIntoView({ block: 'start' })
    input.current?.focus()
  }, [])

  // The open edition: everything included by the build, so no plan to show (planCardShown).
  if (!plan || !shown) return null

  async function run(what: NonNullable<typeof busy>, fn: () => Promise<unknown>): Promise<void> {
    setBusy(what)
    try {
      await fn()
      await reloadSettings()
    } catch (e) {
      toast(errorMessage(e), 'error')
      await reloadSettings()
    } finally {
      setBusy(null)
    }
  }
  const activate = (): Promise<void> =>
    run('activate', async () => {
      const p = await api.activateLicense(key.trim())
      setKey('')
      toast(`${PLAN_LABELS[p.plan]} · activated`)
    })
  const deactivate = (): Promise<void> =>
    run('deactivate', async () => {
      await api.deactivateLicense()
      toast('License removed from this computer')
    })

  const day = (iso: string | null): string => (iso ? fmtDay(iso.slice(0, 10)) : '')
  const state =
    plan.plan === 'trial'
      ? `${plan.trialDaysLeft} day${plan.trialDaysLeft === 1 ? '' : 's'} left`
      : plan.plan === 'plus'
        ? plan.dev
          ? 'Development build'
          : plan.beta
            ? `Through ${day(plan.betaUntil)}`
            : plan.paidThrough
              ? `Paid through ${day(plan.paidThrough)}`
              : ''
        : ''
  const window = allowance?.window ? (allowance.plan === 'trial' ? `${day(allowance.window.from)} – ${day(allowance.window.to)}` : new Date(allowance.window.from).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })) : ''

  return (
    <div className="card" ref={card}>
      <h2>Plan</h2>
      {/* The hosted build: Plus through Stripe's checkout and portal, no license key and no machine. */}
      {onWeb() && <HostedPlan plan={plan} />}
      {!onWeb() && (
      <div className="row" style={{ gap: 14 }}>
        <span className="tier-name">{plan.beta ? 'Beta' : PLAN_LABELS[plan.plan]}</span>
        {state && <span className="muted small">{state}</span>}
        {plan.plan === 'free' && !plan.trialStarted && <StartTrialButton className="btn small primary" />}
      </div>
      )}
      {/* The beta is Plus by the build: no key to enter. */}
      {!plan.beta && !onWeb() && (
      <div className="tier-rows">
        <span className="label-muted">License key</span>
        {plan.licensed && plan.plan === 'plus' ? (
          <div className="row">
            <code>Active on this computer</code>
            <button className="btn small ghost danger" disabled={busy !== null} onClick={() => void deactivate()}>
              {busy === 'deactivate' ? 'Removing…' : 'Deactivate'}
            </button>
          </div>
        ) : (
          <div className="row">
            <input ref={input} className="input" type="password" placeholder="License key" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void activate()} autoComplete="off" aria-label="License key" style={{ flex: 1 }} />
            <button className="btn primary small" disabled={!key.trim() || busy !== null} onClick={() => void activate()}>
              {busy === 'activate' ? 'Activating…' : 'Activate'}
            </button>
          </div>
        )}
        <span className="label-muted">Machine ID</span>
        <code title={plan.machineId}>{plan.machineId}</code>
      </div>
      )}
      {allowance?.window && allowance.budget !== null && !plan.beta && (
        <table className="cat-table" style={{ marginTop: 16 }}>
          <tbody>
            <tr>
              <td className="label-muted">AI allowance · {window}</td>
              <td className="num mono small">{budgetPercent(allowance.used, allowance.budget)}% used</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

const PROVIDER_LABEL: Record<AiProvider, string> = { 'claude-code': 'Claude subscription', api: 'API key', proxy: 'Hosted' }

function AiSettings(): ReactNode {
  const { settings, reloadSettings, runClassify, classifying, toast } = useApp()
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [usage, setUsage] = useState<AiUsageTotals[]>([])

  const provider = settings?.provider
  const keySource = settings?.apiKeySource
  const tokenSaved = settings?.licenseTokenSaved
  const on = settings?.aiEnabled
  useEffect(() => {
    if (!settings) return
    let alive = true
    setStatus(null)
    // Claude Code mode has its own sign-in check below; asking again would start the CLI twice. Off, nothing to check.
    if (settings.aiEnabled && settings.provider !== 'claude-code') void api.aiStatus().then((s) => alive && setStatus(s), () => {})
    void api.getAiUsage().then((u) => alive && setUsage(u), () => {})
    return () => {
      alive = false
    }
    // Checked again when the switch, the provider or its credentials change.
  }, [on, provider, keySource, tokenSaved])
  if (!settings) return null

  const save = (patch: Parameters<typeof api.setSettings>[0]): void => void api.setSettings(patch).then(reloadSettings, (e) => toast(errorMessage(e), 'error'))
  // The web runs on the service's AI only: no Claude Code, and no key of the user's own (the desktop keeps both).
  const providers = (['claude-code', 'api', 'proxy'] as const).filter((p) => (p === 'claude-code' ? settings.claudeCodeOffered && !onWeb() : p === 'proxy' ? settings.proxyAvailable : !onWeb()))
  // A model and effort per route with a key of the user's own; the included AI runs each route on a set one.
  const perRoute = settings.provider === 'api' && !onWeb()
  const withModel = settings.aiEnabled && settings.provider === 'claude-code'

  return (
    <div className="card">
      <h2>AI</h2>
      {onWeb() ? (
        settings.plan.plan !== 'free' && <AiConsentRow consent={settings.aiConsent} save={save} />
      ) : (
        <label className="check" style={{ marginBottom: 14 }}>
          <input type="checkbox" checked={settings.aiEnabled} onChange={(e) => save({ aiEnabled: e.target.checked })} />
          AI
        </label>
      )}
      {settings.aiEnabled && (
        <>
          {providers.length > 1 && (
            <div className="segmented" role="group" aria-label="Connect with" style={{ marginBottom: 14 }}>
              {providers.map((id) => (
                <button key={id} className={settings.provider === id ? 'active' : ''} onClick={() => save({ provider: id })}>
                  {PROVIDER_LABEL[id]}
                </button>
              ))}
            </div>
          )}
          {settings.provider === 'claude-code' ? <ClaudeCodeSignIn /> : settings.provider === 'proxy' || onWeb() ? <LicenseToken status={status} /> : <ApiKey status={status} />}
        </>
      )}

      <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
        {withModel && (
          <label className="field">
            Model
            <select className="select" value={settings.model} onChange={(e) => save({ model: e.target.value })}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="check" style={{ marginTop: withModel ? 18 : 0 }}>
          <input type="checkbox" checked={settings.autoClassify} onChange={(e) => save({ autoClassify: e.target.checked })} />
          Auto-categorize after sync or import
        </label>
        {settings.aiEnabled && (
          <label className="check" style={{ marginTop: withModel ? 18 : 0 }}>
            <input type="checkbox" checked={settings.lookupValues} onChange={(e) => save({ lookupValues: e.target.checked })} />
            Look up house and vehicle values monthly
          </label>
        )}
      </div>
      {settings.aiEnabled && (
        <>
          <RouteTable perRoute={perRoute} usage={usage} save={save} />
          <div style={{ marginTop: 16 }}>
            <button
              className="btn small"
              disabled={!!classifying}
              onClick={() => {
                if (confirm('Ask the AI again for every transaction it categorized before? Your own choices and rules are kept.')) void runClassify(true)
              }}
            >
              <Icon name="sparkle" size={14} /> Re-run AI categorization
            </button>
          </div>
        </>
      )}
      <WhatsSent />
      <RequestLog />
    </div>
  )
}

/** Hosted: the service's AI waits for the consent line (Apple's 5.1.2(i)); Turn off takes it back. */
function AiConsentRow({ consent, save }: { consent: AiConsent | null; save: (patch: Parameters<typeof api.setSettings>[0]) => void }): ReactNode {
  if (consent?.allowed)
    return (
      <div className="row small" style={{ gap: 12, marginBottom: 14 }}>
        <span className="status-dot on" aria-hidden />
        Allowed · {fmtDay(consent.at.slice(0, 10))}
        <button className="btn small ghost" onClick={() => save({ aiConsent: false })}>
          Turn off
        </button>
      </div>
    )
  return (
    <div style={{ marginBottom: 14 }}>
      <p className="small" style={{ marginTop: 0 }}>
        {AI_CONSENT_LINE}{' '}
        <a href={LEGAL_LINKS.privacy} target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
      </p>
      <button className="btn small primary" onClick={() => save({ aiConsent: true })}>
        Allow
      </button>
    </div>
  )
}

/** Each feature's fields, from the one table the README and the privacy policy repeat (src/shared/whatsSent.ts); the desktop adds its key check. */
function WhatsSent(): ReactNode {
  const { settings } = useApp()
  const cli = settings?.provider === 'claude-code'
  return (
    <>
      <div className="label-muted" style={{ marginTop: 26 }}>
        What's sent
      </div>
      {settings && !settings.aiEnabled && (
        <div className="row small sent-off" role="status">
          <span className="status-dot" aria-hidden />
          AI off
        </div>
      )}
      <table className="cat-table sent-table">
        <tbody>
          {(onWeb() ? WHATS_SENT : [...WHATS_SENT, ...DESKTOP_SENT]).map((f) => (
            <tr key={f.route}>
              <td className="sent-feature">{f.label}</td>
              <td>
                <ul className="sent-fields">
                  {f.fields.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                  {cli && f.claudeCode?.map((x) => <li key={x}>{`Claude Code mode: ${x}`}</li>)}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const fmtAt = (unix: number): string => new Date(unix * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
const modelLabel = (id: string): string => MODEL_OPTIONS.find((m) => m.id === id)?.label.split(' — ')[0] ?? id
const STATUS_LABEL: Record<AiRequestSummary['status'], string> = { ok: 'OK', error: 'Error', sent: 'Sent' }

/** Every request sent to the AI, kept with the books: a row opens the request as it was sent. */
function RequestLog(): ReactNode {
  const { settings, reloadSettings, toast, tick, classifying } = useApp()
  const [rows, setRows] = useState<AiRequestSummary[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const load = useCallback(() => void api.listAiRequests().then(setRows, () => setRows([])), [])
  // Fresh after a change, a categorization run, or a key check (it reloads the settings).
  useEffect(load, [load, tick, classifying, settings])
  if (!settings) return null

  const setOn = (on: boolean): void => void api.setSettings({ requestLog: on }).then(reloadSettings, (e) => toast(errorMessage(e), 'error'))
  const clear = (): void => {
    if (!confirm('Clear the request log?')) return
    void api.clearAiRequests().then(load, (e) => toast(errorMessage(e), 'error'))
  }

  return (
    <>
      <div className="row" style={{ marginTop: 26, gap: 18 }}>
        <div className="label-muted">Request log</div>
        <label className="check">
          <input type="checkbox" checked={settings.requestLog} onChange={(e) => setOn(e.target.checked)} />
          On
        </label>
        <span className="muted small mono">{rows ? `${rows.length} / 500 · 30 days` : ''}</span>
        <button className="btn small ghost" style={{ marginLeft: 'auto' }} disabled={!rows?.length} onClick={clear}>
          <Icon name="trash" size={13} /> Clear
        </button>
      </div>
      {rows && rows.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>None</div>}
      {rows && rows.length > 0 && (
        <div className="log-scroll">
          <table className="cat-table log-table">
            <thead>
              <tr className="label-muted">
                <td>Time</td>
                <td>Feature</td>
                <td>Model</td>
                <td className="num">Size</td>
                <td>Status</td>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="log-row"
                  tabIndex={0}
                  aria-label={`${requestLabel(r.route)} request, ${fmtAt(r.at)}`}
                  onClick={() => setOpen(r.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(r.id))}
                >
                  <td className="mono small">{fmtAt(r.at)}</td>
                  <td>{requestLabel(r.route)}</td>
                  <td className="small">{modelLabel(r.model)}</td>
                  <td className="num mono small">{fmtBytes(r.bytes)}</td>
                  <td className={`small ${r.status === 'error' ? 'neg' : ''}`}>{STATUS_LABEL[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open !== null && <RequestModal id={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** One logged request: what came back, and the body as it was sent, pretty-printed. */
function RequestModal({ id, onClose }: { id: number; onClose: () => void }): ReactNode {
  const { toast } = useApp()
  const [r, setR] = useState<AiRequestDetail | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void api.getAiRequest(id).then((x) => alive && setR(x), (e) => alive && (setR(null), toast(errorMessage(e), 'error')))
    return () => {
      alive = false
    }
  }, [id, toast])
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  const copy = (): void => void api.copyAiRequest(id).then(() => toast('Request copied'), (e) => toast(errorMessage(e), 'error'))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="request-title">
        <h2 id="request-title">{r ? `${requestLabel(r.route)} · ${fmtAt(r.at)}` : 'Request'}</h2>
        {r === null && <div className="muted small">No longer in the log</div>}
        {r && (
          <>
            <div className="request-facts">
              <span className="label-muted">Model</span>
              <span className="mono small">{r.model}</span>
              <span className="label-muted">Via</span>
              <span className="small">{PROVIDER_LABEL[r.provider] ?? r.provider}</span>
              <span className="label-muted">Size</span>
              <span className="mono small">{fmtBytes(r.bytes)}</span>
              <span className="label-muted">Status</span>
              <span className={`small ${r.status === 'error' ? 'neg' : ''}`}>{r.error ? `${STATUS_LABEL[r.status]} · ${r.error}` : STATUS_LABEL[r.status]}</span>
              {r.usage && (
                <>
                  <span className="label-muted">Tokens</span>
                  <span className="mono small">
                    {tokens(r.usage.inputTokens)} in · {tokens(r.usage.outputTokens)} out{r.usage.cacheReadTokens ? ` · ${tokens(r.usage.cacheReadTokens)} cache read` : ''}
                    {r.usage.cacheWriteTokens ? ` · ${tokens(r.usage.cacheWriteTokens)} cache write` : ''}
                    {r.usage.thinkingDropped ? ` · ${r.usage.thinkingDropped} thinking left out` : ''}
                    {r.usage.thinkingUnread ? ` · ${r.usage.thinkingUnread} thinking unread` : ''}
                    {r.usage.thinkingRemoved ? ` · ${r.usage.thinkingRemoved} thinking removed` : ''}
                    {r.usage.model && r.usage.model !== r.model ? ` · ${r.usage.model}` : ''}
                  </span>
                </>
              )}
            </div>
            <pre className="json-view" aria-label="Request as sent">
              {JSON.stringify(r.request, null, 2)}
            </pre>
          </>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!r} onClick={copy}>
            <Icon name="list" size={14} /> Copy
          </button>
        </div>
      </div>
    </div>
  )
}

const tokens = (n: number): string => n.toLocaleString('en-US')

/** Each route's model and effort (with the user's own key) and this month's usage. */
function RouteTable({ perRoute, usage, save }: { perRoute: boolean; usage: AiUsageTotals[]; save: (patch: Parameters<typeof api.setSettings>[0]) => void }): ReactNode {
  const { settings } = useApp()
  if (!settings) return null
  const sum = (route: string, key: 'calls' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'): number => usage.filter((u) => u.route === route).reduce((s, u) => s + u[key], 0)
  const month = new Date().toLocaleDateString('en-US', { month: 'long' })
  return (
    <table className="cat-table" style={{ marginTop: 16 }}>
      <thead>
        <tr className="label-muted">
          <td />
          {perRoute && <td>Model</td>}
          {perRoute && <td>Effort</td>}
          <td className="num">{month} calls</td>
          <td className="num">In</td>
          <td className="num">Out</td>
          <td className="num">Cache read</td>
          <td className="num">Cache write</td>
        </tr>
      </thead>
      <tbody>
        {AI_ROUTES.map((route) => (
          <tr key={route}>
            <td>{AI_ROUTE_LABELS[route]}</td>
            {perRoute && (
              <td>
                <select className="select" aria-label={`${AI_ROUTE_LABELS[route]} model`} value={settings.routes[route].model} onChange={(e) => save({ routes: { [route]: { model: e.target.value as ModelId } } })}>
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label.split(' — ')[0]}
                    </option>
                  ))}
                </select>
              </td>
            )}
            {perRoute && (
              <td>
                <select className="select" aria-label={`${AI_ROUTE_LABELS[route]} effort`} value={settings.routes[route].effort} onChange={(e) => save({ routes: { [route]: { effort: e.target.value as AiEffort } } })}>
                  {AI_EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {EFFORT_LABEL[e]}
                    </option>
                  ))}
                </select>
              </td>
            )}
            <td className="num mono small">{tokens(sum(route, 'calls'))}</td>
            <td className="num mono small">{tokens(sum(route, 'inputTokens'))}</td>
            <td className="num mono small">{tokens(sum(route, 'outputTokens'))}</td>
            <td className="num mono small">{tokens(sum(route, 'cacheReadTokens'))}</td>
            <td className="num mono small">{tokens(sum(route, 'cacheWriteTokens'))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Spendable's risk (spend.risk), the one its card's risks set too: Most likely until one is chosen. */
function SpendSettings(): ReactNode {
  const { settings, reloadSettings, toast } = useApp()
  if (!settings) return null
  const pick = (risk: SpendRisk): void => void api.setSpendSettings({ risk }).then(reloadSettings, (e) => toast(errorMessage(e), 'error'))
  return (
    <div className="card">
      <h2>Spendable</h2>
      <div className="segmented" role="radiogroup" aria-label="Spendable">
        {SPEND_RISKS.map((r) => (
          <button key={r.id} role="radio" aria-checked={settings.spendRisk === r.id} className={settings.spendRisk === r.id ? 'active' : ''} onClick={() => settings.spendRisk !== r.id && pick(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Privacy(): ReactNode {
  const { settings, reloadSettings, toast } = useApp()
  const [vendor, setVendor] = useState('')
  if (!settings) return null

  const save = (patch: Parameters<typeof api.setSettings>[0]): void => void api.setSettings(patch).then(reloadSettings, (e) => toast(errorMessage(e), 'error'))
  const add = (): void => {
    if (!vendor.trim()) return
    save({ hiddenVendors: [...settings.hiddenVendors, vendor.trim()] })
    setVendor('')
  }

  return (
    <div className="card">
      <h2>Privacy</h2>
      <label className="check">
        <input type="checkbox" checked={settings.hideNumbersOnOpen} onChange={(e) => save({ hideNumbersOnOpen: e.target.checked })} />
        Hide numbers when the app opens
      </label>
      <div className="field" style={{ marginTop: 18 }}>
        Hidden vendors
        <div className="vendor-list">
          {settings.hiddenVendors.map((v) => (
            <span className="vendor-chip" key={v}>
              {v}
              <button className="btn ghost icon-btn small" aria-label={`Show ${v} again`} onClick={() => save({ hiddenVendors: settings.hiddenVendors.filter((x) => x !== v) })}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <input className="input" placeholder="Vendor name" aria-label="Vendor to hide" value={vendor} onChange={(e) => setVendor(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="btn small" disabled={!vendor.trim()} onClick={add}>
            <Icon name="plus" size={13} /> Hide
          </button>
        </div>
      </div>
    </div>
  )
}

const THEME_LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' }

/** The window's theme: the system's, or always light or dark. */
function Display(): ReactNode {
  const { settings, reloadSettings, toast } = useApp()
  if (!settings) return null
  const pick = (theme: ThemeChoice): void => void api.setTheme(theme).then(reloadSettings, (e) => toast(errorMessage(e), 'error'))

  return (
    <div className="card">
      <h2>Display</h2>
      <div className="field">
        Theme
        <div className="segmented" role="group" aria-label="Theme" style={{ alignSelf: 'flex-start' }}>
          {THEMES.map((t) => (
            <button key={t} className={settings.theme === t ? 'active' : ''} aria-pressed={settings.theme === t} onClick={() => pick(t)}>
              {THEME_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const ROLE_LABEL: Record<string, string> = { phone: 'Phone', viewer: 'Web viewer' }
const STATE_LABEL: Record<SyncDeviceView['state'], string> = { approved: 'Approved', waiting: 'Waiting', nocode: 'No code', twice: 'Code used twice', changed: 'Key changed' }
const fmtCode = (code: string | null): string => (code ? `${code.slice(0, 3)} ${code.slice(3)}` : '—')

const fmtWhen = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const fmtSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
const svgSrc = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/**
 * The phone and the web viewer, on every plan, once there is a relay or a viewer to pair with, or a
 * pairing: a build without either (the beta) has no Devices section.
 */
function Devices(): ReactNode {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let alive = true
    void api.getSyncStatus().then(
      (s) => alive && setAvailable(s.paired || !!s.relayUrl || !!s.viewerUrl),
      () => {}
    )
    return () => {
      alive = false
    }
  }, [])
  if (!available) return null
  return <DevicesCard />
}

function DevicesCard(): ReactNode {
  const { toast, tick } = useApp()
  const [status, setStatus] = useState<SyncStatusView | null>(null)
  const [devices, setDevices] = useState<SyncDeviceView[] | null>(null)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [relay, setRelay] = useState('')
  const [viewer, setViewer] = useState('')
  // A one-time code, held only while it's showing.
  const [shown, setShown] = useState<{ which: 'phone' | 'viewer'; pairing: SyncPairing } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const loadStatus = useCallback(async (): Promise<SyncStatusView | null> => {
    try {
      const s = await api.getSyncStatus()
      setStatus(s)
      return s
    } catch (e) {
      toast(errorMessage(e), 'error')
      return null
    }
  }, [toast])

  useEffect(() => {
    void loadStatus().then((s) => {
      if (!s) return
      setRelay(s.relayUrl ?? '')
      setViewer(s.viewerUrl ?? '')
    })
  }, [loadStatus])

  const paired = !!status?.paired
  const waiting = !!devices?.some((d) => d.state === 'waiting')
  const showing = shown !== null
  // The device list and the status, often while a device may be pairing.
  useEffect(() => {
    if (!paired) return
    let alive = true
    const load = (): void => {
      void api.listSyncDevices().then(
        (d) => {
          if (!alive) return
          setDevices(d)
          setDevicesError(null)
        },
        (e) => alive && setDevicesError(errorMessage(e))
      )
      void api.getSyncStatus().then((s) => alive && setStatus(s), () => {})
    }
    load()
    const timer = setInterval(load, showing || waiting ? 5000 : 20000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [paired, showing, waiting, tick])

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(what)
    try {
      return await fn()
    } catch (e) {
      toast(errorMessage(e), 'error')
      return undefined
    } finally {
      setBusy(null)
    }
  }

  // Pressed again, a code closes.
  async function show(which: 'phone' | 'viewer'): Promise<void> {
    if (shown?.which === which) return setShown(null)
    await run(which, async () => {
      const pairing = await api.startPairing(which)
      setShown({ which, pairing })
      await loadStatus()
    })
  }

  // A code that ran out closes.
  useEffect(() => {
    if (!shown) return
    const left = Date.parse(shown.pairing.expiresAt) - Date.now()
    const timer = setTimeout(() => setShown(null), Math.max(0, left))
    return () => clearTimeout(timer)
  }, [shown])

  const saveRelay = (): Promise<void> =>
    run('relay', async () => {
      const s = await api.setRelayUrl(relay.trim() || null)
      if (!s) return
      setStatus(s)
      setRelay(s.relayUrl ?? '')
      // A reset onto a new relay: the codes showing are the old mailbox's.
      setShown(null)
    }).then(() => {})

  const saveViewer = (): Promise<void> =>
    run('viewer-url', async () => {
      const s = await api.setViewerUrl(viewer.trim() || null)
      setStatus(s)
      setViewer(s.viewerUrl ?? '')
      if (shown?.which === 'viewer') setShown(s.viewerUrl ? { which: 'viewer', pairing: await api.startPairing('viewer') } : null)
    }).then(() => {})

  const copy = (): Promise<void> =>
    run('copy-viewer', async () => {
      await api.copySyncPairing('viewer')
      toast('Copied')
    }).then(() => {})

  const device = (fn: () => Promise<SyncDeviceView[]>, what: string): Promise<void> =>
    run(what, async () => {
      setDevices(await fn())
      await loadStatus()
    }).then(() => {})

  const reset = (): Promise<void> =>
    run('reset', async () => {
      const s = await api.resetSync()
      if (!s) return
      setStatus(s)
      setShown(null)
      setDevices(null)
      toast('Pairing reset')
    }).then(() => {})

  const syncNow = (): Promise<void> =>
    run('sync', async () => {
      setStatus(await api.syncNow())
    }).then(() => {})

  if (!status) return null
  const relayChanged = relay.trim() !== (status.relayUrl ?? '')
  const viewerChanged = viewer.trim() !== (status.viewerUrl ?? '')
  const svg = shown?.pairing.svg

  return (
    <div className="card">
      <h2>Devices</h2>
      {/* The addresses come with a product build; a development build can point at its own. */}
      {status.urlsEditable && (
      <div className="tier-rows" style={{ marginTop: 0 }}>
        <span className="label-muted">Relay</span>
        <div className="row">
          <input className="input" placeholder="https://" aria-label="Relay URL" value={relay} onChange={(e) => setRelay(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && relayChanged && void saveRelay()} style={{ flex: 1, maxWidth: 420 }} spellCheck={false} />
          <button className="btn small" disabled={!relayChanged || (paired && !relay.trim()) || busy !== null} onClick={() => void saveRelay()}>
            Save
          </button>
        </div>
        <span className="label-muted">Web viewer</span>
        <div className="row">
          <input className="input" placeholder="https://" aria-label="Web viewer URL" value={viewer} onChange={(e) => setViewer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && viewerChanged && void saveViewer()} style={{ flex: 1, maxWidth: 420 }} spellCheck={false} />
          <button className="btn small" disabled={!viewerChanged || busy !== null} onClick={() => void saveViewer()}>
            Save
          </button>
        </div>
      </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button className={`btn ${shown?.which === 'phone' ? 'primary' : ''}`} aria-pressed={shown?.which === 'phone'} disabled={!status.relayUrl || busy !== null} onClick={() => void show('phone')}>
          {busy === 'phone' ? 'Pairing…' : 'Pair a phone'}
        </button>
        <button className={`btn ${shown?.which === 'viewer' ? 'primary' : ''}`} aria-pressed={shown?.which === 'viewer'} disabled={!status.relayUrl || !status.viewerUrl || busy !== null} onClick={() => void show('viewer')}>
          {busy === 'viewer' ? 'Pairing…' : 'Web viewer'}
        </button>
      </div>
      {shown && svg && (
        <div className="row" style={{ marginTop: 16, alignItems: 'flex-end', gap: 16 }}>
          <img className="pairing-qr" src={svgSrc(svg)} width={220} height={220} alt={shown.which === 'viewer' ? 'Web viewer link' : 'Pairing code'} style={{ borderRadius: 4, background: '#fff' }} />
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="small mono muted">{`Until ${fmtWhen(shown.pairing.expiresAt)}`}</span>
            <div className="row">
              {shown.which === 'viewer' && (
                <button className="btn small" disabled={busy !== null} onClick={() => void copy()}>
                  Copy link
                </button>
              )}
              <button className="btn small ghost" onClick={() => setShown(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {paired && (
        <table className="cat-table sync-devices" style={{ marginTop: 16 }}>
          <thead>
            <tr className="label-muted">
              <td>Device</td>
              <td>Role</td>
              <td>Code</td>
              <td>Status</td>
              <td>Last seen</td>
              <td />
            </tr>
          </thead>
          <tbody>
            {devicesError && (
              <tr>
                <td colSpan={6} className="small" style={{ color: 'var(--neg)' }}>
                  {devicesError}
                </td>
              </tr>
            )}
            {!devicesError && devices?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted small">
                  None
                </td>
              </tr>
            )}
            {devices?.map((d) => (
              <tr key={d.deviceId} data-device={d.deviceId}>
                <td>{d.name || d.deviceId}</td>
                <td>{ROLE_LABEL[d.role] ?? d.role}</td>
                <td className="mono small" data-code={d.code}>{fmtCode(d.code)}</td>
                <td>
                  <span className="row small">
                    <span className={`status-dot ${d.state === 'approved' ? 'on' : ''}`} aria-hidden />
                    {STATE_LABEL[d.state]}
                  </span>
                </td>
                <td className="mono small">{fmtWhen(d.lastSeen)}</td>
                <td className="num">
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    {d.state === 'waiting' && (
                      <button className="btn small primary" disabled={busy !== null} onClick={() => void device(() => api.approveSyncDevice({ deviceId: d.deviceId, devicePub: d.devicePub, role: d.role }), `approve-${d.deviceId}`)}>
                        <Icon name="check" size={13} /> Approve
                      </button>
                    )}
                    <button className="btn small ghost danger" disabled={busy !== null} onClick={() => void device(() => api.removeSyncDevice(d.deviceId), `remove-${d.deviceId}`)}>
                      Remove
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {paired && (
        <div className="tier-rows">
          <span className="label-muted">Desktop code</span>
          <span className="small mono">{fmtCode(status.desktopCode)}</span>
          <span className="label-muted">Last published</span>
          <span className="small mono">{status.lastPublishedAt ? `${fmtWhen(status.lastPublishedAt)} · ${status.lastBytes ? fmtSize(status.lastBytes) : ''}` : '—'}</span>
          <span className="label-muted">Last command</span>
          <span className="small">{status.lastCommand ? `${fmtWhen(status.lastCommand.at)} · ${status.lastCommand.text}` : '—'}</span>
          {status.lastError && (
            <>
              <span className="label-muted">Last error</span>
              <span className="small" style={{ color: 'var(--neg)' }}>{`${fmtWhen(status.lastError.at)} · ${status.lastError.text}`}</span>
            </>
          )}
        </div>
      )}

      {paired && (
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn small" disabled={busy !== null || status.running} onClick={() => void syncNow()}>
            <Icon name="refresh" size={13} className={busy === 'sync' ? 'spin' : ''} /> Sync now
          </button>
          <button className="btn small ghost danger" disabled={busy !== null} onClick={() => void reset()}>
            Reset pairing
          </button>
        </div>
      )}
    </div>
  )
}

/** Development builds: the books into an empty hosted account on the configured server, signed in by emailed code. */
function MoveToAccount(): ReactNode {
  const { toast } = useApp()
  const [status, setStatus] = useState<MoveAccountStatus | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void api.moveAccountStatus().then(
      (s) => alive && setStatus(s),
      () => {}
    )
    return () => {
      alive = false
    }
  }, [])
  if (!status?.available) return null

  const run = async (step: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await step()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const sendCode = (): Promise<void> =>
    run(async () => {
      await api.moveAccountSendCode(email)
      setSent(true)
    })
  const move = (): Promise<void> =>
    run(async () => {
      const r = await api.moveAccountFinish(email, code)
      setSent(false)
      setCode('')
      toast(`Moved ${r.rows.toLocaleString('en-US')} rows · ${r.files} files${r.skipped.length ? ` · ${r.skipped.length} files not moved` : ''}`)
    })

  return (
    <div className="row" style={{ marginTop: 12 }}>
      <div className="label-muted">Move to an account</div>
      <span className="mono small muted">{status.server}</span>
      <input className="input" type="email" placeholder="Email" aria-label="Account email" value={email} disabled={busy || sent} onChange={(e) => setEmail(e.target.value)} style={{ width: 220 }} spellCheck={false} />
      {!sent ? (
        <button className="btn" disabled={busy || !email.trim()} onClick={() => void sendCode()}>
          Send code
        </button>
      ) : (
        <>
          <input className="input mono" inputMode="numeric" placeholder="Code" aria-label="Sign-in code" value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void move()} style={{ width: 100 }} />
          <button className="btn primary" disabled={busy || !code.trim()} onClick={() => void move()}>
            {busy ? 'Moving…' : 'Move'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setSent(false)}>
            Cancel
          </button>
        </>
      )}
    </div>
  )
}

function ClaudeCodeSignIn(): ReactNode {
  const { toast } = useApp()
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null)
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    let alive = true
    void api.claudeCodeStatus({ force: true }).then((s) => alive && setStatus(s))
    return () => {
      alive = false
    }
  }, [])

  // After opening the sign-in window, check every few seconds until it's done (up to 5 minutes).
  useEffect(() => {
    if (!waiting) return
    const started = Date.now()
    const timer = setInterval(() => {
      void api.claudeCodeStatus({ force: true }).then((s) => {
        setStatus(s)
        if (s.loggedIn || Date.now() - started > 5 * 60_000) setWaiting(false)
      })
    }, 3000)
    return () => clearInterval(timer)
  }, [waiting])

  async function signIn(): Promise<void> {
    try {
      await api.claudeCodeSignIn()
      setWaiting(true)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const text = !status
    ? 'Checking Claude Code…'
    : !status.installed
      ? 'Claude Code isn\'t installed'
      : status.loggedIn
        ? `Signed in${status.account ? ` as ${status.account}` : ''}${status.method ? ` · ${status.method}` : ''}`
        : waiting
          ? 'Finish signing in in the window that opened…'
          : 'Not signed in'

  return (
    <div className="row small" style={{ marginBottom: 16 }}>
      <span className={`status-dot ${status?.loggedIn ? 'on' : ''}`} aria-hidden />
      {text}
      {status && !status.installed && (
        <button className="link small" onClick={() => void api.openExternal(INSTALL_URL)}>
          Install Claude Code
        </button>
      )}
      {status?.installed && !status.loggedIn && (
        <button className="btn small primary" disabled={waiting} onClick={() => void signIn()}>
          Sign in
        </button>
      )}
    </div>
  )
}

/** The hosted service runs on the plan's token (Settings → Plan); a token can also be pasted here, for a development build. */
function LicenseToken({ status }: { status: AiStatus | null }): ReactNode {
  const { settings, reloadSettings, toast } = useApp()
  const [token, setToken] = useState('')
  if (!settings) return null

  async function save(): Promise<void> {
    try {
      await api.setLicenseToken(token)
      setToken('')
      await reloadSettings()
      toast('License token saved')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <>
      <div className="row small" style={{ marginBottom: 10 }}>
        <span className={`status-dot ${status?.ready ? 'on' : ''}`} aria-hidden />
        {!status ? 'Checking…' : (status.problem ?? (settings.plan.licensed ? `${PLAN_LABELS[settings.plan.plan]} license` : 'No license'))}
      </div>
      {settings.claudeCodeOffered && (
        <div className="row" style={{ marginBottom: 16 }}>
          <input className="input" type="password" placeholder={settings.licenseTokenSaved ? 'Paste a new token to replace it' : 'Paste a license token'} value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1, maxWidth: 420 }} autoComplete="off" aria-label="License token" />
          <button className="btn primary" disabled={!token.trim()} onClick={() => void save()}>
            Save token
          </button>
          {settings.licenseTokenSaved && (
            <button className="btn ghost danger" onClick={() => void api.clearLicenseToken().then(reloadSettings)}>
              Remove
            </button>
          )}
        </div>
      )}
    </>
  )
}

function ApiKey({ status }: { status: AiStatus | null }): ReactNode {
  const { settings, reloadSettings, toast } = useApp()
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  if (!settings) return null

  async function save(): Promise<void> {
    try {
      await api.setApiKey(key)
      setKey('')
      await reloadSettings()
      toast('API key saved')
      void test()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  // One billed call with the key; the dot shows what the last one found.
  async function test(): Promise<void> {
    setTesting(true)
    try {
      const c = await api.checkApiKey()
      toast(keyCheckLine(c), c.result === 'ok' ? undefined : 'error')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setTesting(false)
      await reloadSettings()
    }
  }

  const keyText = {
    saved: 'API key saved (encrypted)',
    env: 'Using ANTHROPIC_API_KEY',
    none: 'No API key'
  }[settings.apiKeySource]
  const check = settings.apiKeySource === 'none' ? null : settings.keyCheck
  const checkText = check ? ` · ${keyCheckLine(check)} · ${fmtAgo(check.at)}` : ''

  return (
    <>
      <div className="row small" style={{ marginBottom: 10 }}>
        <span className={`status-dot ${keyDot(settings.apiKeySource, check)}`} aria-hidden />
        {status?.problem ?? `${keyText}${checkText}`}
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <input className="input" type="password" placeholder={settings.apiKeySource === 'saved' ? 'Paste a new key to replace it' : 'Paste your Anthropic API key (sk-ant-…)'} value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: 1, maxWidth: 420 }} autoComplete="off" />
        <button className="btn primary" disabled={!key.trim()} onClick={() => void save()}>
          Save key
        </button>
        <button className="btn" disabled={testing || settings.apiKeySource === 'none'} onClick={() => void test()}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {settings.apiKeySource === 'saved' && (
          <button className="btn ghost danger" onClick={() => void api.clearApiKey().then(reloadSettings)}>
            Remove
          </button>
        )}
        <button className="link small" onClick={() => void api.openExternal(KEYS_URL)}>
          Get an API key
        </button>
      </div>
    </>
  )
}

function Categories(): ReactNode {
  const { categories, reloadCategories, toast } = useApp()
  const [draft, setDraft] = useState<Category[]>(categories)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<CategoryKind>('expense')

  useEffect(() => setDraft(categories), [categories])

  async function save(c: Category): Promise<void> {
    const orig = categories.find((x) => x.id === c.id)
    if (orig && orig.name === c.name && orig.kind === c.kind && orig.description === c.description) return
    try {
      await api.saveCategory(c)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
    await reloadCategories()
  }

  async function add(): Promise<void> {
    try {
      await api.saveCategory({ name: newName, kind: newKind, description: '' })
      setNewName('')
      await reloadCategories()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function remove(c: Category): Promise<void> {
    if (!confirm(`Delete "${c.name}"? Its transactions become uncategorized and any rules using it are removed.`)) return
    await api.deleteCategory(c.id).catch((e) => toast(errorMessage(e), 'error'))
    await reloadCategories()
  }

  const update = (id: number, patch: Partial<Category>): void => setDraft((d) => d.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  return (
    <div className="card">
      <h2>Categories</h2>
      <table className="cat-table categories">
        <colgroup>
          <col style={{ width: 200 }} />
          <col style={{ width: 130 }} />
          <col />
          <col style={{ width: 40 }} />
        </colgroup>
        <tbody>
          {draft.map((c) => (
            <tr key={c.id}>
              <td>
                <input className="input" value={c.name} aria-label="Category name" onChange={(e) => update(c.id, { name: e.target.value })} onBlur={() => void save(c)} />
              </td>
              <td>
                <select
                  className="select"
                  value={c.kind}
                  aria-label="Category type"
                  onChange={(e) => {
                    const next = { ...c, kind: e.target.value as CategoryKind }
                    update(c.id, next)
                    void save(next)
                  }}
                >
                  <option value="expense">Spending</option>
                  <option value="income">Income</option>
                  <option value="transfer">Transfer</option>
                </select>
              </td>
              <td>
                <input className="input" value={c.description} placeholder="Hint for the AI (optional)" aria-label="Category hint" onChange={(e) => update(c.id, { description: e.target.value })} onBlur={() => void save(c)} />
              </td>
              <td>
                <button className="btn small ghost icon-btn danger" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}>
                  <Icon name="trash" size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12 }}>
        <input className="input" placeholder="New category name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newName.trim() && void add()} />
        <select className="select" value={newKind} onChange={(e) => setNewKind(e.target.value as CategoryKind)} aria-label="New category type">
          <option value="expense">Spending</option>
          <option value="income">Income</option>
          <option value="transfer">Transfer</option>
        </select>
        <button className="btn" disabled={!newName.trim()} onClick={() => void add()}>
          <Icon name="plus" size={14} /> Add
        </button>
      </div>
    </div>
  )
}

function Rules(): ReactNode {
  const { categories, tick, toast } = useApp()
  const [rules, setRules] = useState<Rule[]>([])
  const [field, setField] = useState<RuleField>('contains')
  const [pattern, setPattern] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)

  const load = (): void => void api.listRules().then(setRules, () => {})
  useEffect(load, [tick])

  async function add(): Promise<void> {
    if (categoryId === null) return
    try {
      await api.addRule({ field, pattern, categoryId })
      setPattern('')
      load()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="card">
      <h2>Rules</h2>
      {rules.length === 0 && <div className="muted small">None</div>}
      {rules.map((r) => (
        <div className="list-row" key={r.id}>
          <div className="grow small">
            <span className="muted">{FIELD_LABEL[r.field]}</span> <span className="mono">“{r.pattern}”</span> <span className="muted">→</span> <strong>{r.categoryName}</strong>
          </div>
          <button
            className="btn small ghost icon-btn danger"
            aria-label="Delete rule"
            onClick={() => void api.deleteRule(r.id).then(load, (e) => toast(errorMessage(e), 'error'))}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <select className="select" value={field} onChange={(e) => setField(e.target.value as RuleField)} aria-label="Rule type">
          <option value="contains">Description contains</option>
          <option value="merchant">Merchant is</option>
        </select>
        <input className="input" placeholder={field === 'contains' ? 'e.g. costco' : 'e.g. Trader Joe’s'} value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} allowNone={false} />
        <button className="btn" disabled={!pattern.trim() || categoryId === null} onClick={() => void add()}>
          <Icon name="plus" size={14} /> Add rule
        </button>
      </div>
    </div>
  )
}

/** The toast after an update check. */
function updateText(r: UpdateCheck, current: string): string {
  switch (r.status) {
    case 'off':
      return 'No update feed'
    case 'current':
      return `Up to date · ${current}`
    case 'downloading':
      return `${r.version} downloading`
    case 'ready':
      return `${r.version} downloaded · installs when you quit, or from the tray's Restart to update`
    case 'available':
      return `${r.version} is out · this build can't install it itself${r.url ? ', so its download page is opening' : ''}`
    case 'failed':
      return `Update check failed: ${r.error ?? ''}`
  }
}

function DataSettings(): ReactNode {
  const { settings, toast, reloadSettings } = useApp()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [codeModal, setCodeModal] = useState<'new' | 'check' | null>(null)
  const [restoreFile, setRestoreFile] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.getAppInfo().then((i) => alive && setInfo(i), () => {})
    return () => {
      alive = false
    }
  }, [])
  const saved = (run: () => Promise<string | null>, did: string): void => void run().then((p) => p && toast(`${did} ${p}`), (e) => toast(errorMessage(e), 'error'))
  const checkUpdates = (): void =>
    void api.checkForUpdates().then(
      (r) => {
        toast(updateText(r, info?.version ?? ''), r.status === 'failed' ? 'error' : 'info')
        // A build that can't install the update itself shows where it is.
        if (r.status === 'available' && r.url) void api.openExternal(r.url).catch(() => {})
      },
      (e) => toast(errorMessage(e), 'error')
    )
  const copyDiagnostics = (): void => void api.copyDiagnostics().then(() => toast('Diagnostics copied'), (e) => toast(errorMessage(e), 'error'))
  const deleteAll = (): void => void api.deleteAllData().catch((e) => toast(errorMessage(e), 'error'))
  // A backup encrypted on another computer asks for its recovery code.
  const restore = (): void => void api.restoreBackup().then((r) => r && typeof r === 'object' && setRestoreFile(r.needsCode), (e) => toast(errorMessage(e), 'error'))
  const setEncrypted = (on: boolean): void => void api.setDbEncryption(on).then(reloadSettings, (e) => toast(errorMessage(e), 'error'))
  const database = settings?.database
  // The web app's books are the account's: no folder, local backup, encryption key, updater or diagnostics here.
  const web = onWeb()
  return (
    <div className="card">
      <h2>Data</h2>
      {!web && (
      <div className="row">
        <code className="data-path truncate">
          {settings?.dataPath}
        </code>
        <button className="btn" onClick={() => void api.openDataFolder()}>
          <Icon name="folder" size={15} /> Open folder
        </button>
        <button className="btn" onClick={() => void api.openBackupsFolder()}>
          <Icon name="folder" size={15} /> Open backups folder
        </button>
      </div>
      )}
      <div className="row" style={{ marginTop: web ? 0 : 12 }}>
        {!web && (
          <>
            <button className="btn" onClick={() => saved(api.backupNow, 'Backed up to')}>
              <Icon name="download" size={15} /> Back up now
            </button>
            <button className="btn" onClick={restore}>
              <Icon name="upload" size={15} /> Restore backup
            </button>
          </>
        )}
        <button className="btn" onClick={() => saved(api.exportAll, 'Exported to')}>
          <Icon name="download" size={15} /> Export all data
        </button>
        <button className="btn" onClick={() => saved(api.exportCsv, 'Exported to')}>
          <Icon name="download" size={15} /> Export all transactions
        </button>
      </div>
      {database && !web && (
        <div className="row" style={{ marginTop: 12, gap: 14 }}>
          <div className="label-muted">Database</div>
          {database.switchable ? (
            <label className="check">
              <input type="checkbox" checked={database.switchOn} onChange={(e) => setEncrypted(e.target.checked)} />
              Encrypted
            </label>
          ) : (
            <span className="small">{database.encrypted ? 'Encrypted' : 'Not encrypted'}</span>
          )}
          {database.switchable && database.switchOn !== database.encrypted && <span className="muted small">After restart</span>}
          {database.encrypted && (
            <>
              <div className="label-muted" style={{ marginLeft: 12 }}>
                Recovery code
              </div>
              <button className="btn small" onClick={() => setCodeModal('new')}>
                <Icon name="lock" size={13} /> New recovery code
              </button>
              <button className="btn small ghost" disabled={database.recoveryPending} onClick={() => setCodeModal('check')}>
                Check
              </button>
              <span className="muted small">Shown once; a new code replaces the old one.</span>
            </>
          )}
        </div>
      )}
      {!web && (
      <div className="row" style={{ marginTop: 12 }}>
        <span className="mono small">{info ? `Version ${info.version}` : ''}</span>
        <button className="btn" onClick={checkUpdates}>
          <Icon name="refresh" size={15} /> Check for updates
        </button>
        <button className="btn" onClick={copyDiagnostics}>
          <Icon name="list" size={15} /> Copy diagnostics
        </button>
      </div>
      )}
      <div className="muted small" style={{ marginTop: 8 }}>
        {NOT_ADVICE}
      </div>
      {!web && <MoveToAccount />}
      <DataFolders />
      {/* On the web, deleting everything is Settings → Account's Delete account. */}
      {!web && (
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn danger" onClick={deleteAll}>
          <Icon name="trash" size={15} /> Delete all data
        </button>
      </div>
      )}
      {codeModal === 'new' && <RecoveryCodeModal onClose={() => setCodeModal(null)} />}
      {codeModal === 'check' && <CheckCodeModal onClose={() => setCodeModal(null)} />}
      {restoreFile && <RestoreCodeModal file={restoreFile} onClose={() => setRestoreFile(null)} />}
    </div>
  )
}
