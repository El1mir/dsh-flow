/**
 * dsh-flow · command-flow
 *
 * `/flow` 只读调度模式：进入后收回写类工具，只允许"想与规划"；敲定后用 flow_publish 发布成一张大 issue。
 *
 * 设计要点（与 docs/事务流设计.md 4.10 一致）：
 * - 只读是**硬的**：销毁式 `tools.restrict({deny:[...]})`，不是提示词约束；
 * - 收回失败（没有 tools 服务）→ **拒绝进入**，不留半开状态；
 * - 状态按会话记（Map<sessionId, mode>），不进 flow.json：它属于 DSH 会话生命周期，重启后由用户重新进入。
 */

/**
 * 模式里**想收回**的工具名。
 *
 * 注意这是"意图清单"，不是"一定存在"：不同 DSH 构建注册的工具名不同
 * （这套构建里是 edit / write / pwsh，没有 bash / str_replace_editor），
 * 而 `tools.restrict({deny})` 对**未知名字是原子失败**的——线上就报过
 * `names unknown global tools "str_replace_editor", "bash", ...`，整个 /flow 进不去。
 *
 * 所以进入模式时用 {@link resolveDenyList} 与真实注册表求交集，
 * 只 deny 确实存在的那些。
 */
export const FLOW_DENY_TOOLS = [
  // 写文件 / 改代码
  'write', 'edit', 'write_file', 'edit_file', 'replace', 'apply_patch', 'str_replace_editor',
  // 跑命令
  'bash', 'pwsh', 'shell', 'exec',
  // 会动仓库/外部状态的
  'present', 'todo_write',
]

/**
 * 把意图清单收敛成"本构建真的有、且当前 agent 看得见"的工具名。
 *
 * @param tools - scoped tools 服务（agent.ctx.tools）
 * @param scope - 视图作用域（agent 身份）；不给就用默认视图
 * @returns 可安全放进 restrict({deny}) 的名字数组（可能为空）
 */
export function resolveDenyList(tools, scope) {
  const wanted = new Set(FLOW_DENY_TOOLS)
  const present = new Set()
  if (tools && typeof tools.schemas === 'function') {
    let list = []
    try { list = tools.schemas(scope) || [] } catch { list = [] }
    for (const item of list) {
      const name = item && item.name
      if (typeof name === 'string' && name) present.add(name)
    }
  }
  if (!present.size && tools && typeof tools.get === 'function') {
    // 兜底：没有枚举能力就逐个探测
    for (const name of wanted) {
      try { if (tools.get(name, scope)) present.add(name) } catch { /* 忽略 */ }
    }
  }
  return [...wanted].filter((name) => present.has(name))
}

/** 模式里额外允许的 flow 工具（即使全局被 restrict 影响也要显式保留）。 */
export const FLOW_ALLOW_TOOLS = [
  'flow_board', 'flow_task_create', 'flow_task_comment', 'flow_scope_set', 'flow_publish', 'flow_config',
]

/**
 * 模式下注入系统提示的一段话。
 *
 * 这里只放**agent 不看就问不出来**的东西：模式语义、硬边界、该去调用哪个 skill。
 * 完整拆解流程在 `flow` skill 里（skills/flow/SKILL.md）——单一来源，避免两处漂移。
 */
/**
 * 只读诊断：算出"进入模式时会 deny 哪些工具"，但**不真的 restrict**。
 * 用来线上确认交集逻辑生效与否（直接跑 /flow 会把当前会话的写工具收走，代价太大）。
 */
export function describeDenyPlan(tools, scope) {
  const resolved = resolveDenyList(tools, scope)
  // 把"这个 agent 到底有哪些工具"也带出来：线上出现过 deny=[] 的情况，
  // 只有看到全量列表才能判断是"本构建没有写工具"还是"scope 传错了/视图是空的"。
  let visible = []
  if (tools && typeof tools.schemas === 'function') {
    try { visible = (tools.schemas(scope) || []).map((x) => x && x.name).filter(Boolean) } catch { visible = [] }
  }
  const restrictable = []
  if (tools && typeof tools.get === 'function') {
    for (const name of FLOW_DENY_TOOLS) {
      try { if (tools.get(name, scope)) restrictable.push(name) } catch { /* 忽略 */ }
    }
  }
  return {
    ok: true,
    intent: FLOW_DENY_TOOLS.slice(),
    deny: resolved,
    missing: FLOW_DENY_TOOLS.filter((name) => !resolved.includes(name)),
    willRestrict: resolved.length > 0,
    visible,
    visibleCount: visible.length,
    restrictable,
  }
}

