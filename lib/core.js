/**
 * dsh-flow · core
 *
 * 真相源 + 状态机 + 事件。全部同步纯函数，唯一副作用在 Store 的原子落盘。
 *
 * 事务模型（设计文档 5.x 的落地版）：
 * - 单进程单写者：Store.tx(fn) 串行化，进事务前快照，抛错整份回滚。
 * - 落盘原子：写 tmp 再 rename，进程被杀不会留半份文件。
 * - 迁移：schemaVersion 不匹配时按 MIGRATIONS 链升级，不认识的版本拒绝启动。
 */

import { readFile, writeFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

// v0.008（C-10）：14 = 子卡的 unitMode（工作单元 / 历史分支）落地。
export const SCHEMA_VERSION = 15

/**
 * 孤儿 tmp 的判废时间（v1.39.2）。
 * 一次落盘是"写 tmp + rename"，正常在毫秒级完成；留在这里超过 10 分钟
 * 只能是 persist 失败或进程被杀留下的垃圾。留足余量是因为别的进程
 * 可能正在同一个目录里写（测试并行、多个工作区共用），过早删会让它 ENOENT。
 */
export const STALE_TMP_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// v1.35 · causation（设计文档 §3.2 / I7）
//
// 事件只带 actor 时，「issue 入站 → 建卡 → 派工 → 自停 → 巡检 → 重派」这条链
// 事后只能按时间猜。这里用 AsyncLocalStorage 携带「当前在处理哪个事件」，
// emit 自动把它写进 causationId —— 调用方不用逐层传参，
// 跨 await（包括 Store.tx 的队列）也能带过去。
// ---------------------------------------------------------------------------
const causeStore = new AsyncLocalStorage()

/** 在 causationId 上下文里跑 fn：fn 里（含异步链）emit 的事件都会带上它。 */
export function withCause(causationId, fn) {
  if (!causationId) return fn()
  return causeStore.run({ causationId: String(causationId) }, fn)
}

/** 当前上下文的 causationId（没有就是 null）。 */
export function currentCause() {
  const ctx = causeStore.getStore()
  return (ctx && ctx.causationId) || null
}

export const COLUMNS = ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled']
export const COLUMN_TITLE = {
  todo: '待办',
  planning: '规划中',
  running: '执行中',
  verifying: '待验收',
  merging: '合并中',
  done: '完成',
  cancelled: '已取消',
}
export const BLOCKED = 'blocked'

/**
 * 回退能落到哪些列（v0.007）。
 *
 * 不含 done / cancelled：那两列是「这一轮结束了」，要再来一次是 reopen 的语义
 * （清快照、计 reopenCount、走人类闸门），不是「退一步」。混在一起会让
 * 「重开次数」这种审计字段失去意义。
 */
export const REWIND_TARGETS = ['todo', 'planning', 'running', 'verifying', 'merging']

let seq = 0
export const newId = (prefix) => {
  seq = (seq + 1) % 1000
  return prefix + '_' + Date.now().toString(36) + seq.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6)
}
export const nowIso = () => new Date().toISOString()
export const clampText = (v, limit) => {
  if (typeof v !== 'string') return ''
  if (v.length <= limit) return v
  // 不把代理对（emoji / 生僻字）切成两半：孤立代理项不是合法 UTF-16，下游 JSON 校验会拒
  let end = limit
  const c = v.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end -= 1
  return v.slice(0, end)
}

/**
 * 把任意值收敛成「无损 JSON」：PTC 的工具输出校验要求 JSON.parse(JSON.stringify(v)) 与 v 等价。
 *
 * 内存态里会留下 JSON 写盘时被悄悄丢掉、但校验不接受的值（线上：message_log 里
 * queued: undefined 让 flow_worker_log 整条失败）。这里统一处理：
 * - 对象里值为 undefined / 函数 / symbol 的键删除；数组里的同类元素改 null（保持下标）
 * - NaN / ±Infinity → null；-0 → 0；超出安全整数 → 字符串
 * - Date → ISO 字符串；Map / Set → 数组 / 对象；BigInt → 字符串；循环引用 → '[circular]'
 */
export function sanitizeLossless(value, seen = new WeakSet()) {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') {
    if (!Number.isFinite(value)) return null
    if (Object.is(value, -0)) return 0
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return String(value)
    return value
  }
  if (t === 'bigint') return String(value)
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.map((x) => { const v = sanitizeLossless(x, seen); return v === undefined ? null : v })
  } else if (value instanceof Map) {
    out = {}
    for (const [k, x] of value) { const v = sanitizeLossless(x, seen); if (v !== undefined) out[String(k)] = v }
  } else if (value instanceof Set) {
    out = [...value].map((x) => { const v = sanitizeLossless(x, seen); return v === undefined ? null : v })
  } else {
    out = {}
    for (const k of Object.keys(value)) { const v = sanitizeLossless(value[k], seen); if (v !== undefined) out[k] = v }
  }
  seen.delete(value)
  return out
}

/**
 * 评论正文上限（v1.25：4000 → 40000）。
 *
 * 原来写死 4000，工人交的调研报告/验收材料从**存储**就被砍断——
 * 线上真实事故：c_00082 正好停在 4000 字符、止于 spec 015 中途，
 * 子调度复核时读到的是半截内容，只能打回让人重写。
 * 原文一旦被 clamp 掉就永久丢失，事后无论怎么读都补不回来，所以上限必须放宽。
 *
 * 为什么不定成无穷大：state 是整份 JSON、每个事务全量 stringify（约 15MB），
 * 单条评论无上限等于给写放大开了个口子。40KB 足够装下逐项审计报告，
 * 又不至于一条评论就把文件撑爆。真要更大，改这一个常量即可。
 */
export const COMMENT_MAX = 40000

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    projects: {},
    tasks: {},
    task_comments: [],
    runs: {},
    agents: {},
    agent_sessions: {},
    approvals: {},
    merge_requests: {},
    leases: {},
    events: [],
    outbox: [],
    review_prompts: {},
    // ---- v0.3：事件管道 / 远程镜像 / PR / worktree / 注入 / 投递审计 ----------
    event_inbox: [],
    event_cursors: {},
    issues_mirror: {},
    pull_requests: {},
    worktrees: {},
    injections: [],
    message_log: [],
    // v1.22：远程同步状态按项目一条（since / 两条游标 / 熔断 / 出站 pending / 轮转指针）。
    remote_sync: {},
    // v1.24：全局控制位。halted = 人按下「停止全部调度」后禁止一切自动推进
    // （tick / 派工 / 事件注入 / 会话事件回灌），直到显式恢复。
    // 放在全局而不是每个项目各一份：按钮的语义是"我现在要安静"，按项目分只会漏掉某个项目。
    control: { halted: false, haltedAt: null, haltedBy: null, reason: null },
    // v1.31：调度员请示箱。调度遇到需要人拍板的事就写一条到这里，
    // 人在看板上多轮回复，调度判定阻塞消除后归档并继续推进。
    // 与 event_inbox（远程事件入站）不是一回事，别混用。
    human_inbox: [],
    // v1.35：迁移副作用的意图表（设计文档 §3 的 L1 意图）。
    // move 在同一事务里写一条 pending，提交后执行；崩溃/失败留在这里由 tick 收敛。
    effects: {},
    // v1.36: maintenance + model cooldowns
    maintenance: {
      lastWorktreeGcAt: null,
      // v0.006：没有 run 的会话（需求评审工位 / 调度员自己）报错或被打断时留一条事实。
      // 这些会话不进 runs 表，所以老代码把它们的事件全丢了 —— 卡就这么静默挂着。
      lastSessionErrors: [],
    },
    model_cooldowns: {},
    // v1.37：全局设置 — 调度模型默认值（工位显式配置 > 项目 defaultProvider/Model > 这里）。
    settings: { defaultProvider: null, defaultModel: null, defaultReasoningEffort: null },
    // v1.37：项目指标累加器。DSH 的 tokenUsage 只给到会话当前 turn/step，
    // 总量必须靠相邻采样求增量累加；samples 是最近 120 个点（约 2 小时）用于算每分钟速率。
    metrics: {},
    // v1.37.1：调度的只读探测计数（agentId → { windowStart, count }），防止用轮询代替等事件
    probe_budget: {},
    seq: { task: 0, run: 0, agent: 0, session: 0, comment: 0, event: 0, prompt: 0, inbox: 0, injection: 0, mirror: 0, pr: 0, worktree: 0, msg: 0, outbound: 0, humanInbox: 0, effect: 0 },
  }
}

// ---------------------------------------------------------------------------
// 状态机：column 是位置，blocked 是覆盖在位置上的旗子（设计文档 4.x）。
// 每个动作声明：允许的来源列、允许的角色、守卫、目标列、副作用。
// 守卫返回字符串表示拒绝原因，返回 null 表示放行。
// ---------------------------------------------------------------------------

const notEmpty = (v) => typeof v === 'string' && v.trim().length > 0

