import { readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as db from './db'
import { conversionFiles } from './dbconvert'
import { KEY_COPY_NOTE, KEY_FILE_NAME, setSession } from './dbsession'
import { SWITCH_FILE_NAME } from './dbopen'

// Delete all data's removal step (wipe.ts asks first and does the rest), free
// of Electron so the tests run it on a scratch folder.

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const removePath = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (err) {
    console.error(`[wipe] ${path}: ${message(err)}`)
  }
}

/**
 * What a conversion or a restore can leave beside the database (the first version's names too), the
 * half-written files of a durable write (<name>.tmp), the note of where the key file's copy went, and
 * key files set aside (finance-<id>.key).
 */
function besideDb(dbFile: string): string[] {
  const f = conversionFiles(dbFile)
  const dir = dirname(dbFile)
  const stem = basename(dbFile).replace(/\.db$/i, '')
  let aside: string[] = []
  try {
    aside = readdirSync(dirname(dbFile))
      .filter((n) => n.startsWith(`${stem}-`) && /^-[0-9a-f]{8}\.key$/.test(n.slice(stem.length)))
      .map((n) => join(dirname(dbFile), n))
  } catch {
    // No folder, nothing beside it.
  }
  const restore = `${dbFile.replace(/\.db$/i, '')}.restore`
  const durable = [f.marker, join(dir, KEY_FILE_NAME), join(dir, SWITCH_FILE_NAME), join(dir, KEY_COPY_NOTE)].map((p) => `${p}.tmp`)
  return [f.marker, f.encTmp, f.plainTmp, f.scratch, f.pre, `${f.pre}.tmp`, `${f.encTmp}.main`, `${f.plainTmp}.main`, f.restoreTmp, `${dbFile}.restore.tmp`, `${restore}.tmp`, `${restore}.back`, join(dir, KEY_COPY_NOTE), ...durable, ...aside]
}

/**
 * Empties the AI request log (secure_delete overwrites its rows, so they're
 * gone even if a file below can't be removed), closes the database, and
 * removes every location, the database's write-ahead files and whatever a
 * conversion left beside it. The key goes from memory too.
 */
export function removeData(dbFile: string, locations: readonly string[]): void {
  try {
    db.clearAiRequests()
    db.checkpoint()
  } catch (err) {
    console.error('[wipe] request log:', message(err))
  }
  db.closeDb()
  setSession(null)
  for (const p of locations) removePath(p)
  for (const s of ['-wal', '-shm', '-journal']) removePath(`${dbFile}${s}`)
  for (const p of besideDb(dbFile)) for (const s of ['', '-wal', '-shm', '-journal']) removePath(`${p}${s}`)
}
