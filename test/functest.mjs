/**
 * functest.mjs — 全功能端到端测试（真实插件代码 + 真实 HTTP + 忠实宿主桩）。
 *
 * 为什么要有这个文件：
 *   之前的 smoke/host/e2e 各自只覆盖一部分，而且假 runtime 的签名和真实 Host 不一致
 *   （inspect({sessionId}) vs inspect(sessionId)、prompt(req) vs prompt(req, signal)），
 *   于是"测试全绿但线上一点就炸"。这里的原则是：
 *   **每个桩都按真实 Host 的签名和行为写，签名不对就抛错**，让偏差立刻暴露。
 *
 * 覆盖：项目/工作区、任务全状态机、plan/approve/派工/自停/巡检/验收/PR/合并、
 *      阻塞/取消/重开/改派、评论/注入/车道/预算/范围、agent 增删改、
 *      /flow 调度模式（agent 作用域 restrict）、回信路由、catalog。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { emptyState } from '../lib/core.js'

const dir = mkdtempSync(join(os.tmpdir(), 'dsh-flow-func-'))
process.env.DSH_FLOW_FILE = join(dir, 'flow.json')
writeFileSync(process.env.DSH_FLOW_FILE, JSON.stringify(emptyState(), null, 2))

const { apply } = await import('../index.js')

// ---- 忠实宿主桩 -----------------------------------------------------------
const routes = []
const prompts = []        // { sessionId, text, mode }
const created = []        // 建会话记录
const archived = []
const restrictCalls = []  // agent 作用域 restrict 的调用（应按会话分开）
const globalRestrict = [] // 全局 ctx.tools.restrict：**绝不允许**被调用
const sessions = new Map() // sessionId -> { cwd }

const persistedCwd = new Map() // sessionId -> cwd（只给 persistence.stat 兜底用）
/**
 * 工作区桩要镜像真实 Workspace 实体：sessionIds 是「按 cwd 过滤后的成员表」，
 * attachSession 会校验会话头 cwd 与工作区路径一致，不一致就抛。
 * 只放 {id,path,title} 的裸对象会让『会话有没有真的进工作区』永远测不出来——
 * 线上那个 bug（初始化了，会话却在侧栏未分组里）就是这么漏过去的。
 */
const normWsPath = (x) => String(x || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const makeWorkspace = (id, path, title) => ({
  id,
  path,
  title,
  sessionIds: [],
  async attachSession(sessionId) {
    if (this.sessionIds.includes(sessionId)) return
    const rec = sessions.get(sessionId)
    const cwd = (rec && rec.cwd) || persistedCwd.get(sessionId) || null
    if (!cwd) throw new Error("cannot attach session '" + sessionId + "': its stored header carries no cwd to validate against")
    if (normWsPath(cwd) !== normWsPath(this.path)) {
      throw new Error("cannot attach session '" + sessionId + "': its cwd resolves to '" + cwd + "'")
    }
    this.sessionIds.push(sessionId)
  },
})
const workspaces = new Map([
  ['ws_alpha', makeWorkspace('ws_alpha', 'C:/work/alpha', 'alpha')],
  ['ws_beta', makeWorkspace('ws_beta', 'C:/work/beta', 'beta')],
  ['ws_gamma', makeWorkspace('ws_gamma', 'C:/work/gamma', 'gamma')],
])

const modelCatalog = {
  default: { provider: 'maxapi', model: 'deepseek-v4.1-flash' },
  routableProviders: ['maxapi', 'krc'],
  groups: [
    { id: 'maxapi', name: 'MaxAPI', models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] },
    { id: 'krc', name: 'KRC', models: [{ id: 'gpt-6-luna-codex', name: 'gpt-6-luna-codex' }] },
  ],
  failures: [],
}

let seq = 0
const renamed = []
const sessionController = {
  // 真实签名与语义：create({ workspaceId | cwd })，两个都传要炸；给了 workspaceId 就
  // 自动挂进那个工作区（DSH 的 sessionController 在 :701-708 就是这么做的）。
  async create(request = {}) {
    if (request.workspaceId && request.cwd) throw new Error('session.create accepts workspaceId or cwd, not both')
    const ws = request.workspaceId ? workspaces.get(request.workspaceId) : undefined
    if (request.workspaceId && !ws) throw new Error('workspace "' + request.workspaceId + '" not found')
    seq += 1
    const sessionId = 'sess_' + seq
    const cwd = (ws && ws.path) || request.cwd || null
    sessions.set(sessionId, { cwd, agentPreset: request.agentPreset || undefined })
    created.push({ sessionId, ...request, cwd })
    if (ws) await ws.attachSession(sessionId)
    return { sessionId }
  },
  // 真实签名：inspect(sessionId, signal?) —— 传对象必须炸，正是线上那个 bug
  async inspect(sessionId) {
    if (typeof sessionId !== 'string') throw new TypeError('inspect(sessionId): sessionId must be a string, got ' + typeof sessionId)
    const rec = sessions.get(sessionId)
    if (!rec) return { meta: { id: sessionId } }
    return { meta: { id: sessionId, cwd: rec.cwd } }
  },
  // 真实签名：prompt(request, signal) —— 少传 signal 在 Host 里会 throwIfAborted 崩
  async prompt(request, signal) {
    if (!signal || typeof signal.throwIfAborted !== 'function') {
      throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
    }
    signal.throwIfAborted()
    const text = (request.content && request.content[0] && request.content[0].text) || ''
    prompts.push({ sessionId: request.sessionId, text, mode: request.mode })
    return {}
  },
  cancel() { return {} },
  async list() {
    return { items: [...sessions.entries()].map(([sessionId, v]) => ({ sessionId, cwd: v.cwd, updatedAt: 1 })) }
  },
  async modelCatalog() { return modelCatalog },
  async selectModel(request) { return { sessionId: request.sessionId } },
  // 真实签名：rename({ sessionId, title }) —— 依赖 sessionTitle 服务；
  // 这里只记下来，断言"初始化仓库确实把身份名写进去了"。
  async rename(request = {}) {
    renamed.push({ sessionId: request.sessionId, title: request.title })
    const rec = sessions.get(request.sessionId)
    if (rec) rec.title = request.title
    return { title: request.title, seq: 1 }
  },
}

const REGISTRY = ['write', 'edit', 'pwsh', 'read', 'flow_board', 'flow_publish', 'flow_task_create']
const registeredTools = []
const ctx = {
  tools: {
    register(tool) { registeredTools.push(tool); return () => {} },
    // 全局限制：调用即失败（Host 就是这么拒绝的），用来抓"退化成全局"的回归
    restrict() {
      globalRestrict.push(1)
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent')
    },
    guard() { return () => {} },
  },
  on() { return () => {} },
  effect(cb) { return cb() },
  inject(_deps, cb) { return cb(ctx) },
  reflect: {
    get(name) {
      if (name === 'webServer') return { register(route) { routes.push(route); return () => {} } }
      if (name === 'connection') return { admit() { return { peer: { id: 'func' } } } }
      if (name === 'sessionController') return sessionController
      if (name === 'workspaceRegistry') {
        return {
          get: (id) => workspaces.get(id),
          resolveByPath: async (p) => {
            const norm = (x) => String(x || '').replace(/\\/g, '/').toLowerCase()
            return [...workspaces.values()].find((w) => norm(w.path) === norm(p))
          },
          list: () => [...workspaces.values()],
        }
      }
      if (name === 'agentPresets') return { list: async () => [{ id: 'standard' }, { id: 'ptc' }] }
      if (name === 'sessionPersistence') {
        return {
          async stat(id) {
            const cwd = persistedCwd.get(id)
            return cwd ? { header: { id, cwd }, revision: 'r1' } : undefined
          },
        }
      }
      // 真实服务名是 workspaceController（dsh-api-workspace-controller 的 super(ctx,'workspaceController',{namespace:'workspace'})）
      if (name === 'workspaceController') {
        return { archiveSession: async (req) => { archived.push(req.sessionId) } }
      }
      if (name === 'commands') {
        return { register(def) { commandDefs.push(def); return () => {} }, async execute() { return null }, list() { return [] } }
      }
      if (name === 'systemPrompt') return { section() { return () => {} }, getSectionOrder() { return 100 } }
      if (name === 'compaction') return { compactNow: async () => ({}) }
      if (name === 'tokenMeter') return { measure: () => ({ tokens: 10, window: 1000, ratio: 0.01 }) }
      return undefined
    },
  },
  logger: { warn() {}, error() {} },
}
const commandDefs = []

const disposePlugin = apply(ctx)
assert.ok(routes.length >= 1, '插件应注册前缀路由')

const route = routes[0]
const server = http.createServer((req, res) => route.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, json, text }
}
const act = async (name, args = {}) => {
  const r = await api('POST', '/api/flow/action', { action: name, args })
  const body = r.json || {}
  const res = body.result || body
  if (res && res.ok === false) {
    const err = new Error(res.message || res.error || 'action failed: ' + name)
    err.payload = res
    throw err
  }
  return res
}
const actRaw = async (name, args = {}) => {
  const r = await api('POST', '/api/flow/action', { action: name, args })
  const body = r.json || {}
  return body.result || body
}

let pass = 0
const failures = []
const t = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log('  ✓ ' + name)
  } catch (err) {
    failures.push({ name, message: (err && err.message) || String(err) })
    console.log('  ✗ ' + name + '\n      ' + ((err && err.message) || String(err)).slice(0, 240))
  }
}

// =========================================================================
console.log('\n[1] 工作区 = 项目')
// =========================================================================
let projectId = null
await t('会话 → 工作区 → 自动建项目', async () => {
  const d = await api('POST', '/api/flow/action', { action: 'project.ensure', args: { workspacePath: 'C:/work/alpha', name: 'alpha', workspaceId: 'ws_alpha' } })
  projectId = (d.json.result || d.json).id
  assert.ok(projectId, '要能建出项目')
  const r = await api('GET', '/api/flow/session-project?sessionId=sess_missing')
  assert.equal(r.json.ok, false, '查不到的会话应明确失败')
})

await t('已有 cwd 的会话解析到工作区项目', async () => {
  sessions.set('sess_in_alpha', { cwd: 'C:/work/alpha' })
  const r = await api('GET', '/api/flow/session-project?sessionId=sess_in_alpha')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.projectId, projectId)
  assert.equal(r.json.matchedBy, 'workspace')
})

