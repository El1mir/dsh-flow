import assert from 'node:assert/strict'

/**
 * dsh-flow · 调度台视图的**真实渲染**冒烟测试。
 *
 * 为什么要有这个文件：
 * test/client.mjs 用的是 `useState: (init) => [init, () => {}]` —— 那是个空壳，
 * 组件函数**从头到尾一次都没有执行过**。于是「在 head 里引用了还没赋值的 v」
 * 这种崩溃能 100% 通过全部断言，然后线上白屏。
 *
 * 这里换一个会真的驱动渲染的假 React：
 *   - useState 带 setState，值变了会真的重新渲染；
 *   - useEffect 在渲染之后按序执行（模拟 commit 阶段）；
 *   - createElement 返回普通对象（不碰 DOM）。
 * 组件跑到 ready 分支、把整页架子建出来，抛错就当场失败。
 */

// ---- 假 React：够真，能驱动状态更新 ----------------------------------------
function makeReact() {
  const hookState = []
  const effectDeps = []
  let cursor = 0
  let effects = []
  let rerender = () => {}
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.length ? children : [] }
    },
    useState(init) {
      const i = cursor; cursor += 1
      if (hookState.length <= i) hookState[i] = typeof init === 'function' ? init() : init
      const set = (next) => {
        const val = typeof next === 'function' ? next(hookState[i]) : next
        if (val === hookState[i]) return
        hookState[i] = val
        rerender()
      }
      return [hookState[i], set]
    },
    useEffect(fn, deps) {
      // 必须做 deps 比较：真实 React 里 [] 依赖的 effect 只跑一次。
      // 不做比较的话，load() 每轮都重跑 → 每次都 setState → 永远不稳定，
      // 看起来像组件死循环，其实是测试替身的锅。
      const i = cursor; cursor += 1
      const prev = effectDeps[i]
      const changed = !prev || !deps || deps.length !== prev.length
        || deps.some((d, k) => d !== prev[k])
      effectDeps[i] = deps
      if (changed) effects.push({ fn, deps })
    },
    useCallback(fn) { return fn },
  }
  return {
    React,
    begin() { cursor = 0; effects = [] },
    drainEffects() { const list = effects; effects = []; for (const e of list) e.fn(); return list.length },
    onRerender(fn) { rerender = fn },
    // 重置 hook 槽位。**必须在新旧组件实例之间调用**：
    // 这个 harness 是模块级的，hooks 数组会跨实例残留，
    // 不重置的话新实例读到的是上一个实例的 state（表现为"数据是旧的"）。
    reset() { hookState.length = 0; effectDeps.length = 0; cursor = 0; effects = [] },
  };
}

// ---- 浏览器环境替身 --------------------------------------------------------
const parentMessages = []
const windowStub = {
  // 面板模式：地址栏**不能**带 flowSession/flowEmbed，否则 apply 走 embed 分支直接 return，
  // registerPanel 根本不会被调用（这个坑一开始就踩了）。
  location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' },
  innerWidth: 1440,
  parent: { postMessage(m, o) { parentMessages.push({ m, o }) } },
  addEventListener() {},
}
const styleNodes = []
const documentStub = {
  documentElement: { attributes: {}, setAttribute(k, v) { this.attributes[k] = v } },
  createElement() { return { textContent: '' } },
  getElementById() { return null },
  head: { appendChild(n) { styleNodes.push(n) } },
}

const reactHarness = makeReact()
let registered = null
windowStub.__ModuleLoader__ = {
  load(def) {
    registered = def.factory((name) => (name === 'react' ? reactHarness.React : {}))
  },
}

