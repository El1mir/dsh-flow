/**
 * 工人中断续跑（v0.016 / ticket 09）：进程重启/超时把一轮打断之后，自动接上下一轮。
 *
 * 关键不是「再派一次」，而是**续跑前先看这轮是否已经交付** —— 分支动了就写「接续收尾」，
 * 不给工人重做一遍的机会。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-wresume-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'base' + NL)
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
const project = await domain.ensureProject({ workspacePath: repo, name: 'w' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')
await domain.bindSession(worker.id, 'ses-' + worker.id, { state: 'idle' }, { role: 'system' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL).slice(0, 4).join(' | ')) }
}

async function readyCard(title) {
  const task = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 做', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  const cur = store.state.tasks[task.id]
  await dispatcher.ensureWorktree(cur, project)
  await dispatcher.dispatch(store.state.tasks[task.id])
  return store.state.tasks[task.id]
}

const c1 = await readyCard('会被中断的卡')
await t('① 中断（进程重启）→ 自动续跑，开出一条新 run', async () => {
  const before = c1.activeRunId
  assert.ok(before, '先要有在跑的 run')
  await dispatcher.onSessionEvent(store.state.runs[before].sessionId, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  const cur = store.state.tasks[c1.id]
  assert.ok(cur.activeRunId, '应当已经续跑')
  assert.notEqual(cur.activeRunId, before, '续跑要开新 run，而不是复用旧 id')
  assert.equal(store.state.runs[before].status, 'interrupted')
})

await t('② 续跑文案写「接续」而不是从头再来', () => {
  const text = prompted.map((p) => String((p && p.text) || '')).join(NL)
  assert.match(text, /接续/)
})

const c2 = await readyCard('关掉续跑的卡')
await t('③ 开关关闭 → 不续跑（与旧行为一致）', async () => {
  await store.tx((s) => { s.settings.workerAutoResume = false })
  const before = c2.activeRunId
  await dispatcher.onSessionEvent(store.state.runs[before].sessionId, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  assert.equal(store.state.tasks[c2.id].activeRunId, null, '关掉就不该偷偷续')
  await store.tx((s) => { s.settings.workerAutoResume = true })
})

const c3 = await readyCard('人点停止的卡')
await t('④ 人点「停止生成」→ 不续跑', async () => {
  const before = c3.activeRunId
  await dispatcher.onSessionEvent(store.state.runs[before].sessionId, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(store.state.tasks[c3.id].activeRunId, null)
})

const c4 = await readyCard('反复被中断的卡')
await t('⑤ 连续中断到上限（默认 5）就停，并开一张错误工单', async () => {
  for (let i = 0; i < 6; i += 1) {
    const rid = store.state.tasks[c4.id].activeRunId
    if (!rid) break
    await dispatcher.onSessionEvent(store.state.runs[rid].sessionId, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  }
  assert.equal(store.state.tasks[c4.id].activeRunId, null, '到上限后不再续')
  const ticket = (store.state.human_inbox || []).find((x) => x.taskId === c4.id && x.from === 'system:worker-resume')
  assert.ok(ticket, '应当开一张说明连败次数的工单')
  assert.match(ticket.topic, /连续中断 5 次/)
})

const c5 = await readyCard('已经交了部分活的卡')
await t('⑥ 分支已前进 → 续跑文案写「接续收尾」', async () => {
  const wt = store.state.worktrees[c5.id]
  writeFileSync(join(wt.path, 'part.txt'), 'x' + NL)
  sh(wt.path, ['add', '-A']); sh(wt.path, ['commit', '-qm', 'work: 先交一部分'])
  const before = c5.activeRunId
  await dispatcher.onSessionEvent(store.state.runs[before].sessionId, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  assert.ok(store.state.tasks[c5.id].activeRunId, '应当续跑')
  const text = prompted.map((p) => String((p && (p.content || p.text || JSON.stringify(p))) || '')).join(NL)
  assert.match(text, /接续收尾/)
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')