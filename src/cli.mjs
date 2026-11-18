#!/usr/bin/env node
/**
 * hub CLI —— 在没有飞书、没有面板时也能把系统用起来。
 *
 *   node src/cli.mjs status
 *   node src/cli.mjs submit --type cmd.manual --target acme/shop --summary "查一下 CI"
 *   node src/cli.mjs submit --engine codex --summary "跑一遍仓库巡检" --sync
 *   node src/cli.mjs pipeline --repo owner/name --pr 123
 *   node src/cli.mjs events --limit 20
 *   node src/cli.mjs tasks --status queued
 *   node src/cli.mjs approvals
 *   node src/cli.mjs approve <approval_id> [--note "可以"]
 *   node src/cli.mjs reject  <approval_id> --note "不做"
 *   node src/cli.mjs revise  <approval_id> --note "改成只读方案"
 *   node src/cli.mjs reports [--limit 5]
 *   node src/cli.mjs decisions [--query "删除"]
 *   node src/cli.mjs rules
 *   node src/cli.mjs engines
 *   node src/cli.mjs doctor
 *
 * 说明：CLI 直接操作本地台账（不需要中台在跑）。
 * 例外：submit 会先探测中台——在线则走 HTTP 交给中台派活。
 * 原因：CLI 是独立进程，进程内 queue.wakeAll() 只唤醒本进程的 waiter，
 * 唤不醒中台进程里挂着长轮询的节点；必须由中台自己建任务才能即时唤醒。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, ensureDirs } from './lib/config.mjs';
import { Hub } from './hub.mjs';
import { STEPS } from './m4/pipeline.mjs';

/** 探测中台是否在线（1 秒超时，避免 CLI 卡住） */
async function probeHub(config) {
  const url = `http://${config.hub.host}:${config.hub.port}/api/health`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.ok ? { url: `http://${config.hub.host}:${config.hub.port}`, health: data } : null;
  } catch {
    return null;
  }
}

