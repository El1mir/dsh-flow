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
import { statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { rename as fsRename, mkdir as fsMkdir, rm as fsRm, readdir as fsReaddir, chmod } from 'node:fs/promises'
import { createAggregator } from './aggregator.js'
import { classifyFailure } from './retry.js'
import { listSkills, exposedSkills, resolveSkill } from './skills.js'
import * as git from './git.js'
// v1.22：方案风险评估（自动批准分层）与远程 PR 建单都在这层用，之前漏了 import，
// 线上表现为 ReferenceError: assessPlanRisk is not defined（方案落库失败、卡被 block）。
import { assessPlanRisk, canAutoApprove } from './sync.js'
// v1.36：派工前磁盘余量门禁 + 合并后冒烟命令（受控执行）
import { checkFreeSpace, DEFAULT_MIN_FREE_BYTES } from './disk.js'
import { runCommand, postMergeCheckOf } from './exec.js'
import * as integration from './integration.js'
import { resolveTarget, integrationBranchOf, integrationBranchFor } from './deliver.js'
// C-11：子卡能不能并行，由 scope 决定（纯函数，不碰 git）。
import { canRunParallel, scratchBranchFor } from './units.js'
import { createPull, closePull } from './remote.js'
// v1.39：评审轮数上限等配置要用同一套默认值
import { withDefaults } from './domain.js'
// v1.29：内置提示词（不可被项目配置覆盖，但设置页只读展示）。
import { builtinWorkerRules, builtinDispatcherRules, criticalRules, commentRules, rulesAreInSystemPrompt, SYSTEM_RULES_POINTER } from './prompts.js'

const NL = String.fromCharCode(10)

/**
 * 默认**不共享**任何目录（ADR-0003）：依赖各装各的，由 install.commands 装。
 *
 * 曾经默认把 backend/.venv、node_modules 链进来，理由是「省一次安装」。这个理由被实测推翻了：
 * 链接会制造**假绿** —— 主仓的 .venv 里有 166 个包（含 pytest、2GB nvidia），
 * 而 requirements.txt 只有 128 行且**没有 pytest**，全新检出按声明装完反而 ModulesNotFound。
 * 工人的测试因此在别人的环境上跑，绿不绿与这次改动无关。
 *
 * 仍可 opt-in：项目 config.sharedDirs 显式列出**只读**目录（文档、样例数据），
 * 但 .venv / node_modules 这类会被写入的依赖目录不该出现在那里。
 */
/** 后到者最多等这么久（覆盖 addWorktree 在冷盘上的耗时，1.1s 量级）。 */
const WORKTREE_WAIT_MS = 10 * 1000

/** setup/install 的单条命令超时（uv/pnpm 在热 store 上 5–50s，留足余量）。 */
const DEFAULT_HOOK_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 建检出时默认要从主仓库拷进来的密文本（v0.016 / ticket 02）。
 * 只读拷贝：抄一份进去，永远不写回。项目可用 config.env.files 覆盖（空数组 = 不拷）。
 */
const DEFAULT_ENV_FILES = ['.env', '.env.local']

const DEFAULT_SHARED_DIRS = []

/**
 * 检出状态里「目录本身还能用」的那几种（C-08）。
 *
 * 注意这只是「目录能不能进」，不等于「能不能直接派工」——
 * blocked 的检出目录可能好端端躺在磁盘上，但上次 setup/install 没成功，
 * 直接复用它会让工人在一个没有依赖的目录里开工（半小时后以「模块找不到」失败，
 * 而且那一轮模型已经烧掉了）。所以复用分两级：directory-reusable 与 prepared。
 */
function isReusableWorktree(state) {
  return state === 'ready' || state === 'creating'
}

/** 上次准备（setup/install）挂在哪一步；挂在这里的状态要重新准备，而不是重建目录。 */
const REPREPARE_REASONS = new Set(['install-failed', 'setup-failed'])

function needsReprepare(rec) {
  return !!rec && !!rec.path && rec.state === 'blocked' && REPREPARE_REASONS.has(String(rec.stateReason || ''))
}

/**
 * 合并 blocked 的**契约类**原因：卡片自己（PR 快照 / 验收绑定 / 合并落点）与 git 的事实对不上。
 * 这一类重试没有意义，必须先改卡：重新开 PR（head 变了）或重新验收（绑定新的 head_sha）。
 *
 * 另一半是**环境类**（脏文件、分支被检出占着、缺基线提交、集成检出脏、推送失败…）：
 * 人把环境修好之后，**再合一次就应该成功** —— 那是唯一的恢复路径，所以守卫必须放行。
 *
 * 为什么用契约类黑名单，而不是环境类白名单（RETRYABLE_MERGE_REASONS）：
 * 环境原因是开放集合 —— blockMerge 会把 integration.ensure 的 reason（integ-dirty /
 * integ-not-detached / integ-diverged / integ-add-failed / base-missing …）和
 * mergeBranch / mergeInto 的 reason（repo-dirty / wrong-branch / no-branch / not-detached /
 * worktree-dirty …）**原样**记进 mergeReason。白名单漏一个，那张卡就永远焊死在合并列。
 * 契约类是封闭的小集合，写死更安全。
 *
 * 与 lib/merge-state.js 的 MERGE_REASON 是同一个枚举的两个视角：那边管「怎么说给人听」
 * （label / 配色 / 修复动作，归 C-03），这边管「能不能再试一次」。新增原因时两边都要看一眼，
 * 但本文件不改那张表。
 */
export const CONTRACT_MERGE_REASONS = new Set(['head-mismatch', 'not-merged'])

const comment = (domain, taskId, content) =>
  domain.comment(taskId, content, { role: 'system', id: 'system' }).catch(() => null)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function worktreePathFor(project, task) {
  const ws = project.workspacePath
  // 默认放在仓库外面：仓库里的未跟踪目录会把 git status 弄脏，挡住合并
  const root = (project.config && project.config.worktreeRoot) || join(dirname(ws), '.flow-worktrees', basename(ws))
  return join(root, String(task.id))
}

/** 隔离区根：与 worktree 同级（同一条规则，避免两处各算一次算错）。 */
export function quarantineRootFor(project) {
  const ws = project.workspacePath
  const root = (project.config && project.config.worktreeRoot) || join(dirname(ws), '.flow-worktrees', basename(ws))
  return join(root, '.quarantine')
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
    // C-10：子卡是**工作单元**，检出与分支都是父卡的。
    // 不说清楚，工人会顺手 git checkout -b 建一条自己的分支 —— 父卡检出就落在
    // 别的分支上，父分支拿不到提交，下一轮所有人对着错的工作区干活。
    extra.sharedUnit
      ? '这是**父卡 ' + task.parentId + ' 的工作单元**：工作目录与分支都是父卡的（分支 ' + (extra.branch || 'flow/' + task.parentId) + '）。'
        + '不要新建分支、不要切换分支（git branch / checkout / switch 一律别用）；改动直接用 commit 落在当前分支上。'
        + '子卡不合并、不开 PR —— 父卡收口时才对外交付。'
      : '',
    // C-11：并行子卡有自己的目录与一条**瞬时分枝**。不说清楚同样会出事 ——
    // 工人顺手 checkout -b，提交就落到一条验收时不会被合并的分支上（改动静默丢掉）。
    extra.parallelUnit
      ? '这是**父卡 ' + task.parentId + ' 的并行工作单元**（独立检出，分支 ' + (extra.branch || 'unit/' + task.parentId) + ' 是临时分支）。'
        + '不要新建分支、不要切换分支；改动直接用 commit 落在当前分支上。'
        + '子卡不合并、不开 PR —— 验收时系统会把这条临时分支合进父分支并删掉它。'
      : '',
    // 会话的 cwd 是项目工作区（这样会话才落在当前工作区里），
    // 但改动必须落在 worktree——不说清楚，工人会用相对路径改到主仓库。
    (!investigating && extra.worktree && workdir !== workspacePath)
      ? '注意：这个会话的当前目录是主工作区 ' + workspacePath + '，**不是**你要改的地方。所有读写与 git 命令都走绝对路径 ' + workdir + '（或先 cd 过去），用相对路径会改到主仓库、让合并直接失败。\n' +
        '另外：检出里**只有**版本库里的文件。被 .gitignore 的数据（.env、数据库、dist、样例数据）不在里面 —— 需要就按 install/setup 配置准备，别去主仓库读，那会让结果与这次改动无关。'
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
  // v0.016（ticket 03）：把上一轮的落地状态写进案卷。
  // 这些是**事实**（提交、改过哪些文件），不是模型的叙述——
  // 工人第一件事就是照着走，不用先花十分钟读历史。
  const handoff = extra.handoff !== undefined ? extra.handoff : (task.handoff || null)
  if (handoff && !investigating) {
    const lines2 = ['', '【上一轮停在哪】']
    if (Array.isArray(handoff.commits) && handoff.commits.length) {
      lines2.push('已完成（' + handoff.commits.length + ' 个提交）：')
      for (const c of handoff.commits) lines2.push('  · ' + (c.sha || '') + ' ' + (c.subject || ''))
    }
    if (Array.isArray(handoff.changedFiles) && handoff.changedFiles.length) {
      lines2.push('改过的文件：' + handoff.changedFiles.slice(0, 20).join('、') + (handoff.changedFiles.length > 20 ? ' 等 ' + handoff.changedFiles.length + ' 个' : ''))
    }
    if (handoff.next) lines2.push('上一轮留下的下一步：' + handoff.next)
    if (Array.isArray(handoff.open) && handoff.open.length) lines2.push('还没答的问题：' + handoff.open.join(' / '))
    if (handoff.avoidTry) lines2.push('上一轮失败的做法（**别重复**）：' + handoff.avoidTry)
    lines2.push('上面的事实已经落在分支上了：先确认现状，再接着做剩下的部分。')
    lines.push(...lines2)
  }
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
  // v0.006：需求评审工位报错/被打断。它与 grill.message 必须分开：一个是「评审说话了」，
  // 一个是「评审没说话了（这一轮的模型调用根本没成功）」，调度对这两件事的动作完全不同。
  "grill-failed": 'grill.failed',
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
    case 'grill.failed': return [
      '评审这一轮没有正常结束（模型报错 / 被中断），所以没有结论。卡上的 grill 状态已经被标成失败。',
      '想重开：修好环境后 flow_grill_start 再来一轮；草稿改了就先 flow_task_plan 更新方案。',
      '连续失败或本身不需要评审：跳过评审直接 flow_task_plan / flow_task_split，并在评论里说明为什么跳过。',
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
  else {
    // v0.015：内联规则只在「宿主不支持系统提示词」时才发。它必须**有上限** ——
    // 每一个事件包都带一份完整规则，包会一路长到聚合器的 6000 字上限之外，
    // 那一批事件就被整批丢成「更早的 N 条因长度省略」，调度什么都读不到（smoke 撞过）。
    // 最高优先级那段（criticalRules）始终放在包首，由调用处拼；这里只放「规范」部分。
    const full = [builtinDispatcherRules(), '', commentRules()].join(NL)
    const RULES_BUDGET = 1800
    extra.push('', full.length > RULES_BUDGET
      ? full.slice(0, RULES_BUDGET) + NL + '…（规则已截断；完整规范见设置页的提示词预览，或以系统提示词方式注入）'
      : full)
  }
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
      // v0.015：六问的完成度直接摆在包里 —— 缺的是「环境/人才能给的」还是「他没写清」，
      // 决定调度该 block 还是只要一条评论，而不是无脑再来一轮。
      ...(report.six ? [
        '六问: ' + ['problem', 'cause', 'impact', 'fix', 'regression', 'design'].filter((k) => report.six[k]).length + '/6'
          + '（' + String(report.six.problem || '问题未写').slice(0, 80) + '）'
          + (Array.isArray(report.sixMissing) && report.sixMissing.length ? ' · 缺 ' + report.sixMissing.join('、') : ''),
      ] : []),
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

/**
 * 外部 PR 的冲突解决包（rf-03）。
 *
 * 与普通卡的软合并包不同：别人的分支我们推不回去，也不能 rebase（会改写他的历史），
 * 所以做法是「在他那次提交之上，把 base 合进来，解掉冲突」——
 * 结果留在我们自己的一条本地分支上，由系统合进 base。
 */
export function buildExternalConflictPacket(task, external, conflict) {
  const files = (conflict.files || []).join(' / ') || '-'
  const number = external && external.number
  const branch = (external && external.resolver) || ('flow/' + task.id)
  return [
    '【外部 PR 合并冲突 ' + task.id + '】别人提的 PR #' + (number || '?') + ' 与我们当前 base 打架，需要你把冲突解掉。',
    '冲突文件：' + files,
    '',
    '【你的分支】' + branch,
    '它的起点是**外部 PR 的提交**（不是 base），系统已经替你建好检出，直接进去干活。',
    '',
    '【怎么做】',
    '1. 在你的工作目录里执行：git merge <base 分支>（不是 rebase！这条分支代表别人的提交，改写历史会丢东西）。',
    '2. 手工解决这些文件的冲突：' + files + '。保留双方意图：别人的功能不能删，我们的 base 改动也要在。',
    '3. git add -A && git commit 收尾。',
    '4. 不要 rebase、不要 force push、不要动 external/pr-' + (number || 'n') + ' 这条抓取分支。',
    '5. 解决完 flow_task_move(action="stop", …) 结束本轮 —— 系统会自动重新合并并关掉远程 PR。',
    '6. 解不掉就 flow_task_move(action="block", reason="…") 说明卡在哪一行。',
  ].join(String.fromCharCode(10))
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
  /**
   * C-10：父检出租约（unit:<parentId>）的 TTL。
   *
   * 为什么不直接用 WORKTREE_LOCK_TTL（30 秒）：那是「建检出」这种秒级临界区的锁。
   * 这里的锁要活到**这一轮跑完**（几十分钟很常见），而续租只在心跳里做（60 秒一拍）——
   * 30 秒的租约会在两拍之间过期，兄弟子卡于是合法地闯进同一个目录（同目录并发是静默覆盖，
   * 一方以为保存成功）。10 分钟留足余量；run 结束不再续租，租约随后自然过期，
   * 所以它永远是一条「最多挡这么久」的串行带，而不是死锁。
   */
  const UNIT_LEASE_MS = 10 * 60 * 1000

  /** 续一次共享检出的父租约（同一个 owner 的 acquire 就是续租，见 domain.lockUnit）。 */
  async function renewUnitLease(runId) {
    const runs = store.state.runs || {}
    const run = runs[runId]
    const tasks = store.state.tasks || {}
    const taskId = (run && run.taskId) || Object.keys(tasks).find((id) => tasks[id].activeRunId === runId) || null
    const task = taskId ? tasks[taskId] : null
    if (!task || !task.parentId || task.unitMode === 'legacy-branch') return null
    return await domain.lockUnit(task.parentId, task.id, UNIT_LEASE_MS).catch(() => null)
  }

  function startHeartbeat(runId) {
    if (!runId || heartbeatTimers.has(runId)) return
    const timer = setInterval(() => {
      domain.heartbeat(runId).then((res) => {
        // run 已经结束（或不存在）→ 自行停表，别对着跑完的 run 一直写盘
        if (!res || res.ok === false) { stopHeartbeat(runId); return }
        // C-10：子卡的父检出租约跟着 run 一起续，否则长任务跑到一半串行就失效了。
        renewUnitLease(runId)
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

  /**
   * 建（或复用）任务检出（ADR-0006 §2 / I-07）。
   *
   * 这一版最重要的不是"加了锁"，而是**删掉了降级到主检出的分支**。原来 addWorktree 失败时
   * 返回 `{ path: repo }`，调用方照旧派工 —— 工人就落在人的检出里干活（T-043 的 run_037 是真实事故）。
   * 现在的语义分三类：
   *
   *   ok        拿到独立检出
   *   degraded  这个项目**根本不需要**检出（非 git 工作区 / 仓库还没有基线提交），在项目工作区干活是对的
   *   fatal     本该有检出但建不出来（磁盘、分支被占、git 报错）—— 调用方必须停下，不能派工
   *
   * degraded 与 fatal 分开是这一版的全部要点：以前它们被同一个 `ok:false` 表达，于是"环境坏了"
   * 与"不需要"走到了同一条兜底路径上，而那条兜底路径就是主检出。
   */
  /**
   * 跑项目配置里的 setup / install 命令（ADR-0003）。
   *
   * 边界与 postMergeCheck 一样：**只有显式配置才跑**，每条命令有超时，cwd 固定是这个检出。
   * 与 postMergeCheck 不同的是失败语义 —— 那边是「合并后冒烟没过」，这边是「这一轮根本没法开工」。
   * 命令可以是字符串或字符串数组；数组**按序**执行，第一条失败就停。
   */
  async function runHooks(project, hook, dir) {
    const cfg = (project && project.config && project.config[hook]) || null
    const raw = cfg && Array.isArray(cfg.commands) ? cfg.commands : (cfg && typeof cfg.commands === 'string' ? [cfg.commands] : [])
    const commands = raw.map((c) => String(c || '').trim()).filter(Boolean)
    if (!commands.length) return { ok: true, skipped: 'no-commands' }
    const timeoutMs = Number(cfg.timeoutMs) || DEFAULT_HOOK_TIMEOUT_MS
    const ran = []
    for (const command of commands) {
      const res = await runCommand({ command, cwd: dir, timeoutMs })
      ran.push({ command, ok: !!(res && res.ok), code: (res && res.code) != null ? res.code : null })
      if (!res || !res.ok) {
        const tailOut = String((res && (res.stderr || res.stdout)) || '').trim().split(/\r?\n/).slice(-5).join(' | ')
        return { ok: false, hook, command, commands: ran, message: (res && res.timedOut ? '超时 ' + timeoutMs + 'ms' : '退出码 ' + ((res && res.code) != null ? res.code : '?')) + (tailOut ? '：' + tailOut.slice(0, 400) : '') }
      }
    }
    return { ok: true, hook, commands: ran }
  }
  /**
   * 在一个已经建好的检出里做「准备」：共享目录 + setup + install（C-08 抽出来的）。
   *
   * 为什么抽出来：以前这套只在**新建**检出时跑一次，而 blocked（install-failed）的检出
   * 下次会被「复用」判据放过去 —— 工人拿到的就是一个没装成依赖的目录。
   * 现在新建、复用、重修三条路都走同一段准备逻辑，成功与否只有一个判据：这里返回 ok。
   */
  /**
   * 把主仓库里的密文本拷进检出（v0.016 / ticket 02）。
   *
   * 为什么必须拷：`.env` 这类文件被 .gitignore 忽略，检出里天生没有；而验收又常要求「真实跑通」，
   * 于是「API key 不正确 / 服务不可达」被当成内容失败，一轮轮返工（BiliNote 的 200105 就是这么来的）。
   *
   * 为什么这不违反 ADR-0003：ADR 拒绝共享的是**依赖目录**（运行期可写、包集合可能与声明不一致，
   * 会造成假绿）；密文本是只读配置，方向相反 —— 缺了它，工人只能靠猜。
   *
   * 边界：
   * - 只从 `<repo>/<name>` 拷到 `<检出>/<name>`，不许绝对路径、不许 `..`（防越界写）。
   * - 目标已存在就跳过（人可能已在检出里放了自己的版本）。
   * - 源不存在记为 missing，**不阻断**建检出 —— 缺密文是环境问题，该在案卷与请示里说清楚，
   *   而不是让工人拿不到工作区。
   * - 拷完尽量置只读（chmod 444），失败就忽略：这是软保证，真正的保证是永不写回源。
   */
  async function copyEnvFiles(project, dir) {
    const cfg = (project && project.config && project.config.env) || null
    const raw = cfg ? (Array.isArray(cfg.files) ? cfg.files : []) : DEFAULT_ENV_FILES
    const names = raw.map((x) => String(x || '').trim()).filter(Boolean)
    if (!names.length) return { copied: [], missing: [], skipped: [] }
    const copied = []
    const missing = []
    const skipped = []
    for (const name of names) {
      const clean = name.replace(/\\/g, '/')
      if (clean.startsWith('/') || clean.split('/').indexOf('..') >= 0) { missing.push(clean); continue }
      const src = join(project.workspacePath, clean)
      const dst = join(dir, clean)
      if (existsSync(dst)) { skipped.push(clean); continue }
      if (!existsSync(src)) { missing.push(clean); continue }
      try {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
        await chmod(dst, 0o444).catch(() => null)
        copied.push(clean)
      } catch (err) {
        missing.push(clean + '（' + String((err && err.message) || err).slice(0, 80) + '）')
      }
    }
    return { copied, missing, skipped }
  }

  async function prepareWorktree(task, project, dir) {
    const sharedDirs = (project.config && Array.isArray(project.config.sharedDirs)) ? project.config.sharedDirs : DEFAULT_SHARED_DIRS
    const linked = sharedDirs.length ? await git.linkSharedDirs({ repo: project.workspacePath, worktree: dir, dirs: sharedDirs }).catch(() => null) : null
    // v0.016（ticket 02）：先把密文本拷进来。
    // 顺序放在 setup 之前：安装脚本经常要读 .env（比如 `uv pip install -r requirements.txt` 之后跑迁移）。
    const envRes = await copyEnvFiles(project, dir)
    // setup 放在 install 之前：安装脚本经常要读 .env / 本地目录。
    const setup = await runHooks(project, 'setup', dir)
    const install = setup.ok ? await runHooks(project, 'install', dir) : { ok: false, skipped: 'setup-failed' }
    const shared = (linked && linked.linked) ? linked.linked : []
    if (!setup.ok) return { ok: false, phase: 'setup', linked: shared, env: envRes, message: setup.message || 'unknown' }
    if (!install.ok) return { ok: false, phase: 'install', linked: shared, env: envRes, message: install.message || 'unknown' }
    return { ok: true, linked: shared, env: envRes }
  }

  /**
   * 这张卡的分支该从哪条基线拉（C-05 / rf-01）。
   *
   * 优先级：父分支（子卡）→ 项目 baseBranch → 自动探测。
   * 子卡从父分支拉是 rf-01 的核心：父分支是集成点，子卡的产出先落那儿，
   * 父卡收口时再一次性合进 base（对外只有一个 PR）。
   */
  async function baseRefFor(task, project, repo) {
    // rf-03 / 外部 PR 冲突：工人要在一个**以 PR 提交为起点**的分支上解冲突。
    // 起点是 ext.baseRef（external/pr-<n>），不是 base —— 从 base 拉会把别人的改动整段丢掉，
    // 那样「解决冲突」就变成了「重新实现一遍」。
    const extBase = task && task.external && task.external.baseRef
    if (extBase) {
      const target = branchFor(task)
      const made = await git.materializeBranch(repo, { branch: target, base: extBase })
      if (made.ok) return { ref: extBase, kind: 'external', created: made.created === true }
      return { ref: (project.config && project.config.baseBranch) || (await git.defaultBranch(repo)), kind: 'base', warning: made.reason }
    }
    const parentBranch = task && task.branchFrom
    if (parentBranch) {
      // 父分支可能还没被 materialize（父卡还没派过工）。这里补一次，
      // 而不是让 addWorktree 静默退回 HEAD —— 那会让子卡从错误的基线上拉出来。
      const made = await git.materializeBranch(repo, { branch: parentBranch, base: (project.config && project.config.baseBranch) || (await git.defaultBranch(repo)) })
      if (made.ok) return { ref: parentBranch, kind: 'parent', created: made.created === true }
      return { ref: (project.config && project.config.baseBranch) || (await git.defaultBranch(repo)), kind: 'base', warning: made.reason }
    }
    return { ref: (project.config && project.config.baseBranch) || (await git.defaultBranch(repo)), kind: 'base' }
  }

  /**
   * 把上一轮的审核结论清掉（回到「还没审」）。
   *
   * 什么时候需要：分支头变了（rebase 之后、冲突解决之后）。审核绑的是**具体那个 head**，
   * 新旧混用等于「审过 A 却合了 B」。不清的话卡会卡死在合并列：
   * merge() 的 reviewGate 见到非 approved 直接拒，
   * scheduler 见到 reviewVerdict 有值就不再请重新审核（scheduler.js:451），autoMerge 也跳过 ——
   * 三重门都关着，只能等人手动重审。
   */
  async function clearReviewVerdict(taskId) {
    await store.tx((s) => {
      const cur = s.tasks[taskId]
      const mr = cur && cur.mergeRequest
      if (mr && mr.reviewVerdict != null) {
        cur.mergeRequest = { ...mr, reviewVerdict: null, reviewEvidence: null }
        if (mr.id && s.merge_requests && s.merge_requests[mr.id]) {
          s.merge_requests[mr.id] = { ...s.merge_requests[mr.id], reviewVerdict: null, reviewEvidence: null }
        }
      }
    }).catch(() => null)
  }
  /** 准备失败的统一收尾：标 blocked/install-failed、写评论、阻塞卡片、返回 fatal。 */
  async function failPrepare(task, dir, res) {
    const why = '检出准备（' + res.phase + '）失败：' + res.message
    await domain.setWorktreeState(task.id, { state: 'blocked', reason: 'install-failed', detail: { phase: res.phase, dir, why } }, { role: 'system' }).catch(() => null)
    await comment(domain, task.id, why + '。这个检出**没有**可用的依赖，所以这一轮不派工（不降级到主检出；修好 setup/install 后重新派工会复用同目录重跑准备）。')
    await domain.block(task.id, why, { role: 'system' }).catch(() => null)
    return { ok: false, fatal: true, path: dir, reason: 'install-failed', message: why }
  }

  async function ensureWorktree(task, project) {
    // v0.008（C-10）：子卡与父卡**共用**一个检出、一条分支 —— 一条分支只有一个检出，
    // 这是 git 的硬约束，不是选择。子卡不再 branchFor / addWorktree / materializeBranch。
    //
    // legacy-branch 是迁移给「有父卡且已有自己分支」的老卡打的标记（线上 5 张）：
    // 它们仍走下面一卡一分支的老路径，好在 accept 时把分支合进父分支收尾，
    // 而不是被新规则卡死。
    if (task.parentId && task.unitMode !== 'legacy-branch') return await ensureUnitWorktree(task, project)
    const existing = domain.worktreeOf(task.id)
    // C-08：只有 ready/creating 才算「可以进」。
    // 以前这里除了 blocked-delete/quarantined 一律复用 —— 而 blocked 恰恰表达「上次没准备好」，
    // 复用它等于把工人送进一个没有依赖的目录（这正是 ensureWorktree 注释里说要避免的那件事）。
    if (existing && existing.path && isReusableWorktree(existing.state)) {
      // v0.016（ticket 02）：复用也要补拷一次密文本。便宜、幂等，而且主仓库的 .env
      // 经常是检出建好**之后**才补上的（线上 BiliNote 就是这样：检出一直在，.env 一直缺）。
      const envRes = await copyEnvFiles(project, existing.path).catch(() => null)
      return { ok: true, path: existing.path, branch: existing.branch, reused: true, baseSha: existing.baseSha, env: envRes }
    }
    const repo = project && project.workspacePath
    if (!repo) return { ok: false, degraded: true, state: 'none', path: null, message: '项目没有工作区路径' }
    // v1.36：建 worktree 之前先看盘（ework 的 ENOSPC 事故闸门）。
    // 盘满时工人表现得像「莫名其妙失败」，原因藏在会话里；这里提前拦住并写清原因。
    const disk = await checkFreeSpace(repo, (project.config && project.config.minFreeBytes) || DEFAULT_MIN_FREE_BYTES)
    if (!disk.ok) {
      await comment(domain, task.id, disk.reason + '。清理后重新派工。')
      await domain.block(task.id, disk.reason, { role: 'system' })
      return { ok: false, fatal: true, path: null, message: disk.reason, disk }
    }
    if (!(await git.isRepo(repo))) {
      // 非 git 工作区是**正常的**支持路径，不是错误：显式记 none，让人一眼看出
      // "这张卡没有检出"是这个项目的事实，而不是某次建失败。
      await domain.setWorktreeState(task.id, { state: 'none', reason: 'not-a-repo' }, { role: 'system' }).catch(() => null)
      return { ok: false, degraded: true, state: 'none', path: repo, message: '工作区不是 git 仓库，改动直接落在工作区' }
    }

    // ---- 锁内判断（ADR-0006 §2）-------------------------------------------------
    // 锁的 key 是**卡**而不是仓库：两张不同的卡当然可以同时建各自的检出。
    // 抢不到锁说明另一个调用者正在这张卡上做同一件事 —— 等它做完，再看它留下的结果。
    // 抢不到锁就**等**：后到者等的不是"随机的 300ms"，而是"前一个调用者把结果落进登记表"。
    // 早先只等三次（~0.9s），而 addWorktree 在冷盘上要 1.1s —— 后到者于是直接报 busy，
    // 而它等的那个结果其实马上就要可见了。上限 10s：超过这个时间说明锁是崩溃残留。
    let lease = null
    const waitUntil = Date.now() + WORKTREE_WAIT_MS
    for (;;) {
      lease = await domain.lockWorktree(task.id).catch(() => ({ ok: false, reason: 'lock-failed' }))
      if (lease.ok) break
      const now = domain.worktreeOf(task.id)
      // C-08：等的第一优先是「别人已经准备好了一个可用的目录」，不是「别人写了条记录」。
      if (now && now.path && isReusableWorktree(now.state)) return { ok: true, path: now.path, branch: now.branch, reused: true, baseSha: now.baseSha }
      // 租约已经消失（上一个调用者解锁了）→ 立刻重试，不要空等满一个间隔。
      const still = domain.worktreeLeaseOf(task.id)
      if (!still || still.expiresAt <= Date.now()) continue
      if (Date.now() >= waitUntil) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!lease || !lease.ok) {
      // 拿不到锁：可能是别人正在建，也可能是残留锁。
      // 无论哪种，**这里绝不去 add** —— 重复 add 才是要修的病。
      const now = domain.worktreeOf(task.id)
      if (now && now.path && isReusableWorktree(now.state)) return { ok: true, path: now.path, branch: now.branch, reused: true, baseSha: now.baseSha }
      return { ok: false, fatal: true, busy: true, path: null, message: '另一个调用者正在为这张卡建检出（' + ((lease && lease.reason) || 'lock failed') + '）' }
    }
    try {
      const list = await git.listWorktrees(repo)
      const dir = worktreePathFor(project, task)
      const branch = branchFor(task)
      const adopt = git.findWorktree(list, dir)

      // C-08：blocked 但目录还在、原因是准备失败 → **不重建目录**（重建要重装一遍依赖，
      // 那是 30 分钟），就地重跑准备。成功的条件是准备真的过了，不是目录存在。
      if (existing && existing.path && needsReprepare(existing)) {
        await domain.setWorktreeState(task.id, { state: 'creating', reason: 'reprepare' }, { role: 'system' }).catch(() => null)
        const res = await prepareWorktree(task, project, existing.path)
        if (!res.ok) return await failPrepare(task, existing.path, res)
        await domain.setWorktreeState(task.id, { state: 'ready', reason: null }, { role: 'system' }).catch(() => null)
        await comment(domain, task.id, '重新跑了一遍检出准备（setup/install），通过；复用 ' + existing.path)
        return { ok: true, path: existing.path, branch: existing.branch, reused: true, baseSha: existing.baseSha }
      }

      if (adopt) {
        // 拿到锁之后**必须重读 git**：不重读的话，"登记表里没有"会被当成"git 里也没有"，
        // 而这两件事在双派现场是不同步的（T-043：add 成功、登记未写）。
        await domain.recordWorktree(task.id, { path: adopt.path, branch: adopt.branch || branch, baseSha: adopt.head || null, state: 'creating', sharedDirs: [] })
        await comment(domain, task.id, '复用了已经在磁盘上的检出 ' + adopt.path + '（登记表曾经落后于 git）')
        const res = await prepareWorktree(task, project, adopt.path)
        if (!res.ok) return await failPrepare(task, adopt.path, res)
        await domain.setWorktreeState(task.id, { state: 'ready', reason: null }, { role: 'system' }).catch(() => null)
        return { ok: true, path: adopt.path, branch: adopt.branch || branch, reused: true, baseSha: adopt.head || null }
      }
      const occupied = list.find((w) => !w.bare && w.branch === branch)
      if (occupied) {
        // 分支被**别的目录**占着。可能是幽灵检出（目录没了但 git 还有条目），也可能是
        // 上一次清理失败留下的现场。两种情况都不能 add（git 会 fatal），也不该偷偷 -B 重置
        // 别人的分支 —— 那是销毁证据。停下来，让人决定。
        const why = '分支 ' + branch + ' 已被另一个检出占用：' + occupied.path + '（' + (occupied.locked ? '已锁定' : '未锁定') + '）'
        await domain.setWorktreeState(task.id, { state: 'blocked', reason: 'branch-busy', detail: { path: occupied.path, branch } }, { role: 'system' }).catch(() => null)
        await comment(domain, task.id, '建检出失败：' + why + '。清理那个检出（或确认它没在用）后再派工。')
        await domain.block(task.id, why, { role: 'system' }).catch(() => null)
        return { ok: false, fatal: true, path: null, reason: 'branch-busy', message: why }
      }

      // 先写意图再动手：崩溃在 add 中途时，下一次派工能看出"上一轮走到哪一步了"。
      await domain.setWorktreeState(task.id, { state: 'creating', reason: null }, { role: 'system' }).catch(() => null)
      const baseRef = await baseRefFor(task, project, repo)
      if (baseRef.warning) await comment(domain, task.id, '父分支 ' + String(task.branchFrom) + ' 还不存在（' + baseRef.warning + '），这次从 ' + baseRef.ref + ' 拉分支')
      const made = await git.addWorktree({ repo, dir, branch, base: baseRef.ref })
      if (!made.ok) {
        // no-commits 不是"这个项目不支持 git"，而是"这个仓库还一次提交都没有"：
        // worktree 共享对象库，没有基线就没有可检出的内容。这是 degraded，不是 fatal ——
        // 补一次基线提交之后下次派工就能自动恢复。
        if (made.reason === 'no-commits') {
          await domain.setWorktreeState(task.id, { state: 'none', reason: 'no-commits' }, { role: 'system' }).catch(() => null)
          const why = made.message + '。' + (made.hint || '')
          await comment(domain, task.id, '这一轮先在工作区动手：' + why)
          return { ok: false, degraded: true, state: 'none', noCommits: true, path: null, message: why, hint: made.hint || '' }
        }
        const why = String(made.reason || made.message || 'worktree 失败').slice(0, 500)
        await domain.setWorktreeState(task.id, { state: 'blocked', reason: 'create-failed', detail: { dir, branch, why } }, { role: 'system' }).catch(() => null)
        await comment(domain, task.id, '建检出失败，这一轮不派工（不会退回到主检出）：' + why)
        return { ok: false, fatal: true, path: null, reason: 'create-failed', message: why }
      }
      // C-08：目录建出来 ≠ 能用。先记 creating（崩溃在这里能看出"建了但没准备好"），
      // 准备真的过了再写 ready —— 判据只有一条：「state === ready」等于「可以派工」。
      await domain.recordWorktree(task.id, { path: made.path, branch: made.branch, baseSha: made.headSha || null, state: 'creating', sharedDirs: [] })
      const res = await prepareWorktree(task, project, made.path)
      if (!res.ok) return await failPrepare(task, made.path, res)
      await domain.recordWorktree(task.id, { path: made.path, branch: made.branch, baseSha: made.headSha || null, state: 'ready', sharedDirs: res.linked })
      const linkNote = res.linked && res.linked.length ? '；已共享目录 ' + res.linked.join('、') : ''
      // v0.016（ticket 02）：告诉人这轮拷了什么、缺了什么。
      // 缺密文不定为失败（缺的是环境，不是代码），但必须留痕 —— 否则下一轮又会在同一个地方返工。
      const env = res.env || {}
      const envNote = (env.copied && env.copied.length) ? '；已拷密文 ' + env.copied.join('、') : ''
      const envWarn = (env.missing && env.missing.length) ? '；**缺** ' + env.missing.join('、') + '（工人可能因此无法真实跑通，先补到主仓库再派工）' : ''
      await comment(domain, task.id, '已建 worktree ' + made.path + '（分支 ' + made.branch + '，base ' + (made.base || '') + '）' + linkNote + envNote + envWarn)
      return { ok: true, path: made.path, branch: made.branch, baseSha: made.headSha || null }
    } finally {
      await domain.unlockWorktree(task.id, lease.token).catch(() => null)
    }
  }

  /**
   * C-11：子卡的检出 —— 三条规则，按顺序判：
   *
   *   1) 有在跑的兄弟且**与它互斥** → 不并行：沿用 v0.009 的共用父检出 + unit:<parentId> 租约；
   *   2) 有在跑的兄弟且**都不互斥** → 并行：各给一条瞬时分枝 + 自己的检出；
   *   3) **没有任何在跑的兄弟** → 不并行：这时候并行只是多装一次依赖、多留一条临时分支，
   *      一点收益都没有 —— 并行的钱只在**真要同时干两件事**时付。
   *
   * 为什么不能一律共用（v0.009 的做法）：共用父检出就必然串行 —— 一条分支同一时刻只能被
   * 一个检出持有，那是 git 的物理约束，不是调度偏好。两张改不相干文件的子卡排队等对方验收，
   * 纯属白等。反过来，没人跟你抢的时候去并行，也纯属白付。
   *
   * 规则 3 落在 dispatch 这一侧（多了 runningSiblings.length > 0 一道），因为
   * canRunParallel 的语义只有「与在跑的兄弟互不互斥」——「现在有没有必要并行」是调度策略，
   * 混进那个纯判据会让它答非所问（票里那三条纯判据也钉不住）。
   *
   * project.config.unitParallel === false 是逃生阀（回到全串行）。默认 true 不写进默认表：
   * 配置项清单归 domain，这里只按「没有显式关掉就是开」读。
   */
  async function ensureUnitWorktree(task, project) {
    const parent = store.state.tasks[task.parentId]
    if (!parent) return { ok: false, fatal: true, degraded: false, path: null, message: '父卡不存在：' + String(task.parentId) + '，子卡没有可用的检出' }
    // 只允许两层：父卡自己也是子卡时，「谁的分支」无解 —— 不许往上再找。
    if (parent.parentId) return { ok: false, fatal: true, degraded: false, path: null, message: '父卡自己也是子卡（只允许两层），拒绝共用检出' }
    const repo = project && project.workspacePath
    if (!repo) return { ok: false, degraded: true, state: 'none', path: null, message: '项目没有工作区路径' }
    const parallelOn = !(project.config && project.config.unitParallel === false)
    const runningSiblings = runningSiblingsOf(task)
    // 规则 3 就在这里：没有兄弟在跑时 runningSiblings 为空，
    // canRunParallel 恒 true（没人撞车），但那不是「需要并行」。
    if (parallelOn && runningSiblings.length > 0 && canRunParallel(task, runningSiblings)) {
      const parallel = await ensureParallelWorktree(task, project, parent)
      // null = 这条路这一轮走不了（父分支建不出来 / 瞬时分枝被别的检出占着）。
      // 退回共用检出是**降级成串行**，不是降级到没有依赖的目录：下面的准备判据一条不少。
      if (parallel) return parallel
    }
    return await ensureSharedUnitWorktree(task, project, parent)
  }

  /**
   * 同父卡、**正在跑**的其它子卡（C-11 的互斥判据只看它们）。
   *
   * 不看排队的：那张到它派工时也会重算一次，所以不会漏判；
   * 而整批一起判会把「有一对冲突」放大成「全部串行」—— 那正是 v0.009 的退化。
   */
  function runningSiblingsOf(task) {
    const parentId = task && task.parentId
    if (!parentId) return []
    return Object.values(store.state.tasks).filter((t) => t && t.id !== task.id && t.parentId === parentId && (!!t.activeRunId || t.column === 'running'))
  }

  /**
   * C-11：非互斥子卡的独立检出 —— 一条瞬时分枝 + 一个自己的目录。
   *
   * 为什么必须有分支：一条分支同一时刻只能被一个检出持有。要并行就得有第二个 HEAD，
   * 而 HEAD 只能是某条分支。所以并行不是「不用分支」，而是「用一条只活到验收的临时分支」。
   *
   * 起点是**父分支的 sha**，绝不去 checkout 父分支：父卡自己可能正占着 flow/<parentId>
   * 的检出（线上 T-048 就是），第二个检出去 checkout 它必然被 git 拒。所以先 materialize
   * 父分支（没有就从 base 建），再以它为 base 拉瞬时分枝 —— 开工前父分支是什么样，就是什么样。
   */
  async function ensureParallelWorktree(task, project, parent) {
    const repo = project.workspacePath
    const parentBranch = integrationBranchOf(parent.id)
    const branch = scratchBranchFor(parent.id, task.id)
    const dir = worktreePathFor(project, task)
    // 复用上一次没收拾干净的现场：分支与目录都对得上就直接用（setup/install 不必重跑）。
    const existing = domain.worktreeOf(task.id)
    if (existing && existing.path && existing.branch === branch && isReusableWorktree(existing.state)) {
      return { ok: true, path: existing.path, branch, reused: true, baseSha: existing.baseSha, parallel: true, parentId: parent.id }
    }
    const baseBranch = (project.config && project.config.baseBranch) || (await git.defaultBranch(repo))
    const madeParent = await git.materializeBranch(repo, { branch: parentBranch, base: baseBranch })
    if (!madeParent.ok) {
      await comment(domain, task.id, '这张子卡本可以并行（与在跑的兄弟 scope 不重叠），但父分支 ' + parentBranch + ' 还没建出来（' + String(madeParent.reason || 'unknown') + '）：这一轮改走父卡检出的串行路径。')
      return null
    }
    // 与普通检出同一把锁（key 是**卡**）：同一张卡的并发派工只能有一个在建。
    const lease = await domain.lockWorktree(task.id).catch(() => ({ ok: false }))
    if (!lease || !lease.ok) {
      const now = domain.worktreeOf(task.id)
      if (now && now.path && now.branch === branch && isReusableWorktree(now.state)) {
        return { ok: true, path: now.path, branch, reused: true, baseSha: now.baseSha, parallel: true, parentId: parent.id }
      }
      return { ok: false, fatal: true, busy: true, path: null, message: '另一个调用者正在为这张卡建检出（' + ((lease && lease.reason) || 'lock failed') + '）' }
    }
    try {
      // 盘满时的现场最难查（工人表现为「莫名其妙失败」）—— 与普通检出同一道闸。
      const disk = await checkFreeSpace(repo, (project.config && project.config.minFreeBytes) || DEFAULT_MIN_FREE_BYTES)
      if (!disk.ok) {
        await comment(domain, task.id, disk.reason + '。清理后重新派工。')
        await domain.block(task.id, disk.reason, { role: 'system' })
        return { ok: false, fatal: true, path: null, message: disk.reason, disk }
      }
      await domain.setWorktreeState(task.id, { state: 'creating', reason: null }, { role: 'system' }).catch(() => null)
      const made = await git.addWorktree({ repo, dir, branch, base: parentBranch })
      if (!made.ok) {
        // 与普通路径同语义：no-commits 是「仓库还没有基线」的 degraded，其余是 fatal。
        if (made.reason === 'no-commits') {
          await domain.setWorktreeState(task.id, { state: 'none', reason: 'no-commits' }, { role: 'system' }).catch(() => null)
          return { ok: false, degraded: true, state: 'none', noCommits: true, path: null, message: made.message, hint: made.hint || '' }
        }
        const why = String(made.reason || made.message || 'worktree 失败').slice(0, 500)
        await domain.setWorktreeState(task.id, { state: 'blocked', reason: 'create-failed', detail: { dir, branch, why } }, { role: 'system' }).catch(() => null)
        await comment(domain, task.id, '并行检出建失败，这一轮不派工（不会退回到主检出）：' + why)
        return { ok: false, fatal: true, path: null, reason: 'create-failed', message: why }
      }
      // 与普通检出同一套准备（sharedDirs / setup / install）。失败**不降级**：
      // 把一个没装依赖的目录派出去，半小时后以「模块找不到」失败，那一轮模型全烧掉。
      await domain.recordWorktree(task.id, { path: dir, branch, baseSha: made.headSha || null, state: 'creating', sharedDirs: [] })
      const res = await prepareWorktree(task, project, dir)
      if (!res.ok) return await failPrepare(task, dir, res)
      const startSha = await git.headSha(dir).catch(() => made.headSha || null)
      await domain.recordWorktree(task.id, { path: dir, branch, baseSha: startSha, state: 'ready', sharedDirs: res.linked, parentId: parent.id })
      await domain.setUnitStartSha(task.id, startSha).catch(() => null)
      // unitMode 是**投影字段**（看板 / 验收分叉用），没有专门的写入口：与 C-10 的 shared 一样
      // 直接落在卡上，验收时一眼看出该走哪条收尾路径。
      await store.tx((s) => { const cur = s.tasks[task.id]; if (cur) cur.unitMode = 'parallel' }).catch(() => null)
      await domain.setMergeState(task.id, { state: 'none', reason: null, humanReason: '改动在瞬时分枝 ' + branch + '，验收时合进父分支 ' + parentBranch }, { role: 'system', id: 'system:unit' }).catch(() => null)
      const linkNote = res.linked && res.linked.length ? '；已共享目录 ' + res.linked.join('、') : ''
      await comment(domain, task.id, '并行子卡：已建独立检出 ' + dir + '（瞬时分枝 ' + branch + '，从 ' + parentBranch + ' 拉出）' + linkNote + '。验收时合进父分支并删掉这条分支。')
      return { ok: true, path: dir, branch, baseSha: startSha, parallel: true, parentId: parent.id }
    } finally {
      await domain.unlockWorktree(task.id, lease.token).catch(() => null)
    }
  }

  /**
   * v0.008（C-10）：互斥子卡的检出 **就是父卡的检出**（共用目录 + 共用分支）。
   *
   * 子卡只在登记表里留一条**只读投影** { path, branch, shared: true, parentId }：
   * 它只用来「验收时查工作区干净吗 / 取 HEAD」，不参与回收（回收跟着父卡走）。
   *
   * 串行用租约 unit:<parentId> 表达（见 domain.lockUnit）：抢不到就返回
   * { ok:true, waiting:true }，调用方把卡留在 running + phase='waiting-branch'，
   * 下一拍再试 —— 两个子卡在同一个目录里改同一份工作区，`git index.lock` 与
   * 工作区互覆盖都是**静默**的（一方以为保存成功），那是正确性问题。
   */
  async function ensureSharedUnitWorktree(task, project, parent) {
    // 父卡检出先就位：复用 ensureWorktree 的全套判据（磁盘余量、锁、setup/install），
    // 不为子卡另开一套 —— 那套判据是几次线上事故换来的。
    const pw = await ensureWorktree(parent, project)
    if (!pw.ok) return { ...pw, shared: true }
    const dir = pw.path
    const branch = pw.branch || branchFor(parent)
    // ---- 独占父检出：同一父卡下同一时刻只允许一个子卡在跑 ----
    const leaseOf = () => domain.unitLeaseOf(parent.id) || null
    let lease = await domain.lockUnit(parent.id, task.id, UNIT_LEASE_MS).catch(() => ({ ok: false }))
    if (!lease.ok) {
      // 持锁方已经不在这条流水线上了（done/cancelled/blocked）→ 它不会再来释放，接管。
      const holderId = String((leaseOf() || {}).owner || '').replace(/^unit:/, '')
      const holder = holderId ? store.state.tasks[holderId] : null
      if (holder && (holder.blocked || ['done', 'cancelled'].includes(holder.column))) {
        await domain.releaseUnitLease(parent.id, holder.id).catch(() => null)
        lease = await domain.lockUnit(parent.id, task.id, UNIT_LEASE_MS).catch(() => ({ ok: false }))
      }
    }
    if (!lease.ok) {
      return {
        ok: true, waiting: true, shared: true, path: dir, branch,
        message: '父卡检出正被另一个子卡占用（' + String((leaseOf() || {}).owner || 'unknown') + '）',
      }
    }
    const startSha = await git.headSha(dir).catch(() => null)
    await domain.recordWorktree(task.id, { path: dir, branch, baseSha: startSha, state: 'ready', shared: true, parentId: parent.id })
    await domain.setUnitStartSha(task.id, startSha).catch(() => null)
    // 子卡的 mergeState 恒为 none（不是 blocked —— blocked 会让看板以为它坏了）。
    await domain.setMergeState(task.id, { state: 'none', reason: null, humanReason: '改动以提交形式落在父分支 ' + branch }, { role: 'system', id: 'system:unit' }).catch(() => null)
    return { ok: true, path: dir, branch, shared: true, baseSha: startSha, parentId: parent.id }
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
    // C-05 / rf-01：父卡的集成分支要**尽早**标出来，不能等到全部子卡完成 ——
    // 子卡合并时要用它，而这行写在下面的 already 早返回之后就永远轮不到
    // （父卡通常在进 verifying 之后就已经是 verifying，二次调用直接返回）。
    // 幂等：只在还没标过的时候写一次，避免每次 rollup 都发一条 task.merge_state 事件。
    if (parent.integrationBranch !== integrationBranchOf(parent.id)) {
      await domain.markParentIntegration(parent.id, { role: 'system', id: 'system:rollup' }).catch(() => null)
    }
    const open = kids.filter((k) => !['done', 'cancelled'].includes(k.column))
    if (open.length) return { ok: true, waiting: open.length, total: kids.length }
    // v0.008：收口前逐张子卡核「这块活到底进没进父分支」。
    //
    // 判据只能是**交付事实**，不能是 column === 'done'：done 有五条来路，
    // 其中 done-no-commit（在父检出里一个提交都没有）与 merged-skipped（显式不合并）
    // 的活根本没进父分支。用列判断会把它们也算成「齐了」，父卡带着缺口去开 PR。
    //
    // 这里不重新量 git：afterUnitAccept 在验收那一刻已经量过 HEAD 并写死了 phase，
    // 再量一次只会得到「两次测量不一致时该信谁」的新问题。
    const kindOf = (k) => {
      if (!k) return 'unknown'
      if (k.column === 'cancelled') return 'cancelled'
      if (k.phase === 'done-in-parent' || k.phase === 'merged-into-parent') return 'delivered'
      if (k.phase === 'merged-skipped') return 'skipped'
      if (k.phase === 'done-no-commit') return 'no-commit'
      if (k.phase === 'done-no-merge') return 'no-merge'
      return 'unknown'
    }
    const facts = kids.map((k) => ({ id: k.id, kind: kindOf(k) }))
    const delivered = facts.filter((x) => x.kind === 'delivered').map((x) => x.id)
    // cancelled 不算缺口：取消是有意的，而且取消时已经放掉了租约。
    const undelivered = facts.filter((x) => x.kind === 'no-commit' || x.kind === 'skipped' || x.kind === 'unknown').map((x) => x.id)
    // 记父分支自己的头（不是 base）：收口那一刻「父分支上有多少东西」就是这个 sha。
    const parentProject = store.state.projects[parent.projectId]
    const parentBranch = integrationBranchOf(parent.id)
    const headSha = parentProject && parentBranch
      ? await git.revParse(parentProject.workspacePath, parentBranch).catch(() => null)
      : null
    await domain.recordRollup(parent.id, { delivered, undelivered, headSha }).catch(() => null)
    if (['verifying', 'merging', 'done'].includes(parent.column)) return { ok: true, already: true }
    // 父卡的集成分支已在函数开头标好（C-05），这里只做迁移：状态机要留历史。
    // 走专门的迁移（不是直接改 column）：状态机要有历史，别人也能看懂这是"汇总"
    const moved = await domain.move(parent.id, 'children_done', { role: 'system', id: 'system:rollup' }, {})
      .catch((err) => ({ error: err }))
    if (moved && moved.error) return { ok: false, message: String(moved.error.message || moved.error) }
    if (undelivered.length) {
      // 有子卡没落地：父卡照样进待验收（人要看得到它），但**不能**自己变成 ready ——
      // 那样 autoMerge 会在一张缺了支线的父卡上自动开合。
      await comment(domain, parent.id, '子卡都走到终态了，但**有 ' + undelivered.length + ' 张没有落地改动**：' + undelivered.join('、')
        + '。它们在父分支上没有任何提交（没提交 / 显式不合并 / 状态不明），合并前请先核对：是调查类子卡（那本来就该没有改动），还是真的漏了。')
      await notifyDispatcher(store.state.tasks[parent.id] || parent, '子卡有 ' + undelivered.length + ' 张没有落地改动，合并前需核对', 'children-done', {}).catch(() => null)
    } else {
      // 全部落地：兑现 markParentIntegration 注释里那句「子卡全合入时写 ready」。
      // ready 的含义是「现在可以去合并了」，与「已经合并」无关 —— 后者只有 review_approve 能给。
      await domain.setMergeState(parent.id, { state: 'ready', reason: null }, { role: 'system', id: 'system:rollup' }).catch(() => null)
    }
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
      // roundStartedAt 是「这一轮什么时候发出去的」：grillStuckAfterMs 的回收要用它，
      // startedAt 只记「这张卡的评审从什么时候开始」，拿它判超时会把第 2 轮一上来就判死。
      await domain.setGrill(task.id, { ...reviewState, status: 'running', rounds: (reviewState.rounds || 0) + 1, maxRounds, verdict: null, openForHuman: [],
        startedAt: reviewState.startedAt || new Date().toISOString(), roundStartedAt: new Date().toISOString() })
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
    // C-01：合并列里的卡不该被派工 —— 它要么在等合并，要么在等冲突回派（那条路会先 move 到 running）。
    // 顺序刻意排在**所有**已有守卫之后：halted / 项目 / 在跑的 run / 父卡 / 依赖这些返回值
    // 被 smoke 钉住了文案，插在前面会改变它们的优先级。
    // 少了这条守卫时，needs-rebase 的 dispatch 会把工人叫起来干活，
    // 而工人做完 flow_task_move(stop) 时起始列不对，直接被状态机拒 —— 那一轮改动白做。
    if (task.column === 'merging') return { ok: false, skipped: 'merging', message: '卡在合并列，先回派（review_conflict）再派工' }
    // rf-03：外部 PR 卡**永远**不派工。
    // 上面那条「合并列不派工」在正常流程里已经挡住它（这类卡只会落在 merging），
    // 但它不是为这个目的写的：只要有人把卡挪出合并列（人工 move、修复脚本），守卫就失效了。
    // 而这类卡根本没有检出，派出去的工人会对着主检出改别人的代码 —— 所以这里再钉一道。
    // ✅ 唯一例外：**冲突解决轮**。
    // 外部 PR 打架时它和普通 PR 一样该回派 —— 由工人把 base 合进自己的分支、解掉冲突再交回来。
    // 判据是 mergeLocked 在冲突时落的 external.resolver（见 :等）。没有这个标记就仍然不派。
    const resolving = task.kind === 'external-pr' && task.external && task.external.resolver === true
    if (task.kind === 'external-pr' && !resolving) return { ok: false, skipped: 'external-pr', message: '这是外部 PR 的合并卡，没有检出、不派工（只有冲突解决轮例外）' }

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
    // I-07：fatal 直接停在这里。原来这里是 `wt.path || project.workspacePath`，
    // 于是"建检出失败"顺滑地变成了"工人在人的检出里干活" —— 那是 T-043 的事故形态。
    // degraded（非 git / 无提交）才允许落到项目工作区，那本来就是这个项目的正确形态。
    if (wt.fatal) {
      await comment(domain, task.id, '这一轮没能派工：' + (wt.message || '检出不可用'))
      return { ok: false, message: wt.message || '检出不可用', fatal: true }
    }
    // C-10：父检出正被兄弟子卡占用 —— 不投案卷、不开 run，留在执行中等下一拍
    // （与 waiting-worker 同形：看板上一眼能分出是「等工位」还是「等分支」）。
    if (wt.waiting) {
      const wasWaiting = (store.state.tasks[task.id] || task).phase === 'waiting-branch'
      await domain.setTaskPhase(task.id, 'waiting-branch').catch(() => null)
      // 每拍都写一条评论会把卡刷成流水账：只在「刚进入等待」时说一次。
      if (!wasWaiting) await comment(domain, task.id, '这张子卡要用的父卡检出正被兄弟子卡占用，保持执行中；等那张卡验收后会接着派工（不需要你做什么）。')
      return { ok: false, waiting: true, message: '等待父卡检出（另一个子卡在跑）' }
    }
    const cwd = wt.ok ? wt.path : (project && project.workspacePath)
    // 没有 worktree 就没有分支可合 —— 记下来，验收后直接进 done，别塞进合并列。
    // 但这是"这一轮的状态"而不是"这张卡的永久属性"：仓库补上基线提交、或者
    // 项目以后接上了 git，下次派工就该重新拿到 worktree 与合并流程。
    if (!wt.ok || !wt.branch) {
      await domain.setNoMerge(task.id, true, wt.message || '非 Git 工作区，不需要合并', { role: 'system' }).catch(() => null)
    } else if (task.noMerge && !task.parentId) {
      // 子卡不参与合并：needsMerge 对它是拓扑判断，noMerge 被 setMergeState 维护成 true
      // 是**正确的**，不能在这里翻回 false，更不该对它说「合并流程回到正常路径」。
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
    // I-09：run 活着的时候锁住检出。放在 startRun **之后** —— startRun 会用 DUPLICATE_RUN
    // 把并发派工挡掉，所以走到这里的一定是「这张卡现在真的有一个 run」，锁与 run 同生命周期。
    await lockRunWorktree(store.state.tasks[task.id] || task, project, wt.ok ? wt.path : null)
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
      // C-10：共用检出必须在案卷里说清楚 —— 工人若顺手新建/切换分支，
      // 父卡的检出就落在别的分支上，下一轮所有人都对着错的工作区干活。
      sharedUnit: wt.shared === true,
      // C-11：并行子卡要知道自己这条分支是**临时**的 —— 与 sharedUnit 同一个理由：
      // 工人 checkout -b 一次，提交就落在一条验收时不会被合并的分支上（改动静默丢掉）。
      parallelUnit: wt.parallel === true,
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
  /**
   * 生成接力包（v0.016 / ticket 03）。全部取自可查事实，不依赖模型的六问。
   *
   * 起点取 `unitStartSha`（子卡本轮起点）→ 检出记的 baseSha → 不写。
   * 没有起点时宁可不写：把「整条分支的历史」当成这一轮的产出，会误导下一轮。
   */
  async function buildHandoff(task) {
    const cur = store.state.tasks[task.id] || task
    const project = store.state.projects[cur.projectId]
    const repo = project && project.workspacePath
    const wt = domain.worktreeOf(cur.id) || (cur.worktree || {})
    const dir = wt.path || repo
    if (!dir) return null
    const from = cur.unitStartSha || wt.baseSha || null
    let commits = []
    let changedFiles = []
    if (from && await git.isRepo(dir).catch(() => false)) {
      const log = await git.log({ dir, from, to: 'HEAD', limit: 5 }).catch(() => null)
      if (log && log.ok) commits = log.commits.map((c) => ({ sha: c.short, subject: String(c.subject || '').slice(0, 120) }))
      // changedFiles 返回的是**数组**（不是 {ok, files}）—— 这里曾经按对象取，静默拿到空列表。
      const changed = await git.changedFiles(dir, from, 'HEAD').catch(() => null)
      if (Array.isArray(changed)) changedFiles = changed.slice(0, 40)
    }
    const next = String((cur.progress && cur.progress.next) || '').trim()
    const open = domain.openInboxFor(cur.id).slice(0, 3).map((x) => String(x.topic || '').slice(0, 80)).filter(Boolean)
    const avoidTry = cur.rework && cur.rework.reason ? String(cur.rework.reason) : null
    const nothing = !commits.length && !changedFiles.length && !next && !open.length && !avoidTry
    if (nothing) return null
    return { commits, changedFiles, next, open, avoidTry }
  }

  /**
   * 卡级推进预算（v0.016 / ticket 05）。
   *
   * 判据是「这一轮有没有产生新提交/新改动」，不是「报告写没写」。
   * 到上限就 block + 开一张决策工单：把这笔账交给人，而不是让它再烧一轮。
   * 上限用 `settings.noProgressBudget` 覆盖（默认 3）。
   */
  async function trackProgressBudget(task, advanced) {
    const cur = store.state.tasks[task.id]
    if (!cur || cur.column === 'done' || cur.column === 'cancelled') return null
    const n = await domain.noteProgressRuns(task.id, advanced)
    const budget = Math.max(1, Number((store.state.settings || {}).noProgressBudget) || 3)
    if (n < budget) return { ok: true, noProgressRuns: n }
    // 已经在等人（blocked）就不要再堆工单：同一张卡只开一张决策（askHuman 的 dedupeKey 兜底）。
    if (cur.blocked && cur.blocked.reason === 'no-progress') return { ok: true, noProgressRuns: n, skipped: 'already-blocked' }
    const why = '这张卡连续 ' + n + ' 轮没有任何新提交'
    // 巡检可能已经因为 no-diff 把这卡 block 了 —— 那就别覆盖它的理由（两条信号说的是同一件事），
    // 但决策工单照样要开：人需要知道「已经连着 N 轮没前进了」。
    if (!cur.blocked) await domain.block(task.id, 'no-progress', { role: 'system', id: 'system:progress-budget' }).catch(() => null)
    await domain.askHuman({
      taskId: task.id,
      projectId: cur.projectId,
      kind: 'decision',
      topic: why + '，要不要换个做法？',
      problem: why + '。每一轮都在写同一份说明，代码没有前进 —— 再派一轮只会重复一次。',
      decisionNeeded: '这张卡接下来怎么走：拆小、换人、补环境，还是取消？',
      where: task.id + '（' + cur.column + (cur.phase ? '/' + cur.phase : '') + '）',
      suggestion: '优先「拆小」：把卡拆成两块能在同一轮里做完的。若卡等的是环境或凭据，改成补齐环境后重开。',
      current: '连续 ' + n + ' 轮没有新提交（预算 ' + budget + ' 轮）',
      progress: '最近一条进展：' + String((cur.progress && cur.progress.summary) || (cur.stopReport && cur.stopReport.summary) || '（无）'),
      asks: [{
        key: 'q1',
        question: '这张卡接下来走哪条路？',
        why: '再派一轮已经证明无效；继续需要你选一条不重复的路。',
        type: 'choice',
        choices: [
          { value: 'split', label: '拆小', impact: '把卡拆成两块更小的，下一轮各自能做完' },
          { value: 'env', label: '补环境', impact: '缺的是凭据/服务/数据，补好环境再重新派工' },
          { value: 'cancel', label: '取消', impact: '不做这张卡，把预算留给别的' },
          { value: 'continue', label: '再试一轮', impact: '再多派一轮（我会在方案里写明和上次不同的做法）' },
        ],
        default: 'split',
        required: true,
      }],
    }, { role: 'system', id: 'system:progress-budget' }).catch(() => null)
    return { ok: true, noProgressRuns: n, blocked: true }
  }

  async function afterStop(task) {
    const report = task.stopReport || {}
    // I-09：这一轮结束了，先解开这个检出的 run 锁（sync 会核对「卡上确实没有活跃 run」）。
    await syncWorktreeLocks(store.state.projects[task.projectId]).catch(() => null)
    const run = await domain.endRun(task.id, 'stopped', { stopReason: report.summary || '', runId: task.activeRunId || null })
    if (run && run.id) stopHeartbeat(run.id)
    const workerId = (run && run.agentId) || task.assignee
    if (workerId) await domain.setSessionState(workerId, 'idle', { role: 'system' }).catch(() => {})

    // v0.016（ticket 03）：在通知之前先把「这一轮停在哪」沉淀下来。
    // 顺序有意义：endRun 已经收口，分支上的提交是最终状态；通知里只带一句 summary，
    // 下一轮靠这份接力包接上——否则每个 run 都从零开始（线上 45% 的 run ≤5 分钟就是这么烧掉的）。
    const handoff = await buildHandoff(task).catch(() => null)
    if (handoff) await domain.recordHandoff(task.id, handoff, { role: 'system', id: 'system:handoff' }).catch(() => null)


    // issue 卡的调研轮结束 → 把工人写的方案整理成 plan，进"待批准"。
    // 这一步之后卡就停在 waiting-approval，**人（或主调度）点头才会真的开工**。
    // 调研轮 = issue 卡、还没批准过方案（phase=investigating 或 plan 还没成型）
    const wasInvestigating = task.lane === 'issue' && (task.phase === 'investigating' || !task.plan || task.plan.revision === 0)
    let awaiting = null
    if (wasInvestigating) awaiting = await awaitingApproval(task, report)

    // v0.016（ticket 05）：卡级推进预算 —— 连续几轮没有任何新提交就停下来问人。
    // 线上 T-046 用了 29 个 run 写同一份报告：不是工人不干活，是系统从来没有「这条路走不通」的出口。
    const advancedNow = !!(handoff && ((handoff.commits || []).length || (handoff.changedFiles || []).length))
    if (!wasInvestigating) await trackProgressBudget(task, advancedNow).catch(() => null)

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
    // I-09：取消之后这个检出不该再被当作「在用」——先解残留锁，否则它永远回收不了。
    await syncWorktreeLocks(store.state.projects[task.projectId]).catch(() => null)
    const had = task.activeRunId
    const run = had ? await domain.endRun(task.id, 'cancelled', { stopReason: '任务被取消', runId: task.activeRunId || null }, { role: 'human', id: 'cancel' }) : null
    if (run && run.id) stopHeartbeat(run.id)
    const workerId = (run && run.agentId) || task.assignee
    if (workerId) await domain.setSessionState(workerId, 'idle', { role: 'system' }).catch(() => {})
    try {
      // C-11：并行子卡的分支是**瞬时分枝**，判「合没合过」要拿父分支比 ——
      // 拿 base 比会把一条还没合进去的空瞬时分枝记成 not-merged，
      // 结果是卡都取消了还留着一条野分支和一个 blocked。
      const mergedInto = task.unitMode === 'parallel' ? integrationBranchOf(task.parentId) : null
      await removeWorktree(task, mergedInto ? { mergedInto } : {})
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
      // v0.006：grill-failed 也走紧急通道 —— 评审停住时整张卡停在等结论上，
      // 攒进聚合器等 maxWait 没有意义，而且这类事件通常一条就完了。
      urgent: kind === 'handoff' || kind === 'session-failed' || kind === 'grill-failed',
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

  /**
   * 合并入口的 mergeState 守卫（C-01）。
   *
   * 拒两类，其余一律放行：
   *   · none                —— 本来就没有可合的东西（没有分支 / 不是 git），推进去只会等一个不来的结果；
   *   · blocked + 契约类原因 —— 卡与 git 的事实对不上（见 CONTRACT_MERGE_REASONS），重试没意义。
   * 放行：pending / ready / undefined（schema 12 之前的老卡，向后兼容）、
   * 以及 **blocked + 环境类原因** —— 人把环境修好之后再合一次，是唯一的恢复路径。
   *
   * 放行 blocked 时**不清** mergeState：让 mergeLocked 自己去试 ——
   * 成功由 markMerged 收口，再失败由 blockMerge 重写原因（换一条更像样的原因也是信息）。
   *
   * 副作用（已知、留给 C-04）：autoMerge 的候选只看 column/autoMerge/approved，
   * 环境类 blocked 的卡会被它每次 tick 重试一次 —— 每次一行评论，直到人把环境修好。
   * 这是有意的取舍：宁可多刷几次评论，也不让「修好了却合不进去」成为死路。
   * 本票不动 scheduler.js（C-04 的地盘），它把候选收紧到 mergeState=ready 之后就是第二层。
   */
  const canEnterMerge = (task) => {
    const ms = task && task.mergeState
    if (ms === undefined || ms === 'pending' || ms === 'ready') return true
    if (ms === 'blocked') return !CONTRACT_MERGE_REASONS.has((task && task.mergeReason) || '')
    return false
  }

  const mergeStateReject = (task) => {
    const ms = task && task.mergeState
    const why = task && task.mergeReason ? '，原因 ' + task.mergeReason : ''
    return {
      ok: false,
      blocked: true,
      reason: (task && task.mergeReason) || ms,
      message: '这张卡当前不可合并（mergeState=' + ms + why + '），先修好再重试',
    }
  }

  /** TX-16：合并事务。成功 → done；冲突 → 软合并回派（TX-17）。 */
  async function merge(task, { strategy, by = 'agent', overrideOutOfScope = false } = {}) {
    if (!task) return { ok: false, message: 'unknown task' }
    if (task.column !== 'merging') return { ok: false, message: '只有「合并中」的任务能合并（当前 ' + task.column + '）' }
    // C-01 / I-12：mergeState 是「这次该不该合、能不能合」的唯一判据，合并入口必须先看它。
    // 以前这里只有列检查 —— 于是一张已被判 blocked 的卡会被 autoMerge 每 15 秒重试一次：
    // 每轮 rebaseAttempts++，三次之后永久 blocked；期间还反复 dispatch 工人干白活。
    // none/blocked 都不是「等着合」的状态，重试只会把计数刷到上限。
    if (!canEnterMerge(task)) return mergeStateReject(task)
    // 先确认有东西可合，再过审核闸门（否则人点合并会先留下一条 approved，然后才发现没有 PR）。
    // C-05：子卡的目标是父分支，它**不该**有 PR —— rf-01 明确「子卡不开自己的 PR」，
    // 所以这条守卫对它是反的：要求它有 PR 等于强迫它走一条被否决的形态。
    const target = resolveTarget(task)
    if (target.kind !== 'branch' && !Object.values(store.state.pull_requests).some((p) => p.taskId === task.id)) return { ok: false, message: '没有 PR 记录，先 flow_pr_open' }
    const gate = await reviewGate(store.state.tasks[task.id] || task, by)
    if (!gate.ok) return gate
    // I4/I10：同一仓库同时只允许一个合并事务，持租约才动 base。
    const lock = await domain.lockMerge(task.projectId, task.id)
    if (!lock.ok) {
      // v1.35：排队而不是直接拒（设计文档 §4.8 merge_queue）。autoMerge 按 queuedAt 先来先合。
      await domain.markMergeQueued(task.id).catch(() => null)
      return { ok: false, queued: true, message: '仓库合并锁被占用（' + lock.reason + '），已排队，锁释放后按顺序合并' }
    }
    // ADR-0004 §7：合并要跑 merge + 推进 base + 冒烟 + 可选 push，锁必须能续。
    // 续租失败（锁被别人抢了 / token 过期）不是小事：说明我们已经在跟另一个合并事务并发，
    // 这时正确的动作是**停下**，而不是继续往 base 上写。
    let renewTimer = null
    let lostLease = false
    if (typeof domain.renewMerge === 'function') {
      renewTimer = setInterval(() => {
        domain.renewMerge(task.projectId, lock.token).then((r) => { if (r && r.ok === false) lostLease = true }).catch(() => null)
      }, 30 * 1000)
      if (renewTimer && typeof renewTimer.unref === 'function') renewTimer.unref()
    }
    try {
      const out = await mergeLocked(store.state.tasks[task.id] || task, { strategy, overrideOutOfScope })
      if (lostLease) {
        await comment(domain, task.id, '合并期间合并锁丢了（可能被另一个合并事务接管），本次结果的可靠性存疑，请复核 base 上的提交').catch(() => null)
      }
      return out
    } finally {
      if (renewTimer) clearInterval(renewTimer)
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
  /**
   * 把"合并不了"分类落地（ADR-0004 §3，I-03）。
   *
   * 三类事必须分开：
   *  - 冲突（代码层面真打架）→ 回派原工人软合并，这是唯一应该动卡片的失败；
   *  - 环境（集成检出不可用、base 被占、人的改动挡路、需要 rebase）→ 卡停在合并列等修，
   *    **不回派**，否则工人白做一次软合并、下次照样撞同一堵墙；
   *  - 前置（没有 PR、验收后提交变了）→ 原样返回，调用方自己处理。
   */
  async function blockMerge(taskId, reason, humanReason, detail = null) {
    await domain.setMergeState(taskId, { state: 'blocked', reason, humanReason, detail }, { role: 'system', id: 'system:merge' }).catch(() => null)
    await comment(domain, taskId, '合并没完成（' + reason + '）：' + humanReason)
    return { ok: false, blocked: true, reason, message: humanReason }
  }
  /**
   * I-04（ADR-0004 §6）：base 的默认值 + 集成检出的查询/释放。
   *
   * 集成检出常驻会一直占着 base，主检出 `git switch base` 直接 fatal（exit 128）。
   * 这是本方案最扎人的副作用，必须有出口 —— 而且必须有**不靠命令行**的出口，
   * 否则看板上的人只能去看 ERROR，不知道下一步做什么。
   */
  async function defaultBase(project) {
    return (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath))
  }

  async function integrationStatus(project, { base } = {}) {
    return integration.status(project, { base: base || (await defaultBase(project)) })
  }

  async function releaseIntegration(project, { base } = {}) {
    const baseName = base || (await defaultBase(project))
    // 合并进行中不许释放：那会把正在合并的那棵树的现场删掉。
    const held = store.state.leases['merge:' + project.id]
    if (held && held.expiresAt > Date.now()) {
      return { ok: false, reason: 'merging', message: '有合并事务正在进行（持有者 ' + held.owner + '），等它结束再释放' }
    }
    return await integration.release(project, { base: baseName })
  }
  /**
   * I-05 / ADR-0002：越界改动检查。
   *
   * 合并落点搬进集成检出之后（ADR-0004），"主仓库必须干净"这层顺手的保护就没了。
   * 而工人会话的 cwd 仍是项目工作区（ADR-0002），所以工人用相对路径改文件会直接改到主仓库 ——
   * 那些改动不会进他的分支，合并看起来却是干净的：任务"成功"了，代码没进去。
   *
   * 这里比对**主检出的未提交文件**与这张卡的阅读范围：落在范围内 = 工人可能改错了地方，拦下来问人。
   * 只在任务设了 scope.paths 时生效 —— 没设范围的任务，人的日常编辑不该被当成越界。
   */
  async function detectOutOfScopeDirty(task, project) {
    const scope = (task.scope && task.scope.paths) || []
    if (!scope.length) return { ok: true, skipped: 'no-scope' }
    const dirty = await git.dirtyFilePaths(project.workspacePath).catch(() => [])
    if (!dirty.length) return { ok: true }
    const hits = dirty.filter((f) => scope.some((p) => {
      const base0 = String(p).replace(/[/\\]+$/, '')
      return f === base0 || f.startsWith(base0 + '/') || f === p
    }))
    return hits.length ? { ok: false, files: hits, scope } : { ok: true }
  }
  async function commitSummary(task, { commit = null, base = null, dir = null } = {}) {
    try {
      const project = store.state.projects[task.projectId]
      // 合并落在集成检出里，提交清单必须从**那个检出**读：
      // 主检出的 base 可能还没前进（advanceBase 失败 / 被占用），读它会拿到空列表而静默。
      const dir0 = dir || (project && project.workspacePath) || null
      const dir = dir0
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
  /**
   * C-10：把一条分支合进**目标分支**（base 或父分支），返回落点。
   *
   * 两条落点，按「目标分支是不是已经被某个检出占用」选：
   *
   *   ① 被占用 → 在**那个检出里**合（git.mergeBranch）。线上 T-048 就是这种：
   *      父卡自己占着 flow/T-048。走集成检出的结果是先在 __integ__ 落一个
   *      detached 提交、再由 advanceBase 推分支指针；目标分支被占时
   *      advanceBase 直接 base-busy（lib/integration.js:110），那个提交就成了
   *      不属于任何分支的孤儿，下次 ensure 判 integ-diverged —— 现场越合越脏。
   *   ② 没被占用 → 集成检出（ADR-0004 的默认路径）：detached 合并 + advanceBase。
   *
   * 落点选错不会丢提交（分支指针没动就等于没合），但会留下需要人工清的现场，
   * 所以这里宁可多读一次 worktree list。
   */
  async function mergeBranchInto(project, { branch, targetBranch, strategy = 'merge', message } = {}) {
    const repo = project.workspacePath
    const log = String(message || ('flow: merge ' + branch + ' into ' + targetBranch))
    const list = await git.listWorktrees(repo).catch(() => [])
    const holder = (list || []).find((w) => !w.bare && w.branch === targetBranch) || null
    if (holder && holder.path) {
      // 检出就在目标分支上：当前分支 === 目标，mergeBranch 的前置刚好成立。
      const res = await git.mergeBranch({ repo: holder.path, branch, base: targetBranch, strategy, message: log })
      return { ...res, via: 'holder', dir: holder.path, targetBranch }
    }
    const integ = await integration.ensure(project, { base: targetBranch })
    if (!integ.ok) return { ok: false, env: 'ensure', reason: integ.reason || 'integration-failed', message: '集成检出不可用（' + (integ.reason || 'unknown') + '）', via: 'integration', detail: integ, targetBranch }
    const res = await git.mergeInto({ dir: integ.dir, branch, strategy, message: log })
    if (!res.ok) return { ...res, via: 'integration', dir: integ.dir, targetBranch }
    // 合并落在集成检出的 detached HEAD 上：目标分支指针要显式推进。
    const adv = await integration.advanceBase(project, { base: targetBranch, sha: res.commit, dir: integ.dir })
    if (!adv.ok) {
      return { ok: false, env: 'advance', reason: adv.reason || 'advance-failed', message: '合并已在检出里完成，但分支指针没法前进（' + (adv.reason || 'unknown') + '）', via: 'integration', dir: integ.dir, commit: res.commit, detail: adv, targetBranch }
    }
    return { ...res, via: 'integration', dir: integ.dir, targetBranch }
  }

  /**
   * 子卡合进父卡的集成分支（C-05 / rf-01）。
   *
   * 与 mergeLocked 的区别只有「合到哪」：
   *   mergeLocked     → 合进 base，落地后 base 前进、对外 PR 收口；
   *   mergeIntoParent → 合进 flow/<parentId>，base **不动**，不开 PR。
   * 相同的是全部机制：合并后校验、冲突回派、越界检查、mergeIntent。
   *
   * 落点交给 mergeBranchInto 选（C-10）：父分支被某张卡自己的检出占着时
   * 就在那个检出里合；没被占用才走集成检出 + advanceBase。
   */
  async function mergeIntoParent(task, project, { strategy } = {}) {
    const current = store.state.tasks[task.id] || task
    const target = resolveTarget(current)
    if (target.kind !== 'branch') return { ok: false, message: '这张卡没有父分支可以合' }
    const parent = store.state.tasks[target.parentId]
    if (!parent) return { ok: false, message: '父卡不存在：' + String(target.parentId) }
    if (!(await git.isRepo(project.workspacePath))) return { ok: false, message: '工作区不是 git 仓库，无法合并' }
    const branch = branchFor(current)
    const baseBranch = (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath))
    const parentBranch = target.branch || integrationBranchOf(target.parentId)
    // 父分支可能还不存在（父卡没派过工、也不开检出）。补一次，别让 promise 落空。
    const madeParent = await git.materializeBranch(project.workspacePath, { branch: parentBranch, base: baseBranch })
    if (!madeParent.ok) {
      return await blockMerge(task.id, 'base-missing', '父分支 ' + parentBranch + ' 还不存在，也没法从 ' + baseBranch + ' 建（' + (madeParent.reason || 'unknown') + '）', madeParent)
    }
    if (madeParent.created) await comment(domain, task.id, '父卡的集成分支 ' + parentBranch + ' 已从 ' + baseBranch + ' 建出（' + String(madeParent.sha || '').slice(0, 8) + '）')
    // 越界检查与 base 路径一致：主检出里落在这张卡阅读范围内的未提交改动，说明工人可能改错了地方。
    const cfg = project.config || {}
    if (cfg.outOfScopeCheck !== false) {
      const oos = await detectOutOfScopeDirty(current, project)
      if (!oos.ok) {
        await domain.setMergeState(task.id, { state: 'blocked', reason: 'out-of-scope-dirty', humanReason: '主检出里有落在这张卡阅读范围内的未提交改动：' + oos.files.slice(0, 5).join(', '), detail: { files: oos.files, scope: oos.scope } }, { role: 'system', id: 'system:merge' }).catch(() => null)
        await comment(domain, task.id, '合并被拦下：主检出里有落在这张卡阅读范围内的未提交改动：\n\n' + oos.files.slice(0, 20).map((f) => '- `' + f + '`').join('\n'))
        return { ok: false, outOfScope: true, files: oos.files, message: '主检出有越界未提交改动' }
      }
    }
    const strat = strategy || cfg.mergeStrategy || 'merge'
    const baseBefore = await git.revParse(project.workspacePath, parentBranch).catch(() => null)
    await domain.recordMergeIntent(task.id, { branch, base: parentBranch, strategy: strat, headSha: current.headSha || null, baseBefore })
    const res = await mergeBranchInto(project, { branch, targetBranch: parentBranch, strategy: strat, message: 'flow: merge ' + task.id + ' into ' + parentBranch + ' — ' + task.title })
    // 环境问题（集成检出不可用 / 指针推不动）不动卡，只标阻塞；合并本身的失败走下面同一套分类。
    if (!res.ok && res.env) {
      if (res.env === 'advance') await domain.clearMergeIntent(task.id, 'advanceBase failed').catch(() => null)
      const human = res.env === 'ensure' ? ('集成检出不可用（' + String(res.reason) + '），合进父分支失败') : String(res.message || '合并已在检出里完成，但分支指针没法前进')
      return await blockMerge(task.id, res.reason, human, res.detail)
    }
    if (!res.ok) {
      // 与 base 路径同一套语义：冲突回派工人改，其余是环境问题、卡不动。
      if (res.conflict) {
        await domain.markMergeConflict(task.id, { files: res.files || [], reason: 'conflict' }).catch(() => null)
        await domain.move(task.id, 'review_conflict', { role: 'dispatcher', id: 'system:merge' }, {}).catch(() => null)
        await comment(domain, task.id, '与父分支 ' + parentBranch + ' 冲突（' + (res.files || []).slice(0, 5).map((f) => '`' + f + '`').join('、') + '），已回派解决')
        return { ok: false, conflict: true, files: res.files || [], message: '合并冲突' }
      }
      if (res.reason === 'needs-rebase') {
        await domain.move(task.id, 'review_conflict', { role: 'dispatcher', id: 'system:merge' }, {}).catch(() => null)
        await domain.setMergeState(task.id, { state: 'pending', reason: 'needs-rebase', humanReason: '父分支 ' + parentBranch + ' 已经前进，需要把你的分支 rebase 到它上面' }, { role: 'system', id: 'system:merge' }).catch(() => null)
        await comment(domain, task.id, '父分支 ' + parentBranch + ' 已经前进，需要先 rebase 到它上面（已回派）')
        return { ok: false, reason: 'needs-rebase', message: '需要先 rebase 到父分支' }
      }
      return await blockMerge(task.id, 'merge-failed', '合进父分支失败：' + (res.reason || 'unknown'), res)
    }
    const verified = await git.isAncestor(project.workspacePath, res.commit, parentBranch).catch(() => null)
    if (verified === false) {
      return await blockMerge(task.id, 'not-merged', '合并后校验失败：' + parentBranch + ' 不包含本次结果', { commit: res.commit })
    }
    await domain.markMerged(task.id, { commit: res.commit, strategy: strat, alreadyMerged: res.alreadyMerged === true, mergeCommit: res.mergeCommit || null })
    // 状态机里做**这次**迁移：verifying → done/merged-into-parent。
    // 子卡不是「已交付」（代码还在父分支上），所以不走 review_approve。
    const moved = await domain.move(task.id, 'merge_into_parent', { role: 'dispatcher', id: 'system:merge' }, {})
      .catch((err) => ({ error: err }))
    if (moved && moved.error) return { ok: false, message: '合并已落地，但状态迁移失败：' + String(moved.error.message || moved.error), commit: res.commit }
    // 合进父分支之后这张卡不需要再合：mergeState 收成 none（needsMerge 才会变 false）。
    await domain.setMergeState(task.id, { state: 'none', reason: null, humanReason: '已合进父分支 ' + parentBranch }, { role: 'system', id: 'system:merge' }).catch(() => null)
    // 回收检出时把「已合进哪个分支」告诉 removeWorktree：
    // 它默认拿项目 base 判断分支合没合过，而子卡的目标是父分支 ——
    // 用 base 判断会把一条已经合好的分支记成 blocked/not-merged（实测就是这个覆盖了 mergeState）。
    await removeWorktree(store.state.tasks[task.id] || task, { mergedInto: parentBranch }).catch(() => null)
    await comment(domain, task.id, '已合进父分支 ' + parentBranch + '（' + strat + '，commit ' + String(res.commit || '-').slice(0, 8) + '）；父卡收口时会一起进 ' + baseBranch)
    await rollupParent(store.state.tasks[task.id] || task).catch(() => null)
    return { ok: true, commit: res.commit, strategy: strat, base: parentBranch }
  }

  async function mergeLocked(task, { strategy, overrideOutOfScope = false } = {}) {
    if (task.column !== 'merging') return { ok: false, message: '只有「合并中」的任务能合并（当前 ' + task.column + '）' }
    // C-01：这里是**对内入口**（scheduler 与测试会直接调），不许绕开 merge() 的守卫。
    // 读 store 里的当前态而不是调用方传来的快照：持锁这段时间里状态可能已经被改过。
    const current = store.state.tasks[task.id] || task
    if (!canEnterMerge(current)) return mergeStateReject(current)
    const project = store.state.projects[task.projectId]
    // C-05 / rf-01：子卡的交付目标是**父分支**，不是 base。
    // 分派必须在这里（PR 检查之前）：子卡不开自己的 PR，所以 `if (!pr)` 那道守卫
    // 对它不成立 —— 顺序反了就会报「没有 PR 记录，先 flow_pr_open」，
    // 而子卡的正确动作是「合进父分支」。
    const target = resolveTarget(current)
    if (target.kind === 'branch') return await mergeIntoParent(task, project, { strategy })
    const prs = Object.values(store.state.pull_requests).filter((p) => p.taskId === task.id)
    const pr = prs[prs.length - 1]
    if (!pr) return { ok: false, message: '没有 PR 记录，先 flow_pr_open' }
    if (pr.status === 'merged') return { ok: true, already: true, commit: pr.mergeCommit }
    // I6/T13：验收绑定的 head_sha 与 PR 当前提交不一致，说明验收后又改过，必须重新验收。
    if (task.headSha && pr.headSha && task.headSha !== pr.headSha) {
      return { ok: false, message: '验收后提交已变化（验收 ' + task.headSha.slice(0, 8) + '，PR ' + pr.headSha.slice(0, 8) + '），需要重新验收' }
    }
    // ---- C-06 / rf-03：外部 PR 的代码**不在**我们的分支上 ----
    //
    // 别人开的 PR，分支在他的 fork 里，本地既没有 origin/<headBranch> 也没有 flow/*。
    // 可靠的位置只有 refs/pull/<n>/head（GitHub 与 Gitea 同形）。所以：
    //   ① 先把它抓到一条我们自己的、一次性的分支 external/pr-<n>；
    //   ② 用抓到的 sha 与建卡时锁定的 headSha 比对 —— 变了就停（见下）；
    //   ③ 之后走**同一条**合并路径（集成检出 / advanceBase / isAncestor / markMerged）。
    //
    // 为什么不调 forge 的 merge API：那会让「本地 base 是否真的前进」变成第二个真相。
    let mergeSource = pr.branch
    let externalPull = null
    if (current.kind === 'external-pr') {
      const ext = current.external || {}
      const number = Number(ext.number) || null
      if (!number) return await blockMerge(task.id, 'not-a-repo', '这张外部 PR 卡没有 PR 编号，没法抓取代码', { external: ext })
      const fetched = await git.fetchRef({ repo: project.workspacePath, remote: (project.config && project.config.remote && project.config.remote.name) || 'origin', source: 'refs/pull/' + number + '/head', dest: 'external/pr-' + number })
      if (!fetched.ok) {
        const human = fetched.reason === 'ref-missing'
          ? '远程找不到 PR #' + number + ' 的提交引用（PR 可能已被删除或关闭）'
          : '抓取 PR #' + number + ' 失败：' + String(fetched.message || fetched.reason || '').slice(0, 300)
        return await blockMerge(task.id, 'not-a-repo', human, fetched)
      }
      // rf-03：外部 PR 没有「我们的验收」这一步，所以他把 headSha 在**建卡时**锁定。
      // 他后来又推了提交 → 停在这里等人确认（不能偷偷合一个没人看过的新提交）。
      const locked = ext.headSha || pr.headSha || null
      if (locked && fetched.sha && locked !== fetched.sha) {
        const human = '外部 PR #' + number + ' 又推了新提交（建卡时 ' + String(locked).slice(0, 8) + '，现在 ' + String(fetched.sha).slice(0, 8) + '）。确认新提交没问题后再合（或重建这张卡）'
        return await blockMerge(task.id, 'head-mismatch', human, { locked, fetched: fetched.sha })
      }
      mergeSource = fetched.branch
      externalPull = { number, provider: ext.provider || 'github', sha: fetched.sha || locked }
      // ---- 冲突解决轮：合工人交上来的那条分支，而不是又合一遍原始 PR 头 ----
      // 工人拿到的是「以 external/pr-<n> 为起点的 flow/<taskId>」，他把 base 合进来解掉冲突。
      // 这里只要它**仍然包含**被锁定的那个提交就采用它 —— 那个校验防的是「解冲突时把别人的改动丢掉」，
      // 是外部 PR 唯一能表达「我没偷偷改需求」的证据。
      if (ext.resolver === true) {
        const resolver = branchFor(current)
        if (await git.branchExists(project.workspacePath, resolver)) {
          const keeps = await git.isAncestor(project.workspacePath, fetched.sha || locked, resolver).catch(() => false)
          if (keeps === true) {
            mergeSource = resolver
            externalPull = { ...externalPull, resolver, resolved: true }
          } else {
            await comment(domain, task.id, '工人交上来的分支 ' + resolver + ' 不包含外部 PR 的提交 ' + String(fetched.sha || locked || '').slice(0, 8) + '，不能用它合并（会丢掉别人的改动）。正在按原始 PR 头再试一次。')
          }
        }
      }
    }
    if (!(await git.isRepo(project.workspacePath))) return { ok: false, message: '工作区不是 git 仓库，无法合并' }
    const base = (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath))
    const stratRaw = strategy || (project.config && project.config.mergeStrategy) || 'merge'
    // 外部 PR 不走 rebase：那会把别人提交的历史改写掉（PR 上看到的 commits 全变了），
    // 而我们的语义是「把他的提交原样接进来」。rebase 策略在外部卡上退化成 merge。
    const strat = (current.kind === 'external-pr' && stratRaw === 'rebase') ? 'merge' : stratRaw
    const cfg = project.config || {}
    // ---- I-05（ADR-0002）：越界改动检查 ----
    // 合并落点搬到集成检出之后，主仓库"必须干净"这层顺手的保护就没了（ADR-0004）。
    // 这里把它显式补回来：主检出里的脏文件如果落在本任务的阅读范围内，说明工人可能改错了地方
    // 又没落进他的检出 —— 先拦下来问人，而不是把主检出的未提交内容晾在那儿让合并看起来干净。
    if (cfg.outOfScopeCheck !== false) {
      const oos = await detectOutOfScopeDirty(task, project)
      if (!oos.ok) {
        if (!overrideOutOfScope) {
          await domain.setMergeState(task.id, { state: 'blocked', reason: 'out-of-scope-dirty', humanReason: '主检出里有落在这张卡阅读范围内的未提交改动：' + oos.files.slice(0, 5).join(', '), detail: { files: oos.files, scope: oos.scope } }, { role: 'system', id: 'system:merge' }).catch(() => null)
          await comment(domain, task.id, '合并被拦下：主检出（不是工人检出）里有落在这张卡阅读范围内的未提交改动，合并会在别人没提交的现场上进行：\n\n' + oos.files.slice(0, 20).map((f) => '- `' + f + '`').join('\n') + '\n\n处理方式：提交/暂存这些改动，或用 flow_pr_merge 带 `overrideOutOfScope: true` 显式放行（会记一条授权评论）。')
          return { ok: false, outOfScope: true, files: oos.files, message: '主检出有越界未提交改动：' + oos.files.slice(0, 5).join(', ') }
        }
        await comment(domain, task.id, '人工显式放行越界检查（overrideOutOfScope），以下文件仍在主检出里未提交：\n\n' + oos.files.slice(0, 20).map((f) => '- `' + f + '`').join('\n'))
      }
    }
    // v1.35：L1 先落意图（谁、哪条分支、合到哪、合并前 base 在哪），再动 git。
    const baseBefore = await git.revParse(project.workspacePath, base).catch(() => null)
    await domain.recordMergeIntent(task.id, { branch: mergeSource, base, strategy: strat, headSha: pr.headSha || null, baseBefore })
    // ---- I-02（ADR-0004）：合并在集成检出里发生 ----
    // 主检出爱脏就脏、爱在哪个分支就在哪个分支 —— 合并队列不再挂在人的本地状态上。
    const useInteg = cfg.integrationCheckout !== false
    let integ = null
    if (useInteg) {
      integ = await integration.ensure(project, { base })
      if (!integ.ok) {
        return await blockMerge(task.id, integ.reason || 'integration-failed', '集成检出不可用（' + (integ.reason || 'unknown') + '）：' + (integ.message || integ.dir || ''), integ)
      }
    }
    let res
    if (integ) {
      res = await git.mergeInto({
        dir: integ.dir,
        branch: mergeSource,
        strategy: strat,
        message: 'flow: merge ' + task.id + ' — ' + task.title,
      })
      // 合并落在集成检出的 detached HEAD 上：base 不会自己动，得显式推进（ADR-0004 修订）。
      if (res.ok) {
        const adv = await integration.advanceBase(project, { base, sha: res.commit, dir: integ.dir })
        if (!adv.ok) {
          // 分类而不是压平：环境问题（人没提交/别的检出占着）不该回派工人重做一次软合并。
          const human = adv.reason === 'base-busy'
            ? 'base 分支正被另一个检出占用（' + (adv.holder || '?') + '），没法快进；关掉那个检出或换一条 base 再来'
            : '合并结果已生成，但推进 base 时被人未提交的改动挡下（' + String(adv.detail || adv.message || '').split(String.fromCharCode(10))[0] + '）—— 提交或挪走那些文件后重试'
          await comment(domain, task.id, '合并结果已在集成检出里生成（commit ' + String(res.commit || '').slice(0, 8) + '），但 base 没能前进：\n\n' + human)
          const blk = await blockMerge(task.id, adv.reason === 'base-busy' ? 'base-busy' : 'base-dirty-collide', human, adv)
          return { ...blk, commit: res.commit }
        }
      }
    } else {
      res = await git.mergeBranch({
        repo: project.workspacePath,
        branch: mergeSource,
        base,
        strategy: strat,
        message: 'flow: merge ' + task.id + ' — ' + task.title,
      })
    }
    if (!res.ok) {
      // ---- I-03：拒绝语义分家（ADR-0004 §3）----
      // 原来 `if (!res.ok)` 一律当冲突处理：markMergeConflict → review_conflict → 回派工人做软合并。
      // 但 repo-dirty / wrong-branch / no-branch 这些"环境没准备好"也被压进这条路 ——
      // 工人被叫回来做一次毫无意义的 rebase，醒来发现还是撞同一堵墙。
      // 现在只把**代码真打架**当冲突，环境问题原地 blocked 等人处理。
      if (res.reason === 'needs-rebase') {
        const attempts = (task.rebaseAttempts || 0) + 1
        await domain.setRebaseAttempts(task.id, attempts).catch(() => null)
        if (attempts > 3) {
          // 连续三次追不上就是信号（分支被别的东西顶住了），永久停等，不再回派。
          return await blockMerge(task.id, 'needs-rebase', '分支落后 base，已让工人软合并 ' + (attempts - 1) + ' 次仍未追上（上限 3），停下等人看看这条分支是不是被别的东西顶住了', { attempts, detail: res.detail || null })
        }
        // C-01：这里原来**同时**做两件相反的事 —— 先 dispatch 回派工人（卡还在 merging），
        // 紧接着 setMergeState(blocked)。三处连锁失效：
        //   ① dispatch 当时没有列守卫，工人在合并列的卡上开了 run；
        //   ② 工人改完 flow_task_move(stop) 起始列不对，直接被状态机拒，这一轮白做；
        //   ③ blocked 让 autoMerge 每 15 秒重试一次，rebaseAttempts 一路刷到上限。
        // 现在只做「回派」：先 move 到 running（复用 conflict 分支的 review_conflict，语义相同，
        // 都是「代码打架，回派工人」），派工才合法；合并状态给 pending 而不是 blocked ——
        // 合并没有失败，只是还没轮到，工人交上来之后会重新验收再合并。
        // ⚠️ rebaseAttempts 不清零：那是「连续追不上」的证据，合并成功时由 markMerged 那侧收口。
        // 外部 PR 落后 base 与「冲突」是同一件事的两种探测结果（ff-only 失败 vs merge 打架），
        // 走同一条回派：工人从 external/pr-<n> 拉分支、把 base 合进来。
        const extPacket = (current.kind === 'external-pr' && externalPull)
          ? buildExternalConflictPacket(task, { ...externalPull, resolver: branchFor(current) }, res)
          : buildConflictPacket(task, pr, res)
        if (current.kind === 'external-pr' && externalPull) {
          await domain.setExternal(task.id, { resolver: true, baseRef: mergeSource }, { role: 'system', id: 'system:merge' }).catch(() => null)
        }
        await domain.inject(task.id, { kind: 'context', content: extPacket.slice(0, 4000) }, { role: 'dispatcher', id: 'system' })
        await comment(domain, task.id, '分支落后 base，已让原工人做一次软合并（第 ' + attempts + '/3 次），完成后会重新验收并重试合并')
        await domain.move(task.id, 'review_conflict', { role: 'dispatcher', id: 'system' }, { reason: 'needs-rebase' })
        // 上一轮的审核结论绑的是**旧 head**：rebase 之后分支已经不是被审过的那条。
        // 不清掉的话卡会卡死在合并列：merge() 的 reviewGate 见到非 approved 直接拒，
        // scheduler 见到 reviewVerdict 有值就不再请重新审核（scheduler.js:357），autoMerge 也跳过。
        // 清空 = 回到「还没审」的初始态，下次合并会重新走审核闸门（人点/调度按判据审），
        // 而不是把「分支落后」这种环境问题伪装成一次审核不通过。
        await clearReviewVerdict(task.id)
        // move 的副作用（onMoved）自己就会派工；只有它没派（无 runtime / 效果入队）时才补一次，
        // 免得第二次 dispatch 撞上「任务已有在跑的 run」而把 redispatched 报成 false。
        const afterMove = store.state.tasks[task.id] || task
        const again = afterMove.activeRunId
          ? { ok: true, already: true, message: '已由迁移副作用派工' }
          : await dispatch(afterMove)
        // pending：还要重新验收再合，不是「随时可合」。这也让看板显示「等待合并」而不是红标。
        await domain.setMergeState(task.id, { state: 'pending', reason: 'needs-rebase', humanReason: '分支落后 base，已回派工人软合并（第 ' + attempts + '/3 次）', detail: { attempts } }, { role: 'system', id: 'system:merge' }).catch(() => null)
        return { ok: false, rebase: true, reason: 'needs-rebase', attempts, redispatched: again, message: '需要先把分支 rebase 到 base（已回派一次）' }
      }
      if (res.conflict) {
        await domain.markMergeConflict(task.id, { files: res.files || [], baseSha: pr.baseSha, reason: res.reason || '' })
        // rf-03：外部 PR 和普通 PR 一样回派工人解冲突（用户口径：没冲突自动合、冲突派单）。
        // 与普通卡唯一的区别是「工人从哪起步」：把 resolver/baseRef 落到卡上，
        // ensureWorktree 就会从 external/pr-<n> 拉一条 flow/<taskId>，而不是从 base 拉。
        if (current.kind === 'external-pr' && externalPull) {
          await domain.setExternal(task.id, { resolver: true, baseRef: mergeSource }, { role: 'system', id: 'system:merge' }).catch(() => null)
          await comment(domain, task.id, '合并冲突：' + ((res.files || []).join(', ') || res.reason || '未知') + '。已回派工人解冲突（从外部 PR #' + externalPull.number + ' 的提交拉一条本地分支）')
        } else {
          await comment(domain, task.id, '合并冲突：' + ((res.files || []).join(', ') || res.reason || '未知') + '，已回派原工人软合并')
        }
        const pkt = current.kind === 'external-pr' ? buildExternalConflictPacket(task, externalPull, res) : buildConflictPacket(task, pr, res)
        await domain.inject(task.id, { kind: 'context', content: pkt.slice(0, 4000) }, { role: 'dispatcher', id: 'system' })
        await domain.move(task.id, 'review_conflict', { role: 'dispatcher', id: 'system' }, { reason: res.reason || 'merge conflict' })
        // 清 verdict 必须在 move 之后：review_conflict 自己会写一条 needs_work 结论，
        // 顺序反过来等于「清完又被写回去」，卡仍旧焊死在合并列（本轮踩过）。
        await clearReviewVerdict(task.id)
        const again = await dispatch(store.state.tasks[task.id])
        return { ok: false, conflict: true, files: res.files || [], redispatched: again }
      }
      // 其余（not-a-repo / no-branch / worktree-dirty / not-detached …）：环境问题，卡不动、不派工。
      return await blockMerge(task.id, 'merge-failed', '合并没能开始：' + (res.reason || 'unknown'), { reason: res.reason || null, detail: (res.detail || null), files: res.files || [] })
    }
    // v1.35：合并后校验（设计文档 §4.8）—— base 现在必须真的包含这次的结果。
    // squash 的结果是 base 上的新提交，不是分支头，所以校验对象统一用 res.commit。
    // 顺序不能反：先校验再 push。反过来的话"推上去了但 base 没包含它"是可能的状态，
    // 那就等于把一次不成立的合并同步给了所有人。
    const verified = await git.isAncestor(project.workspacePath, res.commit, base).catch(() => null)
    if (verified === false) {
      await domain.block(task.id, '合并后校验失败：' + base + ' 不包含 ' + String(res.commit || '').slice(0, 8) + '（mergeIntent 保留待人核对）', { role: 'system', id: 'system:merge' })
      return { ok: false, message: '合并后校验失败：base 不包含合并结果', verify: false }
    }
    // ---- I-04（ADR-0004 §5）：pushRemote 项目要把 base 推上去 ----
    // 原来只有 openPr 推 flow/* 分支，合并不推 base —— 远程 master 永不前进、PR 永远 open，
    // 本地与远程是两个真相。失败**不撤销**已经落地的本地合并（撤销比不同步更危险）。
    if (cfg.pushRemote === true) {
      const integDirForPush = (integ && integ.dir) || project.workspacePath
      const pushed = await git.pushBranch({ dir: integDirForPush, branch: base })
      if (!pushed.ok) {
        const msg = String(pushed.reason || 'push failed').slice(0, 500)
        await domain.setMergeState(task.id, { state: 'blocked', reason: 'push-failed', humanReason: '本地已合进 ' + base + '（commit ' + String(res.commit || '').slice(0, 8) + '），但推送远程失败：' + msg + '。本地结果保留，修好远程后手工 push。', detail: { base, commit: res.commit, stderr: msg } }, { role: 'system', id: 'system:merge' }).catch(() => null)
        await comment(domain, task.id, '本地合并已完成，但推送到远程失败（本地结果保留）：\n\n' + msg)
        return { ok: false, pushFailed: true, commit: res.commit, message: '已合并到 ' + base + '，推送远程失败' }
      }
      await comment(domain, task.id, '已推送 ' + base + ' 到 ' + (project.config && project.config.remote && project.config.remote.name ? project.config.remote.name : 'origin'))
    }
    // v1.33：把「这次是真合并还是早就合过了」一起记下来 —— 审计里要能分辨
    await domain.markMerged(task.id, { commit: res.commit, strategy: strat, alreadyMerged: res.alreadyMerged === true, mergeCommit: res.mergeCommit || null })
    // C-01：合并成功就是「这个阻塞已经解除」的事实，别把红标的 mergeState 带进 done。
    // 这条路径以前不存在（blocked 根本进不来合并入口），现在环境类 blocked 放行之后它存在了：
    // 卡以 blocked 合并成功 → markMerged 只动 mergeRequest/mergeIntent → 看板对一张已完成的卡
    // 一直挂「合不了」的红 chip，而且下次任何复核都会再看到同一个已修好的原因。
    // 清 rebaseAttempts 归 C-05（markMerged 那侧），这里只负责状态本身。
    if ((store.state.tasks[task.id] || {}).mergeState === 'blocked') {
      await domain.setMergeState(task.id, { state: 'ready', reason: null, humanReason: null }, { role: 'system', id: 'system:merge' }).catch(() => null)
    }
    // 冲突解决轮的两个标记到此为止：合完了它们就没有意义，留着会让下次派工/合并继续当「解冲突」处理。
    if (current.external && (current.external.resolver || current.external.baseRef)) {
      await domain.setExternal(task.id, { resolver: false, baseRef: null }, { role: 'system', id: 'system:merge' }).catch(() => null)
    }
    // ---- C-06 / rf-05：外部 PR 收尾（尽力而为，绝不回滚已落地的本地合并）----
    //
    // 顺序与 push 同一口径：本地先成为既成事实，远程收尾是**投影**。
    // 投影失败只留一条评论，不改 ok —— 否则「已合并」与「失败」又是两个真相。
    if (externalPull && cfg.closePullOnMerge !== false) {
      const remoteCfg = (project.config && project.config.remote) || {}
      const closed = await closePull({
        remote: { ...remoteCfg, kind: remoteCfg.kind || externalPull.provider, provider: externalPull.provider },
        number: externalPull.number,
      }).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
      if (closed && closed.ok) {
        await comment(domain, task.id, '合并完成，已关闭外部 PR #' + externalPull.number + '（' + String(res.commit || '').slice(0, 8) + '）。远程分支没有删 —— 那是别人的分支。')
      } else {
        await comment(domain, task.id, '合并已完成（' + String(res.commit || '').slice(0, 8) + '），但关闭远程 PR #' + externalPull.number + ' 失败：' + String((closed && closed.reason) || 'unknown') + '。本地结果保留，需要手工关一次。')
      }
      // 抓取用的一次性分支：合并已经落进 base，它的提交不再只靠这条 ref 存在。
      // 用 -D（force）：这是**我们自己拉的**名字（external/pr-<n>），不是任何人的活。
      await git.deleteBranch({ dir: (integ && integ.dir) || project.workspacePath, branch: 'external/pr-' + externalPull.number, force: true }).catch(() => null)
    } else if (pr.remote && pr.remote.number && cfg.closePullOnMerge !== false) {
      // rf-05：我们**自己开的** PR 同样要收尾。
      // 以前这里什么都没有：本地合了、远程 PR 一直 open，仓库里看到的是「13 个开着的 PR」，
      // 与看板上的「已合并」完全对不上 —— 而 forge 会不会自己认领，是我们没法承诺的事。
      const remoteCfg = (project.config && project.config.remote) || {}
      const closed = await closePull({ remote: remoteCfg, number: pr.remote.number })
        .catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
      if (closed && closed.ok) {
        await comment(domain, task.id, '远程 PR #' + pr.remote.number + ' 已关闭（本地已合进 ' + base + '）。')
      } else {
        await comment(domain, task.id, '本地已合进 ' + base + '，但关闭远程 PR #' + pr.remote.number + ' 失败：' + String((closed && closed.reason) || 'unknown') + '。远程收尾是投影，本地结果不受影响。' )
      }
    }
    // v1.36：合并后冒烟（设计文档 §4.8 第 6 步）。只在项目显式配了 postMergeCheck 时跑。
    // 失败不回滚已经落地的合并（revert 掉是更危险的动作），而是阻塞卡片并把人叫来。
    const check = postMergeCheckOf(project)
    if (check) {
      // 冒烟必须在**合并真正落地的地方**跑：主检出可能还停在旧 base 上（advanceBase 被占用时），
      // 在它里面跑会得到"代码没变"的假绿。
      const checkDir = (integ && integ.dir) || project.workspacePath
      const runRes = await runCommand({ command: check.command, cwd: checkDir, timeoutMs: check.timeoutMs })
      await domain.setPostMergeCheck(task.id, { ok: runRes.ok, command: check.command, cwd: checkDir, code: runRes.code, timedOut: !!runRes.timedOut, stdout: runRes.stdout, stderr: runRes.stderr }, { role: 'system', id: 'system:merge' }).catch(() => null)
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
    const summary = await commitSummary(task, { commit: res.commit, base, dir: (integ && integ.dir) || null })
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
    const repo = project && project.workspacePath
    const dir = (wt && wt.path) || repo
    if (!dir || !(await git.isRepo(dir))) return { ok: false, message: '工作目录不是 git 仓库，无法开 PR' }
    // C-05 / rf-01：父卡的 PR 是它在**集成分支**上的收口，不存在自己的检出。
    // 这类卡不能走 commitAll（那是往主检出里提交别人的东西），head 也不能取「当前检出分支」
    // （主检出停在什么分支与父分支无关）。直接读集成分支的 ref。
    const integBranch = integrationBranchFor(task)
    const isParentPr = !!integBranch && !(wt && wt.path)
    const prBranch = isParentPr ? integBranch : (wt && wt.branch)
    let commit = null
    if (!isParentPr) {
      commit = await git.commitAll({ dir, message: message || ('flow: ' + task.id + ' ' + task.title) })
      if (!commit.ok) return commit
    }
    let pushed = { ok: false, reason: 'pushRemote 未开' }
    if (project.config && project.config.pushRemote) {
      pushed = await git.pushBranch({ dir, branch: prBranch || undefined })
    }
    const head = isParentPr
      ? ((await git.revParse(repo, integBranch).catch(() => null)) || (await git.headSha(dir)))
      : (commit.headSha || (await git.headSha(dir)))
    // base 的"当时位置"必须读 git 里的 ref，而不是"主检出当前检出的东西"：
    // 主检出可能停在别的分支上（ADR-0004 之后这是允许的），headSha 会给出一条毫不相干的提交。
    const baseRef0 = (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath))
    const base = (await git.revParse(project.workspacePath, baseRef0).catch(() => null)) || (await git.headSha(project.workspacePath))
    // v0.008：快照从 git 里量，不从「这次提交动了什么」里猜。
    // 工人自己提交过时 commitAll 返回 changed:false，用它的结果算 diff 必然是空的 ——
    // 线上 T-049 就是这样被判 risk：文件真的在（+1094/-0），快照却写着 files: -. 
    // 量 base..head 与「谁提交的、分几次提交的」无关，这是唯一不会撒谎的取数口。
    const stat = await git.diffStat(repo, base, head).catch(() => ({ files: 0, additions: 0, deletions: 0 }))
    const changed = await git.changedFiles(repo, base, head).catch(() => [])
    const snapshot = {
      files: changed,
      additions: stat.additions,
      deletions: stat.deletions,
      // 摘要只用机械事实：工人自己的话在 stopReport 里，审核员该看得到它，但不能把传闻当测量值。
      summary: (stat.files || changed.length) + ' file(s) · +' + stat.additions + '/-' + stat.deletions + ' · ' + String(head || '').slice(0, 8),
    }
    const pr = await domain.openPullRequest(task.id, {
      headSha: head, baseSha: base, branch: prBranch, title: task.title, ...snapshot,
    })

    // 远程 PR：pushRemote 开着才建（没推分支就建 PR 只会得到 422）
    let remotePr = null
    const cfg = project.config || {}
    // C-01 / rf-03：recordPulls 才是「发不发远程 PR」的开关；recordIssues 只管 issue 入站。
    // 一个字段管两件事的后果是：关掉 issue 同步的瞬间，PR 也一起没了（是两件不同的事）。
    // 仍然兼容 recordIssues：线上有项目是 recordIssues:true && pushRemote:true，
    // 一刀切会让它突然不再发 PR。旧开关继续算数，新开关是加法。
    if (cfg.pushRemote && cfg.remote && cfg.remote.owner && cfg.remote.repo && (cfg.recordPulls === true || cfg.recordIssues === true)) {
      try {
        const branch = prBranch || (await git.currentBranch(dir))
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

    await comment(domain, task.id, '已开 PR ' + pr.id + '（head ' + String(head).slice(0, 8) + (isParentPr ? '' : (commit.changed ? '，含新提交' : '，无新改动')) + (pushed.ok ? '，已推送' : '') + (remotePr ? '，远程 #' + remotePr.number : '') + '）')
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

  /**
   * run 期间给检出上 git 锁（I-09 / ADR-0006 §5）。
   *
   * 为什么用 git 自己的 lock 而不是登记表里加一个字段：**lock 是唯一真的挡住 prune / remove 的机制**
   * （实测：目录 rm -rf 后 `prune --expire=now` 也清不掉 locked 条目）。登记表是自己的账本，
   * 而回收代码就在同一个进程里 —— 账本拦不住自己想删的时候。
   *
   * reason 的格式是机器可读的：`flow <taskId> running`，`syncWorktreeLocks` 靠它反查是哪张卡。
   */
  async function lockRunWorktree(task, project, dir) {
    if (!dir) return { ok: true, skipped: 'no-dir' }
    if (project && project.config && project.config.lockRunningWorktrees === false) return { ok: true, skipped: 'config' }
    return git.lockWorktree({ repo: project.workspacePath, dir, reason: 'flow ' + task.id + ' running' })
      .catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
  }

  /**
   * 把"已经没人用"的检出锁解开（I-09 的兜底，也是 I-10 启动重活的一步）。
   *
   * 为什么必须有它：解铃还须系铃人这条规矩在异常路径上不成立 —— 进程被杀、会话超时、卡被人工撤销，
   * 都走不到 unlock。留着锁的后果不是"安全"，而是这个检出**永远**删不掉（gc 会一直跳过它）。
   * 判据只有一条且可靠：git 里有锁 && 这张卡没有活跃 run。
   */
  async function syncWorktreeLocks(project) {
    if (!project || !project.workspacePath) return { ok: true, unlocked: [] }
    if (project.config && project.config.lockRunningWorktrees === false) return { ok: true, unlocked: [] }
    const unlocked = []
    const list = await git.listWorktrees(project.workspacePath).catch(() => [])
    for (const w of list) {
      if (!w.locked || w.bare) continue
      const m = /^flow (\S+) running$/.exec(String(w.lockReason || ''))
      if (!m) continue
      const taskId = m[1]
      const task = store.state.tasks[taskId]
      // 卡没了，或者卡上没有活跃 run → 这把锁是残留。
      if (task && task.activeRunId) continue
      const res = await git.unlockWorktree({ repo: project.workspacePath, dir: w.path }).catch(() => ({ ok: false }))
      if (res.ok) unlocked.push({ taskId, path: w.path })
    }
    return { ok: true, unlocked }
  }
  /** Windows 删除失败的退避序列：目录被别的进程占着（最常见是**进程 cwd 在目录里**）。 */
  const DELETE_BACKOFF_MS = [200, 1000, 3000, 10000, 30000]

  /**
   * 回收一个任务的检出（ADR-0006 §3–§6 / I-08）。
   *
   * 与旧版的差别不只是"多写了几行"，而是四条判据被拆开了：
   *   ① **成功才 drop 登记**。旧版无论成败都 drop —— 于是删失败的目录从此在登记表里消失，
   *      变成谁都看不见的幽灵（BiliNote 上 3 个检出 / 1 条登记就是这么来的）。
   *   ② **先取证据再 prune**。旧版 rename 之后立刻 prune，`.quarantine` 里 4 条**全部**不可 git 读取。
   *   ③ **失败要退避，不是一次就放弃**。Windows 上目录被占是常态，等几秒通常就好了。
   *   ④ **删分支要判已合并**。全仓原来没有任何 `branch -d`，20 条 `flow/*` 全留着。
   */
  /**
   * 远程 PR 结束后的收口（v0.005）。
   *
   * 两种车道两种待遇（用户口径）：
   *   - **自动车道**（`visibility='auto'`，不在看板上）：PR 一结束，卡就地结束，不进生命周期管理；
   *   - **人车道**：PR 结束后按正常生命周期收口 —— 被合了就走 review_approve 落 done，
   *     被关了就在卡上问人（他可能想重开 PR、也可能想放弃这张卡）。
   *
   * 谁是权威：**远程事实**。人被 forge 那边合掉/关掉 PR 之后，本地无论处在哪一步，
   * 都以远程为准记事实；但「卡接下来怎么走」仍然由本地状态机决定（不越过它）。
   */
  async function closeoutRemote(facts = {}) {
    const f = facts || {}
    const task = store.state.tasks[f.taskId]
    if (!task) return { ok: false, reason: 'no-task' }
    if (task.column === 'done' || task.column === 'cancelled') return { ok: true, already: true }
    const isAuto = task.visibility === 'auto'
    const number = Number(f.number) || (task.external && task.external.number) || (task.mergeRequest && task.mergeRequest.remote && task.mergeRequest.remote.number) || null
    const label = 'PR #' + (number || '?')

    // 先把「远程事实」落到卡上：重复对账要靠它幂等（external.state 不再是 open 就不会再查一遍）。
    if (task.kind === 'external-pr' || (task.external && task.external.number)) {
      await domain.setExternal(task.id, { state: f.merged ? 'merged' : 'closed' }, { role: 'system', id: 'system:remote' }).catch(() => null)
    }

    if (f.merged) {
      // 被合了：本地跟着落事实。commit 用远程给的合并提交（没有就退到 headSha，再没有就不冒充）。
      const commit = f.mergeCommitSha || f.headSha || null
      if (!commit) {
        await domain.askHuman({
          taskId: task.id, kind: 'decision',
          topic: '远程 ' + label + ' 已合并但没有提交号：' + task.id,
          problem: '远程说这个 PR 已合并，但没带 merge_commit_sha / head sha，无法证明合并落地。',
          decisionNeeded: '确认合并后在看板上手动收口（跳过合并或修复记录）。',
          where: task.id + ' 在 ' + task.column, suggestion: '去远程仓库看一眼合并提交，再在卡上修复。',
        }, { role: 'system', id: 'system:remote' }).catch(() => null)
        return { ok: false, reason: 'no-commit' }
      }
      await domain.markMerged(task.id, { commit, strategy: 'remote', mergeCommit: f.mergeCommitSha || null }).catch(() => null)
      // 远程合并之后本地 base 往往还落后：尽力追一次，追不上就如实说（不假装本地也有了）。
      await syncBaseAfterRemoteMerge(task, f)
      if (task.column === 'merging') {
        await domain.setReviewVerdict(task.id, 'approved', '远程已合并（' + label + '）', [], { role: 'human', id: 'remote' }).catch(() => null)
        const moved = await domain.move(task.id, 'review_approve', { role: 'dispatcher', id: 'system:remote' }).catch((err) => ({ error: String((err && err.message) || err) }))
        if (moved && moved.error) return { ok: false, reason: moved.error }
        await removeWorktree(store.state.tasks[task.id] || task).catch(() => null)
        await comment(domain, task.id, label + ' 已在远程合并（commit ' + String(commit).slice(0, 8) + '），本地卡收口为已完成。')
        if (!isAuto) await notifyDispatcher(store.state.tasks[task.id] || task, '远程 PR 已合并，卡已收口', 'remote-merged').catch(() => null)
        return { ok: true, merged: true, commit }
      }
      // 不在合并列（还在 running / verifying 等）：只落事实，让生命周期继续走它自己的路。
      await comment(domain, task.id, label + ' 已在远程合并（commit ' + String(commit).slice(0, 8) + '）。卡当前在 ' + task.column + '，按本地生命周期继续推进。')
      return { ok: true, merged: true, commit, deferred: true }
    }

    // 被关了但没合并：这是我们没合、对方也不改了。
    if (isAuto) {
      // 自动车道：结束就结束。走 remote_ended（不是 cancel —— 取消是人的决定）。
      const moved = await domain.move(task.id, 'remote_ended', { role: 'system', id: 'system:remote' }, { reason: '远程 ' + label + ' 已关闭，未合并' }).catch((err) => ({ error: String((err && err.message) || err) }))
      await comment(domain, task.id, label + ' 在远程被关闭（未合并）。自动车道的卡随 PR 结束，这张卡就地结束。')
      await removeWorktree(store.state.tasks[task.id] || task).catch(() => null)
      return { ok: !(moved && moved.error), closed: true, error: (moved && moved.error) || null }
    }
    // 人车道：不替人做决定，问。
    await domain.askHuman({
      taskId: task.id, kind: 'decision',
      topic: '远程 ' + label + ' 被关闭但没合并：' + task.id,
      problem: '这个 PR 在远程被关掉了，没有合并进 base。',
      decisionNeeded: '这张卡还做不做？继续推进、重新开 PR，还是取消。',
      where: task.id + ' 在 ' + task.column,
      suggestion: '需要继续就重新开 PR；不做了就取消这张卡（会记为 cancelled，区别于自动收尾）。',
    }, { role: 'system', id: 'system:remote' }).catch(() => null)
    await comment(domain, task.id, label + ' 在远程被关闭（未合并）。已开请示，等人决定这张卡怎么处理。')
    return { ok: true, closed: true, needsHuman: true }
  }

  /**
   * 远程合并之后把本地 base 追上去（尽力而为）。
   *
   * 为什么不能直接用 `updateRef` 把 base 指过去：本地主检出可能正停在 base 上，
   * 硬改 ref 会让它的工作区与 HEAD 脱节（ADR-0004 的 `base-busy` 就是为这件事）。
   * 所以走集成检出的 `advanceBase`：它自己会处理「谁占着 base」「会不会覆盖未跟踪文件」。
   */
  async function syncBaseAfterRemoteMerge(task, facts) {
    const project = store.state.projects[task.projectId]
    if (!project || !project.workspacePath) return { ok: false, reason: 'no-project' }
    const base = (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath).catch(() => null))
    if (!base) return { ok: false, reason: 'no-base' }
    const fetched = await git.fetchBranch({ repo: project.workspacePath, remote: (project.config && project.config.remote && project.config.remote.name) || 'origin', branch: base }).catch(() => ({ ok: false }))
    if (!fetched.ok) {
      await comment(domain, task.id, '远程已合并且本地已记下合并提交，但本地 ' + base + ' 没能从远程追新（' + (fetched.reason || 'fetch failed') + '）：本地 base 仍落后。').catch(() => null)
      return { ok: false, reason: fetched.reason || 'fetch-failed' }
    }
    const res = await integration.advanceBase(project, { base, sha: fetched.sha }).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
    if (!res || res.ok === false) {
      await comment(domain, task.id, '远程已合并；本地 ' + base + ' 想快进到 ' + String(fetched.sha || '').slice(0, 8) + ' 但没成功（' + ((res && res.reason) || 'unknown') + '）。本地结果保留，人确认后再手工同步。').catch(() => null)
    }
    return res || { ok: false }
  }
  async function removeWorktree(task, { force = false, backoff = DELETE_BACKOFF_MS, deleteBranch = true, mergedInto = null } = {}) {
    const wt = domain.worktreeOf(task.id)
    if (!wt) return null
    const project = store.state.projects[task.projectId]
    if (!project || !project.workspacePath) return { ok: false, reason: 'no-project' }
    const repo = project.workspacePath

    // ① 有人在用这个检出就不删。删掉别人正在跑的现场等于把一次正在进行的工失败，
    //    而失败原因会显示成"文件突然不见了"—— 排查成本极高。
    const live = task.activeRunId ? domain.store.state.runs && domain.store.state.runs[task.activeRunId] : null
    const lease = store.state.leases['task:' + task.id]
    if (!force && (live || (lease && lease.expiresAt > Date.now()))) {
      return { ok: false, reason: 'in-use', message: '检出正在被使用（' + (live ? '有活跃 run ' + task.activeRunId : '租约未过期') + '）' }
    }

    // ② 别人给它上过锁（I-09 的 run 期 lock）就别强拆。git 的 lock 是唯一挡 prune 的机制。
    const list = await git.listWorktrees(repo).catch(() => [])
    const entry = git.findWorktree(list, wt.path)
    if (entry && entry.locked && !force) {
      // 锁是**我们自己的 run 锁**时，说明上一轮没有走到 unlock（进程被杀 / 会话超时）。
      // 这种情况下自己解开继续走：不解就会死结 —— 合并与取消这两条路上没人会再去调 sync，
      // 于是这个检出会被 gc 永远跳过，永远回收不了。
      // 用字符串比较而不是正则：reason 是我们自己写的 `flow <taskId> running`，
      // taskId 是内部 id，不含正则元字符，正则只会让这行更难读。
      const reason = String(entry.lockReason || '')
      const mine = reason === 'flow ' + task.id + ' running'
      if (!mine) return { ok: false, reason: 'locked', message: '检出被锁定（' + (reason || 'no reason') + '），先解锁再删' }
      await git.unlockWorktree({ repo, dir: wt.path }).catch(() => null)
    }

    // ③ 先断 junction 再动目录：实测当前 git 不会跟着删主仓库内容，但不值得拿 2.7GB 去赌。
    const sharedDirs = (project.config && Array.isArray(project.config.sharedDirs) && project.config.sharedDirs.length)
      ? project.config.sharedDirs
      : DEFAULT_SHARED_DIRS
    await git.unlinkSharedDirs({ worktree: wt.path, dirs: sharedDirs }).catch(() => null)

    // ④ 脏的移到隔离区，且**先取证据**（patch 落在隔离目录里，重启后还能捞）。
    const dirty = force ? [] : await git.dirtyFiles(wt.path).catch(() => [])
    if (dirty && dirty.length) {
      const dest = quarantineDirFor(wt)
      const patchPath = dest + '.patch'
      // **先取证据、再动目录**。这一步的顺序是整套设计里唯一不可调换的地方：
      // 一旦目录被 rename，worktree 的 gitdir 就指向了旧路径，git 在副本里直接报
      // not a git repository —— 线上 .quarantine 里 4 条"隔离成功"的记录全都读不出来，
      // 就是因为旧代码先 rename 再 prune。
      await fsMkdir(dirname(dest), { recursive: true }).catch(() => null)
      const ev = await git.captureEvidence({ dir: wt.path, patchPath, maxBytes: 8 * 1024 * 1024 })
        .catch((err) => ({ ok: false, reason: 'capture-threw', message: String((err && err.message) || err) }))
      const patch = ev.ok && !ev.empty ? patchPath : null
      const moved = await fsRename(wt.path, dest)
        .then(() => ({ ok: true, dest }))
        .catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
      if (!moved.ok) {
        // 隔离都失败：登记表要留着（这是唯一还知道这个目录存在的记录），状态说清楚。
        await domain.setWorktreeState(task.id, { state: 'blocked-delete', reason: 'quarantine-failed', detail: { dir: wt.path, why: moved.message } }, { role: 'system' }).catch(() => null)
        await comment(domain, task.id, 'worktree 有未提交改动且隔离失败（' + moved.message + '），保留原目录 ' + wt.path)
        return { ok: false, reason: 'quarantine-failed', message: moved.message }
      }
      if (ev.ok && ev.empty) await fsRm(patchPath, { force: true }).catch(() => null)
      await git.pruneWorktrees(repo).catch(() => null)
      // 登记**不 drop**：改成 quarantined + patchPath，人从看板还能看到"这里有一份没交的活"。
      await domain.setWorktreeState(task.id, {
        state: 'quarantined',
        reason: patch ? 'dirty-quarantined' : ('dirty-' + (ev.reason || 'unrecoverable')),
        patchPath: patch,
        detail: { dest, files: dirty.slice(0, 20), bytes: ev.bytes || 0, evidence: ev.ok ? 'patch' : ev.reason },
      }, { role: 'system' }).catch(() => null)
      await comment(domain, task.id, 'worktree 里有 ' + dirty.length + ' 个未提交改动，没有删除，已隔离到 ' + dest + (patch ? '（未提交内容存成 quarantine.patch）' : '（改动太大或已无法读取，只保留了目录）'))
      return { ok: true, quarantined: true, path: dest, patchPath: patch, files: dirty.slice(0, 20) }
    }

    // ⑤ 真删：失败要退避。删不掉的两个真实原因——进程 cwd 在目录里、杀毒/索引器临时占用。
    let res = null
    for (let i = 0; i <= backoff.length; i++) {
      res = await git.removeWorktree({ repo, dir: wt.path })
      if (res.ok) break
      // 元数据已被删（只剩空壳目录）时，`worktree remove` 只会回 not a working tree —— 永远修不好。
      // 这时候退化成"孤儿目录清扫"：直接删目录，再 prune 一次。
      const meta = await git.worktreeMetadataGone(repo, basename(wt.path))
      if (!meta.present) {
        const swept = await fsRm(wt.path, { recursive: true, force: true, maxRetries: 3 }).then(() => ({ ok: true })).catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
        if (swept.ok) { res = { ok: true, swept: true }; break }
        res = { ok: false, reason: 'sweep-failed', message: swept.message }
      }
      const wait = backoff[i]
      if (wait == null) break
      await new Promise((r) => setTimeout(r, wait))
    }
    if (!res || !res.ok) {
      // **保留登记**并标 blocked-delete —— 幽灵就是在这里产生的：旧代码无论如何都 drop，
      // 目录还在、git 还有条目，但登记表里已经没有它了，于是谁都看不见。
      const why = String(res && (res.message || res.reason) || 'remove failed').slice(0, 400)
      await domain.setWorktreeState(task.id, { state: 'blocked-delete', reason: 'remove-failed', detail: { dir: wt.path, why } }, { role: 'system' }).catch(() => null)
      await comment(domain, task.id, '检出删除失败（目录保留，登记保留）：' + why)
      return { ok: false, reason: 'remove-failed', message: why }
    }
    await git.pruneWorktrees(repo).catch(() => null)
    await domain.dropWorktree(task.id, { reason: 'merged' })

    // ⑥ 分支收尾（ADR-0006 §5）：**只删已合并的**。
    const branch = wt.branch
    let branchResult = null
    if (deleteBranch !== false && branch && project.config && project.config.deleteMergedBranches === false) deleteBranch = false
    if (deleteBranch && branch) {
      // C-05：子卡的分支合进的是**父分支**，不是 base。
      // 用 base 判断会把一条已经合好的分支记成「未合并」（并覆盖掉刚写好的 mergeState=none），
      // 调用方通过 mergedInto 把真实目标传进来（mergeIntoParent 传父分支）。
      const base = mergedInto || (project.config && project.config.baseBranch) || (await git.defaultBranch(repo))
      const merged = await git.isAncestor(repo, branch, base).catch(() => null)
      if (merged === true) {
        // 为什么 force：这里**已经**证明分支头在 base 里了 —— 那正是 `branch -d` 想确认的事，
        // 但 -d 的基准是「当前检出的 HEAD」，只有主检出正好停在 base 时才成立。
        // 子卡的目标是父分支 flow/<parentId>，主检出永远不包含它 → -d 以 not-merged 拒绝，
        // 于是「已合进父分支的子分支」永远删不掉（线上 T-049 收尾时就撞这条）。
        // -D 在这里不会丢提交：判据是 isAncestor(branch, 目标分支) === true。
        const del = await git.deleteBranch({ dir: repo, branch, force: true })
        branchResult = del
        if (!del.ok) {
          // 已判定合并却删不掉：不能说成"没事"，但也确实不是数据风险 —— 说清楚就行。
          await comment(domain, task.id, '分支 ' + branch + ' 删除失败（' + (del.reason || '') + '）：' + String(del.message || '').slice(0, 200))
        }
      } else {
        // 未合并：**绝不 -D**。这是工人做了但还没进 base 的活。
        const soft = await git.deleteBranch({ dir: repo, branch })
        branchResult = soft
        await domain.setMergeState(task.id, {
          state: 'blocked',
          reason: 'not-merged',
          humanReason: '分支 ' + branch + ' 还没合进 ' + base + '，检出已回收但分支保留（恢复指针：git branch ' + branch + ' ' + (wt.baseSha || '<sha>') + '）',
          detail: { branch, base, baseSha: wt.baseSha || null },
        }, { role: 'system' }).catch(() => null)
        await comment(domain, task.id, '分支 ' + branch + ' 未合进 ' + base + '，没有删（不做静默 -D）。要恢复现场：git branch ' + branch + ' ' + (wt.headSha || wt.baseSha || '<sha>'))
      }
    }
    return { ok: true, path: wt.path, branch: branchResult }
  }

  /**
   * 四时点对账里的「启动重活」与「tick 只读」共用同一个函数（I-10 / ADR-0006 §2）。
   *
   * 为什么必须两个时点都有：
   *   · 只有 tick → 进程整个停摆一晚、第二天开机时的那批漂移没人管；
   *   · 只有启动 → 两次启动之间产生的幽灵永远不消失（进程一跑就是几天）。
   * 所以：启动跑**重活**（dryRun:false，会动仓库），tick 跑**只读**（dryRun:true，只记录）。
   *
   * grace window（默认 10 分钟）只对 orphan-dir 生效：那是「刚建出来、登记还没写」的正常状态。
   * 没有它的话，对账会把自己刚建的检出当孤儿删掉 —— 第一次上线就会删掉正在干活的目录。
   */
  async function reconcileWorktrees({ dryRun = false, graceMs = 10 * 60 * 1000, now = Date.now(), projectId = null } = {}) {
    const { reconcile } = await import('./reconcile.js')
    const projects = projectId
      ? [store.state.projects[projectId]].filter(Boolean)
      : Object.values(store.state.projects || {}).filter((p) => p && p.workspacePath)
    const actions = []
    const skipped = []
    for (const project of projects) {
      if (project.config && project.config.worktreeReconcile === false) { skipped.push({ projectId: project.id, why: 'config' }); continue }
      const res = await reconcile(project, store.state.worktrees || {}).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
      if (!res.ok) { skipped.push({ projectId: project.id, why: res.reason }); continue }
      // ① 残留锁：无论 dryRun 与否都要知道，但只有重活才真的解。
      if (!dryRun) {
        const sync = await syncWorktreeLocks(project).catch(() => ({ unlocked: [] }))
        for (const u of sync.unlocked || []) actions.push({ projectId: project.id, kind: 'unlock', taskId: u.taskId, path: u.path })
      }
      for (const e of res.entries) {
        // ② ghost / stale-record：登记里有、git 里没有（或目录没了）。两种都该 drop，
        //    区别只在于要不要先把目录清掉。
        if (e.kind === 'ghost' || e.kind === 'stale-record') {
          if (dryRun) { actions.push({ projectId: project.id, kind: 'would-drop-record', taskId: e.taskId, path: e.path, reason: e.kind }); continue }
          if (e.kind === 'ghost' && e.onDisk) await fsRm(e.path, { recursive: true, force: true, maxRetries: 2 }).catch(() => null)
          await domain.dropWorktree(e.taskId, { reason: e.kind }).catch(() => null)
          await comment(domain, e.taskId, e.kind === 'ghost'
            ? '对账：登记里有这个检出，但它在 git 里或磁盘上已经不完整了，登记已收口。'
            : '对账：这条检出记录既不在磁盘上也不在 git 里，已删除记录。')
          actions.push({ projectId: project.id, kind: 'drop-record', taskId: e.taskId, path: e.path, reason: e.kind })
          continue
        }
        // ③ orphan-dir：目录在、git 与登记都没有。这是 Windows 删除失败留下的空壳形态。
        if (e.kind === 'orphan-dir') {
          const born = statBirth(e.path)
          const young = born != null && now - born < graceMs
          if (young) { skipped.push({ projectId: project.id, kind: 'orphan-dir', path: e.path, why: 'grace' }); continue }
          const empty = await dirIsEmpty(e.path)
          if (dryRun) { actions.push({ projectId: project.id, kind: empty ? 'would-remove-empty-dir' : 'would-archive-dir', path: e.path }); continue }
          if (empty) {
            await fsRm(e.path, { recursive: true, force: true, maxRetries: 2 }).catch(() => null)
            actions.push({ projectId: project.id, kind: 'remove-empty-dir', path: e.path })
          } else {
            // 非空且过了 grace：里面有东西，但不是任何一次派工的现场。移到归档区，
            // 之后由 gcWorktrees 的隔离区 TTL 段处理（不在这里立刻删 —— 那等于替人做决定）。
            const dest = join(quarantineRootFor(project), 'orphan-' + basename(e.path) + '-' + now)
            await fsMkdir(dirname(dest), { recursive: true }).catch(() => null)
            const moved = await fsRename(e.path, dest).then(() => true).catch(() => false)
            actions.push({ projectId: project.id, kind: moved ? 'archive-dir' : 'archive-failed', path: e.path, dest: moved ? dest : null })
          }
          continue
        }
        // ④ external / branch-busy：只报告。别人的检出、幽灵条目都不归对账动 ——
        //    动 external 等于删别人手工建的检出；branch-busy 需要人判断哪个才是真的。
        if (e.kind === 'branch-busy') actions.push({ projectId: project.id, kind: 'report-branch-busy', taskId: e.taskId, path: e.path, branch: e.branch, others: e.others })
      }
    }
    return { ok: true, dryRun, actions, skipped, at: new Date(now).toISOString() }
  }

/** 目录创建时间（Windows 上 birthtime 不可靠时退回 ctime）。取不到返回 null —— 取不到不该被当成「很旧」。 */
function statBirth(p) {
  try {
    const st = statSync(p)
    const t = st.birthtime && st.birthtimeMs ? st.birthtimeMs : st.ctimeMs
    return Number.isFinite(t) ? t : null
  } catch { return null }
}

async function dirIsEmpty(p) {
  try {
    const names = await fsReaddir(p)
    return names.length === 0
  } catch { return false }
}
  /**
   * 检出回收（TTL + 孤儿 + 隔离区），由 tick 定期跑。
   *
   * 这一版的三条纪律：**锁着的不动**（跳过并记录）、**隔离区不提前清**（14 天）、
   * **失败的在结果里说出来**（沉默的失败等于没有回收）。
   */
  async function gcWorktrees({ ttlMs = 7 * 24 * 3600 * 1000, quarantineTtlMs = 14 * 24 * 3600 * 1000, now = Date.now() } = {}) {
    // I-09/I-10：回收之前先把残留锁解开 —— 不解的话 gc 会永远跳过那些检出，
    // 而「永远跳过」与「永远不回收」是一回事。
    for (const project of Object.values(store.state.projects)) {
      await syncWorktreeLocks(project).catch(() => null)
    }
    const removed = []
    const quarantined = []
    const skippedLocked = []
    const failed = []
    for (const [taskId, wt] of Object.entries(store.state.worktrees || {})) {
      if (!wt) continue
      // 已隔离的现场不参与回收：它的 patch 还在，删了就真没了。14 天后由 quarantine TTL 处理。
      if (wt.state === 'quarantined') continue
      if (!wt.path) continue
      const task = store.state.tasks[taskId]
      const terminal = !task || task.column === 'done' || task.column === 'cancelled'
      const age = now - (Date.parse(wt.createdAt || wt.updatedAt || 0) || 0)
      if (!terminal && age < ttlMs) continue
      const res = await removeWorktree(task || { id: taskId, projectId: wt.projectId }, { force: !task })
        .catch((err) => ({ ok: false, reason: 'threw', message: String((err && err.message) || err) }))
      if (res && res.quarantined) quarantined.push({ taskId, path: res.path })
      else if (res && res.ok) removed.push({ taskId, why: terminal ? 'terminal' : 'ttl' })
      else if (res && res.reason === 'locked') skippedLocked.push({ taskId, path: wt.path })
      else if (res && (res.reason === 'in-use' || res.reason === 'locked')) skippedLocked.push({ taskId, path: wt.path })
      else if (res) failed.push({ taskId, reason: res.reason || 'unknown' })
    }
    // 隔离区到期清理（ADR-0006 §4：TTL 14 天）。
    // 这一条必须**单独**做：隔离区里的记录是 quarantined，主循环第一步就把它们 skip 了 ——
    // 没有这一段的话，隔离区只进不出，一年后就是一个几十 GB 的黑洞。
    const quarantinePurged = []
    const qtTtl = quarantineTtlMs == null ? 14 * 24 * 3600 * 1000 : quarantineTtlMs
    for (const project of Object.values(store.state.projects)) {
      if (!project || !project.workspacePath) continue
      const qroot = quarantineRootFor(project)
      let names = []
      try { names = await fsReaddir(qroot) } catch { names = [] }
      for (const name of names) {
        const full = join(qroot, name)
        const born = /-(\d{10,})$/.exec(name)
        const at = born ? Number(born[1]) : null
        const age = at ? now - at : null
        if (age != null && age < qtTtl) continue
        const gone = await fsRm(full, { recursive: true, force: true, maxRetries: 2 }).then(() => true).catch(() => false)
        if (gone) {
          quarantinePurged.push({ path: full, at })
          // 登记里指向这条隔离记录的也一并收口（patchPath 指向的文件已经没了）。
          for (const [taskId, rec] of Object.entries(store.state.worktrees || {})) {
            if (!rec || !rec.path) continue
            if (rec.path === full || (rec.detail && rec.detail.dest === full)) {
              await domain.dropWorktree(taskId, { reason: 'quarantine-purged' }).catch(() => null)
            }
          }
        }
      }
    }
    for (const project of Object.values(store.state.projects)) {
      if (project && project.workspacePath) await git.pruneWorktrees(project.workspacePath).catch(() => null)
    }
    return { removed, quarantined, skippedLocked, failed, quarantinePurged, at: new Date(now).toISOString() }
  }
  /**
   * v0.008（C-10）：子卡验收之后的收尾。
   *
   * 只回答一个问题：**父分支的 HEAD 是不是比派工时前进了**。
   *   前进 → done-in-parent（改动已经在父分支上，父卡收口时一起交付）；
   *   没动 → done-no-commit（本轮没有提交可交付 —— 不是失败，是事实）。
   * 不比对工人自述（自述留在 stopReport 里），交付事实从 git 量。
   *
   * legacy-branch（迁移打标的老子卡）走另一条：先把它的分支合进父分支，
   * 再收掉子分支与 PR 快照 —— 线上正在飞的那几张能收尾，而不是被新规则卡死。
   *
   * parallel（C-11 并行子卡）再走一条：改动在**瞬时分枝**上，这里合进父分支后连分支带检出
   * 一起收掉。判「有没有提交」量的是瞬时分枝的头，不是父分支的头 —— 父分支可能已经被
   * 别的并行子卡推进过，拿它比会把别人的提交算成自己的。
   *
   * 注意执行顺序：onMoved 发生在迁移**提交之后**（状态已经落 done），
   * 所以这里拦不住 done 本身；失败时只能把卡标成阻塞，让它看板上显形。
   */
  async function afterUnitAccept(task) {
    const current = store.state.tasks[task.id] || task
    const project = store.state.projects[current.projectId]
    const parentBranch = integrationBranchOf(current.parentId)
    // 先把父检出租约放掉：这张子卡已经不在执行，兄弟子卡下一拍就能接着派工。
    await domain.releaseUnitLease(current.parentId, current.id).catch(() => null)
    // 子卡的 mergeState 恒为 none（它在任何情况下都不等合并）。
    await domain.setMergeState(current.id, { state: 'none', reason: null, humanReason: '改动以提交形式落在父分支 ' + parentBranch }, { role: 'system', id: 'system:unit' }).catch(() => null)
    if (!project) return { ok: false, message: '项目不存在：' + String(current.projectId) }
    if (current.unitMode === 'legacy-branch') {
      const merged = await mergeUnitIntoParent(current, project)
      if (!merged.ok) {
        await domain.block(current.id, '子卡合进父分支失败：' + String(merged.message || '未知原因').slice(0, 300), { role: 'system', id: 'system:unit' }).catch(() => null)
        await comment(domain, current.id, '合进父分支 ' + parentBranch + ' 失败：' + String(merged.message || '未知原因') + '。子分支与 PR 都保留着，修好后可以重试。')
        return merged
      }
      await rollupParent(store.state.tasks[current.id] || current).catch(() => null)
      return merged
    }
    // C-11：并行子卡的改动还在一条瞬时分枝上，验收这一步是它唯一的落地时机。
    if (current.unitMode === 'parallel') return await afterParallelUnitAccept(current, project, parentBranch)
    const wt = domain.worktreeOf(current.id) || {}
    const dir = wt.path || (current.worktree && current.worktree.path) || null
    const head = dir ? await git.headSha(dir).catch(() => null) : null
    const start = current.unitStartSha || null
    if (head && start && head === start) {
      await domain.setTaskPhase(current.id, 'done-no-commit').catch(() => null)
      await comment(domain, current.id, '验收通过，但父分支 HEAD 没有前进（' + String(head).slice(0, 8) + '）：这一轮没有提交可交付。')
      await rollupParent(store.state.tasks[current.id] || current).catch(() => null)
      return { ok: true, phase: 'done-no-commit', head }
    }
    await comment(domain, current.id, '改动已在父分支 ' + parentBranch + ' 上（head ' + String(head || '').slice(0, 8) + '）：子卡不开 PR、不进合并列，父卡收口时一起交付。')
    await rollupParent(store.state.tasks[current.id] || current).catch(() => null)
    return { ok: true, phase: 'done-in-parent', head }
  }

  /**
   * C-11：并行子卡验收后的收尾 —— 把瞬时分枝合进父分支，然后连分支带检出一起收掉。
   *
   * 顺序是有讲究的：先量「有没有提交」，再合并，合并成功才删分支。
   * 反过来（先删检出）就再也没地方 rebase 了；合并失败时那条分支是这张卡唯一的交付物，
   * 必须留着让人能修 —— 所以**合并失败不落 done-in-parent**，而是把卡标阻塞让它显形。
   *
   * 合并竞态：A 并行卡先合进去推进了父分支，B 基于旧头 —— rebase 策略下这就是 needs-rebase
   * （只接受快进的策略，见 lib/git.js 里 mergeInto 的 rebase 分支）。这里先 rebase 再试一次，
   * 否则线上会变成「偶尔合不进去」的幽灵问题。
   */
  async function afterParallelUnitAccept(current, project, parentBranch) {
    const wt = domain.worktreeOf(current.id) || {}
    const dir = wt.path || (current.worktree && current.worktree.path) || null
    const branch = wt.branch || (current.worktree && current.worktree.branch) || scratchBranchFor(current.parentId, current.id)
    const start = current.unitStartSha || null
    const head = dir ? await git.headSha(dir).catch(() => null) : null
    if (head && start && head === start) {
      // 与共用检出同一条判据：头没动 = 这一轮没有提交。检出与瞬时分枝都要收掉 ——
      // 它们已经是空的（分支头就是派工时的基线），留着只会让下次派工复用错现场。
      await removeWorktree(current, { mergedInto: parentBranch }).catch(() => null)
      await domain.setTaskPhase(current.id, 'done-no-commit').catch(() => null)
      await comment(domain, current.id, '验收通过，但瞬时分枝 ' + branch + ' 没有新提交（head ' + String(head).slice(0, 8) + '）：这一轮没有可交付的改动，检出已回收。')
      await rollupParent(store.state.tasks[current.id] || current).catch(() => null)
      return { ok: true, phase: 'done-no-commit', head }
    }
    const strat = (project.config && project.config.mergeStrategy) || 'merge'
    const message = 'flow: merge ' + current.id + ' into ' + parentBranch + ' — ' + current.title
    let merged = await mergeBranchInto(project, { branch, targetBranch: parentBranch, strategy: strat, message })
    if (!merged.ok && dir && (merged.reason === 'needs-rebase' || merged.conflict)) {
      // 先 rebase 到父分支再合一次：父分支被兄弟推进过是**正常的并行现象**，
      // 不是这张卡的错，所以不能直接判失败（那会让并行卡有一半卡在合并上）。
      const rebased = await git.rebaseWorktree({ dir, onto: parentBranch }).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }))
      if (rebased.ok) merged = await mergeBranchInto(project, { branch, targetBranch: parentBranch, strategy: strat, message })
      else merged = { ...merged, rebase: rebased.reason, files: (rebased.files && rebased.files.length ? rebased.files : merged.files) || [] }
    }
    if (!merged.ok) {
      const files = (merged.files || []).slice(0, 20)
      const why = String(merged.reason || merged.message || 'unknown').slice(0, 300)
      await domain.block(current.id, '并行子卡的改动没能合进父分支 ' + parentBranch + '：' + why, { role: 'system', id: 'system:unit' }).catch(() => null)
      await comment(domain, current.id, '合进父分支 ' + parentBranch + ' 失败（' + why + '）'
        + (files.length ? '，冲突文件：' + String.fromCharCode(10) + files.map((f) => '- `' + f + '`').join(String.fromCharCode(10)) : '')
        + String.fromCharCode(10) + '瞬时分枝 ' + branch + ' 与检出都保留着：修好后再验收一次会重试合并。')
      return { ok: false, conflict: !!merged.conflict, files, message: why }
    }
    // 校验落地的是**这条分支的提交**：merge 策略下 commit 可能是分支自己的头，
    // rebase 策略下分支头被重写过 —— 两种情况下 branchHead 都必须在父分支的历史里。
    const anchor = merged.branchHead || merged.commit
    const verified = anchor ? await git.isAncestor(project.workspacePath, anchor, parentBranch).catch(() => null) : true
    if (verified === false) {
      await domain.block(current.id, '合并后校验失败：' + parentBranch + ' 不包含 ' + String(anchor).slice(0, 8) + '（瞬时分枝与检出保留）', { role: 'system', id: 'system:unit' }).catch(() => null)
      await comment(domain, current.id, '合进父分支 ' + parentBranch + ' 之后校验没通过：父分支里找不到这次的提交 ' + String(anchor).slice(0, 8) + '。检出与瞬时分枝都保留着。')
      return { ok: false, message: 'not-merged' }
    }
    // 先删目录再删分支：分支还被某个检出持有时 git 会拒删（checked out）。
    await removeWorktree(current, { mergedInto: parentBranch }).catch(() => null)
    // 瞬时分枝是**实现细节**，必须删干净：它不属于任何人的交付面，
    // 留在分支列表里会让「父卡还有几条支线」变得不可读。
    // removeWorktree 只在 isAncestor(分支, mergedInto) 成立时才删，上面已经校验过；
    // 这里再兜一次，是因为项目可能配了 deleteMergedBranches=false —— 那是给**交付分支**
    // 留档的开关，不该把一条临时分支一起留下来。
    if (await git.branchExists(project.workspacePath, branch).catch(() => false)) {
      await git.deleteBranch({ dir: project.workspacePath, branch, force: true }).catch(() => null)
    }
    await domain.setTaskPhase(current.id, 'done-in-parent').catch(() => null)
    await domain.setMergeState(current.id, { state: 'none', reason: null, humanReason: '已合进父分支 ' + parentBranch }, { role: 'system', id: 'system:unit' }).catch(() => null)
    await comment(domain, current.id, '改动已合进父分支 ' + parentBranch + '（commit ' + String(merged.commit || '').slice(0, 8) + '），瞬时分枝 ' + branch + ' 与检出已收掉：子卡不开 PR、不进合并列。')
    await rollupParent(store.state.tasks[current.id] || current).catch(() => null)
    return { ok: true, phase: 'done-in-parent', head, commit: merged.commit }
  }

  /**
   * v0.008（C-10）：把 legacy 子卡的分支合进父分支，然后收掉子分支与 PR 快照。
   *
   * 只给迁移打上 unitMode='legacy-branch' 的存量卡用（线上 5 张）。
   * 新子卡根本不需要这段：它们的提交本来就落在父分支上。
   *
   * 落点不在这里选：交给 mergeBranchInto（目标分支被父卡检出占着就在那里合，
   * 没人占才走集成检出）。父卡明明有检出还去建集成检出，会撞 base-busy 并留下孤儿提交。
   */
  async function mergeUnitIntoParent(task, project) {
    const current = store.state.tasks[task.id] || task
    const target = resolveTarget(current)
    if (target.kind !== 'branch') return { ok: false, message: '这张子卡没有父分支可以合' }
    const parent = store.state.tasks[target.parentId]
    if (!parent) return { ok: false, message: '父卡不存在：' + String(target.parentId) }
    if (!(await git.isRepo(project.workspacePath))) return { ok: false, message: '工作区不是 git 仓库，无法合并' }
    const wt = domain.worktreeOf(current.id) || current.worktree || {}
    const branch = (wt && wt.branch) || null
    if (!branch) return { ok: false, message: '这张子卡没有自己的分支，不需要合进父分支' }
    const baseBranch = (project.config && project.config.baseBranch) || (await git.defaultBranch(project.workspacePath))
    const parentBranch = target.branch || integrationBranchOf(target.parentId)
    // 父卡的集成分支可能还没建出来（历史数据里 integrationBranch 是 null）—— 补一次。
    const madeParent = await git.materializeBranch(project.workspacePath, { branch: parentBranch, base: baseBranch })
    if (!madeParent.ok) return { ok: false, message: '父分支 ' + parentBranch + ' 还不存在，也没法从 ' + baseBranch + ' 建（' + (madeParent.reason || 'unknown') + '）' }
    if (madeParent.created) await comment(domain, current.id, '父卡的集成分支 ' + parentBranch + ' 已从 ' + baseBranch + ' 建出（' + String(madeParent.sha || '').slice(0, 8) + '）')
    const merged = await mergeBranchInto(project, {
      branch,
      targetBranch: parentBranch,
      strategy: (project.config && project.config.mergeStrategy) || 'merge',
      message: 'flow: merge ' + current.id + ' into ' + parentBranch + ' — ' + current.title,
    })
    if (!merged.ok) {
      return { ok: false, conflict: !!merged.conflict, files: merged.files || [], message: String(merged.reason || merged.message || '合并失败'), via: merged.via }
    }
    // 校验父分支真的包含这张卡验收时那个提交（没验收过就退到本次的合并提交）。
    const anchor = current.headSha || merged.commit
    const verified = anchor ? await git.isAncestor(project.workspacePath, anchor, parentBranch).catch(() => null) : true
    if (verified === false) return { ok: false, message: '合并后校验失败：' + parentBranch + ' 不包含 ' + String(anchor).slice(0, 8) }
    // 回收子卡检出（先删目录才删得掉分支），只删已合进**父分支**的那条。
    await removeWorktree(current, { mergedInto: parentBranch }).catch(() => null)
    await domain.clearPullRequest(current.id).catch(() => null)
    await domain.setMergeState(current.id, { state: 'none', reason: null, humanReason: '已合进父分支 ' + parentBranch }, { role: 'system', id: 'system:unit' }).catch(() => null)
    await comment(domain, current.id, '已把改动合进父分支 ' + parentBranch + '（commit ' + String(merged.commit || '').slice(0, 8) + '）；子分支与 PR 快照已收尾。')
    return { ok: true, commit: merged.commit, base: parentBranch }
  }

  const onMoved = async (task, action) => {
    if (action === 'cancel') {
      const res = await afterCancel(task)
      // C-10：子卡取消也要放掉父检出租约，否则兄弟子卡会永远停在 waiting-branch。
      if (task.parentId) await domain.releaseUnitLease(task.parentId, task.id).catch(() => null)
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
      // C-10：子卡验收不走 PR / 合并那一套 —— 它只回答「这一轮交没交东西」。
      // 这段必须在下面所有「准备开 PR」的逻辑之前返回：子卡没有 PR，也不该有。
      const accepted = store.state.tasks[task.id] || task
      if (accepted.parentId) return await afterUnitAccept(accepted)
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
  const NL = String.fromCharCode(10)
  const silentNotifiedAt = new Map() // runId -> ms，同一个 run 10 分钟内只通知一次
  // v0.007：调度员/主调度自己那轮被环境打断后的连续失败次数。agentId -> { count, lastAt, lastError }
  //
  // 为什么存在内存里而不落库：这是「这一阵子的抖动」而不是业务事实，进程重启后清零是期望行为；
  // 真正要留痕的（谁、什么错）已经在 maintenance.lastSessionErrors 里。
  const dispatcherResume = new Map()
  const SILENT_WINDOW_MS = 10 * 60 * 1000

  /**
   * 一次会话事件。
   * v1.39：没有 goal 之后，completed 是"工人这一轮结束了"。汇报过就什么都不做；
   * 没汇报（没 stop / block / flow_message）就包装成 worker.turn-ended-silent 事件发给调度 ——
   * 否则卡会一直挂在 running，直到 30 分钟心跳超时才被发现。run 不结束，由调度决定下一步。
   */
  /**
   * 调度员自己那一轮的失败，能不能自动接上（v0.007）。
   *
   * 口径：调度自己的请求失败/报错要自动续跑，设置里默认开启，最多连续 5 次，
   *
   * 全失败就用 inbox 的系统消息（kind=error）告诉人。
   *
   * 三条边界：
   *
   *  · 人点停止不续跑（kind=stopped）：那是人的决定，接上去等于跟人对着干；
   *
   *  · 续跑是「给同一个会话再发一条 queue 消息」，不重建会话 —— 重建会丢掉它已经读到的上下文，
   *
   *    而那正是续跑相对重新派工的价值；
   *
   *  · 次数用尽后不再试，等人处理；人处理完（发一句话/重建会话）计数自然清零。
   */
  async function resumeDispatcher(sessionId, agent, verdict) {
    const settings = store.state.settings || {}
    const enabled = settings.dispatcherAutoResume !== false   // 未设置 = 开（默认要求）
    const rawMax = Number(settings.dispatcherAutoResumeMax)
    const max = Number.isFinite(rawMax) && rawMax >= 1 ? Math.min(10, Math.floor(rawMax)) : 5
    const prev = dispatcherResume.get(agent.id) || { count: 0, lastAt: null, lastError: null }
    // 人点的停止不续跑，也不计入失败次数 —— 否则「人想停」会把人自己推到上限。
    if (verdict.kind === 'stopped') return { ok: true, skipped: 'human-stopped' }
    if (!enabled) return { ok: true, skipped: 'disabled' }
    if (prev.count >= max) {
      // 到上限：不再自动试，转成一条系统错误通知（kind=error，只有信息、不要人做决定）。
      // 同一个 agent 只开一张（通知类在 askHuman 里不去重，这里自己判一次）。
      const existing = (store.state.human_inbox || []).find((x) => x && x.kind === 'error' && x.status !== 'archived'
        && x.from === 'system:dispatcher-resume' && String(x.topic || '').includes(agent.id))
      if (!existing) {
        await domain.askHuman({
          projectId: agent.projectId,
          kind: 'error',
          topic: '调度员连续失败 ' + max + ' 次，已停止自动续跑：' + agent.id,
          problem: '最近一次错误：' + String(prev.lastError || verdict.reason || ''),
          body: [
            '这个工位（' + agent.role + ' · ' + agent.id + '）连续 ' + max + ' 次没能完成一轮，自动续跑已停止。',
            '',
            '最近一次错误：' + String(prev.lastError || verdict.reason || '未知'),
            '',
            '接下来需要你做一件事：在 DSH 里打开这个工位的会话（或重建它），确认模型可用后让它继续；',
            '它这一轮没做完的判断与动作都还在卡上，不会丢。',
            '',
            '如果只是想让它别再自动试 —— 这条通知本身就代表「已经停了」，不需要额外操作。',
          ].join(NL),
        }, { role: 'system', id: 'system:dispatcher-resume' }).catch(() => null)
      }
      return { ok: true, exhausted: true, count: prev.count, max }
    }
    const attempt = prev.count + 1
    const text = [
      '【自动续跑 ' + attempt + '/' + max + '】上一轮没有正常结束：' + String(verdict.reason || '未知原因'),
      '',
      '这不是你的问题，是环境/模型侧的失败。请从断点继续：',
      '1. 先看这张卡现在到哪一步了（你手上的上下文，或 flow_task_detail），不要把已经做完的事再做一遍；',
      '2. 继续做完你这一轮该做的判断与动作；',
      '3. 做完就发出去（flow_message / flow_task_move / flow_ask_human），然后立刻结束本轮。',
      '',
      '如果你判断这件事现在做不下去（比如需要的模型一直不可用），就直接 flow_ask_human 说明卡在哪，不要硬试。',
    ].join(NL)
    const sent = await runtime.promptSession(sessionId, text, 'queue', { origin: 'system' })
      .catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
    if (!sent || sent.ok === false) {
      // 连「发消息」都失败：算一次失败（否则一个坏会话会被无限重试），但不进请示箱 —— 下一次事件还会再来。
      dispatcherResume.set(agent.id, { count: attempt, lastAt: new Date().toISOString(), lastError: verdict.reason })
      return { ok: false, resumed: false, count: attempt, message: String((sent && sent.message) || 'promptSession failed') }
    }
    dispatcherResume.set(agent.id, { count: attempt, lastAt: new Date().toISOString(), lastError: verdict.reason })
    return { ok: true, resumed: true, count: attempt, max }
  }
  /**
   * v0.006：**没有 run 的会话**失败时怎么办。
   *
   * 为什么需要这一段：runs 表只记「派过工的轮次」。三类会话从不进 runs ——
   * 需求评审工位（grillStart 走 promptSession）、调度员自己、以及交接过来的会话。
   * 老代码在 `no-active-run` 处一行 return 丢掉事件，后果是：
   *   · 评审工位被 503 打断 → 卡永远挂在 `grill.status='running'`，调度全程不知情；
   *   · grillStart 又因为「评审正在进行中」拒绝重开 → 这张卡从此不能再走评审，只能人手工救。
   * 线上就是这么撞上的（SERVER 503 / model_not_found，需求评审的对话停了，调度没收到任何停止事件）。
   *
   * 现在：
   *   ① 不管什么角色，先留一条事实（`maintenance.lastSessionErrors`）—— 排障时能查到「谁、什么错、什么时候」；
   *   ② 如果这个会话属于某项目的评审工位，就把正在等结论的那一轮判失败/中断，并在卡上评论 + 通知调度。
   * 只做 ②不做「通知任何角色」：调度员自己报错时给自己发通知是自通知死循环，
   * 而它的失败在界面上本来就看得见（会话帧里的错误）。
   */
  async function handleNoRunFailure(sessionId, verdict) {
    if (!verdict) return { ok: true, ignored: true, reason: 'no-run-no-verdict' }
    const agent = domain.agentBySession(sessionId)
    const rec = await domain.recordSessionError({
      sessionId,
      agentId: agent ? agent.id : null,
      role: agent ? agent.role : null,
      kind: verdict.kind,
      reason: verdict.reason,
    }).catch(() => null)
    // ---- 调度员 / 主调度自己：自动续跑（「调度自己的请求失败要能续上」）----
    if (agent && (agent.role === 'dispatcher' || agent.role === 'chief')) {
      // 续跑本身出问题时不要把错误吞掉：返回值里带上原因，排障时不必猜。
      const resumed = await resumeDispatcher(sessionId, agent, verdict)
        .catch((err) => ({ ok: false, resumed: false, error: String((err && err.message) || err) }))
      return { ok: true, recorded: !!rec, notified: false, resumed, reason: 'no-run-dispatcher' }
    }
    if (!agent || agent.role !== 'griller') return { ok: true, recorded: !!rec, notified: false, reason: 'no-run' }
    // 这个项目的评审工位正在等结论的卡（理论上同一时刻只有一张：grillStart 有 running 守卫）
    const waiting = Object.values(store.state.tasks)
      .filter((t) => t && t.projectId === agent.projectId && t.grill && t.grill.status === 'running')
      .sort((a, b) => String((b.grill && b.grill.startedAt) || '').localeCompare(String((a.grill && a.grill.startedAt) || '')))[0]
    if (!waiting) return { ok: true, recorded: !!rec, notified: false, reason: 'no-running-grill' }
    const round = Number((waiting.grill && waiting.grill.rounds) || 0)
    const interrupted = verdict.kind === 'stopped'
    await domain.setGrill(waiting.id, {
      status: interrupted ? 'interrupted' : 'failed',
      lastError: verdict.reason,
      failedAt: new Date().toISOString(),
      failedRound: round,
      // 这一轮没有产出任何问题/结论，不能白占一个轮次配额：退回上一轮，重开时还是同一轮。
      // 不退的话，连着两次模型抖动就会把 grillMaxRounds 用完，卡只能放弃评审。
      rounds: Math.max(0, round - 1),
    }, { role: 'system', id: 'system:grill' }).catch(() => null)
    await comment(domain, waiting.id, '【评审中断】第 ' + Math.max(1, round) + ' 轮没有正常结束：' + verdict.reason
      + '。这一轮已标记为' + (interrupted ? '中断' : '失败') + '，调度已收到通知。')
    const notified = await notifyDispatcher(store.state.tasks[waiting.id] || waiting,
      interrupted ? '评审这一轮被中断' : '评审这一轮报错停止',
      'grill-failed',
      { dedupeSuffix: 'r' + round }
    ).catch(() => null)
    if (!notified || notified.ok === false) {
      await comment(domain, waiting.id, '（顺带：调度员没收到这条通知 —— '
        + String((notified && (notified.message || notified.skipped)) || '未知原因') + '。需要人自己接手。）').catch(() => null)
    }
    return { ok: true, recorded: !!rec, notified, taskId: waiting.id, round }
  }
  async function onSessionEvent(sessionId, event) {
    if (!sessionId || !event || typeof event.type !== 'string') return { ok: true, ignored: true }
    // 一键停止期间什么都不接：用户要的是安静，报错/停止生成也算打扰。
    if (domain.halted()) return { ok: true, skipped: 'halted' }
    const data = event.data || {}
    let verdict = null
    if (event.type === 'error' || event.type === 'session/error') {
      // v0.016（ticket 07）：先分类再决定进哪个预算。
      const cls = classifyFailure({ message: String(data.message || data.reason || 'unknown error'), stderr: data.stderr, stdout: data.stdout, exitCode: data.exitCode, signal: data.signal })
      verdict = { kind: cls.kind, signature: cls.signature, reason: (cls.kind === 'infra' ? '环境失败：' : '这一轮报错：') + cls.reason.slice(0, 280) }
    } else if (event.type === 'turn/end') {
      const reason = (data && data.reason) || {}
      const rk = String(reason.kind || '')
      if (rk === 'error') {
        const e = reason.error || {}
        const cls = classifyFailure({ message: String(e.message || e.code || 'unknown'), stderr: e.stderr, stdout: e.stdout, exitCode: e.exitCode, signal: e.signal, durationMs: run && run.startedAt ? Date.now() - Date.parse(run.startedAt) : null })
        verdict = { kind: cls.kind, signature: cls.signature, reason: (cls.kind === 'infra' ? '环境失败：' : '这一轮报错：') + cls.reason.slice(0, 280) }
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
        // 调度员/主调度正常跑完一轮：连续失败计数清零（续跑算成功）。
        // 放在「没有 run」的判断之前 —— 它们的轮次本来就没有 run。
        {
          const a = domain.agentBySession(sessionId)
          if (a && (a.role === 'dispatcher' || a.role === 'chief')) {
            const had = dispatcherResume.get(a.id)
            if (had && had.count > 0) {
              dispatcherResume.set(a.id, { count: 0, lastAt: new Date().toISOString(), lastError: null })
              return { ok: true, ignored: true, reason: 'dispatcher-resumed-ok', cleared: had.count }
            }
          }
        }
        // 这一支只处理「工人这一轮结束了但没汇报」。没有 run 就不是工人的轮次：
        // 评审/调度员自己完成一轮不需要通知任何人（评审的正常路径是回调 flow_message）。
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
    if (!run) return await handleNoRunFailure(sessionId, verdict)
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
    const budget = await domain.recordFailure(task.id, { kind: verdict.kind, reason: verdict.reason, signature: verdict.signature || null }).catch(() => null)
    const retry = !!(budget && budget.retry)
    const note = retry
      ? '【会话失败】' + verdict.reason + '。' + Math.round((budget.backoffMs || 0) / 1000) + ' 秒后自动重试（第 ' + budget.tries + '/' + budget.max + ' 次）。'
      : '【会话失败】' + verdict.reason + '。重试预算已用尽（' + (budget ? budget.tries + '/' + budget.max : '?') + '），需要人处理。'
    await comment(domain, task.id, note)
    if (!retry) {
      if (verdict.kind === 'infra') {
        // v0.016（ticket 07）：三次退避都失败 → 这不是运气，是环境。转「缺环境」并请示，
        // 不放进内容返工预算（那会让工人回去重写「我做不到」）。
        const why = '环境失败 ' + (budget ? budget.tries : '?') + ' 次（信号：' + (verdict.signature || '未分类') + '）：' + verdict.reason
        await domain.move(task.id, 'infra_exhausted', { role: 'system', id: 'system:infra' }, { reason: why }).catch(() => null)
        await domain.block(task.id, 'needs-env', { role: 'system', id: 'system:infra' }).catch(() => null)
        await domain.askHuman({
          taskId: task.id,
          projectId: task.projectId,
          kind: 'blocked',
          topic: '环境失败三次，卡住了：' + task.id + ' ' + String(task.title || '').slice(0, 50),
          problem: why,
          decisionNeeded: '把环境修好（凭据/服务/磁盘/依赖），或者确认这张卡不用做了。',
          where: task.id + '（' + (store.state.tasks[task.id].column) + ' · blocked-needs-env）',
          suggestion: '先看给定的信号原文：网络类通常是服务没起；spawn 类通常是依赖没装；磁盘类要清空间。',
          asks: [{ key: 'e1', question: '环境现在是什么状态？修好后回一句，我重新派工。', why: '这些只能由你处理。', type: 'text', default: verdict.signature || '', required: true }],
        }, { role: 'system', id: 'system:infra' }).catch(() => null)
      } else {
        await domain.block(task.id, '会话失败且重试预算用尽：' + verdict.reason).catch(() => {})
      }
    }
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

  // C-01：mergeLocked 也导出 —— 它是对内入口（scheduler / 测试直接调），
  // 藏着的话测试只能绕到 merge() 去验它的守卫，等于没验。
  return { listSkills, exposedSkills, deliverInjection, handoff, rollupParent, pendingDeps, grillStart, grillVerdict, dispatch, afterStop, awaitingApproval, notifyDispatcher, notifyRecovered, relayToOrigin, merge, mergeLocked, closeoutRemote, softMerge, requestReview, reconcileMergeIntents, ensureWorktree, removeWorktree, gcWorktrees, syncWorktreeLocks, lockRunWorktree, reconcileWorktrees, openPr, defaultBase, integrationStatus, releaseIntegration, onMoved, onStopped, onSessionEvent, startHeartbeat, stopHeartbeat, stopAllHeartbeats, watchEvents, steerSupervisor, aggregator, WATCHED }
}
