/**
 * 派工前意图锁 + 禁止降级主检出（I-07 / ADR-0006 §2）。
 *
 * 这张测试钉住两件事，它们都是线上事故的直接来源：
 *   ① 同一张卡被并发派两次时，**只允许 add 一次**；第二个调用者必须复用它；
 *   ② 建检出失败时**绝不能**把 path 降级成项目工作区 —— 那会把工人放进人的检出里干活。
 * 第二件事比第一件重要：①只是浪费一次 git 调用，②是数据污染。
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

const root = mkdtempSync(join(tmpdir(), 'flow-wt-'))
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
    const wantCwd = opts.cwd || (project && project.workspacePath) || null
    if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId, created: false }
    const sessionId = 'ses-' + agent.id
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: wantCwd }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async workerGoal() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })

const project = await domain.ensureProject({ workspacePath: repo, name: 'wt' })
await domain.ensureAgents(project.id)

const mkTask = async (title) => {
  const t = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(t.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(t.id, '1. x', { role: 'dispatcher' })
  await domain.move(t.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(t.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[t.id]
}

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

// ---------- ① 并发：只 add 一次 ----------

const t1 = await mkTask('并发派工只建一个检出')
const [a, b] = await Promise.all([dispatcher.ensureWorktree(t1, project), dispatcher.ensureWorktree(t1, project)])

await t('并发两次 ensureWorktree：都成功且拿到同一个目录', () => {
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.equal(b.ok, true, JSON.stringify(b))
  // 路径要比"目录等价"而不是字符串：node 手里可能是 8.3 短名（ADMINI~1），git 给长名。
  assert.ok(git.samePath(a.path, b.path), a.path + ' != ' + b.path)
  assert.ok(existsSync(a.path), '目录要真的在')
})

await t('并发两次 ensureWorktree：git 里只多出一条该目录的记录', async () => {
  const list = await git.listWorktrees(repo)
  const hits = list.filter((w) => !w.bare && git.samePath(w.path, a.path))
  assert.equal(hits.length, 1, JSON.stringify(list.map((x) => x.path)))
})

await t('并发两次 ensureWorktree：至少有一个是复用的（不是两次都新建）', () => {
  assert.ok(a.reused === true || b.reused === true, JSON.stringify({ a: a.reused, b: b.reused }))
})

await t('派工结束后意图锁要释放（不能留下 worktree:<taskId> 的幽灵锁）', () => {
  assert.equal(domain.worktreeLeaseOf(t1.id), null)
})

// ---------- ② 分支被别的检出占着 → fatal，不许降级 ----------

const t2 = await mkTask('分支被占用时不许把工人放进主检出')
const branch2 = 'flow/' + t2.id
const squatter = join(root, 'squatter')
sh(repo, ['worktree', 'add', '-q', '-b', branch2, squatter, 'main'])

const r2 = await dispatcher.ensureWorktree(t2, project)

await t('分支被别人占着：返回 fatal 而不是 degraded', () => {
  assert.equal(r2.ok, false)
  assert.equal(r2.fatal, true, JSON.stringify(r2))
  assert.equal(r2.reason, 'branch-busy')
  assert.equal(r2.path, null, '绝不能给出一个可用的 path —— 那等于把工人放进别人的检出')
})

await t('分支被别人占着：卡被 block 并留下人话评论', () => {
  assert.ok(store.state.tasks[t2.id].blocked, '要 block')
  assert.match(String(store.state.tasks[t2.id].blocked.reason), /已被另一个检出占用/)
})

await t('分支被别人占着：登记表里不留下一条假路径', () => {
  const rec = domain.worktreeOf(t2.id)
  assert.ok(!rec || !rec.path, JSON.stringify(rec))
  assert.equal(rec ? rec.state : null, 'blocked')
})

// ---------- ③ dispatch 遇到 fatal 必须停，不许派工 ----------

const d2 = await dispatcher.dispatch(store.state.tasks[t2.id])
await t('dispatch 遇到 fatal：返回 ok:false 且不存在任何 run', () => {
  assert.equal(d2.ok, false)
  assert.equal(d2.fatal, true, JSON.stringify(d2))
  const runs = store.state.runs ? Object.values(store.state.runs).filter((r) => r.taskId === t2.id) : []
  assert.equal(runs.length, 0, '不许开 run')
  assert.equal(store.state.tasks[t2.id].activeRunId, null)
})

await t('dispatch 遇到 fatal：工人会话没有被投递案卷', () => {
  const msgs = (store.state.messages || []).filter((m) => m.taskId === t2.id && m.direction === 'out')
  assert.equal(msgs.length, 0, JSON.stringify(msgs.map((m) => m.kind)))
})

// ---------- ④ 非 git 工作区：degraded，派工照常 ----------

const plain = join(root, 'plain')
mkdirSync(plain, { recursive: true })
const p2 = await domain.ensureProject({ workspacePath: plain, name: 'plain' })
await domain.ensureAgents(p2.id)
const t4 = await domain.createTask(p2.id, { title: '非 git 项目也能派工', acceptance: ['x'] })
await domain.move(t4.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(t4.id, '1. x', { role: 'dispatcher' })
await domain.move(t4.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(t4.id, 'approve', { role: 'human', id: 'me' })

const r4 = await dispatcher.ensureWorktree(store.state.tasks[t4.id], p2)
await t('非 git 工作区：degraded + worktreeState=none（不是 fatal）', () => {
  assert.equal(r4.ok, false)
  assert.equal(r4.degraded, true)
  assert.equal(r4.fatal, undefined)
  assert.equal(r4.state, 'none')
  const rec = domain.worktreeOf(t4.id)
  assert.equal(rec.state, 'none')
  assert.equal(rec.stateReason, 'not-a-repo')
})

await t('非 git 工作区：dispatch 仍然派得出去（degraded 不是错误）', async () => {
  const d4 = await dispatcher.dispatch(store.state.tasks[t4.id])
  assert.equal(d4.ok, true, JSON.stringify(d4))
  assert.equal(d4.degraded, true)
  assert.equal(d4.worktree, plain)
})

// ---------- ⑤ creating 残留不会永久挡卡 ----------

const t5 = await mkTask('creating 残留要能被接管')
await domain.setWorktreeState(t5.id, { state: 'creating', reason: null }, { role: 'system' })
const r5 = await dispatcher.ensureWorktree(store.state.tasks[t5.id], project)
await t('creating 残留（无锁）：下一次派工照样能建出来', () => {
  assert.equal(r5.ok, true, JSON.stringify(r5))
  assert.ok(existsSync(r5.path))
})

console.log('')
if (fails.length) { console.log(fails.length + ' 项失败'); process.exit(1) }
console.log('worktree intent ok (' + pass + ' checks)')