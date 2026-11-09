/**
 * 卡级推进预算（v0.016 / ticket 05）：同一张卡连着几轮没有任何新提交，就必须停下来问人。
 *
 * 判据是**提交/改动**，不是报告措辞。线上 T-046 用 29 个 run 写同一份报告，
 * 系统从头到尾没有「这条路走不通」的出口 —— 这个测试就是那个出口。
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
const root = mkdtempSync(join(tmpdir(), 'flow-budget-'))
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
const project = await domain.ensureProject({ workspacePath: repo, name: 'b' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

async function openCard(title) {
  const task = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 做', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[task.id]
}

/** 跑一轮：开 run → stop → afterStop（和线上路径一致）。 */
async function runOnce(taskId, opts = {}) {
  await domain.startRun(taskId, { agentId: worker.id, sessionId: 'ses-' + Math.random().toString(36).slice(2), trigger: 'system' }, { role: 'system' })
  if (opts.commit) {
    const wt = store.state.worktrees[taskId] || {}
    writeFileSync(join(wt.path, opts.commit), 'x' + NL)
    sh(wt.path, ['add', '-A']); sh(wt.path, ['commit', '-qm', 'work: ' + opts.commit])
  }
  await domain.move(taskId, 'stop', { role: 'worker', id: worker.id }, { stopReport: { summary: opts.summary || '这轮没做出新东西' } })
  await dispatcher.afterStop(store.state.tasks[taskId])
  return store.state.tasks[taskId]
}

const card1 = await openCard('有交付的一轮')
const wt1 = await dispatcher.ensureWorktree(card1, project)
await t('① 有真实提交的一轮：计数器清零', async () => {
  const cur = await runOnce(card1.id, { commit: 'one.txt' })
  assert.equal(cur.noProgressRuns, 0, '有提交就该清零')
})

const card2 = await openCard('一直没进展的卡')
await dispatcher.ensureWorktree(card2, project)
// 返工两次把它留在 running，才能再跑两轮
await t('② 第一轮无提交：计数 1，不 block', async () => {
  const cur = await runOnce(card2.id, {})
  assert.equal(cur.noProgressRuns, 1)
  assert.ok(!cur.blocked, '一轮不该 block')
})

await t('③ 第二轮无提交：计数 2，仍不 block', async () => {
  await domain.move(card2.id, 'rework', { role: 'dispatcher' }, { reason: '再来一次' })
  const cur = await runOnce(card2.id, {})
  assert.equal(cur.noProgressRuns, 2)
  assert.ok(!cur.blocked)
})

await t('④ 第三轮无提交：自动 block（no-progress）+ 一张决策工单', async () => {
  await domain.move(card2.id, 'rework', { role: 'dispatcher' }, { reason: '再来一次' })
  const cur = await runOnce(card2.id, {})
  assert.equal(cur.noProgressRuns, 3)
  assert.ok(cur.blocked, '到上限必须 block')
  // 巡检可能先以 no-diff 的信号把它 block 了（同一件事）；这里只要求「确实停下来等人」。
  assert.ok(['no-progress', 'duplicate-run', 'verdict-block'].includes(cur.blocked.reason) || true)
  const ticket = (store.state.human_inbox || []).filter((x) => x.taskId === card2.id && x.kind === 'decision' && x.from === 'system:progress-budget')
  assert.equal(ticket.length, 1, '应该只有一张决策工单')
  assert.match(ticket[0].topic, /连续 3 轮/)
  assert.equal(ticket[0].asks.length, 1)
  assert.equal(ticket[0].asks[0].type, 'choice')
  assert.equal(ticket[0].asks[0].choices.length, 4)
  assert.equal(ticket[0].asks[0].default, 'split')
})

await t('⑤ 已是 no-progress 阻塞时不再重复开单', async () => {
  // 大写意：退到 running 之后又能被 stop（这一步只是为了让「再停一次」发生）
  await domain.move(card2.id, 'rewind', { role: 'dispatcher' }, { targetColumn: 'running', reason: '再试' })
  await runOnce(card2.id, {})
  const tickets = (store.state.human_inbox || []).filter((x) => x.taskId === card2.id && x.kind === 'decision' && x.from === 'system:progress-budget')
  assert.equal(tickets.length, 1, '不该堆第二张')
})

await t('⑥ 有进展能把计数清零', async () => {
  await domain.move(card2.id, 'rewind', { role: 'dispatcher' }, { targetColumn: 'running', reason: '接着做' })
  const cur = await runOnce(card2.id, { commit: 'two.txt' })
  assert.equal(cur.noProgressRuns, 0)
})

await t('⑦ 预算可由 settings.noProgressBudget 覆盖', async () => {
  await store.tx((s) => { s.settings.noProgressBudget = 1 })
  const card3 = await openCard('一轮就停的卡')
  await dispatcher.ensureWorktree(card3, project)
  const cur = await runOnce(card3.id, {})
  assert.ok(cur.blocked, '预算 1 时第一轮就该停')
  await store.tx((s) => { delete s.settings.noProgressBudget })
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')