/**
 * dsh-flow · disk
 *
 * 派工前的磁盘余量检查。
 *
 * 为什么要有：ework 在 ENOSPC 上翻过车（`workdir-gc.ts` 里就是为这个事故加的闸门）。
 * 建 worktree 本身几乎不占空间，但刚建完工人就要装依赖、跑构建 —— 盘满了的表现是
 * 「工人莫名其妙失败」，而失败原因写在会话里、看板上只看到「会话报错」，
 * 人要翻半天才发现是盘满。这里在建 worktree 之前就拦住，并把原因写到卡上。
 *
 * 阈值：项目配置 `minFreeBytes`（默认 2GB）。检查不出来（statfs 不可用）就放行 ——
 * 这是防呆，不是硬约束，不能因为它自身不可用而卡住派工。
 */
import { statfs } from 'node:fs/promises'

export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

/** 人类可读的大小。 */
export function humanBytes(n) {
  const v = Number(n) || 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1 }
  return (i === 0 ? String(Math.round(x)) : x.toFixed(1)) + units[i]
}

/**
 * 读某个路径所在卷的可用字节。
 * @returns {Promise<{ok:boolean, freeBytes:number|null, reason?:string}>}
 */
export async function freeBytes(path) {
  if (!path) return { ok: false, freeBytes: null, reason: 'no-path' }
  try {
    const st = await statfs(path)
    const bsize = Number(st.bsize) || 0
    // Linux 用 bavail（非特权可用块）；Windows 的 statfs 也只给这三个字段
    const blocks = Number(st.bavail ?? st.bfree) || 0
    if (!bsize || !blocks) return { ok: false, freeBytes: null, reason: 'statfs-empty' }
    return { ok: true, freeBytes: bsize * blocks }
  } catch (err) {
    return { ok: false, freeBytes: null, reason: String((err && err.message) || err) }
  }
}

/**
 * 派工前的门禁。
 * @returns {Promise<{ok:boolean, skipped?:string, freeBytes?:number|null, minFreeBytes?:number, reason?:string}>}
 */
export async function checkFreeSpace(path, minFreeBytes = DEFAULT_MIN_FREE_BYTES) {
  const min = Number(minFreeBytes) || DEFAULT_MIN_FREE_BYTES
  const res = await freeBytes(path)
  if (!res.ok) return { ok: true, skipped: res.reason, freeBytes: null, minFreeBytes: min }
  if (res.freeBytes < min) {
    return {
      ok: false,
      freeBytes: res.freeBytes,
      minFreeBytes: min,
      reason: '磁盘余量不足：' + path + ' 所在卷只剩 ' + humanBytes(res.freeBytes) + '（要求至少 ' + humanBytes(min) + '）',
    }
  }
  return { ok: true, freeBytes: res.freeBytes, minFreeBytes: min }
}
