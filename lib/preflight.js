/**
 * 环境自检（v0.016 / ticket 10）。
 *
 * 「API key 不正确」「连不上后端」这类失败，本质是**开工前**就能查出来的事实，
 * 却让工人跑了八轮才发现（线上 BiliNote 的 200105 就是这么连烧了三个 run）。
 * 这个模块只做一件事：按项目声明探一遍，给出一份能读的清单。
 *
 * seam：网络与文件系统都通过 `deps` 注入，测试里不必发真实请求（spec 的 testing decisions）。
 */

export const PREFLIGHT_TTL_MS = 30 * 60 * 1000

const defaultFileExists = async (path) => {
  const { existsSync } = await import('node:fs')
  return existsSync(path)
}

const defaultFetch = async (url, timeoutMs) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, method: 'GET' })
    return { ok: res.ok, status: res.status }
  } finally { clearTimeout(timer) }
}

export function preflightConfig(project) {
  const list = project && project.config && project.config.preflight
  return Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : []
}

function configKey(list) {
  return JSON.stringify(list.map((x) => [x.type || 'file', x.path || x.url || '', x.expect || '']))
}

/**
 * 跑一遍自检。返回 `{ ok, items, at, cached }`。
 *
 * 缓存 30 分钟（`project.preflight`）；项目改动后立即失效 —— 判据是配置的指纹，
 * 而不是时间戳，因为「改完配置再等 30 分钟」比不缓存更让人难受。
 */
export async function probe(project, { now = () => Date.now(), deps = {}, force = false, root = null } = {}) {
  const list = preflightConfig(project)
  if (!list.length) return { ok: true, items: [], at: new Date(now()).toISOString(), cached: false, skipped: 'no-checks' }
  const key = configKey(list)
  const prev = project && project.preflight
  const fresh = prev && prev.configKey === key && (now() - (Date.parse(prev.at || 0) || 0)) < PREFLIGHT_TTL_MS
  if (fresh && !force) return { ok: prev.ok === true, items: prev.items || [], at: prev.at, cached: true }
  const fileExists = deps.fileExists || defaultFileExists
  const fetchImpl = deps.fetch || defaultFetch
  const items = []
  for (const check of list) {
    const type = String(check.type || 'file')
    const hint = String(check.hint || '')
    if (type === 'http') {
      const url = String(check.url || '')
      if (!url) { items.push({ type, target: '(未填 url)', ok: false, hint: '配置漏了 url' }); continue }
      let ok = false; let detail = ''
      try { const res = await fetchImpl(url, Number(check.timeoutMs) || 3000); ok = res && res.ok === true; detail = res && res.status ? 'HTTP ' + res.status : '' } catch (err) { detail = String((err && err.message) || err).slice(0, 120) }
      items.push({ type, target: url, ok, hint, detail })
    } else if (type === 'dir') {
      const path = String(check.path || '')
      const ok = path ? await fileExists(root && !/^[a-zA-Z]:[\\/]|^[\\/]/.test(path) ? (root + '/' + path) : path).catch(() => false) : false
      items.push({ type, target: path || '(未填 path)', ok, hint })
    } else {
      const path = String(check.path || '')
      const ok = path ? await fileExists(root && !/^[a-zA-Z]:[\\/]|^[\\/]/.test(path) ? (root + '/' + path) : path).catch(() => false) : false
      items.push({ type: 'file', target: path || '(未填 path)', ok, hint })
    }
  }
  const ok = items.every((i) => i.ok)
  return { ok, items, at: new Date(now()).toISOString(), cached: false, configKey: key }
}

/** 缺失项（给请示正文用）。 */
export function missing(items) {
  return (items || []).filter((i) => !i.ok)
}

/** 一行摘要（进案卷）：✔ .env ✔ backend:8484（3 条）。 */
export function renderLine(result) {
  if (!result || result.skipped === 'no-checks') return null
  const items = result.items || []
  if (!items.length) return null
  const short = (i) => {
    const t = String(i.target || '')
    const name = i.type === 'http' ? t.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : t
    return (i.ok ? '✔ ' : '✘ ') + name
  }
  return '环境自检：' + items.map(short).join(' ') + '（' + items.length + ' 条' + (result.cached ? '，缓存' : '') + '）'
}

/** 可读清单（请示正文用）：每项 ✔/✘ + 一句提示。 */
export function renderChecklist(result) {
  const items = result && result.items ? result.items : []
  if (!items.length) return ''
  return items.map((i) => (i.ok ? '✔ ' : '✘ ') + i.target + (i.hint ? ' — ' + i.hint : '') + (i.detail ? '（' + i.detail + '）' : '')).join('\n')
}