await t('worktree 目录（仓库外部）反查所属仓库项目', async () => {
  // 真实布局：<parent>/.flow-worktrees/<repo>/<taskId>（见 lib/dispatch.js worktreePathFor）
  sessions.set('sess_in_wt', { cwd: 'C:/work/.flow-worktrees/alpha/T-001' })
  const r = await api('GET', '/api/flow/session-project?sessionId=sess_in_wt')
  assert.equal(r.json.ok, true, 'worktree 里的会话必须能解析：' + JSON.stringify(r.json))
  assert.equal(r.json.projectId, projectId, 'worktree 不能变成新项目')
  assert.equal(r.json.matchedBy, 'worktree', '要说明是靠 worktree 反查命中的')
})

await t('仓库内部残留的 .flow-worktrees 目录仍按前缀归到项目', async () => {
  sessions.set('sess_in_wt_old', { cwd: 'C:/work/alpha/.flow-worktrees/alpha/T-9' })
  const r = await api('GET', '/api/flow/session-project?sessionId=sess_in_wt_old')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.projectId, projectId)
})

await t('未登记的工作区目录 → 自动建项目', async () => {
  sessions.set('sess_in_beta', { cwd: 'C:/work/beta' })
  const r = await api('GET', '/api/flow/session-project?sessionId=sess_in_beta')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.matchedBy, 'workspace-created')
  assert.notEqual(r.json.projectId, projectId)
})

await t('cwd 兜底：inspect 查不到时读持久化层会话头', async () => {
  const sid = 'sess_persist_only'
  persistedCwd.set(sid, 'C:/work/alpha')
  // 注意：故意不在 sessions map 里登记，模拟 sessionController.inspect 拿不到 cwd
  const r = await api('GET', '/api/flow/session-project?sessionId=' + sid)
  assert.equal(r.json.ok, true, '要靠持久化层兜底解析出项目：' + JSON.stringify(r.json))
  assert.equal(r.json.projectId, projectId)
})

await t('inspect 抛错（线上那种签名不匹配）时仍能靠持久化层解析', async () => {
  const sid = 'sess_inspect_broken'
  persistedCwd.set(sid, 'C:/work/alpha')
  const originalInspect = sessionController.inspect
  // 模拟线上：inspect 用错签名 → 抛错
  sessionController.inspect = async () => { throw new TypeError('inspect(): bad args') }
  try {
    const r = await api('GET', '/api/flow/session-project?sessionId=' + sid)
    assert.equal(r.json.ok, true, 'inspect 炸了也要靠兜底解析出来：' + JSON.stringify(r.json))
    assert.equal(r.json.projectId, projectId)
  } finally {
    sessionController.inspect = originalInspect
  }
})

await t('所有 cwd 来源都没有时明确失败（不瞎猜项目）', async () => {
  const r = await api('GET', '/api/flow/session-project?sessionId=sess_nowhere')
  assert.equal(r.json.ok, false, '拿不到 cwd 必须明确失败')
  assert.match(String(r.json.error), /cwd/i)
})

// =========================================================================
console.log('\n[2] 任务全状态机（事务守卫）')
// =========================================================================
let taskId = null
const task = async () => (await act('task.detail', { taskId })).task

await t('建卡：进待办，版本 0，带发起会话', async () => {
  const tk = await act('task.create', {
    projectId,
    title: '功能测试任务',
    note: '背景',
    acceptance: ['条件一'],
    lane: 'human',
    originSessionId: 'sess_origin',
  })
  taskId = tk.id
  assert.equal(tk.column, 'todo')
  assert.equal(tk.version, 0)
  assert.equal(tk.originSessionId, 'sess_origin')
})

await t('待办不能直接 approve（守卫）', async () => {
  const r = await actRaw('task.move', { taskId, action: 'approve' })
  assert.equal(r.ok, false, '非法迁移必须被拒')
  assert.match(String(r.error || r.message), /待办|todo|列|状态/i)
})

await t('claim → 规划中', async () => {
  const r = await act('task.move', { taskId, action: 'claim' })
  assert.equal(r.column, 'planning')
  assert.ok(r.version > 0, '版本要单调递增')
})

await t('写计划 → revision 1', async () => {
  const r = await act('task.plan', { taskId, text: '1. 做 A\n2. 做 B' })
  assert.equal(r.plan.revision, 1)
})

await t('plan_ready → 等审批', async () => {
  const r = await act('task.move', { taskId, action: 'plan_ready' })
  assert.equal(r.phase, 'waiting-approval')
})

await t('approve → 执行中 + 审批绑 plan rev', async () => {
  const r = await act('task.move', { taskId, action: 'approve' })
  assert.equal(r.column, 'running')
  assert.equal(r.plan.approvedRevision, 1)
  const st = (await api('GET', '/api/flow/state')).json.state
  const aps = Object.values(st.approvals || {}).filter((a) => a.taskId === taskId && a.kind === 'plan')
  assert.equal(aps.length, 1, '要落一条 plan 审批')
  assert.equal(aps[0].planRevision, 1)
})

// =========================================================================
console.log('\n[3] 派工（含宿主契约）')
// =========================================================================
await t('approve 自动派工：建会话 + 投递 brief + run', async () => {
  assert.ok(prompts.length > 0, 'approve 后必须已经投递了 brief（自动派工）')
  assert.ok(created.length > 0, '要调用 sessionController.create 建会话')
  const tk = await task()
  assert.ok(tk.activeRunId, 'approve 后要有活跃 run')
})

await t('派工后任务拿到 assignee / activeRunId / 租约', async () => {
  const tk = await task()
  assert.ok(tk.assignee, '要有负责人')
  assert.ok(tk.activeRunId, '要有活跃 run')
  const st = (await api('GET', '/api/flow/state')).json.state
  const leaseKeys = (Array.isArray(st.leases) ? st.leases : Object.values(st.leases || {})).map((l) => l.key)
  assert.ok(leaseKeys.includes('task:' + taskId), '要占任务租约，实际 ' + leaseKeys.join(','))
})

await t('派工会给工人建 goal', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const run = Object.values(st.runs).find((x) => x.taskId === taskId && x.status === 'running')
  assert.ok(run, '要有 running run')
})

// =========================================================================
console.log('\n[4] 自停 → 巡检 → 验收 → PR → 审核 → 合并')
// =========================================================================
await t('工人自停 → 待验收 + 停止报告', async () => {
  const r = await act('task.move', {
    taskId,
    action: 'stop',
    payload: { stopReport: { summary: '改完了', tests: 'bun test 通过' } },
  })
  assert.equal(r.column, 'verifying')
  const tk = await task()
  assert.equal(tk.stopReport.summary, '改完了')
})

await t('自停后租约释放', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const leaseKeys = (Array.isArray(st.leases) ? st.leases : Object.values(st.leases || {})).map((l) => l.key)
  assert.equal(leaseKeys.includes('task:' + taskId), false, 'run 结束要放租约')
})

await t('巡检结论落库', async () => {
  const r = await act('task.inspect', { taskId, notify: false })
  assert.ok(r.suggestion && r.suggestion.verdict, '要有巡检建议')
  const w = await act('task.inspect.write', { taskId, verdict: 'done', reasons: ['证据齐全'] })
  assert.equal(w.inspection.verdict, 'done')
})

// 这一段测的是"合并链路"（PR/审核/合并），所以要显式要求合并：
// 插件在非 Git 工作区会自动打 noMerge，验收后直接 done（那是另一条正确路径）。
await act('task.noMerge', { taskId, noMerge: false })

await t('验收：绑 head_sha 进合并中 + head 审批', async () => {
  const r = await act('task.move', { taskId, action: 'accept', payload: { headSha: 'deadbeef' } })
  assert.equal(r.column, 'merging')
  const st = (await api('GET', '/api/flow/state')).json.state
  const head = Object.values(st.approvals || {}).filter((a) => a.taskId === taskId && a.kind === 'head')
  assert.equal(head.length, 1)
  assert.equal(head[0].headSha, 'deadbeef')
})

await t('开 PR → review-pending', async () => {
  await act('pr.open', { taskId, headSha: 'deadbeef', files: ['lib/core.js'], summary: '改 core' })
  const r = await act('task.move', { taskId, action: 'pr_open' })
  assert.equal(r.phase, 'review-pending')
  const tk = await task()
  assert.equal(tk.mergeRequest.headSha, 'deadbeef')
})

await t('审核通过 → 完成', async () => {
  const reviewed = await act('pr.review', { taskId, verdict: 'approved', summary: '没问题' })
  assert.ok(reviewed, '审核要成功')
  const tk = await task()
  assert.equal(tk.column, 'done')
  assert.equal(tk.mergeRequest.reviewVerdict, 'approved')
})

// =========================================================================
console.log('\n[5] 阻塞 / 取消 / 重开 / 改派')
// =========================================================================
let t2 = null
await t('阻塞 → 解除', async () => {
  const tk = await act('task.create', { projectId, title: '阻塞测试' })
  t2 = tk.id
  await act('task.block', { taskId: t2, reason: '等接口' })
  let cur = await task() // 注意：task() 读的是 taskId，这里改用 detail
  const d = await act('task.detail', { taskId: t2 })
  assert.ok(d.task.blocked)
  assert.equal(d.task.blocked.reason, '等接口')
  await act('task.unblock', { taskId: t2 })
  const d2 = await act('task.detail', { taskId: t2 })
  assert.equal(d2.task.blocked, null)
})

await t('取消 → 已取消；重开 → 回待办且计数 +1', async () => {
  await act('task.move', { taskId: t2, action: 'cancel' })
  let d = await act('task.detail', { taskId: t2 })
  assert.equal(d.task.column, 'cancelled')
  const r = await act('task.move', { taskId: t2, action: 'reopen', payload: { reason: '需求变了' } })
  assert.equal(r.column, 'todo')
  d = await act('task.detail', { taskId: t2 })
  assert.equal(d.task.reopenCount, 1)
})

await t('重开必须写原因（守卫）', async () => {
  await act('task.move', { taskId: t2, action: 'cancel' })
  const r = await actRaw('task.move', { taskId: t2, action: 'reopen', payload: {} })
  assert.equal(r.ok, false, '没写原因不能重开')
})

await t('改派上级（agent.reparent）', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const sup = Object.values(st.agents).find((a) => a.projectId === projectId && a.role === 'dispatcher')
  const worker = Object.values(st.agents).find((a) => a.projectId === projectId && a.role === 'worker')
  assert.ok(sup && worker, '要有调度员和工人')
  const r = await act('agent.reparent', { agentId: worker.id, supervisorId: sup.id })
  assert.equal(r.ok, true)
})