// ---- 假 fetch：先给 session-project，再给 project view ----------------------
// view 里必须带 inbox —— 这是本次崩溃的那条数据。
const VIEW = {
  ok: true,
  generatedAt: '2026-11-01T08:00:00.000Z',
  control: { halted: false, haltedAt: null, haltedBy: null, reason: null },
  builtinPrompts: { worker: 'w', dispatcher: 'd' },
  inbox: {
    open: 1,
    answered: 0,
    items: [{
      id: 'hi_test1', projectId: 'prj_1', taskId: 'T-1', from: 'ag_018', lane: 'human',
      kind: 'decision', topic: '要不要改接口',
      problem: '现有 retryFailedTasks 返回 void',
      decisionNeeded: '改成返回 Result 还是保持 void？',
      where: 'T-1 · services/note.ts:42',
      suggestion: '建议返回失败数',
      // v1.39 结构化：现状 + 要人补充 + 不答的影响
      context: { facts: ['retryFailedTasks 目前返回 void', '调用方 3 处'], evidence: [{ kind: 'file', ref: 'services/note.ts:42' }] },
      impactIfNoAnswer: '这张卡会停在待决策，retry 相关改动无法开工。',
      asks: [
        { key: 'q1', question: '返回类型选哪个？', why: '公共接口改动需要人拍板。', type: 'choice', required: true, choices: [{ value: 'A', label: '返回 Result', impact: '调用方要改 3 处' }, { value: 'B', label: '保持 void', impact: '无需改动' }], default: 'A', defaultReason: '调用方本来就要拿失败数。', blocks: '接口形状定不下来' },
        { key: 'q2', question: '失败数上限多少？', why: '超限要告警。', type: 'number', required: false, default: '3' },
      ],
      status: 'open', replies: [], createdAt: '2026-11-01T07:00:00.000Z',
    }],
  },
  project: { id: 'prj_1', name: 'BiliNote', path: 'C:/x', config: { autoDispatch: true, recordIssues: true } },
  totals: { tasks: 1, running: 1, blocked: 0, approvals: 0 },
  agents: [{ id: 'ag_018', name: '调度1', role: 'dispatcher' }],
  // 真实结构：columns 是数组（带 count），tasks 是按列 id 分组的对象。
  // 写成数组 + 内嵌 tasks 是错的，columnEl 用 v.tasks[col.id] 取，取不到就渲染空。
  columns: [
    { id: 'todo', title: '待办', count: 0 },
    { id: 'running', title: '执行中', count: 1 },
  ],
  tasks: {
    todo: [],
    running: [{ id: 'T-1', title: '测试卡', column: 'running', phase: 'executing', projectId: 'prj_1' }],
  },
  leases: [], runs: [], approvals: [], events: [], sessions: [],
  // lanes 是对象（key = human/issue），每个值带 dispatchers/workers/budget 等
  lanes: {
    human: { lane: 'human', dispatchers: 1, workers: 2, running: 1, blocked: 0, waitingWorker: 0, waitingSupervisor: 0, budget: { max: 0.12 } },
    issue: { lane: 'issue', dispatchers: 0, workers: 0, running: 0, blocked: 0, waitingWorker: 0, waitingSupervisor: 0, budget: { max: 0 } },
  },
  outbox: [], worktrees: [], pull_requests: [], merge_requests: [],
}

const fetchLog = []
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  fetchLog.push({ url: u, method: (opts && opts.method) || 'GET', body: (opts && opts.body) || null })
  // postAction 打的是 POST /api/flow/action，body 里带 { action, args }；
  // 响应约定是 { result: {...} }。inbox.list 必须真的给 items，
  // 否则测到的只是"坏响应时不清空列表"的兜底分支，而不是正常路径。
  if (u.indexOf('/api/flow/action') >= 0) {
    let action = ''
    try { action = JSON.parse(opts.body || '{}').action || '' } catch (e) { action = '' }
    if (action === 'inbox.list') {
      const body = { result: { items: VIEW.inbox.items, counts: { open: 1, answered: 0, archived: 0 } } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: { ok: true } }) }
  }
  const body = u.indexOf('session-project') >= 0
    ? { ok: true, projectId: 'prj_1', sessionId: 'ses_chief' }
    : VIEW
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
};

// 组件里有 setInterval(load, 8000) 做轮询，setTimeout 做抽屉退场动画。
// 在浏览器里没问题，在 Node 里会让进程永远不退出 —— 这里统一 unref，
// 让「测试跑完」和「进程退出」解耦（否则 CI 里会挂到超时，看起来像测试卡死）。
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
globalThis.setInterval = (fn, ms, ...rest) => { const t = realSetInterval(fn, ms, ...rest); if (t && t.unref) t.unref(); return t };
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (t && t.unref) t.unref(); return t };

