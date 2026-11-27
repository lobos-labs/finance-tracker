import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as db from '../src/main/db.ts'
import { loadDemoData } from '../src/main/demo.ts'
import { configureLicense } from '../src/main/license.ts'
import { closeDueMonths, listSnapshots } from '../src/main/snapshots.ts'
import { getWaterfall, monthClose } from '../src/main/waterfall.ts'
import { addDays, shiftMonth } from '../src/shared/zone.ts'
import type { Span, Waterfall } from '../src/shared/types.ts'
import { noonOn } from './days.ts'
import { household, TODAY } from './fixtures/waterfall-household.ts'
import { tieOut } from './fixtures/tieout.ts'

// Net worth's Overview on one source (waterfall spec sub-phase 2d, part 2) moves the net worth series and the balance
// sheet onto the bridge's walk, and moves no row, identity, bridge or close: on the sample household, section 5's
// household and the section 2 tie-out, each is as it was before it. A file of its own, so each fixture is built first
// in its process and numbers its lines from the start, as it did when the digests below were taken.

configureLicense({ dev: true })

const [Y, M, D] = TODAY.split('-').map(Number)

/** Each fixture's spans: every month, YTD, 12M, All, the last 30 days, a custom span of months and one of days. */
function spansOf(first: string): Span[] {
  const today = db.today()
  const cur = today.slice(0, 7)
  const months: Span[] = []
  for (let m = first; m <= cur; m = shiftMonth(m, 1)) months.push({ from: m, to: m })
  return [...months, { from: `${cur.slice(0, 4)}-01`, to: cur }, { from: shiftMonth(cur, -11), to: cur }, { from: first, to: cur }, { from: addDays(today, -29), to: today }, { from: '2026-03', to: '2026-08' }, { from: '2026-09-10', to: '2026-10-20' }]
}

/**
 * Rows, identities and bridges as they were before this part of 2d: for each fixture at its
 * clock, every span's rows, cash identity and bridge, each as sha-256 (16 hex) of its JSON with each manual account's
 * id in place of its name (they are random), and every close's lines digest and month-end balances. A figure that
 * moves changes its span's digest: getWaterfall over that span shows what moved.
 */
