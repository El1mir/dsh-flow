/**
 * C-03：可见性（visibility）+ 自动车道视图 + isDelivered 读侧。
 *
 * 这张测试钉住 8 件事，它们各自对应一个「静默失败」的入口：
 *   ① auto 卡不上看板 —— 但必须出现在 autoLane 里（降噪不能变成失明）；
 *   ② 子卡仍然不上板（hiddenOnBoard 与 visibility 正交，别互相踩）；
 *   ③ autoLane.count 是**本项目**的 auto 卡总数（不是看板剩余数、不是全库数）；
 *   ④ autoLane.tasks 有 20 条上限，且 blocked / 有未归档请示的置顶；
 *   ⑤ taskCard 的白名单投影必须显式带上 kind/visibility/external/branchFrom/deliveryState
 *      —— 少一个字段不报错，客户端只会静默拿到 null（v0.002 的 mergeState chip 就是这么消失的）；
 *   ⑥ panel 的 deliveryStateOf 与 core 的 deliveryState 不漂移（两份镜像 + 一组输入）；
 *   ⑦ task.visibility 是唯一写入口，写完视图立即变化；
 *   ⑧ 非法值被拒（枚举守卫），且被拒时状态与事件都不能变。
 *
 * 直接跑：node test/panel-visibility.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, DELIVERY_STATE, deliveryState, isDelivered } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { buildProjectView, deliveryStateOf } from '../lib/panel.js'
import { createHttpHandler, TASK_VISIBILITY, setTaskVisibility } from '../lib/http.js'

const NL = String.fromCharCode(10)

const dir = mkdtempSync(join(tmpdir(), 'flow-visibility-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()

// 领域层只用到 runtime 的这几个方法；这里全部给「成功」的最小替身。
const rt = {
  async ensureSession() { return { ok: true, sessionId: 'ses-stub', created: false } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async workerGoal() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const project = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'visibility' })

const host = {
  domain,
  runtime: rt,
  resolveProjectById: (id) => store.state.projects[id],
  listProjects: () => Object.values(store.state.projects),
}
const handler = createHttpHandler(host)
/** 走真实的 HTTP 动作表：测试必须覆盖「人点按钮」那条路，而不只是 domain 方法。 */
async function post(action, args) {
  const res = await handler(new Request('http://local/api/flow/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args }),
  }))
  return { status: res.status, body: await res.json() }
}

const view = () => buildProjectView(store.state, project.id)
/** view.tasks 是按列分组的对象 {column: [card]}，不是扁平数组（这里踩过坑）。 */
const boardCards = (v) => Object.values(v.tasks || {}).flat()
const mk = async (title) => (await domain.createTask(project.id, { title, acceptance: ['x'] })).id

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

// ---------------------------------------------------------------------------
// ① auto 卡不上板，但出现在 autoLane 里
// ---------------------------------------------------------------------------

const autoId = await mk('自动车道里的卡')
const boardId = await mk('正常看板卡')

await t('task.visibility 写 auto 后，view.tasks 里立刻不再出现（且 autoLane 出现）', async () => {
  const before = boardCards(view())
  assert.ok(before.some((c) => c.id === autoId), '前置：还没写 visibility 时这张卡应在看板上')
  assert.equal(view().autoLane.count, 0, '前置：还没有 auto 卡')

  const res = await post('task.visibility', { taskId: autoId, visibility: 'auto' })
  assert.equal(res.status, 200, '动作应成功：' + JSON.stringify(res.body).slice(0, 200))
  assert.equal(res.body.ok, true)
  assert.equal(res.body.result.visibility, 'auto')

  const v = view()
  assert.equal(v.tasks.todo.some((c) => c.id === autoId), false, 'auto 卡不能再出现在看板的 todo 列')
  assert.equal(v.autoLane.count, 1, 'autoLane.count 要算上这张卡')
  assert.equal(v.autoLane.tasks.length, 1)
  assert.equal(v.autoLane.tasks[0].id, autoId)
  // 另一张普通卡必须还在：过滤不能把整列吃掉
  assert.ok(v.tasks.todo.some((c) => c.id === boardId), '普通卡仍应在看板上')
})

await t('写 visibility 会留下一条 task.visibility 事件（可审计），且重复写入不产生噪音', async () => {
  const events = store.state.events.filter((e) => e.type === 'task.visibility')
  assert.equal(events.length, 1, '第一次写入应落一条事件，实际 ' + events.length)
  assert.equal(events[0].payload.taskId, autoId)
  assert.equal(events[0].payload.visibility, 'auto')
  assert.equal(events[0].payload.previous, 'board', '事件要带 previous，审计才看得出方向')

  // 幂等：值没变就不写事件（界面上点两下不该多两条审计）
  await setTaskVisibility(domain, autoId, 'auto', { role: 'human', id: 'web' })
  assert.equal(store.state.events.filter((e) => e.type === 'task.visibility').length, 1, '同值重写不该再落事件')
})

