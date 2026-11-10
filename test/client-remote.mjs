/**
 * RT-05：客户端远程事务界面的源码契约。
 * 与 test/view-contract.mjs 同一手法：client.js 是 bundle，不跑 DOM，
 * 用字面量把车道看板、工单/消息、remoteMode、外部 PR 审批钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let pass = 0
function t(name, fn) { fn(); pass += 1; console.log('  ok ' + pass + ' - ' + name) }

t('buildLocalView 投影 lanes.human / lanes.issue', () => {
  assert.match(src, /onHumanBoard/)
  assert.match(src, /onIssueBoard/)
  assert.equal(src.includes('human: Object.assign'), true)
  assert.equal(src.includes('issue: Object.assign'), true)
})

t('看板页签是人车道 / 自动车道，旧台账不是主视图', () => {
  assert.match(src, /人车道/)
  assert.match(src, /自动车道/)
  assert.match(src, /boardLane/)
  assert.doesNotMatch(src, /这些卡被系统自动接管，不上看板/)
})

t('remoteMode / externalPr / acceptanceTickets', () => {
  assert.match(src, /remoteMode/)
  assert.match(src, /externalPr/)
  assert.match(src, /acceptanceTickets/)
  assert.match(src, /remoteReason/)
})

t('消息与外部 PR 审批走指定 action', () => {
  assert.match(src, /lane.message.list/)
  assert.match(src, /lane.message.post/)
  assert.match(src, /task.approveExternal/)
  assert.match(src, /调度会审核/)
})

t('Inbox 顶栏是工单 / 消息，芯片含外部 PR 与已归档', () => {
  assert.match(src, /工单/)
  assert.match(src, /消息/)
  assert.match(src, /待批准/)
  assert.match(src, /外部 PR/)
  assert.match(src, /已归档/)
})

t('不读取 cfg.remote.token 明文', () => {
  assert.equal(src.includes('cfg.remote.token'), false)
  assert.match(src, /hasToken/)
})

t('远程合并文案，且没有关闭远程 PR / 强制本地合并', () => {
  assert.match(src, /远程合并（forge PR）/)
  assert.equal(src.includes('关闭远程 PR'), false)
  assert.equal(src.includes('强制本地合并'), false)
  assert.equal(src.includes('force-local-merge'), false)
})

t('消息正文当文本，链接只放行 http(s)，未投递不承诺叫醒', () => {
  assert.match(src, /未投递/)
  assert.equal(src.includes('https?:\\/\\/'), true)
  assert.doesNotMatch(src, /已叫醒/)
})

console.log('client-remote: ' + pass + ' passed')
