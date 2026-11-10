/**
 * RT-01：forge merge API（mergePull）+ getPull/listPulls 扩字段 + canMergePull。
 *
 * 这些用例全部用假的 fetchImpl，**一个网络请求都不发**。它们钉的是 RT-02 远程合并
 * 依赖的最小契约：
 *   ①-⑧.  GitHub merge 的请求形状与状态分类（成功 / not-merged / 冲突 / 保护 /
 *         401 / 404 / 5xx / 网络异常）。分类错了 RT-02 会把「分支保护」当「冲突」
 *         回派工人，或者把「网络抖动」当「已合并」继续收口 —— 两种都是不可逆的错。
 *   ⑨.   不支持的 merge method 必须抛错，不能静默 fallback 成 merge。
 *   ⑩-⑬. Gitea 请求形状与返回判定（字段名未实测，所以 canMergePull[gitea] 仍是 false）。
 *   ⑭.   remote 没配齐：不发请求。
 *   ⑮-⑰. getPull / listPulls 扩字段，且**旧键一个都不能少**（RT-03/RT-06 在读）。
 *   ⑱.   remoteCapabilities.canMergePull 的配置闸门。
 *
 * 回归：本文件只管新契约；test/pr-snapshot.mjs 与 test/external-ingest.mjs 另外跑，
 * 它们钉住 getPull/listPulls 的既有消费方。
 */
import assert from 'node:assert/strict'
import { mergePull, getPull, listPulls } from '../lib/remote.js'
import { remoteCapabilities } from '../lib/sync.js'

let pass = 0
const fails = []
async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ok ' + pass + ' - ' + name)
  } catch (err) {
    fails.push({ name, err })
    console.log('  FAIL ' + name)
    console.log('    ' + String((err && err.message) || err).split(String.fromCharCode(10))[0])
  }
}

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => (data === undefined ? '' : JSON.stringify(data)),
})

/** 记下每一次请求，返回受控响应。 */
function recorder(handler) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    })
    return handler(String(url), init, seen.length)
  }
  return { fetchImpl, seen }
}

const GITHUB = { kind: 'github', owner: 'acme', repo: 'demo', token: 'tok' }
const GITEA = { kind: 'gitea', owner: 'acme', repo: 'demo', baseUrl: 'https://gitea.example', token: 'tok' }

// ---- 1. GitHub 成功 --------------------------------------------------------

await t('① GitHub 成功：PUT .../pulls/7/merge，body 带 sha/merge_method/commit_title，返回 merged+sha', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes({ merged: true, sha: 'mergesha1', message: 'Pull Request successfully merged' }))
  const res = await mergePull({
    remote: GITHUB, number: 7, sha: 'heads-ha', method: 'squash',
    commitTitle: 'feat: 合一下', commitMessage: 'body text', fetchImpl,
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.github.com/repos/acme/demo/pulls/7/merge')
  assert.equal(seen[0].method, 'PUT')
  assert.deepEqual(seen[0].body, {
    commit_title: 'feat: 合一下',
    commit_message: 'body text',
    sha: 'heads-ha',
    merge_method: 'squash',
  })
  assert.equal(seen[0].headers.authorization, 'Bearer tok')
  assert.equal(res.ok, true)
  assert.equal(res.merged, true)
  assert.equal(res.mergeCommitSha, 'mergesha1')
  assert.equal(res.status, 200)
  assert.equal(res.reason, 'merged')
  assert.deepEqual(Object.keys(res).sort(), ['mergeCommitSha', 'merged', 'message', 'ok', 'reason', 'status'])
})

// ---- 2-8. GitHub 失败分类 ---------------------------------------------------

