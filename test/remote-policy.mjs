/**
 * remote-policy：唯一「是否出网 / 能不能用远程 PR」判定（RT-00 / ADR-0007 §1）。
 *
 * 这一层是纯函数，所有模式判定都从这里出；后续票只允许读 policyFor 的结果，
 * 不得再散落 cfg.pushRemote / cfg.recordIssues / cfg.remote.enabled。
 *
 * 钉住的语义（票面 §2）：
 *   · mode='remote' 要求四项同时满足：remoteMode、坐标完整、provider 支持 merge、pushRemote；
 *   · 任何一项不满足都返回 local，并给出唯一的 reason；
 *   · gitea 在 RT-01 验证 merge API 前一律 mergeSupported=false，只能靠 opts.canMergePull 显式打开；
 *   · can* 都是「远程模式 + 对应单项开关」的交集，不是单项开关本身；
 *   · 不 import domain/sync/remote（避免环）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { policyFor } from '../lib/remote-policy.js'

const NL = String.fromCharCode(10)
let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (e) { fails.push({ name, e }); console.log('  ✗ ' + name + NL + '    ' + String((e && e.message) || e)) }
}

const project = (config) => ({ id: 'p', config })
const gh = { kind: 'github', owner: 'o', repo: 'r' }
const gt = { kind: 'gitea', owner: 'o', repo: 'r' }
const full = (extra = {}) => project({ remoteMode: true, remote: gh, pushRemote: true, ...extra })

// ---- A：默认与「四项缺一不可」 --------------------------------------------
await t('① 默认项目：local，reason=remote-mode-off，全部 can* false', () => {
  for (const p of [project({}), project(undefined), { id: 'p' }, null]) {
    const pol = policyFor(p)
    assert.equal(pol.mode, 'local')
    assert.equal(pol.reason, 'remote-mode-off')
    assert.equal(pol.remoteMode, false)
    assert.equal(pol.remoteReady, false)
    assert.equal(pol.hasCoords, false)
    assert.equal(pol.canPushIssues, false)
    assert.equal(pol.canIngestIssues, false)
    assert.equal(pol.canIngestPulls, false)
    assert.equal(pol.canUseRemotePr, false)
    assert.equal(pol.canAutoMergeExternal, false)
    assert.equal(pol.canAcceptAutomatically, false)
  }
})

await t('② remoteMode=false + 完整坐标 + pushRemote：仍是 local（单项开关打不开远程模式）', () => {
  const pol = policyFor(project({ remoteMode: false, remote: gh, pushRemote: true, recordIssues: true, recordPulls: true }))
  assert.equal(pol.mode, 'local')
  assert.equal(pol.reason, 'remote-mode-off')
  assert.equal(pol.remoteReady, false)
  assert.equal(pol.canPushIssues, false)
  assert.equal(pol.canIngestIssues, false)
  assert.equal(pol.canIngestPulls, false)
  assert.equal(pol.canUseRemotePr, false)
})

await t('③ remoteMode=true 但坐标不完整：local + missing-remote', () => {
  for (const remote of [undefined, null, {}, { kind: 'github' }, { kind: 'github', owner: 'o' }, { kind: 'github', repo: 'r' }]) {
    const pol = policyFor(project({ remoteMode: true, remote, pushRemote: true }))
    assert.equal(pol.mode, 'local')
    assert.equal(pol.reason, 'missing-remote')
    assert.equal(pol.hasCoords, false)
    assert.equal(pol.remoteReady, false)
  }
  // 坐标完整但 remoteMode 是字符串 "true"：不是 true，按关处理
  const pol = policyFor(project({ remoteMode: 'true', remote: gh, pushRemote: true }))
  assert.equal(pol.mode, 'local')
  assert.equal(pol.reason, 'remote-mode-off')
})

await t('④ 坐标 + remoteMode + mergeSupported，但 pushRemote=false：local + push-remote-off', () => {
  const pol = policyFor(full({ pushRemote: false }), { canMergePull: true })
  assert.equal(pol.mode, 'local')
  assert.equal(pol.reason, 'push-remote-off')
  assert.equal(pol.remoteReady, false)
  assert.equal(pol.mergeSupported, true, '这项失败的原因是 pushRemote，不是 merge 能力')
  assert.equal(pol.canUseRemotePr, false)
})

await t('⑤ gitea + 完整坐标 + pushRemote：未验证 merge API 前 merge-unsupported', () => {
  const pol = policyFor(project({ remoteMode: true, remote: gt, pushRemote: true }))
  assert.equal(pol.mode, 'local')
  assert.equal(pol.reason, 'merge-unsupported')
  assert.equal(pol.mergeSupported, false)
  assert.equal(pol.remoteReady, false)
})

await t('⑥ github + 完整坐标 + pushRemote + recordIssues：remote，单项能力各归各位', () => {
  const pol = policyFor(full({ recordIssues: true }))
  assert.equal(pol.mode, 'remote')
  assert.equal(pol.reason, null)
  assert.equal(pol.remoteMode, true)
  assert.equal(pol.remoteReady, true)
  assert.equal(pol.hasCoords, true)
  assert.equal(pol.mergeSupported, true)
  assert.equal(pol.canPushIssues, true)
  assert.equal(pol.canIngestIssues, true)
  assert.equal(pol.canIngestPulls, false, 'recordPulls 未开')
  assert.equal(pol.canUseRemotePr, true)
  assert.equal(pol.canAutoMergeExternal, false)
  // recordPulls 打开后 canIngestPulls 才为真；pushRemote 关掉后 canUseRemotePr 才为假
  assert.equal(policyFor(full({ recordIssues: true, recordPulls: true })).canIngestPulls, true)
  const noPush = policyFor(full({ recordIssues: true, pushRemote: false }))
  assert.equal(noPush.mode, 'local')
  assert.equal(noPush.canUseRemotePr, false)
  assert.equal(noPush.canPushIssues, false)
})

await t('⑦ gitea 的 canMergePull 必须由调用方显式给：true 才 remote，false 仍 local', () => {
  const base = project({ remoteMode: true, remote: gt, pushRemote: true })
  const off = policyFor(base, { canMergePull: false })
  assert.equal(off.mode, 'local')
  assert.equal(off.reason, 'merge-unsupported')
  const on = policyFor(base, { canMergePull: true })
  assert.equal(on.mode, 'remote')
  assert.equal(on.mergeSupported, true)
  // 未知 provider 默认不支持 merge
  const unknown = policyFor(project({ remoteMode: true, remote: { kind: 'bitbucket', owner: 'o', repo: 'r' }, pushRemote: true }))
  assert.equal(unknown.mode, 'local')
  assert.equal(unknown.reason, 'merge-unsupported')
})

await t('⑧ canAutoMergeExternal = 远程模式 && externalPr.autoMerge && autoMerge', () => {
  const both = full({ externalPr: { autoMerge: true }, autoMerge: true })
  assert.equal(policyFor(both).canAutoMergeExternal, true)
  assert.equal(policyFor(full({ externalPr: { autoMerge: true }, autoMerge: false })).canAutoMergeExternal, false, 'autoMerge 是第二道闸门')
  assert.equal(policyFor(full({ externalPr: { autoMerge: false }, autoMerge: true })).canAutoMergeExternal, false, 'externalPr.autoMerge 默认 false')
  assert.equal(policyFor(full({ externalPr: {}, autoMerge: true })).canAutoMergeExternal, false)
  // 本地模式下即使两个开关都开也不允许
  const local = project({ remoteMode: false, remote: gh, pushRemote: true, externalPr: { autoMerge: true }, autoMerge: true })
  assert.equal(policyFor(local).canAutoMergeExternal, false)
})

await t('⑨ canAcceptAutomatically 只看 autoAccept，与模式无关', () => {
  assert.equal(policyFor(project({ autoAccept: true })).canAcceptAutomatically, true)
  assert.equal(policyFor(full({ autoAccept: true })).canAcceptAutomatically, true)
  assert.equal(policyFor(full({ autoAccept: false })).canAcceptAutomatically, false)
  assert.equal(policyFor(full({ autoAccept: 'true' })).canAcceptAutomatically, false, '只认 === true')
})

await t('⑩ 纯函数：不改 project，也不读 import（避免与 domain/sync/remote 成环）', () => {
  const cfg = { remoteMode: true, remote: { ...gh }, pushRemote: true, recordIssues: true }
  const p = project(cfg)
  const before = JSON.stringify(p)
  const pol1 = policyFor(p)
  const pol2 = policyFor(p)
  assert.deepEqual(pol1, pol2, '同样输入必须同样输出')
  assert.equal(JSON.stringify(p), before, '不得往 project 上写东西')
  const src = readFileSync(new URL('../lib/remote-policy.js', import.meta.url), 'utf8')
  assert.ok(!/^\s*import\s/m.test(src), 'remote-policy.js 必须是零 import 的纯模块')
})

console.log(NL + pass + ' 通过，' + fails.length + ' 失败')
if (fails.length) {
  for (const f of fails) console.log('- ' + f.name + ': ' + String((f.e && f.e.stack) || f.e).split(NL).slice(0, 3).join(NL))
  process.exit(1)
}
