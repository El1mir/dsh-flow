/**
 * 失败分类（v0.016 / ticket 07）：环境失败走退避，不烧内容预算。
 *
 * 钉住四类环境信号、退避序列、上限转缺环境，以及两套计数互不污染。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import { classifyFailure, infraSignature } from '../lib/retry.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-infra-'))
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
const project = await domain.ensureProject({ workspacePath: join(root, 'ws'), name: 'i' })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

await t('① 进程被信号杀 = 环境失败（exit ≥ 128 / signal）', () => {
  assert.equal(classifyFailure({ exitCode: 137 }).signature, 'signal-killed')
  assert.equal(classifyFailure({ signal: 'SIGTERM' }).kind, 'infra')
})

await t('② 磁盘满 = 环境失败', () => {
  const r = classifyFailure({ exitCode: 1, stderr: 'write error: ENOSPC: no space left on device' })
  assert.equal(r.kind, 'infra')
  assert.equal(r.signature, 'disk-full')
})

await t('③ 服务不可达 = 环境失败（fetch failed / ECONNREFUSED）', () => {
  assert.equal(infraSignature('TypeError: fetch failed'), 'unreachable')
  assert.equal(classifyFailure({ message: 'connect ECONNREFUSED 127.0.0.1:8000' }).signature, 'unreachable')
})

await t('④ 命令不在 = 环境失败（ENOENT / command not found）', () => {
  assert.equal(classifyFailure({ message: "sh: 1: pnpm: command not found" }).signature, 'command-missing')
  assert.equal(classifyFailure({ message: "spawn ENOENT" }).signature, 'command-missing')
})

await t('⑤ 普通报错 = 内容失败（不进环境预算）', () => {
  const r = classifyFailure({ message: 'TypeError: cannot read properties of undefined (reading \'id\')' })
  assert.equal(r.kind, 'content')
  assert.equal(r.signature, null)
})

async function card(title) {
  const task = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 做', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[task.id]
}

const c1 = await card('环境抖动的卡')
await t('⑥ 退避序列 15s → 30s → 60s，三次后不再重试', () => {
  const a = domain.recordFailure(c1.id, { kind: 'infra', reason: 'ECONNREFUSED', signature: 'unreachable' })
  return a.then(async (r1) => {
    assert.equal(r1.backoffMs, 15000)
    assert.equal(r1.retry, true)
    const r2 = await domain.recordFailure(c1.id, { kind: 'infra', reason: 'ECONNREFUSED', signature: 'unreachable' })
    assert.equal(r2.backoffMs, 30000)
    const r3 = await domain.recordFailure(c1.id, { kind: 'infra', reason: 'ECONNREFUSED', signature: 'unreachable' })
    assert.equal(r3.backoffMs, 60000)
    assert.equal(r3.retry, false, '第三次之后不再自动重试')
    assert.equal(store.state.tasks[c1.id].infraAttempts, 3)
  })
})

await t('⑦ 环境失败不动内容计数（attempts 仍为 0）', () => {
  const cur = store.state.tasks[c1.id]
  assert.equal(cur.attempts === undefined ? 0 : cur.attempts, 0, 'attempts 是内容预算')
  assert.equal(cur.rework ? cur.rework.count : 0, 0, '返工计数不受影响')
})

await t('⑧ 用尽后转 blocked-needs-env（同列迁移）', async () => {
  await domain.move(c1.id, 'infra_exhausted', { role: 'system', id: 'system:infra' }, { reason: '环境失败 3 次' })
  const cur = store.state.tasks[c1.id]
  assert.equal(cur.column, 'running', '不该换列')
  assert.equal(cur.phase, 'blocked-needs-env')
})

const c2 = await card('跑一半收到网络错误的卡')
await t('⑨ 会话错误按信号分类进环境预算（端到端）', async () => {
  const started = await domain.startRun(c2.id, { agentId: worker.id, sessionId: 'ses-net', trigger: 'system' }, { role: 'system' })
  assert.ok(started && started.run)
  const err = await dispatcher.onSessionEvent('ses-net', { type: 'error', data: { message: 'TypeError: fetch failed' } })
  assert.ok(err)
  const cur = store.state.tasks[c2.id]
  assert.equal(cur.infraAttempts, 1, '网络错误应进环境预算')
  assert.equal(cur.attempts === undefined ? 0 : cur.attempts, 0, '内容预算不该动')
  const run = Object.values(store.state.runs).find((r) => r.sessionId === 'ses-net')
  assert.ok(run && run.failure, 'run 上要记分类')
  assert.equal(run.failure.kind, 'infra')
  assert.equal(run.failure.signature, 'unreachable')
})

const c3 = await card('内容失败的卡')
await t('⑩ 内容失败进内容预算（不吃环境退避）', async () => {
  await domain.startRun(c3.id, { agentId: worker.id, sessionId: 'ses-ctx', trigger: 'system' }, { role: 'system' })
  await dispatcher.onSessionEvent('ses-ctx', { type: 'error', data: { message: 'cannot read properties of undefined' } })
  const cur = store.state.tasks[c3.id]
  assert.equal(cur.attempts, 1, '内容失败进 attempts')
  assert.equal(cur.infraAttempts === undefined ? 0 : cur.infraAttempts, 0)
  // 内容失败保持原有行为：允许一次立即重试（退避 0），不吃环境退避；不改返工频控。
  assert.equal(cur.retryBudget.backoffMs === undefined ? 0 : cur.retryBudget.backoffMs, 0, '内容失败没有退避')
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')