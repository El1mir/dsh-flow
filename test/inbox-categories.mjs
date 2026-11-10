/**
 * RT-04：工单 category / refs / 去重。
 *
 * 显式 category 优先；否则按 kind 映射。refs 最多 8，task 必须属于本项目。
 * 同键 open 工单不新建，只更新 updatedAt/replyCount。归档后的行保留。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-inboxcat-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const domain = new FlowDomain(store, {
  async ensureSession() { return { ok: true, sessionId: 'ses' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
})
const project = await domain.ensureProject({ workspacePath: join(root, 'repo'), name: 'inboxcat' })
const other = await domain.ensureProject({ workspacePath: join(root, 'other'), name: 'other' })
const task = await domain.createTask(project.id, { title: '登录页', acceptance: ['能登录'] })
const foreign = await domain.createTask(other.id, { title: '别人的卡', acceptance: ['x'] })

const ask = (extra = {}) => domain.askHuman({
  taskId: task.id,
  kind: 'decision',
  topic: extra.topic || '要不要改范围',
  problem: '范围说不清。',
  decisionNeeded: '选一个。',
  asks: [{ key: 'q1', question: '选哪个？', why: '没有默认', type: 'confirm', default: 'yes' }],
  ...extra,
})

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

await t('没给 category 时按 kind 映射：risk→approval，blocked→blocked，decision→decision，info/error→info', async () => {
  const risk = await domain.askHuman({
    taskId: task.id, kind: 'risk', topic: '风险', problem: '要批。', decisionNeeded: '批不批',
    asks: [{ key: 'q1', question: '批？', why: '高风险', type: 'confirm' }],
  })
  const blocked = await domain.askHuman({
    taskId: task.id, kind: 'blocked', topic: '卡住', problem: '缺密钥。', decisionNeeded: '给密钥',
    asks: [{ key: 'q1', question: '密钥？', why: '没有就不能跑', type: 'text' }],
  })
  const decision = await ask({ topic: '决策映射' })
  const info = await domain.askHuman({ taskId: task.id, kind: 'info', topic: '通知', body: '只是告诉你' })
  const error = await domain.askHuman({ taskId: task.id, kind: 'error', topic: '出错了', body: '同步失败' })
  assert.equal(risk.category, 'approval')
  assert.equal(blocked.category, 'blocked')
  assert.equal(decision.category, 'decision')
  assert.equal(info.category, 'info')
  assert.equal(error.category, 'info')
})

await t('显式 category 压过 kind 映射', async () => {
  const item = await ask({ topic: '外部 PR 批准', category: 'external-pr', kind: 'decision' })
  assert.equal(item.category, 'external-pr')
})

await t('没给 refs 但有 taskId 时自动补一条 task 引用；创建时 replyCount=0 且 updatedAt=createdAt', async () => {
  const item = await ask({ topic: '自动引用', category: 'acceptance' })
  assert.equal(item.replyCount, 0)
  assert.equal(item.updatedAt, item.createdAt)
  assert.equal(item.refs.length, 1)
  assert.equal(item.refs[0].kind, 'task')
  assert.equal(item.refs[0].id, task.id)
  assert.ok(item.refs[0].label)
  assert.equal(Object.prototype.hasOwnProperty.call(item.refs[0], 'url'), true)
})

await t('refs 只留 kind/id/label/url；超过 8 条、非法 kind、别的项目的 task 都拒绝', async () => {
  const ok = await domain.askHuman({
    projectId: project.id,
    kind: 'info',
    topic: '带引用的通知',
    category: 'info',
    refs: [{ kind: 'pull', id: 'pr_9', label: 'PR 9', url: 'https://example.test/9', extra: 'drop' }],
  })
  assert.deepEqual(Object.keys(ok.refs[0]).sort(), ['id', 'kind', 'label', 'url'])
  assert.equal(ok.refs[0].url, 'https://example.test/9')
  assert.equal(ok.refs[0].extra, undefined)
  await assert.rejects(() => domain.askHuman({
    projectId: project.id, kind: 'info', topic: '太多',
    refs: Array.from({ length: 9 }, (_, i) => ({ kind: 'issue', id: String(i) })),
  }))
  await assert.rejects(() => domain.askHuman({
    projectId: project.id, kind: 'info', topic: '坏 kind',
    refs: [{ kind: 'commit', id: 'abc' }],
  }))
  await assert.rejects(() => domain.askHuman({
    projectId: project.id, kind: 'info', topic: '跨项目',
    refs: [{ kind: 'task', id: foreign.id }],
  }))
})

await t('同键 open 工单不新建：更新 updatedAt/replyCount；换 pull 引用或归档后可以再开', async () => {
  const first = await ask({
    topic: '去重甲',
    category: 'acceptance',
    refs: [{ kind: 'pull', id: 'pr_1', label: 'PR 1' }, { kind: 'task', id: task.id }],
  })
  const again = await ask({
    topic: '去重甲-重复',
    category: 'acceptance',
    refs: [{ kind: 'task', id: task.id }, { kind: 'pull', id: 'pr_1', label: 'PR 1' }],
  })
  assert.equal(again.duplicate, true)
  assert.equal(again.id, first.id)
  assert.equal(again.replyCount, 1)
  assert.notEqual(again.updatedAt, first.createdAt)
  const openSame = store.state.human_inbox.filter((x) => x.dedupeKey === first.dedupeKey && x.status === 'open')
  assert.equal(openSame.length, 1)
  const otherPull = await ask({
    topic: '另一张 PR',
    category: 'acceptance',
    refs: [{ kind: 'pull', id: 'pr_2', label: 'PR 2' }],
  })
  assert.notEqual(otherPull.id, first.id)
  assert.equal(otherPull.duplicate, undefined)
  await domain.resolveInbox(first.id, { note: '收' }, { role: 'human', id: 'web' })
  const archived = store.state.human_inbox.find((x) => x.id === first.id)
  assert.equal(archived.status, 'archived', '归档保留行，不删')
  const after = await ask({
    topic: '归档后再开',
    category: 'acceptance',
    refs: [{ kind: 'pull', id: 'pr_1', label: 'PR 1' }],
  })
  assert.notEqual(after.id, first.id)
  assert.equal(after.duplicate, undefined)
})

await t('回复和追问增加 replyCount/updatedAt，不改任务列', async () => {
  const item = await ask({ topic: '回复计数', category: 'decision', refs: [{ kind: 'issue', id: 'iss-reply', label: '回复用' }] })
  const column = store.state.tasks[task.id].column
  const replied = await domain.replyInbox(item.id, '继续', { role: 'human', id: 'web' })
  assert.equal(replied.replyCount, 1)
  assert.ok(replied.updatedAt)
  assert.equal(store.state.tasks[task.id].column, column)
  const followed = await domain.appendInboxFollowUp(item.id, '还差截图', { role: 'dispatcher', id: 'ag' })
  assert.equal(followed.replyCount, 2)
  assert.equal(store.state.tasks[task.id].column, column)
})

await t('inboxList 按 category 过滤，不带 category 时行为不变', async () => {
  const all = domain.inboxList({ projectId: project.id, includeArchived: true, limit: 200 })
  const decisions = domain.inboxList({ projectId: project.id, category: 'decision', includeArchived: true, limit: 200 })
  assert.ok(all.length > decisions.length)
  assert.ok(decisions.every((x) => x.category === 'decision'))
  assert.ok(decisions.length >= 1)
})

console.log(NL + pass + ' passed, ' + fails.length + ' failed')
if (fails.length) process.exit(1)
