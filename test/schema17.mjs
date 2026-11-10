/**
 * schema 16 → 17（RT-00 / ADR-0007 §8、docs/远程事务设计.md §11）。
 *
 * 钉住的语义：
 *   ① 版本/集合：SCHEMA_VERSION=17、MIGRATIONS[16] 存在、lane_messages 是冷集合；
 *   ② 迁移只补默认值：remoteMode 推导、externalPr 浅合并、acceptanceTickets=true；
 *   ③ 旧外部 PR 卡按 merged/closed/open 映射 approval，已有 approval 绝不覆盖；
 *   ④ 旧 pull_requests.remote 镜像到 task.mergeRequest.remote（评论路由用）；
 *   ⑤ 旧工单补 category/refs/updatedAt/replyCount；
 *   ⑥ 迁移幂等、不覆盖用户值、其它字段原样保留；
 *   ⑦ 迁移中途抛错不写回（内存对象与磁盘都不半写）；
 *   ⑧ 领域层默认值/守卫/approval/PR 镜像（RT-00 §3）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, SCHEMA_VERSION, MIGRATIONS, COLD_KEYS, emptyState } from '../lib/core.js'
import { FlowDomain, DEFAULT_CONFIG, withDefaults } from '../lib/domain.js'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-schema17-'))
let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (e) { fails.push({ name, e }); console.log('  ✗ ' + name + NL + '    ' + String((e && e.message) || e)) }
}
const clone = (v) => JSON.parse(JSON.stringify(v))
const iso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s))
function v16(name, data) {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify({ schemaVersion: 16, ...data }))
  return file
}
const GH = { kind: 'github', owner: 'o', repo: 'r' }
const GT = { kind: 'gitea', owner: 'o', repo: 'r' }

// ---- A：常量与集合 ---------------------------------------------------------
await t('① schema 17 常量：MIGRATIONS[16]、lane_messages 进冷集合', () => {
  assert.equal(SCHEMA_VERSION, 17)
  assert.equal(typeof MIGRATIONS[16], 'function', '16→17 的迁移键是当前版本 16')
  assert.ok(COLD_KEYS.includes('lane_messages'), 'lane_messages 是低频路径，必须进冷集合')
  const s = emptyState()
  assert.deepEqual(s.lane_messages, [])
  assert.equal(s.seq.laneMsg, 0)
})

await t('② v16 空库加载后落到 17：lane_messages=[]、seq.laneMsg=0，且冷集合不落热文件', async () => {
  const f = v16('empty.json', {})
  const st = new Store(f)
  await st.load()
  assert.equal(st.state.schemaVersion, 17)
  assert.deepEqual(st.state.lane_messages, [])
  assert.equal(st.state.seq.laneMsg, 0)
  const hot = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(hot.schemaVersion, 17, '迁移后要立刻落盘（否则每次启动重放）')
  assert.equal(hot.lane_messages, undefined, 'lane_messages 属冷集合，不进热文件')
  assert.equal(hot.seq.laneMsg, 0)

  // 已有的 laneMsg 计数与消息不被覆盖
  const f2 = v16('seq.json', { seq: { task: 4, laneMsg: 7 }, lane_messages: [{ id: 'lm1' }] })
  const st2 = new Store(f2)
  await st2.load()
  // lane_messages 是冷集合：老文件里的内容先拆进 ledger，按需装回（不占启动热数据）。
  await st2.ledgerReady()
  assert.equal(st2.state.seq.task, 4)
  assert.equal(st2.state.seq.laneMsg, 7)
  assert.deepEqual(st2.state.lane_messages, [{ id: 'lm1' }])
})

// ---- B：remoteMode / externalPr / acceptanceTickets -----------------------
await t('③ remoteMode 推导：只在 config 有 remote 且任一远程开关为 true 时开', async () => {
  const f = v16('projects.json', {
    projects: {
      p1: { id: 'p1', config: { remote: GH, recordIssues: true } },
      p2: { id: 'p2', config: { recordIssues: true } },
      p3: { id: 'p3', config: { remote: GH, pushRemote: true } },
      p4: { id: 'p4', config: { recordPulls: true } },
      p5: { id: 'p5', config: { remote: GH } },
      p6: { id: 'p6', config: { remote: GH, recordIssues: true, remoteMode: false } },
      p7: { id: 'p7', config: { remote: GH, recordIssues: true, externalPr: { autoMerge: true, extra: 'keep' }, acceptanceTickets: false } },
      p8: { id: 'p8', config: {} },
      p9: { id: 'p9' },
    },
  })
  const st = new Store(f)
  await st.load()
  const cfg = (id) => st.state.projects[id].config
  assert.equal(cfg('p1').remoteMode, true, '有 remote + recordIssues → 远程模式')
  assert.equal(cfg('p2').remoteMode, false, '没有 remote 不能进远程模式')
  assert.equal(cfg('p3').remoteMode, true, '有 remote + pushRemote → 远程模式')
  assert.equal(cfg('p4').remoteMode, false, '只有 recordPulls 没有 remote → 本地')
  assert.equal(cfg('p5').remoteMode, false, '坐标在但没有任何远程开关 → 本地')
  assert.equal(cfg('p6').remoteMode, false, '用户显式写 false 不被推导覆盖')
  assert.equal(cfg('p7').remoteMode, true)
  // externalPr：缺省补 {autoMerge:false}；已有对象只补 autoMerge，不动用户键
  assert.deepEqual(cfg('p1').externalPr, { autoMerge: false })
  assert.deepEqual(cfg('p7').externalPr, { autoMerge: true, extra: 'keep' })
  // acceptanceTickets：缺省 true，用户写 false 保留
  assert.equal(cfg('p1').acceptanceTickets, true)
  assert.equal(cfg('p7').acceptanceTickets, false)
  // 连 config 都没有的项目也要有默认值
  assert.equal(cfg('p9').remoteMode, false)
  assert.deepEqual(cfg('p9').externalPr, { autoMerge: false })
  assert.equal(cfg('p9').acceptanceTickets, true)
})

// ---- C：外部 PR 卡的 approval 映射 ---------------------------------------
await t('④ kind=external-pr：merged/done→approved，closed/cancelled→closed，open→pending', async () => {
  const f = v16('external.json', {
    projects: { p: { id: 'p', config: {} } },
    tasks: {
      T1: { id: 'T1', projectId: 'p', kind: 'external-pr', column: 'merging', phase: 'merge-ready', external: { state: 'merged', number: 1 } },
      T2: { id: 'T2', projectId: 'p', kind: 'external-pr', column: 'done', external: { state: 'open', number: 2 } },
      T3: { id: 'T3', projectId: 'p', kind: 'external-pr', column: 'merging', external: { state: 'closed', number: 3 } },
      T4: { id: 'T4', projectId: 'p', kind: 'external-pr', column: 'cancelled', external: { state: 'open', number: 4 } },
      T5: { id: 'T5', projectId: 'p', kind: 'external-pr', column: 'merging', external: { state: 'open', number: 5 } },
      T6: { id: 'T6', projectId: 'p', kind: 'external-pr', column: 'done', external: { state: 'merged', number: 6, approval: { status: 'pending', by: 'human', at: '2026-01-01T00:00:00.000Z' } } },
      T7: { id: 'T7', projectId: 'p', kind: 'external-pr', column: 'merging', external: null },
      T8: { id: 'T8', projectId: 'p', kind: 'card', column: 'done' },
      T9: { id: 'T9', projectId: 'p', kind: 'external-pr', column: 'merging', external: { number: 9, approval: { status: 'approved', by: 'alice', at: '2026-01-02T00:00:00.000Z' }, approvalHandledAt: '2026-01-03T00:00:00.000Z' } },
    },
  })
  const st = new Store(f)
  await st.load()
  const T = (id) => st.state.tasks[id]
  assert.equal(T('T1').external.approval.status, 'approved')
  assert.equal(T('T1').external.approval.by, 'migration')
  assert.ok(iso(T('T1').external.approval.at))
  assert.equal(T('T2').external.approval.status, 'approved', 'column=done 视为已批')
  assert.equal(T('T3').external.approval.status, 'closed')
  assert.equal(T('T4').external.approval.status, 'closed', 'column=cancelled 视为已关闭')
  assert.equal(T('T5').external.approval.status, 'pending')
  assert.equal(T('T5').external.approval.by, null)
  assert.equal(T('T5').external.approval.at, null)
  assert.equal(T('T6').external.approval.status, 'pending', '已有 approval 绝不覆盖（哪怕列是 done）')
  assert.equal(T('T6').external.approval.by, 'human')
  assert.equal(T('T7').external.approval.status, 'pending', 'external=null 时的旧卡也补出 approval')
  assert.equal(T('T8').external, undefined, '普通卡不写 external（迁移只补 external-pr 卡）')
  assert.equal(T('T8').external?.approval, undefined)
  assert.equal(T('T9').external.approval.status, 'approved')
  assert.equal(T('T9').external.approvalHandledAt, '2026-01-03T00:00:00.000Z', '已有处理时间保留')
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T9']) {
    assert.ok(Object.prototype.hasOwnProperty.call(T(id).external, 'approvalHandledAt'), id + ' 必须有 approvalHandledAt 键')
  }
  assert.equal(T('T5').external.approvalHandledAt, null)
  // 迁移不改既有语义
  assert.equal(T('T1').column, 'merging')
  assert.equal(T('T2').column, 'done')
})

// ---- D：PR remote 镜像到 task.mergeRequest.remote -------------------------
await t('⑤ 旧 pull_requests.remote 镜像到 task.mergeRequest.remote（按 taskId 取最后一条）', async () => {
  const prRemote1 = { source: 'github', number: 11, url: 'https://github.com/o/r/pull/11', state: 'open', merged: false, mergeCommitSha: null }
  const f = v16('pr-mirror.json', {
    tasks: {
      T1: { id: 'T1', projectId: 'p', column: 'merging', mergeRequest: { id: 'pr_1', headSha: 'sha-1', status: 'open', files: ['a.js'] } },
      T2: { id: 'T2', projectId: 'p', column: 'merging', mergeRequest: null },
      T3: { id: 'T3', projectId: 'p', column: 'merging', mergeRequest: { id: 'pr_3', status: 'open' } },
      T4: { id: 'T4', projectId: 'p', column: 'merging', mergeRequest: { id: 'pr_4', remote: { number: 4, url: 'keep' } } },
      T5: { id: 'T5', projectId: 'p', column: 'merging', mergeRequest: { id: 'pr_5' } },
    },
    pull_requests: {
      pr_1: { id: 'pr_1', taskId: 'T1', status: 'open', remote: prRemote1 },
      pr_2: { id: 'pr_2', taskId: 'T2', status: 'open', remote: { number: 2, url: 'u2', state: 'open', merged: false, mergeCommitSha: null } },
      pr_5: { id: 'pr_5', taskId: 'T5', status: 'open', remote: { number: 5, url: 'u5', state: 'open', merged: false, mergeCommitSha: null } },
      pr_9: { id: 'pr_9', taskId: 'T5', status: 'merged', remote: { number: 9, url: 'u9', state: 'merged', merged: true, mergeCommitSha: 'sha-9' } },
      pr_4: { id: 'pr_4', taskId: 'T4', status: 'open', remote: { number: 4, url: 'u4', state: 'open', merged: false, mergeCommitSha: null } },
    },
  })
  const st = new Store(f)
  await st.load()
  const task = (id) => st.state.tasks[id]
  assert.deepEqual(task('T1').mergeRequest.remote, { number: 11, url: prRemote1.url, state: 'open', merged: false, mergeCommitSha: null })
  assert.equal(task('T1').mergeRequest.id, 'pr_1', '既有 mergeRequest 字段原样保留')
  assert.deepEqual(task('T1').mergeRequest.files, ['a.js'])
  assert.equal(task('T2').mergeRequest, null, 'mergeRequest 不是对象时不要凭空造')
  assert.deepEqual(task('T3').mergeRequest, { id: 'pr_3', status: 'open' }, '没有 remote PR 的卡不补')
  assert.deepEqual(task('T4').mergeRequest.remote, { number: 4, url: 'keep' }, '已有 remote 不覆盖')
  assert.deepEqual(task('T5').mergeRequest.remote, { number: 9, url: 'u9', state: 'merged', merged: true, mergeCommitSha: 'sha-9' }, '同一 taskId 取最后一条 PR')
  // 只读 PR 表，不改 state
  assert.deepEqual(st.state.pull_requests.pr_1.remote, prRemote1)
  assert.equal(st.state.pull_requests.pr_9.remote.state, 'merged')
})

// ---- E：human_inbox 补 category/refs/updatedAt/replyCount ----------------
await t('⑥ human_inbox：category 按 kind 映射，refs/updatedAt/replyCount 补齐且不覆盖', async () => {
  const f = v16('inbox.json', {
    human_inbox: [
      { id: 'hi1', kind: 'risk', taskId: 'T1', createdAt: '2026-01-01T00:00:00.000Z', replies: [{ at: 'a' }, { at: 'b' }] },
      { id: 'hi2', kind: 'blocked', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'hi3', kind: 'decision', taskId: 'T3', createdAt: '2026-01-03T00:00:00.000Z', replies: [] },
      { id: 'hi4', kind: 'info', createdAt: '2026-01-04T00:00:00.000Z' },
      { id: 'hi5', kind: 'error', createdAt: '2026-01-05T00:00:00.000Z' },
      { id: 'hi6', kind: 'whatever', createdAt: '2026-01-06T00:00:00.000Z' },
      { id: 'hi7', kind: 'risk', taskId: 'T7', category: 'external-pr', refs: [{ kind: 'pr', id: '7' }], updatedAt: '2026-03-03T00:00:00.000Z', replyCount: 4, createdAt: '2026-01-07T00:00:00.000Z', replies: [1, 2, 3] },
    ],
  })
  const st = new Store(f)
  await st.load()
  const item = (id) => st.state.human_inbox.find((x) => x.id === id)
  assert.equal(item('hi1').category, 'approval')
  assert.equal(item('hi2').category, 'blocked')
  assert.equal(item('hi3').category, 'decision')
  assert.equal(item('hi4').category, 'info')
  assert.equal(item('hi5').category, 'info')
  assert.equal(item('hi6').category, 'info', '未知 kind 兜底 info')
  assert.equal(item('hi7').category, 'external-pr', '已有 category 保留')
  assert.deepEqual(item('hi1').refs, [{ kind: 'task', id: 'T1', label: 'T1', url: null }])
  assert.deepEqual(item('hi2').refs, [], '没有 taskId 时 refs=[]')
  assert.deepEqual(item('hi7').refs, [{ kind: 'pr', id: '7' }], '已有 refs 保留')
  assert.equal(item('hi1').updatedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(item('hi7').updatedAt, '2026-03-03T00:00:00.000Z', '已有 updatedAt 保留')
  assert.equal(item('hi1').replyCount, 2)
  assert.equal(item('hi2').replyCount, 0, '没有 replies 时 0')
  assert.equal(item('hi7').replyCount, 4, '已有 replyCount 保留')
})

// ---- F：幂等 / 不覆盖 / 其它字段不变 -------------------------------------
await t('⑦ 幂等：重复迁移结果完全一致，用户值与其它字段原样保留', () => {
  const input = {
    schemaVersion: 16,
    projects: {
      p: {
        id: 'p', name: 'P', workspacePath: '/x', customKey: { keep: true },
        config: { remoteMode: true, remote: GH, recordIssues: true, pushRemote: false, acceptanceTickets: false, externalPr: { autoMerge: true }, keepMe: 1 },
        lanes: { human: { workers: 1 } },
      },
      q: { id: 'q' },
    },
    tasks: {
      T: {
        id: 'T', projectId: 'p', kind: 'external-pr', column: 'done', phase: 'merged', mergeState: 'pending',
        external: { state: 'merged', approval: { status: 'rejected', by: 'human', at: '2026-01-01T00:00:00.000Z' }, approvalHandledAt: '2026-01-02T00:00:00.000Z' },
        plan: { revision: 2, text: 'plan' }, custom: [{ n: 1 }],
      },
    },
    human_inbox: [{ id: 'hi', kind: 'risk', taskId: 'T', category: 'decision', refs: [{ kind: 'pr', id: '9' }], updatedAt: '2026-02-02T00:00:00.000Z', replyCount: 9, replies: [1, 2], custom: 'x' }],
    pull_requests: { pr: { id: 'pr', taskId: 'T', remote: { number: 1, url: 'u', state: 'open', merged: false, mergeCommitSha: null }, status: 'open' } },
    seq: { task: 3, laneMsg: 7 },
    lane_messages: [{ id: 'lm_1', text: 'hi' }],
    runs: { r1: { id: 'r1', failure: null } },
    agents: { a1: { id: 'a1' } },
    events: [{ id: 'ev_1', type: 'x' }],
  }
  const once = MIGRATIONS[16](clone(input))
  assert.equal(once.schemaVersion, 17)
  assert.equal(once.projects.p.config.remoteMode, true, '用户写的 remoteMode 不被推导覆盖')
  assert.equal(once.projects.p.config.acceptanceTickets, false, '用户写的 acceptanceTickets 不被覆盖')
  assert.deepEqual(once.projects.p.config.externalPr, { autoMerge: true })
  assert.equal(once.projects.p.config.keepMe, 1)
  assert.deepEqual(once.projects.p.customKey, { keep: true })
  assert.deepEqual(once.projects.p.lanes, { human: { workers: 1 } })
  assert.equal(once.projects.q.config.remoteMode, false)
  assert.deepEqual(once.projects.q.config.externalPr, { autoMerge: false })
  assert.equal(once.projects.q.config.acceptanceTickets, true)
  assert.equal(once.tasks.T.external.approval.status, 'rejected', '已有审批不覆盖')
  assert.equal(once.tasks.T.external.approvalHandledAt, '2026-01-02T00:00:00.000Z')
  assert.deepEqual(once.tasks.T.plan, { revision: 2, text: 'plan' })
  assert.deepEqual(once.tasks.T.custom, [{ n: 1 }])
  assert.equal(once.tasks.T.column, 'done')
  assert.equal(once.tasks.T.phase, 'merged')
  assert.equal(once.human_inbox[0].category, 'decision')
  assert.deepEqual(once.human_inbox[0].refs, [{ kind: 'pr', id: '9' }])
  assert.equal(once.human_inbox[0].updatedAt, '2026-02-02T00:00:00.000Z')
  assert.equal(once.human_inbox[0].replyCount, 9)
  assert.equal(once.human_inbox[0].custom, 'x')
  assert.deepEqual(once.pull_requests.pr.remote, { number: 1, url: 'u', state: 'open', merged: false, mergeCommitSha: null }, 'PR remote 不改 state')
  assert.deepEqual(once.seq, { task: 3, laneMsg: 7 })
  assert.deepEqual(once.lane_messages, [{ id: 'lm_1', text: 'hi' }])
  assert.deepEqual(once.runs, input.runs)
  assert.deepEqual(once.agents, input.agents)
  assert.deepEqual(once.events, input.events)
  // 幂等：第二遍（即使输入已经是 17）结果完全一致
  const twice = MIGRATIONS[16](clone(once))
  assert.deepEqual(twice, once)
})

// ---- G：迁移中途抛错不写回 ------------------------------------------------
await t('⑧ 迁移中途抛错：输入对象不被半写，磁盘与内存状态都不变', async () => {
  const input = {
    schemaVersion: 16,
    projects: { p: { id: 'p', config: { remote: GH, recordIssues: true } } },
    tasks: { T: { id: 'T', projectId: 'p', kind: 'external-pr', column: 'done', external: { state: 'merged' } } },
    pull_requests: {},
    human_inbox: [42],
  }
  const pristine = clone(input)
  assert.throws(() => MIGRATIONS[16](input), /human_inbox/)
  assert.deepEqual(input, pristine, '迁移抛错时不得把默认值写进输入对象')
  assert.equal(input.projects.p.config.remoteMode, undefined, 'projects 阶段也不能留下半写痕迹')

  // 磁盘级：load 失败不得落盘，内存状态保持构造时的样子
  const f = join(dir, 'bad.json')
  writeFileSync(f, JSON.stringify(input))
  const raw = readFileSync(f, 'utf8')
  const st = new Store(f)
  const before = clone(st.state)
  await assert.rejects(st.load(), /human_inbox/)
  assert.equal(readFileSync(f, 'utf8'), raw, '迁移失败不得改写磁盘文件')
  assert.deepEqual(st.state, before, '迁移失败不得改内存状态')
})

// ---- H：领域层默认值 + 守卫 + approval + PR 镜像 -------------------------
const flowFile = join(dir, 'flow.json')
const store = new Store(flowFile)
await store.load()
const domain = new FlowDomain(store)
const project = await domain.ensureProject({ workspacePath: join(dir, 'repo-main'), name: 'P' })

await t('⑨ 默认配置：remoteMode=false / externalPr={autoMerge:false} / acceptanceTickets=true', () => {
  assert.equal(DEFAULT_CONFIG.remoteMode, false)
  assert.deepEqual(DEFAULT_CONFIG.externalPr, { autoMerge: false })
  assert.equal(DEFAULT_CONFIG.acceptanceTickets, true)
  // 老开关全部保留
  for (const [k, v] of Object.entries({ recordIssues: false, recordPulls: false, pushRemote: false, closePullOnMerge: true, autoLane: undefined, autoAccept: false, autoMerge: false })) {
    if (v !== undefined) assert.equal(DEFAULT_CONFIG[k], v, k + ' 默认值不能变')
  }
  const base = withDefaults({})
  assert.equal(base.remoteMode, false)
  assert.deepEqual(base.externalPr, { autoMerge: false })
  assert.equal(base.acceptanceTickets, true)
  // remoteMode/acceptanceTickets 只在 undefined 时补
  assert.equal(withDefaults({ remoteMode: true }).remoteMode, true)
  assert.equal(withDefaults({ remoteMode: false }).remoteMode, false)
  assert.equal(withDefaults({ acceptanceTickets: false }).acceptanceTickets, false)
  // externalPr 浅合并：默认键不能因为用户只写一个键就丢
  assert.deepEqual(withDefaults({ externalPr: { autoMerge: true } }).externalPr, { autoMerge: true })
  assert.deepEqual(withDefaults({ externalPr: {} }).externalPr, { autoMerge: false })
  assert.deepEqual(withDefaults({ externalPr: null }).externalPr, { autoMerge: false })
  const user = { externalPr: { autoMerge: true, extra: 'keep' } }
  const merged = withDefaults(user)
  assert.deepEqual(merged.externalPr, { autoMerge: true, extra: 'keep' })
  assert.deepEqual(user.externalPr, { autoMerge: true, extra: 'keep' }, 'withDefaults 不得改用户对象')
  assert.deepEqual(DEFAULT_CONFIG.externalPr, { autoMerge: false }, 'withDefaults 不得改共享默认对象')
})

await t('⑩ updateProjectConfig：false→true 必须坐标完整 + pushRemote + mergeSupported', async () => {
  const cfgOf = () => store.state.projects[project.id].config
  await assert.rejects(domain.updateProjectConfig(project.id, { remoteMode: true }, { role: 'human' }), /remote/)
  assert.equal(cfgOf().remoteMode, false, '守卫失败不得半写')
  await assert.rejects(domain.updateProjectConfig(project.id, { remoteMode: true, remote: { kind: 'github', owner: 'o' } }, { role: 'human' }), /remote/)
  await assert.rejects(domain.updateProjectConfig(project.id, { remoteMode: true, remote: GH, pushRemote: false }, { role: 'human' }), /pushRemote/)
  await assert.rejects(domain.updateProjectConfig(project.id, { remoteMode: true, remote: GT, pushRemote: true }, { role: 'human' }), /merge|remoteMode/)
  assert.equal(cfgOf().remoteMode, false)

  const on = await domain.updateProjectConfig(project.id, { remoteMode: true, remote: GH, pushRemote: true }, { role: 'human' })
  assert.equal(on.config.remoteMode, true)
  assert.deepEqual(on.config.remote, GH)
  // true→false 允许，且不删除 remote 坐标
  const off = await domain.updateProjectConfig(project.id, { remoteMode: false }, { role: 'human' })
  assert.equal(off.config.remoteMode, false)
  assert.deepEqual(off.config.remote, GH, '关闭远程模式不删除坐标/游标')
  assert.equal(off.config.pushRemote, true)
  // externalPr 也走浅合并
  const ext = await domain.updateProjectConfig(project.id, { externalPr: { autoMerge: true } }, { role: 'human' })
  assert.deepEqual(ext.config.externalPr, { autoMerge: true })
})

await t('⑪ 迁移推导出的 remoteMode=true（但 pushRemote=false）不被后续配置写入误伤', async () => {
  const f = v16('legacy-project.json', {
    projects: {
      lp: { id: 'lp', name: 'legacy', workspacePath: join(dir, 'legacy'), config: { remote: GH, recordIssues: true, pushRemote: false } },
    },
  })
  const st = new Store(f)
  await st.load()
  assert.equal(st.state.projects.lp.config.remoteMode, true)
  const d2 = new FlowDomain(st)
  const after = await d2.updateProjectConfig('lp', { defaultModel: 'm1' }, { role: 'human' })
  assert.equal(after.config.remoteMode, true, '守卫只管 false→true，不改已推导出来的值')
  assert.equal(after.config.defaultModel, 'm1')
  assert.equal(after.config.pushRemote, false)
})

await t('⑫ createTask(kind=external-pr)：lane=human、approval=pending，且尊重入参', async () => {
  const t1 = await domain.createTask(project.id, { title: '外部卡', kind: 'external-pr' })
  assert.equal(t1.lane, 'human', 'kind=external-pr 默认走人车道')
  assert.deepEqual(t1.external, { approval: { status: 'pending', by: null, at: null } })
  const seeded = { approval: { status: 'approved', by: 'seed', at: '2026-01-02T03:04:05.000Z' }, note: '预置' }
  const t2 = await domain.createTask(project.id, { title: '已批外部卡', kind: 'external-pr', external: seeded })
  assert.equal(t2.external.approval.status, 'approved', '入参已有的 approval 要尊重')
  assert.equal(t2.external.approval.by, 'seed')
  assert.equal(t2.external.note, '预置')
  const t3 = await domain.createTask(project.id, { title: '普通卡' })
  assert.equal(t3.external, null, '普通卡不带 external')
})

await t('⑬ createExternalPrTask：固定形状 + lane/visibility + 保留 approval + 幂等', async () => {
  const facts = { provider: 'github', number: 301, url: 'https://github.com/o/r/pull/301', headBranch: 'feature', baseBranch: 'main', headSha: 'sha-301', title: '外部 PR #301' }
  const human = await domain.createExternalPrTask(project.id, facts)
  assert.equal(human.kind, 'external-pr')
  assert.equal(human.lane, 'human')
  assert.equal(human.visibility, 'board')
  assert.equal(human.column, 'merging')
  assert.equal(human.phase, 'merge-ready')
  assert.equal(human.worktree, false)
  assert.equal(human.mergeState, 'pending')
  assert.equal(human.external.provider, 'github')
  assert.equal(human.external.number, 301)
  assert.equal(human.external.state, 'open')
  assert.deepEqual(human.external.approval, { status: 'pending', by: null, at: null })
  assert.equal(human.external.approvalHandledAt, null)

  // 审批后再入站（幂等锚点 originRef）：不得把 approval 冲掉
  await domain.approveExternal(human.id, { decision: 'approve', by: 'alice' }, { role: 'human', id: 'alice' })
  const again = await domain.createExternalPrTask(project.id, facts)
  assert.equal(again.id, human.id)
  assert.equal(store.state.tasks[human.id].external.approval.status, 'approved')

  // 入参已给 approval 时尊重（重放/导入用）
  const seeded = await domain.createExternalPrTask(project.id, { ...facts, number: 302, external: { approval: { status: 'approved', by: 'seed', at: '2026-01-03T00:00:00.000Z' } } })
  assert.equal(seeded.external.approval.status, 'approved')
  assert.equal(seeded.external.approval.by, 'seed')
  assert.equal(seeded.external.approvalHandledAt, null)

  // 自动车道显式传 lane='issue'
  const auto = await domain.createExternalPrTask(project.id, { ...facts, number: 303 }, { lane: 'issue' })
  assert.equal(auto.lane, 'issue')
  assert.equal(auto.visibility, 'auto')
})

await t('⑭ approveExternal：pending→approved/rejected、幂等、冲突抛错、只审计不挪卡', async () => {
  const a = await domain.createExternalPrTask(project.id, { provider: 'github', number: 310, title: 'A' })
  const before = store.state.events.filter((e) => e.type === 'external.approved').length
  const approved = await domain.approveExternal(a.id, { decision: 'approve', note: '看过了', by: 'alice' })
  assert.equal(approved.external.approval.status, 'approved')
  assert.equal(approved.external.approval.by, 'alice')
  assert.equal(approved.external.approval.note, '看过了')
  assert.ok(iso(approved.external.approval.at))
  assert.equal(approved.column, 'merging', '审批不得移动卡列')
  assert.equal(approved.phase, 'merge-ready')
  assert.equal(approved.mergeState, 'pending', '审批不等于合并')
  const evs = store.state.events.filter((e) => e.type === 'external.approved')
  assert.equal(evs.length, before + 1)
  const ev = evs[evs.length - 1]
  assert.equal(ev.payload.taskId, a.id)
  assert.equal(ev.payload.by, 'alice')
  assert.equal(ev.payload.at, approved.external.approval.at)

  // 幂等：同一个决定重复提交不改 at/by、不再发事件
  const at = approved.external.approval.at
  const idem = await domain.approveExternal(a.id, { decision: 'approved', by: 'bob' })
  assert.equal(idem.external.approval.by, 'alice', '幂等返回不改 by')
  assert.equal(idem.external.approval.at, at)
  assert.equal(store.state.events.filter((e) => e.type === 'external.approved').length, before + 1)

  // 冲突：approved 不能被改成 rejected
  await assert.rejects(domain.approveExternal(a.id, { decision: 'reject', by: 'mallory' }), /审批|approval|rejected/)
  assert.equal(store.state.tasks[a.id].external.approval.status, 'approved')

  // rejected 路径与字符串归一
  const b = await domain.createExternalPrTask(project.id, { provider: 'github', number: 311, title: 'B' })
  const rejected = await domain.approveExternal(b.id, { decision: 'reject', by: 'bob' })
  assert.equal(rejected.external.approval.status, 'rejected')
  assert.equal(rejected.external.approval.by, 'bob')
  const rejectedAgain = await domain.approveExternal(b.id, { decision: 'rejected' })
  assert.equal(rejectedAgain.external.approval.status, 'rejected')

  // 非法 decision / 非外部卡
  const c = await domain.createExternalPrTask(project.id, { provider: 'github', number: 312, title: 'C' })
  await assert.rejects(domain.approveExternal(c.id, { decision: 'maybe' }), /decision/)
  const plain = await domain.createTask(project.id, { title: '普通卡' })
  await assert.rejects(domain.approveExternal(plain.id, { decision: 'approved' }), /external-pr/)
  // by 缺省 = human
  const d = await domain.createExternalPrTask(project.id, { provider: 'github', number: 313, title: 'D' })
  const def = await domain.approveExternal(d.id, { decision: 'approve' })
  assert.equal(def.external.approval.by, 'human')
})

await t('⑮ attachPullRemote/syncPullRemote：新字段落 remote 并镜像到 task.mergeRequest.remote', async () => {
  const tk = await domain.createTask(project.id, { title: 'PR 镜像' })
  await domain.move(tk.id, 'claim', { role: 'human', id: 'h' })
  const pr = await domain.openPullRequest(tk.id, { headSha: 'sha-pr-1', baseSha: 'sha-base', branch: 'flow/T-1' })
  await domain.attachPullRemote(pr.id, {
    number: 7, url: 'https://github.com/o/r/pull/7', source: 'github', state: 'open',
    author: 'alice', headRepo: 'alice/r', baseRef: 'main', headRef: 'feature', mergeableState: 'clean',
  })
  const live = store.state.pull_requests[pr.id]
  for (const [k, v] of Object.entries({ author: 'alice', headRepo: 'alice/r', baseRef: 'main', headRef: 'feature', mergeableState: 'clean' })) {
    assert.equal(live.remote[k], v, 'pr.remote.' + k)
  }
  // 老字段仍在
  assert.equal(live.remote.number, 7)
  assert.equal(live.remote.merged, false)
  assert.equal(live.remote.mergeCommitSha, null)
  assert.ok(iso(live.remote.at))
  // 镜像：remoteThreadFor 不扫 pull_requests 也能拿到 number
  const mirror = store.state.tasks[tk.id].mergeRequest
  assert.ok(mirror && mirror.remote, 'task.mergeRequest.remote 必须补齐')
  assert.equal(mirror.remote.number, 7)
  assert.equal(mirror.remote.author, 'alice')
  assert.equal(mirror.id, pr.id, '既有 mergeRequest 字段不能被镜像覆盖')
  // 同步：更新同一份事实，未给的新字段保留旧值
  await domain.syncPullRemote(pr.id, { merged: true, state: 'merged', mergeCommitSha: 'sha-merge-7', mergeableState: 'clean', reviews: [{ state: 'APPROVED' }] })
  const synced = store.state.pull_requests[pr.id]
  assert.equal(synced.remote.merged, true)
  assert.equal(synced.remote.mergeCommitSha, 'sha-merge-7')
  assert.equal(synced.remote.number, 7, 'sync 不得丢编号')
  assert.equal(synced.remote.author, 'alice', 'sync 未给 author 时保留旧值')
  assert.equal(synced.remote.headRepo, 'alice/r')
  assert.deepEqual(synced.remote.reviews, [{ state: 'APPROVED' }])
  assert.equal(store.state.tasks[tk.id].mergeRequest.remote.merged, true)
  assert.equal(store.state.tasks[tk.id].mergeRequest.remote.mergeCommitSha, 'sha-merge-7')
  // sync 显式给新字段时覆盖
  await domain.syncPullRemote(pr.id, { merged: true, state: 'merged', author: 'bob', headRepo: 'fork/r', baseRef: 'release', headRef: 'topic' })
  const synced2 = store.state.pull_requests[pr.id]
  assert.equal(synced2.remote.author, 'bob')
  assert.equal(synced2.remote.headRepo, 'fork/r')
  assert.equal(synced2.remote.baseRef, 'release')
  assert.equal(synced2.remote.headRef, 'topic')
  assert.equal(store.state.tasks[tk.id].mergeRequest.remote.author, 'bob')
})

console.log(NL + pass + ' 通过，' + fails.length + ' 失败')
if (fails.length) {
  for (const f of fails) console.log('- ' + f.name + ': ' + String((f.e && f.e.stack) || f.e).split(NL).slice(0, 3).join(NL))
  process.exit(1)
}
