/**
 * host.mjs — 插件与 DSH 宿主的「接口契约」测试。
 *
 * 不用真 DSH，用一个最小的 Cordis 替身验证 dsh-flow 只走官方扩展点：
 *   ctx.tools.register · ctx.on · ctx.effect · ctx.inject · ctx.reflect.get
 *   webServer.register({kind:'prefix'}) · connection.admit(Request) · webserver/index-inject
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { emptyState } from '../lib/core.js'

const dir = mkdtempSync(join(os.tmpdir(), 'dsh-flow-host-'))
process.env.DSH_FLOW_FILE = join(dir, 'flow.json')

// 预置一份磁盘数据：DSH 重启后，只读接口（/state、/agent/:id/session、工具）
// 必须能看到它，不能等第一次写事务才 load。
const seed = emptyState()
seed.projects.prj_seed = {
  id: 'prj_seed',
  name: 'seed',
  workspacePath: 'C:/work/seed',
  workspaceId: 'ws_seed',
  createdAt: '2026-10-18T00:00:00.000Z',
  config: { dispatchers: 1, workers: 1, chiefs: 1 },
}
seed.agents.ag_seed = {
  id: 'ag_seed',
  projectId: 'prj_seed',
  name: '总调度者',
  role: 'chief',
  slot: 1,
  preset: null,
  enabled: true,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
}
writeFileSync(process.env.DSH_FLOW_FILE, JSON.stringify(seed, null, 2))

const { apply } = await import('../index.js')

const calls = { tools: [], routes: [], effects: [], listeners: {}, injects: [], prompts: [], commands: [], sessionCreates: 0, sessionCreateArgs: [], agentMessages: [] }
const services = {
  webServer: {
    register(route) {
      calls.routes.push(route)
      return () => { const i = calls.routes.indexOf(route); if (i >= 0) calls.routes.splice(i, 1) }
    },
  },
  connection: {
    admit(request) {
      const url = new URL(request.url)
      if (url.searchParams.get('deny') === '1') return { rejection: 401 }
      return { peer: { id: 'operator' } }
    },
  },
  sessionController: {
    async create(request = {}) {
      // 与真实 DSH 一致：workspaceId 与 cwd 只能二选一
      if (request.workspaceId !== undefined && request.cwd !== undefined) throw new Error('session.create accepts workspaceId or cwd, not both')
      calls.sessionCreates += 1
      calls.sessionCreateArgs.push({ ...request })
      return { sessionId: 'ses_created_' + calls.sessionCreates }
    },
    async prompt(request, signal) {
      // 真实 Host 的 prompt 签名是 (request, signal)；少传会在内部 signal.throwIfAborted() 崩
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      signal.throwIfAborted()
      calls.prompts.push(request)
    },
    async list() {
      return {
        items: [
          { sessionId: 'ses_a', cwd: 'C:/work/alpha', updatedAt: 1, running: false, projections: { values: { modelSelection: { lastUsed: { provider: 'deepseek', model: 'm-1' }, next: null } } } },
          { sessionId: 'ses_b', cwd: 'C:/work/beta', updatedAt: 2, running: true },
        ],
      }
    },
    async inspect(sessionId) {
      if (typeof sessionId !== 'string') throw new TypeError('inspect(sessionId): sessionId must be a string, got ' + typeof sessionId)
      return { meta: { cwd: sessionId === 'ses_b' ? 'C:/work/beta' : 'C:/work/alpha' } }
    },
    async resolveAgent(sessionId) {
      // v1.37.2：flow 现在自己造 message 走 agent.followup/steer（为了能给消息打
      // source.kind='plugin:dsh-flow'，让下游插件分清机器通知和用户提问）。
      // 假 Agent 要跟着支持这两个方法，否则测不到那条路径。
      const agent = {
        session: { header: { id: sessionId } },
        inbox: { nextTurn: [], nextStep: [] },
        followup(message) { calls.agentMessages.push({ sessionId, mode: 'followup', message }) },
        steer(message) { calls.agentMessages.push({ sessionId, mode: 'steer', message }) },
      }
      return { agent }
    },
  },
  commands: {
    async execute(agent, line) { calls.commands.push(line); return { commandId: 'cmd_1', result: { kind: 'success', text: 'goal 已建立' } } },
    list() { return [{ name: 'goal', description: '设定目标' }, { name: 'compact', description: '压缩上下文' }] },
    register(def) { calls.commandDefs = calls.commandDefs || []; calls.commandDefs.push(def); return () => {} },
  },
  systemPrompt: {
    section(def) { calls.promptSections = calls.promptSections || []; calls.promptSections.push(def); return () => {} },
    getSectionOrder(name) { return name === 'PLAN_POLICY' ? 40 : 100 },
  },
  workspaceController: {},
  goals: {},
  // 真实 registry 有 get(id) / resolveByPath(path) / list()；预置项目绑的就是 ws_seed，
  // 这里必须照实提供 get，否则『项目的工作区 id 有效』这条路径测不到。
  workspaceRegistry: {
    get: (id) => (id === 'ws_seed' ? { id: 'ws_seed', path: 'C:/work/seed', title: 'seed', sessionIds: [], attachSession: async () => {} } : undefined),
  },
  // domain 内部走真实 store，这里只观察 /flow 命令是否触发绑定：用 events 里的 chief.session.bound 断言更稳
}

const makeCtx = () => {
  const ctx = {
    tools: {
      register(tool) { calls.tools.push(tool) },
      // 全局 ctx 上的 restrict：v1.4 起 flow 模式**绝不能**走这条（会 mask 掉所有 agent）
      restrict() { calls.globalRestrictCalled = (calls.globalRestrictCalled || 0) + 1; throw new Error('a context-global restriction would mask every agent') },
    },
    on(event, cb) { (calls.listeners[event] ||= []).push(cb); return () => {} },
    effect(cb, label) {
      const dispose = cb()
      calls.effects.push({ label, dispose })
      return dispose
    },
    inject(deps, cb) { calls.injects.push(deps); return cb(ctx) },
    reflect: { get(name) { return services[name] } },
    logger: { warn() {}, error() {} },
  }
  return ctx
}

class FakeRes {
  constructor() {
    this.status = 0
    this.headers = {}
    this.chunks = []
    this.writableEnded = false
    this.destroyed = false
    this.headersSent = false
  }
  writeHead(status, headers) { this.status = status; this.headers = { ...(headers || {}) }; this.headersSent = true }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true }
  end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true }
  on() {} once() {} off() {}
  get text() { return Buffer.concat(this.chunks).toString('utf8') }
}

const fakeReq = ({ url, method = 'GET', headers = {} }) => {
  const req = Readable.from([])
  req.url = url
  req.method = method
  req.headers = headers
  return req
}

const dispose = apply(makeCtx())

// 1) 工具注册走 ctx.tools.register
assert.ok(calls.tools.length >= 15, '工具数应 >= 15，实际 ' + calls.tools.length)
assert.ok(calls.tools.every((t) => typeof t.name === 'string' && typeof t.execute === 'function'), '每个工具要有 name/execute')
assert.ok(calls.tools.every((t) => Array.isArray(t.output.render({}, 'x'))), 'output.render 必须返回 ContentBlock[]')

// v1.0：/flow 命令、系统提示段落、工具收回
assert.ok(Array.isArray(calls.commandDefs) && calls.commandDefs.some((d) => d.name === 'flow'), '/flow 命令已注册')
assert.ok(Array.isArray(calls.promptSections) && calls.promptSections.some((s) => s.name === 'flow:dispatch'), 'flow:dispatch 提示段落已注册')
{
  const flow = calls.commandDefs.find((d) => d.name === 'flow')
  const agent = {
    session: { header: { id: 'ses_flow' } },
    // 真实 Host：agent.ctx.tools —— restrict 必须落在这里。
    // schemas() 真实存在（dsh-tools 的 schemas(scope?)），进入模式前要靠它把
    // 意图清单收敛成"本构建真的有的工具名"，否则 restrict 会对未知名原子失败。
    ctx: {
      tools: {
        schemas() { return [{ name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'read' }] },
        get(name) { return ['write', 'edit', 'pwsh', 'read'].includes(name) ? { name } : undefined },
        restrict(filter) { calls.restrict = filter; return () => { calls.restrict = null } },
      },
    },
  }
  const on = await flow.handler({ agent, rawInput: '' })
  assert.equal(on.kind, 'success', '/flow 进入成功')
  assert.ok(calls.restrict && Array.isArray(calls.restrict.deny), '进入后调用了 tools.restrict(deny)')
  assert.equal(calls.globalRestrictCalled || 0, 0, '只能用 agent.ctx.tools.restrict，不能碰全局 ctx.tools.restrict')
  assert.ok(calls.restrict.deny.includes('write'), 'deny 列表要覆盖真实存在的写工具')
  assert.equal(calls.restrict.deny.includes('bash'), false, '本构建没有 bash，不能进 deny（会原子失败）')
  const status = await flow.handler({ agent, rawInput: 'status' })
  assert.match(status.text, /开启/)
  const off = await flow.handler({ agent, rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.equal(calls.restrict, null, '退出后工具集恢复')
  // 主调度 = 默认聊天区：进入 /flow 时把当前会话绑到当前工作区所属项目
  assert.match(on.text, /调度模式/, '进入提示说明了调度模式')
}

// 2) 路由走 webServer.register({kind:'prefix'})，不是 connection.fetch.register
assert.equal(calls.routes.length, 1, '应只注册一条路由')
assert.equal(calls.routes[0].kind, 'prefix', '必须是前缀路由（精确路由覆盖不到 /api/flow/app）')
assert.equal(calls.routes[0].path, '/api/flow')
assert.equal(typeof calls.routes[0].handler, 'function')
assert.ok(calls.injects.some((d) => Array.isArray(d) && d.includes('webServer')), '应用 ctx.inject([webServer]) 挂路由')

// 3) v1.3：不再往 index.html 注入浮标，入口是会话里的「调度台」标签
const table = []
for (const cb of calls.listeners['webserver/index-inject'] || []) cb(table)
assert.equal(table.length, 0, '不再注入浮标（原先在右下角跳 /api/flow/app）')

// 4) 前缀路由真的能把 /api/flow/app 送到 lib/http.js（node req/res ↔ Fetch 桥）
const route = calls.routes[0]
const okRes = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/app', headers: { host: '127.0.0.1:3080' } }), okRes)
assert.equal(okRes.status, 404, 'v1.3 已删除独立工作台页面，/api/flow/app 应 404，实际 ' + okRes.status)

// 5) 状态与动作入口也在前缀路由下
const stateRes = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/state' }), stateRes)
assert.equal(stateRes.status, 200)
const firstState = JSON.parse(stateRes.text)
assert.ok(firstState.projects !== undefined, 'state 应有 projects')
assert.deepEqual(firstState.state.projects.map((p) => p.id), ['prj_seed'], 'DSH 重启后只读接口要能看到磁盘里的项目（启动即 load）')
assert.deepEqual(firstState.state.agents.map((a) => a.id), ['ag_seed'], '只读接口要能看到磁盘里的代理')

// 5b) v1.2：会话 → 项目解析、单项目事务视图、主调度绑定/解绑
{
  const call = async (url, init = {}) => {
    const res = new FakeRes()
    const req = init.body
      ? (() => {
        const r = Readable.from([Buffer.from(JSON.stringify(init.body))])
        r.url = url
        r.method = 'POST'
        r.headers = { 'content-type': 'application/json', host: '127.0.0.1:3080' }
        return r
      })()
      : fakeReq({ url, headers: { host: '127.0.0.1:3080' } })
    await route.handler(req, res)
    let body = null
    try { body = JSON.parse(res.text) } catch { /* 非 JSON */ }
    return { status: res.status, body }
  }

  // 未绑定时按 cwd 解析（sessionController.inspect 给 C:/work/alpha）
  const r1 = await call('/api/flow/session-project?sessionId=ses_a')
  assert.equal(r1.status, 200)
  assert.equal(r1.body.ok, false, '没有项目的会话应返回 ok:false')

  // 建项目 → cwd 命中
  const created = await call('/api/flow/action', { body: { action: 'project.ensure', args: { workspacePath: 'C:/work/alpha', name: 'alpha' } } })
  assert.ok(created.body && (created.body.result || created.body).ok !== false, 'project.ensure 应成功')
  const r2 = await call('/api/flow/session-project?sessionId=ses_a')
  assert.equal(r2.body.ok, true, 'cwd 命中后应解析出项目')
  assert.equal(r2.body.matchedBy, 'workspace')

  // 单项目事务视图
  const view = await call('/api/flow/project?projectId=' + encodeURIComponent(r2.body.projectId))
  assert.equal(view.status, 200)
  assert.equal(view.body.ok, true)
  assert.ok(Array.isArray(view.body.columns) && view.body.columns.length === 7, '七列')
  assert.ok(view.body.lanes && view.body.lanes.human && view.body.lanes.issue, '双车道')

  // 绑定主调度 → session-project 以 chief 优先
  const bound = await call('/api/flow/action', { body: { action: 'chief.bind', args: { projectId: r2.body.projectId, sessionId: 'ses_a' } } })
  const boundRes = (bound.body && (bound.body.result || bound.body)) || {}
  assert.equal(boundRes.ok !== false, true, 'chief.bind 应成功')
  // v1.4：不再以「绑定」优先——工作区就是项目，绑不绑都解析到同一个项目
  const r3 = await call('/api/flow/session-project?sessionId=ses_a')
  assert.equal(r3.body.ok, true, '绑定后仍能解析')
  assert.equal(r3.body.projectId, r2.body.projectId, '绑不绑都落到同一个工作区项目')

  // 解绑后回到 cwd 解析
  const unbound = await call('/api/flow/action', { body: { action: 'chief.unbind', args: { projectId: r2.body.projectId } } })
  const unboundRes = (unbound.body && (unbound.body.result || unbound.body)) || {}
  assert.equal(unboundRes.ok, true, 'chief.unbind 应成功')
  const r4 = await call('/api/flow/session-project?sessionId=ses_a')
  assert.equal(r4.body.projectId, r2.body.projectId, '解绑后仍然是同一个工作区项目')
}

