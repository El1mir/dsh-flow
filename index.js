/**
 * dsh-flow: DSH 调度台插件（Cordis function plugin）。
 *
 * 组成：
 *   lib/core.js    真相源 Store + 状态机 + 租约 + 事件/outbox
 *   lib/domain.js  领域操作（全部走事务）
 *   lib/chat.js    会话事件流 → 工作台聊天帧（只读）
 *   lib/tools.js   flow_* 工具（给调度员/工人会话）
 *   lib/http.js    /api/flow/*（页面、快照、SSE、聊天、动作）
 *   lib/ui.js      工作台页面
 *
 * 依赖的 DSH 能力（缺失时降级，不崩）：
 *   ctx.sessionController  create / prompt / cancel / resolveAgent
 *   ctx.workspaceController archiveSession
 *   ctx.goals              create / clear / get
 *   ctx.on('session/event') 聊天流
 */

import os from 'node:os'
import { join } from 'node:path'
import { Store } from './lib/core.js'
import { FlowDomain, agentLabel } from './lib/domain.js'
import { ChatHub } from './lib/chat.js'
import { createDispatcher } from './lib/dispatch.js'
import { createScheduler } from './lib/scheduler.js'
import { syncProject } from './lib/remote.js'
import { createSyncEngine } from './lib/sync-engine.js'
import { detectSetup, planSetup } from './lib/setup.js'
import { buildTools } from './lib/tools.js'
import { foldUsage, totalsFromProjection } from './lib/token-usage.js'
import { systemRulesFor, setRulesInSystemPrompt } from './lib/prompts.js'
import { createHttpHandler } from './lib/http.js'
import { createFlowMode, parseFlowCommand, validatePublishInput, FLOW_SECTION_TEXT, describeDenyPlan } from './lib/command-flow.js'

export const name = 'dsh-flow'
export const inject = ['tools']

const DATA_FILE = () => process.env.DSH_FLOW_FILE || join(os.homedir(), '.dsh', 'flow', 'flow.json')

const pick = (svc, keys) => {
  if (!svc) return null
  for (const k of keys) if (typeof svc[k] === 'function') return svc[k].bind(svc)
  return null
}
const msgOf = (err) => (err && err.message) || String(err)

/**
 * v1.37.2：flow 自己投递消息时的 source.kind。
 *
 * DSH 的 sessionController.prompt() 把它写死成 'user'，于是下游插件分不清
 * "人问的问题"和"flow 的机器通知"。flow 自己造 message 时用这个值，
 * 让别的插件（例如 codegraph 的 prompt front-load）能按 source.kind 过滤掉。
 */
const SOURCE_KIND = 'plugin:dsh-flow'
const rid = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
const logLine = (msg) => console.log('dsh-flow: ' + msg)

/**
 * 读 DSH 服务，不需要 inject 声明。
 * Cordis 的 ctx.reflect.get(name, false) 是官方「无 inject 要求」的读取入口；
 * ctx[name] 对未声明的服务会抛 "cannot get property ... without inject"。
 */
const resolveService = (ctx, key) => {
  try {
    const reflect = ctx && ctx.reflect
    if (reflect && typeof reflect.get === 'function') {
      const svc = reflect.get(key, false)
      if (svc) return svc
    }
  } catch {}
  try { return ctx[key] } catch { return undefined }
}

/**
 * session.create 只接受 workspaceId 或 cwd 之一：两个都传会被 DSH 拒绝
 * （"session.create accepts workspaceId or cwd, not both"）。
 * 项目根目录优先挂 workspaceId（会话进工作区列表）；worktree 等其它目录只传 cwd。
 */
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const sessionLocation = (project, cwd, resolvedWsId) => {
  // resolvedWsId 三态：undefined=没解析过（沿用 project.workspaceId）
  //                 null=解析过但**没有**工作区 → 绝不能把可能失效的 id 交给 DSH
  //                 字符串=按路径重解析到的真实 id
  const wsId = resolvedWsId === undefined ? (project && project.workspaceId) : resolvedWsId
  const root = project && project.workspacePath
  if (wsId && (!cwd || (root && normPath(cwd) === normPath(root)))) return { workspaceId: wsId }
  return cwd ? { cwd } : {}
}

/** 代理身上配置的模型选择；没配 provider+model 就返回 null（交给 DSH 默认）。 */
const modelOf = (agent) =>
  agent && agent.provider && agent.model
    ? { provider: agent.provider, model: agent.model, reasoningEffort: agent.reasoningEffort || undefined }
    : null

const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/**
 * node:http ↔ WHATWG Fetch 桥。
 * webServer.register 的 handler 是 (req,res)，而 lib/http.js 是 Request→Response，
 * 这里做转换；响应体按块写回，SSE 才能真流。
 */
async function serveNodeRequest(req, res, fetchHandler, connection) {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const url = new URL(req.url || '/', 'http://dsh.internal')
  const method = req.method || 'GET'
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
  let body
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.byteLength
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    if (chunks.length > 0) body = Buffer.concat(chunks)
  }
  const request = new Request(url, { method, headers, ...(body ? { body } : {}), signal: abort.signal })
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(request)
      if (admission && admission.rejection) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
    } catch (err) {
      logLine('admit failed: ' + msgOf(err))
    }
  }
  const response = await fetchHandler(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (!response.body) { res.end(); return }
  for await (const chunk of response.body) {
    if (abort.signal.aborted) continue
    if (!res.write(chunk) && !res.destroyed) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve() }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}

