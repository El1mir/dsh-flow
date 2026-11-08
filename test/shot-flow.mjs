/**
 * 把调度台组件渲染成 HTML，供浏览器截图复核。
 *
 * 为什么需要它：dsh web 的鉴权靠 ?token=<进程内随机值> 换 cookie，
 * 那个 token 只活在 dsh 进程内存里（PROCESS_LAUNCH_TOKENS），拿不到。
 * 所以用真实 client.js + 真实 VIEW_CSS + 假 fetch，自己搭一个能截图的页面。
 *
 * 它验证的是**真实组件代码**，只是把 DSH 主题变量补成近似值。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = process.argv[2] || 'C:/Users/Administrator/Desktop/prjs/dsh-flow/test/.preview/flow-render.html'

// ---- 假 React ---------------------------------------------------------------
function makeReact() {
  const hooks = []; const deps = []; let cursor = 0; let effects = [];
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        // 函数组件：真的调用它（Btn/Chip 这些都在这里）
        const merged = Object.assign({}, props || {})
        if (children.length) merged.children = children
        return type(merged);
      }
      return { type, props: props || {}, children: children.flat() };
    },
    useState(init) {
      const i = cursor; cursor += 1;
      if (hooks.length <= i) hooks[i] = typeof init === 'function' ? init() : init;
      const set = (next) => {
        const v = typeof next === 'function' ? next(hooks[i]) : next;
        if (v !== hooks[i]) hooks[i] = v;
      };
      return [hooks[i], set];
    },
    useEffect(fn, d) {
      const i = cursor; cursor += 1;
      const prev = deps[i];
      const changed = !prev || !d || d.length !== prev.length || d.some((x, k) => x !== prev[k]);
      deps[i] = d;
      if (changed) effects.push(fn);
    },
    useCallback(fn) { return fn },
  };
  return { React, begin() { cursor = 0; effects = [] }, drain() { const e = effects; effects = []; for (const f of e) f() } };
}

// ---- 环境替身 ---------------------------------------------------------------
const windowStub = {
  location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' },
  innerWidth: 1440,
  parent: null,
  addEventListener() {},
};
const styleNodes = [];
const documentStub = {
  documentElement: { attributes: {}, setAttribute(k, v) { this.attributes[k] = v } },
  createElement() { return { textContent: '' } },
  getElementById() { return null },
  head: { appendChild(n) { styleNodes.push(n) } },
};
const reactHarness = makeReact();
let registered = null;
windowStub.__ModuleLoader__ = { load(def) { registered = def.factory((n) => (n === 'react' ? reactHarness.React : {})) } };

// ---- 假数据 -----------------------------------------------------------------
const VIEW = {
  ok: true, generatedAt: '2026-11-01T08:00:00.000Z',
  control: { halted: false, haltedAt: null, haltedBy: null, reason: null },
  builtinPrompts: { worker: 'w', dispatcher: 'd' },
  inbox: {
    open: 2, answered: 1,
    items: [
      // v1.39：结构化工单（asks + context + impactIfNoAnswer）—— 界面的主形态
      { id: 'hi_2', taskId: 'T-044', from: 'ag_018', lane: 'human', kind: 'risk', status: 'open',
        topic: 'T-044 方案涉及 schema 变更，需要你拍板',
        problem: '方案里提到要加一个 failed_at 字段，属于数据库迁移，且类型放宽会掩盖错误。',
        decisionNeeded: '这一轮要不要一起做迁移，还是先只做前端接线？',
        where: 'T-044 · backend/models/task.py',
        suggestion: '建议先只做前端接线，迁移单独开一张卡：迁移不可回滚，应该单独验收。',
        context: {
          facts: ['retryFailedTasks 目前返回 void', '调用方 3 处：backend/jobs.ts、api/retry.ts、web/panel.tsx'],
          evidence: [{ kind: 'file', ref: 'services/note.ts:42' }, { kind: 'test', ref: 'npm test' }],
        },
        impactIfNoAnswer: '这张卡停在待决策，retry 相关改动无法开工。',
        asks: [
          { key: 'q1', question: '返回类型选哪个？', why: '公共接口改动需要人拍板，调度不能替你决定。', type: 'choice', required: true,
            choices: [{ value: 'A', label: '返回 Result', impact: '调用方要改 3 处' }, { value: 'B', label: '保持 void', impact: '无需改动，但拿不到失败数' }],
            default: 'A', defaultReason: '调用方本来就要拿失败数，抛异常的方案还得再包一层。', blocks: '接口形状定不下来' },
          { key: 'q2', question: '失败数上限多少？', why: '超过上限要告警。', type: 'number', required: false, default: '3' },
          { key: 'q3', question: '这一轮要不要一起做数据库迁移？', why: '迁移不可回滚，属于必须人拍板的决定。', type: 'confirm', required: true,
            default: 'no', defaultReason: '迁移单独开卡验收更安全。', blocks: '迁移排期定不下来' },
        ],
        replies: [], createdAt: '2026-11-01T07:10:00.000Z' },
      // v1.39：老工单（只有 options/where）也要能渲染 —— 读侧会补成 asks
      { id: 'hi_1', taskId: 'T-042', from: 'ag_018', lane: 'human', kind: 'decision', status: 'open',
        topic: '要不要改 retryFailedTasks 的返回类型',
        problem: '现有 retryFailedTasks() 返回 void，前端拿不到失败数量，只能整体刷新列表。',
        decisionNeeded: '改成返回 { ok, failedCount } 还是保持 void、由前端自己再查一次？',
        where: 'T-042 · BillNote_frontend/src/services/note.ts:42',
        suggestion: '建议改成返回失败数：改动面小，前端拿到数就能直接提示用户。',
        replies: [{ id: 'r1', at: '2026-11-01T07:30:00.000Z', by: 'human:web', content: '按你说的改成返回失败数' }],
        createdAt: '2026-11-01T07:00:00.000Z' },
    ],
  },
  project: { id: 'prj_1', name: 'BiliNote', path: 'C:/Users/Administrator/Desktop/prjs/BiliNote', config: { autoDispatch: true, recordIssues: true, autoAccept: true, autoMerge: true } },
  totals: { tasks: 14, running: 2, blocked: 0, approvals: 6 },
  agents: [{ id: 'ag_018', name: '调度1', role: 'dispatcher' }, { id: 'ag_019', name: '工人1', role: 'worker' }],
  columns: [
    { id: 'todo', title: '待办', count: 0 },
    { id: 'planning', title: '规划中', count: 0 },
    { id: 'running', title: '执行中', count: 2 },
    { id: 'verifying', title: '待验收', count: 0 },
    { id: 'merging', title: '合并中', count: 0 },
    { id: 'done', title: '完成', count: 1 },
  ],
  // v.tasks 是按列 id 分组的对象（不是数组），columnEl 用 v.tasks[col.id] 取
  tasks: {
    todo: [], planning: [], verifying: [], merging: [],
    running: [
      { id: 'T-042', title: 'T41 缺陷修复：转写器枚举与失败任务重试入口', column: 'running', phase: 'executing', projectId: 'prj_1', assignee: 'ag_019' },
      { id: 'T-044', title: 'T-044 Ember 失败任务批量重试入口', column: 'running', phase: 'executing', projectId: 'prj_1', assignee: 'ag_019' },
    ],
    done: [
      { id: 'T-043', title: 'Onboarding 转写器枚举对齐', column: 'done', phase: 'done-no-merge', projectId: 'prj_1' },
    ],
  },
  lanes: {
    human: { lane: 'human', dispatchers: 1, workers: 2, running: 2, blocked: 0, waitingWorker: 0, waitingSupervisor: 0, budget: { max: 0.34 } },
    issue: { lane: 'issue', dispatchers: 0, workers: 0, running: 0, blocked: 0, waitingWorker: 0, waitingSupervisor: 0, budget: { max: 0 } },
  },
  leases: [], runs: [], approvals: [], events: [], sessions: [], outbox: [], worktrees: [], pull_requests: [], merge_requests: [],
};

globalThis.fetch = async (url, opts) => {
  if (String(url).indexOf('/api/flow/action') >= 0) {
    let action = ''; try { action = JSON.parse(opts.body || '{}').action || '' } catch (e) {}
    if (action === 'inbox.list') return { ok: true, status: 200, text: async () => JSON.stringify({ result: { items: VIEW.inbox.items, counts: { open: 2, answered: 1, archived: 0 } } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: { ok: true } }) };
  }
  const body = String(url).indexOf('session-project') >= 0
    ? { ok: true, projectId: 'prj_1', sessionId: 'ses_chief' }
    : VIEW;
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

Object.assign(globalThis, { window: windowStub, document: documentStub });
const realSI = globalThis.setInterval, realST = globalThis.setTimeout;
globalThis.setInterval = (f, m, ...r) => { const t = realSI(f, m, ...r); if (t.unref) t.unref(); return t };
globalThis.setTimeout = (f, m, ...r) => { const t = realST(f, m, ...r); if (t.unref) t.unref(); return t };
await import('../client.js?shot=1');

// ---- 渲染成 HTML -------------------------------------------------------------
let FlowView = null;
const ctx = {
  uiWorkspace: { openSession() {} },
  layout: { toggleSidebar() {}, closeRightbar() {} },
  slots: { inject(s, fn) { if (s === 'conversation.view') fn() }, register(spec, comp) { FlowView = comp; return {} } },
};
registered.apply(ctx);
if (!FlowView) throw new Error('组件没注册上')

/** 把 createElement 的树序列化成 HTML 字符串。 */
function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { type, props, children } = node;
  if (typeof type === 'function') return toHtml(type(Object.assign({}, props, { children })));
  const tag = type || 'div';
  const attrs = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'children' || k === 'key' || k === 'ref') continue;
    if (typeof v === 'function' || v === undefined || v === null) continue;
    if (k === 'className') { attrs.push('class="' + String(v) + '"'); continue }
    if (k === 'style' && typeof v === 'object') {
      attrs.push('style="' + Object.entries(v).map(([sk, sv]) => sk.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + sv).join(';') + '"');
      continue;
    }
    if (k === 'value') { attrs.push('value="' + String(v).replace(/"/g, '&quot;') + '"'); continue }
    if (k === 'onChange' || k === 'onClick' || k === 'onBlur' || k === 'onKeyDown') continue;
    attrs.push(k + '="' + String(v).replace(/"/g, '&quot;') + '"');
  }
  const inner = (children || []).map(toHtml).join('');
  if (tag === 'textarea') return '<textarea ' + attrs.join(' ') + '>' + (props && props.value ? String(props.value) : '') + '</textarea>';
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + inner + '</' + tag + '>';
}

/** 驱动渲染到能出画面。 */
async function drive(props, rounds = 6) {
  let tree = null;
  for (let i = 0; i < rounds; i += 1) {
    reactHarness.begin();
    tree = FlowView(props);
    reactHarness.drain();
    for (let k = 0; k < 3; k += 1) await new Promise((r) => setImmediate(r));
  }
  return tree;
}

function findClickable(node, needle, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) findClickable(n, needle, out); return out }
  const kids = node.children || [];
  const text = kids.filter((c) => typeof c === 'string').join('');
  if (text.indexOf(needle) >= 0 && node.props && typeof node.props.onClick === 'function') out.push(node);
  for (const c of kids) findClickable(c, needle, out);
  return out;
}

/** 找图标浮标：入口是 svg 按钮，没有文字可匹配。 */
function findFab(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) findFab(n, out); return out }
  const cls = node.props && node.props.className;
  if (typeof cls === 'string' && cls.indexOf('flowv-fab-btn') >= 0 && typeof node.props.onClick === 'function') out.push(node);
  for (const c of node.children || []) findFab(c, out);
  return out;
}

