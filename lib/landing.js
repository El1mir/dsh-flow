/**
 * dsh-flow · landing（RT-02 / ADR-0007 §2–§4、docs/远程事务设计.md §6.2–§6.5）
 *
 * 「怎么合」的执行层：dispatch.merge 只管列/mergeState 守卫、审核闸门、合并锁与工单；
 * 真正的落点在这里，按 authority 分两个适配器：
 *
 *   · authority='local'  —— 调用注入的 ctx.localMerge（dispatch 传 mergeLocked）。
 *     本地模式与子卡 branch 目标走这里；本文件**不重写 mergeLocked**，也不 import dispatch
 *     （否则 dispatch ↔ landing 成环，而且本地路径的行为会悄悄漂移）。
 *   · authority='remote' —— 远程模式下唯一允许碰 base 的路径：forge merge API 是唯一权威。
 *     合并成功后本地只做「快进 + 校验 + 记账」，失败一律 blocked，绝不本地兜底。
 *
 * 为什么 landing 不直接 import remote/git/integration/domain：
 *   这张票的核心风险是「顺序错了/多调了一次 merge API/失败后假装成功」，
 *   而这些都只能靠**日志序列**断言。全部依赖由 ctx 注入，landing 就能用 fake 单测钉死：
 *     ① mergePull 只许一次（GitHub 405 也可能表示已合并，所以先看 getPull().merged）；
 *     ② 合并路径永不 closePull（PR 的最终状态是 merged，不是 closed）；
 *     ③ 合并后 fetch → advanceBase → isAncestor → markMerged → postMergeCheck → review_approve；
 *     ④ 任何校验失败都不 markMerged / 不 review_approve；但「远程已合并」这一事实先落库，
 *        供下一次重入只重试本地同步（不重复调 merge API）。
 *
 * ctx（除票面列出的字段外，落地必需下列注入项）：
 *   {
 *     authority: 'local' | 'remote',
 *     strategy, by, overrideOutOfScope,
 *     project,                  // 需要 workspacePath / config.baseBranch / config.mergeStrategy / config.remote
 *     pr,                       // 本地 pull_requests 记录（要 headSha / branch / remote.number / remote.merged）
 *     localMerge: (task, ctx) => result,
 *     remote, git, integration, domain,
 *     detectOutOfScope: async (task, project) => ({ ok, files, scope }),  // 复用 dispatch 的现有实现
 *     postMergeCheck: async ({ task, project, base, dir, commit }) => ({ ok, ... }),
 *     timeoutMs,                // 单次 forge API 超时；必须远小于合并锁 TTL（10 分钟）
 *   }
 */

/** forge API 默认超时：合并锁 TTL 是 10 分钟，单次请求必须远小于它，否则锁续不上。 */
const DEFAULT_API_TIMEOUT_MS = 60 * 1000

const MERGE_METHODS = ['merge', 'squash', 'rebase']

/** 只有这三种结果允许带出「文件」：冲突（展示/注入）与越界（人处理）。 */
function done(fields) {
  return { files: [], ...fields }
}

/**
 * 给单次 forge 调用套上超时。
 *
 * 为什么必须自己套：lib/remote.js 的 fetchImpl 没有超时（RT-01 的范围），
 * 而合并事务持着 10 分钟的合并锁 —— 一个卡住的请求会把整条合并队列钉死。
 * 超时按 server 处理（dispatch 会重试 1 次），不按冲突处理（冲突要回派工人）。
 */
