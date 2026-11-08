/**
 * C-09：autoLane 落地 + since 真拦住建卡。
 *
 * 这张测试钉住 9 条（外加 3 条本票顺带引入的边界），每一条都对应一个会**静默失败**的入口：
 *   ① autoLane 未设置 + autoDispatch:true → 照旧建卡（升级兼容，本票唯一的线上破坏点）；
 *   ② autoLane:false + autoDispatch:true → 不建卡（新开关能压住旧开关）；
 *   ③ autoLane:true + autoDispatch:false → 建卡，但不补位派工；
 *   ④ sync.since 之后出现的 issue 建卡；
 *   ⑤ sync.since 之前的 issue 不建卡，但镜像落库；
 *   ⑥ issue 没有 createdAt → 仍然建卡（宁多建一张，不要让卡静默不建）；
 *   ⑦ recordIssues:false 时 autoLane:true 被 http 层拒绝（防误配，现状保留）；
 *   ⑧ recordIssues:true + autoLane:true 时 http 允许写入（解耦生效）；
 *   ⑨ remoteCapabilities 含 canClosePull；
 *   ⑩ 入站建的卡带 visibility（auto 默认不上板 / showAutoCards 覆盖 / 老项目回退也走 auto）；
 *   ⑪ webhook 信封（live:true）绕过 since —— 新 issue 不会被历史分界挡住；
 *   ⑫ recordPulls-only 的项目也能开 autoMerge（补充 §6：两个入站开关任一即可）。
 *
 * 直接跑：node test/autolane.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createScheduler } from '../lib/scheduler.js'
import { createHttpHandler } from '../lib/http.js'
import { remoteCapabilities } from '../lib/sync.js'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-c09-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)

// dispatcher 只做两件事：记下派工（判「补位有没有真的发生」），其余给最小成功值。
const dispatched = []
const dispatcher = {
  dispatch: async (task) => { dispatched.push(task.id); return { ok: true } },
  merge: async () => ({ ok: true, commit: 'deadbeef' }),
  removeWorktree: async () => ({ ok: true }),
  openPr: async () => ({ ok: true }),
  requestReview: async () => ({ ok: true }),
}
const sched = createScheduler({ domain, dispatcher, store, log: () => {} })

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
    console.log('    ' + String((err && err.message) || err).split(NL)[0])
  }
}

/** 每个用例一个独立项目：配置互不串台，also 让 since 的取值可以逐例控制。 */
async function freshProject(name) {
  const project = await domain.ensureProject({ workspacePath: join(dir, name), name })
  return project
}

/**
 * 把一条 issue 先落成镜像（走真实的 applySyncResults，而不是手写 state）——
 * 「历史 issue 也要进 mirror」正是本票要保住的那一半语义。
 *
 * applySyncResults 会顺手把镜像事件塞进 event_inbox，这里立刻消费掉：
 * 否则 tick 会先把这个事件处理掉，用例就没法自己控制 payload（createdAt / live）。
 */
async function seedMirror(project, remoteId, title = '历史 issue') {
  await domain.applySyncResults(project.id, {
    cursors: {},
    inbound: {
      issues: [{
        remoteId: String(remoteId), remoteRev: 'rev-' + remoteId, kind: 'issue', source: 'github',
        title, body: 'body ' + remoteId, state: 'open',
      }],
      comments: [],
    },
  })
  await domain.consume(domain.pendingEvents(500).map((e) => e.id))
  const mirror = domain.mirrorList(project.id).find((m) => String(m.remoteId) === String(remoteId))
  assert.ok(mirror, '前置：镜像要落库（remoteId=' + remoteId + '）')
  assert.equal(mirror.taskId, null, '前置：镜像还没绑卡')
  return mirror
}

/** 投一条「镜像刚看到这条 issue」的事件（形状与 mergeRemoteItems 造的一致，只多带 createdAt/live）。 */
async function ingestMirror(project, remoteId, extra = {}) {
  const env = {
    source: 'github',
    type: 'issue.mirrored',
    refKind: 'issue',
    refId: String(remoteId),
    dedupeKey: 'github:issue:' + remoteId + ':' + (extra.rev || 'r1'),
    payload: { projectId: project.id, remoteId: String(remoteId), title: '远程 issue ' + remoteId, state: 'open', ...extra },
  }
  const res = await domain.ingest(env)
  assert.equal(res.ok, true, '事件要入信箱：' + JSON.stringify(res).slice(0, 120))
  return res
}

