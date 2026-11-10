/**
 * RT-03：评论路由（issue ↔ PR）+ 出站 marker + 入站回卡（设计文档 §7、ADR-0007 §7）。
 *
 * 这张测试只钉「评论往哪发、回来落到哪张卡」，不碰合并/状态机：
 *   ① remoteThreadFor 的三段优先级（受控 PR / 外部 PR / issue / 都没有）；
 *   ② pickOutbound 不再要求 task.remote.issueNumber，改用 remoteThreadFor；
 *   ③ 出站发到 PR 号（GitHub 的 issue-comments API 对 PR conversation 有效）；
 *   ④ 评论 body 带 flow comment + task 标记；
 *   ⑤ 出站结果写回 comment.remote.thread/number/id/url/at；
 *   ⑥ PR 打开的里程碑评论只发一次（issue 上，不走 remoteThreadFor）；
 *   ⑦ 入站 issue / 受控 PR / 外部 PR 三种来源都回卡，并写 remote.thread/number/remoteId；
 *   ⑧ marker 评论丢弃（marker 的 commentId 必须长得像本系统的 id）；
 *   ⑨ 同一 remoteId 重复投递幂等；PR 评论在卡上标注来源；
 *   ⑩ 403/限流：整轮跳过，不逐条重试（下一轮重新规划）。
 *
 * 全部用假 fetch，不联网。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createSyncEngine } from '../lib/sync-engine.js'
import { remoteThreadFor, pickOutbound, desiredLabels, flowMarker } from '../lib/sync.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-rt03-cr-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)

let pass = 0
const fails = []
async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ok ' + pass + ' - ' + name)
  } catch (err) {
    fails.push({ name, err })
    console.log('  FAIL - ' + name)
    console.log('    ' + String((err && err.message) || err).split(String.fromCharCode(10))[0])
  }
}

const REMOTE = { kind: 'github', owner: 'acme', repo: 'demo', token: 'tok', useGhCli: false }
const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
})

/** 远程模式项目：评论能不能出去，只由 policyFor 判定（RT-03 §2）。 */
async function project(name, config = {}) {
  const p = await domain.ensureProject({ workspacePath: join(dir, 'repo-' + name), name })
  await domain.updateProjectConfig(p.id, {
    recordIssues: true,
    pushRemote: true,
    remoteMode: true,
    remote: REMOTE,
    ...config,
  }, { role: 'human' })
  return store.state.projects[p.id]
}

/** 给卡一个远程 issue 身份（走真实落盘路径，不改 state 内部形状）。 */
async function withIssue(p, task, number) {
  await domain.applySyncResults(p.id, {
    inbound: { issues: [], comments: [] },
    outbound: [{ taskId: task.id, issueNumber: number, url: 'https://github.com/acme/demo/issues/' + number, source: 'github', labels: desiredLabels(task) }],
    pendingAdd: [], pendingDone: [], cursors: {},
  })
  return store.state.tasks[task.id]
}

/** 给卡开一条受控 PR（attachPullRemote 会把 remote 镜像进 task.mergeRequest.remote）。 */
async function withPull(task, number, state = 'open') {
  const pr = await domain.openPullRequest(task.id, { headSha: 'sha-' + number, baseSha: 'base', branch: 'flow/' + task.id })
  await domain.attachPullRemote(pr.id, { number, url: 'https://github.com/acme/demo/pull/' + number, source: 'github', state })
  return store.state.pull_requests[pr.id]
}

// ---------------------------------------------------------------------------
// ① remoteThreadFor：优先级与「PR 关了回落 issue」
// ---------------------------------------------------------------------------
await t('① remoteThreadFor：都没有 → null；只有 issue → issue；开着的 PR → pr；关掉的 PR 回落 issue', () => {
  assert.equal(remoteThreadFor({ id: 'T-1' }), null, '本地卡没有远程身份就不该出站')
  assert.deepEqual(remoteThreadFor({ remote: { issueNumber: 5 } }), { thread: 'issue', number: 5 })
  assert.deepEqual(
    remoteThreadFor({ remote: { issueNumber: 5 }, mergeRequest: { remote: { number: 12, state: 'open' } } }),
    { thread: 'pr', number: 12 },
    'PR 优先于 issue',
  )
  assert.deepEqual(
    remoteThreadFor({ remote: { issueNumber: 5 }, mergeRequest: { remote: { number: 12, state: 'closed' } } }),
    { thread: 'issue', number: 5 },
    'PR 已关：评论回落到 issue',
  )
  assert.deepEqual(
    remoteThreadFor({ remote: { issueNumber: 5 }, mergeRequest: { remote: { number: 12, state: 'closed', merged: true } } }),
    { thread: 'issue', number: 5 },
    'PR 已合并：同样回落 issue',
  )
  assert.deepEqual(
    remoteThreadFor({ external: { number: 21, state: 'open' } }),
    { thread: 'pr', number: 21 },
    '外部 PR 卡没有合并快照，也要能发到 PR',
  )
})