// ---------------------------------------------------------------------------
// ② 子卡仍然不上看板（hiddenOnBoard 与 visibility 正交）
// ---------------------------------------------------------------------------

await t('子卡（hiddenOnBoard + parentId）仍然不上板，visibility 的过滤没有把它带回来', async () => {
  const parent = await domain.createTask(project.id, { title: '父卡', acceptance: ['a'] })
  const split = await domain.splitTask(parent.id, {
    reason: '测试拆卡',
    items: [
      { title: '子卡一', purpose: 'p1', scope: { paths: ['a.js'] }, effect: 'e1', acceptance: ['x'] },
      { title: '子卡二', purpose: 'p2', scope: { paths: ['b.js'] }, effect: 'e2', acceptance: ['x'] },
    ],
  }, { role: 'dispatcher', id: 'web' })
  const ids = split.children.map((c) => c.id)
  const children = ids.map((id) => store.state.tasks[id])
  for (const c of children) {
    assert.equal(c.hiddenOnBoard, true, '前置：splitTask 的产出必须带 hiddenOnBoard')
    assert.equal(c.visibility, 'board', '子卡默认仍是 board（跟随父卡，父卡不是 auto）')
  }
  const v = view()
  const all = boardCards(v)
  for (const id of ids) assert.equal(all.some((c) => c.id === id), false, '子卡不该出现在看板上：' + id)
  assert.ok(all.some((c) => c.id === parent.id), '父卡本身要看得到（子卡在它详情里打开）')
  // 子卡也不该混进自动车道：它不是 auto
  assert.equal(v.autoLane.tasks.some((x) => ids.includes(x.id)), false, '子卡不该出现在自动车道里')
})

// ---------------------------------------------------------------------------
// ③④ autoLane：计数 / 20 条上限 / blocked 与请示置顶
// ---------------------------------------------------------------------------

const autoIds = []
for (let i = 1; i <= 22; i += 1) autoIds.push(await mk('自动批 ' + String(i).padStart(2, '0')))

await t('autoLane.count 等于本项目的 auto 卡数；不是看板剩余数，也不含子卡', async () => {
  // 批量写成 auto：走同一个写入口（不是直接改 store，否则测的就不是入口了）
  for (const id of autoIds) await setTaskVisibility(domain, id, 'auto', { role: 'system', id: 'scheduler' })
  const v = view()
  const expect = Object.values(store.state.tasks)
    .filter((x) => x.projectId === project.id && x.visibility === 'auto').length
  assert.equal(v.autoLane.count, expect, 'autoLane.count 应等于项目的 auto 卡数 ' + expect)
  assert.ok(expect > 20, '前置：auto 卡要多于 20 条，才能测上限')
  assert.equal(boardCards(v).some((c) => c.visibility === 'auto'), false, '看板上不能有任何 auto 卡')
})

// 把「卡住的」和「有未归档请示的」两张压成最旧 —— 这样置顶只可能是 escalated，
// 不可能是因为「它比较新」。顺序如果只看 updatedAt，这条断言就会红。
const stuckId = autoIds[2]
const inboxId = autoIds[5]
await domain.block(stuckId, '基线分支缺失，等环境修好', { role: 'human', id: 'web' })
const asked = await domain.askHuman({
  taskId: inboxId,
  kind: 'decision',
  topic: '这条自动卡要不要人工确认',
  problem: '自动车道判断不出该不该继续',
  decisionNeeded: '继续 / 放弃',
}, { role: 'dispatcher', id: 'web' })
assert.equal(asked.status, 'open', '前置：请示必须未归档，才会被算成「要人处理」')
await store.tx((s) => {
  s.tasks[stuckId].updatedAt = '2000-01-01T00:00:00.000Z'
  s.tasks[inboxId].updatedAt = '2000-01-02T00:00:00.000Z'
})

await t('autoLane.tasks 最多 20 条，且 blocked / 有未归档请示的置顶（不是按时间）', () => {
  const v = view()
  assert.equal(v.autoLane.tasks.length, 20, '台账上限必须是 20 条，实际 ' + v.autoLane.tasks.length)
  const topTwo = v.autoLane.tasks.slice(0, 2).map((x) => x.id).sort()
  assert.deepEqual(topTwo, [inboxId, stuckId].sort(), '两张要人处理的卡必须置顶（即使它们最旧），实际前两条：' + topTwo.join(','))
  const stuck = v.autoLane.tasks.find((x) => x.id === stuckId)
  assert.ok(stuck && stuck.blocked && stuck.blocked.reason, 'blocked 的卡要带原因，展开时人能直接读到')
  const inboxRow = v.autoLane.tasks.find((x) => x.id === inboxId)
  assert.equal(inboxRow.openInbox, 1, '有未归档请示的卡要带请示数')
  assert.equal(v.autoLane.boardEscalated, 2, 'boardEscalated 数该是人需要处理的那 2 条')
  // 计数不受 20 条上限影响：count 是全量，tasks 只是台账
  assert.ok(v.autoLane.count > v.autoLane.tasks.length, 'count 必须是全量，不能被 20 条上限截断')
})

