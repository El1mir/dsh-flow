/**
 * dsh-flow · remote
 *
 * Gitea / GitHub 的最小客户端与 webhook 归一化（设计文档 14.5 / 15.4 TX-18、TX-19）。
 * 只做三件事：拉 issue/PR 列表、把 webhook 变成统一信封、把本地状态推回远程。
 * 网络失败一律返回 { ok:false, reason }，由 scheduler 决定下次再试。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const HOUR = 60 * 60 * 1000

/** HMAC-SHA256 验签（Gitea: X-Gitea-Signature；GitHub: X-Hub-Signature-256 = sha256=…）。 */
export function verifySignature(secret, rawBody, signature) {
  if (!secret) return true
  if (!signature) return false
  const got = String(signature).replace(/^sha256=/, '').trim().toLowerCase()
  const want = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (got.length !== want.length) return false
  try {
    return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'))
  } catch {
    return false
  }
}

/** 把 Gitea / GitHub 的 webhook 归一成事件信封；不认识的返回 null。 */
export function normalizeWebhook(source, headers = {}, body = {}) {
  const h = {}
  for (const [k, v] of Object.entries(headers)) h[String(k).toLowerCase()] = v
  const giteaEvent = h['x-gitea-event']
  const githubEvent = h['x-github-event']
  const event = String(giteaEvent || githubEvent || '').toLowerCase()
  const action = String(body.action || '').toLowerCase() || 'updated'

  const pick = (kind, obj, extra = {}) => {
    const num = obj && (obj.number || obj.id)
    if (!num) return null
    const updated = obj.updated_at || obj.updated || new Date().toISOString()
    const refId = String(num)
    return {
      source: source || (giteaEvent ? 'gitea' : 'github'),
      type: 'issue.mirrored',
      refKind: kind,
      refId,
      dedupeKey: [source || 'remote', kind, refId, action, updated].join(':'),
      payload: {
        remoteId: refId,
        kind,
        action,
        title: obj.title || '',
        body: obj.body || '',
        state: obj.state || 'open',
        rev: String(updated),
        branch: (obj.head && obj.head.ref) || null,
        headSha: (obj.head && obj.head.sha) || null,
        baseSha: (obj.base && obj.base.sha) || null,
        merged: !!obj.merged,
        // v1.35：远程合并的提交号。review_approve 要求 mergedCommit（v1.32），
        // 原来这里不带，远程合并的卡永远收不了口（静默 catch）。
        mergeCommitSha: obj.merge_commit_sha || null,
        url: obj.html_url || obj.url || null,
        // v1.22：标签 / 关闭原因 / 里程碑 / 负责人 一起进信封，出站入站都靠这几个字段对账
        labels: Array.isArray(obj.labels)
          ? obj.labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean)
          : [],
        stateReason: obj.state_reason || null,
        milestone: (obj.milestone && obj.milestone.title) || null,
        assignees: Array.isArray(obj.assignees) ? obj.assignees.map((a) => (a && a.login) || '').filter(Boolean) : [],
        ...extra,
      },
      at: new Date().toISOString(),
    }
  }

  if (event === 'issues' || event === 'issue') return pick('issue', body.issue)
  if (event === 'pull_request' || event === 'pull_request_review' || event === 'pull') return pick('pull', body.pull_request)
  if (event === 'issue_comment') {
    const c = body.comment || {}
    return pick('issue', body.issue, {
      comment: c.body || '',
      commentId: c.id ? String(c.id) : null,
      commentLogin: (c.user && c.user.login) || null,
      commentUrl: c.html_url || null,
    })
  }
  if (body.issue) return pick('issue', body.issue)
  if (body.pull_request) return pick('pull', body.pull_request)
  return null
}

function apiBase(remote) {
  if (remote.kind === 'github') return (remote.baseUrl || 'https://api.github.com').replace(/\/$/, '')
  // gitea 必须显式配 baseUrl：缺了别拼出相对 URL 去 fetch（会抛 URL parse 错）
  if (!remote.baseUrl) return null
  return remote.baseUrl.replace(/\/$/, '') + '/api/v1'
}

