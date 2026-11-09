/**
 * dsh-flow · domain
 *
 * 所有写操作都走 store.tx()：一次动作 = 一次事务 = 一条事件 = 一条 outbox。
 * runtime 是可注入的 DSH 适配层（sessionController / workspaceController / goal），
 * 没装 DSH 时传 null，领域逻辑照样跑，只是把“要开会话”记成 pending 事件。
 */

import {
  newId, nowIso, clampText, emit, applyTransition, checkTransition,
  blockTask, unblockTask, acquireLease, renewLease, releaseLease, assertFence,
  ingestEvent, pendingEvents, consumeEvents,
  COLUMNS, COLUMN_TITLE, effectiveColumn,
  normalizeLanes, DEFAULT_LANE_CONFIG, COMMENT_MAX,
  withCause, PLAN_APPROVALS, reviewActionOf, sanitizeLossless, inferMergeState,
} from './core.js'
import { pickByScope, workerScopeProfile, overlapScope, budgetRisk } from './scope.js'
// v1.36：巡检信号（连续无产出 / 同错误码 / 预算耗尽）
import { analyzeCycles } from './inspect-signals.js'
// v1.36：拆出去的领域模块（原型混入，调用点不变）
import { inboxMethods } from './domain/inbox.js'
// v1.39：拆分 / 工作包工单 / 结构化八问的纯函数
import { normalizeSplitItem, overlapPaths, assertNoCycle, renderTicketPlan, renderSplitTable, EIGHT_QUESTIONS } from './split.js'
import { syncMirrorMethods } from './domain/sync-mirror.js'
import { ensureSyncState, emptySyncState, newNonce, flowMarker, hasFlowMarker, stripFlowMarker, diffLabels, desiredLabels, scrubOutbound, LABEL_COLORS, assessPlanRisk } from './sync.js'

const NL = String.fromCharCode(10)

// 非空判定：core 里的 notEmpty 是私有的，domain 也需要，模块级留一个。
const notEmpty = (v) => typeof v === 'string' && v.trim().length > 0

const DEFAULT_PROMPTS = [
  { name: 'R-API 破坏', severity: 'block', order: 10, prompt: '是否改了已导出的类型/函数签名、事件格式、CLI 参数、持久化字段语义；调用方是否跟着改。' },
  { name: 'R-跨模块重构', severity: 'block', order: 20, prompt: 'diff 是否跨 3 个以上模块、是否搬动目录或改依赖方向；改动面是否与任务描述匹配。' },
  { name: 'R-敏感路径', severity: 'block', order: 30, prompt: '是否触碰鉴权、迁移脚本、CI、密钥/环境变量、发布配置。' },
  { name: 'R-依赖升级', severity: 'warn', order: 40, prompt: '是否新增/升级依赖，锁文件是否变化，版本范围是否放宽。' },
  { name: 'R-覆盖不足', severity: 'block', order: 50, prompt: '验收标准每条是否有对应测试或可复现命令；缺证据不算通过。' },
  { name: 'R-回滚困难', severity: 'block', order: 60, prompt: '是否含数据迁移、不可逆写入、外部副作用；失败能否 revert。' },
]

/** 项目默认配置：新项目从这里铺开（也用于老项目补缺失字段）。 */
/**
 * 合并状态（ADR-0005）。写入口只有 FlowDomain.setMergeState 一个。
 *
 * blocked 与 none 的区别是：blocked 是"在等人/等环境修"，必须在看板上显形；
 * none 是"这张卡本来就不用合"，应当静默 —— 否则每张只读审计卡都挂一个黄标，
 * 看板就再也扫不出真正卡住的那几张。
 */
export const MERGE_STATES = ['none', 'pending', 'blocked', 'ready']

/**
 * 派工前的检出意图锁（ADR-0006 §2 / I-07）。
 *
 * 这个锁的存活时间故意很短：它只覆盖"读 git → 写 creating → addWorktree"这一小段。
 * TTL 长了会变成新的泄漏源（崩溃后这张卡几十分钟不能派工）；短了则会穿透 ——
 * 但穿透的后果由"锁内重读 git"兜住，不会重复 add。
 */
export const WORKTREE_LOCK_TTL = 30 * 1000

/** creating 意图的失效期：超过这么久还没落成 ready/blocked，就当它是崩溃残留。 */
export const CREATING_STALE_MS = 2 * 60 * 1000

/** 合并事务锁的存活时间（ADR-0004 §7）。见 lockMerge 的注释。 */
export const MERGE_LOCK_TTL = 10 * 60 * 1000

export const DEFAULT_CONFIG = {
  dispatchers: 1,
  workers: 2,
  allowedSkills: null,             // v1.40：只决定向 AI 暴露哪些技能（null = 全部；[] = 一个都不暴露）；不在列表里的技能仍可按名投递
  grillSkill: 'grilling',
  grillMaxRounds: 4,
  inspectMs: 10 * 60 * 1000,
  maxActivePerDispatcher: 3,
  workerMaxGoalRounds: 0,
  autoResume: true,
  // ---- v0.3（设计文档 14.9 / 15.4） ---------------------------------------
  chiefs: 1,                       // 总调度者数量（只读工作区，聊天的人）
  autoDispatch: false,             // tick 是否自动补位派工
  dispatchIntervalMs: 15000,       // tick 周期
  maxInFlightPerProject: 3,        // 同项目并行任务上限
  stuckAfterMs: 30 * 60 * 1000,    // 心跳过期多久算卡死（替代 inspectMs）
  autoAccept: false,               // 有证据的停止报告可否自动验收
  autoMerge: false,                // 审核通过后是否自动合并
  mergeStrategy: 'merge',          // merge | squash | rebase
  // 空串 = 自动探测（defaultBranch()：origin/HEAD → main|master → 当前分支 → symbolic-ref）。
  // 写死 'main' 会在 master 仓库上静默用错基线（真值短路掉后面的探测）。
  baseBranch: '',
  worktreeRoot: '',                // 空 = <项目路径>/.flow-worktrees
  /**
   * 检出的准备命令（ADR-0003）。只在 ensureWorktree 建出**新**检出后跑，cwd 就是那个检出。
   * 形状：{ commands: string[], timeoutMs?: number }；不配 = 什么都不跑。
   *   setup   —— 低成本准备（拷 .env、建本地数据目录），失败算 fatal。
   *   install —— 装依赖（uv sync / pnpm install）。失败算 fatal：没有依赖的检出等于没法开工。
   * 为什么放在项目配置而不是仓库里：这是「这台机器怎么准备环境」，不该进版本库。
   */
  setup: null,
  // v0.016（ticket 02）：建检出时从主仓库只读拷进来的密文本。null = 用默认 [.env, .env.local]。
  env: null,
  install: null,
  // C-11：子卡能不能并行。true = 按 scope 判互斥、不互斥就各给一条瞬时分枝（ADR-0003：各装各的依赖）；
  // false = 回到 v0.009 的全串行（同一父卡下所有子卡共用父检出排队）。
  // 默认开：串行会让人以为「这个功能慢」，而真实原因只是两张互不相关的卡在互相等。
  unitParallel: true,
  /**
   * 共享目录（默认空，ADR-0003）。只该放**只读**目录。
   * 不要放 .venv / node_modules：链接会让工人的测试跑在别人的环境上，绿了也不说明问题。
   */
  sharedDirs: [],
  remote: null,                    // { kind:'gitea'|'github', baseUrl, owner, repo, token }
  /**
   * 是否记录远程 issue（默认 **false** = 纯本地看板模式）。
   *
   * 关掉时：不建 issue 车道工位、不同步远程 issue、不暴露任何自动化开关——
   * 任务全靠人/主调度在看板上建。开着时才有 issue 自动调研这条链路。
   * 为什么要开关：issue 自动维修会自己建卡、自己烧模型，很多项目就是本地派活，
   * 不该因为插件装了就被动接上游事件。
   */
  recordIssues: false,
  /**
   * 拉「别人提的 PR」并建受限合并卡（rf-03 / C-02，默认关）。
   *
   * 为什么与 recordIssues 分开：原来一个开关同时管「issue 建不建卡」和「PR 发不发出去」，
   * 「issue 不必落卡、但 PR 照接」这种组合根本表达不出来（C-01 已把发 PR 的闸门拆成 recordPulls）。
   * 关着时一个远程请求都不发 —— 判据在 sync-engine.ingestExternalPulls 的最前面。
   */
  recordPulls: false,
  // rf-05：合并落地后关掉对应的远程 PR（只关 PR，不删远程分支）。
  // 默认开：不关的话仓库里会堆一堆「本地已合、远程还开着」的 PR，与看板对不上。
  closePullOnMerge: true,
  /**
   * 项目级的"新建工位用什么模型"。
   *
   * 为什么要存：DEFAULT 模型是**全局当前选择**，换个对话就变了。
   * 工位如果留空（null），界面就只能显示"沿用默认"，看起来像配置跟着对话串台；
   * 而工位真正的会话模型并不会变，于是显示与实际对不上。
   * 存在项目上，就是"这个项目的工位统一用这个模型"，与谁在哪个对话无关。
   */
  defaultProvider: null,
  defaultModel: null,
  defaultReasoningEffort: null,
  pushRemote: false,               // 本地卡是否外推成远程 issue
  // v1.29：卡进 done/cancelled 时是否把对应 issue 关掉。
  // 以前是 `!== false` 的隐式默认（实际也是开），但配置里看不到这个开关，人不知道有它。
  issueCloseEnabled: true,
  injectionMaxBytes: 4096,         // 单条注入上限（设计文档 14.8）
  promptOverlay: '',               // 项目级 prompt 覆盖：拼在角色 prompt 之前（设计文档 2.5）
  // ---- v1.0（三层监督 / 同域分派 / 上下文预算） ---------------------------
  lanes: null,                     // { human:{dispatchers,workers,maxActivePerDispatcher}, issue:{...} }；null = 按默认补齐
  hotWorkerStreak: 3,              // 同一工人连续被选中多少次后强制轮转
  scopeDecayTasks: 5,              // 工人阅读画像取最近 N 个完成任务
  // ---- 会话重置（毒会话判定 / 调度员重置保护） -------------------------------
  // 重建会话会丢掉整段上下文，前缀缓存全部失效，所以默认保守：
  poisonRebuild: false,            // 连续卡死/超时达到阈值时是否自动重建工人会话（关 = 只计数并评论提醒）
  poisonStuckThreshold: 3,         // 连续多少次卡死/超时算毒会话
  workerResetPolicy: 'guarded',    // 调度员 flow_worker_reset：allow 直接放行 / guarded 工人近期有活动则拒绝 / deny 一律拒绝
  workerResetQuietMs: 600000,      // guarded 下工人需静默多久（毫秒）才允许被调度员重置；run 刚开始也算活动
  maxSteersWithoutProgress: 3,     // 两次结构化进度之间，调度对同一工人同一张卡最多催几次；再催就拒绝，要求标阻塞或请示人
}

/** 审核结论的唯一值域：approved / needs_work / risk。兼容历史 'approve'。 */
export function normalizeVerdict(v) {
  const s0 = String(v || '').trim().toLowerCase()
  if (s0 === 'approved' || s0 === 'approve') return 'approved'
  if (s0 === 'risk') return 'risk'
  if (s0 === 'conflict' || s0 === 'needs_work' || s0 === 'changes_requested') return 'needs_work'
  return s0 || 'needs_work'
}

const must = (cond, message) => { if (!cond) throw new Error(message) }

// ---------------------------------------------------------------------------
// v1.35：副作用意图（effects）
// ---------------------------------------------------------------------------

/** 有运行时副作用的迁移（与 dispatch.onMoved / onStopped 的路由一致）。 */
export const EFFECT_ACTIONS = new Set([
  'cancel', 'approve', 'approve_by_chief', 'approve_by_dispatcher', 'approve_by_publish',
  'rework', 'review_conflict', 'claim', 'accept', 'pr_open', 'stop',
])
/** 卡被后续迁移推走后就不该再执行的副作用（派工类）。收尾类（stop/cancel）必须照做。 */
const STALE_SENSITIVE = new Set(['approve', 'approve_by_chief', 'approve_by_dispatcher', 'approve_by_publish', 'rework', 'review_conflict', 'claim', 'accept', 'pr_open'])
export const EFFECT_MAX_ATTEMPTS = 5
/** 人回复里的明确否定（用在验收授权核验上；拿不准的不算否定，交给调度判断）。 */
const REJECT_REPLY_RE = /^(不|别|否|不行|不可以|不同意|不通过|驳回|拒绝|no\b|nope|reject)/i

function enqueueEffect(s, { kind, taskId, action, taskVersion, causationId }) {
  if (!s.effects || typeof s.effects !== 'object') s.effects = {}
  s.seq.effect = (Number(s.seq.effect) || 0) + 1
  const id = 'fx_' + String(s.seq.effect).padStart(6, '0')
  s.effects[id] = {
    id,
    // 幂等键：同一张卡同一版本同一动作只有一条意图（设计文档 §3.1）
    key: kind + ':' + taskId + ':' + action + ':v' + taskVersion,
    kind, taskId, action, taskVersion, causationId: causationId || null,
    status: 'pending', attempts: 0,
    createdAt: nowIso(), startedAt: null, endedAt: null, nextAt: null,
    result: null, lastError: null, reason: null,
  }
  // 已结束的意图只留最近 2000 条（审计在 events 里，这里只是收敛用的工作表）
  const ids = Object.keys(s.effects)
  if (ids.length > 2500) {
    for (const old of ids.slice(0, ids.length - 2000)) {
      const st = s.effects[old] && s.effects[old].status
      if (st === 'done' || st === 'skipped' || st === 'dead') delete s.effects[old]
    }
  }
  return id
}

/** 副作用返回值只留可展示的几个字段（不把整个 PR/会话对象塞进状态文件）。 */
function summarizeEffectResult(out) {
  if (!out || typeof out !== 'object') return { ok: out !== false }
  const pick = {}
  for (const k of ['ok', 'message', 'agentId', 'sessionId', 'runId', 'waiting', 'skipped', 'duplicate', 'degraded']) {
    if (out[k] !== undefined && (typeof out[k] !== 'object' || out[k] === null)) pick[k] = out[k]
  }
  if (pick.ok === undefined) pick.ok = true
  if (typeof pick.message === 'string') pick.message = pick.message.slice(0, 300)
  return pick
}

/**
 * v1.29：评论 id 生成。
 *
 * 以前 4 个写入点各自写 `"c_" + String(s.seq.comment).padStart(5, "0")`，问题是：
 *   - seq.comment 是**全局**计数器，跨项目共享：项目 A 的评论号会被项目 B 撑大；
 *   - padStart(5) 只在 99999 以内有效，越过之后位数变化，格式不再统一；
 *   - 计数器与评论生命周期解耦（删卡不回退），id 里读不出任何上下文。
 *
 * 改成和 prj / mr / rp 一样的 newId 风格：`c_` + base36 时间戳 + 序号 + 随机，
 * 天然唯一、与全局计数无关。旧 id（c_00082 这种）**保留不迁移** ——
 * 读取侧只做字符串匹配，marker 也只匹配 `<!-- dsh-flow ... -->` 整体、不解析 id，所以新旧可以共存。
 *
 * seq.comment 仍然自增：留着它是因为历史数据和外部脚本可能读它，删字段属于破坏性改动。
 */
export function nextCommentId(s) {
  if (s && s.seq) s.seq.comment = (Number(s.seq.comment) || 0) + 1
  return newId("c")
}

/**
 * 按项目配置补齐代理池（幂等）：config.dispatchers 个调度员 + config.workers 个工人。
 * 必须在事务内调用；按 role+slot 判断是否已存在，所以改配置只会新增不会删。
 */
/** 阅读范围归一：paths 是文件/目录前缀，symbols 是函数/类/表名，都做去空与截断。 */
export function normalizeScope(scope) {
  const src = scope && typeof scope === 'object' ? scope : {}
  const paths = Array.isArray(src.paths) ? src.paths : []
  const symbols = Array.isArray(src.symbols) ? src.symbols : []
  const clean = (arr) => arr
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, 100)
    .map((v) => v.replace(/\\/g, '/').slice(0, 300))
  return { paths: clean(paths), symbols: clean(symbols) }
}

/** 老数据补默认键：只补缺的，不覆盖用户已经设过的值。 */
export function withDefaults(config) {
  const next = { ...(config || {}) }
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) if (next[k] === undefined) next[k] = v
  return next
}

/** 代理配置白名单：只接受这些字段，其余键一律丢弃（设计文档 2.5：可查、可审计、可回滚）。 */
// I6：审批绑定不可变版本；同一任务同类审批只保留一条有效记录（旧的自动吊销）。
export function recordApproval(s, task, kind, extra, actor) {
  if (!s.approvals) s.approvals = {}
  s.seq.approval = (s.seq.approval || 0) + 1
  const id = 'ap_' + String(s.seq.approval).padStart(5, '0')
  const at = nowIso()
  const rec = {
    id,
    taskId: task.id,
    kind,
    actor: (actor && (actor.id || actor.role)) || 'system',
    role: (actor && actor.role) || 'human',
    at,
    revokedAt: null,
    revokeReason: null,
    ...extra,
  }
  for (const other of Object.values(s.approvals)) {
    if (other.taskId === task.id && other.kind === kind && !other.revokedAt) {
      other.revokedAt = at
      other.revokeReason = 'superseded by ' + id
    }
  }
  s.approvals[id] = rec
  task.approvalId = id
  return rec
}

/** 吊销某任务某类审批（T4：评论/追问/改方案都让旧批准失效）。 */
export function revokeApprovals(s, taskId, kind, reason) {
  const revoked = []
  const at = nowIso()
  for (const rec of Object.values(s.approvals || {})) {
    if (rec.taskId !== taskId) continue
    if (kind && rec.kind !== kind) continue
    if (rec.revokedAt) continue
    rec.revokedAt = at
    rec.revokeReason = reason
    revoked.push(rec.id)
  }
  return revoked
}

/** I5：命令带的期望版本与当前任务版本不一致就拒绝（防旧界面覆盖新状态）。 */
export function checkVersion(task, expected) {
  if (expected === undefined || expected === null) return
  const cur = task.version || 0
  if (Number(expected) !== cur) {
    throw new Error('任务版本已变化（当前 ' + cur + '，命令基于 ' + expected + '），请刷新后重试')
  }
}

function normalizeAgentPatch(input) {
  const patch = {}
  if (!input || typeof input !== 'object') return patch
  if (input.name !== undefined) patch.name = clampText(String(input.name || ''), 120)
  if (input.preset !== undefined) patch.preset = input.preset ? String(input.preset) : null
  if (input.provider !== undefined) patch.provider = input.provider ? String(input.provider) : null
  if (input.model !== undefined) patch.model = input.model ? String(input.model) : null
  if (input.reasoningEffort !== undefined) {
    patch.reasoningEffort = input.reasoningEffort ? String(input.reasoningEffort) : null
  }
  if (input.promptOverlay !== undefined) patch.promptOverlay = clampText(input.promptOverlay || '', 4000)
  if (input.enabled !== undefined) patch.enabled = input.enabled !== false
  if (input.maxConcurrency !== undefined) {
    const n = Number(input.maxConcurrency)
    patch.maxConcurrency = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  }
  return patch
}

/**
 * v1.0：按「车道 × 角色」补齐代理位。
 * - chief 全局唯一（不属任何车道，默认挂 human 车道），dispatchers/workers 按车道补齐；
 * - 老配置（dispatchers/workers 无 lanes）视为 human 车道的数量，保持向后兼容；
 * - 工位按 (lane, role, slot) 幂等：改小配置不删已有工位。
 */
function provisionAgentsIn(s, project, actor, { create = true } = {}) {
  project.config = withDefaults(project.config)
  // 工位模型：项目级默认（不是全局当前选择），所以换个对话也不会变
  const modelDefaults = (project.config.defaultProvider && project.config.defaultModel)
    ? {
      provider: project.config.defaultProvider,
      model: project.config.defaultModel,
      reasoningEffort: project.config.defaultReasoningEffort || null,
    }
    : null
  // 车道真相源优先级：项目上已存在的 lanes > config.lanes > 老式 dispatchers/workers
  project.lanes = normalizeLanes(project.lanes || project.config.lanes || {
    human: {
      dispatchers: project.config.dispatchers,
      workers: project.config.workers,
      maxActivePerDispatcher: project.config.maxActivePerDispatcher,
    },
  })
  const created = []
  const lanes = ['human', 'issue']
  // 身份名要让人一眼分清「这条车道、这个角色、第几号」：human调度1 / human工人1 / auto调度1 / auto工人1。
  // issue 车道在界面上叫「自动」，所以前缀用 auto 而不是 Issue·。
  const laneLabel = { human: 'human', issue: 'auto' }

  // chief：全局一个车道一份（默认 human），保持老名字不变
  const chiefWant = project.config.chiefs === undefined ? 1 : Number(project.config.chiefs) || 0
  const chiefs = Object.values(s.agents).filter((a) => a.projectId === project.id && a.role === 'chief')
  for (let slot = 1; create && slot <= chiefWant; slot += 1) {
    if (chiefs.some((a) => a.slot === slot)) continue
    s.seq.agent += 1
    // 总调度者的模型由 DSH 自己的会话设置决定，不进本插件的模型配置
    const agent = makeAgent(project, s.seq.agent, 'chief', slot, 'human', '总调度者' + slot, null, 1, null)
    s.agents[agent.id] = agent
    emit(s, 'agent.created', { agentId: agent.id, role: 'chief', slot, lane: 'human' }, actor)
    created.push(agent)
  }

  for (const lane of lanes) {
    const laneCfg = project.lanes[lane]
    const plan = [
      ['dispatcher', laneCfg.dispatchers, laneCfg.maxActivePerDispatcher || 3],
      ['worker', laneCfg.workers, 1],
    ]
    for (const [role, want, concurrency] of plan) {
      const have = Object.values(s.agents).filter(
        (a) => a.projectId === project.id && a.role === role && (a.lane || 'human') === lane,
      )
      const slots = Math.max(0, Number(want) || 0)
      for (let slot = 1; create && slot <= slots; slot += 1) {
        if (have.some((a) => a.slot === slot)) continue
        s.seq.agent += 1
        const base = ({ dispatcher: '调度', worker: '工人' })[role]
        const agent = makeAgent(project, s.seq.agent, role, slot, lane, laneLabel[lane] + base + slot, null, concurrency, modelDefaults)
        s.agents[agent.id] = agent
        emit(s, 'agent.created', { agentId: agent.id, role, slot, lane }, actor)
        created.push(agent)
      }
    }
  }

  // 老项目里的工位可能还是 provider/model = null（那时还没冻结默认模型）。
  // 只补空值，不动用户已经设过的 —— 否则改个配置就把人工选择冲掉了。
  if (modelDefaults) {
    for (const a of Object.values(s.agents)) {
      if (!a || a.projectId !== project.id) continue
      if (a.role === 'chief') continue // 总调度的模型不归本插件管
      if (a.provider && a.model) continue
      a.provider = modelDefaults.provider
      a.model = modelDefaults.model
      a.reasoningEffort = a.reasoningEffort || modelDefaults.reasoningEffort || null
      a.updatedAt = nowIso()
      emit(s, 'agent.updated', { agentId: a.id, filledFrom: 'project-default' }, actor)
    }
  }

  // v1.39：需求评审工位（griller）—— 每个项目一个，只做"挑毛病"，
  // 不接任务、不建 worktree、不写代码。拆分前用它把八问的空白逼出来。
  const grillerWant = project.config.griller === undefined ? 1 : Number(project.config.griller) || 0
  const grillers = Object.values(s.agents).filter((a) => a.projectId === project.id && a.role === 'griller')
  for (let slot = 1; create && slot <= grillerWant; slot += 1) {
    if (grillers.some((a) => a.slot === slot)) continue
    s.seq.agent += 1
    const agent = makeAgent(project, s.seq.agent, 'griller', slot, 'human', '需求评审' + (slot > 1 ? slot : ''), null, 1, modelDefaults)
    s.agents[agent.id] = agent
    emit(s, 'agent.created', { agentId: agent.id, role: 'griller', slot, lane: 'human' }, actor)
    created.push(agent)
  }

  backfillSupervisorsIn(s, project)
  return created
}

/**
 * 代理的身份名（会话标题、界面标签都用它）。
 * 老数据里 name 可能是 '调度员1' 这种，以 name 为准；没有 name 才按 lane×role×slot 拼。
 */
export function agentLabel(agent) {
  if (!agent) return ''
  if (agent.name) return String(agent.name)
  if (agent.role === 'chief') return '总调度者' + (agent.slot || 1)
  if (agent.role === 'griller') return '需求评审' + ((agent.slot || 1) > 1 ? agent.slot : '')
  const lane = agent.lane === 'issue' ? 'auto' : 'human'
  const role = agent.role === 'dispatcher' ? '调度' : '工人'
  return lane + role + (agent.slot || 1)
}

