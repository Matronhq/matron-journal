import test from 'node:test'
import assert from 'node:assert/strict'
import { boxLetters, boxLetterFor, sessionShortFromTitle, sideTag, roomTitle, ROOM_TITLE_MAX } from '../src/room-title.js'

// Ports of matron-bridge lib/box-letters.js — every case has a twin there
// and in MatronShared/Tests/ChatTests/SessionTagTests.swift.
test('boxLetters strips the prefix common to ALL names', () => {
  assert.deepEqual(boxLetters(['dev-y', 'dev-z']), ['Y', 'Z'])
  assert.deepEqual(boxLetters(['mac-mini', 'box-3']), ['M', 'B'])
  assert.deepEqual(boxLetters(['box', 'box-2']), ['B', '2'])
  assert.deepEqual(boxLetters(['Dev-y', 'dev-z']), ['Y', 'Z'])
  assert.deepEqual(boxLetters(['', 'dev-y', 'dev-z']), ['?', 'Y', 'Z'])
  assert.deepEqual(boxLetters(['---']), ['?'])
})

test('boxLetterFor derives against the roster and honours a tag_char override', () => {
  assert.equal(boxLetterFor('dev-z', ['dev-y', 'dev-z']), 'Z')
  assert.equal(boxLetterFor('opal', ['box-6']), 'O') // absent from the set: added before deriving
  assert.equal(boxLetterFor('dev-z', ['dev-y', 'dev-z'], '🦊'), '🦊')
  assert.equal(boxLetterFor('dev-z', ['dev-y', 'dev-z'], '  '), 'Z')
})

test('sessionShortFromTitle reads the bridge-baked short, through markers, and nothing else', () => {
  assert.equal(sessionShortFromTitle('[2h] Remote work'), '2h')
  assert.equal(sessionShortFromTitle('🐣 [cd] child task'), 'cd')
  assert.equal(sessionShortFromTitle('↔️ [2h] mac ↔️ box-2 — ci triage'), '2h')
  assert.equal(sessionShortFromTitle('🔗 [2h] mac ↔ box-2'), '2h')
  assert.equal(sessionShortFromTitle('[WIP] ship it'), '')
  assert.equal(sessionShortFromTitle('[2h]no space'), '')
  assert.equal(sessionShortFromTitle('[2h] '), '')
  assert.equal(sessionShortFromTitle('D:ab ↔️ E:cd — topic'), '')
  assert.equal(sessionShortFromTitle(null), '')
})

test('sideTag is Letter:short when the short is known, else the plain label', () => {
  const names = ['box-6', 'opal']
  assert.equal(sideTag({ name: 'box-6', short: 'ab', names }), 'B:ab')
  assert.equal(sideTag({ name: 'opal', short: '', names }), 'opal')
  assert.equal(sideTag({ name: 'opal', short: 'cd', names, override: '🦊' }), '🦊:cd')
  assert.equal(sideTag({ name: null, short: 'cd', names, label: 'device 9' }), 'device 9')
})

test('roomTitle joins the two sides with an optional topic and caps the length', () => {
  assert.equal(roomTitle('D:ab', 'E:cd', 'ci triage'), 'D:ab ↔️ E:cd — ci triage')
  assert.equal(roomTitle('D:ab', 'opal', ''), 'D:ab ↔️ opal')
  assert.equal(roomTitle('D:ab', 'E:cd', 'x'.repeat(300)).length, ROOM_TITLE_MAX)
})
