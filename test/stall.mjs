/**
 * 项目停摆告警（v0.016 / ticket 12）：还有待办、却几小时没有一个 run。
 * 线上出现过「master 停在 8 天前，没人发现」—— 这条告警就是为了不再靠人眼。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import { createScheduler } from '../lib/scheduler.js'

const NL = String.fromCharCode(10)
const root = mkdtempSync(join(tmpdir(), 'flow-stall-'))
const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
let clock = Date.now()
const scheduler = createScheduler({ domain, dispatcher, store, log: () => {}, now: () => clock })
const project = await domain.ensureProject({ workspacePath: root, name: 's' })
await domain.ensureAgents(project.id)
const worker = Object.values(store.state.agents).find((a) => a.role === 'worker')
await domain.bindSession(worker.id, 'ses-' + worker.id, { state: 'idle' }, { role: 'system' })
const task = await domain.createTask(project.id, { title: '没人管的卡', acceptance: ['x'] })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL).slice(0, 4).join(' | ')) }
}
const stallTickets = () => (store.state.human_inbox || []).filter((x) => x.from === 'system:stall')

await t('① 6 小时内不告警', async () => {
  clock += 5 * 3600000
  await scheduler.tick()
  assert.equal(stallTickets().length, 0)
})

await t('② 超过 6 小时且还有待办 → 发一条，含停摆时长与待办数', async () => {
  clock += 2 * 3600000
  await scheduler.tick()
  const list = stallTickets()
  assert.equal(list.length, 1)
  assert.match(list[0].topic, /停摆 \d+ 小时/)
  assert.match(list[0].topic, /1 张卡/)
})

await t('③ 同一停摆窗口只发一次', async () => {
  clock += 3600000
  await scheduler.tick()
  assert.equal(stallTickets().length, 1)
})

await t('④ 有新 run 之后计数器重置，下一次停摆再发', async () => {
  await domain.startRun(task.id, { agentId: worker.id, sessionId: 'ses-' + worker.id, trigger: 'system' }, { role: 'system' })
  await domain.endRun(task.id, 'failed', { stopReason: 'test' })
  clock += 7 * 3600000
  await scheduler.tick()
  assert.equal(stallTickets().length, 2, '恢复运行后再停摆，应该再发一次')
})

await t('⑤ 没有待办卡时不告警', async () => {
  await store.tx((s) => { Object.assign(s.tasks[task.id], { column: 'done', phase: 'merged' }) })
  clock += 7 * 3600000
  await scheduler.tick()
  assert.equal(stallTickets().length, 2)
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')