Object.assign(globalThis, { window: windowStub, document: documentStub });
await import('../client.js?render-test=1')
reactHarness.reset()
assert.ok(registered && typeof registered.apply === 'function', 'client bundle 应导出 apply')

// ---- 捕获注册的视图组件 ----------------------------------------------------
let FlowView = null
const ctx = {
  uiWorkspace: { openSession() {} },
  layout: { toggleSidebar() {}, closeRightbar() {} },
  slots: {
    inject(slot, fn) { if (slot === 'conversation.view') fn() },
    register(spec, component) { FlowView = component; return { spec, component } },
  },
}
registered.apply(ctx)
assert.ok(FlowView, '应当向 conversation.view 注册了组件')

// ---- 真的把组件跑起来 ------------------------------------------------------
/**
 * 驱动渲染。
 *
 * 不追"收敛"：组件的 load() 是异步的，fetch 的 promise 会在轮次之间落下，
 * 严格收敛判定会把正常的异步加载误判成死循环。
 * 改成固定轮次驱动 —— 我们真正要验的是「渲染过程中不抛异常」+「ready 分支能建出来」。
 */
async function drive(props, rounds = 8) {
  let tree = null
  for (let round = 0; round < rounds; round += 1) {
    reactHarness.begin()
    reactHarness.onRerender(() => {})
    tree = FlowView(props)   // 抛错就当场失败，这正是本测试要抓的
    reactHarness.drainEffects()
    // 多等几拍，让 fetch 的 promise 链走完
    for (let k = 0; k < 3; k += 1) await new Promise((r) => setImmediate(r))
  }
  return tree
}

// ① ready 分支必须能渲染出来（这正是线上白屏的那一条）
const tree = await drive({ sessionId: 'ses_chief' })
assert.ok(tree, 'ready 分支应当返回一棵树')
const flat = JSON.stringify(tree)
assert.ok(flat.indexOf('看板') >= 0, '应当渲染出看板区')
// 入口现在是右下角的图标浮标（不是文字按钮）：断言它的类名和角标数字。
assert.ok(flat.indexOf('flowv-fab-btn') >= 0, 'inbox 有内容时应出现图标浮标')
assert.ok(flat.indexOf('flowv-badge') >= 0, '浮标上应有数字角标')

// ---- v0.011：三层密度 ------------------------------------------------------
// 首屏只回答「哪儿卡住了」：低频按钮收进「更多」，统计只留 6 个，其余折叠。
//
// 注意：这个 harness 只跑 createElement，不渲染组件 —— 所以断言要看**元素本身**
//（props 上的 open / aria-expanded），而不是找渲染后的 DOM 类名。
const nodeList = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => nodeList(n, pred, out)); return out }
  if (pred(node)) out.push(node)
  ;(node.children || []).forEach((n) => nodeList(n, pred, out))
  return out
}
const btnTextOf = (n) => JSON.stringify(n.children || [])
const labelledNode = (t, label) => nodeList(t, (n) => JSON.stringify(n.children || []) === JSON.stringify([label]))[0]
const menuPop = (t) => nodeList(t, (n) => (n.props || {}).className === 'flowv-menu-pop')[0]
const foldByTitle = (t, title) => nodeList(t, (n) => n.props && n.props.title === title && typeof n.props.onToggle === 'function')[0]

assert.ok(nodeList(tree, (n) => n.props && n.props['aria-haspopup']).length === 1, '顶栏要有「更多」入口')
assert.equal(menuPop(tree), undefined, '默认不展开：低频按钮一个都不进树')
assert.equal(labelledNode(tree, '初始化仓库'), undefined, '初始化仓库默认不该占首屏（它在「更多」里）')
assert.equal(nodeList(tree, (n) => n.props && n.props.title === '全部统计').length, 1, '统计区要有「全部统计」折叠块')

