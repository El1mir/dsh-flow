/**
 * 集成检出（ADR-0004）。
 *
 * 为什么要它：合并原先跑在**人的检出**里，于是 `repo-dirty`（主仓库必须干净）和
 * `wrong-branch`（主仓库必须正好在 base 上）被写死成前置条件 —— 合并队列挂在了
 * 开发者本地状态上。人的检出脏了、切了分支，任务就合不进去。
 *
 * 设计上的两个硬约束（都是实测出来的，写在 ADR-0004 里）：
 *
 * 1. **必须是 detached，不能真实检出 base**。`git worktree add -B master <dir> master`
 *    在 master 已被主检出占用时会直接 fatal（`already used by worktree`）—— 而
 *    "主检出正在 base 上"才是常态。所以集成检出一律 `--detach`，代价是它自己 merge
 *    之后 base 指针不会自动前进，要我们显式推进（见 advanceBase）。
 * 2. **推进 base 不能只用 update-ref**。如果 base 正被某个检出占用，直接改 ref 会让那个
 *    检出的 HEAD 动了、文件没动，`git status` 立刻变成一片假的"已删除"。所以按"谁占着 base"
 *    选手段：没人占 → update-ref；主检出占着 → 在它里面 `merge --ff-only`（干净就前进，
 *    有冲突就**安全中止**，不覆盖任何未提交内容）。
 *
 * 另外它**不登记进 store.state.worktrees** —— 那是任务检出的表，会被 gcWorktrees 的
 * 7 天 TTL 收走；集成检出的生命周期跟项目走，不跟任务走。
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as git from './git.js'

export const INTEG_DIR_NAME = '__integ__'

/** 与任务检出同根，只是目录名固定 —— 不跟着 taskId 走，所以生命周期也不跟任务走。 */
export function integDirFor(project) {
  const ws = project.workspacePath
  const root = (project.config && project.config.worktreeRoot) || join(dirname(ws), '.flow-worktrees', basename(ws))
  return join(root, INTEG_DIR_NAME)
}

/**
 * 建或复用一个可用的集成检出。
 *
 * 复用前核对两件事：**仍是 detached**、**自己是干净的**。任一条不满足就报错而不是硬修
 * —— 集成检出里出现别的东西，说明有人手动动过它，静默 reset 会把现场抹掉。
 */
export async function ensure(project, { base } = {}) {
  const dir = integDirFor(project)
  const repo = project.workspacePath
  if (!(await git.isRepo(repo))) return { ok: false, reason: 'not-a-repo' }
  if (!base) return { ok: false, reason: 'base-missing' }
  if (!(await git.branchExists(repo, base))) return { ok: false, reason: 'base-missing', base }
  const baseSha = await git.revParse(repo, base)
  const listed = git.findWorktree(await git.listWorktrees(repo), dir)
  if (listed) {
    const cur = await git.currentBranch(dir).catch(() => null)
    if (cur) return { ok: false, reason: 'integ-not-detached', dir, branch: cur, base }
    const dirty = await git.dirtyFiles(dir).catch(() => [])
    if (dirty && dirty.length) return { ok: false, reason: 'integ-dirty', dir, files: dirty.slice(0, 20) }
    // 只补锁（可能上一版没锁，或者被 unlock 过）
    if (!listed.locked) await git.lockWorktree({ repo, dir, reason: 'flow integration' })
    // 对齐到 base 当前的位置：上一次合并之后 base 可能已经被别人推过。
    // 这里用 checkout --detach（不是 reset --hard）之外的更安全做法：只有落后时才动。
    const integHead = await git.headSha(dir)
    if (integHead !== baseSha) {
      const anc = await git.isAncestor(repo, integHead, baseSha)
      if (anc !== true) return { ok: false, reason: 'integ-diverged', dir, integHead, baseSha }
      const moved = await git.detachAt(dir, baseSha)
      if (!moved.ok) return { ok: false, reason: 'integ-realign-failed', dir, message: moved.stderr || '' }
    }
    return { ok: true, dir, base, baseSha, reused: true, locked: true }
  }
  // 目录存在但 git 不认识它（手工删了 .git / 上次崩溃的壳）→ 先清掉，否则 add 会
  // 报 `already exists`（实测：非空目录必失败，空目录才能成功）。
  if (existsSync(dir)) {
    const shell = await removeDir(dir)
    if (!shell.ok) return { ok: false, reason: 'integ-dir-stuck', dir, message: shell.message }
  }
  const made = await git.addDetachedWorktree({ repo, dir, base })
  if (!made.ok) return { ok: false, reason: made.reason || 'integ-add-failed', message: made.message || '' }
  const locked = await git.lockWorktree({ repo, dir, reason: 'flow integration' })
  if (!locked.ok) return { ok: false, reason: 'integ-lock-failed', dir, message: locked.stderr || '' }
  return { ok: true, dir, base, baseSha, created: true, locked: true }
}

