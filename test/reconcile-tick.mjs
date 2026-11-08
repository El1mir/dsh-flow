/**
 * 四时点对账里的两个时点（I-10 / ADR-0006 §2）：启动重活 vs tick 只读。
 *
 * 这张测试真正钉住的是三条**不该发生**的事：
 *   ① tick 不许动仓库（只读）；
 *   ② grace window 内的 orphan-dir 不许被当成孤儿（否则对账会删掉自己刚建的检出）；
 *   ③ 有活跃 run 的检出不许被 unlock（锁是 run 的，不是对账的）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import * as git from '../lib/git.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const NL = String.fromCharCode(10)

const root = mkdtempSync(join(tmpdir(), 'flow-rc10-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'base' + NL)
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession(agent, project, opts = {}) {
    const rec = domain.latestSession(agent.id)
    if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId, created: false }
    const sessionId = 'ses-' + agent.id
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: (project && project.workspacePath) || null }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async workerGoal() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'rc10' })
const wtRoot = join(root, '.flow-worktrees', 'repo')

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

// ---------- ① tick 只读：什么都不许动 ----------

const orphan = join(wtRoot, 'T-ORPHAN')
mkdirSync(orphan, { recursive: true })
writeFileSync(join(orphan, 'leftover.txt'), 'x' + NL)
// 变老：把目录 ctime 往前拨不动，所以用"把 now 往后拨 11 分钟"来模拟（grace 判据是 now - birth）
const later = Date.now() + 11 * 60 * 1000
const dry = await dispatcher.reconcileWorktrees({ dryRun: true, now: later })

await t('tick（dryRun）把 orphan-dir 报成 would-archive-dir', () => {
  const hit = dry.actions.find((a) => a.kind === 'would-archive-dir' && a.path === orphan)
  assert.ok(hit, JSON.stringify(dry.actions))
})

await t('tick（dryRun）**没有**动仓库：目录还在', () => {
  assert.equal(existsSync(orphan), true)
})

// ---------- ② grace window ----------

const young = await dispatcher.reconcileWorktrees({ dryRun: true, now: Date.now() })
await t('刚建出来的 orphan-dir 落在 grace window 里，只被跳过、不算孤儿', () => {
  const skippedHit = young.skipped.find((s) => s.kind === 'orphan-dir' && s.path === orphan && s.why === 'grace')
  const acted = young.actions.find((a) => a.path === orphan)
  assert.ok(skippedHit, JSON.stringify(young.skipped))
  assert.equal(acted, undefined, 'grace 内不许有动作')
})

// ---------- ③ 启动重活：ghost 清理 ----------

const tk = await domain.createTask(project.id, { title: '幽灵登记要能被收口', acceptance: ['x'] })
const gone = join(wtRoot, tk.id)
// 真正的幽灵形态：**git 还认这个检出，但目录已经被删了**（Windows 删除失败 / 手工 rm 都这样）。
// 只造登记不造 git 条目的话那是 stale-record，与幽灵是两件事 —— 测错对象就测不出要修的东西。
sh(repo, ['worktree', 'add', '-q', '-b', 'flow/' + tk.id, gone, 'main'])
await domain.recordWorktree(tk.id, { path: gone, branch: 'flow/' + tk.id, baseSha: null })
const { rmSync } = await import('node:fs')
rmSync(gone, { recursive: true, force: true })
assert.equal(existsSync(gone), false, '这里要的就是"git 有、目录无"的幽灵')

const heavy = await dispatcher.reconcileWorktrees({ dryRun: false, now: later })

await t('启动重活：ghost 记录被收口（drop）', () => {
  assert.ok(heavy.actions.some((a) => a.kind === 'drop-record' && a.taskId === tk.id && a.reason === 'ghost'), JSON.stringify(heavy.actions))
  assert.equal(domain.worktreeOf(tk.id), null)
})

await t('启动重活：卡上留了人话评论（不是静默清理）', () => {
  const cs = (store.state.task_comments || []).filter((c) => c.taskId === tk.id)
  assert.ok(cs.some((c) => /对账/.test(String(c.content))), JSON.stringify(cs.map((c) => c.content)))
})

await t('启动重活：非空 orphan-dir 被归档而不是删掉', () => {
  const hit = heavy.actions.find((a) => a.path === orphan)
  assert.ok(hit, JSON.stringify(heavy.actions))
  assert.equal(hit.kind, 'archive-dir')
  assert.ok(hit.dest && existsSync(hit.dest), '归档目录要在')
  assert.equal(existsSync(orphan), false)
})

// ---------- ④ 有活跃 run 的锁不许被解 ----------

const slot = await domain.createTask(project.id, { title: '有 run 的锁不能被对账解掉', acceptance: ['x'] })
const liveBranch = 'flow/' + slot.id
const live = join(wtRoot, slot.id)
sh(repo, ['worktree', 'add', '-q', '-b', liveBranch, live, 'main'])
await git.lockWorktree({ repo, dir: live, reason: 'flow ' + slot.id + ' running' })
// 让 activeRunId 指到一个真 run 上：直接造一条 run 记录
await store.tx((s) => {
  s.tasks[slot.id].activeRunId = 'run_fake_1'
  s.runs = s.runs || {}
  s.runs.run_fake_1 = { id: 'run_fake_1', taskId: slot.id, agentId: 'ag_x', status: 'running', startedAt: new Date().toISOString() }
})

const lockedNow = await git.listWorktrees(repo)
await t('（预置）锁确实加上了', () => {
  const e = lockedNow.find((w) => git.samePath(w.path, live))
  assert.ok(e && e.locked, JSON.stringify(lockedNow))
})

await dispatcher.reconcileWorktrees({ dryRun: false, now: later })
const after = await git.listWorktrees(repo)
await t('有活跃 run：锁**不被**解掉', () => {
  const e = after.find((w) => git.samePath(w.path, live))
  assert.ok(e && e.locked, '锁被解了 —— 那会让 gc 在 run 期间删掉检出')
})

// 清掉活跃 run 之后，同一次对账就该把锁解掉
await store.tx((s) => { s.tasks[slot.id].activeRunId = null })
const healed = await dispatcher.reconcileWorktrees({ dryRun: false, now: later })
const after2 = await git.listWorktrees(repo)
await t('没有活跃 run：残留锁由对账解开（并记进 actions）', () => {
  assert.ok(healed.actions.some((a) => a.kind === 'unlock' && a.taskId === slot.id), JSON.stringify(healed.actions))
  const e = after2.find((w) => git.samePath(w.path, live))
  assert.ok(!e || !e.locked, '锁应该被解开')
})

// ---------- ④b 全局登记表不许串项目（真机踩到的数据丢失级 bug）----------

// store.state.worktrees 是**所有项目共一个对象**，而 reconcile 只对账一个项目。
// 不过滤的后果在真机复现过：跑 ework 的对账时，BiliNote 的 T-048 被报成 orphan-dir；
// 而 orphan-dir 在启动重活里过了 grace 会被 **rename 进隔离区** ——
// 也就是「对账 A 项目时把 B 项目正在用的检出搬走」。
const other = await domain.ensureProject({ workspacePath: join(root, 'other-repo'), name: 'other' })
mkdirSync(join(root, 'other-repo'), { recursive: true })
// 造一个属于**另一个项目**的登记：路径在它的根下，不在本项目根下
const otherPath = join(root, '.flow-worktrees', 'other-repo', 'T-OTHER')
mkdirSync(otherPath, { recursive: true })
writeFileSync(join(otherPath, 'live.txt'), 'x' + NL)
await store.tx((s) => {
  s.worktrees = s.worktrees || {}
  s.worktrees['T-OTHER'] = { taskId: 'T-OTHER', projectId: other.id, path: otherPath, branch: 'flow/T-OTHER', baseSha: null, state: 'ready', sharedDirs: [], createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString() }
})
const cross = await dispatcher.reconcileWorktrees({ dryRun: false, now: later, projectId: project.id })
await t('别的项目的登记不会被本项目对账成 orphan-dir，更不会被归档', () => {
  const touch = cross.actions.find((a) => String(a.path || '').indexOf('T-OTHER') >= 0)
  assert.equal(touch, undefined, '别的项目的检出被动了：' + JSON.stringify(touch))
  assert.equal(existsSync(otherPath), true, '别的项目正在用的检出被搬走了')
  assert.equal(existsSync(join(otherPath, 'live.txt')), true)
})

await t('按项目 id 过滤：别的项目的记录不进本项目的对账表', () => {
  // 本项目根下**没有**这个目录，若登记表串了项目，它会以 stale-record / orphan-dir 出现在 actions 里
  const leaked = cross.actions.find((a) => a.taskId === 'T-OTHER')
  assert.equal(leaked, undefined, 'B 项目的 taskId 出现在 A 项目的对账结果里')
})

// ---------- ⑤ config 可以关掉 ----------

await domain.updateProjectConfig(project.id, { worktreeReconcile: false }, { role: 'human' })
const off = await dispatcher.reconcileWorktrees({ dryRun: false, now: later })
await t('worktreeReconcile=false 时整个对账跳过该项目', () => {
  assert.ok(off.skipped.some((s) => s.projectId === project.id && s.why === 'config'), JSON.stringify(off.skipped))
})

console.log('')
if (fails.length) { console.log(fails.length + ' 项失败'); process.exit(1) }
console.log('reconcile tick ok (' + pass + ' checks)')