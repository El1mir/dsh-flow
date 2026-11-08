/**
 * worktree-empty-repo.mjs — 「工作区是 git 仓库、但一次提交都没有」时建 worktree 的复现。
 *
 * 线上症状（wb反代 / T-011，系统评论 c_00022）：
 *   建 worktree 失败，降级到工作区：fatal: invalid reference: HEAD
 *
 * 根因不是「没有 GitHub」，而是**仓库里没有任何提交**：
 *   - worktree 共享对象库，没有提交就没有可检出的内容；
 *   - defaultBranch() 在 unborn HEAD 上 `rev-parse --abbrev-ref HEAD` 失败，
 *     回退去猜 main/master 都不存在，最后返回 'main'（而真实分支叫 master）；
 *   - addWorktree 用 'main' 建失败后又拿 'HEAD' 兜底，两个引用都不存在，
 *     报出来的就是最后那条 fallback 的 stderr —— 真正的失败原因被盖住了。
 *
 * 本文件锁定三件事：
 *   1. defaultBranch 在 unborn HEAD 上也要说出**真实**分支名（symbolic-ref 可用）；
 *   2. 无提交时必须报 no-commits 这个**可识别**原因，附带中文处置建议，
 *      而不是把 git 的 fatal 原文丢给用户；
 *   3. 一旦有了基线提交，worktree + 合并流程必须完整跑通（这是用户的核心诉求：
 *      「无 github 情况下不代表没有 git，工作树合并这个流程还是要有的」）。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as git from '../lib/git.js'

// 探针环境里 process.env 可能缺少 HOME，git 找不到全局配置 → commit 会报「Author identity unknown」。
// 这里补上，并且每个临时仓库都写本地身份，保证测试在任何环境都能提交。
const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Administrator'
process.env.HOME = HOME
process.env.USERPROFILE = HOME

const TMP = process.env.TEMP || process.env.TMP || join(HOME, 'AppData', 'Local', 'Temp')

const raw = (cwd, args) => new Promise((resolve) => {
  execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() }))
})

/** 造一个「git init 了、但一次都没提交」的仓库。 */
function emptyRepo() {
  const root = mkdtempSync(join(TMP, 'flow-empty-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  return { root, repo }
}

async function initRepo(repo) {
  await raw(repo, ['init'])
  await raw(repo, ['config', 'user.email', 'flow@test.local'])
  await raw(repo, ['config', 'user.name', 'flow test'])
}

let pass = 0
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass += 1; console.log('  ok  ' + name) })

// ---- 1. unborn HEAD 上的真实分支名 ----------------------------------------
const e1 = emptyRepo()
await initRepo(e1.repo)

await check('init 之后确实没有任何提交（前提成立）', async () => {
  assert.equal(await git.headSha(e1.repo), null)
})

await check('defaultBranch 在 unborn HEAD 上返回真实分支名，而不是猜出来的 main', async () => {
  const real = (await raw(e1.repo, ['symbolic-ref', '--short', 'HEAD'])).out
  const got = await git.defaultBranch(e1.repo)
  assert.equal(got, real, 'defaultBranch 返回 ' + got + '，真实分支是 ' + real)
})

// ---- 2. 无提交时的失败必须可识别 ------------------------------------------
await check('addWorktree 在无提交仓库上报 no-commits，而不是裸的 fatal: invalid reference: HEAD', async () => {
  const made = await git.addWorktree({
    repo: e1.repo,
    dir: join(e1.root, 'wt'),
    branch: 'flow/T-001',
    base: undefined,
  })
  assert.equal(made.ok, false, '无提交仓库不该建出 worktree')
  assert.equal(made.reason, 'no-commits', '实际 reason: ' + made.reason)
  assert.ok(/提交/.test(made.message || ''), '要说清是「没有提交」：' + made.message)
})

await check('no-commits 的提示里给出可执行的处置建议', async () => {
  const made = await git.addWorktree({ repo: e1.repo, dir: join(e1.root, 'wt2'), branch: 'flow/T-002' })
  assert.ok(made.hint && /commit|提交/.test(made.hint), '要给 hint：' + made.hint)
})

// ---- 3. 有基线提交后，worktree + 合并流程必须跑通 --------------------------
await check('建了基线提交之后，worktree 能建出来并且看得见源码', async () => {
  await raw(e1.repo, ['add', '-A'])
  const c = await raw(e1.repo, ['commit', '-m', 'baseline'])
  assert.ok(c.ok, 'baseline commit 失败：' + c.err)

  const dir = join(e1.root, 'wt3')
  const made = await git.addWorktree({ repo: e1.repo, dir, branch: 'flow/T-003' })
  assert.equal(made.ok, true, '有提交后仍失败：' + JSON.stringify(made))
  assert.ok(readdirSync(dir).includes('a.txt'), 'worktree 里应该能看到仓库里的文件')
})

await check('worktree 里提交后能合回主仓库（合并流程没被降级掉）', async () => {
  const dir = join(e1.root, 'wt3')
  writeFileSync(join(dir, 'b.txt'), 'from worker\n')
  assert.ok((await raw(dir, ['add', '-A'])).ok)
  const c = await raw(dir, ['commit', '-m', 'flow: T-003'])
  assert.ok(c.ok, 'worktree commit 失败：' + c.err)

  const m = await git.mergeBranch({ repo: e1.repo, branch: 'flow/T-003', base: (await git.defaultBranch(e1.repo)) })
  assert.equal(m.ok, true, '合并失败：' + JSON.stringify(m))
  assert.ok(readdirSync(e1.repo).includes('b.txt'), '合并后主仓库应该有 b.txt')
})

// ---- 4. 前端要能看见「为什么没有 worktree」 --------------------------------
await check('defaultBranch 在有提交的仓库上仍然返回当前分支', async () => {
  assert.equal(await git.defaultBranch(e1.repo), 'master')
})

console.log('\nworktree-empty-repo: ' + pass + ' checks passed')
