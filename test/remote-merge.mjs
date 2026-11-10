/**
 * RT-02：landing 接缝 + 远程合并 + 合并后校验（spec §6.2–§6.4、ADR-0007 §2/§3）。
 *
 * 这些用例分两段：
 *   A. landing 单元：用 fake ctx（remote/git/integration/domain 全部注入）钉**远程合并的算法与顺序**。
 *      ——「先查外部批准 → 再 getPull → 已 merged 就不再调 merge API → head 对齐 → 越界 →
 *      mergePull → 失败分类 → fetch/advanceBase/isAncestor → markMerged → postMergeCheck →
 *      review_approve」，以及「合并路径永不 closePull」。
 *   B. dispatch 集成：真 git 仓库 + 假 forge，钉「dispatch 只做守卫/锁/工单，落点委托 landing」。
 *
 * 为什么 A 段必须用 fake：landing 的全部意义就是「不 import dispatch、不直接发网络」，
 * 这样「顺序」可以被断言成一条日志序列，而不是靠观察 git 现场的副作用去猜。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { land } from '../lib/landing.js'
import * as git from '../lib/git.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ok ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  FAIL ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

// ---------------------------------------------------------------------------
// A. landing 单元：一条日志序列 + fake ctx
// ---------------------------------------------------------------------------

const HEAD = 'a'.repeat(40)
const BASE_BEFORE = 'b'.repeat(40)
const BASE_AFTER = 'c'.repeat(40)
const FORGE_MERGE = 'd'.repeat(40)

/**
 * fake ctx。
 * opts:
 *   pull       getPull 的返回（默认：open、head 对齐、mergeable_state=clean）
 *   merge      mergePull 的返回（默认：成功）
 *   fetch / advance / ancestor / check  base 同步各步的返回
 *   pr / task / config  覆盖记录
 */
function makeCtx(opts = {}) {
  const log = []
  const task = {
    id: 'T-1', projectId: 'p1', title: '把远程合并接上', column: 'merging',
    scope: { paths: ['lib/'] }, kind: opts.kind || 'card',
    external: opts.external || null,
    mergeRequest: { id: 'pr_1', headSha: HEAD, status: 'open', reviewVerdict: 'approved' },
    ...(opts.task || {}),
  }
  const project = {
    id: 'p1', workspacePath: opts.dir || '/repo',
    config: {
      baseBranch: 'main', mergeStrategy: 'merge', remoteMode: true, pushRemote: true,
      remote: { kind: 'github', owner: 'o', repo: 'r', name: 'origin' },
      ...(opts.config || {}),
    },
  }
  const pr = {
    id: 'pr_1', taskId: 'T-1', headSha: HEAD, branch: 'flow/T-1', status: 'open', baseSha: BASE_BEFORE,
    remote: { number: 7, url: 'https://forge.invalid/o/r/pull/7', source: 'github', merged: false, state: 'open' },
    ...(opts.pr || {}),
  }
  const remote = {
    async getPull() {
      log.push(['getPull', 7])
      return opts.pull || { ok: true, number: 7, state: 'open', merged: false, headSha: HEAD, baseRef: 'main', mergeable: true, mergeableState: 'clean' }
    },
    async mergePull(args) {
      log.push(['mergePull', args.number, args.sha, args.method])
      if (opts.mergeThrow) throw opts.mergeThrow
      return opts.merge || { ok: true, merged: true, mergeCommitSha: FORGE_MERGE, status: 200, reason: 'merged', message: 'ok' }
    },
    // 合并路径**不该**调它（RT-02 的核心行为变化：不 close）。
    async closePull() { log.push(['closePull']); return { ok: true } },
  }
  const gitApi = {
    async defaultBranch() { return 'main' },
    async fetchBranch(args) { log.push(['fetchBranch', args.branch]); return opts.fetch || { ok: true, sha: BASE_AFTER, ref: 'refs/remotes/origin/main' } },
    async isAncestor(a, b) { log.push(['isAncestor', a, b]); return opts.ancestor === undefined ? true : opts.ancestor },
    async revParse() { return BASE_AFTER },
    async dirtyFilePaths() { return opts.dirty || [] },
    async branchExists() { return true },
    async dryRunMerge(dir, branch) { log.push(['dryRunMerge', branch]); return opts.dry || { ok: false, clean: false, files: [] } },
    async fetchRef() { log.push(['fetchRef']); return { ok: true, sha: HEAD, branch: 'external/pr-7' } },
  }
  const integration = {
    async ensure() { return { ok: true, dir: '/integ' } },
    async advanceBase(project0, args) { log.push(['advanceBase', args.sha]); return opts.advance || { ok: true, base: args.base, sha: args.sha } },
  }
  const domain = {
    async attachPullRemote(id, info) { log.push(['attachPullRemote', info.merged === true, info.state, info.mergeCommitSha || null]) },
    async markMerged(id, info) { log.push(['markMerged', info.commit, info.strategy, info.mergeCommit === undefined ? null : info.mergeCommit]) },
    async setReviewVerdict(id, verdict) { log.push(['setReviewVerdict', verdict]) },
    async move(id, action) { log.push(['move', action]); return {} },
    async setMergeState() {},
    async block() {},
    async comment() {},
    async inject() {},
    async setExternal() {},
    async askHuman() {},
  }
  let checkCalls = 0
  const postMergeCheck = opts.noCheck ? null : async () => {
    checkCalls += 1
    log.push(['postMergeCheck'])
    return opts.check || { ok: true }
  }
  const ctx = {
    authority: 'remote', strategy: opts.strategy, by: opts.by || 'agent', overrideOutOfScope: false,
    project, pr, remote, git: gitApi, integration, domain, postMergeCheck, timeoutMs: opts.timeoutMs,
    detectOutOfScope: async () => opts.outOfScope || { ok: true },
    localMerge: opts.localMerge,
  }
  return { ctx, log, task, project, pr, get checkCalls() { return checkCalls } }
}

