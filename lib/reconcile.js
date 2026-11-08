/**
 * 检出对账（ADR-0006 / I-06）。**纯只读**：不 repair、不 prune、不删任何东西。
 *
 * 为什么要有它：现在"谁说了算"根本说不清 —— 同一台机器上 git 报 6 条 worktree、
 * flow.json.worktrees 只登记 1 条、磁盘上却有 8 个目录，三方各说各话。
 * 没有零副作用的观察者，任何清理动作都是盲动：你删掉的那个目录可能是别人正在跑的工的检出。
 *
 * 分类（六类）：
 *   in-sync      git 有、登记有、目录在  —— 正常
 *   external     git 有、登记无           —— 别人的检出（含 __integ__、手工建的），**只报告不动**
 *   ghost        登记有、目录无           —— 目录被删了但记录还在
 *   orphan-dir   目录在、git 无条目        —— Windows 上删除失败留下的空壳（T-002 / T-036 形态）
 *   stale-record 登记有、git 无、目录也无  —— 纯记录残留
 *   branch-busy  同一个分支被两个检出占用  —— 这种情况 git 自己也不允许长期存在，但历史遗留会有
 *
 * 所有动作留给 I-08（删除路径重写）与 I-10（四时点对账）。这里只回答"现在是什么状况"。
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as git from './git.js'

export const RECONCILE_KINDS = ['in-sync', 'external', 'ghost', 'orphan-dir', 'stale-record', 'branch-busy']

/**
 * 解析 `git worktree list --porcelain`。
 *
 * 按**每行的第一个词**分派，不按列位置切：porcelain 是"面向机器但格式会变"的接口，
 * `locked` / `prunable` 是行内标志且可能各带一句 reason，位置切开迟早错。
 */
export function parsePorcelain(out) {
  const list = []
  let cur = null
  for (const raw of String(out || '').split(/\r?\n/)) {
    if (!raw) continue
    const line = raw
    const verb = line.split(' ')[0]
    if (verb === 'worktree') {
      cur = { path: line.slice('worktree '.length), branch: null, head: null, bare: false, detached: false, locked: false, lockReason: null, prunable: false, prunableReason: null }
      list.push(cur)
      continue
    }
    if (!cur) continue
    if (verb === 'HEAD') cur.head = line.slice('HEAD '.length)
    else if (verb === 'branch') cur.branch = line.slice('branch '.length).replace('refs/heads/', '')
    else if (verb === 'bare') cur.bare = true
    else if (verb === 'detached') cur.detached = true
    else if (verb === 'locked') { cur.locked = true; cur.lockReason = line.slice('locked'.length).trim() || null }
    else if (verb === 'prunable') { cur.prunable = true; cur.prunableReason = line.slice('prunable'.length).trim() || null }
  }
  return list
}

/**
 * 三方比对。返回分类结果，**不产生任何副作用**。
 *
 * 入参 deliberately 只收 project + 一个"登记表"（store.state.worktrees 的形状），
 * 不收整个 store：让这个函数能在测试里手搓输入，也能在 tick 之外的地方单独调。
 */
