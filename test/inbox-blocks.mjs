/** v0.012：工单预设组件的规整与文本化。 */
import assert from 'node:assert/strict'
import { normalizeBlocks, blocksToText, BLOCK_TYPES, MAX_BLOCKS } from '../lib/inbox-blocks.js'

const NL = String.fromCharCode(10)
let pass = 0
const fails = []
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push({ name, err }); console.log('  ✗ ' + name); console.log('    ' + String((err && err.message) || err).split(NL)[0]) }
}

await t('① 九种类型齐全，未知类型静默丢弃', () => {
  assert.deepEqual(BLOCK_TYPES.slice().sort(), ['checklist', 'choice', 'code', 'diff', 'evidence', 'facts', 'link', 'note', 'progress'])
  const out = normalizeBlocks([{ type: 'html', text: '<b>x</b>' }, { type: 'note', text: 'hi' }])
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'note')
})

await t('② 最多 12 块（超出的丢掉，不报错）', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ type: 'note', text: 'n' + i }))
  assert.equal(normalizeBlocks(many).length, MAX_BLOCKS)
})

await t('③ choice 少选项被丢，多推荐只留第一个', () => {
  assert.equal(normalizeBlocks([{ type: 'choice', prompt: 'p', options: [{ value: 'A', label: '甲' }] }]).length, 0)
  const [b] = normalizeBlocks([{ type: 'choice', prompt: '选哪个', options: [
    { value: 'A', label: '甲', recommended: true },
    { value: 'B', label: '乙', recommended: true },
  ] }])
  assert.equal(b.options.filter((o) => o.recommended).length, 1)
  assert.equal(b.key, 'q1')
})

await t('④ javascript: 链接被丢弃，http 保留', () => {
  const out = normalizeBlocks([{ type: 'link', items: [
    { kind: 'pr', label: '坏链接', url: 'javascript:alert(1)' },
    { kind: 'pr', label: '好链接', url: 'https://github.com/o/r/pull/1', number: '1' },
  ] }])
  assert.equal(out.length, 1)
  assert.equal(out[0].items.length, 1)
  assert.equal(out[0].items[0].url, 'https://github.com/o/r/pull/1')
})

await t('⑤ 文本超长被截断（单块 2000 字符）', () => {
  const [b] = normalizeBlocks([{ type: 'note', text: 'x'.repeat(5000) }])
  assert.equal(b.text.length, 2000)
})

await t('⑥ progress 的 total<=0 视为非法', () => {
  assert.equal(normalizeBlocks([{ type: 'progress', done: 1, total: 0 }]).length, 0)
  const [p] = normalizeBlocks([{ type: 'progress', label: '验收', done: 7, total: 5 }])
  assert.equal(p.done, 5, 'done 不能超过 total')
})

await t('⑦ facts / evidence / checklist / code 的空内容被丢', () => {
  assert.equal(normalizeBlocks([{ type: 'facts', items: [] }]).length, 0)
  assert.equal(normalizeBlocks([{ type: 'evidence', items: [{ kind: 'file', ref: '' }] }]).length, 0)
  assert.equal(normalizeBlocks([{ type: 'checklist', items: [{ text: '' }] }]).length, 0)
  assert.equal(normalizeBlocks([{ type: 'code', text: '  ' }]).length, 0)
})

await t('⑧ blocksToText 一行一块，模型能直接读', () => {
  const text = blocksToText([
    { type: 'note', tone: 'warn', text: '主检出有未提交改动' },
    { type: 'choice', key: 'q2', prompt: '按哪条走', options: [{ value: 'A', label: '先提交' }, { value: 'B', label: '先搁置' }] },
    { type: 'facts', title: '现状', items: [{ k: '卡', v: 'T-049' }, { k: '列', v: 'merging' }] },
    { type: 'evidence', items: [{ kind: 'commit', ref: '4293589' }] },
    { type: 'progress', label: '验收', done: 3, total: 5 },
    { type: 'diff', files: 3, additions: 120, deletions: 8 },
    { type: 'checklist', items: [{ text: 'a', checked: true }, { text: 'b' }] },
    { type: 'code', lang: 'js', text: 'const a = 1' + NL + 'more' },
  ])
  const lines = text.split(NL)
  assert.equal(lines.length, 8)
  assert.match(lines[0], /^！ 主检出有未提交改动/)
  assert.match(lines[1], /^选择 q2：按哪条走（A 先提交 \/ B 先搁置）/)
  assert.match(lines[2], /^现状（现状）：卡=T-049；列=merging/)
  assert.match(lines[4], /^进度：验收 3\/5/)
  assert.match(lines[5], /^变更：3 文件 \+120\/-8/)
  assert.match(lines[6], /^清单：1\/2 已勾/)
  assert.match(lines[7], /^代码\(js\)：const a = 1/)
})

await t('⑨ 空输入返回空数组 / 空串（不抛错）', () => {
  assert.deepEqual(normalizeBlocks(null), [])
  assert.deepEqual(normalizeBlocks('nope'), [])
  assert.equal(blocksToText(undefined), '')
})

if (fails.length) { console.log('FAIL inbox-blocks ' + fails.length + '/' + (pass + fails.length)); process.exitCode = 1 }
else console.log('PASS inbox-blocks ' + pass + '/' + pass)