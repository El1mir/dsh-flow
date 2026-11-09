/**
 * ui-02：视图模型（lib/view-model.js）。
 *
 * 这张测试钉住 8 件事，都是「界面说一套、状态机做一套」的入口：
 *   ① BADGE_ORDER 的顺序就是优先级（撞车时谁先说话），只有最后两枚进详情；
 *   ② 卡片最多 2 枚徽标（再多就把卡号/时间挤没了，看板是扫的不是读的）；
 *   ③ 溢出的那几枚要能数出来（more），否则"还有 3 个问题"就静默消失了；
 *   ④ 摘要行四级降级：blocked.reason > progress.blocker > progress.next > 阶段短语 > null；
 *   ⑤ 抽屉折叠默认值随列变化：验收清单只在 verifying / merging / done 展开；
 *   ⑥ 交付徽标：只有 delivered 静默，另外三种假完成必须出声，且与 panel 的镜像不漂移；
 *   ⑦ 高风险压过交付标（先看风险，再看落点）；
 *   ⑧ 纯函数：同输入两次 deepEqual、不改入参、返回值互不污染（ui-04 会在 render 里反复调）。
 *
 * 直接跑：node test/view-model.mjs
 */
import assert from 'node:assert/strict'
import { BADGE_ORDER, badgesFor, cardView, chipsFor, headlineFor } from '../lib/view-model.js'
import { deliveryStateOf } from '../lib/panel.js'

const NL = String.fromCharCode(10)
const BT = String.fromCharCode(96) // 反引号：merge 的 fix 用它圈命令，chip 标题里必须剥掉

/** 只填测试关心的字段：视图模型不该要求整张 store task。 */
const task = (patch) => Object.assign({ id: 'T-1', title: '一张卡', column: 'todo', phase: null }, patch || {})

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name) } catch (err) {
    fails.push({ name, err })
    console.log('  ✗ ' + name)
    console.log('    ' + String((err && err.message) || err).split(NL)[0])
  }
}

// ---------- ① 顺序与形状 ----------

await t('BADGE_ORDER 的顺序即优先级，且只有 lane / child 进详情', () => {
  assert.deepEqual(BADGE_ORDER.map((b) => b.key), [
    'blocked', 'merge-blocked', 'risk-high', 'grill-escalate', 'waiting-branch',
    'merge-pending', 'delivery', 'lane', 'child',
  ], '顺序变了 = 撞车时谁先说话变了，这是一次产品决定，不能顺手改')
  const seen = new Set()
  for (const b of BADGE_ORDER) {
    assert.equal(typeof b.key, 'string')
    assert.ok(b.key.length > 0, '徽标缺 key')
    assert.ok(!seen.has(b.key), '重复的 key：' + b.key)
    seen.add(b.key)
    assert.ok(typeof b.label === 'string' && b.label.length > 0, b.key + ' 缺 label')
    assert.ok(['ok', 'warn', 'bad', 'info'].indexOf(b.tone) >= 0, b.key + ' 的 tone 非法：' + b.tone)
    assert.ok(['card', 'detail'].indexOf(b.only) >= 0, b.key + ' 的 only 只能是 card / detail')
  }
  // 车道名与子卡进度是"打开后才知道"的背景，挂在卡上会把真正会变的几枚挤掉。
  assert.deepEqual(BADGE_ORDER.filter((b) => b.only === 'detail').map((b) => b.key), ['lane', 'child'])
  // badgesFor 必须严格按这张表的顺序吐（调用方靠顺序取"最该被看见的那枚"）。
  const t0 = task({ blocked: { reason: '分支被占用' }, risk: { level: 'high' }, phase: 'waiting-branch', lane: 'issue' })
  assert.deepEqual(badgesFor(t0).map((b) => b.key), ['blocked', 'risk-high', 'waiting-branch', 'lane'])
  for (const b of badgesFor(t0)) {
    assert.deepEqual(Object.keys(b).sort(), ['key', 'text', 'title', 'tone'], '徽标形状必须是 {key,text,tone,title}')
  }
})

// ---------- ②③ 截断与溢出计数 ----------

