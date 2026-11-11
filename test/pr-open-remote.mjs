/**
 * RT-02：openPr 远程优先。
 *
 *   - 远程模式 push 失败 → ok:false + blocked，不写可合并的本地 PR
 *   - createPull 失败 → 同样 block，不本地合并
 *   - 已有 PR 按 head 分支复用，不再 POST
 *   - 422 already exists → 再查一次
 *   - 本地模式不 push、不 createPull
 *   - 里程碑评论打到 issueNumber，不经过 PR 线程
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listOpenPulls } from '../lib/remote.js'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher, branchFor } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-pr-open-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession() { return { ok: true, sessionId: 'ses' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })

function mkRepo(name) {
  const repo = join(root, name)
  sh(root, ['init', '-q', '-b', 'main', name])
  sh(repo, ['config', 'user.email', 'flow@local'])
  sh(repo, ['config', 'user.name', 'flow'])
  writeFileSync(join(repo, 'a.txt'), 'a' + NL)
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])
  return repo
}

function withOrigin(repo) {
  const bare = repo + '.git'
  sh(root, ['init', '-q', '--bare', '-b', 'main', bare.slice(root.length + 1)])
  sh(repo, ['remote', 'add', 'origin', bare])
  sh(repo, ['push', '-u', 'origin', 'main'])
}

async function projectFor(repo, { remoteMode }) {
  const project = await domain.ensureProject({ workspacePath: repo, name: repo })
  await store.tx((s) => {
    s.projects[project.id].config = {
      ...s.projects[project.id].config,
      baseBranch: 'main',
      pushRemote: true,
      recordPulls: true,
      remoteMode,
      remote: { kind: 'github', owner: 'o', repo: 'r', useGhCli: false },
    }
  })
  return store.state.projects[project.id]
}

function ensureBranch(repo, branch) {
  sh(repo, ['checkout', '-qb', branch])
  writeFileSync(join(repo, 'b.txt'), branch + NL)
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'branch'])
  sh(repo, ['checkout', '-q', 'main'])
}

const json = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
})

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ok ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  FAIL ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

await t('远程模式 push 失败 → blocked，不写本地 PR', async () => {
  const repo = mkRepo('push-fail')
  const project = await projectFor(repo, { remoteMode: true })
  const task = await domain.createTask(project.id, { title: 'push fail' })
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => { seen.push(String(url)); return json(500, {}) }
  try {
    const out = await dispatcher.openPr(store.state.tasks[task.id])
    assert.equal(out.ok, false, JSON.stringify(out))
    assert.equal(out.blocked, true)
    assert.equal(out.reason, 'push-failed')
    assert.equal(Object.values(store.state.pull_requests || {}).filter((p) => p.taskId === task.id).length, 0)
    assert.equal(seen.length, 0, '推送失败不该再去建 PR')
    const cur = store.state.tasks[task.id]
    assert.equal(cur.blocked && cur.blocked.reason, 'push-failed')
    assert.equal(cur.mergeState, 'blocked')
  } finally { globalThis.fetch = real }
})

await t('createPull 失败 → blocked，不写本地 PR', async () => {
  const repo = mkRepo('create-fail')
  withOrigin(repo)
  const project = await projectFor(repo, { remoteMode: true })
  const task = await domain.createTask(project.id, { title: 'create fail' })
  ensureBranch(repo, branchFor(task))
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    if (method === 'GET') return json(200, [])
    return json(500, { message: 'boom' })
  }
  try {
    const out = await dispatcher.openPr(store.state.tasks[task.id])
    assert.equal(out.ok, false, JSON.stringify(out))
    assert.equal(out.reason, 'open-pr-failed')
    assert.equal(Object.values(store.state.pull_requests || {}).filter((p) => p.taskId === task.id).length, 0)
    assert.equal(store.state.tasks[task.id].mergeState, 'blocked')
  } finally { globalThis.fetch = real }
})

await t('GET /pulls 403 诊断截断后仍完整脱敏 token', async () => {
  const secret = 'test-token-do-not-leak'
  const detail = 'x'.repeat(1990) + secret + ' tail'
  const out = await listOpenPulls({
    remote: { kind: 'github', owner: 'o', repo: 'r', token: secret, useGhCli: false },
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => detail }),
  })
  assert.equal(out.status, 403)
  assert.equal(out.detail.includes('test-token'), false, '截断前完整脱敏，不能留下 token 前缀')
  assert.ok(out.detail.length <= 2000)
})

await t('GET /pulls 403 保留响应诊断并脱敏 token', async () => {
  const repo = mkRepo('list-forbidden')
  withOrigin(repo)
  const project = await projectFor(repo, { remoteMode: true })
  const secret = 'test-token-do-not-leak'
  await store.tx((s) => { s.projects[project.id].config.remote = { kind: 'github', owner: 'o', repo: 'r', token: secret, useGhCli: true } })
  const task = await domain.createTask(project.id, { title: 'list forbidden' })
  ensureBranch(repo, branchFor(task))
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: (init && init.method) || 'GET', authorization: init && init.headers && init.headers.authorization })
    return json(403, { message: 'Resource not accessible by personal access token', token: secret })
  }
  try {
    const out = await dispatcher.openPr(store.state.tasks[task.id])
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'open-pr-failed')
    assert.match(out.message, /HTTP 403/)
    assert.match(out.message, /Resource not accessible by personal access token/)
    assert.equal(out.message.includes(secret), false, '错误诊断不得泄漏 token')
    assert.equal(seen.length, 1, '列出 PR 失败后不得继续 POST')
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].authorization, 'Bearer ' + secret, 'API 查询必须使用配置/CLI token')
    assert.equal(store.state.tasks[task.id].noMergeReason.includes(secret), false)
    assert.equal(Object.values(store.state.pull_requests || {}).filter((p) => p.taskId === task.id).length, 0)
  } finally { globalThis.fetch = real }
})

await t('已有 PR 按 head 复用，不再 POST', async () => {
  const repo = mkRepo('reuse')
  withOrigin(repo)
  const project = await projectFor(repo, { remoteMode: true })
  const task = await domain.createTask(project.id, { title: 'reuse' })
  await store.tx((s) => { s.tasks[task.id].remote = { issueNumber: 42, source: 'github' } })
  const branch = branchFor(task)
  ensureBranch(repo, branch)
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    seen.push({ url: String(url), method })
    if (method === 'GET') {
      return json(200, [{ number: 9, html_url: 'https://github.com/o/r/pull/9', state: 'open', head: { ref: branch }, base: { ref: 'main' }, user: { login: 'ada' } }])
    }
    if (String(url).includes('/issues/42/comments')) return json(201, { id: 1 })
    return json(500, { message: 'should not create' })
  }
  try {
    const out = await dispatcher.openPr(store.state.tasks[task.id])
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.remote.number, 9)
    assert.equal(out.remote.reused, true)
    assert.equal(seen.filter((s) => s.method === 'POST' && /\/pulls$/.test(s.url)).length, 0)
    assert.ok(seen.some((s) => s.method === 'POST' && s.url.includes('/issues/42/comments')), '里程碑打到 issue，不打到 PR')
    const pr = store.state.pull_requests[out.pr.id]
    assert.equal(pr.remote.number, 9)
    assert.equal(pr.remote.author, 'ada')
  } finally { globalThis.fetch = real }
})

await t('422 already exists 再查一次并复用', async () => {
  const repo = mkRepo('requery')
  withOrigin(repo)
  const project = await projectFor(repo, { remoteMode: true })
  const task = await domain.createTask(project.id, { title: '422' })
  const branch = branchFor(task)
  ensureBranch(repo, branch)
  let lists = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    if (method === 'GET') {
      lists += 1
      if (lists === 1) return json(200, [])
      return json(200, [{ number: 11, html_url: 'https://github.com/o/r/pull/11', state: 'open', head: { ref: branch }, base: { ref: 'main' } }])
    }
    return json(422, { message: 'A pull request already exists' })
  }
  try {
    const out = await dispatcher.openPr(store.state.tasks[task.id])
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(lists, 2, '422 之后必须再查一次')
    assert.equal(out.remote.number, 11)
    assert.equal(out.remote.reused, true)
  } finally { globalThis.fetch = real }
})

await t('本地模式不 push、不 createPull', async () => {
  const repo = mkRepo('local')
  const project = await projectFor(repo, { remoteMode: false })
  const task = await domain.createTask(project.id, { title: 'local' })
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => { seen.push(String(url)); return json(500, {}) }
  try {
    const out = await dispatcher.openPr(store.state.tasks[task.id])
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.remote, null)
    assert.equal(seen.length, 0)
    assert.equal(Object.values(store.state.pull_requests || {}).filter((p) => p.taskId === task.id).length, 1)
  } finally { globalThis.fetch = real }
})

if (fails.length) {
  console.log('FAIL pr-open-remote ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err).split(NL).slice(0, 4).join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS pr-open-remote ' + pass + '/' + pass)
}
