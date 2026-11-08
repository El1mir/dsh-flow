/**
 * C-01：合并入口的 mergeState 守卫 + needs-rebase 语义修正 + PR 闸门拆分。
 *
 * 这张测试钉住四件事（都是"代码看起来做了、实际没做"的入口）：
 *   ① merge() / mergeLocked() 的入口守卫，**在动 git 之前**：
 *      none 一律拒；blocked 按原因二分 —— 契约类（head-mismatch / not-merged）拒，
 *      环境类（out-of-scope-dirty 这类，环境修好之后应当能重试）放行；
 *      undefined（schema 12 之前的老卡）与 ready/pending 放行，保持向后兼容；
 *   ② needs-rebase 现在只做「回派」：回 running + mergeState=pending，
 *      不再同时 setMergeState(blocked)（那是缺陷 2：回派与阻断互斥）；
 *      第 4 次（attempts>3）直接 blockMerge，不回派；
 *   ③ dispatch() 对 column=merging 的卡返回 skipped:'merging'（缺陷 2 的另一半：
 *      没有列守卫时工人在合并列被叫起来干活，stop 必被状态机拒）；
 *   ④ openPr 的远程 PR 闸门是 recordPulls，不再是 recordIssues（缺陷 3：一个字段管两件事）。
 *
 * 为什么①的"没调用 git"用 rebaseAttempts 不变当证据：rebaseAttempts 只在 mergeLocked
 * 走到 git 的 needs-rebase 分支才 ++；它没变就说明连 mergeLocked 都没进。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const dir = mkdtempSync(join(tmpdir(), 'flow-guards-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()

const rt = {
  calls: [],
  async ensureSession(agent, project, opts = {}) {
    const rec = domain.latestSession(agent.id)
    if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId, created: false }
    const sessionId = 'ses-' + agent.id
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: opts.cwd || null }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession(sessionId, text) { this.calls.push({ sessionId, text }); return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
  async cancelSession() { return { ok: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) {
    fails.push({ name, err })
    console.log('  ✗ ' + name)
    console.log('    ' + String((err && err.message) || err).split(NL)[0])
  }
}

/** 一个新仓库：有基线提交、main 检出、git 身份齐（不然 commitAll 会失败）。 */
function mkRepo(name) {
  const repo = join(dir, name)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] })
  sh(repo, ['config', 'user.email', 'flow@test'])
  sh(repo, ['config', 'user.name', 'flow'])
  writeFileSync(join(repo, 'README.md'), '# demo' + NL)
  sh(repo, ['add', '-A'])
  sh(repo, ['commit', '-qm', 'baseline'])
  return repo
}

const project = await domain.ensureProject({ workspacePath: mkRepo('repo-guard'), name: 'guards' })
// 合并走 mergeBranch（不建集成检出），needs-rebase 只由 rebase + ff-only 之外的路径产生，
// 这里反过来：留在集成检出里（默认），由 mergeInto 的 rebase 分支给出 needs-rebase。
await store.tx((s) => {
  s.projects[project.id].config = { ...s.projects[project.id].config, baseBranch: 'main', mergeStrategy: 'rebase' }
})

const mk = async (title) => (await domain.createTask(project.id, { title, acceptance: ['x'] })).id

// 把卡摆到「合并中」列上（绕过状态机：本测试要验的是合并入口，不是迁移本身）。
const parkInMerging = async (id, patch = {}) => {
  await store.tx((s) => {
    Object.assign(s.tasks[id], { column: 'merging', phase: 'review-pending', ...patch })
  })
}

// ---------- ① merge() 的 mergeState 守卫 ----------

await t('mergeState=blocked + 契约类原因（head-mismatch）→ 拒绝，且没动 git', async () => {
  const id = await mk('契约对不上不该重试')
  await domain.setMergeState(id, { state: 'blocked', reason: 'head-mismatch', humanReason: '验收绑的 head 与 PR 快照不一致' }, { role: 'system' })
  await parkInMerging(id)
  const before = store.state.tasks[id].rebaseAttempts
  const res = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
  assert.equal(res.ok, false)
  assert.equal(res.blocked, true)
  assert.equal(res.reason, 'head-mismatch')
  assert.match(res.message, /mergeState=blocked/)
  assert.equal(store.state.tasks[id].rebaseAttempts, before, '没进 git：needs-rebase 的计数不该动')
  assert.equal(store.state.tasks[id].mergeIntent || null, null, '连 mergeIntent 都不该留（那是在动 git 之前写的）')
  assert.equal(store.state.tasks[id].column, 'merging', '守卫生效时卡不该动')
})

