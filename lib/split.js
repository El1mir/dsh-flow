/**
 * dsh-flow · split
 *
 * v1.39：拆分（父卡 → 子卡）与工作包工单（结构化八问）的纯函数。
 * 放在单独模块里：这些全是无副作用的校验 / 渲染，便于单测，也让 domain 的事务方法保持短。
 */

const must = (cond, message) => { if (!cond) throw new Error(message) }
const clamp = (text, max) => String(text == null ? '' : text).slice(0, max)

/** 结构化八问：每个工作包按它填；sources 记录每一项是谁补的（auto / grill / human）。 */
export const EIGHT_QUESTIONS = [
  { n: 1, key: 'purpose', ask: '为什么改（修改目的）' },
  { n: 2, key: 'current', ask: '现在什么样（现状与代码位置）' },
  { n: 3, key: 'scope', ask: '改哪里（修改范围：路径/符号）' },
  { n: 4, key: 'outOfScope', ask: '不改什么（排除项）' },
  { n: 5, key: 'effect', ask: '影响到谁（生效域：调用方/接口/配置/用户可见行为）' },
  { n: 6, key: 'acceptance', ask: '怎么算完成（验收范围与测试命令）' },
  { n: 7, key: 'risk', ask: '风险与回滚' },
  { n: 8, key: 'dependsOn', ask: '依赖与顺序（能否并行）' },
]

const pathPrefix = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()

/** 两组路径前缀是否重叠；有就返回命中的那一条（错误信息里用）。 */
export function overlapPaths(a, b) {
  const xs = (Array.isArray(a) ? a : []).map(pathPrefix).filter(Boolean)
  const ys = (Array.isArray(b) ? b : []).map(pathPrefix).filter(Boolean)
  for (const x of xs) {
    for (const y of ys) {
      if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return x + ' ∩ ' + y
    }
  }
  return null
}

/** 依赖成环检查：DFS 三色标记。 */
export function assertNoCycle(norm) {
  const color = new Array(norm.length).fill(0)
  const visit = (i) => {
    if (color[i] === 1) throw new Error('依赖成环：第 ' + (i + 1) + ' 项绕回了自己')
    if (color[i] === 2) return
    color[i] = 1
    for (const j of norm[i].dependsOn) visit(j)
    color[i] = 2
  }
  for (let i = 0; i < norm.length; i += 1) visit(i)
}

/** 规整一个拆分项：缺什么就说缺第几项的什么。字段对应结构化八问。 */
export function normalizeSplitItem(raw, i) {
  const x = raw || {}
  const at = '第 ' + (i + 1) + ' 项'
  const title = clamp(String(x.title || '').trim(), 120)
  must(title, at + '缺 title（子卡标题）')
  const purpose = clamp(String(x.purpose || '').trim(), 500)
  must(purpose, at + '缺 purpose（修改目的：为什么改）')
  const effect = clamp(String(x.effect || '').trim(), 500)
  must(effect, at + '缺 effect（生效域：影响到谁）')
  const scope = {
    paths: (Array.isArray(x.scope && x.scope.paths) ? x.scope.paths : []).map((p) => clamp(String(p || ''), 300)).filter(Boolean).slice(0, 20),
    symbols: (Array.isArray(x.scope && x.scope.symbols) ? x.scope.symbols : []).map((p) => clamp(String(p || ''), 120)).filter(Boolean).slice(0, 20),
  }
  must(scope.paths.length || scope.symbols.length, at + '缺 scope（修改范围：paths 或 symbols 至少一个）')
  const acceptance = (Array.isArray(x.acceptance) ? x.acceptance : []).map((a) => clamp(String(a || ''), 300)).filter(Boolean).slice(0, 10)
  must(acceptance.length, at + '缺 acceptance（验收范围：至少 1 条可复现的验收点）')
  const dependsOn = []
  for (const d of (Array.isArray(x.dependsOn) ? x.dependsOn : [])) {
    const n = Number(d)
    must(Number.isInteger(n), at + '的 dependsOn 只能是同批的序号（数字）')
    // 兼容 1-based（人习惯从 1 数）与 0-based：先试 1-based
    const idx = (n >= 1 && n <= 8) ? n - 1 : n
    must(idx >= 0 && idx < 8, at + '的 dependsOn 序号越界：' + d)
    must(idx !== i, at + '不能依赖自己')
    if (!dependsOn.includes(idx)) dependsOn.push(idx)
  }
  const ticket = {
    purpose,
    current: clamp(String(x.current || '').trim(), 800),
    scope,
    outOfScope: clamp(String(x.outOfScope || '').trim(), 500),
    effect,
    acceptance,
    testCmd: clamp(String(x.testCmd || '').trim(), 500),
    risk: clamp(String(x.risk || '').trim(), 500),
    rollback: clamp(String(x.rollback || '').trim(), 500),
    dependsOn,
    sources: (() => {
      const out = {}
      for (const q of EIGHT_QUESTIONS) {
        const v = x.sources && x.sources[q.key]
        out[q.key] = ['auto', 'grill', 'human'].includes(v) ? v : 'auto'
      }
      return out
    })(),
  }
  return {
    title, purpose, scope, effect, acceptance, dependsOn,
    priority: ['high', 'medium', 'low'].includes(x.priority) ? x.priority : null,
    ticket,
  }
}

