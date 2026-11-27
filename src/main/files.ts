import { existsSync, realpathSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { ledgerState } from './ledgerState'
import { docsDir, extraDocsDirs } from './paths'

// The one rule for a file path the app stores and later opens (a tax form, a
// credit report, a policy document, a receipt): a full path to a document
// inside the documents folder, or inside one of the extra folders the user
// allowed. The assistant, the file bridge and a document it read can all hand
// the app a path, so none of them can point it at a program, a shortcut or a
// share.

export const DOCUMENT_TYPES = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tif', 'tiff', 'csv', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'eml', 'html', 'htm']

/** Whether a file name has one of the document extensions. */
export const isDocumentName = (name: string): boolean => DOCUMENT_TYPES.includes(extname(name).slice(1).toLowerCase())

/** Paths compare without case on Windows. */
const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Whether `child` is `parent` or inside it, both already resolved. */
export function isWithin(child: string, parent: string): boolean {
  const c = process.platform === 'win32' ? child.toLowerCase() : child
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * A path on this computer's own drives: a drive letter on Windows (never a
 * \\server\share, which would make the app sign in to that server just by
 * checking whether the file exists), an absolute path elsewhere.
 */
export function isLocalPath(p: string): boolean {
  if (typeof p !== 'string' || !isAbsolute(p)) return false
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : !p.startsWith('//')
}

/** The folder as the file system knows it (links followed), or as given when it doesn't exist yet. */
function realDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

/** The folders a stored document may be in: the documents folder, then the extra folders the user allowed. */
export function documentRoots(): string[] {
  return [docsDir(), ...extraDocsDirs()]
}

/** Whether a (resolved) path is inside one of the document roots. */
export const inDocumentRoots = (p: string, roots = documentRoots()): boolean => roots.some((r) => isWithin(p, realDir(r)))

/**
 * Why a path can't be opened, or null when it can. `shown` is how the message names the file: what the caller was
 * given (a name in the documents folder), so a message never spells out the folder's own path, which carries the
 * computer's user name and can go to a model.
 */
export function documentProblem(p: string, shown: string = p): string | null {
  const roots = documentRoots()
  const rule = `File paths must be inside the documents folder${roots.length > 1 ? ' or an extra document folder' : ''}`
  if (typeof p !== 'string' || !p.trim()) return `${rule}; no path was given`
  if (!isAbsolute(p)) return `${rule}, as a full path`
  if (!isLocalPath(p)) return `${rule}, on this computer`
  const ext = extname(p).slice(1).toLowerCase()
  if (!DOCUMENT_TYPES.includes(ext)) return `${rule} and be a document (${DOCUMENT_TYPES.join(', ')})`
  let real: string
  try {
    // Links and junctions are followed, so one inside the folder can't lead out of it.
    real = realpathSync(p)
  } catch {
    return `${rule}; ${shown} doesn't exist`
  }
  if (!same(extname(real).slice(1).toLowerCase(), ext)) return `${rule}; ${shown} leads to a different kind of file`
  if (!inDocumentRoots(real, roots)) return `${rule}; ${shown} is outside it`
  return null
}

/** A full path to an existing document inside the documents folder, links followed. */
export function isOpenableDocument(p: string): boolean {
  return documentProblem(p) === null
}

/** A documents-folder name ("Receipts/visit.pdf") or full path as the full path of an openable document; throws the rule otherwise. */
export function documentPath(nameOrPath: string): string {
  let full = nameOrPath
  if (typeof nameOrPath === 'string' && nameOrPath.trim() && !isAbsolute(nameOrPath)) {
    full = resolve(docsDir(), nameOrPath)
    if (!existsSync(full)) {
      // A file in an extra document folder is named under that folder's own name (withoutDocumentRoots).
      const [head, ...rest] = nameOrPath.split(/[\\/]+/)
      const root = extraDocsDirs().find((d) => same(basename(d), head))
      if (root && rest.length) full = resolve(root, ...rest)
    }
  }
  const problem = documentProblem(full, nameOrPath)
  if (problem) throw new Error(problem)
  return full
}

/**
 * A tool's answer as it goes to a model, with each document root's own path taken out: a file reads as its name in
 * the documents folder (Tax/w2.pdf), or under an extra folder's own name, in plain text and inside JSON. A root's
 * path carries the computer's user name, and only names are said to be sent. documentPath takes the names back.
 */
export function withoutDocumentRoots(text: string, roots: string[] = documentRoots()): string {
  const named = roots.map((root, i) => ({ root, name: i === 0 ? '' : basename(root) })).sort((a, b) => b.root.length - a.root.length)
  let out = text
  for (const { root, name } of named) {
    if (!root) continue
    // As it is, with forward slashes, and as JSON writes its backslashes.
    for (const form of new Set([root, root.split('\\').join('/'), root.split('\\').join('\\\\')])) {
      for (const after of ['\\\\', '\\', '/']) out = out.split(form + after).join(name ? `${name}/` : '')
      out = out.split(form).join(name || 'the documents folder')
    }
  }
  return out
}

// ---------- whether stored files are still there ----------

// The pages show which forms, reports and policy documents are still on disk.
// Checking is done off the main thread before a page loads (probeFiles) and
// remembered for a while; a path outside the document roots is never touched,
// and a share is never contacted.

const PROBE_TTL = 30_000
/** What was found, each ledger's own (ledgerState.ts). */
const probedNow = ledgerState(() => new Map<string, { ok: boolean; at: number }>())

/** Whether a stored path may be looked at on disk at all. */
const probeable = (p: string): boolean => isLocalPath(p) && inDocumentRoots(resolve(p))

/** Checks which of the paths exist, asynchronously, and remembers the answers for fileFound. */
export async function probeFiles(paths: string[]): Promise<void> {
  await Promise.all(
    [...new Set(paths)].map(async (p) => {
      let ok = false
      if (probeable(p)) {
        try {
          await access(p)
          ok = true
        } catch {
          ok = false
        }
      }
      probedNow().set(p, { ok, at: Date.now() })
    })
  )
}

/** Whether a stored document path is there: the last probe's answer, or a direct look at a local document path when none is fresh. */
export function fileFound(p: string): boolean {
  const probed = probedNow()
  const c = probed.get(p)
  if (c && Date.now() - c.at < PROBE_TTL) return c.ok
  const ok = probeable(p) && existsSync(p)
  probed.set(p, { ok, at: Date.now() })
  return ok
}

/**
 * The folder to allow for a stored document outside the roots: the first
 * folder below the nearest base (Desktop, Documents, Downloads, then the home
 * folder), such as <Desktop>/Paperwork. Null when the path sits directly in
 * a base or outside them all.
 */
export function folderToAdopt(p: string, bases: string[]): string | null {
  if (!isLocalPath(p)) return null
  const full = resolve(p)
  for (const base of bases) {
    const b = resolve(base)
    if (!isWithin(full, b) || same(full, b)) continue
    const parts = full.slice(b.length).replace(/^[\\/]+/, '').split(/[\\/]/)
    if (parts.length < 2 || !parts[0]) continue
    return join(b, parts[0])
  }
  return null
}
