/**
 * dsh-flow · client
 *
 * v1.3：独立工作台（lib/app.html）已移除，看板 / 任务详情 / 项目与角色配置
 * 全部搬进会话视图「调度台」（conversation.view，编队右边的标签页）。
 *
 * 为什么能搬：
 *   - conversation.view 是 session 作用域，组件直接拿 sessionId，
 *     「绑定对话」天然就是「当前对话」，不用再从 DOM 猜；
 *   - 原 HTML 页里所有动作都走 POST /api/flow/action，这里原样复用，
 *     所以搬的是界面，不是事务逻辑。
 *
 * 约束：客户端单文件、无构建、无 JSX —— 用 createElement + 小型 h 包装；
 * 全部包在 try/catch 里，抛错会白屏。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-flow',
  factory: (require) => {
    var logger = {
      warn: (m, e) => console.warn('[dsh-flow]', m, e),
    }
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var LOG = '[dsh-flow]'
    var VIEW_ID = 'flow'

    // ---- embed 模式（工作台 iframe 用；保留，供外部页面把会话嵌进来） ----------
    var OPEN_RETRIES = 24
    var OPEN_INTERVAL = 500
    var openGeneration = 0

    var readQuery = function () {
      try {
        var url = new URL(window.location.href)
        var sessionId = url.searchParams.get('flowSession') || ''
        var flag = url.searchParams.get('flowEmbed')
        return { sessionId: sessionId, embed: flag === '1' || flag === 'true' }
      } catch (error) {
        return { sessionId: '', embed: false }
      }
    }

    var openOnce = function (ctx, sessionId) {
      try {
        ctx.uiWorkspace.openSession(sessionId)
        return true
      } catch (error) {
        return false
      }
    }

    var openWithRetry = function (ctx, sessionId, attempt, generation) {
      var round = attempt || 0
      var token = generation === undefined ? ++openGeneration : generation
      if (!sessionId || token !== openGeneration) return
      if (openOnce(ctx, sessionId)) return
      if (round >= OPEN_RETRIES) {
        logger.warn('切会话失败（会话可能还没就绪）：' + sessionId)
        return
      }
      setTimeout(function () { openWithRetry(ctx, sessionId, round + 1, token) }, OPEN_INTERVAL)
    }

    var COLLAPSE_MIN_WIDTH = 1024

    var collapseSidebar = function (ctx) {
      try {
        var width = typeof window !== 'undefined' ? window.innerWidth : 0
        if (!(width >= COLLAPSE_MIN_WIDTH)) return
        if (ctx.layout && typeof ctx.layout.toggleSidebar === 'function') ctx.layout.toggleSidebar()
      } catch (error) {
        logger.warn('toggleSidebar 失败', error)
      }
    }

    var EMBED_CSS = [
      '#dsh-flow-entry{display:none!important}',
      '[class*="_frame"]{grid-template-columns:0 minmax(0,1fr) auto!important}',
      '[class*="sidebarCol"]{width:0!important;min-width:0!important;max-width:0!important;overflow:hidden!important;padding:0!important;border:none!important}',
    ].join('')

    var markEmbed = function (ctx) {
      try {
        document.documentElement.setAttribute('data-flow-embed', '1')
        var style = document.createElement('style')
        style.textContent = EMBED_CSS
        document.head.appendChild(style)
      } catch (error) { /* 无 document */ }
      collapseSidebar(ctx)
      try {
        if (ctx.layout && typeof ctx.layout.closeRightbar === 'function') ctx.layout.closeRightbar()
      } catch (error) {
        logger.warn('closeRightbar 失败', error)
      }
    }

    var listenSwitch = function (ctx) {
      try {
        window.addEventListener('message', function (event) {
          if (!event || event.origin !== window.location.origin) return
          if (!window.parent || event.source !== window.parent) return
          var data = event.data
          if (!data || data.type !== 'dsh-flow:session' || typeof data.sessionId !== 'string') return
          openWithRetry(ctx, data.sessionId)
        })
      } catch (error) {
        logger.warn('message 监听失败', error)
      }
    }

    // ---- 事务模型常量（与 lib/core.js / lib/panel.js 保持一致） ----------------
    var COLUMNS = ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled']
    var COLUMN_TITLES = {
      todo: '待办', planning: '规划中', running: '执行中', verifying: '待验收',
      merging: '合并中', done: '完成', cancelled: '已取消',
    }
    var COLUMN_HINTS = {
      todo: '人类建卡后落在这里，等调度员认领',
      planning: '调度员拆解 + 写计划，等人批准',
      running: '工人持有任务租约，在 worktree 里干活',
      verifying: '工人自停，等人类验收（绑定 head_sha）',
      merging: '验收通过 → 开 PR → 审核 → 合并',
      done: '终态：合并完成',
      cancelled: '终态：人工取消',
    }
    var ROLE_LABELS = { remote: '远程', human: '人类', chief: '主调度', dispatcher: '子调度', worker: '工人', system: '系统' }
    var ROLE_LETTER = { remote: '远', human: '我', chief: '总', dispatcher: '调', worker: '工', system: '系' }

    // ---- 小工具 ---------------------------------------------------------------
    var esc = function (v) {
      return String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }
    var hhmm = function (iso) {
      if (!iso) return ''
      var s = String(iso)
      return s.length >= 16 ? s.slice(11, 16) : s
    }
    // v1.37：按本地时区显示（原来直接截 UTC 字符串，北京时间 20:10 显示成 12:10）。
    // 一小时内显示相对时间，更远的显示 MM-DD HH:mm。
    var pad2 = function (n) { return n < 10 ? '0' + n : String(n) }
    var fmtTime = function (iso, nowMs) {
      if (!iso) return '—'
      var d = new Date(iso)
      var t = d.getTime()
      if (!isFinite(t)) return String(iso)
      var now = typeof nowMs === 'number' ? nowMs : Date.now()
      var diff = now - t
      if (diff >= 0 && diff < 60 * 1000) return '刚刚'
      if (diff >= 0 && diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }
    var dayTime = function (iso) { return fmtTime(iso) }
    var fmtTokens = function (n) { n = Number(n) || 0; if (n >= 1000000) return (n/1000000).toFixed(1)+'M'; if (n >= 1000) return (n/1000).toFixed(0)+'K'; return String(n) }
    var pct = function (r) { return Math.round((Number(r) || 0) * 100) + '%' }
    var ratioClass = function (r) { return r >= 0.9 ? 'bad' : r >= 0.7 ? 'warn' : '' }
    var normP = function (p) {
      return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }
    var shortSha = function (sha) { return sha ? String(sha).slice(0, 8) : '—' }

    // ---- HTTP：所有写操作都走 /api/flow/action（与原工作台同一张动作表） ------
    var postAction = function (action, args) {

      return fetch('/api/flow/action', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, args: args || {} }),
      })
        .then(function (r) { return r.text() })
        .then(function (t) {
          var body = null
          try { body = JSON.parse(t) } catch (e) { body = { ok: false, error: t.slice(0, 200) } }
          var res = (body && body.result) || body || {}
          if (res && res.ok === false) {
            var err = new Error(res.message || res.error || '操作失败')
            err.result = res
            throw err
          }
          return res
        })
    }
    var getJson = function (url) {
      return fetch(url, { credentials: 'same-origin' }).then(function (r) {
        return r.text().then(function (t) {
          var body = null
          try { body = JSON.parse(t) } catch (e) { body = { ok: false, error: t.slice(0, 200) } }
          return { ok: r.ok, status: r.status, body: body }
        })
      })
    }

    /** tasks 可能是对象/数组，统一成按 id 查。 */
    var taskIndex = function (state) {
      var raw = (state && state.tasks) || {}
      var list = Array.isArray(raw) ? raw : Object.values(raw)
      var map = new Map()
      for (var i = 0; i < list.length; i += 1) {
        var t = list[i]
        if (!t) continue
        if (t.id) map.set(t.id, t)
        if (t.uid) map.set(t.uid, t)
      }
      return map
    }

    var latestSessionOf = function (sessions, agentId) {
      var best = null
      for (var i = 0; i < sessions.length; i += 1) {
        var rec = sessions[i]
        if (!rec || rec.agentId !== agentId) continue
        if (!best || String(rec.createdAt || '') >= String(best.createdAt || '')) best = rec
      }
      return best
    }

    /** 从 /state 快照里算会话 → 项目（服务端旧版时的兜底）。 */
    var resolveFromState = function (state, sessionId, cwd) {
      var projects = Object.values((state && state.projects) || {})
      var bound = projects.filter(function (p) { return p.chiefSessionId === sessionId })[0]
      if (bound) return { project: bound, matchedBy: 'chief' }
      var recs = Object.values((state && state.agent_sessions) || {})
      for (var i = 0; i < recs.length; i += 1) {
        var rec = recs[i]
        if (!rec || rec.sessionId !== sessionId || rec.state === 'archived') continue
        var agent = state.agents && state.agents[rec.agentId]
        var project = agent && state.projects[agent.projectId]
        if (project) return { project: project, matchedBy: 'agent-session' }
      }
      if (cwd) {
        var target = normP(cwd)
        var hit = projects
          .filter(function (p) { return p.workspacePath })
          .sort(function (a, b) { return normP(b.workspacePath).length - normP(a.workspacePath).length })
          .filter(function (p) {
            var root = normP(p.workspacePath)
            return target === root || target.indexOf(root + '/') === 0
          })[0]
        if (hit) return { project: hit, matchedBy: 'cwd' }
      }
      return null
    }

    /** 用 /state 快照拼出与 lib/panel.js buildProjectView 同形的视图（服务端旧版兜底）。 */
    var buildLocalView = function (state, project) {
      var index = taskIndex(state)
      var seen = new Set()
      var tasks = []
      index.forEach(function (t) {
        if (!t || seen.has(t.id)) return
        seen.add(t.id)
        if (t.projectId === project.id) tasks.push(t)
      })
      var agents = Object.values((state && state.agents) || {}).filter(function (a) { return a.projectId === project.id })
      var sessions = Object.values((state && state.agent_sessions) || {}).filter(function (r) { return r.projectId === project.id })
      var runs = Object.values((state && state.runs) || {}).filter(function (r) { return r.projectId === project.id && r.status === 'running' })
      var leases = Object.values((state && state.leases) || {}).filter(function (l) {
        var key = String((l && l.key) || '')
        if (key.indexOf('merge:') === 0) return key === 'merge:' + project.id
        if (key.indexOf('task:') === 0) {
          var t = index.get(key.slice(5))
          return !!t && t.projectId === project.id
        }
        return false
      })
      var approvals = Object.values((state && state.approvals) || {}).filter(function (a) {
        var t = index.get(a.taskId)
        return !!t && t.projectId === project.id
      })
      var laneOf = function (lane) {
        var lt = tasks.filter(function (t) { return (t.lane || 'human') === lane })
        var la = agents.filter(function (a) { return (a.lane || 'human') === lane })
        var ratios = la.map(function (a) {
          var rec = latestSessionOf(sessions, a.id)
          return Number(rec && rec.budget && rec.budget.ratio) || 0
        })
        return {
          lane: lane,
          tasks: lt.length,
          running: lt.filter(function (t) { return t.activeRunId }).length,
          blocked: lt.filter(function (t) { return t.blocked }).length,
          waitingWorker: lt.filter(function (t) { return t.phase === 'waiting-worker' }).length,
          waitingSupervisor: lt.filter(function (t) { return t.phase === 'waiting-supervisor' }).length,
          dispatchers: la.filter(function (a) { return a.role === 'dispatcher' }).length,
          workers: la.filter(function (a) { return a.role === 'worker' }).length,
          budget: {
            max: ratios.length ? Math.max.apply(null, ratios) : 0,
            avg: ratios.length ? ratios.reduce(function (n, r) { return n + r }, 0) / ratios.length : 0,
          },
        }
      }
      var byColumn = {}
      COLUMNS.forEach(function (c) { byColumn[c] = [] })
      tasks.forEach(function (t) {
        var card = {
          id: t.id, title: t.title, lane: t.lane || 'human', origin: t.origin || 'manual',
          column: t.column, phase: t.phase || '', version: t.version || 0,
          blocked: t.blocked ? { reason: t.blocked.reason, at: t.blocked.at } : null,
          assignee: t.assignee || null, activeRunId: t.activeRunId || null,
          plan: {
            revision: (t.plan && t.plan.revision) || 0,
            approvedRevision: t.plan && t.plan.approvedRevision !== undefined ? t.plan.approvedRevision : null,
            hasText: !!(t.plan && t.plan.text),
          },
          stopReport: t.stopReport && t.stopReport.summary ? { summary: t.stopReport.summary } : null,
          mergeRequest: t.mergeRequest
            ? { headSha: t.mergeRequest.headSha || null, status: t.mergeRequest.status || null, reviewVerdict: t.mergeRequest.reviewVerdict || null }
            : null,
          inspection: t.inspection || null,
          scope: t.scope || { paths: [], symbols: [] },
          subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
          dispatchedBy: t.dispatchedBy || null,
          dispatchReason: t.dispatchReason || null,
          reopenCount: t.reopenCount || 0,
          reopenRequested: t.reopenRequested
            ? { reason: t.reopenRequested.reason, by: t.reopenRequested.by, at: t.reopenRequested.at }
            : null,
          noMerge: t.noMerge === true,
          noMergeReason: t.noMergeReason || '',
          updatedAt: t.updatedAt || null,
        }
        if (!byColumn[t.column]) byColumn[t.column] = []
        byColumn[t.column].push(card)
      })
      var events = (state.events || [])
        .filter(function (e) { return e && e.type !== 'session.budget' })
        .filter(function (e) {
          var p = (e && e.payload) || {}
          if (p.taskId) {
            var t = index.get(p.taskId)
            return !!t && t.projectId === project.id
          }
          return p.projectId === project.id || e.type === 'project.created' || e.type === 'project.config' || e.type === 'project.lane.ensured'
        })
        .slice(-40)
        .reverse()
        .map(function (e) {
          return {
            id: e.id, type: e.type, at: e.at,
            text: describeEvent(e),
            actor: (e.actor && (e.actor.id || e.actor.role)) || 'system',
          }
        })
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        project: {
          id: project.id, name: project.name, path: project.workspacePath,
          workspaceId: project.workspaceId || null, chiefSessionId: project.chiefSessionId || null,
          config: project.config || {},
        },
        lanes: { human: laneOf('human'), issue: laneOf('issue') },
        columns: COLUMNS.map(function (id) {
          return { id: id, title: COLUMN_TITLES[id] || id, count: (byColumn[id] || []).length }
        }),
        tasks: byColumn,
        agents: agents.map(function (a) {
          var rec = latestSessionOf(sessions, a.id)
          return {
            id: a.id, name: a.name, role: a.role, slot: a.slot, lane: a.lane || 'human',
            supervisorId: a.supervisorId || null, enabled: a.enabled !== false,
            maxConcurrency: a.maxConcurrency || 1, model: a.model || null, provider: a.provider || null,
            preset: a.preset || null, promptOverlay: a.promptOverlay || '',
            sessionId: (rec && rec.sessionId) || null, budget: (rec && rec.budget) || null,
          }
        }),
        runs: runs.map(function (r) {
          return { runId: r.id, taskId: r.taskId, agentId: r.agentId, sessionId: r.sessionId || null, startedAt: r.startedAt, lastHeartbeat: r.lastHeartbeat || null }
        }),
        leases: leases.map(function (l) { return { key: l.key, owner: l.owner, token: l.token, expiresAt: l.expiresAt } }),
        approvals: approvals.slice(-20).reverse().map(function (a) {
          return {
            id: a.id, taskId: a.taskId, kind: a.kind,
            planRevision: a.planRevision === undefined ? null : a.planRevision,
            headSha: a.headSha === undefined ? null : a.headSha,
            by: a.actor || null, role: a.role || null,
            at: a.at, revokedAt: a.revokedAt || null, revokeReason: a.revokeReason || null,
          }
        }),
        events: events,
        totals: {
          tasks: tasks.length,
          running: tasks.filter(function (t) { return t.activeRunId }).length,
          blocked: tasks.filter(function (t) { return t.blocked }).length,
          approvals: approvals.filter(function (a) { return !a.revokedAt }).length,
        },
      }
    }

    /** 事件 → 一行人类可读文本（与服务端 describeEvent 保持一致）。 */
    var describeEvent = function (e) {
      var p = (e && e.payload) || {}
      var actor = (e && e.actor && (e.actor.id || e.actor.role)) || 'system'
      switch (e && e.type) {
        case 'task.created': return '新建任务 ' + (p.taskId || '') + '：' + (p.title || '')
        case 'task.moved': return (p.taskId || '') + ' → ' + (p.column || '') + (p.action ? '（' + p.action + '）' : '')
        case 'task.dispatched': return (p.taskId || '') + ' 已派工给 ' + (p.agentId || '')
        case 'task.run.ended': return (p.taskId || '') + ' 运行结束：' + (p.status || '')
        case 'task.inspection': return (p.taskId || '') + ' 巡检结论：' + (p.verdict || '')
        case 'task.blocked': return (p.taskId || '') + ' 被阻塞：' + (p.reason || '')
        case 'task.comment': return (p.taskId || '') + ' 新评论'
        case 'approval.recorded': return (p.taskId || '') + ' 审批：' + (p.kind || '') + (p.planRevision ? ' rev' + p.planRevision : '')
        case 'session.budget': return (p.agentId || '') + ' 上下文水位 ' + Math.round((Number(p.ratio) || 0) * 100) + '%'
        case 'agent.reparented': return (p.agentId || '') + ' 改派上级 → ' + (p.to || '无')
        case 'chief.session.bound': return '主调度绑定会话 ' + String(p.sessionId || '').slice(0, 12)
        case 'project.created': return '新建项目 ' + (p.name || '')
        case 'task.removed': return '删除任务 ' + (p.taskId || '')
        case 'project.removed': return '删除项目 ' + (p.name || '')
        default: return (e && e.type ? e.type : '事件') + ' · ' + actor
      }
    }

    // ---- 样式：全部走 DSH 设计令牌，跟随主题 --------------------------------
    var VIEW_CSS = [
      '#dsh-flow-entry{display:none!important}',
      '.flowv{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);background:var(--dsw-alias-bg-base)}',
      '.flowv *{box-sizing:border-box}',
      /* v0.011 视觉令牌：间距/字号/时长只在这里定义一次。
         原来 4px/6px/12px 与 120ms/180ms 散落在几百条规则里，想整体收紧一档只能全局搜索替换。 */
      '.flowv{--flowv-space-1:4px;--flowv-space-2:8px;--flowv-space-3:12px;--flowv-fs-xs:10.5px;--flowv-fs-sm:11.5px;--flowv-fs-md:12.5px;--flowv-t-fast:120ms;--flowv-t-med:180ms;--flowv-ease-drawer:cubic-bezier(.32,.72,0,1)}',
      /* 折叠块：标题整行可点，折叠态**不渲染**子节点（一屏 15 块全渲染是主要的 DOM 成本）。
         展开用 180ms 的淡入+下移 2px —— 不做高度动画：高度要测量 DOM，而测试里的 fake React 没有 DOM。 */
      '.flowv-fold{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-fold:first-child{border-top:none}',
      '.flowv-fold-head{display:flex;align-items:center;gap:6px;width:100%;padding:7px 0;background:none;border:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--flowv-fs-md);font-weight:600;text-align:left;cursor:pointer;line-height:1.4}',
      '.flowv-fold-head:hover{color:var(--dsw-alias-label-primary)}',
      '.flowv-fold-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px;border-radius:4px}',
      '.flowv-fold-caret{flex:0 0 auto;width:9px;font-size:9px;color:var(--dsw-alias-label-tertiary);transition:transform var(--flowv-t-fast) var(--flowv-ease-out)}',
      '.flowv-fold.is-open .flowv-fold-caret{transform:rotate(90deg)}',
      '.flowv-fold-sum{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;font-size:var(--flowv-fs-xs);color:var(--dsw-alias-label-tertiary);text-align:right}',
      '.flowv-fold-body{animation:flowv-fold-in var(--flowv-t-med) var(--flowv-ease-out) both}',
      '@keyframes flowv-fold-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){.flowv-fold-body{animation:none}.flowv-fold-caret{transition-duration:0ms}}',
      /* 顶栏「更多」：低频且危险的动作收在这里，主操作与危险操作分开。 */
      '.flowv-stats-more{flex:1 1 100%;border-top:1px solid var(--dsw-alias-border-l2);margin-top:4px}',
      '.flowv-stats-all{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:6px 0 2px}',
      '.flowv-menu{position:relative}',
      '.flowv-menu-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:260;min-width:190px;padding:4px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-module-platform);box-shadow:0 10px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:2px}',
      '.flowv-menu-pop .flowv-btn{justify-content:flex-start;width:100%}',

      /* 顶栏 */
      '.flowv-head{display:flex;align-items:center;gap:8px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap;position:sticky;top:0;background:var(--dsw-alias-bg-base);z-index:3}',
      '.flowv-name{font-size:13px;font-weight:600}',
      '.flowv-path{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34ch}',

      /* v1.31 请示箱 */
      /* 每一条请示是一张独立的卡：四段结构之间有呼吸，但不做成卡片套卡片。 */
      '.flowv-inbox-bar{display:flex;align-items:center;gap:8px;padding:0 0 8px}',
      /* 请示箱是"对话"不是"详情"：用窄抽屉，右侧留出看板可见区域。
         1040px 那版铺满整屏，人回复时看不到上下文，像被弹窗挡住。 */
      /* 头部用 flex：标题占主位，元信息靠右且不换行挤成竖排。 */
      '.flowv-inbox-hd{display:flex;align-items:flex-start;gap:8px;margin-bottom:4px}',
      '.flowv-inbox-hd b{flex:1;min-width:0;font-size:12.5px;line-height:1.45;word-break:break-word}',
      '.flowv-inbox-hd-right{display:flex;align-items:center;gap:6px;flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      /* 图标按钮：只放图标时用正方形容器，避免文字按钮被拉宽 */
      '.flowv-iconbtn{width:26px;height:26px;padding:0;justify-content:center;gap:0}',
      '.flowv-iconbtn svg{width:15px;height:15px;display:block}',
      /* 徽标：数字角标挂在图标右上角 */
      '.flowv-badge-wrap{position:relative;display:inline-flex}',
      '.flowv-badge{position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary,#4d6bfe));color:#fff;font-size:10px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none}',
      '.flowv-badge.is-idle{background:var(--dsw-alias-label-tertiary)}',
      /* 请示箱浮标：固定在右下角，任何滚动位置都点得到 */
      '.flowv-fab{position:fixed;right:20px;bottom:20px;z-index:240}',
      '.flowv-fab-btn{position:relative;width:44px;height:44px;border-radius:14px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;cursor:pointer;font:inherit;box-shadow:0 6px 20px rgba(0,0,0,.28);transition:transform var(--flowv-t-fast) var(--flowv-ease-out),background-color var(--flowv-t-fast) linear,color var(--flowv-t-fast) linear}',
      '.flowv-fab-btn svg{width:20px;height:20px}',
      '.flowv-fab-btn:hover{background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}',
      '.flowv-fab-btn:active{transform:scale(.94)}',
      /* 有未回复时用品牌色：不靠数字大小也能一眼看出"有东西等我" */
      '.flowv-fab-btn.is-active{background:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary,#4d6bfe));border-color:transparent;color:#fff}',
      '.flowv-fab-btn.is-active:hover{background:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary,#4d6bfe));color:#fff}',
      /* 分页"显示更多" */
      '.flowv-more{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 0;font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-sm,8px)}',
      '.flowv-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      /* 翻页条：上下各一条，做成"可以点的一行"，不要做成大按钮 ——
         它只是轻翻页，不是主操作，占用越小越好。 */
      '.flowv-more--up{margin-bottom:2px}',
      '.flowv-more--down{margin-top:2px}',
      '.flowv-more{user-select:none;line-height:1.6}',
      '.flowv-inbox-item{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-inbox-item:last-child{border-bottom:none}',
      '.flowv-inbox-hd{display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:4px}',
      '.flowv-inbox-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}',
      /* 四段：左侧固定宽度的标签列 + 右侧内容。标签窄、内容宽，扫读时眼睛不用来回跳。 */
      '.flowv-inbox-seg{display:flex;gap:10px;padding:5px 0;font-size:12px;line-height:1.55}',
      '.flowv-inbox-seg-k{flex:0 0 62px;color:var(--dsw-alias-label-tertiary);font-size:11px;padding-top:1px}',
      '.flowv-inbox-seg-v{flex:1;min-width:0;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}',
      /* v1.37：Inbox 工单化 —— 筛选栏 / 选项 / 对话线 / 通知条 */
      '.flowv-inbox-filters{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 18px;border-bottom:1px solid var(--dsw-alias-border-l2);position:sticky;top:0;background:var(--dsw-alias-bg-module-platform);z-index:2}',
      '.flowv-inbox-tabs{display:flex;gap:4px;align-items:center;flex-wrap:wrap}',
      '.flowv-inbox-tab{padding:3px 9px;font-size:11.5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.flowv-inbox-tab:hover{border-color:var(--dsw-alias-border-l4,var(--dsw-alias-border-l3))}',
      '.flowv-inbox-tab.on{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.flowv-inbox-options{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 4px}',
      '.flowv-inbox-option{padding:4px 10px;font-size:11.5px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}',
      '.flowv-inbox-option:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.flowv-inbox-option.is-rec{border-color:var(--dsw-alias-state-business-primary);font-weight:600}',
      /* v1.39 Inbox 结构化分区：概况条 / 现状 / 需要你补充 / 调度建议 / 处理记录 */
      '.flowv-inbox-item{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-module-platform);margin-bottom:10px}',
      '.flowv-inbox-item.is-open{border-color:var(--dsw-alias-border-l3)}',
      '.flowv-inbox-item.is-archived{opacity:.72}',
      '.flowv-ib-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer}',
      '.flowv-ib-head .flowv-inbox-meta{flex:1 1 100%;margin:6px 0 0;order:9}',
      '.flowv-ib-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:3px;border-radius:6px}',
      '.flowv-ib-title{font-size:13px;line-height:1.4;min-width:0;flex:1;overflow-wrap:anywhere}',
      '.flowv-ib-progress-chip{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
      '.flowv-ib-head-right{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-ib-status{white-space:nowrap}',
      '.flowv-ib-chev{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-ib-body{padding-top:10px;margin-top:10px;border-top:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px}',
      '.flowv-ib-problem{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
      '.flowv-ib-sec{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);padding:10px 12px;background:var(--dsw-alias-bg-base)}',
      '.flowv-ib-sec-h{margin:0 0 8px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}',
      '.flowv-ib-sec-n{margin-left:auto;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-ib-facts{margin:0;padding-left:18px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}',
      '.flowv-ib-facts li{margin:2px 0}',
      '.flowv-ib-prog{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:6px;line-height:1.6}',
      '.flowv-ib-prog-k{color:var(--dsw-alias-label-tertiary);margin-right:6px}',
      '.flowv-ask-ev{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}',
      '.flowv-ask-ev-item{font-size:10.5px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-ib-impact{border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-sm,8px);padding:8px 12px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}',
      '.flowv-ib-impact b{color:var(--dsw-alias-state-warn-primary);margin-right:6px}',
      '.flowv-ask{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);padding:10px;margin-top:8px;background:var(--dsw-alias-bg-module-platform)}',
      '.flowv-ask:first-of-type{margin-top:0}',
      '.flowv-ask.is-required{border-left:3px solid var(--dsw-alias-state-warn-primary)}',
      '.flowv-ask-hd{display:flex;align-items:baseline;gap:7px;font-size:12.5px;line-height:1.5}',
      '.flowv-ask-k{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.flowv-ask-type,.flowv-ask-req,.flowv-ask-opt{font-size:10.5px;white-space:nowrap}',
      '.flowv-ask-req,.flowv-ask-opt{margin-left:auto}',
      '.flowv-ask-type{color:var(--dsw-alias-label-tertiary)}',
      '.flowv-ask-req{color:var(--dsw-alias-state-warn-primary)}',
      '.flowv-ask-opt{color:var(--dsw-alias-label-tertiary)}',
      '.flowv-ask-why{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);margin:4px 0 8px}',
      '.flowv-ask-rec{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}',
      '.flowv-ask-rec-k{font-size:10.5px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-state-business-tertiary,#e6ecff);color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.flowv-ask-rec-why{color:var(--dsw-alias-label-tertiary);flex:1 1 100%}',
      '.flowv-ask-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px}',
      '.flowv-ask-confirm{display:flex;gap:6px}',
      '.flowv-ask-confirm .flowv-ask-choice{min-width:96px;align-items:center}',
      '.flowv-ask-confirm{flex-direction:row}',
      '.flowv-ask-choice{display:flex;flex-direction:column;gap:2px;text-align:left;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:1.5}',
      '.flowv-ask-choice:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.flowv-ask-choice.on{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.flowv-ask-choice:disabled{cursor:default;opacity:.7}',
      '.flowv-ask-choice:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
      '.flowv-ask-choice-impact{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
      '.flowv-ask-blocks{margin-top:6px;font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      '.flowv-ib-submit{display:flex;flex-direction:column;gap:8px}',
      '.flowv-inbox-acts{margin-top:2px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.flowv-ib-submit+.flowv-inbox-acts{margin-top:0}',
      '.flowv-ib-body>.flowv-ib-submit{margin-top:2px}',
      '.flowv-ib-body>.flowv-inbox-acts{border-top:0;padding-top:0}',
      '.flowv-ib-submit-bar{display:flex;align-items:center;gap:8px}',
      '.flowv-ib-missing{font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      '.flowv-ib-thread{padding:0;overflow:hidden}',
      '.flowv-ib-thread-toggle{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;background:var(--dsw-alias-bg-base);cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary);text-align:left}',
      '.flowv-ib-thread-toggle:hover{color:var(--dsw-alias-label-primary)}',
      '.flowv-ib-thread-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px}',
      '.flowv-ib-thread-sum{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.flowv-ib-thread-chev{margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-ib-timeline{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 12px;display:flex;flex-direction:column;gap:10px;max-height:340px;overflow:auto}',
      '.flowv-ib-msg{font-size:12px;line-height:1.6}',
      '.flowv-ib-msg.is-mine{padding-left:10px;border-left:2px solid var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.flowv-ib-msg-who{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}',
      '.flowv-ib-msg-kv{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.flowv-ib-answers{margin:6px 0 0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;font-size:11.5px}',
      '.flowv-ib-answer{display:contents}',
      '.flowv-ib-answers dt{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.flowv-ib-answers dd{margin:0;color:var(--dsw-alias-label-primary);font-weight:500;text-align:right}',
      '@media (prefers-reduced-motion:reduce){.flowv-ask-choice{transition:none}}',
      '.flowv-inbox-thread{margin:8px 0 2px;display:flex;flex-direction:column;gap:6px}',
      '.flowv-inbox-msg{max-width:86%;padding:6px 9px;border-radius:9px;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:1.5}',
      '.flowv-inbox-msg.is-mine{align-self:flex-end;border-color:var(--dsw-alias-state-business-secondary,var(--dsw-alias-border-l3));background:var(--dsw-alias-bg-module-platform)}',
      '.flowv-inbox-msg-who{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}',
      '.flowv-inbox-msg-body{white-space:pre-wrap;word-break:break-word}',
      '.flowv-inbox-info{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-inbox-info-tx{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.flowv-inbox-item.is-archived{opacity:.62}',
      '.flowv-inbox-replies{margin-top:8px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2)}',
      '.flowv-inbox-reply{font-size:12px;padding:5px 0;white-space:pre-wrap;word-break:break-word}',
      '.flowv-inbox-reply-who{display:block;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}',
      '.flowv-inbox-form{margin-top:10px}',
      '.flowv-inbox-ta{width:100%;min-height:74px;resize:vertical;box-sizing:border-box;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.55}',
      '.flowv-inbox-ta:focus{outline:none;border-color:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary,#4d6bfe))}',
      '.flowv-inbox-form-btns{display:flex;gap:8px;margin-top:8px}',
      '.flowv-inbox-acts{display:flex;gap:8px;margin-top:10px}',
      '.flowv-spacer{flex:1}',

      /* 按钮 */
      /* 动效令牌：只在这里定义曲线与时长，下面各处引用，不散落魔法数字。
         ease-out = 快进慢收，用于"进入"；ease-in 用于"退出"（收得比进得快，不拖沓）。 */
      /* 动效令牌：定义在组件容器上（不用 :root，免得全局可见）。
         只在这里写曲线与时长，下面各处引用，不散落魔法数字。 */
      '.flowv-body,.flowv-drawer,.flowv-modal{',
      '--flowv-ease-out:cubic-bezier(.23,1,.32,1);',
      '--flowv-ease-in:cubic-bezier(.4,0,1,1);',
      '--flowv-ease-drawer:cubic-bezier(.32,.72,0,1);',
      '--flowv-t-fast:120ms;',
      '--flowv-t-panel:260ms;',
      '}',

      '.flowv-btn{height:26px;padding:0 9px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}',
      '.flowv-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      /* 按压反馈：只在按下那一瞬缩一点点，手指/鼠标才觉得"点到了"。
         100ms 快到几乎无感 —— 按钮一天要按几十次，绝不能拖。 */
      '.flowv-btn{transition:transform var(--flowv-t-fast) var(--flowv-ease-out),background-color var(--flowv-t-fast) linear,color var(--flowv-t-fast) linear,border-color var(--flowv-t-fast) linear}',
      '.flowv-btn:active:not(:disabled){transform:scale(.97)}',
      '.flowv-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.flowv-btn:disabled{opacity:.45;cursor:default}',
      '.flowv-btn-primary{border-color:transparent;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-inverted)}',
      '.flowv-btn-primary:hover{background:var(--dsw-alias-button-info-hover);color:var(--dsw-alias-label-primary-inverted)}',
      '.flowv-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-secondary) 55%,transparent)}',
      '.flowv-btn-danger:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.flowv-btn-sm{height:22px;font-size:11px;padding:0 7px}',

      /* 主体：顶部摘要条（统计 + 车道）→ 看板 → 分区网格 */
      '.flowv-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 150px}',
      '.flowv-top{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:stretch;margin-bottom:12px}',
      /* v1.21：不再抢宽度——1920 下 6 个 chip 只到 x=440，却把整条占成 769px，尾部空一大片 */
      '.flowv-stats{display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:0 1 auto;min-width:0;align-content:flex-start}',
      '.flowv-stat{display:inline-flex;align-items:baseline;gap:5px;padding:3px 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}',
      '.flowv-stat b{font-size:13px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.flowv-stat span{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-stat.is-warn{border-color:var(--dsw-alias-state-warn-secondary)}',
      '.flowv-stat.is-warn b{color:var(--dsw-alias-state-warn-primary)}',
      '.flowv-stat.is-bad{border-color:var(--dsw-alias-state-error-secondary)}',
      '.flowv-stat.is-bad b{color:var(--dsw-alias-state-error-primary)}',
      '.flowv-stat.is-ok b{color:var(--dsw-alias-state-success-primary)}',
      '.flowv-stat.is-info b{color:var(--dsw-alias-state-business-primary)}',
      '.flowv-stats{flex-wrap:wrap;row-gap:5px}',
      '.flowv-stats-sep{width:1px;height:18px;background:var(--dsw-alias-border-l2);align-self:center;margin:0 2px}',
      '.flowv-stat-group{display:flex;align-items:center;gap:4px}',
      '.flowv-stat-grp-label{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em;padding-right:4px;align-self:center}',


      /* 车道：压成两条窄带，和统计条同一行；窄屏整行换下去 */
      '.flowv-lanes{display:flex;flex-direction:column;gap:2px;flex:1 1 380px;max-width:none}',
      // 收起态的宽度要压过 .flowv-col.has-tasks / .is-empty（同为两类的选择器，后写者赢）—— 所以两个都写。
      '.flowv-col.has-tasks.is-collapsed,.flowv-col.is-empty.is-collapsed{flex:0 0 46px;min-width:46px;max-width:46px;overflow:hidden}',
      '.flowv-col.is-collapsed .flowv-col-head{flex-direction:column;align-items:flex-start;gap:2px;padding:7px 6px;border-bottom:0;background:none;cursor:pointer}',
      '.flowv-col-head{background:none;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);font:inherit;color:inherit;cursor:pointer;text-align:left;width:100%}',
      '.flowv-col-head:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#2f6feb);outline-offset:-2px}',
      '.flowv-task:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#2f6feb);outline-offset:2px}',
      '.flowv-task:active{transform:scale(.99)}',
      '.flowv-drawer-lead{display:flex;align-items:center;gap:8px;padding:6px 10px;margin:6px 0 2px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);font-size:var(--flowv-fs-sm)}',
      '.flowv-drawer-lead.is-bad{border-color:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.flowv-lead-col{flex:none;font-size:var(--flowv-fs-xs);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.flowv-lead-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.flowv-card-fold>.flowv-fold-head{display:flex;align-items:center;gap:6px}',
      '.flowv-fold-btn{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:0;border:0;background:none;cursor:pointer;text-align:left;color:inherit;font:inherit}',
      '.flowv-fold-btn:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#2f6feb);outline-offset:2px;border-radius:4px}',
      '.flowv-fold-caret{display:inline-block;transition:transform var(--flowv-t-fast) var(--flowv-ease-out);color:var(--dsw-alias-label-tertiary);font-size:10px}',
      '.flowv-card-fold.is-open .flowv-fold-caret,.flowv-fold.is-open .flowv-fold-caret{transform:rotate(90deg)}',
      '.flowv-fold-sum{flex:none;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--flowv-fs-xs);color:var(--dsw-alias-label-tertiary)}',
      '.flowv-fold-body{animation:flowv-fold-in 180ms var(--flowv-ease-out)}',
      '@keyframes flowv-fold-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){.flowv-fold-body{animation:none}.flowv-fold-caret{transition:none}}',
      '.flowv-lane-row{display:flex;align-items:center;gap:8px;min-height:24px;font-size:var(--flowv-fs-sm)}',
      '.flowv-lane-name{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.flowv-lane-meta{font-size:var(--flowv-fs-xs);color:var(--dsw-alias-label-tertiary)}',
      '.flowv-lane-water{position:relative;width:64px;height:2px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}',
      '.flowv-lane-water i{display:block;height:100%;background:var(--dsw-alias-label-secondary)}',
      '.flowv-lane-water.warn i{background:var(--dsw-alias-state-warning-primary,#c98a00)}',
      '.flowv-lane-water.bad i{background:var(--dsw-alias-state-error-primary,#d9534f)}',
      '@media(max-width:1180px){.flowv-lanes{flex-basis:100%;max-width:none}}',
      '.flowv-lane{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);padding:9px 12px 10px;background:var(--dsw-alias-bg-module-platform)}',
      '.flowv-lane-title{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center;margin-bottom:5px;font-weight:500}',
      '.flowv-meter{margin-top:8px}',
      '.flowv-meter-row{display:flex;justify-content:space-between;align-items:baseline;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}',
      '.flowv-meter-row b{font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.flowv-bar{height:4px;border-radius:3px;background:var(--dsw-alias-border-l2);overflow:hidden}',
      '.flowv-bar>i{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary);transition:width var(--flowv-t-panel) var(--flowv-ease-out)}',
      '.flowv-bar.warn>i{background:var(--dsw-alias-state-warn-primary)}',
      '.flowv-bar.bad>i{background:var(--dsw-alias-state-error-primary)}',

      /* chips / tags */
      '.flowv-request{border:1px solid var(--dsw-alias-state-warn-secondary);border-left-width:3px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-module-platform);padding:11px 12px;margin-bottom:12px}',
      '.flowv-request>b{display:block;font-size:12.5px;font-weight:600;color:var(--dsw-alias-state-warn-primary);margin-bottom:6px}',
      '.flowv-request-why{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap}',
      '.flowv-request-by{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-chip{font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;line-height:18px}',
      '.flowv-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-secondary)}',
      '.flowv-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-secondary)}',
      '.flowv-chip.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}',
      '.flowv-chip.info{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-tertiary)}',

      /* 看板 */
      /* 看板标题行：让人知道这块是主区，且能横向滚动 */
      '.flowv-board-head{display:flex;align-items:baseline;gap:8px;margin:2px 0 8px}',
      '.flowv-board-title{font-size:12.5px;font-weight:600;letter-spacing:-.01em}',
      '.flowv-board-head .flowv-hint{margin:0}',
      /* C-03：自动车道（auto 卡不上板，但要看得见）。标题行常驻，展开后是台账。 */
      '.flowv-auto-head{display:flex;align-items:baseline;gap:8px;margin:0 0 6px}',
      '.flowv-auto-toggle{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:999px;cursor:pointer}',
      '.flowv-auto-toggle:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
      '.flowv-auto-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px}',
      '.flowv-auto-toggle .n{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.flowv-auto-list{max-height:220px;overflow:auto;overscroll-behavior:contain;margin:0;padding:0;list-style:none}',
      '.flowv-auto-row{display:flex;align-items:baseline;gap:6px;padding:3px 0;font-size:11.5px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-auto-row:last-child{border-bottom:0}',
      '.flowv-auto-row:hover{color:var(--dsw-alias-label-primary)}',
      '.flowv-auto-row .id{font-family:var(--dsw-font-family,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.flowv-auto-row .ttl{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.flowv-auto-row .col{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-auto-row.is-bad .col,.flowv-auto-row.is-bad .ttl{color:var(--dsw-alias-state-error-primary)}',
      /* 横向滚动：列会被拉伸填满可用宽度，窄屏才滚动（比固定 190px 更容易读卡片）
         v1.21：align-items 从 flex-start 改 stretch——七列等高，空列不再是一条断掉的细条 */
      '.flowv-cols{display:flex;gap:10px;overflow-x:auto;padding-bottom:10px;align-items:stretch;scrollbar-gutter:stable}',
      '.flowv-col{flex:1 1 0;min-width:104px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:transparent;display:flex;flex-direction:column}',
      /* v1.21：空列固定 108px 只放一句列说明，宽度全部让给有卡的列。
         1920 下七列原来是 [187×5,420,187]，6 个空列吃掉 1150px 却只有 35px 高。 */
      '.flowv-col.is-empty{flex:0 0 108px;min-width:96px}',
      '.flowv-col.is-empty .flowv-col-body{display:flex;padding:8px 8px 10px}',
      '.flowv-col-hint{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.flowv-col.has-tasks{flex:1 1 240px;min-width:220px;max-width:none}',
      /* 有卡列宽到一定程度就把卡片横排，别让窄屏下挤成一列长条 */
      '.flowv-col.has-tasks .flowv-col-body{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));align-content:start}',
      '.flowv-col.is-running{border-color:var(--dsw-alias-state-business-tertiary);background:color-mix(in srgb,var(--dsw-alias-state-business-tertiary) 22%,transparent)}',
      '.flowv-col.is-terminal{opacity:.78}',
      '.flowv-col-head{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.flowv-col-head b{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-weight:500;font-variant-numeric:tabular-nums;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;line-height:16px}',
      '.flowv-col.is-running .flowv-col-head b{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-tertiary)}',
      '.flowv-col-body{padding:6px;display:flex;flex-direction:column;gap:6px;min-height:38px;flex:1}',
      /* 列内滚动：固定页数之后列还可能很长（每张卡 60px+），
         列一长整页就被撑开，看板失去"一眼扫完"的作用。
         给它一个上限高度 + 内部滚动，页面高度就收敛了。
         上限用 vh 而不是 px：窗口大小不同都能按比例收敛。 */
      '.flowv-col.has-tasks .flowv-col-body{max-height:min(62vh,720px);overflow-y:auto;overscroll-behavior:contain}',
      /* 滚动条要跟主题走：默认那根白色亮条在暗色界面上像一道裂口。 */
      '.flowv-col-body{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l3) transparent}',
      '.flowv-col-body::-webkit-scrollbar{width:8px}',
      '.flowv-col-body::-webkit-scrollbar-track{background:transparent}',
      '.flowv-col-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:4px;border:2px solid transparent;background-clip:padding-box}',
      '.flowv-col-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary);background-clip:padding-box}',
      '.flowv-task{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px 8px;cursor:pointer;background:var(--dsw-alias-bg-module-platform);transition:border-color var(--flowv-t-fast) linear,transform var(--flowv-t-fast) var(--flowv-ease-out)}',
      '.flowv-task:hover{border-color:var(--dsw-alias-border-l4,var(--dsw-alias-border-l3))}',
      '@media (hover:hover) and (pointer:fine){',
      '.flowv-task:hover{transform:translateY(-1px)}',
      '}',
      '.flowv-task:active{transform:translateY(0) scale(.995)}',
      '.flowv-task:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.flowv-task.blocked{border-color:var(--dsw-alias-state-error-secondary);box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary)}',
      '.flowv-task-id{display:flex;align-items:center;gap:5px;font-family:var(--dsw-font-family,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.2}',
      '.flowv-task-title{font-size:12.5px;line-height:1.45;margin:4px 0 7px;font-weight:550;letter-spacing:-.005em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.flowv-task-meta{display:flex;flex-wrap:wrap;gap:3px;align-items:center}',
      '.flowv-task-cmt{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:5px;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.flowv-task-row2{font-size:11.5px;line-height:1.4;margin:3px 0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.flowv-task-row2.is-blocked{color:var(--dsw-alias-state-error-primary)}',
      '.flowv-task-row2.is-progress{color:var(--dsw-alias-label-secondary)}',
      '.flowv-task-row3{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-task-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;display:inline-block;margin-right:2px}',
      '.flowv-task-dot.on-track{background:var(--dsw-alias-state-success-primary,#4CAF50)}',
      '.flowv-task-dot.waiting{background:var(--dsw-alias-state-warn-primary,#FFC107)}',
      '.flowv-task-dot.blocked{background:var(--dsw-alias-state-error-primary,#f44336)}',
      '.flowv-task-dot.partial{background:var(--dsw-alias-state-warn-primary,#FF9800)}',
      '.flowv-task-dot.done{background:var(--dsw-alias-state-success-primary,#2196F3)}',
      '.flowv-task-dot.none{background:var(--dsw-alias-border-l3)}',

      /* 分区列表：看板下面排成网格，别再把页面拉成一条长龙。
         v1.21：auto-fit 在宽屏会排成 3 列，4 段里落单 1 个、右侧空两列。改成显式列数。
         顺序要紧：同特异性下后写的胜出，所以「基础 1 列 → 1100 两列 → 1780 四列」。 */
      '.flowv-sections{display:grid;grid-template-columns:1fr;gap:14px 22px;margin-top:16px;align-items:start}',
      '@media (min-width:1100px){.flowv-sections{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (min-width:1780px){.flowv-sections{grid-template-columns:repeat(4,minmax(0,1fr))}}',
      '.flowv-sections>.flowv-sec{margin-top:0}',
      '.flowv-quiet{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2);font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-sec{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2);min-width:0}',
      '.flowv-sec>h4{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 7px;display:flex;align-items:center;gap:6px;letter-spacing:.01em}',
      '.flowv-list{margin:0;padding:0;list-style:none}',
      /* 分区网格里最长的一块（事务事件）动辄几十行，限高滚动免得把整行撑出半屏空白 */
      '.flowv-sections .flowv-list{max-height:264px;overflow:auto;overscroll-behavior:contain}',
      '.flowv-list li{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0;display:flex;gap:7px}',
      '.flowv-list time{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;font-variant-numeric:tabular-nums}',
      '.flowv-sec-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0 0}',
      '.flowv-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,10px);padding:20px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.flowv-err{margin:8px 14px;padding:8px 11px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary);font-size:11.5px}',
      /* v1.25 修：操作反馈必须是 toast，不能留在文档流里。
         线上真实事故：抽屉打开时点「提交待批」「批准开工」，接口 400 已经把原因返回、
         notice 也确实渲染了，但它留在 .flowv-flow 的文档流里（z-index:auto），
         而抽屉遮罩是 fixed + z-index:220 —— elementFromPoint 命中的是遮罩。
         用户看到的就是"点了一下什么都没发生"，同一份错误提示写了却没人看得见。 */
      '.flowv-note{position:fixed;left:50%;transform:translateX(-50%);top:12px;margin:0;padding:9px 12px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-size:11.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:min(720px,92vw);z-index:260;box-shadow:0 6px 24px rgba(0,0,0,.18)}',
      '.flowv-loading{padding:20px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px}',

      /* 抽屉：任务详情 */
      /* 遮罩：淡入淡出，别用瞬间显隐（那一下最"跳"） */
      '.flowv-drawer-mask{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:220;opacity:0;transition:opacity 220ms var(--flowv-ease-out)}',
      '.flowv-drawer-mask.is-open{opacity:1}',
      '.flowv-drawer-mask.is-closing{opacity:0;pointer-events:none}',
      /* 抽屉从右侧来、回右侧去（空间一致性：进出同一边） */
      '.flowv-drawer{position:fixed;top:0;right:0;bottom:0;width:min(1040px,94vw);background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;z-index:221;box-shadow:var(--dsw-elevation-panel,0 8px 30px rgba(0,0,0,.18));transform:translateX(100%);transition:transform 260ms var(--flowv-ease-drawer)}',
      '.flowv-drawer.is-open{transform:translateX(0)}',
      /* 窄版抽屉必须写在 .flowv-drawer 之后：两选择器优先级相同，后定义的胜出。
         放到前面会被 1040px 覆盖，表现为「设了窄版却还是铺满」。 */
      '.flowv-drawer--narrow{width:min(560px,94vw)}',
      '.flowv-drawer.flowv-sheet.flowv-drawer--narrow{width:auto}',
      /* v1.39：详情层改为覆盖整个调度台视图的全屏层（不再是右侧抽屉） */
      '.flowv{position:relative}',
      '.flowv-sheet-stack{position:absolute;inset:0;z-index:220;pointer-events:none}',
      '.flowv-sheet-layer{position:absolute;inset:0;pointer-events:auto}',
      '.flowv-sheet-layer.is-under{pointer-events:none}',
      '.flowv-sheet-mask{position:absolute;inset:0;background:rgba(0,0,0,.32)}',
      '.flowv-sheet-mask.is-under{background:rgba(0,0,0,.14)}',
      '.flowv-drawer.flowv-sheet{position:absolute;top:0;right:0;bottom:0;left:0;width:auto;height:auto;border-left:0;box-shadow:none;transform:translateY(10px);opacity:0;transition:transform 200ms var(--flowv-ease-out),opacity 160ms linear;border-radius:0}',
      '.flowv-drawer.flowv-sheet.is-open{transform:translateY(0);opacity:1}',
      '.flowv-drawer.flowv-sheet.is-closing{transform:translateY(6px);opacity:0;pointer-events:none}',
      '.flowv-sheet .flowv-drawer-head{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base)}',
      // 全屏之后正文要自己收住可读宽度（75–90 字符），否则一行横跨整个屏幕
      '.flowv-sheet .flowv-drawer-body{max-width:1180px;margin:0 auto;width:100%}',
      '.flowv-sheet .flowv-drawer-body>*{min-width:0}',
      '@media(min-width:1500px){.flowv-sheet .flowv-drawer-body{grid-template-columns:minmax(0,1fr) 320px}}',
      '.flowv-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-width:0}',
      '.flowv-crumb{border:0;background:none;padding:2px 5px;border-radius:5px;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-family:inherit}',
      '.flowv-crumb:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
      '.flowv-crumb.is-current{color:var(--dsw-alias-label-primary);font-weight:600;cursor:default}',
      '.flowv-crumb:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}',
      '.flowv-crumb-sep{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      /* v1.39 工作包工单 / 子任务列表 */
      '.flowv-tk-row{display:flex;gap:10px;padding:6px 0;font-size:12px;line-height:1.6;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.flowv-tk-row:first-child{border-top:0}',
      '.flowv-tk-k{flex:0 0 76px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;padding-top:1px}',
      '.flowv-tk-v{flex:1;min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.flowv-tk-src{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;height:16px;line-height:15px}',
      '.flowv-tk-row.is-flagged .flowv-tk-src{color:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:currentColor}',
      '.flowv-tk-chips{display:flex;flex-wrap:wrap;gap:5px}',
      '.flowv-tk-chips code{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-tk-acc{margin:0;padding-left:18px}',
      '.flowv-tk-dep{border:1px solid var(--dsw-alias-border-l2);background:none;border-radius:5px;padding:1px 7px;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-family:inherit}',
      '.flowv-tk-dep:hover{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:var(--dsw-alias-label-primary)}',
      '.flowv-kids{display:flex;flex-direction:column;gap:6px}',
      '.flowv-kid{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base);cursor:pointer;color:var(--dsw-alias-label-primary);font-family:inherit}',
      '.flowv-kid:hover{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.flowv-kid:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
      '.flowv-kid.is-blocked{border-left:3px solid var(--dsw-alias-state-error-primary)}',
      '.flowv-kid-id{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.flowv-kid-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.flowv-kid-col{font-size:11px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.flowv-kid-who{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.flowv-kid-dep{font-size:10.5px;color:var(--dsw-alias-state-warn-primary);flex:0 0 auto}',
      '.flowv-kid-chev{color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '@media (prefers-reduced-motion:reduce){.flowv-drawer.flowv-sheet{transition:none;transform:none}}',
      /* 窄抽屉里 body 必须是单列：.flowv-drawer-body 默认是「1fr + 300px 侧栏」，
         那是给任务详情（左内容右上下文）设计的。请示箱只有一列内容，
         沿用两列会把标题和提示文字挤进 260px 的窄格里，读起来像被切碎。 */
      '.flowv-drawer--narrow .flowv-drawer-body{grid-template-columns:minmax(0,1fr)}',
      /* 首次挂载即 is-open：没有起始态就不会过渡。@starting-style 补上这一帧，
         省掉 JS 里 requestAnimationFrame 那套双帧写法。 */
      '@starting-style{',
      '.flowv-drawer.is-open{transform:translateX(100%)}',
      '.flowv-drawer-mask.is-open{opacity:0}',
      '.flowv-modal.is-open{transform:scale(.96);opacity:0}',
      '.flowv-modal-mask.is-open{opacity:0}',
      '}',
      '.flowv-drawer.is-closing{transform:translateX(100%);transition-duration:180ms;transition-timing-function:var(--flowv-ease-in)}',
      '.flowv-drawer-head{display:flex;align-items:center;gap:8px;padding:11px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap;background:var(--dsw-alias-bg-module-platform)}',
      '.flowv-drawer-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 24px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-content:start}',
      '@media(max-width:1180px){.flowv-drawer-body{grid-template-columns:minmax(0,1fr) 264px}}',
      '.flowv-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-module-platform);margin-bottom:10px;overflow:hidden}',
      '.flowv-card>h6{margin:0;padding:8px 11px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-base)}',
      '.flowv-card>h6 .n{margin-left:auto;font-weight:400}',
      '.flowv-card-bd{padding:10px 11px}',
      '.flowv-input,.flowv-textarea,.flowv-select{width:100%;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);color:inherit;font:inherit;font-size:12px;padding:6px 8px}',
      '.flowv-textarea{resize:vertical;line-height:1.5}',
      '.flowv-input:focus,.flowv-textarea:focus,.flowv-select:focus{outline:none;border-color:var(--dsw-focus-ring-color,currentColor)}',
      '.flowv-title-input{font-size:15px;font-weight:600;padding:8px 10px;letter-spacing:-.01em}',
      '.flowv-kv{display:grid;grid-template-columns:84px minmax(0,1fr);gap:4px 8px;margin:0;font-size:11.5px}',
      '.flowv-kv dt{color:var(--dsw-alias-label-tertiary)}',
      '.flowv-kv dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.flowv-mono{font-family:var(--dsw-font-family,monospace);font-size:11px}',
      '.flowv-actions{display:flex;flex-wrap:wrap;gap:6px}',
      '.flowv-accept{list-style:none;margin:0;padding:0}',
      '.flowv-accept li{display:flex;align-items:flex-start;gap:6px;font-size:11.5px;padding:2px 0;color:var(--dsw-alias-label-secondary)}',
      '.flowv-accept li span{flex:1}',
      /* 评论列表限高滚动：23 条日志式评论曾把抽屉拉到 7000px */
      '.flowv-cmt-list{max-height:min(60vh,640px);overflow:auto;overscroll-behavior:contain;padding-right:4px}',
      '.flowv-cmt{display:flex;gap:7px;margin-bottom:8px}',
      '.flowv-cmt+.flowv-cmt{padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-cmt-ava{flex:0 0 auto;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
      '.flowv-cmt-ava.ok{border-color:var(--dsw-alias-state-success-secondary);color:var(--dsw-alias-state-success-primary)}',
      '.flowv-cmt-ava.warn{border-color:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-state-warn-primary)}',
      '.flowv-cmt-ava.info{border-color:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}',
      '.flowv-cmt-box{flex:1;min-width:0}',
      '.flowv-cmt-hd{display:flex;gap:6px;align-items:baseline;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-cmt-hd b{color:var(--dsw-alias-label-secondary);font-weight:500;font-size:11px}',
      '.flowv-cmt-tx{font-size:12px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin-top:1px}',
      /* v1.38 详情抽屉：降低信息密度 —— 更大的留白、统一 8px 节奏、元信息降级 */
      '.flowv-drawer-body{padding:18px 22px 28px;gap:18px}',
      '.flowv-card{margin-bottom:14px}',
      '.flowv-card>h6{padding:9px 14px;font-size:12px}',
      '.flowv-card-bd{padding:12px 14px}',
      '.flowv-kv{gap:7px 10px;font-size:12px}',
      '.flowv-accept li{padding:5px 0;font-size:12.5px;line-height:1.55}',
      '.flowv-accept li+li{border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.flowv-cmt{gap:10px;margin-bottom:0;padding:12px 0}',
      '.flowv-cmt:first-child{padding-top:2px}',
      '.flowv-cmt+.flowv-cmt{padding-top:12px}',
      '.flowv-cmt-ava{width:24px;height:24px;font-size:11px}',
      '.flowv-cmt-hd{gap:8px;margin-bottom:4px;font-size:11px}',
      '.flowv-cmt-hd b{font-size:12px;font-weight:600}',
      '.flowv-cmt-id{margin-left:auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:10px;opacity:0;transition:opacity .15s}',
      '.flowv-cmt:hover .flowv-cmt-id{opacity:.7}',
      '.flowv-cmt-md.flowv-md>*{font-size:12.5px;line-height:1.65}',
      '.flowv-cmt-md.flowv-md p{margin:0 0 6px}',
      '.flowv-cmt-md.flowv-md code{font-size:11.5px}',
      '.flowv-cmt-body{position:relative}',
      '.flowv-jump{position:absolute;right:14px;bottom:18px;z-index:5;display:flex;flex-direction:column;gap:8px}',
      '.flowv-jump-btn{width:34px;height:34px;border-radius:50%;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);transition:opacity .18s,transform .18s,color .15s}',
      '.flowv-jump-btn:hover{color:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:currentColor}',
      '.flowv-jump-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
      '.flowv-jump-btn.is-hidden{opacity:0;transform:translateY(6px);pointer-events:none}',
      '@media (prefers-reduced-motion:reduce){.flowv-jump-btn{transition:none}}',
      '.flowv-cmt-body.is-clamped{max-height:240px;overflow:hidden}',
      '.flowv-cmt-body.is-clamped::after{content:"";position:absolute;left:0;right:0;bottom:0;height:56px;background:linear-gradient(transparent,var(--dsw-alias-bg-module-platform));pointer-events:none}',
      '.flowv-cmt-more{position:relative;z-index:1;margin-top:4px;padding:2px 0;border:0;background:none;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.flowv-cmt-body.is-clamped .flowv-cmt-more{position:absolute;bottom:2px;left:0}',
      '.flowv-cmt-more:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:3px}',
      '.flowv-prog-sum{font-size:13px;line-height:1.6;margin-bottom:8px;color:var(--dsw-alias-label-primary)}',
      '.flowv-prog-list{margin:0 0 8px;padding-left:18px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.flowv-prog-next{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.flowv-prog-meta{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}',

      /* Markdown：复用官方 MarkdownText(compact)，这里只收口密度与配色。
         双类选择器是为了压过 primitives 的 CSS Modules 哈希类，不依赖注入顺序。 */
      '.flowv-md.flowv-md{margin-top:2px;min-width:0}',
      '.flowv-md.flowv-md>*{color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.6}',
      '.flowv-md.flowv-md h1,.flowv-md.flowv-md h2,.flowv-md.flowv-md h3,.flowv-md.flowv-md h4,.flowv-md.flowv-md h5,.flowv-md.flowv-md h6{font-size:12.5px;font-weight:600;line-height:1.5;margin:8px 0 4px}',
      '.flowv-md.flowv-md>*:first-child{margin-top:0}',
      '.flowv-md.flowv-md>*:last-child{margin-bottom:0}',
      '.flowv-md.flowv-md ul,.flowv-md.flowv-md ol{padding-left:18px;margin:4px 0}',
      '.flowv-md.flowv-md li{margin:2px 0}',
      '.flowv-md.flowv-md pre{max-height:420px;overflow:auto;font-size:11.5px}',
      '.flowv-md.flowv-md table{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.flowv-md.flowv-md th,.flowv-md.flowv-md td{border:1px solid var(--dsw-alias-border-l2);padding:3px 6px;text-align:left}',
      '.flowv-md.flowv-md blockquote{border-left:2px solid var(--dsw-alias-border-l3);padding-left:8px;margin:6px 0;color:var(--dsw-alias-label-secondary)}',
      '.flowv-chip-rmt{text-decoration:none;color:var(--dsw-alias-label-secondary,#666)}',
  '.flowv-chip-rmt:hover{color:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary,#4d6bfe));text-decoration:underline}',
  '.flowv-cmt-src{margin-left:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);text-decoration:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px}',
  '.flowv-cmt-src:hover{color:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary,#4d6bfe));border-color:currentColor}',
  // v1.24 停止横幅：必须"吵"，否则人会以为系统在跑只是不动。
  // 用 warn 令牌而不是 error：这不是故障，是人自己按的。
  '.flowv-halt{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 14px;font-size:12px;border-bottom:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-label-primary)}',
  '.flowv-halt-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:0 0 auto}',
  '.flowv-halt-at{color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
  '.flowv-plain{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}',
      // 预览态保持和 textarea（6 行）差不多高，切换时卡片不跳
      '.flowv-note-preview{min-height:118px;padding-top:2px}',

      /* 弹窗：新建任务 / 项目设置 */
      '.flowv-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:230;display:grid;place-items:center;opacity:0;transition:opacity 160ms var(--flowv-ease-out)}',
      '.flowv-modal-mask.is-open{opacity:1}',
      '.flowv-modal-mask.is-closing{opacity:0;pointer-events:none}',
      /* 弹窗居中、没有空间来源 → 只做 scale+opacity，从不 scale(0) */
      '.flowv-modal{width:min(680px,94%);max-height:86vh;max-height:86dvh;min-height:0;overflow:hidden;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-elevation-prominent,0 20px 48px rgba(0,0,0,.24));transform:scale(.96);opacity:0;transition:transform 160ms var(--flowv-ease-out),opacity 160ms linear}',
      '.flowv-modal.is-open{transform:scale(1);opacity:1}',
      '.flowv-modal.is-closing{transform:scale(.98);opacity:0;transition-duration:120ms}',
      '.flowv-modal-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:13px;font-weight:600}',
      '.flowv-modal-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 20px}',
      '.flowv-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-field{margin-bottom:10px}',
      '.flowv-field>label{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}',
      '.flowv-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:3px}',
      '.flowv-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.flowv-agent-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11.5px}',
      '.flowv-agent-row:last-child{border-bottom:0}',
      '.flowv-agent-name{font-weight:500;min-width:76px}',
      '.flowv-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.flowv-tab{padding:4px 9px;font-size:11.5px;border-radius:var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px) 0 0;border:1px solid transparent;border-bottom:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit}',
      '.flowv-tab.on{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',

      '@media(max-width:900px){.flowv-lanes{grid-template-columns:1fr}.flowv-drawer-body{grid-template-columns:1fr}.flowv-drawer{width:100%}}',

      /* ---- v0.012：工单箱改成两栏邮箱 ----------------------------------
         左列表 / 右详情。理由不是好看：工单是逐条处理的，两栏让"一次只读一条"
         成为版式的事实，而不是靠人自己克制。 */
      '.flowv-drawer--wide{width:min(1040px,96vw)}',
      '.flowv-mail{display:grid;grid-template-columns:300px minmax(0,1fr);flex:1;min-height:0;overflow:hidden}',
      '.flowv-mail-side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}',
      '.flowv-mail-side-hd{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-mail-unread{font-size:10.5px;line-height:1.5;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted)}',
      '.flowv-mail-search{margin:8px 12px 0;width:auto;flex:0 0 auto}',
      '.flowv-mail-tabs{display:flex;gap:2px;padding:8px 8px 6px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-mail-tab{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;padding:4px 6px;font-size:11px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background var(--flowv-t-fast) var(--flowv-ease-out)}',
      '.flowv-mail-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.flowv-mail-tab.on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
      '.flowv-mail-tab:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.flowv-mail-tab-n{font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.flowv-mail-list{flex:1;min-height:0;overflow:auto;padding:4px}',
      '.flowv-mail-row{display:flex;gap:8px;width:100%;text-align:left;padding:8px;border:none;border-radius:8px;background:transparent;cursor:pointer;color:inherit;transition:background var(--flowv-t-fast) var(--flowv-ease-out)}',
      '.flowv-mail-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.flowv-mail-row.is-sel{background:var(--dsw-alias-bg-base);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3)}',
      '.flowv-mail-row:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.flowv-mail-dot{flex:0 0 auto;width:6px;height:6px;margin-top:5px;border-radius:50%;background:transparent}',
      '.flowv-mail-row.is-unread .flowv-mail-dot{background:var(--dsw-alias-state-business-primary)}',
      '.flowv-mail-row-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}',
      '.flowv-mail-row-top{display:flex;align-items:center;gap:6px;justify-content:space-between}',
      '.flowv-mail-row-time{font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:0 0 auto}',
      '.flowv-mail-row-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
      '.flowv-mail-row.is-unread .flowv-mail-row-title{font-weight:700}',
      '.flowv-mail-row-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-mail-row-keep{font-size:9.5px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-business-primary)}',
      '.flowv-mail-main{display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.flowv-mail-main-in{padding:14px 18px 30px}',
      '.flowv-mail-empty{margin:auto;display:flex;flex-direction:column;gap:6px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:40px}',
      '.flowv-mail-task{font-family:var(--dsw-font-mono,ui-monospace);font-size:11px;background:none;border:none;color:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary));cursor:pointer;padding:0 2px}',
      '.flowv-mail-task:hover{text-decoration:underline}',
'.flowv-mail-arch{font-size:11px;background:none;border:none;padding:2px 6px;border-radius:4px;cursor:pointer;color:var(--dsw-alias-label-tertiary);transition:color 120ms linear,background 120ms linear]}',
'.flowv-mail-arch:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,transparent)}',
'.flowv-mail-arch:disabled{opacity:.5;cursor:default}',
'.flowv-mail-arch:focus-visible{outline:2px solid var(--dsw-alias-border-accent,currentColor);outline-offset:1px}',
      '.flowv-ib-head.is-static{cursor:default}',
      /* 预设组件：可在界面上直接动手的内容，不是又一段文字 */
      '.flowv-blks{display:flex;flex-direction:column;gap:8px;margin:0 0 12px}',
      '.flowv-blk{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55;background:var(--dsw-alias-bg-base)}',
      '.flowv-blk.is-warn{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}',
      '.flowv-blk.is-danger{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-secondary)}',
      '.flowv-blk.is-ok{border-color:var(--dsw-alias-state-success-primary)}',
      '.flowv-blk-tx{color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.flowv-blk-choices{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
      '.flowv-blk-choice{display:flex;flex-direction:column;gap:1px;text-align:left;padding:5px 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-base);cursor:pointer;color:inherit;font-size:12px}',
      '.flowv-blk-choice:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.flowv-blk-choice.on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
      '.flowv-blk-choice.is-rec{border-style:dashed}',
      '.flowv-blk-choice span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-blk-dl{margin:4px 0 0;display:flex;flex-direction:column;gap:2px}',
      '.flowv-blk-kv{display:flex;gap:8px;font-size:11.5px}',
      '.flowv-blk-kv dt{flex:0 0 96px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.flowv-blk-kv dd{margin:0;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.flowv-blk-kv.is-warn dd{color:var(--dsw-alias-state-warn-primary)}',
      '.flowv-blk-kv.is-danger dd{color:var(--dsw-alias-state-error-primary)}',
      '.flowv-blk.is-ev{display:flex;flex-wrap:wrap;gap:6px}',
      '.flowv-blk-ev{font-size:10.5px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
      '.flowv-blk.is-link{display:flex;flex-wrap:wrap;gap:8px}',
      '.flowv-blk-link{color:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary));text-decoration:none;font-size:11.5px}',
      '.flowv-blk-link:hover{text-decoration:underline}',
      '.flowv-blk-prog-hd{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.flowv-blk-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;margin-top:4px}',
      '.flowv-blk-bar i{display:block;height:100%;background:var(--dsw-alias-state-business-primary);transition:width var(--flowv-t-med) var(--flowv-ease-out)}',
      '.flowv-blk.is-diff{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.flowv-blk-add{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}',
      '.flowv-blk-del{color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums}',
      '.flowv-blk-sha{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-blk-ul{margin:4px 0 0;padding-left:2px;list-style:none;display:flex;flex-direction:column;gap:2px}',
      '.flowv-blk-ul li{font-size:11.5px;color:var(--dsw-alias-label-primary)}',
      '.flowv-blk-ul li.is-done{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}',
      '.flowv-blk.is-code{padding:0;border:none;background:var(--dsw-alias-bg-module-platform);overflow:auto;max-height:240px}',
      '.flowv-blk.is-code code{display:block;padding:8px 10px;font-size:11px;line-height:1.5;white-space:pre}',
      '@media(max-width:860px){.flowv-mail{grid-template-columns:1fr;grid-template-rows:minmax(0,38%) minmax(0,1fr)}.flowv-mail-side{border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2)}.flowv-drawer--wide{width:100vw}}',
      /* ---- v0.013：右侧消息流 + 聊天式输入区 ----------------------------
         工单正文是第一条消息，之后每条回复是一条消息；不用气泡（长段落会被挤碎），
         用“角色/时间一行 + 左对齐正文”的线索式排版。 */
      '.flowv-mail-detail{display:flex;flex-direction:column;flex:1;min-height:0}',
      '.flowv-mail-head{flex:0 0 auto;padding:10px 22px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);z-index:2}',
      '.flowv-mail-head-top{display:flex;align-items:center;gap:8px;min-width:0}',
      '.flowv-mail-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.flowv-mail-head-meta{margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.flowv-mail-stream{flex:1;min-height:0;overflow:auto;padding:4px 22px 18px}',
      '.flowv-msg{padding:11px 0}',
      '.flowv-msg+.flowv-msg{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-msg-hd{display:flex;align-items:center;gap:8px;margin-bottom:5px;min-height:16px}',
      '.flowv-msg-who{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.flowv-msg.is-ticket .flowv-msg-who{color:var(--dsw-alias-state-business-primary)}',
      '.flowv-msg.is-mine .flowv-msg-who{color:var(--dsw-alias-label-primary)}',
      '.flowv-msg-at{font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.flowv-msg-act{opacity:0;font-size:10.5px;padding:0 6px;height:17px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:opacity var(--flowv-t-fast) var(--flowv-ease-out),border-color var(--flowv-t-fast) linear}',
      '.flowv-msg:hover .flowv-msg-act,.flowv-msg-act:focus-visible{opacity:1}',
      '.flowv-msg-act:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.flowv-msg-act:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.flowv-msg-body{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.flowv-msg-note{margin-top:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-mail-archived{padding:9px 0;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-mail-foot{padding:7px 22px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.flowv-composer{flex:0 0 auto;padding:9px 22px 12px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}',
      '.flowv-quote{display:flex;align-items:flex-start;gap:8px;padding:5px 8px;margin-bottom:6px;border-left:2px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-module-platform);border-radius:4px;font-size:11px}',
      '.flowv-quote-b{flex:0 0 auto;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.flowv-quote-tx{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.flowv-quote-x,.flowv-attach-x{flex:0 0 auto;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:0 2px}',
      '.flowv-quote-x:hover,.flowv-attach-x:hover{color:var(--dsw-alias-label-primary)}',
      '.flowv-attach{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}',
      '.flowv-attach-chip{display:flex;align-items:center;gap:4px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.flowv-attach-chip i{font-style:normal;color:var(--dsw-alias-label-tertiary)}',
      '.flowv-attach-tx{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace)}',
      '.flowv-attach-in{width:100%;margin-bottom:6px}',
      '.flowv-composer-tx{width:100%;min-height:62px;resize:vertical}',
      '.flowv-composer-bar{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}',
      '.flowv-tool{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color var(--flowv-t-fast) linear,color var(--flowv-t-fast) linear}',
      '.flowv-tool:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.flowv-tool.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.flowv-tool:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      // 折叠与邮箱的位移都不参与 reduced-motion：颜色可以留，位移全部去掉。
      /* 减少动态偏好：不是关掉动效，而是去掉"位移/缩放"这类会让人不适的部分，
         保留淡入淡出——状态变化仍然可感知，只是不晃。 */
      '@media (prefers-reduced-motion:reduce){',
      '.flowv-drawer,.flowv-drawer.is-open,.flowv-drawer.is-closing{transform:none}',
      '.flowv-modal,.flowv-modal.is-open,.flowv-modal.is-closing{transform:none}',
      '.flowv-task:hover{transform:none}',
      '.flowv-btn:active:not(:disabled){transform:none}',
      '.flowv-task:active{transform:none}',
      '}',
    ].join('')

    var ensureStyle = function () {
      try {
        if (document.getElementById('flow-view-style')) return
        var style = document.createElement('style')
        style.id = 'flow-view-style'
        style.textContent = VIEW_CSS
        document.head.appendChild(style)
      } catch (error) { /* 无 document */ }
    }

    // ---- 组件 -----------------------------------------------------------------
    var createFlowView = function (React, appCtx, prims) {
      /**
       * 进出场用的挂载管理。
       *
       * 只靠 CSS 的 @starting-style 能做"进场"，但**出场做不到**——
       * 条件渲染一 false，节点当场消失，想淡出也没东西可淡。
       * 这里在关闭时多留 ms 毫秒，让 is-closing 那条过渡跑完再卸载。
       *
       * 用 transition 而不是 keyframes：快速反复开关时能从中途平滑接上。
       * （必须定义在 createFlowView 内部：React 是它拿到的参数，外面没有。）
       */
      var usePresence = function (open, ms) {
        var st = React.useState({ mounted: !!open, closing: false })
        var v = st[0]
        var set = st[1]
        React.useEffect(function () {
          if (open) {
            set({ mounted: true, closing: false })
            return undefined
          }
          if (!v.mounted) return undefined
          set({ mounted: true, closing: true })
          var timer = setTimeout(function () { set({ mounted: false, closing: false }) }, ms)
          return function () { clearTimeout(timer) }
        }, [open])
        return { mounted: open ? true : v.mounted, closing: open ? false : v.closing }
      }

      /**
       * 跳到某个代理的会话。
       * 优先用 DSH 原生的 uiWorkspace.openSession（同一个页面里切过去，侧栏不崩）；
       * 拿不到就退回带 flowSession 参数的地址，至少能新开一页看到那个会话。
       */
      /** 多行提示的换行符：直接写 '\n' 字面量在源码里会被转义成真换行，断掉语句。 */
      var SEP = String.fromCharCode(10)

      var gotoSession = function (sid) {
        if (!sid) return false
        try {
          if (appCtx && appCtx.uiWorkspace && typeof appCtx.uiWorkspace.openSession === 'function') {
            appCtx.uiWorkspace.openSession(sid)
            return true
          }
        } catch (error) {
          logger.warn('打开会话失败', error)
        }
        try {
          window.open('/?flowSession=' + encodeURIComponent(sid), '_blank', 'noopener')
          return true
        } catch (error) {
          return false
        }
      }

      var h = React.createElement

      var Chip = function (props) {
        return h('span', { className: 'flowv-chip ' + (props.tone || ''), title: props.title || '' }, props.children)
      }
      var Btn = function (props) {
        var cls = 'flowv-btn' + (props.variant ? ' flowv-btn-' + props.variant : '') + (props.small ? ' flowv-btn-sm' : '')
        return h('button', {
          type: 'button',
          className: cls,
          disabled: !!props.disabled,
          title: props.title || '',
          onClick: props.disabled ? undefined : props.onClick,
        }, props.children)
      }
      /**
       * 卡片。带 fold 时整块可折叠（v0.011）：标题行变成按钮，折叠态不渲染正文。
       *
       * 为什么折在 Card 上而不是外面包一层：标题、计数（extra）本来就在卡片头部，
       * 外面再包一层会出现两个标题；而且折叠后仍要看到「工作包 · 八问」这种摘要。
       */
      var Card = function (props) {
        if (!props.fold) {
          return h('div', { className: 'flowv-card' },
            props.title ? h('h6', null, props.title, props.extra || null) : null,
            h('div', { className: 'flowv-card-bd' }, props.children),
          )
        }
        var f = props.fold
        return h('div', { className: 'flowv-card flowv-card-fold' + (f.open ? ' is-open' : '') },
          h('div', { className: 'flowv-fold-head' },
            h('button', {
              type: 'button', className: 'flowv-fold-btn',
              'aria-expanded': f.open ? 'true' : 'false',
              title: f.open ? '收起这一块' : '展开这一块',
              onClick: f.onToggle,
            },
              h('span', { className: 'flowv-fold-caret' }, '\u25B8'),
              props.title ? h('h6', null, props.title) : null,
              f.summary ? h('span', { className: 'flowv-fold-sum' }, f.summary) : null),
            props.extra || null),
          f.open ? h('div', { className: 'flowv-card-bd flowv-fold-body' }, props.children) : null)
      }
      var Modal = function (props) {
        // 弹窗是"偶发"面（一天开几次），够资格做完整进出场；
        // 而且它居中弹出，没有空间来源，所以只用 scale+opacity，不做位移。
        var pres = usePresence(props.open, 160)
        if (!pres.mounted) return null
        var maskCls = 'flowv-modal-mask' + (props.open ? ' is-open' : ' is-closing')
        return h('div', { className: maskCls, onClick: props.onClose },
          h('div', { className: 'flowv-modal' + (props.open ? ' is-open' : ' is-closing'), onClick: function (e) { e.stopPropagation() } },
            h('div', { className: 'flowv-modal-head' }, props.title,
              h('div', { className: 'flowv-spacer' }),
              h(Btn, { small: true, onClick: props.onClose }, '关闭')),
            h('div', { className: 'flowv-modal-body' }, props.children),
            props.footer ? h('div', { className: 'flowv-modal-foot' }, props.footer) : null,
          ))
      }

      /**
       * 折叠块（v0.011）。
       *
       * 为什么不用原生 <details>：折叠态必须**不渲染**子节点（一屏十几块全渲染是主要 DOM 成本），
       * 而 details 的内容永远在树里；它的开合也没有任何过渡可挂。
       * 为什么把 open 交给调用方：本组件保持纯展示，fake React（只有 useState）里也能测。
       */
      var Fold = function (props) {
        var open = !!props.open
        return h('div', { className: 'flowv-fold' + (open ? ' is-open' : '') },
          h('button', {
            type: 'button',
            className: 'flowv-fold-head',
            'aria-expanded': open ? 'true' : 'false',
            title: props.titleTitle || '',
            onClick: function () { if (props.onToggle) props.onToggle() },
          },
            h('span', { className: 'flowv-fold-caret' }, '\u25B8'),
            h('span', null, props.title),
            props.summary ? h('span', { className: 'flowv-fold-sum' }, props.summary) : null),
          open ? h('div', { className: 'flowv-fold-body' }, props.children) : null)
      }

      /**
       * Markdown 渲染。
       *
       * 复用 DSH 官方的 MarkdownText（来自 @deepseek-ai/dsh-client-ui-primitives，
       * 由 shell 的静态 seed 表提供，所以插件里 require 就能拿到，不用自己打包）。
       * 拿不到组件时不能白屏：一律退回 .flowv-plain 的纯文本 pre-wrap。
       */
      // MarkdownText 是 React.memo(...) 的产物 —— 那是个对象，不是函数，
      // 用 typeof === 'function' 判断会把它误杀成纯文本（线上踩过）。
      var MarkdownExport = prims ? prims.MarkdownText : null
      var MarkdownText = MarkdownExport && (typeof MarkdownExport === 'function' || typeof MarkdownExport === 'object')
        ? MarkdownExport
        : null
      // 引用必须稳定：MarkdownText 是 memo 组件，每次新建 labels 会让缓存永不命中
      var MD_LABELS = {
        code: {
          copyLabel: '复制',
          copiedLabel: '已复制',
          toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
        },
        footnotes: '脚注',
      }
      // 够不够像 markdown：标题 / 列表 / 围栏 / 引用 / 表格 / 粗体 / 行内 code。
      // 只判断明显的标记——纯文本多行评论直接进 Markdown 会被 GFM 把换行塌成空格，
      // 原来排好的段落就全没了，所以纯文本必须留在 pre-wrap 分支。
      var RICH_RE = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)|```|`[^`\n]+`|\*\*[^*\n]+\*\*/
      var looksRich = function (text) { return typeof text === 'string' && RICH_RE.test(text) }
      var md = function (text, plainClass) {
        var value = text == null ? '' : String(text)
        if (!value.trim()) return null
        if (MarkdownText && looksRich(value)) {
          return h('div', { className: 'flowv-md' },
            h(MarkdownText, { text: value, labels: MD_LABELS, variant: 'compact' }))
        }
        return h('div', { className: 'flowv-plain' + (plainClass ? ' ' + plainClass : '') }, value)
      }
      // 评论一律按 Markdown 渲染：围栏外的单换行补成硬换行（行尾两个空格），
      // 这样纯文本评论的段落不会被 GFM 塌成一行，列表/代码/表格照常排版。
      var hardBreaks = function (text) {
        var inFence = false
        return String(text).split('\n').map(function (line) {
          if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; return line }
          if (inFence || !line.trim() || /^\s{0,3}(\||#{1,6}\s|[-*+]\s|\d+\.\s|>)/.test(line)) return line
          return line + '  '
        }).join('\n')
      }
      var mdComment = function (text) {
        var value = text == null ? '' : String(text)
        if (!value.trim()) return null
        if (!MarkdownText) return h('div', { className: 'flowv-plain flowv-cmt-tx' }, value)
        return h('div', { className: 'flowv-md flowv-cmt-md' },
          h(MarkdownText, { text: hardBreaks(value), labels: MD_LABELS, variant: 'compact' }))
      }
      // v1.38：评论列表打开即滚到最新；有新评论时，只有本来就在底部才跟随（不打断正在往上翻的人）。
      var CommentList = function (props) {
        var ref = React.useRef(null)
        var atBottom = React.useRef(true)
        var count = (props.children || []).length
        React.useLayoutEffect(function () {
          var el = ref.current
          if (el) { el.scrollTop = el.scrollHeight; atBottom.current = true }
        }, [props.taskId])
        React.useLayoutEffect(function () {
          var el = ref.current
          if (el && atBottom.current) el.scrollTop = el.scrollHeight
        }, [count])
        return h('div', {
          ref: ref, className: 'flowv-cmt-list',
          onScroll: function (e) { var el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 },
        }, props.children)
      }
      // v1.38：抽屉侧边固定的跳转按钮：回到顶部 / 跳到最新评论。滚动超过一屏的 1/3 才出现「回到顶部」。
      var DrawerJump = function () {
        var s = React.useState(false)
        var ref = React.useRef(null)
        var body = function () { var n = ref.current; var dr = n && n.closest('.flowv-drawer'); return dr && dr.querySelector('.flowv-drawer-body') }
        React.useEffect(function () {
          var b = body()
          if (!b) return
          var on = function () { s[1](b.scrollTop > b.clientHeight / 3) }
          on()
          b.addEventListener('scroll', on, { passive: true })
          return function () { b.removeEventListener('scroll', on) }
        }, [])
        var smooth = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
        var toTop = function () { var b = body(); if (b) b.scrollTo({ top: 0, behavior: smooth }) }
        var toLatest = function () {
          var n = ref.current; var dr = n && n.closest('.flowv-drawer'); if (!dr) return
          var list = dr.querySelector('.flowv-cmt-list')
          if (!list) return
          list.scrollTo({ top: list.scrollHeight, behavior: smooth })
          list.scrollIntoView({ block: 'end', behavior: smooth })
        }
        return h('div', { ref: ref, className: 'flowv-jump' },
          h('button', { type: 'button', className: 'flowv-jump-btn' + (s[0] ? '' : ' is-hidden'), onClick: toTop, title: '回到顶部', 'aria-label': '回到顶部', tabIndex: s[0] ? 0 : -1 }, '↑'),
          h('button', { type: 'button', className: 'flowv-jump-btn', onClick: toLatest, title: '跳到最新评论', 'aria-label': '跳到最新评论' }, '↓'))
      }
      // 长评论默认折叠，点开看全文（独立组件：需要自己的 state）
      var CommentBody = function (props) {
        var s = React.useState(false)
        var expanded = s[0]
        var text = String(props.text || '')
        var long = text.length > 600 || text.split('\n').length > 14
        return h('div', { className: 'flowv-cmt-body' + (long && !expanded ? ' is-clamped' : '') },
          mdComment(text),
          long ? h('button', { className: 'flowv-cmt-more', onClick: function () { s[1](!expanded) } }, expanded ? '收起' : '展开全文') : null)
      }

      /**
       * 描述卡：编辑 / 预览两态。
       *
       * textarea 常挂载、预览时只 display:none —— 来回切换不丢草稿；
       * 保存仍然直接读 textarea.value（和文件里其它写法保持一致）。
       * 独立成组件是因为它需要 useState，而 FlowView 里的 hook 顺序被测试锁死了。
       */
      var NoteCard = function (props) {
        var modeState = React.useState('edit')
        var mode = modeState[0]
        var setMode = modeState[1]
        // 草稿单独存一份：预览要显示「正在编辑的内容」，不能回退到上次保存的 props.value
        var draftState = React.useState(props.value || '')
        var draft = draftState[0]
        var setDraft = draftState[1]
        var preview = mode === 'preview'
          ? (md(draft) || h('div', { className: 'flowv-sec-empty' }, '还没有内容'))
          : null
        return h(Card, { title: props.title || '描述' },
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
            h(Btn, { small: true, variant: preview ? '' : 'primary', onClick: function () { setMode('edit') } }, '编辑'),
            h(Btn, { small: true, variant: preview ? 'primary' : '', onClick: function () { setMode('preview') } }, '预览')),
          h('div', { style: preview ? { display: 'none' } : null },
            h('textarea', {
              className: 'flowv-textarea',
              rows: 6,
              defaultValue: props.value || '',
              placeholder: props.placeholder || '',
              id: props.inputId,
              onInput: function (e) { setDraft(e.target.value) },
            })),
          preview ? h('div', { className: 'flowv-note-preview' }, preview) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
            h(Btn, { small: true, variant: 'primary', onClick: props.onSave }, props.saveLabel || '保存描述'),
            h('span', { className: 'flowv-hint' }, props.hint || '')))
      }

      /**
       * 「远程仓库」设置面板（v1.22 P7）。
       *
       * 为什么单独抽一个组件：它自带 useState 草稿，塞进 FlowView 会打乱 hook 顺序回归
       * （test/client.mjs 会从 FlowView 第一个 return 往前数 hook）。
       *
       * 保存有个坑：lib/http.js 在 recordIssues=false 时会**拒绝写 remote**，
       * 所以这里保存必须把 recordIssues:true 一起 patch —— 否则"配了远程但存不进去"。
       */
      var RemotePane = function (props) {
        var ctx = props || {}
        var formState = React.useState(null)
        var form = formState[0]
        var setForm = formState[1]
        var busyState = React.useState('')
        var busy = busyState[0]
        var setBusy = busyState[1]
        var noticeState = React.useState('')
        var notice = noticeState[0]
        var setNotice = noticeState[1]

        var project = ctx.project
        var cfg = (project && project.config) || {}
        var remote = cfg.remote || {}

        // 首次挂载时把已存配置灌进表单（之后由用户编辑，不再回灌，否则输入会被覆盖）
        React.useEffect(function () {
          setForm({
            kind: remote.kind || 'github',
            baseUrl: remote.baseUrl || '',
            owner: remote.owner || '',
            repo: remote.repo || '',
            token: '',
            useGhCli: remote.useGhCli !== false,
            webhookSecret: remote.webhookSecret || '',
            pushRemote: !!cfg.pushRemote,
            autoApproveIssue: !!cfg.autoApproveIssue,
          })
        }, [project && project.id])

        if (!form) return h('div', { className: 'flowv-hint' }, '正在读取配置…')

        var set = function (key, value) {
          setForm(function (prev) { var next = Object.assign({}, prev); next[key] = value; return next })
        }
        var input = function (key, label, placeholder, type) {
          return h('div', { className: 'flowv-field', key: key },
            h('label', { htmlFor: 'flowv-rm-' + key }, label),
            h('input', {
              id: 'flowv-rm-' + key, className: 'flowv-input', type: type || 'text',
              defaultValue: form[key] || '', placeholder: placeholder || '',
              onInput: function (e) { set(key, e.target.value) },
            }))
        }
        var select = function (key, label, options, hint) {
          return h('div', { className: 'flowv-field', key: key },
            h('label', null, label),
            h('select', {
              className: 'flowv-select', defaultValue: form[key] ? '1' : '0',
              onChange: function (e) { set(key, e.target.value === '1') },
            }, options.map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) })),
            hint ? h('div', { className: 'flowv-hint' }, hint) : null)
        }

        var savePatch = function () {
          var r = {
            kind: form.kind || 'github',
            baseUrl: String(form.baseUrl || '').trim() || 'https://api.github.com',
            owner: String(form.owner || '').trim(),
            repo: String(form.repo || '').trim(),
            useGhCli: !!form.useGhCli,
          }
          if (String(form.token || '').trim()) r.token = String(form.token).trim()
          if (String(form.webhookSecret || '').trim()) r.webhookSecret = String(form.webhookSecret).trim()
          return {
            // recordIssues 必须一起打开：它是"接不接远程"的硬门禁，单写 remote 会被拒
            recordIssues: true,
            remote: r,
            pushRemote: !!form.pushRemote,
            autoApproveIssue: !!form.autoApproveIssue,
          }
        }

        var save = function () {
          if (!form.owner || !form.repo) { setNotice('owner / repo 必填'); return }
          setBusy('save')
          ctx.act('project.config', { projectId: project.id, patch: savePatch() })
            .then(function (res) {
              setBusy('')
              // 保存成功后再把表单里的 token 清掉（它已经进了配置，不该留在 DOM 里）
              setForm(function (prev) { var next = Object.assign({}, prev); next.token = ''; return next })
              setNotice((res && res.ok === false) ? '保存失败：' + (res.message || res.reason || res.error || '') : '已保存。下一轮同步（60s 内）就会开始。')
            })
        }

        var detect = function () {
          setBusy('detect')
          ctx.act('remote.detect', { projectId: project.id })
            .then(function (res) {
              setBusy('')
              if (!res || !res.ok) { setNotice('探测失败：' + ((res && (res.reason || res.message || res.error)) || '宿主没有 remote.detect（要重启 dsh web）')); return }
              var r = res.remote || {}
              if (r.owner && r.repo) {
                setForm(function (prev) {
                  var next = Object.assign({}, prev)
                  next.kind = r.kind || next.kind
                  next.owner = r.owner
                  next.repo = r.repo
                  next.baseUrl = r.baseUrl || next.baseUrl
                  return next
                })
                setNotice('已从 git remote 填入 ' + r.owner + '/' + r.repo + '，确认后点保存')
              } else {
                setNotice('git remote 里没有可用的仓库坐标' + (res.notes && res.notes.length ? '：' + res.notes.join('；') : ''))
              }
            })
        }

        var test = function () {
          setBusy('test')
          ctx.act('remote.test', { projectId: project.id, remote: savePatch().remote })
            .then(function (res) {
              setBusy('')
              setNotice(res && res.ok
                ? '连通：' + (res.fullName || '') + '，默认分支 ' + (res.defaultBranch || '?') + (res.hasIssues ? '，issue 已开启' : '，issue 关闭（双向同步会失败）')
                : '连不通：' + ((res && (res.reason || res.message || res.error)) || '宿主没有 remote.test（要重启 dsh web）'))
            })
        }

        var syncNow = function () {
          setBusy('sync')
          ctx.act('event.sync', { projectId: project.id })
            .then(function (res) {
              setBusy('')
              setNotice((res && res.ok === false) ? '同步失败：' + (res.reason || res.message || res.error || '') : '已同步一次')
              if (ctx.reload) ctx.reload()
            })
        }

        var sync = ctx.sync || project.sync || null
        var when = function (iso) {
          if (!iso) return '—'
          var d = new Date(iso)
          return isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
        }
        var syncBox = h('div', { className: 'flowv-card' },
          h('h6', null, '同步状态'),
          h('div', { className: 'flowv-card-bd' },
            h('div', { className: 'flowv-kv' },
              h('dt', null, '开始于'), h('dd', null, when(sync && sync.since)),
              h('dt', null, '上次同步'), h('dd', null, when(sync && sync.lastSyncAt)),
              h('dt', null, '熔断到'), h('dd', null, when(sync && sync.circuitUntil)),
              h('dt', null, '最近错误'), h('dd', null, (sync && sync.lastError) || '—'),
              h('dt', null, '待推'), h('dd', null, String(((sync && sync.outbound) || []).length) + ' 条'))))

        return h('div', null,
          h('div', { className: 'flowv-hint', style: { marginBottom: 8 } },
            '开了远程之后：配置时刻之后新建的卡与评论会双向同步，PR 默认建到远程，合并后把提交摘要贴回 issue。历史卡不回填。'),
          h('div', { className: 'flowv-grid2' },
            h('div', { className: 'flowv-field' },
              h('label', null, '平台'),
              h('select', {
                className: 'flowv-select', defaultValue: form.kind,
                onChange: function (e) { set('kind', e.target.value) },
              }, h('option', { value: 'github' }, 'GitHub'), h('option', { value: 'gitea' }, 'Gitea'))),
            select('useGhCli', '用 gh CLI 登录态', [['1', '是（不必填 token）'], ['0', '否（用下面的 token）']])),
          h('div', { className: 'flowv-grid2' },
            input('owner', '仓库 owner', 'El1mir'),
            input('repo', '仓库名', 'BiliNote')),
          form.kind === 'gitea' ? input('baseUrl', 'API 地址', 'https://git.example.com') : null,
          input('token', 'token（留空 = 用已保存的）', 'ghp_… 或 gho_…', 'password'),
          input('webhookSecret', 'webhook secret（可选）', '推送入站才需要；默认走轮询'),
          h('div', { className: 'flowv-grid2' },
            select('pushRemote', '同步方向', [['0', '只同步进来'], ['1', '双向（写回 issue / PR / 评论）']]),
            select('autoApproveIssue', '低风险方案自动批准', [['0', '关（调度判断 + 人拍板）'], ['1', '开（低风险 + 无人插手才代批）']])),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' } },
            h(Btn, { key: 'detect', small: true, disabled: busy === 'detect', onClick: detect }, busy === 'detect' ? '探测中…' : '从 git remote 探测'),
            h(Btn, { key: 'test', small: true, disabled: busy === 'test', onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
            h(Btn, { key: 'sync', small: true, disabled: busy === 'sync', onClick: syncNow }, busy === 'sync' ? '同步中…' : '立即同步'),
            h(Btn, { key: 'save', small: true, variant: 'primary', disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存配置')),
          notice ? h('div', { className: 'flowv-hint', style: { margin: '8px 0', color: 'var(--dsw-alias-label-secondary)' } }, notice) : null,
          syncBox)
      }

      return function FlowView(props) {
        ensureStyle()
        var sessionId = props.sessionId || (props.session && props.session.sessionId) || null

        var viewState = React.useState({ phase: 'loading', view: null, session: null, error: '', degraded: false })
        var st = viewState[0]
        var setSt = viewState[1]

        var capsState = React.useState({ bind: false, unbind: false, remove: false, catalog: false, checked: false })
        var caps = capsState[0]
        var setCaps = capsState[1]

        var noticeState = React.useState('')
        var notice = noticeState[0]
        var setNotice = noticeState[1]

        var busyState = React.useState('')
        var busy = busyState[0]
        var setBusy = busyState[1]

        // v1.39：详情页改成"全屏层栈"。一层 = 一张卡的详情；子卡从父卡里再压一层。
        // 栈底是看板，栈里每一层都能单独退出（Esc 只退最上面一层）。
        var sheetsState = React.useState([]) // [{ taskId, detail, loading }]
        var sheets = sheetsState[0]
        var setSheets = sheetsState[1]
        // 兼容：原有代码全部按 drawer = 栈顶来读，改动面最小
        var drawer = sheets.length ? sheets[sheets.length - 1] : null
        var setDrawer = function (next) { setSheets(next ? [next] : []) }

        // v1.31：请示箱。null = 关闭；打开时 { items, open, answered, loading, replying, draft }。
        // 和其他 hook 放在一起、在全部 early return 之前 —— 否则首屏 loading 时 hook 数量对不上，整页白屏。
        // v1.31.1：每列已显示多少张卡（key = 列 id）。
        // 只显示最近进来的 N 张，底部"显示更多"再追加一页 —— 列里有 50 张卡时
        // 整页会被撑爆，而人真正关心的是最近进来的那几张。
        var colShownState = React.useState({})
        // v0.011：列可以收起 —— 七列并排时，人真正在看的通常只有两三列。
        var colCollapsedState = React.useState({})
        var colShown = colShownState[0]
        var colCollapsed = colCollapsedState[0]
        var setColCollapsed = colCollapsedState[1]
        var setColShown = colShownState[1]

        // v1.37：调度台顶部指标（token / 缓存命中率要异步从 DSH 会话读，所以单独存）
        var metricsState = React.useState(null)
        var metrics = metricsState[0]
        var setMetrics = metricsState[1]
        var metricsProjectId = st && st.view && st.view.project ? st.view.project.id : null
        var loadMetricsFor = function (pid) {
          if (!pid) return
          postAction('project.metrics', { projectId: pid, withTokens: true })
            .then(function (r) { var res = r && (r.result || r); if (res && res.ok) setMetrics(res) })
            .catch(function () {})
        }
        // 指标自动轮询（和看板同一节奏），不再放手动刷新按钮
        // v1.39：Esc 只退最上面一层（多层详情页）。有弹窗打开时交给弹窗自己处理。
        var sheetsOpen = sheets.length > 0
        React.useEffect(function () {
          if (!sheetsOpen) return
          var onKey = function (e) {
            if (e.key !== 'Escape') return
            if (document.querySelector('.flowv-modal-mask')) return
            e.preventDefault()
            setSheets(function (prev) { return prev.slice(0, -1) })
          }
          document.addEventListener('keydown', onKey)
          return function () { document.removeEventListener('keydown', onKey) }
        }, [sheetsOpen])
        React.useEffect(function () {
          if (!metricsProjectId) return
          loadMetricsFor(metricsProjectId)
          var timer = setInterval(function () { loadMetricsFor(metricsProjectId) }, 8000)
          return function () { clearInterval(timer) }
        }, [metricsProjectId])
        var inboxState = React.useState(null)
        var inbox = inboxState[0]
        var setInbox = inboxState[1]
        // 请示箱打开期间自动轮询（只换列表和计数，不动草稿/回复状态）
        var inboxOpen = !!inbox
        var inboxArchived = !!(inbox && inbox.includeArchived)
        React.useEffect(function () {
          if (!inboxOpen || !metricsProjectId) return
          var timer = setInterval(function () {
            postAction('inbox.list', { projectId: metricsProjectId, includeArchived: inboxArchived }).then(function (res) {
              if (!res || !Array.isArray(res.items)) return
              setInbox(function (prev) {
                if (!prev) return prev
                return Object.assign({}, prev, {
                  items: res.items,
                  open: res.counts && typeof res.counts.open === 'number' ? res.counts.open : prev.open,
                  answered: res.counts && typeof res.counts.answered === 'number' ? res.counts.answered : prev.answered,
                })
              })
            }).catch(function () {})
          }, 8000)
          return function () { clearInterval(timer) }
        }, [inboxOpen, inboxArchived, metricsProjectId])

        var modalState = React.useState(null) // 'new-task' | 'settings' | 'new-project'
        var modal = modalState[0]
        var setModal = modalState[1]

        var draftState = React.useState({}) // 新建任务/项目的草稿
        var draft = draftState[0]
        var setDraft = draftState[1]

        // C-03：自动车道面板的展开态。必须和其他 hook 待在一起、在 early return 之前，
        // 否则首屏 loading 与数据回来后的 hook 数量对不上 —— 整页白屏（同 drawerPresence 的坑）。
        var autoLaneState = React.useState(false)
        var autoLaneOpen = autoLaneState[0]
        var setAutoLaneOpen = autoLaneState[1]

        var settingsState = React.useState({ tab: 'general', catalog: null, global: {}, loading: false })
        /**
         * 抽屉的进出场状态。
         *
         * **必须和其他 hook 待在一起、在任何 early return 之前**：
         * 下面有 loading / no-session / unbound / error 四个 early return，
         * 首屏是 loading → 只跑到第 901 行就返回了；数据回来后才往下走到这个 hook。
         * 前后两次渲染的 hook 数量不一致 → React 报
         * "Rendered more hooks than during the previous render" → 没有 error boundary → 整页白屏。
         */
        var drawerPresence = usePresence(sheets.length > 0, 220)
        var settings = settingsState[0]
        var setSettings = settingsState[1]

        // v0.011：折叠态与顶栏菜单。和其它 hook 一样必须在四个 early return 之前。
        // 键是 `区域:标识`（例 `drawer:T-049:status`），默认值由调用方传 —— 这样「哪些块默认展开」
        // 是一条可读的规则，而不是每次渲染都重新算。
        var foldState = React.useState({})
        var folds = foldState[0]
        var setFolds = foldState[1]
        var foldOpen = function (key, def) {
          return Object.prototype.hasOwnProperty.call(folds, key) ? !!folds[key] : !!def
        }
        var toggleFold = function (key, def) {
          setFolds(function (prev) {
            var next = Object.assign({}, prev)
            next[key] = !(Object.prototype.hasOwnProperty.call(prev, key) ? !!prev[key] : !!def)
            return next
          })
        }
        var menuState = React.useState(false)
        var menuOpen = menuState[0]
        var setMenuOpen = menuState[1]

        // ---- 数据加载 ---------------------------------------------------------
        var load = React.useCallback(function () {
          if (!sessionId) {
            setSt({ phase: 'no-session', view: null, session: null, error: '', degraded: false })
            return
          }
          getJson('/api/flow/session-project?sessionId=' + encodeURIComponent(sessionId))
            .then(function (r) {
              var body = r.body || {}
              if (r.ok && body.ok) {
                return getJson('/api/flow/project?projectId=' + encodeURIComponent(body.projectId)).then(function (pr) {
                  var v = pr.body || {}
                  if (pr.ok && v.ok) {
                    setSt({ phase: 'ready', view: v, session: body, error: '', degraded: false })
                    return null
                  }
                  throw new Error((v && (v.error || v.message)) || '项目数据加载失败')
                })
              }
              // 旧服务端兜底：/sessions 找 cwd + /state 本地组装
              return getJson('/api/flow/sessions').then(function (sr) {
                var items = (sr.body && sr.body.items) || []
                var mine = items.filter(function (x) { return x.sessionId === sessionId })[0] || null
                var cwd = mine ? mine.cwd : null
                return getJson('/api/flow/state').then(function (str) {
                  var snap = (str.body && str.body.state) || {}
                  var hit = resolveFromState(snap, sessionId, cwd)
                  if (!hit) {
                    setSt({ phase: 'unbound', view: null, session: { cwd: cwd }, error: '', degraded: true })
                    return
                  }
                  var v = buildLocalView(snap, hit.project)
                  setSt({ phase: 'ready', view: v, session: { cwd: cwd, matchedBy: hit.matchedBy }, error: '', degraded: true })
                })
              })
            })
            .catch(function (err) {
              setSt(function (prev) {
                return {
                  phase: prev.view ? 'ready' : 'error',
                  view: prev.view,
                  session: prev.session,
                  degraded: prev.degraded,
                  error: (err && err.message) || String(err),
                }
              })
            })
        }, [sessionId])

        React.useEffect(function () {
          load()
          var timer = setInterval(load, 8000)
          return function () { clearInterval(timer) }
        }, [load])

        React.useEffect(function () {
          // 能力探测：只认新版本才有的 action，避免旧服务端上按钮点了报错
          getJson('/api/flow/health').catch(function () { return null })
          fetch('/api/flow/action', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'catalog.get', args: {} }),
          })
            .then(function (r) { return r.text() })
            .then(function (t) {
              var isOld = /unknown action/.test(t)
              setCaps({ bind: !isOld, unbind: !isOld, remove: !isOld, catalog: !isOld, checked: true })
            })
            .catch(function () { setCaps({ bind: false, unbind: false, remove: false, catalog: false, checked: true }) })
        }, [])

        // ---- 动作 -------------------------------------------------------------
        var run = function (label, fn) {
          setBusy(label)
          setNotice('')
          return fn()
            .then(function (res) { return res })
            .catch(function (err) { setNotice((err && err.message) || String(err)); return null })
            .then(function (res) {
              setBusy('')
              // load() 可能同步返回 undefined（没有 sessionId 的分支）：
              // 直接 .then 会抛 "Cannot read properties of undefined (reading 'then')"，
              // 整条动作链被打断，调用方（比如新建任务弹窗）就永远关不掉。
              return Promise.resolve(load()).then(function () { return res })
            })
        }

        var act = function (action, args) {
          return run(action, function () { return postAction(action, args) })
        }

        /** 打开设置：顺手拉一次模型目录（拿不到就退化成手填）。 */
        var openSettings = function () {
          setModal('settings')
          setSettings(function (prev) { return Object.assign({}, prev, { tab: 'general', loading: true }) })
          loadCatalog()
          setSettings(function (prev) { return Object.assign({}, prev, { skills: null, skillsError: '' }) })
          act('skills.list', { projectId: project.id }).then(function (res) {
            var r = res && (res.result || res)
            setSettings(function (prev) { return Object.assign({}, prev, {
              skills: r && r.ok && Array.isArray(r.skills) ? r.skills : [],
              skillsError: r && r.ok ? '' : ((r && r.message) || '技能目录加载失败，请重新打开设置重试'),
            }) })
          }).catch(function () {
            setSettings(function (prev) { return Object.assign({}, prev, { skills: [], skillsError: '技能目录加载失败，请重新打开设置重试' }) })
          })
          // v1.37：全局默认模型（不随项目走）
          postAction('settings.get', {}).then(function (res) {
            var r = res && (res.result || res)
            if (r && r.ok) setSettings(function (prev) { return Object.assign({}, prev, { global: r.settings || {} }) })
          }).catch(function () {})
        }
        var loadCatalog = function () {
          return postAction('catalog.get', {}).then(function (res) {
            // action 返回 { ok, catalog, presets }——真正给下拉吃的是里面的 catalog
            var catalog = (res && res.catalog) || null
            var presets = (res && res.presets) || []
            setSettings(function (prev) { return Object.assign({}, prev, { catalog: catalog, presets: presets, loading: false }) })
            return res
          }).catch(function () {
            setSettings(function (prev) { return Object.assign({}, prev, { catalog: null, presets: [], loading: false }) })
          })
        }

        /**
         * 把 DSH 的 ModelCatalog 摊平成 [{key,label}]：
         *   { groups: [{ id, name, models: [{ id, name, description }] }], default: {provider, model} }
         * 结构不认识就返回空（调用方退化成手填）。
         */
        var modelOptions = function (catalog) {
          var out = []
          if (!catalog || catalog.ok === false) return out
          var groups = catalog.groups || catalog.providers || []
          if (!Array.isArray(groups)) return out
          groups.forEach(function (g) {
            var provider = g.id || g.provider || g.name
            var models = Array.isArray(g.models) ? g.models : []
            models.forEach(function (m) {
              var id = m.id || m.model || m.name
              if (!provider || !id) return
              var label = (g.name || provider) + ' · ' + (m.name || id)
              out.push({ key: provider + '/' + id, label: label })
            })
          })
          return out
        }
        /** 目录里的默认模型，给下拉里那项「沿用默认」当说明。 */
        var defaultModelLabel = function (catalog) {
          var d = catalog && catalog.default
          if (!d || !d.provider || !d.model) return '沿用会话默认'
          return '沿用默认（' + d.provider + '/' + d.model + '）'
        }

        // 换某一张卡的层（不改变层数）：reloadDrawer / 打开时的回填都走它
        var replaceSheet = function (taskId, patch) {
          setSheets(function (prev) {
            return prev.map(function (x) { return x.taskId === taskId ? Object.assign({}, x, patch) : x })
          })
        }
        /**
         * 打开一张卡的详情层。
         * - 已经在栈里（例如点面包屑往上跳）→ 把栈截断到那一层，不重复压。
         * - 否则压一层新层（子卡就是从父卡上面再压一层）。
         */
        var openDrawer = function (taskId) {
          var id = String(taskId || '')
          if (!id) return
          setSheets(function (prev) {
            var idx = prev.findIndex(function (x) { return x.taskId === id })
            if (idx >= 0) return prev.slice(0, idx + 1)
            return prev.concat([{ taskId: id, detail: null, loading: true }])
          })
          getJson('/api/flow/task/' + encodeURIComponent(id)).then(function (r) {
            var d = (r.body && r.body.ok) ? r.body : null
            replaceSheet(id, { detail: d, loading: false })
          })
        }
        /** 退出最上面一层（Esc / 返回按钮 / 点遮罩）。 */
        var closeDrawer = function () { setSheets(function (prev) { return prev.slice(0, -1) }) }
        /** 一次退到底（回到看板）。 */
        var closeAllSheets = function () { setSheets([]) }
        var reloadDrawer = function (taskId) {
          return getJson('/api/flow/task/' + encodeURIComponent(taskId)).then(function (r) {
            var d = (r.body && r.body.ok) ? r.body : null
            replaceSheet(taskId, { detail: d, loading: false })
          })
        }

        // 抽屉里的迁移动作：与原工作台 taskAction 一一对应
        var taskAction = function (task, action) {
          var pid = st.view && st.view.project ? st.view.project.id : null
          var after = function () { return reloadDrawer(task.id) }
          if (action === 'claim') return act('task.move', { taskId: task.id, action: 'claim' }).then(after)
          if (action === 'plan') {
            var text = window.prompt('计划（Markdown）', (task.plan && task.plan.text) || '')
            if (!text) return null
            return act('task.plan', { taskId: task.id, text: text }).then(after)
          }
          if (action === 'plan_ready') return act('task.move', { taskId: task.id, action: 'plan_ready' }).then(after)
          if (action === 'reject') return act('task.move', { taskId: task.id, action: 'reject' }).then(after)
          if (action === 'approve') return act('task.move', { taskId: task.id, action: 'approve' }).then(after)
          if (action === 'dispatch') return act('task.dispatch', { taskId: task.id }).then(after)
          if (action === 'inspect') return act('task.inspect', { taskId: task.id }).then(after)
          if (action === 'block') {
            var reason = window.prompt('阻塞原因')
            if (!reason) return null
            return act('task.block', { taskId: task.id, reason: reason }).then(after)
          }
          if (action === 'unblock') return act('task.unblock', { taskId: task.id }).then(after)
          if (action === 'accept') {
            // v1.28：不再让人手抄 head_sha。系统自己从 worktree 读，
            // 没有提交的卡（只读审计/文档/调研）直接验收到 done-no-merge。
            // 人点的 accept 本身就是"人类授权"，所以不需要额外凭据。
            return act('task.move', { taskId: task.id, action: 'accept' }).then(after)
          }
          if (action === 'rework') return act('task.move', { taskId: task.id, action: 'rework' }).then(after)
          if (action === 'merge_skip') return act('task.move', { taskId: task.id, action: 'merge_skip' }).then(after)
          if (action === 'pr_open') {
            return act('pr.open', { taskId: task.id }).then(function (res) {
              if (res) setNotice('PR 快照已生成：head ' + String((res.headSha || '')).slice(0, 8) + '，现在可以审核了。')
              after()
              load()
            })
          }
          if (action === 'review_approve') return act('pr.review', { taskId: task.id, verdict: 'approved' }).then(after)
          if (action === 'review_conflict') return act('pr.review', { taskId: task.id, verdict: 'needs_work' }).then(after)
          if (action === 'review_risk') return act('pr.review', { taskId: task.id, verdict: 'risk' }).then(after)
          if (action === 'reopen') {
            // 代理申请过重开就把它的理由预填，人只需确认或改写
            var preset = (task.reopenRequested && task.reopenRequested.reason) || ''
            var rr = window.prompt('重开原因（写进审计历史）', preset)
            if (!rr) return null
            return act('task.move', { taskId: task.id, action: 'reopen', payload: { reason: rr } }).then(after)
          }
          if (action === 'cancel') {
            if (!window.confirm('确认取消该任务？')) return null
            return act('task.move', { taskId: task.id, action: 'cancel' }).then(function () { closeDrawer() })
          }
          // v1.4：删除动作从界面收起（API 仍保留 task.remove）
          return null
        }

        // ---- 回退（v0.007）-----------------------------------------------------
        //
        // 与「取消 + 重开」的区别：回退不动取消/重开计数，也不清计划快照 ——
        // 它就是「这一步走早了，退回去重来」，所以审计里必须留着 reason。
        // 列顺序与 core 的 REWIND_TARGETS 一致；这里不复用后端投影是因为
        // 回退目标只依赖列顺序，一个纯常量比一次字段投影更不容易漂。
        var REWIND_TARGETS = ['todo', 'planning', 'running', 'verifying', 'merging']
        var rewindTargetsFor = function (t) {
          var i = REWIND_TARGETS.indexOf(t.column)
          return i <= 0 ? [] : REWIND_TARGETS.slice(0, i)
        }
        var rewound = function (task, to, reason) {
          return act('task.move', { taskId: task.id, action: 'rewind', payload: { targetColumn: to, reason: reason } }).then(function (res) {
            if (res && res.ok === false) { setNotice(res.message || '回退被拒绝'); return null }
            setNotice('已回退到 ' + (COLUMN_TITLES[to] || to))
            reloadDrawer(task.id)
            load()
          })
        }
        // ---- 渲染：顶栏 -------------------------------------------------------
        var project = st.view ? st.view.project : null
        var isChief = !!(project && sessionId && project.chiefSessionId === sessionId)
        // 全局控制位（一键停止）。老服务端不返回 control，一律按"未停止"处理。
        var ctl = (st.view && st.view.control) || { halted: false, haltedAt: null, reason: null }

        // v0.011：顶栏只留每天都要按的（新建任务 / 停止调度 / 设置），
        // 初始化仓库、重建会话、手动同步都是低频且后果重的动作 —— 收进「更多」，
        // 主操作与危险操作分开，误点的成本从「重建了所有会话」降到「多点一次」。
        var moreItems = []
        if (project) {
        moreItems.push(h(Btn, {
            disabled: busy === 'project.init',
            title: '给每个工位建一个带身份名的会话，并把漂在 worktree 里的旧会话收回当前工作区（可反复点）',
            onClick: function () {
              act('project.init', { projectId: project.id }).then(function (res) {
                if (!res) return
                var lines = [res.message || '已初始化']
                var notes = res.setupNotes || []
                if (notes.length) lines.push('环境：' + notes.join('；'))
                var names = (res.created || []).concat(res.moved || []).map(function (x) { return x.name }).filter(Boolean)
                if (names.length) lines.push('备好的会话：' + names.join('、'))
                if ((res.attached || []).length) lines.push('补挂回工作区：' + res.attached.map(function (x) { return x.name }).filter(Boolean).join('、'))
                if ((res.failed || []).length) lines.push('失败：' + res.failed.map(function (x) { return (x.name || x.agentId) + '（' + (x.message || '未知原因') + '）' }).join('；'))
                lines.push('这些会话还没对话过，侧栏只会显示当前打开的那一个；在「设置 → 代理」点「打开会话」即可让它出现。')
                setNotice(lines.join(SEP))
              })
            },
          }, busy === 'project.init' ? '初始化中…' : '初始化仓库'))
        moreItems.push(h(Btn, {
            disabled: busy === 'project.reset',
            title: '归档当前所有工位会话并重新建一套（用于清理「未分组」里的孤儿会话）',
            onClick: function () {
              var ok = window.confirm('归档当前所有工位会话并重新建一套？卡片与评论不受影响。')
              if (!ok) return
              act('project.reset', { projectId: project.id }).then(function (res) {
                if (!res) return
                var lines = [res.message || '已重建']
                var rnotes = (res.init && res.init.setupNotes) || []
                if (rnotes.length) lines.push('环境：' + rnotes.join('；'))
                if ((res.skipped || []).length) lines.push('跳过：' + res.skipped.map(function (x) { return (x.name || x.agentId) + '（' + (x.message || '在跑任务') + '）' }).join('；'))
                lines.push('新会话还没对话过，侧栏只显示当前打开的那一个；点「打开会话」让它出现。')
                setNotice(lines.join(SEP))
              })
            },
          }, busy === 'project.reset' ? '重建中…' : '清理并重建会话'))
          if (project.config && project.config.recordIssues) {
        moreItems.push(h(Btn, {
            disabled: busy === 'event.sync',
            title: '立刻拉一次远程 issue/PR（平时 15s 自动同步一次）',
            onClick: function () {
              act('event.sync', { projectId: project.id }).then(function (res) {
                if (!res) return
                if (res.ok === false) {
                  var why = res.reason || res.skipped || '未知原因'
                  var extra = []
                  if (res.lastError) extra.push('最近错误：' + res.lastError)
                  if (res.circuitUntil) extra.push('熔断到 ' + String(res.circuitUntil).slice(11, 16))
                  if (res.skipped === 'circuit') extra.push('（正在熔断冷却期，稍后再试）')
                  setNotice('同步失败：' + why + (extra.length ? '\n' + extra.join('\n') : ''))
                  load()
                  return
                }
                var s = res.stats || {}
                var lines = ['同步完成：新增 ' + (s.added || 0) + ' · 更新 ' + (s.updated || 0) +
                  ' · 未变 ' + (s.unchanged || 0) + ' · 事件 ' + (s.events || 0)]
                if (s.outbound || s.comments) lines.push('出站评论 ' + (s.comments || 0) + ' 条')
                if (res.cursor) lines.push('游标：' + res.cursor)
                if (res.pulled && res.pulled.reason) lines.push('原因：' + res.pulled.reason)
                setNotice(lines.join(SEP))
                load()
              }).catch(function (err) {
                var r = (err && err.result) || {}
                var parts = ['同步失败：' + (r.reason || r.skipped || (err && err.message) || '未知原因')]
                if (r.lastError) parts.push('最近错误：' + r.lastError)
                if (r.circuitUntil) parts.push('熔断到 ' + String(r.circuitUntil).slice(11, 16))
                if (r.skipped === 'circuit') parts.push('（正在熔断冷却期，稍后再试）')
                setNotice(parts.join(SEP))
                load()
              })
            },
          }, busy === 'event.sync' ? '同步中…' : '同步 issue'))
          }
        }
        var moreMenu = h('div', { className: 'flowv-menu' },
          h('button', {
            type: 'button',
            className: 'flowv-btn' + (menuOpen ? ' is-on' : ''),
            'aria-haspopup': 'true',
            'aria-expanded': menuOpen ? 'true' : 'false',
            title: '初始化仓库 / 重建会话 / 手动同步',
            onClick: function () { setMenuOpen(function (prev) { return !prev }) },
          }, '更多 ' + '\u25BE'),
          menuOpen ? h('div', { className: 'flowv-menu-pop' }, moreItems) : null)

        var head = h('div', { className: 'flowv-head' },
          h('div', { className: 'flowv-name' }, project ? project.name : '调度台'),
          project ? h('div', { className: 'flowv-path', title: project.path || '' }, project.path || '') : null,
          h('div', { className: 'flowv-spacer' }),
          st.degraded && caps.checked && !caps.bind ? h(Chip, { tone: 'warn', title: '服务端还是旧版本：需要重启 dsh web' }, '需重启后端') : null,
          st.degraded && (!caps.checked || caps.bind) ? h(Chip, { tone: 'warn', title: '数据来自 /state 本地组装' }, '降级数据') : null,
          // v1.4：工作区即项目，任意对话都能调度——不再有"绑定/解绑主调度"
          project ? h(Chip, { tone: 'ok', title: '这个工作区就是这个项目；本对话可以直接调度' }, '工作区 = 项目') : null,
          project ? h(Btn, { onClick: function () { setModal('new-task'); setDraft({ title: '', note: '', acceptance: '', priority: 'medium', lane: 'human' }) } }, '+ 新建任务') : null,
          project && moreItems.length ? moreMenu : null,



          // v1.24 一键停止：控制位是进程级开关，所以按钮常驻（不跟 recordIssues 走）。
          // 停下来之后这一颗变成"恢复调度"——同一个位置，避免停下后找不到出口。
          h(Btn, {
            variant: ctl.halted ? 'primary' : 'danger',
            disabled: busy === 'flow.halt' || busy === 'flow.resume',
            title: ctl.halted
              ? '恢复后下一拍开始自动推进（卡的状态不会被自动改）'
              : '立刻停止所有自动推进：不派工、不跑 tick、报错与停止生成也不再发给调度；在跑的会话会被取消',
            onClick: function () {
              var halting = !ctl.halted
              if (halting && !window.confirm('停止全部调度？\n\n• 不再自动派工、不再跑 tick\n• 生成报错/停止生成不会再发给调度\n• 正在跑的会话会被取消（卡停在原列，状态不自动改）\n\n恢复前不会自动继续。')) return
              var action = halting ? 'flow.halt' : 'flow.resume'
              setBusy(action)
              act(action, halting ? { reason: '人工一键停止' } : {}).then(function (res) {
                setBusy('')
                if (!res) return
                setNotice(res.message || (halting ? '已停止调度' : '已恢复调度'))
                load()
              })
            },
          }, (busy === 'flow.halt' ? '停止中…' : busy === 'flow.resume' ? '恢复中…' : (ctl.halted ? '恢复调度' : '停止全部调度'))),
          project ? h(Btn, { onClick: function () { openSettings() } }, '设置') : null,
        )

        if (st.phase === 'loading') return h('div', { className: 'flowv' }, head, h('div', { className: 'flowv-loading' }, '加载中…'))
        if (st.phase === 'no-session') return h('div', { className: 'flowv' }, head, h('div', { className: 'flowv-loading' }, '这个视图需要一个会话。'))
        if (st.phase === 'unbound') {
          var sess = st.session || {}
          return h('div', { className: 'flowv' }, head,
            notice ? h('div', { className: 'flowv-note' }, notice) : null,
            h('div', { className: 'flowv-body' },
              h('div', { className: 'flowv-empty' },
                h('div', { style: { marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' } }, '这个对话所在的工作区还没有登记为项目。'),
                sess.cwd ? h('div', { className: 'flowv-mono', style: { marginBottom: 10 } }, '会话目录：' + sess.cwd) : null,
                h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' } },
                  h(Btn, { variant: 'primary', onClick: function () { setModal('new-project'); setDraft({ path: sess.cwd || '', name: '' }) } }, '按当前目录建立项目'),
                  h(Btn, { onClick: function () { load() } }, '重新检测'),
                ),
                h('div', { className: 'flowv-hint', style: { marginTop: 10 } }, '工作区 = 项目：在 DSH 里把目录加成工作区后，这里会自动出现对应项目；也可以在聊天里执行 /flow 自动认领。'),
              )))
        }
        if (st.phase === 'error') {
          return h('div', { className: 'flowv' }, head,
            h('div', { className: 'flowv-err' }, '加载失败：' + st.error),
            h('div', { className: 'flowv-loading' }, '检查 /api/flow/session-project 是否可达。'))
        }

        var v = st.view
        var totals = v.totals || { tasks: 0, running: 0, blocked: 0, approvals: 0 }
        var agents = v.agents || []
        var agentName = function (id) {
          var a = agents.filter(function (x) { return x.id === id })[0]
          return a ? a.name : (id || '—')
        }

        // ---- 渲染：统计条 -----------------------------------------------------
        var mt = metrics || {}
        var mTotals = mt.totals || totals
        var mTok = mt.tokens || null
        var sess = mTotals.sessions || {}
        var inboxM = mTotals.inbox || {}
        var msgM = mTotals.messages || {}
        var Stat = function (p) { return h('div', { className: 'flowv-stat' + (p.tone ? ' is-'+p.tone : ''), title: p.title || '' }, h('b', null, p.val), h('span', null, p.label)) }
        var Sep = function () { return h('div', { className: 'flowv-stats-sep' }) }
        // v0.011：首屏只留六个「会让我立刻动手」的数字，其余收进折叠。
        // 十六个数字并排时人眼一个都不读 —— 密度不等于信息量。
        var stats = h('div', { className: 'flowv-stats' },
          h(Stat, { val: String(mTotals.tasks), label: '任务' }),
          h(Stat, { val: String(mTotals.running), label: '执行中', tone: mTotals.running > 0 ? 'ok' : '' }),
          h(Stat, { val: String(mTotals.blocked), label: '阻塞', tone: mTotals.blocked > 0 ? 'bad' : '' }),
          h(Stat, { val: String(mTotals.verifying || 0), label: '待验收' }),
          h(Stat, { val: String(inboxM.open || 0), label: '待答复', tone: (inboxM.open || 0) > 0 ? 'warn' : '' }),
          mTok && mTok.available
            ? h(Stat, { val: fmtTokens(mTok.uncachedInput + mTok.cacheRead + mTok.output), label: 'Token 总量',
                title: '输入 ' + fmtTokens(mTok.uncachedInput) + ' · 缓存读 ' + fmtTokens(mTok.cacheRead) + ' · 缓存写 ' + fmtTokens(mTok.cacheWrite) + ' · 输出 ' + fmtTokens(mTok.output) })
            : h('div', { className: 'flowv-stat', title: 'DSH 没有暴露 tokenMeter / sessionController，读不到 token 统计' }, h('b', null, '不可用'), h('span', null, 'Token')),
          h('div', { className: 'flowv-stats-more' },
            h(Fold, {
              id: 'stats:all',
              title: '全部统计',
              summary: '会话 · 缓存 · 轮步 · 流量',
              open: foldOpen('stats:all', false),
              onToggle: function () { toggleFold('stats:all', false) },
            },
              h('div', { className: 'flowv-stats-all' },
                // —— 会话 ——
                h(Stat, { val: String(sess.active || 0), label: '活跃会话', tone: (sess.active || 0) > 0 ? 'ok' : '' }),
                h(Stat, { val: String(sess.idle || 0), label: '空闲' }),
                h(Stat, { val: String(sess.total || agents.length), label: '对话数' }),
                h(Sep),
                // —— Inbox ——
                h(Stat, { val: String(inboxM.answered || 0), label: '待调度确认' }),
                h(Sep),
                // —— Token / 缓存 ——
                mTok && mTok.cacheHitPct !== null && mTok.cacheHitPct !== undefined
                  ? h(Stat, { val: mTok.cacheHitPct + '%', label: '缓存命中率', tone: mTok.cacheHitPct >= 50 ? 'ok' : 'warn', title: 'cacheRead ÷ (未缓存输入 + cacheRead)' })
                  : h('div', { className: 'flowv-stat' }, h('b', null, '—'), h('span', null, '缓存命中率')),
                mTok && mTok.perMinTokens !== null && mTok.perMinTokens !== undefined
                  ? h(Stat, { val: fmtTokens(mTok.perMinTokens), label: 'Token/分' })
                  : h('div', { className: 'flowv-stat' }, h('b', null, '—'), h('span', null, 'Token/分')),
                h(Sep),
                // —— 轮数 / 步数 ——
                mTok
                  ? h(Stat, { val: String(mTok.turns || 0), label: '总轮数', title: mTok.since ? '本次插件启动后累计（起算 ' + dayTime(mTok.since) + '，之前的历史不计入）' : '' })
                  : h('div', { className: 'flowv-stat' }, h('b', null, '—'), h('span', null, '总轮数')),
                mTok
                  ? h(Stat, { val: String(mTok.steps || 0), label: '总步数', title: mTok.since ? '本次插件启动后累计（起算 ' + dayTime(mTok.since) + '）' : '' })
                  : h('div', { className: 'flowv-stat' }, h('b', null, '—'), h('span', null, '总步数')),
                mTok && mTok.perMinSteps !== null && mTok.perMinSteps !== undefined
                  ? h(Stat, { val: String(mTok.perMinSteps), label: '步/分' })
                  : h('div', { className: 'flowv-stat' }, h('b', null, '—'), h('span', null, '步/分')),
                h(Sep),
                // —— 消息流量 ——
                h(Stat, { val: String(msgM.total || 0), label: '投递数' }),
                h(Stat, { val: String(msgM.recent5 || 0), label: '近5分' }),
              )),
          ),
        )

        // ---- 渲染：车道 -------------------------------------------------------
        // v0.011：两张车道卡并成一行分段 —— 车道是「谁在干活」的概览，不是一张要读的卡。
        // 水位条只在超过 70% 时出现：正常水位不需要占像素，快满了才值得提醒。
        var laneRow = function (lane) {
          var busy = lane.running || 0
          var ratio = Number(lane.budget && lane.budget.max) || 0
          var hint = lane.waitingWorker ? '缺工位 ' + lane.waitingWorker : (lane.waitingSupervisor ? '缺调度 ' + lane.waitingSupervisor : '')
          return h('div', { className: 'flowv-lane-row', key: lane.lane },
            h('span', { className: 'flowv-lane-name' }, lane.lane === 'issue' ? 'issue 自动' : '人直派'),
            h('span', { className: 'flowv-lane-meta' }, lane.dispatchers + ' 调度 / ' + lane.workers + ' 工人'),
            busy ? h(Chip, { tone: 'ok' }, '在跑 ' + busy) : null,
            lane.blocked ? h(Chip, { tone: 'bad' }, '阻塞 ' + lane.blocked) : null,
            hint ? h(Chip, { tone: 'warn' }, hint) : null,
            ratio > 0.7
              ? h('span', { className: 'flowv-lane-water ' + ratioClass(ratio), title: '上下文水位 ' + pct(ratio) }, h('i', { style: { width: pct(ratio) } }))
              : null)
        }

        // ---- 渲染：看板 -------------------------------------------------------
        var commentCount = function (taskId) {
          // 事件里没有评论计数，这里用任务卡上已有的字段（无则 0）
          return 0
        }
        var PHASE_LABEL = {
          executing: '执行中', investigating: '调研中', 'waiting-approval': '待批准', discussing: '讨论中',
          dispatched: '已交接', 'waiting-worker': '等工位', classifying: '判读中', paused: '已暂停',
          'awaiting-acceptance': '待验收', 'merge-ready': '待开 PR', 'review-pending': '待审核',
          'risk-escalation': '风险升级', 'changes-requested': '要求修改',
          merged: '已合并', 'merged-skipped': '跳过合并', 'done-no-merge': '无需合并',
        }
        var PHASE_REDUNDANT = { 'running/executing': true, 'verifying/awaiting-acceptance': true }
        // v1.37：重新设计的 4 行卡片
        // 行1：状态点 + ID + 车道 + 时间；行2：标题；行3：阻塞/下一步；行4：执行者·验收进度·请示数·PR
        var PROGRESS_STATE_LABEL = { 'on-track': '进行中', waiting: '等待中', blocked: '已阻塞', partial: '部分完成', done: '本轮完成' }

        // ---- mergeState 的读侧表（ADR-0005）------------------------------------
        //
        // 为什么在这里内联一份，而不是 import lib/merge-state.js：
        // client.js 是 window.__ModuleLoader__ 的 bundle（id: '@local/dsh-flow'），
        // 整个文件没有 import/export —— 宿主只负责把模块装进浏览器，浏览器里拿不到
        // lib/*.js 的模块图，相对路径的 ESM import 在这里根本不会被解析。
        // 所以表在客户端必须有一份**同形状的副本**。
        //
        // 唯一来源仍是 lib/merge-state.js。改一处要改两处：test/merge-state.mjs
        // 会逐条比对两边的 label / fix，漏改一处测试就红 —— 宁可测试红，也不能让
        // 看板 chip 和详情行各说各话。
        var MERGE_REASON = {
          'no-code-change': { label: '没有代码改动', fix: '无需处理：这张卡的交付物不是代码', tone: 'info' },
          'coordination-card': { label: '协调卡', fix: '无需处理：父卡只做汇总，改动在子卡里合并', tone: 'info' },
          'superseded': { label: '已被父卡取代', fix: '无需处理：改动改由父分支统一发布', tone: 'info' },
          'no-worktree': { label: '没有检出', fix: '本身就按主工作区交付，无需处理', tone: 'info' },
          'not-a-repo': { label: '不是 Git 仓库', fix: '无需处理：改动直接落在工作区，没有分支可合', tone: 'warn' },
          'no-commits': { label: '缺基线提交', fix: '初始化仓库：在项目目录执行 `git add -A && git commit -m "baseline"`', tone: 'warn' },
          'base-missing': { label: '基线分支不存在', fix: '改项目设置里的基线分支（`git branch --show-current` 看真实分支名）', tone: 'bad' },
          'branch-busy': { label: '分支被占用', fix: '清掉残留检出：`git worktree list` 找到占用者，再 `git worktree remove <该目录>`', tone: 'bad' },
          'head-mismatch': { label: '验收后又提交了', fix: '重新验收一次（`git log --oneline -3` 确认当前提交）', tone: 'bad' },
          'out-of-scope-dirty': { label: '改到了范围外', fix: '把范围外的改动退回或另开一张卡，再重新派工', tone: 'bad' },
          'worktree-missing': { label: '检出不见了', fix: '重新派工会重建检出（`git worktree list` 先确认它真的没了）', tone: 'bad' },
          'needs-rebase': { label: '分支落后基线', fix: '等调度回派工人做一次软合并，或手工 rebase 到基线', tone: 'warn' },
        }
        var MERGE_STATE_LABEL = { none: '不需要合并', pending: '等待合并', blocked: '合不了', ready: '可合并' }

        // 与 lib/merge-state.js 的 mergeReasonOf 同规则：未知原因是线上数据里可能出现的东西，
        // 一次 undefined 就是整页白屏 —— 兜底退回任务自己那句人话。
        var mergeReasonOf = function (task) {
          var t = task || {}
          var hit = t.mergeReason ? MERGE_REASON[t.mergeReason] : null
          if (hit) return hit
          return { label: String(t.noMergeReason || ''), fix: '', tone: 'info', state: t.mergeState || null }
        }

        // chip 的 title 是单行纯文本，反引号在那里没有意义；详情页才按反引号切成等宽段。
        var mergeFixTitle = function (fix) { return String(fix || '').replace(/`/g, '') }

        // fix 里的动作用反引号圈住可复制命令；只有偶数段是正文、奇数段是命令。
        var mergeFixNodes = function (fix) {
          var parts = String(fix || '').split('`')
          var out = []
          for (var i = 0; i < parts.length; i += 1) {
            if (!parts[i]) continue
            out.push(i % 2 === 1
              ? h('span', { key: 'mfix' + i, className: 'flowv-mono' }, parts[i])
              : h('span', { key: 'mfix' + i }, parts[i]))
          }
          return out
        }

        /**
         * 看板卡片上的合并徽标。只有 blocked / pending 出声：
         * none 是"本来就不用合"，占一个位置反而会把真故障淹掉（ADR-0005 界面取舍 1）；
         * ready 是终态里的正常值，出 chip 只会让每张卡都挂一个彩色标。
         */
        var mergeBadgeOf = function (t) {
          var state = t && t.mergeState
          if (state !== 'blocked' && state !== 'pending') return null
          var info = mergeReasonOf(t)
          return {
            tone: state === 'pending' ? 'info' : (info.tone || 'bad'),
            text: info.label || MERGE_STATE_LABEL[state] || state,
            title: mergeFixTitle(info.fix) || (MERGE_STATE_LABEL[state] || state),
          }
        }

        /**
         * 详情页「合并」行：状态 · 原因，blocked 再附一行修复动作。
         *
         * 为什么 blocked 要两行：详情页是人来动手的地方，修复动作藏进 title 等于没有；
         * 看板才需要收成一枚 chip。none 保留一行淡的（"不需要合并 · 原因"），
         * 因为看板要扫、详情要解释（ADR-0005 界面取舍 1）。
         * 没有 mergeState 的老数据仍显示原来那句"不走合并（原因）"—— 升级窗口里
         * 服务端可能还没重启，详情页不能因此少一项。
         */
        // ---- 交付态（C-03 / rf-02 的展示侧）------------------------------------
        //
        // 与 lib/core.js 的 DELIVERY_STATE / deliveryState 同形。为什么内联：
        // 和上面 mergeState 表同一个理由 —— 浏览器里拿不到 lib/*.js 的模块图。
        // lib/panel.js 的 deliveryStateOf 是第二份镜像；两边都由
        // test/panel-visibility.mjs 与 core 比对，漂移就红。
        //
        // 为什么要单独一套而不是看 column==='done'：done 有三条来路，只有
        // phase==='merged' 真的把代码放进了 base。用列判断会把「有意不合并」
        // 和「本来没有可合的东西」也算成交付（T-036/T-042 的假完成就是这么来的）。
        var DELIVERY_STATE_LABEL = {
          delivered: '已交付',
          skipped: '有意未合并',
          'no-merge': '无可合并内容',
          'merged-into-parent': '已合入父分支',
          partial: '部分完成，还有剩余',
          'not-delivered': '未交付',
        }
        var deliveryStateOf = function (t) {
          if (!t || t.column !== 'done') return 'not-delivered'
          if (t.phase === 'merged') return 'delivered'
          if (t.phase === 'merged-skipped') return 'skipped'
          if (t.phase === 'done-no-merge') return 'no-merge'
          if (t.phase === 'merged-into-parent') return 'merged-into-parent'
          // v0.008：工作单元直接在父检出里提交，落点同样是父分支。
          if (t.phase === 'done-in-parent') return 'merged-into-parent'
          if (t.phase === 'done-partial') return 'partial'
          return 'not-delivered'
        }
        // 服务端投影带 deliveryState 时以它为准（老服务端还没重启时退回本地算）。
        var deliveryOf = function (t) {
          return (t && t.deliveryState) || deliveryStateOf(t)
        }

        /**
         * 看板卡片上的交付徽标。
         *
         * delivered 不出标：正常的 done 不需要噪音（和 mergeState 的 none/ready 同理）。
         * 另外三种都要出 —— 它们都是「列写着完成、代码没进 base」的假完成形态，
         * 不出标就等于让看板替它撒谎。
         */
        var deliveryBadgeOf = function (t) {
          var state = deliveryOf(t)
          if (state === 'skipped') {
            return { tone: 'warn', text: '未合并', title: '有意未合并：这张卡决定不合并（不是故障，但代码没进基线）' }
          }
          if (state === 'no-merge') {
            return { tone: 'info', text: '无可合', title: '无可合并内容：这张卡本来就没有要合进基线的东西' }
          }
          if (state === 'merged-into-parent') {
            return { tone: 'info', text: '已合入父分支', title: '已合入父分支：改动在父分支上统一发布，不单独进基线' }
          }
          return null
        }

        /**
         * 详情页「交付」行：永远显示一行人话（详情页要解释，看板才要收窄）。
         * 非 done 的卡显示「未交付 · 还在路上」—— 它不是缺陷，所以用淡色。
         */
        var deliveryKvRow = function (task) {
          var state = deliveryOf(task)
          var label = DELIVERY_STATE_LABEL[state] || state
          if (state === 'delivered') {
            return ['交付', h('span', { title: 'phase=merged：代码已进入基线分支' }, label)]
          }
          if (state === 'not-delivered') {
            var hint = task && (task.column === 'done' ? '完成态但不是合并落点（没有进基线）' : '还在路上')
            return ['交付', h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' }, title: hint }, label + ' · ' + hint)]
          }
          if (state === 'skipped') {
            return ['交付', h('div', null,
              h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, label),
              h('div', { className: 'flowv-hint', style: { marginTop: 2 } }, '这张卡有意不合并（merge_skip）；要合得重新开卡或改 mergeState。'))]
          }
          if (state === 'no-merge') {
            return ['交付', h('span', { title: '本来就没有可合进基线的东西' }, label)]
          }
          // 工作单元的落点必须写出**具体分支名**：只写「改动在父分支上」，
          // 人还是得回去翻父卡才知道是哪条分支（T-049 那次就是这么绕回不来的）。
          var land = task && (task.branchFrom || (task.parentId ? 'flow/' + task.parentId : null))
          return ['交付落点', h('span', { title: '改动由父卡那一个 PR 统一发布' },
            label + ' · ' + (land ? h('span', { className: 'flowv-mono' }, land) : '父分支'))]
        }

        /**
         * 父卡的「子卡核对」行（v0.008）：rollup 在收口时逐张子卡核过「到底落没落地」。
         * 没落地的子卡（done-no-commit / merge_skip）必须在这一行显形 ——
         * 否则父卡看起来「子卡都完成了」，实际有一条支线的活根本没进来。
         */
        var rollupKvRow = function (task) {
          var r = task && task.rollup
          if (!r) return null
          var bad = Array.isArray(r.undelivered) ? r.undelivered : []
          if (!bad.length) {
            return ['子卡核对', h('span', { title: '每张子卡都有落地提交' }, '全部落地（' + String((r.delivered || []).length) + ' 张）')]
          }
          return ['子卡核对', h('div', null,
            h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '有 ' + bad.length + ' 张子卡没有落地改动'),
            h('div', { className: 'flowv-hint', style: { marginTop: 2 } }, bad.join('、') + ' —— 核对后再决定要不要合并'))]
        }

        var mergeKvRow = function (task) {
          // v0.008：工作单元没有「合并」这一维。以前它显示「不走合并（no-code-change）」，
          // 那是一句既不准确也不解释任何事的话 —— 子卡的交付面只有父卡。
          if (task && task.parentId) return null
          var state = task && task.mergeState
          if (!state) {
            if (!task || !task.noMerge) return null
            return ['合并', h('span', { title: task.noMergeReason || '' }, '不走合并（' + (task.noMergeReason || '没有 worktree') + '）')]
          }
          var info = mergeReasonOf(task)
          var text = (MERGE_STATE_LABEL[state] || state) + (info.label ? ' · ' + info.label : '')
          if (state === 'blocked') {
            return ['合并', h('div', null,
              h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, text),
              info.fix
                ? h('div', { className: 'flowv-hint', style: { marginTop: 2 } }, '还能修：', mergeFixNodes(info.fix))
                : null)]
          }
          return ['合并', h('span', { style: { color: state === 'none' ? 'var(--dsw-alias-label-tertiary)' : undefined }, title: info.fix ? mergeFixTitle(info.fix) : '' }, text)]
        }

        var boardCard = function (t) {
          var pg = t.progress
          var pgState = pg ? pg.state : null
          var dotClass = 'flowv-task-dot ' + (pgState || 'none')
          var timeStr = fmtTime(t.lastActivityAt || t.updatedAt)
          // ── 行2：标题（保留高优先标签紧靠卡号）
          // v0.011：徽标优先级与「只把最要紧的一枚说出来」下沉到 lib/view-model.js（服务端算好）。
          // 这里只负责画：最多 2 枚 + 溢出计数。六枚并排时每张卡都像告警，等于没有告警。
          var view = t.view || null
          var sideBadges = []
          if (view && Array.isArray(view.chips)) {
            for (var bi = 0; bi < view.chips.length; bi += 1) {
              var cb = view.chips[bi] || {}
              sideBadges.push(h(Chip, { key: cb.key || ('b' + bi), tone: cb.tone, title: cb.title || '' }, cb.text))
            }
            if (view.more) {
              sideBadges.push(h(Chip, { key: 'more', tone: 'info', title: '还有 ' + view.more + ' 项状态，点开详情看全' }, '+' + view.more))
            }
          } else {
            // 老服务端（没有 view 字段）走原来的路径：升级窗口里不能因为少一个字段就少一堆状态。
            if (t.lane === 'issue') sideBadges.push(h(Chip, { key: 'lane' }, 'issue'))
            var mergeBadge = mergeBadgeOf(t)
            if (mergeBadge) sideBadges.push(h(Chip, { key: 'merge', tone: mergeBadge.tone, title: mergeBadge.title }, mergeBadge.text))
            var deliveryBadge = deliveryBadgeOf(t)
            if (deliveryBadge) sideBadges.push(h(Chip, { key: 'delivery', tone: deliveryBadge.tone, title: deliveryBadge.title }, deliveryBadge.text))
            if (t.risk && t.risk.level === 'high') sideBadges.push(h(Chip, { key: 'risk', tone: 'bad', title: (t.risk.reasons || []).join('；') }, '高风险'))
            if (t.reopenRequested) sideBadges.push(h(Chip, { key: 'rrq', tone: 'warn', title: '申请重开：' + t.reopenRequested.reason }, '重开申请'))
            if (t.childProgress) {
              var cp = t.childProgress
              sideBadges.push(h(Chip, { key: 'kids', tone: cp.done >= cp.total ? 'ok' : 'info', title: '子任务 ' + cp.done + '/' + cp.total + ' 完成（子卡在详情里打开）' }, '子任务 ' + cp.done + '/' + cp.total))
            }
            if (t.grill && t.grill.status === 'running') sideBadges.push(h(Chip, { key: 'grill', tone: 'info', title: '需求评审第 ' + t.grill.rounds + '/' + t.grill.maxRounds + ' 轮' }, '评审中'))
            if (t.grill && t.grill.verdict === 'escalate') sideBadges.push(h(Chip, { key: 'grillx', tone: 'warn', title: '有 ' + (t.grill.openForHuman || []).length + ' 个问题等你定' }, '评审待定'))
          }
          // ── 行3：阻塞点 > next > phase（降优先级后移至此）
          var row2Text = null, row2Class = 'flowv-task-row2'
          // 一句话现状由服务端算（blocked > blocker > next > 阶段），看板不再各自排优先级。
          if (view && view.headline && view.headline.text) {
            row2Text = view.headline.text
            row2Class += view.headline.tone === 'bad' ? ' is-blocked' : ' is-progress'
          } else if (t.blocked) { row2Text = '⛔ ' + (t.blocked.reason || '阻塞'); row2Class += ' is-blocked' }
          else if (pg && pg.blocker) { row2Text = '⛔ ' + pg.blocker; row2Class += ' is-blocked' }
          else if (pg && pg.next) { row2Text = '→ ' + pg.next; row2Class += ' is-progress' }
          else if (t.phase && !PHASE_REDUNDANT[t.column + '/' + t.phase]) { row2Text = PHASE_LABEL[t.phase] || t.phase; row2Class += ' is-progress' }
          // ── 行4：执行者·验收进度·请示数·PR/issue
          var row3Parts = []
          if (t.assignee) row3Parts.push(agentName(t.assignee))
          if (t.acceptance && t.acceptance.total > 0) {
            row3Parts.push('验收 ' + t.acceptance.pass + '/' + t.acceptance.total)
          }
          if (t.openInbox > 0) row3Parts.push('📨' + t.openInbox)
          if (t.remote && t.remote.issueNumber) {
            row3Parts.push(t.remote.url
              ? h('a', { key: 'ri', className: 'flowv-chip-link', href: t.remote.url, target: '_blank', rel: 'noreferrer', onClick: function (e) { e.stopPropagation() } }, '#' + t.remote.issueNumber)
              : '#' + t.remote.issueNumber)
          }
          if (t.pullRequestStatus) row3Parts.push('PR·' + t.pullRequestStatus)
          var titleHover = (t.title || '') + (t.blocked ? '\n阻塞：' + t.blocked.reason : '') + (pg && pg.next ? '\n→ ' + pg.next : '')
          return h('div', {
            className: 'flowv-task' + (t.blocked ? ' blocked' : ''),
            key: t.id, title: titleHover,
            onClick: function () { openDrawer(t.id) },
          },
          // 行1: 状态·ID·时间
          h('div', { className: 'flowv-task-id' },
            h('span', { className: dotClass, title: pgState ? PROGRESS_STATE_LABEL[pgState] : '无进度' }),
            t.id,
            sideBadges.length ? h('span', { style: { display:'inline-flex', gap:'3px', marginLeft:'3px' } }, ...sideBadges) : null,
            h('span', { style: { marginLeft:'auto', flexShrink:0 } }, timeStr)
          ),
          // 行2: 标题 (2行截断)
          h('div', { className: 'flowv-task-title', style: { WebkitLineClamp: 2, marginBottom: row2Text ? '2px' : '5px' } }, t.title || '(未命名)'),
          // 行3: 阻塞/下一步/阶段
          row2Text ? h('div', { className: row2Class }, row2Text) : null,
          // 行4: 底部元信息
          row3Parts.length ? h('div', { className: 'flowv-task-row3' }, ...row3Parts.map(function (p, i) {
            if (typeof p === 'string') return h('span', { key: i }, p)
            return p
          }).reduce(function (acc, el, i) { return i === 0 ? [el] : [...acc, h('span', { key: 's'+i, style:{color:'var(--dsw-alias-border-l3)'} }, '·'), el] }, []))
          : null)
        }
        /** 每页多少张（项目配置可覆盖，默认 8）。 */
        var pageSize = function () {
          var n = Number(v.project && v.project.config && v.project.config.columnPageSize)
          return n > 0 ? n : 8
        }

        var columnEl = function (col) {
          var all = (v.tasks[col.id] || [])
          var size = pageSize()
          // 窗口式分页：offset = "从最新那张往后跳过多少张"。
          // 服务端已按"后移入的排前面"排好（columnAt 倒序），所以：
          //   offset=0 → 最近进来的一页
          //   点下端 → offset += size（看更早的）
          //   点上端 → offset -= size（翻回更新的）
          var offset = Math.max(0, Number(colShown[col.id]) || 0)
          // offset 可能越界（这一列的卡变少了），夹到最后一页
          var maxOffset = Math.max(0, Math.floor((all.length - 1) / size) * size)
          if (offset > maxOffset) offset = maxOffset
          var list = all.slice(offset, offset + size)
          var newerCount = offset
          var olderCount = Math.max(0, all.length - offset - list.length)

          /** 翻一页：delta 为 +size 往下（更早），-size 往上（更新）。 */
          var goPage = function (delta) {
            return function (e) {
              if (e) e.stopPropagation()
              setColShown(function (prev) {
                var next = Object.assign({}, prev)
                next[col.id] = Math.max(0, (Number(next[col.id]) || 0) + delta)
                return next
              })
            }
          }
          // 上端：翻回更新的一页（只有在还有更新的卡时才出现）
          var newerBtn = newerCount > 0
            ? h('div', {
                className: 'flowv-more flowv-more--up',
                key: 'newer',
                title: '上面还有 ' + newerCount + ' 张更新的，点这里翻回去',
                onClick: goPage(-size),
              }, '↑ 更新 ' + Math.min(size, newerCount) + ' 张')
            : null
          // 下端：翻到更早的一页
          var olderBtn = olderCount > 0
            ? h('div', {
                className: 'flowv-more flowv-more--down',
                key: 'older',
                title: '下面还有 ' + olderCount + ' 张更早的，点这里往下翻',
                onClick: goPage(size),
              }, '↓ 更早 ' + Math.min(size, olderCount) + ' 张')
            : null
          var collapsed = colCollapsed[col.id] === true
          var colCls = 'flowv-col' + (list.length ? ' has-tasks' : ' is-empty') +
            (col.id === 'running' ? ' is-running' : (col.id === 'done' || col.id === 'cancelled') ? ' is-terminal' : '') +
            (collapsed ? ' is-collapsed' : '')
          // 列头计数显示"翻到第几张/共几张"，翻页时能看出自己在哪
          var label = all.length > size && list.length
            ? (offset + 1) + '-' + (offset + list.length) + '/' + all.length
            : String(col.count)
          return h('div', { className: colCls, key: col.id },
            h('button', {
              type: 'button',
              className: 'flowv-col-head',
              title: (collapsed ? '展开这一列' : '收起这一列') + (COLUMN_HINTS[col.id] ? ' · ' + COLUMN_HINTS[col.id] : ''),
              'aria-expanded': collapsed ? 'false' : 'true',
              onClick: function () {
                setColCollapsed(function (prev) {
                  var next = Object.assign({}, prev)
                  if (next[col.id]) delete next[col.id]; else next[col.id] = true
                  return next
                })
              },
            },
              h('span', null, collapsed ? '▸ ' + col.title : col.title), h('b', null, label)),
            collapsed ? null : h('div', { className: 'flowv-col-body' },
              newerBtn,
              list.length ? list.map(boardCard)
                : h('div', { className: 'flowv-col-hint' }, COLUMN_HINTS[col.id] || ''),
              olderBtn)
          )
        }

        // ---- 渲染：分区 -------------------------------------------------------
        var sec = function (title, items, render, emptyText) {
          var list = items || []
          if (!list.length && !emptyText) return null
          return h('div', { className: 'flowv-sec', key: title },
            h('h4', null, title),
            list.length ? h('ul', { className: 'flowv-list' }, list.map(render)) : h('div', { className: 'flowv-sec-empty' }, emptyText))
        }

        /** 打开请示箱：拉一次最新数据。 */
        var refreshInbox = function (opts) {
          var want = opts || {}
          // 归档区要连已归档一起拉；其余视图默认不拉
          var includeArchived = want.includeArchived === true
          // 只置 loading，不把 items 清空：清空会让列表闪一下，且选中项在数据回来前无处可落。
          setInbox(function (prev) { return Object.assign({}, prev || {}, { loading: true, replying: null, includeArchived: includeArchived }) })
          postAction('inbox.list', {
            projectId: v.project.id,
            includeArchived: includeArchived,
            q: want.q || (inbox && inbox.q) || '',
          }).then(function (res) {
            if (!res) return
            setInbox(function (prev) {
              var base = prev || {}
              // 只在服务端真的给了数组时才替换列表。
              // 直接写 res.items || [] 的话，一次形状异常的响应就会把
              // 打开抽屉时带进来的数据清空 —— 用户看到的是"点开就空了"。
              return Object.assign({}, base, {
                items: Array.isArray(res.items) ? res.items : (base.items || []),
                open: (res.counts && typeof res.counts.open === 'number') ? res.counts.open : (base.open || 0),
                answered: (res.counts && typeof res.counts.answered === 'number') ? res.counts.answered : (base.answered || 0),
                counts: res.counts || base.counts || {},
                total: typeof res.total === 'number' ? res.total : (base.total || 0),
                loading: false,
              })
            })
            // 打开箱子先把「第一条未读」标成已读：列表里那颗未读点不该停在一条你正在看的工单上。
            // 只发一次（inboxReadSent 去重），失败也不打扰人。
            var fresh = ((res.items || []).filter(function (x) { return x.status !== 'archived' && !x.readAt })[0]) || null
            if (fresh && !inboxReadSent[fresh.id]) {
              inboxReadSent[fresh.id] = true
              silentRead(fresh.id).then(function () {
                setInbox(function (prev) {
                  var base2 = prev || {}
                  var items2 = (base2.items || []).map(function (x) {
                    return x.id === fresh.id ? Object.assign({}, x, { readAt: new Date().toISOString() }) : x
                  })
                  var c2 = Object.assign({}, base2.counts || {})
                  if (typeof c2.unread === 'number') c2.unread = Math.max(0, c2.unread - 1)
                  return Object.assign({}, base2, { items: items2, counts: c2 })
                })
              }).catch(function () {})
            }
          }).catch(function () {
            setInbox(function (prev) { return Object.assign({}, prev || {}, { loading: false }) })
          })
        }
        // 请示箱图标：托盘 + 下坠箭头，一眼是「收件」而不是「列表」。
        var InboxIcon = function () {
          return h('svg', {
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
            h('path', { d: 'M4 13h4l2 3h4l2-3h4' }),
            h('path', { d: 'M4 13 6.5 5h11L20 13v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4Z' })
          )
        }

        // v0.012：哪些工单已经发过「标已读」请求。渲染期间不能改 state，
        // 所以放在模型外面做一个幂等的去重表（同一条工单只发一次）。
        var inboxReadSent = {}
// v0.013：标已读是「顺手做的事」，失败不该弹红条 —— 老版本服务端还没这个 action，
// 用户会看到「unknown action: inbox.read」而工单其实一切正常。
var silentRead = function (inboxId) {
  return postAction('inbox.read', { inboxId: inboxId }).catch(function () { return null })
}

        // ---- 渲染：Inbox 工单抽屉（v1.37）--------------------------------------
        // 请示类是多轮工单（有对话线、可追问、归档后留档）；info 类是一次性通知，已读即归档。
        // error 是「系统自己坏了」（调度员连续失败到头）—— 与通知同形状，但要看得出是坏消息。
        var INBOX_KIND_LABEL = { decision: '待决策', blocked: '阻塞', risk: '风险审批', info: '通知', error: '系统错误' }
        var INBOX_KIND_TONE = { decision: 'warn', blocked: 'bad', risk: 'bad', info: 'info', error: 'bad' }
        var renderInbox = function () {
          if (!inbox) return null
          var close = function (e) { if (e) e.stopPropagation(); setInbox(null) }
          var all = inbox.items || []

          // ---- v0.012 两栏邮箱 -------------------------------------------------
          // 左：收件列表（tab + 搜索 + 行）　右：这一条工单（模板 + 组件 + 聊天区 + 回复区）。
          // 为什么两栏：工单是逐条处理的，一次只该读一条。原来把 N 张工单的全文铺在同一列里，
          // 人滚到第三条就忘了第一条要答什么 —— 那不是「信息多」，是「没有焦点」。
          var TABS = [
            { id: 'todo', label: '待我回' },
            { id: 'replied', label: '已回复' },
            { id: 'notices', label: '通知' },
            { id: 'archived', label: '归档' },
          ]
          var tab = inbox.tab || 'todo'
          var q = inbox.q || ''
          var isNotice = function (x) { return x.kind === 'info' || x.kind === 'error' }
          var isActive = function (x) { return x.status !== 'archived' }
          var keepId = inbox.keep || ''
          var pool = all.filter(function (x) {
            if (tab === 'archived') return !isActive(x)
            if (!isActive(x)) return false
            if (tab === 'notices') return isNotice(x)
            if (isNotice(x)) return false
            // 刚回复的那一条：即便已经变成「已答复」，也留在当前 tab 里，
            // 否则人一回信就被弹到另一张工单，读到一半的上下文当场丢掉。
            if (x.id === keepId) return true
            return tab === 'todo' ? x.status === 'open' : x.status === 'answered'
          })
          var counts = inbox.counts || {}
          var countOf = function (id) {
            if (id === 'todo') return counts.open || 0
            if (id === 'replied') return counts.answered || 0
            if (id === 'notices') return counts.notices || 0
            return counts.archived || 0
          }
          var selected = pool.filter(function (x) { return x.id === (inbox.sel || '') })[0] || pool[0] || null
          var select = function (x) {
            setInbox(Object.assign({}, inbox, { sel: x.id, draft: '', keep: keepId === x.id ? keepId : null }))
            // 选中即已读（列表上的未读点跟着消失）。只在第一次发，失败也不打扰人。
            if (!x.readAt && x.status !== 'archived' && !inboxReadSent[x.id]) {
              inboxReadSent[x.id] = true
              silentRead(x.id).then(function () {
                setInbox(function (prev) {
                  var base = prev || {}
                  var items = (base.items || []).map(function (y) {
                    return y.id === x.id ? Object.assign({}, y, { readAt: new Date().toISOString() }) : y
                  })
                  var c = Object.assign({}, base.counts || {})
                  if (typeof c.unread === 'number') c.unread = Math.max(0, c.unread - 1)
                  return Object.assign({}, base, { items: items, counts: c })
                })
              }).catch(function () {})
            }
          }
          var answeredOf = function (x) {
            var answers = answersOf(x)
            return (Array.isArray(x.asks) ? x.asks : []).filter(function (a) {
              return answers[a.key] !== undefined && String(answers[a.key]).trim() !== ''
            }).length
          }
          var tabsEl = h('nav', { className: 'flowv-mail-tabs' }, TABS.map(function (t) {
            var on = tab === t.id
            return h('button', {
              key: 'tab-' + t.id, type: 'button',
              className: 'flowv-mail-tab' + (on ? ' on' : ''),
              'aria-pressed': on ? 'true' : 'false',
              onClick: function (e) {
                e.stopPropagation()
                setInbox(Object.assign({}, inbox, { tab: t.id, sel: null, keep: null }))
                if (t.id === 'archived') refreshInbox({ includeArchived: true })
                else refreshInbox({ includeArchived: false })
                setInbox(Object.assign({}, inbox, { tab: t.id, sel: null }))
              },
            }, t.label, h('span', { className: 'flowv-mail-tab-n' }, String(countOf(t.id))))
          }))
          var searchEl = h('input', {
            className: 'flowv-input flowv-mail-search', type: 'search', value: q,
            placeholder: '搜索标题 / 卡号…',
            onChange: function (e) { setInbox(Object.assign({}, inbox, { q: e.target.value })) },
            onKeyDown: function (e) {
              if (e.key !== 'Enter') return
              e.stopPropagation()
              refreshInbox({ q: e.target.value, includeArchived: tab === 'archived' })
            },
          })
          var rowEl = function (x) {
            var on = selected && selected.id === x.id
            var unread = !x.readAt && x.status !== 'archived'
            var asks = Array.isArray(x.asks) ? x.asks : []
            return h('button', {
              key: 'row-' + x.id, type: 'button',
              className: 'flowv-mail-row' + (on ? ' is-sel' : '') + (unread ? ' is-unread' : ''),
              onClick: function (e) { e.stopPropagation(); select(x) },
            },
              h('span', { className: 'flowv-mail-dot', 'aria-hidden': 'true' }),
              h('div', { className: 'flowv-mail-row-main' },
                h('div', { className: 'flowv-mail-row-top' },
                  h(Chip, { tone: INBOX_KIND_TONE[x.kind] || 'info' }, INBOX_KIND_LABEL[x.kind] || x.kind),
                  h('span', { className: 'flowv-mail-row-time' }, dayTime(x.updatedAt || x.createdAt))),
                h('span', { className: 'flowv-mail-row-title' }, x.topic || '(无标题)'),
                h('div', { className: 'flowv-mail-row-meta' },
                  x.taskId ? h('span', { className: 'flowv-mono' }, x.taskId) : null,
                  asks.length ? h('span', null, answeredOf(x) + '/' + asks.length) : null,
                  x.id === (inbox.keep || '') ? h('span', { className: 'flowv-mail-row-keep' }, x.status === 'archived' ? '已归档' : '刚回复') : (x.status === 'answered' ? h('span', null, '已回') : null),
                  x.status === 'archived' ? h('span', null, '归档') : null)))
          }

          // 选项按钮：点了把选项文字填进回复框，人可以接着补充
          // ---- v1.39 结构化分区 ------------------------------------------------
          // 单条工单固定五段：概况条 / 现状 / 需要你补充 / 调度建议 / 处理记录。
          // 换掉原来的一长串"问题背景/现状/进行状况/阻塞点..."平铺 —— 那些段落全是
          // 同一层级的文字块，人扫不出"哪一段要我动手"。
          var ASK_TYPE_LABEL = { choice: '选择', text: '填写', confirm: '确认', number: '数字' }
          // 草稿按工单 id 存，避免两张工单都用 q1 时互相串值
          var answersOf = function (x) { return (inbox.answers && inbox.answers[x.id]) || {} }
          var setAnswer = function (x, key, val) {
            var all = Object.assign({}, inbox.answers || {})
            var mine = Object.assign({}, all[x.id] || {})
            mine[key] = val
            all[x.id] = mine
            setInbox(Object.assign({}, inbox, { answers: all }))
          }

          var evidenceChips = function (x) {
            var ev = (x.context && x.context.evidence) || []
            if (!ev.length) return null
            return h('div', { className: 'flowv-ask-ev' },
              ev.map(function (e, i) {
                return h('code', { key: 'ev' + i, className: 'flowv-ask-ev-item', title: e.ref }, e.kind + ':' + String(e.ref || '').slice(0, 40))
              }))
          }

          // 现状区：事实 + 证据 + 进行状况
          var factsEl = function (x) {
            var facts = (x.context && x.context.facts) || []
            // 老工单没有 context：把 where / current 当成现状，别让这一段空着
            if (!facts.length && !x.current && !x.progress && !x.where) return null
            return h('section', { className: 'flowv-ib-sec' },
              h('h6', { className: 'flowv-ib-sec-h' }, '现状'),
              facts.length ? h('ul', { className: 'flowv-ib-facts' }, facts.map(function (f, i) { return h('li', { key: 'f' + i }, f) })) : null,
              x.current ? md(x.current) : null,
              x.where ? h('div', { className: 'flowv-ib-prog' }, h('span', { className: 'flowv-ib-prog-k' }, '在哪'), h('span', { className: 'flowv-mono' }, x.where)) : null,
              x.progress ? h('div', { className: 'flowv-ib-prog' }, h('span', { className: 'flowv-ib-prog-k' }, '已进行'), x.progress) : null,
              evidenceChips(x))
          }

          // 需要你补充：每一项一个卡片，带"为什么问你 / 推荐 / 卡住什么"
          var askCard = function (x, a) {
            var draft = answersOf(x)
            var val = draft[a.key]
            var setVal = function (v) { setAnswer(x, a.key, v) }
            var disabled = x.status === 'archived'
            var control = null
            if (a.type === 'choice') {
              control = h('div', { className: 'flowv-ask-choices' }, (a.choices || []).map(function (c) {
                var on = val === c.value
                return h('button', {
                  key: 'ch-' + a.key + '-' + c.value,
                  className: 'flowv-ask-choice' + (on ? ' on' : ''),
                  disabled: disabled,
                  'aria-pressed': on ? 'true' : 'false',
                  onClick: function (e) { e.stopPropagation(); if (!disabled) setVal(c.value) },
                },
                  h('b', null, c.label),
                  c.impact ? h('span', { className: 'flowv-ask-choice-impact' }, c.impact) : null)
              }))
            } else if (a.type === 'confirm') {
              control = h('div', { className: 'flowv-ask-confirm' },
                ['yes', 'no'].map(function (v) {
                  var on = val === v
                  return h('button', {
                    key: 'cf-' + a.key + '-' + v,
                    className: 'flowv-ask-choice' + (on ? ' on' : ''),
                    disabled: disabled, 'aria-pressed': on ? 'true' : 'false',
                    onClick: function (e) { e.stopPropagation(); if (!disabled) setVal(v) },
                  }, v === 'yes' ? '可以' : '不行')
                }))
            } else {
              control = h('input', {
                className: 'flowv-input', type: a.type === 'number' ? 'number' : 'text',
                value: val == null ? '' : val, disabled: disabled,
                placeholder: a.default || '填写…',
                onChange: function (e) { setVal(e.target.value) },
              })
            }
            return h('div', { className: 'flowv-ask' + (a.required ? ' is-required' : ''), key: 'ask-' + a.key },
              h('div', { className: 'flowv-ask-hd' },
                h('span', { className: 'flowv-ask-k' }, a.key),
                h('b', null, a.question),
                h('span', { className: 'flowv-ask-type' }, ASK_TYPE_LABEL[a.type] || a.type),
                // v1.39.1：选项全部可选（只写补充说明也行），required 只表示"调度最想知道"
                a.required ? h('span', { className: 'flowv-ask-req' }, '重要') : h('span', { className: 'flowv-ask-opt' }, '可选')),
              a.why ? h('div', { className: 'flowv-ask-why' }, a.why) : null,
              a.default ? h('div', { className: 'flowv-ask-rec' },
                h('span', { className: 'flowv-ask-rec-k' }, '推荐'),
                // 选择题的 default 存的是 value（A/B），显示时要换成人读的 label
                h('span', null, (function () {
                  const hit = (a.choices || []).filter(function (c) { return c.value === a.default })[0]
                  if (hit) return hit.label
                  if (a.type === 'confirm') return a.default === 'yes' ? '可以' : (a.default === 'no' ? '不行' : a.default)
                  return a.default
                })()),
                a.defaultReason ? h('span', { className: 'flowv-ask-rec-why' }, a.defaultReason) : null) : null,
              control,
              a.blocks ? h('div', { className: 'flowv-ask-blocks' }, '不答会卡住：' + a.blocks) : null)
          }

          var asksEl = function (x) {
            var asks = Array.isArray(x.asks) ? x.asks : []
            if (!asks.length) return null
            var answered = answersOf(x)
            var answeredCount = asks.filter(function (a) { return answered[a.key] !== undefined && String(answered[a.key]).trim() !== '' }).length
            return h('section', { className: 'flowv-ib-sec' },
              h('h6', { className: 'flowv-ib-sec-h' }, '需要你补充（选项可不答，写一句也行）',
                h('span', { className: 'flowv-ib-sec-n' }, answeredCount + '/' + asks.length)),
              asks.map(function (a) { return askCard(x, a) }))
          }

          var impactEl = function (x) {
            if (!x.impactIfNoAnswer) return null
            return h('div', { className: 'flowv-ib-impact' }, h('b', null, '不答会怎样'), x.impactIfNoAnswer)
          }

          var suggestEl = function (x) {
            if (!x.suggestion) return null
            return h('section', { className: 'flowv-ib-sec' },
              h('h6', { className: 'flowv-ib-sec-h' }, '调度建议'),
              md(x.suggestion))
          }

          // 处理记录：默认折成一行摘要，点开才是时间线（含结构化答案）
          var threadEl = function (x) {
            var reps = Array.isArray(x.replies) ? x.replies.slice().sort(function (a, b) {
              return String(a.at || '') < String(b.at || '') ? -1 : 1
            }) : []
            if (!reps.length) return null
            var open = !!inbox.threadOpen[x.id]
            var last = reps[reps.length - 1] || {}
            var asksByKey = {}
            ;(x.asks || []).forEach(function (a) { asksByKey[a.key] = a })
            return h('section', { className: 'flowv-ib-sec flowv-ib-thread' },
              h('button', {
                className: 'flowv-ib-thread-toggle', type: 'button',
                'aria-expanded': open ? 'true' : 'false',
                onClick: function (e) { e.stopPropagation(); var o = Object.assign({}, inbox.threadOpen || {}); o[x.id] = !open; setInbox(Object.assign({}, inbox, { threadOpen: o })) },
              },
                h('span', null, '处理记录'),
                h('span', { className: 'flowv-ib-thread-sum' }, reps.length + ' 条 · 最近：' + ((last.role || 'human') === 'human' ? '你' : (last.by || '调度')) + ' ' + dayTime(last.at)),
                h('span', { className: 'flowv-ib-thread-chev' }, open ? '收起' : '展开')),
              open ? h('div', { className: 'flowv-ib-timeline' }, reps.map(function (r) {
                var mine = (r.role || 'human') === 'human'
                var ans = r.answers || {}
                var ansKeys = Object.keys(ans)
                return h('div', { className: 'flowv-ib-msg' + (mine ? ' is-mine' : ''), key: r.id },
                  h('div', { className: 'flowv-ib-msg-who' },
                    (mine ? '你' : (r.by || '调度')) + ' · ' + dayTime(r.at),
                    ansKeys.length ? h('span', { className: 'flowv-ib-msg-kv' }, ' 结构化 ' + ansKeys.length + ' 项') : null),
                  r.content ? md(r.content) : null,
                  ansKeys.length ? h('dl', { className: 'flowv-ib-answers' }, ansKeys.map(function (k) {
                    var a = asksByKey[k] || {}
                    var hit = (a.choices || []).filter(function (c) { return c.value === ans[k] })[0]
                    return h('div', { className: 'flowv-ib-answer', key: 'an-' + k },
                      h('dt', null, a.question ? a.question.slice(0, 40) : k),
                      h('dd', null, hit ? hit.label : ans[k]))
                  })) : null)
              })) : null)
          }

          // ---- v0.013 回复区：引用 / 附件 / 快捷采纳 -------------------------
          // 不再是一个“提交表单”，而是聊天输入区：能引用上一句、能附加证据、能一键采纳推荐。
          // 判断标准仍然是“人能不能直接动手”——输入框 + 三个按钮就是最小的聊天能力。
          var composerEl = function (x) {
            var asks = Array.isArray(x.asks) ? x.asks : []
            var answers = answersOf(x)
            var missing = asks.filter(function (a) { return a.required }).filter(function (a) {
              var v = answers[a.key]
              return v === undefined || String(v).trim() === ''
            })
            var recAll = function (e) {
              if (e) e.stopPropagation()
              var next = Object.assign({}, answers)
              asks.forEach(function (a) { if (a.default && (next[a.key] === undefined || String(next[a.key]).trim() === '')) next[a.key] = a.default })
              var all = Object.assign({}, inbox.answers || {})
              all[x.id] = next
              setInbox(Object.assign({}, inbox, { answers: all }))
            }
            var quote = inbox.quote && inbox.quote.anchor === x.id ? inbox.quote : null
            var attach = inbox.attach && inbox.attach.anchor === x.id && Array.isArray(inbox.attach.items) ? inbox.attach.items : []
            var setAttach = function (items) {
              setInbox(Object.assign({}, inbox, { attach: { anchor: x.id, items: items } }))
            }
            var addAttach = function (raw) {
              var v = String(raw || '').trim()
              if (!v) return
              if (attach.indexOf(v) >= 0) return
              setAttach(attach.concat([v]).slice(0, 8))
              setInbox(Object.assign({}, inbox, { attachDraft: '' }))
            }
            var answeredCount = Object.keys(answers).filter(function (k) { return answers[k] !== undefined && String(answers[k]).trim() !== '' }).length
            var hasBody = !!String(inbox.draft || '').trim()
            var canSend = !(busy === 'inbox.reply' || x.status === 'archived' || (!hasBody && answeredCount === 0 && attach.length === 0))
            var send = function (e) {
              if (e) e.stopPropagation()
              if (!canSend) return
              var content = String(inbox.draft || '').trim()
              // 引用写进正文（Markdown 引用），而不是藏在一个系统字段里：
              // 调度看到的就是人看到的那一段。
              if (quote) content = '> ' + quote.who + ' · ' + quote.at + '：' + quote.text + (content ? SEP + SEP + content : '')
              // 附件按形状分派成两种组件：http(s) 是链接徽标，其余当作文件证据。
              var blocks = attach.map(function (a) {
                return /^https?:\/\//i.test(a)
                  ? { type: 'link', items: [{ provider: 'web', kind: 'link', label: a, url: a }] }
                  : { type: 'evidence', items: [{ kind: 'file', ref: a }] }
              })
              setBusy('inbox.reply')
              act('inbox.reply', { inboxId: x.id, content: content, answers: answers, blocks: blocks }).then(function (res) {
                setBusy('')
                if (!res) return
                setNotice('已回复。' + (missing.length ? '还有 ' + missing.length + ' 项没答，调度会再问你。' : '已通知调度员在票里回复你。'))
                var keep = Object.assign({}, inbox.answers || {})
                delete keep[x.id]
                // v0.013.1：回复完**留在这一条**。原来这里会 refreshInbox，工单变成「已答复」后被
                // 当前 tab 过滤掉，选中项顺势落到下一条 —— 人刚写完一段话就被弹去看别的工单，
                // 既丢了读的上下文，也不知道自己刚发的那条长什么样。
                // 现在本地就地更新（不用等一次网络往返），并把 keep 记住：列表仍留着这一行、消息流仍停在这里。
                var at = new Date().toISOString()
                var items2 = (inbox.items || []).map(function (y) {
                  if (y.id !== x.id) return y
                  var prevReps = Array.isArray(y.replies) ? y.replies : []
                  return Object.assign({}, y, {
                    status: 'answered',
                    readAt: y.readAt || at,
                    updatedAt: at,
                    replies: prevReps.concat([{
                      id: 'local-' + at, at: at, by: 'human:web', role: 'human',
                      content: content, blocks: blocks, answers: answers,
                    }]),
                  })
                })
                var c2 = Object.assign({}, inbox.counts || {})
                if (typeof c2.open === 'number') c2.open = Math.max(0, c2.open - 1)
                if (typeof c2.answered === 'number') c2.answered = c2.answered + 1
                setInbox(Object.assign({}, inbox, {
                  answers: keep, draft: '', quote: null, attach: null, attachOpen: false, attachDraft: '', keep: null,
                  items: items2, counts: c2, open: c2.open, answered: c2.answered,
                  sel: x.id, keep: x.id,
                }))
                load()
                // 发送后回到消息流底部：新的那条就在眼前，不用自己拖。
                setTimeout(function () {
                  if (typeof document !== 'undefined' && document.querySelector) {
                    var el = document.querySelector('.flowv-mail-stream')
                    if (el) el.scrollTop = el.scrollHeight
                  }
                }, 0)
              })
            }
            var clearQuote = function (e) { if (e) e.stopPropagation(); setInbox(Object.assign({}, inbox, { quote: null })) }
            return h('div', { className: 'flowv-composer' },
              quote ? h('div', { className: 'flowv-quote' },
                h('span', { className: 'flowv-quote-b' }, '引用 ' + quote.who + ' · ' + quote.at),
                h('span', { className: 'flowv-quote-tx' }, quote.text),
                h('button', { type: 'button', className: 'flowv-quote-x', title: '取消引用', onClick: clearQuote }, '×')) : null,
              attach.length ? h('div', { className: 'flowv-attach' }, attach.map(function (a, i) {
                return h('span', { className: 'flowv-attach-chip', key: 'at' + i },
                  h('i', null, /^https?:/i.test(a) ? '链接' : '文件'),
                  h('span', { className: 'flowv-attach-tx' }, a),
                  h('button', { type: 'button', className: 'flowv-attach-x', title: '移除', onClick: function (e) { e.stopPropagation(); setAttach(attach.filter(function (_, j) { return j !== i })) } }, '×'))
              })) : null,
              inbox.attachOpen ? h('input', {
                className: 'flowv-input flowv-attach-in',
                placeholder: '文件路径或链接，回车加入（如 lib/dispatch.js 或 https://…）',
                value: inbox.attachDraft || '',
                onChange: function (e) { setInbox(Object.assign({}, inbox, { attachDraft: e.target.value })) },
                onKeyDown: function (e) {
                  if (e.key === 'Enter') { e.preventDefault(); addAttach(e.target.value) }
                },
              }) : null,
              h('textarea', {
                className: 'flowv-textarea flowv-composer-tx', rows: 3,
                value: inbox.draft || '',
                placeholder: '写回复…（只说这一条需要对方知道的事；Ctrl+Enter 发送）',
                onChange: function (e) { setInbox(Object.assign({}, inbox, { draft: e.target.value })) },
                onKeyDown: function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e) },
              }),
              h('div', { className: 'flowv-composer-bar' },
                h('button', {
                  type: 'button', className: 'flowv-tool', title: '引用上一条内容',
                  onClick: function (e) {
                    e.stopPropagation()
                    var reps = x.replies || []
                    var last = reps[reps.length - 1]
                    var who = last ? (last.role === 'human' ? '你' : (last.by || '调度')) : (x.from || '调度')
                    var at = last ? last.at : x.createdAt
                    var text = last ? last.content : (x.problem || x.topic || '')
                    setInbox(Object.assign({}, inbox, { quote: { anchor: x.id, who: who, at: dayTime(at), text: String(text || '').slice(0, 400) } }))
                  },
                }, '引用'),
                h('button', {
                  type: 'button', className: 'flowv-tool' + (inbox.attachOpen ? ' on' : ''), title: '附一份证据或链接',
                  onClick: function (e) { e.stopPropagation(); setInbox(Object.assign({}, inbox, { attachOpen: !inbox.attachOpen })) },
                }, '附文件'),
                asks.some(function (a) { return a.default }) ? h('button', { type: 'button', className: 'flowv-tool', onClick: recAll }, '采纳推荐') : null,
                h('div', { className: 'flowv-spacer' }),
                missing.length ? h('span', { className: 'flowv-ib-missing' }, '未答 ' + missing.length + ' 项（可不答）') : null,
                h(Btn, {
                  small: true, variant: 'primary',
                  disabled: !canSend,
                  onClick: send,
                }, busy === 'inbox.reply' ? '发送中…' : '发送回复')))
          }
          // info 类：一行通知条，点已读即归档
          var infoEl = function (x) {
            return h('div', { className: 'flowv-inbox-info', key: x.id },
              h(Chip, { tone: 'info' }, '通知'),
              h('span', { className: 'flowv-inbox-info-tx' }, x.topic || ''),
              h('span', { className: 'flowv-inbox-meta', style: { margin: 0 } }, dayTime(x.createdAt)),
              x.status === 'archived'
                ? h(Chip, null, '已读')
                : h(Btn, {
                    small: true,
                    disabled: busy === 'inbox.read',
                    onClick: function (e) {
                      if (e) e.stopPropagation()
                      setBusy('inbox.read')
                      act('inbox.mark-read', { inboxId: x.id }).then(function () { setBusy(''); refreshInbox({ includeArchived: inbox.tab === 'archived' }) })
                    },
                  }, '已读'))
          }

          // 工单卡：五段分区

          // ---- 预设组件 -------------------------------------------------------
          // 组件是「可在界面上直接动手的内容」：快捷选项点一下就填进你的回答，
          // 现状卡片 / 证据 / 链接是**只读的事实**，进度与变更让人一眼知道走到哪。
          // 不认识的类型在服务端就被丢了（lib/inbox-blocks.js 白名单），这里只负责画。
          var BLOCK_TONE = { info: 'is-info', warn: 'is-warn', danger: 'is-danger', ok: 'is-ok' }
          var toneCls = function (t) { return t && BLOCK_TONE[t] ? ' ' + BLOCK_TONE[t] : '' }
          var chooseBlock = function (x, b, o) {
            var asks = Array.isArray(x.asks) ? x.asks : []
            var hit = asks.filter(function (a) { return a.key === b.key })[0]
            if (hit) { setAnswer(x, hit.key, o.value); return }
            // 组件上的选项没有对应 ask：当成一句现成的回复填进输入框，人还能改。
            var line = String(inbox.draft || '').trim()
            setInbox(Object.assign({}, inbox, { draft: (line ? line + String.fromCharCode(10) : '') + o.label }))
          }
          var blockEl = function (x, b, key) {
            if (b.type === 'note') {
              return h('div', { key: key, className: 'flowv-blk' + toneCls(b.tone) },
                b.title ? h('b', null, b.title) : null,
                h('div', { className: 'flowv-blk-tx' }, b.text))
            }
            if (b.type === 'choice') {
              return h('div', { key: key, className: 'flowv-blk is-choice' },
                h('div', { className: 'flowv-blk-tx' }, h('b', null, b.key), ' · ' + b.prompt),
                h('div', { className: 'flowv-blk-choices' }, (b.options || []).map(function (o) {
                  var on = (answersOf(x) || {})[b.key] === o.value
                  return h('button', {
                    key: 'bc-' + key + '-' + o.value, type: 'button',
                    className: 'flowv-blk-choice' + (on ? ' on' : '') + (o.recommended ? ' is-rec' : ''),
                    'aria-pressed': on ? 'true' : 'false',
                    onClick: function (e) { e.stopPropagation(); chooseBlock(x, b, o) },
                  }, h('b', null, o.label), o.impact ? h('span', null, o.impact) : null)
                })))
            }
            if (b.type === 'facts') {
              return h('div', { key: key, className: 'flowv-blk is-facts' },
                b.title ? h('b', null, b.title) : null,
                h('dl', { className: 'flowv-blk-dl' }, (b.items || []).map(function (it, i) {
                  return h('div', { key: 'f' + i, className: 'flowv-blk-kv' + toneCls(it.tone) },
                    h('dt', null, it.k), h('dd', null, it.v))
                })))
            }
            if (b.type === 'evidence') {
              return h('div', { key: key, className: 'flowv-blk is-ev' }, (b.items || []).map(function (e, i) {
                return h('code', { key: 'e' + i, className: 'flowv-blk-ev', title: e.ref },
                  (e.kind || 'ref') + ':' + String(e.ref || '').slice(0, 60))
              }))
            }
            if (b.type === 'link') {
              return h('div', { key: key, className: 'flowv-blk is-link' }, (b.items || []).map(function (l, i) {
                return h('a', {
                  key: 'l' + i, className: 'flowv-blk-link', href: l.url,
                  target: '_blank', rel: 'noreferrer noopener',
                  onClick: function (e) { e.stopPropagation() },
                }, (l.number ? l.kind + ' #' + l.number : (l.label || l.url)) + (l.state ? ' · ' + l.state : ''))
              }))
            }
            if (b.type === 'progress') {
              var pct = Math.max(0, Math.min(100, Math.round((b.done / b.total) * 100)))
              return h('div', { key: key, className: 'flowv-blk is-prog' },
                h('div', { className: 'flowv-blk-prog-hd' },
                  h('span', null, b.label || '进度'),
                  h('span', { className: 'flowv-mono' }, b.done + '/' + b.total)),
                h('div', { className: 'flowv-blk-bar' }, h('i', { style: { width: pct + '%' } })))
            }
            if (b.type === 'diff') {
              return h('div', { key: key, className: 'flowv-blk is-diff' },
                h('span', { className: 'flowv-mono' }, b.files + ' 文件'),
                h('span', { className: 'flowv-blk-add' }, '+' + b.additions),
                h('span', { className: 'flowv-blk-del' }, '-' + b.deletions),
                b.base || b.head
                  ? h('span', { className: 'flowv-mono flowv-blk-sha' },
                    String(b.base || '?').slice(0, 8) + ' → ' + String(b.head || '?').slice(0, 8))
                  : null)
            }
            if (b.type === 'checklist') {
              return h('div', { key: key, className: 'flowv-blk is-list' },
                b.title ? h('b', null, b.title) : null,
                h('ul', { className: 'flowv-blk-ul' }, (b.items || []).map(function (it) {
                  return h('li', { key: 'c' + it.id, className: it.checked ? 'is-done' : '' },
                    (it.checked ? '☑ ' : '☐ ') + it.text)
                })))
            }
            return h('pre', { key: key, className: 'flowv-blk is-code' }, h('code', null, b.text))
          }
          var blocksEl = function (x) {
            var list = Array.isArray(x.blocks) ? x.blocks : []
            var reps = x.replies || []
            var lastRep = reps[reps.length - 1]
            var extra = lastRep && Array.isArray(lastRep.blocks) ? lastRep.blocks : []
            var merged = list.concat(extra)
            if (!merged.length) return null
            return h('div', { className: 'flowv-blks' }, merged.map(function (b, i) { return blockEl(x, b, 'bk' + i) }))
          }

          // 归档（手动兜底）：归档完**留在这一条**，和回复同样的就地更新 —— 否则刚点完归档
          // 这张工单就从当前 tab 消失、选中项跳到下一张，人会以为自己点错了。
          var archiveInbox = function (x) {
            if (!window.confirm('直接归档这条工单？' + SEP + SEP + '通常应该让调度自己判断阻塞是否消除后再归档；这里手动归档是兜底。')) return
            setBusy('inbox.archive')
            act('inbox.archive', { inboxId: x.id }).then(function (res) {
              if (!res) return
              setNotice('已归档。归档后的工单在「归档」里还能翻到。')
              var at = new Date().toISOString()
              var items3 = (inbox.items || []).map(function (y) {
                return y.id !== x.id ? y : Object.assign({}, y, { status: 'archived', readAt: y.readAt || at, updatedAt: at })
              })
              var c3 = Object.assign({}, inbox.counts || {})
              if (typeof c3.open === 'number') c3.open = Math.max(0, c3.open - 1)
              if (typeof c3.archived === 'number') c3.archived = c3.archived + 1
              setInbox(Object.assign({}, inbox, {
                items: items3, counts: c3, open: c3.open, archived: c3.archived,
                sel: x.id, keep: x.id,
              }))
            })
          }
          var actsEl = function (x) {
            if (x.status === 'archived') return h('div', { className: 'flowv-inbox-acts' }, h('span', { className: 'flowv-hint' }, '已归档 · 只读留档'))
            return h('div', { className: 'flowv-inbox-acts' },
              h(Btn, {
                small: true,
                title: '手动归档：一般不需要 —— 调度看到你的回复后会自己判断阻塞是否消除并归档',
                disabled: busy === 'inbox.archive',
                onClick: function (e) { e.stopPropagation(); archiveInbox(x) },
              }, '手动归档'))
          }
          // ---- v0.013 消息流：整条工单读起来像一条对话，但不用气泡 ----------
          // 不用气泡的理由：气泡把内容挤成窄条，长段落与表格会碎；工单正文往往长，
          // 所以用“左对齐的段落 + 上方一行角色/时间”，靠间距与发丝线区分消息。
          var blocksOf = function (list, pref) {
            var arr = Array.isArray(list) ? list : []
            if (!arr.length) return null
            return h('div', { className: 'flowv-blks' }, arr.map(function (b, i) { return blockEl({}, b, pref + i) }))
          }
          var msgEl = function (opts) {
            return h('article', {
              key: opts.key,
              className: 'flowv-msg' + (opts.mine ? ' is-mine' : '') + (opts.ticket ? ' is-ticket' : ''),
            },
              h('div', { className: 'flowv-msg-hd' },
                h('span', { className: 'flowv-msg-who' }, opts.who || '系统'),
                h('span', { className: 'flowv-msg-at' }, opts.at || ''),
                h('div', { className: 'flowv-spacer' }),
                opts.onQuote ? h('button', { type: 'button', className: 'flowv-msg-act', title: '引用这条内容', onClick: opts.onQuote }, '引用') : null),
              h('div', { className: 'flowv-msg-body' }, opts.children))
          }

          var headEl = function (x) {
            var asks = Array.isArray(x.asks) ? x.asks : []
            var archived = x.status === 'archived'
            return h('header', { className: 'flowv-mail-head flowv-ib-head' },
              h('div', { className: 'flowv-mail-head-top' },
                h(Chip, { tone: INBOX_KIND_TONE[x.kind] || 'info' }, INBOX_KIND_LABEL[x.kind] || x.kind),
                h('b', { className: 'flowv-mail-title' }, x.topic || '(无标题)'),
                h('div', { className: 'flowv-spacer' }),
                x.taskId ? h('button', {
                  className: 'flowv-mail-task', type: 'button', title: '打开这张卡',
                  onClick: function (e) { e.stopPropagation(); setInbox(null); openDrawer(x.taskId) },
                }, x.taskId) : null,
                // v0.015.1：把「手动归档」放回头栏。v0.013 改成消息流时，归档按钮只留在
                // 已归档分支的脚注里（actsEl 只在 infoDetailEl 与已归档 detail 用），结果问答类
                // 工单一旦没归档就再也点不到归档 —— 而它恰恰是唯一需要人手动兜底的地方。
                (!archived && x.kind !== 'info' && x.kind !== 'error') ? h('button', {
                  className: 'flowv-mail-arch', type: 'button',
                  title: '手动归档这条工单（一般是兜底：正常情况让调度判断阻塞消除后自己归档）',
                  disabled: busy === 'inbox.archive',
                  onClick: function (e) { e.stopPropagation(); archiveInbox(x) },
                }, '归档') : null,
                h('span', { className: 'flowv-ib-status' }, archived ? '已归档' : (x.status === 'answered' ? '已答复 · 待调度确认' : '待答复'))),
              h('div', { className: 'flowv-mail-head-meta' },
                dayTime(x.createdAt) + ' · 来自 ' + (x.from || '-')
                + (x.lane ? ' · ' + x.lane + ' 车道' : '')
                + (asks.length ? ' · 补充 ' + answeredOf(x) + '/' + asks.length : '')
                + (x.replies && x.replies.length ? ' · 往来 ' + x.replies.length + ' 条' : '')))
          }

          var streamEl = function (x) {
            var replies = Array.isArray(x.replies) ? x.replies : []
            return h('div', { className: 'flowv-mail-stream' },
              msgEl({
                key: 'ticket-' + x.id, ticket: true,
                who: (x.from || '调度'), at: dayTime(x.createdAt),
                onQuote: function (e) {
                  e.stopPropagation()
                  setInbox(Object.assign({}, inbox, { quote: { anchor: x.id, who: (x.from || '调度'), at: dayTime(x.createdAt), text: String(x.problem || x.topic || '').slice(0, 400) } }))
                },
                children: [
                  blocksOf(x.blocks, 'tb'),
                  x.problem ? h('div', { className: 'flowv-ib-problem' }, md(x.problem)) : null,
                  factsEl(x),
                  impactEl(x),
                  asksEl(x),
                  suggestEl(x),
                ],
              }),
              replies.map(function (r) {
                var mine = r.role === 'human'
                var who = mine ? '你' : (r.role === 'system' ? '系统' : (r.by || '调度'))
                return msgEl({
                  key: 'r-' + r.id, mine: mine, who: who, at: dayTime(r.at),
                  onQuote: function (e) {
                    e.stopPropagation()
                    setInbox(Object.assign({}, inbox, { quote: { anchor: x.id, who: who, at: dayTime(r.at), text: String(r.content || '').slice(0, 400) } }))
                  },
                  children: [
                    blocksOf(r.blocks, 'rb'),
                    r.content ? h('div', { className: 'flowv-msg-tx' }, md(r.content)) : null,
                    (r.answers && Object.keys(r.answers).length)
                      ? h('div', { className: 'flowv-msg-note' }, '已回答 ' + Object.keys(r.answers).length + ' 项')
                      : null,
                  ],
                })
              }),
              x.status === 'archived' ? h('div', { className: 'flowv-mail-archived' }, '已归档 · 只读留档') : null)
          }

          var detailEl = function (x) {
            return h('div', { key: 'd-' + x.id, className: 'flowv-mail-detail' },
              headEl(x),
              streamEl(x),
              x.status === 'archived' ? h('div', { className: 'flowv-mail-foot' }, actsEl(x)) : composerEl(x))
          }

          var infoDetailEl = function (x) {
            return h('div', { key: 'd-' + x.id, className: 'flowv-mail-detail' },
              headEl(x),
              h('div', { className: 'flowv-mail-stream' },
                msgEl({
                  key: 'notice-' + x.id, ticket: true, who: (x.from || '系统'), at: dayTime(x.createdAt),
                  children: [
                    blocksOf(x.blocks, 'nb'),
                    x.body ? h('div', { className: 'flowv-msg-tx' }, md(x.body)) : null,
                    x.problem ? h('div', { className: 'flowv-msg-tx' }, md(x.problem)) : null,
                  ],
                })),
              h('div', { className: 'flowv-mail-foot' }, actsEl(x)))
          }
          var sideEl = h('aside', { className: 'flowv-mail-side' },
            h('div', { className: 'flowv-mail-side-hd' },
              h('b', null, 'Inbox'),
              counts.unread ? h('span', { className: 'flowv-mail-unread' }, counts.unread + ' 未读') : null,
              h('div', { className: 'flowv-spacer' })),
            searchEl,
            tabsEl,
            h('div', { className: 'flowv-mail-list' },
              inbox.loading && !pool.length
                ? h('div', { className: 'flowv-loading' }, '载入中…')
                : (pool.length ? pool.map(rowEl) : h('div', { className: 'flowv-hint' }, tab === 'todo' ? '没有等你回的工单。' : '这里没有内容。'))))
          var mainEl = h('section', { className: 'flowv-mail-main' },
            selected ? (isNotice(selected) ? infoDetailEl(selected) : detailEl(selected)) : emptyEl)

          return h('div', { className: 'flowv-sheet-stack', key: 'inbox-stack' },
            h('div', { className: 'flowv-sheet-layer is-top', style: { zIndex: 240 } },
              h('div', { className: 'flowv-sheet-mask flowv-drawer-mask is-top is-open', onClick: close }),
              h('div', {
                className: 'flowv-drawer flowv-drawer--wide flowv-sheet is-open',
                onClick: function (e) { e.stopPropagation() },
                style: { zIndex: 241 },
              },
                h('div', { className: 'flowv-drawer-head' },
                  h(Btn, { small: true, onClick: close }, '← 看板'),
                  h('b', null, 'Inbox'),
                  h(Chip, { tone: (counts.open || 0) > 0 ? 'bad' : 'info' }, (counts.open || 0) + ' 条待答复'),
                  h('div', { className: 'flowv-spacer' })),
                h('div', { className: 'flowv-mail' }, sideEl, mainEl))))
        }
        // ---- 渲染：详情层（v1.39 全屏 + 多层） --------------------------------
        /**
         * 一层详情。layer = { taskId, detail, loading }，depth = 在栈里的位置（0 = 最底），
         * isTop = 是不是最上面那层（只有最上面可交互，下面的压暗）。
         */
        var renderSheet = function (layer, depth, isTop) {
          var drawer = layer
          var d = drawer.detail
          var task = d ? d.task : null
          var close = function (e) { if (e) e.stopPropagation(); closeDrawer() }
          // 面包屑：看板 › T-010 › T-013 —— 每一级都能点回去（点了就是"退到这一层"）
          var crumbs = [h('button', {
            key: 'crumb-board', type: 'button', className: 'flowv-crumb',
            onClick: function (e) { e.stopPropagation(); closeAllSheets() },
          }, '看板')]
          sheets.slice(0, depth + 1).forEach(function (x, i) {
            crumbs.push(h('span', { key: 'sep' + i, className: 'flowv-crumb-sep' }, '›'))
            crumbs.push(h('button', {
              key: 'crumb' + i, type: 'button',
              className: 'flowv-crumb' + (i === depth ? ' is-current' : ''),
              'aria-current': i === depth ? 'page' : 'false',
              onClick: function (e) { e.stopPropagation(); if (i < depth) setSheets(function (prev) { return prev.slice(0, i + 1) }) },
            }, (x.detail && x.detail.task && x.detail.task.id) || x.taskId))
          })
          var headEl = h('div', { className: 'flowv-drawer-head' },
            h(Btn, { small: true, onClick: close }, depth === 0 ? '← 返回看板' : '← 返回 ' + ((((sheets[depth - 1] || {}).detail || {}).task || {}).id || '上一层')),
            h('div', { className: 'flowv-crumbs' }, crumbs),
            // 卡号已经在面包屑末级里，这里只在没有面包屑（loading 态）时补一个
            task && !sheets.length ? h('span', { className: 'flowv-mono' }, task.id) : null,
            task ? h(Chip, { tone: task.blocked ? 'bad' : task.column === 'done' ? 'ok' : 'info' },
              (COLUMN_TITLES[task.blocked ? 'blocked' : task.column] || task.column) + (task.phase ? ' · ' + task.phase : '')) : null,
            task && task.origin === 'auto' ? h(Chip, null, '自动调度') : null,
            d && d.mirror ? h(Chip, { tone: 'info' }, (d.mirror.source || 'remote') + ' #' + (d.mirror.remoteId || '')) : null,
            h('div', { className: 'flowv-spacer' }),
            task ? h(Btn, { small: true, onClick: function () { act('task.inspect', { taskId: task.id }) } }, '让调度员看一眼') : null,
            sheets.length > 1 ? h(Btn, { small: true, title: '一次退到底，回到看板', onClick: function (e) { if (e) e.stopPropagation(); closeAllSheets() } }, '全部关闭') : null,
            // v1.4：删除先不展示（项目/卡的数据清理走 API 或跟着工作区走）
          )

          if (drawer.loading || !d) {
            return h('div', { className: 'flowv-sheet-mask' + (isTop ? ' is-top' : ' is-under'), onClick: isTop ? close : undefined },
              h('div', { className: 'flowv-drawer flowv-sheet', onClick: function (e) { e.stopPropagation() } },
                headEl, h('div', { className: 'flowv-loading' }, '载入中…')))
          }

          var roleClass = { human: 'ok', chief: 'info', dispatcher: 'info', worker: 'warn', remote: 'info', system: '' }
          var commentEl = function (c) {
            var role = c.role || 'human'
            return h('div', { className: 'flowv-cmt', key: c.id },
              h('div', { className: 'flowv-cmt-ava ' + (roleClass[role] || '') }, ROLE_LETTER[role] || '系'),
              h('div', { className: 'flowv-cmt-box' },
                h('div', { className: 'flowv-cmt-hd' },
                  h('b', null, (c.remote && c.remote.login) || ROLE_LABELS[role] || role),
                  h('span', null, dayTime(c.at)),
                  // v1.22：远程来的评论要能点回 GitHub（否则分不清这是谁说的、在哪说的）
                  c.remote && c.remote.url
                    ? h('a', { className: 'flowv-cmt-src', href: c.remote.url, target: '_blank', rel: 'noreferrer', title: '在远程仓库查看这条评论' }, '远程')
                    : null,
                  h('span', { className: 'flowv-cmt-id', title: c.id || '' }, c.id || ''),
                ),
                h(CommentBody, { text: c.content }),
              ))
          }

          var actionsFor = function (t) {
            var out = []
            var b = function (label, action, variant, disabled) {
              out.push(h(Btn, {
                key: action + label, small: true, variant: variant || '', disabled: !!disabled,
                onClick: function () { taskAction(t, action) },
              }, label))
            }
            if (t.column === 'todo') { b('认领 → 规划', 'claim', 'primary'); b('让调度员拆解', 'inspect') }
            if (t.column === 'planning') { b('写计划', 'plan'); b('提交待批', 'plan_ready', 'primary'); b('批准开工', 'approve', 'primary'); b('打回', 'reject') }
            if (t.column === 'running') { b('重新派工', 'dispatch'); b('让调度员看一眼', 'inspect'); b('阻塞', 'block') }
            // v0.008：工作单元（子卡）没有合并这一维 —— 验收就是收口。
            var isUnit = !!t.parentId
            if (t.column === 'verifying') {
              b(t.noMerge || isUnit ? '验收通过 → 完成' : '验收通过 → 合并', 'accept', 'primary')
              b('返工', 'rework')
            }
            if (t.column === 'merging' && !isUnit) {
              // v1.30：没有 PR 快照时直接点「审核通过」只会得到「没有 PR 快照，无法审核」。
              // 与其让人猜，不如把该做的那一步摆出来。
              if (!t.mergeRequest) b('① 开 PR 快照', 'pr_open', 'primary')
              b(t.mergeRequest ? '审核通过' : '审核通过（先开 PR）', 'review_approve', t.mergeRequest ? 'primary' : '', !t.mergeRequest)
              // 非 Git 项目没有 PR 可合：给一个明确的收尾口，别让卡永远停在"合并中"
              b('跳过合并（无 Git）', 'merge_skip')
              b('冲突回工人', 'review_conflict')
              b('有风险', 'review_risk')
            }
            if (t.column === 'done' || t.column === 'cancelled') b('重开', 'reopen')
            if (t.blocked) b('解除阻塞', 'unblock', 'primary')
            if (t.column !== 'done' && t.column !== 'cancelled') b('取消', 'cancel', 'danger')
            return out
          }

          var kv = function (rows) {
            var items = []
            rows.forEach(function (row) {
              if (!row) return
              items.push(h('dt', { key: 'k' + items.length }, row[0]))
              items.push(h('dd', { key: 'v' + items.length }, row[1]))
            })
            return h('dl', { className: 'flowv-kv' }, items)
          }

          // v0.011：抽屉里默认只开「现在要决定的」四块，其余折叠但带摘要。
          // 摘要不是装饰：折叠后如果只剩一个标题，人就失去「要不要展开」的判断依据。
          var cardFold = function (key, summary, defaultOpen) {
            var k = 'drawer:' + task.id + ':' + key
            var vf = (task.view && task.view.folds) || null
            var def = vf && typeof vf[key] === 'boolean' ? vf[key] : defaultOpen === true
            return {
              open: foldOpen(k, def),
              onToggle: function (e) { if (e) e.stopPropagation(); toggleFold(k, def) },
              summary: summary || '',
            }
          }
          var colLabel = COLUMN_TITLES[task.blocked ? 'blocked' : task.column] || task.column
          var leadHeadline = (task.view && task.view.headline && task.view.headline.text) || null
          if (!leadHeadline) {
            leadHeadline = task.blocked ? '⛔ ' + (task.blocked.reason || '阻塞')
              : (task.progress && task.progress.summary) ? task.progress.summary
              : (PHASE_LABEL[task.phase] || task.phase || '')
          }
          var leadTone = (task.view && task.view.headline && task.view.headline.tone) || (task.blocked ? 'bad' : 'info')
          var primaryAction = actionsFor(task)[0] || null
          var leadEl = h('div', { className: 'flowv-drawer-lead' + (leadTone === 'bad' ? ' is-bad' : '') },
            h('span', { className: 'flowv-lead-col' }, colLabel + (task.phase ? ' · ' + task.phase : '')),
            h('span', { className: 'flowv-lead-text', title: leadHeadline }, leadHeadline),
            h('div', { className: 'flowv-spacer' }),
            primaryAction)

          var titleInput = h('input', {
            className: 'flowv-input flowv-title-input',
            defaultValue: task.title || '',
            placeholder: '给这个任务起个标题',
            key: 'title-' + task.id + '-' + task.version,
            onBlur: function (e) {
              var val = e.target.value.trim()
              if (val && val !== task.title) act('task.update', { taskId: task.id, patch: { title: val } }).then(function () { reloadDrawer(task.id) })
            },
            onKeyDown: function (e) { if (e.key === 'Enter') e.target.blur() },
          })
          var accInput = { value: '' }

          var open = !!drawer
          return h('div', { className: 'flowv-drawer-mask flowv-sheet-mask' + (open ? ' is-open' : ' is-closing') + (isTop ? ' is-top' : ' is-under'), onClick: isTop ? close : undefined },
            h('div', { className: 'flowv-drawer flowv-sheet' + (open ? ' is-open' : ' is-closing'), onClick: function (e) { e.stopPropagation() } },
              headEl,
              leadEl,
              h(DrawerJump, { key: 'jump-' + task.id }),
              h('div', { className: 'flowv-drawer-body' },
                h('div', null,
                  titleInput,
                  h('div', { className: 'flowv-hint', style: { margin: '4px 0 10px' } },
                    task.id + ' · 建于 ' + dayTime(task.createdAt) + ' · 更新 ' + dayTime(task.updatedAt) +
                    (task.assignee ? ' · 负责人 ' + agentName(task.assignee) : '') +
                    (task.origin === 'auto' ? ' · 由远程 issue 建立' : '')),


                  // v1.39：工作包工单（子卡顶部）—— 结构化八问分栏，标出来源
                  (function () {
                    var tk = task.ticket
                    if (!tk) return null
                    var SRC = { auto: '自动', grill: '评审', human: '人补' }
                    var src = tk.sources || {}
                    var srcOf = function (k) { return SRC[src[k]] || '自动' }
                    var seg = function (k, label, body, mono) {
                      return h('div', { className: 'flowv-tk-row' + (src[k] === 'human' || src[k] === 'grill' ? ' is-flagged' : '') },
                        h('span', { className: 'flowv-tk-k' }, label),
                        h('div', { className: 'flowv-tk-v' + (mono ? ' flowv-mono' : '') }, body || '—'),
                        h('span', { className: 'flowv-tk-src', title: '这一栏是谁补的' }, srcOf(k)))
                    }
                    var scopePaths = (tk.scope && tk.scope.paths) || []
                    var scopeSymbols = (tk.scope && tk.scope.symbols) || []
                    return h(Card, { fold: cardFold('ticket', '八问 + 依赖', false), title: '工作包', extra: task.parentId ? h(Btn, { small: true, onClick: function (e) { if (e) e.stopPropagation(); openDrawer(task.parentId) } }, '父卡 ' + task.parentId) : null },
                      seg('purpose', '① 修改目的', tk.purpose),
                      seg('current', '② 现状', tk.current),
                      h('div', { className: 'flowv-tk-row' },
                        h('span', { className: 'flowv-tk-k' }, '③ 修改范围'),
                        h('div', { className: 'flowv-tk-v' },
                          scopePaths.length ? h('div', { className: 'flowv-tk-chips' }, scopePaths.map(function (p, i) { return h('code', { key: 'sp' + i }, p) })) : null,
                          scopeSymbols.length ? h('div', { className: 'flowv-tk-chips' }, scopeSymbols.map(function (p, i) { return h('code', { key: 'ss' + i }, p) })) : null,
                          !scopePaths.length && !scopeSymbols.length ? '—' : null),
                        h('span', { className: 'flowv-tk-src' }, srcOf('scope'))),
                      seg('outOfScope', '④ 不改什么', tk.outOfScope),
                      seg('effect', '⑤ 生效域', tk.effect),
                      h('div', { className: 'flowv-tk-row' },
                        h('span', { className: 'flowv-tk-k' }, '⑥ 验收范围'),
                        h('div', { className: 'flowv-tk-v' },
                          (tk.acceptance || []).length
                            ? h('ol', { className: 'flowv-tk-acc' }, tk.acceptance.map(function (a, i) { return h('li', { key: 'a' + i }, a) }))
                            : '—',
                          tk.testCmd ? h('div', { className: 'flowv-hint' }, '测试命令：' + tk.testCmd) : null),
                        h('span', { className: 'flowv-tk-src' }, srcOf('acceptance'))),
                      (tk.risk || tk.rollback) ? seg('risk', '⑦ 风险与回滚', (tk.risk ? '风险：' + tk.risk : '') + (tk.rollback ? '　回滚：' + tk.rollback : '')) : null,
                      h('div', { className: 'flowv-tk-row' },
                        h('span', { className: 'flowv-tk-k' }, '⑧ 依赖'),
                        h('div', { className: 'flowv-tk-v' },
                          (task.dependsOn || []).length
                            ? h('div', { className: 'flowv-tk-chips' }, (task.dependsOn || []).map(function (id) {
                              var dep = ((d && d.children) || []).filter(function (c) { return c.id === id })[0]
                              return h('button', { key: 'dep' + id, type: 'button', className: 'flowv-tk-dep', onClick: function (e) { if (e) e.stopPropagation(); openDrawer(id) } },
                                id + (dep ? ' · ' + (COLUMN_TITLES[dep.column] || dep.column) : ' · 已归档'))
                            }))
                            : '无（可立即派工）'),
                        h('span', { className: 'flowv-tk-src' }, srcOf('dependsOn'))))
                  })(),

                  // v1.39：子任务列表（父卡顶部）—— 点一行再压一层，看子卡详情
                  (function () {
                    var kids = (d && d.children) || []
                    if (!kids.length) return null
                    var done = kids.filter(function (k) { return k.column === 'done' || k.column === 'cancelled' }).length
                    return h(Card, { fold: cardFold('children', done + '/' + kids.length + ' 已完成', false), title: '子任务', extra: h('span', { className: 'n' }, done + '/' + kids.length) },
                      h('div', { className: 'flowv-kids' }, kids.map(function (k) {
                        return h('button', {
                          key: 'kid-' + k.id, type: 'button', className: 'flowv-kid' + (k.blocked ? ' is-blocked' : ''),
                          onClick: function (e) { if (e) e.stopPropagation(); openDrawer(k.id) },
                        },
                          h('span', { className: 'flowv-kid-id flowv-mono' }, k.id),
                          h('span', { className: 'flowv-kid-title' }, k.title),
                          h('span', { className: 'flowv-kid-col' }, COLUMN_TITLES[k.column] || k.column),
                          k.assignee ? h('span', { className: 'flowv-kid-who' }, agentName(k.assignee)) : null,
                          (k.dependsOn || []).length ? h('span', { className: 'flowv-kid-dep', title: '依赖：' + k.dependsOn.join('、') }, '依赖 ' + k.dependsOn.length) : null,
                          k.risk && k.risk.level === 'high' ? h(Chip, { tone: 'bad' }, '高风险') : null,
                          h('span', { className: 'flowv-kid-chev' }, '›'))
                      })),
                      h('div', { className: 'flowv-hint' }, '子卡各自有自己的 run / worktree / 验收；全部完成后父卡自动进待验收。'))
                  })(),

                  // v1.39：需求评审状态
                  (function () {
                    var g = task.grill
                    if (!g || (!g.rounds && !g.verdict)) return null
                    var GL = { idle: '未开始', running: '评审中', settled: '已定稿', escalate: '待人决定' }
                    var GT = { idle: '', running: 'info', settled: 'ok', escalate: 'warn' }
                    return h(Card, { fold: cardFold('grill', '第 ' + g.rounds + '/' + g.maxRounds + ' 轮 · ' + (GL[g.status] || g.status), false), title: '需求评审', extra: h(Chip, { tone: GT[g.status] || 'info' }, GL[g.status] || g.status) },
                      h('div', { className: 'flowv-hint' }, '第 ' + g.rounds + '/' + g.maxRounds + ' 轮'),
                      (g.settled || []).length ? h('ul', { className: 'flowv-prog-list' }, g.settled.map(function (x, i) { return h('li', { key: 'st' + i }, x) })) : null,
                      (g.openForHuman || []).length
                        ? h('div', null,
                          h('div', { className: 'flowv-hint' }, '需要人决定（已写进 Inbox）：'),
                          h('ul', { className: 'flowv-prog-list' }, g.openForHuman.map(function (x, i) { return h('li', { key: 'of' + i }, x.question) })))
                        : null)
                  })(),

                  // v1.37：当前进展（结构化 progress，替代检查点评论）
                  (function () {
                    var pg = task.progress
                    var ST_LABEL = { 'on-track': '进行中', waiting: '等待中', blocked: '已阻塞', partial: '部分完成', done: '本轮完成' }
                    var ST_TONE = { 'on-track': 'ok', waiting: 'warn', blocked: 'bad', partial: 'warn', done: 'ok' }
                    if (!pg) return h(Card, { title: '当前进展', extra: h('span', { className: 'n' }, '—') },
                      h('div', { className: 'flowv-sec-empty' }, '还没有进度记录。工人和调度用 flow_task_progress 写进度。'))
                    var ev = (pg.evidence || [])
                    return h(Card, {
                      title: '当前进展',
                      extra: h(Chip, { tone: ST_TONE[pg.state] || 'info' }, ST_LABEL[pg.state] || pg.state),
                    },
                      h('div', { className: 'flowv-prog-sum' }, pg.summary || '—'),
                      pg.blocker ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', marginBottom: '8px' } }, '阻塞：' + pg.blocker) : null,
                      (pg.done || []).length ? h('ul', { className: 'flowv-prog-list' },
                        (pg.done || []).map(function (x, i) { return h('li', { key: 'dn' + i }, x) })) : null,
                      pg.next ? h('div', { className: 'flowv-prog-next' }, '下一步：' + pg.next) : null,
                      ev.length ? h('div', { className: 'flowv-prog-meta' },
                        ev.map(function (e, i) { return h(Chip, { key: 'ev' + i }, e.kind + ': ' + e.ref) })) : null,
                      h('div', { className: 'flowv-hint', style: { marginTop: '6px' } }, '更新于 ' + dayTime(pg.updatedAt) + (pg.by ? ' · ' + pg.by : '')))
                  })(),

                  h(NoteCard, {
                    key: 'note-' + task.id + '-' + task.version,
                    title: '描述',
                    value: task.note || '',
                    inputId: 'flowv-note-' + task.id,
                    placeholder: '写背景、目标、约束。支持 Markdown，可以只写一句，之后再补。',
                    hint: '描述是工人读到的第一份材料',
                    onSave: function () {
                      var box = document.getElementById('flowv-note-' + task.id)
                      act('task.update', { taskId: task.id, patch: { note: box ? box.value : (task.note || '') } })
                        .then(function () { reloadDrawer(task.id) })
                    },
                  }),

                  h(Card, {
                    fold: cardFold('acceptance', (task.acceptance || []).length + ' 条 · ' + (task.acceptance && task.acceptance.reported ? '已逐项核对' : '待核对'),
                      task.column === 'verifying' || task.column === 'merging' || task.column === 'done'),
                    title: '验收标准',
                    extra: h('span', { className: 'n' }, String((task.acceptance || []).length)),
                  },
                  (task.acceptance || []).length
                    ? h('ul', { className: 'flowv-accept' }, (task.acceptance || []).map(function (a, i) {
                      // v1.37：逐项验收状态（来自 stopReport.acceptanceStatus）
                      var st = (task.stopReport && Array.isArray(task.stopReport.acceptanceStatus))
                        ? task.stopReport.acceptanceStatus.filter(function (x) { return x && x.index === i })[0] : null
                      var ACC_LABEL = { pass: '✓ 通过', partial: '~ 部分', 'not-run': '· 未验', fail: '✗ 失败' }
                      var ACC_CLASS = { pass: 'ok', partial: 'warn', 'not-run': '', fail: 'bad' }
                      return h('li', { key: 'acc' + i, style: { alignItems: 'baseline', gap: '6px' } },
                        h('span', null, (i + 1) + '. ' + a),
                        st ? h(Chip, { tone: ACC_CLASS[st.status] || 'info', title: st.evidence || '' }, ACC_LABEL[st.status] || st.status) : null,
                        h(Btn, {
                          small: true, onClick: function () {
                            var next = (task.acceptance || []).filter(function (_, j) { return j !== i })
                            act('task.update', { taskId: task.id, patch: { acceptance: next } }).then(function () { reloadDrawer(task.id) })
                          },
                        }, '✕'))
                    }))
                    : h('div', { className: 'flowv-sec-empty' }, '还没有验收标准'),
                  h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
                    h('input', {
                      className: 'flowv-input',
                      placeholder: '加一条可复现的验收点',
                      onKeyDown: function (e) {
                        if (e.key !== 'Enter') return
                        var val = e.target.value.trim()
                        if (!val) return
                        var next = (task.acceptance || []).concat([val])
                        e.target.value = ''
                        act('task.update', { taskId: task.id, patch: { acceptance: next } }).then(function () { reloadDrawer(task.id) })
                      },
                    }))),

                  h(Card, {
                    fold: cardFold('plan', task.plan && task.plan.revision ? 'r' + task.plan.revision : '还没写', false),
                    title: '计划',
                    extra: task.plan && task.plan.revision ? h('span', { className: 'n' }, 'r' + task.plan.revision + (task.plan.approvedRevision ? ' ✓' : '')) : null,
                  },
                  (task.plan && task.plan.text)
                    ? md(task.plan.text)
                    : h('div', { className: 'flowv-sec-empty' }, '调度员还没写计划')),

                  h(Card, {
                    title: '讨论',
                    extra: h('span', { className: 'n' }, String((d.comments || []).length)),
                  },
                  (d.comments || []).length
                    ? h(CommentList, { taskId: task.id }, (d.comments || []).map(commentEl))
                    : h('div', { className: 'flowv-sec-empty' }, '还没有评论。调度员和工人在会话里评论时也会出现在这里。'),
                  h('div', { style: { marginTop: 10 } },
                    h('textarea', { className: 'flowv-textarea', rows: 3, placeholder: '写评论…（Ctrl+Enter 发送）', id: 'flowv-cmt-' + task.id }),
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                      h(Btn, {
                        small: true, variant: 'primary',
                        onClick: function () {
                          var box = document.getElementById('flowv-cmt-' + task.id)
                          var val = box && box.value.trim()
                          if (!val) return
                          act('task.comment', { taskId: task.id, content: val }).then(function () {
                            if (box) box.value = ''
                            reloadDrawer(task.id)
                          })
                        },
                      }, '发表评论')))),
                ),

                h('aside', null,
                  // 代理挂着重开请求时，顶栏必须显眼：这是唯一需要人立刻做决定的地方
                  task.reopenRequested ? h('div', { className: 'flowv-request' },
                    h('b', null, '有代理申请重开这张卡'),
                    md(task.reopenRequested.reason, 'flowv-request-why'),
                    h('div', { className: 'flowv-request-by' }, '提出人：' + (task.reopenRequested.by || 'agent') +
                      (task.reopenRequested.at ? ' · ' + String(task.reopenRequested.at).replace('T', ' ').slice(0, 16) : '')),
                    h('div', { style: { marginTop: 8 } },
                      h(Btn, {
                        small: true, variant: 'primary',
                        onClick: function () { return taskAction(task, 'reopen') },
                      }, '确认重开（回到待办）'),
                    ),
                  ) : null,

                  h(Card, { fold: cardFold('status', colLabel + (task.phase ? ' · ' + task.phase : ''), false), title: '状态' },
                    kv([
                      ['列', COLUMN_TITLES[task.column] || task.column],
                      ['阶段', task.phase || '—'],
                      ['版本', 'v' + (task.version || 0)],
                      ['优先级', task.priority || 'medium'],
                      ['车道', task.lane === 'issue' ? 'issue 自动' : '人直派'],
                      ['负责人', task.assignee ? agentName(task.assignee) : '—'],
                      ['计划', 'rev ' + ((task.plan && task.plan.revision) || 0) + (((task.plan && task.plan.approvedRevision) ? ' · 已批 rev ' + task.plan.approvedRevision : ''))],
                      d.worktree ? ['worktree', h('span', { className: 'flowv-mono' }, d.worktree.branch || d.worktree.path)] : null,
                      task.headSha ? ['head', h('span', { className: 'flowv-mono' }, shortSha(task.headSha))] : null,
                      d.pullRequest ? ['PR', (d.pullRequest.status || '') + ' · ' + (d.pullRequest.branch || '')] : null,
                      task.blocked ? ['阻塞', h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, task.blocked.reason || '—')] : null,
                      mergeKvRow(task),
                      deliveryKvRow(task),
                      rollupKvRow(task),
                      task.reopenRequested ? ['重开请求', (task.reopenRequested.by || 'agent') + '：' + (task.reopenRequested.reason || '')] : null,
                      task.inspection ? ['巡检', (task.inspection.verdict || '') + ((task.inspection.reasons || []).length ? ' · ' + (task.inspection.reasons || []).join('；') : '')] : null,
                      ['发起对话', task.originSessionId ? h('span', { className: 'flowv-mono' }, String(task.originSessionId).slice(0, 18)) : '—（非对话发起）'],
                    ])),

                  h(Card, { title: '操作' },
                    h('div', { className: 'flowv-actions' }, actionsFor(task))),

                  // 回退：把卡退回更早的列。人的界面在这里，调度的入口是 flow_task_move(action="rewind")。
                  // 不是为了绕过守卫，而是「这一步走早了」需要一个不带惩罚的退路 ——
                  // 原来只能 取消 + 重开，重开计数会涨，看着像这张卡反复失败。
                  rewindTargetsFor(task).length
                    ? h(Card, { fold: cardFold('rewind', '退回更早的列（会清停止报告）', false), title: '回退（退回更早的列）' },
                      h('div', { className: 'flowv-hint', style: { marginBottom: 6 } },
                        task.activeRunId
                          ? '这张卡还有运行中的 run（' + String(task.activeRunId).slice(0, 12) + '），先让它停下来再回退'
                          : '回退会清掉上一轮的停止报告与阻塞标记，并把原因写进历史。当前在 ' + (COLUMN_TITLES[task.column] || task.column) + '，只能往更早的列退。'),
                      h('div', { style: { display: 'grid', gap: 6 } },
                        h('select', {
                          id: 'flowv-rewind-to-' + task.id,
                          className: 'flowv-select',
                          defaultValue: rewindTargetsFor(task)[rewindTargetsFor(task).length - 1],
                          disabled: !!task.activeRunId,
                        }, rewindTargetsFor(task).map(function (c) {
                          return h('option', { key: c, value: c }, COLUMN_TITLES[c] || c)
                        })),
                        h('textarea', {
                          id: 'flowv-rewind-why-' + task.id,
                          className: 'flowv-textarea',
                          rows: 2,
                          placeholder: '为什么退回这一步（写进审计历史，必填）',
                          disabled: !!task.activeRunId,
                        }),
                        h(Btn, {
                          small: true,
                          disabled: !!task.activeRunId,
                          onClick: function () {
                            var sel = document.getElementById('flowv-rewind-to-' + task.id)
                            var why = document.getElementById('flowv-rewind-why-' + task.id)
                            var to = sel && sel.value
                            var reason = why && why.value.trim()
                            if (!to) return null
                            if (!reason) { setNotice('回退必须填写原因（会写进历史）'); return null }
                            return rewound(task, to, reason)
                          },
                        }, '↩ 回退到所选列')))
                    : null,

                  h(Card, { fold: cardFold('reply', '把结论回给发起这张卡的对话', false), title: '回信给发起对话' },
                    h('div', { className: 'flowv-hint', style: { marginBottom: 6 } },
                      task.originSessionId
                        ? '这条消息会直接投回发起这张卡的那个对话（' + String(task.originSessionId).slice(0, 14) + '）'
                        : '这张卡不是从对话发起的，没有收件人'),
                    h('textarea', {
                      className: 'flowv-textarea', rows: 2,
                      placeholder: '给发起对话回一条…',
                      defaultValue: '',
                      key: 'reply-' + task.id + '-' + task.version,
                      disabled: !task.originSessionId,
                      id: 'flowv-reply-' + task.id,
                    }),
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                      h(Btn, {
                        small: true, variant: 'primary', disabled: !task.originSessionId,
                        onClick: function () {
                          var box = document.getElementById('flowv-reply-' + task.id)
                          var val = box && box.value.trim()
                          if (!val) return
                          act('task.reply', { taskId: task.id, message: val }).then(function () {
                            if (box) box.value = ''
                            reloadDrawer(task.id)
                          })
                        },
                      }, '发送回信'))),

                  task.stopReport
                    ? h(Card, { fold: cardFold('stopReport', '工人这一轮自述', false), title: '停止报告' }, md(task.stopReport.summary))
                    : null,

                  (d.runs || []).length
                    ? h(Card, { fold: cardFold('runs', '逐轮运行记录', false), title: '运行记录' },
                      h('ul', { className: 'flowv-list' }, (d.runs || []).map(function (r) {
                        return h('li', { key: r.id },
                          h('time', null, dayTime(r.startedAt)),
                          h('span', null, (r.status || '') + ' · ' + agentName(r.agentId) + (r.stopReason ? ' · ' + r.stopReason : '')))
                      })))
                    : null,
                ))))
        }

        /**
         * 栈渲染器：只渲染最上面两层（再往下看不见，渲染纯浪费）。
         * 下层压暗且不吃事件 —— 点它等于点遮罩（退出当前层）。
         */
        var renderDrawer = function () {
          if (!drawerPresence.mounted || !sheets.length) return null
          var visible = sheets.slice(-2)
          var baseDepth = sheets.length - visible.length
          return h('div', { className: 'flowv-sheet-stack', key: 'sheet-stack' },
            visible.map(function (layer, i) {
              var depth = baseDepth + i
              var isTop = depth === sheets.length - 1
              return h('div', {
                key: 'sheet-' + layer.taskId + '-' + depth,
                className: 'flowv-sheet-layer' + (isTop ? ' is-top' : ' is-under'),
                style: { zIndex: 220 + depth },
              }, renderSheet(layer, depth, isTop))
            }))
        }

        // ---- 渲染：弹窗 -------------------------------------------------------
        var renderNewTask = function () {
          var set = function (k, v) { setDraft(function (d) { var n = Object.assign({}, d); n[k] = v; return n }) }
          var submit = function () {
            var title = String(draft.title || '').trim()
            if (!title) { setNotice('新建任务需要标题'); return }
            var acceptance = String(draft.acceptance || '').split('\n').map(function (x) { return x.trim() }).filter(Boolean)
            act('task.create', {
              projectId: project.id,
              title: title,
              note: draft.note || '',
              acceptance: acceptance,
              priority: draft.priority || 'medium',
              lane: draft.lane === 'issue' ? 'issue' : 'human',
              // 记住"这张卡是哪个对话建的"：子调度/工人的回信会投回这里
              originSessionId: sessionId || null,
            }).then(function (res) {
              if (res && res.id) {
                setModal(null)
                setDraft({})
                openDrawer(res.id)
              }
            })
          }
          return h(Modal, {
            open: modal === 'new-task',
            title: '新建任务',
            onClose: function () { setModal(null) },
            footer: [
              h(Btn, { key: 'cancel', onClick: function () { setModal(null) } }, '取消'),
              h(Btn, { key: 'ok', variant: 'primary', disabled: !!busy, onClick: submit }, busy ? '创建中…' : '创建'),
            ],
          },
          h('div', { className: 'flowv-field' },
            h('label', { htmlFor: 'flowv-nt-title' }, '标题'),
            h('input', {
              id: 'flowv-nt-title', className: 'flowv-input', autoFocus: true, defaultValue: draft.title || '',
              placeholder: '一句话说清要做什么',
              onInput: function (e) { set('title', e.target.value) },
            })),
          h('div', { className: 'flowv-grid2' },
            h('div', { className: 'flowv-field' },
              h('label', { htmlFor: 'flowv-nt-lane' }, '车道'),
              h('select', {
                id: 'flowv-nt-lane', className: 'flowv-select', defaultValue: draft.lane || 'human',
                onChange: function (e) { set('lane', e.target.value) },
              },
              h('option', { value: 'human' }, '人直派（人类建单）'),
              h('option', { value: 'issue' }, 'issue 自动（外部事件驱动）'))),
            h('div', { className: 'flowv-field' },
              h('label', { htmlFor: 'flowv-nt-priority' }, '优先级'),
              h('select', {
                id: 'flowv-nt-priority', className: 'flowv-select', defaultValue: draft.priority || 'medium',
                onChange: function (e) { set('priority', e.target.value) },
              },
              h('option', { value: 'high' }, '高'),
              h('option', { value: 'medium' }, '中'),
              h('option', { value: 'low' }, '低')))),
          h('div', { className: 'flowv-field' },
            h('label', { htmlFor: 'flowv-nt-note' }, '描述'),
            h('textarea', {
              id: 'flowv-nt-note', className: 'flowv-textarea', rows: 5, defaultValue: draft.note || '',
              placeholder: '背景、目标、约束',
              onInput: function (e) { set('note', e.target.value) },
            })),
          h('div', { className: 'flowv-field' },
            h('label', { htmlFor: 'flowv-nt-accept' }, '验收标准（一行一条）'),
            h('textarea', {
              id: 'flowv-nt-accept', className: 'flowv-textarea', rows: 3, defaultValue: draft.acceptance || '',
              placeholder: '每条一个可复现的验收点',
              onInput: function (e) { set('acceptance', e.target.value) },
            }),
            h('div', { className: 'flowv-hint' }, '验收标准是工人停止报告要对照的清单')))
        }

        var renderNewProject = function () {
          var submit = function () {
            var path = String(draft.path || '').trim()
            if (!path) { setNotice('需要工作区路径'); return }
            act('project.ensure', { workspacePath: path, name: String(draft.name || '').trim() || undefined })
              .then(function () { setModal(null); load() })
          }
          return h(Modal, {
            open: modal === 'new-project',
            title: '把工作区建成项目',
            onClose: function () { setModal(null) },
            footer: [
              h(Btn, { key: 'cancel', onClick: function () { setModal(null) } }, '取消'),
              h(Btn, { key: 'ok', variant: 'primary', disabled: !!busy, onClick: submit }, busy ? '创建中…' : '创建项目'),
            ],
          },
          h('div', { className: 'flowv-field' },
            h('label', { htmlFor: 'flowv-np-path' }, '工作区路径'),
            h('input', {
              id: 'flowv-np-path', className: 'flowv-input', autoFocus: true, defaultValue: draft.path || '',
              placeholder: 'C:/Users/you/projects/my-repo',
              onInput: function (e) { setDraft(function (d) { var n = Object.assign({}, d); n.path = e.target.value; return n }) },
            }),
            h('div', { className: 'flowv-hint' }, '必须是已存在的目录；落在 .flow-worktrees 下的路径会被拒绝')),
          h('div', { className: 'flowv-field' },
            h('label', { htmlFor: 'flowv-np-name' }, '项目名（可选）'),
            h('input', {
              id: 'flowv-np-name', className: 'flowv-input', defaultValue: draft.name || '',
              placeholder: '默认取目录名',
              onInput: function (e) { setDraft(function (d) { var n = Object.assign({}, d); n.name = e.target.value; return n }) },
            })))
        }

        var renderSettings = function () {
          var cfg = (project && project.config) || {}
          var setCfg = function (patch) { return act('project.config', { projectId: project.id, patch: patch }) }
          var setAgent = function (agent, patch) {
            return act('agent.upsert', Object.assign({ projectId: project.id, id: agent.id }, patch))
          }
          /**
           * 设置面板里的一行提示（不弹窗）。
           * 用途：模型已落库但会话没切成功时得让人知道，否则又变成"以为改了"。
           */
          var settingsNotice = function (text) {
            if (!text) return
            setSettings(function (prev) { return Object.assign({}, prev, { notice: String(text) }) })
          }
          // v1.4：危险操作先不展示（删除工作区在 DSH 侧做，项目跟着工作区走）
          var tabs = [['general', '通用'], ['project', '项目配置'], ['remote', '远程仓库'], ['lanes', '车道与工位'], ['agents', '代理与模型'], ['prompts', '提示词']]
          var body = null
          var recordIssues = !!(cfg && cfg.recordIssues)
          var noticeEl = settings.notice
            ? h('div', { className: 'flowv-hint', style: { color: 'var(--bad, #c00)', marginBottom: 8 } }, settings.notice)
            : null
          if (settings.tab === 'general') {
            // v1.37：全局默认模型 —— 工位没单独配时不跟随"当前对话选了什么"。
            // 会话重建（resetSession）后也会切到这个模型，不会再被别的对话改掉。
            var gs = settings.global || {}
            var gOpts = modelOptions(settings.catalog)
            var gCur = gs.defaultProvider && gs.defaultModel ? gs.defaultProvider + '/' + gs.defaultModel : ''
            var gKnown = gOpts.some(function (o) { return o.key === gCur })
            var saveGlobal = function (patch) {
              act('settings.set', patch).then(function (r) {
                var res = r && (r.result || r)
                if (!res || res.ok === false) { settingsNotice('保存失败：' + ((res && res.message) || '未知原因')); return }
                setSettings(function (s) { return Object.assign({}, s, { global: res.settings || {} }) })
              })
            }
            body = h('div', null,
              h('div', { className: 'flowv-field' },
                h('label', null, '调度默认模型'),
                h('select', {
                  className: 'flowv-select',
                  defaultValue: gKnown ? gCur : '',
                  onChange: function (e) {
                    var val = String(e.target.value || '')
                    if (!val) { saveGlobal({ defaultProvider: '', defaultModel: '' }); return }
                    var parts = val.split('/')
                    saveGlobal({ defaultProvider: parts[0], defaultModel: parts.slice(1).join('/') })
                  },
                },
                h('option', { value: '' }, gCur && !gKnown ? '当前：' + gCur : '（未设置 —— 跟 DSH 当前选择）'),
                gKnown ? null : (gCur ? h('option', { value: gCur }, gCur) : null),
                gOpts.map(function (o) { return h('option', { key: o.key, value: o.key }, o.label) }))),
              h('div', { className: 'flowv-field' },
                h('label', null, '思考强度'),
                h('select', {
                  className: 'flowv-select',
                  defaultValue: gs.defaultReasoningEffort || '',
                  onChange: function (e) { saveGlobal({ defaultReasoningEffort: e.target.value || '' }) },
                },
                h('option', { value: '' }, '（默认）'),
                h('option', { value: 'low' }, 'low'),
                h('option', { value: 'medium' }, 'medium'),
                h('option', { value: 'high' }, 'high'))),
              h('div', { className: 'flowv-hint', style: { marginTop: 6 } },
                '生效顺序：工位单独配的模型 → 项目默认模型 → 这里的全局默认 → DSH 当前选择。'),
              h('div', { className: 'flowv-hint' },
                gCur ? '当前：工人/子调度新建或重建会话都会切到这个模型，不受你在别的对话里换模型影响。'
                     : '⚠ 没设置时，工位会话会跟随 DSH 的全局选择 —— 你在任意对话里换模型，重建出的会话也会跟着变。建议在这里固定下来。'))
              // v0.007：调度员自己那轮被 503 这类环境错误打断时，自动给同一个会话续一条消息。
              // 这一项是人能看见「它还在自己试」的唯一凭据 —— 所以放在全局设置里，不藏在某张卡下面。
              h('div', { className: 'flowv-field' },
                h('label', null, '调度员失败后自动续跑'),
                h('select', {
                  className: 'flowv-select',
                  defaultValue: gs.dispatcherAutoResume === false ? '0' : (gs.dispatcherAutoResume === true ? '1' : ''),
                  onChange: function (e) {
                    var v = String(e.target.value || '')
                    if (!v) return
                    saveGlobal({ dispatcherAutoResume: v === '1' })
                  },
                },
                h('option', { value: '' }, '（默认：开启）'),
                h('option', { value: '1' }, '开启'),
                h('option', { value: '0' }, '关闭'))),
              h('div', { className: 'flowv-field' },
                h('label', null, '连续续跑上限'),
                h('input', {
                  className: 'flowv-input',
                  type: 'number', min: 1, max: 10,
                  defaultValue: String(gs.dispatcherAutoResumeMax || 5),
                  onChange: function (e) {
                    var n = Number(e.target.value)
                    if (!Number.isFinite(n) || n < 1) return
                    saveGlobal({ dispatcherAutoResumeMax: Math.min(10, Math.floor(n)) })
                  },
                })),
              h('div', { className: 'flowv-hint' },
                '调度员（子调度/主调度）自己那一轮报错时，系统会给同一个会话再发一条续跑消息，从断点接着做。人点停止生成不算失败、不续跑；连续失败到上限就停下来，并往收件箱发一条「系统错误」通知等你处理。')
          }
          if (settings.tab === 'project') {
            var skillList = settings.skills || []
            var allSkills = cfg.allowedSkills == null
            var allowedSkills = Array.isArray(cfg.allowedSkills) ? cfg.allowedSkills : []
            var skillNames = skillList.map(function (s) { return s.name })
            // 保留暂时不在目录里的已配置技能，避免编辑白名单时静默丢失。
            var selectableSkills = skillList.concat(allowedSkills.filter(function (name) { return skillNames.indexOf(name) < 0 }).map(function (name) { return { name: name, description: '当前目录不可用（已配置）' } }))
            var grillSkill = cfg.grillSkill || 'grilling'
            var grillNames = skillNames.indexOf(grillSkill) < 0 ? [grillSkill].concat(skillNames) : skillNames
            body = h('div', null,
              h('h6', null, '共享技能暴露范围'),
              h('div', { className: 'flowv-field' },
                h('label', { htmlFor: 'flowv-skills-mode' }, '工位可用技能'),
                h('select', { id: 'flowv-skills-mode', className: 'flowv-select', value: allSkills ? 'all' : 'selected',
                  onChange: function (e) { setCfg({ allowedSkills: e.target.value === 'all' ? null : [] }) },
                }, h('option', { value: 'all' }, '全部技能（含以后新增的技能）'), h('option', { value: 'selected' }, '仅选中的技能向 AI 暴露（不选 = 一个都不暴露）'))),
              h('div', { className: 'flowv-hint' }, 'human / issue 两条车道共享此暴露范围；只影响哪些技能出现在 AI 的可选清单里，显式投递不受限制。'),
              settings.skills == null ? h('div', { className: 'flowv-hint', role: 'status' }, '正在加载技能目录…') : null,
              settings.skillsError ? h('div', { className: 'flowv-hint', role: 'alert' }, settings.skillsError) : null,
              selectableSkills.map(function (skill) {
                return h('div', { className: 'flowv-field', key: skill.name },
                  h('label', null, h('input', { type: 'checkbox', checked: allSkills || allowedSkills.indexOf(skill.name) >= 0,
                    onChange: function (e) {
                      var next = (allSkills ? selectableSkills.map(function (s) { return s.name }) : allowedSkills).filter(function (name) { return name !== skill.name })
                      if (e.target.checked) next.push(skill.name)
                      setCfg({ allowedSkills: next })
                    },
                  }), ' ', skill.name),
                  skill.description ? h('div', { className: 'flowv-hint' }, skill.description) : null)
              }),
              settings.skills && !selectableSkills.length && !settings.skillsError ? h('div', { className: 'flowv-hint' }, '没有可用技能') : null,
              h('h6', null, '需求讨论工位'),
              h(Btn, { small: true, onClick: function () { setSettings(function (s) { return Object.assign({}, s, { tab: 'agents' }) }) } }, '配置需求讨论模型（griller）'),
              !agents.some(function (a) { return a.role === 'griller' }) ? h('div', { className: 'flowv-field' },
                h('div', { className: 'flowv-hint' }, '尚未创建需求讨论工位，初始化后即可配置模型。'),
                h(Btn, { small: true, onClick: function () { act('agents.ensure', { projectId: project.id }).then(function () { setSettings(function (s) { return Object.assign({}, s, { tab: 'agents' }) }) }) } }, '创建需求讨论工位')) : null,
              h('div', { className: 'flowv-hint' }, '需求讨论是独立工位，由 human / issue 两条车道共享。模型在「代理与模型」中配置。'),
              h('div', { className: 'flowv-grid2' },
                h('div', { className: 'flowv-field' },
                  h('label', { htmlFor: 'flowv-grill-skill' }, '讨论技能'),
                  h('select', { id: 'flowv-grill-skill', className: 'flowv-select', value: grillSkill,
                    onChange: function (e) { setCfg({ grillSkill: e.target.value }) },
                  }, grillNames.map(function (name) { return h('option', { key: name, value: name }, name) }))),
                h('div', { className: 'flowv-field' },
                  h('label', { htmlFor: 'flowv-grill-rounds' }, '讨论轮数上限'),
                  h('input', { id: 'flowv-grill-rounds', className: 'flowv-input', type: 'number', min: 1, max: 20, step: 1,
                    key: String(cfg.grillMaxRounds), defaultValue: cfg.grillMaxRounds == null ? 4 : cfg.grillMaxRounds,
                    onBlur: function (e) {
                      var rounds = Number(e.target.value)
                      if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 20) setCfg({ grillMaxRounds: rounds })
                      else e.target.value = cfg.grillMaxRounds == null ? 4 : cfg.grillMaxRounds
                    },
                  }))),
              h('div', { className: 'flowv-field' },
                h('label', null, '记录 issue（远程工单）'),
                h('select', {
                  className: 'flowv-select', defaultValue: recordIssues ? '1' : '0',
                  onChange: function (e) { setCfg({ recordIssues: e.target.value === '1' }) },
                }, h('option', { value: '0' }, '关闭 —— 纯本地看板，只由人派活'),
                  h('option', { value: '1' }, '开启 —— 接远程 issue，先自动调研再等人批准'))),
              h('div', { className: 'flowv-hint' },
                recordIssues
                  ? '开着：远程 issue 会建卡并自动调研，调研完停在待批准，人点头才开工。'
                  : '关着：纯本地看板模式。任务全靠人/主调度在看板上建，不接远程事件，也没有自动化开关。'),
              recordIssues ? h('div', { className: 'flowv-grid2' },
                h('div', { className: 'flowv-field' },
                  h('label', null, '自动接管远程 issue（autoLane）'),
                  // C-09：这一项成为建卡开关。没设过（null）时显示「跟随补位」——
                  // 那就是升级前的行为，不能悄悄变成关。
                  h('select', {
                    className: 'flowv-select',
                    defaultValue: cfg.autoLane === null || cfg.autoLane === undefined ? 'x' : (cfg.autoLane ? '1' : '0'),
                    onChange: function (e) { setCfg({ autoLane: e.target.value === 'x' ? undefined : e.target.value === '1' }) },
                  }, h('option', { value: 'x' }, '跟随「自动补位派工」'), h('option', { value: '0' }, '关闭（不建卡）'), h('option', { value: '1' }, '开启（建卡并自动派工）'))),
                h('div', { className: 'flowv-field' },
                  h('label', null, '自动补位派工'),
                  h('select', {
                    className: 'flowv-select', defaultValue: cfg.autoDispatch ? '1' : '0',
                    onChange: function (e) { setCfg({ autoDispatch: e.target.value === '1' }) },
                  }, h('option', { value: '0' }, '关闭'), h('option', { value: '1' }, '开启'))),
                h('div', { className: 'flowv-field' },
                  h('label', null, '自动验收'),
                  h('select', {
                    className: 'flowv-select', defaultValue: cfg.autoAccept ? '1' : '0',
                    onChange: function (e) { setCfg({ autoAccept: e.target.value === '1' }) },
                  }, h('option', { value: '0' }, '关闭（人工验收）'), h('option', { value: '1' }, '开启（证据齐全自动过）')))) : null,
              h('div', { className: 'flowv-grid2' },
                h('div', { className: 'flowv-field' },
                  h('label', null, '同项目并行上限'),
                  h('input', {
                    className: 'flowv-input', type: 'number', min: 1, defaultValue: cfg.maxInFlightPerProject || 3,
                    onBlur: function (e) { setCfg({ maxInFlightPerProject: Number(e.target.value) || 1 }) },
                  })),
                h('div', { className: 'flowv-field' },
                  h('label', null, '基础分支（留空 = 自动探测）'),
                  h('input', {
                    className: 'flowv-input', defaultValue: cfg.baseBranch || '', placeholder: '自动探测（origin/HEAD → main → master → 当前分支）',
                    onBlur: function (e) { setCfg({ baseBranch: e.target.value.trim() }) },
                  }))),
              // v0.002（ADR-0004）：集成检出说明。base 默认被它占住 —— 这是本方案唯一
              // 会让人"突然切不回 base"的副作用，必须写在人找得到的地方。
              h('div', { className: 'flowv-field' },
                h('label', null, '集成检出'),
                h('div', { className: 'flowv-hint' },
                  '合并在一个常驻的独立检出里跑（与任务检出同根、目录名 __integ__），它默认把基础分支占住。',
                  h('br'),
                  '所以在它存在期间，主检出里 ', h('code', null, 'git switch ' + (cfg.baseBranch || 'main')), ' 会报 ', h('code', null, 'already used by worktree'),
                  ' —— 想在主检出里看基础分支，先点下面的「释放」。需要合并时会自动重建。'),
                h('div', { className: 'flowv-actions' },
                  h(Btn, {
                    small: true,
                    onClick: function () {
                      act('integration.release', { projectId: project.id }).then(function (r) {
                        if (!r) return
                        setNotice(r.removed ? '集成检出已释放，主检出现在可以切回基础分支' : '当时没有集成检出，无需释放')
                      })
                    },
                  }, '释放集成检出'))),
              recordIssues ? h('div', { className: 'flowv-grid2' },
                h('div', { className: 'flowv-field' },
                  h('label', null, '合并策略'),
                  h('select', {
                    className: 'flowv-select', defaultValue: cfg.mergeStrategy || 'merge',
                    onChange: function (e) { setCfg({ mergeStrategy: e.target.value }) },
                  },
                  h('option', { value: 'merge' }, 'merge commit'),
                  h('option', { value: 'squash' }, 'squash'),
                  h('option', { value: 'rebase' }, 'rebase'))),
                h('div', { className: 'flowv-field' },
                  h('label', null, '自动合并'),
                  h('select', {
                    className: 'flowv-select', defaultValue: cfg.autoMerge ? '1' : '0',
                    onChange: function (e) { setCfg({ autoMerge: e.target.value === '1' }) },
                  }, h('option', { value: '0' }, '关闭（人工点合并）'), h('option', { value: '1' }, '开启（审核通过即合并')))) : null,
              h('div', { className: 'flowv-grid2' },
                ),
              h('div', { className: 'flowv-grid2' },
                h('div', { className: 'flowv-field' },
                  h('label', null, '毒会话自动重建'),
                  h('select', {
                    className: 'flowv-select', defaultValue: cfg.poisonRebuild ? '1' : '0',
                    onChange: function (e) { setCfg({ poisonRebuild: e.target.value === '1' }) },
                  }, h('option', { value: '0' }, '关闭（只提醒，保留会话）'), h('option', { value: '1' }, '开启（达到阈值自动重建）')),
                  h('div', { className: 'flowv-hint' }, '重建会丢上下文，缓存命中率会下降')),
                h('div', { className: 'flowv-field' },
                  h('label', null, '毒会话阈值（连续卡死/超时次数，默认 3）'),
                  h('input', {
                    className: 'flowv-input', type: 'number', step: '1', min: 1, max: 20,
                    defaultValue: cfg.poisonStuckThreshold || 3,
                    onBlur: function (e) { setCfg({ poisonStuckThreshold: Math.max(1, Math.floor(Number(e.target.value)) || 3) }) },
                  }))),
              h('div', { className: 'flowv-grid2' },
                h('div', { className: 'flowv-field' },
                  h('label', null, '调度员重置工人会话'),
                  h('select', {
                    className: 'flowv-select', defaultValue: cfg.workerResetPolicy || 'guarded',
                    onChange: function (e) { setCfg({ workerResetPolicy: e.target.value }) },
                  },
                  h('option', { value: 'guarded' }, '保护（工人近期有活动则拒绝）'),
                  h('option', { value: 'allow' }, '放行（调度员可随时重置）'),
                  h('option', { value: 'deny' }, '禁止（只能人在看板上重置）')),
                  h('div', { className: 'flowv-hint' }, '人在看板上点重置不受此限制')),
                h('div', { className: 'flowv-field' },
                  h('label', null, '静默期（分钟，默认 10）'),
                  h('input', {
                    className: 'flowv-input', type: 'number', step: '1', min: 0, max: 180,
                    defaultValue: Math.round((cfg.workerResetQuietMs == null ? 600000 : cfg.workerResetQuietMs) / 60000),
                    onBlur: function (e) { var m = Number(e.target.value); setCfg({ workerResetQuietMs: (Number.isFinite(m) && m >= 0 ? m : 10) * 60000 }) },
                  }),
                  h('div', { className: 'flowv-hint' }, '保护模式下，工人最近评论或 run 开始后这么久内不允许调度员重置'))),
            )
          } else if (settings.tab === 'remote') {
            body = h(RemotePane, {
              project: project,
              sync: v.sync || null,
              act: act,
              reload: load,
            })
          } else if (settings.tab === 'lanes') {
            var laneList = (cfg && cfg.recordIssues) ? ['human', 'issue'] : ['human']
            var laneRows = laneList.map(function (lane) {
              var info = v.lanes[lane]
              return h('div', { key: lane, style: { marginBottom: 10 } },
                h('div', { style: { fontSize: 12, fontWeight: 500, marginBottom: 4 } }, lane === 'issue' ? 'issue 自动' : '人直派'),
                h('div', { className: 'flowv-grid2' },
                  h('div', { className: 'flowv-field' },
                    h('label', null, '子调度数量'),
                    h('input', {
                      className: 'flowv-input', type: 'number', min: 0, defaultValue: info.dispatchers,
                      onBlur: function (e) { act('lane.set', { projectId: project.id, lane: lane, dispatchers: Number(e.target.value) || 0, workers: info.workers }) },
                    })),
                  h('div', { className: 'flowv-field' },
                    h('label', null, '工人数量'),
                    h('input', {
                      className: 'flowv-input', type: 'number', min: 0, defaultValue: info.workers,
                      onBlur: function (e) { act('lane.set', { projectId: project.id, lane: lane, dispatchers: info.dispatchers, workers: Number(e.target.value) || 0 }) },
                    }))),
                h('div', { className: 'flowv-hint' }, '调大只补工位，调小不删已有工位；issue 车道默认 0，首次来 issue 时自动补齐'))
            })
            body = h('div', null, laneRows)
          } else if (settings.tab === 'prompts') {
            // v1.29：三层提示词的可见与可改。
            // 上层只读（内置，由 lib/prompts.js 维护）；中层项目自定义；下层角色自定义。
            // 为什么要把内置的展示出来：以前它埋在 dispatch.js 里，人根本不知道模型被告知了什么，
            // 于是「为什么它老是自己填 head_sha」这类问题只能靠翻源码回答。
            var bp = v.builtinPrompts || { worker: '', dispatcher: '' }
            var editableAgents = agents.filter(function (a) { return a.role !== 'chief' })
            var pickAgentId = settings.promptAgentId || (editableAgents[0] && editableAgents[0].id) || ''
            var pickedAgent = editableAgents.filter(function (a) { return a.id === pickAgentId })[0] || null
            body = h('div', null,
              h('div', { className: 'flowv-field' },
                h('label', null, '内置默认提示词（只读 · 由插件维护，改配置覆盖不了）'),
                h('div', { className: 'flowv-hint' }, '这是工人和调度每次都会收到的固定规则。要加自己的约束，用下面的「自定义」。'),
                h('details', { className: 'flowv-md' },
                  h('summary', null, '展开看工人规则（' + String(bp.worker || '').length + ' 字符）'),
                  h('pre', { className: 'flowv-plain', style: { whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' } }, bp.worker || '')),
                h('details', { className: 'flowv-md' },
                  h('summary', null, '展开看调度规则（' + String(bp.dispatcher || '').length + ' 字符）'),
                  h('pre', { className: 'flowv-plain', style: { whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' } }, bp.dispatcher || ''))),
              h('div', { className: 'flowv-field' },
                h('label', null, '项目自定义提示词（拼在内置之后，所有工位可见）'),
                h('textarea', {
                  className: 'flowv-input', rows: 5,
                  defaultValue: cfg.promptOverlay || '',
                  placeholder: '例如：本项目禁止改 package.json；测试命令统一用 pnpm -C frontend test',
                  onBlur: function (e) {
                    var text = String(e.target.value || '')
                    if (text === (cfg.promptOverlay || '')) return
                    setCfg({ promptOverlay: text }).then(function (res) {
                      if (res) settingsNotice(res.message || '项目提示词已保存')
                    })
                  },
                })),
              h('div', { className: 'flowv-field' },
                h('label', null, '角色自定义提示词（只影响选中的工位）'),
                editableAgents.length
                  ? h('select', {
                      className: 'flowv-select',
                      value: pickAgentId,
                      onChange: function (e) { setSettings(function (prev) { return Object.assign({}, prev, { promptAgentId: e.target.value }) }) },
                    }, editableAgents.map(function (a) { return h('option', { key: a.id, value: a.id }, (a.label || a.name) + '（' + a.role + '）') }))
                  : h('div', { className: 'flowv-hint' }, '没有可配置的工位'),
                pickedAgent
                  ? h('textarea', {
                      className: 'flowv-input', rows: 4,
                      key: pickedAgent.id,   // 换人时重置受控值
                      defaultValue: pickedAgent.promptOverlay || '',
                      placeholder: '只对这个工位生效的约定，例如：你是审读者，不要直接改代码',
                      onBlur: function (e) {
                        var text = String(e.target.value || '')
                        var original = pickedAgent.promptOverlay || ''
                        if (text === original) return
                        setAgent(pickedAgent, { promptOverlay: text }).then(function (res) {
                          if (res) settingsNotice('已更新 ' + (pickedAgent.label || pickedAgent.name) + ' 的角色提示词')
                        })
                      },
                    })
                  : null,
                h('div', { className: 'flowv-hint' }, '这三层按顺序拼接：内置 → 项目 → 角色。后面可以补充或收紧，但删不掉内置规则。')),
              h('div', { className: 'flowv-hint' }, '保存时机：离开输入框（blur）即保存。保存后下一次派工生效。')
            )
          } else if (settings.tab === 'agents') {
            // 总调度者不进模型配置（它的模型归 DSH 会话设置）
            var rows = agents.filter(function (a) { return a.role !== 'chief' }).sort(function (a, b) { return Number(b.role === 'griller') - Number(a.role === 'griller') }).map(function (a) {
              var sup = a.supervisorId && agents.filter(function (x) { return x.id === a.supervisorId })[0]
              return h('div', { className: 'flowv-agent-row', key: a.id },
                h('span', { className: 'flowv-agent-name' }, a.label || a.name),
                h(Chip, null, a.role),
                h(Chip, null, a.role === 'griller' ? '共享需求讨论' : (a.lane === 'issue' ? 'auto' : 'human')),
                h('span', { className: 'flowv-hint', style: { flex: 1 } },
                  (sup ? '上级 ' + (sup.label || sup.name) + ' · ' : '无上级 · ')
                  + (a.sessionId ? '会话 ' + String(a.sessionId).slice(0, 14) : '无会话')
                  + (a.sessionTitle && a.sessionTitle !== (a.label || a.name) ? ' · 标题 ' + a.sessionTitle : '')),
                (function () {
                  var opts = modelOptions(settings.catalog)
                  var current = a.provider && a.model ? a.provider + '/' + a.model : ''
                  var known = opts.some(function (o) { return o.key === current })
                  if (opts.length) {
                    return h('select', {
                      className: 'flowv-select', style: { width: 200 },
                      defaultValue: known ? current : '',
                      onChange: function (e) {
                        var raw = String(e.target.value || '')
                        if (raw === '__custom') return
                        if (!raw) return
                        var parts = raw.split('/')
                        // 走 selectModel：先落库，再对**已有会话**切换模型。
                        // 之前这里走 agent.upsert，只改数据库不动会话，
                        // 于是界面上模型变了、工人/子调度实际还跑在旧模型上。
                        act('agent.selectModel', {
                          agentId: a.id, provider: parts[0], model: parts.slice(1).join('/') || null,
                        }).then(function (r) {
                          var applied = r && r.applied
                          if (applied && applied.ok === false) {
                            // 已保存但会话没切成功：必须说清楚，否则又变成"以为改了"
                            settingsNotice('模型已保存，但这个工位的会话没切过来：' + (applied.message || '未知原因'))
                          }
                        })
                      },
                    },
                    h('option', { value: '' }, current && !known ? '当前：' + current : defaultModelLabel(settings.catalog)),
                    known ? null : (current ? h('option', { value: current }, current) : null),
                    opts.map(function (o) { return h('option', { key: o.key, value: o.key }, o.label) }),
                    h('option', { value: '__custom' }, '手填…'))
                  }
                  return h('input', {
                    className: 'flowv-input', style: { width: 180 }, placeholder: 'provider/model',
                    defaultValue: current,
                    onBlur: function (e) {
                      var raw = String(e.target.value || '').trim()
                      if (!raw) return
                      var parts = raw.split('/')
                      act('agent.selectModel', {
                        agentId: a.id, provider: parts[0], model: parts.slice(1).join('/') || null,
                      }).then(function (r) {
                        var applied = r && r.applied
                        if (applied && applied.ok === false) {
                          settingsNotice('模型已保存，但这个工位的会话没切过来：' + (applied.message || '未知原因'))
                        }
                      })
                    },
                  })
                })(),
                h(Btn, {
                  small: true, onClick: function () {
                    act('agent.session', { agentId: a.id }).then(function (res) {
                      if (res && res.sessionId) {
                        // 有会话就真的跳过去看一眼——只弹个 id 等于什么也没做
                        if (!gotoSession(res.sessionId)) setNotice((a.label || a.name) + ' 的会话：' + res.sessionId)
                      }
                    })
                  },
                }, '打开会话'),
                h(Btn, {
                  small: true, onClick: function () {
                    if (!window.confirm('重置 ' + a.name + ' 的会话？会归档旧会话并投递案卷摘要。')) return
                    act('agent.reset', { agentId: a.id })
                  },
                }, '重置'),
                h(Btn, {
                  small: true, onClick: function () {
                    var target = window.prompt('改派给哪个上级（agentId，留空=无上级）', a.supervisorId || '')
                    if (target === null) return
                    act('agent.reparent', { agentId: a.id, supervisorId: target.trim() || null })
                  },
                }, '改派'),
              )
            })
            body = h('div', null,
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                h(Btn, {
                  small: true, primary: true, disabled: busy === 'project.init', onClick: function () {
                    // 一次性把项目里该有的工位会话全备齐：缺的建、有的按身份名改名、
                    // 漂在 worktree 里的旧会话收回当前工作区（在跑的不动）。
                    // busy 由 act() 里的 run() 负责设置与清空，这里不要自己动。
                    act('project.init', { projectId: project.id }).then(function (res) {
                      if (!res) return
                      var lines = [res.message || '已初始化']
                      var names = (res.created || []).concat(res.moved || []).map(function (x) { return x.name }).filter(Boolean)
                      if (names.length) lines.push('备好的会话：' + names.join('、'))
                      var bad = (res.failed || [])
                      if (bad.length) lines.push('失败：' + bad.map(function (x) { return (x.name || x.agentId) + '（' + (x.message || '未知原因') + '）' }).join('；'))
                      var renameFail = (res.existing || []).filter(function (x) { return x.renameMessage }).map(function (x) { return x.name + '：' + x.renameMessage })
                      if (renameFail.length) lines.push('改名没成功（会话照常可用）：' + renameFail.join('；'))
                      settingsNotice(lines.join(SEP))
                    })
                  },
                }, busy === 'project.init' ? '初始化中…' : '初始化仓库'),
                h('span', { className: 'flowv-hint', style: { flex: 1 } },
                  '给每个工位备好会话并标上身份名（human调度1 / auto工人2…），可以反复点。'),
                h(Btn, {
                  small: true, onClick: function () { load() },
                }, '刷新')),
              h('div', { className: 'flowv-hint', style: { marginBottom: 6 } },
                '模型填 provider/model（例如 deepseek-official/deepseek-flash）；改派决定「谁能给谁派活」。'),
              rows.length ? rows : h('div', { className: 'flowv-sec-empty' }, '没有代理'))
          } else {
            // v1.4：危险操作先不展示。项目跟随工作区——在 DSH 里删除工作区，项目随之消失。
            body = h('div', { className: 'flowv-sec-empty' }, '这一栏先收起来了。项目跟随工作区：在 DSH 里删除工作区，对应项目会被清理。')
          }
          return h(Modal, {
            open: modal === 'settings',
            title: '调度台设置',
            onClose: function () { setModal(null) },
            footer: [h(Btn, { key: 'close', onClick: function () { setModal(null) } }, '关闭')],
          },
          noticeEl,
          h('div', { className: 'flowv-tabs' }, tabs.map(function (pair) {
            return h('button', {
              type: 'button', key: pair[0],
              className: 'flowv-tab' + (settings.tab === pair[0] ? ' on' : ''),
              onClick: function () { setSettings(function (s) { return Object.assign({}, s, { tab: pair[0] }) }) },
            }, pair[1])
          })),
          body)
        }

        // ---- 渲染：主体 -------------------------------------------------------
        // 四个事务分区：都是日志性质的次要信息，用网格并排，别纵向堆成半屏空白
        var secEls = [
          sec('运行中的 run', v.runs, function (r) {
            return h('li', { key: r.runId },
              h('time', null, hhmm(r.startedAt)),
              // v1.37：心跳不再暴露给界面（它只说明进程活着，不代表有进展）。显示已跑时长更有用。
              h('span', null, r.taskId + ' → ' + agentName(r.agentId) +
                (r.startedAt ? '（已跑 ' + Math.max(0, Math.round((Date.now() - new Date(r.startedAt).getTime()) / 60000)) + ' 分钟）' : '')))
          }, '当前没有在跑的 run'),
          sec('租约', v.leases, function (l) {
            return h('li', { key: l.key },
              h('time', null, l.expiresAt ? hhmm(new Date(l.expiresAt).toISOString()) : ''),
              h('span', null, l.key + ' · owner ' + agentName(l.owner) + ' · token ' + l.token))
          }, '没有活跃租约'),
          sec('最近审批', v.approvals, function (a) {
            return h('li', { key: a.id },
              h('time', null, hhmm(a.at)),
              h('span', null, a.taskId + ' · ' + a.kind + ' ' +
                (a.kind === 'plan' ? 'plan r' + (a.planRevision === null ? '?' : a.planRevision) : 'head ' + shortSha(a.headSha)) +
                (a.by ? ' · ' + a.by : '') +
                (a.revokedAt ? '（已吊销）' : '')))
          }, '还没有审批记录'),
          sec('事务事件', v.events, function (e) {
            return h('li', { key: e.id },
              h('time', null, hhmm(e.at)),
              h('span', null, e.text + ' · ' + e.actor))
          }, st.degraded ? '旧服务端不返回事务事件；重启 dsh web 后这里会显示完整事件链。' : '还没有事务事件'),
        ].filter(Boolean)
        // 四段全空时不再铺四块空卡片，用一行提示收掉（内容全空时网格反而显得页面坏了）
        var sectionsQuiet = secEls.every(function (el) {
          return el.props && el.props.children && el.props.children[1] &&
            el.props.children[1].props && el.props.children[1].props.className === 'flowv-sec-empty'
        })

        // ---- C-03：自动车道面板 -----------------------------------------------
        //
        // auto 卡不上看板（rf-04），但「隐藏」必须配一个「看得见」的出口：
        // 否则降噪会变成失明 —— 人不再看板时，就不知道系统自动接管了什么、
        // 哪一条卡住了。所以这里是一份**常驻的**台账：
        //   标题永远在（空态写「没有自动卡」，整块消失会让人以为功能坏了）；
        //   展开后是最近 20 条，blocked / 有未归档请示的置顶（服务端排好序）。
        var renderAutoLane = function () {
          var lane = v.autoLane || { count: 0, boardEscalated: 0, tasks: [] }
          var list = Array.isArray(lane.tasks) ? lane.tasks : []
          var n = Number(lane.count) || 0
          var esc = Number(lane.boardEscalated) || 0
          var rows = list.map(function (t) {
            var isBad = !!t.blocked
            var colTxt = COLUMN_TITLES[t.column] || t.column || ''
            var tail = t.blocked && t.blocked.reason ? '⛔ ' + t.blocked.reason : (t.openInbox ? '📨' + t.openInbox : '')
            return h('li', {
              key: t.id,
              className: 'flowv-auto-row' + (isBad ? ' is-bad' : ''),
              title: (t.title || '') + (tail ? '\n' + tail : '') + '\n点这里打开详情',
              onClick: function () { openDrawer(t.id) },
            },
              h('span', { className: 'id' }, t.id),
              h('span', { className: 'ttl' }, t.title || '(未命名)'),
              tail ? h('span', { className: 'col' }, tail) : null,
              h('span', { className: 'col' }, colTxt),
              // 拉上板：自动车道的卡人看上了就收回看板（唯一会写 visibility 的用户入口）。
              // 不写「推下板」——往下推是系统的事，人在这里只做「我要盯着这张」。
              h(Btn, {
                small: true,
                title: '拉回看板（这张卡我要自己盯着）',
                onClick: function (e) {
                  if (e) e.stopPropagation()
                  act('task.visibility', { taskId: t.id, visibility: 'board' })
                },
              }, '拉上板'))
          })
          return h('div', { key: 'autolane', style: { marginTop: 12 } },
            h('div', { className: 'flowv-auto-head' },
              h('button', {
                type: 'button',
                className: 'flowv-auto-toggle',
                'aria-expanded': autoLaneOpen ? 'true' : 'false',
                onClick: function () { setAutoLaneOpen(function (prev) { return !prev }) },
              },
                (autoLaneOpen ? '▾ ' : '▸ ') + '自动车道',
                h('span', { className: 'n' }, '(' + n + ')'),
                !autoLaneOpen && n ? h('span', { className: 'n' }, '· 展开看') : null),
              esc
                ? h(Chip, { tone: 'warn', title: esc + ' 条自动卡卡住了或有请示在等人' }, '需人处理 ' + esc)
                : null,
              h('span', { className: 'flowv-hint' }, '这些卡被系统自动接管，不上看板；展开可见、可点开详情')),
            autoLaneOpen
              ? (rows.length
                ? h('ul', { className: 'flowv-auto-list' }, rows)
                : h('div', { className: 'flowv-sec-empty' }, '没有自动卡'))
              : null,
            // 折叠时也要能分清「没有自动卡」与「功能坏了」：这一句常驻。
            !autoLaneOpen && !n ? h('div', { className: 'flowv-sec-empty' }, '没有自动卡') : null,
            autoLaneOpen && n > list.length
              ? h('div', { className: 'flowv-hint' }, '只列最近 ' + list.length + ' 条（共 ' + n + ' 条）；卡住和等回复的已置顶')
              : null)
        }

        var bodyEl = h('div', { className: 'flowv-body' },
          h('div', { className: 'flowv-top' },
            stats,
            h('div', { className: 'flowv-lanes' },
              laneRow(v.lanes.human),
              // 纯本地看板模式（没开记录 issue）就不显示 issue 车道：它没有工位也不该有活
              v.project && v.project.config && v.project.config.recordIssues ? laneRow(v.lanes.issue) : null)),
          h('div', { className: 'flowv-board-head' },
            h('span', { className: 'flowv-board-title' }, '看板'),
            h('span', { className: 'flowv-hint' }, '点卡片打开详情；空列会收窄，把宽度让给有卡的列')),
          h('div', { className: 'flowv-cols' }, v.columns.map(columnEl)),
          // 自动车道紧跟在看板下面：它是看板的补充（不上板的那批卡在这里），不是设置项。
          renderAutoLane(),
          sectionsQuiet
            ? h('div', { className: 'flowv-quiet' }, '没有在跑的 run、租约、审批或事务事件——有活时这里会按列铺开')
            : h('div', { className: 'flowv-sections' }, secEls),
        )


        // v1.31.1：请示箱入口改成**带图标的浮标**，挂在右下角。
        //
        // 原来的做法是在看板顶上塞一个文字按钮，问题有三：
        //   ① 没有图标，和旁边"同步 issue""停止调度"混成一片，看不出它是"有东西等我"；
        //   ② 它跟着看板滚动/换页消失；
        //   ③ 有未读时只是文字里多个数字，不显眼。
        // 现在：固定在右下角、带收件箱图标 + 数字角标，任何滚动位置都点得到。
        var inboxFab = null;
        if (v.inbox) {
          var nOpen = Number(v.inbox.open) || 0;
          var nAnswered = Number(v.inbox.answered) || 0;
          var nTotal = nOpen + nAnswered;
          inboxFab = h('div', { className: 'flowv-fab' },
            h('button', {
              className: 'flowv-fab-btn' + (nOpen > 0 ? ' is-active' : ''),
              title: nOpen > 0
                ? nOpen + ' 条等你回复'
                : (nTotal > 0 ? nTotal + ' 条请示待归档（已回复，等调度处理）' : '请示箱（暂无内容）'),
              'aria-label': '打开 Inbox',
              onClick: function () {
                setInbox({
                  items: v.inbox.items || [], open: nOpen, answered: nAnswered,
                  loading: false, replying: null, draft: '',
                  tab: 'todo', q: '', sel: null, quote: null, attach: null, attachOpen: false, attachDraft: '',
                  // v1.39：结构化答复的草稿 / 展开态 / 处理记录展开态
                  answers: {}, expanded: {}, threadOpen: {},
                });
                refreshInbox({ includeArchived: false });
              },
            },
              h(InboxIcon),
              nTotal > 0
                ? h('span', { className: 'flowv-badge' + (nOpen > 0 ? '' : ' is-idle') }, nTotal > 99 ? '99+' : String(nTotal))
                : null
            )
          );
        }

        return h('div', { className: 'flowv' },
          head,

          // 停止状态必须一眼看见：否则人会以为"系统在跑只是不动"，反复刷新等活。
          ctl.halted ? h('div', { className: 'flowv-halt' },
            h('span', { className: 'flowv-halt-dot' }),
            h('span', null, '调度已停止 —— 不会自动派工、不会跑 tick，生成报错与停止生成也不再发给调度。'),
            ctl.haltedAt ? h('span', { className: 'flowv-halt-at' }, '停止于 ' + String(ctl.haltedAt).replace('T', ' ').slice(0, 19)) : null,
            h(Btn, {
              small: true,
              variant: 'primary',
              disabled: busy === 'flow.resume',
              onClick: function () {
                var action = 'flow.resume'
                setBusy(action)
                act(action, {}).then(function (res) { setBusy(''); if (res) { setNotice(res.message || '已恢复调度'); load() } })
              },
            }, busy === 'flow.resume' ? '恢复中…' : '恢复调度')) : null,
          st.error ? h('div', { className: 'flowv-err' }, '刷新失败：' + st.error + '（显示上次数据）') : null,
          notice ? h('div', { className: 'flowv-note' }, notice,
            h(Btn, { small: true, onClick: function () { setNotice('') } }, '知道了')) : null,
          bodyEl,
          inboxFab,
          renderDrawer(),
          renderInbox(),
          renderNewTask(),
          renderNewProject(),
          renderSettings(),
        )
      }
    }

    /** 注册「调度台」View：order 40，落在编队（fleet=30）右边。 */
    var registerPanel = function (ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function' || typeof ctx.slots.inject !== 'function') {
          logger.warn('当前 DSH 没有 slots 服务，跳过调度台视图')
          return
        }
        var require2 = typeof require === 'function' ? require : null
        if (!require2) return
        var React = null
        try { React = require2('react') } catch (err) {
          logger.warn('拿不到 react，跳过调度台视图', err)
          return
        }
        if (!React || typeof React.createElement !== 'function') return
        ensureStyle()
        // MarkdownText 来自 shell 的静态 seed 表（dsh-client-ui-primitives），
        // 拿不到就退回纯文本：这里绝不能因为可选依赖让整个调度台注册失败。
        var prims = null
        try {
          prims = require2('@deepseek-ai/dsh-client-ui-primitives')
        } catch (error) {
          logger.warn('markdown 组件不可用，讨论区退回纯文本', error)
        }
        var FlowView = createFlowView(React, ctx, prims)
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: VIEW_ID,
            order: 40,
            label: function () { return '调度台' },
          }, FlowView)
        })
      } catch (err) {
        logger.warn('调度台视图注册失败', err)
      }
    }

    var apply = function (ctx) {
      try {
        var query = readQuery()
        if (query.embed || query.sessionId) {
          if (query.embed) markEmbed(ctx)
          listenSwitch(ctx)
          if (query.sessionId) openWithRetry(ctx, query.sessionId)
          if (query.embed && window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'dsh-flow:ready' }, window.location.origin)
          }
          return
        }
        registerPanel(ctx)
      } catch (error) {
        logger.warn('apply 失败', error)
      }
    }

    exports.apply = apply
    exports.inject = ['sessions', 'uiWorkspace', 'layout', 'slots']
    return module.exports
  },
})
