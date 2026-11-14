# Agents Workflow Hub — Local Automation Agent System

> Events come in, the hub dispatches, local nodes do the work, the pipeline stops at a PR, Feishu approval gate, full audit trail.

[简体中文](README.zh-CN.md) | [English](README.md)

A self-hosted automation agent hub that runs on your own machine: external events (Feishu messages, GitHub webhooks, monitor alerts, cron timers, manual submissions) flow into one dispatch hub, get routed by rules to AI engines on local executor nodes, and code tasks go through a five-step quality pipeline that stops at a pull request. Only items on the must-ask list are escalated to a human for approval — everything else runs unattended, and every step lands in an audit ledger.

Zero npm dependencies — Node built-in modules + `node:sqlite` only (Node ≥ 22.5).

---

## Up and running in 30 seconds

```cmd
git clone https://github.com/Mikajin1206/agents-workflow-hub.git hub
cd hub
copy config\hub.config.example.json config\hub.config.json
start-hub.cmd
```

Open http://127.0.0.1:8787 — that's the web panel.

In a second terminal, start an executor node:

```cmd
cd hub
start-worker-win-a.cmd
```

Dispatch your first task (from the panel's "Dispatch" page, or the CLI):

```cmd
node src\cli.mjs submit --engine mock --prompt "Hello, check in" --summary "First dispatch"
```

> The real config `config/hub.config.json` is git-ignored (it holds secrets like the Feishu app secret once you connect one). The repo ships `config/hub.config.example.json` as a template — all secret fields are empty and everything works locally out of the box (the `mock` / `shell` engines need no external accounts). Fill in the `feishu` block when you want the Feishu channel; see [docs/部署运维.md](docs/部署运维.md) (Chinese).

---

## Six modules

| Module | Responsibility | Code |
|---|---|---|
| **M1 Intake layer** | Feishu callbacks (websocket), GitHub webhooks, monitor alerts, cron timers, manual submits — all normalized into one event envelope | `src/m1/`, `src/lib/http.mjs` |
| **M2 Dispatch hub** | Persist → dedupe → rule match → concurrency limits → dispatch → writeback → notify → bookkeeping | `src/m2/events.mjs`, `src/m2/queue.mjs` |
| **M3 Local executors** | Nodes long-poll for tasks and run them with Claude Code / Codex / mock / shell engines | `src/m3/worker.mjs`, `src/m3/engines.mjs` |
| **M4 Quality pipeline** | Review → check → merge → release → verify, five steps unattended | `src/m4/pipeline.mjs` |
| **M5 Decision feedback** | Must-ask categorization, approval state machine, tiered notifications | `src/m5/approvals.mjs`, `src/m5/feishu.mjs` |
| **M6 Knowledge assets** | Skill library, decision memory, audit ledger, report archive | `src/m6/` |

---

## Five iron rules (enforced in code, not slogans)

1. **Humans are not the starting point** — event-triggered tasks run to completion on their own; nobody clicks a button to begin.
2. **Single channel out** — everything outbound goes through one channel: the panel + console in local mode.
3. **Must-ask list always gates** — deleting data / stopping services / spending money / outbound messages / changing product direction / creating or rotating secrets / changing permissions: none of these execute without explicit human approval. Reminders escalate once on timeout and **never auto-approve**.
4. **Stop at PR** — code tasks end at "committed + pull request opened". Merging and releasing is M4's job; agents don't ship to production themselves.
5. **Everything leaves a trace** — every event, task, approval request, decision, and report goes into the SQLite ledger.

---

## Directory layout

```
hub/
├─ config/
│  ├─ hub.config.json            # real config (git-ignored; copy from the example)
│  ├─ hub.config.example.json    # config template (committed, secrets blank)
│  ├─ rules.json                 # dispatch rules (event → node/engine/skill/parallelism/approval)
│  └─ decisions/                 # decision-memory seed (plain-language markdown)
├─ skills/                       # skill library (SOPs), one SKILL.md each
├─ src/
│  ├─ index.mjs                  # HTTP server + all routes (panel + API + webhooks)
│  ├─ hub.mjs                    # hub assembly: wires M1–M6 together
│  ├─ cli.mjs                    # CLI tool
│  ├─ lib/                       # config, ledger, event envelope, rules, cron, HTTP
│  ├─ m1/ … m6/                  # the six modules
│  └─ web/public/                # web panel (vanilla JS, no framework, no build step)
├─ scripts/
│  ├─ backup.mjs / backup.cmd    # ledger & report backup (schedule daily)
│  ├─ feishu-setup.mjs           # Feishu integration wizard
│  ├─ smoke.mjs                  # DB schema integrity check
│  └─ service/                   # wscript supervisor + scheduled tasks (Windows daemon)
├─ test/
│  ├─ e2e.mjs                    # end-to-end self-test, 102 assertions
│  ├─ lib.test.mjs               # pure-function unit tests
│  ├─ m1.test.mjs                # intake layer tests
│  └─ feishu*.test.mjs           # Feishu signature / websocket tests
├─ data/                         # ledger, logs, reports (git-ignored)
├─ artifacts/                    # daily reports and other run artifacts (git-ignored)
├─ start-hub.cmd                 # start the hub
├─ start-worker-win-a.cmd        # start a Windows executor node
└─ start-worker-mac-b.cmd        # start a Mac executor node
```

---

## Common commands

```cmd
node src\cli.mjs doctor          # environment self-check (12 items, +1 with Feishu)
node src\cli.mjs status          # current situation
node src\cli.mjs rules           # show dispatch rules
node src\cli.mjs tasks           # show tasks
node src\cli.mjs approvals       # show pending approvals
node src\cli.mjs approve apr_xx  # approve
node src\cli.mjs reject apr_xx --note "not yet"
node --test test/*.test.mjs      # unit tests (53)
node test\e2e.mjs                # end-to-end self-test (102 assertions)
node scripts\smoke.mjs           # DB schema integrity
scripts\backup.cmd               # back up ledger & reports (schedule daily)
```

Full command reference: [docs/部署运维.md](docs/部署运维.md) (Chinese).

---

## Documentation

- [开发方案](docs/开发方案.md) — architecture decisions, data model, API contracts, how each module is built and why (Chinese)
- [部署运维](docs/部署运维.md) — install, run, configure, troubleshoot, back up, recover (Chinese)

---

## Status

- ✅ M1–M6 all implemented; hub and executor nodes run as independent processes
- ✅ Web panel with 11 views (overview / approvals / tasks / events / pipeline / reports / notifications / decision memory / rules / engines & skills / dispatch)
- ✅ Ledger, dedupe, retries, dead-letter, long-poll leases, approval state machine, tiered notifications, decision memory, report archive
- ✅ Unit tests: 53 green; e2e self-test: 102 assertions
- ✅ All four engines working: `claude-code` / `codex` / `mock` / `shell`
- ✅ Feishu bidirectional over websocket: P0/P1 notifications and approval cards pushed to a Feishu group; approve directly from card buttons (with toast receipt); dispatch tasks by sending messages in the group. No public IP / domain / TLS needed
- ✅ M4 pipeline supports `mode: "real"` — five steps exercised end-to-end on a real repo, including a real merge
- ⚠️ Bidirectional Feishu requires the open-platform subscription mode "receive events via long connection" with im.message.receive_v1 subscribed; the feishu_ws field of /api/health shows connection status
- ⚠️ M4 release/verify commands must be configured per project in the pipeline block of `config/hub.config.json`
- ⚠️ mac-b currently runs as a second process on the same machine; cross-machine deployment is planned (P2)

---

## License

[MIT](LICENSE)
