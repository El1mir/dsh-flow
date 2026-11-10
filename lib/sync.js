/**
 * dsh-flow · sync
 *
 * 项目级双向同步的**纯函数层**：防环标记、出站脱敏、标签映射、方案风险评估、
 * 出站扫描。这里不碰网络、不碰 Store —— 所有 I/O 在 lib/remote.js（HTTP）与
 * lib/domain.js（落盘），中间这一层可以被单测完整覆盖。
 *
 * 为什么单独一层：同步的每条规则（marker 长什么样、哪些标签该有、什么算高风险方案）
 * 都是「可解释、可复现」的判断，混进 tx 里就再也没法单独验。
 */

import { nowIso, clampText } from './core.js'

/** 出站 body 上限：GitHub issue/comment 的正文上限 65536，留余量。 */
export const OUTBOUND_MAX = 60000

// ---------------------------------------------------------------------------
// 1. 防环标记
// ---------------------------------------------------------------------------

/**
 * 出站内容的身份标记。
 *
 * 为什么必须带 nonce：POST 成功但落盘失败时，重启后的对账只能靠「远端那条是不是我发的」
 * 来判断。只认 `dsh-flow:T-012` 会把人工转述的卡也当成自己发的；带上 nonce 才能精确
 * 认领「上一次我发的那一条」。
 */
export function flowMarker(kind, id, nonce) {
  const k = kind === 'comment' ? 'comment' : (kind === 'milestone' ? 'milestone' : 'task')
  return '<!-- dsh-flow:' + k + ' ' + String(id || '') + ' n=' + String(nonce || '') + ' -->'
}

const FLOW_MARKER_RE = /<!--\s*dsh-flow\b[^>]*-->/
const NONCE_RE = /n=([0-9a-z]+)/

/** 这段正文是不是 dsh-flow 自己写的。 */
export function hasFlowMarker(text) {
  return FLOW_MARKER_RE.test(String(text || ''))
}

/** 从正文里取 nonce（对账用）；没有返回 null。 */
export function markerNonce(text) {
  const m = String(text || '').match(FLOW_MARKER_RE)
  if (!m) return null
  const n = String(m[0]).match(NONCE_RE)
  return n ? n[1] : null
}

/** 去掉正文里的 marker（展示给人看时用）。 */
export function stripFlowMarker(text) {
  return String(text || '').replace(FLOW_MARKER_RE, '').trim()
}

/** 新建一个 nonce。 */
export function newNonce() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 取 marker 的 { kind, id, nonce }；不是 flow marker 返回 null。 */
const MARKER_PARTS_RE = /<!--\s*dsh-flow:([a-z]+)\s*([^\s>]*)([^>]*)-->/i
export function parseFlowMarker(text) {
  const m = String(text || '').match(MARKER_PARTS_RE)
  if (!m) return null
  const n = String(m[3] || '').match(NONCE_RE)
  return { kind: String(m[1] || '').toLowerCase(), id: String(m[2] || ''), nonce: n ? n[1] : null }
}

/**
 * 这条正文里的 marker 是不是**本系统**写的（RT-03 §3）。
 *
 * 为什么不能只看 `dsh-flow` 字样：marker 会随评论正文出现在任何地方，人转述一句
 * `dsh-flow:comment foo` 就被当成回声丢掉，等于人说的话被系统吞了。
 * 判据落在"id 形状"上 —— 本系统的评论 id 是 `c_<数字>`（见 domain.nextCommentId），
 * 任务 id 是 `T-<数字>`，里程碑是我们自己发的 `milestone`。
 *
 * 返回 true 才允许丢弃。
 */
export function isOwnFlowMarker(text) {
  const m = parseFlowMarker(text)
  if (!m) return false
  if (m.kind === 'comment') return /^c_\d+$/.test(m.id)
  if (m.kind === 'task') return /^T-\d+$/.test(m.id)
  if (m.kind === 'milestone') return true
  return false
}

// ---------------------------------------------------------------------------
// 2. 出站脱敏
// ---------------------------------------------------------------------------

/**
 * 出站前擦掉不该出现在公开仓库里的东西。
 *
 * 这一层不是可选的：工人的评论里出现 `C:/Users/...`、`/home/runner/...`、
 * 或不小心贴出的 `gho_xxx` token 都是真实发生过的事。宁可擦多不可漏。
 */
