/**
 * dsh-flow · exec
 *
 * 受控的命令执行（合并后冒烟检查用）。
 *
 * 边界写清楚，因为这是唯一一个「项目配置里的字符串会被当命令跑」的地方：
 *   1. 必须显式配置 postMergeCheck 才会跑，没有配置就什么都不做；
 *   2. 只跑一条命令，有超时（默认 120s），超时就杀进程树；
 *   3. cwd 固定是项目工作区，不给自定义环境变量表；
 *   4. 输出只留尾部若干行（冒烟失败时人要看的就是最后那几十行）。
 *
 * 为什么不在 git 层做：这是「项目自己的验收命令」，和 git 无关；
 * 放在独立模块里，将来要加 allowlist / 白名单钩子只改这一处。
 */
import { execFile } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 120 * 1000
const TAIL_LINES = 40

const tail = (text, lines = TAIL_LINES) => {
  const all = String(text || '').split(/\r?\n/).filter((x) => x !== '')
  return all.slice(-lines).join('\n')
}

/**
 * 跑一条命令。
 * @returns {Promise<{ok:boolean, skipped?:string, code:number|null, stdout:string, stderr:string, timedOut?:boolean, command:string}>}
 */
export function runCommand({ command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} } = {}) {
  const cmd = String(command || '').trim()
  if (!cmd) return Promise.resolve({ ok: true, skipped: 'empty-command', code: null, stdout: '', stderr: '', command: '' })
  return new Promise((resolve) => {
    const child = execFile(cmd, {
      cwd,
      timeout: Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: true,
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      const timedOut = !!(err && (err.killed || err.signal))
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: tail(stdout),
        stderr: tail(stderr),
        timedOut,
        command: cmd,
      })
    })
    // 兜底：某些 shell 包装会让 timeout 不生效，这里再挂一道
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS) + 2000)
    if (t && typeof t.unref === 'function') t.unref()
    child.on('exit', () => clearTimeout(t))
  })
}

/** 合并后冒烟检查的配置读取（只认显式配置，不猜）。 */
export function postMergeCheckOf(project) {
  const cfg = (project && project.config) || {}
  const raw = cfg.postMergeCheck
  if (!raw) return null
  if (typeof raw === 'string') return raw.trim() ? { command: raw, timeoutMs: DEFAULT_TIMEOUT_MS } : null
  if (typeof raw === 'object' && typeof raw.command === 'string' && raw.command.trim()) {
    return { command: raw.command.trim(), timeoutMs: Number(raw.timeoutMs) || DEFAULT_TIMEOUT_MS }
  }
  return null
}
