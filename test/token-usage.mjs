import assert from 'node:assert/strict'
import { foldUsage } from '../lib/token-usage.js'

const msg = (turn, step, u) => ({ type: 'assistant/message', data: { turn, step, usage: u } })
const att = (turn, step, u) => ({ type: 'assistant/attempt', data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'text' } }, { type: 'chunk', chunk: { type: 'usage', usage: u } }] } })
const ev = [
  msg(1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 5 }),
  att(1, 2, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0 }),
  msg(1, 2, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0 }), // 同槽重复 → 不重复计
  { type: 'llm/retry-started', data: { turn: 1, step: 2 } },
  msg(1, 2, { inputTokens: 20, outputTokens: 2, cacheReadTokens: 30 }), // 重试 → 新增
  msg(2, 1, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 70 }),
  { type: 'user/message', data: {} },
]
const r = foldUsage(ev)
assert.deepEqual(r, { uncachedInput: 180, output: 18, cacheRead: 1000, cacheWrite: 5, turns: 2, steps: 3 })
assert.deepEqual(foldUsage([]), { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, steps: 0 })
console.log('token-usage ok')
