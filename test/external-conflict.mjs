/**
 * rf-03（用户口径）：外部 PR 的冲突也要按**正常 PR 流程**处理 ——
 * 没冲突就自动合并，有冲突就把卡回派给工人解冲突，解完再自动合并。
 *
 * 钉住四条：
 *   ① 冲突时不把卡停在原地等人，而是 review_conflict → running；
 *   ② 卡上落下 resolver + baseRef，工人分支从 external/pr-<n> 拉（不是从 base）；
 *   ③ 工人那条分支必须**仍然包含**外部 PR 的提交，否则重新按原始 PR 头合；
 *   ④ 解完冲突后同一条合并路径能自动合进 base，并清掉 resolver 标记。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store, isDelivered } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-extconflict-'))

// ---- 远程：bare + 一条会冲突的 PR 分支 ----
const origin = join(root, 'origin.git')
sh(root, ['init', '-q', '--bare', 'origin.git'])
const seed = join(root, 'seed')
sh(root, ['clone', '-q', origin, 'seed'])
sh(seed, ['config', 'user.email', 'pr@local'])
sh(seed, ['config', 'user.name', 'pr'])
sh(seed, ['checkout', '-q', '-b', 'main'])
writeFileSync(join(seed, 'conflict.txt'), 'base version' + NL)
sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'baseline'])
sh(seed, ['push', '-q', 'origin', 'main'])
sh(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
sh(seed, ['checkout', '-q', '-b', 'feature'])
writeFileSync(join(seed, 'conflict.txt'), 'external version' + NL)
writeFileSync(join(seed, 'from-pr.txt'), 'external only' + NL)
sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'external work'])
const externalSha = sh(seed, ['rev-parse', 'HEAD']).trim()
sh(seed, ['push', '-q', 'origin', 'feature'])
sh(seed, ['push', '-q', 'origin', 'feature:refs/pull/3/head'])

// ---- 本地工作区：同一条 main 上先走一个**冲突**改动，让外部 PR 与我们打架 ----
const repo = join(root, 'repo')
sh(root, ['clone', '-q', origin, 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'conflict.txt'), 'local version' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'our change'])
sh(repo, ['push', '-q', 'origin', 'main'])
const baseBefore = sh(repo, ['rev-parse', 'main']).trim()

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  // dispatch 会走「绑会话 → 投案卷」：只回 ok 不够，domain 要有一条 agent_sessions 记录
  // （setSessionState 的守卫是 agent has no session）。照 smoke 的 fake runtime 写。
  async ensureSession(agent) {
    const rec = domain.latestSession(agent.id)
    if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId, created: false }
    const sessionId = 'ses-' + agent.id
    await domain.bindSession(agent.id, sessionId, { state: 'idle' }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'extconflict' })
await domain.updateProjectConfig(project.id, { mergeStrategy: 'merge', outOfScopeCheck: false, pushRemote: false })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const task = await domain.createExternalPrTask(project.id, { provider: 'github', number: 3, headBranch: 'feature', baseBranch: 'main', headSha: externalSha, title: '外部 PR #3' }, { role: 'system', id: 'sync:external-pr' })
await domain.openPullRequest(task.id, { headSha: externalSha, branch: 'external/pr-3', base: 'main', source: 'external', title: '外部 PR #3' }, { role: 'system', id: 'sync:external-pr' })

const first = await dispatcher.merge(store.state.tasks[task.id], { by: 'human' })
await t('① 外部 PR 与我们打架：判冲突，并把卡回派（不再是原地 blocked 等人）', () => {
  assert.equal(first.ok, false)
  assert.equal(first.conflict, true, JSON.stringify(first))
  const cur = store.state.tasks[task.id]
  assert.equal(cur.column, 'running', '卡要回到执行列（工人才能自停），实际 ' + cur.column)
  assert.equal(cur.phase, 'changes-requested')
  assert.equal(sh(repo, ['rev-parse', 'main']).trim(), baseBefore, 'base 不能被碰')
})

await t('①b 冲突回派时清掉旧审核结论（否则卡会焊死在合并列）', () => {
  const cur = store.state.tasks[task.id]
  assert.equal((cur.mergeRequest && cur.mergeRequest.reviewVerdict) || null, null)
})
await t('② 卡上落下 resolver 与 baseRef，工人分支从 external/pr-3 拉出来', () => {
  const cur = store.state.tasks[task.id]
  assert.equal(cur.external.resolver, true)
  assert.equal(cur.external.baseRef, 'external/pr-3')
  const wt = domain.worktreeOf(task.id)
  assert.ok(wt && wt.path, '应该有检出，实际 ' + JSON.stringify(wt))
  assert.equal(wt.branch, 'flow/' + task.id)
  const parent = sh(wt.path, ['rev-parse', 'HEAD']).trim()
  assert.equal(parent, externalSha, '检出起点必须是外部 PR 的提交')
  const files = readFileSync(join(wt.path, 'from-pr.txt'), 'utf8')
  assert.match(files, /external only/, '外部 PR 的内容必须在检出里（否则等于重新实现一遍）')
})

await t('③ 冲突解决包写的指令是 merge base 而不是 rebase', () => {
  const ctx = (store.state.injections || []).filter((x) => x.taskId === task.id).map((x) => x.content || '').join(NL)
  assert.match(ctx, /git merge/, '包内容：' + ctx.slice(0, 200))
  assert.match(ctx, /不要 rebase/)
})

// ---- 模拟工人：在检出里把 base 合进来、解掉冲突、提交 ----
const wt = domain.worktreeOf(task.id)
try { sh(wt.path, ['merge', 'main']) } catch (err) { /* 预期冲突 */ }
writeFileSync(join(wt.path, 'conflict.txt'), 'merged: both sides' + NL)
sh(wt.path, ['add', '-A'])
sh(wt.path, ['commit', '-qm', 'resolve conflict with main'])