// ---------------------------------------------------------------------------
// ② pickOutbound：不再要求 task.remote.issueNumber
// ---------------------------------------------------------------------------
await t('② pickOutbound：受控 PR 卡（没有 issue 号）的评论也要被捡起来，并记 remote.thread/number', () => {
  const state = {
    projects: { p1: { id: 'p1', config: {} } },
    remote_sync: { p1: { since: '2020-01-01T00:00:00.000Z' } },
    tasks: {
      'T-1': { id: 'T-1', projectId: 'p1', column: 'running', createdAt: '2026-01-01T00:00:00.000Z', mergeRequest: { remote: { number: 12, state: 'open' } } },
      'T-2': { id: 'T-2', projectId: 'p1', column: 'running', createdAt: '2026-01-01T00:00:00.000Z', remote: { issueNumber: 5 } },
      'T-3': { id: 'T-3', projectId: 'p1', column: 'running', createdAt: '2026-01-01T00:00:00.000Z' },
    },
    task_comments: [
      { id: 'c_00001', taskId: 'T-1', role: 'worker', content: 'a', at: '2026-02-01T00:00:00.000Z' },
      { id: 'c_00002', taskId: 'T-2', role: 'worker', content: 'b', at: '2026-02-01T00:00:00.000Z' },
      { id: 'c_00003', taskId: 'T-3', role: 'worker', content: 'c', at: '2026-02-01T00:00:00.000Z' },
    ],
  }
  const plan = pickOutbound(state, 'p1')
  const byId = Object.fromEntries(plan.comments.map((x) => [x.commentId, x]))
  assert.deepEqual(byId.c_00001.remote, { thread: 'pr', number: 12 })
  assert.deepEqual(byId.c_00002.remote, { thread: 'issue', number: 5 })
  assert.equal(byId.c_00003, undefined, '既没 issue 也没 PR 的卡：评论先等着，不出站')
})

// ---------------------------------------------------------------------------
// ③④⑤ 出站：发到 PR 号 + marker + 回写 remote.thread
// ---------------------------------------------------------------------------
await t('③④⑤ 出站：评论走 PR conversation（/issues/12/comments），body 带两种 marker，成功回写 remote.thread/number', async () => {
  const p = await project('out')
  const task = await domain.createTask(p.id, { title: 'PR 评论路由' })
  await withIssue(p, store.state.tasks[task.id], 5)
  await withPull(store.state.tasks[task.id], 12)
  const c = await domain.comment(task.id, '这条要发到 PR 上', { role: 'worker', id: 'ag_w' })
  store.state.remote_sync[p.id].since = '2020-01-01T00:00:00.000Z'

  const posts = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if ((init.method || 'GET') === 'POST' && u.includes('/comments')) {
      posts.push({ url: u, body: String(init.body || '') })
      return jsonRes({ id: 9001, html_url: 'https://github.com/acme/demo/pull/12#issuecomment-9001' }, 201)
    }
    return jsonRes([])
  }
  const eng = createSyncEngine({ domain, store, log: () => {}, fetchImpl })
  const pushed = await eng.pushProject(p)
  assert.equal(pushed.ok, true, JSON.stringify(pushed).slice(0, 200))

  const commentPost = posts.find((x) => x.body.includes('这条要发到 PR 上'))
  assert.ok(commentPost, '评论必须真的发出去：' + JSON.stringify(posts.map((x) => x.url)))
  assert.ok(commentPost.url.endsWith('/issues/12/comments'), 'PR conversation 用 issue comments API，号必须是 PR 号：' + commentPost.url)
  assert.ok(commentPost.body.includes('dsh-flow:comment'), 'body 要带 comment marker（防环）：' + commentPost.body)
  assert.ok(commentPost.body.includes('dsh-flow:task'), 'body 要带 task marker（§7.1）')

  await domain.applySyncResults(p.id, {
    inbound: { issues: [], comments: [] },
    outbound: pushed.results.outbound,
    outboundComments: pushed.results.outboundComments,
    pendingAdd: [], pendingDone: pushed.results.pendingDone, cursors: {},
  })
  const saved = store.state.task_comments.find((x) => x.id === c.id)
  assert.equal(saved.remote.thread, 'pr')
  assert.equal(saved.remote.number, 12)
  assert.equal(saved.remote.commentId, '9001')
  assert.equal(saved.remote.remoteId, '9001')
  assert.ok(saved.remote.at, '要记下发出去的时间')
  assert.ok(saved.remote.url, '要记下远端 url')
})