await t('autoLane 每条都够展开看：有 id/title/column，且不带整份任务体', () => {
  const v = view()
  for (const row of v.autoLane.tasks) {
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.title, 'string')
    assert.equal(typeof row.column, 'string')
    // 上限存在是有意的：不要把整张卡（plan/ticket/history）搬进视图
    assert.equal(row.history, undefined, 'autoLane 不该带 history')
    assert.equal(row.plan, undefined, 'autoLane 不该带 plan')
  }
})

// ---------------------------------------------------------------------------
// ⑤ taskCard 白名单投影（防「字段静默变 null」）
// ---------------------------------------------------------------------------

// 一张「被远程接管」的卡：把 external / branchFrom / kind 一起写上，验证投影是透传而不是丢字段。
const remoteId = await mk('远程接管的卡')
await store.tx((s) => {
  const t = s.tasks[remoteId]
  t.kind = 'mirror'
  t.external = { source: 'github', issueNumber: 42, url: 'https://example.invalid/42' }
  t.branchFrom = 'flow/T-001'
  t.column = 'done'
  t.phase = 'merged-into-parent'
})

await t('taskCard 投影含 kind / visibility / external / branchFrom / deliveryState（缺一个就挂）', () => {
  const v = view()
  const card = boardCards(v).find((c) => c.id === remoteId)
  assert.ok(card, '这张卡应在看板上')
  assert.equal(card.kind, 'mirror', 'kind 没投影出来')
  assert.equal(card.visibility, 'board', 'visibility 没投影出来')
  assert.equal(card.external.issueNumber, 42, 'external 没投影出来（远程身份会丢）')
  assert.equal(card.branchFrom, 'flow/T-001', 'branchFrom 没投影出来')
  assert.equal(card.deliveryState, 'merged-into-parent', 'deliveryState 没投影出来')
  assert.equal(card.delivered, false, 'merged-into-parent 不是「已进基线」')

  // 老数据（没有 kind/visibility/external/branchFrom）必须退化成默认值，而不是 undefined
  const plain = boardCards(v).find((c) => c.id === boardId)
  assert.equal(plain.kind, 'card', '缺 kind 时应退化成 card')
  assert.equal(plain.visibility, 'board', '缺 visibility 时应退化成 board')
  assert.equal(plain.external, null)
  assert.equal(plain.branchFrom, null)
  assert.equal(plain.deliveryState, 'not-delivered')
  assert.equal(isDelivered(store.state.tasks[boardId]), false)
})

await t('delivered 只认 done + merged：skipped / no-merge / merged-into-parent 都不算交付', async () => {
  const specs = [
    ['merged', 'delivered', true],
    ['merged-skipped', 'skipped', false],
    ['done-no-merge', 'no-merge', false],
    ['merged-into-parent', 'merged-into-parent', false],
  ]
  for (const [phase, want, delivered] of specs) {
    const id = await mk('交付态 ' + phase)
    await store.tx((s) => { s.tasks[id].column = 'done'; s.tasks[id].phase = phase })
    const t = store.state.tasks[id]
    assert.equal(deliveryState(t), want, phase + ' → ' + want)
    assert.equal(isDelivered(t), delivered, phase + ' 的 isDelivered 应为 ' + delivered)
    const card = boardCards(view()).find((c) => c.id === id)
    assert.equal(card.deliveryState, want, '卡片投影的 deliveryState 与 core 不一致：' + phase)
    assert.equal(card.delivered, delivered, '卡片投影的 delivered 与 core 不一致：' + phase)
  }
})

// ---------------------------------------------------------------------------
// ⑥ 漂移检测：panel 的内联镜像 vs core 的 deliveryState
// ---------------------------------------------------------------------------

await t('deliveryStateOf 与 core.deliveryState 对同一组输入结果一致（漂移检测）', () => {
  // v0.016（ticket 04）：done-partial 进同一组输入 —— 三份镜像都要认得它。
  const phases = ['merged', 'merged-skipped', 'done-no-merge', 'merged-into-parent', 'done-in-parent', 'done-partial', 'merge-ready', '', null, undefined]
  const columns = ['done', 'running', 'verifying', 'todo', 'merging', null, undefined]
  const cases = [null, undefined, {}, { column: 'done' }]
  for (const column of columns) {
    for (const phase of phases) cases.push({ column, phase })
  }
  for (const tc of cases) {
    const a = deliveryStateOf(tc)
    const b = deliveryState(tc)
    assert.equal(a, b, '两份镜像漂了：' + JSON.stringify(tc) + ' panel=' + a + ' core=' + b)
    assert.ok(Object.prototype.hasOwnProperty.call(DELIVERY_STATE, a), '结果必须是 DELIVERY_STATE 的键：' + a)
  }
  // 五个键一个不少：少一个键的后果是详情页显示 undefined
  assert.deepEqual(Object.keys(DELIVERY_STATE).sort(), ['delivered', 'merged-into-parent', 'no-merge', 'not-delivered', 'partial', 'skipped'])
})

