/**
 * dsh-flow · domain / inbox
 *
 * 调度员请示箱（v1.31）。人在看板上多轮回复，调度判定阻塞消除后归档。
 *
 * v1.36 从 domain.js 抽出：这五个方法只认 store.tx 和事件，和任务/合并/同步都不相干。
 * 通过 Object.assign(FlowDomain.prototype, inboxMethods) 混入，调用点一个都不用改。
 */
import { newId, nowIso, clampText, emit } from '../core.js'

const must = (cond, message) => { if (!cond) throw new Error(message) }
const notEmpty = (v) => typeof v === 'string' && v.trim().length > 0


/**
 * v1.39：把旧的 options（3–4 个按钮）规整成结构化 asks。
 *
 * 为什么换：选项按钮只能回答"选 A/B/C"，但真正需要人补的是——缺的事实、
 * 要不要接受某个取舍、参数填多少。按钮把"补充"压成了"三选一"，人回复完了
 * 调度还是不知道该改哪里。asks 让每一项都带"为什么问你 + 推荐答案 + 卡住什么"。
 */
const ASK_TYPES = ['choice', 'text', 'confirm', 'number']

function normalizeAsks(input) {
  const raw = Array.isArray(input && input.asks) ? input.asks : []
  return raw.slice(0, 6).map((a, i) => {
    const q = a || {}
    const type = ASK_TYPES.includes(q.type) ? q.type : 'text'
    const choices = Array.isArray(q.choices)
      ? q.choices.slice(0, 8).map((c, j) => ({
        value: clampText(String((c && c.value) || String.fromCharCode(65 + j)), 40),
        label: clampText(String((c && c.label) || ''), 160),
        impact: clampText(String((c && c.impact) || ''), 400),
      })).filter((c) => c.label)
      : []
    return {
      key: clampText(String(q.key || 'q' + (i + 1)), 20),
      question: clampText(String(q.question || ''), 300),
      why: clampText(String(q.why || ''), 500),
      type,
      choices: type === 'choice' ? choices : [],
      default: clampText(String(q.default == null ? '' : q.default), 400),
      defaultReason: clampText(String(q.defaultReason || ''), 500),
      required: q.required !== false,
      blocks: clampText(String(q.blocks || ''), 400),
    }
  })
}

/** options → asks 的兼容转换（老调度/老 prompt 还能用，但会被规整成一条选择题）。 */
function optionsToAsks(options) {
  const opts = Array.isArray(options) ? options : []
  if (!opts.length) return []
  return [{
    key: 'q1',
    question: '按哪个方案推进？',
    why: '这是一个需要人拍板的取舍，调度不能替你决定。',
    type: 'choice',
    choices: opts.slice(0, 8).map((o, i) => ({
      value: clampText(String((o && o.key) || String.fromCharCode(65 + i)), 40),
      label: clampText(String((o && o.label) || ''), 160),
      impact: clampText(String((o && o.detail) || ''), 400),
    })).filter((c) => c.label),
    default: (() => { const rec = opts.find((o) => o && o.recommended); return rec ? String(rec.key || 'A') : '' })(),
    defaultReason: (() => { const rec = opts.find((o) => o && o.recommended); return rec ? clampText(String(rec.detail || ''), 500) : '' })(),
    required: true,
    blocks: '',
  }]
}

/** 校验：type=choice 至少 2 个选项；问句和"为什么问你"必填。 */
function validateAsks(asks) {
  for (const a of asks) {
    must(notEmpty(a.question), 'asks[' + a.key + '].question（要人补什么）不能为空')
    must(notEmpty(a.why), 'asks[' + a.key + '].why（为什么需要人补）不能为空')
    if (a.type === 'choice') must(a.choices.length >= 2, 'asks[' + a.key + '] 是选择题，至少要 2 个选项')
  }
  const keys = new Set()
  for (const a of asks) {
    must(!keys.has(a.key), 'asks 的 key 重复：' + a.key)
    keys.add(a.key)
  }
}

/** 校验人的回复是否覆盖了所有必答项；返回缺失的 key 列表。 */
export function missingAnswers(asks, answers) {
  const got = answers && typeof answers === 'object' ? answers : {}
  return (asks || []).filter((a) => a.required).filter((a) => {
    const v = got[a.key]
    return v === undefined || v === null || String(v).trim() === ''
  }).map((a) => a.key)
}

