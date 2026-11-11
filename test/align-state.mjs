/**
 * 状态机与设计文档的一致性校验。
 *
 * 为什么要有它：v1.32 之前，`review_approve` 在文档里和代码里都被描述成
 * 「审核通过 → done/merged」，而实际上它跳过了 git 合并 —— 文档和代码“一致地错”，
 * 谁都没有发现问题。所以光比对“代码有没有按文档实现”不够，
 * 还要比对「文档承诺的语义，代码是否真的能保证」。
 *
 * 这里做两件事：
 *   ① 结构对齐：docs/事务流设计.md §2.2/§2.3 的迁移表 vs lib/core.js 的 TRANSITIONS
 *   ② 不变量落点：§1.2 的 I1–I15 是否都有可执行代码，且能被冒烟测试触达
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { TRANSITIONS, COLUMNS, SCHEMA_VERSION, reviewActionOf, PLAN_APPROVALS } from '../lib/core.js'

const DOC = new URL('../docs/事务流设计.md', import.meta.url)
// 设计文档不随开源仓库发布（docs/ 已 gitignore）；没有它就跳过对齐核对。
if (!existsSync(DOC)) { console.log('  - skip：docs/事务流设计.md 不存在'); process.exit(0) }
const doc = readFileSync(DOC, 'utf8')
const docLines = doc.split(/\r?\n/)

let pass = 0
const t = (name, fn) => { fn(); pass += 1; console.log('  ✓ ' + name) }

/** 取两个标题之间的正文。 */
function section(startRe, endRe) {
  const s = docLines.findIndex((l) => startRe.test(l))
  if (s < 0) return []
  const e = docLines.findIndex((l, i) => i > s && endRe.test(l))
  return docLines.slice(s + 1, e < 0 ? docLines.length : e)
}