// 5c) worktree 目录不能被当成新项目（v1.2 修复：最长前缀匹配 + 拒绝 .flow-worktrees）
{
  const call = async (url) => {
    const res = new FakeRes()
    await route.handler(fakeReq({ url, headers: { host: '127.0.0.1:3080' } }), res)
    try { return JSON.parse(res.text) } catch { return null }
  }
  // 造一个项目，然后让会话 cwd 落在它的 worktree 目录下
  const created = await (async () => {
    const res = new FakeRes()
    const req = Readable.from([Buffer.from(JSON.stringify({ action: 'project.ensure', args: { workspacePath: 'C:/work/alpha', name: 'alpha' } }))])
    req.url = '/api/flow/action'
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3080' }
    await route.handler(req, res)
    return JSON.parse(res.text)
  })()
  // 不猜 /action 的封装：从 /state 里按路径反查项目 id
  const snap = await call('/api/flow/state')
  const projectId = ((snap && snap.state && snap.state.projects) || [])
    .find((p) => p.workspacePath === 'C:/work/alpha')?.id
  assert.ok(projectId, 'project.ensure 后 /state 里应出现该项目')

  // 会话 cwd 指向 worktree：session-project 仍应命中父项目，不应新建
  const originalInspect = services.sessionController.inspect
  services.sessionController.inspect = async (sessionId, signal) => {
    if (typeof sessionId !== 'string') throw new TypeError('inspect(sessionId): sessionId must be a string')
    if (sessionId === 'ses_in_worktree') return { meta: { cwd: 'C:/work/alpha/.flow-worktrees/alpha/T-9' } }
    return originalInspect(sessionId, signal)
  }
  const before = Object.keys(services.__projects || {}).length
  const hit = await call('/api/flow/session-project?sessionId=ses_in_worktree')
  assert.equal(hit.ok, true, 'worktree 内的会话应命中父项目')
  assert.equal(hit.projectId, projectId, '命中的是最长前缀的父项目')
  assert.equal(hit.matchedBy, 'workspace')
  services.sessionController.inspect = originalInspect
}

