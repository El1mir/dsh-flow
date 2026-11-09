/**
 * dsh-flow · tools
 *
 * 给调度员/工人会话用的工具。每个工具都先解析“当前 workspace 对应哪个项目”，
 * 解析不到就直接说清楚，不猜。
 */

import { sanitizeLossless } from './core.js'
// rf-04：visibility 的写入口只有一处（lib/http.js 的 setTaskVisibility），
// 浏览器点「拉上板」和模型调 flow_task_update 走的是同一个校验与同一类事件。
import { setTaskVisibility } from './http.js'
// v0.012：工单预设组件的文本摘要（给 flow_inbox_list 的输出用，不把整包 JSON 塞回模型上下文）
import { blocksToText } from './inbox-blocks.js'
// v1.39：拆分子卡要按同一套风险规则过预筛（低风险自动批、高风险等人）
import { assessPlanRisk, canAutoApprove } from './sync.js'

// 所有工具输出统一过一遍无损 JSON 清洗：内存态里残留的 undefined / NaN 会让 PTC 整条拒收
const ok = (message, extra = {}) => sanitizeLossless({ ok: true, message, ...extra })
/** 工具 output.render 必须返回 ContentBlock[]（DSH tools/index.ts:1839）；返回字符串会让 PTC 报 content.some is not a function */
const blocks = (s) => [{ type: 'text', text: String(s ?? '') }]
const fail = (message) => sanitizeLossless({ ok: false, message: String(message ?? '') })

const text = (label, value) => (value ? label + ': ' + value + '\n' : '')
const shortSha = (sha) => (sha ? String(sha).slice(0, 10) : '—')

function renderBoard(value) {
  const s = value && value.state
  if (!s) return String((value && value.message) || '')
  const lines = [String(value.message || '')]
  lines.push('列：' + s.columns.map((c) => c.title + '(' + c.count + ')').join(' · '))
  if (s.blockedCount) lines.push('阻塞：' + s.blockedCount)
  for (const t of s.tasks.slice(0, 20)) {
    lines.push('· [' + t.id + '] ' + t.title + ' — ' + t.effectiveColumn + (t.phase ? '/' + t.phase : '') + (t.assignee ? ' @' + t.assignee : ''))
  }
  return lines.join('\n')
}

/**
 * v1.38：评论质量闸。只拦明显没有信息量的（空话确认、超长日志），不做语义判断。
 * 返回拒绝原因；通过返回 ''。
 */
const FILLER_RE = /^(收到|好的?|ok|okay|明白|了解|开始(处理|执行|工作)?|我(来|先)?(看看|处理|开始)|继续|进行中|处理中|done|完成)[。.!！~～\s]*$/i
export function commentRejectReason(content) {
  const text = String(content == null ? '' : content).trim()
  if (!text) return '内容为空'
  if (FILLER_RE.test(text)) return '这是确认/寒暄，没有信息量。进度写 flow_task_progress；没有需要别人知道的事就不要发评论'
  if (text.length > 2000) return '超过 2000 字（当前 ' + text.length + '）。只留结论和关键证据，日志/输出给路径或命令，不要整段粘贴'
  return ''
}