export const FLOW_SECTION_TEXT = [
  '## 调度模式',
  '你现在的产出是**一组能被别人独立做完的任务**，不是代码。写工具已收回，正确做法是把改动写进任务。',
  '',
  '进入后的第一个动作：调用 `skill` 工具，name=`flow`。它给出摸清现状 → 切工作包 → 定执行序 → 发布的完整判据。',
  '若该 skill 不可用，按这个下限做：每条任务给 title、scope(paths/symbols)、可复现的 acceptance、note；scope 不重叠的才拆成两条；',
  '先找出被依赖的地基任务单独成包，其余并行；把清单与执行序讲给用户，确认后调用 `flow_publish` 一次发布。',
  '',
  '发布成功即本模式结束，后续由子调度按 scope 打分派给工人。',
].join('\n')

/**
 * 模式管理：按 sessionId 记录，并用 tools.restrict 的真实 disposer 恢复。
 */
export function createFlowMode({ log = () => {} } = {}) {
  const modes = new Map()

  function isActive(sessionId) {
    return modes.has(sessionId)
  }

  function activeSessions() {
    return [...modes.keys()]
  }

  /**
   * 进入模式。返回 { ok, message }。
   *
   * **必须用 agent 作用域的 tools**：`tools.restrict()` 只接受 scoped context，
   * 在全局 ctx 上调用会抛
   * `a context-global restriction would mask every agent`——
   * 那会把每个 agent 的写工具都收掉，不是我们要的"只限制这个对话"。
   *
   * `agent.ctx` 的贡献是 agent-local，agent 销毁时自动回卷，
   * 正好是"这个会话进只读模式"的语义。拿不到 scoped tools 就拒绝进入
   * （不允许静默降级成全局限制）。
   */
  function enter(agent, sessionId, toolsService) {
    const sid = String(sessionId || '').trim()
    if (!sid) return { ok: false, message: '缺少会话 id' }
    if (modes.has(sid)) return { ok: true, message: '已经在调度模式', active: true }
    const scopedCtx = agent && agent.ctx
    const tools = toolsService || (scopedCtx && scopedCtx.tools)
    if (!scopedCtx) {
      return { ok: false, message: '拿不到当前 agent 的 scoped context，无法只限制本对话的工具（拒绝退化成全局限制）' }
    }
    if (!tools || typeof tools.restrict !== 'function') {
      return { ok: false, message: '当前 profile 没有 tools.restrict，无法安全地进入只读调度模式' }
    }
    // 与真实注册表求交集：未知名字会让 restrict 原子失败（线上就是这么炸的）
    const deny = resolveDenyList(tools, agent && agent.id ? agent.id : undefined)
    let dispose = null
    let used = deny
    if (deny.length) {
      try {
        dispose = tools.restrict({ deny })
      } catch (err) {
        const msg = String((err && err.message) || err)
        // Host 的报错会列出它认识的全局工具名：用它把列表再收敛一次，
        // 这样即便某个构建改名了（bash→pwsh、write_file→write），也只丢那几个名字，不会整体失败。
        const known = /known global tools:\s*(.+)$/s.exec(msg)
        if (known) {
          const names = new Set(known[1].split(',').map((x) => x.trim()).filter(Boolean))
          const retry = deny.filter((n) => names.has(n))
          if (retry.length && retry.length !== deny.length) {
            try {
              dispose = tools.restrict({ deny: retry })
              used = retry
            } catch (err2) {
              return { ok: false, message: '收回写工具失败：' + String((err2 && err2.message) || err2) }
            }
          } else {
            return { ok: false, message: '收回写工具失败：' + msg }
          }
        } else {
          return { ok: false, message: '收回写工具失败：' + msg }
        }
      }
    } else {
      // 一个都没匹配上：要先分清是"这个视图本来就没有写工具"（只读天然成立）
      // 还是"有写工具但名字对不上"（那是 bug，必须拒绝进入，不能假装只读）。
      const visible = []
      if (tools && typeof tools.schemas === 'function') {
        try { for (const item of tools.schemas(scope) || []) if (item && item.name) visible.push(item.name) } catch { /* 忽略 */ }
      }
      const risky = visible.filter((name) => /^(write|edit|write_file|edit_file|replace|apply_patch|str_replace_editor|bash|pwsh|shell|exec)$/.test(name))
      if (risky.length) {
        return {
          ok: false,
          message: '这个会话有写工具（' + risky.join('、') + '），但没匹配上可收回的名字，为安全起见不进入调度模式。请把工具名补进 FLOW_DENY_TOOLS。',
        }
      }
      log('flow mode: view has no write tools, read-only is inherent for ' + sid)
    }
    const denyFinal = used
    modes.set(sid, { since: new Date().toISOString(), dispose, deny: denyFinal })
    log('flow mode on for ' + sid + ' (deny=' + denyFinal.join(',') + ')')
    const denyNote = denyFinal.length
      ? '已收回写工具：' + denyFinal.join('、')
      : '本会话视图里没有写工具，只读天然成立'
    return {
      ok: true,
      active: true,
      deny: denyFinal,
      message: '已进入调度模式：只思考与规划。' + denyNote + '。下一步：调用 skill(name=flow) 按它的判据拆任务，确认后 flow_publish 发布。',
    }
  }

  /** 退出模式并恢复工具集（dispose 幂等）。 */
  function exit(sessionId) {
    const sid = String(sessionId || '').trim()
    const rec = modes.get(sid)
    if (!rec) return { ok: true, message: '不在调度模式', active: false }
    modes.delete(sid)
    try {
      if (typeof rec.dispose === 'function') rec.dispose()
    } catch (err) {
      log('flow mode dispose failed: ' + ((err && err.message) || String(err)))
    }
    log('flow mode off for ' + sid)
    return { ok: true, message: '已退出调度模式，工具集已恢复。', active: false }
  }

  /** 释放所有模式（插件卸载时调用）。 */
  function disposeAll() {
    for (const sid of [...modes.keys()]) exit(sid)
  }

  return { enter, exit, isActive, activeSessions, disposeAll }
}

