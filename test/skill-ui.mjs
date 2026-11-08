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
  agents: [{ id: 'ag_018', name: '调度1', role: 'dispatcher' }, { id: 'ag_grill', name: '需求讨论', role: 'griller' }],
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
    const args = JSON.parse(opts.body || '{}').args || {}
    if (action === 'project.config') Object.assign(VIEW.project.config, args.patch)
    const result = action === 'skills.list' ? { ok: true, skills: [{name:'grilling',description:'Discuss requirements'}, {name:'ui-styling',description:'UI styling'}] } : {ok:true}
    return { ok: true, status: 200, text: async () => JSON.stringify({ result }) }
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


function nodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => nodes(n, predicate, out)); return out }
  if (predicate(node)) out.push(node)
  ;(node.children || []).forEach(n => nodes(n, predicate, out))
  return out
}
const props = {sessionId:'ses_chief'}
let tree = await drive(props)
const find = predicate => nodes(tree, predicate)[0]
const text = n => JSON.stringify(n.children || [])
const click = async label => {
  const button = find(n => n.props?.onClick && text(n) === JSON.stringify([label]))
  assert.ok(button, 'button exists: ' + label)
  button.props.onClick()
  tree = await drive(props)
}
await click('设置')
assert.ok(fetchLog.some(r => r.body && JSON.parse(r.body).action === 'skills.list'), 'settings fetches skill catalog')
await click('项目配置')
const field = id => find(n => n.props?.id === id)
assert.equal(field('flowv-skills-mode').props.value, 'all', 'undefined allowlist allows all')
assert.equal(field('flowv-grill-skill').props.value, 'grilling')
assert.equal(field('flowv-grill-rounds').props.defaultValue, 4)
field('flowv-skills-mode').props.onChange({target:{value:'selected'}})
tree = await drive(props)
assert.deepEqual(VIEW.project.config.allowedSkills, [], 'explicit selection persists none')
let checkboxes = nodes(tree, n => n.type === 'input' && n.props.type === 'checkbox')
assert.equal(checkboxes.length, 2)
assert.ok(checkboxes.every(n => !n.props.checked && !n.props.disabled))
checkboxes[1].props.onChange({target:{checked:true}})
tree = await drive(props)
assert.deepEqual(VIEW.project.config.allowedSkills, ['ui-styling'])
assert.equal(nodes(tree,n=>n.type === 'input' && n.props.type === 'checkbox')[1].props.checked,true)
field('flowv-grill-skill').props.onChange({target:{value:'ui-styling'}})
tree = await drive(props)
assert.equal(VIEW.project.config.grillSkill,'ui-styling')
field('flowv-grill-rounds').props.onBlur({target:{value:'7'}})
tree = await drive(props)
assert.equal(VIEW.project.config.grillMaxRounds,7)
for (const invalid of ['', '0', '2.5', '21', 'no']) {
  const target = {value:invalid}
  field('flowv-grill-rounds').props.onBlur({target})
  assert.equal(VIEW.project.config.grillMaxRounds,7)
  assert.equal(target.value,7)
}
field('flowv-skills-mode').props.onChange({target:{value:'all'}})
tree = await drive(props)
assert.equal(VIEW.project.config.allowedSkills,null)
assert.ok(nodes(tree,n=>n.type === 'input' && n.props.type === 'checkbox').every(n=>n.props.checked && !n.props.disabled), 'all mode still permits direct deselection')
const allChecks = nodes(tree,n=>n.type === 'input' && n.props.type === 'checkbox')
allChecks[0].props.onChange({target:{checked:false}})
tree = await drive(props)
assert.deepEqual(VIEW.project.config.allowedSkills, ['ui-styling'], 'direct deselection switches all to selected preserving other skills')
await click('配置需求讨论模型（griller）')
assert.ok(JSON.stringify(tree).includes('共享需求讨论'))
const grillerRow = find(n=>n.props?.className === 'flowv-agent-row' && JSON.stringify(n).includes('共享需求讨论'))
const model = nodes(grillerRow,n=>n.type === 'input' && n.props.placeholder === 'provider/model')[0]
assert.ok(model,'shared griller has model control')
model.props.onBlur({target:{value:'provider/discussion-model'}})
tree = await drive(props)
assert.ok(fetchLog.some(r=>r.body && JSON.parse(r.body).action === 'agent.selectModel' && JSON.parse(r.body).args.agentId === 'ag_grill'))
await click('项目配置')
VIEW.project.config.allowedSkills = ['uninstalled-skill']
tree = await drive(props)
// Reload the view after changing the persisted fixture, just as a fresh server response would.
await click('代理与模型')
await click('刷新')
await click('项目配置')
assert.ok(JSON.stringify(tree).includes('uninstalled-skill'), 'unavailable configured skills remain editable')
checkboxes = nodes(tree, n => n.type === 'input' && n.props.type === 'checkbox')
checkboxes[0].props.onChange({target:{checked:true}})
tree = await drive(props)
assert.deepEqual(VIEW.project.config.allowedSkills, ['uninstalled-skill','grilling'], 'changing selection preserves unavailable skill names')
console.log('skill UI configuration persistence passed')