/**
 * 这张卡要不要走"合并"这一步。
 *
 * 判据是**项目是不是 Git 仓库**，不是任务上有没有 headSha：
 * 非 Git 的工作区根本没有分支可合，硬走 merging 会让卡卡死在那里
 * （review_approve 因为没有 PR 快照被拒，accept 又不允许从 merging 发起）。
 *
 * task.worktree === false / null 表示派工时就没建 worktree（非 Git 降级），
 * 也算"不需要合并"。
 *
 * I-12（ADR-0005）：判据从布尔 `noMerge` 换成三态 `mergeState`。
 * 为什么换：布尔把「本来就不用合」（none）和「合不了」（blocked）压成同一个 true，
 * 基分支配错、分支被残留检出占用这类**故障**于是在看板上跟正常决策长得一模一样。
 * 现在只有 pending / ready 走合并列 —— blocked 进合并列只会等一个永远不来的结果
 * （merge() 第一道检查就是 mergeState，非 ready/pending 一律拒），
 * 它的归宿是 done-no-merge + 看板上一直显形的红 chip。
 *
 * 降级：mergeState 缺失 = schema 11→12 迁移之前的老数据。直接当 none 会把该合的卡
 * 静默成 done，所以回退读 noMerge / worktree —— 与 v0.001 的行为逐字一致。
 * 回退是**只读兼容**，不是第二套判据：新写入的卡一定有 mergeState（setMergeState 是唯一写入口）。
 */
const needsMerge = (t) => {
  if (!t) return false
  // C-10：子卡**永不走合并列**。判据是拓扑（有没有父卡），不是状态字段 ——
  // 子卡是工作单元：它只产生提交，落在父分支 flow/<parentId> 上；
  // 分支、PR、审核、合并这一整套对外交付面只属于父卡。
  // 放在最前面（比 mergeState 更早）：线上 T-049 正是「子卡在 merging 列被判 risk」
  // —— 那是把工作单元当成交付单元来管，怎么修都修不对。
  if (t.parentId) return false
  // pending：应该合、还没轮到；ready：可合并。两者都得进合并列。
  if (t.mergeState === 'pending' || t.mergeState === 'ready') return true
  // none：本来就不用合；blocked：现在合不了（原因与修复动作走 MERGE_REASON 表）。
  if (t.mergeState === 'none' || t.mergeState === 'blocked') return false
  // 迁移前的老卡没有 mergeState，回退旧判据
  if (t.noMerge === true) return false
  // 显式标记优先：dispatch 在非 Git 项目上会给任务打 noMerge
  if (t.worktree === false) return false
  return true
}

/**
 * 子卡不参与合并（C-10）。
 *
 * 判据与 needsMerge 一样是**拓扑**：有 parentId 就是子卡。
 * 三个合并类动作（merge_skip / review_approve / review_risk）各自过一道，
 * 是纵深防御 —— needsMerge 只决定 accept 往哪走，工具、看板、脚本这些旁路入口
 * 仍可能把一张子卡推进 merging，那时这里必须挡住，而不是让它再走一遍合并。
 */
const childMergeReject = (t) => (t && t.parentId
  ? '子卡不参与合并：改动以提交形式落在父分支 flow/' + String(t.parentId) + ' 上（子卡是工作单元，交付面只有父卡）'
  : null)

/**
 * 交付阶段的人话枚举（rf-02）。
 *
 * 为什么需要它，而不是到处写 `column === done`：
 * done 有三条来路，其中只有一条真的把代码放进了 base。用列判断交付率会把
 * 「有意不合并」与「本来没有可合的东西」也算成交付 —— T-036/T-042 的假完成就是这么来的。
 *
 * 这张表也是读侧唯一的分类来源：看板徽标、详情页、巡检统计都从它取值，
 * 否则每个读出口又会各写一遍 if。
 */
export const DELIVERY_STATE = {
  delivered: '已交付',
  skipped: '有意未合并',
  'no-merge': '无可合并内容',
  'merged-into-parent': '已合入父分支',
  'not-delivered': '未交付',
}

/**
 * 唯一「代码已进 base」的判据（rf-02）。
 *
 * 只认 column==='done' 且 phase==='merged'。merge_skip 落 merged-skipped、
 * 无需合并落 done-no-merge、子卡落 merged-into-parent —— 三者都不是交付。
 */
export function isDelivered(t) {
  return !!t && t.column === 'done' && t.phase === 'merged'
}

/**
 * 把一张卡归类到 DELIVERY_STATE 的某个键。
 *
 * 非 done 的卡一律 not-delivered，不看 phase —— 在途的卡可能在 merged-into-parent，
 * 也可能带着上一步的 phase 残留，那些都不该被当成「已交付」。
 */
export function deliveryState(t) {
  if (!t || t.column !== 'done') return 'not-delivered'
  if (t.phase === 'merged') return 'delivered'
  if (t.phase === 'merged-skipped') return 'skipped'
  if (t.phase === 'done-no-merge') return 'no-merge'
  if (t.phase === 'merged-into-parent') return 'merged-into-parent'
  // v0.008：工作单元（子卡）的落点也是父分支，只是路径不同 ——
  // merged-into-parent 是「自己的分支合进父分支」（legacy），done-in-parent 是
  // 「直接在父检出里提交」。对读侧来说它们是同一件事：代码在父分支上，没进 base。
  if (t.phase === 'done-in-parent') return 'merged-into-parent'
  return 'not-delivered'
}

