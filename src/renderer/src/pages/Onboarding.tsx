import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account, AiSetup, HomeOpen, ImportPreview, OnboardingState, Spendable, SyncResult } from '../../../shared/types'
import { keyCheckLine, type KeyCheck } from '../../../shared/checks'
import { TRIAL_DAYS } from '../../../shared/plans'
import { AI_CONSENT_LINE, LEGAL_LINKS } from '../../../shared/app'
import { classifiedToasts, useApp } from '../App'
import { Icon } from '../Icon'
import { api, errorMessage, onWeb, SIMPLEFIN_BRIDGE_URL, simplefinOffered } from '../lib'
import { WelcomeStep } from './Welcome'
import { ImportModal } from './StatementImportModal'
import { monthDay } from './Upcoming'
import { signedRound } from './Spendable'
import { RecoveryCodeBlock, RecoveryCodeModal } from '../RecoveryCode'
import { aiPrimary, bankPrimary, currentCheck, foundLine, type CheckedKey } from './wizardFlow'
import { HOME_CHOICES, homeChoiceLabel, spendNote } from './homeView'

// The first run: five steps drawn over the app until the user has seen where
// the data lives, chosen how the AI runs, brought in (or skipped) a bank, and
// said what Home should open on (home.open). A bank just linked brings one more
// right after it: what's spendable from the main account, its low day and the
// next payday ("Estimating" while the bank's history is still arriving). The
// web asks one more: whether notifications show dollar amounts (the ledger's
// alert preferences; No unless told otherwise). The web's first step, its
// welcome with the 18+ and Terms line, comes before the app (web/Agree.tsx,
// pages/Welcome.tsx): the account's books stay closed until it's ticked, and
// ticking it starts the trial at the server. So the web's AI step has no plan
// to choose: it is the consent line (Apple's 5.1.2(i)), Allow or Not now.
// Enter runs each step's primary action, Esc its skip. The AI step checks an
// API key with one billed call (src/main/ai/keyCheck.ts) and the bank step
// checks the setup token before it's sent; nothing else here calls a model.
// The design is in docs/onboarding-ux.md; the step logic is in wizardFlow.ts.

const ALL_STEPS = ['welcome', 'ai', 'bank', 'spendable', 'home', 'notify', 'done'] as const
type Step = (typeof ALL_STEPS)[number]
// Alerts with amounts are the hosted ledger's (push, text, email); the desktop's own notifications are set in Settings.
// Spendable follows a bank linked here. The web's welcome was the page before the app (web/Agree.tsx).
const stepsHere = (linked: boolean): readonly Step[] =>
  ALL_STEPS.filter((s) => (s !== 'notify' || onWeb()) && (s !== 'welcome' || !onWeb()) && (s !== 'spendable' || linked))

const AI_LABEL: Record<AiSetup, string> = { trial: `Trial · ${TRIAL_DAYS} days`, key: 'API key', 'claude-code': 'Claude subscription', none: 'Off', later: 'Later' }
/** The web's answer to the consent line, as the last step lists it. */
const CONSENT_LABEL = (chosen: AiSetup | null): string => (chosen === 'trial' ? 'Allowed' : 'Not now')

const TRIAL_CAPS = `${TRIAL_DAYS}-day trial · no card`

/** Shows the wizard on a first run (no accounts, not finished); after it, a recovery code not yet saved (an install encrypted at an upgrade); nothing otherwise. */
export function FirstRun(): ReactNode {
  const { go, settings } = useApp()
  const [state, setState] = useState<OnboardingState | null>(null)
  useEffect(() => {
    api.getOnboarding().then(setState, () => {})
  }, [])
  if (state && !state.needed && state.recoveryPending) return <RecoveryCodeModal cancel={false} onClose={() => setState(null)} />
  if (!state?.needed) return null
  return (
    <Onboarding
      state={state}
      onDone={() => {
        setState(null)
        // Home, open on what the Home step chose (home.open).
        go('home', undefined, settings?.homeOpen ?? null)
      }}
    />
  )
}

