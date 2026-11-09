/**
 * 依赖按产物判定（v0.016 / ticket 13）：上游写出来的东西在分支上，下游就能开工。
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
const root = mkdtempSync(join(tmpdir(), 'flow-deps-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'base' + NL)
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
const project = await domain.ensureProject({ workspacePath: repo, name: 'd' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })
await domain.ensureAgents(project.id)
const workers = Object.values(store.state.agents).filter((a) => a.role === 'worker')
for (const w of workers) await domain.bindSession(w.id, 'ses-' + w.id, { state: 'idle' }, { role: 'system' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL).slice(0, 4).join(' | ')) }
}

async function ready(title, patch) {
  const task = await domain.createTask(project.id, { title, acceptance: ['x'] })
  if (patch) await store.tx((s) => { Object.assign(s.tasks[task.id], patch) })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 做', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[task.id]
}

const up = await ready('上游卡')
await dispatcher.ensureWorktree(up, project)
const down = await ready('下游卡', { dependsOn: [up.id], dependsOnMeta: [{ taskId: up.id, artifacts: ['report.md'] }] })

await t('① 产物还没写出来 → 下游等（文案能指到路径）', async () => {
  const res = await dispatcher.dispatch(store.state.tasks[down.id])
  assert.equal(res.ok, false)
  assert.match(String(res.message), /等待前置子卡完成/)
  const { waitingReasonFor } = await import('../lib/view-model.js')
  const why = waitingReasonFor(store.state.tasks[down.id], { tasks: Object.values(store.state.tasks) })
  assert.match(why.text, /report\.md/)
})

await t('② 上游把产物提交到自己的分支 → 下游立刻放行（上游整张卡还没验收）', async () => {
  const wt = store.state.worktrees[up.id]
  writeFileSync(join(wt.path, 'report.md'), '# 报告' + NL)
  sh(wt.path, ['add', '-A']); sh(wt.path, ['commit', '-qm', 'docs: report'])
  const res = await dispatcher.dispatch(store.state.tasks[down.id])
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200))
  assert.ok(store.state.tasks[down.id].activeRunId)
})

await t('③ 两卡各自独立的检出与分支（并行不互相踩）', () => {
  const a = store.state.worktrees[up.id]
  const b = store.state.worktrees[down.id]
  assert.ok(a && b && a.path !== b.path)
  assert.notEqual(a.branch, b.branch)
})

const down2 = await ready('没声明的下游卡', { dependsOn: [up.id] })
await t('④ 没声明产物 → 退回旧判据（上游必须验收完成）', async () => {
  const res = await dispatcher.dispatch(store.state.tasks[down2.id])
  assert.equal(res.ok, false)
  assert.match(String(res.message), /等待前置子卡完成/)
})

await t('⑤ 上游验收完成后，旧判据放行', async () => {
  await store.tx((s) => { Object.assign(s.tasks[up.id], { column: 'done', phase: 'merged' }) })
  const res = await dispatcher.dispatch(store.state.tasks[down2.id])
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 160))
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')