# dsh-flow

当前版本：**v0.014**（`package.json` = `0.0.14`；npm 版本号不允许前导零，故展示名与字段值分开）

数据 schema：**15**（v0.012 是 15、v0.011 是 14、v0.002 是 12、v0.001 是 11；首次加载自动迁移，见 CHANGELOG）

DSH 插件：调度台工作台。把「需求 → 拆解 → 派工 → 工人 goal 自循环 → 停止分类 → 验收 → PR 审核 → 合并」做成一条带事务的记录流。

## v0.015：六问报告 + 反循环（少打扰人，但打扰对的人）

线上 BiliNote 的教训：T-055 在 36 分钟里跑了 5 个 run、被返工 3 次、4 次巡检告警 no-diff ——
而它缺的是隔离环境的真实凭据，**不是工人能干的活**。每一轮工人只能交回同一份说明，调度只能再要一次。

这一版加了三道闸，都是「让循环自己停下来」的：

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| **六问报告** | `stopReport.problem/cause/impact/fix/regression/design` | 停止报告必须能回答这六个问题；缺哪几项记进 `sixMissing`，事件包里直接显示 `六问: 3/6 · 缺 impact、regression` |
| **返工频控** | `domain.move('rework')` | 同一张卡 20 分钟内第 3 次返工被拒，报错里直接给三条替代动作（block / steer / rewind） |
| **no-diff 升级** | `inspect-signals.js` | 连续两轮无改动仍是 steer；**连续三轮升级为 block**，不再继续派工 |
| **验收证据分两类** | 调度提示词 | 写验收时要分清「系统可验」（commit/diff/退出码）与「需环境或人提供」；后者不写成硬闸门，否则工人永远满足不了 |

## 放权：模型自己决定的事，不再问人

调度员内置规则新增一张清单。能靠代码和事实自己验出来的决定，全部自己做：
返工范围、补哪些测试、要不要拆卡、子卡排序、合并策略、PR 文案、什么时候放弃一条路。

只有五类事才进请示箱：改设计方向/公共接口/数据格式、要凭据或真实环境、删或迁移数据、不可回滚操作、
两个方案都合理且影响钱或用户可见行为。**问人之前先自问：我自己查一次代码能不能回答？**

## v0.014：回复完，留在原地

v0.013 的消息流有一个用起来很别扭的地方：**回完一条就被弹到别的工单**。
原因是发送成功后客户端会重新拉列表 —— 那条工单变成「已答复」，在「待我回」里不再成立，
选中项顺势落到下一条。人刚写完一段话，读的上下文没了，也看不到自己刚发出去的那一条。

现在：

| 行为 | 说明 |
| --- | --- |
| **不跳走** | 发送成功后就地更新这张工单（状态 → 已答复、把新回复追加进消息流、计数 -1/+1），选中项不动 |
| **留在当前 tab** | 这条工单以「刚回复」标记留在列表里（`keep`），直到你切 tab 或点别的工单 |
| **消息流停在原处** | 新回复出现在底部并自动滚到底 |
| **不闪** | 刷新列表不再先清空 items（原来会闪一下，选中项在数据回来前无处可落） |
## v0.013：右侧是一条消息流，不是一个表单

v0.012 把工单箱做成了邮箱，但右栏仍然是一张竖着铺开的表单：组件、问题、现状、asks、建议、回复区，
从上到下排下来，人要先「读表」再「回信」。v0.013 把右栏改成**一条对话**：

| 之前 | 现在 |
| --- | --- |
| 右栏整体滚动，标题也滚走 | 顶部**标题条**固定（类型 · 标题 · 卡号 · 状态 · 时间/来源/进度/往来） |
| 组件与正文次序固定、混在一起 | 工单正文是**第一条消息**，之后的每次回复各是一条消息 |
| 回复区是一个 textarea + 提交按钮 | 输入区有**引用 / 附文件 / 采纳推荐 / 未答计数**，`Ctrl+Enter` 发送 |

**不用气泡**：气泡把内容挤成窄条，长段落、表格、diff 会碎掉；工单正文往往很长。
所以用「一行角色 · 时间 + 左对齐正文 + 发丝线分隔」，靠间距而不是底色区分谁说了话。

- **引用**：鼠标移到任意一条消息上出现「引用」，或在输入区点「引用」取上一条；引用以 Markdown 引用块写进正文，
  调度看到的就是人看到的那一段（不藏在系统字段里）。
- **附文件**：输入区可挂文件路径或链接，发送时转成工单组件（`evidence` / `link`），与调度写的是同一套白名单。
  人回复因此也能「只挂一份证据、不写正文」。
- **已读静默**：`inbox.read` 是顺手做的事，失败不再弹红条（老服务端没有这个 action 时，人只会看到工单一切正常）。
## v0.012：工单箱改成邮箱 —— 一次只读一条

inbox 原来把**所有工单的全文**竖着铺在一列里。信息是全的，但人滚到第三条就忘了第一条要答什么 ——
问题不是信息多，是**没有焦点**。v0.012 把它改成两栏：左收件列表，右**只显示选中的那一条**。

| 左栏 | 右栏 |
| --- | --- |
| 待我回 / 已回复 / 通知 / 归档 四个 tab + 搜索 + 收件行（未读点、类型、标题、卡号、进度） | 概况条 → 预设组件 → 问题 → 现状 → 影响 → 需要你补充 → 调度建议 → 处理记录 → 回复区 |

「已读」与「已处理」是两回事（`readAt` vs `status`）：看过不等于回完。未读点会随选中消失，
但工单在你回复前仍然留在「待我回」。

**预设组件**：调度现在能随工单/追问带九种结构化积木，人在界面上直接动手，而不是读一大段中文：

| 组件 | 人看到什么 |
| --- | --- |
| `choice` 快捷选项 | 按钮组，点一下即填进你的回答（有同名 ask 时直接写进那一项） |
| `facts` 现状卡片 | 3–6 行键值，比散文好扫 |
| `evidence` 证据徽标 | `commit:4293589`、`file:lib/x.js` 这类等宽小签 |
| `link` 网络徽标 | issue / PR / CI / 外部链接（只放行 http(s)，`javascript:` 直接丢） |
| `progress` 进度条 | 验收 3/5、子任务 2/8 |
| `diff` 变更摘要 | `3 文件 +120/-8  c011bbd → c8594a1` |
| `checklist` 清单 | ☑ / ☐ |
| `code` 片段 | 等宽、可横滚（≤2000 字符） |
| `note` 提示条 | 一句必须看见的话（tone: info / warn / danger / ok） |

组件是**白名单 + 纯文本字段**：AI 写的 HTML 是执行入口，不是内容 —— 所以组件只能有受控的几种形状，
未知类型与超长文本在服务端就被丢掉（`lib/inbox-blocks.js`），坏一块不会让整条工单发不出去。

顺带修掉的线上 bug：回信时报 `(store.state.runs || []).find is not a function` —— `runs` 是字典不是数组。
现在回信的成功与否只反映「回复本身」，顺手 steer 在跑的工人失败会记成 `steerFailed` 并留一条 message_log，
不再出现「报错但其实已经回进去了」。

数据侧：`SCHEMA_VERSION` 14 → 15（补 `blocks` / `readAt`），列表接口新增 `kind` / `q` / `offset`，
新增 `inbox.read`（只标已读，不动状态）。
## v0.011：三层密度 —— 看板扫一眼，抽屉看一张卡

416 行的调度台视图里，一屏同时摆着顶栏 8 个按钮、16 个统计数字、2 张车道卡、7 列看板、自动车道和系统活动。
信息都在，但**没有一个是在这一秒要用的**。v0.011 把它重新拆成三层，每层只回答一个问题：

| 层 | 回答 | 看到什么 |
| --- | --- | --- |
| 看板 | 现在哪儿卡住了？ | 7 列、每卡 3 行、最多 2 枚徽标（其余收进 `+N`） |
| 抽屉 | 这张卡什么状态、我要做什么？ | 结论条 + 当前进展 + 讨论 + 验收 + 操作，其余折叠且标题带摘要 |
| 归档 | 系统整体健康吗？ | 自动车道、6 个主指标，其余进「全部统计」 |

具体改了六处：

1. **顶栏收口**：初始化仓库 / 清理并重建会话 / 同步 issue 进「更多」；**停止全部调度常驻**（安全阀不能藏）。
2. **统计只留 6 个**：任务 / 执行中 / 阻塞 / 待验收 / 待答复 / Token —— 会让人立刻动手的那六个；其余进折叠。
3. **车道合成一行**：`人直派 · 1 调度 / 2 工人 · 在跑 1`，上下文水位只在超过 70% 时以 2px 细条出现。
4. **卡片三行两徽标**：优先级由服务端算（blocked > 合并受阻 > 高风险 > 评审待定 > 等分支 > 待合并 > 交付态），
   看板只负责画前两枚，溢出显示 `+N`。六枚并排时每张卡都像告警，等于没有告警。
5. **抽屉折叠**：结论条给出「列 · 阶段 · 一句话现状 · 主操作」；工作包八问、子任务、状态、回退、回信、
   停止报告、运行记录默认收起，但每个标题后面都印一句摘要 —— 折叠的成本是「看不见」，摘要就是这笔成本的利息。
6. **列可收起**：七列并排时人通常只看两三列；列头点击即收起成 46px 竖条，空列本来就只有 108px。

语义只在 `lib/view-model.js` 一处：谁说什么、徽标优先级、折叠默认值。`lib/panel.js` 把结果投影成
`task.view`，客户端只画 —— 删掉它，客户端就得重新实现一遍优先级，并立刻长回第二份 `MERGE_REASON`。

**没做的两件事**（已在 `.wayfinder/map-ui.md` 记为 defer）：设置页 6 个 tab 合并成 4 组、Inbox 分区折叠；
以及 CSS 类名收敛（255 → 150）。它们都在「一天开几次」的归档层，先把主屏改完发布，比一次改到底更稳。
## v0.010：互斥由 scope 决定，不是「只能串行」

v0.008/v0.009 把 `git` 的物理约束（一条分支同一时刻只能被一个检出持有）直接翻译成了调度规则：
同一父卡下的子卡一律共用父检出、一律排队。这过头了 —— 两张改**不相干文件**的子卡本来可以同时干。

**现在的规则**：

| 情形 | 行为 |
| --- | --- |
| 兄弟子卡的 `scope.paths` / `scope.symbols` **有重叠** | 互斥：共用父检出，抢 `unit:<parentId>` 租约，抢不到进 `phase=waiting-branch` |
| 兄弟子卡**不重叠** | 并行：给一条**瞬时分枝** `unit/<parentId>/<taskId>` + 自己的检出，验收时合进父分支、删掉瞬时分枝 |
| 某张子卡**没写 scope** | 视为与所有兄弟互斥（保守：宁可串行，不要撞车） |

互斥只对**正在跑**的兄弟成立，不是整批串行：A 与 B 互斥、A 与 C 不互斥时，C 可以跟 A 一起跑。

**瞬时分枝对人是不可见的**：不开 PR、不进审核、不进合并列、不留分支（验收时删掉）。
它存在只是因为「要有第二个 HEAD，就必须有第二条分支」——这是 git 的物理约束，不是流程设计。

**代价与开关**：并行检出卖要各装各的依赖（ADR-0003：不共享 `.venv`/`node_modules`），一张子卡多 30–60 秒。
项目配置 `unitParallel: false` 可以回到 v0.009 的全串行。

**合并竞态**：A 先合并推进了父分支、B 基于旧头 —— B 落点时先 rebase 到父分支再合；仍冲突就标 blocked 并把冲突文件给工人，不会静默丢改动。
## v0.009：收口时核对「这块活到底进没进父分支」

v0.008 让子卡不再进合并列，但父卡收口时仍只看 `column === 'done'` —— done 有五条来路，
其中 `done-no-commit`（在父检出里一个提交都没有）与 `merged-skipped`（显式不合并）的活
根本没进父分支。父卡看起来「子卡都齐了」，实际少一条支线，而这件事在看板上没有任何痕迹。

**现在**：`rollupParent` 逐张子卡按**交付事实**分类，结果落在 `task.rollup = { delivered, undelivered, headSha, at }`：

| 子卡 phase | 归类 | 算缺口 |
| --- | --- | --- |
| `done-in-parent` / `merged-into-parent` | delivered | 否 |
| `done-no-commit` | no-commit | **是** |
| `merged-skipped` | skipped | **是** |
| `done-no-merge` | no-merge | 否（本来就没有可合的） |
| `cancelled` | cancelled | 否（人的决定） |

- 全部落地 → 父卡 `mergeState` 由 `pending` 推成 **`ready`**（这句写在 `markParentIntegration` 注释里，但一直没人实现）。
- 有缺口 → 父卡照样进待验收（人要看得到），但**不会**自己变 ready（否则 autoMerge 会在一张缺支线的父卡上自动开合），并写一条点名评论 + 叫醒调度。
- 详情页多一行「子卡核对」：全部落地显示 `全部落地（N 张）`，有缺口则红字列出 id。

**界面同时补的三处**（子卡的交付面只有父卡，界面得跟上）：
- 子卡详情不再显示「合并」行（以前显示「不走合并（no-code-change）」，一句既不准确也不解释任何事的话）。
- 「交付」行对工作单元改成「交付落点 · `flow/<parentId>`」——写具体分支名，不然人还得回去翻父卡（T-049 那次就是这么绕不回来的）。
- 子卡的「验收通过」按钮不再写「→ 合并」，也没有 `pr_open` / 审核 / 跳过合并这些动作。

**顺带的守卫**：`domain.review()` 对子卡直接拒（`子卡不参与审核…`）。状态机已经让它进不了 merging，但 tools/http 这些旁路仍能调到领域方法 —— 判据放在汇合点才拦得住。
## v0.008：子卡是工作单元，不是小卡

**你会看到什么**：子卡不再有 `merging` 列、不再开 PR、不再被审核。它跑完就是 `done`，阶段 `done-in-parent`；
父卡收口时才开那唯一一个 PR。

**为什么**：线上 T-049（子卡）在 `merging` 里被判 risk，理由是「PR 快照 files=- / diff=+0/-0」。
工人其实提交了 2 个文件 +1094 行 —— 一个是取数口坏了（本版已修：快照从 `git diff --numstat base..head` 量），
另一个更根本：**子卡压根不该出现在合并列**。子卡是内部拆解，对外只有一个可评审单元，就是父卡。

**形态**：

| | 父卡 | 子卡（工作单元） |
| --- | --- | --- |
| 分支 | `flow/<parentId>` | 没有（与父卡共用） |
| 检出 | 自己那一个 | 与父卡共用 |
| 列 | … verifying → merging → done | … verifying → done（`done-in-parent`） |
| 对外 | 一个 PR、一次审核、一次合并 | 无 PR / 审核 / 合并 |
| 完成判据 | `phase=merged` 且 `mergedCommit` 有值 | 父分支 HEAD 比派工时前进了 |

**代价**：同一父卡下的子卡**串行**（第二个进 `phase=waiting-branch`）。git 的硬约束是「一条分支只能在一个检出里」，
共用检出就必然排队；要并行就得回到一卡一分支，那正是本版否掉的形态。

**存量**：迁移（schema 13→14）给已经在飞的子卡打 `unitMode=legacy-branch`；它们在验收时把子分支合进父分支、
删掉子分支、作废 PR 快照，然后落 `done-in-parent`。不硬改历史，但也不再产生新的子卡 PR。
## v0.007：卡片能回退，调度员会自己续跑

两件都是「流程走错一步、或环境抖一下」时的出路：

1. **回退 rewind** —— 把卡退回更早的列（todo/planning/running/verifying/merging 之一），必须写原因。
   硬守卫仍然只拦「没走完生命周期就推完」；**回推不冻结**，被阻塞的卡也能退（退回去会清掉阻塞标记与上一轮停止报告）。
   终态的卡想再来一次请用 reopen（语义不同：那会清快照并计入重开次数）。界面在卡片详情的「回退」卡片里。
2. **调度员自动续跑** —— 调度/主调度自己那轮被 503 这类环境错误打断时，系统给**同一个会话**再发一条消息从断点继续。
   默认开启，最多连续 5 次（设置里可调）；人点「停止生成」不续跑；到上限就停，并往收件箱投一条「系统错误」等你处理。

## v0.006：报错停止也算停止事件

没有 run 的会话（需求评审工位、调度员自己）报错时，插件以前会把 `turn/end(error)` 判成 `no-active-run` 丢掉 ——
于是评审被 `SERVER 503` 打断后，卡永远挂在 `grill.status='running'`，既没人被通知，也再也开不了新一轮评审。

现在：

- 先落一条事实 `maintenance.lastSessionErrors`（谁、什么错、什么时候，留最近 20 条）；
- 若出错的是**评审工位**：这一轮判 `failed`（模型报错）或 `interrupted`（人停止生成），在卡上评论，
  `notifyDispatcher(kind='grill-failed')` 走紧急通道叫醒调度；**轮次回滚**，失败的一轮不占 `grillMaxRounds` 配额。
- 调度员/chief 自己报错只留事实、不发通知（避免自通知死循环）。
## v0.005：远程 PR 结束后，本地卡按车道收口

这里的「PR」指 GitHub/Gitea 上真实可见的 PR（不是本地快照）。

| 车道 | 远程被合了 | 远程被关了（未合并） |
| --- | --- | --- |
| **自动**（`visibility='auto'`，不上板） | 落 `done / merged`，就地结束 | 落 `cancelled / remote-ended`，不进生命周期、不打扰人 |
| **人**（`visibility='board'`） | 落 `done / merged` + 通知调度员 | 卡不动，开请示：继续 / 重开 PR / 取消 |

同步层只收集事实（`ended[]`），收口由调度按车道做（`dispatcher.closeoutRemote`）。
远程合并后本地 base 会尽力追一次，追不上如实评论，不假装本地也合了。
## v0.004：外部 PR 打架时也按正常 PR 走

外部 PR（别人提上来的）现在和普通 PR 一样处理：

- **没冲突**：审核通过后一次自动合进 base，合完 `closePull` 关掉远程 PR。
- **有冲突**：卡退回 `running` 派工，工人在一条以 **外部 PR 提交为起点**的本地分支上 `git merge` base、解掉冲突、`stop`；
  验收后重新进合并列，自动合第二次 —— 这次合的是工人交上来的那条分支。
  合之前会校验它**仍包含**外部 PR 的提交，防「解冲突时把别人的改动丢掉」。

外部卡不走 `rebase` 策略（会改写别人的提交历史），也不吃 `headSha` 之外的新提交（变了就停，等人确认）。
## v0.003：一张卡 = 一分支 = 一 PR（rf-01..rf-05 落地）

这一版把「卡怎么交付」这摊知识收进了一条流水线。行为变更如下，都是会让人当场看见的。

### 子卡不再各自开 PR：父卡持有集成分支

拆过卡的父卡现在有一条 `flow/<父卡 id>` 的**集成分支**：

- 子卡派工时从**父分支**拉出（不是从 base），合并时也合回父分支；
- 子卡落 `done / merged-into-parent`，但**不算已交付**（`isDelivered` 为 false）——它的代码还在父分支上；
- 全部子卡完成后，父卡把集成分支合进 base，**对外只有一个 PR**；
- 只允许两层：拆出来的子卡不能再拆（`splitTask` 会拒）。

为什么不让子卡共用父卡检出：`workers=2` 是默认并发，两个子卡在同一目录里改同一份工作区，git 的 index.lock 与互覆盖是**静默**的。
也不让子卡各开 PR：那会把一个可评审单元拆成 N 个，正好卡在真正的瓶颈（评审带宽）上。

### 外部 PR 变成一种卡（`kind: 'external-pr'`）

打开 `recordPulls` 之后，别人开的 PR 会被拉进看板，落在**合并列**，没有检出、永不派工：

