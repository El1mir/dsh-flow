/**
 * C-04：自动化的两道守卫（rf-02 / rf-04）。
 *
 * 只有这几种东西值得测：
 *  1. autoMerge 不该每 15 秒去撞一张已经被判 blocked 的卡（mergeState 过滤 + 老卡兼容）；
 *  2. autoAccept 不能把「需要合并」的卡直接落成 done（rf-02 的核心不变式）；
 *  3. 自动车道的留痕必须只统计 visibility='auto' 的卡（rf-04：隐藏不等于失明）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createScheduler } from '../lib/scheduler.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-c04-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)
const logs = []
let mergeCalls = []
const dispatcher = {
  merge: async (task) => {
    mergeCalls.push(task.id)
    return { ok: true, commit: 'deadbeef', base: 'master' }
  },
}
const sched = createScheduler({ domain, dispatcher, store, log: (m) => logs.push(String(m)) })

let pass = 0
async function t(name, fn) {
  await fn()
  pass += 1
  console.log('  ok ' + pass + ' - ' + name)
}

const project = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'c04' })
await domain.updateProjectConfig(project.id, { autoAccept: true, autoMerge: true })

/** 造一张在 merging 列、审核已通过的卡。 */
async function mergingCard(mergeState, extra = {}) {
  const task = await domain.createTask(project.id, { title: '合并卡 ' + String(mergeState) })
  await domain.store.tx((s) => {
    Object.assign(s.tasks[task.id], {
      column: 'merging',
      phase: 'merge-ready',
      mergeRequest: { headSha: 'abc123', status: 'open', reviewVerdict: 'approved', baseSha: 'abc123', queuedAt: new Date().toISOString() },
      ...extra,
    })
    if (mergeState !== undefined) s.tasks[task.id].mergeState = mergeState
  })
  return store.state.tasks[task.id]
}

await t('autoMerge 对 blocked 但原因未知的卡仍试一次（不焊死，靠退避止噪）', async () => {
  mergeCalls = []
  const task = await mergingCard('blocked')
  await sched.tick()
  // 口径与 dispatch 的 canEnterMerge 一致：只有**契约类**原因才一律拒绝；
  // 环境原因是开放集合（integ-dirty / repo-dirty / wrong-branch…），白名单漏一个就是永久焊死。
  assert.equal(mergeCalls.includes(task.id), true)
})

await t('autoMerge 合 ready 的卡', async () => {
  mergeCalls = []
  const task = await mergingCard('ready')
  await sched.tick()
  assert.equal(mergeCalls.includes(task.id), true)
})

await t('autoMerge 合 pending 的卡', async () => {
  mergeCalls = []
  const task = await mergingCard('pending')
  await sched.tick()
  assert.equal(mergeCalls.includes(task.id), true)
})

await t('autoMerge 跳过 none 的卡（没有可合的东西）', async () => {
  mergeCalls = []
  const task = await mergingCard('none')
  await sched.tick()
  assert.equal(mergeCalls.includes(task.id), false)
})

await t('autoMerge 对没有 mergeState 的老卡仍然放行（schema 12 兼容）', async () => {
  mergeCalls = []
  const task = await mergingCard(undefined)
  delete store.state.tasks[task.id].mergeState
  await sched.tick()
  assert.equal(mergeCalls.includes(task.id), true)
})

await t('autoAccept：需要合并的卡只能推到 merging，不能直接 done', async () => {
  const task = await domain.createTask(project.id, { title: '待验收' })
  await domain.store.tx((s) => {
    Object.assign(s.tasks[task.id], {
      column: 'verifying',
      phase: 'awaiting-acceptance',
      mergeState: 'pending',
      stopReport: { summary: '改完了', tests: 'npm test 12 passed', acceptanceStatus: [{ index: 0, status: 'pass' }] },
    })
  })
  await sched.tick()
  const after = store.state.tasks[task.id]
  assert.equal(after.column, 'merging', '必须进合并列等真合并')
  assert.equal(after.phase, 'merge-ready')
})

await t('autoAccept：没有可合的东西才落 done-no-merge', async () => {
  const task = await domain.createTask(project.id, { title: '无需合并' })
  await domain.store.tx((s) => {
    Object.assign(s.tasks[task.id], {
      column: 'verifying',
      phase: 'awaiting-acceptance',
      mergeState: 'none',
      worktree: false,
      stopReport: { summary: '文档改动', tests: '无（只改文档）', acceptanceStatus: [{ index: 0, status: 'pass' }] },
    })
  })
  await sched.tick()
  const after = store.state.tasks[task.id]
  assert.equal(after.column, 'done')
  assert.equal(after.phase, 'done-no-merge')
})

