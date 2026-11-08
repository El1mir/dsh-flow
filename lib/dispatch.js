/**
 * dsh-flow · dispatch
 *
 * 派工事务（设计文档 5.13 / 15.4 TX-05、TX-13、TX-14）与巡检通知（5.14）。
 * 合并事务（TX-16）与软合并回派（TX-17）也在这里：它们都依赖 domain + runtime + git。
 *
 * runtime 需要提供：
 *   ensureSession(agent, project, { cwd }) → { ok, sessionId }
 *   promptSession(sessionId, text, mode, { origin }) → { ok, message? }
 *   clearWorkerGoal(agentId) → { ok, cleared? }（v1.39：不再建 goal，只清残留）
 *   cancelSession(sessionId) → { ok }
 *   steer(project, { agentId, message }) → { ok }
 */

import { join, dirname, basename } from 'node:path'
import { rename as fsRename, mkdir as fsMkdir } from 'node:fs/promises'
import { createAggregator } from './aggregator.js'
import { listSkills, exposedSkills, resolveSkill } from './skills.js'
import * as git from './git.js'
// v1.22：方案风险评估（自动批准分层）与远程 PR 建单都在这层用，之前漏了 import，
// 线上表现为 ReferenceError: assessPlanRisk is not defined（方案落库失败、卡被 block）。
import { assessPlanRisk, canAutoApprove } from './sync.js'
// v1.36：派工前磁盘余量门禁 + 合并后冒烟命令（受控执行）
import { checkFreeSpace, DEFAULT_MIN_FREE_BYTES } from './disk.js'
import { runCommand, postMergeCheckOf } from './exec.js'
import { createPull } from './remote.js'
// v1.39：评审轮数上限等配置要用同一套默认值
import { withDefaults } from './domain.js'
// v1.29：内置提示词（不可被项目配置覆盖，但设置页只读展示）。
import { builtinWorkerRules, builtinDispatcherRules, criticalRules, commentRules, rulesAreInSystemPrompt, SYSTEM_RULES_POINTER } from './prompts.js'

/**
 * v1.29：worktree 默认共享哪些被 .gitignore 的开发依赖目录。
 *
 * 放成常量而不是写死一处，是因为不同项目的依赖目录名不一样（backend/.venv、node_modules、
 * .venv、vendor…）。项目可以用 config.sharedDirs 覆盖这个默认值。
 */
export const DEFAULT_SHARED_DIRS = ['backend/.venv', 'BillNote_frontend/node_modules', '.venv', 'node_modules']

const comment = (domain, taskId, content) =>
  domain.comment(taskId, content, { role: 'system', id: 'system' }).catch(() => null)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function worktreePathFor(project, task) {
  const ws = project.workspacePath
  // 默认放在仓库外面：仓库里的未跟踪目录会把 git status 弄脏，挡住合并
  const root = (project.config && project.config.worktreeRoot) || join(dirname(ws), '.flow-worktrees', basename(ws))
  return join(root, String(task.id))
}

export function branchFor(task) {
  return 'flow/' + String(task.id).replace(/[^A-Za-z0-9._-]/g, '-')
}

/** prompt 覆盖统一收敛：去空白、截断，避免把空格子渲染成空段落。 */
function clampOverlay(text) {
  const s = String(text || '').trim()
  return s ? s.slice(0, 4000) : ''
}

/**
 * 给"要写进代码字面量"的路径统一成正斜杠。
 *
 * 线上踩过：工人把 `C:\Users\...\x.js` 直接粘进 TypeScript 字符串，
 * 反斜杠被当成转义序列，run_code 直接报
 * `Expected unicode escape` / `Expected ';', '}' or <eof>`。
 * 路径在这里归一，工人才不会把整条 Windows 路径当字面量抄进代码。
 */
const asPosixPath = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p)

export function buildBrief(task, project, worker, extra = {}) {
  const skills = extra.skills || []
  const contexts = extra.contexts || []
  const workspacePath = asPosixPath(project ? project.workspacePath : '-')
  const workdir = asPosixPath(extra.worktree || (project && project.workspacePath) || '-')
  // issue 卡的第一轮是「调研」，不是「实现」：工人只出方案，不改代码。
  // 这条必须在案卷最前面说清楚，否则 worker 会直接动手改仓库。
  const investigating = !!(extra.investigate || (task.plan && task.plan.revision === 0 && task.lane === 'issue'))
  const lines = [
    (investigating
      ? '【调研任务 ' + task.id + '】' + task.title
      : '【案卷 ' + task.id + '】' + task.title),
    '项目：' + (project ? project.name : '-') + ' · 工作区：' + workspacePath,
    '你的工位：' + worker.name + '（' + worker.id + '）',
    '你的工作目录：' + workdir,
    extra.branch ? '你的分支：' + extra.branch + '（只改这个目录，不要动主仓库）' : '',
    // 会话的 cwd 是项目工作区（这样会话才落在当前工作区里），
    // 但改动必须落在 worktree——不说清楚，工人会用相对路径改到主仓库。
    (!investigating && extra.worktree && workdir !== workspacePath)
      ? '注意：这个会话的当前目录是主工作区 ' + workspacePath + '，**不是**你要改的地方。所有读写与 git 命令都走绝对路径 ' + workdir + '（或先 cd 过去），用相对路径会改到主仓库、让合并直接失败。'
      : '',
    '',
    '【需求】',
    task.note || '（无详细描述，按标题与验收标准实现）',
    '',
    '【验收标准】',
    ...(task.acceptance && task.acceptance.length ? task.acceptance.map((a, i) => (i + 1) + '. ' + a) : ['1. 无（由调度员补充）']),
    '',
    '【计划 rev ' + task.plan.revision + '】',
    task.plan.text || '（计划为空）',
  ]
  if (investigating) {
    lines.push(
      '',
      '【这一轮只做调研，不要改代码】',
      '1. 先把需求读懂，找出相关文件与现有实现（用 codegraph_explore / grep / read）。',
      '2. 判断影响面：要改哪几个文件、有没有既有机制可以复用、有没有坑。',
      '3. 写一份**可执行方案**：改什么、怎么改、怎么验证、风险是什么。',
      '4. 用 flow_task_comment 把方案写进这张卡（这是人批准的依据）。',
      '5. 不要 commit、不要开 PR、不要改工作区里的任何文件——批准之后才会派你做实现。',
      '做完就正常自停；子调度会把方案整理成 plan、标成待批准，等人拍板。',
    )
  }
  if (skills.length) {
    lines.push('', '【技能（按调度员注入执行）】', ...skills.map((s, i) => (i + 1) + '. ' + s.content))
  }
  if (contexts.length) {
    lines.push('', '【上下文（调度员提供的材料）】', ...contexts.map((c) => '- ' + c.content))
  }
  // 设计文档 2.5：项目约定 + 角色约定两段追加在预设 system 之后，改了下一次投递即生效。
  const projectOverlay = clampOverlay(project && project.config && project.config.promptOverlay)
  const agentOverlay = clampOverlay(worker && worker.promptOverlay)
  if (projectOverlay) lines.push('', '【项目约定】', projectOverlay)
  if (agentOverlay) lines.push('', '【角色约定（' + worker.name + '）】', agentOverlay)
  // v1.29：改用内置提示词（lib/prompts.js）。文本从业务代码里搬走，
  // 目的是让设置页能只读展示「模型到底被告知了什么」，改一处即全线生效。
  // v1.38：规则已进系统提示词时，消息里只留一行提醒 + 本卡相关的路径约定，不再整段重复。
  const inSystem = extra.rulesInSystem !== undefined ? !!extra.rulesInSystem : rulesAreInSystemPrompt()
  if (inSystem) {
    lines.push('', SYSTEM_RULES_POINTER, '在 run_code / 字符串字面量里引用路径用正斜杠（' + workdir + '）。')
    return lines.filter((l) => l !== null && l !== undefined).join('\n')
  }
  lines.push('', builtinWorkerRules({ workdir }), '', commentRules())
  // v1.35：最高优先级段**置顶**。原来所有规则一起拼在末尾，
  // 位置越靠后越容易被当参考而不是命令；这几条违反就会让整轮作废，必须最先读到。
  return [criticalRules('worker')].concat(lines.filter((l) => l !== null && l !== undefined)).join('\n')
}

/**
 * v1.39：事件类型。所有发给调度员的工人侧通知都归到这几类，
 * 调度员看到的是"发生了什么事件"，而不是一段自由格式的巡检文本。
 */
export const EVENT_OF_KIND = {
  stop: 'worker.stopped',
  'session-stopped': 'worker.aborted',
  'session-failed': 'worker.failed',
  // v1.39.2：进程重启时被 recoverRuns 认作中断的 run —— 以前这条只写 flow.recovered 事件，
  // 调度员（一个 LLM 会话）根本收不到，于是卡悄悄回到待办，没人知道上一轮为什么没了。
  recovered: 'worker.recovered',
  'turn-silent': 'worker.turn-ended-silent',
  handoff: 'worker.handoff',
  claim: 'task.claimed',
  accept: 'task.accepted',
  review: 'pr.opened',
  'children-done': 'task.children-done',
  grill: 'grill.message',
}

/** 每类事件给调度的可选动作（只列具体工具名，不写空话）。 */
function actionsFor(eventType, task) {
  const planning = task.column === 'planning' || task.column === 'todo'
  switch (eventType) {
    case 'worker.stopped': return [
      '证据齐（停止报告逐条 acceptanceStatus + 真实测试）：推进到待验收，等人或按凭据代收。',
      '证据不全：flow_message(to="worker") 写清缺什么，或 flow_task_move(action="rework")。',
      '做不下去：flow_task_move(action="block") 并说明原因。',
    ]
    case 'worker.turn-ended-silent': return [
      '工人这一轮结束了，但没有 stop / block / flow_message。',
      '要它继续：flow_message(to="worker") 写清下一步（只说一次，然后结束本轮）。',
      '它其实做完了：让它补 stop 报告（flow_message），不要替它写。',
      '判断它卡住了：flow_task_move(action="block")。',
    ]
    case 'worker.failed': return [
      '失败预算未用尽时系统会自动退避重派，通常不需要动作。',
      '预算用尽且已阻塞：判断是环境问题还是方案问题，必要时 flow_ask_human。',
    ]
    case 'worker.aborted': return [
      '人或进程停掉了这一轮，系统不会自动重派。',
      '要继续：flow_message(to="worker")（会重新派工）；要换方案：flow_task_plan 改计划。',
    ]
    case 'worker.handoff': return [
      '这是工人的交接消息，按内容回应：flow_message(to="worker") 回复，或推进/阻塞卡片。',
    ]
    case 'task.claimed': return [
      '先调研（codegraph / 只读工具），再决定：单卡 → flow_task_plan + plan_ready；需要拆分 → flow_grill_start 走评审，或直接 flow_task_split。',
    ]
    case 'task.children-done': return [
      '子任务全部完成：核对各子卡的合并结果，推进父卡验收（等人或按凭据代收）。',
    ]
    default: return planning
      ? ['还没有计划：flow_task_plan 写方案 → flow_task_move(action="plan_ready")。', '低风险可 flow_task_move(action="approve_by_dispatcher") 代批。']
      : ['按事件内容处理；不需要动作就直接结束本轮。']
  }
}

/**
 * 调度事件信封（v1.39，替代 v1.29 的自由格式巡检包）。
 *
 * 为什么统一成信封：去掉 goal 之后，调度员不再"盯着"工人，每一轮都由一个事件叫醒。
 * 事件必须自带"发生了什么 + 证据 + 能做什么"，调度员才能一轮内做完判断就结束，
 * 而不是再去 flow_task_detail / git status 轮询。
 *
 * opts: { project, agent, kind, runId, workerName, message, rulesInSystem }
 */
export function buildInspectPacket(task, trigger, suggestion, opts = {}) {
  const report = task.stopReport || {}
  const project = opts.project || null
  const agent = opts.agent || null
  const eventType = EVENT_OF_KIND[opts.kind] || (opts.kind ? 'task.' + opts.kind : 'task.update')
  const projectOverlay = clampOverlay(project && project.config && project.config.promptOverlay)
  const agentOverlay = clampOverlay(agent && agent.promptOverlay)
  const extra = []
  const inSystem = opts.rulesInSystem !== undefined ? !!opts.rulesInSystem : rulesAreInSystemPrompt()
  if (inSystem) extra.push('', SYSTEM_RULES_POINTER)
  else extra.push('', builtinDispatcherRules(), '', commentRules())
  if (projectOverlay) extra.push('', '【项目约定】', projectOverlay)
  if (agentOverlay) extra.push('', '【角色约定（' + (agent.name || agent.id) + '）】', agentOverlay)
  const acc = Array.isArray(report.acceptanceStatus) ? report.acceptanceStatus : []
  const hasReport = !!(report.summary || report.tests || report.files || acc.length)
  const sug = suggestion || { verdict: 'keep', reasons: [] }
  return [
    ...(inSystem ? [] : [criticalRules('dispatcher'), '']),
    '【事件 ' + eventType + '】' + task.id + (opts.runId ? ' · ' + opts.runId : '') + (opts.workerName || task.assignee ? ' · 工人 ' + (opts.workerName || task.assignee) : '') + ' · 触发：' + trigger,
    '卡片：' + task.title + ' · 列 ' + task.column + ' · 阶段 ' + (task.phase || '-') + ' · 计划 rev ' + ((task.plan && task.plan.revision) || 0) + (task.parentId ? ' · 父卡 ' + task.parentId : '') + ((task.childIds || []).length ? ' · 子卡 ' + task.childIds.length : ''),
    ...(opts.message ? ['', '【消息】', String(opts.message).slice(0, 4000)] : []),
    ...(hasReport ? [
      '',
      '【停止报告】',
      'summary: ' + (report.summary || '-'),
      'tests: ' + (report.tests || '-'),
      'files: ' + (Array.isArray(report.files) ? report.files.join(', ') : report.files || '-'),
      ...(acc.length ? ['acceptance: ' + acc.map((a) => '#' + ((a.index || 0) + 1) + ' ' + a.status).join(' / ')] : []),
    ] : []),
    '',
    '【系统建议】' + sug.verdict + ' — ' + ((sug.reasons || []).join('；') || '无'),
    '',
    '【你的选择】',
    ...actionsFor(eventType, task).map((x) => '- ' + x),
    '- 处理完就结束本轮；下一件事会作为新事件叫醒你。',
    ...extra,
  ].join('\n')
}

