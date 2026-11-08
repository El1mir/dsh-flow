/** 本地验证用：带 DSH 浏览器会话自签 cookie 请求 /api/flow/*。用法：node test/api.mjs <path> [method] */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac } from 'node:crypto'

// Git Bash 会把 /api/... 转成 Windows 路径，这里取回 /api/ 之后的部分
const raw = process.argv[2] ?? '/api/flow/state'
const pathname = (raw.match(/\/api\/.*$/) || [raw])[0]
const [method = 'GET'] = process.argv.slice(3)
const base = new URL('http://127.0.0.1:3080')
const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const m = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/)
if (!m) throw new Error('browser-session secret not found')
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const b64u = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const authority = base.host
const now = Date.now()
const body = b64u(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }))
const value = 'v1.' + body + '.' + b64u(createHmac('sha256', secret).update(body).digest())
const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())
const target = new URL(pathname, base)
if (process.env.API_DEBUG) console.error('target', target.href)
const bodyArg = process.argv[4]
const headers = { cookie: name + '=' + value }
if (bodyArg) headers['content-type'] = 'application/json'
const res = await fetch(target, { method, headers, ...(bodyArg ? { body: bodyArg } : {}) })
const text = await res.text()
console.log(JSON.stringify({ status: res.status, type: res.headers.get('content-type'), len: text.length }))
console.log(process.env.API_FULL ? text : text.slice(0, 1200))
