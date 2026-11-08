import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
process.env.DSH_FLOW_MERGE_WINDOW_MS = '5'
process.env.DSH_FLOW_MERGE_MAX_WAIT_MS = '20'
const dir = await mkdtemp(join(tmpdir(), 'flow-comment-'))
const store = new Store(join(dir, 'flow.json'))
await store.load()
const calls = []
const runtime = { async promptSession(...args) { calls.push(args); return { ok: true } } }
const domain = new FlowDomain(store, runtime)
const dispatcher = createDispatcher({ domain, runtime, store })
const project = await domain.ensureProject({ workspacePath: join(dir, 'repo'), name: 'comment delivery' })
const agent = Object.values(store.state.agents).find(a => a.projectId === project.id && a.role === 'dispatcher')
await domain.bindSession(agent.id, 'dispatcher-session', { state: 'idle' }, { role: 'system' })
const task = await domain.createTask(project.id, { title: 'human question' })
const off = dispatcher.watchEvents()
try {
  await domain.comment(task.id, '审核到哪里了，ui组件全部审核完了吗', { role: 'human', id: 'web' })
  await domain.pumpOutbox(500)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.ok(calls.some(c => c[1].includes('审核到哪里了')), 'human comment must reach dispatcher promptSession')
  assert.equal(calls.find(c => c[1].includes('审核到哪里了'))[2], 'steer', 'event must use steer instead of queue')
  await domain.comment(task.id, '第二条追问必须送达', { role: 'human', id: 'web' })
  await domain.pumpOutbox(500)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.ok(calls.some(c => c[1].includes('第二条追问必须送达')), 'distinct human comments must not be suppressed by the 30 second window')
  console.log('PASS human comments reach dispatcher via steer without dedupe loss')
} finally { off(); await rm(dir, { recursive: true, force: true }) }