const HELP = `本地自动化 Agent 体系 —— 命令行

  node src/cli.mjs <命令> [选项]

命令：
  status                       一眼看清全系统状态（事件/任务/待批红/死信）
  submit                       投递一条事件（默认走 rules.json 路由）
  events [--limit N] [--status S] [--source S]
  tasks  [--limit N] [--status S] [--node N]
  task <task_id>               看单个任务与它的执行记录
  approvals [--all]            待批红清单（--all 含历史）
  approve|reject|revise <id>   批红 / 驳回 / 改派（--note 说明）
  reports [--kind K] [--limit N]
  decisions [--query 关键词]
  rules                        当前生效的路由规则
  engines                      可用引擎与节点
  timers                       定时器与下次触发时间
  nodes                        节点清单与启动命令
  doctor                       环境自检（Node/SQLite/引擎/目录）
  help

submit 选项：
  --type <事件类型>            例如 cmd.manual / monitor.alert / github.issue
  --target <目标>              例如 acme/shop
  --summary <一句话>           事件摘要（人看的）
  --engine <引擎>              明确指定引擎时就跳过规则匹配
  --node <节点>                指定派给哪台机器（默认取规则里的）
  --skill <技能>               指定 SOP
  --prompt <指令>              额外指令
  --priority P0|P1|P2|P3
  --approval                   强制走批红（不管规则怎么写）
  --sync                       投递后等它被节点接走并跑完（需要 worker 在线）

示例：
  node src/cli.mjs submit --type cmd.manual --target acme/shop --summary "看看 issue 42" 
  node src/cli.mjs submit --engine mock --summary "链路自检" --sync
  node src/cli.mjs approve apr_xxx --note "可以，按方案改"
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i += 1; }
  }
  return out;
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function table(rows, cols) {
  if (!rows.length) { console.log(C.dim('  （空）')); return; }
  const widths = cols.map((c) => Math.max(c.title.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  console.log('  ' + cols.map((c, i) => pad(c.title, widths[i])).join('  '));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log('  ' + cols.map((c, i) => pad(String(c.get(r) ?? ''), widths[i])).join('  '));
}

/** 中英混排按显示宽度补齐（中文占两列） */
function pad(s, width) {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}

function colorStatus(s) {
  const map = {
    completed: C.green, passed: C.green, approved: C.green, executed: C.green,
    failed: C.red, dead_letter: C.red, rejected: C.red,
    pending: C.yellow, await_approval: C.yellow, awaiting_approval: C.yellow, revising: C.yellow,
    running: C.cyan, queued: C.cyan, leased: C.cyan, routed: C.cyan,
  };
  return (map[s] || ((x) => x))(s);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return 0; }

  const config = loadConfig();
  if (cmd === 'pipeline') return await cmdPipeline(args, config);
  ensureDirs(config);
  const hub = new Hub({ config, logLevel: 'warn' });

  try {
    switch (cmd) {
      case 'status': return cmdStatus(hub, config);
      case 'submit': return await cmdSubmit(hub, args, config);
      case 'events': return cmdEvents(hub, args);
      case 'tasks': return cmdTasks(hub, args);
      case 'task': return cmdTask(hub, args);
      case 'approvals': return cmdApprovals(hub, args);
      case 'approve': return await cmdDecide(hub, args, 'agree');
      case 'reject': return await cmdDecide(hub, args, 'reject');
      case 'revise': return await cmdDecide(hub, args, 'revise');
      case 'reports': return cmdReports(hub, args);
      case 'decisions': return cmdDecisions(hub, args);
      case 'rules': return cmdRules(hub);
      case 'engines': return cmdEngines(hub);
      case 'timers': return cmdTimers(hub);
      case 'nodes': return cmdNodes(config);
      case 'doctor': return cmdDoctor(hub, config);
      default:
        console.error(`未知命令：${cmd}\n`);
        console.log(HELP);
        return 2;
    }
  } finally {
    hub.queue.stop();
    hub.approvals.stop();
    hub.cron.stop();
    hub.log.close();
    hub.ledger.close();
  }
}

function cmdStatus(hub, config) {
  const snap = hub.snapshot();
  const c = snap.counters;
  const dead = hub.ledger.get(`SELECT COUNT(*) c FROM tasks WHERE status='dead_letter'`).c;
  const engines = (snap.hub.engines || []).map((e) => (e.available ? C.green(e.id) : C.dim(e.id))).join(' ');
  console.log(`\n${C.bold('本地自动化 Agent 体系')}  ${C.dim(config.hub.name)}`);
  console.log(C.dim(`台账 ${config.paths.db}`));
  console.log('');
  console.log(`  规则 ${C.bold(String(snap.hub.rules))}  技能 ${C.bold(String((snap.hub.skills || []).length))}  定时器 ${C.bold(String((snap.hub.timers || []).length))}`);
  console.log(`  引擎 ${engines}`);
  console.log('');
  const rows = [
    { k: '事件', v: `${c.events_total}（重复 ${c.duplicates}，待归类 ${c.unrouted}）` },
    { k: '任务', v: `${c.completed + c.failed + c.queued + c.running} 总（排队 ${c.queued}，执行 ${c.running}，完成 ${c.completed}，失败 ${c.failed}，死信 ${dead}）` },
    { k: '待批红', v: c.approvals_pending ? C.yellow(String(c.approvals_pending)) : '0' },
    { k: '决定记忆', v: String(c.decisions) },
    { k: '报告', v: String(c.reports) },
    { k: '飞书', v: snap.hub.feishu?.enabled ? C.green('已配置') : C.dim('未配置（本地兜底通道）') },
  ];
  for (const r of rows) console.log(`  ${C.dim(pad(r.k, 10))} ${r.v}`);
  console.log('');
  const timers = snap.hub.timers || [];
  if (timers.length) {
    console.log(C.dim('  定时器'));
    for (const t of timers) console.log(C.dim(`    ${pad(t.name || t.id, 18)} ${pad(t.cron, 16)} 下次 ${t.next_local || t.next || '-'}`));
    console.log('');
  }
  if (c.approvals_pending) console.log(C.yellow(`  ⚠ 有 ${c.approvals_pending} 件事在等你批红：node src/cli.mjs approvals`));
  if (dead) console.log(C.red(`  ⚠ 有 ${dead} 个任务进了死信：node src/cli.mjs tasks --status dead_letter`));
  if (c.unrouted) console.log(C.dim(`  · 有 ${c.unrouted} 条事件没有规则覆盖，在待归类队列里`));
  console.log('');
  return 0;
}

async function cmdSubmit(hub, args, config) {
  const summary = args.summary ? String(args.summary) : undefined;
  if (!summary && !args.type) { console.error('需要 --summary 或 --type'); return 2; }

  const live = await probeHub(config);

  // ── 中台在线：走 HTTP，让中台进程自己建任务（这样才能唤醒挂起的长轮询）
  if (live) {
    const res = await postToHub(live.url, config, '/api/dispatch', {
      type: args.type || 'cmd.manual',
      target: args.target || null,
      summary: summary || null,
      payload: args.instruction ? { instruction: String(args.instruction) } : {},
      node: args.node || 'any',
      engine: args.engine || undefined,
      model: args.model || undefined,
      skill: args.skill || undefined,
      prompt: args.prompt || undefined,
      priority: args.priority || 'P2',
      approval_required: Boolean(args.approval),
      // --source 要真的传下去：r01-daily-report 这类规则是按 source=cron 匹配的，
      // 硬编码 'cli' 会让"手动触发一次定时任务"永远匹配不上规则。
      source: args.source || 'cli',
    });
    if (!res || !res.ok) {
      console.error(C.red(`✗ 提交失败：${res?.error || '中台无响应'}`));
      return 1;
    }
    console.log(`\n${C.green('✓')} 事件已进中台 ${C.dim('(http)')}`);
    console.log(`  事件 ${res.event_id}`);
    if (res.task_id) console.log(`  任务 ${res.task_id}${res.adhoc ? C.dim('（手工派活）') : ''}`);
    if (args.sync && res.task_id) {
      console.log(C.dim('\n  等节点接单…'));
      const task = await waitForTaskHttp(live.url, config, res.task_id, Number(args.timeout || 180) * 1000);
      if (!task) { console.log(C.yellow('  ⚠ 超时未见结果（节点没在线？）')); return 1; }
      printTaskResult(task);
    } else if (res.task_id) {
      console.log(C.dim('\n  节点接单后自动执行。看进度：node src/cli.mjs task ' + res.task_id));
    }
    console.log('');
    return 0;
  }

  // ── 中台没在跑：直接写本地台账（节点上线后自己来取）
  const res = await hub.dispatchManual({
    type: args.type || 'cmd.manual',
    target: args.target || null,
    summary,
    payload: args.instruction ? { instruction: String(args.instruction) } : {},
    node: args.node || undefined,
    engine: args.engine || undefined,
    skill: args.skill || undefined,
    prompt: args.prompt || undefined,
    priority: args.priority || undefined,
    source: args.source || 'cli',
    approvalRequired: Boolean(args.approval),
  });
  console.log(`\n${C.green('✓')} 事件已进台账 ${C.dim('(中台未运行，任务排队等节点上线)')}`);
  console.log(`  事件 ${res.event_id}`);
  if (res.task_id) console.log(`  任务 ${res.task_id}${res.adhoc ? C.dim('（手工派活）') : ''}`);
  else console.log(C.yellow('  ⚠ 规则未匹配，任务未建；可用 --engine 指定引擎直接派活'));

  if (args.sync && res.task_id) {
    console.log(C.yellow('\n  ⚠ 中台未运行，--sync 无从等待；启动中台后再看：node src/cli.mjs task ' + res.task_id));
  } else if (res.task_id) {
    console.log(C.dim('\n  节点接单后自动执行。看进度：node src/cli.mjs task ' + res.task_id));
  }
  console.log('');
  return 0;
}

async function cmdPipeline(args, config) {
  const repo = String(args.repo || '');
  const pr = Number(args.pr);
  const existingId = args._[1];
  if (!existingId && (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(pr) || pr < 1)) {
    console.error('用法：node src/cli.mjs pipeline --repo owner/name --pr 123，或 pipeline <流水线编号>');
    return 2;
  }
  if (args.local && !existingId) {
    if (config.pipeline?.mode !== 'real' || !config.pipeline.releaseCommand || !config.pipeline.verifyCommand) {
      throw new Error('本机发布需要真实模式，并配置发布和核实命令');
    }
    const git = (...argv) => execFileSync('git', argv, { cwd: config.paths.root, encoding: 'utf8' }).trim();
    if (git('status', '--porcelain')) throw new Error('本机发布要求工作区干净');
    const info = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo,
      '--json', 'state,headRefOid'], { encoding: 'utf8' }));
    if (info.state !== 'OPEN' || git('rev-parse', 'HEAD') !== info.headRefOid) {
      throw new Error('本机发布要求当前检出版本与开放 PR 的提交一致');
    }
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      'scripts/service/release-hub.ps1', '-Check'], { cwd: config.paths.root, stdio: 'inherit' });
    const hub = new Hub({ config: { ...config, feishu: { ...config.feishu, enabled: false } } });
    const engine = String(args.engine || 'codex');
    const prUrl = `https://github.com/${repo}/pull/${pr}`;
    try {
      const pipelineId = hub.pipeline.create({ repo, prNumber: pr, prUrl, engine });
      console.log(pipelineId);
      const result = await hub.pipeline.run({
        pipelineId, repo, prNumber: pr, prUrl, engine,
        options: { expectedHeadSha: info.headRefOid, requireReview: true, localController: true },
      });
      console.log(JSON.stringify(result, null, 2));
      return result.ok && result.steps.length === STEPS.length && result.steps.every((step) => step.ok && !step.skipped) ? 0 : 1;
    } finally {
      hub.stop();
      hub.ledger.close();
    }
  }
  const live = await probeHub(config);
  if (!live) throw new Error('中台未在线');
  const headers = { 'x-hub-token': config.hub.secret };
  async function get(pathname) {
    const res = await fetch(live.url + pathname, { headers, signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  let id = existingId;
  if (!id) {
    const status = await get('/api/pipeline?limit=1');
    if (status.dry || !status.release_configured || !status.verify_configured) {
      throw new Error('真实五步验收需要真实模式，并配置发布和核实命令');
    }
    const result = await postToHub(live.url, config, '/api/pipeline', {
      repo, pr_number: pr, engine: String(args.engine || 'codex'),
    });
    if (!result?.ok) throw new Error(result?.error || '流水线启动结果未知，请查看面板');
    id = result.pipeline_id;
  }
  console.log(id);
  const deadline = Date.now() + 60 * 60_000;
  let previous = '';
  while (Date.now() < deadline) {
    const { steps, active } = await get(`/api/pipeline/${encodeURIComponent(id)}`);
    const latest = new Map(steps.map((row) => [row.step, row]));
    const summary = STEPS.map((step) => `${step}=${latest.get(step)?.status || 'pending'}`).join(' ');
    if (summary !== previous) console.log(summary);
    previous = summary;
    const failed = STEPS.find((step) => latest.get(step)?.status === 'failed');
    if (failed && (active === false || failed !== 'review' || latest.get(failed).attempt >= 3)) {
      const detail = JSON.parse(latest.get(failed).detail || '{}');
      if (detail.error) console.error(detail.error);
      return 1;
    }
    if (['passed', 'skipped'].includes(latest.get('verify')?.status)) {
      return STEPS.every((step) => latest.get(step)?.status === 'passed') ? 0 : 1;
    }
    if (active === false) throw new Error('流水线已停止，五步尚未完成');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`等待超时。可用 pipeline ${id} 继续查看`);
}

/** 带访问令牌的 JSON POST */
async function postToHub(baseUrl, config, pathname, body) {
  const secret = config.hub.secret;
  const headers = { 'Content-Type': 'application/json' };
  if (secret && secret !== 'local-dev-secret-change-me') headers['x-hub-token'] = secret;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    clearTimeout(timer);
    return await res.json().catch(() => null);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 通过 HTTP 轮询任务状态（中台在线时用，避免读到过期的本地快照） */
async function waitForTaskHttp(baseUrl, config, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let beat = 0;
  const secret = config.hub.secret;
  const headers = {};
  if (secret && secret !== 'local-dev-secret-change-me') headers['x-hub-token'] = secret;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers });
      const data = await res.json().catch(() => null);
      const row = data?.task;
      if (row && ['completed', 'failed', 'dead_letter', 'rejected'].includes(row.status)) return row;
    } catch { /* 网络抖动忽略，继续等 */ }
    await new Promise((r) => setTimeout(r, 400));
    beat += 1;
    if (beat % 25 === 0) process.stdout.write(C.dim('.'));
  }
  return null;
}

