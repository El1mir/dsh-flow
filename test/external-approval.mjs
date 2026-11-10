/**
 * RT-03：外部 PR 入站闸门 / 人工批准 / 自动车道入口（设计文档 §5.3、§8、ADR-0007 §5）。
 *
 * 钉住六件事：
 *   ① 入站闸门是 policyFor(project).canIngestPulls —— 远程模式关着时一个请求都不发；
 *   ② 人车道入站：merging/merge-ready、approval=pending、external 事实齐全、external-pr 工单带 refs/asks；
 *   ③ 自动路径：externalPr.autoMerge + autoMerge 才建 lane=issue 的卡；approval 仍 pending（RT-06 才写 approved）；
 *   ④ headSha 变了：approval 重置 pending + blocked/head-mismatch + 工单；
 *   ⑤ merged / closed：产 ended 事实，经 scheduler 交给 closeoutRemote（本票不自己收口）；
 *   ⑥ approveExternal 只写 approval + 审计事件，绝不合并。
 *
 * 全部用假 fetch，不联网；closeoutRemote 用假 dispatcher 记录调用。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createSyncEngine } from '../lib/sync-engine.js'
import { createScheduler } from '../lib/scheduler.js'
import { policyFor } from '../lib/remote-policy.js'
import { remoteThreadFor } from '../lib/sync.js'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-rt03-ext-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)

let pass = 0
const fails = []
async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ok ' + pass + ' - ' + name)
  } catch (err) {
    fails.push({ name, err })
    console.log('  FAIL - ' + name)
    console.log('    ' + String((err && err.message) || err).split(NL)[0])
  }
}

const REMOTE = { kind: 'github', owner: 'acme', repo: 'demo', token: 'tok', useGhCli: false }
const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
})

/**
 * 假网关。pulls 是 /pulls? 的原始行（listOpenPulls 的输入），
 * details 是 /pulls/<n> 的返回体（getPull 的输入）——两者形状不同，不能共用。
 */
function gateway({ pulls = [], details = {} } = {}) {
  const seen = []
  const impl = async (url, init = {}) => {
    const u = String(url)
    const method = init.method || 'GET'
    seen.push({ url: u, method })
    if (u.includes('/pulls?')) return jsonRes(pulls)
    const m = u.match(/\/pulls\/(\d+)(\?|$)|\/pulls\/(\d+)\/reviews/)
    const num = m ? Number(m[1] || m[3]) : null
    if (num && details[num]) {
      if (u.includes('/reviews')) return jsonRes([])
      return jsonRes(details[num])
    }
    if (u.includes('/issues/comments') && method === 'POST') return jsonRes({ id: 999, html_url: 'https://github.com/acme/demo/issues/1#issuecomment-999' }, 201)
    if (u.endsWith('/issues') && method === 'POST') return jsonRes({ number: 401, html_url: 'https://github.com/acme/demo/issues/401' }, 201)
    return jsonRes([])
  }
  return { impl, seen, details }
}

function row(number, extra = {}) {
  const { headBranch, headSha, baseBranch, author, createdAt, updatedAt, url, state, merged } = extra
  return {
    number,
    state: state || 'open',
    title: 'PR #' + number,
    html_url: url || ('https://github.com/acme/demo/pull/' + number),
    head: { ref: headBranch || ('feat/' + number), sha: headSha || ('sha' + number) },
    base: { ref: baseBranch || 'main', sha: 'basesha' },
    user: { login: author || 'octo' },
    created_at: createdAt || '2024-05-01T00:00:00Z',
    updated_at: updatedAt || '2024-05-02T00:00:00Z',
    ...(merged ? { merged: true } : {}),
  }
}

function detail(number, extra = {}) {
  const { headSha, headRepo, baseRef, mergeableState, author, state, merged, url } = extra
  return {
    number,
    state: state || 'open',
    merged: !!merged,
    merged_at: merged ? '2024-06-01T00:00:00Z' : null,
    merged_by: merged ? { login: 'maintainer' } : null,
    merge_commit_sha: merged ? 'merge-' + number : null,
    mergeable: true,
    mergeable_state: mergeableState || 'clean',
    head: { ref: 'feat/' + number, sha: headSha || ('sha' + number), repo: { full_name: headRepo || 'acme/demo' } },
    base: { ref: baseRef || 'main' },
    user: { login: author || 'octo' },
    html_url: url || ('https://github.com/acme/demo/pull/' + number),
  }
}

