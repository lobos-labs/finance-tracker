import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { updateFeedProblem } from './src/main/updateFeed'

// The dev server injects an inline React Fast Refresh script and talks over a
// WebSocket; allow both only while developing so the built app keeps a strict CSP.
const devCsp: Plugin = {
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws://localhost:*")
}

// npm run dist compiles the main process to V8 bytecode (not the preload,
// which keeps its sandbox, nor the renderer); npm run build and the shortcut
// stay plain JavaScript.
const dist = /^dist(:|$)/.test(process.env['npm_lifecycle_event'] ?? '')

// A beta build (npm run dist:beta, scripts/dist-beta.cjs) fixes its last day
// and its own data folder here; both empty is a normal build (src/main/build.ts).
const isDay = (s: string): boolean => {
  const t = Date.parse(`${s}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(t) && new Date(t).toISOString().startsWith(s)
}
const betaUntil = process.env['FINANCE_TRACKER_BETA_UNTIL'] ?? ''
if (betaUntil && !isDay(betaUntil)) throw new Error(`FINANCE_TRACKER_BETA_UNTIL must be a day as YYYY-MM-DD, not "${betaUntil}"`)
const dataDirName = process.env['FINANCE_TRACKER_DATA_DIR_NAME'] ?? ''
if (dataDirName && (!/[A-Za-z0-9]/.test(dataDirName) || /[\\/:*?"<>|]/.test(dataDirName) || dataDirName !== dataDirName.trim())) throw new Error(`FINANCE_TRACKER_DATA_DIR_NAME must be a plain folder name, not "${dataDirName}"`)
// Where Report emails an AI answer; empty hides its Email button (src/shared/aiReport.ts checks the same shape).
const supportEmail = (process.env['FINANCE_TRACKER_SUPPORT_EMAIL'] ?? '').trim()
if (supportEmail && !/^[^\s@<>()[\]\\,;:"?&#%]+@[^\s@<>()[\]\\,;:"?&#%]+\.[A-Za-z]{2,}$/.test(supportEmail)) throw new Error(`FINANCE_TRACKER_SUPPORT_EMAIL must be a plain email address, not "${supportEmail}"`)
// The hosted service and license server: the only one a packaged build uses (src/main/license.ts).
const proxyUrl = (process.env['FINANCE_TRACKER_PROXY_URL'] ?? '').trim()
const isServer = (s: string): boolean => {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  } catch {
    return false
  }
}
if (proxyUrl && !isServer(proxyUrl)) throw new Error(`FINANCE_TRACKER_PROXY_URL must be an https address (or http to this computer), not "${proxyUrl}"`)
// A packaged build honors FINANCE_TRACKER_DEV and FINANCE_TRACKER_BRIDGE only when built with this (src/main/devBuild.ts).
const allowDev = process.env['FINANCE_TRACKER_ALLOW_DEV'] ?? ''
if (allowDev !== '' && allowDev !== '1') throw new Error(`FINANCE_TRACKER_ALLOW_DEV must be 1 or empty, not "${allowDev}"`)
if (allowDev) console.warn('\nFINANCE_TRACKER_ALLOW_DEV=1: a packaged copy of this build honors FINANCE_TRACKER_DEV and FINANCE_TRACKER_BRIDGE. Never give it to anyone.\n')
// The open edition: every feature, no license, SimpleFIN for the banks (src/main/build.ts). It never has the hosted service.
// This source builds only the open edition, so the switch defaults to it (empty or blank is open).
const edition = (process.env['FINANCE_TRACKER_EDITION'] ?? '').trim() || 'open'
if (edition !== 'open') throw new Error(`This source builds only the open edition: FINANCE_TRACKER_EDITION must be open or empty, not "${edition}"`)
if (edition === 'open' && proxyUrl) throw new Error('FINANCE_TRACKER_EDITION=open has no hosted service; leave FINANCE_TRACKER_PROXY_URL empty')
// The open edition updates only from its GitHub releases; another feed, such as the paid build's, would update it into that build (same app id, same data folder).
const updateUrl = process.env['FINANCE_TRACKER_UPDATE_URL'] ?? ''
const feedProblem = updateFeedProblem(edition, updateUrl)
if (feedProblem) throw new Error(feedProblem)

export default defineConfig({
  main: {
    // The update feed is fixed at build time; empty means the app never checks.
    // The hosted service, the phone's relay and the web viewer too: a packaged
    // build uses these and nothing else (empty: no hosted service, the hosted
    // service's server as the relay, no viewer). A development build's
    // variables and settings come before them.
    define: {
      __UPDATE_URL__: JSON.stringify(updateUrl),
      // A Mac build signed with a Developer ID can install its updates itself; any other Mac build only says one is out.
      __MAC_SELF_UPDATE__: JSON.stringify(process.env['FINANCE_TRACKER_MAC_SELF_UPDATE'] === '1' ? '1' : ''),
      __BETA_UNTIL__: JSON.stringify(betaUntil),
      __DATA_DIR_NAME__: JSON.stringify(dataDirName),
      __PROXY_URL__: JSON.stringify(proxyUrl),
      __RELAY_URL__: JSON.stringify((process.env['FINANCE_TRACKER_RELAY_URL'] ?? '').trim()),
      __VIEWER_URL__: JSON.stringify((process.env['FINANCE_TRACKER_VIEWER_URL'] ?? '').trim()),
      __SUPPORT_EMAIL__: JSON.stringify(supportEmail),
      __ALLOW_DEV__: JSON.stringify(allowDev),
      __EDITION__: JSON.stringify(edition)
    },
    build: {
      bytecode: dist,
      // The SQLite driver (better-sqlite3-multiple-ciphers) is a dependency, so it stays external: loaded from node_modules (app.asar.unpacked once packaged).
      rollupOptions: {
        // mcp-server.js is the review's tool server, started by Claude Code.
        input: { index: 'src/main/index.ts', 'mcp-server': 'src/main/mcp-server.ts' }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react(), devCsp]
  }
})
