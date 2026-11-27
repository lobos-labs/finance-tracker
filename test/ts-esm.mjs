// The package is CommonJS (Electron's main process), but the app's TypeScript
// is written as ES modules: load .ts files as such for the tests. The app's
// own imports leave off the extension (the bundler adds it), so try .ts.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      if (existsSync(`${fileURLToPath(new URL(specifier, context.parentURL))}.ts`)) return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return nextLoad(url, url.endsWith('.ts') ? { ...context, format: 'module-typescript' } : context)
  }
})
