/**
 * v0.005：远程 PR 结束后的本地收口（用户口径）。
 *
 *   - 自动车道（visibility='auto'，不在看板上）：PR 一结束，卡就地结束，不进生命周期管理；
 *   - 人车道：PR 结束后按正常生命周期 —— 合并了照常落 done，被关了开请示等人决定。
 *
 * 这里只钉**收口逻辑本身**（dispatcher.closeoutRemote），不发网络请求：
 * 事实由同步层收集，收口由调度按车道决定，两层各测各的。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store, isDelivered } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-closeout-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
const { writeFileSync } = await import('node:fs')
writeFileSync(join(repo, 'a.txt'), 'a' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])
const headSha = sh(repo, ['rev-parse', 'HEAD']).trim()

const store = new Store(join(root, 'flow.json'))
await store.load()
const notified = []
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession(sessionId, text) { notified.push({ sessionId, text }); return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'closeout' })
await domain.updateProjectConfig(project.id, { pushRemote: false, recordPulls: true })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

let seq = 0
async function mkCard({ visibility = 'board', kind = 'card', number = null, external = false } = {}) {
  seq += 1
  const num = number || seq
  const task = external
    ? await domain.createExternalPrTask(project.id, { provider: 'github', number: num, headBranch: 'feature', baseBranch: 'main', headSha, title: '外部 PR #' + num }, { role: 'system' })
    : await domain.createTask(project.id, { title: '本地卡 ' + seq })
  await store.tx((s) => {
    const x = s.tasks[task.id]
    x.column = 'merging'
    x.phase = 'merge-ready'
    x.mergeState = 'pending'
    x.visibility = visibility
    x.kind = kind
    if (!x.external) x.external = null
    x.mergeRequest = { id: 'mr_' + num, headSha, status: 'ready_for_review', reviewVerdict: null, remote: { number: num } }
    s.merge_requests = s.merge_requests || {}
    s.merge_requests['mr_' + num] = { ...x.mergeRequest }
  })
  return store.state.tasks[task.id]
}

// ---- ① 自动车道 + 远程已合并 ----
const autoMerged = await mkCard({ visibility: 'auto' })
const r1 = await dispatcher.closeoutRemote({ taskId: autoMerged.id, number: 1, merged: true, mergeCommitSha: headSha, source: 'local' })
await t('① 自动车道 + 远程已合并：卡收口为 done/merged', () => {
  assert.equal(r1.ok, true, JSON.stringify(r1))
  const cur = store.state.tasks[autoMerged.id]
  assert.equal(cur.column, 'done')
  assert.equal(cur.phase, 'merged')
  assert.equal(isDelivered(cur), true)
})

await t('①b 幂等：再收一次是 already，不会重放迁移', async () => {
  const again = await dispatcher.closeoutRemote({ taskId: autoMerged.id, number: 1, merged: true, mergeCommitSha: headSha })
  assert.equal(again.already, true)
})

// ---- ② 自动车道 + 远程被关（未合并）----
const autoClosed = await mkCard({ visibility: 'auto' })
const r2 = await dispatcher.closeoutRemote({ taskId: autoClosed.id, number: 2, merged: false, state: 'closed', source: 'local' })
await t('② 自动车道 + 远程被关：卡就地结束（cancelled / remote-ended）', () => {
  assert.equal(r2.ok, true, JSON.stringify(r2))
  const cur = store.state.tasks[autoClosed.id]
  assert.equal(cur.column, 'cancelled')
  assert.equal(cur.phase, 'remote-ended')
})

await t('②b 自动车道被关时不进请示箱（结束就是结束，不打扰人）', () => {
  const asks = (store.state.human_inbox || []).filter((x) => x.taskId === autoClosed.id && x.status !== 'archived')
  assert.equal(asks.length, 0)
})

// ---- ③ 人车道 + 远程已合并 ----
const humanMerged = await mkCard({ visibility: 'board' })
const r3 = await dispatcher.closeoutRemote({ taskId: humanMerged.id, number: 3, merged: true, mergeCommitSha: headSha, source: 'local' })
await t('③ 人车道 + 远程已合并：同样收口为 done/merged', () => {
  assert.equal(r3.ok, true, JSON.stringify(r3))
  const cur = store.state.tasks[humanMerged.id]
  assert.equal(cur.column, 'done')
  assert.equal(cur.phase, 'merged')
})

await t('③b 人车道收口会通知调度员（人能看见发生了什么）', () => {
  const comments = (store.state.task_comments || []).filter((c) => c.taskId === humanMerged.id).map((c) => c.content || '').join(NL)
  assert.match(comments, /已在远程合并/)
})

// ---- ④ 人车道 + 远程被关（未合并）----
const humanClosed = await mkCard({ visibility: 'board' })
const r4 = await dispatcher.closeoutRemote({ taskId: humanClosed.id, number: 4, merged: false, state: 'closed', source: 'local' })
await t('④ 人车道 + 远程被关：卡不动，开请示由人决定', () => {
  assert.equal(r4.needsHuman, true, JSON.stringify(r4))
  const cur = store.state.tasks[humanClosed.id]
  assert.equal(cur.column, 'merging', '卡不能被系统自己结束')
  const asks = (store.state.human_inbox || []).filter((x) => x.taskId === humanClosed.id && x.status !== 'archived')
  assert.equal(asks.length, 1, '应该有一条请示')
})

// ---- ⑤ 外部 PR 卡：远程被关也按同样规则（merged 走收口，closed 走车道差异）----
const ext = await mkCard({ visibility: 'auto', external: true, number: 9 })
const r5 = await dispatcher.closeoutRemote({ taskId: ext.id, number: 9, merged: false, state: 'closed', source: 'external' })
await t('⑤ 外部 PR 卡（自动车道）+ 远程被关：就地结束，并把 external.state 记成 closed', () => {
  assert.equal(r5.ok, true, JSON.stringify(r5))
  const cur = store.state.tasks[ext.id]
  assert.equal(cur.column, 'cancelled')
  assert.equal(cur.external.state, 'closed')
})

if (fails.length) {
  console.log('FAIL remote-closeout ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err).split(NL).slice(0, 3).join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS remote-closeout ' + pass + '/' + pass)
}