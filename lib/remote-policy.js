/**
 * dsh-flow · remote-policy（RT-00 / ADR-0007 §1、docs/远程事务设计.md §3）
 *
 * 唯一「是否出网 / 能不能用远程 PR / 能不能自动合外部 PR」的判定。
 * 这里的约束不是风格问题：以前 recordIssues / recordPulls / pushRemote / remote.enabled
 * 四个开关散落在不同调用点各自解读，语义已经漂移；从 schema 17 起所有读侧只能问 policyFor。
 *
 * 为什么必须是纯函数、零 import：
 *   domain.js 要 import 它做 remoteMode 守卫，sync/dispatch 也要读它；
 *   一旦它反过来 import domain/sync/remote 就成环。能力探测（canMergePull）由调用方
 *   从 remoteCapabilities 传进来，而不是自己发请求。
 *
 * 判定是「四项缺一不可」：
 *   remoteMode === true && remote.kind/owner/repo 完整 && provider 支持 forge merge && pushRemote === true
 * 任一不满足都返回 local，并用一个唯一的 reason 指明卡在哪一项（设置页据此提示）。
 * 注意：mode='local' 不是错误 —— 本地模式是默认形态，只是不出网、不开远程 PR。
 */

/**
 * @param {object|null} project 项目（读 project.config）
 * @param {{canMergePull?: boolean}} [opts] 调用方从 remoteCapabilities 传入；
 *   未传时按 provider 推断（gitea 在 RT-01 验证 merge API 前一律 false）。
 */
export function policyFor(project, opts = {}) {
  const cfg = project?.config || {}
  const remote = cfg.remote || {}
  const kind = remote.kind || 'github'
  const hasCoords = !!(remote.owner && remote.repo)
  const mergeSupported = opts.canMergePull !== undefined
    ? !!opts.canMergePull
    : kind === 'github'          // gitea 在 RT-01 验证前一律 false
  const pushRemote = cfg.pushRemote === true
  const remoteMode = cfg.remoteMode === true
  const remoteReady = remoteMode && hasCoords && mergeSupported && pushRemote
  const mode = remoteReady ? 'remote' : 'local'
  let reason = null
  if (!remoteMode) reason = 'remote-mode-off'
  else if (!hasCoords) reason = 'missing-remote'
  else if (!mergeSupported) reason = 'merge-unsupported'
  else if (!pushRemote) reason = 'push-remote-off'
  const recordIssues = cfg.recordIssues === true
  const recordPulls = cfg.recordPulls === true
  const autoMerge = cfg.autoMerge === true
  const externalAuto = cfg.externalPr?.autoMerge === true
  return {
    mode,
    reason,
    remoteMode,
    remoteReady,
    hasCoords,
    mergeSupported,
    // 下面每个 can* 都是「远程模式 + 对应单项开关」的交集：
    // 单项开关本身（recordIssues 等）不能单独把任何一个能力打开。
    canPushIssues: mode === 'remote' && recordIssues && pushRemote,
    canIngestIssues: mode === 'remote' && recordIssues,
    canIngestPulls: mode === 'remote' && recordPulls,
    canUseRemotePr: mode === 'remote' && pushRemote,
    canAutoMergeExternal: mode === 'remote' && externalAuto && autoMerge,
    canAcceptAutomatically: cfg.autoAccept === true,
  }
}
