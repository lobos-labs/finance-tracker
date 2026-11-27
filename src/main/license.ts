import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createPublicKey, randomBytes, verify as edVerify, type KeyObject } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { BUILT_PROXY_URL, OPEN_EDITION } from './build'
import * as db from './db'
import { betaEndsAt, daysLeft, FEATURES, featureLabel, hasFeature, planState as localPlanState, TRIAL_DAYS, type FeatureId, type Plan } from '../shared/plans'

// The plan in force, and the license behind it. An entitlement token from
// the server (finance-server/README.md, "Entitlement token") is a JWT signed
// with Ed25519 that the app verifies offline with the public key below; it
// lives in the OS-encrypted secrets. Without a token a packaged beta build is
// Plus through the beta's last day, then the local trial date decides; a
// development build is Plus unless FINANCE_TRACKER_PLAN says otherwise. Only
// a development build reads FINANCE_TRACKER_PLAN and FINANCE_TRACKER_PROXY_URL
// (devBuild.ts); a shipped one runs on its license and its built-in server.
// Nothing here touches Electron: the secrets store, the platform, the beta's
// date and fetch are handed in by configureLicense (index.ts), so tests run
// plain. A hosted ledger has no token: the account's plan is set for the
// request's scope (withPlan), and planState and can read it instead. The open
// edition (FINANCE_TRACKER_EDITION=open, build.ts) is Plus by the build: no
// token, trial, beta or FINANCE_TRACKER_PLAN changes that, and it never calls
// the license server.

/**
 * Placeholder key pair generated for development; the private half is kept
 * outside the repo. The server's real public key (`npm run keygen` there)
 * replaces this constant before a release of the paid edition. The open
 * edition never checks a token, so it never uses this key.
 */
export const LICENSE_PUBLIC_KEY = 'kXX6rGeoUNneG93TuZFZfN_MomvUdSsPOa1V-cPhImo'

const DAY = 86_400_000
/** How long a server answer is trusted before the token is refreshed online. */
const REFRESH_AFTER_MS = DAY
const TRIAL_STARTED = 'plan.trialStartedAt'
const MACHINE_SALT = 'license.machineSalt'
const CHECKED_AT = 'license.checkedAt'

// ---------- wiring ----------

export interface SecretStore {
  read(): string | null
  write(value: string): void
  clear(): void
}

const memory = (): SecretStore => {
  let v: string | null = null
  return { read: () => v, write: (x) => void (v = x), clear: () => void (v = null) }
}

interface LicenseConfig {
  publicKey: string
  /** a development build (devBuild.ts): Plus without a token, and FINANCE_TRACKER_PLAN, FINANCE_TRACKER_PROXY_URL and the ai.proxyUrl setting count */
  dev: boolean
  /** the server built in (FINANCE_TRACKER_PROXY_URL when the app was built, build.ts); empty when none was */
  proxyUrl: string
  /** a packaged beta build: its last day (YYYY-MM-DD), Plus through it without a token; empty otherwise */
  betaUntil: string
  platform: string
  token: SecretStore
  key: SecretStore
  /** this computer's Free token for the bank routes, used while no license or trial token is */
  freeToken: SecretStore
  /** the open edition (OPEN_EDITION, build.ts): Plus with no license, and no call to the license server */
  openEdition: boolean
  fetch: typeof fetch
}

const cfg: LicenseConfig = { publicKey: LICENSE_PUBLIC_KEY, dev: false, proxyUrl: BUILT_PROXY_URL, betaUntil: '', platform: process.platform, token: memory(), key: memory(), freeToken: memory(), openEdition: OPEN_EDITION, fetch: (...a) => fetch(...a) }

/** Wires the module up at startup (secrets, build) or in a test (its own key pair and server). */
export function configureLicense(o: Partial<LicenseConfig>): void {
  Object.assign(cfg, o)
  cache = null
}

/** Whether this is the open edition: the build's switch, or what a test configured. */
export const openEdition = (): boolean => cfg.openEdition

/**
 * The server the AI proxy and the license calls go to, when there is one: the
 * one built in; a development build's FINANCE_TRACKER_PROXY_URL or ai.proxyUrl
 * setting before it. Nothing in Settings sets the address, so a shipped build
 * never takes it from anywhere but the build. The open edition has none, even
 * in a development run with a server configured.
 */