export const TRANSITIONS = {
  claim: {
    from: ['todo'],
    roles: ['dispatcher', 'human'],
    to: 'planning',
    guard: () => null,
  },
  plan_ready: {
    from: ['planning'],
    roles: ['dispatcher'],
    to: 'planning',
    phase: 'waiting-approval',
    guard: (t) => (notEmpty(t.plan && t.plan.text) ? null : 'plan 为空'),
  },
  approve: {
    from: ['planning'],
    roles: ['human'],
    to: 'running',
    phase: 'executing',
    guard: (t) => (t.plan && t.plan.revision > 0 && t.plan.text ? null : '先写计划再批准（批准会绑定当前 plan_rev）'),
  },
  /**
   * issue 卡的调研轮：从"规划中"进入"执行中"，但阶段标成 investigating。
   *
   * 为什么要动列：调研本身就是一次 run（要开会话、要能被 stop），
   * 而 stop 只允许从 running 发起。所以调研必须在 running 列里跑，
   * 靠 phase 区分它是调研还是实现。
   */
  investigate: {
    from: ['planning'],
    roles: ['dispatcher', 'system'],
    to: 'running',
    phase: 'investigating',
    guard: (t) => (t.lane === 'issue' ? null : '只有 issue 车道的卡需要调研'),
  },
  // 调研结束：把方案交回去，停在"待批准"（不进 running，所以人批了才会开工）
  submit_plan: {
    from: ['verifying'],
    roles: ['dispatcher', 'system'],
    to: 'planning',
    phase: 'waiting-approval',
    guard: (t) => (t.plan && t.plan.revision > 0 && t.plan.text ? null : '没有方案可提交'),
  },
  /**
   * issue 车道专用：主调度（chief）代替人批准调研方案。
   *
   * 为什么单开一个动作而不是把 approve 的 roles 放宽：human 车道的卡必须人来批准，
   * 这条闸门不能因为 issue 流程而松。issue 是"外部进来的活"，允许主调度代批，
   * 但**批准者会记在 approval 记录里**，事后能查是谁点的。
   */
  approve_by_chief: {
    from: ['planning'],
    roles: ['chief'],
    to: 'running',
    phase: 'executing',
    guard: (t) => {
      if (t.lane !== 'issue') return '只有 issue 车道的卡可以由主调度代批'
      return t.plan && t.plan.revision > 0 && t.plan.text ? null : '先有调研方案再批准'
    },
  },
  /**
   * v1.26：human 车道的卡，方案由调度/主调度代批。
   *
   * 为什么需要它：调度用 flow_task_create 建出卡、claim 进 planning 之后
   * **永远走不下去** —— 代理没有写计划的工具，而 approve 只有 human 能执行。
   * 线上 T-035..T-039 五张卡就卡死在这里，卡上写着「Flow 当前不能将这类新卡
   * 直接分派给子代理或由代理推进 human acceptance」。
   *
   * 为什么不同时放开 approve 的 roles：approve 是**人行闸门**，语义是
   * '人看过并同意'；把 dispatcher 塞进去，审计记录就分不清哪个是人批的。
   * 单开一个动作，审批记录里的 by 写的是具体调度 id，事后可查。
   *
   * 闸门保留在哪：guard 要求 risk 已评估且不是 high —— 改 schema、加依赖、
   * 动核心文件这类方案仍然必须人拍板。风险由 domain 在代批前现算，不信旧值。
   */
  approve_by_dispatcher: {
    from: ['planning'],
    roles: ['dispatcher'],
    to: 'running',
    phase: 'executing',
    guard: (t) => {
      if (t.lane === 'issue') return 'issue 车道走 approve_by_chief（评审人是主调度）'
      if (!(t.plan && t.plan.revision > 0 && t.plan.text)) return '先写计划再批准（代批也要有方案）'
      const level = (t.risk && t.risk.level) || 'unknown'
      if (level === 'high') return '方案命中高风险规则，必须人工批准（' + (((t.risk && t.risk.reasons) || [])[0] || 'high') + '）'
      return null
    },
  },
  /**
   * v1.35：/flow 发布即开工。
   *
   * 以前 flow_publish 用 `{ role:'human', id:'flow-publish' }` 执行 approve —— 工具调用方是模型，
   * 却以人的身份过了人行闸门，审批记录里也分不出「人批的」和「发布带出来的」。
   * 发布确实代表人在对话里确认了方案，但这份确认是**对话里的**，不是看板上的人工点击，
   * 所以单开一个动作：
   *   - 署名是真实的调度/主调度；
   *   - 必须带 publishedFrom（发起发布的会话），审批记录里留下来源；
   *   - 高风险方案照样拦住，停在待批准等人点。
   */
  approve_by_publish: {
    from: ['planning'],
    roles: ['dispatcher', 'chief'],
    to: 'running',
    phase: 'executing',
    guard: (t, ctx) => {
      const payload = (ctx && ctx.payload) || {}
      if (!(t.plan && t.plan.revision > 0 && t.plan.text)) return '先写计划再发布'
      if (!notEmpty(payload.publishedFrom)) return '发布即开工必须带 publishedFrom（发起发布的会话 id）'
      const level = (t.risk && t.risk.level) || 'unknown'
      if (level === 'high') return '方案命中高风险规则，发布后仍需人工批准（' + (((t.risk && t.risk.reasons) || [])[0] || 'high') + '）'
      return null
    },
  },
  reject: {
    from: ['planning'],
    roles: ['human'],
    to: 'todo',
    phase: '',
  },
  stop: {
    from: ['running'],
    roles: ['worker', 'dispatcher'],
    to: 'verifying',
    phase: 'awaiting-acceptance',
    guard: (t) => (t.stopReport && notEmpty(t.stopReport.summary) ? null : '停止必须带 stop report'),
  },
  rework: {
    from: ['verifying'],
    roles: ['human', 'dispatcher'],
    to: 'running',
    phase: 'executing',
  },
  /**
   * 验收（人闸门）。
   *
   * v1.28 放宽两处，都是被线上卡住的实际问题逼出来的：
   *
   * 1. **允许 dispatcher 代收口，但必须带 acceptedBy（人类授权凭据）。**
   *    以前只有 human 能执行：人在对话里说了"通过吧"，调度仍然被挡在门外，
   *    卡永远停在 verifying —— 授权已经给了，系统却要人再点一次按钮。
   *    现在：人可以点，也可以**授权后由调度代点**；凭据写进审批记录，事后可查谁授的权。
   *    没有凭据的代收一律拒 —— AI 不许自批自收。
   *
   * 2. **headSha 不再是必填。** 以前 guard 只检查"非空"，线上于是出现了
   *    `audit-T035-verified` 这种根本不是 SHA 的值也能过闸门 —— 闸门形同虚设。
   *    真相是：很多单没有代码改动（只读审计/文档/调研），压根没有提交可绑；
   *    有改动的单，SHA 也该由系统从 worktree 读，不该让人手抄。
   *    现在：headSha 要么是合法 SHA（系统填），要么为空表示"无提交"。
   *    真正防"批旧码合新码"的闸门在 dispatch.mergeLocked 里比对 PR headSha，那个不动。
   */
  accept: {
    from: ['verifying'],
    roles: ['human', 'dispatcher'],
    // 没有 Git 就不存在"合并"这一步：直接完成，别把卡塞进合并列等一个永远不会有的 PR。
    // to 支持函数，由 applyTransition 解析（本地看板/非 Git 项目必须能走完）。
    to: (t) => (needsMerge(t) ? 'merging' : 'done'),
    // C-10：子卡验收落 done-in-parent —— 改动已经在父分支上（父卡收口时才对外交付）；
    // 普通卡没有合并列可走时仍是 done-no-merge。两者的区别是「东西在哪」，不是措辞。
    phase: (t) => (needsMerge(t) ? 'merge-ready' : (t && t.parentId ? 'done-in-parent' : 'done-no-merge')),
    guard: (t, ctx) => {
      const payload = (ctx && ctx.payload) || {}
      // 代理代收必须有人类授权凭据；人自己点不需要。
      if (ctx && ctx.role === 'dispatcher' && !notEmpty(payload.acceptedBy)) {
        return '验收需要授权：代理代收必须带 acceptedBy（人回复过的请示单 id，例如 hi_xxx），否则请人工验收'
      }
      // v1.35：凭据必须**核验得过**，不是「非空」就行。
      // 以前提示词直接教模型填 'human:web'，任何调度都能自称「人授权了」。
      // 现在由 domain 去请示箱查证（见 FlowDomain.resolveAcceptGrant），守卫只认核验结果。
      if (ctx && ctx.role === 'dispatcher') {
        const grant = ctx.grant
        if (!grant || grant.ok !== true) {
          return '验收授权核验失败：' + ((grant && grant.reason) || 'acceptedBy 不是可核验的凭据')
            + '。正确做法：flow_ask_human 发请示，人在看板回复同意后，用那条请示的 id 作为 acceptedBy'
        }
      }
      // headSha 可空（无提交的卡），但一旦给了必须是**提交号的形状**（全十六进制）。
      // 长度放宽到 3+ 是因为短 SHA 可以有多种长度（git 里 abc1234 / deadbeef 都常见）；
      // 真正要拦的是 `audit-T035-verified` / `sha-pr-1` 这种根本不是哈希的字符串 ——
      // 线上就是靠它蒙过了旧闸门（旧闸门只看"非空"）。
      if (notEmpty(t.headSha) && !/^[0-9a-f]{3,40}$/i.test(String(t.headSha))) {
        return 'head_sha 格式不合法（应为十六进制提交号，收到：' + String(t.headSha).slice(0, 24) + '）；无提交的卡可以留空'
      }
      return null
    },
  },
  // C-05 / rf-01：子卡的交付落点不是 base，而是**父分支**。
  //
  // 为什么单独一个 action 而不是复用 review_approve：review_approve 的守卫要求
  // mergedCommit（那是「已经在 base 上」的证据），而子卡合进父分支时 base 并没有前进。
  // 用 review_approve 记这笔账，会让「已交付」的判据失去意义（isDelivered 就不再可信）。
  //
  // 语义：verifying → done / merged-into-parent。它**不算已交付**（代码还在父分支上），
  // 只表示「这个工作包已经进了父卡的集成点」。父卡收口时才是对外交付。
  merge_into_parent: {
    // 子卡的实际路径是 verifying → accept → **merging** → 合进父分支。
    // 所以来源列是 merging；verifying 也放着，是为了「没有合并列的卡」在收口时
    // 还能直接走这条路（needsMerge=false 的那类：本来就没有可合的东西）。
    from: ['verifying', 'merging'],
    roles: ['system', 'dispatcher', 'human'],
    to: 'done',
    phase: 'merged-into-parent',
    guard: (t) => {
      if (!t.parentId) return '只有子卡才有父分支可以合（这张卡没有 parentId）'
      const st = t.mergeState
      if (st === 'none' || st === 'blocked') return '这张卡当前不可合进父分支（mergeState=' + String(st) + '），先修好再重试'
      return null
    },
    // 注意：这里**不写** effect —— applyTransition 不消费 rule.effect（只有 domain.move 的调用方
    // 自己接 after）。写在这里等于写了一段没人执行的代码，读代码的人会以为 mergeState 会被自动清掉。
    // 「合进父分支之后把 mergeState 收成 none」的收尾由 dispatch.mergeIntoParent 显式做（C-05）。
  },

  // 已经卡在合并列（历史数据、或仓库在过程中没了 .git）时的出口：  // 已经卡在合并列（历史数据、或仓库在过程中没了 .git）时的出口：
  // 明确记下"跳过合并"，落到 done，而不是让卡永远停在 merging。
  merge_skip: {
    from: ['merging'],
    roles: ['human', 'dispatcher'],
    to: 'done',
    phase: 'merged-skipped',
    /**
     * v1.33：允许「审核通过但不该合并」的情况显式跳过。
     *
     * 原来这里一刀切：只要有审核结论就拒绝 merge_skip。
     * 但真实情况里存在「审核通过了、可合并会倒退」的卡 —— 典型的 T-042：
     * 它是 T-044 的早期版本，合并它会删掉 T-044 已引入的文件。
     *
     * 那种卡的正确归宿就是 merged-skipped（有意不合并），
     * 用 review_approve 反而会要求 mergedCommit、逼出一次错误的合并。
     *
     * 所以：带 reason 的显式跳过放行，让调用方把「为什么不合并」写清楚；
     * 不写理由的仍然按原样拒绝（防止随手跳过）。
     */
    guard: (t, ctx) => {
      const sub = childMergeReject(t)
      if (sub) return sub
      const payload = (ctx && ctx.payload) || {}
      const hasVerdict = t.mergeRequest && notEmpty(t.mergeRequest.reviewVerdict)
      if (hasVerdict && !notEmpty(payload.reason)) {
        return '这张卡已有审核结论：要合并请用 review_approve，要明确不合并请用 merge_skip 并写 reason 说明原因'
      }
      return null
    },
  },
  pr_open: {
    from: ['merging'],
    roles: ['worker', 'dispatcher'],
    to: 'merging',
    phase: 'review-pending',
    // C-10：子卡不参与合并 —— 它的产出以提交形式落在父分支上，没有自己的 PR 可开。
    // 这条守卫堵的是「别的入口自己把子卡推进 merging 再补 PR」那条路（D-surface §1.2g）。
    guard: (t) => childMergeReject(t) || (t.mergeRequest && notEmpty(t.mergeRequest.headSha) ? null : '没有 PR 快照'),
  },
  review_approve: {
    from: ['merging'],
    roles: ['dispatcher'],
    to: 'done',
    phase: 'merged',
    /**
     * v1.32：**审核通过 ≠ 已合并**。
     *
     * 线上事故：T-036/T-042/T-044 卡上写着 done/merged，但
     *   mr.status = ready_for_review / open，mergedCommit = null
     * —— 从来没有任何一次 git 合并发生过。
     *
     * 原因是这个守卫只看"有没有审核结论"。而 review_approve 可以由
     * pr.review / flow_pr_review 直接调用，于是「点一下审核通过」就把卡
     * 标成了已合并，整个 git merge 被跳过。
     *
     * 现在要求：必须有真实合并落地的证据（mergedCommit）。
     * 正常路径不受影响 —— mergeLocked 是「先 markMerged 记提交，再 review_approve」，
     * 到这一步 mergedCommit 已经有值了。
     */
    guard: (t) => {
      const sub = childMergeReject(t)
      if (sub) return sub
      if (!t.mergeRequest || !notEmpty(t.mergeRequest.reviewVerdict)) return '审核结论缺失'
      const commit = t.mergeRequest.mergedCommit || t.mergeRequest.mergeCommit
      if (!notEmpty(commit)) {
        return '还没有真正的合并提交，不能标记为已合并：'
          + '要么让调度走 flow_pr_merge 真合并，要么用 merge_skip 显式跳过'
      }
      return null
    },
  },
  review_conflict: {
    from: ['merging'],
    roles: ['dispatcher'],
    to: 'running',
    phase: 'changes-requested',
  },
  review_risk: {
    from: ['merging'],
    roles: ['dispatcher'],
    to: 'merging',
    phase: 'risk-escalation',
    // C-10：子卡没有合并列，也就没有「合并风险评估」这件事可记。
    guard: (t) => childMergeReject(t),
  },
  cancel: {
    from: ['todo', 'planning', 'running', 'verifying', 'merging'],
    roles: ['human'],
    to: 'cancelled',
    phase: '',
  },
  /**
   * v0.005：远程 PR 结束（被合了或被人关了）→ 自动车道的卡就地结束。
   *
   * 为什么不复用 `cancel`：那条迁移的 roles 只有 human（「取消」是人的决定）。
   * 这里结束卡的是**远程事实**，人是把 PR 关掉而不是把卡取消，
   * 所以单开一条 system 可发起的迁移，phase 也分开记（`remote-ended`），
   * 看板上能区分「人取消」与「PR 结束自动收尾」。
   *
   * 只给自动车道用；人车道的卡 PR 结束后仍走正常生命周期（见 dispatcher.closeoutRemote）。
   */
  remote_ended: {
    from: ['merging', 'running', 'verifying'],
    roles: ['system', 'dispatcher'],
    to: 'cancelled',
    phase: 'remote-ended',
    guard: (t) => (t.kind === 'external-pr' || t.mergeRequest ? null : '这张卡没有远程 PR 记录'),
  },
  // ---- v1.0：三层监督的补充迁移 ------------------------------------------
  // plan 定稿后把卡交给车道子调度（不移动列，只记阶段，避免看板抖动）
  handoff: {
    from: ['planning'],
    roles: ['chief', 'dispatcher'],
    to: 'planning',
    phase: 'dispatched',
    guard: (t) => (t.plan && t.plan.revision > 0 && t.plan.text ? null : '先写计划再交接'),
  },
  // T20 改派：非终态同列改派给另一个子调度；旧租约由调用方释放
  reassign: {
    from: ['planning', 'running', 'verifying', 'merging'],
    roles: ['human', 'dispatcher'],
    to: null, // 同列
    phase: 'dispatched',
    guard: () => null,
  },
  // T8：工人自停后由子调度落巡检结论（不移动列，只写 inspection）
  classify: {
    from: ['running', 'verifying'],
    roles: ['dispatcher'],
    to: null,
    phase: 'classifying',
    guard: (t) => (t.stopReport && t.stopReport.summary ? null : '没有停止报告可判读'),
  },

  /**
   * v1.39：父卡汇总（子卡全部完成）。
   *
   * 父卡自己不派工、不合并，所有代码都在子卡里。子卡全部 done/cancelled 之后，
   * 父卡从 planning/running 直接进待验收 —— 这一步由系统在 rollupParent 里触发，
   * 不是人也不是工人的决定，所以单独开一条迁移，而不是让 rollup 直接改 column
   * （绕过状态机就没有历史记录，也容易和别的迁移打架）。
   */
  children_done: {
    from: ['todo', 'planning', 'running'],
    roles: ['system', 'dispatcher'],
    to: 'verifying',
    phase: 'children-done',
    guard: (t) => {
      const ids = Array.isArray(t.childIds) ? t.childIds : []
      return ids.length ? null : '这张卡没有子任务，不需要汇总'
    },
  },

  // T19：完成/取消是终态，只有人类能显式重开，且必须留原因。
  /**
   * 回退（v0.007）：把卡退回更早的列，**不进冻结**。
   *
   * 为什么需要它：正向动作的守卫是「没走完生命周期不许推完」，那些守卫本身是对的；
   * 但流程走错一步（提前进 verifying、评审结论推翻、拆分要重来）时，
   * 原来只能 cancel + reopen —— 一次真取消，reopenCount 涨一，审计里看着像「这张卡反复失败」。
   * 线上 T-048 就是这么卡住的：评审 settled、拆分草稿已定，卡却在 verifying，
   * splitTask 只收 todo/planning，reject/rework 的 from 也不含 verifying，四条路全堵。
   *
   * 口径（用户定的）：硬守卫只防「没走完就推完」，**回推不该被冻结**。
   * 所以 blocked 的卡也能回退（checkTransition 里 rewind 与 cancel 一起豁免），
   * 回退本身会把 blocked 旗子清掉 —— 卡都退回去了，原来那个阻塞原因已经不代表现状。
   *
   * 必须写 reason：history 里要能看出是谁、什么时候、为什么退回，
   * 否则「卡自己变回去了」就是最难查的一类问题。
   */
  rewind: {
    from: ['todo', 'planning', 'running', 'verifying', 'merging'],
    roles: ['human', 'dispatcher'],
    // to 由 payload.targetColumn 决定（resolve 现在会把 payload 传进函数）
    to: (t, actor, payload) => String((payload && payload.targetColumn) || '') || null,
    phase: '',
    guard: (t, ctx) => {
      const payload = (ctx && ctx.payload) || {}
      const to = String(payload.targetColumn || '')
      if (!REWIND_TARGETS.includes(to)) {
        return '回退目标只能是 ' + REWIND_TARGETS.join(' / ') + '（收到：' + (to || '(空)') + '）。'
          + '已完成的卡想再来一次，请用 reopen（它会清掉上一轮快照并计入重开次数）'
      }
      const back = COLUMNS.indexOf(to)
      const now = COLUMNS.indexOf(t.column)
      if (back >= now) return '回退只能往更早的列走：当前 ' + t.column + '，目标是 ' + to + '（向前请用对应的前进动作）'
      if (!notEmpty(payload.reason)) return '回退必须写 reason（会写进历史：为什么退回这一步）'
      // 有 run 在跑时不能动列：run 的 stop 只认 running 列，退走了它就永远停不下来。
      if (t.activeRunId) return '这张卡还有运行中的 run（' + t.activeRunId + '），先让它停下来再回退'
      return null
    },
  },
  reopen: {
    from: ['done', 'cancelled'],
    roles: ['human'],
    to: 'todo',
    phase: '',
    guard: (t) => (notEmpty(t.reopenReason) ? null : '重开必须说明原因'),
  },
}