const tasksOf = (project) => Object.values(store.state.tasks).filter((x) => x.projectId === project.id)
const taskForRemote = (project, remoteId) => tasksOf(project).find((x) => x.remote && String(x.remote.issueNumber) === String(remoteId)) || null

// ---------------------------------------------------------------------------
// ① 升级兼容：autoLane 未设置 + autoDispatch:true → 照旧建卡（本票唯一的线上破坏点）
// ---------------------------------------------------------------------------
await t('① autoLane 未设置 + autoDispatch:true → 照旧建卡（升级不能让人停止建卡）', async () => {
  const project = await freshProject('c09-compat')
  // 老项目就是这样：只有 autoDispatch，配置里根本没有 autoLane 这个键。
  await domain.updateProjectConfig(project.id, { autoDispatch: true }, { role: 'human' })
  assert.equal(store.state.projects[project.id].config.autoLane, undefined, '前置：autoLane 必须是未设置')
  await seedMirror(project, '9101')
  await ingestMirror(project, '9101')
  const report = await sched.tick()
  assert.equal(report.ingested, 1, 'autoDispatch:true 的老项目必须继续建卡')
  const task = taskForRemote(project, '9101')
  assert.ok(task, '卡要建出来')
  assert.equal(task.lane, 'issue')
  // 镜像要回写到 taskId：不回写的话下一轮会把同一条 issue 再建一张卡
  const mirror = domain.mirrorList(project.id).find((m) => String(m.remoteId) === '9101')
  assert.equal(mirror.taskId, task.id)
})

// ---------------------------------------------------------------------------
// ② 新开关能压住旧开关：autoLane:false + autoDispatch:true → 不建卡
// ---------------------------------------------------------------------------
await t('② autoLane:false + autoDispatch:true → 不建卡（新开关压住旧开关）', async () => {
  const project = await freshProject('c09-off')
  await domain.updateProjectConfig(project.id, { autoDispatch: true, autoLane: false }, { role: 'human' })
  await seedMirror(project, '9102')
  await ingestMirror(project, '9102')
  const report = await sched.tick()
  assert.equal(report.ingested, 0, 'autoLane:false 时一张卡都不该建')
  assert.equal(taskForRemote(project, '9102'), null, '不该有卡')
  // 镜像仍然在：关的是建卡，不是把已经看到的远程事实也抹掉
  assert.ok(domain.mirrorList(project.id).some((m) => String(m.remoteId) === '9102'), '镜像仍要落库')
})

// ---------------------------------------------------------------------------
// ③ autoLane:true + autoDispatch:false → 建卡，但不补位派工
// ---------------------------------------------------------------------------
await t('③ autoLane:true + autoDispatch:false → 建卡但不补位派工', async () => {
  const project = await freshProject('c09-no-dispatch')
  await domain.updateProjectConfig(project.id, { autoLane: true, autoDispatch: false }, { role: 'human' })
  await seedMirror(project, '9103')
  await ingestMirror(project, '9103')
  const report = await sched.tick()
  assert.equal(report.ingested, 1, 'autoLane:true 必须建卡')
  assert.ok(taskForRemote(project, '9103'), '卡要建出来')
  // 补位（refill）仍然只认 autoDispatch：关着就一次派工都不许发生
  assert.deepEqual(report.dispatched, [], 'autoDispatch:false 时不许补位派工')
  assert.deepEqual(dispatched, [])
})

// ---------------------------------------------------------------------------
// ④ / ⑤ since 的两侧：之后的建卡，之前的只落镜像
// ---------------------------------------------------------------------------
const SINCE = '2026-01-01T00:00:00Z'

