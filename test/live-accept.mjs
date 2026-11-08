/**
 * live-accept.mjs — 线上实例验收脚本（重启 dsh web 之后跑）。
 *
 * 单测证明的是"代码对"，这个脚本证明的是"**你正在用的这个实例**已经加载了新代码"。
 * 用法：
 *   node test/live-accept.mjs [baseUrl] [cookie]
 * 默认 http://127.0.0.1:3080，cookie 从 DSH_COOKIE 环境变量取（不传就跳过鉴权）。
 */
import assert from 'node:assert/strict'

const base = (process.argv[2] || process.env.DSH_BASE || 'http://127.0.0.1:3080').replace(/\/$/, '')

/** 从 ~/.dsh/.credentials.yaml 现签一个 cookie（只在本地用，不打印、不落盘）。 */
const mintCookie = async () => {
  const { readFileSync } = await import('node:fs')
  const { createHmac, createHash } = await import('node:crypto')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return '' }
  const m = /secret:\s*([^\s]+)/.exec(raw)
  if (!m) return ''
  const secret = m[1].replace(/^["']|["']$/g, '')
  const authority = new URL(base).host
  const body = Buffer.from(JSON.stringify({ v: 1, authority })).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  return name + '=v1.' + body + '.' + sig
}

const cookie = process.argv[3] || process.env.DSH_COOKIE || await mintCookie()

const headers = cookie ? { cookie } : {}
const get = async (path) => {
  const r = await fetch(base + path, { headers })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: r.status, json, text }
}
const post = async (action, args) => {
  const r = await fetch(base + '/api/flow/action', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ action, args: args || {} }),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: r.status, json, text }
}
const act = async (action, args) => {
  const r = await post(action, args)
  const body = r.json || {}
  return body.result || body
}

let pass = 0
const fails = []
const t = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log('  ✓ ' + name)
  } catch (err) {
    fails.push({ name, message: (err && err.message) || String(err) })
    console.log('  ✗ ' + name + '\n      ' + ((err && err.message) || String(err)).slice(0, 300))
  }
}

// 0) 鉴权
const health = await get('/api/flow/health')
if (health.status === 401) {
  console.log('\n鉴权被拒（401）。把浏览器里的 dsh-auth cookie 传进来：')
  console.log('  node test/live-accept.mjs http://127.0.0.1:3080 \'dsh-auth-xxx=...\'')
  process.exit(2)
}
await t('实例在线且 flow 数据可读', () => {
  assert.equal(health.status, 200, 'health 应 200，实际 ' + health.status)
  assert.equal(health.json.ok, true)
})

// 1) 新代码是否已加载：session-project 对"有 cwd 的会话"必须解析成功
const sessions = await act('session.list', {})
const items = (sessions && sessions.items) || []
let probe = null
for (const item of items) {
  if (!item || !item.sessionId) continue
  const r = await get('/api/flow/session-project?sessionId=' + encodeURIComponent(item.sessionId))
  if (r.json && r.json.ok) { probe = { sessionId: item.sessionId, resolved: r.json }; break }
}
await t('会话 → 工作区 → 项目能解析（说明新解析逻辑已加载）', async () => {
  if (!probe) {
    // 解析失败时顺手把诊断打出来：到底是 inspect 没给 cwd，还是持久化层也没有
    const anySession = items.find((x) => x && x.sessionId)
    if (anySession) {
      const diag = await act('diag.cwd', { sessionId: anySession.sessionId })
      console.log('      诊断（' + anySession.sessionId.slice(0, 18) + '）：')
      if (diag && diag.sources) {
        console.log('        inspect      → ' + JSON.stringify(diag.sources.inspect).slice(0, 160))
        console.log('        persistence  → ' + JSON.stringify(diag.sources.persistence).slice(0, 160))
        console.log('        agentSession → ' + JSON.stringify(diag.sources.agentSession).slice(0, 160))
        console.log('        resolvedCwd  → ' + JSON.stringify(diag.resolvedCwd))
      } else {
        console.log('        diag.cwd 也不可用：' + JSON.stringify(diag).slice(0, 160) + '（说明是旧模块）')
      }
    }
    assert.ok(probe, '所有会话都解析失败（见上面的诊断）')
  }
  assert.ok(probe.resolved.projectId, '要拿到 projectId')
  console.log('      → ' + probe.sessionId.slice(0, 18) + ' ⇒ ' + probe.resolved.projectName + '（' + probe.resolved.matchedBy + '）')
})

// 2) 项目视图
if (probe) {
  const pv = await get('/api/flow/project?projectId=' + encodeURIComponent(probe.resolved.projectId))
  await t('/project 返回七列 + 双车道', () => {
    assert.equal(pv.status, 200)
    assert.equal(pv.json.columns.length, 7)
    assert.ok(pv.json.lanes.human && pv.json.lanes.issue)
  })
}

