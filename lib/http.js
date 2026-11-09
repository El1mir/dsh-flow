/**
 * dsh-flow · http
 *
 * 一个前缀路由 /api/flow/ 承担全部浏览器交互：
 *   GET  /api/flow/app          工作台页面
 *   GET  /api/flow/state        快照
 *   GET  /api/flow/stream       SSE（看板事件）
 *   GET  /api/flow/chat/stream  SSE（会话聊天帧，按 agentId 或 sessionId）
 *   POST /api/flow/action       统一动作入口
 */

import { normalizeWebhook, verifySignature, probeRepo } from './remote.js'
import { detectSetup } from './setup.js'
import { buildOverview, buildProjectView } from './panel.js'
import { sanitizeLossless, emit, nowIso } from './core.js'
// v1.39：老工单的 options 要在读侧补成 asks，界面不用到处判空
import { upgradeInboxItem } from './domain/inbox.js'

const MAX_BODY = 2 * 1024 * 1024
const json = (status, value) => Response.json(sanitizeLossless(value), { status })
const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }

async function readRaw(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req.body || []) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req) {
  const raw = await readRaw(req)
  return raw ? JSON.parse(raw) : {}
}

/** 任务可见性的两个合法值（rf-04）。字符串常量集中在这里，界面/工具/测试都从同一处取。 */
export const TASK_VISIBILITY = ['board', 'auto']

/**
 * 任务可见性的唯一写入口（rf-04）。
 *
 * 为什么不在 lib/domain.js 的 updateTask 里加一个字段：visibility 表达的是
 * **「这张卡要不要出现在看板上」**，不是内容字段。让 updateTask 接受它会打开一扇
 * 什么都往里塞的门（它现在的 allowed 白名单就是为此存在的）；而 domain 的
 * setMergeState 之类写的是状态机的一部分，visibility 不参与任何迁移。
 *
 * 语义：
 *   board = 上板（人看得见，旧行为）
 *   auto  = 只在自动车道视图出现（被系统接管、人不需要盯着）
 *
 * 不限制当前列 —— done 的卡也要能事后整理（收进自动车道 / 拉回板上）。
 * 幂等：值没变就不写事件，避免界面上点一下多一条审计噪音。
 */
export async function setTaskVisibility(domain, taskId, visibility, actor = { role: 'human', id: 'web' }) {
  if (!TASK_VISIBILITY.includes(visibility)) {
    throw new Error('visibility 只接受 board / auto，收到：' + String(visibility))
  }
  return domain.store.tx((s) => {
    const task = s.tasks[taskId]
    if (!task) throw new Error('unknown task: ' + taskId)
    const previous = task.visibility === 'auto' ? 'auto' : 'board'
    if (previous === visibility) return task
    task.visibility = visibility
    task.updatedAt = nowIso()
    emit(s, 'task.visibility', { taskId: task.id, projectId: task.projectId, visibility, previous }, actor)
    return task
  })
}