async function project(name, config = {}) {
  const p = await domain.ensureProject({ workspacePath: join(dir, 'repo-' + name), name })
  await domain.updateProjectConfig(p.id, {
    recordIssues: true,
    recordPulls: true,
    pushRemote: true,
    remoteMode: true,
    remote: REMOTE,
    ...config,
  }, { role: 'human' })
  return store.state.projects[p.id]
}

function engine(fetchImpl, extra = {}) {
  return createSyncEngine({ domain, store, log: () => {}, fetchImpl, ...extra })
}

const inboxOf = (taskId) => (store.state.human_inbox || []).filter((x) => x.taskId === taskId && x.status !== 'archived')

// ---------------------------------------------------------------------------
// ① 闸门：policyFor(...).canIngestPulls
// ---------------------------------------------------------------------------
await t('① 远程模式关（policy.canIngestPulls=false）：整段跳过且一个请求都不发', async () => {
  const p = await project('gate-off', { recordIssues: true, recordPulls: true, remoteMode: false })
  const pol = policyFor(store.state.projects[p.id])
  assert.equal(pol.canIngestPulls, false, '前置：remoteMode=false 时 policy 必须是 local')
  const gw = gateway({ pulls: [row(11)], details: { 11: detail(11) } })
  const res = await engine(gw.impl).ingestExternalPulls(store.state.projects[p.id])
  assert.equal(res.ok, true)
  assert.equal(res.created.length, 0)
  assert.equal(gw.seen.length, 0, '闸门关着却发了请求：' + JSON.stringify(gw.seen.map((x) => x.url)))
  assert.ok(res.skipped.some((x) => x.reason === 'ingest-pulls-off'), JSON.stringify(res.skipped))
  assert.equal(Object.values(store.state.tasks).filter((x) => x.projectId === p.id).length, 0)
})