await t('② GitHub 200 但 merged=false：ok=false，reason=not-merged，保留 message', async () => {
  const { fetchImpl } = recorder(() => jsonRes({ merged: false, message: 'Pull Request is not mergeable' }))
  const res = await mergePull({ remote: GITHUB, number: 7, sha: 'heads-ha', fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.merged, false)
  assert.equal(res.status, 200)
  assert.equal(res.reason, 'not-merged')
  assert.equal(res.message, 'Pull Request is not mergeable')
  assert.equal(res.mergeCommitSha, null)
})

await t('③ 405 "Pull Request is not mergeable" → conflict', async () => {
  const { fetchImpl } = recorder(() => jsonRes({ message: 'Pull Request is not mergeable' }, 405))
  const res = await mergePull({ remote: GITHUB, number: 7, sha: 'heads-ha', fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.status, 405)
  assert.equal(res.reason, 'conflict')
  assert.match(res.message, /not mergeable/)
})

await t('④ 405 "protected branch" → protected', async () => {
  const { fetchImpl } = recorder(() => jsonRes({ message: 'Cannot merge: protected branch hook declined' }, 405))
  const res = await mergePull({ remote: GITHUB, number: 7, fetchImpl })
  assert.equal(res.reason, 'protected')
  assert.equal(res.status, 405)
})

await t('⑤ 405 "At least 1 approving review is required" → protected', async () => {
  const { fetchImpl } = recorder(() => jsonRes({ message: 'At least 1 approving review is required by reviewers with write access.' }, 405))
  const res = await mergePull({ remote: GITHUB, number: 7, fetchImpl })
  assert.equal(res.reason, 'protected')
})

await t('⑥ 409 → head-moved（head 分支被别人改了）', async () => {
  const { fetchImpl } = recorder(() => jsonRes({ message: 'Head branch was modified. Review and try the merge again.' }, 409))
  const res = await mergePull({ remote: GITHUB, number: 7, sha: 'heads-ha', fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.status, 409)
  assert.equal(res.reason, 'head-moved')
})

await t('⑦ 401/403→auth、404→missing、500→server（三种都保留 status 与 message）', async () => {
  const cases = [
    [401, 'auth', 'Bad credentials'],
    [403, 'auth', 'Resource not accessible by integration'],
    [404, 'missing', 'Not Found'],
    [500, 'server', 'Server Error'],
    [503, 'server', 'Service Unavailable'],
  ]
  for (const [status, reason, message] of cases) {
    const { fetchImpl } = recorder(() => jsonRes({ message }, status))
    const res = await mergePull({ remote: GITHUB, number: 7, fetchImpl })
    assert.equal(res.ok, false, status + ' 不能算成功')
    assert.equal(res.status, status, '原始 status 必须保留')
    assert.equal(res.reason, reason, status + ' 的分类')
    assert.equal(res.message, message, status + ' 的原始文案必须保留（RT-02 可能还要再判）')
  }
})

await t('⑧ 网络异常：status=0、reason=server、message 是原始错误', async () => {
  const { fetchImpl, seen } = recorder(() => { throw new Error('ECONNRESET: socket hang up') })
  const res = await mergePull({ remote: GITHUB, number: 7, sha: 'heads-ha', fetchImpl })
  assert.equal(seen.length, 1)
  assert.equal(res.ok, false)
  assert.equal(res.status, 0)
  assert.equal(res.reason, 'server')
  assert.match(res.message, /ECONNRESET/)
})

await t('⑨ 不支持的 method：抛错且一个请求都不发（不静默 fallback 成 merge）', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes({ merged: true, sha: 'x' }))
  await assert.rejects(() => mergePull({ remote: GITHUB, number: 7, method: 'fast-forward', fetchImpl }), /fast-forward/)
  assert.equal(seen.length, 0, '非法 method 不该发请求')
  for (const bad of ['MERGE', 'ff-only', '', null]) {
    await assert.rejects(() => mergePull({ remote: GITHUB, number: 7, method: bad, fetchImpl }), undefined, 'method=' + String(bad))
  }
})

// ---- 10. Gitea 请求形状 -----------------------------------------------------

await t('⑩ Gitea：POST {baseUrl}/api/v1/.../pulls/7/merge，字段是 Do/MergeTitleField/MergeMessageField/head_commit_id', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes({ merged: true, message: 'PR merged' }))
  const res = await mergePull({
    remote: GITEA, number: 7, sha: 'heads-ha', method: 'squash',
    commitTitle: 'feat: 合一下', commitMessage: 'body text', fetchImpl,
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://gitea.example/api/v1/repos/acme/demo/pulls/7/merge')
  assert.equal(seen[0].method, 'POST')
  assert.deepEqual(seen[0].body, {
    Do: 'squash',
    MergeTitleField: 'feat: 合一下',
    MergeMessageField: 'body text',
    head_commit_id: 'heads-ha',
  })
  assert.equal(seen[0].headers.authorization, 'token tok', 'Gitea 用 token 前缀，不能抄 GitHub 的 Bearer')
  assert.equal(res.ok, true)
  assert.equal(res.merged, true)
  assert.equal(res.status, 200)
  assert.equal(res.reason, 'merged')
})

await t('⑪ Gitea 200 只有 merge_commit_sha（没有 merged 字段）也算成功', async () => {
  const { fetchImpl } = recorder(() => jsonRes({ merge_commit_sha: 'giteasha9' }))
  const res = await mergePull({ remote: GITEA, number: 7, sha: 'heads-ha', fetchImpl })
  assert.equal(res.ok, true)
  assert.equal(res.merged, true)
  assert.equal(res.mergeCommitSha, 'giteasha9')
  assert.equal(res.reason, 'merged')
})

await t('⑫ Gitea 200 空 body（既无 merged 也无 merge_commit_sha）→ not-merged，不假装成功', async () => {
  const { fetchImpl } = recorder(() => jsonRes(undefined))
  const res = await mergePull({ remote: GITEA, number: 7, sha: 'heads-ha', fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.status, 200)
  assert.equal(res.reason, 'not-merged')
})

await t('⑬ Gitea 4xx/5xx 走同一套状态分类（405 文案 → conflict / protected）', async () => {
  const plain = await mergePull({ remote: GITEA, number: 7, fetchImpl: recorder(() => jsonRes({ message: 'Pull request is not mergeable' }, 405)).fetchImpl })
  assert.equal(plain.reason, 'conflict')
  const prot = await mergePull({ remote: GITEA, number: 7, fetchImpl: recorder(() => jsonRes({ message: 'protected branch' }, 405)).fetchImpl })
  assert.equal(prot.reason, 'protected')
  const auth = await mergePull({ remote: GITEA, number: 7, fetchImpl: recorder(() => jsonRes({ message: 'token is required' }, 401)).fetchImpl })
  assert.equal(auth.reason, 'auth')
  const boom = await mergePull({ remote: GITEA, number: 7, fetchImpl: recorder(() => jsonRes({ message: 'boom' }, 502)).fetchImpl })
  assert.equal(boom.reason, 'server')
})

await t('⑭ remote 未配置：ok=false 且一个请求都不发', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes({ merged: true }))
  const res = await mergePull({ remote: { kind: 'github', repo: 'demo' }, number: 7, fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(seen.length, 0)
  assert.equal(res.message, 'remote 未配置')
  const none = await mergePull({ remote: { kind: 'gitea', owner: 'a', repo: 'b' }, number: 7, fetchImpl })
  assert.equal(none.ok, false)
  assert.equal(seen.length, 0, 'Gitea 缺 baseUrl 时也不该拼相对 URL 去 fetch')
})

// ---- 15-17. getPull / listPulls 扩字段（旧键一个都不能少） --------------------

/** a2bc1f6 上 getPull 已经在返回的键：调用方在读，扩字段时不许改名。 */
const GETPULL_OLD_KEYS = [
  'ok', 'number', 'state', 'merged', 'mergedAt', 'mergeCommitSha', 'mergedBy',
  'mergeable', 'mergeableState', 'requestedReviewers', 'reviewDecision', 'headSha', 'baseRef', 'url',
]

await t('⑮ getPull：补 author/headRepo/headRef（baseRef/mergeableState/merged/mergeCommitSha 已在），旧键全保留', async () => {
  const body = {
    number: 7, state: 'open', merged: false, merged_at: null, merge_commit_sha: null, merged_by: null,
    mergeable: true, mergeable_state: 'blocked',
    requested_reviewers: [{ login: 'rev1' }, { login: 'rev2' }], review_decision: null,
    head: { ref: 'flow/T-012', sha: 'headsha', repo: { full_name: 'acme/demo' } },
    base: { ref: 'main', sha: 'basesha' },
    html_url: 'https://github.com/acme/demo/pull/7',
    user: { login: 'alice' },
  }
  const { fetchImpl, seen } = recorder(() => jsonRes(body))
  const res = await getPull({ remote: GITHUB, number: 7, fetchImpl })
  assert.equal(seen[0].url, 'https://api.github.com/repos/acme/demo/pulls/7')
  for (const k of GETPULL_OLD_KEYS) assert.ok(k in res, '旧键丢了：' + k + '（RT-03/RT-06 在读）')
  assert.equal(res.number, 7)
  assert.equal(res.state, 'open')
  assert.equal(res.mergeable, true)
  assert.equal(res.headSha, 'headsha')
  assert.equal(res.url, 'https://github.com/acme/demo/pull/7')
  assert.deepEqual(res.requestedReviewers, ['rev1', 'rev2'])
  assert.equal(res.author, 'alice')
  assert.equal(res.headRepo, 'acme/demo')
  assert.equal(res.headRef, 'flow/T-012')
  assert.equal(res.baseRef, 'main')
  assert.equal(res.mergeableState, 'blocked')
  assert.equal(res.merged, false)
  assert.equal(res.mergeCommitSha, null)
})

await t('⑯ getPull：Gitea 的 user.username / head.repo.name 当兜底；空 body 全 null 不抛', async () => {
  const giteaBody = {
    number: 3, state: 'closed', merged: true, merge_commit_sha: 'mc3',
    head: { ref: 'feat/x', sha: 'h3', repo: { name: 'demo', full_name: '' } },
    base: { ref: 'main', sha: 'b3' },
    user: { username: 'bob' },
  }
  const one = await getPull({ remote: GITEA, number: 3, fetchImpl: recorder(() => jsonRes(giteaBody)).fetchImpl })
  assert.equal(one.author, 'bob')
  assert.equal(one.headRepo, 'demo', '没有 full_name 时退到 repo.name')
  assert.equal(one.headRef, 'feat/x')
  assert.equal(one.merged, true)
  assert.equal(one.mergeCommitSha, 'mc3')

  const empty = await getPull({ remote: GITHUB, number: 9, fetchImpl: recorder(() => jsonRes({})).fetchImpl })
  assert.equal(empty.author, null)
  assert.equal(empty.headRepo, null)
  assert.equal(empty.headRef, null)
  assert.equal(empty.baseRef, null)
  assert.equal(empty.mergeableState, null)
  assert.equal(empty.merged, false)
  assert.equal(empty.mergeCommitSha, null)
  assert.equal(empty.number, null)
})

await t('⑰ listPulls：每项补 author/headRepo/headRef/baseRef/mergeableState（null 安全），旧键不动', async () => {
  const rows = [
    {
      number: 9, title: 'p', body: 'b', state: 'open', merged: false,
      updated_at: '2026-10-31T10:00:00Z',
      head: { ref: 'flow/T-1', sha: 'abc', repo: { full_name: 'acme/demo' } },
      base: { ref: 'main', sha: 'base1' },
      mergeable_state: 'clean',
      user: { login: 'alice' },
      html_url: 'https://github.com/acme/demo/pull/9',
    },
    { number: 8, merged: true, head: { ref: 'flow/T-2', sha: 'def' }, updated_at: '2026-10-31T12:00:00Z' },
  ]
  const { fetchImpl, seen } = recorder(() => jsonRes(rows))
  const res = await listPulls({ remote: GITHUB, limit: 20, fetchImpl })
  assert.equal(res.ok, true)
  assert.equal(res.cursor, '2026-10-31T12:00:00Z', '游标仍取最大值')
  const a = res.items[0]
  for (const k of ['remoteId', 'remoteRev', 'kind', 'title', 'body', 'state', 'branch', 'headSha', 'baseSha', 'merged', 'url']) {
    assert.ok(k in a, 'listPulls 旧键丢了：' + k)
  }
  assert.equal(a.remoteId, '9')
  assert.equal(a.state, 'open')
  assert.equal(a.branch, 'flow/T-1')
  assert.equal(a.headSha, 'abc')
  assert.equal(a.baseSha, 'base1')
  assert.equal(a.author, 'alice')
  assert.equal(a.headRepo, 'acme/demo')
  assert.equal(a.headRef, 'flow/T-1')
  assert.equal(a.baseRef, 'main')
  assert.equal(a.mergeableState, 'clean')
  // 第二条什么可选字段都没有：新键必须存在且为 null，不能抛
  const b = res.items[1]
  assert.equal(b.author, null)
  assert.equal(b.headRepo, null)
  assert.equal(b.headRef, 'flow/T-2')
  assert.equal(b.baseRef, null)
  assert.equal(b.mergeableState, null)
  assert.equal(b.state, 'merged', 'merged:true 仍映射成 state=merged')
  assert.ok(seen[0].url.includes('sort=updated'), 'GitHub 仍带 sort=updated')
})

// ---- 18. remoteCapabilities.canMergePull（配置闸门） -------------------------

await t('⑱ remoteCapabilities：github.canMergePull=true；gitea/其它=false；canClosePull/canListPulls 保留', async () => {
  const gh = remoteCapabilities({ config: { remote: { kind: 'github', owner: 'o', repo: 'r' } } })
  assert.equal(gh.canMergePull, true)
  // 票 §3：两个旧能力不许被这次改动挤掉（autolane.mjs ⑨ 也钉着它们）
  assert.equal(gh.canClosePull, true)
  assert.equal(gh.canListPulls, true)

  const gitea = remoteCapabilities({ config: { remote: { kind: 'gitea', owner: 'o', repo: 'r', baseUrl: 'https://gitea.local' } } })
  assert.equal(gitea.canMergePull, false, 'Gitea merge 字段名未实测，闸门必须先是 false')
  assert.equal(gitea.canClosePull, true)
  assert.equal(gitea.canListPulls, true)

  assert.equal(remoteCapabilities({ config: { remote: { kind: 'unknown', owner: 'o', repo: 'r' } } }).canMergePull, false)
  assert.equal(remoteCapabilities({ config: { remote: { kind: 'github' } } }).canMergePull, false, '缺 owner/repo 不许放行')
  assert.equal(remoteCapabilities(null).canMergePull, false)
  assert.equal(remoteCapabilities({}).canMergePull, false)
  assert.equal(remoteCapabilities({ config: { remote: { kind: 'github', owner: 'o', repo: 'r' } } }).kind, 'github')
})

console.log('')
if (fails.length) {
  console.log('FAIL remote-merge-api ' + fails.length + '/' + (pass + fails.length))
  process.exitCode = 1
} else {
  console.log('PASS remote-merge-api ' + pass + '/' + pass)
}
