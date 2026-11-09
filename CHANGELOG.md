## v0.015（package 0.0.15）

- 停止报告支持六问：`problem` / `cause` / `impact` / `fix` / `regression` / `design`（各 600 字上限），
  归一化时算出 `sixMissing`；调度事件包里显示 `六问: N/6 · 缺 …`。
- 返工频控：同一张卡 20 分钟内第 3 次 `rework` 直接拒绝（`settings.reworkWindowMs` 可调），
  错误信息给出 block / steer / rewind 三条替代路径；`task.rework = {count, lastAt, reason}` 留痕。
- 巡检 `no-diff`：连续 2 轮仍是 steer，连续 3 轮（`noDiffBlockCycles`）升级为 `block`。
- `analyzeCycles` 过滤空对象：调用方不传 `now` 时不再把连续计数从中间切断。
- 提示词：工人侧写六问模板 + 「同一件事连续两轮拿不到证据就 block，不要再试同一招」；
  调度侧新增「六问报告怎么读」「返工前先自查事实」「放权清单 + 只有五类事才问人」。
- 提示词（调度侧）新增：验收标准要分「系统可验」与「需环境或人提供」两类，后者不写成硬闸门。
- 事件包内联规则加上限（1800 字）：宿主不支持系统提示词时，每个包不再整份复制规则。
- 修聚合器：一条事件自身体积超过上限时，至少投递它（截断 + 指路），不再产出空信封。
- 新测试 `test/anti-loop.mjs`（9 checks）。

# 变更日志

版本线说明：v0.001 起为本仓库的**新版本线**（此前代码对应 v1.39.1 的连续开发，但从未建过 git 仓库）。
npm 的 `version` 字段必须是合法 semver，所以 `package.json` 写 `0.0.1`，对外展示与 git tag 用 `v0.001`。

## v0.014（package 0.0.14，schema 不变 15）

- fix(inbox)：**回复后不再跳走**。原来发送成功会 `refreshInbox`，工单变成「已答复」被当前 tab 过滤掉，
  选中项顺势落到下一张 —— 人刚写完一段话就被弹去看别的工单。现在就地更新（状态 / 回复列表 / 计数），
  记住 `keep` 让这条以「刚回复」留在列表里，消息流停在原处并滚到底；切 tab 或点别的卡才放手。
- fix(inbox)：刷新列表不再先把 `items` 清空（原来会闪一下，且选中项在数据回来前无处可落）。
## v0.013（package 0.0.13，schema 不变 15）

- feat(inbox)：右栏改**消息流** —— 顶部标题条固定，工单正文是第一条消息，每次回复各成一条；
  不用气泡（长段落/表格会被挤碎），用「角色 · 时间 + 左对齐正文 + 发丝线」的线索式排版。
- feat(inbox)：输入区升级为聊天式 —— `引用`（把某条消息引成 Markdown 引用块写进正文）、`附文件`（路径或链接，
  发送时转成 `evidence` / `link` 组件）、`采纳推荐`、未答计数、`Ctrl/Cmd+Enter` 发送、发送后滚到底部。
  人回复因此可以只挂证据不写正文：`replyInbox` 的空内容判据改成「正文、选项、组件三样全空才算空」。
- fix(client)：`inbox.read` 改成静默调用（`silentRead`）。老服务端没有这个 action 时会报 `unknown action: inbox.read`，
  而标已读只是顺手做的事 —— 不该打断人。
- test：`test/inbox-mailbox.mjs` 加两条（人回复带 blocks、三样全空才拒）；`test/render.mjs` 断言随信息架构更新。
## v0.012（package 0.0.12，schema 14 → 15）

- fix(inbox)：回信报 `(store.state.runs || []).find is not a function` —— `runs` 是字典（`lib/core.js` 的 `runs: {}`），
  `lib/http.js` 却当数组用。改为按 id 取，并把「顺手 steer 在跑的工人」整段包进 try/catch：失败写 `steerFailed` 与一条
  `inbox-reply-steer-failed` 的 message_log，**回复本身仍然成功**（原来报错但消息其实回进去了，提示与事实相反）。
  新增 `test/inbox-reply.mjs`（4 checks）。
