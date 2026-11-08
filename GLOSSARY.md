# GLOSSARY · 调度台的领域词汇

只收**代码里真的存在**的词。每条给出它在代码里的落点，避免同一个东西在不同地方叫三个名字。新词先在这里定义，再写进 ADR 和票。

## 1. 编排

| 词 | 含义 | 落点 |
| --- | --- | --- |
| **项目（project）** | 一个被调度的 git 工作区 + 它的配置（车道、并发、base、remote） | `lib/domain.js:673` `ensureProject`；配置默认值 `lib/domain.js:40` `DEFAULT_CONFIG` |
| **卡 / 任务（task）** | 可被派工、验收、合并的最小记录单位。id 形如 `T-043` | `lib/domain.js:787` `createTask` |
| **列（column）** | 卡在流程里的宏观位置（待办 / 计划 / 执行 / 验收 / 合并中 / 完成…） | `lib/domain.js:990` `move`（状态机守卫在这里） |
| **阶段（phase）** | 列内部的细分（investigating / running / reviewing…）。列是"在哪"，阶段是"在干什么" | `lib/domain.js:1802` `setTaskPhase` |
| **车道（lane）** | 任务来源：`human`（人直派）或 `issue`（远程 issue 自动接单） | 项目配置 `lanes`；`lib/domain.js:1630` `ensureLaneAgents` |
| **工位 / 代理（agent）** | 扮演某个角色的会话：调度员 dispatcher、工人 worker、总调度 chief、需求评审 griller | `lib/domain.js:1469` `ensureAgents` |
| **派工（dispatch）** | 把一张卡交给某个工人，并建它这一轮的 run | `lib/dispatch.js` 派工主体；`lib/domain.js:1896` `startRun` |
| **案卷（brief）** | 派工时写给工人的那段自包含说明书（目标、验收、范围、环境、禁区） | `lib/dispatch.js:72` `buildBrief` |
| **run** | 一次派工的执行记录：绑 sessionId、有心跳、有结束分类 | `lib/domain.js:1896` / `:2004` `endRun` |

## 2. 隔离与合并

| 词 | 含义 | 落点 |
| --- | --- | --- |
| **分支是账本** | 可审、可合、可回溯的那份记录永远是分支（`flow/<taskId>`） | `lib/dispatch.js:52` `branchFor`；ADR-0001 |
| **检出（worktree）** | 一次性脚手架：给一轮工作用的独立目录。删了可以重建，不承载历史 | `lib/dispatch.js:45` `worktreePathFor`；`ensureWorktree` `lib/dispatch.js:300` |
| **共享依赖（sharedDirs）** | 用 junction 链进检出的主仓库依赖目录（`node_modules` / `.venv`…） | `lib/dispatch.js:38`；`lib/git.js:169` `linkSharedDirs`；`lib/git.js:198` `unlinkSharedDirs` |
| **集成检出（integration checkout）** | 计划中的长期检出，所有合并都在它里面发生，人的检出不参与 | ADR-0004（proposed） |
| **合并锁（merge lock）** | 同仓库同时只允许一个合并事务；抢不到就排队 | `lib/domain.js:1327` `lockMerge` / `:1331` `unlockMerge` / `:2422` `markMergeQueued` |
| **合并意图（merge intent）** | 动 git 之前先落库：谁、哪条分支、合到哪、合并前 base 在哪 | `lib/domain.js:2400` `recordMergeIntent` |
| **软合并（soft merge）** | 冲突后用 rebase 把 base 的新提交接进工人分支，再重试 | `lib/dispatch.js:1391` `softMerge`；`markRebased` `lib/domain.js:2434` |
| **隔离区（quarantine）** | 有未提交改动的检出不删，移到这里等人捞 | `lib/dispatch.js:1488-1500` |
| **mergeState** | 替代 `noMerge` 布尔的三态：`none` / `pending` / `blocked`（+ 原因枚举） | ADR-0005（proposed）；现状 `lib/domain.js:1724` `setNoMerge` |

## 3. 记录与监督

| 词 | 含义 | 落点 |
| --- | --- | --- |
| **验收（acceptance）** | 卡上逐条可复现的通过条件；验收通过的提交 sha 会钉在卡上（headSha） | `lib/domain.js:787` `createTask`（acceptance 字段） |
| **审核（review）** | 合并前的判据闸门，判据本身是项目配置的一组 prompt | `lib/domain.js:1241` `review`；`lib/domain.js:1394` `upsertReviewPrompt` |
| **巡检（inspection）** | 对一张卡/一轮工作的结论：keep / steer / pause / reset / done / blocked | `lib/domain.js:1773` `setInspection`；`:2055` `noteInspectionCycle` |
| **请示（inbox）** | 代理向人要决定的结构化工单，人在看板回复 | `flow_ask_human`（`lib/tools.js`）；`lib/domain.js` human_inbox |
| **需求评审（grill）** | 拆票前的多轮提问工位，把八问草稿挑错 | `lib/domain.js:2688` `setGrill`；`flow_grill_start` |
| **进度快照（progress）** | 工人写的结构化现状（state/summary/done/next/evidence） | `lib/domain.js:3210` `setProgress` |
| **事件聚合（aggregator）** | 把一串通知合成一条再叫醒调度员，避免每条都插话 | `lib/dispatch.js:946`（debounceMs / maxWait） |
| **事务流** | 领域写操作 = 校验 + 改状态 + 发事件，三者在一个事务里 | `lib/domain.js` 的 `emit`；`docs/事务流设计.md` |

## 4. 词义校正（避免这几组词被混用）

- **卡 ≠ 分支 ≠ 检出**：卡是记录，分支是账本，检出是脚手架。三者生命周期不同，别用"任务目录"这种含混说法。
- **列 ≠ 阶段**：列决定能做什么动作（状态机守卫），阶段只决定界面显示什么。
- **降级 ≠ 故障**：`not-a-repo` 是"这个项目本来就不进合并流程"（正常）；`base-missing`、`branch-busy` 是故障。ADR-0005 之后它们不再共用 `noMerge`。
- **自停 ≠ 阻塞**：工人自停是一轮的正常结束（有 stopReport），阻塞是要人/环境介入。