# 变更日志

版本线说明：v0.001 起为本仓库的**新版本线**（此前代码对应 v1.39.1 的连续开发，但从未建过 git 仓库）。
npm 的 `version` 字段必须是合法 semver，所以 `package.json` 写 `0.0.1`，对外展示与 git tag 用 `v0.001`。

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
