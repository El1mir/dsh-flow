/**
 * 本地预览：把插件的工作台挂到 http://127.0.0.1:8791 上（不依赖 DSH，用于看界面）。
 * 数据落在 test/.preview/flow.json，每次启动会灌一份演示数据。
 */
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createHttpHandler } from '../lib/http.js'
import { ChatHub } from '../lib/chat.js'
import { createDispatcher } from '../lib/dispatch.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataFile = join(here, '.preview', 'flow.json')
mkdirSync(dirname(dataFile), { recursive: true })
rmSync(dataFile, { force: true })

const store = new Store(dataFile)
await store.load()

// 预览用的假 runtime：会话是假的，但聊天帧会真的进 ChatHub，界面上能看到来回。
const hub = new ChatHub()
const rt = {
  calls: [],
  async ensureSession(agent, project, opts = {}) {
    const rec = domain.latestSession(agent.id)
    const wantCwd = opts.cwd || (project && project.workspacePath) || null
    if (rec && rec.sessionId && agent.role === 'chief') return { ok: true, sessionId: rec.sessionId }
    if (rec && rec.sessionId && (!wantCwd || !rec.cwd || rec.cwd === wantCwd)) return { ok: true, sessionId: rec.sessionId }
    const sessionId = 'ses-' + agent.id + '-' + Math.random().toString(36).slice(2, 6)
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: wantCwd }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async agentSession(agentId) {
    const agent = store.state.agents[agentId]
    if (!agent) return { ok: false, message: 'unknown agent: ' + agentId }
    const project = store.state.projects[agent.projectId]
    const rec = domain.latestSession(agentId)
    const ens = rec && rec.sessionId ? { ok: true, sessionId: rec.sessionId } : await this.ensureSession(agent, project)
    if (!ens.ok) return ens
    return { ok: true, agentId, role: agent.role, name: agent.name, sessionId: ens.sessionId, cwd: rec && rec.cwd || project.workspacePath, projectId: agent.projectId }
  },
  async listSessions() {
    const latest = {}
    for (const rec of Object.values(store.state.agent_sessions)) {
      if (rec && rec.sessionId) latest[rec.agentId] = rec.sessionId
    }
    const bySession = {}
    for (const [agentId, sid] of Object.entries(latest)) bySession[sid] = agentId
    const bound = Object.values(store.state.agent_sessions)
      .filter((r) => r.sessionId)
      .map((r, i) => ({
        sessionId: r.sessionId,
        cwd: r.cwd || 'C:/tmp/demo',
        updatedAt: Date.now() - i * 3600000,
        running: i === 0,
        model: 'deepseek-v4.1-flash',
        provider: 'deepseek',
        boundAgentId: bySession[r.sessionId] || null,
      }))
    return bound.concat([
      { sessionId: 'ses_dsh_alpha', cwd: 'C:/Users/Administrator/Desktop/prjs/ework', updatedAt: Date.now() - 1800000, running: false, model: 'deepseek-v4.1-flash', provider: 'deepseek', boundAgentId: null },
      { sessionId: 'ses_dsh_beta', cwd: 'C:/Users/Administrator/Desktop/prjs/dsh-lens', updatedAt: Date.now() - 7200000, running: false, model: 'deepseek-v4.1-pro', provider: 'deepseek', boundAgentId: null },
    ])
  },
  async listCommands() {
    return [
      { name: 'goal', description: '设定/查看这个会话的目标', usage: '/goal <objective>' },
      { name: 'compact', description: '压缩上下文' },
      { name: 'feedback', description: '记录一条反馈' },
    ]
  },
  async bindAgentSession(agentId, sessionId) {
    const rec = await domain.bindSession(agentId, sessionId, { state: 'idle', cwd: 'C:/tmp/demo' }, { role: 'human', id: 'web' })
    return { ok: true, agentId, sessionId, cwd: 'C:/tmp/demo', record: rec.id }
  },
  async runCommand(agentId, line) {
    const rec = domain.latestSession(agentId)
    const sid = rec && rec.sessionId
    if (sid) {
      const name = String(line).replace(/^\//, '').split(/\s+/)[0]
      const args = String(line).replace(/^\/\S+\s*/, '')
      hub.ingest({ id: sid }, { type: 'command/run', data: { name, args } })
      hub.ingest({ id: sid }, { type: 'command/done', data: { kind: 'success', text: '（预览）' + name + ' 已执行' } })
    }
    return { ok: true, sessionId: sid, commandId: 'cmd_preview', kind: 'success', text: '（预览）命令已执行：' + line }
  },
  async promptSession(sessionId, text, mode, opts = {}) {
    this.calls.push({ sessionId, text, mode })
    if (opts.origin === 'system') hub.markSystem(sessionId, text)
    hub.ingest({ id: sessionId }, { type: 'user/message', data: { message: { content: [{ type: 'text', text: text.slice(0, 400) }] } } })
    hub.ingest({ id: sessionId }, { type: 'turn/start', data: { turn: 1 } })
    const reply = text.includes('【巡检请求')
      ? '巡检包收到：工人已停，报告里说测试全绿。我核对了验收标准，证据够，推到待验收；PR 开好我来审。'
      : text.includes('【案卷')
        ? '案卷已发给工人，目标也重建了。它会在自己会话里循环推进，卡住会主动停。'
        : '收到。我先看板子和代码，需要动手就用工具，拆完把计划贴回任务里。'
    setTimeout(() => {
      hub.ingest({ id: sessionId }, { type: 'tool/call', data: { name: 'flow_board', arguments: '{}', callId: 'c1' } })
      hub.ingest({ id: sessionId }, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '6 列 · 9 个任务 · 1 个在跑' }], toolCallId: 'c1' } } })
      hub.ingest({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } })
      hub.ingest({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }, 700)
    return { ok: true }
  },
  async workerGoal(project, { agentId, objective }) {
    this.calls.push({ agentId, objective })
    return { ok: true }
  },
  async onMoved(task, action) { return dispatcher.onMoved(task, action) },
  async onStopped(task) { return dispatcher.onStopped(task) },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })

