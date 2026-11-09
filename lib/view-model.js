/**
 * 看板 / 抽屉的视图模型（ui-02）。
 *
 * 为什么单独成文件：今天「这张卡该说什么」有两份实现 —— `lib/panel.js` 算投影、
 * `client.js` 的 `boardCard` 再算一遍徽标与摘要行，连 mergeState 的读侧表都得在
 * 浏览器里内联一份。三处各写一遍 if，改一处忘两处是常态，而且漂移不报错
 * （界面只是安静地少一个标）。这里把「徽标顺序 / 摘要行 / 折叠默认值」收成一个
 * **纯函数模块**：服务端投影（panel）与客户端（ui-04）都从它取值，就没有第二份 if。
 *
 * 约束（和 lib/merge-state.js 同一理由）：
 *   · 不 import git / IO / 领域层。只 import merge-state.js 的读侧表 —— 那是
 *     merge 原因的唯一字典，抄一份 label 进来就等于又开一个漂移点。
 *   · 不读写任何模块级可变状态；同一输入两次调用必须 deepEqual（纯函数）。
 *   · 不碰传进来的 task（读字段、返回新对象）。
 */

import { MERGE_STATE_LABEL, mergeReasonOf } from './merge-state.js'

/** Chip 认的配色。未知值一律降级到 info，别把客户端没有的 class 塞进 DOM。 */
const TONES = ['ok', 'warn', 'bad', 'info']

/**
 * 卡片徽标的**唯一顺序表**。
 *
 * 顺序就是优先级：冲突时排在前面的那枚先说（撞车时"合不了"比"待验收"更该被看见）。
 * 数组尾部两枚 `only:'detail'` 只进抽屉：车道名和子卡进度属于"打开后才知道"的背景，
 * 挂在卡上会把真正会变的那几枚挤掉（ui-02 票面：前段决定上卡顺序，后两个只进详情）。
 *
 * `label` / `tone` 是静态兜底；实际文案与配色由 badgesFor 按任务状态现算
 * （例如 delivery 有四种落点、merge 的 tone 取自原因表）。`only` 才是这里真正
 * 被程序读的字段 —— chipsFor 靠它决定上不上卡。
 */
export const BADGE_ORDER = [
  { key: 'blocked', label: '阻塞', tone: 'bad', only: 'card' },
  { key: 'merge-blocked', label: '合不了', tone: 'bad', only: 'card' },
  { key: 'risk-high', label: '⚡高风险', tone: 'bad', only: 'card' },
  { key: 'grill-escalate', label: '待人决定', tone: 'warn', only: 'card' },
  { key: 'waiting-branch', label: '等分支', tone: 'info', only: 'card' },
  { key: 'merge-pending', label: '等待合并', tone: 'info', only: 'card' },
  { key: 'delivery', label: '交付', tone: 'info', only: 'card' },
  { key: 'lane', label: 'issue', tone: 'info', only: 'detail' },
  { key: 'child', label: '子任务', tone: 'info', only: 'detail' },
]

/** 上卡的键（BADGE_ORDER 里 only==='card' 的那些），chipsFor 用它过滤。 */
const CARD_KEYS = BADGE_ORDER.filter((b) => b.only === 'card').map((b) => b.key)

/**
 * 阶段短语（摘要行的最后一档）。
 *
 * 和 client.js 的 PHASE_LABEL 同字面量：ui-04 接线后那份内联副本会删掉，
 * 这里就是唯一来源。缺键时 headlineFor 原样吐 phase，不做静默吞掉 ——
 * 一个新的 phase 至少还能让人看见英文名。
 */
const PHASE_LABEL = {
  executing: '执行中',
  investigating: '调研中',
  'waiting-approval': '待批准',
  discussing: '讨论中',
  dispatched: '已交接',
  'waiting-worker': '等工位',
  'waiting-branch': '等分支',
  classifying: '判读中',
  paused: '已暂停',
  'awaiting-acceptance': '待验收',
  'merge-ready': '待开 PR',
  'review-pending': '待审核',
  'risk-escalation': '风险升级',
  'changes-requested': '要求修改',
  merged: '已合并',
  'merged-skipped': '跳过合并',
  'merged-into-parent': '已合入父分支',
  'done-in-parent': '已合入父分支',
  'done-no-merge': '无需合并',
}

/**
 * 列本身已经说清楚了、再写一遍就是噪音的阶段。
 *
 * 「执行中」的卡在「执行中」列里、phase=executing，摘要行再重复一遍等于白占一行；
 * 客户端原来就是这么判的，这里照抄，免得迁移后每张卡都多一行废话。
 */