// 6) 鉴权复用 connection.admit：拒绝时 401
const denyRes = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/app?deny=1' }), denyRes)
assert.equal(denyRes.status, 401, 'admit 拒绝时应 401')
assert.equal(denyRes.text, 'unauthorized')

// 7) POST 动作走同一个前缀路由（读 body）
const actionRes = new FakeRes()
const postReq = Readable.from([Buffer.from(JSON.stringify({ action: 'state', projectId: null }))])
postReq.url = '/api/flow/action'
postReq.method = 'POST'
postReq.headers = { 'content-type': 'application/json' }
await route.handler(postReq, actionRes)
assert.ok([200, 400].includes(actionRes.status), 'POST /api/flow/action 应有响应，实际 ' + actionRes.status)

// 7b) 新建项目的数据源：工作区列表来自 workspaceRegistry.list()
services.workspaceRegistry.list = () => [
  { id: 'ws_1', path: 'C:/work/alpha', title: 'alpha', sessionIds: ['s1', 's2'], updatedAt: '2026-10-18T00:00:00.000Z' },
  { id: 'ws_2', path: 'C:/work/beta' },
]
const wsRes = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/workspaces' }), wsRes)
const wsBody = JSON.parse(wsRes.text)
assert.equal(wsRes.status, 200)
assert.equal(wsBody.items.length, 2, '工作区列表应有 2 条')
assert.equal(wsBody.items[0].sessions, 2, '会话数要带上')
assert.equal(wsBody.items[1].title, 'beta', '没有 title 时用路径末段')