async function waitForTask(hub, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let beat = 0;
  while (Date.now() < deadline) {
    const row = hub.ledger.get('SELECT * FROM tasks WHERE task_id=?', taskId);
    if (row && ['completed', 'failed', 'dead_letter', 'rejected'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 400));
    beat += 1;
    if (beat % 25 === 0) process.stdout.write(C.dim('.'));
  }
  return hub.ledger.get('SELECT * FROM tasks WHERE task_id=?', taskId);
}

function printTaskResult(task) {
  const status = colorStatus(task.status);
  console.log(`\n  ${status}  ${task.title || task.task_id}`);
  if (task.finished_at) {
    const ms = new Date(task.finished_at) - new Date(task.created_at);
    console.log(C.dim(`  用时 ${(ms / 1000).toFixed(1)}s  引擎 ${task.engine}`));
  }
  let result = null;
  try { result = JSON.parse(task.result || 'null'); } catch { /* ignore */ }
  const text = result?.text || result?.summary || '';
  if (text) {
    console.log('');
    const lines = String(text).split('\n').slice(0, 40);
    for (const l of lines) console.log('  ' + l);
    if (String(text).split('\n').length > 40) console.log(C.dim('  …（完整输出在台账与日志里）'));
  }
  if (task.error) console.log(C.red(`\n  错误：${task.error}`));
}