- feat(inbox)：工单箱改成**两栏邮箱**（左收件列表 / 右只显示选中那一条）：四个 tab（待我回 / 已回复 / 通知 / 归档）+ 搜索 +
  未读点 + 行内进度；右栏是「概况条 → 预设组件 → 问题 → 现状 → 影响 → 需要你补充 → 调度建议 → 处理记录 → 回复区」。
  README 顶部与 `.wayfinder/tickets/inbox-mailbox.md` 有完整信息架构。
- feat(inbox)：**预设组件**（九种）。`lib/inbox-blocks.js` 新增 `BLOCK_TYPES` / `MAX_BLOCKS=12` / `normalizeBlocks`（白名单、
  单块 2000 字符截断、choice 至少 2 项且只留 1 个 recommended、link 只放行 `^https?://`）/ `blocksToText`（一行一块，给模型读）。
  `flow_ask_human` 与 `flow_inbox_reply` 新增 `blocks` 参数；`flow_inbox_list` 输出多一行「组件：…」摘要。
  新增 `test/inbox-blocks.mjs`（9 checks）。
- feat(schema)：`SCHEMA_VERSION` 14 → 15，`MIGRATIONS[14]` 补 `human_inbox[*].blocks=[]`、`readAt`（归档视为已读，其余 null，
  判据 `readAt === undefined` 保证幂等）、`replies[*].blocks=[]`。
- feat(inbox 数据层)：`readAt`（已读）与 `status`（处理状态）**正交**；`markInboxRead` 只动 `readAt` 且幂等；
  `appendInboxFollowUp(inboxId, content, actor, {blocks})` 追问后**重新未读**（`status='open'` + `readAt=null`）；
  `inboxList` 新增 `kind` / `q` / `offset`，改成**倒序**（新→旧，原来 `slice(-limit)` 让首屏显示最旧的几条）并以 `id` 兜底稳定排序；
  新增 `inboxCount`。新增 `test/inbox-mailbox.mjs`（8 checks）。
- feat(inbox 出口)：`lib/panel.js` 的 inbox 投影显式映射全部字段并给出 `counts.unread` / `counts.notices`；
  `inbox.list` 返回 `{items, counts, total, hasMore}`；新增 `inbox.read`（与 `inbox.mark-read` 不同：后者是通知类归档）。
- style：`VIEW_CSS` 加邮箱与组件令牌化样式（`--flowv-space-*` / `--flowv-fs-*` / `--flowv-t-*`），
  左列 300px、正文 `max-width:760px`、数字 `tabular-nums`、`prefers-reduced-motion` 去位移；窄屏（≤860px）单列堆叠。
## v0.011（package 0.0.11，schema 仍 14）

- 新增 `lib/view-model.js`（297 行，纯函数）：`BADGE_ORDER` / `badgesFor` / `chipsFor(task, max)` / `headlineFor` / `cardView`，
  统一「这张卡在每个高度上说什么」；`lib/panel.js` 的 `taskCard` 追加投影 `view`（其余字段不变）。
- 看板卡片改读 `task.view`：最多 2 枚徽标 + `+N` 溢出、第三行用服务端算好的 headline；没有 `view` 的老服务端回退旧路径。
- 顶栏低频动作收进「更多」菜单（停止调度常驻）；统计 16 → 6（其余折叠）；车道两张卡合成一行、水位仅 >70% 显示。
- 抽屉：`Card` 支持折叠（`fold:{open,summary,onToggle}`，折叠态不渲染正文）；新增结论条与 10 个可折叠块。
- 看板列可收起（`colCollapsed`），空列保留 108px rail；补 `:focus-visible` 与按下 `scale(.99)`。
- 动效：折叠 180ms（`flowv-fold-in`）、箭头旋转 120ms、`prefers-reduced-motion` 全部关闭。
- 新增 `test/view-model.mjs`（8 checks）；`test/render.mjs` 增「三层密度」断言（更多菜单、统计折叠、Fold 默认值）；
  `test/merge-state.mjs` 的「客户端内联副本」断言改为「view-model 是唯一来源」。
