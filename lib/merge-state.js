/**
 * mergeState 的读侧表（ADR-0005）。
 *
 * 为什么单独成文件、而不是放进 lib/domain.js：
 * 这张表有三个读出口 —— 状态机的 needsMerge（lib/core.js）、看板卡片的 chip、
 * 任务详情页的「合并」行。任何一处手写文案都会开始漂移，所以表只能有一份。
 * 放进 domain.js 会让 client.js 的参照物变成整个领域层；放进 core.js 又会被
 * domain.js 反向 import 成环。读侧不需要任何领域知识，纯数据 + 纯函数即可。
 *
 * 约束：**本文件不 import 任何项目文件**。它必须能在测试、工具、客户端契约测试里
 * 单独跑起来，也不该把 store / git 的副作用带进任何读出口。
 */

/**
 * 原因表：键与 ADR-0005 完全一致，不增不减。
 *
 * 每项：
 *   label  中文短语（≤12 字），直接做 chip 文案与详情行的原因半句 —— 不复用不缩
 *   fix    一句人话的修复动作；可含命令，命令用反引号圈住（客户端只在详情页把这一段
 *          换成等宽样式，看板 chip 的 title 会去掉反引号）
 *   tone   配色：bad（红的故障）| warn（黄的环境问题）| info（中性说明）
 *   state  所属状态，便于测试与调用方反查「这个原因属于哪一态」
 *
 * 三态的取舍（ADR-0005）：
 *   none    本来就不用合 —— 卡片静默，详情留一行淡的
 *   blocked 现在合不了 —— 卡片出 chip，详情给修复动作
 *   pending / ready 不需要原因，表里刻意留空
 */
export const MERGE_REASON = {
  // ---- none：正常，不是故障 ----------------------------------------------
  'no-code-change': {
    label: '没有代码改动',
    fix: '无需处理：这张卡的交付物不是代码',
    tone: 'info',
    state: 'none',
  },
  'coordination-card': {
    label: '协调卡',
    fix: '无需处理：父卡只做汇总，改动在子卡里合并',
    tone: 'info',
    state: 'none',
  },
  'no-worktree': {
    label: '没有检出',
    fix: '本身就按主工作区交付，无需处理',
    tone: 'info',
    state: 'none',
  },
  'not-a-repo': {
    label: '不是 Git 仓库',
    fix: '无需处理：改动直接落在工作区，没有分支可合',
    tone: 'warn',
    state: 'none',
  },

  // ---- blocked：合不了 ----------------------------------------------------
  // no-commits 用 warn 而不是 bad：仓库一次提交都没有是**环境**没准备好，
  // 补一次基线提交就能恢复；其余几项是这张卡/这次交付真的出了问题。
  'no-commits': {
    label: '缺基线提交',
    fix: '初始化仓库：在项目目录执行 `git add -A && git commit -m "baseline"`',
    tone: 'warn',
    state: 'blocked',
  },
  'base-missing': {
    label: '基线分支不存在',
    fix: '改项目设置里的基线分支（`git branch --show-current` 看真实分支名）',
    tone: 'bad',
    state: 'blocked',
  },
  'branch-busy': {
    label: '分支被占用',
    fix: '清掉残留检出：`git worktree list` 找到占用者，再 `git worktree remove <该目录>`',
    tone: 'bad',
    state: 'blocked',
  },
  'head-mismatch': {
    label: '验收后又提交了',
    fix: '重新验收一次（`git log --oneline -3` 确认当前提交）',
    tone: 'bad',
    state: 'blocked',
  },
  'out-of-scope-dirty': {
    label: '改到了范围外',
    fix: '把范围外的改动退回或另开一张卡，再重新派工',
    tone: 'bad',
    state: 'blocked',
  },
  'worktree-missing': {
    label: '检出不见了',
    fix: '重新派工会重建检出（`git worktree list` 先确认它真的没了）',
    tone: 'bad',
    state: 'blocked',
  },
}

/** 四种状态的短标签。pending / ready 没有原因，靠它给文案。 */
export const MERGE_STATE_LABEL = {
  none: '不需要合并',
  pending: '等待合并',
  blocked: '合不了',
  ready: '可合并',
}

/**
 * 取一个任务的原因项。
 *
 * 为什么要有兜底而不是直接 MERGE_REASON[x]：mergeReason 是**线上数据**，枚举会
 * 随着迁移/人工写入/未来新增原因出现表里没有的键。读出口是看板与详情页 ——
 * 一次 undefined 就是整页白屏。兜底返回同一形状的对象，label 退回任务自己那句
 * 人话（noMergeReason），再退到空串，让调用方自己拼「状态 · 原因」。
 */
export function mergeReasonOf(task) {
  const t = task || {}
  const key = t.mergeReason || null
  const hit = key ? MERGE_REASON[key] : null
  if (hit) return hit
  return {
    label: String(t.noMergeReason || ''),
    fix: '',
    tone: 'info',
    state: t.mergeState || null,
  }
}
