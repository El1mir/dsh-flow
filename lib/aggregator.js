/**
 * dsh-flow · aggregator
 *
 * 把「连续产生的一批通知」合并成一条消息再投给调度员。
 *
 * 为什么需要它：watchEvents + notifyDispatcher 是「一个事件一次 promptSession」。
 * 线上实测一分钟最多投 8 条 —— 调度员平均每 7 秒被打断一次，
 * 模型每次都要重新进上下文，根本没法连续输出。
 *
 * 三层策略（缺一层都会出问题）：
 *
 *   ① 紧急事件（blocked / run 失败 / 合并冲突）→ **立即发**。
 *      这类是"卡死了"，等 3 秒等于延迟故障处理。
 *
 *   ② 普通事件 → trailing debounce：来一条就重置计时器，
 *      「安静 debounceMs 毫秒」才发。这样一波事件只发一条。
 *
 *   ③ maxWait 兜底：只有 debounce 会饿死 ——
 *      如果消息持续每 2 秒来一条，计时器永远被重置，一条都发不出去。
 *      所以从**第一条进队**开始算，最多等 maxWaitMs，到点无条件发。
 *
 * 另外：合并后的正文有长度上限，超了截断成摘要 —— 调度员上下文也是有限的，
 * 一次塞 5 个 inspect 包会把他的窗口吃掉。
 */

/** 换行常量：模板字符串里写 \n 会被转义，单列出来更稳。 */
const NL1 = String.fromCharCode(10)
const NL2 = NL1 + NL1

/** 默认参数。都可以被项目配置或环境变量覆盖。 */
export const DEFAULT_AGGREGATE = {
  debounceMs: 3000,   // 尾触发窗口
  maxWaitMs: 10000,   // 从第一条进队算起的最长等待（防饿死）
  maxChars: 6000,     // 合并后正文上限
}

/**
 * 建一个聚合器。
 *
 * @param {object} opts
 * @param {(sessionId: string, text: string) => Promise<any>} opts.deliver 真正的投递函数
 * @param {(msg: string) => void} [opts.log]
 * @param {() => number} [opts.now] 测试注入时钟
 */
