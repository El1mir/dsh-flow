/**
 * dsh-flow · 车道消息区（RT-04 / 设计 §9）
 *
 * 纯状态函数：不 import dispatch / scheduler，也不查 remoteMode。
 * 出网与否由 HTTP / 工具路由挡。wake 由调用方注入；失败不丢消息。
 */

const TO_LANES = new Set(['human', 'issue', 'all'])
const FROM_KINDS = new Set(['human', 'agent', 'system'])
const REF_KINDS = new Set(['task', 'pull', 'issue', 'ticket', 'message'])

function must(cond, message) {
  if (!cond) throw new Error(message)
}

function readByBlank() {
  return { human: null, 'lane:human': null, 'lane:issue': null }
}

function normalizeRefs(refs, state, projectId) {
  const list = Array.isArray(refs) ? refs : []
  must(list.length <= 8, 'refs 最多 8 条')
  return list.map((r) => {
    const kind = String((r && r.kind) || '')
    must(REF_KINDS.has(kind), 'refs.kind 只能是 task / pull / issue / ticket / message')
    const id = r && r.id != null ? String(r.id) : ''
    must(id, 'refs.id 不能为空')
    if (kind === 'task') {
      const task = state.tasks && state.tasks[id]
      must(task && task.projectId === projectId, 'refs 里的 task 必须属于本项目')
    }
    return {
      kind,
      id,
      label: String((r && r.label) || '').slice(0, 120),
      url: r && r.url ? String(r.url).slice(0, 300) : null,
    }
  })
}

/**
 * @param {object} state 内存账本（调用方负责事务）
 * @param {string} projectId
 * @param {{body:string,to:string|{lane:string},from?:object,refs?:object[],replyTo?:string}} input
 * @param {{wake?:function}} [deps]
 */
export async function postLaneMessage(state, projectId, input = {}, deps = {}) {
  must(state && state.projects && state.projects[projectId], 'unknown project: ' + projectId)
  const body = String(input.body == null ? '' : input.body).trim()
  must(body, '消息不能为空')
  must(body.length <= 4000, '消息不能超过 4000 字')
  const toLane = typeof input.to === 'string' ? input.to : (input.to && input.to.lane)
  must(TO_LANES.has(toLane), 'to.lane 只能是 human / issue / all')
  const from = input.from && typeof input.from === 'object' ? input.from : {}
  must(FROM_KINDS.has(from.kind), 'from.kind 只能是 human / agent / system')
  const refs = normalizeRefs(input.refs, state, projectId)
  if (input.replyTo) {
    const parent = (state.lane_messages || []).find((m) => m && m.id === input.replyTo && m.projectId === projectId)
    must(parent, 'replyTo 不存在或不属于本项目')
  }
  if (!Array.isArray(state.lane_messages)) state.lane_messages = []
  if (!state.seq || typeof state.seq !== 'object') state.seq = {}
  state.seq.laneMsg = (Number(state.seq.laneMsg) || 0) + 1
  const id = 'lm_' + String(state.seq.laneMsg).padStart(4, '0')
  const message = {
    id,
    projectId,
    body,
    from: {
      kind: from.kind,
      lane: from.lane || null,
      agentId: from.agentId || null,
      name: from.name || null,
    },
    to: { lane: toLane },
    refs,
    replyTo: input.replyTo || null,
    readBy: readByBlank(),
    deliveredAt: null,
    createdAt: new Date().toISOString(),
  }
  state.lane_messages.push(message)
  if (from.kind === 'human' && typeof deps.wake === 'function') {
    const targets = toLane === 'all' ? ['human', 'issue'] : [toLane]
    try {
      for (const lane of targets) await deps.wake(projectId, lane, message)
      message.deliveredAt = new Date().toISOString()
    } catch {
      message.deliveredAt = null
    }
  }
  return message
}

export function listLaneMessages(state, projectId, { before, limit } = {}) {
  const all = (state.lane_messages || [])
    .filter((m) => m && m.projectId === projectId)
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      || String(b.id).localeCompare(String(a.id)))
  let start = 0
  if (before) {
    const idx = all.findIndex((m) => m.id === before)
    if (idx >= 0) start = idx + 1
    else {
      const byTime = all.findIndex((m) => String(m.createdAt || '') < String(before))
      start = byTime >= 0 ? byTime : all.length
    }
  }
  const n = Math.max(1, Math.min(100, Number(limit) || 50))
  const items = all.slice(start, start + n)
  return { items, hasMore: start + items.length < all.length }
}

export function markLaneRead(state, projectId, reader, at) {
  const when = at || new Date().toISOString()
  for (const m of state.lane_messages || []) {
    if (!m || m.projectId !== projectId) continue
    if (!m.readBy) m.readBy = readByBlank()
    if (Object.prototype.hasOwnProperty.call(m.readBy, reader)) m.readBy[reader] = when
  }
}
