import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { imageSizeFromBuffer, imageSizeFromFile } from '../src/image-size.js'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'images')
const fixture = (name) => path.join(dir, name)

test('image size: every format the apps upload reads its real dimensions', () => {
  for (const name of ['w40h30.png', 'w40h30.jpg', 'w40h30-prog.jpg', 'w40h30.gif', 'w40h30-lossy.webp',
    'w40h30-lossless.webp', 'w40h30-alpha.webp', 'w40h30.heic']) {
    assert.deepEqual(imageSizeFromFile(fixture(name)), { width: 40, height: 30 }, name)
  }
  assert.deepEqual(imageSizeFromFile(fixture('w30h40.heic')), { width: 30, height: 40 })
})

test('image size: a JPEG with EXIF orientation 6 reads as displayed (portrait), not as stored', () => {
  assert.deepEqual(imageSizeFromFile(fixture('w40h30-orient6.jpg')), { width: 30, height: 40 })
})

test('image size: a HEIC whose irot turns it a quarter turn reads as displayed', () => {
  const b = fs.readFileSync(fixture('w40h30.heic'))
  const at = b.indexOf('irot')
  assert.ok(at > 0, 'fixture carries an irot property')
  for (const [angle, want] of [[0, { width: 40, height: 30 }], [1, { width: 30, height: 40 }],
    [2, { width: 40, height: 30 }], [3, { width: 30, height: 40 }]]) {
    const c = Buffer.from(b)
    c[at + 4] = angle
    assert.deepEqual(imageSizeFromBuffer(c), want, `irot ${angle}`)
  }
})

test('image size: non-images, truncated and garbled headers are unknown (null), never a throw', () => {
  assert.equal(imageSizeFromBuffer(Buffer.from('hello, this is plain text, not an image')), null)
  assert.equal(imageSizeFromBuffer(Buffer.alloc(0)), null)
  assert.equal(imageSizeFromBuffer('not a buffer'), null)
  for (const name of fs.readdirSync(dir)) {
    const b = fs.readFileSync(fixture(name))
    for (const n of [4, 12, 20, 26]) assert.doesNotThrow(() => imageSizeFromBuffer(b.subarray(0, n)), `${name}[0:${n}]`)
  }
  // A PNG claiming a 0 × 0 or absurd size is a garbled header.
  const png = Buffer.from(fs.readFileSync(fixture('w40h30.png')))
  png.writeUInt32BE(0, 16)
  assert.equal(imageSizeFromBuffer(png), null)
  png.writeUInt32BE(1 << 20, 16)
  assert.equal(imageSizeFromBuffer(png), null)
  assert.equal(imageSizeFromFile(fixture('does-not-exist.png')), null)
})

test('image size: a JPEG whose SOF sits past the first 64 KB is still found', () => {
  const jpg = fs.readFileSync(fixture('w40h30.jpg'))
  // Splice a ~100 KB APP2 run (ICC-profile-sized) between SOI and the rest.
  const pads = []
  for (let i = 0; i < 2; i++) {
    const seg = Buffer.alloc(4 + 60000)
    seg[0] = 0xff; seg[1] = 0xe2; seg.writeUInt16BE(60002, 2)
    pads.push(seg)
  }
  const big = Buffer.concat([jpg.subarray(0, 2), ...pads, jpg.subarray(2)])
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-img-')), 'big.jpg')
  fs.writeFileSync(tmp, big)
  try {
    assert.deepEqual(imageSizeFromFile(tmp), { width: 40, height: 30 })
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  }
})

test('image size: an XMP APP1 after the EXIF one keeps the EXIF orientation (phone HDR / Lightroom JPEGs)', () => {
  const jpg = fs.readFileSync(fixture('w40h30-orient6.jpg'))
  // Find the end of the EXIF APP1 and splice an XMP APP1 right after it.
  const exifAt = jpg.indexOf(Buffer.from([0xff, 0xe1]))
  assert.ok(exifAt > 0 && jpg.toString('latin1', exifAt + 4, exifAt + 8) === 'Exif')
  const exifEnd = exifAt + 2 + jpg.readUInt16BE(exifAt + 2)
  const xmpBody = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')
  const xmp = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), xmpBody])
  xmp.writeUInt16BE(xmpBody.length + 2, 2)
  const spliced = Buffer.concat([jpg.subarray(0, exifEnd), xmp, jpg.subarray(exifEnd)])
  assert.deepEqual(imageSizeFromBuffer(spliced), { width: 30, height: 40 })
})

test('image size: an unsizable non-JPEG/HEIF image is read once, not retried at megabytes', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-img-')), 'big.svg')
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.alloc(3 * 1024 * 1024, 0x20)]))
  const reads = []
  const realRead = fs.readSync
  fs.readSync = (fd, buf, ...rest) => { reads.push(buf.length); return realRead(fd, buf, ...rest) }
  try {
    assert.equal(imageSizeFromFile(tmp), null)
    assert.deepEqual(reads, [64 * 1024])
  } finally {
    fs.readSync = realRead
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  }
})

test('image size: an identity irot sticks; a later irot (a thumbnail\'s) does not turn the primary', () => {
  const b = fs.readFileSync(fixture('w40h30.heic'))
  const at = b.indexOf('irot')
  // Append a second ipco property: a 90° irot after the identity one.
  const ipcoAt = b.indexOf('ipco') - 4
  const extra = Buffer.from([0, 0, 0, 9, 0x69, 0x72, 0x6f, 0x74, 1])
  const grow = (buf, off) => buf.writeUInt32BE(buf.readUInt32BE(off) + extra.length, off)
  const ipcoEnd = ipcoAt + b.readUInt32BE(ipcoAt)
  const c = Buffer.concat([b.subarray(0, ipcoEnd), extra, b.subarray(ipcoEnd)])
  c[at + 4] = 0
  // Grow every enclosing box: ipco, iprp, meta (all start before ipcoEnd and end at/after it).
  for (const name of ['ipco', 'iprp', 'meta']) grow(c, c.indexOf(name) - 4)
  assert.deepEqual(imageSizeFromBuffer(c), { width: 40, height: 30 })
})
