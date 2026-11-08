/**
 * flow-command-real.mjs — 用**真实的 lib/command-flow.js 模块**跑 /flow 的进入流程。
 *
 * 和 functest 的区别：functest 里 /flow 那段用的是 host 桩，这个文件直接 import
 * 生产模块本身，再用"线上真实报错里的工具名单"当注册表，验证：
 *   1) 交集非空（否则只读不生效）
 *   2) restrict 真的被调用，且只含真实存在的名字
 *   3) 拿不到 scoped ctx 时拒绝进入
 */
import assert from 'node:assert/strict'
const m = await import('../lib/command-flow.js')

// 线上真实报错里 host 回传的 known global tools（原样）
const REAL_KNOWN = ('SSHManager, advanced_search, ask_user_question, cache_search, codegraph_explore, codegraph_init, ' +
  'codegraph_status, codegraph_sync, create_goal, domain_search, dsh_browser_a11y, dsh_browser_auth, dsh_browser_back, ' +
  'dsh_browser_challenge, dsh_browser_check, dsh_browser_clear, dsh_browser_click, dsh_browser_close_tab, dsh_browser_content, ' +
  'dsh_browser_download, dsh_browser_execute, dsh_browser_fill, dsh_browser_forward, dsh_browser_get_value, dsh_browser_history, ' +
  'dsh_browser_key, dsh_browser_list_tabs, dsh_browser_open, dsh_browser_refresh, dsh_browser_replay, dsh_browser_reset, ' +
  'dsh_browser_reset_session, dsh_browser_restrict, dsh_browser_scrape, dsh_browser_screenshot, dsh_browser_scroll, ' +
  'dsh_browser_select, dsh_browser_session, dsh_browser_set_value, dsh_browser_snapshot, dsh_browser_switch_tab, ' +
  'dsh_browser_type, dsh_browser_visited, dsh_browser_wait, edit, exit_plan_mode, flow_agent_reparent, flow_board, ' +
  'flow_config, flow_inspect, flow_issue_sync, flow_lane, flow_pr_merge, flow_pr_open, flow_pr_review, flow_publish, flow_reply, ' +
  'flow_scope_set, flow_task_comment, flow_task_create, flow_task_move, flow_task_remove, flow_message, flow_worker_inject, ' +
  'flow_worker_log, flow_worker_reset, flow_worker_steer, flow_worktree, free_search_test, get_goal, glob, grep, interrupt_agent, ' +
  'job_kill, job_list, job_output, list_agents, multi_search, platform_search, present, pwsh, read, read_image, research, ' +
  'send_message, skill, subagent_fork, todo_write, update_goal, video_search, weather, web_fetch, web_search, write')
  .split(',').map((x) => x.trim()).filter(Boolean)

let pass = 0
const fails = []
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push(name + '：' + ((err && err.message) || err)); console.log('  ✗ ' + name + '：' + ((err && err.message) || err).slice(0, 180)) }
}

t('意图清单与真实注册表的交集非空', () => {
  const plan = m.describeDenyPlan({ schemas: () => REAL_KNOWN.map((name) => ({ name })) })
  assert.equal(plan.willRestrict, true, '交集为空会让只读失效')
  assert.deepEqual(plan.deny.slice().sort(), ['edit', 'present', 'pwsh', 'todo_write', 'write'])
  console.log('      deny=' + JSON.stringify(plan.deny) + '  剔除=' + JSON.stringify(plan.missing))
})

t('/flow 进入：restrict 只收到真实存在的名字', () => {
  const calls = []
  const tools = {
    schemas: () => REAL_KNOWN.map((name) => ({ name })),
    restrict: (filter) => { calls.push(filter.deny.slice()); return () => calls.push('disposed') },
  }
  const mode = m.createFlowMode({ log: () => {} })
  const r = mode.enter({ ctx: { tools } }, 'ses_real', tools)
  assert.equal(r.ok, true, r.message)
  assert.equal(calls.length, 1, 'restrict 要调一次')
  for (const ghost of ['bash', 'str_replace_editor', 'write_file', 'edit_file', 'replace', 'apply_patch']) {
    assert.equal(calls[0].includes(ghost), false, ghost + ' 不能进 deny')
  }
  assert.match(r.message, /已收回写工具/)
  mode.exit('ses_real')
})

t('/flow 进入：没有 scoped ctx 时拒绝（不退化成全局）', () => {
  const mode = m.createFlowMode({ log: () => {} })
  const r = mode.enter({ session: {} }, 'ses_noctx', { restrict: () => { throw new Error('不该走到这里') } })
  assert.equal(r.ok, false)
  assert.match(r.message, /scoped/)
})

t('系统提示段落把流程指向 skill，而不是自己复述一遍', () => {
  assert.match(m.FLOW_SECTION_TEXT, /skill/, '要指引调用 flow skill')
  assert.match(m.FLOW_SECTION_TEXT, /name=`?flow/)
})

console.log('\n' + pass + ' 项 /flow 真实模块检查通过' + (fails.length ? '，' + fails.length + ' 失败' : ''))
for (const f of fails) console.log('  ✗ ' + f)
process.exit(fails.length ? 1 : 0)