await t('mergeState=blocked + 契约类原因（not-merged）→ 同样拒绝', async () => {
  const id = await mk('分支没合进去不该重试')
  await domain.setMergeState(id, { state: 'blocked', reason: 'not-merged', humanReason: '分支还没合进 main' }, { role: 'system' })
  await parkInMerging(id)
  const res = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
  assert.equal(res.ok, false)
  assert.equal(res.blocked, true)
  assert.match(res.message, /mergeState=blocked/)
})

await t('merge() 对 mergeState=none 的卡同样拒绝（"本来就不用合"不是"等着合"）', async () => {
  const id = await mk('none 卡不该被合并')
  await domain.setMergeState(id, { state: 'none', reason: 'no-code-change', humanReason: '这张卡的交付物不是代码' }, { role: 'system' })
  await parkInMerging(id)
  const res = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
  assert.equal(res.ok, false)
  assert.equal(res.blocked, true)
  assert.equal(res.reason, 'no-code-change')
  assert.equal(store.state.tasks[id].mergeIntent || null, null)
})

/** 把一张卡摆到「合并中」，分支 flow/<id> 领先 base 一个提交（所以 rebase 策略能 ff 成功）。 */
const mkAhead = async (title) => {
  const repo = project.workspacePath
  const id = await mk(title)
  const branch = 'flow/' + id
  sh(repo, ['checkout', '-q', '-b', branch])
  writeFileSync(join(repo, id + '.txt'), 'worker' + NL)
  sh(repo, ['add', '-A'])
  sh(repo, ['commit', '-qm', 'worker 的改动'])
  const head = sh(repo, ['rev-parse', 'HEAD']).trim()
  sh(repo, ['checkout', '-q', 'main'])
  await store.tx((s) => {
    Object.assign(s.tasks[id], {
      column: 'merging', phase: 'review-pending', mergeState: 'ready', mergeReason: null, noMerge: false,
      scope: { paths: ['README.md'], symbols: [] },
      mergeRequest: { id: 'pr_' + id, headSha: head, baseSha: head, branch, status: 'open', reviewVerdict: null },
    })
    s.seq.pr += 1
    s.pull_requests['pr_' + id] = { id: 'pr_' + id, taskId: id, projectId: project.id, headSha: head, baseSha: head, branch, status: 'open', conflictFiles: [], attempts: 0 }
  })
  return { id, head }
}

await t('mergeState=blocked + 环境类原因（out-of-scope-dirty）→ 放行；把环境修好之后同一张卡合得上', async () => {
  const { id } = await mkAhead('脏文件清掉之后应该能合')
  // 第一次：主检出里有落在阅读范围内的未提交改动 → 环境类 blocked。
  writeFileSync(join(project.workspacePath, 'README.md'), '# demo' + NL + NL + 'human 还没提交的改动' + NL)
  const first = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
  assert.equal(first.ok, false)
  assert.equal(first.outOfScope, true)
  assert.equal(store.state.tasks[id].mergeState, 'blocked')
  assert.equal(store.state.tasks[id].mergeReason, 'out-of-scope-dirty')
  // 人把环境修好（提交 / 暂存 / 像这里一样丢弃），**再合一次必须成功**：这是唯一的恢复路径。
  sh(project.workspacePath, ['checkout', '-q', '--', 'README.md'])
  const second = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
  assert.equal(second.ok, true, '环境修好后的重试不该被守卫拦下：' + JSON.stringify(second))
  assert.equal(store.state.tasks[id].column, 'done', '真合并完成（markMerged + review_approve → done）')
  assert.equal(store.state.tasks[id].mergeState, 'ready', '合并成功后 mergeState 回到 ready（不是还挂着 blocked）')
})