export function serverUrl(): string | null {
  if (cfg.openEdition) return null
  const url = (cfg.dev ? process.env['FINANCE_TRACKER_PROXY_URL'] || db.getSetting('ai.proxyUrl') : null) || cfg.proxyUrl || null
  return url ? url.replace(/\/+$/, '').replace(/\/v1$/, '') : null
}

// ---------- the machine ----------

/** A stable id for this install: the computer, the user and a random salt made once, hashed together. */
export function machineId(): string {
  let salt = db.getSetting(MACHINE_SALT)
  if (!salt) {
    salt = randomBytes(16).toString('hex')
    db.setSetting(MACHINE_SALT, salt)
  }
  let user = ''
  try {
    user = userInfo().username
  } catch {
    user = process.env['USERNAME'] ?? process.env['USER'] ?? ''
  }
  return createHash('sha256').update(`${hostname()}|${user}|${salt}`).digest('hex').slice(0, 32)
}

// ---------- the token ----------

export interface Entitlement {
  iss: string
  /** sha256 hex of the license key; "trial:" + sha256 hex of the machine id for a trial */
  sub: string
  aud: 'desktop'
  iat: number
  exp: number
  plan: 'plus' | 'trial'
  /** feature names in the server's wire format (Feature.wire) */
  features: string[]
  paidThrough: string
  /** features stay on this many days past paidThrough (0 for a trial) */
  graceDays: number
  machineId: string
  platform: string
  trialStartedAt?: string
  trialEndsAt?: string
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid'

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

const keyObject = (publicKey: string): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads and checks a token's claims and signature, then the server's time checks (exp, iat). */
export function verifyEntitlement(token: string, now: number = Date.now(), publicKey = cfg.publicKey): { ok: true; claims: Entitlement } | { ok: false; reason: VerifyFailure } {
  const v = readSigned(token, publicKey)
  if (!v.ok) return v
  const t = now / 1000
  if (v.claims.exp <= t) return { ok: false, reason: 'expired' }
  if (v.claims.iat > t + 300) return { ok: false, reason: 'not_yet_valid' }
  return v
}

/**
 * The claims of a well-formed token signed by the key, whatever the time says
 * (a token past exp may still be in its grace). A Free token (no features; the
 * bank routes take it) reads only where `free` says so, so it can never stand
 * in for a license.
 */
function readSigned(token: string, publicKey: string, free = false): { ok: true; claims: Entitlement } | { ok: false; reason: 'malformed' | 'bad_signature' } {
  const parts = token.trim().split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, p, s] = parts
  let header: unknown
  let claims: unknown
  try {
    header = JSON.parse(b64url(h).toString('utf8'))
    claims = JSON.parse(b64url(p).toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!isRecord(header) || header.alg !== 'EdDSA') return { ok: false, reason: 'malformed' }
  if (!isRecord(claims) || typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return { ok: false, reason: 'malformed' }
  if (claims.aud !== 'desktop' || (claims.plan !== 'plus' && claims.plan !== 'trial' && !(free && claims.plan === 'free')) || !Array.isArray(claims.features)) return { ok: false, reason: 'malformed' }
  if (typeof claims.paidThrough !== 'string' || typeof claims.graceDays !== 'number' || typeof claims.machineId !== 'string') return { ok: false, reason: 'malformed' }
  if (claims.plan === 'trial' && (typeof claims.trialStartedAt !== 'string' || typeof claims.trialEndsAt !== 'string')) return { ok: false, reason: 'malformed' }
  let good = false
  try {
    good = edVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), keyObject(publicKey), b64url(s))
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'bad_signature' }
  return { ok: true, claims: claims as unknown as Entitlement }
}

/** What a held token says at `now`: good for the proxy while now < exp; features on while now < paidThrough + graceDays. */
export interface TokenState {
  claims: Entitlement
  /** the proxy still takes it (not past exp) */
  usable: boolean
  /** paid features stay on (paidThrough plus the grace days) */
  entitled: boolean
  graceUntil: number
}