const idx = (log, name) => log.findIndex((x) => x[0] === name)
const count = (log, name) => log.filter((x) => x[0] === name).length
function assertOrder(log, names) {
  const positions = names.map((n) => idx(log, n))
  for (let i = 0; i < positions.length; i++) {
    assert.ok(positions[i] >= 0, '缺少步骤 ' + names[i] + '（实际顺序 ' + log.map((x) => x[0]).join(' → ') + '）')
    if (i > 0) assert.ok(positions[i] > positions[i - 1], names[i] + ' 必须排在 ' + names[i - 1] + ' 之后（实际 ' + log.map((x) => x[0]).join(' → ') + '）')
  }
}

// ---- A1 成功：顺序、一次 mergePull、不 close、pr.remote 收口 ----

await t('A1 远程合并成功：mergePull 一次；fetch→advanceBase→isAncestor→markMerged→postMergeCheck→review_approve；不 closePull', async () => {
  const { ctx, log, task, pr } = makeCtx()
  const out = await land(task, ctx)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.state, 'merged')
  assert.equal(out.commit, FORGE_MERGE)
  assert.equal(out.commitSource, 'forge')
  assert.equal(count(log, 'mergePull'), 1, 'mergePull 只能调一次')
  const args = log.find((x) => x[0] === 'mergePull')
  assert.equal(args[1], 7)
  assert.equal(args[2], HEAD, '必须带锁定的 headSha')
  assert.equal(args[3], 'merge')
  assert.equal(count(log, 'closePull'), 0, '合并路径不许 closePull')
  assertOrder(log, ['getPull', 'mergePull', 'fetchBranch', 'advanceBase', 'isAncestor', 'markMerged', 'postMergeCheck', 'setReviewVerdict', 'move'])
  assert.deepEqual(log.find((x) => x[0] === 'markMerged'), ['markMerged', FORGE_MERGE, 'merge', FORGE_MERGE])
  assert.deepEqual(log.find((x) => x[0] === 'move'), ['move', 'review_approve'])
  // 远程事实：merged/state/mergeCommitSha 都要落，供重入判断
  assert.deepEqual(log.find((x) => x[0] === 'attachPullRemote'), ['attachPullRemote', true, 'merged', FORGE_MERGE])
  assert.equal(out.remote.number, 7)
  assert.equal(out.remote.merged, true)
})

