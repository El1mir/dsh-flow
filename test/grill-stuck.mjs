/**
 * v0.006：评审轮次卡死的兜底回收。
 *
 * 会话报错有 turn/end 可抓；进程崩溃 / 会话被归档 / provider 没发事件时没有 ——
 * 那时 grill.status 会永远停在 running，而 grillStart 的守卫会把这张卡的评审永久锁死。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import { createScheduler } from '../lib/scheduler.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-grillstuck-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
const { writeFileSync } = await import('node:fs')
writeFileSync(join(repo, 'a.txt'), 'a' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'grillstuck' })
await domain.ensureAgents(project.id)
const disp = Object.values(store.state.agents).find((a) => a.projectId === project.id && a.role === 'dispatcher')
await domain.bindSession(disp.id, 'ses-disp', { state: 'idle' }, { role: 'system' })

const T0 = Date.parse('2026-11-08T10:00:00Z')
const sched = createScheduler({ domain, dispatcher, store, log: () => {}, now: () => T0 })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

async function mkRunningTask(minutesAgo) {
  const task = await domain.createTask(project.id, { title: '评审卡 ' + minutesAgo })
  await domain.setGrill(task.id, {
    status: 'running', rounds: 2, maxRounds: 4,
    startedAt: new Date(T0 - 120 * 60000).toISOString(),
    roundStartedAt: new Date(T0 - minutesAgo * 60000).toISOString(),
  })
  return task.id
}

const stale = await mkRunningTask(40)
const fresh = await mkRunningTask(5)
const report = await sched.tick()

await t('① 超过 30 分钟没有回信的评审轮次被判失败', () => {
  const cur = store.state.tasks[stale]
  assert.equal(cur.grill.status, 'failed', JSON.stringify(report.grill))
  assert.match(cur.grill.lastError, /没有回信/)
  assert.equal(cur.grill.failedRound, 2)
})

await t('①b 轮次退回上一轮（超时的一轮不占上限）', () => {
  assert.equal(store.state.tasks[stale].grill.rounds, 1)
})

await t('①c 刚到 5 分钟的轮次不动（阈值默认 30 分钟）', () => {
  const cur = store.state.tasks[fresh]
  assert.equal(cur.grill.status, 'running')
  assert.equal(cur.grill.rounds, 2)
})

await t('①d 超时也在卡上留了评论', () => {
  const body = (store.state.task_comments || []).filter((c) => c.taskId === stale).map((c) => c.content || '').join(NL)
  assert.match(body, /评审超时/)
})

await t('①e 调度收到 grill.failed（超时也是一个停止事件）', () => {
  const hit = (store.state.message_log || []).find((m) => m && m.taskId === stale && m.event === 'grill.failed')
  assert.ok(hit, '没有投递')
})

await t('② 幂等：同一拍再跑一次不会把已经失败的轮次再收一次', async () => {
  const again = await sched.tick()
  assert.equal((again.grill || []).length, 0, JSON.stringify(again.grill))
  assert.equal(store.state.tasks[stale].grill.rounds, 1)
})

await t('③ 配置可调：grillStuckAfterMs 设小一点，5 分钟也算超时', async () => {
  await domain.updateProjectConfig(project.id, { grillStuckAfterMs: 60 * 1000 })
  await sched.tick()
  assert.equal(store.state.tasks[fresh].grill.status, 'failed')
})

if (fails.length) {
  console.log('FAIL grill-stuck ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err).split(NL).slice(0, 3).join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS grill-stuck ' + pass + '/' + pass)
}