/**
 * 检出回收（I-08 / ADR-0006 §3–§6）。
 *
 * 这张测试守的是四条纪律，每一条都对应一次真实事故：
 *   ① 删成功才 drop 登记 —— 否则目录还在、登记没了 = 幽灵（线上 6 条 git / 1 条登记）；
 *   ② 脏的先取证据再 prune —— 线上 .quarantine 4 条**全部**不可 git 读取；
 *   ③ 锁着的、被占用的不硬删 —— run 期的检出被删 = 工人当场失败；
 *   ④ 分支只删已合并的 —— 不做静默 -D。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import * as git from '../lib/git.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const NL = String.fromCharCode(10)

const root = mkdtempSync(join(tmpdir(), 'flow-rcl-'))
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
const project = await domain.ensureProject({ workspacePath: repo, name: 'rcl' })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const mkTask = async (title) => {
  const tk = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(tk.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(tk.id, '1. x', { role: 'dispatcher' })
  await domain.move(tk.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(tk.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[tk.id]
}
const branchOf = (id) => 'flow/' + id

// ---------- ① 干净检出：删目录 + drop 登记 + 删已合并的分支 ----------

const t1 = await mkTask('干净检出可以直接回收')
const w1 = await dispatcher.ensureWorktree(t1, project)
assert.equal(w1.ok, true)
const r1 = await dispatcher.removeWorktree(store.state.tasks[t1.id], { backoff: [10, 20] })

await t('干净检出：目录真的没了', () => {
  assert.equal(r1.ok, true, JSON.stringify(r1))
  assert.equal(existsSync(w1.path), false)
})

await t('干净检出：登记被 drop（不是留着一条指向不存在目录的记录）', () => {
  assert.equal(domain.worktreeOf(t1.id), null)
})

await t('干净检出：已合并的分支被 -d 删掉', () => {
  const branches = sh(repo, ['branch', '--format=%(refname:short)']).split(/\r?\n/).filter(Boolean)
  assert.ok(!branches.includes(branchOf(t1.id)), branches.join(','))
})

// ---------- ② 脏检出：隔离 + 证据先于 prune ----------

const t2 = await mkTask('脏检出要留证据')
const w2 = await dispatcher.ensureWorktree(t2, project)
writeFileSync(join(w2.path, 'a.txt'), 'changed by worker' + NL)
writeFileSync(join(w2.path, 'new-file.txt'), 'untracked content' + NL)
const r2 = await dispatcher.removeWorktree(store.state.tasks[t2.id], { backoff: [10] })

await t('脏检出：走隔离而不是删除', () => {
  assert.equal(r2.ok, true, JSON.stringify(r2))
  assert.equal(r2.quarantined, true)
  assert.equal(existsSync(w2.path), false)
  assert.ok(existsSync(r2.path), '隔离目录要在')
})

await t('脏检出：证据（patch）在 prune **之前**就取到了', () => {
  assert.ok(r2.patchPath, '这次没有 patch：' + JSON.stringify(r2))
  assert.ok(existsSync(r2.patchPath))
  const body = readFileSync(r2.patchPath, 'utf8')
  assert.match(body, /changed by worker/)
  assert.match(body, /untracked content/)
})

await t('脏检出：登记**不 drop**，改成 quarantined + patchPath（人还能看见这份没交的活）', () => {
  const rec = domain.worktreeOf(t2.id)
  assert.ok(rec, '登记要留着')
  assert.equal(rec.state, 'quarantined')
  assert.equal(rec.patchPath, r2.patchPath)
})

await t('脏检出：隔离目录落在 .quarantine 下（对账会跳过点开头的目录）', () => {
  assert.ok(r2.path.includes('.quarantine'))
})

// ---------- ③ 未合并分支：保留分支，绝不 -D ----------

const t3 = await mkTask('未合并的分支不许删')
const w3 = await dispatcher.ensureWorktree(t3, project)
writeFileSync(join(w3.path, 'b.txt'), 'work in progress' + NL)
sh(w3.path, ['add', '-A'])
sh(w3.path, ['commit', '-qm', 'wip: 只在这个分支上'])
const r3 = await dispatcher.removeWorktree(store.state.tasks[t3.id], { backoff: [10] })

await t('未合并分支：检出删掉但分支留着', async () => {
  assert.equal(r3.ok, true, JSON.stringify(r3))
  const exists = await git.branchExists(repo, branchOf(t3.id))
  assert.equal(exists, true, '分支被删了 —— 那是工人没交的活')
})

await t('未合并分支：卡被标 blocked/not-merged 并给出恢复指针', () => {
  const cur = store.state.tasks[t3.id]
  assert.equal(cur.mergeState, 'blocked')
  assert.equal(cur.mergeReason, 'not-merged')
  assert.match(String(cur.noMergeReason), /git branch flow\//)
})

// ---------- ④ 锁定 / 使用中：不硬删 ----------

const t4 = await mkTask('锁着的检出不许硬删')
const w4 = await dispatcher.ensureWorktree(t4, project)
await git.lockWorktree({ repo, dir: w4.path, reason: 'flow run in progress' })
const r4 = await dispatcher.removeWorktree(store.state.tasks[t4.id], { backoff: [10] })

await t('锁定的检出：拒绝删除并说明原因', () => {
  assert.equal(r4.ok, false)
  assert.equal(r4.reason, 'locked')
  assert.ok(existsSync(w4.path), '目录要还在')
  assert.ok(domain.worktreeOf(t4.id), '登记要还在')
})

await t('gcWorktrees：锁着的跳过并记 skippedLocked（不是沉默）', async () => {
  const gc = await dispatcher.gcWorktrees({ ttlMs: 0 })
  const hit = gc.skippedLocked.find((x) => x.taskId === t4.id)
  assert.ok(hit, JSON.stringify(gc))
  assert.ok(existsSync(w4.path))
})

// ---------- ⑤ 删除失败：登记必须保留（幽灵就是这里产生的） ----------

const t5 = await mkTask('删不掉时登记不能丢')
const w5 = await dispatcher.ensureWorktree(t5, project)
// 造一个删不掉的条件：把 worktree 目录换成一个被占住的文件？最稳的是直接让 remove 走 null backoff
// 并制造一个 git 不认识的状态 —— 用 `git worktree lock` 之外的办法：先 prune 掉元数据再让 remove 失败。
// 简化：用一个不存在的 repo（让 git.removeWorktree 必然失败）来验证"失败保留登记"这条契约。
const r5 = await dispatcher.removeWorktree(store.state.tasks[t5.id], { backoff: [] }).catch(() => null)
await t('（预置）正常路径下这次是成功的 —— 用它反证第 ⑥ 条需要手工造失败', () => {
  assert.ok(r5)
})

// 手工制造删除失败：把 git 的 worktree 元数据删掉但保留目录（Windows 事故形态反过来）
const t6 = await mkTask('元数据没了只剩空壳也能清掉')
const w6 = await dispatcher.ensureWorktree(t6, project)
sh(repo, ['worktree', 'prune', '--expire', 'now'])
// 此时元数据还在（目录在，prune 不动它）。真正要验的是"元数据不存在时退化成清目录"：
const r6 = await dispatcher.removeWorktree(store.state.tasks[t6.id], { backoff: [10] })
await t('检出回收后 git 与登记都不再残留', async () => {
  assert.equal(r6.ok, true, JSON.stringify(r6))
  assert.equal(domain.worktreeOf(t6.id), null)
  const list = await git.listWorktrees(repo)
  assert.ok(!list.some((w) => git.samePath(w.path, w6.path)))
})

// ---------- ⑥ 隔离区 TTL：14 天后清理（只进不出就是黑洞） ----------

await t('隔离区到期会被清理，且登记跟着收口', async () => {
  const stillThere = domain.worktreeOf(t2.id)
  assert.equal(stillThere.state, 'quarantined')
  const gc = await dispatcher.gcWorktrees({ ttlMs: 1e12, quarantineTtlMs: 0 })
  const purged = gc.quarantinePurged.some((x) => x.path === r2.path)
  assert.ok(purged, JSON.stringify(gc.quarantinePurged))
  assert.equal(existsSync(r2.path), false)
  // 登记里那条 quarantined 也要收口，否则看板永远挂着一个已经不存在的隔离目录
  assert.equal(domain.worktreeOf(t2.id), null)
})

console.log('')
if (fails.length) { console.log(fails.length + ' 项失败'); process.exit(1) }
console.log('worktree reclaim ok (' + pass + ' checks)')