- 未做：设置页 4 组重排、Inbox 分区折叠、客户端详情页语义副本删除、CSS 类名收敛（见 `.wayfinder/tickets/ui-05*`、`ui-06*`）。
## v0.010（package 0.0.10，schema 仍 14）

- 子卡的互斥判据从「同父卡一律串行」改成「**scope 重叠才串行**」：`lib/units.js` 新增 `scopesConflict` / `canRunParallel` / `scratchBranchFor`。
- 派工三条规则：有互斥兄弟在跑 → 共用父检出排队；只有不互斥的兄弟在跑 → 瞬时分枝 `unit/<parent>/<task>` + 自己的检出并行；没有兄弟在跑 → 仍走共用（并行的开销只在真要并发时才付）。
- 并行子卡验收：合进父分支 → isAncestor 校验 → 删瞬时分枝 → `done-in-parent`；落点过期时先 rebase 再合，仍冲突则 block 并写冲突文件（不静默丢改动）。
- 新配置 `unitParallel`（默认 `true`，`false` 回到 v0.009 全串行）。
- 新增 `test/unit-parallel.mjs`（16 checks）；`test/unit-shared.mjs` 显式关并行，继续钉共用检出那条路。
## v0.009（package 0.0.9，schema 仍为 14）

- `rollupParent` 按交付事实（子卡 phase）分类，结果写 `task.rollup`；`domain.recordRollup` 是唯一写入口。
- 全部落地 → 父卡 `mergeState = ready`；有 `done-no-commit` / `merged-skipped` → 写点名评论 + 叫醒调度，父卡保持 `pending`。
- `domain.review()` 拒子卡；`client.js` 去掉子卡的合并动作与「合并」行，加「交付落点」与父卡「子卡核对」行。
- `deliveryState` / `deliveryStateOf` 把 `done-in-parent` 归到 `merged-into-parent`（读侧语义相同：代码在父分支，未进 base）。
- 新增 `test/rollup-delivery.mjs`（5 checks）。
## v0.008（package 0.0.8，schema 14）

### 子卡是工作单元
- `needsMerge` 以**拓扑**判否：有父卡的卡永不走合并列（不再靠 `mergeState` 反推）。
- `accept` 对子卡落 `done` / `done-in-parent`；`merge_skip` / `review_approve` / `review_risk` 对子卡一律拒（文案说明「子卡不参与合并」）。
- 子卡与父卡**共用检出与分支**；派工抢 `unit:<parentId>` 租约，抢不到进 `phase=waiting-branch` 等下一拍。
- 子卡验收不靠自述：比较 `unitStartSha` 与父分支当前 HEAD；没前进就是 `done-no-commit`。
- 两处「子卡开 PR」的入口都加了守卫：`onMoved` 的 accept 分支、scheduler 的兜底补 PR。
- 迁移 13→14：存量子卡按「有没有自己的分支」分成 `shared` / `legacy-branch`；legacy 卡验收时把子分支合进父分支、删子分支、作废 PR 快照。

### PR 快照从 git 量
- `openPr` 用 `git diff --numstat base..head` 算 `files/additions/deletions/summary`，不再用 `commitAll` 的 `changed`（工人自己提交过时它恒为空）。
- `openPullRequest` 存这四个字段；同一 head 重开一次会把快照补回来（线上已判 risk 的卡自愈通道）。
- 审核包里写明「快照是实测的；为空且 head≠base 属取数问题，重开一次 PR 会重算；不要把修快照派给工人」。
## v0.007（未发布）

### 卡片可以回退（调度与人都能）

