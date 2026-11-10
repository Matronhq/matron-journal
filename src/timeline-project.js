// One project on the timeline: the summary its page opens with. Pure DB
// reads over what src/timeline.js already defines (moves, the stored weeks,
// the sieves), for one project the caller has already resolved (through a
// merge, under its own sieve). `excludePrivateOwned` hides what an ordinary
// agent may not see, exactly as the week reads do.
import { ORIGIN_SIEVE } from './missions.js'
import { filesSql } from './projects-feed.js'
import { allWrittenWeeks } from './week-stories.js'
import {
  userTimeZone, parseWeekKey, weekEndOf, projectMoveTimes, weekStartsOf, rowProjects, survivingProjects, storyProjects,
  liveMedia, convoSieveOf, IN_PROJECT, OF_PROJECT, needsYouSql, forYouSql,
} from './timeline.js'

export const PROJECT_PAGE = {
  needsYou: 10, // waiting items listed on the page; needs_you_total counts them all
}

const PICTURES = "(f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')"
// The needs-you SQL asks for items created before @end; a page takes them all.
const ALWAYS = Number.MAX_SAFE_INTEGER

// What the stored `weeks` say about the project: for each week with a story
// whose main project is this one (the first project the story names that the
// caller may see, through merges; the first such story wins, as on the week
// page), { week, story }, in the order of `weeks`. Two statements, however
// many weeks.
function storiesAbout(db, userId, project, weeks, excludePrivateOwned) {
  if (!weeks.length) return []
  const byId = new Map(rowProjects(db, userId, excludePrivateOwned).map((p) => [p.id, p]))
  const ids = [...new Set(weeks.flatMap((w) => w.stories.flatMap((s) => s.project_ids)))]
  const projects = survivingProjects(db, userId, ids, byId)
  const out = []
  for (const week of weeks) {
    const story = week.stories.find((s) => storyProjects(s, projects)[0]?.id === project.id)
    if (story) out.push({ week, story })
  }
  return out
}

// The newest picture picked for the project in a stored week that still
// resolves for the caller, as { media, at }; null when none does. A pick
// dates from the end of its week, or from when it was written if that came
// first (a week still running).
function storedPick(db, userId, about, tz, excludePrivateOwned) {
  const picks = about.filter((a) => a.story.media_blob_id)
  const live = liveMedia(db, userId, [...new Set(picks.map((a) => a.story.media_blob_id))], excludePrivateOwned)
  const pick = picks.find((a) => live.has(a.story.media_blob_id))
  if (!pick) return null
  const start = parseWeekKey(pick.week.week_key, tz)
  const end = start == null ? pick.week.written_at : weekEndOf(start, tz)
  return { media: live.get(pick.story.media_blob_id), at: Math.min(end, pick.week.written_at) }
}

// The summary of one project:
// { project: {id,num,title,state,live}, sentence, sentence_source, next,
//   needs_you: [{id,num,title}], needs_you_total, media, counts }.
// - `sentence` is the project's status (`sentence_source` 'status'), else its
//   newest milestone's title ('milestone'), else null (null).
// - `next` is what the newest stored week about the project says comes next;
//   null when that week says nothing, or no week is about it.
// - `needs_you` is the newest PROJECT_PAGE.needsYou of its open items waiting
//   on the user, consent cards left out; `needs_you_total` counts them all.
// - `media` is the newer of the newest stored pick that still resolves and
//   the newest picture or video among its files (the pick on a tie).
// - `counts`: the local weeks it moved in, its open and closed missions, and
//   its files.
// `project` is the row getProject returns (its status already sieved).
export function projectPage(db, userId, project, { excludePrivateOwned = false } = {}) {
  const tz = userTimeZone(db, userId)
  const convoSieve = convoSieveOf(excludePrivateOwned)
  const args = { userId, projectId: project.id }

  const missions = new Map(db.prepare(`SELECT m.state, COUNT(*) AS n FROM missions m
    WHERE ${OF_PROJECT} ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''} GROUP BY m.state`).all(args).map((r) => [r.state, r.n]))
  const open = missions.get('open') ?? 0

  let sentence = project.status?.trim() || null
  let source = sentence ? 'status' : null
  if (!sentence) {
    sentence = db.prepare(`SELECT l.title FROM milestones l JOIN missions m ON m.id = l.mission_id
        JOIN conversations c ON c.id = l.convo_id
      WHERE ${OF_PROJECT} ${convoSieve} ORDER BY l.created_at DESC, l.seq DESC LIMIT 1`).get(args)?.title ?? null
    source = sentence ? 'milestone' : null
  }

  const about = storiesAbout(db, userId, project, allWrittenWeeks(db, userId), excludePrivateOwned)

  const files = filesSql(excludePrivateOwned, IN_PROJECT)
  const newest = db.prepare(`SELECT f.blob_id, f.content_type, f.name, f.at FROM (${files}) f
    WHERE ${PICTURES} ORDER BY f.at DESC, f.sort_key DESC LIMIT 1`).get(args)
  const pick = storedPick(db, userId, about, tz, excludePrivateOwned)
  const fromFiles = newest ? { blob_id: newest.blob_id, content_type: newest.content_type, name: newest.name } : null
  const media = pick && (!newest || pick.at >= newest.at) ? pick.media : fromFiles

  const waiting = { ...args, end: ALWAYS }
  return {
    project: { id: project.id, num: project.num, title: project.title, state: project.state, live: project.state === 'open' && open > 0 },
    sentence,
    sentence_source: source,
    next: about[0]?.story.next ?? null,
    needs_you: db.prepare(needsYouSql(convoSieve, PROJECT_PAGE.needsYou)).all(waiting),
    needs_you_total: db.prepare(forYouSql(convoSieve)).get(waiting).n,
    media,
    counts: {
      weeks: weekStartsOf(projectMoveTimes(db, userId, project.id, { excludePrivateOwned }), tz).length,
      missions_open: open,
      missions_done: missions.get('closed') ?? 0,
      files: db.prepare(`SELECT COUNT(*) AS n FROM (${files})`).get(args).n,
    },
  }
}