export function apply(ctx) {
  const store = new Store(DATA_FILE())
  const chat = new ChatHub()
  const log = logLine

  // v1.37：三级模型解析 — 工位显式 → 项目默认 → 全局默认 → DSH 当前
  const resolveModel = (agent) => {
    if (agent && agent.provider && agent.model) {
      return { provider: agent.provider, model: agent.model, reasoningEffort: agent.reasoningEffort || undefined }
    }
    if (agent && agent.projectId) {
      const proj = store.state.projects[agent.projectId]
      if (proj && proj.config && proj.config.defaultProvider && proj.config.defaultModel) {
        return { provider: proj.config.defaultProvider, model: proj.config.defaultModel, reasoningEffort: proj.config.defaultReasoningEffort || undefined }
      }
      const g = store.state.settings
      if (g && g.defaultProvider && g.defaultModel) {
        return { provider: g.defaultProvider, model: g.defaultModel, reasoningEffort: g.defaultReasoningEffort || undefined }
      }
    }
    return null
  }

  // ---- v1.0：/flow 只读调度模式 -------------------------------------------
  const flowMode = createFlowMode({ log })
  ctx.effect(() => () => { try { flowMode.disposeAll() } catch { /* 卸载期尽力 */ } }, 'dsh-flow: dispose flow mode')

  // 系统提示段落：只在模式激活时注入（按会话判定）
  try {
    const prompt = resolveService(ctx, 'systemPrompt')
    if (prompt && typeof prompt.section === 'function') {
      prompt.section({
        name: 'flow:dispatch',
        order: typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('PLAN_POLICY') : 100,
        text: (context) => {
          const sid = context && context.agent && context.agent.session && context.agent.session.header
            ? context.agent.session.header.id
            : null
          return sid && flowMode.isActive(sid) ? FLOW_SECTION_TEXT : ''
        },
      })
      log('systemPrompt section flow:dispatch registered')
      // v1.38：工人 / 调度会话的强制约束走系统提示词，投递消息里不再每次重复。
      // 只对本插件登记过的工位会话生效；chief（总调度）和普通对话不注入。
      prompt.section({
        name: 'flow:rules',
        order: typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('PLAN_POLICY') + 1 : 101,
        text: (context) => {
          const sid = context && context.agent && context.agent.session && context.agent.session.header
            ? context.agent.session.header.id
            : null
          if (!sid) return ''
          const rec = Object.values(store.state.agent_sessions || {})
            .find((r) => r && r.sessionId === sid && r.state !== 'archived')
          const agent = rec ? (store.state.agents || {})[rec.agentId] : null
          if (!agent || !['worker', 'dispatcher', 'griller'].includes(agent.role)) return ''
          return systemRulesFor(agent.role)
        },
      })
      setRulesInSystemPrompt(true)
      log('systemPrompt section flow:rules registered')
    }
  } catch (err) {
    log('systemPrompt section skipped: ' + msgOf(err))
  }

  // /flow 斜杠命令
  try {
    const commands = resolveService(ctx, 'commands')
    if (commands && typeof commands.register === 'function') {
      commands.register({
        definitionId: '@local/dsh-flow',
        name: 'flow',
        description: '进入/退出调度模式：拆解需求 → 生成可派工任务 → flow_publish 发布即开工（写工具已收回）',
        input: { hint: '[on|off|status]', attachments: false },
        handler: async ({ agent, rawInput }) => {
          const sid = agent && agent.session && agent.session.header ? agent.session.header.id : null
          if (!sid) return { kind: 'error', text: '当前会话没有 id，无法切换调度模式' }
          const cmd = parseFlowCommand(rawInput)
          if (cmd.action === 'off') {
            const r = flowMode.exit(sid)
            return { kind: 'success', text: r.message }
          }
          if (cmd.action === 'status') {
            return { kind: 'success', text: flowMode.isActive(sid) ? '调度模式：开启' : '调度模式：关闭' }
          }
          if (cmd.action === 'help') {
            return {
              kind: 'success',
              text: [
                '用法：/flow [on|off|status]',
                '',
                'on  → 进入调度模式：写工具被收回，自动加载 flow skill 开始拆解需求；',
                '      拆完把任务清单与执行序讲给用户，确认后 flow_publish 发布。',
                'off → 退出模式，工具恢复。',
                'status → 看当前是否在模式里。',
                '',
                '发布 = 已批准：任务会直接进「执行中」并派给子调度/工人。',
              ].join('\n'),
            }
          }
          // 关键：把 agent 传进去——restrict 必须落在 agent 作用域，
          // 用全局 ctx.tools 会被 Host 拒绝（会 mask 掉所有 agent 的写工具）
          const r = flowMode.enter(agent, sid)
          if (!r.ok) return { kind: 'error', text: r.message }
          // v1.4：工作区即项目，不再"认领主调度"；这里只报一下当前工作区对应哪个项目
          let tip = ''
          try {
            const resolved = await resolveSessionProject(sid)
            tip = resolved && resolved.ok
              ? '\n当前工作区项目：' + resolved.projectName + '（本对话可直接调度）'
              : '\n当前工作区还没有对应项目：在 DSH 里把它加成工作区即可'
          } catch (err) {
            tip = '\n解析当前工作区失败：' + msgOf(err)
          }
          return { kind: 'success', text: r.message + tip }
        },
      })
      log('/flow command registered')
    } else {
      log('/flow command skipped: no commands service')
    }
  } catch (err) {
    log('/flow command skipped: ' + msgOf(err))
  }


  // 只读接口（state / 工具 / 侧栏会话）不经过写事务：启动即加载磁盘状态，
  // 否则 DSH 重启后会看到空工作台（文件里有项目/代理却读不出来）。
  const storeReady = store.ready()
  storeReady.catch((err) => log('store load failed: ' + msgOf(err)))

  // ---- 读侧短缓存（v0.016.3） -------------------------------------------------
  // 调度台面板有个 8 秒轮询：project.metrics（token 统计）和 inbox.list。
  // token 统计要把每个会话 inspect + foldUsage 一遍，4.7M token 的会话单次 150ms；
  // 面板只要开着就每 8 秒烧一次主线程，打开时的首屏也排在这后面。
  // 这里只缓存「按项目汇总的 token 数字」——它是累计值，20 秒陈旧度不影响任何决策。
  const TOKEN_STATS_TTL_MS = 20 * 1000
  const tokenStatsCache = new Map()

  // ---- DSH 适配层：会话/归档/goal。任何一项缺失都只影响对应动作。 ----------------
  const runtime = {
    services() {
      const get = (key) => resolveService(ctx, key)
      return {
        session: get('sessionController'),
        commands: get('commands'),
        workspace: get('workspaceController'),
        goals: get('goals') || get('goalService') || get('goal'),
      }
    },

    /**
     * 把一段文本投进真实 DSH 会话。
     *
     * v1.37.2：优先自己造 message 走 agent.followup/steer，而不是 sessionController.prompt()。
     *
     * 为什么必须绕开 prompt()：它把 source.kind 硬编码成 'user'
     * （dsh-api-session-controller/lib/index.js: "const source = { kind: \"user\", ... }"），
     * 而 SessionPromptRequest 没有 source 字段 —— 插件无法声明"这是我发的"。
     * 后果：其它插件（如 codegraph 的 prompt front-load）把 flow 的机器通知当成用户提问，
     * 白跑一遍索引检索再注入大段上下文。实测一个调度会话里 353 条 user 消息有 98 条是这种注入。
     *
     * 这里给 flow 自己发的消息打上 'plugin:dsh-flow'，下游按 source.kind 就能分出来。
     * 取不到活 Agent 时退回 prompt()（少一次标记，但不影响投递）。
     */
    async promptSession(sessionId, text, mode = 'queue', { origin = 'human', kind = 'notice' } = {}) {
      const { session } = this.services()
      const prompt = pick(session, ['prompt'])
      if (origin === 'system') chat.markSystem(sessionId, text)
      const content = [{ type: 'text', text }]
      // 只有 flow 自己发起的机器通知才改 source.kind。
      // origin==='human' 是人在调度台上打的字（chat.send 复用本函数）——
      // 那是货真价实的用户提问，必须保持 'user'：否则 codegraph 不会给人做检索，
      // 聊天界面也会把它折叠成"注入的上下文"而不是一个气泡。
      if (origin !== 'system') {
        if (!prompt) return { ok: false, message: '当前 profile 没有 sessionController，无法投递' }
        try {
          const controller = new AbortController()
          await prompt({ requestId: rid('flow'), sessionId, mode, content }, controller.signal)
          return { ok: true, via: 'prompt' }
        } catch (err) {
          return { ok: false, message: msgOf(err) }
        }
      }
      // 机器通知：先试自造 message，能给消息标上 flow 的 source.kind，
      // 下游插件（codegraph 等）就不会把它误判成用户提问。
      try {
        const agent = await this.agentOf(sessionId)
        if (agent && agent.inbox) {
          const message = Object.freeze({
            id: rid('flow-msg'),
            role: 'user',
            content,
            source: {
              kind: SOURCE_KIND,
              // form/summary 让界面把这类消息折叠成一行"注入的上下文"，
              // 而不是像用户粘贴了一大段那样铺开（与 DSH 原生注入一致）。
              form: kind,
              summary: String(text).replace(/\s+/g, ' ').trim().slice(0, 120),
            },
          })
          if (mode === 'steer') {
            if (typeof agent.steer !== 'function') throw new Error('agent 没有 steer，改走 sessionController.prompt')
            await agent.steer(message)
          } else if (typeof agent.followup === 'function') await agent.followup(message)
          else throw new Error('agent 没有 followup/steer')
          return { ok: true, via: 'agent', sourceKind: SOURCE_KIND }
        }
      } catch (err) {
        log('promptSession(agent path) failed, falling back to prompt(): ' + msgOf(err))
      }
      if (!prompt) return { ok: false, message: '当前 profile 没有 sessionController，无法投递' }
      try {
        // 签名是 prompt(request, signal)：少传 signal 会在 Host 侧抛 "reading 'throwIfAborted'"
        const controller = new AbortController()
        await prompt({ requestId: rid('flow'), sessionId, mode, content }, controller.signal)
        return { ok: true, via: 'prompt' }
      } catch (err) {
        return { ok: false, message: msgOf(err) }
      }
    },

    /**
     * 把会话标题改成身份名（human调度1 / auto工人2 …）。
     * 失败不算错：某些部署没挂 sessionTitle 服务，重命名会抛
     * "renaming is unavailable"；初始化要照常把会话建出来。
     */
    async renameSession(sessionId, title) {
      const sid = String(sessionId || '').trim()
      const text = String(title || '').trim()
      if (!sid || !text) return { ok: false, message: 'renameSession: sessionId/title 必填' }
      const { session } = this.services()
      const rename = pick(session, ['rename'])
      if (!rename) return { ok: false, message: '当前 profile 不支持重命名会话' }
      try {
        const res = await rename({ sessionId: sid, title: text })
        return { ok: true, sessionId: sid, title: (res && res.title) || text }
      } catch (err) {
        return { ok: false, message: '重命名失败：' + msgOf(err) }
      }
    },

    async cancelSession(sessionId) {
      const { session } = this.services()
      const cancel = pick(session, ['cancel'])
      if (!cancel) return { ok: false, message: '没有 sessionController' }
      try { await cancel({ sessionId }); return { ok: true } } catch (err) { return { ok: false, message: msgOf(err) } }
    },

    /** 取代理的活会话；没有就建一个。cwd 默认项目工作区，派工时会传任务 worktree。 */
    async ensureSession(agent, project, { cwd } = {}) {
      const rec = domain.latestSession(agent.id)
      const wantCwd = cwd || (project && project.workspacePath) || null
      // 工作区按路径重解析（id 会失效）：建会话要用对的 id，已有会话要能补挂进去
      const ws = await this.workspaceFor(project)
      if (rec && rec.sessionId) {
        // 总调度跟的是用户自己的聊天框：绝不因为 cwd 不同就归档重建
        if (agent.role === 'chief') return { ok: true, sessionId: rec.sessionId, created: false, bound: true }
        const sameDir = !!(wantCwd && rec.cwd && normPath(rec.cwd) === normPath(wantCwd))
        if (!wantCwd || !rec.cwd || sameDir) {
          // 目录已经对了，但会话可能**不在**工作区里（历史会话 / 工作区重建过）。
          // 不补挂的话，它就在侧栏「未分组」里，而看板显示这个工位一切正常。
          let attached = null
          if (ws) {
            const had = await this.sessionInWorkspace(project, rec.sessionId)
            if (had === false) attached = await this.attachToWorkspace(ws, rec.sessionId)
          }
          return { ok: true, sessionId: rec.sessionId, created: false, attached: attached ? !!attached.ok : null, attachMessage: attached && !attached.ok ? attached.message : null }
        }
        // 已绑会话但工作目录不对（例如换了 worktree）→ 重置一个
        const reset = await this.resetSession(project, agent.id, { cwd: wantCwd })
        if (reset.ok) return { ok: true, sessionId: reset.sessionId, created: true, reset: true }
        return { ok: true, sessionId: rec.sessionId, created: false, cwdMismatch: true }
      }
      const { session } = this.services()
      const create = pick(session, ['create'])
      if (!create) return { ok: false, message: '没有 sessionController，无法建会话' }
      try {
        const created = await create({
          ...sessionLocation(project, wantCwd, ws && ws.id),
          agentPreset: agent.preset || undefined,
        })
        // 走了 cwd 分支（没有工作区可用）时，会话不会自动进工作区——能挂就补挂一次。
        if (ws && !(sessionLocation(project, wantCwd, ws.id).workspaceId)) await this.attachToWorkspace(ws, created.sessionId)
        await domain.bindSession(agent.id, created.sessionId, { state: 'idle', cwd: wantCwd }, { role: 'system' })
        // 角色配了模型：建完会话立刻切过去（DSH 原生 selectModel，不换会话）。
        const selection = resolveModel(agent)
        if (selection) await this.applyModel(created.sessionId, selection)
        // 身份名写进会话标题：侧栏里一眼能认出「这是 human工人1，不是在跟用户聊天」。
        // 失败不影响会话本身，只在结果里带 renamed:false。
        const named = await this.renameSession(created.sessionId, agentLabel(agent))
        if (named.ok) await domain.setSessionTitle(agent.id, named.title || agentLabel(agent)).catch(() => null)
        return { ok: true, sessionId: created.sessionId, created: true, renamed: !!named.ok, renameMessage: named.ok ? null : named.message }
      } catch (err) {
        return { ok: false, message: '建会话失败：' + msgOf(err) }
      }
    },

    /**
     * 找项目对应的真实 DSH 工作区；顺手把失效的 project.workspaceId 自愈。
     *
     * 为什么需要它：项目的 workspaceId 是**建项目那一刻**解析出来的，之后
     * DSH 删工作区 / 重建工作区 / 从别处导入 project 行，id 都可能失效。
     * 失效之后不报错，只是静默降级：会话建在 cwd 上、进不了工作区，
     * 侧栏把它显示成「未分组」——用户看到的就是「初始化了但会话不在项目里」。
     */
    async workspaceFor(project) {
      const reg = resolveService(ctx, 'workspaceRegistry')
      const path = project && project.workspacePath
      if (!reg || !path) return null
      let ws = null
      const cur = project.workspaceId && typeof reg.get === 'function' ? reg.get(project.workspaceId) : null
      if (cur) return cur
      if (typeof reg.resolveByPath === 'function') {
        try { ws = await reg.resolveByPath(path) } catch { ws = null }
      }
      if (!ws && typeof reg.list === 'function') {
        try { ws = (reg.list() || []).find((w) => w && normPath(w.path) === normPath(path)) || null } catch { ws = null }
      }
      // 只有真的换了 id 才写回并打日志：project. 对象可能是调用方手里的旧快照
      // （store 里已经改了），拿旧快照比会打出「ws_1 → ws_1」这种假自愈。
      if (ws && project && ws.id) {
        const live = store.state.projects[project.id]
        const from = live ? live.workspaceId : project.workspaceId
        if (from !== ws.id) {
          await domain.setProjectWorkspace(project.id, ws.id).catch(() => null)
          log('project ' + project.id + ' workspaceId 自愈：' + (from || '(空)') + ' → ' + ws.id)
        }
      }
      return ws || null
    },

    /**
     * 把已有会话挂进项目工作区。attachSession 会重读会话头并校验 cwd，
     * cwd 与工作区路径不一致时会抛——那种会话本来就该被 reset 而不是 attach，
     * 所以这里把失败当结果返回，交给调用方决定。
     */
    async attachToWorkspace(ws, sessionId) {
      if (!ws || !sessionId) return { ok: false, message: 'attachToWorkspace: ws/sessionId 必填' }
      if (typeof ws.attachSession !== 'function') return { ok: false, message: '当前 profile 不支持 attachSession' }
      if ((ws.sessionIds || []).includes(sessionId)) return { ok: true, already: true }
      try {
        await ws.attachSession(sessionId)
      } catch (err) {
        return { ok: false, message: msgOf(err) }
      }
      // attachSession 对「记录里已有这个 id、但 header 索引里没有」的会话会直接早退，
      // 那种会话挂完仍然不在 ws.sessionIds 里——必须复查，否则界面还是看不到。
      if (!(ws.sessionIds || []).includes(sessionId)) {
        return { ok: false, message: '挂载后仍未出现在工作区成员里（会话 cwd 与工作区路径不一致）' }
      }
      return { ok: true }
    },

    /**
     * 把一个工位的历史会话收干净：归档 DSH 会话 + 本地记录标记 archived。
     *
     * 为什么需要「清理」而不只是「重建」：孤儿会话（cwd 在 worktree、或项目 workspaceId
     * 失效时建的会话）在 DSH 侧仍然存在，侧栏里挂着「未分组」。只重建的话它们会一直留在那儿，
     * 用户看到的就是「我没有这么多会话」。
     *
     * force=false 时不碰还在跑活的工位（activeRunId / 会话 state=active 且不属于该项目）。
     */
    async cleanSession(agentId, { force = false } = {}) {
      const agent = store.state.agents[agentId]
      if (!agent) return { ok: false, message: 'unknown agent: ' + agentId }
      const busy = Object.values(store.state.tasks).some((t) => t && t.assignee === agentId && t.activeRunId)
      if (busy && !force) return { ok: false, busy: true, message: '这个工位还有在跑的 run，先停掉或等它结束' }
      const recs = Object.values(store.state.agent_sessions).filter((r) => r.agentId === agentId && r.sessionId)
      const archivedIds = []
      const failures = []
      const archive = pick(this.services().workspace, ['archiveSession'])
      for (const rec of recs) {
        // 每条历史记录都归档：只标记最新一条的话，旧的孤儿会话会一直留在侧栏「未分组」里。
        if (archive) {
          try { await archive({ sessionId: rec.sessionId, stopActivity: !!force }) } catch (err) {
            failures.push({ sessionId: rec.sessionId, message: msgOf(err) })
            log('archiveSession failed ' + rec.sessionId + ': ' + msgOf(err))
          }
        }
        archivedIds.push(rec.sessionId)
        // 逐条标记：setSessionState 只改最新一条，历史记录要单独落 archived，
        // 否则 latestSession 还会捡回它们。
        await domain.markSessionArchived(rec.id, { role: 'system' }).catch(() => null)
      }
      return { ok: failures.length === 0, agentId, archived: archivedIds, failures }
    },

    /** 这个会话是不是项目工作区的成员（有工作区才判，没有就返回 null = 无从判断）。 */
    async sessionInWorkspace(project, sessionId) {
      const ws = await this.workspaceFor(project)
      if (!ws) return null
      return (ws.sessionIds || []).includes(sessionId)
    },

    /** DSH 里现存的工作区路径（工作区即项目：对账要用）。 */
    async listWorkspacePaths() {
      const reg = resolveService(ctx, 'workspaceRegistry')
      if (!reg || typeof reg.list !== 'function') return null
      try {
        const items = reg.list() || []
        return items.map((w) => w && w.path).filter(Boolean)
      } catch {
        return null
      }
    },

    /** 把已有会话切到指定模型（不换会话）；失败只记日志，不影响会话本身。 */
    async applyModel(sessionId, selection) {
      const sid = String(sessionId || '').trim()
      if (!sid || !selection || !selection.provider || !selection.model) {
        return { ok: false, message: 'applyModel: sessionId/provider/model 必填' }
      }
      const { session } = this.services()
      const select = pick(session, ['selectModel'])
      if (!select) return { ok: false, message: '当前 profile 不支持切换模型' }
      try {
        await select({
          sessionId: sid,
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort || undefined,
        })
        return { ok: true, sessionId: sid }
      } catch (err) {
        log('selectModel failed: ' + msgOf(err))
        return { ok: false, message: '切换模型失败：' + msgOf(err) }
      }
    },

    /** 改代理的模型选择：先落库，有活会话就立刻切过去。 */
    async selectAgentModel(agentId, input = {}) {
      const agent = store.state.agents[agentId]
      if (!agent) return { ok: false, message: 'unknown agent: ' + agentId }
      const provider = input.provider === undefined ? agent.provider || null : input.provider || null
      const model = input.model === undefined ? agent.model || null : input.model || null
      const reasoningEffort = input.reasoningEffort === undefined
        ? agent.reasoningEffort || null
        : input.reasoningEffort || null
      await domain.upsertAgent(
        agent.projectId,
        { id: agentId, provider, model, reasoningEffort },
        { role: 'human', id: 'web' },
      )
      const rec = domain.latestSession(agentId)
      let applied = { ok: false, message: '该代理还没有会话' }
      if (rec && rec.sessionId && provider && model) {
        applied = await this.applyModel(rec.sessionId, { provider, model, reasoningEffort })
      }
      return { ok: true, agentId, provider, model, reasoningEffort, applied }
    },

    // v1.37：measureBudget 已移除 —— DSH 宿主自己管理上下文压缩，不需要插件做双轨。
    // budget.get 和 flow_budget 工具也一并移除。


    /**
     * v1.37：读取项目下所有会话的 token 统计。
     * 只读，不压缩，不重建。返回 { uncachedInput, output, cacheRead, cacheWrite, cacheHitPct } 或 null。
     */
    async getSessionTokens(projectId) {
      // v0.016.3：20 秒结果缓存。调度台面板每 8 秒轮询一次 project.metrics，
      // 而这里每个会话都要 session.inspect + foldUsage 一遍（4.7M token 的会话线上实测 150ms），
      // 等于面板一开着服务器就每 8 秒白烧一次主线程。token 是累计值，
      // 20 秒的陈旧度对仪表盘完全没有影响（每分速率本来就是分钟级口径）。
      const cached = tokenStatsCache.get(projectId)
      if (cached && Date.now() - cached.at < TOKEN_STATS_TTL_MS) return cached.value
      const session = resolveService(ctx, 'sessionController')
      const projections = resolveService(ctx, 'sessionProjections')
      const sessions = resolveService(ctx, 'sessions')
      const canRead = !!(session && typeof session.inspect === 'function')
      const recs = Object.values(store.state.agent_sessions)
        .filter((r) => r && r.projectId === projectId && r.sessionId && r.state !== 'archived')
      const ids = [...new Set(recs.map((r) => r.sessionId))]
      const totals = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      let turns = 0
      let steps = 0
      let readOk = 0
      if (canRead) {
        for (const sid of ids) {
          try {
            // 累计用量来自事件流（同 DSH tokenUsage 投影口径）；turn/step 用事件里的去重计数。
            const info = await session.inspect(sid)
            const folded = foldUsage((info && info.events) || [])
            let tu = folded
            const live = sessions && typeof sessions.get === 'function' ? sessions.get(sid) : undefined
            if (live && projections && typeof projections.stateOf === 'function') {
              const p = totalsFromProjection(projections.stateOf(live, 'tokenUsage'))
              if (p) tu = p
            }
            totals.uncachedInput += tu.uncachedInput
            totals.output += tu.output
            totals.cacheRead += tu.cacheRead
            totals.cacheWrite += tu.cacheWrite
            turns += folded.turns
            steps += folded.steps
            readOk += 1
          } catch {}
        }
      }
      const tokenNow = totals.uncachedInput + totals.cacheRead + totals.output
      // v0.016.3：采样落盘从「每次调用」改成「每分钟最多一次」。
      // store.tx 会先把整份 state 深拷一份做回滚快照，再把 3MB 的热数据 pretty-print 落盘 ——
      // 原来面板每 8 秒轮询一次就等于每 8 秒做一次这样的全量重写（线上 3MB/次），
      // 主线程被占住，同一时刻进来的请求（包括打开面板本身）全在排队。
      // 速率本来就是「最新采样 vs ≥1 分钟前的采样」，所以分钟级采样完全够用。
      const prevSamples = (store.state.metrics && store.state.metrics[projectId] && Array.isArray(store.state.metrics[projectId].samples))
        ? store.state.metrics[projectId].samples
        : []
      const lastSampleAt = prevSamples.length ? Number(prevSamples[prevSamples.length - 1].at) || 0 : 0
      if (Date.now() - lastSampleAt >= 60 * 1000) {
        await store.tx((s) => {
          if (!s.metrics) s.metrics = {}
          const slot = s.metrics[projectId] || {}
          const samples = Array.isArray(slot.samples) ? slot.samples : []
          samples.push({ at: Date.now(), tokens: tokenNow, turns, steps })
          if (samples.length > 120) samples.splice(0, samples.length - 120)
          s.metrics[projectId] = { samples, startedAt: slot.startedAt || new Date().toISOString() }
        }).catch(() => null)
      }
      const slot = (store.state.metrics || {})[projectId] || {}
      // 速率：最新采样 vs 至少 1 分钟前的采样（不足 1 分钟取最早一条）
      let perMinTokens = null
      let perMinSteps = null
      const samples = Array.isArray(slot.samples) ? slot.samples : []
      if (samples.length >= 2) {
        const lastP = samples[samples.length - 1]
        let base = samples[0]
        for (let i = samples.length - 2; i >= 0; i -= 1) {
          if (lastP.at - samples[i].at >= 60000) { base = samples[i]; break }
        }
        const minutes = (lastP.at - base.at) / 60000
        if (minutes > 0) {
          perMinTokens = Math.max(0, Math.round((lastP.tokens - base.tokens) / minutes))
          perMinSteps = Math.max(0, Math.round(((lastP.steps || 0) - (base.steps || 0)) / minutes * 10) / 10)
        }
      }
      const totalInput = totals.uncachedInput + totals.cacheRead
      const hitPct = totalInput > 0 ? Math.round(totals.cacheRead / totalInput * 100) : null
      const result = {
        available: canRead,
        ...totals,
        cacheHitPct: hitPct,
        turns,
        steps,
        perMinTokens,
        perMinSteps,
        since: slot.startedAt || null,
        sessionsRead: readOk,
        sessionsTotal: ids.length,
      }
      tokenStatsCache.set(projectId, { at: Date.now(), value: result })
      return result
    },

    /**
     * 项目环境自检 + 配置补齐（v1.19）。
     *
     * 起因：baseBranch 写死 'main' 在 master 仓库上会把整个合并步骤打空（BiliNote T-012 就这么丢的），
     * remote 没配则 issue 车道永远是哑的，recordIssues 关着则一个 issue 工位都不建。
     * 这些全是能自动看出来的东西，不该让人手填一遍再踩一遍。
     *
     * 只补「缺失」或「证明是错的」：探测失败不猜（不动 recordIssues），人填对的值不动。
     */
    async setupProject(projectId, { dryRun = false } = {}) {
      const project = store.state.projects[projectId]
      if (!project) return { ok: false, message: 'unknown project: ' + projectId }
      const dir = project.workspacePath || null
      if (!dir) return { ok: false, message: '项目还没绑定工作区路径' }

      let detected = null
      try {
        detected = await detectSetup(dir)
      } catch (err) {
        return { ok: false, message: '环境自检失败：' + msgOf(err) }
      }

      const current = project.config || {}
      const plan = planSetup(current, detected)
      const applied = []
      if (!dryRun && plan.patch && Object.keys(plan.patch).length) {
        try {
          await domain.updateProjectConfig(projectId, plan.patch, { role: 'system', id: 'setup' })
          for (const k of Object.keys(plan.patch)) applied.push(k)
        } catch (err) {
          return { ok: false, message: '写配置失败：' + msgOf(err), detected, plan }
        }
      }

      // issue 车道：recordIssues 一开就该有工位，否则「开了记录却没有接单的人」。
      let lanes = null
      const nowRecord = dryRun
        ? !!(plan.patch && plan.patch.recordIssues) || !!current.recordIssues
        : !!(store.state.projects[projectId] || {}).config?.recordIssues
      if (nowRecord && !dryRun) {
        try { lanes = await domain.ensureLaneAgents(projectId, 'issue', { dispatchers: 1, workers: 2 }, { role: 'system', id: 'setup' }) }
        catch (err) { lanes = { ok: false, message: msgOf(err) } }
      }

      // 远端 issue 立刻拉一次，让车道里马上有东西可看；失败只记一笔，下次 tick 再试。
      //
      // v1.22：「配置之后出现的卡才同步」这条要求靠 `sync.since` 实现，所以配置成功的
      // 当下就要把 since 定下来（armProjectSync 是幂等的，只写一次），再让引擎立刻跑一轮——
      // 引擎自己会带 force，跳过 60s 节流。
      let synced = null
      if (!dryRun && nowRecord) {
        const live = store.state.projects[projectId]
        if (live && live.config && live.config.remote) {
          try {
            await domain.armProjectSync(projectId, { role: 'system', id: 'setup' })
            synced = syncEngine
              ? await syncEngine.runProject(store.state.projects[projectId], { force: true })
              : await syncProject({ domain, project: live })
          } catch (err) { synced = { ok: false, reason: msgOf(err) } }
        }
      }

      if (applied.length) log('project ' + projectId + ' 环境自检写入：' + applied.join(','))
      return {
        ok: true,
        projectId,
        workspacePath: dir,
        git: detected && detected.git ? detected.git : null,
        isRepo: !!(detected && detected.isRepo),
        branches: (detected && detected.branches) || null,
        remote: (detected && detected.remote) || null,
        upstream: (detected && detected.upstream) || null,
        notes: [].concat((detected && detected.notes) || [], plan.notes || []),
        applied,
        patch: plan.patch,
        lanes,
        synced,
      }
    },

    /**
     * 「初始化仓库」：一次性把项目里**该有的工位会话**全部备齐并标上身份名。
     *
     * 做三件事（幂等）：
     *   1. 没有会话的工位建一个（cwd = 项目工作区，会话直接落在当前工作区）；
     *   2. 有会话的也把标题改成身份名（human调度1 / auto工人2 …）；
     *   3. 顺手把 cwd 不在项目工作区的老会话收敛回工作区（只在不忙时动，免得打断在跑的工人）。
     *
     * v1.40：**不补工位池**。工位只在项目第一次落库时初始化一次（lib/domain.js ensureProject
     * 的新建分支）；之后要加回被删的工位走显式的 agents.ensure。
     *
     * 主调度（chief）不参与：那是用户自己的聊天框，不该被改名或搬家。
     */
    async ensureProjectSessions(projectId, { setup = true } = {}) {
      const project = store.state.projects[projectId]
      if (!project) return { ok: false, message: 'unknown project: ' + projectId }
      // 先做环境自检：基础分支/远程/issue 开关没配好，后面建的 issue 工位就是空转的。
      // setup 失败不阻断建会话——配置问题不该让人连工位都备不齐。
      let setupResult = null
      if (setup) {
        try { setupResult = await this.setupProject(projectId) }
        catch (err) { setupResult = { ok: false, message: msgOf(err) } }
      }
      const rank = { chief: 0, dispatcher: 1, griller: 2, worker: 3 }
      const root = project.workspacePath || null

      // v1.40：不再在这里补齐工位池。工位只在项目首次建立时初始化一次；
      // 删除 / 调整过工位的项目，点「初始化仓库」只帮**已存在**的工位备会话，
      // 不会把删掉的工位复活（要加回来走设置页的显式操作）。
      const ensured = null

      // v1.0：主调度不单独建会话——它就是用户自己的默认聊天区，这里只给 dispatcher/worker 备会话
      // v1.39：griller（需求评审）也要会话 —— 它是被投递消息的一方，没有会话就永远评审不了
      const agents = Object.values(store.state.agents)
        .filter((a) => a.projectId === projectId && a.enabled !== false && a.role !== 'chief')
        .sort((x, y) => (rank[x.role] ?? 9) - (rank[y.role] ?? 9) || String(x.id).localeCompare(String(y.id)))

      const created = []
      const existing = []
      const renamed = []
      const moved = []
      const attached = []
      const failed = []
      // 工作区按路径重解析一次（id 失效会导致新会话直接落到「未分组」）
      const ws = await this.workspaceFor(project)

      for (const agent of agents) {
        const label = agentLabel(agent)
        const rec = domain.latestSession(agent.id)
        const busy = Object.values(store.state.tasks).some((t) => t && t.assignee === agent.id && t.activeRunId)

        if (rec && rec.sessionId) {
          // 2) 老会话：标题改成身份名（幂等——已经是这个名字就跳过）
          const entry = { agentId: agent.id, role: agent.role, lane: agent.lane || 'human', name: label, sessionId: rec.sessionId }
          if (String(rec.title || '') !== label) {
            const rn = await this.renameSession(rec.sessionId, label)
            if (rn.ok) {
              entry.renamed = true
              renamed.push(entry)
              await domain.setSessionTitle(agent.id, rn.title || label).catch(() => null)
            } else {
              entry.renameMessage = rn.message
              // 老会话可能还引用着本构建已经移除的 preset（实测 `Unknown agent preset: router-standard`）。
              // 这种会话改名要 resume，而 resume 会校验 preset ⇒ 改不动也挂不上，只能重建。
              // 不把它算成「失败」会让人一直点「初始化」都看不到任何变化。
              if (/unknown agent preset/i.test(String(rn.message || ''))) {
                failed.push({ agentId: agent.id, name: label, message: '旧会话引用了已移除的 preset，改不动也挂不上——用「清理并重建会话」重建一个' })
              }
            }
          }
          // 3) cwd 漂在外面（历史 worktree 会话）→ 收敛回项目工作区。忙的时候不动。
          if (root && rec.cwd && normPath(rec.cwd) !== normPath(root) && !busy) {
            const reset = await this.resetSession(project, agent.id, { cwd: root })
            if (reset.ok) {
              entry.sessionId = reset.sessionId
              entry.movedFrom = rec.cwd
              moved.push(entry)
              const rn2 = await this.renameSession(reset.sessionId, label).catch(() => null)
              if (rn2 && rn2.ok) await domain.setSessionTitle(agent.id, rn2.title || label).catch(() => null)
              continue
            }
            entry.moveMessage = reset.message
          }
          // 4) 目录对了、但会话不在工作区成员里（历史会话 / 工作区重建过 / 上一次初始化中途失败）
          //    → 直接补挂。这是「初始化了，会话却不在项目里」的正解：能挂就不重建，
          //      重建会丢掉会话历史。忙的时候也安全：attach 不动会话内容。
          let attachedHere = null
          if (ws && !busy) {
            const had = (ws.sessionIds || []).includes(rec.sessionId)
            if (!had) {
              attachedHere = await this.attachToWorkspace(ws, rec.sessionId)
              if (attachedHere.ok) {
                entry.attached = true
                attached.push(entry)
              } else {
                entry.attachMessage = attachedHere.message
                failed.push({ agentId: agent.id, name: label, message: '挂进工作区失败：' + attachedHere.message })
              }
            }
          }
          existing.push(entry)
          continue
        }

        // 4) 没有会话 → 建一个（cwd = 项目工作区）
        const res = await this.ensureSession(agent, project)
        if (res && res.ok && res.sessionId) {
          if (res.renamed) await domain.setSessionTitle(agent.id, label).catch(() => null)
          created.push({ agentId: agent.id, role: agent.role, lane: agent.lane || 'human', name: label, sessionId: res.sessionId, renamed: !!res.renamed, renameMessage: res.renameMessage || null })
        } else {
          failed.push({ agentId: agent.id, name: label, message: (res && res.message) || '建会话失败' })
        }
      }

      const parts = [
        '新增 ' + created.length,
        '已存在 ' + existing.length,
        '改名 ' + renamed.length,
        '收回工作区 ' + moved.length,
        '补挂工作区 ' + attached.length,
        '失败 ' + failed.length,
      ]
      const message = '会话：' + parts.join('，')
      const setupNotes = (setupResult && Array.isArray(setupResult.notes)) ? setupResult.notes : []
      return {
        ok: failed.length === 0,
        projectId,
        workspacePath: root,
        workspaceId: ws ? ws.id : null,
        agentCount: agents.length,
        created, existing, renamed, moved, attached, failed,
        ensured: ensured ? ensured.length : null,
        setup: setupResult,
        setupNotes,
        message,
      }
    },

    /** 取一个 sessionId 对应的活 Agent（goal 服务要求活 Agent 对象）。 */
    async agentOf(sessionId) {
      const { session } = this.services()
      const resolve = pick(session, ['resolveAgent'])
      if (!resolve) return null
      try {
        const result = await resolve(sessionId)
        return (result && result.agent) || null
      } catch { return null }
    },

/** 列出 DSH 里可见的会话（给「总调度接会话」用）。 */
    async listSessions() {
      const { session } = this.services()
      const list = pick(session, ['list'])
      if (!list) return []
      try {
        const res = await list({})
        const items = (res && res.items) || []
        // 每个代理只有最后绑的那个会话算“已接”，否则重绑后旧会话还挂着标记
        const latest = {}
        for (const rec of Object.values(store.state.agent_sessions)) {
          if (!rec || !rec.sessionId) continue
          latest[rec.agentId] = rec.sessionId
        }
        const bySession = {}
        for (const [agentId, sid] of Object.entries(latest)) bySession[sid] = agentId
        return items.map((it) => {
          const values = (it.projections && it.projections.values) || {}
          const sel = values.modelSelection || {}
          const used = sel.lastUsed || sel.next || null
          return {
            sessionId: it.sessionId,
            cwd: it.cwd || null,
            updatedAt: it.updatedAt || null,
            running: it.running === true,
            blank: it.blank === true,
            preset: it.agentPreset || null,
            model: used ? used.model || null : null,
            provider: used ? used.provider || null : null,
            boundAgentId: bySession[it.sessionId] || null,
          }
        })
      } catch (err) {
        log('listSessions failed: ' + msgOf(err))
        return []
      }
    },

    /**
     * v1.0：把「当前会话」认作该项目的主调度（不再新建专属聊天窗）。
     * @returns { ok, projectId, sessionId, agentId }
     */
    async bindChiefSession(projectId, sessionId, opts = {}) {
      try {
        const rec = await domain.bindChiefSession(projectId, sessionId, { cwd: opts.cwd || null }, { role: 'human', id: 'web' })
        return { ok: true, projectId, sessionId, agentId: rec.agentId, record: rec.id }
      } catch (err) {
        return { ok: false, message: msgOf(err) }
      }
    },

    /**
     * 把某个代理接到一个已有 DSH 会话。
     * 总调度专用：接上之后命令、skill、模型都跟着那个聊天框，我们不再建新会话。
     */
    async bindAgentSession(agentId, sessionId) {
      const agent = store.state.agents[agentId]
      if (!agent) return { ok: false, message: 'unknown agent: ' + agentId }
      const sid = String(sessionId || '').trim()
      if (!sid) return { ok: false, message: 'sessionId 必填' }
      const owner = Object.values(store.state.agents).find((other) => {
        if (other.id === agentId) return false
        const rec = domain.latestSession(other.id)
        return rec && rec.sessionId === sid
      })
      if (owner) return { ok: false, message: '该 DSH 会话已属于代理：' + owner.name }
      const { session } = this.services()
      let cwd = null
      try {
        const inspect = pick(session, ['inspect'])
        if (inspect) {
          const info = await inspect(sid)
          cwd = (info && info.meta && info.meta.cwd) || (info && info.cwd) || null
        }
      } catch (err) {
        log('bindAgentSession: inspect failed: ' + msgOf(err))
      }
      const rec = await domain.bindSession(agentId, sid, { state: 'idle', cwd }, { role: 'human', id: 'web' })
      return { ok: true, agentId, sessionId: sid, cwd, record: rec.id }
    },

    /**
     * agentId → 这个代理的 DSH 会话（没有就建一个）。
     * 工作台侧栏拿到 sessionId 后，用 /?flowSession=<id>&flowEmbed=1 直接渲染 DSH 原生会话界面。
     */
    async agentSession(agentId) {
      const agent = store.state.agents[agentId]
      if (!agent) return { ok: false, message: 'unknown agent: ' + agentId }
      const project = store.state.projects[agent.projectId]
      // 已有会话可能在任务 worktree；聊天入口必须复用，不能按项目根目录触发 reset。
      const existing = domain.latestSession(agentId)
      const ens = existing && existing.sessionId
        ? { ok: true, sessionId: existing.sessionId }
        : await this.ensureSession(agent, project)
      if (!ens.ok) return ens
      const rec = domain.latestSession(agentId)
      return {
        ok: true,
        agentId,
        role: agent.role,
        name: agent.name,
        sessionId: ens.sessionId,
        cwd: (rec && rec.cwd) || (project && project.workspacePath) || null,
        projectId: agent.projectId,
      }
    },

    /** 在当前会话上执行一条 /命令（/goal、/compact、/feedback…），和 DSH 聊天框走同一条命令通道。 */
    async runCommand(agentId, line) {
      const rec = domain.latestSession(agentId)
      if (!rec || !rec.sessionId) return { ok: false, message: '该代理还没有会话' }
      const { commands } = this.services()
      const exec = pick(commands, ['execute'])
      if (!exec) return { ok: false, message: '当前 profile 没有 commands 服务，无法执行斜杠命令' }
      const agent = await this.agentOf(rec.sessionId)
      if (!agent) return { ok: false, message: '会话不是活 Agent（可能已归档）' }
      try {
        const out = await exec(agent, String(line || '').trim(), [], new AbortController().signal)
        if (!out) return { ok: false, message: '没有这个命令：' + String(line || '').trim().split(/\s+/)[0] }
        return { ok: true, sessionId: rec.sessionId, commandId: out.commandId, kind: out.result.kind, text: out.result.text || '' }
      } catch (err) {
        return { ok: false, message: '命令执行失败：' + msgOf(err) }
      }
    },

    /** 列出当前会话可用的斜杠命令（面板做提示用）。 */
    async listCommands(agentId) {
      const rec = domain.latestSession(agentId)
      if (!rec || !rec.sessionId) return []
      const { commands } = this.services()
      const list = pick(commands, ['list'])
      if (!list) return []
      const agent = await this.agentOf(rec.sessionId)
      if (!agent) return []
      try {
        return list(agent).map((d) => ({ name: d.name, description: d.description || '', usage: d.usage || '' }))
      } catch {
        return []
      }
    },

    /**
     * v1.39：清掉工位会话上残留的 goal（v1.38 以前派工会建 goal，旧会话会继续自己续跑）。
     * 没有 goals 服务 / 没有活 Agent / 没有 goal 都算成功：目的只是"别再有 goal"。
     */
    async clearWorkerGoal(agentId) {
      const { goals } = this.services()
      if (!goals || typeof goals.get !== 'function' || typeof goals.clear !== 'function') return { ok: true, skipped: 'no-goals-service' }
      const rec = domain.latestSession(agentId)
      if (!rec || !rec.sessionId) return { ok: true, skipped: 'no-session' }
      try {
        const agent = await this.agentOf(rec.sessionId)
        if (!agent) return { ok: true, skipped: 'no-live-agent' }
        const cur = goals.get(agent)
        if (!cur) return { ok: true, cleared: false }
        await goals.clear(agent, { id: cur.id, revision: cur.revision })
        return { ok: true, cleared: true }
      } catch (err) {
        return { ok: false, message: '清 goal 失败：' + msgOf(err) }
      }
    },

    /** 给工人的真实会话建 goal（先清旧的）。v1.39 起调度流程不再调用，只保留给人手动使用。 */
    async workerGoal(_project, { agentId, objective, clear = true, maxGoalRounds }) {
      const { goals } = this.services()
      const rec = domain.latestSession(agentId)
      if (!rec || !rec.sessionId) return { ok: false, message: '该代理还没有绑定会话' }
      if (!goals) return { ok: false, message: '当前 profile 没有 goals 服务' }
      const agent = await this.agentOf(rec.sessionId)
      if (!agent) return { ok: false, message: '会话不是活 Agent（可能已归档）' }
      try {
        if (clear && typeof goals.get === 'function') {
          const cur = goals.get(agent)
          if (cur) await goals.clear(agent, { id: cur.id, revision: cur.revision })
        }
        const view = await goals.create(agent, {
          objective: String(objective || '').slice(0, 4000),
          maxGoalRounds: Number.isFinite(maxGoalRounds) && maxGoalRounds > 0 ? maxGoalRounds : undefined,
        })
        return { ok: true, goal: view, sessionId: rec.sessionId }
      } catch (err) {
        return { ok: false, message: '建 goal 失败：' + msgOf(err) }
      }
    },

    /** 调度员给工人插话（steer，不打断当前回合）。 */
    async steer(_project, { agentId, message }) {
      const rec = domain.latestSession(agentId)
      if (!rec || !rec.sessionId) return { ok: false, message: '该代理还没有会话' }
      const r = await this.promptSession(rec.sessionId, String(message || ''), 'steer', { origin: 'system' })
      domain.logMessage({ sessionId: rec.sessionId, agentId, direction: 'out', origin: 'system', kind: 'steer', ok: !!r.ok })
      return r.ok ? { ok: true, message: '已插话给 ' + agentId } : r
    },

    /** 重置事务：归档旧会话（stopActivity）→ 建新会话 → 绑定 → 投案卷。 */
    async resetSession(project, agentId, { cwd } = {}) {
      const { session, workspace } = this.services()
      const create = pick(session, ['create'])
      const archive = pick(workspace, ['archiveSession'])
      if (!create) return { ok: false, message: '没有 sessionController，无法新建会话' }
      const rec = domain.latestSession(agentId)
      const agent = store.state.agents[agentId]
      const proj = project || (agent && store.state.projects[agent.projectId])
      try {
        if (rec && rec.sessionId && archive) await archive({ sessionId: rec.sessionId, stopActivity: true })
        if (rec && rec.sessionId) await domain.setSessionState(agentId, 'archived', { role: 'system' })
        // cwd 统一落项目工作区：会话要出现在当前工作区里（DSH 按 cwd 归组），
        // 任务隔离由 worktree + 案卷里的绝对路径负责，不靠会话 cwd。
        const nextCwd = cwd || (proj && proj.workspacePath) || null
        const ws = proj ? await this.workspaceFor(proj) : null
        const created = await create({
          ...sessionLocation(proj, nextCwd, ws && ws.id),
          agentPreset: agent && agent.preset || undefined,
        })
        if (ws && !sessionLocation(proj, nextCwd, ws.id).workspaceId) await this.attachToWorkspace(ws, created.sessionId)
        await domain.bindSession(agentId, created.sessionId, { state: 'idle', cwd: nextCwd || null }, { role: 'system' })
        // v1.37：重建后立刻把工位配置的模型切过去，否则新会话会用 DSH 全局当前模型
        if (agent) {
          const sel = resolveModel(agent)
          if (sel) await this.applyModel(created.sessionId, sel).catch((err) => log('resetSession applyModel failed: ' + msgOf(err)))
        }
        // v1.38：重建的会话也要立刻起身份名。DSH 只在「首条提示且还没有标题」时自动起名，
        // 不在投递案卷前改名，新会话就会被命名成案卷第一段（【最高优先级…】/【案卷 T-xx】）。
        let renamedTitle = null
        if (agent) {
          const label = agentLabel(agent)
          const named = await this.renameSession(created.sessionId, label).catch(() => null)
          if (named && named.ok) {
            renamedTitle = named.title || label
            await domain.setSessionTitle(agentId, renamedTitle).catch(() => null)
          } else if (named) log('resetSession rename failed: ' + named.message)
        }
        return { ok: true, sessionId: created.sessionId, archived: rec ? rec.sessionId : null, title: renamedTitle }
      } catch (err) {
        return { ok: false, message: '重置失败：' + msgOf(err) }
      }
    },
  }

  const domain = new FlowDomain(store, runtime)

  // ---- 派工与巡检（设计文档 5.13 / 5.14） -----------------------------------
  const dispatcher = createDispatcher({ domain, runtime, store, log })

/**
 * v1.22 同步引擎（在 dispatcher 之后创建：入站评论要能叫调度员）。
 *
 * 声明成外层 let 是因为 `setupProject`（定义在上面的 return 对象里）也要用它首跑一次，
 * 而那个定义在 createSyncEngine 之前——直接引用会撞 TDZ。
 */
let syncEngine = null
  runtime.onMoved = dispatcher.onMoved
  runtime.onStopped = dispatcher.onStopped

  // 事件驱动：把"调度员该知道"的事务事件变成插话（评论/阻塞/失败/冲突/巡检结论…）。
  // 订阅的是 domain 事件流（outbox pump 出队时广播），所以事件都是**已提交**的状态。
  try {
    ctx.effect(() => {
      const off = dispatcher.watchEvents()
      return () => { try { off() } catch { /* 已退订 */ } }
    }, 'dsh-flow: watch supervisor events')
    log('supervisor event watch mounted')
  } catch (err) {
    log('supervisor event watch skipped: ' + msgOf(err))
  }

  const registry = () => resolveService(ctx, 'workspaceRegistry')
  const listProjects = () => Object.values(store.state.projects)

  /**
   * 已有工作区清单（DSH workspaceRegistry）。
   * 新建项目从这份清单里选，不用手输路径；已绑过项目的标出 projectId。
   */
  const listWorkspaces = () => {
    const reg = registry()
    if (!reg || typeof reg.list !== 'function') return []
    try {
      return reg.list().map((w) => {
        const path = w.path || ''
        const bound = Object.values(store.state.projects).find((p) => p.workspacePath === path)
        return {
          id: String(w.id || ''),
          title: w.title || path.split(/[\\/]/).pop() || path,
          path,
          sessions: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
          updatedAt: w.updatedAt || null,
          projectId: bound ? bound.id : null,
        }
      })
    } catch (err) {
      log('listWorkspaces failed: ' + msgOf(err))
      return []
    }
  }

  const ensureProject = async ({ workspacePath, name, workspaceId }) => {
    if (!workspacePath) throw new Error('workspacePath 必填')
    const reg = registry()
    let wsId = workspaceId || null
    if (!wsId && reg && typeof reg.resolveByPath === 'function') {
      try { const ws = await reg.resolveByPath(workspacePath); if (ws) wsId = ws.id } catch { /* 未注册也允许 */ }
    }
    // 建项目那一刻的默认模型，冻结到项目上。
    // 不这么做的话，工位模型留空，界面只能显示"沿用默认"，
    // 而"默认"是全局当前选择 —— 换个对话就变，看起来像配置串台。
    let modelDefaults = null
    try {
      const cat = await catalog()
      const d = cat && cat.catalog && cat.catalog.default
      if (d && d.provider && d.model) modelDefaults = { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort || null }
    } catch { modelDefaults = null }
    return domain.ensureProject({ workspacePath, name, workspaceId: wsId, modelDefaults })
  }

  /** 归一化路径用于前缀比较（反斜杠、结尾斜杠、大小写）。 */
  const normCwd = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  /** 该路径是否位于某个项目的 worktree 根下（.flow-worktrees/<repo>/<task>）。 */
  const isWorktreePath = (cwd) => /\/\.flow-worktrees\//.test(normCwd(cwd) + '/')

  const resolveProject = async (exec) => {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
    if (!cwd) return null
    const target = normCwd(cwd)
    // 最长前缀优先：worktree 目录会同时前缀匹配仓库根，必须选最具体的那个
    const hit = Object.values(store.state.projects)
      .filter((p) => p.workspacePath)
      .sort((a, b) => normCwd(b.workspacePath).length - normCwd(a.workspacePath).length)
      .find((p) => {
        const root = normCwd(p.workspacePath)
        return target === root || target.startsWith(root + '/')
      })
    if (hit) return hit
    // worktree 目录（在仓库外面）→ 先反查它所属的仓库项目，别建新项目
    const viaWorktree = projectFromWorktreePath(cwd)
    if (viaWorktree) return viaWorktree
    // 还是不认识、但落在 .flow-worktrees 下 → 拒绝（不能把 worktree 建成项目）
    if (isWorktreePath(cwd)) return null
    return ensureProject({ workspacePath: cwd })
  }
  const resolveProjectById = (id) => store.state.projects[id]

  /**
   * 会话的 cwd。三层来源，从快到慢：
   *
   * 1. `sessionController.inspect(sessionId, signal?)`
   *    真实实现：dsh-api-session-controller/lib/index.js:2939
   *    `inspect(sessionId, signal) { ... return { meta: attached.header, ... } }`
   *    → 第一个参数是 **id 字符串**，传对象会静默拿不到 cwd（线上踩过）。
   *
   * 2. `sessionPersistence.stat(id)`
   *    真实实现：dsh-session-persistence-jsonl/lib/index.js:2536
   *    `return { header, revision, sizeBytes }`，header 就是 SessionHeader（含 cwd）。
   *    这层不依赖 sessionController 的方法签名，签名再变也还能拿到。
   *
   * 3. `agent_sessions` 里记过 cwd 的绑定记录（只认未归档的）。
   *
   * 三道都拿不到才返回 null —— 宁可明确失败，也不瞎猜一个项目。
   *
   * v0.016.3：结果按 sessionId 缓存，因为这条路径就是"打开调度台要等好几秒"的来源。
   * inspect 对**不在内存里的**会话要把整份会话文件读出来才能拿到 header：线上实测
   * 冷会话 0.12s，最大的那个 7.26s；而调度台每次挂载都打一次 /api/flow/session-project，
   * 面板开着还每 8 秒轮询一次 —— 于是每次打开/刷新都被这条 inspect 拖住，看到一块白屏。
   * 会话的 cwd 在创建时就固定了、之后不会变，所以记住它是安全的：
   *   · 命中（拿到 cwd）：缓存 30 分钟后复查一次（目录被搬走这种极端情况仍能纠正）；
   *   · 没命中（新会话还没落盘）：只缓存 15 秒，别把同一条慢路径反复踩。
   */
  const cwdCache = new Map()
  const CWD_HIT_MS = 30 * 60 * 1000
  const CWD_MISS_MS = 15 * 1000

  const sessionCwd = async (sessionId) => {
    const sid = String(sessionId || '').trim()
    if (!sid) return null
    const cached = cwdCache.get(sid)
    if (cached && Date.now() - cached.at < (cached.cwd ? CWD_HIT_MS : CWD_MISS_MS)) return cached.cwd
    const remember = (cwd) => {
      cwdCache.set(sid, { cwd: cwd || null, at: Date.now() })
      return cwd || null
    }
    const session = resolveService(ctx, 'sessionController')
    const inspect = session && typeof session.inspect === 'function' ? session.inspect.bind(session) : null
    if (inspect) {
      try {
        const info = await inspect(sid)
        const cwd = (info && info.meta && info.meta.cwd) || (info && info.cwd) || null
        if (cwd) return remember(cwd)
      } catch { /* 未落盘的新会话查不到，走下面的回落 */ }
    }
    // 第三层兜底：直接读持久化层的会话头（不依赖 sessionController 的方法签名）。
    // 线上就出现过 "inspect 签名不对 → 静默拿不到 cwd → 解析不出工作区"，
    // 多这一层可以让解析不至于因为一个 API 形状变化就整体失效。
    const persistence = resolveService(ctx, 'sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      try {
        const snap = await persistence.stat(sid)
        const cwd = snap && snap.header && snap.header.cwd
        if (cwd) return remember(cwd)
      } catch { /* 没有持久化记录也正常 */ }
    }
    const rec = Object.values(store.state.agent_sessions || {})
      .filter((r) => r && r.sessionId === sid && r.cwd && r.state !== 'archived')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
    return remember((rec && rec.cwd) || null)
  }

  /**
   * 调度模式诊断：算出"进 /flow 会 deny 哪些工具"，但**不真的 restrict**。
   *
   * 为什么需要它：线上验证 restrict 逻辑只能靠真的敲 /flow，而那是破坏性的
   * （当前会话的写工具会被收走）。这个只读探针拿同一个 agent 的 scoped tools
   * 算出同一份 deny 计划，能证明"交集逻辑生效了"，且什么都不改。
   */
  const diagFlowPlan = async (sessionId) => {
    const sid = String(sessionId || '').trim()
    if (!sid) return { ok: false, error: 'sessionId required' }
    const agents = resolveService(ctx, 'agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(sid) : null
    if (!agent || !agent.ctx) {
      return { ok: false, error: '会话当前没有活跃 agent（只有活跃会话才有 scoped tools）', sessionId: sid }
    }
    try {
      const plan = describeDenyPlan(agent.ctx.tools, agent.id || sid)
      return { ok: true, sessionId: sid, ...plan, mode: flowMode.isActive(sid) }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  /**
   * v1.40：显式补齐工位池（**人工**动作，不在任何自动路径里调用）。
   *
   * 自动补齐已经全部取消：工位只在项目第一次落库时初始化一次。之后要加回
   * 被删掉的工位、或按调大的配置补新槽位，走这里——设置页「创建需求讨论工位」
   * 与车道配置的显式动作都落到这一个入口。
   */
  const ensureAgents = async (projectId, { sessions = false } = {}) => {
    const project = store.state.projects[projectId]
    if (!project) return { ok: false, message: 'unknown project: ' + projectId }
    let created = []
    try { created = await domain.ensureAgents(projectId, { role: 'human', id: 'web' }) } catch (err) {
      return { ok: false, message: '补齐工位失败：' + msgOf(err) }
    }
    const out = { ok: true, created, agentCount: created.length }
    if (sessions && created.length) {
      const ensured = await this.ensureProjectSessions(projectId, { setup: false }).catch((err) => ({ ok: false, message: msgOf(err) }))
      out.init = ensured
    }
    return out
  }

  /**
   * cwd 诊断：把每个来源单独试一遍，返回谁给了什么。
   * 线上排查"解析不出工作区"时用这个，比 only-error 的 session-project 有信息量得多。
   */
  const diagSessionCwd = async (sessionId) => {
    const sid = String(sessionId || '').trim()
    if (!sid) return { ok: false, error: 'sessionId required' }
    const out = { sessionId: sid, inspect: null, persistence: null, agentSession: null }
    const session = resolveService(ctx, 'sessionController')
    if (session && typeof session.inspect === 'function') {
      try {
        const info = await session.inspect(sid)
        out.inspect = {
          ok: true,
          cwd: (info && info.meta && info.meta.cwd) || (info && info.cwd) || null,
          keys: info ? Object.keys(info).slice(0, 6) : null,
          metaKeys: info && info.meta ? Object.keys(info.meta).slice(0, 8) : null,
        }
      } catch (err) {
        out.inspect = { ok: false, error: String((err && err.message) || err) }
      }
    } else {
      out.inspect = { ok: false, error: 'no sessionController.inspect' }
    }
    const persistence = resolveService(ctx, 'sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      try {
        const snap = await persistence.stat(sid)
        out.persistence = { ok: true, cwd: (snap && snap.header && snap.header.cwd) || null, found: !!snap }
      } catch (err) {
        out.persistence = { ok: false, error: String((err && err.message) || err) }
      }
    } else {
      out.persistence = { ok: false, error: 'no sessionPersistence.stat' }
    }
    const rec = Object.values(store.state.agent_sessions || {})
      .filter((r) => r && r.sessionId === sid)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
    out.agentSession = rec ? { ok: true, cwd: rec.cwd || null, state: rec.state || null, agentId: rec.agentId } : { ok: false, error: 'no record' }
    return {
      ok: true,
      sessionId: sid,
      resolvedCwd: await sessionCwd(sid),
      sources: out,
    }
  }

  /**
   * worktree 目录 → 所属仓库项目。
   *
   * worktree 放在仓库**外面**：`<parent>/.flow-worktrees/<repo>/<taskId>`
   * （见 lib/dispatch.js worktreePathFor：这样不会弄脏 git status）。
   * 所以 worktree 里的会话不能按"cwd 前缀"归到仓库——要把前半段换成仓库名再精确匹配。
   */
  const projectFromWorktreePath = (cwd) => {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
    const target = norm(cwd)
    const m = /^(.*)\/\.flow-worktrees\/([^/]+)(\/|$)/.exec(target)
    if (!m) return null
    const parent = m[1]
    const repo = m[2]
    const repoPath = parent + '/' + repo
    const want = repoPath.toLowerCase()
    return Object.values(store.state.projects)
      .filter((p) => p.workspacePath)
      .find((p) => norm(p.workspacePath).toLowerCase() === want) || null
  }

  /**
   * v1.4：工作区即项目。会话 → 工作区（按 cwd）→ 项目（没有就建）。
   *
   * 不再看 chiefSessionId：**同一工作区里的任何对话都能进调度模式**，
   * 项目和工作区天生一一对应，不需要"先绑定主调度"，也就不会出现
   * "点开工作区里的对话，调度台却显示别的项目"这种错位。
   */
  const resolveSessionProject = async (sessionId, explicitCwd = null) => {
    const sid = String(sessionId || '').trim()
    if (!sid) return { ok: false, error: 'sessionId required' }
    const cwd = explicitCwd || await sessionCwd(sid)
    if (!cwd) return { ok: false, error: 'cannot resolve session cwd', sessionId: sid, cwd: null }
    const target = normCwd(cwd)

    // 0) worktree 目录（在仓库外面）→ 反查所属仓库项目
    const viaWorktree = projectFromWorktreePath(cwd)
    if (viaWorktree) {
      return { ok: true, matchedBy: 'worktree', projectId: viaWorktree.id, projectName: viaWorktree.name, cwd }
    }

    // 1) 按 cwd 找已存在的项目（最长前缀）
    const hit = Object.values(store.state.projects)
      .filter((p) => p.workspacePath)
      .sort((a, b) => normCwd(b.workspacePath).length - normCwd(a.workspacePath).length)
      .find((p) => {
        const root = normCwd(p.workspacePath)
        return target === root || target.startsWith(root + '/')
      })
    if (hit) return { ok: true, matchedBy: 'workspace', projectId: hit.id, projectName: hit.name, cwd }

    // 2) 工作区里还没有项目 → 用工作区本身建一个（工作区天生就是一个项目）
    const reg = registry()
    let ws = null
    if (reg && typeof reg.resolveByPath === 'function') {
      try { ws = await reg.resolveByPath(cwd) } catch { ws = null }
    }
    if (ws && ws.path) {
      const created = await ensureProject({ workspacePath: ws.path, name: ws.title || undefined, workspaceId: ws.id })
      return { ok: true, matchedBy: 'workspace-created', projectId: created.id, projectName: created.name, cwd }
    }
    // 3) DSH 没登记这个目录（比如 worktree）→ 不建项目，保持"无项目"
    return { ok: false, error: 'no workspace for this session', sessionId: sid, cwd }
  }

  // ---- 定时 tick（设计文档 14.9 / 15.4 TX-23） -------------------------------
  syncEngine = createSyncEngine({ domain, store, dispatcher, runtime, log })
  const scheduler = createScheduler({ domain, dispatcher, store, sync: syncProject, engine: syncEngine, runtime, log })

  /** 模型/预设目录：给前端做下拉用（只读，取不到就返回空）。 */
  const catalog = async () => {
    const session = resolveService(ctx, 'sessionController')
    const presets = resolveService(ctx, 'agentPresets')
    let modelCatalog = null
    let presetList = []
    try {
      if (session && typeof session.modelCatalog === 'function') modelCatalog = await session.modelCatalog()
    } catch { modelCatalog = null }
    try {
      if (presets && typeof presets.list === 'function') presetList = await presets.list()
    } catch { presetList = [] }
    return { ok: true, catalog: modelCatalog, presets: presetList }
  }

  const host = {
    domain, runtime, chat, dispatcher, scheduler, flowMode, resolveSessionProject, catalog, diagSessionCwd, diagFlowPlan,
    flowCommand: { validatePublishInput, parseFlowCommand },
    ensureProject, ensureAgents, resolveProject, resolveProjectById, listProjects, listWorkspaces,
    dispatch: dispatcher.dispatch, afterStop: dispatcher.afterStop, notifyDispatcher: dispatcher.notifyDispatcher,
    merge: dispatcher.merge, softMerge: dispatcher.softMerge, ensureWorktree: dispatcher.ensureWorktree, openPr: dispatcher.openPr, removeWorktree: dispatcher.removeWorktree,
    syncProject,
    /**
     * v1.23：「同步一次」必须走**同步引擎**，不能走老的 syncProject。
     *
     * 老路径（lib/remote.js syncProject → domain.syncRemote）只做「拉 issues 写镜像」，
     * 不认识 flow marker，也不做出站 —— 线上那次回声级联就是从「同步 issue」按钮进来的。
     * 引擎那条路才带 marker 过滤、评论、标签、PR 回读与两阶段 pending。
     * 引擎不可用（没配远程 / headless）时才退回去，保证老接口不炸。
     */
    runSync: async (project) => {
      if (syncEngine) {
        const res = await syncEngine.runProject(project, { force: true })
        if (res && res.ok !== false) return res
        if (res && res.skipped === 'not-configured') return syncProject({ domain, project })
        return res
      }
      return syncProject({ domain, project })
    },

    /**
     * v1.24 一键停止全部调度。
     *
     * 两步：① 事务里置控制位 + 把所有在跑的 run 收成 interrupted（一次写，原子）；
     * ② 事务外逐个真取消会话、停心跳。顺序不能反：先取消会话的话，
     * 会话的 turn/end 事件会先回来，把 run 标成"用户停止"，
     * 人就分不清是"我按了停止"还是"工人自己停了"。
     */
    haltAll: async (reason = null, actor = { role: 'human', id: 'web' }) => {
      const res = await domain.haltAll(actor, reason)
      dispatcher.stopAllHeartbeats()
      const cancelled = []
      for (const sessionId of res.sessionIds || []) {
        const r = await runtime.cancelSession(sessionId).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
        cancelled.push({ sessionId, ok: !!(r && r.ok), message: (r && r.message) || null })
      }
      await domain.logMessage({ direction: 'out', origin: 'system', kind: 'flow.halt', ok: true, sessionId: null, detail: { runIds: res.runIds, cancelled } })
      return { ok: true, halted: true, already: !!res.already, interruptedRuns: (res.runIds || []).length, cancelled }
    },

    resumeAll: async (actor = { role: 'human', id: 'web' }) => {
      const res = await domain.resumeAll(actor)
      return { ok: true, halted: false, was: !!res.was }
    },
  }

  // ---- 工具 ----------------------------------------------------------------
  for (const tool of buildTools(host)) {
    const execute = tool.execute
    // 工具里有直接读 store.state 的只读操作（flow_board 等）：先等状态就绪。
    tool.execute = async (args, execCtx) => {
      await storeReady
      return execute(args, execCtx)
    }
    ctx.tools.register(tool)
  }

  // ---- 会话事件 → 聊天帧 ----------------------------------------------------
  const detachChat = chat.attach(ctx)

  // ---- 会话事件 → 调度管道（v1.24）------------------------------------------
  // 生成报错、用户点"停止生成"、进程崩溃留下的孤儿 —— 这些以前只有
  // stuckRuns(30min) / maxRunMs(3h) 兜底，中间整段时间调度不知情。
  // 这里把它们接进事务管道（dispatcher.onSessionEvent 会收 run、记预算、通知调度）。
  // 必须排在 storeReady 之后才能读状态；事件本身很轻，串行投递避免并发写库。
  let sessionEventChain = Promise.resolve()
  const offSessionEvents = ctx.on('session/event', (session, event) => {
    const sessionId = session && session.id
    if (!sessionId) return
    sessionEventChain = sessionEventChain
      .then(async () => {
        await storeReady
        return dispatcher.onSessionEvent(sessionId, event)
      })
      .catch((err) => log('session event failed: ' + ((err && err.message) || err)))
  }, { global: true })

  // ---- 把 flow skill 装到 skill 根下（/flow 进入后要 agent 去调它） ----------
  // skill 由 dsh-skill-filesystem 扫描 ~/.agents/skills 发现，插件不能直接注册，
  // 所以把仓库里的 skills/flow/SKILL.md 同步过去。
  // 只在「没有」或「上次是我们装的、内容变了」时写，不覆盖用户自己写的同名 skill。
  const FLOW_SKILL_MARKER = '.dsh-flow-managed'
  const ensureFlowSkill = async () => {
    try {
      const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const { join, dirname } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      const src = join(dirname(fileURLToPath(import.meta.url)), 'skills', 'flow', 'SKILL.md')
      if (!existsSync(src)) return { ok: false, reason: 'skill 源文件不存在：' + src }
      const body = readFileSync(src, 'utf8')
      const root = process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
      const targetDir = join(root, 'skills', 'flow')
      const target = join(targetDir, 'SKILL.md')
      const marker = join(targetDir, FLOW_SKILL_MARKER)
      if (existsSync(target) && !existsSync(marker)) {
        log('flow skill 已存在且不是我们装的，跳过：' + target)
        return { ok: true, skipped: 'user-owned', target }
      }
      if (existsSync(target) && readFileSync(target, 'utf8') === body) {
        if (!existsSync(marker)) writeFileSync(marker, new Date().toISOString())
        return { ok: true, unchanged: true, target }
      }
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(target, body)
      writeFileSync(marker, new Date().toISOString())
      log('flow skill 已安装：' + target)
      return { ok: true, installed: true, target }
    } catch (err) {
      log('flow skill 安装失败（不影响其它功能）：' + msgOf(err))
      return { ok: false, reason: msgOf(err) }
    }
  }
  ensureFlowSkill().catch(() => {})

  // ---- 定时器 --------------------------------------------------------------
  const timers = []
  timers.push(setInterval(() => { domain.pumpOutbox().catch(() => {}) }, 2000))
  // v1.22 P5：启动对账 —— 进程重启后 JSON 里那些 status:'running' 的 run 已经不可能还活着
  // （心跳定时器随进程消失了）。先统一认作 interrupted 并清 activeRunId，再让 tick 重派；
  // 否则任务会卡在 running 等半小时后才被 reapStuck 捡走。
  storeReady
    .then(() => domain.recoverRuns(Date.now(), { role: 'system', id: 'recover' }))
    .then(async (res) => {
      if (res && res.runs && res.runs.length) {
        log('flow recovered: ' + res.runs.length + ' run(s) → interrupted，停机 ' + Math.round((res.shiftMs || 0) / 1000) + 's 不计入退避')
        // v1.39.2：光收 run 不够 —— 调度员得知道"上一轮被重启打断了"，
        // 否则卡默默回到待办，没人重新派工、也没人换做法。
        const told = await dispatcher.notifyRecovered(res.runs).catch(() => [])
        const okCount = (told || []).filter((x) => x && x.ok).length
        if (told && told.length) log('flow recovered: 已通知调度员 ' + okCount + '/' + told.length + ' 张卡')
      }
    })
    .catch((err) => log('flow recover failed: ' + msgOf(err)))
  // v1.23：入站身份对账。v1.22 的回声级联给入站卡写了错的 remote.issueNumber
  // （实际是自己的重复 issue），不修的话出站会继续把它们当成"已推过的卡"，
  // 标签回写会打到那条重复 issue 上，而真正的来源 issue 永远收不到状态。
  storeReady
    .then(() => domain.repairInboundIdentities({ role: 'system', id: 'repair' }))
    .then((res) => {
      const fixed = (res && res.fixed) || []
      if (fixed.length) {
        log('flow identity repaired: ' + fixed.length + ' task(s) 的远程身份已改回来源 issue')
      }
    })
    .catch((err) => log('flow identity repair failed: ' + msgOf(err)))

  const sched = scheduler.start({ intervalMs: Number(process.env.DSH_FLOW_TICK_MS) || 15000 })

  // v1.3：入口只剩会话里的「调度台」标签（conversation.view），
  // 不再注入 /api/flow/app 浮标，也不再提供独立工作台页面。

  // ---- HTTP：注册到 DSH webServer 的前缀路由（/api/flow/*） -------------------
  // 不能用 connection.fetch.register：它按「精确 pathname」匹配（见 dsh-client-connection
  // createSharedFetchHandler），path '/api/flow' 匹配不到 '/api/flow/app' → 404。
  // 前缀路由必须走 webServer.register({kind:'prefix'})；鉴权复用 connection.admit(Request)。
  const handler = createHttpHandler(host)
  // 读接口也依赖磁盘状态：统一在进入 http handler 前等到 ready。
  const readyHandler = async (request) => {
    try {
      await storeReady
    } catch (err) {
      return Response.json({ ok: false, error: 'flow 数据加载失败：' + msgOf(err) }, { status: 500 })
    }
    return handler(request)
  }
  const routeState = { dispose: null }
  const mountRoute = (webServer, connection) => {
    if (!webServer || typeof webServer.register !== 'function') {
      log('route skipped: 当前 profile 没有 webServer（headless 正常）')
      return null
    }
    let dispose = null
    try {
      dispose = webServer.register({
        kind: 'prefix',
        path: '/api/flow',
        handler: (req, res) => serveNodeRequest(req, res, readyHandler, connection),
      })
    } catch (err) {
      log('route registration failed: ' + msgOf(err))
      return null
    }
    routeState.dispose = dispose
    log('route registered at /api/flow/*')
    return dispose
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () => mountRoute(resolveService(webCtx, 'webServer'), resolveService(webCtx, 'connection')),
        'dsh-flow: /api/flow routes',
      )
    })
  } else {
    // 老 cordis 没有 ctx.inject：退化成轮询（最多 20 秒）
    const legacy = { dispose: null, tries: 0 }
    const tryMount = () => {
      if (legacy.dispose) return
      const webServer = resolveService(ctx, 'webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        if (legacy.tries++ < 40) setTimeout(tryMount, 500)
        return
      }
      try {
        legacy.dispose = mountRoute(webServer, resolveService(ctx, 'connection'))
      } catch (err) {
        log('route registration failed: ' + msgOf(err))
      }
    }
    tryMount()
  }

  // I-10（ADR-0006 §2）：启动重活 —— 对账**会动仓库**，所以后台跑，不阻塞就绪。
  //
  // 启动这一路与 tick 那一路的分工是这样定的：tick 每 15 秒一次，若它有权删目录，
  // 就等于让一个高频、无人值守的循环去判断「这个目录是不是垃圾」；判错的代价是工人正在干的活消失。
  // 启动这一次是低频的、有人的（刚开机/刚重启），适合做真正的修复。
  storeReady
    .then(() => (dispatcher && typeof dispatcher.reconcileWorktrees === 'function' ? dispatcher.reconcileWorktrees({}) : null))
    .then((res) => {
      if (!res || !res.ok) return
      const acted = (res.actions || []).filter((a) => !/^would-/.test(String(a.kind)))
      if (acted.length) log('worktree reconcile: ' + acted.length + ' action(s) · ' + acted.map((a) => a.kind).join(','))
      if ((res.skipped || []).length) log('worktree reconcile skipped: ' + res.skipped.length)
    })
    .catch((err) => log('worktree reconcile failed: ' + msgOf(err)))
  log('ready · data=' + DATA_FILE())

  return async () => {
    try { sched.stop() } catch {}
    // run 心跳定时器：卸载时必须停掉，否则插件被替换后旧定时器还在写 run
    try { if (dispatcher && typeof dispatcher.stopAllHeartbeats === 'function') dispatcher.stopAllHeartbeats() } catch {}
    for (const t of timers) clearInterval(t)
    try { detachChat() } catch {}
    try { if (typeof offSessionEvents === 'function') offSessionEvents() } catch {}
    try { if (routeState.dispose) await routeState.dispose() } catch {}
    routeState.dispose = null
  }
}

