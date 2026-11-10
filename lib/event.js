/**
 * dsh-flow · event
 *
 * issue 车道的入站收口：把「外部 webhook → 本地任务」这条链路参数化到 lane='issue'。
 *
 * 事务顺序（与 docs/事务流设计.md 4.4 一致）：
 *   L1 收件（event_inbox + dedupeKey 唯一）→ L1 建任务/更新镜像（同事务）→ L1 交给 issue 车道子调度
 * 幂等键 = <source>:<kind>:<refId>，写进 task.originRef（**不含 action/rev**，见 originRefOf 注释）；
 * 重复投递、同一条 issue 的后续修订都只会命中已存在的任务，不会建第二张卡。
 */

import { hasFlowMarker } from './sync.js'

/**
 * 构造幂等键：**只由「来源身份」组成，不含 action / revision**。
 *
 * v1.23 修正：原实现是 [src, kind, id, action, rev].join(':')，把 updated_at 编进了身份。
 * 后果是 GitHub 上同一条 issue 每被改一次（改标题、加评论、打标签都会推 updated_at），
 * 就变成一个"全新事件"再建一张卡 —— 线上真实事故：issue #6 的两个 revision
 * （17:46:48Z / 17:48:12Z）分别长出 T-019 和 T-022，两条卡内容一模一样。
 *
 * 身份是「这条 issue」，修订是它的属性 → 修订写进 task.originRev，不参与去重。
 */
export function originRefOf(source, refKind, payload = {}) {
  const src = String(source || 'remote')
  const kind = String(refKind || payload.kind || 'issue')
  const id = String(payload.remoteId || payload.refId || '')
  if (!id) return null
  return [src, kind, id].join(':')
}

/** 事件对应的修订时间（与 originRefOf 分开存：身份稳定、修订会变）。 */
export function originRevOf(payload = {}) {
  const rev = String(payload.rev || payload.updatedAt || '')
  return rev || null
}

/**
 * 老格式（含 action/rev 的四段/五段式）兼容匹配。
 * 库里已有的卡还是老键，升级后不能让它们变成"查不到的新卡"。
 */
export function originRefMatches(taskRef, originRef) {
  if (!taskRef || !originRef) return false
  if (taskRef === originRef) return true
  // 老键以 "src:kind:id:" 开头，ident 是它的前缀
  return String(taskRef).startsWith(originRef + ':')
}

/** 从归一化事件里抽建卡所需字段。 */
export function taskInputFromEvent(env) {
  const p = (env && env.payload) || {}
  const title = String(p.title || ('远程 ' + (p.kind || 'issue') + ' #' + (p.remoteId || '?'))).slice(0, 120)
  const body = String(p.body || '')
  const src = env && env.source ? env.source : 'remote'
  const note = [body, '', '（来自 ' + src + ' #' + (p.remoteId || '?') + (p.url ? ' ' + p.url : '') + '）']
    .filter((x) => x !== undefined && x !== null)
    .join('\n')
    .slice(0, 4000)
  return {
    title,
    note,
    origin: 'auto',
    originRef: originRefOf(src, env && env.refKind, p),
    originRev: originRevOf(p),
    // v1.23：入站建的卡必须当场记下"它是远程哪一条"。否则 pickOutbound 认为这卡
    // 还没推过，会把它再推一次 → 生成新 issue → 下一轮又被拉回来建卡（线上级联事故）。
    remote: {
      source: src,
      issueNumber: p.remoteId || p.refId ? Number(p.remoteId || p.refId) : null,
      url: p.url || null,
    },
    scope: { paths: [], symbols: [] },
    // RT-06：入站卡固定 visibility=auto。showAutoCards 只影响看板读侧，
    // 不能在这里把卡改成 board。lane 固定 issue；kind 由 createTask 落成 card。
    visibility: 'auto',
    lane: 'issue',
  }
}

/**
 * 幂等判定：按 originRef 找已存在的任务。
 * @returns 已存在的任务或 null
 */
export function findTaskByOriginRef(state, originRef) {
  if (!originRef) return null
  for (const task of Object.values((state && state.tasks) || {})) {
    if (task && originRefMatches(task.originRef, originRef)) return task
  }
  return null
}

/**
 * 处理一条入站事件：去重 → 建卡 → 交给 issue 车道子调度。
 * 全部走 domain 的事务方法，本函数不直接改 state。
 *
 * @returns { created, taskId, skipped, reason }
 */
export async function ingestIssueEvent(domain, env, opts = {}) {
  const state = domain.store.state
  const p = (env && env.payload) || {}
  const project = opts.project || Object.values(state.projects || {}).find((x) => x.id === p.projectId)
  if (!project) return { created: false, skipped: true, reason: 'unknown project' }

  // v1.23：自己推出去的 issue 会带着 flow marker 回流，见到 marker 一律当回声丢掉。
  if (hasFlowMarker(p.body)) return { created: false, skipped: true, reason: 'self-echo' }

  const input = taskInputFromEvent(env)
  if (!input.originRef) return { created: false, skipped: true, reason: 'no originRef' }

  const existing = findTaskByOriginRef(state, input.originRef)
  if (existing) return { created: false, skipped: true, reason: 'duplicate', taskId: existing.id }

  // 同一条 issue 的另一个修订：只推进 originRev，绝不建第二张卡。
  const byRemote = Object.values(state.tasks || {}).find(
    (x) => x && x.projectId === project.id && x.remote && String(x.remote.issueNumber) === String(p.remoteId || p.refId || ''),
  )
  if (byRemote) return { created: false, skipped: true, reason: 'duplicate', taskId: byRemote.id }

  // 懒补齐 issue 车道（默认 0 工位，第一次真的来了 issue 才补）
  try {
    await domain.ensureLaneAgents(project.id, 'issue', opts.laneAgents || { dispatchers: 1, workers: 2 }, { role: 'system', id: 'event' })
  } catch { /* 补齐失败不阻塞建卡 */ }

  const task = await domain.createTask(project.id, input, { role: 'system', id: 'event:' + (env.source || 'remote') })

  // 交接给 issue 车道的子调度：有 dispatcher 就 claim + 计划交接，没有就留 todo
  let handedOff = false
  try {
    const sup = domain.supervisorOf(project.id, 'issue')
    if (sup) {
      await domain.move(task.id, 'claim', { role: 'dispatcher', id: sup.id })
      handedOff = true
    }
  } catch { /* 交不出去就等人认领 */ }

  return { created: true, taskId: task.id, handedOff, title: input.title }
}