await t('merge() 对没有 mergeState 的老卡（schema 12 之前）放行，走到后面的检查', async () => {
  const id = await mk('老卡没有 mergeState')
  await parkInMerging(id)
  assert.equal(store.state.tasks[id].mergeState, undefined)
  const res = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
  assert.equal(res.ok, false, '没有 PR 记录本来就合不了')
  assert.match(res.message, /PR 记录/, '必须是被 PR 检查拦下，而不是被 mergeState 守卫拦下：' + res.message)
})

await t('mergeLocked() 对契约类 blocked 卡同样拒绝（对内入口不许绕开守卫）', async () => {
  const id = await mk('mergeLocked 也不许绕')
  await domain.setMergeState(id, { state: 'blocked', reason: 'head-mismatch', humanReason: '验收与 PR 快照不一致' }, { role: 'system' })
  await parkInMerging(id)
  const res = await dispatcher.mergeLocked(store.state.tasks[id], {})
  assert.equal(res.ok, false)
  assert.equal(res.blocked, true)
  assert.match(res.message, /mergeState=blocked/)
  assert.equal(store.state.tasks[id].mergeIntent || null, null)
})

await t('blocked 卡有一条回到 ready 的路（否则守卫会把卡焊死）', async () => {
  const id = await mk('修好原因后放行')
  await domain.setMergeState(id, { state: 'blocked', reason: 'base-missing', humanReason: '主检出的脏文件已经清掉' }, { role: 'system' })
  assert.equal(store.state.tasks[id].mergeState, 'blocked')
  // 界面那条路是 http.js 的 task.noMerge { noMerge:false } → setNoMerge(false) → 推断成 ready。
  await domain.setNoMerge(id, false, '原因已修掉，重新放行合并', { role: 'human', id: 'web' })
  assert.equal(store.state.tasks[id].mergeState, 'ready')
  assert.equal(store.state.tasks[id].noMerge, false)
})

// ---------- ② dispatch() 的合并列守卫 ----------

await t('dispatch() 对 column=merging 的卡返回 skipped:merging', async () => {
  const id = await mk('合并列不派工')
  await domain.setMergeState(id, { state: 'pending', reason: null }, { role: 'system' })
  await parkInMerging(id)
  const res = await dispatcher.dispatch(store.state.tasks[id])
  assert.equal(res.ok, false)
  assert.equal(res.skipped, 'merging')
  assert.match(res.message, /先回派/)
  assert.equal(store.state.tasks[id].phase, 'review-pending', '被守卫拦下时不该去写派工阶段')
})

// ---------- ③ needs-rebase：回派而不是回派+阻断 ----------

/** 造一张「分支落后 base」的卡：flow/<id> 上有一个提交，之后 base 又前进了一个提交。 */
const mkBehind = async (title) => {
  const repo = project.workspacePath
  const id = await mk(title)
  const branch = 'flow/' + id
  sh(repo, ['checkout', '-q', '-b', branch])
  writeFileSync(join(repo, id + '.txt'), 'worker' + NL)
  sh(repo, ['add', '-A'])
  sh(repo, ['commit', '-qm', 'worker 的改动'])
  const head = sh(repo, ['rev-parse', branch]).trim()
  sh(repo, ['checkout', '-q', 'main'])
  writeFileSync(join(repo, 'someone-else-' + id + '.txt'), '别人先合进来的' + NL)
  sh(repo, ['add', '-A'])
  sh(repo, ['commit', '-qm', '别人的提交'])
  const base = sh(repo, ['rev-parse', 'main']).trim()
  await store.tx((s) => {
    Object.assign(s.tasks[id], {
      column: 'merging', phase: 'review-pending', mergeState: 'ready', mergeReason: null, noMerge: false,
      mergeRequest: { id: 'pr_' + id, headSha: head, baseSha: base, branch, status: 'open', reviewVerdict: null },
    })
    s.seq.pr += 1
    s.pull_requests['pr_' + id] = { id: 'pr_' + id, taskId: id, projectId: project.id, headSha: head, baseSha: base, branch, status: 'open', conflictFiles: [], attempts: 0 }
  })
  return { id, branch }
}