/** The token's state, or null when it can't be read, isn't signed by the key, or was issued to another machine. */
export function tokenState(token: string, now: number = Date.now(), publicKey = cfg.publicKey): TokenState | null {
  const v = readSigned(token, publicKey)
  if (!v.ok) return null
  const claims = v.claims
  if (claims.machineId !== machineId()) return null
  const paid = Date.parse(claims.paidThrough)
  if (!Number.isFinite(paid)) return null
  const graceUntil = paid + Math.max(0, claims.graceDays) * DAY
  return { claims, usable: now < claims.exp * 1000, entitled: now < graceUntil, graceUntil }
}

// The verified claims of the stored token, so the secret isn't decrypted and the signature checked on every call.
let cache: { raw: string | null; claims: Entitlement | null } | null = null

function storedClaims(): Entitlement | null {
  const raw = cfg.token.read()
  if (cache && cache.raw === raw) return cache.claims
  const v = raw ? readSigned(raw, cfg.publicKey) : null
  const claims = v?.ok && v.claims.machineId === machineId() ? v.claims : null
  cache = { raw, claims }
  return claims
}

/** The stored token's state at `now`, or null when there is none worth anything. */
export function currentToken(now: number = Date.now()): TokenState | null {
  const claims = storedClaims()
  if (!claims) return null
  const paid = Date.parse(claims.paidThrough)
  if (!Number.isFinite(paid)) return null
  const graceUntil = paid + Math.max(0, claims.graceDays) * DAY
  return { claims, usable: now < claims.exp * 1000, entitled: now < graceUntil, graceUntil }
}

/** Stores a token after checking it (a paste in Settings, or a server answer). */
export function importToken(raw: string): TokenState {
  const t = raw.trim()
  const v = verifyEntitlement(t, Date.now())
  if (!v.ok) throw new LicenseError(v.reason === 'bad_signature' ? 'auth' : v.reason === 'expired' ? 'expired' : 'auth', v.reason === 'expired' ? 'That license token has expired.' : 'That isn\'t a license token for this app.')
  const st = tokenState(t)
  if (!st) throw new LicenseError('auth', 'That license token was issued to another computer.')
  cfg.token.write(t)
  cache = null
  return st
}

export function clearToken(): void {
  cfg.token.clear()
  cfg.key.clear()
  cache = null
}

export const hasToken = (): boolean => storedClaims() !== null

// ---------- the plan ----------

export interface PlanInfo {
  plan: Plan
  trialDaysLeft: number
  trialEndsAt: string | null
  /** a trial was started on this install (so it isn't offered again) */
  trialStarted: boolean
  /** a license token is held and still entitles (a trial token counts) */
  licensed: boolean
  /** a Plus license: paid through, and the day the grace runs out */
  paidThrough: string | null
  graceUntil: string | null
  machineId: string
  /** a server is set to activate with and run the included AI */
  serverAvailable: boolean
  /** Plus by the development build, not by a license */
  dev: boolean
  /** Plus by the beta, not by a license: a packaged beta build before its end */
  beta: boolean
  /** the beta's last day (YYYY-MM-DD) while it's in force */
  betaUntil: string | null
  /** the free, open-source desktop build: everything included, no license */
  openEdition: boolean
}

// ---------- the account's plan (a hosted ledger) ----------

/** The plan an account holds, as the server's sign-in knows it. */
export interface AccountPlan {
  plan: Plan
  /** feature names in the server's wire format (Feature.wire); absent: every feature of the plan */
  features?: string[]
  trialEndsAt?: string | null
  plusUntil?: string | null
}

const planScope = new AsyncLocalStorage<AccountPlan>()

/** Runs `fn` with the account's plan in force, in place of this install's license (a hosted ledger's request). */
export function withPlan<T>(plan: AccountPlan, fn: () => T): T {
  return planScope.run(plan, fn)
}

/** The account's plan as PlanInfo: no machine, token, beta or development build behind it. */
function accountPlanState(a: AccountPlan, now: number): PlanInfo {
  const trialEnd = a.trialEndsAt ? Date.parse(a.trialEndsAt) : NaN
  const trialEndsAt = Number.isFinite(trialEnd) ? new Date(trialEnd).toISOString() : null
  return {
    plan: a.plan,
    trialDaysLeft: a.plan === 'trial' ? (trialEndsAt ? daysLeft(trialEnd, now) : TRIAL_DAYS) : 0,
    trialEndsAt,
    trialStarted: a.plan === 'trial' || trialEndsAt !== null,
    licensed: a.plan !== 'free',
    paidThrough: a.plan === 'plus' ? (a.plusUntil ?? null) : null,
    graceUntil: null,
    machineId: '',
    serverAvailable: true,
    dev: false,
    beta: false,
    betaUntil: null,
    openEdition: false
  }
}