// ---- A2 local 权威：只调注入的 localMerge，不碰 remote ----

await t('A2 authority=local：只调 ctx.localMerge，不调任何 forge API（本地模式零网络）', async () => {
  const localCalls = []
  const { ctx, log } = makeCtx({ localMerge: async (task0, ctx0) => { localCalls.push({ taskId: task0.id, strategy: ctx0.strategy }); return { ok: true, commit: 'localsha' } } })
  ctx.authority = 'local'
  ctx.strategy = 'squash'
  const out = await land({ id: 'T-1' }, ctx)
  assert.deepEqual(out, { ok: true, commit: 'localsha' }, 'local 必须原样返回 mergeLocked 的结果')
  assert.deepEqual(localCalls, [{ taskId: 'T-1', strategy: 'squash' }])
  assert.deepEqual(log, [], '本地权威不许有任何 forge/git 调用')
})

// ---- A3 幂等：远程已 merged → 不重复调 merge API ----

await t('A3 幂等：pr.remote.merged=true 时不再调 mergePull，只做本地同步与收口', async () => {
  const { ctx, log, task, pr } = makeCtx({ pull: { ok: true, number: 7, state: 'closed', merged: true, headSha: HEAD, mergeCommitSha: FORGE_MERGE, baseRef: 'main', mergeableState: 'unknown' }, pr: { remote: { number: 7, url: 'u', merged: true, state: 'merged', mergeCommitSha: FORGE_MERGE } } })
  const out = await land(task, ctx)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.state, 'already')
  assert.equal(count(log, 'mergePull'), 0, '已经合过了，不能再调 merge API')
  assert.equal(count(log, 'closePull'), 0)
  assertOrder(log, ['getPull', 'fetchBranch', 'advanceBase', 'isAncestor', 'markMerged', 'setReviewVerdict', 'move'])
})

// ---- A4 冲突：返回 conflict + 文件，不改卡、不 markMerged ----

await t('A4 冲突：返回 state=conflict 且带 dry-run 冲突文件；不 markMerged、不 review_approve', async () => {
  const { ctx, log, task } = makeCtx({
    merge: { ok: false, merged: false, mergeCommitSha: null, status: 405, reason: 'conflict', message: 'Pull Request is not mergeable' },
    dry: { ok: false, clean: false, files: ['src/a.js', 'src/b.js'] },
  })
  const out = await land(task, ctx)
  assert.equal(out.ok, false)
  assert.equal(out.state, 'conflict')
  assert.deepEqual(out.files, ['src/a.js', 'src/b.js'])
  assert.equal(count(log, 'markMerged'), 0)
  assert.equal(count(log, 'move'), 0)
  assert.equal(count(log, 'fetchBranch'), 0, '冲突时不动 base')
  assert.equal(count(log, 'closePull'), 0)
})

// ---- A5 失败分类：protected / auth / missing / head-moved / server ----

for (const [reason, blockedReason, category] of [
  ['protected', 'merge-protected', 'approval'],
  ['auth', 'auth', 'blocked'],
  ['missing', 'pr-missing', 'blocked'],
  ['head-moved', 'head-mismatch', 'blocked'],
  ['not-merged', 'not-merged', 'blocked'],
]) {
  await t('A5/' + reason + '：mergePull 失败分类为 blocked/' + blockedReason + '，不本地兜底', async () => {
    const { ctx, log, task } = makeCtx({ merge: { ok: false, merged: false, mergeCommitSha: null, status: 400, reason, message: 'forge says ' + reason } })
    const out = await land(task, ctx)
    assert.equal(out.ok, false)
    assert.equal(out.state, 'blocked')
    assert.equal(out.blockedReason, blockedReason)
    assert.match(String(out.message || ''), new RegExp(reason === 'head-moved' ? 'forge says head-moved' : reason))
    if (category) assert.equal(out.category, category)
    assert.equal(count(log, 'fetchBranch'), 0, '失败时不许动本地 base')
    assert.equal(count(log, 'markMerged'), 0)
    assert.equal(count(log, 'closePull'), 0)
  })
}

