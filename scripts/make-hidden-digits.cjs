// Writes a minimal TrueType font ("Hidden Digits") with no dependencies. The app uses it for digits, commas and
// periods only (unicode-range) when numbers are hidden. A contextual substitution (rlig and calt) turns any run of
// digits, with the commas and decimal points inside it, into one fixed "•••", so a number's length doesn't show:
// $12 and $1,234,567.89 both read "$•••". Outside a number, comma and period look like themselves.
// usage: node scripts/make-hidden-digits.cjs src/renderer/src/assets/hidden-digits.ttf
const fs = require('fs')

const UPM = 1000
const buf = (n) => Buffer.alloc(n)
const pad4 = (b) => {
  const extra = (4 - (b.length % 4)) % 4
  return extra ? Buffer.concat([b, Buffer.alloc(extra)]) : b
}
const u16 = (...vals) => {
  const b = buf(2 * vals.length)
  vals.forEach((v, i) => b.writeUInt16BE(v & 0xffff, 2 * i))
  return b
}
const checksum = (b) => {
  const p = pad4(b)
  let sum = 0
  for (let i = 0; i < p.length; i += 4) sum = (sum + p.readUInt32BE(i)) >>> 0
  return sum
}

// ---- glyphs ----
// A dot: eight quadratic points, clockwise (y up), starting at the bottom.
const dot = (cx, cy, r) => [
  [cx, cy - r, 1],
  [cx - r, cy - r, 0],
  [cx - r, cy, 1],
  [cx - r, cy + r, 0],
  [cx, cy + r, 1],
  [cx + r, cy + r, 0],
  [cx + r, cy, 1],
  [cx + r, cy - r, 0]
]
const DIGIT = { advance: 600, contours: [dot(300, 340, 100)] }
const RUN = { advance: 1200, contours: [dot(200, 340, 100), dot(600, 340, 100), dot(1000, 340, 100)] }
const EMPTY = { advance: 0, contours: [] }
const COMMA = {
  advance: 280,
  contours: [
    [
      [60, -130, 1],
      [110, 110, 1],
      [180, 110, 1],
      [100, -130, 1]
    ]
  ]
}
const PERIOD = { advance: 280, contours: [dot(130, 60, 60)] }

// Glyph ids: 0 .notdef, 1-10 the digits (one dot each, for when no shaping applies), 11 the run, 12 empty, 13 comma, 14 period.
const glyphs = [{ advance: 600, contours: [] }, ...Array.from({ length: 10 }, () => DIGIT), RUN, EMPTY, COMMA, PERIOD]
const G_DIGITS = Array.from({ length: 10 }, (_, i) => i + 1)
const G_RUN = 11
const G_EMPTY = 12
const G_COMMA = 13
const G_PERIOD = 14
const NUM_GLYPHS = glyphs.length

const bbox = (g) => {
  const pts = g.contours.flat()
  if (!pts.length) return null
  return { xMin: Math.min(...pts.map((p) => p[0])), yMin: Math.min(...pts.map((p) => p[1])), xMax: Math.max(...pts.map((p) => p[0])), yMax: Math.max(...pts.map((p) => p[1])) }
}

function glyphData(g) {
  const b = bbox(g)
  if (!b) return Buffer.alloc(0)
  const pts = g.contours.flat()
  const head = buf(10)
  head.writeInt16BE(g.contours.length, 0)
  head.writeInt16BE(b.xMin, 2)
  head.writeInt16BE(b.yMin, 4)
  head.writeInt16BE(b.xMax, 6)
  head.writeInt16BE(b.yMax, 8)
  let end = -1
  const ends = g.contours.map((c) => (end += c.length))
  const flags = Buffer.from(pts.map((p) => (p[2] ? 1 : 0)))
  const xs = buf(2 * pts.length)
  const ys = buf(2 * pts.length)
  let px = 0
  let py = 0
  pts.forEach((p, i) => {
    xs.writeInt16BE(p[0] - px, 2 * i)
    ys.writeInt16BE(p[1] - py, 2 * i)
    px = p[0]
    py = p[1]
  })
  return pad4(Buffer.concat([head, u16(...ends), u16(0), flags, xs, ys]))
}

const datas = glyphs.map(glyphData)
const glyf = Buffer.concat(datas)
const loca = buf(2 * (NUM_GLYPHS + 1))
let at = 0
datas.forEach((d, i) => {
  loca.writeUInt16BE(at / 2, 2 * i)
  at += d.length
})
loca.writeUInt16BE(at / 2, 2 * NUM_GLYPHS)

const boxes = glyphs.map(bbox).filter(Boolean)
const all = { xMin: Math.min(...boxes.map((b) => b.xMin)), yMin: Math.min(...boxes.map((b) => b.yMin)), xMax: Math.max(...boxes.map((b) => b.xMax)), yMax: Math.max(...boxes.map((b) => b.yMax)) }
const lsbs = glyphs.map((g) => bbox(g)?.xMin ?? 0)
const rsbs = glyphs.map((g) => (bbox(g) ? g.advance - bbox(g).xMax : Infinity))

