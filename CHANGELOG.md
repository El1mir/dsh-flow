# 变更日志

版本线说明：v0.001 起为本仓库的**新版本线**（此前代码对应 v1.39.1 的连续开发，但从未建过 git 仓库）。
npm 的 `version` 字段必须是合法 semver，所以 `package.json` 写 `0.0.1`，对外展示与 git tag 用 `v0.001`。

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