await t('A6 server：state=blocked/forge-error 且 retryable=true（重试策略归 dispatch）', async () => {
  const { ctx, log, task } = makeCtx({ merge: { ok: false, merged: false, mergeCommitSha: null, status: 502, reason: 'server', message: 'Bad Gateway' } })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'forge-error')
  assert.equal(out.retryable, true)
  assert.equal(count(log, 'markMerged'), 0)
})

await t('A6b unknown：同样 retryable=true（不猜，交给重试 + 工单）', async () => {
  const { ctx, task } = makeCtx({ merge: { ok: false, merged: false, mergeCommitSha: null, status: 418, reason: 'unknown', message: 'I am a teapot' } })
  const out = await land(task, ctx)
  assert.equal(out.blockedReason, 'forge-error')
  assert.equal(out.retryable, true)
  assert.match(out.message, /teapot/)
})

await t('A6c merge API 超时（>timeoutMs）按 server 归类，retryable=true', async () => {
  const { ctx, task } = makeCtx({ timeoutMs: 20 })
  ctx.remote.mergePull = () => new Promise(() => {}) // 永不返回
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'forge-error')
  assert.equal(out.retryable, true)
  assert.match(String(out.message), /超时|timeout/i)
})

// ---- A7 前置守卫：外部批准 / review / head 对齐 / 越界 ----

await t('A7 外部 PR 未批准：needs-approval，一次 forge 调用都不发', async () => {
  const { ctx, log, task } = makeCtx({
    kind: 'external-pr',
    external: { number: 7, provider: 'github', headSha: HEAD, approval: { status: 'pending' } },
  })
  const out = await land(task, ctx)
  assert.equal(out.ok, false)
  assert.equal(out.state, 'needs-approval')
  assert.equal(out.blockedReason, 'pending')
  assert.equal(count(log, 'getPull'), 0)
  assert.equal(count(log, 'mergePull'), 0)
})

await t('A7b 外部 PR 已批准：正常进入 mergePull', async () => {
  const { ctx, log, task } = makeCtx({
    kind: 'external-pr',
    external: { number: 7, provider: 'github', headSha: HEAD, approval: { status: 'approved' } },
    pr: { branch: 'external/pr-7' },
  })
  const out = await land(task, ctx)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(count(log, 'mergePull'), 1)
})

await t('A7c 防御性审核断言：没有 approved 且不是人点的 → blocked/needs-review（不猜）', async () => {
  const { ctx, log, task } = makeCtx({ task: { mergeRequest: { id: 'pr_1', headSha: HEAD, status: 'open', reviewVerdict: 'needs_work' } } })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'needs-review')
  assert.equal(count(log, 'getPull'), 0)
})

await t('A7d 人点的合并（by=human）不需要预置 approved', async () => {
  const { ctx, log, task } = makeCtx({ by: 'human', task: { mergeRequest: { id: 'pr_1', headSha: HEAD, status: 'open', reviewVerdict: null } } })
  const out = await land(task, ctx)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(count(log, 'mergePull'), 1)
})

await t('A8 getPull 的 headSha 与锁定 head 不一致：blocked/head-mismatch，不调 merge API', async () => {
  const { ctx, log, task } = makeCtx({ pull: { ok: true, number: 7, state: 'open', merged: false, headSha: 'f'.repeat(40), baseRef: 'main', mergeable: true, mergeableState: 'clean' } })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'head-mismatch')
  assert.equal(count(log, 'mergePull'), 0)
})

