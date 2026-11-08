/**
 * dsh-flow · chat
 *
 * 把 DSH 会话的事件流（ctx.on('session/event')）规范化成工作台聊天面板能直接渲染的帧，
 * 按 sessionId 环形缓冲最近 N 条，供 SSE 续传。
 *
 * 帧形状：{ seq, sessionId, kind, ... }
 *   kind = 'user' | 'assistant' | 'tool' | 'tool_result' | 'status' | 'error'
 *
 * 这里只读不写：真正发消息走 runtime.prompt（见 index.js）。
 */

const LIMIT = 400
const cut = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) + '…' : v) : '')

const textOf = (message) => {
  if (!message) return ''
  if (typeof message === 'string') return message
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
  }
  return ''
}

/** 一个 session/event 可能产出 0..n 帧。 */
export function normalize(event) {
  if (!event || typeof event.type !== 'string') return []
  const data = event.data || {}
  switch (event.type) {
    case 'user/message': {
      const text = textOf(data.message)
      return text ? [{ kind: 'user', text: cut(text, 8000) }] : []
    }
    case 'assistant/message': {
      const text = textOf(data.message)
      if (!text && !data.interrupted) return []
      return [{ kind: 'assistant', text: cut(text, 12000), interrupted: data.interrupted === true, usage: data.usage || null }]
    }
    case 'tool/call':
      return [{ kind: 'tool', name: data.name || 'tool', args: cut(data.arguments || '', 600), callId: data.callId || null }]
    case 'tool/result': {
      const text = textOf(data.message)
      return [{
        kind: 'tool_result',
        ok: !data.error,
        name: data.message && data.message.name ? data.message.name : '',
        text: cut(text, 600),
        reason: data.error ? cut(String(data.error.reason || data.error.code || ''), 300) : '',
        callId: data.message ? data.message.toolCallId || null : null,
      }]
    }
    case 'command/run':
      return [{ kind: 'command', name: data.name || '?', args: cut(String(data.args || ''), 400) }]
    case 'command/done':
      return [{
        kind: 'command_result',
        ok: data.kind === 'success',
        verdict: String(data.kind || ''),
        text: cut(String(data.text || ''), 2000),
      }]
    case 'model/selection': {
      const sel = data.selection || data
      const model = sel && sel.model
      if (!model) return []
      return [{ kind: 'model', model: String(model), provider: String((sel && sel.provider) || '') }]
    }
    case 'turn/start':
      return [{ kind: 'status', state: 'thinking', turn: data.turn || null }]
    case 'turn/end':
      return [{ kind: 'status', state: 'idle', reason: (data.reason && data.reason.kind) || 'end' }]
    case 'error':
    case 'session/error':
      return [{ kind: 'error', text: cut(String(data.message || data.reason || 'unknown error'), 600) }]
    default:
      return []
  }
}

export class ChatHub {
  constructor({ limit = LIMIT } = {}) {
    this.limit = limit
    this.buffers = new Map()
    this.subs = new Set()
    this.seq = 0
    this.dispose = null
    this.systemMarks = new Map()
  }

  /** 订阅进程内会话事件总线；返回清理函数。 */
  attach(ctx) {
    const off = ctx.on('session/event', (session, event) => {
      try { this.ingest(session, event) } catch { /* 渲染层的问题不该影响会话 */ }
    }, { global: true })
    this.dispose = () => { try { off() } catch {} }
    return this.dispose
  }

  /** 记一条“这是插件投递的系统消息”，下次同文事件标成 origin=system。 */
  markSystem(sessionId, text) {
    if (!sessionId || !text) return
    const list = this.systemMarks.get(sessionId) || []
    list.push(String(text).slice(0, 80))
    if (list.length > 50) list.splice(0, list.length - 50)
    this.systemMarks.set(sessionId, list)
  }

  ingest(session, event) {
    const sessionId = session && session.id
    if (!sessionId) return
    for (const frame of normalize(event)) {
      let out = frame
      if (frame.kind === 'user') {
        const marks = this.systemMarks.get(sessionId) || []
        const hit = marks.findIndex((m) => frame.text && frame.text.startsWith(m))
        if (hit >= 0) { marks.splice(hit, 1); out = { ...frame, origin: 'system' } }
      }
      this.push(sessionId, { ...out, seq: ++this.seq, sessionId, at: event.time || Date.now() })
    }
  }

  push(sessionId, frame) {
    const list = this.buffers.get(sessionId) || []
    list.push(frame)
    if (list.length > this.limit) list.splice(0, list.length - this.limit)
    this.buffers.set(sessionId, list)
    for (const fn of this.subs) { try { fn(frame) } catch {} }
  }

  since(sessionId, after = 0) {
    return (this.buffers.get(sessionId) || []).filter((f) => f.seq > after)
  }

  clear(sessionId) { this.buffers.delete(sessionId) }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn) }
}
