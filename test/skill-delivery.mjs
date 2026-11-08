import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatcher, buildBrief } from '../lib/dispatch.js'
import { resolveSkill, exposedSkills } from '../lib/skills.js'

const root = await mkdtemp(join(tmpdir(), 'flow-skills-'))
try {
  const skillPath = join(root, '.agents', 'skills', 'grilling')
  await mkdir(skillPath, { recursive: true })
  const skillText = '# Actual installed grilling skill\n' + 'Full skill instructions. '.repeat(600)
  await writeFile(join(skillPath, 'SKILL.md'), skillText)
  const project = { id: 'p', workspacePath: root, config: { allowedSkills: ['grilling'], grillMaxRounds: 2 } }
  const agents = {
    g: { id: 'g', projectId: 'p', role: 'griller', lane: 'human' },
    wh: { id: 'wh', projectId: 'p', role: 'worker', lane: 'human' },
    wi: { id: 'wi', projectId: 'p', role: 'worker', lane: 'issue' },
    dh: { id: 'dh', projectId: 'p', role: 'dispatcher', lane: 'human' },
    di: { id: 'di', projectId: 'p', role: 'dispatcher', lane: 'issue' },
  }
  const tasks = {}
  const injections = [], prompts = [], notifications = [], logs = []
  const store = { state: { projects: { p: project }, agents, tasks, runs: {}, message_log: logs } }
  const domain = {
    halted: () => false,
    inspect: () => ({ verdict: 'keep', reasons: [] }),
    inject: async (id, value) => { const item = { id: 'inj-' + injections.length, taskId: id, ...value }; injections.push(item); return item },
    setGrill: async (id, value) => { tasks[id].grill = value },
    noteEvent: async () => {},
    comment: async () => ({ ok: true }),
    logMessage: (value) => logs.push(value),
    hasLogged: () => false,
  }
  const runtime = {
    ensureSession: async (agent) => ({ ok: true, sessionId: agent.id }),
    promptSession: async (sessionId, text, mode) => { prompts.push({ sessionId, text, mode }); return { ok: true } },
    steer: async (_, args) => { prompts.push(args); return { ok: true } },
  }
  const dispatcher = createDispatcher({ domain, runtime, store })
  // Keep the real dispatcher route while making queue delivery observable.
  dispatcher.aggregator.push = async (event) => { notifications.push(event); return { ok: true } }
  assert.ok((await dispatcher.listSkills(project)).some((s) => s.name === 'grilling'))
  assert.equal((await resolveSkill(project, '../grilling')).ok, false)
  // v1.40：白名单只做暴露过滤，投递不再因 allowedSkills 拒绝（kind=skill 不带 skillName 时按原始文本注入）
  const bypass = await dispatcher.deliverInjection({ projectId: 'p' }, { kind: 'skill', content: 'bypass' })
  assert.equal(bypass.ok, true)
  assert.equal(injections.at(-1).content, 'bypass')
  assert.equal((await resolveSkill(project, 'missing')).ok, false)
  project.config.allowedSkills = []
  assert.ok((await dispatcher.listSkills(project)).some((s) => s.name === 'grilling'), '目录仍展示全部已安装技能，设置页才能勾选')
  assert.deepEqual(await dispatcher.exposedSkills(project), [], 'allowedSkills=[] 时向 AI 暴露的技能为空')
  assert.equal((await resolveSkill(project, 'grilling')).ok, true, 'v1.40：加载不再被 allowedSkills 拒绝')
  project.config.allowedSkills = null
  assert.equal((await resolveSkill(project, 'grilling')).content, skillText)
  assert.ok((await dispatcher.exposedSkills(project)).some((s) => s.name === 'grilling'), 'allowedSkills=null 时暴露全部已安装技能')
  for (const lane of ['human', 'issue']) {
    const task = tasks[lane] = { id: lane, projectId: 'p', lane, title: 'Review', column: 'running', plan: { revision: 1, text: 'plan' }, assignee: lane === 'human' ? 'wh' : 'wi' }
    const delivery = await dispatcher.deliverInjection(task, { kind: 'skill', skillName: 'grilling' })
    assert.equal(delivery.ok, true)
    assert.equal(delivery.injectionId, injections.at(-1).id)
    assert.equal(prompts.length, lane === 'human' ? 0 : 3)
    assert.ok(injections.at(-1).content.includes(skillText))
    assert.ok(injections.at(-1).content.includes('<skill_content name="grilling">'))
    assert.ok(buildBrief(task, project, agents[task.assignee], { skills: [injections.at(-1)] }).includes(skillText))
    task.activeRunId = 'run'
    const immediate = await dispatcher.deliverInjection(task, { kind: 'skill', skillName: 'grilling' })
    assert.equal(immediate.ok, true)
    assert.equal(immediate.injectionId, injections.at(-1).id)
    assert.equal(prompts.at(-1).agentId, task.assignee)
    const started = await dispatcher.grillStart(task, { draft: 'Draft for ' + lane })
    assert.equal(started.ok, true)
    assert.equal(prompts.at(-1).sessionId, 'g')
    assert.ok(prompts.at(-1).text.includes(skillText))
    assert.ok(prompts.at(-1).text.includes('Draft for ' + lane))
    assert.equal(injections.at(-1).skillName, 'grilling')
    assert.equal((await dispatcher.handoff(task, { to: 'grill', content: 'Answer' })).ok, true)
    assert.equal(task.grill.rounds, 2)
    assert.equal((await dispatcher.handoff(task, { to: 'grill', content: 'Over cap' })).ok, false)
    assert.equal((await dispatcher.handoff(task, { to: 'dispatcher', from: 'g', content: 'Griller question' })).ok, true)
    assert.equal(notifications.at(-1).agentId, lane === 'human' ? 'dh' : 'di')
    assert.ok(notifications.at(-1).text.includes('Griller question'))
    assert.equal((await dispatcher.grillVerdict(task, { verdict: 'settled', settled: ['Agreed'] })).ok, true)
    assert.equal(notifications.at(-1).agentId, lane === 'human' ? 'dh' : 'di')
    assert.ok(notifications.at(-1).text.includes('Agreed'))
  }
  const generic = tasks.generic = { id: 'generic', projectId: 'p', lane: 'issue', title: 'Shared review' }
  assert.equal((await dispatcher.deliverInjection(generic, { to: 'grill', skillName: 'grilling' })).ok, true)
  assert.equal(generic.grill.rounds, 1)
  assert.ok(prompts.at(-1).text.includes('generic'))
  assert.ok(notifications.length >= 4)
  dispatcher.stopAllHeartbeats()
  console.log('skill delivery passed')
} finally { await rm(root, { recursive: true, force: true }) }