// 场景零：卡多的一列（验分页）—— MANY=1 时把 running 撑到 20 张
if (process.env.MANY === '1') {
  VIEW.tasks.running = [];
  for (let i = 1; i <= 20; i += 1) {
    // unshift：服务端已按「后移入的排前面」排好，i 越大越新，放越前
    VIEW.tasks.running.unshift({ id: 'T-' + (100 + i), title: '第 ' + i + ' 张卡（' + (i === 20 ? '最新' : i === 1 ? '最早' : '') + '）', column: 'running', phase: 'executing', projectId: 'prj_1' });
  }
  VIEW.columns = VIEW.columns.map((c) => (c.id === 'running' ? Object.assign({}, c, { count: 20 }) : c));
}

// 场景一：看板
const board = await drive({ sessionId: 'ses_chief' });
// 场景二：点开请示箱
const btns = findFab(board);
if (!btns.length) throw new Error('没找到请示浮标，无法生成抽屉预览');
btns[0].props.onClick();
const withInbox = await drive({ sessionId: 'ses_chief' });

const css = (styleNodes[0] && styleNodes[0].textContent) || '';

/**
 * 真实 DSH 暗色主题变量：从已安装的 dsh-client-ui-theme 里读。
 *
 * 以前这里只有一份手写近似值，而且写了一个 DSH 里**不存在**的 --dsw-alias-brand-primary ——
 * 组件用了这个变量，截图里一切正常，真实界面里浮标却是一块白色（变量未定义回退）。
 * 读不到主题包时退回下面的近似值。
 */