// ---------------------------------------------------------------------------
// ② 人车道入站：卡 + external 事实 + approval pending + external-pr 工单
// ---------------------------------------------------------------------------
let humanCard = null
await t('② 人车道入站：merging/merge-ready、approval=pending、external 事实齐全、工单带 category/refs/asks', async () => {
  const p = await project('human')
  assert.equal(policyFor(store.state.projects[p.id]).canIngestPulls, true, '前置：远程模式要真的开着')
  const gw = gateway({ pulls: [row(42, { headBranch: 'feat/x', headSha: 'sha42', author: 'octo' })], details: { 42: detail(42, { headSha: 'sha42', headRepo: 'octo/demo', baseRef: 'main', mergeableState: 'clean', author: 'octo' }) } })
  const res = await engine(gw.impl).ingestExternalPulls(store.state.projects[p.id])
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors))
  assert.equal(res.created.length, 1, JSON.stringify(res.skipped))
  humanCard = store.state.tasks[res.created[0].taskId]

  assert.equal(humanCard.kind, 'external-pr')
  assert.equal(humanCard.lane, 'human', '默认人车道（ADR-0007 §5）')
  assert.equal(humanCard.visibility, 'board')
  assert.equal(humanCard.column, 'merging')
  assert.equal(humanCard.phase, 'merge-ready')
  assert.equal(humanCard.external.approval.status, 'pending', '入站时 approval 必须是 pending')
  assert.equal(humanCard.external.approval.at, null)
  assert.equal(humanCard.external.number, 42)
  assert.equal(humanCard.external.headSha, 'sha42')
  assert.equal(humanCard.external.state, 'open')
  assert.equal(humanCard.external.author, 'octo', 'author 要落盘（RT-01 getPull）')
  assert.equal(humanCard.external.headRepo, 'octo/demo', 'headRepo 要落盘（fork 判定用）')
  assert.equal(humanCard.external.baseRef, 'main')
  assert.equal(humanCard.external.mergeableState, 'clean')
  assert.equal(humanCard.external.origin, 'external-pr', '要记下这是外部 PR 入站来的')

  const pr = Object.values(store.state.pull_requests || {}).find((x) => x.taskId === humanCard.id)
  assert.ok(pr, '外部卡仍要有 pull_requests 快照')
  assert.equal(pr.remote.number, 42)
  assert.equal(pr.remote.author, 'octo')
  assert.equal(pr.remote.headRepo, 'octo/demo')
  assert.equal(pr.remote.baseRef, 'main')

  const cards = inboxOf(humanCard.id)
  const ticket = cards.find((x) => x.category === 'external-pr')
  assert.ok(ticket, '人车道要开 category=external-pr 的工单：' + JSON.stringify(cards.map((x) => x.category)))
  assert.equal(ticket.kind, 'decision')
  assert.match(ticket.topic, /外部 PR #42 是否合并/)
  assert.ok(Array.isArray(ticket.refs), 'refs 要落盘')
  const refKinds = ticket.refs.map((r) => r.kind)
  assert.deepEqual(refKinds.sort(), ['pull', 'task'], 'refs 至少要有卡与 PR：' + JSON.stringify(ticket.refs))
  const taskRef = ticket.refs.find((r) => r.kind === 'task')
  const pullRef = ticket.refs.find((r) => r.kind === 'pull')
  assert.equal(taskRef.id, humanCard.id)
  assert.equal(String(pullRef.id), '42')
  assert.match(pullRef.label, /PR #42/)
  assert.ok(pullRef.url && pullRef.url.includes('/pull/42'))
  const choice = (ticket.asks || []).find((a) => a.type === 'choice')
  assert.ok(choice, 'asks 里要有 approve/reject 选择题：' + JSON.stringify(ticket.asks))
  const values = choice.choices.map((c) => c.value).sort()
  assert.deepEqual(values, ['approve', 'reject'])
})

// ---------------------------------------------------------------------------
// ③ 自动路径：两个开关都开才建 lane=issue 的卡；approval 仍 pending
// ---------------------------------------------------------------------------
await t('③ 自动路径：externalPr.autoMerge + autoMerge → lane=issue / visibility=auto / approval 仍 pending', async () => {
  const p = await project('auto', { externalPr: { autoMerge: true }, autoMerge: true })
  const gw = gateway({
    pulls: [row(43, { headBranch: 'feat/auto', headSha: 'sha43' }), row(44, { headBranch: 'feat/human', headSha: 'sha44' })],
    details: { 43: detail(43, { headSha: 'sha43' }), 44: detail(44, { headSha: 'sha44' }) },
  })
  const res = await engine(gw.impl).ingestExternalPulls(store.state.projects[p.id])
  assert.equal(res.created.length, 2, JSON.stringify(res.errors))
  const auto = store.state.tasks[res.created[0].taskId]
  assert.equal(auto.lane, 'issue')
  assert.equal(auto.visibility, 'auto')
  assert.equal(auto.column, 'merging')
  assert.equal(auto.external.approval.status, 'pending', '自动卡也不能在入站时写 approved（RT-06 的活）')
  assert.equal(auto.external.autoCandidate, true, '要记下它是自动路径的候选：' + JSON.stringify(auto.external))
  assert.equal(inboxOf(auto.id).filter((x) => x.category === 'external-pr').length, 0, '自动卡入站时不开人工批准工单')
})

await t('③b 只有一个开关时不走自动路径（仍建人卡）', async () => {
  const p1 = await project('auto-off', { externalPr: { autoMerge: false }, autoMerge: true })
  const g1 = gateway({ pulls: [row(45)], details: { 45: detail(45) } })
  const r1 = await engine(g1.impl).ingestExternalPulls(store.state.projects[p1.id])
  assert.equal(store.state.tasks[r1.created[0].taskId].lane, 'human', 'externalPr.autoMerge=false 时必须是人卡')

  const p2 = await project('automerge-off', { externalPr: { autoMerge: true }, autoMerge: false })
  const g2 = gateway({ pulls: [row(46)], details: { 46: detail(46) } })
  const r2 = await engine(g2.impl).ingestExternalPulls(store.state.projects[p2.id])
  assert.equal(store.state.tasks[r2.created[0].taskId].lane, 'human', 'autoMerge=false 时必须是人卡')
})

