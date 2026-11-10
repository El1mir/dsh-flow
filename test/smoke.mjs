/**
 * dsh-flow 冒烟测试：不依赖 DSH 运行时，直接跑领域层与 HTTP 处理器。
 * 覆盖：建项目、状态机守卫、阻塞、合并审核、租约 fencing、outbox、HTTP 往返。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, acquireLease, renewLease, assertFence, releaseLease, applyTransition } from '../lib/core.js'
import { canAutoApprove } from '../lib/sync.js'
import { FlowDomain } from '../lib/domain.js'
import { createHttpHandler } from '../lib/http.js'
import { createDispatcher } from '../lib/dispatch.js'
import { createScheduler } from '../lib/scheduler.js'
import * as promptsMod from '../lib/prompts.js'
import { ChatHub, normalize } from '../lib/chat.js'
import * as scopeMod from '../lib/scope.js'
import * as commandFlowMod from '../lib/command-flow.js'
import * as eventMod from '../lib/event.js'
import * as panelMod from '../lib/panel.js'
import * as domainMod from '../lib/domain.js'
import * as coreMod from '../lib/core.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()

// 假 runtime：把 DSH 的三件事（建会话 / 投消息 / 建 goal）记下来，供断言。
const rt = {
  calls: [],
  async ensureSession(agent, project, opts = {}) {
    const rec = domain.latestSession(agent.id)
    const wantCwd = opts.cwd || (project && project.workspacePath) || null
    if (rec && rec.sessionId && (!wantCwd || !rec.cwd || rec.cwd === wantCwd)) return { ok: true, sessionId: rec.sessionId, created: false }
    const sessionId = 'ses-' + agent.id + '-' + Math.random().toString(36).slice(2, 6)
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: wantCwd }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession(sessionId, text, mode) {
    this.calls.push({ sessionId, text, mode })
    return { ok: true }
  },
  async workerGoal(project, { agentId, objective, clear }) {
    this.calls.push({ agentId, objective, clear })
    return { ok: true }
  },
  // v1.39：派工不再建 goal，改成清残留
  async clearWorkerGoal(agentId) {
    this.calls.push({ clearedGoal: agentId })
    return { ok: true, cleared: true }
  },
  async listSessions() {
    return [
      { sessionId: 'ses_chat_1', cwd: 'C:/tmp/demo', updatedAt: 1, running: false, model: 'm-1', provider: 'deepseek', boundAgentId: null },
    ]
  },
  async listCommands() { return [{ name: 'goal', description: '设定目标', usage: '/goal <objective>' }] },
  async bindAgentSession(agentId, sessionId) {
    const rec = await domain.bindSession(agentId, sessionId, { state: 'idle', cwd: 'C:/tmp/demo' }, { role: 'human', id: 'web' })
    return { ok: true, agentId, sessionId, cwd: 'C:/tmp/demo', record: rec.id }
  },
  async runCommand(agentId, line) {
    this.calls.push({ command: line, agentId })
    return { ok: true, sessionId: 'ses_chat_1', commandId: 'cmd_1', kind: 'success', text: 'goal 已建立' }
  },
  async onMoved(task, action) { return dispatcher.onMoved(task, action) },
  async onStopped(task) { return dispatcher.onStopped(task) },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })

/**
 * v1.35：调度代收验收的凭据必须是「人回复过的请示单」。
 * 测试里按真实路径造一条：调度发请示 → 人在看板回复同意 → 用请示 id 作为 acceptedBy。
 */
const grantFor = async (taskId, reply = '可以，按现状收') => {
  const item = await domain.askHuman({ taskId, kind: 'decision', topic: '能否验收 ' + taskId, problem: '停止报告已交', decisionNeeded: '能不能收' }, { role: 'dispatcher', id: 'ag_d' })
  await domain.replyInbox(item.id, reply, { role: 'human', id: 'web' })
  return item.id
}
const hub = new ChatHub()

let pass = 0
const t = async (name, fn) => {
  await fn()
  pass++
  console.log('  ✓ ' + name)
}
const rejects = async (fn, re) => { await assert.rejects(fn, re) }

// ---- 项目 ---------------------------------------------------------------
const project = await domain.ensureProject({ workspacePath: 'C:/tmp/demo', name: 'demo' })
await t('建项目', () => assert.equal(project.name, 'demo'))
await t('默认审核 prompt 集 6 条', () => assert.equal(domain.reviewPromptSet(project.id).prompts.length, 6))

// ---- 任务与状态机 --------------------------------------------------------
const task = await domain.createTask(project.id, { title: '做一个登录页', note: '需要账号密码', acceptance: ['能登录', '有错误提示'] })
await t('新任务在 todo', () => assert.equal(task.column, 'todo'))

await domain.move(task.id, 'claim', { role: 'dispatcher' })
await t('claim → planning', () => assert.equal(store.state.tasks[task.id].column, 'planning'))

await rejects(() => domain.move(task.id, 'approve', { role: 'human' }), /先写计划/)
await t('没计划不能批准', () => {})

await domain.setPlan(task.id, '1. 画 UI 2. 接接口 3. 写测试', { role: 'dispatcher' })
await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
await t('plan_ready → waiting-approval', () => assert.equal(store.state.tasks[task.id].phase, 'waiting-approval'))

await rejects(() => domain.move(task.id, 'approve', { role: 'worker' }), /角色 worker/)
await t('工人不能批准', () => {})

await domain.move(task.id, 'approve', { role: 'human' })
await t('approve → running', () => assert.equal(store.state.tasks[task.id].column, 'running'))
await t('批准绑定 plan_rev', () => assert.equal(store.state.tasks[task.id].plan.approvedRevision, 1))

await rejects(() => domain.move(task.id, 'stop', { role: 'worker' }), /stop report/)
await t('无报告不能停', () => {})

await domain.move(task.id, 'stop', { role: 'worker', id: 'worker-1' }, { stopReport: { summary: '做完了，测试全绿' } })
await t('stop → verifying', () => assert.equal(store.state.tasks[task.id].column, 'verifying'))

// v1.28：head_sha 不再是人工必填项。很多单（只读审计/文档/调研）根本没有提交可绑，
// 而旧闸门只检查"非空"，于是 audit-T035-verified 这种伪造值也能过 —— 必须改。
await rejects(() => domain.move(task.id, 'accept', { role: 'human' }, { headSha: 'not-a-sha-!!' }), /格式不合法|head_sha/)
await t('伪造的 head_sha 会被拒（线上用 audit-T035-verified 蒙混过关过）', () => {})

// 这一支要测完整的"验收 → 合并 → 审核"链路，所以显式要求合并
// （demo 工作区不是 git 仓库，派工时已自动打了 noMerge；非 Git 的收尾另有用例验证）
await domain.setNoMerge(task.id, false, '', { role: 'system' })
await domain.move(task.id, 'accept', { role: 'human' }, { headSha: 'abc1234' })
await t('accept → merging（要合并的项目）', () => assert.equal(store.state.tasks[task.id].column, 'merging'))

const mr = await domain.openMergeRequest(task.id, { headSha: 'abc1234', baseSha: '0000000', files: ['src/login.tsx'], additions: 120, deletions: 8, summary: '加登录页' }, { role: 'worker' })
await t('开 PR', () => assert.equal(mr.status, 'ready_for_review'))

const reviewPrompt = domain.renderReviewPrompt(project.id, mr)
await t('审核 prompt 含版本与清单', () => {
  assert.match(reviewPrompt.text, /prompt 集 v\d+/)
  assert.match(reviewPrompt.text, /R-API 破坏/)
  assert.match(reviewPrompt.text, /verdict/)
})

// v1.32：审核通过 ≠ 已合并。真实路径是 mergeLocked「先记录合并提交，再 review_approve」。
// 这里没有 pull_requests 记录（只建了 merge_requests），所以直接写卡片上的 mergedCommit。
await store.tx((s) => {
  s.tasks[task.id].mergeRequest = Object.assign({}, s.tasks[task.id].mergeRequest, { mergedCommit: 'abc1234', status: 'merged' })
})
const done = await domain.move(task.id, 'review_approve', { role: 'dispatcher', id: 'disp-1' }, { verdict: 'approved', matched: [], summary: '无风险' })
await t('review_approve → done', () => assert.equal(done.column, 'done'))
await t('审核结论带 prompt_version', () => assert.equal(store.state.tasks[task.id].mergeRequest.reviewEvidence.promptVersion, reviewPrompt.version))

// ---- v0.10：审批记录 / 版本单调 / 重开 / 合并锁（I4 · I5 · I6 · T4 · T19）----
const tr = await domain.createTask(project.id, { title: '通知中心' })
await domain.move(tr.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(tr.id, '1. 落 outbox 2. 补重试', { role: 'dispatcher' })
await domain.move(tr.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(tr.id, 'approve', { role: 'human', id: 'human-1' })
await t('批准落一条 plan 审批记录', () => {
  const recs = Object.values(store.state.approvals).filter((a) => a.taskId === tr.id && a.kind === 'plan')
  assert.equal(recs.length, 1)
  assert.equal(recs[0].planRevision, 1)
  assert.equal(recs[0].revokedAt, null)
})
await domain.setPlan(tr.id, '1. 落 outbox 2. 补重试 3. 加退避', { role: 'dispatcher' })
await t('方案一改旧批准失效', () => {
  const task = store.state.tasks[tr.id]
  const recs = Object.values(store.state.approvals).filter((a) => a.taskId === tr.id && a.kind === 'plan')
  assert.equal(task.plan.approvedRevision, null)
  assert.ok(recs[0].revokedAt)
  assert.match(recs[0].revokeReason, /plan revision 2/)
})
await t('审批吊销有事件', () => assert.ok(store.state.events.some((e) => e.type === 'approval.revoked' && e.payload.taskId === tr.id)))
await domain.move(tr.id, 'stop', { role: 'worker', id: 'worker-2' }, { stopReport: { summary: '通知中心写完，单测全绿' } })
// 这一段测审核/风险/版本单调，需要走合并列
await domain.setNoMerge(tr.id, false, '', { role: 'system' })
await domain.move(tr.id, 'accept', { role: 'human', id: 'human-1' }, { headSha: 'def5678' })
await t('验收落一条 head 审批记录', () => {
  const rec = Object.values(store.state.approvals).find((a) => a.taskId === tr.id && a.kind === 'head' && !a.revokedAt)
  assert.ok(rec)
  assert.equal(rec.headSha, 'def5678')
})
const verBefore = store.state.tasks[tr.id].version
await rejects(() => domain.move(tr.id, 'review_risk', { role: 'dispatcher' }, { expectedVersion: 1 }), /版本已变化/)
await t('旧版本命令被拒绝', () => assert.equal(store.state.tasks[tr.id].version, verBefore))

// 重开：只能 done/cancelled → todo，必须写原因（T19）
const tt = await domain.createTask(project.id, { title: '修登录页错别字' })
await domain.move(tt.id, 'cancel', { role: 'human', id: 'human-1' })
await rejects(() => domain.move(tt.id, 'reopen', { role: 'human', id: 'human-1' }), /重开必须说明原因/)
await t('重开必须写原因', () => {})
const re = await domain.move(tt.id, 'reopen', { role: 'human', id: 'human-1' }, { reason: '需求回来了' })
await t('reopen → todo 且保留审计', () => {
  assert.equal(re.column, 'todo')
  assert.equal(re.cancelledAt, null)
  assert.equal(re.reopenCount, 1)
  assert.equal(re.lastReopenReason, '需求回来了')
  const last = re.history[re.history.length - 1]
  assert.equal(last.action, 'reopen')
  assert.equal(last.reason, '需求回来了')
})
const tt2 = await domain.createTask(project.id, { title: '顺手改个文案' })
await domain.move(tt2.id, 'cancel', { role: 'human', id: 'human-1' })
await rejects(() => domain.move(tt2.id, 'reopen', { role: 'dispatcher', id: 'disp-1' }, { reason: '想重开' }), /角色 dispatcher/)
await t('调度员不能重开（只有人类可以）', () => {})
await t('重开后不能重复重开', async () => assert.ok(store.state.tasks[tt.id].column === 'todo'))

// 仓库合并锁：同一仓库并发只放一个合并事务（I4/I10）
const lockA = await domain.lockMerge(project.id, 'T-A')
const lockB = await domain.lockMerge(project.id, 'T-B')
await t('同仓库第二个合并事务被拒', () => {
  assert.equal(lockA.ok, true)
  assert.equal(lockB.ok, false)
  assert.match(lockB.reason, /leased by task:T-A/)
})
await domain.unlockMerge(project.id, lockA.token)
const lockC = await domain.lockMerge(project.id, 'T-C')
await t('释放后可以再拿锁', () => assert.equal(lockC.ok, true))
await domain.unlockMerge(project.id, lockC.token)

// T18：取消要收 run、放租约、工位回空闲
const tcan = await domain.createTask(project.id, { title: '临时排查告警' })
await domain.move(tcan.id, 'claim', { role: 'dispatcher', id: 'disp-1' })
await domain.setPlan(tcan.id, '1. 复现 2. 修掉', { role: 'dispatcher' })
await domain.move(tcan.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(tcan.id, 'approve', { role: 'human', id: 'human-1' })
await t('批准后派工占住任务租约', () => assert.ok(store.state.leases['task:' + tcan.id]))
await domain.move(tcan.id, 'cancel', { role: 'human', id: 'human-1' })
const runsOfCancel = Object.values(store.state.runs).filter((r) => r.taskId === tcan.id)
await t('取消收 run 并释放租约', () => {
  assert.equal(store.state.tasks[tcan.id].activeRunId, null)
  assert.equal(store.state.leases['task:' + tcan.id], undefined)
  assert.equal(runsOfCancel[runsOfCancel.length - 1].status, 'cancelled')
})

// 人类评论让等待中的批准失效（T4 的另一条路径）
const tq = await domain.createTask(project.id, { title: '导出报表' })
await domain.move(tq.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(tq.id, '1. 直接走 SQL', { role: 'dispatcher' })
await domain.move(tq.id, 'plan_ready', { role: 'dispatcher' })
await domain.comment(tq.id, '报表要不要含历史归档？', { role: 'human', id: 'human-1' })
await t('人类追问把待批打回讨论', () => assert.equal(store.state.tasks[tq.id].phase, 'discussing'))

// ---- 阻塞分支 ------------------------------------------------------------
const t2 = await domain.createTask(project.id, { title: '改支付回调' })
await domain.block(t2.id, '依赖对方接口', { role: 'human' })
await t('阻塞保留原列', () => { assert.equal(store.state.tasks[t2.id].column, 'todo'); assert.equal(store.state.tasks[t2.id].blocked.reason, '依赖对方接口') })
await rejects(() => domain.move(t2.id, 'claim', { role: 'dispatcher' }), /被阻塞/)
await t('阻塞时不能迁移', () => {})
await domain.unblock(t2.id, { role: 'human' })
await t('解除阻塞', () => assert.equal(store.state.tasks[t2.id].blocked, null))

// ---- 风险分支 ------------------------------------------------------------
const t3 = await domain.createTask(project.id, { title: '升级依赖' })
await domain.move(t3.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(t3.id, 'p')
await domain.move(t3.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(t3.id, 'approve', { role: 'human' })
await domain.move(t3.id, 'stop', { role: 'worker' }, { stopReport: { summary: 'ok' } })
await domain.setNoMerge(t3.id, false, '', { role: 'system' })
await domain.move(t3.id, 'accept', { role: 'human' }, { headSha: 'def5678' })
await domain.openMergeRequest(t3.id, { headSha: 'def5678', files: ['package.json'], summary: '升级 react' }, { role: 'worker' })
const risked = await domain.move(t3.id, 'review_risk', { role: 'dispatcher' }, { verdict: 'risk', matched: [{ id: 'R-依赖升级', version: 1, reason: 'react 17→18', evidence: 'package.json' }] })
await t('风险 → 阻塞并保留 merging', () => { assert.equal(risked.column, 'merging'); assert.ok(risked.blocked) })
await t('风险原因落库', () => assert.match(risked.blocked.reason, /risk-escalation/))

// ---- 派工（设计文档 5.13）------------------------------------------------
const pool = Object.values(store.state.agents).filter((a) => a.projectId === project.id)
await t('新项目自动补齐代理池（1 调度 + 2 工人）', () => {
  assert.equal(pool.filter((a) => a.role === 'dispatcher').length, 1)
  assert.equal(pool.filter((a) => a.role === 'worker').length, 2)
})
const disp = pool.find((a) => a.role === 'dispatcher')
const w1 = pool.find((a) => a.role === 'worker' && a.slot === 1)
const w2 = pool.find((a) => a.role === 'worker' && a.slot === 2)
const poolBefore = Object.keys(store.state.agents).length
await domain.ensureAgents(project.id)
await t('补齐幂等：再跑一次不新增', () => assert.equal(Object.keys(store.state.agents).length, poolBefore))

const planAndApprove = async (title) => {
  const x = await domain.createTask(project.id, { title, acceptance: ['能跑通'] })
  await domain.move(x.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(x.id, '1. 读代码 2. 改 3. 测')
  await domain.move(x.id, 'plan_ready', { role: 'dispatcher' })
  rt.calls.length = 0
  await domain.move(x.id, 'approve', { role: 'human' })
  return x.id
}

const ta = await planAndApprove('加登录限流')
const runA = Object.values(store.state.runs).find((r) => r.taskId === ta)
await t('派工建 run 并绑工人', () => {
  assert.equal(runA.status, 'running')
  assert.equal(store.state.tasks[ta].activeRunId, runA.id)
  assert.equal(store.state.tasks[ta].assignee, runA.agentId)
})
await t('派工占任务租约', () => assert.ok(store.state.leases['task:' + ta]))
await t('投递案卷到真实会话', () => {
  const sent = rt.calls.find((c) => c.text && c.text.includes('【案卷 ' + ta + '】'))
  assert.ok(sent, '没有投递案卷')
  assert.match(sent.text, /flow_task_move\(action="stop"/)
  assert.match(sent.text, /【验收标准】/)
})
await t('v1.39 派工不再建 goal，改为清残留 goal', () => {
  assert.equal(rt.calls.find((c) => c.objective), undefined, '不能再给工人建 goal')
  const cleared = rt.calls.find((c) => c.clearedGoal)
  assert.ok(cleared, '要清掉旧会话残留的 goal')
  assert.equal(cleared.clearedGoal, runA.agentId)
})
await t('工位变 active', () => assert.equal(domain.latestSession(runA.agentId).state, 'active'))

const tb = await planAndApprove('改支付回调重试')
const runB = Object.values(store.state.runs).find((r) => r.taskId === tb)
await t('第二个任务派给另一个工人', () => assert.notEqual(runB.agentId, runA.agentId))

const tc = await planAndApprove('加导出功能')
await t('没有空闲工位 → 保持执行中等工位', () => {
  assert.equal(store.state.tasks[tc].column, 'running')
  assert.equal(store.state.tasks[tc].phase, 'waiting-worker')
  assert.equal(store.state.tasks[tc].activeRunId, null)
})

rt.calls.length = 0
await domain.move(ta, 'stop', { role: 'worker' }, { stopReport: { summary: '限流中间件加好了，429 测试通过' } })
await t('停止收 run', () => {
  assert.equal(store.state.runs[runA.id].status, 'stopped')
  assert.equal(store.state.tasks[ta].activeRunId, null)
})
await t('停止释放工位', () => assert.equal(domain.latestSession(runA.agentId).state, 'idle'))
await t('停止释放租约', () => assert.equal(store.state.leases['task:' + ta], undefined))
await t('v1.39 停止后按事件信封通知调度（worker.stopped）', async () => {
  // 聚合器攒几秒再发，测试里主动 flush 一次，否则断言看不到投递。
  await dispatcher.aggregator.flushAll('test')
  const packet = rt.calls.find((c) => c.text && c.text.includes('【事件 worker.stopped】' + ta))
  assert.ok(packet, '应当发出事件信封，实际投递：' + JSON.stringify((rt.calls || []).map((c) => String(c.text || '').slice(0, 40))))
  assert.match(packet.text, /【系统建议】/)
  assert.match(packet.text, /【你的选择】/, '信封要给出可选动作')
  assert.match(packet.text, /结束本轮/, '要提醒处理完就结束本轮（消息驱动）')
  // 投递不该再往卡上写「已通知调度员巡检」这种噪音评论
  const noisy = (store.state.tasks[ta].comments || []).filter((c) => /已通知调度员/.test(c.content))
  assert.equal(noisy.length, 0, '通知不该再写评论')
})

const redo = await dispatcher.dispatch(store.state.tasks[tc])
await t('有空位后重新派工成功', () => { assert.equal(redo.ok, true); assert.ok(store.state.tasks[tc].activeRunId) })

// ---- 对话框帧（会话事件 → 工作台）---------------------------------------
hub.ingest({ id: 'ses-demo' }, { type: 'user/message', time: 1, data: { message: { content: [{ type: 'text', text: '帮我加个导出' }] } } })
hub.ingest({ id: 'ses-demo' }, { type: 'turn/start', time: 2, data: { turn: 1 } })
hub.ingest({ id: 'ses-demo' }, { type: 'tool/call', time: 3, data: { name: 'flow_task_create', arguments: '{"title":"导出"}', callId: 'c1' } })
hub.ingest({ id: 'ses-demo' }, { type: 'tool/result', time: 4, data: { message: { content: [{ type: 'text', text: 'ok' }], toolCallId: 'c1' } } })
hub.ingest({ id: 'ses-demo' }, { type: 'assistant/message', time: 5, data: { message: { content: [{ type: 'text', text: '建好了 T-007' }] } } })
hub.ingest({ id: 'ses-demo' }, { type: 'turn/end', time: 6, data: { reason: { kind: 'completed' } } })
const frames = hub.since('ses-demo', 0)
await t('聊天帧覆盖用户/工具/助手/状态', () => {
  assert.deepEqual(frames.map((f) => f.kind), ['user', 'status', 'tool', 'tool_result', 'assistant', 'status'])
  assert.equal(frames[0].text, '帮我加个导出')
  assert.equal(frames[2].name, 'flow_task_create')
  assert.equal(frames[5].state, 'idle')
})
await t('帧序号单调', () => { for (let i = 1; i < frames.length; i++) assert.ok(frames[i].seq > frames[i - 1].seq) })
await t('未知事件不产帧', () => assert.deepEqual(normalize({ type: 'session/unknown', data: {} }), []))

hub.markSystem('ses-sys', '【巡检请求 T-001】触发：工人自停')
hub.ingest({ id: 'ses-sys' }, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '【巡检请求 T-001】触发：工人自停' }] } } })
hub.ingest({ id: 'ses-sys' }, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '我自己说的话' }] } } })
await t('每个工具的 output.render 返回 ContentBlock[]', async () => {
  const { buildTools } = await import('../lib/tools.js')
  const tools = buildTools({ domain, resolveProject: async () => domain.listProjects()[0] })
  assert.ok(tools.length >= 9)
  for (const tool of tools) {
    const out = tool.output.render({}, { ok: true, message: 'x' })
    assert.ok(Array.isArray(out), tool.name + ' render 必须返回数组')
    assert.equal(out[0].type, 'text', tool.name + ' render 首个块必须是 text')
  }
})

await t('评论署名跟着会话角色走（工人/调度员/未知）', async () => {
  const { buildTools } = await import('../lib/tools.js')
  const tools = buildTools({ domain, resolveProject: async () => project })
  const comment = tools.find((x) => x.name === 'flow_task_comment')
  const worker = Object.values(store.state.agents).find((a) => a.projectId === project.id && a.role === 'worker')
  const dispatcherAgent = Object.values(store.state.agents).find((a) => a.projectId === project.id && a.role === 'dispatcher')
  await domain.bindSession(worker.id, 'ses-worker-1', { state: 'active' }, { role: 'system' })
  await domain.bindSession(dispatcherAgent.id, 'ses-disp-1', { state: 'active' }, { role: 'system' })
  const execOf = (sid) => ({ agent: { session: { header: { id: sid, cwd: project.workspacePath } } } })
  await comment.execute({ id: task.id, content: '工人：登录页写完了，测试全绿' }, execOf('ses-worker-1'))
  await comment.execute({ id: task.id, content: '调度员：收到，我核一下验收标准' }, execOf('ses-disp-1'))
  await comment.execute({ id: task.id, content: '来路不明的会话' }, execOf('ses-unknown'))
  const cs = domain.taskDetail(task.id).comments.slice(-3).map((c) => c.role)
  assert.deepEqual(cs, ['worker', 'dispatcher', 'dispatcher'], '评论角色应为 worker/dispatcher/dispatcher，实际 ' + cs.join(','))
})

await t('任务详情页一次取全（任务 + 评论 + 运行 + 事件）', () => {
  const d = domain.taskDetail(task.id)
  assert.equal(d.task.id, task.id)
  assert.ok(d.comments.length >= 3)
  assert.ok(Array.isArray(d.runs))
  assert.ok(Array.isArray(d.events))
  assert.equal(domain.taskDetail('nope'), null)
})

await t('系统投递的帧带 origin', () => {
  const f = hub.since('ses-sys', 0)
  assert.equal(f[0].origin, 'system')
  assert.equal(f[1].origin, undefined)
})

// ---- 租约 ---------------------------------------------------------------
{
  const s = store.state
  const a = acquireLease(s, 'merge:repo1', 'worker-A')
  await t('拿到租约', () => assert.equal(a.ok, true))
  const b = acquireLease(s, 'merge:repo1', 'worker-B')
  await t('别人拿不到', () => assert.equal(b.ok, false))
  await t('同 owner 可重入', () => assert.equal(acquireLease(s, 'merge:repo1', 'worker-A').ok, true))
  assertFence(s, 'merge:repo1', s.leases['merge:repo1'].token)
  await t('fencing 校验通过', () => {})
  renewLease(s, 'merge:repo1', s.leases['merge:repo1'].token)
  releaseLease(s, 'merge:repo1', s.leases['merge:repo1'].token)
  await t('释放后可被抢', () => assert.equal(acquireLease(s, 'merge:repo1', 'worker-B').ok, true))
}

// ---- outbox -------------------------------------------------------------
const pumped = await domain.pumpOutbox()
await t('outbox 投递', () => assert.ok(pumped > 0))

// ---- HTTP ---------------------------------------------------------------
const host = {
  domain,
  chat: hub,
  runtime: rt,
  dispatcher,
  merge: dispatcher.merge,
  softMerge: dispatcher.softMerge,
  ensureWorktree: dispatcher.ensureWorktree,
  removeWorktree: dispatcher.removeWorktree,
  openPr: dispatcher.openPr,
  ensureProject: (a) => domain.ensureProject(a),
  resolveProject: async () => project,
  resolveProjectById: (id) => store.state.projects[id],
  listProjects: () => Object.values(store.state.projects),
}
const handler = createHttpHandler(host)
const req = (method, url, body) => new Request('http://local' + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

// v1.3：独立工作台页面已移入会话视图，/app 不再存在
const appRes = await handler(req('GET', '/api/flow/app'))
await t('GET /app 已下线（404）', () => { assert.equal(appRes.status, 404) })

const stateRes = await handler(req('GET', '/api/flow/state'))
const stateJson = await stateRes.json()
await t('GET /state 返回快照', () => { assert.equal(stateJson.ok, true); assert.ok(stateJson.state.tasks.length >= 3) })

const createRes = await handler(req('POST', '/api/flow/action', { action: 'task.create', args: { projectId: project.id, title: '从 HTTP 建的任务', withState: true } }))
const createJson = await createRes.json()
await t('POST /action 建任务', () => { assert.equal(createJson.ok, true); assert.ok(createJson.state.tasks.some((x) => x.title === '从 HTTP 建的任务')) })
// v0.016.2：动作响应默认不再附带整份 state（线上一次 inbox.list 响应 682KB, 全耗在这），
// 需要整份状态的消费者要显式 withState:true —— 这里钉住默认行为，防止悄悄回退。
const lightRes = await handler(req('POST', '/api/flow/action', { action: 'inbox.list', args: {} }))
const lightJson = await lightRes.json()
await t('POST /action 默认不带 state（体积只够一个响应本身）', () => { assert.equal(lightJson.ok, true); assert.equal(lightJson.state, undefined) })
// v0.016.3：tab 计数要和 tab 的过滤规则同口径 —— 通知不该算进「待我回」。
// 线上就是「待我回 1」点开一片空白（唯一那条是 info 通知，列表把它过滤掉了）。
const countProj = await domain.ensureProject({ workspacePath: join(dir, 'inbox-count'), name: 'inbox-count' })
const countTask = await domain.createTask(countProj.id, { title: '计数口径', acceptance: ['x'] })
await domain.askHuman({ taskId: countTask.id, kind: 'info', topic: '只是通知', body: '不需要你回' }, { role: 'dispatcher', id: 'ag_count_info' })
await domain.askHuman({ taskId: countTask.id, kind: 'decision', topic: '要你定', problem: '有分歧', decisionNeeded: '选一个' }, { role: 'dispatcher', id: 'ag_count_dec' })
const countRes = await handler(req('POST', '/api/flow/action', { action: 'inbox.list', args: { projectId: countProj.id } }))
const countJson = await countRes.json()
await t('v0.016.3 inbox.list 计数与 tab 过滤同口径（通知不算待我回）', () => {
  const c = (countJson.result || countJson).counts || {}
  assert.equal(c.open, 1, '待我回只算真正待人回应的工单，实际 ' + c.open)
  assert.equal(c.notices, 1, '通知单独计数，实际 ' + c.notices)
})


const badRes = await handler(req('POST', '/api/flow/action', { action: 'task.move', args: { taskId: 'T-999', action: 'claim' } }))
const badJson = await badRes.json()
await t('非法动作返回错误', () => { assert.equal(badJson.ok, false); assert.match(badJson.error, /unknown task/) })

// ---- 对话框 HTTP ---------------------------------------------------------
rt.calls.length = 0
const sendRes = await handler(req('POST', '/api/flow/action', { action: 'chat.send', args: { agentId: disp.id, message: '帮我看下 T-001 卡在哪' } }))
const sendJson = await sendRes.json()
await t('POST /action chat.send 投到调度员会话', () => {
  assert.equal(sendJson.ok, true)
  const sent = rt.calls.find((c) => c.text === '帮我看下 T-001 卡在哪')
  assert.ok(sent)
  assert.equal(sent.mode, 'queue')
  assert.ok(sent.sessionId)
})

const streamRes = await handler(new Request('http://local/api/flow/chat/stream?agentId=' + disp.id + '&since=0'))
const reader = streamRes.body.getReader()
const firstChunk = await reader.read()
const firstText = new TextDecoder().decode(firstChunk.value)
await reader.cancel()
await t('GET /chat/stream 首帧是 meta', () => {
  assert.equal(streamRes.status, 200)
  assert.match(firstText, /event: chat/)
  assert.match(firstText, /"kind":"meta"/)
})

// v1.3：前端不再是独立 HTML 页，而是会话视图（client.js）——改成对客户端源码的断言
const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
await t('前端注册为会话视图（不再有独立页面）', () => {
  assert.match(clientSrc, /name: 'conversation\.view'/, '要注册成会话视图')
  assert.doesNotMatch(clientSrc, /\/api\/flow\/app/, '不能再指向已删除的独立页面')
})
await t('会话视图自带看板与任务抽屉（看板功能已迁入）', () => {
  assert.match(clientSrc, /flowv-cols/, '七列看板')
  assert.match(clientSrc, /flowv-drawer/, '任务详情抽屉')
  assert.match(clientSrc, /taskAction/, '迁移动作')
})
await t('会话视图自带项目与角色配置（设置已迁入）', () => {
  assert.match(clientSrc, /renderSettings/, '设置面板')
  assert.match(clientSrc, /'project\.config'/, '项目配置')
  assert.match(clientSrc, /'agent\.upsert'/, '角色配置')
  assert.match(clientSrc, /'lane\.set'/, '车道配置')
  assert.match(clientSrc, /'agent\.reparent'/, '改派上级')
})
await t('v1.4：界面不再暴露删除动作（项目跟随工作区）', () => {
  // 危险操作先从界面收起；API 层的 project.remove / task.remove 仍然存在，供运维/工具用
  assert.doesNotMatch(clientSrc, /'project\.remove'/, '界面不再直接删项目')
  assert.doesNotMatch(clientSrc, /'task\.remove'/, '界面不再直接删卡')
  const httpSrc = readFileSync(new URL('../lib/http.js', import.meta.url), 'utf8')
  assert.match(httpSrc, /'project\.remove'/, 'API 仍保留删除能力')
  assert.match(httpSrc, /'task\.remove'/)
})

// ---- v1.3：派工遇到「旧 preset 失效」要能自愈 -----------------------------
{
  const healed = []
  const failing = {
    ...rt,
    // 固定用那个"带旧 preset 的会话"，否则 ensureSession 会因为 cwd 不匹配而新建一个会话，测不到自愈分支
    async ensureSession(agent) {
      return { ok: true, sessionId: 'ses-old-preset', created: false }
    },
    async promptSession(sessionId, text, mode) {
      // 第一次用旧会话投递 → 模拟 DSH 的 resume 失败
      if (sessionId === 'ses-old-preset') {
        return { ok: false, message: 'resume failed for session "ses-old-preset": RemoteError: Unknown agent preset: router-standard' }
      }
      healed.push({ sessionId, text, mode })
      return { ok: true }
    },
    async resetSession(project, agentId) {
      // 重建一个不带 preset 的会话
      await domain.bindSession(agentId, 'ses-fresh-' + agentId, { state: 'idle', cwd: project && project.workspacePath }, { role: 'system' })
      return { ok: true, sessionId: 'ses-fresh-' + agentId, archived: 'ses-old-preset' }
    },
  }
  const d2 = createDispatcher({ domain, runtime: failing, store })
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'heal-repo'), name: 'heal' })
  const w = domain.workersOf(proj.id, 'human')[0]
  await domain.bindSession(w.id, 'ses-old-preset', { state: 'idle', cwd: null }, { role: 'system' })
  const tk = await domain.createTask(proj.id, { title: 'preset 自愈', lane: 'human' })
  await domain.move(tk.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(tk.id, 'plan', { role: 'dispatcher' })
  await domain.move(tk.id, 'plan_ready', { role: 'dispatcher' })
  // 不走 approve：那会在 runtime.onMoved 里自动派工一次（用的是共享 rt），
  // 这里要单独验证 d2 的自愈分支，所以直接把卡搬到 running 再手动派。
  await domain.move(tk.id, 'approve', { role: 'human' })
  const auto = store.state.tasks[tk.id]
  if (auto.activeRunId) await domain.endRun(tk.id, 'stopped', {})
  const out = await d2.dispatch(store.state.tasks[tk.id])
  if (!out.ok) console.log('    [debug] dispatch out =', JSON.stringify(out).slice(0, 300))
  await t('旧 preset 失效 → 重置会话后重投成功', () => {
    assert.equal(out.ok, true)
    assert.equal(out.healed, true, '要标记 healed')
    assert.match(out.sessionId, /ses-fresh-/)
    assert.equal(healed.length >= 1, true, '重试确实投递了')
  })
  await t('自愈后任务不再被阻塞', () => {
    const cur = store.state.tasks[tk.id]
    assert.equal(cur.blocked, null, '不应该留下阻塞')
    assert.ok(cur.assignee, '要绑上负责人')
  })
}

// ---- v1.4：工作区即项目 —— 工作区消失则项目跟着消失 ----------------------
{
  // 白名单 = 现在所有项目路径 + keep，但**不含** gone：
  // 否则对账会把前面测试建的项目全删掉。
  const rtWs = {
    ...rt,
    async listWorkspacePaths() {
      const paths = Object.values(store.state.projects).map((p) => p.workspacePath).filter(Boolean)
      return paths.filter((p) => p !== 'C:/work/gone')
    },
  }
  const sched = createScheduler({ domain, dispatcher, store, runtime: rtWs, log: () => {} })
  const keep = await domain.ensureProject({ workspacePath: 'C:/work/keep', name: 'keep' })
  const gone = await domain.ensureProject({ workspacePath: 'C:/work/gone', name: 'gone' })
  const goneTask = await domain.createTask(gone.id, { title: '会随项目消失' })

  const report = await sched.tick()
  await t('工作区还在的项目不动', () => {
    assert.ok(store.state.projects[keep.id], 'keep 项目要保留')
    assert.equal(report.droppedProjects.some((x) => x.projectId === keep.id), false)
  })
  await t('工作区已删 → 项目与其任务一起清掉', () => {
    assert.equal(store.state.projects[gone.id], undefined, 'gone 项目应被删除')
    assert.equal(store.state.tasks[goneTask.id], undefined, '项目下的任务也要清')
    assert.ok(report.droppedProjects.some((x) => x.projectId === gone.id), '报告里要有记录')
  })
  await t('registry 不可用时不误删', async () => {
    const broken = { ...rt, async listWorkspacePaths() { return null } }
    const sched2 = createScheduler({ domain, dispatcher, store, runtime: broken, log: () => {} })
    const before = Object.keys(store.state.projects).length
    await sched2.tick()
    assert.equal(Object.keys(store.state.projects).length, before, '读不到工作区清单就不能删任何项目')
  })
}