await t('A8b 外部 PR 的 headSha 与建卡时锁定的不一致：同样 head-mismatch', async () => {
  const { ctx, log, task } = makeCtx({
    kind: 'external-pr',
    external: { number: 7, provider: 'github', headSha: 'e'.repeat(40), approval: { status: 'approved' } },
    pull: { ok: true, number: 7, state: 'open', merged: false, headSha: HEAD, baseRef: 'main', mergeable: true, mergeableState: 'clean' },
  })
  const out = await land(task, ctx)
  assert.equal(out.blockedReason, 'head-mismatch')
  assert.equal(count(log, 'mergePull'), 0)
})

await t('A9 越界未提交改动：blocked/out-of-scope，不调 merge API', async () => {
  const { ctx, log, task } = makeCtx({ outOfScope: { ok: false, files: ['lib/x.js'], scope: ['lib/'] } })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'out-of-scope')
  assert.deepEqual(out.files, ['lib/x.js'])
  assert.equal(count(log, 'mergePull'), 0)
})

// ---- A10 合并后校验失败：记录远程事实，但不 markMerged ----

await t('A10 base 同步失败（fetch 失败）：blocked/base-sync-failed；远程已合并的事实已落库；不 markMerged', async () => {
  const { ctx, log, task } = makeCtx({ fetch: { ok: false, reason: 'fetch-failed', message: 'network down' } })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'base-sync-failed')
  assert.equal(log.find((x) => x[0] === 'attachPullRemote')[1], true, '远程已合并必须落库，供重入判断')
  assert.equal(count(log, 'markMerged'), 0)
  assert.equal(count(log, 'move'), 0)
})

await t('A11 advanceBase 失败：blocked/base-sync-failed；不 markMerged', async () => {
  const { ctx, log, task } = makeCtx({ advance: { ok: false, reason: 'base-busy', holder: '/other' } })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'base-sync-failed')
  assert.equal(count(log, 'markMerged'), 0)
})

await t('A12 isAncestor=false：blocked/merge-not-in-base；不 markMerged', async () => {
  const { ctx, log, task } = makeCtx({ ancestor: false })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'merge-not-in-base')
  assert.equal(count(log, 'markMerged'), 0)
  assert.equal(count(log, 'move'), 0)
})

await t('A13 postMergeCheck 失败：blocked/post-merge-check-failed；markMerged 已记，但不 review_approve', async () => {
  const { ctx, log, task } = makeCtx({ check: { ok: false, code: 1, stderr: 'boom' } })
  const out = await land(task, ctx)
  assert.equal(out.state, 'blocked')
  assert.equal(out.blockedReason, 'post-merge-check-failed')
  assert.equal(count(log, 'markMerged'), 1, '远程已合并的事实必须留下')
  assert.equal(count(log, 'setReviewVerdict'), 0, '冒烟红不许写 approved')
  assert.equal(count(log, 'move'), 0, '冒烟红不许 review_approve')
})

await t('A14 forge 没给 mergeCommitSha：commit 退到 fetch 后 base 的 head，并标注来源 commit', async () => {
  const { ctx, log, task } = makeCtx({ merge: { ok: true, merged: true, mergeCommitSha: null, status: 200, reason: 'merged', message: 'ok' } })
  const out = await land(task, ctx)
  assert.equal(out.ok, true)
  assert.equal(out.commit, BASE_AFTER)
  assert.equal(out.commitSource, 'commit')
  assert.equal(log.find((x) => x[0] === 'markMerged')[1], BASE_AFTER)
})

// ---------------------------------------------------------------------------
// A2. git.dryRunMerge：只用来「forge 说冲突，取冲突文件」，绝不改变工作区最终状态
// ---------------------------------------------------------------------------

