/**
 * RT-04：面板双车道投影 + 远程模式配置守卫。
 *
 * 人板 = 人车道（非 auto）+ 被拉上板的 issue 卡。
 * issue 车道保留 auto 卡。顶层 columns/tasks 仍是人板，给旧客户端。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { buildProjectView } from '../lib/panel.js'
import { createHttpHandler } from '../lib/http.js'
import { postLaneMessage } from '../lib/domain/lane-messages.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-panel-lanes-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const domain = new FlowDomain(store, {
  async ensureSession() { return { ok: true, sessionId: 'ses' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
})
const project = await domain.ensureProject({ workspacePath: join(root, 'repo'), name: 'panel' })
const view = () => buildProjectView(store.state, project.id)
const cardsOf = (tasks) => Object.values(tasks || {}).flat()

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const humanBoard = await domain.createTask(project.id, { title: '人板', acceptance: ['a'] })
const humanAuto = await domain.createTask(project.id, { title: '人车道 auto', acceptance: ['a'] })
const issueBoard = await domain.createTask(project.id, { title: 'issue 上板', acceptance: ['a'] })
const issueAuto = await domain.createTask(project.id, { title: 'issue auto', acceptance: ['a'] })
const blocked = await domain.createTask(project.id, { title: '阻塞', acceptance: ['a'] })
const verifying = await domain.createTask(project.id, { title: '待验收', acceptance: ['a'] })
const pending = await domain.createTask(project.id, { title: '外部待批', acceptance: ['a'] })

await store.tx((s) => {
  s.tasks[humanAuto.id].visibility = 'auto'
  s.tasks[issueBoard.id].lane = 'issue'
  s.tasks[issueBoard.id].visibility = 'board'
  s.tasks[issueAuto.id].lane = 'issue'
  s.tasks[issueAuto.id].visibility = 'auto'
  s.tasks[blocked.id].blocked = { reason: '缺人', at: '2026-11-10T00:00:00.000Z' }
  s.tasks[verifying.id].column = 'verifying'
  s.tasks[pending.id].lane = 'issue'
  s.tasks[pending.id].visibility = 'board'
  s.tasks[pending.id].kind = 'external-pr'
  s.tasks[pending.id].mergeState = 'open'
  s.tasks[pending.id].external = { number: 7, approval: { status: 'pending', by: null, at: null, note: null } }
  s.tasks[pending.id].mergeRequest = { id: 'pr_1', status: 'open', remote: { number: 7, url: 'https://example.test/7', state: 'open' } }
  s.pull_requests.pr_1 = {
    id: 'pr_1', taskId: pending.id, projectId: project.id, status: 'open',
    remote: { number: 7, url: 'https://example.test/7', state: 'open' },
  }
  s.projects[project.id].config.remoteMode = false
  s.projects[project.id].config.externalPr = { autoMerge: false }
  s.projects[project.id].config.acceptanceTickets = true
})

await t('人板含人车道非 auto 与 issue/board，不含两边的 auto', async () => {
  const ids = cardsOf(view().tasks).map((c) => c.id)
  assert.ok(ids.includes(humanBoard.id))
  assert.ok(ids.includes(issueBoard.id))
  assert.ok(ids.includes(blocked.id))
  assert.ok(ids.includes(verifying.id))
  assert.ok(ids.includes(pending.id))
  assert.equal(ids.includes(humanAuto.id), false)
  assert.equal(ids.includes(issueAuto.id), false)
})

await t('lanes.human 与顶层一致；lanes.issue 保留 auto 卡', async () => {
  const v = view()
  const human = cardsOf(v.lanes.human.tasks).map((c) => c.id).sort()
  const top = cardsOf(v.tasks).map((c) => c.id).sort()
  assert.deepEqual(human, top)
  const issue = cardsOf(v.lanes.issue.tasks).map((c) => c.id)
  assert.ok(issue.includes(issueBoard.id))
  assert.ok(issue.includes(issueAuto.id), '不要把 auto 卡从 lanes.issue 拿掉')
  assert.ok(issue.includes(pending.id))
  assert.equal(issue.includes(humanBoard.id), false)
  assert.deepEqual(v.lanes.human.columns.map((c) => c.id), ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled'])
  assert.equal(typeof v.lanes.human.count, 'number')
  assert.equal(typeof v.lanes.human.blocked, 'number')
  assert.equal(typeof v.lanes.issue.count, 'number')
  assert.ok(v.lanes.human.blocked >= 1)
  assert.equal(v.lanes.human.needsHuman, 3, '人板含阻塞、待验收，以及被拉上板的外部待批')
  assert.equal(v.lanes.issue.needsHuman, 1)
  assert.equal(typeof v.lanes.human.running, 'number', '旧统计字段还在，smoke 读它')
  assert.equal(typeof v.lanes.issue.budget.max, 'number')
})

await t('卡视图带 lane/visibility/mergeState/remotePr/external.approval', async () => {
  const card = cardsOf(view().lanes.issue.tasks).find((c) => c.id === pending.id)
  assert.equal(card.lane, 'issue')
  assert.equal(card.visibility, 'board')
  assert.equal(card.mergeState, 'open')
  assert.equal(card.external.approval.status, 'pending')
  assert.equal(card.remotePr.number, 7)
  assert.equal(card.remotePr.url, 'https://example.test/7')
})

await t('inbox 投影带 category/refs/updatedAt/replyCount，categories 只数 open', async () => {
  const openDecision = await domain.askHuman({
    taskId: humanBoard.id, kind: 'decision', topic: '开放决策', problem: 'p', decisionNeeded: 'd',
    asks: [{ key: 'q1', question: '？', why: 'w', type: 'confirm' }],
  })
  const answered = await domain.askHuman({
    taskId: humanBoard.id, kind: 'info', topic: '已回通知', category: 'info', body: 'n',
  })
  await store.tx((s) => {
    const row = s.human_inbox.find((x) => x.id === answered.id)
    row.status = 'answered'
  })
  await domain.askHuman({
    taskId: pending.id, kind: 'risk', topic: '待批', problem: 'p', decisionNeeded: 'd', category: 'approval',
    asks: [{ key: 'q1', question: '？', why: 'w', type: 'confirm' }],
  })
  const inbox = view().inbox
  const row = inbox.items.find((x) => x.id === openDecision.id)
  assert.equal(row.category, 'decision')
  assert.ok(Array.isArray(row.refs))
  assert.ok(row.updatedAt)
  assert.equal(typeof row.replyCount, 'number')
  assert.equal(typeof inbox.open, 'number')
  assert.ok(inbox.byTask)
  assert.equal(inbox.categories.decision, 1)
  assert.equal(inbox.categories.approval, 1)
  assert.equal(inbox.categories.info, 0, 'answered 的 info 不进 open 计数')
  for (const key of ['approval', 'acceptance', 'external-pr', 'blocked', 'decision', 'info']) {
    assert.equal(typeof inbox.categories[key], 'number', key)
  }
})

await t('config 白名单含远程模式只读字段；laneMessages 空时是 []，有消息时最多 50 并带 latestAt', async () => {
  const cfg = view().project.config
  assert.equal(cfg.remoteMode, false)
  assert.equal(typeof cfg.remoteReady, 'boolean')
  assert.ok('remoteReason' in cfg)
  assert.deepEqual(cfg.externalPr, { autoMerge: false })
  assert.equal(cfg.acceptanceTickets, true)
  assert.equal(cfg.recordIssues, false)
  assert.equal(cfg.pushRemote, false)
  assert.equal('autoLane' in cfg, true)
  assert.equal(cfg.autoAccept, false)
  assert.equal(cfg.autoMerge, false)
  assert.equal('closePullOnMerge' in cfg, true)
  assert.deepEqual(view().laneMessages, [])
  for (let i = 0; i < 60; i += 1) {
    await postLaneMessage(store.state, project.id, {
      body: 'm' + i,
      to: 'human',
      from: { kind: 'agent', lane: 'human', agentId: 'ag' },
    }, {})
  }
  const lm = view().laneMessages
  assert.equal(lm.items.length, 50)
  assert.ok(lm.latestAt)
  assert.equal(lm.items[0].body, 'm59')
})

const handler = createHttpHandler({
  domain,
  runtime: {
    async ensureSession() { return { ok: true, sessionId: 'ses' } },
    async promptSession() { return { ok: true } },
  },
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

await t('remoteMode=false 时写远程键返回 400 且不清已有值', async () => {
  await store.tx((s) => {
    s.projects[project.id].config.remote = { kind: 'github', owner: 'acme', repo: 'app', token: 'keep' }
    s.projects[project.id].config.remoteMode = false
  })
  const res = await post('project.config', { projectId: project.id, patch: { recordIssues: true } })
  assert.equal(res.status, 400)
  assert.match(String(res.body.error || ''), /先开启远程模式/)
  assert.equal(store.state.projects[project.id].config.recordIssues, false)
  assert.equal(store.state.projects[project.id].config.remote.token, 'keep')
  const local = await post('project.config', { projectId: project.id, patch: { autoAccept: true, autoMerge: true, autoDispatch: true } })
  assert.equal(local.status, 200, JSON.stringify(local.body).slice(0, 240))
  assert.equal(store.state.projects[project.id].config.autoAccept, true)
  assert.equal(store.state.projects[project.id].config.autoMerge, true)
  assert.equal(store.state.projects[project.id].config.autoDispatch, true)
})

await t('remoteMode=true 缺坐标 / pushRemote / merge 能力时 400；齐全后可开，autoLane 仍要 recordIssues', async () => {
  const noCoord = await post('project.config', { projectId: project.id, patch: { remoteMode: true, remote: null } })
  assert.equal(noCoord.status, 400)
  assert.equal(store.state.projects[project.id].config.remoteMode, false)
  await store.tx((s) => {
    s.projects[project.id].config.remote = { kind: 'gitea', owner: 'acme', repo: 'app', baseUrl: 'https://git.example' }
  })
  const gitea = await post('project.config', { projectId: project.id, patch: { remoteMode: true, pushRemote: true } })
  assert.equal(gitea.status, 400, 'Gitea 不能合并，不能开远程模式')
  assert.equal(store.state.projects[project.id].config.remoteMode, false)
  const opened = await post('project.config', {
    projectId: project.id,
    patch: {
      remoteMode: true,
      pushRemote: true,
      remote: { kind: 'github', owner: 'acme', repo: 'app' },
    },
  })
  assert.equal(opened.status, 200, JSON.stringify(opened.body).slice(0, 300))
  assert.equal(store.state.projects[project.id].config.remoteMode, true)
  assert.equal(store.state.projects[project.id].config.remote.owner, 'acme')
  const lane = await post('project.config', { projectId: project.id, patch: { autoLane: true } })
  assert.equal(lane.status, 400)
  assert.match(String(lane.body.error || ''), /没有 issue 入站就没有自动卡/)
  assert.notEqual(store.state.projects[project.id].config.autoLane, true)
  const withIssues = await post('project.config', { projectId: project.id, patch: { recordIssues: true, autoLane: true } })
  assert.equal(withIssues.status, 200, JSON.stringify(withIssues.body).slice(0, 240))
  assert.equal(store.state.projects[project.id].config.autoLane, true)
  const closed = await post('project.config', { projectId: project.id, patch: { remoteMode: false } })
  assert.equal(closed.status, 200, JSON.stringify(closed.body).slice(0, 240))
  assert.equal(store.state.projects[project.id].config.remoteMode, false)
  assert.equal(store.state.projects[project.id].config.remote.owner, 'acme', '关远程模式不删 remote')
})

console.log(NL + pass + ' passed, ' + fails.length + ' failed')
if (fails.length) process.exit(1)