// ---- tables ----
const head = buf(54)
head.writeUInt32BE(0x00010000, 0)
head.writeUInt32BE(0x00010000, 4)
head.writeUInt32BE(0x5f0f3cf5, 12)
head.writeUInt16BE(0x0003, 16)
head.writeUInt16BE(UPM, 18)
head.writeInt16BE(all.xMin, 36)
head.writeInt16BE(all.yMin, 38)
head.writeInt16BE(all.xMax, 40)
head.writeInt16BE(all.yMax, 42)
head.writeUInt16BE(8, 46)
head.writeInt16BE(2, 48)
head.writeInt16BE(0, 50) // short loca

const hhea = buf(36)
hhea.writeUInt32BE(0x00010000, 0)
hhea.writeInt16BE(800, 4)
hhea.writeInt16BE(-200, 6)
hhea.writeUInt16BE(Math.max(...glyphs.map((g) => g.advance)), 10)
hhea.writeInt16BE(Math.min(...glyphs.filter((g) => bbox(g)).map((g) => bbox(g).xMin)), 12)
hhea.writeInt16BE(Math.min(...rsbs), 14)
hhea.writeInt16BE(all.xMax, 16)
hhea.writeInt16BE(1, 18)
hhea.writeUInt16BE(NUM_GLYPHS, 34)

const hmtx = buf(4 * NUM_GLYPHS)
glyphs.forEach((g, i) => {
  hmtx.writeUInt16BE(g.advance, 4 * i)
  hmtx.writeInt16BE(lsbs[i], 4 * i + 2)
})

const maxp = buf(32)
maxp.writeUInt32BE(0x00010000, 0)
maxp.writeUInt16BE(NUM_GLYPHS, 4)
maxp.writeUInt16BE(Math.max(...glyphs.map((g) => g.contours.flat().length)), 6)
maxp.writeUInt16BE(Math.max(...glyphs.map((g) => g.contours.length)), 8)
maxp.writeUInt16BE(2, 14) // maxZones

const os2 = buf(96)
os2.writeUInt16BE(4, 0)
os2.writeInt16BE(600, 2)
os2.writeUInt16BE(400, 4)
os2.writeUInt16BE(5, 6)
os2.writeInt16BE(650, 10)
os2.writeInt16BE(600, 12)
os2.writeInt16BE(75, 16)
os2.writeInt16BE(650, 18)
os2.writeInt16BE(600, 20)
os2.writeInt16BE(350, 24)
os2.writeInt16BE(50, 26)
os2.writeInt16BE(300, 28)
os2.writeUInt32BE(1, 42) // Basic Latin
os2.write('NONE', 58, 'ascii')
os2.writeUInt16BE(0x0040, 62) // regular
os2.writeUInt16BE(0x2c, 64)
os2.writeUInt16BE(0x39, 66)
os2.writeInt16BE(800, 68)
os2.writeInt16BE(-200, 70)
os2.writeUInt16BE(800, 74)
os2.writeUInt16BE(200, 76)
os2.writeUInt32BE(1, 78) // Latin 1
os2.writeInt16BE(500, 86)
os2.writeInt16BE(700, 88)
os2.writeUInt16BE(0x20, 92)

const names = [
  [1, 'Hidden Digits'],
  [2, 'Regular'],
  [3, 'HiddenDigits-Regular'],
  [4, 'Hidden Digits'],
  [5, 'Version 2.0'],
  [6, 'HiddenDigits-Regular']
]
const strings = names.map(([, s]) => Buffer.from(s, 'utf16le').swap16())
const nameHeader = buf(6 + 12 * names.length)
nameHeader.writeUInt16BE(names.length, 2)
nameHeader.writeUInt16BE(6 + 12 * names.length, 4)
let soff = 0
names.forEach(([id], i) => {
  const o = 6 + 12 * i
  nameHeader.writeUInt16BE(3, o)
  nameHeader.writeUInt16BE(1, o + 2)
  nameHeader.writeUInt16BE(0x0409, o + 4)
  nameHeader.writeUInt16BE(id, o + 6)
  nameHeader.writeUInt16BE(strings[i].length, o + 8)
  nameHeader.writeUInt16BE(soff, o + 10)
  soff += strings[i].length
})
const name = Buffer.concat([nameHeader, ...strings])

