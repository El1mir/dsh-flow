/**
 * dsh-flow · panel
 *
 * 总览聚合：一屏回答「哪个项目卡住了、谁在干活、上下文还剩多少」。
 * 只读投影，不写任何状态；数据全部来自 domain.snapshot 与 store.state 的现成字段。
 */

import { agentLabel } from './domain.js'
import { builtinPromptsForDisplay } from './prompts.js'

/** 单车道聚合。 */
function laneStat(project, lane, tasks, runs, agents, sessions) {
  const laneTasks = tasks.filter((t) => (t.lane || 'human') === lane)
  const running = laneTasks.filter((t) => t.activeRunId)
  const blocked = laneTasks.filter((t) => t.blocked)
  const waitingWorker = laneTasks.filter((t) => t.phase === 'waiting-worker')
  const waitingSupervisor = laneTasks.filter((t) => t.phase === 'waiting-supervisor')
  const laneAgents = agents.filter((a) => (a.lane || 'human') === lane)
  const ratios = laneAgents
    .map((a) => latestSessionOf(a.id, sessions))
    .filter(Boolean)
    .map((rec) => (rec.budget ? Number(rec.budget.ratio) || 0 : 0))
  const maxBudget = ratios.length ? Math.max(...ratios) : 0
  const avgBudget = ratios.length ? ratios.reduce((n, r) => n + r, 0) / ratios.length : 0
  return {
    lane,
    tasks: laneTasks.length,
    running: running.length,
    blocked: blocked.length,
    waitingWorker: waitingWorker.length,
    waitingSupervisor: waitingSupervisor.length,
    workers: laneAgents.filter((a) => a.role === 'worker').length,
    dispatchers: laneAgents.filter((a) => a.role === 'dispatcher').length,
    budget: { max: Number(maxBudget.toFixed(3)), avg: Number(avgBudget.toFixed(3)) },
  }
}

function latestSessionOf(agentId, sessions) {
  let best = null
  for (const rec of sessions) {
    if (rec.agentId !== agentId || !rec.sessionId) continue
    if (!best || String(rec.createdAt || '') >= String(best.createdAt || '')) best = rec
  }
  return best
}

/**
 * 全项目总览。
 * @param state store.state
 * @param opts { eventLimit }
 */
export function buildOverview(state, { eventLimit = 20 } = {}) {
  const projects = Object.values(state.projects || {})
  const tasks = Object.values(state.tasks || {})
  const runs = Object.values(state.runs || {})
  const agents = Object.values(state.agents || {})
  const sessions = Object.values(state.agent_sessions || {})

  const rows = projects.map((project) => {
    const pTasks = tasks.filter((t) => t.projectId === project.id)
    const pRuns = runs.filter((r) => r.projectId === project.id && r.status === 'running')
    const pAgents = agents.filter((a) => a.projectId === project.id)
    const pSessions = sessions.filter((s) => s.projectId === project.id)
    const lanes = {
      human: laneStat(project, 'human', pTasks, pRuns, pAgents, pSessions),
      issue: laneStat(project, 'issue', pTasks, pRuns, pAgents, pSessions),
    }
    const lastEvent = [...(state.events || [])]
      .reverse()
      .find((e) => e && e.payload && e.payload.projectId === project.id)
    return {
      id: project.id,
      name: project.name,
      path: project.workspacePath,
      chiefSessionId: project.chiefSessionId || null,
      lanes,
      running: pRuns.length,
      blocked: pTasks.filter((t) => t.blocked).length,
      tasks: pTasks.length,
      agents: pAgents.length,
      taskPreview: [...pTasks]
        .sort((a, b) => {
          const rank = (t) => (t.activeRunId ? 0 : t.blocked ? 1 : 2)
          return rank(a) - rank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        })
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          title: t.title,
          column: t.column,
          phase: t.phase || '',
          running: !!t.activeRunId,
          blocked: !!t.blocked,
          lane: t.lane || 'human',
        })),
      lastEventAt: lastEvent ? lastEvent.at : null,
    }
  })

  // 事件流只留"有信息量"的：水位刷新这类周期性事件降噪（同 agent 只留最新一条且 ratio<0.6 的直接丢）
  const rawEvents = [...(state.events || [])]
  const keep = []
  const seenBudget = new Set()
  for (let i = rawEvents.length - 1; i >= 0 && keep.length < Math.max(1, eventLimit) * 3; i -= 1) {
    const e = rawEvents[i]
    if (!e) continue
    // 水位事件不进总览流：它每 tick 每个代理都发一次，信息已由车道水位条承载
    if (e.type === 'session.budget') continue
    keep.push(e)
    if (keep.length >= Math.max(1, eventLimit)) break
  }
  const events = keep.map((e) => ({
    id: e.id,
    type: e.type,
    at: e.at,
    text: describeEvent(e),
  }))

  const totals = rows.reduce(
    (acc, r) => {
      acc.projects += 1
      acc.tasks += r.tasks
      acc.running += r.running
      acc.blocked += r.blocked
      return acc
    },
    { projects: 0, tasks: 0, running: 0, blocked: 0 },
  )

  return { ok: true, totals, projects: rows, events, generatedAt: new Date().toISOString() }
}

