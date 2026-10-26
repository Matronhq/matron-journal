// Cloud text-to-speech for voice mode: Azure Speech, MAI-Voice-2.1-Flash by
// default (spec 2026-10-03 voice mode, section 2). Optional by construction:
// with no key makeCloudTts returns null, POST /tts answers 501 and the app
// speaks with the on-device voice.
//
// One object, two callers. The HTTP route (src/tts-http.js) hands it a
// client's text; a later server-side caller (the spoken notification, phase
// 3 of the spec) calls synthesize({userId, text, format: 'wav'}) directly.
// Both get the same validation, cache, budget and concurrency cap.
//
// The text is the only thing a caller controls. It is stripped of control
// characters, XML-escaped and placed inside one <voice> element; the voice
// comes from an allow-list and the format from a fixed table, so no caller
// can put markup into the SSML.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAzureKey } from './cloud-transcribe.js'

export const DEFAULT_TTS_REGION = 'northeurope'
export const DEFAULT_TTS_MODEL = 'MAI-Voice-2.1-Flash'
export const DEFAULT_TTS_VOICE = 'en-GB-Harry'
export const DEFAULT_TTS_DAILY_CHARS = 300000
export const TTS_TEXT_MAX = 2000
export const TTS_CACHE_TTL_MS = 24 * 3600000
// Azure's speech endpoint refuses a request with no User-Agent.
export const TTS_USER_AGENT = 'matron-journal'

// The voices on offer. The Azure voice name is `<id>:<model>`.
export const TTS_VOICES = Object.freeze([
  Object.freeze({ id: 'en-GB-Harry', name: 'Harry', locale: 'en-GB', gender: 'male' }),
  Object.freeze({ id: 'en-GB-Emily', name: 'Emily', locale: 'en-GB', gender: 'female' }),
])

// mp3 for playing in the app; wav (PCM) for notification sounds, which iOS
// will not play from mp3.
export const TTS_FORMATS = Object.freeze({
  mp3: Object.freeze({ azure: 'audio-24khz-48kbitrate-mono-mp3', contentType: 'audio/mpeg', ext: 'mp3' }),
  wav: Object.freeze({ azure: 'riff-16khz-16bit-mono-pcm', contentType: 'audio/wav', ext: 'wav' }),
})

export const TTS_ERROR_STATUS = Object.freeze({
  bad_request: 400,
  unknown_voice: 400,
  tts_budget_exceeded: 429,
  tts_busy: 503,
  tts_failed: 502,
})

// Every refusal synthesize() makes. `code` is the wire error; `status` its
// HTTP status. The message never carries the text or the key.
export class TtsError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'TtsError'
    this.code = code
    this.status = TTS_ERROR_STATUS[code] ?? 500
  }
}

// What XML 1.0 cannot carry (C0 controls other than tab, LF and CR), DEL and
// the C1 controls, the two non-characters, and U+FFFD (what toWellFormed
// leaves in place of a lone surrogate).
const UNSPEAKABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�￾￿]/g

// The text as it is hashed, counted and spoken: control characters removed,
// then trimmed. null for anything that is not a string.
export function cleanTtsText(raw) {
  if (typeof raw !== 'string') return null
  return raw.toWellFormed().replace(UNSPEAKABLE, '').trim()
}

const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => XML_ENTITIES[c])
}

export function azureVoiceName(id, model) {
  return model ? `${id}:${model}` : id
}

export function buildSsml({ text, voiceName, locale }) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(locale)}">` +
    `<voice name="${escapeXml(voiceName)}">${escapeXml(text)}</voice></speak>`
}

// sha256 of `voice|model|format|text`. voice, model and format come from
// fixed sets with no `|` in them and the text is last, so two different
// requests cannot share a key.
export function ttsCacheKey({ voice, model, format, text }) {
  return crypto.createHash('sha256').update(`${voice}|${model}|${format}|${text}`).digest('hex')
}

// Clips live beside the database, in their own directory: never in the media
// store, whose blobs are user-owned rows that count against the user's quota
// and are only reaped under quota pressure.
export function resolveTtsCacheDir(dbPath, override) {
  return override || path.join(path.dirname(dbPath), 'tts-cache')
}

// MATRON_TTS_AZURE_KEY, or the file named by MATRON_TTS_AZURE_KEY_FILE. With
// neither set, the transcription key (cloud-transcribe.js): it is the same
// Azure Speech resource. Never logged.
export function resolveTtsKey(env = process.env) {
  if (env.MATRON_TTS_AZURE_KEY) return env.MATRON_TTS_AZURE_KEY.trim()
  if (env.MATRON_TTS_AZURE_KEY_FILE) return fs.readFileSync(env.MATRON_TTS_AZURE_KEY_FILE, 'utf8').trim()
  return resolveAzureKey(env)
}

const REGION_RE = /^[a-z0-9]{2,40}$/
const STT_REGIONAL_ENDPOINT_RE = /^https:\/\/([a-z0-9]{2,40})\.api\.cognitive\.microsoft\.com\/?$/

// MATRON_TTS_AZURE_REGION when it has a region's shape. Otherwise, when the
// key in use is the transcription key and MATRON_STT_AZURE_ENDPOINT is a
// regional endpoint, that endpoint's region (a key only works in its own
// region). Otherwise northeurope. A custom-domain transcription endpoint
// names no region, so it is never guessed from.
export function resolveTtsRegion(env = process.env, { log = console } = {}) {
  const raw = env.MATRON_TTS_AZURE_REGION
  if (raw) {
    if (REGION_RE.test(raw)) return raw
    log.error(`tts: MATRON_TTS_AZURE_REGION=${JSON.stringify(raw)} is not a region name (e.g. northeurope) — ignored`)
  }
  const ownKey = !!(env.MATRON_TTS_AZURE_KEY || env.MATRON_TTS_AZURE_KEY_FILE)
  const m = ownKey ? null : STT_REGIONAL_ENDPOINT_RE.exec(env.MATRON_STT_AZURE_ENDPOINT || '')
  return m ? m[1] : DEFAULT_TTS_REGION
}