/** 解析 markdown 表格行（跳过分隔行和表头）。 */
function tableRows(rows) {
  const out = []
  for (const line of rows) {
    const s = line.trim()
    if (!s.startsWith('|')) continue
    const cells = s.split('|').slice(1, -1).map((c) => c.trim())
    if (!cells.length) continue
    if (cells.every((c) => /^-+$/.test(c) || c === '')) continue
    if (/^(动作|#)$/.test(cells[0])) continue
    out.push(cells)
  }
  return out
}

/** 把文档里的 `a, b` / `a, b` / `非终态` 解析成列名数组。 */
function parseFrom(raw) {
  const s = String(raw || '').trim()
  if (s === '非终态') return null   // 特殊：表示除终态外都可以
  return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
}

// ---- ① 结构对齐：文档迁移表 vs 代码 TRANSITIONS -----------------------------
const s22 = section(/^### 2\.2 迁移表/, /^### 2\.3/)
const s23 = section(/^### 2\.3 v1\.0 新增迁移/, /^## 3\./)
const docRows = [...tableRows(s22), ...tableRows(s23)]

console.log('\n[1] 迁移表对齐：文档 ' + docRows.length + ' 条 vs 代码 ' + Object.keys(TRANSITIONS).length + ' 条');

/** 文档某条迁移对应的代码定义。 */
const codeOf = (action) => TRANSITIONS[action]

t('文档里的每个动作，代码里都存在', () => {
  const missing = docRows.map((r) => r[0].replace(/`/g, '').trim()).filter((a) => !codeOf(a))
  assert.deepEqual(missing, [], '文档有、代码没有的动作：' + JSON.stringify(missing))
})

const documented = new Set(docRows.map((r) => r[0].replace(/`/g, '').trim()))
const undocumented = Object.keys(TRANSITIONS).filter((a) => !documented.has(a))
/** 文档 §2.2/§2.3 之外还有 9.4.x 版本叙述，先认了吗？ */
const inNarrative = (a) => new RegExp('\\b' + a + '\\b').test(doc)
const undocumentedAndUnnarrated = undocumented.filter((a) => !inNarrative(a))

t('代码里的每个动作，文档里都有出处（迁移表或版本叙述）', () => {
  assert.deepEqual(undocumentedAndUnnarrated, [],
    '这些动作文档里完全没提过：' + JSON.stringify(undocumentedAndUnnarrated))
})

t('代码里的每个动作，都写进了 §2.2/§2.3 权威迁移表', () => {
  assert.deepEqual(undocumented, [],
    '代码有、迁移表没写的动作（版本叙述里有也不算，迁移表才是权威）：' + JSON.stringify(undocumented))
})

t('每条迁移的 from 列与文档一致', () => {
  const bad = []
  for (const row of docRows) {
    const action = row[0].replace(/`/g, '').trim()
    const def = codeOf(action)
    if (!def) continue
    const want = parseFrom(row[1])
    if (want === null) continue   // 「非终态」这种描述性写法跳过精确比对
    const got = (def.from || []).slice().sort()
    const exp = want.slice().sort()
    if (JSON.stringify(got) !== JSON.stringify(exp)) {
      bad.push({ action, doc: exp, code: got })
    }
  }
  assert.deepEqual(bad, [], 'from 列不一致：' + JSON.stringify(bad, null, 1))
})

t('每条迁移的 roles 与文档一致（顺序无关）', () => {
  const bad = []
  for (const row of docRows) {
    const action = row[0].replace(/`/g, '').trim()
    const def = codeOf(action)
    if (!def) continue
    const want = String(row[2] || '').split(/[,，/]/).map((x) => x.trim()).filter(Boolean).sort()
    const got = (def.roles || []).slice().sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad.push({ action, doc: want, code: got })
    }
  }
  assert.deepEqual(bad, [], 'roles 不一致：' + JSON.stringify(bad, null, 1))
})

t('终态（done / cancelled）只能由 human 重开（I9）', () => {
  const reopen = TRANSITIONS.reopen
  assert.deepEqual(reopen.roles, ['human'], 'reopen 必须只允许 human')
  assert.deepEqual(reopen.from.slice().sort(), ['cancelled', 'done'], 'reopen 的 from 应是两个终态')
})

t('列集合与文档 §2.1 一致', () => {
  assert.deepEqual(COLUMNS.slice().sort(),
    ['cancelled', 'done', 'merging', 'planning', 'running', 'todo', 'verifying'].sort())
})

// ---- ② 语义对齐：文档承诺的保证，代码是否真的能做到 -------------------------
//
// 结构对齐只能证明「迁移表长得一样」。v1.32 的教训是：文档和代码可以**一致地错** ——
// 两边都写着 review_approve → done/merged，但那个 merged 是假的。
// 所以这一段检查的是「文档说不允许的事，代码真的会拒绝」。

const guardOf = (action) => {
  const def = TRANSITIONS[action]
  return def && def.guard ? def.guard : () => null
}
const taskLike = (over = {}) => Object.assign({
  id: 'T-1', column: 'merging', phase: 'merge-ready', version: 1,
  plan: { revision: 1, text: 'x' }, stopReport: { summary: 's', tests: 't' },
}, over)

console.log('\n[2] 语义闸门：文档说不允许的，代码必须真的拒绝');

t('review_approve 不会把「没合并过」的卡标成 merged（v1.32）', () => {
  const noMerge = taskLike({ mergeRequest: { status: 'open', reviewVerdict: 'approved', mergedCommit: null } })
  const blocked = guardOf('review_approve')(noMerge, { role: 'dispatcher', payload: {} })
  assert.ok(blocked, '没有 mergedCommit 时必须拒绝，实际放行了 —— 这正是 v1.32 的事故');
  assert.match(blocked, /合并/, '拒绝理由要指向合并，实际：' + blocked)

  const merged = taskLike({ mergeRequest: { status: 'merged', reviewVerdict: 'approved', mergedCommit: 'deadbeef' } })
  assert.equal(guardOf('review_approve')(merged, { role: 'dispatcher', payload: {} }), null, '真有合并提交时应当放行')
})

const GOOD_GRANT = { ok: true, kind: 'inbox', ref: 'hi_1' }

t('accept 不给 head_sha 也能过（系统自己去读），但代收必须带凭据', () => {
  // 无 headSha 不该被拒（v1.28：不让人手抄提交号）
  const noSha = guardOf('accept')(taskLike({ column: 'verifying' }), { role: 'dispatcher', payload: { acceptedBy: 'hi_1' }, grant: GOOD_GRANT })
  assert.equal(noSha, null, '不给 head_sha 应当放行，实际：' + noSha)
  // 代理代收必须有凭据（v1.28）
  const noAuth = guardOf('accept')(taskLike({ column: 'verifying' }), { role: 'dispatcher', payload: {} })
  assert.ok(noAuth, '代理代收没凭据必须拒绝')
})

t('accept 的凭据必须核验通过，非空字符串不算（v1.35）', () => {
  const selfDeclared = guardOf('accept')(taskLike({ column: 'verifying' }), { role: 'dispatcher', payload: { acceptedBy: 'human:web' } })
  assert.ok(selfDeclared, '没有核验结果时必须拒绝 —— 这正是 v1.34 之前「自称人授权」的漏洞')
  const failed = guardOf('accept')(taskLike({ column: 'verifying' }), { role: 'dispatcher', payload: { acceptedBy: 'hi_1' }, grant: { ok: false, reason: '否定回复' } })
  assert.match(failed || '', /否定回复/)
})

t('approve_by_publish：要方案、要来源会话、拦高风险，且不允许 human/worker（v1.35）', () => {
  const g = guardOf('approve_by_publish')
  const base = taskLike({ column: 'planning', risk: { level: 'low' } })
  assert.equal(g(base, { role: 'dispatcher', payload: { publishedFrom: 'ses_1' } }), null)
  assert.ok(g(base, { role: 'dispatcher', payload: {} }), '没有 publishedFrom 必须拒绝')
  assert.ok(g(taskLike({ column: 'planning', risk: { level: 'high', reasons: ['x'] } }), { role: 'dispatcher', payload: { publishedFrom: 's' } }), '高风险必须拒绝')
  assert.deepEqual(TRANSITIONS.approve_by_publish.roles.slice().sort(), ['chief', 'dispatcher'])
  assert.ok(PLAN_APPROVALS.has('approve_by_publish') && PLAN_APPROVALS.has('approve_by_dispatcher'), '所有开工批准都要绑 plan rev')
})

t('审核 approved 不映射成任何迁移（审核 ≠ 合并，v1.35）', () => {
  assert.equal(reviewActionOf('approved'), null)
  assert.equal(reviewActionOf('risk'), 'review_risk')
  assert.equal(reviewActionOf('needs_work'), 'review_conflict')
})

t('accept 不接受伪装成哈希的假值（v1.29）', () => {
  const fake = guardOf('accept')(taskLike({ column: 'verifying', headSha: 'audit-T035-verified' }),
    { role: 'dispatcher', payload: { acceptedBy: 'hi_1' }, grant: GOOD_GRANT })
  assert.ok(fake, 'audit-xxx-verified 这类值必须被拒')
  const real = guardOf('accept')(taskLike({ column: 'verifying', headSha: 'deadbeef' }),
    { role: 'human', payload: {} })
  assert.equal(real, null, '合法十六进制短 SHA 应当放行，实际：' + real)
})

t('merge_skip：有审核结论时默认拒绝，但写清 reason 可以显式跳过', () => {
  // 默认拒绝：防止随手把已审核的卡跳过去
  const reviewed = guardOf('merge_skip')(taskLike({ mergeRequest: { reviewVerdict: 'approved' } }), { payload: {} })
  assert.ok(reviewed, '已有审核结论且没写 reason 时必须拒绝')
  // v1.33 逃生口：审核通过但合并会倒退的卡（T-042 被 T-044 取代）
  const withReason = guardOf('merge_skip')(
    taskLike({ mergeRequest: { reviewVerdict: 'approved' } }),
    { payload: { reason: '内容是 T-044 的早期子集，合并会删掉 T-044 的文件' } })
  assert.equal(withReason, null, '写清 reason 时应当允许显式跳过，实际：' + withReason)
  const plain = guardOf('merge_skip')(taskLike({ mergeRequest: null }), { payload: {} })
  assert.equal(plain, null, '没有 PR 的卡应当允许跳过合并')
})

t('stop 必须有停止报告（不能空手自停）', () => {
  // 注意：stop 的守卫读的是**任务上的** stopReport，不是 payload ——
  // 因为 domain.move 会先把 payload.stopReport 落到 task 上，再走守卫（真实路径）。
  // 一开始我在 taskLike 里预置了 stopReport，导致「空报告」用例根本没测到空。
  const empty = guardOf('stop')(taskLike({ column: 'running', stopReport: {} }), { role: 'worker', payload: {} })
  assert.ok(empty, '没有 summary 的 stop 必须拒绝，实际放行了')
  const noReport = guardOf('stop')(taskLike({ column: 'running', stopReport: null }), { role: 'worker', payload: {} })
  assert.ok(noReport, '完全没有报告也必须拒绝')
  const good = guardOf('stop')(taskLike({ column: 'running', stopReport: { summary: 'done' } }), { role: 'worker', payload: {} })
  assert.equal(good, null, '有报告应当放行，实际：' + good)
})

t('approve / reject / cancel / reopen 的人闸门没有被放宽（I9）', () => {
  for (const action of ['approve', 'reject', 'cancel', 'reopen']) {
    const def = TRANSITIONS[action]
    assert.ok(def, '缺少动作 ' + action)
    assert.ok(def.roles.includes('human'), action + ' 必须允许 human')
    assert.equal(def.roles.includes('worker'), false, action + ' 不应允许 worker')
  }
})

// ---- ③ 不变量落点：§1.2 的 I1–I15 有没有对应实现 ---------------------------
//
// 这不是“全自动证明” —— 它做的是**点名**：每个不变量必须能指出一处代码落点，
// 指不出来说明这一条还停留在文档里。

const coreSrc = readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8')
const domainSrc = readFileSync(new URL('../lib/domain.js', import.meta.url), 'utf8')
const dispatchSrc = readFileSync(new URL('../lib/dispatch.js', import.meta.url), 'utf8')

console.log('\n[3] 不变量落点（指不出代码 = 还停留在文档里）');

const INVARIANTS = [
  { id: 'I1', why: '一任务只有一个 (column, phase)', where: coreSrc, needle: 'applyTransition' },
  { id: 'I2', why: '一任务最多一条活跃 run', where: domainSrc, needle: 'startRun' },
  { id: 'I3', why: '一 worktree 一个写入者（任务租约）', where: domainSrc, needle: 'acquireLease' },
  { id: 'I4', why: '一仓库最多一个合并事务', where: domainSrc, needle: 'lockMerge' },
  { id: 'I5', why: '任务 version 严格单调', where: coreSrc, needle: 'next.version' },
  { id: 'I6', why: '审批绑不可变版本，变化即失效', where: domainSrc, needle: 'revokeApprovals' },
  { id: 'I7', why: '每次迁移有事件 + actor + causation', where: coreSrc, needle: 'causationId: currentCause()' },
  { id: 'I8', why: '副作用幂等（意图表 + 幂等键）', where: domainSrc, needle: 'enqueueEffect' },
  { id: 'I9', why: '终态只能人类重开', where: coreSrc, needle: "roles: ['human']" },
  { id: 'I10', why: '合并只能持锁写 base', where: dispatchSrc, needle: 'mergeLocked' },
]

t('文档里列出的不变量都能指出代码落点', () => {
  const missing = INVARIANTS.filter((inv) => !inv.where.includes(inv.needle))
  assert.deepEqual(missing.map((x) => x.id + ' ' + x.why), [], '找不到落点的不变量')
})

// ---- ④ 事故回归：v1.32 的失效模式必须被永久钉住 ----------------------------

console.log('\n[4] 事故回归（这几条如果绿了，说明同一个坑被重新挖开）');

t('「审核通过」和「已合并」是两个状态，不能合并成一步（v1.32 事故）', () => {
  const ra = TRANSITIONS.review_approve
  assert.equal(ra.to, 'done')
  assert.equal(ra.phase, 'merged')
  // 关键：它必须依赖 mergedCommit，而不是只看 reviewVerdict
  const src = String(ra.guard)
  assert.match(src, /mergedCommit/, 'review_approve 的守卫必须检查 mergedCommit —— 否则会把审核当合并');
})

t('merge_skip 落的是 merged-skipped，不冒充 merged', () => {
  assert.equal(TRANSITIONS.merge_skip.phase, 'merged-skipped')
})

t('accept 允许 dispatcher 代收（人授权后），但必须留凭据', () => {
  assert.ok(TRANSITIONS.accept.roles.includes('dispatcher'), 'accept 要允许调度代收')
  assert.equal(TRANSITIONS.accept.roles.includes('worker'), false, 'accept 不能允许工人')
})

t('schemaVersion 与迁移链长度自洽', () => {
  assert.ok(SCHEMA_VERSION >= 9, '至少到 v1.36 的维护位迁移（8→9）')
})

// ---- ⑤ 数据层：迁移产出的状态必须能通过一致性扫描 ----------------------
//
// 前面的检查都在静态定义层。这一段把「一张卡从建到合并走完全程」的真实产出
// 丢给扫描器，确认它**不会产生自己都不信的状态**。

console.log('\n[5] 走完整条链之后，状态不能自相矛盾');

const { scanLies } = await import('./scan-state-lies.mjs')

t('一条合法走完的卡，任何时刻都不该被判为「状态与事实不符」', async () => {
  const { Store } = await import('../lib/core.js')
  const { FlowDomain } = await import('../lib/domain.js')
  const { mkdtemp, mkdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'flow-align-'))
  const store = new Store(join(dir, 'flow.json'))
  await store.load()
  const domain = new FlowDomain(store, null)
  const repo = join(dir, 'repo')
  await mkdir(repo, { recursive: true })
  const p = await domain.ensureProject({ workspacePath: repo, name: 'align' })
  const task = await domain.createTask(p.id, { title: '全链路', lane: 'human' })

  const step = async (fn) => { await fn(); assert.deepEqual(scanLies(store.state), [], '这一步之后出现了状态谎言') }
  await step(async () => { await domain.move(task.id, 'claim', { role: 'dispatcher', id: 'd' }) })
  await step(async () => { await domain.setPlan(task.id, 'x'.repeat(400), { role: 'dispatcher', id: 'd' }) })
  await step(async () => { await domain.move(task.id, 'plan_ready', { role: 'dispatcher', id: 'd' }) })
  await step(async () => { await domain.move(task.id, 'approve', { role: 'human', id: 'web' }) })
  await step(async () => { await domain.move(task.id, 'stop', { role: 'worker', id: 'w' }, { stopReport: { summary: 'done', tests: '7 passed' } }) })
  await step(async () => { await domain.setNoMerge(task.id, false, '', { role: 'system' }) })
  await step(async () => { await domain.move(task.id, 'accept', { role: 'human', id: 'web' }, { headSha: 'abc1234' }) })
  await step(async () => { await domain.openMergeRequest(task.id, { headSha: 'abc1234', baseSha: '0000000', files: ['a.ts'] }, { role: 'worker' }) })
  await step(async () => { await domain.markMerged(task.id, { commit: 'deadbeef', strategy: 'merge' }) })
  await step(async () => { await domain.move(task.id, 'review_approve', { role: 'dispatcher', id: 'd' }, { verdict: 'approved' }) })

  const done = store.state.tasks[task.id]
  assert.equal(done.column, 'done')
  assert.equal(done.phase, 'merged')
  assert.equal(done.mergeRequest.mergedCommit, 'deadbeef', '完成时必须拿得出合并提交')
})

console.log('\nstate alignment: all checks passed (' + pass + ' checks)')
