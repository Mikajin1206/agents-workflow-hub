#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, nowIso } from './lib/config.mjs';
import { Router, createCtx, readBody, parseBody, verifyHmacSha256, serveStatic } from './lib/http.mjs';
import { Hub } from './hub.mjs';
import { parseCron } from './lib/cron.mjs';
import {
  SOURCES, EVENT_TYPES, PRIORITIES, APPROVAL_MODES, ACTIONS, CRON_PRESETS,
} from './lib/catalog.mjs';

/**
 * 中台 HTTP 服务（唯一监听端口，默认 127.0.0.1:8787）。
 *
 * 三条边界：
 *  1) /webhook/*   ← 外部系统主动打进来（GitHub / 监控 / 飞书回调）
 *  2) /api/agent/* ← 内网节点主动来要活（长轮询），中台从不主动连节点
 *  3) /api/*、/     ← 本地面板与 CLI 使用
 */

const cfg = loadConfig();
const hub = new Hub({ config: cfg });
const router = new Router();
const startedAt = nowIso();

/* ────────────────────────── 鉴权（轻量） ────────────────────────── */

const SECRET = cfg.hub.secret;
const SECRET_IS_DEFAULT = !SECRET || SECRET === 'local-dev-secret-change-me';

function authorized(ctx) {
  if (SECRET_IS_DEFAULT) return true; // 本地开发：不设防，靠 127.0.0.1
  const header = ctx.headers['x-hub-token'] || ctx.query.token || '';
  return header === SECRET;
}

function guard(ctx) {
  if (authorized(ctx)) return true;
  ctx.error('未授权：请在请求头带 x-hub-token', 401);
  return false;
}

/* ────────────────────────── 面板静态资源 ────────────────────────── */

router.get('/', (ctx) => {
  const file = path.join(cfg.paths.ui, 'index.html');
  if (!fs.existsSync(file)) return ctx.html(fallbackPage(), 200);
  ctx.text(fs.readFileSync(file, 'utf8'), 200, 'text/html; charset=utf-8');
});