**问题**：正向动作的守卫都对（没走完生命周期不许推完），但走错一步没有退路 ——
线上 T-048 评审 settled、拆分草稿已定，卡却在 `verifying`：`flow_task_split` 只收 todo/planning，
`reject`/`rework` 的 `from` 也不含 verifying，四条路全堵，只能 取消 + 重开（`reopenCount` 涨一次，审计里像反复失败）。

**改法**：新增迁移 `rewind`。

- 允许的列：todo / planning / running / verifying / merging 中**更早**的一列（`REWIND_TARGETS`）；
- 必须带 `payload.targetColumn` 与 `payload.reason`（原因写进 history 与 `lastRewind`）；
- **不受冻结**：被阻塞的卡也能回退（`checkTransition` 里 rewind 与 cancel 一起豁免），退回去会清掉 `blocked`；
- 回退同时清掉上一轮 `stopReport` —— 否则 verifying 的自动验收会拿旧报告直接收；
- 有 `activeRunId` 时拒绝（run 的 stop 只认 running 列，退走了它就永远停不下来）；
- 终态（done / cancelled）不在来源列里：想再来一次用 `reopen`，两者语义不同。

**界面**：卡片详情新增「回退（退回更早的列）」卡片 —— 目标列下拉 + 原因输入 + 一次确认；
标题也说明了会清掉什么，避免人以为只是「改个列名」。

### 调度员自己的失败自动续跑

**问题**：调度员/主调度没有 run，被 503 这类环境错误打断时没人接手（v0.006 只处理了评审工位）。

**改法**：`resumeDispatcher` 给**同一个会话**再发一条 `queue` 消息，从断点继续（不重建会话，免得丢掉已读上下文）。

- 设置项：`dispatcherAutoResume`（默认开）、`dispatcherAutoResumeMax`（默认 5，1–10）；
- 人点「停止生成」**不续跑也不计数**（那是人的决定）；
- 连到上限就停，并投一条收件箱「系统错误」；同一工位只投一条，等人处理；
- 正常跑完一轮清零（续跑算成功）；计数在内存里（进程重启清零是期望行为，事实另存 `maintenance.lastSessionErrors`）。

为此 `askHuman` 新增 kind **`error`**（与 info 同形状：有 body、无 asks、可标已读、不能追问，但看板徽标与色调不同），
且 `settings.set` 从「整块重建」改成**合并**（否则每加一个设置项都可能被静默抹掉）。

### 新增测试

- `test/rewind.mjs`（12 checks）：verifying→planning、阶段清空、原因进 history/lastRewind、回退后 `splitTask` 可用、
  被阻塞也能退且清旗子、清 stopReport、有 run 拒、终态拒、无 reason 拒、向前退拒、目标非法拒、调度也能退。
- `test/dispatcher-resume.mjs`（10 checks）：默认续跑、文案要求从断点继续、计数递增、完成清零、人停不续、
  到上限停并投系统错误、不刷第二条、开关关闭不续、上限可配、未知会话不炸。
## v0.006 — 2026-11-08

主题：**「报错停止」也算停止事件** —— 没有 run 的会话出错时必须叫醒调度。

### 修的问题（线上事故）

需求评审的对话被 `SERVER 503 / model_not_found` 打断。DSH 照常发了 `turn/end`（reason.kind='error'），
但插件在 `onSessionEvent` 里按「有没有正在跑的 run」分流 —— 而**评审工位从来没有 run**
（它由 `promptSession` 驱动，不进 runs 表）。于是事件走到 `reason:'no-active-run'` 被静默丢掉：

1. 调度全程不知情，卡停在 `grill.status='running'`；
2. `grillStart` 有「评审正在进行中」守卫 → **这张卡从此不能再开评审**，只能人手工救。

### 行为变化