// ---------------------------------------------------------------------------
// ⑥ 里程碑评论：PR 打开时在 issue 上补一条，只补一次
// ---------------------------------------------------------------------------
await t('⑥ 里程碑：PR 打开后在 issue 上补一条「已开 PR #n」，第二次推送不重复发', async () => {
  const p = await project('milestone')
  const task = await domain.createTask(p.id, { title: '里程碑' })
  await withIssue(p, store.state.tasks[task.id], 7)
  await withPull(store.state.tasks[task.id], 31)
  store.state.remote_sync[p.id].since = '2020-01-01T00:00:00.000Z'

  const posts = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if ((init.method || 'GET') === 'POST' && u.includes('/comments')) {
      posts.push({ url: u, body: String(init.body || '') })
      return jsonRes({ id: 7001, html_url: 'https://github.com/acme/demo/issues/7#issuecomment-7001' }, 201)
    }
    return jsonRes([])
  }
  const eng = createSyncEngine({ domain, store, log: () => {}, fetchImpl })
  const first = await eng.pushProject(p)
  assert.equal(first.ok, true)
  const milestone = posts.filter((x) => x.body.includes('已开 PR #31'))
  assert.equal(milestone.length, 1, '里程碑评论要发一条：' + JSON.stringify(posts.map((x) => x.url)))
  assert.ok(milestone[0].url.endsWith('/issues/7/comments'), '里程碑发 issue，不走 remoteThreadFor：' + milestone[0].url)

  await domain.applySyncResults(p.id, {
    inbound: { issues: [], comments: [] },
    outbound: first.results.outbound,
    outboundComments: first.results.outboundComments,
    pendingAdd: [], pendingDone: first.results.pendingDone, cursors: {},
  })
  assert.ok(store.state.tasks[task.id].remote.milestoneCommentAt, '要落 milestoneCommentAt（否则每轮重发）')

  const before = posts.length
  const second = await eng.pushProject(p)
  assert.equal(second.ok, true)
  assert.equal(posts.length, before, '第二轮不该再发里程碑')
})

