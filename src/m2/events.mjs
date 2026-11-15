import { nowIso, addSeconds } from '../lib/config.mjs';
import { makeEnvelope, validateEnvelope, summarize } from '../lib/envelope.mjs';
import { newEventId, newTaskId } from '../lib/ids.mjs';

/**
 * M2 事件处理链（方案 §5.2）：
 * 接收入库 → 去重 → 规则匹配 → 约束检查 → 入队派活 → 结果回写 → 通知决策 → 记账
 */

export const EVENT_STATUS = {
  RECEIVED: 'received',
  DUPLICATE: 'duplicate',
  ROUTED: 'routed',
  UNROUTED: 'unrouted',
  AWAITING_APPROVAL: 'awaiting_approval',
  RUNNING: 'running',
  DECIDING: 'deciding',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REJECTED: 'rejected',
  DEAD_LETTER: 'dead_letter',
};

export class EventService {
  constructor({ ledger, rules, log, config }) {
    this.ledger = ledger;
    this.rules = rules;
    this.log = log;
    this.config = config;
    this.onQueued = () => {};
    /** action:'notify' 的规则不派活，直接推到人面前；由 Hub 注入实现 */
    this.onNotify = () => {};
    /** 规则 approval:'always'：任务停在 awaiting_approval，票拟单由 Hub 注入这里建出来 */
    this.onApprovalRequired = () => {};
  }

