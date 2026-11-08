/**
 * dsh-flow · git
 *
 * worktree 与合并的落地（设计文档 14.6 / 14.7 / 15.4 TX-13、TX-16、TX-17）。
 * 约定：项目仓库就是“共享仓库”，每个任务在它下面开一个 worktree；
 * 合并发生在项目仓库里（worker 分支 → base 分支），冲突则整体 abort 并把
 * 冲突文件清单交回调度者。
 *
 * 所有函数都返回 { ok, ... }，不抛异常：git 缺失、不是仓库、冲突都是常态。
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, normalize } from 'node:path'

const MAX_BUFFER = 4 * 1024 * 1024

function run(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      })
    })
  })
}

/**
 * 与 run 相同，但**不 trim 输出**。
 *
 * `run` 会 trim：`status --porcelain` 的第一行可能是 ` M README.md`（未暂存的修改），
 * 开头的空格被吃掉就变成 `M README.md`，按固定列切状态码会切掉首字母（实测：README.md 变 EADME.md）。
 * 任何按列解析 git 输出的地方都必须用这个。
 */
function runRaw(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** git 在不在（不在就整条 worktree 链路降级）。 */
export async function gitAvailable() {
  const r = await run(process.cwd(), ['--version'])
  return r.ok ? r.stdout : null
}

/**
 * 两个路径是否指向同一个目录。
 *
 * 为什么不用 `===`：`git worktree list` 回正斜杠路径、node 拼出来的是反斜杠；Windows 上
 * 临时目录还可能给 8.3 短名（`C:\\Users\\ADMINI~1\\...`）而 git 给长名。任何一处不同，
 * `entry.path === dir` 就永远不成立 —— 调用方会"看不见"自己刚建的检出，然后重复添加或
 * 误判成"别的检出占着分支"。
 */
export function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => {
    let q = normalize(String(p))
    try { q = realpathSync.native(q) } catch { /* 不存在就按原样比 */ }
    q = normalize(q)
    return process.platform === 'win32' ? q.toLowerCase() : q
  }
  return norm(a) === norm(b)
}

/** 在 worktree 列表里按目录找一条（路径按目录等价比较，不比字符串）。 */
export function findWorktree(list, dir) {
  return (list || []).find((w) => samePath(w.path, dir)) || null
}

export async function isRepo(dir) {
  if (!dir || !existsSync(dir)) return false
  const r = await run(dir, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout === 'true'
}

export async function currentBranch(dir) {
  const r = await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!r.ok) return null
  // detached 时 git 不报错，而是把 'HEAD' 当分支名回给你。
  // 把它当分支用会在三处出事（ADR-0004 / ADR-0006）：集成检出被误判成"还在某个分支上"、
  // mergeBranch 的 wrong-branch 检查把 'HEAD' 当成"人切到了别的分支"、pushBranch 去推 'HEAD'。
  // detached 就是"没有当前分支"，如实返回 null。
  return r.stdout === 'HEAD' ? null : r.stdout
}

export async function headSha(dir) {
  const r = await run(dir, ['rev-parse', 'HEAD'])
  return r.ok ? r.stdout : null
}

export async function branchExists(dir, branch) {
  const r = await run(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])
  return r.ok
}

/** 列出全部本地分支名（合并的落点必须真实存在，猜出来的名字会把整个合并步骤打空）。 */
export async function localBranches(dir) {
  const r = await run(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!r.ok || !r.stdout) return []
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** 列出远程并解析（同一远程会同时给 fetch/push 两行，用 forceUpdate 之外的 url 就是同一行，这里原样返回）。 */
export async function remotes(dir) {
  const r = await run(dir, ['remote', '-v'])
  if (!r.ok || !r.stdout) return []
  const out = []
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (!m) continue
    out.push({ name: m[1], url: m[2], direction: m[3] })
  }
  return out
}

