import { setupTokenClaimUrl } from '../shared/checks'

// Claiming a SimpleFIN setup token: one POST to the claim URL inside it,
// answered with the access URL (Basic-auth credentials embedded). Every
// failure is one line for the wizard and the Accounts page. Free of Electron
// and the database, so the tests run it with a fake fetch; simplefin.ts keeps
// the access URL.

const CLAIM_TIMEOUT_MS = 30_000

export async function claimSetupToken(token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const claimUrl = setupTokenClaimUrl(token)
  if (!claimUrl) throw new Error('Not a setup token')
  let res: Response
  try {
    res = await fetchImpl(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS) })
  } catch {
    throw new Error("Can't reach the bridge")
  }
  // A bridge answers 403 for a token claimed before (or never issued); one the user didn't claim should be disabled at the bridge.
  if (res.status === 403) throw new Error('Token already used')
  if (!res.ok) throw new Error(`Bridge error ${res.status}`)
  let accessUrl: string
  try {
    accessUrl = (await res.text()).trim()
  } catch {
    throw new Error("Can't reach the bridge")
  }
  let u: URL | null = null
  try {
    u = new URL(accessUrl)
  } catch {
    u = null
  }
  if (!u || u.protocol !== 'https:' || !u.username) throw new Error('Bridge error: no access URL')
  return accessUrl
}
