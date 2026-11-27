import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { shell } from 'electron'
import * as db from './db'
import { devEnv, type DevVariable } from './devBuild'
import { addDays, calendarItems, itemSummary, timeZone } from './calendar'
import { can, PlanError } from './license'
import { deleteSecret, readSecret, saveSecret } from './secrets'
import { calendarName, GOOGLE_NAME, isAppTask, taskNotes } from './googleNames'
import { isRateLimited, MAX_TRIES, retryDelay } from './googleRetry'
import { APP_NAME } from '../shared/app'
import type { CalendarItem, GoogleCalendarStatus } from '../shared/types'

// Google Calendar sync. The app creates its own calendar, named after the
// product, in the user's Google account and keeps it matched to the app's
// calendar: reminders plus projected bills, paychecks and transfers for the
// next four months. Google gets each item's title, date, time and amount and a
// fixed note (the calendar's name); the app's own notes (policy numbers,
// account names) stay here. Reminders that are to-dos go to a Google Tasks
// list of the same name when that's switched on, so they can be checked off in
// Google Calendar; check-offs and new dates made there come back. A connection
// made before the rename keeps its "Finance Tracker" calendar and list, found
// by their stored ids (googleNames.ts). Sign-in uses the user's own OAuth
// client (Google requires one per app) with the loopback flow and PKCE. The
// calendar scope only reaches calendars this app created; Tasks has no such
// narrower scope, which is why it's a choice.

// The endpoints can be pointed at a stand-in in a development build only.
const endpoint = (name: DevVariable, real: string): string => devEnv(name) || real
const authUrl = (): string => endpoint('FINANCE_TRACKER_GOOGLE_AUTH', 'https://accounts.google.com/o/oauth2/v2/auth')
const tokenUrl = (): string => endpoint('FINANCE_TRACKER_GOOGLE_TOKEN', 'https://oauth2.googleapis.com/token')
const api = (): string => endpoint('FINANCE_TRACKER_GOOGLE_API', 'https://www.googleapis.com/calendar/v3')
const tasksApi = (): string => endpoint('FINANCE_TRACKER_GOOGLE_TASKS', 'https://tasks.googleapis.com/tasks/v1')
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'
const DAYS_AHEAD = 120
/** The name the app gave its calendar (stored since the rename; before it, "Finance Tracker"). */
const CALENDAR_NAME_SETTING = 'gcal.calendarName'

/** What Google gets as every event's description: the calendar's own name, so a calendar made before the rename isn't rewritten. */
const eventNote = (): string => calendarName(db.getSetting(CALENDAR_NAME_SETTING))

export function status(): GoogleCalendarStatus {
  return {
    configured: !!db.getSetting('gcal.clientId') && !!readSecret('googleClientSecret'),
    connected: !!readSecret('googleRefreshToken'),
    calendarName: db.getSetting('gcal.calendarId') ? calendarName(db.getSetting(CALENDAR_NAME_SETTING)) : null,
    lastSyncAt: Number(db.getSetting('gcal.lastSyncAt')) || null,
    lastError: db.getSetting('gcal.lastError'),
    tasks: tasksGranted(),
    tasksOn: tasksOn()
  }
}

/** Whether the sign-in covers Google Tasks (connections made before tasks don't). */
const tasksGranted = (): boolean => (db.getSetting('gcal.scopes') ?? '').split(' ').includes(TASKS_SCOPE)

/** Whether to-dos go to Google Tasks: the setting, or, before it was ever set, whatever the existing sign-in already covers (so a connection made with Tasks keeps working; a new one starts without). */
export const tasksOn = (): boolean => {
  const v = db.getSetting('gcal.tasks')
  return v === null ? tasksGranted() : v === '1'
}

/** Switches the Tasks sync; turning it on without the scope asks Google for it (a sign-in). */
export async function setTasks(on: boolean): Promise<GoogleCalendarStatus> {
  db.setSetting('gcal.tasks', on ? '1' : '0')
  if (on && readSecret('googleRefreshToken') && !tasksGranted()) return connect()
  scheduleSync()
  return status()
}