function headersFor(remote) {
  const h = { accept: 'application/json', 'user-agent': 'dsh-flow' }
  if (remote.token) {
    h.authorization = remote.kind === 'github' ? 'Bearer ' + remote.token : 'token ' + remote.token
  }
  return h
}

/**
 * 用 GitHub CLI 换一个 token。
 *
 * 为什么要它：`gh auth token` 已经在本机的 keyring 里，用户既不会（也不该）把
 * PAT 贴在项目配置里。没有 gh 就返回 null，上层照旧走 token 或匿名。
 * 只读一次，调用方自己缓存。
 */
export async function ghToken() {
  const { execFile } = await import("node:child_process")
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null)
      const t = String(stdout || "").trim()
      resolve(t || null)
    })
  })
}

/**
 * 远程配置补上 token：显式 token > gh CLI > 匿名。
 *
 * v1.27：**这个函数以前只被 probeRepo 用过**。
 * 真正发同步请求的那些函数（listIssues / createComment / createRemoteIssue /
 * addIssueLabel …）全都直接拿 cfg.remote，而 cfg.remote.token 通常是空的
 * （用户靠 gh CLI 登录，不该把 PAT 贴在配置里）。于是所有请求都是匿名的：
 * GitHub 对匿名 IP 只给 60 次/小时，实际表现是每 5 分钟一次 403 限流熔断，
 * 同步器一直在跑、什么都没成 —— 线上 T-012 本地 24 条评论、远端只有 1 条。
 *
 * 现在的规矩：**任何一个会真正打网络的对外函数，都必须先过 withToken。**
 * 用 remote.js 里的 sendJson/getJson 是做不到自动注入的（它们是同步纯函数、
 * 不该自己去跑子进程），所以由导出函数在入口处解析一次并往下传。
 */
export async function withToken(remote) {
  if (!remote) return remote
  if (remote.token) return remote
  if (remote.kind !== "github" || remote.useGhCli === false) return remote
  const t = await ghToken()
  return t ? { ...remote, token: t } : remote
}

/**
 * 探一个仓库的事实：默认分支、issue 开没开、是不是 fork / 归档。
 *
 * 这是「能不能把 issue 车道接上」的唯一判据：上游没开 issue 时，
 * 打开 recordIssues 只会让同步永远拉回空列表，还会白建一套 issue 工位。
 */
export async function probeRepo({ remote, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const r = await withToken(remote)
  const res = await getJson(base + "/repos/" + r.owner + "/" + r.repo, r, fetchImpl)
  if (!res.ok) return res
  const d = res.data || {}
  return {
    ok: true,
    fullName: d.full_name || (remote.owner + "/" + remote.repo),
    defaultBranch: d.default_branch || null,
    hasIssues: d.has_issues === true,
    private: d.private === true,
    fork: d.fork === true,
    archived: d.archived === true,
  }
}

async function getJson(url, remote, fetchImpl) {
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: 'no-fetch' }
  remote = await withToken(remote)
  try {
    const res = await f(url, { headers: headersFor(remote) })
    if (!res.ok) {
      let detail = ''
      try {
        const body = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json())
        detail = String(body || '')
        if (remote && remote.token) detail = detail.split(String(remote.token)).join('[redacted]')
        detail = detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2000)
      } catch {}
      return { ok: false, status: res.status, reason: 'http-' + res.status, detail }
    }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

const iso = (v) => (v ? String(v) : null)

/**
 * v1.21：列表请求的排序参数。
 *
 * 为什么必须排序：游标靠 updated_at 推进，而两个 API 默认都按 created desc 返回。
 * 不排序时「最后一行的 updated_at」既不是最大值、也不是最小值，取决于谁最近被创建；
 * 排序之后第一页至少覆盖「最近更新的一批」，游标才有意义。
 */
export const sortQuery = (remote) => (remote && remote.kind === 'github'
  ? { sort: 'updated', direction: 'desc' }
  : { sort: 'recentupdate' })

/**
 * v1.21：游标取**所有行 updated_at 的最大值**，不再取末行。
 *
 * 原来的写法是 `rows[rows.length - 1].updated_at`，在 GitHub/Gitea 默认的 created desc
 * 下末行就是这一页里**最旧**的那条，游标会被钉在过去，之后每轮都重拉同一批。
 */
