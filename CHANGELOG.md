# 变更日志

版本线说明：v0.001 起为本仓库的**新版本线**（此前代码对应 v1.39.1 的连续开发，但从未建过 git 仓库）。
npm 的 `version` 字段必须是合法 semver，所以 `package.json` 写 `0.0.1`，对外展示与 git tag 用 `v0.001`。

## v0.001 — 2026-11-08

版本线重启 + 建立仓库。

- 新建 git 仓库（`main` 分支），把现有代码作为基线入库；此前所有备份目录（`.backup/`、`.bak-20261107/`、`.bak-v139/`）与 CodeGraph 索引不进库。
- 版本号从 `1.0.0` 重启为 `0.0.1`（展示名 v0.001）。**数据 schema 不变**：`SCHEMA_VERSION` 仍为 11，`~/.dsh/flow/flow.json` 不受影响。
- 本版本**不含功能改动**，代码等同于 v1.39.1。
- 附带 `.wayfinder/map.md`：worktree 工作流的地图与六张决策票（wf-01 … wf-06），以及 `docs/worktree-工作流.md` 方案正文。

下一个版本 v0.002 承接「worktree 工作流深化」的实现（acquire/dispose 深模块、集成检出、mergeState 枚举、会话工作根）。
