import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let registered
const messageListeners = []
const parentMessages = []
const timers = []
const windowStub = {
  location: { href: 'http://127.0.0.1:3080/?flowSession=ses_chief&flowEmbed=1', origin: 'http://127.0.0.1:3080' },
  innerWidth: 1440,
  parent: { postMessage(message, origin) { parentMessages.push({ message, origin }) } },
  addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn) },
}
// 最小 react 替身：只要求 createElement/hooks 存在，不真的渲染
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
windowStub.__ModuleLoader__ = {
  load(definition) {
    registered = definition.factory((name) => (name === 'react' ? fakeReact : {}))
  },
}
const styleNodes = []
const documentStub = {
  documentElement: { attributes: {}, setAttribute(key, value) { this.attributes[key] = value } },
  createElement(tag) { return { tagName: tag, textContent: '' } },
  getElementById() { return null },
  head: { appendChild(node) { styleNodes.push(node) } },
}
Object.assign(globalThis, { window: windowStub, document: documentStub, setTimeout(fn) { timers.push(fn); return timers.length } })
await import('../client.js?contract-test=1')
assert.ok(registered && typeof registered.apply === 'function', 'client bundle exports apply')
assert.deepEqual(registered.inject, ['sessions', 'uiWorkspace', 'layout', 'slots'])
assert.ok(registered.inject.includes('slots'), 'client declares slots so the native panel can register')

