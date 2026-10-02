// Voice notes transcribed at upload. When the journal has a cloud transcriber
// (cloud-transcribe.js), every audio blob a user's app uploads is sent off
// the moment POST /media stores it; the words land on the blob row
// (blobs.transcript, blobs.transcript_status), and the bridge that later
// gets the chat message asks GET /media/:id/transcript for them instead of
// fetching the audio and running its own whisper. A 30-second note is
// usually done before the app has even sent the message that names it.
//
// Off without a cloud transcriber: a whisper-only journal keeps transcribing
// item voice notes alone (items-transcribe.js), since doing every chat note
// too would put minutes of CPU per note on the journal host.
//
// Status on the row: NULL = never asked (the bridge does it, as before),
// 'pending', 'done', 'failed'. Owner-scoped throughout: a job only ever
// reads the audio of the user who uploaded it.

// Bounded backlog, per user and overall, so a burst of uploads cannot queue
// an unbounded bill. A blob refused here stays NULL, and its bridge
// transcribes it locally.
const DEFAULT_MAX_QUEUED = 100
const DEFAULT_MAX_QUEUED_PER_USER = 20
// A row left 'pending' by a process that died: re-run it at boot if it is
// recent, give up on it otherwise (its bridge has long since fallen back).
const DEFAULT_RECOVER_MAX_AGE_MS = 60 * 60 * 1000

export function isAudioType(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('audio/')
}

export function readBlobTranscript(db, blobId) {
  const row = db.prepare('SELECT transcript, transcript_status FROM blobs WHERE id=?').get(blobId)
  if (!row || !row.transcript_status) return { status: 'none' }
  return row.transcript_status === 'done'
    ? { status: 'done', transcript: row.transcript }
    : { status: row.transcript_status }
}

export function makeBlobTranscripts({
  db, transcriber, log = console, now = Date.now,
  maxQueued = DEFAULT_MAX_QUEUED, maxQueuedPerUser = DEFAULT_MAX_QUEUED_PER_USER,
  recoverMaxAgeMs = DEFAULT_RECOVER_MAX_AGE_MS, closeTimeoutMs = 5000,
}) {
  const enabled = transcriber?.kind === 'cloud'
  if (!enabled) {
    return {
      enabled: false,
      start: () => false,
      lookup: (blobId) => readBlobTranscript(db, blobId),
      wait: async (blobId) => readBlobTranscript(db, blobId),
      inFlight: () => null,
      recover: () => 0,
      close: () => Promise.resolve(),
    }
  }

  const limit = Math.max(1, transcriber.concurrency ?? 1)
  const abort = new AbortController()
  let closed = false
  let running = 0
  const queue = []
  // blobId -> promise of the settled {status, transcript?}; present from
  // start() until the row is written.
  const jobs = new Map()
  const perUser = new Map()

  const setPending = db.prepare("UPDATE blobs SET transcript_status='pending', transcript=NULL WHERE id=? AND owner_user_id=? AND transcript_status IS NULL")
  const setDone = db.prepare("UPDATE blobs SET transcript_status='done', transcript=? WHERE id=? AND transcript_status='pending'")
  const setFailed = db.prepare("UPDATE blobs SET transcript_status='failed', transcript=NULL WHERE id=? AND transcript_status='pending'")

  function pump() {
    while (!closed && running < limit && queue.length) {
      const job = queue.shift()
      running += 1
      runJob(job).finally(() => {
        running -= 1
        const n = (perUser.get(job.userId) || 1) - 1
        if (n > 0) perUser.set(job.userId, n); else perUser.delete(job.userId)
        job.settle(readBlobTranscript(db, job.blobId))
        jobs.delete(job.blobId)
        pump()
      })
    }
  }

  async function runJob({ blobId, userId }) {
    if (closed) return
    let text = null
    try {
      const blob = db.prepare('SELECT disk_path FROM blobs WHERE id=? AND owner_user_id=?').get(blobId, userId)
      if (!blob) return // reaped while queued: nothing to write
      text = await transcriber.transcribeFile(blob.disk_path, { signal: abort.signal, userId })
    } catch (err) {
      // Shutting down: leave it pending for the next boot's recover().
      if (closed) return
      log.error(`blob-transcripts: ${blobId} failed: ${err?.message ?? err}`)
    }
    if (closed) return
    try {
      if (text && String(text).trim()) setDone.run(String(text).trim(), blobId)
      else setFailed.run(blobId)
    } catch (err) {
      log.error(`blob-transcripts: write-back for ${blobId} failed`, err)
    }
  }

  function enqueue(blobId, userId) {
    let settle
    const promise = new Promise((r) => { settle = r })
    jobs.set(blobId, promise)
    perUser.set(userId, (perUser.get(userId) || 0) + 1)
    queue.push({ blobId, userId, settle })
    pump()
  }

  function queuedCount() { return queue.length + running }

  return {
    enabled: true,
    // Called by POST /media right after the row is stored. True when the
    // blob is now pending; false when it is not audio, the backlog is full,
    // or the journal is closing (the bridge then transcribes it as before).
    start(blobId, userId, contentType) {
      if (closed || !isAudioType(contentType)) return false
      if (queuedCount() >= maxQueued || (perUser.get(userId) || 0) >= maxQueuedPerUser) return false
      if (setPending.run(blobId, userId).changes !== 1) return false
      enqueue(blobId, userId)
      return true
    },
    lookup: (blobId) => readBlobTranscript(db, blobId),
    // The row's state once its job settles, or as it stands after `ms`.
    // `signal` lets a disconnecting HTTP caller stop waiting.
    async wait(blobId, ms, signal) {
      const job = jobs.get(blobId)
      if (!job || ms <= 0) return readBlobTranscript(db, blobId)
      let timer
      let onAbort
      try {
        await Promise.race([
          job,
          new Promise((r) => { timer = setTimeout(r, ms) }),
          new Promise((r) => { onAbort = r; signal?.addEventListener('abort', r, { once: true }) }),
        ])
      } finally {
        clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
      return readBlobTranscript(db, blobId)
    },
    // The running job's promise for this blob, for items-transcribe.js to
    // await instead of paying for the same audio twice.
    inFlight: (blobId) => jobs.get(blobId) ?? null,
    recover() {
      const rows = db.prepare("SELECT id, owner_user_id, created_at FROM blobs WHERE transcript_status='pending'").all()
      let requeued = 0
      for (const r of rows) {
        if (now() - r.created_at > recoverMaxAgeMs) { setFailed.run(r.id); continue }
        enqueue(r.id, r.owner_user_id)
        requeued += 1
      }
      if (rows.length) log.log(`blob-transcripts: ${requeued} pending transcript(s) re-queued, ${rows.length - requeued} too old and failed`)
      return requeued
    },
    // Abort the in-flight requests and wait (bounded) for the jobs to return,
    // so shutdown never closes the DB under a write-back.
    close() {
      closed = true
      abort.abort()
      // Jobs that never started stay pending for the next boot; settle their
      // waiters now so nothing is left hanging on them.
      for (const job of queue.splice(0)) { job.settle(readBlobTranscript(db, job.blobId)); jobs.delete(job.blobId) }
      let timer
      const giveUp = new Promise((r) => { timer = setTimeout(r, closeTimeoutMs) })
      return Promise.race([Promise.allSettled([...jobs.values()]), giveUp]).finally(() => clearTimeout(timer))
    },
  }
}