export const maxStamp = (rows) => rows.reduce((acc, it) => {
  const t = iso(it && (it.updated_at || it.updated))
  return t && (!acc || t > acc) ? t : acc
}, null)

/** 拉 issue 列表（Gitea 与 GitHub 字段不同，这里归一化）。 */
export async function listIssues({ remote, since = null, limit = 50, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const q = new URLSearchParams({ state: 'all', limit: String(limit), per_page: String(limit) })
  // v1.21：显式排序，见 sortQuery 注释
  for (const [k, v] of Object.entries(sortQuery(remote))) q.set(k, v)
  if (since) q.set('since', since)
  const url = base + '/repos/' + remote.owner + '/' + remote.repo + '/issues?' + q.toString()
  const res = await getJson(url, remote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  const items = rows
    .filter((it) => !it.pull_request)
    .map((it) => ({
      remoteId: String(it.number || it.id),
      remoteRev: iso(it.updated_at || it.updated),
      kind: 'issue',
      title: it.title || '',
      body: it.body || '',
      state: it.state || 'open',
      url: it.html_url || it.url || null,
      // C-09：建卡要用 created_at 判 since（「只接管配置之后出现的 issue」）。
      // 少了这一行，事件信封里没有创建时间，scheduler 的 since 守卫只能放行 —— 等于空转。
      createdAt: iso(it.created_at || null),
    }))
  return { ok: true, items, cursor: maxStamp(rows) }
}

/** 拉 PR 列表（只看合并状态与 head 分支，用于把远程合并同步回本地）。 */
export async function listPulls({ remote, since = null, limit = 50, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const q = new URLSearchParams({ state: 'all', limit: String(limit), per_page: String(limit) })
  for (const [k, v] of Object.entries(sortQuery(remote))) q.set(k, v)
  if (since) q.set('since', since)
  const url = base + '/repos/' + remote.owner + '/' + remote.repo + '/pulls?' + q.toString()
  const res = await getJson(url, remote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  const items = rows.map((it) => ({
    remoteId: String(it.number || it.id),
    remoteRev: iso(it.updated_at || it.updated),
    kind: 'pull',
    title: it.title || '',
    body: it.body || '',
    state: it.merged ? 'merged' : (it.state || 'open'),
    branch: (it.head && it.head.ref) || null,
    headSha: (it.head && it.head.sha) || null,
    baseSha: (it.base && it.base.sha) || null,
    // RT-01：外部 PR 入站要 author/headRepo；远程合并要 baseRef/mergeableState。
    // 全部 null 安全：Gitea 的老版本 /pulls 不保证带 head.repo。
    author: (it.user && (it.user.login || it.user.username)) || null,
    headRepo: (it.head && it.head.repo && (it.head.repo.full_name || it.head.repo.name)) || null,
    headRef: (it.head && it.head.ref) || null,
    baseRef: (it.base && it.base.ref) || null,
    mergeableState: it.mergeable_state || null,
    merged: !!it.merged,
    url: it.html_url || it.url || null,
  }))
  return { ok: true, items, cursor: maxStamp(rows) }
}

/** 本地卡推成远程 issue（pushRemote 打开时才用）。 */
export async function createRemoteIssue({ remote, title, body, fetchImpl } = {}) {
  if (!remote || !remote.owner || !remote.repo) return { ok: false, reason: 'remote 未配置' }
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: 'no-fetch' }
  remote = await withToken(remote)
  const base = apiBase(remote)
  const url = base + '/repos/' + remote.owner + '/' + remote.repo + '/issues'
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { ...headersFor(remote), 'content-type': 'application/json' },
      body: JSON.stringify({ title: String(title || '').slice(0, 200), body: String(body || '') }),
    })
    if (!res.ok) return { ok: false, status: res.status, reason: 'http-' + res.status }
    const data = await res.json()
    return { ok: true, remoteId: String(data.number || data.id), url: data.html_url || null }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

/**
 * 通用 JSON 请求（v1.22）。
 *
 * 为什么单开一个而不是继续用 getJson：出站要 POST/PATCH/DELETE，还要把
 * 202/204 这类没有 body 的成功响应当成成功。getJson 假设所有成功响应都是 JSON，
 * 用在 DELETE 上会抛。
 */
async function sendJson(url, remote, { method = 'GET', body = undefined, includeErrorBody = false } = {}, fetchImpl) {
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: 'no-fetch' }
  remote = await withToken(remote)
  const init = { method, headers: headersFor(remote) }
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  try {
    const res = await f(url, init)
    if (!res.ok) {
      let detail = ''
      let errBody
      try {
        errBody = await res.json()
        detail = JSON.stringify(errBody).slice(0, 300)
      } catch { /* 没有 body 就算了 */ }
      const out = { ok: false, status: res.status, reason: 'http-' + res.status, detail }
      // RT-01：mergePull 要按 forge 的 message 文案分类（405 的 protected/review 关键词）。
      // 默认不带解析后的 body，既有调用方拿到的形状一个键都不变。
      if (includeErrorBody) out.data = errBody === undefined ? null : errBody
      return out
    }
    if (res.status === 204) return { ok: true, data: null }
    const text = typeof res.text === 'function' ? await res.text() : ''
    if (!text) return { ok: true, data: null }
    try {
      return { ok: true, data: JSON.parse(text) }
    } catch {
      return { ok: true, data: null }
    }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

const repoUrl = (base, remote) => base + '/repos/' + remote.owner + '/' + remote.repo

/**
 * 拉仓库里的评论流（v1.22）。
 *
 * 与 listIssues 不同的地方：评论没有自己的 number，靠 id 定位；而且它的
 * updated_at 会因为编辑而变，所以游标同样必须取 max 而不是末行。
 */
export async function listComments({ remote, since = null, limit = 100, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const q = new URLSearchParams({ per_page: String(limit) })
  for (const [k, v] of Object.entries(sortQuery(remote))) q.set(k, v)
  if (since) q.set('since', since)
  const url = repoUrl(base, remote) + '/issues/comments?' + q.toString()
  const res = await getJson(url, remote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  const items = rows.map((c) => ({
    commentId: String(c.id),
    remoteId: String(c.issue_url || '').split('/').pop() || null,
    issueNumber: Number(String(c.issue_url || '').split('/').pop() || 0) || null,
    body: c.body || '',
    login: (c.user && c.user.login) || null,
    url: c.html_url || null,
    createdAt: iso(c.created_at),
    updatedAt: iso(c.updated_at),
    reactions: (c.reactions && (c.reactions.total_count || 0)) || 0,
    authorAssociation: c.author_association || null,
  }))
  return { ok: true, items, cursor: maxStamp(rows) }
}

/** 在某个 issue 下建评论（出站）。 */
export async function createComment({ remote, issueNumber, body, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const url = repoUrl(base, remote) + '/issues/' + Number(issueNumber) + '/comments'
  const res = await sendJson(url, remote, { method: 'POST', body: { body: String(body || '') } }, fetchImpl)
  if (!res.ok) return res
  const d = res.data || {}
  return { ok: true, commentId: d.id ? String(d.id) : null, url: d.html_url || null }
}

/**
 * 改 issue 本身（state / state_reason / title / body）。
 *
 * state_reason 是 v1.22 才用上的：`closed + not_planned` 表示「取消」，与
 * `closed + completed`（真正做完）在 GitHub 上是两个不同的语义，本地必须能分开写。
 */
export async function patchIssue({ remote, issueNumber, patch = {}, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const url = repoUrl(base, remote) + '/issues/' + Number(issueNumber)
  const body = {}
  if (patch.state) body.state = patch.state
  if (patch.stateReason) body.state_reason = patch.stateReason
  if (patch.title) body.title = String(patch.title).slice(0, 200)
  if (patch.body !== undefined) body.body = String(patch.body)
  const res = await sendJson(url, remote, { method: 'PATCH', body }, fetchImpl)
  if (!res.ok) return res
  return { ok: true, data: res.data }
}

/** 给 issue 加一个标签。 */
export async function addIssueLabel({ remote, issueNumber, label, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const url = repoUrl(base, remote) + '/issues/' + Number(issueNumber) + '/labels'
  return sendJson(url, remote, { method: 'POST', body: { labels: [String(label)] } }, fetchImpl)
}

/** 从 issue 摘一个标签。 */
export async function removeIssueLabel({ remote, issueNumber, label, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const name = encodeURIComponent(String(label))
  const url = repoUrl(base, remote) + '/issues/' + Number(issueNumber) + '/labels/' + name
  return sendJson(url, remote, { method: 'DELETE' }, fetchImpl)
}

/** 读仓库已有标签（出站建标签前先看有没有，避免 422）。 */
export async function listLabels({ remote, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const res = await getJson(repoUrl(base, remote) + '/labels?per_page=100', remote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  return { ok: true, names: rows.map((l) => (l && l.name) || '').filter(Boolean) }
}

/** 建仓库标签（`flow/running` 这类受管标签第一次出站时要先存在）。 */
export async function createLabel({ remote, name, color, description, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const base = apiBase(remote)
  const url = repoUrl(base, remote) + '/labels'
  return sendJson(url, remote, {
    method: 'POST',
    body: { name: String(name), color: String(color || 'ededed'), description: String(description || '') },
  }, fetchImpl)
}

/** 建远程 PR（本地合并走本地，远程 PR 只用来让人看见进度）。 */
export async function createPull({ remote, title, head, base, body, draft = false, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const authorizedRemote = await withToken(remote)
  const api = apiBase(authorizedRemote)
  const url = repoUrl(api, authorizedRemote) + '/pulls'
  const res = await sendJson(url, authorizedRemote, {
    method: 'POST',
    body: { title: String(title || '').slice(0, 200), head: String(head || ''), base: String(base || 'main'), body: String(body || ''), draft: !!draft },
  }, fetchImpl)
  if (!res.ok) return res
  const d = res.data || {}
  return { ok: true, number: d.number || null, url: d.html_url || null, state: d.state || 'open' }
}

/**
 * 远端配置的可用性检查（v1.36：18 个函数各写一遍同样的两行判断）。
 * 返回 null 表示可用，否则返回给人看的拒绝原因。
 */
export function remoteReady(remote) {
  if (!remote || !remote.owner || !remote.repo) return 'remote 未配置'
  if (!apiBase(remote)) return 'remote.baseUrl 未配置'
  return null
}

/** 读单个 PR（拿 merged / mergeable / 合并事件三元组）。 */
export async function getPull({ remote, number, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const api = apiBase(remote)
  const res = await getJson(repoUrl(api, remote) + '/pulls/' + Number(number), remote, fetchImpl)
  if (!res.ok) return res
  const d = res.data || {}
  return {
    ok: true,
    number: d.number || null,
    state: d.state || null,
    merged: !!d.merged,
    mergedAt: iso(d.merged_at),
    mergeCommitSha: d.merge_commit_sha || null,
    mergedBy: (d.merged_by && d.merged_by.login) || null,
    mergeable: d.mergeable === undefined ? null : d.mergeable,
    mergeableState: d.mergeable_state || null,
    // v1.35：REST /pulls/{n} 没有 reviewDecision（那是 GraphQL 字段），sync-engine 判的字段原来永远为空。
    // 这里只带出「还在等谁评审」，是否等评审由 sync-engine 结合 reviews 推导。
    requestedReviewers: Array.isArray(d.requested_reviewers) ? d.requested_reviewers.map((u) => (u && u.login) || '').filter(Boolean) : [],
    reviewDecision: d.review_decision || null,
    headSha: (d.head && d.head.sha) || null,
    // RT-01 / spec §12.1：远程合并要判「这个 head 还是不是当初锁定的那个」，
    // 也要知道 head 在哪个仓库（fork 的外部 PR 与同仓库受控 PR 处理方式不同，ADR-0007 §4）。
    headRef: (d.head && d.head.ref) || null,
    headRepo: (d.head && d.head.repo && (d.head.repo.full_name || d.head.repo.name)) || null,
    baseRef: (d.base && d.base.ref) || null,
    // Gitea 的用户对象同时有 login / username；GitHub 只有 login。
    author: (d.user && (d.user.login || d.user.username)) || null,
    url: d.html_url || null,
  }
}

const MERGE_METHODS = ['merge', 'squash', 'rebase']

/**
 * 405 的文案在 GitHub / Gitea 上都不稳定，只能当「倾向性」判断：
 * 命中这里 → 分支保护 / 必需评审 / 必需 checks，重试没有意义，要阻塞找人；
 * 没命中 → 当冲突（可回派工人）。
 * 关键词表由 test/remote-merge-api.mjs 的 ③④⑤ 钉住，改这里必须同步改测试。
 */
const MERGE_PROTECTED_RE = /protected|branch\s+protection|review|approv|status\s+check|\bchecks?\b/i

/** 统一的返回形状：六键永远齐全，调用方不必判 undefined。 */
const mergeResult = ({ ok = false, merged = false, mergeCommitSha = null, status = 0, reason = 'unknown', message = '' } = {}) => ({
  ok: !!ok,
  merged: !!merged,
  mergeCommitSha: mergeCommitSha || null,
  status: Number(status) || 0,
  reason,
  message: String(message || ''),
})

/**
 * status + message → reason。**不猜**：认不出的状态一律 'unknown'，
 * 原始 status/message 照样带出去，让 RT-02 自己决定要不要升级成工单（ADR-0007 §3）。
 */
function classifyMergeFailure(status, message) {
  const text = String(message || '')
  if (!status) return 'server' // 网络异常 / 超时 / 没有可用的 fetch
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'missing'
  if (status === 405) return MERGE_PROTECTED_RE.test(text) ? 'protected' : 'conflict'
  if (status === 409) return 'head-moved'
  if (status >= 500) return 'server'
  return 'unknown'
}

/** 从响应里取 forge 的原始文案（分类与工单都要它）。 */
function forgeMessage(res) {
  const d = res && res.data
  const msg = d && (typeof d === 'string' ? d : (d.message || d.error || d.msg))
  return String(msg || (res && res.detail) || (res && res.reason) || '')
}

/**
 * RT-01 / spec §12.1：让 forge 合并 PR（远程模式的唯一合并入口）。
 *
 * 与 closePull 的区别是「结果必须可判定」：调用方要能分清
 * 冲突 / 分支保护 / head 被移动 / 认证失效 / PR 不存在 / 服务端故障，
 * 每一种对应不同的 blocked 原因与工单文案（ADR-0007 §3/§4）。
 * 所以返回体固定六键（ok/merged/mergeCommitSha/status/reason/message），
 * 永远保留原始 status 与 message —— 文案不稳定时 RT-02 还能自己再判一次。
 *
 * 不自动重试：重试策略在 RT-02（票 §约束）。
 *
 * @param {{remote:object, number:number, sha?:string, method?:'merge'|'squash'|'rebase',
 *          commitTitle?:string, commitMessage?:string, fetchImpl?:Function}} args
 * @returns {Promise<{ok:boolean, merged:boolean, mergeCommitSha:string|null,
 *          status:number, reason:'merged'|'conflict'|'protected'|'head-moved'|'auth'|
 *          'missing'|'server'|'not-merged'|'unknown', message:string}>}
 */
export async function mergePull({ remote, number, sha, method = 'merge', commitTitle, commitMessage, fetchImpl } = {}) {
  // 票 §1：只接受这三个值，其它抛错 —— 静默 fallback 会把 squash 变成空提交堆。
  if (!MERGE_METHODS.includes(method)) {
    throw new Error('mergePull: 不支持的 method ' + JSON.stringify(method) + '（只接受 merge/squash/rebase）')
  }
  const miss = remoteReady(remote)
  if (miss) return mergeResult({ status: 0, reason: 'unknown', message: miss })
  const api = apiBase(remote)
  const url = repoUrl(api, remote) + '/pulls/' + Number(number) + '/merge'
  // 两边只在「动词 + 字段名」上不同，成功/失败的判定与分类共用一条尾巴。
  let request
  if (remote.kind === 'github') {
    const body = { merge_method: method }
    if (commitTitle !== undefined) body.commit_title = String(commitTitle)
    if (commitMessage !== undefined) body.commit_message = String(commitMessage)
    if (sha !== undefined) body.sha = String(sha)
    request = { method: 'PUT', body }
  } else if (remote.kind === 'gitea') {
    // 字段名取自 Gitea 文档，但**未在本仓库实测**（票 §1）：这里只钉请求形状。
    // canMergePull[gitea] 仍是 false，所以远程模式目前不会真的走到这一支。
    const body = { Do: method }
    if (commitTitle !== undefined) body.MergeTitleField = String(commitTitle)
    if (commitMessage !== undefined) body.MergeMessageField = String(commitMessage)
    if (sha !== undefined) body.head_commit_id = String(sha)
    request = { method: 'POST', body }
  } else {
    return mergeResult({ reason: 'unknown', message: 'unsupported provider: ' + String(remote.kind) })
  }

  const res = await sendJson(url, remote, { ...request, includeErrorBody: true }, fetchImpl)
  if (res.ok) {
    const d = res.data || {}
    // GitHub：只有 merged === true 才算合了。Gitea：文档里有 merged 字段的实现不多，
    // 带 merge_commit_sha 同样视为成功（票 §1）。空 body 一律 not-merged —— 不假装成功。
    const merged = remote.kind === 'github'
      ? d.merged === true
      : (d.merged === true || !!d.merge_commit_sha)
    const mergeCommitSha = remote.kind === 'github' ? d.sha : (d.merge_commit_sha || d.sha)
    if (merged) {
      return mergeResult({ ok: true, merged: true, mergeCommitSha, status: 200, reason: 'merged', message: d.message || 'merged' })
    }
    return mergeResult({ status: 200, reason: 'not-merged', message: d.message || 'forge 未确认合并' })
  }
  const message = forgeMessage(res)
  return mergeResult({ status: res.status, reason: classifyMergeFailure(res.status, message), message })
}

/**
 * rf-05：关远程 PR（不删分支）。
 *
 * GitHub 与 Gitea 同形：`PATCH /repos/{owner}/{repo}/pulls/{n} {state:'closed'}`。
 *
 * 为什么这一条必须由我们发：本地合并落地后，远程 PR 只会一直挂在 open 等 forge
 * 自己认领 —— 那是我们没法测试、也没法承诺的外部行为。人打开仓库看到的是"13 个
 * 还开着的 PR，一个都没合"，与本地看板完全对不上。
 *
 * 与 `patchIssue` 一样，token 由调用方解析好再传进来（sync-engine 走 remoteFor）。
 */
export async function closePull({ remote, number, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const url = repoUrl(apiBase(remote), remote) + '/pulls/' + Number(number)
  const res = await sendJson(url, remote, { method: 'PATCH', body: { state: 'closed' } }, fetchImpl)
  if (!res.ok) return res
  return { ok: true, data: res.data }
}

/**
 * rf-03：列仓库里**开放**的 PR（外部 PR 入站的唯一入口）。
 *
 * 与 `listPulls`（:236）的两处区别，都是刻意的：
 *  1. `state=open` —— 入站只关心还在开的；已合并/已关闭的历史进来看板会被灌满；
 *  2. **不发** sort / direction。Gitea 老版本的 /pulls 对这两个参数支持不全，
 *     与其让它默默无效、让分页顺序变得不可解释，不如只传 `state` + `per_page`，
 *     排序在本地按 created_at 倒序做（票 C-02 §风险第 1 条）。
 *
 * 返回归一化条目；`state !== 'open'` 与已合并的行一律滤掉 —— 服务端不保证只给我们
 * open 的（Gitea 对 state 的实现有过回归），这一层过滤是判据 ⑥ 的第一道防线。
 */
export async function listOpenPulls({ remote, limit = 50, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const authorizedRemote = await withToken(remote)
  const base = apiBase(authorizedRemote)
  const q = new URLSearchParams({ state: 'open', per_page: String(limit) })
  const url = repoUrl(base, authorizedRemote) + '/pulls?' + q.toString()
  const res = await getJson(url, authorizedRemote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  const items = rows
    .filter((it) => it && !it.merged && String(it.state || 'open') === 'open')
    .map((it) => ({
      number: Number(it.number || it.id) || null,
      title: it.title || '',
      url: it.html_url || it.url || null,
      state: 'open',
      headBranch: (it.head && it.head.ref) || null,
      headSha: (it.head && it.head.sha) || null,
      baseBranch: (it.base && it.base.ref) || null,
      baseSha: (it.base && it.base.sha) || null,
      author: (it.user && it.user.login) || null,
      createdAt: iso(it.created_at),
      updatedAt: iso(it.updated_at || it.updated),
    }))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return { ok: true, items }
}

/** 读 PR 的评审（人给的 verdict 与本地 review_prompts 的 verdict 分记，不合流）。 */
export async function listPullReviews({ remote, number, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const api = apiBase(remote)
  const res = await getJson(repoUrl(api, remote) + '/pulls/' + Number(number) + '/reviews?per_page=100', remote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  return {
    ok: true,
    items: rows.map((r) => ({
      reviewId: r.id ? String(r.id) : null,
      login: (r.user && r.user.login) || null,
      state: String(r.state || '').toUpperCase(),
      body: r.body || '',
      submittedAt: iso(r.submitted_at),
      url: r.html_url || null,
    })),
  }
}

/** 读某个 commit 的 check-runs（ci_failed 唤醒用）。 */
export async function listCheckRuns({ remote, sha, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const api = apiBase(remote)
  const res = await getJson(repoUrl(api, remote) + '/commits/' + String(sha) + '/check-runs?filter=latest&per_page=100', remote, fetchImpl)
  if (!res.ok) return res
  const d = res.data || {}
  const rows = Array.isArray(d.check_runs) ? d.check_runs : []
  return {
    ok: true,
    total: rows.length,
    completed: rows.filter((c) => c && c.status === 'completed').length,
    failed: rows.filter((c) => c && c.status === 'completed' && c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped').length,
    items: rows.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url || null })),
  }
}

/** 读子议题（GitHub；用只读渲染，不双写本地 subtasks）。 */
export async function listSubIssues({ remote, issueNumber, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const api = apiBase(remote)
  const res = await getJson(repoUrl(api, remote) + '/issues/' + Number(issueNumber) + '/sub_issues?per_page=100', remote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  return {
    ok: true,
    items: rows.map((it) => ({
      number: it.number,
      title: it.title || '',
      state: it.state || 'open',
      url: it.html_url || null,
    })),
  }
}

/** 读仓库里程碑（只读渲染，不在本地建实体）。 */
export async function listMilestones({ remote, fetchImpl } = {}) {
  const miss = remoteReady(remote)
  if (miss) return { ok: false, reason: miss }
  const api = apiBase(remote)
  const res = await getJson(repoUrl(api, remote) + '/milestones?state=all&per_page=50', remote, fetchImpl)
  if (!res.ok) return res
  const rows = Array.isArray(res.data) ? res.data : []
  return {
    ok: true,
    items: rows.map((m) => ({
      number: m.number,
      title: m.title || '',
      state: m.state || 'open',
      dueOn: iso(m.due_on),
      openIssues: m.open_issues || 0,
      closedIssues: m.closed_issues || 0,
      url: m.html_url || null,
    })),
  }
}

/** TX-19：拉一次并落库（镜像 + 事件 + 游标同一事务）。 */
export async function syncProject({ domain, project, fetchImpl, withPulls = true } = {}) {
  const remote = project && project.config && project.config.remote
  if (!remote) return { ok: false, reason: '项目没配 remote' }
  const source = remote.kind || 'gitea'
  const cursor = domain.cursorFor(project.id, source)
  // v1.21：since 只喂 issues。GitHub 的 /pulls 不支持 since（多传一个查询参数不会报错但也不会过滤），
  // 与其让它默默无效，不如靠 sort=updated + remoteRev 去重。
  const issues = await listIssues({ remote, since: cursor, fetchImpl })
  if (!issues.ok) return issues
  const pulls = withPulls ? await listPulls({ remote, fetchImpl }) : { ok: true, items: [] }
  const items = [...(issues.items || []), ...(pulls.ok ? pulls.items || [] : [])]
  // 两个列表各自有游标，取较大的那个往前推；任一为空时退回另一个，最后退回老游标。
  const stamps = [issues.cursor, pulls.ok ? pulls.cursor : null].filter(Boolean).sort()
  const nextCursor = stamps.length ? stamps[stamps.length - 1] : cursor
  const stats = await domain.syncRemote(project.id, { source, cursor: nextCursor || null, items })
  return { ok: true, source, cursor: nextCursor || null, pulled: items.length, stats, pulls: (pulls.items || []).length }
}

export const _HOUR = HOUR
