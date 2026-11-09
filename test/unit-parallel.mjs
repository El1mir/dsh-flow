/**
 * C-11：子卡的互斥由 scope 决定，不是由拓扑决定（允许并行）。
 *
 * 这个测试钉住五件事：
 *   ① 判据是纯函数：scope 重叠 → 互斥；缺 scope → 保守互斥；不相交 → 可并行；
 *   ② 派工选路：不相交的两张子卡同时派出 → 各拿一条**瞬时分枝** + 独立目录，父分支头不变；
 *      相交的第二张 → 留在 waiting-branch，不建检出（同一目录并发是静默覆盖）；
 *   ③ 没人抢的时候不付并行的钱：没有兄弟在跑（或它已离场）→ 复用父卡检出，不建瞬时分枝；
 *      并行只发生在「真要同时干两件事」时；
 *   ④ 验收收尾：并行子卡的改动合进父分支、瞬时分枝删掉、落 done-in-parent；
 *   ⑤ 合并竞态：B 基于旧头（A 先合进去了）→ rebase 到父分支再合一次，
 *      否则线上会变成「偶尔合不进去」的幽灵问题。
 *
 * 用临时 git 仓库跑，不 mock git：C-11 的难点全在 git 的物理约束上，
 * 把 git 换成假的，这个测试就只是在测自己的假设。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher, worktreePathFor } from '../lib/dispatch.js'
import * as git from '../lib/git.js'
import { scopesConflict, canRunParallel, scratchBranchFor } from '../lib/units.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-unit-par-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'base.txt'), 'base' + NL)
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'baseline'])
const baseSha = sh(repo, ['rev-parse', 'main']).trim()

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
const project = await domain.ensureProject({ workspacePath: repo, name: 'unit-parallel' })
// mergeStrategy=rebase：C-11 的合并竞态只在「只接受快进」的策略下才暴露成 needs-rebase，
// 用 merge 策略它会自己开一个合并提交，测不到 rebase 重试那条路。
await domain.updateProjectConfig(project.id, { mergeStrategy: 'rebase', outOfScopeCheck: false, lockRunningWorktrees: false })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}
const change = (id, patch) => store.tx((s) => { Object.assign(s.tasks[id], patch) })
const task = (id) => store.state.tasks[id]

// ---- 1. 纯判据：scope 决定互斥 ----
await t('scopesConflict：路径前缀重叠 → 互斥（父目录算重叠）', () => {
  assert.equal(scopesConflict({ paths: ['lib'] }, { paths: ['lib/dispatch.js'] }), true)
  assert.equal(scopesConflict({ paths: ['lib/dispatch.js'] }, { paths: ['lib/dispatch.js'] }), true)
})

await t('scopesConflict：符号同名或前缀 → 互斥（Dispatcher / Dispatcher.run）', () => {
  assert.equal(scopesConflict({ symbols: ['Dispatcher'] }, { symbols: ['Dispatcher.run'] }), true)
  assert.equal(scopesConflict({ symbols: ['Dispatcher.run'] }, { symbols: ['Dispatcher'] }), true)
  assert.equal(scopesConflict({ symbols: ['Dispatcher'] }, { symbols: ['DispatcherX'] }), false, '前缀必须以 . 分界')
})

await t('scopesConflict：有一方没声明 scope → 互斥（保守，宁可串行）', () => {
  assert.equal(scopesConflict({}, { paths: ['a.txt'] }), true)
  assert.equal(scopesConflict({ paths: ['a.txt'], symbols: ['A'] }, {}), true)
  assert.equal(scopesConflict({ paths: [], symbols: [] }, { paths: ['a.txt'] }), true)
})

await t('scopesConflict：路径与符号都不相交 → 可并行', () => {
  assert.equal(scopesConflict({ paths: ['lib/units.js'], symbols: ['units'] }, { paths: ['lib/split.js'], symbols: ['split'] }), false)
  assert.equal(scopesConflict({ paths: ['lib/a.js'] }, { paths: ['test/b.mjs'] }), false)
})

await t('scratchBranchFor：unit/<parent>/<task>，非法字符被归一', () => {
  assert.equal(scratchBranchFor('T-010', 'T-012'), 'unit/T-010/T-012')
  assert.equal(scratchBranchFor('T 1', 'x/y'), 'unit/T-1/x-y', '分支名里不能有空格与斜杠')
})

// ---- 2. 纯判据：只看正在跑的兄弟 ----
const sib = (patch) => ({ id: 'T-S1', parentId: 'T-P', column: 'running', activeRunId: 'run_1', scope: { paths: ['b.txt'] }, ...patch })
const me = { id: 'T-ME', parentId: 'T-P', column: 'running', scope: { paths: ['a.txt'] } }

await t('canRunParallel：兄弟在跑且不冲突 → true', () => {
  assert.equal(canRunParallel(me, [sib({})]), true)
})

await t('canRunParallel：兄弟在跑且冲突 → false', () => {
  assert.equal(canRunParallel(me, [sib({ scope: { paths: ['a.txt'] } })]), false)
  assert.equal(canRunParallel(me, [sib({ scope: {} })]), false, '缺 scope 的兄弟也要挡住')
})

await t('canRunParallel：兄弟不在跑 → true（排队那张不参与判）', () => {
  const queued = sib({ column: 'todo', activeRunId: null, scope: { paths: ['a.txt'] } })
  assert.equal(canRunParallel(me, [queued]), true)
  assert.equal(canRunParallel(me, []), true)
  assert.equal(canRunParallel(me, [sib({ parentId: 'T-OTHER', scope: { paths: ['a.txt'] } })]), true, '不是兄弟不参与')
})

// ---- 3. 端到端：不相交的两张同时派出 ----
const parent1 = await domain.createTask(project.id, { title: '父卡（并行）', acceptance: ['两张子卡都完成'] })
const split1 = await domain.splitTask(parent1.id, {
  reason: '并行 e2e',
  items: [
    { title: '子卡 X', purpose: '改 x', scope: { paths: ['x.txt'] }, effect: 'x', acceptance: ['x 存在'] },
    { title: '子卡 Y', purpose: '改 y', scope: { paths: ['y.txt'] }, effect: 'y', acceptance: ['y 存在'] },
  ],
})
const [childX, childY] = split1.children
const parentBranch1 = 'flow/' + parent1.id
const parentDir1 = worktreePathFor(project, task(parent1.id))
await change(childX.id, { column: 'running', phase: 'executing' })
await change(childY.id, { column: 'running', phase: 'executing' })

const runX = await dispatcher.dispatch(task(childX.id))
const runY = await dispatcher.dispatch(task(childY.id))

await t('两张 scope 不相交的子卡同时派出：各自成功、不同工人、都在跑', () => {
  assert.equal(runX.ok, true, JSON.stringify(runX))
  assert.equal(runY.ok, true, JSON.stringify(runY))
  assert.notEqual(runX.agentId, runY.agentId, '拆开的子卡要分给不同工人，否则并行只是名义上的')
  assert.equal(task(childX.id).activeRunId, runX.runId)
  assert.equal(task(childY.id).activeRunId, runY.runId)
})

await t('并行子卡各拿一条瞬时分枝 + 独立目录（不是父卡检出）', async () => {
  const wtX = store.state.worktrees[childX.id]
  const wtY = store.state.worktrees[childY.id]
  assert.ok(wtX && wtY, '两张卡都要有检出登记')
  assert.notEqual(wtX.path, wtY.path, '两个并行子卡不能共用一个目录')
  assert.notEqual(wtX.path, parentDir1)
  assert.equal(wtX.branch, scratchBranchFor(parent1.id, childX.id))
  assert.equal(wtY.branch, scratchBranchFor(parent1.id, childY.id))
  assert.notEqual(wtX.shared, true, '并行检出不共用父卡投影')
  assert.equal(await git.branchExists(repo, wtX.branch), true)
  assert.equal(await git.branchExists(repo, wtY.branch), true)
  assert.equal(await git.branchExists(repo, 'flow/' + childX.id), false, '并行子卡不建任务分支 flow/<id>')
  assert.equal(task(childX.id).unitMode, 'parallel')
  assert.equal(task(childY.id).unitMode, 'parallel')
})

await t('派工不改父分支：两张卡都从父分支头拉出，谁也没动它', async () => {
  assert.equal(sh(repo, ['rev-parse', parentBranch1]).trim(), baseSha, '父分支头必须还是基线')
  assert.equal(task(childX.id).unitStartSha, baseSha)
  assert.equal(task(childY.id).unitStartSha, baseSha)
  assert.equal(store.state.worktrees[parent1.id] || null, null, '并行路线不需要父卡自己的检出')
})

// X 先做：提交 x.txt 然后验收
const wtXPath = store.state.worktrees[childX.id].path
writeFileSync(join(wtXPath, 'x.txt'), 'x' + NL)
const commitX = await git.commitAll({ dir: wtXPath, message: 'child x work' })
await domain.move(childX.id, 'stop', { role: 'worker', id: runX.agentId }, { stopReport: { summary: '加了 x.txt', files: ['x.txt'], tests: '无' } })
await domain.move(childX.id, 'accept', { role: 'human', id: 'web' }, {})

await t('并行子卡验收：改动合进父分支、瞬时分枝删掉、落 done-in-parent', async () => {
  const x = task(childX.id)
  assert.equal(x.column, 'done')
  assert.equal(x.phase, 'done-in-parent', 'HEAD 前进了就必须落 done-in-parent')
  assert.equal(await git.isAncestor(repo, commitX.headSha, parentBranch1), true, '父分支要真的包含这次改动')
  assert.equal(sh(repo, ['show', parentBranch1 + ':x.txt']).trim(), 'x', '内容要真的在父分支上')
  assert.equal(await git.branchExists(repo, scratchBranchFor(parent1.id, childX.id)), false, '瞬时分枝是内部细节，必须删掉')
  assert.equal(store.state.worktrees[childX.id] || null, null, '并行检出要回收')
  assert.equal(Object.values(store.state.pull_requests).filter((p) => p.taskId === childX.id).length, 0, '子卡不该有 PR')
})

// Y 基于旧头（X 合进去之前拉出来的）：这条分支落后了，必须 rebase 再合
const wtYPath = store.state.worktrees[childY.id].path
writeFileSync(join(wtYPath, 'y.txt'), 'y' + NL)
const commitY = await git.commitAll({ dir: wtYPath, message: 'child y work' })
const parentAfterX = sh(repo, ['rev-parse', parentBranch1]).trim()
await domain.move(childY.id, 'stop', { role: 'worker', id: runY.agentId }, { stopReport: { summary: '加了 y.txt', files: ['y.txt'], tests: '无' } })
await domain.move(childY.id, 'accept', { role: 'human', id: 'web' }, {})

await t('合并竞态：B 基于旧头 → rebase 到父分支再合，落地而不是卡住', async () => {
  const y = task(childY.id)
  assert.equal(y.phase, 'done-in-parent', '落后一条提交不该变成 blocked：那是正常的并行现象')
  assert.equal(sh(repo, ['show', parentBranch1 + ':y.txt']).trim(), 'y', '内容要真的在父分支上')
  assert.notEqual(sh(repo, ['rev-parse', parentBranch1]).trim(), parentAfterX, '父分支要因为这次合并再前进')
  // rebase 会重写提交 → 旧 sha 不在父分支历史里，这正是「重试真的走了 rebase」的证据
  assert.equal(await git.isAncestor(repo, commitY.headSha, parentBranch1), false, 'rebase 策略下旧头应当被重写')
  assert.equal(await git.branchExists(repo, scratchBranchFor(parent1.id, childY.id)), false)
  assert.equal(store.state.worktrees[childY.id] || null, null)
})

// ---- 4. 端到端：互斥的两张（符号重叠）→ 第二张 waiting-branch ----
const parent2 = await domain.createTask(project.id, { title: '父卡（互斥）', acceptance: ['两张子卡都完成'] })
const split2 = await domain.splitTask(parent2.id, {
  reason: '互斥 e2e',
  // 路径不相交（splitTask 会放行），但符号重叠 —— 按 C-11 的判据这就是互斥。
  items: [
    { title: '互斥 A', purpose: '改 loader', scope: { paths: ['oa.txt'], symbols: ['Dispatcher'] }, effect: 'a', acceptance: ['a 存在'] },
    { title: '互斥 B', purpose: '改 loader', scope: { paths: ['ob.txt'], symbols: ['Dispatcher.run'] }, effect: 'b', acceptance: ['b 存在'] },
  ],
})
const [mutexA, mutexB] = split2.children
const parentDir2 = worktreePathFor(project, task(parent2.id))
await change(mutexA.id, { column: 'running', phase: 'executing' })
await change(mutexB.id, { column: 'running', phase: 'executing' })

const runA2 = await dispatcher.dispatch(task(mutexA.id))
const runB2 = await dispatcher.dispatch(task(mutexB.id))

await t('符号重叠的两张子卡：第一张走共用父检出，第二张 waiting-branch 且不建检出', async () => {
  assert.equal(runA2.ok, true, JSON.stringify(runA2))
  const wtA = store.state.worktrees[mutexA.id]
  assert.ok(wtA, '互斥卡要有共用检出的只读投影')
  assert.equal(wtA.shared, true)
  assert.equal(wtA.path, parentDir2, '互斥卡沿用父卡检出（一卡一分支的物理约束）')
  assert.equal(wtA.branch, 'flow/' + parent2.id)
  assert.notEqual(task(mutexA.id).unitMode, 'parallel')

  assert.equal(runB2.ok, false)
  assert.equal(runB2.waiting, true)
  const b = task(mutexB.id)
  assert.equal(b.phase, 'waiting-branch')
  assert.equal(b.activeRunId || null, null)
  assert.equal(store.state.worktrees[mutexB.id] || null, null, '没抢到租约就不该留下任何检出登记')
  assert.equal(await git.branchExists(repo, scratchBranchFor(parent2.id, mutexB.id)), false, '更不该建瞬时分枝')
})

await domain.move(mutexA.id, 'stop', { role: 'worker', id: runA2.agentId }, { stopReport: { summary: '只读检查，没有改动', tests: '无' } })
await domain.move(mutexA.id, 'accept', { role: 'human', id: 'web' }, {})

await t('互斥卡验收后放租约：等待的那张能接着派工（复用父卡检出）', async () => {
  assert.equal(task(mutexA.id).phase, 'done-no-commit', '父分支头没动就是 done-no-commit')
  assert.equal(domain.unitLeaseOf(parent2.id) || null, null, '租约要随验收释放')
  const again = await dispatcher.dispatch(task(mutexB.id))
  assert.equal(again.ok, true, JSON.stringify(again))
  // 派工成功不一定要改 phase（清理 waiting-* 是别处的活，C-11 不碰），
  // 所以这里只钉「这一拍真的开工了」：不再是等待返回，且拿到了 run。
  assert.equal(again.waiting, undefined, '这一拍不该再判成等待')
  assert.equal(task(mutexB.id).activeRunId, again.runId)
  // A 已经验收离场，B 这一拍**没有在跑的兄弟** → 规则 3：不并行，复用父卡检出。
  // 这是刻意的：没人跟它抢的时候去并行，只是多装一次依赖、多留一条临时分支。
  const wtB = store.state.worktrees[mutexB.id]
  assert.ok(wtB)
  assert.equal(wtB.shared, true)
  assert.equal(wtB.path, parentDir2, '接着派工要复用父卡检出，不是新建一个')
  assert.equal(wtB.branch, 'flow/' + parent2.id)
  assert.equal(await git.branchExists(repo, scratchBranchFor(parent2.id, mutexB.id)), false, '没并行就不建瞬时分枝')
})

// ---- 5. 规则 3：没有兄弟在跑时，一定走 shared（不付并行的钱）----
const parent3 = await domain.createTask(project.id, { title: '父卡（独苗）', acceptance: ['子卡完成'] })
const split3 = await domain.splitTask(parent3.id, {
  reason: '规则 3',
  items: [
    { title: '独苗子卡 P', purpose: '改 p', scope: { paths: ['p.txt'] }, effect: 'p', acceptance: ['p 存在'] },
    { title: '独苗子卡 Q', purpose: '改 q（这一轮不派）', scope: { paths: ['q.txt'] }, effect: 'q', acceptance: ['q 存在'] },
  ],
})
const [loneP, loneQ] = split3.children
const parentDir3 = worktreePathFor(project, task(parent3.id))
await change(loneP.id, { column: 'running', phase: 'executing' })
const runLone = await dispatcher.dispatch(task(loneP.id))

await t('规则 3：只有自己在跑（兄弟仍在 planning）→ 走 shared，不建瞬时分枝', async () => {
  assert.equal(runLone.ok, true, JSON.stringify(runLone))
  assert.equal(task(loneQ.id).column, 'planning', '这张兄弟不参与判（不是在跑）')
  const wtP = store.state.worktrees[loneP.id]
  assert.ok(wtP)
  assert.equal(wtP.shared, true, '没有并行需求就该共用父卡检出')
  assert.equal(wtP.path, parentDir3)
  assert.equal(wtP.branch, 'flow/' + parent3.id)
  assert.notEqual(task(loneP.id).unitMode, 'parallel')
  assert.equal(await git.branchExists(repo, scratchBranchFor(parent3.id, loneP.id)), false, '不需要并行就不该留下瞬时分枝')
})

console.log('')
console.log(pass + ' passed, ' + fails.length + ' failed')
if (fails.length) {
  for (const f of fails) console.log('- ' + f.name + ': ' + String((f.err && f.err.stack) || f.err))
  process.exit(1)
}