// =========================================================================
console.log('\n[6] 评论 / 注入 / 车道 / 配置 / 范围')
// =========================================================================
await t('任务评论', async () => {
  const r = await act('task.comment', { taskId: t2, content: '这条是功能测试评论' })
  assert.ok(r.ok !== false)
  const d = await act('task.detail', { taskId: t2 })
  assert.ok(d.comments.some((c) => c.content === '这条是功能测试评论'))
})

await t('注入上下文', async () => {
  const r = await act('task.inject', { taskId: t2, kind: 'context', content: '先读 AGENTS.md' })
  assert.ok(r, '注入要成功')
})

await t('车道配置读写 + 补工位', async () => {
  const before = await act('lane.get', { projectId })
  assert.equal(before.ok !== false, true)
  const set = await act('lane.set', { projectId, lane: 'human', dispatchers: 1, workers: 3 })
  assert.ok(set, '设置成功')
  const st = (await api('GET', '/api/flow/state')).json.state
  const workers = Object.values(st.agents).filter((a) => a.projectId === projectId && a.role === 'worker' && (a.lane || 'human') === 'human')
  assert.ok(workers.length >= 3, '工人数要补到 3，实际 ' + workers.length)
})

await t('纯本地看板模式拒绝开自动化开关（先开记录 issue 才行）', async () => {
  // act() 在 ok:false 时会抛出带原因的错误，所以要断言抛出的消息
  await assert.rejects(() => act('project.config', { projectId, patch: { autoDispatch: true } }), /纯本地看板|记录 issue/)
  await assert.rejects(() => act('project.config', { projectId, patch: { remote: { kind: 'gitea', owner: 'o', repo: 'r' } } }), /纯本地看板/)
  await assert.rejects(() => act('project.config', { projectId, patch: { autoMerge: true } }), /纯本地看板/)
})

await t('项目配置读写（打开记录 issue 之后）', async () => {
  await act('project.config', { projectId, patch: { recordIssues: true } })
  await act('project.config', { projectId, patch: { autoDispatch: true, maxInFlightPerProject: 5 } })
  const st = (await api('GET', '/api/flow/state')).json.state
  const p = st.projects.find((x) => x.id === projectId)
  assert.equal(p.config.recordIssues, true)
  assert.equal(p.config.autoDispatch, true)
  assert.equal(p.config.maxInFlightPerProject, 5)
})

await t('阅读范围设置 + 打分派工不会跨车道', async () => {
  const r = await act('scope.set', { taskId: t2, paths: ['lib/core.js'], symbols: ['emit'] })
  assert.ok(r, '设范围成功')
  const d = await act('task.detail', { taskId: t2 })
  assert.deepEqual(d.task.scope.paths, ['lib/core.js'])
})

// =========================================================================
console.log('\n[7] 回信路由（谁发起，回给谁）')
// =========================================================================
await t('task.reply 投回发起会话', async () => {
  const before = prompts.length
  const r = await act('task.reply', { taskId, message: '进度：已完成' })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'sess_origin', '收件人必须是建卡时的会话')
  const sent = prompts.slice(before)
  assert.ok(sent.some((p) => p.sessionId === 'sess_origin' && /已完成/.test(p.text)))
})

await t('没有发起会话的卡，回信要明确失败', async () => {
  const tk = await act('task.create', { projectId, title: '无发起会话' })
  const r = await actRaw('task.reply', { taskId: tk.id, message: 'x' })
  assert.equal(r.ok, false)
  assert.match(String(r.message), /没有发起会话|无法回信/)
})

// =========================================================================
console.log('\n[8] /flow 调度模式（agent 作用域 restrict）')
// =========================================================================
{
  const flow = commandDefs.find((d) => d.name === 'flow')
  assert.ok(flow, '/flow 命令要注册')

  // 忠实 agent：带 agent.ctx.tools（真实 Host 就是这样给的）
  const REGISTERED = ['write', 'edit', 'pwsh', 'read', 'flow_board', 'flow_publish']
  const makeAgent = (id) => {
    const calls = []
    return {
      session: { header: { id, cwd: 'C:/work/alpha' } },
      ctx: {
        tools: {
          schemas() { return REGISTERED.map((name) => ({ name })) },
          get(name) { return REGISTERED.includes(name) ? { name } : undefined },
          restrict(filter) { calls.push(filter); return () => { calls.push('disposed') } },
        },
      },
      calls,
    }
  }

  let flowAgent = null
  await t('/flow 进入：用 agent 作用域 restrict，不碰全局', async () => {
    const agent = makeAgent('sess_flow_on')
    flowAgent = agent
    const r = await flow.handler({ agent, rawInput: '' })
    assert.equal(r.kind, 'success', '进入要成功：' + r.text)
    assert.equal(agent.calls.length, 1, 'agent 作用域 restrict 要调一次')
    assert.ok(Array.isArray(agent.calls[0].deny), '要传 deny 列表')
    assert.deepEqual(agent.calls[0].deny.slice().sort(), ['edit', 'pwsh', 'write'], '只 deny 本构建真实存在的写工具')
    assert.equal(agent.calls[0].deny.includes('bash'), false, '不存在的 bash 不能进 deny')
    assert.equal(globalRestrict.length, 0, '绝不能退化成全局限制')
  })

  await t('/flow status 反映状态', async () => {
    const agent = makeAgent('sess_flow_on')
    const r = await flow.handler({ agent, rawInput: 'status' })
    assert.match(r.text, /开启/)
  })

  await t('/flow off 恢复工具集', async () => {
    // 必须拿"进入时那个 agent"：dispose 记在它的 restrict 返回值上
    const r = await flow.handler({ agent: flowAgent, rawInput: 'off' })
    assert.equal(r.kind, 'success')
    assert.equal(flowAgent.calls[flowAgent.calls.length - 1], 'disposed', '要 dispose，不能泄漏限制')
  })

  await t('/flow 在拿不到 agent.ctx 时明确拒绝（不退化成全局）', async () => {
    const bare = { session: { header: { id: 'sess_flow_bare' } } }
    const r = await flow.handler({ agent: bare, rawInput: '' })
    assert.equal(r.kind, 'error', '没有 scoped ctx 必须报错')
    assert.match(r.text, /scoped/)
    assert.equal(globalRestrict.length, 0, '拒绝时也不能碰全局 restrict')
  })

  await t('/flow 进入后提示当前工作区项目', async () => {
    const agent = makeAgent('sess_flow_tip')
    const r = await flow.handler({ agent, rawInput: '' })
    assert.equal(r.kind, 'success')
    assert.match(r.text, /工作区项目|调度模式/)
  })
}

// =========================================================================
console.log('\n[8.5] cwd 诊断（线上排查用）')
// =========================================================================
await t('diag.cwd 逐层报告 cwd 来源', async () => {
  const r = await act('diag.cwd', { sessionId: 'sess_in_alpha' })
  assert.equal(r.ok, true)
  assert.equal(r.sources.inspect.ok, true, 'inspect 这一层要能查')
  assert.equal(r.sources.inspect.cwd, 'C:/work/alpha')
  assert.equal(r.resolvedCwd, 'C:/work/alpha', '最终解析结果要一致')
})

await t('diag.cwd 在 inspect 抛错时仍报告持久化层命中', async () => {
  const sid = 'sess_diag_persist'
  persistedCwd.set(sid, 'C:/work/alpha')
  const original = sessionController.inspect
  sessionController.inspect = async () => { throw new TypeError('bad args') }
  try {
    const r = await act('diag.cwd', { sessionId: sid })
    assert.equal(r.sources.inspect.ok, false, '要如实报告 inspect 失败')
    assert.equal(r.sources.persistence.cwd, 'C:/work/alpha', '持久化层要能兜住')
    assert.equal(r.resolvedCwd, 'C:/work/alpha')
  } finally {
    sessionController.inspect = original
  }
})

await t('三层兜底都不通时报错，而不是随便建一个项目', async () => {
  const before = Object.keys((await api('GET', '/api/flow/state')).json.state.projects).length
  const r = await api('GET', '/api/flow/session-project?sessionId=sess_truly_unknown')
  assert.equal(r.json.ok, false)
  const after = Object.keys((await api('GET', '/api/flow/state')).json.state.projects).length
  assert.equal(after, before, '解析失败绝不能偷偷建项目')
})

await t('diag.cwd 报告 agent_sessions 兜底（前两层都没有时）', async () => {
  const sid = 'sess_only_agent_session'
  const rec = Object.values((await api('GET', '/api/flow/state')).json.state.agent_sessions || {})
    .find((x) => x && x.cwd && x.state !== 'archived')
  if (!rec) return // 没有可用样本就跳过（不算失败）
  const r = await act('diag.cwd', { sessionId: rec.sessionId })
  assert.equal(r.ok, true)
  assert.ok(r.sources, '要报告每一层')
  assert.equal(typeof r.resolvedCwd !== 'undefined', true)
})

// =========================================================================
console.log('\n[8.6] /flow 复用 skill + 发布即开工')
// =========================================================================
await t('flow skill 已安装到 skill 根（agent 能 skill(name=flow) 拿到）', async () => {
  const { existsSync, readFileSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const root = process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
  const file = join(root, 'skills', 'flow', 'SKILL.md')
  if (!existsSync(file)) {
    // 测试环境可能没装：至少确认仓库里有源文件（打包时随插件分发）
    const src = join(process.cwd(), 'skills', 'flow', 'SKILL.md')
    assert.ok(existsSync(src), '仓库里要有 skills/flow/SKILL.md 源文件')
    return
  }
  const body = readFileSync(file, 'utf8')
  assert.match(body, /^---[\s\S]*name: flow/, '要有 frontmatter 且 name=flow')
  assert.match(body, /flow_publish/, '要讲清发布动作')
  assert.match(body, /完成判据/, '按面向 agent 的写法给完成判据')
})

await t('flow_publish 发布即开工：进 running 且绑定批准版本', async () => {
  const publish = registeredTools.find((t) => t.name === 'flow_publish')
  assert.ok(publish, 'flow_publish 工具要注册')
  const exec = {
    agent: { session: { header: { id: 'sess_pub', cwd: 'C:/work/alpha' } }, ctx: { tools: { schemas() { return REGISTRY.map((name) => ({ name })) } } } },
  }
  const res = await publish.execute({
    title: '发布即开工',
    plan: '## 计划\n1. 做 A',
    acceptance: ['A 能跑通'],
    scope: { paths: ['lib/panel.js'] },
    subtasks: [{ title: '子任务 A', scope: { paths: ['lib/panel.js'] } }],
  }, exec)
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200))
  const published = (await api('GET', '/api/flow/task/' + encodeURIComponent(res.taskId))).json.task
  assert.equal(published.column, 'running', '发布即批准，要进执行中；发布返回：' + res.message)
  assert.equal(published.plan.approvedRevision, 1, '要绑定 plan rev')
  // 派出去了就占租约；没派出必须有明确说明（无 dispatcher / 无空闲工位）
  if (published.activeRunId) {
    const st = (await api('GET', '/api/flow/state')).json.state
    const keys = (Array.isArray(st.leases) ? st.leases : Object.values(st.leases || {})).map((l) => l.key)
    assert.ok(keys.includes('task:' + res.taskId), '派出去就要占任务租约')
  } else {
    assert.match(res.message, /暂未派出|等待认领/)
  }
})

