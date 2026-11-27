import { ALLOW_DEV } from './build'

// Which kind of build is running, and the environment variables only a
// development build honors. A development build is an unpackaged one (npm run
// dev, npm start, the shortcut; the tests and the review's tool server run as
// one too), or a packaged one made with FINANCE_TRACKER_ALLOW_DEV=1 (build.ts)
// and run with FINANCE_TRACKER_DEV=1. Every other packaged build (the
// installer, the beta, the Store package) is a shipped build: it reads none
// of DEV_VARIABLES and drops them, with every ANTHROPIC_* variable the SDK
// would read, from its environment at startup (index.ts), so nothing it starts
// sees them either. No Electron here: index.ts hands in app.isPackaged.

/** The variables that move the data, redirect the traffic or change the plan: honored in a development build only. */
export const DEV_VARIABLES = [
  // the folders, and the claude stand-in
  'FINANCE_TRACKER_DATA_DIR',
  'FINANCE_TRACKER_DOCS_DIR',
  'FINANCE_TRACKER_BRIDGE_DIR',
  // the home folder Claude Desktop's connector writes its connection file and extension to (connector.ts)
  'FINANCE_TRACKER_HOME_DIR',
  'FINANCE_TRACKER_CLAUDE',
  // where requests go
  'FINANCE_TRACKER_ANTHROPIC_BASE_URL',
  'FINANCE_TRACKER_PROXY_URL',
  'FINANCE_TRACKER_RELAY_URL',
  'FINANCE_TRACKER_VIEWER_URL',
  'FINANCE_TRACKER_GOOGLE_AUTH',
  'FINANCE_TRACKER_GOOGLE_TOKEN',
  'FINANCE_TRACKER_GOOGLE_API',
  'FINANCE_TRACKER_GOOGLE_TASKS',
  // the plan
  'FINANCE_TRACKER_PLAN',
  // the dev server's page (index.ts and ipc.ts read it only unpackaged)
  'ELECTRON_RENDERER_URL'
] as const

export type DevVariable = (typeof DEV_VARIABLES)[number]

let packaged = false
let allowDev = ALLOW_DEV

/** At startup, app.isPackaged; in a test, the build to behave as (allowDev: built with FINANCE_TRACKER_ALLOW_DEV=1). */
export function configureBuild(o: { packaged: boolean; allowDev?: boolean }): void {
  packaged = o.packaged
  allowDev = o.allowDev ?? ALLOW_DEV
}

/** A development build: unpackaged, or packaged with the dev flag and run with FINANCE_TRACKER_DEV=1. */
export const devBuild = (): boolean => !packaged || (allowDev && process.env['FINANCE_TRACKER_DEV'] === '1')

/** The file bridge (no authentication) runs in a development build, or with FINANCE_TRACKER_BRIDGE=1 in a packaged one made with the dev flag. */
export const bridgeAllowed = (): boolean => devBuild() || (allowDev && process.env['FINANCE_TRACKER_BRIDGE'] === '1')

/** A development-only variable as this run has it; undefined when unset or empty, and always in a shipped build. */
export const devEnv = (name: DevVariable): string | undefined => (devBuild() ? process.env[name] || undefined : undefined)

/** Whether a shipped build drops the variable: one of DEV_VARIABLES, or any ANTHROPIC_* (the SDK reads a base URL, keys, headers and a log level from them). */
export const droppedInShippedBuild = (name: string): boolean => (DEV_VARIABLES as readonly string[]).includes(name.toUpperCase()) || /^ANTHROPIC_/i.test(name)

/** Removes those variables from `env` (index.ts: process.env, in a shipped build, before anything reads it). */
export function dropDevVariables(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) if (droppedInShippedBuild(k)) delete env[k]
}