// cmap format 4: ',' -> comma, '.' -> period, '0'-'9' -> digits 1-10.
const segs = [
  [0x2c, 0x2c, G_COMMA - 0x2c],
  [0x2e, 0x2e, G_PERIOD - 0x2e],
  [0x30, 0x39, 1 - 0x30],
  [0xffff, 0xffff, 1]
]
const segX2 = 2 * segs.length
const sel = Math.floor(Math.log2(segs.length))
const fmt4body = Buffer.concat([u16(...segs.map((s) => s[1])), u16(0), u16(...segs.map((s) => s[0])), u16(...segs.map((s) => s[2])), u16(...segs.map(() => 0))])
const fmt4 = Buffer.concat([u16(4, 14 + fmt4body.length, 0, segX2, 2 * 2 ** sel, sel, segX2 - 2 * 2 ** sel), fmt4body])
const cmap = Buffer.concat([u16(0, 1, 3, 1), Buffer.from([0, 0, 0, 12]), fmt4])

const post = buf(32)
post.writeUInt32BE(0x00030000, 0)
post.writeInt16BE(-100, 8)
post.writeInt16BE(50, 10)

// ---- GSUB ----
const coverage = (ids) => u16(1, ids.length, ...[...ids].sort((a, b) => a - b))
// A table followed by the tables it points to; offsets are from the table's own start.
function withChildren(headerOf, children) {
  const headerLen = headerOf(children.map(() => 0)).length
  const offsets = []
  let o = headerLen
  for (const c of children) {
    offsets.push(o)
    o += c.length
  }
  return Buffer.concat([headerOf(offsets), ...children])
}
const singleSubst = (from, to) => withChildren(([cov]) => u16(2, cov, from.length, ...from.map(() => to)), [coverage(from)])
function chainSubst(back, input, ahead, lookupIndex) {
  const covs = [...back, ...input, ...ahead].map(coverage)
  return withChildren(
    (offs) => {
      const b = offs.slice(0, back.length)
      const i = offs.slice(back.length, back.length + input.length)
      const a = offs.slice(back.length + input.length)
      return u16(3, back.length, ...b, input.length, ...i, ahead.length, ...a, 1, 0, lookupIndex)
    },
    covs
  )
}
const lookup = (type, subtables) => withChildren((offs) => u16(type, 0, subtables.length, ...offs), subtables)
const NUMERIC = [...G_DIGITS, G_RUN, G_EMPTY] // what a digit sees behind it once the run has started
const L0 = lookup(6, [
  chainSubst([NUMERIC], [G_DIGITS], [], 2), // a digit inside a number: empty
  chainSubst([NUMERIC], [[G_COMMA, G_PERIOD]], [G_DIGITS], 2), // a comma or decimal point inside a number: empty
  chainSubst([], [G_DIGITS], [], 1) // the first digit: the fixed run of dots
])
const L1 = lookup(1, [singleSubst(G_DIGITS, G_RUN)])
const L2 = lookup(1, [singleSubst([...G_DIGITS, G_COMMA, G_PERIOD], G_EMPTY)])
const lookupList = withChildren((offs) => u16(3, ...offs), [L0, L1, L2])
const feature = u16(0, 1, 0)
const featureList = withChildren((offs) => Buffer.concat([u16(2), Buffer.from('calt'), u16(offs[0]), Buffer.from('rlig'), u16(offs[1])]), [feature, feature])
const langSys = u16(0, 0xffff, 2, 0, 1)
const script = Buffer.concat([u16(4, 0), langSys])
const scriptList = withChildren((offs) => Buffer.concat([u16(2), Buffer.from('DFLT'), u16(offs[0]), Buffer.from('latn'), u16(offs[1])]), [script, script])
const GSUB = withChildren((offs) => u16(1, 0, ...offs), [scriptList, featureList, lookupList])

// ---- assemble ----
const tables = { GSUB, 'OS/2': os2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post }
const tags = Object.keys(tables).sort((a, b) => Buffer.compare(Buffer.from(a, 'ascii'), Buffer.from(b, 'ascii')))
const numTables = tags.length
const entrySelector = Math.floor(Math.log2(numTables))
const searchRange = 16 * 2 ** entrySelector
const dir = buf(12 + 16 * numTables)
dir.writeUInt32BE(0x00010000, 0)
dir.writeUInt16BE(numTables, 4)
dir.writeUInt16BE(searchRange, 6)
dir.writeUInt16BE(entrySelector, 8)
dir.writeUInt16BE(numTables * 16 - searchRange, 10)
let offset = dir.length
const bodies = []
tags.forEach((tag, i) => {
  const data = tables[tag]
  const o = 12 + 16 * i
  dir.write(tag.padEnd(4, ' '), o, 'ascii')
  dir.writeUInt32BE(checksum(data), o + 4)
  dir.writeUInt32BE(offset, o + 8)
  dir.writeUInt32BE(data.length, o + 12)
  const padded = pad4(data)
  bodies.push(padded)
  offset += padded.length
})
const font = Buffer.concat([dir, ...bodies])
const headOffset = dir.readUInt32BE(12 + 16 * tags.indexOf('head') + 8)
font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8)
fs.writeFileSync(process.argv[2], font)
console.log('wrote ' + font.length + ' bytes to ' + process.argv[2])