function cmdEvents(hub, args) {
  const rows = hub.events.listEvents({
    status: args.status && args.status !== true ? String(args.status) : undefined,
    source: args.source && args.source !== true ? String(args.source) : undefined,
    limit: Number(args.limit || 20),
  });
  console.log('');
  table(rows, [
    { title: '时间', get: (r) => String(r.created_at).slice(5, 19).replace('T', ' '), width: 16 },
    { title: '来源', get: (r) => r.source },
    { title: '类型', get: (r) => r.type },
    { title: '优先级', get: (r) => r.priority },
    { title: '状态', get: (r) => colorStatus(r.status) },
    { title: '摘要', get: (r) => String(r.summary || '').slice(0, 40) },
  ]);
  console.log('');
  return 0;
}

function cmdTasks(hub, args) {
  const where = [];
  const params = [];
  if (args.status && args.status !== true) { where.push('status=?'); params.push(String(args.status)); }
  if (args.node && args.node !== true) { where.push('node=?'); params.push(String(args.node)); }
  const rows = hub.ledger.all(
    `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`,
    ...params, Number(args.limit || 20),
  );
  console.log('');
  table(rows, [
    { title: '时间', get: (r) => String(r.created_at).slice(5, 19).replace('T', ' ') },
    { title: '任务', get: (r) => r.task_id.slice(0, 12) },
    { title: '引擎', get: (r) => r.engine || '-' },
    { title: '节点', get: (r) => r.node || '-' },
    { title: '状态', get: (r) => colorStatus(r.status) },
    { title: '优先级', get: (r) => r.priority },
    { title: '标题', get: (r) => String(r.title || '').slice(0, 34) },
  ]);
  console.log('');
  return 0;
}

