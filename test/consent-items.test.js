import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnConsentItemFields, spawnConsentClosing, spawnConsentFollowUp, consentLink, fileSpawnConsentItem, closeSpawnConsentItem, chatConsentItemFields, chatConsentClosing } from '../src/consent-items.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

const card = {
  request_id: 'sp-1', from_name: 'box-6', from_convo_title: 'parent session',
  target_name: 'opal', workdir: '/home/alice/proj', task: 'fix the flaky test and report back', topic: 'flaky test',
}

test('consentLink names the ask by kind and id', () => {
  assert.equal(consentLink('spawn', 'sp-1'), 'matron://consent/spawn/sp-1')
})

test('spawnConsentItemFields: title names the box and the topic; body carries task, box, workdir and how to answer', () => {
  const f = spawnConsentItemFields(card)
  assert.equal(f.title, 'Approve spawn on opal — flaky test')
  assert.ok(f.body.includes('fix the flaky test and report back'))
  assert.ok(f.body.includes('opal'))
  assert.ok(f.body.includes('/home/alice/proj'))
  assert.ok(f.body.includes('parent session'))
  assert.ok(/Approve/.test(f.body) && /Decline/.test(f.body))
  assert.ok(!f.body.includes('Model'))
  assert.ok(!/chat room/i.test(f.body))
  assert.deepEqual(f.labels, ['consent'])
  assert.deepEqual(f.links, [{ url: 'matron://consent/spawn/sp-1', title: 'Spawn request sp-1' }])
})

test('spawnConsentItemFields: a predicted Fable-limit fallback names Opus; a named model shows alone', () => {
  const f = spawnConsentItemFields({ ...card, fallback_model: 'opus', fallback_reason: 'fable_limit' })
  assert.ok(f.body.includes('- **Model:** `opus` — opal is at its Fable weekly limit, so a session that would start on Fable starts on Opus'))
  const named = spawnConsentItemFields({ ...card, model: 'fable', fallback_model: 'opus', fallback_reason: 'fable_limit' })
  assert.ok(named.body.includes('- **Model:** `fable`'))
  assert.ok(!named.body.includes('Fable weekly limit'))
})

test('spawnConsentItemFields: a named effort shows on the card body; none says nothing', () => {
  assert.ok(spawnConsentItemFields({ ...card, effort: 'max' }).body.includes('- **Effort:** `max`'))
  assert.ok(!spawnConsentItemFields(card).body.includes('Effort'))
})

test('spawnConsentClosing: a started spawn on a fallback says which model and why', () => {
  const c = spawnConsentClosing({ outcome: 'started', modelFallback: { model: 'opus', model_reason: 'fable_limit' } }, { targetName: 'opal' })
  assert.equal(c.comment, 'Approved — the session started on opal on `opus` — Fable limit reached.')
  const coord = spawnConsentClosing({ outcome: 'started', modelFallback: { model: 'opus', model_reason: 'fable_limit' } }, { targetName: 'opal', decidedBy: { reason: 'ok' } })
  assert.ok(coord.comment.includes('started on opal on `opus` — Fable limit reached.'))
})

test('spawnConsentItemFields: without a topic the title falls back to the task, cut to fit', () => {
  const f = spawnConsentItemFields({ ...card, topic: '', task: 'x'.repeat(500) })
  assert.ok(f.title.startsWith('Approve spawn on opal — xxxx'))
  assert.ok(f.title.length <= 200)
  assert.ok(f.title.endsWith('…'))
})

test('spawnConsentItemFields: model and link show up only when asked for', () => {
  const f = spawnConsentItemFields({ ...card, model: 'opus', link: true })
  assert.ok(f.body.includes('opus'))
  assert.ok(/chat room/i.test(f.body))
})

test('spawnConsentItemFields: a backtick in the workdir cannot break out of its code span', () => {
  const f = spawnConsentItemFields({ ...card, workdir: '/tmp/a`b' })
  assert.ok(!f.body.includes('a`b'))
  assert.ok(f.body.includes('/tmp/a'))
})