await t('卡片最多 2 枚徽标，按 BADGE_ORDER 取前两枚', () => {
  const t0 = task({
    blocked: { reason: '卡在权限' },
    mergeState: 'blocked', mergeReason: 'base-missing',
    risk: { level: 'high', reasons: ['改到公共接口'] },
    grill: { status: 'escalate', openForHuman: [{ question: '收不收？' }] },
    phase: 'waiting-branch',
  })
  const all = badgesFor(t0)
  assert.equal(all.length, 5, '这道题应该有 5 枚徽标：' + all.map((b) => b.key).join(','))
  const { chips, more } = chipsFor(t0)
  assert.equal(chips.length, 2)
  assert.deepEqual(chips.map((c) => c.key), ['blocked', 'merge-blocked'])
  assert.equal(more, 3, '没装下的是 risk-high / grill-escalate / waiting-branch')
  // 悬停解释里的命令不能带反引号（chip 的 title 是单行纯文本）。
  assert.equal(chips[1].title.indexOf(BT), -1, 'chip title 里不该有反引号：' + chips[1].title)
  // 默认值就是 2：调用方不传 max 时行为要一样。
  assert.deepEqual(chipsFor(t0, 2), chipsFor(t0))
})

await t('more 计数：max 可调、详情徽标既不占位也不计数', () => {
  const t0 = task({ blocked: { reason: 'x' }, risk: { level: 'high' }, mergeState: 'pending' })
  assert.equal(badgesFor(t0).length, 3)
  assert.deepEqual(chipsFor(t0, 0), { chips: [], more: 3 }, 'max=0 时三枚全部溢出')
  assert.equal(chipsFor(t0, 1).chips.length, 1)
  assert.equal(chipsFor(t0, 1).more, 2)
  assert.deepEqual(chipsFor(t0, 9), { chips: badgesFor(t0), more: 0 }, 'max 超过总数时全部装下、不溢出')
  assert.equal(chipsFor(t0, 'x').chips.length, 2, '非数字 max 回退到默认 2')
  assert.equal(chipsFor(t0, -1).chips.length, 0, '负数 max 夹到 0')

  // lane / child 是 only:'detail'：它们不能占卡片位置，也不能算进 more（否则角标说
  // "还有 2 枚"，点开却是车道名和子卡进度 —— 那会让人以为有 2 个真问题）。
  const detailOnly = task({ lane: 'issue', childProgress: { done: 1, total: 3 } })
  assert.deepEqual(badgesFor(detailOnly).map((b) => b.key), ['lane', 'child'])
  assert.deepEqual(chipsFor(detailOnly), { chips: [], more: 0 })
})

// ---------- ④ 摘要行 ----------

await t('headline 四级降级：blocked > blocker > next > 阶段短语 > null', () => {
  // 四级同时在场时只取最前一级：人先要"为什么不走了"，再要"下一步做什么"。
  const all = task({
    column: 'verifying', phase: 'awaiting-acceptance',
    blocked: { reason: '分支被占用' },
    progress: { state: 'blocked', blocker: '等登录', next: '重试一次' },
  })
  assert.deepEqual(headlineFor(all), { text: '分支被占用', tone: 'bad' })

  const onlyBlocker = task({ column: 'verifying', phase: 'awaiting-acceptance', progress: { state: 'blocked', blocker: '等登录', next: '重试一次' } })
  assert.deepEqual(headlineFor(onlyBlocker), { text: '等登录', tone: 'bad' }, '工人自己报的阻塞同样是阻塞')

  const onlyNext = task({ column: 'verifying', phase: 'awaiting-acceptance', progress: { state: 'on-track', next: '重试一次' } })
  assert.deepEqual(headlineFor(onlyNext), { text: '重试一次', tone: 'info' })

  const phaseOnly = task({ column: 'todo', phase: 'dispatched' })
  assert.deepEqual(headlineFor(phaseOnly), { text: '已交接', tone: 'muted' }, '阶段是背景，用最淡的一档')

  // 列本身已经写着这个阶段时不再重复（executing 的卡就在「执行中」列里）。
  assert.deepEqual(headlineFor(task({ column: 'running', phase: 'executing' })), { text: null, tone: 'muted' })
  assert.deepEqual(headlineFor(task({ column: 'verifying', phase: 'awaiting-acceptance' })), { text: null, tone: 'muted' })
  // 什么都没有时 text 是 null（不是空串）：空串会占掉一行高度。
  assert.deepEqual(headlineFor(task({})), { text: null, tone: 'muted' })
  assert.deepEqual(headlineFor(null), { text: null, tone: 'muted' }, '看板 loading 态也会调它')
  // 表里没有的 phase 原样吐出英文名，不静默吞掉 —— 至少让人看见有个新阶段。
  assert.deepEqual(headlineFor(task({ column: 'todo', phase: 'pondering' })), { text: 'pondering', tone: 'muted' })
})

