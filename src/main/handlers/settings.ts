import * as db from '../db'
import { aiConsent, aiEnabled, claudeCodeOffered, getModel, getProvider, proxyAvailable, routeConfig, setAiConsent, setAiEnabled, setRouteConfig } from '../ai/backend'
import { lastKeyCheck } from '../ai/keyCheck'
import { requestLogOn, setRequestLogOn } from '../ai/requestLog'
import { activate, clearToken, deactivate, importToken, planState, startTrial } from '../license'
import { hiddenVendors, hideNumbersOnOpen, setHiddenVendors, setHideNumbersOnOpen } from '../privacy'
import { spendSettings } from '../spendable'
import { saveThemeChoice, themeChoice } from '../themeSetting'
import { lookupsOn, setLookupsOn } from '../valuation'
import { AI_ROUTES, HOME_OPEN, MODEL_OPTIONS, type AiProvider, type AiRoute, type AppSettings, type HomeOpen, type RouteConfig, type ThemeChoice } from '../../shared/types'
import { changed, desktopOnly, hosted, type HandlerContext } from './context'
import { autoClassifyEnabled } from './data'

// Settings, the plan, the theme and the app's own facts.
// A license key or token belongs to a computer (desktop only); a hosted
// account's plan is the server's (/v1/me). The API key is the desktop's too
// (its secrets are the OS keystore's, ipc.ts).

type SettingsPatch = { provider?: AiProvider; model?: string; routes?: Partial<Record<AiRoute, Partial<RouteConfig>>>; autoClassify?: boolean; hideNumbersOnOpen?: boolean; hiddenVendors?: string[]; lookupValues?: boolean; requestLog?: boolean; aiEnabled?: boolean; aiConsent?: boolean; homeOpen?: HomeOpen | null }

const HOME_OPEN_KEY = 'home.open'
const isHomeOpen = (v: unknown): v is HomeOpen => typeof v === 'string' && (HOME_OPEN as readonly string[]).includes(v)

/** What Home opens on, as onboarding's answer left it: a row or the Spendable strip; null opens none. */
function homeOpen(): HomeOpen | null {
  const v = db.getSetting(HOME_OPEN_KEY)
  return isHomeOpen(v) ? v : null
}

function getSettings(ctx: HandlerContext): AppSettings {
  const host = ctx.settings()
  return {
    provider: getProvider(),
    model: getModel(),
    routes: Object.fromEntries(AI_ROUTES.map((r) => [r, routeConfig(r)])) as Record<AiRoute, RouteConfig>,
    claudeCodeOffered: claudeCodeOffered(),
    proxyAvailable: proxyAvailable(),
    licenseTokenSaved: host.licenseTokenSaved,
    autoClassify: autoClassifyEnabled(),
    apiKeySource: host.apiKeySource,
    keyCheck: lastKeyCheck(),
    simplefinConnected: host.simplefinConnected,
    bank: host.bank,
    lastSyncAt: host.lastSyncAt,
    syncsLast24h: host.syncsLast24h,
    historyFrom: host.historyFrom,
    historyComplete: host.historyComplete,
    syncWarnings: host.syncWarnings,
    dataPath: host.dataPath,
    database: host.database,
    hideNumbersOnOpen: hideNumbersOnOpen(),
    hiddenVendors: hiddenVendors(),
    lookupValues: lookupsOn(),
    requestLog: requestLogOn(),
    aiEnabled: aiEnabled(),
    aiConsent: aiConsent(),
    plan: planState(),
    theme: themeChoice(),
    homeOpen: homeOpen(),
    spendRisk: spendSettings().risk
  }
}

function setSettings(ctx: HandlerContext, patch: SettingsPatch): void {
  // The headline and Review redraw: off, the headline is the local one.
  if (patch.aiEnabled !== undefined && !!patch.aiEnabled !== aiEnabled()) changed(ctx, setAiEnabled(!!patch.aiEnabled))
  // The consent line's answer (hosted: the service's AI waits for it); the headline and Review redraw.
  if (patch.aiConsent !== undefined) changed(ctx, setAiConsent(!!patch.aiConsent))
  if (patch.hideNumbersOnOpen !== undefined) setHideNumbersOnOpen(!!patch.hideNumbersOnOpen)
  if (patch.requestLog !== undefined) setRequestLogOn(!!patch.requestLog)
  if (patch.lookupValues !== undefined) setLookupsOn(!!patch.lookupValues)
  // Hidden vendors leave every list and insight, so the views redraw.
  if (Array.isArray(patch.hiddenVendors)) changed(ctx, setHiddenVendors(patch.hiddenVendors.map(String)))
  if (patch.provider !== undefined) {
    if (patch.provider === 'claude-code' && !claudeCodeOffered()) throw new Error('Claude Code mode is for development builds')
    if (patch.provider === 'proxy' && !proxyAvailable()) throw new Error('No hosted service is set up')
    if (patch.provider !== 'claude-code' && patch.provider !== 'api' && patch.provider !== 'proxy') throw new Error('Unknown provider')
    db.setSetting('ai.provider', patch.provider)
  }
  if (patch.model !== undefined) {
    if (!MODEL_OPTIONS.some((m) => m.id === patch.model)) throw new Error('Unknown model')
    db.setSetting('ai.model', patch.model)
  }
  if (patch.routes) {
    for (const route of AI_ROUTES) if (patch.routes[route]) setRouteConfig(route, patch.routes[route])
  }
  if (patch.autoClassify !== undefined) db.setSetting('ai.autoClassify', patch.autoClassify ? '1' : '0')
  if (patch.homeOpen !== undefined) {
    if (patch.homeOpen !== null && !isHomeOpen(patch.homeOpen)) throw new Error('Home opens on one of its rows or Spendable')
    db.setSetting(HOME_OPEN_KEY, patch.homeOpen)
  }
}

export const settingsHandlers = {
  getSettings: hosted((ctx) => getSettings(ctx)),
  setSettings: hosted((ctx, patch: SettingsPatch) => setSettings(ctx, patch)),
  getPlan: hosted(() => planState()),
  setLicenseToken: desktopOnly((ctx, token: string) => {
    const t = String(token ?? '').trim()
    if (!t) throw new Error('Paste your license token first.')
    importToken(t)
    ctx.broadcast('data:changed')
  }),
  clearLicenseToken: desktopOnly((ctx) => {
    clearToken()
    ctx.broadcast('data:changed')
  }),
  startTrial: desktopOnly(async (ctx) => changed(ctx, await startTrial())),
  activateLicense: desktopOnly(async (ctx, key: string) => changed(ctx, await activate(String(key ?? '')))),
  deactivateLicense: desktopOnly(async (ctx) => changed(ctx, await deactivate())),
  setTheme: hosted((ctx, theme: ThemeChoice) => {
    saveThemeChoice(theme)
    ctx.themeChanged(theme)
  }),
  getAppInfo: hosted((ctx) => ctx.appInfo())
}