/**
 * v1.39：老工单（v1.38 及以前）只有 options，没有 asks/context。
 * 读侧统一补齐，界面不用到处判空。
 */
export function upgradeInboxItem(item) {
  if (!item) return item
  const asks = Array.isArray(item.asks) && item.asks.length ? item.asks : optionsToAsks(item.options)
  return Object.assign({}, item, {
    asks,
    context: item.context || { facts: [], evidence: [] },
    impactIfNoAnswer: item.impactIfNoAnswer || '',
  })
}

/** 系统规则类请示的兜底：把 decisionNeeded 变成一条确认项（人可以直接采纳推荐值）。 */
function synthesizeAsk(decisionNeeded, suggestion, impactIfNoAnswer) {
  const q = String(decisionNeeded || '').trim()
  if (!q) return []
  return [{
    key: 'q1',
    question: q.slice(0, 300),
    why: '这条请示由系统规则触发，需要你确认处理方向；系统不会替你决定。',
    type: 'confirm',
    choices: [],
    default: String(suggestion || '').trim().slice(0, 200) || '按系统建议推进',
    defaultReason: '系统给的默认建议，可以直接采纳。',
    required: true,
    blocks: String(impactIfNoAnswer || '').trim().slice(0, 300),
  }]
}

export const inboxMethods = {
  async askHuman(input, actor = { role: 'dispatcher' }) {
    return this.store.tx((s) => {
      const { taskId = null, projectId = null, kind = 'decision', topic = '', problem = '', decisionNeeded = '', where = '', suggestion = '', current = '', progress = '', body = '', impactIfNoAnswer = '' } = input || {}
      // v1.37：选项 2–4 个，最多一个推荐；info 类不带选项。
      // v1.39：options 标为废弃，只作为 asks 的兼容来源（老的调用方仍可传）。
      const options = Array.isArray(input && input.options)
        ? input.options.slice(0, 4).map((o, i) => ({
          key: String((o && o.key) || String.fromCharCode(65 + i)).slice(0, 4),
          label: clampText(String((o && o.label) || ''), 120),
          detail: clampText(String((o && o.detail) || ''), 600),
          recommended: !!(o && o.recommended),
        })).filter((o) => o.label)
        : []
      // v1.39 结构化：asks 优先；没给 asks 才用 options 兜底转一条选择题
      const asksRaw = normalizeAsks(input)
      // asks 优先级：显式 asks > options 兼容 > 「从 decisionNeeded 自动生成一条确认项」。
      // 最后一档是给系统内部调用方（scheduler / auto-accept）用的：它们没有结构化输入，
      // 但工单仍然要有"要人补什么"这一项，否则界面上的补充区就是空的。
      const asks = asksRaw.length
        ? asksRaw
        : (kind === 'info' ? [] : (optionsToAsks(options).length ? optionsToAsks(options) : synthesizeAsk(decisionNeeded, suggestion, impactIfNoAnswer)))
      const context = (() => {
        const c = (input && input.context) || {}
        return {
          facts: (Array.isArray(c.facts) ? c.facts : []).slice(0, 12).map((x) => clampText(String(x || ''), 600)).filter(Boolean),
          evidence: (Array.isArray(c.evidence) ? c.evidence : []).slice(0, 12).map((e) => ({
            kind: clampText(String((e && e.kind) || 'ref'), 20),
            ref: clampText(String((e && e.ref) || e || ''), 300),
          })).filter((e) => e.ref),
        }
      })()
      let pid = projectId
      let task = null
      if (taskId) {
        task = s.tasks[taskId]
        must(task, 'unknown task: ' + taskId)
        pid = task.projectId
      }
      must(pid && s.projects[pid], 'askHuman 需要有效的 projectId 或 taskId')
      must(['blocked', 'risk', 'decision', 'info'].includes(kind), 'kind 只能是 blocked / risk / decision / info')
      must(notEmpty(topic), 'topic（一句话标题）不能为空')
      // v1.37：幂等去重 —— 同一张卡、同一类型、同一发起人已有未归档的工单就不再新建。
      // info 类是"通知"可以多发；其余三类是"工单"，重复开单是噪音。
      const dedupeKey = kind === 'info'
        ? null  // info 不去重
        : [taskId, kind, (actor && actor.id) || 'system'].filter(Boolean).join('|')
      if (dedupeKey) {
        const dup = (s.human_inbox || []).find((x) => x.dedupeKey === dedupeKey && x.status !== 'archived')
        if (dup) return Object.assign({}, dup, { duplicate: true })
      }
      // info 是知情项，不需要人做决定；其余三类必须把"要你决定什么"写清楚。
      // 这条校验存在的意义：让调度在发问之前先想明白到底要什么。
      if (kind !== 'info') {
        must(notEmpty(problem), 'problem（遇到的问题或分歧）不能为空')
        must(notEmpty(decisionNeeded), 'decisionNeeded（需要你做什么决定）不能为空')
        must(options.filter((o) => o.recommended).length <= 1, 'options 里最多只能有一个 recommended')
        // v1.39：结构化请示必须列出"要人补什么"。只有一句话的请示等于让人反问三轮。
        must(asks.length > 0, 'asks（要人补充的每一项）不能为空：至少 1 条 {key, question, why, type, default}')
        validateAsks(asks)
      }
      s.seq.humanInbox += 1
      const item = {
        id: newId('hi'),
        projectId: pid,
        taskId: taskId || null,
        from: (actor && actor.id) || 'system',
        fromRole: (actor && actor.role) || 'dispatcher',
        lane: (task && task.lane) || null,
        kind,
        topic: clampText(topic, 200),
        problem: clampText(problem, 4000),
        decisionNeeded: clampText(decisionNeeded, 3000),
        where: clampText(where, 1000),
        suggestion: clampText(suggestion, 2000),
        // v1.37：工单结构 —— 现状 / 进行状况 / 选项；info 类用 body 写正文
        current: clampText(current, 2000),
        progress: clampText(progress, 2000),
        options: kind === 'info' ? [] : options,
        // v1.39：结构化分区 —— 概况 / 现状（facts+evidence）/ 需要你补充（asks）/ 建议 / 处理记录
        asks: kind === 'info' ? [] : asks,
        context: kind === 'info' ? { facts: [], evidence: [] } : context,
        impactIfNoAnswer: clampText(impactIfNoAnswer, 300),
        body: kind === 'info' ? clampText(body || problem || '', 2000) : '',
        status: 'open',
        dedupeKey: dedupeKey || null,
        replies: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
        resolvedNote: null,
        archivedAt: null,
      }
      s.human_inbox.push(item)
      if (s.human_inbox.length > 5000) s.human_inbox.splice(0, s.human_inbox.length - 5000)
      emit(s, 'human.asked', { inboxId: item.id, taskId: item.taskId, kind, topic: item.topic }, actor)
      return item
    })
  }
,
  async replyInbox(inboxId, content, actor = { role: 'human', id: 'web' }, opts = {}) {
    return this.store.tx((s) => {
      const item = (s.human_inbox || []).find((x) => x.id === inboxId)
      must(item, 'unknown inbox item: ' + inboxId)
      must(item.status !== 'archived', '这条请示已归档，不能再回复（要重新讨论请让调度另发一条）')
      // v1.39.1：选项是**可选**的 —— 人完全可以只写一句补充说明（用户明确要求）。
      // asks 只是把「最想问的事」摆出来，不是必填表单。
      //   · 填了的答案逐项校验（选择题的值必须在选项里，防脏数据）
      //   · 没填的必答项**不再拦人**，只把 missing 交给调用方 —— 调度据此决定要不要追问
      const src = (opts && opts.answers && typeof opts.answers === 'object') ? opts.answers : {}
      const picked = {}
      for (const a of (item.asks || [])) {
        if (src[a.key] === undefined || src[a.key] === null) continue
        const v = String(src[a.key]).trim().slice(0, 2000)
        if (!v) continue
        if (a.type === 'choice') {
          must(a.choices.some((c) => c.value === v), 'asks[' + a.key + '] 的答案不在选项里：' + v)
        }
        picked[a.key] = v
      }
      // 没答的必答项：只是提醒，不阻断（只写补充消息也是一种有效回复）
      const missing = missingAnswers(item.asks || [], picked)
      must(notEmpty(content) || Object.keys(picked).length > 0, '回复内容不能为空（写一句补充说明，或者选一个选项）')
      const reply = {
        id: newId('hir'),
        at: nowIso(),
        by: (actor && actor.id) || 'human:web',
        role: (actor && actor.role) || 'human',
        content: clampText(content, 4000),
        // v1.39：答案是结构化的，调度端直接拿到 {q1:'B'}，不用再解析自然语言
        answers: picked,
        // v1.39.1：这次没答的必答项（可能为空）。调度看这个决定要不要追问，而不是拦住人。
        missing,
      }
      item.replies.push(reply)
      // 已经有回复的请示，人再补一句仍然是 answered（不是又变回 open）——
      // open 的语义是"还没人理过"。
      item.status = 'answered'
      item.updatedAt = nowIso()
      emit(s, 'human.replied', { inboxId, replyId: reply.id }, actor)
      return item
    })
  }
,
  /**
   * v1.37：调度在原工单上追问或补充（不另开工单）。
   * 消息进同一条对话线（replies，role=dispatcher），状态回到 open = 等人处理。
   * 验收凭据只认 role=human 的回复（domain.js acceptedBy 校验），这里写入的不会被误当成授权。
   */
  async appendInboxFollowUp(inboxId, content, actor = { role: 'dispatcher' }) {
    return this.store.tx((s) => {
      const item = (s.human_inbox || []).find((x) => x.id === inboxId)
      must(item, 'unknown inbox item: ' + inboxId)
      must(item.kind !== 'info', 'info 类是一次性通知，不能追问；需要人决定请另发 decision 类工单')
      must(item.status !== 'archived', '这条工单已归档，不能再追问')
      must(notEmpty(content), '追问内容不能为空')
      const agentMsgs = (item.replies || []).filter((r) => r && r.role !== 'human').length
      must(agentMsgs < 20, '这条工单调度消息已达 20 条上限，请先归档或让人回复')
      const reply = {
        id: newId('hir'),
        at: nowIso(),
        by: (actor && actor.id) || 'dispatcher',
        role: (actor && actor.role) || 'dispatcher',
        content: clampText(content, 4000),
      }
      item.replies.push(reply)
      item.status = 'open'
      item.updatedAt = nowIso()
      emit(s, 'human.followup', { inboxId, replyId: reply.id, taskId: item.taskId }, actor)
      return item
    })
  }
,
  async resolveInbox(inboxId, { note = '' } = {}, actor = { role: 'dispatcher' }) {
    return this.store.tx((s) => {
      const item = (s.human_inbox || []).find((x) => x.id === inboxId)
      must(item, 'unknown inbox item: ' + inboxId)
      must(item.status !== 'archived', '这条请示已经归档了')
      item.status = 'archived'
      item.resolvedAt = nowIso()
      item.resolvedBy = (actor && actor.id) || 'system'
      item.resolvedNote = clampText(note || '', 2000)
      item.archivedAt = nowIso()
      item.updatedAt = nowIso()
      emit(s, 'human.resolved', { inboxId, note: item.resolvedNote }, actor)
      return item
    })
  }
,
  inboxList({ projectId = null, status = null, taskId = null, includeArchived = false, limit = 100 } = {}) {
    return (this.store.state.human_inbox || [])
      .filter((x) => (!projectId || x.projectId === projectId)
        && (!taskId || x.taskId === taskId)
        && (status ? x.status === status : includeArchived || x.status !== 'archived'))
      .slice(-limit)
  }
,
  async markInfoRead(inboxId, actor = { role: 'human', id: 'web' }) {
    return this.store.tx((s) => {
      const item = (s.human_inbox || []).find((x) => x.id === inboxId)
      must(item, 'unknown inbox item: ' + inboxId)
      must(item.kind === 'info', '只有 info 类可以直接标已读')
      if (item.status === 'archived') return item
      item.status = 'archived'
      item.archivedAt = nowIso()
      item.resolvedAt = item.archivedAt
      item.resolvedBy = (actor && actor.id) || 'human:web'
      item.resolvedNote = '已读'
      item.updatedAt = nowIso()
      emit(s, 'human.resolved', { inboxId, note: '已读' }, actor)
      return item
    })
  }
,
  openInboxFor(taskId) {
    return (this.store.state.human_inbox || []).filter((x) => x.taskId === taskId && x.status !== 'archived')
  }
}
