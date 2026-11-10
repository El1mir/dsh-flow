/**
 * RT-04：车道消息区。
 *
 * 领域模块不查网络；remoteMode=false 的拒绝在 HTTP 路由。
 * 人发消息要叫醒目标车道；代理/系统不叫醒。wake 失败消息仍留下。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createHttpHandler } from '../lib/http.js'
import { postLaneMessage, listLaneMessages, markLaneRead } from '../lib/domain/lane-messages.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-lanemsg-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const runtime = {
  async ensureSession() { return { ok: true, sessionId: 'ses-x' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
}
const domain = new FlowDomain(store, runtime)
const project = await domain.ensureProject({ workspacePath: join(root, 'repo'), name: 'lanes' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const blank = () => ({
  projects: { [project.id]: store.state.projects[project.id] },
  tasks: {},
  lane_messages: [],
  events: [],
  outbox: [],
  seq: { laneMsg: 0 },
})

await t('空项目列表是空的，没有消息时不写事件', async () => {
  const state = blank()
  const listed = listLaneMessages(state, project.id, {})
  assert.deepEqual(listed.items, [])
  assert.equal(listed.hasMore, false)
})

await t('人发到 human：落库、lm_ 序号、readBy 全空，wake 一次', async () => {
  const state = blank()
  const wakes = []
  const msg = await postLaneMessage(state, project.id, {
    body: '请看一眼合并列',
    to: 'human',
    from: { kind: 'human', lane: 'human', name: '人' },
  }, { wake: async (projectId, lane, message) => { wakes.push({ projectId, lane, id: message.id }) } })
  assert.equal(state.lane_messages.length, 1)
  assert.equal(msg.id, 'lm_0001')
  assert.equal(state.seq.laneMsg, 1)
  assert.equal(msg.body, '请看一眼合并列')
  assert.deepEqual(msg.to, { lane: 'human' })
  assert.equal(msg.from.kind, 'human')
  assert.deepEqual(msg.readBy, { human: null, 'lane:human': null, 'lane:issue': null })
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].lane, 'human')
  assert.ok(msg.deliveredAt)
  assert.equal(state.events.length, 0, '消息区不写 events')
  assert.equal(state.outbox.length, 0, '消息区不写 outbox')
})

await t('to=all 时 wake 两次（human 与 issue）', async () => {
  const state = blank()
  const wakes = []
  await postLaneMessage(state, project.id, {
    body: '两边都看',
    to: { lane: 'all' },
    from: { kind: 'human', lane: 'human' },
  }, { wake: async (_p, lane) => { wakes.push(lane) } })
  assert.deepEqual(wakes, ['human', 'issue'])
})

await t('agent / system 不 wake，deliveredAt 为空，消息仍在', async () => {
  const state = blank()
  let wakes = 0
  const agent = await postLaneMessage(state, project.id, {
    body: '工人汇报',
    to: 'issue',
    from: { kind: 'agent', lane: 'issue', agentId: 'ag_w', name: '工人' },
  }, { wake: async () => { wakes += 1 } })
  const system = await postLaneMessage(state, project.id, {
    body: '系统提示',
    to: 'human',
    from: { kind: 'system', lane: 'human' },
  }, { wake: async () => { wakes += 1 } })
  assert.equal(wakes, 0)
  assert.equal(agent.deliveredAt, null)
  assert.equal(system.deliveredAt, null)
  assert.equal(state.lane_messages.length, 2)
})

await t('没有 wake 或 wake 抛错：消息留下，deliveredAt 为空', async () => {
  const state = blank()
  const missing = await postLaneMessage(state, project.id, {
    body: '没人接',
    to: 'human',
    from: { kind: 'human', lane: 'human' },
  }, {})
  const thrown = await postLaneMessage(state, project.id, {
    body: '叫醒失败',
    to: 'issue',
    from: { kind: 'human', lane: 'human' },
  }, { wake: async () => { throw new Error('runtime down') } })
  assert.equal(missing.deliveredAt, null)
  assert.equal(thrown.deliveredAt, null)
  assert.equal(state.lane_messages.length, 2)
  assert.equal(state.lane_messages[1].body, '叫醒失败')
})

await t('空正文、超长正文、过多引用、跨项目 replyTo 都拒绝', async () => {
  const state = blank()
  await assert.rejects(() => postLaneMessage(state, project.id, {
    body: '   ',
    to: 'human',
    from: { kind: 'human', lane: 'human' },
  }, {}))
  await assert.rejects(() => postLaneMessage(state, project.id, {
    body: 'x'.repeat(4001),
    to: 'human',
    from: { kind: 'human', lane: 'human' },
  }, {}))
  await assert.rejects(() => postLaneMessage(state, project.id, {
    body: 'ok',
    to: 'human',
    from: { kind: 'human', lane: 'human' },
    refs: Array.from({ length: 9 }, (_, i) => ({ kind: 'task', id: 'T-' + i })),
  }, {}))
  state.lane_messages.push({ id: 'lm_other', projectId: 'other', body: '别的项目', createdAt: '2026-01-01T00:00:00.000Z' })
  await assert.rejects(() => postLaneMessage(state, project.id, {
    body: '回错项目',
    to: 'human',
    from: { kind: 'human', lane: 'human' },
    replyTo: 'lm_other',
  }, {}))
  assert.equal(state.lane_messages.filter((m) => m.projectId === project.id).length, 0)
})

await t('replyTo 必须是本项目已有消息；列表按时间倒序并支持 before/limit', async () => {
  const state = blank()
  const a = await postLaneMessage(state, project.id, {
    body: '第一',
    to: 'human',
    from: { kind: 'agent', lane: 'human', agentId: 'ag' },
  }, {})
  const b = await postLaneMessage(state, project.id, {
    body: '第二',
    to: 'human',
    from: { kind: 'agent', lane: 'human', agentId: 'ag' },
    replyTo: a.id,
    refs: [{ kind: 'message', id: a.id, label: '第一' }],
  }, {})
  assert.equal(b.replyTo, a.id)
  assert.equal(b.refs.length, 1)
  const page = listLaneMessages(state, project.id, { limit: 1 })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].id, b.id)
  assert.equal(page.hasMore, true)
  const older = listLaneMessages(state, project.id, { before: b.id, limit: 10 })
  assert.equal(older.items.length, 1)
  assert.equal(older.items[0].id, a.id)
  assert.equal(older.hasMore, false)
})

await t('markLaneRead 只更新指定读者', async () => {
  const state = blank()
  const msg = await postLaneMessage(state, project.id, {
    body: '已读测试',
    to: 'human',
    from: { kind: 'agent', lane: 'issue', agentId: 'ag' },
  }, {})
  markLaneRead(state, project.id, 'lane:human', '2026-11-10T00:00:00.000Z')
  assert.equal(msg.readBy['lane:human'], '2026-11-10T00:00:00.000Z')
  assert.equal(msg.readBy.human, null)
  assert.equal(msg.readBy['lane:issue'], null)
})

const handler = createHttpHandler({
  domain,
  runtime,
  resolveProjectById: (id) => store.state.projects[id],
  listProjects: () => Object.values(store.state.projects),
})
async function post(action, args) {
  const res = await handler(new Request('http://local/api/flow/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args }),
  }))
  return { status: res.status, body: await res.json() }
}

await t('remoteMode=false 时车道消息路由拒绝，且不落库', async () => {
  const before = (store.state.lane_messages || []).length
  const listed = await post('lane.message.list', { projectId: project.id })
  const posted = await post('lane.message.post', { projectId: project.id, body: '不该留下', to: 'human' })
  assert.equal(listed.status, 400)
  assert.match(String(listed.body.error || ''), /远程模式/)
  assert.equal(posted.status, 400)
  assert.equal((store.state.lane_messages || []).length, before)
})

await t('remoteMode=true 后 list/post 可用；正文与引用上限在路由上生效', async () => {
  await store.tx((s) => {
    s.projects[project.id].config.remoteMode = true
  })
  const badBody = await post('lane.message.post', { projectId: project.id, body: 'y'.repeat(4001), to: 'human' })
  assert.equal(badBody.status, 400)
  const badRefs = await post('lane.message.post', {
    projectId: project.id,
    body: 'ok',
    to: 'issue',
    refs: Array.from({ length: 9 }, (_, i) => ({ kind: 'issue', id: String(i) })),
  })
  assert.equal(badRefs.status, 400)
  const ok = await post('lane.message.post', { projectId: project.id, body: '看板上的留言', to: 'all', refs: [{ kind: 'issue', id: '9', label: '#9' }] })
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 240))
  assert.equal(ok.body.result.ok, true)
  assert.equal(ok.body.result.message.body, '看板上的留言')
  assert.equal(ok.body.result.message.to.lane, 'all')
  const list = await post('lane.message.list', { projectId: project.id, limit: 10 })
  assert.equal(list.status, 200)
  assert.equal(list.body.result.ok, true)
  assert.ok(list.body.result.items.some((m) => m.body === '看板上的留言'))
  assert.equal(typeof list.body.result.hasMore, 'boolean')
})

await t('未知项目的车道消息被拒绝', async () => {
  const res = await post('lane.message.post', { projectId: 'nope', body: 'x', to: 'human' })
  assert.equal(res.status, 400)
})

await t('task.approveExternal 只走 domain.approveExternal，不额外再发 external.approved', async () => {
  const task = await domain.createTask(project.id, { title: '外部 PR', acceptance: ['合'] })
  await store.tx((s) => {
    s.tasks[task.id].kind = 'external-pr'
    s.tasks[task.id].lane = 'human'
    s.tasks[task.id].external = { number: 4, approval: { status: 'pending', by: null, at: null, note: null } }
  })
  const before = store.state.events.filter((e) => e.type === 'external.approved').length
  const res = await post('task.approveExternal', { taskId: task.id, decision: 'approve', note: '可以合' })
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300))
  assert.equal(res.body.result.ok, true)
  assert.equal(store.state.tasks[task.id].external.approval.status, 'approved')
  const after = store.state.events.filter((e) => e.type === 'external.approved').length
  assert.equal(after - before, 1, 'domain 已经发了 external.approved，路由不能再发一条')
})

console.log(NL + pass + ' passed, ' + fails.length + ' failed')
if (fails.length) process.exit(1)
