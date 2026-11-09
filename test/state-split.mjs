/**
 * 热/冷拆分（v0.016.1）：全量保留，启动只读热数据，冷集合按需装载。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, COLD_KEYS } from '../lib/core.js'

const NL = String.fromCharCode(10)
let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL).slice(0, 3).join(' | ')) }
}

const dir = mkdtempSync(join(tmpdir(), 'flow-split-'))
const file = join(dir, 'flow.json')
const ledger = join(dir, 'flow-ledger.json')

// 一个老库：冷集合还在 flow.json 里
const legacy = {
  schemaVersion: 16,
  projects: { 'P-1': { id: 'P-1', name: 'p' } },
  tasks: { 'T-1': { id: 'T-1', column: 'todo' } },
  events: [{ id: 'ev_1', at: '2026-01-01T00:00:00.000Z', payload: 'kind-of-big' }],
  outbox: [{ id: 'ob_1', deliveredAt: null, at: '2026-01-01T00:00:00.000Z' }],
  event_inbox: [{ id: 'in_1', dedupeKey: 'x:1', at: '2026-01-01T00:00:00.000Z' }],
  message_log: [{ id: 'ml_1', at: '2026-01-01T00:00:00.000Z' }],
  injections: [{ id: 'inj_1' }],
  human_inbox: [],
}
writeFileSync(file, JSON.stringify(legacy, null, 2))
const st = new Store(file)
await st.load()

await t('① 首次加载就把冷集合拆到 ledger，热文件里不再有它们', async () => {
  const hot = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(hot.outbox, undefined)
  assert.equal(hot.event_inbox, undefined)
  assert.equal(hot.message_log, undefined)
  assert.equal(hot.injections, undefined)
  assert.ok(Array.isArray(hot.events), 'events 留在热集合（看板时间线要用）')
  assert.equal(hot.tasks['T-1'].column, 'todo')
  assert.ok(existsSync(ledger), '账本文件要写出来')
  const cold = JSON.parse(readFileSync(ledger, 'utf8'))
  assert.equal(cold.outbox.length, 1)
  assert.equal(cold.event_inbox[0].dedupeKey, 'x:1')
})

await t('② 启动时冷集合是空的，ledgerReady 之后才装进内存', async () => {
  const st2 = new Store(file)
  await st2.load()
  assert.deepEqual(st2.state.outbox, [], '热加载阶段不读账本')
  await st2.ledgerReady()
  assert.equal(st2.state.outbox.length, 1)
  assert.equal(st2.state.message_log.length, 1)
  assert.equal(st2.state.events.length, 1, '热集合一加载就有')
})

await t('③ 事务会先等账本，冷集合不会被写成空', async () => {
  const st3 = new Store(file)
  await st3.load()
  await st3.tx((s) => { s.tasks['T-1'].column = 'running' })
  const cold = JSON.parse(readFileSync(ledger, 'utf8'))
  assert.equal(cold.outbox.length, 1, '事务不能抹掉投递队列')
  const hot = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(hot.tasks['T-1'].column, 'running')
})

await t('④ 反复重启不丢数据、热文件保持精简', async () => {
  for (let i = 0; i < 3; i += 1) {
    const s4 = new Store(file)
    await s4.load()
    await s4.ledgerReady()
    assert.equal(s4.state.outbox.length, 1)
    assert.equal(s4.state.events.length, 1)
    await s4.tx((s) => { s.tasks['T-1'].title = 'x' + i })
  }
  const hot = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(hot.tasks['T-1'].title, 'x2')
  const cold = JSON.parse(readFileSync(ledger, 'utf8'))
  for (const k of COLD_KEYS) assert.ok(cold[k] !== undefined || k === 'injections', '冷集合 ' + k + ' 要在账本里')
})

await t('⑤ 空库：没有账本也能跑，第一次事务不会炸', async () => {
  const f5 = join(dir, 'fresh.json')
  const s5 = new Store(f5)
  await s5.load()
  await s5.tx((s) => { s.projects['P-9'] = { id: 'P-9' } })
  assert.equal(existsSync(join(dir, 'fresh-ledger.json')), false, '没有冷数据就不该造空账本')
})

if (fails.length) { console.log(NL + pass + ' 通过，' + fails.length + ' 失败'); process.exitCode = 1 }
else console.log(NL + pass + ' 通过，0 失败')