- 代码来源是 `refs/pull/<n>/head`，抓到一条一次性的本地分支 `external/pr-<n>`；
- **建卡时锁定 headSha**：他后来推了新提交 → 卡变 `blocked / head-mismatch`，等你确认，不会偷偷合；
- 合并**仍在本机进行**（不调 forge 的 merge API）——本地 base 是否真的前进，只有一个真相；
- 合并完成后关掉远程 PR，并删掉那条抓取分支。

### 合并后关远程 PR（`closePullOnMerge`，默认开）

以前本地合了、远程 PR 一直开着：仓库里看到「13 个开着的 PR」，看板上写着「已合并」。
现在合并落地后显式 `PATCH {state:'closed'}` —— 不依赖 forge 会不会自己认领（那是我们没法测试、也没法承诺的外部行为）。
**只关 PR，不删远程分支。** 关不掉只留一条评论，不回滚本地合并。

### 自动车道（`autoLane`）不再混进看板

- 新开关 `autoLane`：只管「接管远程 issue → 建卡 → 派工」。没设过时**回退**到 `autoDispatch`（升级不会突然停止建卡）。
  `autoDispatch` 从此只表示「running 列补位」。
- `sync.since` 现在真的拦住建卡：早于它的 issue **只落镜像**，不建卡（webhook 来的不受限 —— 那是刚发生的事）。
- 自动车道的卡默认 `visibility='auto'`：不上看板，进「自动车道」折叠区（计数 / 需人处理置顶 / 最近 20 条 / 可一键拉上板）。
  请示不受可见性影响 —— 卡住了照样进收件箱。

### 合并入口的守卫变严了

- `merge()` / `mergeLocked()` 都看 `mergeState`：`none` 一律拒；`blocked` 里只有**环境类**原因允许再试
  （`out-of-scope-dirty` / `base-missing` / `branch-busy` / `push-failed` …），契约类（`head-mismatch` / `not-merged`）永不自动重试。
- 自动合并对环境类 blocked 有 **10 分钟退避**（`mergeRetryAt`），不再每 15 秒撞一次 git。
- `needs-rebase` 不再自相矛盾：先把卡退回 `running` 再回派工人软合并（以前派出去的工人根本无法 `stop`）。

### 检出复用的判据改了

`state === 'ready'` 才等于「可以派工」。`blocked` 的检出（安装失败）不再被当成可复用目录：
下次派工会**复用同一个目录重跑准备**（而不是重建 —— 重建要再装一遍依赖），装好了才写 ready。

## v0.002：合并落进集成检出（ADR-0004）

这一段是**行为变更**，不是重构说明：如果你的项目是 git 仓库，合并现在发生在一个独立检出里。

### 你会看到什么

- 仓库旁边多一个 `.flow-worktrees/<repo>/__integ__` 目录。它是**常驻**的，不是每次合并建一次。
- 它默认把**基础分支占住**。于是你在主检出里 `git switch master` / `git switch main` 会报
  `fatal: '<base>' is already used by worktree`（exit 128）。这不是坏了，是设计代价。
- 想在主检出里切回基础分支：设置页点「释放集成检出」，或调动作 `integration.release`。
  需要合并时会自动重建。
- 集成检出**不**等于任务检出：它不装依赖（ADR-0003），所以依赖环境类的 `postMergeCheck`
  在它里面跑会失败。真要在合并后跑依赖测试，得先让它能装上（`install.commands`，见下）。

### 为什么值得这个代价

原来的合并发生在**人的检出**里，于是两个前置条件被写死：主仓库 `status` 必须干净、当前检出的分支必须正好是 base。
等于把合并队列挂在开发者本地状态上——人切个分支、留个未提交文件，别人的卡就合不进来。

现在合并的落点是集成检出，主检出爱脏就脏、爱在哪个分支就在哪个分支。
代价是上面那条 base 被占；收益是合并队列跟人的本地状态彻底解耦。

### 越界检查（ADR-0002 的补偿）

落点一搬走，主仓库「必须干净」这层顺手的保护就没了。补回来的是显式检查：
**任务设了 `scope.paths`** 且主检出里有未提交文件落在那个范围里 → 合并被拦下判 `blocked/out-of-scope-dirty`，
评论里列出文件名。要放行：`flow_pr_merge` 带 `overrideOutOfScope: true`（会记一条授权评论）。
没设阅读范围的任务不做这个检查——人的日常编辑不该被当成越界。

### 合并失败的分类（不再一律当冲突）

| 判据 | 处理 |
| --- | --- |
| 代码真打架（`conflict`） | `review_conflict` + 回派原工人软合并 |
| 分支落后 base（`needs-rebase`） | 回派一次软合并，**上限 3 次**；之后停下等人 |
| 环境没准备好（集成检出脏 / base 被别的检出占着 / 要覆盖人的未提交改动 / 推送失败） | `blocked` + 人话评论，**卡不动、不派工** |

合并锁从 60s 提到 **10 分钟**并且每 30s 续租；进程重启时 `recoverRuns` 会清掉 `merge:` 前缀的幽灵锁，
否则重启后的十分钟里这个仓库谁都合不了。
## v0.002：检出准备（ADR-0003）—— 依赖各装各的，默认不再链接

这一条也是**行为变更**：新建的检出现在**没有**依赖，`node_modules` / `.venv` 不会再从主仓库链进来。

### 你会看到什么

- 工人第一次跑测试会报「模块不存在」。这是**预期**的：检出里只有版本库里的文件。
- 想让它能开工，在项目配置里写 `install`：

  ```json
  { "install": { "commands": ["uv sync --frozen", "pnpm install --frozen-lockfile"], "timeoutMs": 600000 } }
  ```

  建出检出后按序执行，cwd 就是那个检出。任一条非零退出 → 卡标 `blocked/install-failed`、评论写明是哪条命令、**这一轮不派工**。
- `setup` 同形状，先于 `install` 跑（拷 `.env`、建本地数据目录这类低成本准备）。
- 想共享只读目录（文档、样例数据）：`sharedDirs: ["docs-fixtures"]`。**别把 `.venv` / `node_modules` 写进去**。

### 为什么不再链接（真机实测）

`backend/.venv` 里有 166 个包（含 pytest、2GB nvidia），而 `requirements.txt` 只有 128 行且**没有 pytest**。
链接之后工人跑测试用的是**主仓库的环境**：绿了不说明这次改动对，红了也不说明错。
成本也不是问题：热 store 上 `uv pip install --link-mode hardlink` 5.6s / +11MB、`pnpm install --frozen-lockfile` 48.9s / +114MB，
而 `git worktree add` 只要 1.1s —— **检出不是成本，装依赖才是**，且这件事该由 install 命令诚实做一次。

### 已知限制

没有 lockfile 的项目（比如 BiliNote 的 `requirements.txt` 缺 pytest、无 `uv.lock`）装不出可复现的环境。
这是仓库侧的债，本版本不替它猜版本：install 命令怎么写就怎么装，装不出来就是 `install-failed`。

## v0.002：检出对账（ADR-0006）

git 是**存在性权威**，`flow.json` 里的登记表只是注释。两边不一致时以 `git worktree list --porcelain` 为准。

### 你会看到什么

- 启动时后台跑一次对账（不阻塞就绪），日志里可能出现
  `worktree reconcile: 3 action(s) · drop-record,archive-dir,unlock`。
- tick 只**记录**漂移，不动仓库：结论写在 `store.maintenance.worktreeDrift`。
  为什么 tick 不动手：它 15 秒一次，而「检出建好 → 登记写进去」的窗口是秒级的 ——
  让高频无人值守循环有权删目录，判错一次就删掉正在干活的现场。
- 干净检出回收后，已合并的分支会被删（`branch -d`）；**没合并的分支绝不 `-D`**，
  卡上留一条「分支未合进 base，没有删」的评论并给出恢复指针。

### 五种不一致

| 分类 | 含义 | 处理 |
| --- | --- | --- |
| `in-sync` | git 有、登记有、目录在 | 不动 |
| `ghost` | git 有、登记有、**目录没了** | 收口登记，卡上留「对账」评论 |
| `stale-record` | 登记有、git 与磁盘都没有 | 删登记 |
| `orphan-dir` | 目录在、git 与登记都没有 | 10 分钟内不动（grace）；空目录删，非空归档到 `.quarantine/orphan-*` |
| `branch-busy` | 同一分支被两个检出占用 | 只报告，等人判断 |
| `external` | git 有、登记没有（别人手工建的） | 不动 |

开关：`worktreeReconcile: false` 整个关掉；`worktreeReconcileIntervalMs` 调 tick 节流（默认 6h）。
## 装法

```bash
cd ~/.dsh/profiles/web
npm install "file:C:/Users/Administrator/Desktop/prjs/dsh-flow"
```

然后在该 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-flow
      name: "@local/dsh-flow"
```

重启 DSH。工作台地址：`http://127.0.0.1:3080/api/flow/app`；
**主页面右下角会出现一个「调度台」浮标**，点它直接开工作台（新标签页）。

## 入口与路由注册（当前 DSH 接口）

插件只用官方扩展点，三条都踩过坑，改动前先看这里：

1. **路由**：`ctx.inject(['webServer'], …)` → `webServer.register({ kind: 'prefix', path: '/api/flow', handler })`。
   不能用 `connection.fetch.register({ path: '/api/flow' })`：它按**精确 pathname** 匹配（`dsh-client-connection` 的
   `createSharedFetchHandler`），`/api/flow` 覆盖不到 `/api/flow/app`，浏览器会拿到 404「not found」。
2. **鉴权**：handler 是 `(req, res)`，先把 node 请求桥成 `Request`，再 `connection.admit(request)`；
   被拒时按 `admission.rejection` 回 401/403，通过才进 `lib/http.js`。响应体按块写回，SSE 才是真流。
3. **入口**：订阅 `webserver/index-inject`，往表里 push `{ kind: 'style', text }` 和
   `{ kind: 'html', placement: 'body', html }` 两行；`WebServer.renderIndex` 会把它们插进 index.html。
4. **读服务**：`ctx.reflect.get(name, false)`（Cordis 官方「无 inject 要求」读取入口）。Cordis 的 Context 没有
   `ctx.get()`，未声明 inject 的服务直接 `ctx[name]` 会抛 `cannot get property "..." without inject`。

## 数据

单文件真相源：`<DSH_HOME>/flow/flow.json`（默认 `~/.dsh/flow/flow.json`），
原子写（tmp + rename），schemaVersion 迁移，进程内单写者队列。
文件布局与设计文档 9.1 的表一一对应：projects / tasks / task_comments / runs /
agents / agent_sessions / approvals / merge_requests / leases / events / outbox /
review_prompts。

## HTTP

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/flow/app | 工作台页面（单文件，无构建） |
| GET | /api/flow/state | 全量快照（项目、任务、代理、配置） |
| GET | /api/flow/stream | SSE 事件流（Last-Event-ID 续传） |
| GET | /api/flow/chat/stream | 兼容 SSE：某个真实会话的 transcript（`?agentId=`/`?sessionId=` + `&since=`）；原生侧栏不经过该路由 |
| POST | /api/flow/action | 统一动作入口 {action, args}，44 个 action（v1.0 新增 8 个） |
| GET | /api/flow/overview | 全项目总览（v1.0）：totals + 每项目双车道 + 最近事件 |
| GET | /api/flow/health | 计数：项目/任务/在跑 run/worktree/未消费事件 |
| GET | /api/flow/events | 事件收件箱（?projectId=&limit=） |
| GET | /api/flow/worktrees | 所有任务 worktree |
| GET | /api/flow/worker/:agentId/log | 投递审计（谁给谁投了什么、成没成） |
| POST | /api/flow/hooks/:source | webhook 入口：验签（HMAC-SHA256）→ 归一化 → 去重入库 → 202 |
| GET | /api/flow/workspaces | 可选工作区列表（新建项目用）：id/title/path/会话数/已绑 projectId |
| GET | /api/flow/task/:id | 任务详情页一次取全：task + comments + runs + events + worktree + PR + mirror |
| GET | /api/flow/sessions | DSH 里可见的会话列表（v0.5 兼容接口）：sessionId / cwd / model / running / boundAgentId |
| GET | /api/flow/agent/:id/session | 该代理的 DSH 会话（没有时按代理配置创建，嵌入侧栏用） |

## 工具

`flow_board`、`flow_task_create`、`flow_task_move`、`flow_task_comment`、
`flow_message`、`flow_worker_steer`、`flow_worker_reset`、`flow_pr_review`、
`flow_config`、`flow_pr_open`、`flow_pr_merge`、`flow_worktree`、`flow_worker_log`、
`flow_worker_inject`、`flow_issue_sync`（共 15 个）。

v1.0 新增 6 个：`flow_publish`（调度模式发布大 issue）、`flow_scope_set`（阅读范围）、
`flow_lane`（双车道）、`flow_agent_reparent`（改派）、`flow_budget`（上下文水位）、
`flow_inspect`（巡检结论落库），共 21 个。

## 开发与验证

```bash
cd C:/Users/Administrator/Desktop/prjs/dsh-flow
node test/smoke.mjs     # 245 条断言：状态机守卫 / 租约 fencing / outbox / 派工 / 巡检 / 聊天帧 / HTTP /
                        #   真 git 仓库里的 worktree→PR→合并→冲突回派 / 事件去重 / webhook 验签 / tick 卡死+补位
node test/host.mjs      # 宿主契约：假 Cordis ctx 验证官方扩展点、会话路由与 SSE 桥接
node test/align.mjs     # 界面字段 ↔ 事务模型对齐（30 条：走完整状态机 + 数据清理 + 边界，逐条断言界面看到的东西）
node test/e2e-view.mjs  # 真实 HTTP 验证 /session-project /project / chief.bind|unbind / remove（12 条）
node test/client.mjs    # Client 合约：embed 布局、DSH session 切换、同源校验与过期重试
                        #   webServer 前缀路由、index-inject 两行、admit 401、真 node:http + SSE 首块、卸载摘路由）
node test/functest.mjs  # 106 项：真实插件代码 + 真实 HTTP + 忠实宿主桩（含 project.init 初始化仓库）
node test/setup.mjs     # 17 项：环境自检的纯函数判定（不起服务、不碰网络）
node test/serve.mjs     # 本地预览：http://127.0.0.1:8791/api/flow/app（灌演示数据）
node test/shot.mjs <url> <out.png> [w] [h] [fullPage] [scrollSelector]   # CDP 截图
node test/probe.mjs <url> <expr|@file> [w] [h]                            # CDP 探针（量布局/找溢出）
```

Windows 上 `chrome --headless=new --screenshot` 拿不到产物（chrome 脱离控制台），
必须走 CDP：`test/shot.mjs` 用 ws 连 `--remote-debugging-port` 再 `Page.captureScreenshot`。

## 实现校准（设计稿 → 实际）

设计文档 `docs/ework-flow-design.html` 的 **9.5 实现校准** 一节记了落地时改掉的十九处，
最关键的三条：

1. **守卫只校验迁移之前必须成立的事实**。`claim` 不要求计划存在（否则认领后写不了计划）；
   `approve` 才校验 `plan.revision>0 && plan.text`。
2. **绑定是迁移的结果**。`approvedRevision` 在 approve 迁移内部写入，不能先比对再绑定。
3. **审核结论必须带判据版本**。`promptVersion` 缺省取 `reviewPromptSet(projectId).version`，不允许 null。

## 代理池

新建项目时按项目配置自动补齐：`config.dispatchers`（默认 1）个调度员 + `config.workers`（默认 2）个工人，
按 `role + slot` 幂等；把配置调大只补新工位，调小不删已有工位。左侧「代理」里的调度员可以点开直接对话。

## 派工与对话框（v0.2）

- **派工**：批准执行后 `createDispatcher().dispatch(task)` 依次做——选工位（idle > 未建 > active，且未超 `maxConcurrency`）→ 没有工位就 `task.phase = waiting-worker`（不阻塞）→ `ensureSession`（`sessionController.create`，同工作区 + 该代理预设）→ 事务内 `startRun`（runs + `task:<id>` 租约 + assignee/activeRunId）→ `goals.clear` + `goals.create` → `prompt(queue, content=[{type:'text',text}])` 投案卷 → 工位 `active` + 评论。任何一步失败都落到 `blocked` 并写原因，不留“空跑的 running”。
- **自停**：工人用 `flow_task_move(action="stop", payload.stopReport={summary,tests,files,blocked})` 停下；domain 收 run、释放租约、工位回 `idle`，然后给调度员投巡检包（含系统建议 keep/steer/pause/reset/done）。
- **对话框**：工作台右上角「和调度员对话」（或 `?chat=1`）打开侧栏；v0.6 起侧栏直接嵌入 DSH 原生会话（见下文「DSH 原生会话侧栏」），不再自绘 transcript/composer。兼容通道仍保留：`chat.send` → `sessionController.prompt(queue)`，打断走 `chat.cancel`，重置走 `agent.reset`（archive(stopActivity) → create → bindSession）。
- **系统投递**：案卷/巡检包投递前 `chat.markSystem(sessionId, text)`，面板里显示成“系统投递”（`origin:'system'`），不冒充人说的话。

## v0.3 补齐了什么（对照设计文档 15 章）

15 章列的 15 条能力（C14–C28）全部落地，冒烟 96 条断言逐条对应：

- **总调度者 chief**（`lib/domain.js` `provisionAgentsIn` 三层 plan）：`role='chief'`，`chat.send` 不带 agentId 时默认发给它；`domain.chatTarget` 优先 chief。
- **交付包 handoff**：`domain.handoff(taskId,{to,notes})` 要求 `plan.revision>0`，把 `planRev` 绑进事件。
- **worktree**（`lib/dispatch.js` `worktreePathFor`）：默认落在仓库外 `<repo 同级>/.flow-worktrees/<repo名>/<taskId>`（放仓库里会把 `git status` 弄脏挡住合并），分支 `flow/<taskId>`；会话 `cwd` 指向 worktree（`index.js` `ensureSession(agent, project, {cwd})` 发现 cwd 变了就重建会话）。
- **开 PR / 合并 / 软合并**（`lib/git.js` + `dispatcher.openPr/merge/softMerge`）：commit → 可选 push → 写 `pull_requests`（同一 head 去重）；merge 只允许 `column==='merging'`，成功走 `review_approve` 并回收 worktree，冲突则 `merge --abort` + 写 `pr.merge_conflict` + 注入冲突包 + 回派原工人。
- **事件管道**（`lib/remote.js` + `domain.ingest/syncRemote`）：webhook 验签（HMAC-SHA256，兼容 `sha256=` 前缀）→ 归一化 → `dedupeKey` 去重入库；拉取时镜像 + 事件 + 游标同一事务。
- **注入**（`domain.inject`）：skill / context / steer 三通道，单条超 `config.injectionMaxBytes`（默认 4096）直接拒。
- **自动调度 tick**（`lib/scheduler.js`）：卡死检测（`stuckAfterMs` 默认 30min）→ 补位派工 → 自动验收 → 自动合并 → 拉远程 + 消费事件；每步 try/catch，tick 永不抛。
- **派工不再裸奔**：案卷投递失败重试 2 次（400ms/800ms），投递结果写 `message_log`，可用 `GET /worker/:agentId/log` 或 `flow_worker_log` 回看。

仍缺（M1，不影响本地跑）：client 半 bundle、Remote 面（`flow.tasks.*`/`flow.agents.*`/`flow.approval.*`）、审批持久化表、远程推送（`config.pushRemote` 只影响 openPr 是否 push）。

## 调度台界面（v0.4）

界面这一版按「人只做四件事」重排（设计文档第 16 章）：