  /** 入口统一调用：接收原始信封 → 入库、去重、路由，返回处理结果
   *  opts.noRoute = true 时跳过规则匹配（面板/CLI 手填引擎的场景，由调用方自行建任务）
   */
  ingest(input, actor = 'm1', opts = {}) {
    const env = makeEnvelope(input);
    const errors = validateEnvelope(env);
    if (errors.length) {
      this.ledger.audit({
        entity: 'event', entityId: '-', toStatus: 'rejected', actor,
        detail: { errors, envelope: env },
      });
      const err = new Error(`信封校验失败：${errors.join('；')}`);
      err.code = 'INVALID_ENVELOPE';
      throw err;
    }

    return this.ledger.tx(() => this.#ingestTx(env, actor, opts));
  }

  /**
   * 带异步收尾的入口：action:'notify' 的规则要在事务提交后才推人。
   * @returns {Promise<object>} 同 ingest 的返回结构（去掉内部的 pending）
   */
  async ingestAsync(input, actor, opts = {}) {
    const res = this.ingest(input, actor, opts);
    if (res?.pending?.length) {
      await Promise.allSettled(res.pending);
      const { pending, ...rest } = res;
      return rest;
    }
    return res;
  }

  #ingestTx(env, actor, opts = {}) {
    const now = nowIso();
    const dup = this.#findDuplicate(env, now);
    if (dup) {
      this.ledger.run(
        `UPDATE events SET updated_at=?, payload=? WHERE event_id=?`,
        now, JSON.stringify(mergePayload(dup.payload, env.payload)), dup.event_id,
      );
      // 新事件也入库留痕，但标记为重复，不产生新任务
      const dupId = newEventId();
      this.ledger.run(
        `INSERT INTO events(event_id,source,type,target,summary,link,dedupe_key,priority,status,rule_id,payload,created_at,updated_at,duplicate_of)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        dupId, env.source, env.type, env.target, env.summary, env.link, env.dedupe_key,
        env.priority, EVENT_STATUS.DUPLICATE, dup.rule_id, JSON.stringify(env.payload), env.created_at, now, dup.event_id,
      );
      this.ledger.audit({
        entity: 'event', entityId: dupId, fromStatus: null, toStatus: EVENT_STATUS.DUPLICATE,
        actor, detail: { duplicate_of: dup.event_id, dedupe_key: env.dedupe_key },
      });
      this.log.info('事件重复，仅更新台账', { event: dupId, of: dup.event_id, key: env.dedupe_key });
      return { ok: true, duplicate: true, event_id: dupId, duplicate_of: dup.event_id, task: null };
    }

    const eventId = newEventId();
    this.ledger.run(
      `INSERT INTO events(event_id,source,type,target,summary,link,dedupe_key,priority,status,rule_id,payload,created_at,updated_at,duplicate_of)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      eventId, env.source, env.type, env.target, env.summary, env.link, env.dedupe_key,
      env.priority, EVENT_STATUS.RECEIVED, null, JSON.stringify(env.payload), env.created_at, now, null,
    );
    this.ledger.audit({
      entity: 'event', entityId: eventId, toStatus: EVENT_STATUS.RECEIVED, actor,
      detail: { summary: summarize(env), dedupe_key: env.dedupe_key, source: env.source },
    });

    const rule = opts.noRoute ? null : this.rules.match(env);
    if (!rule) {
      const status = EVENT_STATUS.UNROUTED;
      this.ledger.run(`UPDATE events SET status=?, updated_at=? WHERE event_id=?`, status, now, eventId);
      this.ledger.kvSet('unrouted_count', (this.ledger.kvGet('unrouted_count', 0) || 0) + 1);
      this.ledger.audit({
        entity: 'event', entityId: eventId, fromStatus: EVENT_STATUS.RECEIVED, toStatus: status,
        actor: 'm2', detail: { reason: 'rules.json 未匹配，进入待归类队列' },
      });
      this.log.warn('规则未匹配，进入待归类队列', { event: eventId, type: env.type });
      return { ok: true, duplicate: false, event_id: eventId, unrouted: true, task: null };
    }

    // action:'notify' —— 不派活，直接推人（方案里 review.stalled / release.failed 的处理方式）
    if (rule.action === 'notify') {
      const status = EVENT_STATUS.DECIDING;
      this.ledger.run(`UPDATE events SET status=?, rule_id=?, updated_at=? WHERE event_id=?`, status, rule.id, now, eventId);
      this.ledger.audit({
        entity: 'event', entityId: eventId, fromStatus: EVENT_STATUS.RECEIVED, toStatus: status,
        actor: 'm2', detail: { rule: rule.id, action: 'notify', level: rule.notifyLevel },
      });
      this.log.info('事件直接推人（不派活）', { event: eventId, rule: rule.id, level: rule.notifyLevel });
      // onNotify 是异步的（要发飞书/写通知台账）。这里只登记，由 ingest 在事务提交后 await，
      // 避免在 SQLite 事务里跑异步 IO、也避免 promise 飘在事务外面导致关闭库时炸掉。
      const pending = [];
      try {
        const p = this.onNotify({ eventId, rule, env });
        if (p && typeof p.then === 'function') pending.push(p);
      } catch (err) {
        this.log.error('推送失败', { event: eventId, error: err.message });
      }
      return { ok: true, duplicate: false, event_id: eventId, rule_id: rule.id, notified: true, status, pending };
    }

    const routed = this.#createTask(env, eventId, rule, now);
    this.ledger.run(
      `UPDATE events SET status=?, rule_id=?, updated_at=? WHERE event_id=?`,
      routed.status, rule.id, now, eventId,
    );
    this.ledger.audit({
      entity: 'event', entityId: eventId, fromStatus: EVENT_STATUS.RECEIVED, toStatus: routed.status,
      actor: 'm2', detail: { rule: rule.id, task: routed.task.task_id, node: routed.task.node, engine: routed.task.engine },
    });
    this.log.info('事件已路由', {
      event: eventId, rule: rule.id, task: routed.task.task_id,
      node: routed.task.node, engine: routed.task.engine, status: routed.status,
    });
    // 票拟创建涉及异步通知（写台账 + 推卡片），照 onNotify 的规矩放到事务提交之后，
    // 不在事务里跑异步 IO。pending 由 ingestAsync() await。
    const pending = [];
    if (routed.needsApproval) {
      try {
        const p = this.onApprovalRequired({ eventId, rule, env, task: routed.task });
        if (p && typeof p.then === 'function') pending.push(p);
      } catch (err) {
        this.log.error('为必批任务建票拟失败', { event: eventId, error: err.message });
      }
    }
    if (routed.taskStatus === 'queued') this.onQueued(routed.task);
    return { ok: true, duplicate: false, event_id: eventId, rule_id: rule.id, task: routed.task, status: routed.status, pending };
  }

  #findDuplicate(env, nowIsoStr) {
    const window = this.config.ledger.dedupeWindowSeconds;
    const since = new Date(new Date(nowIsoStr).getTime() - window * 1000).toISOString();
    const rows = this.ledger.all(
      `SELECT * FROM events
       WHERE dedupe_key=? AND created_at >= ? AND status NOT IN ('duplicate','failed','rejected')
       ORDER BY created_at DESC LIMIT 1`,
      env.dedupe_key, since,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.status === EVENT_STATUS.COMPLETED && window <= 0) return null;
    return row;
  }

