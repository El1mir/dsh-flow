/**
 * 工单预设组件（v0.012）。
 *
 * 调度在发请示/追问时，除了文字还能带几块**结构化内容**：快捷选项、现状卡片、证据徽标、
 * 链接徽标、变更摘要、进度条、清单、代码片段。人在工单里看到的是可点的控件，不是一大段中文。
 *
 * 三条硬约束（因为内容由 AI 生成）：
 *   1. **白名单**：只认下面九种类型，未知类型静默丢弃（AI 会写错，丢一块比让整条工单发不出去好）；
 *   2. **纯文本渲染**：每个字段都是字符串/数字，客户端不用 innerHTML，不做 HTML 解析；
 *   3. **长度上限**：单块 2000 字符、最多 12 块 —— 工单是给人读的，不是日志搬运工。
 *
 * 这个模块**不 import 任何项目文件**：domain（写入校验）、panel（投影）、tools（schema 描述）都会用它。
 */

export const BLOCK_TYPES = ['note', 'choice', 'facts', 'evidence', 'link', 'progress', 'diff', 'checklist', 'code']
export const MAX_BLOCKS = 12

const TONES = ['info', 'warn', 'danger', 'ok']
const EVIDENCE_KINDS = ['file', 'commit', 'test', 'url', 'issue', 'pr']
const LINK_PROVIDERS = ['github', 'gitea', 'local']
const LINK_KINDS = ['issue', 'pr', 'ci', 'url']

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max)
const num = (v, max = 1e6) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : null
}
const tone = (v) => (TONES.includes(v) ? v : 'info')

function httpUrl(v) {
  const s = str(v, 600)
  if (!s) return ''
  // 只放行 http(s)：javascript: / data: 这类在浏览器里是执行入口，不是链接。
  if (!/^https?:\/\//i.test(s)) return ''
  return s
}

function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return null
  const type = String(raw.type || '')
  if (!BLOCK_TYPES.includes(type)) return null
  if (type === 'note') {
    const text = str(raw.text, 2000)
    if (!text) return null
    return { type, tone: tone(raw.tone), title: str(raw.title, 120), text }
  }
  if (type === 'choice') {
    const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 8).map((o, i) => ({
      value: str((o && o.value) || String.fromCharCode(65 + i), 40),
      label: str(o && o.label, 160),
      impact: str(o && o.impact, 400),
      recommended: !!(o && o.recommended),
    })).filter((o) => o.label)
    if (options.length < 2) return null
    if (options.filter((o) => o.recommended).length > 1) options.forEach((o, i) => { o.recommended = i === 0 })
    const prompt = str(raw.prompt, 300)
    if (!prompt) return null
    return { type, key: str(raw.key, 20) || 'q1', prompt, options, allowText: raw.allowText === true }
  }
  if (type === 'facts') {
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 12).map((it) => ({
      k: str(it && it.k, 80), v: str(it && it.v, 400), tone: it && it.tone ? tone(it.tone) : null,
    })).filter((it) => it.k && it.v)
    if (!items.length) return null
    return { type, title: str(raw.title, 120), items }
  }
  if (type === 'evidence') {
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 12).map((e) => ({
      kind: EVIDENCE_KINDS.includes(e && e.kind) ? e.kind : 'ref',
      ref: str(e && e.ref, 300), label: str(e && e.label, 160), tone: e && e.tone ? tone(e.tone) : null,
    })).filter((e) => e.ref)
    if (!items.length) return null
    return { type, items }
  }
  if (type === 'link') {
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 8).map((l) => ({
      provider: LINK_PROVIDERS.includes(l && l.provider) ? l.provider : 'local',
      kind: LINK_KINDS.includes(l && l.kind) ? l.kind : 'url',
      label: str(l && l.label, 160),
      url: httpUrl(l && l.url),
      number: str(l && l.number, 20),
      state: str(l && l.state, 40),
    })).filter((l) => l.url)
    if (!items.length) return null
    return { type, items }
  }
  if (type === 'progress') {
    const total = num(raw.total)
    const done = num(raw.done)
    if (total === null || done === null || total <= 0) return null
    return { type, label: str(raw.label, 120), done: Math.min(done, total), total }
  }
  if (type === 'diff') {
    const files = num(raw.files)
    const additions = num(raw.additions)
    const deletions = num(raw.deletions)
    if (files === null && additions === null && deletions === null) return null
    return {
      type, base: str(raw.base, 100), head: str(raw.head, 100),
      files: files || 0, additions: additions || 0, deletions: deletions || 0,
    }
  }
  if (type === 'checklist') {
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 20).map((it, i) => ({
      id: str(it && it.id, 40) || 'c' + (i + 1), text: str(it && it.text, 300), checked: !!(it && it.checked),
    })).filter((it) => it.text)
    if (!items.length) return null
    return { type, title: str(raw.title, 120), items }
  }
  if (type === 'code') {
    const text = str(raw.text, 2000)
    if (!text) return null
    return { type, lang: str(raw.lang, 20), text }
  }
  return null
}

/** 规整调度发来的组件数组：丢掉非法块，保留顺序，最多 12 块。 */
export function normalizeBlocks(raw) {
  const arr = Array.isArray(raw) ? raw : []
  const out = []
  for (const item of arr) {
    if (out.length >= MAX_BLOCKS) break
    const b = normalizeOne(item)
    if (b) out.push(b)
  }
  return out
}

/**
 * 压成纯文本：给提示词、message_log、flow_inbox_list 用。
 * 一个块一行 —— 模型读文字比读 JSON 便宜，人也一样。
 */
export function blocksToText(raw) {
  const blocks = normalizeBlocks(raw)
  if (!blocks.length) return ''
  const lines = blocks.map((b) => {
    if (b.type === 'note') return (b.tone === 'danger' || b.tone === 'warn' ? '！' : '·') + ' ' + (b.title ? b.title + '：' : '') + b.text
    if (b.type === 'choice') return '选择 ' + b.key + '：' + b.prompt + '（' + b.options.map((o) => o.value + ' ' + o.label).join(' / ') + '）'
    if (b.type === 'facts') return '现状' + (b.title ? '（' + b.title + '）' : '') + '：' + b.items.map((i) => i.k + '=' + i.v).join('；')
    if (b.type === 'evidence') return '证据：' + b.items.map((e) => e.kind + ':' + e.ref).join(', ')
    if (b.type === 'link') return '链接：' + b.items.map((l) => (l.number ? l.kind + ' #' + l.number : l.label || l.url)).join(', ')
    if (b.type === 'progress') return '进度：' + (b.label ? b.label + ' ' : '') + b.done + '/' + b.total
    if (b.type === 'diff') return '变更：' + b.files + ' 文件 +' + b.additions + '/-' + b.deletions
    if (b.type === 'checklist') return '清单：' + b.items.filter((i) => i.checked).length + '/' + b.items.length + ' 已勾' + (b.title ? '（' + b.title + '）' : '')
    return '代码' + (b.lang ? '(' + b.lang + ')' : '') + '：' + b.text.split(String.fromCharCode(10))[0].slice(0, 80)
  })
  return lines.join(String.fromCharCode(10))
}