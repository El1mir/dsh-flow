/**
 * 空转收回（v0.016 / ticket 08）：心跳只证明进程活着，不证明它干活。
 *
 * 30 分钟没有任何进展证据（新提交 / 进度更新 / 评论）→ 收回这一轮并通知调度，
 * 而不是等 3 小时总上限。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import { createScheduler } from '../lib/scheduler.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-idle-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'base' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession() { return { ok: true, sessionId: 's' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
let clock = Date.now()
const scheduler = createScheduler({ domain, dispatcher, store, log: () => {}, now: () => clock })
const project = await domain.ensureProject({ workspacePath: repo, name: 'i' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL).slice(0, 6).join(' | ')) }
}

// 心跳用**假时钟**写：tick 的 now() 也是假时钟，两边同一时区才比得出「空转」。
async function beat(runId) {
  await store.tx((s) => { const r = s.runs[runId]; if (r) r.lastHeartbeat = new Date(clock).toISOString() })
}

/** 进展也按假时钟记（真实 nowIso 与 tick 的 now() 不同时区，比不出空转）。 */
async function touchAt(runId) {
  await store.tx((s) => { const r = s.runs[runId]; if (r) { r.lastProgressAt = new Date(clock).toISOString(); r.lastHeartbeat = new Date(clock).toISOString() } })
}

async function card(title) {
  const task = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 做', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[task.id]
}

const c1 = await card('空转的卡')
await dispatcher.ensureWorktree(c1, project)

await t('① 30 分钟没进展 → 收回 run，卡仍在原列但 activeRunId 清空', async () => {
  const started = await domain.startRun(c1.id, { agentId: worker.id, sessionId: 'ses-idle-1', trigger: 'system' }, { role: 'system' })
  await touchAt(started.run.id)
  // 先让 tick 看到一次分支头（第一次看到算基线，不算空转）
  await scheduler.tick()
  assert.equal(store.state.tasks[c1.id].activeRunId, started.run.id, 'tick 不该收刚开跑的 run')
  clock += 31 * 60000
  await beat(started.run.id)
  await scheduler.tick()
  const cur = store.state.tasks[c1.id]
  const run = store.state.runs[started.run.id]
  assert.equal(run.status, 'failed', '空转的 run 要被收回')
  assert.match(String(run.stopReason), /空转 \d+ 分钟/)
  // 收回之后 refill 可能已经重新派了一轮 —— 关键是「新的那一轮不再是它」。
  assert.notEqual(cur.activeRunId, started.run.id, '旧 run 不该还挂在卡上')
})

await t('② 收回时会通知调度（同一条只发一次）', async () => {
  const before = (store.state.events || []).length
  await scheduler.tick()
  const after = (store.state.events || []).length
  // 第二次 tick 不该再产生「空转收回」事件（run 已经不是 running）
  const reclaimed = (store.state.events || []).slice(before).filter((e) => JSON.stringify(e).includes('idle-reclaimed'))
  assert.equal(reclaimed.length, 0)
  assert.ok(after >= before)
})

const c2 = await card('有进展的卡')
await dispatcher.ensureWorktree(c2, project)
await t('③ 有进度更新的 run 不被误收', async () => {
  const started = await domain.startRun(c2.id, { agentId: worker.id, sessionId: 'ses-idle-2', trigger: 'system' }, { role: 'system' })
  await touchAt(started.run.id)
  await scheduler.tick()
  clock += 29 * 60000
  await beat(started.run.id)
  await domain.setProgress(c2.id, { state: 'on-track', summary: '还在写', next: '继续' }, { role: 'worker', id: worker.id })
  await touchAt(started.run.id)
  clock += 20 * 60000
  await beat(started.run.id)
  await scheduler.tick()
  assert.equal(store.state.tasks[c2.id].activeRunId, started.run.id, '刚有进度更新，不该被收')
})

await t('④ 心跳不推进进展（有心跳也照样被收）', async () => {
  const rid = store.state.tasks[c2.id].activeRunId
  clock += 31 * 60000
  await scheduler.tick()
  assert.equal(store.state.tasks[c2.id].activeRunId, null, '心跳不算进展')
})

const c3 = await card('在分支上提交的卡')
await dispatcher.ensureWorktree(c3, project)
await t('⑤ 观察到新提交算进展（不被收回）', async () => {
  const started = await domain.startRun(c3.id, { agentId: worker.id, sessionId: 'ses-idle-3', trigger: 'system' }, { role: 'system' })
  await touchAt(started.run.id)
  await scheduler.tick()
  clock += 29 * 60000
  const wt = store.state.worktrees[c3.id]
  writeFileSync(join(wt.path, 'work.txt'), 'x' + NL)
  sh(wt.path, ['add', '-A']); sh(wt.path, ['commit', '-qm', 'work: 有进展'])
  await scheduler.tick()
  assert.equal(store.state.tasks[c3.id].activeRunId, started.run.id, '有新提交算进展')
})

await t('⑥ 30 分钟阈值可用 settings.idleRunMs 覆盖', async () => {
  await store.tx((s) => { s.settings.idleRunMs = 5 * 60000 })
  const activeBefore = store.state.tasks[c3.id].activeRunId
  clock += 31 * 60000
  await beat(store.state.tasks[c3.id].activeRunId)
  await scheduler.tick()
  assert.notEqual(store.state.tasks[c3.id].activeRunId, activeBefore)
  await store.tx((s) => { delete s.settings.idleRunMs })
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')