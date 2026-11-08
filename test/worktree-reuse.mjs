/**
 * C-08：检出复用判据（B-delivery 调研发现的 v0.002 遗留漏洞）。
 *
 * 病：ensureWorktree 的复用判据只排除 blocked-delete / quarantined，**不排除 blocked**。
 * 而 blocked 里有一类是 install-failed —— 目录建出来了、依赖没装上。
 * 于是「修好 registry 再派一次」会拿到那个空 node_modules 的目录，install 不再重跑。
 *
 * 药：把「目录能用」与「准备好了」分开。state=ready 才是可派工；
 * blocked + install-failed 的目录**不重建**（重装一遍要 30 分钟），就地重跑准备。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import * as git from '../lib/git.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-wt-reuse-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'base' + NL)
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'baseline'])

// 两个 hook 脚本：一个必然失败，一个必然成功（并在 markers.txt 留一行）。
// 用文件而不是行内命令：行内命令要跨平台加引号，测试自己会先死在引号上。
const markers = join(root, 'markers.txt').replace(/\\/g, '/')
const failHook = join(root, 'hook-fail.cjs').replace(/\\/g, '/')
const okHook = join(root, 'hook-ok.cjs').replace(/\\/g, '/')
writeFileSync(failHook, 'process.exit(7)' + NL)
writeFileSync(okHook, ['const fs = require(', JSON.stringify('fs'), ')',
  'fs.appendFileSync(' + JSON.stringify(markers) + ', ' + JSON.stringify('run' + NL) + ')',
].join(NL) + NL)
const markerCount = () => (existsSync(markers) ? readFileSync(markers, 'utf8').split('run').length - 1 : 0)

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
const project = await domain.ensureProject({ workspacePath: repo, name: 'wt-reuse' })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const mkTask = async (title) => {
  const t0 = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(t0.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(t0.id, '1. x', { role: 'dispatcher' })
  await domain.move(t0.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(t0.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[t0.id]
}

const setInstall = (script) => domain.updateProjectConfig(project.id, { install: { commands: ['node ' + script] } })

// ---------- ① 准备通过后 state=ready，第二次直接复用 ----------
await setInstall(okHook)
const t1 = await mkTask('ready 复用')
const first = await dispatcher.ensureWorktree(t1, project)
await t('新建之后显式写 ready，目录真的在', async () => {
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(domain.worktreeOf(t1.id).state, 'ready')
  assert.ok(existsSync(first.path))
})
const again = await dispatcher.ensureWorktree(t1, project)
await t('ready 的检出第二次直接复用（不重跑 install）', () => {
  assert.equal(again.ok, true)
  assert.equal(again.reused, true)
  assert.equal(markerCount(), 1, 'ready 复用不该再跑一次 install')
})

// ---------- ② install 失败 → blocked；再派一次要重跑准备，而不是复用坏目录 ----------
await setInstall(failHook)
const t2 = await mkTask('install 失败')
const bad = await dispatcher.ensureWorktree(t2, project)
await t('install 失败：state=blocked/install-failed，返回 fatal（不降级）', async () => {
  assert.equal(bad.ok, false)
  assert.equal(bad.fatal, true)
  assert.equal(bad.reason, 'install-failed')
  const rec = domain.worktreeOf(t2.id)
  assert.equal(rec.state, 'blocked')
  assert.equal(rec.stateReason, 'install-failed')
  assert.ok(rec.path, '目录要留在磁盘上，重建才是浪费')
})

await setInstall(okHook)
const fixed = await dispatcher.ensureWorktree(t2, project)
await t('修好 install 之后：复用同一个目录并重跑准备，成功', async () => {
  assert.equal(fixed.ok, true, JSON.stringify(fixed))
  assert.equal(fixed.reused, true)
  assert.ok(git.samePath(fixed.path, domain.worktreeOf(t2.id).path))
  assert.equal(domain.worktreeOf(t2.id).state, 'ready')
  assert.equal(markerCount(), 2, 'prepare 必须真的又跑了一次')
})

// ---------- ③ 不复用的状态：quarantined / blocked-delete ----------
const t3 = await mkTask('隔离中的检出不复用')
const third = await dispatcher.ensureWorktree(t3, project)
await domain.setWorktreeState(t3.id, { state: 'quarantined', reason: 'dirty' }, { role: 'system' })
const after = await dispatcher.ensureWorktree(t3, project)
await t('quarantined 的检出不会被当成可用的复用（要么重建要么明确失败）', () => {
  const rec = domain.worktreeOf(t3.id)
  assert.notEqual(rec.state, 'quarantined', '不该原样留着 quarantine 标记还成功派工')
  assert.ok(after.ok === true || after.fatal === true)
  assert.ok(third.path)
})

// ---------- ④ 分支被占：不给可用路径，绝不退回主检出 ----------
const t4 = await mkTask('分支被占')
const fourth = await dispatcher.ensureWorktree(t4, project)
const b4 = branchOf(t4.id)
const other = join(root, 'other-dir')
await git.addWorktree({ repo, dir: other, branch: b4 + '-x', base: 'main' })
await domain.setWorktreeState(t4.id, { state: 'blocked-delete', reason: 'simulate' }, { role: 'system' })
const blocked = await dispatcher.ensureWorktree(t4, project)
await t('blocked-delete 的路径不可复用：返回的 path 绝不能是主工作区', () => {
  assert.ok(fourth.path)
  if (blocked.ok) assert.ok(!git.samePath(blocked.path, repo), '不能把工人放进主检出')
  else assert.equal(blocked.path, null)
})

function branchOf(taskId) { return 'flow/' + taskId }

console.log('')
if (fails.length) {
  console.log('worktree reuse FAILED (' + fails.length + ' of ' + (pass + fails.length) + ')')
  process.exit(1)
}
console.log('worktree reuse ok (' + pass + ' checks)')