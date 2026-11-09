/**
 * 部分完成（v0.016 / ticket 04）：一张卡一轮做不完时，系统要有正经出口。
 *
 * 钉住：stop 带剩余项 → 标记 partial；accept 被拒；accept_partial 收口（done-partial，
 * 不算交付）；剩余项可拆成后续卡；返工把 partial 撤回；自动验收不碰 partial。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, isDelivered, deliveryState } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-partial-'))
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
const project = await domain.ensureProject({ workspacePath: join(root, 'ws'), name: 'p' })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')
const AG = worker.id

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

async function makeCard(title) {
  const task = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 先做一半', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  const started = await domain.startRun(task.id, { agentId: AG, sessionId: 's1', trigger: 'system' }, { role: 'system' })
  return { task, run: started && started.run }
}

const { task } = await makeCard('一张做不完的卡')
await domain.move(task.id, 'stop', { role: 'worker', id: AG }, {
  stopReport: { summary: '做了 60%', remaining: ['补第 3 章的代码', '补端到端测试'] },
})

await t('① stop 带剩余项 → 卡被标成部分完成，剩余项落到卡上', () => {
  const cur = store.state.tasks[task.id]
  assert.equal(cur.column, 'verifying')
  assert.equal(cur.partial, true)
  assert.deepEqual(cur.remainder, ['补第 3 章的代码', '补端到端测试'])
  assert.deepEqual(cur.stopReport.remaining, cur.remainder)
})

await t('② 普通验收被拒，并指向 accept_partial / splitRemainder', async () => {
  await assert.rejects(
    () => domain.move(task.id, 'accept', { role: 'human', id: 'me' }, {}),
    /部分完成/
  )
})

await t('③ 自动验收不碰部分完成的卡', async () => {
  await domain.updateProjectConfig(project.id, { autoAccept: true })
  const sched = (await import('../lib/scheduler.js')).createScheduler({ domain, dispatcher, store, log: () => {} })
  await sched.tick()
  const cur = store.state.tasks[task.id]
  assert.equal(cur.column, 'verifying', '不该被自动收')
})

await t('④ accept_partial 收口：done / done-partial，且不算交付', async () => {
  await domain.move(task.id, 'accept_partial', { role: 'human', id: 'me' }, {})
  const cur = store.state.tasks[task.id]
  assert.equal(cur.column, 'done')
  assert.equal(cur.phase, 'done-partial')
  assert.equal(isDelivered(cur), false, '部分完成不是交付')
  assert.equal(deliveryState(cur), 'partial')
  assert.deepEqual(cur.remainder, ['补第 3 章的代码', '补端到端测试'], '剩余项必须留在卡上')
})

const { task: t2 } = await makeCard('拆剩余的卡')
await domain.move(t2.id, 'stop', { role: 'worker', id: AG }, {
  stopReport: { summary: '做了一半', remaining: ['第 2 节', '第 3 节'] },
})

await t('⑤ splitRemainder：剩余项变成后续卡，父卡落 done-partial', async () => {
  const res = await domain.splitRemainder(t2.id, { role: 'dispatcher', id: 'system' })
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200))
  assert.equal(res.created.length, 2)
  const parent = store.state.tasks[t2.id]
  assert.equal(parent.column, 'done')
  assert.equal(parent.phase, 'done-partial')
  assert.deepEqual(parent.childIds.slice().sort(), res.created.slice().sort())
  const child = store.state.tasks[res.created[0]]
  assert.equal(child.parentId, t2.id)
  assert.equal(child.branchFrom, 'flow/' + t2.id)
  assert.equal(child.mergeState, 'none', '子卡不进合并列')
  assert.equal(child.hiddenOnBoard, true)
})

await t('⑥ 子卡不能再拆（只允许两层）', async () => {
  const childId = store.state.tasks[t2.id].childIds[0]
  await store.tx((s) => { s.tasks[childId].partial = true; s.tasks[childId].remainder = ['x'] })
  await assert.rejects(() => domain.splitRemainder(childId, { role: 'dispatcher' }), /只允许两层/)
})

const { task: t3 } = await makeCard('返工撤回首做的卡')
await domain.move(t3.id, 'stop', { role: 'worker', id: AG }, { stopReport: { summary: '做了一半', remaining: ['还剩一项'] } })
await t('⑦ 返工把「部分完成」撤回（remainder 清空）', async () => {
  await domain.move(t3.id, 'rework', { role: 'dispatcher' }, { reason: '口径不对，重做' })
  const cur = store.state.tasks[t3.id]
  assert.equal(cur.partial, false)
  assert.deepEqual(cur.remainder, [])
  assert.equal(cur.column, 'running')
})

await t('⑧ 不是部分完成却走 accept_partial → 拒', async () => {
  const { task: t4 } = await makeCard('完整交付的卡')
  await domain.move(t4.id, 'stop', { role: 'worker', id: AG }, { stopReport: { summary: '全做完了' } })
  await assert.rejects(() => domain.move(t4.id, 'accept_partial', { role: 'human', id: 'me' }, {}), /不是部分完成/)
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')