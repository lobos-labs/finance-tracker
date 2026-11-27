// Renders the app icon (SVG, in scripts/icon-art.cjs) with Electron and writes
// resources/icon.png and resources/icon.ico. Run with: npm run icon
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { FULL, SMALL } = require('./icon-art.cjs')

const OUT = path.join(__dirname, '..', 'resources')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

// Both designs drawn side by side at 512px in one page, then cropped apart.
function page() {
  const sized = (svg) => svg.replace('<svg ', '<svg width="512" height="512" ')
  return `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden;display:flex">
    <div style="width:512px;height:512px">${sized(FULL)}</div><div style="width:512px;height:512px">${sized(SMALL)}</div>
  </body></html>`
}

async function render() {
  const win = new BrowserWindow({ width: 1024, height: 512, useContentSize: true, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  let last = null
  win.webContents.on('paint', (_e, _dirty, img) => {
    if (!img.isEmpty()) last = img
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page()))
  for (let i = 0; i < 20 && !last; i++) {
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, 300))
  if (!last) throw new Error('Nothing painted')
  // The paint buffer is larger than the window on high-DPI screens.
  const scale = last.getSize().width / 1024
  const crop = (x) => last.crop({ x: Math.round(x * scale), y: 0, width: Math.round(512 * scale), height: Math.round(512 * scale) }).resize({ width: 512, height: 512, quality: 'best' })
  return { big: crop(0), small: crop(512) }
}

// ICO with PNG-encoded entries (supported since Windows Vista).
function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  try {
    const { big, small } = await render()
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'icon.png'), big.toPNG())
    const entries = ICO_SIZES.map((size) => {
      const source = size <= 24 ? small : big
      return { size, data: source.resize({ width: size, height: size, quality: 'best' }).toPNG() }
    })
    fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(entries))
    console.log(`wrote ${path.join(OUT, 'icon.png')} (${big.getSize().width}px) and icon.ico (${ICO_SIZES.join(', ')})`)
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.quit()
})