const post = async (payload) => {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.url = '/api/flow/action'
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  const res = new FakeRes()
  await route.handler(req, res)
  return { status: res.status, body: JSON.parse(res.text || '{}') }
}

// 7c) 无标题建任务 → 未命名任务；任务详情页一次取全（任务 + 评论 + 运行 + 事件）
const proj = await post({ action: 'project.ensure', args: { workspacePath: 'C:/work/alpha', name: 'alpha' } })
assert.equal(proj.status, 200, 'project.ensure 应成功：' + JSON.stringify(proj.body).slice(0, 200))
const projectId = proj.body.result.id
const skillCatalog = await post({ action: 'skills.list', args: { projectId } })
assert.equal(skillCatalog.body.result.ok, true, '技能目录 HTTP action 应成功')
assert.ok(Array.isArray(skillCatalog.body.result.skills), '技能目录应返回数组')
const invalidSkillConfig = await post({ action: 'project.config', args: { projectId, patch: { allowedSkills: ['../escape'] } } })
assert.equal(invalidSkillConfig.body.ok, false, '配置拒绝非法技能名称')
const invalidRounds = await post({ action: 'project.config', args: { projectId, patch: { grillMaxRounds: 0 } } })
assert.equal(invalidRounds.body.ok, false, '配置拒绝零轮数')
const created = await post({ action: 'task.create', args: { projectId, title: '' } })
assert.equal(created.body.result.title, '未命名任务', '空标题应落到“未命名任务”')
const taskId = created.body.result.id
await post({ action: 'task.comment', args: { taskId, content: '先不开工，聊聊需求。', projectId } })