nodeList(tree, (n) => n.props && n.props['aria-haspopup'])[0].props.onClick()
const treeMore = await drive({ sessionId: 'ses_chief' })
assert.ok(menuPop(treeMore), '展开「更多」后菜单要进树')
assert.ok(labelledNode(treeMore, '初始化仓库'), '菜单里要有初始化仓库')

// 折叠块的开关状态由 props.open 表达：默认关、点一下开。
const foldStats = foldByTitle(treeMore, '全部统计')
assert.equal(foldStats.props.open, false, '「全部统计」默认折叠')
foldStats.props.onToggle()
const treeAll = await drive({ sessionId: 'ses_chief' })
assert.equal(foldByTitle(treeAll, '全部统计').props.open, true, '点过之后要保持展开（状态在 FlowView 里）')
// ② 反向验证：把 inbox 拿掉也不能崩（防止又出现只有某条数据才崩）
const noInbox = JSON.parse(JSON.stringify(VIEW))
delete noInbox.inbox
globalThis.fetch = async (url) => {
  const body = String(url).indexOf('session-project') >= 0
    ? { ok: true, projectId: 'prj_1', sessionId: 'ses_chief' }
    : noInbox
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
FlowView = null
await import('../client.js?render-test=2')
reactHarness.reset()
registered.apply(ctx)
assert.ok(FlowView, '第二份组件应注册成功')
const tree2 = await drive({ sessionId: 'ses_chief' })
assert.ok(tree2, '没有 inbox 字段时也必须能渲染')
assert.equal(JSON.stringify(tree2).indexOf('flowv-fab-btn'), -1, '没有 inbox 时不该出现浮标')

// ③ 点开请示箱：抽屉那棵树也要能建出来（新增 UI 的主要风险点）
// 遍历树找到文字包含「请示」的按钮，调用它的 onClick，然后再渲染一轮。
/** 找右下角那个图标浮标（新入口不是文字按钮）。 */
function findFab(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findFab(n, out); return out }
  const cls = node.props && node.props.className
  if (typeof cls === 'string' && cls.indexOf('flowv-fab-btn') >= 0 && typeof node.props.onClick === 'function') out.push(node)
  for (const c of node.children || []) findFab(c, out)
  return out
}

/** 数一列里渲染了多少张卡（用 flowv-task 类名识别 —— 卡片的真实类名）。 */
function findCards(node, out = []) {
  if (!node || typeof node !== 'object') return 0
  if (Array.isArray(node)) { for (const n of node) findCards(n, out); return out.length }
  const cls = node.props && node.props.className
  if (typeof cls === 'string' && /(^|\s)flowv-task(\s|$)/.test(cls)) out.push(node)
  for (const c of node.children || []) findCards(c, out)
  return out.length
}

/** 取一棵子树里所有纯文本拼起来（断言文案用）。 */
function findText(node, acc = []) {
  // 顺序要紧：先处理字符串/数字，再处理数组和对象。
  // 反过来写的话，字符串会被 typeof !== 'object' 拦掉，永远收不到文本。
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc.join('') }
  if (!node || typeof node !== 'object') return acc.join('')
  if (Array.isArray(node)) { for (const n of node) findText(n, acc); return acc.join('') }
  for (const c of node.children || []) findText(c, acc)
  return acc.join('')
}

function findByText(node, needle, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findByText(n, needle, out); return out }
  const kids = node.children || []
  const text = kids.filter((c) => typeof c === 'string').join('')
  if (text.indexOf(needle) >= 0 && node.props && typeof node.props.onClick === 'function') out.push(node)
  for (const c of kids) findByText(c, needle, out)
  return out
}