- **新建项目从工作区里选**：顶栏「新建项目」拉 `GET /workspaces`（`workspaceRegistry.list()` 投影），列表带会话数、已绑项目的标「已在调度台」；底部保留手输路径兜底。
- **新建任务不先命名**：点「新建任务」直接 `task.create {title:''}`（落成「未命名任务」），跳到 `#/task/<id>` 的 issue 式详情页，标题框自动聚焦全选；描述、验收标准、讨论都在这一页。
- **任务页 = issue 页**：左栏标题/描述/验收标准/讨论，右栏状态/操作/计划/运行记录；评论三方同线程，署名按会话角色上色（我=靛蓝、调=青绿、工=琥珀、总=紫、系=灰虚线）。角色由 `exec.agent.session.header.id` 反查 `agent_sessions → agents.role`，不信客户端。
- **自动调度区不进看板**：`origin='auto'`（远程 issue 建的卡）只在左栏「自动调度」列出，看板只显示 `origin='manual'`；自动卡点开同样能评论、页头带来源标签。
- 任务页用 hash 路由（刷新不 404），写操作不做乐观更新（等 `ok:true` 再由 SSE 刷一遍）。

## DSH 原生会话侧栏（v0.6）

工作台的侧栏直接嵌入 DSH 自己的应用与会话视图：输入框、消息渲染、工具调用和命令都由 DSH 原生界面处理。工作台只选择代理并切换该代理的独立 session，不再维护第二套聊天 transcript 或 composer。

- **固定绑主调度（v0.9）**：侧栏永远显示主调度（chief → dispatcher → 首个代理）的 DSH 原生会话，标题是「<主调度名> · 主调度」；header 按钮文案「和主调度对话」。左栏其它代理行只负责打开对话区，点了不会切换对话对象（`openChat()` 无参、`chatChief()` 选主调度，旧的 `defaultChatAgent()` / `renderChatSwitch()` 已删除）。
- **打开方式**：`GET /api/flow/agent/:id/session` 拿到 sessionId 后，iframe 载入 `/?flowSession=<id>&flowEmbed=1`，DSH 客户端在 `dsh-flow:ready` 握手后执行 `uiWorkspace.openSession(sessionId)`；同一 session 只换 `postMessage`，不同 session 才重设 `iframe.src`。worker 已有 worktree cwd 会保留。
- **原生交互**：iframe URL 带 `?flowSession=<sessionId>&flowEmbed=1`；客户端关闭右栏，宽屏（≥1024px）时折叠 DSH 导航栏——窄屏 iframe（工作台侧栏）里 DSH 默认就收起左栏，再调 `toggleSidebar()` 反而会把 `narrowExpanded` 打开，所以只在宽屏主动折叠（v0.8）。通过 `dsh-flow:ready` 握手。
- **只留会话区（v0.9）**：`client.js` 的 `EMBED_CSS` 把 DSH 会话布局压成纯对话区——`[class*="_frame"]{grid-template-columns:0 minmax(0,1fr) auto!important}` + `[class*="sidebarCol"]{width:0!important;min-width:0!important;max-width:0!important;overflow:hidden!important;padding:0!important;border:none!important}`。只隐藏/归零侧栏列会破坏 grid（会话被压到 56px），所以必须同时改模版列。实测 700/1440 宽下会话区 x=0、宽等于视口，看不到「新建会话 / 添加工作区 / 插件 / 设置」入口。
- **安全边界**：父子窗口校验同源与 `event.source`；嵌入客户端只响应 `dsh-flow:session`。没有 embed 参数时不改变普通 DSH 页面。
- **不再使用旧转录通道**：工作台不再用 `GET /chat/stream` 绘制气泡，也没有自建输入框；保留的 HTTP SSE 是其他调用者的兼容接口。
- **Client bundle**：`client.js` 注册 `uiWorkspace` / `layout` / `sessions` 依赖，工作台 HTML 由 Host 的 `/app` 路由提供；更新后重启 DSH 才能加载新 client bundle。
- **重启后不空白（v0.7）**：`Store.ready()` 在插件启动时加载磁盘状态，HTTP 只读接口、工具和侧栏会话都在进入前 `await`。此前只读接口不触发 `load()`，DSH 重启后 `/state` 会返回空项目/空代理，聊天按钮直接报「没有可用代理」。
- **建会话参数（v0.7）**：`sessionController.create` 只接受 `workspaceId` 或 `cwd` 之一。项目根目录传 `workspaceId`（会话进 DSH 工作区），worktree 等其它目录只传 `cwd`；两个都传会被 DSH 拒绝（`session.create accepts workspaceId or cwd, not both`），侧栏和派工都建不出会话。

关键接口：`GET /api/flow/agent/:id/session`、DSH `uiWorkspace.openSession`、`layout.toggleSidebar()` 与 `layout.closeRightbar()`。测试：`node test/client.mjs`、`node test/host.mjs`、`node test/smoke.mjs`。
## 数据清理（v1.2 新增）

**不要手改 `~/.dsh/flow/flow.json`**——Store 是进程内单写者 + 内存态，下一次 tick/写事务会把内存整份原子写回，外部修改会被静默覆盖（实测：清理后 20 秒内被写回旧数据）。

正规入口：

| 方式 | 用法 |
| --- | --- |
| HTTP action | `POST /api/flow/action` `{action:'project.remove', args:{projectId}}` / `{action:'task.remove', args:{taskId}}` |
| 工具 | `flow_task_remove` |

`project.remove` 会连带清掉该项目下的任务、评论、审批、run、代理、会话绑定、租约、worktree 记录与相关事件；`task.remove` 同理作用于单张卡。

## 真实数据验证（不需要重启）

```bash
node test/real-data.mjs          # 4 项：真会话头 + 真 flow.json
node test/flow-command-real.mjs  # 4 项：/flow 真实模块 + 线上真实工具名单
```

读 `~/.dsh/sessions` 下真实的 `session.v4.jsonl.zstd` 会话头 + 真实 `flow.json`，
用插件同款解析顺序跑一遍。它能证明"解析逻辑对真实数据成立"，但**不能**证明
"正在运行的进程已经加载了新代码"——后者只能靠重启 + `live-accept.mjs`。

## 线上验收（重启后跑）

```bash
node test/live-accept.mjs
```

对**正在运行的实例**做验收：会话→工作区解析、`/project` 七列、`catalog.get` 模型目录、
新 action 是否已加载、`event.tick` 对账。全部 ✓ 才算"线上真的生效"。
解析失败时它会自动调 `diag.cwd`，把 inspect / persistence / agent_sessions 三层各给了什么打出来。
自动从 `~/.dsh/.credentials.yaml` 现签 cookie，不用手填。

## 全功能测试套件（v1.5）

```bash
node test/functest.mjs   # 106 项：真实插件代码 + 真实 HTTP + 忠实宿主桩
```

和单测的区别：**每个宿主桩都按真实签名写，签名不对就抛错**。之前踩过的两个坑都是这么漏掉的——
`inspect({sessionId})`（真实是 `inspect(sessionId)`）、`prompt(req)`（真实是 `prompt(req, signal)`）。
现在桩会主动抛错，测试不再"自洽地通过"。

覆盖：工作区=项目解析（含三层 cwd 兜底 + 仓库外 worktree 反查）→ 任务全状态机 → 派工（建会话/投 brief/占租约/建 goal）→ 自停 → 巡检 →
验收 → PR → 审核 → 合并，加上阻塞/取消/重开/改派、评论/注入/车道/配置/范围、回信路由、
`/flow`（agent 作用域 restrict）、catalog、工作区对账、事件流与视图，共 12 组。

## v1.6：/flow 只读边界的三态

`diag.flow` 线上报过 `deny=[]`（13 个意图工具全 missing）。原来会"跳过 restrict 照样进入"——
**看起来进了只读，其实还能写**。现在按视图内容分三态：

| 视图里有写工具？ | 交集 | 行为 |
|---|---|---|
| 有 | 非空 | 正常 `restrict({deny})` |
| 没有（只有 flow_*/read） | 空 | 进入，说明"只读天然成立" |
| **有，但名字对不上** | 空 | **拒绝进入**，提示补 `FLOW_DENY_TOOLS` |

`diag.flow` 现在还会返回 `visible` / `visibleCount` / `restrictable`，空交集时能直接判断是哪种情况。

## v1.35：最高优先级约束置顶（学 CodeGraph 的写法，但不硬阻断）

**问题**：v1.34 把「禁用 `ask_user_question`」写进了提示词，但**位置在 brief 最末尾**。

一份 3000+ 字的案卷里，最末尾那段最容易被当成参考资料而不是命令。模型读完前面一长串背景、方案、上下文之后，最后几行约束的权重已经被稀释了。

### 改法：单独拎出「最高优先级」段，置顶

新增 `criticalRules(role)`，只放**违反就会让整轮作废**的条目：

| 角色 | 条目 |
| --- | --- |
| 工人 | ① 不调 `ask_user_question`（会卡死）② 产出必须进 git 提交 ③ tests 不许编造 |
| 调度 | ① 不调 `ask_user_question`（会停摆）② 审核 ≠ 已合并 ③ 验收前确认 worktree 干净 |

然后**放在消息最前面**（`buildBrief` 和 `buildInspectPacket` 都改）：

```
【最高优先级 · 违反会直接把这一轮作废，先读这段再动手】

1. **不要调用 ask_user_question。** 它是「弹界面然后阻塞等回话」的工具，
   而你跑在后台 worktree 里，没人守着你的会话 —— 调用它只会让这一轮永远卡住，
   占着工位和租约直到心跳超时被判卡死。**没有任何例外。**
   要问调度员：flow_task_comment 写清问题 → flow_task_move(action="block") → 停下来等。
...
【案卷 T-1】      ← 原有的案卷内容全部保留在后面
```

实测位置：`ask_user_question` 出现在**第 41 个字符**（原来在 3000+ 字之后）。

### 措辞参考 CodeGraph 那类工具，但不硬阻断

CodeGraph 是 `MUST use codegraph_explore INSTEAD OF grep/glob/read` —— 全大写 + 明确替代。这里学了三点：

1. **明确优先级**：「最高优先级 · 违反会直接把这一轮作废」；
2. **写清破坏性后果**：不是「建议不要用」，而是「你会永远卡住，占着工位直到心跳超时」；
3. **给出正确替代**：每条禁令后面紧跟「那该怎么做」。

但**没有**用 `tools.restrict({deny})` 做硬阻断，原因：

- `restrict` 对未知工具名是原子失败的（文档 §9.4.5 记过：线上曾因 deny 一个不存在的名字导致整个 `/flow` 进不去）；
- 要给 worker/dispatcher 三个角色的会话都挂 restrict，得先确认 `ask_user_question` 真的注册在这个 DSH 构建里、且 agent 作用域正确；
- 提示词层已经能覆盖绝大多数情况，硬阻断留作以后的加固项。

所以是**软约束 + 最高优先级标注**，不是硬阻断 —— 这也是你要求的。

### 验收

`node test/smoke.mjs` → **370 checks passed**（+3）。新增断言：

- 工人 brief 的**第一段**就是最高优先级约束（`indexOf(「【最高优先级」) === 0`）
- 调度巡检包的**第一段**也是
- 禁止条款出现在**开头 200 字内**
- 同时验证详细规则（【工作方式】【必须提交】）和巡检包内容（【巡检请求】【停止报告】【你的选择】）**没有被挤掉**

最后一条很重要：置顶容易写成「把新段落插到最前面，旧的忘了留」。所以断言两个方向都查了。
## v1.34：通知聚合 + 禁用 ask_user_question

**两件事**：① 调度台被消息挤爆（一分钟最多 8 条），模型没法连续输出；② 工人和调度员都在用 `ask_user_question`，那会弹界面**阻塞等回话**，在后台跑的场景里等于卡死。

### ① 通知聚合（debounce + maxWait + 紧急直通）

先看数据说话：

```
message_log 325 条，按 kind 排序：
  watch:comment.added   116 条   ← 最大来源
  inspect                63 条
  brief                  48 条
同一分钟最多投递：8 条 —— 平均每 7 秒打断一次
```

`watchEvents` / `notifyDispatcher` 原来都是「一个事件一次 `promptSession`」。已有的去重 key 是 `task.id|event.type`，3 卡 × 4 事件 = 12 个独立 key，全都放行 —— 所以它拦不住多卡多事件同时到达。

新增 `lib/aggregator.js`，三层策略（缺一层都会出问题）：

| 层 | 行为 | 为什么必须有 |
| --- | --- | --- |
| 紧急直通 | `blocked` / `run 失败` / `stuck` / `merge_conflict` → 立即发 | 故障等 3 秒等于延迟处理 |
| 尾触发 debounce | 来一条就重置计时器，安静 3 秒才发 | 一波事件只发一条 |
| maxWait 兜底 | 从**第一条进队**算起最多等 10 秒 | **纯 debounce 会饿死**：消息每 2 秒来一条，计时器永远被重置，一条都发不出去 |

参数全部可配：`DSH_FLOW_MERGE_WINDOW_MS`（3000）/ `DSH_FLOW_MERGE_MAX_WAIT_MS`（10000）/ `DSH_FLOW_MERGE_MAX_CHARS`（6000）。

**评论降级为 `noteOnly`**：

116/325 条投递都是 `comment.added`。但评论是**讨论**，不是「等你做决定」——人写一条调度员就醒一次，等于把通知当同步用。

现在它攒着，等本批别的通知要发时作为附注挂上去；一直没别的事就发一条合并摘要。**既不丢信息，也不打断节奏。**

**两个实现细节（都是踩出来的）**：

1. **截断要从后往前装**。第一版从前往后装，结果 15 条排队时只保留最早那条无关的，把刚发生的巡检包整条丢了。最新进来的往往才是最要紧的。
2. **紧急消息不能吞掉队列**。收到紧急消息时先 flush 已排队的，再单独发紧急的——否则一条「卡死了」会把前面攒的几条一起吞掉。

### ② 禁用 ask_user_question，各走各的通道

`ask_user_question` 是给「人和模型在一个对话里实时交互」用的：弹界面然后**阻塞等回话**。但工人和调度员都在后台跑，没人守着它们的会话——用了只会让这一轮卡死，占着工位和租约等心跳超时。

**工人**：

- 需要调度员决定 → `flow_task_comment` 写清问题 + `flow_task_move(action="block")` + **停下来等**；
- 需要人类拍板 → 不由你直接问，同样走 block，由调度员判断是否进请示箱；
- 只是汇报 → 评论即可，不要 block。

一句话：**没有「提问并等回话」这个动作。把问题写进卡里，然后停。**

**调度员**：

- 需要人类拍板 → `flow_ask_human` 进收件箱，**写完继续干别的**（人回复会有 `inbox-reply` 通知叫醒你）；
- 需要工人补充或返工 → 不要问，直接下指令（`flow_worker_steer` / `review_conflict`）；
- 只是知情 → `flow_task_comment`，或用 `kind=info`（不等人回）。

一句话：**你要做的是「把问题投出去然后继续」，不是「停在这里等答案」。**

### 验收

`node test/smoke.mjs` → **367 checks passed**（+10）。新增断言：

- 连续 5 条合并成 1 条（不代表一条一次打断）
- maxWait 兜底：消息持续不断也会强制发出（防饿死）
- 紧急通知立即发，不等窗口
- 紧急消息不吞掉已排队的普通通知
- `noteOnly` 不单独触发，但能搭车
- 不同调度员队列互不干扰
- 超长时保留最新、丢掉最早，并列出涉及哪些卡
- 两条提示词都明确禁止 `ask_user_question` 并给出正确走法

### 一个设计取舍

聚合会**延迟最多 3 秒**（紧急事件除外）。这是有意的：3 秒的等待换来「一次说清 5 件事」而不是「5 次各说一件」，对模型来说后者要重新进 5 次上下文，代价远大于 3 秒。
## v1.33：状态机与事务设计的对齐核对

**背景**：v1.32 的教训不是「某个功能坏了」，而是**文档和代码一起错**——两边都写着「审核通过 → done/merged」，谁都没发现那个 `merged` 是假的。所以这次做一次系统性核对，并把核对本身变成可复跑的测试。

### 核对方式

新增 `test/align-state.mjs`（19 项），分四层：

| 层 | 查什么 |
| --- | --- |
| ① 结构对齐 | `docs/事务流设计.md` §2.2/§2.3 迁移表 vs `lib/core.js` 的 `TRANSITIONS`：动作是否存在、`from` 列、`roles` |
| ② 语义闸门 | 文档说不允许的事，代码是否**真的拒绝**（不是「文档这么写」而是「守卫这么判」） |
| ③ 不变量落点 | §1.2 的 I1–I15 每条能不能指出一处代码 |
| ④ 事故回归 | v1.32 的失效模式是否被永久钉住 |
| ⑤ 端到端 | 一张卡走完全程，每一步都不产生「状态与事实不符」 |

### 核对出的真实差异

**① 权威迁移表漏了 5 个动作**

```
代码 21 个动作 vs 文档迁移表 16 条
漏记：investigate · submit_plan · approve_by_chief · approve_by_dispatcher · merge_skip
```

这 5 个在 9.4.x 的版本叙述里都提过，但**权威表 §2.2/§2.3 从来没同步**。而叙述是「当时怎么想的」，迁移表是「现在到底有哪些动作」——后者才是判断依据。

**② `accept` 的角色范围过期**

文档写 `roles: human`，代码是 `human, dispatcher`（v1.28 就放宽了，文档没跟上）。

**③ `classify` 的 from 列过期**

文档写 `from: running`，代码是 `running, verifying`。

**④ `review_approve` 的守卫描述缺了要害**

文档只写「reviewVerdict 非空」——**和代码的 bug 一模一样**。这正是「一致地错」：比对两边永远发现不了，因为两边缺的是同一句话。

### 修法

- 补齐 5 个动作到 §2.3（写清 from / roles / to / 出处版本）；
- 修正 accept 的 roles、classify 的 from；
- `review_approve` 补上「**且 mergedCommit 非空（v1.32：审核 ≠ 合并）**」；
- 在 §2.3 表上方写明：**这张表是权威，`test/align-state.mjs` 会逐条比对**，加了动作忘了写就会红。

### 新增：状态一致性扫描器

`test/scan-state-lies.mjs` —— 扫描真实 `flow.json`，找「状态字段没有物理事实证明」的条目。

```
$ node test/scan-state-lies.mjs
发现 3 条状态与事实不符：
  · T-036  phase=merged 但没有 mergedCommit（合并从未发生）
  · T-042  phase=merged 但没有 mergedCommit（合并从未发生）
  · T-044  phase=merged 但没有 mergedCommit（合并从未发生）
```

**精确命中已知的 3 张，没有误报也没有漏报。** 规则：

| # | 规则 | 对应事故 |
| --- | --- | --- |
| ① | `phase=merged` 但没有 `mergedCommit` | v1.32 事故本体 |
| ② | `mr.status=merged` 但卡片退回到更早的列 | 合并后状态回退 |
| ③ | 还在 running/verifying 就有审核结论 | 顺序错乱 |
| ④ | 在 merging 列却标 `phase=merged` | 半路卡死 |
| ⑤ | PR 说 merged 但没有 mergedCommit | 字段缺失 |

**一个必须写下来的细节**：规则 ② 最初太严，把「`markMerged` 之后、`review_approve` 之前，卡片还在 merging」判成了谎话。那是**合法过渡窗口**——合并确实发生了，卡片只是还没被推走。

这正是扫描器这类工具的风险：**规则写过头，噪声会淹掉信号**。所以每条规则都要能说清「什么情况是合法的」。

### 现在的状态

```
npm test
  352 checks passed              (smoke)
  client contract: all checks passed
  client render: all checks passed
  6 项工具 schema 检查通过
  state alignment: all checks passed (19 checks)
```

`scan:lies` 有 3 条 —— **那 3 条是真实存在的历史债务**（T-036/T-042/T-044 尚未真正合并），不是测试失败。它们要等真合并之后才会消失，这是对的：扫描器应该继续报，直到事实被修正。

### 回答「会不会再出现」

分三层保障：