const detailRes = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/task/' + encodeURIComponent(taskId) }), detailRes)
const detail = JSON.parse(detailRes.text)
assert.equal(detailRes.status, 200)
assert.equal(detail.task.id, taskId)
assert.ok(Array.isArray(detail.comments) && detail.comments.length === 1, '详情里应带评论')
assert.equal(detail.comments[0].role, 'human', '评论要带角色')
assert.ok(Array.isArray(detail.runs) && Array.isArray(detail.events), '详情要带运行记录与事件')

const missRes = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/task/nope' }), missRes)
assert.equal(missRes.status, 404, '未知任务详情应 404')

// 7d) 总调度接 DSH 会话：/sessions 列表、命令通道、绑定
const sres = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/sessions' }), sres)
const sessBody = JSON.parse(sres.text)
assert.equal(sres.status, 200, '/sessions 应 200')
assert.equal(sessBody.items.length, 2, '应列出 DSH 里的会话')
assert.equal(sessBody.items[0].model, 'm-1', '会话要带当前模型（跟聊天框一致）')

const snap = await post({ action: 'state', args: { projectId } })
const chief = (snap.body.result.agents || []).find((a) => a.role === 'chief')
assert.ok(chief, '项目应有总调度者')

const bound = await post({ action: 'agent.bindSession', args: { agentId: chief.id, sessionId: 'ses_b' } })
assert.equal(bound.body.result.ok, true, '绑定应成功：' + JSON.stringify(bound.body).slice(0, 160))
assert.equal(bound.body.result.cwd, 'C:/work/beta', '绑定要取到会话的 cwd')
const dispatcherAgent = (snap.body.result.agents || []).find((a) => a.role === 'dispatcher')
assert.ok(dispatcherAgent, '项目应有调度员')
const sharedSession = await post({ action: 'agent.bindSession', args: { agentId: dispatcherAgent.id, sessionId: 'ses_b' } })
assert.equal(sharedSession.body.result.ok, false, 'DSH session 不允许同时绑定给多个代理')
assert.match(sharedSession.body.result.message, /已属于代理/)