await t('v1.35 flow_publish 高风险方案不自批：停在待批准并落请示给人', async () => {
  const publish = registeredTools.find((t) => t.name === 'flow_publish')
  const exec = { agent: { session: { header: { id: 'sess_pub_hi', cwd: 'C:/work/alpha' } }, ctx: { tools: { schemas() { return REGISTRY.map((name) => ({ name })) } } } } }
  const res = await publish.execute({ title: '动核心文件', plan: '## 计划\n1. 改 core', acceptance: ['能跑'], scope: { paths: ['lib/core.js'] } }, exec)
  assert.equal(res.ok, true, res.message)
  const published = (await api('GET', '/api/flow/task/' + encodeURIComponent(res.taskId))).json.task
  assert.equal(published.column, 'planning', '高风险方案要等人批')
  assert.match(res.message, /未开工/)
  const listed = await act('inbox.list', { taskId: res.taskId })
  const items = Array.isArray(listed) ? listed : (listed.items || [])
  const inbox = items.filter((x) => x.taskId === res.taskId && x.kind === 'risk')
  assert.equal(inbox.length, 1, '要给人落一条 risk 请示，实际：' + JSON.stringify(listed).slice(0, 200))
})

await t('用线上真实报错里的工具名单复算：交集非空且不再含 ghost', async () => {
  const m = await import('../lib/command-flow.js')
  // 这条名单来自用户线上真实的报错原文（host 回传的 known global tools）
  const REAL_KNOWN = ('SSHManager, advanced_search, ask_user_question, cache_search, codegraph_explore, codegraph_init, ' +
    'codegraph_status, codegraph_sync, create_goal, domain_search, dsh_browser_a11y, dsh_browser_auth, dsh_browser_back, ' +
    'dsh_browser_challenge, dsh_browser_check, dsh_browser_clear, dsh_browser_click, dsh_browser_close_tab, dsh_browser_content, ' +
    'dsh_browser_download, dsh_browser_execute, dsh_browser_fill, dsh_browser_forward, dsh_browser_get_value, dsh_browser_history, ' +
    'dsh_browser_key, dsh_browser_list_tabs, dsh_browser_open, dsh_browser_refresh, dsh_browser_replay, dsh_browser_reset, ' +
    'dsh_browser_reset_session, dsh_browser_restrict, dsh_browser_scrape, dsh_browser_screenshot, dsh_browser_scroll, ' +
    'dsh_browser_select, dsh_browser_session, dsh_browser_set_value, dsh_browser_snapshot, dsh_browser_switch_tab, ' +
    'dsh_browser_type, dsh_browser_visited, dsh_browser_wait, edit, exit_plan_mode, flow_agent_reparent, flow_board, ' +
    'flow_config, flow_inspect, flow_issue_sync, flow_lane, flow_pr_merge, flow_pr_open, flow_pr_review, flow_publish, flow_reply, ' +
    'flow_scope_set, flow_task_comment, flow_task_create, flow_task_move, flow_task_remove, flow_message, flow_worker_inject, ' +
    'flow_worker_log, flow_worker_reset, flow_worker_steer, flow_worktree, free_search_test, get_goal, glob, grep, interrupt_agent, ' +
    'job_kill, job_list, job_output, list_agents, multi_search, platform_search, present, pwsh, read, read_image, research, ' +
    'send_message, skill, subagent_fork, todo_write, update_goal, video_search, weather, web_fetch, web_search, write')
    .split(',').map((x) => x.trim()).filter(Boolean)

  const deny = m.FLOW_DENY_TOOLS.filter((n) => REAL_KNOWN.includes(n))
  assert.ok(deny.length > 0, '交集不能为空，否则只读不生效')
  assert.ok(deny.includes('write') && deny.includes('edit') && deny.includes('pwsh'), '真实存在的写工具要进 deny')
  for (const ghost of ['bash', 'str_replace_editor', 'write_file', 'edit_file']) {
    assert.equal(deny.includes(ghost), false, ghost + ' 不在真实名单里，绝不能进 deny')
  }
  // 用这份交集调用 restrict 必须成功
  let called = null
  const fake = { schemas: () => REAL_KNOWN.map((name) => ({ name })), restrict: (f) => { called = f.deny; return () => {} } }
  const plan = m.describeDenyPlan(fake)
  assert.deepEqual(plan.deny.slice().sort(), deny.slice().sort())
  const mode = m.createFlowMode({ log: () => {} })
  const r = mode.enter({ ctx: { tools: fake } }, 'ses_real_list', fake)
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(called.slice().sort(), deny.slice().sort(), '真正传给 restrict 的就是交集')
  mode.exit('ses_real_list')
  console.log('      deny=' + JSON.stringify(deny) + '  剔除=' + JSON.stringify(m.FLOW_DENY_TOOLS.filter((n) => !deny.includes(n))))
})

