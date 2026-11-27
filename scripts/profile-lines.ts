// Times classifyLines over every demo month, as test/lines.test.ts's budget check does, and with a CPU profile.
// Run: node --import ./test/ts-esm.mjs scripts/profile-lines.ts
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { configureLicense } from '../src/main/license.ts'
import { classifyLines } from '../src/main/lines.ts'
import { daysInMonth, shiftMonth } from '../src/shared/zone.ts'

configureLicense({ dev: true })
db.openDb(':memory:')
loadDemoData()
const first = db.dayKey(db.get<{ p: number }>('SELECT MIN(posted) AS p FROM transactions')!.p).slice(0, 7)
const current = db.today().slice(0, 7)
const lastDay = (m: string): string => `${m}-${String(daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5, 7)))).padStart(2, '0')}`
const months: string[] = []
for (let m = first; m <= current; m = shiftMonth(m, 1)) months.push(m)

classifyLines(`${first}-01`, lastDay(first))
for (let run = 0; run < 3; run++) {
  const t = process.cpuUsage()
  for (const m of months) classifyLines(`${m}-01`, lastDay(m))
  const u = process.cpuUsage(t)
  console.log(`${months.length} months: ${((u.user + u.system) / 1000).toFixed(0)} ms CPU`)
}
