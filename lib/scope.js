/**
 * dsh-flow · scope
 *
 * 同域分派：把「阅读范围相近」的任务压给同一个工人，减少重复读同一批代码。
 * 纯函数，无副作用；所有输入都来自 domain 的只读投影，便于单测与回放仿真。
 *
 * 打分越小越优先：
 *   cost = 3*(1-overlap) + 1*load + 2*seatRank + 5*laneMismatch + 4*budgetRisk
 */

/** 路径归一：统一分隔符、去掉 ./ 前缀与结尾斜杠、转小写（Windows/macOS 大小写不敏感）。 */
export function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** 路径前缀重叠：a 等于 b、或 a 在 b 之下、或 b 在 a 之下，都算命中。 */
export function pathHit(a, b) {
  const x = normalizePath(a)
  const y = normalizePath(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

/**
 * 两组 scope 的重叠度（0..1）。
 * 路径：双向前缀命中即算，按命中数/较大集合大小归一；
 * 符号：大小写不敏感精确匹配。
 */
export function overlapScope(taskScope, workerScope) {
  const t = taskScope || { paths: [], symbols: [] }
  const w = workerScope || { paths: [], symbols: [] }
  const tPaths = Array.isArray(t.paths) ? t.paths : []
  const wPaths = Array.isArray(w.paths) ? w.paths : []
  const tSyms = (Array.isArray(t.symbols) ? t.symbols : []).map((s) => String(s).toLowerCase())
  const wSyms = (Array.isArray(w.symbols) ? w.symbols : []).map((s) => String(s).toLowerCase())
  if (tPaths.length === 0 && tSyms.length === 0) return 0

  let pathHits = 0
  for (const p of tPaths) if (wPaths.some((q) => pathHit(p, q))) pathHits += 1
  let symHits = 0
  for (const s of tSyms) if (wSyms.includes(s)) symHits += 1

  const pathDenom = Math.max(tPaths.length, wPaths.length, 1)
  const symDenom = Math.max(tSyms.length, wSyms.length, 1)
  const pathScore = pathHits / pathDenom
  const symScore = symHits / symDenom
  // 路径是主要信号；符号作为加权补充
  return Math.min(1, pathScore * 0.75 + symScore * 0.25)
}

/**
 * 工人的阅读画像：最近 N 个已完成任务（同车道）的 scope 并集，越新权重越高。
 * 返回 { paths, symbols }（已去重），用于 overlapScope 的第二个参数。
 */
export function workerScopeProfile(tasks, agentId, { limit = 5 } = {}) {
  const mine = Object.values(tasks || {})
    .filter((t) => t && t.assignee === agentId && ['verifying', 'merging', 'done'].includes(t.column))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, Math.max(1, limit))
  const paths = new Set()
  const symbols = new Set()
  for (const t of mine) {
    const sc = t.scope || {}
    for (const p of Array.isArray(sc.paths) ? sc.paths : []) paths.add(normalizePath(p))
    for (const s of Array.isArray(sc.symbols) ? sc.symbols : []) symbols.add(String(s).toLowerCase())
  }
  return { paths: [...paths], symbols: [...symbols] }
}

/** 工位状态排序：idle 最优，未建次之，active 最差。 */
function seatRank(seat) {
  if (seat === 'idle') return 0
  if (!seat || seat === 'none') return 1
  return 2
}

/** 预算风险：>=0.85 视为不可接；0.7~0.85 中等；<0.7 无风险。 */
export function budgetRisk(ratio) {
  const r = Number(ratio) || 0
  if (r >= 0.85) return 1
  if (r >= 0.7) return 0.5
  return 0
}

/**
 * 给一个候选工人打分。参数全部显式传入，便于测试与回放。
 * @returns {number} cost（越小越优）；laneMismatch 时返回 Infinity。
 */
export function scoreWorker({
  taskScope,
  workerScope,
  load = 0,
  maxConcurrency = 1,
  seat = 'none',
  lane = 'human',
  taskLane = 'human',
  budgetRatio = 0,
}) {
  if ((lane || 'human') !== (taskLane || 'human')) return Infinity
  const overlap = overlapScope(taskScope, workerScope)
  const loadPenalty = Math.max(0, Number(load) || 0) / Math.max(1, Number(maxConcurrency) || 1)
  return 3 * (1 - overlap) + 1 * loadPenalty + 2 * seatRank(seat) + 4 * budgetRisk(budgetRatio)
}

/**
 * 从候选里挑最优工人。
 * @param candidates [{ agent, load, seat, budgetRatio }]
 * @returns { agent, cost, overlap, reason } | null
 */
export function pickByScope(candidates, { taskScope, taskLane = 'human', streakInfo = null, hotWorkerStreak = 3 } = {}) {
  const list = (candidates || []).filter(Boolean)
  if (list.length === 0) return null
  const scored = list
    .map((c) => {
      const wScope = c.workerScope || { paths: [], symbols: [] }
      const cost = scoreWorker({
        taskScope,
        workerScope: wScope,
        load: c.load,
        maxConcurrency: c.agent.maxConcurrency || 1,
        seat: c.seat,
        lane: c.agent.lane || 'human',
        taskLane,
        budgetRatio: c.budgetRatio || 0,
      })
      return { ...c, cost, overlap: overlapScope(taskScope, wScope) }
    })
    .filter((c) => Number.isFinite(c.cost))
    .sort((a, b) => a.cost - b.cost || a.agent.id.localeCompare(b.agent.id))
  if (scored.length === 0) return null

  // 热点保护：最优者恰好是刚刚连续被选中的那个，且还有别的可选 → 让给次优
  const best = scored[0]
  if (
    streakInfo &&
    streakInfo.agentId === best.agent.id &&
    (streakInfo.count || 0) >= hotWorkerStreak &&
    scored.length > 1
  ) {
    const alt = scored[1]
    return {
      agent: alt.agent,
      cost: alt.cost,
      overlap: alt.overlap,
      reason: { rotatedFrom: best.agent.id, streak: streakInfo.count },
    }
  }
  return { agent: best.agent, cost: best.cost, overlap: best.overlap, reason: null }
}
