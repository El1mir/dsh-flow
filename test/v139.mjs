/**
 * v1.39：去掉 goal + 事件信封 + flow_message（Phase 1）。
 *
 * 不依赖 DSH 运行时：用假的 runtime 把「投递了什么」记下来断言。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher, buildInspectPacket, EVENT_OF_KIND } from '../lib/dispatch.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-v139-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()

const rt = {
  calls: [],
  async ensureSession(agent, project, opts = {}) {
    const rec = domain.latestSession(agent.id)
    if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId }
    const sessionId = 'ses-' + agent.id
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: opts.cwd || null }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession(sessionId, text, mode) {
    this.calls.push({ kind: 'prompt', sessionId, text, mode })
    return { ok: true }
  },
  async steer(_project, { agentId, message }) {
    this.calls.push({ kind: 'steer', agentId, message })
    return { ok: true }
  },
  async cancelSession(sessionId) { this.calls.push({ kind: 'cancel', sessionId }); return { ok: true } },
  async clearWorkerGoal(agentId) { this.calls.push({ kind: 'clearGoal', agentId }); return { ok: true, cleared: true } },
  async workerGoal(_p, args) { this.calls.push({ kind: 'goal', args }); return { ok: true } },
  async onMoved(task, action) { return dispatcher.onMoved(task, action) },
  async onStopped(task) { return dispatcher.onStopped(task) },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })

let pass = 0
const fails = []
async function t(name, fn) {
  try { const r = await fn(); pass += 1; console.log('  ✓ ' + name); return r }
  catch (err) { fails.push(name + ': ' + (err && err.message)); console.log('  ✗ ' + name + '\n      ' + (err && err.message)) }
}

const skillDir = join(dir, 'repo', '.agents', 'skills', 'grilling')
mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), '# Grilling fixture\nAsk questions and send replies using flow_message.')
const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'v139' })
const worker = Object.values(store.state.agents).find((a) => a.projectId === proj.id && a.role === 'worker')
const dispatcherAgent = Object.values(store.state.agents).find((a) => a.projectId === proj.id && a.role === 'dispatcher')
const task = await domain.createTask(proj.id, { title: '去 goal 验证', acceptance: ['a'] })
await domain.move(task.id, 'claim', { role: 'human', id: 'web' })

// ---- A：派工不再建 goal ---------------------------------------------------
const run = await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-' + worker.id, trigger: 'approve' })
await t('派工清残留 goal、绝不新建 goal', async () => {
  await domain.endRun(task.id, 'stopped', { runId: run.run.id })
  rt.calls.length = 0
  const res = await dispatcher.dispatch(store.state.tasks[task.id])
  assert.ok(res, 'dispatch 要有返回')
  assert.equal(rt.calls.find((c) => c.kind === 'goal'), undefined, '不能再建 goal')
  const cleared = rt.calls.find((c) => c.kind === 'clearGoal')
  assert.ok(cleared, '要清掉旧会话上残留的 goal，实际：' + JSON.stringify(rt.calls.map((c) => c.kind)))
  await domain.endRun(task.id, 'stopped', { runId: store.state.tasks[task.id].activeRunId })
})

// ---- B：事件信封 -----------------------------------------------------------
await t('事件信封：头部是事件类型 + 卡号 + runId，带报告、系统建议和可选动作', () => {
  const cur = Object.assign({}, store.state.tasks[task.id], { stopReport: { summary: '做完了', tests: 'npm test 通过', files: 'a.js' } })
  const pkt = buildInspectPacket(cur, '工人自停', { verdict: 'keep', reasons: ['证据齐'] }, { kind: 'stop', runId: 'run_1', workerName: '工人1' })
  assert.match(pkt, /【事件 worker\.stopped】/)
  assert.match(pkt, /run_1/)
  assert.match(pkt, /【停止报告】/)
  assert.match(pkt, /【系统建议】keep/)
  assert.match(pkt, /【你的选择】/)
  assert.match(pkt, /结束本轮/)
  assert.doesNotMatch(pkt, /【巡检请求/, '旧格式不能残留')
})

await t('事件类型映射：停止/阻塞/静默/失败/中止/交接各归各类', () => {
  for (const [kind, want] of Object.entries({ stop: 'worker.stopped', 'session-failed': 'worker.failed', 'session-stopped': 'worker.aborted', 'turn-silent': 'worker.turn-ended-silent', handoff: 'worker.handoff', claim: 'task.claimed' })) {
    assert.equal(EVENT_OF_KIND[kind], want, kind + ' 要映射到 ' + want)
    const pkt = buildInspectPacket(store.state.tasks[task.id], '触发', { verdict: 'keep', reasons: [] }, { kind })
    assert.match(pkt, new RegExp('【事件 ' + want.replace('.', '\\.') + '】'))
  }
})

// ---- C：flow_message（handoff） -------------------------------------------
await t('工人 → 调度：包装成 worker.handoff 事件投给同车道调度员', async () => {
  rt.calls.length = 0
  const res = await dispatcher.handoff(store.state.tasks[task.id], { to: 'dispatcher', content: '结论：A 方案可行，B 需要你定', from: worker.id, kind: 'question' })
  assert.equal(res.ok, true, JSON.stringify(res))
  await dispatcher.aggregator.flushAll('test')
  const sent = rt.calls.find((c) => c.kind === 'prompt' && c.text && c.text.includes('【事件 worker.handoff】'))
  assert.ok(sent, '要把交接消息投给调度员，实际：' + JSON.stringify(rt.calls.map((c) => c.kind)))
  assert.match(sent.text, /A 方案可行/)
  assert.equal(sent.sessionId, domain.latestSession(dispatcherAgent.id).sessionId)
})

await t('同一条消息不重复投递（幂等键）', async () => {
  const res = await dispatcher.handoff(store.state.tasks[task.id], { to: 'dispatcher', content: '结论：A 方案可行，B 需要你定', from: worker.id, kind: 'question' })
  assert.equal(res.duplicate, true)
})

await t('handoff 落 message_log（kind=handoff），用于判断"本轮汇报过"', () => {
  const rec = (store.state.message_log || []).find((m) => m.kind === 'handoff' && m.taskId === task.id)
  assert.ok(rec, '要记一条 handoff 日志')
  assert.equal(rec.fromAgentId, worker.id)
})

await t('调度 → 工人：有在跑的 run 时走 steer', async () => {
  if (store.state.tasks[task.id].activeRunId) await domain.endRun(task.id, 'stopped', { runId: store.state.tasks[task.id].activeRunId })
  await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-' + worker.id, trigger: 'approve' })
  rt.calls.length = 0
  const res = await dispatcher.handoff(store.state.tasks[task.id], { to: 'worker', content: '先补测试再停', from: dispatcherAgent.id, kind: 'instruction' })
  assert.equal(res.ok, true, JSON.stringify(res))
  const steered = rt.calls.find((c) => c.kind === 'steer')
  assert.ok(steered, '有 run 要 steer 而不是重新派工')
  assert.match(steered.message, /先补测试再停/)
  await domain.endRun(task.id, 'stopped', { runId: store.state.tasks[task.id].activeRunId })
})

await t('调度 → 工人：没有 run 时把消息注入下一轮案卷', async () => {
  const t2 = await domain.createTask(proj.id, { title: '注入验证' })
  await domain.move(t2.id, 'claim', { role: 'human', id: 'web' })
  await domain.setPlan(t2.id, '计划：加导出', { role: 'dispatcher', id: dispatcherAgent.id })
  await domain.move(t2.id, 'plan_ready', { role: 'dispatcher', id: dispatcherAgent.id })
  await domain.move(t2.id, 'approve_by_dispatcher', { role: 'dispatcher', id: dispatcherAgent.id })
  // 派工后会有在跑的 run：先收掉，才能验证"没有 run 时注入下一轮案卷"这条分支
  const live = store.state.tasks[t2.id].activeRunId
  if (live) await domain.endRun(t2.id, 'stopped', { runId: live })
  const injected = await domain.injectionsFor(t2.id, { kind: 'context' })
  const before = injected.length
  const res = await dispatcher.handoff(store.state.tasks[t2.id], { to: 'worker', content: '范围加上导出', from: dispatcherAgent.id, kind: 'instruction' })
  assert.ok(res.ok, JSON.stringify(res))
  const after = await domain.injectionsFor(t2.id, { kind: 'context' })
  assert.equal(after.length, before + 1, '要注入到下一轮案卷')
  assert.match(after[after.length - 1].content, /范围加上导出/)
})

// ---- D：结构化 Inbox（Phase 2） -------------------------------------------
const inboxTask = await domain.createTask(proj.id, { title: 'Inbox 结构化验证' })

await t('askHuman：asks 必填校验（缺 question / why / choice 选项不够都拒）', async () => {
  await assert.rejects(() => domain.askHuman({ taskId: inboxTask.id, kind: 'decision', topic: 'x', problem: 'p', decisionNeeded: 'd', asks: [{ key: 'q1', why: 'w' }] }, { role: 'dispatcher', id: 'ag_x' }), /question/)
  await assert.rejects(() => domain.askHuman({ taskId: inboxTask.id, kind: 'decision', topic: 'x', problem: 'p', decisionNeeded: 'd', asks: [{ key: 'q1', question: 'q' }] }, { role: 'dispatcher', id: 'ag_x' }), /why/)
  await assert.rejects(() => domain.askHuman({ taskId: inboxTask.id, kind: 'decision', topic: 'x', problem: 'p', decisionNeeded: 'd', asks: [{ key: 'q1', question: 'q', why: 'w', type: 'choice', choices: [{ value: 'A', label: 'a' }] }] }, { role: 'dispatcher', id: 'ag_x' }), /至少要 2 个选项/)
  // 没有 asks 但有 decisionNeeded → 自动生成一条确认项（系统内部调用方走这条路），不报错
  const autoAsk = await domain.askHuman({ taskId: inboxTask.id, kind: 'decision', topic: '自动补一条', problem: 'p', decisionNeeded: 'd' }, { role: 'dispatcher', id: 'ag_z' })
  assert.equal(autoAsk.asks.length, 1, '缺 asks 时要从 decisionNeeded 兜底生成')
  assert.equal(autoAsk.asks[0].type, 'confirm')
  // 连 decisionNeeded 都没有 → 一条 ask 都生成不出来 → 拒
  await assert.rejects(() => domain.askHuman({ taskId: inboxTask.id, kind: 'decision', topic: 'x', problem: 'p', decisionNeeded: '' }), /不能为空/)
})

const structured = await t('askHuman：结构化字段完整落库（asks / context / impactIfNoAnswer）', async () => {
  const it = await domain.askHuman({
    taskId: inboxTask.id, kind: 'risk', topic: '要动公共接口',
    problem: 'retry 返回 void', decisionNeeded: '改不改接口形状',
    context: { facts: ['调用方 3 处'], evidence: [{ kind: 'file', ref: 'services/note.ts:42' }] },
    impactIfNoAnswer: '这张卡停在待决策',
    asks: [
      { key: 'q1', question: '返回类型选哪个', why: '公共接口要人拍板', type: 'choice', choices: [{ value: 'A', label: 'Result' }, { value: 'B', label: 'void' }], default: 'A', defaultReason: '调用方要失败数', required: true, blocks: '定不下接口' },
      { key: 'q2', question: '上限多少', why: '超限要告警', type: 'number', required: false },
    ],
  }, { role: 'dispatcher', id: 'ag_x' })
  assert.equal(it.asks.length, 2)
  assert.equal(it.asks[0].type, 'choice')
  assert.equal(it.asks[0].choices.length, 2)
  assert.deepEqual(it.asks[0].default, 'A')
  assert.deepEqual(it.context.facts, ['调用方 3 处'])
  assert.equal(it.context.evidence[0].ref, 'services/note.ts:42')
  assert.equal(it.impactIfNoAnswer, '这张卡停在待决策')
  assert.equal(it.asks[1].required, false)
  return it
})
const item = structured

await t('replyInbox：填了的答案逐项校验（选项非法仍拒），没答的只记 missing 不拦人', async () => {
  await assert.rejects(() => domain.replyInbox(item.id, '', { role: 'human', id: 'web' }, { answers: { q1: 'Z' } }), /不在选项里/)
  // v1.39.1：选项是可选的 —— 必答项没答也让人发（人会只写一句补充说明）
  const partial = await domain.replyInbox(item.id, '先按选填的来', { role: 'human', id: 'web' }, { answers: { q2: '5' } })
  const lastP = partial.replies[partial.replies.length - 1]
  assert.deepEqual(lastP.answers, { q2: '5' })
  assert.deepEqual(lastP.missing, ['q1'], '没答的必答项要随回复带出，供调度决定要不要追问')
})

await t('replyInbox：答案结构化落库，状态转 answered', async () => {
  const after = await domain.replyInbox(item.id, '补充：先只改内部调用', { role: 'human', id: 'web' }, { answers: { q1: 'A', q2: '3' } })
  assert.equal(after.status, 'answered')
  const last = after.replies[after.replies.length - 1]
  assert.deepEqual(last.answers, { q1: 'A', q2: '3' })
  assert.deepEqual(last.missing, [], '都答了就没有缺失项')
  assert.match(last.content, /先只改内部调用/)
})

await t('兼容：只传 options 的老调用方，自动转成一条选择题 ask', async () => {
  const legacy = await domain.askHuman({
    taskId: inboxTask.id, kind: 'decision', topic: '老的选项式请示', problem: 'p', decisionNeeded: 'd',
    options: [{ key: 'A', label: '甲', detail: '代价 x', recommended: true }, { key: 'B', label: '乙', detail: '代价 y' }],
  }, { role: 'dispatcher', id: 'ag_y' })
  assert.equal(legacy.asks.length, 1)
  assert.equal(legacy.asks[0].type, 'choice')
  assert.equal(legacy.asks[0].choices.length, 2)
  assert.equal(legacy.asks[0].default, 'A', 'recommended 要变成默认推荐')
})

await t('兼容：系统规则类请示（没有 asks/options）自动生成一条确认项', async () => {
  const auto = await domain.askHuman({
    taskId: inboxTask.id, kind: 'blocked', topic: '卡住了', problem: '会话失败', decisionNeeded: '要不要换模型重派',
  }, { role: 'system', id: 'system:auto-accept' })
  assert.equal(auto.asks.length, 1)
  assert.equal(auto.asks[0].type, 'confirm')
  assert.match(auto.asks[0].question, /要不要换模型重派/)
})

await t('upgradeInboxItem：老工单读侧补齐 asks/context，界面不用判空', async () => {
  const { upgradeInboxItem } = await import('../lib/domain/inbox.js')
  const old = { id: 'hi_old', kind: 'decision', options: [{ key: 'A', label: '甲' }, { key: 'B', label: '乙' }] }
  const up = upgradeInboxItem(old)
  assert.equal(up.asks.length, 1)
  assert.deepEqual(up.context, { facts: [], evidence: [] })
  assert.equal(up.impactIfNoAnswer, '')
})

// ---- E：拆分（父卡 → 子卡）+ 依赖 + 汇总（Phase 4） ----------------------
const splitParent = await domain.createTask(proj.id, { title: '拆分验证', note: '大需求', acceptance: ['整体可用'] })
await domain.move(splitParent.id, 'claim', { role: 'human', id: 'web' })

await t('splitTask 校验：少于 2 项 / 缺字段 / 范围重叠无依赖 / 依赖成环 都要拒', async () => {
  const base = { title: 'x', purpose: 'p', scope: { paths: ['src/a'] }, effect: 'e', acceptance: ['a'] }
  await assert.rejects(() => domain.splitTask(splitParent.id, { items: [base] }), /至少要 2 项/)
  await assert.rejects(() => domain.splitTask(splitParent.id, { items: [{ title: 'x', scope: { paths: ['src/a'] }, effect: 'e', acceptance: ['a'] }, base] }), /缺 purpose/)
  await assert.rejects(() => domain.splitTask(splitParent.id, { items: [{ title: 'x', purpose: 'p', effect: 'e', acceptance: ['a'] }, base] }), /缺 scope/)
  await assert.rejects(() => domain.splitTask(splitParent.id, { items: [{ title: 'x', purpose: 'p', scope: { paths: ['src/a'] }, effect: 'e' }, base] }), /缺 acceptance/)
  // 范围重叠但没声明先后 → 拒（两个工人会改同一片代码）
  await assert.rejects(() => domain.splitTask(splitParent.id, {
    items: [{ ...base, title: 'A', scope: { paths: ['src/a'] } }, { ...base, title: 'B', scope: { paths: ['src/a/b.ts'] } }],
  }), /范围重叠/)
  // 依赖成环
  await assert.rejects(() => domain.splitTask(splitParent.id, {
    items: [{ ...base, title: 'A', scope: { paths: ['src/a'] }, dependsOn: [2] }, { ...base, title: 'B', scope: { paths: ['src/b'] }, dependsOn: [1] }],
  }), /成环/)
})

let split = null
await t('splitTask 成功：建出子卡、父卡进 split、子卡带工单且不上看板', async () => {
  split = await domain.splitTask(splitParent.id, {
    reason: '影响两个模块，可以并行',
    items: [
      { title: '后端返回 Result', purpose: '让调用方能拿到失败数', current: 'retryFailedTasks 返回 void', scope: { paths: ['src/backend/retry.ts'] }, effect: '后端调用方 3 处', acceptance: ['返回 Result', '测试通过'], testCmd: 'npm test' },
      { title: '前端展示失败数', purpose: '把失败数显示出来', scope: { paths: ['src/web/panel.tsx'] }, effect: '设置页', acceptance: ['显示失败数'], dependsOn: [1] },
    ],
  })
  assert.equal(split.children.length, 2)
  assert.equal(split.parent.childIds.length, 2)
  assert.equal(split.parent.phase, 'split')
  const [a, b] = split.children
  assert.equal(a.parentId, splitParent.id)
  assert.equal(a.hiddenOnBoard, true, '子卡不上看板')
  assert.equal(a.column, 'planning')
  assert.equal(a.plan.revision, 1, '子树带计划 rev1（工单）')
  assert.match(a.plan.text, /修改目的/)
  assert.match(a.plan.text, /验收范围/)
  assert.deepEqual(a.acceptance, ['返回 Result', '测试通过'])
  assert.deepEqual(b.dependsOn, [a.id], '依赖要换成真实子卡 id')
  // 父卡计划变成拆分表
  assert.match(split.parent.plan.text, /拆分表/)
  assert.match(split.parent.plan.text, new RegExp(a.id))
})

await t('splitTask 拒绝重复拆分与已派工的卡', async () => {
  await assert.rejects(() => domain.splitTask(splitParent.id, {
    items: [{ title: 'x', purpose: 'p', scope: { paths: ['s/a'] }, effect: 'e', acceptance: ['a'] }, { title: 'y', purpose: 'p', scope: { paths: ['s/b'] }, effect: 'e', acceptance: ['b'] }],
  }), /已经拆过/)
})

await t('看板投影：子卡被隐藏、父卡带子任务进度', async () => {
  const { buildProjectView } = await import('../lib/panel.js')
  const view = buildProjectView(store.state, proj.id)
  const all = Object.values(view.tasks).flat()
  assert.equal(all.filter((t) => t.parentId === splitParent.id).length, 0, '子卡不该出现在看板列里')
  const parentCard = all.find((t) => t.id === splitParent.id)
  assert.ok(parentCard, '父卡要在看板上')
  assert.deepEqual(parentCard.childProgress, { done: 0, total: 2 })
})

await t('dispatch 守卫：父卡永不派工', async () => {
  const res = await dispatcher.dispatch(store.state.tasks[splitParent.id])
  assert.equal(res.ok, false)
  assert.match(res.message, /已拆成 2 个子任务/)
  assert.equal(store.state.tasks[splitParent.id].activeRunId, null)
})

await t('dispatch 守卫：依赖没完成的子卡不派，phase=waiting-deps', async () => {
  const [a, b] = split.children.map((c) => store.state.tasks[c.id])
  void a
  const res = await dispatcher.dispatch(store.state.tasks[b.id])
  assert.equal(res.ok, false)
  assert.equal(res.waiting, true)
  assert.match(res.message, /等待前置子卡/)
  assert.equal(store.state.tasks[b.id].phase, 'waiting-deps')
})

await t('分派打散：同一父卡的兄弟子卡优先给不同工人', async () => {
  const workers = Object.values(store.state.agents).filter((x) => x.projectId === proj.id && x.role === 'worker')
  assert.ok(workers.length >= 2, '这个项目要有 2 个工人才能验证打散')
  // 打散只在"还有空闲工人"时才成立：先收掉前面用例留下的在跑 run
  for (const r of Object.values(store.state.runs)) {
    if (r.status !== 'running') continue
    const tk = store.state.tasks[r.taskId]
    if (tk) await domain.endRun(tk.id, 'stopped', { runId: r.id }).catch(() => null)
  }
  // 两张不重叠的兄弟子卡
  const p2 = await domain.createTask(proj.id, { title: '打散验证' })
  await domain.move(p2.id, 'claim', { role: 'human', id: 'web' })
  const sp = await domain.splitTask(p2.id, {
    items: [
      { title: 'A 模块', purpose: 'p', scope: { paths: ['m/a'] }, effect: 'e', acceptance: ['a'] },
      { title: 'B 模块', purpose: 'p', scope: { paths: ['m/b'] }, effect: 'e', acceptance: ['b'] },
    ],
  })
  const [c1, c2] = sp.children
  const pick1 = domain.pickWorkerScored(proj.id, { task: store.state.tasks[c1.id], siblingOf: p2.id })
  // 把第一张标记成已派给 pick1，再选第二张
  store.state.tasks[c1.id].assignee = pick1.agent.id
  const pick2 = domain.pickWorkerScored(proj.id, { task: store.state.tasks[c2.id], siblingOf: p2.id })
  assert.notEqual(pick2.agent.id, pick1.agent.id, '兄弟子卡要分给不同工人（打散）')
  assert.equal(pick2.spread, true)
})

await t('rollupParent：子卡全部完成后父卡进待验收并发 children-done 事件', async () => {
  // 合并链路需要真 git 仓库；单测里直接摆子卡终态（rollup 只读 column）
  for (const c of split.children) {
    store.state.tasks[c.id].column = 'done'
    store.state.tasks[c.id].updatedAt = new Date().toISOString()
  }
  rt.calls.length = 0
  const res = await dispatcher.rollupParent(store.state.tasks[split.children[0].id])
  assert.equal(res.rolledUp, true, JSON.stringify(res))
  const parent = store.state.tasks[splitParent.id]
  assert.equal(parent.column, 'verifying', '父卡要进待验收')
  assert.equal(parent.noMerge, true, '父卡不合并')
  await dispatcher.aggregator.flushAll('test')
  const pkt = rt.calls.find((c) => c.text && c.text.includes('【事件 task.children-done】'))
  assert.ok(pkt, '要通知调度父卡可以收口了')
})

await t('rollupParent：还有子卡没完成时不动父卡', async () => {
  const p3 = await domain.createTask(proj.id, { title: '半完成验证' })
  await domain.move(p3.id, 'claim', { role: 'human', id: 'web' })
  const sp = await domain.splitTask(p3.id, {
    items: [
      { title: 'A', purpose: 'p', scope: { paths: ['h/a'] }, effect: 'e', acceptance: ['a'] },
      { title: 'B', purpose: 'p', scope: { paths: ['h/b'] }, effect: 'e', acceptance: ['b'] },
    ],
  })
  store.state.tasks[sp.children[0].id].column = 'done'
  const res = await dispatcher.rollupParent(store.state.tasks[sp.children[0].id])
  assert.equal(res.waiting, 1)
  assert.equal(store.state.tasks[p3.id].column, 'planning', '父卡不该动')
})

// ---- F：需求评审（grill） ---------------------------------------------------
await t('grillStart：投给需求评审工位并把状态置为 running，超轮数拒绝', async () => {
  const gt = await domain.createTask(proj.id, { title: '评审验证' })
  await domain.move(gt.id, 'claim', { role: 'human', id: 'web' })
  rt.calls.length = 0
  const r1 = await dispatcher.grillStart(store.state.tasks[gt.id], { draft: '八问草稿：目的=…，范围=…', reason: '影响 3 个模块' })
  assert.equal(r1.ok, true, JSON.stringify(r1))
  assert.equal(r1.round, 1)
  const sent = rt.calls.find((c) => c.kind === 'prompt' && c.text && c.text.includes('【需求评审 ' + gt.id + '】'))
  assert.ok(sent, '要投给评审工位')
  assert.match(sent.text, /八问草稿/)
  assert.equal(store.state.tasks[gt.id].grill.status, 'running')
  // 进行中不重复开
  const r2 = await dispatcher.grillStart(store.state.tasks[gt.id], { draft: 'x' })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /正在进行中/)
  return gt
})

await t('grillVerdict：settled 落库；escalate 必须写 openForHuman', async () => {
  const gt = Object.values(store.state.tasks).filter((t) => t.title === '评审验证').pop()
  await assert.rejects(async () => {
    const r = await dispatcher.grillVerdict(store.state.tasks[gt.id], { verdict: 'escalate', openForHuman: [] })
    if (!r.ok) throw new Error(r.message)
  }, /openForHuman/)
  const ok1 = await dispatcher.grillVerdict(store.state.tasks[gt.id], { verdict: 'settled', settled: ['返回 Result', '不改前端'] })
  assert.equal(ok1.ok, true)
  assert.equal(store.state.tasks[gt.id].grill.verdict, 'settled')
  assert.deepEqual(store.state.tasks[gt.id].grill.settled, ['返回 Result', '不改前端'])
  const esc = await dispatcher.grillVerdict(store.state.tasks[gt.id], { verdict: 'escalate', openForHuman: [{ question: '要不要改数据格式', why: '不可回滚' }] })
  assert.equal(esc.openForHuman, 1)
})

await t('需求评审工位自动补齐（每个项目一个，身份名「需求评审」）', () => {
  const g = Object.values(store.state.agents).filter((a) => a.projectId === proj.id && a.role === 'griller')
  assert.equal(g.length, 1)
  assert.equal(g[0].name, '需求评审')
})

await t('griller 的系统提示词含按设计树提问与不要自循环', async () => {
  const { systemRulesFor } = await import('../lib/prompts.js')
  const t2 = systemRulesFor('griller')
  assert.match(t2, /需求评审/)
  assert.match(t2, /frontier/)
  assert.match(t2, /不要自循环|结束本轮/)
  assert.match(t2, /escalate/)
})

// ---- G：schema 10 → 11 -----------------------------------------------------
await t('schema 10→11：老卡补 parentId/childIds/ticket，老工单补结构化字段', async () => {
  const { Store } = await import('../lib/core.js')
  const { writeFileSync } = await import('node:fs')
  const f = join(dir, 'mig10.json')
  writeFileSync(f, JSON.stringify({
    schemaVersion: 10,
    tasks: { 'T-1': { id: 'T-1', projectId: 'p', title: '老卡', column: 'todo' } },
    human_inbox: [{ id: 'hi_x', projectId: 'p', kind: 'decision', status: 'open', topic: 't', replies: [] }],
  }))
  const st = new Store(f)
  await st.load()
  assert.equal(st.state.schemaVersion, (await import('../lib/core.js')).SCHEMA_VERSION)
  const task = st.state.tasks['T-1']
  assert.equal(task.parentId, null)
  assert.deepEqual(task.childIds, [])
  assert.equal(task.ticket, null)
  assert.equal(task.hiddenOnBoard, false)
  const item = st.state.human_inbox[0]
  assert.deepEqual(item.asks, [])
  assert.deepEqual(item.context, { facts: [], evidence: [] })
  assert.equal(item.impactIfNoAnswer, '')
})

// ---- H：schema 11 → 12（v0.002 / ADR-0005 与 ADR-0006） ---------------------
//
// 这条迁移的行为增量必须是零：只补字段，needsMerge 仍读 noMerge。
// 归类错会把故障卡错标成"本来就不用合"，比不迁移更糟，所以要逐条钉住。
await t('schema 11→12：noMerge 归类成 mergeState，worktree 补 state/patchPath', async () => {
  const { Store } = await import('../lib/core.js')
  const { writeFileSync } = await import('node:fs')
  const f = join(dir, 'mig11.json')
  writeFileSync(f, JSON.stringify({
    schemaVersion: 11,
    tasks: {
      'T-ok': { id: 'T-ok', projectId: 'p', title: '要合并的卡', column: 'reviewing', noMerge: false },
      'T-readonly': { id: 'T-readonly', projectId: 'p', title: '只读审计', column: 'done', noMerge: true, noMergeReason: '只读审计，没有代码改动' },
      'T-busy': { id: 'T-busy', projectId: 'p', title: '分支被占', column: 'todo', noMerge: true, noMergeReason: "fatal: 'flow/T-busy' is already used by worktree at 'C:/x'" },
      'T-nocommit': { id: 'T-nocommit', projectId: 'p', title: '空仓库', column: 'todo', noMerge: true, noMergeReason: 'fatal: invalid reference: HEAD' },
    },
    worktrees: {
      'T-ok': { taskId: 'T-ok', projectId: 'p', path: 'C:/x/T-ok', branch: 'flow/T-ok', baseSha: null, state: 'ready', sharedDirs: [], createdAt: '2026-01-01T00:00:00Z' },
      'T-legacy': { taskId: 'T-legacy', projectId: 'p', path: 'C:/x/T-legacy', branch: 'flow/T-legacy', baseSha: null, sharedDirs: [], createdAt: '2026-01-01T00:00:00Z' },
    },
  }))
  const st = new Store(f)
  await st.load()
  assert.equal(st.state.schemaVersion, (await import('../lib/core.js')).SCHEMA_VERSION)
  const ok = st.state.tasks['T-ok']
  assert.equal(ok.mergeState, 'ready', '没有 noMerge 的卡是 ready')
  assert.equal(ok.mergeReason, null)
  assert.equal(ok.noMerge, false, '旧字段必须保留（I-12 之前 needsMerge 还读它）')
  assert.equal(st.state.tasks['T-readonly'].mergeState, 'none', '只读卡静默，不显形')
  assert.equal(st.state.tasks['T-readonly'].mergeReason, 'no-code-change')
  assert.equal(st.state.tasks['T-busy'].mergeState, 'blocked', '分支被占是故障，不能标成不用合')
  assert.equal(st.state.tasks['T-busy'].mergeReason, 'branch-busy')
  assert.equal(st.state.tasks['T-nocommit'].mergeReason, 'no-commits')
  assert.equal(st.state.worktrees['T-ok'].state, 'ready')
  assert.equal(st.state.worktrees['T-ok'].patchPath, null)
  assert.equal(st.state.worktrees['T-legacy'].state, 'ready', '历史记录缺 state 要补')
  // 幂等：再加载一次不报错、归类不被重算成别的东西
  const st2 = new Store(f)
  await st2.load()
  assert.equal(st2.state.tasks['T-busy'].mergeReason, 'branch-busy')
})

await t('schema 11→12：setNoMerge 走同一套归类，不写出第二种枚举', async () => {
  const { Store } = await import('../lib/core.js')
  const { FlowDomain, MERGE_STATES } = await import('../lib/domain.js')
  const { writeFileSync } = await import('node:fs')
  const f = join(dir, 'mig11b.json')
  writeFileSync(f, JSON.stringify({
    schemaVersion: 11,
    projects: { p: { id: 'p', title: 'P', workspacePath: dir, config: {} } },
    tasks: { 'T-1': { id: 'T-1', projectId: 'p', title: '卡', column: 'todo', noMerge: false } },
  }))
  const store = new Store(f)
  await store.load()
  const domain = new FlowDomain(store)
  // 线上 T-043 的真实文本：分类必须是 branch-busy，而不是 no-code-change
  await domain.setNoMerge('T-1', true, "fatal: 'flow/T-1' is already used by worktree at 'C:/x'")
  const task = store.state.tasks['T-1']
  assert.equal(task.mergeState, 'blocked')
  assert.equal(task.mergeReason, 'branch-busy')
  // blocked 也算"现在不能合"：noMerge=true 让验收直接落 done-no-merge，
  assert.ok(MERGE_STATES.includes(task.mergeState))
  await domain.setNoMerge('T-1', false)
  assert.equal(store.state.tasks['T-1'].mergeState, 'ready')
})

console.log('')
if (fails.length) { console.log(fails.length + ' 项失败'); process.exit(1) }
console.log('v1.39 ok (' + pass + ' checks)')
