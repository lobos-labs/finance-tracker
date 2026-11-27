import { currentConnection } from './db'

// Engine state that belongs to one ledger, kept per connection rather than in
// a module variable: a Durable Object isolate can host several accounts'
// Ledgers at once, and what one of them holds (an import preview, a file
// check) must never answer another's request. A ledger wiped by deleteAll
// gets a new connection, so its state starts empty too. On the desktop the
// connection is the open file, and with none open (before the database opens,
// or in a tool process) the state is the process's own.

const byConnection = new WeakMap<object, Map<symbol, unknown>>()
const noLedger = {}

/** A getter for one piece of state, made by `init` the first time each ledger asks for it. */
export function ledgerState<T>(init: () => T): () => T {
  const key = Symbol('ledger state')
  return () => {
    const owner = currentConnection() ?? noLedger
    let slots = byConnection.get(owner)
    if (!slots) byConnection.set(owner, (slots = new Map()))
    if (!slots.has(key)) slots.set(key, init())
    return slots.get(key) as T
  }
}
