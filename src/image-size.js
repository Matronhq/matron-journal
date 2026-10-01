import fs from 'node:fs'

// Pixel dimensions of an image blob, as DISPLAYED (spec: 2026-10-01 item
// thread layout shift). The apps reserve a placeholder of the image's real
// aspect ratio before the bytes arrive, so a thread doesn't jump as each image
// loads. The journal reads the header itself rather than trusting a size the
// uploader claims: it is the only party that sees every upload (apps, bridges,
// voice notes), and a wrong claim would reserve a wrong box forever.
//
// Covers what the apps and bridges actually upload: PNG, JPEG (with EXIF
// orientation, so an iPhone portrait shot reads portrait), GIF, WebP and
// HEIC/HEIF (ispe + irot). Anything else, or a truncated/garbled header,
// returns null — "unknown size", which the apps render as before.

const MAX_SIDE = 1 << 16 // 65536: anything bigger is a garbled header, not a photo

function ok(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) return null
  return { width, height }
}

function png(b) {
  // 8-byte signature, then the IHDR chunk: length(4) 'IHDR'(4) width(4) height(4).
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null
  return ok(b.readUInt32BE(16), b.readUInt32BE(20))
}

function gif(b) {
  if (b.length < 10 || b.toString('latin1', 0, 4) !== 'GIF8') return null
  return ok(b.readUInt16LE(6), b.readUInt16LE(8))
}

function webp(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X') return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
  return null
}

// EXIF orientation from an APP1 segment's payload (starting at 'Exif\0\0'),
// or null when the APP1 isn't EXIF (XMP shares the marker, and often follows
// the EXIF segment) so the caller keeps what EXIF said. 5–8 are the four
// orientations that turn the stored image a quarter turn.
function exifOrientation(b, start, end) {
  if (end - start < 14 || b.toString('latin1', start, start + 6) !== 'Exif\0\0') return null
  const tiff = start + 6
  const le = b.toString('latin1', tiff, tiff + 2) === 'II'
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > end) return 1
    if (u16(e) === 0x0112) return u16(e + 8)
  }
  return 1
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let orientation = 1
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i += 1; continue } // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue }
    const len = b.readUInt16BE(i + 2)
    if (len < 2) return null
    const seg = i + 4
    if (marker === 0xe1 && seg + len - 2 <= b.length) {
      try { orientation = exifOrientation(b, seg, seg + len - 2) ?? orientation } catch { /* keep what we had */ }
    }
    if (SOF.has(marker)) {
      if (seg + 5 > b.length) return null
      const h = b.readUInt16BE(seg + 1)
      const w = b.readUInt16BE(seg + 3)
      return orientation >= 5 && orientation <= 8 ? ok(h, w) : ok(w, h)
    }
    if (marker === 0xda || marker === 0xd9) return null // scan data before any SOF
    i = seg + len - 2
  }
  return null
}

// ISO-BMFF boxes (HEIC/HEIF/AVIF): walk to meta/iprp/ipco and read the image
// spatial extents ('ispe') and rotation ('irot'). A HEIC carries one ispe per
// item (tiles, thumbnail, primary); the primary image is the largest one.
function* boxes(b, start, end) {
  let i = start
  while (i + 8 <= end) {
    let size = b.readUInt32BE(i)
    const type = b.toString('latin1', i + 4, i + 8)
    let header = 8
    if (size === 1) {
      if (i + 16 > end) return
      size = Number(b.readBigUInt64BE(i + 8))
      header = 16
    } else if (size === 0) {
      size = end - i
    }
    if (size < header || i + size > end) return
    yield { type, start: i + header, end: i + size }
    i += size
  }
}

function child(b, box, type, skip = 0) {
  for (const c of boxes(b, box.start + skip, box.end)) if (c.type === type) return c
  return null
}

function heif(b) {
  if (b.length < 16 || b.toString('latin1', 4, 8) !== 'ftyp') return null
  const brands = b.toString('latin1', 8, Math.min(b.length, 8 + b.readUInt32BE(0) - 8))
  if (!/heic|heix|hevc|heim|heis|mif1|msf1|avif/.test(brands)) return null
  let meta = null
  for (const box of boxes(b, 0, b.length)) if (box.type === 'meta') { meta = box; break }
  if (!meta) return null
  const iprp = child(b, meta, 'iprp', 4) // meta is a FullBox: 4 bytes version+flags
  const ipco = iprp && child(b, iprp, 'ipco')
  if (!ipco) return null
  let best = null
  let rotate = null // the first irot wins, including an identity (0) one
  for (const p of boxes(b, ipco.start, ipco.end)) {
    if (p.type === 'ispe' && p.start + 12 <= p.end) {
      const w = b.readUInt32BE(p.start + 4)
      const h = b.readUInt32BE(p.start + 8)
      if (!best || w * h > best.w * best.h) best = { w, h }
    } else if (p.type === 'irot' && p.start < p.end && rotate === null) {
      rotate = b[p.start] & 0x3
    }
  }
  if (!best) return null
  return rotate === 1 || rotate === 3 ? ok(best.h, best.w) : ok(best.w, best.h)
}

// Pure: dimensions from the leading bytes of a file, or null.
export function imageSizeFromBuffer(b) {
  if (!Buffer.isBuffer(b) || b.length < 10) return null
  try {
    return png(b) || jpeg(b) || gif(b) || webp(b) || heif(b)
  } catch {
    return null // a header that lies about its own lengths
  }
}

// The header almost always sits in the first 64 KB. A JPEG with a large EXIF
// thumbnail or ICC profile can push the SOF further, and a HEIC's meta box can
// sit after a large mdat, so a miss retries with a bigger read before giving
// up — but only for those two: any other format's size is in its first bytes,
// and an image we can't size (SVG, TIFF) must not cost megabytes of
// synchronous reads on the event loop.
const READS = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024]
const mayNeedMore = (b) => (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8)
  || (b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp')

export function imageSizeFromFile(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    for (const want of READS) {
      const n = Math.min(want, size)
      const buf = Buffer.alloc(n)
      fs.readSync(fd, buf, 0, n, 0)
      const dims = imageSizeFromBuffer(buf)
      if (dims || n === size || !mayNeedMore(buf)) return dims
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