const BEFORE_THIS_PART: Record<'demo' | 'household' | 'tieout', { closes: string; spans: Record<string, string> }> = {
  demo: {
    closes: '6b6e7211ceba452a',
    spans: {
      '2025-10..2025-10': 'd10c654db5537dfd 4db6b1bd50c9014a 6899ad320ef3b83e',
      '2025-11..2025-11': 'd05f0f7582229312 429c0973da859d5a 1625b04d0ad230d0',
      '2025-12..2025-12': 'a436b7cc22b09493 49cc9791f8fce242 f61083ef12c2b915',
      '2026-01..2026-01': '1299499340e275d3 bcd5a40fd3e9360b 163a0c536f5e3f9c',
      '2026-02..2026-02': 'b85c74ad97f2be15 c7dcb11e46cde615 47c1290a4d8a6f62',
      '2026-03..2026-03': '3ba26a8b018a4d4e 478b94ddcf5e3493 4dbb8b160184385c',
      '2026-04..2026-04': '40c6f7db63035ada d451d636a8cb7b2d f2e6116c03a9c03b',
      '2026-05..2026-05': '47bd248347b103c9 f9b657ab98bf9566 72a254e2d354db77',
      '2026-06..2026-06': 'b3ca1603f9060e2b fc4f0703618b804c 139a4c27ab578b4c',
      '2026-07..2026-07': 'daefa934cd4e4801 6015a1dba12087d7 d91f1580a942a8b7',
      '2026-08..2026-08': 'ede4b83abf262481 601c02891d26a3f1 1ff8f2ce2fcbb7f8',
      '2026-09..2026-09': '7ae7eadc2a7ec6bc cedf986596781d37 b6690df294b70097',
      '2026-10..2026-10': 'd7c0c32c18ac103b 18aa3634ad4036a2 78126ae4d3815954',
      '2026-11..2026-11': 'e97942dee0f90c3d 3ca2469c5b06431b f5261b4ae234641b',
      '2026-01..2026-11': 'c1befa38315f4537 f78da4d52d4ba0db 21cbb323668b98e4',
      '2025-12..2026-11': 'd58ae91356be8fb4 bea79d8662bf0def cc7189b8b719fa27',
      '2025-10..2026-11': '55f4a5749c5b2b0b 850b42ab3d5711c4 3835138a43e6cd03',
      '2026-10-09..2026-11-07': '980152a0ff4c7274 c569004ea8d9376c ef2571f7b4fd53f2',
      '2026-03..2026-08': '6438203bd7c4cb9a 95cf68da558b5466 8698ecaebc561bb2',
      '2026-09-10..2026-10-20': 'c84352b37430ac3e c9f4fd3636bf4c9f a4e1f675c524b84f'
    }
  },
  household: {
    closes: 'a4cd6a82e5a012e3',
    spans: {
      '2024-11..2024-11': 'fd4bea394e8094bf ebe420d11039f544 261b861b1b673ce6',
      '2024-12..2024-12': 'bdf2c2ac72bdea40 ebe420d11039f544 a89cbb1bd2cc55e6',
      '2025-01..2025-01': '0197ce6d267c065e ebe420d11039f544 00904018439b5ac6',
      '2025-02..2025-02': '72a597b13e5ab73a ebe420d11039f544 f987683aec18f7c1',
      '2025-03..2025-03': '11d1d4c7b8680df2 ebe420d11039f544 7129a37f343ce49d',
      '2025-04..2025-04': '7b3821fd0ac0ea5d ebe420d11039f544 7f8bfa277376d6c4',
      '2025-05..2025-05': 'ecdb76ec1dcc1c50 8bee33acb2469791 99c2170d025440db',
      '2025-06..2025-06': 'b39561d663766783 8d73f1b2d0dd1d81 720e387833d38ef7',
      '2025-07..2025-07': '192ec162fd32a8ac ae757dc0e99c3ce1 d29c32a5eaa5fa81',
      '2025-08..2025-08': 'b9966808041e3a4c 08e536739bd2b760 03d43ff5eaac1772',
      '2025-09..2025-09': '1a9c14e1f6d97ea8 0755e67a0280e5c3 98c42f016476f4cc',
      '2025-10..2025-10': '8f9b22bf01863738 9e4c9d1885b4a34b 4835c00bb763c157',
      '2025-11..2025-11': '02d7b9f4c0d97afc a4ae81c765b63761 fb4d1f9f08f0bd1e',
      '2025-12..2025-12': '7cd22e8ab81ed2e5 a4ae81c765b63761 f200a4da9de0b156',
      '2026-01..2026-01': 'dc105921de114b17 a4ae81c765b63761 df0f276a0e90c6bd',
      '2026-02..2026-02': '3170b47b9f022ed6 ebe420d11039f544 a0a1541d2390d481',
      '2026-03..2026-03': '1635b47f9f63f0ed ebe420d11039f544 c528d4158134896d',
      '2026-04..2026-04': '65d93530fb942c73 ebe420d11039f544 5a1a5b2d8831cddb',
      '2026-05..2026-05': '6b3e10571e919a00 78c35767d5c0823a 8defbe0fcaf4416f',
      '2026-06..2026-06': '09fa88ab7e753e4e f6cdfdd516c5d970 2102edb4ad5e82d1',
      '2026-07..2026-07': '8c0222117bf02f9a 7fc49fc476bcc520 62ba0c80096e0145',
      '2026-08..2026-08': '5d898b393ed27ff8 1ccecaeb77fe79fd dc9befc4630599a2',
      '2026-09..2026-09': '481c9bf8ce9f8c6f 3928e9fc3a625a27 0acb85879d98e56b',
      '2026-10..2026-10': '96d6b58d7f1cb97a e6f08f4e4eeb689c 8cfc7489733cf889',
      '2026-11..2026-11': '1ba41552e35c005b 4fa45693f01de704 a1aeb3fec5201354',
      '2026-01..2026-11': '8808bc2763f4d5d5 7b89806b5a93772c 09e4091a2e5a9b2f',
      '2025-12..2026-11': '0dd451ffb6707d88 4812bc93e65152e5 44fc63d0bf2cb5c4',
      '2024-11..2026-11': 'd2baa4efa8d0baac 9134a7ac674e7c34 2289f9b661da02d8',
      '2026-10-09..2026-11-07': '90456e67e9058510 79c799a87efab80f 59dd474d3d8488ac',
      '2026-03..2026-08': 'b925177e533f9a19 422040a457146640 9353be42793df4e9',
      '2026-09-10..2026-10-20': '064155a83b3f83c1 90c55da45a6268aa dec76610dfc8cc80'
    }
  },
  tieout: {
    closes: 'e02250b87a8563ff',
    spans: {
      '2026-05..2026-05': '8bd5c3913d970567 90f30a8d615ef77c 6342de0b43685837',
      '2026-06..2026-06': 'c0392847299c6c3c 90f30a8d615ef77c 01d2c4d3941cd5cb',
      '2026-07..2026-07': '88606e486dc45568 90f30a8d615ef77c 73e82aba3a983b33',
      '2026-08..2026-08': 'f2434479cf5a0afc 90f30a8d615ef77c f249da467b163dfb',
      '2026-09..2026-09': '952836186941bcc8 90f30a8d615ef77c a6b8cb5a19ef7959',
      '2026-10..2026-10': 'ce6a9439812816b9 8ca3f04c629d4b41 aac2f8b173312f3d',
      '2026-11..2026-11': 'd8398d1751821561 5a44aaa456ae9f39 e1d1780cc4874573',
      '2026-01..2026-11': 'c1100779600443fa 144cd77b006e7e19 b01998d3fb1cdfc1',
      '2025-12..2026-11': '1a0eefdb096aeeb8 144cd77b006e7e19 05cba235d007429c',
      '2026-05..2026-11': 'f9896d812eac8221 144cd77b006e7e19 8cc651c1a615f505',
      '2026-10-09..2026-11-07': 'd17274b918368d1f 118b74832138d185 a8af3e17d5c9ca35',
      '2026-03..2026-08': '753403aa00d37197 0a08bd82d900ff9a d25e30adafe605dc',
      '2026-09-10..2026-10-20': '0c3517eb3beb41c6 0e34945fc5d50439 0fa5a94c996cd1f3'
    }
  }
}

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** What a fixture's spans and closes digest to now, as BEFORE_THIS_PART holds them. */
function figuresNow(): { closes: string; spans: Record<string, string> } {
  const names = new Map(db.listAccounts().map((a) => [a.id, a.name]))
  const norm = (v: unknown): string => {
    let s = JSON.stringify(v)
    for (const [id, n] of names) if (id.startsWith('manual:')) s = s.split(id).join(`acct:${n}`)
    return s
  }
  const today = db.today()
  const cur = today.slice(0, 7)
  const first = getWaterfall({ from: cur, to: cur }).firstMonth!
  const spans: Record<string, string> = {}
  for (const s of spansOf(first)) {
    const w: Waterfall = getWaterfall(s)
    // Each venture's position at the bridge's ends (sub-phase 1j) came after these digests; every other figure is as it was.
    const { ventures: _ventures, ...bridge } = w.bridge
    spans[`${s.from}..${s.to}`] = `${sha16(norm(w.rows))} ${sha16(norm(w.identity))} ${sha16(norm(bridge))}`
  }
  const closes = listSnapshots(1000).map((c) => {
    const mc = monthClose(c.month)
    return { month: c.month, version: c.version, status: c.status, lines: c.digests.lines, balances: [...mc.balances].sort(([a], [b]) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b)), perimeter: [...mc.perimeter].sort() }
  })
  return { closes: sha16(norm(closes)), spans }
}

describe('rows, identities, bridges and closes as they were before', () => {
  afterEach(() => {
    db.closeDb()
    mock.timers.reset()
  })

  const fixtures: Array<[keyof typeof BEFORE_THIS_PART, () => void]> = [
    [
      'demo',
      () => {
        db.openDb(':memory:')
        loadDemoData()
      }
    ],
    ['household', () => void household()],
    ['tieout', () => void tieOut()]
  ]
  for (const [name, load] of fixtures) {
    test(name, async () => {
      mock.timers.enable({ apis: ['Date'], now: noonOn(Y, M, D) * 1000 })
      load()
      await closeDueMonths()
      const now = figuresNow()
      const was = BEFORE_THIS_PART[name]
      for (const [span, digests] of Object.entries(was.spans)) assert.equal(now.spans[span], digests, `${name} ${span}: rows, identity and bridge`)
      assert.equal(Object.keys(now.spans).length, Object.keys(was.spans).length)
      assert.equal(now.closes, was.closes, `${name}: every close's lines and balances`)
    })
  }
})

