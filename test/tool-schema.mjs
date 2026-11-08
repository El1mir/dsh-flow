/**
 * tool-schema.mjs — 工具返回值必须符合它自己声明的 output.schema。
 *
 * 由来：flow_publish 返回里多了 column/phase/dispatched，而 schema 写了 additionalProperties: false，
 * Host 于是整次拒掉——**任务其实已经建好了**，用户看到的是报错 + 一堆已创建的任务。
 * 这类"schema 与实现漂移"没法靠字段级断言覆盖（谁也不会去断言某个多余字段），
 * 所以这里做结构性校验：把每个工具 execute 里 return ok(...) 的字面量键名抽出来，
 * 与 schema.properties 对比。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')

/** 取 name: '...' 到下一个 name: 之间的片段。 */
const toolBlocks = []
const re = /name: '([a-z_]+)',/g
let m
const marks = []
while ((m = re.exec(src))) marks.push({ name: m[1], at: m.index })
for (let i = 0; i < marks.length; i += 1) {
  const start = marks[i].at
  const end = i + 1 < marks.length ? marks[i + 1].at : src.length
  toolBlocks.push({ name: marks[i].name, body: src.slice(start, end) })
}

/** 从 ok(..., { a, b: c }) 里抽顶层键名。 */
const keysOfPayload = (text) => {
  const idx = text.indexOf('{')
  if (idx < 0) return []
  const keys = []
  let depth = 0
  let i = idx + 1
  let tokenStart = -1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; i += 1; continue }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) break
      depth -= 1
      i += 1
      continue
    }
    if (depth === 0) {
      if (/[A-Za-z_$]/.test(ch) && tokenStart < 0) tokenStart = i
      else if (tokenStart >= 0 && !/[A-Za-z0-9_$]/.test(ch)) {
        const word = text.slice(tokenStart, i)
        // 只认 "word:" 形式（对象键）
        let j = i
        while (j < text.length && /\s/.test(text[j])) j += 1
        if (text[j] === ':') keys.push(word)
        tokenStart = -1
      }
    }
    i += 1
  }
  return [...new Set(keys)]
}

let pass = 0
const fails = []
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ✓ ' + name) }
  catch (err) { fails.push(name + '：' + ((err && err.message) || err)); console.log('  ✗ ' + name + '：' + ((err && err.message) || err).slice(0, 200)) }
}

console.log('扫描到 ' + toolBlocks.length + ' 个工具')

t('每个工具都声明了 output.schema', () => {
  const missing = toolBlocks.filter((b) => !/output:\s*\{[^}]*schema:/.test(b.body)).map((b) => b.name)
  assert.deepEqual(missing, [], '缺 schema 的工具：' + missing.join(', '))
})

t('additionalProperties:false 的工具，返回值里的字面量键都在 schema.properties 里', () => {
  const problems = []
  for (const block of toolBlocks) {
    // 只检查"严格模式"的 schema
    const strict = /additionalProperties:\s*false/.test(block.body)
    if (!strict) continue
    // schema.properties 的键名：定位本块的 output: 之后，再取 properties → required 之间，
    // 避免拿别的工具的 properties 当自己的（会造成"多了字段"的假阳性）。
    const outIdx = block.body.indexOf('output:')
    if (outIdx < 0) continue
    const tail = block.body.slice(outIdx)
    const propMatch = /properties:\s*\{([\s\S]*?)\},\s*\n?\s*required:/.exec(tail)
    if (!propMatch) continue
    const declared = new Set()
    const pRe = /([A-Za-z_$][A-Za-z0-9_$]*):\s*\{/g
    let pm
    while ((pm = pRe.exec(propMatch[1]))) declared.add(pm[1])

    // execute 里所有 ok( / fail( 调用的第二个对象参数
    const calls = []
    const okRe = /return\s+(ok|fail)\(([\s\S]*?)\)\s*\n/g
    let om
    while ((om = okRe.exec(block.body))) calls.push(om[2])
    for (const call of calls) {
      const commaIdx = call.indexOf(',')
      if (commaIdx < 0) continue
      const payload = call.slice(commaIdx + 1)
      if (!payload.trim().startsWith('{')) continue
      for (const key of keysOfPayload(payload)) {
        if (!declared.has(key)) problems.push(block.name + ' → 多了字段 ' + key)
      }
    }
  }
  assert.deepEqual(problems, [], '返回值超出 schema：\n  ' + problems.join('\n  '))
})

t('schema 的 type 必须是单一类型字符串（DSH 不支持 type 数组）', () => {
  // DSH 的 assertSupportedJsonSchema 只接受 type: 'string' 这种写法；
  // 写成 type: ['string','null'] 会让**整个插件注册失败**（线上报 1 entry did not activate），
  // 不是某个工具坏掉，是全部 tools 都没了。所以这条必须静态盯死。
  const bad = []
  const re = /type:\s*\[/g
  let m
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const lineEnd = src.indexOf('\n', m.index)
    bad.push(src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim())
  }
  assert.deepEqual(bad, [], '这些地方用了 type 数组，会让插件注册直接失败：\n  ' + bad.join('\n  '))
})

t('schema 里没有 null 类型的字段（配合单类型约束，用空串/省略代替）', () => {
  assert.equal(/"null"|'null'/.test(src.replace(/\/\/[^\n]*/g, '')), false, "schema 里不该出现 'null' 类型")
})

t('schema 只用受支持的子集关键字（anyOf/oneOf/$ref 这些 DSH 不支持）', () => {
  // 只看 "<关键字>:" 这种 schema 键形式，避免命中注释里的自然语言（"not a declared property"）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const forbidden = /['"]?\b(anyOf|oneOf|allOf|\$ref|patternProperties|additionalItems|dependencies)\b['"]?\s*:/
  assert.equal(forbidden.test(code), false, '出现了 DSH 不支持的 schema 关键字')
})

t('flow_publish 声明了它会返回的 column/phase/dispatched', () => {
  const block = toolBlocks.find((b) => b.name === 'flow_publish')
  assert.ok(block, '要有 flow_publish')
  for (const key of ['column', 'phase', 'dispatched']) {
    assert.match(block.body, new RegExp('properties:\\s*\\{[\\s\\S]*?' + key + ':', 'm'), 'schema 要声明 ' + key)
  }
})

t('工具只通过 ok()/fail() 返回，且两者都经过 sanitizeLossless（防 lossless JSON 拒收）', () => {
  assert.match(src, /const ok = \(message, extra = \{\}\) => sanitizeLossless\(/, 'ok() 必须清洗')
  assert.match(src, /const fail = \(message\) => sanitizeLossless\(/, 'fail() 必须清洗')
  const raw = []
  for (const block of toolBlocks) {
    const ex = block.body.indexOf('execute(')
    if (ex < 0) continue
    const body = block.body.slice(ex)
    if (/return\s+\{\s*ok\s*:/.test(body)) raw.push(block.name)
  }
  assert.deepEqual(raw, [], '这些工具直接 return { ok: … } 绕过了清洗：' + raw.join(', '))
})

console.log('\n' + pass + ' 项工具 schema 检查通过' + (fails.length ? '，' + fails.length + ' 失败' : ''))
for (const f of fails) console.log('  ✗ ' + f)
process.exit(fails.length ? 1 : 0)