// ---------- ⑤ 折叠默认值 ----------

await t('folds：验收清单随列展开，其余 12 项不随列变', () => {
  const STATIC = {
    progress: true, comments: 'recent', ticket: false, children: false, grill: false,
    note: false, plan: false, status: false, rewind: false, reply: false, stopReport: false, runs: false,
  }
  const wantKeys = Object.keys(STATIC).concat('acceptance').sort()
  for (const col of ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled']) {
    const folds = cardView(task({ column: col })).folds
    assert.deepEqual(Object.keys(folds).sort(), wantKeys, col + ' 的 folds 键表不全（ui-03 会按 key 渲染抽屉）')
  }
  // 走到验收 / 合并 / 完成时，验收清单就是当前主内容；其余列还没到那一步，展开只是占高度。
  for (const col of ['verifying', 'merging', 'done']) {
    assert.equal(cardView(task({ column: col })).folds.acceptance, true, col + ' 列应该展开验收清单')
  }
  for (const col of ['todo', 'planning', 'running', 'cancelled']) {
    assert.equal(cardView(task({ column: col })).folds.acceptance, false, col + ' 列应该折叠验收清单')
  }
  for (const k of Object.keys(STATIC)) {
    assert.deepEqual(cardView(task({ column: 'done' })).folds[k], STATIC[k], k + ' 不该随列变')
  }
  // 返回的是拷贝：渲染层改了上一个抽屉的折叠态，不能污染下一张卡。
  const dirty = cardView(task({ column: 'todo' })).folds
  dirty.acceptance = true
  dirty.progress = false
  assert.equal(cardView(task({ column: 'todo' })).folds.acceptance, false)
  assert.equal(cardView(task({ column: 'todo' })).folds.progress, true)
})

// ---------- ⑥ 交付徽标 ----------

await t('delivery 徽标：只有 delivered 静默，且与 panel 的 deliveryStateOf 不漂移', () => {
  const cases = [
    ['merged-skipped', '未合并', 'warn'],
    ['done-no-merge', '无可合', 'info'],
    ['merged-into-parent', '已合入父分支', 'info'],
    ['done-in-parent', '已合入父分支', 'info'], // v0.008：工作单元在父检出里提交，落点同样是父分支
  ]
  for (const [phase, text, tone] of cases) {
    const badge = badgesFor(task({ column: 'done', phase })).find((b) => b.key === 'delivery')
    assert.ok(badge, 'done/' + phase + ' 是假完成形态，必须出声')
    assert.equal(badge.text, text, phase + ' 的文案不对')
    assert.equal(badge.tone, tone, phase + ' 的配色不对')
    assert.ok(badge.title.length > 0, phase + ' 的徽标没有悬停解释')
  }
  // 真交付不出标：正常的 done 不需要噪音。
  assert.equal(badgesFor(task({ column: 'done', phase: 'merged' })).some((b) => b.key === 'delivery'), false)
  // 还在路上的卡更不该出交付标（在途的 phase 残留不代表落点）。
  assert.equal(badgesFor(task({ column: 'verifying', phase: 'merged' })).some((b) => b.key === 'delivery'), false)

  // 服务端投影过的卡自带 deliveryState：以它为准（老服务端没重启时两边的口径也不能分叉）。
  const projected = task({ column: 'done', phase: 'merged', deliveryState: 'skipped' })
  assert.equal(badgesFor(projected).find((b) => b.key === 'delivery').text, '未合并')

  // 漂移哨兵：同一组输入，view-model 的归类必须和 panel 的镜像（= core.deliveryState）一致。
  const matrix = [
    ['done', 'merged'], ['done', 'merged-skipped'], ['done', 'done-no-merge'],
    ['done', 'merged-into-parent'], ['done', 'done-in-parent'], ['done', null],
    ['verifying', 'merged'], ['verifying', 'awaiting-acceptance'], ['running', 'executing'],
    ['todo', null], ['cancelled', 'done-in-parent'],
  ]
  const TEXT_OF = { skipped: '未合并', 'no-merge': '无可合', 'merged-into-parent': '已合入父分支' }
  for (const [column, phase] of matrix) {
    const probe = { column, phase }
    const state = deliveryStateOf(probe)
    const badge = badgesFor(probe).find((b) => b.key === 'delivery')
    const want = TEXT_OF[state] || null
    assert.equal(badge ? badge.text : null, want, column + '/' + phase + '：panel 说 ' + state + '，view-model 的徽标对不上')
  }
})

