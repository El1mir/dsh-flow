import assert from 'node:assert/strict'
import { buildBrief, buildInspectPacket } from '../lib/dispatch.js'
import { systemRulesFor, setRulesInSystemPrompt, criticalRules } from '../lib/prompts.js'
import { commentRejectReason } from '../lib/tools.js'

const project = { id: 'p', name: 'P', workspacePath: 'C:/x', config: {} }
const worker = { id: 'w1', name: '工人1', role: 'worker' }
const task = { id: 'T-1', title: '卡', column: 'running', lane: 'human', plan: { revision: 1, text: 'x' }, stopReport: {} }

// 规则在系统提示词时：消息里不再重复规则正文
setRulesInSystemPrompt(true)
const brief = buildBrief(task, project, worker, { worktree: 'C:/wt' })
assert.doesNotMatch(brief, /【最高优先级/)
assert.doesNotMatch(brief, /【工作方式】/)
assert.match(brief, /系统提示词/)
assert.match(brief, /【案卷 T-1】/)
const pkt = buildInspectPacket(task, 'stop', { verdict: 'keep', reasons: [] }, { project })
assert.doesNotMatch(pkt, /【最高优先级|【你的职责边界】/)
assert.equal(pkt.indexOf('【事件 '), 0)
setRulesInSystemPrompt(false)
assert.match(buildBrief(task, project, worker, {}), /【评论规范/, '回退路径要带评论规范')

// 系统段落内容完整
for (const role of ['worker', 'dispatcher']) {
  const s = systemRulesFor(role)
  assert.match(s, /【最高优先级/)
  assert.match(s, /【评论规范/)
}
assert.equal(criticalRules('dispatcher').split('你是事件驱动的').length - 1, 1, '规则 7 不能重复')

// 评论闸
assert.ok(commentRejectReason('收到'))
assert.ok(commentRejectReason('  好的。 '))
assert.ok(commentRejectReason(''))
assert.ok(commentRejectReason('x'.repeat(2001)))
assert.equal(commentRejectReason('结论：登录页完成，测试 12/12 通过（npm test）'), '')
console.log('v1.38 ok')
