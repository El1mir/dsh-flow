/**
 * 环境自检（v0.016 / ticket 10）：开工前把缺什么说清楚，别让工人跑八轮才发现。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'
import { probe, renderLine, renderChecklist, PREFLIGHT_TTL_MS } from '../lib/preflight.js'

const NL = String.fromCharCode(10)
let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL).slice(0, 4).join(' | ')) }
}

let clock = Date.UTC(2026, 0, 1)
const project = { id: 'P-1', workspacePath: 'C:/ws', config: { preflight: [
  { type: 'file', path: '.env', hint: '数据库口令在这里' },
  { type: 'dir', path: 'data' },
  { type: 'http', url: 'http://127.0.0.1:8484/health', hint: 'backend 没起来' },
] } }
let fetches = 0
const deps = {
  fileExists: async (p) => p.endsWith('.env') || p.endsWith('data'),
  fetch: async (url) => { fetches += 1; return { ok: url.includes('8484'), status: 200 } },
}

await t('① 全通过：三项都 ✔，摘要一行能进案卷', async () => {
  const r = await probe(project, { deps, now: () => clock })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 3)
  assert.match(renderLine(r), /环境自检：✔ \.env ✔ data ✔ 127\.0\.0\.1:8484（3 条）/)
})

await t('② 缺文件：单项 ✘，清单里带提示', async () => {
  const p2 = JSON.parse(JSON.stringify(project))
  p2.config.preflight = [{ type: 'file', path: '.env', hint: '口令' }]
  const r = await probe(p2, { deps: { fileExists: async () => false }, now: () => clock })
  assert.equal(r.ok, false)
  assert.match(renderChecklist(r), /✘ \.env — 口令/)
})

await t('③ 端口不通：http 项 ✘（不抛错，记下原因）', async () => {
  const p2 = JSON.parse(JSON.stringify(project))
  p2.config.preflight = [{ type: 'http', url: 'http://127.0.0.1:9999/health' }]
  const r = await probe(p2, { deps: { fetch: async () => ({ ok: false, status: 502 }) }, now: () => clock })
  assert.equal(r.ok, false)
  assert.equal(r.items[0].ok, false)
})

await t('④ 30 分钟内命中缓存，不再重复探测', async () => {
  const p2 = JSON.parse(JSON.stringify(project))
  const a = await probe(p2, { deps, now: () => clock })
  p2.preflight = a
  fetches = 0
  clock += PREFLIGHT_TTL_MS - 60000
  const b = await probe(p2, { deps, now: () => clock })
  assert.equal(b.cached, true)
  assert.equal(fetches, 0, '缓存命中不该发网络请求')
})

await t('⑤ 过期或配置改动 → 立即重探', async () => {
  const p2 = JSON.parse(JSON.stringify(project))
  const a = await probe(p2, { deps, now: () => clock })
  p2.preflight = a
  fetches = 0
  clock += PREFLIGHT_TTL_MS + 1
  const b = await probe(p2, { deps, now: () => clock })
  assert.equal(b.cached, false)
  assert.ok(fetches > 0)
  const c = await probe({ ...p2, config: { preflight: [{ type: 'file', path: '.env' }] } }, { deps, now: () => clock })
  assert.equal(c.cached, false, '配置变了就不能用旧结论')
})

// ---- 派工集成 -------------------------------------------------------------
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-pf-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, 'a.txt'), 'x' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])
const store = new Store(join(root, 'flow.json'))
await store.load()
const prompts = []
const rt = {
  async ensureSession(agent) { return { ok: true, sessionId: 'ses-' + agent.id } },
  async promptSession(_s, text) { prompts.push(String(text || '')); return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const proj = await domain.ensureProject({ workspacePath: repo, name: 'pf' })
await domain.updateProjectConfig(proj.id, { baseBranch: 'main' })
await domain.ensureAgents(proj.id)
const workers = Object.values(store.state.agents).filter((a) => a.role === 'worker')
for (const w of workers) await domain.bindSession(w.id, 'ses-' + w.id, { state: 'idle' }, { role: 'system' })
async function ready(title) {
  const task = await domain.createTask(proj.id, { title, acceptance: ['x'] })
  await domain.move(task.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(task.id, '1. 做', { role: 'dispatcher' })
  await domain.move(task.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(task.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[task.id]
}

const okCard = await ready('环境齐的卡')
await t('⑥ 自检通过：案卷里出现「环境自检：」一行', async () => {
  await domain.updateProjectConfig(proj.id, { preflight: [{ type: 'file', path: 'a.txt' }] })
  const res = await dispatcher.dispatch(store.state.tasks[okCard.id])
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200))
  assert.ok(prompts.some((p) => p.includes('环境自检：✔')), '案卷要写清环境')
})

const badCard = await ready('缺环境的卡')
await t('⑦ 自检失败：卡进 blocked-needs-env、有请示、不派工', async () => {
  await domain.updateProjectConfig(proj.id, { preflight: [{ type: 'file', path: 'nope.env', hint: '缺配置' }] })
  const res = await dispatcher.dispatch(store.state.tasks[badCard.id])
  assert.equal(res.ok, false)
  assert.equal(res.blocked, 'needs-env')
  const cur = store.state.tasks[badCard.id]
  assert.equal(cur.phase, 'blocked-needs-env')
  assert.equal(cur.activeRunId, null)
  const ticket = (store.state.human_inbox || []).find((x) => x.taskId === badCard.id && x.from === 'system:preflight')
  assert.ok(ticket, '要开一张写清楚缺什么的请示')
  assert.match(String(ticket.problem || ''), /✘ nope\.env/)
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')