/**
 * C-11：视图契约（D-surface §3 S5）。
 *
 * 这个仓库的客户端是 window.__ModuleLoader__ 的 bundle，**拿不到 lib/* 的模块图**，
 * 所以所有「服务端算好的东西」必须经过 panel.js 的白名单投影才能到界面上。
 * 白名单漏一个键的结果不是报错，而是**静默变默认值** ——
 * 技能恒显示「全部」、评审轮数恒 4、每列恒 8 条，看起来像设置没保存。
 *
 * 这里用源码切片把这条约束钉住：client.js 读的每个 cfg.X，panel 必须投影过。
 * 这是 test/tool-schema.mjs 那套「读源码 + 断言字面量」的同一手法。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const clientSrc = readFileSync(new URL('client.js', root), 'utf8')
const panelSrc = readFileSync(new URL('lib/panel.js', root), 'utf8')

let pass = 0
function t(name, fn) { fn(); pass += 1; console.log('  ok ' + pass + ' - ' + name) }

/** client 读的配置键（去重、排序）。 */
const clientCfgKeys = [...new Set([...clientSrc.matchAll(/\bcfg\.([A-Za-z_]\w*)/g)].map((m) => m[1]))].sort()

/** panel 的 project.config 投影白名单。 */
function panelConfigKeys() {
  const at = panelSrc.indexOf('      config: {')
  assert.ok(at > 0, 'panel.js 里找不到 project.config 投影块')
  const end = panelSrc.indexOf('      },', at)
  const block = panelSrc.slice(at, end)
  return [...new Set([...block.matchAll(/^\s{8}([A-Za-z_]\w*):/gm)].map((m) => m[1]))]
}

t('client 读的每个 cfg 键都必须被 panel 投影（白名单漏键 = 界面静默变默认值）', () => {
  const projected = panelConfigKeys()
  const missing = clientCfgKeys.filter((k) => !projected.includes(k))
  assert.deepEqual(missing, [], '这些键 client 会读，但 panel 没投影：' + missing.join(', '))
})

t('投影里必须有这几组核心配置（删了会让设置页读不到）', () => {
  const projected = panelConfigKeys()
  for (const k of ['recordIssues', 'recordPulls', 'autoDispatch', 'autoAccept', 'autoMerge',
    'baseBranch', 'mergeStrategy', 'pushRemote', 'maxInFlightPerProject',
    'remoteMode', 'externalPr', 'acceptanceTickets']) {
    assert.ok(projected.includes(k), '缺投影键 ' + k)
  }
})

t('client 不会把远程 token 明文渲染（只允许读 hasToken / webhookSecret 占位）', () => {
  assert.equal(/cfg\.remote\s*\.\s*token/.test(clientSrc), false, 'client 不该直接读 remote.token')
  assert.ok(/hasToken/.test(panelSrc), 'panel 要回 hasToken 布尔')
})

t('任务可见性的写入口与读入口同时存在', () => {
  const httpSrc = readFileSync(new URL('lib/http.js', root), 'utf8')
  const toolsSrc = readFileSync(new URL('lib/tools.js', root), 'utf8')
  assert.ok(/setTaskVisibility/.test(httpSrc), '写入口 http.setTaskVisibility')
  assert.ok(/visibility/.test(toolsSrc), 'flow_task_update 要能改 visibility')
  assert.ok(/lanes:\s*\{/.test(panelSrc) && /human:/.test(panelSrc) && /issue:/.test(panelSrc), 'panel 要投影 lanes.human / lanes.issue')
  assert.ok(/onHumanBoard/.test(panelSrc) && /onIssueBoard/.test(panelSrc), '两条车道各自过滤，issue 的 auto 卡仍在 lanes.issue')
  assert.ok(/\bvisibility\b/.test(panelSrc), 'visibility 仍要投影')
})

t('交付态与合并态在 panel 上有投影（界面才有东西可贴）', () => {
  for (const k of ['deliveryState', 'delivered', 'mergeState', 'mergeReason', 'kind', 'branchFrom']) {
    assert.ok(new RegExp('\\b' + k + '\\b').test(panelSrc), 'panel 要投影 task.' + k)
  }
})

console.log('view contract ok (' + pass + ' checks)')