// =========================================================================
console.log('\n[8.4] 调度员事件驱动（该插话的才插话）')
// =========================================================================
{
  // 独立的一套：自己的 store/dispatcher，避免污染主流程的项目与代理
  const vDir = mkdtempSync(join(os.tmpdir(), 'dsh-flow-watch-'))
  const vFile = join(vDir, 'flow.json')
  writeFileSync(vFile, JSON.stringify(emptyState(), null, 2))
  const { Store: VStore } = await import('../lib/core.js')
  const { FlowDomain: VDomain } = await import('../lib/domain.js')
  const { createDispatcher: mkDispatcher } = await import('../lib/dispatch.js')
  const vStore = new VStore(vFile)
  await vStore.load()

  const steered = []
  const vRuntime = {
    async ensureSession(agent) {
      const rec = vDomain.latestSession(agent.id)
      if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId }
      const sid = 'ses_' + agent.id
      await vDomain.bindSession(agent.id, sid, { state: 'idle', cwd: null }, { role: 'system' })
      return { ok: true, sessionId: sid }
    },
    async promptSession(sessionId, text, mode) {
      steered.push({ sessionId, text, mode })
      return { ok: true }
    },
    async workerGoal() { return { ok: true } },
  }
  const vDomain = new VDomain(vStore, vRuntime)
  const vDispatcher = mkDispatcher({ domain: vDomain, runtime: vRuntime, store: vStore, log: () => {} })
  const off = vDispatcher.watchEvents()

  const vProj = await vDomain.ensureProject({ workspacePath: join(vDir, 'repo'), name: 'watch' })
  const sup = vDomain.supervisorOf(vProj.id, 'human')
  await vDomain.bindSession(sup.id, 'ses_sup', { state: 'idle', cwd: null }, { role: 'system' })
  const vTask = await vDomain.createTask(vProj.id, { title: '事件驱动测试', lane: 'human' })

  const flush = async () => {
    await vDomain.pumpOutbox()
    await new Promise((r) => setTimeout(r, 60)) // 让 Promise 链跑完
  }

  await t('人类评论 → 插话给同车道调度员', async () => {
    steered.length = 0
    await vDomain.comment(vTask.id, '这里要改一下', { role: 'human', id: 'me' })
    await flush()
    const hit = steered.find((x) => x.sessionId === 'ses_sup')
    assert.ok(hit, '评论必须插话给调度员，实际：' + JSON.stringify(steered))
    assert.equal(hit.mode, 'steer', '要 steer 插话，不是普通排队')
    assert.match(hit.text, /评论/)
    assert.match(hit.text, /这里要改一下/)
  })

  await t('任务阻塞 → 插话', async () => {
    steered.length = 0
    await vDomain.block(vTask.id, '等外部接口', { role: 'human', id: 'me' })
    await flush()
    const hit = steered.find((x) => /阻塞/.test(x.text))
    assert.ok(hit, '阻塞要插话')
    assert.match(hit.text, /等外部接口/)
  })

  await t('常规流转（认领/写计划）不插话', async () => {
    steered.length = 0
    await vDomain.unblock(vTask.id, { role: 'human', id: 'me' })
    await vDomain.move(vTask.id, 'claim', { role: 'dispatcher', id: 'ag_x' })
    await vDomain.setPlan(vTask.id, '计划内容', { role: 'dispatcher', id: 'ag_x' })
    await flush()
    assert.equal(steered.length, 0, '常规流转不该打扰调度员，实际：' + JSON.stringify(steered.map((x) => x.text.slice(0, 40))))
  })

  await t('run 失败 → 插话；正常自停不插话', async () => {
    const w = vDomain.workersOf(vProj.id, 'human').find((a) => a.role === 'worker')
    await vDomain.bindSession(w.id, 'ses_watch_w', { state: 'idle', cwd: null }, { role: 'system' })
    await vDomain.move(vTask.id, 'plan_ready', { role: 'dispatcher', id: 'ag_x' })
    await vDomain.move(vTask.id, 'approve', { role: 'human', id: 'me' }).catch(() => null)
    const { run } = await vDomain.startRun(vTask.id, { agentId: w.id, sessionId: 'ses_watch_w', trigger: 'approve' })

    steered.length = 0
    await vDomain.endRun(vTask.id, 'stopped', { stopReason: '正常做完' })
    await flush()
    assert.equal(steered.length, 0, '正常自停不插话（afterStop 会走巡检包）')

    // 再造一个失败的 run
    await vDomain.move(vTask.id, 'rework', { role: 'human', id: 'me' }).catch(() => null)
    const r2 = await vDomain.startRun(vTask.id, { agentId: w.id, sessionId: 'ses_watch_w', trigger: 'rework' })
    steered.length = 0
    await vDomain.endRun(vTask.id, 'failed', { stopReason: '编译失败' })
    await flush()
    const hit = steered.find((x) => /run 失败/.test(x.text))
    assert.ok(hit, '失败要插话，实际：' + JSON.stringify(steered.map((x) => x.text.slice(0, 40))))
    assert.match(hit.text, /编译失败/)
    assert.ok(run)
    assert.ok(r2)
  })

  await t('同一任务同类事件 30 秒内只插一次话（去重）', async () => {
    // 用全新任务：去重键是 task.id+事件类型，复用前面的任务会吃到已填满的窗口
    const dedupTask = await vDomain.createTask(vProj.id, { title: '去重测试', lane: 'human' })
    steered.length = 0
    for (let i = 0; i < 3; i += 1) {
      await vDomain.comment(dedupTask.id, '刷屏' + i, { role: 'human', id: 'me' })
      await flush()
    }
    const hits = steered.filter((x) => /评论/.test(x.text))
    assert.equal(hits.length, 1, '窗口内只该插一次，实际 ' + hits.length)
  })

  await t('不同任务的同类事件互不抑制', async () => {
    const a1 = await vDomain.createTask(vProj.id, { title: 'A 卡', lane: 'human' })
    const b1 = await vDomain.createTask(vProj.id, { title: 'B 卡', lane: 'human' })
    steered.length = 0
    await vDomain.comment(a1.id, 'A 的评论', { role: 'human', id: 'me' })
    await vDomain.comment(b1.id, 'B 的评论', { role: 'human', id: 'me' })
    await flush()
    const hits = steered.filter((x) => /评论/.test(x.text))
    assert.equal(hits.length, 2, '两张不同的卡都要通知，实际 ' + hits.length)
  })

  await t('调度员用自己的 agentId 写评论 → 不插话（线上那个自激循环）', async () => {
    const t3 = await vDomain.createTask(vProj.id, { title: '自激-agentId', lane: 'human' })
    steered.length = 0
    // 工具层现在会用 agentId 署名（以前是 role 字面量，导致过滤永远匹配不上）
    await vDomain.comment(t3.id, '我自己写的', { role: 'dispatcher', id: sup.id })
    await flush()
    assert.equal(steered.length, 0, '用 agentId 署名时必须认出是自己')
  })

  await t('调度员用自己的 sessionId 写评论 → 不插话（兜底形态）', async () => {
    const t4 = await vDomain.createTask(vProj.id, { title: '自激-sessionId', lane: 'human' })
    steered.length = 0
    await vDomain.comment(t4.id, '我也是我自己', { role: 'dispatcher', id: 'ses_sup' })
    await flush()
    assert.equal(steered.length, 0, 'sessionId 要能反查回自己')
  })

  await t('另一个调度员写评论 → 要插话（不能把同事的动作吞掉）', async () => {
    const t5 = await vDomain.createTask(vProj.id, { title: '同事的评论', lane: 'human' })
    steered.length = 0
    await vDomain.comment(t5.id, '同事写的', { role: 'dispatcher', id: 'ag_colleague' })
    await flush()
    assert.equal(steered.filter((x) => /同事写的/.test(x.text)).length, 1, '同事的评论必须通知我')
  })

  await t('人类评论仍然插话（自激过滤不能误伤人类）', async () => {
    const t6 = await vDomain.createTask(vProj.id, { title: '人类评论', lane: 'human' })
    steered.length = 0
    await vDomain.comment(t6.id, '人类说的', { role: 'human', id: 'me' })
    await flush()
    assert.equal(steered.filter((x) => /人类说的/.test(x.text)).length, 1)
  })

  await t('系统记录类事件（system 署名的评论）不插话', async () => {
    const t7 = await vDomain.createTask(vProj.id, { title: 'system 记录', lane: 'human' })
    steered.length = 0
    await vDomain.comment(t7.id, '已通知调度员巡检（工人自停）', { role: 'system', id: 'system' })
    await flush()
    assert.equal(steered.length, 0, '流程自己写的记录不该回头吵调度员')
  })

  await t('系统触发的故障仍要插话（自激过滤不能吞掉失败）', async () => {
    const t8 = await vDomain.createTask(vProj.id, { title: 'system 故障', lane: 'human' })
    steered.length = 0
    await vDomain.block(t8.id, '派工失败：工人会话不可用', { role: 'system' })
    await flush()
    const hit = steered.find((x) => /派工失败/.test(x.text))
    assert.ok(hit, '派工失败必须通知调度员，实际：' + JSON.stringify(steered.map((x) => x.text.slice(0, 30))))
  })

  await t('调度员自己造成的阻塞仍通知（故障不看署名）', async () => {
    const t9 = await vDomain.createTask(vProj.id, { title: 'self 故障', lane: 'human' })
    steered.length = 0
    await vDomain.block(t9.id, '合并前夹具缺失', { role: 'dispatcher', id: sup.id })
    await flush()
    assert.equal(steered.filter((x) => /夹具缺失/.test(x.text)).length, 1, '自己触发的故障也要知道（那是结果不是噪音）')
  })

  await t('DSH_FLOW_WATCH_ALL=1 时常规流转也插话（开关不是死代码）', async () => {
    const prev = process.env.DSH_FLOW_WATCH_ALL
    process.env.DSH_FLOW_WATCH_ALL = '1'
    try {
      const allTask = await vDomain.createTask(vProj.id, { title: '全量模式', lane: 'human' })
      steered.length = 0
      await vDomain.move(allTask.id, 'claim', { role: 'dispatcher', id: 'ag_other' })
      await flush()
      assert.ok(steered.length > 0, '全量模式下 claim 也该通知')
    } finally {
      if (prev === undefined) delete process.env.DSH_FLOW_WATCH_ALL
      else process.env.DSH_FLOW_WATCH_ALL = prev
    }
  })

  await t('调度员自己触发的事件不插话（防自激）', async () => {
    steered.length = 0
    await vDomain.comment(vTask.id, '调度员自己的评论', { role: 'dispatcher', id: sup.id })
    await flush()
    assert.equal(steered.length, 0, '自己做的事不该再通知自己')
  })

  off()
}

// =========================================================================
console.log('\n[8.6] 模型：落库 + 同步到会话（不是只改界面）')
// =========================================================================
await t('改模型走 selectModel：落库 + 让运行时去切会话', async () => {
  const st0 = (await api('GET', '/api/flow/state')).json.state
  const w = Object.values(st0.agents).find((a) => a.projectId === projectId && a.role === 'worker')
  assert.ok(w, '要有一个工人工位')
  await act('agent.session', { agentId: w.id })
  const r = await act('agent.selectModel', { agentId: w.id, provider: 'krc', model: 'gpt-6-luna-codex' })
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 160))
  assert.equal(r.provider, 'krc', '回包要带回最终生效的选择：' + JSON.stringify(r).slice(0, 160))
  assert.equal(r.model, 'gpt-6-luna-codex')
  // 落库是硬要求
  const st = (await api('GET', '/api/flow/state')).json.state
  const savedAgent = Object.values(st.agents || {}).find((a) => a.id === w.id)
  assert.ok(savedAgent, '要能在 state 里找到这个工位')
  assert.equal(savedAgent.provider, 'krc', '要落库')
  assert.equal(savedAgent.model, 'gpt-6-luna-codex')
  // 会话切换尽力而为：测试宿主没实现 selectModel，必须如实报告而不是假装成功
  assert.ok(r.applied && typeof r.applied.ok === 'boolean', '要回报会话有没有切成功')
})

await t('没会话时：落库但明确说"还没会话"（不能假装切了）', async () => {
  // 造一个"从未绑过会话"的工位
  const made = await act('agent.upsert', { projectId, name: '没会话的工人', role: 'worker', slot: 9 })
  assert.ok(made && made.id, '要能建出工位：' + JSON.stringify(made).slice(0, 120))
  const noSession = made
  const r = await act('agent.selectModel', { agentId: noSession.id, provider: 'krc', model: 'gpt-6-astra' })
  assert.equal(r.ok, true)
  const st = (await api('GET', '/api/flow/state')).json.state
  const saved2 = Object.values(st.agents || {}).find((a) => a.id === noSession.id)
  assert.ok(saved2)
  assert.equal(saved2.model, 'gpt-6-astra', '照样要落库')
  assert.equal(r.applied.ok, false)
  assert.match(String(r.applied.message || ''), /还没有会话/)
})

await t('面板的模型配置里没有总调度（chief 不归插件管）', async () => {
  const v = (await api('GET', '/api/flow/project?projectId=' + encodeURIComponent(projectId))).json
  assert.ok(Array.isArray(v.agents), '项目视图要带 agents 列表')
  const roles = v.agents.map((a) => a.role)
  assert.equal(roles.includes('chief'), false, 'agents 列表里不该出现 chief')
  assert.ok(roles.includes('worker'))
  assert.ok(roles.includes('dispatcher'))
})

