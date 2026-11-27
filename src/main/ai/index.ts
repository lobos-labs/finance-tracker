import { configureAi } from './backend'
import { anthropicBackend } from './anthropic'
import { claudeCodeBackend } from './claudeCodeDev'
import { proxyBackend } from './proxy'

/** Registers the backends; called once at startup, after index.ts has told devBuild.ts which build this is. */
export function setupAi(): void {
  configureAi({ backends: { api: anthropicBackend, proxy: proxyBackend, 'claude-code': claudeCodeBackend } })
}
