/**
 * 状态一致性扫描器。
 *
 * 判断标准只有一条：**状态字段必须有物理事实能证明它为真**。
 * 没有证明的状态就是许愿 —— 而许愿的系统会安静地骗人（v1.32 事故）。
 *
 * 用法：
 *   node test/scan-state-lies.mjs                     扫真实 flow.json
 *   node test/scan-state-lies.mjs <path/to/flow.json>  扫指定文件
 *   作为模块：scanLies(state) -> [{ taskId, why }]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 扫描一个 state 对象，返回所有「状态与事实不符」的条目。 */
export function scanLies(state) {
  const lies = []
  const tasks = state.tasks || {}
  const prs = state.pull_requests || {}

  for (const t of Object.values(tasks)) {
    if (!t || !t.id) continue
    const mr = t.mergeRequest || {}
    const merged = mr.mergedCommit || mr.mergeCommit

    // ① phase=merged 但拿不出合并提交 → v1.32 事故（T-036/T-042/T-044）
    if (t.phase === 'merged' && !merged) {
      lies.push({ taskId: t.id, why: 'phase=merged 但没有 mergedCommit（合并从未发生）' })
    }

    // ② merge request 说已合并，卡片却停在"还没走到终态、也不在合并列"的地方
    //
    // merging 列是**合法过渡窗口**：markMerged 先记提交，紧接着 review_approve 才把卡推走。
    // 中间那一瞬 mr.status 已经是 merged，而卡片还在 merging —— 这是对的，不是谎话。
    // 真正有问题的是：mr 说合并完了，卡却退回到 running / verifying 这种更早的列。
    if (mr.status === 'merged' && t.column !== 'done' && t.column !== 'cancelled' && t.column !== 'merging') {
      lies.push({ taskId: t.id, why: 'mergeRequest.status=merged 但卡片在 ' + t.column })
    }

    // ③ 还没进合并列就有了审核结论 → 顺序错了
    if ((t.column === 'verifying' || t.column === 'running') && mr.reviewVerdict) {
      lies.push({ taskId: t.id, why: '还在 ' + t.column + ' 就有审核结论，顺序不对' })
    }

    // ④ 在 merging 列却标 phase=merged
    if (t.column === 'merging' && t.phase === 'merged') {
      lies.push({ taskId: t.id, why: '在 merging 列却标 phase=merged' })
    }
  }

  for (const pr of Object.values(prs)) {
    if (!pr || !pr.taskId) continue
    if (!tasks[pr.taskId]) continue
    // ⑤ PR 表说已合并却没有合并提交
    if (pr.status === 'merged' && !pr.mergedCommit) {
      lies.push({ taskId: pr.taskId, why: 'PR ' + pr.id + ' status=merged 但没有 mergedCommit' })
    }
  }

  return lies
}


// ---- 作为脚本直接跑 ---------------------------------------------------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scan-state-lies.mjs')
if (isDirect) {
  const file = process.argv[2] || join(homedir(), '.dsh', 'flow', 'flow.json')
  let state = null
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error('读不到 ' + file + ': ' + (e && e.message))
    process.exit(2)
  }
  const lies = scanLies(state)
  if (!lies.length) {
    console.log('状态一致：没有发现「状态与事实不符」的条目')
  } else {
    console.log('发现 ' + lies.length + ' 条状态与事实不符：')
    for (const l of lies) console.log('  · ' + l.taskId + '  ' + l.why)
    process.exitCode = 1
  }
}
