'use strict'

// Generates build/icon.ico (Windows) and build/icon.icns (macOS) from the same procedural {N} logo used at runtime
// (src/main/utils/logoIcon.ts). Run as `node build/generateIcon.js` — wired
// into `prebuild` so electron-builder always finds the file.
//
// ICO format: ICONDIR header + N × ICONDIRENTRY + N × image payload.
// Each payload is a 32bpp BITMAPINFOHEADER + BGRA bottom-up bitmap + 1-bit
// AND mask (we leave the AND mask all zeros — alpha channel handles
// transparency on Vista+).

const fs = require('fs')
const path = require('path')

const LBRACE = [
  [0, 1, 1],
  [0, 1, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 1, 1]
]

const N_GLYPH = [
  [1, 0, 0, 1],
  [1, 1, 0, 1],
  [1, 0, 1, 1],
  [1, 0, 0, 1],
  [1, 0, 0, 1]
]

// Emerald #34d399 — matches createLogoIcon
const FG_R = 0x34
const FG_G = 0xd3
const FG_B = 0x99

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4, 0)
  const s = Math.max(1, Math.floor(size / 8))
  const startY = Math.floor((size - 5 * s) / 2)

  const setPixel = (x, y) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return
    const idx = (y * size + x) * 4
    buf[idx]     = FG_R
    buf[idx + 1] = FG_G
    buf[idx + 2] = FG_B
    buf[idx + 3] = 0xff
  }

  const drawGlyph = (glyph, gx0) => {
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (!glyph[gy][gx]) continue
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            setPixel(gx0 + gx * s + dx, startY + gy * s + dy)
          }
        }
      }
    }
  }

  drawGlyph(LBRACE, 0)
  drawGlyph(N_GLYPH, (3 + 1) * s)
  return buf
}

function buildBmpPayload(size) {
  const rgba = renderRGBA(size)

  // Convert RGBA top-down → BGRA bottom-up (BMP storage order)
  const bgra = Buffer.alloc(rgba.length)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const srcIdx = ((size - 1 - y) * size + x) * 4
      const dstIdx = (y * size + x) * 4
      bgra[dstIdx]     = rgba[srcIdx + 2] // B
      bgra[dstIdx + 1] = rgba[srcIdx + 1] // G
      bgra[dstIdx + 2] = rgba[srcIdx]     // R
      bgra[dstIdx + 3] = rgba[srcIdx + 3] // A
    }
  }

  // BITMAPINFOHEADER (40 bytes). NOTE: inside an ICO, biHeight is twice the
  // bitmap height because the height encompasses both the XOR colour plane
  // and the AND mask plane.
  const bi = Buffer.alloc(40)
  bi.writeUInt32LE(40, 0)        // biSize
  bi.writeInt32LE(size, 4)       // biWidth
  bi.writeInt32LE(size * 2, 8)   // biHeight (XOR + AND)
  bi.writeUInt16LE(1, 12)        // biPlanes
  bi.writeUInt16LE(32, 14)       // biBitCount
  // Remaining fields (compression, sizeImage, etc.) all zero.

  // AND mask: 1 bit per pixel, each row padded to a 4-byte boundary.
  const andRowBytes = Math.ceil(size / 32) * 4
  const andMask = Buffer.alloc(andRowBytes * size, 0)

  return Buffer.concat([bi, bgra, andMask])
}

