/**
 * 接力包（v0.016 / ticket 03）：一轮停下来之后，下一轮不该从零开始。
 *
 * 钉住四件事：首轮无【上一轮停在哪】、二次派工带事实、空字段不占位、
 * 改动文件来自**真实 git diff**（不是模型自述）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher, buildBrief } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-handoff-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'base' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession() { return { ok: true, sessionId: 's' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'hf' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')

const task = await domain.createTask(project.id, { title: '两轮才做得完', acceptance: ['x'] })
await domain.move(task.id, 'claim', { role: 'dispatcher' })
await domain.setPlan(task.id, '1. 先写一半', { role: 'dispatcher' })
await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
const tk = store.state.tasks[task.id]

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

await t('① 首轮案卷里没有【上一轮停在哪】', () => {
  const brief = buildBrief(tk, project, worker, { worktree: join(root, 'wt') })
  assert.ok(brief.indexOf('【上一轮停在哪】') < 0, '首轮不该有这一段')
})

const wt = await dispatcher.ensureWorktree(tk, project)
await t('② 建检出成功（后面要靠它产生真实提交）', () => {
  assert.equal(wt.ok, true, JSON.stringify(wt))
})

const started = await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-h1', trigger: 'system' }, { role: 'system' })
await t('③ startRun 开出 run', () => { assert.ok(started && started.run, JSON.stringify(started)) })

// 工人在检出里真的写了一部分（这是接力包的事实来源）
writeFileSync(join(wt.path, 'half.md'), '第一部分' + NL)
sh(wt.path, ['add', '-A'])
sh(wt.path, ['commit', '-qm', 'docs: 写了一半'])
await domain.setProgress(task.id, { state: 'partial', summary: '写了一半', next: '补第二部分' }, { role: 'worker', id: worker.id })
await domain.move(task.id, 'stop', { role: 'worker', id: worker.id }, { stopReport: { summary: '这一轮写了一半' } })
await dispatcher.afterStop(store.state.tasks[task.id])

await t('④ 停止之后卡上出现接力包，提交与文件来自真实 git', () => {
  const h = store.state.tasks[task.id].handoff
  assert.ok(h, '应当写下接力包')
  assert.equal(h.commits.length, 1, JSON.stringify(h.commits))
  assert.match(h.commits[0].subject, /写了一半/)
  assert.deepEqual(h.changedFiles, ['half.md'])
  assert.equal(h.next, '补第二部分')
})

await t('⑤ 下一轮案卷带上【上一轮停在哪】，含提交与文件', () => {
  const brief = buildBrief(store.state.tasks[task.id], project, worker, { worktree: wt.path })
  assert.ok(brief.indexOf('【上一轮停在哪】') >= 0, '应当有这一段')
  assert.match(brief, /已完成（1 个提交）/)
  assert.match(brief, /half\.md/)
  assert.match(brief, /上一轮留下的下一步：补第二部分/)
})

await t('⑥ 空字段不占位：只有提交的接力包不出现「下一步/没答的问题」', async () => {
  await domain.recordHandoff(task.id, { commits: [{ sha: 'abc12345', subject: 'x' }], changedFiles: [], next: '', open: [], avoidTry: null })
  const brief = buildBrief(store.state.tasks[task.id], project, worker, { worktree: wt.path })
  assert.ok(brief.indexOf('【上一轮停在哪】') >= 0)
  assert.ok(brief.indexOf('上一轮留下的下一步') < 0, '空的 next 不该出现')
  assert.ok(brief.indexOf('还没答的问题') < 0, '空的 open 不该出现')
  assert.ok(brief.indexOf('上一轮失败的做法') < 0, '空的 avoidTry 不该出现')
})

await t('⑦ 调研轮不带接力包（只做调研，不改代码）', async () => {
  const brief = buildBrief(store.state.tasks[task.id], project, worker, { investigate: true, worktree: wt.path })
  assert.ok(brief.indexOf('【上一轮停在哪】') < 0)
})

await t('⑧ 返工理由进接力包（别重复上一轮的做法）', async () => {
  await domain.recordHandoff(task.id, { commits: [], changedFiles: [], next: '', open: [], avoidTry: '上一轮直接改了生成物，被 rolled back' })
  const brief = buildBrief(store.state.tasks[task.id], project, worker, { worktree: wt.path })
  assert.match(brief, /别重复/)
  assert.match(brief, /生成物/)
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); console.log('FAIL handoff ' + fails.length + '/' + (pass + fails.length)); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')