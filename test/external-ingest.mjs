/**
 * C-02 / rf-03：外部 PR 入站（7 条）。
 *
 * 这一段的风险是"一开开关就把历史 PR 全搬进看板"，所以判据必须逐条钉住：
 * ①recordPulls 关 ②没配 remote ③是我们自己发的 ④已经入站过 ⑤早于配置时间 ⑥不是 open，
 * 外加一条"正常入站并写 pull_requests"（没有那条记录，外部卡永远合不了）。
 *
 * 全部用假 fetch，不联网；gh CLI 也用不到（配置里直接给了 token）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createSyncEngine, isExternalPrTask } from '../lib/sync-engine.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-c02-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)

let pass = 0
async function t(name, fn) {
  await fn()
  pass += 1
  console.log('  ok ' + pass + ' - ' + name)
}

const REMOTE = { kind: 'github', owner: 'acme', repo: 'demo', token: 'tok', useGhCli: false }
const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
})

/**
 * 一个 PR 的**上游原始形状**（/pulls 的返回体）。
 *
 * 注意不能喂归一化后的对象：listOpenPulls 就是从 raw 映射过来的，
 * 喂错形状会让 head/created_at 全部丢失，测试通过得毫无意义。
 */
function row(number, extra = {}) {
  const { headBranch, headSha, baseBranch, baseSha, author, createdAt, updatedAt, url, ...rest } = extra
  return {
    number,
    state: 'open',
    title: 'PR #' + number,
    html_url: url || ('https://github.com/acme/demo/pull/' + number),
    head: { ref: headBranch || ('feat/' + number), sha: headSha || ('sha' + number) },
    base: { ref: baseBranch || 'main', sha: baseSha || 'basesha' },
    user: { login: author || 'someone' },
    created_at: createdAt || '2024-05-01T00:00:00Z',
    updated_at: updatedAt || '2024-05-02T00:00:00Z',
    ...rest,
  }
}

/** 归一化后的形状（判据函数收这个，listOpenPulls 产出这个）。 */
function pr(number, extra = {}) {
  return {
    number,
    state: 'open',
    title: 'PR #' + number,
    url: 'https://github.com/acme/demo/pull/' + number,
    headBranch: 'feat/' + number,
    headSha: 'sha' + number,
    baseBranch: 'main',
    baseSha: 'basesha',
    author: 'someone',
    createdAt: '2024-05-01T00:00:00Z',
    updatedAt: '2024-05-02T00:00:00Z',
    ...extra,
  }
}

let feed = []
const fetchImpl = async (url) => {
  if (String(url).includes('/pulls?')) return jsonRes(feed)
  return jsonRes([])
}

async function project(name, config = {}) {
  const p = await domain.ensureProject({ workspacePath: join(dir, 'repo-' + name), name })
  // RT-03 入站闸门是 policyFor.canIngestPulls：有坐标的项目要开 remoteMode+pushRemote，
  // 否则 recordPulls 单独不再入站。显式 remoteMode:false 的调用方仍可盖掉。
  await domain.updateProjectConfig(p.id, {
    ...(config.remote && config.remote.owner ? { pushRemote: true, remoteMode: true } : {}),
    ...config,
  }, { role: 'human' })
  return store.state.projects[p.id]
}

function engine() {
  return createSyncEngine({ domain, store, log: () => {}, fetchImpl })
}

function tasksOf(p) {
  return Object.values(store.state.tasks).filter((x) => x && x.projectId === p.id)
}

// ① recordPulls 关：整段跳过，一个请求都不发
await t('① recordPulls 关：整段跳过且不发请求', async () => {
  const p = await project('off', { recordIssues: true, remote: REMOTE })
  feed = [row(11)]
  const seen = []
  const eng = createSyncEngine({
    domain, store, log: () => {}, fetchImpl: async (u) => { seen.push(String(u)); return jsonRes(feed) },
  })
  const res = await eng.ingestExternalPulls(p)
  assert.equal(res.ok, true)
  assert.equal(res.created.length, 0)
  assert.equal(seen.length, 0, '开关关着却发了请求：' + JSON.stringify(seen))
  assert.equal(tasksOf(p).length, 0)
})

// ② 没配 remote（owner/repo 缺失）：跳过
await t('② 没配 remote：跳过且不建卡', async () => {
  const p = await project('noremote', { recordIssues: true, recordPulls: true })
  feed = [row(12)]
  const res = await engine().ingestExternalPulls(p)
  assert.equal(res.ok, true)
  assert.equal(res.created.length, 0)
  assert.equal(res.skipped[0].reason, 'no-remote')
  assert.equal(tasksOf(p).length, 0)
})

// ③ head.ref 以 flow/ 开头 = 我们自己发的 PR，交给 refreshPulls
await t('③ 自己发的 flow/* PR：跳过（不重复建卡）', async () => {
  const p = await project('ownpr', { recordIssues: true, recordPulls: true, remote: REMOTE })
  feed = [row(13, { headBranch: 'flow/T-001' })]
  const eng = engine()
  const res = await eng.ingestExternalPulls(p)
  assert.equal(res.created.length, 0)
  assert.ok(res.skipped.some((x) => x.reason === 'own-pr'), '要说明为什么跳过：' + JSON.stringify(res.skipped))
  assert.equal(tasksOf(p).length, 0)
  // 纯函数也要一致（refreshPulls 之外还有别的调用方）
  assert.equal(eng.externalPullSkipReason({ recordPulls: true, remote: REMOTE, pr: pr(13, { headBranch: 'flow/T-001' }), tasks: [] }), 'own-pr')
  assert.equal(eng.externalPullSkipReason({ recordPulls: true, remote: REMOTE, pr: pr(13, { headBranch: 'refs/heads/flow/T-1' }), tasks: [] }), 'own-pr')
})