await t('④ sync.since 之后出现的 issue 建卡', async () => {
  const project = await freshProject('c09-since-after')
  await domain.updateProjectConfig(project.id, { autoLane: true, sync: { since: SINCE } }, { role: 'human' })
  await seedMirror(project, '9104')
  // 样本用 Z 结尾的 ISO：Gitea / GitHub 都是这个形状（带时区偏移的比法见 ticket 风险）
  await ingestMirror(project, '9104', { createdAt: '2026-06-01T00:00:00Z' })
  const report = await sched.tick()
  assert.equal(report.ingested, 1, 'since 之后的 issue 要建卡')
  assert.ok(taskForRemote(project, '9104'))
})

await t('⑤ sync.since 之前的 issue 不建卡，但镜像落库', async () => {
  const project = await freshProject('c09-since-before')
  await domain.updateProjectConfig(project.id, { autoLane: true, sync: { since: SINCE } }, { role: 'human' })
  await seedMirror(project, '9105')
  await ingestMirror(project, '9105', { createdAt: '2025-03-01T00:00:00Z' })
  const report = await sched.tick()
  assert.equal(report.ingested, 0, 'since 之前的 issue 不该建卡')
  assert.equal(taskForRemote(project, '9105'), null, '不该有卡')
  const mirror = domain.mirrorList(project.id).find((m) => String(m.remoteId) === '9105')
  assert.ok(mirror, '镜像必须落库（历史 issue 仍要留索引）')
  assert.equal(mirror.taskId, null, '镜像不该被绑卡')
  // 跳过要留痕，不能静默
  const skip = report.issueLane.find((x) => x.skipped === 'before-since' && String(x.remoteId) === '9105')
  assert.ok(skip, 'report.issueLane 要记下被 since 挡住的条目：' + JSON.stringify(report.issueLane))
})

// ---------------------------------------------------------------------------
// ⑥ 没有 createdAt → 放行（极老 issue / 某些 Gitea 版本）
// ---------------------------------------------------------------------------
await t('⑥ issue 没有 createdAt → 仍然建卡（宁多建，不静默丢）', async () => {
  const project = await freshProject('c09-no-created')
  await domain.updateProjectConfig(project.id, { autoLane: true, sync: { since: SINCE } }, { role: 'human' })
  await seedMirror(project, '9106')
  await ingestMirror(project, '9106')   // 不带 createdAt
  const report = await sched.tick()
  assert.equal(report.ingested, 1, '没有 createdAt 时必须放行')
  assert.ok(taskForRemote(project, '9106'))
})

// ---------------------------------------------------------------------------
// ⑦ / ⑧ recordIssues 与自动化开关的解耦（走真实 HTTP 动作表）
// ---------------------------------------------------------------------------
const host = {
  domain,
  runtime: null,
  resolveProjectById: (id) => store.state.projects[id],
  listProjects: () => Object.values(store.state.projects),
}
const handler = createHttpHandler(host)
async function post(action, args) {
  const res = await handler(new Request('http://local/api/flow/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args }),
  }))
  return { status: res.status, body: await res.json() }
}

await t('⑦ recordIssues:false 时 autoLane:true 仍被 http 层拒绝（防误配）', async () => {
  const project = await freshProject('c09-http-off')
  const res = await post('project.config', { projectId: project.id, patch: { autoLane: true } })
  assert.equal(res.body.result.ok, false, '纯本地看板模式不该能开 autoLane')
  assert.match(String(res.body.result.message), /纯本地看板|记录 issue/)
  assert.equal(store.state.projects[project.id].config.autoLane, undefined, '被拒时配置不能变')
})

await t('⑧ recordIssues:true + autoLane:true → http 允许写入（解耦生效）', async () => {
  const project = await freshProject('c09-http-on')
  await post('project.config', { projectId: project.id, patch: { recordIssues: true } })
  const res = await post('project.config', { projectId: project.id, patch: { autoLane: true } })
  assert.equal(res.body.result.ok !== false, true, JSON.stringify(res.body.result).slice(0, 200))
  assert.equal(store.state.projects[project.id].config.autoLane, true)
})

