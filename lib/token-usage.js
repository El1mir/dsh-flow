/**
 * 从会话事件流折算真实累计用量（与 DSH token-meter 的 tokenUsage 投影同口径）。
 *
 * 为什么不用 tokenMeter.measure()：它只给"当前请求的上下文压力"，没有累计用量；
 * sessionController.inspect() 返回的是 { meta, events }，不是 Session 对象，
 * 之前把它塞进 measure() 只会得到全 0。
 *
 * 同一 (turn, step) 的多次采样后者覆盖前者；llm/retry-started 关闭当前槽位，重试按新增计。
 */
const usageOf = (ev) => {
  const d = ev && ev.data
  if (!d) return undefined
  if (ev.type === 'assistant/message' && d.usage !== undefined) return d.usage
  if (ev.type !== 'assistant/message' && ev.type !== 'assistant/attempt') return undefined
  const stream = Array.isArray(d.stream) ? d.stream : []
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const r = stream[i]
    if (r && r.type === 'chunk' && r.chunk && r.chunk.type === 'usage') return r.chunk.usage
  }
  return undefined
}

export function foldUsage(events) {
  const t = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const turns = new Set()
  const steps = new Set()
  let last = null
  for (const ev of events || []) {
    if (!ev) continue
    if (ev.type === 'llm/retry-started') {
      if (last && ev.data && last.turn === ev.data.turn && last.step === ev.data.step) last = null
      continue
    }
    const u = usageOf(ev)
    if (!u) continue
    const turn = ev.data.turn
    const step = ev.data.step
    turns.add(String(turn))
    steps.add(turn + ':' + step)
    const b = {
      uncachedInput: Number(u.inputTokens) || 0,
      output: Number(u.outputTokens) || 0,
      cacheRead: Number(u.cacheReadTokens) || 0,
      cacheWrite: Number(u.cacheWriteTokens) || 0,
    }
    const prev = last && last.turn === turn && last.step === step ? last.b : null
    for (const k of Object.keys(t)) t[k] += b[k] - (prev ? prev[k] : 0)
    last = { turn, step, b }
  }
  return { ...t, turns: turns.size, steps: steps.size }
}

/** 已挂载的会话优先读 DSH 投影（O(1)），否则折算 inspect() 的事件前缀。 */
export function totalsFromProjection(p) {
  if (!p || !p.totals) return null
  const x = p.totals
  return {
    uncachedInput: Number(x.uncachedInputTokens) || 0,
    output: Number(x.outputTokens) || 0,
    cacheRead: Number(x.cacheReadTokens) || 0,
    cacheWrite: Number(x.cacheWriteTokens) || 0,
  }
}