// ---------------------------------------------------------------------------
// ④ headSha 变化：approval 重置 + blocked/head-mismatch + 工单
// ---------------------------------------------------------------------------
await t('④ headSha 变化：approval 重置 pending、approvalHandledAt 清空、mergeState=blocked(head-mismatch) 并开工单', async () => {
  const p = await project('headmove')
  const gw = gateway({ pulls: [row(51, { headSha: 'shaA' })], details: { 51: detail(51, { headSha: 'shaA' }) } })
  const eng = engine(gw.impl)
  const ing = await eng.ingestExternalPulls(store.state.projects[p.id])
  assert.equal(ing.created.length, 1, JSON.stringify(ing.errors))
  const taskId = ing.created[0].taskId
  // 人先批准过一轮（模拟 RT-06 还没实现时人已经点了 approve）
  await domain.approveExternal(taskId, { decision: 'approve', by: 'human:web' })
  assert.equal(store.state.tasks[taskId].external.approval.status, 'approved', '前置：已批准过')
  // 作者推了新提交
  gw.details[51] = detail(51, { headSha: 'shaB' })
  await domain.armProjectSync(p.id)
  await eng.runProject(store.state.projects[p.id], { force: true })

  const cur = store.state.tasks[taskId]
  assert.equal(cur.external.headSha, 'shaB', '新的 headSha 要落盘')
  assert.equal(cur.external.approval.status, 'pending', 'head 变了，旧批准必须作废')
  assert.equal(cur.external.approval.by, null)
  assert.equal(cur.external.approval.at, null)
  assert.equal(cur.external.approvalHandledAt, null)
  assert.equal(cur.mergeState, 'blocked', 'head 变了要挡住合并')
  assert.equal(cur.mergeReason, 'head-mismatch')
  const tickets = inboxOf(taskId)
  assert.ok(tickets.some((x) => /head/i.test(x.topic + x.problem + x.decisionNeeded)), '要开一条 head 变更的工单：' + JSON.stringify(tickets.map((x) => x.topic)))
  assert.ok(tickets.every((x) => ['approval', 'acceptance', 'external-pr', 'blocked', 'decision', 'info'].includes(x.category)), '工单 category 必须属于现行 taxonomy')
})

// ---------------------------------------------------------------------------
// ⑤ merged / closed：ended 事实 → scheduler → closeoutRemote
// ---------------------------------------------------------------------------
await t('⑤ merged / closed：refreshExternalPulls 产 ended 事实，scheduler 交给 closeoutRemote（本票不收口）', async () => {
  const p = await project('ended')
  const gw = gateway({ pulls: [row(81), row(82)], details: { 81: detail(81), 82: detail(82) } })
  const eng = engine(gw.impl)
  const ing = await eng.ingestExternalPulls(store.state.projects[p.id])
  assert.equal(ing.created.length, 2, JSON.stringify(ing.errors))
  await domain.armProjectSync(p.id)
  // 上游：81 被合了，82 被关了（未合并）
  gw.details[81] = detail(81, { state: 'closed', merged: true })
  gw.details[82] = detail(82, { state: 'closed', merged: false })

  const closedOut = []
  const dispatcher = {
    notifyDispatcher: async () => ({ ok: true }),
    closeoutRemote: async (facts) => { closedOut.push(facts); return { ok: true, merged: !!facts.merged } },
    dispatch: async () => ({ ok: true }),
    merge: async () => ({ ok: true }),
    openPr: async () => ({ ok: true }),
    requestReview: async () => ({ ok: true }),
    removeWorktree: async () => ({ ok: true }),
  }
  const sched = createScheduler({ domain, dispatcher, store, engine: eng, log: () => {} })
  const report = await sched.tick()

  const byNumber = Object.fromEntries(closedOut.map((f) => [Number(f.number), f]))
  assert.ok(byNumber[81], 'merged 的 PR 要交给 closeoutRemote：' + JSON.stringify(closedOut))
  assert.ok(byNumber[82], 'closed 的 PR 要交给 closeoutRemote：' + JSON.stringify(closedOut))
  assert.equal(byNumber[81].merged, true)
  assert.equal(byNumber[82].merged, false)
  assert.equal(byNumber[81].source, 'external')
  assert.ok((report.remoteEnded || []).length >= 2, 'report 里要能看见收口结果：' + JSON.stringify(report.remoteEnded))
  // 本票不自己改卡列：收口权在 RT-02/06
  const t81 = Object.values(store.state.tasks).find((x) => x.external && Number(x.external.number) === 81)
  assert.equal(t81.column, 'merging', '同步层不许自己推状态机')
})

