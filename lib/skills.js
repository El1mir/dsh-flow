import { homedir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { readdir, readFile, realpath } from 'node:fs/promises'

const validName = (name) => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)
const rootsFor = (project) => [...new Set([project?.workspacePath && join(project.workspacePath, '.agents', 'skills'), join(homedir(), '.agents', 'skills')].filter(Boolean).map((p) => resolve(p)))]
/**
 * v1.40：allowedSkills 只决定「向 AI 暴露哪些技能」，不再作为调用时的权限闸门。
 *
 * 旧实现在 resolveSkill 里对未列入白名单的技能直接返回
 * "Skill is not allowed: <name>"，结果是不在列表里的技能连按名加载都做不到 ——
 * 这属于权限加固，而不是暴露控制。现在：加载一律放行（只保留名称合法性与路径穿越检查），
 * 白名单只影响 exposedSkills() 返回给 AI 的可见集合。
 */
const allows = (project, name) => project?.config?.allowedSkills == null || (Array.isArray(project.config.allowedSkills) && project.config.allowedSkills.includes(name))

export async function resolveSkill(project, name) {
  if (!validName(name)) return { ok: false, message: 'Invalid skill name: ' + name }
  for (const root of rootsFor(project)) {
    try {
      const base = await realpath(root)
      const path = await realpath(join(root, name, 'SKILL.md'))
      if (!path.startsWith(base + sep)) continue
      return { ok: true, name, skillName: name, path, content: await readFile(path, 'utf8') }
    } catch (err) {
      if (!['ENOENT', 'ENOTDIR'].includes(err.code)) return { ok: false, message: 'Cannot read skill ' + name + ': ' + err.message }
    }
  }
  return { ok: false, message: 'Skill not found: ' + name }
}

export async function listSkills(project) {
  const names = new Set()
  for (const root of rootsFor(project)) {
    try { for (const entry of await readdir(root)) if (validName(entry)) names.add(entry) }
    catch (err) { if (!['ENOENT', 'ENOTDIR'].includes(err.code)) throw err }
  }
  const skills = []
  for (const name of [...names].sort()) {
    const skill = await resolveSkill(project, name)
    if (skill.ok) skills.push({ name, skillName: name, path: skill.path })
  }
  return skills
}

/**
 * 向 AI 暴露的技能集合：allowedSkills 为 null 时等于全部已安装技能，
 * 为数组时只保留其中列出的技能（未列出的安装着但不可见）。
 *
 * 与 listSkills 的区别：listSkills 是「磁盘上装了什么」（设置页要能看到全部才能勾选），
 * exposedSkills 是「AI 该看到什么」。两者不是同一件事，不要合并。
 */
export async function exposedSkills(project) {
  return (await listSkills(project)).filter((skill) => allows(project, skill.name))
}