1. **结构层**：迁移表与代码不一致 → `align-state` 直接红（新增动作忘写、改了 from/roles 忘同步）；
2. **语义层**：文档承诺的拒绝行为，代码必须真的拒绝（`review_approve` 现在必须有 `mergedCommit`，这条被断言钉住）；
3. **数据层**：`scan-state-lies` 扫真实数据，任何「状态没有事实支撑」的卡都会浮出来。

但要说清一个**做不到的地方**：如果文档和代码**一起错**（就像这次），前两层都发现不了。所以真正的兜底是那句原则——

> **每个状态字段都必须能指出一处代码证明它为真。** 指不出来，就是许愿。
## v1.32：状态不能撒谎（审核通过 ≠ 已合并；没提交不算完成）

**一句话**：一共有三张卡写着 `done/merged`，但 `master` 里一行它们的代码都没有。根因是**状态机把「审核通过」当成了「已合并」**。

### 现场

```
T-036  done/merged  ← mr.status=ready_for_review  mergedCommit=null
T-042  done/merged  ← mr.status=open               mergedCommit=undefined
T-044  done/merged  ← mr.status=open               mergedCommit=undefined
master HEAD 675acf1，三条分支各带着 1 个不在 master 里的提交
```

### 三个缺陷叠在一起

**① review_approve 把审核当合并**

```js
review_approve: {
  to: 'done',
  phase: 'merged',        // ← 直接宣布「已合并」
  guard: (t) => t.mergeRequest.reviewVerdict ? null : '审核结论缺失'
}
```

它**只看有没有审核结论**。而 `review_approve` 可以被 `pr.review` / `flow_pr_review` 直接调用 —— 于是「点一下审核通过」就把卡标成已合并，整个 git merge 被跳过。

正常路径本来是对的：`mergeLocked` 是「先 `git.mergeBranch` → 再 `markMerged` 记提交 → 最后 `review_approve`」。问题出在这条路径**可以被绕过**。

**② 字段名不一致，真合并了也查不到**

```js
openMergeRequest → mergedCommit: null   // 建 PR 时用这个名
markMerged       → pr.mergeCommit       // 记合并时用另一个名
```

所以**即使真的合并了，mergedCommit 也永远是 null**。一个字段两套名字，看板上永远看不出到底合并没有。

**③ 验收只读 HEAD，看不到未提交的改动**

`accept` 从 worktree 读 HEAD 绑定 `headSha`，但 **HEAD 不包含未提交的文件**。于是工人在 worktree 里改了一堆、一个都没 commit，停止报告写得好看，验收照样通过 —— 卡变成 done，那些改动从来没进过任何提交，能合进 master 的自然是空的。

线上 T-035/T-037/T-039/T-036 的 worktree 至今留着未提交改动，走的就是这条路。

### 修法

| 改动 | 内容 |
| --- | --- |
| `review_approve` 守卫 | 必须有 `mergedCommit`，否则拒绝并指向「走 flow_pr_merge 或 merge_skip」 |
| `markMerged` | 统一写 `mergedCommit`（同时写 `mergeCommit` 兼容历史数据） |
| `markMerged` 前置条件 | 不再硬要求存在 `pull_requests` 记录（卡片上的 mergeRequest 和那张表是两套记录） |
| `accept` | worktree 有未提交改动时**拒绝**，列出文件，并说明两条出路 |
| `accept` 逃生口 | `payload.allowDirty = true` —— 由人显式决定「这些改动不要了」 |
| `advance` 步骤 | 改成 `review_verdict_only`：只写审核结论，卡片留在 merging，真合并交给 `autoMerge` |

最后一条很重要：自动推进如果直接调 `review_approve`，在新守卫下会永远被拒，环路就死了。现在它只记结论（`setReviewVerdict`，不移动卡片），合并由 `autoMerge` 接手。

### 提示词里的硬约束

**工人侧**：

- 「你的产出只有进入 git 提交才算数」—— 没提交等于这轮什么都没发生；
- 说清三个后果：验收直接拒绝、合并合并不到、交付物只存在随时会被删的 worktree 里；
- stop 之前自查三件事：`git status` 干净吗、分支相对 base 有提交吗、tests 是真跑过还是以为会过。

**调度侧**：

- 「审核通过不等于已合并」，并写明线上事故；
- 正确顺序只有一条：验收 → 开 PR → 审核 → **flow_pr_merge** → 才变 merged；
- 想跳过合并不合代码的卡用 `merge_skip`（落 `merged-skipped`），**不要**用 review_approve 冒充；
- 合并后核对 `mergedCommit` 有值、主仓库 HEAD 变了，两者缺一就是「看起来合并了其实没有」；
- 有未提交改动要退回让工人提交，**不要用 allowDirty 绕过**。

### 验收

- `node test/smoke.mjs` → **352 checks passed**（+8）
- 新增断言：没合并提交时 review_approve 被拒 / 有 mergedCommit 才放行 / merge_skip 仍允许 / 脏 worktree 拒绝验收并列出文件 / allowDirty 放过 / 干净 worktree 正常通过 / 两条提示词强约束存在
- 脏 worktree 的用例用了**真实 git 仓库**（`git init` + `git worktree add`），不是 mock

### 数据修复

三张卡上没有静默翻转状态 —— 那只是从一种谎话换成另一种。改为在每张卡上写清：

- 此前的 done/merged 是假的，合并从未发生；
- merge request 的真实状态、master 的真实 HEAD；
- 分支上那个不在 master 里的提交号；
- 原因是什么、已怎么修、接下来该做什么（走 flow_pr_merge 真合并）。

另外查明：**T-042 的内容是 T-044 的早期子集**，合并应以 T-044 为 canonical，T-042 不该单独合。

### 教训

**「状态字段」和「物理事实」必须能对上，否则系统会安静地骗人。**

这次没有任何报错、没有任何测试失败 —— 卡片显示完成，看板一片绿，唯一的问题是 **master 里没有那些代码**。这种错误比崩溃更贵：崩溃会让你立刻知道出了问题，而虚假的完成状态会让你一直往前走，直到某个环节突然发现地基是空的。

判断一个状态是否可信，标准不是「它被写进去了」，而是「**有没有一处代码能证明它为真**」。`merged` 为真的证明是 `mergedCommit`，`done` 为真的证明是「工作已进提交」。没有证明的状态，就是许愿。
## v1.31.3：看板排序（后移入的排前面）+ 列内上下轻翻页

**一句话**：看板原来按"创建顺序"从上往下排，最老的卡在最上面；分页是"点一次多显示一批"，越堆越长。改成**后移入的排前面**，分页改成**上下两端各一个翻页条** —— 点哪一个就把另一头折叠掉。

### ① 排序：为什么原来是最老的在前

```js
const tasks = Object.values(state.tasks || {}).filter((t) => t.projectId === projectId)
// → 完全没有排序，吃的是对象插入顺序（≈ 创建顺序）
```

所以看板从新到旧是反的。更要紧的是：**「排在前」必须按「什么时候进的这一列」**，而不是创建时间或更新时间 —— 一张卡从 `running` 流到 `done`，它在 `done` 列里应该按**进 done 的时间**排，不是按建卡时间。

改动：

- `applyTransition` 里加 `columnAt` —— **只在列真的变了时**打时间戳；
- `buildProjectView` 按 `columnAt` 倒序排；
- 老数据没有这个字段，`MIGRATIONS[6]` 用 `updatedAt || createdAt` 回填（不精确，但只影响历史卡的相对次序，新卡从这一刻起是准确的）。

为什么不用 `updatedAt` 排序：改个标题、加条评论都会刷新它，卡片会在列里**乱跳**。`columnAt` 只在换列时变，位置才稳。

### ② 分页：从「累积追加」改成「窗口滑动」

用户原话：「我想做的是上下端的翻页，点下面的显示更多折叠上面，点上面的显示更多折叠下面，就是这样的轻翻页效果」。

原来是 `shown += size`（越点越多，最后整列还是全展开），现在是 `offset ± size`（窗口移动，永远是 N 张）：

```
offset=0    → 第 1..8 张    ↑无            ↓更早 12 张
点下端      → offset=8   → 第 9..16 张   ↑更新 8 张   ↓更早 4 张
点下端      → offset=16  → 第 17..20 张  ↑更新 8 张   ↓无
点上端      → 回到 offset=8
```

**每列最多两个翻页条**（上下各一条，哪个方向没内容就不出现），不会再出现「一列里堆了好几个显示更多」。

列头计数也从「总数」改成**「当前页/总数」**（`9-16/20`），翻页时能看出自己在哪。

### ③ offset 越界要夹住

```
列里有 20 张，翻到 offset=16；这时移走 15 张 → all.length=5
offset=16 已经越界 → 空列表 + 两个按钮都不出现 → 列看起来"卡里明明有卡却空着"
```

所以每次渲染前按 `maxOffset = floor((len-1)/size)*size` 夹一次。

### 截图复核（三页都量过）

| 页 | 列头 | 首张 | 末张 | 上端 | 下端 |
| --- | --- | --- | --- | --- | --- |
| 1 | `1-8/20` | 第 20 张（最新） | 第 13 张 | 无 | ↓ 更早 8 张 |
| 2 | `9-16/20` | 第 12 张 | 第 5 张 | ↑ 更新 8 张 | ↓ 更早 4 张 |
| 3 | `17-20/20` | 第 4 张 | 第 1 张（最早） | ↑ 更新 8 张 | 无 |

每一页都是 8 张（最后一页 4 张），**不是累积**。

### 验收

- `node test/render.mjs` → 通过（新增：第一页 8 张、翻页后仍 8 张、翻回后顶部按钮消失、`columnPageSize=5` 生效）
- `npm test` → 344 smoke + client + render + 6 schema，全绿

### 一个测试自身的坑

`smoke.mjs` 里断言写的是 `assert.equal(SCHEMA_VERSION, 6)`。我升到 7 之后它立刻红了 —— 但它红的是「版本号变了」，不是「功能坏了」。

钉死版本号的断言每加一次迁移就要改一遍，改的时候还得想「这次该填几」。现在改成 `assert.equal(store.state.schemaVersion, SCHEMA_VERSION)` —— 守的是「加载后的状态版本等于当前常量」，这才是真正要保证的事。
## v1.31.2：请示箱重做（图标浮标 + 窄抽屉 + 列分页）

**一句话**：v1.31.1 修好了「白屏」，但请示箱本身设计不合格 —— 点开只露出一条边、宽度铺满整屏、没有图标、列表被挤成两列。这一版按用户要求重做，并给看板加了列分页。

### 用户报的两个问题

**① 「点击请示 2 没有反应」**

根因：`renderInbox` 的根节点写的是 `className: 'flowv-drawer-mask'`，**漏了 `is-open`**。而 CSS 是：

```css
.flowv-drawer-mask{opacity:0}              /* 遮罩全透明 */
.flowv-drawer{transform:translateX(100%)}  /* 抽屉推到屏幕外 */
.flowv-drawer.is-open{transform:translateX(0)}
```

于是「点了」和「没点」在视觉上完全一样。正规的任务抽屉用的是 `(open ? ' is-open' : ' is-closing')`，我照抄结构却漏了这一句。

**② 用户要求：inbox 要有自己的图标和展开的对话框，位置也要重新设计**

原设计是「看板顶上塞一个文字按钮 + 复用 1040px 的详情抽屉」。截图一看全是问题：

- 1040px 几乎占满屏幕，人回复时看不到看板上下文；
- 每条请示的头部 `topic` 被挤成两行，`T-042` 和状态竖着堆在右边；
- body 是 `1fr + 300px` 两列网格（那是给任务详情设计的两栏），请示只有一列内容，被塞进窄格里读起来像碎掉；
- 没有图标，混在「同步 issue」「停止调度」里看不出它是「有东西等我」。

### 重做后的设计

**入口：右下角图标浮标**

- 收件箱图标（SVG 托盘 + 下坠箭头），44×44 圆角，固定 `right:20px; bottom:20px`；
- 有未回复时**整颗变品牌色**，不靠数字大小也能一眼看出；
- 右上角数字角标，超过 99 显示 `99+`；已回复但未归档时角标转灰（有东西，但不急）；
- 固定在右下角而不是顶栏：**任何滚动位置都点得到**，且不跟看板内容抢位置。

**抽屉：窄版 560px**

- `flowv-drawer--narrow`，右侧留出看板可见区，回复时能对照上下文；
- `flowv-drawer--narrow .flowv-drawer-body{grid-template-columns:minmax(0,1fr)}` —— 强制单列；
- 头部 flex：`topic` 占主位（`flex:1;min-width:0`），`T-042` 与状态靠右不换行。

**两个 CSS 顺序陷阱**（都踩了，都写进注释）：

| 陷阱 | 现象 | 原因 |
| --- | --- | --- |
| `--narrow` 写在 `.flowv-drawer` **之前** | 设了窄版还是铺满 | 两选择器特异性相同，**后定义的胜出** |
| body 沿用两列网格 | 标题和提示文字被挤进 260px | 两列布局是给任务详情设计的，窄抽屉里必须覆盖成单列 |

### 列分页（懒加载）

用户原话：「某一栏的卡片可以折叠之前移动进来的，保留最近进来的，这样不会让整个页面看起来太臃肿，几个为一页可配置」。

- 每列默认显示 **8 张**，底部「显示更多 N 张」点一次追加一页；
- 每页张数**可配置**：`project.config.columnPageSize`；
- 保留服务端给的列内顺序（不重排），否则两次刷新之间卡片位置会跳；
- 列体加 `max-height:min(62vh,720px)` + 内部滚动 —— **只限张数不够**，每张卡 60px+，8 张照样把页面撑开；
- 滚动条主题化（`scrollbar-color` + `::-webkit-scrollbar-thumb`），默认那根白亮条在暗色界面上像一道裂口。

### 截图复核（这次真的看了）

dsh web 的鉴权是 `?token=<进程内随机值>`，那个 token 只活在 `PROCESS_LAUNCH_TOKENS` 里，磁盘上没有、拿不到。所以做了 `test/shot-flow.mjs`：

- 用**真实 client.js** + **真实 VIEW_CSS** + 假 fetch，把组件渲染成 HTML；
- 起本地静态服务，浏览器打开截图；
- 补 DSH 主题变量（`--dsw-alias-*`）的近似值，只为看版式。

截图验证了四件事，每件都是「改完之后量出来的」：

```
抽屉宽度      560px   （原来 1040px，铺满屏）
body 列数     523px   （原来 1fr+300px 两列）
遮罩 opacity  1       （原来 0，点了看不见）
列体高度上限   494px   （内容 684px 可滚，页面从撑爆收敛到 1037px）
```

### 验收

- `node test/render.mjs` → 通过（新增：抽屉带 is-open、浮标存在、分页 8 张 / 点开 16 张 / `columnPageSize=5` 生效）
- `node test/client.mjs` → 通过（断言改到新入口）
- `npm test` → 344 smoke + client + render + 6 schema，全绿

### 教训

**「组件渲染出来了」和「用户能看见」是两件事。**

上一轮我加的渲染测试只断言了「树里有 `请示箱` 这几个字」—— 树确实建出来了，文字确实在里面，但 CSS 把它推到了屏幕外、调成了全透明。测试绿，功能废。

所以断言要落在**决定可见性的那一层**：不是「文本存在」，而是「决定透明度和位移的那个类名存在」。这条现在有 5 条断言守着。
## v1.31.1：调度台白屏修复 + 补上真正的渲染验收

**一句话**：v1.31 加了请示箱入口，但把它插进了 `head` 的构建表达式 —— 而 `var v = st.view` 在同一函数里要晚 150 行才赋值。`v` 被提升成 `undefined`，读 `v.inbox` 当场抛 `TypeError`，**整个调度台白屏**。

### 根因

```js
var head = h(...)        // 1294 行：这里就构建了 head
  (v.inbox && ...)       // 1387 行：v 还没赋值 → undefined.inbox → 抛错
var v = st.view          // 1444 行：到这里才赋值
```

`var` 的变量提升让它不是 `ReferenceError` 而是 `TypeError`，而且组件没有 error boundary —— 一个渲染异常就是整页空白。

### 修法

按钮移到 `var v = st.view` 之后构建（`inboxBtn`），挂在主 return 里 `head` 的下一行。位置的教训比代码本身重要：**在同一个函数里，读变量的位置必须晚于赋值位置**，而 1294 与 1444 之间隔了 150 行，靠肉眼很难看出来。

### 为什么测试没抓到（这才是重点）

`test/client.mjs` 里的假 React 是这样的：

```js
useState: (init) => [init, () => {}]   // 空壳：setState 什么都不做
```

它配的断言全是 `assert.match(file, /正则/)` —— **检查源码里有没有某段字符串**。于是：

- 组件函数从头到尾**一次都没有被执行**；
- 任何运行时错误都不可能被发现；
- 正则断言 100% 通过，页面 100% 白屏。

这不是「测试写少了」，是**测试类型错了**：正则能证明「代码里有这行」，证明不了「这行跑起来不炸」。

### 新增 test/render.mjs：真的把组件跑起来

| 能力 | test/client.mjs | test/render.mjs |
| --- | --- | --- |
| `useState` | 返回固定值，setState 是 no-op | 带 setState，改了会真的重渲染 |
| `useEffect` | 不执行 | 渲染后执行，**带 deps 比较** |
| 组件函数 | 从不执行 | 真的执行到 ready 分支，把整页建出来 |
| 能发现什么 | 字符串缺失 | 运行时抛错、变量未赋值、分支崩溃 |

几个必须踩过的坑（都写进注释了）：

1. **地址栏不能带 `flowSession`** —— `apply` 会走 embed 分支直接 return，`registerPanel` 根本不执行，测试看起来「没注册组件」。
2. **`useEffect` 必须做 deps 比较** —— 不做的话 `load()` 每轮重跑 → 每轮 setState → 永不收敛，看起来像组件死循环，其实是测试替身的锅。
3. **别追「收敛」** —— `load()` 是异步的，promise 会在轮次之间落下，严格收敛判定会把正常加载误判成死循环。改成固定轮次驱动。
4. **定时器要 unref** —— 组件有 `setInterval(load, 8000)` 轮询，在 Node 里会让进程永不退出，CI 看起来像挂死。

### 反向验证：这个测试真的能抓住那个 bug

把 bug 原样放回去再跑：

```
TypeError: Cannot read properties of undefined (reading 'inbox')
    at FlowView (client.js:1296:14)
```

**它在 1296 行炸了，正是 head 里那一行。** 这说明新测试不是「又多了一个能过的测试」，而是真的覆盖了这次的失效模式。

### 顺便核实的两件事

你说「没有自动开始」，实测**自动循环是跑起来了的**：

```
07:47:51  task.moved       approve_by_dispatcher  planning → running
07:47:54  worktree.created T-044
07:47:54  task.dispatched  run_039  agent=ag_020
07:47:55  human.asked      知情：T-044 计划判 medium，已自动开工
```

T-042 / T-044 都从 `todo` 走到了 `running`，worktree 建好、worker 会话 `active`、心跳正常（`lastHeartbeat` 每 5 分钟一次）。

**所以两个症状是同一个原因的两种表现**：调度台白屏让你看不到它在跑，也看不到请示箱里那两条 medium 知情项。

### 验收

- `node test/render.mjs` → 通过（新增，且经反向验证能抓 bug）
- `node test/smoke.mjs` → 344 checks passed
- `node test/client.mjs` → 通过；`tool-schema` 6 项全过

### 一条方法论

「测试全绿」和「功能可用」之间的距离，等于**测试类型与失效模式之间的距离**。

这次失效在「渲染执行」这一层，而我的测试在「源码字符串」这一层 —— 两层之间隔着整个运行时。

判断测试够不够，标准不是「覆盖率几个点」，而是：**如果这个功能坏了，我的测试会不会失败？** 答不上来的那部分，就是没测的部分。
## v1.31：自动闭环（todo/planning 不再是死区）+ 调度员请示箱