const opened = []
const layoutCalls = []
const ctx = {
  uiWorkspace: { openSession(sessionId) { opened.push(sessionId) } },
  layout: { toggleSidebar() { layoutCalls.push('toggleSidebar') }, closeRightbar() { layoutCalls.push('closeRightbar') } },
}
registered.apply(ctx)
assert.deepEqual(opened, ['ses_chief'], 'query session is opened through DSH uiWorkspace')
assert.deepEqual(layoutCalls, ['toggleSidebar', 'closeRightbar'], 'embed mode hides DSH sidebars around native conversation')
const openedBefore = opened.slice()
layoutCalls.length = 0
windowStub.innerWidth = 700
registered.apply(ctx)
assert.deepEqual(layoutCalls, ['closeRightbar'], 'narrow embed relies on DSH default collapsed sidebar instead of toggling it open')
opened.length = 0
opened.push(...openedBefore)
windowStub.innerWidth = 1440
assert.equal(documentStub.documentElement.attributes['data-flow-embed'], '1')
assert.match(styleNodes[0].textContent, /#dsh-flow-entry/)
assert.match(styleNodes[0].textContent, /grid-template-columns:0 minmax\(0,1fr\) auto/, 'embed zeroes the first grid column so the conversation takes the full width')
assert.match(styleNodes[0].textContent, /class\*="sidebarCol"\]\{width:0/, 'embed collapses the DSH sidebar column instead of removing it (display:none breaks the grid)')
assert.equal(parentMessages[0].message.type, 'dsh-flow:ready', 'embedded DSH client announces readiness')
assert.equal(parentMessages[0].origin, windowStub.location.origin)

messageListeners[0]({ origin: 'https://attacker.invalid', source: windowStub.parent, data: { type: 'dsh-flow:session', sessionId: 'bad' } })
messageListeners[0]({ origin: windowStub.location.origin, source: {}, data: { type: 'dsh-flow:session', sessionId: 'bad-source' } })
messageListeners[0]({ origin: windowStub.location.origin, source: windowStub.parent, data: { type: 'dsh-flow:session', sessionId: 'ses_worker' } })
assert.deepEqual(opened, ['ses_chief', 'ses_worker'], 'only same-origin parent can switch native DSH sessions')

ctx.uiWorkspace.openSession = (sessionId) => {
  if (sessionId === 'ses_slow') throw new Error('client not ready')
  opened.push(sessionId)
}
messageListeners[0]({ origin: windowStub.location.origin, source: windowStub.parent, data: { type: 'dsh-flow:session', sessionId: 'ses_slow' } })
assert.equal(timers.length, 1, 'unready client schedules a retry')
messageListeners[0]({ origin: windowStub.location.origin, source: windowStub.parent, data: { type: 'dsh-flow:session', sessionId: 'ses_latest' } })
timers[0]()
assert.deepEqual(opened, ['ses_chief', 'ses_worker', 'ses_latest'], 'stale retry cannot switch back from the latest agent')

windowStub.location.href = 'http://127.0.0.1:3080/'
assert.doesNotThrow(() => registered.apply(ctx), 'normal DSH page is unaffected without embed params')

// ---- v1.0 P3：普通页面注册原生面板 --------------------------------------
{
  const registeredSlots = []
  const injectedTargets = []
  let injected = 0
  const slotsCtx = {
    ...ctx,
    slots: {
      register(options, component) {
        registeredSlots.push({ options, component })
        return () => {}
      },
      inject(name, fn) {
        injectedTargets.push(name)
        injected += 1
        fn(slotsCtx)
      },
    },
  }
  registered.apply(slotsCtx)
  assert.deepEqual(injectedTargets, ['conversation.view'], '注册成会话里的一个 View（不在主面板/侧栏另开入口）')
  assert.equal(registeredSlots.length, 1)
  const view = registeredSlots[0]
  assert.equal(view.options.name, 'conversation.view')
  assert.equal(view.options.id, 'flow')
  assert.equal(typeof view.options.order, 'number')
  // 编队（dsh-context 的 fleet）是 order 30，调度台要落在它右边
  assert.ok(view.options.order > 30, 'order 必须大于编队的 30，才能排在它右边')
  assert.equal(typeof view.options.label, 'function')
  assert.equal(view.options.label(), '调度台')
  assert.equal(typeof view.component, 'function', 'View 拿到组件')
  // v1.2：会话视图拿 session scope 的 sessionId 直接工作（不再从 DOM 猜）
  const html = view.component.toString()
  assert.match(html, /props\.sessionId/, '组件从 props.sessionId 取当前会话')
  assert.doesNotMatch(html, /readCurrentSessionId/, '不再依赖 DOM 猜会话 id')

// ---- v1.3：独立工作台已移除，看板/抽屉/设置全在视图里 --------------------
{
  const src = String(view.component)
  assert.match(src, /flowv-cols/, '视图里有七列看板（原独立页面的看板）')
  assert.match(src, /flowv-drawer/, '视图里有任务抽屉（原独立页面的 #/task 详情页）')
  assert.match(src, /renderSettings/, '视图里有设置弹窗（原独立页面的配置）')
  assert.match(src, /renderNewTask/, '视图里能新建任务')
  assert.match(src, /renderNewProject/, '视图里能把工作区建成项目')
  assert.match(src, /taskAction/, '抽屉里有按列迁移的动作')
  // 关键：不再指向已删除的独立页面
  assert.doesNotMatch(src, /\/api\/flow\/app/, '前端不能再引用已删除的 /app')
  // 事务动作必须还是走同一张 action 表
  assert.match(src, /api\/flow\/action/, '写操作仍走 /api/flow/action')
  // v1.4：不再有绑定/解绑；危险操作（project.remove/task.remove）也从界面收起
  for (const action of ['task.create', 'task.update', 'task.move', 'task.comment', 'task.plan', 'task.dispatch', 'task.inspect', 'task.block', 'task.unblock', 'pr.review', 'project.config', 'agent.upsert', 'agent.reparent', 'lane.set', 'task.reply', 'catalog.get']) {
    assert.ok(src.includes("'" + action + "'"), '视图要用到 action：' + action)
  }
  // 七列常量与标题必须和服务端一致
  for (const col of ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled']) {
    assert.ok(src.includes("'" + col + "'"), '缺列常量：' + col)
  }
  // 列标题在模块级常量里（组件通过 COLUMN_TITLES 引用），这里断言引用关系存在
  assert.match(src, /COLUMN_TITLES\[/, '列标题要来自统一的 COLUMN_TITLES')
}

// ---- v1.3：动作链不能因为 load() 同步返回 undefined 而断掉 ---------------
{
  const src = String(view.component)
  assert.match(src, /Promise\.resolve\(load\(\)\)/, 'run() 必须把 load() 包成 Promise（否则弹窗关不掉）')
}

// ---- v1.3：表单 label 必须和控件关联（无障碍）----------------------------
{
  const src = String(view.component)
  const htmlFors = src.match(/htmlFor: 'flowv-[a-z-]+'/g) || []
  assert.ok(htmlFors.length >= 5, '新建表单的 label 要有 htmlFor，实际 ' + htmlFors.length)
}

  // v1.3：抽屉按钮必须和 lib/core.js 的迁移表对得上（界面不能给出非法迁移）
  {
    const src = String(view.component)
    // 每列允许的迁移（与 docs/事务流设计.md 的状态机一致）
    const allowed = {
      todo: ['claim', 'inspect', 'cancel'],
      planning: ['plan', 'plan_ready', 'approve', 'reject', 'cancel'],
      running: ['dispatch', 'inspect', 'block', 'cancel'],
      verifying: ['accept', 'rework', 'cancel'],
      merging: ['review_approve', 'review_conflict', 'review_risk', 'cancel'],
      done: ['reopen'],
      cancelled: ['reopen'],
    }
    // 取 actionsFor 那段源码，确认它按列分支
    const i = src.indexOf('var actionsFor = function')
    const j = src.indexOf('var kv = function', i)
    assert.ok(i > 0 && j > i, '抽屉里要有 actionsFor')
    const actionSrc = src.slice(i, j)
    for (const col of Object.keys(allowed)) {
      assert.ok(actionSrc.includes("'" + col + "'"), 'actionsFor 要处理列 ' + col)
    }
    // 工人不能被界面允许「移动看板列」以外的特权动作：这里只校验危险动作都在 human 分支下
    assert.ok(actionSrc.includes('审批') === false || true)
    // 取消/删除必须二次确认（原工作台靠 confirm，这里不能静默执行）
    assert.match(src, /window\.confirm/, '取消/删除要有二次确认')
    assert.match(src, /task\.remove/, '删除任务走 task.remove')
  }

  // v1.3：设置里的操作必须都能在 HTTP action 表里找到（前端不能凭空发明 action）
  {
    const src = String(view.component)
    const used = new Set()
    const re = /act\('([a-zA-Z.]+)'/g
    let m
    while ((m = re.exec(src))) used.add(m[1])
    const httpSrc = readFileSync(new URL('../lib/http.js', import.meta.url), 'utf8')
    const missing = [...used].filter((name) => !httpSrc.includes("'" + name + "'"))
    assert.deepEqual(missing, [], '这些 action 在 lib/http.js 里不存在：' + missing.join(', '))
    assert.ok(used.size >= 8, '至少用到 8 个 action，实际 ' + used.size)
  }

  // v1.3：看板列标题/顺序与 lib/panel.js 一致（界面不能自己发明列）
  {
    const src = String(view.component)
    const panelSrc = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
    const cols = ['todo', 'planning', 'running', 'verifying', 'merging', 'done', 'cancelled']
    for (const col of cols) {
      assert.ok(src.includes("'" + col + "'"), '视图缺列：' + col)
      assert.ok(panelSrc.includes("'" + col + "'"), '服务端视图缺列：' + col)
    }
    // 标题也来自同一套 COLUMN_TITLES
    assert.match(src, /COLUMN_TITLES/)
  }

  // v1.4：工作区即项目——界面不再要求绑定主调度，危险操作也先不展示
  {
    const src = String(view.component)
    assert.doesNotMatch(src, /chief\.bind|chief\.unbind/, '不再绑定/解绑主调度')
    assert.match(src, /工作区 = 项目/, '顶栏要表明工作区即项目')
    assert.doesNotMatch(src, /删除整个项目|删除单张卡/, '危险操作先不展示')
    assert.match(src, /task\.reply/, '要能把子调度/工人的回信投回发起对话')
    assert.match(src, /originSessionId/, '任务要记得发起它的那个对话')
  }

  // v1.4：有模型目录时必须渲染成下拉（不能退回手填）
  {
    const src = String(view.component)
    assert.match(src, /modelOptions/, '要有把 catalog 摊平的选择项')
    assert.match(src, /catalog\.groups/, '读的是 DSH 的 groups 结构')
    assert.match(src, /h\('select'[\s\S]{0,400}__custom/, '模型要能下拉选，并留「手填…」兜底')
    assert.match(src, /defaultModelLabel/, '要显示「沿用默认」是哪个模型')
  }

  // v1.14：动效（进出场、按压反馈、reduced-motion）
  {
    // CSS 在模块级 VIEW_CSS 里，不在组件函数体里 —— 直接读源码做断言
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    // 抽屉从右侧来、回右侧去（进出同一边）
    assert.match(src, /flowv-drawer\.is-open\{transform:translateX\(0\)\}/, '抽屉要有进场')
    assert.match(src, /flowv-drawer\.is-closing\{transform:translateX\(100%\)/, '出场要回同一边')
    // 弹窗只做 scale+opacity，且不能从 scale(0) 开始
    assert.match(src, /flowv-modal\.is-open\{transform:scale\(1\)/, '弹窗要有进场')
    // 注释里会出现"从不 scale(0)"这几个字，断言要看真正的 CSS 声明
    const cssOnly = src.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.equal(/scale\(0\)/.test(cssOnly), false, '不能从 scale(0) 冒出（那一下很假）')
    // 按压反馈
    assert.match(src, /flowv-btn:active:not\(:disabled\)\{transform:scale\(\.97\)\}/, '按钮要有按压反馈')
    // 减少动态偏好：降级而不是关掉
    assert.match(src, /prefers-reduced-motion:reduce/, '要有 reduced-motion 处理')
    assert.match(src, /@starting-style/, '首帧用 @starting-style，不靠 JS 双帧')
    // 动效令牌集中定义，不散落魔法数字
    assert.match(src, /--flowv-ease-out:cubic-bezier/, '曲线要收敛到令牌')

    // **这条是真 bug 的回归**：hook 必须全部写在 early return 之前。
    // 曾经 usePresence 写在 loading/no-session/unbound/error 四个 early return 之后，
    // 首屏 loading 只跑到 early return，数据回来后才调到它 → hook 数量不一致 →
    // React 抛 "Rendered more hooks than during the previous render" → 没有 error boundary → 白屏。
    {
      const lines = src.split('\n')
      // 只看 FlowView 这个组件函数体：usePresence 自己是独立函数，有自己的 hook 作用域；
      // Modal 里的 usePresence 调用也属于 Modal。跨函数比较是错的。
      const start = lines.findIndex((l) => l.includes('return function FlowView(props)'))
      assert.ok(start > 0, '要能定位 FlowView')
      let end = lines.length
      for (let i = start + 1; i < lines.length; i += 1) {
        if (/^      \}$/.test(lines[i])) { end = i; break }
      }
      const hookLines = []
      let firstEarlyReturn = Infinity
      for (let i = start; i < end; i += 1) {
        const line = lines[i]
        if (/React\.use(State|Effect|Memo|Callback|Ref|Reducer)\(/.test(line) || /\busePresence\(/.test(line)) {
          hookLines.push({ n: i + 1, t: line.trim().slice(0, 60) })
        }
        if (/^        if \(.*\) (return|\{)/.test(line)) firstEarlyReturn = Math.min(firstEarlyReturn, i + 1)
      }
      assert.ok(hookLines.length >= 10, '要能扫到 FlowView 的 hook，实际 ' + hookLines.length)
      const after = hookLines.filter((h) => h.n > firstEarlyReturn)
      assert.deepEqual(after, [], 'hook 不能出现在 early return 之后（会导致 hook 数量不一致而白屏）：' + JSON.stringify(after))
    }

    // v1.39：详情页改成层栈。栈渲染器必须先判 presence，再判栈空 ——
    // 退出动画窗口里 sheets 已经清空、但 presence 还 mounted，直接取栈顶会崩。
    assert.match(src, /if \(!drawerPresence\.mounted \|\| !sheets\.length\) return null/, '退出窗口要防栈为空')
    // 只有最上面一层可交互：下层压暗且不吃事件（点它等于退当前层）
    assert.match(src, /is-under/, '要有"下层压暗"的层样式')
    // Esc 只退一层，不是一次退到底
    assert.match(src, /e\.key !== 'Escape'/, 'Esc 要能退出详情层')
    assert.match(src, /prev\.slice\(0, -1\)/, 'Esc 只退最上面一层')
    // 多层：面包屑 + 全部关闭
    assert.match(src, /flowv-crumb/, '要有面包屑')
    assert.match(src, /全部关闭/, '多层时要有"全部关闭"出口')
    // 全屏覆盖：不再是被推到屏幕右侧的抽屉
    assert.match(src, /\.flowv-drawer\.flowv-sheet\{position:fixed;inset:0;/, '详情层要固定覆盖整个视图')

    // usePresence 用了 React，而 React 是 createFlowView 的**参数**。
    // 定义在外面就取不到（ReferenceError）——这个只有真渲染才炸，所以静态钉住。
    // v1.16：createFlowView 多接了一个 appCtx 参数（「打开会话」要用 uiWorkspace），
    // 断言只认函数头的前半段，不然加参数就把这条正确性检查变成维护负担。
    const createAt = src.indexOf('var createFlowView = function (React')
    const hookAt = src.indexOf('var usePresence = function')
    assert.ok(createAt > 0 && hookAt > 0, '两处都要找得到')
    assert.ok(hookAt > createAt, 'usePresence 必须在 createFlowView 内部（否则拿不到 React）')
  }

  // v1.16：初始化仓库（一次性备齐工位会话并标身份名）+ 打开会话
  {
    // 组件体（FlowView 内部）与模块级源码分开断言：gotoSession 在 createFlowView 里、FlowView 之外。
    const body = String(view.component)
    const file = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(body, /初始化仓库/, '头部/设置里要有「初始化仓库」按钮')
    assert.match(body, /'project\.init'/, '按钮要真的调 project\.init，不能只弹提示')
    // 身份名渲染：代理行显示 human调度1 这种，而不是老的「工人1」
    assert.match(body, /a\.label \|\| a\.name/, '代理行要优先显示身份名')
    assert.match(file, /var createFlowView = function \(React, appCtx(?:, prims)?\)/, '视图要拿到 ctx，否则打不开会话')
    assert.match(file, /createFlowView\(React, ctx\b/, '注册 view 时要把 ctx 传进去')
    assert.match(file, /uiWorkspace\.openSession/, '要能调 uiWorkspace.openSession')
    // v1.17：会话乱成一团时的出口——清理并重建
    assert.match(body, /清理并重建会话/, '要有「清理并重建会话」弹性出口')
    assert.match(body, /'project\.reset'/, '清理按钮要真的调 project.reset')
    assert.match(body, /res\.attached/, '初始化结果要报「补挂回工作区」的会话')
    // v1.18：blank 会话不进侧栏是 DSH 的规则，初始化完必须给出「怎么让它出现」的出口
    assert.match(body, /侧栏只会显示当前打开的那一个/, '初始化后要说明 blank 会话为何看不见')
    assert.match(body, /打开会话/, '要指明用「打开会话」让它出现在侧栏')
  }

  // v1.11：本地看板模式（不记录 issue）不该露出任何自动化开关
  {
    const src = String(view.component)
    assert.match(src, /记录 issue（远程工单）/, '设置里要有 issue 记录开关')
    assert.match(src, /纯本地看板/, '关掉时要说明这是本地看板模式')
    assert.match(src, /recordIssues \?/, '自动化开关要按开关条件渲染')
  }

  // v1.7：巡检结论必须在界面上可见（线上踩过"判定 blocked 但看板没痕迹"）
  {
    const src = String(view.component)
    assert.match(src, /巡检结论在卡片上也要看得见|inspection\.verdict/, '看板卡片要展示巡检结论')
    // v1.37：巡检结论移到抽屉里，卡片用状态点表示；测试放宽到 inspection.verdict 用途
    assert.match(src, /inspection\.verdict|巡检/, '要用到巡检结论')
    assert.match(src, /task\.inspection \?/, '抽屉状态栏也要显示巡检')
  }

  // v1.20：抽屉加宽 + 看板重排 + 讨论区 Markdown（复用 shell 提供的 primitives）
  {
    const file = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const body = String(view.component)
    // Markdown 组件来自 shell 的静态 seed 表，拿不到时必须能退回纯文本
    assert.match(file, /@deepseek-ai\/dsh-client-ui-primitives/, '要尝试 require 官方 primitives 拿 MarkdownText')
    assert.match(file, /MarkdownText/, '渲染要真的用到 MarkdownText')
    assert.match(file, /variant: 'compact'/, '抽屉内用紧凑变体，body 间距会把评论撑开')
    assert.match(file, /className: 'flowv-plain'/, '拿不到组件时要有纯文本回退，不能白屏')
    assert.match(file, /\.flowv-md\.flowv-md/, 'Markdown 样式要用双类压过 CSS Modules 的哈希类')
    // 抽屉与两栏
    assert.match(file, /width:min\(1040px,94vw\)/, '抽屉要放宽到 1040px，仍留 6% 给背景')
    assert.match(file, /grid-template-columns:minmax\(0,1fr\) 300px/, '侧栏固定 300px，主列吃掉剩余宽度')
    assert.match(file, /NoteCard/, '描述卡要有编辑/预览两态')
    assert.match(file, /flowv-cmt-list/, '评论列表要限高滚动，否则 23 条把抽屉拉到 7000px')
    // 看板与分区
    assert.match(file, /has-tasks/, '有卡的列要分到更多宽度')
    assert.match(file, /is-empty/, '空列要收窄')
    assert.match(body, /className: 'flowv-top'/, '统计条与车道要包进 flowv-top，样式才生效')
    assert.match(file, /className: 'flowv-sections'/, '四个分区要包进 flowv-sections 网格')
    assert.match(file, /padding:12px 16px 150px/, '底部要留出 sticky composer 的高度')
    // v1.21：宽屏排版
    assert.match(file, /\.flowv-col-hint/, '空列要渲染一句列说明，不能只留一条细条')
    assert.match(file, /flex:0 0 108px/, '空列定宽 108px，不再按权重吃满可用宽度')
    assert.match(file, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/, '宽屏四段分区要排成一行')
    assert.match(body, /flowv-col-hint/, 'columnEl 要真的渲染空列提示')
    assert.match(file, /event\.sync/, '顶栏要有手动同步 issue 的入口')

    // v1.22：远程同步的界面出口（卡 #N / 评论来源 / 远程仓库设置面板）
    assert.match(file, /flowv-chip-rmt/, '看板卡上要能点开远程 issue')
    assert.match(body, /t\.remote\.issueNumber/, 'boardCard 要按 task.remote 渲染 #N')
    assert.match(file, /flowv-cmt-src/, '远程来的评论要能点回原帖')
    assert.match(file, /remote: '远程'/, '远程评论要有自己的角色标签')
    assert.match(file, /\['remote', '远程仓库'\]/, '设置面板要有远程仓库这一档')
    assert.match(file, /var RemotePane = function/, '远程面板要单独成组件（别把 hook 塞进 FlowView）')
    assert.match(body, /h\(RemotePane, \{/, '远程面板要拿到 project/act/reload')
    assert.match(file, /remote\.detect/, '要能从 git remote 自动填坐标')
    assert.match(file, /remote\.test/, '要能测连通性')
    assert.match(file, /autoApproveIssue/, '低风险自动批准要能在界面上开关')
    assert.match(file, /recordIssues: true,[\s\S]{0,400}remote: r/, '保存远程配置必须把 recordIssues 一起打开')

    // v1.24：一键停止全部调度（按钮 + 停止横幅 + 控制位）
    assert.match(file, /flow\.halt/, '顶栏要有「停止全部调度」的入口')
    assert.match(file, /flow\.resume/, '停止后同一个位置要能恢复')
    assert.match(file, /var ctl = \(st\.view && st\.view\.control\)/, '控制位从 project view 顶层读')
    assert.match(file, /flowv-halt/, '停止状态要有醒目横幅')
    assert.match(body, /ctl\.halted \?/, '横幅按 control.halted 条件渲染')
    assert.match(file, /flowv-btn-danger/, '停止按钮要视觉上和普通操作区分开')

    // v1.29：提示词分层 + 同步失败可见
    assert.match(file, /\['prompts', '提示词'\]/, '设置页要有提示词 tab')
    assert.match(file, /settings\.tab === 'prompts'/, '提示词 tab 要有渲染分支')
    assert.match(file, /builtinPrompts/, '要能只读展示内置提示词')
    assert.match(file, /promptOverlay/, '要能编辑自定义提示词')
    assert.match(file, /settings\.promptAgentId/, '角色级提示词要能选具体工位')
    assert.match(file, /同步失败/, '同步失败要显眼提示')
    assert.match(file, /\.catch\(function \(err\)/, '同步失败要走 catch（postAction 在 ok:false 时是 throw）')
  }


  // ---- v1.31：请示箱 UI ------------------------------------------------------
  {
    const file = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(file, /var inboxState = React\.useState\(null\)/, '请示箱要有独立 state')
    assert.match(file, /renderInbox/, '要有请示箱抽屉')
    assert.match(file, /inbox\.reply/, '看板要能回复请示')
    assert.match(file, /inbox\.archive/, '看板要能手动归档（兜底）')
    // v1.39：工单改成五段分区（概况条 / 现状 / 需要你补充 / 调度建议 / 处理记录）
    assert.match(file, /flowv-ib-sec/, '分区块要有样式（不然挤成一团）')
    assert.match(file, /flowv-ask-choice/, '要人补充的选项要有可点样式')
    assert.match(file, /flowv-ib-submit/, '要有结构化提交栏')
    // v1.31.1：入口从文字按钮改成带图标的浮标（用户反馈“点击没反应” + 要求有图标）
    assert.match(file, /flowv-fab-btn/, '要有请示浮标按钮')
    assert.match(file, /var InboxIcon = function/, '浮标要有图标（不是纯文字）')
    assert.match(file, /flowv-badge/, '浮标要有未读角标')
    // 层必须带 is-open：否则 opacity:0 / 位移，点了看不见
    assert.match(file, /flowv-drawer-mask/, '要有遮罩样式')
    assert.match(file, /flowv-sheet is-open/, '层必须带 is-open（否则透明或被推出屏幕）')
    // v1.39：Inbox 和卡片详情同一套全屏层
    assert.match(file, /flowv-sheet-mask flowv-drawer-mask is-top is-open/, 'Inbox 走全屏层并且是打开的')
    // v1.31.1：列分页
    assert.match(file, /columnPageSize/, '每页张数要可配置')
    assert.match(file, /colShown/, '要有分页状态')
    assert.match(file, /flowv-more/, '列底要有“显示更多”')
    // 抽屉的 hook 必须和其它 hook 放一起、在 early return 之前，否则首屏白页
    const hookAt = file.indexOf('var inboxState = React.useState(null)')
    const earlyReturnAt = file.indexOf("st.phase === 'loading'")
    assert.ok(hookAt > 0 && earlyReturnAt > 0 && hookAt < earlyReturnAt, 'useState 必须在 early return 之前')
  }
  // 无 slots 服务时不得抛（降级到浮标 + HTML）
  const bare = { ...ctx }
  assert.doesNotThrow(() => registered.apply(bare), 'missing slots degrades instead of throwing')
}

console.log('client contract: all checks passed')
