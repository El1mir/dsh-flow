/**
 * align.mjs — 「界面字段 ↔ 事务模型」对齐测试。
 *
 * 目的：把"功能和事务逻辑对齐"从口头声称变成可执行断言。
 * 每走一步状态机，就用 buildProjectView（界面数据源）读一次，
 * 校验界面看到的列 / phase / version / 租约 / 审批 / 事件，
 * 与 docs/事务流设计.md 的迁移表逐条对应。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import * as panel from '../lib/panel.js'
import { buildProjectView } from '../lib/panel.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-align-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)

let pass = 0
const t = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log('  ✓ ' + name)
  } catch (err) {
    console.error('  ✗ ' + name + '\n    ' + (err && err.message ? err.message : err))
    throw err
  }
}

// 假 runtime：只记录投递，不真的开 DSH 会话
const sent = []
const runtime = {
  async ensureSession(agent, project, opts = {}) {
    const rec = domain.latestSession(agent.id)
    const want = (opts && opts.cwd) || (project && project.workspacePath) || null
    if (rec && rec.sessionId && (!want || !rec.cwd || rec.cwd === want)) return { ok: true, sessionId: rec.sessionId, created: false }
    const sid = 'ses-' + agent.id
    await domain.bindSession(agent.id, sid, { state: 'idle', cwd: want }, { role: 'system' })
    return { ok: true, sessionId: sid, created: true }
  },
  async promptSession(sessionId, text, mode) { sent.push({ sessionId, text, mode }); return { ok: true } },
  async workerGoal() { return { ok: true } },
}
const dispatcher = createDispatcher({ domain, runtime, store, git: null, log: () => {} })

const project = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'align' })
const viewOf = () => buildProjectView(store.state, project.id, { eventLimit: 80 })
const taskCard = (id) => {
  const v = viewOf()
  for (const col of v.columns) {
    const hit = (v.tasks[col.id] || []).find((x) => x.id === id)
    if (hit) return hit
  }
  return null
}

console.log('\n事务链对齐（建卡 → 合并）')

const task = await domain.createTask(project.id, {
  title: '对齐测试卡',
  note: '验证界面字段与事务模型一致',
  acceptance: ['列/phase 与迁移表一致', '版本单调递增'],
  scope: { paths: ['lib/core.js'], symbols: ['emit'] },
})

await t('建卡：出现在待办列，版本为 0', () => {
  const v = viewOf()
  const card = (v.tasks.todo || []).find((x) => x.id === task.id)
  assert.ok(card, '待办列应有这张卡')
  assert.equal(card.version, 0)
  assert.equal(card.column, 'todo')
  assert.equal(card.lane, 'human')
  assert.deepEqual(card.scope.paths, ['lib/core.js'], '阅读范围要透出给界面')
  assert.equal(v.columns.find((c) => c.id === 'todo').count, 1, '列计数要跟着走')
})

await domain.move(task.id, 'claim', { role: 'dispatcher', id: 'sched' })
await t('claim：移到规划中，版本 +1', () => {
  const card = taskCard(task.id)
  assert.equal(card.column, 'planning')
  assert.equal(card.version, 1)
  const v = viewOf()
  assert.equal(v.columns.find((c) => c.id === 'planning').count, 1)
  assert.equal(v.columns.find((c) => c.id === 'todo').count, 0)
})

await domain.setPlan(task.id, '1. 改 core.js\n2. 跑测试', { role: 'dispatcher', id: 'sched' })
await t('setPlan：界面拿到 plan.revision，未审批时 approvedRevision 为空', () => {
  const card = taskCard(task.id)
  assert.equal(card.plan.revision, 1)
  assert.equal(card.plan.hasText, true)
  assert.equal(card.plan.approvedRevision, null, '还没批准')
})

await domain.move(task.id, 'plan_ready', { role: 'dispatcher', id: 'sched' })
await t('plan_ready：phase=waiting-approval（界面要看得到）', () => {
  const card = taskCard(task.id)
  assert.equal(card.phase, 'waiting-approval')
})

await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
await t('approve：进执行中 + 审批绑定 plan rev1', () => {
  const card = taskCard(task.id)
  assert.equal(card.column, 'running')
  assert.equal(card.phase, 'executing')
  assert.equal(card.plan.approvedRevision, 1, '批准要绑定当前 plan 版本')
  const v = viewOf()
  const ap = v.approvals.find((a) => a.taskId === task.id && a.kind === 'plan')
  assert.ok(ap, '最近审批里要出现 plan 审批')
  assert.equal(ap.planRevision, 1, 'plan 审批绑的是 plan 版本号')
  assert.equal(ap.revokedAt, null, '未吊销')
})

await t('approve 后版本继续单调', () => {
  const card = taskCard(task.id)
  assert.equal(card.version, 4, 'claim+plan(setPlan 也 +1)+plan_ready+approve')
})

// 派工（走 dispatch 的 L1 部分：占租约 + run）
const worker = domain.workersOf(project.id, 'human')[0]
await domain.bindSession(worker.id, 'ses-w1', { state: 'idle', cwd: null }, { role: 'system' })
const { run } = await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-w1', trigger: 'approve' })
await domain.setDispatchReason(task.id, { workerId: worker.id, cost: 1.1, overlap: 0.5 }, { role: 'system' })
await t('派工：界面看到 assignee / activeRunId / run 列表 / 任务租约', () => {
  const card = taskCard(task.id)
  assert.equal(card.assignee, worker.id)
  assert.equal(card.activeRunId, run.id)
  assert.ok(card.dispatchReason && card.dispatchReason.workerId === worker.id, '派工依据要可见')
  const v = viewOf()
  assert.ok(v.runs.some((r) => r.runId === run.id), '运行中的 run 要进列表')
  assert.ok(v.leases.some((l) => l.key === 'task:' + task.id), '任务租约要可见')
})

await domain.move(task.id, 'stop', { role: 'worker', id: worker.id }, { stopReport: { summary: '改完了', tests: 'bun test 通过' } })
await domain.endRun(task.id, 'stopped', {})
await t('stop：进待验收，停止报告进界面', () => {
  const card = taskCard(task.id)
  assert.equal(card.column, 'verifying')
  assert.equal(card.phase, 'awaiting-acceptance')
  assert.equal(card.stopReport.summary, '改完了')
  const v = viewOf()
  assert.equal(v.leases.some((l) => l.key === 'task:' + task.id), false, 'run 结束租约要释放')
})

await domain.setInspection(task.id, 'done', ['证据齐全'], { role: 'dispatcher', id: 'sched' })
await t('巡检结论落库并在界面可见', () => {
  const card = taskCard(task.id)
  assert.equal(card.inspection.verdict, 'done')
  assert.equal(card.inspection.reasons[0], '证据齐全')
})

await domain.move(task.id, 'accept', { role: 'human', id: 'me' }, { headSha: 'abc123' })
await t('验收：绑 head_sha 进合并中 + head 审批', () => {
  const card = taskCard(task.id)
  assert.equal(card.column, 'merging')
  assert.equal(card.phase, 'merge-ready')
  const v = viewOf()
  const ap = v.approvals.find((a) => a.taskId === task.id && a.kind === 'head')
  assert.ok(ap, '验收要落 head 审批')
  assert.equal(ap.headSha, 'abc123', 'head 审批绑的是验收时的 head_sha')
})

await domain.openMergeRequest(task.id, { headSha: 'abc123', files: ['lib/core.js'], summary: '改 emit' }, { role: 'worker', id: worker.id })
await domain.move(task.id, 'pr_open', { role: 'worker', id: worker.id })
await t('开 PR：界面看到 PR 快照与 review-pending', () => {
  const card = taskCard(task.id)
  assert.equal(card.phase, 'review-pending')
  assert.equal(card.mergeRequest.headSha, 'abc123')
})

await domain.setReviewVerdict(task.id, 'approved', '风险项都过了', [{ id: 'R-API 破坏', version: 1 }], { role: 'dispatcher', id: 'sched' })
// v1.32 起「审核通过 ≠ 已合并」：真实路径是合并事务先 markMerged 记提交，再 review_approve
await domain.markMerged(task.id, { commit: 'abc123', strategy: 'merge' })
await domain.move(task.id, 'review_approve', { role: 'dispatcher', id: 'sched' })
await t('合并：进完成列', () => {
  const card = taskCard(task.id)
  assert.equal(card.column, 'done')
  assert.equal(card.phase, 'merged')
  assert.equal(card.mergeRequest.reviewVerdict, 'approved')
  const v = viewOf()
  assert.equal(v.columns.find((c) => c.id === 'done').count, 1)
})

await t('事件链覆盖整条事务（界面的事务事件区）', () => {
  const v = viewOf()
  const types = new Set(v.events.map((e) => e.type))
  for (const need of ['task.created', 'task.dispatched', 'task.inspection', 'task.run.ended', 'approval.recorded']) {
    assert.ok(types.has(need), '事件流缺少 ' + need)
  }
  assert.equal(v.events.some((e) => /上下文水位/.test(e.text)), false, '水位噪声不应出现在事务事件里')
})

console.log('\n事务链对齐（取消 / 重开 / 改派 / 阻塞）')

const t2 = await domain.createTask(project.id, { title: '取消与重开', acceptance: ['a'] })
await domain.move(t2.id, 'claim', { role: 'dispatcher', id: 'sched' })
await domain.move(t2.id, 'cancel', { role: 'human', id: 'me' })
await t('取消：进已取消列', () => {
  const card = taskCard(t2.id)
  assert.equal(card.column, 'cancelled')
})

await domain.move(t2.id, 'reopen', { role: 'human', id: 'me' }, { reopenReason: '需求变了' })
await t('重开：回待办且计数 +1', () => {
  const card = taskCard(t2.id)
  assert.equal(card.column, 'todo')
  assert.equal(card.reopenCount, 1)
  assert.equal(card.plan.approvedRevision, null, '重开要清掉上一轮审批')
})

await domain.block(t2.id, '等接口', { role: 'human', id: 'me' })
await t('阻塞：界面看到阻塞原因', () => {
  const card = taskCard(t2.id)
  assert.ok(card.blocked)
  assert.equal(card.blocked.reason, '等接口')
})
await domain.unblock(t2.id, { role: 'human', id: 'me' })
await t('解除阻塞', () => {
  const card = taskCard(t2.id)
  assert.equal(card.blocked, null)
})

const w2 = domain.workersOf(project.id, 'human')[1]
await t('改派：reparent 后界面拿到新的 supervisorId', async () => {
  await domain.reparent(w2.id, domain.supervisorOf(project.id, 'human').id, { role: 'human', id: 'me' })
  const v = viewOf()
  const row = v.agents.find((a) => a.id === w2.id)
  assert.ok(row)
  assert.equal(row.supervisorId, domain.supervisorOf(project.id, 'human').id)
  assert.equal(row.lane, 'human')
})

await t('车道隔离：issue 任务不落 human 工人', async () => {
  const t3 = await domain.createTask(project.id, { title: 'issue 任务', lane: 'issue' })
  let threw = null
  try {
    await domain.startRun(t3.id, { agentId: w2.id, sessionId: 'ses-w2', trigger: 'system' }, { role: 'system' })
  } catch (e) { threw = e }
  assert.ok(threw && /车道/.test(threw.message), threw && threw.message)
})

console.log('\n视图契约（字段面）')

await t('界面拿到的每张卡都有事务字段（缺一个界面就会画错）', () => {
  const v = viewOf()
  const fields = ['id', 'title', 'lane', 'column', 'phase', 'version', 'blocked', 'assignee', 'activeRunId', 'plan', 'stopReport', 'mergeRequest', 'inspection', 'scope', 'subtasks', 'reopenCount']
  for (const col of v.columns) {
    for (const card of (v.tasks[col.id] || [])) {
      for (const f of fields) assert.ok(f in card, card.id + ' 缺少字段 ' + f)
    }
  }
})

await t('七列顺序与状态机一致', () => {
  const v = viewOf()
  assert.deepEqual(v.columns.map((c) => c.id), ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled'])
  assert.deepEqual(v.columns.map((c) => c.title), ['待办', '规划中', '执行中', '待验收', '合并中', '完成', '已取消'])
})

await t('双车道都在视图里', () => {
  const v = viewOf()
  assert.ok(v.lanes.human && v.lanes.issue)
  assert.equal(typeof v.lanes.human.budget.max, 'number')
})

await t('主调度绑定状态进视图', async () => {
  await domain.bindChiefSession(project.id, 'ses-chief-align', { cwd: project.workspacePath }, { role: 'human', id: 'me' })
  const v = viewOf()
  assert.equal(v.project.chiefSessionId, 'ses-chief-align')
})

console.log('\n数据清理（remove 只能走 domain，不能手改 JSON）')

await t('removeTask：任务与其评论/审批/租约一起消失', async () => {
  const victim = await domain.createTask(project.id, { title: '待删除任务' })
  await domain.move(victim.id, 'claim', { role: 'dispatcher', id: 'sched' })
  await domain.setPlan(victim.id, 'p', { role: 'dispatcher', id: 'sched' })
  await domain.move(victim.id, 'plan_ready', { role: 'dispatcher', id: 'sched' })
  await domain.move(victim.id, 'approve', { role: 'human', id: 'me' })
  assert.ok(store.state.tasks[victim.id])
  assert.ok(Object.values(store.state.approvals).some((a) => a.taskId === victim.id), '先有审批')
  await domain.removeTask(victim.id, { role: 'human', id: 'me' })
  assert.equal(store.state.tasks[victim.id], undefined)
  assert.equal(Object.values(store.state.approvals).some((a) => a.taskId === victim.id), false, '审批要一起删')
  const v = viewOf()
  for (const col of v.columns) {
    assert.equal((v.tasks[col.id] || []).some((x) => x.id === victim.id), false, '界面不能再出现')
  }
})

await t('removeProject：项目连同任务/代理/会话/租约一起清', async () => {
  const junk = await domain.ensureProject({ workspacePath: join(dir, 'junk-project'), name: 'junk' })
  const t9 = await domain.createTask(junk.id, { title: 'junk 任务' })
  const w = domain.workersOf(junk.id, 'human')[0]
  await domain.bindSession(w.id, 'ses-junk', { state: 'idle', cwd: junk.workspacePath }, { role: 'system' })
  await domain.startRun(t9.id, { agentId: w.id, sessionId: 'ses-junk', trigger: 'system' })
  assert.ok(store.state.tasks[t9.id])
  const res = await domain.removeProject(junk.id, { role: 'human', id: 'me' })
  assert.equal(res.removedTasks, 1)
  assert.equal(store.state.projects[junk.id], undefined)
  assert.equal(store.state.tasks[t9.id], undefined, '任务要一起删')
  assert.equal(Object.values(store.state.agents).some((a) => a.projectId === junk.id), false, '代理要一起删')
  assert.equal(Object.values(store.state.agent_sessions).some((r) => r.projectId === junk.id), false, '会话绑定要一起删')
  assert.equal(store.state.leases['task:' + t9.id], undefined, '租约要一起删')
})

await t('删除后视图仍然自洽（列计数与任务对得上）', () => {
  const v = viewOf()
  const counted = v.columns.reduce((n, c) => n + c.count, 0)
  const listed = v.columns.reduce((n, c) => n + (v.tasks[c.id] || []).length, 0)
  assert.equal(counted, listed, '列计数必须等于实际卡片数')
})

await t('空项目：七列都在，计数全 0，不报错', async () => {
  const empty = await domain.ensureProject({ workspacePath: join(dir, 'empty-project'), name: 'empty' })
  const v = panel.buildProjectView(store.state, empty.id, { eventLimit: 10 })
  assert.equal(v.ok, true)
  assert.equal(v.columns.length, 7)
  assert.ok(v.columns.every((c) => c.count === 0))
  assert.equal(v.totals.tasks, 0)
  assert.equal(v.lanes.human.running, 0)
  assert.equal(v.project.chiefSessionId, null)
})

await t('未知项目：ok:false 且不抛异常（界面走错误分支）', () => {
  const v = panel.buildProjectView(store.state, 'prj_does_not_exist')
  assert.equal(v.ok, false)
  assert.match(v.error, /unknown project/)
})

await t('删除后列计数 = 卡片数（不会出现幽灵计数）', async () => {
  const p = await domain.ensureProject({ workspacePath: join(dir, 'count-check'), name: 'count' })
  const a1 = await domain.createTask(p.id, { title: 'A' })
  const a2 = await domain.createTask(p.id, { title: 'B' })
  await domain.move(a1.id, 'claim', { role: 'dispatcher', id: 'sched' })
  let v = panel.buildProjectView(store.state, p.id)
  assert.equal(v.columns.reduce((n, c) => n + c.count, 0), 2)
  await domain.removeTask(a2.id, { role: 'human', id: 'me' })
  v = panel.buildProjectView(store.state, p.id)
  assert.equal(v.columns.reduce((n, c) => n + c.count, 0), 1)
  assert.equal(v.columns.find((c) => c.id === 'planning').count, 1)
})

await t('worktree 路径不能在领域层被建成项目（第二道闸）', async () => {
  let threw = null
  try {
    await domain.ensureProject({ workspacePath: join(dir, 'repo') + '/.flow-worktrees/repo/T-99', name: 'junk' })
  } catch (e) { threw = e }
  assert.ok(threw && /worktree/.test(threw.message), threw && threw.message)
  assert.equal(Object.values(store.state.projects).some((p) => String(p.workspacePath).includes('.flow-worktrees')), false)
})

console.log('\n' + pass + ' alignment checks passed · data ' + store.file)