- `onSessionEvent` 在拿不到 run 时不再直接丢弃，改为 `handleNoRunFailure`：
  - 先落一条事实 `maintenance.lastSessionErrors`（sessionId / agentId / role / kind / reason / at，只留最近 20 条）；
  - 若会话属于某项目的**评审工位**：把正在等结论的那一轮判 `failed`（模型报错/内容问题）或 `interrupted`（人停止生成），
    记录 `lastError`、`failedRound`、`failedAt`，**把 `rounds` 退回上一轮**（失败的一轮不占配额，
    否则两次模型抖动就能把 `grillMaxRounds` 耗光），在卡上写评论，并 `notifyDispatcher(kind='grill-failed')`。
- 新增事件类型 `grill.failed`（`EVENT_OF_KIND['grill-failed']`），与 `grill.message` 分开：
  一个是「评审说话了」，一个是「评审这一轮根本没成功」，调度对这两件事的动作完全不同。
- `grill.failed` 走**紧急**通道（与其他 session 失败同等待遇）：评审停住时整张卡都在等结论，
  攒进聚合器没有意义。
- 调度员/chief 自己报错**只留事实、不发通知**：给自己发通知是自通知死循环，而它的错误在界面上本来就看得见。

### 兜底：轮次超时也收尸（`lib/scheduler.js` `reapGrill`）

有些情况下根本没有 `turn/end`：进程崩溃、会话被归档、provider 切换失败。那时 `grill.status` 会永远停在 `running`。
tick 新增一步 `grill`（排在 `stuck` 之后）：任一评审轮次超过 `grillStuckAfterMs`（默认沿用 `stuckAfterMs` = 30 分钟）没回信，
就判失败、写 `lastError`、**轮次退回**、评论、并 `notifyDispatcher('grill-failed')`。
为此 `deliverInjection` 在每轮开始时写 `grill.roundStartedAt` —— 不能用 `startedAt` 判超时（它只记整张卡评审的起点，会把第 2 轮一上来就判死）。
### 新增状态

- `store.maintenance.lastSessionErrors`（数组，最多 20 条）与 `domain.sessionErrors(limit)`。
- `task.grill` 新增 `lastError` / `failedAt` / `failedRound`，`status` 多了 `failed` / `interrupted` 两个值。

### 新增测试

- `test/session-error.mjs`（10 checks）：不再返回 no-active-run、判失败并记住错误原文、轮次回滚、卡上有评论、
  调度收到 `grill.failed`、失败后可重开评审、人停止生成时记 `interrupted`、调度员自己报错不发通知、
  未知会话安静丢弃、事件类型映射。
- `test/grill-stuck.mjs`（7 checks）：40 分钟不回信判失败、轮次退回、5 分钟不动、卡上评论、调度收到 grill.failed、
  幂等（同一拍不重复收）、`grillStuckAfterMs` 可调。
## v0.005 — 2026-11-08

主题：**远程 PR 结束后，本地卡按车道收口**。

这里的「PR」指 **GitHub/Gitea 上真实可见的 PR**，不是本地 `pull_requests` 快照。

### 行为变化

- **自动车道（`visibility='auto'`，不在看板上）**：远程 PR 一结束（被合了 / 被人关了），卡就地结束、不进生命周期管理。
  被合了 → 记合并事实后落 `done/merged`；被关了没合并 → 落 `cancelled/remote-ended`。
  结束不打扰人：不开请示，只留一条评论（`auto-lane` 巡检报告里也能看到）。
- **人车道**：远程 PR 结束后仍按正常生命周期走。
  被合了 → `review_approve` 落 `done/merged`（带远程的合并提交号）并通知调度员；
  被关了没合并 → 卡**不动**，开一条请示由人决定继续 / 重开 PR / 取消。
- 收口由调度按车道决定，**同步层只收集事实**（`refreshPulls` / `refreshExternalPulls` 产出 `ended[]`）。
  这条边界是为了不让同步层拥有生命周期决定权。
- 远程合并后本地 base 会尽力追一次（`git fetchBranch` + 集成检出 `advanceBase`）；追不上只如实评论，不假装本地也合了。
- 外部 PR 卡也会对账：只查还开着的外部卡（`external.state === 'open'`），避免每轮把已结束的打一遍。