/** 事件 → 一行人类可读文本（面板用，不追求完整性）。 */
export function describeEvent(e) {
  const p = (e && e.payload) || {}
  const actor = (e && e.actor && (e.actor.id || e.actor.role)) || 'system'
  switch (e && e.type) {
    case 'task.created': return '新建任务 ' + (p.taskId || '') + '：' + (p.title || '')
    case 'task.moved': return (p.taskId || '') + ' → ' + (p.column || '') + (p.action ? '（' + p.action + '）' : '')
    case 'task.dispatched': return (p.taskId || '') + ' 已派工给 ' + (p.agentId || '')
    case 'task.run.ended': return (p.taskId || '') + ' 运行结束：' + (p.status || '')
    case 'task.inspection': return (p.taskId || '') + ' 巡检结论：' + (p.verdict || '')
    case 'task.blocked': return (p.taskId || '') + ' 被阻塞'
    case 'session.budget': return (p.agentId || '') + ' 上下文水位 ' + Math.round((Number(p.ratio) || 0) * 100) + '%'
    case 'agent.reparented': return (p.agentId || '') + ' 改派上级 → ' + (p.to || '无')
    case 'project.created': return '新建项目 ' + (p.name || '')
    default: return (e && e.type ? e.type : '事件') + ' · ' + actor
  }
}


/**
 * 单项目事务视图（v1.2）：前端「调度台」标签页的数据源。
 *
 * 与总览的区别：总览是"多项目一眼扫"，这里是"一个项目的事务全景"——
 * 任务按列分组（状态机位置）+ 每条的 version/phase/blocked/plan/approvals，
 * 加上租约、运行、待审批、事件链，让界面和 docs/事务流设计.md 的模型一一对应。
 */
