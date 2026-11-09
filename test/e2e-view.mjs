/**
 * e2e-view.mjs — 用真实插件 + 真实 HTTP 跑一遍会话视图的后端链路。
 *
 * 线上 dsh web 里 lib/http.js 是旧模块（宿主重跑 apply 但不重载已加载模块），
 * /api/flow/project 在线上 404。这个脚本用同一份代码在独立端口起实例，
 * 证明「新路由 + 会话解析 + 绑定解绑 + 视图字段」在真实 HTTP 下是通的，
 * 把"代码问题"和"需要重启"区分开。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { emptyState } from '../lib/core.js'

const dir = mkdtempSync(join(os.tmpdir(), 'dsh-flow-e2e-'))
const dataFile = join(dir, 'flow.json')
process.env.DSH_FLOW_FILE = dataFile
writeFileSync(dataFile, JSON.stringify(emptyState(), null, 2))

const { apply } = await import('../index.js')

const routes = []
const prompts = []
const sessions = { ses_chat: { cwd: 'C:/work/alpha' }, ses_other: { cwd: 'C:/work/beta' } }
// 每个会话被 inspect 了几次：读侧缓存的断言就靠它（v0.016.3）
const inspectCount = {}
const ctx = {
  tools: { register() {}, restrict() { return () => {} } },
  on() { return () => {} },
  effect(cb) { return cb() },
  inject(_deps, cb) { return cb(ctx) },
  reflect: {
    get(name) {
      if (name === 'webServer') return { register(route) { routes.push(route); return () => {} } }
      if (name === 'connection') return { admit() { return { peer: { id: 'e2e' } } } }
      if (name === 'sessionController') {
        return {
          async create() { return { sessionId: 'ses_created' } },
          async prompt(req, signal) {
            if (!signal || typeof signal.throwIfAborted !== 'function') throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
            const text = (req && req.content && req.content[0] && req.content[0].text) || ''
            prompts.push({ sessionId: req && req.sessionId, text })
            return {}
          },
          async list() { return { items: Object.entries(sessions).map(([sessionId, v]) => ({ sessionId, cwd: v.cwd, updatedAt: 1 })) } },
          async inspect(sessionId) {
            if (typeof sessionId !== 'string') throw new TypeError('inspect(sessionId): sessionId must be a string')
            inspectCount[sessionId] = (inspectCount[sessionId] || 0) + 1
            // 慢会话：模拟冷会话要把整份会话文件读出来（线上最大的那个 7.26s）
            if ((sessions[sessionId] || {}).slow) await new Promise((r) => setTimeout(r, 150))
            return { meta: { cwd: (sessions[sessionId] || {}).cwd || null } }
          },
          async resolveAgent(sessionId) { return { agent: { session: { header: { id: sessionId } } } } },
        }
      }
      if (name === 'commands') return { register() { return () => {} }, async execute() { return null }, list() { return [] } }
      if (name === 'systemPrompt') return { section() { return () => {} }, getSectionOrder() { return 100 } }
      if (name === 'workspaceRegistry') return { resolveByPath: async () => null, list: () => [] }
      if (name === 'compaction') return { compactNow: async () => ({}) }
      if (name === 'tokenMeter') return { measure: () => ({ tokens: 100, window: 1000, ratio: 0.1 }) }
      return undefined
    },
  },
  logger: { warn() {}, error() {} },
}

const dispose = apply(ctx)
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
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const action = async (name, args = {}) => {
  const r = await api('POST', '/api/flow/action', { action: name, args })
  const body = r.json || {}
  return body.result || body
}

let pass = 0
const t = async (name, fn) => {
  await fn()
  pass += 1
  console.log('  ✓ ' + name)
}

try {
  const project = await action('project.ensure', { workspacePath: 'C:/work/alpha', name: 'alpha' })
  const projectId = project.id
  await t('project.ensure 走真实 HTTP 返回项目', () => assert.ok(projectId))

  const sp1 = await api('GET', '/api/flow/session-project?sessionId=ses_chat')
  await t('GET /session-project 200 且按 cwd 命中', () => {
    assert.equal(sp1.status, 200)
    assert.equal(sp1.json.ok, true)
    assert.equal(sp1.json.projectId, projectId)
    assert.equal(sp1.json.matchedBy, 'workspace')
  })

  const pv = await api('GET', '/api/flow/project?projectId=' + encodeURIComponent(projectId))
  await t('GET /project 200 且七列/双车道齐全', () => {
    assert.equal(pv.status, 200)
    assert.equal(pv.json.ok, true)
    assert.equal(pv.json.columns.length, 7)
    assert.ok(pv.json.lanes.human && pv.json.lanes.issue)
    assert.equal(pv.json.project.id, projectId)
  })

  // v1.4：不再有「绑定主调度」——同一工作区的任何对话都直接解析到同一个项目
  const sp2 = await api('GET', '/api/flow/session-project?sessionId=ses_chat')
  await t('工作区即项目：任意对话都解析到同一个项目', () => {
    assert.equal(sp2.json.projectId, projectId)
    assert.equal(sp2.json.matchedBy, 'workspace')
  })

  const task = await action('task.create', { projectId, title: 'e2e 任务', lane: 'human' })
  await t('建卡后 /project 里出现该卡（界面数据源）', async () => {
    const v = await api('GET', '/api/flow/project?projectId=' + encodeURIComponent(projectId))
    const todo = v.json.tasks.todo || []
    assert.ok(todo.some((x) => x.id === task.id), '待办列应有这张卡')
    assert.equal(v.json.columns.find((c) => c.id === 'todo').count, 1)
  })

  await action('task.move', { taskId: task.id, action: 'claim' })
  await t('迁移后列计数跟着走（claim → 规划中）', async () => {
    const v = await api('GET', '/api/flow/project?projectId=' + encodeURIComponent(projectId))
    assert.equal(v.json.columns.find((c) => c.id === 'planning').count, 1)
    assert.equal(v.json.columns.find((c) => c.id === 'todo').count, 0)
  })

  await t('解析不依赖任何绑定状态', async () => {
    const sp3 = await api('GET', '/api/flow/session-project?sessionId=ses_chat')
    assert.equal(sp3.json.projectId, projectId)
  })

  // v1.4：任务记住发起对话；回信要投回那个会话
  const withOrigin = await action('task.create', { projectId, title: '回信路由', originSessionId: 'ses_chat' })
  await t('建卡时记录发起对话', async () => {
    const d = await api('GET', '/api/flow/task/' + encodeURIComponent(withOrigin.id))
    assert.equal(d.json.task.originSessionId, 'ses_chat')
  })
  await t('task.reply 把回信投到发起对话', async () => {
    const before = prompts.length
    const r = await action('task.reply', { taskId: withOrigin.id, message: '干完了' })
    assert.equal(r.ok, true)
    assert.equal(r.sessionId, 'ses_chat', '收件人必须是发起这张卡的那个会话')
    const sent = prompts.slice(before)
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /干完了/)
  })

  await t('catalog.get 在缺服务时也稳定返回（不 500）', async () => {
    const r = await api('POST', '/api/flow/action', { action: 'catalog.get', args: {} })
    assert.equal(r.status, 200)
    const res = r.json.result || r.json
    assert.equal(res.ok, true)
    assert.ok(Array.isArray(res.presets), 'presets 必须是数组')
  })


  // ---- v0.016.3 读侧缓存：打开调度台不该反复读会话文件 ----------------------
  //
  // 线上症状：点「调度台」要等好几秒，最大的冷会话实测 7.26s。
  // 根因是 /session-project 每次都 sessionController.inspect(整份会话文件)，
  // 而面板每次挂载、以及开着的每 8 秒轮询，都会把这条路再走一遍。
  await t('会话 cwd 第二次解析必须命中缓存（不再读会话文件）', async () => {
    sessions.ses_cold = { cwd: 'C:/work/gamma', slow: true }
    const t0 = Date.now()
    const first = await api('GET', '/api/flow/session-project?sessionId=ses_cold')
    const firstMs = Date.now() - t0
    const t1 = Date.now()
    const second = await api('GET', '/api/flow/session-project?sessionId=ses_cold')
    const secondMs = Date.now() - t1
    assert.equal(first.json.cwd, 'C:/work/gamma', '首次解析要拿到 cwd')
    assert.equal(second.json.cwd, 'C:/work/gamma', '第二次解析结果要一致')
    assert.equal(inspectCount.ses_cold, 1, '同一个会话只许 inspect 一次，实际 ' + inspectCount.ses_cold)
    assert.ok(firstMs >= 80, '慢会话首次解析应当确实慢（证明载荷有效），实际 ' + firstMs + 'ms')
    assert.ok(secondMs <= 40, '第二次必须是缓存命中（<=40ms），实际 ' + secondMs + 'ms')
  })

  // token 统计：面板每 8 秒打一次 project.metrics，每次都把所有会话 inspect 一遍，
  // 4.7M token 的会话单次 150ms —— 面板开着就等于持续占着主线程。
  await t('project.metrics 的 token 统计 20 秒内复用（不重复读会话）', async () => {
    const view = await api('GET', '/api/flow/project?projectId=' + encodeURIComponent(projectId))
    const firstAgent = (view.json.agents || [])[0]
    assert.ok(firstAgent && firstAgent.id, '项目应带默认工位（要用它绑一个会话）')
    const bound = await action('agent.session', { agentId: firstAgent.id })
    assert.ok(bound && bound.sessionId, '工位绑定会话失败：' + JSON.stringify(bound))
    const sid = bound.sessionId
    const before = inspectCount[sid] || 0
    const m1 = await api('POST', '/api/flow/action', { action: 'project.metrics', args: { projectId, withTokens: true } })
    const mid = inspectCount[sid] || 0
    const m2 = await api('POST', '/api/flow/action', { action: 'project.metrics', args: { projectId, withTokens: true } })
    const after = inspectCount[sid] || 0
    assert.equal((m1.json.result || {}).ok, true)
    assert.equal((m2.json.result || {}).ok, true)
    assert.ok(mid - before >= 1, '第一次 metrics 应当读一次刚绑定的会话，实际增量 ' + (mid - before))
    assert.equal(after - mid, 0, '第二次 metrics 必须走 20 秒缓存，实际又读了 ' + (after - mid) + ' 次')
    assert.ok(m1.json.result.tokens && m2.json.result.tokens, '两次都要带回 tokens')
  })

  // 采样落盘：store.tx 会深拷整份 state 再 pretty-print 落盘（线上 3MB），
  // 原来面板每 8 秒轮询就触发一次全量重写 —— 现在每分钟最多一次。
  await t('metrics 采样每分钟最多落盘一次（不再每 8 秒重写整份 state）', async () => {
    const samplesOf = () => {
      const raw = JSON.parse(readFileSync(dataFile, 'utf8'))
      const slot = (raw.metrics || {})[projectId]
      return Array.isArray(slot && slot.samples) ? slot.samples.length : 0
    }
    // 模拟面板开着一分钟：8 次轮询（真实是每 8 秒一次）。
    // 两道闸一起保证「最多一条采样」：20 秒结果缓存挡住大部分，
    // 真走到计算那一次，落盘节流再挡一层。
    const n0 = samplesOf()
    for (let i = 0; i < 8; i += 1) {
      await api('POST', '/api/flow/action', { action: 'project.metrics', args: { projectId, withTokens: true } })
    }
    const n1 = samplesOf()
    assert.ok(n1 - n0 <= 1, '一分钟 8 次轮询最多写 1 条采样，实际从 ' + n0 + ' 变成 ' + n1)
  })
  const rm = await action('task.remove', { taskId: task.id })
  const rmProject = await action('project.remove', { projectId })
  await t('task.remove / project.remove 真实 HTTP 可用', () => {
    assert.equal(rm.ok, true)
    assert.equal(rmProject.ok, true)
    // withOrigin 那张卡还在项目里：project.remove 要把剩下的任务一起带走
    assert.equal(rmProject.removedTasks, 1, '项目删除要级联清掉剩余任务')
  })
  await t('删项目后 /project 返回 404（界面走未知项目分支）', async () => {
    const gone = await api('GET', '/api/flow/project?projectId=' + encodeURIComponent(projectId))
    assert.equal(gone.status, 404)
    assert.equal(gone.json.ok, false)
  })

  console.log('\n' + pass + ' e2e-view checks passed · ' + base)
} finally {
  await new Promise((resolve) => server.close(resolve))
  // 插件里的 scheduler / outbox 定时器要显式停掉，否则进程不退出（CI 会挂起）
  try { await dispose() } catch { /* 已释放 */ }
  // 注意：不要在这里 process.exit —— 会把 try 块里的断言错误一起吞掉
}