### 新增迁移

- `remote_ended`：`merging | running | verifying → cancelled`，phase `remote-ended`，角色 `system` / `dispatcher`。
  为什么不复用 `cancel`：那条的 roles 只有 human ——「取消」是人的决定，这里结束卡的是**远程事实**。
  看板上也因此能区分「人取消」与「PR 结束自动收尾」。

### 新增测试

- `test/remote-closeout.mjs`（8 checks）：自动车道合并收口、幂等、自动车道被关就地结束且不打扰人、
  人车道合并收口并评论、人车道被关只开请示不动卡、外部卡同样规则且 `external.state` 落 closed。
## v0.004 — 2026-11-08

主题：**外部 PR 打架时也按正常 PR 流程走**。

### 行为变化

- **外部 PR 的冲突改为回派工人解决**（此前它会停在一次失败里等人）。
  做法和普通卡一致：`review_conflict` 退回 `running` → 派工 → 工人把 base 合进自己的分支解掉冲突 → 验收 → 重新合并；
  没有冲突时仍然一次自动合完。
- 工人那条分支**从 `external/pr-<n>` 拉出**，不是从 base 拉：否则「解冲突」会退化成「重新实现一遍别人的功能」。
  两个标记落在卡上：`external.resolver=true`、`external.baseRef='external/pr-<n>'`，合并成功后清掉。
- 回派出去的卡**不会再被 `kind==='external-pr'` 的派工守卫挡住** —— 守卫现在只放行「冲突解决轮」这一种情况。
- 合工人那条分支前会 `isAncestor` 校验它**仍然包含**外部 PR 的提交；丢掉了就退回按原始 PR 头合（不静默丢改动）。
- 外部卡**不吃 rebase 策略**：那会改写别人的提交历史，`mergeStrategy: rebase` 在外部卡上退化成 `merge`。
- `setExternal` 改成**补丁语义**：只覆盖真的给了的键。原来整块重建，会把 `number`/`headSha` 一起清成 null。

### 修掉的 bug

- `setExternal` 的整块重建会清掉 `external.number` / `headSha` —— 冲突回派后再合并直接判「这张外部 PR 卡没有 PR 编号」（本版踩到并修掉）。

### 仍然没做

- `blockMerge('not-a-repo')` 仍然是「没有编号」与「抓不到 ref」两种原因的同一个出口，文案只能靠 detail 区分。
- 外部 PR 被上游**关闭/合并**后，本地卡不会跟着关（`refreshPulls` 明确排除外部卡）。

### 新增测试

- `test/external-conflict.mjs`（7 checks）：冲突判回派、卡上标记、检出起点是外部提交、解决包要求 merge 而非 rebase、
  校验分支包含性、合并落地、标记清理、两边改动都在。
## v0.003 — 2026-11-08

主题：**一张卡 = 一分支 = 一 PR**（rf-01..rf-05 落地，实现票 C-00..C-11）。

### 行为变化（会当场看见的）

- **拆过卡的父卡持有集成分支** `flow/<父卡 id>`：子卡从父分支拉出、合回父分支，父卡收口时一次合进 base，对外**一个** PR。
  子卡落 `done / merged-into-parent`，`isDelivered` 为 false（代码仍在父分支上）。只允许两层，子卡不能再拆。
- **外部 PR 成为一种卡**（`kind: 'external-pr'`，开关 `recordPulls` 默认关）：代码从 `refs/pull/<n>/head` 抓到 `external/pr-<n>`，
  headSha 建卡时锁定，变了判 `blocked / head-mismatch`；合并仍在本机发生；合并后关远程 PR 并删抓取分支。
