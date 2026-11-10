/**
 * dsh-flow · domain / sync-mirror
 *
 * 项目级双向同步的领域侧：镜像行、入站事件、游标、熔断、标签合流（v1.36 从 domain.js 抽出）。
 *
 * 这 17 个方法原来和任务状态机、合并事务混在同一个 3500 行的类里，改同步协议时看不清边界。
 * 通过 Object.assign(FlowDomain.prototype, syncMirrorMethods) 混入，调用点不变。
 *
 * 循环引用说明：nextCommentId / mergeRemoteItems 是 domain.js 里的**函数声明**（提升），
 * 且只在本模块的方法体里调用，不在模块求值期执行 —— ESM 循环引用在这里是安全的。
 */
import { nowIso, clampText, emit, ingestEvent, pendingEvents, consumeEvents, COMMENT_MAX } from '../core.js'
import { ensureSyncState, hasFlowMarker, isOwnFlowMarker, stripFlowMarker } from '../sync.js'
import { nextCommentId, mergeRemoteItems } from '../domain.js'

const must = (cond, message) => { if (!cond) throw new Error(message) }

/** 入站评论找卡：issue 按 issueNumber，PR 按 pull_requests.remote.number 或 external.number。 */
function taskForInboundComment(s, projectId, incoming) {
  const thread = incoming && incoming.thread === 'pr' ? 'pr' : 'issue'
  const number = Number(incoming && (incoming.number || incoming.issueNumber)) || null
  if (!number) return null
  const tasks = Object.values(s.tasks || {}).filter((t) => t && t.projectId === projectId)
  if (thread === 'pr') {
    const byPull = Object.values(s.pull_requests || {}).find((p) => p && p.projectId === projectId && p.remote && Number(p.remote.number) === number)
    if (byPull && s.tasks[byPull.taskId]) return s.tasks[byPull.taskId]
    return tasks.find((t) => t.external && Number(t.external.number) === number) || null
  }
  return tasks.find((t) => t.remote && Number(t.remote.issueNumber) === number) || null
}

export const syncMirrorMethods = {
  async linkMirror(projectId, remoteId, taskId) {
    return this.store.tx((s) => {
      const rec = Object.values(s.issues_mirror).find((m) => m.projectId === projectId && m.remoteId === remoteId)
      if (!rec) return null
      rec.taskId = taskId
      rec.updatedAt = nowIso()
      return rec
    })
  }
,
  pendingEvents(limit = 50) { return pendingEvents(this.store.state, limit) }
,
  async consume(ids) { return this.store.tx((s) => consumeEvents(s, ids)) }
,
  async ingest(env) { return this.store.tx((s) => ingestEvent(s, env)) }
,
  mirrorList(projectId) {
    return Object.values(this.store.state.issues_mirror).filter((m) => m.projectId === projectId)
  }
,
  async upsertMirror(projectId, item = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      must(s.projects[projectId], 'unknown project')
      const remoteId = String(item.remoteId || '')
      must(remoteId, 'remoteId 必填')
      const existing = Object.values(s.issues_mirror).find((m) => m.projectId === projectId && m.remoteId === remoteId)
      if (existing) {
        if (item.remoteRev && existing.remoteRev === item.remoteRev) return { ...existing, unchanged: true }
        existing.remoteRev = item.remoteRev || existing.remoteRev
        existing.title = clampText(item.title || existing.title, 200)
        existing.body = clampText(item.body || existing.body || '', 4000)
        existing.state = item.state || existing.state
        existing.source = item.source || existing.source || 'remote'
        existing.updatedAt = nowIso()
        emit(s, 'issue.mirrored', { projectId, remoteId, rev: existing.remoteRev, changed: true }, actor)
        return existing
      }
      s.seq.mirror += 1
      const rec = {
        id: 'im_' + String(s.seq.mirror).padStart(3, '0'),
        projectId, remoteId, remoteRev: item.remoteRev || null,
        taskId: item.taskId || null, kind: item.kind || 'issue',
        source: item.source || 'remote',
        title: clampText(item.title || '', 200), body: clampText(item.body || '', 4000),
        state: item.state || 'open', createdAt: nowIso(), updatedAt: nowIso(),
      }
      s.issues_mirror[rec.id] = rec
      emit(s, 'issue.mirrored', { projectId, remoteId, rev: rec.remoteRev, changed: true }, actor)
      return rec
    })
  }
