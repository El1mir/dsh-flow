/**
 * dsh-flow · sync-engine
 *
 * 项目级双向同步的**编排层**：负责「这一轮该拉什么、该推什么、失败怎么退」，
 * 但真正的写入全部交给 `domain.applySyncResults`（一个事务落完）。
 *
 * 三条铁律（都是踩过的坑换来的）：
 *   1. 网络请求全在事务外 —— state 15MB，一个请求一个 tx 会把全量序列化跑几十遍；
 *   2. 出站先落 pending 再 POST —— 否则「POST 成功、落盘失败」会在重启后重复建 issue；
 *   3. 一切入站内容先过 marker 判定 —— 自己推上去的东西绝不能被当成外部输入再吃一遍。
 */

import {
  listIssues, listComments, createRemoteIssue, createComment,
  addIssueLabel, removeIssueLabel, listLabels, createLabel, getPull, listPullReviews, listCheckRuns,
  patchIssue, withToken,
} from './remote.js'
import {
  pickOutbound, taskToIssuePayload, desiredLabels, diffLabels, hasFlowMarker, markerNonce,
  newNonce, scrubOutbound, LABEL_COLORS,
} from './sync.js'

const HOUR = 60 * 60 * 1000
/** 同一项目两次同步的最小间隔（tick 是 15s，但 API 不能每 15s 打一次）。 */
export const SYNC_INTERVAL_MS = 60 * 1000

/**
 * v1.35：远程 PR 是否在等评审。
 * 有 reviewDecision（GraphQL / Gitea 扩展）就直接用；否则按 REST 能拿到的事实推导：
 * 还有被请求的评审人，且每个人最新一次评审都不是 APPROVED。
 */
export function pullReviewPending(facts = {}, reviews = []) {
  if (facts.merged) return false
  if (facts.reviewDecision) return String(facts.reviewDecision) === 'REVIEW_REQUIRED'
  const requested = Array.isArray(facts.requestedReviewers) ? facts.requestedReviewers : []
  if (!requested.length) return false
  const latest = new Map()
  for (const r of Array.isArray(reviews) ? reviews : []) if (r && r.login) latest.set(r.login, r.state)
  return requested.some((login) => latest.get(login) !== 'APPROVED')
}