export function scrubOutbound(text) {
  let out = String(text == null ? '' : text)
  // token：GitHub 四种前缀 + 通用长随机串
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, '[redacted]')
  // Windows 绝对路径（含盘符与反斜杠变体）
  out = out.replace(/[A-Za-z]:[\\/](?:[^\s'"`<>|]+[\\/])*[^\s'"`<>|]*/g, '[path]')
  // POSIX 家目录 / 挂载点
  out = out.replace(/\/(?:home|Users)\/[^\s'"`<>|]+/g, '[path]')
  out = out.replace(/\/(?:root|var\/lib|opt)\/[^\s'"`<>|]+/g, '[path]')
  if (out.length > OUTBOUND_MAX) out = out.slice(0, OUTBOUND_MAX) + '\n\n…（内容过长已截断）'
  return out
}

// ---------------------------------------------------------------------------
// 3. 标签映射（ework 的 exclusive scope 语义，见 docs/远程同步设计.md §2）
// ---------------------------------------------------------------------------

export const FLOW_LABELS = {
  todo: 'flow/todo',
  planning: 'flow/planning',
  running: 'flow/running',
  verifying: 'flow/verifying',
  merging: 'flow/merging',
  done: 'flow/done',
  cancelled: 'flow/cancelled',
}

export const LABEL_COLORS = {
  'flow/todo': 'ededed',
  'flow/planning': 'fbca04',
  'flow/running': '1d76db',
  'flow/verifying': 'd4c5f9',
  'flow/merging': 'bfdadc',
  'flow/done': '0e8a16',
  'flow/cancelled': 'b60205',
  'lane/human': 'c2e0c6',
  'lane/auto': 'c5def5',
  'prio/high': 'b60205',
  'prio/medium': 'fbca04',
  'prio/low': 'ededed',
  blocked: 'd93f0b',
}

/** `scope/name` 里的 scope；没有 `/` 就没有 scope，永不独占（与 ework 一致）。 */
export function labelScope(name) {
  const i = String(name || '').indexOf('/')
  return i > 0 ? name.slice(0, i) : ''
}

/**
 * 一张卡「应该」带的标签全集。
 *
 * 只生成受管的那几组（flow/lane/prio/blocked），用户自建的标签一律不进这个集合 ——
 * 否则出站会把人在 GitHub 上手打的 `needs-design` 擦掉。
 */
export function desiredLabels(task) {
  if (!task) return []
  const out = []
  const flow = FLOW_LABELS[task.column || 'todo']
  if (flow) out.push(flow)
  out.push(task.lane === 'issue' ? 'lane/auto' : 'lane/human')
  const prio = String(task.priority || 'medium')
  if (prio === 'high' || prio === 'medium' || prio === 'low') out.push('prio/' + prio)
  if (task.blocked) out.push('blocked')
  return out
}

/** 受管标签集合（出站差异只在这几组里做）。 */
export function managedLabel(name) {
  const scope = labelScope(name)
  return scope === 'flow' || scope === 'lane' || scope === 'prio' || name === 'blocked'
}

/**
 * 算标签差异集：只增删变化的那几个。
 *
 * **不做全量覆盖**：`PUT /issues/{n}/labels` 会把人工标签一起抹掉，
 * 而人在 GitHub 上打 `needs-design` 是很常见的动作。
 */
export function diffLabels(current, desired) {
  const cur = (Array.isArray(current) ? current : []).map((x) => String(x))
  const want = new Set((Array.isArray(desired) ? desired : []).map((x) => String(x)))
  const add = [...want].filter((n) => !cur.includes(n))
  // 只删除「受管且不在期望里」的；不碰人工标签
  const remove = cur.filter((n) => managedLabel(n) && !want.has(n))
  return { add, remove }
}

// ---------------------------------------------------------------------------
// 4. 方案风险评估（自动批准分层的第一段）
// ---------------------------------------------------------------------------

const HIGH_PATTERNS = [
  { re: /schema\s*version|\bschema\b|migrat|数据库迁移|迁移脚本/i, why: '涉及 schema 迁移' },
  { re: /新增依赖|添加依赖|npm i |pnpm add |yarn add |pip install |cargo add /i, why: '新增第三方依赖' },
  { re: /package\.json|pnpm-lock|package-lock|tsconfig|\bCI 配置|github\/workflows/i, why: '改构建/依赖配置' },
  { re: /删除(目录|文件)|drop table|rm -rf/i, why: '删除文件或目录' },
  { re: /改变项目结构|重构目录|重命名模块/i, why: '改动项目结构' },
]

const CRITICAL_PATHS = [
  /(^|\/)lib\/core\.js$/,
  /(^|\/)lib\/domain\.js$/,
  /(^|\/)schema/,
  /(^|\/)\.github\//,
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)index\.(js|ts)$/,
  /(^|\/)cordis\.patch\.yml$/,
]

/**
 * 预筛方案风险：**纯函数、不调模型**，所以可复现、可测试、可解释。
 *
 * 它只是自动批准的三段里的第一段（见 docs/远程同步设计.md §4.2）：
 * 命中 high 就直接阻塞等人工，剩下交给调度判断，调度不看时才轮到兜底自动批。
 */
export function assessPlanRisk(planText, task = {}, project = {}) {
  const text = String(planText || '')
  const reasons = []
  let level = 'low'

  for (const rule of HIGH_PATTERNS) {
    if (rule.re.test(text)) {
      level = 'high'
      reasons.push(rule.why)
    }
  }

  const paths = Array.isArray(task.scope && task.scope.paths) ? task.scope.paths : []
  for (const p of paths) {
    if (CRITICAL_PATHS.some((re) => re.test(String(p)))) {
      level = 'high'
      reasons.push('触碰关键路径：' + String(p).slice(0, 80))
    }
  }

  // 评审判据集里的 high 级告警也算高风险（复用项目自带的 review_prompts，不另造一套）
  const prompts = Array.isArray(project && project.reviewPrompts) ? project.reviewPrompts : []
  for (const rp of prompts) {
    if (rp && rp.severity === 'high' && text.length < 400) {
      level = level === 'high' ? level : 'medium'
      reasons.push('方案较短，需按高严重度判据细看：' + String(rp.name || rp.id || '').slice(0, 40))
    }
  }

  if (level !== 'high') {
    if (!paths.length) {
      level = 'medium'
      reasons.push('调研没定阅读范围（scope.paths 为空），可能摸不清边界')
    }
    if (text.trim().length < 200) {
      level = 'medium'
      reasons.push('方案过于笼统（不足 200 字），看不出要做哪些文件')
    }
    const fileHits = text.match(/(?:^|\n)\s*(?:[-*+]\s*)?(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b/g) || []
    const distinct = new Set(fileHits.map((x) => x.trim()))
    if (distinct.size >= 3) {
      level = 'medium'
      reasons.push('方案涉及 ' + distinct.size + ' 个文件，需要确认改动面')
    }
  }

  return { level, reasons, assessedAt: nowIso() }
}

/**
 * 自动批准是否放行。
 *
 * v1.31 改口径：**只拦 high，其余放行**。
 *
 * 原来是"只放行 low"，理由是保守。但 medium 的判定规则太宽 ——
 * `scope.paths` 为空、方案不足 200 字、涉及 3 个以上文件，全都判 medium。
 * 线上 13 张卡里 medium 3 张，理由全是「调研没定阅读范围」「方案涉及 5 个文件」
 * 这类形式提示。medium 挡着，自动循环在每一张卡上都要停一次等人，
 * 等于没自动化。
 *
 * 现在的分工：
 *   - high  → 必须人批（命中硬规则：改 schema / 新增依赖 / 动关键路径 / 删文件）；
 *   - medium → 放行，但由调用方落一条 inbox 知情项，让人事后能看见；
 *   - low   → 放行。
 *
 * 车道不参与判断：human 和 issue 只是任务来源不同，事务逻辑相同。
 */
export function canAutoApprove(task, project) {
  const cfg = (project && project.config) || {}
  if (cfg.autoApproveIssue !== true) return { ok: false, reason: 'autoApproveIssue 未开启' }
  if (!task || !task.plan || !task.plan.text || !(task.plan.revision > 0)) return { ok: false, reason: '没有可批准的方案' }
  const risk = (task.risk && task.risk.level) || 'medium'
  if (risk === 'high') return { ok: false, reason: '预筛判 high，需要人拍板' }
  return { ok: true, reason: '', risk }
}

// ---------------------------------------------------------------------------
// 5. 出站扫描
// ---------------------------------------------------------------------------

/**
 * 扫出「该往远程推什么」。
 *
 * 只在「配置之后新建的」东西上生效（用户的明确要求：配置之后出现的卡片与评论）：
 * 用 `remote_sync[pid].since` 当分界，历史卡不自动回填（另有显式回填入口）。
 */
/**
 * 系统评论要外推哪些？
 *
 * 判据不是「谁写的」，而是「这条对人有没有用」。看板上人能看到的东西，issue 上也该看到：
 * 状态迁移、阻塞、合并、审核、PR、方案。反过来，巡检通知、心跳、内部提示这类循环噪音
 * 一律不外推——否则一个跑动的项目会把自己的 issue 刷成流水账。
 */
export function systemCommentOutbound(comment) {
  const text = String((comment && comment.content) || '')
  if (!text.trim()) return false
  if (text.length > 6000) return false
  const NOISE = [
    /^已通知调度员/, /^已注入/, /^已建 worktree/, /^已派工/, /^已让工人/,
    /巡检/, /水位/, /^已归档/, /^已清理/,
  ]
  if (NOISE.some((re) => re.test(text))) return false
  const SIGNAL = [
    /^\s*状态/, /^\s*已阻塞/, /^\s*阻塞/, /^\s*合并/, /^\s*已合并/,
    /^\s*审核/, /^\s*PR\b/, /^\s*已开 PR/, /^\s*方案/, /^\s*计划/,
    /^\s*验收/, /^\s*已验收/, /^\s*远程/, /^\s*冲突/, /^\s*已取消/,
    /^\s*重新打开/, /^\s*#/,
  ]
  return SIGNAL.some((re) => re.test(text))
}

/**
 * 这条卡的评论该发到哪条会话（RT-03 / 设计文档 §7.1）。
 *
 * 顺序是有语义的，不能调换：
 *   1. **受控 PR**（task.mergeRequest.remote，openPullRequest + attachPullRemote 的镜像）——
 *      PR 开着时讨论就应该在 PR 上，issue 只留里程碑；PR 关了/合了就回落到 issue，
 *      因为关掉的 PR conversation 已经不是"活着的那条线"。
 *   2. **外部 PR 卡**（task.external.number）—— 别人的 PR 没有本地合并快照，
 *      但它同样有自己的 conversation（GitHub 用 issue comments API）。
 *   3. **远程 issue**（task.remote.issueNumber）。
 *   4. 都没有 → null（不出站）。
 *
 * 限制：一张卡只应有一个受控 PR。真出现多个时，task.mergeRequest.remote 记的是
 * 最后一次 attachPullRemote 的那条（迁移与 attach 都按最后一条覆盖），
 * 本函数不做二次挑选 —— 多 PR 卡的评论会跟最后那条走。
 */
export function remoteThreadFor(task) {
  const t = task && typeof task === 'object' ? task : {}
  const mr = t.mergeRequest && typeof t.mergeRequest === 'object' ? t.mergeRequest : null
  const mrRemote = mr && mr.remote && typeof mr.remote === 'object' ? mr.remote : null
  const prNumber = mrRemote ? Number(mrRemote.number) || null : null
  if (prNumber && prThreadOpen(mrRemote)) return { thread: 'pr', number: prNumber }

  const ext = t.external && typeof t.external === 'object' ? t.external : null
  const extNumber = ext ? Number(ext.number) || null : null
  if (extNumber && prThreadOpen(ext)) return { thread: 'pr', number: extNumber }

  const issueNumber = t.remote && Number(t.remote.issueNumber) || null
  if (issueNumber) return { thread: 'issue', number: issueNumber }
  return null
}

/** PR conversation 还活着吗：closed / merged 之后评论回落到 issue。 */
function prThreadOpen(remote) {
  const state = String((remote && remote.state) || 'open').toLowerCase()
  if (state === 'closed' || state === 'merged') return false
  return !(remote && remote.merged === true)
}

export function pickOutbound(state, projectId, { limitTasks = 3, limitComments = 5 } = {}) {
  const project = (state.projects || {})[projectId]
  if (!project) return { tasks: [], comments: [] }
  const sync = (state.remote_sync || {})[projectId] || {}
  const since = sync.since || null
  const accounts = new Set()
  for (const task of Object.values(state.tasks || {})) {
    if (!task || task.projectId !== projectId) continue
    if (task.remote && task.remote.issueNumber) {
      accounts.add(String(task.remote.issueNumber))
    }
  }

  const tasks = []
  for (const task of Object.values(state.tasks || {})) {
    if (!task || task.projectId !== projectId) continue
    if (task.remote && task.remote.issueNumber) continue
    if (since && String(task.createdAt || '') < since) continue
    if (String(task.column || '') === 'cancelled' && !task.remote) {
      // 取消的卡仍然要推：「这张被取消了」本身就是需要留在 issue 上的信息
    }
    tasks.push({ kind: 'task', taskId: task.id, at: task.createdAt || '' })
    if (tasks.length >= limitTasks) break
  }

  const taskOf = (taskId) => (state.tasks || {})[taskId] || null
  const comments = []
  for (const c of Array.isArray(state.task_comments) ? state.task_comments : []) {
    if (!c || c.remote) continue
    const task = taskOf(c.taskId)
    if (!task || task.projectId !== projectId) continue
    // RT-03 §1：出站目标从「卡必须有 issue 号」改成 remoteThreadFor ——
    // 没有 issue 号、但有受控 PR / 外部 PR 的卡，讨论同样要能被推出去。
    const thread = remoteThreadFor(task)
    if (!thread) continue // 卡还没推上去、也没有 PR：评论先等着
    // v1.22：系统评论默认也外推，但只推「有信息量的」那几类（见 systemCommentOutbound）。
    // 用户要求：与看板看到的一致就行，但「已通知调度员巡检」这种循环噪音不该刷到 issue 上。
    if (String(c.role || '') === 'system' && !systemCommentOutbound(c)) continue
    if (since && String(c.at || '') < since) continue
    comments.push({ kind: 'comment', taskId: c.taskId, commentId: c.id, at: c.at || '', remote: { thread: thread.thread, number: thread.number } })
    if (comments.length >= limitComments) break
  }

  return { tasks, comments }
}

/** 出站正文：卡片 → 远程 issue 的标题与 body。 */
export function taskToIssuePayload(task, project) {
  const parts = []
  const note = String((task && task.note) || '').trim()
  if (note) parts.push(note)
  const acc = Array.isArray(task && task.acceptance) ? task.acceptance : []
  if (acc.length) {
    parts.push('## 验收标准\n' + acc.map((a, i) => (i + 1) + '. ' + String(a)).join('\n'))
  }
  const scope = task && task.scope
  if (scope && ((scope.paths || []).length || (scope.symbols || []).length)) {
    const bits = []
    if ((scope.paths || []).length) bits.push('路径：' + scope.paths.join('、'))
    if ((scope.symbols || []).length) bits.push('符号：' + scope.symbols.join('、'))
    parts.push('## 阅读范围\n' + bits.join('\n'))
  }
  return {
    title: clampText(String((task && task.title) || '未命名任务'), 200),
    body: parts.join('\n\n'),
  }
}

/** 同步状态的默认形状；老数据补字段时用它。 */
export function emptySyncState() {
  return {
    since: null,
    issueCursor: null,
    commentCursor: null,
    circuitUntil: null,
    lastSyncAt: null,
    lastError: null,
    outbound: [],
    rr: 0,
    backfillOffset: 0,
  }
}

/** 取（必要时创建）项目的同步状态。调用方须在事务里改返回值。 */
export function ensureSyncState(state, projectId, now = nowIso()) {
  state.remote_sync = state.remote_sync || {}
  const cur = state.remote_sync[projectId]
  if (!cur) {
    const fresh = { ...emptySyncState(), since: now }
    state.remote_sync[projectId] = fresh
    return fresh
  }
  const base = emptySyncState()
  for (const [k, v] of Object.entries(base)) {
    if (cur[k] === undefined) cur[k] = v
  }
  if (!cur.since) cur.since = now
  return cur
}

/** 远程能力探测：UI 用它把不支持的能力置灰并说明原因。 */
export function remoteCapabilities(project) {
  const remote = (project && project.config && project.config.remote) || null
  const kind = remote && remote.kind
  const configured = !!(remote && remote.owner && remote.repo)
  return {
    configured,
    kind: kind || null,
    canPushIssues: configured,
    canPushComments: configured,
    canPushPulls: configured,
    canPushLabels: configured,
    // gitea 的 check-runs 接口与 GitHub 不同，先只对 GitHub 开放
    canReadChecks: configured && kind === 'github',
    canReadReviews: configured,
    canReadSubIssues: configured && kind === 'github',
    canReadMilestones: configured,
    // C-09 §4：收尾能力。C-02 已经把 `closePull` / `listOpenPulls` 落进 lib/remote.js，
    // 这里只按 provider 判断「这个远程后端能不能收尾」，供 C-06 与看板把按钮置灰。
    //
    // 为什么两个都只放 GitHub / Gitea：closePull 是 `PATCH /repos/{o}/{r}/pulls/{n}`
    // （两边同形），listOpenPulls 只用 `state=open&per_page`（刻意不传 sort/direction，
    // 见 lib/remote.js 的注释）。kind === 'unknown' 时宁可变灰 —— 猜错会让人点了没反应。
    canClosePull: configured && (kind === 'github' || kind === 'gitea'),
    canListPulls: configured && (kind === 'github' || kind === 'gitea'),
    // RT-01 §3：远程合并（lib/remote.js 的 mergePull）。
    //
    // 只有 GitHub 能放行：Gitea 的 merge 请求字段（Do / MergeTitleField /
    // MergeMessageField / head_commit_id）来自文档而**未在本仓库实测**，
    // 猜错字段的后果是「PR 没合、卡却以为合了」。验证通过前 Gitea 只能是 false，
    // 调用方（policyFor）据此拒绝开启 Gitea 远程模式；不要在别处按 provider 自己判断。
    canMergePull: configured && kind === 'github',
  }
}