const inboxButtons = findFab(tree)
assert.ok(inboxButtons.length >= 1, '应能找到请示入口按钮，实际找到 ' + inboxButtons.length)
inboxButtons[0].props.onClick()   // 打开抽屉（内部会 setInbox + refreshInbox）
const treeWithDrawer = await drive({ sessionId: 'ses_chief' })
const drawerFlat = JSON.stringify(treeWithDrawer)
// v1.37：请示箱改名为 Inbox，且按工单结构渲染
assert.ok(drawerFlat.indexOf('Inbox') >= 0, '抽屉标题应当渲染出来')
assert.ok(drawerFlat.indexOf('要不要改接口') >= 0, '请示的 topic 应当显示')
// v1.39：工单改成五段分区（概况条 / 现状 / 需要你补充 / 调度建议 / 处理记录）
assert.ok(drawerFlat.indexOf('flowv-ib-head') >= 0, '概况条应当渲染')
assert.ok(drawerFlat.indexOf('现状') >= 0, '现状分区应当渲染')
assert.ok(drawerFlat.indexOf('需要你补充') >= 0, '补充分区应当渲染（asks）')
assert.ok(drawerFlat.indexOf('flowv-ask') >= 0, '每个 ask 要渲染成可回答的控件')
assert.ok(drawerFlat.indexOf('flowv-ib-sec') >= 0, '分区容器应当渲染')
assert.ok(drawerFlat.indexOf('回复') >= 0, '应当有提交回复按钮')