async function withTimeout(fn, ms, what) {
  if (!ms || ms <= 0) return await fn()
  let timer = null
  // 不 unref：这个定时器正是我们要等的那个事件；unref 会让事件循环空转而进程提前退出
  // （表现为顶层 await 永不 settled，而不是超时）。
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true, what }), ms)
  })
  try {
    const res = await Promise.race([Promise.resolve().then(fn), timeout])
    if (res && res.__timedOut) return { ok: false, reason: 'server', message: what + ' 超时（>' + ms + 'ms）' }
    return res
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function blocked(reason, message, extra = {}) {
  return done({ ok: false, state: 'blocked', blockedReason: reason, message, ...extra })
}

function baseOf(project) {
  const cfg = (project && project.config) || {}
  return cfg.baseBranch || null
}

function remoteCfgOf(project) {
  const cfg = (project && project.config) || {}
  return cfg.remote || {}
}

function remoteNameOf(project) {
  const cfg = (project && project.config) || {}
  return (cfg.remote && cfg.remote.name) || 'origin'
}

/** 合并方法：外部 PR 强制 merge（不改写别人的历史），其余按项目配置。 */
function mergeMethodOf(task, ctx, cfg) {
  if (task && (task.kind === 'external-pr' || (task.external && task.external.number))) return 'merge'
  const raw = ctx.strategy || (cfg && cfg.mergeStrategy) || 'merge'
  return MERGE_METHODS.includes(raw) ? raw : 'merge'
}

/** 外部 PR 卡：审批闸门读 external.approval（RT-00 的字段）。 */
function approvalOf(task) {
  const ext = (task && task.external) || null
  if (!ext) return null
  return ext.approval || {}
}

/** 把「远程已合并」写成 pr.remote 的事实；attachPullRemote 是整体替换，所以字段要全带。 */
function remoteInfoOf(pr, extra = {}) {
  const prev = (pr && pr.remote) || {}
  return {
    source: prev.source || 'github',
    number: Number(prev.number) || Number(extra.number) || null,
    url: extra.url || prev.url || null,
    state: extra.state || prev.state || 'open',
    merged: extra.merged === true,
    mergedAt: extra.mergedAt || prev.mergedAt || null,
    mergedBy: extra.mergedBy || prev.mergedBy || null,
    mergeCommitSha: extra.mergeCommitSha || prev.mergeCommitSha || null,
    author: extra.author || prev.author || null,
    headRepo: extra.headRepo || prev.headRepo || null,
    baseRef: extra.baseRef || prev.baseRef || null,
    headRef: extra.headRef || prev.headRef || null,
    mergeableState: extra.mergeableState || prev.mergeableState || null,
  }
}

/**
 * 冲突文件（只用于展示/注入，不用于实际落地）。
 *
 * forge 说冲突时本地未必有那条分支：受控 PR 的 flow/<taskId> 一般在；外部 PR 要先把
 * refs/pull/<n>/head 抓成 external/pr-<n>。拿不到就返回空数组 —— 冲突本身是 forge 的判定，
 * 不因为「我们算不出文件」而变成成功。
 */
async function conflictFilesOf(task, ctx, { base, number }) {
  const g = ctx.git
  if (!g || typeof g.dryRunMerge !== 'function') return []
  const project = ctx.project
  if (!project || !project.workspacePath) return []
  let dir = project.workspacePath
  try {
    if (ctx.integration && typeof ctx.integration.ensure === 'function') {
      const integ = await ctx.integration.ensure(project, { base }).catch(() => null)
      if (integ && integ.ok && integ.dir) dir = integ.dir
    }
    let source = (ctx.pr && ctx.pr.branch) || null
    if (!source && number && typeof g.fetchRef === 'function') {
      const fetched = await g.fetchRef({ repo: project.workspacePath, remote: remoteNameOf(project), source: 'refs/pull/' + number + '/head', dest: 'external/pr-' + number }).catch(() => null)
      if (fetched && fetched.ok) source = fetched.branch
    }
    if (!source) return []
    const dry = await g.dryRunMerge(dir, source).catch(() => null)
    return (dry && Array.isArray(dry.files) && dry.files) || []
  } catch {
    return []
  }
}

/** mergePull 失败 → {state, blockedReason, category, retryable}。认不出的不猜，一律 forge-error。 */
function classifyMergeFailure(m) {
  const reason = (m && m.reason) || 'unknown'
  const message = String((m && m.message) || '')
  const detail = { status: m && m.status, reason, message }
  if (reason === 'conflict') return { state: 'conflict', blockedReason: 'conflict', detail }
  if (reason === 'protected') return { state: 'blocked', blockedReason: 'merge-protected', category: 'approval', detail }
  if (reason === 'auth') return { state: 'blocked', blockedReason: 'auth', category: 'blocked', detail }
  if (reason === 'missing') return { state: 'blocked', blockedReason: 'pr-missing', category: 'blocked', detail }
  if (reason === 'head-moved') return { state: 'blocked', blockedReason: 'head-mismatch', category: 'blocked', detail }
  if (reason === 'not-merged') return { state: 'blocked', blockedReason: 'not-merged', category: 'blocked', detail }
  // server / unknown / 空 reason：可重试一次（dispatch 负责次数），但仍要工单 —— 不猜就是 blocked。
  return { state: 'blocked', blockedReason: 'forge-error', category: 'blocked', retryable: true, detail }
}

/** getPull 失败 → blocked reason。配置类问题不可重试（重试只是再拿一次同样的拒绝）。 */
function classifyPullFailure(pull) {
  const reason = String((pull && pull.reason) || 'unknown')
  const message = String((pull && pull.message) || reason)
  const detail = { reason, message, status: pull && pull.status }
  if (reason === 'auth') return blocked('auth', '读不到远程 PR（token/权限不足）：' + message, { category: 'blocked', detail })
  if (reason === 'missing') return blocked('pr-missing', '远程 PR 不存在（可能已删除）：' + message, { category: 'blocked', detail })
  if (/remote 未配置|unsupported provider/.test(reason)) {
    return blocked('no-remote-pr', '远程仓库没配好，不能走远程合并：' + message, { category: 'blocked', detail })
  }
  return blocked('forge-error', '读远程 PR 失败（' + reason + '）：' + message, { category: 'blocked', retryable: true, detail })
}

/**
 * 远程合并算法（spec §6.3–§6.4）。
 * 顺序是这张票的核心：任何一步都不能提前动本地 base，也不能在失败后回头本地合并。
 */
async function landRemote(task, ctx) {
  const { remote, git, integration, domain, project, pr } = ctx
  if (!remote || !git || !integration || !domain) {
    return blocked('not-injected', 'landing 缺少注入的 remote/git/integration/domain，无法远程合并')
  }
  if (!project || !project.workspacePath) return blocked('no-project', 'landing 缺少 project（拿不到 workspacePath）')
  const cfg = project.config || {}
  const base = baseOf(project) || (await git.defaultBranch(project.workspacePath).catch(() => null))
  if (!base) return blocked('no-base', '项目没有 base 分支（config.baseBranch 与 git 默认分支都拿不到）')

  // ① 外部 PR 的人工闸门：未批准不自动合（ADR-0007 §5）。这一步**必须在任何 forge 调用之前**。
  const approval = approvalOf(task)
  const isExternal = task.kind === 'external-pr' || !!(task.external && task.external.number)
  if (isExternal) {
    const status = (approval && approval.status) || 'pending'
    if (status !== 'approved') {
      return done({
        ok: false, state: 'needs-approval', blockedReason: status,
        message: status === 'pending'
          ? '外部 PR 还没批准：先让人看一遍 diff 再批（系统不替人批准）'
          : '外部 PR 的批准状态是 ' + status + '，不能合并',
        category: 'approval',
      })
    }
  }

  // ② 防御性审核断言：reviewGate 已在 dispatch.merge 做过，这里只防「绕过 merge() 直接调 land」。不猜。
  const verdict = (task.mergeRequest && task.mergeRequest.reviewVerdict) || null
  if (verdict !== 'approved' && ctx.by !== 'human') {
    return blocked('needs-review', '审核结论不是 approved（当前 ' + (verdict || '无') + '），不能合并；先按判据审核')
  }

  // ③ 本地 PR 与远程编号。没有远程 PR 就没有远程权威可言 —— 不本地兜底。
  if (!pr) return blocked('no-pr', '没有本地 PR 记录，先开 PR')
  const number = Number(pr.remote && pr.remote.number) || Number(task.external && task.external.number) || null
  if (!number) return blocked('no-remote-pr', '本地 PR 没有远程编号（远程模式必须先建远程 PR），不能远程合并')

  const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : DEFAULT_API_TIMEOUT_MS
  const remoteCfg = remoteCfgOf(project)

  // ④ 读远程最新事实：merged 必须**先于** mergePull 判断 ——
  //    GitHub 对已合并的 PR 再发 merge 会回 405，和「冲突」同一个状态码。
  const pull = await withTimeout(() => remote.getPull({ remote: remoteCfg, number }), timeoutMs, 'getPull')
  if (!pull || !pull.ok) return classifyPullFailure(pull)

  const alreadyRemote = (pr.remote && pr.remote.merged === true) || pull.merged === true
  const lockedHead = (isExternal && task.external && task.external.headSha) || pr.headSha || null
  let mergeCommitSha = pull.mergeCommitSha || null
  let mergeMethod = mergeMethodOf(task, ctx, cfg)
  let state = 'merged'

  if (!alreadyRemote) {
    // ⑤ head 对齐：验收/建卡之后又推了新提交就不合（本地与远程必须是同一个提交）。
    if (lockedHead && pull.headSha && String(pull.headSha) !== String(lockedHead)) {
      return blocked('head-mismatch', '远程 PR 的 head 变了（锁定 ' + String(lockedHead).slice(0, 8) + '，现在 ' + String(pull.headSha).slice(0, 8) + '）；确认新提交后再合', { detail: { locked: lockedHead, remote: pull.headSha } })
    }

    // ⑥ 越界检查（沿用 dispatch 的实现）：主检出里的脏文件落在阅读范围内 → 先拦下问人。
    if (cfg.outOfScopeCheck !== false && typeof ctx.detectOutOfScope === 'function') {
      const oos = await ctx.detectOutOfScope(task, project).catch(() => null)
      if (oos && oos.ok === false) {
        if (ctx.overrideOutOfScope !== true) {
          return done({
            ok: false, state: 'blocked', blockedReason: 'out-of-scope',
            files: oos.files || [],
            message: '主检出里有落在这张卡阅读范围内的未提交改动：' + (oos.files || []).slice(0, 5).join(', '),
            detail: { files: oos.files || [], scope: oos.scope || [] },
          })
        }
      }
    }

    // ⑦ forge merge —— 远程模式唯一允许写 base 的动作。
    const merge = await withTimeout(() => remote.mergePull({
      remote: remoteCfg,
      number,
      sha: lockedHead || pr.headSha || undefined,
      method: mergeMethod,
      commitTitle: ('flow: ' + task.id + ' — ' + (task.title || '')).slice(0, 200),
      commitMessage: 'PR #' + number + ' 由 dsh-flow 远程合并（landing/remote）',
    }), timeoutMs, 'mergePull')
    if (!merge || !merge.ok) {
      const cls = classifyMergeFailure(merge)
      if (cls.state === 'conflict') {
        const files = await conflictFilesOf(task, ctx, { base, number })
        return done({
          ok: false, state: 'conflict', blockedReason: 'conflict', files,
          message: 'forge 报告合并冲突：' + ((files || []).join(', ') || String((merge && merge.message) || 'conflict')),
          detail: cls.detail,
        })
      }
      return blocked(cls.blockedReason, 'forge 拒绝合并（' + cls.blockedReason + '）：' + String((merge && merge.message) || ''), {
        category: cls.category, retryable: cls.retryable, detail: cls.detail,
      })
    }
    mergeCommitSha = merge.mergeCommitSha || null
  } else {
    // ⑧ 重入：远程已合并，只重试本地同步，绝不再调 merge API。
    state = 'already'
    mergeCommitSha = mergeCommitSha || (pr.remote && pr.remote.mergeCommitSha) || null
  }

  // ⑨ 先把「远程已合并」落库 —— 后面任何一步失败，下一次重入都靠这条事实走「只同步」分支。
  const mergedInfo = remoteInfoOf(pr, {
    ...pull,
    state: 'merged',
    merged: true,
    mergeCommitSha,
  })
  await domain.attachPullRemote(pr.id, mergedInfo)
  const remoteOut = { number, url: mergedInfo.url, merged: true, mergeCommitSha }

  // ⑩ 本地快进 + 校验。
  const fetched = await git.fetchBranch({ repo: project.workspacePath, remote: remoteNameOf(project), branch: base }).catch(() => null)
  if (!fetched || !fetched.ok) {
    return blocked('base-sync-failed', '远程已合并，但本地 ' + base + ' 没能从远程拉取（' + String((fetched && fetched.reason) || 'fetch-failed') + '）；远程事实已记录，修好后重跑只重试同步', { detail: fetched, remote: remoteOut })
  }
  const advanced = await integration.advanceBase(project, { base, sha: fetched.sha }).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
  if (!advanced || advanced.ok === false) {
    return blocked('base-sync-failed', '远程已合并；本地 ' + base + ' 想快进到 ' + String(fetched.sha || '').slice(0, 8) + ' 但没成功（' + String((advanced && advanced.reason) || 'unknown') + '）；远程事实已记录，修好后重跑只重试同步', { detail: advanced, remote: remoteOut })
  }
  // isAncestor 校验：merge/rebase 后 head 应在 base 历史里；squash 会把提交压成一个新的
  // merge commit（head 不在 base 里是**正常**的），所以 squash 校验 forge 给的合并提交。
  const verifyTarget = mergeMethod === 'merge' || !mergeCommitSha ? (lockedHead || pr.headSha) : mergeCommitSha
  const inBase = await git.isAncestor(project.workspacePath, verifyTarget, base).catch(() => null)
  if (inBase !== true) {
    return blocked('merge-not-in-base', '远程已合并，但合并后校验失败：' + base + ' 不包含 ' + String(verifyTarget || '').slice(0, 8) + '；不标 done，等人核对', { detail: { target: verifyTarget, base, head: lockedHead }, remote: remoteOut })
  }

  // ⑪ 记账：commit 优先 forge 的 merge commit，没有就用 fetch 后 base 的 head（并写明来源）。
  const commit = mergeCommitSha || fetched.sha || (await git.revParse(project.workspacePath, base).catch(() => null))
  const commitSource = mergeCommitSha ? 'forge' : 'commit'
  const alreadyMarked = (task.mergeRequest && task.mergeRequest.status === 'merged') || pr.status === 'merged' || (task.mergeRequest && !!task.mergeRequest.mergedCommit)
  if (!alreadyMarked) {
    await domain.markMerged(task.id, { commit, strategy: mergeMethod, mergeCommit: mergeCommitSha || null })
  }

  // ⑫ 可选冒烟：失败只阻塞，不 undo（远程合并无法本地撤销），也不写 approved。
  if (typeof ctx.postMergeCheck === 'function') {
    const check = await ctx.postMergeCheck({ task, project, base, dir: null, commit }).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
    if (!check || check.ok === false) {
      return blocked('post-merge-check-failed', '远程已合并（commit ' + String(commit || '').slice(0, 8) + '），但合并后冒烟失败：' + String((check && (check.message || check.stderr)) || 'check failed').slice(0, 500), { detail: check, commit, remote: remoteOut })
    }
  }

  // ⑬ 收口：先写结论再迁移（顺序反了会出现「已 done 但没有 mergedCommit」的卡）。
  await domain.setReviewVerdict(task.id, 'approved', '远程已合并（PR #' + number + '）', [], { role: 'system', id: 'system:merge' })
  try {
    await domain.move(task.id, 'review_approve', { role: 'dispatcher', id: 'system' }, {})
  } catch (err) {
    return blocked('state-move-failed', '远程已合并，但本地状态迁移失败：' + String((err && err.message) || err), { commit, remote: remoteOut })
  }

  return done({
    ok: true, state, commit, commitSource, strategy: mergeMethod, base,
    message: '远程 PR #' + number + ' 已合并（commit 来源 ' + commitSource + '）',
    remote: remoteOut,
  })
}

/**
 * 落点入口。dispatch.merge 是唯一生产调用方；测试用 fake ctx 直接调。
 * @param {object} task 当前卡（调用方保证是 store 里的最新快照）
 * @param {object} ctx 见文件头
 */
export async function land(task, ctx = {}) {
  const authority = ctx.authority === 'remote' ? 'remote' : 'local'
  if (authority === 'local') {
    if (typeof ctx.localMerge !== 'function') {
      return blocked('no-local-merge', '本地合并适配器没有注入（ctx.localMerge），无法合并')
    }
    // 原样返回 mergeLocked 的结果：本地模式的行为一个字都不改（票 §不改什么）。
    return await ctx.localMerge(task, ctx)
  }
  return await landRemote(task, ctx)
}