export const effectiveColumn = (t) => (t.blocked ? BLOCKED : t.column)

/**
 * 所有「批准方案、开工」的动作（v1.35 收拢）。
 * 原来 approvedRevision 只在 approve / approve_by_chief 上写，
 * approve_by_dispatcher 代批后 approvedRevision 一直是空 —— 审批绑版本（I6）在代批路径上是缺的。
 */
export const PLAN_APPROVALS = new Set(['approve', 'approve_by_chief', 'approve_by_dispatcher', 'approve_by_publish'])

/**
 * 审核结论 → 状态机动作（v1.35 收拢：tools.js / http.js 各写过一份三元式）。
 * approved 返回 null：审核通过**不移动卡片**，只记结论，真合并由合并事务做（v1.32：审核 ≠ 合并）。
 */
export function reviewActionOf(verdict) {
  const v = String(verdict || '').trim().toLowerCase()
  if (v === 'approved' || v === 'approve') return null
  if (v === 'risk') return 'review_risk'
  return 'review_conflict'
}

/** 校验一次迁移，不修改任务。返回 {ok:true, t} 或 {ok:false, reason}。 */
/**
 * 检查一次迁移是否允许。
 *
 * v1.28：guard 现在能拿到 ctx（{ role, actorId, payload }）。
 * 起因是 accept 的语义变复杂了：人自己点可以，代理代收必须带人类授权凭据 ——
 * 只看 task 是判断不出"这次是谁在点"的。
 */