export function createAggregator({ deliver, log = () => {}, now = () => Date.now(), config } = {}) {
  if (typeof deliver !== 'function') throw new Error('createAggregator 需要 deliver 函数')

  const cfg = { ...DEFAULT_AGGREGATE, ...(config || {}) }
  /** sessionId → { items: [], firstAt, timer, agentId, taskIds: Set } */
  const pending = new Map()

  const charLen = (s) => String(s || '').length

  /**
   * 把一批条目渲染成一条消息。
   *
   * 长度策略：先按完整正文拼，超了就从**最后一条**开始截断 ——
   * 因为先进队的那条通常更接近"最早该处理的"，保留它比保留最新的更有用。
   */
  function render(items, total) {
    const head = '【flow 合并通知 · ' + total + ' 条】'
      + (total > items.length ? '（另有 ' + (total - items.length) + ' 条已省略）' : '')
    if (items.length === 1) return items[0].text

    // 长度策略：**从后往前装** —— 后进来的通常是最新的，也最可能是当前该看的；
    // 装满后把剩下的合并成一行摘要。原来从前往后装，会把刚发生的事整条丢掉
    // （实测：巡检包被截断，调度员只看到最早那条无关的）。
    const body = []
    let used = charLen(head)
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i]
      if (used + charLen(it.text) > cfg.maxChars) break
      body.unshift(it.text)
      used += charLen(it.text) + 2
    }
    const dropped = items.length - body.length
    const tail = []
    if (dropped > 0) {
      // 列出被截掉的涉及哪些卡 —— 只知道「丢了 12 条」没法判断要不要去翻
      const shownText = body.join(NL2)
      const skippedTasks = []
      for (const it of items) {
        if (shownText.indexOf(it.text) >= 0) continue
        if (it.taskId && skippedTasks.indexOf(it.taskId) < 0) skippedTasks.push(it.taskId)
      }
      tail.push('（更早的 ' + dropped + ' 条因长度省略'
        + (skippedTasks.length ? '，涉及：' + skippedTasks.slice(0, 8).join(', ') : '')
        + ' —— 用 flow_board 看全貌，或 flow_task_detail 看单卡）')
    } else {
      // 合并时提示一句：一次给它多条，让它有机会统筹而不是逐条反应
      tail.push('以上是同批到达的 ' + total + ' 条。建议先扫一遍再决定处理顺序，不要逐条单独回。')
    }
    return [head, ...body, ...tail].join(NL2)
  }

  /** 立刻把某个 session 的队列发出去。 */
  async function flush(sessionId, reason = 'flush') {
    const slot = pending.get(sessionId)
    if (!slot) return { ok: false, skipped: 'empty' }
    // 先摘出来再发：发送期间来的新消息要进新队列，不能被这次一起带走
    pending.delete(sessionId)
    if (slot.timer) clearTimeout(slot.timer)
    if (!slot.items.length) return { ok: false, skipped: 'empty' }
    // v1.37：整批都是附注（noteOnly）时不单独发 —— 附注只搭别的通知的车。
    // 停机 flushAll 例外：那时不发就丢了。
    if (reason !== 'flush-all' && slot.items.every((it) => it.noteOnly)) {
      pending.set(sessionId, slot)
      slot.timer = null
      return { ok: true, skipped: 'notes-only', count: slot.items.length }
    }

    const total = slot.items.length
    const text = render(slot.items, total)
    try {
      const res = await deliver(sessionId, text, {
        count: total,
        taskIds: Array.from(slot.taskIds || []),
        reason,
        waitedMs: now() - slot.firstAt,
      })
      return { ok: !!(res && res.ok), count: total, truncated: charLen(text) >= cfg.maxChars }
    } catch (err) {
      log('aggregate flush failed: ' + ((err && err.message) || err))
      return { ok: false, count: total, message: String((err && err.message) || err) }
    }
  }

  /**
   * 投递一条通知。
   *
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {string} opts.text
   * @param {boolean} [opts.urgent] 紧急：跳过合并窗口立即发
   * @param {string} [opts.taskId] 归并统计用
   * @param {string} [opts.kind]
   * @param {string} [opts.agentId] 只用于日志
   */
  async function push({ sessionId, text, urgent = false, noteOnly = false, taskId = null, kind = 'note', agentId = null }) {
    if (!sessionId || !text) return { ok: false, skipped: 'invalid' }
    if (urgent) {
      // 紧急消息不排队，但**不能丢掉已排队的内容** —— 先把队列发掉，再单独发这条。
      // 否则一条"卡死了"会把前面攒的几条一起吞掉，信息就丢了。
      await flush(sessionId, 'urgent-drain')
      try {
        const res = await deliver(sessionId, text, { count: 1, reason: 'urgent', taskIds: taskId ? [taskId] : [] })
        return { ok: !!(res && res.ok), immediate: true, count: 1 }
      } catch (err) {
        log('urgent deliver failed: ' + ((err && err.message) || err))
        return { ok: false, message: String((err && err.message) || err) }
      }
    }

    // noteOnly 是「附注」：它不触发投递，只是搭下一班车。
    //
    // 为什么这么设计：评论是讨论，不是「等你做决定」。人写一条就打断调度员一次，
    // 等于把通知当同步用（线上 116/325 条投递都是它）。
    // 现在它攒着，等本批真的有别的通知要发时一起走；一直没别的事，
    // 就由 maxWait 兜底发一条合并摘要 —— 既不丢信息，也不打断节奏。
    if (noteOnly) {
      let slot0 = pending.get(sessionId)
      if (!slot0) {
        slot0 = { items: [], firstAt: now(), timer: null, agentId, taskIds: new Set(), notesOnly: 0 }
        pending.set(sessionId, slot0)
      }
      slot0.items.push({ text, kind, taskId, at: now(), noteOnly: true })
      slot0.notesOnly = (slot0.notesOnly || 0) + 1
      if (taskId) slot0.taskIds.add(taskId)
      // **不重置也不设置 timer**：若有 timer 在跑，它到点会带上这些附注；
      // 若没有 timer，就等下一个真实通知来触发，或由 flushAll 兜底。
      return { ok: true, queued: slot0.items.length, noteOnly: true, delayMs: null }
    }

    // 普通通知：进队并（重新）设定尾触发计时器
    let slot = pending.get(sessionId)
    if (!slot) {
      slot = { items: [], firstAt: now(), timer: null, agentId, taskIds: new Set() }
      pending.set(sessionId, slot)
    }
    slot.items.push({ text, kind, taskId, at: now() })
    if (taskId) slot.taskIds.add(taskId)

    // 尾触发：每来一条重置计时器；但不超过 maxWait 的硬上限
    if (slot.timer) clearTimeout(slot.timer)
    const waited = now() - slot.firstAt
    const delay = Math.max(0, Math.min(cfg.debounceMs, cfg.maxWaitMs - waited))
    slot.timer = setTimeout(() => {
      if (slot.timer && typeof slot.timer.unref === 'function') slot.timer.unref()
      flush(sessionId, waited + delay >= cfg.maxWaitMs ? 'max-wait' : 'quiet').catch(() => null)
    }, delay)
    if (slot.timer && typeof slot.timer.unref === 'function') slot.timer.unref()

    return { ok: true, queued: slot.items.length, delayMs: delay, waitedMs: waited }
  }

  /** 把所有队列发出去（停机/测试用）。 */
  async function flushAll(reason = 'flush-all') {
    const ids = Array.from(pending.keys())
    const out = []
    for (const id of ids) out.push(await flush(id, reason))
    return out
  }

  /** 当前有多少条在等（看板/诊断用）。 */
  function stats() {
    const out = []
    for (const [sessionId, slot] of pending) {
      out.push({
        sessionId,
        agentId: slot.agentId,
        queued: slot.items.length,
        waitedMs: now() - slot.firstAt,
        taskIds: Array.from(slot.taskIds),
      })
    }
    return out
  }

  /** 有没有东西在等。 */
  const size = () => Array.from(pending.values()).reduce((n, s) => n + s.items.length, 0)

  return { push, flush, flushAll, stats, size, config: cfg }
}