// ⑤ v0.015.1：问答类工单的「归档」按钮必须真的在（v0.013 改成消息流时它只剩在已归档分支里，
//    等于永远点不到；线上症状就是「归档会话的按键又不见了」）。
{
  assert.ok(drawerFlat.indexOf('flowv-mail-arch') >= 0, '未归档工单要能看到「归档」按钮')
  const clsBtns = (node, needle, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) clsBtns(n, needle, out); return out }
    const cls = node.props && node.props.className
    if (typeof cls === 'string' && cls.indexOf(needle) >= 0 && typeof node.props.onClick === 'function') out.push(node)
    for (const c of node.children || []) clsBtns(c, needle, out)
    return out
  }
  const archBtns = clsBtns(treeWithDrawer, 'flowv-mail-arch')
  assert.ok(archBtns.length >= 1, '归档按钮要带 onClick，实际 ' + archBtns.length)
  // 注意：本文件后面几段会把 globalThis.fetch 换成不记录的薄桩，所以这里临时自己包一层。
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, opts) => {
    try { seen.push(JSON.parse((opts && opts.body) || '{}').action || '') } catch (e) { seen.push('') }
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: { ok: true } }) }
  }
  const realConfirm = windowStub.confirm
  windowStub.confirm = () => true
  try {
    archBtns[0].props.onClick({ stopPropagation() {} })
    await new Promise((r) => realSetTimeout(r, 0))
  } finally {
    globalThis.fetch = realFetch
    windowStub.confirm = realConfirm
  }
  assert.ok(seen.indexOf('inbox.archive') >= 0, '点归档要发 inbox.archive，实际 ' + JSON.stringify(seen))
}
// ④ 抽屉必须**可见**：只断言 树里有请示箱 是不够的。
//
// 线上症状是「点了请示按钮没有任何反应」—— 树建出来了、文字也在，
// 但 CSS 里 .flowv-drawer-mask{opacity:0}、.flowv-drawer{transform:translateX(100%)}，
// 少了 is-open 就等于把抽屉推到屏幕外并且全透明。
// 所以这里断言的是**类名**，也就是用户真正能看见/看不见的那一层。
{
  const clsOf = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) clsOf(n, pred, out); return out }
    const cls = node.props && node.props.className
    if (typeof cls === 'string' && pred(cls)) out.push(cls)
    for (const c of node.children || []) clsOf(c, pred, out)
    return out
  }
  // 树里已经有打开状态（上面点过一次），直接用，不要再点第二次 ——
  // 抽屉开着时按钮会被遮罩盖住，那时候去找按钮是测试自己的问题。
  const openedTree = treeWithDrawer

  const masks = clsOf(openedTree, (c) => c.indexOf('flowv-drawer-mask') >= 0)
  const drawers = clsOf(openedTree, (c) => /(^|\s)flowv-drawer(\s|$)/.test(c))
  assert.ok(masks.length >= 1, '请示抽屉的遮罩应当存在')
  assert.ok(drawers.length >= 1, '请示抽屉本体应当存在')
  assert.ok(masks.some((c) => c.indexOf('is-open') >= 0),
    '遮罩必须带 is-open（否则 opacity:0，点了什么都看不见）。实际类名：' + JSON.stringify(masks))
  assert.ok(drawers.some((c) => c.indexOf('is-open') >= 0),
    '抽屉必须带 is-open（否则 translateX(100%) 被推到屏幕外）。实际类名：' + JSON.stringify(drawers))
}
// ⑤ 列分页：窗口式翻页（不是累积追加）
//
// 用户的诉求是「轻翻页」：一页 N 张，点下端看更早的（上面折叠掉），
// 点上端翻回更新的（下面折叠掉）。不是「点一次多显示一批、越堆越长」。
{
  const big = JSON.parse(JSON.stringify(VIEW))
  big.tasks = JSON.parse(JSON.stringify(VIEW.tasks))
  big.tasks.running = []
  for (let i = 1; i <= 20; i += 1) {
    // 服务端已按「后移入的排前面」排好：i=20 是最新的一张，放最前
    big.tasks.running.unshift({ id: 'T-' + (100 + i), title: '卡 ' + i, column: 'running', phase: 'executing', projectId: 'prj_1' })
  }
  big.columns = VIEW.columns.map((c) => (c.id === 'running' ? Object.assign({}, c, { count: 20 }) : c))
  globalThis.fetch = async (url) => {
    const body = String(url).indexOf('session-project') >= 0
      ? { ok: true, projectId: 'prj_1', sessionId: 'ses_chief' }
      : big
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  FlowView = null
  await import('../client.js?render-test=3')
  reactHarness.reset()
  registered.apply(ctx)
  const page1 = await drive({ sessionId: 'ses_chief' })

  assert.equal(findCards(page1), 8, '第一页 8 张（默认每页 8），实际 ' + findCards(page1))
  // 第一页应该是最新的 8 张：卡 20 在列表里（unshift 放最前），卡 1 不在
  const t1 = findText(page1)
  assert.ok(t1.indexOf('卡 20') >= 0, '第一页应包含最新的卡 20')
  assert.equal(t1.indexOf('卡 1：'), -1, '第一页不该包含最早的卡 1')

  // 上端不该有「更新」，下端该有「更早 12 张」
  const up1 = findByText(page1, '↑ 更新')
  const down1 = findByText(page1, '↓ 更早')
  assert.equal(up1.length, 0, '第一页顶部不该有「更新」按钮（已经最前）')
  assert.ok(down1.length >= 1, '第一页底部应有「更早」按钮')
  assert.match(findText(down1[0]), /更早 8 张/, '底部提示应翻 8 张，实际：' + findText(down1[0]))

  // 点下端 → 翻到第 2 页（仍是 8 张，不是 16 张）
  down1[0].props.onClick({ stopPropagation() {} })
  const page2 = await drive({ sessionId: 'ses_chief' })
  assert.equal(findCards(page2), 8, '翻页后仍是 8 张（窗口移动，不是累积），实际 ' + findCards(page2))
  const t2 = findText(page2)
  assert.equal(t2.indexOf('卡 20'), -1, '第 2 页不该还有卡 20（已被折叠）')
  assert.ok(findByText(page2, '↑ 更新').length >= 1, '第 2 页顶部应出现「更新」按钮')

  // 点顶端 → 翻回第 1 页
  findByText(page2, '↑ 更新')[0].props.onClick({ stopPropagation() {} })
  const page1b = await drive({ sessionId: 'ses_chief' })
  assert.equal(findCards(page1b), 8)
  assert.ok(findText(page1b).indexOf('卡 20') >= 0, '翻回后应重新看到最新的卡 20')
  assert.equal(findByText(page1b, '↑ 更新').length, 0, '翻回第一页后顶部按钮应消失')

  // 可配置：columnPageSize = 5
  big.project = Object.assign({}, big.project, { config: Object.assign({}, big.project.config, { columnPageSize: 5 }) })
  FlowView = null
  await import('../client.js?render-test=4')
  reactHarness.reset()
  registered.apply(ctx)
  const cfgPage = await drive({ sessionId: 'ses_chief' })
  assert.equal(findCards(cfgPage), 5, 'columnPageSize=5 时每页应为 5 张，实际 ' + findCards(cfgPage))
}
console.log('client render: all checks passed')
