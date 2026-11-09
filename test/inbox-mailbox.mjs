/** v0.012：工单箱的数据层 —— 已读、预设组件、邮箱式列表与迁移。 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, SCHEMA_VERSION, MIGRATIONS } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { upgradeInboxItem } from '../lib/domain/inbox.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-mailbox-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const domain = new FlowDomain(store, { async ensureSession() { return { ok: true, sessionId: 's' } }, async promptSession() { return { ok: true } } })
const project = await domain.ensureProject({ workspacePath: join(root, 'repo'), name: 'mb' })
const task = await domain.createTask(project.id, { title: '邮箱测试', acceptance: ['x'] })

const base = {
  taskId: task.id, kind: 'decision', topic: '要你定', problem: '有分歧', decisionNeeded: '选一个',
  asks: [{ key: 'q1', question: '选哪个', why: '只有你能定', type: 'choice', choices: [{ value: 'A', label: '甲' }, { value: 'B', label: '乙' }] }],
}
// 每张票换个发送人 id：askHuman 的幂等键含 actor（同卡同类型同发起人会直接返回旧票）。
// 这不是绕过业务规则，而是让「一次测试要造 N 张票」与「真实里同一调度不会重复开单」两件事互不干扰。
let seq = 0
const mk = (patch) => { seq += 1; return domain.askHuman(Object.assign({}, base, patch), { role: 'dispatcher', id: 'ag_dsp_' + seq }) }

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}
async function clearAll() { await store.tx((s) => { s.human_inbox = [] }) }

await t('① 新工单带 blocks 与 readAt=null，非法块被丢掉', async () => {
  await clearAll()
  const item = await mk({ topic: '带组件', blocks: [
    { type: 'note', text: '主检出有未提交改动' },
    { type: 'bogus', text: '不该存在' },
    { type: 'choice', prompt: '按哪条走', options: [{ value: 'A', label: '甲' }, { value: 'B', label: '乙' }] },
  ] })
  assert.equal(item.blocks.length, 2, JSON.stringify(item.blocks))
  assert.equal(item.blocks[0].type, 'note')
  assert.equal(item.readAt, null)
})

await t('② 标已读只动 readAt，不动 status，且幂等（不重复 emit）', async () => {
  const item = store.state.human_inbox[0]
  const events = () => store.state.events.filter((e) => e.type === 'human.read' && e.payload && e.payload.inboxId === item.id).length
  const r1 = await domain.markInboxRead(item.id)
  assert.ok(r1.readAt, '必须写 readAt')
  assert.equal(r1.status, 'open', '已读不等于处理完')
  const n1 = events()
  await domain.markInboxRead(item.id)
  assert.equal(events(), n1, '第二次调用不应再 emit')
})

await t('③ 列表按时间倒序、支持 offset 分页与总数', async () => {
  await clearAll()
  const a = await mk({ topic: '第一条' })
  const b = await mk({ topic: '第二条' })
  const c = await mk({ topic: '第三条' })
  const all = domain.inboxList({ projectId: project.id })
  assert.deepEqual(all.map((x) => x.id), [c.id, b.id, a.id], '必须新→旧')
  const page = domain.inboxList({ projectId: project.id, limit: 1, offset: 1 })
  assert.equal(page.length, 1)
  assert.equal(page[0].id, b.id)
  assert.equal(domain.inboxCount({ projectId: project.id }), 3)
})

await t('④ kind 过滤与 q 搜索（topic / problem / taskId）', async () => {
  const info = await domain.askHuman({ taskId: task.id, kind: 'info', topic: '只是通知', body: '已完成' }, { role: 'dispatcher', id: 'ag_dsp' })
  const onlyInfo = domain.inboxList({ projectId: project.id, kind: 'info' })
  assert.deepEqual(onlyInfo.map((x) => x.id), [info.id])
  assert.equal(domain.inboxList({ projectId: project.id, q: '第二条' }).length, 1)
  assert.equal(domain.inboxList({ projectId: project.id, q: '有分歧' }).length, 3, 'problem 也应命中')
  assert.equal(domain.inboxList({ projectId: project.id, q: task.id }).length, 4, '卡号也应命中')
})

await t('⑤ 调度追问：回到 open、重新未读，追问可带 blocks', async () => {
  const item = domain.inboxList({ projectId: project.id, kind: 'decision' })[0]
  await domain.markInboxRead(item.id)
  assert.ok(item.readAt || store.state.human_inbox.find((x) => x.id === item.id).readAt)
  await store.tx((s) => { s.human_inbox.find((x) => x.id === item.id).status = 'answered' })
  await domain.appendInboxFollowUp(item.id, '还差一个确认', { role: 'dispatcher', id: 'ag_dsp' }, { blocks: [{ type: 'note', text: '再确认一次' }] })
  const after = store.state.human_inbox.find((x) => x.id === item.id)
  assert.equal(after.status, 'open', '追问是新的入站消息')
  assert.equal(after.readAt, null, '必须重新未读')
  const last = after.replies[after.replies.length - 1]
  assert.equal(last.role, 'dispatcher')
  assert.equal(last.blocks.length, 1)
})

await t('⑥ 归档：status=archived 且补 readAt', async () => {
  const item = store.state.human_inbox[0]
  await store.tx((s) => { s.human_inbox[0].readAt = null })
  const r = await domain.resolveInbox(item.id, { note: '处理完' }, { role: 'dispatcher' })
  assert.equal(r.status, 'archived')
  assert.ok(r.readAt, '归档即视为读过')
  assert.equal(domain.inboxList({ projectId: project.id }).some((x) => x.id === item.id), false, '默认列表不含归档')
  assert.equal(domain.inboxList({ projectId: project.id, includeArchived: true }).some((x) => x.id === item.id), true)
})

await t('⑦ 迁移 14：补 blocks / readAt（归档视为已读），幂等', () => {
  assert.equal(SCHEMA_VERSION, 15)
  const data = {
    schemaVersion: 14,
    human_inbox: [
      { id: 'hi_1', status: 'archived', archivedAt: '2026-01-01T00:00:00Z', replies: [{ id: 'r1', role: 'human' }] },
      { id: 'hi_2', status: 'open', replies: [] },
      { id: 'hi_3', status: 'answered', readAt: '2026-02-02T00:00:00Z', blocks: [{ type: 'note', text: 'x' }] },
    ],
  }
  const out = MIGRATIONS[14](data)
  assert.equal(out.schemaVersion, 15)
  const [a, b, c] = out.human_inbox
  assert.deepEqual(a.blocks, [])
  assert.equal(a.readAt, '2026-01-01T00:00:00Z', '归档的视为已读')
  assert.deepEqual(a.replies[0].blocks, [])
  assert.equal(b.readAt, null, '未归档的保持未读')
  assert.equal(c.readAt, '2026-02-02T00:00:00Z', '已有的 readAt 不能被覆盖')
  assert.equal(c.blocks.length, 1, '已有的 blocks 不能被清空')
  const twice = MIGRATIONS[14](JSON.parse(JSON.stringify(out)))
  assert.deepEqual(twice.human_inbox, out.human_inbox, '迁移必须幂等')
})

await t('⑧ upgradeInboxItem 给老工单补 blocks/readAt，不改变其他字段', () => {
  const legacy = { id: 'hi_x', status: 'open', options: [], replies: [{ id: 'r', content: 'x' }] }
  const up = upgradeInboxItem(legacy)
  assert.deepEqual(up.blocks, [])
  assert.equal(up.readAt, null)
  assert.deepEqual(up.replies[0].blocks, [])
  assert.deepEqual(up.context, { facts: [], evidence: [] })
})

if (fails.length) { console.log('FAIL inbox-mailbox ' + fails.length + '/' + (pass + fails.length)); process.exitCode = 1 }
else console.log('PASS inbox-mailbox ' + pass + '/' + pass)