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
 * 合并失败里「修好环境就能重试」的那几类（C-04）。
 *
 * 与 `lib/merge-state.js` 的 MERGE_REASON 是同一个枚举的两个视角：那边管**文案**，这边管**要不要再试**。
 * 为什么会有一份副本：scheduler 拿不到 DOMAIN 常量表（它只注入 domain/dispatcher），
 * 而 client.js 也内联了一份同样的文案表 —— 这个仓库对「跨层共享常量」的选择就是「各自声明 + 测试逐键比对」。
 * 加新原因时三处一起改：merge-state.js / client.js / 这里。
 */
const RETRYABLE_MERGE_REASONS = new Set(['out-of-scope-dirty', 'base-missing', 'base-busy', 'branch-busy', 'worktree-missing', 'push-failed', 'install-failed', 'merge-failed'])

export function createScheduler({ domain, dispatcher, store, sync = null, engine = null, runtime = null, log = () => {}, now = () => Date.now() }) {
  const minutes = (ms) => Math.round(ms / 60000)

  function projectOf(task) { return store.state.projects[task.projectId] }

  function getFirstCfg() {
    for (const p of Object.values(store.state.projects)) if (p && p.config) return p.config
    return {}
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

  /** ② 补位：执行中且没有 run 的任务，在并发上限内自动派工。 */
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

  /** ③ 自动验收：只有证据齐全的停止报告才自动过（autoAccept 默认关）。 */
  async function autoAccept(report) {
    for (const task of Object.values(store.state.tasks)) {
      if (task.column !== 'verifying') continue
      const cfg = (projectOf(task) || {}).config || {}
      if (!cfg.autoAccept) continue
      const r = task.stopReport || {}
      if (!r.summary || !r.tests) continue

      // v1.31：证据不足不自动收。
      // 自动验收的前提是"报告给了能核对的东西"，不是"报告字段有值"。
      // 工人写「未执行」也算诚实，但那种情况必须人看一眼 —— 否则等于鼓励
      // 不跑测试也能过（这条已经写进内置提示词要求工人如实写）。
      const testsText = String(r.tests || '')
      // v1.37：逐项验收状态里只要有 not-run / partial / fail，就不能自动收
      const acc = Array.isArray(r.acceptanceStatus) ? r.acceptanceStatus : []
      const accIncomplete = acc.some((x) => x && x.status !== 'pass')
      const noEvidence = accIncomplete || /未执行|没跑|无法执行|not run|skipped/i.test(testsText)
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
      if (!RETRYABLE_MERGE_REASONS.has(t.mergeReason)) return false
      const last = Date.parse(t.mergeRetryAt || '') || 0
      return !last || now() - last >= 10 * 60 * 1000
    }
    const candidates = Object.values(store.state.tasks)
      .filter((t) => t.column === 'merging' && mergeable(t))
      .sort((a, b) => order(a).localeCompare(order(b)))
    for (const task of candidates) {
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

  async function handleEvent(env, report) {
    const p = env.payload || {}
    const project = Object.values(store.state.projects).find((x) => x.id === p.projectId)
    if (!project) return
    const cfg = project.config || {}

    // 远程 issue 本地没有 → 建卡（v1.0：走 event.ingestIssueEvent，落 issue 车道 + originRef 幂等）
    if (env.refKind === 'issue' && cfg.autoDispatch) {
      const mirror = domain.mirrorList(project.id).find((m) => m.remoteId === p.remoteId)
      if (mirror && !mirror.taskId) {
        const { ingestIssueEvent } = await import('./event.js')
        const res = await ingestIssueEvent(domain, { ...env, payload: { ...p, projectId: project.id } }, { project })
        if (res.created) {
          await domain.linkMirror(project.id, p.remoteId, res.taskId)
          report.ingested += 1
          report.issueLane.push({ taskId: res.taskId, handedOff: !!res.handedOff })
        } else if (res.reason === 'duplicate') {
          report.issueLane.push({ taskId: res.taskId, duplicate: true })
        }
      }
    }

    // 远程 PR 已合并且分支是 flow/<taskId> → 本地跟着合并
    if (env.refKind === 'pull' && p.merged && p.branch && p.branch.startsWith('flow/')) {
      const taskId = p.branch.slice(5)
      const task = store.state.tasks[taskId]
      if (task && (!task.mergeRequest || task.mergeRequest.status !== 'merged')) {
        // v1.35：带上远程给的真实提交号；没有提交号就不冒充合并完成，交给人。
        const commit = p.mergeCommitSha || p.headSha || null
        await domain.markMerged(taskId, { commit, strategy: 'remote', mergeCommit: p.mergeCommitSha || null }).catch(() => null)
        if (task.column === 'merging') {
          if (commit) {
            await domain.setReviewVerdict(taskId, 'approved', '远程已合并（人在远程仓库合的）', [], { role: 'human', id: 'remote' })
            await domain.move(taskId, 'review_approve', { role: 'dispatcher', id: 'remote' }).catch((err) => log('remote merge close failed ' + taskId + ': ' + ((err && err.message) || err)))
          } else {
            await domain.askHuman({
              taskId, kind: 'decision',
              topic: '远程 PR 已合并但没有提交号：' + taskId,
              problem: '远程事件说 PR 已合并，但没带 merge_commit_sha / head sha，无法证明合并落地。',
              decisionNeeded: '确认合并后在看板上手动收口（跳过合并或修复记录）。',
              where: taskId + ' 在 merging', suggestion: '去远程仓库看一眼合并提交，再在卡上修复。',
            }, { role: 'system', id: 'system:remote' }).catch(() => null)
          }
        }
        await dispatcher.removeWorktree(store.state.tasks[taskId]).catch(() => null)
        report.ingested += 1
      }
    }
  }

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

  async function tick() {
    // v1.37：budget[] 保留在 report 结构里（兼容看板读取），但不再填充。
    const report = { at: new Date(now()).toISOString(), stuck: [], zombies: [], overrun: [], retried: [], dispatched: [], accepted: [], merged: [], synced: [], ingested: 0, consumed: 0, budget: [], issueLane: [], droppedProjects: [], advanced: [], advanceBlocked: [], effects: [], reconciled: [], worktrees: [] }
    // 一键停止期间整轮不跑：不是只停"派新活"，而是连收尸、重试、自动验收、
    // 自动合并、远程同步一起停 —— 这些都会写状态、都会唤起别人，停一半等于没停。
    // 注意顺序：判在 report 之后，调用方仍拿得到 at（日志里能看出"这一拍被跳过了"）。
    if (domain.halted()) return { ...report, halted: true }
    const step = async (name, fn) => {
      try { await fn(report) } catch (err) { log('tick.' + name + ' failed: ' + (err && err.message ? err.message : err)) }
    }
    await step('workspaces', reconcileWorkspaces)
    await step('stuck', reapStuck)
    await step('zombies', reapZombies)
    await step('overrun', reapOverrun)
    await step('effects', drainEffects)
    // v1.37：移除 budget 巡检步骤（DSH 自己管理上下文压缩）
    await step('retry', retryDue)
    await step('advance', advance)
    await step('refill', refill)
    await step('accept', autoAccept)
    await step('reconcile-merge', reconcileMerges)
    await step('worktree-gc', gcWorktrees)
    // tick 的只读对账放在 gc 之后：gc 已经做过"清残留锁 + 到期清理"，
    // 这里记录的是清理之后仍然存在的漂移。
    await step('worktree-drift', reconcileWorktreesTick)
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