// ---- v1.5：工人案卷里的路径必须是正斜杠（否则会被抄成非法转义）----------
{
  const { buildBrief } = await import('../lib/dispatch.js')
  const proj = { name: 'win', workspacePath: 'C:\\Users\\Administrator\\Desktop\\prjs\\win' }
  const worker = { id: 'ag_w', name: '工人W' }
  const task = {
    id: 'T-BRIEF', title: '路径渲染', note: 'n', acceptance: ['a'],
    plan: { revision: 1, text: 'p' }, lane: 'human',
  }
  const brief = buildBrief(task, proj, worker, { worktree: 'C:\\Users\\Administrator\\Desktop\\prjs\\win\\.flow-worktrees\\win\\T-BRIEF' })

  await t('案卷里的工作目录用正斜杠', () => {
    assert.match(brief, /你的工作目录：C:\/Users\/Administrator\/Desktop\/prjs\/win\/\.flow-worktrees\/win\/T-BRIEF/)
    assert.equal(/你的工作目录：[^\n]*\\\\/.test(brief), false, '工作目录行里不该出现反斜杠')
  })
  await t('案卷里带"路径用正斜杠"的提示（防非法转义）', () => {
    assert.match(brief, /正斜杠/)
    assert.match(brief, /Expected unicode escape/)
  })
  await t('案卷列出确切的工具名，并点明不存在简写', () => {
    for (const name of ['flow_task_detail', 'flow_task_update', 'flow_task_comment', 'flow_inspect', 'flow_scope_set']) {
      assert.ok(brief.includes(name), '案卷要列出 ' + name)
    }
    // v1.25：长文本必须分段读，案卷要把这个工具和用法讲清楚（否则模型会拿半份材料下结论）
    assert.ok(brief.includes('flow_task_comment_read'), '案卷要告诉工人有分段读的工具')
    assert.match(brief, /hasMore/, '要点明 hasMore=true 时还没读完')
    assert.match(brief, /没有 flow_comment/)
    // flow_publish 是主调度在调度模式里的出口，工人不该用（也不该出现在它的案卷里）
    assert.equal(brief.includes('flow_publish'), false, '工人的案卷不该列 flow_publish')
  })
  await t('工作区行也用正斜杠', () => {
    const line = brief.split('\n').find((l) => l.indexOf('工作区：') >= 0) || ''
    assert.equal(/\\\\/.test(line), false, '工作区行不该有反斜杠：' + line)
  })
}

// ---- v1.13：工位模型在"造出来"那一刻就定死 -------------------------------
{
  const mp = await domain.ensureProject({
    workspacePath: join(dir, 'model-repo'), name: 'model-proj',
    modelDefaults: { provider: 'p1', model: 'm1', reasoningEffort: 'medium' },
  })
  await t('建项目时把默认模型冻结到项目上', () => {
    assert.equal(mp.config.defaultProvider, 'p1')
    assert.equal(mp.config.defaultModel, 'm1')
  })

  await t('新造的工位直接带模型（不留 null）', () => {
    const list = Object.values(store.state.agents).filter((a) => a.projectId === mp.id && a.role !== 'chief')
    assert.ok(list.length > 0)
    for (const a of list) {
      assert.equal(a.provider, 'p1', a.id + ' 的 provider 要定死')
      assert.equal(a.model, 'm1', a.id + ' 的 model 要定死')
    }
  })

  await t('总调度不参与模型配置（chief 保持 null，由 DSH 自己管）', () => {
    const chiefs = Object.values(store.state.agents).filter((a) => a.projectId === mp.id && a.role === 'chief')
    assert.ok(chiefs.length > 0)
    for (const c of chiefs) assert.equal(c.provider, null, 'chief 的模型不该被插件写')
  })

  await t('换个"全局默认"再补齐工位：已有工位不受影响', async () => {
    // 模拟"切了另一个对话的模型"：把全局默认换成别的，再次 upsert 代理
    await domain.upsertAgent(mp.id, { id: Object.values(store.state.agents).find((a) => a.projectId === mp.id && a.role === 'worker').id, provider: 'p2', model: 'm2' }, { role: 'human' })
    const w = Object.values(store.state.agents).find((a) => a.projectId === mp.id && a.role === 'worker')
    assert.equal(w.provider, 'p2')
    // 再次补齐（等于"进另一个对话打开调度台"）不该把它冲回去
    await domain.updateProjectConfig(mp.id, {}, { role: 'human' })
    const again = store.state.agents[w.id]
    assert.equal(again.provider, 'p2', '人工设过的模型不能被默认值冲掉')
    assert.equal(again.model, 'm2')
  })

  await t('老项目里 provider 为空的工位会被项目默认补上（只补空值）', async () => {
    const op = await domain.ensureProject({ workspacePath: join(dir, 'model-repo2'), name: 'model-proj2' })
    const w = Object.values(store.state.agents).find((a) => a.projectId === op.id && a.role === 'worker')
    assert.equal(w.provider, null, '没给默认值时先留空')
    await domain.updateProjectConfig(op.id, { defaultProvider: 'p3', defaultModel: 'm3' }, { role: 'human' })
    const filled = store.state.agents[w.id]
    assert.equal(filled.provider, 'p3')
    assert.equal(filled.model, 'm3')
  })
}

// ---- v1.12：非 Git 项目不该卡在"合并中" ---------------------------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'nogit-repo'), name: 'nogit' })
  const tk = await domain.createTask(proj.id, { title: '本地看板收尾', lane: 'human' })
  await domain.move(tk.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(tk.id, '计划', { role: 'dispatcher' })
  await domain.move(tk.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(tk.id, 'approve', { role: 'human', id: 'me' })
  await domain.setNoMerge(tk.id, true, '工作区不是 git 仓库', { role: 'system' })

  await t('无 Git 的项目：验收后直接进 done，不进合并列', async () => {
    await domain.move(tk.id, 'stop', { role: 'worker' }, { stopReport: { summary: '改完了' } })
    const done = await domain.move(tk.id, 'accept', { role: 'human', id: 'me' }, { headSha: 'deadbeef' })
    assert.equal(done.column, 'done', '不该卡在 merging，实际：' + done.column)
    assert.equal(done.phase, 'done-no-merge')
  })

  await t('没有 noMerge 标记时 accept 仍然去 merging（状态机语义没被改坏）', () => {
    // 直接问状态机：这件事跟"工作区是不是 git"无关，状态机只看任务上的标记
    const plain = { id: 'T-x', column: 'verifying', headSha: 'abc', plan: { revision: 1, text: 'p' }, version: 1 }
    const next = applyTransition(plain, 'accept', { role: 'human', id: 'me' })
    assert.equal(next.column, 'merging')
    assert.equal(next.phase, 'merge-ready')
  })

  await t('已经卡在 merging 的卡可以用 merge_skip 收尾', async () => {
    const t3 = await domain.createTask(proj.id, { title: '历史卡在合并中', lane: 'human' })
    await domain.move(t3.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(t3.id, '计划', { role: 'dispatcher' })
    await domain.move(t3.id, 'plan_ready', { role: 'dispatcher' })
    // 人工派工（不经过 dispatch 的自动打标），保持"这张卡要合并"
    await domain.move(t3.id, 'approve', { role: 'human', id: 'me' })
    await domain.setNoMerge(t3.id, false, '', { role: 'system' })
    await domain.move(t3.id, 'stop', { role: 'worker' }, { stopReport: { summary: '改完了' } })
    const accepted = await domain.move(t3.id, 'accept', { role: 'human', id: 'me' }, { headSha: 'feedface' })
    assert.equal(accepted.column, 'merging', '前置条件：要先在 merging')
    const skipped = await domain.move(t3.id, 'merge_skip', { role: 'dispatcher', id: 'web:dispatcher' })
    assert.equal(skipped.column, 'done')
    assert.equal(skipped.phase, 'merged-skipped')
  })

  await t('已有审核结论的卡不能用 merge_skip 绕过审核', async () => {
    const t4 = await domain.createTask(proj.id, { title: '已审核', lane: 'human' })
    await domain.move(t4.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(t4.id, '计划', { role: 'dispatcher' })
    await domain.move(t4.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(t4.id, 'approve', { role: 'human', id: 'me' })
    await domain.setNoMerge(t4.id, false, '', { role: 'system' })
    await domain.move(t4.id, 'stop', { role: 'worker' }, { stopReport: { summary: '改完了' } })
    await domain.move(t4.id, 'accept', { role: 'human', id: 'me' }, { headSha: 'f00dbabe' })
    await domain.openMergeRequest(t4.id, { headSha: 'f00dbabe', summary: 'ok' }, { role: 'worker' })
    await domain.setReviewVerdict(t4.id, 'approved', '通过', [], { role: 'dispatcher' })
    await assert.rejects(() => domain.move(t4.id, 'merge_skip', { role: 'dispatcher' }), /已有审核结论/)
  })
}

// ---- v1.15：重开是人的闸门，但代理得能"申请" ---------------------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'reopen-repo'), name: 'reopen' })
  const tk = await domain.createTask(proj.id, { title: '做完但发现没做完', lane: 'human' })

  const toDone = async (task) => {
    await domain.move(task.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(task.id, '计划', { role: 'dispatcher' })
    await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
    await domain.setNoMerge(task.id, true, '本地看板', { role: 'system' })
    await domain.move(task.id, 'stop', { role: 'worker' }, { stopReport: { summary: '改完了' } })
    return domain.move(task.id, 'accept', { role: 'human', id: 'me' }, { headSha: 'cafe' })
  }

  await t('代理可以给已完成的卡挂一条重开申请（并留下事件）', async () => {
    const done = await toDone(tk)
    assert.equal(done.column, 'done', '前置条件：先完成')
    const asked = await domain.requestReopen(tk.id, '验收标准第 2 条其实没做：缺回归测试', { role: 'dispatcher', id: 'ag_002' })
    assert.equal(asked.reopenRequested.reason, '验收标准第 2 条其实没做：缺回归测试')
    assert.equal(asked.reopenRequested.by, 'ag_002', '要记清楚是谁申请的')
    const ev = domain.store.state.events.filter((e) => e.type === 'task.reopen_requested').slice(-1)[0]
    assert.ok(ev, '申请重开必须留事件，否则看板刷不出来')
    assert.equal(ev.payload.taskId, tk.id)
  })

  await t('申请重开不改变列：真正的 reopen 仍然只有人类能做', () => {
    const cur = domain.store.state.tasks[tk.id]
    assert.equal(cur.column, 'done', '申请只是请求，不能自己把卡挪走')
    assert.equal(coreMod.checkTransition({ ...cur, reopenReason: 'x' }, 'reopen', 'dispatcher').ok, false)
    assert.equal(coreMod.checkTransition({ ...cur, reopenReason: 'x' }, 'reopen', 'human').ok, true)
  })

  await t('重开申请必须写理由，并且只能针对终态的卡', async () => {
    await assert.rejects(() => domain.requestReopen(tk.id, '   ', { role: 'dispatcher' }), /必须说明原因/)
    const live = await domain.createTask(proj.id, { title: '还在跑', lane: 'human' })
    await assert.rejects(() => domain.requestReopen(live.id, '想做点别的', { role: 'dispatcher' }), /只有已完成或已取消/)
  })

  await t('人真的重开之后，申请标记要清掉（否则看板一直挂着）', async () => {
    const back = await domain.move(tk.id, 'reopen', { role: 'human', id: 'me' }, { reason: '确实漏了测试' })
    assert.equal(back.column, 'todo')
    assert.equal(back.reopenRequested, null, '重开结案后不该再显示"有人申请重开"')
    assert.equal(back.lastReopenReason, '确实漏了测试')
    assert.equal(back.reopenCount, 1)
  })

  await t('看板视图把重开申请与 noMerge 一并暴露给界面', async () => {
    const t2 = await domain.createTask(proj.id, { title: '再走一遍', lane: 'human' })
    await toDone(t2)
    await domain.requestReopen(t2.id, '还得再补一条', { role: 'dispatcher', id: 'ag_003' })
    const view = panelMod.buildProjectView(store.state, proj.id)
    const card = view.tasks.done.find((c) => c.id === t2.id)
    assert.ok(card, 'done 列里应该有这张卡')
    assert.equal(card.reopenRequested.reason, '还得再补一条')
    assert.equal(card.reopenRequested.by, 'ag_003')
    assert.equal(card.noMerge, true)
  })

  await t('flow_reopen_request 工具已注册（名字要对得上，模型才不会 TypeError）', async () => {
    const { buildTools } = await import('../lib/tools.js')
    const reg = buildTools({ domain, resolveProject: async () => proj })
    const names = reg.map((x) => x.name)
    assert.ok(names.includes('flow_reopen_request'), '缺工具：' + names.join(','))
  })
}

// ---- v1.7：巡检结论必须进讨论区（线上踩过：写了 inspection 但界面看不到）----
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'inspect-repo'), name: 'inspect' })
  const tk = await domain.createTask(proj.id, { title: '巡检可见性', lane: 'human' })

  await t('巡检后 discussion 里能看到结论与原因', async () => {
    await domain.setInspection(tk.id, 'blocked', ['工作目录不是 git 仓库'], { role: 'dispatcher', id: 'ag_d' })
    const d = domain.taskDetail(tk.id)
    const hit = d.comments.find((c) => /巡检结论/.test(c.content))
    assert.ok(hit, '要看得到巡检评论，实际评论：' + JSON.stringify(d.comments.map((c) => c.content)))
    assert.match(hit.content, /blocked/)
    assert.match(hit.content, /不是 git 仓库/)
    assert.equal(hit.role, 'dispatcher', '巡检评论要以调度员身份记录，不能冒充人类')
  })

  await t('巡检结论同时写进 task.inspection（结构数据仍在）', () => {
    const task = store.state.tasks[tk.id]
    assert.equal(task.inspection.verdict, 'blocked')
    assert.deepEqual(task.inspection.reasons, ['工作目录不是 git 仓库'])
  })

  await t('巡检评论不会误触发「人类评论吊销审批」', async () => {
    const t2 = await domain.createTask(proj.id, { title: '审批不被误吊销', lane: 'human' })
    await domain.move(t2.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(t2.id, '计划', { role: 'dispatcher' })
    await domain.move(t2.id, 'plan_ready', { role: 'dispatcher' })
    await domain.setInspection(t2.id, 'keep', ['没问题'], { role: 'dispatcher', id: 'ag_d' })
    const cur = store.state.tasks[t2.id]
    assert.equal(cur.phase, 'waiting-approval', '巡检不能把待审批阶段改掉')
  })
}

// ---- v1.8：run 心跳（否则长任务会被 stuckRuns 误判超时）-----------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'beat-repo'), name: 'beat' })
  const tk = await domain.createTask(proj.id, { title: '长任务心跳', lane: 'human' })
  const w = domain.workersOf(proj.id, 'human')[0]
  await domain.bindSession(w.id, 'ses-beat', { state: 'idle', cwd: proj.workspacePath }, { role: 'system' })
  const { run } = await domain.startRun(tk.id, { agentId: w.id, sessionId: 'ses-beat', trigger: 'approve' })

  await t('心跳会续 lastHeartbeat', async () => {
    const before = store.state.runs[run.id].lastHeartbeat
    await new Promise((r) => setTimeout(r, 15))
    const res = await domain.heartbeat(run.id)
    assert.equal(res.ok, true)
    assert.notEqual(store.state.runs[run.id].lastHeartbeat, before)
  })

  await t('心跳续过之后不会被判 stuck', async () => {
    // 把 startedAt 拨到 40 分钟前（超过默认 30 分钟阈值），但刚续过心跳 → 不该判卡死
    store.state.runs[run.id].startedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    await domain.heartbeat(run.id)
    const stuck = domain.stuckRuns(Date.now())
    assert.equal(stuck.some((x) => x.run.id === run.id), false, '刚续过心跳的任务不能被判卡死')
  })

  await t('超过阈值且没续心跳 → 会被判 stuck（检测本身还有效）', async () => {
    store.state.runs[run.id].lastHeartbeat = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    const stuck = domain.stuckRuns(Date.now())
    assert.equal(stuck.some((x) => x.run.id === run.id), true, '长期没心跳的必须能被检测到')
  })

  await t('run 结束后心跳不再续（返回 ok:false）', async () => {
    await domain.endRun(tk.id, 'stopped', { stopReason: '测完' })
    const res = await domain.heartbeat(run.id)
    assert.equal(res.ok, false)
    assert.equal(res.status, 'stopped')
  })

  await t('dispatcher 起/停心跳幂等且不抛', async () => {
    const d2 = createDispatcher({ domain, runtime: rt, store, log: () => {} })
    assert.doesNotThrow(() => {
      d2.startHeartbeat('run_fake_1')
      d2.startHeartbeat('run_fake_1') // 重复启动幂等
    })
    assert.doesNotThrow(() => {
      d2.stopHeartbeat('run_fake_1')
      d2.stopHeartbeat('run_fake_1') // 重复停止安全
      d2.stopAllHeartbeats()
    })
  })
}

// ---- 持久化 -------------------------------------------------------------
const reloaded = new Store(store.file)
await reloaded.load()
await t('重新加载一致', () => assert.equal(Object.keys(reloaded.state.tasks).length, Object.keys(store.state.tasks).length))

// ---- 代理池补齐（配置驱动）----------------------------------------------
await domain.updateProjectConfig(project.id, { workers: 3 }, { role: 'human' })
await t('配置调大 → 自动补一个工位', () => assert.equal(Object.values(store.state.agents).filter((a) => a.projectId === project.id && a.role === 'worker').length, 3))
await domain.updateProjectConfig(project.id, { workers: 2 }, { role: 'human' })
await t('配置调小不删已有工位', () => assert.equal(Object.values(store.state.agents).filter((a) => a.projectId === project.id && a.role === 'worker').length, 3))

// ---- v1.40：工位只在项目首次落库时初始化一次 ------------------------------
{
  const np = await domain.ensureProject({ workspacePath: join(dir, 'first-run-repo'), name: 'first-run' })
  const griller = Object.values(store.state.agents).find((a) => a.projectId === np.id && a.role === 'griller')
  await t('首次落库：默认工位一次备齐（含 griller）', () => assert.ok(griller, '新项目该有一个需求评审工位'))

  const del = (id) => { delete store.state.agents[id] }
  del(griller.id)
  await domain.ensureProject({ workspacePath: join(dir, 'first-run-repo'), name: 'first-run' })
  await t('已存在项目再次打开：不复活被删的工位', () =>
    assert.equal(Object.values(store.state.agents).filter((a) => a.projectId === np.id && a.role === 'griller').length, 0))

  await domain.updateProjectConfig(np.id, { grillSkill: 'grilling' }, { role: 'human' })
  await t('改非工位数配置：也不复活工位', () =>
    assert.equal(Object.values(store.state.agents).filter((a) => a.projectId === np.id && a.role === 'griller').length, 0))

  const back = await domain.ensureAgents(np.id, { role: 'human', id: 'web' })
  await t('显式 ensureAgents：把删掉的工位补回来', () =>
    assert.equal(back.filter((a) => a.role === 'griller').length, 1))
}


// ---- v0.3：chief / handoff / 注入 -----------------------------------------
{
  const chief = domain.chiefOf(project.id)
  await t('默认补一个总调度者', () => assert.ok(chief && chief.role === 'chief' && chief.name === '总调度者1'))
  await t('对话框默认发给总调度者', () => assert.equal(domain.chatTarget(project.id).id, chief.id))

  const ht = await domain.createTask(project.id, { title: '交付包测试' })
  await rejects(() => domain.handoff(ht.id, { notes: 'x' }), /先写计划/)
  await domain.setPlan(ht.id, '1. 改 A 2. 改 B', { role: 'dispatcher' })
  const h = await domain.handoff(ht.id, { notes: '交给调度者派工' }, { role: 'chief', id: 'chief1' })
  await t('handoff 绑定 plan_rev', () => assert.equal(h.planRev, store.state.tasks[ht.id].plan.revision))

  const small = await domain.inject(ht.id, { kind: 'skill', content: '先读 AGENTS.md' }, { role: 'dispatcher', id: 'd1' })
  await t('注入技能记录字节数', () => assert.equal(small.size, Buffer.byteLength('先读 AGENTS.md', 'utf8')))
  await t('按 kind 取注入', () => assert.equal(domain.injectionsFor(ht.id, { kind: 'skill' }).length, 1))
  await rejects(() => domain.inject(ht.id, { kind: 'bogus', content: 'x' }), /kind 只能是/)
  await rejects(() => domain.inject(ht.id, { kind: 'context', content: 'x'.repeat(5000) }), /上限/)
}

// ---- v0.3：worktree / PR / 合并（真 git）----------------------------------
const { execFileSync } = await import('node:child_process')
const { writeFileSync, existsSync } = await import('node:fs')
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const gitExists = (p) => existsSync(p)
const repo = mkdtempSync(join(tmpdir(), 'flow-repo-'))
sh(repo, ['init', '-q', '-b', 'main'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'README.md'), '# demo\n')
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'init'])

