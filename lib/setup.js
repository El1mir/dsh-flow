/**
 * dsh-flow · setup
 *
 * 项目初始化时的「环境自检 + 配置补齐」。
 *
 * 为什么要有这一层：baseBranch 写死 'main' 在 master 仓库上会静默用错基线；
 * remote 没配则 issue 车道永远是哑的；recordIssues 关着则工位一个都不建。
 * 这些全是**能自动看出来**的东西，不该让人手填一遍再踩一遍。
 *
 * 分工：
 * - detectSetup(dir) 只读，把 git 与上游仓库的事实采回来；
 * - planSetup(current, detected) 是**纯函数**，事实 → 配置补丁，可单测；
 * - 真正落库在 index.js 的 setupProject()。
 */

import * as git from './git.js'
import { probeRepo } from './remote.js'

/** 从 remote URL 里解析 { host, kind, owner, repo, baseUrl }；解析不出来返回 null。 */
export function parseRemoteUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return null
  let host = ''
  let pathPart = ''
  // git@host:owner/repo.git  ── scp 风格
  const scp = raw.match(/^[A-Za-z0-9._-]+@([^:/]+):(.+)$/)
  if (scp) {
    host = scp[1]
    pathPart = scp[2]
  } else {
    const m = raw.match(/^[a-zA-Z]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/)
    if (m) {
      host = m[1]
      pathPart = m[2]
    }
  }
  if (!host || !pathPart) return null
  const clean = pathPart.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const seg = clean.split('/').filter(Boolean)
  if (seg.length < 2) return null
  const owner = seg[0]
  const repo = seg[seg.length - 1]
  const kind = host.toLowerCase().endsWith('github.com') ? 'github' : 'unknown'
  return {
    host,
    kind,
    owner,
    repo,
    baseUrl: kind === 'github' ? 'https://api.github.com' : null,
  }
}

/** 读 git remote，按名字去重（fetch 优先），解析成可用的远程候选。 */
export async function detectRemotes(dir) {
  const listed = await git.remotes(dir)
  const out = []
  const seen = new Set()
  for (const r of listed) {
    if (seen.has(r.name)) continue
    seen.add(r.name)
    const parsed = parseRemoteUrl(r.url)
    if (!parsed) continue
    out.push({ name: r.name, url: r.url, ...parsed })
  }
  // origin 排最前：约定俗成的默认远程，找 token/探上游都优先它。
  out.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0))
  return out
}

/**
 * 只读地采集一个工作区的全部环境事实。
 * 不抛异常：git 缺失、不是仓库、没有远程都是常态，全部落到返回值里。
 */
export async function detectSetup(dir) {
  const path = String(dir || '').trim()
  const detected = {
    dir: path,
    isRepo: false,
    hasCommits: false,
    git: null,
    branches: { current: null, default: null, all: [] },
    remotes: [],
    remote: null,
    upstream: null,
    notes: [],
  }
  if (!path) {
    detected.notes.push('工作区路径为空，跳过环境自检')
    return detected
  }
  detected.git = await git.gitAvailable()
  detected.isRepo = await git.isRepo(path)
  if (!detected.isRepo) {
    detected.notes.push('工作区不是 git 仓库：跳过分支、worktree 与合并配置')
    return detected
  }

  detected.hasCommits = await git.hasCommits(path)
  detected.branches.current = await git.currentBranch(path)
  if (detected.hasCommits) {
    detected.branches.default = await git.defaultBranch(path)
    detected.branches.all = await git.localBranches(path)
  } else {
    detected.notes.push('仓库还没有任何提交：先做一次基线提交，worktree 与合并才会恢复')
  }

  detected.remotes = await detectRemotes(path)
  detected.remote = detected.remotes[0] || null
  if (!detected.remote) {
    detected.notes.push('仓库没有可识别的远程地址：issue 车道会保持本地看板模式')
    return detected
  }
  if (detected.remote.kind === 'unknown') {
    detected.notes.push('远程主机 ' + detected.remote.host + ' 不是 GitHub：只记仓库坐标，不自动开 issue 同步')
    return detected
  }

  // 探一次上游：issue 开着才值得把 recordIssues 打开，否则同步永远拉回空列表。
  const probe = await probeRepo({ remote: detected.remote })
  detected.upstream = probe.ok
    ? { ok: true, hasIssues: probe.hasIssues === true, defaultBranch: probe.defaultBranch || null, private: probe.private === true }
    : { ok: false, reason: probe.reason || 'probe-failed' }
  if (detected.upstream.ok) {
    if (!detected.upstream.hasIssues) detected.notes.push('上游仓库没开 issue：保持本地看板模式')
    if (detected.upstream.defaultBranch) detected.branches.default = detected.upstream.defaultBranch
  } else {
    detected.notes.push('读不到上游仓库信息（' + detected.upstream.reason + '）：issue 同步先不自动打开')
  }
  return detected
}

