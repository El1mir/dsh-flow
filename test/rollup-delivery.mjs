/**
 * v0.008 / 架构候选 5：父卡收口要看**交付事实**，不是看列。
 *
 * rollup 原来的判据是 `column === 'done'`，而 done 有五条来路，其中
 * done-no-commit（父检出里一个提交都没有）和 merged-skipped（显式不合并）的活
 * 根本没进父分支。这张测试钉住：
 *   ① 全部落地 → 父卡 mergeState=ready（可以合并了）；
 *   ② 有子卡没落地 → undo 记在 task.rollup 上、评论说清楚、父卡**不**变成 ready；
 *   ③ cancelled 不算缺口；
 *   ④ 子卡不能走审核（domain.review 是汇合点）；
 *   ⑤ 面板投影带上 unitMode / integrationBranch / rollup（漏一个界面就静默）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import { buildProjectView, deliveryStateOf } from '../lib/panel.js'

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-rollup-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'a' + NL)
sh(repo, ['add', '-A'])
sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'rollup' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

/** 造一对父子，子卡的终态由 phase 决定（模拟 afterUnitAccept 已经写下的结论）。 */
async function makePair(title, phases) {
  const parent = await domain.createTask(project.id, { title, acceptance: ['x'] })
  const kids = []
  for (const p of phases) kids.push(await domain.createTask(project.id, { title: 'kid-' + p, acceptance: ['x'] }))
  await store.tx((s) => {
    const pt = s.tasks[parent.id]
    pt.column = 'planning'
    pt.phase = 'split'
    pt.childIds = kids.map((k) => k.id)
    kids.forEach((k, i) => {
      const kt = s.tasks[k.id]
      kt.parentId = parent.id
      kt.unitMode = 'shared'
      kt.branchFrom = 'flow/' + parent.id
      kt.mergeState = 'none'
      kt.column = phases[i] === 'cancelled' ? 'cancelled' : 'done'
      kt.phase = phases[i]
    })
  })
  return { parent, kids }
}

await t('① 子卡全部落地 → 父卡 mergeState 变 ready，rollup.delivered 有全部 id', async () => {
  const { parent, kids } = await makePair('全部落地', ['done-in-parent', 'done-in-parent'])
  const res = await dispatcher.rollupParent(store.state.tasks[kids[0].id])
  assert.equal(res.ok, true, JSON.stringify(res))
  const p = store.state.tasks[parent.id]
  assert.equal(p.mergeState, 'ready', '全落地之后父卡要能合并')
  assert.deepEqual(p.rollup.delivered.slice().sort(), kids.map((k) => k.id).sort())
  assert.deepEqual(p.rollup.undelivered, [])
})

await t('② 有子卡没落地 → 记进 rollup.undelivered，父卡仍是 pending，评论说清楚', async () => {
  const { parent, kids } = await makePair('缺一条支线', ['done-in-parent', 'done-no-commit'])
  await dispatcher.rollupParent(store.state.tasks[kids[0].id])
  const p = store.state.tasks[parent.id]
  assert.deepEqual(p.rollup.undelivered, [kids[1].id])
  assert.equal(p.rollup.delivered.length, 1)
  assert.notEqual(p.mergeState, 'ready', '缺支线的父卡不能自己变成可合并')
  const said = (store.state.task_comments || []).filter((c) => c.taskId === parent.id).map((c) => String(c.content || '')).join(NL)
  assert.match(said, /没有落地改动/)
})

await t('③ 显式不合并（merge_skip）也算缺口，cancelled 不算', async () => {
  const { parent, kids } = await makePair('跳过与取消', ['merged-skipped', 'cancelled'])
  await dispatcher.rollupParent(store.state.tasks[kids[0].id])
  const p = store.state.tasks[parent.id]
  assert.deepEqual(p.rollup.undelivered, [kids[0].id], 'cancel 是人的决定，不该被算成缺口')
})

await t('④ 子卡不能审核：domain.review 直接拒（tools/http 也走这里）', async () => {
  const { kids } = await makePair('子卡审核', ['done-in-parent'])
  await store.tx((s) => { s.tasks[kids[0].id].column = 'merging'; s.tasks[kids[0].id].mergeRequest = { id: 'pr_x' } })
  await assert.rejects(() => domain.review(kids[0].id, 'approved', {}, { role: 'dispatcher' }), /子卡不参与审核/)
})

await t('⑤ 面板投影：unitMode / integrationBranch / rollup 都在', async () => {
  const { parent, kids } = await makePair('投影', ['done-in-parent'])
  await dispatcher.rollupParent(store.state.tasks[kids[0].id])
  // 子卡不上看板（hiddenOnBoard + parentId），所以投影要单独验：
  // 读侧归类 + 父卡行。
  assert.equal(deliveryStateOf({ column: 'done', phase: 'done-in-parent' }), 'merged-into-parent',
    '工作单元的落点必须归到「已合入父分支」这一档，否则界面显示成「未交付」')
  const view = buildProjectView(store.state, project.id)
  const flat = Object.values(view.tasks || {}).flat()
  const pt = flat.find((x) => x.id === parent.id)
  assert.ok(pt, '父卡要在看板视图里')
  assert.ok(pt.rollup, '父卡的核对结果必须投影出去')
  assert.equal(pt.rollup.undelivered.length, 0)
  assert.equal(pt.integrationBranch, 'flow/' + parent.id)
})

if (fails.length) {
  console.log('FAIL rollup-delivery ' + fails.length + '/' + (pass + fails.length))
  process.exitCode = 1
} else {
  console.log('PASS rollup-delivery ' + pass + '/' + pass)
}