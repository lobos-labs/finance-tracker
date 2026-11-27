import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, Bucket, Category, ClassifyProgress, HomeOpen } from '../../shared/types'
import type { FeatureId } from '../../shared/plans'
import { APP_NAME } from '../../shared/app'
import { api, canUse, classifiedToasts, describeClassify, errorMessage, fmtAgo, fmtDate, setNumbersHidden } from './lib'
import { Icon, type IconName } from './Icon'
import { Logo } from './PageHeader'
import { LockedPage, PAGE_FEATURE, planFocused } from './Tier'
import { focusPayoff, sendDebtPlan } from './plan'
import { NARROW, openMenu } from './shellMenu'
import Home from './pages/Home'
import { routeOf, type LegacyPage } from './pages/homeView'
import Transactions from './pages/Transactions'
import type { TxnFilter } from './pages/txnFilter'
import Accounts from './pages/Accounts'
import NetWorth, { NET_VIEWS, type NetView } from './pages/NetWorth'
import Benefits from './pages/Benefits'
import Taxes from './pages/Taxes'
import Credit from './pages/Credit'
import Goals from './pages/Goals'
import Insurance from './pages/Insurance'
import Buckets from './pages/Buckets'
import Calendar from './pages/Calendar'
import Settings from './pages/Settings'
import Review from './pages/Review'
import { FirstRun } from './pages/Onboarding'
import { DropZone } from './DropZone'

/** The pages (spec section 4). The Dashboard, Budget and Recurring are rows of Home now: go() takes their old ids there (homeView.routeOf). */
export type Page = 'home' | 'transactions' | 'benefits' | 'insurance' | 'taxes' | 'credit' | 'review' | 'calendar' | 'networth' | 'buckets' | 'accounts' | 'settings' | 'goals'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface AppContext {
  toast(text: string, kind?: Toast['kind']): void
  /** Opens a page: Transactions on a filter, Home with a row open (null closes them); an old page's id lands on Home */
  go(page: Page | LegacyPage, filter?: TxnFilter, open?: HomeOpen | null): void
  /** Opens a view of Net worth (Overview, Investments, Property, Debts), as its sidebar entry does, and Debts at its payoff plan: Home's debt plan line opens it */
  goNet(view: NetView): void
  /** Opens one venture's page on Ventures: a venture's row on Net worth opens it */
  goVenture(id: number): void
  tick: number
  settings: AppSettings | null
  reloadSettings(): Promise<void>
  categories: Category[]
  reloadCategories(): Promise<void>
  buckets: Bucket[]
  classifying: ClassifyProgress | null
  runClassify(redoAi?: boolean): Promise<void>
  syncing: boolean
  runSync(): Promise<void>
  uncategorized: number
  /** whether the plan in force includes a feature (the main process refuses the calls either way) */
  can(id: FeatureId): boolean
}

const Ctx = createContext<AppContext | null>(null)

export function useApp(): AppContext {
  const c = useContext(Ctx)
  if (!c) throw new Error('useApp outside provider')
  return c
}

export { classifiedToasts, describeClassify }

interface NavLink {
  label: string
  page: Page
  /** a view of the Net worth page rather than a page of its own */
  view?: NetView
}
interface NavItem {
  id: string
  label: string
  icon: IconName
  /** the page it opens; a group without one opens its last-used page */
  page?: Page
  children?: NavLink[]
}

// The waterfall spec's navigation (section 4): Home, the next action, the lines and their days, then the groups
// checked weekly or monthly, then setup.
const NAV: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home', page: 'home' },
  { id: 'review', label: 'Review', icon: 'chat', page: 'review' },
  { id: 'transactions', label: 'Transactions', icon: 'list', page: 'transactions' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', page: 'calendar' },
  { id: 'networth', label: 'Net worth', icon: 'gem', page: 'networth', children: [...NET_VIEWS.map((v) => ({ label: v.label, page: 'networth' as const, view: v.id })), { label: 'Goals', page: 'goals' }, { label: 'Credit', page: 'credit' }] },
  {
    id: 'records',
    label: 'Records',
    icon: 'folder',
    children: [
      { label: 'Pay & benefits', page: 'benefits' },
      { label: 'Insurance', page: 'insurance' },
      { label: 'Taxes', page: 'taxes' }
    ]
  },
  { id: 'buckets', label: 'Ventures', icon: 'layers', page: 'buckets' },
  { id: 'accounts', label: 'Accounts', icon: 'bank', page: 'accounts' },
  { id: 'settings', label: 'Settings', icon: 'gear', page: 'settings' }
]