**一句话**：`tick` 原来有九个步骤，**一个都不覆盖 `todo` 和 `planning`** —— 从建卡到开工全靠调度员在一次会话里连调三个工具，漏一个就永久停住且无告警。这一版补上 `advance` 步骤，并给「需要人拍板」的事开了一个正经入口。

### 现场：同样的调度员，一张跑通一张卡死

```
T-043（跑通）: plan → claim → plan_ready → approve → dispatch → stop → accept → done
T-042（卡死）: plan(rev1) → risk → plan(rev2) → risk → （没有 claim，停在 todo 至今）
T-044（卡死）: plan(rev1) → risk → （同上）
```

调度员自己在评论里写过「T-043 已 claim，plan rev1 已写入并进入 planning」—— 它**知道**要 claim，但只对 T-043 做了。

### 根因：驱动只做了一半

逐步骤核对 `tick()`：

| 步骤 | 处理列 |
| --- | --- |
| `retryDue` | running |
| `refill` | running（无 activeRunId 才派） |
| `autoAccept` | verifying |
| `autoMerge` | merging |

**`todo` 和 `planning` 不在任何步骤里。** `autoDispatch=true` 的真实语义只是「running 列自动补位」，不是「卡会自动走完整条链」。

关于「worker 停止事件有没有传给调度」：事件**送到了**（`message_log` 有 `inspect` 记录，T-042 在 07:05:51 收到并开始干活）。问题不是送不到，是**送到之后没人兜底** —— 调度员是人不是状态机，忘了、被打断、上下文被压缩，都会断。

### 改法：新增 `advance` 步骤（retry 之后、refill 之前）

| 卡的位置 | 自动动作 |
| --- | --- |
| `todo` | `claim` 进 planning |
| `planning` 无计划 | 卡上提醒一次等你写计划（每卡限一次，不刷屏） |
| `planning` 有计划未提交 | `plan_ready` 提交待批 |
| `planning` waiting-approval 且非 high | `approve_by_dispatcher` 代批开工 |
| `planning` waiting-approval 且 high | **不碰**，落一条 inbox 请示等人 |
| `merging` 有 PR 无审核结论 | `review_approve` 自动审核，之后 `autoMerge` 接手 |

三个设计约束：

1. **风险自己算**，不指望「某个调用方记得算过」。`plan` 有了但 `task.risk` 为空时，`advance` 自己调 `assessPlanRiskOf` 并落库。
2. **幂等**：每卡每列一个 key，60s 内只推一次；推到守卫拒绝就记 `advanceBlocked` 并**停车**，绝不每拍重试。
3. **有 open 请示时不抢跑**：人正在拍板，系统不该越过他继续推进。

### 两个车道都自动批

`canAutoApprove` 从「只认 low」改成「**只拦 high**」。

原来 medium 也拦，但 medium 的判定规则太宽：`scope.paths` 为空、方案不足 200 字、涉及 3 个以上文件，全判 medium。线上 13 张卡里 medium 3 张，理由全是「调研没定阅读范围」「方案涉及 5 个文件」这类形式提示。**medium 挡着，自动循环在每张卡上都要停一次等人，等于没自动化。**

现在：high 必须人批；medium 放行但落一条 `info` 知情项（可见、留痕、不阻塞）；low 直接放行。车道不参与判断 —— human 和 issue 只是任务来源不同，事务逻辑相同。

### 验收：从假冒 human 改成 dispatcher 身份

`autoAccept` 原来是 `{ role: "human", id: "auto-accept" }` —— **假冒人类绕过守卫**，导致 v1.28 的 `acceptedBy` 机制形同虚设，审批记录里根本查不出「这是机器收的」。

现在走 dispatcher 身份 + `acceptedBy: "system:advance"`，并且把这个凭据**写进审批记录**：

```
人授权后代收： acceptedBy = "human:web"
系统自动收：   acceptedBy = "system:advance", autoAccepted = true
```

两种凭据在数据上可区分，事后能查出每条验收是谁收的。

同时加了一道**证据兜底**：`stopReport.tests` 里写「未执行 / 没跑 / 无法执行」的，或报告 `blocked: true` 的，**不自动收**，转请示箱让人决定。否则等于鼓励不跑测试也能过。

### 调度员请示箱（Human Inbox）

调度遇到需要人拍板的事 → 写一条**结构化请示** → 人回复（可多轮）→ 调度判断阻塞消除后归档 → 卡继续推进。

**为什么不用评论**：评论是讨论区，进度、证据、闲聊都混在里面，真正需要人做决定的那条会被埋掉。请示是**待办**：有状态、有回复、能归档。

四段结构是硬要求（`decision`/`risk`/`blocked` 三类缺了发不出去）：

```
problem         ① 遇到的问题或分歧是什么
decisionNeeded  ② 需要人做什么决定
where           ③ 发生在什么地方（卡号/文件/阶段）
suggestion      ④ 它的建议
```

只写「我遇到问题了」，人还得反问三轮才知道要干嘛 —— 校验存在的意义就是逼调度在发问前先想清楚。`info` 是纯知情项，只需 `topic`。

**状态流转**：

```
open ──(人回复)──→ answered ──(调度 resolve)──→ archived
  └──(调度自行查清)──────────────────────────→ archived
```

**归档权在调度**，不在人。语义是「我读过回复 / 看过 issue 补充的信息，判断这个阻塞已经消除，可以继续了」。人在看板上也能手动归档，那是兜底。

**调度工具**：`flow_ask_human`（发请示）、`flow_inbox_list`（看有没有人回）、`flow_inbox_resolve`（归档并继续）。

**看板**：顶栏出现「请示 N」入口（只在真有时出现，常驻一个「0 条」只是噪音）。点开是抽屉，四段结构化展示 + 多轮回复框 + 手动归档兜底。人回复后会**异步叫醒原发送调度**（`ensureSession` → `promptSession`），它收到才知道可以继续。

**自动进 inbox 的五种情况**：

| 触发 | kind | 要不要人动作 |
| --- | --- | --- |
| 预筛判 high | risk | 要（批方案） |
| `advance` 被守卫拒绝 | blocked | 要（卡住了） |
| 验收证据不足（未跑测试 / blocked） | decision | 要（能不能收） |
| medium 方案放行 | info | 不用（仅知情） |
| 高风险卡停在 waiting-approval | risk | 要（批方案） |

最后一条容易漏：**卡停在 waiting-approval 等人，和「通知到人」是两件事**。不落请示的话，人只有主动翻看板才会发现它在等，等于静默卡住。

### 数据与迁移

- `SCHEMA_VERSION` 5 → 6；`human_inbox: []` + `seq.humanInbox`；
- `MIGRATIONS[5]` 补默认值（幂等，只补缺失）；
- 老的 todo/planning 卡升级后 `advanceAt = null`，**第一拍就会被推进** —— 这正是想要的。

### 验收

- `node test/smoke.mjs` → **344 checks passed**（v1.30 基线 330 + 14）
- `node test/client.mjs` → 全绿（+7 条请示箱 UI 断言，含「useState 必须在 early return 之前」这条防白屏检查）

新增断言覆盖：todo 自动 claim / 有计划自动 plan_ready / 非高风险自动代批（human 车道）/ high 不批且落请示 / `canAutoApprove` 只拦 high / 拒绝后不重试 / 四段结构入库 / 缺段被拒 / info 只需 topic / 多轮回复 / 归档清阻塞 / 有 open 请示不抢跑 / 验收用 dispatcher 身份 / 证据不足不自动收。

### 一个教训（第三次同类）

| 版本 | 能力 | 接线情况 |
| --- | --- | --- |
| v1.27 | `patchIssue` | **零调用方** |
| v1.30 | `openMergeRequest` | **accept 之后忘了调** |
| v1.31 | tick 的九步 | **漏了整整两列** |

前两次是「函数没接上主流程」，这次是「主流程本身缺了一段」。共同点：**单测覆盖不到「流程完整性」** —— 测了 `claim` 能工作，没测「从建卡到开工有没有人负责推」。

所以判断自动化是否成立，标准不是「每个动作都能执行」，而是**「从最上游到最下游，中间有没有断点」**。
## v1.30：merging 列不再是死胡同

**一句话**：`accept` 把卡推进合并列之后，**没有任何一步会去开 PR** —— 于是 `mergeRequest` 永远是 null，人一点「审核通过」就报「没有 PR 快照，无法审核」。

### 现场

```
T-015  merging  headSha=675acf1(==baseSha)  无 worktree     mergeRequest: 空
T-036  merging  headSha=675acf1(==baseSha)  有 worktree     mergeRequest: 空
pull_requests 表：0 条          merge_requests 表：空
```

### 三个缺陷串成一条链

| # | 缺陷 | 表现 |
| --- | --- | --- |
| 1 | `accept` 的 `onMoved` 只发通知「验收通过，准备开 PR」，**从不调用 openPr** | 卡进 merging 但永不产生 PR 快照 |
| 2 | `pr.open` 的 HTTP 入口直接调 `domain.openMergeRequest`，它要求调用方自带 `headSha` | 看板上没这个字段 → 手动开 PR 也必定失败（`headSha 必填`） |
| 3 | `merging` 列的「审核通过」不看有没有快照 | 点了只得到一句报错，不知道还能做什么 |

链条：**没有自动开 PR → 手动开也失败 → 审核必然报没有快照 → 卡死。**

### 修法

1. **accept 后自动开 PR**：`onMoved` 的 accept 分支在卡确实进了 `merging` 时调 `openPr`（commitAll → 读 headSha → 本地 PR 记录 → 按需推送建远程 PR）。成功发「PR 已开，等待审核」；失败在卡上写清原因并指向「跳过合并」。
2. **`pr.open` 走完整流程**：改成 `host.openPr`，与调度侧共用同一套逻辑，不再要求前端提供 headSha。
3. **merging 列把该做的事摆出来**：没有快照时多一个「① 开 PR 快照」按钮，「审核通过」变灰并注明「先开 PR」；报错文案改成「先点开 PR 快照，或改用跳过合并」。

### 现场处理

- **T-036**：worktree 里 4 个未提交文件（`useTaskPolling.ts` / `taskStatus.ts` + 两个测试）确属本卡范围 → 提交为 `94943e5` → 补 PR 快照 `mr_mvxheefa07qtnq` → 审核通过 → **`done/merged`**。
- **T-015**：无 worktree、`headSha == baseSha`、零提交 —— 本来就该走「跳过合并」→ **`done/merged-skipped`**。

### 验收

- `node test/smoke.mjs` → **330 checks passed**（v1.29 基线 327 + 3）
- 新增断言：无快照时报错要指向下一步 / 跳过合并能收口 / 有快照后审核能正常到 `done/merged`

### 一个教训

「有个动作能推进状态」和「有个动作能走完流程」是两回事。

`merging` 列有四个按钮，但它们都假设快照已存在 —— **没有一个负责把快照造出来**。这和之前 `patchIssue` 写好却零调用方是同一类错误：能力存在，但没接线。
## v1.29：评论 ID 唯一化 + 提示词分层 + worktree 共享环境

**一句话**：三个「早晚要出事」的结构问题一次收口 —— 评论号靠全局计数器、提示词只在源码里、每个 worktree 都要重装 2.7GB 环境。

### ① 评论 ID：从全局计数器改成天然唯一

4 个写入点原来都是：

```js
id: 'c_' + String(s.seq.comment).padStart(5, '0')
```

问题：`seq.comment` 是**全局**计数器（跨项目共享），项目 A 的号会被项目 B 撑大；`padStart(5)` 只在 99999 以内有效，越过后位数变化；计数器与评论生命周期解耦（删卡不回退）。

改成 `newId("c")`（与 `prj`/`mr`/`rp` 同风格：base36 时间戳 + 序号 + 随机）。**旧 id 保留不迁移** —— `hasFlowMarker` 只匹配 `<!-- dsh-flow ... -->` 整体、不解析 id，读取侧只做字符串匹配，新旧天然共存。

顺带一个实测澄清：**本地目前没有评论条数上限**（`injections` 2000、`message_log` 5000 都有截断，评论没有）。当前 `flow.json` 3.25MB 里评论只占 0.16MB。本版**不引入**上限 —— 那等于删审计证据。

### ② 提示词分层：内置只读 + 项目自定义 + 角色自定义

新增 `lib/prompts.js`，导出 `builtinWorkerRules()` / `builtinDispatcherRules()`。三层按顺序拼接：

```
内置默认（只读，代码维护）→ 项目自定义（config.promptOverlay）→ 角色自定义（agent.promptOverlay）
```

**内置部分补上了之前缺的关键说明：**

- 工人：你的目录是独立 git worktree，但 **`.venv`/`node_modules` 是只读的 junction**，不要装包改版本；跑不出环境要 block 并写清命令+报错，不能一句"没有 pytest"就停。
- 调度：**`head_sha` 不要手填**（系统自动读 HEAD），`audit-xxx-verified` 这类非哈希值会被 guard 拒绝；**无提交的卡留空**，走 `done-no-merge`；要不要合并由系统判、怎么合并由调度定。
- 审计填写：`stopReport.tests` **没跑就写"未执行"并说明原因，不许编造通过数量**。

设置页新增第 5 个 tab「提示词」：内置两段可展开只读，项目/角色两个 textarea 可编辑（blur 即存，下一次派工生效）。

### ③ worktree 共享环境（junction）

`.venv`（2.7GB）与 `node_modules`（778MB）被 `.gitignore` 忽略，`git worktree add` 不带过去 → 每个 worktree 都是裸 checkout → worker 报「环境里没有 pytest」。

实测结论（不是推测）：

```
fs.symlinkSync(target, link, "junction")  → 成功，Scripts/python.exe 可见
junction 的 node_modules 跑 vitest         → 7 passed
git worktree remove --force 之后           → 主仓库 deps/KEEP.txt 幸存
```

于是：`ensureWorktree` 建完 worktree 立刻 `linkSharedDirs`（`backend/.venv`、`BillNote_frontend/node_modules`、`.venv`、`node_modules`，**存在才链、不存在静默跳过**）；`removeWorktree` 先 `unlinkSharedDirs` 再删目录（双保险 —— 虽然实测 git 不会跟着 junction 删，但"依赖它一直如此"的代价是主仓库 2.7GB 被清空）。

链接失败只写一行 comment，**不阻断派工**。

### ④ 同步失败不再被藏

客户端「同步 issue」按钮原来只拼 `stats`，而失败形状是 `{ ok:false, reason }` —— 于是提示条显示「同步完成：新增 0」，实际半个功能全废。现在：

- 失败走 `.catch`（`postAction` 在 `ok:false` 时是 `throw`，`.then` 里根本收不到）；
- 提示「同步失败：<reason>」+ `lastError` + 熔断到几点；
- `issueCloseEnabled` 进 `DEFAULT_CONFIG`（默认 `true`），设置面板可见。

### 验收

- `node test/smoke.mjs` → **327 checks passed**（v1.28 基线 321 + 6）
- `node test/client.mjs` → 全绿（+8 条提示词/同步断言）；`tool-schema` 6 项全过
- 新增断言覆盖：新 id 格式与唯一性、旧 id 兼容、工人/调度内置规则存在、项目与角色自定义叠加、junction 存在才链不存在跳过、断链不伤主仓库、`issueCloseEnabled` 默认值
## v1.28：验收不再让人抄 SHA，dispatch 也不再被挡在门外

**一句话**：`accept` 原来是「只有 human 能点 + 必须填 head_sha」，于是①人在对话里授权了，调度还是被拒；②合并人根本不知道提交号，只能瞎填——线上就把 `audit-T035-verified` 填了进去，而旧闸门只查"非空"，伪造值一路通过。

### 现场（三个问题一起暴露）

1. **T-035 已是 done，但 worktree 里还有 8 个未提交文件** —— 验收后又改了东西，交付物跟验收时不是同一个。
2. **headSha 是伪造的**：`audit-T035-verified`，既不是 SHA 也没人校验形状。
3. **三张票验收不了**：`角色 dispatcher 不能执行 accept`，即使人在对话里已经授权。

### 工作树是真的 git worktree，不是沙箱

实测 T-035 的 worktree：

```
$ cd .flow-worktrees/BiliNote/T-035 && git rev-parse --show-toplevel
C:/Users/Administrator/Desktop/prjs/.flow-worktrees/BiliNote/T-035
$ git rev-parse --abbrev-ref HEAD
flow/T-035
```

它是标准 `git worktree add` 出来的独立 checkout，分支 `flow/T-035`，**不是把沙箱当工作树**。但你观察到的现象有真实成因：**每个 worktree 都是裸 checkout，被 gitignore 的本地环境（`backend/.venv`、`node_modules`）不在里面**。主仓库 `.venv` 是 9-25 建的，T-035 worktree 的 `.venv` 是今天 13:58 才建的——worker 说"环境内没有 pytest"在当时很可能是真的，它得自己装一遍。

这是**设计缺陷**：让每个 worktree 各自重装环境既慢又容易失败。

### accept 的两处放宽

| 原来 | 现在 |
| --- | --- |
| `roles: ["human"]` | `roles: ["human","dispatcher"]`，但代理代收**必须带 `acceptedBy`（人类授权凭据）** |
| `guard: headSha 非空` | headSha **可空**（无提交的卡）；一旦有值必须是**十六进制提交号形状** |

语义变成：**人可以点，也可以授权后由调度代点**；凭据写进审批记录，事后能查谁授的权。没有凭据的代收一律拒——AI 不许自批自收。

`head_sha` 也不再让人手抄：`domain.move` 在 accept 时**自己去 worktree 读 HEAD** 自动绑定（无 worktree/无提交就留空）。前端「验收通过」按钮上的 `window.prompt` 已删。

### 新增：验收后漂移检测

`domain.detectPostAcceptDrift(taskId)` 回答一个问题：**这张卡验收之后，worktree 又变了吗？**

真机结果：

```
T-035 → drifted: true | 未提交: 8 | 伪造 sha: true
T-039 → drifted: true | 未提交: 1 | 伪造 sha: true
```

它用 `git.dirtyFiles()`（`status --porcelain`）而不是 `changedFiles()`——后者比的是两个提交之间的差异，传错参数会静默返回空数组（第一版就踩了这个坑，8 个文件报成 0 个）。

### 一个坑值得记下来

`changedFiles(repo, from, to)` 签名是 `git diff --name-only from HEAD`。我按"工作区脏文件"的语义传了 `changedFiles(wt.path)`，`from` 是 undefined，命令失败 → 返回 `[]` → **检测报告"没有漂移"**。

**失败的检测比没有检测更危险**：它给出一个"一切正常"的绿色结论。所以新加的 `dirtyFiles` 在 git 失败时返回空数组的同时，调用方必须能区分"真的干净"和"命令跑挂了"——`detectPostAcceptDrift` 因此保留 `headDrift`/`bogusAcceptedSha` 两个旁证字段。

### 验收

- `node test/smoke.mjs` → **321 checks passed**（v1.27 基线 316 + 5）
- 新增断言：dispatcher 带凭据可代收 / 无凭据代收被拒 / 无 headSha 也能验收 / 伪造 sha 被拒 / `detectPostAcceptDrift` 存在
- client 契约与 tool-schema 全过

### 遗留

- **历史脏数据**：T-035/T-039 的 `headSha` 仍是伪造值，检测会标 `bogusAcceptedSha: true` 但不会自动改（改历史验收记录等于伪造审计）。
- **worktree 环境**：目前仍需各自装 `.venv`/`node_modules`。可以做成 `worktreeCreated` 钩子自动从主仓库复制或软链，但那是下一版的事。
## v1.27：同步器的三个断点（token 没进请求 / 错误被咽 / issue 从不关闭）

