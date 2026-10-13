// Local text embeddings for the similar tier (spec 2026-10-12 unified
// search §5). The model runs in this process; no tracker or message text
// ever leaves the journal. The package is an optional dependency loaded on
// first use — a missing package, a missing model directory or a failed
// load all mean "no similar tier", never a failed boot or a failed request.
import { createHash } from 'node:crypto'

export const MODEL_ID = 'Xenova/bge-small-en-v1.5'
export const DIM = 384
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '
const MAX_CHARS = 2000 // ~512 tokens; longer text is truncated by the tokenizer anyway

// `modelDir` seeds (or caches) the model files so no request-time network
// call is needed in normal operation (MATRON_SEMANTIC_MODEL_DIR).
// `allowDownload: false` is for tests and for a
// pre-seeded production box: never reach the network.
export async function loadEmbedder({ modelDir, allowDownload = true, log = console.log } = {}) {
  let tf
  try {
    tf = await import('@huggingface/transformers')
  } catch {
    log('semantic search off: @huggingface/transformers not installed')
    return null
  }
  try {
    tf.env.cacheDir = modelDir
    tf.env.localModelPath = modelDir
    tf.env.allowRemoteModels = allowDownload
    const fe = await tf.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
    const run = async (texts) => {
      const out = await fe(texts.map((t) => t.slice(0, MAX_CHARS)), { pooling: 'cls', normalize: true })
      const [n, dim] = out.dims
      return Array.from({ length: n }, (_, i) => Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)))
    }
    return {
      model: `${MODEL_ID}@q8`,
      dim: DIM,
      embedDocs: run,
      embedQuery: async (text) => (await run([QUERY_PREFIX + text]))[0],
    }
  } catch (err) {
    log(`semantic search off: model failed to load (${err.message})`)
    return null
  }
}

const normalise = (v) => {
  const n = Math.hypot(...v) || 1
  return Float32Array.from(v, (x) => x / n)
}

function hashVec(text, dim) {
  const h = createHash('sha256').update(text).digest()
  return normalise(Array.from({ length: dim }, (_, i) => h[i % h.length] - 128))
}

// Tests only: deterministic vectors, no model, no network. A text listed in
// `vectors` gets that vector (normalised, after the caller's own geometry);
// any other text gets a hash-seeded vector, stable across calls. `embedQuery`
// looks up `vectors[text]` directly, without a query prefix — the prefix is
// the real embedder's own private concern, not part of this contract.
export function fakeEmbedder({ dim = 16, vectors = {} } = {}) {
  const vec = (t) => (vectors[t] ? normalise(vectors[t]) : hashVec(t, dim))
  return {
    model: `fake-${dim}`,
    dim,
    embedDocs: async (texts) => texts.map(vec),
    embedQuery: async (text) => vec(text),
  }
}