// ---------------------------------------------------------------------------
// ⑦⑧⑨ 入站：三种 thread 都回卡 / marker 丢弃 / remoteId 幂等 / PR 来源标注
// ---------------------------------------------------------------------------
await t('⑦⑧⑨ 入站：issue、受控 PR、外部 PR 都回卡；marker 丢弃；remoteId 幂等；PR 评论标注来源', async () => {
  const p = await project('inbound')
  const issueTask = await domain.createTask(p.id, { title: 'issue 卡' })
  await withIssue(p, store.state.tasks[issueTask.id], 5)
  const prTask = await domain.createTask(p.id, { title: '受控 PR 卡' })
  await withIssue(p, store.state.tasks[prTask.id], 6)
  await withPull(store.state.tasks[prTask.id], 12)
  const extTask = await domain.createExternalPrTask(p.id, { provider: 'github', number: 21, headBranch: 'feat/x', baseBranch: 'main', headSha: 'esha', title: '外部 PR 21' }, { lane: 'human', visibility: 'board' })

  const comment = (commentId, issueNumber, body, thread) => ({
    commentId: String(commentId), issueNumber, remoteId: String(issueNumber), body,
    login: 'octo', url: 'https://github.com/acme/demo/issues/' + issueNumber + '#issuecomment-' + commentId,
    createdAt: '2026-03-01T00:00:00Z', thread,
  })
  const inbound = [
    comment(900, 5, 'issue 上的评论', 'issue'),
    comment(901, 12, 'PR conversation 的评论', 'pr'),
    comment(902, 21, '外部 PR 的评论', 'pr'),
    comment(903, 12, '回声 ' + flowMarker('comment', 'c_00009', 'nn'), 'pr'),
    comment(904, 12, '第三方伪装 marker ' + '<!-- dsh-flow:comment not-ours -->', 'pr'),
  ]
  await domain.applySyncResults(p.id, { inbound: { issues: [], comments: inbound }, outbound: [], pendingAdd: [], pendingDone: [], cursors: {} })

  const of = (taskId) => (store.state.task_comments || []).filter((c) => c.taskId === taskId)
  const issueCm = of(issueTask.id)
  assert.equal(issueCm.length, 1, 'issue 评论要回 issue 卡')
  assert.equal(issueCm[0].remote.thread, 'issue')
  assert.equal(issueCm[0].remote.number, 5)

  const prCm = of(prTask.id)
  const realPr = prCm.find((c) => String(c.remote.remoteId) === '901')
  assert.ok(realPr, '受控 PR 的评论要按 pull_requests.remote.number 回卡：' + JSON.stringify(prCm.map((c) => c.content)))
  assert.equal(realPr.remote.thread, 'pr')
  assert.equal(realPr.remote.number, 12)
  assert.match(realPr.content, /来自 PR #12/, 'PR 评论要在卡上标注来源')
  assert.ok(!prCm.some((c) => c.content.includes('回声')), '本系统 marker 的评论必须丢弃（防环）')
  assert.ok(prCm.some((c) => c.content.includes('第三方伪装 marker')), '不是本系统 id 形状的 marker 不能当成回声丢掉')

  const extCm = of(extTask.id)
  assert.equal(extCm.length, 1, '外部 PR 评论要按 external.number 回卡：' + JSON.stringify(extCm))
  assert.equal(extCm[0].remote.thread, 'pr')
  assert.equal(extCm[0].remote.number, 21)

  const totalBefore = (store.state.task_comments || []).length
  await domain.applySyncResults(p.id, { inbound: { issues: [], comments: inbound }, outbound: [], pendingAdd: [], pendingDone: [], cursors: {} })
  assert.equal((store.state.task_comments || []).length, totalBefore, '同一 remoteId 重复投递必须幂等')
})

// ---------------------------------------------------------------------------
// ⑩ 403 / 限流：整轮跳过，不逐条重试
// ---------------------------------------------------------------------------
await t('⑩ 403 限流：这一轮一条都不再重试（只发一次请求），下一轮重新规划', async () => {
  const p = await project('limited')
  const task = await domain.createTask(p.id, { title: '限流' })
  await withIssue(p, store.state.tasks[task.id], 9)
  store.state.remote_sync[p.id].since = '2020-01-01T00:00:00.000Z'
  await domain.comment(task.id, '第一条待推', { role: 'worker', id: 'ag_w' })
  await domain.comment(task.id, '第二条待推', { role: 'worker', id: 'ag_w' })

  let posts = 0
  const denied = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') {
      posts += 1
      return { ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }), text: async () => '{}' }
    }
    return jsonRes([])
  }
  const eng = createSyncEngine({ domain, store, log: () => {}, fetchImpl: denied })
  const res = await eng.pushProject(p)
  assert.equal(posts, 1, '403 之后不许逐条重试：实际发了 ' + posts + ' 次 POST')
  assert.ok(res.results.errors.some((e) => e.status === 403), '403 要记进 errors')
  assert.equal((res.results.outboundComments || []).length, 0)
  assert.ok(res.results.pendingDone.length >= 2, 'pending 要清掉，下一轮才能重新规划：' + JSON.stringify(res.results.pendingDone))

  await domain.applySyncResults(p.id, {
    inbound: { issues: [], comments: [] },
    outbound: [], outboundComments: [], pendingAdd: [], pendingDone: res.results.pendingDone, cursors: {},
  })

  const okPosts = []
  const okFetch = async (url, init = {}) => {
    const u = String(url)
    if ((init.method || 'GET') === 'POST' && u.includes('/comments')) {
      okPosts.push(u)
      return jsonRes({ id: 8000 + okPosts.length, html_url: 'https://github.com/acme/demo/issues/9#issuecomment-' + okPosts.length }, 201)
    }
    return jsonRes([])
  }
  const eng2 = createSyncEngine({ domain, store, log: () => {}, fetchImpl: okFetch })
  await eng2.pushProject(p)
  assert.equal(okPosts.length, 2, '下一轮两条都要重发：' + JSON.stringify(okPosts))
})

console.log('')
if (fails.length) {
  console.log('FAIL comment-routing ' + fails.length + ' / ' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ' :: ' + String((f.err && f.err.message) || f.err).split(String.fromCharCode(10))[0])
  process.exitCode = 1
} else {
  console.log('PASS comment-routing ' + pass + '/' + pass)
}
rmSync(dir, { recursive: true, force: true })
