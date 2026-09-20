// Journal-side transcription of item voice notes. A user's comment with an
// audio attachment is stored `transcript_status:'pending'` (items-http.js),
// queued here, run through whisper one at a time, and written back; when the
// last pending attachment on a comment settles, `onSettled` fires so
// items-http.js can emit the quiet `updated` marker that refreshes the apps
// and releases the agent's held turn (see items-marker.js).
//
// One job at a time: whisper saturates the cores it is given, and a journal
// host is sized for a Node process, not for N concurrent model loads.
import { finishAttachmentTranscript, listPendingTranscripts } from './items.js'

export function makeItemTranscription({ db, transcriber, onSettled, log = console }) {
  if (!transcriber) return { enabled: false, enqueue() {}, recover() { return 0 }, idle: () => Promise.resolve() }

  let tail = Promise.resolve()
  let closed = false

  async function runOne({ commentId, userId, blobRef }) {
    if (closed) return
    let transcript = null
    try {
      // Still ours to do? A boot re-queue can duplicate a job, and a bridge
      // may have PATCHed its own words in meanwhile (which settles the status
      // and announces itself) — either way a whisper run would be CPU spent
      // on a result nobody keeps.
      if (!listPendingTranscripts(db).some((j) => j.commentId === commentId && j.blobRef === blobRef)) return
      // Owner-scoped: an attachment names a blob by id alone, and a comment
      // must never pull words out of another user's audio.
      const blob = db.prepare('SELECT disk_path FROM blobs WHERE id=? AND owner_user_id=?').get(blobRef, userId)
      if (!blob) throw new Error('blob not found for this user')
      transcript = await transcriber.transcribeFile(blob.disk_path)
    } catch (err) {
      log.error(`items-transcribe: ${commentId}/${blobRef} failed: ${err?.message ?? err}`)
    }
    if (closed) return
    let out
    try {
      out = finishAttachmentTranscript(db, { commentId, blobRef, transcript })
    } catch (err) {
      log.error(`items-transcribe: write-back for ${commentId}/${blobRef} failed`, err)
      return
    }
    if (!out || !out.changed || !out.settled || !out.item) return
    try { onSettled(out) } catch (err) { log.error('items-transcribe: onSettled failed', err) }
  }

  return {
    enabled: true,
    enqueue(job) { tail = tail.then(() => runOne(job)); return tail },
    // Re-queue what a previous process left pending. A failure is still an
    // answer: the bridge is holding a turn until one arrives.
    recover() {
      const jobs = listPendingTranscripts(db)
      for (const j of jobs) this.enqueue(j)
      if (jobs.length) log.log(`items-transcribe: re-queued ${jobs.length} pending transcript(s)`)
      return jobs.length
    },
    idle: () => tail,
    close() { closed = true },
  }
}