export function checkTransition(task, action, actorRole, ctx = {}) {
  const rule = TRANSITIONS[action]
  if (!rule) return { ok: false, reason: 'unknown action: ' + action }
  // rewind 与 cancel 一样不吃「被阻塞就冻结」这一套：卡被卡住时，退回去往往正是解法。
  if (task.blocked && action !== 'cancel' && action !== 'rewind') return { ok: false, reason: '任务被阻塞，先 unblock' }
  if (!rule.from.includes(task.column)) {
    return { ok: false, reason: task.id + ' 当前列 ' + task.column + ' 不允许 ' + action + '（允许的来源列：' + rule.from.join('/') + '）' }
  }
  if (!rule.roles.includes(actorRole)) {
    return { ok: false, reason: '角色 ' + actorRole + ' 不能执行 ' + action }
  }
  if (rule.guard) {
    const reason = rule.guard(task, { ...ctx, role: actorRole })
    if (reason) return { ok: false, reason }
  }
  return { ok: true, rule }
}

/** 应用迁移，返回被修改的任务（浅拷贝）。调用方负责放进事务。 */
export function applyTransition(task, action, actor, payload = {}, extra = {}) {
  const check = checkTransition(task, action, actor.role, { actorId: actor && actor.id, payload, ...extra })
  if (!check.ok) throw new Error(check.reason)
  const rule = check.rule
  const next = { ...task }
  // to / phase 支持函数形式（例如 accept 在没有 Git 的项目上直接落到 done）
  const resolve = (v) => (typeof v === 'function' ? v(task, actor, payload) : v)
  const target = resolve(rule.to)
  const targetPhase = resolve(rule.phase)
  // to === null 表示「同列迁移」：只改 phase / 附属字段（v1.0 的 reassign / classify）
  // v1.31.3：记下"什么时候进的这一列"。
  // 看板要按"后移入的排前面"展示，判据必须是**进列时间**，
  // 不能用 updatedAt —— 后者改标题/加评论都会刷新，卡片会在列里乱跳。
  const columnChanged = target !== null && target !== undefined && target !== task.column
  if (target !== null && target !== undefined) next.column = target
  if (targetPhase !== undefined && targetPhase !== null) next.phase = targetPhase
  if (columnChanged) next.columnAt = nowIso()
  next.updatedAt = nowIso()
  // I5：任务版本严格单调，旧版本命令靠它拒绝。
  next.version = (task.version || 0) + 1
  if (PLAN_APPROVALS.has(action)) {
    next.plan = { ...next.plan, approvedAt: nowIso(), approvedRevision: next.plan.revision }
    // 谁批的：人类 / 主调度代批，事后要能查
    next.plan.approvedBy = (actor && (actor.id || actor.role)) || 'human'
  }
  if (action === 'accept') next.acceptedAt = nowIso()
  if (action === 'review_approve') next.mergedAt = nowIso()
  if (action === 'cancel') next.cancelledAt = nowIso()
  if (action === 'reopen') {
    // 重开回到「待办」，上一轮的快照全部清掉，但历史保留（T19 审计）。
    next.plan = { ...next.plan, approvedRevision: null, approvedAt: null }
    next.activeRunId = null
    next.stopReport = null
    next.headSha = null
    next.acceptedAt = null
    next.mergedAt = null
    next.cancelledAt = null
    next.lastReopenReason = task.reopenReason
    next.reopenCount = (task.reopenCount || 0) + 1
    // 真的重开了，代理挂的那条请求就结案了（否则看板会一直提示"有人申请重开"）
    next.reopenRequested = null
  }
  if (action === 'rewind') {
    // 退回去的卡不该再挂着上一轮的停止报告/阻塞原因 —— 它们描述的是「退之前」的现场。
    // stopReport 留着会让 verifying 的自动验收拿旧报告直接收；blocked 留着会让卡退回去后仍然推不动。
    next.stopReport = null
    next.blocked = null
    next.lastRewind = {
      from: task.column,
      to: target,
      reason: String(payload.reason || '').slice(0, 2000),
      at: next.updatedAt,
      by: (actor && (actor.id || actor.role)) || 'system',
    }
  }
  // column 记解析后的目标：rule.to 可能是函数（accept / rewind），直接写进历史会变成一段源码。
  const entry = { at: next.updatedAt, action, column: target === null || target === undefined ? task.column : target, actor: (actor && (actor.id || actor.role)) || 'system' }
  if (action === 'rewind') entry.reason = String(payload.reason || '').slice(0, 2000)
  if (action === 'reopen') entry.reason = task.reopenReason
  next.history = [...(task.history || []), entry]
  return next
}

/** 阻塞/解除：不是迁移，是旗子，保留原列。 */
export function blockTask(task, reason, actor) {
  if (!notEmpty(reason)) throw new Error('阻塞必须写原因')
  return {
    ...task,
    version: (task.version || 0) + 1,
    blocked: { reason, at: nowIso(), by: (actor && (actor.id || actor.role)) || 'system' },
    history: [...(task.history || []), { at: nowIso(), action: 'block', column: task.column, actor: (actor && (actor.id || actor.role)) || 'system', reason }],
  }
}
export function unblockTask(task, actor) {
  if (!task.blocked) throw new Error('任务没有被阻塞')
  const next = { ...task, blocked: null, updatedAt: nowIso(), version: (task.version || 0) + 1 }
  next.history = [...(task.history || []), { at: next.updatedAt, action: 'unblock', column: task.column, actor: (actor && (actor.id || actor.role)) || 'system' }]
  return next
}

// ---------------------------------------------------------------------------
// 租约：fencing token 单调递增，过期后旧 token 写不进去（设计文档 5.4）。
// ---------------------------------------------------------------------------

export const LEASE_TTL = 120000

export function acquireLease(state, key, owner, ttl = LEASE_TTL) {
  const at = Date.now()
  const cur = state.leases[key]
  if (cur && cur.expiresAt > at && cur.owner !== owner) {
    return { ok: false, reason: 'leased by ' + cur.owner }
  }
  const token = (cur ? cur.token : 0) + 1
  state.leases[key] = { key, owner, token, acquiredAt: at, expiresAt: at + ttl }
  return { ok: true, token }
}
export function renewLease(state, key, token, ttl = LEASE_TTL) {
  const cur = state.leases[key]
  if (!cur || cur.token !== token) return { ok: false, reason: 'fencing token mismatch' }
  cur.expiresAt = Date.now() + ttl
  return { ok: true }
}
export function releaseLease(state, key, token) {
  const cur = state.leases[key]
  if (cur && cur.token === token) delete state.leases[key]
}
export function assertFence(state, key, token) {
  const cur = state.leases[key]
  if (!cur || cur.token !== token) throw new Error('lease lost: ' + key)
  if (cur.expiresAt <= Date.now()) throw new Error('lease expired: ' + key)
}

// ---------------------------------------------------------------------------
// 事件与 outbox：先写 events（审计），再写 outbox（投递），同一事务。
// ---------------------------------------------------------------------------

export function emit(state, type, payload, actor = { role: 'system' }) {
  state.seq.event += 1
  const event = {
    id: 'ev_' + String(state.seq.event).padStart(6, '0'),
    seq: state.seq.event,
    at: nowIso(),
    type,
    actor: (actor && (actor.id || actor.role)) || 'system',
    causationId: currentCause(),
    payload: payload || {},
  }
  state.events.push(event)
  if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000)
  // outbox 必须带上 actor：事件驱动的"别通知自己"靠它判断触发者，
  // 以前只存了 payload，订阅者拿到的 event.actor 永远是 undefined，
  // 于是调度员会把自己的操作当成别人的、反复叫醒自己。
  state.outbox.push({ id: 'ob_' + event.id, eventId: event.id, type, payload: event.payload, actor: event.actor, causationId: event.causationId, at: event.at, attempts: 0, deliveredAt: null })
  // v1.22：outbox 以前没有上限，实测长到 4 万条、把 flow.json 撑到 15MB（每事务全量序列化的主因）。
  // 与 events 对齐留 5000 条：订阅者只消费最近的，更旧的历史已经在 events 里。
  if (state.outbox.length > 5000) state.outbox.splice(0, state.outbox.length - 5000)
  return event
}

