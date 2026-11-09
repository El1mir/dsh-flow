/**
 * v0.015：反循环。三件事：六问报告归一化、返工频控、no-diff 升级为 block。
 */
import assert from 'node:assert/strict'
const NL = String.fromCharCode(10)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { analyzeCycles } from '../lib/inspect-signals.js'
import { builtinDispatcherRules, builtinWorkerRules } from '../lib/prompts.js'

const root = mkdtempSync(join(tmpdir(), 'flow-antiloop-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const domain = new FlowDomain(store, {})
const project = await domain.ensureProject({ workspacePath: root, name: 'al' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

await t('① 停止报告带六问：缺的项被记下来', async () => {
  const k = await domain.createTask(project.id, { title: '六问', acceptance: ['x'] })
  await store.tx((s) => { s.tasks[k.id].column = 'running'; s.tasks[k.id].phase = 'executing' })
  await domain.move(k.id, 'stop', { role: 'worker', id: 'w1' }, {
    stopReport: {
      summary: '修好了',
      tests: 'npm test 12 passed',
      problem: 'connect_test 422',
      cause: '后端只读 body.id，前端传 provider_id',
      design: '没有',
    },
  })
  const r = store.state.tasks[k.id].stopReport
  assert.equal(r.six.problem, 'connect_test 422')
  assert.equal(r.six.design, '没有')
  assert.deepEqual(r.sixMissing, ['impact', 'fix', 'regression'])
})

await t('② 六问字段超长被截断（600 字）', async () => {
  const k = await domain.createTask(project.id, { title: '长报告', acceptance: ['x'] })
  await store.tx((s) => { s.tasks[k.id].column = 'running'; s.tasks[k.id].phase = 'executing' })
  await domain.move(k.id, 'stop', { role: 'worker', id: 'w1' }, { stopReport: { summary: 's', impact: 'x'.repeat(900) } })
  assert.equal(store.state.tasks[k.id].stopReport.six.impact.length, 600)
})

await t('③ 返工第一次、第二次放行，第三次被拒', async () => {
  const k = await domain.createTask(project.id, { title: '返工', acceptance: ['x'] })
  await store.tx((s) => { s.tasks[k.id].column = 'verifying'; s.tasks[k.id].phase = 'awaiting-acceptance' })
  await domain.move(k.id, 'rework', { role: 'dispatcher', id: 'd1' }, { reason: '缺证据' })
  await store.tx((s) => { s.tasks[k.id].column = 'verifying'; s.tasks[k.id].phase = 'awaiting-acceptance' })
  await domain.move(k.id, 'rework', { role: 'dispatcher', id: 'd1' }, { reason: '缺证据' })
  assert.equal(store.state.tasks[k.id].rework.count, 2)
  await store.tx((s) => { s.tasks[k.id].column = 'verifying'; s.tasks[k.id].phase = 'awaiting-acceptance' })
  await assert.rejects(
    () => domain.move(k.id, 'rework', { role: 'dispatcher', id: 'd1' }, { reason: '缺证据' }),
    /不再放行/
  )
})

await t('④ 被拒之后仍然可以 block（换动作不被拦）', async () => {
  const k = await domain.createTask(project.id, { title: '换动作', acceptance: ['x'] })
  await store.tx((s) => { s.tasks[k.id].column = 'verifying'; s.tasks[k.id].phase = 'awaiting-acceptance' })
  for (let i = 0; i < 2; i += 1) {
    await domain.move(k.id, 'rework', { role: 'dispatcher', id: 'd1' }, { reason: 'x' })
    await store.tx((s) => { s.tasks[k.id].column = 'verifying'; s.tasks[k.id].phase = 'awaiting-acceptance' })
  }
  await store.tx((s) => { s.tasks[k.id].column = 'running'; s.tasks[k.id].phase = 'executing' })
  await domain.block(k.id, '缺真实凭据', { role: 'dispatcher', id: 'd1' })
  assert.ok(store.state.tasks[k.id].blocked)
})

await t('⑤ 时间窗过了重新计数（settings.reworkWindowMs）', async () => {
  await store.tx((s) => { s.settings.reworkWindowMs = 1 })
  const k = await domain.createTask(project.id, { title: '窗口', acceptance: ['x'] })
  await store.tx((s) => {
    s.tasks[k.id].column = 'verifying'; s.tasks[k.id].phase = 'awaiting-acceptance'
    s.tasks[k.id].rework = { count: 2, lastAt: new Date(Date.now() - 5000).toISOString() }
  })
  await domain.move(k.id, 'rework', { role: 'dispatcher', id: 'd1' }, { reason: 'x' })
  assert.equal(store.state.tasks[k.id].rework.count, 1)
})

await t('⑥ 巡检：连续两轮 no-diff 仍是 steer', () => {
  const r = analyzeCycles([{ hasDiff: false }, { hasDiff: false }])
  assert.equal(r.verdict, 'steer')
})

await t('⑦ 巡检：连续三轮 no-diff 升为 block', () => {
  const r = analyzeCycles([{ hasDiff: false }, { hasDiff: false }, { hasDiff: false }])
  assert.equal(r.verdict, 'block')
  assert.ok(r.reasons.some((x) => x.includes('停下来问人')))
})

await t('⑧ 有改动就清零（不误判）', () => {
  const r = analyzeCycles([{ hasDiff: false }, { hasDiff: false }, { hasDiff: true }])
  assert.equal(r.verdict, 'keep')
})

await t('⑨ 提示词里有六问与放权清单', () => {
  const w = builtinWorkerRules({ workdir: 'x' })
  const d = builtinDispatcherRules()
  for (const k of ['problem', 'cause', 'impact', 'fix', 'regression', 'design']) assert.ok(w.includes(k + '：'), k)
  assert.ok(w.includes('连续两轮都拿不到证据'))
  assert.ok(d.includes('放权'), 'dispatcher 有放权段')
  assert.ok(d.includes('只有这五类事才问人'))
  assert.ok(d.includes('六问报告'), 'dispatcher 知道怎么读六问')
})

if (fails.length) { console.log('FAIL anti-loop ' + fails.length + '/' + (pass + fails.length)); process.exitCode = 1 }
else console.log('PASS anti-loop ' + pass + '/' + pass)