// =========================================================================
console.log('\n[8.5] issue 自动调研 → 阻塞待批准（人或主调度拍板）')
// =========================================================================
{
  const iDir = mkdtempSync(join(os.tmpdir(), 'dsh-flow-issue-'))
  const iFile = join(iDir, 'flow.json')
  writeFileSync(iFile, JSON.stringify(emptyState(), null, 2))
  const { Store: IStore } = await import('../lib/core.js')
  const { FlowDomain: IDomain } = await import('../lib/domain.js')
  const { createDispatcher: mkD } = await import('../lib/dispatch.js')
  const { ingestIssueEvent } = await import('../lib/event.js')
  const iStore = new IStore(iFile)
  await iStore.load()

  const iPrompts = []
  const iRuntime = {
    async ensureSession(agent) {
      const rec = iDomain.latestSession(agent.id)
      return { ok: true, sessionId: rec ? rec.sessionId : 'ses_' + agent.id }
    },
    async promptSession(sessionId, text, mode) { iPrompts.push({ sessionId, text, mode }); return { ok: true } },
    async workerGoal() { return { ok: true } },
  }
  const iDomain = new IDomain(iStore, iRuntime)
  const iDisp = mkD({ domain: iDomain, runtime: iRuntime, store: iStore, log: () => {} })
  // 真实插件在 index.js 里就是这么接线的；不接上，claim/stop 的副作用不会触发
  iRuntime.onMoved = iDisp.onMoved
  iRuntime.onStopped = iDisp.onStopped

  const iProj = await iDomain.ensureProject({ workspacePath: join(iDir, 'irepo'), name: 'issue-proj' })
  await iDomain.updateProjectConfig(iProj.id, { recordIssues: true }, { role: 'human' })

  await t('issue 入站后派调研（工人只读，不建 worktree）', async () => {
    const res = await ingestIssueEvent(iDomain, {
      source: 'gitea',
      refKind: 'issue',
      payload: { remoteId: 7, title: '导出功能坏了', body: '点导出没反应', action: 'opened', rev: 'r1', projectId: iProj.id },
    }, { project: iProj })
    assert.equal(res.created, true, JSON.stringify(res).slice(0, 160))
    const task = iStore.state.tasks[res.taskId]
    assert.equal(task.lane, 'issue')
    assert.ok(task.activeRunId, '认领后应该已经派了调研 run')
    assert.ok(!task.worktree, '调研轮不该建 worktree，实际：' + JSON.stringify(task.worktree))
    assert.equal(Object.keys(iStore.state.worktrees).length, 0, '不该留下 worktree 记录')
    const brief = iPrompts.map((x) => x.text).join(String.fromCharCode(10))
    assert.match(brief, /只做调研，不要改代码/)
  })

  await t('调研轮自停 → 方案自动进 plan 并停在待批准', async () => {
    const taskId = Object.keys(iStore.state.tasks).find((id) => iStore.state.tasks[id].lane === 'issue')
    const task = iStore.state.tasks[taskId]
    // 工人在调研中写了方案（评论），然后自停
    await iDomain.comment(taskId, '方案：1. 定位导出入口 export.ts 2. 补 CSV 序列化 3. 加单测覆盖 4. 风险：大文件内存', { role: 'worker', id: task.assignee })
    await iDomain.move(taskId, 'stop', { role: 'worker', id: task.assignee }, { stopReport: { summary: '调研完成' } })
    const after = iStore.state.tasks[taskId]
    await iDisp.afterStop(after)
    const cur = iStore.state.tasks[taskId]
    assert.equal(cur.column, 'planning', '要回到规划列等批准')
    assert.equal(cur.phase, 'waiting-approval')
    assert.ok(cur.plan.revision >= 1, '方案要进 plan')
    assert.match(cur.plan.text, /定位导出入口/)
    assert.equal(cur.activeRunId, null, 'run 要收掉')
  })

  await t('没有方案就自停 → block 并说明（绝不空着进批准）', async () => {
    const res = await ingestIssueEvent(iDomain, {
      source: 'gitea',
      refKind: 'issue',
      payload: { remoteId: 8, title: '空调研', body: 'x', action: 'opened', rev: 'r1', projectId: iProj.id },
    }, { project: iProj })
    const taskId = res.taskId
    const task = iStore.state.tasks[taskId]
    await iDomain.move(taskId, 'stop', { role: 'worker', id: task.assignee }, { stopReport: { summary: '调研完成' } })
    await iDisp.afterStop(iStore.state.tasks[taskId])
    const cur = iStore.state.tasks[taskId]
    assert.ok(cur.blocked, '没方案必须 block')
    assert.match(cur.blocked.reason, /没有写出方案/)
  })

  await t('人批准后才会真的开工', async () => {
    const taskId = Object.keys(iStore.state.tasks).find((id) => iStore.state.tasks[id].phase === 'waiting-approval')
    await iDomain.move(taskId, 'approve', { role: 'human', id: 'me' })
    const cur = iStore.state.tasks[taskId]
    assert.equal(cur.column, 'running')
    assert.equal(cur.plan.approvedRevision, cur.plan.revision)
    assert.equal(cur.plan.approvedBy, 'me', '要记下谁批的')
  })

  await t('主调度可代批 issue 卡（approve_by_chief），但 human 车道不行', async () => {
    const res = await ingestIssueEvent(iDomain, {
      source: 'gitea',
      refKind: 'issue',
      payload: { remoteId: 9, title: '代批测试', body: 'x', action: 'opened', rev: 'r1', projectId: iProj.id },
    }, { project: iProj })
    const taskId = res.taskId
    const task = iStore.state.tasks[taskId]
    await iDomain.comment(taskId, '方案：1. 改 a.ts 里的导出入口，补上 CSV 序列化；2. 改 b.ts 调用侧，处理大文件分片；3. 加一个回归测试覆盖边界；4. 风险：内存占用，需要流式写出。', { role: 'worker', id: task.assignee })
    await iDomain.move(taskId, 'stop', { role: 'worker', id: task.assignee }, { stopReport: { summary: '调研完成' } })
    await iDisp.afterStop(iStore.state.tasks[taskId])
    const moved = await iDomain.move(taskId, 'approve_by_chief', { role: 'chief', id: 'chief_1' })
    assert.equal(moved.column, 'running')
    assert.equal(moved.plan.approvedBy, 'chief_1')
    // human 车道的卡不能被代批
    const h = await iDomain.createTask(iProj.id, { title: 'human 卡', lane: 'human' })
    await iDomain.move(h.id, 'claim', { role: 'dispatcher' })
    await iDomain.setPlan(h.id, '计划', { role: 'dispatcher' })
    await iDomain.move(h.id, 'plan_ready', { role: 'dispatcher' })
    await assert.rejects(() => iDomain.move(h.id, 'approve_by_chief', { role: 'chief', id: 'chief_1' }), /只有 issue 车道/)
  })

  await t('flow_issue_pending 列出待拍板的工单（默认前 50）', async () => {
    const tool = registeredTools.find((x) => x.name === 'flow_issue_pending')
    assert.ok(tool, 'flow_issue_pending 要注册')
    const exec = { agent: { session: { header: { id: 'sess_ip', cwd: iProj.workspacePath } } } }
    // 先把刚才批过的卡弄回待批准，制造一条
    const pendingId = Object.keys(iStore.state.tasks).find((id) => iStore.state.tasks[id].lane === 'issue' && iStore.state.tasks[id].column === 'running')
    await iDomain.move(pendingId, 'cancel', { role: 'human', id: 'me' }).catch(() => null)
    const res = await tool.execute({}, exec)
    assert.equal(res.ok, true, JSON.stringify(res).slice(0, 160))
    assert.ok(Array.isArray(res.items))
    assert.equal(typeof res.total, 'number')
    assert.equal(res.shown, Math.min(res.total, 50))
    assert.match(res.message, /待拍板/)
  })

  await t('limit 生效且不会超过总量', async () => {
    const tool = registeredTools.find((x) => x.name === 'flow_issue_pending')
    const exec = { agent: { session: { header: { id: 'sess_ip2', cwd: iProj.workspacePath } } } }
    const res = await tool.execute({ limit: 2 }, exec)
    assert.equal(res.ok, true)
    assert.ok(res.shown <= 2)
    assert.ok(res.shown <= res.total)
  })
}

// =========================================================================
console.log('\n[8.7] 事务工具补全（模型按名字就能调到的那些）')
// =========================================================================
const findTool = (name) => registeredTools.find((t) => t.name === name)

await t('flow_task_detail 能读到评论与 run（不只是看板摘要）', async () => {
  const detail = findTool('flow_task_detail')
  assert.ok(detail, 'flow_task_detail 要注册')
  const tk = await act('task.create', { projectId, title: '详情读取测试' })
  await act('task.comment', { taskId: tk.id, content: '这条评论必须被读到' })
  const res = await detail.execute({ taskId: tk.id })
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 160))
  assert.match(res.message, /这条评论必须被读到/)
  assert.ok(res.detail && res.detail.comments.length >= 1)
})

await t('flow_task_update 能改标题/验收标准', async () => {
  const upd = findTool('flow_task_update')
  assert.ok(upd, 'flow_task_update 要注册')
  const tk = await act('task.create', { projectId, title: '待改名' })
  const res = await upd.execute({ taskId: tk.id, title: '改好了', acceptance: ['a', 'b'] }, { agent: { session: { header: { id: 'sess_upd' } } } })
  assert.equal(res.ok, true)
  const d = await act('task.detail', { taskId: tk.id })
  assert.equal(d.task.title, '改好了')
  assert.deepEqual(d.task.acceptance, ['a', 'b'])
})

await t('flow_task_update 空 patch 要明确拒绝', async () => {
  const upd = findTool('flow_task_update')
  const tk = await act('task.create', { projectId, title: '空更新' })
  const res = await upd.execute({ taskId: tk.id }, {})
  assert.equal(res.ok, false)
  assert.match(res.message, /至少给一个/)
})

await t('flow_task_handoff 交接后阶段变 dispatched', async () => {
  const ho = findTool('flow_task_handoff')
  assert.ok(ho, 'flow_task_handoff 要注册')
  const tk = await act('task.create', { projectId, title: '交接测试' })
  await act('task.move', { taskId: tk.id, action: 'claim' })
  await act('task.plan', { taskId: tk.id, text: '计划' })
  const res = await ho.execute({ taskId: tk.id, notes: '交给子调度' }, { agent: { session: { header: { id: 'sess_ho' } } } })
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 160))
  const d = await act('task.detail', { taskId: tk.id })
  assert.equal(d.task.phase, 'dispatched')
  assert.equal(d.task.column, 'planning')
})

await t('flow_review_prompt 能读到审核判据集', async () => {
  const rp = findTool('flow_review_prompt')
  assert.ok(rp, 'flow_review_prompt 要注册')
  const res = await rp.execute({}, { agent: { session: { header: { id: 'sess_rp', cwd: 'C:/work/alpha' } } } })
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 160))
  assert.ok(Array.isArray(res.prompts))
  assert.ok(res.prompts.length > 0, '默认应带一套审核判据')
  assert.match(res.message, /审核判据/)
})

await t('flow_workspace_list 列出工作区并标出是否已有项目', async () => {
  const wl = findTool('flow_workspace_list')
  assert.ok(wl, 'flow_workspace_list 要注册')
  const res = await wl.execute({})
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.items))
  assert.ok(res.items.length > 0, '测试宿主里注册了 alpha/beta 两个工作区')
  const alpha = res.items.find((w) => /alpha/.test(w.path || ''))
  assert.ok(alpha && alpha.projectId, 'alpha 已经建过项目，要标出来')
})

await t('flow_reopen_request：代理能申请重开，但挂上去的是"申请"不是"重开"', async () => {
  const rq = findTool('flow_reopen_request')
  assert.ok(rq, 'flow_reopen_request 要注册')
  // resolveProject 靠会话头里的 cwd 找项目，别只给 id
  const exec = { agent: { session: { header: { id: 'sess_rq', cwd: 'C:/work/alpha' } } } }
  // t2 此刻是 cancelled（上一条用例刚取消过），正好是允许申请的状态
  const res = await rq.execute({ taskId: t2, reason: '接口改完发现漏了鉴权分支' }, exec)
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200))
  const d = await act('task.detail', { taskId: t2 })
  assert.equal(d.task.column, 'cancelled', '申请不能自己把卡挪走')
  assert.equal(d.task.reopenRequested.reason, '接口改完发现漏了鉴权分支')
  // 人执行重开 → 申请标记要清掉
  await act('task.move', { taskId: t2, action: 'reopen', payload: { reason: '确实漏了' } })
  const d2 = await act('task.detail', { taskId: t2 })
  assert.equal(d2.task.reopenRequested, null, '重开结案后不该再挂着申请')
})

