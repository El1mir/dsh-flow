/**
 * C-06 / rf-03：外部 PR 卡的合并落地。
 *
 * 钉住四条不变式：
 *   ① 代码从 refs/pull/<n>/head 抓下来（本地没有别人的分支）；
 *   ② 建卡时锁定的 headSha 变了就**不合**（head-mismatch），等人确认；
 *   ③ 合并仍然在本地进行（不调 forge 的 merge API），base 真的前进；
 *   ④ 合并成功后关远程 PR、删掉那条一次性抓取分支。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store, isDelivered } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import * as git from '../lib/git.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-external-'))

// ---- 造一个「远程」：bare 仓库 + 一条 PR 分支，外加 refs/pull/1/head ----
const origin = join(root, 'origin.git')
sh(root, ['init', '-q', '--bare', 'origin.git'])
const seed = join(root, 'seed')
sh(root, ['clone', '-q', origin, 'seed'])
sh(seed, ['config', 'user.email', 'pr@local'])
sh(seed, ['config', 'user.name', 'pr'])
sh(seed, ['checkout', '-q', '-b', 'main'])
writeFileSync(join(seed, 'base.txt'), 'base' + NL)
sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'baseline'])
sh(seed, ['push', '-q', 'origin', 'main'])
// bare 仓库的 HEAD 默认指向 master；把远端 HEAD 拨到 main，后面的 clone 才会落在 main 上。
sh(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
sh(seed, ['checkout', '-q', '-b', 'feature'])
writeFileSync(join(seed, 'feature.txt'), 'from external pr' + NL)
sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'external work'])
const externalSha = sh(seed, ['rev-parse', 'HEAD']).trim()
sh(seed, ['push', '-q', 'origin', 'feature'])
sh(seed, ['push', '-q', 'origin', 'feature:refs/pull/1/head'])
// 第二个 PR 引用：给「锁定 headSha 变了」那条用例用（PR 号必须不同，否则会命中同一张卡的去重锚）。
sh(seed, ['push', '-q', 'origin', 'feature:refs/pull/2/head'])

// ---- 本地工作区：同一个 origin 的另一个 clone，origin 就是它的 origin ----
const repo = join(root, 'repo')
sh(root, ['clone', '-q', origin, 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
const baseSha0 = sh(repo, ['rev-parse', 'main']).trim()

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
const project = await domain.ensureProject({ workspacePath: repo, name: 'external' })
// 刻意**不配** remote：closePull 会在 remoteReady 处提前返回，测试不会打网络。
await domain.updateProjectConfig(project.id, { mergeStrategy: 'merge', outOfScopeCheck: false, pushRemote: false })
await domain.ensureAgents(project.id)

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

async function makeExternalTask(facts, prInfo) {
  const task = await domain.createExternalPrTask(project.id, facts, { role: 'system', id: 'sync:external-pr' })
  await domain.openPullRequest(task.id, prInfo, { role: 'system', id: 'sync:external-pr' })
  return store.state.tasks[task.id]
}

const t1 = await makeExternalTask(
  { provider: 'github', number: 1, headBranch: 'feature', baseBranch: 'main', headSha: externalSha, url: 'https://example.invalid/pr/1', title: '外部 PR #1' },
  { headSha: externalSha, branch: 'external/pr-1', base: 'main', source: 'external', title: '外部 PR #1' },
)

await t('① 外部 PR 卡：落 merging、无检出、mergeState=pending、kind=external-pr', () => {
  assert.equal(t1.column, 'merging')
  assert.equal(t1.worktree, false)
  assert.equal(t1.mergeState, 'pending')
  assert.equal(t1.kind, 'external-pr')
  assert.equal(t1.external.number, 1)
})

const t2 = await makeExternalTask(
  { provider: 'github', number: 2, headBranch: 'feature', baseBranch: 'main', headSha: 'f'.repeat(40), title: '旧 head 的外部 PR' },
  { headSha: 'f'.repeat(40), branch: 'external/pr-2', base: 'main', source: 'external' },
)
const bad = await dispatcher.merge(store.state.tasks[t2.id], { by: 'human' })
await t('② 锁定 headSha 变了：不合并，判 head-mismatch 并 blocked', () => {
  assert.equal(bad.ok, false)
  assert.match(String(bad.message || ''), /head-mismatch|新提交/)
  const cur = store.state.tasks[t2.id]
  assert.equal(cur.mergeState, 'blocked')
  assert.equal(cur.mergeReason, 'head-mismatch')
  assert.equal(sh(repo, ['rev-parse', 'main']).trim(), baseSha0, 'base 不能被碰')
})

const ok = await dispatcher.merge(store.state.tasks[t1.id], { by: 'human' })
await t('③ 正常外部 PR：本地合并成功，base 真的前进', () => {
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(sh(repo, ['rev-parse', 'main']).trim() === baseSha0, false, 'base 必须前进')
  const cur = store.state.tasks[t1.id]
  assert.equal(cur.column, 'done')
  assert.equal(cur.phase, 'merged')
  assert.equal(isDelivered(cur), true)
})

await t('④ 合并后那条一次性抓取分支被删掉', () => {
  const branches = sh(repo, ['branch', '--list', 'external/pr-1']).trim()
  assert.equal(branches, '', 'external/pr-1 应该已经不在了（实际 ' + branches + '）')
})

await t('⑤ 远程没配时关 PR 失败不影响本地结果（只落评论）', () => {
  const comments = (store.state.task_comments || []).filter((c) => c.taskId === t1.id).map((c) => c.content || '')
  const text = comments.join(NL)
  assert.match(text, /关闭远程 PR #1 失败|已关闭外部 PR #1|关闭外部 PR/)
})

await t('⑥ createExternalPrTask 幂等：同一个 PR 再入站一次不建第二张卡', async () => {
  const again = await domain.createExternalPrTask(project.id, { provider: 'github', number: 1, headSha: externalSha }, { role: 'system' })
  assert.equal(again.id, t1.id)
  const count = Object.values(store.state.tasks).filter((x) => x && x.kind === 'external-pr' && x.external && x.external.number === 1).length
  assert.equal(count, 1)
})

await t('⑦ fetchRef：ref 不存在时报 ref-missing，不抛', async () => {
  const r2 = await git.fetchRef({ repo, source: 'refs/pull/999/head', dest: 'external/pr-999' })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'ref-missing')
})

await t('⑧ fetchRef：抓下来之后本地有那条分支，sha 与远程一致', async () => {
  const r3 = await git.fetchRef({ repo, source: 'refs/pull/1/head', dest: 'external/pr-1' })
  assert.equal(r3.ok, true, JSON.stringify(r3))
  assert.equal(r3.sha, externalSha)
  assert.equal(await git.branchExists(repo, 'external/pr-1'), true)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.log('FAILED: ' + f.name + NL + String((f.err && f.err.stack) || f.err))
  console.log('external merge FAILED (' + fails.length + ' of ' + (pass + fails.length) + ')')
  process.exit(1)
}
console.log('external merge ok (' + pass + ' checks)')