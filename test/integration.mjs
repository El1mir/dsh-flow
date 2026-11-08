/**
 * 集成检出的单测（I-01 / ADR-0004）。
 *
 * 只跑真实 git（临时的主检出 + 任务分支），不碰任何已有仓库。
 * 重点不是"能建出来"，而是四条容易被写错的性质：
 *   ① 必须是 detached —— 真实检出 base 在"base 已被主检出占用"这个常态下根本建不出来；
 *   ② 建立即 locked —— lock 是唯一挡 prune/remove 的机制；
 *   ③ 有未提交改动时 release 要拒（那是合并中途崩溃的证据）；
 *   ④ 推进 base 的三条路径都要安全：没人占 → update-ref；主检占着 → ff-only；
 *      会被覆盖 → 中止且不动别人的文件。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as git from '../lib/git.js'
import * as integration from '../lib/integration.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const shSoft = (cwd, args) => { try { sh(cwd, args); return { ok: true } } catch (err) { return { ok: false, err: String(err.stderr || err.message || err) } } }

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split('\n')[0]) }
}

/** 造一个"主检在 master、任务分支 flow/T-1 领先一步"的仓库。 */
function makeRepo(tag) {
  const parent = mkdtempSync(join(tmpdir(), 'flow-integ-' + tag + '-'))
  const repo = join(parent, 'repo')
  sh(parent, ['init', '-q', '-b', 'master', 'repo'])
  sh(repo, ['config', 'user.email', 'flow@local'])
  sh(repo, ['config', 'user.name', 'flow'])
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])
  sh(repo, ['checkout', '-qb', 'flow/T-1'])
  writeFileSync(join(repo, 'b.txt'), 'work\n')
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'work'])
  sh(repo, ['checkout', '-q', 'master'])
  return { parent, repo, project: { name: 'repo', workspacePath: repo, config: {} } }
}

/** 在集成检出里合并一条分支，返回合并后的 sha（模拟 mergeLocked 的核心动作）。 */
function mergeInInteg(dir, branch) {
  sh(dir, ['merge', '--no-ff', '-m', 'flow: merge ' + branch, branch])
  return sh(dir, ['rev-parse', 'HEAD']).trim()
}

// ---------------------------------------------------------------- 建与复用

{
  const { repo, project } = makeRepo('basic')

  await t('ensure：建出来的是 detached（真实检出 base 在 base 被占时必然失败）', async () => {
    // 先证明前提：主检在 master 时，真实检出 master 会 fatal
    const direct = shSoft(repo, ['worktree', 'add', '-B', 'master', join(project.workspacePath, '..', 'x'), 'master'])
    assert.equal(direct.ok, false, '前提不成立：git 居然允许两个检出一检出同一分支')
    assert.match(direct.err, /already used by worktree/)
    const res = await integration.ensure(project, { base: 'master' })
    assert.equal(res.ok, true, String(res.reason || res.message || ''))
    assert.equal(await git.currentBranch(res.dir), null, 'detached 的 currentBranch 必须是 null')
    assert.equal(await git.headSha(res.dir), await git.headSha(repo))
  })

  await t('ensure：建立即上锁，porcelain 里能看到 locked', async () => {
    const res = await integration.ensure(project, { base: 'master' })
    const entry = git.findWorktree(await git.listWorktrees(repo), res.dir)
    assert.ok(entry, '集成检出要出现在 worktree list 里')
    assert.equal(entry.locked, true, '没上锁就会被 gcWorktrees / prune 收走')
    assert.match(String(entry.lockReason || ''), /integration/)
  })

  await t('ensure：第二次复用同一个目录，不重建', async () => {
    const a = await integration.ensure(project, { base: 'master' })
    const b = await integration.ensure(project, { base: 'master' })
    assert.equal(a.dir, b.dir)
    assert.equal(b.reused, true)
    assert.equal(b.created, undefined)
  })

  await t('ensure：merge 进来之后 base 不动，但更新 base 后复用要对齐', async () => {
    const res = await integration.ensure(project, { base: 'master' })
    mergeInInteg(res.dir, 'flow/T-1')
    const merged = await git.headSha(res.dir)
    assert.notEqual(merged, await git.revParse(repo, 'master'), 'detached 合并不推进 base —— 这正是必须显式 advanceBase 的原因')
    // base 本身没动，所以复用时应判定为 diverged（集成检出领先 base，但不是 base 的祖先）
    const again = await integration.ensure(project, { base: 'master' })
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'integ-diverged', '集成检出领先 base 时要报出来，不能静默 reset 掉那次合并')
  })

  await t('release：有未提交改动时拒绝', async () => {
    const res = await integration.ensure(project, { base: 'master' })
    const dir = integration.integDirFor(project)
    writeFileSync(join(dir, 'wip.txt'), '脏\n')
    const rel = await integration.release(project, { base: 'master' })
    assert.equal(rel.ok, false)
    assert.equal(rel.reason, 'dirty')
    const { rmSync } = await import('node:fs')
    rmSync(join(dir, 'wip.txt'))
    void res
  })
}

// ---------------------------------------------------------------- 推进 base