// ---------------------------------------------------------------------------
// ⑥ approveExternal：只写 approval + 审计事件，绝不合并
// ---------------------------------------------------------------------------
await t('⑥ approveExternal 只写 approval + external.approved 事件；不合并、不动卡列', async () => {
  assert.ok(humanCard, '前置：② 建的人卡')
  const before = store.state.tasks[humanCard.id]
  const colBefore = before.column
  const prBefore = Object.values(store.state.pull_requests || {}).find((x) => x.taskId === humanCard.id)
  const prStateBefore = prBefore && prBefore.status
  const eventsBefore = (store.state.events || []).length

  await domain.approveExternal(humanCard.id, { decision: 'approve', by: 'human:web' })
  const cur = store.state.tasks[humanCard.id]
  assert.equal(cur.external.approval.status, 'approved')
  assert.equal(cur.external.approval.by, 'human:web')
  assert.ok(cur.external.approval.at, '要记下批准时间')
  assert.equal(cur.column, colBefore, '批准不是状态迁移（卡列不动）')
  const prAfter = Object.values(store.state.pull_requests || {}).find((x) => x.taskId === humanCard.id)
  assert.equal(prAfter.status, prStateBefore, '批准绝不能顺手合并')
  const newEvents = (store.state.events || []).slice(eventsBefore)
  assert.ok(newEvents.some((e) => e.type === 'external.approved'), '要有 external.approved 审计事件：' + JSON.stringify(newEvents.map((e) => e.type)))
  assert.ok(!newEvents.some((e) => e.type === 'pr.merged'), '本票不许合并')

  // 幂等：重复批准不改 at/by
  const at = cur.external.approval.at
  await domain.approveExternal(humanCard.id, { decision: 'approve', by: 'human:other' })
  assert.equal(store.state.tasks[humanCard.id].external.approval.at, at)
  // 已批准不能再改成拒绝（防止误点翻转）
  await assert.rejects(() => domain.approveExternal(humanCard.id, { decision: 'reject' }), /已处理/)
})

// ---------------------------------------------------------------------------
// ⑦ remoteThreadFor：受控 PR 与外部 PR 都返回 pr
// ---------------------------------------------------------------------------
await t('⑦ remoteThreadFor：受控 PR 与外部 PR 都发到 PR 会话', async () => {
  const p = await project('threads')
  const ctl = await domain.createTask(p.id, { title: '受控 PR' })
  const pr = await domain.openPullRequest(ctl.id, { headSha: 'sha-c', baseSha: 'b', branch: 'flow/' + ctl.id })
  await domain.attachPullRemote(pr.id, { number: 61, url: 'https://github.com/acme/demo/pull/61', state: 'open' })
  assert.deepEqual(remoteThreadFor(store.state.tasks[ctl.id]), { thread: 'pr', number: 61 })
  assert.deepEqual(remoteThreadFor(humanCard), { thread: 'pr', number: 42 })
})

console.log('')
if (fails.length) {
  console.log('FAIL external-approval ' + fails.length + ' / ' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ' :: ' + String((f.err && f.err.message) || f.err).split(NL)[0])
  process.exitCode = 1
} else {
  console.log('PASS external-approval ' + pass + '/' + pass)
}
rmSync(dir, { recursive: true, force: true })
