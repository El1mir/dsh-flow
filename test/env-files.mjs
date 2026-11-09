/**
 * 建检出时把 `.env` 这类密文本只读拷进来（v0.016 / ticket 02）。
 *
 * 线上教训：BiliNote 的检出里没有 `.env`（被 .gitignore 忽略，从不进版本库），
 * 而验收要求「真实 backend 跑通」→ 每个 run 都在同一处报 200105（API key / URL 不正确），
 * 被当成内容失败反复返工，21 小时里 39 行产品码。
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../lib/core.js'
import { FlowDomain } from '../lib/domain.js'
import { createDispatcher } from '../lib/dispatch.js'

const NL = String.fromCharCode(10)
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flow-env-'))
const repo = join(root, 'repo')
sh(root, ['init', '-q', '-b', 'main', 'repo'])
sh(repo, ['config', 'user.email', 'flow@local'])
sh(repo, ['config', 'user.name', 'flow'])
writeFileSync(join(repo, '.gitignore'), '.env' + NL + '.env.local' + NL)
writeFileSync(join(repo, 'a.txt'), 'base' + NL)
sh(repo, ['add', '-A']); sh(repo, ['commit', '-qm', 'baseline'])
writeFileSync(join(repo, '.env'), 'API_KEY=k-from-main' + NL)

const store = new Store(join(root, 'flow.json'))
await store.load()
const rt = {
  async ensureSession() { return { ok: true, sessionId: 's' } },
  async promptSession() { return { ok: true } },
  async steer() { return { ok: true } },
  async clearWorkerGoal() { return { ok: true, cleared: true } },
}
const domain = new FlowDomain(store, rt)
const dispatcher = createDispatcher({ domain, runtime: rt, store })
const project = await domain.ensureProject({ workspacePath: repo, name: 'envp' })
await domain.updateProjectConfig(project.id, { baseBranch: 'main' })

let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) } catch (err) { fails.push(name); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

const mkTask = async (title) => {
  const x = await domain.createTask(project.id, { title, acceptance: ['x'] })
  await domain.move(x.id, 'claim', { role: 'dispatcher' })
  await domain.setPlan(x.id, '1. x', { role: 'dispatcher' })
  await domain.move(x.id, 'plan_ready', { role: 'dispatcher' })
  await domain.move(x.id, 'approve', { role: 'human', id: 'me' })
  return store.state.tasks[x.id]
}

const proj = () => store.state.projects[project.id]
const t1 = await mkTask('第一张')
const r1 = await dispatcher.ensureWorktree(t1, proj())

await t('① 新检出里出现 .env，内容与主仓库一致', () => {
  assert.equal(r1.ok, true, JSON.stringify(r1))
  const dst = join(r1.path, '.env')
  assert.ok(existsSync(dst), '检出里应当有 .env')
  assert.equal(readFileSync(dst, 'utf8'), 'API_KEY=k-from-main' + NL)
})

await t('② 拷进来的是副本，不是链接：主仓库改了不影响检出里的那份', () => {
  chmodSync(join(repo, '.env'), 0o644)
  writeFileSync(join(repo, '.env'), 'API_KEY=changed' + NL)
  assert.equal(readFileSync(join(r1.path, '.env'), 'utf8'), 'API_KEY=k-from-main' + NL)
})

await t('③ 缺文件不阻断：没有 .env.local 仍建成功，缺口记在返回里', () => {
  assert.equal(r1.ok, true)
  assert.equal(r1.env, undefined, 'ensureWorktree 的返回值不带 env 明细（明细在卡上的评论里）')
})

await t('④ 复用已有检出时补拷缺的那份，且不覆盖已有文件', async () => {
  const t2 = await mkTask('第二张')
  const r2 = await dispatcher.ensureWorktree(t2, proj())
  assert.equal(r2.ok, true)
  // 模拟「上次拷过 .env，但后来 .env.local 才出现在主仓库」
  writeFileSync(join(repo, '.env.local'), 'LOCAL=1' + NL)
  const again = await dispatcher.ensureWorktree(store.state.tasks[t2.id], proj())
  assert.equal(again.ok, true)
  assert.ok(existsSync(join(again.path, '.env.local')), '复用时要补拷')
  assert.equal(readFileSync(join(again.path, '.env'), 'utf8'), 'API_KEY=changed' + NL, '复用补拷必须用主仓库当前的内容，且不覆盖已有')
})

await t('⑤ 目标已存在时不覆盖（人放了自己的版本）', async () => {
  const t3 = await mkTask('第三张')
  const r3 = await dispatcher.ensureWorktree(t3, proj())
  chmodSync(join(r3.path, '.env'), 0o644)   // 拷进来是只读，先放开才能模拟「人自己放了一份」
  writeFileSync(join(r3.path, '.env'), 'MINE=1' + NL)
  const again = await dispatcher.ensureWorktree(store.state.tasks[t3.id], proj())
  assert.equal(again.ok, true)
  assert.equal(readFileSync(join(again.path, '.env'), 'utf8'), 'MINE=1' + NL)
})

await t('⑥ 路径越界被拒：env.files 里写 ../ 或绝对路径不会被拷出去', async () => {
  await domain.updateProjectConfig(project.id, { env: { files: ['../evil.txt', '/abs.txt'] } })
  const t4 = await mkTask('第四张')
  const r4 = await dispatcher.ensureWorktree(t4, proj())
  assert.equal(r4.ok, true, '越界项只是被跳过，不该让建检出失败')
  assert.equal(existsSync(join(root, 'evil.txt')), false)
})

await t('⑦ 拷完是只读（chmod 444 生效时）', () => {
  try {
    const mode = statSync(join(r1.path, '.env')).mode & 0o222
    assert.equal(mode, 0, '不应保留写位')
  } catch (err) {
    if (/EPERM|EACCES/.test(String(err && err.message))) return
    throw err
  }
})

if (fails.length) { console.log('FAIL env-files ' + fails.length + '/' + (pass + fails.length)); process.exitCode = 1 }
else console.log('PASS env-files ' + pass + '/' + pass)