await t('自动车道留痕只算 visibility=auto 的卡', async () => {
  const mk = async (title, visibility) => {
    const task = await domain.createTask(project.id, { title })
    await domain.store.tx((s) => {
      Object.assign(s.tasks[task.id], {
        column: 'verifying',
        phase: 'awaiting-acceptance',
        visibility,
        mergeState: 'none',
        worktree: false,
        stopReport: { summary: '完成', tests: 'none', acceptanceStatus: [{ index: 0, status: 'pass' }] },
      })
    })
    return task
  }
  const auto = await mk('自动卡', 'auto')
  const board = await mk('人卡', 'board')
  const report = await sched.tick()
  assert.equal(report.autoLane.accepted, 1, '只算自动卡')
  assert.equal(report.autoLane.merged, 0)
  assert.equal(report.autoLane.failed, 0)
  const autoAfter = store.state.tasks[auto.id]
  const boardAfter = store.state.tasks[board.id]
  assert.equal(autoAfter.column, 'done')
  assert.equal(boardAfter.column, 'done')
  assert.ok(logs.some((l) => l.startsWith('auto-lane:')), '有动作时要留一行日志')
})

await t('autoLane 在没有自动卡动作时不刷日志', async () => {
  logs.length = 0
  const report = await sched.tick()
  assert.equal(report.autoLane.accepted + report.autoLane.merged + report.autoLane.failed, 0)
  assert.equal(logs.some((l) => l.startsWith('auto-lane:')), false)
})


// ---- C-10：合并列缺 PR 快照时自动补开 ----
const p2 = await domain.ensureProject({ workspacePath: join(dir, 'repo2'), name: 'c10' })
await domain.updateProjectConfig(p2.id, { autoDispatch: true })
let openCalls = 0
let openResult = { ok: true }
const sched2 = createScheduler({
  domain,
  dispatcher: {
    merge: async () => ({ ok: true, commit: 'cafe', base: 'master' }),
    openPr: async () => { openCalls += 1; return openResult },
  },
  store,
  log: (m) => logs.push(String(m)),
})
async function mergingNoPr(title) {
  const task = await domain.createTask(p2.id, { title })
  await domain.store.tx((s2) => {
    Object.assign(s2.tasks[task.id], { column: 'merging', phase: 'merge-ready', mergeState: 'pending' })
  })
  return store.state.tasks[task.id]
}

await t('合并列没有 PR 快照 → 自动开一次', async () => {
  openCalls = 0
  openResult = { ok: true }
  const task = await mergingNoPr('缺快照')
  const report = await sched2.tick()
  assert.equal(openCalls, 1, '应该调用一次 openPr')
  assert.ok(report.advanced.some((x) => x.taskId === task.id && x.action === 'open_pr'))
})

await t('开 PR 失败写退避时间戳，10 分钟内不再撞', async () => {
  openCalls = 0
  openResult = { ok: false, message: '工作区有未提交改动' }
  const task = await mergingNoPr('开 PR 会失败')
  await sched2.tick()
  assert.equal(openCalls, 1)
  assert.ok(store.state.tasks[task.id].prOpenFailedAt, '要记下失败时间用于退避')
  await sched2.tick()
  assert.equal(openCalls, 1, '退避窗口内不该再调')
})


// ---- C-04 退避：环境类 blocked 能自己恢复，契约类 blocked 永不自动重试 ----
await t('blocked + 环境类原因（没有退避记录）→ 自动通道会再试一次', async () => {
  mergeCalls = []
  const task = await mergingCard('blocked')
  await domain.store.tx((s2) => { s2.tasks[task.id].mergeReason = 'out-of-scope-dirty' })
  await sched.tick()
  assert.equal(mergeCalls.includes(task.id), true, '环境修好后应当能自己接着做')
})

await t('blocked + 契约类原因（head-mismatch）→ 自动通道永不重试', async () => {
  mergeCalls = []
  const task = await mergingCard('blocked')
  await domain.store.tx((s2) => { s2.tasks[task.id].mergeReason = 'head-mismatch' })
  await sched.tick()
  assert.equal(mergeCalls.includes(task.id), false, '契约类要人先改卡，重试没有意义')
})

await t('blocked + 环境类原因但刚失败过 → 退避窗口内不撞', async () => {
  mergeCalls = []
  const task = await mergingCard('blocked')
  await domain.store.tx((s2) => {
    s2.tasks[task.id].mergeReason = 'out-of-scope-dirty'
    s2.tasks[task.id].mergeRetryAt = new Date().toISOString()
  })
  await sched.tick()
  assert.equal(mergeCalls.includes(task.id), false)
})

await t('合并失败会写 mergeRetryAt，下一拍不再撞', async () => {
  const task = await mergingCard('ready')
  const failing = createScheduler({
    domain,
    dispatcher: { merge: async () => ({ ok: false, message: 'git 挂了' }) },
    store,
    log: () => {},
  })
  await failing.tick()
  assert.ok(store.state.tasks[task.id].mergeRetryAt, '失败要留退避时间')
  mergeCalls = []
  await failing.tick()
  assert.equal(mergeCalls.length, 0)
})

console.log('automation guards ok (' + pass + ' checks)')