// ③ 客户端副本（第三份镜像）也要对着 core 校验：
// 浏览器里拿不到 lib/*.js，client.js 只能内联一份。mergeState 的教训是
// 「改表忘改副本」不会有任何报错，只有界面静默显示错的东西 —— 所以这里把它钉住。
await t('client.js 的 DELIVERY_STATE_LABEL / deliveryStateOf 与 core 同键同文案（第三份镜像）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(src.indexOf('var DELIVERY_STATE_LABEL = {') >= 0, 'client.js 里要有内联的 DELIVERY_STATE_LABEL')
  assert.ok(src.indexOf('var deliveryStateOf = function') >= 0, 'client.js 里要有 deliveryStateOf')
  assert.ok(src.indexOf('var deliveryBadgeOf = function') >= 0, '看板要有交付徽标')
  assert.ok(src.indexOf('var deliveryKvRow = function') >= 0, '详情页要有「交付」行')
  for (const key of Object.keys(DELIVERY_STATE)) {
    assert.ok(src.indexOf("'" + key + "'") >= 0, 'client.js 缺交付态键：' + key)
    assert.ok(src.indexOf(DELIVERY_STATE[key]) >= 0, 'client.js 的交付态文案漂了：' + key + ' → ' + DELIVERY_STATE[key])
  }
  // 四条 phase 映射逐条比对：少一条就会有一整类 done 被算成 not-delivered
  const phaseMap = [
    ["t.phase === 'merged'", 'delivered'],
    ["t.phase === 'merged-skipped'", 'skipped'],
    ["t.phase === 'done-no-merge'", 'no-merge'],
    ["t.phase === 'merged-into-parent'", 'merged-into-parent'],
  ]
  for (const pair of phaseMap) {
    assert.ok(src.indexOf(pair[0] + ") return '" + pair[1] + "'") >= 0,
      'client.js 的 deliveryStateOf 缺映射：' + pair[0] + ' → ' + pair[1])
  }
})

// ---------------------------------------------------------------------------
// ⑦⑧ 写入口：拉回板上 / 非法值被拒
// ---------------------------------------------------------------------------

await t('把 auto 卡拉回 board：view.tasks 立即恢复，autoLane 计数立刻减一', async () => {
  const before = view()
  const countBefore = before.autoLane.count
  const res = await post('task.visibility', { taskId: autoIds[0], visibility: 'board' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  const after = view()
  assert.ok(boardCards(after).some((c) => c.id === autoIds[0]), '拉回板上后必须立刻出现在 view.tasks 里')
  assert.equal(after.autoLane.count, countBefore - 1, 'autoLane.count 要立刻减一')
  assert.equal(after.autoLane.tasks.some((x) => x.id === autoIds[0]), false, '自动车道里不该再列出它')
})

await t("非法值 'public' 被拒（HTTP 400），且状态与事件都不变", async () => {
  const target = autoIds[1]
  const before = store.state.tasks[target].visibility
  const eventsBefore = store.state.events.filter((e) => e.type === 'task.visibility').length

  const res = await post('task.visibility', { taskId: target, visibility: 'public' })
  assert.equal(res.status, 400, '越界值必须被路由拦成 400')
  assert.equal(res.body.ok, false)
  assert.match(String(res.body.error || ''), /visibility/, '错误信息要说清是哪个字段：' + res.body.error)

  assert.equal(store.state.tasks[target].visibility, before, '被拒后不能改状态')
  assert.equal(store.state.events.filter((e) => e.type === 'task.visibility').length, eventsBefore, '被拒后不能落事件')
  // 同样的守卫在直接调用层也要挡住（工具走的是这个函数，不能只有 HTTP 层校验）
  await assert.rejects(() => setTaskVisibility(domain, target, 'public', { role: 'human', id: 'web' }), /visibility/, '函数层也要拒绝')
  // 枚举常量就是这两个值：界面只能给出这两个按钮
  assert.deepEqual(TASK_VISIBILITY.slice().sort(), ['auto', 'board'])
})

console.log('')
if (fails.length) { console.log(fails.length + ' 项失败'); process.exit(1) }
console.log('panel-visibility ok (' + pass + ' checks)')
