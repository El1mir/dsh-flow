/** CDP 探针：在页面里跑一段表达式并打印结果。用法：node test/probe.mjs <url> <expr> [w] [h] */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json')
const WebSocket = require('ws')
const [url, expr, w = '390', h = '844'] = process.argv.slice(2)
const port = 9800 + Math.floor(Math.random() * 300)
const profile = join(tmpdir(), 'cdp-probe-' + port)
mkdirSync(profile, { recursive: true })
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = false
for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:'+port+'/json/version'); ok = true; break } catch { await sleep(250) } }
if (!ok) { console.error('chrome did not start'); process.exit(1) }
const target = await (await fetch('http://127.0.0.1:'+port+'/json/new?about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
let id = 0
const pending = new Map()
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600 })
await send('Page.navigate', { url })
await sleep(1500)
const code = expr.startsWith('@') ? (await import('node:fs')).readFileSync(expr.slice(1), 'utf8') : expr
const res = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(res.result.value !== undefined ? res.result.value : res, null, 1))
ws.close(); chrome.kill(); await sleep(200)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
