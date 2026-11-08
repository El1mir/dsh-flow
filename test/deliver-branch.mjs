/**
 * C-05 / rf-01：子卡的交付落点是**父卡的集成分支**，不是 base。
 *
 * 这张测试钉住三条不变式（都是 rf-01 决议里最贵的部分）：
 *   ① 子卡合并后 base **不动**（只有父卡收口才动 base）；
 *   ② 子卡落 done/merged-into-parent，且 `isDelivered === false`（代码还在父分支上）；
 *   ③ 父卡随后把集成分支合进 base，这时才算交付。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store, isDelivered } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import { resolveTarget } from '../lib/deliver.js'
import * as git from '../lib/git.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-deliver-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'base.txt'), 'base' + NL)
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'baseline'])
const baseSha0 = sh(repo, ['rev-parse', 'main']).trim()

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession(agent, project) {
    const rec = domain.latestSession(agent.id)
    if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId, created: false }
    const sessionId = 'ses-' + agent.id
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: project.workspacePath }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async workerGoal() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'deliver' })
await domain.updateProjectConfig(project.id, { mergeStrategy: 'merge', outOfScopeCheck: false })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

// 父卡 + 子卡：直接造数据（走真实的 splitTask 需要 approve 等前序，与本票无关）。
const parentTask = await domain.createTask(project.id, { title: '父卡', acceptance: ['x'] })
const childTask = await domain.createTask(project.id, { title: '子卡', acceptance: ['x'] })
await store.tx((s) => {
  const p = s.tasks[parentTask.id]
  const c = s.tasks[childTask.id]
  p.childIds = [c.id]
  p.phase = 'split'
  p.column = 'verifying'
  p.mergeState = 'pending'
  p.noMerge = false
  c.parentId = p.id
  c.branchFrom = 'flow/' + p.id
  c.mergeState = 'pending'
  c.noMerge = false
  c.worktree = false
})

await t('resolveTarget：子卡的目标是父分支，普通卡是 base', () => {
  assert.equal(resolveTarget(store.state.tasks[childTask.id]).kind, 'branch')
  assert.equal(resolveTarget(store.state.tasks[childTask.id]).branch, 'flow/' + parentTask.id)
  assert.equal(resolveTarget(store.state.tasks[parentTask.id]).kind, 'base')
})

// 子卡跑一轮：建检出（base 会从父分支拉出来 —— 这正是 baseRefFor 的作用），提交一次改动。
const wt = await dispatcher.ensureWorktree(store.state.tasks[childTask.id], project)
await t('子卡的检出从父分支拉出来（父分支被 materialize 出来）', async () => {
  assert.equal(wt.ok, true, JSON.stringify(wt))
  assert.equal(wt.branch, 'flow/' + childTask.id)
  assert.equal(await git.branchExists(repo, 'flow/' + parentTask.id), true, '父分支要被建出来')
})
writeFileSync(join(wt.path, 'child.txt'), 'child' + NL)
await git.commitAll({ dir: wt.path, message: 'child work' })

// 子卡进入合并列，按 human 合并（by=human 跳过审核判据，与看板上点合并同路径）。
await store.tx((s) => {
  const c = s.tasks[childTask.id]
  c.column = 'merging'
  c.phase = 'merge-ready'
  c.mergeState = 'pending'
  c.headSha = null
})
const merged = await dispatcher.merge(store.state.tasks[childTask.id], { by: 'human' })

await t('子卡合并成功，落点是父分支（不是 base）', () => {
  assert.equal(merged.ok, true, JSON.stringify(merged))
  assert.equal(merged.base, 'flow/' + parentTask.id)
})

await t('子卡合并后 base 没动（父卡还没收口）', () => {
  const baseNow = sh(repo, ['rev-parse', 'main']).trim()
  assert.equal(baseNow, baseSha0, 'base 必须一个字节都没动')
})

await t('子卡落 done/merged-into-parent，且不算已交付', () => {
  const c = store.state.tasks[childTask.id]
  assert.equal(c.column, 'done')
  assert.equal(c.phase, 'merged-into-parent')
  assert.equal(c.mergeState, 'none', '合进父分支之后不该再「等着合」（实际 ' + String(c.mergeState) + ' / ' + String(c.humanReason || c.noMergeReason || '') + '）')
  assert.equal(isDelivered(c), false)
})

await t('父分支上真的有子卡的提交', () => {
  const log = sh(repo, ['log', '--oneline', 'flow/' + parentTask.id]).toString()
  assert.match(log, /child work/)
})

// 父卡收口：子卡全部 done → rollupParent 已经跑过，父卡应在 verifying 且 mergeState=pending。
await t('父卡被标成有集成分支（不再「只做汇总」）', () => {
  const p = store.state.tasks[parentTask.id]
  assert.equal(p.integrationBranch, 'flow/' + parentTask.id)
  assert.equal(p.mergeState, 'pending')
  assert.notEqual(p.noMerge, true)
})

// 父卡合进 base：需要一个 PR 快照（普通卡的路径），先开 PR。
const opened = await dispatcher.openPr(store.state.tasks[parentTask.id])
await t('父卡能在集成分支上开出 PR（没有检出也能开）', () => {
  assert.equal(opened.ok, true, JSON.stringify(opened))
})

await store.tx((s) => {
  const p = s.tasks[parentTask.id]
  p.column = 'merging'
  p.phase = 'merge-ready'
  p.mergeState = 'pending'
})
const parentMerged = await dispatcher.merge(store.state.tasks[parentTask.id], { by: 'human' })
await t('父卡合进 base：这时才算交付', async () => {
  assert.equal(parentMerged.ok, true, JSON.stringify(parentMerged))
  const p = store.state.tasks[parentTask.id]
  assert.equal(p.column, 'done')
  assert.equal(p.phase, 'merged')
  assert.equal(isDelivered(p), true)
  const baseNow = sh(repo, ['rev-parse', 'main']).trim()
  assert.notEqual(baseNow, baseSha0, 'base 这时应该前进了')
})

console.log('')
if (fails.length) {
  console.log('deliver branch FAILED (' + fails.length + ' of ' + (pass + fails.length) + ')')
  process.exit(1)
}
console.log('deliver branch ok (' + pass + ' checks)')