// v0.6：总调度已绑会话时，侧栏路由必须返回原 sessionId
const chiefSession = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/agent/' + encodeURIComponent(chief.id) + '/session' }), chiefSession)
const chiefSessionBody = JSON.parse(chiefSession.text)
assert.equal(chiefSession.status, 200)
assert.equal(chiefSessionBody.sessionId, 'ses_b', 'chief 会话路由应复用已绑定 DSH session')
assert.equal(chiefSessionBody.role, 'chief')

const unknownAgentSession = new FakeRes()
await route.handler(fakeReq({ url: '/api/flow/agent/no-such-agent/session' }), unknownAgentSession)
assert.equal(unknownAgentSession.status, 404)

const workerAgent = (snap.body.result.agents || []).find((a) => a.role === 'worker')
assert.ok(workerAgent, '项目应有工人')
const agentSession = async (agentId) => {
  const response = new FakeRes()
  await route.handler(fakeReq({ url: '/api/flow/agent/' + encodeURIComponent(agentId) + '/session' }), response)
  return { status: response.status, body: JSON.parse(response.text) }
}
const dispatcherSession = await agentSession(dispatcherAgent.id)
const workerSession = await agentSession(workerAgent.id)
assert.equal(dispatcherSession.status, 200)
assert.equal(workerSession.status, 200)
assert.equal(dispatcherSession.body.role, 'dispatcher')
assert.equal(workerSession.body.role, 'worker')
assert.notEqual(dispatcherSession.body.sessionId, chiefSessionBody.sessionId)
assert.notEqual(workerSession.body.sessionId, dispatcherSession.body.sessionId, '每个代理都应有独立 session')
assert.equal(calls.sessionCreates, 2, '无绑定的 dispatcher 与 worker 分别创建 session')
for (const request of calls.sessionCreateArgs) {
  assert.ok(!(request.workspaceId !== undefined && request.cwd !== undefined), 'session.create 不能同时传 workspaceId 与 cwd：' + JSON.stringify(request))
  assert.ok(request.workspaceId !== undefined || request.cwd !== undefined, 'session.create 至少给 workspaceId 或 cwd 之一')
}

// 项目根目录（cwd === workspacePath）→ 只传 workspaceId；worktree 才会只传 cwd
const seeded = await agentSession('ag_seed')
assert.equal(seeded.status, 200, '预置 chief 应能建会话：' + JSON.stringify(seeded.body).slice(0, 200))
const seededCreate = calls.sessionCreateArgs.at(-1)
assert.equal(seededCreate.workspaceId, 'ws_seed', '项目根目录会话要挂到工作区')
assert.equal(seededCreate.cwd, undefined, '挂了 workspaceId 就不能再传 cwd')

const cmds = await post({ action: 'session.commands', args: { agentId: chief.id } })
assert.equal(cmds.body.result.items.length, 2, '应列出可用命令')

const run = await post({ action: 'chat.send', args: { agentId: chief.id, message: '/goal 把 README 补完' } })
assert.equal(run.body.result.ok, true, '命令应执行成功：' + JSON.stringify(run.body).slice(0, 160))
assert.equal(run.body.result.command, true, '/ 开头要走命令通道')
assert.equal(run.body.result.kind, 'success')
assert.equal(calls.commands.at(-1), '/goal 把 README 补完', '命令要原样交给 commands.execute')
assert.equal(calls.prompts.length, 0, '命令不能当 prompt 投给模型')

const say = await post({ action: 'chat.send', args: { agentId: chief.id, message: '你好' } })
assert.equal(say.body.result.ok, true)
// 人在调度台打的字是货真价实的用户提问：必须仍走 sessionController.prompt()，
// source.kind 保持 'user'。否则 codegraph 不会给人做检索、聊天界面也会把它折叠成"注入的上下文"。
assert.equal(calls.prompts.length, 1, '普通消息仍走 prompt')
assert.equal(calls.prompts[0].sessionId, 'ses_b', '绑过会话后消息投到那个聊天框')
assert.equal(calls.agentMessages.length, 0, '人的消息不该被标成 flow 的机器通知')