// ---------- ⑦ 高风险优先于交付 ----------

await t('risk high 排在 delivery 前面，且把整张卡点红', () => {
  const t0 = task({ column: 'done', phase: 'merged-skipped', risk: { level: 'high', reasons: ['动了公共接口', '没有回滚方案'] } })
  assert.deepEqual(badgesFor(t0).map((b) => b.key), ['risk-high', 'delivery'], '高风险必须先说：落点是次要信息')
  const view = cardView(t0)
  assert.equal(view.chips[0].key, 'risk-high')
  assert.equal(view.chips[0].tone, 'bad')
  assert.equal(view.tone, 'bad', '卡整体是红的（交付标只是 warn）')
  assert.equal(view.chips[0].title, '动了公共接口；没有回滚方案')
  // 非 high 不出标：medium / low 是提示不是告警。
  assert.equal(badgesFor(task({ risk: { level: 'medium' } })).some((b) => b.key === 'risk-high'), false)
  assert.equal(badgesFor(task({ risk: {} })).some((b) => b.key === 'risk-high'), false)
})

// ---------- ⑧ 纯函数 ----------

await t('纯函数：同输入两次 deepEqual、不改入参、返回值互不污染', () => {
  const sample = task({
    column: 'verifying', phase: 'review-pending',
    blocked: null,
    mergeState: 'blocked', mergeReason: 'head-mismatch',
    risk: { level: 'high', reasons: ['改到公共接口'] },
    grill: { status: 'escalated', openForHuman: [{ question: 'a' }, { question: 'b' }] },
    progress: { state: 'on-track', next: '跑一遍测试' },
    lane: 'issue', childProgress: { done: 2, total: 3 },
    deliveryState: undefined,
  })
  const before = JSON.stringify(sample)
  const once = { badges: badgesFor(sample), chips: chipsFor(sample), headline: headlineFor(sample), view: cardView(sample) }
  const twice = { badges: badgesFor(sample), chips: chipsFor(sample), headline: headlineFor(sample), view: cardView(sample) }
  assert.deepEqual(once, twice, '同输入两次结果不一致（有隐藏状态 / Date / random?）')
  assert.equal(JSON.stringify(sample), before, '入参被改了')

  // 空输入不能炸：看板在 loading 态、抽屉关闭时都会调。
  for (const empty of [null, undefined, {}]) {
    assert.deepEqual(badgesFor(empty), [])
    assert.deepEqual(chipsFor(empty), { chips: [], more: 0 })
    assert.deepEqual(headlineFor(empty), { text: null, tone: 'muted' })
    assert.equal(cardView(empty).folds.progress, true)
    assert.equal(cardView(empty).folds.acceptance, false)
  }

  // 返回值互不污染：渲染层改上一张卡的 chips / folds，不能影响下一张。
  const v1 = cardView(sample)
  v1.chips.push({ key: 'x', text: 'x', tone: 'bad', title: '' })
  v1.folds.progress = false
  v1.headline.text = '被改了'
  const v2 = cardView(sample)
  assert.equal(v2.chips.length, v1.chips.length - 1)
  assert.equal(v2.folds.progress, true)
  assert.notEqual(v2.headline.text, '被改了')
})

if (fails.length) {
  console.log('FAIL view-model ' + fails.length + '/' + (pass + fails.length))
  process.exitCode = 1
} else {
  console.log('PASS view-model ' + pass + '/' + pass)
}