/** The group a page sits in, if any. */
const groupOf = (p: Page): NavItem | undefined => NAV.find((n) => n.children && (n.page === p || n.children.some((c) => c.page === p)))

/** The page's name on the top bar at a phone's width: its entry's, and a view of Net worth by the title its page shows. */
const pageName = (p: Page, view: NetView): string => {
  if (p === 'networth') return view === 'overview' ? 'Net worth' : (NET_VIEWS.find((v) => v.id === view)?.label ?? 'Net worth')
  return NAV.flatMap((n) => (n.page === p && !n.children ? [n.label] : (n.children ?? []).filter((c) => c.page === p && !c.view).map((c) => c.label)))[0] ?? ''
}

const NET_VIEW_KEY = 'networth.view'

/** Mirrors the "hide numbers when the app opens" setting, so the very first paint already follows it. */
const HIDE_ON_OPEN = 'numbers.hideOnOpen'
function hiddenOnOpen(): boolean {
  try {
    return localStorage.getItem(HIDE_ON_OPEN) === '1'
  } catch {
    return false
  }
}

export default function App(): ReactNode {
  // Back from Stripe's checkout or portal (the web), the app opens at Settings → Plan.
  const [page, setPage] = useState<Page>(() => (planFocused() ? 'settings' : 'home'))
  // The row go() asks Home to open, numbered so asking for the same one again still opens it.
  const [homeRequest, setHomeRequest] = useState<{ open: HomeOpen | null; n: number } | null>(null)
  // Net worth's view is picked in the sidebar; the last one sticks while the app is open.
  const [netView, setNetView] = useState<NetView>(() => {
    try {
      const v = sessionStorage.getItem(NET_VIEW_KEY)
      return NET_VIEWS.some((x) => x.id === v) ? (v as NetView) : 'overview'
    } catch {
      return 'overview'
    }
  })
  // The sidebar group that shows its pages: it opens when one of them is picked, and clicking it again closes it.
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  // At a phone's width the sidebar opens over the page from the top bar's menu control (shellMenu.ts).
  const [menu, setMenu] = useState(false)
  const menuControl = useRef<HTMLButtonElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  const shellBar = useRef<HTMLElement>(null)
  // While it's open the top bar and the page behind it can't be reached (mainRef is the page's column, below).
  useEffect(() => (menu ? openMenu({ doc: document, control: menuControl.current, panel: sidebar.current, behind: [shellBar.current, mainRef.current] }, () => setMenu(false)) : undefined), [menu])
  // Widened past a phone's width, the sidebar is back in its place and the menu is closed.
  useEffect(() => {
    const narrow = matchMedia(NARROW)
    const wide = (): void => {
      if (!narrow.matches) setMenu(false)
    }
    narrow.addEventListener('change', wide)
    return () => narrow.removeEventListener('change', wide)
  }, [])
  // Each group's last page, which its header opens; it sticks while the app is open.
  const lastInGroup = useRef<Record<string, Page>>({})
  // Bumped on every pick, so picking the view already shown still leaves an open asset.
  const [netPicks, setNetPicks] = useState(0)
  const pickNet = useCallback((v: NetView) => {
    setNetView(v)
    setNetPicks((n) => n + 1)
    setPage('networth')
    setMenu(false)
    try {
      sessionStorage.setItem(NET_VIEW_KEY, v)
    } catch {
      /* per-viewer convenience only */
    }
  }, [])
  const [numbersHidden, setHiddenState] = useState(() => {
    const on = hiddenOnOpen()
    setNumbersHidden(on)
    return on
  })
  // The flag changes before the redraw, so amounts redraw without their K or M at once.
  const hide = useCallback((on: boolean) => {
    setNumbersHidden(on)
    setHiddenState(on)
    // Notifications mask their amounts while the eye is on.
    api.setNumbersHidden(on).catch(() => {})
  }, [])
  const openedWith = useRef(false)
  const [txnFilter, setTxnFilter] = useState<TxnFilter>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [tick, setTick] = useState(0)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [classifying, setClassifying] = useState<ClassifyProgress | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [uncategorized, setUncategorized] = useState(0)
  const [openItems, setOpenItems] = useState(0)
  const nextId = useRef(1)

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000)
  }, [])

  const reloadSettings = useCallback(async () => setSettings(await api.getSettings()), [])
  const reloadCategories = useCallback(async () => setCategories(await api.listCategories()), [])

  useEffect(() => {
    void reloadSettings()
    void reloadCategories()
    // The debt plan's inputs this viewer kept before the plan had its setting go to it, once.
    void sendDebtPlan(api)
    const offNotify = api.onNotify((text) => toast(text))
    const offData = api.onDataChanged(() => {
      setTick((t) => t + 1)
      void reloadSettings()
    })
    return () => {
      offNotify()
      offData()
    }
  }, [reloadSettings, reloadCategories, toast])

  // The setting decides how the app opens (the eye toggles for now); later changes apply at the next open.
  useEffect(() => {
    if (!settings) return
    try {
      localStorage.setItem(HIDE_ON_OPEN, settings.hideNumbersOnOpen ? '1' : '0')
    } catch {
      /* the mirror is a convenience; the setting still applies once loaded */
    }
    if (!openedWith.current) {
      openedWith.current = true
      hide(settings.hideNumbersOnOpen)
    }
  }, [settings, hide])

  useEffect(() => {
    api.listTransactions({ categoryId: 'none', limit: 1 }).then((p) => setUncategorized(p.total), () => {})
    api.listBuckets().then(setBuckets, () => {})
    api.getReview().then((r) => setOpenItems(Object.values(r.openIssues).reduce((a, b) => a + b, 0)), () => {})
  }, [tick])

  // What Home opens on (home.open), as the settings have it now: where go('dashboard') lands.
  const homeOpen = useRef<HomeOpen | null>(null)
  homeOpen.current = settings?.homeOpen ?? null
  // A venture's page opens on Ventures as its row there does (goVenture); any other way to a page opens Ventures on its list.
  const [ventureRequest, setVentureRequest] = useState<{ id: number; n: number } | null>(null)
  const route = useCallback((p: Page | LegacyPage, filter?: TxnFilter, open?: HomeOpen | null, notification = false) => {
    const to = routeOf(p, { homeOpen: homeOpen.current, notification })
    const row = open !== undefined ? open : to.open
    if (filter) setTxnFilter(filter)
    if (to.page === 'home') setHomeRequest((r) => (row === undefined ? null : { open: row, n: (r?.n ?? 0) + 1 }))
    setVentureRequest(null)
    // The page's group opens to show where it is; the others fold away.
    setOpenGroup(groupOf(to.page)?.id ?? null)
    setPage(to.page)
    // A page chosen from the menu, or opened any other way, closes the menu.
    setMenu(false)
  }, [])
  const go = useCallback((p: Page | LegacyPage, filter?: TxnFilter, open?: HomeOpen | null) => route(p, filter, open), [route])
  const goVenture = useCallback(
    (id: number) => {
      route('buckets')
      setVentureRequest((r) => ({ id, n: (r?.n ?? 0) + 1 }))
    },
    [route]
  )
  // A view of Net worth opens as the sidebar picks it, with its group open to show where it is; Debts at its payoff plan.
  const goNet = useCallback(
    (v: NetView) => {
      if (v === 'debts') focusPayoff()
      setOpenGroup(groupOf('networth')?.id ?? null)
      pickNet(v)
    },
    [pickNet]
  )

  useEffect(() => {
    const g = groupOf(page)
    if (g) lastInGroup.current[g.id] = page
  }, [page])

  // A clicked notification opens its page; Transactions opens anew on its search and month.
  const [opened, setOpened] = useState(0)
  useEffect(
    () =>
      api.onOpenPage((t) => {
        setOpened((n) => n + 1)
        route(t.page, t.page === 'transactions' ? { search: t.search, month: t.month } : undefined, undefined, true)
      }),
    [route]
  )

  // A page, or a view of Net worth, opens at its top: a drill picked low on Home opens Transactions with its filter in
  // view, Saved's next debt opens Debts from its heading, then its payoff plan scrolls into view once it's in
  // (DebtPlan.tsx), and a link at the foot of a scrolled page (Growth's › Net worth) opens the next one with its
  // headline in view.
  const mainRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    mainRef.current?.scrollTo?.(0, 0)
  }, [page, netView, netPicks, opened])

  const runClassify = useCallback(
    async (redoAi = false) => {
      setClassifying({ done: 0, total: 0, stage: 'Starting…' })
      const off = api.onClassifyProgress(setClassifying)
      try {
        const r = await api.classify({ redoAi })
        toast(describeClassify(r))
        if (r.error) toast(r.error, 'error')
      } catch (err) {
        toast(errorMessage(err), 'error')
      } finally {
        off()
        setClassifying(null)
      }
    },
    [toast]
  )

  const runSync = useCallback(async () => {
    setSyncing(true)
    try {
      const r = await api.sync()
      toast(`Synced ${r.accounts} account${r.accounts === 1 ? '' : 's'} · ${r.added} new transaction${r.added === 1 ? '' : 's'}${r.historyFrom ? ` · history from ${fmtDate(r.historyFrom)}` : ''}`)
      for (const [text, kind] of classifiedToasts(r.classified)) toast(text, kind)
      for (const w of r.warnings) toast(`Bank connection: ${w}`, 'error')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSyncing(false)
      void reloadSettings()
    }
  }, [toast, reloadSettings])

  const can = useCallback((id: FeatureId) => canUse(settings, id), [settings])
  /** The feature a page is locked behind, if any. */
  const lockOf = (p: Page): FeatureId | null => {
    const f = PAGE_FEATURE[p]
    return f && !can(f) ? f : null
  }
  const lock = (p: Page): ReactNode => (lockOf(p) ? <Icon name="lock" size={12} strokeWidth={1.8} className="nav-lock" /> : null)
  const pageLock = lockOf(page)

  const ctx: AppContext = { toast, go, goNet, goVenture, tick, settings, reloadSettings, categories, reloadCategories, buckets, classifying, runClassify, syncing, runSync, uncategorized, can }

  const brandName = (
    <span className="brand-name">
      {APP_NAME.split(' ').map((w, i) => (
        <span key={i}>
          {i > 0 && <span className="dot">·</span>}
          {w}
        </span>
      ))}
    </span>
  )

  return (
    <Ctx.Provider value={ctx}>
      <div className={`app ${menu ? 'menu-open' : ''}`}>
        {/* At a phone's width only: the app's name, the page and the control that opens the sidebar over it. */}
        <header className="shell-bar" ref={shellBar}>
          <button ref={menuControl} className="btn ghost icon-btn shell-menu" aria-expanded={menu} aria-controls="shell-nav" aria-label="Menu" onClick={() => setMenu((m) => !m)}>
            <Icon name="menu" size={18} />
            {/* Review's count, the one next action, shows with the menu closed as the sidebar shows it. */}
            {openItems > 0 && (
              <span className="nav-badge shell-badge" title="Open items to review">
                {openItems}
              </span>
            )}
          </button>
          <Logo className="brand-logo" />
          {brandName}
          <span className="shell-page">{pageName(page, netView)}</span>
        </header>
        <nav className="sidebar" id="shell-nav" aria-label="Main" ref={sidebar}>
          <div className="brand">
            <Logo className="brand-logo" />
            {brandName}
            <button className="btn ghost icon-btn small brand-eye" aria-pressed={numbersHidden} aria-label={numbersHidden ? 'Show numbers' : 'Hide numbers'} title={numbersHidden ? 'Show numbers' : 'Hide numbers'} onClick={() => hide(!numbersHidden)}>
              <Icon name={numbersHidden ? 'eyeOff' : 'eye'} size={14} />
            </button>
          </div>
          <div className="nav">
            {NAV.map((n) => {
              if (!n.children) {
                const p = n.page!
                return (
                  <button key={n.id} className={`nav-item ${page === p ? 'active' : ''}`} aria-current={page === p ? 'page' : undefined} onClick={() => go(p, p === 'transactions' ? {} : undefined)}>
                    <Icon name={n.icon} size={15} strokeWidth={1.6} />
                    {n.label}
                    {p === 'review' && openItems > 0 && <span className="nav-badge" title="Open items to review">{openItems}</span>}
                    {p === 'transactions' && uncategorized > 0 && <span className="nav-badge" title="Uncategorized transactions">{uncategorized}</span>}
                    {lock(p)}
                  </button>
                )
              }
              // A group opens into its pages; clicking it again closes them. Closed on one of its pages, it's marked like any other page.
              const open = openGroup === n.id
              const within = groupOf(page)?.id === n.id
              const badge = !open && n.children.some((c) => c.page === 'transactions') ? uncategorized : 0
              // A group whose pages are all locked carries the glyph itself.
              const allLocked = n.children.every((c) => lockOf(c.page))
              return (
                <div key={n.id} className="nav-tree">
                  <button
                    className={`nav-item ${within ? (open ? 'within' : 'active') : ''}`}
                    aria-expanded={open}
                    aria-current={within && !open ? 'page' : undefined}
                    onClick={() => {
                      if (within) return setOpenGroup(open ? null : n.id)
                      const to = n.page ?? lastInGroup.current[n.id] ?? n.children![0].page
                      go(to, to === 'transactions' ? {} : undefined)
                    }}
                  >
                    <Icon name={n.icon} size={15} strokeWidth={1.6} />
                    {n.label}
                    {badge > 0 && <span className="nav-badge" title="Uncategorized transactions">{badge}</span>}
                    {allLocked && <Icon name="lock" size={12} strokeWidth={1.8} className="nav-lock" />}
                    <Icon name="chevronRight" size={13} className={`nav-chevron ${open ? 'open' : ''}`} />
                  </button>
                  {open &&
                    n.children.map((c) => {
                      const on = page === c.page && (!c.view || netView === c.view)
                      return (
                        <button
                          key={c.view ?? c.page}
                          className={`nav-item nav-sub ${on ? 'active' : ''}`}
                          aria-current={on ? 'page' : undefined}
                          onClick={() => (c.view ? pickNet(c.view) : go(c.page, c.page === 'transactions' ? {} : undefined))}
                        >
                          {c.label}
                          {c.page === 'transactions' && uncategorized > 0 && <span className="nav-badge" title="Uncategorized transactions">{uncategorized}</span>}
                          {!c.view && lock(c.page)}
                        </button>
                      )
                    })}
                </div>
              )
            })}
          </div>
          <div className="sidebar-footer">
            {classifying && (
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>
                  Categorizing {classifying.total ? `${classifying.done}/${classifying.total}` : ''}
                </div>
                <div className="progress">
                  <div style={{ width: classifying.total ? `${(classifying.done / classifying.total) * 100}%` : '8%' }} />
                </div>
              </div>
            )}
            {settings?.simplefinConnected || settings?.bank?.connections.length ? (
              <>
                <div className="row">
                  <span className="status-dot on" aria-hidden />
                  Bank synced {fmtAgo(settings.lastSyncAt)}
                </div>
                <button className="btn small" onClick={() => void runSync()} disabled={syncing}>
                  <Icon name="refresh" className={syncing ? 'spin' : ''} size={13} />
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              </>
            ) : (
              <div className="row">
                <span className="status-dot" aria-hidden />
                No bank connected
              </div>
            )}
          </div>
        </nav>
        <main className="main" ref={mainRef}>
          {pageLock && <LockedPage feature={pageLock} title={NAV.flatMap((n) => (n.page === page ? [n.label] : (n.children ?? []).filter((c) => c.page === page && !c.view).map((c) => c.label)))[0] ?? page} />}
          {page === 'home' && <Home request={homeRequest} />}
          {page === 'transactions' && <Transactions key={opened} initialFilter={txnFilter} />}
          {page === 'review' && <Review />}
          {page === 'calendar' && <Calendar />}
          {page === 'networth' && <NetWorth view={netView} picks={netPicks} onView={pickNet} />}
          {page === 'benefits' && !pageLock && <Benefits />}
          {page === 'insurance' && !pageLock && <Insurance />}
          {page === 'taxes' && !pageLock && <Taxes />}
          {page === 'credit' && <Credit />}
          {page === 'goals' && <Goals />}
          {page === 'buckets' && !pageLock && <Buckets request={ventureRequest} />}
          {page === 'accounts' && <Accounts />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
      <DropZone />
      <FirstRun />
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