test('spawnConsentClosing: approve and decline are decided by the user; expiry and failure are cancelled', () => {
  const started = spawnConsentClosing({ outcome: 'started' }, { targetName: 'opal', link: false })
  assert.equal(started.resolution, 'decided'); assert.equal(started.author, 'user')
  assert.ok(started.comment.includes('Approved') && started.comment.includes('opal'))
  assert.ok(!/chat room/i.test(started.comment))
  const linked = spawnConsentClosing({ outcome: 'started', roomId: 'r1' }, { targetName: 'opal', link: true })
  assert.ok(/chat room/i.test(linked.comment))
  const declined = spawnConsentClosing({ outcome: 'declined' }, { targetName: 'opal' })
  assert.equal(declined.resolution, 'decided'); assert.equal(declined.author, 'user')
  assert.ok(declined.comment.includes('Declined'))
  const expired = spawnConsentClosing({ outcome: 'expired' }, { targetName: 'opal' })
  assert.equal(expired.resolution, 'cancelled'); assert.equal(expired.author, 'agent')
  assert.ok(expired.comment.includes('24 h'))
  const failed = spawnConsentClosing({ outcome: 'failed', errorCode: 'agent_unreachable' }, { targetName: 'opal' })
  assert.equal(failed.resolution, 'cancelled'); assert.equal(failed.author, 'agent')
  assert.ok(failed.comment.includes('Approved') && failed.comment.includes('agent_unreachable'))
})

test('spawnConsentItemFields: the task is fenced, so markdown in it (images, links, emphasis) renders as text', () => {
  const f = spawnConsentItemFields({ ...card, task: '![p](https://x/px.png) **bold** [go](https://phish)' })
  assert.ok(f.body.includes('```\n![p](https://x/px.png) **bold** [go](https://phish)\n```'))
  assert.ok(!f.body.includes('> !['))
})

test('spawnConsentItemFields: markup in device and conversation names is stripped, never rendered', () => {
  const f = spawnConsentItemFields({ ...card, from_name: 'dev*6_[x]', target_name: 'op**al', from_convo_title: 'ses"sion <b>' })
  assert.ok(f.body.includes('**dev6x** asks'))
  assert.ok(f.body.includes('on **opal**'))
  assert.ok(f.body.includes('"session b"'))
  assert.equal(f.title, 'Approve spawn on opal — flaky test')
})

test('spawnConsentClosing: an outcome this build does not know closes neutrally, never as an approval', () => {
  const c = spawnConsentClosing({ outcome: 'weird' }, { targetName: 'opal' })
  assert.equal(c.resolution, 'cancelled'); assert.equal(c.author, 'agent')
  assert.ok(!c.comment.includes('Approved'))
  assert.ok(c.comment.includes('weird'))
})

test('closeSpawnConsentItem never throws: a lookup that fails is a false, not an exception past the outcome frame', () => {
  const broken = { prepare() { throw new Error('database connection is not open') } }
  assert.equal(closeSpawnConsentItem({ db: broken, hub: null }, 'sp-1', { outcome: 'declined' }), false)
})

test('fileSpawnConsentItem against a spawn row that is gone files nothing: create and link are one transaction', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const agent = createAgent(db, alice.id, 'box-6')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const hub = { broadcast() {}, sendToDevice() {}, connsOf() { return [] } }
  const item = fileSpawnConsentItem({ db, hub }, { userId: alice.id, fromDeviceId: agent.deviceId, fromName: 'box-6', fromConvoId: 'c1', spawnId: 'no-such-row', card })
  assert.equal(item, null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 0)
})

test('spawnConsentItemFields: a task containing a backtick fence stays verbatim — the fence around it just grows', () => {
  const task = 'run ``` then ```` and report'
  const f = spawnConsentItemFields({ ...card, task })
  assert.ok(f.body.includes(`\`\`\`\`\`\n${task}\n\`\`\`\`\``))
  assert.ok(!f.body.includes(`\n\`\`\`\n${task}`))
})

const chatCard = {
  kind: 'agent_chat', request: 'invite', room_id: 'room-1', from_device_id: 7, from_name: 'dev-a', target_device_id: 12,
  topic: 'ci logs', justification: 'need the failing job output', from_convo_id: 'c-a', from_convo_title: 'A:xy fixing ci',
  to_name: 'dev-b', to_convo_id: 'c-b', to_convo_title: 'B:qq reviewing',
}

test('chatConsentItemFields (invite): title names both sides and the topic; body has both sessions, the justification fenced, and how to answer', () => {
  const f = chatConsentItemFields(chatCard)
  assert.equal(f.title, 'dev-a asks to chat with dev-b — ci logs')
  assert.ok(f.body.includes('```\nneed the failing job output\n```'))
  assert.ok(f.body.includes('A:xy fixing ci') && f.body.includes('B:qq reviewing'))
  assert.ok(/Approve/.test(f.body) && /Decline/.test(f.body))
  assert.deepEqual(f.labels, ['consent'])
  assert.deepEqual(f.links, [{ url: 'matron://consent/chat/room-1/12', title: 'Agent chat request' }])
})

