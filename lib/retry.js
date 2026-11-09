/**
 * 失败分类（v0.016 / ticket 07）。
 *
 * 为什么必须先分类：环境抖动（网络、磁盘、进程被杀、命令不在）重试大概率能过，
 * 而内容失败（方案没实现、输出触顶）重试只会重复烧钱。混成一个计数器，
 * 会得到「环境抖动把任务内容预算吃光」这种最难查的现场（ework 的经验）。
 *
 * 判据只用**可验证信号**，不看模型自述：
 *   1. signal-killed —— 进程被信号杀掉（exitCode ≥ 128 或带 signal）
 *   2. disk-full —— ENOSPC / no space left
 *   3. startup-exit —— 刚启动就非零退出（10 秒内），通常是配置/依赖/环境
 *   4. unreachable —— 网络/服务不可达（ECONNREFUSED / ETIMEDOUT / fetch failed / …）
 *   5. command-missing —— ENOENT / command not found
 * 其余归 content（这张卡自己的问题）。
 */
export const INFRA_SIGNATURES = {
  'signal-killed': /exit code 1[3-9]\d|exit code [1-9]\d{2,}|SIGKILL|SIGTERM|killed by signal|signal: (SIG|\d)/i,
  'disk-full': /ENOSPC|no space left on device|磁盘已满|空间不足/i,
  'startup-exit': /spawn.*failed|failed to start|启动失败|cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i,
  unreachable: /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|connect ECONN|service unavailable|502 Bad Gateway|503 Service|network error|getaddrinfo/i,
  'command-missing': /ENOENT|command not found|不是内部或外部命令|not recognized as an internal/i,
}

/** 代码自身的错误信号：它们长得像「环境报错」，但重试只会重复同一个 bug。 */
export const CONTENT_SIGNATURES = /TypeError|SyntaxError|ReferenceError|RangeError|cannot read propert|is not a function|undefined is not|AssertionError|expected .* to (be|equal)|Cannot access '.*' before initialization/i

/** 把一段文本归类到某个环境信号（返回 null = 没有环境信号）。 */
export function infraSignature(text) {
  const s = String(text || '')
  if (!s) return null
  for (const [name, re] of Object.entries(INFRA_SIGNATURES)) if (re.test(s)) return name
  return null
}

/**
 * 分类一次失败。
 *
 * 入参全部取自运行现场（退出码 / 信号 / 输出 / 阶段 / 耗时），
 * 不接受「模型说这是环境问题」这种说法 —— 那样分类就变成了另一次自述。
 */
export function classifyFailure(input = {}) {
  const { message = '', stderr = '', stdout = '', exitCode = null, signal = null, stage = null, durationMs = null } = input
  const text = [message, stderr, stdout].filter(Boolean).join(NL_LINE)
  if (signal || (Number.isFinite(Number(exitCode)) && Number(exitCode) >= 128)) {
    return { kind: 'infra', signature: 'signal-killed', reason: '进程被信号终止（signal=' + (signal || 'unknown') + ', exit=' + exitCode + '）' }
  }
  if (Number.isFinite(Number(exitCode)) && Number(exitCode) !== 0 && Number(durationMs) > 0 && Number(durationMs) < 10000) {
    const sig = infraSignature(text)
    if (sig || stage === 'spawn') {
      return { kind: 'infra', signature: sig || 'startup-exit', reason: '启动 ' + Math.round(Number(durationMs) / 1000) + ' 秒内非零退出（exit=' + exitCode + '）：' + text.slice(0, 200) }
    }
  }
  const sig = infraSignature(text)
  if (sig) return { kind: 'infra', signature: sig, reason: '环境信号 ' + sig + '：' + text.slice(0, 200) }
  // 会话层的报错（turn/end error）没有进程输出可用：这一层的失败来自宿主的模型/网络调用，
  // 不是卡自己的实现问题 —— 归 infra，否则一次 API 抖动会吃掉这张卡的内容预算。
  if (stage === 'session') {
    if (CONTENT_SIGNATURES.test(text)) return { kind: 'content', signature: null, reason: String(message || '').slice(0, 300) }
    return { kind: 'infra', signature: 'session-error', reason: String(message || '').slice(0, 300) }
  }
  return { kind: 'content', signature: null, reason: String(message || '').slice(0, 300) }
}

const NL_LINE = String.fromCharCode(10)