export function setCredentials(clientId: string, clientSecret: string): void {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (!/\.apps\.googleusercontent\.com$/.test(id)) throw new Error('That isn\'t an OAuth client ID. It ends in .apps.googleusercontent.com.')
  if (!secret) throw new Error('Paste the client secret too.')
  db.setSetting('gcal.clientId', id)
  saveSecret('googleClientSecret', secret)
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  /** the scopes granted, space-separated */
  scope?: string
}

let access: { token: string; expires: number } | null = null
let waiting: (() => void) | null = null

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenUrl(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string }
  if (!res.ok || !body.access_token) throw Object.assign(new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`), { code: body.error })
  return body as TokenResponse
}

function credentials(): { clientId: string; secret: string } {
  const clientId = db.getSetting('gcal.clientId')
  const secret = readSecret('googleClientSecret')
  if (!clientId || !secret) throw new Error('Add your Google OAuth client ID and secret first.')
  return { clientId, secret }
}

/** Signs in through the browser, then creates the calendar and fills it. */
export async function connect(): Promise<GoogleCalendarStatus> {
  const { clientId, secret } = credentials()
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')

  waiting?.()
  const scope = tasksOn() ? `${CALENDAR_SCOPE} ${TASKS_SCOPE}` : CALENDAR_SCOPE
  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // Only Google's redirect for this very sign-in (its state) settles it; anything else is answered and ignored.
      if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) {
        res.writeHead(url.pathname === '/' ? 400 : 404).end()
        return
      }
      const code = url.searchParams.get('code')
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><title>${APP_NAME}</title><body style="font:16px system-ui;background:#0a0a0b;color:#e8e8e3;padding:48px">${code ? 'Google Calendar is connected. You can close this tab.' : 'Sign-in didn\'t finish. You can close this tab.'}</body>`)
      clearTimeout(timer)
      server.close()
      if (code) resolve({ code, redirectUri })
      else reject(new Error(url.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed.'))
    })
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Google sign-in timed out.'))
    }, 5 * 60_000)
    waiting = () => {
      clearTimeout(timer)
      server.close()
      reject(new Error('Started a new Google sign-in.'))
    }
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const auth = new URL(authUrl())
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state
      }).toString()
      void shell.openExternal(auth.toString())
    })
  })

  waiting = null
  const t = await tokenRequest({ code, client_id: clientId, client_secret: secret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier })
  if (!t.refresh_token) throw new Error('Google didn\'t return a refresh token. Remove Finance Tracker at myaccount.google.com/permissions, then connect again.')
  // The sign-in before this one is no longer needed: revoke it rather than leave it live.
  const previous = readSecret('googleRefreshToken')
  if (previous && previous !== t.refresh_token) await revoke(previous)
  saveSecret('googleRefreshToken', t.refresh_token)
  db.setSetting('gcal.scopes', t.scope ?? null)
  if (db.getSetting('gcal.tasks') === null) db.setSetting('gcal.tasks', tasksGranted() ? '1' : '0')
  access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 }
  return sync()
}

const revoke = (token: string): Promise<void> => fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).then(() => undefined, () => undefined)

export async function disconnect(): Promise<void> {
  const refresh = readSecret('googleRefreshToken')
  deleteSecret('googleRefreshToken')
  db.setSetting('gcal.scopes', null)
  access = null
  if (refresh) await revoke(refresh)
}

async function accessToken(): Promise<string> {
  if (access && Date.now() < access.expires) return access.token
  const { clientId, secret } = credentials()
  const refresh = readSecret('googleRefreshToken')
  if (!refresh) throw new Error('Google Calendar isn\'t connected.')
  try {
    const t = await tokenRequest({ refresh_token: refresh, client_id: clientId, client_secret: secret, grant_type: 'refresh_token' })
    if (t.scope) db.setSetting('gcal.scopes', t.scope)
    access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 }
    return t.access_token
  } catch (err) {
    if ((err as { code?: string }).code === 'invalid_grant') {
      deleteSecret('googleRefreshToken')
      throw new Error('Google Calendar access expired or was removed. Connect again.')
    }
    throw err
  }
}

interface ApiResult {
  status: number
  json: Record<string, unknown>
}

