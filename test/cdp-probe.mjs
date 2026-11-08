/**
 * CDP 探针：带头打开 DSH Web（用 ~/.dsh/.credentials.yaml 里的浏览器会话密钥自签 cookie），
 * 执行一段表达式、截图。用法：
 *   node test/cdp-probe.mjs <url> <out.png> [expr|@file] [w] [h] [waitMs]
 * 仅本地验证用，不随插件发布。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, createHmac } from 'node:crypto'

const require = createRequire('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json')
const WebSocket = require('ws')

const [url, out, exprArg = '', w = '1440', h = '940', waitArg = '4000'] = process.argv.slice(2)
const expr = exprArg.startsWith('@') ? readFileSync(exprArg.slice(1), 'utf8') : exprArg
const waitMs = Number(waitArg) || 4000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function authCookie() {
  const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const m = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/)
  if (!m) throw new Error('browser-session secret not found')
  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  const authority = new URL(url).host
  const b64u = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 }
  const body = b64u(JSON.stringify(payload))
  const value = 'v1.' + body + '.' + b64u(createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())
  return { name, value, domain: new URL(url).hostname }
}

const port = 9333 + Math.floor(Math.random() * 400)
const profile = join(tmpdir(), 'cdp-probe-' + port)
mkdirSync(profile, { recursive: true })
mkdirSync(dirname(out), { recursive: true })

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
], { detached: false, stdio: 'ignore' })

let version = null
for (let i = 0; i < 80; i++) {
  try { version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); break } catch { await sleep(250) }
}
if (!version) { console.error('chrome did not start'); process.exit(1) }

const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

let id = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
const cookie = authCookie()
const set = await send('Network.setCookie', { ...cookie, path: '/', httpOnly: true, sameSite: 'Strict' })
const exp = Math.round((Number(w) / 2)) + ''
await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600 })
await send('Page.navigate', { url })
await sleep(waitMs)
let value = null
if (expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  value = r.result && r.result.value
  if (r.exceptionDetails) value = { exception: r.exceptionDetails.text, description: r.exceptionDetails.exception && r.exceptionDetails.exception.description }
}
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(JSON.stringify({ cookieSet: set.success, value, out, bytes: Buffer.from(shot.data, 'base64').length }, null, 1))

ws.close()
chrome.kill()
await sleep(300)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