const project = await domain.ensureProject({ workspacePath: 'C:/Users/Administrator/Desktop/prjs/dsh-flow', name: 'dsh-flow' })
// 代理池由 ensureProject 按 config 自动补齐，这里只取来用
const pool = Object.values(domain.store.state.agents).filter((a) => a.projectId === project.id)
// 对话框默认发给总调度者（与 domain.chatTarget 一致）
const d1 = pool.find((a) => a.role === 'chief') || pool.find((a) => a.role === 'dispatcher')

const t1 = await domain.createTask(project.id, { title: '把合并审核改成 prompt 集驱动', note: '现在审核结论是硬编码的，改成可配置判据。', acceptance: ['任一 block 命中即 risk', '结论里带 prompt 版本'], priority: 'high' })
await domain.move(t1.id, 'claim', { role: 'dispatcher', id: 'disp' })
await domain.setPlan(t1.id, '1. 建 review_prompts 表\n2. 审核时快照版本\n3. 写测试', { role: 'dispatcher' })
await domain.move(t1.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(t1.id, 'approve', { role: 'human', id: 'me' })
await domain.comment(t1.id, '计划看着没问题，注意别改 API。', { role: 'human', id: 'me' })

const t2 = await domain.createTask(project.id, { title: '工作台首页：项目列表 + 代理状态', note: '主页显示有哪些项目，每个项目绑定一个 DSH 工作区。', acceptance: ['能看到代理在线状态', '能切项目'], priority: 'medium' })
await domain.move(t2.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(t2.id, '先出静态稿，再接 SSE', { role: 'dispatcher' })
await domain.move(t2.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(t2.id, 'approve', { role: 'human' })
await domain.move(t2.id, 'stop', { role: 'worker' }, { stopReport: { summary: '三栏骨架完成，SSE 已通' } })
await domain.comment(t2.id, '截图看一下移动端。', { role: 'human', id: 'me' })

const t3 = await domain.createTask(project.id, { title: '租约 fencing 单测', note: '并发抢同一把锁要能证明谁被 fence 掉。', acceptance: ['两个 worker 抢锁只有一个成功'] })
await domain.move(t3.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(t3.id, '用 fake timer 推进 TTL', { role: 'dispatcher' })
await domain.move(t3.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(t3.id, 'approve', { role: 'human' })
await domain.move(t3.id, 'stop', { role: 'worker' }, { stopReport: { summary: '测试全绿，34 项' } })
await domain.move(t3.id, 'accept', { role: 'human' }, { headSha: 'a1b2c3d' })
await domain.openMergeRequest(t3.id, { headSha: 'a1b2c3d', baseSha: '0f0e0d0', files: ['test/smoke.mjs', 'lib/core.js'], additions: 88, deletions: 3, summary: '加租约与 fencing 断言' }, { role: 'worker' })

const t4 = await domain.createTask(project.id, { title: '接 DSH sessionController 的 steer', note: '调度员插话不能打断当前回合。', acceptance: ['mode=steer 生效'] })
await domain.block(t4.id, '等 sessionController 的 remote 签名确认', { role: 'human' })

await domain.createTask(project.id, { title: '风险任务：升级 react 18', note: '依赖升级，warn 级判据。' })
const t6 = await domain.createTask(project.id, { title: '写 DoD 清单', note: '每个里程碑的出口标准。', acceptance: ['M0 能跑通一次派工'] })
await domain.move(t6.id, 'cancel', { role: 'human' })

// 自动调度区：来自远程 issue 的卡不进看板，只在左侧「自动调度」里
const a1 = await domain.createTask(project.id, { origin: 'auto', title: '远程 issue #42：合并前跑一次 dry-run', note: '来自 gitea #42 的镜像卡。调度员和工人照样能在详情页里评论。' })
const a2 = await domain.createTask(project.id, { origin: 'auto', title: '远程 issue #43：把 PR 描述写成中文', note: '来自 gitea #43。' })
// 镜像记录 + 绑定，详情页页头才会显示来源标签
for (const [task, remoteId, title] of [[a1, '42', '合并前跑一次 dry-run'], [a2, '43', '把 PR 描述写成中文']]) {
  await domain.upsertMirror(project.id, { remoteId, kind: 'issue', source: 'gitea', title, state: 'open', action: 'opened', updatedAt: new Date().toISOString() }, { role: 'system', id: 'demo' })
  await domain.linkMirror(project.id, remoteId, task.id)
}

// 演示对话：让对话框打开时就有上下文
{
  const ens = await rt.ensureSession(d1, project)
  const say = (kind, payload) => hub.ingest({ id: ens.sessionId }, { type: kind, data: payload })
  say('user/message', { message: { content: [{ type: 'text', text: '这周先把合并审核改成 prompt 集驱动；另外工作台要能直接和你说话，不用切回聊天区。' }] } })
  say('turn/start', { turn: 1 })
  say('tool/call', { name: 'flow_board', arguments: '{}', callId: 'c0' })
  say('tool/result', { message: { content: [{ type: 'text', text: '6 列 · 9 个任务 · 2 个阻塞' }], toolCallId: 'c0' } })
  say('assistant/message', { message: { content: [{ type: 'text', text: '拆成三条：①审核判据进 review_prompts 表（已有 6 条默认判据）②审核结论绑定 prompt 版本 ③工作台加对话框。第 ① 条我已经写了计划，等你批准；另外两条在待办。' }] } })
  say('turn/end', { reason: { kind: 'completed' } })
}

const host = {
  domain,
  chat: hub,
  runtime: rt,
  ensureProject: (a) => domain.ensureProject(a),
  resolveProject: async () => project,
  resolveProjectById: (id) => store.state.projects[id],
  listProjects: () => Object.values(store.state.projects),
  // 预览里的“已有工作区”列表（真环境来自 DSH workspaceRegistry）
  listWorkspaces: () => [
    { id: 'ws_1', title: 'dsh-flow', path: 'C:/Users/Administrator/Desktop/prjs/dsh-flow', sessions: 3, updatedAt: new Date().toISOString(), projectId: project.id },
    { id: 'ws_2', title: 'ework', path: 'C:/Users/Administrator/Desktop/prjs/ework', sessions: 7, updatedAt: new Date().toISOString(), projectId: null },
    { id: 'ws_3', title: 'dsh-lens', path: 'C:/Users/Administrator/Desktop/prjs/dsh-lens', sessions: 1, updatedAt: new Date().toISOString(), projectId: null },
  ],
}
const handler = createHttpHandler(host)

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(302, { location: '/api/flow/app' }); return res.end() }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const request = new Request('http://local' + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body })
  const response = await handler(request)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  }
  res.end()
})

server.listen(8791, '127.0.0.1', () => console.log('preview http://127.0.0.1:8791/api/flow/app'))
