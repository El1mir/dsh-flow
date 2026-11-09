/**
 * v0.012：回信不能因为「顺手 steer 在跑的工人」失败而报错。
 *
 * 线上事故：`store.state.runs` 是字典（`lib/core.js` 的 `runs: {}`），
 * `lib/http.js` 里却写成 `(store.state.runs || []).find(...)` → 每次回信都 TypeError，
 * 而回复其实已经落库、也已经叫醒调度。提示与事实正好相反。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createHttpHandler } from '../lib/http.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-inbox-'))
const store = new Store(join(root, 'flow.json'))
await store.load()

const calls = { steer: [], prompt: [] }
const runtime = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession(sessionId, text) { calls.prompt.push({ sessionId, text }); return { ok: true } },
  async steer(project, input) { calls.steer.push(input); return { ok: true } }
}
const domain = new FlowDomain(store, runtime)
const project = await domain.ensureProject({ workspacePath: join(root, 'repo'), name: 'inbox' })
const task = await domain.createTask(project.id, { title: '回信测试', acceptance: ['x'] })
await store.tx((s) => {
  s.agents.ag_disp = { id: 'ag_disp', projectId: project.id, role: 'dispatcher', lane: 'human', enabled: true, name: '调度' }
  s.agents.ag_worker = { id: 'ag_worker', projectId: project.id, role: 'worker', lane: 'human', enabled: true, name: '工人' }
})

const host = {
  domain,
  runtime,
  resolveProjectById: (id) => store.state.projects[id],
  listProjects: () => Object.values(store.state.projects),
}
const handler = createHttpHandler(host)
async function post(action, args) {
  const res = await handler(new Request('http://local/api/flow/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args }),
  }))
  return { status: res.status, body: await res.json() }
}

async function newTicket(topic) {
  // 同卡同类同发起人会命中 askHuman 的幂等去重（answered 也算未归档）→ 先归档旧的，每轮拿干净的票。
  await store.tx((st) => {
    for (const x of st.human_inbox) if (x.taskId === task.id && x.status !== 'archived') x.status = 'archived'
  })
  return domain.askHuman({
    taskId: task.id,
    kind: 'decision',
    topic,
    problem: '需要人定一下方向。',
    decisionNeeded: '按哪个方案推进？',
    asks: [{
      key: 'q1', question: '选哪个方案', why: '这是取舍，机器不能替你决定',
      type: 'choice', choices: [{ value: 'A', label: '方案甲' }, { value: 'B', label: '方案乙' }],
      default: 'A', defaultReason: '甲改动更小', required: true,
    }],
  }, { role: 'dispatcher', id: 'ag_disp' })
}

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

// ---------------------------------------------------------------------------
await t('① runs 是字典时回信成功（不再是 find is not a function）', async () => {
  const item = await newTicket('字典 key 取 run')
  await store.tx((s) => {
    s.tasks[task.id].activeRunId = 'run_1'
    s.runs.run_1 = { id: 'run_1', taskId: task.id, agentId: 'ag_worker', projectId: project.id, sessionId: 'ses-w', status: 'running' }
  })
  const res = await post('inbox.reply', { inboxId: item.id, content: '按甲做' })
  assert.equal(res.body.result.ok, true, JSON.stringify(res.body))
  assert.equal(res.body.result.steerFailed, null)
  assert.equal(store.state.human_inbox.find((x) => x.id === item.id).status, 'answered')
  assert.ok(calls.steer.some((x) => x.agentId === 'ag_worker'), '应当顺手 steer 在跑的工人：' + JSON.stringify(calls.steer))
})

await t('② steer 抛错只影响 steerFailed，回复仍然 ok', async () => {
  const item = await newTicket('steer 会抛错')
  const before = runtime.steer
  // 同步抛：`await fn()` 里 fn 抛错时连 .catch 都挂不上，只有外层 try/catch 能接住 —— 这才是 try/catch 的用武之地。
  runtime.steer = () => { throw new Error('boom-steer') }
  try {
    const res = await post('inbox.reply', { inboxId: item.id, content: '按乙做' })
    assert.equal(res.body.result.ok, true, '回复本身必须成功：' + JSON.stringify(res.body))
    assert.equal(res.body.result.steerFailed, 'boom-steer')
    assert.equal(store.state.human_inbox.find((x) => x.id === item.id).status, 'answered')
    assert.ok(store.state.message_log.some((m) => m.kind === 'inbox-reply-steer-failed' && m.ok === false), '必须留下失败记录，不能静默')
  } finally { runtime.steer = before }
})

await t('③ activeRunId 指向不存在的 run → 不抛错、也不误报', async () => {
  const item = await newTicket('幽灵 run')
  await store.tx((s) => { s.tasks[task.id].activeRunId = 'run_missing' })
  const res = await post('inbox.reply', { inboxId: item.id, content: '按甲' })
  assert.equal(res.body.result.ok, true)
  assert.equal(res.body.result.steerFailed, null)
})

await t('④ runs 为空且没有 activeRunId → 纯文本回复照旧', async () => {
  const item = await newTicket('没有 run')
  await store.tx((s) => { s.tasks[task.id].activeRunId = null })
  const res = await post('inbox.reply', { inboxId: item.id, content: '就这样' })
  assert.equal(res.body.result.ok, true)
  assert.equal(res.body.result.steerFailed, null)
  assert.equal(store.state.human_inbox.find((x) => x.id === item.id).replies.length, 1)
})

if (fails.length) {
  console.log('FAIL inbox-reply ' + fails.length + '/' + (pass + fails.length))
  process.exitCode = 1
} else {
  console.log('PASS inbox-reply ' + pass + '/' + pass)
}