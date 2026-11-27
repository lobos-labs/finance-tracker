// For test/update-notice-*.test.ts: lets the real src/main/updater.ts and src/main/background.ts run under
// plain Node. Electron and electron-updater resolve to the stand-ins beside this file, and so do the
// database-backed modules background.ts imports (alerts, the login item, the build's facts, the bank feed).
// The rules they call (updateFeed.ts), the log (log.ts) and the app's name are the real ones.
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const standIn = (name) => pathToFileURL(join(here, name)).href
const BACKGROUND = /\/src\/main\/background\.ts$/
const FOR_BACKGROUND = { './alerts': 'alerts.mjs', './ipc-alerts': 'misc.mjs', './build': 'misc.mjs', './bankFeed': 'misc.mjs', './simplefin': 'misc.mjs' }

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: standIn('electron.mjs'), shortCircuit: true }
    if (specifier === 'electron-updater') return { url: standIn('electron-updater.mjs'), shortCircuit: true }
    if (context.parentURL && BACKGROUND.test(context.parentURL) && FOR_BACKGROUND[specifier]) return { url: standIn(FOR_BACKGROUND[specifier]), shortCircuit: true }
    return nextResolve(specifier, context)
  }
})
