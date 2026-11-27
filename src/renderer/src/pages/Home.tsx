import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HOME_OPEN, type Account, type CommittedGroup, type ContributionSummary, type HomeOpen, type HomePlans, type Insight, type Span, type Spendable, type Waterfall } from '../../../shared/types'
import { useApp } from '../App'
import { LoadSampleButton, SampleDataBar } from '../Empty'
import { FlowChart, FlowViewToggle, StepWalk, useFlowView } from '../Flow'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { ReportButton, ReportDialog } from '../ReportDialog'
import { api, currentMonth, errorMessage, todayKey } from '../lib'
import { NARROW } from '../shellMenu'
import { Contributions } from './Contributions'
import { HomeRows } from './HomeRows'
import { SpanPicker } from './SpanPicker'
import { SpendableCard } from './Spendable'
import { UpcomingList, upcomingUntil } from './Upcoming'
import { arrivalView, HOME_VIEW_KEY, HOME_VIEWS, homeTable, shownHomeView, nextDays, readSpan, sankeyFlow, spanMark, spendableParts, spendNote, walkSteps, writeSpan, type ElectiveView, type LeftOverView, type Opened, type Preset } from './homeView'

// Home is the Personal waterfall (spec 1.10): Gross pay down to Saved, then Invested and Growth, each with its amount
// over the span, its run rate, its rate and its change over 3 months, from one getWaterfall per span. One row opens
// at a time, showing the rows that lead into it, its Δ pts and its levers; the Spendable strip opens the forecast.
// Take-home opens on each payroll's pay-day table and the contributions, Elective on its Committed groups or the
// next 30 days by date (spec 1.3 and 1.4), Left over on its categories with their targets and habits or its payees,
// and Saved on its one-offs, where Kept went, the goals and the debt plan's next target (spec 1.5 and 1.6); every
// part opens the Transactions list on exactly its lines. Rows,
// Walk and Sankey draw the same rows (Decision 2). The span, the open row and the view are this viewer's, kept in
// localStorage; what Home first opens on is the home.open setting, from onboarding's answer.

const ROW_KEY = 'home.row'

/** The span this viewer left, and the preset it was picked by: Net worth's Overview reads the same one. */
const loadSpan = (): { span: Span; preset: Preset | null } => readSpan(() => localStorage, todayKey())

const keepSpan = (s: Span, preset: Preset | null): void => writeSpan(() => localStorage, s, preset, todayKey())

/** The row this viewer left open: undefined when none was kept, so home.open decides. */
function keptRow(): Opened | undefined {
  try {
    const v = localStorage.getItem(ROW_KEY)
    if (v === 'none') return null
    return v && (HOME_OPEN as readonly string[]).includes(v) ? (v as HomeOpen) : undefined
  } catch {
    return undefined
  }
}

/**
 * Elective's view and the group open under it, as this window left them: a drill's Transactions list and back finds
 * them as they were. Held for the window's life only; localStorage keeps the open row and the view (spec section 7).
 */
const electiveKept: { view: ElectiveView; group: CommittedGroup | null } = { view: 'groups', group: null }

/** Left over's Categories or Payees, as this window left it, the same way. */
const leftOverKept: { view: LeftOverView } = { view: 'categories' }

/**
 * Left over's and Saved's plans as this window last had them, with the data change they answer (the app's tick): back
 * on Home from a drill's Transactions list, the same data asks for nothing again.
 */
const plansKept: { tick: number; plans: HomePlans | null } = { tick: -1, plans: null }

function keepRow(open: Opened): void {
  try {
    localStorage.setItem(ROW_KEY, open && open !== 'unexplained' ? open : 'none')
  } catch {
    /* per-viewer convenience only */
  }
}

/** Whether the window is a phone's width (shellMenu.ts NARROW), following it as it changes. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => {
    try {
      return matchMedia(NARROW).matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    let q: MediaQueryList
    try {
      q = matchMedia(NARROW)
    } catch {
      return
    }
    const follow = (): void => setNarrow(q.matches)
    q.addEventListener('change', follow)
    return () => q.removeEventListener('change', follow)
  }, [])
  return narrow
}

/** The strip's figure, with its asterisk at a risk that can overestimate (spendNote), and the last day it keeps the cushion through. */
function SpendableFigure({ strip }: { strip: NonNullable<Waterfall['spendable']> }): ReactNode {
  const { figure, until } = spendableParts(strip)
  const note = spendNote(strip.risk)
  return (
    <span className="num">
      {figure}
      {note && (
        <span className="spend-mark" title={note}>
          *
        </span>
      )}{' '}
      through {until}
    </span>
  )
}