// ---------------------------------------------------------------------------
// 事件管道（v0.3）：外部世界 → 归一化信封 → 去重入库 → 消费游标。
// 设计文档 15.4 TX-18 / TX-24：入库与去重同一事务；消费失败保留未消费位。
// ---------------------------------------------------------------------------

/**
 * 事件信封：
 * { source:'local'|'gitea'|'github'|'webhook', type, refKind, refId, dedupeKey, payload, at? }
 * dedupeKey 必须由调用方构造且全局唯一（例：gitea:issue:42:rev7）。
 */
export function ingestEvent(state, env) {
  const type = String((env && env.type) || '')
  if (!type) throw new Error('event.type 必填')
  const dedupeKey = String((env && env.dedupeKey) || '')
  if (!dedupeKey) throw new Error('event.dedupeKey 必填（重复投递靠它去重）')
  const dup = state.event_inbox.find((e) => e.dedupeKey === dedupeKey)
  if (dup) return { ok: false, duplicate: true, event: dup }
  state.seq.inbox += 1
  const rec = {
    id: 'in_' + String(state.seq.inbox).padStart(6, '0'),
    seq: state.seq.inbox,
    source: String(env.source || 'local'),
    type,
    refKind: env.refKind || null,
    refId: env.refId || null,
    dedupeKey,
    payload: env.payload || {},
    at: env.at || nowIso(),
    ingestedAt: nowIso(),
    consumedAt: null,
  }
  state.event_inbox.push(rec)
  if (state.event_inbox.length > 5000) state.event_inbox.splice(0, state.event_inbox.length - 5000)
  emit(state, 'event.ingested', { eventId: rec.id, type, source: rec.source })
  return { ok: true, event: rec }
}

/** 未消费的事件（tick 每轮取一批）。 */
export function pendingEvents(state, limit = 50) {
  const out = []
  for (const e of state.event_inbox) {
    if (!e.consumedAt) out.push(e)
    if (out.length >= limit) break
  }
  return out
}

/** 标记已消费；返回处理条数。 */
export function consumeEvents(state, ids) {
  const at = nowIso()
  let n = 0
  for (const id of ids || []) {
    const e = state.event_inbox.find((x) => x.id === id)
    if (e && !e.consumedAt) { e.consumedAt = at; n += 1 }
  }
  if (n) emit(state, 'event.consumed', { count: n })
  return n
}

// ---------------------------------------------------------------------------
// Store：单写者 + 快照回滚 + 原子落盘。
// ---------------------------------------------------------------------------

/**
 * 把一个布尔 noMerge + 一句人话 noMergeReason 归到 mergeState 的枚举上（ADR-0005）。
 *
 * 为什么按文本归类而不是按历史：v0.x 起 noMergeReason 一直是自由文本，
 * 线上真实长成的样子只有这几种（BiliNote 18 张卡实测）。归类错会把故障卡
 * 错标成"本来就不用合"，比不迁移更糟 —— 所以顺序很重要：先认故障，再认环境降级。
 */
export function inferMergeState(task) {
  if (task.noMerge !== true) return { state: 'ready', reason: null }
  const why = String(task.noMergeReason || '')
  if (/already used by worktree/i.test(why)) return { state: 'blocked', reason: 'branch-busy' }
  if (/一次提交都没有|invalid reference: HEAD/i.test(why)) return { state: 'blocked', reason: 'no-commits' }
  // not-a-repo 是 none 而不是 blocked：非 git 工作区**永远**没有分支可合，
  // 它是项目的结构属性、不是待修复的故障。标成 blocked 会让这类项目的每张卡
  // 都挂一个红标，而它们本来就该直接 done（v1.12 的语义）。
  // 两种写法都要认：迁移脚本写的是「不是 git 仓库」，派工路径写的是「非 Git 工作区」。
  // 只认前者的话，线上新产生的降级卡会落到 no-code-change，label 显示「没有代码改动」——
  // 状态没错（都是 none），但原因是错的，而这张表存在的意义就是让原因可读。
  if (/不是 git 仓库|不是 git|非 git/i.test(why)) return { state: 'none', reason: 'not-a-repo' }
  if (/基线|base/i.test(why) && /不存在|missing|invalid reference/i.test(why)) return { state: 'blocked', reason: 'base-missing' }
  return { state: 'none', reason: 'no-code-change' }
}

