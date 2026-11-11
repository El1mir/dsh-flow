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
// RT-04 去重键是 [taskId, category, refKey]，不再含 actor。
// 造多张票时给每张一个不同的 issue 引用，否则同键 open 工会被并成一条。
let seq = 0
const mk = (patch) => {
  seq += 1
  const refs = patch.refs || [{ kind: 'issue', id: 'iss-' + seq, label: '#' + seq }]
  return domain.askHuman(Object.assign({}, base, patch, { refs }), { role: 'dispatcher', id: 'ag_dsp_' + seq })
}

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

await t('⑥ 归档：status=archived，但不替人标已读；未读的留在原分类里', async () => {
  const item = store.state.human_inbox[0]
  await store.tx((s) => { s.human_inbox[0].readAt = null })
  const r = await domain.resolveInbox(item.id, { note: '处理完' }, { role: 'dispatcher' })
  assert.equal(r.status, 'archived')
  // v0.017：归档 ≠ 读过。调度归档了、人还没点开，不能替人把未读点抹掉 ——
  // 那样这条工单会从所有分类 tab 里直接消失（这就是「回复完就看不见了」）。
  assert.equal(r.readAt, null, '归档不再顺手标已读')
  assert.ok(r.archivedAt, '归档时间要落库')
  assert.equal(domain.inboxList({ projectId: project.id }).some((x) => x.id === item.id), false, '默认列表不含归档')
  assert.equal(domain.inboxList({ projectId: project.id, includeArchived: true }).some((x) => x.id === item.id), true)
  // 界面（inbox.list）用的是 includeArchivedUnread：未读的归档件留在原位。
  const parked = domain.inboxList({ projectId: project.id, includeArchivedUnread: true })
  assert.equal(parked.some((x) => x.id === item.id), true, '未读的归档件要留在列表里')
  // 人点开读过之后，才真的沉底。
  await domain.markInboxRead(item.id)
  assert.equal(domain.inboxList({ projectId: project.id, includeArchivedUnread: true }).some((x) => x.id === item.id), false, '读过之后不再出现')
})

await t('⑥b 通知 TTL：超时自动归档，未到点不动，0 = 关闭', async () => {
  const mk = async (topic, ageMs) => {
    // 每条给不同的 refs：通知的去重键是 [projectId, category, refKey]，
    // 不区分就会把「久到该归档」和「刚发的」并成一条（并完时间还是新的）。
    const it = await domain.askHuman({
      projectId: project.id, kind: 'info', topic, body: '播报',
      refs: [{ kind: 'issue', id: 'ttl-' + ageMs }],
      from: 'dispatcher', fromRole: 'dispatcher',
    })
    if (ageMs) await store.tx((s) => { s.human_inbox.find((x) => x.id === it.id).updatedAt = new Date(Date.now() - ageMs).toISOString() })
    return it.id
  }
  const oldId = await mk('久到该归档了', 120 * 60000)
  const freshId = await mk('刚发的', 5 * 60000)
  const got = await domain.expireNotices({ minutes: 60 })
  assert.equal(got, 1, '只有超过 60 分钟的那条被归档')
  const oldItem = store.state.human_inbox.find((x) => x.id === oldId)
  assert.equal(oldItem.status, 'archived')
  assert.equal(oldItem.resolvedBy, 'system:notice-ttl')
  assert.equal(store.state.human_inbox.find((x) => x.id === freshId).status, 'open')
  assert.equal(await domain.expireNotices({ minutes: 0 }), 0, '0 = 关闭')
})

await t('⑦ 迁移 14：补 blocks / readAt（归档视为已读），幂等', () => {
  assert.equal(SCHEMA_VERSION, 17)
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

await t('⑨ 人回复可带 blocks：只挂证据、不写正文也算有效回复', async () => {
  await clearAll()
  const item = await mk({ topic: '带证据回复' })
  const r1 = await domain.replyInbox(item.id, '', { role: 'human', id: 'web' }, {
    blocks: [{ type: 'evidence', items: [{ kind: 'file', ref: 'lib/dispatch.js' }] }],
  })
  const saved = store.state.human_inbox.find((x) => x.id === item.id).replies.slice(-1)[0]
  assert.equal(saved.blocks.length, 1, '证据块要存下来')
  assert.equal(saved.blocks[0].items[0].ref, 'lib/dispatch.js')
  assert.equal(item.id, r1.id)
})

await t('⑩ 人回复的空内容被拒：正文、选项、组件三样全空才算空', async () => {
  await clearAll()
  const item = await mk({ topic: '空回复' })
  await assert.rejects(() => domain.replyInbox(item.id, '   ', { role: 'human', id: 'web' }, {}), /回复内容不能为空/)
  // 只选一个选项仍然可以（v1.39.1 的既有语义不能被这次改动破坏）
  await domain.replyInbox(item.id, '', { role: 'human', id: 'web' }, { answers: { q1: 'A' } })
  const rep = store.state.human_inbox.find((x) => x.id === item.id).replies.slice(-1)[0]
  assert.deepEqual(rep.answers, { q1: 'A' })
})
await t('⑪ 对话线分页：默认最近 5 条，before 游标往更早翻，到底 hasMore=false', async () => {
  await clearAll()
  const item = await mk({ topic: '长对话' })
  // 直接灌 12 条，时间戳拉开，保证顺序可断言（不走 replyInbox 免得触发状态机）。
  await store.tx((s) => {
    const it = s.human_inbox.find((x) => x.id === item.id)
    it.replies = Array.from({ length: 12 }, (_, i) => ({
      id: 'r' + (i + 1), at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      role: i % 2 ? 'human' : 'dispatcher', by: i % 2 ? 'human:web' : 'dispatcher', content: '第 ' + (i + 1) + ' 条',
    }))
  })
  const p1 = domain.inboxReplies(item.id, { limit: 5 })
  assert.deepEqual(p1.replies.map((r) => r.id), ['r8', 'r9', 'r10', 'r11', 'r12'], '首屏是最近 5 条（正序）')
  assert.equal(p1.total, 12)
  assert.equal(p1.hasMore, true)
  assert.equal(p1.nextBefore, 'r8')
  const p2 = domain.inboxReplies(item.id, { before: p1.nextBefore, limit: 5 })
  assert.deepEqual(p2.replies.map((r) => r.id), ['r3', 'r4', 'r5', 'r6', 'r7'])
  assert.equal(p2.nextBefore, 'r3')
  const p3 = domain.inboxReplies(item.id, { before: p2.nextBefore, limit: 5 })
  assert.deepEqual(p3.replies.map((r) => r.id), ['r1', 'r2'])
  assert.equal(p3.hasMore, false)
  assert.equal(p3.nextBefore, null)
  // 游标比 offset 稳：翻历史时又来了新回复，不能重复也不能漏。
  await store.tx((s) => {
    const it = s.human_inbox.find((x) => x.id === item.id)
    it.replies.push({ id: 'r13', at: '2026-01-01T01:00:00.000Z', role: 'human', content: '第 13 条' })
  })
  const after = domain.inboxReplies(item.id, { before: 'r8', limit: 5 })
  assert.deepEqual(after.replies.map((r) => r.id), ['r3', 'r4', 'r5', 'r6', 'r7'], '新回复不改变 before 那一页')
  assert.equal(domain.inboxReplies(item.id, { before: 'nope', limit: 2 }).replies.length, 2, '游标失效时退回最后一页而不是报错')
})

if (fails.length) { console.log('FAIL inbox-mailbox ' + fails.length + '/' + (pass + fails.length)); process.exitCode = 1 }
else console.log('PASS inbox-mailbox ' + pass + '/' + pass)