/** 造一个代理位（不落盘，调用方负责塞进 state 并 emit）。 */
function makeAgent(project, seqNo, role, slot, lane, name, preset, concurrency, modelDefaults = null) {
  return {
    id: 'ag_' + String(seqNo).padStart(3, '0'),
    projectId: project.id,
    name,
    role,
    slot,
    lane,
    supervisorId: null,
    scope: null,
    preset: preset || null,
    // 工位一造出来就把模型定死：null 会让界面显示"沿用默认"，
    // 而"默认"是**全局的当前选择**，别的对话一切模型这个工位的显示就跟着变
    // （实际会话里的模型却没变，于是看起来像"配置串台"）。
    provider: (modelDefaults && modelDefaults.provider) || null,
    model: (modelDefaults && modelDefaults.model) || null,
    promptOverlay: '',
    reasoningEffort: (modelDefaults && modelDefaults.reasoningEffort) || null,
    maxConcurrency: concurrency || 1,
    enabled: true,
    health: 'unknown',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

/**
 * 回填层级关系（幂等，每次补齐后调用）：
 *   dispatcher.supervisorId ← 同项目 chief（同车道优先，其次任意 chief）
 *   worker.supervisorId     ← 同车道排序第一的 dispatcher
 * 只填 null 的，不动用户手工改过的关系。
 */
function backfillSupervisorsIn(s, project) {
  const agents = Object.values(s.agents).filter((a) => a.projectId === project.id)
  const chiefs = agents.filter((a) => a.role === 'chief').sort((x, y) => x.slot - y.slot)
  if (chiefs.length === 0) return
  for (const lane of ['human', 'issue']) {
    const chief = chiefs.find((c) => (c.lane || 'human') === lane) || chiefs[0]
    const dispatchers = agents
      .filter((a) => a.role === 'dispatcher' && (a.lane || 'human') === lane)
      .sort((x, y) => x.slot - y.slot)
    for (const d of dispatchers) if (!d.supervisorId) d.supervisorId = chief.id
    const head = dispatchers[0]
    if (!head) continue
    for (const w of agents) {
      if (w.role !== 'worker' || (w.lane || 'human') !== lane) continue
      if (!w.supervisorId) w.supervisorId = head.id
    }
  }
}

/**
 * 把远程条目并进镜像与事件信箱（v1.22 从 syncRemote 里抽出来）。
 *
 * 抽出来是因为 v1.22 的「一次 tick 单事务」也要走同一段逻辑：状态已经 15MB，
 * 每条 issue 各开一个 tx 会把 `JSON.parse(JSON.stringify(state))` 跑几十遍。
 */
// v1.36：被 lib/domain/sync-mirror.js 引用（同一模块级函数声明，混入模块运行时才调用）
export function mergeRemoteItems(s, projectId, source, items, stats, extra = {}) {
  for (const item of items) {
    const remoteId = String(item.remoteId || '')
    if (!remoteId) continue
    // v1.23：自己推上去的 issue 会带着 flow marker 回流。它不是"外部输入"，
    // 收进来只会写一堆镜像行 + 投一堆事件，最后长出重复的卡。
    if (hasFlowMarker(item.body)) { stats.echo = (stats.echo || 0) + 1; continue }
    const existing = Object.values(s.issues_mirror).find((m) => m.projectId === projectId && m.remoteId === remoteId)
    if (existing) {
      if (item.remoteRev && existing.remoteRev === item.remoteRev) { stats.unchanged += 1; continue }
      existing.remoteRev = item.remoteRev || existing.remoteRev
      existing.title = clampText(item.title || existing.title, 200)
      existing.body = clampText(item.body || existing.body || '', 4000)
      existing.state = item.state || existing.state
      existing.source = item.source || existing.source || 'remote'
      if (Array.isArray(item.labels)) existing.labels = item.labels.slice(0, 30)
      if (item.stateReason !== undefined) existing.stateReason = item.stateReason || null
      if (item.milestone !== undefined) existing.milestone = item.milestone || null
      existing.updatedAt = nowIso()
      stats.updated += 1
    } else {
      s.seq.mirror += 1
      const rec = {
        id: 'im_' + String(s.seq.mirror).padStart(3, '0'),
        projectId, remoteId, remoteRev: item.remoteRev || null,
        taskId: item.taskId || null, kind: item.kind || 'issue',
        source: item.source || 'remote',
        title: clampText(item.title || '', 200), body: clampText(item.body || '', 4000),
        state: item.state || 'open',
        labels: Array.isArray(item.labels) ? item.labels.slice(0, 30) : [],
        stateReason: item.stateReason || null,
        milestone: item.milestone || null,
        createdAt: nowIso(), updatedAt: nowIso(),
      }
      s.issues_mirror[rec.id] = rec
      stats.added += 1
    }
    const key = source + ':' + (item.kind || 'issue') + ':' + remoteId + ':' + (item.remoteRev || '')
    if (!s.event_inbox.some((e) => e.dedupeKey === key)) {
      s.seq.inbox += 1
      s.event_inbox.push({
        id: 'in_' + String(s.seq.inbox).padStart(6, '0'), seq: s.seq.inbox,
        source, type: (item.kind === 'pull' ? 'pr' : 'issue') + '.mirrored',
        refKind: item.kind || 'issue', refId: remoteId, dedupeKey: key,
        payload: {
          projectId, remoteId, rev: item.remoteRev || null,
          title: item.title || '', state: item.state || 'open',
          body: clampText(item.body || '', 4000),
          url: item.url || null,
          // C-09：since 判定要用创建时间，这里必须带上（否则事件信封里永远没有它）。
          createdAt: item.createdAt || null,
          merged: item.merged === true,
          branch: item.branch || null,
          headSha: item.headSha || null,
          labels: Array.isArray(item.labels) ? item.labels.slice(0, 30) : [],
          stateReason: item.stateReason || null,
          milestone: item.milestone || null,
          ...(extra.payload || {}),
        },
        at: nowIso(), ingestedAt: nowIso(), consumedAt: null,
      })
      stats.events += 1
    }
  }
  return stats
}

export class FlowDomain {
  constructor(store, runtime = null) {
    this.store = store
    this.runtime = runtime
    this.listeners = new Set()
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  broadcast(event) { for (const fn of this.listeners) { try { fn(event) } catch { /* 订阅者自己的问题 */ } } }

  // -- 读 -------------------------------------------------------------------

  /**
   * 快照（只读）。
   *
   * eventLimit 为什么要可配：事务事件是「审计历史」，默认只给最近 100 条是为了首屏体积，
   * 但排查时（或测试断言「整条事务都留了痕」时）需要更长的窗口。
   * 传 0 表示不截断——只在诊断入口用，界面别这么调。
   */
  snapshot(projectId, { eventLimit = 100 } = {}) {
    const s = this.store.state
    const tasks = Object.values(s.tasks)
      .filter((t) => !projectId || t.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return {
      schemaVersion: s.schemaVersion,
      projects: Object.values(s.projects),
      projectId: projectId || null,
      tasks: tasks.map((t) => ({ ...t, origin: t.origin || 'manual', effectiveColumn: effectiveColumn(t) })),
      comments: s.task_comments.filter((c) => tasks.some((t) => t.id === c.taskId)),
      agents: Object.values(s.agents)
        .filter((a) => !projectId || a.projectId === projectId)
        .map((a) => ({ ...a, lane: a.lane || 'human', supervisorId: a.supervisorId || null })),
      sessions: Object.values(s.agent_sessions).map((rec) => ({
        ...rec,
        budget: rec.budget || { tokens: 0, ratio: 0, checkedAt: null, compactBlockedAt: null },
      })),
      lanes: projectId && s.projects[projectId]
        ? normalizeLanes(s.projects[projectId].lanes)
        : Object.fromEntries(Object.values(s.projects).map((p) => [p.id, normalizeLanes(p.lanes)])),
      mergeRequests: Object.values(s.merge_requests),
      reviewPrompts: Object.values(s.review_prompts).sort((a, b) => a.order - b.order),
      runs: Object.values(s.runs).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 50),
      leases: Object.values(s.leases),
      columns: COLUMNS.map((id) => ({ id, title: COLUMN_TITLE[id], count: tasks.filter((t) => effectiveColumn(t) === id).length })),
      blockedCount: tasks.filter((t) => t.blocked).length,
      approvals: Object.values(s.approvals || {})
        .filter((a) => tasks.some((t) => t.id === a.taskId))
        .sort((a, b) => (a.at < b.at ? 1 : -1)),
      // 事务事件也进快照：会话视图的「事务事件」区靠它（旧版只有 /events 单独接口）
      events: (s.events || [])
        .filter((e) => {
          const p = (e && e.payload) || {}
          if (p.taskId) return tasks.some((t) => t.id === p.taskId)
          return p.projectId === projectId || !projectId
        })
        .filter((e) => e.type !== 'session.budget')
        .slice(eventLimit > 0 ? -eventLimit : 0),
    }
  }

  // -- v1.2 数据清理（不要直接改 flow.json：Store 是内存单写者，下次写事务会把内存态原子写回） --

  /** 删掉一个任务连同它的评论 / run / 审批 / 注入 / 租约 / worktree 记录。 */
  async removeTask(taskId, actor = { role: 'human', id: 'web' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      const projectId = task.projectId
      delete s.tasks[taskId]
      if (Array.isArray(s.task_comments)) s.task_comments = s.task_comments.filter((c) => c.taskId !== taskId)
      for (const [k, v] of Object.entries(s.approvals || {})) if (v && v.taskId === taskId) delete s.approvals[k]
      for (const [k, v] of Object.entries(s.runs || {})) if (v && v.taskId === taskId) delete s.runs[k]
      if (Array.isArray(s.injections)) s.injections = s.injections.filter((x) => x.taskId !== taskId)
      delete s.leases['task:' + taskId]
      delete s.worktrees[taskId]
      delete s.merge_requests[taskId]
      if (Array.isArray(s.events)) s.events = s.events.filter((e) => !(e.payload && e.payload.taskId === taskId))
      emit(s, 'task.removed', { taskId, projectId }, actor)
      return { taskId, projectId }
    })
  }

  /**
   * 删掉一个项目：任务、代理、会话绑定、车道配置一起清，事件里该项目的历史也清掉。
   * 这是"清理误建项目"的正规入口（外部手改 flow.json 会被内存态覆盖）。
   */
  async removeProject(projectId, actor = { role: 'human', id: 'web' }) {
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project: ' + projectId)
      const taskIds = Object.values(s.tasks || {}).filter((t) => t.projectId === projectId).map((t) => t.id)
      for (const id of taskIds) delete s.tasks[id]
      if (Array.isArray(s.task_comments)) s.task_comments = s.task_comments.filter((c) => !taskIds.includes(c.taskId))
      for (const [k, v] of Object.entries(s.approvals || {})) if (v && taskIds.includes(v.taskId)) delete s.approvals[k]
      for (const [k, v] of Object.entries(s.runs || {})) if (v && (v.projectId === projectId || taskIds.includes(v.taskId))) delete s.runs[k]
      for (const [k, v] of Object.entries(s.agent_sessions || {})) if (v && v.projectId === projectId) delete s.agent_sessions[k]
      for (const [k, v] of Object.entries(s.agents || {})) if (v && v.projectId === projectId) delete s.agents[k]
      for (const [k, v] of Object.entries(s.review_prompts || {})) if (v && v.projectId === projectId) delete s.review_prompts[k]
      for (const [k, v] of Object.entries(s.issues_mirror || {})) if (v && v.projectId === projectId) delete s.issues_mirror[k]
      for (const [k, v] of Object.entries(s.pull_requests || {})) if (v && v.projectId === projectId) delete s.pull_requests[k]
      for (const id of taskIds) { delete s.leases['task:' + id]; delete s.worktrees[id]; delete s.merge_requests[id] }
      delete s.leases['merge:' + projectId]
      if (Array.isArray(s.injections)) s.injections = s.injections.filter((x) => !taskIds.includes(x.taskId))
      if (Array.isArray(s.event_inbox)) s.event_inbox = s.event_inbox.filter((e) => !(e.payload && e.payload.projectId === projectId))
      if (Array.isArray(s.events)) s.events = s.events.filter((e) => !(e.payload && (e.payload.projectId === projectId || taskIds.includes(e.payload.taskId))))
      delete s.projects[projectId]
      emit(s, 'project.removed', { projectId, name: project.name, tasks: taskIds.length }, actor)
      return { projectId, name: project.name, removedTasks: taskIds.length }
    })
  }

  /** 任务详情：评论 / 运行 / 事件 / worktree / PR（issue 详情页一次取全）。 */
  taskDetail(taskId) {
    const s = this.store.state
    const task = s.tasks[taskId]
    if (!task) return null
    return {
      task: { ...task, origin: task.origin || 'manual', effectiveColumn: effectiveColumn(task) },
      comments: s.task_comments.filter((c) => c.taskId === taskId),
      runs: Object.values(s.runs)
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .map((r) => {
          const { lastHeartbeat, ...rest } = r
          return rest
        }),
      events: s.events.filter((e) => e.payload && e.payload.taskId === taskId).slice(-40),
      worktree: Object.values(s.worktrees).find((w) => w.taskId === taskId) || null,
      pullRequest: Object.values(s.pull_requests).find((p) => p.taskId === taskId) || null,
      // 远程 issue 镜像（自动调度区里的卡就是从这来的）
      mirror: Object.values(s.issues_mirror).find((m) => m.taskId === taskId) || null,
      // v1.39：父卡带子任务列表（详情页里直接展开 / 点开下一层）；子卡带父卡信息
      parent: task.parentId && s.tasks[task.parentId]
        ? { id: task.parentId, title: s.tasks[task.parentId].title, column: s.tasks[task.parentId].column }
        : null,
      children: (task.childIds || []).map((id) => s.tasks[id]).filter(Boolean).map((c) => ({
        id: c.id, title: c.title, column: c.column, phase: c.phase || '',
        assignee: c.assignee || null, blocked: !!c.blocked,
        dependsOn: Array.isArray(c.dependsOn) ? c.dependsOn : [],
        risk: c.risk ? { level: c.risk.level || null } : null,
        ticket: c.ticket ? { purpose: c.ticket.purpose || '', scope: c.ticket.scope || { paths: [], symbols: [] } } : null,
      })),
    }
  }

  eventsSince(seqNo) {
    return this.store.state.events.filter((e) => e.seq > (seqNo || 0))
  }

  // -- 项目 -----------------------------------------------------------------

  /**
   * @param modelDefaults 新工位默认模型 { provider, model, reasoningEffort }。
   *   由调用方（index.js，能拿到 catalog）提供，domain 层不直接依赖 host 服务。
   *   只在**项目第一次建**时写入；已存在的项目不覆盖（否则换个对话重建就把用户的配置冲了）。
   */
  async ensureProject({ workspacePath, name, workspaceId, modelDefaults = null }) {
    // 兜底：worktree 目录永远不是项目。index.js 的 resolveProject 已经拦了一层，
    // 这里是第二道闸——工作台"新建项目"、脚本、工具任何入口都不能把 worktree 建成项目。
    const normalized = String(workspacePath || '').replace(/\\/g, '/')
    if (/\/\.flow-worktrees\//.test(normalized + '/')) {
      throw new Error('worktree 目录不能作为项目：' + workspacePath)
    }
    return this.store.tx((s) => {
      const existing = Object.values(s.projects).find((p) => p.workspacePath === workspacePath)
      if (existing) {
        existing.config = withDefaults(existing.config)
        // 回调里带了「按路径解析出来的真实工作区 id」就顺手修好——旧的 workspaceId 可能早已失效，
        // 留着它会让新建的会话落进「未分组」（DSH 按 cwd 归组，查不到工作区就不归属）。
        if (workspaceId && existing.workspaceId !== workspaceId) {
          const previous = existing.workspaceId || null
          existing.workspaceId = workspaceId
          existing.updatedAt = nowIso()
          emit(s, 'project.workspace', { projectId: existing.id, workspaceId, previous }, { role: 'system' })
        }
        // v1.40：已存在的项目**不再补齐工位**（create:false）。以前每次 ensureProject
        // （打开对话 / 刷新工作台都会走）都补一遍，用户删掉的工位会被原样复活。
        // 仍做的只有：config 补默认值、lanes 归一化、空模型回填——这些不新增工位。
        provisionAgentsIn(s, existing, { role: 'system', id: 'system' }, { create: false })
        return existing
      }
      const project = {
        id: newId('prj'),
        name: name || workspacePath.split(/[\\/]/).pop() || workspacePath,
        workspacePath,
        workspaceId: workspaceId || null,
        createdAt: nowIso(),
        config: {
          ...DEFAULT_CONFIG,
          // 建项目那一刻的默认模型，冻结到项目上（之后全局默认怎么变都不影响这里的工位）
          ...(modelDefaults && modelDefaults.provider && modelDefaults.model
            ? {
              defaultProvider: modelDefaults.provider,
              defaultModel: modelDefaults.model,
              defaultReasoningEffort: modelDefaults.reasoningEffort || null,
            }
            : {}),
        },
      }
      s.projects[project.id] = project
      // 每个新项目自带一套默认审核 prompt 集
      for (const p of DEFAULT_PROMPTS) {
        const id = newId('rp')
        s.review_prompts[id] = { id, projectId: project.id, ...p, enabled: true, version: 1, updatedAt: nowIso() }
      }
      provisionAgentsIn(s, project, { role: 'system', id: 'system' })
      emit(s, 'project.created', { projectId: project.id, name: project.name })
      return project
    })
  }

  async updateProjectConfig(projectId, patch, actor) {
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project')
      if (patch && patch.allowedSkills !== undefined) {
        must(patch.allowedSkills === null || (Array.isArray(patch.allowedSkills) && patch.allowedSkills.every((name) => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))), 'allowedSkills 必须为 null 或合法技能名称数组')
      }
      if (patch && patch.grillMaxRounds !== undefined) must(Number.isInteger(patch.grillMaxRounds) && patch.grillMaxRounds >= 1 && patch.grillMaxRounds <= 20, 'grillMaxRounds 必须为 1–20 的整数')
      if (patch && patch.grillSkill !== undefined) must(typeof patch.grillSkill === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(patch.grillSkill), 'grillSkill 必须是合法技能名称')
      project.config = withDefaults({ ...project.config, ...patch })
      // 老键（dispatchers/workers/maxActivePerDispatcher）仍然生效：写补丁时同步进 human 车道，
      // 否则「改 workers 数量」这种既有用法会静默失效。
      const lanes = normalizeLanes(project.lanes || project.config.lanes)
      const legacy = ['dispatchers', 'workers', 'maxActivePerDispatcher'].filter((k) => patch && patch[k] !== undefined)
      if (patch && patch.lanes && typeof patch.lanes === 'object') {
        project.lanes = normalizeLanes({ ...lanes, ...patch.lanes })
      } else if (legacy.length > 0) {
        project.lanes = normalizeLanes({
          ...lanes,
          human: {
            ...lanes.human,
            ...Object.fromEntries(legacy.map((k) => [k, Number(patch[k]) || 0])),
          },
        })
      } else {
        project.lanes = lanes
      }
      // v1.40：只有**动到工位数**的配置改动才补工位（调大 workers / dispatchers 是显式动作）；
      // 改其它字段（模型、技能、轮数…）不应该把用户删掉的工位复活。
      const countKeys = ['dispatchers', 'workers', 'maxActivePerDispatcher', 'lanes', 'griller']
      const grew = !!(patch && countKeys.some((k) => patch[k] !== undefined))
      provisionAgentsIn(s, project, actor, { create: grew })
      emit(s, 'project.config', { projectId, patch }, actor)
      return project
    })
  }

  /**
   * 项目绑定的 DSH 工作区 id 可能失效（工作区被删、DSH 重建过工作区、从别处导入的 project 行）。
   * 失效 id 的后果不是报错，而是**静默**：session.create 拿它去查工作区会抛
   * "workspace ... not found"，或者会话落到 cwd 上、进不了任何工作区（侧栏显示"未分组"）。
   * 所以按路径重解析到的真实 id 要写回项目，之后每次建会话都走对的那条。
   */
  async setProjectWorkspace(projectId, workspaceId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project')
      const next = workspaceId || null
      if (project.workspaceId === next) return project
      const previous = project.workspaceId || null
      project.workspaceId = next
      project.updatedAt = nowIso()
      emit(s, 'project.workspace', { projectId, workspaceId: next, previous }, actor)
      return project
    })
  }

  // -- 任务 -----------------------------------------------------------------

  async createTask(projectId, input, actor = { role: 'human' }) {
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project')
      s.seq.task += 1
      const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '未命名任务'
      const task = {
        id: 'T-' + String(s.seq.task).padStart(3, '0'),
        projectId,
        origin: input.origin === 'auto' ? 'auto' : 'manual',
        lane: input.lane === 'issue' ? 'issue' : 'human',
        title: clampText(title, 120),
        note: clampText(input.note || '', 4000),
        acceptance: Array.isArray(input.acceptance) ? input.acceptance.slice(0, 20) : [],
        // v0.016（ticket 06）：新建的卡默认每一档都是「系统可验」，档位由人/调度显式改。
        acceptanceKinds: (Array.isArray(input.acceptance) ? input.acceptance.slice(0, 20) : []).map((_, i) => ((Array.isArray(input.acceptanceKinds) && ['auto','env','human'].includes(input.acceptanceKinds[i])) ? input.acceptanceKinds[i] : 'auto')),
        scope: normalizeScope(input.scope),
        subtasks: Array.isArray(input.subtasks) ? input.subtasks.slice(0, 50) : [],
        inspection: null,
        originRef: typeof input.originRef === 'string' && input.originRef ? clampText(input.originRef, 200) : null,
        // v1.23：身份稳定、修订会变。originRef 只认「哪一条」，originRev 记「最近看到哪一版」。
        originRev: typeof input.originRev === 'string' && input.originRev ? clampText(input.originRev, 40) : null,
        // v1.23：入站来的卡当场带上远程身份。缺了它，出站会把这卡当"本地新卡"再推一次，
        // 生成新 issue → 下一轮又被拉回来建卡（线上级联事故的放大器）。
        remote: input.remote && input.remote.issueNumber
          ? {
              source: input.remote.source || 'github',
              issueNumber: Number(input.remote.issueNumber) || null,
              url: input.remote.url || null,
              syncedRev: null,
              labels: [],
              at: nowIso(),
            }
          : null,
        // v1.4：谁发起的这张卡。子调度/工人的回信要投回这个会话（不绑死某个"主调度"）。
        originSessionId: typeof input.originSessionId === 'string' && input.originSessionId ? input.originSessionId : null,
        dispatchedBy: null,
        dispatchReason: null,
        priority: input.priority || 'medium',
        column: 'todo',
        phase: '',
        // C-00（schema 13）：交付身份。缺省值写在这里，而不是只靠迁移 ——
        // 迁移只回填「建库时已存在」的卡，升级后新建的卡得自己带，否则读侧到处 || 'card'。
        kind: input.kind === 'external-pr' ? 'external-pr' : 'card',
        external: null,
        branchFrom: null,
        integrationBranch: null,
        visibility: input.visibility === 'auto' ? 'auto' : 'board',
        version: 0,
        plan: { revision: 0, text: '', approvedRevision: null },
        headSha: null,
        stopReport: null,
        mergeRequest: null,
        blocked: null,
        assignee: null,
        activeRunId: null,
        worktree: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        history: [],
      }
      s.tasks[task.id] = task
      emit(s, 'task.created', { taskId: task.id, projectId, title: task.title }, actor)
      return task
    })
  }

  /**
   * v1.39：把一张卡拆成若干子卡（工作包）。
   *
   * 为什么拆成子卡而不是"一卡多 run"：一张卡同一时间只有一个 run + 一个租约
   * （activeRunId / lease task:<id>），复用这套约束最安全；子卡各自有自己的
   * run / worktree / 验收 / 合并，可以并行派给多个工人。
   *
   * 全部在一个事务里完成（store.tx 不可重入，所以这里直接建卡片对象，
   * 不调 createTask）。
   */
  /**
   * 把「部分完成」的剩余项变成后续卡（v0.016 / ticket 04）。
   *
   * 与 splitTask 的区别：那是**开工前**按方案拆工作包（要求八问齐全）；
   * 这里是**收口时**把证明做不完的部分变成新卡 —— 剩余项本身就是一句句事实，
   * 不该再逼人补一遍八问。所以只要求标题，其余字段取保守默认。
   *
   * 边界：
   * - 只允许两层（与 splitTask 同一条拓扑规则）：父卡自己已经是子卡时拒。
   * - 子卡不开分支、不进合并列（branchFrom=父分支、mergeState=none）—— 与现有子卡一致。
   * - 父卡落 done / done-partial，剩余项保留在卡上（谁接手都能看见原始措辞）。
   */
  async splitRemainder(taskId, actor = { role: 'system', id: 'system:split-remainder' }) {
    const parent = this.store.state.tasks[taskId]
    must(parent, 'unknown task')
    must(parent.partial === true, '这张卡不是部分完成，没有剩余项可拆')
    must(!parent.parentId, '子卡不能再拆（只允许两层）：' + taskId + ' 的父卡是 ' + parent.parentId)
    const rem = (Array.isArray(parent.remainder) ? parent.remainder : []).map((x) => String(x || '').trim()).filter(Boolean)
    must(rem.length, '没有剩余项可拆')
    const created = []
    for (const line of rem.slice(0, 8)) {
      const child = await this.createTask(parent.projectId, { title: line.slice(0, 120), acceptance: [] })
      await this.store.tx((s) => {
        const c = s.tasks[child.id]
        c.parentId = parent.id
        c.branchFrom = 'flow/' + parent.id
        c.unitMode = 'shared'
        c.mergeState = 'none'
        c.noMerge = true
        c.hiddenOnBoard = true
        c.kind = 'card'
        c.visibility = parent.visibility || 'board'
        c.note = '由 ' + parent.id + ' 的部分完成剩余项拆出：' + line
        const p = s.tasks[parent.id]
        p.childIds = Array.isArray(p.childIds) ? p.childIds : []
        if (p.childIds.indexOf(c.id) < 0) p.childIds.push(c.id)
        emit(s, 'task.split', { parentId: parent.id, childIds: p.childIds }, actor)
      })
      created.push(child.id)
    }
    // 不吞异常：拆完之后父卡没落 done-partial 是最难查的半成功状态。
    // 用 system 身份收口：这一步是**记账**（剩余项已经变成卡了），不是「人点头同意不做了」。
    // 调用方是谁不影响这个判断，所以不让它走 dispatcher 的授权核验。
    const moved = await this.move(parent.id, 'accept_partial',
      { role: 'system', id: (actor && actor.id) || 'system:split-remainder' },
      { reason: '剩余项已拆成 ' + created.join('、') })
    return { ok: true, created, parent: this.store.state.tasks[parent.id], moved: !!moved }
  }

  async splitTask(parentId, input = {}, actor = { role: 'dispatcher' }) {
    const items = Array.isArray(input.items) ? input.items : []
    // ---- 纯校验先做完（不碰状态，失败时不会有半成品）----
    must(items.length >= 2, '拆分至少要 2 项（只有 1 项就是普通单卡，直接写计划即可）')
    must(items.length <= 8, '一次最多拆 8 项（当前 ' + items.length + '）：再多就该先分成两级')
    const norm = items.map((x, i) => normalizeSplitItem(x, i))
    // 范围重叠检查：兄弟卡改同一片代码一定会打架，必须显式声明先后
    for (let i = 0; i < norm.length; i += 1) {
      for (let j = i + 1; j < norm.length; j += 1) {
        const hit = overlapPaths(norm[i].scope.paths, norm[j].scope.paths)
        const declares = norm[i].dependsOn.includes(j) || norm[j].dependsOn.includes(i)
        must(!hit || declares,
          '第 ' + (i + 1) + ' 项与第 ' + (j + 1) + ' 项的修改范围重叠（' + hit + '），必须用 dependsOn 声明先后，否则两个工人会改同一片代码')
      }
    }
    // 依赖不能成环
    assertNoCycle(norm)

    return this.store.tx((s) => {
      const parent = s.tasks[parentId]
      must(parent, 'unknown task: ' + parentId)
      // rf-01：只允许两层 —— 子卡不能再拆。
      // 三层以上的拆法会让「一个可评审单元」变成一棵树，合并目标链也跟着变长，
      // 而评审带宽是真正瓶颈（子卡的存在是为了并行，不是为了制造层级）。
      must(!parent.parentId, '子卡不能再拆（只允许两层）：' + parentId + ' 的父卡是 ' + parent.parentId)
      must(!parent.activeRunId, '这张卡有在跑的 run，不能拆分：先等它停下或取消')
      // 注意：must 的消息是**先求值**的，所以这里不能直接 join 可能为 undefined 的 childIds
      const already = Array.isArray(parent.childIds) ? parent.childIds : []
      must(!already.length, '这张卡已经拆过了（子卡 ' + already.join('、') + '）：要重拆先取消现有子卡')
      must(['todo', 'planning'].includes(parent.column), '只有待办 / 规划中的卡能拆（当前在 ' + parent.column + '）')
      const project = s.projects[parent.projectId]
      must(project, 'unknown project')
      s.seq.task += 0
      const created = []
      const ids = []
      // 先算出所有 id（依赖要用 id 引用兄弟卡）
      for (let i = 0; i < norm.length; i += 1) {
        s.seq.task += 1
        ids.push('T-' + String(s.seq.task).padStart(3, '0'))
      }
      for (let i = 0; i < norm.length; i += 1) {
        const item = norm[i]
        const planText = renderTicketPlan(item)
        const child = {
          id: ids[i],
          projectId: parent.projectId,
          origin: parent.origin,
          lane: parent.lane,
          title: item.title,
          note: item.purpose,
          acceptance: item.acceptance,
          scope: item.scope,
          subtasks: [],
          inspection: null,
          originRef: null,
          originRev: null,
          remote: null,
          originSessionId: parent.originSessionId || null,
          dispatchedBy: null,
          dispatchReason: null,
          priority: item.priority || parent.priority || 'medium',
          column: 'planning',
          phase: 'plan-ready',
          version: 0,
          // 工单直接作为计划 rev1：子卡拿到就是"知道自己要改什么"的状态
          plan: { revision: 1, text: planText, approvedRevision: null },
          headSha: null,
          stopReport: null,
          mergeRequest: null,
          blocked: null,
          assignee: null,
          activeRunId: null,
          worktree: null,
          // v1.39 父子关系与工单
          parentId,
          childIds: [],
          ticket: item.ticket,
          hiddenOnBoard: true,
          // rf-01：子卡的分支从**父分支**拉出，因此它的交付物也合回父分支。
          // 只有 splitTask 新建的子卡带这个字段：迁移不给老子卡回填（见 MIGRATIONS[12]）。
          kind: 'card',
          external: null,
          branchFrom: 'flow/' + parentId,
          integrationBranch: null,
          // v0.008（C-10）：新拆出来的子卡是**工作单元** —— 与父卡共用检出与分支，
          // 只产生提交。老卡由 MIGRATIONS[13] 打 legacy-branch 标记，这里只写新语义。
          unitMode: 'shared',
          unitStartSha: null,
          // C-10：子卡的 mergeState 必须在**创建时**写死 none —— 不能靠状态机去猜默认值。
          // 线上 T-049 就是这里缺字段：accept 时 mergeState === undefined，而 canEnterMerge
          // 把 undefined 当放行（历史数据兼容），于是子卡「恰好」进了合并列，还开了 PR。
          mergeState: 'none',
          mergeReason: null,
          noMerge: true,
          noMergeReason: '子卡是工作单元：改动以提交形式落在父分支 flow/' + parentId + ' 上',
          // 子卡跟着父卡的可见性走：自动车道里拆出来的子卡也是自动的。
          visibility: parent.visibility === 'auto' ? 'auto' : 'board',
          grill: null,
          dependsOn: item.dependsOn.map((j) => ids[j]),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          history: [],
        }
        s.tasks[child.id] = child
        created.push(child)
        emit(s, 'task.created', { taskId: child.id, projectId: parent.projectId, title: child.title, parentId }, actor)
      }
      parent.childIds = ids
      parent.phase = 'split'
      if (parent.column === 'todo') parent.column = 'planning'
      parent.plan = {
        revision: (parent.plan && parent.plan.revision) || 0,
        text: renderSplitTable(norm, ids, input.reason),
        approvedRevision: (parent.plan && parent.plan.approvedRevision) || null,
      }
      parent.version = (parent.version || 0) + 1
      parent.updatedAt = nowIso()
      emit(s, 'task.split', { taskId: parentId, children: ids, reason: input.reason || '' }, actor)
      return { parent, children: created }
    })
  }

  async updateTask(taskId, patch, actor) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const allowed = ['title', 'note', 'acceptance', 'priority', 'headSha', 'worktree', 'assignee', 'scope', 'subtasks']
      for (const key of Object.keys(patch || {})) {
        if (!allowed.includes(key)) throw new Error('field not patchable: ' + key)
      }
      Object.assign(task, patch, { updatedAt: nowIso() })
      emit(s, 'task.updated', { taskId, fields: Object.keys(patch || {}) }, actor)
      return task
    })
  }

  async setPlan(taskId, text, actor = { role: 'dispatcher' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      must(typeof text === 'string' && text.trim(), 'plan 不能为空')
      // v1.25：plan 原来截 8000，比评论还狠。复核意见里「plan rev 1 仍是阶段性核查方向、
      // 而非最终逐项结果」就是这个上限造成的 —— 方案主体被砍在 8000 处，人看到的永远只是前半段。
      task.plan = { ...task.plan, revision: task.plan.revision + 1, text: clampText(text, COMMENT_MAX), updatedAt: nowIso(), approvedRevision: null, approvedAt: null }
      task.updatedAt = nowIso()
      task.version = (task.version || 0) + 1
      emit(s, 'task.plan', { taskId, revision: task.plan.revision }, actor)
      // T4/I6：方案一改，旧批准立即失效，必须重新审批。
      const revoked = revokeApprovals(s, taskId, 'plan', 'plan revision ' + task.plan.revision)
      if (revoked.length) {
        if (task.column === 'planning') task.phase = 'discussing'
        emit(s, 'approval.revoked', { taskId, kind: 'plan', approvals: revoked, reason: 'plan changed' }, actor)
      }
      return task
    })
  }

  /** 状态迁移 + 迁移相关的副作用，一个事务。 */
  async move(taskId, action, actor, payload = {}) {
    const before = this.store.state.tasks[taskId]
    must(before, 'unknown task')
    checkVersion(before, payload.expectedVersion)
    // v0.015：返工频控。
    //
    // 线上 T-055：36 分钟里 5 个 run、3 次 rework、4 次 no-diff —— 缺的是隔离环境的真实凭据，
    // 不是工人的活。每一轮工人只能交回「我说明了为什么做不到」，调度只能再要一次，
    // 于是同一张卡反复派工、产出一模一样的报告。这类循环靠提示词治不住，只能在这里拦。
    //
    // 阈值取 2：第一次返工是正常纠偏，第二次是同一条路又走了一遍，第三次就该换方式了。
    // 时间窗默认 20 分钟（可被 settings.reworkWindowMs 覆盖），超出窗口重新计数。
    if (action === 'rework') {
      const rw = before.rework || { count: 0, lastAt: null }
      const last = Date.parse(rw.lastAt || '') || 0
      const windowMs = Number((this.store.state.settings || {}).reworkWindowMs) || 20 * 60 * 1000
      const recent = last && (Date.now() - last < windowMs) ? (Number(rw.count) || 0) : 0
      if (recent >= 2) {
        const mins = Math.round(windowMs / 60000)
        throw new Error(
          '这张卡在 ' + mins + ' 分钟内已经被返工 ' + recent + ' 次，第 ' + (recent + 1) + ' 次不再放行。' + NL +
          '先判断缺的是什么：' + NL +
          '· 缺环境/凭据/人的决定 → flow_task_move(action="block") 写清缺什么，需要人定的再 flow_ask_human；' + NL +
          '· 只是要工人补一句话或补一个测试 → flow_worker_steer 插话，或 flow_task_comment 写清楚；' + NL +
          '· 是方案错了 → flow_task_move(action="rewind") 退回到能改的那一列。' + NL +
          '同一份指令再来一次只会得到同一份 no-diff 报告。'
        )
      }
      payload = { ...payload, reworkCount: recent + 1 }
    }
    // v1.28：验收的 head_sha 由**系统自己去 worktree 读**，不再让人手抄。
    // 理由：合并人常常根本不知道提交号是多少，而"让人填"正是伪造值（audit-T035-verified）
    // 被写进去的土壤。没有 worktree / 没有提交的卡就留空（表示"无提交可绑"）。
    if (action === 'accept' && !payload.headSha && !before.headSha) {
      const sha = await this.resolveWorktreeHeadSha(before).catch(() => null)
      if (sha) payload = { ...payload, headSha: sha, headShaAuto: true }
    }
    // v1.32：验收前检查 worktree 是否还有未提交改动。
    //
    // 这是「验收不严」的真正根因：accept 只读 worktree 的 HEAD，
    // 而 HEAD **不包含未提交的改动**。于是工人在 worktree 里改了一堆文件、
    // 一个都没 commit，停止报告写得好看，验收照样通过 —— 卡变成 done，
    // 但那些改动从来没进过任何提交，合并进 master 的自然是空的。
    //
    // 线上 T-035/T-037/T-039/T-036 的 worktree 至今留着未提交改动，就是这条路径。
    //
    // 允许显式放过（payload.allowDirty = true），但必须有理由 —— 由人决定，不由流程默认。
    if (action === 'accept' && payload.allowDirty !== true) {
      const dirty = await this.worktreeDirtyFiles(before).catch(() => null)
      if (dirty && dirty.length) {
        const head = before.headSha ? String(before.headSha).slice(0, 8) : '(无)'
        throw new Error([
          '验收被拒：worktree 里还有 ' + dirty.length + ' 个未提交改动，HEAD(' + head + ') 并不包含它们。',
          '未提交文件：',
          ...dirty.slice(0, 15).map((f) => '  ' + f),
          dirty.length > 15 ? '  …还有 ' + (dirty.length - 15) + ' 个' : '',
          '要么让工人把这些改动提交（这是正确做法），要么由人确认「这些改动不要了」后带 allowDirty=true 重新验收。',
        ].filter(Boolean).join('\n'))
      }
    }
    // v1.35：代收验收的凭据在进事务前核验（要读请示箱），核验结果交给守卫裁决。
    const grant = action === 'accept' && actor && actor.role === 'dispatcher'
      ? this.resolveAcceptGrant(before, payload.acceptedBy, actor)
      : null
    let effectId = null
    const result = await this.store.tx((s) => {
      const task = s.tasks[taskId]
      // 守卫里可能需要 payload 先落到任务上（stop report / 审核结论 / 重开原因）
      if (action === 'stop' && payload.stopReport) {
        // v1.37：acceptanceStatus 与 task.acceptance 逐条对应；状态只认四种，未知值按 not-run 处理
        const rep = { ...payload.stopReport }
        if (Array.isArray(rep.acceptanceStatus)) {
          const OK = ['pass', 'partial', 'not-run', 'fail']
          rep.acceptanceStatus = rep.acceptanceStatus.slice(0, 20).map((x, i) => ({
            index: Number.isInteger(x && x.index) ? x.index : i,
            status: OK.includes(x && x.status) ? x.status : 'not-run',
            evidence: clampText(String((x && x.evidence) || ''), 120),
          }))
        }
        // v0.015：六问（复盘模板）。允许填不满，但缺哪几项要记下来 ——
        // 验收和调度看得到，才不会把「报告没写清」当成「活没干」。
        const SIX = { problem: '是什么问题', cause: '什么原因导致', impact: '影响范围与严重程度', fix: '怎么修复的', regression: '是否有回归问题', design: '是否改了设计方向' }
        const six = {}
        const sixMissing = []
        for (const k of Object.keys(SIX)) {
          const v = clampText(String(rep[k] || ''), 600)
          if (v) six[k] = v
          else sixMissing.push(k)
        }
        rep.six = six
        rep.sixMissing = sixMissing
        // v0.016（ticket 04）：允许交「做了一部分 + 剩下什么」。
        // 这是给「一张卡一轮做不完」留的正经出口 —— 没有它，工人只能反复 rework，
        // 而每轮都在写同一份「还差什么」的报告（线上 T-046：29 个 run）。
        const remRaw = Array.isArray(rep.remaining) ? rep.remaining : (Array.isArray(rep.remainder) ? rep.remainder : [])
        rep.remaining = remRaw.map((x) => clampText(String(x || ''), 300)).filter(Boolean).slice(0, 20)
        task.partial = rep.remaining.length > 0
        task.remainder = rep.remaining
        task.stopReport = rep
      }
      if (action === 'rework') {
        task.rework = { count: Number(payload.reworkCount) || 1, lastAt: nowIso(), reason: clampText(payload.reason || '', 300) }
        // 返工 = 把「部分完成」这件事撤回：这张卡重新要整活，剩余项就不再是承诺了。
        task.partial = false
        task.remainder = []
      }
      // v0.016（ticket 06）：缺环境的清单落在卡上，谁看都能知道差什么。
      if (action === 'needs_env') task.envMissing = (Array.isArray(payload.missing) ? payload.missing : []).map((x) => clampText(String(x || ''), 300)).filter(Boolean).slice(0, 20)
      if (action === 'accept' && payload.headSha) task.headSha = payload.headSha
      if (action === 'reopen') task.reopenReason = clampText(payload.reason || payload.reopenReason || '', 2000)
      if (action === 'review_approve' || action === 'review_conflict' || action === 'review_risk') {
        const mr = task.mergeRequest
        // v1.30：把「为什么没有」和「下一步做什么」一起说出来。
        // 原来的报错只有后半句，人卡在 merging 列不知道还能点哪里。
        must(mr, task.column === 'merging'
          ? '这张卡还没有 PR 快照。先点「开 PR 快照」（或让调度 flow_pr_open），'
            + '没有改动/不是 git 的卡请改用「跳过合并」。'
          : '只在合并列（merging）才需要 PR 快照，当前列是 ' + task.column)
        // v1.35：合并事务收口时调 review_approve 不带新结论 —— 保留已有的审核证据，
        // 别把人/调度给的结论覆盖成 reviewer=system（审计会以为是系统审的）。
        const keepEvidence = action === 'review_approve' && !payload.verdict && mr.reviewVerdict && mr.reviewEvidence
        const evidence = keepEvidence ? mr.reviewEvidence : {
          // 统一 verdict 值域：approved / needs_work / risk（历史数据里的 'approve' 也归一）
          verdict: normalizeVerdict(payload.verdict || action.replace('review_', '')),
          promptVersion: payload.promptVersion || this.reviewPromptSet(task.projectId).version,
          matched: Array.isArray(payload.matched) ? payload.matched : [],
          summary: clampText(payload.summary || '', 2000),
          reviewedAt: nowIso(),
          reviewer: actor.id || actor.role,
        }
        task.mergeRequest = { ...mr, reviewVerdict: evidence.verdict, reviewEvidence: evidence }
        s.merge_requests[mr.id] = task.mergeRequest
      }
      // v1.28：把 payload 透给 guard —— accept 需要 acceptedBy 才能判断"这次是谁授的权"
      const next = applyTransition(task, action, actor, payload, { grant })
      if (action === 'review_risk') {
        const blocked = blockTask(next, payload.reason || 'risk-escalation', actor)
        s.tasks[taskId] = blocked
        emit(s, 'task.blocked', { taskId, reason: blocked.blocked.reason }, actor)
        return blocked
      }
      s.tasks[taskId] = next
      // I6：批准绑定 plan_rev，验收绑定 head_sha，各自落一条不可变审批记录。
      // v1.26：approve_by_dispatcher（调度代批 human 车道的方案）同样要落记录，
      // 且 by 是具体 agent id —— 事后必须能区分「人批的」和「代批的」。
      // v1.35：所有开工类批准都落记录（approve_by_chief 以前漏了），发布带出来的批准记下来源会话。
      if (PLAN_APPROVALS.has(action)) {
        const extra = { planRevision: next.plan.revision, via: action }
        if (action === 'approve_by_publish') extra.publishedFrom = String(payload.publishedFrom)
        const rec = recordApproval(s, next, 'plan', extra, actor)
        emit(s, 'approval.recorded', { taskId, kind: 'plan', approvalId: rec.id, planRevision: rec.planRevision, via: action }, actor)
      }
      if (action === 'accept') {
        // v1.31：把"凭什么可以代收"一起写进审批记录。
        // 没有这一项，事后翻审计只能看到 role=dispatcher，分不清是
        // 「人授权后代收」（human:web）还是「系统自动收」（system:advance）。
        const rec = recordApproval(s, next, 'head', {
          headSha: next.headSha,
          acceptedBy: payload.acceptedBy || null,
          autoAccepted: payload.auto === true,
          // v1.35：核验过的凭据来源（inbox = 人回复过的请示单；system = 系统自动验收）
          grantKind: grant ? grant.kind : null,
          grantRef: grant ? grant.ref || null : null,
          grantReplyBy: grant ? grant.replyBy || null : null,
        }, actor)
        emit(s, 'approval.recorded', { taskId, kind: 'head', approvalId: rec.id, headSha: rec.headSha, acceptedBy: rec.acceptedBy }, actor)
      }
      const movedEvent = emit(s, 'task.moved', { taskId, action, from: task.column, to: next.column, phase: next.phase }, actor)
      // v1.35（设计文档 §3 总原则）：副作用的**意图**和迁移同一事务落库。
      // 以前是事务提交后直接调 onMoved 并 .catch(() => {}) 吞掉 —— 进程在两者之间崩了，
      // 或者副作用抛错，卡就停在「状态说已批准、但没人派工」，而且没有任何记录。
      if (EFFECT_ACTIONS.has(action) && this.runtime) {
        effectId = enqueueEffect(s, { kind: 'moved', taskId, action, taskVersion: next.version, causationId: movedEvent.id })
      }
      return next
    })
    // 迁移提交之后执行副作用：失败落在 effects 表里，由 tick 的 effects 步重试（L3）。
    if (effectId) await this.runEffect(effectId)
    return result
  }

  // -- v1.35：副作用意图（effects） -------------------------------------------

  /**
   * 执行一条副作用意图。永不抛错：结果写回 effects 表。
   *
   * 幂等性靠两层：
   *   1. 派工类（approve 系列 / rework / review_conflict / claim）先比对 taskVersion —— 卡已经被别的
   *      迁移推走了（例如批准后马上取消），旧意图直接作废，不在已取消的卡上开会话；
   *   2. 处理函数自己幂等（dispatch 遇到在跑的 run 返回 duplicate；afterStop/afterCancel 带 runId fencing）。
   */
  async runEffect(effectId) {
    const pre = this.store.state.effects && this.store.state.effects[effectId]
    if (!pre || pre.status === 'done' || pre.status === 'skipped' || pre.status === 'dead') return pre || null
    const task = this.store.state.tasks[pre.taskId]
    if (!task) return this.finishEffect(effectId, 'skipped', { reason: 'task-gone' })
    if (STALE_SENSITIVE.has(pre.action) && Number(task.version) !== Number(pre.taskVersion)) {
      return this.finishEffect(effectId, 'skipped', { reason: 'stale: task v' + task.version + ' ≠ v' + pre.taskVersion })
    }
    if (!this.runtime) return pre
    await this.store.tx((s) => {
      const e = s.effects[effectId]
      if (!e) return
      e.status = 'running'
      e.attempts = (Number(e.attempts) || 0) + 1
      e.startedAt = nowIso()
    })
    try {
      const out = await withCause(pre.causationId, async () => (pre.action === 'stop'
        ? this.runtime.onStopped?.(task)
        : this.runtime.onMoved?.(task, pre.action)))
      return this.finishEffect(effectId, 'done', { result: summarizeEffectResult(out) })
    } catch (err) {
      return this.finishEffect(effectId, 'failed', { error: String((err && err.message) || err) })
    }
  }

  async finishEffect(effectId, status, { result = null, error = null, reason = null } = {}) {
    return this.store.tx((s) => {
      const e = s.effects[effectId]
      if (!e) return null
      e.endedAt = nowIso()
      if (status === 'failed') {
        const attempts = Number(e.attempts) || 0
        e.lastError = clampText(error || '', 1000)
        if (attempts >= EFFECT_MAX_ATTEMPTS) {
          e.status = 'dead'
          e.nextAt = null
          emit(s, 'effect.dead', { effectId, taskId: e.taskId, action: e.action, attempts, error: e.lastError }, { role: 'system', id: 'effects' })
        } else {
          e.status = 'failed'
          e.nextAt = new Date(Date.now() + 30000 * Math.pow(2, attempts - 1)).toISOString()
          emit(s, 'effect.failed', { effectId, taskId: e.taskId, action: e.action, attempts, error: e.lastError }, { role: 'system', id: 'effects' })
        }
      } else {
        e.status = status
        e.nextAt = null
        if (result) e.result = result
        if (reason) e.reason = clampText(reason, 300)
      }
      return { ...e }
    })
  }

  /**
   * 待收敛的副作用：
   *   pending 超过 30s（提交后进程没来得及执行）、running 超过 10min（执行到一半进程没了）、failed 到点重试。
   */
  pendingEffects(now = Date.now(), limit = 20) {
    const out = []
    for (const e of Object.values(this.store.state.effects || {})) {
      if (!e) continue
      const age = (iso) => now - (Date.parse(iso || 0) || 0)
      if (e.status === 'pending' && age(e.createdAt) > 30000) out.push(e)
      else if (e.status === 'running' && age(e.startedAt) > 10 * 60000) out.push(e)
      else if (e.status === 'failed' && e.nextAt && Date.parse(e.nextAt) <= now) out.push(e)
      if (out.length >= limit) break
    }
    return out
  }

  /** 某张卡某个动作最近一条副作用的结果（flow_publish 用它报告「派没派出去」，不再自己重派一次）。 */
  lastEffectOf(taskId, action) {
    const list = Object.values(this.store.state.effects || {}).filter((e) => e && e.taskId === taskId && (!action || e.action === action))
    return list.length ? list[list.length - 1] : null
  }

  /**
   * v1.35：验收代收凭据的核验。
   *
   * 接受两种凭据：
   *   - 请示单 id（hi_*）：同一张卡、人类回复过、回复时间晚于本轮停止、回复不是明确拒绝；
   *   - system:*：只有调度器自己的身份（actor.id 以 system: 开头）才能用 —— 模型调用拿不到。
   * 其余字符串（human:web、ok、已授权…）一律不认：那是模型自己能写出来的东西。
   */
  resolveAcceptGrant(task, acceptedBy, actor) {
    const ref = String(acceptedBy || '').trim()
    if (!ref) return { ok: false, reason: '缺少 acceptedBy' }
    const actorId = String((actor && actor.id) || '')
    if (ref.startsWith('system:')) {
      return actorId.startsWith('system:')
        ? { ok: true, kind: 'system', ref }
        : { ok: false, reason: 'system:* 凭据只给调度器自身使用，代理调用不能使用' }
    }
    const item = (this.store.state.human_inbox || []).find((x) => x.id === ref)
    if (!item) return { ok: false, reason: '找不到请示单 ' + ref.slice(0, 40) }
    if (item.taskId !== task.id) return { ok: false, reason: '请示单 ' + ref + ' 不属于 ' + task.id }
    const since = Date.parse((task.stopReport && task.stopReport.at) || task.columnAt || 0) || 0
    const replies = (item.replies || []).filter((r) => r && (r.role || 'human') === 'human' && (Date.parse(r.at) || 0) >= since)
    if (!replies.length) return { ok: false, reason: '请示单 ' + ref + ' 在这一轮停止之后没有人类回复' }
    const last = replies[replies.length - 1]
    if (REJECT_REPLY_RE.test(String(last.content || '').trim())) {
      return { ok: false, reason: '人的最新回复是否定（"' + String(last.content).slice(0, 30) + '"），不能当验收授权' }
    }
    return { ok: true, kind: 'inbox', ref, replyBy: last.by || 'human', replyAt: last.at }
  }

  /**
   * v1.35：审核结论的唯一入口（flow_pr_review 与 pr.review 共用）。
   *
   * approved **不移动卡片**：只记结论，卡留在 merging 等合并事务（v1.32：审核 ≠ 合并）。
   * 以前 approved 映射成 review_approve，守卫要求 mergedCommit，于是事务回滚、
   * 连结论都没留下 —— 调度怎么审都审不过，autoMerge 也永远等不到 approved。
   */
  async review(taskId, verdict, { matched = [], summary = '', promptVersion = null } = {}, actor = { role: 'dispatcher' }) {
    const task = this.store.state.tasks[taskId]
    must(task, 'unknown task')
    // v0.008：工作单元没有自己的 PR，也就没有「审核」这件事可做。
    // 状态机已经让它进不了 merging，但 tools/http 这些旁路入口仍可能直接调到这里，
    // 所以判据放在**领域方法**里 —— 那是所有入口的汇合点。
    must(!task.parentId, '子卡不参与审核：它是工作单元，改动随父卡的 PR 一起发布（父卡 ' + String(task.parentId) + '）')
    must(task.column === 'merging', '只有合并列（merging）的卡能审核，当前列是 ' + task.column)
    must(task.mergeRequest, '这张卡还没有 PR 快照。先开 PR 快照（flow_pr_open），没有改动/不是 git 的卡请改用「跳过合并」。')
    const v = normalizeVerdict(verdict)
    const action = reviewActionOf(v)
    if (!action) {
      // block 级判据命中却给 approved：自相矛盾，按 risk 处理（判定规则见 renderReviewPrompt）
      const blockIds = new Set(this.reviewPromptSet(task.projectId).prompts.filter((p) => p.severity === 'block').map((p) => p.id))
      const hitBlock = (Array.isArray(matched) ? matched : []).some((m) => m && blockIds.has(m.id))
      if (hitBlock) return this.review(taskId, 'risk', { matched, summary: '（命中 block 级判据，approved 改判 risk）' + summary, promptVersion }, actor)
      const evidence = await this.setReviewVerdict(taskId, v, summary, matched, actor, { promptVersion })
      return { task: this.store.state.tasks[taskId], verdict: v, evidence, next: 'merge' }
    }
    const moved = await this.move(taskId, action, actor, { verdict: v, matched, summary, promptVersion })
    return { task: moved, verdict: v, next: action }
  }

  /** v1.35：交接 = 写交付包 + 标 dispatched，一个入口（tools/http 原来各写一遍、失败语义还不同）。 */
  async handoffTask(taskId, { to = 'dispatcher', notes = '' } = {}, actor = { role: 'chief' }) {
    const pk = await this.handoff(taskId, { to, notes }, actor)
    const moveActor = { role: 'dispatcher', id: (actor && actor.id) || 'dispatcher' }
    try {
      const moved = await this.move(taskId, 'handoff', moveActor)
      return { ...pk, column: moved.column, phase: moved.phase, warning: null }
    } catch (err) {
      return { ...pk, column: null, phase: null, warning: '交付包已记录，但状态没切到 dispatched：' + String((err && err.message) || err) }
    }
  }

  async block(taskId, reason, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const next = blockTask(task, reason, actor)
      s.tasks[taskId] = next
      emit(s, 'task.blocked', { taskId, reason }, actor)
      return next
    })
  }

  async unblock(taskId, actor = { role: 'human' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const next = unblockTask(task, actor)
      s.tasks[taskId] = next
      emit(s, 'task.unblocked', { taskId, column: next.column }, actor)
      return next
    })
  }

  /** v1.39：只落事件、不写评论（系统通知类动作走这里，评论区只留人和代理的有效内容）。 */
  async noteEvent(taskId, type, payload = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      if (!s.tasks[taskId]) return null
      return emit(s, type, { taskId, ...payload }, actor)
    })
  }

  async comment(taskId, content, author = { role: 'human' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const c = {
        id: nextCommentId(s),
        taskId,
        content: clampText(content, COMMENT_MAX),
        author: author.id || author.role || 'human',
        role: author.role || 'human',
        at: nowIso(),
      }
      s.task_comments.push(c)
      emit(s, 'comment.added', { taskId, commentId: c.id }, author)
      // T4：人类评论/追问让等待中的批准失效。
      if ((author.role || 'human') === 'human' && task.column === 'planning' && task.phase === 'waiting-approval') {
        const revoked = revokeApprovals(s, taskId, 'plan', 'commented: ' + c.id)
        task.phase = 'discussing'
        if (revoked.length) emit(s, 'approval.revoked', { taskId, kind: 'plan', approvals: revoked, reason: 'user comment' }, author)
      }
      return c
    })
  }

  /**
   * I4/I10：同一仓库同时只允许一个合并事务；租约 token 做 fencing。
   *
   * ttl 从 60s 提到 10 分钟（ADR-0004 §7）：一次合并要跑集成检出里的 merge + 推进 base
   * + 合并后冒烟 + 可选 push，60 秒很容易穿透 —— 穿透的后果不是"慢一点"，而是第二个请求
   * 在第一个还没写完时拿到锁，两条合并交错落地。
   */
  async lockMerge(projectId, taskId, ttl = MERGE_LOCK_TTL) {
    return this.store.tx((s) => acquireLease(s, 'merge:' + projectId, 'task:' + taskId, ttl))
  }

  /**
   * needs-rebase 的尝试计数（ADR-0004 §4）。上限 3 次：没有上限的话，
   * 分支被别的东西顶住时会无限回派工人做软合并 —— 每次都是一轮完整的工位开销。
   */
  async setRebaseAttempts(taskId, n, actor = { role: 'system', id: 'system:merge' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.rebaseAttempts = Math.max(0, Number(n) || 0)
      task.updatedAt = nowIso()
      emit(s, 'task.rebase_attempts', { taskId, attempts: task.rebaseAttempts }, actor)
      return task.rebaseAttempts
    })
  }

  /**
   * 派工前的检出意图锁（I-07）。同一张卡同时只允许一个调用者判断"要不要 add"。
   *
   * 为什么必须锁在 addWorktree **之前**：T-043 的真实事故是 1.5 秒内双派 ——
   * 第一次 add 成功了但登记还没写，第二次看不到登记，拿同一分支再 add，git 回
   * `already used by worktree`，然后旧代码降级成 path=repo，把工人塞进了人的主检出。
   */
  async lockWorktree(taskId, ttl = WORKTREE_LOCK_TTL) {
    // owner 必须**每次调用都不同**：acquireLease 对同一个 owner 是直接放行的（那是"续租"语义）。
    // 如果 owner 写成 'task:'+taskId，同一张卡的两次并发派工会同时拿到锁 —— 互斥形同虚设，
    // 这正是 T-043 那 1.5 秒内双派的形态（实测：加了锁仍然重复 add）。
    const owner = 'worktree:' + taskId + ':' + Math.random().toString(36).slice(2, 10)
    return this.store.tx((s) => acquireLease(s, 'worktree:' + taskId, owner, ttl))
  }

  async renewWorktree(taskId, token) {
    return this.store.tx((s) => renewLease(s, 'worktree:' + taskId, token, WORKTREE_LOCK_TTL))
  }

  async unlockWorktree(taskId, token) {
    return this.store.tx((s) => {
      releaseLease(s, 'worktree:' + taskId, token)
      return { ok: true }
    })
  }

  /** 这张卡的检出意图锁现在归谁（对账与调试用；也用来判断 creating 是不是别人的现场）。 */
  worktreeLeaseOf(taskId) {
    return this.store.state.leases['worktree:' + taskId] || null
  }

  /**
   * v0.008（C-10）：父检出的**独占**租约（unit:<parentId>）。
   *
   * 父子共用同一个检出 + 同一条分支 ⇒ 同一父卡下同一时刻只能有一个子卡在执行。
   * 两个子卡在同一个目录里改同一份工作区，`git index.lock` 与工作区互覆盖都是**静默**的
   * （一方以为保存成功）—— 这是正确性问题，不是效率问题。
   *
   * owner 里带子卡 id：同一张子卡重入 = 续租（acquireLease 的语义），别的子卡抢不到。
   * 租约在子卡验收 / 取消时释放；抢不到的一方留在 running + phase='waiting-branch' 等下一拍。
   */
  async lockUnit(parentId, taskId, ttl = WORKTREE_LOCK_TTL) {
    return this.store.tx((s) => acquireLease(s, 'unit:' + parentId, 'unit:' + taskId, ttl))
  }

  unitLeaseOf(parentId) {
    return this.store.state.leases['unit:' + parentId] || null
  }

  /** 只释放**这张子卡自己**持有的那条；别人的租约一律不动（否则就是抢锁）。 */
  async releaseUnitLease(parentId, taskId) {
    return this.store.tx((s) => {
      const key = 'unit:' + parentId
      const cur = s.leases[key]
      const mine = !!(cur && cur.owner === 'unit:' + taskId)
      if (mine) delete s.leases[key]
      return { ok: true, released: mine }
    })
  }

  /** 续租。长合并期间由 mergeLocked 定时调，否则 10 分钟也会穿透。 */
  async renewMerge(projectId, token) {
    return this.store.tx((s) => renewLease(s, 'merge:' + projectId, token, MERGE_LOCK_TTL))
  }

  async unlockMerge(projectId, token) {
    return this.store.tx((s) => {
      releaseLease(s, 'merge:' + projectId, token)
      return { ok: true }
    })
  }

  // -- 合并请求 -------------------------------------------------------------

  async openMergeRequest(taskId, { headSha, baseSha, files, additions, deletions, summary }, actor) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      must(typeof headSha === 'string' && headSha, 'headSha 必填')
      const mr = {
        id: newId('mr'),
        taskId,
        headSha,
        baseSha: baseSha || null,
        files: Array.isArray(files) ? files.slice(0, 200) : [],
        additions: additions || 0,
        deletions: deletions || 0,
        summary: clampText(summary || '', 2000),
        status: 'ready_for_review',
        reviewVerdict: null,
        reviewEvidence: null,
        openedAt: nowIso(),
        mergedCommit: null,
      }
      s.merge_requests[mr.id] = mr
      task.mergeRequest = mr
      task.headSha = headSha
      task.updatedAt = nowIso()
      emit(s, 'pr.opened', { taskId, mergeRequestId: mr.id, headSha }, actor)
      return mr
    })
  }

  /** 只写审核结论（合并事务自动通过时用，不触发迁移）。 */
  async setReviewVerdict(taskId, verdict, summary = '', matched = [], actor = { role: 'dispatcher' }, { promptVersion = null } = {}) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const v = normalizeVerdict(verdict)
      const evidence = {
        verdict: v,
        promptVersion: promptVersion || this.reviewPromptSet(task.projectId).version,
        matched: Array.isArray(matched) ? matched.slice(0, 20) : [],
        summary: clampText(summary, 2000),
        reviewedAt: nowIso(),
        reviewer: actor.id || actor.role,
      }
      task.mergeRequest = { ...(task.mergeRequest || {}), reviewVerdict: v, reviewEvidence: evidence }
      if (task.mergeRequest.id && s.merge_requests) s.merge_requests[task.mergeRequest.id] = task.mergeRequest
      task.updatedAt = nowIso()
      // v1.35：结论落库要有事件（以前这条路径不留事件，审计里看不到「谁给的 approved」）
      emit(s, 'review.recorded', { taskId, verdict: v, promptVersion: evidence.promptVersion, matched: evidence.matched.length }, actor)
      return evidence
    })
  }

  // -- 审核 prompt 集 -------------------------------------------------------

  async upsertReviewPrompt(projectId, input, actor) {
    return this.store.tx((s) => {
      must(s.projects[projectId], 'unknown project')
      if (input.id) {
        const p = s.review_prompts[input.id]
        must(p, 'unknown prompt')
        Object.assign(p, {
          name: input.name ?? p.name,
          prompt: input.prompt ?? p.prompt,
          severity: input.severity ?? p.severity,
          order: input.order ?? p.order,
          enabled: input.enabled ?? p.enabled,
          version: p.version + 1,
          updatedAt: nowIso(),
        })
        emit(s, 'review_prompt.updated', { promptId: p.id, version: p.version }, actor)
        return p
      }
      const id = newId('rp')
      const p = {
        id,
        projectId,
        name: input.name || '未命名判据',
        prompt: clampText(input.prompt || '', 4000),
        severity: input.severity === 'warn' ? 'warn' : 'block',
        order: Number.isFinite(input.order) ? input.order : 100,
        enabled: input.enabled !== false,
        version: 1,
        updatedAt: nowIso(),
      }
      s.review_prompts[id] = p
      emit(s, 'review_prompt.created', { promptId: id }, actor)
      return p
    })
  }

  reviewPromptSet(projectId) {
    const s = this.store.state
    const list = Object.values(s.review_prompts).filter((p) => p.projectId === projectId && p.enabled).sort((a, b) => a.order - b.order)
    const version = list.reduce((max, p) => Math.max(max, p.version), 1)
    return { version, prompts: list }
  }

  /** 审核模板：把 prompt 集拼成调度员读的那段（设计文档 2.5.1）。 */
  renderReviewPrompt(projectId, prSnapshot) {
    const { version, prompts } = this.reviewPromptSet(projectId)
    const lines = [
      '你是本项目的合并审核员。只根据下面的 PR 快照判定，不修改代码。',
      '',
      '[PR 快照]',
      'base_sha: ' + (prSnapshot.baseSha || '-'),
      'head_sha: ' + (prSnapshot.headSha || '-'),
      'files: ' + ((prSnapshot.files || []).slice(0, 40).join(', ') || '-'),
      'diff: +' + (prSnapshot.additions || 0) + ' / -' + (prSnapshot.deletions || 0),
      'summary: ' + (prSnapshot.summary || '-'),
      // 空快照 + 非空分支 = 取数口坏了。把这条写进审核包，审核员才不会把它判成「工人没交东西」。
      ...(((!prSnapshot.files || !prSnapshot.files.length) && prSnapshot.headSha && prSnapshot.baseSha && prSnapshot.headSha !== prSnapshot.baseSha)
        ? ['⚠ 快照为空但 head ≠ base：这是取数问题，不是交付问题。先 git diff --stat <base> <head> 核对再判。']
        : []),
      '',
            '',
      // v0.008：快照是系统量出来的（base..head），不是工人填的。这句话必须出现在审核包里 ——
      // 它决定了审核员看到 files: - 时是「判 risk」还是「先去核对取数」。
      '【快照怎么来的】files / diff 由系统实测 base..head 得出，与谁提交、分几次提交无关。',
      '若为空且 head ≠ base，那是取数问题（重开一次 PR 会重算），不要当成「工人没交付」；',
      '也不要把「修快照」派给工人 —— 他改不了系统字段。核对的命令是 git diff --stat <base_sha> <head_sha>。',
'[审核清单 · prompt 集 v' + version + ']',
    ]
    for (const p of prompts) lines.push('  - ' + p.id + ' · ' + p.name + ' [' + p.severity + ']\n    ' + p.prompt)
    lines.push(
      '',
      '[输出格式] 必须是 JSON',
      '{"verdict":"approved|needs_work|risk","prompt_version":' + version + ',"matched":[{"id","version","reason","evidence"}],"summary":"一句话结论"}',
      '',
      '[判定规则]',
      '- 任一 block 级命中 → verdict = "risk"',
      '- 只有 warn 级命中 → verdict = "approved"，命中项写入 PR 评论',
      '- 测试证据缺失或与验收标准不对应 → 视为覆盖不足（block）命中',
    )
    return { version, text: lines.join('\n') }
  }

  // -- 代理与会话 -----------------------------------------------------------

  /** 手动补齐代理池（配置调大后调用，或在项目里加回被删的工位） */
  async ensureAgents(projectId, actor = { role: 'human', id: 'web' }) {
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project')
      return provisionAgentsIn(s, project, actor)
    })
  }

  async upsertAgent(projectId, input, actor) {
    return this.store.tx((s) => {
      must(s.projects[projectId], 'unknown project')
      if (input.id) {
        const a = s.agents[input.id]
        must(a, 'unknown agent')
        Object.assign(a, normalizeAgentPatch(input), { updatedAt: nowIso() })
        emit(s, 'agent.updated', { agentId: a.id }, actor)
        return a
      }
      s.seq.agent += 1
      const agent = {
        id: 'ag_' + String(s.seq.agent).padStart(3, '0'),
        projectId,
        name: input.name || (input.role === 'dispatcher' ? '调度员' : '工人') + s.seq.agent,
        role: input.role === 'dispatcher' ? 'dispatcher' : 'worker',
        slot: input.slot || 1,
        preset: input.preset || null,
        provider: input.provider || null,
        model: input.model || null,
        reasoningEffort: input.reasoningEffort || null,
        promptOverlay: clampText(input.promptOverlay || '', 4000),
        maxConcurrency: input.maxConcurrency || (input.role === 'dispatcher' ? 3 : 1),
        enabled: input.enabled !== false,
        health: 'unknown',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      s.agents[agent.id] = agent
      emit(s, 'agent.created', { agentId: agent.id, role: agent.role }, actor)
      return agent
    })
  }

  async bindSession(agentId, sessionId, { state = 'active', cwd = null } = {}, actor) {
    return this.store.tx((s) => {
      const agent = s.agents[agentId]
      must(agent, 'unknown agent')
      s.seq.session += 1
      const rec = {
        id: 'as_' + String(s.seq.session).padStart(3, '0'),
        agentId,
        projectId: agent.projectId,
        sessionId: sessionId || null,
        state,
        cwd: cwd || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      s.agent_sessions[rec.id] = rec
      emit(s, 'session.bound', { agentId, sessionId, state }, actor)
      return rec
    })
  }

  /** 记下会话标题（身份名）：改了名要能看出来，否则界面还显示旧名。 */
  async setSessionTitle(agentId, title, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const recs = Object.values(s.agent_sessions).filter((r) => r.agentId === agentId)
      must(recs.length, 'agent has no session')
      const rec = recs[recs.length - 1]
      rec.title = String(title || '').trim() || null
      rec.updatedAt = nowIso()
      emit(s, 'session.renamed', { agentId, title: rec.title }, actor)
      return rec
    })
  }

  /** 按记录 id 标记归档（历史记录要逐条标记，setSessionState 只改最新那条）。 */
  async markSessionArchived(recId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const rec = s.agent_sessions[recId]
      must(rec, 'unknown session record')
      rec.state = 'archived'
      rec.updatedAt = nowIso()
      emit(s, 'session.state', { agentId: rec.agentId, state: 'archived' }, actor)
      return rec
    })
  }

  async setSessionState(agentId, state, actor) {
    return this.store.tx((s) => {
      const recs = Object.values(s.agent_sessions).filter((r) => r.agentId === agentId)
      must(recs.length, 'agent has no session')
      const rec = recs[recs.length - 1]
      rec.state = state
      rec.updatedAt = nowIso()
      emit(s, 'session.state', { agentId, state }, actor)
      return rec
    })
  }

  // -- v1.0 三层监督 ------------------------------------------------------

  /** 车道配置（含默认补齐）。 */
  lanesOf(projectId) {
    const project = this.store.state.projects[projectId]
    return project ? normalizeLanes(project.lanes) : normalizeLanes(null)
  }

  /**
   * 改代理的上级（T20 改派）。只允许同项目内改，且不能成环。
   * 改派本身不触发重派：已派工的 run 继续跑完，新任务才按新关系走。
   */
  async reparent(agentId, supervisorId, actor = { role: 'human' }) {
    return this.store.tx((s) => {
      const agent = s.agents[agentId]
      must(agent, 'unknown agent: ' + agentId)
      if (agent.role === 'chief') throw new Error('总调度者没有上级')
      let next = supervisorId || null
      if (next) {
        const sup = s.agents[next]
        must(sup, 'unknown supervisor: ' + next)
        must(sup.projectId === agent.projectId, '上级与代理必须同项目')
        must(sup.id !== agent.id, '不能把自己设为上级')
        // 防环：沿上级链向上走，遇到自己就拒绝
        let cur = sup
        const seen = new Set([agent.id])
        while (cur && cur.supervisorId) {
          if (seen.has(cur.id)) throw new Error('上级链存在环: ' + cur.id)
          seen.add(cur.id)
          cur = s.agents[cur.supervisorId]
        }
        if (cur && cur.id === agent.id) throw new Error('不能把下级设为上级')
      }
      const before = agent.supervisorId || null
      agent.supervisorId = next
      agent.updatedAt = nowIso()
      emit(s, 'agent.reparented', { agentId, from: before, to: next }, actor)
      return agent
    })
  }

  /** 某车道里可接活的工人（按 slot 排序）。 */
  workersOf(projectId, lane) {
    const want = lane === 'issue' ? 'issue' : 'human'
    return Object.values(this.store.state.agents)
      .filter((a) => a.projectId === projectId && a.role === 'worker' && (a.lane || 'human') === want && a.enabled !== false)
      .sort((x, y) => x.slot - y.slot)
  }

  /** 某车道的子调度（取 slot 最小的 dispatcher）。 */
  supervisorOf(projectId, lane) {
    const want = lane === 'issue' ? 'issue' : 'human'
    return Object.values(this.store.state.agents)
      .filter((a) => a.projectId === projectId && a.role === 'dispatcher' && (a.lane || 'human') === want && a.enabled !== false)
      .sort((x, y) => x.slot - y.slot)[0] || null
  }

  /**
   * 懒补齐某条车道的工位（issue 车道默认 0 工位，首次出现 issue 任务时补齐）。
   * 幂等：已有工位不动。
   */
  async ensureLaneAgents(projectId, lane, want = { dispatchers: 1, workers: 2 }, actor = { role: 'system' }) {
    // recordIssues 关闭 = 纯本地看板：issue 车道一个工位都不补（也不该有 issue 卡进来）
    if (lane === 'issue') {
      const p = this.store.state.projects[projectId]
      if (!(p && p.config && p.config.recordIssues)) return { ok: false, lane, skipped: 'record-issues-off' }
    }
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project: ' + projectId)
      const lanes = normalizeLanes(project.lanes)
      const target = lane === 'issue' ? 'issue' : 'human'
      const cfg = lanes[target]
      const wantDispatchers = Math.max(cfg.dispatchers || 0, Number(want.dispatchers) || 0)
      const wantWorkers = Math.max(cfg.workers || 0, Number(want.workers) || 0)
      project.lanes = normalizeLanes({ ...lanes, [target]: { ...cfg, dispatchers: wantDispatchers, workers: wantWorkers } })
      const created = provisionAgentsIn(s, project, actor)
      emit(s, 'project.lane.ensured', { projectId, lane: target, dispatchers: wantDispatchers, workers: wantWorkers, created: created.length }, actor)
      return { lane: target, created, lanes: project.lanes }
    })
  }

  // -- v1.0 上下文预算 ----------------------------------------------------

  /** 写会话上下文水位（tick 读取 tokenMeter 后落库）。 */
  // v1.37：插件不再自己做水位追踪 —— DSH 宿主自己管理上下文压缩，不需要双轨。
  // setBudget / budgetOf 保留签名以兼容调用方，但什么都不做，ratio 恒为 0。
  async setBudget() { return { tokens: 0, ratio: 0 } }
  budgetOf() { return { tokens: 0, ratio: 0, checkedAt: null } }

  /**
   * v1.36：模型冷却（对照 ework 的 WORK_MODEL_COOLDOWN_MIN）。
   *
   * 同一个 provider/model 反复出 infra 故障（配额打满、服务不可用）时，
   * 继续往它身上派工只会把同一份错误重复 N 遍。冷却期内这个模型的工位不参与派工。
   * 冷却表按 provider/model 记（不是按工位）：一个模型挂了，用它的所有工位都该歇着。
   */
  modelKeyOf(agent) {
    if (!agent) return null
    const provider = agent.provider || null
    const model = agent.model || null
    if (!provider && !model) return null
    return String(provider || '-') + '/' + String(model || '-')
  }

  async coolModel(key, ms, reason = '', actor = { role: 'system', id: 'dispatch' }) {
    if (!key) return null
    const until = new Date(Date.now() + Math.max(1000, Number(ms) || 0)).toISOString()
    return this.store.tx((s) => {
      if (!s.model_cooldowns || typeof s.model_cooldowns !== 'object') s.model_cooldowns = {}
      const prev = s.model_cooldowns[key]
      // 取更晚的那个：短冷却不能覆盖长冷却
      if (prev && Date.parse(prev.until) > Date.parse(until)) return prev
      const rec = { key, until, reason: clampText(reason || '', 300), at: nowIso() }
      s.model_cooldowns[key] = rec
      emit(s, 'model.cooled', { key, until, reason: rec.reason }, actor)
      return rec
    })
  }

  modelCooling(key, now = Date.now()) {
    const rec = key && this.store.state.model_cooldowns && this.store.state.model_cooldowns[key]
    return !!(rec && (Date.parse(rec.until) || 0) > now)
  }

  /** 记录某工人最近一次被选中的连续次数（热点保护用，内存态，重启清零可接受）。 */
  noteWorkerPick(workerId) {
    if (!this._streak) this._streak = { agentId: null, count: 0 }
    if (this._streak.agentId === workerId) this._streak.count += 1
    else this._streak = { agentId: workerId, count: 1 }
    return { ...this._streak }
  }

  streakOf() {
    return this._streak ? { ...this._streak } : null
  }

  /** 写任务阅读范围（拆解阶段由子调度写，或人工修正）。 */
  async setScope(taskId, scope, actor = { role: 'dispatcher' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      task.scope = normalizeScope(scope)
      task.version = (task.version || 0) + 1
      task.updatedAt = nowIso()
      emit(s, 'task.scope', { taskId, scope: task.scope }, actor)
      return task
    })
  }

  /**
   * 合并状态的唯一写入口（ADR-0005）。
   *
   * 为什么同时维护 noMerge：I-12 切读侧之前，状态机的 needsMerge 读的仍是 noMerge；
   * humanReason 保留那句给人看的原因（`mergeReason` 是枚举，不能拿来当文案）；
   * 只写新字段会让"看板说 blocked、状态机以为 ready"直接分叉，而这种分叉最难查。
   */
  async setMergeState(taskId, { state, reason = null, humanReason = null, detail = null } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      must(MERGE_STATES.includes(state), 'mergeState 非法：' + state)
      task.mergeState = state
      task.mergeReason = reason == null ? null : String(reason)
      task.mergeDetail = detail || null
      task.updatedAt = nowIso()
      // noMerge 仍同步维护到 I-12 切读侧：现在 needsMerge 读的是它，
      // 不同步就会出现"看板说 blocked、状态机以为 ready"的分叉。
      //
      // blocked 也算"现在不能合"，所以 noMerge=true：验收时直接落 done-no-merge，
      // 而不是把卡推进 merging 再让 merge() 拒掉 —— 那样卡会停在合并列等一个永远不来的结果。
      // 修复动作走 flow_pr_merge（它不看 needsMerge），不靠 accept 触发。
      task.noMerge = state === 'none' || state === 'blocked'
      // 两个字段各司其职：mergeReason 是枚举（机器用、决定文案与配色），
      // noMergeReason 是人话（UI 直接显示那句"缺基线提交，不是不支持 git"）。
      if (humanReason != null) task.noMergeReason = String(humanReason)
      emit(s, 'task.merge_state', { taskId, state, reason: task.mergeReason }, actor)
      return task
    })
  }

  /** 检出状态（ADR-0006）。state 沿用 worktree 记录上已有的字段，不另开一个。 */
  async setWorktreeState(taskId, { state, reason = null, patchPath = undefined, detail = null } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const rec = s.worktrees[taskId]
      if (!rec) {
        // I-07 要在 git addWorktree 之前先写 CREATING，所以这里必须能凭空建记录。
        // I-07：git 不适用时也要能显式记一句"这张卡没有检出"（none），
        // 否则只能靠"没有记录"来表达同一种事实，读侧分不清"还没建"与"不需要建"。
        must(state === 'creating' || state === 'none' || state === 'blocked', '没有检出记录时只允许写 creating / none / blocked')
        s.worktrees[taskId] = {
          taskId, projectId: task.projectId, path: null, branch: null,
          baseSha: null, state, stateReason: reason == null ? null : String(reason),
          patchPath: null, sharedDirs: [], createdAt: nowIso(), updatedAt: nowIso(),
        }
        emit(s, 'worktree.state', { taskId, state }, actor)
        return s.worktrees[taskId]
      }
      rec.state = state
      rec.stateReason = reason == null ? null : String(reason)
      rec.detail = detail || null
      if (patchPath !== undefined) rec.patchPath = patchPath
      rec.updatedAt = nowIso()
      emit(s, 'worktree.state', { taskId, state, reason: rec.stateReason }, actor)
      return rec
    })
  }

  /**
   * 标记这张卡"不需要合并"（旧版入口，I-12 之前仍被 dispatch 调用）。
   * 真正的写入口是 setMergeState；这里走同一套归类，避免两条写路径写出不同的枚举。
   */
  async setNoMerge(taskId, noMerge, reason = '', actor = { role: 'system' }) {
    const inferred = inferMergeState({ noMerge: !!noMerge, noMergeReason: reason })
    // 不再单独发 task.no_merge：全仓没有监听者（grep 确认），setMergeState 已发 task.merge_state。
    return this.setMergeState(taskId, { state: inferred.state, reason: inferred.reason, humanReason: reason || null }, actor)
  }

  /**
   * 父卡收口：拆过的父卡从此是**集成分支**的持有者（rf-01）。
   *
   * 为什么不能再沿用 setNoMerge(true, '父卡只做汇总...')：父卡现在有分支 flow/<id>，
   * 也有唯一一个对外的 PR；把它标成「不需要合并」会让验收直接落到 done-no-merge，
   * 子卡的全部改动永远进不了 base。
   *
   * 这里只写三个字段，不动列：进待验收仍然由 children_done 迁移完成（状态机要有历史）。
   * mergeState 先给 pending —— 子卡还没合进来，父分支还不是可合并状态；
   * 等 C-05 的子卡集成全部落地后，由 deliver 把它推到 ready。
   */
  async markParentIntegration(taskId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      const branch = 'flow/' + taskId
      task.integrationBranch = branch
      task.branchFrom = null
      // 走同一套字段语义（不直接改 noMerge）：blocked/none 才同步 noMerge，pending 不是。
      task.mergeState = 'pending'
      task.mergeReason = null
      task.noMerge = false
      task.updatedAt = nowIso()
      emit(s, 'task.merge_state', { taskId, state: task.mergeState, reason: null }, actor)
      return task
    })
  }

  /**
   * 父卡收口时记下「逐张子卡核过什么」（v0.008）。
   *
   * 为什么要有这个字段：rollup 的判据以前是 `column === 'done'`，而 done 有五种来路 ——
   * 其中 done-no-commit（在父检出里没提交任何东西）和 merged-skipped（显式不合并）
   * 都不算「这块活进到父分支了」。父卡看起来子卡全齐，实际少一条支线，
   * 而这件事在看板上**没有任何痕迹**。所以把核对结果落成数据，让界面能显示、
   * 让人能在合并前看见。
   *
   * 事实在 git 里（afterUnitAccept 已经量过 HEAD），这里只做记录，不重新判断。
   */
  async recordRollup(taskId, { delivered = [], undelivered = [], headSha = null, at = null } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      task.rollup = {
        delivered: delivered.slice(0, 50),
        undelivered: undelivered.slice(0, 50),
        headSha: headSha || null,
        at: at || nowIso(),
      }
      task.updatedAt = nowIso()
      emit(s, 'task.rollup', { taskId, delivered: task.rollup.delivered, undelivered: task.rollup.undelivered }, actor)
      return task.rollup
    })
  }

  /**
   * 代理请求重开一张已完成的卡（T19 的补位）。
   *
   * 为什么不是直接放开 dispatcher 的 reopen：重开 = 否决交付物，是人的决定。
   * 但子调度经常第一个发现"这张卡其实没做完"，它只能写评论、等人看见——
   * 卡片在 done 列里，人没有理由再点进去看。所以给它一个**留痕的请求**：
   * 写清理由、挂到卡上、在看板上显示出来，最后由人执行真正的 reopen。
   */
  async requestReopen(taskId, reason, actor = { role: 'dispatcher' }) {
    const why = clampText(reason, 2000)
    if (!why || !why.trim()) throw new Error('重开请求必须说明原因')
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      if (task.column !== 'done' && task.column !== 'cancelled') {
        throw new Error('只有已完成或已取消的卡需要申请重开，当前是 ' + task.column)
      }
      const by = (actor && (actor.id || actor.role)) || 'agent'
      task.reopenRequested = { reason: why.trim(), by: String(by), at: nowIso() }
      task.updatedAt = nowIso()
      emit(s, 'task.reopen_requested', { taskId, reason: task.reopenRequested.reason, by: task.reopenRequested.by }, actor)
      return task
    })
  }

  async setDispatchReason(taskId, reason, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      task.dispatchReason = reason && typeof reason === 'object' ? reason : null
      task.updatedAt = nowIso()
      emit(s, 'task.dispatch_reason', { taskId, reason: task.dispatchReason }, actor)
      return task
    })
  }

  /** 落巡检结论（补 T8/T9：判定不落库的老缺口）。 */
  async setInspection(taskId, verdict, reasons = [], actor = { role: 'dispatcher' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      const allowed = ['keep', 'steer', 'pause', 'reset', 'done', 'blocked']
      const v = String(verdict || '').trim()
      must(allowed.includes(v), '巡检结论必须是 ' + allowed.join('/') + ' 之一')
      task.inspection = { verdict: v, reasons: (Array.isArray(reasons) ? reasons : []).slice(0, 10), at: nowIso() }
      task.updatedAt = nowIso()
      emit(s, 'task.inspection', { taskId, verdict: v, reasons: task.inspection.reasons }, actor)
      // 巡检结论同时落一条评论：看板的"讨论"区只渲染 task_comments，
      // 不写评论的话，巡检发现的问题（比如「工作目录不是 git 仓库」）在界面上等于没发生。
      // 注意：这里不能调 this.comment()——Store.tx 是排队串行的，嵌套会死锁。
      // 兜底：极老的 store 可能没有 seq.comment（迁移会补，但不赌）
      s.seq.comment = (s.seq.comment || 0) + 1
      const note = s.seq.comment
      s.task_comments.push({
        id: 'c_' + String(note).padStart(5, '0'),
        taskId,
        content: '【巡检结论】' + v + (task.inspection.reasons.length ? '：' + task.inspection.reasons.join('；') : ''),
        author: (actor && (actor.id || actor.role)) || 'dispatcher',
        role: (actor && actor.role) || 'dispatcher',
        at: nowIso(),
      })
      return task
    })
  }

  /** 只改阶段（例如 waiting-worker），不动列。 */
  async setTaskPhase(taskId, phase, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.phase = phase || ''
      task.updatedAt = nowIso()
      emit(s, 'task.phase', { taskId, phase: task.phase }, actor)
      return task
    })
  }

  /** 会话 id → 代理（判断评论是调度员写的还是工人写的）。 */
  agentBySession(sessionId) {
    if (!sessionId) return null
    const recs = Object.values(this.store.state.agent_sessions).filter((r) => r.sessionId === sessionId)
    if (!recs.length) return null
    return this.store.state.agents[recs[recs.length - 1].agentId] || null
  }

  latestSession(agentId) {
    // 归档过的会话不算「这个工位的活会话」：否则清理掉一个孤儿会话之后，
    // 初始化仍会捡起那条归档记录、永远建不出新的（界面上就是「会话已存在」但看不见）。
    const recs = Object.values(this.store.state.agent_sessions)
      .filter((r) => r.agentId === agentId && r.state !== 'archived')
    return recs.length ? recs[recs.length - 1] : null
  }

  /**
   * 选一个还能接活的工人。
   * v1.0：先按车道过滤（issue 任务绝不落到 human 工人），再按「同域打分」排序：
   *   覆盖度优先（3 分权重）→ 负载 → 工位状态 → 预算风险；跨车道直接 Infinity。
   * 返回 agent 或 null；`pickWorkerScored` 额外返回打分明细用于审计。
   */
  pickWorker(projectId, opts = {}) {
    const picked = this.pickWorkerScored(projectId, opts)
    return picked ? picked.agent : null
  }

  pickWorkerScored(projectId, { exclude = [], task = null, streakInfo = null, siblingOf = null } = {}) {
    const s = this.store.state
    const project = s.projects[projectId]
    if (!project) return null
    const taskLane = (task && task.lane) || 'human'
    const all = this.workersOf(projectId, taskLane).filter((a) => !exclude.includes(a.id))
    if (!all.length) return null
    // v1.36：冷却中的模型不参与派工。全都在冷却时返回 null，但把原因记下来（dispatch 会写进评论）。
    const nowMs = Date.now()
    const workers = all.filter((a) => !this.modelCooling(this.modelKeyOf(a), nowMs))
    if (!workers.length) {
      this._coolingBlocked = all.map((a) => this.modelKeyOf(a)).filter(Boolean)
      return null
    }
    const cfg = withDefaults(project.config)
    const load = (a) => Object.values(s.runs).filter((r) => r.agentId === a.id && r.status === 'running').length
    const seat = (a) => {
      const rec = this.latestSession(a.id)
      return rec ? rec.state : 'none'
    }
    const budgetRatio = (a) => {
      const rec = this.latestSession(a.id)
      return rec && rec.budget ? Number(rec.budget.ratio) || 0 : 0
    }
    // v1.39：同一父卡的其他子卡优先分给不同工人 —— 大需求拆开的意义就是并行，
    // 全压给一个人等于没拆。只有全都忙不过来时才允许叠加。
    const siblingLoad = (a) => {
      if (!siblingOf) return 0
      return Object.values(s.tasks).filter((t) => t && t.parentId === siblingOf && t.parentId && t.assignee === a.id &&
        !['done', 'cancelled'].includes(t.column)).length
    }
    const candidates = workers
      .map((a) => ({ agent: a, load: load(a), seat: seat(a), budgetRatio: budgetRatio(a), dist: siblingLoad(a) }))
      .filter((x) => x.load < (x.agent.maxConcurrency || 1))
      .map((x) => ({ ...x, workerScope: workerScopeProfile(s.tasks, x.agent.id, { limit: cfg.scopeDecayTasks }) }))
    // 打散：先把「这个父卡名下还没活」的人挑出来（有的话只在它们里面选）
    const spread = siblingOf ? candidates.filter((x) => !x.dist) : []
    const pool = spread.length ? spread : candidates
    const picked = pickByScope(pool, {
      taskScope: (task && task.scope) || null,
      taskLane,
      streakInfo,
      hotWorkerStreak: cfg.hotWorkerStreak,
    })
    if (!picked) return null
    return {
      agent: picked.agent,
      cost: picked.cost,
      overlap: picked.overlap,
      rotation: picked.reason,
      lane: picked.agent.lane || 'human',
      spread: !!spread.length,
    }
  }

  /** 派工事务（设计文档 5.13）：开 run + 占租约 + 把任务绑到工人。 */
  async startRun(taskId, { agentId, sessionId, trigger = 'approve' }, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      // v0.016（ticket 12）：有新 run 就重置停摆窗口 —— 告警只针对「真的没人动」。
      const proj = s.projects[task.projectId]
      if (proj) proj.stallNotifiedAt = null
      const worker = s.agents[agentId]
      must(worker, 'unknown agent')
      // I13：worker 只能接自己上级名下的任务；human/system 派工不受限（人工直派是最高授权）。
      const actorRole = (actor && actor.role) || 'system'
      if (worker.role === 'worker' && worker.supervisorId && !['human', 'system'].includes(actorRole)) {
        const expected = s.agents[worker.supervisorId]
        must(expected, '派工者的上级不存在: ' + worker.supervisorId)
        must(
          actor.id === expected.id || actorRole === 'dispatcher' && (worker.lane || 'human') === (expected.lane || 'human'),
          'worker ' + agentId + ' 属于 ' + expected.id + '，只有它的上级能派工',
        )
      }
      // 车道一致性：issue 车道的任务不能落到 human 车道的工人，反之亦然（可被 human 派工豁免）。
      if (worker.role === 'worker' && ['human', 'system', 'dispatcher'].includes(actorRole)) {
        const wLane = worker.lane || 'human'
        const tLane = task.lane || 'human'
        must(wLane === tLane, '车道不匹配：任务在 ' + tLane + ' 车道，工人属于 ' + wLane + ' 车道')
      }
      // v1.35：I2 在事务内判（原来只有 dispatch 入口处读一次 activeRunId，
      // 两次并发派工都能读到「没 run」然后各开一条）。
      const live = task.activeRunId && s.runs[task.activeRunId]
      if (live && live.status === 'running') {
        const err = new Error('任务已有在跑的 run：' + live.id)
        err.code = 'DUPLICATE_RUN'
        err.runId = live.id
        throw err
      }
      s.seq.run += 1
      // fencing token（v1.22 P5）：每派一次工就自增，run 里记下当时的序号。
      // 迟到的 stop/endRun 带着旧序号回来时直接拒掉 —— 否则 rework 之后
      // 旧 run 的收尾会把新 run 的租约和 activeRunId 一起抹平。
      task.runSeq = (Number(task.runSeq) || 0) + 1
      const runSeq = task.runSeq
      const run = {
        id: 'run_' + String(s.seq.run).padStart(3, '0'),
        taskId,
        projectId: task.projectId,
        agentId,
        sessionId: sessionId || null,
        status: 'running',
        trigger,
        seq: runSeq,
        // 派工幂等键（设计文档 §3.1：dispatch:<taskId>:<runSeq>）
        dedupeKey: 'dispatch:' + taskId + ':' + runSeq,
        infraAttempts: 0,
        attempts: 0,
        startedAt: nowIso(),
        lastHeartbeat: nowIso(),
        // v0.016（ticket 08）：**进展**与**心跳**是两件事。心跳只证明进程活着；
        // 进展由进度更新、评论、以及 tick 观察到的新提交推进 —— 只有后者能阻止「空转收回」。
        lastProgressAt: nowIso(),
        lastSeenSha: null,
        endedAt: null,
        stopReason: null,
      }
      s.runs[run.id] = run
      task.assignee = agentId
      task.activeRunId = run.id
      task.dispatchedBy = (actor && actor.id) || actorRole
      if (task.lane === undefined) task.lane = worker.lane || 'human'
      task.updatedAt = nowIso()
      const lease = acquireLease(s, 'task:' + taskId, agentId)
      emit(s, 'task.dispatched', { taskId, runId: run.id, agentId, sessionId, trigger }, actor)
      return { run, lease }
    })
  }

  /** 收 run：释放租约、清 activeRunId。status = stopped | failed | merged | cancelled。 */
  /** 记录这张卡是从哪个对话发起的（回信投递的收件人）。 */
  async setOriginSession(taskId, sessionId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      const next = sessionId ? String(sessionId) : null
      if (task.originSessionId !== next) {
        task.originSessionId = next
        task.updatedAt = nowIso()
      }
      return task.originSessionId
    })
  }

  /** 这张卡的回信收件人（没记录返回 null）。 */
  originSessionOf(taskId) {
    const task = this.store.state.tasks[taskId]
    return (task && task.originSessionId) || null
  }

  /** 把 run 改挂到另一个会话（派工自愈：旧会话的 preset 失效，重建后要换 sessionId）。 */
  async updateRun(runId, patch = {}) {
    return this.store.tx((s) => {
      const run = s.runs[runId]
      must(run, 'unknown run: ' + runId)
      if (patch.sessionId !== undefined) run.sessionId = patch.sessionId
      if (patch.status !== undefined) run.status = patch.status
      run.updatedAt = nowIso()
      return run
    })
  }

  /**
   * 收 run：释放租约、清 activeRunId。status = stopped | failed | merged | cancelled。
   *
   * v1.22 P5 起带 fencing：传了 `runId` 就只收「当前活跃且 id 匹配」的那一条。
   * 不匹配说明这条 run 已经被后来的派工取代（rework / 重派 / 恢复），
   * 它的迟到收尾必须**什么都不做** —— 否则会把新 run 的租约和 activeRunId 抹掉。
   * 不传 runId 的老调用点保留原行为（系统级收尾，例如取消整张卡）。
   */
  async endRun(taskId, status, { stopReason = null, runId = null } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      if (runId && task.activeRunId !== runId) {
        const stale = s.runs[runId] || null
        return { run: stale, stale: true, ignored: true }
      }
      const run = task.activeRunId ? s.runs[task.activeRunId] : null
      if (run) {
        run.status = status
        run.endedAt = nowIso()
        run.stopReason = stopReason ? clampText(stopReason, 2000) : null
      }
      task.activeRunId = null
      const lease = s.leases['task:' + taskId]
      if (lease) releaseLease(s, 'task:' + taskId, lease.token)
      emit(s, 'task.run.ended', { taskId, runId: run ? run.id : null, status, stopReason }, actor)
      return run
    })
  }

  // -- 巡检 ----------------------------------------------------------------

  /** 只看不写：返回建议。真正动手由调用方决定（设计文档 7.4）。 */
  inspect(taskId) {
    const t = this.store.state.tasks[taskId]
    must(t, 'unknown task')
    const reasons = []
    let verdict = 'keep'
    // v1.36：巡检信号（§4.7）优先展示 —— 它们是跨轮判出来的，比单轮结论更有信息量
    const sig = t.inspectionSignals
    if (sig && sig.signals && sig.signals.length) {
      reasons.push('巡检信号：' + sig.signals.join('/') + '（' + (sig.reasons || []).join('；') + '）')
      if (sig.verdict === 'block' || sig.verdict === 'pause') verdict = 'steer'
    }
    if (t.blocked) { verdict = 'steer'; reasons.push('任务被阻塞：' + t.blocked.reason) }
    else if (t.column === 'running' && t.phase === 'paused') { verdict = 'steer'; reasons.push('工人已暂停') }
    else if (t.column === 'running' && t.stopReport) { verdict = 'done'; reasons.push('工人已交停止报告，等待分类') }
    else if (t.column === 'planning' && t.phase === 'waiting-approval') { verdict = 'steer'; reasons.push('plan 待人类批准') }
    else if (t.column === 'merging' && t.phase === 'review-pending') { verdict = 'steer'; reasons.push('PR 待审核') }
    else if (t.column === 'verifying') { verdict = 'keep'; reasons.push('待人类验收') }
    return { taskId, verdict, reasons, at: nowIso() }
  }

  /**
   * v1.36：记一轮巡检事实并判信号（设计文档 §4.7，对照 ework 的升级规则）。
   *
   * 只在工人自停时调用；判定是纯函数（lib/inspect-signals.js），这里只负责落历史。
   * 历史留最近 12 轮：够判「连续 N 轮」，又不至于把状态文件撑大。
   */
  async noteInspectionCycle(taskId, facts = {}, actor = { role: 'system', id: 'inspect' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const prev = Array.isArray(task.inspectHistory) ? task.inspectHistory : []
      const analysis = analyzeCycles(prev, facts)
      const entry = {
        at: nowIso(),
        hasDiff: facts.hasDiff === undefined ? null : !!facts.hasDiff,
        code: facts.code ? String(facts.code).slice(0, 60) : null,
        needsConfirm: !!facts.needsConfirm,
        testsFailed: !!facts.testsFailed,
        budgetRatio: Number(facts.budgetRatio) || 0,
        compactBlocked: !!facts.compactBlocked,
        signals: analysis.signals,
        verdict: analysis.verdict,
      }
      task.inspectHistory = [...prev, entry].slice(-12)
      task.inspectionSignals = analysis
      task.updatedAt = nowIso()
      if (analysis.signals.length) {
        emit(s, 'task.inspect_signals', { taskId, signals: analysis.signals, verdict: analysis.verdict, reasons: analysis.reasons }, actor)
      }
      return analysis
    })
  }

  // -- v0.3：角色（总调度者 / 派工者 / 工人，设计文档 14.2） ------------------

  chiefOf(projectId) {
    return Object.values(this.store.state.agents)
      .filter((a) => a.projectId === projectId && a.role === 'chief' && a.enabled !== false)
      .sort((x, y) => x.slot - y.slot)[0] || null
  }

  /**
   * 对话框默认发给谁。
   * v1.0：主调度 = 用户自己的默认聊天会话——优先返回「已把外部会话绑到 chief 上」的那个；
   * 没有绑定才退化成排第一的 chief，再退到 dispatcher。
   */
  chatTarget(projectId) {
    const s = this.store.state
    const of = (role) => Object.values(s.agents)
      .filter((a) => a.projectId === projectId && a.role === role && a.enabled !== false)
      .sort((x, y) => x.slot - y.slot)[0]
    const bound = Object.values(s.agents)
      .filter((a) => a.projectId === projectId && a.role === 'chief' && a.enabled !== false)
      .sort((x, y) => x.slot - y.slot)
      .find((a) => {
        const rec = this.latestSession(a.id)
        return !!(rec && rec.sessionId && rec.state !== 'archived')
      })
    return bound || of('chief') || of('dispatcher') || null
  }

  /**
   * 把用户自己的默认聊天会话认作某项目的主调度（v1.0）。
   * 语义上不再"给 chief 建一个专属聊天窗口"——默认聊天区就是主调度的工作台。
   */
  async bindChiefSession(projectId, sessionId, { cwd = null } = {}, actor = { role: 'human', id: 'web' }) {
    const sid = String(sessionId || '').trim()
    must(sid, 'sessionId 必填')
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project: ' + projectId)
      const chief = Object.values(s.agents)
        .filter((a) => a.projectId === projectId && a.role === 'chief')
        .sort((x, y) => x.slot - y.slot)[0]
      must(chief, '项目还没有总调度者')
      // 同一个会话不能同时是两个项目的主调度
      for (const a of Object.values(s.agents)) {
        if (a.id === chief.id || a.projectId === projectId) continue
        for (const rec of Object.values(s.agent_sessions)) {
          if (rec.agentId === a.id && rec.sessionId === sid) throw new Error('该会话已作为其它项目的主调度')
        }
      }
      s.seq.session += 1
      const rec = {
        id: 'as_' + String(s.seq.session).padStart(3, '0'),
        agentId: chief.id,
        projectId,
        sessionId: sid,
        state: 'idle',
        cwd: cwd || null,
        role: 'chief-chat',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      s.agent_sessions[rec.id] = rec
      project.chiefSessionId = sid
      project.updatedAt = nowIso()
      emit(s, 'chief.session.bound', { projectId, sessionId: sid, agentId: chief.id }, actor)
      return rec
    })
  }

  /** 解绑主调度（清项目字段 + 把 chief-chat 记录标 archived）。 */
  async unbindChiefSession(projectId, actor = { role: 'human', id: 'web' }) {
    return this.store.tx((s) => {
      const project = s.projects[projectId]
      must(project, 'unknown project: ' + projectId)
      const before = project.chiefSessionId || null
      project.chiefSessionId = null
      project.updatedAt = nowIso()
      // 该会话在本项目下的所有绑定都归档：否则会话 → 项目的反查（agent_sessions 分支）
      // 会把解绑过的对话又判回原项目，用户看到的是"解绑没生效"。
      for (const rec of Object.values(s.agent_sessions)) {
        const mine = rec.projectId === projectId && (rec.role === 'chief-chat' || rec.sessionId === before)
        if (mine && rec.state !== 'archived' && (!before || rec.sessionId === before || rec.role === 'chief-chat')) {
          rec.state = 'archived'
          rec.updatedAt = nowIso()
        }
      }
      emit(s, 'chief.session.unbound', { projectId, sessionId: before }, actor)
      return { projectId, sessionId: before }
    })
  }

  /** 某项目当前的主调度会话（没绑定返回 null）。 */
  chiefSessionOf(projectId) {
    const project = this.store.state.projects[projectId]
    if (!project) return null
    // project.chiefSessionId 是唯一真相：解绑后即使 chief 还挂着别的会话也不能再报旧绑定
    return project.chiefSessionId || null
  }

  /** 交付包（TX-12）：chief 把卡片与计划交给调度者，绑定 plan_rev。 */
  async handoff(taskId, { to = 'dispatcher', notes = '' } = {}, actor = { role: 'chief' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      must(task.plan && task.plan.revision > 0 && task.plan.text, '先写计划再交付（交付包要带 plan_rev）')
      const handoff = { to, planRev: task.plan.revision, notes: clampText(notes, 4000), at: nowIso(), by: actor.id || actor.role }
      task.handoff = handoff
      task.updatedAt = nowIso()
      emit(s, 'task.handoff', { taskId, planRev: handoff.planRev, to, notes: handoff.notes }, actor)
      return handoff
    })
  }

  // -- v0.3：worktree（TX-13 / TX-14） ---------------------------------------

  worktreeOf(taskId) { return this.store.state.worktrees[taskId] || null }

  /**
   * 卡级推进预算的计数器（v0.016 / ticket 05）。
   *
   * 只记「连续第几轮没有任何新提交」——按**事实**算，不看模型怎么说。
   * 有交付就清零：返工、换策略、重新规划都允许，只要真的推进了一格。
   */
  async noteProgressRuns(taskId, advanced, actor = { role: 'system', id: 'system:progress-budget' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const n = advanced ? 0 : (Number(task.noProgressRuns) || 0) + 1
      task.noProgressRuns = n
      task.updatedAt = nowIso()
      emit(s, 'task.progress-budget', { taskId, noProgressRuns: n }, actor)
      return n
    })
  }

  /**
   * 写下这一轮的「接力包」（v0.016 / ticket 03）。
   *
   * 为什么由系统写而不是靠模型的六问：六问是**软要求**（可以只写 summary），
   * 而接力包要的是「下一轮开工前必须知道的事实」，不能依赖模型自觉。
   * 事实来源全部本就可查：git 提交、改动文件、progress.next、未答请示、上轮返工理由。
   */
  async recordHandoff(taskId, handoff, actor = { role: 'system', id: 'system:handoff' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const one = {
        commits: Array.isArray(handoff.commits) ? handoff.commits.slice(0, 5) : [],
        changedFiles: Array.isArray(handoff.changedFiles) ? handoff.changedFiles.slice(0, 40) : [],
        next: String(handoff.next || '').slice(0, 300),
        open: Array.isArray(handoff.open) ? handoff.open.slice(0, 3) : [],
        avoidTry: handoff.avoidTry ? String(handoff.avoidTry).slice(0, 300) : null,
        at: nowIso(),
      }
      task.handoff = one
      task.updatedAt = one.at
      emit(s, 'task.handoff', { taskId, commits: one.commits.length, files: one.changedFiles.length }, actor)
      return one
    })
  }

  async recordWorktree(taskId, info, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const rec = {
        taskId, projectId: task.projectId, path: info.path, branch: info.branch,
        baseSha: info.baseSha || null, state: info.state || 'ready',
        // v1.29：记下这个 worktree 共享了哪些依赖目录（junction）。
        // 排查「worker 说没环境」时，一眼能看出链接到底建没建。
        sharedDirs: Array.isArray(info.sharedDirs) ? info.sharedDirs.slice(0, 20) : [],
        // v0.008（C-10）：子卡与父卡共用检出 —— 这条记录是**只读投影**，
        // 不参与回收（回收跟着父卡走），只用来「验收时查工作区干净吗 / 取 HEAD」。
        shared: info.shared === true,
        parentId: info.parentId || null,
        createdAt: nowIso(), updatedAt: nowIso(),
      }
      s.worktrees[taskId] = rec
      task.worktree = rec.shared
        ? { path: rec.path, branch: rec.branch, baseSha: rec.baseSha, shared: true, parentId: rec.parentId }
        : { path: rec.path, branch: rec.branch, baseSha: rec.baseSha }
      task.updatedAt = nowIso()
      emit(s, 'worktree.created', { taskId, path: rec.path, branch: rec.branch }, actor)
      return rec
    })
  }

  async dropWorktree(taskId, { reason = '' } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const rec = s.worktrees[taskId]
      if (!rec) return null
      const task = s.tasks[taskId]
      delete s.worktrees[taskId]
      if (task) { task.worktree = null; task.updatedAt = nowIso() }
      emit(s, 'worktree.removed', { taskId, path: rec.path, reason }, actor)
      return rec
    })
  }

  /**
   * v0.008（C-10）：子卡派工时记下父分支的 HEAD（unitStartSha）。
   *
   * 子卡验收只回答一个问题：**父分支的 HEAD 是不是比派工时前进了**。
   * 所以基线必须在这里落库 —— 不比对工人自述（自述留在 stopReport 里），
   * 交付事实从 git 量。
   */
  async setUnitStartSha(taskId, sha, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.unitStartSha = sha ? String(sha) : null
      task.updatedAt = nowIso()
      emit(s, 'task.unit_start', { taskId, sha: task.unitStartSha }, actor)
      return task
    })
  }

  /**
   * v0.008（C-10）：收掉一张卡上的 PR 快照。
   *
   * 用在 legacy 子卡把分支合进父分支之后：它的 PR 已经没有任何意义，
   * 但记录不删（审计要查得到「它曾经开过 PR」），只标 superseded 并摘掉
   * task.mergeRequest —— 留一张 open 的 PR 会让看板与远程对账一直把它当没收口。
   */
  async clearPullRequest(taskId, { reason = '已合进父分支，子卡不再有 PR' } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task) return null
      const prs = Object.values(s.pull_requests || {}).filter((p) => p && p.taskId === taskId)
      for (const pr of prs) {
        pr.status = 'superseded'
        pr.supersededAt = nowIso()
        pr.supersededReason = String(reason).slice(0, 500)
        pr.updatedAt = nowIso()
      }
      task.mergeRequest = null
      task.updatedAt = nowIso()
      if (prs.length) emit(s, 'pr.superseded', { taskId, prIds: prs.map((p) => p.id), reason }, actor)
      return prs.length
    })
  }

  // -- 外部 PR 的受限合并卡（rf-03 / C-02） ------------------------------------

  /**
   * 建一张「外部 PR 的受限合并卡」。
   *
   * 形状是 fix 的：落在 merging、没有检出、mergeState=pending、永不派工。
   * 为什么不是「先建 todo 再推进」：这张卡没有调研/规划/实现三个阶段可走 ——
   * 代码已经在别人的分支上写完了，我们要做的就是审核 + 合并 + 收尾。
   *
   * 幂等锚点是 originRef（`external-pr:<provider>#<number>`），与 issue 那套一致：
   * 同一个 PR 反复入站只建一张卡。
   */
  async createExternalPrTask(projectId, facts = {}, actor = { role: 'system', id: 'sync:external-pr' }) {
    const f = facts || {}
    const provider = f.provider === 'gitea' ? 'gitea' : 'github'
    const number = Number(f.number) || null
    must(number, '外部 PR 缺编号')
    const originRef = 'external-pr:' + provider + '#' + number
    const dup = Object.values(this.store.state.tasks || {}).find((t) => t && t.originRef === originRef)
    if (dup) return dup
    const note = [
      f.author ? '作者 ' + f.author : null,
      f.headBranch ? String(f.headBranch) + ' → ' + String(f.baseBranch || '?') : null,
      f.url || null,
    ].filter(Boolean).join('\n')
    const task = await this.createTask(projectId, {
      title: f.title || ('外部 PR #' + number),
      note,
      kind: 'external-pr',
      origin: 'auto',
      lane: 'human',
      originRef,
      originRev: f.updatedAt || f.createdAt || null,
      priority: 'medium',
    }, actor)
    return this.store.tx((s) => {
      const t = s.tasks[task.id]
      must(t, 'unknown task')
      t.external = {
        provider,
        number,
        url: f.url || null,
        headBranch: f.headBranch || null,
        baseBranch: f.baseBranch || null,
        headSha: f.headSha || null,
        state: 'open',
      }
      // 这一列 + 这一 phase 的组合就是「等人审核、随时可合」。
      t.column = 'merging'
      t.phase = 'merge-ready'
      // 没有检出：派工守卫（dispatch）看到 worktree=false 就不会建会话，
      // kind 是第二道保险（C-06 还会再加一条）。
      t.worktree = false
      t.mergeState = 'pending'
      t.mergeReason = null
      t.noMerge = false
      t.headSha = f.headSha || null
      t.updatedAt = nowIso()
      emit(s, 'task.merge_state', { taskId: t.id, state: 'pending', reason: null }, actor)
      return t
    })
  }

  /** 单独补外部身份（C-02 的兜底路径会用到；也便于测试构造）。 */
  async setExternal(taskId, external = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const t = s.tasks[taskId]
      must(t, 'unknown task')
      const x = external || {}
      // **补丁语义**：只覆盖调用方真的给了的键。
      // 原来的写法是整块重建 —— 于是 `setExternal(id, {resolver:true, baseRef})`
      // 会把 number/headSha 一起清成 null，合并时当场判「这张外部 PR 卡没有 PR 编号」（踩过）。
      const prev = t.external || {}
      const pick = (k, dflt) => (x[k] === undefined ? (prev[k] === undefined ? dflt : prev[k]) : x[k])
      t.external = {
        provider: pick('provider') === 'gitea' ? 'gitea' : 'github',
        number: Number(pick('number', null)) || null,
        url: pick('url', null) || null,
        headBranch: pick('headBranch', null) || null,
        baseBranch: pick('baseBranch', null) || null,
        headSha: pick('headSha', null) || null,
        state: pick('state', 'open') || 'open',
      }
      if (x.resolver !== undefined) t.external.resolver = x.resolver === true
      else if (prev.resolver !== undefined) t.external.resolver = prev.resolver === true
      if (x.baseRef !== undefined) t.external.baseRef = x.baseRef || null
      else if (prev.baseRef !== undefined) t.external.baseRef = prev.baseRef || null
      if (x.kind) t.kind = x.kind
      t.updatedAt = nowIso()
      emit(s, 'task.external', { taskId, number: t.external.number }, actor)
      return t
    })
  }
  // -- v0.3：PR 与合并（TX-15 / TX-16 / TX-17） ------------------------------

  async openPullRequest(taskId, info = {}, actor = { role: 'worker' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const headSha = String(info.headSha || '')
      must(headSha, 'PR 必须带 head_sha')
      const dup = Object.values(s.pull_requests).find((p) => p.taskId === taskId && p.headSha === headSha)
      if (dup) {
        // v0.008：同一 head 再开一次 PR 不是「什么也没发生」，而是「快照被重新量了一次」。
        // 正是这条路径让线上那张已经记成空快照的卡能自愈 —— 否则它只能删数据重建。
        if (Array.isArray(info.files) && info.files.length) {
          dup.files = info.files.slice(0, 200)
          dup.additions = Number(info.additions) || 0
          dup.deletions = Number(info.deletions) || 0
          dup.summary = clampText(info.summary || '', 2000)
          dup.updatedAt = nowIso()
          if (task.mergeRequest && task.mergeRequest.id === dup.id) {
            task.mergeRequest.files = dup.files
            task.mergeRequest.additions = dup.additions
            task.mergeRequest.deletions = dup.deletions
            task.mergeRequest.summary = dup.summary
          }
        }
        return dup
      }
      s.seq.pr += 1
      const pr = {
        id: 'pr_' + String(s.seq.pr).padStart(3, '0'),
        taskId, projectId: task.projectId,
        remoteId: info.remoteId || null,
        headSha, baseSha: info.baseSha || null,
        // C-02：外部 PR 的卡要能说清「合向哪条基线」「这是谁的 PR」。
        base: info.base || null,
        source: info.source === 'external' ? 'external' : 'local',
        branch: info.branch || (task.worktree && task.worktree.branch) || null,
        // v0.008：PR 快照必须自带交付事实。审核模板只印快照，不给「你以为改了但没记」留接口。
        // 这两个字段原来只存在于没人调用的 openMergeRequest 上，于是审核员永远看到 files: - / diff: +0/-0。
        files: Array.isArray(info.files) ? info.files.slice(0, 200) : [],
        additions: Number(info.additions) || 0,
        deletions: Number(info.deletions) || 0,
        summary: clampText(info.summary || '', 2000),
        title: clampText(info.title || task.title, 200),
        status: 'open', mergeCommit: null, conflictFiles: [], attempts: 0,
        createdAt: nowIso(), updatedAt: nowIso(),
      }
      s.pull_requests[pr.id] = pr
      task.headSha = headSha
      task.mergeRequest = { id: pr.id, headSha, baseSha: pr.baseSha, branch: pr.branch, status: 'open', files: pr.files, additions: pr.additions, deletions: pr.deletions, summary: pr.summary, reviewVerdict: task.mergeRequest ? task.mergeRequest.reviewVerdict : null }
      task.updatedAt = nowIso()
      emit(s, 'pr.opened', { taskId, prId: pr.id, headSha, branch: pr.branch }, actor)
      return pr
    })
  }

  /**
   * 把远程 PR 的身份记到本地 PR 上（v1.22）。
   *
   * 远程 PR 只做展示与回读：人在 GitHub 上看到的那条 PR 和本地这条 pr_00x 是一件事，
   * 但**合并仍以本地为准**，所以这里只写身份字段，不改 status。
   */
  async attachPullRemote(prId, info = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const pr = s.pull_requests[prId]
      must(pr, 'unknown pull request')
      pr.remote = {
        source: info.source || 'github',
        number: Number(info.number) || null,
        url: info.url || null,
        state: info.state || 'open',
        merged: info.merged === true,
        mergedAt: info.mergedAt || null,
        mergedBy: info.mergedBy || null,
        mergeCommitSha: info.mergeCommitSha || null,
        at: nowIso(),
      }
      pr.updatedAt = nowIso()
      emit(s, 'pr.remote', { prId, taskId: pr.taskId, number: pr.remote.number, state: pr.remote.state }, actor)
      return pr
    })
  }

  /**
   * 远程 PR 事实回读（v1.22）：合并/关闭/评审都记下来，但**不驱动本地状态机**。
   *
   * 唯一例外是「远程已合并」：那说明代码真的进了主干，本地不跟进就会卡在合并中。
   * 这一条也只在本地还没 merga 的时候补，避免把本地冲突回滚过的卡又推回去。
   */
  async syncPullRemote(prId, facts = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const pr = s.pull_requests[prId]
      must(pr, 'unknown pull request')
      pr.remote = {
        ...(pr.remote || {}),
        source: facts.source || (pr.remote && pr.remote.source) || 'github',
        number: facts.number || (pr.remote && pr.remote.number) || null,
        url: facts.url || (pr.remote && pr.remote.url) || null,
        state: facts.state || (pr.remote && pr.remote.state) || 'open',
        merged: facts.merged === true,
        mergedAt: facts.mergedAt || (pr.remote && pr.remote.mergedAt) || null,
        mergedBy: facts.mergedBy || (pr.remote && pr.remote.mergedBy) || null,
        mergeCommitSha: facts.mergeCommitSha || (pr.remote && pr.mergeCommitSha) || null,
        mergeableState: facts.mergeableState || (pr.remote && pr.remote.mergeableState) || null,
        reviews: Array.isArray(facts.reviews) ? facts.reviews.slice(-20) : ((pr.remote && pr.remote.reviews) || []),
        at: nowIso(),
      }
      pr.updatedAt = nowIso()
      emit(s, 'pr.remote.synced', { prId, taskId: pr.taskId, merged: pr.remote.merged, state: pr.remote.state }, actor)
      return pr
    })
  }

  async markMerged(taskId, { commit = null, strategy = null, alreadyMerged = false, mergeCommit = null } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      // v1.32：没有 pull_requests 记录也能记合并提交。
      // 原来这里 hard must，但"卡片上的 mergeRequest"和"pull_requests 表"是两套记录 ——
      // 只有 pr_mr 路径才建 pull_requests。硬要求它存在会把"记录合并结果"这件事
      // 和"走哪条开 PR 的路"耦合在一起，是不必要的约束。
      const pr = Object.values(s.pull_requests).filter((p) => p.taskId === taskId).pop()
      if (pr) {
        pr.status = 'merged'; pr.mergedCommit = commit; pr.mergeCommit = commit; pr.strategy = strategy; pr.updatedAt = nowIso()
      }
      // v1.32：字段名统一成 mergedCommit。
      // 原来 openMergeRequest 创建的是 mergedCommit，这里写的却是 mergeCommit ——
      // 于是**即使真的合并了，mergedCommit 也永远是 null**，
      // 看板上看起来「合并过了」但拿不到合并提交。两个名字都写，兼容历史数据。
      // alreadyMerged=true 表示「分支早就全部合入了，这次没有产生新提交」：
      // 那时 commit 记的是这条分支自己的头，mergeCommit 为 null —— 别把别人的合并提交记成自己的。
      task.mergeRequest = {
        ...(task.mergeRequest || {}),
        status: 'merged',
        mergedCommit: commit,
        mergeCommit,
        alreadyMerged,
        queuedAt: null,
      }
      task.mergeIntent = null
      task.updatedAt = nowIso()
      emit(s, 'pr.merged', { taskId, prId: pr ? pr.id : null, baseSha: pr ? pr.baseSha : null, commit, strategy }, actor)
      return pr || task.mergeRequest
    })
  }

  /** v1.36：合并后冒烟检查的结果（跟着合并请求走，界面上能查到跑的是什么、失败在哪）。 */
  async setPostMergeCheck(taskId, result = {}, actor = { role: 'system', id: 'system:merge' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.mergeRequest = {
        ...(task.mergeRequest || {}),
        postMergeCheck: {
          ok: result.ok === true,
          command: clampText(result.command || '', 500),
          // 在哪个目录里跑的：合并落到集成检出之后，"冒烟在主检出里跑"是假绿的典型来源。
          cwd: result.cwd ? clampText(result.cwd, 500) : null,
          code: result.code ?? null,
          timedOut: result.timedOut === true,
          stdout: clampText(result.stdout || '', 4000),
          stderr: clampText(result.stderr || '', 4000),
          at: nowIso(),
        },
      }
      task.updatedAt = nowIso()
      emit(s, 'pr.post_merge_check', { taskId, ok: result.ok === true, code: result.code ?? null }, actor)
      return task.mergeRequest.postMergeCheck
    })
  }

  async markMergeConflict(taskId, { files = [], baseSha = null, reason = '' } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const pr = Object.values(s.pull_requests).filter((p) => p.taskId === taskId).pop()
      if (pr) {
        pr.status = 'conflict'
        pr.conflictFiles = files.slice(0, 200)
        pr.attempts += 1
        pr.updatedAt = nowIso()
      }
      task.mergeRequest = { ...(task.mergeRequest || {}), status: 'conflict', conflictFiles: files.slice(0, 200), queuedAt: null }
      task.mergeIntent = null
      task.updatedAt = nowIso()
      emit(s, 'pr.merge_conflict', { taskId, prId: pr ? pr.id : null, baseSha, files: files.slice(0, 50), reason }, actor)
      return pr
    })
  }

  /**
   * v1.35：合并意图（设计文档 §3：L1 先写意图，再动 git）。
   *
   * 原来 mergeLocked 直接 git merge，成功后才 markMerged —— 两步之间进程没了，
   * base 里已经有了这次合并，卡却还停在 merging、mergedCommit 为空，只能人手修（repairUnmerged）。
   * 现在 git 动手前先落 mergeIntent，tick 的对账步看到「有意图、没锁」就去 git 里核实收口。
   */
  async recordMergeIntent(taskId, intent, actor = { role: 'system', id: 'merge' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.mergeIntent = { ...intent, key: 'merge:' + taskId + ':' + (intent.headSha || '-'), at: nowIso() }
      emit(s, 'merge.intent', { taskId, key: task.mergeIntent.key, branch: intent.branch, base: intent.base, baseBefore: intent.baseBefore || null }, actor)
      return task.mergeIntent
    })
  }

  async clearMergeIntent(taskId, reason = '', actor = { role: 'system', id: 'merge' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task || !task.mergeIntent) return null
      const was = task.mergeIntent
      task.mergeIntent = null
      emit(s, 'merge.intent_cleared', { taskId, key: was.key, reason: clampText(reason, 300) }, actor)
      return was
    })
  }

  /** v1.35：合并锁被占时排队（merge_queue 的最小形态：按 queuedAt 先来先合）。 */
  async markMergeQueued(taskId, actor = { role: 'system', id: 'merge' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task || !task.mergeRequest) return null
      if (!task.mergeRequest.queuedAt) {
        task.mergeRequest = { ...task.mergeRequest, queuedAt: nowIso() }
        emit(s, 'merge.queued', { taskId }, actor)
      }
      return task.mergeRequest.queuedAt
    })
  }

  async markRebased(taskId, { headSha = null, files = [] } = {}, actor = { role: 'worker' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const pr = Object.values(s.pull_requests).filter((p) => p.taskId === taskId).pop()
      must(pr, '没有 PR 记录')
      pr.status = 'open'
      pr.headSha = headSha || pr.headSha
      pr.conflictFiles = []
      pr.updatedAt = nowIso()
      task.mergeRequest = { ...(task.mergeRequest || {}), status: 'open', headSha: pr.headSha, conflictFiles: [] }
      task.updatedAt = nowIso()
      emit(s, 'pr.rebased', { taskId, prId: pr.id, headSha: pr.headSha, files: files.slice(0, 50), attempts: pr.attempts }, actor)
      return pr
    })
  }

  // -- v0.3：注入（TX-21） ---------------------------------------------------

  async inject(taskId, { kind = 'context', content = '', agentId = null, skillName = null } = {}, actor = { role: 'dispatcher' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const project = s.projects[task.projectId]
      const limit = skillName ? (Number(project && project.config.namedSkillMaxBytes) || 256 * 1024) : (Number(project && project.config.injectionMaxBytes) || 4096)
      const text = String(content || '')
      must(text.trim(), '注入内容不能为空')
      must(['skill', 'context', 'steer'].includes(kind), 'kind 只能是 skill / context / steer')
      const size = Buffer.byteLength(text, 'utf8')
      must(size <= limit, '注入内容 ' + size + ' 字节，超过 ' + limit + ' 字节上限（设计文档 14.8）')
      s.seq.injection += 1
      const rec = {
        id: 'inj_' + String(s.seq.injection).padStart(3, '0'),
        taskId, projectId: task.projectId, agentId: agentId || task.assignee || null,
        kind, skillName, content: text, size, at: nowIso(), by: actor.id || actor.role,
      }
      s.injections.push(rec)
      if (s.injections.length > 2000) s.injections.splice(0, s.injections.length - 2000)
      emit(s, 'injection.sent', { taskId, agentId: rec.agentId, kind, size }, actor)
      return rec
    })
  }

  /** 任务当前有效的注入（初始案卷用）：按 kind 取最近 N 条。 */
  injectionsFor(taskId, { kind = null, limit = 20 } = {}) {
    return this.store.state.injections
      .filter((i) => i.taskId === taskId && (!kind || i.kind === kind))
      .slice(-limit)
  }

  // -- v1.31：调度员请示箱 ---------------------------------------------------

  /**
   * 调度遇到需要人拍板的事，写一条结构化请示到人的收件箱。
   *
   * 为什么不用评论：评论是"讨论区"，一张卡几十条评论里混着进度、证据、闲聊，
   * 真正需要人做决定的那条会被埋掉。请示是**待办**，有状态、有回复、能归档。
   *
   * 四段结构是硬要求（缺了就不让人发出去）—— 只写"我遇到问题了"，人还得反问三轮。
   */

  /** 人在请示上回复（可多轮）。回复后状态从 open → answered，等调度判定。 */

  /**
   * 调度判定阻塞已消除 → 归档。
   *
   * **归档权在调度**，不在人：是调度读过回复/看过 issue 补充信息之后判断
   * "我可以继续了"，才关掉这条请示。人在看板上也能手动归档，那是兜底。
   */

  /** 列请示。默认只看未归档的（archived 的留作审计，不上看板）。 */

  /** 某张卡有没有还挂着的请示（调度推进前应该先看这个）。 */

  /** 自动推进的防抖标记：同一张卡同一列在窗口内不重复推。 */
  async markAdvance(taskId, key, actor = { role: 'system', id: 'system:advance' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.advanceAt = nowIso()
      task.advanceKey = key
      task.updatedAt = nowIso()
      return task
    })
  }

  /** 推进被守卫拒绝时记下来，避免同一动作每拍重试（要人等/调度清）。 */
  async markAdvanceBlocked(taskId, reason) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.advanceBlocked = { reason: clampText(String(reason || ''), 500), at: nowIso() }
      task.updatedAt = nowIso()
      return task
    })
  }

  /** 清掉阻塞标记（人/调度处理完了）。 */
  async clearAdvanceBlocked(taskId) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.advanceBlocked = null
      task.advanceAt = null
      task.advanceKey = null
      task.updatedAt = nowIso()
      return task
    })
  }

  // -- v0.3：事件管道与远程镜像（TX-18 / TX-19） -----------------------------

  /** 记一条领域事件（没有副作用，只进 events + outbox）。 */
  async emit(type, payload = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => emit(s, type, payload, actor))
  }

  /** 把镜像条目绑到本地卡片（远程 issue 变成任务时用）。 */

  /**
   * TX-19：远程拉取事务——镜像、事件、游标在同一个事务里（设计文档 14.5 SYNC）。
   * items: [{ remoteId, remoteRev, kind, title, body, state }]
   */

  // -- v1.22：项目级双向同步 ---------------------------------------------------

  /**
   * 同步状态（UI 与 scheduler 都读它）。
   */

  /**
   * 一次 tick 的全部同步结果，落成**一个事务**。
   *
   * 为什么必须合批：state 已经 15MB，Store.tx 每次要 `JSON.parse(JSON.stringify(state))`
   * 做快照、再全量 stringify 落盘。一张卡一个事务 = 一次同步跑几十遍全量序列化。
   *
   * results 形状（scheduler / sync-engine 负责攒）：
   * {
   *   sinceIfNull, cursors: {issueCursor?, commentCursor?},
   *   inbound: { issues: [], comments: [] },
   *   outbound: { tasks: [{taskId, issueNumber, url, labels}], comments: [{commentId, remoteCommentId, url, login}] },
   *   pendingAdd: [{kind, id, nonce, at}], pendingDone: [nonce...],
   *   lastError, circuitUntil,
   * }
   */

  /** 记一条远程来源的评论（出站/回读共用）。 */

  /** 记方案风险评估结果（自动批准分层的第一段产物）。 */
  /**
   * v1.33：修复「状态说合并了，但其实没合并」的卡。
   *
   * 为什么需要它：v1.32 之前 review_approve 只检查审核结论，
   * 于是 T-036/T-042/T-044 被标成 done/merged，而 merge request 还是 open、
   * mergedCommit 是空 —— master 里没有它们的代码。
   *
   * 为什么不能直接改 flow.json：Store 是进程内单写者，下一次写事务会把内存态原子写回，
   * 外部手改会被静默覆盖（文档 §9.4.2 记过这个坑）。所以必须走 action。
   *
   * 为什么不能 reopen：reopen 会清空 plan/approval 快照回到 todo，工人得重做一遍。
   * 这里的语义是**只把状态退回到该待的位置**，工作成果（提交、PR）原样保留。
   *
   * 安全闸门：只在「phase=merged 但没有 mergedCommit」时允许，
   * 否则会变成随意篡改状态的入口。
   */
  /**
   * v1.33：让「已合并」这个状态与 git 事实对齐。
   *
   * 来历：v1.32 之前 review_approve 只检查审核结论，
   * 于是 T-036/T-042/T-044 被标成 done/merged 而 merge request 还是 open、
   * mergedCommit 是空 —— master 里没有它们的代码。
   *
   * 修的时候发现事实分两种，处理方式必须不同：
   *
   *   **① 分支还有未合提交** → 代码真的没进 master。
   *      退回 merging，让它走正常合并流程（flow_pr_merge）。
   *
   *   **② 分支已 0 未合** → 代码其实已经在 master 里了，
   *      只是当时绕过了 markMerged，bookkeeping 没记上。
   *      这时候**不能**退回 merging —— 那会把它再合一遍，产生重复提交。
   *      正确做法是把真实的合并提交补记上去。
   *
   * 为什么必须走 action 不能改文件：Store 是进程内单写者，
   * 外部手改 flow.json 会被下一次写事务静默覆盖（文档 §9.4.2）。
   */
  async repairUnmerged(taskId, { reason = '', mergedCommit = null } = {}, actor = { role: 'human', id: 'web' }) {
    must(this.store.state.tasks[taskId], 'unknown task: ' + taskId)
    must(notEmpty(reason), '修复必须说明原因（会进审计）')

    // 先问 git：这条分支相对 base 还剩多少没合？
    const task0 = this.store.state.tasks[taskId]
    const wt = this.store.state.worktrees && this.store.state.worktrees[taskId]
    const project = this.store.state.projects[task0.projectId]
    let unmerged = null
    let branchHead = null
    try {
      const git = await import('./git.js')
      const dir = project && project.workspacePath
      const branch = (wt && wt.branch) || (task0.mergeRequest && task0.mergeRequest.branch) || null
      if (dir && branch && await git.isRepo(dir)) {
        const base = (project.config && project.config.baseBranch) || (await git.defaultBranch(dir))
        unmerged = await git.countUnmerged(dir, base, branch).catch(() => null)
        branchHead = await git.revParse(dir, branch).catch(() => null)
      }
    } catch { /* 拿不到 git 就按「不知道」处理，走保守分支 */ }

    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      const mr = task.mergeRequest || {}
      const already = mr.mergedCommit || mr.mergeCommit
      must(task.phase === 'merged' && !already,
        '只修复「phase=merged 但没有合并提交」的卡；当前 phase=' + task.phase
          + (already ? '，且已有 mergedCommit' : ''))

      const before = { column: task.column, phase: task.phase, mrStatus: mr.status || null }

      // ② 代码已在 master（0 未合）：补记合并提交，保持 done/merged
      if (unmerged === 0) {
        const commit = mergedCommit || branchHead || null
        must(notEmpty(commit),
          '分支已全部合入但拿不到提交号：请显式传 mergedCommit（用 git log 查这条分支最上面的提交）')
        task.mergeRequest = { ...mr, status: 'merged', mergedCommit: commit, mergeCommit: commit }
        // PR 记录也一并对齐
        for (const pr of Object.values(s.pull_requests || {})) {
          if (pr && pr.taskId === taskId && !pr.mergedCommit) {
            pr.status = 'merged'; pr.mergedCommit = commit; pr.mergeCommit = commit; pr.updatedAt = nowIso()
          }
        }
        task.updatedAt = nowIso()
        task.version = (task.version || 0) + 1
        emit(s, 'task.repaired', {
          taskId, reason: clampText(reason, 500), mode: 'backfill-merged-commit',
          before, after: { column: task.column, phase: task.phase, mergedCommit: commit },
        }, actor)
        return task
      }

      // ① 还有未合提交（或拿不到 git）：退回 merging，走正常合并流程
      task.column = 'merging'
      task.phase = 'merge-ready'
      if (task.mergeRequest) {
        task.mergeRequest = { ...mr, status: mr.status === 'merged' ? 'ready_for_review' : (mr.status || 'ready_for_review') }
      }
      task.columnAt = nowIso()
      task.updatedAt = nowIso()
      task.version = (task.version || 0) + 1
      emit(s, 'task.repaired', {
        taskId, reason: clampText(reason, 500), mode: 'back-to-merging', unmerged,
        before, after: { column: task.column, phase: task.phase },
      }, actor)
      return task
    })
  }
  /** v1.39：需求评审状态落库（轮数 / 结论 / 待人决定项）。 */
  /**
   * v0.006：没有 run 的会话（需求评审工位、调度员自己）报错/被打断时留下事实。
   *
   * 为什么需要：runs 表只记「派过工的轮次」。griller 会话是 promptSession 驱动的，从不进 runs，
   * 于是它的 turn/end(error) 在 onSessionEvent 里被判 `no-active-run` 丢掉 —— 调度全程不知情，
   * 卡挂在 grill.status='running' 上，而 grillStart 又会因为「评审正在进行中」拒绝下一轮。
   * 这里只存事实（谁、什么错、什么时候），要不要通知调度由 dispatch 决定 —— 领域层不该决定打扰谁。
   */
  async recordSessionError(entry, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const m = (s.maintenance = s.maintenance || {})
      const list = Array.isArray(m.lastSessionErrors) ? m.lastSessionErrors : (m.lastSessionErrors = [])
      const rec = {
        id: newId('serr'),
        sessionId: (entry && entry.sessionId) || null,
        agentId: (entry && entry.agentId) || null,
        role: (entry && entry.role) || null,
        taskId: (entry && entry.taskId) || null,
        kind: (entry && entry.kind) || 'infra',
        reason: String((entry && entry.reason) || '').slice(0, 500),
        at: nowIso(),
      }
      list.push(rec)
      // 只留最近 20 条：这是排障线索，不是审计流水；无限长会让 flow.json 慢慢变胖。
      if (list.length > 20) list.splice(0, list.length - 20)
      emit(s, 'session.error', { sessionId: rec.sessionId, agentId: rec.agentId, role: rec.role, taskId: rec.taskId, kind: rec.kind }, actor)
      return rec
    })
  }

  /** 最近若干条「无 run 会话出错」记录（新的在前）。 */
  sessionErrors(limit = 20) {
    const list = (this.store.state.maintenance && this.store.state.maintenance.lastSessionErrors) || []
    return list.slice(-Math.max(1, Number(limit) || 20)).reverse()
  }
  async setGrill(taskId, patch, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      task.grill = Object.assign({ status: 'idle', rounds: 0, maxRounds: 4, verdict: null, openForHuman: [], startedAt: null }, task.grill || {}, patch || {})
      task.updatedAt = nowIso()
      task.version = (task.version || 0) + 1
      emit(s, 'task.grill', { taskId, status: task.grill.status, verdict: task.grill.verdict }, actor)
      return task.grill
    })
  }

  async setTaskRisk(taskId, risk, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.risk = risk || null
      task.updatedAt = nowIso()
      emit(s, 'task.risk', { taskId, level: (risk && risk.level) || null, reasons: (risk && risk.reasons) || [] }, actor)
      return task.risk
    })
  }

  /**
   * v1.26：现算一张卡的方案风险并落库，返回 risk。
   *
   * 为什么代批前要现算而不是信 task.risk：那个字段可能是上一次 plan revision 留下的，
   * 方案改了、风险变了却不重算，等于拿旧结论给新方案盖章。
   */
  async assessPlanRiskOf(taskId, actor = { role: 'system', id: 'risk' }) {
    const task = this.store.state.tasks[taskId]
    must(task, 'unknown task: ' + taskId)
    const project = this.store.state.projects[task.projectId]
    const risk = assessPlanRisk((task.plan && task.plan.text) || '', task, project)
    await this.setTaskRisk(taskId, risk, actor)
    return risk
  }

  /**
   * v1.28：从 worktree 读当前 HEAD，供 accept 自动绑定。
   *
   * 失败一律返回 null（没有 worktree / 不是 git / 没有提交），
   * 让验收继续 —— 卡不能因为"读不到提交号"就永远验收不了。
   */
  /**
   * v1.32：worktree 里有没有未提交改动？
   *
   * 验收必须看这个 —— HEAD 不包含未提交的改动，
   * 「HEAD 有提交」和「活干完了」是两件事。
   *
   * 返回文件清单（形如 ` M path`）；没有 worktree / 不是 git 就返回空数组
   * （无从判断不等于有问题，不该拿它拦住非 Git 项目的验收）。
   */
  async worktreeDirtyFiles(task) {
    const wt = task && task.worktree
    if (!wt || !wt.path) return []
    const git = await import('./git.js')
    if (!(await git.isRepo(wt.path).catch(() => false))) return []
    return await git.dirtyFiles(wt.path).catch(() => [])
  }

  async resolveWorktreeHeadSha(task) {
    const wt = task && task.worktree
    if (!wt || !wt.path) return null
    const git = await import('./git.js')
    if (!(await git.isRepo(wt.path).catch(() => false))) return null
    return (await git.headSha(wt.path).catch(() => null)) || null
  }
  /**
   * v1.28：验收后有没有人又动过 worktree？
   *
   * 线上 T-035：06:10 验收、headSha 记成 audit-T035-verified，之后 worker 又在
   * flow/T-035 里补了 buildSinglePayload 和单集 payload 回归，8 个文件没提交，
   * 也没有新的 stop/验收记录 —— 卡是 done，可交付物跟验收时不是同一个东西了。
   *
   * 这里只回答事实，不做迁移：调用方（巡检/合并前检查/看板）拿它决定要不要提示人。
   * 用动态 import 是为了让 domain 继续保持"不直接碰文件系统"的分层，
   * 只有真被调用时才去装载 git 适配层。
   */
  async detectPostAcceptDrift(taskId) {
    const task = this.store.state.tasks[taskId]
    if (!task) return null
    const wt = task.worktree
    if (!wt || !wt.path) return { taskId, drifted: false, reason: 'no-worktree' }
    const git = await import('./git.js')
    const exists = await git.isRepo(wt.path).catch(() => false)
    if (!exists) return { taskId, drifted: false, reason: 'worktree-missing', path: wt.path }
    const head = await git.headSha(wt.path).catch(() => null)
    // 注意用 dirtyFiles 而不是 changedFiles：后者比的是两个提交之间的差异，
    // 传错参数会静默返回空数组（第一版就踩了这个坑，8 个未提交文件报成 0）。
    const dirty = await git.dirtyFiles(wt.path).catch(() => [])
    // 验收时绑定的 headSha 与当前 HEAD 不一致 → 验收后又有提交。
    // 历史上有伪造值（audit-T035-verified 这种），那种不算"前进"，单独标出来。
    const acceptedLooksLikeSha = /^[0-9a-f]{3,40}$/i.test(String(task.headSha || ''))
    const headDrift = !!(acceptedLooksLikeSha && head && String(task.headSha) !== String(head))
    const bogusAcceptedSha = !!(task.headSha && !acceptedLooksLikeSha)
    // 有未提交改动 → 交付物不在那份验收记录里
    const uncommitted = Array.isArray(dirty) ? dirty : []
    const drifted = headDrift || uncommitted.length > 0
    return {
      taskId,
      drifted,
      path: wt.path,
      branch: wt.branch || null,
      acceptedHeadSha: task.headSha || null,
      bogusAcceptedSha,
      currentHeadSha: head,
      headDrift,
      uncommitted,
      uncommittedCount: uncommitted.length,
      hint: drifted
        ? '这张卡验收之后 worktree 又变了：' + (headDrift ? 'HEAD 已从 ' + String(task.headSha).slice(0, 8) + ' 前进；' : '') +
          (uncommitted.length ? '有 ' + uncommitted.length + ' 个未提交文件；' : '') +
          '要纳入交付请重新开卡或走一次新的验收收口。'
        : (bogusAcceptedSha
          ? '验收记录里的 head_sha（' + String(task.headSha).slice(0, 24) + '）不是提交号，无法判断是否漂移；这是 v1.28 之前伪造闸门留下的脏数据。'
          : ''),
    }
  }

  /** 按列/车道/优先级重算受管标签，返回差异化结果（出站用）。 */
  labelPlanFor(taskId) {
    const task = this.store.state.tasks[taskId]
    if (!task) return null
    const remoteLabels = (task.remote && Array.isArray(task.remote.labels) && task.remote.labels) || []
    const want = desiredLabels(task)
    return { desired: want, ...diffLabels(remoteLabels, want) }
  }

  /**
   * 远程标签回读：`prio/*` 双向生效（纯元数据），`flow/*` 只记不一致不驱动状态机。
   *
   * 为什么不驱动：本地列由事务驱动，不能有两个写者。人在 GitHub 上改标签是「表达意见」，
   * 不是「让看板跳列」；真要跳列得在看板上点。
   */

  /** 扫同步候选项目：按 lastSyncAt 轮转，保证多项目时公平。 */

  /**
   * 开/关同步时定分界时刻：`since` 只写一次，之后配置改动不重置。
   * 这是「配置之后出现的卡与评论才同步」的落点。
   */

  /** 熔断：401 需要人换 token（30 分钟），403/429 只是被限流（5 分钟）。 */

  // -- v1.23：入站身份对账（修 v1.22 回声级联留下的脏数据）---------------------

  /**
   * 把「从远程来的卡」的远程身份修正回它的**来源 issue**。
   *
   * v1.22 的级联留了两类脏数据：
   *   ① 入站建卡时没写 task.remote → 出站把它当本地卡，又推出一条新 issue。
   *      于是卡上记的 remote.issueNumber 是那条**重复 issue**，不是它的来源。
   *   ② 同一 issue 的多个 revision 各建了一张卡（originRef 带 rev），
   *      其中最早的才是真身，其余是重复卡。
   *
   * 这个方法只做 ①：把 remote.issueNumber 改回 originRef 里的 id，
   * 把被误推的编号记进 remote.echoedAt/remote.echoIssueNumber 供人追溯。
   * ②（重复卡本身）删卡是人的决定，这里不动——只给出标记 isDuplicateOrigin。
   *
   * 返回 { fixed, marked } 供启动日志用。
   */

  // -- v1.22 P5：run 恢复、僵尸清理、两套重试预算 ---------------------------

  /**
   * 僵尸 run 清理（v1.22 P5）。
   *
   * 判据不是心跳，而是「这张卡的 activeRunId 已经不是它了」——
   * 说明任务被重派/取消/恢复过，这条 run 只是**行没收拾干净**。
   * 心跳型卡死仍归 stuckRuns()/reapStuck 管，两者不要混：一个是"活着但不报进度"，
   * 一个是"已经死了但行还写着 running"。
   */
  zombieRuns() {
    const s = this.store.state
    const out = []
    for (const run of Object.values(s.runs)) {
      if (run.status !== 'running') continue
      const task = s.tasks[run.taskId]
      if (!task) { out.push({ run, reason: 'task-gone' }); continue }
      if (task.activeRunId !== run.id) out.push({ run, reason: 'not-active' })
    }
    return out
  }

  /** 把一条僵尸 run 标成 interrupted（不改任务状态，任务侧已由后续派工接管）。 */
  async markRunInterrupted(runId, reason = '', actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const run = s.runs[runId]
      must(run, 'unknown run: ' + runId)
      if (run.status !== 'running') return run
      run.status = 'interrupted'
      run.endedAt = nowIso()
      run.stopReason = reason ? clampText(reason, 2000) : null
      emit(s, 'run.interrupted', { runId, taskId: run.taskId, reason }, actor)
      return run
    })
  }

  /**
   * 启动对账（v1.22 P5，对应 ework recover() 的第 ①②③ 步）。
   *
   * 进程重启后，内存里的心跳定时器全没了，但 JSON 里那些 run 还写着 running。
   * 这里的处理顺序刻意照抄 ework 的教训：**先把它们认作中断，再让调度重派**，
   * 绝不假装它们还在跑（否则任务永远卡在 running，等 30 分钟才被 reapStuck 捡走）。
   *
   * `shiftPendingSince`：停机时间不计入重试退避 —— 否则一觉醒来所有退避都过期，
   * 会同时冲出去把偶发故障变成雪崩。
   */
  async recoverRuns(now = Date.now(), actor = { role: 'system', id: 'recover' }) {
    return this.store.tx((s) => {
      const stopped = []
      const cleared = []
      const merges = []
      // 停机时长 = 现在 - 最后一条心跳的时刻。state 里没有"上次落盘时间"这种字段，
      // 而 lastHeartbeat 每次心跳都会刷新，是这份数据里唯一可信的"进程还活着的最后证据"。
      let lastAlive = 0
      for (const run of Object.values(s.runs)) {
        if (run.status !== 'running') continue
        const beat = Date.parse(run.lastHeartbeat || run.startedAt || 0)
        if (Number.isFinite(beat) && beat > lastAlive) lastAlive = beat
      }
      const shiftMs = lastAlive ? Math.max(0, Number(now) - lastAlive) : 0
      for (const run of Object.values(s.runs)) {
        if (run.status !== 'running') continue
        run.status = 'interrupted'
        run.endedAt = nowIso()
        run.stopReason = run.stopReason || '进程重启，run 中断（等待重新派工）'
        stopped.push(run.id)
        const task = s.tasks[run.taskId]
        if (task && task.activeRunId === run.id) {
          task.activeRunId = null
          cleared.push(task.id)
        }
      }
      // 停机时间不计入退避：把到点时间整体往后推
      for (const task of Object.values(s.tasks)) {
        if (!task.retryAfter) continue
        const at = Date.parse(task.retryAfter)
        if (Number.isFinite(at)) task.retryAfter = new Date(at + shiftMs).toISOString()
      }
      for (const key of Object.keys(s.leases || {})) {
        const lease = s.leases[key]
        if (!lease) continue
        // run 已经不可能还活着，租约一并释放，免得任务被幽灵持有者锁住。
        // v1.35：租约上记的是 owner（acquireLease），原来判 lease.agentId 永远为空，这段从没生效过。
        if (String(lease.owner || lease.agentId || '') && String(key).startsWith('task:')) {
          const taskId = String(key).slice('task:'.length)
          const task = s.tasks[taskId]
          if (task && !task.activeRunId) { delete s.leases[key]; releaseLease(s, key, lease.token) }
        }
        // v0.002（ADR-0004 §7）：合并锁也要清。它是项目级的（merge:<projectId>），
        // 不清的话进程重启之后这个仓库**10 分钟内谁都合不了**，而持有者根本不存在。
        if (String(key).startsWith('merge:')) { delete s.leases[key]; releaseLease(s, key, lease.token); merges.push(String(key)) }
      }
      // v1.35：执行到一半被进程重启打断的副作用，立刻进重试（不等 10 分钟超时）。
      const effects = []
      for (const e of Object.values(s.effects || {})) {
        if (e && e.status === 'running') { e.status = 'failed'; e.lastError = '进程重启，副作用执行中断'; e.nextAt = nowIso(); effects.push(e.id) }
      }
      if (stopped.length || cleared.length || effects.length) {
        emit(s, 'flow.recovered', { runs: stopped, tasks: cleared, effects, shiftMs }, actor)
      }
      return { runs: stopped, tasks: cleared, merges, effects, shiftMs }
    })
  }

  /**
   * 记一次失败并决定「重试还是放弃」（v1.22 P5，对应 ework 的两套独立预算）。
   *
   * 为什么必须两套：基础设施故障（会话不可用、进程被杀、配额打满）是**环境**的错，
   * 重试大概率能过，给 3 次；内容/逻辑失败是**这张卡**的错，重试只会重复烧钱，给 1 次。
   * 把两者混成一个计数器，会得到「环境抖动把任务内容预算吃光」这种最难查的现场。
   *
   * infra 退避 15s / 30s / 60s（对应 infraAttempts 1/2/3），写进 task.retryAfter
   * 由 tick 到点重派；内容失败不写 retryAfter，直接交给调用方 block。
   */
  async recordFailure(taskId, { kind = 'content', reason = '', status = null, signature = null } = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const run = task.activeRunId ? s.runs[task.activeRunId] : (Object.values(s.runs).filter((r) => r.taskId === taskId).pop() || null)
      const isInfra = kind === 'infra'
      const infraMax = 3
      const contentMax = 2
      // 计数同时记在 run 和 task 上：run 是"这一轮"的账，task 是"这张卡一辈子"的账。
      // 派工阶段就失败时压根没有 run（或 run 已经收掉了），只靠 run 计会永远停在 1 次 —— 无退避、无上限。
      if (run) {
        if (isInfra) run.infraAttempts = (Number(run.infraAttempts) || 0) + 1
        else run.attempts = (Number(run.attempts) || 0) + 1
      }
      if (isInfra) task.infraAttempts = (Number(task.infraAttempts) || 0) + 1
      else task.attempts = (Number(task.attempts) || 0) + 1
      const tries = isInfra
        ? Math.max(Number(task.infraAttempts) || 0, run ? Number(run.infraAttempts) || 0 : 0)
        : Math.max(Number(task.attempts) || 0, run ? Number(run.attempts) || 0 : 0)
      const max = isInfra ? infraMax : contentMax
      const retry = tries < max
      const backoffMs = isInfra ? 15000 * Math.pow(2, Math.max(0, tries - 1)) : 0
      task.retryAfter = retry ? new Date(Number(Date.now()) + backoffMs).toISOString() : null
      // v1.36：排队从什么时候开始等 —— 排队过期（默认 128h）用它算，不用 createdAt
      task.retrySince = retry ? (task.retrySince || nowIso()) : null
      task.retryBudget = { kind, tries, max, at: nowIso(), reason: reason ? clampText(reason, 500) : null, status, signature: signature || null }
      // v0.016（ticket 07）：分类与信号原文落在**这一轮**上（run 是这一轮的账）。
      if (run) run.failure = { kind, signature: signature || null, reason: reason ? clampText(reason, 500) : null, at: nowIso() }
      task.updatedAt = nowIso()
      emit(s, 'task.failed', { taskId, kind, tries, max, retry, backoffMs, reason, status }, actor)
      return { retry, tries, max, backoffMs, retryAfter: task.retryAfter }
    })
  }

  /**
   * 清零失败预算（v1.22 P5）。
   *
   * 预算的语义是"连续失败"而不是"一辈子失败"：工人这一轮真的干完了（自停/合并），
   * 说明环境和内容都恢复了，之前的计数就该归零 —— 否则一张老卡被几次历史故障
   * 耗尽预算，以后每次抖动都直接 block，看起来像是坏掉了。
   */
  async resetFailureBudget(taskId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task) return null
      const had = Number(task.infraAttempts) || Number(task.attempts) || 0
      task.infraAttempts = 0
      task.attempts = 0
      task.retryAfter = null
      task.retryBudget = null
      if (had) emit(s, 'task.budget.reset', { taskId, had }, actor)
      return { taskId, had }
    })
  }

  /**
   * 远程唤醒去重表（v1.22 P6）。
   *
   * 唤醒（PR 冲突 / 等评审 / CI 红）每 60s 一轮都会重新看到同一个事实，
   * 不记时间就会变成每分钟一条评论、每分钟一次通知 —— 那是刷屏而不是唤醒。
   * 表按项目存：`wake['pr_unmergeable:T-012'] = '2026-11-01T...'`。
   */
  wakeAt(projectId, key) {
    const sync = (this.store.state.remote_sync || {})[projectId] || {}
    const wake = sync.wake || {}
    return wake[key] || null
  }

  /** 到了重试时间的任务（tick 用）。 */
  retryDue(now = Date.now()) {
    const out = []
    const s = this.store.state
    for (const task of Object.values(s.tasks)) {
      if (!task.retryAfter) continue
      const at = Date.parse(task.retryAfter)
      if (!Number.isFinite(at) || at > now) continue
      if (task.activeRunId) continue
      // v1.36：排队过期（对照 ework 的 128h）。一张卡反复失败、反复退避，
      // 一直重试下去只会无限烧钱；超过上限就停下来问人。用非枚举字段带出原因，调用方据此分流。
      const project = s.projects[task.projectId]
      const maxAge = Number(project && project.config.maxQueueAgeMs) || 128 * 3600 * 1000
      const since = Date.parse(task.retrySince || task.updatedAt || 0) || 0
      if (since && now - since > maxAge) {
        out.push({ ...task, expired: true, waitedMs: now - since, maxAge })
        continue
      }
      out.push(task)
    }
    return out
  }

  /**
   * v1.36：卡死计数（毒会话判定用）。连续 N 次卡死 → 判定为毒会话。
   * 是否真的重建由项目配置决定（poisonRebuild / poisonStuckThreshold）：
   * 关闭时只返回 poisoned=true 让调用方提醒，计数照常累积，不清零。
   */
  async bumpStuck(taskId, reason = '', actor = { role: 'system', id: 'scheduler' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task) return { count: 0, reset: false, poisoned: false }
      const cfg = withDefaults((s.projects[task.projectId] && s.projects[task.projectId].config) || {})
      const threshold = Math.max(1, Math.floor(Number(cfg.poisonStuckThreshold)) || 3)
      task.stuckCount = (Number(task.stuckCount) || 0) + 1
      task.stuckReason = clampText(reason, 300)
      task.updatedAt = nowIso()
      const count = task.stuckCount
      const poisoned = count >= threshold
      const reset = poisoned && cfg.poisonRebuild === true
      if (reset) { task.stuckCount = 0; task.stuckResetAt = nowIso() }
      emit(s, 'task.stuck', { taskId, count, threshold, poisoned, reset, reason: task.stuckReason }, actor)
      return { count, threshold, poisoned, reset }
    })
  }

  /**
   * 调度员重置工人会话前的保护判定（只读）。
   *
   * 重建会话 = 丢上下文 + 前缀缓存失效。T-046 上调度员 13 分钟内重置了两次，
   * 第二次距离工人提交增量报告不到 1 分钟。所以 guarded 策略下：
   * 工人有在跑的 run，且最近 workerResetQuietMs 内有过活动（run 开始 / 工人评论），就拒绝。
   * 人在看板上点重置不走这里（那是人的决定）。
   */
  resetGuard(agentId, now = Date.now()) {
    const s = this.store.state
    const agent = s.agents[agentId]
    if (!agent) return { allowed: false, reason: 'unknown agent: ' + agentId }
    const cfg = withDefaults((s.projects[agent.projectId] && s.projects[agent.projectId].config) || {})
    const policy = ['allow', 'guarded', 'deny'].includes(cfg.workerResetPolicy) ? cfg.workerResetPolicy : 'guarded'
    if (policy === 'allow') return { allowed: true, policy }
    if (policy === 'deny') {
      return { allowed: false, policy, reason: '项目配置 workerResetPolicy=deny：调度员不能重置工人会话。确需重置请 flow_ask_human，由人在看板上操作。' }
    }
    const quietMs = Math.max(0, Number(cfg.workerResetQuietMs) || 0)
    // v1.37.1 修：原来只看 activeRunId 的任务 —— 而调度学会了"先 interrupt_agent 把 run 停掉，
    // 再 flow_worker_reset"，此时 activeRunId 已被清空，guard 找不到任务就直接放行。
    // 现在改成看这个工人名下所有未终结任务的"最近活动"（run 开始 / 结构化进度 / 工人评论），
    // 无论 run 是否还在跑。
    const tasks = Object.values(s.tasks).filter((t) => t && t.assignee === agentId && !['done', 'cancelled'].includes(t.column))
    for (const task of tasks) {
      const run = task.activeRunId ? s.runs[task.activeRunId] : null
      let last = 0
      let lastWhat = ''
      // 该卡最近一次 run（含已结束的）的开始时间也算活动
      for (const r of Object.values(s.runs)) {
        if (!r || r.taskId !== task.id) continue
        const at = Date.parse(r.startedAt) || 0
        if (at > last) { last = at; lastWhat = 'run ' + r.id + (r.status === 'running' ? ' 开始' : ' 刚结束') }
        const endAt = Date.parse(r.endedAt || 0) || 0
        if (endAt > last) { last = endAt; lastWhat = 'run ' + r.id + ' 刚刚结束（' + (r.status || '') + '）' }
      }
      // 结构化进度比评论更能说明"它刚动过"
      const pgAt = Date.parse((task.progress && task.progress.updatedAt) || 0) || 0
      if (pgAt > last) { last = pgAt; lastWhat = '结构化进度更新' }
      for (const c of s.task_comments || []) {
        if (c.taskId !== task.id || c.author !== agentId) continue
        const at = Date.parse(c.at) || 0
        if (at > last) { last = at; lastWhat = '工人评论' }
      }
      if (!last) continue
      const idle = now - last
      if (idle < quietMs) {
        return {
          allowed: false,
          policy,
          taskId: task.id,
          runId: run ? run.id : null,
          lastActivityAt: new Date(last).toISOString(),
          reason: '工人 ' + agentId + ' 在 ' + task.id + ' 上' + (run ? '有 run ' + run.id : '（run 已结束）') + '，' + Math.round(idle / 1000) + ' 秒前有' + lastWhat +
            '，未满静默期 ' + Math.round(quietMs / 60000) + ' 分钟，拒绝重置（重置会丢上下文和缓存）。先用 flow_worker_steer 催进度；确实失联请等静默期过后再试，或 flow_ask_human。',
        }
      }
    }
    return { allowed: true, policy }
  }

  async resetStuck(taskId, actor = { role: 'system', id: 'dispatch' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task || !task.stuckCount) return null
      task.stuckCount = 0
      task.updatedAt = nowIso()
      return { taskId }
    })
  }

  /** 清掉到期的重试标记（派工前调用，避免同一条被反复捡起）。 */
  async clearRetry(taskId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      task.retryAfter = null
      task.updatedAt = nowIso()
      return task
    })
  }

  /**
   * v1.37 steer 计数：限制调度在没有进度更新的情况下对同一张卡反复催促。
   * 到上限时返回 { allowed: false, count, max, reason }，工具层据此拒绝执行。
   */
  bumpSteer(taskId, agentId) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task || task.assignee !== agentId) return { allowed: true, count: 0, max: 0 }
      const cfg = withDefaults((s.projects[task.projectId] && s.projects[task.projectId].config) || {})
      const max = Math.max(1, Number(cfg.maxSteersWithoutProgress) || 3)
      task.steerCount = (Number(task.steerCount) || 0) + 1
      const count = task.steerCount
      if (count > max) {
        task.steerCount = count
        return { allowed: false, count, max, reason: '已连续催促工人 ' + count + ' 次（上限 ' + max + '，两次进度更新之间），继续催促效果递减。请用 flow_task_move(block) 标阻塞或 flow_ask_human 请示人，不要继续 steer。' }
      }
      return { allowed: true, count, max }
    })
  }

  clearSteer(taskId) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (task) { task.steerCount = 0; task.updatedAt = nowIso() }
    })
  }

  /**
   * v1.37.1：调度"探测预算"。
   *
   * 线上事故：调度被一条 task.progress 唤醒后，在一个 turn 里连查 31 次
   * （curl flow/state、git status、flow_worker_log、steer、sleep 2、interrupt），
   * 跑满 8 分钟不停 —— 它在用轮询代替"等下一个事件"。
   *
   * 这里做成滑动窗口：同一调度在 windowMs 内对只读探测工具的调用超过 max 次就拒绝，
   * 并明确告诉它"没有新事件，结束本轮"。计数只对 dispatcher 生效，工人查自己那张卡不受限。
   */
  probeBudget(agentId, { max = 8, windowMs = 5 * 60 * 1000, now = Date.now() } = {}) {
    const s = this.store.state
    if (!s.probe_budget) s.probe_budget = {}
    const cur = s.probe_budget[agentId]
    if (!cur || now - Number(cur.windowStart || 0) > windowMs) {
      s.probe_budget[agentId] = { windowStart: now, count: 0, kinds: [] }
    }
    const slot = s.probe_budget[agentId]
    slot.count = (Number(slot.count) || 0) + 1
    return { allowed: slot.count <= max, count: slot.count, max, windowMs }
  }

  /**
   * v1.37：写入结构化进度快照。
   * 写入后：① 旧值压入 progressHistory（最多 10 条）；② steerCount 清零；
   * ③ 发出 task.progress 事件供 WATCHED 过滤。
   * 调用方已做长度校验，这里不再截断 —— 拒绝比静默截断更可靠。
   */
  async setProgress(taskId, input, actor = { role: 'worker' }) {
    // 进度更新是**人给的**进展证据：顺手推进 run 的最后进展时间（ticket 08）。
    const ST = ['on-track', 'waiting', 'blocked', 'partial', 'done']
    const state = ST.includes(input.state) ? input.state : 'on-track'
    const summary = clampText(String(input.summary || ''), 120)
    const done = Array.isArray(input.done) ? input.done.slice(0, 5).map((s) => clampText(String(s || ''), 80)) : []
    const next = clampText(String(input.next || ''), 80)
    const blocker = input.blocker != null ? clampText(String(input.blocker), 120) : null
    const evidence = Array.isArray(input.evidence)
      ? input.evidence.slice(0, 5).map((e) => ({ kind: e.kind || 'file', ref: clampText(String(e.ref || ''), 200) }))
      : []
    const saved = await this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task: ' + taskId)
      // push old progress to history before overwriting
      if (task.progress) {
        const history = Array.isArray(task.progressHistory) ? task.progressHistory : []
        task.progressHistory = [...history, task.progress].slice(-10)
      }
      const oldState = task.progress && task.progress.state
      task.progress = { state, summary, done, next, blocker, evidence, updatedAt: nowIso(), by: (actor && actor.id) || 'worker' }
      task.steerCount = 0
      task.updatedAt = nowIso()
      const stateChanged = oldState !== state || (!oldState && state)
      const hasBlocker = state === 'blocked' || !!blocker
      emit(s, 'task.progress', { taskId, state, stateChanged, hasBlocker }, actor)
      return { progress: task.progress, activeRunId: task.activeRunId }
    })
    // 有 run 在跑就把「最后进展时间」往前推（ticket 08）。没有 run 的进度更新不涉及收回。
    if (saved && saved.activeRunId) await this.touchProgress(saved.activeRunId, 'progress').catch(() => null)
    return saved && saved.progress
  }

  /**
   * 超时 run 名单（v1.22 P5：3 小时硬上限）。
   *
   * **DSH 没有 abort API**，所以这里只能"标记 + 通知"，不能强制掐掉会话里的回合。
   * 标记之后任务会被收回重派，旧回合即使还在跑，它的收尾也会被 fencing 拒掉。
   */
  overrunRuns(now = Date.now()) {
    const s = this.store.state
    const out = []
    for (const run of Object.values(s.runs)) {
      if (run.status !== 'running') continue
      const project = s.projects[run.projectId]
      const limit = Number(project && project.config.maxRunMs) || 3 * 60 * 60 * 1000
      const at = Date.parse(run.startedAt || 0)
      if (Number.isFinite(at) && now - at > limit) out.push({ run, overMs: now - at, limit })
    }
    return out
  }

  // -- v0.3：卡死检测与投递审计（TX-22 / TX-23） -----------------------------

  stuckRuns(now = Date.now()) {
    const s = this.store.state
    const out = []
    for (const run of Object.values(s.runs)) {
      if (run.status !== 'running') continue
      const project = s.projects[run.projectId]
      const limit = Number(project && project.config.stuckAfterMs) || 30 * 60 * 1000
      const beat = Date.parse(run.lastHeartbeat || run.startedAt || 0)
      if (Number.isFinite(beat) && now - beat > limit) out.push({ run, overdueMs: now - beat })
    }
    return out
  }

  // -- v1.24 全局控制位：一键停止全部调度 --------------------------------------
  //
  // 语义（用户口径）：按下之后**直接停**——不再派工、不再出 tick、
  // 也不再让调度收到「生成停止 / 模型报错」这类事件。
  // 所以控制位必须挡在**所有**自动推进的入口上（tick / dispatch / watch 注入 /
  // 会话事件回灌），只挡 tick 是不够的：工人还在跑，会话事件照样会灌给调度。

  /** 是否处于全局停止状态（同步读，供各入口在动手前一行早退）。 */
  halted() {
    const c = this.store.state.control
    return !!(c && c.halted)
  }

  /** 控制位快照（界面展示 haltedAt / reason 用）。 */
  controlOf() {
    const c = this.store.state.control
    return {
      halted: !!(c && c.halted),
      haltedAt: (c && c.haltedAt) || null,
      haltedBy: (c && c.haltedBy) || null,
      reason: (c && c.reason) || null,
    }
  }

  /**
   * 停止全部调度：置控制位，并把所有在跑的 run 收成 interrupted。
   *
   * 为什么要在同一个事务里收 run：控制位与 run 状态必须同时生效。分成两次写，
   * 中间那一瞬 tick 可能读到"已停但 run 还在跑"，于是先派工再被停，白烧一次会话。
   * 返回 sessionIds 供上层去取消真实会话——DSH 没有跨进程的 abort，
   * 这里只能把账记干净，再由 index.js 逐个 cancel。
   */
  async haltAll(actor = { role: 'human', id: 'web' }, reason = null) {
    return this.store.tx((s) => {
      if (!s.control || typeof s.control !== 'object') s.control = { halted: false, haltedAt: null, haltedBy: null, reason: null }
      const already = s.control.halted === true
      const runIds = []
      const sessionIds = []
      for (const run of Object.values(s.runs || {})) {
        if (!run || run.status !== 'running') continue
        run.status = 'interrupted'
        run.endedAt = nowIso()
        run.stopReason = '调度被手动停止（一键停止）'
        runIds.push(run.id)
        if (run.sessionId) sessionIds.push(run.sessionId)
        const task = s.tasks[run.taskId]
        if (task && task.activeRunId === run.id) task.activeRunId = null
      }
      s.control.halted = true
      s.control.haltedAt = nowIso()
      s.control.haltedBy = (actor && (actor.id || actor.role)) || 'human'
      s.control.reason = reason ? clampText(reason, 300) : null
      emit(s, 'flow.halted', { runIds, reason: s.control.reason }, actor)
      return { halted: true, already, runIds, sessionIds }
    })
  }

  /** 恢复调度：只清控制位，不动任何卡的状态（下一步由人自己决定推不推）。 */
  async resumeAll(actor = { role: 'human', id: 'web' }) {
    return this.store.tx((s) => {
      if (!s.control || typeof s.control !== 'object') s.control = { halted: false, haltedAt: null, haltedBy: null, reason: null }
      const was = s.control.halted === true
      s.control.halted = false
      s.control.haltedAt = null
      s.control.haltedBy = null
      s.control.reason = null
      emit(s, 'flow.resumed', { was }, actor)
      return { halted: false, was }
    })
  }

  /**
   * 续一次 run 心跳。已结束的 run 不再续（返回 {ok:false,status}），
   * 让调用方的定时器能据此自行停表，而不是对着跑完的 run 一直写盘。
   */
  /**
   * 推进「最后进展时间」（v0.016 / ticket 08）。
   *
   * 只有真进展才调它：进度更新、评论、观察到新提交。**心跳绝不调它** ——
   * 否则「活着但什么都不干」的 run 会永远不被收回，那正是线上 65% 空转的成因。
   */
  /** 记下这一轮已经看到的提交（v0.016 / ticket 08）：只看变化，不看绝对值。 */
  async markRunSeen(runId, sha, kind = 'commit', actor = { role: 'system', id: 'system:idle' }) {
    return this.store.tx((s) => {
      const run = s.runs[runId]
      if (!run) return { ok: false, reason: 'unknown-run' }
      const first = !run.lastSeenSha
      const changed = !first && run.lastSeenSha !== sha
      run.lastSeenSha = String(sha || '')
      // 第一次看到分支头或看到变化都算进展；同一头反复看到不算。
      if (first || changed || !run.lastProgressAt) run.lastProgressAt = nowIso()
      run.lastProgressKind = String(kind || 'commit')
      return { ok: true, changed }
    })
  }

  async touchProgress(runId, reason = 'progress', actor = { role: 'system', id: 'system:progress' }) {
    return this.store.tx((s) => {
      const run = s.runs[runId]
      if (!run) return { ok: false, reason: 'unknown-run' }
      if (run.status !== 'running' || run.endedAt) return { ok: false, reason: 'not-running' }
      run.lastProgressAt = nowIso()
      run.lastProgressKind = String(reason || 'progress').slice(0, 40)
      return { ok: true, runId, lastProgressAt: run.lastProgressAt }
    })
  }

  async heartbeat(runId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const run = s.runs[runId]
      // run 不存在是**正常退出条件**，不是错误：删卡会连带删 runs（removeTask），
      // 而 dispatcher 的心跳定时器还挂在那个 id 上，下一拍就撞进来。早先这里抛 must()，
      // 线上于是每 60 秒刷一行 "heartbeat failed run_0xx: unknown run" —— 纯噪音。
      if (!run) return { ok: false, status: 'missing', runId }
      if (run.status !== 'running') return { ok: false, status: run.status, runId }
      run.lastHeartbeat = nowIso()
      return { ok: true, status: 'running', runId, lastHeartbeat: run.lastHeartbeat }
    })
  }

  /** 投递审计：每次往真实会话投东西都留一条（谁、给谁、什么、成没成）。 */
  /** v1.35：投递幂等键查重（brief:<taskId>:<runId> 这类键投过且成功就不再投）。 */
  hasLogged(dedupeKey) {
    if (!dedupeKey) return false
    return (this.store.state.message_log || []).some((m) => m && m.dedupeKey === dedupeKey && m.ok)
  }

  logMessage(entry) {
    const s = this.store.state
    s.seq.msg += 1
    // 调用方常把可选字段原样传进来（queued: merged.queued），undefined 不能进状态
    const rec = sanitizeLossless({ id: 'msg_' + String(s.seq.msg).padStart(6, '0'), at: nowIso(), ...entry })
    s.message_log.push(rec)
    if (s.message_log.length > 5000) s.message_log.splice(0, s.message_log.length - 5000)
    return rec
  }

  // -- outbox ---------------------------------------------------------------

  async pumpOutbox(limit = 50) {
    const pending = this.store.state.outbox.filter((o) => !o.deliveredAt).slice(0, limit)
    for (const item of pending) {
      item.attempts += 1
      item.deliveredAt = nowIso()
      // actor 必须带出去：订阅方靠它判断"这是不是我自己干的"，缺了就会自激
      this.broadcast({ id: item.eventId, type: item.type, payload: item.payload, actor: item.actor || null, causationId: item.causationId || null, at: item.at })
    }
    if (pending.length) await this.store.persist()
    return pending.length
  }
}

// v1.36：模块混入（放在类定义之后，调用方感觉不到差别）。
Object.assign(FlowDomain.prototype, inboxMethods)
Object.assign(FlowDomain.prototype, syncMirrorMethods)
