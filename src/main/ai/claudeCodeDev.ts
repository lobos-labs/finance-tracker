import { AiError, type AiBackend } from './backend'

// Claude Code mode is not in this edition (claudeCode.ts). ai/backend.ts never
// offers it in the open edition, so this backend is registered but never
// chosen, and each call refuses.

const NOT_HERE = 'Claude Code mode is not in this edition.'

export function claudeCodeBackend(): AiBackend {
  return {
    provider: 'claude-code',
    capabilities: { webSearch: false, documents: false },
    structured: async () => {
      throw new AiError('unavailable', NOT_HERE)
    },
    step: async () => {
      throw new AiError('unavailable', NOT_HERE)
    },
    status: async () => ({ ready: false, provider: 'claude-code', problem: NOT_HERE })
  }
}
