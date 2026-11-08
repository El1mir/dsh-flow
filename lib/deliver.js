/**
 * 交付目标判定（C-05 / rf-01）—— 纯策略，不碰 git。
 *
 * 为什么单独一个模块：这个判断回答的是「这张卡的东西该合到哪里」，
 * 而「怎么合」是 dispatch + git + integration 的事。把前者做成纯函数，
 * 就能在没有仓库、没有运行时的情况下单测它 —— 这也是它唯一值得单独成文件的原因。
 *
 * 两种目标：
 *   base   —— 普通卡：分支合进项目 base，对外是一个 PR。
 *   branch —— 子卡：分支合进**父卡的集成分支**（flow/<parentId>），不开自己的 PR。
 *           父卡收口时才把集成分支合进 base，对外仍然只有一个 PR。
 */

export const DELIVERY_TARGETS = ['base', 'branch']

/** 父卡的集成分支名。<parentId> 是父卡 id，与 branchFor 的命名规则一致。 */
export function integrationBranchOf(parentId) {
  return parentId ? 'flow/' + parentId : null
}

/**
 * 这张卡的交付目标。
 *
 * 判定只有一条：**有父卡就是 branch**。branchFrom 是拆分时写下的父分支名
 * （schema 13 起），缺失时按 parentId 推，再缺失就退回 base —— 一个子卡因为没有
 * branchFrom 就往 base 上合，会让「父卡只有一个 PR」这条不变式当场破掉，
 * 所以宁可推也要推出来。
 */
export function resolveTarget(task) {
  if (!task) return { kind: 'base', branch: null, reason: 'no-task' }
  if (!task.parentId) return { kind: 'base', branch: null }
  const branch = task.branchFrom || integrationBranchOf(task.parentId)
  return { kind: 'branch', branch, parentId: task.parentId }
}

/**
 * 父卡自己的交付目标永远是 base，分支是它的集成分支。
 * 单独写一个函数是因为 openPr / mergeLocked 里到处 `task.integrationBranch || flow/<id>`
 * 会把命名规则散到四五个地方。
 */
export function integrationBranchFor(task) {
  if (!task || !task.id) return null
  if (task.integrationBranch) return task.integrationBranch
  return Array.isArray(task.childIds) && task.childIds.length ? integrationBranchOf(task.id) : null
}

/**
 * 这张卡算不算「已交付」（代码进了 base）。
 * 子卡合进父分支之后 phase 是 merged-into-parent —— 不算交付，代码还在父分支上。
 */
export function isDeliveredByTarget(task) {
  if (!task) return false
  if (resolveTarget(task).kind !== 'base') return false
  return task.column === 'done' && task.phase === 'merged'
}
