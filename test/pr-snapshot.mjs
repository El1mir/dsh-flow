/**
 * v0.008：PR 快照要带真实的交付事实（files / diff），否则审核员只能判 risk。
 *
 * 线上 T-049：工人自己提交了 4293589（2 文件 +1094），worktree clean；
 * 而 openPr 用 commitAll 的结果去算 diff —— 已提交时 changed:false，快照就成了 files: - / +0/-0。
 * 审核员按「只根据 PR 快照判定」照章办事，判 risk，卡永久阻塞。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-snap-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'a' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'snap' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })
const task = await domain.createTask(project.id, { title: '改一份文档', acceptance: ['x'] })

// 造一个真实检出：branch 从 base 拉出，工人在里面**自己提交**（这是线上真实形态）。
const wtDir = join(root, 'wt')
sh(repo, ['worktree', 'add', '-q', '-b', 'flow/' + task.id, wtDir, 'main'])
writeFileSync(join(wtDir, 'report.md'), 'line1' + NL + 'line2' + NL)
writeFileSync(join(wtDir, 'matrix.md'), 'm' + NL)
sh(wtDir, ['add', '-A']); sh(wtDir, ['commit', '-qm', 'docs: add report'])
await domain.recordWorktree(task.id, { path: wtDir, branch: 'flow/' + task.id })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const res = await dispatcher.openPr(store.state.tasks[task.id])
const mr = () => store.state.tasks[task.id].mergeRequest

await t('① 开 PR 成功，head 是工人的那个提交', () => {
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(mr().headSha, /^[0-9a-f]{40}$/)
})

await t('② 快照里有两个文件（不再靠 commitAll 的 changed）', () => {
  assert.deepEqual(mr().files.slice().sort(), ['matrix.md', 'report.md'])
})

await t('③ 快照里有真实 diff 行数', () => {
  assert.equal(mr().additions, 3)
  assert.equal(mr().deletions, 0)
})

await t('④ 摘要写的是机械事实，不是工人的自述', () => {
  assert.match(mr().summary, /\+3\/-0/)
})

await t('⑤ 审核包能印出文件与行数（审核员终于有事实可看）', () => {
  const r = domain.renderReviewPrompt(project.id, mr())
  assert.match(r.text, /files: .*report\.md/)
  assert.match(r.text, /快照怎么来的/, '审核包要写清快照是实测的')
  assert.match(r.text, /diff: \+3 \/ -0/)
})

await t('⑥ 同一 head 再开一次：把空快照补回来（线上卡自愈的通道）', async () => {
  const prId = mr().id
  await store.tx((s) => {
    const p = s.pull_requests[prId]
    p.files = []; p.additions = 0; p.deletions = 0; p.summary = ''
    s.tasks[task.id].mergeRequest.files = []
    s.tasks[task.id].mergeRequest.additions = 0
  })
  const again = await dispatcher.openPr(store.state.tasks[task.id])
  assert.equal(again.ok, true)
  assert.equal(mr().files.length, 2, JSON.stringify(mr()))
  assert.equal(mr().additions, 3)
})

await t('⑦ 空快照 + head≠base 时审核包自己标出「这是取数问题」', () => {
  const fake = { headSha: 'abc1234def', baseSha: '0000000aaa', files: [], additions: 0, deletions: 0, summary: '' }
  const r = domain.renderReviewPrompt(project.id, fake)
  assert.match(r.text, /取数问题/)
})

await t('⑧ 零改动的卡不会凭空造出文件', async () => {
  const t2 = await domain.createTask(project.id, { title: '空卡', acceptance: ['x'] })
  const d2 = join(root, 'wt2')
  sh(repo, ['worktree', 'add', '-q', '-b', 'flow/' + t2.id, d2, 'main'])
  await domain.recordWorktree(t2.id, { path: d2, branch: 'flow/' + t2.id })
  const r2 = await dispatcher.openPr(store.state.tasks[t2.id])
  assert.equal(r2.ok, true, JSON.stringify(r2))
  assert.equal(store.state.tasks[t2.id].mergeRequest.files.length, 0)
})

if (fails.length) {
  console.log('FAIL pr-snapshot ' + fails.length + '/' + (pass + fails.length))
  process.exitCode = 1
} else {
  console.log('PASS pr-snapshot ' + pass + '/' + pass)
}