export function buildTools(host) {
  const { domain, resolveProject } = host
  const flowMode = host.flowMode || null
  /** 换行常量：放进模板字符串会被转义搞乱，单列出来更稳。 */
  const NL = String.fromCharCode(10)
const dayTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d.getTime())) return String(iso).slice(0,16); return (d.getMonth()+1+'').padStart(2,'0')+'-'+(d.getDate()+'').padStart(2,'0')+' '+(d.getHours()+'').padStart(2,'0')+':'+(d.getMinutes()+'').padStart(2,'0') }

  /** 当前执行会话的 sessionId（工具调用永远发生在某个真实会话里）。 */
  const sessionIdOf = (exec) => {
    const header = exec && exec.agent && exec.agent.session && exec.agent.session.header
    return (header && header.id) || null
  }
  /** 迁移署名：chief 与 dispatcher 同一档权限；工人只能做角色允许的迁移（设计 4.3 禁止工人移动看板列）。 */
  const moveRoleOf = (exec) => {
    const role = roleOf(exec)
    return role === 'chief' ? 'dispatcher' : role
  }
  /** 评论署名：工人写的标 worker，调度员写的标 dispatcher，认不出来就按 dispatcher。 */
  const roleOf = (exec) => {
    const agent = domain.agentBySession(sessionIdOf(exec))
    return agent && agent.role ? agent.role : 'dispatcher'
  }

  /**
   * 写操作的署名。
   *
   * `id` 必须是**具体代理 id**（拿不到才退化成 sessionId）。
   * 以前这里写成 `{ role, id: role }`——id 是 'dispatcher' 这种角色字面量，
   * 于是事件驱动的"别通知自己"永远匹配不上（分不清是哪个调度员），
   * 调度员会被自己的操作反复叫醒，形成自激循环。
   */
  const actorOf = (exec) => {
    const sid = sessionIdOf(exec)
    const agent = domain.agentBySession(sid)
    return { role: roleOf(exec), id: agent ? agent.id : (sid || 'agent') }
  }

  /**
   * v1.37.1：调度只读探测节流。
   * 返回 null 表示放行；返回字符串表示应当拒绝并把这句作为失败原因返回。
   * 只对 dispatcher 生效 —— 工人查自己那张卡是正常工作，不该被限。
   */
  const probeGate = (exec) => {
    if (roleOf(exec) !== 'dispatcher') return null
    const agent = domain.agentBySession(sessionIdOf(exec))
    if (!agent) return null
    const cfg = (domain.store.state.projects[agent.projectId] || {}).config || {}
    const max = Number(cfg.maxProbePerWindow) > 0 ? Number(cfg.maxProbePerWindow) : 8
    const windowMs = Number(cfg.probeWindowMs) > 0 ? Number(cfg.probeWindowMs) : 5 * 60 * 1000
    const b = domain.probeBudget(agent.id, { max, windowMs })
    if (b.allowed) return null
    return '本轮已查看 ' + b.count + ' 次（上限 ' + b.max + ' 次 / ' + Math.round(b.windowMs / 60000) +
      ' 分钟）。没有新事件时反复查不会得到新信息：请结束本轮（不要再调工具），把要做的事写进 flow_task_progress 或 flow_task_comment，' +
      '下一个事件会自动叫醒你。需要人拍板就用 flow_ask_human。'
  }

  const withProject = async (exec, fn) => {
    const project = await resolveProject(exec)
    if (!project) return fail('无法从执行上下文确定工作区，请先在工作台创建项目')
    return fn(project)
  }

  return [
    {
      name: 'flow_board',
      description: '读取当前项目（workspace）的调度看板：列计数、任务、代理、待办阻塞项。动手前先读一次。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, state: { type: 'object' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(renderBoard(v)) },
      async execute(args, exec) {
        return withProject(exec, async (project) => ok('看板（' + project.name + '）', { state: domain.snapshot(project.id) }))
      },
    },
    {
      name: 'flow_task_create',
      description: '在当前项目新建一张任务卡（进“待办”列）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题（≤120 字；不传就建“未命名任务”，之后在详情页补）' },
          note: { type: 'string', description: '需求原文/背景（Markdown）' },
          acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准，每条一个可复现点' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: [],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, taskId: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          const task = await domain.createTask(project.id, args, { role: 'agent' })
          return ok('已创建 ' + task.id + '：' + task.title, { taskId: task.id })
        })
      },
    },
    {
      name: 'flow_task_move',
      description: '迁移任务列（claim / plan_ready / approve / approve_by_dispatcher / reject / stop / rework / accept / accept_partial / pr_open / review_approve / review_conflict / review_risk / rewind / cancel / reopen）。守卫不过会返回原因。**rewind 是回退**：把卡退回更早的列，payload 必须带 targetColumn（todo/planning/running/verifying/merging 中更早的一个）+ reason（写进历史）；被阻塞的卡也能回退（回退会清掉阻塞标记与上一轮停止报告）；有运行中的 run 时先让它停。已完成/已取消的卡不能用 rewind，用 reopen。人类闸门：approve / cancel / reopen 只接受人工（想重开用 flow_reopen_request 申请）。**accept_partial 是部分完成收口**（卡上有 stopReport.remaining 时用）：落 done-partial、剩余项留在卡上、不算交付；普通 accept 会拒这种卡。**accept 可以由调度代收**，但必须带 payload.acceptedBy = 一条**人已回复同意**的请示单 id（先 flow_ask_human 问，人在看板回复后用那条的 hi_ id；自己编的字符串会被拒）；headSha 不用填，系统自己从 worktree 的 HEAD 读。approve_by_dispatcher 是 human 车道的方案代批（低风险才可批）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          payload: { type: 'object', description: 'stopReport（可带 remaining 数组 = 还没做完的项）/ headSha（accept 不必填，系统自动读）/ acceptedBy（调度代收验收时：人已回复的请示单 id，hi_xxx）/ verdict / matched / summary / reason / targetColumn（rewind 专用：要退回哪一列）' },
        },
        required: ['id', 'action'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          try {
            // v1.26：代批前现算风险 —— 不信任 task.risk 上的旧值（方案可能改过）。
            // 高风险由 core 的 guard 拒掉，这里只负责把结论算准。
            if (args.action === 'approve_by_dispatcher') await domain.assessPlanRiskOf(args.id).catch(() => null)
            const task = await domain.move(args.id, args.action, actorOf(exec), args.payload || {})
            return ok(args.id + ' → ' + task.column + (task.phase ? '/' + task.phase : ''))
          } catch (err) {
            return fail(String(err.message || err))
          }
        })
      },
    },
    {
      name: 'flow_task_split_remainder',
      description: '把「部分完成」卡上的剩余项变成后续子卡（v0.016）：每项剩余变成一张子卡（挂在父卡下、不开分支、不进合并列），父卡落 done-partial。剩余项来自工人 stop 时填的 remaining。数量上限 8。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '父卡 id' } }, required: ['id'] },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          try {
            const res = await domain.splitRemainder(args.id, actorOf(exec))
            return ok('已把 ' + res.created.length + ' 项剩余拆成子卡：' + res.created.join('、') + '；' + args.id + ' → done/done-partial')
          } catch (err) {
            return fail(String(err.message || err))
          }
        })
      },
    },

    {
      name: 'flow_task_progress',
      description: '写入结构化进度快照（替代检查点评论）。每次写入会把旧值压入历史（最近 10 条），并清零 steer 计数。state: on-track 正常推进 / waiting 等待外部 / blocked 阻塞（同时设置 blocker）/ partial 部分完成 / done 本轮工作完成。evidence 只写 commit SHA、文件路径或命令名，不粘贴内容。调度员和工人都可以调用。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          state: { type: 'string', enum: ['on-track', 'waiting', 'blocked', 'partial', 'done'] },
          summary: { type: 'string', description: '≤120 字，一句话现状' },
          done: { type: 'array', items: { type: 'string' }, description: '≤5 条，本轮新完成的事，每条≤80字' },
          next: { type: 'string', description: '≤80 字，下一步' },
          blocker: { type: 'string', description: '≤120 字，阻塞原因；state=blocked 时必填' },
          evidence: { type: 'array', items: { type: 'object' }, description: '≤5 条，每条 {kind:"commit"|"file"|"test"|"url", ref:string}；ref≤200字，不粘贴内容' },
        },
        required: ['taskId', 'state', 'summary'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          const task = domain.store.state.tasks[args.taskId]
          if (!task) return fail('unknown task: ' + args.taskId)
          // 长度校验：超限时拒绝，不截断
          if (args.summary && String(args.summary).length > 120) return fail('summary 超过 120 字（' + String(args.summary).length + '字）')
          if (args.next && String(args.next).length > 80) return fail('next 超过 80 字（' + String(args.next).length + '字）')
          if (args.blocker && String(args.blocker).length > 120) return fail('blocker 超过 120 字（' + String(args.blocker).length + '字）')
          if (args.state === 'blocked' && !args.blocker) return fail('state=blocked 时必须填写 blocker')
          if (Array.isArray(args.done) && args.done.length > 5) return fail('done 最多 5 条，当前 ' + args.done.length + ' 条')
          if (Array.isArray(args.done)) for (const s of args.done) if (String(s).length > 80) return fail('done 中某条超过 80 字')
          if (Array.isArray(args.evidence) && args.evidence.length > 5) return fail('evidence 最多 5 条')
          if (Array.isArray(args.evidence)) for (const e of args.evidence) { if (String(e.ref || '').length > 200) return fail('evidence.ref 超过 200 字，请只写 SHA/路径/命令名') }
          const progress = await domain.setProgress(args.taskId, args, actorOf(exec))
          return ok('[' + args.state + '] ' + (args.summary || '') + (args.blocker ? ' ⛔ ' + args.blocker : ''))
        })
      },
    },
    {
      name: 'flow_task_plan',
      // v1.26：以前代理**根本没有写计划的工具** —— 调度建出卡、claim 进 planning 之后
      // 就永远走不下去（plan_ready 要求 plan 非空，approve 只有 human 能执行）。
      // 线上 T-035..T-039 五张卡就是这样卡死的。
      description: '写/改一张卡的计划（方案）。写进去会 rev+1，并自动按风险规则预筛：高风险标出来等人拍板，低风险可由调度用 flow_task_move(action="approve_by_dispatcher") 代批开工。写之前先看 flow_task_detail 里的需求与验收标准。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          text: { type: 'string', description: '计划正文（Markdown）：改什么、怎么改、怎么验证、风险是什么' },
        },
        required: ['taskId', 'text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            taskId: { type: 'string' },
            revision: { type: 'number' },
            riskLevel: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        try {
          // 注意 setPlan 返回的是 **task**（不是 plan 对象），revision 要从 plan 上取
          const saved = await domain.setPlan(args.taskId, args.text, actorOf(exec))
          const revision = (saved && saved.plan && saved.plan.revision) || 0
          // 写完立刻预筛风险：把判断结果当场告诉调度，省一次来回。
          const risk = await domain.assessPlanRiskOf(args.taskId).catch(() => null)
          const level = (risk && risk.level) || 'unknown'
          const why = (risk && (risk.reasons || []).join('；')) || ''
          const hint = level === 'high'
            ? '风险判定：高（' + why + '）—— 必须人工批准，不要自己代批。'
            : '风险判定：' + level + (why ? '（' + why + '）' : '') + '。可以 flow_task_move(action="plan_ready") 提交待批，再用 approve_by_dispatcher 代批开工。'
          return ok('已写入 ' + args.taskId + ' 的计划 rev ' + revision + '。' + hint, { taskId: args.taskId, revision, riskLevel: level })
        } catch (err) { return fail(String((err && err.message) || err)) }
      },
    },
    {
      name: 'flow_task_comment',
      description: '在任务下留评论。只写三类：需要对方回应的问题、已做出的决定及理由、结论性证据（SHA/路径/命令+一行结果）。进度写 flow_task_progress；不写寒暄确认、不贴日志、不复述需求。第一行写结论，Markdown 短列表展开，≤2000 字。',
      parameters: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string', description: 'Markdown；第一行是结论或问题，整条精简（建议 ≤600 字，上限 2000）' } }, required: ['id', 'content'] },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          const reason = commentRejectReason(args.content)
          if (reason) return fail('评论未记录：' + reason)
          const c = await domain.comment(args.id, String(args.content).trim(), actorOf(exec))
          return ok('评论已记录 ' + c.id)
        })
      },
    },
    {
      name: 'flow_task_comment_read',
      /**
       * v1.25：按偏移量分段读一条评论的**全文**。
       *
       * 为什么单开一个工具而不是把全文塞进 flow_task_detail：
       * 一份逐项审计报告可能几万字，一次性灌进上下文既贵又容易把上下文吃满；
       * 反过来在读取侧截断，模型就永远读不到后半段（原来的 200 字符预览 + 4000 存储上限
       * 就是双重截断，线上把子调度卡在"工单可读内容止于 spec 015"上）。
       * 分段读让模型自己决定"读多少、还看不看完"——这才是渐进式的正解。
       */
      description: '分段读长文本的全文：传评论 id（c_00082）读评论，传 plan:<taskId>（如 plan:T-012）读该卡的计划正文。先用 flow_task_detail 看索引/预览，再按 offset 一段段读；返回带 nextOffset/hasMore，读到 hasMore=false 才算读完。长报告（逐项审计、验收材料、完整计划）必须读全再下结论。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '评论 id（c_00082）或 plan:<taskId>（plan:T-012）' },
          offset: { type: 'number', description: '从第几个字符开始，默认 0' },
          limit: { type: 'number', description: '这一段读多少字符，默认 4000，上限 20000' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            commentId: { type: 'string' },
            chars: { type: 'number' },
            offset: { type: 'number' },
            nextOffset: { type: 'number' },
            hasMore: { type: 'boolean' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args) {
        const rawId = String(args.id || '')
        let text = ''
        let owner = null   // 用于展示"这是哪张卡的什么"
        // 计划也要能分段读：plan:<taskId>。计划是批准的依据，和评论同样可能几万字。
        if (rawId.startsWith('plan:')) {
          const taskId = rawId.slice(5)
          const task = domain.store.state.tasks[taskId]
          if (!task) return fail('unknown task: ' + taskId)
          if (!task.plan || !task.plan.text) return fail('这张卡还没有计划：' + taskId)
          text = String(task.plan.text)
          owner = taskId + '「' + String(task.title || '').slice(0, 40) + '」 的计划 rev ' + ((task.plan.revision) || 0)
        } else {
          // 评论 id 全局唯一（c_00082 这种），直接按 id 找，不需要 taskId。
          const c = (domain.store.state.task_comments || []).find((x) => x && x.id === rawId)
          if (!c) return fail('unknown text: ' + rawId + '（要读计划请传 plan:<taskId>）')
          text = String(c.content || '')
          const task = domain.store.state.tasks[c.taskId]
          owner = c.id + ' [' + c.role + ']' + (task ? ' · ' + task.id + '「' + String(task.title || '').slice(0, 40) + '」' : '')
        }
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.min(20000, Math.max(200, Number(args.limit) || 4000))
        const end = Math.min(text.length, offset + limit)
        const slice = text.slice(offset, end)
        const hasMore = end < text.length
        const head = rawId + ' · ' + owner + ' · 共 ' + text.length + ' 字符 · 本次 ' + offset + '–' + end +
          (hasMore ? ' · 还有 ' + (text.length - end) + ' 字符（nextOffset=' + end + '）' : ' · 已读完')
        const lines = [head, '', slice]
        // 注意：这里不能写成 nextOffset: hasMore ? end : text.length ——
        // test/tool-schema.mjs 的键名提取器会把三元里的 end 当成新键（它只看顶层字面量），
        // 于是报"返回值超出 schema"。先算成变量，payload 保持纯字面量。
        const nextOffset = hasMore ? end : text.length
        return ok(lines.join('\n'), {
          commentId: rawId, chars: text.length, offset, nextOffset, hasMore,
        })
      },
    },
    {
      name: 'flow_reopen_request',
      description: '申请重开一张已完成/已取消的卡（你不能直接重开，那是人的闸门）：写清为什么它其实没做完，理由会挂到卡上并在看板上显示，由人一键执行重开。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['taskId', 'reason'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          try {
            const t = await domain.requestReopen(args.taskId, args.reason, actorOf(exec))
            return ok('已申请重开 ' + t.id + '，等人在调度台上确认（理由已记进卡里）')
          } catch (err) {
            return fail(String(err.message || err))
          }
        })
      },
    },
    {
      name: 'flow_message',
      /**
       * v1.39：工人 ↔ 调度（以及调度 ↔ 需求评审）之间唯一的交接消息。
       *
       * 替代 goal 自循环：一轮做完一件事 → 发消息 → 立刻结束本轮。对方的回信会作为事件叫醒你。
       * 每条都记 message_log(kind=handoff)：系统靠它判断"工人这一轮汇报过没有"，
       * 没汇报的回合会被包装成 worker.turn-ended-silent 事件发给调度。
       */
      description: '给对方发一条交接消息，然后**立刻结束本轮等回信**（回信会作为事件叫醒你，不要轮询、不要 sleep、不要建 goal）。工人 → to="dispatcher"：需要决定/汇报结论/提问；调度 → to="worker"：下一步指令（工人没在跑时会带着这条消息重新派工）；调度 ↔ to="grill"：需求评审问答。做完了用 flow_task_move(stop)，卡住了用 flow_task_move(block)，不要用这个代替。内容规范同评论：第一行结论/问题，≤2000 字。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          to: { type: 'string', enum: ['dispatcher', 'worker', 'grill'], description: '收件人；不填时工人默认发给调度，调度默认发给工人' },
          kind: { type: 'string', enum: ['question', 'answer', 'instruction', 'report'], description: 'question=需要对方回答；answer=回答对方；instruction=下一步指令；report=结论汇报' },
          content: { type: 'string', description: 'Markdown；第一行是结论或问题' },
        },
        required: ['taskId', 'content'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          const reason = commentRejectReason(args.content)
          if (reason) return fail('消息未发送：' + reason)
          const task = domain.store.state.tasks[args.taskId]
          if (!task) return fail('unknown task: ' + args.taskId)
          const role = roleOf(exec)
          const to = args.to || (['worker', 'griller'].includes(role) ? 'dispatcher' : 'worker')
          if (['worker', 'griller'].includes(role) && to !== 'dispatcher') return fail('工人只能给调度员发消息（to="dispatcher"）')
          const handoffFn = host.dispatcher && host.dispatcher.handoff
          if (typeof handoffFn !== 'function') return fail('当前宿主不支持交接消息')
          const r = await handoffFn(task, { to, content: String(args.content).trim(), from: actorOf(exec).id, kind: args.kind || (['worker', 'griller'].includes(role) ? 'report' : 'instruction') })
          if (!r || !r.ok) return fail((r && r.message) || '投递失败')
          return ok((r.duplicate ? '同一条消息已投递过。' : '已投递（' + r.message + '）。') + '现在结束本轮，等待回信事件，不要轮询。')
        })
      },
    },
    {
      name: 'flow_reply',
      description: '把一条回信投回「发起这张卡的对话」——子调度/工人向主调度汇报用。不传 taskId 时投回当前会话。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' }, message: { type: 'string' } },
        required: ['message'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        // 回给谁：任务记的 originSessionId；没有就说明这张卡不是从对话发起的
        const task = args.taskId ? domain.store.state.tasks[args.taskId] : null
        if (args.taskId && !task) return fail('unknown task: ' + args.taskId)
        const sid = (task && task.originSessionId) || sessionIdOf(exec)
        if (!sid) return fail('没有可用的收件人（这张卡没有发起会话）')
        const text = '【回信】' + (task ? task.id + ' ' + (task.title || '') + '\n' : '') + String(args.message || '')
        const r = await host.runtime.promptSession(sid, text, 'steer', { origin: 'system' })
        domain.logMessage({ sessionId: sid, agentId: null, direction: 'out', origin: 'system', kind: 'reply', ok: !!r.ok, taskId: task ? task.id : null })
        return r.ok ? ok('已回信给发起对话（' + String(sid).slice(0, 16) + '）') : fail(r.message || '回信失败')
      },
    },
    {
      name: 'flow_worker_steer',
      description: '给正在跑的工人插一句话（mode=steer），不打断当前回合。工人只是慢或没有明显进展时：如果两次进度更新之间已经 steer 超过配置上限（默认 3 次），会被拒绝并提示改用 flow_task_move(block) 或 flow_ask_human。',
      parameters: { type: 'object', properties: { agentId: { type: 'string' }, message: { type: 'string' } }, required: ['agentId', 'message'] },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          // 查找该工人当前负责的任务，并检查 steer 计数。
          // v1.37.1 修：bumpSteer 是 async，原来漏了 await —— check 拿到的是 Promise，
          // check.allowed 恒为 undefined，上限从来没生效过（线上 steerCount 涨到 5 才被发现）。
          const task = Object.values(domain.store.state.tasks).find((t) => t && t.assignee === args.agentId && t.activeRunId)
          if (task) {
            const check = await domain.bumpSteer(task.id, args.agentId)
            if (!check.allowed) return fail(check.reason)
          }
          const r = await host.runtime.steer(project, args)
          return r.ok ? ok(r.message) : fail(r.message)
        })
      },
    },
    {
      name: 'flow_worker_reset',
      description: '重置工人对话：归档旧会话（stopActivity）→ 新建会话 → 绑定到该代理。代价高：上下文和前缀缓存全部丢失，会中断正在跑的 run。受项目配置 workerResetPolicy 约束：guarded（默认）时工人近期有活动会被拒绝，deny 时一律拒绝。工人只是慢，优先 flow_worker_steer。',
      parameters: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          // 人直接在会话里调也走工具，但这条工具主要是调度员在用；人在看板点重置走 agent.reset，不受这里约束。
          const guard = domain.resetGuard(args.agentId)
          if (!guard.allowed) return fail('未重置：' + guard.reason)
          const r = await host.runtime.resetSession(project, args.agentId)
          return r.ok ? ok(r.message) : fail(r.message)
        })
      },
    },
    {
      name: 'flow_pr_review',
      description: '对任务的合并请求给出审核结论。verdict=approved|needs_work|risk，matched 为命中的审核 prompt 项。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'needs_work', 'risk'] }, matched: { type: 'array', items: { type: 'object' } }, summary: { type: 'string' } },
        required: ['taskId', 'verdict'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          try {
            // v1.35：走 domain.review —— approved 只记结论不动卡（审核 ≠ 合并），署名用真实调度 id。
            const caller = actorOf(exec)
            const r = await domain.review(args.taskId, args.verdict, { matched: args.matched || [], summary: args.summary || '' }, { role: 'dispatcher', id: caller.id })
            const tail = r.next === 'merge' ? '，结论已记录，接下来 flow_pr_merge 合并（或等 autoMerge）' : ' → ' + r.task.column
            return ok(args.taskId + ' 审核 ' + r.verdict + tail)
          } catch (err) { return fail(String(err.message || err)) }
        })
      },
    },
    {
      name: 'flow_config',
      description: '读或改当前项目的调度配置（调度员/工人数量、巡检周期、并发上限）。',
      parameters: { type: 'object', properties: { patch: { type: 'object' } } },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, config: { type: 'object' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          if (args.patch && Object.keys(args.patch).length) {
            const p = await domain.updateProjectConfig(project.id, args.patch, { role: 'agent' })
            return ok('配置已更新', { config: p.config })
          }
          return ok('当前配置', { config: project.config })
        })
      },
    },
    {
      name: 'flow_pr_open',
      description: '把当前任务的 worktree 改动提交成 PR（pushRemote 打开时同时推送），生成 pull_requests 记录。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' }, message: { type: 'string', description: '提交信息' } },
        required: ['taskId'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, prId: { type: 'string' }, headSha: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          const task = domain.store.state.tasks[args.taskId]
          if (!task) return fail('unknown task')
          const res = await host.openPr(task, { message: args.message })
          if (!res.ok) return fail('开 PR 失败：' + (res.message || res.reason || '未知'))
          return ok('PR ' + res.pr.id + ' head ' + String(res.pr.headSha).slice(0, 8) + (res.commit.changed ? '（含新提交）' : '（无新改动）') + (res.pushed.ok ? '，已推送' : ''), { prId: res.pr.id, headSha: res.pr.headSha })
        })
      },
    },
    {
      name: 'flow_pr_merge',
      description: '合并事务：把 PR 分支合到 base（merge/squash/rebase）。冲突时自动回派原工人做软合并。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' }, strategy: { type: 'string', enum: ['merge', 'squash', 'rebase'] }, overrideOutOfScope: { type: 'boolean' } },
        required: ['taskId'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, conflict: { type: 'boolean' }, commit: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          const task = domain.store.state.tasks[args.taskId]
          if (!task) return fail('unknown task')
          const res = await host.merge(task, { strategy: args.strategy, by: 'agent', overrideOutOfScope: args.overrideOutOfScope === true })
          if (res.ok) return ok('已合并（' + (res.strategy || '') + ' ' + String(res.commit || '').slice(0, 8) + '）', { commit: res.commit })
          if (res.queued) return fail(res.message)
          if (res.outOfScope) return fail('越界改动拦下合并：' + (res.files || []).slice(0, 8).join(', ') + '（确需放行：带 overrideOutOfScope: true 再跑一次）')
          if (res.conflict) return sanitizeLossless({ ok: false, conflict: true, message: '合并冲突：' + ((res.files || []).join(', ') || '未知') + '，已回派软合并' })
          return fail('合并失败：' + (res.message || '未知'))
        })
      },
    },
    {
      name: 'flow_integration',
      description: '集成检出（合并的落地树）：查状态 / 释放。base 默认被它占住，主检出切到 base 会 fatal —— 想切先 release。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['status', 'release'] }, reason: { type: 'string' } },
        required: ['action'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, status: { type: 'object' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          const base = project.config.baseBranch || (await host.defaultBase(project))
          if (args.action === 'release') {
            const r = await host.releaseIntegration(project, { base })
            if (!r.ok) return fail('释放集成检出失败：' + (r.reason || r.message || 'unknown'))
            return ok(r.removed ? '集成检出已释放（base 现在可以正常检出）' : '当时没有集成检出，无需释放')
          }
          const st = await host.integrationStatus(project, { base })
          return ok(
            st.exists
              ? '集成检出在 ' + st.dir + '：' + (st.detached ? 'detached ' : '分支 ' + st.branch + ' ') + (st.clean ? '干净' : '有 ' + st.dirty.length + ' 个脏文件') + (st.locked ? '，已锁定' : '，未锁定') + '（base ' + base + '）'
              : '还没有集成检出（下次合并时创建，位置 ' + st.dir + '，base ' + base + '）',
            { status: st },
          )
        })
      },
    },
    {
      name: 'flow_worktree',
      description: '任务 worktree：create 建（或复用）、remove 删、list 查。git 不可用时降级到项目工作区。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['create', 'remove', 'list'] }, taskId: { type: 'string' } },
        required: ['action'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, path: { type: 'string' }, items: { type: 'array', items: { type: 'object' } } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          if (args.action === 'list') {
            const items = Object.values(domain.store.state.worktrees).filter((w) => w.projectId === project.id)
            return ok('worktree ' + items.length + ' 个', { items })
          }
          const task = domain.store.state.tasks[args.taskId]
          if (!task) return fail('unknown task')
          if (args.action === 'remove') {
            const res = await host.removeWorktree(task)
            return ok('已删除 worktree' + (res && res.ok ? '' : '（git 报错，已从状态里摘除）'))
          }
          const res = await host.ensureWorktree(task, project)
          return ok((res.reused ? '复用 ' : '已建 ') + (res.path || '-') + (res.ok ? '' : '（降级：' + (res.message || '') + '）'), { path: res.path })
        })
      },
    },
    {
      name: 'flow_worker_log',
      description: '读投递审计：谁给谁投了什么、成没成（message_log）。按 agentId 过滤。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string' }, limit: { type: 'number' } },
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, items: { type: 'array', items: { type: 'object' } } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          const blocked = probeGate(exec)
          if (blocked) return fail(blocked)
          const limit = Number(args.limit) || 20
          const items = domain.store.state.message_log
            .filter((m) => !args.agentId || m.agentId === args.agentId)
            .slice(-limit)
          const lines = items.map((m) => '· ' + m.at + ' ' + (m.kind || 'msg') + ' → ' + (m.agentId || '-') + (m.ok ? ' ok' : ' FAIL'))
          return ok('投递记录 ' + items.length + ' 条\n' + lines.join('\n'), { items })
        })
      },
    },
    {
      name: 'flow_worker_inject',
      description: '双车道共用的技能/上下文投递。skillName 按名称加载已安装技能（不做 allowedSkills 校验——白名单只决定哪些技能向 AI 暴露）；to=worker 或 grill（独立需求讨论工位）。运行中的工位立即 steer，未运行的 worker 在下次派工案卷接收。也兼容 content 文本注入。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          kind: { type: 'string', enum: ['skill', 'context', 'steer'] },
          content: { type: 'string', description: '补充说明；命名技能可省略' },
          skillName: { type: 'string', description: '已安装技能名称；不在 allowedSkills 里的技能也能按名加载，白名单只影响暴露目录' },
          to: { type: 'string', enum: ['worker', 'grill'] },
          agentId: { type: 'string' },
        },
        required: ['taskId'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, injectionId: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async () => {
          try {
            const task = domain.store.state.tasks[args.taskId]
            if (!task) return fail('unknown task: ' + args.taskId)
            const deliver = host.dispatcher && host.dispatcher.deliverInjection
            if (typeof deliver !== 'function') return fail('当前宿主不支持技能投递')
            const r = await deliver(task, { kind: args.skillName ? 'skill' : (args.kind || 'context'), content: args.content || '', skillName: args.skillName, agentId: args.agentId || null, to: args.to || 'worker' })
            if (!r || !r.ok) return fail((r && r.message) || '投递失败')
            return ok(r.message || '技能/上下文已投递', { injectionId: r.injectionId })
          } catch (err) { return fail(String(err.message || err)) }
        })
      },
    },
    {
      name: 'flow_issue_pending',
      description: '列出所有"卡在那儿等人拍板"的工单（issue 车道里待批准的、被阻塞的），默认只取前 50 条防止爆上下文。给人做方向总结前先调它。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          kind: { type: 'string', enum: ['all', 'approval', 'blocked'] },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            total: { type: 'number' },
            shown: { type: 'number' },
            truncated: { type: 'boolean' },
            items: { type: 'array', items: { type: 'object' } },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
          const kind = args.kind === 'approval' || args.kind === 'blocked' ? args.kind : 'all'
          const all = Object.values(domain.store.state.tasks).filter((t) => {
            if (!t || t.projectId !== project.id) return false
            if ((t.lane || 'human') !== 'issue') return false
            if (t.column === 'done' || t.column === 'cancelled') return false
            const awaiting = t.phase === 'waiting-approval'
            if (kind === 'approval') return awaiting
            if (kind === 'blocked') return !!t.blocked
            return awaiting || !!t.blocked
          })
          // 先按"最该先看"的排：被阻塞的排前面，然后按更新时间倒序
          all.sort((a, b) => {
            const ab = a.blocked ? 1 : 0
            const bb = b.blocked ? 1 : 0
            if (ab !== bb) return bb - ab
            return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
          })
          const shown = all.slice(0, limit)
          const lines = ['待拍板的工单：共 ' + all.length + ' 条' + (all.length > shown.length ? '（只列前 ' + shown.length + ' 条）' : '')]
          for (const t of shown) {
            const why = t.blocked ? '阻塞：' + String(t.blocked.reason || '').slice(0, 80)
              : (t.phase === 'waiting-approval' ? '待批准方案 rev ' + ((t.plan && t.plan.revision) || 0) : t.phase || '')
            lines.push('  ' + t.id + ' ' + String(t.title || '').slice(0, 60) + ' —— ' + why)
          }
          if (!shown.length) lines.push('  （没有待拍板的工单）')
          if (all.length > shown.length) lines.push('', '还有 ' + (all.length - shown.length) + ' 条没列出来；要看得更全就调大 limit，或先按 kind 过滤。')
          lines.push('', '下一步：可以让我按方向归类总结，你挑要批的那些；批准用 flow_task_move(taskId, approve)。')
          return ok(lines.join('\n'), {
            total: all.length,
            shown: shown.length,
            truncated: all.length > shown.length,
            items: shown.map((t) => ({
              taskId: t.id,
              title: t.title,
              column: t.column,
              phase: t.phase || '',
              blocked: !!t.blocked,
              reason: t.blocked ? t.blocked.reason : '',
              planRev: (t.plan && t.plan.revision) || 0,
            })),
          })
        })
      },
    },
    {
      name: 'flow_issue_sync',
      description: '把项目的远程 issue/PR（Gitea/GitHub）拉一次：镜像 + 事件 + 游标同一事务。',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, pulled: { type: 'number' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          // v1.23：优先走同步引擎（marker 过滤 + 出站 + 评论）；引擎不可用时才退回老的拉取路径。
          const run = host.runSync || ((p) => host.syncProject({ domain, project: p }))
          const res = await run(args.projectId ? domain.store.state.projects[args.projectId] : project)
          if (!res || res.ok === false) return fail('同步失败：' + ((res && (res.reason || res.skipped)) || '未知'))
          const ap = res.applied || res.stats || {}
          const bits = []
          if (ap.issues) bits.push('入站 ' + ap.issues)
          if (ap.tasks) bits.push('建卡 ' + ap.tasks)
          if (typeof res.pulled === 'number') bits.push('拉 ' + res.pulled + ' 条')
          if (Array.isArray(res.notes) && res.notes.length) bits.push(res.notes.join('；'))
          return ok('同步完成：' + (bits.join('，') || '没有变化'), { pulled: res.pulled || ap.issues || 0 })
        })
      },
    },
    // ---- v1.0：调度模式 / 阅读范围 / 车道 / 改派 / 预算 / 巡检 --------------
    {
      name: 'flow_publish',
      description: '在 /flow 调度模式里发布一张大 issue：建任务 + 写计划 + 交给车道子调度。发布后自动退出只读模式。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题（对应 issue 标题）' },
          plan: { type: 'string', description: '完整规划（markdown），会作为 plan.revision=1 落库并等待人类批准' },
          note: { type: 'string', description: '需求正文 / 背景）' },
          acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准，每条一个可复现点' },
          scope: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } } },
            description: '阅读范围：paths 是文件/目录前缀，symbols 是函数/类/表名',
          },
          subtasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, scope: { type: 'object' } },
            },
            description: '拆解出的子任务（留在同一张卡内）',
          },
          lane: { type: 'string', enum: ['human', 'issue'], description: '车道，默认 human' },
        },
        required: ['title', 'plan'],
      },
      // 注意：schema 声明了 additionalProperties: false —— 返回里多一个键 Host 就会整次拒掉
      // （线上就报过 "value.column is not a declared property"：任务已经建好，但调用返回失败）。
      // 所以这里列全 execute 会返回的每个字段。
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            taskId: { type: 'string' },
            column: { type: 'string' },
            phase: { type: 'string' },
            dispatched: { type: 'boolean' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          const { validatePublishInput } = host.flowCommand || {}
          const check = validatePublishInput
            ? validatePublishInput(args)
            : { ok: true, value: args }
          if (!check.ok) return fail(check.message)
          const v = check.value
          try {
            // v1.35：署名用真实调用方。原来建卡/批准都写 { role:'human', id:'flow-publish' } ——
            // 模型调用以人的身份过了人行闸门。发布者只能是调度/主调度。
            const caller = actorOf(exec)
            if (caller.role === 'worker') return fail('工人不能发布任务：flow_publish 是调度模式的出口')
            const publisher = { role: caller.role === 'chief' ? 'chief' : 'dispatcher', id: caller.id }
            const publishedFrom = sessionIdOf(exec) || caller.id
            const task = await domain.createTask(project.id, {
              title: v.title,
              note: v.note,
              acceptance: v.acceptance,
              scope: v.scope,
              subtasks: v.subtasks,
              lane: args.lane === 'issue' ? 'issue' : 'human',
              origin: 'manual',
            }, publisher)
            await domain.setPlan(task.id, v.plan, publisher)
            await domain.assessPlanRiskOf(task.id).catch(() => null)
            await domain.move(task.id, 'claim', { role: 'dispatcher', id: publisher.id }).catch(() => null)
            // 手交给车道子调度：有 dispatcher 就写交付包并标记 dispatched，没有就留 todo 等人认领
            const sup = domain.supervisorOf(project.id, task.lane || 'human')
            if (sup) {
              await domain.move(task.id, 'plan_ready', { role: 'dispatcher', id: sup.id }).catch(() => null)
              await domain.handoffTask(task.id, { to: sup.id, notes: 'flow_publish 发布' }, publisher).catch(() => null)
            }
            // 发布 = 用户在对话里确认了方案：走 approve_by_publish（不冒充人工 approve），
            // 派工由迁移的副作用完成 —— 这里**不再**自己再派一次（原来会派两次，第二次撞 activeRunId，
            // 返回「暂未派出」误导人）。高风险方案会被守卫拦在待批准。
            let dispatchNote = ''
            if (sup) {
              const approved = await domain.move(task.id, 'approve_by_publish', publisher, { publishedFrom })
                .catch((err) => ({ refused: String((err && err.message) || err) }))
              if (approved && approved.refused) {
                dispatchNote = '，未开工：' + approved.refused
                // 停在待批准就必须让人知道（否则人以为「发布即开工」已经开工了）
                await domain.askHuman({
                  taskId: task.id,
                  kind: 'risk',
                  topic: '发布的方案等你批准：' + task.id + ' ' + String(v.title || '').slice(0, 60),
                  problem: approved.refused,
                  decisionNeeded: '看一遍方案，批准开工还是要求改？',
                  where: task.id + ' 在 planning（发布自会话 ' + publishedFrom + '）',
                  suggestion: '没问题就在看板上点「批准」；有顾虑就在卡上评论要改哪里。',
                }, publisher).catch(() => null)
              } else {
                const fx = domain.lastEffectOf(task.id, 'approve_by_publish')
                const r = (fx && fx.result) || {}
                if (fx && fx.status === 'done' && r.ok && !r.waiting) {
                  const agentId = r.agentId || domain.store.state.tasks[task.id].assignee
                  dispatchNote = '，已派给 ' + ((domain.store.state.agents[agentId] && domain.store.state.agents[agentId].name) || agentId || '工人')
                } else {
                  dispatchNote = '，暂未派出（' + (r.message || (fx && fx.lastError) || (fx ? fx.status : '宿主没有派工运行时')) + '）'
                }
              }
            }
            // 退出只读模式（若在模式内）
            const sid = sessionIdOf(exec)
            if (host.flowMode && sid) host.flowMode.exit(sid)
            const finalState = domain.store.state.tasks[task.id]
            return ok('已发布 ' + task.id + '「' + v.title + '」（' + finalState.column + '/' + (finalState.phase || '-') + (sup ? '，已交给 ' + sup.name : '，等待认领') + dispatchNote + '）', { taskId: task.id, column: finalState.column, phase: finalState.phase || '', dispatched: !!finalState.activeRunId })
          } catch (err) { return fail(String(err.message || err)) }
        })
      },
    },
    {
      name: 'flow_task_detail',
      description: '读一张卡的全部细节：任务的列/阶段/计划/失败证据，加上评论、run 记录、worktree、PR、注入材料。开工前、验收前、判 read 结论前都先调它——只看看板摘要会漏掉工人写的评论和停止报告。',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            detail: { type: 'object' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        const blocked = probeGate(exec)
        if (blocked) return fail(blocked)
        const detail = domain.taskDetail(args.taskId)
        if (!detail) return fail('unknown task: ' + args.taskId)
        const t = detail.task
        // v1.25：评论不在这里整段返回，只给**索引**（谁、多长、第一行）。
        //
        // 原来的做法是「最后 8 条 + 每条 200 字符」，两层都会丢内容：
        // 存储侧 clampText(4000) 先砍一次，这里再砍到 200 —— 模型永远读不到全貌。
        // 线上真实事故：c_00082 正好 4000 字符、止于 spec 015 中途，子调度复核时
        // 只能打回让人重写（而原文早就被 clamp 掉了，重写也补不回）。
        // 现在改成渐进式：这里给索引，要看全文用 flow_task_comment 按 offset/limit 分段取，
        // 读多少、读哪条由模型自己决定。
        const firstLine = (c) => String(c.content || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
        const lines = [
          t.id + '「' + t.title + '」 ' + t.column + '/' + (t.phase || '-') + ' · v' + (t.version || 0),
          '负责人：' + (t.assignee || '—') + ' · 计划 rev ' + ((t.plan && t.plan.revision) || 0) + (t.plan && t.plan.approvedRevision ? '（已批 rev ' + t.plan.approvedRevision + '）' : ''),
          t.blocked ? '阻塞：' + t.blocked.reason : '',
          // v1.37：结构化进度 + 逐项验收状态（替代散落的检查点评论）
          t.progress
            ? ('进度 [' + t.progress.state + '] ' + (t.progress.summary || '') +
               (t.progress.blocker ? ' ⛔ ' + t.progress.blocker : '') +
               (t.progress.next ? ' → ' + t.progress.next : '') +
               (t.progress.updatedAt ? '（更新于 ' + dayTime(t.progress.updatedAt) + '）' : ''))
            : '',
          (() => {
            const acc = Array.isArray(t.acceptance) ? t.acceptance : []
            const st = (t.stopReport && Array.isArray(t.stopReport.acceptanceStatus)) ? t.stopReport.acceptanceStatus : []
            if (!acc.length) return ''
            const pass = st.filter((x) => x && x.status === 'pass').length
            const missing = acc.length - st.length
            return '验收 ' + pass + '/' + acc.length + ' 通过' +
              (st.length ? '（' + st.map((x) => (x.index + 1) + ':' + x.status).join(' ') + '）' : '') +
              (missing > 0 ? '，还有 ' + missing + ' 项没报状态' : '')
          })(),
          t.inspection ? '巡检：' + t.inspection.verdict + ((t.inspection.reasons || []).length ? ' · ' + t.inspection.reasons.join('；') : '') : '',
          '',
          // v1.25：计划正文以前在 message 里完全没输出（只有 rev 号），
          // 而"批准方案"恰恰要读全文 —— 复核意见里「plan rev 1 仍是阶段性核查方向」
          // 有一半是"批准者根本没看到完整计划"造成的。这里给正文 + 超长时的读全指引。
          (t.plan && t.plan.text)
            ? ('【计划 rev ' + ((t.plan.revision) || 0) + '】\n' +
               String(t.plan.text).slice(0, 6000) +
               (String(t.plan.text).length > 6000
                 ? '\n…（计划共 ' + String(t.plan.text).length + ' 字符，上面只显示前 6000。读全文：flow_task_comment_read({ id: "plan:' + t.id + '" }) 按 offset 分段读。）'
                 : ''))
            : '（还没有计划）',
          '',
          '评论 ' + detail.comments.length + ' 条（全文用 flow_task_comment_read 分段读，别只凭预览下判断）：',
          ...detail.comments.slice(-30).map((c) => '  ' + c.id + ' [' + c.role + '] ' + String(c.content || '').length + ' 字符 · ' +
            (c.at ? String(c.at).slice(5, 16).replace('T', ' ') + ' · ' : '') + firstLine(c).slice(0, 90)),
          detail.comments.length > 30
            ? '  …还有 ' + (detail.comments.length - 30) + ' 条更早的没列出来（同一条 id 仍可用 flow_task_comment_read 读；完整列表在各卡的「讨论」区）。'
            : '',
          '',
          'run ' + detail.runs.length + ' 条：',
          ...detail.runs.slice(-5).map((r) => '  ' + r.status + ' · ' + (r.stopReason || '—')),
          detail.worktree ? 'worktree: ' + (detail.worktree.branch || detail.worktree.path) : '',
          detail.pullRequest ? 'PR: ' + detail.pullRequest.status + ' · ' + shortSha(detail.pullRequest.headSha) : '',
        ].filter(Boolean)
        // 索引也进 detail，但内容只留预览 + 字符数（前端自己有完整 comments，不受影响）
        const commentIndex = detail.comments.map((c) => ({
          id: c.id, role: c.role, author: c.author, at: c.at,
          chars: String(c.content || '').length,
          preview: firstLine(c).slice(0, 160),
        }))
        return ok(lines.join('\n'), { detail: { task: t, commentIndex, runs: detail.runs, worktree: detail.worktree, pullRequest: detail.pullRequest } })
      },
    },
    {
      name: 'flow_task_update',
      description: '改一张卡的标题/描述/验收标准/优先级/阅读范围/可见性。工人补验收点、调度员补充需求都走它；不要用 flow_task_move 干这个（那是迁移，会过状态机守卫）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          title: { type: 'string' },
          note: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          visibility: { type: 'string', enum: ['board', 'auto'], description: 'board=上板（人看得见）；auto=只在自动车道视图里出现，自动车道的卡不上看板' },
        },
        required: ['taskId'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' }, taskId: { type: 'string' } },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        const patch = {}
        for (const key of ['title', 'note', 'acceptance', 'priority']) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        // visibility 不走 updateTask（它只收内容字段），走唯一的写入口 setTaskVisibility。
        const wantsVisibility = args.visibility !== undefined
        const fields = Object.keys(patch)
        if (!fields.length && !wantsVisibility) return fail('没有要改的字段（title/note/acceptance/priority/visibility 至少给一个）')
        const actor = { role: roleOf(exec), id: sessionIdOf(exec) || 'agent' }
        try {
          let taskId = args.taskId
          if (wantsVisibility) taskId = (await setTaskVisibility(domain, args.taskId, args.visibility, actor)).id
          if (fields.length) taskId = (await domain.updateTask(args.taskId, patch, actor)).id
          return ok('已更新 ' + taskId + '：' + fields.concat(wantsVisibility ? ['visibility'] : []).join('、'), { taskId })
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_task_split',
      /**
       * v1.39：把一张大卡拆成若干子卡（工作包）。
       *
       * 拆卡的三个理由：
       *   1. 一张卡同一时间只能有一个 run —— 不拆就永远只有一个工人在干；
       *   2. 子卡各自有自己的 worktree / 验收 / 合并，冲突面小；
       *   3. 每个工作包都带结构化八问的字段，派工、打分、验收都按字段走。
       */
      description: '把一张卡拆成 2–8 张子卡（工作包），让多个工人并行。每项必须写清结构化八问里可执行的那几栏：purpose（修改目的）、scope（修改范围 paths/symbols）、effect（生效域）、acceptance（验收范围 ≥1 条）。建议同时给 current（现状与代码位置）、outOfScope（不改什么）、testCmd、risk、rollback、dependsOn（同批序号，从 1 数）。兄弟项修改范围重叠时必须用 dependsOn 声明先后，否则会被拒（两个工人改同一片代码必然打架）。拆完子卡会按风险规则自动批准：低风险直接派工，高风险进待批等人。父卡此后只做汇总，不再派工，全部子卡完成后自动进待验收。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          reason: { type: 'string', description: '为什么这么拆（进父卡拆分表）' },
          items: {
            type: 'array',
            description: '2–8 个工作包',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '子卡标题（≤120 字）' },
                purpose: { type: 'string', description: '修改目的：为什么改（≤500 字）' },
                current: { type: 'string', description: '现状：相关代码在哪、现在什么行为（≤800 字）' },
                scope: {
                  type: 'object',
                  description: '修改范围',
                  properties: { paths: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } } },
                },
                outOfScope: { type: 'string', description: '不改什么（相邻模块的明确排除）' },
                effect: { type: 'string', description: '生效域：影响到谁（调用方/接口/配置/用户可见行为）' },
                acceptance: { type: 'array', items: { type: 'string' }, description: '验收范围：每条一个可复现点（≥1 条）' },
                testCmd: { type: 'string', description: '验证命令（如 npm test / pytest -k xxx）' },
                risk: { type: 'string', description: '风险' },
                rollback: { type: 'string', description: '怎么回滚' },
                dependsOn: { type: 'array', items: { type: 'number' }, description: '同批序号（从 1 数），必须等它们完成才能派工' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                sources: { type: 'object', description: '每项是谁补的：{purpose:"auto"|"grill"|"human", ...}' },
              },
              required: ['title', 'purpose', 'scope', 'effect', 'acceptance'],
            },
          },
        },
        required: ['taskId', 'items'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            children: { type: 'array', items: { type: 'object' } },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          const actor = actorOf(exec)
          let res
          try {
            res = await domain.splitTask(args.taskId, { reason: args.reason || '', items: args.items }, actor)
          } catch (err) {
            return fail(String((err && err.message) || err))
          }
          // 子卡按风险规则过预筛：低风险自动批准并派工，高风险进待批（scheduler 会写进 Inbox）
          const outcomes = []
          for (const child of res.children) {
            const risk = assessPlanRisk(child.plan ? child.plan.text : '', child, project)
            await domain.setTaskRisk(child.id, risk, actor).catch(() => null)
            if (canAutoApprove(risk, project)) {
              await domain.move(child.id, 'approve_by_publish', { role: 'system', id: 'system:risk-auto' }, { reason: '拆分后风险预筛通过（' + risk.level + '）' }).catch((err) => {
                outcomes.push(child.id + ' 自动批准失败：' + String((err && err.message) || err))
              })
              outcomes.push(child.id + ' 低风险 → 已自动批准')
            } else {
              await domain.move(child.id, 'plan_ready', { role: 'dispatcher', id: actor.id || 'dispatcher' }).catch(() => null)
              outcomes.push(child.id + ' 风险 ' + risk.level + ' → 待批')
            }
          }
          const ids = res.children.map((c) => c.id)
          domain.logMessage({ direction: 'out', origin: 'agent', kind: 'split', ok: true, taskId: args.taskId, agentId: actor.id, detail: { children: ids } })
          return ok('已拆成 ' + ids.length + ' 张子卡：' + ids.join('、') + '\n' + outcomes.join('\n') +
            '\n子卡在父卡详情里看和打开；父卡不再派工，全部子卡完成后自动进待验收。现在结束本轮，子卡的事件会叫醒你。',
          { children: res.children.map((c) => ({ id: c.id, title: c.title, dependsOn: c.dependsOn })) })
        })
      },
    },
    {
      name: 'flow_grill_start',
      description: '把八问草稿交给「需求评审」工位挑毛病（消息驱动：投递后结束本轮，评审的回信会作为事件叫醒你）。评审会按设计树逐轮提问，每轮给推荐答案。什么时候用：要拆成 ≥2 张子卡、或八问里有你答不准的栏（现状/生效域/回滚）。简单单卡不用评审，直接 flow_task_plan。轮数上限由项目配置 grillMaxRounds（默认 4）决定。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          draft: { type: 'string', description: '八问草稿 + 拆分草稿（Markdown）：每项写你目前填到的值，空着的直接写"不确定"' },
          reason: { type: 'string', description: '为什么需要评审（例如"影响 3 个模块，不确定范围"）' },
        },
        required: ['taskId', 'draft'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        const task = domain.store.state.tasks[args.taskId]
        if (!task) return fail('unknown task: ' + args.taskId)
        const fn = host.dispatcher && host.dispatcher.grillStart
        if (typeof fn !== 'function') return fail('当前宿主不支持需求评审')
        const r = await fn(task, { draft: args.draft, reason: args.reason || '' })
        if (!r || !r.ok) return fail((r && r.message) || '评审启动失败')
        return ok('已交给需求评审（第 ' + r.round + '/' + r.maxRounds + ' 轮）。现在结束本轮：评审的问题会作为事件叫醒你。')
      },
    },
    {
      name: 'flow_grill_verdict',
      description: '需求评审给出结论（只有评审工位该调）。settled = 没有剩余问题，调度可以直接 flow_task_split；escalate = 有必须人定的事，必须写 openForHuman（≥1 项），调度据此走 flow_ask_human。到轮数上限必须给结论。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          verdict: { type: 'string', enum: ['settled', 'escalate'] },
          settled: { type: 'array', items: { type: 'string' }, description: '已经确定下来的关键决定（调度直接照做）' },
          openForHuman: { type: 'array', items: { type: 'object' }, description: 'escalate 时必填：[{question, why, recommendation}]' },
          note: { type: 'string', description: '一句结论说明' },
        },
        required: ['taskId', 'verdict'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args) {
        const task = domain.store.state.tasks[args.taskId]
        if (!task) return fail('unknown task: ' + args.taskId)
        const fn = host.dispatcher && host.dispatcher.grillVerdict
        if (typeof fn !== 'function') return fail('当前宿主不支持需求评审')
        const r = await fn(task, { verdict: args.verdict, settled: args.settled || [], openForHuman: args.openForHuman || [], note: args.note || '' })
        if (!r || !r.ok) return fail((r && r.message) || '结论落库失败')
        return ok(args.verdict === 'settled'
          ? '评审结论已落库：没有剩余问题，调度可以直接拆分。'
          : '评审结论已落库：' + r.openForHuman + ' 项需要人决定，调度会写进 Inbox。')
      },
    },
    {
      name: 'flow_task_handoff',
      description: '把计划定稿的卡交接给车道子调度（写交付包 + 阶段标 dispatched）。交接前必须已有 plan（rev>0 且非空）。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' }, to: { type: 'string' }, notes: { type: 'string' } },
        required: ['taskId'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' }, planRev: { type: 'number' } },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        try {
          const pk = await domain.handoffTask(args.taskId, { to: args.to || 'dispatcher', notes: args.notes || '' }, { role: 'chief', id: actorOf(exec).id })
          return ok('已交接 ' + args.taskId + '（plan rev ' + pk.planRev + '）' + (pk.warning ? '；' + pk.warning : ''), { planRev: pk.planRev })
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_review_prompt',
      description: '读当前项目的审核判据集（每条含 id/name/prompt/severity/version）。开 PR 后要按这套判据审核，不要凭感觉给 verdict。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' }, prompts: { type: 'array', items: { type: 'object' } } },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          const set = domain.reviewPromptSet(project.id)
          const items = (set && set.prompts) || []
          const lines = ['审核判据 set v' + ((set && set.version) || 0) + '（' + items.length + ' 条）']
          for (const p of items) lines.push('  [' + p.severity + '] ' + p.name + '：' + String(p.prompt).replace(/\n/g, ' ').slice(0, 120))
          return ok(lines.join('\n'), { prompts: items })
        })
      },
    },
    {
      name: 'flow_workspace_list',
      description: '列出可以建成项目的 DSH 工作区（路径 + 标题 + 是否已有项目）。新建项目、找不到项目时先读它，别手猜路径。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' }, items: { type: 'array', items: { type: 'object' } } },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute() {
        const items = await host.listWorkspaces()
        const lines = ['工作区 ' + items.length + ' 个：']
        for (const w of items) {
          lines.push('  ' + (w.projectId ? '✓ ' : '  ') + (w.title || w.path) + ' → ' + w.path + (w.projectId ? '（已有项目）' : '（还没建项目，可 project_ensure）'))
        }
        if (!items.length) lines.push('  （DSH 里还没有工作区：先把目录加成工作区，或在调度台按路径建项目）')
        return ok(lines.join('\n'), { items })
      },
    },
    {
      name: 'flow_task_remove',
      description: '删除一条任务及其评论/run/审批/租约记录（数据清理用；不要手改 flow.json，会被内存态覆盖）。',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args) {
        try {
          const r = await domain.removeTask(args.taskId, { role: 'human', id: 'agent' })
          return ok('已删除任务 ' + r.taskId)
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_scope_set',
      description: '设置/修正任务的阅读范围（决定会被派给哪个工人：同域优先）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskId'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        if (!args.taskId) return fail('缺少 taskId')
        try {
          const t = await domain.setScope(args.taskId, { paths: args.paths || [], symbols: args.symbols || [] }, { role: 'dispatcher', id: sessionIdOf(exec) || 'agent' })
          return ok('已更新 ' + t.id + ' 的阅读范围：' + t.scope.paths.length + ' 个路径 / ' + t.scope.symbols.length + ' 个符号')
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_lane',
      description: '查看/调整项目车道（human=人直派，issue=自动接单）：不传参就是读。',
      parameters: {
        type: 'object',
        properties: {
          lane: { type: 'string', enum: ['human', 'issue'] },
          dispatchers: { type: 'number' },
          workers: { type: 'number' },
        },
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        return withProject(exec, async (project) => {
          try {
            if (args.lane && (args.dispatchers !== undefined || args.workers !== undefined)) {
              const cur = domain.lanesOf(project.id)
              const target = args.lane === 'issue' ? 'issue' : 'human'
              await domain.ensureLaneAgents(project.id, target, {
                dispatchers: args.dispatchers !== undefined ? Number(args.dispatchers) : cur[target].dispatchers,
                workers: args.workers !== undefined ? Number(args.workers) : cur[target].workers,
              }, { role: 'human', id: 'agent' })
            }
            const lanes = domain.lanesOf(project.id)
            const fmtLane = (k) => k + ': 调度 ' + lanes[k].dispatchers + ' / 工人 ' + lanes[k].workers +
              '（在跑 ' + domain.workersOf(project.id, k).length + ' 个工位）'
            return ok('车道配置\n- ' + fmtLane('human') + '\n- ' + fmtLane('issue'))
          } catch (err) { return fail(String(err.message || err)) }
        })
      },
    },
    {
      name: 'flow_agent_reparent',
      description: '改派代理的上级（T20）：把某个 worker 换到另一个子调度名下。只传 agentId 就是看当前关系。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string' }, supervisorId: { type: 'string' } },
        required: ['agentId'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args) {
        const agent = domain.store.state.agents[args.agentId]
        if (!agent) return fail('unknown agent: ' + args.agentId)
        if (args.supervisorId === undefined) {
          const sup = agent.supervisorId ? domain.store.state.agents[agent.supervisorId] : null
          return ok(agent.name + '（' + agent.role + '/' + (agent.lane || 'human') + '）的上级：' + (sup ? sup.name + '（' + sup.id + '）' : '无'))
        }
        try {
          const moved = await domain.reparent(agent.id, args.supervisorId || null, { role: 'human', id: 'agent' })
          const sup = moved.supervisorId ? domain.store.state.agents[moved.supervisorId] : null
          return ok('已把 ' + moved.name + ' 改派给 ' + (sup ? sup.name : '（无上级）'))
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    // v1.37：flow_budget 已移除，水位由 DSH 宿主管理
    {
      name: 'flow_inspect',
      description: '落巡检结论（keep/steer/pause/reset/done/blocked）：工人在自停后由子调度判定并写回。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          verdict: { type: 'string', enum: ['keep', 'steer', 'pause', 'reset', 'done', 'blocked'] },
          reasons: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskId', 'verdict'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args) {
        try {
          const t = await domain.setInspection(args.taskId, args.verdict, args.reasons || [], { role: 'dispatcher', id: 'agent' })
          return ok('已记录 ' + t.id + ' 巡检结论：' + t.inspection.verdict)
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_ask_human',
      /**
       * v1.31：调度遇到需要人拍板的事 → 写一条结构化请示到人的收件箱。
       *
       * 为什么不用评论：评论是讨论区，进度、证据、闲聊都混在里面，真正需要人做决定的
       * 那一条会被埋掉。请示是**待办**：有状态、有回复、能归档。
       *
       * 四段结构是硬要求（缺了发不出去）—— 只写「我遇到问题了」，人还得反问三轮才知道要干嘛。
       */
      description: '向人请示：写一条结构化工单到 Inbox，人在看板分区填写后，你判断阻塞消除就用 flow_inbox_resolve 归档并继续。必填 topic + problem（问题/分歧）+ decisionNeeded（要人决定什么）+ **asks**（要人补充的每一项）。asks 每项 {key, question（问什么）, why（为什么必须人来答）, type: choice|text|confirm|number, choices:[{value,label,impact}]（choice 必填 ≥2 个）, default（你的推荐答案）, defaultReason（为什么推荐）, required, blocks（答不了会卡住什么）}，最多 6 项。建议同时给 context.facts（现状事实）、context.evidence（[{kind:"commit"|"file"|"test"|"url", ref}]）、impactIfNoAnswer（不答会怎样）。**只在真正需要人拍板时才发**（高风险、要动依赖/公共接口/数据、grill 判 escalate）；能自己查清或按推荐值推进的不要问人。同一张卡同类请示已有未归档工单时不新建，返回那条 id —— 改用 flow_inbox_reply 在原工单追问。info 类只写 topic + body。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '关联的卡（项目级请示可省略）' },
          projectId: { type: 'string', description: '项目 id（有 taskId 时可不填）' },
          kind: { type: 'string', enum: ['blocked', 'risk', 'decision', 'info'], description: 'blocked=卡住了；risk=预筛判高风险要人批；decision=需要人做个决定；info=纯知情（不需动作）' },
          topic: { type: 'string', description: '一句话标题，人一眼能看出是什么事' },
          problem: { type: 'string', description: '① 遇到的问题或分歧是什么' },
          decisionNeeded: { type: 'string', description: '② 需要人做什么决定' },
          where: { type: 'string', description: '③ 发生在什么地方（卡号/文件/阶段）' },
          suggestion: { type: 'string', description: '④ 你的建议（推荐怎么做，为什么）' },
          current: { type: 'string', description: '现状：现在是什么样（事实，不写推测）' },
          progress: { type: 'string', description: '进行状况：已经做了什么、做到哪一步' },
          asks: {
            type: 'array',
            description: '要人补充的每一项（必填 ≥1，最多 6）。分区显示：问题 / 为什么问你 / 推荐答案 / 对应输入控件',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: '短标识，如 q1' },
                question: { type: 'string', description: '要人补什么（一句话，≤300 字）' },
                why: { type: 'string', description: '为什么必须人来答（调度自己查不了的原因）' },
                type: { type: 'string', enum: ['choice', 'text', 'confirm', 'number'] },
                choices: { type: 'array', items: { type: 'object' }, description: 'type=choice 时必填，2–8 个 {value,label,impact}' },
                default: { type: 'string', description: '你的推荐答案（人可以直接采纳）' },
                defaultReason: { type: 'string', description: '为什么推荐这个' },
                required: { type: 'boolean', description: '默认 true；false 表示可以不答' },
                blocks: { type: 'string', description: '答不了会卡住什么' },
              },
              required: ['question', 'why'],
            },
          },
          context: {
            type: 'object',
            description: '现状分区：{ facts: string[], evidence: [{kind:"commit"|"file"|"test"|"url", ref}] }',
            properties: { facts: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'object' } } },
          },
          impactIfNoAnswer: { type: 'string', description: '不回答会怎样（≤300 字）' },
          options: { type: 'array', items: { type: 'object' }, description: '（已废弃，v1.39 用 asks；传了会自动转成一条选择题）' },
          body: { type: 'string', description: 'info 类的正文（一次性通知，不需要人回复）' },
          blocks: {
            type: 'array',
            description: '预设组件（可选，最多 12 块）：让人看到可点的控件而不是一大段中文。类型：' + [
              'note{tone,title,text} 提示条',
              'choice{key,prompt,options[{value,label,impact,recommended}]} 快捷选项（人点一下即回答）',
              'facts{title,items[{k,v,tone}]} 现状卡片',
              'evidence{items[{kind,ref,label}]} 证据徽标（kind: file/commit/test/url/issue/pr）',
              'link{items[{provider,kind,label,url,number,state}]} 链接徽标（issue/PR/CI/URL）',
              'progress{label,done,total} 进度条',
              'diff{base,head,files,additions,deletions} 变更摘要',
              'checklist{title,items[{id,text,checked}]} 清单',
              'code{lang,text} 代码/命令片段',
            ].join('；'),
            items: { type: 'object' },
          },
        },
        required: ['topic'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            inboxId: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        try {
          const actor = actorOf(exec)
          const item = await domain.askHuman({
            taskId: args.taskId || null,
            projectId: args.projectId || null,
            kind: args.kind || 'decision',
            topic: args.topic || '',
            problem: args.problem || '',
            decisionNeeded: args.decisionNeeded || '',
            where: args.where || '',
            suggestion: args.suggestion || '',
            current: args.current || '',
            progress: args.progress || '',
            asks: Array.isArray(args.asks) ? args.asks : [],
            context: args.context || null,
            impactIfNoAnswer: args.impactIfNoAnswer || '',
            options: Array.isArray(args.options) ? args.options : [],
            body: args.body || '',
            blocks: Array.isArray(args.blocks) ? args.blocks : [],
          }, actor)
          if (item.duplicate) {
            return ok('未新建：这张卡已有同类未归档工单 ' + item.id + '（状态 ' + item.status + '）。要补充或追问请用 flow_inbox_reply({ inboxId: "' + item.id + '", content: "…" })，不要重复发请示。', { inboxId: item.id, status: item.status })
          }
          // 卡上留一条指针，讨论区里能顺着找到这条请示（但讨论区本身不被撑大）。
          if (item.taskId) {
            await domain.comment(item.taskId,
              '【请示人 ' + item.id + '】' + item.topic + ' —— 请在收件箱回复（不必在这条评论下回）。',
              { role: 'system', id: 'flow' }).catch(() => null)
          }
          return ok('已写入请示 ' + item.id + '（' + item.kind + '，状态 open）。人在收件箱回复后，你判断阻塞消除就用 flow_inbox_resolve 归档。', { inboxId: item.id, status: item.status })
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_inbox_reply',
      description: '在已有的请示工单上追问或补充（不另开工单）。人能在 Inbox 里看到同一条工单的完整对话线。已有未归档工单时必须用这个，不要再调 flow_ask_human。info 类和已归档的工单不能追问。',
      parameters: {
        type: 'object',
        properties: {
          inboxId: { type: 'string', description: '工单 id（hi_…），从 flow_inbox_list 拿' },
          content: { type: 'string', description: '追问或补充的内容：新发现的事实、需要人再确认的点' },
          blocks: { type: 'array', items: { type: 'object' }, description: '可选：随追问附带的预设组件（快捷选项 / 现状卡片 / 证据与链接徽标等，最多 12 块，类型同 flow_ask_human）' },
        },
        required: ['inboxId', 'content'],
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, inboxId: { type: 'string' }, status: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false }, render: (a, v) => blocks(v.message) },
      async execute(args, exec) {
        try {
          const item = await domain.appendInboxFollowUp(args.inboxId, args.content, actorOf(exec), { blocks: Array.isArray(args.blocks) ? args.blocks : [] })
          return ok('已追加到工单 ' + item.id + '（对话 ' + item.replies.length + ' 条，状态 open，等人回复）。', { inboxId: item.id, status: item.status })
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_inbox_list',
      description: '列请示（默认只看未归档的）。调度轮询用：看有没有人回复了、哪些还 open。传 status=answered 只看已回复待处理的。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          taskId: { type: 'string', description: '只看某张卡的请示' },
          status: { type: 'string', enum: ['open', 'answered', 'archived'] },
          kind: { type: 'string', enum: ['blocked', 'risk', 'decision', 'info', 'error'], description: '只看某一类工单' },
          q: { type: 'string', description: '搜索：匹配标题 / 问题 / 卡号' },
          includeArchived: { type: 'boolean', description: '连已归档的一起列' },
          limit: { type: 'number' },
          offset: { type: 'number', description: '分页偏移（新的在前）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            total: { type: 'number' },
            items: { type: 'array', items: { type: 'object' } },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args) {
        try {
          const items = domain.inboxList({
            projectId: args.projectId || null,
            taskId: args.taskId || null,
            status: args.status || null,
            kind: args.kind || null,
            q: args.q || null,
            includeArchived: args.includeArchived === true,
            limit: Number(args.limit) || 50,
            offset: Number(args.offset) || 0,
          })
          if (!items.length) return ok('没有未归档的请示。', { total: 0, items: [] })
          const lines = items.map((x) => {
            // v1.39：把结构化答案原样给调度 —— 它不用再从自然语言里猜人答了什么
            const asks = Array.isArray(x.asks) ? x.asks : []
            const last = x.replies && x.replies[x.replies.length - 1]
            const ans = (last && last.answers) || {}
            const ansLine = Object.keys(ans).length
              ? '  已答：' + asks.filter((a) => ans[a.key] !== undefined).map((a) => {
                const hit = (a.choices || []).find((c) => c.value === ans[a.key])
                return a.key + '=' + (hit ? hit.label : ans[a.key])
              }).join('；')
              : ''
            const waitLine = x.status !== 'archived' && asks.length
              ? '  待补：' + asks.filter((a) => a.required && ans[a.key] === undefined).map((a) => a.key + ' ' + String(a.question || '').slice(0, 40)).join('；')
              : ''
            return [
              '· ' + x.id + ' [' + x.kind + '/' + x.status + '] ' + x.topic,
              x.taskId ? '  卡：' + x.taskId : '',
              last ? '  最新回复 [' + (last.role || 'human') + '] ' + dayTime(last.at) + '：' + String(last.content || '').slice(0, 200) + (x.status === 'answered' ? '（等调度处理）' : '') : '  （还没有回复）',
              ansLine,
              waitLine,
              // v0.012：组件只给一行摘要。整包结构化 JSON 进模型上下文既贵又没必要 ——
              // 调度自己发的组件，它需要的是「这条票上还挂着什么」。
              (() => {
                const acc = [].concat(x.blocks || [], ...(x.replies || []).map((r) => (r && r.blocks) || []))
                const t = blocksToText(acc)
                return t ? '  组件：' + t.split(NL).join(' / ').slice(0, 300) : ''
              })(),
            ].filter(Boolean).join(NL)
          })
          return ok('共 ' + items.length + ' 条：' + NL + lines.join(NL), { total: items.length, items })
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
    {
      name: 'flow_inbox_resolve',
      /**
       * 归档权在**调度**，不在人。
       *
       * 语义是「我（调度）读过回复 / 看过 issue 里补充的信息，判断这个阻塞已经消除，
       * 可以继续了」。人也可以在看板上手动归档，那是兜底。
       */
      description: '归档一条请示：你判断阻塞已经消除（人回复了、issue 里补了信息、或你自己查清了）就调它。归档后这张卡会被自动继续推进。传 note 说明你依据什么判断阻塞已消除（会进审计）。',
      parameters: {
        type: 'object',
        properties: {
          inboxId: { type: 'string' },
          note: { type: 'string', description: '判断依据（例如人回复说按现状收）' },
        },
        required: ['inboxId'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (a, v) => blocks(v.message),
      },
      async execute(args, exec) {
        try {
          const item = await domain.resolveInbox(args.inboxId, { note: args.note || '' }, actorOf(exec))
          // 归档后清掉卡的推进阻塞标记，下一拍 advance 会接着推。
          if (item.taskId) await domain.clearAdvanceBlocked(item.taskId).catch(() => null)
          return ok('已归档 ' + item.id + '（' + item.status + '）。这张卡会被自动继续推进。', { status: item.status })
        } catch (err) { return fail(String(err.message || err)) }
      },
    },
  ]
}
