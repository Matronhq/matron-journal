import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  makeAzureTranscriber, makeConfiguredTranscriber, phrasesFor, resolveAzureKey,
  DEFAULT_PHRASES, DEFAULT_AZURE_ENDPOINT, AZURE_API_VERSION,
} from '../src/cloud-transcribe.js'

// ffmpeg stand-in: writes a few bytes where the FLAC would go.
function fakeExec(calls = []) {
  return async (cmd, args) => {
    calls.push([cmd, args])
    fs.writeFileSync(args[args.length - 1], 'flac')
    return { stdout: '' }
  }
}

// fetch stand-in recording the request and answering with `reply`.
function fakeFetch(reply, seen = []) {
  return async (url, init) => {
    const definition = JSON.parse(init.body.get('definition'))
    seen.push({ url, headers: init.headers, definition, audio: init.body.get('audio'), signal: init.signal })
    if (reply instanceof Error) throw reply
    return {
      ok: reply.status === undefined || reply.status < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    }
  }
}

test('no key: no cloud transcriber', () => {
  assert.equal(makeAzureTranscriber({ key: '' }), null)
  assert.equal(makeAzureTranscriber({}), null)
})

test('MAI request: flac upload, enhanced mode, clean style, phrases with box names; words joined', async () => {
  const seen = []
  const execCalls = []
  const t = makeAzureTranscriber({
    key: 'k-123',
    fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'Deploy  to' }, { text: 'alice-mac now.' }] } }, seen),
    exec: fakeExec(execCalls),
    deviceNames: (uid) => (uid === 7 ? ['alice-mac', 'pat', 'bad name; rm -rf'] : []),
  })
  assert.equal(t.kind, 'cloud')
  assert.equal(await t.transcribeFile('/media/ab/abc', { userId: 7 }), 'Deploy to alice-mac now.')
  assert.equal(execCalls[0][0], 'ffmpeg')
  assert.ok(execCalls[0][1].includes('/media/ab/abc'))
  assert.equal(seen[0].url, `${DEFAULT_AZURE_ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSION}`)
  assert.equal(seen[0].headers['Ocp-Apim-Subscription-Key'], 'k-123')
  assert.equal(seen[0].audio.type, 'audio/flac')
  assert.deepEqual(seen[0].definition.locales, ['en'])
  assert.deepEqual(seen[0].definition.enhancedMode, { enabled: true, model: 'MAI-Transcribe-2', modelOptions: { transcribeStyle: 'clean' } })
  assert.deepEqual(seen[0].definition.phraseList.phrases, [...DEFAULT_PHRASES, 'alice-mac', 'pat'])
})

test('standard model: no enhanced mode, en-GB locale, custom endpoint without a doubled slash', async () => {
  const seen = []
  const t = makeAzureTranscriber({ key: 'k', model: '', endpoint: 'https://uksouth.api.cognitive.microsoft.com/', fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'hi' }] } }, seen), exec: fakeExec() })
  await t.transcribeFile('/x')
  assert.ok(seen[0].url.startsWith('https://uksouth.api.cognitive.microsoft.com/speechtotext/'))
  assert.equal(seen[0].definition.enhancedMode, undefined)
  assert.deepEqual(seen[0].definition.locales, ['en-GB'])
})

test('failures throw: HTTP error, empty result; the temp dir is removed either way', async () => {
  const calls = []
  const bad = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ status: 400, body: { code: 'InvalidRequest', message: 'nope' } }), exec: fakeExec(calls) })
  await assert.rejects(bad.transcribeFile('/x'), /HTTP 400: .*InvalidRequest/)
  const empty = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: '  ' }] } }), exec: fakeExec(calls) })
  await assert.rejects(empty.transcribeFile('/x'), /empty transcription/)
  const none = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: {} }), exec: fakeExec(calls) })
  await assert.rejects(none.transcribeFile('/x'), /empty transcription/)
  assert.equal(calls.length, 3)
  for (const [, args] of calls) assert.equal(fs.existsSync(path.dirname(args[args.length - 1])), false)
})

test('an HTTP error message never carries the key', async () => {
  const t = makeAzureTranscriber({ key: 'super-secret', fetchImpl: fakeFetch({ status: 401, body: { error: 'unauthorized' } }), exec: fakeExec() })
  await assert.rejects(t.transcribeFile('/x'), (err) => !String(err.message).includes('super-secret'))
})

test('the caller signal reaches the request (journal shutdown aborts it)', async () => {
  const seen = []
  const t = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'x' }] } }, seen), exec: fakeExec() })
  const ac = new AbortController()
  await t.transcribeFile('/x', { signal: ac.signal })
  ac.abort()
  assert.equal(seen[0].signal.aborted, true)
})

test('phrasesFor: dedupes, keeps the base on a throwing lookup', () => {
  assert.deepEqual(phrasesFor(['a', 'b'], () => ['b', 'c'], 1), ['a', 'b', 'c'])
  assert.deepEqual(phrasesFor(['a'], () => { throw new Error('db') }, 1), ['a'])
  assert.deepEqual(phrasesFor(['a'], () => ['x'], null), ['a'])
  assert.ok(DEFAULT_PHRASES.includes('Matron') && DEFAULT_PHRASES.includes('merge train') && !DEFAULT_PHRASES.some((p) => p.includes('.')))
})

test('resolveAzureKey: env value, else key file, else empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-key-'))
  const f = path.join(dir, 'key')
  fs.writeFileSync(f, 'from-file\n')
  assert.equal(resolveAzureKey({ MATRON_STT_AZURE_KEY: ' from-env ' }), 'from-env')
  assert.equal(resolveAzureKey({ MATRON_STT_AZURE_KEY_FILE: f }), 'from-file')
  assert.equal(resolveAzureKey({}), '')
})

test('makeConfiguredTranscriber: cloud when keyed (key never logged), whisper otherwise, loud fallback on an unreadable key file', () => {
  const logs = []
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  const whisper = () => ({ kind: 'whisper' })
  const cloud = makeConfiguredTranscriber({ env: { MATRON_STT_AZURE_KEY: 'sekrit', MATRON_STT_AZURE_MODEL: '' }, log, whisper })
  assert.equal(cloud.kind, 'cloud')
  assert.match(cloud.label, /standard at northeurope/)
  assert.ok(logs.every((l) => !l.includes('sekrit')))
  assert.equal(makeConfiguredTranscriber({ env: {}, log, whisper }).kind, 'whisper')
  logs.length = 0
  assert.equal(makeConfiguredTranscriber({ env: { MATRON_STT_AZURE_KEY_FILE: '/nonexistent/key' }, log, whisper }).kind, 'whisper')
  assert.match(logs[0], /unreadable.*OFF/)
})
