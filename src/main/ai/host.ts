import { AsyncLocalStorage } from 'node:async_hooks'
import type { AiBackend } from './backend'

// The AI's host. On the desktop that's this process: the backends registered
// at startup, the documents folder, and one copy of the AI's own state (a
// categorization run under way, Review's busy flag). A hosted ledger (a
// Durable Object in finance-server, several of which can share one isolate)
// runs its engine calls inside withAiHost with its own host: the service's
// backend, the account's uploads for documents, and its own copy of that
// state, so nothing the AI keeps between calls is seen by another ledger.

/** A document the host keeps for the AI (a hosted ledger's upload), by the name list_documents gives it. */
export interface HostDocument {
  name: string
  size: number
  /** unix seconds */
  addedAt: number
}

/** The host's documents, in place of the documents folder. */
export interface HostDocuments {
  list(): HostDocument[]
  /** A document's bytes, and the name it was stored under (its extension says what it is). Throws when there's none. */
  open(name: string): Promise<{ name: string; bytes: Uint8Array }>
}

export interface AiHost {
  /** the backend every AI call in this host's scope goes through */
  readonly backend: AiBackend
  readonly documents?: HostDocuments
}

const scope = new AsyncLocalStorage<AiHost>()

/** Runs `fn` with `host` as the AI's host. The host is also the key of its state (perLedger), so a ledger passes the same one every call. */
export const withAiHost = <T>(host: AiHost, fn: () => T): T => scope.run(host, fn)

/** The host in scope; undefined on the desktop. */
export const aiHost = (): AiHost | undefined => scope.getStore()

const DESKTOP = {}
const state = new WeakMap<object, Map<symbol, unknown>>()

/**
 * State the AI keeps between calls, one copy per host: `init` makes a
 * ledger's copy the first time it asks. The desktop has one copy.
 */
export function perLedger<T>(init: () => T): () => T {
  const id = Symbol()
  return () => {
    const owner = scope.getStore() ?? DESKTOP
    let bag = state.get(owner)
    if (!bag) state.set(owner, (bag = new Map()))
    if (!bag.has(id)) bag.set(id, init())
    return bag.get(id) as T
  }
}