**一句话**：`pushRemote=true`，同步器每 60 秒跑一次，事件里写着 `errors: 0`，但本地 129 条评论、远端 issue #3 只有 **1 条**。三个独立缺陷叠在一起，让「同步一直在跑」和「一条都没推上去」同时成立。

### 现场

- T-012 本地 **24 条**评论，远端 #3 只有 **1 条**（17:46 那条调研结论）。
- `sync.applied` 每轮都是 `comments: 0, errors: 0`。
- 同时 `sync.circuit` 每 5 分钟刷一次 `{"status":403,"reason":"http-403"}`。

### 三个缺陷

**① token 根本没进请求（根因）**

`lib/remote.js` 有 `withToken()`（显式 token → `gh auth token` → 匿名），但它**只被 `probeRepo` 用过一次**。真正发同步请求的函数（`listIssues` / `createComment` / `createRemoteIssue` / `addIssueLabel` …）全都直接拿 `cfg.remote`，而 `cfg.remote.token` 是空的（用户靠 gh CLI 登录，本就不该把 PAT 贴在配置里）。

实测证据：

```
匿名 POST https://api.github.com/repos/El1mir/BiliNote/issues/3/comments
→ 403 {"message":"API rate limit exceeded for 134.195.101.195."}
```

GitHub 对匿名请求只给 60 次/小时。同步器每 60s 跑一轮、每轮 7+ 个请求，几分钟就打穿 → 进熔断 → 5 分钟后再撞 403。**gh token 一直在 keyring 里（41 字符），只是从来没被用上。**

**② 错误被咽掉**

拉取失败那条分支（`runProject` 的 `if (!pulled.ok)`）调用 `applySyncResults` 时**只落 outbound，不落 errors**。于是出站 403 明明记进了 `results.errors`，`sync.applied` 却显示 `errors: 0`，唯一痕迹是另一条 `sync.circuit` 事件。

**人看到的是"同步完成、没有变化"，实际是半个功能全废。这比失败本身更坏：失败被藏起来了。**

**③ issue 从不关闭**

`patchIssue()`（支持 `state: closed` + `state_reason: completed/not_planned`）写得完整，**但没有任何地方调用它**。所以"本地 done、远端还 open"是常态 —— 正是你说的「这个票已经完成了 issue 还没有关闭」。

### 修法

- **`withToken` 导出 + 全路径接通**：`sync-engine` 新增 `remoteFor(project)`，按项目缓存带 token 的 remote（TTL 10 分钟 —— gh CLI 是子进程，不能每轮 spawn）。7 处 `remoteOf(project)` 全部换成 `await remoteFor(project)`。新增 `tokenResolver` 注入点（单测不能真去 spawn gh）。
- **错误落盘**：拉取失败分支补 `lastError`，把本轮所有错误（含出站 403）一起落进 `sync.applied`。
- **关闭 issue**：`postPush` 尾部对 `done` 的卡发 `state: closed + reason: completed`、`cancelled` 发 `not_planned`；已关过的按 `task.remote.state === "closed"` 跳过，不重复 PATCH。结果经 `issueClosed` → `applySyncResults` 写回 `task.remote.state`（**只写远程事实，不动状态机** —— 远程不能驱动卡的状态）。
- 开关：`config.issueCloseEnabled !== false`（默认开），想自己在 GitHub 上管生命周期可以关掉。

### 标签这块本来是对的

`desiredLabels` 已经完整：`flow/<列>` + `lane/human|auto` + `prio/高|中|低` + **`blocked`**，`diffLabels` 也只增删受管标签、不碰人贴的标签。它没生效纯粹是被 ①（403）拖死 —— 同一批请求全都 401/403 了。

### 验收

- `node test/smoke.mjs` → **316 checks passed**（v1.26 基线 311 + 5）
- 真机验证（不注入 tokenResolver，走默认 `gh auth token`）：

```
POST AUTH✓ /repos/El1mir/BiliNote/issues/3/comments
GET  AUTH✓ /repos/El1mir/BiliNote/labels?per_page=100
POST AUTH✓ /repos/El1mir/BiliNote/issues/3/labels  （×3）
写请求带 token 比例: 7/7        ← 修复前 0/7
```

### 遗留（需要你定）

- **积压**：`since` 之后共 67 条评论，只推上去 21 条，**46 条积压**。重启后同步器每轮推 5 条（`limitComments`）慢慢消化。
- **历史不回填**：`since`（10-31T17:42:44Z）之前的 62 条按设计永不外推（当时定的"只同步配置之后出现的"）。需要回填得单独做一次。
## v1.26：human 车道的卡不再卡死在 planning

**一句话**：调度建出来的卡 claim 进 `planning` 之后就永远走不下去——因为代理**没有写计划的工具**，而 `approve` 只有人能执行。这一版补上 `flow_task_plan` 与 `approve_by_dispatcher`，并把「点了没反应」的提示条从遮罩底下捞出来。

### 现场

卡上原话：「卡片仍为 human lane planning（Flow 当前不能将这类新卡直接分派给子代理或由代理推进 human acceptance），所以不伪造状态迁移；人工可在看板验收/关闭。」

线上 `T-035..T-039` 五张卡，全是 `planning` + `planRev=0`，卡了一整天。查证创建者：`task.created actor="agent"` —— 调度用 `flow_task_create` 建的。

### 三层根因

| # | 根因 | 证据 |
|---|---|---|
| 1 | **代理没有写计划的工具** | `setPlan` 在 `lib/tools.js` 里只出现一次，且在 `flow_publish` 内；`flow_task_create` 不接受 plan |
| 2 | **approve 只有 human 能执行** | `TRANSITIONS.approve.roles = ['human']`，`approve_by_chief` 又限定 `lane==='issue'` |
| 3 | **错误提示被抽屉遮罩盖住** | `elementFromPoint` 命中的是 `.flowv-drawer-mask`（z=220），`.flowv-note` 是 `z-index:auto` |

第 3 条是「点了没反应」的全部真相：接口**已经**返回 400 并说明原因（`plan 为空` / `先写计划再批准`），`notice` **也**确实渲染了，只是用户看不见。

### 改法

**`flow_task_plan`（新工具）**：写/改计划，rev+1，写完**当场预筛风险**并把结论告诉调用方——

> 已写入 T-035 的计划 rev 1。风险判定：low（未命中风险规则）。可以 `flow_task_move(action="plan_ready")` 提交待批，再用 `approve_by_dispatcher` 代批开工。

**`approve_by_dispatcher`（新迁移）**：调度/主调度代批 human 车道的方案。**不放开 `approve` 的 roles**，因为 `approve` 是「人看过并同意」的人行闸门；单开一个动作，审批记录里的 `actor` 是具体 agent id，事后能区分人批的还是代批的。

闸门保留在 guard 里：`risk.level === 'high'` 直接拒（改 schema / 加依赖 / 动核心文件仍必须人拍板），且风险在代批前**现算**，不信 `task.risk` 上的旧值（方案改过后旧结论不该给新方案盖章）。

**`claim` 会叫醒调度**：human 车道的卡被认领进 `planning` 后，以前是完全静默的（没人写计划、调度也不知道有这活）。现在认领即 `notifyDispatcher` 投一份巡检包，包里把「用 `flow_task_plan` 写方案 → `plan_ready` → 低风险可 `approve_by_dispatcher` 代批」写成了明确选项。

**提示条改成 toast**：`.flowv-note` 从文档流改为 `position:fixed` + `z-index:260`（高于抽屉 221 与弹窗 230），顶部居中。并保留了一个回归断言用 `elementFromPoint` 做命中测试——**提示存在不等于提示可见**。

### 回答「开了低风险自动批准会不会就好了」

**不会。** `canAutoApprove` 有三个前置：`autoApproveIssue === true`、`task.plan.text` 非空且 `revision > 0`、`risk.level === 'low'`。而这些卡 **planRev=0**，第一个条件就不满足。更重要的是它只在 `awaitingApproval`（issue 车道的调研轮收尾）被调用，human 车道压根不经过那条路。

真正的缺口是**写不写得出计划**，不是批不批。自动批准解决的是「有方案、低风险、但等人点头很慢」，这里缺的是「根本没方案」。

### 验收

- `node test/smoke.mjs` → **311 checks passed**（v1.25 基线 306 + 5）
- 端到端（真实 store + 真实 dispatcher）：建卡 → claim（通知落 `ag_002/human调度1`，`message_log: inspect/ag_002`）→ `flow_task_plan`（rev=1，风险 medium）→ `plan_ready` → `approve_by_dispatcher` → **`running/executing`，`activeRunId=run_001`**，审批记录 `actor=ag_002(dispatcher)`
- 浏览器实测：提示条 `z=260`、`position=fixed`、`elementFromPoint` 命中 `flowv-note`（修复前命中 `flowv-drawer-mask`）
- 新增断言：调度能写计划 / 写后能推 plan_ready / 能代批低风险方案（并留 actor 记录）/ **高风险代批被拒且卡停在原地** / 工人不能代批

## v1.25：评论/计划不再被截断，改成渐进式分段读

**一句话**：以前工人交的长报告从**存储**就被砍到 4000 字符、读取时再砍到 200 字符，批准者永远读不到全貌；现在原文完整保存，读多少、读哪段由模型自己按 `offset/limit` 决定。

### 线上事故

子调度复核意见原文：「c_00082 在工单可读内容中止于 spec 015 中途（约 4KB 截断），未能复核 016–020、最终发现和完整拆票；plan rev 1 仍是阶段性核查方向……**收到后再判断是否批准，当前不推进**。」

查证：`c_00082` 的 `content.length` **正好 4000** —— 不是巧合，是 `clampText(content, 4000)` 的刀口。而**原文一旦被 clamp 就永久丢失**，重写也补不回来。

### 三层截断，全都在同一条链上

| 层 | 位置 | 旧上限 | 后果 |
|---|---|---|---|
| 存储·评论 | `domain.comment` | 4000 | 原文丢失，事后无法补读 |
| 存储·计划 | `domain.setPlan` / `pickPlanText` | 8000 | 方案主体被砍，"批准者只看到前半段" |
| 读取·详情 | `flow_task_detail` | 最后 8 条 × 每条 200 字 | 就算存了全文也读不到 |

### 改法

- **存储放宽**：新增 `core.COMMENT_MAX = 40000`，评论（4 处写入点：人工/远程/系统/入站）与 `plan.text` 统一用它。不定成无穷大是因为 state 是整份 JSON、每事务全量 stringify（约 15MB），单条无上限等于给写放大开口子。
- **读取改渐进式**：
  - `flow_task_detail` 只返回**评论索引**（id / 角色 / 字符数 / 首行 90 字）+ **计划正文前 6000 字符**（超长时明确告诉你"还有多少、怎么读全"）。
  - 新增 `flow_task_comment_read`：`{ id, offset?, limit? }` → 返回 `chars / offset / nextOffset / hasMore`，一段段读，读到 `hasMore=false` 才算读完。**评论传 `c_00082`，计划传 `plan:T-012`**，同一个工具。
  - 单段上限 20000 字符，避免一次灌爆上下文。
- **注入侧不再假装完整**：远程评论注入到工人会话时仍只放前 3000 字符（那是提示不是载体），但超长时会明说「完整版共 N 字符：先用 `flow_task_detail` 拿评论 id，再用 `flow_task_comment_read` 分段读完再动手」。

### 为什么不是"直接把上限调到很大"

长报告几万字，一次性塞进上下文既贵又容易把窗口吃满；而读取侧截断又会让模型永远看不到后半段。**分段 + 让模型自己决定读多少**，才是既不丢内容、又不失控的做法。

### 验收

- `node test/smoke.mjs` → **306 checks passed**（v1.24 基线 299 + 7）；`node test/client.mjs` 全绿；`node test/tool-schema.mjs` 6 项全过。
- 新断言覆盖：长评论按原文存储且末节锚点仍在、detail 只给索引且报告真实字符数、分段拼回来与原文**逐字相同**（无缺口无重复）、单段上限生效、`plan:<taskId>` 能读到计划末尾（旧实现 8000 就断）、detail 输出计划正文。

### 一个仍未解决的边界

schema 测试的键名提取器会把 payload 字面量里三元表达式中的变量当成新键（`nextOffset: hasMore ? end : text.length` 被读成多了个 `end`）—— 已在代码里改成先算变量规避，但那个提取器本身对复杂表达式不够健壮，属于测试工具的已知局限。

## v1.24：一键停止全部调度 + 会话事件回灌 + 车道路由修复

**一句话**：以前"停下来"只能靠人一张张卡去点取消；这一版给了红色的「停止全部调度」，按下之后不再派工、不跑 tick、报错与停止生成也不再发给调度。

### 一键停止（全局控制位）

- 状态落在 `state.control = { halted, haltedAt, haltedBy, reason }`（`SCHEMA_VERSION` 4 → **5**，带 4→5 迁移；老文件一律按"未停止"处理 —— 迁移不该把在跑的系统突然冻住）。
- `domain.haltAll()` 在**一个事务**里同时做两件事：立控制位 + 把所有 `running` 的 run 收成 `interrupted`（`stopReason: '调度被手动停止（一键停止）'`）、清 `task.activeRunId`，并回传 `runIds/sessionIds` 给上层逐个 `cancelSession`。分成两次写的话，中间那一瞬 tick 会读到"已停但 run 还在跑"，白烧一次会话。
- 挡在**所有**自动推进的入口上，不只是 tick：`dispatch()` / `scheduler.tick()`（整轮不跑，连收尸、重试、自动验收、自动合并、远程同步一起停）/ `watchEvents()` / `steerSupervisor()` / `notifyDispatcher()` / `dispatcher.onSessionEvent()`。
- `resumeAll()` 只清控制位，**不动任何卡的状态** —— 恢复后要不要继续推，人自己决定。
- 界面：顶栏「停止全部调度」（红）↔「恢复调度」（主色）同一个位置；停止期间顶部常驻一条横幅并写明停止时刻。

### 会话事件回灌：报错与「停止生成」终于有信号了

以前只有工人**自己调** `flow_task_move(stop)` 才会通知调度；模型报错、用户点停止生成、进程崩溃，全靠 `stuckRuns`（30 分钟）或 `maxRunMs`（3 小时）兜底 —— 中间整段时间调度不知情，人也不知情。而且心跳定时器是**纯墙钟**（60s 刷新，与工人是否真干活无关），卡死的 run 也会一直被续命。

现在订阅 `ctx.on('session/event')`（`index.js`，串行投递避免并发写库）→ `dispatcher.onSessionEvent`：

| 事件 | 判定 | 动作 |
|---|---|---|
| `error` / `session/error` | infra 失败 | 收 run(failed) → `recordFailure(infra)` → 退避重试或 block → 通知调度 |
| `turn/end` + `reason.kind === 'error'` | infra 失败 | 同上（带 `LlmFailure` 原文片段） |
| `turn/end` + `'aborted'` | **人停的** | 收 run(interrupted) → 清 retry → 评论「等你决定是重派还是改方案」→ 通知调度，**不自动重派** |
| `turn/end` + `'interrupted'` | 进程崩溃孤儿 | 同 aborted |
| `turn/end` + `'max-tokens'` | 内容失败 | 走内容预算（2 次） |
| `turn/end` + `completed` / `blocked` / `forked` | 正常 | **不碰** —— goal 模式下工人每轮都 completed，当失败会把自己的活打断 |

收 run 带 `runId` 走既有 fencing：期间要是重新派过工，旧 run 的迟到事件自动作废（`stale-run`）。

### 修：issue 的通知发到了人类调度

`notifyDispatcher` 原来取"项目内第一个 dispatcher"，**不看车道** —— issue 车道的巡检包全灌进 human 车道的调度员1。线上 `message_log` 有铁证：同一张 issue 卡，`watch:task.blocked → ag_025`（issue 调度，走 `supervisorFor`）、`inspect → ag_018`（human 调度，走 `notifyDispatcher`）。现在先按车道找（`supervisorFor(task)`），找不到才退回项目内任意调度员。

### 修：两处日志噪音

- `heartbeat failed run_0xx: unknown run`：删卡会连带删 runs，而心跳定时器还挂着那个 id，下一拍撞进 `must(run, 'unknown run')` 抛错。现在返回 `{ ok: false, status: 'missing' }`，定时器据此静默停表。
- `rename EPERM: operation not permitted, …flow.json.<pid>.<seq>.tmp -> flow.json`：Windows 上 rename 覆盖 15MB 目标时，只要目标被任何进程持有读句柄（杀软/索引/editor tail）就会失败。`Store.persist` 抽出 `replaceFile`，对 EPERM/EBUSY/EACCES/ENOENT/EEXIST 做 6 次退避重试（15/30/…/90ms），全失败才抛（宁可这一次事务回滚，也不留半份文件）。
- `bili: watcher registration failed …` 与本插件无关：它来自 `billion-context` 的 agent 适配层。

### 验收

- `node test/smoke.mjs` → **299 checks passed**（v1.23 基线 285 + 14）；`node test/client.mjs` → 全绿。
- 线上端到端（真 dsh web）：`flow.halt` → `control.halted=true`、`event.tick` 返回 `{halted:true, dispatched:0}` → `flow.resume` → `control` 清空、tick 恢复正常。

## v1.23：修 issue 回声级联（同一条 issue 长出几十张卡）

**一句话**：v1.22 的双向同步缺了一道"别把自己的输出当输入"的闸，线上 20 分钟里一张卡繁殖成 18 张；这一版补上三道闸并把脏数据对账掉。

### 现场

- 19 张卡里 18 张是回声（T-016..T-033），title 只有三种，按 17:43 / 17:47 / 17:48 / 18:00 / 18:06 五批成簇生成，**每批 3–5 张、彼此相差不到 1 秒**。
- `originRef` 直接指认：`github:issue:6:updated:2026-10-31T17:46:48Z` 与 `github:issue:6:updated:2026-10-31T17:48:12Z` —— **同一条 issue 的两个 revision 各建了一张卡**。
- `issues_mirror` 19 条里 17 条 `bodyHasMarker: true`，即自己推上去的 issue 又被拉回来当新输入。
- 远端代码仓库同时被灌了 #3..#23（21 条同题 issue）。

### 三处根因（缺一不成灾）

| # | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| ① | 幂等键把 rev 编进身份 | `lib/event.js` `originRefOf` 原 `[src,kind,id,action,rev].join(':')` | issue 每改一次（改标题/加评论/打标签都推 `updated_at`）就变成"全新事件"，再建一张卡 |
| ② | 入站建卡不写 `task.remote` | `lib/event.js` `taskInputFromEvent` | `pickOutbound` 判据是"有 remote 就跳过"，于是入站卡被当本地新卡**再推一条新 issue** |
| ③ | 两条入站路径都不认 flow marker | `lib/domain.js` `mergeRemoteItems`（`syncRemote` 与 `applySyncResults` 共用） | 自己推出去的 issue 回流照收照建。`pullProject` 有过滤，但「同步 issue」按钮走的是老 `syncProject`，完全绕过 |

闭环：卡 → 推出 issue（带 marker）→ 下一轮收回 → 建卡（没有 remote）→ 再推 → **指数放大**。

顺带暴露 ④：`lib/dispatch.js` 顶部**从来没 import** `assessPlanRisk`/`canAutoApprove`/`createPull`。`node --check` 只查语法不查标识符，所以测试全绿；线上第一次走自动批准就 `ReferenceError`，方案落库失败、卡被 block。

### 修复