export const MIGRATIONS = {
  // 0 -> 1：早期无版本文件
  0: (data) => ({ ...emptyState(), ...data, schemaVersion: 1 }),
  // 1 -> 2：加事件管道、远程镜像、PR、worktree、注入、投递审计（v0.3）
  1: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 2 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    for (const key of ['event_inbox', 'injections', 'message_log']) {
      if (!Array.isArray(next[key])) next[key] = []
    }
    for (const key of ['event_cursors', 'issues_mirror', 'pull_requests', 'worktrees']) {
      if (!next[key] || typeof next[key] !== 'object') next[key] = {}
    }
    return next
  },
  // 2 -> 3：v1.0 三层监督 —— lane（人/issue 两条车道）、supervisorId（父代理）、
  // 任务阅读范围 scope、会话上下文预算 budget。只补默认值，不改既有语义。
  2: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 3 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    for (const key of ['agents', 'tasks', 'agent_sessions', 'projects']) {
      if (!next[key] || typeof next[key] !== 'object') next[key] = {}
    }
    for (const agent of Object.values(next.agents)) {
      if (agent.lane !== 'human' && agent.lane !== 'issue') agent.lane = 'human'
      if (agent.supervisorId === undefined) agent.supervisorId = null
      if (agent.scope === undefined) agent.scope = null
    }
    for (const task of Object.values(next.tasks)) {
      if (task.lane !== 'human' && task.lane !== 'issue') task.lane = 'human'
      if (!task.scope || typeof task.scope !== 'object') task.scope = { paths: [], symbols: [] }
      if (!Array.isArray(task.scope.paths)) task.scope.paths = []
      if (!Array.isArray(task.scope.symbols)) task.scope.symbols = []
      if (!Array.isArray(task.subtasks)) task.subtasks = []
      if (task.inspection === undefined) task.inspection = null
      if (task.originRef === undefined) task.originRef = null
      if (task.dispatchedBy === undefined) task.dispatchedBy = null
      if (task.dispatchReason === undefined) task.dispatchReason = null
    }
    for (const rec of Object.values(next.agent_sessions)) {
      if (!rec.budget || typeof rec.budget !== 'object') rec.budget = { tokens: 0, ratio: 0, checkedAt: null, compactBlockedAt: null }
    }
    for (const project of Object.values(next.projects)) {
      project.lanes = normalizeLanes(project.lanes)
    }
    return next
  },
  /**
   * 3 -> 4：v1.22 项目级双向同步。
   *
   * 只补默认值，不动既有语义；已存在的 remote 身份/游标绝不覆盖（迁移要幂等，
   * 因为 load() 失败重试时会再跑一次同样的链）。
   */
  3: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 4 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    if (!next.remote_sync || typeof next.remote_sync !== 'object') next.remote_sync = {}
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (task.remote === undefined) task.remote = null
      if (task.runSeq === undefined) task.runSeq = 0
      if (task.retryAfter === undefined) task.retryAfter = null
      if (task.risk === undefined) task.risk = null
      if (task.reviewRemindedAt === undefined) task.reviewRemindedAt = null
    }
    for (const c of Array.isArray(next.task_comments) ? next.task_comments : []) {
      if (c && c.remote === undefined) c.remote = null
    }
    for (const pr of Object.values(next.pull_requests || {})) {
      if (pr && pr.remote === undefined) pr.remote = null
    }
    for (const run of Object.values(next.runs || {})) {
      if (!run || typeof run !== 'object') continue
      if (run.seq === undefined) run.seq = 0
      if (run.infraAttempts === undefined) run.infraAttempts = 0
      if (run.attempts === undefined) run.attempts = 0
    }
    for (const mirror of Object.values(next.issues_mirror || {})) {
      if (mirror && mirror.labels === undefined) mirror.labels = []
    }
    return next
  },
  // 4 -> 5：加全局控制位（一键停止全部调度）。
  // 老文件没有 control，一律按"未被停止"处理——迁移不该把一个在跑的系统
  // 突然冻住，停不停由人再按一次按钮决定。
  4: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 5 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    if (!next.remote_sync || typeof next.remote_sync !== 'object') next.remote_sync = {}
    const ctl = next.control && typeof next.control === 'object' ? next.control : {}
    next.control = {
      halted: ctl.halted === true,
      haltedAt: ctl.haltedAt || null,
      haltedBy: ctl.haltedBy || null,
      reason: ctl.reason || null,
    }
    return next
  },
  /**
   * 5 -> 6：v1.31 调度员请示箱 + 自动推进标记。
   *
   * 只补默认值、不动既有语义。迁移必须幂等（load 失败重试会再跑一遍链），
   * 所以每处都是"缺了才补"而不是直接赋值。
   */
  5: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 6 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    if (typeof next.seq.humanInbox !== 'number') next.seq.humanInbox = 0
    if (!Array.isArray(next.human_inbox)) next.human_inbox = []
    // v1.31：自动推进的防抖与阻塞标记。老卡一律按"还没推过"处理，
    // 这样升级后第一拍就会把它们从 todo/planning 推到该去的地方。
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (task.advanceAt === undefined) task.advanceAt = null
      if (task.advanceKey === undefined) task.advanceKey = null
      if (task.advanceBlocked === undefined) task.advanceBlocked = null
      if (task.planRemindedAt === undefined) task.planRemindedAt = null
    }
    return next
  },
  /**
   * 6 -> 7：v1.31.3 看板按"后移入的排前面"。
   *
   * 新字段 columnAt（进列时间）。老数据没有，用 updatedAt 再退到 createdAt 回填 ——
   * 不补的话排序函数里全是空串，列内顺序会退化成"对象插入顺序"，
   * 而那个顺序恰恰是我们要改掉的"最老的排最前"。
   *
   * 回填用的时间戳不精确（updatedAt 可能是改标题刷新的），但只影响历史卡的相对次序，
   * 新卡从这一刻起用真实的 columnAt，不会再漂。
   */
  6: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 7 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (typeof task.columnAt !== 'string') {
        task.columnAt = task.updatedAt || task.createdAt || null
      }
    }
    return next
  },
  /**
   * 7 -> 8：v1.35 副作用意图表（effects）+ 合并意图（task.mergeIntent）。
   * 只补默认值：老数据里没有任何「待执行的副作用」，空表就是正确的初值。
   */
  7: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 8 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    if (!next.effects || typeof next.effects !== 'object') next.effects = {}
    for (const task of Object.values(next.tasks || {})) {
      if (task && typeof task === 'object' && task.mergeIntent === undefined) task.mergeIntent = null
    }
    return next
  },
  /**
   * 8 -> 9: v1.36 maintenance slot + model cooldowns + inspect history.
   * Only fills defaults; old data starts recording inspections from this round.
   */
  8: (data) => {
    const base = emptyState()
    const next = { ...base, ...data, schemaVersion: 9 }
    next.seq = { ...base.seq, ...(data.seq || {}) }
    if (!next.maintenance || typeof next.maintenance !== 'object') next.maintenance = { lastWorktreeGcAt: null }
    if (!next.model_cooldowns || typeof next.model_cooldowns !== 'object') next.model_cooldowns = {}
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (!Array.isArray(task.inspectHistory)) task.inspectHistory = []
      if (task.inspectionSignals === undefined) task.inspectionSignals = null
      if (task.mergeRequest && task.mergeRequest.postMergeCheck === undefined) task.mergeRequest.postMergeCheck = null
    }
    return next
  },

  // v1.37 迁移：
  // ① 合并重复请示：同 taskId+kind+from 只保留最早一条，其余归档。回复合并进去。
  // ② 存量请示补写 dedupeKey（之前没有这个字段）。
  9(data) {
    const next = { ...data, schemaVersion: 10 }
    const inbox = Array.isArray(next.human_inbox) ? next.human_inbox : []
    /** 每个 dedupeKey 保留第一条（id 最小的），其余标 archived。 */
    const seen = new Map()  // dedupeKey → 保留的 item
    for (const item of inbox) {
      if (item.kind === 'info') {
        // info 不去重，只补 dedupeKey
        if (!item.dedupeKey) item.dedupeKey = null
        continue
      }
      const key = [item.taskId, item.kind, item.from].filter(Boolean).join('|')
      item.dedupeKey = key
      if (item.status === 'archived') continue
      const kept = seen.get(key)
      if (!kept) { seen.set(key, item); continue }
      // 把这条的回复并入保留的那条
      if (Array.isArray(item.replies) && item.replies.length) {
        kept.replies = (kept.replies || []).concat(item.replies)
        kept.replies.sort((a, b) => String(a.at) < String(b.at) ? -1 : 1)
      }
      // 归档这条
      item.status = 'archived'
      item.archivedAt = item.archivedAt || new Date().toISOString()
      item.resolvedAt = item.resolvedAt || item.archivedAt
      item.resolvedNote = 'v1.37 迁移：重复工单，已合并回复到 ' + kept.id
      item.duplicateOf = kept.id
    }
    next.human_inbox = inbox
    return next
  },

  // v1.39 迁移：父卡 / 子卡 + 工作包工单 + grill 评审 + Inbox 结构化字段。
  // 只补默认值，不动既有语义：老卡 parentId=null / childIds=[] / ticket=null，行为与 v1.38 完全一致。
  10(data) {
    const next = { ...data, schemaVersion: 11 }
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (task.parentId === undefined) task.parentId = null
      if (!Array.isArray(task.childIds)) task.childIds = []
      if (task.ticket === undefined) task.ticket = null
      // 子卡默认不上看板（只在父卡详情里显示和打开）
      if (task.hiddenOnBoard === undefined) task.hiddenOnBoard = false
      if (task.grill === undefined) task.grill = null
    }
    // Inbox：老工单补结构化字段（问句由读侧 upgradeInboxItem 兜底，这里只保证数组/对象存在）
    for (const item of (Array.isArray(next.human_inbox) ? next.human_inbox : [])) {
      if (!item || typeof item !== 'object') continue
      if (!Array.isArray(item.asks)) item.asks = []
      if (!item.context || typeof item.context !== 'object') item.context = { facts: [], evidence: [] }
      if (item.impactIfNoAnswer === undefined) item.impactIfNoAnswer = ''
    }
    return next
  },

  // v0.002 迁移：让"要不要合并"和"这个检出处在什么状态"各自成为字段（ADR-0005 / ADR-0006）。
  //
  // 刻意只加字段、不切读侧：needsMerge 仍读 noMerge（lib/core.js needsMerge），
  // 分家留到 I-12 一次切干净。这样本条迁移的行为增量是零 —— 老数据加载后跑出来的
  // 结果必须与 v0.001 一模一样，否则就是回归。
  11(data) {
    const next = { ...data, schemaVersion: 12 }
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (task.mergeState === undefined) {
        const inferred = inferMergeState(task)
        task.mergeState = inferred.state
        task.mergeReason = inferred.reason
      }
      if (task.mergeDetail === undefined) task.mergeDetail = null
      // 老卡经常没有 noMerge 字段（= undefined）。归一成布尔，让后续 needsMerge 的判断与
      // setMergeState 写出来的一致：undefined 与 false 在 `=== false` 比较里等价，在 `=== true` 里也等价，
      // 但记录里出现两种"没合并"会让对账与迁移归类变难。
      if (task.noMerge === undefined) task.noMerge = false
    }
    // worktree 记录本来就有 state 字段（recordWorktree 写 'ready'），这里只补两类：
    // 一是历史记录缺 state 的，二是新增的 patchPath（隔离证据，ADR-0006）。
    for (const wt of Object.values(next.worktrees || {})) {
      if (!wt || typeof wt !== 'object') continue
      if (!wt.state) wt.state = 'ready'
      if (wt.patchPath === undefined) wt.patchPath = null
    }
    return next
  },

  // v0.003 迁移：卡片生命周期闭环（rf-01..rf-04）需要的四个字段。
  //
  // 只补字段、不切行为：kind / visibility / external / branchFrom / integrationBranch
  // 在 v0.002 的代码里没有任何读者，所以本条迁移的行为增量是零 —— 老数据加载后
  // 跑出来的结果必须与 v0.002 一模一样，否则就是回归。
  //
  // 刻意**不**给已经存在的子卡回填 branchFrom：
  // 那些子卡是从 base 拉出来的（v0.002 的语义），它们的父分支在 git 里根本不存在。
  // 回填成 flow/<parentId> 会让它们下次派工时被 ensureWorktree 判成 branch-missing
  // —— 迁移把好卡改成坏卡，是这里最不能犯的错。只有 splitTask 新建的子卡才带 branchFrom。
  12(data) {
    const next = { ...data, schemaVersion: 13 }
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (task.kind === undefined) task.kind = 'card'
      if (task.visibility === undefined) task.visibility = 'board'
      if (task.external === undefined) task.external = null
      if (task.branchFrom === undefined) task.branchFrom = null
      if (task.integrationBranch === undefined) task.integrationBranch = null
    }
    return next
  },

  // v0.008（C-10）迁移：把「有父卡的卡」标成工作单元。
  //
  // 判据只有一条：这张子卡**是不是已经有自己的分支**。
  //   legacy-branch —— 老语义建的（一卡一分支、自己开过 PR）。迁移不硬改历史，只打标记：
  //                    accept 时把它的分支合进父分支，再收掉子分支与 PR 快照。
  //   shared        —— 新语义：与父卡共用检出与分支，只产生提交。
  // 幂等：已经有 unitMode 的不动（load() 失败重试会把整条链再跑一遍）。
  // 非子卡刻意**不写**这个字段：它只为子卡存在，给普通卡补 null 会让
  // 「这张卡有没有 unitMode」失去区分力，而迁移的判据正是「有没有父卡」。
  13(data) {
    const next = { ...data, schemaVersion: 14 }
    for (const task of Object.values(next.tasks || {})) {
      if (!task || typeof task !== 'object') continue
      if (!task.parentId) continue
      if (task.unitMode === 'shared' || task.unitMode === 'legacy-branch') continue
      const wt = (next.worktrees && next.worktrees[task.id]) || task.worktree || {}
      const branch = (wt && wt.branch) || null
      // 共用检出的投影里 branch 写的是**父分支**（recordWorktree 会带 shared:true），
      // 那不是「自己的分支」——按它判 legacy 会把刚建出来的共享记录误判成老卡。
      const parentBranch = 'flow/' + String(task.parentId)
      const ownBranch = !!branch && branch !== parentBranch && wt.shared !== true
      task.unitMode = ownBranch ? 'legacy-branch' : 'shared'
    }
    return next
  },

  // v0.012 迁移：工单箱补「已读」与「预设组件」。
  //
  // 只有两件事要回填，且都不能动 status（status 是工单状态，readAt 是阅读状态，正交）：
  //   · blocks = []        —— 老工单没有预设组件，渲染层按空数组处理；
  //   · readAt             —— 已经归档的工单视为读过（否则打开收件箱会冒一片未读点，
  //                           而那些恰恰是处理完的）；其余保持 null（未读）。
  // 幂等：已经有 readAt 键（含 null）的不动 —— 注意 `!== undefined`，不能用 `||`。
  14(data) {
    const next = { ...data, schemaVersion: 15 }
    for (const item of next.human_inbox || []) {
      if (!item || typeof item !== 'object') continue
      if (!Array.isArray(item.blocks)) item.blocks = []
      if (item.readAt === undefined) {
        item.readAt = item.status === 'archived' ? (item.archivedAt || item.updatedAt || item.createdAt || null) : null
      }
      for (const reply of item.replies || []) {
        if (reply && typeof reply === 'object' && !Array.isArray(reply.blocks)) reply.blocks = []
      }
    }
    return next
  },
}

