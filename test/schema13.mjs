/**
 * schema 13 + 卡片模型新字段（v0.003 / C-00）。
 *
 * 钉住四件事：
 *   ① 迁移 12→13 只补字段、行为增量是零（老数据加载后列/phase/mergeState 一个不改）；
 *   ② 迁移**不**给已有子卡回填 branchFrom —— 那些子卡的分支是从 base 拉的，
 *      回填会让它们下次派工被判 branch-missing（把好卡改成坏卡）；
 *   ③ isDelivered / deliveryState 是唯一「已交付」判据，四类 done 必须分得开；
 *   ④ 拆分只允许两层，且新子卡带 branchFrom = flow/<parentId>。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, SCHEMA_VERSION, MIGRATIONS, TRANSITIONS, applyTransition, isDelivered, deliveryState, DELIVERY_STATE } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-schema13-'))

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (e) { fails.push({ name, e }); console.log('  ✗ ' + name + NL + '    ' + String((e && e.message) || e)) }
}

// ---- A：schema 常量与迁移表 --------------------------------------------------
await t('SCHEMA_VERSION 是 15，且 MIGRATIONS[12..14] 都在', () => {
  assert.equal(SCHEMA_VERSION, 15)
  assert.equal(typeof MIGRATIONS[13], 'function', 'v0.008 的 unitMode 迁移要挂在 13 上')
  assert.equal(typeof MIGRATIONS[12], 'function')
  assert.equal(typeof MIGRATIONS[14], 'function', 'v0.012 的 blocks/readAt 迁移要挂在 14 上')
})

// ---- B：迁移 12→13 只补字段 ------------------------------------------------
await t('schema 12→13：补 kind/visibility/external/branchFrom/integrationBranch，不动列与 phase', async () => {
  const f = join(dir, 'mig12.json')
  writeFileSync(f, JSON.stringify({
    schemaVersion: 12,
    projects: { p: { id: 'p', title: 'P', workspacePath: dir, config: {} } },
    tasks: {
      'T-1': { id: 'T-1', projectId: 'p', title: '普通卡', column: 'running', phase: 'executing', mergeState: 'ready' },
      'T-2': { id: 'T-2', projectId: 'p', title: '阻塞卡', column: 'merging', phase: 'review-pending', mergeState: 'blocked', mergeReason: 'branch-busy' },
      'T-3': { id: 'T-3', projectId: 'p', title: '子卡', parentId: 'T-9', column: 'done', phase: 'merged', mergeState: 'none' },
    },
  }))
  const st = new Store(f)
  await st.load()
  assert.equal(st.state.schemaVersion, 15)
  const t1 = st.state.tasks['T-1']
  assert.equal(t1.kind, 'card')
  assert.equal(t1.visibility, 'board')
  assert.equal(t1.external, null)
  assert.equal(t1.integrationBranch, null)
  assert.equal(t1.branchFrom, null, '普通卡没有 branchFrom')
  assert.equal(t1.column, 'running', '迁移不动列')
  assert.equal(t1.phase, 'executing', '迁移不动 phase')
  assert.equal(t1.mergeState, 'ready', '迁移不动 mergeState')
  const t2 = st.state.tasks['T-2']
  assert.equal(t2.mergeState, 'blocked', 'blocked 卡不许被迁移顺手改成 ready')
  assert.equal(t2.mergeReason, 'branch-busy')
  const t3 = st.state.tasks['T-3']
  assert.equal(t3.branchFrom, null, '老子卡不回填 branchFrom（它的分支是从 base 拉的）')
  assert.equal(t3.phase, 'merged', '已完成卡的 phase 不被改写')
})

await t('迁移 12 是幂等的：连跑两次结果完全一致', async () => {
  const f = join(dir, 'mig12b.json')
  writeFileSync(f, JSON.stringify({ schemaVersion: 12, tasks: { 'T-1': { id: 'T-1', column: 'todo' } } }))
  const st1 = new Store(f)
  await st1.load()
  const once = JSON.parse(JSON.stringify(st1.state.tasks['T-1']))
  const twice = MIGRATIONS[12]({ tasks: { 'T-1': JSON.parse(JSON.stringify(once)) } }).tasks['T-1']
  assert.deepEqual(twice, once)
})

// ---- C：isDelivered / deliveryState ---------------------------------------
await t('isDelivered 只认 done + merged', () => {
  assert.equal(isDelivered({ column: 'done', phase: 'merged' }), true)
  assert.equal(isDelivered({ column: 'done', phase: 'merged-skipped' }), false)
  assert.equal(isDelivered({ column: 'done', phase: 'done-no-merge' }), false)
  assert.equal(isDelivered({ column: 'done', phase: 'merged-into-parent' }), false)
  assert.equal(isDelivered({ column: 'merging', phase: 'merged' }), false)
  assert.equal(isDelivered(null), false)
})

await t('deliveryState 把四类 done 分开，且未 done 一律 not-delivered', () => {
  assert.equal(deliveryState({ column: 'done', phase: 'merged' }), 'delivered')
  assert.equal(deliveryState({ column: 'done', phase: 'merged-skipped' }), 'skipped')
  assert.equal(deliveryState({ column: 'done', phase: 'done-no-merge' }), 'no-merge')
  assert.equal(deliveryState({ column: 'done', phase: 'merged-into-parent' }), 'merged-into-parent')
  assert.equal(deliveryState({ column: 'done', phase: 'whatever' }), 'not-delivered')
  assert.equal(deliveryState({ column: 'running', phase: 'merged' }), 'not-delivered', '在途卡即使 phase 像也不能算交付')
  assert.equal(deliveryState(null), 'not-delivered')
})

await t('DELIVERY_STATE 的五个键与 deliveryState 的返回值同集合', () => {
  const got = new Set([
    deliveryState({ column: 'done', phase: 'merged' }),
    deliveryState({ column: 'done', phase: 'merged-skipped' }),
    deliveryState({ column: 'done', phase: 'done-no-merge' }),
    deliveryState({ column: 'done', phase: 'merged-into-parent' }),
    deliveryState({ column: 'todo', phase: '' }),
  ])
  assert.deepEqual([...got].sort(), Object.keys(DELIVERY_STATE).sort())
})

// ---- D：拆分两层 + 子卡字段 ------------------------------------------------
const store = new Store(join(dir, 'flow.json'))
await store.load()
const domain = new FlowDomain(store)

async function seed() {
  const project = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'P' })
  const parent = await domain.createTask(project.id, { title: '父卡', acceptance: ['x'] })
  return { project, parent }
}
const items = [
  { title: '子 A', purpose: '改 A', effect: 'A 的调用方', scope: { paths: ['a.js'] }, acceptance: ['A 能跑'] },
  { title: '子 B', purpose: '改 B', effect: 'B 的调用方', scope: { paths: ['b.js'] }, acceptance: ['B 能跑'] },
]

await t('splitTask 给子卡带 branchFrom = flow/<parentId> 与继承的 visibility', async () => {
  const { parent } = await seed()
  const res = await domain.splitTask(parent.id, { items, reason: '并行' }, { role: 'dispatcher' })
  assert.equal(res.children.length, 2)
  for (const c of res.children) {
    assert.equal(c.parentId, parent.id)
    assert.equal(c.branchFrom, 'flow/' + parent.id)
    assert.equal(c.kind, 'card')
    assert.equal(c.external, null)
    assert.equal(c.visibility, 'board')
  }
})

await t('子卡不能再拆（只允许两层）', async () => {
  const { parent } = await seed()
  const res = await domain.splitTask(parent.id, { items }, { role: 'dispatcher' })
  const child = res.children[0]
  await assert.rejects(
    () => domain.splitTask(child.id, { items }, { role: 'dispatcher' }),
    /只允许两层/,
  )
})

await t('markParentIntegration 给父卡写集成分支与 pending，并清掉 noMerge', async () => {
  const { parent } = await seed()
  await domain.splitTask(parent.id, { items }, { role: 'dispatcher' })
  await domain.setNoMerge(parent.id, true, '父卡只做汇总，代码在子卡里合并')
  const got = await domain.markParentIntegration(parent.id)
  assert.equal(got.integrationBranch, 'flow/' + parent.id)
  assert.equal(got.branchFrom, null)
  assert.equal(got.mergeState, 'pending')
  assert.equal(got.mergeReason, null)
  assert.equal(got.noMerge, false, '父卡是要合并的，不能再标 noMerge')
})

// ---- E：子卡的新 phase 已经在状态机里兑现 -------------------------------
await t('TRANSITIONS 有 merge_into_parent（C-05 落地）', () => {
  const tr = TRANSITIONS.merge_into_parent
  assert.ok(tr, '子卡合进父分支要有自己的迁移')
  assert.deepEqual(tr.from, ['verifying', 'merging'])
  assert.equal(tr.to, 'done')
  assert.equal(tr.phase, 'merged-into-parent')
})

await t('merge_into_parent：子卡落 done/merged-into-parent，但不算已交付', () => {
  const task = { id: 'T-900', parentId: 'T-800', column: 'verifying', phase: 'awaiting-acceptance', mergeState: 'pending', noMerge: false }
  const next = applyTransition(task, 'merge_into_parent', { role: 'system' }, {})
  assert.equal(next.column, 'done')
  assert.equal(next.phase, 'merged-into-parent')
  assert.equal(isDelivered(next), false, '子卡不算已交付（代码还在父分支上）')
  assert.equal(deliveryState(next), 'merged-into-parent')
})

await t('merge_into_parent：没有 parentId 的卡走不了这条路', () => {
  const task = { id: 'T-901', parentId: null, column: 'verifying', phase: 'awaiting-acceptance', mergeState: 'pending' }
  assert.throws(() => applyTransition(task, 'merge_into_parent', { role: 'system' }, {}), /父分支/)
})

console.log(NL + pass + ' 通过，' + fails.length + ' 失败')
if (fails.length) {
  for (const f of fails) console.log('- ' + f.name + ': ' + String((f.e && f.e.stack) || f.e).split(NL).slice(0, 3).join(NL))
  process.exit(1)
}