,
  async syncRemote(projectId, { source = 'gitea', cursor = null, items = [] } = {}, actor = { role: 'system' }) {
    {
      const p = this.store.state.projects[projectId]
      // 未开启记录 issue → 不同步（本地看板模式下没有"远程"这个概念）
      if (!(p && p.config && p.config.recordIssues)) return { ok: false, skipped: 'record-issues-off', stats: { added: 0, updated: 0, unchanged: 0 } }
    }
    return this.store.tx((s) => {
      must(s.projects[projectId], 'unknown project')
      const stats = { added: 0, updated: 0, unchanged: 0, events: 0 }
      mergeRemoteItems(s, projectId, source, items, stats)
      if (cursor !== null && cursor !== undefined) {
        s.event_cursors[projectId + ':' + source] = { projectId, source, cursor, updatedAt: nowIso() }
      }
      emit(s, 'issue.mirrored', { projectId, source, ...stats }, actor)
      return stats
    })
  }
,
  cursorFor(projectId, source) {
    const rec = this.store.state.event_cursors[projectId + ':' + source]
    return rec ? rec.cursor : null
  }
,
  async setCursor(projectId, source, cursor, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const rec = { projectId, source, cursor, updatedAt: nowIso() }
      s.event_cursors[projectId + ':' + source] = rec
      emit(s, 'cursor.moved', { projectId, source, cursor }, actor)
      return rec
    })
  }
,
  syncStateOf(projectId) {
    const s = this.store.state.remote_sync || {}
    return s[projectId] || null
  }
