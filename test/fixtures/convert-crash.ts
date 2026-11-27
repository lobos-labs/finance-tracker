// A conversion that dies on the spot at one of its kill points, as a crash or
// a power cut would: no cleanup, connections left open, the process ended by
// the OS. test/db-encryption.test.ts runs it, then opens what it left.
//   node --import test/ts-esm.mjs test/fixtures/convert-crash.ts <dbFile> <backupsDir> <keyFile> <keyHex> <to> <point[:nth]> [<newKeyHex>]
import { writeSync } from 'node:fs'
import { convertDatabase, type KillPoint, type Target } from '../../src/main/dbconvert.ts'

const [dbFile, backupsDir, keyFile, keyHex, to, at, newKeyHex] = process.argv.slice(2)
const [point, nth] = at.split(':')
let seen = 0
try {
  convertDatabase({
    dbFile,
    backupsDir,
    keyFile,
    key: Buffer.from(keyHex, 'hex'),
    newKey: newKeyHex ? Buffer.from(newKeyHex, 'hex') : undefined,
    to: to as Target,
    hook: (p: KillPoint) => {
      if (p !== point || ++seen < Number(nth ?? 1)) return
      writeSync(1, `killed at ${p}\n`)
      process.kill(process.pid, 'SIGKILL')
    }
  })
  process.stdout.write('finished\n')
} catch (err) {
  process.stdout.write(`failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 2
}
