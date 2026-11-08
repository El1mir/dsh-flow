/**
 * v0.007：卡片可以回退（调度与人都能），回退不受「被阻塞」冻结。
 *
 * 线上 T-048 的现场：评审 settled、拆分草稿已定，卡却在 verifying；
 *
 * splitTask 只收 todo/planning，reject/rework 的 from 也不含 verifying —— 四条路全堵，
 *
 * 只能 取消 + 重开（重开计数涨一次，审计里看着像这张卡反复失败）。
 *
 * 现在的口径：硬守卫只拦「没走完生命周期就推完」，回推不该被冻结。
 *
 * 文件顺序对应 core.js 的 REWIND_TARGETS。
 *
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-rewind-'))
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
const project = await domain.ensureProject({ workspacePath: repo, name: 'rewind' })
await domain.ensureAgents(project.id)
const actor = { role: 'human', id: 'web' }

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

/** 直接把卡摆到某一列（绕过前进守卫，模拟线上那张卡的历史状态）。 */
async function place(taskId, column, extra = {}) {
  await store.tx((s) => { Object.assign(s.tasks[taskId], { column, phase: extra.phase || '' }, extra) })
}

const tk = await domain.createTask(project.id, { title: '走早了', acceptance: ['x'] })
await place(tk.id, 'verifying', { phase: 'awaiting-acceptance', mergeState: 'pending' })

const one = await domain.move(tk.id, 'rewind', actor, { targetColumn: 'planning', reason: '评审结论推翻了实现方案，先回规划重写' })

await t('① verifying 可以回退到 planning', () => {
  assert.equal(one.column, 'planning')
  assert.equal(store.state.tasks[tk.id].column, 'planning')
})

await t('①b 阶段被清空（不带着 awaiting-acceptance 退回去）', () => {
  assert.equal(store.state.tasks[tk.id].phase, '')
})

await t('①c 原因写进 history 与 lastRewind（审计要能看出是谁为什么退的）', () => {
  const cur = store.state.tasks[tk.id]
  const entry = cur.history[cur.history.length - 1]
  assert.equal(entry.action, 'rewind')
  assert.equal(entry.column, 'planning')
  assert.match(entry.reason, /评审结论推翻了实现方案/)
  assert.equal(cur.lastRewind.from, 'verifying')
  assert.equal(cur.lastRewind.to, 'planning')

})

await t('② 回退之后 splitTask 能用了（T-048 的实际诉求）', async () => {
  const res = await domain.splitTask(tk.id, {
    reason: '方案已定，拆成两个工作包',
    items: [
      { title: '包一', purpose: '把 A 做掉', effect: '只有 A 模块', scope: { paths: ['src/a.js'] }, acceptance: ['a 能跑'] },
      { title: '包二', purpose: '把 B 做掉', effect: '只有 B 模块', scope: { paths: ['src/b.js'] }, acceptance: ['b 能跑'] },
    ],
  }, { role: 'dispatcher', id: 'system' })
  assert.equal((res.children || res.childIds || []).length >= 0, true)
  const cur = store.state.tasks[tk.id]
  assert.equal(cur.childIds.length, 2)
})

const blockedTask = await domain.createTask(project.id, { title: '卡住的卡', acceptance: ['x'] })
await place(blockedTask.id, 'verifying', { phase: 'awaiting-acceptance' })
await domain.block(blockedTask.id, '依赖服务一直 500', { role: 'system', id: 'system:test' })

await t('③ 被阻塞的卡也能回退（回退不受冻结）', async () => {
  assert.ok(store.state.tasks[blockedTask.id].blocked)
  const res = await domain.move(blockedTask.id, 'rewind', actor, { targetColumn: 'running', reason: '换个做法重做' })
  assert.equal(res.column, 'running')
  assert.equal(store.state.tasks[blockedTask.id].blocked, null, '退回去之后阻塞标记要清掉')
})

await t('③b 回退会清掉上一轮的停止报告（否则自动验收会拿旧报告直接收）', async () => {
  const t2 = await domain.createTask(project.id, { title: '带停止报告', acceptance: ['x'] })
  await place(t2.id, 'verifying', { phase: 'awaiting-acceptance', stopReport: { summary: '做完了', tests: 'npm test 12 passed' } })
  await domain.move(t2.id, 'rewind', actor, { targetColumn: 'planning', reason: '报告是上一轮遗留的' })
  assert.equal(store.state.tasks[t2.id].stopReport, null)
})

await t('④ 有运行中的 run 时拒绝回退', async () => {
  const t3 = await domain.createTask(project.id, { title: '在跑', acceptance: ['x'] })
  await place(t3.id, 'running', { activeRunId: 'run_x' })
  await assert.rejects(() => domain.move(t3.id, 'rewind', actor, { targetColumn: 'planning', reason: '想退' }), /运行中的 run/)
})

await t('⑤ 终态卡不能回退（提示用 reopen）', async () => {
  const t4 = await domain.createTask(project.id, { title: '已完成', acceptance: ['x'] })
  await place(t4.id, 'done', { phase: 'merged' })
  await assert.rejects(() => domain.move(t4.id, 'rewind', actor, { targetColumn: 'planning', reason: '想退' }), /reopen|不允许/)
})

await t('⑥ 不写原因拒绝（历史里不能出现「卡自己变回去了」）', async () => {
  const t5 = await domain.createTask(project.id, { title: '没原因', acceptance: ['x'] })
  await place(t5.id, 'verifying', { phase: 'awaiting-acceptance' })
  await assert.rejects(() => domain.move(t5.id, 'rewind', actor, { targetColumn: 'planning' }), /reason/)
})

await t('⑦ 只能往更早的列退（向前请用前进动作）', async () => {
  const t6 = await domain.createTask(project.id, { title: '向前', acceptance: ['x'] })
  await place(t6.id, 'planning')
  await assert.rejects(() => domain.move(t6.id, 'rewind', actor, { targetColumn: 'verifying', reason: '想往前' }), /更早|向前/)
})

await t('⑧ 目标列不在 REWIND_TARGETS 里拒绝', async () => {
  const t7 = await domain.createTask(project.id, { title: '目标非法', acceptance: ['x'] })
  await place(t7.id, 'verifying', { phase: 'awaiting-acceptance' })
  await assert.rejects(() => domain.move(t7.id, 'rewind', actor, { targetColumn: 'done', reason: '想退到完成？' }), /回退目标/)
})

await t('⑨ 调度也能回退（不只是人）', async () => {
  const t8 = await domain.createTask(project.id, { title: '调度回退', acceptance: ['x'] })
  await place(t8.id, 'merging', { phase: 'merge-ready' })
  const res = await domain.move(t8.id, 'rewind', { role: 'dispatcher', id: 'ag_x' }, { targetColumn: 'verifying', reason: 'PR 里有越界改动，退回验收' })
  assert.equal(res.column, 'verifying')
})

if (fails.length) {
  console.log('FAIL rewind ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err).split(NL).slice(0, 3).join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS rewind ' + pass + '/' + pass)
}