const PHASE_REDUNDANT = { 'running/executing': true, 'verifying/awaiting-acceptance': true }

/**
 * 折叠抽屉的默认值（ui-03 消费）。
 *
 * 只列 ui-02 票面点名的 13 个抽屉面板；`acceptance:'auto'` 不是布尔：
 * 它在 cardView 里按列解析 —— 待验收/合并中/完成三列的验收清单是主内容（展开），
 * 其余列的卡还没到那一步，展开只是占高度。
 */
const FOLD_DEFAULTS = {
  progress: true,
  comments: 'recent',
  acceptance: 'auto',
  ticket: false,
  children: false,
  grill: false,
  note: false,
  plan: false,
  status: false,
  rewind: false,
  reply: false,
  stopReport: false,
  runs: false,
}

/** 'auto' 在这些列展开：卡已经走到「验收 / 合并 / 完成」，验收清单就是当前主内容。 */
const ACCEPTANCE_OPEN_COLUMNS = ['verifying', 'merging', 'done']

const asText = (v) => (v === null || v === undefined ? '' : String(v))
const toneOf = (v, fallback = 'info') => (TONES.indexOf(v) >= 0 ? v : fallback)

/** chip 的 title 是单行纯文本：反引号在那里没有意义（和 client.js 的 mergeFixTitle 同规则）。 */
const stripBackticks = (fix) => String(fix || '').replace(/`/g, '')

/**
 * 交付态归类。
 *
 * 唯一来源是 lib/core.js 的 deliveryState（rf-02）：只有 column==='done' 且
 * phase==='merged' 真的进了基线，另外三种是「列写着完成、代码没进 base」的假完成。
 * 这里保留一份 5 行镜像而不是 import core.js —— core 会把 store/git 那整条依赖
 * 链拉进读侧（panel.js 至今只 import domain/prompts 也是这个理由）。
 *
 * 投影过的卡（panel/http 的 taskCard）自带 deliveryState，直接以它为准；
 * 只有拿到**原始 store task** 时才在这里算（panel.taskCard 正是这种调用）。
 * test/view-model.mjs 拿同一组输入和 panel.deliveryStateOf 比对，漂了就红。
 */
function deliveryStateOf(task) {
  const t = task || {}
  if (typeof t.deliveryState === 'string') return t.deliveryState
  if (t.column !== 'done') return 'not-delivered'
  if (t.phase === 'merged') return 'delivered'
  if (t.phase === 'merged-skipped') return 'skipped'
  if (t.phase === 'done-no-merge') return 'no-merge'
  if (t.phase === 'merged-into-parent') return 'merged-into-parent'
  // v0.008：工作单元在父检出里直接提交，落点同样是父分支。
  if (t.phase === 'done-in-parent') return 'merged-into-parent'
  return 'not-delivered'
}

/**
 * 需求评审是否在等人拍板。
 *
 * 两个都认：领域层 setGrill 把 status 写成 verdict 的值（'escalate'，见
 * lib/dispatch.js:1022），而票面/老调用方说的是 'escalated'。少认一个的后果是
 * 「有 N 项需要人决定」这枚标永远不显形 —— 人以为评审还在跑。
 */
function grillEscalated(g) {
  if (!g) return false
  return g.status === 'escalated' || g.status === 'escalate' || g.verdict === 'escalate'
}

/**
 * 全量徽标，按 BADGE_ORDER 的顺序返回。
 *
 * 形状 {key,text,tone,title}：text 给人看、title 是悬停解释、tone 是配色。
 * 不返回 only —— 调用方要按上卡/详情分流时用 BADGE_ORDER 查（见 chipsFor）。
 * 传 null / undefined 返回空数组：看板在 loading 态也会调它。
 */
export function badgesFor(task) {
  const t = task || {}
  const out = []
  const add = (key, text, tone, title) => {
    const fallback = asText((BADGE_ORDER.find((b) => b.key === key) || {}).label)
    const body = asText(text) || fallback
    // 文案空着也要有话说：一枚没有 text 的 chip 在界面上是一个空胶囊，比不显示更容易被忽略。
    out.push({ key, text: body, tone: toneOf(tone), title: asText(title) || body })
  }

  // ① 人工阻塞：卡片变红、摘要行说原因，这枚标本身只给一个「有阻塞」的钩子。
  if (t.blocked) add('blocked', '阻塞', 'bad', t.blocked.reason || '阻塞')

  // ② 合并受阻（ADR-0005）：这是**故障**，必须一直在看板上显形 —— 以前 noMerge
  // 根本不在卡上，"合不了"和"本来不用合"长得一模一样。
  const mergeState = asText(t.mergeState) || null
  const mergeInfo = mergeReasonOf(t)
  if (mergeState === 'blocked') {
    add('merge-blocked', mergeInfo.label || MERGE_STATE_LABEL.blocked, mergeInfo.tone || 'bad',
      stripBackticks(mergeInfo.fix) || MERGE_STATE_LABEL.blocked)
  }

  // ③ 高风险（方案预筛）：在验收前就该被看见，所以排在合并排队之前。
  if (t.risk && t.risk.level === 'high') {
    const reasons = Array.isArray(t.risk.reasons) ? t.risk.reasons : []
    add('risk-high', '⚡高风险', 'bad', reasons.join('；') || '方案被判为高风险')
  }

  // ④ 评审升级：人在等这张卡，卡上必须说清楚。
  if (grillEscalated(t.grill)) {
    const open = Array.isArray(t.grill.openForHuman) ? t.grill.openForHuman : []
    add('grill-escalate', '待人决定', 'warn', '有 ' + open.length + ' 项需要人决定')
  }

  // ⑤ 子卡等父检出（C-10）：不是故障，是排队 —— 用 info，别和真阻塞抢红色。
  if (t.phase === 'waiting-branch') {
    add('waiting-branch', '等分支', 'info', '等父检出空出来（phase=waiting-branch）')
  }

  // ⑥ 排队等合并：会被问"怎么还没 done"，所以给一枚；none / ready 不出标。
  if (mergeState === 'pending') {
    add('merge-pending', mergeInfo.label || MERGE_STATE_LABEL.pending, 'info',
      stripBackticks(mergeInfo.fix) || MERGE_STATE_LABEL.pending)
  }

  // ⑦ 交付态：只有 delivered 静默（正常的完成不需要噪音），另外三种都是假完成形态。
  const delivery = deliveryStateOf(t)
  if (delivery === 'skipped') {
    add('delivery', '未合并', 'warn', '有意未合并：这张卡决定不合并（不是故障，但代码没进基线）')
  } else if (delivery === 'no-merge') {
    add('delivery', '无可合', 'info', '无可合并内容：这张卡本来就没有要合进基线的东西')
  } else if (delivery === 'merged-into-parent') {
    add('delivery', '已合入父分支', 'info', '已合入父分支：改动在父分支上统一发布，不单独进基线')
  }

  // ⑧ 车道（只进详情）：issue 自动车道的卡和人直派的手感不同，打开时要能看到。
  if (t.lane === 'issue') add('lane', 'issue', 'info', 'issue 自动车道')

  // ⑨ 子卡进度（只进详情）：父卡的汇总进度，子卡本身不上板。
  if (t.childProgress && Number(t.childProgress.total) > 0) {
    const done = Math.max(0, Number(t.childProgress.done) || 0)
    const total = Math.max(0, Number(t.childProgress.total) || 0)
    add('child', '子任务 ' + done + '/' + total, done >= total ? 'ok' : 'info',
      '子任务 ' + done + '/' + total + ' 完成（子卡在详情里打开）')
  }

  return out
}

/** 上卡徽标的截断：chips 是前 max 枚卡片徽标，more 是没装下的个数。 */
function chipsOf(badges, max) {
  const n = max === null || max === undefined ? 2 : Number(max)
  const limit = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 2
  const card = badges.filter((b) => CARD_KEYS.indexOf(b.key) >= 0)
  return { chips: card.slice(0, limit), more: Math.max(0, card.length - limit) }
}

/**
 * 卡片上最多 max 枚徽标（默认 2）+ 溢出计数。
 *
 * 为什么默认 2：一行能无痛放下两枚；第三枚开始挤掉卡号和时间，而看板是扫的，
 * 不是读的。详情面板要全量时调 badgesFor。
 */
export function chipsFor(task, max = 2) {
  return chipsOf(badgesFor(task), max)
}

/**
 * 卡片摘要行（行3）。
 *
 * 优先级：blocked.reason > progress.blocker > progress.next > 阶段短语 > null。
 * 越靠前越"人必须现在知道"：阻塞点不解决这张卡不会动；下一步是顺带的进度；
 * 阶段是背景（而且列里大多已经写着）。
 *
 * 返回 {text,tone}，text 不带 ⛔ / → 前缀 —— 前缀是渲染层按 tone 决定的事
 * （bad 配 ⛔、info 配 →），塞进文案里会让 ui-04 重新剥一遍。
 * text 为 null 表示"这行不渲染"，不是空串：空串会占一行高度。
 */
export function headlineFor(task) {
  const t = task || {}
  if (t.blocked && t.blocked.reason) return { text: asText(t.blocked.reason), tone: 'bad' }
  const pg = t.progress || {}
  if (pg.blocker) return { text: asText(pg.blocker), tone: 'bad' }
  if (pg.next) return { text: asText(pg.next), tone: 'info' }
  if (t.phase && !PHASE_REDUNDANT[t.column + '/' + t.phase]) {
    return { text: PHASE_LABEL[t.phase] || asText(t.phase), tone: 'muted' }
  }
  return { text: null, tone: 'muted' }
}

/** 抽屉折叠默认值：只有 acceptance 随列变化（'auto' 在这里落成布尔）。 */
function foldsFor(task) {
  const t = task || {}
  const open = ACCEPTANCE_OPEN_COLUMNS.indexOf(asText(t.column)) >= 0
  return Object.assign({}, FOLD_DEFAULTS, { acceptance: open })
}

/**
 * 一张卡的全部视图状态：一张卡片 / 一个抽屉只调它。
 *
 * 两个 tone 的含义不同：`tone` 取的是 Chip 的配色（ok/warn/bad/info，没有徽标时是
 * 'muted'），`headline.tone` 只用于摘要行（bad/info/muted），不要互相套。
 *
 * tone 取**当前最该被看见**的那枚徽标的配色（数组已按优先级排好）；
 * 没有徽标但摘要行是红的（progress.blocker 不算 blocked 徽标）也要红 ——
 * 否则"工人自己报的阻塞"在卡上没有颜色，看起来像正常推进。
 *
 * 返回值每次都新建（folds 也是拷贝），调用方改了不会污染下一次调用。
 */
/**
 * 这张卡现在在等什么（v0.016 / ticket 11）。
 *
 * 看板以前只有一个「执行中」，把「有 run 在跑」和「在等依赖/等分支/等人」混成一个数；
 * 线上 65% 的「执行中」其实是空转。这里按优先级给出一个互斥的原因。
 */
export function waitingReasonFor(task, ctx = {}) {
  if (!task) return null
  if (task.blocked) {
    const why = String((task.blocked && task.blocked.reason) || '')
    return { kind: 'blocked', text: '被卡住：' + (why || '未知原因') }
  }
  if (task.phase === 'blocked-needs-env' || (task.envMissing && task.envMissing.length)) {
    const miss = Array.isArray(task.envMissing) ? task.envMissing.join('、') : String(task.envMissing)
    return { kind: 'env', text: '缺环境：' + (miss || '待补') }
  }
  if (task.activeRunId) return null
  const tasks = Array.isArray(ctx.tasks) ? ctx.tasks : []
  const unmet = (task.dependsOn || []).filter((id) => {
    const dep = tasks.find((x) => x && x.id === id)
    return !dep || !(dep.column === 'done' && dep.phase === 'merged')
  })
  if (unmet.length) {
    // v0.016（ticket 13）：能说清在哪等什么就说清 ——「等 T-050 的 report.md」。
    const meta = (task.dependsOnMeta || [])
    const parts = unmet.slice(0, 3).map((id) => {
      const m = meta.find((x) => x && x.taskId === id)
      const arts = Array.isArray(m && m.artifacts) ? m.artifacts : []
      return arts.length ? id + ' 的 ' + arts.slice(0, 2).join('、') : id
    })
    const named = parts.some((p) => p.includes(' 的 '))
    // 有产物声明就说清「等谁的哪份文件」；没有就退回旧的「等依赖：T-007」。
    return { kind: 'dep', text: (named ? '等 ' : '等依赖：') + parts.join(' / ') }
  }
  if (task.mergeReason === 'base-busy' || task.mergeReason === 'integ-dirty') return { kind: 'branch', text: '等分支：' + task.mergeReason }
  if (task.column === 'verifying') return { kind: 'accept', text: '等人验收' }
  if (task.column === 'running' || task.column === 'merging') return { kind: 'run', text: '等工人' }
  return null
}

export function cardView(task, ctx = {}) {
  const badges = badgesFor(task)
  const headline = headlineFor(task)
  const { chips, more } = chipsOf(badges, 2)
  let tone = badges.length ? badges[0].tone : 'muted'
  if (tone !== 'bad' && headline.tone === 'bad') tone = 'bad'
  return { tone, headline, chips, more, folds: foldsFor(task), waiting: waitingReasonFor(task, ctx) }
}