export function createSyncEngine({
  domain, store, dispatcher = null, runtime = null, log = () => {}, fetchImpl = null,
  now = () => Date.now(),
  // v1.27：token 解析器。默认用 gh CLI（gh auth token），测试可注入假 token。
  // 需要注入点是因为 gh CLI 是一次真实子进程调用，单测里不能真去 spawn；
  // 而“请求到底带没带 Authorization”正是这次事故的核心断言，必须可测。
  tokenResolver = null,
} = {}) {
  const state = () => store.state

  function projectOf(projectId) {
    return state().projects[projectId] || null
  }

  function remoteOf(project) {
    const cfg = (project && project.config) || {}
    const remote = cfg.remote
    if (!remote || remote.enabled === false) return null
    if (!remote.owner || !remote.repo) return null
    if (!cfg.recordIssues) return null
    return remote
  }

  function syncOf(projectId) {
    return (state().remote_sync || {})[projectId] || null
  }

  /**
   * v1.27：带 token 的 remote，按项目缓存。
   *
   * 事故：所有网络函数都直接拿 cfg.remote，而它通常没有 token（用户靠 gh CLI 登录）。
   * GitHub 对匿名请求只给 60 次/小时，于是每 5 分钟撞一次 403 熔断，
   * 同步器一直在跑、一条评论也没推上去（本地 24 条 vs 远端 1 条）。
   *
   * 为什么缓存：gh CLI 是子进程调用（几十毫秒），tick 每 15s 一次，不能每次都 spawn。
   * TTL 10 分钟——token 失效时最坏多失败 10 分钟，比每次同步都 spawn 一次划算。
   */
  const remoteCache = new Map()
  const REMOTE_TTL_MS = 10 * 60 * 1000
  async function remoteFor(project) {
    const base = remoteOf(project)
    if (!base) return null
    if (base.token) return base            // 显式 token 优先，不用走缓存
    const hit = remoteCache.get(project.id)
    if (hit && now() - hit.at < REMOTE_TTL_MS) return hit.remote
    let resolved = base
    try {
      // 解析器契约：返回 token 字符串、或带 token 的 remote、或空。
      // 三种都收：默认实现（withToken）返回 remote，而注入方通常只给一个字符串。
      const got = tokenResolver ? await tokenResolver(base) : await withToken(base)
      if (typeof got === 'string' && got.trim()) resolved = { ...base, token: got.trim() }
      else if (got && got.token) resolved = got
    } catch (err) {
      log('token resolve failed: ' + ((err && err.message) || err))
    }
    if (!resolved.token) {
      // 解析不出 token 就别缓存：下次也许 gh 刚登录完
      log('sync ' + ((project && project.name) || project.id) + ' 没有 token（gh CLI 未登录？）—— 匿名请求会很快撞限流')
    }
    remoteCache.set(project.id, { remote: resolved, at: now() })
    return resolved
  }

  /**
   * 熔断判定：401（token 废了）压 30 分钟，403/429（限流）压 5 分钟。
   * 熔断期一个请求都不发 —— 这是「不把配额打穿」的唯一硬保证。
   */
  function circuitOpen(projectId) {
    const s = syncOf(projectId)
    if (!s || !s.circuitUntil) return false
    return Date.parse(s.circuitUntil) > now()
  }

  // -------------------------------------------------------------------------
  // 入站
  // -------------------------------------------------------------------------

  /**
   * 拉一轮。返回 { results, notices }，不落盘。
   *
   * 建卡条件：issue 的 created_at 必须晚于 `sync.since`（用户明确要求「配置之后出现的」才同步）。
   * 更早的 issue 只进 mirror（成了事实与 URL 的索引），绝不建卡 —— 否则一开双向就把历史
   * 几百个 issue 全搬进看板。
   */
  async function pullProject(project) {
    const remote = await remoteFor(project)
    if (!remote) return { ok: false, reason: '未配置远程或未开启记录' }
    const sync = syncOf(project.id) || {}
    const since = sync.since || null
    const results = { inbound: { issues: [], comments: [] }, cursors: {}, notices: [] }

    const issues = await listIssues({ remote, since: sync.issueCursor || null, fetchImpl })
    if (!issues.ok) return { ok: false, status: issues.status || 0, reason: issues.reason || 'list-issues-failed', results }
    for (const item of issues.items || []) {
      if (hasFlowMarker(item.body)) continue               // 自己推上去的，跳过
      const mirror = domain.mirrorList(project.id).find((m) => m.remoteId === item.remoteId)
      const createdAt = item.createdAt || null
      const fresh = !mirror && (!since || !createdAt || createdAt >= since)
      results.inbound.issues.push({ ...item, source: remote.kind || 'github', createTask: fresh })
    }
    if (issues.cursor) results.cursors.issueCursor = issues.cursor

    const comments = await listComments({ remote, since: sync.commentCursor || null, fetchImpl })
    if (comments.ok) {
      for (const c of comments.items || []) {
        if (!c.issueNumber) continue
        if (hasFlowMarker(c.body)) continue                // 自己推的评论
        results.inbound.comments.push(c)
      }
      if (comments.cursor) results.cursors.commentCursor = comments.cursor
    } else if (comments.status === 401 || comments.status === 403 || comments.status === 429) {
      return { ok: false, status: comments.status, reason: comments.reason, results }
    }

    return { ok: true, results }
  }

  /**
   * PR 回读 + 六类唤醒里我们保留的三类（v1.22 P6，用户要求③）。
   *
   * 只回读**本地开着的 PR**（有 remote.number），不做全仓库 PR 扫描：
   * 这个系统的真相在本地，远程 PR 只是"人在仓库里看得见的窗口"。
   *
   * 合并事件（merged）不驱动状态机 —— 远程关了 PR 不等于本地验收通过；
   * 它只落事件 + 一条系统评论，让人自己决定要不要跟进。
   *
   * 唤醒都带 6 小时去重：同一个事实每 60s 重新看见一次，不去重就是刷屏。
   */
  const WAKE_TTL_MS = 6 * 60 * 60 * 1000

  function wakeDue(projectId, key) {
    const at = domain.wakeAt(projectId, key)
    if (!at) return true
    const ts = Date.parse(at)
    return !Number.isFinite(ts) || now() - ts >= WAKE_TTL_MS
  }

  async function refreshPulls(project) {
    const remote = await remoteFor(project)
    if (!remote) return { ok: true, pulls: [], wakes: [], comments: [], notify: [] }
    const repo = (state().pull_requests) || {}
    const local = Object.values(repo).filter((pr) => pr.projectId === project.id && pr.remote && pr.remote.number)
    const out = { ok: true, pulls: [], wakes: [], comments: [], notify: [] }
    const cfg = project.config || {}

    for (const pr of local) {
      const number = Number(pr.remote.number)
      if (!number) continue
      const facts = await getPull({ remote, number, fetchImpl })
      if (!facts.ok) {
        if (facts.status === 401 || facts.status === 403 || facts.status === 429) return { ...out, ok: false, status: facts.status, reason: facts.reason }
        continue
      }
      let reviews = []
      const rv = await listPullReviews({ remote, number, fetchImpl })
      if (rv.ok) reviews = rv.items || []
      out.pulls.push({
        prId: pr.id, taskId: pr.taskId, number,
        url: facts.url, state: facts.state, merged: facts.merged,
        mergedAt: facts.mergedAt, mergedBy: facts.mergedBy,
        mergeCommitSha: facts.mergeCommitSha, mergeableState: facts.mergeableState,
        reviews,
      })

      const task = state().tasks[pr.taskId]
      if (!task) continue

      // ① PR 有冲突：本地合并才是权威，这里只叫调度员，不自动改状态机
      const dirty = facts.mergeableState === 'dirty' || facts.merged !== true && facts.mergeable === false
      if (dirty && !facts.merged) {
        const key = 'pr_unmergeable:' + task.id
        if (wakeDue(project.id, key)) {
          out.wakes.push({ key, at: new Date(now()).toISOString() })
          out.comments.push({ taskId: task.id, body: '远程 PR #' + number + ' 有合并冲突（mergeable_state=' + (facts.mergeableState || 'unknown') + '）。本地合并仍是权威，需要人工确认怎么合。' })
          out.notify.push({ taskId: task.id, message: '远程 PR #' + number + ' 冲突', kind: 'pr_unmergeable' })
        }
      }

      // ② 等评审：审查状态卡在 REVIEW_REQUIRED 说明人在等别人点头
      // v1.35：REST 不给 reviewDecision，按「有被请求的评审人、且最新评审里没有 APPROVED」推导
      const pendingReview = pullReviewPending(facts, reviews)
      if (pendingReview && !facts.merged) {
        const key = 'pr_review_pending:' + task.id
        if (wakeDue(project.id, key)) {
          out.wakes.push({ key, at: new Date(now()).toISOString() })
          out.notify.push({ taskId: task.id, message: '远程 PR #' + number + ' 等待评审', kind: 'pr_review_pending' })
        }
      }

      // ③ 远程已合并：保留事件，不驱动状态机
      if (facts.merged && !(pr.remote && pr.remote.merged)) {
        out.comments.push({ taskId: task.id, body: '远程 PR #' + number + ' 已合并（' + (facts.mergedBy || '-') + '，commit ' + String(facts.mergeCommitSha || '-') + '）。本地状态不自动跟随，是否需要收尾由人决定。' })
        out.wakes.push({ key: 'pr_merged:' + task.id, at: new Date(now()).toISOString() })
      }

      // ④ CI 红（默认关，只有项目显式开 wakeOnCiFailed 才查 —— check-runs 是最贵的一次调用）
      if (cfg.wakeOnCiFailed && facts.headSha) {
        const key = 'ci_failed:' + task.id
        if (wakeDue(project.id, key)) {
          const ci = await listCheckRuns({ remote, sha: facts.headSha, fetchImpl })
          if (ci.ok && ci.total > 0 && ci.completed === ci.total && ci.failed > 0) {
            out.wakes.push({ key, at: new Date(now()).toISOString() })
            out.comments.push({ taskId: task.id, body: '远程 CI 在 ' + String(facts.headSha).slice(0, 8) + ' 上失败（' + ci.failed + '/' + ci.total + '）。' })
            out.notify.push({ taskId: task.id, message: 'CI 失败 ' + ci.failed + '/' + ci.total, kind: 'ci_failed' })
          }
        }
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // 出站
  // -------------------------------------------------------------------------

  /** 调一次 ensure 标签：受管标签在仓库里必须先存在（否则 POST labels 会 422）。 */
  async function ensureManagedLabels(remote, wanted) {
    const has = await listLabels({ remote, fetchImpl })
    if (!has.ok) return { ok: false, reason: has.reason }
    const missing = wanted.filter((n) => !has.names.includes(n))
    for (const name of missing) {
      const r = await createLabel({ remote, name, color: LABEL_COLORS[name] || 'ededed', description: 'dsh-flow 受管标签', fetchImpl })
      if (!r.ok && r.status !== 422) return { ok: false, reason: r.reason || 'create-label-failed' }
    }
    return { ok: true }
  }

  /**
   * 推一轮。返回 results（含 outbound / pendingAdd / pendingDone），不落盘。
   *
   * pending 的处理分两段：写 pending 由调用方在本次 POST **之前**单独落一次盘
   * （`markPending`），POST 完的回收结果并进这里的结果对象。
   */
  async function pushProject(project) {
    const remote = await remoteFor(project)
    const cfg = (project && project.config) || {}
    if (!remote) return { ok: false, reason: '未配置远程' }
    if (!cfg.pushRemote) return { ok: true, skipped: 'push-off', results: emptyResults() }

    const results = emptyResults()
    const plan = pickOutbound(state(), project.id)
    const pending = (syncOf(project.id) || {}).outbound || []

    // ① 建卡：本地新建 → 远程 issue
    const created = []
    for (const entry of plan.tasks) {
      const task = state().tasks[entry.taskId]
      if (!task) continue
      if (pending.some((p) => p.kind === 'task' && p.taskId === task.id)) continue
      const nonce = newNonce()
      results.pendingAdd.push({ kind: 'task', id: task.id, taskId: task.id, nonce })
      results.outbound.push({ __pending: nonce })
      created.push({ task, nonce })
    }

    for (const { task, nonce } of created) {
      const payload = taskToIssuePayload(task, project)
      const body = scrubOutbound(payload.body) + '\n\n' + markerOf('task', task.id, nonce)
      const res = await createRemoteIssue({ remote, title: payload.title, body, fetchImpl })
      if (!res.ok) {
        results.errors.push({ kind: 'task', taskId: task.id, status: res.status || 0, reason: res.reason })
        continue
      }
      results.outbound = results.outbound.filter((x) => x.__pending !== nonce)
      results.outbound.push({
        taskId: task.id, issueNumber: Number(res.remoteId), url: res.url,
        source: remote.kind || 'github', labels: desiredLabels(task),
      })
      results.pendingDone.push(nonce)
      // 拿到 issue 号后立刻补齐受管标签，人一眼能看出这张卡在执行流水线的哪一段
      await ensureManagedLabels(remote, desiredLabels(task))
      for (const label of desiredLabels(task)) {
        await addIssueLabel({ remote, issueNumber: Number(res.remoteId), label, fetchImpl })
      }
    }

    // ② 已推过的卡：标签漂移就修（只动受管标签）
    for (const task of Object.values(state().tasks)) {
      if (!task || task.projectId !== project.id) continue
      if (!task.remote || !task.remote.issueNumber) continue
      const want = desiredLabels(task)
      const diff = diffLabels((task.remote && task.remote.labels) || [], want)
      if (!diff.add.length && !diff.remove.length) continue
      await ensureManagedLabels(remote, want)
      for (const label of diff.add) await addIssueLabel({ remote, issueNumber: task.remote.issueNumber, label, fetchImpl })
      for (const label of diff.remove) await removeIssueLabel({ remote, issueNumber: task.remote.issueNumber, label, fetchImpl })
      results.labelSync.push({ taskId: task.id, add: diff.add, remove: diff.remove, labels: want })
    }

    // ③ 评论：本地新评论 → 远程 issue 评论
    for (const entry of plan.comments) {
      const c = (state().task_comments || []).find((x) => x.id === entry.commentId)
      const task = state().tasks[entry.taskId]
      if (!c || !task || !task.remote || !task.remote.issueNumber) continue
      if (pending.some((p) => p.kind === 'comment' && p.commentId === c.id)) continue
      const nonce = newNonce()
      results.pendingAdd.push({ kind: 'comment', id: c.id, taskId: task.id, commentId: c.id, nonce })
      const body = scrubOutbound(String(c.content || '')) + '\n\n' + markerOf('comment', c.id, nonce)
      const res = await createComment({ remote, issueNumber: task.remote.issueNumber, body, fetchImpl })
      if (!res.ok) {
        results.errors.push({ kind: 'comment', commentId: c.id, status: res.status || 0, reason: res.reason })
        continue
      }
      results.outboundComments.push({ commentId: c.id, remoteCommentId: res.commentId, url: res.url, login: null })
      results.pendingDone.push(nonce)
    }

    results.outbound = results.outbound.filter((x) => !x.__pending)
    return { ok: true, results }
  }

  /**
   * 出站分两段（v1.22 的关键顺序保证）。
   *
   * 第一段 `planPush`：只算「该推什么」，把 pending（带 nonce）**先落盘**；
   * 第二段 `postPush`：才真的发 POST，成功后把身份与 pendingDone 交回。
   *
   * 顺序反了会怎样：POST 成功、进程在落盘前被杀 → 重启后本地没有 remote id，
   * 下一次 push 会把同一张卡再建一个 issue。先落 pending 就能让重启对账认领回来。
   */
  async function planPush(project) {
    const remote = await remoteFor(project)
    const cfg = (project && project.config) || {}
    if (!remote) return { ok: false, reason: '未配置远程' }
    if (!cfg.pushRemote) return { ok: true, skipped: 'push-off', plan: { tasks: [], comments: [] } }
    const plan = pickOutbound(state(), project.id)
    const pending = (syncOf(project.id) || {}).outbound || []
    const pendingAdd = []
    const tasks = []
    for (const entry of plan.tasks) {
      const task = state().tasks[entry.taskId]
      if (!task) continue
      if (pending.some((p) => p.kind === 'task' && p.taskId === task.id)) continue
      if (pendingAdd.some((p) => p.kind === 'task' && p.taskId === task.id)) continue
      const nonce = newNonce()
      pendingAdd.push({ kind: 'task', id: task.id, taskId: task.id, nonce })
      tasks.push({ task, nonce })
    }
    const comments = []
    for (const entry of plan.comments) {
      const c = (state().task_comments || []).find((x) => x.id === entry.commentId)
      const task = state().tasks[entry.taskId]
      if (!c || !task || !task.remote || !task.remote.issueNumber) continue
      if (pending.some((p) => p.kind === 'comment' && p.commentId === c.id)) continue
      if (pendingAdd.some((p) => p.kind === 'comment' && p.commentId === c.id)) continue
      const nonce = newNonce()
      pendingAdd.push({ kind: 'comment', id: c.id, taskId: task.id, commentId: c.id, nonce })
      comments.push({ comment: c, task, nonce })
    }
    return { ok: true, plan: { tasks, comments }, pendingAdd }
  }

  /**
   * 第二段：真的发请求。pending 已经在上一段落过盘了。
   */
  async function postPush(project, plan) {
    const remote = await remoteFor(project)
    const results = emptyResults()
    if (!remote) return results
    const cfg = (project && project.config) || {}

    for (const { task, nonce } of plan.tasks) {
      const payload = taskToIssuePayload(task, project)
      const body = scrubOutbound(payload.body) + '\n\n' + markerOf('task', task.id, nonce)
      const res = await createRemoteIssue({ remote, title: payload.title, body, fetchImpl })
      if (!res.ok) {
        results.errors.push({ kind: 'task', taskId: task.id, status: res.status || 0, reason: res.reason })
        results.pendingDone.push(nonce)
        continue
      }
      const wanted = desiredLabels(task)
      results.outbound.push({
        taskId: task.id, issueNumber: Number(res.remoteId), url: res.url,
        source: remote.kind || 'github', labels: wanted,
      })
      results.pendingDone.push(nonce)
      // 拿到 issue 号后立刻补齐受管标签，人一眼能看出这张卡在流水线的哪一段
      await ensureManagedLabels(remote, wanted)
      for (const label of wanted) {
        await addIssueLabel({ remote, issueNumber: Number(res.remoteId), label, fetchImpl })
      }
    }

    for (const { comment, task, nonce } of plan.comments) {
      const body = scrubOutbound(String(comment.content || '')) + '\n\n' + markerOf('comment', comment.id, nonce)
      const res = await createComment({ remote, issueNumber: task.remote.issueNumber, body, fetchImpl })
      if (!res.ok) {
        results.errors.push({ kind: 'comment', commentId: comment.id, status: res.status || 0, reason: res.reason })
        results.pendingDone.push(nonce)
        continue
      }
      results.outboundComments.push({ commentId: comment.id, remoteCommentId: res.commentId, url: res.url, login: null })
      results.pendingDone.push(nonce)
    }

    // 已推过的卡：标签漂移就修（只动受管标签，人自己贴的标签一根不碰）
    for (const task of Object.values(state().tasks)) {
      if (!task || task.projectId !== project.id) continue
      if (!task.remote || !task.remote.issueNumber) continue
      if (plan.tasks.some((x) => x.task.id === task.id)) continue
      const want = desiredLabels(task)
      const diff = diffLabels((task.remote && task.remote.labels) || [], want)
      if (!diff.add.length && !diff.remove.length) continue
      await ensureManagedLabels(remote, want)
      for (const label of diff.add) await addIssueLabel({ remote, issueNumber: task.remote.issueNumber, label, fetchImpl })
      for (const label of diff.remove) await removeIssueLabel({ remote, issueNumber: task.remote.issueNumber, label, fetchImpl })
      results.labelSync.push({ taskId: task.id, add: diff.add, remove: diff.remove, labels: want })
    }

    // v1.27：卡收口了，issue 也该关 —— 以前 patchIssue 写好了却**从未被调用**，
    // 于是「本地 done / 远端还 open」是常态。用户原话：票完成了 issue 还没关闭。
    //
    // 只关确定终态的列；cancelled 用 not_planned（GitHub 上「不做」与「做完」是两个语义）。
    // issueCloseEnabled 关闭时完全不动远程状态（人可能想自己在 GitHub 上管）。
    if (cfg.issueCloseEnabled !== false) {
      for (const task of Object.values(state().tasks)) {
        if (!task || task.projectId !== project.id) continue
        if (!task.remote || !task.remote.issueNumber) continue
        if (task.remote.state === 'closed') continue          // 已经关过，不重复 PATCH
        const col = String(task.column || '')
        const isDone = col === 'done'
        const isCancelled = col === 'cancelled'
        if (!isDone && !isCancelled) continue
        const res = await patchIssue({
          remote,
          issueNumber: Number(task.remote.issueNumber),
          patch: { state: 'closed', stateReason: isCancelled ? 'not_planned' : 'completed' },
          fetchImpl,
        })
        if (!res.ok) {
          results.errors.push({ kind: 'issue-close', taskId: task.id, status: res.status || 0, reason: res.reason })
          continue
        }
        results.issueClosed.push({ taskId: task.id, issueNumber: Number(task.remote.issueNumber), stateReason: isCancelled ? 'not_planned' : 'completed' })
      }
    }

    return results
  }

  /** 兼容老调用：一次跑完两段（测试与 `flow_issue_sync` 用）。 */
  async function pushProject(project, { onPending = null } = {}) {
    const planned = await planPush(project)
    if (!planned.ok) return planned
    if (planned.skipped) return { ok: true, skipped: planned.skipped, results: emptyResults() }
    if (planned.pendingAdd.length && typeof onPending === 'function') await onPending(planned.pendingAdd)
    const results = await postPush(project, planned.plan)
    return { ok: true, results }
  }

  /**
   * 重启对账：pending 里的东西到底推没推上去？
   *
   * 判据只有一条 —— 远端有没有 body 里带同一个 nonce 的条目。有 → 收养（只补写身份，
   * 绝不再 POST 一次）；没有 → 丢掉 pending，下一轮 pickOutbound 会重新捡起来推。
   */
  async function reconcileOutbound(project) {
    const remote = await remoteFor(project)
    const sync = syncOf(project.id)
    if (!remote || !sync || !Array.isArray(sync.outbound) || !sync.outbound.length) return { adopted: 0, dropped: 0 }
    const results = emptyResults()
    let adopted = 0
    let dropped = 0
    const issues = await listIssues({ remote, limit: 30, fetchImpl })
    const comments = await listComments({ remote, limit: 50, fetchImpl })
    for (const p of sync.outbound) {
      if (p.kind === 'task') {
        const hit = issues.ok ? (issues.items || []).find((it) => markerNonce(it.body) === p.nonce) : null
        if (hit) {
          results.outbound.push({
            taskId: p.taskId, issueNumber: Number(hit.remoteId), url: hit.url,
            source: remote.kind || 'github', labels: (state().tasks[p.taskId] ? desiredLabels(state().tasks[p.taskId]) : []),
          })
          adopted += 1
        } else dropped += 1
      } else if (p.kind === 'comment') {
        const hit = comments.ok ? (comments.items || []).find((it) => markerNonce(it.body) === p.nonce) : null
        if (hit) {
          results.outboundComments.push({ commentId: p.commentId, remoteCommentId: hit.commentId, url: hit.url, login: hit.login })
          adopted += 1
        } else dropped += 1
      }
      results.pendingDone.push(p.nonce)
    }
    return { adopted, dropped, results }
  }

  // -------------------------------------------------------------------------
  // 编排
  // -------------------------------------------------------------------------

  function emptyResults() {
    return { inbound: { issues: [], comments: [] }, outbound: [], outboundComments: [], pendingAdd: [], pendingDone: [], labelSync: [], issueClosed: [], cursors: {}, errors: [] }
  }

  /**
   * 跑一个项目的一轮同步：拉 + 推 + 对账，最后**一次事务**落盘。
   */
  async function runProject(project, { force = false } = {}) {
    const remote = await remoteFor(project)
    if (!remote) return { ok: false, skipped: 'not-configured' }
    if (!force && circuitOpen(project.id)) return { ok: false, skipped: 'circuit' }
    const sync = syncOf(project.id)
    if (!force && sync && sync.lastSyncAt && now() - Date.parse(sync.lastSyncAt) < SYNC_INTERVAL_MS) {
      return { ok: false, skipped: 'throttled' }
    }

    const merged = emptyResults()
    const notes = []

    // ⓪ pending 对账：上一轮死在哪一步，先把身份认领回来（绝不再 POST 一次）
    const rec = await reconcileOutbound(project)
    if (rec.results) {
      mergeResults(merged, rec.results)
      if (rec.adopted || rec.dropped) notes.push('pending 对账：收养 ' + rec.adopted + '，重推 ' + rec.dropped)
    }

    // ① 出站第一段：先落 pending（独立事务），再发 POST。顺序不能反。
    const planned = await planPush(project)
    let postResults = emptyResults()
    if (!planned.ok) {
      notes.push('出站跳过：' + planned.reason)
    } else if (!planned.skipped && planned.pendingAdd.length) {
      await domain.applySyncResults(project.id, {
        inbound: { issues: [], comments: [] },
        outbound: [], outboundComments: [], labelSync: [],
        pendingAdd: planned.pendingAdd, pendingDone: [], cursors: {},
        sinceIfNull: sync && sync.since ? null : new Date(now()).toISOString(),
      })
      postResults = await postPush(project, planned.plan)
    } else if (!planned.skipped) {
      postResults = await postPush(project, planned.plan)
    }

    // ② 入站：拉 issues + comments
    const pulled = await pullProject(project)
    if (pulled.results) mergeResults(merged, pulled.results)
    mergeResults(merged, postResults)

    if (!pulled.ok) {
      // v1.27：这条分支以前**只落 outbound，不落 errors** ——
      // 于是 sync.applied 事件永远是 errors:0，可 sync.circuit 却每 5 分钟刷一次 403。
      // 人看到的是「同步完成、没有变化」，实际是半个功能全废。
      // 现在把本轮所有错误（含出站 403）一起落盘，事件里能看见真实失败。
      await domain.applySyncResults(project.id, {
        inbound: { issues: [], comments: [] },
        outbound: merged.outbound, outboundComments: merged.outboundComments,
        labelSync: merged.labelSync,
        issueClosed: merged.issueClosed,
        pendingAdd: [], pendingDone: merged.pendingDone, cursors: merged.cursors,
        lastError: (merged.errors[0] && (merged.errors[0].reason || 'sync-failed')) || pulled.reason || 'pull-failed',
      })
      await domain.setSyncCircuit(project.id, { status: pulled.status || 0, reason: pulled.reason || 'pull-failed' })
      return { ok: false, reason: pulled.reason, results: merged }
    }

    // ③ 入站评论要「进管道」：跑着的卡注入工人，没跑的叫调度员
    const injected = await deliverInboundComments(project, merged.inbound.comments)
    if (injected.length) notes.push('远程评论进管道 ' + injected.length + ' 条')

    // ③b PR 回读 + 唤醒（v1.22 P6）：只回读本地开着的 PR，事实合并进同一批结果
    const pulls = await refreshPulls(project)
    merged.pulls = pulls.pulls || []
    merged.wakes = pulls.wakes || []
    for (const c of pulls.comments || []) merged.inboundComments = (merged.inboundComments || []).concat([c])
    for (const n of pulls.notify || []) {
      try {
        const task = state().tasks[n.taskId]
        if (task && dispatcher) await dispatcher.notifyDispatcher(task, n.message, n.kind)
        notes.push('唤醒 ' + n.kind + ' ' + n.taskId)
      } catch (err) { log('wake notify failed ' + n.taskId + ': ' + ((err && err.message) || err)) }
    }

    // ④ 一次事务落完全部结果
    const applied = await domain.applySyncResults(project.id, {
      sinceIfNull: sync && sync.since ? null : new Date(now()).toISOString(),
      cursors: merged.cursors,
      inbound: merged.inbound,
      outbound: merged.outbound,
      outboundComments: merged.outboundComments,
      labelSync: merged.labelSync,
      issueClosed: merged.issueClosed,
      pendingAdd: [],
      pendingDone: merged.pendingDone,
      pulls: merged.pulls,
      wakes: merged.wakes,
      systemComments: merged.inboundComments,
      lastError: merged.errors.length ? merged.errors[0].reason || 'push-failed' : null,
      circuitUntil: null,
    })
    return { ok: true, applied, notes, errors: merged.errors, inbound: merged.inbound, outbound: merged.outbound }
  }

  /**
   * 远程评论进管道。
   *
   * 为什么不是「只落库就行」：评论往往就是新的要求或纠正，工人不看到就白干了。
   * 卡在跑 → 直接注入那个 run 的会话；卡没跑 → 走调度员的看管通道（notifyDispatcher）。
   */
  async function deliverInboundComments(project, comments) {
    if (!Array.isArray(comments) || !comments.length) return []
    if (!runtime || typeof runtime.promptSession !== 'function') return []
    const out = []
    for (const c of comments) {
      const task = Object.values(state().tasks).find(
        (t) => t && t.projectId === project.id && t.remote && String(t.remote.issueNumber) === String(c.issueNumber),
      )
      if (!task) continue
      // v1.25：注入到会话里的这段是**提示**，不是正文载体。长评论原来在这里被切到 3000 字符
      // 且没有任何提示，工人会以为那就是全部。现在超长时明说"还有多少、怎么读全"，
      // 让它自己决定要不要去读完整版（评论已落库，能按 id 分段取）。
      const full = String(c.body || '')
      const clipped = full.slice(0, 3000)
      const more = full.length > clipped.length
        ? '\n\n（这段只截了前 3000 字符，完整版共 ' + full.length + ' 字符：先用 flow_task_detail 拿到评论 id，再用 flow_task_comment_read 分段读完再动手。）'
        : ''
      const text = '【远程评论】' + (c.login || 'someone') + ' 在 issue #' + c.issueNumber + ' 上写了：\n' + clipped + more
      const run = task.activeRunId ? state().runs[task.activeRunId] : null
      try {
        if (run && run.sessionId) {
          const sent = await runtime.promptSession(run.sessionId, text, 'queue', { origin: 'system' })
          domain.logMessage({ sessionId: run.sessionId, agentId: run.agentId || null, direction: 'out', origin: 'system', kind: 'remote-comment', ok: !!sent.ok, taskId: task.id })
          out.push({ taskId: task.id, to: 'worker', ok: !!sent.ok })
        } else if (dispatcher && typeof dispatcher.notifyDispatcher === 'function') {
          await dispatcher.notifyDispatcher(task, 'issue #' + c.issueNumber + ' 有新评论', 'remote-comment')
          out.push({ taskId: task.id, to: 'dispatcher', ok: true })
        }
      } catch (err) {
        log('deliver remote comment failed ' + task.id + ': ' + ((err && err.message) || err))
      }
    }
    return out
  }

  /** 一次 tick：按 lastSyncAt 轮转，只跑一个项目（多项目不抢配额）。 */
  async function tick() {
    const due = domain.syncCandidates(now(), SYNC_INTERVAL_MS)
    const report = { synced: [], skipped: [] }
    for (const cand of due.slice(0, 1)) {
      const project = projectOf(cand.projectId)
      if (!project) continue
      const res = await runProject(project).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }))
      report.synced.push({ projectId: project.id, ok: !!res.ok, skipped: res.skipped || null, notes: res.notes || [], reason: res.reason || null })
    }
    return report
  }

  return { tick, runProject, pullProject, pushProject, refreshPulls, reconcileOutbound, circuitOpen }
}

function markerOf(kind, id, nonce) {
  return '<!-- dsh-flow:' + (kind === 'comment' ? 'comment' : 'task') + ' ' + String(id) + ' n=' + String(nonce) + ' -->'
}

function mergeResults(into, from) {
  if (!from) return into
  if (from.inbound) {
    into.inbound.issues.push(...(from.inbound.issues || []))
    into.inbound.comments.push(...(from.inbound.comments || []))
  }
  into.outbound.push(...(from.outbound || []))
  into.outboundComments.push(...(from.outboundComments || []))
  into.pendingAdd.push(...(from.pendingAdd || []))
  into.pendingDone.push(...(from.pendingDone || []))
  into.labelSync.push(...(from.labelSync || []))
  into.issueClosed.push(...(from.issueClosed || []))
  into.errors.push(...(from.errors || []))
  Object.assign(into.cursors, from.cursors || {})
  return into
}