// 7b) v1.37.2：flow 的机器通知必须带自己的 source.kind
//
// DSH 的 sessionController.prompt() 把 source.kind 写死成 'user'，下游插件
// （codegraph 的 prompt front-load 等）就把 flow 的机器通知当成用户提问，
// 白跑索引检索再注入大段上下文。实测一个调度会话里 353 条 user 消息有 98 条是这种注入。
//
// 所以 flow 发机器通知时自己造 message 走 agent.followup，并标上 plugin:dsh-flow。
// 这里走 task.reply（内部 origin:'system'，和巡检包/回信同一条投递路径）验证。
{
  const snap = await post({ action: 'state', args: { projectId } })
  const dispatcher = (snap.body.result.agents || []).find((a) => a.role === 'dispatcher')
  assert.ok(dispatcher, '项目应有调度员')
  await post({ action: 'agent.bindSession', args: { agentId: dispatcher.id, sessionId: 'ses_b' } })

  const t0 = await post({ action: 'task.create', args: { projectId, title: '机器通知测试', originSessionId: 'ses_b' } })
  const taskId2 = t0.body.result.id || t0.body.result.taskId
  assert.ok(taskId2, '应建出任务：' + JSON.stringify(t0.body).slice(0, 160))

  const beforeMsgs = calls.agentMessages.length
  const beforePrompts = calls.prompts.length
  const reply = await post({ action: 'task.reply', args: { taskId: taskId2, message: '机器通知测试' } })
  assert.equal(reply.body.result.ok, true, '回信应成功：' + JSON.stringify(reply.body).slice(0, 200))

  assert.equal(calls.agentMessages.length, beforeMsgs + 1, '机器通知走 agent 投递（才带得上 source.kind）')
  const sent = calls.agentMessages.at(-1)
  assert.equal(sent.mode, 'steer', '事件回信必须插话，不能进入 followup 等待下一回合')
  assert.equal(sent.message.source.kind, 'plugin:dsh-flow', '必须标成 flow 自己的来源')
  assert.equal(sent.message.role, 'user', 'DSH 侧仍然是一条 user 消息')
  assert.equal(sent.message.source.form, 'notice', '界面据此折叠成一行，而不是铺开一大段')
  assert.equal(calls.prompts.length, beforePrompts, '机器通知不该再走 prompt（那样 source.kind 只能是 user）')
}


// 8) 真 node:http 服务器上跑一遍：IncomingMessage / ServerResponse 的真实行为
const { createServer } = await import('node:http')
const server = createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch((err) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(err && err.message))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

const appResp = await fetch(base + '/api/flow/app')
assert.equal(appResp.status, 404, 'v1.3：独立工作台页面已删除，真服务器上 /api/flow/app 应 404')

// SSE：首块必须真的流出来（桥接不能整段缓冲）
const ctrl = new AbortController()
const streamResp = await fetch(base + '/api/flow/stream', { signal: ctrl.signal })
assert.equal(streamResp.status, 200)
assert.match(streamResp.headers.get('content-type') || '', /text\/event-stream/)
const reader = streamResp.body.getReader()
const first = await Promise.race([
  reader.read(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('SSE 首块 3 秒未到（被缓冲了）')), 3000)),
])
assert.ok(first.value && first.value.byteLength > 0, 'SSE 首块应非空')
ctrl.abort()
await new Promise((resolve) => server.close(resolve))

// 9) 卸载后路由应被清理（ctx.effect 的 disposer）
await dispose()
assert.equal(calls.routes.length, 0, '插件卸载后路由要摘掉')

rmSync(dir, { recursive: true, force: true })
// 7) /flow 命令面（放在所有既有断言之后，避免影响前面的项目/代理池断言）
{
  const flow = calls.commandDefs.find((d) => d.name === 'flow')
  const agent2 = {
    session: { header: { id: 'ses_flow2' } },
    ctx: {
      tools: {
        schemas() { return [{ name: 'write' }, { name: 'edit' }] },
        get(name) { return ['write', 'edit'].includes(name) ? { name } : undefined },
        restrict(filter) { calls.restrict = filter; return () => { calls.restrict = null } },
      },
    },
  }
  const res = await flow.handler({ agent: agent2, rawInput: '' })
  assert.equal(res.kind, 'success', '/flow 进入成功（第二轮）')
  assert.match(res.text, /调度模式/)
  assert.ok(calls.restrict && calls.restrict.deny.length > 0, '第二次进入也要真的收回工具（deny 不能为空）')
  const off = await flow.handler({ agent: agent2, rawInput: 'off' })
  assert.equal(off.kind, 'success')
}

console.log('host contract: all checks passed')