const behind = await mkBehind('分支落后 base 时要回派到 running')
await t('needs-rebase 走回派：卡回到 running、mergeState=pending（不再 blocked）', async () => {
  const res = await dispatcher.merge(store.state.tasks[behind.id], { by: 'human' })
  const task = store.state.tasks[behind.id]
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.equal(res.reason, 'needs-rebase')
  assert.equal(res.attempts, 1)
  assert.equal(task.column, 'running', '回派前必须先 move 到 running，否则 dispatch 会撞合并列守卫')
  assert.equal(task.mergeState, 'pending', '合并没有失败，只是还没轮到：blocked 会让 autoMerge 反复重试')
  assert.equal(task.mergeReason, 'needs-rebase')
  assert.equal(task.rebaseAttempts, 1)
  // review_conflict 迁移自己会写 phase='changes-requested'；本条只验「已经离开了合并中」，
  // 派工与否由下一条（没有工位时停在 waiting-* 或迁移阶段）覆盖，避免把迁移的相位当派工证据。
  assert.notEqual(task.phase, 'review-pending', '卡不该还停在合并前的相位')
  assert.equal(res.redispatched && res.redispatched.ok, true, '确实派工了：' + JSON.stringify(res.redispatched))
  assert.ok(res.redispatched.runId, '派工要真的开出一条 run')
  assert.ok(domain.injectionsFor(behind.id, { kind: 'context' }).length >= 1, '软合并包要投给原工人')
})

await t('needs-rebase 第 4 次（attempts>3）走 blockMerge，且不再回派', async () => {
  // 用一张**新的**落后卡：上一张在上一条用例里已经被回派流程修好，不能再当"追不上"的样本。
  const again2 = await mkBehind('追了三次还是追不上')
  const id = again2.id
  await store.tx((s) => { s.tasks[id].rebaseAttempts = 3 })
  const injectedBefore = domain.injectionsFor(id, { kind: 'context' }).length
  const res = await dispatcher.merge(store.state.tasks[id], { by: 'human' })
  const task = store.state.tasks[id]
  assert.equal(res.ok, false)
  assert.equal(res.blocked, true)
  assert.match(String(task.noMergeReason || ''), /上限 3/)
  assert.equal(task.rebaseAttempts, 4)
  assert.equal(task.mergeState, 'blocked')
  assert.equal(task.column, 'merging', '永久停等：卡留在合并列等人看')
  assert.equal(domain.injectionsFor(id, { kind: 'context' }).length, injectedBefore, '第 4 次不该再投软合并包（不再回派）')
})

// ---------- ④ openPr 的远程 PR 闸门 ----------

await t('openPr 在 recordPulls:true 且 recordIssues:false 时仍然建远程 PR', async () => {
  const repo = mkRepo('repo-remote')
  const p2 = await domain.ensureProject({ workspacePath: repo, name: 'remote' })
  await store.tx((s) => {
    s.projects[p2.id].config = {
      ...s.projects[p2.id].config,
      baseBranch: 'main',
      pushRemote: true,
      recordPulls: true,
      recordIssues: false,
      remote: { kind: 'github', owner: 'o', repo: 'r' },
    }
  })
  const id = (await domain.createTask(p2.id, { title: '远程 PR 走 recordPulls' })).id
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init && init.method })
    return { ok: true, status: 201, text: async () => JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'open' }) }
  }
  try {
    const out = await dispatcher.openPr(store.state.tasks[id], {})
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(seen.length, 1, '应当只打一次建 PR 的请求')
    assert.match(seen[0].url, /\/repos\/o\/r\/pulls$/)
    assert.equal(seen[0].method, 'POST')
    assert.equal(out.remotePr.number, 7)
    const pr = store.state.pull_requests[out.pr.id]
    assert.equal(pr.remote.number, 7, '远程身份要挂到本地 PR 上')
  } finally {
    globalThis.fetch = realFetch
  }
})

console.log('')
if (fails.length) {
  console.log('FAILED ' + fails.length + ' / ' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + NL + '    ' + String((f.err && f.err.stack) || f.err).split(NL).slice(0, 4).join(NL + '    '))
  process.exit(1)
}
console.log('全部通过 ' + pass + ' / ' + pass)
