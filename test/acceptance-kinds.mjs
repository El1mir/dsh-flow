/**
 * 验收分档（v0.016 / ticket 06）：系统可验 / 需要环境 / 需要人。
 *
 * 自动验收只对自己的授权范围（系统可验）负责：环境项没过是缺东西，不是活没干；
 * 人验项没过是人还没看。两者都不该变成返工。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher, buildInspectPacket } from '../lib/dispatch.js'
import { createScheduler } from '../lib/scheduler.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-kinds-'))
const gitRepo = join(root, 'repo')
await import('node:fs').then(({ mkdirSync }) => mkdirSync(gitRepo))
execFileSync('git', ['init', '-q'], { cwd: gitRepo })
execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'baseline'], { cwd: gitRepo })
const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo, encoding: 'utf8' }).trim()
const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession() { return { ok: true, sessionId: 's' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const scheduler = createScheduler({ domain, dispatcher, store, log: () => {} })
const project = await domain.ensureProject({ workspacePath: join(root, 'ws'), name: 'k' })
await domain.updateProjectConfig(project.id, { autoAccept: true })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

/** 开一张卡并让它跑到待验收；statuses 与 acceptance 一一对应。 */
async function verifyingCard({ title, acceptance, kinds, statuses, tests = 'node test/x.mjs（8 通过，0 失败）' }) {
  const task = await domain.createTask(project.id, { title, acceptance, acceptanceKinds: kinds || undefined })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 做', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  await domain.startRun(task.id, { agentId: worker.id, sessionId: 's-' + Math.random().toString(36).slice(2), trigger: 'system' }, { role: 'system' })
  await domain.move(task.id, 'stop', { role: 'worker', id: worker.id }, {
    stopReport: {
      summary: '做完了',
      tests,
      acceptanceStatus: statuses.map((st, index) => ({ index, status: st, evidence: 'cmd:' + index })),
    },
  })
  return store.state.tasks[task.id]
}

const c1 = await verifyingCard({ title: '老卡（没有档位）', acceptance: ['能跑', '有测试'], statuses: ['pass', 'pass'] })
await t('① 缺档位的老卡按「系统可验」解释，全过就自动收', async () => {
  await scheduler.tick()
  const cur = store.state.tasks[c1.id]
  // 收下的落点由 needsMerge 决定（有检出的卡先进 merging）；这里只要求「已收」而不是还赖在待验收。
  assert.ok(['merging', 'done'].includes(cur.column), '全 pass 应当自动收下，实际 ' + cur.column)
})

const c2 = await verifyingCard({ title: '老卡有项没跑', acceptance: ['能跑'], statuses: ['not-run'] })
await t('② 系统可验项没过 → 不自动收（走证据不足）', async () => {
  await scheduler.tick()
  assert.equal(store.state.tasks[c2.id].column, 'verifying')
})

const c3 = await verifyingCard({
  title: '缺环境的卡',
  acceptance: ['单测通过', '真实后端返回 SUCCESS', '文案确认'],
  kinds: ['auto', 'env', 'human'],
  statuses: ['pass', 'not-run', 'not-run'],
})
await t('③ 环境项没过 → 进 blocked-needs-env，带缺失清单，不返工', async () => {
  const before = store.state.tasks[c3.id]
  const beforeRework = before.rework ? before.rework.count : 0
  await scheduler.tick()
  const cur = store.state.tasks[c3.id]
  assert.equal(cur.column, 'verifying', '不进 done')
  assert.equal(cur.phase, 'blocked-needs-env')
  assert.equal(cur.envMissing.length, 1, '缺环境清单要落在卡上')
  assert.match(cur.envMissing[0], /真实后端/)
  const afterRework = cur.rework ? cur.rework.count : 0
  assert.equal(afterRework, beforeRework, '环境项不许抬高返工计数')
  const ticket = (store.state.human_inbox || []).find((x) => x.taskId === c3.id && x.kind === 'blocked')
  assert.ok(ticket, '应当开一张缺环境工单')
  assert.match(ticket.problem, /真实后端/)
})

await t('④ 缺环境的卡不能直接验收', async () => {
  await assert.rejects(
    () => domain.move(c3.id, 'accept', { role: 'human', id: 'me' }, {}),
    /缺环境/
  )
})

const c4 = await verifyingCard({
  title: '要人看文案的卡',
  acceptance: ['单测通过', '文案是否合适'],
  kinds: ['auto', 'human'],
  statuses: ['pass', 'not-run'],
})
await t('⑤ 人验项没过 → 停在待验收 + 决策工单，不自动收', async () => {
  await scheduler.tick()
  const cur = store.state.tasks[c4.id]
  assert.equal(cur.column, 'verifying')
  const ticket = (store.state.human_inbox || []).find((x) => x.taskId === c4.id && x.kind === 'decision')
  assert.ok(ticket, '应当问人')
  assert.match(ticket.problem, /文案是否合适/)
})

const c5 = await verifyingCard({
  title: '环境项也过了的卡',
  acceptance: ['单测通过', '真实后端返回 SUCCESS'],
  kinds: ['auto', 'env'],
  statuses: ['pass', 'pass'],
})
await t('⑥ 环境项通过 + 系统项通过 → 照常自动收', async () => {
  await scheduler.tick()
  const cur = store.state.tasks[c5.id]
  assert.ok(['merging', 'done'].includes(cur.column), '环境项与系统项都过就该收，实际 ' + cur.column)
})

