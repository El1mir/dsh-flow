/**
 * dsh-flow · units
 *
 * C-11：子卡的互斥判据 —— **互斥由 scope 决定，不是由拓扑决定**。
 *
 * v0.009 把「一条分支同一时刻只能被一个检出持有」这条 git 的物理约束直接翻译成了
 * 调度规则：同一父卡下的子卡一律共用父检出 → 一律串行。代价太大 ——
 * 两张改**不相干文件**的子卡本来可以同时干，却要排队等对方验收。
 *
 * 这里把问题还原成它真正该问的那一个：**这两张卡会不会写同一片代码**。
 * 物理约束仍然成立，但它现在只决定「怎么并行」（各给一条瞬时分枝 + 一个检出），
 * 不再决定「能不能并行」。
 *
 * 故意是纯函数、不 import git / store：
 *   - 判据必须在派工**之前**就能算，而派工是副作用；
 *   - 少一个依赖，单测就不需要临时仓库（同一套判据也就不会被 git 的报错文案绑架）。
 */
import { overlapPaths } from './split.js'

/** 子卡的三种形态。legacy-branch 只给 C-10 迁移打标的存量卡。 */
export const UNIT_MODES = ['shared', 'parallel', 'legacy-branch']

const listOf = (v) => (Array.isArray(v) ? v : [])
const normSymbol = (s) => String(s == null ? '' : s).trim().toLowerCase()

/** 符号命中：完全相同，或一个是另一个的前缀（Dispatcher / Dispatcher.run）。 */
function symbolHit(a, b) {
  const x = normSymbol(a)
  const y = normSymbol(b)
  if (!x || !y) return false
  if (x === y) return true
  // 前缀用 '.' 分界，不是裸 startsWith：'DispatcherX' 与 'Dispatcher' 是两个符号，
  // 把它们判成互斥会让每个模块的第一张卡都退化成串行。
  return x.startsWith(y + '.') || y.startsWith(x + '.')
}

/**
 * 两个 scope 是否重叠（重叠 = 不能同时跑）。
 *
 * 缺任何一个都算重叠（保守）：没有范围就没有边界，等于"可能碰任何东西"。
 * 这条保守规则是给「调度没填 scope」留的兜底 —— 它会让拆得粗的父卡退回串行，
 * 但那比两张卡同时改同一个文件、互相覆盖对方未提交内容要好。
 */
export function scopesConflict(a, b) {
  const x = a || {}
  const y = b || {}
  const xPaths = listOf(x.paths).filter(Boolean)
  const yPaths = listOf(y.paths).filter(Boolean)
  const xSyms = listOf(x.symbols).filter(Boolean)
  const ySyms = listOf(y.symbols).filter(Boolean)
  // 「这一方什么都没声明」——不是「它不碰任何东西」，而是「不知道它碰什么」。
  if (!xPaths.length && !xSyms.length) return true
  if (!yPaths.length && !ySyms.length) return true
  // 路径前缀重叠复用 lib/split.js 的判据：拆分时校验兄弟重叠用的是同一套，
  // 两处各写一份的话，「拆得开」与「能并行」会给出相反答案。
  if (overlapPaths(xPaths, yPaths)) return true
  for (const s of xSyms) for (const t of ySyms) if (symbolHit(s, t)) return true
  return false
}

/**
 * 这张子卡现在能不能并行跑：与「正在跑的兄弟」都不互斥才行。
 *
 * 只看**正在跑**的兄弟，不看排队的：排队那张到它派工时也会重算一次，
 * 所以这里漏掉它不会漏判，反而能让 A∩B 互斥、A∩C 不互斥时 C 跟 A 并行。
 * （整批一起判会把「有一个冲突」放大成「全部串行」，那正是 v0.009 的退化。）
 */
export function canRunParallel(task, siblings) {
  if (!task || !task.parentId) return false
  for (const s of listOf(siblings)) {
    if (!s || s.id === task.id) continue
    // 不是兄弟（别的父卡 / 没有父卡）不参与：它们各在各的检出里，与这张卡无关。
    if (s.parentId !== task.parentId) continue
    // 「在跑」的两个信号取并集：列已经在 running（等检出的那张也算）或有活跃 run。
    if (!s.activeRunId && s.column !== 'running') continue
    if (scopesConflict(task.scope, s.scope)) return false
  }
  return true
}

/**
 * 瞬时分枝名：unit/<parentId>/<taskId>。
 *
 * 为什么与任务分支 flow/<id> 分开命名：这条分支是**单元内部**的实现细节 ——
 * 验收那一刻就合进父分支并删掉，对人是不可见的，也不该出现在 PR / 合并列里。
 * 前缀不同，运维一眼就能分出手工分支、任务分支和「上次收尾没做完」的残留。
 * 顺带也和 split 的路径归一一样处理非法字符，免得 taskId 里的怪字符让 git 拒收。
 */
export function scratchBranchFor(parentId, taskId) {
  const part = (v) => String(v == null ? '' : v).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '-').replace(/\.+$/, '')
  const p = part(parentId) || 'unknown'
  const t = part(taskId) || 'unknown'
  return 'unit/' + p + '/' + t
}