/** The open edition's plan: Plus by the build, with no license, trial, beta or machine behind it. */
function openPlanState(): PlanInfo {
  return {
    plan: 'plus',
    trialDaysLeft: 0,
    trialEndsAt: null,
    trialStarted: false,
    licensed: false,
    paidThrough: null,
    graceUntil: null,
    machineId: '',
    serverAvailable: serverUrl() !== null,
    dev: false,
    beta: false,
    betaUntil: null,
    openEdition: true
  }
}

/** How a development build is run for testing: FINANCE_TRACKER_PLAN=free or trial turns its built-in Plus off. A shipped build never reads it. */
const forcedPlan = (): 'free' | 'trial' | null => {
  if (!cfg.dev) return null
  const v = process.env['FINANCE_TRACKER_PLAN']
  return v === 'free' || v === 'trial' ? v : null
}

/**
 * The plan in force: the open edition is Plus, whatever else is set; a
 * development build is Plus (unless FINANCE_TRACKER_PLAN says free or trial);
 * else a held token decides; else a beta build is Plus through the beta's last
 * day (in a development build FINANCE_TRACKER_PLAN turns that off too); else
 * the local trial while it has days left; else free. In a hosted ledger's
 * request, the account's plan (withPlan) and nothing else.
 */
export function planState(now: number = Date.now()): PlanInfo {
  const account = planScope.getStore()
  if (account) return accountPlanState(account, now)
  if (cfg.openEdition) return openPlanState()
  const forced = forcedPlan()
  const local = localPlanState({ trialStartedAt: db.getSetting(TRIAL_STARTED), plusUntil: db.getSetting('plan.plusUntil') }, now)
  const tok = currentToken(now)
  const betaEnd = betaEndsAt(cfg.betaUntil)
  const base: Omit<PlanInfo, 'plan' | 'trialDaysLeft' | 'trialEndsAt'> = {
    trialStarted: !!db.getSetting(TRIAL_STARTED),
    licensed: !!tok?.entitled,
    paidThrough: tok?.claims.plan === 'plus' ? tok.claims.paidThrough : null,
    graceUntil: tok?.claims.plan === 'plus' ? new Date(tok.graceUntil).toISOString() : null,
    machineId: machineId(),
    serverAvailable: serverUrl() !== null,
    dev: cfg.dev && !forced,
    beta: false,
    betaUntil: null,
    openEdition: false
  }
  if (cfg.dev && !forced) return { ...base, plan: 'plus', trialDaysLeft: local.trialDaysLeft, trialEndsAt: local.trialEndsAt }
  if (tok?.entitled) {
    if (tok.claims.plan === 'trial') {
      const end = Date.parse(tok.claims.trialEndsAt!)
      return { ...base, plan: 'trial', trialDaysLeft: daysLeft(end, now), trialEndsAt: new Date(end).toISOString() }
    }
    return { ...base, plan: 'plus', trialDaysLeft: local.trialDaysLeft, trialEndsAt: local.trialEndsAt }
  }
  if (!forced && betaEnd !== null && now < betaEnd) return { ...base, plan: 'plus', beta: true, betaUntil: cfg.betaUntil, trialDaysLeft: local.trialDaysLeft, trialEndsAt: local.trialEndsAt }
  if (local.plan !== 'free') return { ...base, ...local }
  if (forced === 'trial') return { ...base, plan: 'trial', trialDaysLeft: TRIAL_DAYS, trialEndsAt: new Date(now + TRIAL_DAYS * DAY).toISOString() }
  return { ...base, ...local, plan: 'free' }
}

/**
 * Whether the plan in force includes a feature (a token may name fewer features than its plan).
 * A name in the token the app doesn't know, like unlimited_accounts from before every plan held
 * any number of accounts, unlocks nothing and is left alone. A development build and the open
 * edition have every feature, a token or not.
 */
