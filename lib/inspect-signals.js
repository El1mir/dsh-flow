/**
 * dsh-flow · inspect-signals
 *
 * 巡检信号（设计文档 §4.7，对照 ework 的升级规则）。
 *
 * 每一次工人自停都记一条「这一轮发生了什么」：有没有产出改动、错误码是什么、上下文水位多少。
 * 在**历史**上判信号，而不是只看这一轮 —— 很多问题一轮看不出来（没产出一次很正常，
 * 连着两轮没产出才是问题；同一个错误报一次是偶发，报三次就是卡住了）。
 *
 * 纯函数：输入历史 + 当前事实，输出信号与建议。便于单测，也便于将来换阈值。
 */

/** 信号 → 建议。keep = 什么都不做；其余由调用方执行（steer / pause / block）。 */
export const SIGNAL_VERDICT = {
  'needs-info': 'block',
  'test-failed': 'keep',
  'no-diff': 'steer',
  'same-code': 'pause',
  'budget-exhausted': 'block',
}

export const DEFAULT_THRESHOLDS = {
  noDiffCycles: 2,      // 连续两轮没有改动 → steer
  noDiffBlockCycles: 3, // 连续三轮没有改动 → block（停下来问人，别再派工）
  sameCodeTimes: 3,     // 同一错误码连续三次 → pause
  budgetRatio: 0.9,     // 水位 ≥ 0.9 且压缩失败 → block
}

const asList = (v) => (Array.isArray(v) ? v : [])

/**
 * @param history 最近若干轮的记录（旧→新），每条形如 {at, hasDiff, code, blocked, testsFailed, budgetRatio, compactBlocked}
 * @param now 当前这一轮的事实（同形状）—— 会被拼在历史后面一起算
 * @param opts  { noDiffCycles, sameCodeTimes, budgetRatio }
 * @returns {{signals: string[], verdict: 'keep'|'steer'|'pause'|'block', reasons: string[]}}
 */
export function analyzeCycles(history, now = {}, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts || {}) }
  // v0.015：空对象（调用方没传 now）要排除 —— 否则它会被当成「这一轮没有 hasDiff」，
  // 把连续 no-diff 的计数从中间切断。
  const cycles = [...asList(history), now].filter((c) => c && typeof c === 'object' && Object.keys(c).length > 0)
  const signals = []
  const reasons = []

  const latest = cycles[cycles.length - 1] || {}

  // 1. 需要确认：工人自己说被阻塞在「需要确认」上 —— 这是人在回路的问题，不是能力问题
  if (latest.needsConfirm) {
    signals.push('needs-info')
    reasons.push('工人报告需要人确认才能继续')
  }

  // 2. 测试失败：不干预，等人工验收判断（自动改代码风险比收益大）
  if (latest.testsFailed) {
    signals.push('test-failed')
    reasons.push('停止报告里测试失败，等人工验收')
  }

  // 3. 连续 N 轮没有产出改动
  let noDiff = 0
  for (let i = cycles.length - 1; i >= 0; i -= 1) {
    if (cycles[i].hasDiff === false) noDiff += 1
    else break
  }
  let noDiffEscalate = false
  if (noDiff >= th.noDiffCycles) {
    signals.push('no-diff')
    reasons.push('连续 ' + noDiff + ' 轮没有产出改动')
    // v0.015：三轮仍然没有改动，就不是「提醒一下」的问题了。线上 T-055 在 36 分钟里
    // 被返工 3 次、5 个 run 全是 no-diff —— 缺的是环境或人给的证据，继续派工只会重复同一份报告。
    if (noDiff >= th.noDiffBlockCycles) {
      noDiffEscalate = true
      reasons.push('连续 ' + noDiff + ' 轮没有产出改动：停下来问人，不要再派同一件事')
    }
  }

  // 4. 同一个错误码连续 N 次
  let sameCode = 0
  let lastCode = null
  for (let i = cycles.length - 1; i >= 0; i -= 1) {
    const code = cycles[i].code
    if (!code) break
    if (lastCode === null) lastCode = code
    if (code !== lastCode) break
    sameCode += 1
  }
  if (sameCode >= th.sameCodeTimes) {
    signals.push('same-code')
    reasons.push('同一错误码 ' + lastCode + ' 连续 ' + sameCode + ' 次')
  }

  // 5. 上下文水位耗而且压缩压不下来
  if (Number(latest.budgetRatio) >= th.budgetRatio && latest.compactBlocked) {
    signals.push('budget-exhausted')
    reasons.push('上下文水位 ' + Math.round(Number(latest.budgetRatio) * 100) + '% 且压缩失败')
  }

  // 建议取最重的那一个：block > pause > steer > keep
  const rank = { keep: 0, steer: 1, pause: 2, block: 3 }
  let verdict = 'keep'
  for (const s of signals) {
    const v = SIGNAL_VERDICT[s] || 'keep'
    if (rank[v] > rank[verdict]) verdict = v
  }
  // 升级：no-diff 到阈值就不是 steer 了。放在最后统一覆盖，避免与其它信号的 rank 比较打架。
  if (noDiffEscalate) verdict = 'block'
  return { signals, verdict, reasons }
}