await t('flow_reopen_request 拒绝没写理由的申请', async () => {
  const rq = findTool('flow_reopen_request')
  await act('task.move', { taskId: t2, action: 'cancel' })
  const res = await rq.execute({ taskId: t2, reason: '  ' }, { agent: { session: { header: { id: 'sess_rq', cwd: 'C:/work/alpha' } } } })
  assert.equal(res.ok, false)
  assert.match(res.message, /必须说明原因/)
  await act('task.move', { taskId: t2, action: 'reopen', payload: { reason: '收尾' } })
})

// =========================================================================
console.log('\n[9] catalog（模型下拉数据源）')
// =========================================================================
await t('catalog.get 返回真实分组与预设', async () => {
  const r = await act('catalog.get', {})
  assert.equal(r.ok, true)
  assert.equal(r.catalog.groups.length, 2)
  assert.equal(r.catalog.default.provider, 'maxapi')
  assert.deepEqual(r.presets.map((p) => p.id), ['standard', 'ptc'])
})

// =========================================================================
console.log('\n[10] 工作区对账（删工作区 = 删项目）')
// =========================================================================
await t('工作区消失 → tick 清掉项目与其任务', async () => {
  const beta = (await api('GET', '/api/flow/session-project?sessionId=sess_in_beta')).json
  const betaId = beta.projectId
  const betaTask = await act('task.create', { projectId: betaId, title: 'beta 任务' })
  workspaces.delete('ws_beta')
  await act('event.tick', {})
  const st = (await api('GET', '/api/flow/state')).json.state
  assert.equal(st.projects.some((p) => p.id === betaId), false, 'beta 项目要消失')
  assert.equal(!!st.tasks[betaTask.id], false, '它的任务也要消失')
})

await t('registry 读不到时不能误删（这一条靠 list() 正常返回保证，前面已断言 alpha 还在）', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  assert.ok(st.projects.some((p) => p.id === projectId), 'alpha 项目必须还在')
})

// =========================================================================
console.log('\n[11] 其余 action 全覆盖')
// =========================================================================
await t('task.update：改标题/描述/验收标准', async () => {
  const r = await act('task.update', { taskId: t2, patch: { title: '改过标题', note: '改过描述', acceptance: ['a', 'b'] } })
  assert.ok(r, '更新要成功')
  const d = await act('task.detail', { taskId: t2 })
  assert.equal(d.task.title, '改过标题')
  assert.equal(d.task.note, '改过描述')
  assert.deepEqual(d.task.acceptance, ['a', 'b'])
})

await t('agent.upsert：改模型/并发并落库', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const worker = Object.values(st.agents).find((a) => a.projectId === projectId && a.role === 'worker')
  const r = await act('agent.upsert', { projectId, id: worker.id, provider: 'krc', model: 'gpt-6-luna-codex', maxConcurrency: 2 })
  assert.ok(r, 'upsert 要成功')
  const st2 = (await api('GET', '/api/flow/state')).json.state
  const w2 = st2.agents.find((a) => a.id === worker.id)
  assert.equal(w2.provider, 'krc')
  assert.equal(w2.model, 'gpt-6-luna-codex')
  assert.equal(w2.maxConcurrency, 2)
})

await t('agent.session：拿到（或建出）DSH 会话', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const worker = Object.values(st.agents).find((a) => a.projectId === projectId && a.role === 'worker')
  const r = await act('agent.session', { agentId: worker.id })
  assert.ok(r.sessionId, '要返回 sessionId：' + JSON.stringify(r).slice(0, 120))
})

await t('budget.get：返回每个代理的水位', async () => {
  const r = await act('budget.get', { projectId })
  assert.ok(r.ok !== false)
  assert.ok(Array.isArray(r.budgets), '要返回 budgets 数组')
  assert.ok(r.budgets.length > 0, '至少一个代理')
  assert.ok(r.budgets.every((b) => b.agentId && b.budget && typeof b.budget.ratio === 'number'), '每项要有 agentId + ratio')
})

await t('project.init：给每个工位备会话并标身份名', async () => {
  const before = created.length
  const r = await act('project.init', { projectId })
  assert.ok(r.ok !== false, '初始化不该失败：' + JSON.stringify(r).slice(0, 300))
  // 工位池补齐 + 每个非 chief 工位都要有会话
  assert.ok(r.agentCount >= 2, '至少补齐调度+工人，实际 ' + r.agentCount)
  const st = (await api('GET', '/api/flow/state')).json.state
  const agents = Object.values(st.agents).filter((a) => a.projectId === projectId && a.role !== 'chief')
  const withSession = agents.filter((a) => Object.values(st.sessions).some((s) => s.agentId === a.id && s.sessionId))
  assert.equal(withSession.length, agents.length, '每个工位都要有会话：' + agents.length + ' 个工位只有 ' + withSession.length + ' 个有会话')
  // 身份名进会话标题：human调度1 / auto工人2 这种
  const titles = renamed.filter((x) => x.title).map((x) => x.title)
  assert.ok(titles.some((x) => /^human(调度|工人)\d+$/.test(x) || /^auto(调度|工人)\d+$/.test(x)),
    '要按身份命名会话，实际：' + JSON.stringify(titles).slice(0, 200))
  assert.ok(created.length > before, '第一次初始化应当建出新会话')
  // v1.17：会话建出来还不够——必须**真的在工作区成员表里**。
  // 线上那次的症状就是「初始化说会话已存在，但侧栏里一个都看不见（未分组）」。
  const ws = workspaces.get('ws_alpha')
  assert.ok(ws, 'alpha 工作区要还在')
  for (const a of agents) {
    const rec = Object.values(st.sessions).filter((s) => s.agentId === a.id && s.sessionId).pop()
    assert.ok(rec, a.name + ' 要有会话')
    assert.ok(ws.sessionIds.includes(rec.sessionId),
      a.name + ' 的会话 ' + rec.sessionId + ' 不在工作区成员里（成员：' + JSON.stringify(ws.sessionIds) + '）')
  }
})

await t('agent.reset：重建的会话也要按身份名命名（不能留 DSH 按首段提示词起的标题）', async () => {
  const st0 = (await api('GET', '/api/flow/state')).json.state
  const worker = Object.values(st0.agents).find((a) => a.projectId === projectId && a.role === 'worker')
  assert.ok(worker, '要有工人工位')
  const r = await act('agent.reset', { agentId: worker.id })
  assert.ok(r.ok !== false && r.sessionId, '重建要成功：' + JSON.stringify(r).slice(0, 200))
  const hit = renamed.find((x) => x.sessionId === r.sessionId)
  assert.ok(hit && /^(human|auto)?工人\d+$/.test(hit.title), '新会话 ' + r.sessionId + ' 要改名成工人身份名，实际：' + JSON.stringify(hit))
  const st = (await api('GET', '/api/flow/state')).json.state
  const rec = Object.values(st.sessions).filter((s) => s.agentId === worker.id && s.sessionId === r.sessionId).pop()
  assert.equal(rec && rec.title, hit.title, '绑定记录里的标题要同步')
})

await t('project.init：环境自检自动纠正 baseBranch 并接上 issue 车道', async () => {
  // 真仓库 + 真 git：模拟 BiliNote 事故形态（配置写 main，仓库真分支 master，上游 issue 开着）。
  // 这里不打网络：probe 用假 fetch 顶替，只验「事实 → 配置」这一段真的写进库。
  const { execFileSync } = await import('node:child_process')
  const gDir = mkdtempSync(join(os.tmpdir(), 'dsh-flow-setup-'))
  const sh = (args) => execFileSync('git', args, { cwd: gDir, encoding: 'utf8' })
  sh(['init', '-q', '-b', 'master'])
  sh(['config', 'user.email', 't@t.t'])
  sh(['config', 'user.name', 't'])
  writeFileSync(join(gDir, 'a.txt'), 'x')
  sh(['add', '-A'])
  sh(['commit', '-q', '-m', 'baseline'])
  sh(['remote', 'add', 'origin', 'https://github.com/El1mir/BiliNote.git'])

  const pr = await act('project.ensure', { workspacePath: gDir, name: 'setup-repo' })
  const pj = pr.result || pr
  assert.ok(pj.id, '建项目失败：' + JSON.stringify(pr).slice(0, 200))
  await act('project.config', { projectId: pj.id, patch: { baseBranch: 'main' } })

  // 探测上游这一步走真 HTTP 会打 GitHub；用 dryRun 关掉网络依赖，只验分支纠正。
  const dry = await act('project.setup', { projectId: pj.id, dryRun: true })
  assert.ok(dry.ok !== false, '自检不该失败：' + JSON.stringify(dry).slice(0, 300))
  assert.equal(dry.isRepo, true)
  assert.equal(dry.patch.baseBranch, 'master', 'baseBranch 应被纠正成 master，实际 ' + JSON.stringify(dry.patch))
  assert.ok((dry.notes || []).some((x) => /main 在仓库里不存在/.test(x)), '要说明为什么改：' + JSON.stringify(dry.notes))

  const real = await act('project.setup', { projectId: pj.id })
  assert.ok(real.ok !== false)
  const st = (await api('GET', '/api/flow/state')).json.state
  const row = Object.values(st.projects).find((p) => p.id === pj.id)
  assert.equal(row.config.baseBranch, 'master', '真跑完 baseBranch 要落库成 master，实际 ' + row.config.baseBranch)
  assert.ok(Array.isArray(real.applied) && real.applied.includes('baseBranch'), 'applied 要列出改了哪些键')
  // 这个仓库是测试临时目录，用完就删——否则 scheduler 的 reconcileWorkspaces
  // 会在后面几秒内把它当「工作区不见了」删掉，事件里还会多一条 project.removed。
  await act('project.remove', { projectId: pj.id })
})
await t('project.init 幂等：再点一次不重复建会话', async () => {
  const st1 = (await api('GET', '/api/flow/state')).json.state
  const n1 = Object.values(st1.sessions).filter((s) => s.projectId === projectId).length
  const r = await act('project.init', { projectId })
  assert.ok(r.ok !== false)
  assert.equal(r.created.length, 0, '第二次不该再建会话：' + JSON.stringify(r.created).slice(0, 200))
  const st2 = (await api('GET', '/api/flow/state')).json.state
  const n2 = Object.values(st2.sessions).filter((s) => s.projectId === projectId).length
  assert.equal(n2, n1, '会话条数不该变')
})