const resolvedSha = sh(wt.path, ['rev-parse', 'HEAD']).trim()
await t('④ 工人分支仍然包含外部 PR 的提交（解冲突不能把别人的改动丢掉）', () => {
  const anc = execFileSync('git', ['merge-base', '--is-ancestor', externalSha, 'flow/' + task.id], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).length >= 0
  assert.ok(anc, 'externalSha 应该是 flow/' + task.id + ' 的祖先')
})

// ---- 工人自停 → 验收 → 重新进合并列 ----
const run = store.state.runs ? Object.values(store.state.runs).find((r) => r.taskId === task.id && r.status === 'running') : null
// endRun 的第一个参数是 **taskId**，runId 走 options（lib/domain.js:2212）。写错会静默忽略，
// 卡上 activeRunId 一直挂着 → stop 被拒、accept 也进不去（本轮踩过）。
if (run) await domain.endRun(task.id, 'completed', { runId: run.id, stopReason: '解冲突完成' }).catch((e) => console.log('    endRun: ' + e.message))
// stop 的 payload 必须是 { stopReport: {...} }（core.js:389 的守卫读 task.stopReport.summary）
const stopped = await domain.move(task.id, 'stop', { role: 'worker', id: 'worker:test' }, { stopReport: { summary: '解冲突完成：conflict.txt 取双方内容', tests: '手工确认合并结果（夹具）', acceptanceStatus: [{ index: 0, status: 'pass' }] } }).catch((e) => ({ error: e.message }))
if (stopped && stopped.error) console.log('    stop 被拒: ' + stopped.error)
const accepted = await domain.move(task.id, 'accept', { role: 'human', id: 'human:test' }, {}).catch((e) => ({ error: e.message }))
if (accepted && accepted.error) console.log('    accept 被拒: ' + accepted.error)

// 冲突回派时上一轮的审核结论已经被清掉（clearReviewVerdict）—— 它绑的是旧 head。
// 这里模拟调度按判据重审一次，然后才是自动合并那一步。
const rev = await domain.review(task.id, 'approved', { summary: '冲突已解（夹具）' }, { role: 'dispatcher', id: 'system' }).catch((e) => ({ error: e.message }))
if (rev && rev.error) console.log('    review 被拒: ' + rev.error)
const second = await dispatcher.merge(store.state.tasks[task.id], { by: 'human' })
await t('⑤ 解完冲突后同一条合并路径自动合进 base（合的是工人那条分支）', () => {
  assert.equal(second.ok, true, JSON.stringify(second))
  const now = sh(repo, ['rev-parse', 'main']).trim()
  assert.notEqual(now, baseBefore, 'base 必须前进')
  const cur = store.state.tasks[task.id]
  assert.equal(cur.column, 'done')
  assert.equal(cur.phase, 'merged')
  assert.equal(isDelivered(cur), true)
})

await t('⑥ 合并后 resolver 标记被清掉（不留成下一轮的「解冲突」）', () => {
  const cur = store.state.tasks[task.id]
  assert.equal(cur.external.resolver, false)
  assert.equal(cur.external.baseRef, null)
})

await t('⑦ 合并结果里两边的改动都在', () => {
  const text = sh(repo, ['show', 'main:conflict.txt'])
  assert.match(text, /merged: both sides/)
  const fromPr = sh(repo, ['show', 'main:from-pr.txt'])
  assert.match(fromPr, /external only/, '外部 PR 新增的文件必须进 base')
})

if (fails.length) {
  console.log('FAIL external-conflict ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err).split(NL).slice(0, 3).join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS external-conflict ' + pass + '/' + pass)
}