export function buildProjectView(state, projectId, { eventLimit = 40 } = {}) {
  const project = (state.projects || {})[projectId]
  if (!project) return { ok: false, error: 'unknown project: ' + projectId }
  // v1.31.3：按"最近移入"倒序 —— 后进这一列的排最前，最早的排最后。
  //
  // 原来这里没有排序，直接吃 Object.values() 的插入顺序（≈ 创建顺序），
  // 于是看板从上往下读是"最老的卡 → 最新的卡"，而人关心的是刚进来的那张。
  //
  // "移入这一列的时间"用 columnAt（进列时打的时间戳）；老数据没有这个字段，
  // 用 updatedAt 再退到 createdAt —— 三个都不存在时排到最后（稳定排序不会乱跳）。
  const colAt = (t) => String(t.columnAt || t.updatedAt || t.createdAt || '')
  const tasks = Object.values(state.tasks || {})
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => colAt(b).localeCompare(colAt(a)))
  const agents = Object.values(state.agents || {}).filter((a) => a.projectId === projectId)
  const sessions = Object.values(state.agent_sessions || {}).filter((r) => r.projectId === projectId)
  const runs = Object.values(state.runs || {}).filter((r) => r.projectId === projectId)
  const leases = Object.values(state.leases || {}).filter((l) => {
    if (String(l.key || '').startsWith('merge:')) return l.key === 'merge:' + projectId
    if (String(l.key || '').startsWith('task:')) return !!state.tasks[l.key.slice(5)] && state.tasks[l.key.slice(5)].projectId === projectId
    return false
  })
  const approvals = Object.values(state.approvals || {}).filter((a) => {
    const t = state.tasks[a.taskId]
    return t && t.projectId === projectId
  })

  const byColumn = {}
  for (const col of COLUMNS_FOR_VIEW) byColumn[col] = []
  // v1.37：每张卡未处理的请示数（卡片上的 📨 徽章）
  const inboxByTask = {}
  for (const x of state.human_inbox || []) {
    if (!x || !x.taskId || x.status === 'archived' || x.kind === 'info') continue
    inboxByTask[x.taskId] = (inboxByTask[x.taskId] || 0) + 1
  }
  // v1.39：子卡不上看板（card.hiddenOnBoard）—— 它们在父卡详情里看和打开。
  // C-03：visibility='auto' 的卡同样不上板（rf-04）—— 被系统自动接管、人不需要盯着的卡
  // 留在自动车道视图里，但**必须仍然可见**（autoLane 就是那个出口），否则降噪会变成失明。
  const boardTasks = tasks.filter((t) => !(t.hiddenOnBoard === true && t.parentId) && t.visibility !== 'auto')
  for (const t of boardTasks) (byColumn[t.column] || (byColumn[t.column] = [])).push(taskCard(t, { openInbox: inboxByTask[t.id], allTasks: tasks }))

  const activeRuns = runs
    .filter((r) => r.status === 'running')
    .map((r) => ({
      runId: r.id, taskId: r.taskId, agentId: r.agentId, sessionId: r.sessionId || null,
      startedAt: r.startedAt, alive: true,
    }))

  const events = [...(state.events || [])]
    .filter((e) => {
      const p = (e && e.payload) || {}
      if (p.projectId === projectId || p.projectId === undefined) {
        if (p.taskId) {
          const t = state.tasks[p.taskId]
          return !!t && t.projectId === projectId
        }
        return p.projectId === projectId || e.type === 'project.created' || e.type === 'project.config' || e.type === 'project.lane.ensured'
      }
      return false
    })
    .filter((e) => e.type !== 'session.budget')
    .slice(-eventLimit)
    .reverse()
    .map((e) => ({ id: e.id, type: e.type, at: e.at, text: describeEvent(e), actor: (e.actor && (e.actor.id || e.actor.role)) || 'system' }))

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    // v1.24：全局控制位（一键停止全部调度）。放在顶层而不是 project 里：
    // 它是进程级开关，一个项目开着 stop，别的项目也不该继续派工。
    control: (() => {
      const c = (state.control && typeof state.control === 'object') ? state.control : {}
      return { halted: c.halted === true, haltedAt: c.haltedAt || null, haltedBy: c.haltedBy || null, reason: c.reason || null }
    })(),
    // v1.29：内置默认提示词（只读）。设置页要能让人看到「模型到底被告知了什么」，
    // 而不是只能翻源码。这些内容由 lib/prompts.js 维护，项目配置改不动它们。
    builtinPrompts: builtinPromptsForDisplay(),
    // v1.31：调度员请示箱。看板顶栏要能显示"有几条在等我"，
    // 所以 count 单独给一份（客户端不必自己 filter 一遍）。
    inbox: (() => {
      const all = (state.human_inbox || []).filter((x) => x.projectId === projectId)
      const open = all.filter((x) => x.status === 'open')
      const answered = all.filter((x) => x.status === 'answered')
      return {
        open: open.length,
        answered: answered.length,
        // 看板只需要未归档的；archived 的留作审计，不下发到前端。
        items: all
          .filter((x) => x.status !== 'archived')
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 100),
      }
    })(),
    project: {
      id: project.id,
      name: project.name,
      path: project.workspacePath,
      workspaceId: project.workspaceId || null,
      chiefSessionId: project.chiefSessionId || null,
      config: {
        // 关掉 = 纯本地看板模式：不记录 issue，也就不该出现任何自动化开关
        recordIssues: !!project.config.recordIssues,
        autoDispatch: !!project.config.autoDispatch,
        autoAccept: !!project.config.autoAccept,
        autoMerge: !!project.config.autoMerge,
        maxInFlightPerProject: project.config.maxInFlightPerProject,
        baseBranch: project.config.baseBranch,
        mergeStrategy: project.config.mergeStrategy,
        hotWorkerStreak: project.config.hotWorkerStreak,
        poisonRebuild: project.config.poisonRebuild === true,
        poisonStuckThreshold: project.config.poisonStuckThreshold,
        workerResetPolicy: project.config.workerResetPolicy || 'guarded',
        workerResetQuietMs: project.config.workerResetQuietMs,
        scopeDecayTasks: project.config.scopeDecayTasks,
        pushRemote: !!project.config.pushRemote,
        // v1.29：自定义提示词（可编辑）。内置默认在顶层 builtinPrompts 里（只读）。
        promptOverlay: project.config.promptOverlay || '',
        sharedDirs: Array.isArray(project.config.sharedDirs) ? project.config.sharedDirs : [],
        autoApproveIssue: !!project.config.autoApproveIssue,
        wakeOnCiFailed: !!project.config.wakeOnCiFailed,
        // C-11：设置页读得到、但白名单里没有的四个键。
        // 症状是「写进去了、回读恒 undefined」——技能恒显示「全部」、评审轮数恒 4、每列恒 8 条，
        // 看起来像设置没保存。写侧一直是好的（domain.updateProjectConfig 会校验后 merge），只有读侧漏了。
        allowedSkills: Array.isArray(project.config.allowedSkills) ? project.config.allowedSkills.slice(0, 200) : null,
        grillSkill: project.config.grillSkill || null,
        grillMaxRounds: project.config.grillMaxRounds,
        columnPageSize: project.config.columnPageSize,
        // C-02：外部 PR 入站开关（客户端据此显示「接别人的 PR」）。
        recordPulls: !!project.config.recordPulls,
        // C-06 预留：外部 PR 合并后是否关掉远程 PR（默认关，等人决定）。
        closePullOnMerge: project.config.closePullOnMerge === true,
        // token 只回 "有没有"，绝不把明文送到浏览器
        remote: project.config.remote ? {
          kind: project.config.remote.kind || 'github',
          baseUrl: project.config.remote.baseUrl || '',
          owner: project.config.remote.owner || '',
          repo: project.config.remote.repo || '',
          useGhCli: project.config.remote.useGhCli !== false,
          webhookSecret: project.config.remote.webhookSecret ? '(已设置)' : '',
          hasToken: !!project.config.remote.token,
          enabled: project.config.remote.enabled !== false,
        } : null,
      },
      // v1.22：同步状态（设置面板的「同步状态」区块与 topbar 的同步按钮读它）
      sync: (() => {
        const st = (state.remote_sync || {})[projectId]
        if (!st) return null
        return {
          since: st.since || null,
          lastSyncAt: st.lastSyncAt || null,
          lastError: st.lastError || null,
          circuitUntil: st.circuitUntil || null,
          issueCursor: st.issueCursor || null,
          commentCursor: st.commentCursor || null,
          outbound: Array.isArray(st.outbound) ? st.outbound.length : 0,
        }
      })(),
    },
    lanes: {
      human: laneView(state, project, 'human'),
      issue: laneView(state, project, 'issue'),
    },
    // C-03 / rf-04：自动车道视图。auto 卡不上板，但**人必须还能看见自动车道在干什么**，
    // 所以这里给一份有上限的台账（20 条），而不是把卡从视图里彻底删掉。
    // 排序：blocked 或有未归档请示的置顶（那才是人该看的），其余按 updatedAt 降序。
    autoLane: (() => {
      const auto = tasks.filter((t) => t.visibility === 'auto')
      const escalated = (t) => !!t.blocked || (inboxByTask[t.id] || 0) > 0
      const rows = [...auto]
        .sort((a, b) => (escalated(a) === escalated(b)
          ? String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
          : (escalated(a) ? -1 : 1)))
        .slice(0, 20)
        .map((t) => ({
          id: t.id,
          title: t.title,
          column: t.column,
          phase: t.phase || '',
          blocked: t.blocked ? { reason: t.blocked.reason, at: t.blocked.at } : null,
          openInbox: inboxByTask[t.id] || 0,
          updatedAt: t.updatedAt || null,
        }))
      return {
        count: auto.length,
        boardEscalated: auto.filter(escalated).length,
        tasks: rows,
      }
    })(),
    columns: COLUMNS_FOR_VIEW.map((id) => ({ id, title: COLUMN_TITLES[id] || id, count: (byColumn[id] || []).length })),
    tasks: byColumn,
    // 总调度者（chief）的模型由 DSH 自己的会话设置决定，不属于本插件的"模型配置"
    agents: agents.filter((a) => a && a.role !== 'chief').map((a) => ({
      id: a.id, name: a.name, role: a.role, slot: a.slot,
      lane: a.lane || 'human', supervisorId: a.supervisorId || null,
      enabled: a.enabled !== false, maxConcurrency: a.maxConcurrency || 1,
      model: a.model || null, provider: a.provider || null,
      // 身份名给界面用（human调度1 / auto工人2）——老数据没有 name 时按 lane×role×slot 拼
      label: agentLabel(a),
      sessionId: (sessions.filter((r) => r.agentId === a.id).slice(-1)[0] || {}).sessionId || null,
      // 会话标题与 cwd：界面要能显示"这个工位现在在哪个目录、认不认得出是谁"
      sessionTitle: (sessions.filter((r) => r.agentId === a.id).slice(-1)[0] || {}).title || null,
      sessionCwd: (sessions.filter((r) => r.agentId === a.id).slice(-1)[0] || {}).cwd || null,
      budget: (sessions.filter((r) => r.agentId === a.id).slice(-1)[0] || {}).budget || null,
    })),
    runs: activeRuns,
    leases: leases.map((l) => ({ key: l.key, owner: l.owner, token: l.token, expiresAt: l.expiresAt })),
    approvals: approvals.slice(-20).reverse().map((a) => ({
      id: a.id,
      taskId: a.taskId,
      kind: a.kind,
      // plan 审批绑的是 plan 版本号，head 审批绑的是验收时的 head_sha（两者字段不同，别用一个 rev 糊过去）
      planRevision: a.planRevision ?? null,
      headSha: a.headSha ?? null,
      by: a.actor || null,
      role: a.role || null,
      at: a.at,
      revokedAt: a.revokedAt || null,
      revokeReason: a.revokeReason || null,
    })),
    events,
    totals: {
      tasks: tasks.length,
      // 列在「执行中」或有活跃 run 都算在跑（只看 activeRunId 时，工人回合间隙会显示 0）
      running: tasks.filter((t) => t.activeRunId || t.column === 'running').length,
      blocked: tasks.filter((t) => t.blocked).length,
      verifying: tasks.filter((t) => t.column === 'verifying').length,
      approvals: approvals.filter((a) => !a.revokedAt).length,
      // v1.37：会话状态
      sessions: {
        active: sessions.filter((r) => r.state === 'active').length,
        idle: sessions.filter((r) => r.state === 'idle').length,
        total: new Set(sessions.map((r) => r.sessionId).filter(Boolean)).size,
      },
      // v1.37：Inbox 待处理
      inbox: (() => {
        const all = (state.human_inbox || []).filter((x) => x.projectId === project.id && x.status !== 'archived' && x.kind !== 'info')
        return { open: all.filter((x) => x.status === 'open').length, answered: all.filter((x) => x.status === 'answered').length }
      })(),
      // v1.37：消息流量（最近 5 分钟）
      messages: (() => {
        const ml = (state.message_log || []).filter((m) => {
          if (!m || !m.sessionId) return false
          const s = sessions.find((r) => r.sessionId === m.sessionId)
          return !!s
        })
        const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString()
        return { total: ml.length, recent5: ml.filter((m) => (m.at || '') >= cutoff).length }
      })(),
    },
  }
}