router.get('/static/*', (ctx) => {
  const rel = ctx.path.replace(/^\/static\//, '');
  const ok = serveStatic(cfg.paths.ui, rel, ctx.res);
  if (!ok) ctx.text('Not found', 404);
});

/* ────────────────────────── 健康与总览 ────────────────────────── */

router.get('/api/health', (ctx) => {
  ctx.json({
    ok: true,
    service: cfg.hub.name,
    started_at: startedAt,
    uptime_seconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
    rules: hub.rules.size,
    feishu: hub.feishu.enabled ? 'enabled' : 'disabled',
    feishu_ws: hub.feishuWs?.status?.() ?? null,
    node: process.version,
  });
});

router.get('/api/snapshot', (ctx) => {
  if (!guard(ctx)) return;
  ctx.json(hub.snapshot());
});

router.get('/api/stats', (ctx) => {
  if (!guard(ctx)) return;
  const since = ctx.query.since || new Date(Date.now() - 24 * 3600_000).toISOString();
  ctx.json({ ok: true, ...hub.stats({ since, until: ctx.query.until }) });
});

/* ────────────────────────── M4 流水线 ────────────────────────── */

router.get('/api/pipeline', (ctx) => {
  if (!guard(ctx)) return;
  const runner = hub.pipeline.runner;
  ctx.json({
    ok: true,
    // dry=true 表示五步全是模拟，一眼要能看出来，不能让人以为真上线了
    dry: Boolean(runner?.dry),
    auto_start: hub.config.pipeline?.autoStart !== false,
    mode: hub.config.pipeline?.mode || 'auto',
    reviewer_engine: hub.config.pipeline?.reviewerEngine || null,
    release_configured: Boolean(hub.config.pipeline?.releaseCommand),
    verify_configured: Boolean(hub.config.pipeline?.verifyCommand),
    runs: hub.pipeline.history({ limit: Number(ctx.query.limit || 30) }),
  });
});

router.get('/api/pipeline/:id', (ctx) => {
  if (!guard(ctx)) return;
  const rows = hub.ledger.all('SELECT * FROM pipeline_runs WHERE pipeline_id=? ORDER BY seq', ctx.params.id);
  if (!rows.length) return ctx.error('流水线不存在', 404);
  ctx.json({ ok: true, pipeline_id: ctx.params.id, steps: rows });
});

/**
 * 手动触发一次流水线。
 * autoStart=false 时这是唯一入口；面板上的「进流水线」按钮走这里。
 * 不给 release/verify 配置就会在④⑤如实报错，不会假装成功。
 */
router.post('/api/pipeline', async (ctx) => {
  if (!guard(ctx)) return;
  const b = ctx.body || {};
  if (!b.repo) return ctx.error('必须给 repo（如 owner/name）', 422);
  const prNumber = Number(b.pr_number || b.prNumber);
  if (!prNumber) return ctx.error('必须给 pr_number', 422);
  const prUrl = b.pr_url || `https://github.com/${b.repo}/pull/${prNumber}`;
  const pipelineId = hub.pipeline.create({
    taskId: b.task_id || null,
    repo: b.repo,
    prNumber,
    prUrl,
    engine: b.engine || 'codex',
  });
  // 不 await：五步可能跑几分钟，让面板立刻拿到 id 去轮询
  hub.pipeline
    .run({
      pipelineId,
      repo: b.repo,
      prNumber,
      prUrl,
      taskId: b.task_id || null,
      engine: b.engine || 'codex',
      options: { workdir: b.workdir, skip: Array.isArray(b.skip) ? b.skip : undefined },
    })
    .catch((err) => hub.log.error('流水线异常', { pipeline: pipelineId, error: err.message }));
  ctx.json({ ok: true, pipeline_id: pipelineId, status: 'started' });
});

router.get('/api/rules', (ctx) => {
  if (!guard(ctx)) return;
  ctx.json({
    ok: true,
    count: hub.rules.size,
    error: hub.rules.error,
    file: cfg.paths.rules,
    rules: hub.rules.all().map((r) => ({
      id: r.id, title: r.title, enabled: r.enabled, order: r.order, priority: r.priority,
      match: r.match, route: r.route, skill: r.skill, limits: r.limits,
      approval: r.approval, silent: r.silent, action: r.action, notify_level: r.notifyLevel,
      prompt: r.prompt || null,
      schedule: r.raw?.schedule || null,
    })),
  });
});

/**
 * 面板编辑规则的选项目录：来源、事件类型、引擎、节点、技能、cron 预设。
 * 集中在一个接口里返回，前端就不必硬编码这些字符串 —— 拼错一个下划线，
 * 规则会安静地永远匹配不上。
 */
router.get('/api/rules/catalog', (ctx) => {
  if (!guard(ctx)) return;
  const engines = hub.snapshot().hub.engines.filter((e) => e.available).map((e) => e.id);
  ctx.json({
    ok: true,
    sources: SOURCES,
    event_types: EVENT_TYPES,
    priorities: PRIORITIES,
    approval_modes: APPROVAL_MODES,
    actions: ACTIONS,
    cron_presets: CRON_PRESETS,
    engines: hub.snapshot().hub.engines.map((e) => ({ id: e.id, label: e.describe || e.id, available: Boolean(e.available) })),
    nodes: (cfg.nodes || []).map((n) => ({ id: n.id, label: n.label || n.id, engines: n.engines || [] })),
    skills: hub.skills.list().map((s) => ({ name: s.name, title: s.meta?.title || s.name })),
    engines_runnable: engines,
  });
});

/* 新建一条规则 */
router.post('/api/rules', (ctx) => {
  if (!guard(ctx)) return;
  try {
    const rule = hub.rules.create(ctx.body || {}, ruleValidateOptions());
    hub.cron.loadFromRules(hub.rules);
    ctx.json({ ok: true, rule: publicRule(rule) }, 201);
  } catch (err) {
    const code = err.code === 'INVALID' ? 422 : err.code === 'NOT_FOUND' ? 404 : 500;
    ctx.json({ ok: false, error: err.message, errors: err.errors || [err.message] }, code);
  }
});

/* 改一条规则 */
router.put('/api/rules/:id', (ctx) => {
  if (!guard(ctx)) return;
  try {
    const rule = hub.rules.save(ctx.params.id, ctx.body || {}, ruleValidateOptions());
    hub.cron.loadFromRules(hub.rules);
    ctx.json({ ok: true, rule: publicRule(rule) });
  } catch (err) {
    const code = err.code === 'INVALID' ? 422 : err.code === 'NOT_FOUND' ? 404 : 500;
    ctx.json({ ok: false, error: err.message, errors: err.errors || [err.message] }, code);
  }
});

/* 删一条规则 */
router.delete('/api/rules/:id', (ctx) => {
  if (!guard(ctx)) return;
  try {
    const gone = hub.rules.remove(ctx.params.id);
    hub.cron.loadFromRules(hub.rules);
    ctx.json({ ok: true, removed: gone.id, count: hub.rules.size });
  } catch (err) {
    ctx.json({ ok: false, error: err.message }, err.code === 'NOT_FOUND' ? 404 : 500);
  }
});

/** 校验时可用的引擎/节点/技能清单 */
function ruleValidateOptions() {
  const snap = hub.snapshot();
  return {
    engines: snap.hub.engines.filter((e) => e.available).map((e) => e.id),
    nodes: (cfg.nodes || []).map((n) => n.id),
    skills: hub.skills.list().map((s) => s.name),
    parseCron,
  };
}

function publicRule(r) {
  return {
    id: r.id, title: r.title, enabled: r.enabled, order: r.order, priority: r.priority,
    match: r.match, route: r.route, skill: r.skill, limits: r.limits,
    approval: r.approval, silent: r.silent, action: r.action, notify_level: r.notifyLevel,
    prompt: r.prompt || null, schedule: r.raw?.schedule || null,
  };
}

router.get('/api/engines', (ctx) => {
  ctx.json({
    ok: true,
    engines: hub.snapshot().hub.engines,
    skills: hub.skills.list(),
    timers: hub.cron.describe(),
    // 谁在线、能跑什么 —— 面板据此判断「这个引擎此刻真的有人能接」
    nodes: hub.queue.listNodes(),
  });
});

/* ────────────────────────── 事件 ────────────────────────── */

router.get('/api/events', (ctx) => {
  if (!guard(ctx)) return;
  ctx.json({
    ok: true,
    events: hub.events.listEvents({
      status: ctx.query.status,
      source: ctx.query.source,
      type: ctx.query.type,
      limit: Number(ctx.query.limit || 50),
      offset: Number(ctx.query.offset || 0),
    }),
  });
});

router.get('/api/events/:id', (ctx) => {
  if (!guard(ctx)) return;
  const trace = hub.events.trace(ctx.params.id);
  if (!trace) return ctx.error('事件不存在', 404);
  ctx.json({ ok: true, ...trace });
});

/** 通用入站：任何来源都可以按信封格式打进来 */
router.post('/api/events', async (ctx) => {
  if (!guard(ctx)) return;
  try {
    const res = await hub.ingestAsync(ctx.body, 'api');
    ctx.json({ ok: true, ...res }, res.duplicate ? 200 : 201);
  } catch (err) {
    ctx.error(err.message, err.code === 'INVALID_ENVELOPE' ? 422 : 400);
  }
});

/* ────────────────────────── 任务 ────────────────────────── */

router.get('/api/tasks', (ctx) => {
  if (!guard(ctx)) return;
  const where = [];
  const params = [];
  if (ctx.query.status) { where.push('status=?'); params.push(ctx.query.status); }
  if (ctx.query.node) { where.push('node=?'); params.push(ctx.query.node); }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const rows = hub.ledger.all(sql, ...params, Number(ctx.query.limit || 50), Number(ctx.query.offset || 0));
  ctx.json({
    ok: true,
    tasks: rows.map((r) => {
      const meta = safeJson(r.meta, {});
      return {
        task_id: r.task_id, event_id: r.event_id, rule_id: r.rule_id, title: r.title,
        node: r.node, engine: r.engine, model: r.model, skill: r.skill, status: r.status,
        priority: r.priority, attempts: r.attempts, max_attempts: r.max_attempts,
        created_at: r.created_at, finished_at: r.finished_at, error: r.error,
        has_result: Boolean(r.result), envelope_type: meta?.envelope?.type || null,
        source: meta?.envelope?.source || null,
      };
    }),
  });
});

router.get('/api/tasks/:id', (ctx) => {
  if (!guard(ctx)) return;
  const row = hub.ledger.get('SELECT * FROM tasks WHERE task_id=?', ctx.params.id);
  if (!row) return ctx.error('任务不存在', 404);
  const runs = hub.ledger.all('SELECT * FROM runs WHERE task_id=? ORDER BY started_at', ctx.params.id);
  ctx.json({ ok: true, task: row, runs });
});

/** 手动派活（面板/CLI）：直接指定引擎，不走规则 */
router.post('/api/dispatch', async (ctx) => {
  if (!guard(ctx)) return;
  const b = ctx.body || {};
  // engine 可省：省了就走 rules.json 匹配。
  // type 单独给也算数 —— cron/webhook 这类事件天然没有 summary，只靠 type 才能匹配规则。
  if (!b.engine && !b.summary && !b.title && !b.type) {
    return ctx.error('至少给一个 engine，或给 summary/type 让规则去匹配', 422);
  }
  const res = await hub.dispatchManual({
    type: b.type || 'cmd.manual',
    target: b.target || null,
    summary: b.summary || b.title || null,
    payload: b.payload || (b.prompt ? { instruction: b.prompt } : {}),
    node: b.node || 'any',
    engine: b.engine || null,
    model: b.model || null,
    skill: b.skill || null,
    prompt: b.prompt || '',
    workdir: b.workdir || null,
    priority: b.priority || 'P2',
    approvalRequired: Boolean(b.approval_required),
    source: b.source || 'web',
  });
  ctx.json({ ok: true, ...res }, 201);
});

/** 重试一个失败/死信任务 */
router.post('/api/tasks/:id/retry', (ctx) => {
  if (!guard(ctx)) return;
  const row = hub.ledger.get('SELECT * FROM tasks WHERE task_id=?', ctx.params.id);
  if (!row) return ctx.error('任务不存在', 404);
  if (!['failed', 'dead_letter', 'rejected'].includes(row.status)) {
    return ctx.error(`只有失败/死信/被驳的任务可以重试，当前 ${row.status}`, 409);
  }
  hub.ledger.run(
    `UPDATE tasks SET status='queued', attempts=0, error=NULL, finished_at=NULL, available_at=?, next_retry_at=NULL WHERE task_id=?`,
    nowIso(), ctx.params.id,
  );
  hub.ledger.audit({ entity: 'task', entityId: ctx.params.id, fromStatus: row.status, toStatus: 'queued', actor: 'web', detail: { manual_retry: true } });
  hub.queue.wakeAll();
  ctx.json({ ok: true, task_id: ctx.params.id, status: 'queued' });
});

/* ────────────────────────── 审批（票拟） ────────────────────────── */

router.get('/api/approvals', (ctx) => {
  if (!guard(ctx)) return;
  ctx.json({ ok: true, approvals: hub.approvals.list({ status: ctx.query.status, limit: Number(ctx.query.limit || 50) }) });
});

router.get('/api/approvals/:id', (ctx) => {
  if (!guard(ctx)) return;
  const a = hub.approvals.get(ctx.params.id);
  if (!a) return ctx.error('审批单不存在', 404);
  ctx.json({ ok: true, approval: a });
});

router.post('/api/approvals/:id/decide', async (ctx) => {
  if (!guard(ctx)) return;
  const { decision, note, revisedProposal } = ctx.body || {};
  const res = await hub.approvals.decide(ctx.params.id, {
    decision, note, revisedProposal, by: ctx.body?.by || 'web',
  });
  if (!res.ok) return ctx.error(res.error, 409);
  if (res.decision === 'agree') hub.queue.wakeAll();
  ctx.json({ ok: true, approval: res.approval, decision: res.decision });
});

router.post('/api/approvals/:id/resubmit', async (ctx) => {
  if (!guard(ctx)) return;
  const res = await hub.approvals.resubmit(ctx.params.id, {
    proposal: ctx.body?.proposal, question: ctx.body?.question, by: ctx.body?.by || 'web',
  });
  if (!res.ok) return ctx.error(res.error, 409);
  ctx.json({ ok: true, approval: res.approval });
});

/* ────────────────────────── 报告 / 决定记忆 / 台账 ────────────────────────── */

// 通知流水：人能核对「该发的到底发了没」。
// 没有这个入口，战报没送到也查不出来 —— 只能靠翻日志猜。
router.get('/api/notifications', (ctx) => {
  if (!guard(ctx)) return;
  const limit = Number(ctx.query.limit || 50);
  const where = [];
  const params = [];
  if (ctx.query.level) { where.push('level=?'); params.push(String(ctx.query.level).toUpperCase()); }
  if (ctx.query.channel) { where.push('channel=?'); params.push(ctx.query.channel); }
  if (ctx.query.status) { where.push('status=?'); params.push(ctx.query.status); }
  const sql = `SELECT * FROM notifications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const rows = hub.ledger.all(sql, ...params, limit);
  const digestQueued = hub.ledger.get(
    "SELECT count(*) AS c FROM notifications WHERE channel='digest' AND status='queued'",
  ).c;
  ctx.json({ ok: true, notifications: rows, digest_queued: digestQueued });
});

router.get('/api/reports', (ctx) => {
  if (!guard(ctx)) return;
  ctx.json({ ok: true, reports: hub.reports.list({ kind: ctx.query.kind, limit: Number(ctx.query.limit || 30) }) });
});

router.get('/api/reports/:id', (ctx) => {
  if (!guard(ctx)) return;
  const r = hub.reports.read(ctx.params.id);
  if (!r) return ctx.error('报告不存在', 404);
  ctx.json({ ok: true, report: r });
});

router.get('/api/decisions', (ctx) => {
  if (!guard(ctx)) return;
  ctx.json({ ok: true, decisions: hub.decisions.list({ kind: ctx.query.kind, limit: Number(ctx.query.limit || 100) }) });
});

router.post('/api/decisions', (ctx) => {
  if (!guard(ctx)) return;
  const b = ctx.body || {};
  if (!b.text) return ctx.error('缺少 text', 422);
  const d = hub.decisions.record({
    kind: b.kind === 'refused' ? 'refused' : 'decided',
    text: b.text, quote: b.quote || b.text, by: b.by || 'web',
    tags: b.tags || [],
  });
  ctx.json({ ok: true, decision: d }, 201);
});

router.get('/api/ledger', (ctx) => {
  if (!guard(ctx)) return;
  ctx.json({ ok: true, ...hub.stats({ since: ctx.query.since, until: ctx.query.until }) });
});

router.get('/api/audit', (ctx) => {
  if (!guard(ctx)) return;
  const entity = ctx.query.entity;
  const entityId = ctx.query.entity_id;
  const rows = entity && entityId
    ? hub.ledger.all('SELECT * FROM event_audit WHERE entity=? AND entity_id=? ORDER BY audit_id DESC LIMIT ?', entity, entityId, Number(ctx.query.limit || 100))
    : hub.ledger.all('SELECT * FROM event_audit ORDER BY audit_id DESC LIMIT ?', Number(ctx.query.limit || 100));
  ctx.json({ ok: true, audit: rows });
});

/* ──────────────── M3 节点接口（长轮询，节点永远主动） ──────────────── */

router.get('/api/agent/poll', async (ctx) => {
  if (!guard(ctx)) return;
  const nodeId = ctx.query.node || 'unknown';
  const engines = String(ctx.query.engines || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wait = Math.min(Number(ctx.query.wait || cfg.hub.leaseWaitSeconds), 120);
  const task = await hub.queue.poll({ nodeId, engines, waitSeconds: wait });
  if (!task) {
    ctx.res.writeHead(204, { 'Cache-Control': 'no-store' });
    ctx.res.end();
    ctx.sent = true;
    return;
  }
  hub.events.updateEventStatus(task.event_id, 'running', { task: task.task_id, node: nodeId });
  ctx.json({ ok: true, task, heartbeat_seconds: cfg.hub.heartbeatSeconds });
});

router.post('/api/agent/tasks/:id/start', (ctx) => {
  if (!guard(ctx)) return;
  const ok = hub.queue.markRunning(ctx.params.id, ctx.body?.node || 'unknown');
  if (!ok) return ctx.error('任务不存在', 404);
  ctx.json({ ok: true });
});

router.post('/api/agent/tasks/:id/heartbeat', (ctx) => {
  if (!guard(ctx)) return;
  const ok = hub.queue.heartbeat(ctx.params.id, ctx.body?.node || 'unknown', ctx.body?.extend || 120);
  ctx.json({ ok });
});

router.post('/api/agent/tasks/:id/complete', async (ctx) => {
  if (!guard(ctx)) return;
  const payload = ctx.body || {};
  const task = hub.queue.complete(ctx.params.id, payload.node || 'unknown', payload);
  if (!task) return ctx.error('任务不存在', 404);
  await hub.afterTaskUpdate(ctx.params.id);
  // 长产出自动归档进报告库
  if (payload.text && payload.text.length > 400) {
    hub.reports.save({
      kind: 'task_output',
      title: task.title || ctx.params.id,
      body: payload.text,
      taskId: task.task_id,
      eventId: task.event_id,
      meta: { engine: payload.engine, node: payload.node, skill: payload.skill },
    });
  }
  ctx.json({ ok: true, task_id: task.task_id, status: task.status });
});

router.post('/api/agent/tasks/:id/fail', async (ctx) => {
  if (!guard(ctx)) return;
  const body = ctx.body || {};
  const res = hub.queue.fail(ctx.params.id, body.node || 'unknown', body.error || '节点报错', {
    retryable: body.retryable !== false,
  });
  if (!res) return ctx.error('任务不存在', 404);
  await hub.afterTaskUpdate(ctx.params.id);
  ctx.json({ ok: true, ...res });
});

/* ────────────────────────── 引擎自检 ────────────────────────── */

router.post('/api/selftest', async (ctx) => {
  if (!guard(ctx)) return;
  const engine = ctx.body?.engine || 'mock';
  const res = await hub.dispatchManual({
    type: 'cmd.manual', target: 'selftest', summary: `自检任务（${engine}）`,
    payload: { instruction: '这是一次链路自检，不需要产生任何副作用。', mock: ctx.body?.mock || {} },
    node: 'any', engine, prompt: '这是一次链路自检，请按 SOP 输出一句结论。', priority: 'P3',
    source: 'web',
  });
  ctx.json({ ok: true, ...res }, 201);
});

/* ────────────────────────── M1 外部 webhook ────────────────────────── */

router.post('/webhook/github', async (ctx) => {
  const raw = ctx.rawBody;
  const sig = ctx.headers['x-hub-signature-256'];
  if (cfg.github.webhookSecret && !verifyHmacSha256(cfg.github.webhookSecret, raw, sig)) {
    return ctx.error('GitHub 签名校验失败', 401);
  }
  try {
    const env = hub.webhooks.github(ctx.headers, ctx.body);
    const res = await hub.ingestAsync(env, 'github-webhook');
    ctx.json({ ok: true, ...res });
  } catch (err) {
    const code = err.code;
    if (code === 'IGNORED') return ctx.json({ ok: true, ignored: true, reason: err.message });
    if (code === 'REPO_NOT_ALLOWED') return ctx.error(err.message, 403);
    ctx.error(err.message, 400);
  }
});

router.post('/webhook/monitor', async (ctx) => {
  // 可选共享密钥：config.monitor.sharedSecret 非空时要求带上。
  // 默认绑 127.0.0.1 时用不上，但只要把 host 改成局域网地址就必须配，
  // 否则同网段任何人都能伪造 P0 告警刷屏。
  const secret = cfg.monitor?.sharedSecret;
  if (secret) {
    const given = ctx.headers['x-monitor-secret'] || ctx.query.secret;
    if (given !== secret) return ctx.error('监控 webhook 密钥不匹配', 401);
  }
  try {
    const env = hub.webhooks.generic(ctx.body || {});
    const res = await hub.ingestAsync(env, 'monitor-webhook');
    ctx.json({ ok: true, ...res });
  } catch (err) {
    ctx.error(err.message, 400);
  }
});

router.post('/webhook/feishu', async (ctx) => {
  const body = ctx.body || {};
  // URL 校验挑战
  if (body.type === 'url_verification' || body.challenge) {
    return ctx.json({ challenge: body.challenge || body.encrypt });
  }
  // 飞书把时间戳和随机串放在 x-lark-request-timestamp / x-lark-request-nonce
  // 里，不是裸的 timestamp / nonce。早先按 bare name 取，两个值永远是 undefined，
  // 于是签名永远算不对 —— 配了密钥就恒返回 401（验签加固后才暴露出来）。
  const timestamp = ctx.headers['x-lark-request-timestamp'] || ctx.headers.timestamp;
  const nonce = ctx.headers['x-lark-request-nonce'] || ctx.headers.nonce;
  const sig = ctx.headers['x-lark-signature'] || ctx.headers['x-feishu-signature'];
  // 用原始请求体验签，不要用 JSON.stringify(body)：飞书对「它发过来的那段字节」
  // 签名，重新序列化会因空格/字段顺序/转义差异导致签名永不匹配。
  if (!hub.feishu.verifySignature({
    timestamp,
    nonce,
    body: ctx.rawBody ?? body,
    token: cfg.feishu.verificationToken,
    signature: sig,
    encryptKey: cfg.feishu.encryptKey,
  })) {
    return ctx.error('飞书验签失败', 401);
  }
  const result = await handleFeishuCallback(body);
  return ctx.json(result ?? { ok: true });
});

// 飞书回调的共用业务链：HTTP webhook（验签后）与长连接（WS 帧）都走这里。
// 卡片动作返回 toast 对象（长连接回写进响应帧，飞书端按钮上直接弹提示）；
// 消息事件返回 null（无须 toast）。适配器抛错（比如空文本）不往上抛：
// HTTP 返回 200+ok:false（比 400 好，免得飞书对不可解析的消息无限重投），
// 长连接侧拿到对象也不会触发 code=500 的服务端重投。
async function handleFeishuCallback(body) {
  try {
    const env = hub.webhooks.feishu(body);
    // 卡片动作 → 直接当决策处理
    if (env.type === 'feishu.card_action') {
      const action = String(env.payload.action || '').replace('approval:', '');
      const res = await hub.approvals.decide(env.payload.value?.approval_id, {
        decision: action, note: '（飞书卡片）', by: env.payload.operator || 'feishu',
      });
      if (res.ok) {
        const label = action === 'agree' ? '已批红' : action === 'reject' ? '已驳回' : '已转改派';
        return { ok: true, toast: { type: 'info', content: `${label}：${res.approval?.title || ''}` } };
      }
      return { ok: false, toast: { type: 'error', content: `操作失败：${res.error || '未知原因'}` } };
    }
    await hub.ingestAsync(env, 'feishu');
    return null;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 飞书长连接：enabled 且配了 appId/appSecret 就启动。事件与卡片回调从
// 出站 WSS 推下来，不需要公网地址 —— 这条链路彻底绕开了 webhook 回调
// 对证书/域名的死结。secret 缺失属于配置错误，启动时就报清楚。
let feishuWs = null;
function startFeishuWS() {
  if (!cfg.feishu?.enabled || !cfg.feishu?.appId || !cfg.feishu?.appSecret) return;
  import('./m1/feishu-ws.mjs').then(({ FeishuWSClient }) => {
    feishuWs = new FeishuWSClient({
      appId: cfg.feishu.appId,
      appSecret: cfg.feishu.appSecret,
      domain: cfg.feishu.domain,
      logger: hub.log,
      onEvent: (body) => handleFeishuCallback(body),
    });
    hub.feishuWs = feishuWs;
    feishuWs.start().catch((err) => hub.log.error(`飞书长连接启动失败：${err.message}`));
  }).catch((err) => hub.log.error(`飞书长连接模块加载失败：${err.message}`));
}
startFeishuWS();

/* ────────────────────────── 兜底 ────────────────────────── */

router.get('/favicon.ico', (ctx) => {
  ctx.res.writeHead(204);
  ctx.res.end();
});

router.add('*', '*', (ctx) => {
  if (ctx.path.startsWith('/api/')) return ctx.error(`未知接口：${ctx.method} ${ctx.path}`, 404);
  ctx.text('Not found', 404);
});

/* ────────────────────────── 服务器 ────────────────────────── */

const server = http.createServer(async (req, res) => {
  const ctx = createCtx(req, res);
  const found = router.match(req.method, ctx.path);

  // 中间件：读 body
  try {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      ctx.rawBody = await readBody(req);
      ctx.body = parseBody(ctx.rawBody, req.headers['content-type']);
    }
  } catch (err) {
    return ctx.error(err.message, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
  }

  if (!found) {
    if (ctx.path.startsWith('/api/')) return ctx.error('接口不存在', 404);
    return ctx.text('Not found', 404);
  }

  ctx.params = found.params;
  try {
    await found.route.handler(ctx);
  } catch (err) {
    hub.log.error('请求处理失败', { path: ctx.path, error: err.message, stack: err.stack?.split('\n').slice(0, 4) });
    if (!ctx.sent) ctx.error(err.message || '内部错误', 500);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(cfg.hub.port, cfg.hub.host, () => {
  hub.start();
  // 启动横幅里的节点命令必须按「这台机器实际装了哪些引擎」生成。
  // 写死 codex,mock 会让人照抄一条漏掉 claude-code 的命令，
  // 于是所有派给 claude-code 的任务静默饥饿（要靠饥饿告警才能发现）。
  const installed = hub.snapshot().hub.engines.filter((e) => e.available).map((e) => e.id);
  const engineHint = installed.length ? installed.join(',') : 'mock';
  hub.log.info('HTTP 服务已监听', {
    url: `http://${cfg.hub.host}:${cfg.hub.port}`,
    rules: cfg.paths.rules,
    feishu: hub.feishu.enabled ? 'on' : 'off',
    engines: engineHint,
  });
  console.log(`
┌────────────────────────────────────────────────────────────┐
│  本地自动化 Agent 体系中台                                  │
│  面板：http://${cfg.hub.host}:${cfg.hub.port}                         │
│  规则：${cfg.rulesPath}  （${hub.rules.size} 条，改文件即热重载）      │
│  节点：node src/m3/worker.mjs --node win-a --engines ${engineHint}
└────────────────────────────────────────────────────────────┘
`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  hub.log.info('收到退出信号，开始优雅关闭', { signal });
  try { hub.feishuWs?.stop(); } catch { /* 关闭时不再计较 */ }
  server.close(() => {
    hub.stop();
    hub.ledger.close();
    process.exit(0);
  });
  setTimeout(() => { try { hub.stop(); process.exit(0); } catch { process.exit(0); } }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  hub.log.error('未处理的 Promise 拒绝', { error: String(err?.message || err) });
});
process.on('uncaughtException', (err) => {
  hub.log.error('未捕获异常', { error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
});

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function fallbackPage() {
  return `<!doctype html><meta charset="utf-8"><title>面板文件缺失</title>
  <body style="font-family:system-ui;padding:40px;background:#0f172a;color:#e2e8f0">
  <h1>面板前端文件缺失</h1>
  <p>请确认 <code>src/web/public/index.html</code> 存在。API 仍可用：<code>/api/health</code></p>
  </body>`;
}