/**
 * 事实 → 配置补丁。**纯函数**，不碰磁盘不碰网络，方便单测。
 *
 * 三条规矩：
 * 1. 只补「缺失」或「证明是错的」，不动人已经填对的值；
 * 2. 每条改动都配一句 notes，界面直接展示，不让人猜为什么变了；
 * 3. 拿不到证据就不猜（比如探测失败时不动 recordIssues）。
 */
export function planSetup(current = {}, detected = {}) {
  const patch = {}
  const notes = []
  const branches = (detected && detected.branches) || {}
  const all = Array.isArray(branches.all) ? branches.all : []

  // ---- 1) 基础分支：合并的落点，写错了整个合并步骤无处落地 ----
  if (detected && detected.isRepo && detected.hasCommits) {
    const want = String(current.baseBranch || '').trim()
    const usable = want && (all.length === 0 || all.includes(want))
    if (usable) {
      notes.push('基础分支 ' + want + ' 与仓库一致')
    } else if (branches.default) {
      patch.baseBranch = branches.default
      notes.push(want
        ? '基础分支 ' + want + ' 在仓库里不存在，改成 ' + branches.default
        : '基础分支设为 ' + branches.default)
    }
  }

  // ---- 2) 远程仓库坐标：issue 车道的入口 ----
  const found = detected && detected.remote
  if (found && found.kind !== 'unknown') {
    const cur = current.remote || null
    const sameRepo = cur && String(cur.owner || '').toLowerCase() === found.owner.toLowerCase() &&
      String(cur.repo || '').toLowerCase() === found.repo.toLowerCase()
    if (!sameRepo) {
      patch.remote = {
        kind: found.kind,
        baseUrl: (cur && cur.baseUrl) || found.baseUrl || null,
        owner: found.owner,
        repo: found.repo,
        token: (cur && cur.token) || null,
        useGhCli: found.kind === 'github',
      }
      notes.push('远程仓库设为 ' + found.owner + '/' + found.repo + '（来自远程 ' + found.name + '）')
    } else if (cur.kind !== found.kind || (!cur.baseUrl && found.baseUrl)) {
      patch.remote = { ...cur, kind: found.kind, baseUrl: cur.baseUrl || found.baseUrl || null }
      notes.push('远程仓库配置补齐：' + found.owner + '/' + found.repo)
    }
  }

  // ---- 3) issue 同步与自动化：只有证据齐全才打开 ----
  const willHaveRemote = patch.remote ? true : !!(current.remote && current.remote.owner && current.remote.repo)
  const upstream = detected && detected.upstream
  const issuesProven = !!(upstream && upstream.ok && upstream.hasIssues)
  if (willHaveRemote && issuesProven) {
    if (current.recordIssues !== true) {
      patch.recordIssues = true
      notes.push('已打开 issue 记录：上游开着 issue，任务会镜像成远程工单')
    }
    if (current.pushRemote !== true) {
      patch.pushRemote = true
      notes.push('已打开外推：本地建的卡会同步成远程 issue')
    }
    // autoDispatch 是 issue 车道的发动机：关着的话卡同步进来了也没人去认领。
    // 但 autoAccept / autoMerge 属于「交付质量由谁把关」的策略，风险不同——不替人决定。
    if (current.autoDispatch !== true && current.recordIssues !== true) {
      patch.autoDispatch = true
      notes.push('已打开自动派工：issue 车道的卡要有人认领才会真的开工')
    }
  } else if (willHaveRemote && upstream && upstream.ok) {
    // 探到了、但上游没开 issue：明确说「故意不动」，否则用户会以为自检漏了这条。
    notes.push('上游仓库没开 issue：保持本地看板模式，需要远程工单请先在仓库设置里打开 issue')
  } else if (willHaveRemote) {
    // 没探到就不能猜：猜着打开会让同步永远拉空列表，还会白建一套 issue 工位。
    const why = (upstream && upstream.reason) || '没有探测结果'
    notes.push('读不到上游仓库信息（' + why + '）：issue 开关保持不变，配好 token 后再点一次初始化')
  }
  return { patch, notes }
}
