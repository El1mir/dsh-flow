/**
 * C-10：子卡 = 工作单元（不开分支、不进合并列、不占 PR）。
 *
 * 这个测试钉住的是「子卡与父卡在交付面上的区别」，不是某条函数：
 *   ① 拓扑判据：needsMerge(子卡) 恒 false，accept 落 done/done-in-parent；
 *   ② 纵深防御：合并类动作（merge_skip / review_approve / review_risk / pr_open）对子卡被拒；
 *   ③ 共用检出：子卡复用父卡目录与 flow/<parent>，没有自己的分支；父卡分支被占时下一个子卡
 *      留在 running + phase='waiting-branch'，不投案卷、不开 run（同目录并发是静默覆盖）；
 *   ④ 交付事实从 git 量：HEAD 没前进 = done-no-commit，前进了 = done-in-parent；
 *   ⑤ 存量卡：迁移给「已有自己分支」的子卡打 legacy-branch，accept 时把分支合进父分支、收掉子分支与 PR。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store, SCHEMA_VERSION, MIGRATIONS, applyTransition } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher, worktreePathFor } from '../lib/dispatch.js'
import * as git from '../lib/git.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-unit-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'base.txt'), 'base' + NL)
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'baseline'])

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
  async onMoved(task, action) { return dispatcher.onMoved(task, action) },
  async onStopped(task) { return dispatcher.onStopped(task) },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'unit' })
// C-11 起：两张 scope 不重叠的子卡默认会并行。这份测试要验的是**共用父检出**那条路，
// 所以显式关掉并行 —— 不是绕开新规则，是选择被测路径（并行那条由 test/unit-parallel.mjs 钉）。
await domain.updateProjectConfig(project.id, { mergeStrategy: 'merge', outOfScopeCheck: false, lockRunningWorktrees: false, unitParallel: false })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}
const change = (id, patch) => store.tx((s) => { Object.assign(s.tasks[id], patch) })
const task = (id) => store.state.tasks[id]

// ---- 1. 纯状态机：拓扑决定去哪 ----
const fakeChild = { id: 'T-CHILD', column: 'verifying', phase: 'awaiting-acceptance', parentId: 'T-PARENT', mergeState: 'none', noMerge: true }
const fakeNormal = { id: 'T-NORMAL', column: 'verifying', phase: 'awaiting-acceptance', mergeState: 'pending', noMerge: false }

await t('子卡 accept 落 done + done-in-parent（不进合并列）', () => {
  const next = applyTransition(fakeChild, 'accept', { role: 'human', id: 'web' })
  assert.equal(next.column, 'done')
  assert.equal(next.phase, 'done-in-parent')
})

await t('对照：普通卡 accept 仍进 merging / merge-ready；无合并卡的普通卡落 done-no-merge', () => {
  const withMerge = applyTransition(fakeNormal, 'accept', { role: 'human', id: 'web' })
  assert.equal(withMerge.column, 'merging')
  assert.equal(withMerge.phase, 'merge-ready')
  const noMerge = applyTransition({ id: 'T-NOMERGE', column: 'verifying', mergeState: 'none', noMerge: true }, 'accept', { role: 'human', id: 'web' })
  assert.equal(noMerge.column, 'done')
  assert.equal(noMerge.phase, 'done-no-merge')
})

await t('合并类动作对子卡一律被拒（文案含「子卡不参与合并」）', () => {
  const inMerging = { id: 'T-CHILD', column: 'merging', phase: 'review-pending', parentId: 'T-PARENT', mergeState: 'pending' }
  const re = /子卡不参与合并/
  assert.throws(() => applyTransition(inMerging, 'merge_skip', { role: 'dispatcher', id: 'd1' }, { reason: '想跳过' }), re)
  assert.throws(() => applyTransition(inMerging, 'review_approve', { role: 'dispatcher', id: 'd1' }, { mergedCommit: 'abc1234' }), re)
  assert.throws(() => applyTransition(inMerging, 'review_risk', { role: 'dispatcher', id: 'd1' }, {}), re)
  assert.throws(() => applyTransition(inMerging, 'pr_open', { role: 'dispatcher', id: 'd1' }, {}), re)
})

// ---- 2. 拆分出来的子卡：字段与共用检出 ----
const parent = await domain.createTask(project.id, { title: '父卡', acceptance: ['子卡都完成'] })
const split = await domain.splitTask(parent.id, {
  reason: '测试子卡生命周期',
  items: [
    { title: '子卡 A', purpose: '改 a', scope: { paths: ['a.txt'] }, effect: 'a', acceptance: ['a 存在'] },
    { title: '子卡 B', purpose: '改 b', scope: { paths: ['b.txt'] }, effect: 'b', acceptance: ['b 存在'] },
  ],
})
const [childA, childB] = split.children
const parentId = store.state.tasks[parent.id].id
const parentDir = worktreePathFor(project, store.state.tasks[parent.id])

await t('拆分出来的子卡自带 unitMode=shared 与 mergeState=none（默认值不能靠状态机猜）', () => {
  for (const c of [childA, childB]) {
    const cur = task(c.id)
    assert.equal(cur.parentId, parent.id)
    assert.equal(cur.unitMode, 'shared')
    assert.equal(cur.mergeState, 'none')
    assert.equal(cur.unitStartSha, null)
  }
})

await change(childA.id, { column: 'running', phase: 'executing' })
await change(childB.id, { column: 'running', phase: 'executing' })

const runA = await dispatcher.dispatch(task(childA.id))

await t('子卡派工复用父卡检出：同目录、分支 flow/<parent>，不新建 flow/<child>', async () => {
  assert.equal(runA.ok, true, JSON.stringify(runA))
  const wt = store.state.worktrees[childA.id]
  assert.ok(wt, '子卡要有只读投影')
  assert.equal(wt.shared, true)
  assert.equal(wt.path, parentDir)
  assert.equal(wt.branch, 'flow/' + parentId)
  assert.equal(task(childA.id).worktree.path, parentDir)
  assert.equal(await git.branchExists(repo, 'flow/' + childA.id), false, '子卡不该有自己的分支')
  assert.equal(await git.branchExists(repo, 'flow/' + parentId), true, '父分支要被建出来')
  assert.ok(store.state.worktrees[parent.id], '父卡自己的检出登记也建出来了')
})

const runB = await dispatcher.dispatch(task(childB.id))

await t('第二个子卡抢不到父检出租约：phase=waiting-branch、没有 run、不写检出', async () => {
  assert.equal(runB.ok, false)
  assert.equal(runB.waiting, true)
  const b = task(childB.id)
  assert.equal(b.phase, 'waiting-branch')
  assert.equal(b.activeRunId || null, null)
  assert.equal(store.state.worktrees[childB.id] || null, null, '没抢到租约就不该留下投影')
  assert.equal(await git.branchExists(repo, 'flow/' + childB.id), false)
})

// 第一个子卡：自停 + 验收（这一轮没有提交）
await domain.move(childA.id, 'stop', { role: 'worker', id: runA.agentId }, { stopReport: { summary: '这一轮只读检查，没有改动', tests: '无' } })
await domain.move(childA.id, 'accept', { role: 'human', id: 'web' }, {})

await t('子卡 accept 但父分支 HEAD 没前进 → done-no-commit，且不开 PR', () => {
  const a = task(childA.id)
  assert.equal(a.column, 'done')
  assert.equal(a.phase, 'done-no-commit')
  assert.equal(Object.values(store.state.pull_requests).filter((p) => p.taskId === childA.id).length, 0, '子卡不该有 PR')
})

await t('第一个子卡验收后，第二个子卡能接着派工', async () => {
  assert.equal(domain.unitLeaseOf(parentId) || null, null, '租约要随验收释放')
  const again = await dispatcher.dispatch(task(childB.id))
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(task(childB.id).activeRunId, again.runId)
})

// 第二个子卡：提交一次改动后验收
writeFileSync(join(parentDir, 'b.txt'), 'b' + NL)
const committed = await git.commitAll({ dir: parentDir, message: 'child b work' })
const startB = task(childB.id).unitStartSha

await t('第二个子卡在父分支上提交：HEAD 前进', () => {
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.notEqual(committed.headSha, startB)
  assert.equal(committed.headSha, sh(repo, ['rev-parse', 'flow/' + parentId]).trim())
})

await domain.move(childB.id, 'stop', { role: 'worker', id: task(childB.id).assignee }, { stopReport: { summary: '提交了 b.txt', files: ['b.txt'], tests: '无' } })
await domain.move(childB.id, 'accept', { role: 'human', id: 'web' }, {})

await t('子卡 accept 且父分支 HEAD 前进 → done-in-parent（交付事实从 git 量）', () => {
  const b = task(childB.id)
  assert.equal(b.column, 'done')
  assert.equal(b.phase, 'done-in-parent')
  assert.equal(b.headSha, committed.headSha, '验收绑定的提交号要来自父检出')
})

// ---- 3. 迁移：schema 14 给子卡打 unitMode ----
const migFile = join(root, 'legacy.json')
writeFileSync(migFile, JSON.stringify({
  schemaVersion: 13,
  seq: { task: 5, pr: 0, run: 0, invoice: 0, approval: 0, comment: 0, event: 0, inbox: 0, injection: 0, effect: 0 },
  tasks: {
    'T-901': { id: 'T-901', title: '父卡', column: 'planning', childIds: ['T-902', 'T-903', 'T-904'] },
    'T-902': { id: 'T-902', title: '老子卡', parentId: 'T-901', worktree: { branch: 'flow/T-902' } },
    'T-903': { id: 'T-903', title: '无分支子卡', parentId: 'T-901', worktree: null },
    'T-904': { id: 'T-904', title: '已有共享投影', parentId: 'T-901' },
    'T-905': { id: 'T-905', title: '普通卡' },
  },
  worktrees: { 'T-904': { branch: 'flow/T-901', shared: true } },
}))
const migrated = new Store(migFile)
await migrated.load()

await t('迁移 schema 14：有自己分支的子卡 → legacy-branch，无分支 → shared，普通卡不动', () => {
  assert.equal(SCHEMA_VERSION, 14)
  assert.equal(migrated.state.schemaVersion, 14)
  assert.equal(migrated.state.tasks['T-902'].unitMode, 'legacy-branch')
  assert.equal(migrated.state.tasks['T-903'].unitMode, 'shared')
  assert.equal(migrated.state.tasks['T-904'].unitMode, 'shared', '共享投影的分支是父分支，不该判成交 legacy')
  assert.equal(migrated.state.tasks['T-905'].unitMode, undefined, '非子卡不写这个字段')
})

await t('迁移幂等：再跑一次 MIGRATIONS[13] 不改任何 unitMode', () => {
  const once = JSON.parse(JSON.stringify(migrated.state))
  const twice = MIGRATIONS[13](JSON.parse(JSON.stringify(once)))
  for (const id of ['T-902', 'T-903', 'T-904', 'T-905']) {
    assert.equal(twice.tasks[id].unitMode, once.tasks[id].unitMode, id + ' 的 unitMode 被改了')
  }
})

// ---- 4. legacy-branch 收尾：合进父分支 + 删子分支 + PR 作废 ----
const childC = await domain.createTask(project.id, { title: '老子卡 C', acceptance: ['c 存在'] })
await change(childC.id, {
  parentId: parent.id, branchFrom: 'flow/' + parentId, unitMode: 'legacy-branch',
  mergeState: 'pending', noMerge: false, column: 'running', phase: 'executing',
  plan: { revision: 1, text: '老子卡的计划' }, worktree: null,
})
const wtC = await dispatcher.ensureWorktree(task(childC.id), project)
writeFileSync(join(wtC.path, 'c.txt'), 'c' + NL)
const commitC = await git.commitAll({ dir: wtC.path, message: 'child c work' })
const pr = await domain.openPullRequest(childC.id, {
  headSha: commitC.headSha, baseSha: sh(repo, ['rev-parse', 'flow/' + parentId]).trim(),
  files: ['c.txt'], additions: 1, deletions: 0, summary: '子卡 C 的改动',
}, { role: 'worker', id: 'w-c' })
await change(childC.id, { column: 'verifying', phase: 'awaiting-acceptance', headSha: commitC.headSha })

await t('legacy 子卡仍用自己的分支（不被共享检出规则改坏）', async () => {
  assert.equal(wtC.ok, true, JSON.stringify(wtC))
  assert.equal(wtC.branch, 'flow/' + childC.id)
  assert.notEqual(wtC.path, parentDir)
  assert.equal(await git.branchExists(repo, 'flow/' + childC.id), true)
})

const acceptedC = await domain.move(childC.id, 'accept', { role: 'human', id: 'web' }, {})

await t('legacy accept：分支合进父分支、删子分支、PR 快照作废', async () => {
  const c = task(childC.id)
  assert.equal(c.column, 'done', JSON.stringify(acceptedC))
  assert.equal(c.phase, 'done-in-parent')
  assert.equal(await git.isAncestor(repo, commitC.headSha, 'flow/' + parentId), true, '父分支要真的包含这次改动')
  assert.equal(await git.branchExists(repo, 'flow/' + childC.id), false, '子分支要删掉')
  assert.equal(c.mergeRequest, null)
  assert.equal(store.state.pull_requests[pr.id].status, 'superseded')
  assert.equal(store.state.worktrees[childC.id] || null, null, '子卡检出要回收')
  assert.equal(c.blocked || null, null, '成功收尾不该把卡标成阻塞')
})

console.log('')
console.log(pass + ' passed, ' + fails.length + ' failed')
if (fails.length) {
  for (const f of fails) console.log('- ' + f.name + ': ' + String((f.err && f.err.stack) || f.err))
  process.exit(1)
}