const COLUMNS_FOR_VIEW = ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled']
const COLUMN_TITLES = {
  todo: '待办', planning: '规划中', running: '执行中', verifying: '待验收',
  merging: '合并中', done: '完成', cancelled: '已取消',
}

/**
 * 交付态分类（C-03 / rf-02 的读侧）。
 *
 * 这份是 lib/core.js 里 deliveryState 的**镜像**，不是随手重写：
 * panel 至今只 import domain.js / prompts.js，为一个 5 行函数把整个 core.js
 * 拉进来不值得（domain 已经间接带它，但读侧不该依赖领域层的依赖图）。
 * 镜像的代价是可能漂移 —— test/panel-visibility.mjs 会拿同一组输入比对两边的结果，
 * 漂了就红。改这里必须同时改 lib/core.js 的 deliveryState。
 *
 * 只认 column==='done' 且 phase 是三种终态之一：用列判断交付率会把
 * 「有意不合并」(merged-skipped) 与「本来没有可合的东西」(done-no-merge) 也算成交付。
 */
export function deliveryStateOf(t) {
  if (!t || t.column !== 'done') return 'not-delivered'
  if (t.phase === 'merged') return 'delivered'
  if (t.phase === 'merged-skipped') return 'skipped'
  if (t.phase === 'done-no-merge') return 'no-merge'
  if (t.phase === 'merged-into-parent') return 'merged-into-parent'
  return 'not-delivered'
}

