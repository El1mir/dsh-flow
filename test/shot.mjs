/**
 * 截图工具：chrome --headless=new + CDP（Windows 下 chrome 会脱离控制台，直接 --screenshot 拿不到文件）。
 * 用法：node test/shot.mjs <url> <out.png> [width] [height] [fullPage]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json')
const WebSocket = require('ws')

const [url, out, w = '1440', h = '940', full = '0', scrollTo = ''] = process.argv.slice(2)
const port = 9333 + Math.floor(Math.random() * 400)
const profile = join(tmpdir(), 'cdp-shot-' + port)
mkdirSync(dirname(out), { recursive: true })
mkdirSync(profile, { recursive: true })

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
], { detached: false, stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let version = null
for (let i = 0; i < 60; i++) {
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
await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600 })
await send('Page.navigate', { url })
await sleep(1600)
if (scrollTo) { const r0 = await send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(scrollTo)}); if(!el) return 'noel'; const y=el.getBoundingClientRect().top+(window.scrollY||document.documentElement.scrollTop||0)-16; window.scrollTo(0,y); document.documentElement.scrollTop=y; document.body.scrollTop=y; return y})()`, returnByValue: true }); await sleep(500); await send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(scrollTo)}); if(el){window.scrollTo(0, el.getBoundingClientRect().top+(window.scrollY||0)-16)}})()` }); await sleep(600); console.error('scroll', JSON.stringify(r0.result.value)) }
const metrics = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,sh:document.documentElement.scrollHeight,ih:window.innerHeight,title:document.title,cards:document.querySelectorAll(".card").length,cols:document.querySelectorAll(".col").length,proj:document.querySelectorAll(".proj").length})',
  returnByValue: true,
})
const m = JSON.parse(metrics.result.value)
const height = full === '1' ? Math.max(m.sh, m.ih) : Number(h)
if (full === '1') await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height, deviceScaleFactor: 1, mobile: Number(w) < 600 })
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full === '1' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(JSON.stringify({ ...m, out, bytes: Buffer.from(shot.data, 'base64').length }))

ws.close()
chrome.kill()
await sleep(300)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
