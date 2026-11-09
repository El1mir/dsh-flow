/**
 * 「等」从「跑」里拆出来（v0.016 / ticket 11）。
 *
 * 五个数字互不重叠、合起来是全部在飞的卡；看一眼就知道人该不该动手。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { buildProjectView } from '../lib/panel.js'
import { waitingReasonFor, cardView } from '../lib/view-model.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-wait-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const domain = new FlowDomain(store, {})
const project = await domain.ensureProject({ workspacePath: root, name: 'w' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL).slice(0, 4).join(' | ')) }
}

async function mk(title, patch) {
  const task = await domain.createTask(project.id, { title, acceptance: ['x'] })
  if (patch) await store.tx((s) => { Object.assign(s.tasks[task.id], patch) })
  return store.state.tasks[task.id]
}

const running = await mk('在跑的卡', { column: 'running', activeRunId: 'run_fake' })
const plain0 = await mk('先占个号', { column: 'todo' })
const waiting = await mk('等依赖的卡', { column: 'running', activeRunId: null, dependsOn: [plain0.id] })
const blocked = await mk('被卡的卡', { column: 'running', blocked: { reason: 'needs-decision' } })
const verifying = await mk('待验收的卡', { column: 'verifying', phase: 'awaiting-acceptance' })
const reply = await mk('等人答的卡', { column: 'planning' })
const plain = await mk('待办的卡', { column: 'todo' })
await domain.askHuman({ taskId: reply.id, projectId: project.id, kind: 'decision', topic: '要不要这么拆？', problem: '范围待定', decisionNeeded: '确认拆分', asks: [{ key: 'q1', question: '拆吗', why: '范围', type: 'confirm' }] }, { role: 'system', id: 'system:test' })

await t('① 执行中只数真有 run 的卡；其余四类分开且互不重叠', () => {
  const view = buildProjectView(store.state, project.id)
  const x = view.totals
  assert.equal(x.running, 1, '只有一张卡真在跑')
  assert.equal(x.blocked, 1)
  assert.equal(x.verifying, 1)
  assert.equal(x.pendingReply, 1)
  assert.equal(x.waiting, 3, '三张在等（含待办与占位号）')
})

await t('② 五个数字之和等于全部在飞的卡', () => {
  const x = buildProjectView(store.state, project.id).totals
  const sum = x.running + x.waiting + x.blocked + x.verifying + x.pendingReply
  assert.equal(sum, x.inFlight)
  assert.equal(x.inFlight + x.archived, x.tasks)
})

await t('③ 等待原因有优先级：被卡住 > 缺环境 > 等依赖 > 等分支 > 等人', () => {
  const tasks = Object.values(store.state.tasks)
  const both = { id: 'T-x', column: 'running', blocked: { reason: 'repo-broken' }, phase: 'blocked-needs-env', envMissing: ['API_KEY'] }
  assert.equal(waitingReasonFor(both, { tasks }).kind, 'blocked')
  const env = { id: 'T-y', column: 'running', phase: 'blocked-needs-env', envMissing: ['API_KEY'] }
  assert.equal(waitingReasonFor(env, { tasks }).kind, 'env')
  const dep = { id: 'T-z', column: 'running', dependsOn: [plain.id] }
  assert.match(waitingReasonFor(dep, { tasks }).text, /等依赖/)
  const branch = { id: 'T-w', column: 'merging', mergeReason: 'base-busy' }
  assert.match(waitingReasonFor(branch, { tasks }).text, /等分支/)
  assert.equal(waitingReasonFor({ id: 'T-v', column: 'verifying' }, { tasks }).kind, 'accept')
})

await t('④ 正在跑的卡没有等待原因；cardView 把它带出来', () => {
  const tasks = Object.values(store.state.tasks)
  assert.equal(waitingReasonFor(running, { tasks }), null)
  const view = cardView(waiting, { tasks })
  assert.ok(view.waiting, '卡面要能显示在等什么')
  assert.equal(view.waiting.kind, 'dep')
})

await t('⑤ 依赖已交付就不再算等待', async () => {
  await store.tx((s) => { Object.assign(s.tasks[plain.id], { column: 'done', phase: 'merged' }) })
  const tasks = Object.values(store.state.tasks)
  const dep = { id: 'T-z2', column: 'running', dependsOn: [plain.id] }
  assert.equal(waitingReasonFor(dep, { tasks }).kind, 'run')
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')