,
  async applySyncResults(projectId, results = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      must(s.projects[projectId], 'unknown project')
      const sync = ensureSyncState(s, projectId, results.sinceIfNull || nowIso())
      if (results.sinceIfNull && !sync.since) sync.since = results.sinceIfNull
      // v1.22 P6：远程唤醒的去重时间戳随本轮结果一起落盘（不单开事务）
      const wakes = Array.isArray(results.wakes) ? results.wakes : []
      const out = { tasks: 0, comments: 0, issues: 0, errors: 0, commentMarks: 0, wakes: 0 }

      for (const issue of results.inbound && results.inbound.issues || []) {
        const stats = { added: 0, updated: 0, unchanged: 0, events: 0 }
        mergeRemoteItems(s, projectId, issue.source || 'github', [issue], stats)
        out.issues += stats.added + stats.updated
      }

      for (const incoming of results.inbound && results.inbound.comments || []) {
        const task = taskForInboundComment(s, projectId, incoming)
        if (!task) continue
        const remoteId = incoming.remoteId != null ? String(incoming.remoteId) : (incoming.commentId != null ? String(incoming.commentId) : '')
        const commentId = incoming.commentId != null ? String(incoming.commentId) : remoteId
        // 幂等键是「这张卡 + 这条远端评论」。remoteId 在 GitHub 上有时是 issue 号
        // （list 映射），不能单独当身份，否则同一 PR 的第二条评论会被吞掉。
        const dup = (s.task_comments || []).some((c) => {
          if (!c || c.taskId !== task.id || !c.remote) return false
          if (commentId && String(c.remote.commentId) === commentId) return true
          if (remoteId && commentId && String(c.remote.remoteId) === remoteId && String(c.remote.commentId) === commentId) return true
          return false
        })
        if (dup) continue
        // RT-03 §3：只有 marker 身份对得上本系统才是回声。人转述一句 dsh-flow:comment 不能丢。
        if (isOwnFlowMarker(incoming.body) || (hasFlowMarker(incoming.body) && isOwnFlowMarker(incoming.body))) continue
        const thread = incoming.thread === 'pr' ? 'pr' : 'issue'
        const number = Number(incoming.number || incoming.issueNumber) || null
        let content = stripFlowMarker(incoming.body) || ''
        if (thread === 'pr' && number && !/来自 PR #/.test(content)) {
          content = content + '\n（来自 PR #' + number + '）'
        }
        s.task_comments.push({
          id: nextCommentId(s),
          taskId: task.id,
          content: clampText(content, COMMENT_MAX),
          author: incoming.login || 'remote',
          role: 'remote',
          at: incoming.createdAt || nowIso(),
          remote: {
            thread,
            number,
            commentId,
            // 落库的 remoteId 是这条评论自己的远端 id（测试与去重都认 commentId）。
            // incoming.remoteId 在 list 映射里常常是 issue 号，只用来找卡，不拿来当评论身份。
            remoteId: commentId || remoteId,
            url: incoming.url || null,
            login: incoming.login || null,
            reactions: incoming.reactions || 0,
            at: incoming.createdAt || nowIso(),
          },
        })
        out.comments += 1
      }

      // v1.22：outbound 在引擎里是「任务 + 评论」合在一根数组里的，这里统一成一种形状再消费。
      const outTasks = Array.isArray(results.outbound) ? results.outbound.filter((x) => x && x.taskId) : ((results.outbound && results.outbound.tasks) || [])
      const outComments = Array.isArray(results.outboundComments)
        ? results.outboundComments
        : (Array.isArray(results.outbound) ? results.outbound.filter((x) => x && x.commentId && !x.taskId) : ((results.outbound && results.outbound.comments) || []))

      for (const done of outTasks) {
        const task = s.tasks[done.taskId]
        if (!task) continue
        const prev = task.remote && typeof task.remote === 'object' ? task.remote : {}
        task.remote = {
          ...prev,
          source: done.source || prev.source || 'github',
          issueNumber: Number(done.issueNumber) || prev.issueNumber || null,
          url: done.url || prev.url || null,
          syncedRev: done.rev || prev.syncedRev || null,
          labels: Array.isArray(done.labels) ? done.labels : (prev.labels || []),
          at: nowIso(),
        }
        task.updatedAt = nowIso()
      }

      for (const done of outComments) {
        if (done && done.kind === 'milestone' && done.taskId) {
          const task = s.tasks[done.taskId]
          if (!task) continue
          task.remote = { ...(task.remote || {}), milestoneCommentAt: done.at || nowIso() }
          out.commentMarks += 1
          continue
        }
        const c = (s.task_comments || []).find((x) => x.id === done.commentId)
        if (!c) continue
        const prev = c.remote && typeof c.remote === 'object' ? c.remote : {}
        c.remote = {
          ...prev,
          thread: done.thread || prev.thread || null,
          number: done.number != null ? Number(done.number) : (prev.number || null),
          commentId: String(done.remoteCommentId || prev.commentId || ''),
          remoteId: done.remoteId != null ? String(done.remoteId) : String(done.remoteCommentId || prev.remoteId || ''),
          url: done.url || prev.url || null,
          login: done.login || prev.login || null,
          at: done.at || nowIso(),
        }
        out.commentMarks += 1
      }

      // v1.27：issue 已被关闭 → 记下来，避免下一轮重复 PATCH。
      // 这里只写 remote.state，不动卡片状态 —— 远程事实绝不能驱动状态机（I5 也要求单写者）。
      for (const done of Array.isArray(results.issueClosed) ? results.issueClosed : []) {
        const task = s.tasks[done.taskId]
        if (!task || !task.remote) continue
        task.remote = { ...task.remote, state: 'closed', stateReason: done.stateReason || null, closedAt: nowIso() }
        out.issuesClosed = (out.issuesClosed || 0) + 1
      }

      if (Array.isArray(results.pendingAdd)) {
        for (const p of results.pendingAdd) {
          s.seq.outbound = (s.seq.outbound || 0) + 1
          sync.outbound.push({ id: 'ob_' + String(s.seq.outbound).padStart(5, '0'), ...p, at: p.at || nowIso() })
        }
        if (sync.outbound.length > 200) sync.outbound.splice(0, sync.outbound.length - 200)
      }
      if (Array.isArray(results.pendingDone) && results.pendingDone.length) {
        const done = new Set(results.pendingDone.map((x) => String(x)))
        sync.outbound = sync.outbound.filter((p) => !done.has(String(p.nonce)))
      }

      // v1.22 P6：PR 远程事实（只记，不驱动状态机）
      for (const pull of Array.isArray(results.pulls) ? results.pulls : []) {
        const pr = s.pull_requests[pull.prId]
        if (!pr) continue
        pr.remote = {
          ...(pr.remote || {}),
          number: pull.number || (pr.remote && pr.remote.number) || null,
          url: pull.url || (pr.remote && pr.remote.url) || null,
          state: pull.state || (pr.remote && pr.remote.state) || 'open',
          merged: pull.merged === true,
          mergedAt: pull.mergedAt || (pr.remote && pr.remote.mergedAt) || null,
          mergedBy: pull.mergedBy || (pr.remote && pr.remote.mergedBy) || null,
          mergeCommitSha: pull.mergeCommitSha || (pr.remote && pr.remote.mergeCommitSha) || null,
          mergeableState: pull.mergeableState || (pr.remote && pr.remote.mergeableState) || null,
          reviews: Array.isArray(pull.reviews) ? pull.reviews.slice(-20) : ((pr.remote && pr.remote.reviews) || []),
          at: nowIso(),
        }
        pr.updatedAt = nowIso()
        out.pulls = (out.pulls || 0) + 1
      }

      // 唤醒与 PR 事实都要在讨论区留痕（人和工人都能看到"远程发生了什么"）
      for (const sc of Array.isArray(results.systemComments) ? results.systemComments : []) {
        if (!sc || !s.tasks[sc.taskId]) continue
        s.task_comments.push({
          id: nextCommentId(s),
          taskId: sc.taskId,
          content: clampText(sc.body || '', COMMENT_MAX),
          author: 'system',
          role: 'system',
          at: nowIso(),
        })
        out.commentMarks += 1
      }

      for (const wake of wakes) {
        if (!wake || !wake.key) continue
        sync.wake = sync.wake || {}
        sync.wake[wake.key] = wake.at || nowIso()
        out.wakes += 1
      }

      if (results.cursors && typeof results.cursors === 'object') {
        if (results.cursors.issueCursor) sync.issueCursor = results.cursors.issueCursor
        if (results.cursors.commentCursor) sync.commentCursor = results.cursors.commentCursor
      }
      if (results.lastError !== undefined) sync.lastError = results.lastError
      if (results.circuitUntil !== undefined) sync.circuitUntil = results.circuitUntil
      sync.lastSyncAt = nowIso()
      emit(s, 'sync.applied', { projectId, ...out, pending: sync.outbound.length }, actor)
      return out
    })
  }