export function createHttpHandler(host) {
  const { domain, chat } = host
  const store = domain.store
  const agentById = (id) => store.state.agents[id]

  /** agentId → 该代理的活会话（没有就建一个，真实 DSH 会话）。 */
  const sessionFor = async (agentId) => {
    const agent = agentById(agentId)
    if (!agent) return { ok: false, message: 'unknown agent: ' + agentId }
    const project = store.state.projects[agent.projectId]
    return host.runtime.ensureSession(agent, project)
  }

  /**
   * 迁移的执行角色：HTTP 层没有 agent 身份，只有"本机已鉴权的浏览器操作"，
   * 所以这里按迁移语义署名。人类闸门保持 human，机器动作署名给对应角色，
   * 否则守卫会直接拒掉（角色 X 不能执行 Y）。
   */
  const actorForTransition = (action) => {
    const machine = {
      plan_ready: 'dispatcher',
      stop: 'worker',
      pr_open: 'worker',
      review_approve: 'dispatcher',
      review_conflict: 'dispatcher',
      review_risk: 'dispatcher',
      handoff: 'dispatcher',
      classify: 'dispatcher',
      reassign: 'dispatcher',
      // 跳过合并：子调度可以判定（非 Git 项目），人也随时能点
      merge_skip: 'dispatcher',
      investigate: 'dispatcher',
      submit_plan: 'dispatcher',
      approve_by_chief: 'chief',
      // v1.26：human 车道的代批。人的浏览器点这个动作时按调度署名 ——
      // 它本来就是「调度替人看一眼低风险方案」的语义，不是人行闸门。
      approve_by_dispatcher: 'dispatcher',
    }
    const role = machine[action]
    return role ? { role, id: 'web:' + role } : { role: 'human', id: 'web' }
  }

  const actions = {
    'skills.list': async (args) => {
      const project = store.state.projects[args.projectId]
      if (!project) return { ok: false, message: 'unknown project' }
      // skills = 目录里装了什么（设置页勾选用）；exposed = 允许向 AI 暴露的（按 allowedSkills 过滤）。
      // v1.40：白名单只做暴露过滤，不再在投递/加载时拒绝技能。
      return { ok: true, skills: await host.dispatcher.listSkills(project), exposed: await host.dispatcher.exposedSkills(project) }
    },
    'project.ensure': async (args) => host.ensureProject(args),
    'project.config': async (args) => {
      const patch = args.patch || {}
      const project = store.state.projects[args.projectId]
      if (!project) return { ok: false, message: 'unknown project: ' + args.projectId }
      // 纯本地看板 = 两条入站车道都关着（recordIssues + recordPulls 都为假）。
      // 此时不接受任何远程/自动化开关，否则会出现「本地模式却在自动合并」这种自相矛盾的状态。
      //
      // C-09 §3/§6：判据从「只看 recordIssues」改成「recordIssues || recordPulls」。
      // 为什么：只接别人 PR 的项目（recordPulls=true / recordIssues=false）同样需要
      // autoMerge —— 用 issue 开关当总闸会把它挡在外面。反过来，两个都关着时必须拦住
      // （这是防误配的最后一道：没有远程坐标就没有远程事实，自动化只会空转）。
      const automation = ['autoLane', 'autoDispatch', 'autoAccept', 'autoMerge', 'pushRemote']
      const nextRecordIssues = patch.recordIssues !== undefined ? !!patch.recordIssues : !!project.config.recordIssues
      const nextRecordPulls = patch.recordPulls !== undefined ? !!patch.recordPulls : !!project.config.recordPulls
      if (!nextRecordIssues && !nextRecordPulls) {
        const offending = automation.filter((k) => patch[k] !== undefined && patch[k])
        if (offending.length) {
          return { ok: false, message: '当前是纯本地看板模式（不记录 issue / PR），不能开启自动化开关：' + offending.join('、') + '。要开请先打开「记录 issue」或「记录 PR」。' }
        }
        if (patch.remote !== undefined && patch.remote) {
          return { ok: false, message: '当前是纯本地看板模式，不能配置远程仓库。' }
        }
      }
      return domain.updateProjectConfig(args.projectId, patch, { role: 'human', id: 'web' })
    },
    'task.create': async (args) => domain.createTask(args.projectId, args, { role: 'human', id: 'web' }),
    // v1.4：把「这张卡来自哪个对话」记下来，子调度/工人的回信投回那里
    // v1.4：子调度/工人 → 发起对话的回信（走 dispatcher.relayToOrigin，和巡检回信同一条路）
    'task.reply': async (args) => {
      const task = store.state.tasks[args.taskId]
      if (!task) return { ok: false, message: 'unknown task: ' + args.taskId }
      const sid = task.originSessionId || args.sessionId || null
      if (!sid) return { ok: false, message: '这张卡没有发起会话，无法回信' }
      const text = '【回信】' + task.id + ' ' + (task.title || '') + '\n' + String(args.message || '')
      const sent = await host.runtime.promptSession(sid, text, 'steer', { origin: 'system' })
      domain.logMessage({ sessionId: sid, agentId: null, direction: 'out', origin: 'system', kind: 'reply', ok: !!sent.ok, taskId: task.id })
      return { ok: !!sent.ok, sessionId: sid, message: sent.message || '已回信' }
    },
    'task.origin': async (args) => {
      try {
        const sid = await domain.setOriginSession(args.taskId, args.sessionId || null, { role: 'human', id: 'web' })
        return { ok: true, taskId: args.taskId, originSessionId: sid }
      } catch (err) {
        return { ok: false, error: String(err.message || err) }
      }
    },
    'task.update': async (args) => domain.updateTask(args.taskId, args.patch || {}, { role: 'human', id: 'web' }),
    // rf-04：人把自动卡「拉上板」或「推下板」。这是唯一会写 visibility 的用户入口
    // （flow_task_update 走同一个 setTaskVisibility，不重复实现校验）。
    'task.visibility': async (args) => {
      const t = await setTaskVisibility(domain, args.taskId, args.visibility, { role: 'human', id: 'web' })
      return { ok: true, taskId: t.id, visibility: t.visibility || 'board' }
    },
    // 按迁移本身要求的角色署名：一律用 human 会让 plan_ready / stop / pr_open / review_*
    // 这些「工人或调度员的动作」在界面上永远点不动（线上实测过）。
    // 人类闸门（approve / accept / cancel / reopen / reject）仍以 human 运行。
    'task.move': async (args) => domain.move(args.taskId, args.action, actorForTransition(args.action), args.payload || {}),
    'task.plan': async (args) => domain.setPlan(args.taskId, args.text, { role: 'dispatcher', id: 'web' }),
    // 显式声明"这张卡要不要合并"（非 Git 工作区默认不合并；人也可以手动改回来）
    'task.noMerge': async (args) => {
      const t = await domain.setNoMerge(args.taskId, args.noMerge !== false, args.reason || '', { role: 'human', id: 'web' })
      return { ok: true, taskId: t.id, noMerge: !!t.noMerge, reason: t.noMergeReason || '' }
    },
    'task.block': async (args) => domain.block(args.taskId, args.reason, { role: 'human', id: 'web' }),
    'task.unblock': async (args) => domain.unblock(args.taskId, { role: 'human', id: 'web' }),
    'task.comment': async (args) => domain.comment(args.taskId, args.content, { role: 'human', id: 'web' }),
    // ---- v1.31：调度员请示箱（人这一侧） -------------------------------------
    'inbox.list': async (args) => {
      const query = {
        projectId: args.projectId || null,
        taskId: args.taskId || null,
        status: args.status || null,
        kind: args.kind || null,
        q: args.q || null,
        includeArchived: args.includeArchived === true,
        limit: Number(args.limit) || 100,
        offset: Number(args.offset) || 0,
      }
      const items = domain.inboxList(query)
      const counts = { open: 0, answered: 0, archived: 0, unread: 0, notices: 0 };
      const all = domain.inboxList({ projectId: query.projectId, includeArchived: true, limit: 5000 })
      for (const x of all) {
        if (counts[x.status] !== undefined) counts[x.status] += 1;
        if (x.status !== 'archived' && !x.readAt) counts.unread += 1;
        if (x.status !== 'archived' && (x.kind === 'info' || x.kind === 'error')) counts.notices += 1;
      }
      // v1.39：老工单没有 asks/context，读侧统一补齐（界面不用到处判空）
      // v0.012：邮箱要分页与 tab 计数，所以把 total / hasMore 一起回给客户端。
      return {
        items: items.map((x) => upgradeInboxItem(x)),
        counts,
        total: all.length,
        hasMore: (Number(args.offset) || 0) + items.length < all.length,
      };
    },

    // v0.012：标「已读」。与 inbox.mark-read（通知类=归档）不是一回事 —— 看过不等于处理完。
    'inbox.read': async (args) => {
      const item = await domain.markInboxRead(args.inboxId, { role: 'human', id: 'web' })
      return { ok: true, id: item.id, readAt: item.readAt || null, status: item.status }
    },
    'inbox.reply': async (args) => {
      // 客户端没传 answers 就是纯文本回复（老语义）；传了才按 asks 逐项校验
      const opts = {}
      if (args.answers && typeof args.answers === 'object') opts.answers = args.answers
      // v0.013：人可以随回复附组件（证据 / 链接），与调度用的是同一套白名单
      if (Array.isArray(args.blocks)) opts.blocks = args.blocks
      const item = await domain.replyInbox(args.inboxId, args.content, { role: 'human', id: 'web' }, opts)
      // 异步叫醒原发送调度：它收到才知道可以继续推进了。
      // 走 ensureSession + promptSession（不是 promptAgent —— 那个方法不存在）。
      // v1.37.3 修：原来只看 item.from 是不是 ag_*。
      // 但 auto-accept / scheduler 发的请示 from 是 "system:auto-accept" 这类，
      // 于是人回复后**谁都没被叫醒** —— 补充说明永远躺在 Inbox 里（线上 T-046 的真实情况）。
      // 现在：from 是具体代理就用它；否则按这张卡所属车道找调度员（和巡检包同一条找法）。
      const who = String(item.from || '')
      const taskForLane = item.taskId ? store.state.tasks[item.taskId] : null
      const lane = (taskForLane && taskForLane.lane) || item.lane || 'human'
      const projectIdForLane = (taskForLane && taskForLane.projectId) || item.projectId || null
      // v1.39.1：**两边都要叫醒**。旧逻辑是"from 是 ag_* 就只叫它"，结果是：
      //   · 工人发的票 → 只叫醒工人，调度全程不知道人在票里回了话（卡还挂在工人手上）；
      //   · 系统发的票 → 只叫醒调度，工人手里的答案没人转达。
      // 现在：原发送方（如果是代理）+ 同车道调度员，两个都发，去重后逐个投递。
      const recipients = []
      const originAgent = who.indexOf('ag_') === 0 ? (store.state.agents[who] || null) : null
      if (originAgent) recipients.push(originAgent)
      {
        // 优先同项目同车道的调度员，其次是项目内任意启用的调度员
        const dispatchers = Object.values(store.state.agents).filter((a) =>
          a && a.role === 'dispatcher' && a.enabled !== false && (!projectIdForLane || a.projectId === projectIdForLane))
        const laneDispatcher = dispatchers.find((a) => (a.lane || 'human') === lane) || dispatchers[0] || null
        if (laneDispatcher && !recipients.some((r) => r.id === laneDispatcher.id)) recipients.push(laneDispatcher)
      }
      // v1.39.1：把这次回复整理成调度能直接用的一段话（结构化答案 + 人没答的必答项）。
      const lastReply = (item.replies || [])[item.replies.length - 1] || {}
      const ans = (lastReply && lastReply.answers) || {}
      const missing = Array.isArray(lastReply.missing) ? lastReply.missing : []
      const askLines = (item.asks || []).filter((a) => ans[a.key] !== undefined).map((a) => {
        const picked = a.type === 'choice' ? ((a.choices || []).find((c) => c.value === ans[a.key]) || {}) : {}
        return '- ' + a.key + ' ' + a.question.slice(0, 60) + ' → ' + (picked.label ? picked.label + '（' + ans[a.key] + '）' : ans[a.key])
      })
      const missingLines = missing.map((k) => {
        const a = (item.asks || []).find((x) => x.key === k) || {}
        return '- ' + k + ' ' + String(a.question || '').slice(0, 60) + (a.blocks ? '（不答会卡住：' + String(a.blocks).slice(0, 60) + '）' : '')
      })
      const headLines = [
        '【人已回复你的请示 ' + item.id + '】' + String(item.topic || '').slice(0, 120),
        ...(askLines.length ? ['【结构化答案】', ...askLines] : []),
        ...(missingLines.length ? ['【人没答的必答项】', ...missingLines] : []),
        ...(String(args.content || '').trim() ? ['【人的补充说明】', String(args.content || '').slice(0, 2000)] : []),
      ]
      // v1.39.1 核心修复：被叫醒的人**必须先回票**。
      // 原来的提示词只让它 flow_inbox_resolve 归档 —— 人呢？票被归档，
      // 但没有任何人回他一句话。线上那 6 张票都是这么结束的。
      const isDispatcher = (a) => a && a.role === 'dispatcher'
      const textFor = (a) => (isDispatcher(a)
        ? [
            ...headLines,
            '',
            '按这个顺序做，不要跳过第 1 步：',
            '1. 先用 flow_inbox_reply 把结论回在这张票里：第一行写判断（继续 / 改方案 / 还差什么），下面列要点。人只在票里看你的话，不回等于没回应。',
            '2. 如果信息还缺，用 flow_inbox_reply 追问并结束本轮（别急着归档）。',
            '3. 阻塞确实消除了，再用 flow_inbox_resolve 归档（note 写判断依据），然后继续推进 ' + String(item.taskId || '') + '。',
            '4. 这张卡有工人在跑的话，人的答案已经直接转给它了，不要重复转达。',
          ].join(String.fromCharCode(10))
        : [
            ...headLines,
            '',
            '人已经在票里答复了你要的东西。',
            '1. 先用 flow_inbox_reply 在票里回一句你接下来怎么做（人只在这里看得到）。',
            '2. 然后按答复继续干活；还缺关键信息就用 flow_message（to=dispatcher）说明缺什么，不要自己猜。',
            '3. 干完或卡住就结束本轮（stop / block），调度会接手。',
          ].join(String.fromCharCode(10)))
      if (host.runtime && typeof host.runtime.promptSession === 'function') {
        if (!recipients.length) {
          // v1.39.1：没人接手时**不许静默跳过**。原来这里是裸 if，
          // 线上两条人工回复连一条日志都没有 —— 事后根本查不到。
          domain.logMessage({ sessionId: null, agentId: null, direction: 'out', origin: 'system', kind: 'inbox-reply-failed', ok: false, taskId: item.taskId, reason: '项目里没有可用的调度员（' + String(projectIdForLane || '未知项目') + '），人的回复没有任何代理收到' })
        }
        for (const a of recipients) {
          const project = store.state.projects[a.projectId]
          const ens = await host.runtime.ensureSession(a, project).catch(() => ({ ok: false }))
          if (!(ens && ens.ok)) {
            domain.logMessage({ sessionId: null, agentId: a.id, direction: 'out', origin: 'system', kind: 'inbox-reply-failed', ok: false, taskId: item.taskId, reason: String((ens && ens.message) || '会话不可用').slice(0, 200) })
            continue
          }
          const sent = await host.runtime.promptSession(ens.sessionId, textFor(a), 'steer', { origin: 'system' }).catch(() => ({ ok: false }))
          domain.logMessage({ sessionId: ens.sessionId, agentId: a.id, direction: 'out', origin: 'system', kind: 'inbox-reply', ok: !!sent.ok, taskId: item.taskId })
        }
      } else {
        domain.logMessage({ sessionId: null, agentId: null, direction: 'out', origin: 'system', kind: 'inbox-reply-failed', ok: false, taskId: item.taskId, reason: '运行时不可用，没人能收到这条回复' })
      }
      // v1.39.1：票所属卡有在跑的工人 → 把人的答案直接转给它，别让它拿着一半信息继续干。
      //
      // v0.012：这一段是**可选副作用**，必须尽力而为。
      // 线上事故：`store.state.runs` 是字典（`lib/core.js` 的 `runs: {}`，键是 run id），
      // 这里曾经当数组用 `.find(...)` → 人每次回信都抛 `find is not a function`，
      // 而回复其实早已落库并叫醒了调度 —— 提示与事实正好相反。
      // 所以两件事一起做：取值改成字典查，并且把整段包进 try/catch（类错误以后还会再来）。
      const activeRunId = taskForLane && taskForLane.activeRunId
      let steerFailed = null
      if (activeRunId && host.runtime && typeof host.runtime.steer === 'function') {
        try {
          const run = (store.state.runs || {})[activeRunId]
          if (run && run.agentId) {
            const steerText = [
              ...headLines,
              '按人的答复继续做。如果还缺关键信息，用 flow_message 发回调度（to=dispatcher）说明缺什么，不要自己猜。',
            ].join(String.fromCharCode(10))
            const st = await host.runtime.steer(store.state.projects[run.projectId] || null, { agentId: run.agentId, message: steerText }).catch(() => ({ ok: false }))
            domain.logMessage({ sessionId: run.sessionId || null, agentId: run.agentId, direction: 'out', origin: 'system', kind: 'inbox-steer-worker', ok: !!(st && st.ok), taskId: item.taskId })
          }
        } catch (err) {
          steerFailed = String((err && err.message) || err)
          domain.logMessage({ sessionId: null, agentId: null, direction: 'out', origin: 'system', kind: 'inbox-reply-steer-failed', ok: false, taskId: item.taskId, detail: steerFailed.slice(0, 300) })
        }
      }
      // ok 只反映「回复本身成没成」；steerFailed 单独回传，界面可以提示「工人没被叫醒」，但不该说回复失败。
      return { ok: true, id: item.id, status: item.status, replies: item.replies.length, steerFailed }
    },
    'inbox.archive': async (args) => {
      const item = await domain.resolveInbox(args.inboxId, { note: args.note || '人手动归档' }, { role: 'human', id: 'web' })
      if (item.taskId) await domain.clearAdvanceBlocked(item.taskId).catch(() => null)
      return { ok: true, id: item.id, status: item.status };
    },
    'task.dispatch': async (args) => host.dispatch(store.state.tasks[args.taskId]),
    'task.inspect': async (args) => {
      const task = store.state.tasks[args.taskId]
      return { suggestion: domain.inspect(args.taskId), notify: args.notify === false ? null : await host.notifyDispatcher(task, '人工巡检', 'manual') }
    },
    // v1.30：走 host.openPr（它才是完整流程：commitAll → headSha → 本地 PR 记录 → 推送建远程 PR）。
    // 原来直接调 domain.openMergeRequest，它要求调用方自带 headSha ——
    // 而看板上根本没有这个字段，于是「开 PR」永远失败（headSha 必填）。
    'pr.open': async (args) => {
      const task = store.state.tasks[args.taskId]
      if (!task) return { ok: false, reason: 'unknown task: ' + args.taskId }
      if (!host.openPr) return domain.openMergeRequest(args.taskId, args, { role: 'worker', id: 'web' })
      const res = await host.openPr(task, { message: args.message || args.summary || undefined })
      if (!res || res.ok === false) return { ok: false, reason: (res && (res.message || res.reason)) || 'pr-open-failed' }
      const fresh = store.state.tasks[args.taskId] || task
      return { ok: true, mergeRequestId: fresh.mergeRequest && fresh.mergeRequest.id, headSha: fresh.mergeRequest && fresh.mergeRequest.headSha, commit: res.commit || null, pushed: res.pushed || null }
    },
    // v1.35：与 flow_pr_review 共用 domain.review（approved 只记结论，不再因 review_approve 守卫回滚）
    //
    // 看板上「审核通过」是人点的：人审过了就该真合并（看板没有单独的合并按钮，
    // v1.32 之后这个按钮一直因 review_approve 守卫回滚而失败）。合并失败把原因带回去。
    'pr.review': async (args) => {
      const r = await domain.review(args.taskId, args.verdict, { matched: args.matched || [], summary: args.summary || '' }, { role: 'dispatcher', id: 'web' })
      if (r.next !== 'merge' || !host.merge) return r.task
      const merged = await host.merge(store.state.tasks[args.taskId], { by: 'human' }).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
      const task = store.state.tasks[args.taskId] || r.task
      if (merged && merged.ok) return task
      return { ...task, mergeResult: { ok: false, conflict: !!(merged && merged.conflict), queued: !!(merged && merged.queued), message: (merged && merged.message) || '合并没有完成' } }
    },
    'review.prompt.upsert': async (args) => domain.upsertReviewPrompt(args.projectId, args, { role: 'human', id: 'web' }),
    'agent.upsert': async (args) => domain.upsertAgent(args.projectId, args, { role: 'human', id: 'web' }),
    'agent.session': async (args) => sessionFor(args.agentId),
    'agent.reset': async (args) => host.runtime.resetSession(null, args.agentId),
    // v1.37：项目指标 — 所有可从 store 直接算的指标同步返回；token 数据可选
    'project.metrics': async (args) => {
      const project = store.state.projects[args.projectId]
      if (!project) return { ok: false, message: 'unknown project' }
      const view = buildProjectView(store.state, args.projectId)
      if (!view.ok) return view
      const tokensFromHost = args.withTokens && host.runtime && typeof host.runtime.getSessionTokens === 'function'
        ? await host.runtime.getSessionTokens(args.projectId).catch(() => null)
        : null
      return { ok: true, totals: view.totals, tokens: tokensFromHost }
    },
    'inbox.mark-read': async (args) => {
      const item = await domain.markInfoRead(args.inboxId, { role: 'human', id: 'web' })
      return { ok: true, id: item.id, status: item.status }
    },
    'inbox.follow-up': async (args) => {
      const actor = { role: 'dispatcher', id: 'dispatcher:web' }
      const item = await domain.appendInboxFollowUp(args.inboxId, args.content, actor)
      return { ok: true, id: item.id, status: item.status }
    },
    // v1.37：全局设置（调度默认模型）
    'settings.get': async () => ({ ok: true, settings: store.state.settings || {} }),
    'settings.set': async (args) => {
      const s = store.state.settings || {}
      // v0.007：从「整块重建」改成「合并」—— 以前每加一个设置项，忘了往这里补一行就会被静默抹掉
      // （dispatcherAutoResume 这类会读成 undefined，从而回落到默认值，看起来像「设置不生效」）。
      const next = { ...s }
      if (args.defaultProvider !== undefined) next.defaultProvider = args.defaultProvider || null
      if (args.defaultModel !== undefined) next.defaultModel = args.defaultModel || null
      if (args.defaultReasoningEffort !== undefined) next.defaultReasoningEffort = args.defaultReasoningEffort || null
      // 调度员自动续跑：默认开；上限 1..10，非法值忽略（保持原值）。
      if (args.dispatcherAutoResume !== undefined) next.dispatcherAutoResume = args.dispatcherAutoResume === true || args.dispatcherAutoResume === '1'
      if (args.dispatcherAutoResumeMax !== undefined) {
        const n = Number(args.dispatcherAutoResumeMax)
        if (Number.isFinite(n) && n >= 1) next.dispatcherAutoResumeMax = Math.min(10, Math.floor(n))
      }
      store.state.settings = next
      await store.persist()
      return { ok: true, settings: store.state.settings }
    },
    // v1.17：把工位的历史会话收干净（归档 + 标记 archived），用于清掉「未分组」里的孤儿会话。
    // 之后 project.init 会重新建一个干净的、确实挂在工作区里的会话。
    'agent.clean': async (args) => host.runtime.cleanSession(args.agentId, { force: args.force === true }),
    // 给整个项目做一遍：清掉所有非 chief 工位的旧会话，再走一遍初始化。
    // 用户的诉求就是「直接清理这些会话并修复这个问题然后我重新初始化」——一步到位。
    'project.reset': async (args) => {
      const project = store.state.projects[args.projectId]
      if (!project) return { ok: false, message: 'unknown project: ' + args.projectId }
      const target = Object.values(store.state.agents)
        .filter((a) => a.projectId === args.projectId && a.enabled !== false && a.role !== 'chief')
      const cleaned = []
      const skipped = []
      for (const a of target) {
        const res = await host.runtime.cleanSession(a.id, { force: args.force === true })
        if (res.ok) cleaned.push({ agentId: a.id, name: a.name || a.role, archived: res.archived })
        else skipped.push({ agentId: a.id, name: a.name || a.role, message: res.message })
      }
      const init = await host.runtime.ensureProjectSessions(args.projectId)
      return {
        ok: init.ok !== false,
        projectId: args.projectId,
        cleanedCount: cleaned.length,
        cleaned,
        skipped,
        init,
        message: '清理 ' + cleaned.length + ' 个工位（跳过 ' + skipped.length + '）；' + (init.message || ''),
      }
    },
    // 「初始化仓库」：环境自检（基础分支/远程/issue 开关）→ 给**已存在**的工位备会话
    // → 标身份名 → 把漂在别处的会话收回工作区。幂等，可以反复点。
    // v1.40：不再补齐工位池 —— 工位只在项目第一次落库时初始化一次。
    'project.init': async (args) => host.runtime.ensureProjectSessions(args.projectId),
    // v1.40：显式补齐工位（设置页「创建需求讨论工位」、被删工位加回来）——唯一的补工位入口。
    'agents.ensure': async (args) => host.runtime.ensureAgents(args.projectId, { sessions: args.sessions !== false }),
    // 只做环境自检 + 配置补齐，不建会话；dryRun 只报「会改什么」不动库（界面用来预览）。
    'project.setup': async (args) => host.runtime.setupProject(args.projectId, { dryRun: args.dryRun === true }),
    // 老名字保留，前端/脚本都还在用。
    'project.sessions': async (args) => host.runtime.ensureProjectSessions(args.projectId),
    // 改角色模型：落库 + 有活会话就立刻切换（不换会话）。
    'agent.selectModel': async (args) => host.runtime.selectAgentModel(args.agentId, args),
    'chat.send': async (args) => {
      const ens = await sessionFor(args.agentId)
      if (!ens.ok) return ens
      const message = String(args.message || '')
      // 以 / 开头 = 斜杠命令，走和 DSH 聊天框同一条命令通道（/goal、/compact、/feedback…）
      if (/^\s*\//.test(message)) {
        const out = await host.runtime.runCommand(args.agentId, message.trim())
        return { ...out, sessionId: ens.sessionId, command: true }
      }
      const sent = await host.runtime.promptSession(ens.sessionId, message, args.mode === 'steer' ? 'steer' : 'queue')
      return { ...sent, sessionId: ens.sessionId }
    },
    'session.list': async () => ({ items: host.runtime.listSessions ? await host.runtime.listSessions() : [] }),
    'session.commands': async (args) => ({ items: host.runtime.listCommands ? await host.runtime.listCommands(args.agentId) : [] }),
    'agent.bindSession': async (args) => host.runtime.bindAgentSession(args.agentId, args.sessionId),
    'chat.cancel': async (args) => {
      const rec = domain.latestSession(args.agentId)
      if (!rec || !rec.sessionId) return { ok: false, message: '该代理还没有会话' }
      return host.runtime.cancelSession(rec.sessionId)
    },
    'inspect': async (args) => domain.inspect(args.taskId),
    'state': async (args) => domain.snapshot(args.projectId),
    'workspace.list': async () => ({ items: host.listWorkspaces ? host.listWorkspaces() : [] }),
    // ---- v1.0：车道 / 改派 / 阅读范围 / 预算 / 巡检 -------------------------
    // v1.0：主调度 = 用户默认聊天会话
    'chief.get': async (args) => {
      const project = store.state.projects[args.projectId]
      if (!project) return { ok: false, message: 'unknown project: ' + args.projectId }
      const chief = domain.chiefOf(args.projectId)
      return {
        ok: true,
        projectId: args.projectId,
        chiefAgentId: chief ? chief.id : null,
        chiefName: chief ? chief.name : null,
        sessionId: domain.chiefSessionOf(args.projectId),
      }
    },
    'chief.bind': async (args) => {
      const r = await host.runtime.bindChiefSession(args.projectId, args.sessionId, { cwd: args.cwd || null })
      return r
    },
    'chief.unbind': async (args) => {
      try {
        const r = await domain.unbindChiefSession(args.projectId, { role: 'human', id: 'web' })
        return { ok: true, projectId: r.projectId, sessionId: r.sessionId }
      } catch (err) {
        return { ok: false, error: String(err.message || err) }
      }
    },
    'lane.get': async (args) => ({ ok: true, lanes: domain.lanesOf(args.projectId), lane: args.lane || null }),
    'lane.set': async (args) => {
      const want = args.lane === 'issue' ? 'issue' : 'human'
      const res = await domain.ensureLaneAgents(args.projectId, want, {
        dispatchers: args.dispatchers !== undefined ? Number(args.dispatchers) : undefined,
        workers: args.workers !== undefined ? Number(args.workers) : undefined,
      }, { role: 'human', id: 'web' })
      // 没开记录 issue 的项目不该被偷偷配上 issue 车道：明确拒绝，别让人以为配上了
      if (res && res.skipped === 'record-issues-off') {
        return { ok: false, message: '这个项目没开「记录 issue」，当前是纯本地看板模式；要先在设置里打开才能配 issue 车道' }
      }
      return { ok: true, lanes: res.lanes, created: res.created.length }
    },
    'agent.reparent': async (args) => {
      const agent = await domain.reparent(args.agentId, args.supervisorId || null, { role: 'human', id: 'web' })
      return { ok: true, agentId: agent.id, supervisorId: agent.supervisorId || null }
    },
    'scope.set': async (args) => {
      const task = await domain.setScope(args.taskId, { paths: args.paths || [], symbols: args.symbols || [] }, { role: 'human', id: 'web' })
      return { ok: true, taskId: task.id, scope: task.scope }
    },
    // v1.37：budget.get 和 budget.compact 已移除
    'task.inspect.write': async (args) => {
      const task = await domain.setInspection(args.taskId, args.verdict, args.reasons || [], { role: 'dispatcher', id: 'web' })
      return { ok: true, taskId: task.id, inspection: task.inspection }
    },
    'task.reassign': async (args) => {
      const task = store.state.tasks[args.taskId]
      if (!task) return { ok: false, message: 'unknown task: ' + args.taskId }
      const sup = args.supervisorId ? store.state.agents[args.supervisorId] : null
      if (args.supervisorId && !sup) return { ok: false, message: 'unknown supervisor: ' + args.supervisorId }
      const moved = await domain.move(task.id, 'reassign', { role: 'human', id: 'web' })
      if (sup) await domain.reparent(args.agentId || task.assignee, sup.id, { role: 'human', id: 'web' }).catch(() => null)
      return { ok: true, taskId: moved.id, column: moved.column, phase: moved.phase, supervisorId: args.supervisorId || null }
    },
    // v1.2：数据清理（外部手改 flow.json 会被内存态覆盖，只能走 action）
    'task.remove': async (args) => {
      try {
        const r = await domain.removeTask(args.taskId, { role: 'human', id: 'web' })
        return { ok: true, taskId: r.taskId }
      } catch (err) {
        return { ok: false, error: String(err.message || err) }
      }
    },
    'project.remove': async (args) => {
      try {
        const r = await domain.removeProject(args.projectId, { role: 'human', id: 'web' })
        return { ok: true, projectId: r.projectId, name: r.name, removedTasks: r.removedTasks }
      } catch (err) {
        return { ok: false, error: String(err.message || err) }
      }
    },
    // 诊断：/flow 会 deny 哪些工具（只读，不真的 restrict）
    'diag.flow': async (args) => {
      try {
        return await host.diagFlowPlan(args.sessionId)
      } catch (err) {
        return { ok: false, error: String(err.message || err) }
      }
    },
    // 诊断：会话 cwd 到底从哪一层拿到的（线上排查"解析不出工作区"）
    'diag.cwd': async (args) => {
      try {
        return await host.diagSessionCwd(args.sessionId)
      } catch (err) {
        return { ok: false, error: String(err.message || err) }
      }
    },
    // v1.4：模型下拉的数据源（DSH 原生目录 + agent preset 列表）
    'catalog.get': async () => host.catalog(),
    'task.detail': async (args) => {
      const detail = domain.taskDetail(args.taskId)
      if (!detail) return { ok: false, message: 'unknown task: ' + args.taskId }
      return detail
    },
    // ---- v0.3 -----------------------------------------------------------
    // 和 flow_task_handoff / flow_publish 走同一个入口（v1.35 domain.handoffTask）
    'task.handoff': async (args) => {
      const r = await domain.handoffTask(args.taskId, { to: args.to || 'dispatcher', notes: args.notes || '' }, { role: 'chief', id: 'web' })
      if (!r.warning) delete r.warning
      return r
    },
    'task.inject': async (args) => domain.inject(args.taskId, { kind: args.kind || 'context', content: args.content || '', agentId: args.agentId || null }, { role: 'dispatcher', id: 'web' }),
        // v1.33：把「说合并了但其实没合并」的卡退回 merging，让合并事务能正常处理它。
    // 只能修 phase=merged 且没有 mergedCommit 的卡，避免变成一个随意改状态的入口。
    'task.repairUnmerged': async (args) => domain.repairUnmerged(args.taskId, { reason: args.reason || '', mergedCommit: args.mergedCommit || null }, { role: 'human', id: 'web' }),
    // 人在看板上点合并：这次点击本身就是人工审核结论（见 dispatch.reviewGate）
    'task.merge': async (args) => host.merge(store.state.tasks[args.taskId], { strategy: args.strategy, by: 'human' }),
    // I-04：集成检出的查询与释放。base 默认被它占住这件事必须有个看板出口，
    // 否则人只能看到 `fatal: 'master' is already used by worktree` 而不知道下一步做什么。
    'integration.status': async (args) => {
      const project = store.state.projects[args.projectId]
      if (!project) return { ok: false, reason: 'unknown project: ' + args.projectId }
      if (!host.integrationStatus) return { ok: false, reason: 'host 不支持集成检出' }
      const status = await host.integrationStatus(project, { base: args.base })
      return { ok: true, status }
    },
    'integration.release': async (args) => {
      const project = store.state.projects[args.projectId]
      if (!project) return { ok: false, reason: 'unknown project: ' + args.projectId }
      if (!host.releaseIntegration) return { ok: false, reason: 'host 不支持集成检出' }
      const res = await host.releaseIntegration(project, { base: args.base })
      return { ok: res.ok === true, removed: !!res.removed, reason: res.reason || null, message: res.message || null }
    },
    'task.softMerge': async (args) => host.softMerge(store.state.tasks[args.taskId], { onto: args.onto }),
    'worktree.list': async (args) => ({ items: Object.values(store.state.worktrees), taskId: args.taskId || null }),
    /**
     * 远程仓库探测（v1.22 P7，只读）。
     *
     * 设置面板要能"从我工作区的 git remote 自动填"，而不是让人手抄 owner/repo。
     * 这里只读：不写配置、不建标签、不改任何东西 —— 探测的结论由人确认后才 patch。
     */
    'remote.detect': async (args) => {
      const project = args.projectId ? store.state.projects[args.projectId] : null
      const dir = (project && project.workspacePath) || String(args.path || '').trim()
      if (!dir) return { ok: false, reason: '没有工作区路径' }
      const detected = await detectSetup(dir)
      return {
        ok: true,
        isRepo: detected.isRepo,
        hasCommits: detected.hasCommits,
        branch: detected.branches && detected.branches.default,
        remotes: detected.remotes || [],
        remote: detected.remote || null,
        upstream: detected.upstream || null,
        notes: detected.notes || [],
      }
    },

    /**
     * 远程连通性测试（v1.22 P7，只读）：用当前（或传入的）坐标读一次仓库。
     * 返回值里 hasIssues 决定"能不能开 issue 同步"——上游关着 issue 的仓库，
     * 双向同步开起来只会每一轮都失败。
     */
    'remote.test': async (args) => {
      const project = args.projectId ? store.state.projects[args.projectId] : null
      const cfg = (project && project.config) || {}
      const remote = args.remote || cfg.remote
      if (!remote || !remote.owner || !remote.repo) return { ok: false, reason: '还没配 owner/repo' }
      const res = await probeRepo({ remote })
      return { ok: !!res.ok, ...res }
    },

    'event.sync': async (args) => {
      const project = args.projectId ? store.state.projects[args.projectId] : null
      if (!project) return { ok: false, reason: 'unknown project' }
      // v1.23：走同步引擎（带 marker 过滤 + 出站 + 评论），老 syncProject 只是引擎不可用时的退路。
      const run = host.runSync || ((p) => host.syncProject({ domain, project: p }))
      const res = await run(project)
      if (!res || res.ok !== false) {
        // 引擎与老路径的形状不同，这里归一成一个给人看的回执，界面与工具都读 message
        const ap = (res && res.applied) || res || {}
        const parts = []
        if (ap.issues) parts.push('入站 ' + ap.issues)
        if (ap.tasks) parts.push('建卡 ' + ap.tasks)
        if (ap.comments || ap.commentMarks) parts.push('评论 ' + (ap.comments || 0) + '/' + (ap.commentMarks || 0))
        if (res && Array.isArray(res.notes) && res.notes.length) parts.push(res.notes.join('；'))
        if (typeof res.pulled === 'number') parts.push('拉 ' + res.pulled + ' 条')
        return { ok: true, message: parts.length ? '同步完成：' + parts.join('，') : '同步完成（没有变化）', stats: ap, notes: (res && res.notes) || [], cursor: (res && res.cursor) || null }
      }
      return { ok: false, reason: res.reason || res.skipped || 'sync-failed', skipped: res.skipped || null, results: res.results || null }
    },
    /**
     * 一键停止全部调度（v1.24）。
     *
     * 只做一件事：把控制位立起来，并让在跑的 run 全部收成 interrupted。
     * 停的语义是「安静」——tick 不跑、不派工、事件不再灌给调度；
     * 但**不自动改任何卡的状态**（卡停在 running 列等人决定），
     * 也不删会话（工人可能正写完一半的东西，留着可查）。
     */
    'flow.halt': async (args) => {
      if (!host.haltAll) return { ok: false, reason: '宿主没有 flow.halt（要重启 dsh web）' }
      const res = await host.haltAll(args.reason || null, { role: 'human', id: 'web' })
      const n = (res.cancelled || []).filter((x) => x.ok).length
      return {
        ok: true,
        halted: true,
        message: '已停止全部调度：收掉 ' + res.interruptedRuns + ' 个 run，取消 ' + n + ' 个在跑的会话。' +
          (res.already ? '（之前就已经是停止状态）' : '') + '恢复前不会再自动派工。',
        interruptedRuns: res.interruptedRuns,
        cancelled: res.cancelled,
      }
    },
    'flow.resume': async () => {
      if (!host.resumeAll) return { ok: false, reason: '宿主没有 flow.resume（要重启 dsh web）' }
      const res = await host.resumeAll({ role: 'human', id: 'web' })
      return {
        ok: true,
        halted: false,
        message: res.was ? '已恢复调度：下一拍开始自动推进。' : '本来就没有停止，无需恢复。',
        was: !!res.was,
      }
    },
    'event.tick': async () => host.scheduler.tick(),
    'worker.log': async (args) => ({ items: store.state.message_log.filter((m) => !args.agentId || m.agentId === args.agentId).slice(-(Number(args.limit) || 50)) }),
  }

  return async function handler(req) {
    const url = new URL(req.url, 'http://local')
    const path = url.pathname.replace(/^\/api\/flow/, '') || '/'

    if (req.method === 'GET' && path === '/state') {
      const projectId = url.searchParams.get('projectId') || undefined
      // 事件窗口可调：默认 100 条（首屏体积），排查时可要更多（上限 2000）。
      const wantEvents = Number(url.searchParams.get('events')) || 0
      const eventLimit = wantEvents ? Math.min(2000, Math.max(1, wantEvents)) : 100
      return json(200, { ok: true, state: domain.snapshot(projectId, { eventLimit }), projects: host.listProjects() })
    }

    // v1.0：全项目总览（原生面板首屏一次拿全，只读）
    if (req.method === 'GET' && path === '/overview') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('events')) || 20))
      return json(200, buildOverview(store.state, { eventLimit: limit }))
    }

    // v1.2：单项目事务视图（会话标签页「调度台」的数据源）
    if (req.method === 'GET' && path === '/project') {
      const projectId = url.searchParams.get('projectId') || ''
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('events')) || 40))
      const view = buildProjectView(store.state, projectId, { eventLimit: limit })
      return json(view.ok ? 200 : 404, view)
    }

    // v1.2：按会话解析项目（绑定优先，其次 cwd 前缀匹配）
    if (req.method === 'GET' && path === '/session-project') {
      const sessionId = url.searchParams.get('sessionId') || ''
      if (!sessionId) return json(400, { ok: false, error: 'sessionId required' })
      const resolved = await host.resolveSessionProject(sessionId, url.searchParams.get('cwd') || null)
      return json(200, resolved)
    }

    // 看板事件流
    if (req.method === 'GET' && path === '/stream') {
      const lastId = Number(req.headers.get('last-event-id') || url.searchParams.get('since') || 0)
      const encoder = new TextEncoder()
      let closed = false
      let off = () => {}
      const stream = new ReadableStream({
        start(controller) {
          const send = (event) => {
            if (closed) return
            controller.enqueue(encoder.encode('id: ' + event.seq + '\nevent: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'))
          }
          for (const e of domain.eventsSince(lastId)) send(e)
          off = domain.subscribe((event) => {
            const seq = Number(String(event.id || '').replace(/\D/g, '')) || 0
            send({ ...event, seq })
          })
          controller.enqueue(encoder.encode(': connected\n\n'))
        },
        cancel() { closed = true; off() },
      })
      return new Response(stream, { status: 200, headers: sseHeaders })
    }

    // 会话聊天流（真实 DSH 会话的事件 → 工作台对话框）
    if (req.method === 'GET' && path === '/chat/stream') {
      const agentId = url.searchParams.get('agentId') || ''
      let sessionId = url.searchParams.get('sessionId') || ''
      const since = Number(url.searchParams.get('since') || req.headers.get('last-event-id') || 0)
      if (!sessionId && agentId) {
        const ens = await sessionFor(agentId)
        if (ens.ok) sessionId = ens.sessionId
      }
      if (!sessionId) return json(404, { ok: false, error: 'no session for ' + (agentId || 'request') })
      const encoder = new TextEncoder()
      const target = sessionId
      let closed = false
      let off = () => {}
      const stream = new ReadableStream({
        start(controller) {
          const send = (frame) => {
            if (closed) return
            controller.enqueue(encoder.encode('id: ' + frame.seq + '\nevent: chat\ndata: ' + JSON.stringify(frame) + '\n\n'))
          }
          send({ kind: 'meta', seq: 0, sessionId: target, agentId })
          for (const frame of chat.since(target, since)) send(frame)
          off = chat.subscribe((frame) => { if (frame.sessionId === target) send(frame) })
          controller.enqueue(encoder.encode(': connected\n\n'))
        },
        cancel() { closed = true; off() },
      })
      return new Response(stream, { status: 200, headers: sseHeaders })
    }

    // 返回代理自己的 DSH 会话；工作台 iframe 随后用客户端 openSession 渲染原生聊天。
    if (req.method === 'GET' && path.startsWith('/agent/') && path.endsWith('/session')) {
      const agentId = decodeURIComponent(path.slice('/agent/'.length, -'/session'.length))
      const result = host.runtime.agentSession ? await host.runtime.agentSession(agentId) : { ok: false, message: 'agent session unavailable' }
      return json(result.ok ? 200 : 404, result)
    }

    // DSH 里可见的会话（旧版会话选择器兼容）
    if (req.method === 'GET' && path === '/sessions') {
      const items = host.runtime.listSessions ? await host.runtime.listSessions() : []
      return json(200, { ok: true, items })
    }

    // 已有工作区（新建项目时选，不用手输路径）
    if (req.method === 'GET' && path === '/workspaces') {
      return json(200, { ok: true, items: host.listWorkspaces ? host.listWorkspaces() : [] })
    }

    // 任务详情（issue 页一次取全：任务 + 评论 + 运行 + 事件 + worktree + PR）
    if (req.method === 'GET' && path.startsWith('/task/')) {
      const taskId = decodeURIComponent(path.slice('/task/'.length))
      const detail = domain.taskDetail(taskId)
      if (!detail) return json(404, { ok: false, error: 'unknown task: ' + taskId })
      return json(200, { ok: true, ...detail })
    }

    if (req.method === 'GET' && path === '/health') {
      const projects = Object.values(store.state.projects)
      return json(200, {
        ok: true,
        version: 3,
        projects: projects.length,
        tasks: Object.keys(store.state.tasks).length,
        runs: Object.values(store.state.runs).filter((r) => r.status === 'running').length,
        worktrees: Object.keys(store.state.worktrees).length,
        pendingEvents: domain.pendingEvents(1000).length,
        at: new Date().toISOString(),
      })
    }

    if (req.method === 'GET' && path === '/events') {
      const projectId = url.searchParams.get('projectId') || null
      const limit = Number(url.searchParams.get('limit')) || 50
      const rows = store.state.event_inbox
        .filter((e) => !projectId || (e.payload && e.payload.projectId === projectId))
        .slice(-limit)
        .reverse()
      return json(200, { ok: true, items: rows, cursor: rows.length ? rows[0].seq : 0 })
    }

    if (req.method === 'GET' && path === '/worktrees') {
      return json(200, { ok: true, items: Object.values(store.state.worktrees), repo: Object.values(store.state.projects).map((p) => p.workspacePath) })
    }

    if (req.method === 'GET' && path.startsWith('/worker/') && path.endsWith('/log')) {
      const agentId = decodeURIComponent(path.slice('/worker/'.length, -'/log'.length))
      const limit = Number(url.searchParams.get('limit')) || 50
      const items = store.state.message_log.filter((m) => m.agentId === agentId).slice(-limit)
      return json(200, { ok: true, agentId, items })
    }

    if (req.method === 'POST' && path.startsWith('/hooks/')) {
      const source = path.slice('/hooks/'.length) || 'unknown'
      try {
        const raw = await readRaw(req)
        let body = {}
        try { body = raw ? JSON.parse(raw) : {} } catch { return json(400, { ok: false, error: 'bad json' }) }
        const headerObj = {}
        for (const [k, v] of req.headers.entries()) headerObj[k] = v
        const projectId = url.searchParams.get('projectId') || ''
        const repoName = body.repository && (body.repository.name || body.repository.full_name)
        const project = (projectId && store.state.projects[projectId]) ||
          Object.values(store.state.projects).find((p) => p.config && p.config.remote && (p.config.remote.repo === repoName || p.config.remote.repo === String(repoName || '').split('/').pop()))
        if (!project) return json(404, { ok: false, error: 'no project for this repo' })
        const secret = (project.config.remote && project.config.remote.webhookSecret) || ''
        const sig = headerObj['x-hub-signature-256'] || headerObj['x-gitea-signature'] || ''
        if (secret && !verifySignature(secret, raw, sig)) return json(401, { ok: false, error: 'bad signature' })
        const env = normalizeWebhook(source, headerObj, body)
        if (!env) return json(202, { ok: true, ignored: true })
        // C-09：webhook 是「刚发生的事」，必须绕过 since 守卫（票 §2 的明确要求）。
        // 不靠「信封里没有 createdAt」这种巧合来豁免 —— 那是实现细节，哪天 normalizeWebhook
        // 补了 created_at，新 issue 就会被 since 挡住。这里把意图显式写进 payload。
        env.payload = { ...env.payload, projectId: project.id, live: true }
        const res = await domain.ingest(env)
        if (res && res.ok === false && res.duplicate) return json(202, { ok: true, duplicate: true, dedupeKey: env.dedupeKey })
        return json(202, { ok: true, ingested: true, refKind: env.refKind, refId: env.refId })
      } catch (err) {
        return json(400, { ok: false, error: (err && err.message) || String(err) })
      }
    }

    if (req.method === 'POST' && path === '/action') {
      try {
        const body = await readJson(req)
        const action = String(body.action || '')
        const fn = actions[action]
        if (!fn) return json(404, { ok: false, error: 'unknown action: ' + action })
        const result = await fn(body.args || {})
        return json(200, { ok: true, result, state: domain.snapshot((body.args && body.args.projectId) || undefined) })
      } catch (err) {
        // 调试开关：DSH_FLOW_DEBUG=1 时把栈一起带回，方便定位"测试绿、线上炸"的调用点
        return json(400, {
          ok: false,
          error: (err && err.message) || String(err),
          stack: process.env.DSH_FLOW_DEBUG ? String(err && err.stack) : undefined,
        })
      }
    }

    return json(404, { ok: false, error: 'not found: ' + path })
  }
}