export async function defaultBranch(dir) {
  const head = await run(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.stdout) return head.stdout.replace(/^origin\//, '')
  for (const guess of ['main', 'master']) {
    if (await branchExists(dir, guess)) return guess
  }
  const cur = await currentBranch(dir)
  if (cur) return cur
  // 一次提交都没有的仓库（unborn HEAD）：rev-parse --abbrev-ref HEAD 会失败，
  // 但 symbolic-ref 仍然能说出分支名（git init 出来的 master/main）。
  // 少了这一步就会返回猜出来的 'main'，与真实分支对不上，建 worktree 必然失败。
  const symbolic = await run(dir, ['symbolic-ref', '--short', 'HEAD'])
  if (symbolic.ok && symbolic.stdout) return symbolic.stdout
  return 'main'
}

export async function listWorktrees(repo) {
  const r = await run(repo, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const out = []
  let cur = null
  for (const line of r.stdout.split(/\r?\n/)) {
    // git 一律回正斜杠路径，而调用方手里的是 node 拼的（Windows 上是反斜杠）。
    // 不归一的话 `entry.path === dir` 永远不成立 —— ensure 会"看不见"自己刚建的检出，
    // 然后再去 add 一次（实测：这是集成检出复用失败、release 找不到目录的根因）。
    if (line.startsWith('worktree ')) { cur = { path: normalize(line.slice(9)), branch: null, head: null, bare: false }; out.push(cur); continue }
    if (!cur) continue
    if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '')
    if (line === 'bare') cur.bare = true
    if (line === 'detached') cur.detached = true
    // v0.002（ADR-0006）：locked / prunable 是行内标志，后面可能跟一句 reason。
    // 它们是"这个检出能不能被删"的机器可读信号 —— lock 是唯一挡 prune/remove 的机制，
    // 所以对账必须看见它，不能只靠目录在不在。
    if (line.startsWith('locked')) { cur.locked = true; cur.lockReason = line.slice(6).trim() }
    if (line.startsWith('prunable')) { cur.prunable = true; cur.prunableReason = line.slice(8).trim() }
  }
  return out
}

/** 仓库里有没有提交（unborn HEAD 时为 false）。worktree 必须有基线提交才建得出来。 */
export async function hasCommits(dir) {
  if (!dir || !existsSync(dir)) return false
  const r = await run(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return r.ok && !!r.stdout
}

/** 建（或重建）一个任务 worktree：git worktree add -B <branch> <dir> <base>。 */
export async function addWorktree({ repo, dir, branch, base }) {
  if (!(await isRepo(repo))) return { ok: false, reason: 'not-a-repo: ' + repo }
  // worktree 共享对象库，没有提交就没有可检出的内容：git 只会回一句
  // "fatal: invalid reference: HEAD"，看不出是缺基线。这里提前说清楚。
  if (!(await hasCommits(repo))) {
    return {
      ok: false,
      reason: 'no-commits',
      message: '工作区是 git 仓库，但一次提交都没有——没有基线就开不出 worktree',
      hint: '先在工作区里做一次基线提交（git add -A && git commit -m baseline），之后任务会自动恢复 worktree 与合并流程',
    }
  }
  const baseRef = base || (await defaultBranch(repo))
  const existing = findWorktree(await listWorktrees(repo), dir)
  if (existing) {
    await run(repo, ['worktree', 'remove', '--force', dir])
    await run(repo, ['worktree', 'prune'])
  }
  const r = await run(repo, ['worktree', 'add', '-B', branch, dir, baseRef])
  if (!r.ok) {
    // 降级：base 不存在时用当前 HEAD
    const fallback = await run(repo, ['worktree', 'add', '-B', branch, dir, 'HEAD'])
    if (!fallback.ok) return { ok: false, reason: fallback.stderr || r.stderr, base: baseRef }
    return { ok: true, path: dir, branch, base: 'HEAD', degraded: true }
  }
  const sha = await headSha(dir)
  return { ok: true, path: dir, branch, base: baseRef, headSha: sha }
}

/** 给检出上锁：之后 prune / 单 --force 都删不动它（实测 remove --force 会被拒）。 */
/** 在已有检出里切到某个 sha 的 detached 状态（只用于集成检出对齐 base）。 */
export async function detachAt(dir, sha) {
  const r = await run(dir, ['checkout', '--detach', '--force', sha])
  return { ok: r.ok, stderr: r.stderr }
}

/** 建一个 detached 检出（不占用任何分支）。ADR-0004：集成检出必须用这个。 */
export async function addDetachedWorktree({ repo, dir, base }) {
  const r = await run(repo, ['worktree', 'add', '--detach', dir, base])
  if (!r.ok) return { ok: false, reason: 'integ-add-failed', message: r.stderr || r.stdout }
  return { ok: true, path: dir, headSha: await headSha(dir) }
}

/** 直接改 ref（底层）。只在 base 没有被任何检出占用时安全 —— 调用方负责判断。 */
export async function updateRef(dir, ref, sha) {
  const r = await run(dir, ['update-ref', ref, sha])
  return { ok: r.ok, stderr: r.stderr }
}

/** 在检出里快进（git 自己会拒绝覆盖未提交内容，这是我们要的安全网）。 */
export async function mergeFastForward(dir, sha) {
  const r = await run(dir, ['merge', '--ff-only', sha])
  return { ok: r.ok, stderr: r.stderr, stdout: r.stdout }
}

export async function lockWorktree({ repo, dir, reason = 'flow' }) {
  const r = await run(repo, ['worktree', 'lock', '--reason', String(reason).slice(0, 200), '--', dir])
  return { ok: r.ok, stderr: r.stderr }
}

/** 解锁。目录已经不在时也能 unlock（实测），所以对账清理可以无条件先解锁。 */
export async function unlockWorktree({ repo, dir }) {
  const r = await run(repo, ['worktree', 'unlock', dir])
  return { ok: r.ok, stderr: r.stderr }
}

export async function removeWorktree({ repo, dir }) {
  const r = await run(repo, ['worktree', 'remove', '--force', dir])
  await run(repo, ['worktree', 'prune'])
  return { ok: r.ok, stderr: r.stderr }
}

/**
 * v1.29：把主仓库里被 .gitignore 的开发依赖目录「链」进 worktree。
 *
 * 事故：.venv（2.7GB）与 node_modules（778MB）被 .gitignore 忽略，
 * git worktree add 不会带过去，于是每个 worktree 都是裸 checkout ——
 * worker 报「环境里没有 pytest」，其实主仓库好好的，只是那份环境不在它的目录里。
 *
 * 为什么是 junction 不是复制：2.7GB × 每任务 = 不可接受；软链在 Windows 还要管理员权限，
 * junction 不需要、且实测 vitest 与 python 都能正常解析。
 *
 * 为什么安全：实测 `git worktree remove --force` 与 rm -rf 都**不会**跟着 junction 删到目标，
 * 主仓库依赖目录内容安然无恙。
 *
 * @param {object} opts { repo, worktree, dirs }  dirs 是相对路径数组
 * @returns {{ linked: string[], skipped: string[], failed: {dir,reason}[] }}
 */
export async function linkSharedDirs({ repo, worktree, dirs = [] } = {}) {
  const out = { linked: [], skipped: [], failed: [] }
  if (!repo || !worktree) return out
  const { existsSync, symlinkSync, mkdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  for (const rel of dirs) {
    const from = join(repo, rel)
    const to = join(worktree, rel)
    try {
      if (!existsSync(from)) { out.skipped.push(rel); continue }   // 主仓库没有就跳过，不报错
      if (existsSync(to)) { out.skipped.push(rel); continue }      // 已经有了（重装过/已链）就跳过
      mkdirSync(dirname(to), { recursive: true })
      symlinkSync(from, to, 'junction')
      out.linked.push(rel)
    } catch (err) {
      // 非 NTFS / 权限不足 / 目标已存在：一律降级为「不链」，让派工继续。
      out.failed.push({ dir: rel, reason: String((err && err.message) || err) })
    }
  }
  return out
}

/**
 * 删 worktree 之前先把 junction 断掉（双保险）。
 *
 * 实测 git worktree remove 不会跟着 junction 删目标，但「依赖主仓库做到这一点」
 * 是有风险的假设：万一哪天 git 或文件系统行为变了，代价是主仓库 2.7GB 环境被清空。
 * 自己先断链，最坏情况只是少删一个空目录。
 */
export async function unlinkSharedDirs({ worktree, dirs = [] } = {}) {
  const out = { unlinked: [], failed: [] }
  if (!worktree) return out
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  for (const rel of dirs) {
    const target = join(worktree, rel)
    try {
      // lstat 看的是链接本身（不跟随），所以能区分「junction」与「worker 自己装的真目录」
      const st = fs.lstatSync(target)
      if (!st.isSymbolicLink()) continue   // 真目录不动它
      fs.unlinkSync(target)
      out.unlinked.push(rel)
    } catch {
      // 不存在 / 删不掉：无所谓，git worktree remove 会兜底
    }
  }
  return out
}

export async function pruneWorktrees(repo) {
  const r = await run(repo, ['worktree', 'prune'])
  return { ok: r.ok, stderr: r.stderr }
}

/** 在 worktree 里提交全部改动。没有改动返回 ok:true, changed:false。 */
export async function commitAll({ dir, message }) {
  await run(dir, ['add', '-A'])
  const status = await run(dir, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, reason: status.stderr }
  if (!status.stdout) return { ok: true, changed: false, headSha: await headSha(dir) }
  const msg = String(message || 'flow: worker commit').slice(0, 2000)
  const r = await run(dir, ['commit', '-m', msg])
  if (!r.ok) return { ok: false, reason: r.stderr || r.stdout, changed: false }
  return { ok: true, changed: true, headSha: await headSha(dir), output: r.stdout }
}

export async function pushBranch({ dir, remote = 'origin', branch }) {
  const target = branch || (await currentBranch(dir))
  if (!target) return { ok: false, reason: 'no-branch' }
  const r = await run(dir, ['push', '-u', remote, target])
  return { ok: r.ok, branch: target, remote, reason: r.ok ? null : (r.stderr || r.stdout) }
}

export async function changedFiles(repo, from, to = 'HEAD') {
  const r = await run(repo, ['diff', '--name-only', from, to])
  return r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : []
}

/**
 * v1.28：工作区里**未提交**的改动（git status --porcelain）。
 *
 * 和 changedFiles 的区别很重要：changedFiles(repo, from, to) 比的是两个提交之间的差异，
 * 传错参数会静默返回空数组 —— 线上 T-035 明明有 8 个未提交文件，检测却报告 0 个。
 * 这里只回答"工作区脏不脏"，是验收后漂移检测的正确工具。
 */
  /**
   * v1.33：这条分支相对 base 还有多少个提交没合进去？
   *
   * 用途是判断「代码到底进 master 了没有」—— 状态修复离不开这个事实。
   * 拿不到（分支不存在、base 不存在、不是仓库）一律返回 null，
   * 让调用方走保守分支，而不是把 null 当成 0（那会误判成"已经合了"）。
   */
  export async function countUnmerged(dir, base, branch) {
    const r = await run(dir, ['rev-list', '--count', base + '..' + branch])
    if (!r.ok) return null
    const n = Number(String(r.stdout || '').trim())
    return Number.isFinite(n) ? n : null
  }

  /** v1.33：解析任意 ref 到完整 SHA（拿不到返回 null）。 */
  export async function revParse(dir, ref) {
    const r = await run(dir, ['rev-parse', ref])
    if (!r.ok) return null
    const sha = String(r.stdout || '').trim()
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null
  }

/**
 * v1.35：ancestor 是否已包含在 descendant 的历史里（合并后校验 / 崩溃对账用）。
 * 返回 true / false；git 出错（ref 不存在等）返回 null，调用方不能把 null 当 false。
 */
export async function isAncestor(dir, ancestor, descendant) {
  if (!ancestor || !descendant) return null
  const r = await run(dir, ['merge-base', '--is-ancestor', String(ancestor), String(descendant)])
  if (r.ok) return true
  return r.code === 1 ? false : null
}

export async function dirtyFiles(dir) {
  const r = await run(dir, ['status', '--porcelain'])
  if (!r.ok) return []
  return r.stdout.split(/\r?\n/).filter(Boolean)
}

/**
 * `dirtyFiles` 的裸路径版（给"按路径比对"的调用方用，比如越界检查）。
 *
 * `status --porcelain` 的行是 `XY <path>`，直接拿整行和路径比永远不相等
 * —— 这个坑很安静：越界检查会一直判"没越界"，看起来像功能写好了。
 * 重命名/复制的行是 `R  old -> new`，两边都算（旧路径也是这次动过的）。
 */
export async function dirtyFilePaths(dir) {
  const r = await runRaw(dir, ['status', '--porcelain'])
  if (!r.ok) return []
  const out = []
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue
    // 前两列是状态码 + 空格；带引号的路径（含空格/中文）去掉引号
    let rest = line.slice(3)
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1)
    const arrow = rest.indexOf(' -> ')
    if (arrow >= 0) {
      out.push(rest.slice(0, arrow), rest.slice(arrow + 4))
    } else {
      out.push(rest)
    }
  }
  return out.filter(Boolean)
}

export async function diffStat(repo, from, to = 'HEAD') {
  const r = await run(repo, ['diff', '--numstat', from, to])
  if (!r.ok) return { files: 0, additions: 0, deletions: 0 }
  let files = 0, additions = 0, deletions = 0
  for (const line of r.stdout.split(/\r?\n/)) {
    const [a, d] = line.split('\t')
    if (a === undefined) continue
    files += 1
    additions += Number(a) || 0
    deletions += Number(d) || 0
  }
  return { files, additions, deletions }
}

async function unmerged(repo) {
  const r = await run(repo, ['diff', '--name-only', '--diff-filter=U'])
  return r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : []
}

/**
 * 合并 worker 分支到 base（合并事务的 git 部分）。
 * strategy: merge（--no-ff）| squash | rebase（先 rebase 再 ff）
 * 返回 { ok, conflict, files, commit, reason }
 */
export async function mergeBranch({ repo, branch, base, strategy = 'merge', message }) {
  if (!(await isRepo(repo))) return { ok: false, reason: 'not-a-repo' }
  const target = base || (await currentBranch(repo))
  const dirty = await run(repo, ['status', '--porcelain', '--untracked-files=no'])
  if (!dirty.ok) return { ok: false, reason: dirty.stderr }
  if (dirty.stdout) return { ok: false, reason: 'repo-dirty', detail: dirty.stdout.split(/\r?\n/).slice(0, 10) }
  if (!(await branchExists(repo, branch))) return { ok: false, reason: 'no-branch: ' + branch }
  // v1.35：git merge 合进的是**当前检出的分支**，不是 base 参数。
  // 主工作区检出的不是 base（人切到了别的分支干活）时，原来会把任务分支合进那个分支，
  // 事后才被合并后校验拦下 —— 那时错误的合并提交已经在人的分支上了。
  // 这里先拒，不替人切分支（切分支会动人的工作区）。
  const checkedOut = await currentBranch(repo)
  if (base && checkedOut && checkedOut !== base) {
    return { ok: false, reason: 'wrong-branch: 主工作区当前检出 ' + checkedOut + '，不是合并目标 ' + base + '；请先切回 ' + base + ' 再合并' }
  }
  const msg = String(message || ('flow: merge ' + branch))

  if (strategy === 'squash') {
    const sq = await run(repo, ['merge', '--squash', branch])
    if (!sq.ok) {
      const files = await unmerged(repo)
      await run(repo, ['reset', '--hard', 'HEAD'])
      return { ok: false, conflict: files.length > 0, files, reason: sq.stderr || sq.stdout }
    }
    const commit = await run(repo, ['commit', '-m', msg])
    if (!commit.ok) {
      await run(repo, ['reset', '--hard', 'HEAD'])
      return { ok: false, reason: commit.stderr || commit.stdout }
    }
    return { ok: true, strategy, base: target, commit: await headSha(repo) }
  }

  if (strategy === 'rebase') {
    // v1.36：方向原来反了 —— 原来在当前分支上执行 `git rebase <任务分支>`，
    // 那等于把 base 的提交逐个重放到任务分支上（改的是 base 的历史），
    // 而设计写的是「把任务分支 rebase 到 base，再 fast-forward base」。
    // 现在：切到任务分支 → rebase 到 base → 切回 base → ff-only 合并。
    // 全程无冲突才算成功；任何一步失败都恢复检出 base，不把人留在半路上。
    const before = await headSha(repo)
    const co = await run(repo, ['checkout', '-q', branch])
    if (!co.ok) return { ok: false, reason: co.stderr || co.stdout }
    const rb = await run(repo, ['rebase', target])
    if (!rb.ok) {
      const files = await unmerged(repo)
      await run(repo, ['rebase', '--abort'])
      await run(repo, ['checkout', '-q', target])
      return { ok: false, conflict: true, files, reason: rb.stderr || rb.stdout }
    }
    const back = await run(repo, ['checkout', '-q', target])
    if (!back.ok) return { ok: false, reason: 'rebase 完成但切回 ' + target + ' 失败：' + (back.stderr || back.stdout) }
    const ff = await run(repo, ['merge', '--ff-only', branch])
    if (!ff.ok) {
      await run(repo, ['merge', '--abort'])
      return { ok: false, reason: 'ff-only 合并失败：' + (ff.stderr || ff.stdout) }
    }
    const after = await headSha(repo)
    return {
      ok: true,
      strategy: 'rebase',
      base: target,
      commit: after,
      branchHead: await revParse(repo, branch),
      mergeCommit: null,
      alreadyMerged: before === after,
    }
  }

  const before = await headSha(repo)
  const m = await run(repo, ['merge', '--no-ff', '-m', msg, branch])
  if (!m.ok) {
    const files = await unmerged(repo)
    await run(repo, ['merge', '--abort'])
    return { ok: false, conflict: files.length > 0, files, reason: m.stderr || m.stdout }
  }
  const after = await headSha(repo)
  // v1.33：区分「真的合并出了新提交」和「分支早已全部合入」。
  //
  // 原来一律返回 headSha(repo)。两种情况记成同一个值，后果很具体：
  //   T-036 的分支 94943e5 早已在 master 里，再 flow_pr_merge 时
  //   git 回 "Already up to date"、不产生任何新提交，
  //   而我们把这个 master HEAD 记成了它的 mergedCommit ——
  //   那个提交其实是**别的任务（T-044）的合并提交** a713b12。
  //
  // 现在：up-to-date 时显式标记 alreadyMerged，并把 commit 记成**这条分支自己的头**，
  // 那才是这张卡真正贡献的东西。
  const branchHead = await revParse(repo, branch)
  const alreadyMerged = before === after
  return {
    ok: true,
    strategy: 'merge',
    base: target,
    commit: alreadyMerged ? (branchHead || after) : after,
    branchHead,
    mergeCommit: alreadyMerged ? null : after,
    alreadyMerged,
  }
}

/**
 * 在**指定检出**里把一条分支合进该检出当前的位置（ADR-0004 修订后的落点）。
 *
 * 与 mergeBranch 的分工：mergeBranch 是"合进当前分支"，要人先把主检出切到 base；
 * 这个函数不关心分支，只关心**这个检出的 HEAD**，所以能在集成检出（detached）里跑，
 * 也能在 base 正被 worker 的分支占用时跑 —— 那正是当年 rebase 策略 `checkout` 撞死的场景。
 *
 * 调用方负责两件事：这个检出是干净的 detached（ensure 已校验），以及合并完成后推进 base。
 */
export async function mergeInto({ dir, branch, strategy = 'merge', message }) {
  if (!(await isRepo(dir))) return { ok: false, reason: 'not-a-repo' }
  if (!(await branchExists(dir, branch))) return { ok: false, reason: 'no-branch: ' + branch }
  const dirty = await run(dir, ['status', '--porcelain', '--untracked-files=no'])
  if (!dirty.ok) return { ok: false, reason: dirty.stderr }
  if (dirty.stdout) return { ok: false, reason: 'worktree-dirty', detail: dirty.stdout.split(/\r?\n/).slice(0, 10) }
  const cur = await currentBranch(dir)
  if (cur) return { ok: false, reason: 'not-detached: 检出停在 ' + cur + '，合并会落到那个分支上' }
  const msg = String(message || ('flow: merge ' + branch))
  const before = await headSha(dir)

  if (strategy === 'squash') {
    const sq = await run(dir, ['merge', '--squash', branch])
    if (!sq.ok) {
      const files = await unmerged(dir)
      await run(dir, ['reset', '--hard', before])
      return { ok: false, conflict: files.length > 0, files, reason: sq.stderr || sq.stdout }
    }
    const commit = await run(dir, ['commit', '-m', msg])
    if (!commit.ok) {
      await run(dir, ['reset', '--hard', before])
      return { ok: false, reason: commit.stderr || commit.stdout }
    }
    const after = await headSha(dir)
    return { ok: true, strategy: 'squash', commit: after, branchHead: await revParse(dir, branch), mergeCommit: after, alreadyMerged: before === after }
  }

  // rebase 策略（ADR-0004 §4）：不再 checkout 任务分支自己 rebase ——
  // 那条分支正被 worker 的检出持有，checkout 必然 fatal（实测）。
  // 改成"只接受快进"：ff 得动就说明分支已经在 base 之上，是 rebase 想达到的状态；
  // ff 得不动就说明分支落后了，得让 worker 先把它 rebase 到 base（softMerge）再来。
  if (strategy === 'rebase') {
    const ff = await run(dir, ['merge', '--ff-only', branch])
    if (!ff.ok) {
      const files = await unmerged(dir)
      await run(dir, ['merge', '--abort'])
      await run(dir, ['reset', '--hard', before])
      return { ok: false, reason: 'needs-rebase', needle: 'ff-only', files, detail: (ff.stderr || ff.stdout || '').slice(0, 2000) }
    }
    const after = await headSha(dir)
    return { ok: true, strategy: 'rebase', commit: after, branchHead: await revParse(dir, branch), mergeCommit: null, alreadyMerged: before === after, fastForwarded: true }
  }

  const m = await run(dir, ['merge', '--no-ff', '-m', msg, branch])
  if (!m.ok) {
    const files = await unmerged(dir)
    await run(dir, ['merge', '--abort'])
    return { ok: false, conflict: files.length > 0, files, reason: m.stderr || m.stdout }
  }
  const after = await headSha(dir)
  const branchHead = await revParse(dir, branch)
  // 与 mergeBranch 同样的区分：up-to-date 时 commit 记成分支自己的头，
  // 否则会把"别的任务的合并提交"当成这张卡的贡献（v1.33 踩过）。
  const alreadyMerged = before === after
  return { ok: true, strategy: 'merge', commit: alreadyMerged ? (branchHead || after) : after, branchHead, mergeCommit: alreadyMerged ? null : after, alreadyMerged }
}

/** 软合并：把 base 的新提交 rebase 进 worker 的 worktree；冲突返回文件清单。 */
export async function rebaseWorktree({ dir, onto }) {
  const dirty = await run(dir, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.ok && dirty.stdout) return { ok: false, reason: 'worktree-dirty', detail: dirty.stdout.split(/\r?\n/).slice(0, 10) }
  const r = await run(dir, ['rebase', onto])
  if (!r.ok) {
    const files = await unmerged(dir)
    await run(dir, ['rebase', '--abort'])
    return { ok: false, conflict: files.length > 0, files, reason: r.stderr || r.stdout }
  }
  return { ok: true, headSha: await headSha(dir) }
}

/** worktree list 的原始 porcelain 文本（对账要原样，不要归一化过的版本）。 */
export async function porcelainWorktrees(repo) {
  const r = await run(repo, ['worktree', 'list', '--porcelain'])
  return r.ok ? r.stdout : ''
}

/** 给调度者的冲突包：冲突文件 + base 新提交 + 改动统计。 */
export async function conflictPackage({ repo, branch, base }) {
  const files = await unmerged(repo)
  const log = await run(repo, ['log', '--oneline', (base || 'HEAD') + '..' + branch])
  const stat = await diffStat(repo, base || 'HEAD', branch)
  return { files, commits: log.ok ? log.stdout.split(/\r?\n/).filter(Boolean) : [], stat }
}

/**
 * 读提交清单（v1.22，为「commit 也同步到 issue」服务）。
 *
 * 只要 `<from>..<to>` 之间的提交，输出已经裁成同步用的形状（sha 短号 + 首行 + 作者 + 时间），
 * 不把整份 git log 抛给调用方 —— 这个列表最终会出现在 GitHub 的评论里，越长越没人看。
 */
export async function log({ dir, from = null, to = 'HEAD', limit = 20 } = {}) {
  const range = from ? String(from) + '..' + String(to) : String(to)
  const r = await run(dir, ['log', '--pretty=format:%H%x1f%s%x1f%an%x1f%aI', '-n', String(limit), range])
  if (!r.ok) return { ok: false, reason: r.stderr || r.stdout, commits: [] }
  const commits = String(r.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, at] = line.split('\x1f')
      return { sha: sha || '', short: String(sha || '').slice(0, 8), subject: subject || '', author: author || '', at: at || null }
    })
  return { ok: true, commits }
}

export const _run = run
export const _join = join