await t('advanceBase：base 没被占用时走 update-ref', async () => {
  const { repo, project } = makeRepo('updref')
  const res = await integration.ensure(project, { base: 'master' })
  const merged = mergeInInteg(res.dir, 'flow/T-1')
  // 让主检出离开 master，于是没人占着它
  sh(repo, ['checkout', '-q', 'flow/T-1'])
  const adv = await integration.advanceBase(project, { base: 'master', sha: merged, dir: res.dir })
  assert.equal(adv.ok, true, JSON.stringify(adv))
  assert.equal(adv.via, 'update-ref')
  assert.equal(await git.revParse(repo, 'master'), merged)
  // 主检出仍停在 flow/T-1，工作区不该被搅动
  assert.equal(await git.currentBranch(repo), 'flow/T-1')
})

await t('advanceBase：主检出占着 base 时走 ff-only，干净就前进', async () => {
  const { repo, project } = makeRepo('ff')
  const res = await integration.ensure(project, { base: 'master' })
  const merged = mergeInInteg(res.dir, 'flow/T-1')
  const adv = await integration.advanceBase(project, { base: 'master', sha: merged, dir: res.dir })
  assert.equal(adv.ok, true, JSON.stringify(adv))
  assert.equal(adv.via, 'ff-only')
  assert.equal(await git.headSha(repo), merged, '主检出的 HEAD 与 ref 必须一起前进')
  assert.equal(await git.dirtyFiles(repo).then((x) => x.length), 0, 'ff 之后工作区必须干净')
  assert.ok(existsSync(join(repo, 'b.txt')), '合并带进来的文件要真的落到主检出')
})

await t('advanceBase：主检出有不相关脏文件时仍能前进，且不碰那个文件', async () => {
  const { repo, project } = makeRepo('ffdirty')
  writeFileSync(join(repo, 'c.txt'), 'local wip\n')
  const res = await integration.ensure(project, { base: 'master' })
  const merged = mergeInInteg(res.dir, 'flow/T-1')
  const adv = await integration.advanceBase(project, { base: 'master', sha: merged, dir: res.dir })
  assert.equal(adv.ok, true, JSON.stringify(adv))
  assert.ok(existsSync(join(repo, 'c.txt')), '人的未提交文件必须还在')
})

await t('advanceBase：会被覆盖时安全中止，判 base-dirty-collide 且不动文件', async () => {
  const { repo, project } = makeRepo('collide')
  writeFileSync(join(repo, 'b.txt'), 'local wip that collides\n')
  const res = await integration.ensure(project, { base: 'master' })
  const merged = mergeInInteg(res.dir, 'flow/T-1')
  const adv = await integration.advanceBase(project, { base: 'master', sha: merged, dir: res.dir })
  assert.equal(adv.ok, false)
  assert.equal(adv.reason, 'base-dirty-collide')
  assert.match(adv.detail, /would be overwritten|overwritten by/i)
  const { readFileSync } = await import('node:fs')
  assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8'), 'local wip that collides\n', '人的东西一个字节都不能动')
  assert.notEqual(await git.revParse(repo, 'master'), merged, '中止时 base 不该前进')
})

await t('advanceBase：base 被别的（非主）检出占着时判 base-busy，不硬改 ref', async () => {
  const { parent, repo, project } = makeRepo('busy')
  sh(repo, ['checkout', '-q', 'flow/T-1'])
  const other = join(parent, 'other-checkout')
  sh(repo, ['worktree', 'add', '-q', other, 'master'])
  const res = await integration.ensure(project, { base: 'master' })
  const merged = mergeInInteg(res.dir, 'flow/T-1')
  const adv = await integration.advanceBase(project, { base: 'master', sha: merged, dir: res.dir })
  assert.equal(adv.ok, false)
  assert.equal(adv.reason, 'base-busy')
  assert.equal(git.samePath(adv.holder, other), true, 'holder 要指向那个非主检出：' + adv.holder)
  assert.notEqual(await git.revParse(repo, 'master'), merged)
})

await t('status：报告 detached / 干净 / 锁定 / 与 base 的关系', async () => {
  const { repo, project } = makeRepo('status')
  const res = await integration.ensure(project, { base: 'master' })
  const st = await integration.status(project, { base: 'master' })
  assert.equal(st.exists, true)
  assert.equal(st.detached, true)
  assert.equal(st.clean, true)
  assert.equal(st.locked, true)
  assert.equal(st.head, st.baseSha)
  void res
  void repo
})

await t('ensure：base 不存在时报 base-missing，不去猜一个分支出来', async () => {
  const { project } = makeRepo('nobase')
  const res = await integration.ensure(project, { base: 'no-such-branch' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'base-missing')
})

await t('ensure：非 git 工作区直接 not-a-repo', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'flow-integ-nogit-'))
  const res = await integration.ensure({ name: 'x', workspacePath: join(parent, 'nope'), config: {} }, { base: 'master' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not-a-repo')
})

await t('release：干净时解锁并删除，worktree list 里不留条目；没建过时幂等', async () => {
  const { repo, project } = makeRepo('rel')
  const res = await integration.ensure(project, { base: 'master' })
  const dir = integration.integDirFor(project)
  const rel = await integration.release(project, { base: 'master' })
  assert.equal(rel.ok, true, String(rel.message || ''))
  assert.equal(rel.removed, true)
  assert.equal(git.findWorktree(await git.listWorktrees(repo), dir), null)
  const again = await integration.release(project, { base: 'master' })
  assert.equal(again.ok, true)
  assert.equal(again.removed, false)
  void res
})

console.log('')
if (fails.length) { console.log(fails.length + ' 项失败'); process.exit(1) }
console.log('integration ok (' + pass + ' checks)')