function cmdTask(hub, args) {
  const id = args._[1];
  if (!id) { console.error('用法：node src/cli.mjs task <task_id>'); return 2; }
  const row = hub.ledger.get('SELECT * FROM tasks WHERE task_id=? OR task_id LIKE ?', id, `${id}%`);
  if (!row) { console.error('任务不存在：' + id); return 1; }
  const runs = hub.ledger.all('SELECT * FROM runs WHERE task_id=? ORDER BY started_at', row.task_id);
  console.log(`\n${C.bold(row.title || row.task_id)}`);
  console.log(`  任务 ${row.task_id}`);
  console.log(`  状态 ${colorStatus(row.status)}  引擎 ${row.engine || '-'}  节点 ${row.node || '-'}  尝试 ${row.attempts}/${row.max_attempts}`);
  if (row.skill) console.log(`  技能 ${row.skill}`);
  if (row.rule_id) console.log(`  规则 ${row.rule_id}`);
  if (row.error) console.log(C.red(`  错误 ${row.error}`));
  if (runs.length) {
    console.log('\n' + C.dim('  执行记录'));
    table(runs, [
      { title: '开始', get: (r) => String(r.started_at || '').slice(5, 19).replace('T', ' ') },
      { title: '节点', get: (r) => r.node || '-' },
      { title: '引擎', get: (r) => r.engine || '-' },
      { title: '状态', get: (r) => colorStatus(r.status) },
      { title: '退出码', get: (r) => (r.exit_code ?? '-') },
    ]);
  }
  printTaskResult(row);
  console.log('');
  return 0;
}

