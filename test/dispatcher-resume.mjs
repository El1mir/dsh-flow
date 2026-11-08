/**
 * v0.007：调度员自己那一轮被 503 这类环境错误打断时，自动续跑同一个会话。
 *
 * 口径：设置里默认开启，最多连续 5 次（可调），全失败就投一条 inbox 的「系统错误」（kind=error）。
 * 人点「停止生成」不续跑 —— 那是人的决定，接上去等于跟人对着干。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-resume-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
const { writeFileSync } = await import('node:fs')
writeFileSync(join(repo, 'a.txt'), 'a' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])

const store = new Store(join(root, 'flow.json'))
await store.load()
const prompts = []
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession(sessionId, text, mode) { prompts.push({ sessionId, text, mode }); return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'resume' })
await domain.ensureAgents(project.id)
const disp = Object.values(store.state.agents).find((a) => a.projectId === project.id && a.role === 'dispatcher')
await domain.bindSession(disp.id, 'ses-disp-r', { state: 'idle' }, { role: 'system' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const errEvent = { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'SERVER 503: Service temporarily unavailable', code: 'model_not_found' } } } }
const okEvent = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
const stopEvent = { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }

const first = await dispatcher.onSessionEvent('ses-disp-r', errEvent)

await t('① 默认开启：调度员报错后自动续跑（给同一个会话发 queue 消息）', () => {
  assert.equal(first.resumed && first.resumed.resumed, true, JSON.stringify(first))
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'ses-disp-r')
  assert.equal(prompts[0].mode, 'queue')
  assert.match(prompts[0].text, /自动续跑 1\/5/)
})

await t('①b 续跑文案要求从断点继续、不要重复已做完的事、做完就结束本轮', () => {
  assert.match(prompts[0].text, /断点/)
  assert.match(prompts[0].text, /不要/)
  assert.match(prompts[0].text, /结束本轮/)
})

await t('② 连续失败计数递增', async () => {
  const r = await dispatcher.onSessionEvent('ses-disp-r', errEvent)
  assert.equal(r.resumed.count, 2)
  assert.equal(prompts.length, 2)
})

await t('③ 正常完成一轮后计数清零（下一次又从 1 开始）', async () => {
  const r = await dispatcher.onSessionEvent('ses-disp-r', okEvent)
  assert.equal(r.reason, 'dispatcher-resumed-ok')
  await dispatcher.onSessionEvent('ses-disp-r', errEvent)
  assert.match(prompts[prompts.length - 1].text, /自动续跑 1\/5/)
})

await t('④ 人点停止不续跑（也不计入失败次数）', async () => {
  const before = prompts.length
  const r = await dispatcher.onSessionEvent('ses-disp-r', stopEvent)
  assert.equal(r.resumed.skipped, 'human-stopped')
  assert.equal(prompts.length, before)
})

await t('⑤ 连到上限就停，并投一条 inbox 的系统错误（kind=error）', async () => {
  // 上面已经续了 1 次（第 3 步清零后从 1 开始）；再撞 4 次到 5。
  for (let i = 0; i < 4; i += 1) await dispatcher.onSessionEvent('ses-disp-r', errEvent)
  const before = prompts.length
  const r = await dispatcher.onSessionEvent('ses-disp-r', errEvent)
  assert.equal(r.resumed.exhausted, true, JSON.stringify(r.resumed))
  assert.equal(prompts.length, before, '到上限后不再往会话里发消息')
  const note = (store.state.human_inbox || []).find((x) => x.kind === 'error')
  assert.ok(note, '没有投出系统错误')
  assert.match(note.body, /连续 5 次/)
  assert.match(note.body, /503|model_not_found/)
})

await t('⑥ 到上限后重复失败不会刷出第二条错误通知', async () => {
  await dispatcher.onSessionEvent('ses-disp-r', errEvent)
  const notes = (store.state.human_inbox || []).filter((x) => x.kind === 'error')
  assert.equal(notes.length, 1, JSON.stringify(notes.map((x) => x.id)))
})

await t('⑦ 设置里关掉就不续跑（也不计数）', async () => {
  store.state.settings = { ...(store.state.settings || {}), dispatcherAutoResume: false }
  const before = prompts.length
  const r = await dispatcher.onSessionEvent('ses-disp-r', errEvent)
  assert.equal(r.resumed.skipped, 'disabled')
  assert.equal(prompts.length, before)
})

await t('⑧ 上限可配（dispatcherAutoResumeMax）', async () => {
  store.state.settings = { ...(store.state.settings || {}), dispatcherAutoResume: true, dispatcherAutoResumeMax: 2 }
  const other = await domain.createTask(project.id, { title: '占位', acceptance: ['x'] })
  assert.ok(other.id)
  // 先清零：跑一轮正常完成
  await dispatcher.onSessionEvent('ses-disp-r', okEvent)
  await dispatcher.onSessionEvent('ses-disp-r', errEvent)   // 第 1 次：续跑
  await dispatcher.onSessionEvent('ses-disp-r', errEvent)   // 第 2 次：续跑（= 上限）
  const r2 = await dispatcher.onSessionEvent('ses-disp-r', errEvent)   // 第 3 次：到上限
  assert.equal(r2.resumed.exhausted, true, JSON.stringify(r2.resumed))
  assert.equal(r2.resumed.max, 2)
})

await t('⑨ 未知会话（没有 agent）不续跑、不报错', async () => {
  const r = await dispatcher.onSessionEvent('ses-nobody', errEvent)
  assert.equal(r.ok, true)
  assert.equal(r.resumed, undefined)
})

if (fails.length) {
  console.log('FAIL dispatcher-resume ' + fails.length + '/' + (pass + fails.length))
  for (const f of fails) console.log('  - ' + f.name + ': ' + String((f.err && f.err.message) || f.err).split(NL).slice(0, 3).join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS dispatcher-resume ' + pass + '/' + pass)
}