test('chatConsentItemFields (join): title says join, names the owner; blank session titles are left out, not rendered empty', () => {
  const f = chatConsentItemFields({ ...chatCard, request: 'join', topic: '', from_convo_id: '', from_convo_title: '', to_convo_id: '', to_convo_title: '', target_device_id: 7 })
  assert.equal(f.title, "dev-a asks to join dev-b's room")
  assert.ok(!f.body.includes('""'))
  assert.deepEqual(f.links, [{ url: 'matron://consent/chat/room-1/7', title: 'Agent chat request' }])
})

test('chatConsentClosing: approve and deny are decided by the user; expiry and a dissolved room are cancelled', () => {
  assert.deepEqual(chatConsentClosing('approved'), { resolution: 'decided', author: 'user', comment: 'Approved — the invitation is on its way.' })
  assert.deepEqual(chatConsentClosing('denied'), { resolution: 'decided', author: 'user', comment: 'Declined.' })
  assert.deepEqual(chatConsentClosing('expired'), { resolution: 'cancelled', author: 'agent', comment: 'Expired — no answer within 24 h.' })
  assert.deepEqual(chatConsentClosing('left'), { resolution: 'cancelled', author: 'agent', comment: 'The room was closed before you answered.' })
  assert.equal(chatConsentClosing('weird').resolution, 'cancelled')
})

test('spawnConsentItemFields: a spawn onto a mission says "joins mission #N" with its title; without one the line is absent', () => {
  const plain = spawnConsentItemFields(card)
  assert.ok(!/joins mission/i.test(plain.body), 'no mission line without mission_num')
  const withMission = spawnConsentItemFields({ ...card, mission_num: 42, mission_title: 'Ship the *panel*' })
  // Title passed through plain(): markdown/control characters stripped, same as every other peer string here.
  assert.ok(withMission.body.includes('- **Joins mission #42** — Ship the panel'), withMission.body)
  const untitled = spawnConsentItemFields({ ...card, mission_num: 42 })
  assert.ok(untitled.body.includes('- **Joins mission #42**\n'), 'no dangling dash when the title is absent')
})

test('spawnConsentClosing: the approval itself closes the item as decided, before any outcome; the Coordinator form names its reason', () => {
  const tap = spawnConsentClosing({ outcome: 'approved' }, { targetName: 'opal' })
  assert.equal(tap.resolution, 'decided'); assert.equal(tap.author, 'user')
  assert.ok(tap.comment.startsWith('Approved. Starting the session on opal;'))
  const coord = spawnConsentClosing({ outcome: 'approved' }, { targetName: 'opal', decidedBy: { reason: 'follows the box rules' } })
  assert.equal(coord.resolution, 'decided'); assert.equal(coord.author, 'agent'); assert.equal(coord.byCoordinator, true)
  assert.ok(coord.comment.startsWith('Approved by the Coordinator — follows the box rules. Starting the session on opal;'))
  const gone = spawnConsentClosing({ outcome: 'gone' }, { targetName: '' })
  assert.equal(gone.resolution, 'cancelled'); assert.equal(gone.comment, 'Closed — the request is no longer waiting for an answer.')
  assert.equal(chatConsentClosing('gone').comment, gone.comment)
})

test('spawnConsentFollowUp: only a start or a failed start adds a note to an item its approval already closed', () => {
  assert.equal(spawnConsentFollowUp({ outcome: 'started' }, { targetName: 'opal' }), 'The session started on opal.')
  assert.equal(spawnConsentFollowUp({ outcome: 'started', roomId: 'r1', modelFallback: { model: 'opus' } }, { targetName: 'opal', link: true }),
    'The session started on opal on `opus` — Fable limit reached. A chat room between the two sessions was opened.')
  assert.equal(spawnConsentFollowUp({ outcome: 'failed', errorCode: 'agent_unreachable' }, { targetName: 'opal' }), 'The session could not be started (agent_unreachable).')
  for (const outcome of ['approved', 'declined', 'expired', 'gone']) assert.equal(spawnConsentFollowUp({ outcome }, { targetName: 'opal' }), null)
})
