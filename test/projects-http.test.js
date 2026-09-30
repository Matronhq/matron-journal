import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { saveGithubIdentity } from '../src/github-accounts.js'
import { createProject, closeProject } from '../src/projects.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(s.db, { id, ownerUserId: dan.id, title: id, agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'mac' } })).json.token
  return { s, dan, pat, agent, priv, client: await tok('dan'), patClient: await tok('pat') }
}
const seedProject = (s, dan, deviceId, extra = {}) => createProject(s.db, { userId: dan.id, deviceId, createdBy: 'agent', title: 'Promo launch', ...extra }).project
const startMission = (s, token, body) => s.http('/missions', { method: 'POST', token, body: { title: 'M', convo_id: 'c1', ...body } })

test('POST /missions {project}: files the new mission; unknown/hidden 404, closed 409 project_closed, bad type 400; ignored on existing', async (t) => {
  const { s, dan, agent, priv } = await fleet(t)
  const p = seedProject(s, dan, agent.deviceId)
  const r = await startMission(s, agent.token, { project: `#${p.num}` })
  assert.equal(r.status, 201); assert.equal(r.json.mission.project_id, p.id); assert.equal(r.json.mission.project_num, p.num)
  const again = await startMission(s, agent.token, { project: null, title: 'other' })
  assert.equal(again.json.existing, true); assert.equal(again.json.mission.project_id, p.id)
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: '#999' })).status, 404)
  const hidden = seedProject(s, dan, priv.deviceId, { title: 'Hidden' })
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: hidden.id })).status, 404)
  const closed = seedProject(s, dan, agent.deviceId, { title: 'Done' })
  closeProject(s.db, { userId: dan.id, projectId: closed.id, by: 'user', summary: 'x' })
  const refused = await startMission(s, agent.token, { convo_id: 'c2', project: closed.num })
  assert.equal(refused.status, 409); assert.equal(refused.json.blocked_by, 'project_closed')
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: { id: p.id } })).status, 400)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM missions WHERE origin_convo_id='c2'").get().n, 0, 'nothing created on a refusal')
})

test('PATCH /missions/:id {project}: moves and detaches with a project_changed marker on the origin; a closed mission may be refiled but not edited; a colleague never sees project_id', async (t) => {
  const { s, dan, pat, agent, client, patClient } = await fleet(t)
  const p = seedProject(s, dan, agent.deviceId); const q = seedProject(s, dan, agent.deviceId, { title: 'Other' })
  const m = (await startMission(s, agent.token, {})).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const patch = (body, token = agent.token) => s.http(`/missions/${m.id}`, { method: 'PATCH', token, body })
  const filed = await patch({ project: p.id })
  assert.equal(filed.status, 200); assert.equal(filed.json.mission.project_num, p.num)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.project_changed, true)
  ws.close()
  assert.equal((await patch({ project: null })).json.mission.project_id, null)
  await s.http(`/missions/${m.id}/close`, { method: 'POST', token: client, body: { summary: 'done' } })
  const refiled = await patch({ project: `#${q.num}` })
  assert.equal(refiled.status, 200); assert.equal(refiled.json.mission.project_id, q.id)
  assert.equal((await patch({ title: 'x' })).status, 409)
  assert.equal((await patch({ project: q.id, title: 'x' })).status, 409, 'a closed mission refiles with project alone')
  assert.equal((await patch({})).status, 400)
  // A colleague reading the shared mission never learns which project it is in.
  for (const [u, gid] of [[dan, 1], [pat, 2]]) {
    saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  }
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, repo: 'github.com/matronhq/x' })
  const shared = await s.http('/missions?scope=shared', { token: patClient })
  assert.equal(shared.json.missions.length, 1)
  assert.equal(shared.json.missions[0].project_id, null); assert.equal(shared.json.missions[0].project_num, null)
})
