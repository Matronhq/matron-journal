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