function cmdApprovals(hub, args) {
  const rows = hub.approvals.list({ status: args.all ? undefined : 'pending', limit: Number(args.limit || 30) });
  console.log('');
  if (!rows.length) { console.log(C.dim('  （没有待批红事项）')); console.log(''); return 0; }
  table(rows, [
    { title: '时间', get: (r) => String(r.created_at).slice(5, 16).replace('T', ' ') },
    { title: '编号', get: (r) => r.approval_id },
    { title: '分类', get: (r) => r.category },
    { title: '状态', get: (r) => colorStatus(r.status) },
    { title: '事项', get: (r) => String(r.title || '').slice(0, 36) },
  ]);
  console.log(C.dim('\n  批红：node src/cli.mjs approve <编号> --note "可以"'));
  console.log('');
  return 0;
}

async function cmdDecide(hub, args, decision) {
  const id = args._[1];
  if (!id) { console.error(`用法：node src/cli.mjs ${decision === 'agree' ? 'approve' : decision} <approval_id> --note "说明"`); return 2; }
  const res = await hub.approvals.decide(id, {
    decision, note: args.note && args.note !== true ? String(args.note) : undefined, by: args.by || 'cli',
  });
  if (!res.ok) { console.error(C.red('✗ ' + res.error)); return 1; }
  console.log(`\n${C.green('✓')} ${res.approval.title} → ${colorStatus(res.approval.status)}`);
  if (decision === 'agree') console.log(C.dim('  已记进决定记忆；对应任务回到队列，等节点接单。'));
  if (decision === 'reject') console.log(C.dim('  已记进「定了不做的事」，对应任务置为 rejected。'));
  if (decision === 'revise') console.log(C.dim('  已置为调整中；改完用 resubmit 重新票拟（面板或 API）。'));
  console.log('');
  return 0;
}

function cmdReports(hub, args) {
  const rows = hub.reports.list({ kind: args.kind && args.kind !== true ? String(args.kind) : undefined, limit: Number(args.limit || 10) });
  console.log('');
  if (!rows.length) { console.log(C.dim('  （还没有报告）')); console.log(''); return 0; }
  table(rows, [
    { title: '时间', get: (r) => String(r.created_at).slice(0, 16).replace('T', ' ') },
    { title: '类别', get: (r) => r.kind },
    { title: '标题', get: (r) => String(r.title || '').slice(0, 40) },
    { title: '文件', get: (r) => String(r.path || '').replace(/^.*reports[\\/]/, '') },
  ]);
  console.log('');
  if (args.read) {
    const one = hub.reports.read(String(args.read));
    if (one) console.log(one.body);
  }
  return 0;
}

function cmdDecisions(hub, args) {
  const list = args.query && args.query !== true
    ? hub.decisions.relevant(String(args.query), Number(args.limit || 10))
    : hub.decisions.list({ limit: Number(args.limit || 20) });
  console.log('');
  if (!list.length) { console.log(C.dim('  （还没有决定记忆）')); console.log(''); return 0; }
  for (const d of list) {
    const tag = d.kind === 'refused' ? C.red('[不做]') : C.green('[定过]');
    console.log(`  ${tag} ${d.text}  ${C.dim(String(d.decided_at).slice(0, 10))}`);
  }
  console.log('');
  return 0;
}

function cmdRules(hub) {
  const rules = hub.rules.all ? hub.rules.all() : null;
  const list = rules || [];
  console.log('');
  table(list, [
    { title: '序号', get: (r) => r.order },
    { title: '规则', get: (r) => r.id },
    { title: '匹配', get: (r) => `${r.match.source || '*'} / ${r.match.type || '*'}` },
    { title: '派给', get: (r) => (r.action === 'notify' ? C.yellow('直接推人') : `${r.route.node}·${r.route.engine}`) },
    { title: '技能', get: (r) => r.skill || '-' },
    { title: '批红', get: (r) => (r.approval === 'always' ? C.yellow('必批') : '-') },
  ]);
  console.log('');
  return 0;
}

