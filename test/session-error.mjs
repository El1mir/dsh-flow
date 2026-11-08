/**
 * v0.006：没有 run 的会话出错 / 被中断时，调度必须收到停止事件。
 *
 * 线上事故：需求评审的对话被 SERVER 503 / model_not_found 打断，
 * 插件把这条 turn/end(error) 判成 no-active-run 丢掉 → 卡挂在 grill.status='running'，
 * 既没人被通知，也再也开不了新一轮评审（grillStart 有 running 守卫）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher, EVENT_OF_KIND } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-session-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
const { writeFileSync } = await import('node:fs')
writeFileSync(join(repo, 'a.txt'), 'a' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const prompted = []
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession(sessionId, text, mode) { prompted.push({ sessionId, text, mode }); return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'sesserr' })
await domain.ensureAgents(project.id)

const griller = Object.values(store.state.agents).find((a) => a.projectId === project.id && a.role === 'griller')
const dispatcherAgent = Object.values(store.state.agents).find((a) => a.projectId === project.id && a.role === 'dispatcher')
await domain.bindSession(griller.id, 'ses-grill-1', { state: 'idle' }, { role: 'system' })
await domain.bindSession(dispatcherAgent.id, 'ses-disp-1', { state: 'idle' }, { role: 'system' })

const task = await domain.createTask(project.id, { title: '要评审的卡', acceptance: ['x'] })
await domain.setGrill(task.id, { status: 'running', rounds: 2, maxRounds: 4, startedAt: new Date().toISOString() })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const event = { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'SERVER 503: Service temporarily unavailable', code: 'model_not_found' } } } }
const res = await dispatcher.onSessionEvent('ses-grill-1', event)

await t('① 评审工位报错：onSessionEvent 不再返回 no-active-run', () => {
  assert.equal(res.ok, true)
  assert.equal(res.reason, undefined, '旧代码这里会静默丢掉：' + JSON.stringify(res))
  assert.equal(res.taskId, task.id)
})

await t('①b 这一轮被判失败（status=failed），并记住错误原文', () => {
  const cur = store.state.tasks[task.id]
  assert.equal(cur.grill.status, 'failed', '旧的会一直停在 running')
  assert.equal(cur.grill.failedRound, 2)
  assert.match(cur.grill.lastError, /503/)
})

await t('①c 轮次回滚：失败的一轮不占配额（2 → 1），避免两次抖动就把 maxRounds 用完', () => {
  assert.equal(store.state.tasks[task.id].grill.rounds, 1)
})

await t('①d 卡上有评论，人看得见这一轮为什么没了', () => {
  const body = (store.state.task_comments || []).filter((c) => c.taskId === task.id).map((c) => c.content || '').join(NL)
  assert.match(body, /评审中断/)
  assert.match(body, /503/)
})

await t('①e 调度收到了 grill.failed 通知（走紧急通道，不攒聚合器）', () => {
  const logs = (store.state.message_log || []).filter((m) => m && m.taskId === task.id && m.kind === 'inspect')
  const hit = logs.find((m) => m.event === 'grill.failed')
  assert.ok(hit, '没有 grill.failed 投递：' + JSON.stringify(logs.map((m) => m.event)))
  assert.equal(hit.ok, true)
})

await t('② 失败之后可以重开评审（grillStart 的 running 守卫不再永久拒绝）', async () => {
  const again = await dispatcher.grillStart(store.state.tasks[task.id], { draft: '# 八问草稿' })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(store.state.tasks[task.id].grill.status, 'running')
  assert.equal(store.state.tasks[task.id].grill.rounds, 2, '重开后回到第 2 轮')
})

await t('③ 用户手动停止生成：评审这一轮记为 interrupted（不是 failed）', async () => {
  const stopped = await dispatcher.onSessionEvent('ses-grill-1', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(stopped.ok, true)
  const cur = store.state.tasks[task.id]
  assert.equal(cur.grill.status, 'interrupted')
})

await t('④ 调度员自己报错：只留事实，不给自己发通知（避免自通知死循环）', async () => {
  const before = (store.state.message_log || []).length
  const r = await dispatcher.onSessionEvent('ses-disp-1', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'SERVER 503' } } } })
  assert.equal(r.ok, true)
  assert.equal(r.notified, false)
  assert.equal((store.state.message_log || []).length, before, '不该有任何投递')
  const errs = domain.sessionErrors(5)
  assert.ok(errs.some((e) => e.sessionId === 'ses-disp-1'), '至少要在 maintenance 里留一条')
})

await t('⑤ 不认识会话的事件仍然安静丢弃（没有 agent 就是外部/已删会话）', async () => {
  const r = await dispatcher.onSessionEvent('ses-unknown', event)
  assert.equal(r.ok, true)
  assert.equal(r.notified, false)
})

await t('⑥ 事件类型映射：grill-failed → grill.failed（与 grill.message 分开）', () => {
  assert.equal(EVENT_OF_KIND['grill-failed'], 'grill.failed')
  assert.equal(EVENT_OF_KIND.grill, 'grill.message')
})

if (fails.length) {
  console.log('FAIL session-error ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err).split(NL).slice(0, 3).join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS session-error ' + pass + '/' + pass)
}