const call = (method: string, path: string, body?: unknown): Promise<ApiResult> => request(method, `${api()}${path}`, body)
const tasksCall = (method: string, path: string, body?: unknown): Promise<ApiResult> => request(method, `${tasksApi()}${path}`, body)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One API call; told to slow down, it waits and tries again (googleRetry.ts). */
async function request(method: string, url: string, body?: unknown): Promise<ApiResult> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    const json = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>)
    if (attempt < MAX_TRIES && isRateLimited(res.status, json)) {
      await sleep(retryDelay(attempt, res.headers.get('Retry-After')))
      continue
    }
    return { status: res.status, json }
  }
}

function fail(r: ApiResult, what: string): never {
  const message = (r.json['error'] as { message?: string } | undefined)?.message
  throw new Error(`Google ${what.includes('task') ? 'Tasks' : 'Calendar'}: ${what} failed (${r.status}${message ? `: ${message}` : ''})`)
}

async function ensureCalendar(): Promise<string> {
  const id = db.getSetting('gcal.calendarId')
  if (id) {
    const r = await call('GET', `/calendars/${encodeURIComponent(id)}`)
    if (r.status === 200) return id
    // A 403 that only means "slow down" isn't a calendar gone; making a new one would leave a duplicate.
    if ((r.status !== 404 && r.status !== 403) || isRateLimited(r.status, r.json)) fail(r, 'finding the calendar')
  }
  const r = await call('POST', '/calendars', { summary: GOOGLE_NAME, description: `Bills, paychecks, transfers and reminders from ${GOOGLE_NAME}.`, timeZone: timeZone() })
  if (r.status !== 200) fail(r, 'creating the calendar')
  db.setSetting('gcal.calendarId', String(r.json['id']))
  db.setSetting(CALENDAR_NAME_SETTING, GOOGLE_NAME)
  return String(r.json['id'])
}

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv'

/** A stable Google event id for an item (Google allows a-v and 0-9). */
function eventId(key: string): string {
  let out = 'ft'
  let value = 0
  let bits = 0
  for (const b of createHash('sha1').update(key).digest()) {
    value = ((value << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

type EventTime = { date: string } | { dateTime: string; timeZone: string }

interface EventBody {
  id: string
  summary: string
  description: string
  start: EventTime
  end: EventTime
  transparency: 'transparent' | 'opaque'
}

function eventBody(i: CalendarItem, note: string): EventBody {
  const at = (time: string): EventTime => ({ dateTime: `${i.day}T${time}:00`, timeZone: timeZone() })
  return {
    id: eventId(i.key),
    summary: itemSummary(i),
    // Titles, dates and amounts travel; the app's notes (a policy number, an account name) don't.
    description: note,
    // A timed reminder (an appointment) holds its time; all-day items leave the day free.
    ...(i.start && i.end ? { start: at(i.start), end: at(i.end), transparency: 'opaque' } : { start: { date: i.day }, end: { date: addDays(i.day, 1) }, transparency: 'transparent' })
  }
}

/** An event time to compare: Google lists dateTime with the calendar time zone's offset, which the event list asks for. */
const whenKey = (t: unknown): string => {
  const w = (t ?? {}) as { date?: string; dateTime?: string; timeZone?: string }
  return w.date ?? `${w.dateTime?.slice(0, 19)} ${w.timeZone}`
}

const same = (e: Record<string, unknown>, b: EventBody): boolean =>
  e['summary'] === b.summary && (e['description'] ?? '') === b.description && whenKey(e['start']) === whenKey(b.start) && whenKey(e['end']) === whenKey(b.end)

/** Runs API calls a few at a time, well inside Google's per-user rate limits. */
async function runJobs(jobs: Array<() => Promise<void>>): Promise<void> {
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) await job()
    })
  )
}

// ---------- tasks ----------

// Every task the app made ends its notes with a mark (googleNames.ts), so tasks the user adds to the list are left alone.

async function ensureTaskList(): Promise<string> {
  const id = db.getSetting('gcal.taskListId')
  if (id) {
    const r = await tasksCall('GET', `/users/@me/lists/${encodeURIComponent(id)}`)
    if (r.status === 200) return id
    if (r.status !== 404) fail(r, 'finding the task list')
  }
  const r = await tasksCall('POST', '/users/@me/lists', { title: GOOGLE_NAME })
  if (r.status !== 200) fail(r, 'creating the task list')
  db.setSetting('gcal.taskListId', String(r.json['id']))
  return String(r.json['id'])
}

