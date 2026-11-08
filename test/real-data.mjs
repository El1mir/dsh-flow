/**
 * real-data.mjs — 用**真实的 DSH 会话文件 + 真实的 flow.json** 验证 cwd → 项目解析。
 *
 * 为什么要有它：functest 用的是桩，桩再忠实也只是"我理解的 Host"。
 * 这个脚本不猜——直接读 ~/.dsh/sessions 下每个会话的 session.v4.jsonl.zstd 真实会话头，
 * 用插件同款的解析顺序（worktree 反查 → 最长前缀 → 失败）跑一遍。
 *
 * 判定：
 *   - 带 cwd 的会话里，只要有一条能解析出项目就证明"链路对真实数据成立"
 *   - 落在 parent/.flow-worktrees/<repo>/ 的会话必须解析到 <repo> 对应项目
 *   - 样本不足时明确 skip，不算失败
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const home = homedir()
const sessionsRoot = join(home, '.dsh', 'sessions')
const flowFile = join(home, '.dsh', 'flow', 'flow.json')

if (!existsSync(sessionsRoot) || !existsSync(flowFile)) {
  console.log('跳过：没有真实会话目录或 flow.json')
  process.exit(0)
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
const projects = Object.values((JSON.parse(readFileSync(flowFile, 'utf8')).projects) || {})

const projectFromWorktreePath = (cwd) => {
  const target = norm(cwd)
  const m = /^(.*)\/\.flow-worktrees\/([^/]+)(\/|$)/.exec(target)
  if (!m) return null
  const want = (m[1] + '/' + m[2]).toLowerCase()
  return projects.filter((p) => p.workspacePath).find((p) => norm(p.workspacePath).toLowerCase() === want) || null
}

const projectByPrefix = (cwd) => {
  const target = norm(cwd).toLowerCase()
  return projects
    .filter((p) => p.workspacePath)
    .sort((a, b) => norm(b.workspacePath).length - norm(a.workspacePath).length)
    .find((p) => {
      const root = norm(p.workspacePath).toLowerCase()
      return target === root || target.startsWith(root + '/')
    }) || null
}

const resolve = (cwd) => {
  const wt = projectFromWorktreePath(cwd)
  if (wt) return { project: wt, matchedBy: 'worktree' }
  const pref = projectByPrefix(cwd)
  if (pref) return { project: pref, matchedBy: 'workspace' }
  return null
}

const heads = []
const walk = (dir, depth) => {
  if (heads.length >= 60 || depth > 3) return
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) { walk(full, depth + 1); continue }
    if (!/\.jsonl\.zstd$/.test(e.name)) continue
    try {
      const text = zlib.zstdDecompressSync(readFileSync(full)).toString('utf8')
      const first = JSON.parse(text.split('\n')[0])
      if (first && first.type === 'session' && first.cwd) {
        heads.push({ id: first.id || basename(dirname(full)), cwd: first.cwd, preset: first.agentPreset || null })
      }
    } catch { /* 坏文件跳过 */ }
  }
}
walk(sessionsRoot, 0)

let pass = 0
const fails = []
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push(name + '：' + ((err && err.message) || err)); console.log('  ✗ ' + name + '：' + ((err && err.message) || err).slice(0, 200)) }
}

console.log('真实样本：' + heads.length + ' 个带 cwd 的会话，' + projects.length + ' 个项目')

await t('真实会话头里能读到 cwd（兜底链第一手数据存在）', () => {
  assert.ok(heads.length > 0, '至少要有一个带 cwd 的真实会话')
  assert.ok(heads.every((h) => typeof h.cwd === 'string' && h.cwd.length > 0))
})

await t('真实数据里至少一条会话能解析出项目', () => {
  const ok = heads.map((h) => ({ h, r: resolve(h.cwd) })).filter((x) => x.r)
  assert.ok(ok.length > 0, '没有任何会话能解析出项目，解析逻辑或项目数据有问题')
  for (const x of ok.slice(0, 5)) {
    console.log('      → ' + String(x.h.cwd).replace(/^.*Desktop[\\/]/, '') + ' ⇒ ' + x.r.project.name + '（' + x.r.matchedBy + '）')
  }
})

await t('worktree 目录的会话必须解析到它所属仓库的项目', () => {
  const wtHeads = heads.filter((h) => /\.flow-worktrees[\\/]/.test(h.cwd))
  if (!wtHeads.length) return
  let checked = 0
  for (const h of wtHeads) {
    const repo = /\.flow-worktrees[\\/]([^\\/]+)/.exec(h.cwd)[1]
    const hasRepoProject = projects.some((p) => norm(p.workspacePath).endsWith('/' + repo))
    if (!hasRepoProject) continue
    const r = resolve(h.cwd)
    assert.ok(r, 'worktree ' + h.cwd + ' 应能解析到 ' + repo)
    assert.equal(r.matchedBy, 'worktree')
    checked += 1
  }
  console.log('      worktree 样本：' + wtHeads.length + ' 条，其中可校验 ' + checked + ' 条')
})

await t('不带 worktree 的普通目录走最长前缀（不是 worktree 分支）', () => {
  const plain = heads.filter((h) => !/\.flow-worktrees[\\/]/.test(h.cwd))
  const hit = plain.map((h) => ({ h, r: resolve(h.cwd) })).find((x) => x.r)
  if (!hit) return
  assert.equal(hit.r.matchedBy, 'workspace')
})

console.log('\n' + pass + ' 项真实数据检查通过' + (fails.length ? '，' + fails.length + ' 失败' : ''))
for (const f of fails) console.log('  ✗ ' + f)
process.exit(fails.length ? 1 : 0)
