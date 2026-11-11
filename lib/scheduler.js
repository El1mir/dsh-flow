/**
 * dsh-flow · scheduler
 *
 * 定时 tick（设计文档 14.9 / 15.4 TX-22、TX-23）。每次 tick 按固定顺序做五件事：
 *   ① 卡死检测  ② 补位派工  ③ 自动验收  ④ 自动合并  ⑤ 拉远程 + 消费事件
 * 顺序不能反：先收尸再补位，先验收再合并，先落事实再消费。
 *
 * 所有步骤都吞异常并记进 report，tick 本身永不抛。
 */

/**
 * 合并 blocked 的**契约类**原因（C-01 同口径的副本）。
 *
 * 为什么要副本而不是 import：scheduler 拿不到 dispatch 的常量表（它只被注入 dispatcher），
 * 而 lib/merge-state.js 那张表管的是「怎么说给人听」。这个仓库对跨层常量的既有做法就是
 * 「各自声明 + 测试钉住」，所以这里写一份，并在 test/automation-guards.mjs 里锁住。
 *
 * 为什么是黑名单而不是环境类白名单：环境原因是**开放集合** —— blockMerge 会把
 * integration.ensure / mergeBranch / mergeInto 的 reason 原样记进 mergeReason（integ-dirty、
 * repo-dirty、wrong-branch、no-branch…）。白名单漏一个，那张卡就永远焊死在合并列。
 * 契约类是封闭小集合，写死更安全。
 */
const NL = String.fromCharCode(10)
const CONTRACT_MERGE_REASONS = new Set(['head-mismatch', 'not-merged'])