export default function Onboarding({ state: initial, onDone }: { state: OnboardingState; onDone: () => void }): ReactNode {
  const { settings, toast, reloadSettings } = useApp()
  const [state, setState] = useState(initial)
  const [linked, setLinked] = useState(false)
  const STEPS = stepsHere(linked)
  const [step, setStep] = useState<Step>(STEPS[0])
  const [amounts, setAmounts] = useState(false)
  const [amountsChosen, setAmountsChosen] = useState<boolean | null>(null)
  // Which action is running, so its button says so and the keys wait.
  const [busy, setBusy] = useState<'ai' | 'check' | 'connect' | 'csv' | 'sample' | 'finish' | 'notify' | null>(null)
  // The beta and the open edition have every feature already and no hosted AI, so no trial to start: the AI runs on the user's own key.
  const trialOffered = !initial.plan.beta && !initial.plan.openEdition
  const [ai, setAi] = useState<AiSetup>(trialOffered ? 'trial' : 'key')
  const [chosen, setChosen] = useState<AiSetup | null>(null)
  const [key, setKey] = useState('')
  const [checked, setChecked] = useState<CheckedKey | null>(null)
  const [token, setToken] = useState('')
  const [bankError, setBankError] = useState<string | null>(null)
  const [bank, setBank] = useState<{ accounts: number; transactions: number | null } | null>(null)
  const [csv, setCsv] = useState<ImportPreview | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  // What Home opens on (null: Everything, no row), and the answer once saved.
  const [lead, setLead] = useState<HomeOpen | null>(null)
  const [leadChosen, setLeadChosen] = useState<HomeOpen | null>(null)
  // An encrypted install's last step shows the recovery code; Done waits for Saved.
  const [saved, setSaved] = useState(false)
  const codeWaits = initial.recoveryPending && !saved
  const panel = useRef<HTMLDivElement>(null)

  const envKey = settings?.apiKeySource === 'env'
  // Claude Code mode is for development builds, the same test Settings uses.
  const dev = settings?.claudeCodeOffered ?? false
  // SimpleFIN's setup token in place of Plaid (the open edition, or a development build without a server).
  const sfin = simplefinOffered(settings)
  const n = STEPS.indexOf(step)
  const next = (): void => setStep(STEPS[Math.min(n + 1, STEPS.length - 1)])
  const fail = (e: unknown): void => toast(errorMessage(e), 'error')

  // Each step opens with focus inside the panel, so Enter and Esc work at once.
  useEffect(() => {
    const el = panel.current
    if (!el) return
    ;(el.querySelector<HTMLElement>('[data-focus]') ?? el).focus()
  }, [step, ai])

  async function run(what: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> {
    setBusy(what)
    try {
      await fn()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const changeDocs = (): void => {
    api.setDocumentsDir(null).then((dir) => dir && setState((s) => ({ ...s, docsDir: dir })), fail)
  }

  // The key's check: Check runs it, Continue runs it when it hasn't run, and only a pass advances by itself.
  const aiNext = aiPrimary({ ai, key, envKey, checked })
  const keyCheck = ai === 'key' ? currentCheck(key, checked) : null
  const keyFailed = !!keyCheck && keyCheck.result !== 'ok'
  const checkKey = async (): Promise<KeyCheck> => {
    const k = key.trim()
    const c = await api.checkApiKey(k || undefined)
    setChecked({ key: k, check: c })
    return c
  }
  const runCheck = (): Promise<void> =>
    run('check', async () => {
      await checkKey()
    })
  // Saving a checked key keeps its check (main matches it); "Continue anyway" saves a failed one the same way.
  const commitAi = async (): Promise<void> => {
    if (ai === 'key' && key.trim()) await api.setApiKey(key.trim())
    // The trial starts here (locally, and at the server when one is set); the choice is recorded after.
    if (ai === 'trial') await api.startTrial()
    await api.setupAi(ai)
    setChosen(ai)
    setKey('')
    setChecked(null)
    await reloadSettings()
    next()
  }
  const continueAi = (): Promise<void> => {
    if (aiNext === 'blocked' || aiNext === 'retry') return Promise.resolve()
    return run(aiNext === 'check' ? 'check' : 'ai', async () => {
      if (aiNext === 'check' && (await checkKey()).result !== 'ok') return
      await commitAi()
    })
  }
  const continueAnyway = (): Promise<void> => run('ai', commitAi)
  const laterAi = (): Promise<void> =>
    run('ai', async () => {
      await api.setupAi('later')
      setChosen('later')
      await reloadSettings()
      next()
    })
  // The web: the trial is already running (the server started it at the Terms), so the AI is on and waits only for
  // the consent line's answer. The answer is the account's, so the phone won't ask again; Settings → AI changes it.
  const answerAi = (allow: boolean): Promise<void> =>
    run('ai', async () => {
      await api.setupAi('trial')
      await api.setSettings({ aiConsent: allow })
      setChosen(allow ? 'trial' : 'none')
      await reloadSettings()
      next()
    })

  // Plaid's page opens in the browser; this waits for it (or Cancel). SimpleFIN's token is checked here first,
  // so text that isn't one never leaves the computer; the bridge's answer is one line.
  const connect = (): Promise<void> => {
    if (sfin && bankPrimary({ connected: false, token }) === 'invalid') {
      setBankError('Not a setup token')
      return Promise.resolve()
    }
    return run('connect', async () => {
      let r: SyncResult | null
      try {
        r = sfin ? await api.simplefinConnect(token.trim()) : await api.bankConnect()
      } catch (e) {
        setBankError(errorMessage(e))
        return
      }
      if (!r) return
      setToken('')
      setBankError(null)
      setLinked(true)
      setBank({ accounts: r.accounts, transactions: r.added })
      for (const [text, kind] of classifiedToasts(r.classified)) toast(text, kind)
      for (const w of r.warnings) toast(sfin ? `Bank connection: ${w}` : w, 'error')
      await reloadSettings()
    })
  }
  const pickCsv = (): Promise<void> =>
    run('csv', async () => {
      const p = await api.csvPick()
      if (!p) return
      setAccounts((await api.listAccounts()).filter((a) => a.source !== 'manual'))
      setCsv(p)
    })
  // The import dialog closes on cancel as well; the account count says which it was.
  const closeCsv = (): void => {
    setCsv(null)
    api.listAccounts().then((list) => {
      if (list.length > state.accounts) {
        setState((s) => ({ ...s, accounts: list.length }))
        setBank({ accounts: list.length, transactions: null })
        next()
      }
    }, fail)
  }

  const sealCode = async (): Promise<void> => {
    if (initial.recoveryPending) await api.confirmRecoveryCode()
  }
  // The answer is what Home opens on (home.open): Spendable, Saved, Growth or Left over, or no row for Everything.
  const chooseLead = (): Promise<void> =>
    run('finish', async () => {
      await api.setSettings({ homeOpen: lead })
      await reloadSettings()
      setLeadChosen(lead)
      next()
    })
  const chooseAmounts = (): Promise<void> =>
    run('notify', async () => {
      await api.setAlertPrefs({ showAmounts: amounts })
      setAmountsChosen(amounts)
      next()
    })
  const finish = (): Promise<void> =>
    run('finish', async () => {
      if (codeWaits) return
      await sealCode()
      await api.finishOnboarding()
      onDone()
    })
  const loadSample = (): Promise<void> =>
    run('sample', async () => {
      if (codeWaits) return
      await sealCode()
      const r = await api.loadDemoData()
      toast(`Sample data · ${r.accounts} accounts · ${r.transactions.toLocaleString()} transactions`)
      await api.finishOnboarding()
      onDone()
    })

  // Enter runs the step's primary action, Esc its skip; a focused button keeps
  // its own Enter. The handlers live in a ref so the listener is added once.
  const keys = useRef({ primary: (): void => {}, skip: (): void => {}, off: false })
  keys.current = {
    off: !!busy || !!csv,
    primary: () => {
      if (step === 'welcome') next()
      else if (step === 'ai' && onWeb()) void answerAi(true)
      else if (step === 'ai') void (aiNext === 'retry' ? runCheck() : continueAi())
      else if (step === 'bank') bankPrimary({ connected: !!bank, token: sfin ? token : undefined }) === 'advance' ? next() : void connect()
      else if (step === 'spendable') next()
      else if (step === 'home') void chooseLead()
      else if (step === 'notify') void chooseAmounts()
      else void finish()
    },
    skip: () => {
      if (step === 'welcome') next()
      else if (step === 'ai' && onWeb()) void answerAi(false)
      else if (step === 'ai') void laterAi()
      else if (step === 'bank' || step === 'spendable' || step === 'home' || step === 'notify') next()
      else void finish()
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = keys.current
      if (k.off || e.isComposing) return
      if (e.key === 'Enter') {
        const t = e.target as HTMLElement | null
        if (t && ['BUTTON', 'A', 'SELECT'].includes(t.tagName)) return
        e.preventDefault()
        k.primary()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        k.skip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const counter = (
    <div className="wizard-count">
      {n + 1} / {STEPS.length}
    </div>
  )

  return (
    <div className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="wizard-drag" aria-hidden />
      <div className="wizard-panel fade-up" key={step} ref={panel} tabIndex={-1}>
        {counter}

        {step === 'welcome' && (
          <WelcomeStep appName={state.appName} line="Your money, on this computer." onContinue={next}>
            <div className="wizard-rows">
              <div className="wizard-row">
                <span className="wizard-label">Data folder</span>
                <code title={state.dataDir}>{state.dataDir}</code>
                <button className="btn small" onClick={() => api.openDataFolder().catch(fail)}>
                  Open
                </button>
              </div>
              <div className="wizard-row">
                <span className="wizard-label">Documents folder</span>
                <code title={state.docsDir}>{state.docsDir}</code>
                {!state.docsDirLocked && (
                  <button className="btn small" onClick={changeDocs}>
                    Change…
                  </button>
                )}
                <button className="btn small" onClick={() => api.openDocumentFolder().catch(fail)}>
                  Open
                </button>
              </div>
            </div>
          </WelcomeStep>
        )}

        {step === 'ai' && onWeb() && (
          <>
            <h2 id="wizard-title">AI</h2>
            <p className="wizard-line">An AI does the bookkeeping. It sees only what each task needs.</p>
            <div className="wizard-caps">{TRIAL_CAPS}</div>
            <p className="wizard-line">
              {AI_CONSENT_LINE}{' '}
              <a href={LEGAL_LINKS.privacy} target="_blank" rel="noreferrer">
                Privacy Policy
              </a>
            </p>
            <div className="wizard-actions">
              <button className="btn ghost" disabled={!!busy} onClick={() => void answerAi(false)}>
                Not now
              </button>
              <button data-focus className="btn primary" disabled={!!busy} onClick={() => void answerAi(true)}>
                Allow
              </button>
            </div>
          </>
        )}

        {step === 'ai' && !onWeb() && (
          <>
            <h2 id="wizard-title">AI</h2>
            <p className="wizard-line">An AI does the bookkeeping. It sees only what each task needs.</p>
            <div className="segmented" role="group" aria-label="AI">
              {(
                [
                  ...(trialOffered ? [['trial', `Start ${TRIAL_DAYS}-day trial`] as const] : []),
                  // The friends beta and the open edition (no hosted AI) and development builds run on a key of the user's own.
                  ...(!trialOffered || dev ? [['key', 'Use my own API key'] as const] : []),
                  ...(dev ? [['claude-code', 'Claude subscription'] as const] : []),
                  ['none', 'No AI']
                ] as ReadonlyArray<readonly [AiSetup, string]>
              ).map(([id, label]) => (
                <button key={id} className={ai === id ? 'active' : ''} aria-pressed={ai === id} onClick={() => setAi(id)}>
                  {label}
                </button>
              ))}
            </div>
            {ai === 'trial' && <div className="wizard-caps">{TRIAL_CAPS}</div>}
            {ai === 'key' && (
              <>
                <div className="wizard-keyrow">
                  <input data-focus className="input" type="password" placeholder={envKey ? 'Using ANTHROPIC_API_KEY' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" aria-label="API key" />
                  {!keyFailed && (
                    <button className="btn" disabled={!!busy || aiNext === 'blocked'} onClick={() => void runCheck()}>
                      {busy === 'check' ? 'Checking…' : 'Check'}
                    </button>
                  )}
                </div>
                {keyCheck && (
                  <div className="wizard-check" role="status">
                    <span className={`status-dot ${keyFailed ? 'bad' : 'on'}`} aria-hidden />
                    {keyCheckLine(keyCheck)}
                  </div>
                )}
              </>
            )}
            {ai === 'claude-code' && <div className="wizard-caps">Sign-in · Settings → AI</div>}
            <div className="wizard-actions">
              <button className="btn ghost" disabled={!!busy} onClick={() => void laterAi()}>
                Later
              </button>
              {keyFailed ? (
                <>
                  <button className="btn" disabled={!!busy} onClick={() => void continueAnyway()}>
                    Continue anyway
                  </button>
                  <button className="btn primary" disabled={!!busy} onClick={() => void runCheck()}>
                    {busy === 'check' ? 'Checking…' : 'Try again'}
                  </button>
                </>
              ) : (
                <button className="btn primary" disabled={!!busy || aiNext === 'blocked'} onClick={() => void continueAi()}>
                  Continue
                </button>
              )}
            </div>
          </>
        )}

        {step === 'bank' && (
          <>
            <h2 id="wizard-title">Bank</h2>
            <p className="wizard-line">Bring in your accounts.</p>
            {bank ? (
              <div className="wizard-check" role="status">
                <span className="status-dot on" aria-hidden />
                {foundLine(bank.accounts, bank.transactions)}
              </div>
            ) : (
              <>
                {sfin ? (
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <textarea
                      data-focus
                      className="textarea"
                      rows={2}
                      style={{ flex: 1 }}
                      placeholder="Setup token"
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value)
                        setBankError(null)
                      }}
                      aria-label="Setup token"
                    />
                    <button className="btn" onClick={() => api.openExternal(SIMPLEFIN_BRIDGE_URL).catch(fail)}>
                      <Icon name="external" size={15} /> Get token
                    </button>
                    <button className="btn primary" disabled={!token.trim() || !!busy} onClick={() => void connect()}>
                      {busy === 'connect' ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                ) : (
                  <div className="row">
                    {busy === 'connect' ? (
                      <>
                        <span className="wizard-caps" style={{ margin: 0 }}>
                          Waiting for Plaid in your browser…
                        </span>
                        <button className="btn" onClick={() => void api.bankCancel()}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button data-focus className="btn primary" disabled={!!busy || !settings?.bank?.available} onClick={() => void connect()}>
                        <Icon name="bank" size={15} /> Connect bank
                      </button>
                    )}
                  </div>
                )}
                {bankError && (
                  <div className="wizard-check" role="alert">
                    <span className="status-dot bad" aria-hidden />
                    {bankError}
                  </div>
                )}
              </>
            )}
            <div className="wizard-actions">
              {!bank && (
                <button className="btn" disabled={!!busy} onClick={() => void pickCsv()}>
                  <Icon name="upload" size={15} /> Import file
                </button>
              )}
              <div className="spacer" />
              {bank ? (
                <button className="btn primary" onClick={next}>
                  Continue
                </button>
              ) : (
                <button className="btn ghost" disabled={!!busy} onClick={next}>
                  Later
                </button>
              )}
            </div>
          </>
        )}

        {step === 'spendable' && (
          <>
            <h2 id="wizard-title">Spendable</h2>
            <LinkedSpendable />
            <div className="wizard-actions">
              <div className="spacer" />
              <button data-focus className="btn primary" onClick={next}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'home' && (
          <>
            <h2 id="wizard-title">Home</h2>
            <p className="wizard-line">What comes first?</p>
            <div className="wizard-choices" role="radiogroup" aria-label="Home">
              {HOME_CHOICES.map((c) => (
                <button key={c.label} role="radio" aria-checked={lead === c.open} className={`btn ${lead === c.open ? 'primary' : ''}`} data-focus={lead === c.open || undefined} onClick={() => setLead(c.open)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <div className="spacer" />
              <button className="btn ghost" disabled={!!busy} onClick={next}>
                Later
              </button>
              <button className="btn primary" disabled={!!busy} onClick={() => void chooseLead()}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'notify' && (
          <>
            <h2 id="wizard-title">Notifications</h2>
            <p className="wizard-line">Show dollar amounts in notifications?</p>
            <div className="segmented" role="radiogroup" aria-label="Dollar amounts">
              {([false, true] as const).map((on) => (
                <button key={String(on)} role="radio" aria-checked={amounts === on} className={amounts === on ? 'active' : ''} data-focus={amounts === on || undefined} onClick={() => setAmounts(on)}>
                  {on ? 'Yes' : 'No'}
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <div className="spacer" />
              <button className="btn primary" disabled={!!busy} onClick={() => void chooseAmounts()}>
                {busy === 'notify' ? 'Saving…' : 'Continue'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <h2 id="wizard-title">Done</h2>
            <p className="wizard-line">Ready.</p>
            <div className="wizard-rows">
              <div className="wizard-row">
                <span className="wizard-label">AI</span>
                <code>{onWeb() ? CONSENT_LABEL(chosen) : AI_LABEL[chosen ?? 'later']}</code>
              </div>
              <div className="wizard-row">
                <span className="wizard-label">Bank</span>
                <code>{bank ? foundLine(bank.accounts, bank.transactions) : 'Later'}</code>
              </div>
              <div className="wizard-row">
                <span className="wizard-label">Home</span>
                <code>{homeChoiceLabel(leadChosen)}</code>
              </div>
              {STEPS.includes('notify') && (
                <div className="wizard-row">
                  <span className="wizard-label">Notifications</span>
                  <code>{amountsChosen ? 'Amounts shown' : 'Amounts hidden'}</code>
                </div>
              )}
            </div>
            {initial.recoveryPending && (
              <>
                <div className="wizard-label wizard-code-label">Recovery code</div>
                <RecoveryCodeBlock saved={saved} onSaved={setSaved} />
              </>
            )}
            <div className="wizard-actions">
              {state.accounts === 0 && !bank && (
                <button className="btn ghost" disabled={!!busy || codeWaits} onClick={() => void loadSample()}>
                  {busy === 'sample' ? 'Loading…' : 'Load sample data'}
                </button>
              )}
              <div className="spacer" />
              <button className="btn primary" disabled={!!busy || codeWaits} onClick={() => void finish()}>
                Open Home
              </button>
            </div>
          </>
        )}
      </div>
      {csv && <ImportModal preview={csv} accounts={accounts} onClose={closeCsv} />}
    </div>
  )
}

/** What's spendable from the main account right after its bank linked, again as the rest of its history arrives. */
function LinkedSpendable(): ReactNode {
  const [spend, setSpend] = useState<Spendable | null>(null)
  useEffect(() => {
    const load = (): void => void api.getSpendable().then(setSpend, () => {})
    load()
    return api.onDataChanged(load)
  }, [])
  if (!spend) return <div className="wizard-figure muted">…</div>
  const a = spend.accounts.find((x) => x.id === spend.accountId) ?? spend.accounts[0]
  if (!a) return <p className="wizard-line">No current balance</p>
  const note = spendNote(spend.risk)
  return (
    <>
      <div className={`wizard-figure ${a.spendableCents < 0 ? 'neg' : ''}`}>
        {signedRound(a.spendableCents)}
        {note && (
          <span className="spend-mark" title={note}>
            *
          </span>
        )}
      </div>
      <div className="wizard-caps wizard-figure-sub">{spend.provisional ? 'Estimating' : a.name}</div>
      <div className="wizard-rows">
        <div className="wizard-row">
          <span className="wizard-label">Low</span>
          <code>{monthDay(a.lowDay)}</code>
        </div>
        {a.nextPayday && (
          <div className="wizard-row">
            <span className="wizard-label">Payday</span>
            <code>{monthDay(a.nextPayday)}</code>
          </div>
        )}
      </div>
    </>
  )
}
