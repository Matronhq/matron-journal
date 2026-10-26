import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanTtsText, escapeXml, azureVoiceName, buildSsml, ttsCacheKey, resolveTtsCacheDir, resolveTtsKey, resolveTtsRegion,
  TtsError, TTS_ERROR_STATUS, TTS_VOICES, TTS_FORMATS, TTS_TEXT_MAX, TTS_CACHE_TTL_MS,
  DEFAULT_TTS_REGION, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, DEFAULT_TTS_DAILY_CHARS,
} from '../src/cloud-tts.js'

const tmpDir = (t, prefix = 'matron-tts-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---- The pure pieces: text, SSML, cache key, configuration ----

test('constants: the contract values', () => {
  assert.equal(DEFAULT_TTS_REGION, 'northeurope')
  assert.equal(DEFAULT_TTS_MODEL, 'MAI-Voice-2.1-Flash')
  assert.equal(DEFAULT_TTS_VOICE, 'en-GB-Harry')
  assert.equal(DEFAULT_TTS_DAILY_CHARS, 300000)
  assert.equal(TTS_TEXT_MAX, 2000)
  assert.equal(TTS_CACHE_TTL_MS, 86400000)
  assert.deepEqual(TTS_VOICES, [
    { id: 'en-GB-Harry', name: 'Harry', locale: 'en-GB', gender: 'male' },
    { id: 'en-GB-Emily', name: 'Emily', locale: 'en-GB', gender: 'female' },
  ])
  assert.deepEqual(TTS_FORMATS.mp3, { azure: 'audio-24khz-48kbitrate-mono-mp3', contentType: 'audio/mpeg', ext: 'mp3' })
  assert.deepEqual(TTS_FORMATS.wav, { azure: 'riff-16khz-16bit-mono-pcm', contentType: 'audio/wav', ext: 'wav' })
  assert.deepEqual(TTS_ERROR_STATUS, { bad_request: 400, unknown_voice: 400, tts_budget_exceeded: 429, tts_busy: 503, tts_failed: 502 })
  const e = new TtsError('tts_busy')
  assert.ok(e instanceof Error)
  assert.equal(e.code, 'tts_busy')
  assert.equal(e.status, 503)
})

test('cleanTtsText: trims, strips control characters and lone surrogates, keeps tab and newline, null for a non-string', () => {
  assert.equal(cleanTtsText('  Hello there.  '), 'Hello there.')
  assert.equal(cleanTtsText('a\u0000b\u0007c\u001bd\u007fe\u0085f￾g'), 'abcdefg')
  assert.equal(cleanTtsText('line one\n\tline two\r\n'), 'line one\n\tline two')
  assert.equal(cleanTtsText('ok 😀 done'), 'ok 😀 done', 'a whole emoji survives')
  assert.equal(cleanTtsText('half \ud83d pair'), 'half  pair', 'a lone surrogate is dropped')
  assert.equal(cleanTtsText(' \u0000\u0001 '), '')
  for (const bad of [undefined, null, 42, true, {}, ['x']]) assert.equal(cleanTtsText(bad), null, JSON.stringify(bad))
})

test('escapeXml and buildSsml: the five characters are escaped, so text can never become markup', () => {
  assert.equal(escapeXml(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &apos; f')
  assert.equal(escapeXml('&amp;'), '&amp;amp;', 'an entity in the text is text')
  assert.equal(azureVoiceName('en-GB-Harry', 'MAI-Voice-2.1-Flash'), 'en-GB-Harry:MAI-Voice-2.1-Flash')
  assert.equal(azureVoiceName('en-GB-RyanNeural', ''), 'en-GB-RyanNeural')
  assert.equal(
    buildSsml({ text: 'Tom & Jerry', voiceName: 'en-GB-Harry:MAI-Voice-2.1-Flash', locale: 'en-GB' }),
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-GB"><voice name="en-GB-Harry:MAI-Voice-2.1-Flash">Tom &amp; Jerry</voice></speak>'
  )
  const attack = '</voice><voice name="en-US-Evil"><break time="60s"/>hi'
  const ssml = buildSsml({ text: attack, voiceName: 'v', locale: 'en-GB' })
  assert.equal(ssml.match(/<voice /g).length, 1)
  assert.equal(ssml.match(/<\/voice>/g).length, 1)
  assert.ok(!ssml.includes('<break'))
  assert.ok(ssml.includes('&lt;/voice&gt;&lt;voice name=&quot;en-US-Evil&quot;&gt;&lt;break time=&quot;60s&quot;/&gt;hi'))
})

test('ttsCacheKey: sha256 of voice|model|format|text; any part changing changes the key', () => {
  const base = { voice: 'en-GB-Harry', model: 'MAI-Voice-2.1-Flash', format: 'mp3', text: 'Hello' }
  const k = ttsCacheKey(base)
  assert.equal(k, crypto.createHash('sha256').update('en-GB-Harry|MAI-Voice-2.1-Flash|mp3|Hello').digest('hex'))
  assert.match(k, /^[0-9a-f]{64}$/)
  assert.equal(ttsCacheKey({ ...base }), k)
  for (const change of [{ voice: 'en-GB-Emily' }, { model: 'other' }, { format: 'wav' }, { text: 'Hello.' }]) {
    assert.notEqual(ttsCacheKey({ ...base, ...change }), k, JSON.stringify(change))
  }
})

test('resolveTtsCacheDir: an override, else tts-cache beside the database', () => {
  assert.equal(resolveTtsCacheDir('/opt/matron-journal/data/matron.db'), '/opt/matron-journal/data/tts-cache')
  assert.equal(resolveTtsCacheDir('/opt/matron-journal/data/matron.db', '/var/cache/tts'), '/var/cache/tts')
})

test('resolveTtsKey: its own key, else its own key file, else the transcription key', (t) => {
  const dir = tmpDir(t, 'tts-key-')
  const own = path.join(dir, 'tts'); fs.writeFileSync(own, 'tts-from-file\n')
  const stt = path.join(dir, 'stt'); fs.writeFileSync(stt, 'stt-from-file\n')
  assert.equal(resolveTtsKey({ MATRON_TTS_AZURE_KEY: ' tts-env ', MATRON_STT_AZURE_KEY: 'stt-env' }), 'tts-env')
  assert.equal(resolveTtsKey({ MATRON_TTS_AZURE_KEY_FILE: own, MATRON_STT_AZURE_KEY: 'stt-env' }), 'tts-from-file')
  assert.equal(resolveTtsKey({ MATRON_STT_AZURE_KEY: ' stt-env ' }), 'stt-env')
  assert.equal(resolveTtsKey({ MATRON_STT_AZURE_KEY_FILE: stt }), 'stt-from-file')
  assert.equal(resolveTtsKey({}), '')
  assert.throws(() => resolveTtsKey({ MATRON_TTS_AZURE_KEY_FILE: path.join(dir, 'missing'), MATRON_STT_AZURE_KEY: 'stt-env' }), /ENOENT/, 'a set but unreadable file is not papered over by the fallback')
})

test('resolveTtsRegion: its own variable; else the transcription endpoint\'s region when the key is shared; else northeurope', () => {
  const logs = []
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  assert.equal(resolveTtsRegion({}, { log }), 'northeurope')
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_REGION: 'uksouth' }, { log }), 'uksouth')
  assert.equal(resolveTtsRegion({ MATRON_STT_AZURE_ENDPOINT: 'https://swedencentral.api.cognitive.microsoft.com' }, { log }), 'swedencentral')
  assert.equal(resolveTtsRegion({ MATRON_STT_AZURE_ENDPOINT: 'https://eastus2.api.cognitive.microsoft.com/' }, { log }), 'eastus2')
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_REGION: 'uksouth', MATRON_STT_AZURE_ENDPOINT: 'https://eastus2.api.cognitive.microsoft.com' }, { log }), 'uksouth')
  assert.equal(resolveTtsRegion({ MATRON_STT_AZURE_ENDPOINT: 'https://my-speech.cognitiveservices.azure.com' }, { log }), 'northeurope', 'a custom domain names no region')
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_KEY: 'own', MATRON_STT_AZURE_ENDPOINT: 'https://eastus2.api.cognitive.microsoft.com' }, { log }), 'northeurope', 'its own key is not tied to the transcription endpoint')
  assert.equal(logs.length, 0)
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_REGION: 'evil.example.com/x?' }, { log }), 'northeurope')
  assert.match(logs[0], /MATRON_TTS_AZURE_REGION.*not a region name/)
})
