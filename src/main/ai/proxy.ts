import { AiError, type AiBackend } from './backend'

// The included AI runs through the hosted service, which this edition does not
// have. ai/backend.ts offers it only when there is a server, so this backend is
// registered but never chosen, and each call refuses.

const NOT_HERE = 'There is no hosted service in this edition.'

export const proxyBackend = (): AiBackend => ({
  provider: 'proxy',
  capabilities: { webSearch: false, documents: false },
  structured: async () => {
    throw new AiError('unavailable', NOT_HERE)
  },
  step: async () => {
    throw new AiError('unavailable', NOT_HERE)
  },
  status: async () => ({ ready: false, provider: 'proxy', problem: NOT_HERE })
})
