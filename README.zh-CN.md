# Agents Workflow Hub — 本地自动化 Agent 体系

> 事件进、中台派、本地干、流水线上线、飞书批红、台账留痕。

[简体中文](README.zh-CN.md) | [English](README.md)

一套跑在自己机器上的自动化 Agent 中台：外部事件（飞书消息、GitHub Webhook、监控告警、定时器、手动提交）统一进入调度中台，按规则派给本地执行节点上的 AI 引擎干活，代码任务走五步质量流水线止步于 PR，只有必问清单里的事才会推到你面前批红，全程写进台账。

零 npm 依赖，只用 Node 内置模块 + `node:sqlite`（Node ≥ 22.5）。

---

## 30 秒上手

```cmd
git clone https://github.com/Mikajin1206/agents-workflow-hub.git hub
cd hub
copy config\hub.config.example.json config\hub.config.json
start-hub.cmd
```

打开 http://127.0.0.1:8787 就是面板。

再开一个窗口跑执行节点：

```cmd
cd hub
start-worker-win-a.cmd
```

派第一个活（面板「派活」页，或命令行）：

```cmd
node src\cli.mjs submit --engine mock --prompt "你好，报个到" --summary "第一次派活"
```

> 真实配置 `config/hub.config.json` 不进版本库（里面会有飞书 appSecret 这类密钥）。仓库只带 `config/hub.config.example.json` 模板，密钥字段留空即可本地跑通（mock / shell 引擎不需要任何外部账号）；接飞书时再填 `feishu` 块，见 [docs/部署运维.md](docs/部署运维.md)。

---

## 六个模块

| 模块 | 职责 | 代码位置 |
|---|---|---|
| **M1 多入口接入层** | 飞书回调（长连接）、GitHub Webhook、监控告警、cron 定时器、手动提交，统一成一个事件信封 | `src/m1/`、`src/lib/http.mjs` |
| **M2 调度中台** | 接收入库 → 去重 → 规则匹配 → 并发约束 → 派活 → 回写 → 通知 → 记账 | `src/m2/events.mjs`、`src/m2/queue.mjs` |
| **M3 本地执行层** | 节点长轮询接单，调 Claude Code / Codex / mock / shell 干具体活 | `src/m3/worker.mjs`、`src/m3/engines.mjs` |
| **M4 质量发布流水线** | 审查 → 检查 → 合并 → 发布 → 核实，五步无人值守 | `src/m4/pipeline.mjs` |
| **M5 决策反馈层** | 必问清单分类、票拟批红状态机、分级通知 | `src/m5/approvals.mjs`、`src/m5/feishu.mjs` |
| **M6 知识资产层** | Skill 库、决定记忆、事件台账、报告归档 | `src/m6/` |

---

## 五条铁律（写进代码，不是口号）

1. **人不是起点** — 事件自己触发的活自己跑完，不等人发指令。
2. **唯一出口** — 对外只走一个通道，本地模式下是面板 + 控制台。
3. **白名单必批** — 删数据 / 停服 / 花钱 / 对外发消息 / 改产品方向 / 新建或轮换密钥 / 修改权限，七类事项没批红绝不执行；超时只提醒一次，**绝不默认同意**。
4. **止步 PR** — 代码任务写完提交开 PR 就停，合并发布是 M4 的活，Agent 不自己上线。
5. **一切留痕** — 每个事件、任务、票拟、决定、报告都进 SQLite 台账，可追溯。

---

## 目录结构

```
hub/
├─ config/
│  ├─ hub.config.json            # 真实配置（git 忽略，从 example 复制而来）
│  ├─ hub.config.example.json    # 配置模板（进版本库，密钥留空）
│  ├─ rules.json                 # 派活规则（事件 → 节点/引擎/Skill/并发/审批）
│  └─ decisions/                 # 决定记忆底稿（人话写的 markdown）
├─ skills/                       # Skill 库（SOP），每个一个 SKILL.md
├─ src/
│  ├─ index.mjs                  # HTTP 服务 + 全部路由（面板 + API + Webhook）
│  ├─ hub.mjs                    # 中台装配：把 M1–M6 接起来
│  ├─ cli.mjs                    # 命令行工具
│  ├─ lib/                       # 配置、台账、事件信封、规则、cron、HTTP
│  ├─ m1/ … m6/                  # 六个模块
│  └─ web/public/                # 面板（原生 JS，无框架无构建）
├─ scripts/
│  ├─ backup.mjs / backup.cmd    # 备份台账与报告（可挂每日任务）
│  ├─ feishu-setup.mjs           # 飞书接入向导
│  ├─ smoke.mjs                  # 库表完整性自检
│  └─ service/                   # wscript 守护 + 计划任务（Windows 常驻）
├─ test/
│  ├─ e2e.mjs                    # 端到端自测，102 项断言
│  ├─ lib.test.mjs               # 纯函数单元测试
│  ├─ m1.test.mjs                # 接入层测试
│  └─ feishu*.test.mjs           # 飞书签名/长连接测试
├─ data/                         # 台账、日志、报告（git 忽略）
├─ artifacts/                    # 日报等运行产物（git 忽略）
├─ start-hub.cmd                 # 启动中台
├─ start-worker-win-a.cmd        # 启动 Windows 执行节点
└─ start-worker-mac-b.cmd        # 启动 Mac 执行节点
```

---

## 常用命令

```cmd
node src\cli.mjs doctor          # 环境自检（12 项，配了飞书多 1 项）
node src\cli.mjs status          # 当前态势
node src\cli.mjs rules           # 看规则表
node src\cli.mjs tasks           # 看任务
node src\cli.mjs approvals       # 看待批红
node src\cli.mjs approve apr_xx  # 批红
node src\cli.mjs reject apr_xx --note "先别动"
node --test test/*.test.mjs      # 单元测试（53 项）
node test\e2e.mjs                # 端到端自测（102 项）
node scripts\smoke.mjs           # 库表完整性
scripts\backup.cmd               # 备份台账与报告（可挂每日任务）
```

完整命令见 [docs/部署运维.md](docs/部署运维.md)。

---

## 文档

- [开发方案](docs/开发方案.md) — 架构决策、数据模型、接口契约、每个模块怎么实现的、为什么这么选
- [部署运维](docs/部署运维.md) — 装、起、配、排障、备份、灾恢

---

## 当前状态

- ✅ M1–M6 全部实现，中台与执行节点可独立进程运行
- ✅ 面板 11 个视图可用（总览/批红/任务/事件/流水线/报告/通知/决定记忆/规则/引擎技能/派活）
- ✅ 台账、去重、重试、死信、长轮询租约、批红状态机、通知分层、决定记忆、报告归档
- ✅ 单元测试 53 项全绿；e2e 自测 102 项断言
- ✅ 四个引擎全部可用：`claude-code` / `codex` / `mock` / `shell`
- ✅ 飞书已接入（长连接双向）：P0/P1 通知与批红卡推送到飞书群；卡片按钮直接批红（带 toast 回执）；群里发消息可派任务。长连接不需要公网 IP/域名证书
- ✅ M4 流水线支持 `mode: "real"`，已在真实仓库五步跑穿含真合并
- ⚠️ 飞书双向依赖开放平台订阅方式为「长连接接收事件」且 im.message.receive_v1 已订阅；/api/health 的 feishu_ws 字段显示连接状态
- ⚠️ M4 的发布/核实命令需要按你的项目在 `config/hub.config.json` 的 pipeline 块里配置
- ⚠️ mac-b 是同机第二个进程占位，跨机器部署待做（方案 P2 期）

---

## License

[MIT](LICENSE)