// 3) catalog（模型下拉数据源）
const cat = await act('catalog.get', {})
await t('catalog.get 返回 DSH 原生模型目录', () => {
  assert.equal(cat.ok, true, 'catalog.get 失败：' + JSON.stringify(cat).slice(0, 160))
  assert.ok(Array.isArray(cat.catalog.groups) && cat.catalog.groups.length > 0, '要有 provider 分组')
  assert.ok(cat.catalog.default && cat.catalog.default.provider, '要有默认模型')
})

// 3.5) /flow 的 restrict 计划（只读诊断，不真的收工具）
const diagFlow = await post('diag.flow', { sessionId: (items[0] && items[0].sessionId) || '' })
const diagFlowBody = (diagFlow.json && (diagFlow.json.result || diagFlow.json)) || {}
await t('/flow 的 deny 清单按真实注册表收敛（不再含本构建没有的工具名）', () => {
  assert.doesNotMatch(diagFlow.text, /unknown action/, 'diag.flow 不存在 → 还是旧模块，需要重启')
  if (diagFlowBody.ok === false) {
    console.log('      （跳过：' + (diagFlowBody.error || '拿不到活跃 agent') + '）')
    return
  }
  assert.ok(Array.isArray(diagFlowBody.deny), '要返回 deny 计划')
  console.log('      deny = ' + JSON.stringify(diagFlowBody.deny))
  console.log('      缺（本构建没有，不再传）= ' + JSON.stringify(diagFlowBody.missing))
  for (const ghost of ['bash', 'str_replace_editor', 'write_file', 'edit_file', 'replace', 'apply_patch']) {
    if (diagFlowBody.missing && diagFlowBody.missing.includes(ghost) && diagFlowBody.deny.includes(ghost)) {
      throw new Error(ghost + ' 不在注册表里却进了 deny（会导致 restrict 原子失败）')
    }
  }
})

// 4) /flow 的 restrict 修复：这里只验证 action 面存在（真正的 /flow 要在聊天里敲）
await t('task.reply / catalog.get / task.origin 这些新 action 都已加载', async () => {
  for (const name of ['task.reply', 'catalog.get', 'task.origin']) {
    const r = await post(name, { taskId: 'T-__probe__' })
    assert.doesNotMatch(r.text, /unknown action/, name + ' 还是未知 action，线上是旧模块')
  }
})

// 4.5) v1.16：初始化仓库（幂等，只在有项目时跑；不打断在跑的工人）
if (probe) {
  const init = await act('project.init', { projectId: probe.resolved.projectId })
  await t('project.init 可用，且幂等（第二次不再新建会话）', async () => {
    assert.doesNotMatch(JSON.stringify(init), /unknown action/, 'project.init 不存在 → 还是旧模块，需要重启')
    assert.ok(init && init.ok !== false, 'project.init 失败：' + JSON.stringify(init).slice(0, 200))
    assert.ok(Array.isArray(init.created) && Array.isArray(init.renamed) && Array.isArray(init.moved), '要返回 created/renamed/moved')
    console.log('      ' + init.message)
    const again = await act('project.init', { projectId: probe.resolved.projectId })
    assert.equal((again.created || []).length, 0, '第二次不该再建会话：' + JSON.stringify(again.created).slice(0, 160))
  })
}

// 4.6) v1.16：会话 cwd 是否已收敛到项目工作区（这就是"工人会话看不见"的根因）
if (probe) {
  const pv = await get('/api/flow/project?projectId=' + encodeURIComponent(probe.resolved.projectId))
  const rows = ((pv.json && pv.json.agents) || []).filter((a) => a && a.role !== 'chief' && a.sessionCwd)
  await t('工人/调度会话的 cwd 落在项目工作区（不再跟 worktree 走）', () => {
    if (!rows.length) {
      console.log('      （跳过：这个项目还没有带 cwd 的工位会话）')
      return
    }
    const off = rows.filter((a) => String(a.sessionCwd || '').replace(/\\/g, '/').toLowerCase() !== String(pv.json.project.path || '').replace(/\\/g, '/').toLowerCase())
    assert.deepEqual(off.map((a) => a.label + ' → ' + a.sessionCwd), [], '这些会话还不工作区里')
  })
}

// 5) 工作区对账：tick 要能跑
const tick = await act('event.tick', {})
await t('scheduler tick 可执行（工作区对账 / 补位都在里面）', () => {
  assert.ok(tick && tick.at, 'tick 要返回报告')
})

console.log('\n' + pass + ' 项线上验收通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''))
if (fails.length) {
  console.log('\n未通过项：')
  for (const f of fails) console.log('  ✗ ' + f.name + '：' + f.message.slice(0, 200))
  console.log('\n如果失败项集中在"解析/未知 action"，说明 dsh web 还是旧进程——重启它再跑一次。')
}
process.exit(fails.length ? 1 : 0)