function mkRepo(name) {
  const dir = join(root, name)
  sh(root, ['init', '-q', '-b', 'main', name])
  sh(dir, ['config', 'user.email', 'flow@local'])
  sh(dir, ['config', 'user.name', 'flow'])
  writeFileSync(join(dir, 'a.txt'), 'base' + NL)
  sh(dir, ['add', '-A'])
  sh(dir, ['commit', '-qm', 'baseline'])
  return dir
}
const root = mkdtempSync(join(tmpdir(), 'flow-dryrun-'))
const cleanRepo = mkRepo('clean')
sh(cleanRepo, ['checkout', '-q', '-b', 'feature'])
writeFileSync(join(cleanRepo, 'b.txt'), 'feature only' + NL)
sh(cleanRepo, ['add', '-A']); sh(cleanRepo, ['commit', '-qm', 'feature work'])
sh(cleanRepo, ['checkout', '-q', 'main'])
const cleanHead = sh(cleanRepo, ['rev-parse', 'HEAD']).trim()

await t('A15 dryRunMerge：能干净合并 → {ok:true, clean:true, files:[]}，且工作区留在原地', async () => {
  const out = await git.dryRunMerge(cleanRepo, 'feature')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.clean, true)
  assert.deepEqual(out.files, [])
  assert.equal(sh(cleanRepo, ['rev-parse', 'HEAD']).trim(), cleanHead, 'HEAD 不能动')
  assert.equal(sh(cleanRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main', '不能把检出切走')
  assert.equal(sh(cleanRepo, ['status', '--porcelain']).trim(), '', '必须恢复干净状态')
})

const conflictRepo = mkRepo('conflict')
sh(conflictRepo, ['checkout', '-q', '-b', 'feature'])
writeFileSync(join(conflictRepo, 'a.txt'), 'feature version' + NL)
sh(conflictRepo, ['add', '-A']); sh(conflictRepo, ['commit', '-qm', 'feature changes a'])
sh(conflictRepo, ['checkout', '-q', 'main'])
writeFileSync(join(conflictRepo, 'a.txt'), 'main version' + NL)
sh(conflictRepo, ['add', '-A']); sh(conflictRepo, ['commit', '-qm', 'main changes a'])
const conflictHead = sh(conflictRepo, ['rev-parse', 'HEAD']).trim()

await t('A16 dryRunMerge：冲突 → files 含冲突文件，且工作区必须恢复（无 MERGE_HEAD、status 干净）', async () => {
  const out = await git.dryRunMerge(conflictRepo, 'feature')
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.clean, false)
  assert.ok(out.files.includes('a.txt'), '冲突文件应包含 a.txt，实际 ' + JSON.stringify(out.files))
  assert.equal(sh(conflictRepo, ['rev-parse', 'HEAD']).trim(), conflictHead, 'HEAD 不能动')
  assert.equal(sh(conflictRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')
  assert.equal(sh(conflictRepo, ['status', '--porcelain']).trim(), '', '必须 abort 掉，不能留下半合并现场')
  let mergeHead = ''
  try { mergeHead = sh(conflictRepo, ['rev-parse', '--verify', 'MERGE_HEAD']).trim() } catch { mergeHead = '' }
  assert.equal(mergeHead, '', 'MERGE_HEAD 还在，说明没有 abort')
})

await t('A17 dryRunMerge：分支不存在 → 不抛错，返回 ok:false 且工作区不受影响', async () => {
  const out = await git.dryRunMerge(cleanRepo, 'no-such-branch')
  assert.equal(out.ok, false)
  assert.ok(out.reason, '要带 reason')
  assert.equal(sh(cleanRepo, ['status', '--porcelain']).trim(), '')
  assert.equal(sh(cleanRepo, ['rev-parse', 'HEAD']).trim(), cleanHead)
})

// ---- 汇总 ----

if (fails.length) {
  console.log('')
  console.log('FAIL remote-merge ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.stack) || f.err).split(NL).slice(0, 3).join(NL + '    '))
  process.exitCode = 1
} else {
  console.log('')
  console.log('PASS remote-merge ' + pass + '/' + pass)
}
