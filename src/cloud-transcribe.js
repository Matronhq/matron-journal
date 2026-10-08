// Cloud speech-to-text for voice notes: Azure Speech fast transcription,
// MAI-Transcribe-2 by default. Optional by construction: with no key the
// journal keeps whatever it had before (whisper if MATRON_WHISPER_MODEL is
// set, nothing otherwise) and every bridge transcribes locally as it does
// today.
//
// Chosen from a bake-off on 49 real voice notes, each
// system given the same short word list as the whisper prompt:
// MAI-Transcribe-2 2.79% word error, 0/51 numbers wrong, 0.6 s median per
// note; whisper small with the prompt 3.51%, ~8 s. Azure's fast
// transcription does not store the audio it is sent.
//
// Same transcriber shape as transcribe.js — transcribeFile(diskPath,
// {signal, userId}) -> text — so items-transcribe.js runs either. `kind:
// 'cloud'` is what turns on transcription of chat voice notes at upload
// (blob-transcripts.js): a remote call costs this host nothing, whisper
// would cost it minutes of CPU per note.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_WHISPER_PROMPT, makeTranscriber } from './transcribe.js'

const execFileAsync = promisify(execFile)

export const DEFAULT_AZURE_ENDPOINT = 'https://northeurope.api.cognitive.microsoft.com'
export const DEFAULT_AZURE_MODEL = 'MAI-Transcribe-2'
export const AZURE_API_VERSION = '2025-10-15'

// The whisper prompt's vocabulary, as a phrase list: "Matron voice note.
// Matron, Claude, …, deploy." -> ['Matron', 'Claude', …, 'deploy'].
export const DEFAULT_PHRASES = DEFAULT_WHISPER_PROMPT.replace(/^[^.]*\.\s*/, '').replace(/\.$/, '').split(',').map((s) => s.trim()).filter(Boolean)

// Phrases plus this user's device names (box names are where most of the
// name errors were), deduped, restricted to the hostname shape a device name
// has. A failing lookup keeps the base list.
export function phrasesFor(base, deviceNames, userId) {
  let names = []
  if (typeof deviceNames === 'function' && userId != null) {
    try { names = deviceNames(userId) } catch { names = [] }
  }
  const ok = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && /^[\w.-]{1,40}$/.test(n))
  return [...new Set([...base, ...ok])]
}

// The key comes from MATRON_STT_AZURE_KEY, or from the file named by
// MATRON_STT_AZURE_KEY_FILE (so it need not sit in the unit's environment).
// Never logged.
export function resolveAzureKey(env = process.env) {
  if (env.MATRON_STT_AZURE_KEY) return env.MATRON_STT_AZURE_KEY.trim()
  if (env.MATRON_STT_AZURE_KEY_FILE) return fs.readFileSync(env.MATRON_STT_AZURE_KEY_FILE, 'utf8').trim()
  return ''
}

// Azure takes WAV, MP3 or FLAC; voice notes arrive as m4a/ogg/webm, so
// ffmpeg turns them into 16 kHz mono FLAC (about half a WAV's size).
async function toFlac(exec, diskPath, outPath, { timeout, signal }) {
  await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', diskPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'flac', '-y', outPath], { timeout, signal })
}

export function makeAzureTranscriber({
  key,
  endpoint = DEFAULT_AZURE_ENDPOINT,
  // '' = Azure's standard model (no enhanced mode).
  model = DEFAULT_AZURE_MODEL,
  // Locale hint. MAI takes a bare language ('en'); the standard model wants a
  // full locale ('en-GB').
  locale = model ? 'en' : 'en-GB',
  phrases = DEFAULT_PHRASES,
  deviceNames = null,
  // MAI's 'clean' drops fillers and false starts; it scored 2.79% against
  // verbatim's 3.43% on the bake-off set.
  style = 'clean',
  fetchImpl = globalThis.fetch,
  exec = execFileAsync,
  ffmpegTimeoutMs = 30000,
  requestTimeoutMs = 60000,
  // Parallel jobs this transcriber is worth: a remote call is I/O, not CPU.
  concurrency = 4,
} = {}) {
  if (!key) return null
  const url = `${String(endpoint).replace(/\/+$/, '')}/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSION}`
  return {
    kind: 'cloud',
    label: `Azure ${model || 'standard'} at ${new URL(url).host}`,
    concurrency,
    // diskPath -> transcript string. Throws on any failure, including audio
    // with no words in it; the caller records that as 'failed'.
    async transcribeFile(diskPath, { signal, userId = null } = {}) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
      const flacPath = path.join(tmpDir, 'audio.flac')
      try {
        await toFlac(exec, diskPath, flacPath, { timeout: ffmpegTimeoutMs, signal })
        const definition = {
          locales: [locale],
          phraseList: { phrases: phrasesFor(phrases, deviceNames, userId) },
          ...(model ? { enhancedMode: { enabled: true, model, modelOptions: { transcribeStyle: style } } } : {}),
        }
        const form = new FormData()
        form.append('audio', new Blob([fs.readFileSync(flacPath)], { type: 'audio/flac' }), 'audio.flac')
        form.append('definition', JSON.stringify(definition))
        const timeout = AbortSignal.timeout(requestTimeoutMs)
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Ocp-Apim-Subscription-Key': key },
          body: form,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        if (!res.ok) {
          // The body is Azure's {code, message}; it never echoes the key.
          const detail = (await res.text().catch(() => '')).slice(0, 200)
          throw new Error(`azure transcription HTTP ${res.status}: ${detail}`)
        }
        const body = await res.json()
        const text = (body.combinedPhrases ?? []).map((p) => p.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
        if (!text) throw new Error('empty transcription result')
        return text
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    },
  }
}

// The transcriber this journal runs: the cloud one when a key is configured,
// else whisper when MATRON_WHISPER_MODEL is, else none. A key that is set but
// unreadable is said loudly at boot and falls back, rather than failing every
// note quietly.
export function makeConfiguredTranscriber({ env = process.env, deviceNames = null, log = console, whisper = makeTranscriber } = {}) {
  let key = ''
  try { key = resolveAzureKey(env) } catch (err) {
    log.error(`transcribe: MATRON_STT_AZURE_KEY_FILE is set but unreadable (${err.code ?? err.message}) — cloud transcription is OFF`)
  }
  if (key) {
    const model = env.MATRON_STT_AZURE_MODEL ?? DEFAULT_AZURE_MODEL
    const t = makeAzureTranscriber({
      key,
      endpoint: env.MATRON_STT_AZURE_ENDPOINT || DEFAULT_AZURE_ENDPOINT,
      model,
      ...(env.MATRON_STT_LOCALE ? { locale: env.MATRON_STT_LOCALE } : {}),
      deviceNames,
    })
    log.log(`transcribe: voice notes are transcribed on upload by ${t.label}`)
    return t
  }
  return whisper({ deviceNames })
}