/** 任务卡：只投影界面要用的字段，避免把整份 state 发给浏览器。 */
function taskCard(t, extra = {}) {
  const plan = t.plan || {}
  // v1.39：父卡 / 子卡 / 工作包工单
  const childIds = Array.isArray(t.childIds) ? t.childIds : []
  const kids = (extra.allTasks || []).filter((x) => childIds.includes(x.id))
  const childDone = kids.filter((x) => ['done', 'cancelled'].includes(x.column)).length
  const report = t.stopReport || {}
  // v1.37：验收进度 = acceptanceStatus 里 pass 的条数 / 验收标准条数
  const accTotal = Array.isArray(t.acceptance) ? t.acceptance.length : 0
  const accList = Array.isArray(report.acceptanceStatus) ? report.acceptanceStatus : []
  const accPass = accList.filter((x) => x && x.status === 'pass').length
  const pg = t.progress || null
  const delivery = deliveryStateOf(t)
  return {
    id: t.id,
    title: t.title,
    lane: t.lane || 'human',
    origin: t.origin || 'manual',
    column: t.column,
    phase: t.phase || '',
    version: t.version || 0,
    blocked: t.blocked ? { reason: t.blocked.reason, at: t.blocked.at } : null,
    assignee: t.assignee || null,
    activeRunId: t.activeRunId || null,
    plan: { revision: plan.revision || 0, approvedRevision: plan.approvedRevision ?? null, hasText: !!plan.text },
    stopReport: report.summary ? { summary: report.summary, tests: report.tests || null, blocked: report.blocked || null } : null,
    mergeRequest: t.mergeRequest ? {
      headSha: t.mergeRequest.headSha || null, status: t.mergeRequest.status || null,
      reviewVerdict: t.mergeRequest.reviewVerdict || null,
    } : null,
    inspection: t.inspection || null,
    scope: t.scope || { paths: [], symbols: [] },
    subtasks: Array.isArray(t.subtasks) ? t.subtasks.map((x) => ({ title: x.title, status: x.status || 'todo' })) : [],
    // v1.39：父子关系（子卡不上看板，只在父卡详情里显示和打开）
    parentId: t.parentId || null,
    childIds,
    childProgress: childIds.length ? { done: childDone, total: childIds.length } : null,
    hiddenOnBoard: t.hiddenOnBoard === true,
    ticket: t.ticket ? {
      purpose: t.ticket.purpose || '', current: t.ticket.current || '',
      scope: t.ticket.scope || { paths: [], symbols: [] },
      outOfScope: t.ticket.outOfScope || '', effect: t.ticket.effect || '',
      acceptance: t.ticket.acceptance || [], testCmd: t.ticket.testCmd || '',
      risk: t.ticket.risk || '', rollback: t.ticket.rollback || '',
      dependsOn: t.ticket.dependsOn || [], sources: t.ticket.sources || {},
    } : null,
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    grill: t.grill ? { status: t.grill.status || 'idle', rounds: t.grill.rounds || 0, maxRounds: t.grill.maxRounds || 4, verdict: t.grill.verdict || null, openForHuman: t.grill.openForHuman || [], settled: t.grill.settled || [] } : null,
    dispatchedBy: t.dispatchedBy || null,
    dispatchReason: t.dispatchReason || null,
    reopenCount: t.reopenCount || 0,
    reopenRequested: t.reopenRequested ? { reason: t.reopenRequested.reason, by: t.reopenRequested.by, at: t.reopenRequested.at } : null,
    noMerge: t.noMerge === true,
    noMergeReason: t.noMergeReason || '',
    // I-12：看板 chip 与详情行读的是 mergeState / mergeReason（ADR-0005）。
    // 这两个字段必须**显式投影**：buildProjectView 的 taskCard 是白名单式手写的，
    // 少一个字段的后果不是「显示得朴素」，而是客户端 mergeBadgeOf 拿不到状态、
    // 整块合并信息静默消失 —— 那种 bug 不会报错，只会让人以为「本来就没有」。
    mergeState: t.mergeState || null,
    mergeReason: t.mergeReason || null,
    // C-03：rf-04 / rf-02 的读侧字段。和白名单里其他字段一样，**漏一个就是静默 null**：
    // 客户端拿不到 kind/visibility/external/branchFrom 时不会报错，只会显示得像老数据。
    kind: t.kind || 'card',
    visibility: t.visibility || 'board',
    external: t.external || null,
    branchFrom: t.branchFrom || null,
    // 交付态与 core.isDelivered 同义（done + merged 才算真进了 base）；
    // deliveryState 给详情页与徽标用，delivered 是它的布尔快捷方式。
    delivered: delivery === 'delivered',
    deliveryState: delivery,
    // v1.22：卡在远程的身份（看板上要点得开 #N）与方案风险评估结论
    remote: t.remote ? { source: t.remote.source || 'github', issueNumber: t.remote.issueNumber || null, url: t.remote.url || null, labels: t.remote.labels || [] } : null,
    risk: t.risk ? { level: t.risk.level || null, reasons: t.risk.reasons || [] } : null,
    retryAfter: t.retryAfter || null,
    updatedAt: t.updatedAt || null,
    // v1.37：卡片所需的结构化信息
    progress: pg ? { state: pg.state, summary: pg.summary, next: pg.next || '', blocker: pg.blocker || null, updatedAt: pg.updatedAt || null } : null,
    acceptance: { total: accTotal, pass: accPass, reported: accList.length > 0 },
    acceptanceStatus: accList,
    openInbox: Number(extra.openInbox) || 0,
    lastActivityAt: (pg && pg.updatedAt) || t.columnAt || t.updatedAt || null,
    pullRequestStatus: (t.mergeRequest && t.mergeRequest.status) || null,
  }
}

