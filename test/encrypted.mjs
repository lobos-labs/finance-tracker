// The encrypted run of the suite (npm run test:encrypted, part of npm test):
// every database a test opens without naming a key is encrypted under a
// random one, as a packaged build's are. Loaded after ts-esm.mjs, so the
// module here is the one db.ts imports.
import { randomBytes } from 'node:crypto'
import { setDefaultKey } from '../src/main/sqlite.ts'

setDefaultKey(randomBytes(32))
