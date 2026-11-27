import * as db from '../db'
import { claudeCodeOffered, setAiEnabled } from '../ai/backend'
import { classify } from '../classifier'
import * as csv from '../csvImport'
import { clearDemoData, demoStatus, loadDemoData } from '../demo'
import { hasToken, planState } from '../license'
import * as statement from '../statementImport'
import { APP_NAME, DOC_FOLDERS } from '../../shared/app'
import type { AiSetup, ClassifyResult, CsvImportRequest, OnboardingState, StatementImportRequest } from '../../shared/types'
import { hosted, refreshed, type HandlerContext } from './context'
import { heldPreview } from './files'

// Categorizing, imports, first run and sample data. Picking a file to import
// is the desktop's (csvPick, ipc.ts); the web uploads one (importPreview,
// files.ts). Then both import the preview by its token here.

const DONE = 'onboarding.done'
const AI = 'onboarding.ai'

export const autoClassifyEnabled = (): boolean => db.getSetting('ai.autoClassify') !== '0'

/** Categorizes what needs it, telling the host's views how far it got; bucket rules run again after. `auto`: after an import or a sync (classifier.ts). */
export function runClassify(ctx: HandlerContext, redoAi = false, auto = false): Promise<ClassifyResult> {
  // New categories can change which transactions bucket rules take (they leave transfers alone).
  return classify({ redoAi, auto }, (p) => ctx.broadcast('classify:progress', p)).finally(() => {
    db.applyBucketRules()
    ctx.broadcast('data:changed')
  })
}

/** After an import: bucket rules, the views, and the new rows categorized like a sync's. */
async function imported<R extends { imported: number }>(ctx: HandlerContext, r: R): Promise<R & { classified: ClassifyResult | undefined }> {
  if (r.imported > 0) db.applyBucketRules()
  ctx.broadcast('data:changed')
  const classified = autoClassifyEnabled() && r.imported > 0 ? await runClassify(ctx, false, true) : undefined
  ctx.broadcast('data:bulk')
  return { ...r, classified }
}

function onboardingState(ctx: HandlerContext): OnboardingState {
  const accounts = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')?.n ?? 0
  let done = db.getSetting(DONE) === '1'
  // An install from before the wizard existed has nothing to set up.
  if (!done && accounts > 0) {
    db.setSetting(DONE, '1')
    done = true
  }
  const ai = db.getSetting(AI)
  const host = ctx.folders()
  return {
    needed: !done,
    appName: APP_NAME,
    dataDir: host.dataDir,
    docsDir: host.docsDir,
    docsDirLocked: host.docsDirLocked,
    folders: [...DOC_FOLDERS],
    extraDirs: host.extraDirs,
    accounts,
    ai: ai === 'trial' || ai === 'key' || ai === 'claude-code' || ai === 'none' || ai === 'later' ? ai : null,
    plan: planState(),
    demo: demoStatus(),
    recoveryPending: host.recoveryPending
  }
}

/**
 * Records the AI choice. Never calls a model: the key (if any) was checked by
 * checkApiKey and stored by setApiKey before this. The trial itself
 * was started by startTrial (license.ts): with a server token the AI runs
 * through the hosted service, without one the key route stays (rules and
 * history until a key is added). "Later" keeps the key route with no key, so
 * a fresh install never starts the Claude Code CLI unless that was chosen.
 * "No AI" turns the AI off (the AI switch under Settings → AI); every other choice on.
 */
function setupAi(mode: AiSetup): void {
  if (mode === 'trial') {
    if (!hasToken()) db.setSetting('ai.provider', 'api')
  } else if (mode === 'key' || mode === 'none' || mode === 'later') db.setSetting('ai.provider', 'api')
  else if (mode === 'claude-code') {
    if (!claudeCodeOffered()) throw new Error('Claude Code mode is for development builds')
    db.setSetting('ai.provider', 'claude-code')
  } else throw new Error('Unknown choice')
  setAiEnabled(mode !== 'none')
  db.setSetting(AI, mode)
}

export const dataHandlers = {
  classify: hosted(async (ctx, opts: { redoAi?: boolean }) => {
    // Asking again about everything Claude categorized rewrites those rows.
    if (opts?.redoAi) await ctx.backup()
    return runClassify(ctx, !!opts?.redoAi).finally(() => ctx.broadcast('data:bulk'))
  }),
  // The web's "sync now" (the desktop's Accounts page calls sync, ipc.ts, which runs the same).
  bankSync: hosted((ctx) => ctx.syncBanks()),
  // A hosted ledger may have restarted since the preview: heldPreview reads the upload again first.
  csvImport: hosted(async (ctx, req: CsvImportRequest) => {
    await heldPreview(ctx, req?.token)
    const r = csv.importCsv(req)
    ctx.previews?.drop(req.token)
    return imported(ctx, r)
  }),
  statementImport: hosted(async (ctx, req: StatementImportRequest) => {
    await heldPreview(ctx, req?.token)
    const r = statement.importStatement(req)
    ctx.previews?.drop(req.token)
    return imported(ctx, r)
  }),

  getOnboarding: hosted((ctx) => onboardingState(ctx)),
  setupAi: hosted((_c, mode: AiSetup) => setupAi(mode)),
  finishOnboarding: hosted((ctx) => {
    db.setSetting(DONE, '1')
    ctx.broadcast('data:changed')
  }),

  demoStatus: hosted(() => demoStatus()),
  loadDemoData: hosted((ctx) => refreshed(ctx, loadDemoData())),
  clearDemoData: hosted((ctx) => refreshed(ctx, clearDemoData()))
}