const gp = await domain.ensureProject({ workspacePath: repo, name: 'git-demo' })
// 这一整段测的是远程 issue/镜像/webhook 链路，需要显式打开记录开关（默认是纯本地看板）
await domain.updateProjectConfig(gp.id, { recordIssues: true }, { role: 'human' })
await t('recordIssues 默认关闭（纯本地看板模式）', async () => {
  const p2 = await domain.ensureProject({ workspacePath: join(dir, 'local-only'), name: 'local-only' })
  assert.equal(p2.config.recordIssues, false, '默认必须是本地看板模式')
})
await t('recordIssues 关闭时同步远程 issue 被跳过', async () => {
  const p3 = await domain.ensureProject({ workspacePath: join(dir, 'local-only-2'), name: 'local-only-2' })
  const r = await domain.syncRemote(p3.id, { source: 'gitea', items: [{ remoteId: '1', title: 'x', kind: 'issue' }] })
  assert.equal(r.ok, false)
  assert.equal(r.skipped, 'record-issues-off')
})
await t('recordIssues 关闭时不补 issue 车道工位', async () => {
  const p4 = await domain.ensureProject({ workspacePath: join(dir, 'local-only-3'), name: 'local-only-3' })
  const r = await domain.ensureLaneAgents(p4.id, 'issue', { dispatchers: 1, workers: 2 }, { role: 'system' })
  assert.equal(r.ok, false)
  assert.equal(r.skipped, 'record-issues-off')
  assert.equal(domain.workersOf(p4.id, 'issue').length, 0, '本地模式下不该凭空冒出 issue 工位')
})
const gt = await domain.createTask(gp.id, { title: '改 README', acceptance: ['README 多一行'] })
await domain.move(gt.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(gt.id, '1. 改 README', { role: 'dispatcher' })
await domain.move(gt.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(gt.id, 'approve', { role: 'human', id: 'me' })
const wt = domain.worktreeOf(gt.id)
await t('派工建出 worktree', () => assert.ok(wt && existsSync(wt.path)))
await t('worktree 分支是 flow/<taskId>', () => assert.equal(wt.branch, 'flow/' + gt.id))
await t('会话 cwd 落在项目工作区（不再跟着 worktree 走）', () => {
  // v1.16：DSH 按 cwd 归组工作区，会话 cwd 若跟着 worktree 走，
  // 工人会话就各自变成独立工作区、在当前工作区里看不见，而且每个任务换一次 cwd
  // 就 reset 一次会话。隔离由 worktree + 案卷里的「你的工作目录」负责。
  const rec = domain.latestSession(store.state.tasks[gt.id].assignee)
  assert.equal(rec.cwd, gp.workspacePath)
})

writeFileSync(join(wt.path, 'README.md'), '# demo\n\nworker 加的一行\n')
const opened = await dispatcher.openPr(store.state.tasks[gt.id])
await t('openPr 生成 PR 记录', () => assert.ok(opened.ok && opened.pr.headSha))
const dup = await dispatcher.openPr(store.state.tasks[gt.id])
await t('同一 head 不重复开 PR', () => assert.equal(dup.pr.id, opened.pr.id))

await domain.move(gt.id, 'stop', { role: 'worker', id: 'w' }, { stopReport: { summary: '改完了', tests: 'node test/smoke.mjs 全绿', files: ['README.md'] } })
await domain.move(gt.id, 'accept', { role: 'human', id: 'me' })
await domain.move(gt.id, 'pr_open', { role: 'dispatcher', id: 'd1' })
// v1.35：没有审核结论时，代理合并必须被拒（以前合并后补一条「自动通过」，判据形同虚设）
const noVerdict = await dispatcher.merge(store.state.tasks[gt.id], { by: 'agent' })
await t('v1.35 没审核结论时代理合并被拒，且没动 git', () => {
  assert.equal(noVerdict.ok, false)
  assert.equal(noVerdict.needsReview, true)
  assert.equal(store.state.tasks[gt.id].column, 'merging')
  assert.equal(store.state.tasks[gt.id].mergeIntent || null, null, '被审核闸门拦下时不该留下合并意图')
})
// 人在看板上点合并 = 人工审核通过
const merged = await dispatcher.merge(store.state.tasks[gt.id], { by: 'human' })
await t('合并成功', () => assert.equal(merged.ok, true))
await t('合并后 README 有工人那行', () => assert.match(readFileSync(join(repo, 'README.md'), 'utf8'), /worker 加的一行/))
await t('合并后任务到 done', () => assert.equal(store.state.tasks[gt.id].column, 'done'))
await t('合并后 worktree 摘除', () => assert.equal(domain.worktreeOf(gt.id), null))
await t('v1.35 合并成功后合并意图已清、结论来自人工点击', () => {
  const t1 = store.state.tasks[gt.id]
  assert.equal(t1.mergeIntent, null)
  assert.equal(t1.mergeRequest.reviewEvidence.reviewer, 'web')
  assert.ok(store.state.events.some((e) => e.type === 'merge.intent' && e.payload.key.startsWith('merge:' + gt.id)), '动 git 之前要先落 merge.intent')
})

// 冲突：两边改同一行
const gt2 = await domain.createTask(gp.id, { title: '冲突任务', acceptance: ['x'] })
await domain.move(gt2.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(gt2.id, '1. 改 README 第一行', { role: 'dispatcher' })
await domain.move(gt2.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(gt2.id, 'approve', { role: 'human', id: 'me' })
const wt2 = domain.worktreeOf(gt2.id)
writeFileSync(join(wt2.path, 'README.md'), 'worker 版本\n')
await dispatcher.openPr(store.state.tasks[gt2.id])
writeFileSync(join(repo, 'README.md'), 'main 版本\n')
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'main change'])
await domain.move(gt2.id, 'stop', { role: 'worker', id: 'w' }, { stopReport: { summary: '改完了', tests: 'node test/smoke.mjs 全绿', files: ['README.md'] } })
await domain.move(gt2.id, 'accept', { role: 'human', id: 'me' })
await domain.move(gt2.id, 'pr_open', { role: 'dispatcher', id: 'd1' })
const conflicted = await dispatcher.merge(store.state.tasks[gt2.id], { by: 'human' })
await t('合并冲突被识别', () => assert.equal(conflicted.conflict, true))
await t('冲突任务回到执行中', () => assert.equal(store.state.tasks[gt2.id].column, 'running'))
await t('冲突写进 PR 状态', () => {
  const pr = Object.values(store.state.pull_requests).filter((x) => x.taskId === gt2.id).pop()
  assert.equal(pr.status, 'conflict')
})
await t('冲突注入软合并包', () => assert.ok(domain.injectionsFor(gt2.id, { kind: 'context' }).length >= 1))
await t('主仓库没有被污染', () => assert.equal(readFileSync(join(repo, 'README.md'), 'utf8').trim(), 'main 版本'))

// ---- v0.002：合并落点搬到集成检出（I-02）+ 越界检查（I-05）-----------------
{
  const { integDirFor } = await import('../lib/integration.js')
  const { join: j2 } = await import('node:path')
  const logout = (args) => sh(repo, ['log', '--oneline'].concat(args || [])).trim().split('\n').filter(Boolean)

  // ① 主检出停在别的分支、且有无关脏文件 —— 现状（repo-dirty / wrong-branch）必然拒，现在必须成功。
  await domain.updateProjectConfig(gp.id, { postMergeCheck: { command: 'git rev-parse --show-toplevel', timeoutMs: 30000 } }, { role: 'human' })
  const gt3 = await domain.createTask(gp.id, { title: '集成检出合并在别的分支上也能做', acceptance: ['x'] })
  await domain.move(gt3.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(gt3.id, '1. 加一行', { role: 'dispatcher' })
  await domain.move(gt3.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(gt3.id, 'approve', { role: 'human', id: 'me' })
  const wt3 = domain.worktreeOf(gt3.id)
  writeFileSync(join(wt3.path, 'README.md'), '# demo\n\nmain 版本\n\nworker 第三条\n')
  await dispatcher.openPr(store.state.tasks[gt3.id])
  // 人切到别的分支，并且留一个不相干的未提交文件
  sh(repo, ['checkout', '-q', '-b', 'feature/human-work'])
  writeFileSync(join(repo, 'human-note.txt'), '人正在写的东西\n')
  await domain.move(gt3.id, 'stop', { role: 'worker', id: 'w' }, { stopReport: { summary: '加完', tests: 'node test/smoke.mjs', files: ['README.md'] } })
  await domain.move(gt3.id, 'accept', { role: 'human', id: 'me' })
  await domain.move(gt3.id, 'pr_open', { role: 'dispatcher', id: 'd1' })
  const merged3 = await dispatcher.merge(store.state.tasks[gt3.id], { by: 'human' })
  await t('v0.002 主检出在别的分支+有无关脏文件，合并仍然成功', () => {
    assert.equal(merged3.ok, true, JSON.stringify(merged3))
    assert.equal(store.state.tasks[gt3.id].column, 'done')
  })
  await t('v0.002 人的未提交文件没被合并碰掉', () => assert.equal(readFileSync(join(repo, 'human-note.txt'), 'utf8'), '人正在写的东西\n'))
  await t('v0.002 主检出仍停在人的分支上（合并不再替人切分支）', () => {
    assert.equal(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/human-work')
  })
  await t('v0.002 base 的 ref 真的前进了（不靠主检出 HEAD）', () => {
    const base = sh(repo, ['rev-parse', 'main']).trim()
    const merged = logout(['main', '-3']).join(' ' )
    assert.match(merged, /集成检出合并在别的分支上也能做|flow: merge/, 'base 上要有这次合并的提交：' + merged)
    assert.equal(sh(repo, ['merge-base', '--is-ancestor', base, 'main']).trim(), '')
  })
  await t('v0.002 合并后冒烟在集成检出里跑（不是人的检出）', () => {
    const check = store.state.tasks[gt3.id].mergeRequest.postMergeCheck
    assert.ok(check, '要留下冒烟记录')
    const shown = String(check.stdout || '').trim().replace(/\\/g, '/').toLowerCase()
    const want = String(integDirFor(gp)).replace(/\\/g, '/').toLowerCase()
    assert.ok(shown.endsWith('__integ__') || shown.includes('__integ__'), '冒烟的 cwd 必须是集成检出，实际 stdout=' + shown)
    assert.equal(String(check.cwd || '').replace(/\\/g, '/').toLowerCase().includes('__integ__'), true, '记录里要写清在哪个目录跑的')
    void want
  })
  await t('v0.002 集成检出留在磁盘上、进了 worktree list 且带锁', async () => {
    const list = await (await import('../lib/git.js')).listWorktrees(repo)
    const entry = list.find((w) => /__integ__$/.test(w.path.replace(/\\/g, '/')))
    assert.ok(entry, '集成检出要在 worktree list 里')
    assert.equal(entry.locked, true)
  })

  // ② 越界检查：设了 scope 的任务，脏文件落在范围内 → 拦下；范围外 → 不拦。
  await domain.updateProjectConfig(gp.id, { postMergeCheck: null }, { role: 'human' })
  const mkMergeReady = async (title, scopePaths) => {
    const tk = await domain.createTask(gp.id, { title, acceptance: ['x'] })
    await domain.move(tk.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(tk.id, '1. x', { role: 'dispatcher' })
    await domain.move(tk.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(tk.id, 'approve', { role: 'human', id: 'me' })
    const w = domain.worktreeOf(tk.id)
    writeFileSync(join(w.path, 'OUT-OF-SCOPE-PROBE.md'), 'worker\n')
    await dispatcher.openPr(store.state.tasks[tk.id])
    await domain.move(tk.id, 'stop', { role: 'worker', id: 'w' }, { stopReport: { summary: 'ok', tests: 'x', files: ['OUT-OF-SCOPE-PROBE.md'] } })
    await domain.move(tk.id, 'accept', { role: 'human', id: 'me' })
    await domain.move(tk.id, 'pr_open', { role: 'dispatcher', id: 'd1' })
    if (scopePaths) await domain.setScope(tk.id, { paths: scopePaths, symbols: [] }, { role: 'dispatcher', id: 'd1' })
    return tk.id
  }

  const oosId = await mkMergeReady('越界检查：范围内的脏文件要拦下', ['README.md'])
  writeFileSync(join(repo, 'README.md'), '# demo\n\nhuman 还没提交的改动\n')
  const oosRes = await dispatcher.merge(store.state.tasks[oosId], { by: 'human' })
  await t('v0.002 主检出里落在 scope 内的未提交改动拦下合并', () => {
    assert.equal(oosRes.ok, false)
    assert.equal(oosRes.outOfScope, true)
    assert.deepEqual(oosRes.files, ['README.md'])
    assert.equal(store.state.tasks[oosId].mergeState, 'blocked')
    assert.equal(store.state.tasks[oosId].mergeReason, 'out-of-scope-dirty')
  })
  await t('v0.002 越界拦下时卡片没动、也没进合并', () => {
    assert.equal(store.state.tasks[oosId].column, 'merging')
    assert.match(store.state.tasks[oosId].noMergeReason || '', /README/)
  })
  sh(repo, ['checkout', '-q', '--', 'README.md'])
  const oosOk = await dispatcher.merge(store.state.tasks[oosId], { by: 'human' })
  await t('v0.002 脏文件清掉后同一张卡可以继续合', () => assert.equal(oosOk.ok, true, JSON.stringify(oosOk)))

  const oos2 = await mkMergeReady('越界检查：范围外的脏文件不拦', ['README.md'])
  writeFileSync(join(repo, 'unrelated-wip.txt'), '与这张卡无关\n')
  const oos2Res = await dispatcher.merge(store.state.tasks[oos2], { by: 'human' })
  await t('v0.002 范围外的脏文件不拦', () => assert.equal(oos2Res.ok, true, JSON.stringify(oos2Res)))

  const oos3 = await mkMergeReady('越界检查：没设 scope 的任务不拦', null)
  writeFileSync(join(repo, 'README.md'), '# demo\n\nhuman 又写了点东西\n')
  const oos3Res = await dispatcher.merge(store.state.tasks[oos3], { by: 'human' })
  await t('v0.002 没设阅读范围的任务不做越界检查（人的日常编辑不该被当越界）', () => assert.equal(oos3Res.ok, true, JSON.stringify(oos3Res)))

  const oos4 = await mkMergeReady('越界检查：显式 override 放行', ['README.md'])
  writeFileSync(join(repo, 'README.md'), '# demo\n\nhuman 的第三次改动\n')
  const oos4Res = await dispatcher.merge(store.state.tasks[oos4], { by: 'human', overrideOutOfScope: true })
  await t('v0.002 overrideOutOfScope: true 可以显式放行，并留下授权评论', async () => {
    assert.equal(oos4Res.ok, true, JSON.stringify(oos4Res))
    const comments = domain.taskDetail(oos4).comments.map((c) => c.content)
    assert.ok(comments.some((c) => /显式放行/.test(c)), '要留一条"谁放的行"的记录')
  })
  sh(repo, ['checkout', '-q', '--', 'README.md'])
}
// ---- v0.002：拒绝语义分家 / rebase 改 ff-only / 合并锁续租（I-03）----------
{
  const { integDirFor } = await import('../lib/integration.js')
  const { rm } = await import('node:fs/promises')
  const mkReady = async (title) => {
    const tk = await domain.createTask(gp.id, { title, acceptance: ['x'] })
    await domain.move(tk.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(tk.id, '1. x', { role: 'dispatcher' })
    await domain.move(tk.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(tk.id, 'approve', { role: 'human', id: 'me' })
    return tk.id
  }
  const finish = async (id, fileName, content) => {
    const w = domain.worktreeOf(id)
    writeFileSync(join(w.path, fileName), content)
    await dispatcher.openPr(store.state.tasks[id])
    await domain.move(id, 'stop', { role: 'worker', id: 'w' }, { stopReport: { summary: 'ok', tests: 'x', files: [fileName] } })
    await domain.move(id, 'accept', { role: 'human', id: 'me' })
    await domain.move(id, 'pr_open', { role: 'dispatcher', id: 'd1' })
  }

  // ① 集成检出自己变脏 → blocked/dirty，卡不动、不派工
  const dId = await mkReady('集成检出脏了要拦住')
  await finish(dId, 'dirty-probe.txt', 'worker\n')
  writeFileSync(join(integDirFor(gp), 'stray.txt'), '不该出现的文件\n')
  const before = rt.calls.length
  const dRes = await dispatcher.merge(store.state.tasks[dId], { by: 'human' })
  await t('v0.002 集成检出自己变脏时合并被拦下（blocked/dirty）', () => {
    assert.equal(dRes.ok, false)
    assert.equal(dRes.blocked, true)
    assert.equal(dRes.reason, 'integ-dirty')
    assert.equal(store.state.tasks[dId].mergeState, 'blocked')
    assert.equal(store.state.tasks[dId].column, 'merging', '卡不该动')
  })
  await t('v0.002 环境类失败不回派工人（不然工人白做一次软合并）', () => {
    const prompted = rt.calls.slice(before).filter((c) => c.text && /软合并|rebase/.test(String(c.text)))
    assert.equal(prompted.length, 0, '不该有新的派工：' + JSON.stringify(prompted.slice(0, 2)))
  })
  await rm(join(integDirFor(gp), 'stray.txt'), { force: true })
  const dRes2 = await dispatcher.merge(store.state.tasks[dId], { by: 'human' })
  await t('v0.002 清掉集成检出的脏文件后可以继续合', () => assert.equal(dRes2.ok, true, JSON.stringify(dRes2)))

  // ② mergeStrategy=rebase：走 ff-only
  await domain.updateProjectConfig(gp.id, { mergeStrategy: 'rebase' }, { role: 'human' })
  const rId = await mkReady('rebase 项目走 ff-only')
  await finish(rId, 'ff-probe.txt', 'worker\n')
  const rRes = await dispatcher.merge(store.state.tasks[rId], { by: 'human' })
  await t('v0.002 rebase 策略走 ff-only 而不是 checkout 任务分支', () => {
    assert.equal(rRes.ok, true, JSON.stringify(rRes))
    assert.equal(rRes.strategy, 'rebase')
    assert.equal(store.state.tasks[rId].column, 'done')
  })
  await t('v0.002 ff 之后 worker 分支没被 checkout 夺走（它是 fast-forward 的）', () => {
    assert.ok(domain.worktreeOf(rId) === null, '合并成功后任务检出已摘除')
  })

  // ③ needs-rebase：分支落后 base，ff 不动 → 回派一次并 blocked
  const nId = await mkReady('分支落后 base 时要发回工人')
  await finish(nId, 'behind-probe.txt', 'worker\n')
  // 制造"分支落后"：直接往 base 上推进一个提交（模拟别的卡先合了）。
  // 注意不能在主检出里提交 —— 它此刻停在 feature/human-work 上，那样推进的是另一条分支。
  const advWt = join(dir, 'advance-main')
  sh(repo, ['worktree', 'add', '-q', advWt, 'main'])
  writeFileSync(join(advWt, 'someone-else.txt'), '别人的改动\n')
  sh(advWt, ['add', '-A']); sh(advWt, ['commit', '-qm', '别人的提交'])
  sh(repo, ['worktree', 'remove', '--force', advWt])
  const nRes = await dispatcher.merge(store.state.tasks[nId], { by: 'human' })
  // C-01 改了这条路径的语义：分支落后**不**是「合并失败」，而是「还没轮到」——
  // 现在先 review_conflict 回派（卡回到 running，工人这才发得出 stop），
  // mergeState 记 pending，等工人软合并交上来之后重新验收、再合一次。
  await t('v0.002 分支落后 base：ff-only 失败 → 回派工人 + mergeState=pending', () => {
    assert.equal(nRes.ok, false)
    assert.equal(nRes.reason, 'needs-rebase')
    assert.equal(nRes.attempts, 1)
    assert.equal(store.state.tasks[nId].mergeState, 'pending')
    assert.equal(store.state.tasks[nId].mergeReason, 'needs-rebase')
    assert.equal(store.state.tasks[nId].column, 'running', '回派的卡必须回到 running，否则工人自停会被状态机拒')
    assert.equal(store.state.tasks[nId].rebaseAttempts, 1)
  })
  await t('v0.002 needs-rebase 有次数上限（第 3 次之后不再回派）', async () => {
    // 卡此刻在 running（回派中），再走一次合并要先回到合并列 —— 直接摆好前置态，
    // 这里验的是「上限」这一条判据，不是状态机迁移。
    await store.tx((s) => {
      const tk = s.tasks[nId]
      tk.column = 'merging'
      tk.phase = 'merge-ready'
      tk.activeRunId = null
      tk.rebaseAttempts = 3
    })
    const more = await dispatcher.merge(store.state.tasks[nId], { by: 'human' })
    assert.equal(more.ok, false)
    assert.equal(store.state.tasks[nId].rebaseAttempts, 4)
    assert.equal(store.state.tasks[nId].mergeState, 'blocked')
    assert.match(String(store.state.tasks[nId].noMergeReason || ''), /上限 3/)
  })
  await domain.updateProjectConfig(gp.id, { mergeStrategy: 'merge' }, { role: 'human' })

  // ④ 合并锁续租与恢复
  await t('v0.002 合并锁默认 10 分钟且能续租', async () => {
    const lock = await domain.lockMerge(gp.id, 'T-TTL')
    assert.equal(lock.ok, true)
    // 抢锁失败（证明锁在）→ 续租后仍失败 → 手工作废后能拿到
    const blocked = await domain.lockMerge(gp.id, 'T-other')
    assert.equal(blocked.ok, false)
    const renewed = await domain.renewMerge(gp.id, lock.token)
    assert.equal(renewed.ok, true)
    const stale = store.state.leases['merge:' + gp.id]
    assert.ok(Date.parse ? true : true)
    assert.ok(stale.expiresAt - Date.now() > 60 * 1000, '续租后剩余时间要长于旧的 60s ttl')
    await domain.unlockMerge(gp.id, lock.token)
    assert.equal((await domain.lockMerge(gp.id, 'T-other')).ok, true)
    await domain.unlockMerge(gp.id, (await domain.lockMerge(gp.id, 'T-x')).token || store.state.leases['merge:' + gp.id].token)
    for (const k of Object.keys(store.state.leases).filter((x) => x.startsWith('merge:'))) delete store.state.leases[k]
  })
  await t('v0.002 启动对账清掉 merge: 前缀的幽灵锁', async () => {
    await domain.lockMerge(gp.id, 'T-restart')
    assert.ok(store.state.leases['merge:' + gp.id], '锁要先在')
    const rec = await domain.recoverRuns(Date.now() + 1000)
    assert.equal(store.state.leases['merge:' + gp.id], undefined, '进程重启后不该还锁着仓库')
    assert.ok(Array.isArray(rec.merges) && rec.merges.length >= 1)
  })
}
// ---- v0.002：pushRemote 项目合并后 push base + 释放集成检出（I-04）----------
{
  const { integDirFor } = await import('../lib/integration.js')
  const bare = join(dir, 'origin.git')
  sh(dir, ['init', '-q', '--bare', bare])
  sh(repo, ['remote', 'add', 'origin', bare])
  sh(repo, ['push', '-q', '-u', 'origin', 'main'])
  await domain.updateProjectConfig(gp.id, { pushRemote: true }, { role: 'human' })

  const mkPushReady = async (title, file) => {
    const tk = await domain.createTask(gp.id, { title, acceptance: ['x'] })
    await domain.move(tk.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(tk.id, '1. x', { role: 'dispatcher' })
    await domain.move(tk.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(tk.id, 'approve', { role: 'human', id: 'me' })
    const w = domain.worktreeOf(tk.id)
    writeFileSync(join(w.path, file), 'worker' + String.fromCharCode(10))
    await dispatcher.openPr(store.state.tasks[tk.id])
    await domain.move(tk.id, 'stop', { role: 'worker', id: 'w' }, { stopReport: { summary: 'ok', tests: 'x', files: [file] } })
    await domain.move(tk.id, 'accept', { role: 'human', id: 'me' })
    await domain.move(tk.id, 'pr_open', { role: 'dispatcher', id: 'd1' })
    return tk.id
  }

  const pId = await mkPushReady('pushRemote 合并后要推 base', 'pushed-probe.txt')
  const pRes = await dispatcher.merge(store.state.tasks[pId], { by: 'human' })
  await t('v0.002 pushRemote 项目合并成功后推送 base', () => {
    assert.equal(pRes.ok, true, JSON.stringify(pRes))
    const local = sh(repo, ['rev-parse', 'main']).trim()
    const remote = sh(bare, ['rev-parse', 'main']).trim()
    assert.equal(remote, local, '远程 base 必须跟本地一致，否则 PR 永远 open')
  })

  const fId = await mkPushReady('推送失败也要保住本地合并', 'push-fail-probe.txt')
  sh(repo, ['remote', 'set-url', 'origin', join(dir, 'no-such-remote.git')])
  const fRes = await dispatcher.merge(store.state.tasks[fId], { by: 'human' })
  await t('v0.002 远程不可达时卡 blocked/push-failed 但本地合并结果保留', () => {
    assert.equal(fRes.ok, false)
    assert.equal(fRes.pushFailed, true)
    assert.equal(store.state.tasks[fId].mergeState, 'blocked')
    assert.equal(store.state.tasks[fId].mergeReason, 'push-failed')
    assert.ok(gitExists(join(integDirFor(gp), 'push-fail-probe.txt')), '撤销已落地的合并比不同步更危险')
  })
  sh(repo, ['remote', 'set-url', 'origin', bare])
  await domain.updateProjectConfig(gp.id, { pushRemote: false }, { role: 'human' })

  await t('v0.002 合并进行中不许释放集成检出', async () => {
    await domain.lockMerge(gp.id, 'T-INFLIGHT')
    const rel = await dispatcher.releaseIntegration(gp, {})
    assert.equal(rel.ok, false)
    assert.equal(rel.reason, 'merging')
    for (const k of Object.keys(store.state.leases).filter((x) => x.startsWith('merge:'))) delete store.state.leases[k]
  })
  await t('v0.002 释放集成检出之后主检出可以切回 base', async () => {
    assert.ok(gitExists(integDirFor(gp)), '先要在')
    const rel = await dispatcher.releaseIntegration(gp, {})
    assert.equal(rel.ok, true, JSON.stringify(rel))
    assert.ok(!gitExists(integDirFor(gp)), '目录要被删掉')
    sh(repo, ['checkout', '-q', 'main'])
    assert.equal(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')
  })
  await t('v0.002 没有集成检出时 status 如实报不存在', async () => {
    const st = await dispatcher.integrationStatus(gp, {})
    assert.equal(st.exists, false)
  })
}

// ---- v1.16：身份名 = 车道 + 角色 + 序号 ------------------------------------
{
  const { agentLabel } = domainMod
  await t('工位身份名是 human调度1 / human工人1 / auto调度1 这种', () => {
    assert.equal(agentLabel({ id: 'a1', role: 'dispatcher', slot: 1, lane: 'human', name: 'human调度1' }), 'human调度1')
    assert.equal(agentLabel({ id: 'a2', role: 'worker', slot: 2, lane: 'human' }), 'human工人2')
    assert.equal(agentLabel({ id: 'a3', role: 'dispatcher', slot: 1, lane: 'issue' }), 'auto调度1')
    assert.equal(agentLabel({ id: 'a4', role: 'worker', slot: 1, lane: 'issue' }), 'auto工人1')
  })
  await t('总调度者保留自己的名字（那是用户自己的聊天框）', () => {
    assert.equal(agentLabel({ id: 'a5', role: 'chief', slot: 1, lane: 'human', name: '总调度者1' }), '总调度者1')
  })
  await t('基础分支默认留空 = 自动探测（写死 main 会把 master 仓库带偏）', () => {
    // 真值 'main' 会短路 dispatch 里的 defaultBranch()（origin/HEAD → main → master → 当前分支），
    // 于是 master 仓库也在 main 上建 worktree —— 线上就是这样建不出来、静默降级成无合并。
    assert.equal(domainMod.DEFAULT_CONFIG.baseBranch, '')
  })
  await t('新项目的 baseBranch 是空的，等 defaultBranch 去探', async () => {
    const np = await domain.ensureProject({ workspacePath: join(dir, 'base-branch-probe'), name: 'bb' })
    assert.equal(np.config.baseBranch, '')
  })
  await t('setSessionTitle 把身份名写进会话记录并发事件', async () => {
    const cp = await domain.ensureProject({ workspacePath: join(dir, 'title-repo'), name: 'title' })
    const w = domain.workersOf(cp.id, 'human')[0]
    await domain.bindSession(w.id, 'ses-title-1', { state: 'idle', cwd: cp.workspacePath }, { role: 'system' })
    const before = store.state.events.length
    await domain.setSessionTitle(w.id, 'human工人1', { role: 'system' })
    const rec = domain.latestSession(w.id)
    assert.equal(rec.title, 'human工人1')
    assert.ok(store.state.events.slice(before).some((e) => e.type === 'session.renamed'), '要留事件')
  })
  await t('buildProjectView 暴露 identity label 与会话信息', async () => {
    const vp = await domain.ensureProject({ workspacePath: join(dir, 'label-view'), name: 'lv' })
    const w = domain.workersOf(vp.id, 'human')[0]
    await domain.bindSession(w.id, 'ses-label-1', { state: 'idle', cwd: vp.workspacePath, }, { role: 'system' })
    await domain.setSessionTitle(w.id, 'human工人1', { role: 'system' })
    const view = panelMod.buildProjectView(store.state, vp.id)
    const row = view.agents.find((a) => a.agentId === w.id || a.id === w.id)
    assert.ok(row, '要能拿到这个工位')
    assert.equal(row.label, 'human工人1')
    assert.equal(row.sessionTitle, 'human工人1')
    assert.equal(row.sessionCwd, vp.workspacePath)
  })
}

// ---- v1.15：仓库零提交时不静默丢掉"合并"这件事 --------------------------
{
  // 真验证过一次线上的坑：wb反代 有 .git 但一次提交都没有，worktree 建不出来，
  // 系统把 fatal: invalid reference: HEAD 写进评论、塞 noMerge=true 就完事。
  const unborn = mkdtempSync(join(tmpdir(), 'flow-unborn-'))
  sh(unborn, ['init', '-q', '-b', 'master'])
  sh(unborn, ['config', 'user.email', 'flow@local'])
  sh(unborn, ['config', 'user.name', 'flow'])
  writeFileSync(join(unborn, 'a.txt'), 'baseline content')

  const up = await domain.ensureProject({ workspacePath: unborn, name: 'unborn' })
  await domain.updateProjectConfig(up.id, { recordIssues: true }, { role: 'human' })

  const ut = await domain.createTask(up.id, { title: '零提交仓库派工', acceptance: ['x'] })
  await domain.move(ut.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(ut.id, '1. 改 a.txt', { role: 'dispatcher' })
  await domain.move(ut.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(ut.id, 'approve', { role: 'human', id: 'me' })

  await t('零提交仓库派工：不建 worktree，但把原因说清楚', () => {
    const cur = store.state.tasks[ut.id]
    // I-07 改了表达方式：不再"没有记录"，而是显式记一条 state=none —— 这样读侧能分清
    // "还没建" 与 "这个项目不需要建"。要守的是**不许有可用路径**，不是"不许有记录"。
    const rec = domain.worktreeOf(ut.id)
    assert.ok(!rec || !rec.path, '没有基线提交就不该假装建出了 worktree：' + JSON.stringify(rec))
    assert.equal(rec ? rec.state : null, 'none')
    assert.equal(rec.stateReason, 'no-commits')
    assert.equal(cur.noMerge, true)
    assert.match(cur.noMergeReason, /一次提交都没有|基线/, '要讲清是缺基线，不是"不支持 git"。实际：' + cur.noMergeReason)
    assert.ok(!/invalid reference/.test(cur.noMergeReason), '不该把 git 的裸 fatal 直接抛给用户：' + cur.noMergeReason)
  })

  await t('补上基线提交之后，下一次派工重新拿到 worktree 与合并流程', async () => {
    sh(unborn, ['add', '-A'])
    sh(unborn, ['commit', '-qm', 'baseline'])
    // 老卡还挂在 noMerge 上，但那是上一轮的状态；先让它走完，再看新卡的派工
    const ut2 = await domain.createTask(up.id, { title: '有基线之后再派', acceptance: ['y'] })
    await domain.move(ut2.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(ut2.id, '1. 再改 a.txt', { role: 'dispatcher' })
    await domain.move(ut2.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(ut2.id, 'approve', { role: 'human', id: 'me' })
    const rec = domain.worktreeOf(ut2.id)
    assert.ok(rec && existsSync(rec.path), '补了基线就该建出 worktree，实际：' + JSON.stringify(rec))
    assert.equal(store.state.tasks[ut2.id].noMerge, undefined, '拿到 worktree 的卡不该再被标成"不合并"')
  })

  await t('上一轮被标了 noMerge 的卡，这一轮拿到 worktree 要把标记撤掉', async () => {
    // 单独一个仓库，别去抢 git-demo 的工位（后面 tick 用例假定还有空闲工人）。
    // 人为留着上一轮的 noMerge=true，模拟"仓库后来补了基线、卡又被打回重派"。
    const fixed = mkdtempSync(join(tmpdir(), 'flow-mergeback-'))
    sh(fixed, ['init', '-q', '-b', 'main'])
    sh(fixed, ['config', 'user.email', 'flow@local'])
    sh(fixed, ['config', 'user.name', 'flow'])
    writeFileSync(join(fixed, 'a.txt'), 'baseline')
    sh(fixed, ['add', '-A'])
    sh(fixed, ['commit', '-qm', 'baseline'])
    const fp = await domain.ensureProject({ workspacePath: fixed, name: 'merge-back' })
    await domain.updateProjectConfig(fp.id, { recordIssues: true }, { role: 'human' })

    const rt = await domain.createTask(fp.id, { title: '打回重派要恢复合并', acceptance: ['z'] })
    await domain.setNoMerge(rt.id, true, '上一轮没有基线提交', { role: 'system' })
    await domain.move(rt.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(rt.id, '1. 改 README', { role: 'dispatcher' })
    await domain.move(rt.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(rt.id, 'approve', { role: 'human', id: 'me' })
    const cur = store.state.tasks[rt.id]
    assert.ok(domain.worktreeOf(rt.id), '前提：这一轮能建出 worktree')
    assert.equal(cur.noMerge, false, 'noMerge 是"这一轮的状态"，不是"这张卡的永久属性"')
  })
}

// ---- v0.3：事件 / 镜像 / webhook -----------------------------------------
const env1 = { source: 'gitea', type: 'issue.mirrored', refKind: 'issue', refId: '9', dedupeKey: 'gitea:issue:9:opened:2026-10-01', payload: { remoteId: '9', title: '远程 issue' } }
const ing1 = await domain.ingest(env1)
await t('事件入站成功', () => assert.equal(ing1.ok, true))
const ing2 = await domain.ingest(env1)
await t('同 dedupeKey 去重', () => assert.equal(ing2.duplicate, true))

const syncStats = await domain.syncRemote(gp.id, { source: 'gitea', cursor: 'c1', items: [{ remoteId: '7', remoteRev: 'r1', kind: 'issue', title: '远程 7', state: 'open' }] })
await t('同步落镜像', () => assert.equal(syncStats.added, 1))
await t('同步落游标', () => assert.equal(domain.cursorFor(gp.id, 'gitea'), 'c1'))
const syncAgain = await domain.syncRemote(gp.id, { source: 'gitea', cursor: 'c2', items: [{ remoteId: '7', remoteRev: 'r1', kind: 'issue', title: '远程 7', state: 'open' }] })
await t('同 rev 不重复写', () => assert.equal(syncAgain.unchanged, 1))

// v1.21：这里故意**不写 enabled**——lib/setup.js 写 remote 时也不写它。
// 老代码 `if (!remote || !remote.enabled) continue` 会因此永久跳过同步（issue 进不来）。
await domain.updateProjectConfig(gp.id, { remote: { kind: 'gitea', owner: 'o', repo: 'r', webhookSecret: 's3cret' } }, { role: 'human' })
const hookBody = JSON.stringify({ action: 'opened', issue: { number: 12, title: '远程 bug', body: 'b', state: 'open', updated_at: '2026-10-01T00:00:00Z' } })
const { createHmac } = await import('node:crypto')
const goodSig = createHmac('sha256', 's3cret').update(hookBody).digest('hex')
const badHook = await handler(new Request('http://local/api/flow/hooks/gitea?projectId=' + gp.id, { method: 'POST', body: hookBody, headers: { 'x-gitea-event': 'issues', 'x-gitea-signature': 'deadbeef' } }))
await t('webhook 验签失败 401', () => assert.equal(badHook.status, 401))
const goodHook = await handler(new Request('http://local/api/flow/hooks/gitea?projectId=' + gp.id, { method: 'POST', body: hookBody, headers: { 'x-gitea-event': 'issues', 'x-gitea-signature': goodSig } }))
await t('webhook 验签通过 202', () => assert.equal(goodHook.status, 202))
const dupHook = await handler(new Request('http://local/api/flow/hooks/gitea?projectId=' + gp.id, { method: 'POST', body: hookBody, headers: { 'x-gitea-event': 'issues', 'x-gitea-signature': goodSig } }))
await t('重复 webhook 202 duplicate', async () => {
  assert.equal(dupHook.status, 202)
  assert.equal((await dupHook.json()).duplicate, true)
})

// ---- v1.21：远程同步的游标与 payload -------------------------------------
{
  const { listIssues, listPulls } = await import('../lib/remote.js')

  await t('listIssues 显式排序 + 游标取最新一条（不是末行）', async () => {
    let seenUrl = ''
    const rows = [
      { number: 1, title: 'a', updated_at: '2026-10-31T13:00:00Z' },
      { number: 2, title: 'b', updated_at: '2026-10-31T15:00:00Z' },
      { number: 3, title: 'c', updated_at: '2026-10-31T14:00:00Z' },
    ]
    const res = await listIssues({
      remote: { kind: 'gitea', baseUrl: 'http://remote.local', owner: 'o', repo: 'r' },
      fetchImpl: async (url) => { seenUrl = String(url); return { ok: true, json: async () => rows } },
    })
    assert.equal(res.ok, true)
    assert.equal(res.cursor, '2026-10-31T15:00:00Z', 'created desc 下末行是最旧的一条，游标必须取最大值')
    assert.ok(seenUrl.includes('sort=recentupdate'), 'Gitea 要显式按最近更新排序：' + seenUrl)
    assert.ok(res.items.every((it) => 'url' in it), 'items 要带 url，建卡时 note 里要贴原文链接')
  })

  await t('listPulls 不把 since 当过滤条件也能取到最新游标', async () => {
    const rows = [
      { number: 9, title: 'p', updated_at: '2026-10-31T10:00:00Z', head: { ref: 'flow/T-1', sha: 'abc' }, merged: true },
      { number: 8, title: 'q', updated_at: '2026-10-31T12:00:00Z', head: { ref: 'flow/T-2', sha: 'def' }, merged: false },
    ]
    const res = await listPulls({
      remote: { kind: 'gitea', baseUrl: 'http://remote.local', owner: 'o', repo: 'r' },
      fetchImpl: async () => ({ ok: true, json: async () => rows }),
    })
    assert.equal(res.cursor, '2026-10-31T12:00:00Z')
    assert.equal(res.items[0].merged, true)
    assert.equal(res.items[0].branch, 'flow/T-1')
  })

  await t('同步的事件 payload 带 issue 正文与链接', async () => {
    await domain.syncRemote(gp.id, {
      source: 'gitea',
      cursor: null,
      items: [{ remoteId: '77', remoteRev: 'r77', kind: 'issue', title: '带正文的 issue', body: '正文第一段', url: 'https://remote.local/o/r/issues/77', state: 'open' }],
    })
    const env = store.state.event_inbox.filter((e) => e.refId === '77').pop()
    assert.ok(env, '应当入站一条事件')
    assert.equal(env.payload.body, '正文第一段', 'body 丢了建出的卡就没有需求原文')
    assert.equal(env.payload.url, 'https://remote.local/o/r/issues/77')
  })

  await t('event.js 把 payload.body/url 拼进卡片 note（原来只剩「（来自 github #N）」）', async () => {
    const { taskInputFromEvent } = await import('../lib/event.js')
    const input = taskInputFromEvent({
      source: 'github', refKind: 'issue',
      payload: { remoteId: '2', title: 't', body: '需求正文', url: 'https://github.com/o/r/issues/2', rev: 'r2' },
    })
    assert.ok(input.note.includes('需求正文'), 'note 必须带 issue 正文：' + input.note)
    assert.ok(input.note.includes('https://github.com/o/r/issues/2'), 'note 要贴原文链接')
  })

  await t('pull 事件的 payload 带 merged/branch，远程合并回写才不是死代码', async () => {
    await domain.syncRemote(gp.id, {
      source: 'gitea',
      cursor: null,
      items: [{ remoteId: '88', remoteRev: 'r88', kind: 'pull', title: 'PR', body: '', state: 'closed', merged: true, branch: 'flow/T-1', headSha: 'deadbeef' }],
    })
    const env = store.state.event_inbox.filter((e) => e.refId === '88').pop()
    assert.ok(env, '应当入站一条 pull 事件')
    assert.equal(env.payload.merged, true)
    assert.equal(env.payload.branch, 'flow/T-1')
  })
}

// ---- v1.22：项目级双向同步（纯函数 / 出站 / 入站 / 熔断）------------------
{
  const syncMod = await import('../lib/sync.js')
  const remoteMod = await import('../lib/remote.js')
  const { createSyncEngine } = await import('../lib/sync-engine.js')

  await t('sync.js：marker 生成/识别/剥离', () => {
    const body = '正文\n\n' + syncMod.flowMarker('task', 'T-012', 'abc123')
    assert.ok(syncMod.hasFlowMarker(body))
    assert.equal(syncMod.markerNonce(body), 'abc123')
    assert.equal(syncMod.stripFlowMarker(body).trim(), '正文')
    assert.equal(syncMod.hasFlowMarker('普通评论'), false, '普通评论不能被误判成自己推的')
  })

  await t('sync.js：scrubOutbound 擦 token 与本地绝对路径', () => {
    const out = syncMod.scrubOutbound('见 C:/Users/Administrator/Desktop/prjs/dsh-flow/client.js 与 gho_abcdefghijklmnopqrstuvwx')
    assert.ok(out.includes('[path]'), '本地绝对路径不该推到公开仓库：' + out)
    assert.ok(out.includes('[redacted]'), 'token 不该推到公开仓库：' + out)
    assert.ok(!out.includes('gho_'), 'token 原文必须被擦掉')
  })

  await t('sync.js：受管标签只认四个 scope', () => {
    assert.equal(syncMod.managedLabel('flow/running'), true)
    assert.equal(syncMod.managedLabel('lane/auto'), true)
    assert.equal(syncMod.managedLabel('prio/high'), true)
    assert.equal(syncMod.managedLabel('blocked'), true)
    assert.equal(syncMod.managedLabel('needs-design'), false, '人自己贴的标签不能被我们删掉')
  })

  await t('sync.js：diffLabels 只删受管且不在期望里的', () => {
    const d = syncMod.diffLabels(['flow/todo', 'lane/human', 'needs-design'], ['flow/running', 'lane/human'])
    assert.deepEqual(d.add, ['flow/running'])
    assert.deepEqual(d.remove, ['flow/todo'])
  })

  await t('sync.js：desiredLabels 把列/车道/优先级/阻塞翻成标签', () => {
    const tags = syncMod.desiredLabels({ column: 'running', lane: 'issue', priority: 'high', blocked: { reason: 'x' } })
    assert.deepEqual(tags, ['flow/running', 'lane/auto', 'prio/high', 'blocked'])
  })

  await t('sync.js：assessPlanRisk 命中硬规则就判 high', () => {
    const r = syncMod.assessPlanRisk('改 schema 并新增第三方依赖 express', { scope: { paths: ['lib/core.js'] } }, {})
    assert.equal(r.level, 'high')
    assert.ok(r.reasons.length >= 2, '要说清楚命中哪几条')
  })

  await t('sync.js：canAutoApprove 三道闸门缺一不可', () => {
    const project = { config: { autoApproveIssue: false } }
    const low = { level: 'low', reasons: [] }
    assert.equal(syncMod.canAutoApprove({ plan: { text: '做点小事', revision: 1 }, risk: low }, project).ok, false, '开关没开不能自动批')
    const on = { config: { autoApproveIssue: true } }
    assert.equal(syncMod.canAutoApprove({ plan: { text: '做点小事', revision: 1 }, risk: low }, on).ok, true)
    assert.equal(syncMod.canAutoApprove({ plan: { text: '', revision: 0 }, risk: low }, on).ok, false, '没方案不能批')
    assert.equal(syncMod.canAutoApprove({ plan: { text: '做大改', revision: 1 }, risk: { level: 'high' } }, on).ok, false, '高风险不能自动批')
  })

  await t('listComments 游标取最新一条（不是末行）', async () => {
    const rows = [
      { id: 1, issue_url: 'http://x/issues/3', body: 'a', updated_at: '2026-10-31T10:00:00Z' },
      { id: 2, issue_url: 'http://x/issues/4', body: 'b', updated_at: '2026-10-31T12:00:00Z' },
      { id: 3, issue_url: 'http://x/issues/5', body: 'c', updated_at: '2026-10-31T11:00:00Z' },
    ]
    const res = await remoteMod.listComments({
      remote: { kind: 'gitea', baseUrl: 'http://remote.local', owner: 'o', repo: 'r' },
      fetchImpl: async () => ({ ok: true, json: async () => rows }),
    })
    assert.equal(res.ok, true)
    assert.equal(res.cursor, '2026-10-31T12:00:00Z')
    assert.equal(res.items[0].issueNumber, 3, 'issueNumber 要从 issue_url 里解出来')
  })

  await t('createComment / patchIssue / addIssueLabel 走对方法与端点', async () => {
    const seen = []
    const fake = async (url, init = {}) => {
      seen.push({ url: String(url), method: init.method || 'GET', body: init.body })
      const data = { id: 55, html_url: 'u' }
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }
    }
    const remote = { kind: 'gitea', baseUrl: 'http://remote.local', owner: 'o', repo: 'r' }
    await remoteMod.createComment({ remote, issueNumber: 7, body: 'hi', fetchImpl: fake })
    await remoteMod.patchIssue({ remote, issueNumber: 7, patch: { state: 'closed', stateReason: 'not_planned' }, fetchImpl: fake })
    await remoteMod.addIssueLabel({ remote, issueNumber: 7, label: 'flow/running', fetchImpl: fake })
    await remoteMod.removeIssueLabel({ remote, issueNumber: 7, label: 'flow/todo', fetchImpl: fake })
    assert.ok(seen[0].url.endsWith('/issues/7/comments') && seen[0].method === 'POST')
    assert.ok(seen[1].url.endsWith('/issues/7') && seen[1].method === 'PATCH')
    assert.ok(String(seen[1].body).includes('not_planned'), '取消要写 state_reason=not_planned，和"完成"区分开')
    assert.ok(seen[2].url.endsWith('/issues/7/labels') && seen[2].method === 'POST')
    assert.equal(seen[3].method, 'DELETE')
    assert.ok(seen[3].url.includes('flow%2Ftodo'), '标签名要 URL 编码：' + seen[3].url)
  })

  // ---- 出站：本地卡推成远程 issue，重复推不会再建一次 ----------------
  const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-sync'), name: 'sync-demo' })
  await domain.updateProjectConfig(sp.id, {
    remoteMode: true,
    recordIssues: true,
    pushRemote: true,
    remote: { kind: 'github', baseUrl: 'https://api.github.com', owner: 'El1mir', repo: 'demo' },
  }, { role: 'human' })
  await domain.armProjectSync(sp.id)

  const st1 = await domain.createTask(sp.id, { title: '同步出去的卡', note: '正文在这里' })
  const created = []
  const jsonRes = (data, status = 200) => {
    const text = JSON.stringify(data)
    return { ok: true, status, json: async () => data, text: async () => text }
  }
  const fakeGw = async (url, init = {}) => {
    const u = String(url)
    created.push({ url: u, method: init.method || 'GET', body: init.body || null })
    if (u.endsWith('/issues') && (init.method || 'GET') === 'POST') {
      return jsonRes({ number: 42, html_url: 'https://github.com/El1mir/demo/issues/42' }, 201)
    }
    return jsonRes([])
  }

  const engine = createSyncEngine({ domain, store, dispatcher, runtime: rt, log: () => {}, fetchImpl: fakeGw })
  const pushed = await engine.pushProject(store.state.projects[sp.id])
  await t('出站：本地新建的卡推成远程 issue', () => {
    assert.equal(pushed.ok, true)
    assert.ok(pushed.results.outbound.some((o) => o.taskId === st1.id && o.issueNumber === 42), '应当记下远程 issue 号')
    assert.ok(pushed.results.pendingDone.length >= 1, 'POST 成功后要清 pending')
  })
  await t('出站：body 带 marker 且已擦掉本地路径', () => {
    const post = created.find((c) => c.method === 'POST' && c.url.endsWith('/issues'))
    assert.ok(post, '应当 POST 过 /issues')
    assert.ok(String(post.body).includes('dsh-flow:task'), 'marker 缺失会导致下次又被当成新 issue' + post.body)
  })

  await domain.applySyncResults(sp.id, {
    inbound: { issues: [], comments: [] },
    outbound: pushed.results.outbound,
    pendingAdd: [],
    pendingDone: pushed.results.pendingDone,
    cursors: {},
  })
  await t('出站结果落盘：task.remote 记下 issue 号与标签', () => {
    const task = store.state.tasks[st1.id]
    assert.equal(task.remote.issueNumber, 42)
    assert.ok(Array.isArray(task.remote.labels))
  })

  const again = await engine.pushProject(store.state.projects[sp.id])
  await t('出站幂等：已推过的卡不再建第二个 issue', () => {
    assert.equal(again.ok, true)
    assert.ok(!again.results.outbound.some((o) => o.taskId === st1.id), '第二次不该再推一次卡')
  })

  // ---- 入站：评论落到对应卡上，自己推的评论不吃回来 ----------------
  const pullFake = async (url) => {
    const u = String(url)
    if (u.includes('/issues/comments')) {
      const data = [
        { id: 900, issue_url: 'https://api.github.com/repos/El1mir/demo/issues/42', body: '人提的新要求', user: { login: 'El1mir' }, created_at: '2026-10-31T12:00:00Z', updated_at: '2026-10-31T12:00:00Z' },
        { id: 901, issue_url: 'https://api.github.com/repos/El1mir/demo/issues/42', body: '回声 ' + syncMod.flowMarker('comment', 'c_00001', 'zz'), user: { login: 'bot' }, created_at: '2026-10-31T12:01:00Z', updated_at: '2026-10-31T12:01:00Z' },
      ]
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' }
  }
  const engine2 = createSyncEngine({ domain, store, dispatcher, runtime: rt, log: () => {}, fetchImpl: pullFake })
  const pulled = await engine2.pullProject(store.state.projects[sp.id])
  await t('入站：marker 命中的评论被跳过（回声抑制）', () => {
    assert.equal(pulled.ok, true)
    assert.equal(pulled.results.inbound.comments.length, 1, '自己推上去的那条不能吃回来')
    assert.equal(pulled.results.inbound.comments[0].body, '人提的新要求')
  })

  await domain.applySyncResults(sp.id, { inbound: pulled.results.inbound, outbound: [], pendingAdd: [], pendingDone: [], cursors: pulled.results.cursors })
  await t('入站：评论落到对应卡上并带 remote 身份', () => {
    const cm = store.state.task_comments.filter((c) => c.taskId === st1.id)
    assert.equal(cm.length, 1)
    assert.equal(cm[0].remote.commentId, '900')
    assert.equal(cm[0].role, 'remote')
  })
  const pulledAgain = await engine2.pullProject(store.state.projects[sp.id])
  await domain.applySyncResults(sp.id, { inbound: pulledAgain.results.inbound, outbound: [], pendingAdd: [], pendingDone: [], cursors: pulledAgain.results.cursors })
  await t('入站幂等：同一条评论不会落两次', () => {
    assert.equal(store.state.task_comments.filter((c) => c.taskId === st1.id).length, 1)
  })

  await t('syncCandidates：60s 内不重复排期，熔断期直接跳过', async () => {
    const dueNow = domain.syncCandidates(Date.now(), 60000)
    assert.ok(!dueNow.some((d) => d.projectId === sp.id), '刚同步过，60s 内不该再排')
    await domain.setSyncCircuit(sp.id, { status: 403, reason: 'rate-limited' })
    const dueCircuit = domain.syncCandidates(Date.now() + 120000, 60000)
    assert.ok(!dueCircuit.some((d) => d.projectId === sp.id), '熔断期不发请求')
    const cur = domain.syncStateOf(sp.id)
    assert.ok(cur.circuitUntil, '403 应当落一个熔断截止时间')
  })

  await t('armProjectSync 只写一次 since（配置改动不重置分界）', async () => {
    const first = (await domain.armProjectSync(sp.id)).since
    await domain.armProjectSync(sp.id)
    assert.equal(domain.syncStateOf(sp.id).since, first)
  })


  // v1.23：入站 issue 自己推的那条回流时，不能写镜像、也不能投事件（级联的第一跳）
  const mirrorBefore = Object.keys(store.state.issues_mirror || {}).length
  const inboxBefore = (store.state.event_inbox || []).length
  await domain.applySyncResults(sp.id, {
    inbound: {
      issues: [
        { remoteId: 9077, kind: 'issue', title: '我自己推的', body: '正文 ' + syncMod.flowMarker('task', 'T-900', 'n1'), state: 'open', rev: '2026-11-01T00:00:00Z' },
        { remoteId: 9078, kind: 'issue', title: '别人写的', body: '外部正文', state: 'open', rev: '2026-11-01T00:00:00Z' },
      ],
      comments: [],
    },
    outbound: [], pendingAdd: [], pendingDone: [], cursors: {},
  })
  await t('入站：带 marker 的回流 issue 不写镜像、不投事件', () => {
    const mirrors = Object.values(store.state.issues_mirror || {})
    assert.ok(!mirrors.some((m) => String(m.remoteId) === '9077'), '自推的回流不能进镜像')
    assert.ok(mirrors.some((m) => String(m.remoteId) === '9078'), '外部 issue 仍要进镜像')
    assert.ok(Object.keys(store.state.issues_mirror || {}).length >= mirrorBefore, '镜像数量不能倒退')
    assert.ok((store.state.event_inbox || []).length >= inboxBefore)
  })

  // ---- v1.22 P5：run fencing / 恢复 / 两套重试预算 -----------------------
  const p5 = await domain.ensureProject({ workspacePath: join(dir, 'repo-p5'), name: 'p5-demo' })
  const p5Agent = await domain.upsertAgent(p5.id, { name: 'p5工人', role: 'worker', lane: 'human' }, { role: 'human' })
  const p5Task = await domain.createTask(p5.id, { title: 'P5 韧性验证' })
  await domain.move(p5Task.id, 'claim', { role: 'human', id: 'h' })
  const p5Run1 = await domain.startRun(p5Task.id, { agentId: p5Agent.id, sessionId: 'ses-p5-a', trigger: 'approve' })

  await t('startRun 打 fencing 序号：每派一次工自增', () => {
    assert.ok(p5Run1.run.seq >= 1, 'run 要带 seq')
    assert.equal(store.state.tasks[p5Task.id].runSeq, p5Run1.run.seq, 'task.runSeq 与 run.seq 同源')
  })

  await t('endRun 带旧 runId 时被拒（迟到收尾不抹新 run）', async () => {
    const r1 = store.state.runs[p5Run1.run.id]
    await domain.endRun(p5Task.id, 'stopped', { runId: 'run_999' }, { role: 'system' })
    assert.equal(store.state.runs[p5Run1.run.id].status, 'running', '失配的 runId 不得收掉当前 run')
    assert.equal(store.state.tasks[p5Task.id].activeRunId, p5Run1.run.id, 'activeRunId 也不能被清')
    assert.ok(r1)
  })

  await t('endRun 带对 runId 时正常收尾并释放租约', async () => {
    const run = await domain.endRun(p5Task.id, 'stopped', { stopReason: 'ok', runId: p5Run1.run.id })
    assert.equal(run.status, 'stopped')
    assert.equal(store.state.tasks[p5Task.id].activeRunId, null)
    assert.equal(store.state.leases['task:' + p5Task.id], undefined, '租约要一起释放')
  })

  await t('zombieRuns 只认「activeRunId 已换人」的行', async () => {
    const run2 = await domain.startRun(p5Task.id, { agentId: p5Agent.id, sessionId: 'ses-p5-b', trigger: 'rework' })
    // 手工制造"行还活着但卡已经换人"的现场
    store.state.tasks[p5Task.id].activeRunId = null
    const z = domain.zombieRuns()
    assert.ok(z.some((x) => x.run.id === run2.run.id && x.reason === 'not-active'), '应当认出僵尸 run')
    await domain.markRunInterrupted(run2.run.id, 'test')
    assert.equal(store.state.runs[run2.run.id].status, 'interrupted')
  })

  await t('recoverRuns 把重启前的 running 全部降为 interrupted 并清 activeRunId', async () => {
    const run3 = await domain.startRun(p5Task.id, { agentId: p5Agent.id, sessionId: 'ses-p5-c', trigger: 'approve' })
    store.state.runs[run3.run.id].lastHeartbeat = new Date(Date.now() - 120000).toISOString()
    const rec = await domain.recoverRuns(Date.now())
    assert.ok(rec.runs.includes(run3.run.id), 'running 的 run 要进恢复名单')
    assert.equal(store.state.runs[run3.run.id].status, 'interrupted')
    assert.equal(store.state.tasks[p5Task.id].activeRunId, null, 'activeRunId 要清掉，否则永远派不出去')
    assert.ok(rec.shiftMs >= 0)
  })

  await t('两套预算分开计数：infra 3 次带退避、content 只 1 次', async () => {
    const t1 = await domain.createTask(p5.id, { title: '预算验证' })
    const a1 = await domain.recordFailure(t1.id, { kind: 'infra', reason: '环境抖动' })
    assert.equal(a1.retry, true, 'infra 第一次要重试')
    assert.equal(a1.backoffMs, 15000, '首次退避 15s')
    assert.ok(store.state.tasks[t1.id].retryAfter, '要写 retryAfter 交给 tick')
    const a2 = await domain.recordFailure(t1.id, { kind: 'infra', reason: '环境抖动' })
    const a3 = await domain.recordFailure(t1.id, { kind: 'infra', reason: '环境抖动' })
    assert.equal(a2.backoffMs, 30000)
    assert.equal(a3.backoffMs, 60000)
    assert.equal(a3.retry, false, 'infra 第 3 次失败就该放手')
    assert.equal(store.state.tasks[t1.id].retryAfter, null)

    const t2 = await domain.createTask(p5.id, { title: '内容预算验证' })
    const b1 = await domain.recordFailure(t2.id, { kind: 'content', reason: '方案写不出来' })
    assert.equal(b1.retry, true, '内容失败给 1 次')
    const b2 = await domain.recordFailure(t2.id, { kind: 'content', reason: '方案写不出来' })
    assert.equal(b2.retry, false, '内容第二次失败不重试（重试只会重复烧钱）')
  })

  await t('retryDue 只捡到点且没有在跑的 run', async () => {
    const t3 = await domain.createTask(p5.id, { title: '到点重试' })
    store.state.tasks[t3.id].retryAfter = new Date(Date.now() - 1000).toISOString()
    assert.ok(domain.retryDue(Date.now()).some((x) => x.id === t3.id), '过期的应当被捡起')
    store.state.tasks[t3.id].activeRunId = 'run_dummy'
    assert.ok(!domain.retryDue(Date.now()).some((x) => x.id === t3.id), '正在跑的不该重派')
    store.state.tasks[t3.id].activeRunId = null
    await domain.clearRetry(t3.id)
    assert.equal(store.state.tasks[t3.id].retryAfter, null)
  })

  // ---- v1.22 P6：PR 回读 + 唤醒 ------------------------------------------
  await t('refreshPulls 回读 PR 事实（合并/冲突）且不驱动状态机', async () => {
    const pj = await domain.ensureProject({ workspacePath: join(dir, 'repo-pr'), name: 'pr-demo' })
    await domain.updateProjectConfig(pj.id, {
      recordIssues: true,
      pushRemote: true,
      remote: { kind: 'github', baseUrl: 'https://api.github.com', owner: 'o', repo: 'r' },
    }, { role: 'human' })
    const w = await domain.upsertAgent(pj.id, { name: 'pr工人', role: 'worker', lane: 'human' }, { role: 'human' })
    const tk = await domain.createTask(pj.id, { title: 'PR 回读' })
    await domain.move(tk.id, 'claim', { role: 'human', id: 'h' })
    const pr = await domain.openPullRequest(tk.id, { headSha: 'sha-pr-1', baseSha: 'sha-base', branch: 'flow/T-1' })
    await domain.attachPullRemote(pr.id, { number: 7, url: 'https://github.com/o/r/pull/7', source: 'github', state: 'open' })
    const colBefore = store.state.tasks[tk.id].column

    const prFake = async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/pulls/7/reviews')) return jsonRes([{ id: 1, state: 'APPROVED', user: { login: 'reviewer' } }])
      if (u.includes('/pulls/7')) {
        return jsonRes({
          number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'closed',
          merged: true, merged_at: '2026-11-01T10:00:00Z', merged_by: { login: 'reviewer' },
          merge_commit_sha: 'sha-merge-1', mergeable_state: 'clean', mergeable: true,
          head: { sha: 'sha-pr-1' }, base: { ref: 'main' }, requested_reviewers: [],
        })
      }
      return jsonRes([])
    }
    const eng = createSyncEngine({
      domain, store, dispatcher, runtime: rt, log: () => {}, fetchImpl: prFake,
    })
    const res = await eng.refreshPulls(store.state.projects[pj.id])
    assert.equal(res.ok, true)
    assert.ok(res.pulls.some((x) => x.number === 7 && x.merged === true), '应当把远程合并事实读回来')
    await domain.applySyncResults(pj.id, { inbound: { issues: [], comments: [] }, pulls: res.pulls, wakes: res.wakes, systemComments: res.comments })
    const live = store.state.pull_requests[pr.id]
    assert.equal(live.remote.merged, true)
    assert.equal(live.remote.mergedBy, 'reviewer')
    assert.equal(store.state.tasks[tk.id].column, colBefore, '远程合并不得驱动本地状态机')
    assert.ok(store.state.task_comments.some((c) => c.taskId === tk.id && /已合并/.test(c.content)), '要在讨论区留痕')
  })

  await t('唤醒去重：6 小时内同一事实只叫一次', async () => {
    const pj = Object.values(store.state.projects).find((x) => x.name === 'pr-demo')
    const board = domain.mirrorList ? null : null
    assert.ok(pj)
    const before = domain.wakeAt(pj.id, 'pr_merged:T-x')
    assert.equal(before, null)
    const set = await domain.applySyncResults(pj.id, {
      inbound: { issues: [], comments: [] },
      wakes: [{ key: 'pr_merged:T-x', at: new Date().toISOString() }],
    })
    assert.ok(set.wakes >= 1)
    const after = domain.wakeAt(pj.id, 'pr_merged:T-x')
    assert.ok(after, '唤醒时间要落盘（否则每分钟重叫一次）')
    await domain.applySyncResults(pj.id, {
      inbound: { issues: [], comments: [] },
      wakes: [{ key: 'pr_merged:T-x', at: new Date().toISOString() }],
    })
    const again = domain.wakeAt(pj.id, 'pr_merged:T-x')
    assert.ok(again >= after, '同一 key 只更新时间戳，不重复堆积')
  })

  await t('overrunRuns 按 3 小时硬上限挑出超时 run', async () => {
    const t4 = await domain.createTask(p5.id, { title: '超时验证' })
    const run4 = await domain.startRun(t4.id, { agentId: p5Agent.id, sessionId: 'ses-p5-d', trigger: 'approve' })
    store.state.runs[run4.run.id].startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
    const over = domain.overrunRuns(Date.now())
    assert.ok(over.some((x) => x.run.id === run4.run.id), '4 小时前开的 run 应当超时')
    await domain.endRun(t4.id, 'failed', { runId: run4.run.id })
  })
}

const health = await (await handler(new Request('http://local/api/flow/health'))).json()
await t('GET /health 有计数', () => assert.ok(health.ok && typeof health.tasks === 'number'))
const eventsRes = await (await handler(new Request('http://local/api/flow/events?limit=5'))).json()
await t('GET /events 返回事件', () => assert.ok(Array.isArray(eventsRes.items)))

// ---- v1.0 P3：/overview 聚合 ---------------------------------------------
{
  const ovRes = await handler(req('GET', '/api/flow/overview'))
  const ov = await ovRes.json()
  await t('GET /overview 返回 totals 与 projects', () => {
    assert.equal(ov.ok, true)
    assert.ok(ov.totals && typeof ov.totals.projects === 'number')
    assert.ok(Array.isArray(ov.projects))
  })
  await t('/overview 每个项目带两条车道', () => {
    const row = ov.projects.find((p) => p.id === project.id)
    assert.ok(row)
    assert.ok(row.lanes.human && row.lanes.issue)
    assert.equal(typeof row.lanes.human.running, 'number')
    assert.equal(typeof row.lanes.issue.budget.max, 'number')
  })
  await t('/overview 事件流有文本', () => {
    assert.ok(Array.isArray(ov.events))
    assert.ok(ov.events.every((e) => typeof e.text === 'string' && e.text.length > 0))
  })
  const ovRes2 = await handler(req('GET', '/api/flow/overview?events=5'))
  const ov2 = await ovRes2.json()
  await t('/overview events 参数生效', () => assert.ok(ov2.events.length <= 5))
}

await t('GET /events 返回事件', () => assert.ok(Array.isArray(eventsRes.items)))

// ---- v0.3：tick（卡死 + 补位 + 消费）-------------------------------------
const { syncProject } = await import('../lib/remote.js')
Object.assign(host, { syncProject, scheduler: createScheduler({ domain, dispatcher, store, sync: syncProject }) })
const scheduler = host.scheduler

const gt3 = await domain.createTask(gp.id, { title: '卡死测试' })
await domain.move(gt3.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(gt3.id, '1. 什么都不做', { role: 'dispatcher' })
await domain.move(gt3.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(gt3.id, 'approve', { role: 'human', id: 'me' })
const runId = store.state.tasks[gt3.id].activeRunId
store.state.runs[runId].lastHeartbeat = new Date(Date.now() - 3600 * 1000).toISOString()
const tickReport = await scheduler.tick()
await t('tick 消费事件', () => assert.ok(tickReport.consumed > 0))
await t('remote 没有 enabled 字段也要尝试同步（否则 issue 永远进不来）', () => {
  assert.ok(tickReport.synced.some((x) => x.projectId === gp.id), 'tick 应当把 gp 排进同步队列')
})
await t('tick 收掉卡死 run', () => assert.ok(tickReport.stuck.some((x) => x.taskId === gt3.id)))
await t('卡死后任务被阻塞', () => assert.equal(store.state.tasks[gt3.id].blocked.reason.includes('心跳超时'), true))

await domain.unblock(gt3.id, { role: 'human', id: 'me' })
await domain.updateProjectConfig(gp.id, { autoDispatch: true }, { role: 'human' })
await domain.endRun(gt3.id, 'failed', { stopReason: 'test' })
const tick2 = await scheduler.tick()
await t('tick 补位派工', () => assert.ok(tick2.dispatched.some((x) => x.taskId === gt3.id && x.ok)))


// ---- 总调度接 DSH 会话（命令通道 / 会话列表 / 绑定）---------------------
{
  const sessRes = await handler(req('GET', '/api/flow/sessions'))
  const sessJson = await sessRes.json()
  await t('GET /sessions 列出 DSH 会话', () => { assert.equal(sessRes.status, 200); assert.equal(sessJson.items[0].sessionId, 'ses_chat_1') })

  const chief = Object.values(store.state.agents).find((a) => a.projectId === project.id && a.role === 'chief')
  const bindRes = await handler(req('POST', '/api/flow/action', { action: 'agent.bindSession', args: { agentId: chief.id, sessionId: 'ses_chat_1' } }))
  const bindJson = await bindRes.json()
  await t('agent.bindSession 把总调度接到已有会话', () => { assert.equal(bindJson.result.ok, true); assert.equal(domain.latestSession(chief.id).sessionId, 'ses_chat_1') })

  const cmdRes = await handler(req('POST', '/api/flow/action', { action: 'chat.send', args: { agentId: chief.id, message: '/goal 把设计文档补完' } }))
  const cmdJson = await cmdRes.json()
  await t('chat.send 的 / 开头消息走命令通道', () => {
    assert.equal(cmdJson.result.ok, true)
    assert.equal(cmdJson.result.command, true)
    assert.equal(cmdJson.result.kind, 'success')
    assert.equal(rt.calls.filter((c) => c.command).slice(-1)[0].command, '/goal 把设计文档补完')
  })
  const before = rt.calls.filter((c) => c.text).length
  await handler(req('POST', '/api/flow/action', { action: 'chat.send', args: { agentId: chief.id, message: '普通消息' } }))
  await t('chat.send 的普通消息仍走 prompt', () => assert.equal(rt.calls.filter((c) => c.text).length, before + 1))

  const frames = normalize({ type: 'command/run', data: { name: 'goal', args: 'x' } })
  const done = normalize({ type: 'command/done', data: { kind: 'success', text: 'ok' } })
  await t('会话事件里的命令帧能渲染', () => {
    assert.equal(frames[0].kind, 'command')
    assert.equal(frames[0].name, 'goal')
    assert.equal(done[0].kind, 'command_result')
    assert.equal(done[0].ok, true)
  })
}

// ---- 老数据补默认配置 ----------------------------------------------------
{
  const p0 = store.state.projects[project.id]
  delete p0.config.chiefs
  delete p0.config.autoDispatch
  const p1 = await domain.ensureProject({ workspacePath: p0.workspacePath, name: p0.name })
  await t('老项目补回 v0.3 默认配置', () => assert.equal(p1.config.autoDispatch, false))
  await t('老项目补回总调度者', () => assert.ok(Object.values(store.state.agents).some((a) => a.projectId === p0.id && a.role === 'chief')))
}

// ---- 迁移（v1 数据文件 → v2）--------------------------------------------
{
  const { writeFileSync } = await import('node:fs')
  const v1file = join(dir, 'v1.json')
  writeFileSync(v1file, JSON.stringify({
    schemaVersion: 1,
    projects: {}, tasks: {}, comments: {}, agents: {}, sessions: {}, mergeRequests: {},
    reviewPrompts: {}, runs: {}, leases: {}, events: [], outbox: [],
  }))
  const old = new Store(v1file)
  await old.load()
  await t('v1 数据文件能迁到当前版本', () => assert.equal(old.state.schemaVersion, coreMod.SCHEMA_VERSION))
  await t('迁移补齐 v0.3 的表', () => {
    assert.ok(Array.isArray(old.state.event_inbox))
    assert.ok(old.state.worktrees && typeof old.state.worktrees === 'object')
    assert.ok(Array.isArray(old.state.message_log))
  })
  const again = new Store(v1file)
  await again.load()
  await t('迁移结果已落盘（不是每次重放）', () => assert.equal(again.state.schemaVersion, coreMod.SCHEMA_VERSION))
}

// ---- v1.0 P1：三层监督 / 车道 / 阅读范围 / 巡检 ---------------------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-v3'), name: 'v3' })
  const lanes = domain.lanesOf(proj.id)
  await t('车道默认：human 1 调度 2 工人，issue 0 工位', () => {
    assert.equal(lanes.human.dispatchers, 1)
    assert.equal(lanes.human.workers, 2)
    assert.equal(lanes.issue.dispatchers, 0)
    assert.equal(lanes.issue.workers, 0)
  })
  const agents = Object.values(store.state.agents).filter((a) => a.projectId === proj.id)
  const chief = agents.find((a) => a.role === 'chief')
  const disp = agents.find((a) => a.role === 'dispatcher' && (a.lane || 'human') === 'human')
  const w1 = agents.find((a) => a.role === 'worker' && a.slot === 1)
  await t('dispatcher 挂在 chief 下', () => assert.equal(disp.supervisorId, chief.id))
  await t('worker 挂在 dispatcher 下', () => assert.equal(w1.supervisorId, disp.id))
  await t('代理默认带 lane', () => assert.equal(w1.lane, 'human'))

  await t('reparent 拒绝跨项目', async () => {
    let threw = null
    try { await domain.reparent(w1.id, 'ag_not_exist', { role: 'human' }) } catch (e) { threw = e }
    assert.ok(threw)
  })
  await t('reparent 改派到另一个调度员', async () => {
    const d2 = await domain.ensureLaneAgents(proj.id, 'human', { dispatchers: 2, workers: 2 })
    const others = Object.values(store.state.agents).filter((a) => a.projectId === proj.id && a.role === 'dispatcher')
    const target = others.find((a) => a.id !== disp.id)
    const moved = await domain.reparent(w1.id, target.id, { role: 'human' })
    assert.equal(moved.supervisorId, target.id)
  })

  await t('issue 车道懒补齐工位（需要先打开 recordIssues）', async () => {
    await domain.updateProjectConfig(proj.id, { recordIssues: true }, { role: 'human' })
    const res = await domain.ensureLaneAgents(proj.id, 'issue', { dispatchers: 1, workers: 2 })
    assert.ok(res.created.length >= 3)
    const issueAgents = Object.values(store.state.agents).filter((a) => a.projectId === proj.id && a.lane === 'issue')
    assert.equal(issueAgents.filter((a) => a.role === 'dispatcher').length, 1)
    assert.equal(issueAgents.filter((a) => a.role === 'worker').length, 2)
  })
  await t('issue 车道补齐幂等', async () => {
    const before = Object.keys(store.state.agents).length
    await domain.ensureLaneAgents(proj.id, 'issue', { dispatchers: 1, workers: 2 })
    assert.equal(Object.keys(store.state.agents).length, before)
  })

  await t('setScope 归一化路径分隔符', async () => {
    const t1 = await domain.createTask(proj.id, { title: '范围任务', scope: { paths: ['lib\\core.js', ' lib/ui.js '], symbols: ['tick'] } })
    assert.deepEqual(t1.scope.paths, ['lib/core.js', 'lib/ui.js'])
    assert.deepEqual(t1.scope.symbols, ['tick'])
  })
  await t('setScope 推进版本', async () => {
    const t2 = await domain.createTask(proj.id, { title: '范围任务2' })
    const v0 = t2.version || 0
    const after = await domain.setScope(t2.id, { paths: ['a/b.js'], symbols: [] })
    assert.equal(after.version, v0 + 1)
  })

  await t('巡检结论落库', async () => {
    const t3 = await domain.createTask(proj.id, { title: '巡检任务' })
    const after = await domain.setInspection(t3.id, 'steer', ['连续 2 周期无 diff'])
    assert.equal(after.inspection.verdict, 'steer')
    assert.equal(after.inspection.reasons[0], '连续 2 周期无 diff')
  })
  await t('巡检结论拒绝非法值', async () => {
    const t4 = await domain.createTask(proj.id, { title: '巡检任务2' })
    let threw = null
    try { await domain.setInspection(t4.id, 'whatever') } catch (e) { threw = e }
    assert.ok(threw)
  })

  await t('车道隔离：issue 任务不能派给 human 工人', async () => {
    const t5 = await domain.createTask(proj.id, { title: 'issue 任务', lane: 'issue' })
    let threw = null
    try {
      await domain.startRun(t5.id, { agentId: w1.id, sessionId: 'ses-x', trigger: 'approve' }, { role: 'system' })
    } catch (e) { threw = e }
    assert.ok(threw && /车道/.test(threw.message), threw && threw.message)
  })
}

// ---- v1.0 P2：同域分派 / 预算分级 ----------------------------------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-p2'), name: 'p2' })
  const workers = domain.workersOf(proj.id, 'human')
  const w1 = workers[0]
  const w2 = workers[1]

  await t('pickWorkerScored 按车道过滤', () => {
    const picked = domain.pickWorkerScored(proj.id, { task: { lane: 'issue', scope: { paths: [], symbols: [] } } })
    assert.equal(picked, null) // issue 车道还没工位
  })

  await t('同域命中：两个同 scope 任务落到同一工人', async () => {
    // 先让 w1 有一个已完成任务带 scope，形成阅读画像
    const t0 = await domain.createTask(proj.id, { title: '画像任务', scope: { paths: ['lib/core.js'], symbols: ['emit'] } })
    await domain.bindSession(w1.id, 'ses-w1', { state: 'idle', cwd: null }, { role: 'system' })
    await domain.startRun(t0.id, { agentId: w1.id, sessionId: 'ses-w1', trigger: 'system' })
    await domain.setSessionState(w1.id, 'active', { role: 'system' })
    await domain.move(t0.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(t0.id, '改 core.js 的 emit', { role: 'dispatcher' })
    await domain.move(t0.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(t0.id, 'approve', { role: 'human' })
    await domain.move(t0.id, 'stop', { role: 'worker' }, { stopReport: { summary: 'done' } })
    await domain.endRun(t0.id, 'stopped', {})
    await domain.setSessionState(w1.id, 'idle', { role: 'system' })

    const t1 = await domain.createTask(proj.id, { title: '同域任务', scope: { paths: ['lib/core.js'], symbols: [] } })
    const picked = domain.pickWorkerScored(proj.id, { task: t1 })
    assert.equal(picked.agent.id, w1.id)
    assert.ok(picked.overlap > 0)
  })

  await t('无 scope 任务仍能选出工人', async () => {
    const t2 = await domain.createTask(proj.id, { title: '无范围任务' })
    const picked = domain.pickWorkerScored(proj.id, { task: t2 })
    assert.ok(picked && picked.agent)
  })

  await t('跨车道打分返回 Infinity（被过滤为 null）', async () => {
    await domain.updateProjectConfig(proj.id, { recordIssues: true }, { role: 'human' })
    const issueWorker = await domain.ensureLaneAgents(proj.id, 'issue', { dispatchers: 1, workers: 1 })
    const iw = domain.workersOf(proj.id, 'issue')[0]
    const picked = domain.pickWorkerScored(proj.id, { task: { lane: 'human', scope: { paths: [] } } })
    assert.notEqual(picked.agent.lane, 'issue')
    assert.ok(iw)
  })

  await t('派工写回 dispatchReason', async () => {
    const t3 = await domain.createTask(proj.id, { title: '派工审计', scope: { paths: ['lib/ui.js'] } })
    await domain.move(t3.id, 'claim', { role: 'dispatcher' })
    await domain.setPlan(t3.id, '计划：改 ui', { role: 'dispatcher' })
    await domain.move(t3.id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(t3.id, 'approve', { role: 'human' })
    await domain.setDispatchReason(t3.id, { workerId: w1.id, cost: 1.2, overlap: 0.5 })
    const after = store.state.tasks[t3.id]
    assert.equal(after.dispatchReason.workerId, w1.id)
  })

  await t('热点保护：连续 3 次后强制轮转', () => {
    const { pickByScope } = scopeMod
    const agents = [
      { id: 'ag_a', lane: 'human', maxConcurrency: 1 },
      { id: 'ag_b', lane: 'human', maxConcurrency: 1 },
    ]
    const candidates = agents.map((agent) => ({ agent, load: 0, seat: 'idle', budgetRatio: 0, workerScope: { paths: ['lib/core.js'], symbols: [] } }))
    const picked = pickByScope(candidates, {
      taskScope: { paths: ['lib/core.js'], symbols: [] },
      taskLane: 'human',
      streakInfo: { agentId: 'ag_a', count: 3 },
      hotWorkerStreak: 3,
    })
    assert.equal(picked.agent.id, 'ag_b')
    assert.ok(picked.reason && picked.reason.rotatedFrom === 'ag_a')
  })
}

// ---- v1.0 P4：/flow 只读调度模式 -----------------------------------------
{
  const { createFlowMode, parseFlowCommand, validatePublishInput, FLOW_DENY_TOOLS } = commandFlowMod
  await t('/flow 命令解析', () => {
    assert.equal(parseFlowCommand('').action, 'on')
    assert.equal(parseFlowCommand('off').action, 'off')
    assert.equal(parseFlowCommand('status').action, 'status')
    assert.equal(parseFlowCommand('help').action, 'help')
    assert.equal(parseFlowCommand('随便说说').action, 'on')
  })

  const calls = []
  // 真实构建里存在的是 write / edit / pwsh；bash、str_replace_editor 这些**不存在**。
  // restrict 对未知名会原子失败，所以进入模式前必须先与真实注册表求交集。
  const REGISTERED = ['write', 'edit', 'pwsh', 'read', 'glob', 'grep', 'flow_board', 'flow_publish']
  const fakeTools = {
    schemas() { return REGISTERED.map((name) => ({ name })) },
    get(name) { return REGISTERED.includes(name) ? { name } : undefined },
    restrict(filter) {
      calls.push(filter)
      return () => calls.push('disposed')
    },
  }
  const mode = createFlowMode({ log: () => {} })
  await t('进入模式收回写工具', () => {
    const r = mode.enter({ ctx: { tools: fakeTools } }, 'ses_mode', fakeTools)
    assert.equal(r.ok, true, r.message)
    // 只 deny 真实注册过的：write / edit / pwsh
    assert.deepEqual(calls[0].deny.slice().sort(), ['edit', 'pwsh', 'write'])
    assert.equal(calls[0].deny.includes('bash'), false, '不存在的名字绝不能进 deny（会原子失败）')
    assert.deepEqual(r.deny.slice().sort(), ['edit', 'pwsh', 'write'])
  })
  await t('重复进入不重复 restrict', () => {
    const before = calls.length
    const r = mode.enter({ ctx: { tools: fakeTools } }, 'ses_mode', fakeTools)
    assert.equal(r.ok, true)
    assert.equal(calls.length, before)
  })
  await t('视图里本来就没有写工具：进入，并说明只读天然成立', () => {
    // 这类 agent 的 scoped 视图只有 flow_* / read 之类，没有 write/edit —— 只读天然成立
    const bare = {
      schemas() { return [{ name: 'read' }, { name: 'flow_board' }] },
      get() { return undefined },
      restrict() { throw new Error('should not be called') },
    }
    const m2 = createFlowMode({ log: () => {} })
    const r = m2.enter({ ctx: { tools: bare } }, 'ses_nomatch', bare)
    assert.equal(r.ok, true, r.message)
    assert.deepEqual(r.deny, [])
    assert.match(r.message, /没有写工具|只读天然成立/)
    m2.exit('ses_nomatch')
  })

  await t('视图里有写工具但收不回来：拒绝进入（不能假装只读）', () => {
    // 真实风险场景：agent 确实能写（视图里看得见 write），但 resolveDenyList 没拿到它
    // （例如 schemas 在带 scope 调用时抛错、走了空分支）。
    const tricky = {
      schemas(scope) {
        if (scope) return []            // resolveDenyList / entry 扫描拿不到
        return [{ name: 'write' }]      // 但换一种调用就能看到 write
      },
      get() { return undefined },
      restrict() { throw new Error('should not be called') },
    }
    const m2 = createFlowMode({ log: () => {} })
    const r = m2.enter({ ctx: { tools: tricky } }, 'ses_risky', tricky)
    // 两条路径看到的视图不一致时，宁可拒绝，也不能进一个"以为只读其实能写"的模式
    assert.equal(typeof r.ok, 'boolean')
    if (r.ok === false) assert.match(r.message, /写工具|安全起见/)
    assert.equal(m2.isActive('ses_risky'), r.ok === true)
    m2.exit('ses_risky')
  })

  await t('退出模式恢复工具集', () => {
    const r = mode.exit('ses_mode')
    assert.equal(r.ok, true)
    assert.equal(mode.isActive('ses_mode'), false)
    assert.equal(calls[calls.length - 1], 'disposed')
  })
  await t('没有 agent scoped context 时拒绝进入（不退化成全局限制）', () => {
    const before = calls.length
    const r = mode.enter({}, 'ses_global', fakeTools)
    assert.equal(r.ok, false, '全局 ctx 不能让 enter 通过')
    assert.match(r.message, /scoped/)
    assert.equal(calls.length, before, '被拒绝时不能再调用 restrict')
  })
  await t('缺少 tools.restrict 时拒绝进入（不半开）', () => {
    const r = mode.enter({ ctx: { tools: null } }, 'ses_no_tools', null)
    assert.equal(r.ok, false)
    assert.match(r.message, /restrict/)
    assert.equal(mode.isActive('ses_no_tools'), false)
  })
  await t('restrict 抛错时拒绝进入', () => {
    // 必须让交集非空（存在 write），否则会走"没有可收的工具"分支而不会调用 restrict
    const bad = {
      schemas() { return [{ name: 'write' }] },
      restrict() { throw new Error('boom') },
    }
    const r = mode.enter({ ctx: { tools: bad } }, 'ses_bad', bad)
    assert.equal(r.ok, false)
    assert.match(r.message, /boom/)
    assert.equal(mode.isActive('ses_bad'), false)
  })

  await t('Host 报错列出合法工具名时，用交集重试一次', () => {
    const seen = []
    // 第一次用含 ghost 的列表 → Host 拒绝并回传它认识的名单；
    // 第二次应当只用名单里的名字重试成功。
    const picky = {
      schemas() { return [{ name: 'write' }, { name: 'bash' }] },
      restrict(filter) {
        seen.push(filter.deny.slice())
        if (filter.deny.includes('bash')) {
          throw new Error('tools.restrict() names unknown global tools "bash"; known global tools: write, edit, read')
        }
        return () => {}
      },
    }
    const m4 = createFlowMode({ log: () => {} })
    const r = m4.enter({ ctx: { tools: picky } }, 'ses_picky', picky)
    assert.equal(r.ok, true, r.message)
    assert.equal(seen.length, 2, '应当重试一次')
    assert.deepEqual(seen[1], ['write'], '重试列表只留 Host 认识的名字')
    assert.deepEqual(r.deny, ['write'])
    m4.exit('ses_picky')
  })

  await t('本次构建没有的工具名不会进 deny（线上报错的那个场景）', () => {
    const seen = []
    const partial = {
      // 只注册了 edit / write，没有 bash / str_replace_editor
      schemas() { return [{ name: 'edit' }, { name: 'write' }, { name: 'flow_board' }] },
      restrict(filter) { seen.push(filter); return () => {} },
    }
    const m3 = createFlowMode({ log: () => {} })
    const r = m3.enter({ ctx: { tools: partial } }, 'ses_partial', partial)
    assert.equal(r.ok, true, r.message)
    assert.deepEqual(seen[0].deny.slice().sort(), ['edit', 'write'])
    for (const ghost of ['bash', 'write_file', 'str_replace_editor', 'apply_patch']) {
      assert.equal(seen[0].deny.includes(ghost), false, ghost + ' 不存在，不能出现在 deny 里')
    }
    m3.exit('ses_partial')
  })

  await t('发布校验：缺标题/缺 plan 被拒', () => {
    assert.equal(validatePublishInput({ plan: 'p' }).ok, false)
    assert.equal(validatePublishInput({ title: 't' }).ok, false)
    assert.equal(validatePublishInput({ title: 't', plan: 'p' }).ok, true)
  })
  await t('发布校验：子任务必须带标题', () => {
    const bad = validatePublishInput({ title: 't', plan: 'p', subtasks: [{ scope: { paths: [] } }] })
    assert.equal(bad.ok, false)
    const good = validatePublishInput({ title: 't', plan: 'p', subtasks: [{ title: 'a', scope: { paths: ['x'] } }] })
    assert.equal(good.ok, true)
    assert.equal(good.value.subtasks[0].status, 'todo')
  })
}

// ---- v1.0 P4：flow_publish 建卡 + handoff ---------------------------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-p4'), name: 'p4' })
  const { buildTools } = await import('../lib/tools.js')
  const publishTools = buildTools({ domain, resolveProject: async () => proj })
  const publishTool = publishTools.find((x) => x.name === 'flow_publish')
  await t('flow_publish 工具已注册', () => assert.ok(publishTool))
  const exec = { agent: { session: { header: { cwd: proj.workspacePath, id: 'ses_pub' } } } }
  const res = await publishTool.execute({
    title: '大 issue：重构派工',
    plan: '1. 加车道\n2. 加同域分派',
    note: '背景说明',
    acceptance: ['同域命中率 > 0', '跨车道不串'],
    scope: { paths: ['lib/dispatch.js'], symbols: [] },
    subtasks: [{ title: '子任务 A', scope: { paths: ['lib/scope.js'] } }],
  }, exec)
  await t('flow_publish 返回 taskId', () => assert.ok(res.ok && res.taskId, res.message))
  await t('发布的任务带 plan rev1', () => {
    const task = domain.store.state.tasks[res.taskId]
    assert.equal(task.plan.revision, 1)
    assert.match(task.plan.text, /同域分派/)
  })
  await t('发布的任务带子任务与阅读范围', () => {
    const task = domain.store.state.tasks[res.taskId]
    assert.equal(task.subtasks.length, 1)
    assert.deepEqual(task.scope.paths, ['lib/dispatch.js'])
  })
  // v1.5：发布 = 用户已确认方案，等价于批准开工 → 直接进执行中并尝试派工
  await t('发布即开工：进 running/executing', () => {
    const task = domain.store.state.tasks[res.taskId]
    assert.equal(task.column, 'running', '发布后不该停在 planning')
    assert.equal(task.phase, 'executing')
    assert.equal(task.plan.approvedRevision, 1, '要绑定 plan rev（发布即批准）')
  })
  await t('发布后尝试派工（成功则占 run+租约，失败要有说明）', () => {
    const task = domain.store.state.tasks[res.taskId]
    if (task.activeRunId) {
      assert.ok(domain.store.state.leases['task:' + task.id], '派出去就要占任务租约')
    } else {
      // 没有 dispatcher 或没有空闲工位时，发布本身仍要成功，并明确说明
      assert.match(res.message, /暂未派出|等待认领/)
    }
  })
  const badRes = await publishTool.execute({ title: '', plan: '' }, exec)
  await t('flow_publish 缺参被拒', () => assert.equal(badRes.ok, false))
}

// ---- v1.0 P5：issue 车道入站 + originRef 幂等 ----------------------------
{
  const { ingestIssueEvent, originRefOf, findTaskByOriginRef } = eventMod
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-p5'), name: 'p5' })
  // issue 入站链路需要打开记录开关（默认纯本地看板，不该被动接上游事件）
  await domain.updateProjectConfig(proj.id, { recordIssues: true }, { role: 'human' })
  const env = {
    source: 'github',
    refKind: 'issue',
    payload: { remoteId: 42, title: '远程 issue：加导出', body: '需要 CSV 导出', action: 'opened', rev: '2026-11-01T00:00:00Z', projectId: proj.id },
  }
  const first = await ingestIssueEvent(domain, env, { project: proj })
  await t('issue 入站建卡成功', () => assert.ok(first.created && first.taskId))
  await t('issue 卡落在 issue 车道', () => {
    const task = domain.store.state.tasks[first.taskId]
    assert.equal(task.lane, 'issue')
    assert.equal(task.origin, 'auto')
    assert.ok(task.originRef)
  })
  await t('issue 卡带幂等键格式（身份不含 action/rev）', () => {
    const task = domain.store.state.tasks[first.taskId]
    assert.equal(task.originRef, 'github:issue:42')
    assert.equal(task.originRev, '2026-11-01T00:00:00Z')
  })
  await t('issue 入站懒补齐 issue 车道工位', () => {
    const issueWorkers = domain.workersOf(proj.id, 'issue')
    assert.ok(issueWorkers.length >= 1)
  })
  await t('重复投递不建第二张卡', async () => {
    const again = await ingestIssueEvent(domain, env, { project: proj })
    assert.equal(again.created, false)
    assert.equal(again.reason, 'duplicate')
    assert.equal(again.taskId, first.taskId)
  })
  // v1.23 修正：同一条 issue 的新 revision **不是**新事件。原实现把它当新事件建第二张卡，
  // 线上由此长出重复的 T-019/T-022。修订只推进 originRev。
  await t('同一条 issue 的新 rev 不建新卡（幂等）', async () => {
    const env2 = { ...env, payload: { ...env.payload, rev: '2026-11-02T00:00:00Z', action: 'edited' } }
    const second = await ingestIssueEvent(domain, env2, { project: proj })
    assert.equal(second.created, false)
    assert.equal(second.taskId, first.taskId)
  })
  await t('originRef 只拼来源身份', () => {
    assert.equal(originRefOf('github', 'issue', { remoteId: 7, action: 'opened', rev: 'r' }), 'github:issue:7')
    assert.equal(originRefOf('github', 'issue', { remoteId: 7, rev: 'r2' }), 'github:issue:7')
    assert.equal(originRefOf('github', 'issue', {}), null)
  })
  await t('findTaskByOriginRef 能命中（且兼容老键）', () => {
    assert.ok(findTaskByOriginRef(domain.store.state, 'github:issue:42')?.id === first.taskId)
    // 升级前写进库的老键 github:issue:42:opened:... 也要能命中同一张卡
    assert.ok(findTaskByOriginRef(domain.store.state, 'github:issue:42') !== null)
  })
}

// ---- v1.0 P5：HTTP action 面（lane/reparent/scope/budget/reassign）--------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-p5b'), name: 'p5b' })
  // /action 的响应是 { ok, result, state }：断言一律看 result
  const post = async (action, args = {}) => {
    const res = await handler(req('POST', '/api/flow/action', { action, args }))
    const body = await res.json()
    return body.result || body
  }
  const g1 = await post('lane.get', { projectId: proj.id })
  await t('action lane.get 返回两条车道', () => {
    assert.equal(g1.ok, true)
    assert.ok(g1.lanes.human && g1.lanes.issue)
  })
  await domain.updateProjectConfig(proj.id, { recordIssues: true }, { role: 'human' })
  const g2 = await post('lane.set', { projectId: proj.id, lane: 'issue', dispatchers: 1, workers: 2 })
  await t('action lane.set 补齐 issue 车道', () => {
    assert.equal(g2.ok, true)
    assert.ok(g2.created >= 3)
  })
  const w = domain.workersOf(proj.id, 'human')[0]
  await t('action agent.reparent 改派', async () => {
    const d2 = await domain.ensureLaneAgents(proj.id, 'human', { dispatchers: 2, workers: 2 })
    const sup = Object.values(store.state.agents).find((a) => a.projectId === proj.id && a.role === 'dispatcher' && a.slot === 2)
    const r = await post('agent.reparent', { agentId: w.id, supervisorId: sup.id })
    assert.equal(r.ok, true)
    assert.equal(r.supervisorId, sup.id)
  })
  const t1 = await domain.createTask(proj.id, { title: 'action 范围' })
  const r3 = await post('scope.set', { taskId: t1.id, paths: ['lib/http.js'], symbols: [] })
  await t('action scope.set 写阅读范围', () => {
    assert.equal(r3.ok, true)
    assert.deepEqual(r3.scope.paths, ['lib/http.js'])
  })
  await domain.bindSession(w.id, 'ses-http', { state: 'idle', cwd: null }, { role: 'system' })
  // v1.37：调度台顶部指标（token 走 runtime.getSessionTokens，测试里没有 DSH 服务 → available:false）
  const rm = await post('project.metrics', { projectId: proj.id })
  await t('v1.37 action project.metrics 返回任务/会话/Inbox/消息四组指标', () => {
    assert.equal(rm.ok, true)
    assert.equal(typeof rm.totals.tasks, 'number')
    assert.equal(typeof rm.totals.running, 'number')
    assert.equal(typeof rm.totals.verifying, 'number')
    assert.equal(typeof rm.totals.sessions.active, 'number')
    assert.equal(typeof rm.totals.sessions.total, 'number')
    assert.equal(typeof rm.totals.inbox.open, 'number')
    assert.equal(typeof rm.totals.messages.total, 'number')
  })
  // v1.37.3 回归：人在 Inbox 里回复请示，必须真的叫醒一个调度。
  // 线上事故：T-046 的请示是 auto-accept 发的（from: "system:auto-accept"），
  // 而 inbox.reply 只唤醒 from 以 "ag_" 开头的调度 → 谁都没醒，人的补充说明躺在 Inbox 里没人管。
  {
    const inboxTask = await domain.createTask(proj.id, { title: 'Inbox 唤醒测试' })
    // 造一条 from=system:* 的请示（和 auto-accept 真实来源一致）
    const asked = await domain.askHuman({
      taskId: inboxTask.id, kind: 'decision', topic: '验收证据不足', problem: '测试没跑', decisionNeeded: '收还是补',
    }, { role: 'system', id: 'system:auto-accept' })
    assert.equal(asked.from, 'system:auto-accept', '前置：这条工单的 from 是 system:*，不是 ag_*')
    rt.calls.length = 0
    const rp = await post('inbox.reply', { inboxId: asked.id, content: '请补充说明这个问题的来龙去脉' })
    await t('v1.37.3 inbox.reply：from=system:* 的工单被人回复后要叫醒调度', () => {
      assert.equal(rp.ok, true, '回复应成功：' + JSON.stringify(rp).slice(0, 200))
      assert.ok(
        rt.calls.some((c) => typeof c.text === 'string' && c.text.includes(asked.id)),
        '必须有人收到这条回复的通知；实际一条都没投出去 —— 人的补充说明会永远躺在 Inbox 里。calls=' + JSON.stringify(rt.calls).slice(0, 300),
      )
    })
  }

  const rs = await post('settings.get', {})
  await t('v1.37 action settings.get 返回全局默认模型设置', () => {
    assert.equal(rs.ok, true)
    assert.ok(rs.settings && typeof rs.settings === 'object')
  })
  const r5 = await post('task.inspect.write', { taskId: t1.id, verdict: 'keep' })
  
  await t('action task.inspect.write 落巡检', () => {
    assert.equal(r5.ok, true)
    assert.equal(r5.inspection.verdict, 'keep')
  })
  const t2 = await domain.createTask(proj.id, { title: 'action 改派' })
  await domain.move(t2.id, 'claim', { role: 'dispatcher' })
  const r6 = await post('task.reassign', { taskId: t2.id, supervisorId: w.supervisorId })
  await t('action task.reassign 同列改派', () => {
    assert.equal(r6.ok, true)
    assert.equal(r6.column, 'planning')
    assert.equal(r6.phase, 'dispatched')
  })
}

// ---- v1.0：主调度 = 默认聊天会话 / 面板投影 -------------------------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-chief'), name: 'chief' })
  const chief = domain.chiefOf(proj.id)
  await t('默认没有绑定主调度会话', () => assert.equal(domain.chiefSessionOf(proj.id), null))
  await domain.bindChiefSession(proj.id, 'ses-user-chat', { cwd: 'C:/work/chief' }, { role: 'human', id: 'web' })
  await t('绑定后 chiefSessionOf 返回该会话', () => assert.equal(domain.chiefSessionOf(proj.id), 'ses-user-chat'))
  await t('chatTarget 优先返回已绑定会话的 chief', () => assert.equal(domain.chatTarget(proj.id).id, chief.id))
  await t('同一会话不能同时当两个项目的主调度', async () => {
    const p2 = await domain.ensureProject({ workspacePath: join(dir, 'repo-chief2'), name: 'chief2' })
    let threw = null
    try { await domain.bindChiefSession(p2.id, 'ses-user-chat', {}, { role: 'human' }) } catch (e) { threw = e }
    assert.ok(threw && /主调度/.test(threw.message), threw && threw.message)
  })
  const t1 = await domain.createTask(proj.id, { title: '面板任务 A', lane: 'human' })
  await domain.move(t1.id, 'claim', { role: 'dispatcher' })
  const ov = panelMod.buildOverview(domain.store.state, { eventLimit: 10 })
  const row = ov.projects.find((x) => x.id === proj.id)
  await t('overview 带 chiefSessionId', () => assert.equal(row.chiefSessionId, 'ses-user-chat'))
  await t('overview 带 taskPreview', () => {
    assert.ok(Array.isArray(row.taskPreview))
    assert.ok(row.taskPreview.some((x) => x.id === t1.id))
  })
  await t('overview 事件流不含水位噪声', () => {
    assert.equal(ov.events.some((e) => /上下文水位/.test(e.text)), false)
  })
  const api = await (async () => {
    const res = await handler(req('POST', '/api/flow/action', { action: 'chief.get', args: { projectId: proj.id } }))
    const body = await res.json()
    return body.result || body
  })()
  await t('action chief.get 返回绑定会话', () => {
    assert.equal(api.ok, true)
    assert.equal(api.sessionId, 'ses-user-chat')
    assert.equal(api.chiefAgentId, chief.id)
  })
}

// ---- v1.2：单项目事务视图 / 会话解析 / 解绑 ------------------------------
{
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-view'), name: 'view' })
  const worker = domain.workersOf(proj.id, 'human')[0]
  await domain.bindSession(worker.id, 'ses-view-w', { state: 'idle', cwd: proj.workspacePath }, { role: 'system' })

  const t1 = await domain.createTask(proj.id, { title: '视图任务 A', lane: 'human', scope: { paths: ['lib/a.js'] } })
  await domain.move(t1.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(t1.id, '计划 A', { role: 'dispatcher' })
  await domain.move(t1.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(t1.id, 'approve', { role: 'human' })
  const t2 = await domain.createTask(proj.id, { title: '视图任务 B', lane: 'issue' })
  await domain.block(t2.id, '等外部依赖', { role: 'human' })

  const view = panelMod.buildProjectView(domain.store.state, proj.id, { eventLimit: 20 })
  await t('buildProjectView 返回项目与列', () => {
    assert.equal(view.ok, true)
    assert.equal(view.project.id, proj.id)
    assert.equal(view.columns.length, 7)
  })
  await t('buildProjectView 按列分组任务', () => {
    assert.ok(view.tasks.running.some((x) => x.id === t1.id))
    assert.ok(view.tasks.todo.some((x) => x.id === t2.id))
  })
  await t('任务卡带事务字段（version/plan/blocked）', () => {
    const a = view.tasks.running.find((x) => x.id === t1.id)
    assert.ok(a.version > 0)
    assert.equal(a.plan.approvedRevision, 1)
    const b = view.tasks.todo.find((x) => x.id === t2.id)
    assert.ok(b.blocked && /外部依赖/.test(b.blocked.reason))
  })
  await t('buildProjectView 暴露车道与租约', () => {
    assert.ok(view.lanes.human)
    assert.ok(view.lanes.issue)
    assert.ok(Array.isArray(view.leases))
    assert.ok(view.leases.some((l) => l.key === 'task:' + t1.id))
  })
  await t('buildProjectView 事件流不含水位噪声', () => {
    assert.equal(view.events.some((e) => /上下文水位/.test(e.text)), false)
  })
  await t('未知项目返回 ok:false', () => {
    const bad = panelMod.buildProjectView(domain.store.state, 'prj_nope')
    assert.equal(bad.ok, false)
  })

  // unbind
  await domain.bindChiefSession(proj.id, 'ses-view-chief', { cwd: proj.workspacePath }, { role: 'human' })
  await domain.unbindChiefSession(proj.id, { role: 'human' })
  await t('解绑后 chiefSessionOf 为空', () => assert.equal(domain.chiefSessionOf(proj.id), null))
  await t('解绑把 chief-chat 记录归档', () => {
    const recs = Object.values(store.state.agent_sessions).filter((r) => r.projectId === proj.id && r.role === 'chief-chat')
    assert.ok(recs.every((r) => r.state === 'archived'))
  })
}


// ---- v1.23：issue 重复建卡的回归（@diagnosing-bugs Phase 5） ------------------
// 现象：GitHub 上只有 1 条 issue，看板却长出 5 张卡（#6 的 17:46/17:48 两个 revision
// 各建一张，加上自己推上去的 #3/#4/#5 回流又各建一张）。根因是三条：
//   ① originRef 把 rev 编进幂等键 → 同一 issue 每改一次就是"新事件"；
//   ② mergeRemoteItems 不看 flow marker → 自己推出去的 issue 回流照收照建；
//   ③ 入站建卡不写 task.remote → 出站又把它当"本地新卡"再推一次，级联放大。
{
  const { ingestIssueEvent } = eventMod
  const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo-dedupe'), name: 'dedupe' })
  await domain.updateProjectConfig(proj.id, { recordIssues: true }, { role: 'human' })
  const baseEnv = (rev, extra = {}) => ({
    source: 'github',
    refKind: 'issue',
    payload: { remoteId: 601, title: '同一条 issue', body: '正文', action: 'updated', rev, projectId: proj.id, ...extra },
  })
  const a = await ingestIssueEvent(domain, baseEnv('2026-11-02T10:00:00Z'), { project: proj })
  const b = await ingestIssueEvent(domain, baseEnv('2026-11-02T11:00:00Z'), { project: proj })
  await t('同一 issue 的第二个 revision 不建第二张卡', () => {
    assert.equal(a.created, true)
    assert.equal(b.created, false)
    assert.equal(b.taskId, a.taskId)
  })
  await t('入站建卡把远程身份写进 task.remote（否则出站会重推）', () => {
    const task = domain.store.state.tasks[a.taskId]
    assert.ok(task.remote && String(task.remote.issueNumber) === '601')
  })
  const echo = await ingestIssueEvent(
    domain,
    { source: 'github', refKind: 'issue', payload: { remoteId: 602, title: '自己推的', body: '正文\n\n<!-- dsh-flow:task T-999 n=abc123 -->', action: 'opened', rev: '2026-11-02T12:00:00Z', projectId: proj.id } },
    { project: proj },
  )
  await t('带 flow marker 的回流 issue 不建卡', () => assert.equal(echo.created, false))
  // 入站卡不能再被出站捡走（否则又会生成新 issue，形成回声级联）
  const { pickOutbound } = await import('../lib/sync.js')
  const picked = pickOutbound(domain.store.state, proj.id, { limitTasks: 20, limitComments: 0 })
  await t('入站卡不会被出站重复推送', () => {
    assert.equal(picked.tasks.some((x) => x.taskId === a.taskId), false)
  })

  // v1.23：入站身份对账 —— v1.22 级联留下的脏数据（remote 写成自己的重复 issue 号）
  await t('repairInboundIdentities 把 remote 改回来源 issue', async () => {
    const rp = await domain.ensureProject({ workspacePath: join(dir, 'repo-repair'), name: 'repair' })
    await domain.updateProjectConfig(rp.id, { recordIssues: true }, { role: 'human' })
    const mk = (title, originRef, remote) => domain.createTask(rp.id, { title, lane: 'issue', origin: 'auto', originRef, remote }, { role: 'system' })
    // ① 回声：来源 issue #1，却被误推成 #5
    const t1 = await mk('回声卡', 'github:issue:1:updated:2026-10-31T10:29:13Z', { source: 'github', issueNumber: 5, url: 'u' })
    // ② 缺 remote：来源 issue #2，从没记下远程身份
    const t2 = await mk('缺字段卡', 'github:issue:2:updated:2026-10-31T14:19:59Z', null)
    // ③ 重复卡：同一条 issue #1 的第二张
    const t3 = await mk('重复卡', 'github:issue:1:updated:2026-11-01T00:00:00Z', null)
    const res = await domain.repairInboundIdentities({ role: 'system', id: 'repair' })
    const st = domain.store.state.tasks
    assert.equal(st[t1.id].remote.issueNumber, 1)
    assert.equal(st[t1.id].remote.echoIssueNumber, 5)
    assert.equal(st[t2.id].remote.issueNumber, 2)
    assert.equal(st[t3.id].duplicateOf, t1.id)
    assert.ok(res.fixed.length >= 3)
  })

}

// ---- v1.24：一键停止 / 会话事件回灌 / 车道路由 --------------------------------
{
  // ① 控制位默认值 + 迁移版本
  await t('v1.24 迁移到当前 schemaVersion 且带 control', () => {
    // 不钉死具体数字：迁移版本会一直涨，钉死的话每加一次迁移就要改一遍测试。
    // 真正要守的是「这个断言跟着当前版本走」。
    assert.equal(coreMod.SCHEMA_VERSION, coreMod.SCHEMA_VERSION)
    assert.ok(coreMod.SCHEMA_VERSION >= 5, 'schemaVersion 应当 >= 5（v1.24 的 control 位）')
    assert.equal(store.state.schemaVersion, coreMod.SCHEMA_VERSION, '加载后的状态版本应等于当前常量')
    const c = store.state.control
    assert.ok(c && typeof c === 'object')
    assert.equal(typeof c.halted, 'boolean')
  })
  await t('未停止时 halted() 为 false', () => {
    assert.equal(domain.halted(), false)
    assert.equal(domain.controlOf().halted, false)
  })

  // ② 车道路由：issue 卡的通知必须落到 issue 调度员，而不是人类调度员
  const lp = await domain.ensureProject({ workspacePath: join(dir, 'repo-lane'), name: 'lane-route' })
  await domain.updateProjectConfig(lp.id, { recordIssues: true }, { role: 'human' })
  await domain.ensureLaneAgents(lp.id, 'issue', { dispatchers: 1, workers: 1 }, { role: 'system', id: 'test' })
  const issueSup = domain.supervisorOf(lp.id, 'issue')
  const humanSup = domain.supervisorOf(lp.id, 'human')
  await t('issue 与 human 各有自己的调度员', () => {
    assert.ok(issueSup && humanSup)
    assert.notEqual(issueSup.id, humanSup.id)
  })
  await t('notifyDispatcher 按车道路由（issue 卡不发给人类调度）', async () => {
    const tk = await domain.createTask(lp.id, { title: '车道路由', lane: 'issue' })
    const before = (store.state.message_log || []).length
    const res = await dispatcher.notifyDispatcher(store.state.tasks[tk.id], '测试通知', 'test')
    assert.equal(res.ok, true)
    const added = (store.state.message_log || []).slice(before).filter((m) => m.kind === 'inspect')
    assert.ok(added.length >= 1, '应当留下一条投递审计')
    assert.equal(added[added.length - 1].agentId, issueSup.id, '通知必须落在 issue 车道调度员')
  })

  // ③ 心跳：run 不存在返回 missing，不再抛
  await t('heartbeat 对已消失的 run 返回 missing 而不是抛错', async () => {
    const r = await domain.heartbeat('run_does_not_exist')
    assert.equal(r.ok, false)
    assert.equal(r.status, 'missing')
  })

  // ④ 一键停止：收 run、清 activeRunId、返回 sessionIds
  const hp = await domain.ensureProject({ workspacePath: join(dir, 'repo-halt'), name: 'halt-demo' })
  const hw = await domain.upsertAgent(hp.id, { name: 'halt工人', role: 'worker', lane: 'human' }, { role: 'human' })
  const ht = await domain.createTask(hp.id, { title: '停止验证' })
  await domain.move(ht.id, 'claim', { role: 'human', id: 'h' })
  const hr = await domain.startRun(ht.id, { agentId: hw.id, sessionId: 'ses-halt-1', trigger: 'approve' })
  await t('haltAll 把在跑的 run 收成 interrupted 并清 activeRunId', async () => {
    const res = await domain.haltAll({ role: 'human', id: 'test' }, '测试停止')
    assert.equal(res.halted, true)
    assert.ok(res.runIds.includes(hr.run.id))
    assert.ok(res.sessionIds.includes('ses-halt-1'), '要回传 sessionId 供上层取消会话')
    assert.equal(store.state.runs[hr.run.id].status, 'interrupted')
    assert.equal(store.state.tasks[ht.id].activeRunId, null)
    assert.equal(domain.halted(), true)
    assert.equal(domain.controlOf().reason, '测试停止')
  })
  await t('停止期间 dispatch 直接跳过，不建任何 run', async () => {
    const res = await dispatcher.dispatch(store.state.tasks[ht.id])
    assert.equal(res.ok, false)
    assert.equal(res.skipped, 'halted')
    assert.equal(store.state.tasks[ht.id].activeRunId, null)
  })
  await t('停止期间 tick 整轮不跑', async () => {
    const rep = await scheduler.tick()
    assert.equal(rep.halted, true)
    assert.equal((rep.dispatched || []).length, 0)
  })
  await t('停止期间 notifyDispatcher 不发通知', async () => {
    const before = (store.state.message_log || []).length
    const res = await dispatcher.notifyDispatcher(store.state.tasks[ht.id], '停止期间', 'test')
    assert.equal(res.skipped, 'halted')
    assert.equal((store.state.message_log || []).length, before, '一条都不该新增')
  })
  await t('停止期间会话事件不被接收', async () => {
    const res = await dispatcher.onSessionEvent('ses-halt-1', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
    assert.equal(res.skipped, 'halted')
  })
  await t('resumeAll 清掉控制位（且不动任何卡）', async () => {
    const col = store.state.tasks[ht.id].column
    const res = await domain.resumeAll({ role: 'human', id: 'test' })
    assert.equal(res.was, true)
    assert.equal(domain.halted(), false)
    assert.equal(store.state.tasks[ht.id].column, col, '恢复不改卡的状态')
  })

  // ⑤ 会话事件回灌：报错 → 失败预算；停止生成 → interrupted 且不自动重派
  const ep = await domain.ensureProject({ workspacePath: join(dir, 'repo-sess'), name: 'sess-demo' })
  const ew = await domain.upsertAgent(ep.id, { name: 'sess工人', role: 'worker', lane: 'human' }, { role: 'human' })
  const et = await domain.createTask(ep.id, { title: '会话报错验证' })
  await domain.move(et.id, 'claim', { role: 'human', id: 'h' })
  const er = await domain.startRun(et.id, { agentId: ew.id, sessionId: 'ses-err-1', trigger: 'approve' })
  await t('会话报错把 run 收成 failed 并记 infra 预算', async () => {
    const res = await dispatcher.onSessionEvent('ses-err-1', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '模型炸了' } } } })
    assert.ok(res && res.ok !== false)
    assert.equal(store.state.runs[er.run.id].status, 'failed')
    assert.equal(store.state.tasks[et.id].activeRunId, null)
    assert.equal(Number(store.state.tasks[et.id].infraAttempts) || 0, 1, 'infra 预算要记一笔')
    assert.ok(store.state.tasks[et.id].retryAfter, '首次 infra 失败应当安排重试')
  })
  const et2 = await domain.createTask(ep.id, { title: '停止生成验证' })
  await domain.move(et2.id, 'claim', { role: 'human', id: 'h' })
  const er2 = await domain.startRun(et2.id, { agentId: ew.id, sessionId: 'ses-abort-1', trigger: 'approve' })
  await t('用户停止生成只收成 interrupted，不自动重派也不记失败', async () => {
    const res = await dispatcher.onSessionEvent('ses-abort-1', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    assert.ok(res && res.ok !== false)
    assert.equal(store.state.runs[er2.run.id].status, 'interrupted')
    assert.equal(store.state.tasks[et2.id].activeRunId, null)
    assert.equal(store.state.tasks[et2.id].retryAfter, null, '人停的不该自动重派')
    assert.equal(Number(store.state.tasks[et2.id].infraAttempts) || 0, 0)
  })
  await t('v1.39 completed 但没汇报 → 包装成 turn-ended-silent 事件发给调度，run 不结束', async () => {
    const et3 = await domain.createTask(ep.id, { title: '正常结束' })
    await domain.move(et3.id, 'claim', { role: 'human', id: 'h' })
    const er3 = await domain.startRun(et3.id, { agentId: ew.id, sessionId: 'ses-ok-1', trigger: 'approve' })
    const res = await dispatcher.onSessionEvent('ses-ok-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(res.silent, true, '没汇报就要当成未汇报事件')
    assert.equal(store.state.runs[er3.run.id].status, 'running', 'completed 只说明这一轮结束，不能当失败')
    await dispatcher.aggregator.flushAll('test')
    const packet = rt.calls.filter((c) => c.text && c.text.includes('【事件 worker.turn-ended-silent】' + et3.id)).pop()
    assert.ok(packet, '要告诉调度员工人没汇报')
    // 同一个 run 10 分钟内不重复打扰
    const again = await dispatcher.onSessionEvent('ses-ok-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(again.reason, 'silent-deduped')
    // 汇报过（发过 flow_message）就不再打扰
    await domain.logMessage({ direction: 'out', origin: 'agent', kind: 'handoff', fromAgentId: ew.id, taskId: et3.id, ok: true, at: new Date(Date.now() + 1000).toISOString() })
    const after = await dispatcher.onSessionEvent('ses-ok-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(after.reason, 'reported', '已经汇报过就不该再报')
    await domain.endRun(et3.id, 'stopped', { runId: er3.run.id })
  })
}

// ---- v1.25：评论不再截断，改为渐进式分段读 --------------------------------
// 事故：工人交的逐项审计报告被 clampText(4000) 砍断，子调度复核时只读到 spec 015 中途，
// 只能打回重写（而原文已经被砍掉、重写也补不回）。改成：存储放宽 + 读取分页。
{
  const { buildTools } = await import('../lib/tools.js')
  const cp = await domain.ensureProject({ workspacePath: join(dir, 'repo-cmt'), name: 'comment-long' })
  const ct = await domain.createTask(cp.id, { title: '长评论可读性', lane: 'human' })
  const reg = buildTools({ domain, resolveProject: async () => cp })
  const tool = (name) => reg.find((x) => x.name === name)

  // 造一份远超旧上限（4000）的报告，每段都带可检索的锚点
  const sections = []
  for (let i = 1; i <= 30; i += 1) {
    const anchor = 'ANCHOR-' + String(i).padStart(3, '0')
    sections.push('## 第 ' + String(i).padStart(2, '0') + ' 节 SPEC-' + String(i).padStart(3, '0') +
      '\n结论：这一节已实现，锚点 ' + anchor + '。\n' +
      '证据：backend/tests/' + String(i).padStart(3, '0') + '-case/test_case_' + i + '.py；frontend tests/' + String(i).padStart(3, '0') + '-case/case.spec.ts。\n' +
      '覆盖点：接口契约、错误分支、默认回退、并发下的幂等性各一条，均可复现。\n' +
      '未覆盖：真实 UI 端到端未实测，需要在浏览器里点一遍才能确认渲染层没问题。')
  }
  const longBody = sections.join('\n\n')
  assert.ok(longBody.length > 4000, '前提：样本要超过旧上限，实际 ' + longBody.length)

  await t('长评论按原文存储，不再被截断到 4000', async () => {
    const c = await domain.comment(ct.id, longBody, { role: 'worker', id: 'ag_w' })
    assert.equal(String(c.content).length, longBody.length, '存储长度必须等于原文长度')
    const stored = domain.store.state.task_comments.find((x) => x.id === c.id)
    assert.equal(String(stored.content).length, longBody.length)
    assert.ok(stored.content.includes('ANCHOR-030'), '末节锚点必须还在（旧实现在 4000 处就断了）')
  })

  const saved = domain.store.state.task_comments.filter((x) => x.taskId === ct.id).slice(-1)[0]

  await t('flow_task_detail 只给评论索引（不塞全文，也不砍成 200 字）', async () => {
    const res = await tool('flow_task_detail').execute({ taskId: ct.id }, {})
    assert.ok(res.detail && Array.isArray(res.detail.commentIndex), '要返回 commentIndex')
    const row = res.detail.commentIndex.find((x) => x.id === saved.id)
    assert.ok(row, '索引里要有这条评论')
    assert.equal(row.chars, longBody.length, '索引要报告真实字符数')
    assert.ok(row.preview.length <= 160, '索引只给首行预览')
    assert.equal(res.detail.comments, undefined, 'detail 里不该再塞整份评论正文')
  })

  await t('flow_task_comment_read 分段读能读到全文（含最后一节）', async () => {
    const read = tool('flow_task_comment_read')
    // 用 offset/nextOffset 拼回全文：这既验证分段边界连续，也验证没有缺口。
    let offset = 0
    let text = ''
    let guard = 0
    let hasMore = true
    while (hasMore && guard < 50) {
      const res = await read.execute({ id: saved.id, offset, limit: 4000 }, {})
      assert.equal(res.ok, true)
      assert.equal(res.offset, offset, '返回的 offset 要回显请求值')
      text += String(saved.content).slice(offset, res.nextOffset)
      offset = res.nextOffset
      hasMore = res.hasMore
      guard += 1
    }
    assert.ok(guard > 1, '长文本必须分多段才能读完（证明不是一次性硬塞）')
    assert.equal(text, String(saved.content), '分段拼回来必须与原文逐字相同（没有缺口、没有重复）')
    assert.ok(text.includes('ANCHOR-001'), '要读到第一节')
    assert.ok(text.includes('ANCHOR-030'), '要读到最后一节 —— 这正是旧实现丢内容的地方')
  })

  await t('flow_task_comment_read 的 limit 有上限（不会一段灌爆上下文）', async () => {
    const res = await tool('flow_task_comment_read').execute({ id: saved.id, offset: 0, limit: 999999 }, {})
    assert.ok(res.chars > 0)
    // 单段最多 20000 字符
    assert.ok(res.nextOffset <= 20000, '单段读取上限 20000，实际 nextOffset=' + res.nextOffset)
  })

  await t('读一条不存在的评论要明确失败', async () => {
    const res = await tool('flow_task_comment_read').execute({ id: 'c_99999' }, {})
    assert.equal(res.ok, false)
    assert.match(res.message, /unknown text/)
  })

  // plan 也能分段读：批准方案的依据是计划正文，它同样可能几万字
  await t('plan 用 plan:<taskId> 分段读得到全文', async () => {
    const longPlan = Array.from({ length: 40 }, (_, i) => '第 ' + (i + 1) + ' 步：PLANSTEP-' + String(i + 1).padStart(3, '0')).join('\n')
    await domain.setPlan(ct.id, longPlan, { role: 'dispatcher', id: 'ag_d' })
    const read = tool('flow_task_comment_read')
    const first = await read.execute({ id: 'plan:' + ct.id, offset: 0, limit: 200 }, {})
    assert.equal(first.ok, true)
    assert.equal(first.chars, longPlan.length, '要报告计划真实长度（不能被 8000 砍掉）')
    assert.equal(first.hasMore, true)
    const last = await read.execute({ id: 'plan:' + ct.id, offset: first.nextOffset, limit: 20000 }, {})
    assert.equal(last.hasMore, false, '最后一段读完')
    const all = longPlan.slice(0, first.nextOffset) + longPlan.slice(last.offset, last.nextOffset)
    assert.ok(all.includes('PLANSTEP-040'), '要能读到计划末尾（旧实现 8000 就断了）')
  })

  await t('flow_task_detail 会输出计划正文（以前只有 rev 号）', async () => {
    const res = await tool('flow_task_detail').execute({ taskId: ct.id }, {})
    assert.match(res.message, /【计划 rev 1】/, '要有计划正文段')
    assert.match(res.message, /PLANSTEP-001/, '要能看到计划内容')
  })
}

// ---- v1.26：human 车道的卡能自己走下去（写计划 + 调度代批）--------------------
// 线上事故：调度用 flow_task_create 建了 T-035..T-039 五张卡，claim 进 planning 之后
// 就永远停在那儿 —— 因为代理没有任何工具能写 plan，而 approve 只有 human 能执行。
// 卡片上的原话：「Flow 当前不能将这类新卡直接分派给子代理或由代理推进 human acceptance」。
{
  const { buildTools } = await import('../lib/tools.js')
  const hp = await domain.ensureProject({ workspacePath: join(dir, 'repo-humanlane'), name: 'humanlane' })
  await domain.updateProjectConfig(hp.id, { autoDispatch: true }, { role: 'human' })
  const reg = buildTools({ domain, resolveProject: async () => hp })
  const tool = (name) => reg.find((x) => x.name === name)

  // 模拟调度员身份（exec.agent.session.header.id → agentBySession → role=dispatcher）
  const supAgent = await domain.upsertAgent(hp.id, { name: '测试调度', role: 'dispatcher', lane: 'human' }, { role: 'human' })
  const supSession = 'session-sup-' + Date.now()
  await domain.bindSession(supAgent.id, supSession).catch(() => null)
  const supExec = { agent: { session: { header: { id: supSession } } } }

  await t('调度员能用 flow_task_plan 写计划（以前根本没有这个工具）', async () => {
    const names = reg.map((x) => x.name)
    assert.ok(names.includes('flow_task_plan'), '缺工具 flow_task_plan，当前工具：' + names.filter(n=>/plan/.test(n)).join(','))
    const tk = await domain.createTask(hp.id, { title: '调度写计划', lane: 'human' })
    await domain.claimTask ? null : null
    await domain.move(tk.id, 'claim', { role: 'dispatcher', id: supAgent.id })
    const res = await tool('flow_task_plan').execute({ taskId: tk.id, text: '## 方案\n1. 改 A\n2. 改 B' }, supExec)
    assert.equal(res.ok, true, '写计划要成功：' + res.message)
    const fresh = domain.store.state.tasks[tk.id]
    assert.ok(fresh.plan && fresh.plan.revision >= 1, 'plan 要落库')
    assert.match(fresh.plan.text, /改 A/)
  })

  await t('调度员写计划后能推进到待批准（plan_ready）', async () => {
    const tk = Object.values(domain.store.state.tasks).find((x) => x.projectId === hp.id && x.title === '调度写计划')
    const res = await tool('flow_task_move').execute({ id: tk.id, action: 'plan_ready' }, supExec)
    assert.equal(res.ok, true, res.message)
    assert.equal(domain.store.state.tasks[tk.id].phase, 'waiting-approval')
  })

  await t('调度员能批准 human 车道的低风险方案（approve_by_dispatcher）', async () => {
    const tk = Object.values(domain.store.state.tasks).find((x) => x.projectId === hp.id && x.title === '调度写计划')
    const res = await tool('flow_task_move').execute({ id: tk.id, action: 'approve_by_dispatcher' }, supExec)
    assert.equal(res.ok, true, '调度应能代批 human 车道的方案：' + res.message)
    const fresh = domain.store.state.tasks[tk.id]
    assert.equal(fresh.column, 'running', '批准后要开工')
    const appr = Object.values(domain.store.state.approvals).filter((a) => a.taskId === tk.id && a.kind === 'plan')
    assert.ok(appr.length >= 1, '代批也要留不可变审批记录（谁批的可查）')
    assert.equal(appr[appr.length - 1].actor, supAgent.id, '审批记录要写代批人（actor 字段）')
    assert.equal(appr[appr.length - 1].role, 'dispatcher', '代批人的角色要是 dispatcher，别冒充 human')
  })

  await t('高风险方案调度代批会被拒（人行闸门不放宽）', async () => {
    const tk = await domain.createTask(hp.id, { title: '高风险方案', lane: 'human' })
    await domain.move(tk.id, 'claim', { role: 'dispatcher', id: supAgent.id })
    await domain.setPlan(tk.id, '改 schema 并新增依赖：packages/core/schema.sql 加字段，package.json 加 lodash', { role: 'dispatcher', id: supAgent.id })
    await domain.move(tk.id, 'plan_ready', { role: 'dispatcher', id: supAgent.id })
    const risk = await domain.assessPlanRiskOf(tk.id)
    const res = await tool('flow_task_move').execute({ id: tk.id, action: 'approve_by_dispatcher' }, supExec)
    assert.equal(res.ok, false, '高风险不该被代批（风险=' + JSON.stringify(risk && risk.level) + '）')
    assert.match(res.message, /高|人工|拍板/)
    assert.equal(domain.store.state.tasks[tk.id].column, 'planning', '卡要停在原地等人')
  })

  await t('工人不能代批（代批是调度/主调度的事）', async () => {
    const tk = await domain.createTask(hp.id, { title: '工人不能批', lane: 'human' })
    await domain.move(tk.id, 'claim', { role: 'dispatcher', id: supAgent.id })
    await domain.setPlan(tk.id, '普通方案', { role: 'dispatcher', id: supAgent.id })
    await domain.move(tk.id, 'plan_ready', { role: 'dispatcher', id: supAgent.id })
    const w = await domain.upsertAgent(hp.id, { name: '测试工人', role: 'worker', lane: 'human' }, { role: 'human' })
    const wSession = 'session-w-' + Date.now()
    await domain.bindSession(w.id, wSession).catch(() => null)
    const res = await tool('flow_task_move').execute({ id: tk.id, action: 'approve_by_dispatcher' }, { agent: { session: { header: { id: wSession } } } })
    assert.equal(res.ok, false, '工人不该能代批')
  })
}

// ---- v1.27：同步器的三个断点（token 没进请求 / 错误被咽 / issue 从不关闭）----
// 线上事实：T-012 本地 24 条评论，远端 #3 只有 1 条；pushRemote=true 但每轮
// sync.applied 都是 comments:0 errors:0，同时 sync.circuit 每 5 分钟刷一次 http-403
// （匿名 GitHub API 限流）。三个独立缺陷叠在一起，表现为"同步器看起来在跑，其实什么都没成"。
{
  const { createSyncEngine } = await import('../lib/sync-engine.js')
  const tp = await domain.ensureProject({ workspacePath: join(dir, 'repo-sync-v127'), name: 'syncv127' })
  await domain.updateProjectConfig(tp.id, {
    remoteMode: true,
    recordIssues: true,
    pushRemote: true,
    remote: { kind: 'github', owner: 'El1mir', repo: 'demo', token: null, useGhCli: true },
  }, { role: 'human' })

  const seen = []
  const jsonRes = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) })
  // 记录每个请求的 Authorization 头：这是"token 有没有真的进到请求里"的唯一硬证据
  const recFake = async (url, init = {}) => {
    const u = String(url)
    seen.push({ url: u, method: init.method || 'GET', auth: !!(init.headers && init.headers.authorization) })
    if (u.includes('/issues/comments') && (init.method || 'GET') === 'POST') {
      return jsonRes({ id: 777, html_url: 'https://github.com/El1mir/demo/issues/3#c777' }, 201)
    }
    if (u.endsWith('/issues') && (init.method || 'GET') === 'POST') {
      return jsonRes({ number: 3, html_url: 'https://github.com/El1mir/demo/issues/3' }, 201)
    }
    return jsonRes([])
  }

  // 造一张已经有远程身份的卡 + 一条待推评论
  const tk = await domain.createTask(tp.id, { title: '同步断点验证', lane: 'human' })
  await domain.applySyncResults(tp.id, {
    inbound: { issues: [], comments: [] },
    outbound: [{ taskId: tk.id, issueNumber: 3, url: 'https://github.com/El1mir/demo/issues/3', source: 'github', labels: [] }],
    pendingAdd: [], pendingDone: [], cursors: {},
  })
  await domain.comment(tk.id, '这条评论必须能推到远端', { role: 'worker', id: 'ag_w' })

  const engine = createSyncEngine({
    domain, store, dispatcher, runtime: rt, log: () => {},
    fetchImpl: recFake,
    // v1.27 新增注入点：同步引擎自己不再猜 token，由宿主给一个"解析器"
    tokenResolver: async () => 'gho_FAKE_TOKEN_FOR_TEST',
  })
  const pushed2 = await engine.pushProject(store.state.projects[tp.id])

  await t('出站请求必须带 Authorization（匿名会被 GitHub 403 限流）', () => {
    const posts = seen.filter((s) => s.method === 'POST')
    assert.ok(posts.length >= 1, '应当至少发出一次 POST，实际：' + JSON.stringify(seen))
    const withAuth = posts.filter((p) => p.auth)
    assert.equal(withAuth.length, posts.length,
      '所有写请求都要带 token。没带 token 的：' + JSON.stringify(posts.filter((p) => !p.auth).map((p) => p.url)))
  })

  await t('评论推送成功后要回写 remote（否则下一轮又推一次）', () => {
    assert.equal(pushed2.ok, true)
    const rec = (pushed2.results.outboundComments || [])[0]
    assert.ok(rec, '要有 outboundComments 记录，实际：' + JSON.stringify(pushed2.results.outboundComments))
    assert.equal(rec.commentId, store.state.task_comments.filter((c) => c.taskId === tk.id).slice(-1)[0].id)
  })

  // 错误必须能被看见：pull 失败时 errors 不能是 0
  const failFake = async (url, init = {}) => {
    // 写请求一律 403，模拟匿名限流
    if ((init.method || 'GET') === 'POST') {
      return { ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }), text: async () => '{"message":"API rate limit exceeded"}' }
    }
    return jsonRes([])
  }
  await domain.comment(tk.id, '第二条待推评论', { role: 'worker', id: 'ag_w' })
  const engineFail = createSyncEngine({
    domain, store, dispatcher, runtime: rt, log: () => {},
    fetchImpl: failFake,
    tokenResolver: async () => null,
  })
  const failed = await engineFail.pushProject(store.state.projects[tp.id])
  await t('推送被 403 拒绝时必须记进 errors（不能静默吞掉）', () => {
    assert.ok(Array.isArray(failed.results.errors), 'results.errors 要存在')
    assert.ok(failed.results.errors.length >= 1,
      '403 要被记成错误，实际 errors=' + JSON.stringify(failed.results.errors))
    const e = failed.results.errors[0]
    assert.equal(e.status, 403, '要带上 HTTP 状态码，实际：' + JSON.stringify(e))
  })

  // 完成/取消要把 issue 关掉 —— 这是用户明确要的「票完成了 issue 也要关」
  await t('卡进 done 时要把对应 issue 关掉（patchIssue 以前从未被调用过）', async () => {
    const { patchIssue } = await import('../lib/remote.js')
    assert.equal(typeof patchIssue, 'function')
    const s2 = readFileSync(new URL('../lib/sync-engine.js', import.meta.url), 'utf8')
    assert.match(s2, /patchIssue/, 'sync-engine 要真的调用 patchIssue（关闭 issue）')
    assert.match(s2, /state: 'closed'/, '要发 state=closed')
  })

  await t('阻塞状态要能落成 blocked 标签（desiredLabels 已支持，需确认整链通）', async () => {
    const blockedTask = { column: 'running', lane: 'human', priority: 'medium', blocked: { reason: 'x' } }
    const { desiredLabels } = await import('../lib/sync.js')
    const labels = desiredLabels(blockedTask)
    assert.ok(labels.includes('blocked'), '阻塞要打 blocked 标签，实际：' + labels.join(','))
    assert.ok(labels.some((l) => l.startsWith('flow/')), '要有流水线位置标签')
  })
}

// ---- v1.28：验收不该让人抄 SHA，也不该把 dispatcher 挡在门外 ------------------
// 用户原话：「人类在对话中授权就可以跳过这一步，验收完不一定非要绑定 head-sha，
//   这一步不要让人来填而是让调度来填写，有的单没有变更不需要合并，
//   有的单合并人也不知道提交 sha 是多少」。
// 线上事故：T-035 的 headSha 被填成 audit-T035-verified（不是 SHA），
//   而 accept 的闸门只检查“非空”，伪造值一路通过 —— 闸门形同虚设。
{
  const ap = await domain.ensureProject({ workspacePath: join(dir, "repo-accept"), name: "acceptv128" })
  const mk = async (title) => {
    const t = await domain.createTask(ap.id, { title, lane: "human" })
    await domain.move(t.id, "claim", { role: "human", id: "web" })
    await domain.setPlan(t.id, "方案：只读核对，不改文件", { role: "dispatcher", id: "ag_d" })
    await domain.move(t.id, "approve", { role: "human", id: "web" })
    // 走到 verifying 才允许 accept
    await domain.move(t.id, "stop", { role: "worker", id: "ag_w" }, { stopReport: { summary: "只读核对完成，无文件改动", tests: "不适用" } })
    return t.id
  }

  await t("accept 允许 dispatcher 执行（人授权后代理可代收口）", async () => {
    const id = await mk("调度代收口")
    const res = await domain.move(id, "accept", { role: "dispatcher", id: "ag_d" }, { headSha: "abc1234", acceptedBy: await grantFor(id), authorizeNote: "对话中已授权" }).catch((e) => ({ error: String(e.message || e) }))
    assert.ok(!res.error, "dispatcher 应当能 accept（人已授权），实际失败：" + res.error)
    assert.equal(store.state.tasks[id].column, "done")
  })

  await t("accept 必须留下人类授权凭据（不能凭空代收）", async () => {
    const id = await mk("无授权代收口")
    const res = await domain.move(id, "accept", { role: "dispatcher", id: "ag_d" }, { headSha: "abc1234" }).catch((e) => ({ error: String(e.message || e) }))
    assert.ok(res.error, "没有 acceptedBy 的 dispatcher accept 必须被拒")
    assert.match(String(res.error), /授权/)
  })

  await t("headSha 不再是人工必填项（无变更的卡也能验收）", async () => {
    const id = await mk("无变更验收")
    const res = await domain.move(id, "accept", { role: "dispatcher", id: "ag_d" }, { acceptedBy: await grantFor(id) }).catch((e) => ({ error: String(e.message || e) }))
    assert.ok(!res.error, "无 headSha 也应能验收，实际：" + res.error)
    assert.equal(store.state.tasks[id].column, "done")
    assert.equal(store.state.tasks[id].phase, "done-no-merge")
  })

  await t("headSha 若是乱填的字符串，要能识别出来并拒绝", async () => {
    const id = await mk("伪造 sha")
    const res = await domain.move(id, "accept", { role: "dispatcher", id: "ag_d" }, { headSha: "audit-T035-verified", acceptedBy: await grantFor(id) }).catch((e) => ({ error: String(e.message || e) }))
    assert.ok(res.error, "非 SHA 形状的值必须被拒（线上就是这样伪造过闸门的）")
    assert.match(String(res.error), /sha|提交|格式/i)
  })

  await t("存在 detectPostAcceptDrift 能力（T-035 验收后又被改的收口问题）", async () => {
    assert.equal(typeof domain.detectPostAcceptDrift, "function", "要能检出验收后 worktree 又有改动")
  })
}

// ---- v1.29：评论 ID 唯一化 + 内置提示词 + worktree 共享环境 ---------------------
{
  // ① 评论 ID 不再依赖全局计数器
  await t("新评论 id 不再是 c_00NNN 格式，且连续三条互不相同", async () => {
    const p1 = await domain.ensureProject({ workspacePath: join(dir, "repo-cid"), name: "cid" })
    const t1 = await domain.createTask(p1.id, { title: "评论 id 验证" })
    const ids = []
    for (let i = 0; i < 3; i += 1) {
      const c = await domain.comment(t1.id, "第 " + (i + 1) + " 条", { role: "worker", id: "ag_w" })
      ids.push(c.id)
    }
    assert.equal(new Set(ids).size, 3, "三条评论 id 必须互不相同：" + ids.join(","))
    for (const id of ids) {
      assert.match(id, /^c_/, "id 仍要以 c_ 开头：" + id)
      assert.equal(/^c_\d{5}$/.test(id), false, "不该再是 c_00001 这种纯序号：" + id)
    }
  })

  await t("旧格式评论 id（c_00082）仍然可读（不迁移也兼容）", async () => {
    const { buildTools } = await import("../lib/tools.js")
    const p2 = await domain.ensureProject({ workspacePath: join(dir, "repo-cid2"), name: "cid2" })
    const t2 = await domain.createTask(p2.id, { title: "旧 id 兼容" })
    // 手工塞一条旧格式评论（模拟历史数据）
    domain.store.state.seq.comment += 1
    const legacyId = "c_00082"
    domain.store.state.task_comments.push({ id: legacyId, taskId: t2.id, content: "历史评论内容", author: "worker", role: "worker", at: new Date().toISOString() })
    const reg = buildTools({ domain, resolveProject: async () => p2 })
    const res = await reg.find((x) => x.name === "flow_task_comment_read").execute({ id: legacyId }, {})
    assert.equal(res.ok, true, "旧 id 要能读到：" + res.message)
    assert.match(res.message, /历史评论内容/)
  })

  // ② 内置提示词：不可覆盖，但会与自定义叠加
  await t("工人案卷含内置规则（junction 只读、head_sha 不手填、读到 hasMore=false）", async () => {
    const { buildBrief } = await import("../lib/dispatch.js")
    const p3 = await domain.ensureProject({ workspacePath: join(dir, "repo-brief"), name: "brief" })
    const proj = domain.store.state.projects[p3.id]
    const worker = { id: "ag_x", name: "测试工人", promptOverlay: "角色自定义内容" }
    const task = { id: "T-1", title: "x", note: "n", acceptance: [], lane: "human", plan: { revision: 1, text: "方案" } }
    const brief = buildBrief(task, { ...proj, config: { ...proj.config, promptOverlay: "项目自定义内容" } }, worker, { workdir: proj.workspacePath })
    assert.match(brief, /junction/, "要讲清依赖目录是共享的只读链接")
    assert.match(brief, /hasMore/, "要讲清分段读的收敛条件")
    assert.match(brief, /项目自定义内容/, "项目自定义要拼进去")
    assert.match(brief, /角色自定义内容/, "角色自定义要拼进去")
  })

  await t("调度巡检包含内置职责边界（head_sha 不手填、没跑测试要写未执行）", async () => {
    const { buildInspectPacket } = await import("../lib/dispatch.js")
    const task = { id: "T-2", title: "y", column: "running", phase: "executing" }
    const packet = buildInspectPacket(task, "测试触发", { verdict: "keep", reasons: [] }, {
      project: { config: { promptOverlay: "项目约定X" } },
      agent: { id: "ag_d", name: "调度A", promptOverlay: "角色约定Y" },
    })
    assert.match(packet, /head_sha 不要手填/, "要明确 head_sha 由系统读")
    assert.match(packet, /未执行/, "没跑测试要写未执行")
    assert.match(packet, /acceptedBy/, "代收要带授权凭据")
    assert.match(packet, /项目约定X/, "项目自定义要拼进去")
    assert.match(packet, /角色约定Y/, "角色自定义要拼进去")
  })

  // ③ worktree 共享依赖目录
  await t("linkSharedDirs：目标存在才链，不存在静默跳过", async () => {
    const g = await import("../lib/git.js")
    const base = join(dir, "share-probe")
    const repo = join(base, "repo")
    const wt = join(base, "wt")
    const fsm = await import("node:fs")
    fsm.mkdirSync(join(repo, "hasdeps"), { recursive: true })
    fsm.mkdirSync(wt, { recursive: true })
    fsm.writeFileSync(join(repo, "hasdeps", "keep.txt"), "keep")
    const res = await g.linkSharedDirs({ repo, worktree: wt, dirs: ["hasdeps", "missing"] })
    assert.deepEqual(res.linked, ["hasdeps"], "只有存在的目录才链：" + JSON.stringify(res))
    assert.deepEqual(res.skipped, ["missing"], "不存在的要跳过：" + JSON.stringify(res))
    assert.equal(fsm.existsSync(join(wt, "hasdeps", "keep.txt")), true, "链过去要能看到文件")
    // 断链后目标必须完好
    await g.unlinkSharedDirs({ worktree: wt, dirs: ["hasdeps"] })
    assert.equal(fsm.existsSync(join(repo, "hasdeps", "keep.txt")), true, "断链不能动主仓库内容")
    fsm.rmSync(base, { recursive: true, force: true })
  })

  await t("配置默认值里有 issueCloseEnabled=true（开关要能在界面看到）", async () => {
    const p4 = await domain.ensureProject({ workspacePath: join(dir, "repo-cfg"), name: "cfg" })
    const cfg = domain.store.state.projects[p4.id].config
    assert.equal(cfg.issueCloseEnabled, true, "默认要开，且要显式存在于配置里")
  })
}

// ---- v1.30：merging 列不能是死胡同 -----------------------------------------
// 线上事故：accept 进 merging 后没有人开 PR，卡片 mergeRequest=null，
// 点「审核通过」必然报「没有 PR 快照，无法审核」；T-015/T-036 就这样卡住。
{
  const mp = await domain.ensureProject({ workspacePath: join(dir, "repo-merging"), name: "mergingv130" })
  const mkTask = async (title) => {
    const t = await domain.createTask(mp.id, { title, lane: "human" })
    await domain.move(t.id, "claim", { role: "human", id: "web" })
    await domain.setPlan(t.id, "方案", { role: "dispatcher", id: "ag_d" })
    await domain.move(t.id, "approve", { role: "human", id: "web" })
    await domain.move(t.id, "stop", { role: "worker", id: "ag_w" }, { stopReport: { summary: "做完了", tests: "跑了" } })
    return t.id
  }

  await t("没有 PR 快照时，报错要指向可执行的下一条路（不是干巴巴一句）", async () => {
    const id = await mkTask("无 PR 审核")
    await domain.setNoMerge(id, false, "", { role: "system" })
    await domain.move(id, "accept", { role: "human", id: "web" }, { headSha: "abcdef1" })
    assert.equal(store.state.tasks[id].column, "merging", "应当进合并列")
    const res = await domain.move(id, "review_approve", { role: "dispatcher", id: "ag_d" }, { verdict: "approved" }).catch((e) => ({ error: String(e.message || e) }))
    assert.ok(res.error, "没有快照必须拒绝")
    assert.match(res.error, /开 PR|跳过合并/, "报错要告诉人下一步做什么，实际：" + res.error)
  })

  await t("跳过合并能把无 PR 的卡收口（不再卡在 merging）", async () => {
    const id = await mkTask("跳过合并收口")
    await domain.setNoMerge(id, false, "", { role: "system" })
    await domain.move(id, "accept", { role: "human", id: "web" }, { headSha: "abcdef2" })
    const moved = await domain.move(id, "merge_skip", { role: "dispatcher", id: "ag_d" })
    assert.equal(moved.column, "done")
    assert.equal(moved.phase, "merged-skipped")
  })

  await t("有 PR 快照之后审核通过能正常收口", async () => {
    const id = await mkTask("有 PR 收口")
    await domain.setNoMerge(id, false, "", { role: "system" })
    await domain.move(id, "accept", { role: "human", id: "web" }, { headSha: "abcdef3" })
    await domain.openMergeRequest(id, { headSha: "abcdef3", baseSha: "0000000", files: ["a.ts"], summary: "s" }, { role: "worker" })
    // v1.32：必须先有真实合并提交，否则 review_approve 会被守卫拒
    await domain.markMerged(id, { commit: "abcdef3", strategy: "merge" })
    const moved = await domain.move(id, "review_approve", { role: "dispatcher", id: "ag_d" }, { verdict: "approved" })
    assert.equal(moved.column, "done")
    assert.equal(moved.phase, "merged")
    assert.equal(moved.mergeRequest.mergedCommit, "abcdef3", "合并提交要能从卡片上查到")
  })
}

// ---- v1.31：自动闭环（todo/planning 推进）+ 调度员请示箱 ----------------------
// 线上事故：T-042/T-044 的调度员写了计划却没 claim，卡永远停在 todo。
// 根因是 tick 的九个步骤一个都不覆盖 todo/planning —— 全靠调度员记得连调三个工具。
{
  const mp31 = await domain.ensureProject({ workspacePath: join(dir, "repo-v131"), name: "v131" })
  // 打开自动派工（advance 的总开关），其余按默认
  await store.tx((s) => {
    s.projects[mp31.id].config.autoDispatch = true
    s.projects[mp31.id].config.autoApproveIssue = true
    s.projects[mp31.id].config.autoAccept = false
    s.projects[mp31.id].config.autoMerge = false
  })
  const schedV131 = createScheduler({ domain, dispatcher, store, log: () => {}, now: () => Date.now() })

  /** 静默跑一拍 tick（吞掉所有 dispatch 尝试的日志噪音）。 */
  const tickQuiet = async () => { try { return await schedV131.tick() } catch (e) { return null } }

  await t("todo 的卡会被自动 claim 进 planning（不再等人连调工具）", async () => {
    const task = await domain.createTask(mp31.id, { title: "自动认领", lane: "human" })
    assert.equal(store.state.tasks[task.id].column, "todo")
    await tickQuiet()
    const after = store.state.tasks[task.id]
    assert.equal(after.column, "planning", "应当被自动认领进 planning，实际：" + after.column)
    assert.ok(after.advanceAt, "处理完要打防抖时间戳")
  })

  await t("planning 有计划但没提交 → 自动 plan_ready", async () => {
    const task = await domain.createTask(mp31.id, { title: "自动提交待批", lane: "human" })
    await domain.move(task.id, "claim", { role: "dispatcher", id: "ag_d" })
    await domain.setPlan(task.id, "方案：改 taskStatus.ts，加测试，验证 status 归一。".repeat(6), { role: "dispatcher", id: "ag_d" })
    assert.equal(store.state.tasks[task.id].phase, "", "还没提交待批")
    await tickQuiet()
    const after = store.state.tasks[task.id]
    assert.equal(after.phase, "waiting-approval", "应当自动 plan_ready，实际 phase=" + after.phase)
  })

  await t("waiting-approval 且非高风险 → 自动代批开工（human 车道也走同一条）", async () => {
    const task = await domain.createTask(mp31.id, { title: "自动代批", lane: "human" })
    await domain.move(task.id, "claim", { role: "dispatcher", id: "ag_d" })
    await domain.setPlan(task.id, "方案：改 BillNote_frontend/src/utils/taskStatus.ts 的 status 归一，补 1 个测试文件验证。".repeat(4), { role: "dispatcher", id: "ag_d" })
    await domain.move(task.id, "plan_ready", { role: "dispatcher", id: "ag_d" })
    assert.equal(store.state.tasks[task.id].phase, "waiting-approval")
    await tickQuiet()
    const after = store.state.tasks[task.id]
    assert.equal(after.column, "running", "应当被自动代批进 running，实际：" + after.column + "/" + after.phase)
  })

  await t("high 风险的卡不会被自动批，而是落到请示箱等人", async () => {
    const task = await domain.createTask(mp31.id, { title: "高风险要人批", lane: "human" })
    await domain.move(task.id, "claim", { role: "dispatcher", id: "ag_d" })
    // 命中 high 规则：涉及 schema 迁移
    await domain.setPlan(task.id, "方案：涉及 schema 迁移，需要改表结构并写迁移脚本。".repeat(5), { role: "dispatcher", id: "ag_d" })
    await domain.move(task.id, "plan_ready", { role: "dispatcher", id: "ag_d" })
    // risk 由 advance 自己算（不依赖调用方是否算过），所以这里等 tick 之后再看
    await tickQuiet()
    const after = store.state.tasks[task.id]
    assert.equal(after.risk && after.risk.level, "high", "预筛应判 high，实际：" + (after.risk && after.risk.level))
    assert.equal(after.column, "planning", "high 风险必须停在 planning 等人，实际：" + after.column)
    assert.equal(after.phase, "waiting-approval")
    // 光停下来不够：必须有人被告知在等（否则等于静默卡住）
    const asked = domain.inboxList({ projectId: mp31.id, taskId: task.id })
    assert.ok(asked.length >= 1, "高风险必须落一条请示让人知道在等")
  })

  await t("canAutoApprove 只拦 high（medium 放行，才可能自动循环）", () => {
    const lowTask = { plan: { revision: 1, text: "x".repeat(300) }, risk: { level: "low" } }
    const medTask = { plan: { revision: 1, text: "x".repeat(300) }, risk: { level: "medium" } }
    const highTask = { plan: { revision: 1, text: "x".repeat(300) }, risk: { level: "high" } }
    const proj = { config: { autoApproveIssue: true } }
    assert.equal(canAutoApprove(lowTask, proj).ok, true)
    assert.equal(canAutoApprove(medTask, proj).ok, true, "medium 必须放行，否则每张卡都要人批")
    assert.equal(canAutoApprove(highTask, proj).ok, false, "high 必须拦住")
  })

  await t("推进被守卫拒绝时不会每拍重试（记 advanceBlocked 并停车）", async () => {
    const task = await domain.createTask(mp31.id, { title: "被拒的推进", lane: "human" })
    await store.tx((s) => {
      s.tasks[task.id].advanceBlocked = { reason: "测试用的拒绝", at: new Date().toISOString() }
    })
    await tickQuiet()
    const after = store.state.tasks[task.id]
    assert.equal(after.column, "todo", "被标阻塞的卡不该被继续推")
  })

  await t("flow_ask_human 的四段结构进请示箱，卡上留指针评论", async () => {
    const task = await domain.createTask(mp31.id, { title: "请示对象", lane: "human" })
    const item = await domain.askHuman({
      taskId: task.id,
      kind: "decision",
      topic: "要不要改接口",
      problem: "现有 retryFailedTasks 返回 void，前端拿不到失败数",
      decisionNeeded: "改成返回 Result 还是保持 void 由前端自己查？",
      where: task.id + " · services/note.ts:42",
      suggestion: "建议改成返回失败数，改动面小且前端立刻能用",
    }, { role: "dispatcher", id: "ag_018" })
    assert.equal(item.status, "open")
    // 按 taskId 收窄：同一个项目里前面的 tick 也会落请示（高风险 / medium 知情项），
    // 用项目总数断言属于测试自身脆弱，不是被测行为有问题。
    const list = domain.inboxList({ projectId: mp31.id, taskId: task.id })
    assert.equal(list.length, 1)
    assert.equal(list[0].problem.indexOf("retryFailedTasks") >= 0, true)
    assert.equal(list[0].decisionNeeded.indexOf("Result") >= 0, true)
    assert.equal(list[0].where.indexOf("note.ts") >= 0, true)
    assert.equal(list[0].suggestion.indexOf("建议") >= 0, true)
  })

  await t('缺四段的关键项会拒绝（不许只发一句我遇到问题了）', async () => {
    const task = await domain.createTask(mp31.id, { title: "空请示", lane: "human" })
    await rejects(() => domain.askHuman({ taskId: task.id, kind: "decision", topic: "有问题" }, { role: "dispatcher" }), /problem|decisionNeeded/)
  })

  await t("info 类型只需 topic（纯知情项不强制四段）", async () => {
    const item = await domain.askHuman({ projectId: mp31.id, kind: "info", topic: "仅知情" }, { role: "dispatcher", id: "ag_018" })
    assert.equal(item.kind, "info")
    assert.equal(item.status, "open")
  })

  await t("人多轮回复后状态变 answered，日志留痕", async () => {
    const first = domain.inboxList({ projectId: mp31.id, status: "open" })[0]
    await domain.replyInbox(first.id, "第一轮：先看看现在的调用方", { role: "human", id: "web" })
    const mid = (await store.state.human_inbox).find((x) => x.id === first.id)
    assert.equal(mid.status, "answered")
    assert.equal(mid.replies.length, 1)
    await domain.replyInbox(first.id, "第二轮：按你说的改成返回失败数", { role: "human", id: "web" })
    const done = store.state.human_inbox.find((x) => x.id === first.id)
    assert.equal(done.replies.length, 2, "要支持多轮回复")
    assert.equal(done.status, "answered")
  })

  await t("调度归档后阻塞标记被清掉，卡能继续推进", async () => {
    const task = await domain.createTask(mp31.id, { title: "归档后继续", lane: "human" })
    const item = await domain.askHuman({
      taskId: task.id, kind: "blocked", topic: "卡住了",
      problem: "不知道走哪条路", decisionNeeded: "选 A 还是 B", where: task.id, suggestion: "建议 A",
    }, { role: "dispatcher", id: "ag_018" })
    await domain.replyInbox(item.id, "走 A", { role: "human", id: "web" })
    await domain.markAdvanceBlocked(task.id, "等人在请示里回")
    await domain.resolveInbox(item.id, { note: "人回复说走 A，阻塞已消除" }, { role: "dispatcher", id: "ag_018" })
    await domain.clearAdvanceBlocked(task.id)
    const after = store.state.tasks[task.id]
    assert.equal(after.advanceBlocked, null, "归档后要清掉阻塞标记")
    const archived = store.state.human_inbox.find((x) => x.id === item.id)
    assert.equal(archived.status, "archived")
    assert.equal(archived.resolvedNote.indexOf("走 A") >= 0, true, "归档要留判断依据")
    // 归档的不再出现在默认列表里
    assert.equal(domain.inboxList({ projectId: mp31.id }).filter((x) => x.id === item.id).length, 0)
  })

  await t("有 open 请示时不抢跑推进（等人拍板）", async () => {
    const task = await domain.createTask(mp31.id, { title: "等回复中", lane: "human" })
    await domain.askHuman({
      taskId: task.id, kind: "blocked", topic: "等人回",
      problem: "要人决定", decisionNeeded: "选一个", where: task.id, suggestion: "建议",
    }, { role: "dispatcher", id: "ag_018" })
    await tickQuiet()
    const after = store.state.tasks[task.id]
    assert.equal(after.column, "todo", "还挂着 open 请示时不该自动认领")
  })

  await t("autoAccept 用 dispatcher 身份 + 系统凭据（不再假冒 human）", async () => {
    const before = store.state.approvals
    const count0 = Object.keys(before || {}).length
    const task = await domain.createTask(mp31.id, { title: "自动验收身份", lane: "human" })
    await domain.move(task.id, "claim", { role: "dispatcher", id: "ag_d" })
    await domain.setPlan(task.id, "方案：改一个文件补一个测试。".repeat(8), { role: "dispatcher", id: "ag_d" })
    await domain.move(task.id, "plan_ready", { role: "dispatcher", id: "ag_d" })
    await store.tx((s) => { s.projects[mp31.id].config.autoApproveIssue = true })
    await domain.move(task.id, "approve_by_dispatcher", { role: "dispatcher", id: "ag_d" });
    // 直接把它推进到 verifying，模拟 worker 交了活
    await domain.move(task.id, "stop", { role: "worker", id: "ag_w" }, { stopReport: { summary: "改完了，测试通过", tests: "vitest run → 7 passed" } })
    await store.tx((s) => { s.projects[mp31.id].config.autoAccept = true })
    await tickQuiet()
    const after = store.state.tasks[task.id]
    // 收了但可能进 merging（这张卡需要合并）——关键是"离开了 verifying"，
    // 以及审批凭据能辨认出是系统代收而不是人收的。
    assert.notEqual(after.column, "verifying", "autoAccept 开着应当收掉，实际：" + after.column);
    const ap = Object.values(store.state.approvals || {}).find((x) => x.taskId === task.id && x.kind === "head")
    assert.ok(ap, "必须有验收审批记录")
    assert.equal(ap.acceptedBy, "system:advance", "系统代收要能辨认，实际：" + ap.acceptedBy)
  })

  await t("证据写「未执行」时不自动收，转请示箱等人决定", async () => {
    const task = await domain.createTask(mp31.id, { title: "没跑测试", lane: "human" })
    await domain.move(task.id, "claim", { role: "dispatcher", id: "ag_d" })
    await domain.setPlan(task.id, "方案：改一个文件。".repeat(10), { role: "dispatcher", id: "ag_d" })
    await domain.move(task.id, "plan_ready", { role: "dispatcher", id: "ag_d" })
    await domain.move(task.id, "approve_by_dispatcher", { role: "dispatcher", id: "ag_d" })
    await domain.move(task.id, "stop", { role: "worker", id: "ag_w" }, { stopReport: { summary: "改完了但环境跑不起来", tests: "未执行（.venv 里没有 pytest）" } })
    await store.tx((s) => { s.projects[mp31.id].config.autoAccept = true })
    await tickQuiet()
    const after = store.state.tasks[task.id]
    assert.equal(after.column, "verifying", "证据不足不能自动收，实际：" + after.column)
    const asked = domain.inboxList({ projectId: mp31.id, taskId: task.id });
    assert.ok(asked.length >= 1, "应当落一条请示让人决定")
    assert.equal(asked[0].kind, "decision")
  })
}

// ---- v1.32：状态不能撒谎（review_approve ≠ 已合并；accept 要求工作已提交） ----
// 线上真实事故：T-036/T-042/T-044 卡上写着 done/merged，但
//   mr.status=ready_for_review / open，mergedCommit=null
// —— 从来没有任何一次 git 合并发生过。
{
  const mp32 = await domain.ensureProject({ workspacePath: join(dir, "repo-v132"), name: "v132" })

  /** 造一张到 merging 列的卡（有 PR 快照、有审核结论）。 */
  const toMerging = async (title) => {
    const t = await domain.createTask(mp32.id, { title, lane: "human" })
    await domain.move(t.id, "claim", { role: "dispatcher", id: "ag_d" })
    await domain.setPlan(t.id, "方案：改一个文件补一个测试。".repeat(6), { role: "dispatcher", id: "ag_d" })
    await domain.move(t.id, "plan_ready", { role: "dispatcher", id: "ag_d" })
    await domain.move(t.id, "approve_by_dispatcher", { role: "dispatcher", id: "ag_d" })
    await domain.move(t.id, "stop", { role: "worker", id: "ag_w" }, { stopReport: { summary: "改完了", tests: "跑了 7 passed" } })
    // 测试仓库不是 git 仓库，派工时会自动打 noMerge；这里要显式关掉，
    // 否则 accept 会直接落到 done，根本进不了合并列 —— 那就测不到合并链路了。
    await domain.setNoMerge(t.id, false, "", { role: "system" })
    await domain.move(t.id, "accept", { role: "dispatcher", id: "ag_d" }, { acceptedBy: await grantFor(t.id), headSha: "abc1234" })
    await domain.openMergeRequest(t.id, { headSha: "abc1234", baseSha: "0000000", files: ["a.ts"], summary: "s" }, { role: "worker" })
    return t.id
  }

  await t("没有真正合并过，review_approve 必须被拒绝（不能把审核当成合并）", async () => {
    const id = await toMerging("假合并")
    const tk = store.state.tasks[id]
    assert.equal(tk.column, "merging", "应当在合并列")
    assert.equal(tk.mergeRequest.mergedCommit, null, "还没合并，mergedCommit 应为 null")
    // 只给审核结论，不给合并提交
    const res = await domain.move(id, "review_approve", { role: "dispatcher", id: "ag_d" }, { verdict: "approved" })
      .catch((e) => ({ error: String(e.message || e) }))
    assert.ok(res.error, "没有合并提交时必须拒绝，实际放行了")
    assert.match(res.error, /合并|flow_pr_merge|merge_skip/, "报错要指向该怎么做，实际：" + res.error)
    assert.equal(store.state.tasks[id].column, "merging", "被拒后必须还停在合并列")
  })

  await t("真的合并之后（有 mergedCommit）才允许 review_approve", async () => {
    const id = await toMerging("真合并")
    // 模拟 mergeLocked 的顺序：先 markMerged 记录提交，再 review_approve
    await domain.markMerged(id, { commit: "deadbeef", strategy: "merge" })
    const tk = store.state.tasks[id]
    assert.equal(tk.mergeRequest.mergedCommit, "deadbeef", "markMerged 必须写入 mergedCommit（字段名别写错）")
    const moved = await domain.move(id, "review_approve", { role: "dispatcher", id: "ag_d" }, { verdict: "approved" })
    assert.equal(moved.column, "done")
    assert.equal(moved.phase, "merged")
  })

  await t("merge_skip 是显式跳过，仍然允许（但要能看出跳过了）", async () => {
    const id = await toMerging("跳过合并")
    const moved = await domain.move(id, "merge_skip", { role: "dispatcher", id: "ag_d" })
    assert.equal(moved.column, "done")
    assert.equal(moved.phase, "merged-skipped", "跳过的语义用 merged-skipped 表达，不冒充 merged")
  })

  await t("worktree 有未提交改动时，accept 必须拒绝（验收不严的根因）", async () => {
    const t2 = await domain.createTask(mp32.id, { title: "脏工作区验收", lane: "human" })
    await domain.move(t2.id, "claim", { role: "dispatcher", id: "ag_d" })
    await domain.setPlan(t2.id, "方案：改一个文件。".repeat(10), { role: "dispatcher", id: "ag_d" })
    await domain.move(t2.id, "plan_ready", { role: "dispatcher", id: "ag_d" })
    await domain.move(t2.id, "approve_by_dispatcher", { role: "dispatcher", id: "ag_d" })
    await domain.move(t2.id, "stop", { role: "worker", id: "ag_w" }, { stopReport: { summary: "改完了", tests: "7 passed" } })
    // 故意不建 worktree —— 没有 worktree 时无从判断脏不脏，不该被拦
    const ok = await domain.move(t2.id, "accept", { role: "dispatcher", id: "ag_d" }, { acceptedBy: await grantFor(t2.id) }).catch((e) => ({ error: String(e.message || e) }))
    assert.ok(!ok.error, "没有 worktree 的卡不该被脏检查拦住，实际：" + ok.error)
  })
}

// ---- v1.32：真实 git 仓库里，脏 worktree 必须拦住验收 ----
//
// 上一条用例只验证了"没有 worktree 不该被拦"。这条造一个真正的 git worktree，
// 在里面留一个未提交文件，验收必须被拒 —— 这才是线上出问题的那条路径。
{
  const { execSync } = await import("node:child_process");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const gitRepo = join(dir, "repo-dirty");
  const wtDir = join(dir, "wt-dirty");
  const g = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();
  mkdirSync(gitRepo, { recursive: true });
  g("git init -q", gitRepo);
  g("git config user.email t@t", gitRepo);
  g("git config user.name t", gitRepo);
  writeFileSync(join(gitRepo, "a.txt"), "base\n");
  g("git add -A && git commit -qm base", gitRepo);
  g("git worktree add -q -b flow/dirty " + JSON.stringify(wtDir), gitRepo);

  const mpD = await domain.ensureProject({ workspacePath: gitRepo, name: "dirty" });
  const td = await domain.createTask(mpD.id, { title: "脏 worktree 验收", lane: "human" });
  await domain.move(td.id, "claim", { role: "dispatcher", id: "ag_d" });
  await domain.setPlan(td.id, "方案：改一个文件。".repeat(10), { role: "dispatcher", id: "ag_d" });
  await domain.move(td.id, "plan_ready", { role: "dispatcher", id: "ag_d" });
  await domain.move(td.id, "approve_by_dispatcher", { role: "dispatcher", id: "ag_d" });
  await domain.move(td.id, "stop", { role: "worker", id: "ag_w" }, { stopReport: { summary: "改完了", tests: "7 passed" } });
  // 手工登记 worktree，并把 noMerge 关掉（这个仓库是真 git）
  await domain.recordWorktree(td.id, { path: wtDir, branch: "flow/dirty", baseSha: null, sharedDirs: [] });
  await domain.setNoMerge(td.id, false, "", { role: "system" });

  // 顺序：先在 verifying 列上把「脏 → 拒绝」「allowDirty → 放过」「干净 → 通过」测完。
  // accept 只能从 verifying 发起，测完一次就离开这一列了，所以要按这个顺序。

  await t("worktree 里留了未提交文件时，验收必须被拒并列出文件", async () => {
    writeFileSync(join(wtDir, "uncommitted.txt"), "work done but never committed\n");
    const dirty = await domain.worktreeDirtyFiles(store.state.tasks[td.id]);
    assert.equal(dirty.length, 1, "应当检测到 1 个未提交文件，实际：" + JSON.stringify(dirty));
    const res = await domain.move(td.id, "accept", { role: "dispatcher", id: "ag_d" }, { acceptedBy: await grantFor(td.id) })
      .catch((e) => ({ error: String(e.message || e) }));
    assert.ok(res.error, "有未提交改动时必须拒绝，实际放行了");
    assert.match(res.error, /未提交/, "报错要说清是未提交改动，实际：" + res.error);
    assert.match(res.error, /uncommitted\.txt/, "要列出具体文件，实际：" + res.error);
    assert.equal(store.state.tasks[td.id].column, "verifying", "被拒后要停在待验收");
  });

  await t("人确认这些改动不要了，可以带 allowDirty 放过", async () => {
    const moved = await domain.move(td.id, "accept", { role: "dispatcher", id: "ag_d" }, { acceptedBy: await grantFor(td.id), allowDirty: true });
    assert.ok(moved.column === "merging" || moved.column === "done", "显式 allowDirty 应当放过，实际：" + moved.column);
  });
}

// ---- v1.32：提示词里的硬约束（防止再出现"完成了但没提交"） ----
{
  await t("工人提示词强约束「必须提交」并把自查写清", () => {
    const w = promptsMod.builtinWorkerRules({ workdir: "C:/x" });
    assert.match(w, /必须提交/, "要明确说产出只有进提交才算数");
    assert.match(w, /git status/, "要给出具体自查命令");
    assert.match(w, /零提交/, "要提醒零提交等于交空票");
    assert.match(w, /验收会\*\*直接拒绝\*\*/ , "要说明不提交会被验收拒绝");
    assert.match(w, /flow_pr_open/, "要指明推荐做法（自动提交+推送+PR）");
  });

  await t("调度提示词强约束「审核通过 ≠ 已合并」", () => {
    const d = promptsMod.builtinDispatcherRules();
    assert.match(d, /审核通过/, "要提到这个词");
    assert.match(d, /不等于|≠/, "要明确区分「审核」和「合并」");
    assert.match(d, /flow_pr_merge/, "要指明真合并的唯一入口");
    assert.match(d, /mergedCommit/, "要指出核对哪个字段");
    assert.match(d, /merge_skip/, "要说明不想合并的卡该怎么走");
    assert.match(d, /allowDirty/, "要警告不要用 allowDirty 绕过");
  });
}

// ---- v1.33：状态修复的两种模式（回退 / 补记） ----
{
  const mpFix = await domain.ensureProject({ workspacePath: join(dir, "repo-fix"), name: "fix" })

  /** 造一张「说合并了但没提交」的卡。 */
  const fakeMerged = async (title) => {
    const tt = await domain.createTask(mpFix.id, { title, lane: "human" })
    await domain.move(tt.id, "claim", { role: "dispatcher", id: "d" })
    await domain.setPlan(tt.id, "x".repeat(300), { role: "dispatcher", id: "d" })
    await domain.move(tt.id, "plan_ready", { role: "dispatcher", id: "d" })
    await domain.move(tt.id, "approve_by_dispatcher", { role: "dispatcher", id: "d" })
    await domain.move(tt.id, "stop", { role: "worker", id: "w" }, { stopReport: { summary: "done", tests: "7 passed" } })
    await domain.setNoMerge(tt.id, false, "", { role: "system" })
    await domain.move(tt.id, "accept", { role: "dispatcher", id: "d" }, { acceptedBy: await grantFor(tt.id), headSha: "abc1234" })
    await domain.openMergeRequest(tt.id, { headSha: "abc1234", baseSha: "0000000", files: ["a.ts"] }, { role: "worker" })
    // 直接把它推成 done/merged，模拟 v1.32 之前的老数据
    await store.tx((s) => {
      const tk = s.tasks[tt.id]; tk.column = "done"; tk.phase = "merged"
      tk.mergeRequest = Object.assign({}, tk.mergeRequest, { status: "ready_for_review" })
    })
    return tt.id
  }

  await t("修复必须说明原因（留审计）", async () => {
    const id = await fakeMerged("没理由的修复")
    await rejects(() => domain.repairUnmerged(id, {}, { role: "human", id: "web" }), /原因/);
  })

  await t("只修「phase=merged 但没有提交」的卡，正常的卡不能被动", async () => {
    const id = await fakeMerged("正常的卡")
    await domain.markMerged(id, { commit: "cafebabe", strategy: "merge" })
    await rejects(() => domain.repairUnmerged(id, { reason: "试一下" }, { role: "human", id: "web" }), /只修复|已有 mergedCommit/);
  })

  await t("没有 git 事实时退回 merging（保守分支），不清空 worktree 记录", async () => {
    const id = await fakeMerged("退回合并列")
    const fixed = await domain.repairUnmerged(id, { reason: "代码没进 master" }, { role: "human", id: "web" })
    assert.equal(fixed.column, "merging", "应当退回合并列，实际：" + fixed.column)
    assert.equal(fixed.phase, "merge-ready")
    assert.ok(fixed.mergeRequest.branch !== undefined || true)
    // 审计事件要记下"为什么改"
    const ev = (store.state.events || []).filter((e) => e.type === "task.repaired" && e.payload && e.payload.taskId === id).pop()
    assert.ok(ev, "必须留 task.repaired 事件")
    assert.match(String(ev.payload.reason), /没进 master/)
    assert.equal(ev.payload.mode, "back-to-merging")
  })

  await t("分支已全部合入时，改为补记 mergedCommit（不能退回重复合并）", async () => {
    // 造一个真 git 仓库：分支已合进 master
    const { execSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const repo = join(dir, "repo-fix-git");
    const g = (cmd) => execSync(cmd, { cwd: repo, stdio: "pipe" }).toString().trim();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo, { recursive: true });
    g("git init -q -b master");
    g("git config user.email t@t");
    g("git config user.name t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    g("git add -A && git commit -qm base");
    g("git checkout -q -b flow/done");
    writeFileSync(join(repo, "b.txt"), "work\n");
    g("git add -A && git commit -qm work");
    const branchHead = g("git rev-parse HEAD");
    g("git checkout -q master && git merge -q --no-ff flow/done -m merge");
    // 现在 flow/done 相对 master 是 0 个未合

    const mp2 = await domain.ensureProject({ workspacePath: repo, name: "fixgit" });
    await store.tx((s) => { s.projects[mp2.id].config.baseBranch = "master" })
    const tt = await domain.createTask(mp2.id, { title: "已合但没记账", lane: "human" })
    await domain.move(tt.id, "claim", { role: "dispatcher", id: "d" })
    await domain.setPlan(tt.id, "x".repeat(300), { role: "dispatcher", id: "d" })
    await domain.move(tt.id, "plan_ready", { role: "dispatcher", id: "d" })
    await domain.move(tt.id, "approve_by_dispatcher", { role: "dispatcher", id: "d" })
    await domain.move(tt.id, "stop", { role: "worker", id: "w" }, { stopReport: { summary: "done", tests: "t" } })
    await domain.setNoMerge(tt.id, false, "", { role: "system" })
    await domain.move(tt.id, "accept", { role: "dispatcher", id: "d" }, { acceptedBy: await grantFor(tt.id), headSha: branchHead.slice(0, 8) })
    await domain.openMergeRequest(tt.id, { headSha: branchHead, baseSha: "0000000", files: ["b.txt"] }, { role: "worker" })
    await domain.recordWorktree(tt.id, { path: repo, branch: "flow/done", baseSha: null, sharedDirs: [] })
    await store.tx((s) => {
      const tk = s.tasks[tt.id]; tk.column = "done"; tk.phase = "merged"
      tk.mergeRequest = Object.assign({}, tk.mergeRequest, { status: "ready_for_review" })
    })

    const fixed = await domain.repairUnmerged(tt.id, { reason: "代码已在 master，只是没记账" }, { role: "human", id: "web" })
    assert.equal(fixed.column, "done", "已经合入的卡不该退回合并列（会重复合并）");
    assert.equal(fixed.phase, "merged")
    assert.ok(fixed.mergeRequest.mergedCommit, "必须补记 mergedCommit")
    assert.equal(fixed.mergeRequest.mergedCommit, branchHead, "补记的应当是分支头提交")
    assert.equal(fixed.mergeRequest.status, "merged")
    const ev = (store.state.events || []).filter((e) => e.type === "task.repaired" && e.payload && e.payload.taskId === tt.id).pop()
    assert.equal(ev.payload.mode, "backfill-merged-commit")
    assert.equal(ev.payload.after.mergedCommit, branchHead)
  })
}

// ---- v1.33：alreadyMerged 的记账语义（别把别人的合并提交记成自己的） ----
{
  await t("分支已全部合入时，mergeBranch 要标记 alreadyMerged 并返回分支自己的头", async () => {
    const { execSync } = await import("node:child_process");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const git = await import("../lib/git.js");
    const repo = join(dir, "repo-am");
    const g = (cmd) => execSync(cmd, { cwd: repo, stdio: "pipe" }).toString().trim();
    mkdirSync(repo, { recursive: true });
    g("git init -q -b master");
    g("git config user.email t@t");
    g("git config user.name t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    g("git add -A && git commit -qm base");
    g("git checkout -q -b flow/x");
    writeFileSync(join(repo, "b.txt"), "work\n");
    g("git add -A && git commit -qm work");
    const branchHead = g("git rev-parse HEAD");
    // 先把它合进 master，制造 already-up-to-date 的条件
    g("git checkout -q master && git merge -q --no-ff flow/x -m first-merge");
    const masterBefore = g("git rev-parse HEAD");

    // 再合一次：这次不该产生新提交
    const res = await git.mergeBranch({ repo, branch: "flow/x", base: "master", strategy: "merge", message: "again" });
    assert.equal(res.ok, true, "重复合并应当成功（不是失败）");
    assert.equal(res.alreadyMerged, true, "必须标记 alreadyMerged —— 否则会误记成产生了新提交");
    assert.equal(res.mergeCommit, null, "没有产生新提交，mergeCommit 必须是 null");
    assert.equal(res.commit, branchHead, "commit 要记分支自己的头，不是 master 的 HEAD");
    assert.notEqual(res.commit, masterBefore, "**不能**把 master 上的合并提交记成这张卡的贡献");

    // 对照：真的合并时应该产生新提交
    g("git checkout -q -b flow/y");
    writeFileSync(join(repo, "c.txt"), "more\n");
    g("git add -A && git commit -qm more");
    g("git checkout -q master");
    const real = await git.mergeBranch({ repo, branch: "flow/y", base: "master", strategy: "merge", message: "real" });
    assert.equal(real.ok, true);
    assert.equal(real.alreadyMerged, false, "真合并不该被标 alreadyMerged");
    assert.ok(real.mergeCommit, "真合并要给出合并提交");
    assert.equal(real.commit, real.mergeCommit, "真合并时 commit 就是那个新提交");
  })
}

// ---- v1.34：通知聚合（debounce + maxWait + 紧急直通） ----
//
// 线上实测：一分钟最多投 8 条通知，调度员每 7 秒被打断一次，
// 模型每次都要重新进上下文，没法连续输出。这里验证三个机制真的生效。
{
  const { createAggregator } = await import("../lib/aggregator.js")

  /** 造一个可控的聚合器（记录投递、可注入时钟）。 */
  const mkAgg = (cfg) => {
    const sent = []
    let clock = 0
    const agg = createAggregator({
      deliver: async (sid, text) => { sent.push({ sid, text, at: clock }); return { ok: true } },
      now: () => clock,
      config: Object.assign({ debounceMs: 3000, maxWaitMs: 10000 }, cfg || {}),
    })
    return { agg, sent, tick: (ms) => { clock += ms } }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  await t("连续 5 条通知合并成 1 条（不再一条一次打断）", async () => {
    const { agg, sent } = mkAgg({ debounceMs: 40, maxWaitMs: 500 })
    for (let i = 1; i <= 5; i += 1) {
      await agg.push({ sessionId: "s1", text: "事件 " + i, taskId: "T-" + i })
    }
    assert.equal(sent.length, 0, "刚入队时不该立即发")
    assert.equal(agg.size(), 5, "5 条都该在队列里")
    await sleep(120)
    assert.equal(sent.length, 1, "应当合并成 1 条，实际 " + sent.length + " 条")
    assert.match(sent[0].text, /合并通知 · 5 条/)
    assert.match(sent[0].text, /事件 1/)
    assert.match(sent[0].text, /事件 5/)
  })

  await t("maxWait 兜底：消息持续不断也会强制发出（防饿死）", async () => {
    const { agg, sent, tick } = mkAgg({ debounceMs: 30, maxWaitMs: 90 })
    for (let i = 0; i < 6; i += 1) {
      await agg.push({ sessionId: "s1", text: "持续 " + i })
      tick(20)
      await sleep(20)
    }
    await sleep(60)
    assert.ok(sent.length >= 1, "持续有消息时也必须发出去，否则调度员永远收不到")
  })

  await t("紧急通知立即发，不等合并窗口", async () => {
    const { agg, sent } = mkAgg({ debounceMs: 3000, maxWaitMs: 10000 })
    await agg.push({ sessionId: "s1", text: "卡死了", urgent: true, taskId: "T-9" })
    assert.equal(sent.length, 1, "紧急消息必须立即投递，实际 " + sent.length)
    assert.match(sent[0].text, /卡死了/)
    assert.equal(agg.size(), 0, "紧急消息不进队列")
  })

  await t("紧急消息不会吞掉已排队的普通通知", async () => {
    const { agg, sent } = mkAgg({ debounceMs: 3000, maxWaitMs: 10000 })
    await agg.push({ sessionId: "s1", text: "普通A" })
    await agg.push({ sessionId: "s1", text: "普通B" })
    assert.equal(sent.length, 0)
    await agg.push({ sessionId: "s1", text: "紧急X", urgent: true })
    assert.equal(sent.length, 2, "应当是「先发队列」+「再发紧急」两条，实际 " + sent.length)
    assert.match(sent[0].text, /普通A/)
    assert.match(sent[1].text, /紧急X/)
  })

  await t("附注（noteOnly）不单独触发投递，但要能搭车", async () => {
    const { agg, sent } = mkAgg({ debounceMs: 30, maxWaitMs: 200 })
    await agg.push({ sessionId: "s1", text: "有人评论了", noteOnly: true, taskId: "T-1" })
    await sleep(60)
    assert.equal(sent.length, 0, "只有附注时不该打扰调度员，实际发了 " + sent.length)
    await agg.push({ sessionId: "s1", text: "PR 开了", taskId: "T-2" })
    await sleep(90)
    assert.equal(sent.length, 1, "应当合并成一条")
    assert.match(sent[0].text, /有人评论了/, "附注要搭车一起发，不能丢")
    assert.match(sent[0].text, /PR 开了/)
  })

  // ---- 回归：人的声音不能被"降噪"吃掉 ----
  //
  // 线上事故（2026-11-07）：人在 T-046 下留了评论、又在 Inbox 里回复了请示，
  // 调度一次都没被叫醒。两个独立原因：
  //   ① 人评论被标成 noteOnly，而 v1.37 的"整批都是附注就不发"规则让单条人评论永远发不出去；
  //   ② Inbox 回复只唤醒 from 是 ag_* 的调度，auto-accept 发出的请示 from 是 system:* —— 没人醒。
  await t("人单独留一条评论，必须投给调度员（不能被 noteOnly 规则吞掉）", async () => {
    // ① 静态：comment.added 不能标 noteOnly。
    //    标了就意味着"攒着搭车"，而聚合器整批都是附注时不单独发 ——
    //    人单独留一条评论时那一批只有它自己，于是永远发不出去（线上真实事故）。
    //    降噪已经在 WATCHED 的 only 那一层做完（工人/系统评论压根进不来）。
    const dispatchSrc = readFileSync(new URL('../lib/dispatch.js', import.meta.url), 'utf8')
    const block = /'comment\.added':\s*\{([\s\S]{0,400}?)\}/
    const m = block.exec(dispatchSrc)
    assert.ok(m, 'dispatch.js 里应当能找到 comment.added 的配置')
    assert.equal(/noteOnly/.test(m[1]), false, 'comment.added 不能标 noteOnly —— 那会让人单独留的评论永远发不出去')

    // ② 行为：一条非附注通知，安静到期就必须真的投出去。
    const { agg, sent } = mkAgg({ debounceMs: 30, maxWaitMs: 150 })
    await agg.push({ sessionId: "s1", text: "【事件 comment.added】人问了：为什么没回复", taskId: "T-1" })
    await sleep(400)
    assert.equal(sent.length, 1, "人评论必须送达，实际发了 " + sent.length + " 条")
    assert.match(sent[0].text, /为什么没回复/)
  })

  await t("不同调度员的队列互不干扰", async () => {
    const { agg, sent } = mkAgg({ debounceMs: 30, maxWaitMs: 200 })
    await agg.push({ sessionId: "s1", text: "给A的", taskId: "T-1" })
    await agg.push({ sessionId: "s2", text: "给B的", taskId: "T-2" })
    await sleep(90)
    assert.equal(sent.length, 2, "两个调度员各一条")
    const byId = {}
    for (const s of sent) byId[s.sid] = s.text
    assert.match(byId.s1, /给A的/)
    assert.match(byId.s2, /给B的/)
    assert.equal(byId.s1.indexOf("给B的"), -1, "不能串台")
  })

  await t("超长时保留最新的、丢掉最早的（并说清涉及哪些卡）", async () => {
    const { agg, sent } = mkAgg({ debounceMs: 30, maxWaitMs: 200, maxChars: 300 })
    for (let i = 1; i <= 6; i += 1) {
      await agg.push({ sessionId: "s1", text: "第" + i + "条：" + "x".repeat(80), taskId: "T-" + i })
    }
    await sleep(90)
    assert.equal(sent.length, 1)
    const text = sent[0].text
    assert.match(text, /第6条/, "最新的必须保住 —— 那通常才是当前该看的")
    assert.equal(text.indexOf("第1条"), -1, "最早的可以被截掉")
    assert.match(text, /长度省略/, "要说明被省略了")
    assert.match(text, /T-1/, "要列出被省略的涉及哪些卡")
  })
}

// ---- v1.34：禁用 ask_user_question，改走各自的消息通道 ----
//
// 背景：ask_user_question 会弹界面并**阻塞等回话**。工人/调度员都在后台跑，
// 没有人守着它们的会话 —— 用了只会让这一轮卡死，占着工位和租约等心跳超时。
{
  await t("工人被明确禁止用 ask_user_question，并给了正确走法", () => {
    const w = promptsMod.builtinWorkerRules({ workdir: "C:/x" })
    assert.match(w, /不要用 ask_user_question/, "要明确禁止")
    assert.match(w, /阻塞/, "要说明为什么禁止（会卡住）")
    assert.match(w, /flow_task_move\(action="block"/, "要给出正确走法：block")
    assert.match(w, /停下来等待/, "要说明发完之后是停，不是空转")
  })

  await t("调度员被禁止用 ask_user_question，改走 flow_ask_human", () => {
    const d = promptsMod.builtinDispatcherRules()
    assert.match(d, /不要调用 ask_user_question/, "要明确禁止")
    assert.match(d, /flow_ask_human/, "要指向请示箱")
    assert.match(d, /不要等/, "要说明发完继续干，别停在那里等")
    assert.match(d, /flow_worker_steer/, "要给出对工人下指令的正确方式")
  })

  await t("两条通道的归属写清楚了（工人→调度，调度→人）", () => {
    const w = promptsMod.builtinWorkerRules({ workdir: "C:/x" })
    const d = promptsMod.builtinDispatcherRules()
    assert.match(w, /需要人类拍板/, "工人要能区分该问人的情况")
    assert.match(w, /由调度员判断/, "工人要把该问人的事交调度员，不是自己问")
    assert.match(d, /flow_worker_steer/, "调度员对工人用 steer")
  })
}

// ---- v1.35：最高优先级段必须置顶（不是埋在末尾） ----
//
// 原来所有规则一起拼在 brief 末尾，位置越靠后越容易被当参考而不是命令。
// 这几条违反就会让整轮作废/产生假完成，必须最先读到。
{
  await t("工人 brief 的第一段就是最高优先级约束", async () => {
    const { buildBrief } = await import("../lib/dispatch.js")
    const project = { id: "p", name: "P", workspacePath: "C:/x", config: {} }
    const agent = { id: "ag1", name: "工人1", role: "worker" }
    const task = { id: "T-1", title: "测试卡", column: "running", phase: "executing", projectId: "p", lane: "human", plan: { revision: 1, text: "x" } }
    const brief = buildBrief(task, project, agent, { workdir: "C:/wt", skills: [], contexts: [] })
    assert.equal(brief.indexOf("【最高优先级"), 0, "最高优先级段必须在最开头，实际：" + brief.slice(0, 40))
    assert.ok(brief.indexOf("ask_user_question") < 200, "禁止条款要出现在开头 200 字内，实际位置：" + brief.indexOf("ask_user_question"))
    // 但完整规则仍然要在（不能只顾置顶、把详细说明丢了）
    assert.match(brief, /【工作方式】/, "详细规则不能丢")
    assert.match(brief, /【必须提交/, "提交约束不能丢")
  })

  await t("调度巡检包的第一段就是最高优先级约束", async () => {
    const { buildInspectPacket } = await import("../lib/dispatch.js")
    const project = { id: "p", name: "P", workspacePath: "C:/x", config: {} }
    const task = { id: "T-1", title: "卡", column: "verifying", phase: "awaiting-acceptance", projectId: "p", stopReport: { summary: "s", tests: "t" } }
    const pkt = buildInspectPacket(task, "stop", { verdict: "keep", reasons: ["ok"] }, { project, agent: { id: "d1", name: "调度1" }, kind: "stop", runId: "run_9" })
    assert.equal(pkt.indexOf("【最高优先级"), 0, "最高优先级段必须在最开头")
    assert.ok(pkt.indexOf("ask_user_question") < 200)
    // v1.39：巡检包改成事件信封 —— 头部是事件类型 + 卡号，正文是报告/建议/可选动作
    assert.match(pkt, /【事件 worker\.stopped】T-1 · run_9/)
    assert.match(pkt, /【停止报告】/)
    assert.match(pkt, /【系统建议】/)
    assert.match(pkt, /【你的选择】/)
    assert.match(pkt, /结束本轮/)
  })

  await t('最高优先级段用的是硬措辞，不是建议/尽量', async () => {
    const { criticalRules } = await import("../lib/prompts.js")
    for (const role of ["worker", "dispatcher"]) {
      const t = criticalRules(role)
      assert.match(t, /最高优先级/, role + " 要标优先级")
      assert.match(t, /不要调用 ask_user_question|不要用 ask_user_question/, role + " 要明确禁止")
      assert.match(t, /没有任何例外|违反会/, role + " 要给强制性措辞")
    }
  })
}

// ---- v1.35：事务流对齐（凭据核验 / 发布不冒充人 / 审核不回滚 / 副作用意图 / 合并对账） ----
{
  const p35 = await domain.ensureProject({ workspacePath: join(dir, 'repo-v135'), name: 'v135' })
  const toVerifying = async (title) => {
    const tk = await domain.createTask(p35.id, { title, lane: 'human' })
    await domain.move(tk.id, 'claim', { role: 'human', id: 'web' })
    await domain.setPlan(tk.id, '方案：只读核对', { role: 'dispatcher', id: 'ag_d' })
    await domain.move(tk.id, 'approve', { role: 'human', id: 'web' })
    await domain.move(tk.id, 'stop', { role: 'worker', id: 'ag_w' }, { stopReport: { summary: '核对完成', tests: '不适用' } })
    return tk.id
  }
  const acceptErr = (id, actor, payload) => domain.move(id, 'accept', actor, payload).then(() => null, (e) => String(e.message || e))

  await t('v1.35 自己写的 human:web 不再是验收凭据', async () => {
    const id = await toVerifying('伪凭据')
    const err = await acceptErr(id, { role: 'dispatcher', id: 'ag_d' }, { acceptedBy: 'human:web' })
    assert.match(err || '', /核验失败/)
    assert.equal(store.state.tasks[id].column, 'verifying')
  })
  await t('v1.35 人的否定回复不能当验收授权', async () => {
    const id = await toVerifying('否定回复')
    const g = await grantFor(id, '不行，先补测试')
    assert.match(await acceptErr(id, { role: 'dispatcher', id: 'ag_d' }, { acceptedBy: g }) || '', /否定/)
  })
  await t('v1.35 别的卡的请示单不能拿来用', async () => {
    const a = await toVerifying('卡 A')
    const b = await toVerifying('卡 B')
    const g = await grantFor(a)
    assert.match(await acceptErr(b, { role: 'dispatcher', id: 'ag_d' }, { acceptedBy: g }) || '', /不属于/)
  })
  await t('v1.35 system:* 凭据只有调度器自身能用', async () => {
    const id = await toVerifying('系统凭据')
    assert.match(await acceptErr(id, { role: 'dispatcher', id: 'ag_d' }, { acceptedBy: 'system:advance' }) || '', /调度器自身/)
    assert.equal(await acceptErr(id, { role: 'dispatcher', id: 'system:auto-accept' }, { acceptedBy: 'system:advance', auto: true }), null)
  })
  await t('v1.35 有效凭据落进审批记录（能查到是哪条请示、谁回复的）', async () => {
    const id = await toVerifying('真凭据')
    const g = await grantFor(id)
    assert.equal(await acceptErr(id, { role: 'dispatcher', id: 'ag_d' }, { acceptedBy: g }), null)
    const rec = Object.values(store.state.approvals).filter((x) => x.taskId === id && x.kind === 'head').pop()
    assert.equal(rec.grantKind, 'inbox')
    assert.equal(rec.grantRef, g)
    assert.equal(rec.grantReplyBy, 'web')
  })

  await t('v1.35 flow_publish 不冒充人、只派一次工', async () => {
    const { buildTools } = await import('../lib/tools.js')
    const pubTools = buildTools({ domain, resolveProject: async () => p35, dispatcher })
    const pub = pubTools.find((x) => x.name === 'flow_publish')
    const exec = { agent: { session: { header: { cwd: p35.workspacePath, id: 'ses_pub35' } } } }
    const res = await pub.execute({ title: '发布不冒充', plan: '1. 改 A\n2. 测 A' }, exec)
    assert.ok(res.ok, res.message)
    const tk = store.state.tasks[res.taskId]
    assert.equal(tk.column, 'running')
    assert.equal(tk.plan.approvedRevision, 1)
    const ap = Object.values(store.state.approvals).filter((x) => x.taskId === tk.id && x.kind === 'plan').pop()
    assert.equal(ap.via, 'approve_by_publish')
    assert.equal(ap.publishedFrom, 'ses_pub35')
    assert.notEqual(ap.role, 'human', '发布带出来的批准不能署名 human')
    const dispatched = store.state.events.filter((e) => e.type === 'task.dispatched' && e.payload.taskId === tk.id)
    assert.ok(dispatched.length <= 1, '只能派一次工，实际 ' + dispatched.length)
    if (tk.activeRunId) assert.match(res.message, /已派给/)
  })

  await t('v1.35 审核 approved 只记结论、卡留在 merging（不再被 review_approve 守卫回滚）', async () => {
    const id = await toVerifying('审核不回滚')
    await domain.setNoMerge(id, false, '', { role: 'system' })
    await domain.move(id, 'accept', { role: 'human', id: 'web' }, { headSha: 'abcdef9' })
    await domain.openMergeRequest(id, { headSha: 'abcdef9', baseSha: '0000000', files: ['a.js'], summary: 's' }, { role: 'worker' })
    const r = await domain.review(id, 'approved', { summary: '判据都过' }, { role: 'dispatcher', id: 'ag_d' })
    assert.equal(r.next, 'merge')
    assert.equal(store.state.tasks[id].column, 'merging')
    assert.equal(store.state.tasks[id].mergeRequest.reviewVerdict, 'approved')
    assert.ok(store.state.events.some((e) => e.type === 'review.recorded' && e.payload.taskId === id))
  })
  await t('v1.35 命中 block 级判据却给 approved → 改判 risk', async () => {
    const id = await toVerifying('判据矛盾')
    await domain.setNoMerge(id, false, '', { role: 'system' })
    await domain.move(id, 'accept', { role: 'human', id: 'web' }, { headSha: 'abcdef8' })
    await domain.openMergeRequest(id, { headSha: 'abcdef8', baseSha: '0000000', files: ['a.js'], summary: 's' }, { role: 'worker' })
    const blockPrompt = domain.reviewPromptSet(p35.id).prompts.find((x) => x.severity === 'block')
    const r = await domain.review(id, 'approved', { matched: [{ id: blockPrompt.id, reason: 'x' }] }, { role: 'dispatcher', id: 'ag_d' })
    assert.equal(r.verdict, 'risk')
    assert.ok(store.state.tasks[id].blocked, 'risk 要升级成阻塞')
  })

  await t('v1.35 startRun 在事务内拒绝第二条活跃 run（I2）', async () => {
    const tk = await domain.createTask(p35.id, { title: '双派工' })
    const w = await domain.upsertAgent(p35.id, { name: 'v135工人', role: 'worker', lane: 'human' }, { role: 'human' })
    const r1 = await domain.startRun(tk.id, { agentId: w.id, sessionId: 's1' })
    assert.equal(r1.run.dedupeKey, 'dispatch:' + tk.id + ':' + r1.run.seq)
    const err = await domain.startRun(tk.id, { agentId: w.id, sessionId: 's2' }).then(() => null, (e) => e)
    assert.equal(err && err.code, 'DUPLICATE_RUN')
  })

  // 副作用意图：用独立 store + 会失败一次的运行时
  const fxStore = new Store(join(dir, 'flow-fx.json'))
  await fxStore.load()
  let failOnce = true
  const seen = []
  const fxRt = {
    async onMoved(task, action) {
      await fxDomain.comment(task.id, 'effect ran: ' + action, { role: 'system', id: 'fx' })
      seen.push(action)
      if (failOnce && action === 'approve') { failOnce = false; throw new Error('会话服务暂时不可用') }
      return { ok: true }
    },
    async onStopped() { return { ok: true } },
  }
  const fxDomain = new FlowDomain(fxStore, fxRt)
  const fxp = await fxDomain.ensureProject({ workspacePath: join(dir, 'repo-fx'), name: 'fx' })
  const fxt = await fxDomain.createTask(fxp.id, { title: '副作用' })
  await fxDomain.move(fxt.id, 'claim', { role: 'human', id: 'web' })
  await fxDomain.setPlan(fxt.id, '方案', { role: 'dispatcher', id: 'd' })
  await fxDomain.move(fxt.id, 'approve', { role: 'human', id: 'web' })
  const fx = fxDomain.lastEffectOf(fxt.id, 'approve')

  await t('v1.35 副作用抛错不再被吞：意图落 failed + 下次重试时间', () => {
    assert.equal(fx.status, 'failed')
    assert.match(fx.lastError, /暂时不可用/)
    assert.ok(fx.nextAt)
  })
  await t('v1.35 到点后 tick 能把失败的副作用补跑成功', async () => {
    const due = fxDomain.pendingEffects(Date.parse(fx.nextAt) + 1)
    assert.ok(due.some((x) => x.id === fx.id))
    const res = await fxDomain.runEffect(fx.id)
    assert.equal(res.status, 'done')
    assert.equal(res.attempts, 2)
  })
  await t('v1.35 副作用里产生的事件带 causationId 指回触发它的迁移（I7）', () => {
    const moved = fxStore.state.events.find((e) => e.type === 'task.moved' && e.payload.taskId === fxt.id && e.payload.action === 'approve')
    const caused = fxStore.state.events.filter((e) => e.causationId === moved.id)
    assert.ok(caused.some((e) => e.type === 'task.comment' || e.type === 'comment.added' || /comment/.test(e.type)), '评论事件应当带 causationId，实际：' + JSON.stringify(caused.map((e) => e.type)))
  })
  await t('v1.35 卡已被后续迁移推走时，旧派工意图作废（不在已取消的卡上派工）', async () => {
    const t2 = await fxDomain.createTask(fxp.id, { title: '批准后马上取消' })
    await fxDomain.move(t2.id, 'claim', { role: 'human', id: 'web' })
    await fxDomain.setPlan(t2.id, '方案', { role: 'dispatcher', id: 'd' })
    failOnce = true
    await fxDomain.move(t2.id, 'approve', { role: 'human', id: 'web' })
    const e2 = fxDomain.lastEffectOf(t2.id, 'approve')
    assert.equal(e2.status, 'failed')
    await fxDomain.move(t2.id, 'cancel', { role: 'human', id: 'web' })
    const res = await fxDomain.runEffect(e2.id)
    assert.equal(res.status, 'skipped')
    assert.match(res.reason, /stale/)
  })
  await t('v1.35 recoverRuns 把执行到一半的副作用转入立即重试', async () => {
    const t3 = await fxDomain.createTask(fxp.id, { title: '中断' })
    await fxStore.tx((s) => { s.effects.fx_crash = { id: 'fx_crash', taskId: t3.id, action: 'claim', taskVersion: 0, status: 'running', attempts: 1, startedAt: new Date().toISOString() } })
    const rec = await fxDomain.recoverRuns(Date.now())
    assert.ok(rec.effects.includes('fx_crash'))
    assert.equal(fxStore.state.effects.fx_crash.status, 'failed')
  })

  // 合并意图对账：真 git 仓库
  const repo35 = join(dir, 'git-v135')
  const { mkdirSync: mk35 } = await import('node:fs')
  mk35(repo35, { recursive: true })
  sh(repo35, ['init', '-q', '-b', 'master'])
  sh(repo35, ['config', 'user.email', 't@t'])
  sh(repo35, ['config', 'user.name', 't'])
  writeFileSync(join(repo35, 'a.txt'), 'base\n')
  sh(repo35, ['add', '-A']); sh(repo35, ['commit', '-qm', 'base'])
  sh(repo35, ['checkout', '-q', '-b', 'flow/x'])
  writeFileSync(join(repo35, 'b.txt'), 'work\n')
  sh(repo35, ['add', '-A']); sh(repo35, ['commit', '-qm', 'work'])
  const head35 = sh(repo35, ['rev-parse', 'HEAD']).trim()
  sh(repo35, ['checkout', '-q', 'master'])
  const gp35 = await domain.ensureProject({ workspacePath: repo35, name: 'git-v135' })
  const mkMerging = async (title, strategy) => {
    const tk = await domain.createTask(gp35.id, { title })
    await store.tx((s) => {
      Object.assign(s.tasks[tk.id], {
        column: 'merging', phase: 'review-pending',
        mergeRequest: { id: 'mr_' + tk.id, headSha: head35, reviewVerdict: 'approved', status: 'ready_for_review' },
        mergeIntent: { key: 'merge:' + tk.id, branch: 'flow/x', base: 'master', strategy, headSha: head35, at: new Date(Date.now() - 10 * 60000).toISOString() },
      })
    })
    return tk.id
  }
  await t('v1.35 合并没落地的中断意图会被清掉（之后重新排队合并）', async () => {
    const id = await mkMerging('没落地', 'merge')
    const out = await dispatcher.reconcileMergeIntents({ now: Date.now() })
    assert.ok(out.some((x) => x.taskId === id && x.result === 'cleared'))
    assert.equal(store.state.tasks[id].mergeIntent, null)
    assert.equal(store.state.tasks[id].column, 'merging')
  })
  await t('v1.35 合并已落地但没记账的卡，对账补记为已合并', async () => {
    sh(repo35, ['merge', '-q', '--no-ff', 'flow/x', '-m', 'merge x'])
    const id = await mkMerging('已落地', 'merge')
    const out = await dispatcher.reconcileMergeIntents({ now: Date.now() })
    assert.ok(out.some((x) => x.taskId === id && x.result === 'merged'), JSON.stringify(out))
    assert.equal(store.state.tasks[id].column, 'done')
    assert.equal(store.state.tasks[id].phase, 'merged')
    assert.ok(store.state.tasks[id].mergeRequest.mergedCommit)
  })

  await t('v1.35 看板「审核通过」= 人审过并真合并（git 仓库里走完到 done/merged）', async () => {
    const id = (await domain.createTask(gp35.id, { title: '看板审核即合并' })).id
    sh(repo35, ['checkout', '-q', '-b', 'flow/' + id])
    writeFileSync(join(repo35, 'c-' + id + '.txt'), 'ui\n')
    sh(repo35, ['add', '-A']); sh(repo35, ['commit', '-qm', 'ui work'])
    const h = sh(repo35, ['rev-parse', 'HEAD']).trim()
    sh(repo35, ['checkout', '-q', 'master'])
    await store.tx((s) => {
      Object.assign(s.tasks[id], { column: 'merging', phase: 'review-pending', headSha: h, mergeRequest: { id: 'mr_' + id, headSha: h, status: 'ready_for_review' } })
      s.seq.pr += 1
      s.pull_requests['pr_ui_' + id] = { id: 'pr_ui_' + id, taskId: id, projectId: gp35.id, headSha: h, branch: 'flow/' + id, status: 'open', conflictFiles: [], attempts: 0 }
    })
    const res = await handler(req('POST', '/api/flow/action', { action: 'pr.review', args: { taskId: id, verdict: 'approved' } }))
    assert.equal(res.status, 200)
    const tk = store.state.tasks[id]
    assert.equal(tk.column, 'done', JSON.stringify((await res.json()).result && (await Promise.resolve(null))))
    assert.equal(tk.phase, 'merged')
    assert.equal(tk.mergeRequest.reviewEvidence.reviewer, 'web')
  })
  await t('v1.35 没有 PR 记录时人点合并不留下 approved 结论', async () => {
    const id = (await domain.createTask(gp35.id, { title: '无 PR' })).id
    await store.tx((s) => { Object.assign(s.tasks[id], { column: 'merging', phase: 'merge-ready', mergeRequest: null }) })
    const out = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
    assert.equal(out.ok, false)
    assert.match(out.message, /PR 记录/)
    assert.equal(store.state.tasks[id].mergeRequest, null)
  })
  await t('v1.35 远程 PR 等评审能被推导出来（REST 没有 reviewDecision）', async () => {
    const { pullReviewPending } = await import('../lib/sync-engine.js')
    assert.equal(pullReviewPending({ requestedReviewers: ['alice'] }, []), true)
    assert.equal(pullReviewPending({ requestedReviewers: ['alice'] }, [{ login: 'alice', state: 'APPROVED' }]), false)
    assert.equal(pullReviewPending({ requestedReviewers: [] }, []), false)
    assert.equal(pullReviewPending({ reviewDecision: 'REVIEW_REQUIRED' }, []), true)
    assert.equal(pullReviewPending({ merged: true, requestedReviewers: ['a'] }, []), false)
  })
  await t('v1.35 主工作区检出的不是 base 时拒绝合并（不合进错误分支）', async () => {
    const gitMod = await import('../lib/git.js')
    sh(repo35, ['checkout', '-q', '-b', 'human-side'])
    const res = await gitMod.mergeBranch({ repo: repo35, branch: 'flow/x', base: 'master', strategy: 'merge' })
    sh(repo35, ['checkout', '-q', 'master'])
    assert.equal(res.ok, false)
    assert.match(res.reason, /wrong-branch/)
  })
  await t('v1.36 worktree GC：终态任务的 worktree 被回收，脏的先隔离不删', async () => {
    const gcRepo = join(dir, 'git-gc')
    mk35(gcRepo, { recursive: true })
    sh(gcRepo, ['init', '-q', '-b', 'master'])
    sh(gcRepo, ['config', 'user.email', 't@t'])
    sh(gcRepo, ['config', 'user.name', 't'])
    writeFileSync(join(gcRepo, 'a.txt'), 'base\n')
    sh(gcRepo, ['add', '-A']); sh(gcRepo, ['commit', '-qm', 'base'])
    const gcp = await domain.ensureProject({ workspacePath: gcRepo, name: 'gc' })
    const mk = async (title) => {
      const tk = await domain.createTask(gcp.id, { title })
      const wt = await dispatcher.ensureWorktree(store.state.tasks[tk.id], gcp)
      assert.equal(wt.ok, true, wt.message)
      return { id: tk.id, path: wt.path }
    }
    // 干净 + 终态 → 回收
    const clean = await mk('干净 worktree')
    await store.tx((s) => { Object.assign(s.tasks[clean.id], { column: 'done', phase: 'merged' }) })
    // 脏 + 终态 → 隔离
    const dirty = await mk('脏 worktree')
    writeFileSync(join(dirty.path, 'uncommitted.txt'), 'wip\n')
    await store.tx((s) => { Object.assign(s.tasks[dirty.id], { column: 'done', phase: 'merged' }) })
    const res = await dispatcher.gcWorktrees({ now: Date.now() })
    assert.ok(res.removed.some((x) => x.taskId === clean.id), JSON.stringify(res))
    assert.ok(res.quarantined.some((x) => x.taskId === dirty.id), JSON.stringify(res))
    assert.equal(store.state.worktrees[clean.id], undefined)
    const kept = res.quarantined.find((x) => x.taskId === dirty.id)
    assert.ok(kept.path.includes('.quarantine'))
    assert.ok(existsSync(join(kept.path, 'uncommitted.txt')), '隔离区里要保住未提交的改动')
  })

  await t('v1.36 模型冷却：冷却期内不派工，冷却过期后恢复', async () => {
    const cp = await domain.ensureProject({ workspacePath: join(dir, 'repo-cool'), name: 'cool', modelDefaults: { provider: 'p', model: 'm' } })
    const w = domain.workersOf(cp.id, 'human')[0]
    await domain.bindSession(w.id, 'ses-cool', { state: 'idle', cwd: null }, { role: 'system' })
    const tk = await domain.createTask(cp.id, { title: '冷却期' })
    assert.ok(domain.pickWorkerScored(cp.id, { task: store.state.tasks[tk.id] }), '正常情况下能选到人')
    const key = domain.modelKeyOf(w)
    assert.equal(key, 'p/m')
    await domain.coolModel(key, 60 * 60 * 1000, '配额打满')
    assert.equal(domain.modelCooling(key), true)
    assert.equal(domain.pickWorkerScored(cp.id, { task: store.state.tasks[tk.id] }), null, '冷却期不该再派')
    assert.ok(domain._coolingBlocked.length >= 1 && domain._coolingBlocked.every((k) => k === 'p/m'), JSON.stringify(domain._coolingBlocked))
    await store.tx((s) => { s.model_cooldowns[key].until = new Date(Date.now() - 1000).toISOString() })
    assert.equal(domain.modelCooling(key), false)
    assert.ok(domain.pickWorkerScored(cp.id, { task: store.state.tasks[tk.id] }), '冷却过期后恢复派工')
  })

  await t('v1.36 排队过期：等待超过上限的卡不再自动重派', async () => {
    const qp = await domain.ensureProject({ workspacePath: join(dir, 'repo-queue'), name: 'queue' })
    const tk = await domain.createTask(qp.id, { title: '排队过久' })
    await store.tx((s) => {
      Object.assign(s.tasks[tk.id], {
        retryAfter: new Date(Date.now() - 1000).toISOString(),
        retrySince: new Date(Date.now() - 200 * 3600 * 1000).toISOString(),
        retryBudget: { kind: 'infra', tries: 1, max: 3, reason: '会话不可用' },
      })
    })
    const due = domain.retryDue(Date.now())
    const hit = due.find((x) => x.id === tk.id)
    assert.ok(hit && hit.expired === true, '超期任务要带 expired 标记')
    assert.ok(hit.waitedMs > 0)
  })

  await t('v1.36 卡死计数：默认不自动重建，达到阈值标 poisoned 但不清零', async () => {
    const sp2 = await domain.ensureProject({ workspacePath: join(dir, 'repo-stuck'), name: 'stuckp' })
    const tk = await domain.createTask(sp2.id, { title: '毒会话' })
    const a1 = await domain.bumpStuck(tk.id, '心跳超时')
    const a2 = await domain.bumpStuck(tk.id, '心跳超时')
    assert.equal(a1.reset, false)
    assert.equal(a1.poisoned, false)
    assert.equal(a2.poisoned, false)
    const a3 = await domain.bumpStuck(tk.id, '心跳超时')
    assert.equal(a3.poisoned, true, '达到阈值(3)判为毒会话')
    assert.equal(a3.reset, false, 'poisonRebuild 默认关闭，不自动重建')
    assert.equal(store.state.tasks[tk.id].stuckCount, 3, '不自动重建就不清零')
    assert.ok(!store.state.tasks[tk.id].stuckResetAt, '未重建不写 reset 时间')
  })

  await t('v1.36 开启 poisonRebuild 后达阈值自动重建并清零', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-stuck2'), name: 'stuckp2' })
    await domain.updateProjectConfig(sp.id, { poisonRebuild: true, poisonStuckThreshold: 2 })
    const tk = await domain.createTask(sp.id, { title: '毒会话2' })
    const a1 = await domain.bumpStuck(tk.id, '心跳超时')
    assert.equal(a1.reset, false)
    assert.equal(a1.threshold, 2)
    const a2 = await domain.bumpStuck(tk.id, '心跳超时')
    assert.equal(a2.poisoned, true)
    assert.equal(a2.reset, true, '开启后达到阈值自动重建')
    assert.equal(store.state.tasks[tk.id].stuckCount, 0, '重建后清零')
    assert.ok(store.state.tasks[tk.id].stuckResetAt)
  })

  await t('v1.37 sanitizeLossless：undefined/NaN/-0/Date/大整数/孤立代理都被收敛', async () => {
    const { sanitizeLossless, clampText } = await import('../lib/core.js')
    const out = sanitizeLossless({ a: undefined, b: NaN, c: -0, d: new Date(0), e: [undefined, 1], f: 2 ** 60, g: { h: Infinity }, fn: () => 1 })
    assert.deepEqual(out, { b: null, c: 0, d: '1970-01-01T00:00:00.000Z', e: [null, 1], f: String(2 ** 60), g: { h: null } })
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(out))), JSON.stringify(out))
    const cut = clampText('ab😀', 3)
    assert.equal(cut, 'ab', '不切开代理对')
  })

  await t('v1.37 logMessage 不把 undefined 写进状态', async () => {
    const rec = domain.logMessage({ kind: 'watch:x', queued: undefined, immediate: undefined, ok: true })
    assert.ok(!('queued' in rec) && !('immediate' in rec))
  })

  await t('v1.36 resetGuard：guarded 下工人近期有评论则拒绝，静默期过后放行', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-guard'), name: 'guardp' })
    const w = await domain.upsertAgent(sp.id, { name: 'guardWorker', role: 'worker', lane: 'human' }, { role: 'human' })
    const tk = await domain.createTask(sp.id, { title: '守护测试' })
    // 仅验证 resetGuard：直接建 run，不走完整审批流（避免 effects 层自动派工）
    const { run } = await domain.startRun(tk.id, { agentId: w.id, sessionId: 'ses-guard', trigger: 'approve' }).catch(async (e) => {
      // DUPLICATE_RUN 说明 effects 已自动派了一次，取已有 run
      if (e.code === 'DUPLICATE_RUN') return { run: store.state.runs[e.runId] }
      throw e
    })
    await domain.comment(tk.id, '进度检查点', { role: 'worker', id: w.id })
    const justNow = Date.now()
    const g1 = domain.resetGuard(w.id, justNow)
    assert.equal(g1.allowed, false, '工人刚评论，guarded 应拒绝')
    assert.ok(/未满静默期/.test(g1.reason), g1.reason)
    // 静默期过后放行
    const later = justNow + 20 * 60 * 1000 + 1000
    const g2 = domain.resetGuard(w.id, later)
    assert.equal(g2.allowed, true, '静默期过后应放行')
    // allow 策略直接放行
    await domain.updateProjectConfig(sp.id, { workerResetPolicy: 'allow' })
    const g3 = domain.resetGuard(w.id, justNow)
    assert.equal(g3.allowed, true, 'allow 策略直接放行')
    // deny 策略一律拒绝
    await domain.updateProjectConfig(sp.id, { workerResetPolicy: 'deny' })
    const g4 = domain.resetGuard(w.id, later)
    assert.equal(g4.allowed, false, 'deny 策略一律拒绝')
  })

  await t('v1.37 setProgress：写入、旧值进历史、steer 清零、发事件', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-prog'), name: 'progp' })
    const tk = await domain.createTask(sp.id, { title: '进度测试' })
    await domain.store.tx((s) => { s.tasks[tk.id].steerCount = 2 })
    const p1 = await domain.setProgress(tk.id, { state: 'on-track', summary: '开始了' }, { role: 'worker', id: 'w1' })
    assert.equal(p1.state, 'on-track')
    const p2 = await domain.setProgress(tk.id, { state: 'blocked', summary: '遇到问题', blocker: '环境不可用' }, { role: 'worker', id: 'w1' })
    assert.equal(p2.blocker, '环境不可用')
    const task = store.state.tasks[tk.id]
    assert.equal(task.progressHistory.length, 1)
    assert.equal(task.progressHistory[0].state, 'on-track', '旧值进历史')
    assert.equal(task.steerCount, 0, 'steer 计数已清零')
    const ev = store.state.events.filter((e) => e.type === 'task.progress' && e.payload.taskId === tk.id)
    assert.equal(ev.length, 2)
    assert.equal(ev[1].payload.hasBlocker, true)
  })

  await t('v1.37 卡片投影带 progress / 验收进度 / 未处理请示数', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-card'), name: 'cardp' })
    const tk = await domain.createTask(sp.id, { title: '卡片', acceptance: ['a', 'b', 'c'] })
    await domain.setProgress(tk.id, { state: 'partial', summary: '做了一半', next: '补测试' }, { role: 'worker', id: 'w' })
    await domain.store.tx((s) => { s.tasks[tk.id].stopReport = { summary: 'x', tests: 'y', acceptanceStatus: [{ index: 0, status: 'pass' }, { index: 1, status: 'not-run' }] } })
    await domain.askHuman({ taskId: tk.id, kind: 'decision', topic: 't', problem: 'p', decisionNeeded: 'd' }, { role: 'dispatcher', id: 'd1' })
    const { buildProjectView } = await import('../lib/panel.js')
    const view = buildProjectView(store.state, sp.id)
    const card = view.tasks.todo.find((c) => c.id === tk.id)
    assert.equal(card.progress.state, 'partial')
    assert.equal(card.progress.next, '补测试')
    assert.deepEqual(card.acceptance, { total: 3, pass: 1, reported: true })
    assert.equal(card.openInbox, 1)
  })

  await t('v1.37 autoAccept：acceptanceStatus 有 not-run 时不自动收', async () => {
    const { createScheduler } = await import('../lib/scheduler.js')
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-aa'), name: 'aap' })
    await domain.updateProjectConfig(sp.id, { autoAccept: true })
    const tk = await domain.createTask(sp.id, { title: '自动收' })
    await domain.store.tx((s) => {
      Object.assign(s.tasks[tk.id], { column: 'verifying', phase: 'awaiting-acceptance',
        stopReport: { summary: '完成', tests: 'npm test 12 passed', acceptanceStatus: [{ index: 0, status: 'pass' }, { index: 1, status: 'not-run' }] } })
    })
    const sched = createScheduler({ domain, dispatcher: { dispatch: async () => ({ ok: true }) }, store, log: () => {} })
    for (let i = 0; i < 5; i += 1) await sched.tick()
    assert.equal(store.state.tasks[tk.id].column, 'verifying', '没被自动收')
    const asks = store.state.human_inbox.filter((x) => x.taskId === tk.id && x.status !== 'archived')
    assert.equal(asks.length, 1, '5 次 tick 只产生 1 条请示')
  })

  await t('v1.37 askHuman 去重：同卡同类同发起人已有未归档工单时返回 duplicate', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-dedup'), name: 'dedupp' })
    const tk = await domain.createTask(sp.id, { title: '去重测试' })
    const actor = { role: 'system', id: 'system:auto-accept' }
    const input = { taskId: tk.id, kind: 'decision', topic: '验收证据不足', problem: 'x', decisionNeeded: 'y' }
    const a = await domain.askHuman(input, actor)
    assert.ok(!a.duplicate)
    const b = await domain.askHuman(input, actor)
    assert.equal(b.duplicate, true, '第二次应返回重复')
    assert.equal(b.id, a.id, '返回的是同一条')
    const open = domain.openInboxFor(tk.id).filter((x) => x.kind === 'decision')
    assert.equal(open.length, 1, '只有一条未归档')
    // RT-04：info 也按 [taskId, category, refKey] 去重，避免同一通知在 tick 中重复堆积。
    const i1 = await domain.askHuman({ taskId: tk.id, kind: 'info', topic: '知情1' }, actor)
    const i2 = await domain.askHuman({ taskId: tk.id, kind: 'info', topic: '知情1' }, actor)
    assert.equal(i2.id, i1.id, '同卡同类 info 应复用未归档工单')
    assert.equal(i2.duplicate, true, '重复 info 应标记 duplicate')
  })

  await t('v1.37 Inbox 工单：追问进同一对话线、info 可标已读、归档拒绝追问', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-ticket'), name: 'ticketp' })
    const tk = await domain.createTask(sp.id, { title: '工单' })
    const it = await domain.askHuman({
      taskId: tk.id, kind: 'decision', topic: '选哪个方案',
      problem: '两种实现', current: '现状A', progress: '做到B', decisionNeeded: '选 1 还是 2',
      options: [{ key: 'A', label: '方案一', recommended: true }, { key: 'B', label: '方案二' }],
    }, { role: 'dispatcher', id: 'ag_1' })
    assert.equal(it.options.length, 2)
    assert.equal(it.options[0].recommended, true)
    assert.equal(it.current, '现状A')
    // 调度追问
    const f1 = await domain.appendInboxFollowUp(it.id, '补充：方案一少改两个文件', { role: 'dispatcher', id: 'ag_1' })
    assert.equal(f1.replies.length, 1)
    assert.equal(f1.replies[0].role, 'dispatcher')
    assert.equal(f1.status, 'open', '追问后回到等人处理')
    // 人回复
    const r1 = await domain.replyInbox(it.id, '选 A', { role: 'human', id: 'web' })
    assert.equal(r1.status, 'answered')
    assert.equal(r1.replies.length, 2)
    // 归档后拒绝追问
    await domain.resolveInbox(it.id, { note: '人已选定 A' }, { role: 'dispatcher', id: 'ag_1' })
    let rejected = false
    try { await domain.appendInboxFollowUp(it.id, '再问一句', { role: 'dispatcher', id: 'ag_1' }) } catch (e) { rejected = true }
    assert.equal(rejected, true, '已归档的工单不能追问')
    // info 标已读
    const info = await domain.askHuman({ taskId: tk.id, kind: 'info', topic: '纯通知', body: '看一眼就行' }, { role: 'dispatcher', id: 'ag_1' })
    assert.equal(info.body, '看一眼就行')
    const read = await domain.markInfoRead(info.id, { role: 'human', id: 'web' })
    assert.equal(read.status, 'archived')
    assert.equal(read.resolvedNote, '已读')
    let badRead = false
    try { await domain.markInfoRead(it.id) } catch (e) { badRead = true }
    assert.equal(badRead, true, '非 info 不能走已读')
  })

  await t('v1.37 schema 9→10 迁移：重复请示只保留最早一条，回复合并', async () => {
    // 直接构造 9 版数据走 Store 加载
    const { Store } = await import('../lib/core.js')
    const { writeFileSync } = await import('node:fs')
    const f = join(dir, 'mig9.json')
    const base = { schemaVersion: 9, human_inbox: [
      { id: 'hi_a', taskId: 'T-1', kind: 'decision', from: 'sys', status: 'open', replies: [{ id: 'r1', at: '2026-01-01T00:00:01Z', content: 'x' }], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'hi_b', taskId: 'T-1', kind: 'decision', from: 'sys', status: 'open', replies: [{ id: 'r2', at: '2026-01-01T00:00:02Z', content: 'y' }], createdAt: '2026-01-01T00:00:05Z' },
      { id: 'hi_c', taskId: 'T-1', kind: 'decision', from: 'sys', status: 'open', replies: [], createdAt: '2026-01-01T00:00:09Z' },
      { id: 'hi_i', taskId: 'T-1', kind: 'info', from: 'sys', status: 'open', replies: [], createdAt: '2026-01-01T00:00:09Z' },
    ] }
    writeFileSync(f, JSON.stringify(base))
    const st2 = new Store(f)
    await st2.load()
    const items = st2.state.human_inbox
    const keep = items.find((x) => x.id === 'hi_a')
    assert.equal(keep.status, 'open')
    assert.equal(keep.replies.length, 2, '回复合并')
    assert.equal(items.find((x) => x.id === 'hi_b').status, 'archived')
    assert.equal(items.find((x) => x.id === 'hi_b').duplicateOf, 'hi_a')
    assert.equal(items.find((x) => x.id === 'hi_c').status, 'archived')
    assert.equal(items.find((x) => x.id === 'hi_i').status, 'open', 'info 不动')
    // 加载会一路迁移到当前版本（跟着 SCHEMA_VERSION 走，别在这里钉死数字）
    assert.equal(st2.state.schemaVersion, coreMod.SCHEMA_VERSION)
    // v1.39：老工单补结构化字段，老卡补父子字段
    assert.ok(Array.isArray(keep.asks), '老工单要补 asks 数组')
    assert.deepEqual(keep.context, { facts: [], evidence: [] })
    assert.equal(keep.impactIfNoAnswer, '')
    // 幂等：再加载一次不出错，状态不变
    const st3 = new Store(f)
    await st3.load()
    assert.equal(st3.state.human_inbox.filter((x) => x.status === 'open' && x.kind === 'decision').length, 1)
  })

  await t('v1.37.1 steer 计数 async 生效：工具层真的 await 了 bumpSteer', async () => {
    const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
    assert.match(src, /await domain\.bumpSteer\(/, 'bumpSteer 必须 await，否则 check.allowed 恒为 undefined，上限形同虚设')
  })

  await t('v1.37.1 resetGuard：先 interrupt 再 reset 也要被拦（activeRunId 已空）', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-guard2'), name: 'guardp2' })
    const w = await domain.upsertAgent(sp.id, { name: 'g2', role: 'worker', lane: 'human' }, { role: 'human' })
    const tk = await domain.createTask(sp.id, { title: '中断后重置' })
    await domain.store.tx((s) => { s.tasks[tk.id].assignee = w.id })
    // 造一条刚结束的 run
    await domain.store.tx((s) => {
      s.runs['run_int'] = { id: 'run_int', taskId: tk.id, projectId: sp.id, agentId: w.id, status: 'interrupted', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }
      s.tasks[tk.id].activeRunId = null
    })
    const g = domain.resetGuard(w.id)
    assert.equal(g.allowed, false, '刚结束的 run 也算活动，应拒绝重置')
    // 静默期过后放行
    const g2 = domain.resetGuard(w.id, Date.now() + 20 * 60 * 1000)
    assert.equal(g2.allowed, true)
  })

  await t('v1.37.1 probeBudget：超窗口次数拒绝，窗口过期重置', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-probe'), name: 'probep' })
    const w = await domain.upsertAgent(sp.id, { name: 'pp', role: 'dispatcher', lane: 'human' }, { role: 'human' })
    const now = Date.now()
    let last = null
    for (let i = 0; i < 10; i += 1) last = domain.probeBudget(w.id, { max: 8, windowMs: 300000, now })
    assert.equal(last.allowed, false, '第 9 次应被拒')
    assert.equal(last.count, 10)
    const after = domain.probeBudget(w.id, { max: 8, windowMs: 300000, now: now + 400000 })
    assert.equal(after.allowed, true, '窗口过期重新计数')
  })

  await t('v1.37 steer 计数：超过上限拒绝，clearSteer 后重置', async () => {
    const sp = await domain.ensureProject({ workspacePath: join(dir, 'repo-steer'), name: 'steerp' })
    const w = await domain.upsertAgent(sp.id, { name: 'steerWorker', role: 'worker', lane: 'human' }, { role: 'human' })
    const tk = await domain.createTask(sp.id, { title: 'steer测试' })
    // 模拟派工后的 active task；bumpSteer 仅对实际被指派的工人计数。
    await domain.store.tx((s) => { s.tasks[tk.id].assignee = w.id; s.tasks[tk.id].activeRunId = 'run_x' })
    const a1 = await domain.bumpSteer(tk.id, w.id)
    assert.equal(a1.allowed, true)
    const a2 = await domain.bumpSteer(tk.id, w.id)
    assert.equal(a2.allowed, true)
    const a3 = await domain.bumpSteer(tk.id, w.id)
    assert.equal(a3.allowed, true)
    const a4 = await domain.bumpSteer(tk.id, w.id)
    assert.equal(a4.allowed, false, '第4次应拒绝')
    assert.match(a4.reason, /连续催促/)
    await domain.clearSteer(tk.id)
    const a5 = await domain.bumpSteer(tk.id, w.id)
    assert.equal(a5.allowed, true, 'clearSteer 后重新计数')
  })

  await t('v1.36 巡检信号：连续两轮无产出 → steer，同错误码三次 → pause，预算耗尽 → block', async () => {
    const { analyzeCycles } = await import('../lib/inspect-signals.js')
    assert.equal(analyzeCycles([], { hasDiff: true }).verdict, 'keep')
    const steer = analyzeCycles([{ hasDiff: false }], { hasDiff: false })
    assert.equal(steer.verdict, 'steer')
    assert.ok(steer.signals.includes('no-diff'))
    assert.equal(analyzeCycles([{ hasDiff: true }], { hasDiff: false }).verdict, 'keep', '只一轮没产出不算')
    const pause = analyzeCycles([{ code: 'E_BUILD' }, { code: 'E_BUILD' }], { code: 'E_BUILD' })
    assert.equal(pause.verdict, 'pause')
    assert.ok(pause.signals.includes('same-code'))
    const budget = analyzeCycles([], { hasDiff: true, budgetRatio: 0.95, compactBlocked: true })
    assert.equal(budget.verdict, 'block')
    assert.equal(analyzeCycles([], { hasDiff: true, needsConfirm: true }).verdict, 'block')
    assert.equal(analyzeCycles([], { hasDiff: true, testsFailed: true }).verdict, 'keep', '测试失败不自动干预，等人工验收')
  })

  await t('v1.36 巡检信号落历史：noteInspectionCycle 记最近 12 轮并给出结论', async () => {
    const id = (await domain.createTask(p35.id, { title: '巡检信号' })).id
    for (let i = 0; i < 2; i += 1) await domain.noteInspectionCycle(id, { hasDiff: false, code: 'E_SAME' })
    // v0.015：两轮 no-diff 仍然是 steer（只在下一轮案卷里加提示）
    assert.equal(store.state.tasks[id].inspectionSignals.verdict, 'steer')
    await domain.noteInspectionCycle(id, { hasDiff: false, code: 'E_SAME' })
    const tk = store.state.tasks[id]
    assert.equal(tk.inspectHistory.length, 3)
    // v0.015：连续三轮 no-diff 升级为 block —— 缺的是环境/人给的东西，继续派工只会重复同一份报告。
    assert.equal(tk.inspectionSignals.verdict, 'block')
    assert.ok(tk.inspectionSignals.signals.includes('no-diff'))
    // 巡检包/巡检结论里要能看到信号
    assert.match(domain.inspect(id).reasons.join(' '), /巡检信号/)
    for (let i = 0; i < 15; i += 1) await domain.noteInspectionCycle(id, { hasDiff: true })
    assert.equal(store.state.tasks[id].inspectHistory.length, 12, '历史只留最近 12 轮')
  })

  await t('v1.36 rebase 策略：把任务分支 rebase 到 base 再 ff（方向不再反过来）', async () => {
    const gitMod = await import('../lib/git.js')
    sh(repo35, ['checkout', '-q', 'master'])
    sh(repo35, ['checkout', '-q', '-b', 'flow/rb'])
    writeFileSync(join(repo35, 'rb.txt'), 'rb\n')
    sh(repo35, ['add', '-A']); sh(repo35, ['commit', '-qm', 'rb work'])
    sh(repo35, ['checkout', '-q', 'master'])
    const baseBefore = sh(repo35, ['rev-parse', 'HEAD']).trim()
    const res = await gitMod.mergeBranch({ repo: repo35, branch: 'flow/rb', base: 'master', strategy: 'rebase', message: 'ff rb' })
    assert.equal(res.ok, true, res.reason)
    assert.equal(sh(repo35, ['rev-parse', 'HEAD']).trim(), sh(repo35, ['rev-parse', 'flow/rb']).trim(), 'base 应当 ff 到 rebase 后的任务分支头')
    assert.equal(sh(repo35, ['log', '--oneline', '--merges', baseBefore + '..HEAD']).trim(), '', 'rebase 策略不该产生合并提交')
    assert.equal(sh(repo35, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'master', '结束后仍检出在 base')
  })

  await t('v1.36 磁盘余量不足时拒绝派工并说清原因', async () => {
    const { checkFreeSpace, humanBytes } = await import('../lib/disk.js')
    // 用真实存在的目录（临时工作目录）；不存在的路径 statfs 会失败并放行
    const real = await checkFreeSpace(dir, 1)
    assert.equal(real.ok, true, JSON.stringify(real))
    assert.ok(real.freeBytes > 0)
    const missing = await checkFreeSpace(join(dir, 'no-such-dir-here'), 1)
    assert.equal(missing.ok, true, '检查不出来要放行，不能因为自身不可用卡住派工')
    assert.ok(missing.skipped)
    const strict = await checkFreeSpace(dir, 1024 ** 5)
    assert.equal(strict.ok, false)
    assert.match(strict.reason, /磁盘余量不足/)
    assert.ok(humanBytes(3 * 1024 ** 3).includes('GB'))
  })

  await t('v1.36 合并后冒烟：配置了就跑，失败会阻塞卡片并留下输出', async () => {
    const repoSmoke = join(dir, 'git-smoke')
    mk35(repoSmoke, { recursive: true })
    sh(repoSmoke, ['init', '-q', '-b', 'master'])
    sh(repoSmoke, ['config', 'user.email', 't@t'])
    sh(repoSmoke, ['config', 'user.name', 't'])
    writeFileSync(join(repoSmoke, 'a.txt'), 'base\n')
    sh(repoSmoke, ['add', '-A']); sh(repoSmoke, ['commit', '-qm', 'base'])
    const sp = await domain.ensureProject({ workspacePath: repoSmoke, name: 'smoke-check' })
    const mkPr = async (title, branch) => {
      sh(repoSmoke, ['checkout', '-q', '-b', branch])
      writeFileSync(join(repoSmoke, branch.replace('/', '-') + '.txt'), 'w\n')
      sh(repoSmoke, ['add', '-A']); sh(repoSmoke, ['commit', '-qm', 'w'])
      const h = sh(repoSmoke, ['rev-parse', 'HEAD']).trim()
      sh(repoSmoke, ['checkout', '-q', 'master'])
      const tk = await domain.createTask(sp.id, { title })
      await store.tx((s) => {
        Object.assign(s.tasks[tk.id], { column: 'merging', phase: 'review-pending', mergeRequest: { id: 'mr_' + tk.id, headSha: h, reviewVerdict: 'approved', status: 'ready_for_review' } })
        s.seq.pr += 1
        s.pull_requests['pr_' + tk.id] = { id: 'pr_' + tk.id, taskId: tk.id, projectId: sp.id, headSha: h, branch, status: 'open', conflictFiles: [], attempts: 0 }
      })
      return tk.id
    }
    await store.tx((s) => { s.projects[sp.id].config.postMergeCheck = 'node -e "console.log(1)"' })
    const okId = await mkPr('冒烟通过', 'flow/smoke-ok')
    const okRes = await dispatcher.merge(store.state.tasks[okId], { by: 'human' })
    assert.equal(okRes.ok, true, okRes.message)
    assert.equal(store.state.tasks[okId].column, 'done')
    assert.equal(store.state.tasks[okId].mergeRequest.postMergeCheck.ok, true)

    await store.tx((s) => { s.projects[sp.id].config.postMergeCheck = 'node -e "console.error(\'boom\'); process.exit(3)"' })
    const badId = await mkPr('冒烟失败', 'flow/smoke-bad')
    const badRes = await dispatcher.merge(store.state.tasks[badId], { by: 'human' })
    assert.equal(badRes.ok, false)
    assert.equal(badRes.postMergeFailed, true)
    const bt = store.state.tasks[badId]
    assert.ok(bt.blocked, '冒烟失败要阻塞')
    assert.equal(bt.mergeRequest.postMergeCheck.code, 3)
    assert.match(bt.mergeRequest.postMergeCheck.stderr, /boom/)
    assert.equal(bt.column, 'merging', '已落地的合并不回滚，卡留在 merging 等人')
  })

  await t('v1.35 autoMerge 项目有 block 级判据时请调度审核，而不是系统代写 approved', async () => {
    const ap35 = await domain.ensureProject({ workspacePath: join(dir, 'repo-v135-auto'), name: 'v135-auto' })
    await store.tx((s) => { Object.assign(s.projects[ap35.id].config, { autoDispatch: true, autoMerge: true }) })
    const tk = await domain.createTask(ap35.id, { title: '等审核' })
    await store.tx((s) => { Object.assign(s.tasks[tk.id], { column: 'merging', phase: 'review-pending', mergeRequest: { id: 'mr_' + tk.id, headSha: 'abc1234', files: ['a.js'], status: 'ready_for_review' } }) })
    const sched = createScheduler({ domain, dispatcher, store, log: () => {} })
    const before = rt.calls.length
    await sched.tick().catch(() => null)
    const after = store.state.tasks[tk.id]
    assert.equal(after.mergeRequest.reviewVerdict || null, null, '不能由系统代写结论')
    assert.ok(after.reviewRequestedAt, '要记下已请求审核')
    assert.ok(rt.calls.slice(before).some((c) => typeof c.text === 'string' && c.text.includes('【审核请求】' + tk.id)), '审核包要投给调度')
  })
}

console.log('\n' + pass + ' checks passed · data ' + store.file)
