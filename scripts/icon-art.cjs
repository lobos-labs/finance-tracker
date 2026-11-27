// The app icon's artwork, shared by scripts/make-icon.cjs (resources/icon.png
// and icon.ico) and scripts/make-appx-assets.cjs (the Microsoft Store tiles).

const INK = '#0a0a0b'

const DEFS = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1a1d"/><stop offset="1" stop-color="${INK}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.1" r="0.75">
      <stop offset="0" stop-color="#d4a574" stop-opacity="0.22"/><stop offset="1" stop-color="#d4a574" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cu" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e8c79e"/><stop offset="1" stop-color="#c28b4d"/>
    </linearGradient>
  </defs>`

// Copper frame around rising bars, in the full icon's 256-unit square; it is centred on 128,128.
const MARK = `
  <rect x="58" y="58" width="140" height="140" fill="none" stroke="url(#cu)" stroke-width="7"/>
  <path d="M80 172h96" stroke="#c99459" stroke-width="6"/>
  <rect x="88" y="132" width="20" height="30" fill="url(#cu)"/>
  <rect x="118" y="106" width="20" height="56" fill="url(#cu)"/>
  <rect x="148" y="80" width="20" height="82" fill="url(#cu)"/>`
const MARK_SPAN = 147 // the frame's outer edge, stroke included: 54.5 to 201.5

// Just the bars, in a 64-unit square centred on 32,32: what stays legible at 16-24px.
const BARS = `
  <rect x="11" y="36" width="11" height="17" fill="#d4a574"/>
  <rect x="26.5" y="24" width="11" height="29" fill="#d4a574"/>
  <rect x="42" y="11" width="11" height="42" fill="#d4a574"/>`
const BARS_SPAN = 42

// Full mark: copper frame around rising bars, on an ink tile.
const FULL = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${DEFS}
  <rect x="8" y="8" width="240" height="240" rx="54" fill="url(#bg)"/>
  <rect x="8" y="8" width="240" height="240" rx="54" fill="url(#glow)"/>
  <rect x="8.75" y="8.75" width="238.5" height="238.5" rx="53.25" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.5"/>${MARK}
</svg>`

// Small sizes drop the frame so the bars stay legible at 16–24px.
const SMALL = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="1" y="1" width="62" height="62" rx="13" fill="#141416"/>${BARS}
</svg>`

/** The icon as an SVG drawn at `size` pixels: the bars alone up to 24px, the full mark above, as in icon.ico. */
function iconSvg(size) {
  return (size <= 24 ? SMALL : FULL).replace('<svg ', `<svg width="${size}" height="${size}" `)
}

/**
 * A full-bleed tile `width` x `height` in flat ink (the manifest's tile colour,
 * so the edges meet it exactly) with the mark centred, its frame `fraction` of
 * the shorter side. `bars` draws the bars alone (for small tiles).
 */
function tileSvg(width, height, { fraction = 0.5, bars = false } = {}) {
  const side = Math.min(width, height) * fraction
  const scale = side / (bars ? BARS_SPAN : MARK_SPAN)
  const centre = bars ? 32 : 128
  const body = bars ? BARS : MARK
  const r = (n) => Math.round(n * 1000) / 1000
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${DEFS}
  <rect width="${width}" height="${height}" fill="${INK}"/>
  <g transform="translate(${r(width / 2)} ${r(height / 2)}) scale(${r(scale)}) translate(${-centre} ${-centre})">${body}
  </g>
</svg>`
}

module.exports = { INK, FULL, SMALL, iconSvg, tileSvg }