/**
 * 把 base 推进到 `sha`。
 *
 * 分三种情况（实测结论，见 ADR-0004 §6）：
 * - base 没被任何检出占用 → `update-ref`，最干净。
 * - base 正被主检出占用 → 在主检出里 `merge --ff-only`：
 *   干净/只有无关脏文件 → 前进且保留那些文件；会被覆盖 → git **安全中止**，
 *   我们转成 `blocked / base-dirty-collide`，**不动任何人的文件**。
 * - base 被别的（非主）检出占用 → `blocked / base-busy`，让人自己处理。
 */
export async function advanceBase(project, { base, sha, dir: integDir } = {}) {
  const repo = project.workspacePath
  if (!base || !sha) return { ok: false, reason: 'bad-args' }
  const holder = await whoHolds(repo, base)
  if (!holder) {
    const r = await git.updateRef(repo, 'refs/heads/' + base, sha)
    return r.ok ? { ok: true, via: 'update-ref', base, sha } : { ok: false, reason: 'advance-failed', message: r.stderr || '' }
  }
  if (!git.samePath(holder.path, repo)) return { ok: false, reason: 'base-busy', holder: holder.path }
  // 主检出占着 base：在它里面快进。git 自己会拒绝覆盖未提交内容，这是我们要的安全网。
  const r = await git.mergeFastForward(repo, sha)
  if (!r.ok) {
    return { ok: false, reason: 'base-dirty-collide', message: r.stderr || '', detail: String(r.stderr || '').slice(0, 2000) }
  }
  // 复核：ref 真的到了 sha（ff 成功时 HEAD 与 ref 同步前进）
  const now = await git.revParse(repo, base)
  if (now !== sha) return { ok: false, reason: 'advance-mismatch', expected: sha, actual: now }
  return { ok: true, via: 'ff-only', base, sha }
}

/**
 * 谁把 base 检出在树里了？（返回 { path } 或 null）
 *
 * 比较必须按"同一目录"算，不能比字符串：`git worktree list` 回的是正斜杠路径，
 * 我们手里的是 node 给的（Windows 上反斜杠），直接 `!==` 会把**主检出自己**判成别人的检出。
 */
async function whoHolds(repo, base) {
  const list = await git.listWorktrees(repo)
  const hits = list.filter((w) => !w.bare && w.branch === base)
  return hits.length ? { path: hits[0].path, all: hits.map((h) => h.path) } : null
}


/**
 * 释放：解锁 + 删除。只在两次合并之间可以调；合并进行中由调用方先看锁。
 *
 * 有未提交改动就拒（不 force）：集成检出的脏东西通常意味着合并中途崩了，
 * 直接删会把那次合并的证据一起删掉。
 */
export async function release(project, { base } = {}) {
  const dir = integDirFor(project)
  const repo = project.workspacePath
  const listed = git.findWorktree(await git.listWorktrees(repo), dir)
  if (!listed) {
    if (existsSync(dir)) await removeDir(dir)
    await git.pruneWorktrees(repo).catch(() => null)
    return { ok: true, removed: false }
  }
  const dirty = await git.dirtyFiles(dir).catch(() => [])
  if (dirty && dirty.length) return { ok: false, reason: 'dirty', files: dirty.slice(0, 20) }
  // 先解锁再删：locked 时 remove 会被拒（实测，单 --force 也拒）
  await git.unlockWorktree({ repo, dir })
  const res = await git.removeWorktree({ repo, dir })
  return { ok: res.ok, removed: res.ok, dir, message: res.ok ? null : (res.stderr || 'remove failed') }
}

/** 只读状态，给 UI / 对账用。 */
export async function status(project, { base } = {}) {
  const dir = integDirFor(project)
  const repo = project.workspacePath
  if (!(await git.isRepo(repo))) return { exists: false, reason: 'not-a-repo', dir }
  const listed = git.findWorktree(await git.listWorktrees(repo), dir)
  if (!listed) return { exists: false, dir, base }
  const branch = await git.currentBranch(dir).catch(() => null)
  const head = await git.headSha(dir).catch(() => null)
  const dirty = await git.dirtyFiles(dir).catch(() => [])
  const baseSha = base ? await git.revParse(repo, base) : null
  return {
    exists: true, dir, base, baseSha, head, detached: !branch, branch,
    clean: !dirty.length, dirty: dirty.slice(0, 20),
    locked: !!listed.locked, lockReason: listed.lockReason || null,
  }
}

/** 删除目录树（只用于"git 已经不认它"的壳）；失败返回原因，不抛。 */
async function removeDir(dir) {
  const { rm } = await import('node:fs/promises')
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err) }
  }
}