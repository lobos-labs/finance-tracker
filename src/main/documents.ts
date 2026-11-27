import type Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { aiHost, perLedger } from './ai/host'
import * as db from './db'
import { documentPath } from './files'
import { docsDir } from './paths'

// Documents for the assistant in API-key and hosted mode, where the app reads
// the file itself and hands the model a content block: a PDF as a document
// block, a picture as an image block, text in pages. (Claude Code mode reads
// files with its own Read tool.) Files attached in the Review chat are saved
// here too, under Chat in the documents folder.

export const MAX_BYTES = 30 * 1024 * 1024
/** The API takes an image of up to 5 MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** The API takes a PDF of up to 600 pages. */
const MAX_PDF_PAGES = 600
/**
 * The included AI (a hosted ledger) reads a PDF of up to 100 pages: one read is then at most about $0.60 of its
 * budget, so a book-length upload can't take one call far past it. A key of the user's own takes 600.
 */
export const INCLUDED_AI_PDF_PAGES = 100
/** Characters of a text file per page. */
export const PAGE_CHARS = 12_000
/** Where files attached in the chat go, inside the documents folder. */
export const CHAT_FOLDER = 'Chat'

const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const TEXT_TYPES = ['txt', 'md', 'csv', 'eml', 'html', 'htm']
/** What can be attached in the chat: what read_document can read. */
export const ATTACHMENT_TYPES = ['pdf', ...Object.keys(IMAGE_TYPES), ...TEXT_TYPES]

export type DocumentBlock = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam | Anthropic.Beta.BetaRequestDocumentBlock

export interface DocumentRead {
  /** what was read, for callers that take JSON */
  result: { name: string; kind: 'pdf' | 'image' | 'text'; bytes: number; page?: number; pages?: number }
  /** the file as the model sees it */
  content: DocumentBlock[]
}

/** The text of an HTML page: scripts and styles gone, tags out, whitespace collapsed. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** How many pages a PDF declares (0 when they're packed where this can't see them). */
const pdfPages = (buf: Buffer): number => (buf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length

// ---------- a hosted ledger's documents ----------

// In a hosted ledger (ai/host.ts) the documents are the account's uploads,
// named "<fileId>/<name>", and their bytes come from the server. The tools
// run synchronously, so Review fetches the documents a step asks to read
// before its tools run (holdDocuments) and lets them go after.

const held = perLedger(() => new Map<string, { name: string; buf: Buffer }>())

/** Fetches the documents a step is about to read; a name the host doesn't have is left for read_document to refuse. */
export async function holdDocuments(names: string[]): Promise<void> {
  const docs = aiHost()?.documents
  if (!docs) return
  for (const name of new Set(names)) {
    try {
      const f = await docs.open(name)
      held().set(name, { name: f.name, buf: Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength) })
    } catch {
      // Not the account's: "No document named ..."
    }
  }
}

export function releaseDocuments(): void {
  held().clear()
}

/** The host's documents as list_documents gives them (no path: there's no folder), or null on the desktop. */
export function hostedDocuments(): Array<{ name: string; path: string; size: number; modified: string; read: boolean; summary: string | null }> | null {
  const docs = aiHost()?.documents
  if (!docs) return null
  const records = db.documentRecords()
  return docs
    .list()
    .map((d) => {
      const r = records.get(d.name)
      return { name: d.name, path: '', size: d.size, modified: db.dayKey(d.addedAt), read: !!r && r.size === d.size, summary: r?.summary ?? null }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Reads a document by its documents-folder name (or full path), as the model takes it. Text files come in pages of PAGE_CHARS. */
export function readDocument(name: string, page = 1): DocumentRead {
  if (aiHost()?.documents) {
    const f = held().get(name)
    if (!f) throw new Error(`No document named ${name}. Use list_documents for names.`)
    if (f.buf.length > MAX_BYTES) throw new Error(`${name} is over 30 MB`)
    return documentBlocks(name, extname(f.name).slice(1).toLowerCase(), f.buf, page)
  }
  const full = documentPath(name)
  const bytes = statSync(full).size
  if (bytes > MAX_BYTES) throw new Error(`${name} is over 30 MB`)
  return documentBlocks(name, extname(full).slice(1).toLowerCase(), readFileSync(full), page)
}

/** A document's bytes as the model takes them, by its extension. */
function documentBlocks(name: string, ext: string, buf: Buffer, page: number): DocumentRead {
  const bytes = buf.length
  if (ext === 'pdf') {
    const pages = pdfPages(buf)
    const max = aiHost() ? INCLUDED_AI_PDF_PAGES : MAX_PDF_PAGES
    if (pages > max) throw new Error(`${name} has about ${pages} pages; up to ${max} can be read. Ask for the pages that matter as their own file.`)
    return { result: { name, kind: 'pdf', bytes, ...(pages ? { pages } : {}) }, content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: name }] }
  }
  const image = IMAGE_TYPES[ext]
  if (image) {
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`${name} is over 5 MB; an image that size can't be read`)
    return { result: { name, kind: 'image', bytes }, content: [{ type: 'image', source: { type: 'base64', media_type: image, data: buf.toString('base64') } }] }
  }
  if (TEXT_TYPES.includes(ext)) {
    const raw = buf.toString('utf8')
    const text = ext === 'html' || ext === 'htm' ? stripHtml(raw) : raw
    const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS))
    const p = Math.min(Math.max(Math.floor(page) || 1, 1), pages)
    const chunk = text.slice((p - 1) * PAGE_CHARS, p * PAGE_CHARS)
    return { result: { name, kind: 'text', bytes, page: p, pages }, content: [{ type: 'text', text: pages > 1 ? `${name}, page ${p} of ${pages}:\n${chunk}` : chunk }] }
  }
  throw new Error(`${name} can't be read here (${ext}); ask for a PDF or an image of it`)
}

const fileSafe = (s: string): string =>
  s
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)

/** Saves a file attached in the chat into the documents folder, named by its content so the same file isn't saved twice; returns its documents-folder name. */
export function saveAttachment(name: string, data: Buffer): string {
  const ext = extname(name).slice(1).toLowerCase()
  if (!ATTACHMENT_TYPES.includes(ext)) throw new Error(`Attach a PDF, an image or a text file (${ATTACHMENT_TYPES.join(', ')})`)
  if (!data.length) throw new Error('That file is empty')
  if (data.length > MAX_BYTES) throw new Error('That file is over 30 MB')
  const dir = join(docsDir(), CHAT_FOLDER)
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha1').update(data).digest('hex').slice(0, 10)
  // The last segment under either separator: a path from another system is cut down to its name here too.
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const stem = fileSafe(basename(leaf, extname(leaf))) || 'Pasted'
  const file = `${stem} ${hash}.${ext}`
  if (!existsSync(join(dir, file))) writeFileSync(join(dir, file), data)
  return `${CHAT_FOLDER}/${file}`
}
