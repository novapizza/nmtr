'use strict'

// Rasterises resources/logo.svg (the nmtr logo from novasuite.coding4pizza.com/nmtr)
// into every icon the app ships:
//   build/icon.ico            Windows installer / exe icon
//   build/icon.icns           macOS app icon
//   resources/icon.png        runtime window icon (256 px)
//   resources/tray-icon.png   runtime tray icon (16 px, + @2x / @3x variants)
// Run as `node build/generateIcon.js` — wired into `prebuild`.
//
// ICO and ICNS both accept PNG payloads (ICO since Vista), so every entry is a
// PNG rendered by resvg straight from the SVG.

const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')

const ROOT = path.join(__dirname, '..')
const SVG = fs.readFileSync(path.join(ROOT, 'resources', 'logo.svg'), 'utf8')

const cache = new Map()
function renderPng(size) {
  if (!cache.has(size)) {
    const png = new Resvg(SVG, { fitTo: { mode: 'width', value: size } }).render().asPng()
    cache.set(size, Buffer.from(png))
  }
  return cache.get(size)
}

function write(rel, buf, note = '') {
  const out = path.join(ROOT, rel)
  fs.writeFileSync(out, buf)
  console.log(`  • generateIcon: wrote ${rel} (${(buf.length / 1024).toFixed(1)} KB${note})`)
}

// ─── Windows .ico ────────────────────────────────────────────────────────────
// ICONDIR (6 bytes) + N × ICONDIRENTRY (16 bytes) + N × PNG payload.

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function buildIco() {
  const pngs = ICO_SIZES.map(renderPng)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  let offset = 6 + pngs.length * 16
  const entries = pngs.map((png, i) => {
    const size = ICO_SIZES[i]
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size // width  (0 = 256)
    e[1] = size >= 256 ? 0 : size // height (0 = 256)
    e[2] = 0 // palette
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    return e
  })
  return Buffer.concat([header, ...entries, ...pngs])
}

// ─── macOS .icns ─────────────────────────────────────────────────────────────
// 'icns' + u32 BE total length, then [OSType, u32 BE length, PNG bytes] entries.

const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64],
  ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512],
  ['ic09', 512], ['ic10', 1024]
]

function buildIcns() {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const png = renderPng(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const body = Buffer.concat(entries)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

write('build/icon.ico', buildIco(), `, ${ICO_SIZES.length} entries`)
write('build/icon.icns', buildIcns(), `, ${ICNS_TYPES.length} entries`)
write('resources/icon.png', renderPng(256))
write('resources/tray-icon.png', renderPng(16))
write('resources/tray-icon@2x.png', renderPng(32))
write('resources/tray-icon@3x.png', renderPng(48))