/** 工作包工单 → Markdown：作为子卡计划 rev1（工人读到的第一份材料）。 */
export function renderTicketPlan(item) {
  const t = item.ticket || {}
  const deps = item.dependsOn.length ? item.dependsOn.map((j) => '第 ' + (j + 1) + ' 项').join('、') : '无'
  const out = [
    '# 工作包：' + item.title,
    '',
    '## 1. 修改目的',
    t.purpose || '-',
    '',
    '## 2. 现状',
    t.current || '（调度未补充：开工前先用 codegraph / read 查清楚再动手）',
    '',
    '## 3. 修改范围',
  ]
  for (const p of (t.scope && t.scope.paths) || []) out.push('- ' + p)
  if (!((t.scope && t.scope.paths) || []).length) out.push('（未声明路径）')
  if (t.scope && t.scope.symbols && t.scope.symbols.length) out.push('', '符号：' + t.scope.symbols.join('、'))
  out.push('', '## 4. 不改什么', t.outOfScope || '（未声明）')
  out.push('', '## 5. 生效域', t.effect || '-')
  out.push('', '## 6. 验收范围')
  ;(t.acceptance || []).forEach((a, i) => out.push((i + 1) + '. ' + a))
  if (t.testCmd) out.push('', '测试命令：' + t.testCmd)
  out.push('', '## 7. 风险与回滚')
  if (t.risk) out.push('- 风险：' + t.risk)
  if (t.rollback) out.push('- 回滚：' + t.rollback)
  if (!t.risk && !t.rollback) out.push('（未声明）')
  out.push('', '## 8. 依赖与顺序', '依赖：' + deps, '')
  out.push('> 本卡从父任务拆分而来：只做「修改范围」内的事。范围外的改动请 flow_message 问调度，不要顺手改。')
  return out.join('\n')
}

/** 父卡计划改成拆分表。 */
export function renderSplitTable(norm, ids, reason) {
  const out = ['# 拆分表：' + norm.length + ' 个工作包']
  if (reason) out.push('', '拆分理由：' + reason)
  out.push('', '| 子卡 | 标题 | 主要范围 | 依赖 |', '| --- | --- | --- | --- |')
  norm.forEach((item, i) => {
    const deps = item.dependsOn.length ? item.dependsOn.map((j) => ids[j]).join('、') : '—'
    const main = (item.scope.paths[0] || item.scope.symbols[0] || '—')
    out.push('| ' + ids[i] + ' | ' + item.title + ' | ' + main + ' | ' + deps + ' |')
  })
  out.push('', '子卡各自有自己的 run / worktree / 验收 / 合并；本卡只做汇总，全部子卡完成后自动进待验收。')
  return out.join('\n')
}
