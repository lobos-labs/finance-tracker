import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A small log under <userData>/logs: app.log, rolled over to app.1.log past
// 512 KB. It records events and error messages (what console.error and
// console.warn print, too), never anything from the ledger, and it stays on
// this machine; Settings → Data copies its tail to the clipboard.

const MAX_BYTES = 512 * 1024
const LINE_MAX = 1000

let dir: string | null = null

export const logFile = (): string | null => (dir ? join(dir, 'app.log') : null)

const text = (a: unknown): string => (a instanceof Error ? a.message : typeof a === 'string' ? a : String(a))

function write(level: string, line: string): void {
  if (!dir) return
  try {
    const file = join(dir, 'app.log')
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'app.1.log'))
    appendFileSync(file, `${new Date().toISOString()} ${level} ${line.replace(/\r?\n/g, ' | ').slice(0, LINE_MAX)}\n`)
  } catch {
    // The log never takes the app down.
  }
}

/** Starts the log in `folder` and mirrors console.error and console.warn into it. */
export function openLog(folder: string): void {
  dir = folder
  mkdirSync(dir, { recursive: true })
  for (const level of ['error', 'warn'] as const) {
    const print = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      print(...args)
      write(level, args.map(text).join(' '))
    }
  }
}

export function log(tag: string, message: string): void {
  write('info', `[${tag}] ${message}`)
}

export { errorTag } from '../shared/errorTag'

/** An error's message and its first few stack frames (file positions, no data). */
export function logCrash(tag: string, err: unknown): void {
  const frames = err instanceof Error && err.stack ? err.stack.split('\n').slice(1, 4).map((f) => f.trim()) : []
  write('error', [`[${tag}] ${text(err)}`, ...frames].join(' | '))
}

/** The last n lines of the log, for diagnostics. */
export function lastLines(n: number): string[] {
  const file = logFile()
  if (!file || !existsSync(file)) return []
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}
