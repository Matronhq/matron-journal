import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  makeAzureTranscriber, makeConfiguredTranscriber, makeChainedTranscriber, phrasesFor, resolveAzureKey,
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

// A transcriber stand-in: answers with `impl(diskPath, opts)` and counts calls.
function fakeTranscriber(impl, extra = {}) {
  const t = { calls: 0, ...extra, async transcribeFile(diskPath, opts) { t.calls++; return impl(diskPath, opts) } }
  return t
}

function logSpy() {
  const lines = []
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) }
}

const azureLike = (impl) => fakeTranscriber(impl, { kind: 'cloud', label: 'Azure X at host.example', concurrency: 4 })

test('chained: primary success never calls fallback', async () => {
  const primary = azureLike(async () => 'from azure')
  const fallback = fakeTranscriber(async () => 'from whisper')
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  assert.equal(await t.transcribeFile('/x'), 'from azure')
  assert.equal(fallback.calls, 0)
})

test('chained: primary throws → fallback text, one log line naming the primary label', async () => {
  const log = logSpy()
  const seen = []
  const primary = azureLike(async () => { throw new Error('azure transcription HTTP 503: busy') })
  const fallback = fakeTranscriber(async (diskPath, opts) => { seen.push([diskPath, opts.userId]); return 'from whisper' })
  const t = makeChainedTranscriber(primary, fallback, { log })
  assert.equal(await t.transcribeFile('/media/ab/abc', { userId: 7 }), 'from whisper')
  assert.deepEqual(seen, [['/media/ab/abc', 7]])
  assert.equal(log.lines.length, 1)
  assert.ok(log.lines[0].includes('Azure X at host.example'))
  assert.match(log.lines[0], /failed .*trying whisper/)
  assert.match(log.lines[0], /HTTP 503/)
})

test('chained: four concurrent primary failures run the fallback one at a time', async () => {
  let inflight = 0
  let maxInflight = 0
  const releases = []
  const primary = azureLike(async () => { throw new Error('down') })
  const fallback = fakeTranscriber(async (diskPath) => {
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    await new Promise((resolve) => releases.push(resolve))
    inflight--
    return `whisper ${diskPath}`
  })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  const runs = ['/a', '/b', '/c', '/d'].map((p) => t.transcribeFile(p))
  // Release whichever run is waiting, one at a time, until all four are done.
  for (let released = 0; released < 4; released++) {
    while (releases.length === 0) await new Promise((r) => setImmediate(r))
    assert.equal(inflight, 1)
    releases.shift()()
  }
  assert.deepEqual(await Promise.all(runs), ['whisper /a', 'whisper /b', 'whisper /c', 'whisper /d'])
  assert.equal(maxInflight, 1)
  assert.equal(fallback.calls, 4)
})

test('chained: a fallback failure does not stall the runs queued behind it', async () => {
  const primary = azureLike(async () => { throw new Error('down') })
  const fallback = fakeTranscriber(async (diskPath) => { if (diskPath === '/bad') throw new Error('whisper crashed'); return 'ok' })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  const [bad, good] = await Promise.allSettled([t.transcribeFile('/bad'), t.transcribeFile('/good')])
  assert.equal(bad.reason.message, 'whisper crashed')
  assert.equal(good.value, 'ok')
})

test('chained: aborted signal skips the fallback and rethrows', async () => {
  const ac = new AbortController()
  const primary = azureLike(async () => { ac.abort(); throw new Error('This operation was aborted') })
  const fallback = fakeTranscriber(async () => 'from whisper')
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  await assert.rejects(t.transcribeFile('/x', { signal: ac.signal }), /aborted/)
  assert.equal(ac.signal.aborted, true)
  assert.equal(fallback.calls, 0)
})

test('chained: a request aborted while queued for the fallback never starts it', async () => {
  let release
  const primary = azureLike(async () => { throw new Error('down') })
  const fallback = fakeTranscriber(async () => { await new Promise((r) => { release = r }); return 'from whisper' })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  const first = t.transcribeFile('/first')
  const ac = new AbortController()
  const second = t.transcribeFile('/second', { signal: ac.signal })
  while (!release) await new Promise((r) => setImmediate(r))
  ac.abort()
  release()
  assert.equal(await first, 'from whisper')
  await assert.rejects(second, /down/)
  assert.equal(fallback.calls, 1)
})

test('chained: fallback throw propagates', async () => {
  const primary = azureLike(async () => { throw new Error('azure down') })
  const fallback = fakeTranscriber(async () => { throw new Error('empty transcription result') })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  await assert.rejects(t.transcribeFile('/x'), { message: 'empty transcription result' })
})

test('chained: kind, label and concurrency come from the primary', () => {
  const t = makeChainedTranscriber(azureLike(async () => ''), fakeTranscriber(async () => ''), { log: logSpy() })
  assert.equal(t.kind, 'cloud')
  assert.equal(t.label, 'Azure X at host.example, then whisper.cpp')
  assert.equal(t.concurrency, 4)
})

test('makeConfiguredTranscriber: key + whisper → chain', async () => {
  const log = logSpy()
  const whisperT = fakeTranscriber(async () => 'from whisper')
  const t = makeConfiguredTranscriber({
    env: { MATRON_STT_AZURE_KEY: 'sekrit' },
    log,
    whisper: () => whisperT,
  })
  assert.equal(t.kind, 'cloud')
  assert.match(t.label, /^Azure MAI-Transcribe-2 at northeurope\..*, then whisper\.cpp$/)
  assert.equal(t.concurrency, 4)
  assert.ok(log.lines.some((l) => l.includes(t.label)))
  assert.ok(log.lines.every((l) => !l.includes('sekrit')))
})

test('makeConfiguredTranscriber: key + no whisper → plain azure', () => {
  const log = logSpy()
  const t = makeConfiguredTranscriber({ env: { MATRON_STT_AZURE_KEY: 'sekrit' }, log, whisper: () => null })
  assert.equal(t.kind, 'cloud')
  assert.doesNotMatch(t.label, /whisper/)
  assert.ok(log.lines.some((l) => l.includes(t.label)))
})