// ④ 已经入站过：按 kind / external.number 认，不新建第二张
await t('④ 已经有一张 external-pr 卡：跳过（不重复入站）', async () => {
  const p = await project('dup', { recordIssues: true, recordPulls: true, remote: REMOTE })
  const first = await domain.createTask(p.id, { title: '旧的外部 PR' })
  // C-00 目前没有写 kind/external 的入口，直接在 store 里造出目标形状（这就是去重判据认的形状）
  await store.tx((s) => {
    s.tasks[first.id].kind = 'external-pr'
    s.tasks[first.id].external = { provider: 'github', number: 42, url: null }
  })
  assert.equal(isExternalPrTask(store.state.tasks[first.id]), true)
  feed = [row(42)]
  const res = await engine().ingestExternalPulls(p)
  assert.equal(res.created.length, 0)
  assert.ok(res.skipped.some((x) => x.reason === 'already-ingested'), JSON.stringify(res.skipped))
  assert.equal(tasksOf(p).length, 1, '不该建第二张')
})

// ⑤ created_at 早于 sync.since：与 issue 入站同一条防历史灌入规则
await t('⑤ created_at 早于 sync.since：跳过（防历史灌入）', async () => {
  const p = await project('since', { recordIssues: true, recordPulls: true, remote: REMOTE })
  await domain.applySyncResults(p.id, {
    inbound: { issues: [], comments: [] }, outbound: [], outboundComments: [],
    labelSync: [], pendingAdd: [], pendingDone: [], cursors: {},
    sinceIfNull: '2099-01-01T00:00:00.000Z',
  })
  feed = [row(51, { createdAt: '2020-01-01T00:00:00Z' })]
  const eng = engine()
  const res = await eng.ingestExternalPulls(p)
  assert.equal(res.created.length, 0)
  assert.ok(res.skipped.some((x) => x.reason === 'before-since'), JSON.stringify(res.skipped))
  assert.equal(tasksOf(p).length, 0)
  // since 之后的那张要能进来（否则"跳过"就变成了"永远跳过"）
  feed = [row(52, { createdAt: '2099-06-01T00:00:00Z' })]
  const res2 = await eng.ingestExternalPulls(p)
  assert.equal(res2.created.length, 1, JSON.stringify(res2.errors))
})

// ⑥ state !== 'open'：closed 与 merged 都不入站
await t('⑥ 非 open 的 PR：不入站（服务端混进来也要滤掉）', async () => {
  const p = await project('closed', { recordIssues: true, recordPulls: true, remote: REMOTE })
  feed = [row(61, { state: 'closed' }), row(62, { merged: true })]
  const eng = engine()
  const res = await eng.ingestExternalPulls(p)
  assert.equal(res.created.length, 0)
  assert.equal(tasksOf(p).length, 0)
  // 判据本身（listOpenPulls 是第一道过滤，判据是第二道）
  assert.equal(eng.externalPullSkipReason({ recordPulls: true, remote: REMOTE, pr: pr(63, { state: 'closed' }), tasks: [] }), 'not-open')
})

// ⑦ 正常建卡：卡 + pull_requests 记录（合并的前置）
await t('⑦ 正常入站：建卡并写 pull_requests 快照', async () => {
  const p = await project('ok', { recordIssues: true, recordPulls: true, remote: REMOTE })
  feed = [row(71, { title: '上游的新特性', author: 'octo', headBranch: 'feat/new', headSha: 'sha71' })]
  const eng = engine()
  const res = await eng.ingestExternalPulls(p)
  assert.equal(res.ok, true)
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors))
  assert.equal(res.created.length, 1, JSON.stringify(res.skipped))
  const task = store.state.tasks[res.created[0].taskId]
  assert.equal(task.title, '上游的新特性')
  assert.equal(task.origin, 'auto')
  // C-00 没有 createExternalPrTask：当前靠 originRef 承载外部身份（见报告）
  assert.equal(task.originRef, 'external-pr:github#71')
  assert.equal(isExternalPrTask(task), true)

  const record = res.created[0].prId ? store.state.pull_requests[res.created[0].prId] : null
  assert.ok(record, '建卡时必须同时写一条 pull_requests（否则 mergeLocked 永远拦"没有 PR 记录"）')
  assert.equal(record.taskId, task.id)
  assert.equal(record.branch, 'feat/new')
  assert.equal(record.headSha, 'sha71')
  assert.equal(record.status, 'open')
  assert.equal(record.remote.number, 71)
  assert.equal(record.remote.source, 'github')

  // 再来一轮：同一张 PR 不该变成第二张卡（去重锚是 originRef）
  const again = await eng.ingestExternalPulls(p)
  assert.equal(again.created.length, 0, '重复入站了：' + JSON.stringify(again.created))
  assert.equal(tasksOf(p).length, 1)
})

console.log('PASS external-ingest ' + pass + '/7')
rmSync(dir, { recursive: true, force: true })