// v0.016（ticket 08）：空转检测要看「分支上有没有新提交」—— 这是最强、也最难伪造的进展信号。
import { headSha } from './git.js'
import { policyFor } from './remote-policy.js'
export function createScheduler({ domain, dispatcher, store, sync = null, engine = null, runtime = null, log = () => {}, now = () => Date.now() }) {
  const minutes = (ms) => Math.round(ms / 60000)

  function projectOf(task) { return store.state.projects[task.projectId] }

  function getFirstCfg() {
    for (const p of Object.values(store.state.projects)) if (p && p.config) return p.config
    return {}
  }

  /**
   * C-09：「自动车道」开关（issue → 建卡 → 交接给 issue 车道子调度）。
   *
   * 语义：
   *   autoLane === true   → 建卡（+ 默认隐藏，见 handleEvent 的 visibility）
   *   autoLane === false  → 不建卡（连镜像都可以不落）
   *   autoLane 未设置     → 回退 autoDispatch（存量项目全走这条）
   *   autoDispatch        → 只剩「running 列补位」（refill）+「自动推进」（advance）
   *
   * 为什么 advance 仍读 autoDispatch、不跟着换：票 C-09 的「不改什么」明确写着
   * 「不改 advanceStep 的行为」——把 advance 的闸门也收窄成 laneAutoOn，会让
   * autoLane:false / autoDispatch:true 的项目连既有的自动推进都停掉（那是行为回归，
   * 不是本票要的「不建卡」）。语义表里那句「autoDispatch 只保留补位」是目标态，
   * 落地到 advance 属于另一张票。
   *
   * ⚠️ 兼容口就在这一行：用 `=== undefined` 判缺失，不能用 `!cfg.autoLane` ——
   * 后者会把显式写的 false 当成「没设置」再回退到 autoDispatch，新开关就压不住旧开关。
   * 这条是本票唯一会让**线上存量项目停止建卡**的地方（老项目都没有 autoLane 字段），
   * 由 test/autolane.mjs 的「升级兼容」用例钉住。
   */
  function laneAutoOn(cfg) {
    const c = cfg || {}
    return c.autoLane === undefined ? c.autoDispatch === true : c.autoLane === true
  }

  /**
   * C-09 / D10：`since` 是「只接管配置之后出现的 issue」这条意图的**唯一实现位置**。
   *
   * lib/sync-engine.js 里那个 `createTask` 字段没有读者（grep 确认：全仓只有写入方），
   * 真正建卡在下面的 handleEvent，所以判据只能落在这。
   *
   * 取值的两个来源，按优先级：
   *   1. project.config.sync.since —— 人显式写的「从这个时刻开始接管」；
   *   2. remote_sync[projectId].since —— 首次开启远程时钉住的时刻（lib/sync.js
   *      ensureSyncState 的初值就是这个语义），存量项目都是这一个。
   *
   * 字符串比较的前提：GitHub 与 Gitea 都给 `2026-01-01T00:00:00Z` 这种 ISO 形状。
   * 若某天出现带时区偏移的（+08:00），比较会错 —— 那时要改成 Date.parse 比较。
   */
  function issueSince(project) {
    if (!project) return null
    const cfgSync = (project.config && project.config.sync) || null
    if (cfgSync && cfgSync.since) return String(cfgSync.since)
    try {
      const st = typeof domain.syncStateOf === 'function' ? domain.syncStateOf(project.id) : null
      if (st && st.since) return String(st.since)
    } catch { /* 同步状态读不到就当没有 since —— 宁建不丢 */ }
    return null
  }

  /** 往卡片讨论区写一条系统评论（dispatch 里同名函数的轻量版）。 */
  async function comment(taskId, content) {
    return domain.comment(taskId, content, { role: 'system', id: 'scheduler' }).catch(() => null)
  }

  /**
   * ⓪ 工作区对账：v1.4 起「工作区即项目」——DSH 里删掉工作区，对应项目要跟着消失。
   *
   * 只删「确实能确认工作区已经不在」的项目：registry 不可用就整步跳过，
   * 避免因为读不到清单而误删掉用户的数据。
   */
  async function reconcileWorkspaces(report) {
    if (!runtime || typeof runtime.listWorkspacePaths !== 'function') return
    let paths = null
    try { paths = await runtime.listWorkspacePaths() } catch { return }
    if (!Array.isArray(paths)) return
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const live = new Set(paths.map(norm))
    for (const project of Object.values(store.state.projects)) {
      if (!project.workspacePath) continue
      const p = norm(project.workspacePath)
      if (live.has(p)) continue
      // worktree 目录不是工作区，但它也不会被登记成项目——这里只处理真正的项目路径
      try {
        const r = await domain.removeProject(project.id, { role: 'system', id: 'workspace-sync' })
        report.droppedProjects.push({ projectId: project.id, name: project.name, removedTasks: r.removedTasks })
        log('workspace gone → project removed: ' + project.name + ' (' + project.workspacePath + ')')
      } catch (err) {
        log('reconcile drop failed ' + project.id + ': ' + (err && err.message ? err.message : err))
      }
    }
  }

  /** ① 卡死：心跳过期的 run 收掉并阻塞任务，等人或调度员接手。 */
  async function reapStuck(report) {
    for (const { run, overdueMs } of domain.stuckRuns(now())) {
      const task = store.state.tasks[run.taskId]
      if (!task || task.activeRunId !== run.id) continue
      try {
        await domain.emit('run.stuck', { taskId: run.taskId, runId: run.id, agentId: run.agentId, overdueMs })
        await domain.endRun(run.taskId, 'failed', { stopReason: '心跳超时 ' + minutes(overdueMs) + ' 分钟', runId: run.id })
        await domain.block(run.taskId, '工人心跳超时（' + minutes(overdueMs) + ' 分钟没动静）')
        if (run.agentId) await domain.setSessionState(run.agentId, 'idle', { role: 'system' }).catch(() => {})
        // v1.36：毒会话（连续 3 次卡死）→ 重建会话，别在同一个坏会话上反复撞
        const stuck = await domain.bumpStuck(run.taskId, '心跳超时 ' + minutes(overdueMs) + ' 分钟').catch(() => null)
        if (stuck && stuck.reset && run.agentId && runtime && typeof runtime.resetSession === 'function') {
          const project = store.state.projects[run.projectId]
          const reset = await runtime.resetSession(project, run.agentId).catch(() => null)
          if (reset && reset.ok) await comment(run.taskId, '连续 ' + stuck.count + ' 次卡死，已重建工人会话（' + (reset.sessionId || '-') + '）')
        } else if (stuck && stuck.poisoned) {
          await comment(run.taskId, '连续 ' + stuck.count + ' 次卡死，已达毒会话阈值（' + stuck.threshold + '）；自动重建未开启（poisonRebuild=false），会话保留。需要时在看板上手动重置。')
        }
        report.stuck.push({ taskId: run.taskId, overdueMs, stuck })
      } catch (err) {
        log('tick.stuck item failed ' + run.taskId + ': ' + (err && err.message ? err.message : err))
        report.stuck.push({ taskId: run.taskId, overdueMs, error: String((err && err.message) || err) })
      }
    }
  }

  /**
   * ①c 评审轮次卡死（v0.006）。
   *
   * 会话报错/被打断时会有 turn/end，`handleNoRunFailure` 能收到；但**进程崩溃、会话被归档、
   * DSH 换 provider 失败没发事件**这几种情况下，grill.status 会永远停在 running，
   * 而 grillStart 的守卫会把这张卡的评审永久锁死。这里按轮次时长兜底收尸。
   *
   * 阈值取 `grillStuckAfterMs`，没配就用 stuckAfterMs（默认 30 分钟）——
   * 评审一轮通常几分钟，30 分钟还没回信就已经不是慢了。
   */
  async function reapGrill(report) {
    report.grill = report.grill || []
    const nowMs = now()
    for (const task of Object.values(store.state.tasks)) {
      if (!task || !task.grill || task.grill.status !== 'running') continue
      const cfg = (projectOf(task) || {}).config || {}
      const after = Number(cfg.grillStuckAfterMs) > 0 ? Number(cfg.grillStuckAfterMs) : 30 * 60 * 1000
      const since = String(task.grill.roundStartedAt || task.grill.startedAt || '')
      const ms = since ? nowMs - Date.parse(since) : NaN
      if (!Number.isFinite(ms) || ms < after) continue
      const round = Number(task.grill.rounds || 0)
      const why = '评审超过 ' + minutes(ms) + ' 分钟没有回信（会话可能崩了或被归档）'
      await domain.setGrill(task.id, {
        status: 'failed',
        lastError: why,
        failedAt: new Date().toISOString(),
        failedRound: round,
        rounds: Math.max(0, round - 1),
      }, { role: 'system', id: 'system:grill' }).catch(() => null)
      await comment(task.id, '【评审超时】' + why + '。这一轮已标为失败，轮次退回。')
      const notified = await dispatcher.notifyDispatcher(store.state.tasks[task.id] || task, '评审超时没有回信', 'grill-failed', { dedupeSuffix: 'timeout:r' + round }).catch(() => null)
      report.grill.push({ taskId: task.id, round, overdueMs: ms, notified: !!(notified && notified.ok) })
    }
  }
  /**
   * ①b 僵尸 run 清理（v1.22 P5）。
   *
   * 与 ①a 的区别：卡死是"活着但没动静"，僵尸是"已经死了但行还写着 running"
   * （任务被重派/取消/恢复过，旧 run 只是没收尾）。后者不该走 block ——
   * 任务已经有新主人了，把它标成 interrupted 就行。
   */
  async function reapZombies(report) {
    for (const { run, reason } of domain.zombieRuns()) {
      try {
        await domain.markRunInterrupted(run.id, '已被后续派工取代（' + reason + '）')
        report.zombies.push({ runId: run.id, taskId: run.taskId, reason })
      } catch (err) {
        log('tick.zombies item failed ' + run.id + ': ' + (err && err.message ? err.message : err))
      }
    }
  }

  /**
   * ①c 超时 run（v1.22 P5，3 小时硬上限）。
   *
   * DSH 没有 abort API，掐不掉会话里的回合；能做的是"把这条 run 判死、任务收回重派"。
   * 旧回合若还活着，它之后的 stop 会带着旧 fencing 序号回来，被 endRun 直接拒掉。
   */
  async function reapOverrun(report) {
    for (const { run, overMs, limit } of domain.overrunRuns(now())) {
      const task = store.state.tasks[run.taskId]
      if (!task || task.activeRunId !== run.id) continue
      try {
        await domain.endRun(run.taskId, 'failed', { stopReason: '超过单次上限 ' + minutes(limit) + ' 分钟', runId: run.id })
        if (run.agentId) await domain.setSessionState(run.agentId, 'idle', { role: 'system' }).catch(() => {})
        // 归到基础设施类失败：超时不是这张卡的错，给 3 次机会
        const res = await domain.recordFailure(run.taskId, { kind: 'infra', reason: 'run 超时 ' + minutes(overMs) + ' 分钟' })
        // v1.36：超时也计入毒会话计数（超时和心跳超时是同一类「这个会话不干活」）
        const stuck = await domain.bumpStuck(run.taskId, 'run 超时 ' + minutes(overMs) + ' 分钟').catch(() => null)
        if (stuck && stuck.reset && run.agentId && runtime && typeof runtime.resetSession === 'function') {
          const project = store.state.projects[run.projectId]
          const reset = await runtime.resetSession(project, run.agentId).catch(() => null)
          if (reset && reset.ok) await comment(run.taskId, '连续 ' + stuck.count + ' 次超时，已重建工人会话（' + (reset.sessionId || '-') + '）')
        } else if (stuck && stuck.poisoned) {
          await comment(run.taskId, '连续 ' + stuck.count + ' 次超时，已达毒会话阈值（' + stuck.threshold + '）；自动重建未开启（poisonRebuild=false），会话保留。需要时在看板上手动重置。')
        }
        if (!res.retry) await domain.block(run.taskId, '单次执行超过 ' + minutes(limit) + ' 分钟，已停止重试', { role: 'system' })
        else await comment(run.taskId, '本次执行超时，' + Math.round(res.backoffMs / 1000) + ' 秒后重试（第 ' + res.tries + ' 次）')
        report.overrun.push({ taskId: run.taskId, runId: run.id, overMs, retry: res.retry })
      } catch (err) {
        log('tick.overrun item failed ' + run.taskId + ': ' + (err && err.message ? err.message : err))
      }
    }
  }

  /**
   * ①e 空转收回（v0.016 / ticket 08）。
   *
   * 心跳只证明进程活着，**不再算进展**：线上 65% 的「执行中」就是这个状态。
   * 30 分钟没有任何进展证据（新提交 / 进度更新 / 评论）→ 收回这一轮，
   * 保留工作区与现场，让调度重新判断 —— 而不是等 3 小时总上限。
   */
  /** 项目停摆告警（v0.016 / ticket 12）：还有待办、却连续几小时没有任何 run。 */
  async function alertStall(report) {
    const cfg = store.state.settings || {}
    const hours = Math.max(1, Number(cfg.stallHours) || 6)
    const limit = hours * 3600000
    for (const project of Object.values(store.state.projects || {})) {
      if (!project || project.enabled === false) continue
      const tasks = Object.values(store.state.tasks || {}).filter((t) => t && t.projectId === project.id
        && t.column !== 'done' && t.column !== 'cancelled')
      if (!tasks.length) continue
      const runs = Object.values(store.state.runs || {}).filter((r) => r && r.projectId === project.id)
      const lastAt = runs.reduce((acc, r) => Math.max(acc, Date.parse(r.startedAt || 0) || 0), 0)
      const base = lastAt || (Date.parse(project.createdAt || 0) || 0)
      const idle = now() - base
      if (idle < limit) continue
      // 同一停摆窗口只发一次：发过之后要等到有新 run（或已发时间早于最近一次 run）才再发。
      const notifiedAt = Date.parse(project.stallNotifiedAt || 0) || 0
      if (notifiedAt && notifiedAt >= base) continue
      const hrs = Math.round(idle / 3600000)
      await domain.askHuman({
        projectId: project.id,
        kind: 'info',
        topic: '项目已停摆 ' + hrs + ' 小时：还有 ' + tasks.length + ' 张卡没做完',
        body: ['最近一次 run 开始于 ' + (lastAt ? new Date(lastAt).toISOString() : '（从未有 run）') + '。', '', '看看是没人可派、被依赖焊住，还是调度自己停了。'].join(NL),
        dedupeRef: 'stall:' + base,
      }, { role: 'system', id: 'system:stall' }).catch(() => null)
      await store.tx((st) => { if (st.projects && st.projects[project.id]) st.projects[project.id].stallNotifiedAt = new Date(now()).toISOString() })
      report.stalled.push({ projectId: project.id, idleMs: idle, tasks: tasks.length })
    }
  }

  async function reapIdle(report) {
    const cfg = store.state.settings || {}
    const idleMs = Math.max(60000, Number(cfg.idleRunMs) || 30 * 60000)
    for (const run of Object.values(store.state.runs)) {
      if (!run || run.status !== 'running' || run.endedAt) continue
      const task = store.state.tasks[run.taskId]
      if (!task || task.activeRunId !== run.id) continue
      // 先看分支：有新提交就是真进展，直接推 lastProgressAt（不靠模型自述）。
      const wt = domain.worktreeOf(run.taskId)
      if (wt && wt.path) {
        const sha = await headSha(wt.path).catch(() => null)
        if (sha) {
          if (run.lastSeenSha !== sha) {
            await domain.markRunSeen(run.id, sha, 'commit').catch(() => null)
            continue
          }
        }
      }
      const last = Date.parse(run.lastProgressAt || run.startedAt || 0) || 0
      const idle = now() - last
      if (idle < idleMs) continue
      try {
        const idleMin = minutes(idle)
        await domain.endRun(run.taskId, 'failed', { stopReason: '空转 ' + idleMin + ' 分钟没有任何进展', runId: run.id })
        if (run.agentId) await domain.setSessionState(run.agentId, 'idle', { role: 'system' }).catch(() => null)
        await domain.recordFailure(run.taskId, { kind: 'infra', reason: '空转 ' + idleMin + ' 分钟没有任何进展' }).catch(() => null)
        // 卡还留在 running，但 activeRunId 已经清掉 —— 调度可以重新派工（换人或换方案）。
        await comment(run.taskId, '【空转收回】这一轮 ' + idleMin + ' 分钟没有任何进展（无新提交、无进度更新、无评论）。'
          + 'run 已收回，工作区与现场保留；重新派工前先看一眼是不是卡在同一个地方。')
        await dispatcher.notifyDispatcher(store.state.tasks[run.taskId] || task, '空转收回', 'idle-reclaimed', { runId: run.id }).catch(() => null)
        report.idle.push({ taskId: run.taskId, runId: run.id, idleMs: idle })
      } catch (err) {
        log('tick.idle item failed ' + run.taskId + ': ' + (err && err.message ? err.message : err))
      }
    }
  }

  /** ①d 退避到点的任务：清标记 → 重派（v1.22 P5 两套预算里的 infra 重试）。 */
  async function retryDue(report) {
    for (const task of domain.retryDue(now())) {
      const project = projectOf(task)
      if (!project) continue
      try {
        // v1.36：排队过期不再重派，停下来问人（否则一张坏卡能无限烧下去）
        if (task.expired) {
          await domain.clearRetry(task.id)
          await domain.block(task.id, '排队超时（等待 ' + Math.round((task.waitedMs || 0) / 3600000) + ' 小时），停止自动重试', { role: 'system', id: 'system:retry' })
          await domain.askHuman({
            taskId: task.id,
            kind: 'blocked',
            topic: '排队超时：' + task.id + ' ' + String(task.title || '').slice(0, 50),
            problem: '这张卡等待重试已超过 ' + Math.round((task.maxAge || 0) / 3600000) + ' 小时（最近原因：' + ((task.retryBudget && task.retryBudget.reason) || '未知') + '）。',
            decisionNeeded: '继续等、换人重派，还是取消？',
            where: task.id + ' · ' + task.column + '/' + (task.phase || '-'),
            suggestion: '先看失败原因是不是环境问题；环境修好后在看板上解除阻塞即可重新派工。',
          }, { role: 'system', id: 'system:retry' }).catch(() => null)
          report.retried.push({ taskId: task.id, ok: false, expired: true })
          continue
        }
        await domain.clearRetry(task.id)
        const res = await dispatcher.dispatch(store.state.tasks[task.id])
        report.retried.push({ taskId: task.id, ok: !!res.ok, message: res.message || null })
      } catch (err) {
        log('tick.retry item failed ' + task.id + ': ' + (err && err.message ? err.message : err))
      }
    }
  }

  /**
   * ③ 自动推进（v1.31）：把卡从 todo/planning 走到该去的地方。
   *
   * 这一步骤补的是一个**结构性缺口**，不是优化：
   *
   *   tick 原来的九个步骤里，没有一步覆盖 todo 和 planning 两列。
   *   autoDispatch=true 的真实语义只是「running 列自动补位」，
   *   从 todo 到 running 完全依赖调度员在一次会话里连调
   *   claim → plan_ready → approve 三个工具。
   *
   *   线上 T-042 / T-044 就是这样卡死的：调度员写了计划（rev1、rev2 都写了）、
   *   也知道要 claim（它在评论里明确写过「T-043 已 claim」），但只为 T-043 做了，
   *   另外两张永远停在 todo，且没有任何告警。
   *
   * 判据放在"卡在哪一列 + 计划到哪一步"，不放在"调度员记不记得"。
   *
   * 幂等：每卡每列一个 key，config.advanceIntervalMs（默认 60s）内只推一次；
   * 推到守卫拒绝就记 advanceBlocked 并停车，等人/调度清掉，绝不每拍重试。
   */
  async function advance(report) {
    const tasks = Object.values(store.state.tasks)

    for (const task of tasks) {
      const project = projectOf(task)
      if (!project) continue
      const cfg = project.config || {}
      // v1.35：推进窗口按卡所在项目取（原来 getCfgAny 取第一个项目的值套到所有项目上）
      const interval = Number(cfg.advanceIntervalMs) || 60 * 1000
      // autoDispatch 是总开关：关掉就是纯手动模式，推进也停。
      if (!cfg.autoDispatch) continue
      // 还挂着人没回的请示就先等着 —— 别在人正要拍板时抢跑。
      const openAsk = domain.openInboxFor(task.id).filter((x) => x.status === 'open')
      if (openAsk.length) continue

      const key = task.column + '/' + (task.phase || '')
      if (task.advanceBlocked) continue
      if (task.advanceKey === key && task.advanceAt) {
        const last = Date.parse(task.advanceAt) || 0
        if (now() - last < interval) continue
      }

      const step = await nextStep(task)
      // review_verdict_only 不是状态机动作：只写审核结论、卡片留在 merging，
      // 让 autoMerge 接着做真正的合并（review_approve 现在要求已有 mergedCommit）。
      // v1.35：只在「项目没有启用 block 级判据」时才走这条（见 nextStep）。
      if (step && step.action === 'review_verdict_only') {
        await domain.setReviewVerdict(task.id, 'approved', '项目没有启用 block 级审核判据，自动记录通过（待合并）', [],
          { role: 'dispatcher', id: 'system:advance' }).catch(() => null)
        await domain.markAdvance(task.id, task.column + '/' + (task.phase || ''))
        report.advanced.push({ taskId: task.id, action: 'review_verdict', to: 'merging', why: step.why })
        continue
      }
      // C-10：合并列缺 PR 快照时补开一张。
      // 与别的推进不同，这一步不 move 卡片、也不进请示箱：
      // git 层面的失败（脏工作区、分支在别的检出、远程 401）不是「卡片走错了」，
      // 人每次都要点一遍只会让请示箱变成噪音。用 prOpenFailedAt 退避 10 分钟重试。
      if (step && step.action === 'open_pr') {
        const snap = await (dispatcher.openPr
          ? dispatcher.openPr(task)
          : Promise.resolve({ ok: false, message: '宿主没有 openPr' })
        ).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
        if (snap && snap.ok === false) {
          await markField(task.id, 'prOpenFailedAt')
          log('advance.open_pr failed ' + task.id + ': ' + (snap.message || 'unknown'))
          report.advanceBlocked.push({ taskId: task.id, action: 'open_pr', reason: snap.message || 'unknown' })
        } else {
          await domain.markAdvance(task.id, task.column + '/' + (task.phase || ''))
          report.advanced.push({ taskId: task.id, action: 'open_pr', ok: true, why: step.why })
        }
        continue
      }
      // v1.35：有判据就请调度按判据审核，结论由它用 flow_pr_review 回（不再系统代写 approved）。
      if (step && step.action === 'request_review') {
        const res = dispatcher.requestReview
          ? await dispatcher.requestReview(task).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
          : { ok: false, message: '宿主没有 requestReview' }
        await markField(task.id, 'reviewRequestedAt')
        await domain.markAdvance(task.id, task.column + '/' + (task.phase || ''))
        report.advanced.push({ taskId: task.id, action: 'request_review', ok: !!res.ok, why: step.why })
        if (!res.ok) {
          await domain.askHuman({
            taskId: task.id,
            kind: 'blocked',
            topic: '审核请求没送到：' + task.id + ' ' + (task.title || '').slice(0, 60),
            problem: '合并前要按审核判据审核，但没能把审核包交给调度：' + (res.message || '未知原因'),
            decisionNeeded: '你来审（看板上点审核通过/驳回），还是先把调度恢复？',
            where: task.id + ' 在 merging · ' + (task.phase || ''),
            suggestion: '改动小的话直接在看板上点合并即可（人点合并视为人工审核通过）。',
          }, { role: 'system', id: 'system:advance' }).catch(() => null)
        }
        continue
      }
      // 高风险卡停在 waiting-approval 等人 —— 但「停在这里」和「通知到人」是两件事。
      // 不落请示的话，人只有主动翻看板才会发现它在等，等于静默卡住。
      if (!step && task.column === 'planning' && task.phase === 'waiting-approval') {
        const lvl = (task.risk && task.risk.level) || 'unknown'
        if (lvl === 'high' && !task.highRiskAskedAt) {
          await domain.askHuman({
            taskId: task.id,
            kind: 'risk',
            topic: '高风险方案等人批：' + task.id + ' ' + (task.title || '').slice(0, 60),
            problem: '预筛判高风险（' + (((task.risk && task.risk.reasons) || []).join('；') || '命中硬规则') + '），系统不会自动代批。',
            decisionNeeded: '批准这个方案开工，还是要求重写？',
            where: task.id + ' 在 planning · waiting-approval',
            suggestion: '看一遍 flow_task_detail 里的 plan 正文；没问题就回一句 批，有顾虑就说要改哪里。',
          }, { role: 'system', id: 'system:advance' }).catch(() => null)
          await markField(task.id, 'highRiskAskedAt')
        }
        continue
      }
      if (!step) continue
      try {
        const moved = await domain.move(task.id, step.action, { role: step.role, id: step.actor }, step.payload || {})
        await domain.markAdvance(task.id, task.column + '/' + (task.phase || ''))
        report.advanced.push({ taskId: task.id, action: step.action, to: moved && moved.column, why: step.why })
        if (step.after) await step.after(moved || task).catch(() => null)
      } catch (err) {
        const reason = String((err && err.message) || err)
        await domain.markAdvanceBlocked(task.id, reason).catch(() => null)
        report.advanceBlocked.push({ taskId: task.id, action: step.action, reason })
        // 推进不动 = 卡住了，这是**必须让人知道**的信号，落到请示箱。
        await domain.askHuman({
          taskId: task.id,
          kind: 'blocked',
          topic: '自动推进被拒：' + task.id + ' ' + (task.title || '').slice(0, 60),
          problem: '系统尝试执行 ' + step.action + ' 时被守卫拒绝：' + reason,
          decisionNeeded: '需要你确认这张卡该怎么走（改计划 / 补信息 / 直接取消）。',
          where: task.id + ' 在 ' + task.column + (task.phase ? ' · ' + task.phase : ''),
          suggestion: '如果是计划内容有问题，回一句该怎么改；如果这张卡本来就不该做，直接取消。',
        }, { role: 'system', id: 'system:advance' }).catch(() => null)
      }
    }
  }

  /**
   * 这张卡下一个该做的动作是什么？不动手，只判断。
   *
   * 返回 null = 不该自动推（要么该人等，要么该调度自己决定而不是系统代劳）。
   */
  async function nextStep(task) {
    const project = projectOf(task)
    const cfg = (project && project.config) || {}
    const planRev = (task.plan && task.plan.revision) || 0
    // 风险要自己算，不能指望"某个调用方记得算过"。
    // advance 的判据必须自足：plan 有了但风险没评估（直接 setPlan 绕过工具、
    // 或老数据从没算过），这里补一次并把结果落库。
    let risk = (task.risk && task.risk.level) || null
    if (planRev > 0 && !risk) {
      const assessed = await domain.assessPlanRiskOf(task.id).catch(() => null)
      risk = (assessed && assessed.level) || null
    }

    // ---- todo：认领 ----
    if (task.column === 'todo') {
      return {
        action: 'claim',
        role: 'dispatcher',
        actor: 'system:advance',
        why: planRev > 0 ? '已写好计划，认领进规划' : '新卡，认领进规划等写计划',
      }
    }

    // ---- planning：写计划 → 提交待批 → 批准 ----
    if (task.column === 'planning') {
      if (planRev === 0) {
        // 没计划：只提醒一次，不反复刷屏（调度员会收到通知去写）。
        if (task.planRemindedAt) return null
        await domain.comment(task.id, '等你写计划：调用 flow_task_plan 写入方案，之后系统会自动提交审批。').catch(() => null)
        await domain.markAdvance(task.id, 'planning/no-plan').catch(() => null)
        await markField(task.id, 'planRemindedAt')
        return null
      }
      if (task.phase !== 'waiting-approval') {
        return { action: 'plan_ready', role: 'dispatcher', actor: 'system:advance', why: '计划已就绪，提交待批' }
      }
      // waiting-approval：只拦 high，其余代批
      if (risk === 'high') return null   // 留给人
      if (cfg.autoApproveIssue !== true) return null
      const step = {
        action: 'approve_by_dispatcher',
        role: 'dispatcher',
        actor: 'system:advance',
        why: '预筛判 ' + (risk || 'medium') + '，自动代批开工',
      }
      // medium 的知情项：放行，但让人能看见"这方案写得比较笼统"
      if (risk === 'medium' && !task.mediumNoticedAt) {
        step.after = async () => {
          await markField(task.id, 'mediumNoticedAt')
          await domain.askHuman({
            taskId: task.id,
            kind: 'info',
            topic: '知情：' + task.id + ' 计划判 medium，已自动开工',
            problem: ((task.risk && (task.risk.reasons || []).join('；')) || '预筛判 medium'),
            decisionNeeded: '不需要动作。这只是一种留痕：方案判 medium（不致命，但写得比较笼统），系统已自动批准开工。',
            where: task.id + ' · ' + (task.title || ''),
            suggestion: '想拦住它就在这张卡上评论说明；不回复则继续执行。',
          }, { role: 'system', id: 'system:advance' }).catch(() => null)
        }
      }
      return step
    }

    // ---- merging：审核结论（不动卡片） ----
    //
    // v1.35：项目启用了 block 级判据 → 请调度审核（只请一次，结论由调度回）；
    // 没有判据可审 → 才由系统直接记 approved。
    //
    // v1.32：以前这里直接 review_approve，而 review_approve 会把卡推到 done/merged。
    // 但「审核通过」不等于「已合并」—— 那样会让卡片谎称合并完成，而 master 里什么都没有。
    // 现在只记结论（setReviewVerdict 不移动卡片），真合并交给下一步 autoMerge 做：
    //   autoMerge 看到 reviewVerdict==='approved' → dispatcher.merge() →
    //   markMerged 记 mergedCommit → review_approve → done/merged
    // C-10（D-surface §2.1）：进合并列就该有一张 PR 快照，不能等人去点按钮。
    // 现在开 PR 只有一个隐式入口 —— dispatch.afterMove 的 accept 分支（lib/dispatch.js:2144-2160）。
    // 于是 review_risk 留在 merging、repairUnmerged 退回 merging、人工 move 进来的卡都没有 PR，
    // 而下一步又要求 mergeRequest 存在才动作 → 卡停在那儿等一个没人点的按钮。
    // 这里只把「该开 PR 了」作为一步返回，真正的 git 动作仍归 dispatch.openPr。
    // 失败的退避用 prOpenFailedAt（10 分钟）：失败是环境问题，每 60 秒撞一次只会刷日志。
    // C-10：子卡没有对外交付面 —— 它不开 PR、不请审核、不进合并列。
    // 这三条守卫是纵深防御：正常路径上子卡 accept 就已离开（dispatch.afterUnitAccept），
    // 但迁移前的存量卡、或别的入口手推进来的卡仍可能停在 merging 里。
    // 让它们停在原地等人 - 比自动给子卡开一张 PR 干净得多（线上 T-049 就是这么来的）。
    // RT-06：外部 PR 卡的审核/合并不走本地 open_pr / 盲合。那条路会在没有判据时
    // 代写 approved，也会去改作者分支。外部卡只由 advanceExternal 处理。
    if (task.kind === 'external-pr') return null
    if (task.column === 'merging' && task.parentId) return null

    if (task.column === 'merging' && !task.mergeRequest) {
      const failedAt = Date.parse(task.prOpenFailedAt || '') || 0
      if (failedAt && now() - failedAt < 10 * 60 * 1000) return null
      return { action: 'open_pr', role: 'dispatcher', actor: 'system:advance', why: '合并列没有 PR 快照，补开一张' }
    }

    if (task.column === 'merging' && task.mergeRequest && cfg.autoMerge) {
      if (task.mergeRequest.reviewVerdict) return null
      const blocks = domain.reviewPromptSet(task.projectId).prompts.filter((p) => p.severity === 'block')
      if (blocks.length) {
        if (task.reviewRequestedAt) return null
        return { action: 'request_review', role: 'dispatcher', actor: 'system:advance', why: '按 ' + blocks.length + ' 条 block 级判据请调度审核' }
      }
      return {
        action: 'review_verdict_only',
        role: 'dispatcher',
        actor: 'system:advance',
        why: '没有 block 级判据，自动记录审核结论（真正合并由 autoMerge 执行）',
      }
    }

    return null
  }

  /** 给任务补一个时间戳字段（advance 内部去重用）。 */
  async function markField(taskId, field) {
    await store.tx((s) => { if (s.tasks[taskId]) s.tasks[taskId][field] = new Date(now()).toISOString() }).catch(() => null)
  }

  /**
   * ② 补位：执行中且没有 run 的任务，在并发上限内自动派工。
   *
   * C-10：phase='waiting-branch' 的**子卡**也在这里被捞起来 —— 筛选条件只看
   * 「在 running、没有 run」，不看 phase。它和 waiting-worker 同形：
   * 都是「卡在执行中、等一个外部条件」，下一拍重试而不是阻塞。
   * 谁抢到了父检出租约谁开工，抢不到的继续留在 waiting-branch（dispatch 自己判定）。
   */
  async function refill(report) {
    const tasks = Object.values(store.state.tasks).filter((t) => t.column === 'running' && !t.activeRunId)
    for (const task of tasks) {
      const project = projectOf(task)
      if (!project) continue
      const cfg = project.config || {}
      if (!cfg.autoDispatch) continue
      const inFlight = Object.values(store.state.runs).filter((r) => r.projectId === project.id && r.status === 'running').length
      const cap = Number(cfg.maxInFlightPerProject) || 3
      if (inFlight >= cap) break
      const res = await dispatcher.dispatch(task)
      report.dispatched.push({ taskId: task.id, ok: !!res.ok, message: res.message || null })
    }
  }

  /**
   * 验收分档（v0.016 / ticket 06）。
   *
   * 把 acceptance / acceptanceKinds / stopReport.acceptanceStatus 三列按下标对齐。
   * 缺档位的老卡一律按 auto 解释 —— 迁移只保证长度，不保证有人填过。
   */
  function acceptanceBuckets(task) {
    const items = Array.isArray(task.acceptance) ? task.acceptance : []
    const kinds = Array.isArray(task.acceptanceKinds) ? task.acceptanceKinds : []
    const raw = Array.isArray((task.stopReport || {}).acceptanceStatus) ? task.stopReport.acceptanceStatus : []
    const byIndex = new Map(raw.map((x) => [Number(x && x.index), x]))
    const buckets = { auto: [], env: [], human: [] }
    // 卡上没有 acceptance 文案、但停止报告交了 acceptanceStatus 时，也要逐项判：
    // 否则「只写了几条状态」的卡会被当成「没有验收项」直接收掉（v1.37 的用例钉的就是这个）。
    const statusMax = raw.reduce((acc, x) => Math.max(acc, Number(x && x.index) + 1 || 0), 0)
    const total = Math.max(items.length, statusMax)
    for (let i = 0; i < total; i += 1) {
      const kind = ['auto', 'env', 'human'].includes(kinds[i]) ? kinds[i] : 'auto'
      const row = byIndex.get(i) || {}
      buckets[kind].push({ index: i, text: String(items[i] || ''), status: row.status || 'missing-report', evidence: String(row.evidence || '') })
    }
    return buckets
  }

  /** ③ 自动验收：只有证据齐全的停止报告才自动过（autoAccept 默认关）。 */
  async function autoAccept(report) {
    for (const task of Object.values(store.state.tasks)) {
      if (task.column !== 'verifying') continue
      const cfg = (projectOf(task) || {}).config || {}
      if (!cfg.autoAccept) continue
      // v0.016（ticket 04）：部分完成的卡不进自动验收。
      // 自动验收的语义是「证据齐全就收」，而部分完成的事实是「还剩活没干」——
      // 自动收下等于替人做了「剩下的不做了」这个决定。留给人：收下（accept_partial）或拆后续卡。
      if (task.partial === true) {
        report.accepted.push({ taskId: task.id, ok: false, skipped: 'partial' })
        continue
      }
      // v0.016（ticket 06）：先分档再判断能不能收。
      // 自动验收的授权只覆盖「系统自己能验」的那类项；环境项没过是缺东西，不是活没干；
      // 人验项没过是人还没看 —— 两种情况都不该被系统当成「返工」。
      const buckets = acceptanceBuckets(task)
      const envMissing = buckets.env.filter((x) => x.status !== 'pass')
      const humanPending = buckets.human.filter((x) => x.status !== 'pass')
      const autoFail = buckets.auto.filter((x) => x.status !== 'pass')
      if (envMissing.length) {
        const moved = await domain.move(task.id, 'needs_env', { role: 'system', id: 'system:auto-accept' },
          { missing: envMissing.map((x) => x.text) }).catch((e) => ({ error: String(e.message || e) }))
        if (!moved.error) {
          await domain.askHuman({
            taskId: task.id,
            projectId: task.projectId,
            kind: 'blocked',
            topic: '缺环境，验收做不了：' + task.id + ' ' + String(task.title || '').slice(0, 50),
            problem: '这几项「需要环境」的验收没通过：' + envMissing.map((x) => x.text).join('；').slice(0, 600),
            decisionNeeded: '把缺的环境/凭据补上，然后让这张卡再跑一轮；或者确认这一项可以不做。',
            where: task.id + ' 在待验收（verifying · blocked-needs-env）',
            suggestion: '优先补环境：这通常是一行 .env 或一个本地服务，比再派一轮便宜得多。',
            current: '缺 ' + envMissing.length + ' 项环境',
            asks: [{
              key: 'env1',
              question: '缺的环境是哪些？补好之后回一句，我就重新派工。',
              why: '这些项只能由你提供（凭据/服务地址/数据），工人拿不到。',
              type: 'text',
              default: envMissing.map((x) => x.text).join('；').slice(0, 200),
              required: true,
            }],
          }, { role: 'system', id: 'system:auto-accept' }).catch(() => null)
        }
        report.accepted.push({ taskId: task.id, ok: false, skipped: 'needs-env', missing: envMissing.length })
        continue
      }
      if (humanPending.length) {
        const existingInbox = domain.openInboxFor(task.id).find((x) => x.kind === 'decision')
        if (!existingInbox) {
          await domain.askHuman({
            taskId: task.id,
            projectId: task.projectId,
            kind: 'decision',
            topic: '需要你亲自验的一项：' + task.id + ' ' + String(task.title || '').slice(0, 50),
            problem: '这些验收项只能由人确认：' + humanPending.map((x) => x.text).join('；').slice(0, 600),
            decisionNeeded: '确认它们是否通过；通过就收，不通过就说清差在哪。',
            where: task.id + ' 在待验收（verifying）',
            suggestion: '看完回一句「收」或「不通过：原因」，我会照着处理。',
            asks: [{ key: 'h1', question: '这几项算通过吗？', why: '「需要人」这一档只有你能判。', type: 'confirm', default: 'true', required: true }],
          }, { role: 'system', id: 'system:auto-accept' }).catch(() => null)
        }
        report.accepted.push({ taskId: task.id, ok: false, skipped: 'human-acceptance' })
        continue
      }

      const r = task.stopReport || {}
      const structured = buckets.auto.length > 0
      const autoMissing = buckets.auto.filter((x) => x.status === 'pass' && !x.evidence.trim())
      const issue = autoFail.some((x) => x.status === 'fail') ? 'failed'
        : autoFail.some((x) => x.status === 'not-run') ? 'not-run'
          : autoFail.length || autoMissing.length || !r.summary || (!structured && !r.tests) ? 'missing-report' : null
      const testsText = String(r.tests || '')
      const noEvidence = issue || (!structured && /未执行|没跑|无法执行|not run|skipped/i.test(testsText))
      if (r.blocked !== true && noEvidence && dispatcher.notifyDispatcher) {
        const notified = await dispatcher.notifyDispatcher(task, '验收证据待核查', 'acceptance-evidence', {
          dedupeSuffix: JSON.stringify([r, task.acceptance, task.acceptanceKinds, task.worktree]),
          message: '验收分类：' + (issue || 'not-run') + '。先读完整证据链并核对当前 HEAD；信任已有有效证明，只自行运行缺失且可负担的检查。命令已证明通过时只补报告；环境未变化不要重跑。仅缺环境、权限、需人验或真实决策时请示。',
        }).catch(() => ({ ok: false }))
        if (notified && notified.ok) {
          report.accepted.push({ taskId: task.id, ok: false, skipped: issue || 'not-run' })
          continue
        }
      }
      if (r.blocked === true || noEvidence) {
        // v1.37：同卡同类已有未归档工单就不再新建（askHuman 内部也去重，此处是提前的快路径）
        const existingInbox = domain.openInboxFor(task.id).find((x) => x.kind === 'decision')
        if (existingInbox) {
          report.accepted.push({ taskId: task.id, ok: false, skipped: 'inbox-open' })
          continue
        }
        await domain.askHuman({
          taskId: task.id,
          kind: 'decision',
          topic: '验收证据不足，等你决定：' + task.id + ' ' + (task.title || '').slice(0, 60),
          problem: (r.blocked === true ? '工人报告本轮被阻塞。' : '')
            + '测试证据：' + testsText.slice(0, 300),
          decisionNeeded: '这张卡能不能算完成？要么让它补跑测试，要么你确认按现状收。',
          where: task.id + ' 在待验收（verifying · awaiting-acceptance）',
          suggestion: '不确定就回一句"补测试"；改动没问题就回"收"。',
        }, { role: 'system', id: 'system:auto-accept' }).catch(() => null)
        report.accepted.push({ taskId: task.id, ok: false, skipped: 'evidence' })
        continue
      }

      // v1.31：身份从"假冒 human"改成 dispatcher + 显式系统凭据。
      // 原来写 role:'human' id:'auto-accept' 是绕过 v1.28 的 acceptedBy 守卫，
      // 结果是审批记录里查不出"这是机器收的"。现在用 dispatcher 身份走同一道哨，
      // 凭据 system:advance 与人的 human:web 在数据上是两种可区分的东西。
      const res = await domain.move(task.id, 'accept',
        { role: 'dispatcher', id: 'system:auto-accept' },
        { acceptedBy: 'system:advance', auto: true }
      ).catch((e) => ({ error: String(e.message || e) }))
      report.accepted.push({ taskId: task.id, ok: !res.error, error: res.error || null })
      // rf-02：需要合并的卡不能被自动验收直接落到 done。状态机靠 needsMerge 决定 to，
      // 现在恰好是对的；这条守卫的价值是让「哪天 needsMerge 出错」在日志里可见，而不是静默假完成。
      // 只记日志、不回滚移动 —— 回滚会让状态机出现「已 move 又退回」的脏历史。
      const after = store.state.tasks[task.id]
      if (!res.error && after && after.column === 'done' && after.phase === 'done-no-merge'
          && task.mergeState !== 'none' && task.mergeState !== 'blocked') {
        log('auto-accept 越过了合并列：' + task.id + '（mergeState=' + String(task.mergeState) + '），这不该发生')
      }
    }
  }

  /** ④ 自动合并：审核已通过的合并请求（autoMerge 默认关）。 */
  async function autoMerge(report) {
    // 外部 PR 不进这条通用合并：它要 approval + 两开关，由 advanceExternal 调 dispatch.merge。
    // v1.35：排过队的先合（queuedAt 升序），其余按进列时间
    const order = (t) => String((t.mergeRequest && t.mergeRequest.queuedAt) || '~' + (t.columnAt || ''))
    // C-04：只合「值得再试一次」的卡。
    //
    // 三档：
    //   ready / pending / undefined（schema 12 老卡）→ 合；
    //   blocked 且原因是**环境类** → 退避后还能再试（人把环境修好，系统自己接着做）；
    //   blocked 且原因是**契约类**（head-mismatch / not-merged）→ 永不在自动通道上重试；
    //   none → 没有可合的东西，别推。
    //
    // 退避是必须的：环境没修好时每 15 秒撞一次 git 会刷 attempts、刷评论、让一轮巡检看起来一直在动。
    const mergeable = (t) => {
      if (t.mergeState === 'ready' || t.mergeState === 'pending' || t.mergeState === undefined) return true
      if (t.mergeState !== 'blocked') return false
      if (CONTRACT_MERGE_REASONS.has(t.mergeReason)) return false
      const last = Date.parse(t.mergeRetryAt || '') || 0
      return !last || now() - last >= 10 * 60 * 1000
    }
    const candidates = Object.values(store.state.tasks)
      .filter((t) => t.column === 'merging' && mergeable(t))
      .sort((a, b) => order(a).localeCompare(order(b)))
    for (const task of candidates) {
      if (task.kind === 'external-pr') continue
      if (task.column !== 'merging') continue
      const cfg = (projectOf(task) || {}).config || {}
      if (!cfg.autoMerge) continue
      const mr = task.mergeRequest || {}
      if (mr.status === 'merged') continue
      if (mr.reviewVerdict !== 'approved') continue
      const res = await dispatcher.merge(task).catch((e) => ({ ok: false, message: String(e.message || e) }))
      report.merged.push({ taskId: task.id, ok: !!res.ok, conflict: !!res.conflict, message: res.message || null })
      // 失败就记一个退避时间：环境类 blocked 由自动通道自己恢复，但别每拍都撞（见 mergeable）。
      if (!res.ok) await markField(task.id, 'mergeRetryAt')
    }
  }

  /**
   * ⑤ 远程：拉 + 推 + 消费事件。
   *
   * v1.22 起走 sync-engine：它自己做项目级节流（60s）、熔断、pending 对账，
   * 并把「入站 + 出站」的结果攒成**一个事务**交给 domain.applySyncResults。
   * 老入口 sync({domain, project}) 保留给测试与外部一次性拉取（flow_issue_sync 工具）。
   */
  async function syncAndConsume(report) {
    if (engine) {
      try {
        const res = await engine.tick()
        for (const item of res.synced || []) report.synced.push(item)
        // v0.005：PR 结束的事实由同步层收集，收口由这里按车道决定（同步层不推状态机）。
        await closeoutEnded(res.ended || [], report)
      } catch (err) {
        log('tick.sync failed: ' + ((err && err.message) || err))
      }
    } else if (sync) {
      for (const project of Object.values(store.state.projects)) {
        const cfg = project.config || {}
        const remote = cfg.remote
        // v1.21：原来写的是 `!remote.enabled`，但 lib/setup.js 写 remote 时从来不含 enabled 字段
        // （只有 {kind,baseUrl,owner,repo,token,useGhCli}），于是这里每 tick 都 continue，
        // issue 永远同步不进来——只有「初始化仓库」时那一次性的 syncProject 能拉。
        // 现在把 enabled 当可选关闭开关（没写 = 开启），并用 recordIssues + owner/repo 判定能不能同步。
        if (!remote || remote.enabled === false) continue
        if (!remote.owner || !remote.repo) continue
        // C-02：issue 入站与外部 PR 入站是两个开关。只开 recordPulls 的项目也要被排进 tick，
        // 否则那个人最想要的「接别人的 PR」永远跑不起来（runProject 内部再按车道分流）。
        if (!cfg.recordIssues && !cfg.recordPulls) continue
        const res = await sync({ domain, project }).catch((e) => ({ ok: false, reason: String(e.message || e) }))
        report.synced.push({ projectId: project.id, ok: !!res.ok, pulled: res.pulled || 0, reason: res.reason || null })
      }
    }
    const events = domain.pendingEvents(50)
    const done = []
    for (const env of events) {
      try {
        await handleEvent(env, report)
        done.push(env.id)
      } catch (err) {
        log('event failed ' + env.id + ': ' + (err.message || err))
      }
    }
    if (done.length) await domain.consume(done)
    report.consumed = done.length
  }

  /**
   * 把「远程 PR 结束」的事实逐条交给 dispatcher 收口，并把结果记进巡检报告。
   *
   * 失败一条不影响下一条：一张卡收不了口不该让整轮同步作废。
   */
  async function closeoutEnded(ended, report) {
    if (!ended || !ended.length || !dispatcher.closeoutRemote) return
    report.remoteEnded = report.remoteEnded || []
    for (const f of ended) {
      const res = await dispatcher.closeoutRemote(f).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
      report.remoteEnded.push({ taskId: f.taskId, number: f.number, merged: !!f.merged, ok: !!(res && res.ok), already: !!(res && res.already), what: (res && (res.merged ? 'merged' : res.closed ? 'closed' : res.reason)) || null })
    }
  }

  async function handleEvent(env, report) {
    const p = env.payload || {}
    const project = Object.values(store.state.projects).find((x) => x.id === p.projectId)
    if (!project) return
    const cfg = project.config || {}

    // 远程 issue 本地没有 → 建卡（v1.0：走 event.ingestIssueEvent，落 issue 车道 + originRef 幂等）
    //
    // C-09：闸门从 autoDispatch 换成 laneAutoOn(cfg)（未写 autoLane 的老项目回退 autoDispatch）。
    if (env.refKind === 'issue' && policyFor(project).canIngestIssues && laneAutoOn(cfg)) {
      const mirror = domain.mirrorList(project.id).find((m) => m.remoteId === p.remoteId)
      if (mirror && !mirror.taskId) {
        // C-09 / D10：since 之前出现的 issue 只落镜像、不建卡。
        //
        // 为什么判在这里而不是 sync-engine：那里拉回来的 issue 是"镜像 + 事件"，两条路
        // （轮询镜像 / webhook 直达）都在下面这一个建卡点收口，只有这里知道"要不要建卡"。
        //
        // 没有 createdAt 时**放行** —— 极老的 issue / 某些 Gitea 版本不给这个字段，
        // 宁多建一张卡（人能取消），也不要让本该接管的卡静默不建（没人会知道它丢了）。
        //
        // webhook 路径显式豁免：lib/http.js 在 webhook 信封上打 `live: true`
        // （webhook 是「刚发生的事」，天然 fresh；给它加 since 会让新 issue 也进不来）。
        // 不用「信封里没有 createdAt」来碰运气 —— 那是实现细节，不是契约。
        const since = issueSince(project)
        const createdAt = String(p.createdAt || p.created_at || '')
        const fresh = p.live === true || !since || !createdAt || createdAt >= since
        if (fresh) {
          const { ingestIssueEvent } = await import('./event.js')
          // RT-06：可见性由 event.js 固定为 auto。showAutoCards 不参与写入。
          const res = await ingestIssueEvent(
            domain,
            { ...env, payload: { ...p, projectId: project.id } },
            { project },
          )
          if (res.created) {
            await domain.linkMirror(project.id, p.remoteId, res.taskId)
            report.ingested += 1
            report.issueLane.push({ taskId: res.taskId, handedOff: !!res.handedOff })
          } else if (res.reason === 'duplicate') {
            report.issueLane.push({ taskId: res.taskId, duplicate: true })
          }
        } else {
          // 只落镜像：结构化记一笔，界面上能看出"这条历史 issue 被 since 挡住了"。
          report.issueLane.push({ remoteId: p.remoteId, skipped: 'before-since', since, createdAt })
        }
      }
    }

    // 远程 PR 的结束事件（合并 / 被关）→ 统一走 closeoutRemote 按车道收口（v0.005）。
    // 旧版这里只处理 merged，而且把所有卡都当成同一个样子（自动车道的卡会一直挂在合并列）。
    // 现在只把**事实**交给收口，车道差异由 dispatcher 决定；重复收口靠 already 幂等。
    if (env.refKind === 'pull' && p.branch && p.branch.startsWith('flow/')) {
      const ended = p.merged || String(p.state || '') === 'closed'
      if (ended) {
        const taskId = p.branch.slice(5)
        if (store.state.tasks[taskId]) {
          await closeoutEnded([{
            taskId,
            number: p.number || null,
            merged: !!p.merged,
            state: p.state || null,
            mergeCommitSha: p.mergeCommitSha || null,
            headSha: p.headSha || null,
            url: p.url || null,
            source: 'local',
          }], report)
          report.ingested += 1
        }
      }
    }  }

  /**
   * ⓪.5 副作用收敛（v1.35，设计文档 §3 的 L3）：
   * 迁移提交了、副作用没跑成（进程崩溃 / 抛错）的意图在这里重试；超过上限转 dead 并通知人。
   */
  async function drainEffects(report) {
    for (const e of domain.pendingEffects(now())) {
      if (domain.halted()) break
      const res = await domain.runEffect(e.id).catch((err) => ({ status: 'failed', lastError: String((err && err.message) || err) }))
      report.effects.push({ effectId: e.id, taskId: e.taskId, action: e.action, status: res && res.status })
      if (res && res.status === 'dead') {
        await domain.askHuman({
          taskId: e.taskId,
          kind: 'blocked',
          topic: '迁移后的动作反复失败：' + e.taskId + ' · ' + e.action,
          problem: '「' + e.action + '」之后的系统动作重试 ' + res.attempts + ' 次都失败：' + (res.lastError || '未知'),
          decisionNeeded: '要人处理：修好环境后重新推进这张卡，或者改走别的路径。',
          where: e.taskId + ' · effects ' + e.id,
          suggestion: '看卡上的评论与 run 记录；会话/工位问题先在工位面板重置会话。',
        }, { role: 'system', id: 'system:effects' }).catch(() => null)
      }
    }
  }

  /**
   * 4.6 worktree GC (v1.36): terminal or expired worktrees.
   * Dirty ones get quarantined, clean ones removed, then prune metadata. Default every 6h.
   */
  async function gcWorktrees(report) {
    if (!dispatcher.gcWorktrees) return
    const cfg = getFirstCfg()
    const interval = Number(cfg.worktreeGcIntervalMs) || 6 * 3600 * 1000
    const last = store.state.maintenance && store.state.maintenance.lastWorktreeGcAt
    if (last && now() - (Date.parse(last) || 0) < interval) return
    const res = await dispatcher.gcWorktrees({ ttlMs: Number(cfg.worktreeTtlMs) || undefined, now: now() })
    await store.tx((s) => { s.maintenance = { ...(s.maintenance || {}), lastWorktreeGcAt: new Date(now()).toISOString() } }).catch(() => null)
    for (const x of res.removed || []) report.worktrees.push({ taskId: x.taskId, result: 'removed', why: x.why })
    for (const x of res.quarantined || []) report.worktrees.push({ taskId: x.taskId, result: 'quarantined', path: x.path })
    // I-08：跳过与失败必须出现在报告里。沉默的失败等于没有回收 ——
    // 幽灵正是"删失败但没人知道"积累出来的。
    for (const x of res.skippedLocked || []) report.worktrees.push({ taskId: x.taskId, result: 'skipped-locked', path: x.path })
    for (const x of res.failed || []) report.worktrees.push({ taskId: x.taskId, result: 'failed', why: x.reason })
    for (const x of res.quarantinePurged || []) report.worktrees.push({ taskId: null, result: 'quarantine-purged', path: x.path })
  }

  /**
   * 4.8 检出对账（ADR-0006 §2 / I-10）：tick 这一路**只读**，只记录漂移，不动仓库。
   *
   * 为什么 tick 不许动手：tick 每 15 秒跑一次，而建检出的窗口（add → 写登记）是秒级的。
   * 让 tick 有机会删东西，就等于让一个高频、无人值守的循环去判断"这个目录是不是垃圾"——
   * 判错的代价是工人正在干的活消失。真正的清理放在启动重活与派工/合并后的精确路径上。
   */
  async function reconcileWorktreesTick(report) {
    if (!dispatcher.reconcileWorktrees) return
    const cfg = getFirstCfg()
    const interval = Number(cfg.worktreeReconcileIntervalMs) || Number(cfg.worktreeGcIntervalMs) || 6 * 3600 * 1000
    const last = store.state.maintenance && store.state.maintenance.lastWorktreeReconcileAt
    if (last && now() - (Date.parse(last) || 0) < interval) return
    const res = await dispatcher.reconcileWorktrees({ dryRun: true, now: now() }).catch(() => null)
    if (!res || !res.ok) return
    await store.tx((s) => {
      s.maintenance = {
        ...(s.maintenance || {}),
        lastWorktreeReconcileAt: new Date(now()).toISOString(),
        // 漂移结论落库：UI 与人都能读到"现在有哪些不一致"，不必去翻日志。
        worktreeDrift: { at: res.at, actions: (res.actions || []).slice(0, 50), skipped: (res.skipped || []).slice(0, 50) },
      }
    }).catch(() => null)
    for (const x of res.actions || []) report.worktrees.push({ taskId: x.taskId || null, result: 'drift', kind: x.kind, path: x.path })
  }

  /** 4.5 merge intent reconcile (v1.35)：合并在 git 与记账之间中断的卡，去 git 里核实后收口。 */
  async function reconcileMerges(report) {
    if (!dispatcher.reconcileMergeIntents) return
    const res = await dispatcher.reconcileMergeIntents({ now: now() })
    for (const item of res || []) report.reconciled.push(item)
  }

  async function patchExternal(taskId, patch) {
    return store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task) return null
      task.external = { ...(task.external || {}), ...patch }
      task.updatedAt = new Date(now()).toISOString()
      return task.external
    })
  }

  function externalHead(task) {
    return String((task.external && task.external.headSha) || '')
  }

  async function openExternalTicket(task, reason) {
    const number = task.external && task.external.number
    await domain.askHuman({
      taskId: task.id,
      kind: 'blocked',
      category: 'external-pr',
      topic: '外部 PR ' + (number || task.id) + ' 不能自动合并',
      problem: '自动审核没有通过，原因：' + reason,
      decisionNeeded: '人来决定这张外部 PR 卡怎么处理。工单不会移动卡，也不会合并。',
      refs: [{ kind: 'task', id: task.id, label: task.title || task.id }],
      asks: [{
        key: 'next',
        question: '这张外部 PR 怎么处理？',
        why: '自动路径停了，系统不能盲合，也不能改作者分支。',
        type: 'choice',
        choices: [
          { value: 'hold', label: '先停着' },
          { value: 'human', label: '改由人审' },
        ],
        default: 'hold',
        required: true,
      }],
    }, { role: 'system', id: 'system:external-auto' }).catch(() => null)
  }

  async function blockExternal(task, reason) {
    await domain.setMergeState(task.id, { state: 'blocked', reason }, { role: 'system', id: 'system:external-auto' }).catch(() => null)
    await openExternalTicket(task, reason)
    await patchExternal(task.id, { handledSha: externalHead(task), approvalHandledAt: new Date(now()).toISOString() })
  }

  /** RT-06：autoAccept 关时，issue 车道的待验收卡开验收工单。工单不移动卡。 */
  async function acceptanceTickets() {
    for (const task of Object.values(store.state.tasks)) {
      if (!task || task.lane !== 'issue') continue
      const cfg = (projectOf(task) || {}).config || {}
      if (cfg.autoAccept) continue
      if (cfg.acceptanceTickets === false) continue
      const open = (store.state.human_inbox || []).filter((x) => x.taskId === task.id && x.category === 'acceptance' && x.status === 'open')
      if (task.column === 'merging' || task.column === 'done') {
        for (const item of open) {
          await domain.resolveInbox(item.id, { note: '验收已通过，归档' }, { role: 'system', id: 'system:acceptance' }).catch(() => null)
        }
        continue
      }
      if (task.column !== 'verifying' && task.column !== 'running') continue
      if (task.column === 'running' && !open.length) continue
      await domain.askHuman({
        taskId: task.id,
        kind: 'decision',
        category: 'acceptance',
        topic: '卡 ' + task.id + ' 待验收',
        problem: '这张卡需要人验收。自动验收是关的，工单只展示选项，不会移动卡。',
        decisionNeeded: '收下还是打回？选择只用于展示，真正的移动仍走看板上的验收动作。',
        refs: [{ kind: 'task', id: task.id, label: task.title || task.id }],
        asks: [{
          key: 'decision',
          question: '这张卡怎么处理？',
          why: '自动验收关闭，收下或打回只能由人决定。',
          type: 'choice',
          choices: [
            { value: 'accept', label: '收下' },
            { value: 'rework', label: '打回' },
          ],
          default: 'accept',
          required: true,
        }],
      }, { role: 'system', id: 'system:acceptance' }).catch(() => null)
    }
  }

  /**
   * RT-06：每拍扫 kind=external-pr。
   * 自动审核只在 externalPr.autoMerge && autoMerge 且 lane=issue、approval 仍 pending 时发生。
   * 调度只调 dispatch.merge / requestReview / closeoutRemote，不直接 git，不改作者分支。
   */
  async function advanceExternal() {
    for (const task of Object.values(store.state.tasks)) {
      if (!task || task.kind !== 'external-pr') continue
      if (task.column === 'done' || task.column === 'cancelled') continue
      const project = projectOf(task)
      if (!project) continue
      const ext = task.external || {}
      const head = externalHead(task)
      const approval = (ext.approval && ext.approval.status) || 'pending'

      if (ext.state === 'closed' || approval === 'closed') {
        if (ext.closeoutHandledAt || !dispatcher.closeoutRemote) continue
        await dispatcher.closeoutRemote({
          taskId: task.id,
          projectId: task.projectId,
          number: ext.number || null,
          merged: false,
          closed: true,
        }).catch(() => null)
        await patchExternal(task.id, { closeoutHandledAt: new Date(now()).toISOString() })
        continue
      }

      if (approval === 'rejected') {
        if (ext.rejectHandledAt) continue
        await domain.move(task.id, 'remote_ended', { role: 'system', id: 'system:external-rejection' }).catch(() => null)
        await patchExternal(task.id, { rejectHandledAt: new Date(now()).toISOString() })
        continue
      }

      const policy = policyFor(project)
      const auto = task.lane === 'issue' && policy.canAutoMergeExternal

      if (approval === 'approved' && !auto) {
        if (ext.approvalHandledAt) continue
        if (dispatcher.requestReview) {
          await dispatcher.requestReview(task).catch(() => null)
        }
        await patchExternal(task.id, { approvalHandledAt: new Date(now()).toISOString(), handledSha: head })
        continue
      }

      if (!auto) continue
      if (task.mergeState === 'blocked' && ext.handledSha === head && ['no-review-prompts', 'no-reviewer', 'external-review-rejected', 'head-mismatch'].includes(task.mergeReason)) {
        continue
      }

      const prompts = (domain.reviewPromptSet(task.projectId).prompts || []).filter((p) => p && p.severity === 'block')
      if (!prompts.length) {
        await blockExternal(task, 'no-review-prompts')
        continue
      }
      if (typeof dispatcher.reviewExternal !== 'function') {
        await blockExternal(task, 'no-reviewer')
        continue
      }

      let verdict = ext.reviewVerdict || null
      if (ext.reviewedSha !== head) {
        const reviewed = await dispatcher.reviewExternal(task).catch((err) => ({ verdict: null, error: String((err && err.message) || err) }))
        verdict = reviewed && reviewed.verdict ? reviewed.verdict : null
        await patchExternal(task.id, { reviewedSha: head, reviewVerdict: verdict })
        if (!verdict) {
          await blockExternal(task, 'no-reviewer')
          continue
        }
      }

      if (ext.mergeIssuedSha && ext.mergeIssuedSha !== head) {
        await blockExternal(task, 'head-mismatch')
        continue
      }
      if (verdict !== 'approved') {
        await blockExternal(task, 'external-review-rejected')
        continue
      }

      if (approval !== 'approved') {
        const approved = await domain.approveExternal(task.id, { decision: 'approved', by: 'system:auto-pr', note: '自动审核通过' }, { role: 'system', id: 'system:auto-pr' }).catch((err) => ({ error: String((err && err.message) || err) }))
        if (approved && approved.error) {
          await blockExternal(task, 'no-reviewer')
          continue
        }
        await domain.setReviewVerdict(task.id, 'approved', '外部 PR 自动审核通过', [], { role: 'system', id: 'system:auto-pr' }).catch(() => null)
      }

      if (ext.mergeIssuedSha === head) continue
      if (ext.mergeRetried && ext.mergeAttemptSha === head) {
        await blockExternal(task, 'unknown')
        continue
      }
      const merged = dispatcher.merge
        ? await dispatcher.merge(store.state.tasks[task.id]).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
        : { ok: false, reason: 'no-merge' }
      if (merged && merged.ok) {
        await patchExternal(task.id, { mergeIssuedSha: head, handledSha: head, approvalHandledAt: new Date(now()).toISOString() })
        continue
      }
      const why = String((merged && (merged.reason || merged.message)) || 'unknown')
      if (/server|unknown/i.test(why) && ext.mergeAttemptSha !== head) {
        await patchExternal(task.id, { mergeAttemptSha: head, mergeRetried: false })
        continue
      }
      if (/server|unknown/i.test(why) && !ext.mergeRetried) {
        await patchExternal(task.id, { mergeRetried: true, mergeAttemptSha: head })
        continue
      }
      await blockExternal(task, /conflict|protection|head/i.test(why) ? why : why)
    }
  }

  async function tick() {
    // v1.37：budget[] 保留在 report 结构里（兼容看板读取），但不再填充。
    const report = { at: new Date(now()).toISOString(), stuck: [], zombies: [], overrun: [], idle: [], retried: [], dispatched: [], accepted: [], merged: [], synced: [], ingested: 0, consumed: 0, budget: [], issueLane: [], droppedProjects: [], advanced: [], advanceBlocked: [], effects: [], reconciled: [], worktrees: [], stalled: [] }
    // 一键停止期间整轮不跑：不是只停"派新活"，而是连收尸、重试、自动验收、
    // 自动合并、远程同步一起停 —— 这些都会写状态、都会唤起别人，停一半等于没停。
    // 注意顺序：判在 report 之后，调用方仍拿得到 at（日志里能看出"这一拍被跳过了"）。
    if (domain.halted()) return { ...report, halted: true }
    const step = async (name, fn) => {
      try { await fn(report) } catch (err) { log('tick.' + name + ' failed: ' + (err && err.message ? err.message : err)) }
    }
    await step('workspaces', reconcileWorkspaces)
    await step('stuck', reapStuck)
    await step('grill', reapGrill)
    await step('zombies', reapZombies)
    await step('overrun', reapOverrun)
    // 空转收回排在超时之后、退避重派之前：先把「没干活的」收掉，再看谁能被重派。
    await step('idle', reapIdle)
    // 停摆告警放在补位之后：先派工，实在派不动才报。
    await step('stall', alertStall)
    await step('effects', drainEffects)
    // v1.37：移除 budget 巡检步骤（DSH 自己管理上下文压缩）
    await step('retry', retryDue)
    await step('advance', advance)
    await step('refill', refill)
    await step('accept', autoAccept)
    await step('acceptance', acceptanceTickets)
    await step('reconcile-merge', reconcileMerges)
    await step('worktree-gc', gcWorktrees)
    // tick 的只读对账放在 gc 之后：gc 已经做过"清残留锁 + 到期清理"，
    // 这里记录的是清理之后仍然存在的漂移。
    await step('worktree-drift', reconcileWorktreesTick)
    await step('external', advanceExternal)
    await step('merge', autoMerge)
    await step('sync', syncAndConsume)
    // rf-04：自动车道的留痕。自动卡不上看板，所以「这一轮自动做了什么」必须在能看见的地方留一份 ——
    // 否则隐藏就从降噪变成了失明。这里只做结构化汇总 + 一行日志；界面读的是 report.autoLane。
    report.autoLane = summarizeAutoLane(report)
    if (report.autoLane.accepted || report.autoLane.merged || report.autoLane.failed) {
      log('auto-lane: 验收 ' + report.autoLane.accepted + ' · 合并 ' + report.autoLane.merged
        + (report.autoLane.failed ? ' · 失败 ' + report.autoLane.failed + '（' + report.autoLane.failedIds.join('、') + '）' : ''))
    }
    return report
  }

  /**
   * 把这一轮里落在可见性='auto' 的卡上的自动动作分桶（rf-04）。
   *
   * 为什么在 tick 末尾统一算、而不是在 autoAccept/autoMerge 里各记一次：
   * 那两个函数只知道自己做了动作，不知道「这张卡是不是自动车道的」；在这里查一次 store 最省。
   * 失败的判定：ok === false 且不是 skipped（skipped 是「本轮没做」，不是「做坏了」）。
   */
  function summarizeAutoLane(report) {
    const isAuto = (taskId) => {
      const t = store.state.tasks[taskId]
      return !!t && t.visibility === 'auto'
    }
    const failedIds = []
    let accepted = 0
    let merged = 0
    for (const x of report.accepted || []) {
      if (!isAuto(x.taskId)) continue
      if (x.ok) accepted += 1
      else if (!x.skipped) failedIds.push(x.taskId)
    }
    for (const x of report.merged || []) {
      if (!isAuto(x.taskId)) continue
      if (x.ok) merged += 1
      else failedIds.push(x.taskId)
    }
    return { accepted, merged, failed: failedIds.length, failedIds }
  }

  /** 起一个定时器；返回 stop()。间隔取项目里最小的 dispatchIntervalMs。 */
  function start({ intervalMs = 15000 } = {}) {
    let running = false
    let timer = null
    const run = async () => {
      if (running) return
      running = true
      try { await tick() } finally { running = false }
    }
    timer = setInterval(run, Math.max(1000, Number(intervalMs) || 15000))
    if (timer && typeof timer.unref === 'function') timer.unref()
    return {
      stop() { if (timer) clearInterval(timer); timer = null },
      run,
      tick,
    }
  }

  return { tick, start }
}
