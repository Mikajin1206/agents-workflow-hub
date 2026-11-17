import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDirs, HUB_ROOT } from '../lib/config.mjs';
import { createLogger } from '../lib/logger.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { RuleSet } from '../lib/rules.mjs';
import { SkillLibrary, buildPrompt } from '../m6/skills.mjs';
import { DecisionMemory } from '../m6/decisions.mjs';
import { runWithEngine, listEngines, setCodexSandboxPolicy, setClaudePermissionMode } from './engines.mjs';

/**
 * M3 执行节点（方案 §6）。
 *
 * 一台机器上跑一个 worker：
 *   node src/m3/worker.mjs --node win-a --engines claude-code,codex,mock
 *
 * 行为：长轮询挂起 → 接单 → 装 SOP（skill）+ 决定记忆 + 指令模板 → 调引擎 → 回写结果。
 * 关键：中台不主动连节点，节点永远主动来要活。
 */
export async function startWorker(options = {}) {
  const cfg = options.config || loadConfig();
  ensureDirs(cfg);
  TOKEN_CACHE = options.token || process.env.HUB_TOKEN || cfg.hub.secret || '';
  const nodeId = options.nodeId || process.env.HUB_NODE || cfg.nodes?.[0]?.id || 'win-a';
  const engines = normalizeList(options.engines || process.env.HUB_ENGINES || 'claude-code,codex,mock');
  const hubUrl = options.hubUrl || process.env.HUB_URL || `http://${cfg.hub.host}:${cfg.hub.port}`;
  const once = Boolean(options.once);
  const log = createLogger({ dir: path.join(cfg.paths.logs, 'worker'), level: options.level || cfg.logging.level, name: nodeId });

  const skills = new SkillLibrary({ dir: cfg.paths.skills, log });
  const ledger = options.ledger || null;
  const decisions = options.decisions
    || (ledger ? new DecisionMemory({ ledger, dir: cfg.paths.decisions, config: cfg, log }) : null);

  log.info('执行节点启动', { node: nodeId, engines, hub: hubUrl, once });

  // 按配置决定 codex 是否用原生沙箱（默认 bypass，理由见 engines.mjs）
  setCodexSandboxPolicy(cfg.engines?.codexSandbox);
  setClaudePermissionMode(cfg.engines?.claudePermissionMode);

  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let processed = 0;

  while (!stopping) {
    try {
      const le = await pollOnce({ hubUrl, nodeId, engines, waitSeconds: cfg.hub.leaseWaitSeconds, log });
      if (!le) {
        if (once) break;
        continue;
      }
      processed += 1;
      await handleTask({ le, hubUrl, nodeId, cfg, log, skills, decisions });
      if (once) break;
    } catch (err) {
      log.error('节点主循环异常', { error: err.message });
      if (once) throw err;
      await sleep(3000);
    }
  }
  log.info('执行节点退出', { node: nodeId, processed });
  return { processed };
}

async function pollOnce({ hubUrl, nodeId, engines, waitSeconds, log }) {
  const url = `${hubUrl}/api/agent/poll?node=${encodeURIComponent(nodeId)}&engines=${encodeURIComponent(engines.join(','))}&wait=${waitSeconds}`;
  const res = await fetchWithRetry(url, { method: 'GET', headers: authHeaders() }, log);
  if (!res) return null;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!data?.task) return null;
  log.info('接到任务', { task: data.task.task_id, engine: data.task.engine, title: data.task.title });
  return data.task;
}

