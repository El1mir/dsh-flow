# dsh-flow

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的调度台插件：把「需求 → 拆解 → 派工 → 工人执行 → 验收 → PR 审核 → 合并」做成一条带事务的记录流，并提供看板、工单箱（Inbox）和调度员/工人之间的消息区。

## 特性

- **两种事务模式**：本地模式（分支、检出、验收、本地合并，完全不出网）；远程模式（GitHub/Gitea issue 与评论双向同步，一张卡一分支一 PR，以 forge 合并为唯一入口）。
- **双车道调度**：`human` 车道由人派单；`issue` 车道把远程 issue 自动建卡并走完整生命周期。
- **验收闭环**：停止报告按六问书写，验收项逐条记录状态与证据；证据不足时调度员先自行补证，只有环境/权限不可用或需要人决策时才请示。授权守卫（`acceptedBy`、`autoAccept`）始终保留。
- **工单箱与消息区**：需要人拍板的事走带分类、引用和多轮对话的工单；两个车道的调度员与人在消息区沟通，可引用任务卡。
- **反循环**：返工频控、失败预算、卡死巡检，避免调度空转。
- **远程合并安全**：冲突回派原工人；分支保护、权限、head 变化等失败进入 blocked 工单，不做本地兜底。

## 安装

要求：DSH `>=0.2.0-rc.2`，Node.js 20+。

```bash
cd ~/.dsh/profiles/web
npm install @el1mir/dsh-flow
```

然后在该 profile 的 `package.json` 的 `dsh.profile.bundles` 里加入 `"@el1mir/dsh-flow"`（或在 `cordis.patch.yml` 里加 `- insert: [{id: dsh-flow, name: "@el1mir/dsh-flow"}]`），重启 DSH。工作台入口：`/api/flow/app`，页面右下角会出现「调度台」浮标。

从源码安装：

```bash
git clone https://github.com/El1mir/dsh-flow.git
cd ~/.dsh/profiles/web && npm install "file:/path/to/dsh-flow"
```

发布到 npm（维护者）：`npm test && npm publish`（`prepublishOnly` 会先跑测试，包只含 `index.js`、`client.js`、`lib/`、`skills/`、`cordis.patch.yml`、`README.md`、`LICENSE`）。
## 开启远程模式

在项目配置里设置 `remoteMode: true`、`remote.kind` / `remote.owner` / `remote.repo`、`pushRemote: true`，再按需开启 `recordIssues` / `recordPulls`。条件不满足时会退回本地模式并说明原因，不会静默出网。

GitHub 认证：显式 `remote.token` 优先，否则使用 `gh auth token`（`remote.useGhCli` 默认开启）。**没有 token 时请求是匿名的，会被 GitHub 限流为 403。**

## 开发与测试

```bash
npm test                      # 完整测试套件
node test/smoke.mjs           # 状态机、租约、派工、合并等主流程
node test/render.mjs          # 界面渲染断言
```

测试不依赖网络或真实 DSH 宿主。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.js` | 插件入口与路由注册 |
| `client.js` | 调度台前端 |
| `lib/` | 事务模型、调度器、派工、远程同步与合并 |
| `skills/flow/` | `/flow` 调度技能 |
| `test/` | 测试 |
| `CHANGELOG.md` | 版本变更 |
| `GLOSSARY.md` | 术语表 |

## 许可证

[MIT](LICENSE)