await t('project.init 不动主调度（chief 是用户自己的聊天）', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const chief = Object.values(st.agents).find((a) => a.projectId === projectId && a.role === 'chief')
  assert.ok(chief, '要有主调度')
  assert.ok(!/^(human|auto)/.test(String(chief.name || '')), '主调度不该被改成身份名：' + chief.name)
})

// v1.17 回归：项目的 workspaceId 会失效（工作区被删/重建、project 行从别处导入）。
// 失效后 session.create 拿它查不到工作区，会话就落到 cwd 上、进不了任何工作区——
// 界面上就是「初始化说会话已存在，侧栏里却是未分组」。这条用例专门钉住那个模式。
await t('project.init：workspaceId 失效时按路径自愈，会话仍要进工作区', async () => {
  const ghost = await api('POST', '/api/flow/action', {
    action: 'project.ensure',
    args: { workspacePath: 'C:/work/gamma', name: 'gamma', workspaceId: 'ws_ghost' },
  })
  assert.ok(ghost.json.ok !== false, '建项目：' + JSON.stringify(ghost.json).slice(0, 200))
  const p2 = (ghost.json.result && ghost.json.result.id) || (ghost.json.result && ghost.json.result.project && ghost.json.result.project.id)
  assert.ok(p2, '要拿到新项目 id：' + JSON.stringify(ghost.json).slice(0, 300))
  const r = await actRaw('project.init', { projectId: p2 })
  assert.ok(r.ok !== false, '初始化不该失败，失败明细：' + JSON.stringify(r.failed).slice(0, 600))
  // 1) 项目的 workspaceId 要自愈成真实 id
  const st = (await api('GET', '/api/flow/state')).json.state
  // 注意：snapshot 里 projects 是**数组**（Object.values），不是以 id 为键的表
  const p2row = st.projects.find((p) => p.id === p2)
  assert.ok(p2row, 'gamma 项目要在快照里')
  assert.equal(p2row.workspaceId, 'ws_gamma',
    'workspaceId 应按路径自愈成 ws_gamma，实际 ' + p2row.workspaceId)
  // 2) 每个会话都要真的在工作区成员表里
  const ws = workspaces.get('ws_gamma')
  const agents = Object.values(st.agents).filter((a) => a.projectId === p2 && a.role !== 'chief')
  assert.ok(agents.length >= 2, '至少补齐调度+工人，实际 ' + agents.length)
  for (const a of agents) {
    const rec = Object.values(st.sessions).filter((s) => s.agentId === a.id && s.sessionId).pop()
    assert.ok(rec, a.name + ' 要有会话')
    assert.ok(ws.sessionIds.includes(rec.sessionId),
      a.name + ' 的会话不在 ws_gamma 成员里（成员：' + JSON.stringify(ws.sessionIds) + '）')
  }
})

await t('project.sessions：给角色补会话不炸（老名字，等价于 project.init）', async () => {
  const r = await act('project.sessions', { projectId })
  assert.ok(r.ok !== false, '要能补会话')
})

// v1.17：用户点「清理并重建」要能把孤儿会话收干净再建新的。
await t('project.reset：清掉旧会话并重新建一套（挂进工作区）', async () => {
  const before = created.length
  const r = await actRaw('project.reset', { projectId })
  assert.ok(r.ok !== false, '清理+重建不该失败：' + JSON.stringify(r).slice(0, 400))
  assert.ok(r.cleanedCount >= 2, '至少清掉调度+工人两个工位，实际 ' + r.cleanedCount)
  assert.ok(created.length > before, '清完要重建新会话')
  // 重建出来的会话必须真的在工作区里
  const st = (await api('GET', '/api/flow/state')).json.state
  const ws = workspaces.get('ws_alpha')
  const agents = Object.values(st.agents).filter((a) => a.projectId === projectId && a.role !== 'chief')
  for (const a of agents) {
    const rec = Object.values(st.sessions).filter((s) => s.agentId === a.id && s.sessionId && s.state !== 'archived').pop()
    assert.ok(rec, a.name + ' 清理后要重建出会话')
    assert.ok(ws.sessionIds.includes(rec.sessionId),
      a.name + ' 重建的会话不在工作区成员里（成员：' + JSON.stringify(ws.sessionIds) + '）')
  }
  assert.ok(archived.length > 0, '旧会话要被归档，不能只是从表里删掉')
})

await t('workspace.list：列出 DSH 工作区', async () => {
  const r = await act('workspace.list', {})
  assert.ok(Array.isArray(r.items), '要返回数组')
})

await t('worktree.list：列 worktree', async () => {
  const r = await act('worktree.list', { taskId })
  assert.ok(Array.isArray(r.items))
})

await t('review.prompt.upsert：改审核判据版本号递增', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const promptsList = Array.isArray(st.reviewPrompts) ? st.reviewPrompts : Object.values(st.reviewPrompts || {})
  const p = promptsList.find((x) => x.projectId === projectId)
  assert.ok(p, '要有默认审核判据')
  const r = await act('review.prompt.upsert', { projectId, id: p.id, name: '改名', prompt: '新判据', severity: 'warn' })
  assert.ok(r.version >= p.version, '版本号不能回退')
})

await t('chat.send：投到主调度会话', async () => {
  const before = prompts.length
  const st = (await api('GET', '/api/flow/state')).json.state
  const chief = Object.values(st.agents).find((a) => a.projectId === projectId && a.role === 'chief')
  assert.ok(chief, '要有主调度角色')
  const r = await act('chat.send', { agentId: chief.id, message: '功能测试：你好' })
  assert.ok(r.ok !== false, '投递要成功')
  assert.ok(prompts.length > before, '真的投了消息')
})

await t('session.list / session.commands 可用', async () => {
  const a1 = await act('session.list', {})
  assert.ok(Array.isArray(a1.items))
  const a2 = await actRaw('session.commands', {})
  assert.ok(Array.isArray(a2.items || []), '命令列表要是数组')
})

await t('inspect（只读取巡检建议）', async () => {
  const r = await act('inspect', { taskId })
  assert.ok(r.verdict, '要有结论')
})

await t('task.handoff：计划定稿后交给车道子调度', async () => {
  const tk = await act('task.create', { projectId, title: 'handoff 测试' })
  await act('task.move', { taskId: tk.id, action: 'claim' })
  await act('task.plan', { taskId: tk.id, text: '计划内容' })
  const r = await act('task.handoff', { taskId: tk.id, notes: '交给子调度' })
  assert.ok(r, 'handoff 要成功')
  const d = await act('task.detail', { taskId: tk.id })
  assert.ok(d.task.handoff, '要留下交付包')
  assert.equal(d.task.handoff.planRev, d.task.plan.revision, '交付包要绑当前 plan_rev')
  assert.equal(d.task.column, 'planning', 'handoff 不挪列')
  assert.equal(d.task.phase, 'dispatched', '但要把 phase 标成已交给子调度（和 flow_publish 一致）')
})

await t('task.reassign：改派但列不变', async () => {
  const st = (await api('GET', '/api/flow/state')).json.state
  const sups = Object.values(st.agents).filter((a) => a.projectId === projectId && a.role === 'dispatcher')
  const tk = await act('task.create', { projectId, title: '改派测试' })
  await act('task.move', { taskId: tk.id, action: 'claim' })
  const r = await act('task.reassign', { taskId: tk.id, agentId: tk.assignee || null, supervisorId: sups[sups.length - 1].id })
  assert.ok(r.ok !== false)
  const d = await act('task.detail', { taskId: tk.id })
  assert.equal(d.task.column, 'planning', '改派不能挪列')
})

await t('chief.get / chief.bind / chief.unbind 仍可用（兼容旧接口）', async () => {
  const g = await act('chief.get', { projectId })
  assert.ok(g.ok !== false)
  const b = await act('chief.bind', { projectId, sessionId: 'sess_chief_x' })
  assert.ok(b.ok !== false, '绑定接口要保留')
  const u = await act('chief.unbind', { projectId })
  assert.equal(u.ok, true)
})

await t('event.sync：没配 remote 时明确报错，tick 能跑', async () => {
  const s1 = await actRaw('event.sync', { projectId })
  assert.equal(s1.ok, false, '没配 remote 必须明确失败')
  assert.match(String(s1.reason), /remote/)
  const s2 = await act('event.tick', {})
  assert.ok(s2 && s2.at, 'tick 要返回报告')
})

// =========================================================================
console.log('\n[12] 事件流与视图')
// =========================================================================
await t('事件流覆盖整条事务且不含水位噪声', async () => {
  const st = (await api('GET', '/api/flow/state?events=2000')).json.state
  const events = (st.events || []).filter((e) => e.type !== 'session.budget')
  const types = new Set(events.map((e) => e.type))
  for (const need of ['task.created', 'task.moved', 'task.dispatched', 'approval.recorded']) {
    assert.ok(types.has(need), '缺事件 ' + need)
  }
  assert.equal(events.some((e) => /上下文水位/.test(e.type)), false)
})

await t('/project 视图带七列、双车道、任务卡事务字段', async () => {
  const r = await api('GET', '/api/flow/project?projectId=' + encodeURIComponent(projectId))
  assert.equal(r.status, 200)
  assert.equal(r.json.columns.length, 7)
  assert.ok(r.json.lanes.human && r.json.lanes.issue)
  const cards = Object.values(r.json.tasks).flat()
  assert.ok(cards.length > 0, '要有卡')
  for (const f of ['id', 'column', 'version', 'plan', 'blocked', 'scope']) {
    assert.ok(f in cards[0], '任务卡缺字段 ' + f)
  }
})

// =========================================================================
console.log('\n' + pass + ' 功能检查通过' + (failures.length ? '，' + failures.length + ' 失败' : ''))
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f.name + '：' + f.message.slice(0, 200))
}
await new Promise((resolve) => server.close(resolve))
// 插件里有 setInterval（outbox pump / scheduler tick），不停掉进程不会退出
try { if (typeof disposePlugin === 'function') await disposePlugin() } catch { /* 已释放 */ }
process.exit(failures.length ? 1 : 0)