- `originRef` **只拼来源身份**：`github:issue:42`；修订写进 `task.originRev`。新增 `originRefMatches` 做前缀兼容 —— 老库里 `…:opened:rev` 的旧键仍能命中同一张卡，升级不会让它们变成"查不到的新卡"。
- 入站建卡当场写 `task.remote = { source, issueNumber, url }`。
- `mergeRemoteItems` 遇 `hasFlowMarker(body)` 直接跳过（`stats.echo++`）—— 一处覆盖两条入站路径。
- `ingestIssueEvent` 三道守卫：flow marker → 自回声；`originRef` → 同一条；**`remote.issueNumber` → 同一号**（兜住老库里没有新格式 originRef 的卡）。
- `dispatch.js` 补齐三个 import。
- `event.sync` / `flow_issue_sync` 改走**同步引擎**（带 marker 过滤 + 出站 + 评论 + PR 回读），老 `syncProject` 降级为引擎不可用时的退路。
- 新增 `domain.repairInboundIdentities()`，接在启动链上：按 `originRef` 把 `remote.issueNumber` 改回**来源**号（误推的号存 `echoIssueNumber` 供追溯），同一条 issue 的第二张卡只打 `duplicateOf` 标记 —— **删卡是人的决定，代码不删**。

### 验收

- `node test/smoke.mjs` → **284 checks passed**（v1.22 基线 279 + 5）。
- 新回归块：同一 issue 两个 revision 只建一张卡 / 入站卡带 `task.remote` / 带 marker 的回流被拒 / 入站卡不会再被出站捡走 / `repairInboundIdentities` 三类脏数据（回声号、缺 remote、重复卡）。
- 线上数据：`recordIssues=false` 刹住级联 → 删掉 18 张回声卡（保留 T-011..T-015）→ 重启后由 `repairInboundIdentities` 把 T-014 的 remote 从 #5 改回 #1、T-015 补上 #2（已在状态副本上 dry-run 验证）。

## v1.22：项目级双向同步（远程 = 镜像面，不是入口）

**一句话**：配了 GitHub 之后，配置时刻**之后**新建的卡与评论双向同步，PR 默认建到远程，合并把提交摘要贴回 issue；方案可自动批准但验收永远由人点。

### 新增能力

| 方向 | 内容 |
|---|---|
| 入站 | issue 建卡（`sync.since` 之后才建）、**评论落「讨论」区并进管道**（卡在跑 → 注入工人；没跑 → 叫调度员）、PR 状态与评审回读、三类唤醒 |
| 出站 | 卡片建 issue（带 marker）、评论外推（**系统评论走白名单**，见下）、受管标签差异集同步、PR 创建、合并提交摘要 |
| 就地 | 方案风险评估（`assessPlanRisk`）、run fencing、重启对账、双预算重试、3h 上限、僵尸行清理 |

### 系统评论不是全推，是按"对人有没有用"推

`lib/sync.js:systemCommentOutbound`：**不外推**「已通知调度员 / 已注入 / 已建 worktree / 已派工 / 已让工人 / 巡检 / 水位 / 已归档 / 已清理」；**外推** 状态变化、阻塞、合并、审核、计划、验收、冲突、`#引用`。判据不是"谁写的"——系统写的状态变化恰恰是人在 GitHub 上最想看到的。

### 自动批准分三层（不是一刀切）

1. **纯函数预筛** `assessPlanRisk`（零模型成本）：命中 schema/migration、新增依赖、改 `package.json`/`tsconfig`/`pnpm-lock`/CI、删目录、改 `lib/core.js`/`lib/domain.js`/`index.js`/`cordis.patch.yml` → **high 直接 block**，评论写清命中哪条。
2. **调度判断**（主路径）：子调度读方案，可 `approve_by_chief` 也可 block。
3. **无人值守兜底**：`config.autoApproveIssue` 打开 + 预筛 low + 30 分钟无人插手 → 以 `chief / auto:risk-low` 身份代批，并留「若不同意请驳回」。

**`accept` 永不自动**：方案批错只是重写方案，验收批错要回滚代码。

### 三个踩过的坑（写在这里省得再踩）

1. **`MarkdownText` 是 `React.memo` 的产物（对象，不是函数）** —— 用 `typeof === 'function'` 判定会把所有评论误杀成纯文本（曾经实测 `flowv-md: 0 / flowv-plain: 25`）。
2. **出站必须先落 pending 再 POST**。反过来的话"POST 成功、落盘失败"会在重启后重复建 issue；pending 带 nonce，重启后按 nonce 在远端前 30 条里认领。
3. **远程事实不能驱动状态机**。远程合了 PR、关了 issue、改了 `flow/*` 标签，都只落 system 评论与 `pr.remote`。状态机只有一个写者（I5）；两个写者一定会打架。

### 验收

- `node test/smoke.mjs` → **279 checks passed**（v1.21 基线 251）；`node test/client.mjs` → client contract 全绿。
- `SCHEMA_VERSION` 3 → **4**（迁移幂等：`tasks[].remote/runSeq/retryAfter/risk`、`task_comments[].remote`、`runs[].seq/infraAttempts/attempts`、`pull_requests[].remote`、`remote_sync`、`seq.outbound`）。
- `outbox` 加 5000 条上限（实测曾 4 万条，是 flow.json 撑到 15MB 的主因）。

### 明确不做

- **公平让渡（yield/boost）**：dsh-flow 派工是即时调用，没有可让的队列。纪律保留 —— 失败只登记 `retryAfter`，由 tick 统一重派，不在失败分支递归 dispatch。
- **首轮全量 backfill**：用户要"配置之后出现的"才同步，历史 issue 只进 mirror 不建卡。
- **`master_ci_failed` / `ci_coord_comment`**：DSH 没有共享 master 与协作评论协议。
- **远程合并自动跟随**：远程按了 merge 不等于本地验收通过。

## v1.21：1920 排版 + issue 同步断链

两件事：宽屏下看板难看，以及「在远程发的 issue 根本进不来看板」。

### 1. 1920×1080 下的看板（实测内容宽 1640）

用 iframe harness 把 1920×1080 的真实媒体查询跑出来量的（现成视口只有 1384，改不了窗口大小）：

| 病灶 | 改前 | 改后 |
| --- | --- | --- |
| 六个空列吃满宽却只有 35px 高 | 列宽 `[187×5, 420, 187]`、列高 `[35,35,35,35,35,357,35]` | 空列固定 108px、七列等高 169，列宽 `[108×6, 895]` |
| 有卡列被上限切掉 | `.has-tasks{max-width:420px}`，右侧留死白 | 去掉上限，列吸收剩余宽度；卡片改网格 `minmax(min(100%,260px),1fr)`，3 张横排 |
| 四个分区排成 3+1 孤儿 | `auto-fit` 在 1640 下出 3 列，第二行落单 1 个 | 显式列数：默认 1 列 → ≥1100px 2 列 → ≥1780px 4 列 |
| 统计条抢宽度 | `.flowv-stats{flex:1 1 auto}` 占 769px，6 个 chip 只到 x=440 | `flex:0 1 auto`，让给车道 |
| 整块高度 | 克隆体 1171px | **675px** |

空列现在不再是一条没内容的胶囊，而是渲染该列的一句话说明（`COLUMN_HINTS`，之前只当 tooltip 用）。
1384（内容宽 1104）下复验：列宽 `[108×5, 359, 108]`、分区 2 列、无横向溢出。

**媒体查询顺序的坑**：同特异性下后写的规则胜出，所以必须「1 列基础 → 1100 两列 → 1780 四列」，
写反了宽屏反而停在两列。

### 2. issue 同步断链（三处语义错位）

| # | bug | 后果 |
| --- | --- | --- |
| 1 | `lib/scheduler.js` 的 `if (!remote || !remote.enabled) continue`——而 `lib/setup.js` 写 remote 时**从来不含 enabled** | 每 15s 的 tick 永远跳过同步；只有「初始化仓库」那一次性的 `syncProject` 能拉进来 |
| 2 | 游标取 `rows[rows.length-1].updated_at`，而 GitHub/Gitea 列表默认 `created desc` | 末行是**最旧**那条，游标被钉在过去，反复重拉同一批 |
| 3 | `event_inbox.payload` 只有 `{projectId,remoteId,rev,title,state}` | `lib/event.js` 拼 note 时读 `p.body`/`p.url` 全空 → 卡片 note 只剩「（来自 github #N）」；`scheduler` 判 PR 回写的 `p.merged`/`p.branch` 永远为假（死代码） |

修法：门禁改判 `recordIssues + owner/repo`（`enabled` 降级成可选关闭开关）；列表显式排序
（GitHub `sort=updated&direction=desc`、Gitea `sort=recentupdate`）+ 游标取所有行的最大 `updated_at`；
`payload` 补 `body/url/merged/branch/headSha`。顶栏加了「同步 issue」按钮（`event.sync`，仅 `recordIssues` 项目显示）。

真实仓库验证（`El1mir/BiliNote`）：游标从 `2026-10-31T13:48:52Z` 推进到 `14:19:59Z`（issue #2 的时间），
两条 issue 都带 url 与正文；手动同步后 #2 建出 T-015 并进入 issue 车道。

其余（评论同步、写回防环、403 冷却、CI 唤醒、重启对账、公平让渡、首轮 backfill）仍未移植，
逐条对照见 `docs/ework-机制对照.md`。