export async function reconcile(project, registry = {}) {
  const repo = project && project.workspacePath
  const started = Date.now()
  if (!repo || !(await git.isRepo(repo))) {
    return { ok: false, reason: 'not-a-repo', entries: [], counts: {}, durationMs: Date.now() - started }
  }
  // 直接调 porcelain 而不是 git.listWorktrees：后者为其他地方做了路径归一化（normalize），
  // 而这里的判断要拿**原样**的 git 视角跟磁盘比，归一化会掩盖"同一目录的两个写法"这种真实差异。
  const raw = await git.porcelainWorktrees(repo)
  const gits = parsePorcelain(raw)
  const byPath = new Map()
  for (const w of gits) if (w.path) byPath.set(normalizeKey(w.path), w)

  // 登记表：以 taskId 为键（store.state.worktrees 就是这个形状）
  const reg = new Map()
  for (const [taskId, rec] of Object.entries(registry || {})) {
    if (!rec || !rec.path) continue
    reg.set(normalizeKey(rec.path), { taskId, ...rec })
  }

  const entries = []
  const seenGit = new Set()
  const seenReg = new Set()

  // ① git 有：in-sync 或 external
  const mainKey = normalizeKey(repo)
  for (const w of gits) {
    if (!w.path || w.bare) continue
    // 主检出是 git 的第一条，但它不是"我们管的检出" —— 把它算进 external 会让每次对账都
    // 报一条假的"没人登记的检出"，人对账报的信任就没了。
    if (normalizeKey(w.path) === mainKey) continue
    const key = normalizeKey(w.path)
    seenGit.add(key)
    const hit = reg.get(key)
    const onDisk = existsSync(w.path)
    if (hit) {
      seenReg.add(key)
      entries.push({
        kind: 'in-sync',
        taskId: hit.taskId,
        path: w.path,
        branch: w.branch || null,
        head: w.head || null,
        detached: !!w.detached,
        locked: !!w.locked,
        lockReason: w.lockReason || null,
        onDisk,
        state: hit.state || null,
      })
      continue
    }
    // 我们的集成检出登记在 git 里但不在 worktrees 表（ADR-0004：它的生命周期跟项目走）
    const isInteg = basename(w.path) === '__integ__' || /[/\\]__integ__$/.test(w.path)
    entries.push({
      kind: 'external',
      taskId: null,
      role: isInteg ? 'integration' : guessTaskId(w.path),
      path: w.path,
      branch: w.branch || null,
      head: w.head || null,
      detached: !!w.detached,
      locked: !!w.locked,
      lockReason: w.lockReason || null,
      prunable: !!w.prunable,
      onDisk,
    })
  }

  // ② 登记有、git 无：ghost（目录在）或 stale-record（目录也没）
  for (const [key, rec] of reg) {
    if (seenReg.has(key)) continue
    const onDisk = existsSync(rec.path)
    entries.push({
      kind: onDisk ? 'ghost' : 'stale-record',
      taskId: rec.taskId,
      path: rec.path,
      branch: rec.branch || null,
      head: rec.headSha || rec.baseSha || null,
      onDisk,
      state: rec.state || null,
    })
  }

  // ③ 磁盘上有、git 与登记都没有：orphan-dir
  // 扫的是 checked-out 的根目录，不是整个磁盘：只有 <parent>/.flow-worktrees/<repo>/* 归我们管。
  const root = worktreeRootOf(project)
  for (const dir of await listDirs(root)) {
    // 以 . 开头的是我们的管理目录（.quarantine 回收站），不是检出 —— 把它们算成 orphan-dir
    // 会让人以为有 3 个待清理的检出，实际那些是已经隔离好的现场。
    if (dir.startsWith('.')) continue
    const key = normalizeKey(join(root, dir))
    if (seenGit.has(key) || reg.has(key)) continue
    entries.push({ kind: 'orphan-dir', taskId: dir, path: join(root, dir), onDisk: true })
  }

  // ④ 同一个分支被多条检出占用
  const byBranch = new Map()
  for (const e of entries) {
    if (!e.branch) continue
    if (!byBranch.has(e.branch)) byBranch.set(e.branch, [])
    byBranch.get(e.branch).push(e)
  }
  for (const [branch, group] of byBranch) {
    if (group.length < 2) continue
    for (const e of group) {
      entries.push({ ...e, kind: 'branch-busy', branch, others: group.filter((x) => x !== e).map((x) => x.path) })
    }
  }

  const counts = {}
  for (const k of RECONCILE_KINDS) counts[k] = 0
  for (const e of entries) counts[e.kind] = (counts[e.kind] || 0) + 1

  return { ok: true, entries, counts, durationMs: Date.now() - started }
}

/** 只列直接子目录（不递归）。读不到就当空 —— 对账不该因为目录不存在而抛。 */
async function listDirs(root) {
  const { readdir } = await import('node:fs/promises')
  try {
    const items = await readdir(root, { withFileTypes: true })
    return items.filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

/** 与 lib/dispatch.js 的 worktreePathFor 同一套规则（不 import，避免循环依赖）。 */
function worktreeRootOf(project) {
  const cfg = (project && project.config) || {}
  const ws = project.workspacePath
  return cfg.worktreeRoot || join(dirnameSafe(ws), '.flow-worktrees', basename(ws))
}

function dirnameSafe(p) {
  const s = String(p || '').replace(/[/\\]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i > 0 ? s.slice(0, i) : s
}

/**
 * 路径等价键。
 *
 * 只做斜杠归一和小写是不够的：git 回的是正斜杠**长名** `C:/Users/Administrator/...`，
 * node 从 tmpdir 拼出来的是反斜杠**短名** `C:\Users\ADMINI~1\...`。两者指同一个目录，
 * 但键不同 —— 对账会把同一个检出同时判成 in-sync 和 ghost，于是凭空多出一条 branch-busy。
 * 所以存在性优先：能 realpath 就 realpath（这一步顺带把短名展开成长名）。
 */
export function normalizeKey(p) {
  let q = String(p || '')
  try { q = realpathSync.native(q) } catch { /* 不存在（ghost / stale-record）就按原样 */ }
  q = q.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? q.toLowerCase() : q
}

/** 从 <root>/<taskId> 的目录名里猜 taskId（T-003 这种）。猜不出就 null。 */
function guessTaskId(p) {
  const name = basename(String(p || ''))
  return /^[A-Za-z]+-\w+$/.test(name) ? name : null
}