- **合并后关远程 PR**（`closePullOnMerge` 默认开）：`PATCH {state:'closed'}`，只关 PR 不删分支，失败只落评论不回滚。
- **`autoLane` 取代 `autoDispatch` 成为建卡开关**：未设置时回退 `autoDispatch`（升级不会停止建卡）；`autoDispatch` 现在只表示 running 补位。
- **`sync.since` 真的拦住建卡**：早于它的 issue 只落镜像（webhook 路径豁免）。为此 `listIssues` 与事件信封补上了 `createdAt`。
- **自动车道的卡默认不上看板**（`visibility='auto'`）：进「自动车道」折叠区，可一键拉上板；请示不受影响。
- **合并入口按 `mergeState` 守门**：`none` 拒；`blocked` 只有环境类可重试且带 10 分钟退避（`mergeRetryAt`）；契约类永不自动重试。
- **`needs-rebase` 语义修正**：先退回 `running` 再回派（以前回派的工人无法 `stop`），并在回派时清掉旧 head 的审核结论。
- **检出复用判据**：`ready` 才可派工；`blocked`（安装失败）复用同目录**重跑准备**而不是重建。

### 数据迁移

- `SCHEMA_VERSION` 12 → 13。任务新增 `kind`（默认 `card`）、`visibility`（默认 `board`）、`external`、`branchFrom`、`integrationBranch`。
- 迁移**刻意不给已有子卡回填 `branchFrom`**：那些子卡的分支是从 base 拉的，它们的父分支在 git 里不存在；回填会让它们下次派工被判 `branch-missing`。
- 新增配置键：`recordPulls`（默认 false）、`closePullOnMerge`（默认 true）。
- **`autoLane` 刻意不进 DEFAULT_CONFIG**：一旦有默认值，`=== undefined` 的升级回退就失效，存量项目会停止建卡。

### 修掉的 bug

- `merge()` 以前只看 `column`，不看 `mergeState`：已判 blocked 的卡每 15 秒被自动合并重试一次，45 秒内烧完 `rebaseAttempts`。
- `needs-rebase` 分支一次做两件相反的事（回派 + 阻断），且派工没有列守卫 → 回派的工人无法自停。
- `ensureWorktree` 复用判据不排除 `blocked`，且 `recordWorktree` 先于 setup/install 落库 → 装依赖失败的检出会被再次复用，依赖永远装不上。
- `removeWorktree` 默认拿项目 base 判断「分支合没合过」，把已合进父分支的子卡分支记成 `blocked / not-merged` 并覆盖 `mergeState`。
- 集成检出在「合过一次别的分支」后与目标分支分叉，`ensure` 直接判 `integ-diverged`，导致那条分支再也合不进来。现在先确认上次合并**已落到某条分支**才允许拨过去。
- `openPr` 的远程闸门挂在 `recordIssues` 上：关掉 issue 入站就发不出远程 PR。现在由 `recordPulls` 独立控制（兼容 `recordIssues`）。

### 新增测试

`schema13`（12）/ `merge-guards`（11）/ `automation-guards`（15）/ `panel-visibility`（12）/ `remote-closepull`（6）/ `external-ingest`（7）/ `external-merge`（8）/ `autolane`（12）/ `worktree-reuse`（6）/ `deliver-branch`（9）/ `view-contract`（5）—— 全部接进 `npm test`。

## v0.002 — 2026-11-08

主题：**检出变成可丢弃的脚手架**（ADR-0001..0006 落地）。13 张实现票 I-00..I-12 全部完成，每票单独跑过 `npm test`。

### 你会看到的行为变化

- **数据迁移一次**：`SCHEMA_VERSION` 11 → 12。`noMerge` 布尔 → `mergeState`（`none|pending|blocked|ready`）+ 原因枚举；
  迁移按人话 `noMergeReason` 归类（先认故障再认环境降级）。老文件首次加载即完成，幂等。
- **合并落进常驻集成检出** `<parent>/.flow-worktrees/<repo>/__integ__`，是个 detached 检出。
  代价：基础分支被它**占住**，你在主检出里 `git switch master` 会报 `fatal: already used by worktree`。
  设置页「释放集成检出」或 `integration.release` 可解除（需要合并时自动重建）。
  收益：合并队列不再挂在你的本地状态上（主检出脏着、切在别的分支都能合）。