/**
 * 解析 `/flow` 的命令输入。
 * @returns { action: 'on'|'off'|'status'|'help', message?: string }
 */
export function parseFlowCommand(raw) {
  const text = String(raw || '').trim()
  if (!text) return { action: 'on' }
  const lower = text.toLowerCase()
  if (lower === 'off') return { action: 'off' }
  if (lower === 'status') return { action: 'status' }
  if (lower === 'help' || lower === '?') return { action: 'help' }
  return { action: 'on', message: text }
}

/**
 * 发布：把模式里的方案变成一张大 issue（任务）。
 * 校验必须在建卡之前做完，避免建出半张卡。
 * @returns { ok, taskId? , message }
 */
export function validatePublishInput(input) {
  const title = String((input && input.title) || '').trim()
  if (!title) return { ok: false, message: '发布需要标题' }
  const plan = String((input && input.plan) || '').trim()
  if (!plan) return { ok: false, message: '发布需要有内容（plan 不能为空）' }
  const acceptance = Array.isArray(input && input.acceptance) ? input.acceptance.filter((x) => String(x || '').trim()) : []
  const subtasks = Array.isArray(input && input.subtasks) ? input.subtasks : []
  for (const st of subtasks) {
    if (!String((st && st.title) || '').trim()) return { ok: false, message: '子任务缺少标题' }
  }
  return {
    ok: true,
    value: {
      title: title.slice(0, 120),
      plan: plan.slice(0, 8000),
      note: String((input && input.note) || '').slice(0, 4000),
      acceptance: acceptance.slice(0, 20),
      scope: input && input.scope ? input.scope : { paths: [], symbols: [] },
      subtasks: subtasks.slice(0, 50).map((st) => ({
        title: String(st.title || '').slice(0, 120),
        scope: st.scope || { paths: [], symbols: [] },
        status: 'todo',
      })),
    },
  }
}