,
  async commentFromRemote(taskId, incoming = {}, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const body = stripFlowMarker(incoming.content || '')
      if (hasFlowMarker(incoming.content || '')) return { skipped: 'self-marker' }
      const dup = (s.task_comments || []).some(
        (c) => incoming.commentId && c.remote && String(c.remote.commentId) === String(incoming.commentId),
      )
      if (dup) return { skipped: 'duplicate' }
      const rec = {
        id: nextCommentId(s),
        taskId,
        content: clampText(body || '', COMMENT_MAX),
        author: incoming.login || 'remote',
        role: 'remote',
        at: incoming.at || nowIso(),
        remote: incoming.commentId
          ? { commentId: String(incoming.commentId), url: incoming.url || null, login: incoming.login || null }
          : null,
      }
      s.task_comments.push(rec)
      emit(s, 'comment.added', { taskId, commentId: rec.id, remote: !!rec.remote }, actor)
      return rec
    })
  }
,
  async mergeRemoteLabels(taskId, labels, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      must(task, 'unknown task')
      const list = Array.isArray(labels) ? labels.map(String) : []
      const notes = []
      const prio = list.find((l) => l.startsWith('prio/'))
      if (prio) {
        const next = prio.slice('prio/'.length)
        if (['high', 'medium', 'low'].includes(next) && task.priority !== next) {
          task.priority = next
          notes.push('优先级按远程标签改成 ' + next)
        }
      }
      const flow = list.find((l) => l.startsWith('flow/'))
      if (flow) {
        const col = flow.slice('flow/'.length)
        const cur = String(task.column || '')
        if (col && cur && col !== cur) notes.push('远程标签是 ' + flow + '，本地列是 ' + cur + '（以本地为准）')
      }
      task.remote = { ...(task.remote || {}), labels: list }
      task.updatedAt = nowIso()
      emit(s, 'task.labels', { taskId, labels: list, notes }, actor)
      return { task, notes }
    })
  }