  #createTask(env, eventId, rule, now) {
    const taskId = newTaskId();
    const title = env.summary || `${env.type}${env.target ? ' · ' + env.target : ''}`;
    const workdir = rule.route.workdir || this.config.paths.root;
    const needsApproval = rule.approval === 'always' || Boolean(env.payload?.approval_required);
    // 注意：任务状态与事件状态是两套值域，不能混用。
    // 任务只有 queued/leased/running/completed/failed/dead_letter/awaiting_approval/rejected，
    // queue.leaseNext() 只认 'queued'——早先误用 EVENT_STATUS.ROUTED（'routed'）导致
    // 规则派出的任务永远接不走，只有 adhoc 任务能跑。
    const taskStatus = needsApproval ? 'awaiting_approval' : 'queued';
    const eventStatus = needsApproval ? EVENT_STATUS.AWAITING_APPROVAL : EVENT_STATUS.ROUTED;
    const concurrencyKey = env.dedupe_key;

    const conflicts = this.#concurrencyConflicts(rule, concurrencyKey);
    const availableAt = conflicts > 0 ? addSeconds(now, Math.max(1, conflicts * 2)) : now;

    this.ledger.run(
      `INSERT INTO tasks(task_id,event_id,rule_id,title,node,engine,model,skill,prompt,status,priority,attempts,max_attempts,
        concurrency_key,approval_id,workdir,created_at,available_at,meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      taskId, eventId, rule.id, title,
      rule.route.node || 'any', rule.route.engine || 'claude-code', rule.route.model || null,
      rule.skill || null, rule.prompt || '', taskStatus, env.priority,
      0, Math.max(1, (rule.limits?.attempts ?? 2) + 1),
      concurrencyKey, null, workdir, now, availableAt,
      JSON.stringify({
        rule_id: rule.id,
        silent: rule.silent !== false,
        limits: rule.limits,
        envelope: { source: env.source, type: env.type, target: env.target, link: env.link, priority: env.priority },
        payload: env.payload,
      }),
    );

    this.ledger.audit({
      entity: 'task', entityId: taskId, toStatus: taskStatus, actor: 'm2',
      detail: { rule: rule.id, node: rule.route.node, engine: rule.route.engine, skill: rule.skill },
    });

    return {
      status: eventStatus,
      taskStatus,
      task: {
        task_id: taskId, event_id: eventId, rule_id: rule.id, title, node: rule.route.node,
        engine: rule.route.engine, model: rule.route.model, skill: rule.skill,
        prompt: rule.prompt, status: taskStatus, priority: env.priority, workdir,
      },
      needsApproval,
    };
  }

  #concurrencyConflicts(rule, concurrencyKey) {
    const perKey = rule.limits?.per_key ?? 1;
    if (perKey > 0) {
      const active = this.ledger.get(
        `SELECT COUNT(*) c FROM tasks WHERE concurrency_key=? AND status IN ('queued','leased','running','awaiting_approval')`,
        concurrencyKey,
      );
      if (active.c >= perKey) return active.c;
    }
    const maxParallel = rule.limits?.max_parallel;
    if (Number.isFinite(maxParallel) && maxParallel > 0) {
      const running = this.ledger.get(
        `SELECT COUNT(*) c FROM tasks WHERE rule_id=? AND status IN ('leased','running')`, rule.id,
      );
      if (running.c >= maxParallel) return running.c;
    }
    return 0;
  }

  /** 结果回写后由 hub 调用：推进事件状态 */
  updateEventStatus(eventId, status, detail) {
    const now = nowIso();
    const prev = this.ledger.get('SELECT status FROM events WHERE event_id=?', eventId);
    this.ledger.run('UPDATE events SET status=?, updated_at=? WHERE event_id=?', status, now, eventId);
    this.ledger.audit({
      entity: 'event', entityId: eventId, fromStatus: prev?.status, toStatus: status, actor: 'm2', detail,
    });
  }

  getEvent(eventId) {
    const row = this.ledger.get('SELECT * FROM events WHERE event_id=?', eventId);
    return row ? parseEvent(row) : null;
  }

  listEvents({ status, limit = 50, offset = 0, source, type } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status=?'); params.push(status); }
    if (source) { where.push('source=?'); params.push(source); }
    if (type) { where.push('type=?'); params.push(type); }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    return this.ledger.all(sql, ...params, limit, offset).map(parseEvent);
  }

  /** 一次事件的全链路轨迹（人回溯用） */
  trace(eventId) {
    const event = this.getEvent(eventId);
    if (!event) return null;
    const tasks = this.ledger.all('SELECT * FROM tasks WHERE event_id=?', eventId).map(parseTask);
    const audits = this.ledger.all(
      `SELECT * FROM event_audit WHERE (entity='event' AND entity_id=?)
         OR (entity='task' AND entity_id IN (SELECT task_id FROM tasks WHERE event_id=?))
         OR (entity='approval' AND entity_id IN (SELECT approval_id FROM approvals WHERE event_id=?))
       ORDER BY audit_id`, eventId, eventId, eventId,
    );
    const runs = this.ledger.all(
      `SELECT * FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE event_id=?)`, eventId,
    );
    const approvals = this.ledger.all('SELECT * FROM approvals WHERE event_id=?', eventId).map(parseApproval);
    return { event, tasks, approvals, runs, audit: audits };
  }
}

function mergePayload(oldRaw, payload) {
  let old = {};
  try { old = JSON.parse(oldRaw || '{}'); } catch { /* ignore */ }
  const merged = { ...old, ...payload };
  const notes = [];
  if (Array.isArray(old.notes)) notes.push(...old.notes);
  if (payload?.note) notes.push({ at: nowIso(), note: payload.note });
  if (notes.length) merged.notes = notes;
  return JSON.stringify(merged);
}

export function parseEvent(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { /* ignore */ }
  return {
    event_id: row.event_id,
    source: row.source,
    type: row.type,
    target: row.target,
    summary: row.summary,
    link: row.link,
    dedupe_key: row.dedupe_key,
    priority: row.priority,
    status: row.status,
    rule_id: row.rule_id,
    payload,
    created_at: row.created_at,
    updated_at: row.updated_at,
    duplicate_of: row.duplicate_of,
  };
}

export function parseTask(row) {
  if (!row) return null;
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { /* ignore */ }
  return {
    task_id: row.task_id,
    event_id: row.event_id,
    rule_id: row.rule_id,
    title: row.title,
    node: row.node,
    engine: row.engine,
    model: row.model,
    skill: row.skill,
    prompt: row.prompt,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    concurrency_key: row.concurrency_key,
    approval_id: row.approval_id,
    workdir: row.workdir,
    created_at: row.created_at,
    available_at: row.available_at,
    leased_at: row.leased_at,
    lease_expires_at: row.lease_expires_at,
    lease_owner: row.lease_owner,
    started_at: row.started_at,
    finished_at: row.finished_at,
    result,
    error: row.error,
    next_retry_at: row.next_retry_at,
    meta,
  };
}

export function parseApproval(row) {
  if (!row) return null;
  return {
    approval_id: row.approval_id,
    event_id: row.event_id,
    task_id: row.task_id,
    category: row.category,
    title: row.title,
    question: row.question,
    proposal: row.proposal,
    options: safeJson(row.options, ['agree', 'reject', 'revise']),
    status: row.status,
    revision: row.revision,
    requested_by: row.requested_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    due_at: row.due_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    decision_note: row.decision_note,
    reminded_at: row.reminded_at,
    channel: row.channel,
    card_ref: row.card_ref,
    meta: safeJson(row.meta, {}),
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