// ---------------------------------------------------------------------------
// ⑨ 远程能力表：收尾能力（C-06 / 看板据此置灰）
// ---------------------------------------------------------------------------
await t('⑨ remoteCapabilities 含 canClosePull / canListPulls（按 provider）', async () => {
  const gh = { config: { remote: { kind: 'github', owner: 'o', repo: 'r' } } }
  const capsGh = remoteCapabilities(gh)
  assert.equal(capsGh.canClosePull, true)
  assert.equal(capsGh.canListPulls, true)
  const gitea = remoteCapabilities({ config: { remote: { kind: 'gitea', owner: 'o', repo: 'r', baseUrl: 'https://gitea.local' } } })
  assert.equal(gitea.canClosePull, true)
  assert.equal(gitea.canListPulls, true)
  // 没配坐标 / 未知后端：宁可置灰（猜错会让人点了没反应）
  assert.equal(remoteCapabilities({ config: { remote: { kind: 'github' } } }).canClosePull, false)
  assert.equal(remoteCapabilities({ config: { remote: { kind: 'unknown', owner: 'o', repo: 'r' } } }).canClosePull, false)
})

// ---------------------------------------------------------------------------
// ⑩ 入站建卡带 visibility（rf-04 写侧补漏）
// ---------------------------------------------------------------------------
await t('⑩ autoLane 建的卡默认 visibility=auto（不上看板），showAutoCards 可覆盖', async () => {
  const project = await freshProject('c09-visibility')
  await domain.updateProjectConfig(project.id, { autoLane: true }, { role: 'human' })
  await seedMirror(project, '9110')
  await ingestMirror(project, '9110')
  await sched.tick()
  const auto = taskForRemote(project, '9110')
  assert.ok(auto, '卡要建出来')
  assert.equal(auto.visibility, 'auto', '自动车道的卡默认不上看板')

  // 覆盖位：人明确要「在板上盯着自动卡」时，建出的卡要落在 board
  const project2 = await freshProject('c09-visibility-on')
  await domain.updateProjectConfig(project2.id, { autoLane: true, showAutoCards: true }, { role: 'human' })
  await seedMirror(project2, '9111')
  await ingestMirror(project2, '9111')
  await sched.tick()
  const shown = taskForRemote(project2, '9111')
  assert.ok(shown, '卡要建出来')
  assert.equal(shown.visibility, 'board')
})

// ---------------------------------------------------------------------------
// ⑪ webhook 信封（live:true）绕过 since —— 新 issue 不能被历史分界挡住
// ---------------------------------------------------------------------------
await t('⑪ webhook 的 live:true 绕过 since（刚发生的事天然 fresh）', async () => {
  const project = await freshProject('c09-live')
  await domain.updateProjectConfig(project.id, { autoLane: true, sync: { since: SINCE } }, { role: 'human' })
  await seedMirror(project, '9112')
  // webhook 归一化会把 created_at 丢掉，但即使带上了，live:true 也必须放行
  await ingestMirror(project, '9112', { createdAt: '2025-01-01T00:00:00Z', live: true })
  const report = await sched.tick()
  assert.equal(report.ingested, 1, 'webhook 事件不该被 since 拦')
  assert.ok(taskForRemote(project, '9112'))
})

// ---------------------------------------------------------------------------
// ⑫ 补充 §6：只接别人 PR 的项目也要能开自动化开关
// ---------------------------------------------------------------------------
await t('⑫ recordPulls-only（recordIssues:false）也能开 autoMerge', async () => {
  const project = await freshProject('c09-pulls-only')
  await post('project.config', { projectId: project.id, patch: { recordPulls: true } })
  const res = await post('project.config', { projectId: project.id, patch: { autoMerge: true } })
  assert.equal(res.body.result.ok !== false, true, JSON.stringify(res.body.result).slice(0, 200))
  assert.equal(store.state.projects[project.id].config.autoMerge, true)
})

// ---------------------------------------------------------------------------
console.log('')
if (fails.length) {
  console.log('autolane FAILED: ' + fails.length + ' / ' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ' :: ' + String((f.err && f.err.message) || f.err).split(NL)[0])
  process.exitCode = 1
} else {
  console.log('autolane ok (' + pass + ' cases)')
}
