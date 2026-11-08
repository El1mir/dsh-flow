/**
 * mergeState 读侧（I-12 / ADR-0005）。
 *
 * 这张测试钉住四件事，它们都是"界面说一套、状态机做一套"的入口：
 *   ① 原因表与 ADR 的键**完全一致**（多一个少一个都要红）—— 表是三个读出口的唯一来源；
 *   ② needsMerge 切到 mergeState 后，none/blocked 不再进合并列，否则卡会停在 merging
 *      等一个永远不来的结果（merge() 对非 ready/pending 一律拒）；
 *   ③ 迁移前的老卡（没有 mergeState、只有 noMerge=true）仍然不进合并列 —— 这是
 *      schema 11→12 的回退契约，破了就是老数据批量回归；
 *   ④ client.js 里那份内联副本没有和 lib/merge-state.js 漂移（浏览器里拿不到 ESM，
 *      只能复制一份，所以必须由测试替人盯着"改一处要改两处"）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, TRANSITIONS, applyTransition } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { buildProjectView } from '../lib/panel.js'
import { MERGE_REASON, MERGE_STATE_LABEL, mergeReasonOf } from '../lib/merge-state.js'

const NL = String.fromCharCode(10)

const dir = mkdtempSync(join(tmpdir(), 'flow-merge-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()

const rt = {
  async ensureSession(agent, project, opts = {}) {
    const rec = domain.latestSession(agent.id)
    if (rec && rec.sessionId) return { ok: true, sessionId: rec.sessionId, created: false }
    const sessionId = 'ses-' + agent.id
    await domain.bindSession(agent.id, sessionId, { state: 'idle', cwd: opts.cwd || null }, { role: 'system' })
    return { ok: true, sessionId, created: true }
  },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async workerGoal() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const project = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'merge' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

// ADR-0005 正文里列出的键。用数组而不是两段正则：迁移归类新增一个原因时，
// 这张表必须有人**手工**来这里加一行，否则测试红 —— 那正是想要的摩擦。
const ADR_NONE = ['no-code-change', 'coordination-card', 'superseded', 'no-worktree', 'not-a-repo']
// needs-rebase 也是 blocked：dispatch 的软合并 3 次仍落后时写的就是这个 reason。
const ADR_BLOCKED = ['no-commits', 'needs-rebase', 'base-missing', 'branch-busy', 'head-mismatch', 'out-of-scope-dirty', 'worktree-missing']
// 两个「环境问题」用黄：仓库缺基线、分支落后基线——都不是这张卡的代码出了故障。
const ADR_WARN = ['no-commits', 'needs-rebase']

// ---------- ① 表的键与形状 ----------

await t('MERGE_REASON 覆盖 ADR-0005 的全部原因（不多不少）', () => {
  const want = ADR_NONE.concat(ADR_BLOCKED).sort()
  const got = Object.keys(MERGE_REASON).sort()
  assert.deepEqual(got, want, '表与 ADR 对不上，多了：' + got.filter((k) => want.indexOf(k) < 0).join(',') + ' 少了：' + want.filter((k) => got.indexOf(k) < 0).join(','))
})

await t('每项都有 label / fix / tone / state，label ≤12 字', () => {
  for (const key of Object.keys(MERGE_REASON)) {
    const item = MERGE_REASON[key]
    assert.equal(typeof item.label, 'string', key + ' 缺 label')
    assert.ok(item.label.length > 0, key + ' 的 label 是空串')
    assert.ok(item.label.length <= 12, key + ' 的 label 超过 12 字：' + item.label)
    assert.equal(typeof item.fix, 'string', key + ' 缺 fix')
    assert.ok(item.fix.length > 0, key + ' 没有修复动作')
    assert.ok(['bad', 'warn', 'info'].indexOf(item.tone) >= 0, key + ' 的 tone 非法：' + item.tone)
    assert.ok(['none', 'blocked'].indexOf(item.state) >= 0, key + ' 的 state 非法（pending/ready 不该有原因）：' + item.state)
  }
})

await t('state 归类与 ADR 一致；环境问题（无基线/落后基线）用 warn，其余 blocked 用 bad', () => {
  for (const key of ADR_NONE) assert.equal(MERGE_REASON[key].state, 'none', key + ' 应该是 none')
  for (const key of ADR_BLOCKED) assert.equal(MERGE_REASON[key].state, 'blocked', key + ' 应该是 blocked')
  for (const key of ADR_WARN) assert.equal(MERGE_REASON[key].tone, 'warn', key + ' 是环境问题，应该用黄不用红')
  for (const key of ADR_BLOCKED.filter((k) => ADR_WARN.indexOf(k) < 0)) {
    assert.equal(MERGE_REASON[key].tone, 'bad', key + ' 是故障，应该用红')
  }
})

await t('MERGE_STATE_LABEL 四态齐全', () => {
  assert.deepEqual(Object.keys(MERGE_STATE_LABEL).sort(), ['blocked', 'none', 'pending', 'ready'])
  for (const state of Object.keys(MERGE_STATE_LABEL)) {
    assert.ok(MERGE_STATE_LABEL[state] && MERGE_STATE_LABEL[state].length > 0, state + ' 没有短标签')
  }
})

// ---------- ② needsMerge 切到 mergeState ----------

const toOf = (task) => TRANSITIONS.accept.to(task)
const phaseOf = (task) => TRANSITIONS.accept.phase(task)

await t('mergeState=pending / ready → 进合并列', () => {
  assert.equal(toOf({ mergeState: 'pending' }), 'merging')
  assert.equal(phaseOf({ mergeState: 'pending' }), 'merge-ready')
  assert.equal(toOf({ mergeState: 'ready' }), 'merging')
  assert.equal(phaseOf({ mergeState: 'ready' }), 'merge-ready')
})

await t('mergeState=none / blocked → 直接 done（不占合并列）', () => {
  assert.equal(toOf({ mergeState: 'none' }), 'done')
  assert.equal(phaseOf({ mergeState: 'none' }), 'done-no-merge')
  // blocked 进来等的是一个永远不来的结果：merge() 第一道检查就是 mergeState。
  assert.equal(toOf({ mergeState: 'blocked' }), 'done')
  assert.equal(phaseOf({ mergeState: 'blocked' }), 'done-no-merge')
})

await t('没有 mergeState 的老卡：回退读 noMerge（兼容 v0.001）', () => {
  assert.equal(toOf({ noMerge: true }), 'done', '老数据 noMerge=true 必须仍然不进合并列')
  assert.equal(phaseOf({ noMerge: true }), 'done-no-merge')
  assert.equal(toOf({ noMerge: false }), 'merging', '老数据 noMerge=false 仍然要合')
  // 非 Git 降级：dispatch 给的是 worktree=false
  assert.equal(toOf({ worktree: false }), 'done')
})

// ---------- ③ 写入口 ----------

const mk = async (title) => (await domain.createTask(project.id, { title, acceptance: ['x'] })).id

await t('setMergeState(blocked, base-missing) 同步维护 noMerge 与 mergeState', async () => {
  const id = await mk('基线分支配错')
  await domain.setMergeState(id, { state: 'blocked', reason: 'base-missing', humanReason: '配置的基线分支 main 不存在' }, { role: 'system' })
  const task = store.state.tasks[id]
  assert.equal(task.mergeState, 'blocked')
  assert.equal(task.mergeReason, 'base-missing')
  assert.equal(task.noMerge, true, 'blocked 也必须 noMerge=true，否则状态机会把卡推进合并列')
  assert.equal(toOf(task), 'done')
})

await t('setNoMerge(true, 线上 T-043 的 fatal 原文) → blocked / branch-busy', async () => {
  const id = await mk('分支被残留检出占用')
  await domain.setNoMerge(id, true, "fatal: 'flow/T-043' is already used by worktree at 'C:/x'", { role: 'system' })
  const task = store.state.tasks[id]
  assert.equal(task.mergeState, 'blocked')
  assert.equal(task.mergeReason, 'branch-busy')
  assert.equal(task.noMerge, true)
  assert.equal(toOf(task), 'done')
})

await t('setNoMerge(false, ...) 把卡放回可合并', async () => {
  const id = await mk('恢复合并')
  await domain.setNoMerge(id, false, '这一轮拿到了 worktree', { role: 'system' })
  const task = store.state.tasks[id]
  assert.equal(task.mergeState, 'ready')
  assert.equal(task.mergeReason, null)
  assert.equal(toOf(task), 'merging')
})

// ---------- ⑤ 看板投影：字段必须在白名单里 ----------

// 这条是补的（原票面没写，但它是「chip 永不显形」那个 bug 的入口）：
// buildProjectView 的 taskCard 是**白名单手写**的投影，少一个字段的后果不是显示得朴素，
// 而是客户端 mergeBadgeOf 静默返回 null —— 不报错、也不留痕，人只会以为「本来就没有」。
const cardId = await mk('基线分支不存在，看板要出红标')
await domain.setMergeState(cardId, { state: 'blocked', reason: 'base-missing', humanReason: '配置的基线分支 main 不存在' }, { role: 'system' })

await t('buildProjectView 的卡片透出 mergeState / mergeReason（否则看板 chip 不显形）', () => {
  const view = buildProjectView(store.state, project.id)
  // view.tasks 是**按列分组的对象**（{column: [card]}），不是扁平数组 ——
  // 这里踩过一次坑：直接 view.tasks.find(...) 会报 "find is not a function"。
  const all = Object.values(view.tasks || {}).flat()
  const card = all.find((x) => x.id === cardId)
  assert.ok(card, '卡片不在视图里：' + JSON.stringify(all.map((x) => x.id)))
  assert.equal(card.mergeState, 'blocked', '卡片缺 mergeState（或值不对）')
  assert.equal(card.mergeReason, 'base-missing', '卡片缺 mergeReason（或值不对）')
  // noMerge 仍要在：老客户端读它，删掉就是给升级窗口埋雷
  assert.equal(card.noMerge, true)
})

// ---------- ④ 兜底与 UI 一致性 ----------

await t('mergeReasonOf 对未知原因返回兜底、不抛', () => {
  const unknown = mergeReasonOf({ mergeReason: 'not-in-table', noMergeReason: '人工写的一句话', mergeState: 'blocked' })
  assert.equal(unknown.label, '人工写的一句话', '兜底要用任务自己那句人话')
  assert.equal(unknown.fix, '')
  assert.equal(unknown.tone, 'info')
  const bare = mergeReasonOf({})
  assert.equal(bare.label, '')
  assert.equal(bare.fix, '')
  // 传 null / undefined 也不能炸：看板与详情页都可能在 loading 态调用
  assert.equal(mergeReasonOf(null).label, '')
  assert.equal(mergeReasonOf({ mergeReason: 'base-missing' }).state, 'blocked')
})

await t('client.js 内联副本与表一致（改一处要改两处）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(/var MERGE_REASON = \{/.test(src), 'client.js 里要有内联的 MERGE_REASON')
  assert.ok(/var MERGE_STATE_LABEL = \{/.test(src), 'client.js 里要有内联的 MERGE_STATE_LABEL')
  assert.ok(/var mergeReasonOf = function/.test(src), 'client.js 里要有 mergeReasonOf')
  assert.ok(/var mergeBadgeOf = function/.test(src), '看板 chip 要走表格')
  assert.ok(/var mergeKvRow = function/.test(src), '详情行要走表格')
  for (const key of Object.keys(MERGE_REASON)) {
    const item = MERGE_REASON[key]
    assert.ok(src.indexOf("'" + key + "'") >= 0, 'client.js 缺原因键：' + key)
    assert.ok(src.indexOf(item.label) >= 0, 'client.js 的 label 漂了：' + key + ' → ' + item.label)
    assert.ok(src.indexOf(item.fix) >= 0, 'client.js 的 fix 漂了：' + key)
  }
})

await t('applyTransition 冒烟：verifying + blocked 落 done-no-merge', async () => {
  const id = await mk('验收冒烟')
  const base = Object.assign({}, store.state.tasks[id], { column: 'verifying', phase: null })
  const blocked = applyTransition(Object.assign({}, base, { mergeState: 'blocked', mergeReason: 'branch-busy' }), 'accept', { role: 'human', id: 'me' })
  assert.equal(blocked.column, 'done')
  assert.equal(blocked.phase, 'done-no-merge')
  const pending = applyTransition(Object.assign({}, base, { mergeState: 'pending' }), 'accept', { role: 'human', id: 'me' })
  assert.equal(pending.column, 'merging')
  assert.equal(pending.phase, 'merge-ready')
})

console.log('')
if (fails.length) { console.log(fails.length + ' 项失败'); process.exit(1) }
console.log('merge-state ok (' + pass + ' checks)')
