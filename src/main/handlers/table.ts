import { PlanError, requireFeature, withPlan } from '../license'
import type { FeatureId } from '../../shared/plans'
import type { Api } from '../../shared/types'
import { accountHandlers } from './accounts'
import { alertHandlers } from './alerts'
import { benefitHandlers } from './benefits'
import { budgetHandlers } from './budget'
import { calendarHandlers } from './calendar'
import type { HandlerContext, HandlerDef } from './context'
import { dataHandlers } from './data'
import { fileHandlers } from './files'
import { moneyHandlers } from './money'
import { reviewHandlers } from './review'
import { settingsHandlers } from './settings'
import { transactionHandlers } from './transactions'

// The one handler table the Electron app (ipc.ts registers it with ipcMain)
// and a hosted Ledger (finance-server/src/ledger, POST /v1/ledger/rpc) both
// run, keyed by Api method name. Every Api method has exactly one home: here,
// among the desktop's own handlers that need Electron (DESKTOP_ONLY, in
// ipc.ts and ipc-*.ts), or in the preload (events and a dropped file's path).
// The types at the bottom fail the build when a method is missing or doubled.

export const HANDLERS = {
  ...moneyHandlers,
  ...transactionHandlers,
  ...accountHandlers,
  ...budgetHandlers,
  ...benefitHandlers,
  ...calendarHandlers,
  ...reviewHandlers,
  ...settingsHandlers,
  ...dataHandlers,
  ...fileHandlers,
  ...alertHandlers
} satisfies Record<string, HandlerDef>

export type TableMethod = keyof typeof HANDLERS

/** Methods only the desktop answers, registered with Electron by ipc.ts, ipc-*.ts and unlock.ts. */
export const DESKTOP_ONLY = [
  // opening files, folders and links; dialogs and the clipboard
  'openTaxForm',
  'openCreditReport',
  'openInsuranceFile',
  'openReceipt',
  'openDocumentsFolder',
  'openDataFolder',
  'openBackupsFolder',
  'openExternal',
  'exportCalendar',
  'csvPick',
  'exportCsv',
  'exportAll',
  // moving the books into a hosted account (moveToAccount.ts, development builds)
  'moveAccountStatus',
  'moveAccountSendCode',
  'moveAccountFinish',
  'copyAiRequest',
  'copyAiReport',
  'emailAiReport',
  'copyDiagnostics',
  // Google Calendar and Tasks (the desktop's sign-in and sync)
  'googleStatus',
  'googleSetCredentials',
  'googleConnect',
  'googleDisconnect',
  'googleSync',
  'googleSetTasks',
  // the desktop's API key and Claude Code mode
  'setApiKey',
  'clearApiKey',
  'checkApiKey',
  'claudeCodeStatus',
  'claudeCodeSignIn',
  // Claude Desktop's connector, a pipe in the running app (connector.ts; the open edition and a development build)
  'connectorStatus',
  'setConnector',
  'installConnector',
  'undoConnectorChange',
  // the desktop's own bank sync (hosted banks are /v1/bank and the Ledger's)
  'bankConnect',
  'bankReconnect',
  'bankCancel',
  'bankDisconnect',
  'simplefinConnect',
  'simplefinDisconnect',
  'sync',
  // the data folder, local backups, the database key and its recovery code, the updater
  'deleteAllData',
  'backupNow',
  'restoreBackup',
  'restoreBackupCode',
  'newRecoveryCode',
  'printRecoveryCode',
  'confirmRecoveryCode',
  'checkRecoveryCode',
  'protectWindow',
  'setDbEncryption',
  'unlockDatabase',
  'checkForUpdates',
  // the documents folder and the folders it may read (ipc-setup.ts)
  'setDocumentsDir',
  'openDocumentFolder',
  'addDocumentFolder',
  'removeDocumentFolder',
  'importDocuments',
  // the phone and web viewer paired through the relay (ipc-sync.ts)
  'getSyncStatus',
  'listSyncDevices',
  'removeSyncDevice',
  'resetSync',
  'setRelayUrl',
  'setViewerUrl',
  'startPairing',
  'copySyncPairing',
  'approveSyncDevice',
  'syncNow',
  // desktop notifications, the tray and open at login (ipc-alerts.ts)
  'getNotificationSettings',
  'setNotificationSettings',
  'setNumbersHidden'
] as const satisfies readonly (keyof Api)[]

/** Answered by the preload itself: the events, and a dropped file's path. Never a call. */
export const PRELOAD_ONLY = ['pathForFile', 'onClassifyProgress', 'onDataChanged', 'onBulkChange', 'onReviewUpdate', 'onNotify', 'onOpenPage'] as const satisfies readonly (keyof Api)[]

type DesktopMethod = (typeof DESKTOP_ONLY)[number]
type Homed = TableMethod | DesktopMethod | (typeof PRELOAD_ONLY)[number]

/** true, or the Api methods with no handler anywhere. */
export const EVERY_METHOD_HANDLED: [Exclude<keyof Api, Homed>] extends [never] ? true : Exclude<keyof Api, Homed> = true
/** true, or the names handled that the Api doesn't have. */
export const NO_STRAY_HANDLERS: [Exclude<TableMethod, keyof Api>] extends [never] ? true : Exclude<TableMethod, keyof Api> = true
/** true, or the methods both the table and the desktop's own handlers answer. */
export const ONE_HOME_EACH: [Extract<TableMethod, DesktopMethod>] extends [never] ? true : Extract<TableMethod, DesktopMethod> = true

const desktopOnly = new Set<string>(DESKTOP_ONLY)

/** The table's entry for a method name; nothing for a name it doesn't hold (inherited names like "constructor" included). */
export function handlerFor(method: string): HandlerDef | undefined {
  return Object.hasOwn(HANDLERS, method) ? (HANDLERS as Record<string, HandlerDef>)[method] : undefined
}

/** Where a method runs: on both hosts, on the desktop only, or nowhere (not an Api call). */
export function methodKind(method: string): 'hosted' | 'desktop' | null {
  const def = handlerFor(method)
  if (def) return def.hosted ? 'hosted' : 'desktop'
  return desktopOnly.has(method) ? 'desktop' : null
}

/** Runs a handler after its plan check (a refusal throws PlanError). */
export function callHandler(def: HandlerDef, ctx: HandlerContext, args: unknown[]): unknown {
  if (def.feature) requireFeature(def.feature)
  return (def.run as (ctx: HandlerContext, ...a: unknown[]) => unknown)(ctx, ...args)
}

/** The desktop's IPC envelope: a refusal by the plan says which feature, anything else its message. */
export type Envelope = { ok: true; data: unknown } | { ok: false; error: string; feature?: FeatureId }

export const NOT_ON_WEB = 'Not available on the web'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * A hosted call: the method, run with the account's plan in force, answered as the desktop's IPC answers
 * (ipc.ts). A desktop-only method is refused; the caller has already turned away names that aren't methods.
 */
export async function answer(method: string, args: unknown[], ctx: HandlerContext): Promise<Envelope> {
  const def = handlerFor(method)
  if (!def || (ctx.platform === 'web' && !def.hosted)) return { ok: false, error: NOT_ON_WEB }
  const run = async (): Promise<Envelope> => {
    try {
      return { ok: true, data: await callHandler(def, ctx, args) }
    } catch (err) {
      if (err instanceof PlanError) return { ok: false, error: 'plan', feature: err.feature }
      return { ok: false, error: message(err) }
    }
  }
  return ctx.plan ? withPlan(ctx.plan, run) : run()
}
