/**
 * dsh-flow · setup 单元测试
 *
 * 全走纯函数，不起服务、不碰网络：parseRemoteUrl / planSetup 的判定逻辑
 * 就是「初始化时到底会自动改什么」的唯一真相，必须能单独验。
 */
import assert from 'node:assert/strict'
import { parseRemoteUrl, planSetup } from '../lib/setup.js'

let n = 0
const t = (name, fn) => { fn(); n += 1; if (process.env.DSH_FLOW_VERBOSE) console.log('  ok ' + name) }

// ---- parseRemoteUrl --------------------------------------------------------
t('scp 风格 git@github.com 解析出 owner/repo', () => {
  const r = parseRemoteUrl('git@github.com:El1mir/BiliNote.git')
  assert.equal(r.host, 'github.com')
  assert.equal(r.kind, 'github')
  assert.equal(r.owner, 'El1mir')
  assert.equal(r.repo, 'BiliNote')
  assert.equal(r.baseUrl, 'https://api.github.com')
})

t('https 风格带 .git 后缀也解析', () => {
  const r = parseRemoteUrl('https://github.com/El1mir/BiliNote.git')
  assert.equal(r.owner, 'El1mir')
  assert.equal(r.repo, 'BiliNote')
})

t('https 带用户名/端口', () => {
  const r = parseRemoteUrl('https://user@git.example.com:8443/team/repo.git')
  assert.equal(r.host, 'git.example.com')
  assert.equal(r.owner, 'team')
  assert.equal(r.repo, 'repo')
  assert.equal(r.kind, 'unknown')
  assert.equal(r.baseUrl, null)
})

t('嵌套组路径取最后一段做 repo', () => {
  const r = parseRemoteUrl('git@gitlab.com:group/sub/deep-repo.git')
  assert.equal(r.owner, 'group')
  assert.equal(r.repo, 'deep-repo')
})

t('空串 / 垃圾串 / 单段路径都返回 null', () => {
  assert.equal(parseRemoteUrl(''), null)
  assert.equal(parseRemoteUrl('   '), null)
  assert.equal(parseRemoteUrl('not-a-url'), null)
  assert.equal(parseRemoteUrl('https://github.com/onlyowner'), null)
})

// ---- planSetup -------------------------------------------------------------
const detectedBase = {
  isRepo: true,
  hasCommits: true,
  branches: { current: 'master', default: 'master', all: ['master', 'dev'] },
  remote: { name: 'origin', kind: 'github', host: 'github.com', owner: 'El1mir', repo: 'BiliNote', baseUrl: 'https://api.github.com' },
  upstream: { ok: true, hasIssues: true, defaultBranch: 'master' },
  notes: [],
}

t('baseBranch 留空 → 填成仓库真实默认分支', () => {
  const { patch, notes } = planSetup({ baseBranch: '', remote: null }, detectedBase)
  assert.equal(patch.baseBranch, 'master')
  assert.ok(notes.some((x) => /基础分支设为 master/.test(x)))
})

t('baseBranch 写错成 main → 纠正成 master（BiliNote T-012 的事故形态）', () => {
  const { patch, notes } = planSetup({ baseBranch: 'main', remote: null }, detectedBase)
  assert.equal(patch.baseBranch, 'master')
  assert.ok(notes.some((x) => /main 在仓库里不存在/.test(x)))
})

t('baseBranch 写对 → 不动', () => {
  const { patch } = planSetup({ baseBranch: 'dev', remote: null }, detectedBase)
  assert.equal(patch.baseBranch, undefined)
})

t('remote 缺失 → 从远程地址补上坐标，并标 useGhCli', () => {
  const { patch, notes } = planSetup({ baseBranch: 'master', remote: null }, detectedBase)
  assert.equal(patch.remote.owner, 'El1mir')
  assert.equal(patch.remote.repo, 'BiliNote')
  assert.equal(patch.remote.kind, 'github')
  assert.equal(patch.remote.useGhCli, true)
  assert.ok(notes.some((x) => /远程仓库设为 El1mir\/BiliNote/.test(x)))
})

t('remote 已配同一个仓库 → 不重写（保住人填的 token）', () => {
  const cur = { baseBranch: 'master', remote: { kind: 'github', owner: 'el1mir', repo: 'biliNote', token: 'abc', baseUrl: 'https://api.github.com' } }
  const { patch } = planSetup(cur, detectedBase)
  assert.equal(patch.remote, undefined)
})

t('上游开着 issue → 打开 recordIssues、pushRemote 与 autoDispatch', () => {
  const { patch, notes } = planSetup({ baseBranch: 'master', remote: null }, detectedBase)
  assert.equal(patch.recordIssues, true)
  assert.equal(patch.pushRemote, true)
  assert.equal(patch.autoDispatch, true)
  assert.ok(notes.some((x) => /已打开 issue 记录/.test(x)))
  // autoAccept / autoMerge 是交付策略，不该被自检替人决定
  assert.equal(patch.autoAccept, undefined)
  assert.equal(patch.autoMerge, undefined)
})

t('已经开着 recordIssues → 不重复写 autoDispatch（尊重人已定的配置）', () => {
  const { patch } = planSetup({ baseBranch: 'master', remote: null, recordIssues: true }, detectedBase)
  assert.equal(patch.autoDispatch, undefined)
  assert.equal(patch.recordIssues, undefined)
})

t('上游 issue 关着 → 不打开 recordIssues', () => {
  const d = { ...detectedBase, upstream: { ok: true, hasIssues: false } }
  const { patch, notes } = planSetup({ baseBranch: 'master', remote: null }, d)
  assert.equal(patch.recordIssues, undefined)
  assert.equal(patch.pushRemote, undefined)
  assert.ok(notes.some((x) => /上游仓库没开 issue/.test(x)))
})

t('探测失败 → 不猜，录 recordIssues 保持关闭', () => {
  const d = { ...detectedBase, upstream: { ok: false, reason: 'http-404' } }
  const { patch, notes } = planSetup({ baseBranch: 'master', remote: null }, d)
  assert.equal(patch.recordIssues, undefined)
  assert.ok(notes.some((x) => /读不到上游仓库信息/.test(x)))
})

t('不是 git 仓库 → 一条 patch 都不出', () => {
  const { patch } = planSetup({ baseBranch: '', remote: null }, { isRepo: false, hasCommits: false, branches: {}, remote: null, upstream: null })
  assert.deepEqual(patch, {})
})

t('没有远程 → 只补分支，不补 remote / 不动 issue 开关', () => {
  const d = { ...detectedBase, remote: null, upstream: null }
  const { patch } = planSetup({ baseBranch: '', remote: null }, d)
  assert.equal(patch.baseBranch, 'master')
  assert.equal(patch.remote, undefined)
  assert.equal(patch.recordIssues, undefined)
})

t('零提交仓库 → 不动 baseBranch（没分支可选）', () => {
  const d = { ...detectedBase, hasCommits: false, branches: { current: null, default: null, all: [] } }
  const { patch } = planSetup({ baseBranch: 'main' }, d)
  assert.equal(patch.baseBranch, undefined)
})

console.log(n + ' 项环境自检检查通过')