/** 软合并包：告诉原工人怎么把 base 的新提交接进来（设计文档 14.7）。 */
export function buildConflictPacket(task, pr, conflict) {
  return [
    '【软合并请求 ' + task.id + '】合并冲突，需要你在自己的 worktree 里 rebase。',
    '分支：' + (pr.branch || '-') + ' · 冲突文件：' + ((conflict.files || []).join(', ') || '-'),
    '',
    '【怎么做】',
    '1. 在工作目录里 git fetch 后 git rebase ' + (pr.baseSha ? pr.baseSha : 'origin/HEAD') + '（或 git merge 最新 base）。',
    '2. 手工解决冲突文件：' + ((conflict.files || []).join(' / ') || '-') + '。',
    '3. 解决后 git add -A && git rebase --continue，再调 flow_pr_open 重新开 PR。',
    '4. 解决不了就 flow_task_move(action="block", reason="…") 说明卡在哪一行。',
  ].join('\n')
}

export const objectiveOf = (task) => {
  const first = (task.acceptance && task.acceptance[0]) || ''
  return [task.title, first ? '验收：' + first : ''].filter(Boolean).join(' — ').slice(0, 500)
}

export function createDispatcher({ domain, runtime, store, log = () => {} }) {
  /**
   * run 心跳：`stuckRuns()` 用 lastHeartbeat 判卡死（默认 30 分钟），
   * 而 lastHeartbeat 只在 startRun 写一次——长任务会被误判超时并强制 block。
   * 这里按 run 起一个 unref 的定时器定期续期，run 结束时清掉。
   */
  const heartbeatTimers = new Map()
  const HEARTBEAT_MS = Number(process.env.DSH_FLOW_HEARTBEAT_MS) || 60 * 1000

  function startHeartbeat(runId) {
    if (!runId || heartbeatTimers.has(runId)) return
    const timer = setInterval(() => {
      domain.heartbeat(runId).then((res) => {
        // run 已经结束（或不存在）→ 自行停表，别对着跑完的 run 一直写盘
        if (!res || res.ok === false) stopHeartbeat(runId)
      }).catch((err) => {
        log('heartbeat failed ' + runId + ': ' + ((err && err.message) || err))
        stopHeartbeat(runId)
      })
    }, HEARTBEAT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    heartbeatTimers.set(runId, timer)
  }

  function stopHeartbeat(runId) {
    const timer = heartbeatTimers.get(runId)
    if (timer) clearInterval(timer)
    heartbeatTimers.delete(runId)
  }

  function stopAllHeartbeats() {
    for (const id of [...heartbeatTimers.keys()]) stopHeartbeat(id)
  }

  /** TX-13：建（或复用）任务 worktree；git 不可用时降级到项目目录。 */
  async function ensureWorktree(task, project) {
    const existing = domain.worktreeOf(task.id)
    if (existing && existing.path) return { ok: true, path: existing.path, branch: existing.branch, reused: true, baseSha: existing.baseSha }
    const repo = project && project.workspacePath
    if (!repo) return { ok: false, degraded: true, path: null, message: '项目没有工作区路径' }
    if (!(await git.isRepo(repo))) {
      return { ok: false, degraded: true, path: repo, message: '工作区不是 git 仓库，改动直接落在工作区' }
    }
    // v1.36：建 worktree 之前先看盘（ework 的 ENOSPC 事故闸门）。
    // 盘满时工人表现得像「莫名其妙失败」，原因藏在会话里；这里提前拦住并写清原因。
    const disk = await checkFreeSpace(repo, (project.config && project.config.minFreeBytes) || DEFAULT_MIN_FREE_BYTES)
    if (!disk.ok) {
      await comment(domain, task.id, disk.reason + '。清理后重新派工。')
      await domain.block(task.id, disk.reason, { role: 'system' })
      return { ok: false, degraded: true, path: repo, message: disk.reason, disk }
    }
    const dir = worktreePathFor(project, task)
    const branch = branchFor(task)
    const base = (project.config && project.config.baseBranch) || (await git.defaultBranch(repo))
    const made = await git.addWorktree({ repo, dir, branch, base })
    if (!made.ok) {
      // no-commits 不是"这个项目不支持 git"，而是"这个仓库还一次提交都没有"：
      // worktree 共享对象库，没有基线就没有可检出的内容，git 只会回一句
      // fatal: invalid reference: HEAD，看不出真正原因。说清楚，并且不要把它
      // 当成永久结论——补了基线提交之后，下次派工要能自动恢复 worktree。
      const why = made.reason === 'no-commits'
        ? (made.message + '。' + (made.hint || ''))
        : (made.reason || 'worktree 失败')
      await comment(domain, task.id, '建 worktree 失败，这一轮先直接在工作区动手：' + why)
      return {
        ok: false,
        degraded: true,
        noCommits: made.reason === 'no-commits',
        path: repo,
        message: why,
        hint: made.hint || '',
      }
    }
    // v1.29：把被 .gitignore 的开发依赖（.venv / node_modules）链进 worktree。
    // 不链的话每个 worktree 都是裸 checkout，worker 就得重装一遍 2.7GB 环境，
    // 装不动就报「环境里没有 pytest」—— 线上真实踩过。
    // 链接失败不阻断派工（降级为 worker 自己装），只是记一行说明。
    const sharedDirs = (project.config && Array.isArray(project.config.sharedDirs) && project.config.sharedDirs.length)
      ? project.config.sharedDirs
      : DEFAULT_SHARED_DIRS
    const linked = await git.linkSharedDirs({ repo, worktree: made.path, dirs: sharedDirs }).catch(() => null)
    await domain.recordWorktree(task.id, { path: made.path, branch: made.branch, baseSha: made.headSha || null, sharedDirs: linked && linked.linked ? linked.linked : [] })
    const linkNote = linked && linked.linked.length ? '；已共享依赖目录 ' + linked.linked.join('、') : ''
    await comment(domain, task.id, '已建 worktree ' + made.path + '（分支 ' + made.branch + '，base ' + (made.base || base) + '）' + linkNote)
    if (linked && linked.failed.length) {
      await comment(domain, task.id, '（注意：依赖目录链接失败 ' + linked.failed.map((x) => x.dir).join('、') + '，这一轮你得自己准备环境）')
    }
    return { ok: true, path: made.path, branch: made.branch, baseSha: made.headSha || null }
  }

  /**
   * v1.39：子卡进终态后汇总父卡。
   * 全部子卡 done/cancelled → 父卡推进到待验收（父卡自己不合并，noMerge），
   * 并发 task.children-done 事件叫醒调度来核对证据。
   */
  async function rollupParent(child) {
    if (!child || !child.parentId) return { ok: false, skipped: 'no-parent' }
    const parent = store.state.tasks[child.parentId]
    if (!parent) return { ok: false, skipped: 'no-parent' }
    const kids = (parent.childIds || []).map((id) => store.state.tasks[id]).filter(Boolean)
    const open = kids.filter((k) => !['done', 'cancelled'].includes(k.column))
    if (open.length) return { ok: true, waiting: open.length, total: kids.length }
    if (['verifying', 'merging', 'done'].includes(parent.column)) return { ok: true, already: true }
    await domain.setNoMerge(parent.id, true, '父卡只做汇总，代码在子卡里合并', { role: 'system' }).catch(() => null)
    // 走专门的迁移（不是直接改 column）：状态机要有历史，别人也能看懂这是"汇总"
    const moved = await domain.move(parent.id, 'children_done', { role: 'system', id: 'system:rollup' }, {})
      .catch((err) => ({ error: err }))
    if (moved && moved.error) return { ok: false, message: String(moved.error.message || moved.error) }
    await comment(domain, parent.id, '子卡全部完成（' + kids.map((k) => k.id).join('、') + '），父卡已进待验收：核对各子卡的合并结果后收口。')
    await notifyDispatcher(store.state.tasks[parent.id] || parent, '子任务全部完成', 'children-done', {})
    return { ok: true, rolledUp: true, total: kids.length }
  }

  /**
   * v1.39：需求评审（grill）会话 —— 把调度的草稿发给"需求评审"工位，让它逐轮挑毛病。
   *
   * 消息驱动的核心示例：投出去就结束本轮，评审的回信（flow_message）会作为
   * grill.message 事件把调度叫醒。轮数越多越贵，所以有 grillMaxRounds 上限。
   */
  async function deliverInjection(task, { kind = 'context', content = '', skillName, agentId, to = 'worker' } = {}) {
    if (!task) return { ok: false, message: 'unknown task' }
    if (domain.halted()) return { ok: false, message: '调度已被手动停止' }
    const project = store.state.projects[task.projectId]
    if (!project) return { ok: false, message: '项目不存在' }
    if (!['skill', 'context', 'steer'].includes(kind)) return { ok: false, message: 'Unknown injection kind: ' + kind }
    if (!['worker', 'grill', 'griller'].includes(to)) return { ok: false, message: '未知收件人：' + to }
    let text = String(content || '')
    if (skillName !== undefined && skillName !== null) {
      const skill = await resolveSkill(project, skillName)
      if (!skill.ok) return skill
      kind = 'skill'
      text = '<skill_content name="' + skillName + '">\nSkill resource directory: ' + dirname(skill.path) + '\n\n' + skill.content + '\n</skill_content>' + (text ? '\n\n' + text : '')
    }
    if (!text.trim()) return { ok: false, message: 'content 不能为空' }
    const cur = store.state.tasks[task.id] || task
    const reviewing = to === 'grill' || to === 'griller'
    const recipient = agentId ? store.state.agents[agentId] : reviewing
      ? Object.values(store.state.agents).find((a) => a && a.projectId === task.projectId && a.role === 'griller' && a.enabled !== false)
      : store.state.agents[cur.assignee]
    if ((agentId || recipient) && (!recipient || recipient.projectId !== task.projectId || recipient.enabled === false || recipient.role !== (reviewing ? 'griller' : 'worker') || (!reviewing && (recipient.lane || 'human') !== (task.lane || 'human')))) return { ok: false, message: 'Invalid recipient agent' }
    if (reviewing && !recipient) return { ok: false, message: '这个项目没有需求评审工位' }
    const maxRounds = Number(project.config?.grillMaxRounds) > 0 ? Number(project.config.grillMaxRounds) : 4
    const reviewState = cur.grill || { rounds: 0 }
    if (reviewing && (reviewState.rounds || 0) >= maxRounds) return { ok: false, message: '评审已达轮数上限 ' + maxRounds + '，请直接给结论（flow_grill_verdict）' }
    const stored = await domain.inject(task.id, { kind, content: text, ...(skillName != null ? { skillName } : {}), agentId: recipient?.id || null }, { role: 'dispatcher', id: 'system' })
    if (stored?.ok === false) return stored
    if (!reviewing && !cur.activeRunId) return { ok: true, stored: true, injection: stored, injectionId: stored?.id, message: '已保存，下一轮案卷送达' }
    if (!recipient) return { ok: false, message: '没有收件工人' }
    const deliveryText = '【任务注入 ' + task.id + '】' + (task.title || '') + '\n\n' + text
    let sent
    let sessionId
    if (reviewing) {
      const ens = await runtime.ensureSession(recipient, project, { cwd: project.workspacePath })
      if (!ens.ok) return ens
      sessionId = ens.sessionId
      sent = await runtime.promptSession(sessionId, deliveryText, 'steer', { origin: 'system' })
    } else sent = await runtime.steer(project, { agentId: recipient.id, message: deliveryText })
    domain.logMessage({ sessionId: sessionId || null, agentId: recipient.id, direction: 'out', origin: 'system', kind: 'injection', ok: !!sent.ok, taskId: task.id })
    if (reviewing && sent.ok) {
      await domain.setGrill(task.id, { ...reviewState, status: 'running', rounds: (reviewState.rounds || 0) + 1, maxRounds, verdict: null, openForHuman: [], startedAt: reviewState.startedAt || new Date().toISOString() })
      await domain.noteEvent(task.id, 'grill.message', { round: (reviewState.rounds || 0) + 1, grillerId: recipient.id }).catch(() => null)
    }
    return { ...sent, stored: true, injection: stored, injectionId: stored?.id, sessionId, agentId: recipient.id, message: sent.message || (sent.ok ? '已投递给收件人' : '投递失败') }
  }

  async function grillStart(task, { draft, reason = '' } = {}) {
    if (!task) return { ok: false, message: 'unknown task' }
    if (domain.halted()) return { ok: false, skipped: 'halted', message: '调度已被手动停止' }
    const project = store.state.projects[task.projectId]
    if (!project) return { ok: false, message: '项目不存在' }
    const cur = store.state.tasks[task.id] || task
    if (!String(draft || '').trim()) return { ok: false, message: 'draft（八问草稿 + 拆分草稿）不能为空' }
    const griller = Object.values(store.state.agents)
      .find((a) => a && a.projectId === task.projectId && a.role === 'griller' && a.enabled !== false)
    if (!griller) return { ok: false, message: '这个项目没有需求评审工位：先 flow_config 或 project.init 补齐' }
    const cfg = withDefaults(project.config)
    const maxRounds = Number(cfg.grillMaxRounds) > 0 ? Number(cfg.grillMaxRounds) : 4
    const state = cur.grill || { status: 'idle', rounds: 0, maxRounds, verdict: null, openForHuman: [], startedAt: null }
    if (state.status === 'running') return { ok: false, message: '这张卡的评审正在进行中（第 ' + state.rounds + ' 轮）：等结论，不要重复开' }
    if (state.rounds >= maxRounds) return { ok: false, message: '评审已达轮数上限 ' + maxRounds + '，请直接给结论（flow_grill_verdict）' }
    const text = [
      '【需求评审 ' + task.id + '】第 ' + (state.rounds + 1) + '/' + maxRounds + ' 轮',
      '任务：' + task.title,
      reason ? '为什么需要评审：' + reason : '',
      '',
      '【调度交来的草稿】',
      String(draft).slice(0, 8000),
      '',
      '按你的角色规则：这一轮把当前能问的问题都问完（每个问题给推荐答案），',
      '用 flow_message(taskId="' + task.id + '", to="dispatcher", kind="question") 发回，然后结束本轮。',
      '没有可问的就直接 flow_grill_verdict 给结论。',
    ].filter(Boolean).join('\n')
    const sent = await deliverInjection(task, { to: 'grill', kind: 'skill', skillName: cfg.grillSkill || 'grilling', content: text, agentId: griller.id })
    if (!sent.ok) return { ok: false, message: '投递失败：' + (sent.message || '') }
    await domain.noteEvent(task.id, 'grill.started', { round: (state.rounds || 0) + 1, grillerId: griller.id }).catch(() => null)
    return { ok: true, round: (state.rounds || 0) + 1, maxRounds, sessionId: sent.sessionId, grillerId: griller.id }
  }

  /** v1.39：评审结论落库。settled → 调度可以直接拆；escalate → 调度走 flow_ask_human。 */
  async function grillVerdict(task, { verdict, settled = [], openForHuman = [], note = '' } = {}) {
    if (!task) return { ok: false, message: 'unknown task' }
    const cur = store.state.tasks[task.id] || task
    if (!['settled', 'escalate'].includes(verdict)) return { ok: false, message: 'verdict 只能是 settled / escalate' }
    const state = cur.grill || { status: 'idle', rounds: 0, maxRounds: 4, verdict: null, openForHuman: [], startedAt: null }
    const open = (Array.isArray(openForHuman) ? openForHuman : []).slice(0, 8).map((x) => ({
      question: String((x && x.question) || '').slice(0, 300),
      why: String((x && x.why) || '').slice(0, 400),
      recommendation: String((x && x.recommendation) || '').slice(0, 300),
    })).filter((x) => x.question)
    if (verdict === 'escalate' && !open.length) return { ok: false, message: 'escalate 必须写出 openForHuman（至少 1 项：要人定什么）' }
    await domain.setGrill(task.id, {
      status: verdict, rounds: state.rounds || 0, maxRounds: state.maxRounds || 4,
      verdict, openForHuman: open, settled: (Array.isArray(settled) ? settled : []).slice(0, 20).map((x) => String(x).slice(0, 300)),
      verdictNote: String(note || '').slice(0, 1000), startedAt: state.startedAt || null,
    })
    await domain.noteEvent(task.id, 'grill.verdict', { verdict, openForHuman: open.length }).catch(() => null)
    if (verdict === 'settled') await comment(domain, task.id, '需求评审结束（' + (state.rounds || 0) + ' 轮）：没有剩余问题，可以按拆分表开工。')
    else await comment(domain, task.id, '需求评审结束：有 ' + open.length + ' 项需要人决定（已列出），其余已确定。')
    const notified = await notifyDispatcher(store.state.tasks[task.id] || task, '需求评审结论', 'handoff', { message: JSON.stringify({ verdict, settled, openForHuman: open, note }), dedupeSuffix: 'grill-verdict:' + (state.rounds || 0) + ':' + verdict })
    return { ok: true, verdict, openForHuman: open.length, rounds: state.rounds || 0, notified: !!notified?.ok }
  }

  /** v1.39：子卡依赖是否都完成了（dependsOn 里的卡必须进 done）。 */
  function pendingDeps(task) {
    const deps = Array.isArray(task && task.dependsOn) ? task.dependsOn : []
    return deps.filter((id) => {
      const t = store.state.tasks[id]
      return !t || t.column !== 'done'
    })
  }

  /** TX-05：选工位 → 建 worktree → 保会话 → 开 run/占租约 → 清残留 goal → 投案卷。v1.39 起不再建 goal：工人做完一件事就发消息并停下。 */
  async function dispatch(task) {
    if (!task) return { ok: false, message: 'unknown task' }
    // 一键停止期间绝不派工：tick 也挡了一层，但 dispatch 还有工具/事件等旁路入口
    // （flow_task_move 推进、agent 手动派工），这里是最后一道闸。
    if (domain.halted()) return { ok: false, skipped: 'halted', message: '调度已被手动停止，恢复后再派工' }
    const project = store.state.projects[task.projectId]
    if (!project) return { ok: false, message: '项目不存在' }
    if (task.activeRunId) return { ok: false, message: '任务已有在跑的 run：' + task.activeRunId }
    // v1.39：父卡只做汇总，永不派工（代码都在子卡里）
    if ((task.childIds || []).length) {
      await domain.setTaskPhase(task.id, 'split').catch(() => null)
      return { ok: false, message: '这张卡已拆成 ' + task.childIds.length + ' 个子任务，本身不派工' }
    }
    // v1.39：依赖没完成就不派（先做完前置，避免两个工人改同一片代码）
    const waiting = pendingDeps(task)
    if (waiting.length) {
      await domain.setTaskPhase(task.id, 'waiting-deps').catch(() => null)
      return { ok: false, message: '等待前置子卡完成：' + waiting.join('、'), waiting: true }
    }

    // v1.0：按车道 + 同域打分选人（issue 任务不会落到 human 工人）
    const picked = domain.pickWorkerScored(task.projectId, { task, streakInfo: domain.streakOf(), siblingOf: task.parentId || null })
    const worker = picked && picked.agent
    if (!worker) {
      await domain.setTaskPhase(task.id, 'waiting-worker')
      // v1.36：因为模型冷却才没有工位时，说清楚（否则人只会看到「没有空闲工人」去查工位）
      const cooling = domain._coolingBlocked
      const why = cooling && cooling.length
        ? '工位都在模型冷却期（' + cooling.join('、') + '），冷却结束后自动重派'
        : '没有空闲工人（车道 ' + (task.lane || 'human') + '）'
      await comment(domain, task.id, why + '，任务保持执行中等待工位')
      return { ok: false, message: cooling && cooling.length ? '模型冷却中' : '没有空闲工人', waiting: true }
    }
    if (picked) domain.noteWorkerPick(worker.id)

    // 调研轮不需要独立 worktree：工人只读不写，用项目目录就行，
    // 免得为一次只读调研建分支/开目录（做完了还要清）。
    const investigating = task.lane === 'issue' && (task.phase === 'investigating' || !task.plan || task.plan.revision === 0)
    const wt = investigating
      ? { ok: true, path: project && project.workspacePath, branch: null, reused: true }
      : await ensureWorktree(task, project)
    const cwd = wt.ok ? wt.path : (wt.path || (project && project.workspacePath))
    // 没有 worktree 就没有分支可合 —— 记下来，验收后直接进 done，别塞进合并列。
    // 但这是"这一轮的状态"而不是"这张卡的永久属性"：仓库补上基线提交、或者
    // 项目以后接上了 git，下次派工就该重新拿到 worktree 与合并流程。
    if (!wt.ok || !wt.branch) {
      await domain.setNoMerge(task.id, true, wt.message || '非 Git 工作区，不需要合并', { role: 'system' }).catch(() => null)
    } else if (task.noMerge) {
      await domain.setNoMerge(task.id, false, '这一轮拿到了 worktree，合并流程恢复', { role: 'system' }).catch(() => null)
      await comment(domain, task.id, 'worktree 已恢复，合并流程回到正常路径').catch(() => null)
    }

    // 会话的 cwd 固定落在**项目工作区**，而不是 worktree。
    //
    // 为什么：DSH 按 cwd 把会话归到工作区（workspace 的 sessionIds 只认
    // sessionPath(id) === record.path），cwd 在 .flow-worktrees/<repo>/<task>
    // 里的会话会各自变成一个独立工作区——用户在当前工作区里就看不到工人会话了
    // （而且每个任务换一次 cwd 就 resetSession 一次，会话身份也留不住）。
    // 隔离靠的是 worktree 本身 + 案卷里的「你的工作目录」，不靠会话 cwd。
    const sessionCwd = (project && project.workspacePath) || cwd
    const ens = await runtime.ensureSession(worker, project, { cwd: sessionCwd })
    if (!ens.ok) {
      // 会话不可用是环境的错，不是这张卡的错 → 走 infra 预算（3 次退避），不直接 block
      const res = await domain.recordFailure(task.id, { kind: 'infra', reason: '工人会话不可用：' + ens.message })
      // v1.36：会话不可用大概率是这个模型/配额的问题 —— 冷却它，别让下一个工位再撞一次
      await domain.coolModel(domain.modelKeyOf(worker), Math.max(5 * 60000, res.backoffMs * 2), '会话不可用：' + String(ens.message || '').slice(0, 120)).catch(() => null)
      if (res.retry) {
        await comment(domain, task.id, '工人会话不可用（' + ens.message + '），' + Math.round(res.backoffMs / 1000) + ' 秒后重试（第 ' + res.tries + '/' + res.max + ' 次）')
      } else {
        await domain.block(task.id, '工人会话不可用：' + ens.message, { role: 'system' })
      }
      return ens
    }

    let started
    try {
      started = await domain.startRun(task.id, { agentId: worker.id, sessionId: ens.sessionId, trigger: investigating ? 'investigate' : 'approve' })
    } catch (err) {
      // v1.35：并发/重试派工撞上已在跑的 run —— 这是幂等命中，不是失败。
      if (err && err.code === 'DUPLICATE_RUN') return { ok: true, duplicate: true, runId: err.runId, message: '已有在跑的 run（' + err.runId + '），不重复派工' }
      throw err
    }
    const { run } = started
    startHeartbeat(run.id)
    // 打分明细落库：事后能解释「为什么是这个工人」
    await domain.setDispatchReason(task.id, {
      workerId: worker.id,
      lane: picked ? picked.lane : (worker.lane || 'human'),
      cost: picked ? Number(picked.cost.toFixed(4)) : null,
      overlap: picked ? Number(picked.overlap.toFixed(4)) : null,
      rotation: picked ? picked.rotation : null,
      budgetRatio: 0,  // v1.37：不再追踪水位
      at: new Date().toISOString(),
    }, { role: 'system' })
    // v1.39：不建 goal。旧会话上可能还挂着 v1.38 以前建的 goal，不清掉它会继续自己续跑。
    const goal = typeof runtime.clearWorkerGoal === 'function'
      ? await runtime.clearWorkerGoal(worker.id).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
      : { ok: true, skipped: true }

    const brief = buildBrief(store.state.tasks[task.id], project, worker, {
      worktree: cwd,
      branch: wt.ok ? wt.branch : null,
      investigate: investigating,
      skills: domain.injectionsFor(task.id, { kind: 'skill' }).filter((i) => !i.agentId || i.agentId === worker.id),
      contexts: domain.injectionsFor(task.id, { kind: 'context' }).filter((i) => !i.agentId || i.agentId === worker.id),
    })

    // 案卷投递幂等键（设计文档 §3.1：brief:<taskId>:<runId>）：同一条 run 的案卷只投一次
    const briefKey = 'brief:' + task.id + ':' + run.id
    if (domain.hasLogged(briefKey)) return { ok: true, duplicate: true, agentId: worker.id, sessionId: ens.sessionId, runId: run.id, message: '案卷已投递过' }
    let sent = await runtime.promptSession(ens.sessionId, brief, 'queue', { origin: 'system' })
    for (let attempt = 0; !sent.ok && attempt < 2; attempt += 1) {
      await sleep(400 * (attempt + 1))
      sent = await runtime.promptSession(ens.sessionId, brief, 'queue', { origin: 'system' })
    }
    domain.logMessage({ sessionId: ens.sessionId, agentId: worker.id, direction: 'out', origin: 'system', kind: 'brief', ok: !!sent.ok, taskId: task.id, dedupeKey: briefKey })
    if (!sent.ok) {
      // 遗留会话用的是已下线的 agent preset（例如 `@dsh-external/dsh-preset-router-standard` 被关掉），
      // resume 会失败、任务被永久阻塞。这里自愈一次：丢掉旧会话、建一个不带 preset 的新会话再投。
      if (/Unknown agent preset|agent preset/i.test(String(sent.message || '')) && runtime.resetSession) {
        const reset = await runtime.resetSession(project, worker.id)
        if (reset && reset.ok) {
          const retry = await runtime.promptSession(reset.sessionId, brief, 'queue', { origin: 'system' })
          domain.logMessage({ sessionId: reset.sessionId, agentId: worker.id, direction: 'out', origin: 'system', kind: 'brief', ok: !!retry.ok, taskId: task.id })
          if (retry.ok) {
            await domain.updateRun(run.id, { sessionId: reset.sessionId })
            await domain.setSessionState(worker.id, 'active', { role: 'system' })
            await comment(domain, task.id, '工位会话因旧 preset 失效已重建（' + reset.sessionId + '），已重新投递')
            return { ok: true, agentId: worker.id, sessionId: reset.sessionId, runId: run.id, goal, worktree: cwd, degraded: !wt.ok, healed: true }
          }
          sent = retry
        }
      }
      await domain.endRun(task.id, 'failed', { stopReason: sent.message, runId: run.id })
      stopHeartbeat(run.id)
      // 投递失败同样是环境的错（会话挂了/配额打满/网络），走 infra 预算
      const fail = await domain.recordFailure(task.id, { kind: 'infra', reason: '派工失败：' + sent.message })
      await domain.coolModel(domain.modelKeyOf(worker), Math.max(5 * 60000, fail.backoffMs * 2), '派工失败：' + String(sent.message || '').slice(0, 120)).catch(() => null)
      if (fail.retry) {
        await comment(domain, task.id, '派工失败（' + sent.message + '），' + Math.round(fail.backoffMs / 1000) + ' 秒后重试（第 ' + fail.tries + '/' + fail.max + ' 次）')
      } else {
        await domain.block(task.id, '派工失败：' + sent.message, { role: 'system' })
      }
      return sent
    }
    await domain.setSessionState(worker.id, 'active', { role: 'system' })
    await comment(domain, task.id, '已派工给 ' + worker.name + '（会话 ' + ens.sessionId + '，run ' + run.id + '，目录 ' + cwd + '）')
    log('dispatched ' + task.id + ' → ' + worker.id + ' @ ' + ens.sessionId + ' (' + cwd + ')')
    return { ok: true, agentId: worker.id, sessionId: ens.sessionId, runId: run.id, goal, worktree: cwd, degraded: !wt.ok }
  }

  /** 工人自停：收 run → 工位释放 → 通知调度员巡检。 */
  async function afterStop(task) {
    const report = task.stopReport || {}
    const run = await domain.endRun(task.id, 'stopped', { stopReason: report.summary || '', runId: task.activeRunId || null })
    if (run && run.id) stopHeartbeat(run.id)
    const workerId = (run && run.agentId) || task.assignee
    if (workerId) await domain.setSessionState(workerId, 'idle', { role: 'system' }).catch(() => {})

    // issue 卡的调研轮结束 → 把工人写的方案整理成 plan，进"待批准"。
    // 这一步之后卡就停在 waiting-approval，**人（或主调度）点头才会真的开工**。
    // 调研轮 = issue 卡、还没批准过方案（phase=investigating 或 plan 还没成型）
    const wasInvestigating = task.lane === 'issue' && (task.phase === 'investigating' || !task.plan || task.plan.revision === 0)
    let awaiting = null
    if (wasInvestigating) awaiting = await awaitingApproval(task, report)

    // 工人真的干完了一轮：失败预算归零（预算的语义是"连续失败"）
    await domain.resetFailureBudget(task.id).catch(() => null)
    await domain.resetStuck(task.id).catch(() => null)

    // v1.36：巡检信号（§4.7）。判完再通知 —— 升级结论要出现在巡检包里。
    const escalated = await escalateBySignals(task, report, workerId).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
    // v1.39.1：endRun 之后 activeRunId 已清空，必须显式带 runId ——
    // 否则同一张卡第二次自停会被第一次的去重键（evt:<task>:-:worker.stopped）静默吞掉。
    const notified = await notifyDispatcher(store.state.tasks[task.id] || task, '工人自停', 'stop', { runId: (run && run.id) || null })
    return { run, notified, awaiting, signals: escalated }
  }

  /**
   * 巡检信号的事实采集与升级（v1.36）。
   *
   * 事实只取「能重复验证」的：有没有产出改动（git）、错误码（停止报告里工人自己写的）、
   * 上下文水位（会话预算）。判据在 lib/inspect-signals.js，这里只做采集 + 执行建议。
   */
  async function inspectionFacts(task, report, workerId) {
    const facts = {
      hasDiff: null,
      code: report.errorCode || report.code || null,
      needsConfirm: /需要确认|需要澄清|need.{0,6}confirm|blocked.*确认/i.test(String(report.blocked || '') + ' ' + String(report.summary || '')),
      testsFailed: /失败|failed|FAIL|❌/i.test(String(report.tests || '')),
    }
    const project = store.state.projects[task.projectId]
    const repo = project && project.workspacePath
    const wt = domain.worktreeOf(task.id)
    if (wt && wt.path && repo && await git.isRepo(repo).catch(() => false)) {
      const from = wt.baseSha || null
      const changed = from ? await git.changedFiles(repo, from, wt.branch || 'HEAD').catch(() => null) : null
      const dirty = await git.dirtyFiles(wt.path).catch(() => null)
      if (changed || dirty) facts.hasDiff = (changed && changed.files ? changed.files.length : 0) + (dirty ? dirty.length : 0) > 0
    }
    // v1.37：budgetRatio 和 compactBlocked 已移除
    return facts
  }

  /** 把信号建议执行掉：steer = 下一轮案卷里带上提示；pause/block = 停下来叫人。 */
  async function escalateBySignals(task, report, workerId) {
    const facts = await inspectionFacts(task, report, workerId)
    const analysis = await domain.noteInspectionCycle(task.id, facts)
    const why = (analysis.reasons || []).join('；')
    if (analysis.verdict === 'steer') {
      // 不打断、不阻塞：把提示塞进注入表，下一轮案卷自动带上（dispatch 会读 injectionsFor）
      await domain.inject(task.id, { kind: 'context', content: '【巡检提示】' + why + '。下一轮请先确认上一步产出了什么，没有改动就别重复同一做法。' }, { role: 'system', id: 'system:inspect' }).catch(() => null)
      await comment(domain, task.id, '巡检信号：' + analysis.signals.join('/') + '（' + why + '），已在下一轮案卷里加提示')
      return { ok: true, verdict: analysis.verdict, signals: analysis.signals }
    }
    if (analysis.verdict === 'pause' || analysis.verdict === 'block') {
      // 暂停 = 取消工人会话当前回合（v1.39 不再有 goal 可暂停），再阻塞卡片等人
      if (analysis.verdict === 'pause' && workerId && typeof runtime.cancelSession === 'function') {
        const rec = domain.latestSession(workerId)
        if (rec && rec.sessionId) await runtime.cancelSession(rec.sessionId).catch(() => null)
      }
      await domain.block(task.id, '巡检信号升级（' + analysis.signals.join('/') + '）：' + why, { role: 'system', id: 'system:inspect' }).catch(() => null)
      await comment(domain, task.id, '巡检信号升级：' + analysis.signals.join('/') + '（' + why + '），已阻塞等调度处理')
      await domain.askHuman({
        taskId: task.id,
        kind: 'decision',
        topic: '巡检信号要求介入：' + task.id + ' ' + String(task.title || '').slice(0, 50),
        problem: '系统在最近几轮里判出：' + why,
        decisionNeeded: analysis.verdict === 'pause' ? '这张卡要不要暂停（换会话/换人），还是补充信息后继续？' : '这张卡怎么处理：补信息继续、换人，还是取消？',
        where: task.id + ' · ' + task.column + '/' + (task.phase || '-') + ' · 信号 ' + analysis.signals.join('/'),
        suggestion: '先看 flow_task_detail 里的停止报告与 run 记录，再决定；不确定就让它再跑一轮并注入提示。',
      }, { role: 'system', id: 'system:inspect' }).catch(() => null)
      return { ok: true, verdict: analysis.verdict, signals: analysis.signals }
    }
    return { ok: true, verdict: 'keep', signals: analysis.signals }
  }

  /**
   * 调研轮收尾：工人交的方案（评论）→ task.plan → plan_ready（waiting-approval）。
   *
   * 全自动链路的最后一米必须停在"人点头"：方案写不出来就 block 并说明，
   * 绝不带着空方案进批准（那等于让人批一个空计划）。
   */
  async function awaitingApproval(task, report) {
    const comments = domain.taskDetail(task.id).comments || []
    const planText = pickPlanText(comments, report)
    if (!planText) {
      // 内容失败：工人这一轮没交出方案。给 1 次重派（内容预算），第二次仍无方案才阻塞等人。
      const fail = await domain.recordFailure(task.id, { kind: 'content', reason: '调研轮没有产出可用方案' })
      if (fail.retry) {
        await comment(domain, task.id, '调研轮没有写出可用方案，重新派一轮（内容重试 ' + fail.tries + '/' + fail.max + '）')
        await domain.setTaskPhase(task.id, 'investigating', { role: 'system', id: 'investigate' }).catch(() => null)
        return { ok: false, reason: 'no-plan-retry' }
      }
      await domain.block(task.id, '调研轮结束但没有写出方案：评论里没有可用的调研结论，需要重新派调研或人工补方案', { role: 'system' })
      return { ok: false, reason: 'no-plan' }
    }
    await comment(domain, task.id, '【调研完成】方案已整理进 plan（rev 加一），等你批准后才开工。批准用看板，或让主调度 flow_task_move(approve)。')
    try {
      await domain.setPlan(task.id, planText, { role: 'system', id: 'investigate' })
      await domain.move(task.id, 'submit_plan', { role: 'system', id: 'investigate' })
      const risk = await assessAndMaybeAutoApprove(task.id)
      return { ok: true, planRev: store.state.tasks[task.id].plan.revision, risk }
    } catch (err) {
      await domain.block(task.id, '调研方案落库失败：' + String((err && err.message) || err), { role: 'system' })
      return { ok: false, reason: String((err && err.message) || err) }
    }
  }

  /**
   * 从评论里挑最像"方案"的那条：优先带标题/列表的长评论，其次最后一条 worker 评论。
   *
   * v1.25：不再在这里 slice(0, 8000)。原来这一刀会把工人写的逐项方案砍掉后半段，
   * 而 plan 是人批准的唯一依据 —— 批准者读不到全文就只能打回重写。
   * 上限交给 setPlan 的 COMMENT_MAX 统一管，这里原样传过去。
   */
  function pickPlanText(comments, report) {
    const workerComments = comments.filter((c) => c && c.role === 'worker' && String(c.content || '').trim().length >= 40)
    if (workerComments.length) return String(workerComments[workerComments.length - 1].content)
    const summary = String((report && report.summary) || '').trim()
    if (summary.length >= 40) return summary
    const anyLong = comments.filter((c) => c && String(c.content || '').trim().length >= 40)
    if (anyLong.length) return String(anyLong[anyLong.length - 1].content)
    return ''
  }

  /**
   * 方案风险评估 + 自动批准分层（v1.22，用户要求 ①）。
   *
   * 三段，顺序不能反：
   *   1. 确定性预筛 `assessPlanRisk`：命中硬规则（改 schema / 新增依赖 / 动核心文件）就判 high，
   *      直接阻塞等人拍板 —— 这一步零模型成本，也不能被"调度觉得没问题"覆盖；
   *   2. 有风险但不致命（medium）→ 通知调度员看一眼，卡继续停在 waiting-approval；
   *   3. 低风险 + 项目开了 autoApproveIssue → 由**主调度身份**代批（approve_by_chief），
   *      批准者记 `auto:risk-low`，看板上能查出这是机器批的。
   *
   * 为什么只批方案不批验收（accept 仍是 human only）：方案批错了只是重写方案，
   * 验收批错了要回滚代码。
   */
  async function assessAndMaybeAutoApprove(taskId) {
    const task = store.state.tasks[taskId]
    if (!task) return null
    const project = store.state.projects[task.projectId]
    const risk = assessPlanRisk((task.plan && task.plan.text) || '', task, project)
    await domain.setTaskRisk(taskId, risk, { role: 'system', id: 'risk' })

    if (risk.level === 'high') {
      await comment(domain, taskId, '【方案风险：高】' + (risk.reasons.join('；') || '命中高风险规则') + '\n\n这一类改动会动到项目结构或外部依赖，必须人拍板。看板上批准或驳回。')
      await domain.block(taskId, '方案命中高风险规则，等人工审批（' + (risk.reasons[0] || 'high') + '）', { role: 'system', id: 'risk' })
      return risk
    }
    if (risk.level === 'medium') {
      await comment(domain, taskId, '【方案风险：中】' + (risk.reasons.join('；') || '有需要人看一眼的地方') + '\n\n方案已就绪，等整条链路上的人或调度员确认。')
      return risk
    }

    const gate = canAutoApprove({ ...task, risk }, project)
    if (!gate.ok) {
      await comment(domain, taskId, '【方案风险：低】' + (risk.reasons.join('；') || '没有命中风险规则') + '\n\n等待批准（自动批准未开启：' + gate.reason + '）。')
      return risk
    }
    try {
      await domain.move(taskId, 'approve_by_chief', { role: 'chief', id: 'auto:risk-low' })
      await comment(domain, taskId, '【自动批准】方案风险判为 low（' + (risk.reasons.join('；') || '未命中风险规则') + '），主调度以 auto:risk-low 身份代批，直接开工。若你不同意，撤回请点驳回。')
      const fresh = store.state.tasks[taskId]
      if (fresh && fresh.column === 'running') await dispatch(fresh)
    } catch (err) {
      await comment(domain, taskId, '自动批准失败，回退到人工：' + String((err && err.message) || err))
    }
    return risk
  }

  /** T18：取消是终态 —— 收 run、放租约、工位回空闲、worktree 尽力回收（会话保留可查）。 */
  async function afterCancel(task) {
    const had = task.activeRunId
    const run = had ? await domain.endRun(task.id, 'cancelled', { stopReason: '任务被取消', runId: task.activeRunId || null }, { role: 'human', id: 'cancel' }) : null
    if (run && run.id) stopHeartbeat(run.id)
    const workerId = (run && run.agentId) || task.assignee
    if (workerId) await domain.setSessionState(workerId, 'idle', { role: 'system' }).catch(() => {})
    try {
      await removeWorktree(task)
    } catch (err) {
      await comment(domain, task.id, 'worktree 回收失败（不影响取消）：' + String(err && err.message ? err.message : err))
    }
    await comment(domain, task.id, '已取消：' + (had ? '结束 run 并释放租约' : '本来没有活跃 run') + '，工位回到空闲，会话保留可回看')
    return { ok: true, run }
  }

  /**
   * 调度员的"看管范围"：哪些事件值得插话、多急、怎么说。
   *
   * 判断标准只有一条——**它是否需要调度员做一个决定**。常规流转（工人认领、写计划、
   * 审批通过）不需要：那是系统按规则走的。真正需要的是环境变化、人的介入、和失败。
   */
  const WATCHED = {
    // ---- 人的动作 ----
    /**
     * v1.34：评论降级为 noteOnly —— 它不再单独触发一次投递。
     *
     * 线上 325 条投递里 116 条是这个事件（最大来源）。但评论是讨论，
     * 不是「等你做决定」：人写一条调度员就醒一次，等于把通知当同步用。
     * 调度员真要看内容时会自己调 flow_task_detail。
     *
     * 现在的行为：攒着，等本批别的通知要发时作为附注挂上去；
     * 如果一直没别的通知，它自己也会在 maxWait 后发一条合并摘要。
     */
    // v1.37：只有人或远程（GitHub）来的评论才进调度队列。
    // 工人检查点、系统流水评论是"记录"不是"等你决定"：线上 11:40–12:16 调度 46 次投递里 37 次是它们。
    // 工人进度改走 task.progress（状态变化才唤醒）。
    //
    // v1.37.3 修：这里**不能**标 noteOnly。
    // noteOnly 的语义是"攒着搭别的通知的车"，配合聚合器"整批都是附注就不单独发"的规则，
    // 后果是**人单独留一条评论时那一批只有它自己 → 永远发不出去**（线上 T-046 的证据）。
    // 降噪已经在 only 这一层做完了：工人和系统评论压根进不来，能进来的就是人在说话，
    // 人说话必须能叫醒调度。
    'comment.added': { why: '人留了评论', only: (event) => {
      // emit() stores actor as an id string (e.g. 'web'), not the original role object.
      // The persisted comment is the authoritative source of the author's role.
      const p = event && event.payload || {}
      const c = p.commentId && (store.state.task_comments || []).find((x) => x && x.id === p.commentId)
      const role = c ? c.role : (event && event.actor && typeof event.actor === 'object' ? event.actor.role : null)
      return role === 'human' || role === 'remote' || !!p.remote
    } },
    // 故障类：即使是被我自己（派工/合并流程）触发的也要通知——
    // 否则 dispatcher 自己派工失败会把通知吞掉，任务就静默卡住了。
    'task.blocked': { why: '任务被阻塞', selfNotify: true },
    'approval.revoked': { why: '审批被吊销（方案变了，需要重新对齐）' },
    'task.handoff': { why: '有卡交接过来' },
    // task.moved 是"一个事件类型装很多动作"，按 action 细分（domain 里重开/改派都走它）
    'task.moved': {
      actions: {
        reopen: { why: '任务被重开' },
        cancel: { why: '任务被取消' },
        reassign: { why: '任务被改派' },
        review_conflict: { why: '审核判冲突，已回工人' },
        review_risk: { why: '审核判有风险，需要你介入' },
        rework: { why: '验收打回返工' },
        reject: { why: '计划被打回' },
      },
    },

    // ---- 失败与异常 ----
    'task.run.ended': { why: 'run 失败（不是正常自停）', onlyFailed: true, selfNotify: true },
    'run.stuck': { why: '心跳超时，任务卡死', selfNotify: true },
    'pr.merge_conflict': { why: '合并冲突', selfNotify: true },

    // ---- 需要调度员推进下一步 ----
    'task.inspection': { why: '有巡检结论，等你推进' },
    'pr.opened': { why: 'PR 已开，等审核' },
    'task.scope': { why: '阅读范围变了（会影响派给谁）' },
    // v1.37：工人进度只在状态变化或出现阻塞点时唤醒调度员。
    // 这条事件在 setProgress 中发出，payload 带 stateChanged 和 hasBlocker。
    'task.progress': { why: '进度状态变化', only: (event) => {
      const p = event && event.payload || {}
      return !!p.stateChanged || !!p.hasBlocker
    } },
  }

  /** 去重窗口：同一任务同类事件在窗口内只插一次话，避免消息风暴。 */
  /**
   * 这类通知能不能等？
   *
   * 能等的是「知道一下就好」的推进提示；不能等的是「卡死了/炸了」——
   * 故障等 3 秒才告诉调度员，等于把故障处理推迟 3 秒。
   */
  function isUrgentKind(kind) {
    const k = String(kind || '')
    if (k.indexOf('watch:task.blocked') === 0) return true
    if (k.indexOf('watch:task.run.ended') === 0) return true
    if (k.indexOf('watch:run.stuck') === 0) return true
    if (k.indexOf('watch:pr.merge_conflict') === 0) return true
    if (k.indexOf('watch:task.moved:review_risk') === 0) return true
    return false
  }

  /** 聚合器：把连续产生的一批通知合并成一条再投给调度员（见 lib/aggregator.js）。 */
const aggregator = createAggregator({
  deliver: async (sessionId, text) => runtime.promptSession(sessionId, text, 'steer', { origin: 'system' }),
  log,
  config: aggregatorConfig(),
})

/** 参数可被项目环境变量覆盖；默认值见 DEFAULT_AGGREGATE。 */
function aggregatorConfig() {
  const num = (name, fallback) => {
    const v = Number(process.env[name])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    debounceMs: num('DSH_FLOW_MERGE_WINDOW_MS', 3000),
    maxWaitMs: num('DSH_FLOW_MERGE_MAX_WAIT_MS', 10000),
    maxChars: num('DSH_FLOW_MERGE_MAX_CHARS', 6000),
  }
}

const STEER_WINDOW_MS = Number(process.env.DSH_FLOW_STEER_WINDOW_MS) || 30 * 1000
  const recentSteer = new Map()

  /**
   * 这个事件的触发者是不是"我自己"。
   *
   * actor 可能是 agentId / sessionId / 角色字面量。前两种能精确定位到人；
   * 角色字面量只能定位到"角色"，这时**只有在该项目该车道只有一个这类代理时**
   * 才敢判成自己，否则会把同事的动作也吞掉。
   */
  function isSelfActor(actor, self) {
    const raw = actor && typeof actor === 'object' ? (actor.id || actor.role) : actor
    const token = String(raw || '').trim()
    if (!token || !self) return false
    // 系统自己做的（调度流程内部动作）也不算"别人"：这类事件多半是
    // dispatcher 刚调用的工具留下的记录，通知回去就是自激。
    // 真正的故障已经由 WATCHED 里的 selfNotify 标出来，不会被这里吞掉。
    if (token === 'system') return true
    if (token === self.id) return true
    // sessionId → 反查 agent
    const bySession = domain.agentBySession(token)
    if (bySession && bySession.id === self.id) return true
    // 角色字面量：同项目同车道同类代理只有一个时，才算自己
    if (token === self.role) {
      const peers = Object.values(store.state.agents).filter((a) =>
        a && a.projectId === self.projectId && a.role === self.role && a.enabled !== false)
      return peers.length === 1
    }
    return false
  }

  /** 找到某车道该被通知的子调度（同项目、同车道、启用中）。 */
  function supervisorFor(task) {
    const lane = (task && task.lane) || 'human'
    const list = Object.values(store.state.agents).filter((a) =>
      a && a.projectId === task.projectId && a.role === 'dispatcher' && a.enabled !== false && (a.lane || 'human') === lane)
    return list[0] || null
  }

  /**
   * 给调度员插话（steer：进入当前回合但不打断）。
   * 投递失败只记日志——事件通知不能反过来影响事务提交。
   */
  async function steerSupervisor(task, text, { kind = 'watch', noteOnly = false } = {}) {
    if (domain.halted()) return { ok: false, skipped: 'halted', message: '调度已被手动停止' }
    const sup = supervisorFor(task)
    if (!sup) {
      domain.logMessage({ direction: 'out', origin: 'system', kind: 'notify-failed', ok: false, taskId: task.id, reason: '没有同车道调度员' })
      return { ok: false, message: '没有同车道调度员' }
    }
    let rec = domain.latestSession(sup.id)
    if (!rec || !rec.sessionId) {
      rec = await runtime.ensureSession(sup, store.state.projects[task.projectId], { cwd: store.state.projects[task.projectId]?.workspacePath })
      if (!rec || !rec.ok || !rec.sessionId) {
        domain.logMessage({ agentId: sup.id, direction: 'out', origin: 'system', kind: 'notify-failed', ok: false, taskId: task.id, reason: '调度员会话不可用' })
        return { ok: false, message: '调度员会话不可用' }
      }
    }
    try {
      // v1.34：不直接 promptSession —— 走聚合器合并一批再发。
      // 原来一个事件一次投递，线上实测一分钟最多 8 条，
      // 调度员每 7 秒被打断一次，模型没法连续输出。
      const merged = await aggregator.push({
        sessionId: rec.sessionId,
        text,
        // 故障类立即发：卡死了等 3 秒等于延迟处理
        urgent: isUrgentKind(kind),
        // 附注类不单独触发投递，攒到下一批一起走（见 aggregator.push）
        noteOnly,
        taskId: task.id,
        kind,
        agentId: sup.id,
      })
      domain.logMessage({ sessionId: rec.sessionId, agentId: sup.id, direction: 'out', origin: 'system', kind, ok: !!merged.ok, taskId: task.id,
        queued: Number(merged.queued) || 0, immediate: !!merged.immediate })
      return { ok: !!merged.ok, sessionId: rec.sessionId, agentId: sup.id, queued: merged.queued, immediate: merged.immediate }
    } catch (err) {
      log('steer supervisor failed ' + sup.id + ': ' + ((err && err.message) || err))
      return { ok: false, message: String((err && err.message) || err) }
    }
  }

  /** 事件 → 一行"要你判断什么"，让对方不用回头读历史。 */
  function describeWatch(event, rule) {
    const p = event.payload || {}
    const task = p.taskId ? store.state.tasks[p.taskId] : null
    const where = task ? task.id + '「' + task.title + '」 ' + task.column + (task.phase ? '/' + task.phase : '') : (p.taskId || '(无任务)')
    const bits = [ '【事件 ' + event.type + '】' + where ]
    if (p.reason) bits.push('原因：' + p.reason)
    if (p.status) bits.push('run 状态：' + p.status)
    if (p.stopReason) bits.push('停止原因：' + String(p.stopReason).slice(0, 300))
    if (p.verdict) bits.push('巡检结论：' + p.verdict)
    if (p.overdueMs) bits.push('超时：' + Math.round(Number(p.overdueMs) / 60000) + ' 分钟')
    if (p.files && p.files.length) bits.push('冲突文件：' + p.files.slice(0, 5).join(', '))
    // 评论正文不在事件 payload 里（只有 commentId），按 id 反查一次，
    // 否则调度员收到的通知是"有人评论了"但不知道说了什么，等于还得自己去捞。
    if (p.commentId) {
      const c = (store.state.task_comments || []).find((x) => x && x.id === p.commentId)
      if (c) bits.push('评论者：' + (c.author || c.role || '?') + '（' + (c.role || 'human') + '）')
      if (c && c.content) bits.push('内容：' + String(c.content).replace(/\n/g, ' ').slice(0, 400))
    }
    if (p.content) bits.push('内容：' + String(p.content).replace(/\n/g, ' ').slice(0, 300))
    if (p.actor || event.actor) bits.push('触发者：' + (p.actor || event.actor))
    bits.push('')
    bits.push('请判断：' + ((rule && rule.why) || '是否需要动作') + '。要细节用 flow_task_detail，要推进用 flow_task_move。')
    return bits.join('\n')
  }

  /**
   * 订阅事务事件流，把"调度员该知道"的那些变成插话。
   * 返回 off()。挂在 index.js 的 ctx.effect 里，卸载即退订。
   */
  function watchEvents() {
    return domain.subscribe((event) => {
      // 一键停止期间一律不打扰：用户要的是"安静下来"，
      // 这时候还往里塞事件等于没停。
      if (domain.halted()) return
      // 默认只打扰"需要调度员做决定"的事件（见 WATCHED 的取舍）。
      // 想全量通知（任何事件都插话）就设 DSH_FLOW_WATCH_ALL=1 —— 会明显吵，仅调试/演示用。
      const watchAll = process.env.DSH_FLOW_WATCH_ALL === '1'
      const raw = WATCHED[event.type] || (watchAll ? { why: '事件通知（全量模式）' } : null)
      if (!raw) return
      const p = event.payload || {}
      // 一个事件类型装多个动作时，只有登记过的动作才打扰调度员
      let rule = raw
      if (raw.actions) {
        rule = raw.actions[p.action]
        if (!rule) return
      }
      if (typeof rule.only === 'function' && !rule.only(event)) return
      if (!p.taskId) return
      const task = store.state.tasks[p.taskId]
      if (!task) return
      // 只看自己车道：issue 车道的卡归 issue 调度，human 的归 human 调度
      const self = supervisorFor(task)
      if (!self) return
      // 不让调度员被自己刚做的事刷屏（自激过滤）。
      // actor 有三种历史形态，必须都认，否则会漏判 → 调度员被自己的操作反复叫醒：
      //   1) agentId（工具层 actorOf 写入，最准）
      //   2) sessionId（拿不到 agent 时的兜底）
      //   3) role 字面量（更早的写法，如 'dispatcher'）
      // 自己触发的"记录类"事件不打扰自己（防自激）；
      // 但故障类（blocked / 失败 / 冲突 / 卡死）必须通知——那是结果，不是噪音。
      if (isSelfActor(event.actor, self) && !rule.selfNotify) return
      // run 结束只在失败/超时时打扰（正常 stop 由 afterStop 走巡检）
      if (rule.onlyFailed && p.status === 'stopped') return
      // Distinct human messages must survive the coarse event throttle.
      const key = task.id + '|' + event.type + (p.commentId ? '|' + p.commentId : '')
      const now = Date.now()
      const last = recentSteer.get(key) || 0
      if (now - last < STEER_WINDOW_MS) return
      recentSteer.set(key, now)
      const kind = 'watch:' + event.type + (p.action ? ':' + p.action : '')
      // 异步投递：不阻塞事务、失败只记日志
      Promise.resolve()
        .then(() => steerSupervisor(task, describeWatch(event, rule), {
          kind,
          // v1.34：noteOnly 的事件（目前是评论）不单独触发投递，
          // 而是作为附注排队 —— 等本批别的通知要发时一起走，否则攒到 maxWait。
          // 这样一次讨论里的 10 条评论不会变成 10 次打断。
          noteOnly: rule.noteOnly === true,
        }))
        .catch((err) => log('watchEvents deliver failed: ' + ((err && err.message) || err)))
    })
  }

  /** 把巡检包投给调度员的真实会话（没有调度员就只记事件）。 */
  async function notifyDispatcher(task, trigger, kind, extra = {}) {
    if (!task) return { ok: false, message: 'unknown task' }
    if (domain.halted()) return { ok: false, skipped: 'halted', message: '调度已被手动停止' }
    const project = store.state.projects[task.projectId]
    // v1.24 修：原来这里取"项目内第一个 dispatcher"，不看车道 ——
    // 于是 issue 车道的巡检包全灌进 human 车道的调度员1。
    // 线上 message_log 有铁证：watch:* 落 ag_025（issue 调度），inspect 落 ag_018（human 调度），
    // 同一张卡两套通知走两条路。先按车道找，找不到才退回项目内任意调度员
    // （单车道项目里两者本来就是同一个，退化分支只为兼容老项目少配工位的情况）。
    const dispatcher = supervisorFor(task) ||
      Object.values(store.state.agents)
        .find((a) => a.projectId === task.projectId && a.role === 'dispatcher' && a.enabled !== false)
    // v1.24 补：失败也要留痕。
    // 线上验证「停止生成」链路时踩到：run 收了、评论写了，但 message_log 里没有 inspect 记录——
    // 因为下面两处失败是**静默 return**，调用方拿到的返回值没人看。
    // 结果就是"通知到底有没有送到"只能靠猜，而这恰恰是最需要留证据的一步。
    if (!dispatcher) {
      domain.logMessage({ sessionId: null, agentId: null, direction: 'out', origin: 'system', kind: 'notify-failed', ok: false, taskId: task.id, reason: '没有调度员（lane=' + (task.lane || 'human') + '）' })
      return { ok: false, message: '没有调度员' }
    }
    const ens = await runtime.ensureSession(dispatcher, project, { cwd: project && project.workspacePath })
    if (!ens.ok) {
      domain.logMessage({ sessionId: null, agentId: dispatcher.id, direction: 'out', origin: 'system', kind: 'notify-failed', ok: false, taskId: task.id, reason: '调度员会话不可用：' + String(ens.message || '').slice(0, 200) })
      return ens
    }
    // v1.29：把 project / 具体调度员传进去，巡检包才能拼上内置规则与自定义提示词。
    const cur = store.state.tasks[task.id] || task
    const runId = extra.runId || cur.activeRunId || null
    const worker = cur.assignee ? store.state.agents[cur.assignee] : null
    const packet = buildInspectPacket(cur, trigger, domain.inspect(task.id), { project, agent: dispatcher, kind, runId, workerName: worker ? worker.name : null, message: extra.message || null })
    const eventType = EVENT_OF_KIND[kind] || ('task.' + (kind || 'update'))
    // 同一事件只投一次（evt:<task>:<run>:<type>）；handoff 等带内容的事件由调用方给 dedupe 后缀
    const evtKey = 'evt:' + task.id + ':' + (runId || '-') + ':' + eventType + (extra.dedupeSuffix ? ':' + extra.dedupeSuffix : '')
    if (extra.dedupe !== false && kind !== 'claim' && domain.hasLogged(evtKey)) return { ok: true, duplicate: true, kind }
    // v1.34：巡检包同样走聚合 —— 它是最容易和别的通知撞在一起的一类。
    // inspect 包通常较长，但聚合器有 maxChars 上限，超了会截断并提示用 flow_task_detail。
    const mergedNotify = await aggregator.push({
      sessionId: ens.sessionId,
      text: packet,
      urgent: kind === 'handoff' || kind === 'session-failed',
      taskId: task.id,
      kind: 'inspect',
      agentId: dispatcher.id,
    })
    const sent = { ok: !!mergedNotify.ok }
    domain.logMessage({ sessionId: ens.sessionId, agentId: dispatcher.id, direction: 'out', origin: 'system', kind: 'inspect', event: eventType, ok: !!sent.ok, taskId: task.id, runId, dedupeKey: evtKey })
    // v1.39：投递只记事件，不再往卡上写「已通知调度员巡检」评论（那是评论区最大的噪音来源）
    if (sent.ok) await domain.noteEvent(task.id, 'dispatcher.notified', { event: eventType, trigger, dispatcherId: dispatcher.id }).catch(() => null)
    // v1.4：这张卡是某个对话发起的 → 回一条摘要给那个对话（不绑死"主调度"，
    // 谁发起谁收信；同一工作区里多个对话同时调度也不会串。）
    const origin = await relayToOrigin(task, trigger)
    return { ...sent, sessionId: ens.sessionId, kind, origin }
  }

  /**
   * 把一条摘要投回「发起这张卡的对话」。
   * 收件人是任务上的 originSessionId；没有就跳过（例如自动调度进来的卡）。
   */
  async function relayToOrigin(task, reason) {
    const sid = (task && task.originSessionId) || null
    if (!sid) return { ok: false, skipped: 'no-origin' }
    const text = [
      '【调度台回信】' + task.id + ' ' + (task.title || ''),
      '触发：' + (reason || 'update'),
      '当前列：' + (task.column || '') + (task.phase ? ' · ' + task.phase : ''),
      '巡检建议：' + ((domain.inspect(task.id) || {}).verdict || 'keep'),
    ].join('\n')
    const sent = await runtime.promptSession(sid, text, 'steer', { origin: 'system' })
    domain.logMessage({ sessionId: sid, agentId: null, direction: 'out', origin: 'system', kind: 'relay', ok: !!sent.ok, taskId: task.id })
    return { ok: !!sent.ok, sessionId: sid, message: sent.message || null }
  }

  /**
   * 审核闸门（v1.35）：合并前必须有结论。
   *
   * 原来 mergeLocked 在合并**之后**发现没结论就补一条「合并事务自动通过」—— 审核判据形同虚设。
   * 现在：
   *   - 有结论且是 approved → 放行；不是 approved → 拒绝；
   *   - 没结论、人在界面点合并（by='human'）→ 这次点击就是人的结论，记一条并放行；
   *   - 没结论、项目没有启用的 block 级判据 → 没有可审的东西，记一条并放行；
   *   - 其余（代理/自动合并、有 block 级判据）→ 拒绝，先 flow_pr_review。
   */
  async function reviewGate(task, by) {
    const mr = task.mergeRequest || {}
    if (mr.reviewVerdict) {
      return mr.reviewVerdict === 'approved' ? { ok: true } : { ok: false, message: '审核结论是 ' + mr.reviewVerdict + '，不能合并' }
    }
    if (by === 'human') {
      await domain.setReviewVerdict(task.id, 'approved', '人在看板上直接合并（视为人工审核通过）', [], { role: 'human', id: 'web' })
      return { ok: true }
    }
    const blocks = domain.reviewPromptSet(task.projectId).prompts.filter((p) => p.severity === 'block')
    if (!blocks.length) {
      await domain.setReviewVerdict(task.id, 'approved', '项目没有启用 block 级审核判据，合并前自动记录通过', [], { role: 'system', id: 'system:merge' })
      return { ok: true }
    }
    return { ok: false, needsReview: true, message: '还没有审核结论：先按审核判据审核（flow_pr_review），审核通过后再合并' }
  }

  /** TX-16：合并事务。成功 → done；冲突 → 软合并回派（TX-17）。 */
  async function merge(task, { strategy, by = 'agent' } = {}) {
    if (!task) return { ok: false, message: 'unknown task' }
    if (task.column !== 'merging') return { ok: false, message: '只有「合并中」的任务能合并（当前 ' + task.column + '）' }
    // 先确认有东西可合，再过审核闸门（否则人点合并会先留下一条 approved，然后才发现没有 PR）
    if (!Object.values(store.state.pull_requests).some((p) => p.taskId === task.id)) return { ok: false, message: '没有 PR 记录，先 flow_pr_open' }
    const gate = await reviewGate(store.state.tasks[task.id] || task, by)
    if (!gate.ok) return gate
    // I4/I10：同一仓库同时只允许一个合并事务，持租约才动 base。
    const lock = await domain.lockMerge(task.projectId, task.id)
    if (!lock.ok) {
      // v1.35：排队而不是直接拒（设计文档 §4.8 merge_queue）。autoMerge 按 queuedAt 先来先合。
      await domain.markMergeQueued(task.id).catch(() => null)
      return { ok: false, queued: true, message: '仓库合并锁被占用（' + lock.reason + '），已排队，锁释放后按顺序合并' }
    }
    try {
      return await mergeLocked(store.state.tasks[task.id] || task, { strategy })
    } finally {
      await domain.unlockMerge(task.projectId, lock.token)
    }
  }

  /**
   * 合并提交摘要（v1.22 用户要求③「PR/commit 也全同步」）。
   *
   * 为什么是"摘要评论"而不是"每个 commit 建一个实体"：issue 上人真正要看到的是
   * 「这次合并带进来哪些提交」，逐条 commit 建实体既没有对应的可点对象，也会把看板撑爆。
   * 摘要里带短 sha，需要细节的人照样能在 GitHub 上点开。
   */
  async function commitSummary(task, { commit = null, base = null } = {}) {
    try {
      const project = store.state.projects[task.projectId]
      const dir = (project && project.workspacePath) || null
      if (!dir || !(await git.isRepo(dir))) return ''
      const res = await git.log({ dir, from: base, to: commit || 'HEAD', limit: 10 })
      if (!res.ok || !res.commits.length) return ''
      const lines = res.commits.map((c) => '- `' + c.short + '` ' + c.subject)
      return '**本次合并的提交**\n' + lines.join('\n')
    } catch {
      return ''
    }
  }

  /** 持锁后的合并主体。 */
  async function mergeLocked(task, { strategy } = {}) {
    if (task.column !== 'merging') return { ok: false, message: '只有「合并中」的任务能合并（当前 ' + task.column + '）' }
    const project = store.state.projects[task.projectId]
    const prs = Object.values(store.state.pull_requests).filter((p) => p.taskId === task.id)
    const pr = prs[prs.length - 1]
    if (!pr) return { ok: false, message: '没有 PR 记录，先 flow_pr_open' }
    if (pr.status === 'merged') return { ok: true, already: true, commit: pr.mergeCommit }
    // I6/T13：验收绑定的 head_sha 与 PR 当前提交不一致，说明验收后又改过，必须重新验收。
    if (task.headSha && pr.headSha && task.headSha !== pr.headSha) {
      return { ok: false, message: '验收后提交已变化（验收 ' + task.headSha.slice(0, 8) + '，PR ' + pr.headSha.slice(0, 8) + '），需要重新验收' }
    }
    if (!(await git.isRepo(project.workspacePath))) return { ok: false, message: '工作区不是 git 仓库，无法合并' }
    const base = (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath))
    const strat = strategy || (project.config && project.config.mergeStrategy) || 'merge'
    // v1.35：L1 先落意图（谁、哪条分支、合到哪、合并前 base 在哪），再动 git。
    const baseBefore = await git.revParse(project.workspacePath, base).catch(() => null)
    await domain.recordMergeIntent(task.id, { branch: pr.branch, base, strategy: strat, headSha: pr.headSha || null, baseBefore })
    const res = await git.mergeBranch({
      repo: project.workspacePath,
      branch: pr.branch,
      base,
      strategy: strat,
      message: 'flow: merge ' + task.id + ' — ' + task.title,
    })
    if (!res.ok) {
      await domain.markMergeConflict(task.id, { files: res.files || [], baseSha: pr.baseSha, reason: res.reason || '' })
      await comment(domain, task.id, '合并冲突：' + ((res.files || []).join(', ') || res.reason || '未知') + '，已回派原工人软合并')
      const pkt = buildConflictPacket(task, pr, res)
      await domain.inject(task.id, { kind: 'context', content: pkt.slice(0, 4000) }, { role: 'dispatcher', id: 'system' })
      await domain.move(task.id, 'review_conflict', { role: 'dispatcher', id: 'system' }, { reason: res.reason || 'merge conflict' })
      const again = await dispatch(store.state.tasks[task.id])
      return { ok: false, conflict: true, files: res.files || [], redispatched: again }
    }
    // v1.35：合并后校验（设计文档 §4.8）—— base 现在必须真的包含这次的结果。
    // squash 的结果是 base 上的新提交，不是分支头，所以校验对象统一用 res.commit。
    const verified = await git.isAncestor(project.workspacePath, res.commit, base).catch(() => null)
    if (verified === false) {
      await domain.block(task.id, '合并后校验失败：' + base + ' 不包含 ' + String(res.commit || '').slice(0, 8) + '（mergeIntent 保留待人核对）', { role: 'system', id: 'system:merge' })
      return { ok: false, message: '合并后校验失败：base 不包含合并结果', verify: false }
    }
    // v1.33：把「这次是真合并还是早就合过了」一起记下来 —— 审计里要能分辨
    await domain.markMerged(task.id, { commit: res.commit, strategy: strat, alreadyMerged: res.alreadyMerged === true, mergeCommit: res.mergeCommit || null })
    // v1.36：合并后冒烟（设计文档 §4.8 第 6 步）。只在项目显式配了 postMergeCheck 时跑。
    // 失败不回滚已经落地的合并（revert 掉是更危险的动作），而是阻塞卡片并把人叫来。
    const check = postMergeCheckOf(project)
    if (check) {
      const runRes = await runCommand({ command: check.command, cwd: project.workspacePath, timeoutMs: check.timeoutMs })
      await domain.setPostMergeCheck(task.id, { ok: runRes.ok, command: check.command, code: runRes.code, timedOut: !!runRes.timedOut, stdout: runRes.stdout, stderr: runRes.stderr }, { role: 'system', id: 'system:merge' }).catch(() => null)
      if (!runRes.ok) {
        const detail = [runRes.stderr, runRes.stdout].filter(Boolean).join('\n').slice(-2000)
        await domain.block(task.id, '合并后冒烟失败：' + (runRes.timedOut ? '超时' : '退出码 ' + runRes.code) + '（' + check.command + '）', { role: 'system', id: 'system:merge' })
        await comment(domain, task.id, '合并已完成（' + String(res.commit || '').slice(0, 8) + '），但合并后冒烟失败：\n\n' + detail)
        return { ok: false, postMergeFailed: true, commit: res.commit, message: '合并后冒烟失败' }
      }
      await comment(domain, task.id, '合并后冒烟通过（' + check.command + '）')
    }
    await domain.move(task.id, 'review_approve', { role: 'dispatcher', id: 'system' }, {})
    await removeWorktree(task)
    // v1.39：子卡合并完成 → 检查父卡是不是该收口了
    await rollupParent(store.state.tasks[task.id] || task).catch(() => null)
    const summary = await commitSummary(task, { commit: res.commit, base })
    await comment(domain, task.id, '已合并到 ' + base + '（' + strat + '，commit ' + (res.commit || '-') + '）' + (summary ? '\n\n' + summary : ''))
    return { ok: true, commit: res.commit, strategy: strat, base }
  }

  /**
   * v1.35：请调度按审核判据审核（设计文档 §4.8 第 4 步）。
   *
   * 原来自动推进直接写 approved，renderReviewPrompt 在生产代码里没有调用方 —— 判据集只是摆设。
   * 现在把 PR 快照 + 判据拼成审核包投给车道调度，让它用 flow_pr_review 回结论。
   */
  async function requestReview(task) {
    if (!task || !task.mergeRequest) return { ok: false, message: '没有 PR 快照' }
    if (domain.halted()) return { ok: false, skipped: 'halted', message: '调度已被手动停止' }
    const project = store.state.projects[task.projectId]
    const dispatcherAgent = supervisorFor(task) ||
      Object.values(store.state.agents).find((a) => a.projectId === task.projectId && a.role === 'dispatcher' && a.enabled !== false)
    if (!dispatcherAgent) return { ok: false, message: '没有调度员可以审核' }
    const ens = await runtime.ensureSession(dispatcherAgent, project, { cwd: project && project.workspacePath })
    if (!ens.ok) return { ok: false, message: '调度员会话不可用：' + (ens.message || '') }
    const rendered = domain.renderReviewPrompt(task.projectId, task.mergeRequest)
    const text = [
      '【审核请求】' + task.id + ' ' + (task.title || ''),
      '',
      rendered.text,
      '',
      '审核完用 flow_pr_review(taskId="' + task.id + '", verdict, matched, summary) 回结论；approved 之后合并事务会接着做。',
    ].join('\n')
    const sent = await runtime.promptSession(ens.sessionId, text, 'steer', { origin: 'system' })
    domain.logMessage({ sessionId: ens.sessionId, agentId: dispatcherAgent.id, direction: 'out', origin: 'system', kind: 'review-request', ok: !!sent.ok, taskId: task.id, dedupeKey: 'review:' + task.id + ':' + (task.mergeRequest.headSha || '-') })
    if (sent.ok) await comment(domain, task.id, '已请调度按审核判据 v' + rendered.version + ' 审核')
    return { ok: !!sent.ok, message: sent.message || null, promptVersion: rendered.version }
  }

  /**
   * v1.35：合并意图对账（L3）。有 mergeIntent、合并锁没人持有、超过 graceMs —— 说明上一次合并
   * 在 git 和 markMerged 之间断掉了。去 git 里看结果再收口，而不是等人发现。
   */
  async function reconcileMergeIntents({ now = Date.now(), graceMs = 2 * 60000 } = {}) {
    const out = []
    for (const task of Object.values(store.state.tasks)) {
      const intent = task && task.mergeIntent
      if (!intent || task.column !== 'merging') continue
      if (now - (Date.parse(intent.at) || 0) < graceMs) continue
      const lease = store.state.leases['merge:' + task.projectId]
      if (lease && lease.expiresAt > now) continue
      const project = store.state.projects[task.projectId]
      if (!project || !(await git.isRepo(project.workspacePath).catch(() => false))) continue
      const baseNow = await git.revParse(project.workspacePath, intent.base).catch(() => null)
      const landed = intent.headSha ? await git.isAncestor(project.workspacePath, intent.headSha, intent.base).catch(() => null) : null
      if (landed === true) {
        await domain.markMerged(task.id, { commit: baseNow || intent.headSha, strategy: intent.strategy || 'merge', alreadyMerged: false, mergeCommit: baseNow || null })
        await domain.move(task.id, 'review_approve', { role: 'dispatcher', id: 'system:reconcile' }, {}).catch(() => null)
        await comment(domain, task.id, '对账：上次合并在记账前中断，git 里已经包含 ' + String(intent.headSha).slice(0, 8) + '，已补记为已合并')
        out.push({ taskId: task.id, result: 'merged' })
      } else if (landed === false && intent.strategy !== 'squash') {
        await domain.clearMergeIntent(task.id, '对账：合并没有落到 ' + intent.base)
        await comment(domain, task.id, '对账：上次合并中断且没有落到 ' + intent.base + '，已清掉合并意图，会重新排队合并')
        out.push({ taskId: task.id, result: 'cleared' })
      } else {
        // squash 的结果不是分支头的后代，git 判不出来；或者 git 出错 —— 交给人
        await domain.block(task.id, '合并中断且无法自动判定是否已落到 ' + intent.base + '（策略 ' + (intent.strategy || '?') + '），请人工核对后修复', { role: 'system', id: 'system:reconcile' }).catch(() => null)
        out.push({ taskId: task.id, result: 'blocked' })
      }
    }
    return out
  }

  /** TX-17：软合并 —— 在 worker 的 worktree 里把 base 的新提交接进来。 */
  async function softMerge(task, { onto } = {}) {
    const project = store.state.projects[task.projectId]
    const wt = domain.worktreeOf(task.id)
    if (!wt) return { ok: false, message: '任务没有 worktree' }
    const base = onto || (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath))
    const res = await git.rebaseWorktree({ dir: wt.path, onto: base })
    if (!res.ok) {
      await comment(domain, task.id, '软合并失败：' + (res.reason || '') + (res.files && res.files.length ? '（冲突：' + res.files.join(', ') + '）' : ''))
      return res
    }
    await domain.markRebased(task.id, { headSha: res.headSha, files: [] })
    await comment(domain, task.id, '软合并完成，分支已 rebase 到 ' + base)
    return { ok: true, headSha: res.headSha }
  }

  /**
   * TX-15：开 PR —— 提交 worktree 改动（可选推送），落一条 pull_requests，
   * 同步开着的时候**同时建远程 PR**（用户要求③「默认建」）。
   *
   * 远程 PR 只是「让人在仓库里看见这条卡走到了哪一步」，合并仍以本地为准：
   * 双写会产生两套真相，谁先谁后都能打架。
   */
  async function openPr(task, { message } = {}) {
    if (!task) return { ok: false, message: 'unknown task' }
    const project = store.state.projects[task.projectId]
    const wt = domain.worktreeOf(task.id)
    const dir = (wt && wt.path) || (project && project.workspacePath)
    if (!dir || !(await git.isRepo(dir))) return { ok: false, message: '工作目录不是 git 仓库，无法开 PR' }
    const commit = await git.commitAll({ dir, message: message || ('flow: ' + task.id + ' ' + task.title) })
    if (!commit.ok) return commit
    let pushed = { ok: false, reason: 'pushRemote 未开' }
    if (project.config && project.config.pushRemote) {
      pushed = await git.pushBranch({ dir, branch: (wt && wt.branch) || undefined })
    }
    const head = commit.headSha || (await git.headSha(dir))
    const base = await git.headSha(project.workspacePath)
    const pr = await domain.openPullRequest(task.id, {
      headSha: head, baseSha: base, branch: wt && wt.branch, title: task.title,
    })

    // 远程 PR：pushRemote 开着才建（没推分支就建 PR 只会得到 422）
    let remotePr = null
    const cfg = project.config || {}
    if (cfg.pushRemote && cfg.remote && cfg.remote.owner && cfg.remote.repo && cfg.recordIssues) {
      try {
        const branch = (wt && wt.branch) || (await git.currentBranch(dir))
        const baseRef = cfg.baseBranch || (await git.defaultBranch(project.workspacePath)) || 'main'
        const body = [
          '本地卡：' + task.id + ' ' + (task.title || ''),
          '',
          '由 dsh-flow 自动创建；合并以本地为准，这里只是让人看见进度。',
          '',
          '<!-- dsh-flow:task ' + task.id + ' n=pr-' + pr.id + ' -->',
        ].join('\n')
        const created = await createPull({
          remote: cfg.remote, title: '[flow] ' + task.id + ' ' + (task.title || ''), head: branch, base: baseRef, body,
        })
        if (created.ok) {
          remotePr = created
          await domain.attachPullRemote(pr.id, { number: created.number, url: created.url, source: cfg.remote.kind || 'github', state: created.state })
        } else {
          await comment(domain, task.id, '远程 PR 建失败（不影响本地审核）：' + (created.reason || 'unknown'))
        }
      } catch (err) {
        await comment(domain, task.id, '远程 PR 建失败（不影响本地审核）：' + String((err && err.message) || err))
      }
    }

    await comment(domain, task.id, '已开 PR ' + pr.id + '（head ' + String(head).slice(0, 8) + (commit.changed ? '，含新提交' : '，无新改动') + (pushed.ok ? '，已推送' : '') + (remotePr ? '，远程 #' + remotePr.number : '') + '）')
    return { ok: true, pr, commit, pushed, remotePr }
  }

  /**
   * v1.36：worktree 的回收与隔离。
   *
   * 以前只有"尽力 remove，失败留评论"。两个问题：
   *   1. 有未提交改动时直接删 = 把工人没交的东西一起烧掉（T-035 系列就留着未提交改动）；
   *   2. 删失败没人管，目录和 git 元数据越积越多（ework 有 workdir-gc，我们没有）。
   * 现在：脏的**移到隔离区**（.quarantine/<taskId>-<时间戳>）而不是删，干净的才真删；
   * 另配一个按 TTL 的 GC（gcWorktrees），由 tick 定期跑。
   */
  function quarantineDirFor(wt) {
    const parent = dirname(wt.path)
    return join(parent, '.quarantine', basename(wt.path) + '-' + Date.now())
  }

  async function removeWorktree(task, { force = false } = {}) {
    const wt = domain.worktreeOf(task.id)
    if (!wt) return null
    const project = store.state.projects[task.projectId]
    // v1.29：先断 junction 再删目录。
    // 实测 git worktree remove 不会跟着 junction 删主仓库内容，但「依赖它一直如此」风险太大 ——
    // 一旦行为变化，代价是主仓库那份 2.7GB 环境被清空。先断链，最坏只是少删个空目录。
    const sharedDirs = (project && project.config && Array.isArray(project.config.sharedDirs) && project.config.sharedDirs.length)
      ? project.config.sharedDirs
      : DEFAULT_SHARED_DIRS
    await git.unlinkSharedDirs({ worktree: wt.path, dirs: sharedDirs }).catch(() => null)
    // 脏 worktree 不删，移到隔离区（人还能去捞未提交的东西）
    const dirty = force ? [] : await git.dirtyFiles(wt.path).catch(() => [])
    if (dirty && dirty.length) {
      const dest = quarantineDirFor(wt)
      const moved = await fsMkdir(dirname(dest), { recursive: true })
        .then(() => fsRename(wt.path, dest))
        .then(() => ({ ok: true, dest }))
        .catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
      if (moved.ok) {
        await git.pruneWorktrees(project.workspacePath).catch(() => null)
        await domain.dropWorktree(task.id, { reason: 'quarantined' })
        await comment(domain, task.id, 'worktree 里有 ' + dirty.length + ' 个未提交改动，没有删除，已隔离到 ' + moved.dest)
        return { ok: true, quarantined: true, path: moved.dest, files: dirty.slice(0, 20) }
      }
      await comment(domain, task.id, 'worktree 有未提交改动且隔离失败（' + moved.message + '），保留原目录 ' + wt.path)
      return { ok: false, reason: 'quarantine-failed', message: moved.message }
    }
    const res = await git.removeWorktree({ repo: project.workspacePath, dir: wt.path })
    await domain.dropWorktree(task.id, { reason: res.ok ? 'merged' : 'remove-failed' })
    return res
  }

  /**
   * v1.36：worktree 回收（TTL + 孤儿），由 tick 定期跑。
   * 回收条件：任务已终态 / 任务不存在 / 超过 TTL。脏的会走隔离，不会丢东西。
   */
  async function gcWorktrees({ ttlMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
    const removed = []
    const quarantined = []
    for (const [taskId, wt] of Object.entries(store.state.worktrees || {})) {
      if (!wt || !wt.path) continue
      const task = store.state.tasks[taskId]
      const terminal = !task || task.column === 'done' || task.column === 'cancelled'
      const age = now - (Date.parse(wt.createdAt || wt.updatedAt || 0) || 0)
      if (!terminal && age < ttlMs) continue
      const res = await removeWorktree(task || { id: taskId, projectId: wt.projectId }, { force: !task }).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
      if (res && res.quarantined) quarantined.push({ taskId, path: res.path })
      else if (res && res.ok) removed.push({ taskId, why: terminal ? 'terminal' : 'ttl' })
    }
    for (const project of Object.values(store.state.projects)) {
      if (project && project.workspacePath) await git.pruneWorktrees(project.workspacePath).catch(() => null)
    }
    return { removed, quarantined, at: new Date(now).toISOString() }
  }

  const onMoved = async (task, action) => {
    if (action === 'cancel') {
      const res = await afterCancel(task)
      // v1.39：子卡被取消也要检查父卡是否该收口（否则父卡永远等一张不会完成的卡）
      await rollupParent(store.state.tasks[task.id] || task).catch(() => null)
      return res
    }
    // v1.39：跳过合并 = 子卡这条支线收口 → 汇总父卡
    if (action === 'merge_skip' || action === 'review_approve') {
      await rollupParent(store.state.tasks[task.id] || task).catch(() => null)
      return null
    }
    if (action === 'approve' || action === 'approve_by_chief' || action === 'approve_by_dispatcher' || action === 'approve_by_publish' || action === 'rework' || action === 'review_conflict') return dispatch(task)
    // issue 卡的调研轮：一认领就开始调研（调研只读，不需要人先批准）
    if (action === 'claim' && task.lane === 'issue' && (!task.plan || task.plan.revision === 0)) {
      const moved = await domain.move(task.id, 'investigate', { role: 'system', id: 'flow' }).catch(() => null)
      return dispatch(moved || task)
    }
    // v1.26：human 车道的卡被认领进 planning 之后，以前是**完全静默**的 ——
    // 没人写计划、调度也不知道有这活，卡就停在那儿。线上 T-035..T-039 卡了一天。
    // 现在认领即叫调度员来写计划（它现在有 flow_task_plan 了）。
    if (action === 'claim' && (!task.plan || task.plan.revision === 0)) {
      return notifyDispatcher(task, '新卡已认领：先调研，再决定单卡计划还是拆分', 'claim')
    }
    if (action === 'accept') {
      // v1.30：验收后自动补齐 PR 快照。
      // 以前这里只发一句「验收通过，准备开 PR」的通知就结束了 —— 卡片进了 merging 列，
      // 但 mergeRequest 永远是 null，于是人一点「审核通过」就报「没有 PR 快照，无法审核」。
      // 线上 T-015/T-036 就卡在这儿。
      const notify = () => notifyDispatcher(task, '验收通过，准备开 PR', 'accept')
      if (task.column !== 'merging') return notify()
      const opened = await openPr(store.state.tasks[task.id] || task).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
      if (opened && opened.ok) {
        await comment(domain, task.id, '已自动生成 PR 快照（head ' + String(opened.headSha || '').slice(0, 8) + '），可以审核了。')
        return notifyDispatcher(store.state.tasks[task.id] || task, 'PR 已开，等待审核', 'review')
      }
      // 开不出来（没有 worktree / 没有改动 / 不是 git）：说清楚为什么，并给出可执行的下一条路。
      const why = (opened && (opened.message || opened.reason)) || '未知原因'
      await comment(domain, task.id, '这一轮没有开出 PR 快照：' + why + '。看板上点「跳过合并」可以直接收口（非 Git / 无改动的卡本来就该这么走）。')
      return notify()
    }
    if (action === 'pr_open') return notifyDispatcher(task, 'PR 已开，等待审核', 'review')
    return null
  }

  const onStopped = async (task) => afterStop(task)

  // -- v1.24 会话事件回灌：生成报错 / 停止生成 也要进管道 ----------------------
  //
  // 之前只有工人**自己调** flow_task_move(stop) 才会走 afterStop 通知调度。
  // 模型报错、用户点"停止生成"、会话崩掉，全都只有 stuckRuns（30 分钟）
  // 或 maxRunMs（3 小时）兜底 —— 中间那段时间调度完全不知道卡死了，人也不知情。
  // 这里订阅 DSH 的 session/event，把两种真实信号接进来。

  /** 按会话找正在跑的 run（调度员会话没有 run，天然被过滤掉）。 */
  function runningRunOf(sessionId) {
    if (!sessionId) return null
    return Object.values(store.state.runs || {})
      .filter((r) => r && r.status === 'running' && r.sessionId === sessionId)
      .pop() || null
  }

  /**
   * v1.39：工人这一轮有没有"汇报"过。汇报 = stop / block（卡片已阻塞或 run 已收）或发过 flow_message。
   * 只看本 run 开始之后的记录，上一轮的消息不算。
   */
  function reportedSince(run, task) {
    if (!run || run.status !== 'running') return true
    if (task && task.blocked) return true
    const since = String(run.startedAt || run.createdAt || '')
    return (store.state.message_log || []).some((m) => m && m.ok && m.kind === 'handoff' && m.fromAgentId === run.agentId &&
      m.taskId === run.taskId && String(m.at || '') >= since)
  }
  const silentNotifiedAt = new Map() // runId -> ms，同一个 run 10 分钟内只通知一次
  const SILENT_WINDOW_MS = 10 * 60 * 1000

  /**
   * 一次会话事件。
   * v1.39：没有 goal 之后，completed 是"工人这一轮结束了"。汇报过就什么都不做；
   * 没汇报（没 stop / block / flow_message）就包装成 worker.turn-ended-silent 事件发给调度 ——
   * 否则卡会一直挂在 running，直到 30 分钟心跳超时才被发现。run 不结束，由调度决定下一步。
   */
  async function onSessionEvent(sessionId, event) {
    if (!sessionId || !event || typeof event.type !== 'string') return { ok: true, ignored: true }
    // 一键停止期间什么都不接：用户要的是安静，报错/停止生成也算打扰。
    if (domain.halted()) return { ok: true, skipped: 'halted' }
    const data = event.data || {}
    let verdict = null
    if (event.type === 'error' || event.type === 'session/error') {
      verdict = { kind: 'infra', reason: '会话报错：' + String(data.message || data.reason || 'unknown error').slice(0, 300) }
    } else if (event.type === 'turn/end') {
      const reason = (data && data.reason) || {}
      const rk = String(reason.kind || '')
      if (rk === 'error') {
        const e = reason.error || {}
        verdict = { kind: 'infra', reason: '这一轮报错：' + String(e.message || e.code || 'unknown').slice(0, 300) }
      } else if (rk === 'aborted') {
        // 用户手动点了"停止生成"：这不是环境故障，是人的决定，
        // 所以只把 run 收成 interrupted 并通知调度，不自动重派。
        verdict = { kind: 'stopped', reason: '会话被停止生成（' + String((reason.reason && reason.reason.kind) || 'user') + '）' }
      } else if (rk === 'interrupted') {
        verdict = { kind: 'stopped', reason: '会话被中断（进程重启或崩溃孤儿）' }
      } else if (rk === 'max-tokens') {
        verdict = { kind: 'content', reason: '输出 token 触顶，这一轮没写完' }
      } else if (rk === 'completed') {
        const run = runningRunOf(sessionId)
        if (!run) return { ok: true, ignored: true, reason: 'no-active-run' }
        const task = store.state.tasks[run.taskId]
        if (!task || reportedSince(run, task)) return { ok: true, ignored: true, reason: 'reported' }
        const last = silentNotifiedAt.get(run.id) || 0
        if (Date.now() - last < SILENT_WINDOW_MS) return { ok: true, ignored: true, reason: 'silent-deduped' }
        silentNotifiedAt.set(run.id, Date.now())
        const notified = await notifyDispatcher(task, '工人本轮结束未汇报', 'turn-silent', { runId: run.id, dedupeSuffix: String(Date.now()) })
        return { ok: true, silent: true, notified }
      }
    }
    if (!verdict) return { ok: true, ignored: true }
    const run = runningRunOf(sessionId)
    if (!run) return { ok: true, ignored: true, reason: 'no-active-run' }
    const task = store.state.tasks[run.taskId]
    if (!task) return { ok: true, ignored: true, reason: 'no-task' }
    // 收 run（带 runId 命中 fencing：这期间要是重新派过工，旧 run 的迟到事件自动作废）
    const endStatus = verdict.kind === 'stopped' ? 'interrupted' : 'failed'
    const ended = await domain.endRun(task.id, endStatus, { runId: run.id, stopReason: verdict.reason }).catch(() => null)
    stopHeartbeat(run.id)
    if (ended && ended.ignored) return { ok: true, ignored: true, reason: 'stale-run' }
    if (verdict.kind === 'stopped') {
      // 人停了生成：清掉重试标记，等调度判断要不要重新派（不自己偷偷重派）。
      await domain.clearRetry(task.id).catch(() => {})
      await comment(domain, task.id, '【会话停止】' + verdict.reason + '。run 已收为 interrupted，等你决定是重派还是改方案。')
      // v1.39.1：必须显式带 runId —— 上面 endRun 已经把 activeRunId 清掉了，
      // 不带的话幂等键塌缩成 evt:<task>:-:worker.aborted，同一张卡第二次停止会被当成重复静默吞掉。
      const notified = await notifyDispatcher(store.state.tasks[task.id] || task, '会话停止生成', 'session-stopped', { runId: run.id })
      // 通知没送到就补一句：人得知道"调度其实没收到"，否则他会以为已经交代过了。
      if (!notified || notified.ok === false) {
        await comment(domain, task.id, '（顺带：调度员没收到这条通知 —— ' + String((notified && (notified.message || notified.skipped)) || '未知原因') + '。需要人自己接手。）')
      }
      return notified
    }
    const budget = await domain.recordFailure(task.id, { kind: verdict.kind, reason: verdict.reason }).catch(() => null)
    const retry = !!(budget && budget.retry)
    const note = retry
      ? '【会话失败】' + verdict.reason + '。' + Math.round((budget.backoffMs || 0) / 1000) + ' 秒后自动重试（第 ' + budget.tries + '/' + budget.max + ' 次）。'
      : '【会话失败】' + verdict.reason + '。重试预算已用尽（' + (budget ? budget.tries + '/' + budget.max : '?') + '），需要人处理。'
    await comment(domain, task.id, note)
    if (!retry) await domain.block(task.id, '会话失败且重试预算用尽：' + verdict.reason).catch(() => {})
    // v1.39.1：同上 —— 失败事件按 run 隔离，第二次失败不能被第一次的去重键吃掉。
    const notified = await notifyDispatcher(store.state.tasks[task.id] || task, 'run 失败', 'session-failed', { runId: run.id })
    if (!notified || notified.ok === false) {
      await comment(domain, task.id, '（顺带：调度员没收到失败通知 —— ' + String((notified && (notified.message || notified.skipped)) || '未知原因') + '。需要人自己接手。）')
    }
    return notified
  }

  // v1.34：把 aggregator 暴露出去 —— 停机时要 flushAll（否则攒着的通知会静默丢掉），
  // 测试也要能主动把队列推出去（否则断言看不到投递）。
  /**
   * v1.39 交接消息（flow_message 的落点）。工人和调度之间只走这一条路：
   *   to=dispatcher → 包装成 worker.handoff 事件投给同车道调度；
   *   to=worker     → 有在跑的 run 就 steer；没有 run 就把消息注入下一轮案卷并重新派工
   *                   （待验收的卡先 rework 退回执行）。
   * 每次都记 message_log(kind=handoff)，onSessionEvent 用它判断"本轮汇报过"。
   */
  async function handoff(task, { to, content, from = null, kind = 'report' }) {
    if (!task) return { ok: false, message: 'unknown task' }
    if (domain.halted()) return { ok: false, skipped: 'halted', message: '调度已被手动停止' }
    const text = String(content || '').trim()
    const hash = Array.from(text).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)
    const key = 'msg:' + task.id + ':' + (from || '-') + ':' + to + ':' + hash
    if (domain.hasLogged(key)) return { ok: true, duplicate: true, message: '同一条消息已投递过' }
    const log = (extra) => domain.logMessage({ direction: 'out', origin: 'agent', kind: 'handoff', to, fromAgentId: from, taskId: task.id, dedupeKey: key, msgKind: kind, ...extra })
    if (to === 'dispatcher') {
      const r = await notifyDispatcher(task, '工人消息（' + kind + '）', 'handoff', { message: text, dedupeSuffix: hash, runId: task.activeRunId })
      log({ ok: !!(r && r.ok), sessionId: (r && r.sessionId) || null })
      return r && r.ok ? { ok: true, message: '已投递给调度员' } : { ok: false, message: (r && r.message) || '投递失败' }
    }
    if (to === 'grill') {
      const cur = store.state.tasks[task.id] || task
      const project = store.state.projects[task.projectId]
      const maxRounds = Number(project?.config?.grillMaxRounds) > 0 ? Number(project.config.grillMaxRounds) : 4
      const state = cur.grill || { rounds: 0 }
      if ((state.rounds || 0) >= maxRounds) return { ok: false, message: '评审已达轮数上限 ' + maxRounds + '，请直接给结论（flow_grill_verdict）' }
      const r = await deliverInjection(cur, { to: 'grill', kind: 'context', content: '【调度回复 ' + task.id + '】第 ' + ((state.rounds || 0) + 1) + '/' + maxRounds + ' 轮\n' + text })
      log({ ok: !!r.ok, sessionId: r.sessionId || null })
      return r
    }
    if (to === 'worker') {
      const cur = store.state.tasks[task.id]
      if (cur.activeRunId && cur.assignee) {
        const r = await runtime.steer(null, { agentId: cur.assignee, message: '【调度消息 ' + cur.id + '】' + text })
        log({ ok: !!r.ok })
        return r.ok ? { ok: true, message: '已插话给工人' } : r
      }
      await domain.inject(cur.id, { kind: 'context', content: '【调度消息】' + text }, { role: 'dispatcher', id: from || 'dispatcher' }).catch(() => null)
      let moved = cur
      if (cur.column === 'verifying') moved = await domain.move(cur.id, 'rework', { role: 'dispatcher', id: from || 'dispatcher' }, { reason: text.slice(0, 200) }).catch((err) => ({ error: err }))
      if (moved && moved.error) { log({ ok: false }); return { ok: false, message: '退回执行失败：' + String(moved.error.message || moved.error) } }
      if ((store.state.tasks[cur.id] || {}).column !== 'running') { log({ ok: false }); return { ok: false, message: '这张卡在 ' + cur.column + ' 列，不能直接派给工人；先推进到执行中' } }
      // rework 的 onMoved 已经派工过就不重复派
      const after = store.state.tasks[cur.id]
      const r = after.activeRunId ? { ok: true } : await dispatch(after)
      log({ ok: !!(r && r.ok) })
      return r && r.ok ? { ok: true, message: '已重新派工，消息随案卷送达' } : { ok: false, message: (r && r.message) || '派工失败' }
    }
    return { ok: false, message: '未知收件人：' + to }
  }

  /**
   * v1.39.2：启动对账里被认作"进程重启中断"的 run，也要播报给调度员。
   *
   * domain.recoverRuns() 在事务里把 running → interrupted 并清 activeRunId，
   * 但它只 emit 了一条 flow.recovered —— 那是给审计看的，调度员是 LLM 会话，
   * 收不到事务事件。线上"进程重启 7 次"就是这么静默过去的：卡回到待办等人
   * 重新派，没人知道上一轮为什么没了、要不要换个做法。
   *
   * 每张卡只发一条（按 runId 去重），失败不影响启动。
   */
  async function notifyRecovered(runIds) {
    const out = []
    for (const runId of runIds || []) {
      const run = (store.state.runs || {})[runId]
      if (!run) continue
      const task = store.state.tasks[run.taskId]
      if (!task) continue
      const notified = await notifyDispatcher(task, '进程重启，上一轮被中断，卡已回到待重新派工', 'recovered', { runId })
      out.push({ runId, taskId: run.taskId, ok: !!(notified && notified.ok) })
    }
    return out
  }

  return { listSkills, exposedSkills, deliverInjection, handoff, rollupParent, pendingDeps, grillStart, grillVerdict, dispatch, afterStop, awaitingApproval, notifyDispatcher, notifyRecovered, relayToOrigin, merge, softMerge, requestReview, reconcileMergeIntents, ensureWorktree, removeWorktree, gcWorktrees, openPr, onMoved, onStopped, onSessionEvent, startHeartbeat, stopHeartbeat, stopAllHeartbeats, watchEvents, steerSupervisor, aggregator, WATCHED }
}
