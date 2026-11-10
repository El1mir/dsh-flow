/**
 * RT-06：外部 PR 自动审核 / 自动合并。
 *
 * 缝：createScheduler().tick 的公开行为。reviewExternal 是可注入的只读审核入口
 * （生产 dispatch 没有同步结论 API，本票不改 dispatch.js）。调度不改作者分支、
 * 不直接 git merge。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createScheduler } from '../lib/scheduler.js'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-rt06-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)
const merges = []
const reviews = []
const handoffs = []
const closeouts = []
let reviewResult = { verdict: 'approved' }

const dispatcher = {
  async dispatch() { return { ok: true } },
  async merge(task) { merges.push(task.id); return { ok: true, commit: 'abc1234' } },
  async reviewExternal(task) { reviews.push({ id: task.id, sha: task.external && task.external.headSha }); return reviewResult },
  async requestReview(task) { handoffs.push(task.id); return { ok: true } },
  async closeoutRemote(fact) { closeouts.push(fact); return { ok: true, closed: true } },
}
const sched = createScheduler({ domain, dispatcher, store, log() {} })

const REMOTE = {
  remoteMode: true,
  pushRemote: true,
  recordIssues: true,
  recordPulls: true,
  remote: { kind: 'github', owner: 'acme', repo: 'flow' },
}

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ok  ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  FAIL ' + name + NL + '       ' + (err && err.stack || err)) }
}

async function project(name, extra = {}) {
  const p = await domain.ensureProject({ name, workspacePath: join(dir, name) })
  await domain.updateProjectConfig(p.id, { ...REMOTE, autoDispatch: false, ...extra }, { role: 'human' })
  return store.state.projects[p.id]
}

async function prompt(projectId, name = '不改无关模块') {
  return domain.upsertReviewPrompt(projectId, { name, prompt: 'diff 不得改调度核心', severity: 'block' }, { role: 'human' })
}

async function externalCard(p, number, extra = {}) {
  const task = await domain.createExternalPrTask(p.id, {
    provider: 'github',
    number,
    title: '外部 PR #' + number,
    headBranch: 'feat/' + number,
    baseBranch: 'main',
    headSha: extra.headSha || 'aaaa111',
    url: 'https://github.com/acme/flow/pull/' + number,
    author: 'someone',
  }, { lane: extra.lane || 'issue', actor: { role: 'system', id: 'test' } })
  if (extra.headSha) {
    await store.tx((s) => { s.tasks[task.id].external.headSha = extra.headSha })
  }
  return store.state.tasks[task.id]
}

const inboxFor = (taskId) => (store.state.human_inbox || []).filter((x) => x.taskId === taskId && x.status === 'open')

await t('开关任一关闭：不审核、不合并', async () => {
  merges.length = 0; reviews.length = 0
  reviewResult = { verdict: 'approved' }
  const p = await project('ext-off', { autoMerge: true, externalPr: { autoMerge: false } })
  await prompt(p.id)
  const task = await externalCard(p, 31, { lane: 'human' })
  await sched.tick()
  assert.equal(reviews.length, 0)
  assert.equal(merges.length, 0)
  assert.notEqual(store.state.tasks[task.id].external.approval.status, 'approved')
  assert.notEqual(store.state.tasks[task.id].column, 'done')
})

await t('两开关开 + 审核通过：approval=system:auto-pr，merge 只一次', async () => {
  merges.length = 0; reviews.length = 0
  reviewResult = { verdict: 'approved' }
  const p = await project('ext-ok', { autoMerge: true, externalPr: { autoMerge: true } })
  await prompt(p.id)
  const task = await externalCard(p, 32)
  assert.equal(task.lane, 'issue')
  await sched.tick()
  const after = store.state.tasks[task.id]
  assert.equal(after.external.approval.status, 'approved')
  assert.equal(after.external.approval.by, 'system:auto-pr')
  assert.equal(merges.length, 1)
  assert.equal(reviews.length, 1)
  await sched.tick()
  assert.equal(merges.length, 1, '同一 head 不能再 merge')
  assert.equal(reviews.length, 1, '同一 head 不能再审核')
})

await t('没有 review prompts：blocked/no-review-prompts，不调 merge', async () => {
  merges.length = 0; reviews.length = 0
  reviewResult = { verdict: 'approved' }
  const p = await project('ext-noprompt', { autoMerge: true, externalPr: { autoMerge: true } })
  await store.tx((s) => {
    for (const [id, prompt] of Object.entries(s.review_prompts || {})) {
      if (prompt && prompt.projectId === p.id) delete s.review_prompts[id]
    }
  })
  const task = await externalCard(p, 33)
  await sched.tick()
  const after = store.state.tasks[task.id]
  assert.equal(after.mergeState, 'blocked')
  assert.equal(after.mergeReason, 'no-review-prompts')
  assert.equal(merges.length, 0)
  assert.equal(reviews.length, 0, '没有判据不能盲合，也不该先问 reviewer')
  assert.ok(inboxFor(task.id).length >= 1)
  await sched.tick()
  assert.equal(merges.length, 0)
})

await t('review needs_work：blocked/external-review-rejected + 工单，不 merge', async () => {
  merges.length = 0; reviews.length = 0
  reviewResult = { verdict: 'needs_work' }
  const p = await project('ext-work', { autoMerge: true, externalPr: { autoMerge: true } })
  await prompt(p.id)
  const task = await externalCard(p, 34)
  await sched.tick()
  const after = store.state.tasks[task.id]
  assert.equal(after.mergeState, 'blocked')
  assert.equal(after.mergeReason, 'external-review-rejected')
  assert.equal(merges.length, 0)
  const tickets = inboxFor(task.id)
  assert.ok(tickets.some((x) => x.category === 'external-pr'))
  assert.equal(after.column, 'merging', '工单不移动卡')
})

await t('没有 reviewer：blocked，不 merge', async () => {
  merges.length = 0
  const bare = createScheduler({
    domain, store, log() {},
    dispatcher: { async merge(task) { merges.push(task.id); return { ok: true } } },
  })
  const p = await project('ext-noreviewer', { autoMerge: true, externalPr: { autoMerge: true } })
  await prompt(p.id)
  const task = await externalCard(p, 35)
  await bare.tick()
  const after = store.state.tasks[task.id]
  assert.equal(after.mergeState, 'blocked')
  assert.equal(after.mergeReason, 'no-reviewer')
  assert.equal(merges.length, 0)
  assert.ok(inboxFor(task.id).length >= 1)
})

await t('headSha 变化：重新审核并 blocked，不重复 merge', async () => {
  merges.length = 0; reviews.length = 0
  reviewResult = { verdict: 'approved' }
  const p = await project('ext-sha', { autoMerge: true, externalPr: { autoMerge: true } })
  await prompt(p.id)
  const task = await externalCard(p, 36, { headSha: 'bbbb222' })
  await sched.tick()
  assert.equal(merges.length, 1)
  assert.equal(reviews.length, 1)
  await store.tx((s) => { s.tasks[task.id].external.headSha = 'cccc333' })
  reviewResult = { verdict: 'needs_work' }
  await sched.tick()
  assert.equal(reviews.length, 2, 'head 变了要重新审核')
  assert.equal(merges.length, 1, '不能对同一张已合并的外部卡再 merge')
  const after = store.state.tasks[task.id]
  assert.equal(after.mergeState, 'blocked')
  assert.equal(after.mergeReason, 'head-mismatch')
})

await t('人批准：tick 只交接一次，不直接 merge', async () => {
  merges.length = 0; handoffs.length = 0; reviews.length = 0
  const p = await project('ext-human', { autoMerge: false, externalPr: { autoMerge: false } })
  const task = await externalCard(p, 37, { lane: 'human' })
  await domain.approveExternal(task.id, { decision: 'approved', by: 'human', note: '看着行' }, { role: 'human', id: 'human:test' })
  await sched.tick()
  assert.equal(merges.length, 0)
  assert.equal(reviews.length, 0, '人车道不走自动审核')
  assert.equal(handoffs.length, 1)
  assert.ok(store.state.tasks[task.id].external.approvalHandledAt)
  await sched.tick()
  assert.equal(handoffs.length, 1, 'approvalHandledAt 挡住第二次交接')
  assert.equal(merges.length, 0)
  assert.equal(store.state.tasks[task.id].external.approval.status, 'approved')
  assert.equal(store.state.tasks[task.id].external.approval.by, 'human')
})

await t('rejected：人确认拒绝后收口为 remote-ended，不 merge、不关闭远程 PR', async () => {
  merges.length = 0; closeouts.length = 0
  const p = await project('ext-reject', { autoMerge: true, externalPr: { autoMerge: true } })
  const task = await externalCard(p, 38, { lane: 'human' })
  await domain.approveExternal(task.id, { decision: 'rejected', by: 'human' }, { role: 'human', id: 'human:test' })
  await sched.tick()
  const after = store.state.tasks[task.id]
  assert.equal(merges.length, 0)
  assert.equal(closeouts.length, 0, '拒绝本地卡不应关闭作者的远程 PR')
  assert.equal(after.column, 'cancelled')
  assert.equal(after.phase, 'remote-ended')
  assert.equal(after.external.approval.status, 'rejected')
  await sched.tick()
  assert.equal(store.state.tasks[task.id].column, 'cancelled', '同一拒绝事实幂等收口')
})

await t('closed：走 closeout，不 merge', async () => {
  merges.length = 0; closeouts.length = 0
  const p = await project('ext-closed', { autoMerge: true, externalPr: { autoMerge: false } })
  const task = await externalCard(p, 39, { lane: 'human' })
  await store.tx((s) => { s.tasks[task.id].external.state = 'closed' })
  await sched.tick()
  assert.equal(merges.length, 0)
  assert.equal(closeouts.length, 1)
  assert.equal(closeouts[0].taskId, task.id)
  await sched.tick()
  assert.equal(closeouts.length, 1, '收口只交一次')
})

console.log('')
if (fails.length) {
  console.log('external-auto FAILED: ' + fails.length + ' / ' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ' :: ' + String((f.err && f.err.message) || f.err).split(NL)[0])
  process.exitCode = 1
} else {
  console.log('external-auto ok (' + pass + ' cases)')
}
