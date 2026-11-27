import type { AccountPlan } from '../license'
import type { FeatureId } from '../../shared/plans'
import type { AppInfo, AppSettings, OnboardingState, SyncResult, ThemeChoice } from '../../shared/types'

// The handler table's shape: what a handler is (its run, whether the hosted
// ledger offers it, the plan feature it needs) and what it gets from the host
// that runs it, the Electron app (ipc.ts) or a Ledger Durable Object
// (finance-server/src/ledger). Nothing here or in the handler modules touches
// Electron; what only a host can do comes in through the HandlerContext.

export type Platform = 'desktop' | 'web'

/** A file uploaded to the account (POST /v1/ledger/files). */
export interface LedgerFile {
  fileId: string
  /** the name it was uploaded with */
  name: string
  /** its MIME type */
  type: string
  size: number
  bytes(): Promise<Uint8Array>
}

/**
 * Import previews a host keeps across a restart: the upload each preview's token was read from and
 * when. A Ledger keeps them in its storage, so a Durable Object evicted between the preview and the
 * import reads the file again (files.ts heldPreview); the desktop's process holds its own.
 */
export interface PreviewKeeper {
  keep(token: string, fileId: string, at: number): void
  find(token: string): { fileId: string; at: number } | null
  drop(token: string): void
}

/** What getSettings says that only the host knows: its keys and tokens, the bank feed it runs, its folders and database. */
export type HostSettings = Pick<AppSettings, 'licenseTokenSaved' | 'apiKeySource' | 'simplefinConnected' | 'bank' | 'lastSyncAt' | 'syncsLast24h' | 'historyFrom' | 'historyComplete' | 'syncWarnings' | 'dataPath' | 'database'>

/** What the first-run wizard shows of the host's folders and database. */
export type HostFolders = Pick<OnboardingState, 'dataDir' | 'docsDir' | 'docsDirLocked' | 'extraDirs' | 'recoveryPending'>

export interface HandlerContext {
  readonly platform: Platform
  /** the account's plan (hosted): handlers run with it in force (license.ts withPlan); the desktop reads its own license */
  readonly plan?: AccountPlan
  /**
   * the partner making this call, on a hosted ledger shared with one (docs/hosted-api.md, "Household"): their
   * own alert preferences; null or absent, the ledger's owner (the desktop always)
   */
  readonly member?: string | null
  /** tells every window, or every connected client: data:changed, data:bulk, classify:progress, review:update, notify */
  broadcast(event: string, payload?: unknown): void
  /** an uploaded file by its id; throws when the account has none by that id (the desktop has no uploads) */
  file(fileId: string): Promise<LedgerFile>
  /** where import previews outlive the process (a Ledger's storage); absent on the desktop */
  readonly previews?: PreviewKeeper
  /** asks for a file to open (the desktop's dialog); null when cancelled, or where nothing can ask */
  pickFile(o: { title: string; name: string; extensions: string[] }): Promise<string | null>
  /** before a rewrite of rows across the whole history: the desktop's bulk backup (a ledger's point-in-time recovery covers it) */
  backup(): Promise<void>
  /** Google Calendar and Tasks pick up a change to what they mirror (the desktop's Google sync) */
  calendarChanged(): void
  /** settles once no bank sync is running */
  syncIdle(): Promise<void>
  /** syncs the banks now: the desktop's own feed, or the account's Items in a Ledger */
  syncBanks(): Promise<SyncResult>
  /** the Review conversation was cleared (the desktop drops Claude Code's copy of it too) */
  reviewCleared(): void
  /** the theme was saved (the desktop's window follows it) */
  themeChanged(theme: ThemeChoice): void
  appInfo(): AppInfo
  settings(): HostSettings
  folders(): HostFolders
}

/** A handler: the context first, then the Api method's arguments as they came over the wire (unchecked). */
export type Run = (ctx: HandlerContext, ...args: never[]) => unknown

export interface HandlerDef {
  /** the hosted ledger offers it: false when it needs Electron, the local file system or the desktop's process */
  readonly hosted: boolean
  /** a plan feature checked before it runs (a refusal answers { ok: false, error: 'plan', feature }) */
  readonly feature?: FeatureId
  readonly run: Run
}

/** On every host, every plan. */
export const hosted = (run: Run): HandlerDef => ({ hosted: true, run })
/** On every host, with the plan feature it needs. */
export const plus = (feature: FeatureId, run: Run): HandlerDef => ({ hosted: true, feature, run })
/** The desktop only: the hosted ledger answers "Not available on the web". */
export const desktopOnly = (run: Run, feature?: FeatureId): HandlerDef => (feature ? { hosted: false, feature, run } : { hosted: false, run })

/** Tells every view to refresh, passing a handler's result through. */
export function changed<T>(ctx: HandlerContext, result: T): T {
  ctx.broadcast('data:changed')
  return result
}

/** data:changed and data:bulk: a change that reaches across many rows or pages. */
export function refreshed<T>(ctx: HandlerContext, result: T): T {
  ctx.broadcast('data:changed')
  ctx.broadcast('data:bulk')
  return result
}

export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