interface TaskBody {
  title: string
  notes: string
  /** Google keeps only the date */
  due: string
  status: 'needsAction' | 'completed'
}

const taskDay = (t: Record<string, unknown>): string | null => (typeof t['due'] === 'string' ? t['due'].slice(0, 10) : null)
const sameTask = (t: Record<string, unknown>, b: TaskBody): boolean => t['title'] === b.title && (t['notes'] ?? '') === b.notes && taskDay(t) === b.due.slice(0, 10) && t['status'] === b.status

let onPulled: (() => void) | null = null

/** Called when check-offs or new dates come back from Google Tasks. */
export function setOnPulled(fn: () => void): void {
  onPulled = fn
}

/**
 * Matches the Google task list to the app's to-dos. A date or check-off
 * changed in Google since the last sync comes back to the app; everything else
 * goes from the app to Google. A task deleted in Google counts as done.
 */
async function syncTasks(today: string): Promise<void> {
  const list = await ensureTaskList()
  const l = encodeURIComponent(list)
  const remote = new Map<string, Record<string, unknown>>()
  let pageToken: string | undefined
  do {
    const q = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100', ...(pageToken ? { pageToken } : {}) })
    const r = await tasksCall('GET', `/lists/${l}/tasks?${q}`)
    if (r.status !== 200) fail(r, 'reading tasks')
    for (const t of (r.json['items'] as Array<Record<string, unknown>> | undefined) ?? []) remote.set(String(t['id']), t)
    pageToken = r.json['nextPageToken'] as string | undefined
  } while (pageToken)

  const links = db.googleTaskLinks()
  const horizon = addDays(today, DAYS_AHEAD)
  const kept = new Set<string>()
  const jobs: Array<() => Promise<void>> = []
  let pulled = false
  for (const e of db.listCalendarEvents('0000-01-01')) {
    const had = links.get(e.id)
    // A link into a list that's since been replaced is no link.
    const link = had?.list === list ? had : undefined
    if (!e.task || e.startTime) {
      // Its task, if it had one, goes with the strays below.
      if (had) db.setGoogleTaskLink(e.id, null)
      continue
    }
    const t = link ? remote.get(link.id) : undefined
    if (link && !t) {
      if (e.doneAt === null) {
        db.updateCalendarEvent(e.id, { done: true })
        pulled = true
      }
      db.setGoogleTaskLink(e.id, null)
      continue
    }
    let day = e.day
    let done = e.doneAt !== null
    if (link && t) {
      const googleDay = taskDay(t)
      const googleDone = t['status'] === 'completed'
      if (googleDay && googleDay !== link.due) day = googleDay
      if (googleDone !== (link.status === 'completed')) done = googleDone
      if (day !== e.day || done !== (e.doneAt !== null)) {
        db.updateCalendarEvent(e.id, { day, done })
        pulled = true
      }
    } else if (done || day > horizon) continue

    // A task made under the old name keeps its mark; a new one gets the new mark.
    const b: TaskBody = { title: itemSummary({ ...e, kind: 'reminder' }), notes: taskNotes(t?.['notes']), due: `${day}T00:00:00.000Z`, status: done ? 'completed' : 'needsAction' }
    const linkTo = (id: string): void => db.setGoogleTaskLink(e.id, { list, id, due: day, status: b.status })
    if (link && t) {
      kept.add(link.id)
      if (sameTask(t, b)) {
        if (link.due !== day || link.status !== b.status) linkTo(link.id)
        continue
      }
      jobs.push(async () => {
        const r = await tasksCall('PATCH', `/lists/${l}/tasks/${encodeURIComponent(link.id)}`, { ...b, ...(b.status === 'needsAction' ? { completed: null } : {}) })
        if (r.status !== 200) fail(r, 'updating a task')
        linkTo(link.id)
      })
    } else {
      jobs.push(async () => {
        const r = await tasksCall('POST', `/lists/${l}/tasks`, b)
        if (r.status !== 200) fail(r, 'adding a task')
        linkTo(String(r.json['id']))
      })
    }
  }
  if (pulled) onPulled?.()
  // Tasks of reminders deleted or no longer to-dos.
  for (const [id, t] of remote) {
    if (kept.has(id) || !isAppTask(t['notes'])) continue
    jobs.push(async () => {
      const r = await tasksCall('DELETE', `/lists/${l}/tasks/${encodeURIComponent(id)}`)
      if (![200, 204, 404, 410].includes(r.status)) fail(r, 'removing a task')
    })
  }
  await runJobs(jobs)
}