function buildIco(sizes) {
  const payloads = sizes.map((s) => ({ size: s, data: buildBmpPayload(s) }))

  const ICONDIR_SIZE = 6
  const ENTRY_SIZE = 16

  const header = Buffer.alloc(ICONDIR_SIZE)
  header.writeUInt16LE(0, 0)              // reserved
  header.writeUInt16LE(1, 2)              // type 1 = ICO
  header.writeUInt16LE(payloads.length, 4)

  const entries = Buffer.alloc(payloads.length * ENTRY_SIZE)
  let offset = ICONDIR_SIZE + payloads.length * ENTRY_SIZE
  payloads.forEach(({ size, data }, i) => {
    const base = i * ENTRY_SIZE
    // 256x256 is encoded as 0 in the width/height byte
    entries[base + 0] = size === 256 ? 0 : size
    entries[base + 1] = size === 256 ? 0 : size
    entries[base + 2] = 0   // bColorCount
    entries[base + 3] = 0   // bReserved
    entries.writeUInt16LE(1, base + 4)            // wPlanes
    entries.writeUInt16LE(32, base + 6)           // wBitCount
    entries.writeUInt32LE(data.length, base + 8)  // dwBytesInRes
    entries.writeUInt32LE(offset, base + 12)      // dwImageOffset
    offset += data.length
  })

  return Buffer.concat([header, entries, ...payloads.map((p) => p.data)])
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const ico = buildIco(SIZES)
const outPath = path.join(__dirname, 'icon.ico')
fs.writeFileSync(outPath, ico)
console.log(
  `  • generateIcon: wrote ${path.relative(process.cwd(), outPath)} ` +
  `(${(ico.length / 1024).toFixed(1)} KB, sizes: ${SIZES.join(', ')})`
)

// ─── macOS .icns ─────────────────────────────────────────────────────────────
//
// macOS icons sit on a rounded-square "squircle-ish" plate (Apple grid: 824/1024
// body, ~185/1024 corner radius) instead of a bare glyph, so the Mac variant
// draws the {N} glyph centred on the app's dark canvas colour.
//
// ICNS = 'icns' + u32 BE total length, then entries of [OSType, u32 BE length,
// PNG bytes]. Modern macOS reads PNG payloads for all of these types.

const zlib = require('zlib')

const BG = [0x1e, 0x1e, 0x24] // matches BrowserWindow backgroundColor

function renderMacRGBA(size) {
  const buf = Buffer.alloc(size * size * 4, 0)
  const body = size * (824 / 1024)
  const inset = (size - body) / 2
  const radius = size * (185 / 1024)
  const SS = 4 // supersampling for anti-aliased corners

  const inside = (x, y) => {
    const lx = x - inset, ly = y - inset
    if (lx < 0 || ly < 0 || lx > body || ly > body) return false
    const cx = Math.min(Math.max(lx, radius), body - radius)
    const cy = Math.min(Math.max(ly, radius), body - radius)
    return (lx - cx) ** 2 + (ly - cy) ** 2 <= radius * radius
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++
        }
      }
      if (!hits) continue
      const i = (y * size + x) * 4
      buf[i] = BG[0]; buf[i + 1] = BG[1]; buf[i + 2] = BG[2]
      buf[i + 3] = Math.round((hits / (SS * SS)) * 255)
    }
  }

  // Glyph: 8 × 5 logical px, ~55% of the plate width, centred.
  const s = Math.max(1, Math.floor((body * 0.55) / 8))
  const gx0 = Math.floor((size - 8 * s) / 2)
  const gy0 = Math.floor((size - 5 * s) / 2)
  const draw = (glyph, ox) => {
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (!glyph[gy][gx]) continue
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            const i = ((gy0 + gy * s + dy) * size + (ox + gx * s + dx)) * 4
            buf[i] = FG_R; buf[i + 1] = FG_G; buf[i + 2] = FG_B; buf[i + 3] = 0xff
          }
        }
      }
    }
  }
  draw(LBRACE, gx0)
  draw(N_GLYPH, gx0 + 4 * s)
  return buf
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // colour type RGBA
  // compression / filter / interlace = 0
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64],
  ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512],
  ['ic09', 512], ['ic10', 1024]
]

function buildIcns() {
  const cache = new Map()
  const entries = ICNS_TYPES.map(([type, size]) => {
    if (!cache.has(size)) cache.set(size, encodePng(renderMacRGBA(size), size))
    const png = cache.get(size)
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

const icns = buildIcns()
const icnsPath = path.join(__dirname, 'icon.icns')
fs.writeFileSync(icnsPath, icns)
console.log(
  `  • generateIcon: wrote ${path.relative(process.cwd(), icnsPath)} ` +
  `(${(icns.length / 1024).toFixed(1)} KB, ${ICNS_TYPES.length} entries)`
)
