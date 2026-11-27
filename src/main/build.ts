// Switches fixed at build time (electron.vite.config.ts; npm run dist:beta
// sets them). A normal build leaves them empty and behaves as before. Where
// they don't exist (the tests, the browser demo's dump under plain Node, a
// Vite build without electron-vite's define) `typeof` finds no name, so each
// falls back to the normal build's value instead of throwing.

declare const __BETA_UNTIL__: string
declare const __DATA_DIR_NAME__: string
declare const __PROXY_URL__: string
declare const __RELAY_URL__: string
declare const __VIEWER_URL__: string
declare const __SUPPORT_EMAIL__: string
declare const __ALLOW_DEV__: string
declare const __EDITION__: string

/** The beta's last day (YYYY-MM-DD): a packaged build is Plus through it. Empty outside a beta build. */
export const BETA_UNTIL: string = typeof __BETA_UNTIL__ === 'string' ? __BETA_UNTIL__ : ''

/**
 * The data folder's name under the OS app-data folder. It's named here, not
 * after the product, so a later rename doesn't strand the data; changing it
 * needs a one-time move of the folder. A build with its own name (the beta)
 * never opens the default one.
 */
export const DATA_DIR_NAME: string = (typeof __DATA_DIR_NAME__ === 'string' && __DATA_DIR_NAME__) || 'Finance Tracker'

/** The hidden folder in the home directory (the old documents folder, the file bridge), named after the data folder: ".finance-tracker" by default. */
export const HOME_DIR_NAME = `.${DATA_DIR_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'finance-tracker'}`

/** The hosted service and license server (FINANCE_TRACKER_PROXY_URL when the app was built); empty when none was. */
export const BUILT_PROXY_URL: string = typeof __PROXY_URL__ === 'string' ? __PROXY_URL__ : ''

/** The phone's relay (FINANCE_TRACKER_RELAY_URL when the app was built); empty when none was. */
export const BUILT_RELAY_URL: string = typeof __RELAY_URL__ === 'string' ? __RELAY_URL__ : ''

/** The web viewer's address (FINANCE_TRACKER_VIEWER_URL when the app was built); empty when none was. */
export const BUILT_VIEWER_URL: string = typeof __VIEWER_URL__ === 'string' ? __VIEWER_URL__ : ''

/** Where Report emails an AI answer (FINANCE_TRACKER_SUPPORT_EMAIL when the app was built); empty when none was, and Report then only copies. */
export const SUPPORT_EMAIL: string = typeof __SUPPORT_EMAIL__ === 'string' ? __SUPPORT_EMAIL__ : ''

/**
 * Built with FINANCE_TRACKER_ALLOW_DEV=1: a packaged copy honors
 * FINANCE_TRACKER_DEV=1 and FINANCE_TRACKER_BRIDGE=1 when it runs (devBuild.ts),
 * for smoke runs of an installer build against scratch folders. Never set for
 * a build anyone installs; the beta, signed and Store scripts clear it.
 */
export const ALLOW_DEV: boolean = typeof __ALLOW_DEV__ === 'string' && __ALLOW_DEV__ === '1'

/** The edition (FINANCE_TRACKER_EDITION when the app was built): "open", or empty for every other build. */
export const EDITION: string = typeof __EDITION__ === 'string' ? __EDITION__ : ''

/**
 * The open edition, the free, open-source desktop build: every feature with
 * no license or trial (license.ts), SimpleFIN for the banks (bankFeed.ts) and
 * the AI on the user's own key. It never has the hosted service, so no Plaid
 * and no included AI.
 */
export const OPEN_EDITION: boolean = EDITION === 'open'

/**
 * What a run from source of the open edition adds to its folder names: it keeps its own data folder and its own
 * documents folder, so it never opens, upgrades or deletes the books of an installed copy. Empty for a packaged
 * build, and for every other edition's development build. FINANCE_TRACKER_DATA_DIR still points a run anywhere.
 */
export const sourceRunSuffix = (packaged: boolean, open: boolean = OPEN_EDITION): string => (!packaged && open ? ' Dev' : '')

/** The installer's app id (electron-builder.yml, or the beta's own), which Windows also shows notifications under as the AppUserModelID. */
export const APP_ID: string = BETA_UNTIL ? 'ai.loboslabs.financetracker.beta' : 'ai.loboslabs.financetracker'

/**
 * The AppUserModelID to run as: an installed app's is APP_ID, which its shortcuts carry. An unpackaged
 * build's shortcut (npm run shortcut) carries none, so it goes by its exe, as Windows names an app
 * without one; under APP_ID its notifications would be dropped, or shown as the installed app's.
 */
export const appUserModelId = (packaged: boolean, execPath: string): string => (packaged ? APP_ID : execPath)