await t('⑦ acceptanceKinds 迁移后与 acceptance 等长（老卡默认 auto）', async () => {
  const task = store.state.tasks[c1.id]
  assert.equal(task.acceptanceKinds.length, task.acceptance.length)
  assert.deepEqual(task.acceptanceKinds, ['auto', 'auto'])
})

const proven = await verifyingCard({ title: '逐项证据优先', acceptance: ['能跑'], statuses: ['pass'], tests: '完整套件 skipped；逐项命令已通过' })
await t('⑧ 逐项 pass 且证据齐全优先于汇总 skipped', async () => {
  await scheduler.tick()
  assert.ok(['merging', 'done'].includes(store.state.tasks[proven.id].column))
})

await t('⑨ 缺证据交给调度且同缺口只通知一次，不开人工单', async () => {
  const card = await verifyingCard({ title: '缺证明', acceptance: ['能跑'], statuses: ['pass'] })
  await store.tx((s) => { s.tasks[card.id].stopReport.acceptanceStatus[0].evidence = '  ' })
  await scheduler.tick()
  await scheduler.tick()
  assert.equal(store.state.tasks[card.id].column, 'verifying')
  assert.equal(domain.openInboxFor(card.id).length, 0)
  const messages = store.state.message_log.filter((m) => m.taskId === card.id && m.event === 'task.acceptance-evidence')
  assert.equal(messages.length, 1)
})

await t('⑩ 调度员可在当前 HEAD 上补录自动验收证据', async () => {
  const card = await verifyingCard({ title: '调度补证闭环', acceptance: ['自动检查通过'], statuses: ['not-run'] })
  await store.tx((s) => { s.tasks[card.id].headSha = currentHead; s.tasks[card.id].worktree = { path: gitRepo }; s.tasks[card.id].activeRunId = null })
  const payload = (headSha) => ({ headSha, acceptanceStatus: [{ index: 0, status: 'pass', evidence: 'node test/x.mjs exit 0' }] })
  const headError = await domain.move(card.id, 'supplement_evidence', { role: 'dispatcher', id: 'ag_d' }, payload('wrong')).then(() => '', (err) => err.message)
  assert.match(headError, /HEAD/, headError)
  await domain.move(card.id, 'supplement_evidence', { role: 'dispatcher', id: 'ag_d' }, payload(currentHead))
  assert.equal(store.state.tasks[card.id].stopReport.acceptanceStatus[0].status, 'pass')
  assert.equal(store.state.tasks[card.id].column, 'verifying')
  assert.ok(store.state.events.some((e) => e.type === 'task.evidence_supplemented' && e.payload.taskId === card.id))
})

await t('补证仅允许调度员与 auto 项，拒绝旧 HEAD 和无 active run', async () => {
  const card = await verifyingCard({ title: '补证权限边界', acceptance: ['人验', '环境验', '自动验'], kinds: ['human', 'env', 'auto'], statuses: ['not-run', 'not-run', 'not-run'] })
  await store.tx((s) => { s.tasks[card.id].headSha = currentHead; s.tasks[card.id].worktree = { path: gitRepo }; s.tasks[card.id].activeRunId = null })
  const act = (actor, index, headSha = currentHead) => domain.move(card.id, 'supplement_evidence', actor, { headSha, acceptanceStatus: [{ index, status: 'pass', evidence: 'node test/x.mjs exit 0' }] })
  await assert.rejects(act({ role: 'worker', id: worker.id }, 2), /只有调度员/)
  await assert.rejects(act({ role: 'dispatcher', id: 'ag_d' }, 0), /只能补录系统可验项/)
  await assert.rejects(act({ role: 'dispatcher', id: 'ag_d' }, 1), /只能补录系统可验项/)
  await assert.rejects(act({ role: 'dispatcher', id: 'ag_d' }, 2, 'stale'), /HEAD/)
  await store.tx((s) => { s.tasks[card.id].activeRunId = 'run_active' })
  await assert.rejects(act({ role: 'dispatcher', id: 'ag_d' }, 2), /没有运行任务/)
  assert.equal(store.state.tasks[card.id].stopReport.acceptanceStatus[2].status, 'not-run')
})

await t('⑪ 巡检包保留逐项验收原文和证明', async () => {
  const packet = buildInspectPacket(proven, '验收', null, { rulesInSystem: false })
  assert.match(packet, /能跑/)
  assert.match(packet, /cmd:0/)
})

await t('⑪ fail、缺报告、未运行保持独立分类且不消耗失败预算', async () => {
  for (const [status, expected] of [['fail', 'failed'], ['not-run', 'not-run'], [null, 'missing-report']]) {
    const card = await verifyingCard({ title: expected, acceptance: ['检查'], statuses: [status] })
    if (status === null) await store.tx((s) => { s.tasks[card.id].stopReport.acceptanceStatus = [] })
    const result = await scheduler.tick()
    assert.equal(result.accepted.find((x) => x.taskId === card.id).skipped, expected)
    assert.equal(store.state.tasks[card.id].attempts || 0, 0)
    assert.equal(domain.openInboxFor(card.id).length, 0)
  }
})
await t('⑫ 老报告未执行仍保守处理；没有调度员才请人', async () => {
  const card = await verifyingCard({ title: 'legacy', acceptance: [], statuses: [], tests: '未执行' })
  await store.tx((s) => { for (const agent of Object.values(s.agents)) if (agent.role === 'dispatcher') agent.enabled = false })
  await scheduler.tick()
  assert.equal(store.state.tasks[card.id].column, 'verifying')
  assert.equal(domain.openInboxFor(card.id).length, 1)
  await scheduler.tick()
  assert.equal(domain.openInboxFor(card.id).length, 1)
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')