export function can(id: FeatureId, now: number = Date.now()): boolean {
  const account = planScope.getStore()
  if (account) {
    if (!hasFeature(account.plan, id)) return false
    const wire = FEATURES.find((f) => f.id === id)?.wire
    return !account.features || !wire || account.features.includes(wire)
  }
  const p = planState(now)
  if (!hasFeature(p.plan, id)) return false
  if (p.dev || p.openEdition) return true
  const tok = currentToken(now)
  if (tok?.entitled) {
    const wire = FEATURES.find((f) => f.id === id)?.wire
    return !wire || tok.claims.features.includes(wire)
  }
  return true
}

/** A call that needs a plan the install doesn't have; the IPC layer answers it as {ok:false, error:'plan'}. */
export class PlanError extends Error {
  feature: FeatureId
  constructor(feature: FeatureId) {
    super(`Plus: ${featureLabel(feature)}`)
    this.feature = feature
  }
}

export function requireFeature(id: FeatureId): void {
  if (!can(id)) throw new PlanError(id)
}

// ---------- the server ----------

export type LicenseErrorKind = 'auth' | 'offline' | 'server' | 'limit' | 'trial_over' | 'expired' | 'unavailable'

export class LicenseError extends Error {
  kind: LicenseErrorKind
  fatal = true
  constructor(kind: LicenseErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

interface ServerAnswer {
  status: number
  body: Record<string, unknown>
}

async function post(path: string, body: Record<string, unknown>): Promise<ServerAnswer> {
  const base = serverUrl()
  if (!base) throw new LicenseError('unavailable', 'No license server is set up.')
  let res: Response
  try {
    res = await cfg.fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new LicenseError('offline', 'The license server can\'t be reached.')
  }
  let parsed: unknown = {}
  try {
    parsed = await res.json()
  } catch {
    parsed = {}
  }
  return { status: res.status, body: isRecord(parsed) ? parsed : {} }
}

/** A server refusal as a LicenseError with a plain sentence. */
function refusal(r: ServerAnswer): LicenseError {
  const code = String(r.body.kind ?? r.body.error ?? '')
  if (code === 'trial_over') return Object.assign(new LicenseError('trial_over', 'The trial on this computer has ended.'), { trialStartedAt: String(r.body.trialStartedAt ?? ''), trialEndsAt: String(r.body.trialEndsAt ?? '') })
  if (code === 'activation_limit') return new LicenseError('limit', `That key is already active on ${String(r.body.limit ?? 3)} computers.`)
  if (code === 'invalid_key') return new LicenseError('auth', 'That license key isn\'t valid.')
  if (code === 'license_revoked') return new LicenseError('auth', 'That license was revoked.')
  if (code === 'subscription_ended') return new LicenseError('expired', 'That subscription has ended.')
  if (code === 'not_activated') return new LicenseError('auth', 'This computer isn\'t activated with that key.')
  if (r.status >= 500) return new LicenseError('server', `The license server failed (${r.status}).`)
  if (r.status === 401 || r.status === 403 || r.status === 404) return new LicenseError('auth', `The license server refused (${code || r.status}).`)
  return new LicenseError('server', `The license server answered ${r.status}${code ? ` (${code})` : ''}.`)
}

/** Stores a token the server issued after checking it; the AI runs through the server from then on. */
function takeToken(r: ServerAnswer): TokenState {
  if (typeof r.body.token !== 'string') throw new LicenseError('server', 'The license server sent no token.')
  const st = importToken(r.body.token)
  db.setSetting(CHECKED_AT, new Date().toISOString())
  if (db.getSetting('ai.provider') !== 'claude-code') db.setSetting('ai.provider', 'proxy')
  return st
}

/** Activates a license key for this machine and keeps the token (and the key, for refreshes). The open edition has none to activate. */
export async function activate(key: string): Promise<PlanInfo> {
  if (cfg.openEdition) throw new LicenseError('unavailable', 'The open edition has no license.')
  const k = key.trim()
  if (!k) throw new LicenseError('auth', 'Enter the license key first.')
  const r = await post('/v1/license/activate', { key: k, machineId: machineId(), platform: cfg.platform })
  if (r.status !== 200) throw refusal(r)
  takeToken(r)
  cfg.key.write(k)
  return planState()
}

/** Frees this machine's activation at the server and drops the token here; offline, nothing changes. The open edition calls no server and changes nothing. */
export async function deactivate(): Promise<PlanInfo> {
  if (cfg.openEdition) return planState()
  const key = cfg.key.read()
  if (key && serverUrl()) {
    const r = await post('/v1/license/deactivate', { key, machineId: machineId() })
    // Anything the server answered settles it; only an unreachable server keeps the token.
    if (r.status >= 500) throw refusal(r)
  }
  clearToken()
  if (db.getSetting('ai.provider') === 'proxy') db.setSetting('ai.provider', 'api')
  return planState()
}

/**
 * Starts the trial: the local date at once, and, when a server is set, its
 * token (the server's window wins, so a reinstall gets the same end). Without
 * a server the trial unlocks the features and the AI needs the user's own key.
 * The open edition has every feature already, so no trial.
 */
export async function startTrial(): Promise<PlanInfo> {
  if (cfg.openEdition) throw new LicenseError('unavailable', 'The open edition has no trial.')
  if (!db.getSetting(TRIAL_STARTED)) db.setSetting(TRIAL_STARTED, new Date().toISOString())
  if (serverUrl()) {
    const r = await post('/v1/license/trial', { machineId: machineId(), platform: cfg.platform })
    if (r.status === 200) {
      const st = takeToken(r)
      if (st.claims.trialStartedAt) db.setSetting(TRIAL_STARTED, st.claims.trialStartedAt)
    } else {
      const err = refusal(r)
      if (err.kind === 'trial_over') {
        const started = (err as LicenseError & { trialStartedAt?: string }).trialStartedAt
        if (started && Number.isFinite(Date.parse(started))) db.setSetting(TRIAL_STARTED, started)
        else db.setSetting(TRIAL_STARTED, new Date(Date.now() - (TRIAL_DAYS + 1) * DAY).toISOString())
      }
      throw err
    }
  }
  return planState()
}

/**
 * The token the bank routes take: the license or trial token while it's
 * usable, else this computer's Free token, asked for once and kept until a
 * day before it expires. Free's token names no features; the server lets it
 * connect one bank. The open edition has no hosted service to connect through.
 */
export async function bankToken(now: number = Date.now()): Promise<string> {
  if (cfg.openEdition) throw new LicenseError('unavailable', 'The open edition has no hosted service.')
  const held = cfg.token.read()
  if (held && currentToken(now)?.usable) return held
  const kept = cfg.freeToken.read()
  const v = kept ? readSigned(kept, cfg.publicKey, true) : null
  if (kept && v?.ok && v.claims.machineId === machineId() && v.claims.exp * 1000 - DAY > now) return kept
  const r = await post('/v1/license/free', { machineId: machineId(), platform: cfg.platform })
  if (r.status !== 200 || typeof r.body.token !== 'string') throw refusal(r)
  const fresh = readSigned(r.body.token, cfg.publicKey, true)
  if (!fresh.ok) throw new LicenseError('server', 'The server sent a token that is not for this app.')
  if (fresh.claims.machineId !== machineId()) throw new LicenseError('server', 'The server sent a token for another computer.')
  cfg.freeToken.write(r.body.token)
  return r.body.token
}

/** Asks the server for a fresh token for the held license (or trial); the plan after. The open edition asks nothing. */
export async function refresh(): Promise<PlanInfo> {
  if (cfg.openEdition) return planState()
  const claims = storedClaims()
  if (!claims) return planState()
  if (claims.plan === 'trial') {
    const r = await post('/v1/license/trial', { machineId: machineId(), platform: cfg.platform })
    if (r.status === 200) takeToken(r)
    else {
      const err = refusal(r)
      if (err.kind === 'trial_over') clearToken()
      throw err
    }
    return planState()
  }
  const key = cfg.key.read()
  if (!key) return planState()
  const r = await post('/v1/license/validate', { key, machineId: machineId() })
  if (r.status === 200) takeToken(r)
  else {
    const err = refusal(r)
    // The server says the license is gone: so is the token (the grace is for being offline, not for a refusal).
    if (err.kind === 'auth' || err.kind === 'expired') clearToken()
    throw err
  }
  return planState()
}

/** Whether a refresh is due: not the open edition, a token is held, a server is set, and the last check is a day old or more. */
export function refreshDue(now: number = Date.now()): boolean {
  if (cfg.openEdition || !serverUrl() || !storedClaims()) return false
  const last = Date.parse(db.getSetting(CHECKED_AT) ?? '')
  return !Number.isFinite(last) || now - last >= REFRESH_AFTER_MS
}