function realDarkTokens() {
  try {
    const t = readFileSync('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js', 'utf8')
    const di = t.indexOf('--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800)')
    const ds = t.lastIndexOf('--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)', di)
    if (di < 0 || ds < 0) return ''
    const map = new Map()
    for (const m of (t.match(/--dsw-static-[a-z0-9-]+:[^;"'}]+/g) || [])) { const i = m.indexOf(':'); if (!map.has(m.slice(0, i))) map.set(m.slice(0, i), m.slice(i + 1)) }
    for (const m of (t.slice(ds, di + 20000).match(/--dsw-alias-[a-z0-9-]+:[^;"'}]+/g) || [])) { const i = m.indexOf(':'); if (!map.has(m.slice(0, i))) map.set(m.slice(0, i), m.slice(i + 1)) }
    return ':root{' + [...map].map(([k, v]) => k + ':' + v).join(';') + ';--dsw-radius-sm:8px;--dsw-radius-md:10px;--dsw-radius-lg:12px}'
  } catch { return '' }
}

// 近似值在前作兜底，真实主题变量追加在后覆盖（body 规则始终保留）
const THEME = `
:root{
  --dsw-alias-bg-base:#1a1a1a; --dsw-alias-bg-l1:#212121; --dsw-alias-bg-l2:#282828;
  --dsw-alias-label-primary:#e8e8e8; --dsw-alias-label-secondary:#a8a8a8; --dsw-alias-label-tertiary:#7a7a7a;
  --dsw-alias-border-l1:#2e2e2e; --dsw-alias-border-l2:#333; --dsw-alias-border-l3:#3d3d3d;
  --dsw-alias-button-info-fill:#4d8dff; --dsw-alias-interactive-bg-hover:#2a2a2a;
  --dsw-radius-sm:8px; --dsw-radius-md:10px;
}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:13px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;padding:16px}
`.replace(/`/g, '') + realDarkTokens();

const html = '<!doctype html><html><head><meta charset="utf-8"><title>flow render</title>'
  + '<style>' + THEME + '</style>'
  + '<style>' + css + '</style>'
  + '</head><body>' + toHtml(board) + '</div></body></html>';

const htmlInbox = '<!doctype html><html><head><meta charset="utf-8"><title>flow inbox</title>'
  + '<style>' + THEME + '</style>'
  + '<style>' + css + '</style>'
  + '</head><body>' + toHtml(withInbox) + '</body></html>';

// 逐页快照：静态 HTML 不响应点击（导出时去掉了 onClick），
// 所以在 Node 里模拟翻页，把每一页分别导出成一张图。
if (process.env.MANY === '1') {
  let cur = board;
  for (let page = 1; page <= 3; page += 1) {
    const doc = '<!doctype html><html><head><meta charset="utf-8"><title>page' + page + '</title>'
      + '<style>' + THEME + '</style><style>' + css + '</style></head><body>' + toHtml(cur) + '</body></html>';
    writeFileSync(OUT.replace('.html', '-page' + page + '.html'), doc, 'utf8');
    console.log('page' + page + ' →', OUT.replace('.html', '-page' + page + '.html'));
    const down = findClickable(cur, '↓ 更早');
    if (!down.length) break;
    down[0].props.onClick({ stopPropagation() {} });
    cur = await drive({ sessionId: 'ses_chief' });
  }
}

writeFileSync(OUT.replace('.html', (process.env.MANY === '1' ? '-many.html' : '-board.html')), html, 'utf8');
writeFileSync(OUT.replace('.html', '-inbox.html'), htmlInbox, 'utf8');
console.log('board →', OUT.replace('.html', (process.env.MANY === '1' ? '-many.html' : '-board.html')));
console.log('inbox →', OUT.replace('.html', '-inbox.html'));
