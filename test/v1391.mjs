/**
 * v1.39.1 回归：三个线上问题的"红→绿"回路。
 *
 * 1) Inbox 只写补充说明、一个选项都不选，也必须能回复（用户明确：选项不是必填）。
 * 2) 对票（Inbox 工单）的回复必须真的唤醒一个代理，并且在票里留得下回应。
 * 3) worker 没做完就停（停止生成 / 会话失败），调度必须收到 —— 不能被去重键吃掉。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-v1391-'))
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
    this.calls.push({ kind: 'prompt', sessionId, text: String(text), mode })
    return { ok: true }
  },
  async cancelSession(sessionId) { this.calls.push({ kind: 'cancel', sessionId }); return { ok: true } },
  async clearWorkerGoal(agentId) { return { ok: true, cleared: false } },
  async workerGoal() { this.calls.push({ kind: 'goal' }); return { ok: true } },
  async onMoved(task, action) { return dispatcher.onMoved(task, action) },
  async onStopped(task) { return dispatcher.onStopped(task) },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push(name + ': ' + (err && err.message)); console.log('  ✗ ' + name + '\n      ' + (err && err.message)) }
}

const proj = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'v1391' })
const worker = Object.values(store.state.agents).find((a) => a.projectId === proj.id && a.role === 'worker')
const dispAgent = Object.values(store.state.agents).find((a) => a.projectId === proj.id && a.role === 'dispatcher')
const task = await domain.createTask(proj.id, { title: '三个线上问题', acceptance: ['a'] })
await domain.move(task.id, 'claim', { role: 'human', id: 'web' })

const ASKS = [
  { key: 'q1', question: '返回类型选哪个', why: '公开接口要人拍板', type: 'choice', required: true,
    choices: [{ value: 'A', label: '返回 Result' }, { value: 'B', label: '保持 void' }] },
  { key: 'q2', question: '失败数上限多少', why: '超限要告警', type: 'number', required: false },
]

// ---- 1：只写补充说明（一个选项都不选） -------------------------------------
const asked = await domain.askHuman({
  taskId: task.id, kind: 'decision', topic: '要不要改返回类型',
  problem: '改返回类型会动到 3 个调用方', decisionNeeded: '选一个', asks: ASKS,
}, { role: 'system', id: 'system:auto-accept' })

await t('只写补充说明、不选任何选项也能回复', async () => {
  const r = await domain.replyInbox(asked.id, '我补充一句：先别动前端调用方', { role: 'human', id: 'web' }, { answers: {} })
  assert.equal(r.status, 'answered', '回复后状态应为 answered')
  const last = r.replies[r.replies.length - 1]
  assert.equal(last.content, '我补充一句：先别动前端调用方', '补充说明原文要落库')
  assert.deepEqual(last.answers, {}, '没选选项就是空答案，不能凭空造答案')
})

await t('不传 answers 的纯文本回复同样可用（老客户端）', async () => {
  const asked2 = await domain.askHuman({
    taskId: task.id, kind: 'decision', topic: '另一个决定', problem: 'p', decisionNeeded: 'd', asks: ASKS,
  }, { role: 'system', id: 'system:auto-accept' })
  const r = await domain.replyInbox(asked2.id, '直接说一句', { role: 'human', id: 'web' })
  assert.equal(r.status, 'answered')
  assert.deepEqual(r.replies[r.replies.length - 1].answers, {})
})

await t('填了选项就按 ask 校验（非法选项仍然拒）', async () => {
  await assert.rejects(
    () => domain.replyInbox(asked.id, '选 Z', { role: 'human', id: 'web' }, { answers: { q1: 'Z' } }),
    /不在选项里/,
  )
})

await t('只要有一条正文或一个答案就允许提交（全空才拒）', async () => {
  await assert.rejects(
    () => domain.replyInbox(asked.id, '   ', { role: 'human', id: 'web' }, { answers: {} }),
    /不能为空|必答|至少/,
  )
})

// ---- 2：对票的回复要真的唤醒代理，并在票里留得下回应 ----------------------
await t('人回复票之后，票对话里会出现调度方的回复（不只是被叫醒）', async () => {
  const before = (domain.inboxList({ includeArchived: true, limit: 500 }).find((x) => x.id === asked.id).replies || []).length
  const r = await domain.replyInbox(asked.id, '这一轮先不动前端，先把后端补上', { role: 'human', id: 'web' }, { answers: { q1: 'A' } })
  const after = r.replies.length
  assert.equal(after, before + 1, '人这条要进对话线')
  // 唤醒是 http 层的事，这里只证明"人能留下结构化答案 + 正文"，且后续可由调度 appendInboxFollowUp
  const replied = await domain.appendInboxFollowUp(asked.id, '收到：先补后端，前端调用方这轮不动。下一步我派工。', { role: 'dispatcher', id: dispAgent.id })
  const last = replied.replies[replied.replies.length - 1]
  assert.equal(last.role, 'dispatcher', '调度的回应要记在同一个对话线里（人才看得到答复）')
  assert.ok(String(last.content).length > 5, '回应要有内容，不能是占位符')
})

// ---- 3：停止事件不能被去重键吃掉 -----------------------------------------
await t('同一个任务连续两次「停止生成」，调度两次都要收到', async () => {
  const r1 = await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-stop-1' })
  rt.calls.length = 0
  const n1 = await dispatcher.onSessionEvent('ses-stop-1', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await dispatcher.aggregator.flushAll('probe')
  const sent1 = rt.calls.filter((c) => c.kind === 'prompt').length
  assert.ok(n1 && n1.ok !== false, '第一次停止的通知要成功：' + JSON.stringify(n1))
  assert.ok(sent1 > 0, '第一次停止必须投递，实际 0 条')

  const r2 = await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-stop-2' })
  rt.calls.length = 0
  const n2 = await dispatcher.onSessionEvent('ses-stop-2', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await dispatcher.aggregator.flushAll('probe')
  const sent2 = rt.calls.filter((c) => c.kind === 'prompt').length
  assert.ok(sent2 > 0, '第二次停止也必须投递（现在被去重键吃掉了）：' + JSON.stringify(n2) + ' run=' + r2.run.id)
})

await t('同一个任务连续两次会话失败，调度两次都要收到', async () => {
  await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-fail-1' }).catch(() => null)
  rt.calls.length = 0
  await dispatcher.onSessionEvent('ses-fail-1', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom-1' } } } })
  await dispatcher.aggregator.flushAll('probe')
  const sent1 = rt.calls.filter((c) => c.kind === 'prompt').length
  await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-fail-2' }).catch(() => null)
  rt.calls.length = 0
  await dispatcher.onSessionEvent('ses-fail-2', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom-2' } } } })
  await dispatcher.aggregator.flushAll('probe')
  const sent2 = rt.calls.filter((c) => c.kind === 'prompt').length
  assert.ok(sent1 > 0 && sent2 > 0, '两次失败都得通知调度，实际 ' + sent1 + '/' + sent2)
})

// ---- 3b：工人连续两次自停（走真实迁移 stop → runtime.onStopped） ---------------
await t('工人连续两次自停，调度两次都要收到（afterStop 也不能被去重键吃掉）', async () => {
  const st = await domain.createTask(proj.id, { title: '连续自停', acceptance: ['a'] })
  await domain.move(st.id, 'claim', { role: 'human', id: 'web' })

  // 走到 running：plan 定稿 → 计划就绪 → 批准（真实现里卡必须到 running 才允许 stop）
  const toRunning = async (id) => {
    await domain.setPlan(id, '1. 干活', { role: 'dispatcher' })
    await domain.move(id, 'plan_ready', { role: 'dispatcher' })
    await domain.move(id, 'approve', { role: 'human', id: 'web' })
  }
  await toRunning(st.id)
  assert.ok(store.state.tasks[st.id].activeRunId, '批准后应当已经派工起 run')
  await dispatcher.aggregator.flushAll('probe')
  rt.calls.length = 0
  await domain.move(st.id, 'stop', { role: 'worker', id: worker.id }, { stopReport: { summary: '第一轮做完了', tests: 'npm test 通过' } })
  await dispatcher.aggregator.flushAll('probe')
  const sent1 = rt.calls.filter((c) => c.kind === 'prompt').length
  assert.ok(sent1 > 0, '第一次自停必须通知调度，实际 0 条')

  // 第二轮：rework 回 todo 再派工 → 再停
  // rework：verifying → running，再派一次工（新 run）
  await domain.move(st.id, 'rework', { role: 'human', id: 'web' })
  await dispatcher.dispatch(store.state.tasks[st.id]).catch(() => null)
  await dispatcher.aggregator.flushAll('probe')
  assert.ok(store.state.tasks[st.id].activeRunId, '返工后应当重新起 run')
  rt.calls.length = 0
  await domain.move(st.id, 'stop', { role: 'worker', id: worker.id }, { stopReport: { summary: '第二轮也做完了' } })
  await dispatcher.aggregator.flushAll('probe')
  const sent2 = rt.calls.filter((c) => c.kind === 'prompt').length
  assert.ok(sent2 > 0, '第二次自停也必须通知调度（现在会被 evt:<task>:-:worker.stopped 吞掉）')
})

// ---- 4：票里回话的唤醒面（走真实 HTTP action） -------------------------------
{
  const { createHttpHandler } = await import('../lib/http.js')
  const host = {
    domain, runtime: rt, dispatcher,
    resolveProjectById: (id) => store.state.projects[id],
    listProjects: () => Object.values(store.state.projects),
  }
  const handler = createHttpHandler(host)
  const post = async (action, args) => {
    const res = await handler(new Request('http://local/api/flow/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, args }),
    }))
    return res.json()
  }

  await t('工人发的票：人回复后调度和工人都被叫醒（不能只叫醒工人）', async () => {
    const wt = await domain.createTask(proj.id, { title: '工人提问的卡', acceptance: ['a'] })
    await domain.move(wt.id, 'claim', { role: 'human', id: 'web' })
    const asked2 = await domain.askHuman({
      taskId: wt.id, kind: 'decision', topic: '工人问的：要不要动 schema',
      problem: 'p', decisionNeeded: 'd', asks: ASKS,
    }, { role: 'worker', id: worker.id })
    assert.equal(asked2.from, worker.id, '前置：from 是工人')
    rt.calls.length = 0
    const rp = await post('inbox.reply', { inboxId: asked2.id, content: '别动 schema，先加个兼容字段', answers: {} })
    assert.equal(rp.ok, true, '回复应成功：' + JSON.stringify(rp).slice(0, 200))
    const targets = rt.calls.filter((c) => c.kind === 'prompt').map((c) => c.sessionId)
    assert.ok(targets.includes('ses-' + dispAgent.id), '调度必须被叫醒（否则卡在工人手里没人推）：' + JSON.stringify(targets))
    assert.ok(targets.includes('ses-' + worker.id), '工人也要被叫醒（答案得回到干活的人手里）：' + JSON.stringify(targets))
  })

  await t('只写补充说明（不选选项）也能从 HTTP 回复成功', async () => {
    const rp = await post('inbox.reply', { inboxId: asked.id, content: '再补一句：这轮先不动前端', answers: {} })
    assert.equal(rp.ok, true, '不能因为选项没选就拒：' + JSON.stringify(rp).slice(0, 200))
  })

  await t('被叫醒的调度收到的提示词要求先回票，而不是直接归档', async () => {
    rt.calls.length = 0
    await post('inbox.reply', { inboxId: asked.id, content: '请回我一句', answers: {} })
    const toDispatcher = rt.calls.filter((c) => c.kind === 'prompt' && c.sessionId === 'ses-' + dispAgent.id)
    assert.ok(toDispatcher.length, '调度要被叫醒')
    const text = String(toDispatcher[0].text)
    assert.match(text, /flow_inbox_reply/, '提示词必须要求先在票里回话（否则人只看到归档、看不到回答）')
    assert.match(text, /结构|答案|补充/, '提示词要把人的答案原文带上')
  })
}

// ---- 4b：进程重启的 run 也要播报（否则卡悄悄回到待办） -------------------------
await t('进程重启被认作中断的 run，调度要收到播报', async () => {
  const rt2 = await domain.createTask(proj.id, { title: '重启被打断的卡', acceptance: ['a'] })
  await domain.move(rt2.id, 'claim', { role: 'human', id: 'web' })
  await domain.setPlan(rt2.id, '1. 干活', { role: 'dispatcher' })
  await domain.move(rt2.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(rt2.id, 'approve', { role: 'human', id: 'web' })
  const runId = store.state.tasks[rt2.id].activeRunId
  assert.ok(runId, '前置：批准后应该已经起 run')
  await dispatcher.aggregator.flushAll('probe')

  // 模拟进程重启：recoverRuns 会把 running 认作 interrupted 并清 activeRunId
  const rec = await domain.recoverRuns(Date.now(), { role: 'system', id: 'recover' })
  assert.ok(rec.runs.includes(runId), '前置：recoverRuns 要认出这个 run')
  assert.equal(store.state.tasks[rt2.id].activeRunId, null, '前置：activeRunId 已被清空')

  rt.calls.length = 0
  const told = await dispatcher.notifyRecovered(rec.runs)
  await dispatcher.aggregator.flushAll('probe')
  const mine = (told || []).filter((x) => x.taskId === rt2.id)
  assert.equal(mine.length, 1, '这个 run 要被播报一次')
  const sent = rt.calls.filter((c) => c.kind === 'prompt')
  assert.ok(sent.length > 0, '调度必须真的被叫醒（否则卡默默回到待办，没人重派）')
  assert.ok(sent.some((c) => /重启|中断/.test(String(c.text))), '播报里要说清是进程重启打断的：' + JSON.stringify(sent.map((c) => String(c.text).slice(0, 80))))
  assert.ok(store.state.message_log.some((m) => m && m.kind === 'inspect' && m.event === 'worker.recovered'), '要落一条 worker.recovered 通知事件')
})

// ---- 5：孤儿 tmp 清理（12GB 垃圾的来源） -------------------------------------
await t('启动时清掉孤儿 tmp，但不碰别的进程正在写的和自己刚写的', async () => {
  const { writeFileSync, utimesSync, existsSync, mkdirSync } = await import('node:fs')
  const d2 = mkdtempSync(join(tmpdir(), 'dsh-flow-tmpsweep-'))
  const file = join(d2, 'flow.json')
  const old = join(d2, 'flow.json.999999.42.tmp')
  const fresh = join(d2, 'flow.json.999998.43.tmp')
  const mine = join(d2, 'flow.json.' + process.pid + '.777.tmp')
  for (const p of [old, fresh, mine]) writeFileSync(p, '{}')
  // old 是 1 小时前的；fresh 是刚刚的（可能别的进程正在写）
  const long = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(old, long, long)
  mkdirSync(d2, { recursive: true })

  const s2 = new Store(file)
  await s2.load()
  // load() 里已经顺手扫过一次（fire-and-forget），这里显式再扫一次等它落定
  const removed = await s2.sweepStaleTmp()
  assert.ok(removed >= 0)
  assert.equal(existsSync(old), false, '陈旧孤儿 tmp 必须被清掉（线上堆了 12GB）')
  assert.equal(existsSync(fresh), true, '刚写不久的不能删：别的进程可能正在写')
  assert.equal(existsSync(mine), true, '本进程自己的 tmp 不能删')
})

if (fails.length) {
  console.log('\nv1.39.1 FAILED (' + fails.length + ')')
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
console.log('\nv1.39.1 ok (' + pass + ' checks)')