,
  syncCandidates(now = Date.now(), intervalMs = 60000) {
    const s = this.store.state
    const due = []
    for (const project of Object.values(s.projects)) {
      const cfg = project.config || {}
      const remote = cfg.remote
      if (!remote || remote.enabled === false) continue
      if (!remote.owner || !remote.repo) continue
      // C-02：PR 车道也算「需要同步」—— 只有 recordPulls 的项目同样要排进候选。
      if (!cfg.recordIssues && !cfg.recordPulls) continue
      const sync = (s.remote_sync || {})[project.id] || {}
      if (sync.circuitUntil && Date.parse(sync.circuitUntil) > now) continue
      const last = sync.lastSyncAt ? Date.parse(sync.lastSyncAt) : 0
      if (last && now - last < intervalMs) continue
      due.push({ projectId: project.id, last, rr: sync.rr || 0 })
    }
    due.sort((a, b) => (a.last - b.last) || (a.rr - b.rr))
    return due
  }
,
  async armProjectSync(projectId, actor = { role: 'system' }) {
    return this.store.tx((s) => {
      must(s.projects[projectId], 'unknown project')
      const sync = ensureSyncState(s, projectId, nowIso())
      if (!sync.since) sync.since = nowIso()
      emit(s, 'sync.armed', { projectId, since: sync.since }, actor)
      return sync
    })
  }
,
  async setSyncCircuit(projectId, { status = 0, reason = '', lastError = null } = {}, actor = { role: 'system' }) {
    const now = Date.now()
    const ttl = Number(status) === 401 ? 30 * 60 * 1000 : Number(status) === 403 || Number(status) === 429 ? 5 * 60 * 1000 : 0
    return this.store.tx((s) => {
      const sync = ensureSyncState(s, projectId, nowIso())
      if (ttl > 0) sync.circuitUntil = new Date(now + ttl).toISOString()
      sync.lastError = lastError || (reason ? String(reason) : null)
      sync.lastSyncAt = nowIso()
      emit(s, 'sync.circuit', { projectId, status, ttl, reason: sync.lastError }, actor)
      return { circuitUntil: sync.circuitUntil, lastError: sync.lastError }
    })
  }