/**
 * 两条车道的默认配置。
 * human 车道保持 v0.x 的既有默认（1 调度 + 2 工人），保证老配置零迁移；
 * issue 车道默认 0 工位——它由外部事件驱动，首次入站时懒补齐（见 domain.ensureLaneAgents），
 * 避免只想用人直派的项目凭空多出一套工位。
 */
export const DEFAULT_LANE_CONFIG = { human: { dispatchers: 1, workers: 2, maxActivePerDispatcher: 3 }, issue: { dispatchers: 0, workers: 0, maxActivePerDispatcher: 3 } }

export function normalizeLanes(lanes) {
  const src = lanes && typeof lanes === 'object' ? lanes : {}
  const one = (fallback, v) => ({ ...fallback, ...(v && typeof v === 'object' ? v : {}) })
  return {
    human: one(DEFAULT_LANE_CONFIG.human, src.human),
    issue: one(DEFAULT_LANE_CONFIG.issue, src.issue),
  }
}

export class Store {
  constructor(file) {
    this.file = file
    this.state = emptyState()
    this.queue = Promise.resolve()
    this.loaded = false
    this.readyPromise = null
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8')
      let data = JSON.parse(raw)
      let version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0
      const from = version
      while (version < SCHEMA_VERSION) {
        const migrate = MIGRATIONS[version]
        if (!migrate) throw new Error('no migration from schemaVersion ' + version)
        data = migrate(data)
        version = data.schemaVersion
      }
      // 迁移过就立刻落盘：否则每次启动都在内存里重放，且崩溃会回到旧版本
      if (from !== version) {
        this.state = { ...emptyState(), ...data }
        await this.persist()
      }
      if (version > SCHEMA_VERSION) throw new Error('flow data is newer than this plugin (' + version + ')')
      this.state = { ...emptyState(), ...data }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.state = emptyState()
        await this.persist()
      } else {
        throw err
      }
    }
    this.loaded = true
    // 启动时顺手扫一遍孤儿 tmp（不阻塞启动，失败也不影响加载）
    this.sweepStaleTmp().catch(() => {})
    return this.state
  }

  /**
   * 启动即加载磁盘状态，读写共用同一个 promise。
   * 读接口（snapshot / agentSession / 工具）不走 tx，没有它重启后会看到空工作台。
   */
  ready() {
    if (this.loaded) return Promise.resolve(this.state)
    if (!this.readyPromise) {
      this.readyPromise = this.load().catch((err) => {
        this.readyPromise = null
        throw err
      })
    }
    return this.readyPromise
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }

  /** 串行事务：抛错整份回滚。返回 fn 的返回值。 */
  async tx(fn) {
    const run = this.queue.then(async () => {
      if (!this.loaded) await this.ready()
      const before = this.snapshot()
      try {
        const result = await fn(this.state)
        await this.persist()
        return result
      } catch (err) {
        this.state = before
        throw err
      }
    })
    // 队列不能因为一次失败而卡死
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async persist() {
    await mkdir(dirname(this.file), { recursive: true })
    // tmp 名必须唯一：同一进程里若出现两个 Store 指向同一文件（测试常见，
    // 线上虽然单写者但也不该赌），光用 pid 会互相踩 —— 一个 rename 完，
    // 另一个的 tmp 就没了，报 ENOENT。加自增序号把这种竞态关掉。
    this._persistSeq = (this._persistSeq || 0) + 1
    const tmp = this.file + '.' + process.pid + '.' + this._persistSeq + '.tmp'
    try {
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      await this.replaceFile(tmp, this.file)
    } catch (err) {
      // v1.39.2：写失败必须自己收拾 tmp。
      // 线上 flow 目录里曾经堆了 1000+ 个 3~14MB 的 *.tmp（合计 12GB）——
      // 每一个都是"写成功、rename 失败"或"写到一半进程被杀"留下的。
      // 这些文件永远没人读，只会一直吃磁盘。
      await unlink(tmp).catch(() => {})
      throw err
    }
  }

  /**
   * 清理同目录下的孤儿 tmp（v1.39.2）。
   *
   * persist 先写 `<file>.<pid>.<seq>.tmp` 再 rename。rename 在 Windows 上会因为
   * 目标被读句柄占住而 EPERM，重试仍失败时旧代码直接抛出 —— tmp 就留在盘上。
   * 进程被 kill -9 也会留下这种文件。它们没有任何用途（真相源是正式文件），
   * 只会在每次落盘时多占一份全量快照（线上有 3~14MB 一份的）。
   *
   * 只删"明显已经没人要"的：跳过本进程自己的 tmp，且只删 mtime 早于
   * STALE_TMP_MS 的 —— 别的进程可能正在写，删掉它会让那次事务报 ENOENT。
   */
  async sweepStaleTmp(now = Date.now()) {
    const dir = dirname(this.file)
    const base = basename(this.file)
    const me = '.' + process.pid + '.'
    let names = []
    try { names = await readdir(dir) } catch { return 0 }
    let removed = 0
    for (const name of names) {
      if (!name.startsWith(base + '.') || !name.endsWith('.tmp')) continue
      const seqPart = name.slice(base.length)
      if (seqPart.startsWith(me)) continue
      const full = join(dir, name)
      let info = null
      try { info = await stat(full) } catch { continue }
      if (now - info.mtimeMs < STALE_TMP_MS) continue
      try { await unlink(full); removed += 1 } catch { /* 别的进程刚好收走了，忽略 */ }
    }
    if (removed) this._sweptTmp = (this._sweptTmp || 0) + removed
    return removed
  }

  /**
   * tmp -> 正式文件的重命名，带 Windows 退避重试。
   *
   * 线上踩过：\`rename EPERM: operation not permitted\`。Windows 上 rename 覆盖一个
   * 15MB 的既有文件时，只要目标此刻被任何进程持有读句柄（杀毒扫描、Everything 建索引、
   * 编辑器/脚本 tail 日志），就会失败；POSIX 上这是原子换指针，压根不会有这种错。
   * 退避重试几十毫秒就够——这不是竞争写，是瞬时锁。
   *
   * 全部重试都失败才抛：宁可这一次事务报错（上层回滚、下次 tick 再来），
   * 也不要留半份文件或静默丢写。
   */
  async replaceFile(from, to) {
    const retryable = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'EEXIST'])
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await rename(from, to)
        return
      } catch (err) {
        const code = err && err.code
        if (!retryable.has(code) || attempt === 6) throw err
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt))
      }
    }
  }
}