// ---------- sync ----------

let syncing: Promise<GoogleCalendarStatus> | null = null

/** Brings the Google calendar and task list in line with the app. Past events are left as they were. */
export function sync(): Promise<GoogleCalendarStatus> {
  if (!can('googleSync')) return Promise.reject(new PlanError('googleSync'))
  syncing ??= runSync().finally(() => {
    syncing = null
  })
  return syncing
}

async function runSync(): Promise<GoogleCalendarStatus> {
  try {
    const cal = encodeURIComponent(await ensureCalendar())
    const today = db.dayKey(db.now())
    // To-dos become tasks when that's switched on and the sign-in covers Google
    // Tasks; otherwise, or when Tasks fails, they stay calendar events.
    let tasksError: string | null = null
    let asTasks = false
    if (tasksOn() && tasksGranted()) {
      try {
        await syncTasks(today)
        asTasks = true
      } catch (err) {
        tasksError = err instanceof Error ? err.message : String(err)
      }
    }
    const items = calendarItems(today, addDays(today, DAYS_AHEAD)).filter((i) => !(asTasks && i.task))
    const note = eventNote()
    const desired = new Map(items.map((i) => [eventId(i.key), eventBody(i, note)]))
    // A to-do's old event goes even when its day has passed.
    const taskEvents = new Set(asTasks ? db.listCalendarEvents('0000-01-01').filter((e) => e.task && !e.startTime).map((e) => eventId(`event:${e.id}`)) : [])

    const existing = new Map<string, Record<string, unknown>>()
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({ timeMin: `${addDays(today, -1)}T00:00:00Z`, timeZone: timeZone(), maxResults: '2500', ...(pageToken ? { pageToken } : {}) })
      const r = await call('GET', `/calendars/${cal}/events?${q}`)
      if (r.status !== 200) fail(r, 'reading events')
      for (const e of (r.json['items'] as Array<Record<string, unknown>> | undefined) ?? []) existing.set(String(e['id']), e)
      pageToken = r.json['nextPageToken'] as string | undefined
    } while (pageToken)

    const jobs: Array<() => Promise<void>> = []
    for (const [id, b] of desired) {
      const e = existing.get(id)
      if (e && same(e, b)) continue
      jobs.push(async () => {
        if (e) {
          const r = await call('PUT', `/calendars/${cal}/events/${id}`, b)
          if (r.status !== 200) fail(r, 'updating an event')
          return
        }
        let r = await call('POST', `/calendars/${cal}/events`, b)
        // An event deleted earlier keeps its id; bring it back instead.
        if (r.status === 409) r = await call('PUT', `/calendars/${cal}/events/${id}`, { ...b, status: 'confirmed' })
        if (r.status !== 200) fail(r, 'adding an event')
      })
    }
    for (const [id, e] of existing) {
      const start = e['start'] as { date?: string; dateTime?: string } | undefined
      const day = start?.date ?? start?.dateTime?.slice(0, 10)
      if (desired.has(id) || !id.startsWith('ft') || !day || (day < today && !taskEvents.has(id))) continue
      jobs.push(async () => {
        const r = await call('DELETE', `/calendars/${cal}/events/${id}`)
        if (![200, 204, 404, 410].includes(r.status)) fail(r, 'removing an event')
      })
    }
    await runJobs(jobs)
    db.setSetting('gcal.lastSyncAt', String(db.now()))
    db.setSetting('gcal.lastError', tasksError)
  } catch (err) {
    db.setSetting('gcal.lastError', err instanceof Error ? err.message : String(err))
    throw err
  }
  return status()
}

let timer: ReturnType<typeof setTimeout> | undefined

/** Syncs a few seconds after the last change, when connected (and the plan includes the sync). */
export function scheduleSync(): void {
  if (!readSecret('googleRefreshToken') || !can('googleSync')) return
  clearTimeout(timer)
  timer = setTimeout(() => sync().catch((err) => console.error('[google]', err)), 5000)
}