function cmdEngines(hub) {
  const engines = hub.engines.list();
  console.log('');
  for (const e of engines) {
    const mark = e.available ? C.green('✓ 可用') : C.dim('✗ 未安装');
    console.log(`  ${pad(e.id, 14)} ${mark}  ${C.dim(e.label || e.bin || '')}`);
  }
  console.log('');
  console.log(C.dim('  技能：' + hub.skills.list().map((s) => s.name).join(' ')));
  console.log('');
  return 0;
}

function cmdTimers(hub) {
  const timers = hub.cron.describe();
  console.log('');
  if (!timers.length) { console.log(C.dim('  （没有定时器）')); console.log(''); return 0; }
  table(timers, [
    { title: '名称', get: (t) => t.name },
    { title: 'cron', get: (t) => t.cron },
    { title: '下次', get: (t) => t.next_local || t.next || '-' },
    { title: '类型', get: (t) => t.type },
  ]);
  console.log('');
  return 0;
}

function cmdNodes(config) {
  console.log('');
  for (const n of config.nodes || []) {
    console.log(`  ${C.bold(n.id)}  ${C.dim(n.label || '')}`);
    console.log(`    引擎 ${(n.engines || []).join(' ')}`);
    console.log(C.dim(`    启动：node src/m3/worker.mjs --node ${n.id} --engines ${(n.engines || ['mock']).join(',')} --hub http://${config.hub.host}:${config.hub.port}`));
  }
  console.log('');
  return 0;
}

function cmdDoctor(hub, config) {
  const checks = [];
  checks.push(['Node 版本', process.version, process.versions.node >= '22.5']);
  let sqliteOk = false;
  try { sqliteOk = Boolean(hub.ledger.get('SELECT 1 AS ok')?.ok); } catch { /* ignore */ }
  checks.push(['SQLite 台账', sqliteOk ? config.paths.db : '不可用', sqliteOk]);
  const dirs = [config.paths.data, config.paths.logs, config.paths.reports, config.paths.skills, config.paths.decisions];
  for (const d of dirs) checks.push([`目录 ${d.replace(config.paths.root + path.sep, '')}`, fs.existsSync(d) ? '存在' : '缺失', fs.existsSync(d)]);
  checks.push(['规则文件', `${config.paths.rules}（${hub.rules.size} 条）`, hub.rules.size > 0]);
  checks.push(['技能库', `${hub.skills.list().length} 套`, hub.skills.list().length > 0]);
  const engines = hub.engines.list();
  checks.push(['可用引擎', engines.filter((e) => e.available).map((e) => e.id).join(' ') || '无', engines.some((e) => e.available)]);
  checks.push(['飞书', hub.feishu.enabled ? '已配置' : '未配置（通知走本地兜底）', true]);
  // 配了飞书却没配验签密钥 = /webhook/feishu 对所有请求放行，
  // 而这条路径直接改票拟状态。必须显式拦一下，别让人以为「跑起来了就安全」。
  // 例外：中台只监听回环地址时（单向模式），回调根本进不来、没有可伪造的入口，
  // 降级为提示不判死；一旦 hub.host 对外监听（局域网面板/公网回调），立即恢复判死。
  if (hub.feishu.enabled) {
    const hasSecret = Boolean(config.feishu.verificationToken || config.feishu.encryptKey);
    const exposed = config.hub.host !== '127.0.0.1' && config.hub.host !== 'localhost';
    if (hasSecret) {
      checks.push(['飞书回调验签', '已启用', true]);
    } else if (exposed) {
      checks.push(['飞书回调验签', '未配置密钥，且中台已对外监听（任何人都能伪造批红卡片）', false]);
    } else {
      checks.push(['飞书回调验签', '未配置密钥（单向模式：只监听本机，回调进不来，暂无风险）', true]);
    }
  }
  checks.push(['GitHub Webhook 密钥', config.github.webhookSecret ? '已设置' : '未设置（webhook 不验签）', true]);
  console.log('');
  for (const [name, value, ok] of checks) {
    console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${pad(name, 26)} ${C.dim(String(value))}`);
  }
  console.log('');
  const bad = checks.filter((c) => !c[2]);
  if (bad.length) { console.log(C.red(`  有 ${bad.length} 项不通过，先修好再跑。`)); console.log(''); return 1; }
  console.log(C.green('  环境自检通过。'));
  console.log('');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('命令失败：', err.message);
  if (process.env.HUB_DEBUG) console.error(err);
  process.exitCode = 1;
});