- **越界检查**（补 ADR-0002 的缺口）：任务设了 `scope.paths` 且主检出里有未提交文件落在范围内 → 合并判 `blocked/out-of-scope-dirty`。
- **依赖不再默认链接**：`DEFAULT_SHARED_DIRS` 从四个目录收敛到空。新检出**没有**依赖，要么配置 `install.commands`，
  要么接受 `blocked/install-failed`。理由：链接制造假绿（主仓 `.venv` 166 包含 pytest，而 `requirements.txt` 128 行无 pytest）。
- **检出生命周期以 git 为权威**：`flow.json.worktrees` 降级为注释。启动时后台对账，tick 只读记录漂移。
  干净检出回收后已合并分支用 `branch -d` 删；**未合并的分支绝不 `-D`**，卡上留恢复指针。
- **看板出合并故障标**：`blocked` 出红/黄 chip + 修复动作，`pending` 出「等待合并」，`none`/`ready` 静默。
  T-012（基线分支不存在）、T-043（分支被残留检出占用）这类卡从此显形，不再与「本来就不用合」长得一样。

### 修掉的 bug（线上/真机）

- `run()` 会 trim 输出，越界检查把首行 ` M README.md` 切成 `EADME.md` → 检查静默放行。新增不 trim 的 `runRaw`。
- 路径不能比字符串：git 回正斜杠长名、node 手里是 8.3 短名 → 新增 `samePath()` / `findWorktree()`；
  同理 `normalizeKey` 对已消失目录改走 `realpath(dirname)+basename`（否则同一个 ghost 被拆成两条）。
- 隔离区先 `rename` 后 `prune` 导致 patch 永远取不到（线上 `.quarantine` 4 条全不可读）→ 改成**先取证据再 rename**。
- 删除失败仍 drop 登记 → 幽灵；`addWorktree` 失败降级 `path: repo` → 工人被塞进主检出（T-043 的直接来源）。两条路径都已删除。
- `currentBranch()` 在 detached 下返回字符串 `'HEAD'`，被 `mergeBranch` / `pushBranch` 当分支用 → 如实返回 `null`。
- 对账的登记表没按项目过滤 → 跑 A 项目的对账会把 B 项目正在用的检出**归档**（真机复现，数据丢失级）。

### 新增配置

`setup` / `install`（`{ commands: string[], timeoutMs? }`）、`sharedDirs`（默认空）、
`worktreeReconcile` / `worktreeReconcileIntervalMs`、`quarantineTtlMs`、`lockRunningWorktrees`、
`integrationCheckout`、`outOfScopeCheck`、`deleteMergedBranches`。

### 新的出口

`flow_integration`（`status` / `release`）、HTTP `integration.status` / `integration.release`；
设置页「集成检出」段。

### 出界（明确不做）

会话 cwd 进检出（需 DSH 内核改动，ADR-0002 已记录）；`.worktreeinclude`；温检出池；容器/VM 隔离；迁移 jj；functest 那批测试债。
## v0.001 — 2026-11-08

版本线重启 + 建立仓库。

- 新建 git 仓库（`main` 分支），把现有代码作为基线入库；此前所有备份目录（`.backup/`、`.bak-20261107/`、`.bak-v139/`）与 CodeGraph 索引不进库。
- 版本号从 `1.0.0` 重启为 `0.0.1`（展示名 v0.001）。**数据 schema 不变**：`SCHEMA_VERSION` 仍为 11，`~/.dsh/flow/flow.json` 不受影响。
- 本版本**不含功能改动**，代码等同于 v1.39.1。
- 附带 `.wayfinder/map.md`：worktree 工作流的地图与六张决策票（wf-01 … wf-06），以及 `docs/worktree-工作流.md` 方案正文。

→ v0.002 已承接「worktree 工作流深化」（见上）。