,
  /**
   * 外部 PR 回读落盘（RT-03）。只补事实，不推状态机。
   * external / approval 缺了也不抛 —— 回读不能因为一张旧卡把整轮同步打崩。
   */
  async applyExternalRefresh(taskId, facts = {}, actor = { role: 'system', id: 'sync:external-pr' }) {
    return this.store.tx((s) => {
      const task = s.tasks[taskId]
      if (!task) return { ok: false, reason: 'unknown-task' }
      const ext = task.external && typeof task.external === 'object' && !Array.isArray(task.external) ? task.external : {}
      const prevSha = ext.headSha || null
      const nextSha = facts.headSha || prevSha || null
      const changed = !!(prevSha && nextSha && prevSha !== nextSha)
      const nextState = facts.merged ? 'merged' : (facts.state || ext.state || 'open')
      task.external = {
        ...ext,
        author: facts.author || ext.author || null,
        headRepo: facts.headRepo || ext.headRepo || null,
        baseRef: facts.baseRef || ext.baseRef || null,
        mergeableState: facts.mergeableState || ext.mergeableState || null,
        headSha: nextSha,
        state: nextState,
        url: facts.url || ext.url || null,
      }
      if (!task.external.approval) task.external.approval = { status: 'pending', by: null, at: null }
      if (changed) {
        task.external.approval = { status: 'pending', by: null, at: null }
        task.external.approvalHandledAt = null
        task.mergeState = 'blocked'
        task.mergeReason = 'head-mismatch'
      }
      task.updatedAt = nowIso()
      const pr = Object.values(s.pull_requests || {}).find((p) => p && p.taskId === taskId)
      if (pr) {
        pr.remote = {
          ...(pr.remote || {}),
          state: facts.merged ? 'closed' : (facts.state || (pr.remote && pr.remote.state) || 'open'),
          merged: facts.merged === true,
          author: facts.author || (pr.remote && pr.remote.author) || null,
          headRepo: facts.headRepo || (pr.remote && pr.remote.headRepo) || null,
          baseRef: facts.baseRef || (pr.remote && pr.remote.baseRef) || null,
          mergeableState: facts.mergeableState || (pr.remote && pr.remote.mergeableState) || null,
          at: nowIso(),
        }
        pr.updatedAt = nowIso()
      }
      if (changed) emit(s, 'external.head_moved', { taskId, from: prevSha, to: nextSha }, actor)
      return { ok: true, headMismatch: changed, prevSha, nextSha, number: ext.number || null }
    })
  }
,
  async repairInboundIdentities(actor = { role: 'system', id: 'repair' }) {
    return this.store.tx((s) => {
      const fixed = []
      const seen = new Map() // "<projectId>|<issueNumber>" → 最早的任务 id
      const tasks = Object.values(s.tasks || {}).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      for (const task of tasks) {
        const ref = String(task.originRef || '')
        const m = ref.match(/^(github|gitea|gitlab):(issue|pull):(\d+)/)
        if (!m) continue
        const source = m[1]
        const issueNumber = Number(m[3])
        const key = task.projectId + '|' + issueNumber
        const first = seen.get(key)
        if (first) {
          // 同一条远程 issue 的第二张卡：标记出来，不删（删卡是人来决定）
          if (!task.duplicateOf) {
            task.duplicateOf = first
            task.updatedAt = nowIso()
            fixed.push({ taskId: task.id, reason: 'duplicate-card', of: first })
          }
          continue
        }
        seen.set(key, task.id)
        const cur = task.remote || null
        if (!cur || Number(cur.issueNumber) !== issueNumber) {
          task.remote = {
            source,
            issueNumber,
            url: (cur && cur.url) || null,
            syncedRev: (cur && cur.syncedRev) || null,
            labels: (cur && cur.labels) || [],
            // 记下"我们曾经把它误推成第几条"，追溯用；不参与任何逻辑
            echoIssueNumber: cur && cur.issueNumber ? Number(cur.issueNumber) : null,
            at: nowIso(),
          }
          task.updatedAt = nowIso()
          fixed.push({ taskId: task.id, reason: cur ? 'echo-number' : 'missing-remote', was: cur && cur.issueNumber, now: issueNumber })
        }
      }
      if (fixed.length) emit(s, 'sync.repaired', { count: fixed.length, items: fixed.slice(0, 50) }, actor)
      return { fixed }
    })
  }
}