/** 车道视图：数量 + 预算水位 + 该车道的代理。 */
function laneView(state, project, lane) {
  const tasks = Object.values(state.tasks || {}).filter((t) => t.projectId === project.id && (t.lane || 'human') === lane)
  const agents = Object.values(state.agents || {}).filter((a) => a.projectId === project.id && (a.lane || 'human') === lane)
  const sessions = Object.values(state.agent_sessions || {})
  const laneSessions = agents.map((a) => sessions.filter((r) => r.agentId === a.id).slice(-1)[0]).filter(Boolean)
  const ratios = laneSessions.map((r) => Number(r.budget && r.budget.ratio) || 0)
  return {
    lane,
    tasks: tasks.length,
    running: tasks.filter((t) => t.activeRunId).length,
    blocked: tasks.filter((t) => t.blocked).length,
    waitingWorker: tasks.filter((t) => t.phase === 'waiting-worker').length,
    waitingSupervisor: tasks.filter((t) => t.phase === 'waiting-supervisor').length,
    dispatchers: agents.filter((a) => a.role === 'dispatcher').length,
    workers: agents.filter((a) => a.role === 'worker').length,
    budget: { max: ratios.length ? Math.max(...ratios) : 0, avg: ratios.length ? ratios.reduce((n, r) => n + r, 0) / ratios.length : 0 },
  }
}
