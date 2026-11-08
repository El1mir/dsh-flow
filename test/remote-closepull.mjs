/**
 * C-02 / rf-05：closePull 与 listOpenPulls（全部用假 fetch，不联网）。
 *
 * 这 6 条钉的是"远程 PR 可以被我们关掉"这件事的最小契约：
 *  1-2. GitHub 与 Gitea 走同一个实现分支，但 apiBase 的差异必须真的套用（Gitea 少了 /api/v1 就 404）；
 *  3.   配置不全时**一个请求都不发**（本地已经知道答案，不该拿配额去换一个 400）；
 *  4.   4xx 要把 status 带出来（上层靠它决定熔断还是重试）；
 *  5-6. 入站只取 open：URL 上带 state=open，返回体里混进来的 closed/merged 也要滤掉。
 */
import assert from 'node:assert/strict'
import { closePull, listOpenPulls } from '../lib/remote.js'

let pass = 0
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    pass += 1
    console.log('  ok ' + pass + ' - ' + name)
  })
}

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
})

/** 记下每一次请求，返回受控响应。 */
function recorder(handler) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    return handler(String(url), init, seen.length)
  }
  return { fetchImpl, seen }
}

const GITHUB = { kind: 'github', owner: 'acme', repo: 'demo', token: 'tok' }
const GITEA = { kind: 'gitea', owner: 'acme', repo: 'demo', baseUrl: 'https://gitea.example', token: 'tok' }

await t('GitHub：PATCH /pulls/7，body 是 {state:"closed"}', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes({ number: 7, state: 'closed' }))
  const res = await closePull({ remote: GITHUB, number: 7, fetchImpl })
  assert.equal(res.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.github.com/repos/acme/demo/pulls/7')
  assert.equal(seen[0].method, 'PATCH')
  assert.deepEqual(seen[0].body, { state: 'closed' })
})

await t('Gitea：同一个实现分支，URL 走 {baseUrl}/api/v1', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes({ number: 7, state: 'closed' }))
  const res = await closePull({ remote: GITEA, number: 7, fetchImpl })
  assert.equal(res.ok, true)
  assert.equal(seen[0].url, 'https://gitea.example/api/v1/repos/acme/demo/pulls/7')
  assert.equal(seen[0].method, 'PATCH')
  assert.deepEqual(seen[0].body, { state: 'closed' })
})

await t('remoteReady 缺 owner：返回 {ok:false,reason} 且不发请求', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes({}))
  const res = await closePull({ remote: { kind: 'github', repo: 'demo' }, number: 7, fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'remote 未配置')
  assert.equal(seen.length, 0, '配置不全时不该发请求，实际发了：' + JSON.stringify(seen))
})

await t('4xx：返回 ok:false 并把 status 带出来', async () => {
  const { fetchImpl } = recorder(() => jsonRes({ message: 'Not Found' }, 404))
  const res = await closePull({ remote: GITHUB, number: 7, fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.status, 404)
})

await t('listOpenPulls：请求带 state=open、不发 sort/direction', async () => {
  const { fetchImpl, seen } = recorder(() => jsonRes([]))
  const res = await listOpenPulls({ remote: GITHUB, limit: 20, fetchImpl })
  assert.equal(res.ok, true)
  assert.equal(seen.length, 1)
  const u = new URL(seen[0].url)
  assert.equal(u.pathname, '/repos/acme/demo/pulls')
  assert.equal(u.searchParams.get('state'), 'open')
  assert.equal(u.searchParams.get('per_page'), '20')
  // 票 C-02 §风险第 1 条：Gitea 老版本对 sort/direction 支持不全，宁可在本地排
  assert.equal(u.searchParams.get('sort'), null, '不该发 sort')
  assert.equal(u.searchParams.get('direction'), null, '不该发 direction')
})

await t('listOpenPulls：只返回 open 的条目（closed 与 merged 被滤掉，按 createdAt 倒序）', async () => {
  const rows = [
    { number: 1, state: 'open', title: 'old', created_at: '2024-01-01T00:00:00Z', head: { ref: 'feat/a' }, user: { login: 'a' } },
    { number: 2, state: 'closed', title: 'gone', created_at: '2024-02-01T00:00:00Z', head: { ref: 'feat/b' } },
    { number: 3, state: 'open', merged: true, title: 'merged', created_at: '2024-03-01T00:00:00Z', head: { ref: 'feat/c' } },
    { number: 4, state: 'open', title: 'new', created_at: '2024-04-01T00:00:00Z', head: { ref: 'feat/d', sha: 'deadbeef' }, user: { login: 'd' } },
  ]
  const { fetchImpl } = recorder(() => jsonRes(rows))
  const res = await listOpenPulls({ remote: GITHUB, fetchImpl })
  assert.equal(res.ok, true)
  assert.deepEqual(res.items.map((it) => it.number), [4, 1])
  assert.equal(res.items[0].headSha, 'deadbeef')
  assert.equal(res.items[0].author, 'd')
})

console.log('PASS remote-closepull ' + pass + '/6')
