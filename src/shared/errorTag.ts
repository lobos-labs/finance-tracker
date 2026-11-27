/**
 * How a failed call is named in the log, as " (kind)": its kind (an AI or a license error), its code (Node, SQLite)
 * or its class when that is not plain Error, each only when it is a short identifier. Never its message: that can
 * name what the call was about (an account, an asset, a payee) or carry the model's own words about it.
 */
export function errorTag(err: unknown): string {
  const e = err !== null && typeof err === 'object' ? (err as { kind?: unknown; code?: unknown; name?: unknown }) : null
  const tag = typeof e?.kind === 'string' ? e.kind : typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' && e.name !== 'Error' ? e.name : ''
  return /^[A-Za-z0-9_]{1,40}$/.test(tag) ? ` (${tag})` : ''
}