async function handleTask({ le, hubUrl, nodeId, cfg, log, skills, decisions }) {
  const task = le;
  const base = hubUrl;
  const taskId = task.task_id;
  const beat = setInterval(() => {
    heartbeat(base, taskId, nodeId).catch(() => {});
  }, Math.max(5, cfg.hub.heartbeatSeconds) * 1000);
  beat.unref?.();

  try {
    await postJson(`${base}/api/agent/tasks/${taskId}/start`, { node: nodeId }, log);

    // ── 装 SOP：skill 正文 + 决定记忆 + 指令模板
    const skill = task.skill ? skills.load(task.skill) : null;
    if (task.skill && !skill) log.warn('指定 skill 不存在，按无 SOP 执行', { skill: task.skill });
    const query = `${task.title || ''} ${task.skill || ''} ${task.meta?.envelope?.type || ''} ${JSON.stringify(task.meta?.payload || {})}`;
    const rel = decisions ? decisions.relevant(query, 6) : [];
    const prompt = buildPrompt({
      task,
      skill,
      decisions: rel,
      envelope: task.meta?.envelope,
      payload: task.meta?.payload,
      hubUrl,
      token: hubTokenValue(),
    });

    const workdir = resolveWorkdir(task.workdir, cfg);
    const logDir = path.join(cfg.paths.logs, 'engines');
    fs.mkdirSync(logDir, { recursive: true });

    const result = await runWithEngine({
      engineId: task.engine,
      prompt,
      task,
      workdir,
      model: task.model,
      mode: task.meta?.payload?.mode || 'work',
      log,
      logDir,
    });

    const payload = {
      ok: result.ok,
      exit_code: result.exitCode,
      text: result.text || '',
      error: result.error || null,
      duration_ms: result.durationMs || 0,
      engine: result.engine,
      node: nodeId,
      log_path: result.logPath || null,
      skill: task.skill || null,
      prompt_chars: prompt.length,
      decided_refs: rel.map((d) => d.decision_id),
    };

    if (result.ok) {
      await postJson(`${base}/api/agent/tasks/${taskId}/complete`, payload, log);
      log.info('任务完成', { task: taskId, ms: payload.duration_ms });
    } else {
      await postJson(`${base}/api/agent/tasks/${taskId}/fail`, {
        error: result.error || `引擎退出码 ${result.exitCode}`,
        retryable: result.exitCode !== 126 && result.exitCode !== 403,
        log_path: result.logPath || null,
      }, log);
      log.warn('任务失败已回写', { task: taskId, error: result.error });
    }
  } catch (err) {
    log.error('任务处理异常', { task: taskId, error: err.message, stack: err.stack });
    try {
      await postJson(`${base}/api/agent/tasks/${taskId}/fail`, { error: err.message, retryable: true }, log);
    } catch { /* ignore */ }
  } finally {
    clearInterval(beat);
  }
}

function resolveWorkdir(workdir, cfg) {
  if (!workdir) return cfg.paths.root;
  const p = path.isAbsolute(workdir) ? workdir : path.join(HUB_ROOT, workdir);
  try {
    if (fs.statSync(p).isDirectory()) return p;
  } catch { /* ignore */ }
  return cfg.paths.root;
}

async function heartbeat(base, taskId, nodeId) {
  await postJson(`${base}/api/agent/tasks/${taskId}/heartbeat`, { node: nodeId, extend: 120 }, null);
}

async function postJson(url, body, log) {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }, log);
  if (!res) throw new Error(`请求失败：${url}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} → ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// 中台设了访问密钥（hub.secret）后，节点必须带同一个令牌才能领活。
// 令牌来源：config/hub.config.json 的 hub.secret（worker 和中台读同一份配置，
// 重启即生效）；环境变量 HUB_TOKEN 可覆盖 —— 本地无密钥模式照常工作。
// 同一个值也喂给 buildPrompt 注入 {{token}} 占位，让日报这类 SOP 能带着
// 令牌调中台 API（默认开发值不注入，避免把假令牌写进提示词）。
let TOKEN_CACHE = '';
function hubTokenValue() {
  const token = TOKEN_CACHE || process.env.HUB_TOKEN || '';
  return token && token !== 'local-dev-secret-change-me' ? token : '';
}
function authHeaders() {
  const token = hubTokenValue();
  return token ? { 'x-hub-token': token } : {};
}

async function fetchWithRetry(url, init, log, attempt = 0) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 120_000);
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    if (attempt >= 3) {
      log?.error?.('请求失败且重试用尽', { url, error: err.message });
      return null;
    }
    await sleep(1000 * (attempt + 1));
    return fetchWithRetry(url, init, log, attempt + 1);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/* ─────────────── CLI 入口 ─────────────── */
if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法：
  node src/m3/worker.mjs --node win-a --engines claude-code,codex,mock [--once] [--hub http://127.0.0.1:8787]

选项：
  --node <id>       节点名，需与 rules.json 里 route.node 对应（默认 win-a）
  --engines <list>  本机启用的引擎，逗号分隔（默认 claude-code,codex,mock）
  --hub <url>       中台地址（默认读配置）
  --once            只接一个任务就退出（用于自测）
  --list-engines    打印引擎可用性后退出`);
    process.exit(0);
  }
  if (args['list-engines']) {
    (async () => {
      for (const e of listEngines()) console.log(`${e.available ? '✓' : '✗'} ${e.id.padEnd(12)} ${e.describe}`);
    })();
  } else {
    startWorker({
      nodeId: args.node,
      engines: args.engines,
      hubUrl: args.hub,
      once: Boolean(args.once),
    }).then((r) => {
      if (args.once) process.exit(0);
      return r;
    }).catch((err) => {
      console.error('执行节点启动失败：', err.message);
      process.exit(1);
    });
  }
}

function isMain(url) {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(url));
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}