⚠️ **lib/*.js 的改动要重启 `dsh web` 才生效**：`@deepseek-ai/dsh-client-hmr` 只重载浏览器端 bundle，
宿主进程里的插件代码不会热替换。

已知边界：`remote.token` 为空、只靠 `gh auth token` 的项目，sync 走的是匿名请求（`withToken` 目前只在
`probeRepo` 里用）；公共仓库够用，私有仓库要显式存 token。另外一页 50 条，更旧的历史 issue 不会自动回填。

测试：`node test/client.mjs` 通过；`node test/smoke.mjs` **251 checks passed**（v1.20 基线 245，新增 6 条：
乱序 rows 取最大游标、`sort` 参数、payload 带 body/url、pull 的 merged/branch、note 拼正文、无 enabled 仍进同步队列）。

## v1.20：抽屉放宽 + 看板重排 + 讨论区 Markdown

三个问题一起改的，都由页面实测定位：

| 问题 | 实测 | 改法 |
| --- | --- | --- |
| 抽屉太窄 | 720px 时主列只有 436px，计划 1302px 长文挤在 236px 侧栏里逐字折行 | `width:min(1040px,94vw)`，两栏改 `minmax(0,1fr) 300px`；计划从侧栏搬进主列 |
| 看板溢出 | 七列各 168px，`scrollWidth 1236 > clientWidth 1060`，最后一列被裁 | 空列 `.is-empty` 收窄到 104px 且不渲染 body；有卡列 `.has-tasks` 拿 2.6 份宽度（220–420px） |
| 分区是死代码 | `.flowv-sections` / `.flowv-top` / `.flowv-board-head` 写了样式但渲染侧从没包上，四段纵向堆了 725px | 补上容器，分区 2×2 网格降到 365px；四段全空时收成一行 `.flowv-quiet` |

**Markdown 用官方 `MarkdownText`，不自写渲染器。** 它来自 `@deepseek-ai/dsh-client-ui-primitives`，
在 shell 的静态 seed 表里（`dsh-web-frontend` 的 `rM()`），插件 `require` 直接命中——不改 `package.json` 的 `dsh.client.inject`、不打包。

两个坑值得记：

- **`MarkdownText` 是 `React.memo(...)` 的产物，是个对象不是函数。** 用 `typeof x === 'function'` 判断会把它误杀成纯文本
  （页面显示 `flowv-md: 0 / flowv-plain: 25`），判断要接受 object。
- **不能无脑全量渲染。** GFM 会把单换行塌成空格，纯文本多行评论（worktree 路径那种）会被揉成一段；
  所以只对「像 markdown」的文本（标题/列表/围栏/引用/表格/粗体/行内 code）走 MarkdownText，其余保持 `.flowv-plain` 的 `pre-wrap`。

另外：评论列表限高 `min(54vh,560px)` 内部滚动（23 条评论原本把抽屉拉到 7043px，评论框推到最底部）；
描述卡加「编辑/预览」，预览渲染的是实时草稿而不是上次保存值；`.flowv-body` 底部留白 150px 躲开 131px 的 sticky 输入框。

**没改的地方**：`.flowv` 的 `height:100%` 断链修不了——断在 DSH 的 slot 容器（真正滚的是 `.wSkVaW_scrollBody`），
插件里硬设高度会把 sticky 输入框挤出容器、反而让整页滚。细节见 `docs/界面与装配设计.md` 的 v1.20 节。

## v1.13：非 Git 不卡"合并中" + 工位模型定死

**没 Git 就没有合并这一步。** 原来 `accept` 一律去 `merging`，而非 Git 项目开不出 PR
（`review_approve` 要 PR 快照 → 被拒）、`accept` 又只能从 `verifying` 发起 → 卡死。

- `accept` 的 `to`/`phase` 改成函数：要合并 → `merging/merge-ready`；不要合并 → `done/done-no-merge`
- 新增 `merge_skip`（merging → done）收尾历史卡；已有审核结论的不许用它绕过审核
- 判定靠 `task.noMerge`：dispatch 建不出 worktree 时自动打标

**工位模型在造出来时就写死。** 原来 `makeAgent` 留 `provider/model = null`，界面只能显示
"沿用默认"，而"默认"是**全局当前选择**——换个对话就变，看起来像配置串台（实际会话模型并没变）。

- 项目级 `defaultProvider/defaultModel/defaultReasoningEffort`，建项目时从 catalog 冻结
- 造工位直接写入；老项目只补空值，不动人工设过的
- **chief 不进模型配置**（归 DSH 会话设置）
- 改模型走 `agent.selectModel`（落库 + 切已有会话），切不动就如实报 `applied.ok=false`

## v1.15：零提交仓库要讲人话，重开要能"申请"

**`fatal: invalid reference: HEAD` 不是"没装 Git"，是"仓库一次提交都没有"。**
worktree 共享对象库，没有提交就没有可检出的内容（`--orphan` 能建出空壳，但里面没有项目文件）。

- `lib/git.js` 新增 `hasCommits()`；`addWorktree()` 无提交时返回 `{ reason: 'no-commits', hint }`，
  不再跌到 `HEAD` 兜底把 git 的裸报错糊到评论里
- `defaultBranch()` 在 `currentBranch()` 之后补 `symbolic-ref --short HEAD` 兜底
  （unborn HEAD 上 `rev-parse` 失败，但分支名是知道的）
- `noMerge` 从"一次失败永久"改成**每轮重算**：拿到 worktree 就撤销标记，并往讨论区写一条恢复记录

**重开是否决一次交付物，闸门仍然归人。** 但代理得能把异议送到人眼前：

- 新工具 `flow_reopen_request(taskId, reason)` → `domain.requestReopen()` 只挂
  `task.reopenRequested = { reason, by, at }`，**不动列**
- 发 `task.reopen_requested` 事件；人真的 reopen 后副作用把标记清掉
- 界面三处：卡片琥珀色「申请重开」+「无合并」标签、抽屉状态两行、抽屉顶栏横幅一键确认

## v1.19：初始化顺手把环境读出来（fork 的 issue、写错的 baseBranch）

BiliNote 那条 issue 车道一直是哑的，两个原因都不是代码 bug：

1. 它是 fork，**GitHub 对 fork 的 issue 默认关闭**——`recordIssues` 开着也同步不出东西。
2. `config.baseBranch` 写的是 `main`，仓库真分支是 `master`——三处 `addWorktree` 全用不存在的 ref，T-012 的合并就是这么丢的。
   子调度当时在巡检里报了这条（c_00032），但**没人会去改配置**。

这两件事机器都能读出来。所以「初始化仓库」现在先做一次环境自检：

| 读到什么 | 自动做什么 |
| --- | --- |
| 分支表 | `baseBranch` 为空或指向不存在的分支 → 取仓库真实默认分支（写错也纠正） |
| `git remote -v` | `remote` 没配或配的仓库不同 → 按远程地址补坐标（同仓库不动，保住人填的 token） |
| 上游 `has_issues` | true → 打开 `recordIssues` / `pushRemote` / `autoDispatch`；false 或探测失败 → **不动**，并说明原因 |
| — | `autoAccept` / `autoMerge` **永不自动改**：谁来把关交付质量是人的策略 |

判定逻辑是纯函数（`lib/setup.js` 的 `planSetup`），所以能脱网单测——`test/setup.mjs` 17 项把每条分支都钉住了。

拿不到 token 时用 `gh auth token` 兜底（你机器上本来就已经登录过），不用把 PAT 贴进项目配置。

跑完的提示里会多一行「环境：…」，例如：

> 环境：基础分支 main 在仓库里不存在，改成 master；远程仓库设为 El1mir/BiliNote（来自远程 origin）；已打开 issue 记录…

新增 action `project.setup`（带 `dryRun` 只报不改），`project.init` 会先跑它再建会话。

## v1.18：blank 会话不进侧栏，这是 DSH 的规则，不是初始化失败

「初始化仓库」跑完，提示说会话备好了，侧栏里却看不见——确认下来这是 **DSH 的既定行为**。

    // dsh-api-session-controller/lib/index.js:1840-1843
    init: () => ({ blank: true, lastPromptAt: null }),

    // :1807-1814  只有 turn/start 能把 blank 变 false
    const blank = state.blank && event.type !== "turn/start";

    // dsh-client-ui-workspace/lib/client.js:352-359
    // Ordinary sessions are visible; among blank sessions, only the current one is visible.
    if (session.blank && session.id !== current) return false;

也就是：**普通会话全显示；还没开张的会话只显示「当前正打开的那一个」**。
点「新建会话」它之所以出现，是因为它同时成了 current；切走就没了。

所以「初始化完」其实有三种状态，得分开看：

| 状态 | 怎么判断 |
| --- | --- |
| 会话已建 | `agent_sessions` 里有 `sessionId` |
| 已进工作区 | 该 id 在 `workspace.sessionIds` 里（v1.17 修的就是这条） |
| 侧栏可见 | 还需要**非 blank**（真跑过至少一轮），或它就是当前打开的那一个 |

选的是「保持语义正确 + 把出口写清楚」，**不**在初始化时给每个工位发一条唤醒消息：
那会让每个工位多一次模型调用，还会在会话里留下一条无意义的系统提示。备好但没开张本来就是准确的语义。

因此两处提示的尾部都多了一句：

> 这些会话还没对话过，侧栏只会显示当前打开的那一个；在「设置 → 代理」点「打开会话」即可让它出现。

`test/client.mjs` 断言这两句必须在，否则这个「看不见」会反复被当成 bug 报回来。

### 顺带记一个解压坑

会话文件 `session.v4.jsonl.zstd` 是**多帧 zstd**（一个事件一帧）。`zlib.zstdDecompressSync(整个文件)`
只解第一帧，会得出「这个会话只有 1 个事件」的错误结论。要按魔数 `28 b5 2f fd` 切开逐帧解。

按正确方式解完实测：ework 三个工位会话各 5 个事件、无 `turn/start`（blank）；
BiliNote 工人1 有 2749 个事件、含 `turn/start`（非 blank，可见）。

## v1.17：会话归属要能自愈，乱掉的会话要能一键收干净

v1.16 把工人会话的 cwd 收敛到项目工作区，但**归属是另一件事**：DSH 的工作区成员表里没有它，
侧栏就还是看不见。根因有两个，都不是 cwd 的问题：

- 项目的 `workspaceId` 可能是**失效 id**。ework 的 `prj_mvcgebz401r795` 记的是
  `ba8f61f8-…`，真实工作区却是 `49196b53-…`。旧代码把它原样交给 `session.create`，
  DSH 查不到工作区 → 不开工作区、只按 cwd 建会话 → 落进「未分组」。
- 「初始化」看到 `rec.cwd === wantCwd` 就直接早退，**从不校验、也从不修复**工作区成员关系。
  所以它每次都乐呵呵地说「已存在 3」，而那 3 个一个都不在工作区里。

修法（都在 `index.js`）：

| 动作 | 做什么 |
| --- | --- |
| `workspaceFor(project)` | `get(id)` → `resolveByPath` → `list()` 按路径找；找到不同的 id 就写回项目并打日志 |
| `attachToWorkspace(ws, sid)` | 挂完**复查** `ws.sessionIds`，因为 `attachSession` 对索引缺失的会话会早退、挂完仍不在成员里 |
| `ensureSession` / `resetSession` | 建会话时传解析出来的真实 `workspaceId`；走 cwd 分支时补挂一次 |
| `ensureProjectSessions` | 新增第六段统计「补挂工作区 N」 |
| `ensureProject` | 项目已存在、但拿得到真实 id 时也要写回（原来只建新项目时才记） |

配套的清理能力：`agent.clean`（归档该工位全部历史会话 + 逐条 `markSessionArchived`）与
`project.reset`（清完再跑一遍初始化）。界面上头部多了「清理并重建会话」，
点了先确认，再一步到位。`latestSession` 现在跳过 `archived` 记录——不然清掉的会话
会被下一次初始化捡回来，界面显示「会话已存在」却什么都看不见。

顺带修掉一条假日志：`workspaceId 自愈：ws_1 → ws_1`。调用方手里的 project 常是旧快照，
拿它跟解析结果比必然相同；改成读 `store` 里的 live 值再比。

测试补了三条能变红的：`project.init` 后每个工位会话必须在 `ws.sessionIds` 里、
失效 `workspaceId` 的项目必须按路径自愈成正确 id、`project.reset` 清完重建后仍在工作区里。
把 `workspaceFor` 的两处解析改成 `if (false && …)`，第一条与第二条立刻变红。

**顺带发现的测试盲区**：functest 的工作区桩一直是裸 `{id,path,title}`，没有 `sessionIds`、
没有 `attachSession`，`create` 桩也不挂工作区——所以「会话到底有没有真进工作区」这件事
从来就测不到；桩里的服务名还写成 `'workspace'`（真实是 `'workspaceController'`），
连归档路径都是死代码。桩已按真实实体补齐，这一步比修 bug 本身更重要。
## v1.16：一个工位一个稳定会话，「初始化仓库」把身份一次标好

**工人会话看不见，不是界面没刷新，是 DSH 按 cwd 把会话归到工作区。**
`dsh-workspace` 的 `sessionIds` 只认 `host.sessionPath(id) === record.path`，且 `attachSession()` 在
`cwd !== record.path` 时直接抛错。工人会话原来 cwd = worktree（`<parent>/.flow-worktrees/<repo>/<taskId>`），
于是各自变成一个独立工作区（实测 `~/.dsh/sessions` 里 4 个 `.flow-worktrees-BiliNote-T-00N` 桶），
当前工作区里自然一个都看不到；而且**每个任务换一次 cwd 就 `resetSession` 一次**，会话身份也留不住。

- 派工与重置统一把会话 cwd 收敛到 `project.workspacePath`
  （`lib/dispatch.js` `sessionCwd`、`index.js` `resetSession` 的 `nextCwd`）——隔离仍由 worktree 与案卷里的
  「你的工作目录」负责，不靠会话 cwd
- 案卷新增一行纪律：*这个会话的当前目录是主工作区，不是你要改的地方；读写与 git 命令都走绝对路径*，
  否则工人用相对路径会改到主仓库、让合并直接失败
- 工位身份名 = 车道 + 角色 + 序号：`human调度1` / `human工人1` / `auto调度1` / `auto工人1`
  （`lib/domain.js` `agentLabel`；`provisionAgentsIn` 的 `laneLabel` 由 `'' / 'Issue·'` 改为 `'human' / 'auto'`）
- 会话建好即改名（`sessionController.rename`），失败不阻断，只在结果里记 `renameMessage`

**「初始化仓库」按钮**（头部 + 设置→代理页，可反复点）→ `project.init` → `ensureProjectSessions`：

1. 没有会话的工位建一个；
2. 有会话但标题不是身份名的，改名（`domain.setSessionTitle` 落库并发 `session.renamed`）；
3. cwd 漂在 worktree 里的老会话**收回工作区**——但只在 `!busy`（该工位没有 `activeRunId`）时动，绝不打断在跑的工人。

v1.40 起这一步**不再补齐工位池**：工位只在项目第一次落库时初始化一次（`lib/domain.js` `ensureProject` 新建分支）。被删的工位、调大配置后要新增的槽位，走显式的 `agents.ensure`（HTTP action / 设置页「创建需求讨论工位」）。

主调度（chief）不参与：那是用户自己的聊天框，不改名也不搬家。
代理行显示身份名 + 会话标题 + 「打开会话」（`ctx.uiWorkspace.openSession`，拿不到就退回 `/?flowSession=<id>`）。

顺带修一个**一直静默生效的默认值**：`config.baseBranch` 原来默认 `'main'`，是**真值**，于是
`dispatch` 里 `(project.config.baseBranch) || defaultBranch(repo)` 永远走 `main`，master 仓库也在 main 上建 worktree。
现在默认 `''`（留空=自动探测），设置页文案同步改成「留空 = 自动探测」。

## v1.11：issue 记录开关 + 「先调研、再批准」

**`config.recordIssues` 默认 false** —— 纯本地看板模式：不补 issue 车道工位、不同步远程、
不显示也不接受任何自动化开关（后端 `project.config` 直接拒）。开着才接远程 issue。

issue 卡走两段，不是一次做完：

```
issue 到达 → 建卡 → claim → investigate（running/investigating，只读不写、不建 worktree）
          → 工人把方案写进评论 → 自停
          → 系统整理成 plan → submit_plan（planning/waiting-approval）
          → 人批准 / 主调度代批（approve_by_chief，仅 issue 车道）→ 才开工
```

没有方案就自停会 **block 并说明**，绝不带空 plan 进批准。

新增工具 `flow_issue_pending`：列出待批准/被阻塞的 issue 卡，**默认前 50 条**（可调到 200），
返回 `total/shown/truncated`，阻塞的排前面。给人做方向总结用。

另外修了 `Store.persist` 的 tmp 文件名：原来只用 pid，同进程两个 Store 指向同一文件会互相踩（ENOENT 竞态）。

## v1.10：自激循环（调度员被自己的操作反复叫醒）

线上现象：调度员写一条巡检评论 → 立刻收到"有人评论了这张卡" → 去处理 → 又写评论 → 又被叫醒。

三层根因叠加，缺一层都修不干净：

1. **actor 没传到订阅方** — outbox 只存 `{eventId,type,payload,at}`，没存 `actor`，广播时永远是 `undefined`
2. **工具署名用的是角色字面量** — `{ role, id: role }` 写成 `'dispatcher'`，分不清是哪个调度员（新增 `actorOf()` 署名具体 agentId）
3. **判定要认三种历史形态** — agentId / sessionId 反查 / 角色字面量（后者**只在同类代理唯一时**才算自己，否则会吞掉同事的动作）

**但故障不能被"自己"吞掉**：`WATCHED` 里给 `task.blocked` / `pr.merge_conflict` / `run.stuck` / `run 失败`
加了 `selfNotify: true` —— 自己派工失败也必须知道。判据是**"结果"还是"噪音"**。

## v1.8：补齐模型调不到的事务工具（23 → 28）

模型调 `flow_comment` 报 `is not a function`，顺着查出**几件事务必需的能力没暴露成工具**：

| 新增工具 | 之前缺什么 |
| --- | --- |
| `flow_task_detail` | 只看看板摘要 → 看不到评论/停止报告/run 记录，判断验收全靠猜 |
| `flow_task_update` | 没有改标题/描述/验收标准的入口 |
| `flow_task_handoff` | 单张卡无法交接（只有 flow_publish） |
| `flow_review_prompt` | 审核判据读不到，verdict 只能凭感觉 |
| `flow_workspace_list` | 建项目要手猜工作区路径 |

**更严重的一个**：`domain.heartbeat` 零调用方，而 `stuckRuns()` 靠 `lastHeartbeat` 判卡死（默认 30 分钟），
该字段只在 `startRun` 写一次 → **任何跑超过 30 分钟的任务都会被误判卡死并 block**。
已加 dispatcher 定期续期（60s，unref）、结束停表、卸载清理。

案卷与 `flow` skill 现在列**确切工具名**，并注明没有 `flow_comment` 这类简写。

## v1.6：两个真 bug

- **`flow_publish` 返回被 Host 整次拒掉**（`value.column is not a declared property`）——任务已创建，但调用报错。
  schema 没声明返回里的 `column/phase/dispatched`。已补全，并加了 `test/tool-schema.mjs`
  做**结构性校验**：每个工具返回值里的字面量键必须在它自己的 `output.schema.properties` 里。
- **工人在 `run_code` 里报 `Expected unicode escape`**——案卷给了 `C:\Users\...` 反斜杠路径，
  被抄成字符串字面量后变成非法转义。`buildBrief` 现在把路径统一成正斜杠，并在工作方式里写明该约定。

## v1.5：/flow 由 skill 驱动，发布即开工

- **`/flow` 进入后自动加载 `flow` skill**（`skills/flow/SKILL.md`，随插件分发到 `~/.agents/skills`），
  按它的判据拆需求：摸清现状 → 切工作包 → 定执行序 → 确认后发布。模式提示词只留语义与硬边界，
  流程细节单一来源在 skill 里。
- **`flow_publish` 发布即开工**：发布等价于批准，任务直接进「执行中」并派工；派不出去也会明确说明
  「暂未派出（原因）」，不会静默卡住。
- **写工具收回不再因工具名对不上而失败**：`FLOW_DENY_TOOLS` 只是意图清单，实际 `deny` 与
  `tools.schemas()` 求交集；Host 报错时还会用它回传的合法名单重试一次。
  （线上曾报 `names unknown global tools "bash", "str_replace_editor", ...`，整套 /flow 进不去。）

## v1.4：工作区 = 项目，任意对话都能调度

- **一个工作区天生就是一个项目**：会话先按 cwd 找到 DSH 工作区，再映射到项目（没有就用工作区建一个）。不再有"新建项目"，也不会出现"点开 A 工作区的对话却显示 B 项目"。
- **不需要绑定主调度**：同一工作区里的任何对话都能进调度模式，直接给子调度派活。
- **回信按发起者路由**：任务上记 `originSessionId`；子调度/工人的回信（`flow_reply` / `task.reply`）投回**发起这张卡的那个对话**，不会串到别的会话。
- **删工作区 = 删项目**：DSH 没有工作区删除事件，所以 `scheduler.tick` 第一步做对账——工作区清单里没有的项目会被连带清理（registry 读不到时整步跳过，绝不误删）。
- **界面**：顶栏换成「工作区 = 项目」；模型选择改成下拉（读 DSH 原生 ModelCatalog）；「危险操作」先不展示。

## v1.3：独立工作台已移除，全部功能在会话标签页里

原 `/api/flow/app` 那个 637 行 HTML 单页**已删除**（`lib/app.html`、`lib/ui.js`、路由、右下角浮标一起移除）。
看板、任务详情、项目/车道/角色配置、数据清理现在都在「调度台」标签页里：

- **看板**：七列状态机，点卡片开右侧抽屉；空列会收窄，把宽度让给有卡的列
- **任务抽屉**（v1.20 起 `min(1040px,94vw)`）：主列放标题/描述（编辑·预览）/验收标准/计划/讨论，侧栏放状态/操作/停止报告/回信/运行记录；评论流和计划按 Markdown 渲染
- **设置弹窗**：项目配置（自动派工/验收/合并、水位阈值）、车道与工位、代理与模型（含改派上级）、危险操作（删项目/删卡）
- **数据清理**：`project.remove` / `task.remove` 都在设置里，不用再手改 `flow.json`（手改会被内存态覆盖）

动作表没变，仍是 `POST /api/flow/action`——搬的是界面，不是事务逻辑。

## 入口：会话里的「调度台」标签（v1.2）

不再另开主面板或侧栏入口。调度台是**会话视图里的一个标签页**，注册在 `conversation.view`，order 40——排在「编队」（order 30）右边：

```
阅读 | 对话 | 轨迹 | 上下文 | 编队 | 调度台
```

好处是它天然处在 `session` 作用域，**"当前对话"就是当前会话**，"绑定当前对话为主调度"不会再绑错对象。

标签页内容按事务逻辑组织：项目身份与主调度状态 → 任务/在跑/阻塞/审批统计 → 人直派与 issue 两条车道（工位、水位）→ 七列状态机看板 → 运行中的 run → 租约 → 最近审批 → 事务事件链。

## 主调度 = 你的默认聊天区（v1.0 修订）

v1.0 早期版本里"主调度"是一个单独的聊天窗口（chief 专属会话）。现在改成：**不另开窗口**——你平时用的 DSH 聊天区就是主调度的工作台，只是调度模式下把当前聊天代理认定成"主调度"这个角色。

- 进入：在任意会话里 `/flow`，插件会用当前会话的 cwd 找到（或创建）对应项目，并把它绑定为主调度。
- 面板里不再自绘聊天框；"回到聊天"按钮只负责切回 DSH 会话区。
- 一个会话只能是一个项目的主调度；换项目时先解绑或用另一个会话。
- 侧栏「调度台」面板里的"绑定为主调度"按钮是给拿得到会话 id 的场景兜底的，正常路径是 `/flow` 自动认领。

## v1.0 新增（多 Agent 调度台）

- **双车道**：`lane='human'`（人直派）与 `lane='issue'`（外部 issue 自动接单）各一套 dispatcher + worker，跨车道绝不串人；issue 车道默认 0 工位，首次真的来 issue 时懒补齐。
- **三层监督**：chief → dispatcher（子调度）→ worker，`agents.supervisorId` 表达父子，`flow_agent_reparent` 可改派（带防环校验）；`startRun` 强制「worker 只能接自己上级名下的任务」。
- **同域分派**：`tasks.scope = {paths, symbols}`，`lib/scope.js` 按重叠度打分（3×覆盖 + 负载 + 工位 + 预算风险），同一批代码的活优先压给同一个工人；连续被选中超阈值强制轮转。
- **上下文预算**：`ctx.tokenMeter` 读水位 → <0.6 正常 / 0.6–0.7 降权 / 0.7–0.9 压缩 / ≥0.9 重建；压缩只在 idle 且能 `resolveAgent` 时执行，busy 则冷却重试。
- **`/flow` 只读调度模式**：进入即 `ctx.tools.restrict({deny:[写类工具]})`（硬约束，不是提示词），规划完成后 `flow_publish` 发布成一张大 issue 并交给车道子调度；收不进工具就拒绝进入模式。
- **原生总览面板**：DSH 侧栏「调度台」+ 主面板总览（项目 / 两车道在跑与阻塞 / 上下文水位条 / 最近事件），数据来自 `GET /api/flow/overview`；无 slots 服务时自动降级为浮标 + HTML 工作台。

## 当前状态

- 已实现：状态机与守卫、租约与 fencing、events/outbox、SSE、工作台、21 个工具、16 条 HTTP 路由、44 个 action。
- 已实现（v0.2）：代理池自动补齐、派工事务（真实会话 + goal + 案卷）、自停与巡检包。
- 已实现（v0.3）：总调度者、交付包、worktree、开 PR / 合并 / 冲突回派、事件管道与 webhook、注入、自动调度 tick。
- 已实现（v0.4）：工作区选择、无标题建卡 + issue 式任务页、三方评论（角色按会话判定）、自动调度区不进看板。
- 已实现（v0.5）：会话控制 API（代理会话绑定、斜杠命令）；`test/smoke.mjs` 103 条断言。
- 已实现（v0.6）：DSH 原生会话侧栏；每个代理可切到自己的 DSH session，使用原生消息与工具界面；`test/client.mjs`、`test/host.mjs`、`test/smoke.mjs` 全绿。
- 已修复（v0.7）：重启后只读接口看不到磁盘数据（Store 懒加载）；`session.create` 同时传 `workspaceId` + `cwd` 导致侧栏/派工建会话失败；host 契约测试覆盖这两条回归。
- 已修复（v0.8）：窄屏 iframe 里 embed 客户端用 `toggleSidebar()` 会把 DSH 左栏从默认收起切成展开；改为只在 `window.innerWidth >= 1024` 时折叠，`test/client.mjs` 覆盖宽/窄两种宽度。
- 业务流程核对（v0.10）：`docs/业务流全量核对.md` 逐条对照设计文档并列出「仍缺清单」（工具权限白名单、classifying 中间态与巡检判读落库、改派调度员、worktree GC、goal 四动词的 edit/pause/resume、merge_queue 与合并后冒烟、重置事务行锁、巡检信号检测、approval Remote 面）。
- 已实现（v0.9）：对话区固定绑主调度（其它角色只开面板、不可切换对象）；「角色设置」弹层补齐角色名 / 模式预设（`agentPresets.list`）/ 模型三件套（`session.modelCatalog` + `agent.selectModel`）/ 角色与项目 prompt 覆盖 / 并发上限 / 启停 / 重置该角色会话；项目加载后自动为每个角色补建并绑定 DSH 会话（`project.sessions` → `ensureProjectSessions`，按 chief→dispatcher→worker 顺序）；`test/smoke.mjs` 106 条断言。
- 已实现（v0.10 · 业务流程补缺）：对照 `docs/ework-flow-design.html` 逐条核对后补了四处硬缺口，核对表见 `docs/业务流全量核对.md`（14 章，T1–T20 / I1–I12 / 4.3 / 4.4 / 5.7–5.14 / 7.3–7.4 / 8.2–8.3 逐条 + 仍缺清单）：
  - **T19 重开**：`done`/`cancelled` → `todo`，只有人类能重开、必须写原因（`reopen` 规则在 `lib/core.js`，`applyTransition` 清 approvedRevision/activeRunId/stopReport/headSha 与终态时间戳，写 `lastReopenReason`/`reopenCount`，history 带 reason）；工作台 done/cancelled 列有「重开」按钮。
  - **I6/5.8 审批记录**：`approve` 落 `kind:'plan'`、`accept` 落 `kind:'head'` 的不可变审批记录（`recordApproval`，同任务同类旧记录自动 `revokedAt`），`setPlan` 与人类评论会让等待中的批准失效（`revokeApprovals` + `approval.revoked` 事件），`snapshot` 里能看到 `approvals`。
  - **I5 任务版本**：每次迁移/阻塞/写计划都 `version+1`，命令可带 `payload.expectedVersion`，版本不一致抛「任务版本已变化…请刷新后重试」。
  - **I4/I10/T14 合并锁**：同一仓库同时只允许一个合并事务（`lockMerge('merge:'+projectId)` + 租约 token），合并主体拆成持锁的 `mergeLocked`，冲突路径也在 finally 释放锁；合并前比对验收 `headSha` 与 PR `headSha`，不一致拒绝（需重新验收）。
  - **T18 取消副作用**：`cancel` 现在会结束 run、释放 `task:<id>` 租约、把工位打回 idle、尽力回收 worktree 并写评论（`afterCancel`），不再留下「已取消但有 run」的脏状态。
  - **4.3 工人越权**：`flow_task_move` 改为按调用会话绑定的代理角色署名（`moveRoleOf`，chief 视同 dispatcher），批准/验收/取消/重开这些人类闸门不再接受代理调用——工人会话无法再移动看板列或替人验收。
  - 测试：`test/smoke.mjs` 120 条断言（新增 14 条覆盖上面六处）。
- 生效条件（v0.9）：`lib/app.html` 在 `lib/ui.js:4` 被 `readFileSync` 缓存、action 表与 runtime 方法在 `lib/http.js`/`index.js` 里注册，改动都随模块加载生效；**DSH 重启后**才在运行实例上出现「角色设置」按钮、`project.sessions` / `agent.selectModel` action 与自动建会话。`client.js` 的 embed CSS 每次 iframe 加载即从磁盘读取，无需重启。
- 入口（v0.3）：主页面右下角「调度台」浮标（`webserver/index-inject`）+ `/api/flow/app` 直链；`test/host.mjs` 契约测试全绿。
- 未实现（M1）：Remote 面（`flow.tasks.*`/`flow.agents.*`/`flow.approval.*`）、审批持久化表。