export default function Home({ request }: { request: { open: HomeOpen | null; n: number } | null }): ReactNode {
  const { tick, go, goNet, toast, settings, can } = useApp()
  const [picked, setPicked] = useState(loadSpan)
  const span = picked.span
  // The latest answer, with the span it answers: until the span picked has its own, the figures shown are dimmed.
  const [answer, setAnswer] = useState<{ span: Span; w: Waterfall } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const wf = answer?.w ?? null
  const stale = !!answer && (answer.span.from !== span.from || answer.span.to !== span.to)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [open, setOpenState] = useState<Opened | undefined>(keptRow)
  const [spend, setSpend] = useState<Spendable | null>(null)
  const [contrib, setContrib] = useState<ContributionSummary | null>(null)
  // Elective's Committed by group or by date, and the group open under it, as they were left.
  const [electiveView, setElectiveViewState] = useState<ElectiveView>(electiveKept.view)
  const [group, setGroupState] = useState<CommittedGroup | null>(electiveKept.group)
  const setElectiveView = (v: ElectiveView): void => {
    electiveKept.view = v
    setElectiveViewState(v)
  }
  const setGroup = (g: CommittedGroup | null): void => {
    electiveKept.group = g
    setGroupState(g)
  }
  const [leftOverView, setLeftOverViewState] = useState<LeftOverView>(leftOverKept.view)
  const setLeftOverView = (v: LeftOverView): void => {
    leftOverKept.view = v
    setLeftOverViewState(v)
  }
  // The view picked here, else the Sankey, or the rows for a row open on arrival (arrivalView), shown but not kept.
  const [view, setView, showView, viewPicked] = useFlowView(HOME_VIEWS, HOME_VIEW_KEY, () => arrivalView(keptRow()))
  const flowOn = can('moneyFlow')
  const narrow = useNarrow()

  const setOpen = useCallback((next: Opened) => {
    setOpenState(next)
    keepRow(next)
  }, [])
  // With no row kept, Home opens on home.open once the settings are in.
  useEffect(() => {
    if (open !== undefined || !settings) return
    setOpenState(settings.homeOpen)
    if (!viewPicked) showView(arrivalView(settings.homeOpen))
  }, [open, settings, viewPicked, showView])
  // go() to Home with a row (the Dashboard, Budget and Recurring, or a notification) opens it, in the rows, where an
  // open row shows, for now: the view picked stays as it was. The Spendable strip sits above every view.
  useEffect(() => {
    if (!request) return
    setOpen(request.open)
    if (request.open && request.open !== 'spendable') showView('rows')
  }, [request, setOpen, showView])

  // One getWaterfall per span, and again when the data changes; a slower answer for an older span is dropped.
  const asked = useRef(0)
  useEffect(() => {
    const n = ++asked.current
    setFailed(null)
    api.getWaterfall(span).then(
      (w) => n === asked.current && setAnswer({ span, w }),
      (e) => {
        if (n !== asked.current) return
        setFailed(errorMessage(e))
        toast(errorMessage(e), 'error')
      }
    )
  }, [span, tick, toast])
  useEffect(() => {
    api.listAccounts().then(setAccounts, () => {})
  }, [tick])
  // What an open row's drill reads beside the waterfall, one call for it, once a data change: the forecast behind
  // the Spendable strip and Elective's By date (with no current balance there's no strip to open), and Take-home's
  // contributions. Neither depends on the span, so switching rows and spans asks again only after the data changed.
  const spendOpen = open === 'spendable' && !!wf?.spendable
  const wantSpend = spendOpen || open === 'elective'
  const spendAsked = useRef(-1)
  useEffect(() => {
    if (!wantSpend || spendAsked.current === tick) return
    spendAsked.current = tick
    api.getSpendable().then(setSpend, (e) => toast(errorMessage(e), 'error'))
  }, [wantSpend, tick, toast])
  const wantContrib = open === 'takeHome'
  const contribAsked = useRef(-1)
  useEffect(() => {
    if (!wantContrib || contribAsked.current === tick) return
    contribAsked.current = tick
    api.listContributions().then(setContrib, (e) => toast(errorMessage(e), 'error'))
  }, [wantContrib, tick, toast])
  // Left over's and Saved's plans (targets, habits, the one-off budget, goals and the debt plan's next target), one
  // call for both and none of it the span's: the categories, payees and one-offs come in the waterfall.
  const [plans, setPlans] = useState<HomePlans | null>(plansKept.plans)
  const wantPlans = open === 'leftOver' || open === 'saved'
  useEffect(() => {
    if (!wantPlans || plansKept.tick === tick) return
    plansKept.tick = tick
    api.getHomePlans().then(
      (p) => {
        plansKept.plans = p
        setPlans(p)
      },
      (e) => {
        // Asked again the next time Home opens.
        plansKept.tick = -1
        toast(errorMessage(e), 'error')
      }
    )
  }, [wantPlans, tick, toast])

  const pickSpan = (s: Span, preset: Preset | null): void => {
    setPicked({ span: s, preset })
    keepSpan(s, preset)
  }
  const names = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.name])), [accounts])
  const next = useMemo(() => nextDays(spend?.items ?? []), [spend])
  const table = useMemo(() => (wf ? homeTable(wf, open ?? null, names, { electiveView, group, nextDays: next, leftOverView, plans }) : null), [wf, open, names, electiveView, group, next, leftOverView, plans])
  // The charts are laid out again only when the waterfall changes.
  const steps = useMemo(() => (wf ? walkSteps(wf) : []), [wf])
  const flow = useMemo(() => (wf ? sankeyFlow(wf) : null), [wf])
  const shownView = shownHomeView({ flowOn, view, picked: viewPicked, flow, narrow })
  const toggle = (id: HomeOpen | 'unexplained'): void => setOpen(open === id ? null : id)

  if (accounts?.length === 0) {
    return (
      <>
        <PageHeader title="Home" />
        <div className="page">
          <div className="card empty">
            <h2>No accounts yet</h2>
            <button className="btn primary" onClick={() => go('accounts')}>
              <Icon name="bank" size={15} /> Add an account
            </button>
            <LoadSampleButton />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Home">
        <SpanPicker span={span} preset={picked.preset} firstMonth={wf?.firstMonth ?? null} mark={wf && !stale ? spanMark(wf.months) : null} onChange={pickSpan} />
      </PageHeader>
      <div className="page home">
        <SampleDataBar />
        {wf?.spendable && (
          <button className={`home-strip${spendOpen ? ' open' : ''}`} aria-expanded={spendOpen} onClick={() => toggle('spendable')}>
            <span className="label-muted">Spendable</span>
            <SpendableFigure strip={wf.spendable} />
            <Icon name="chevronRight" size={13} className="home-chevron" />
          </button>
        )}
        {spendOpen && spend && <SpendableCard spend={spend} />}
        <div className="home-bar">
          <Headline onCategory={(categoryId) => go('transactions', { month: currentMonth(), categoryId, bucketId: 'personal' })} />
          {flowOn && <FlowViewToggle view={shownView} onChange={setView} views={HOME_VIEWS} />}
        </div>
        {!table || !flow ? (
          failed ? <div className="card empty">{failed}</div> : <div className="skeleton" style={{ height: 290 }} />
        ) : (
          <div className={stale ? 'home-stale' : undefined} aria-busy={stale}>
            {shownView === 'walk' ? (
              <StepWalk steps={steps} />
            ) : shownView === 'sankey' ? (
              <FlowChart data={flow} />
            ) : (
              <HomeRows
                table={table}
                onOpen={toggle}
                onDrill={(f) => go('transactions', f)}
                onPage={(p, v) => (v ? goNet(v) : go(p))}
                onGroup={(g) => setGroup(group === g ? null : g)}
                onView={setElectiveView}
                onLeftOverView={setLeftOverView}
                onNet={goNet}
                slots={{
                  contributions: <Contributions summary={contrib} compact />,
                  byDate: spend ? <UpcomingList spend={spend} until={upcomingUntil(todayKey())} /> : <div className="skeleton" style={{ height: 120 }} />
                }}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** The headline as one line above the rows (spec section 4): the insight's own words, and its category's transactions. */
function Headline({ onCategory }: { onCategory: (categoryId: number) => void }): ReactNode {
  const { settings } = useApp()
  const [insight, setInsight] = useState<Insight | null>(null)
  const [reporting, setReporting] = useState(false)
  const load = useCallback(() => {
    api.getInsight({ force: false }).then(setInsight, () => setInsight(null))
  }, [])
  // On opening and after a sync, and after a categorizing run or an import (debounced), not on every edit; the main
  // process keeps its answer until the numbers under it change.
  useEffect(() => load(), [load, settings?.lastSyncAt])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.onBulkChange(() => {
      clearTimeout(timer)
      timer = setTimeout(load, 1500)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [load])
  // With no headline the line is left out; the view toggle keeps its place on the right.
  if (!insight) return null
  // The line is cut to the width it has, so its title holds it whole, with the detail under it.
  const title = [insight.headline, insight.detail].filter(Boolean).join('\n')
  return (
    <>
      <div className={`home-headline tone-${insight.tone}`}>
        {insight.categoryId !== null ? (
          <button className="home-headline-text" title={title} onClick={() => onCategory(insight.categoryId!)}>
            {insight.headline}
          </button>
        ) : (
          <span className="home-headline-text" title={title}>
            {insight.headline}
          </span>
        )}
        {insight.source === 'ai' && <ReportButton className="report-link" onClick={() => setReporting(true)} />}
      </div>
      {reporting && <ReportDialog route="headline" message={[insight.headline, insight.detail].filter(Boolean).join('\n')} onClose={() => setReporting(false)} />}
    </>
  )
}
