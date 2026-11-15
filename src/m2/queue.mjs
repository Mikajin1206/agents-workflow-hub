import { nowIso, addSeconds } from '../lib/config.mjs';
import { newLeaseId, newRunId } from '../lib/ids.mjs';
import { parseTask } from './events.mjs';

/**
 * 任务队列与长轮询派活（方案 §5.2 步骤 4-6）。
 *
 * 关键约定：节点永远主动 —— 中台不主动连接内网节点，节点挂起等待，
 * 最长等 leaseWaitSeconds（默认 50 秒），有活立刻接走。
 */
export class TaskQueue {
  constructor({ ledger, log, config, notifier }) {
    this.ledger = ledger;
    this.log = log;
    this.config = config;
    this.notifier = notifier;
    this.waiters = new Map(); // node -> [resolve, ...]
    this.timers = new Set(); // 长轮询挂起中的定时器
    this.nodeSeen = new Map(); // nodeId -> { id, engines, lastSeenMs }（饥饿检测要用）
    this.sweeper = null;
  }

  start() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.#sweep().catch((e) => this.log.error('sweep 失败', { e: e.message })), 5000);
    this.sweeper.unref?.();
  }

  /** 立刻跑一次巡检（测试与 CLI 用；生产走 5 秒定时器） */
  async sweepNow() {
    await this.#sweep();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const [, list] of this.waiters) for (const fn of list) fn(null);
    this.waiters.clear();
  }

  /** 节点发起长轮询。nodeId 定向 + any 兜底。 */
  async poll({ nodeId, engines = [], capabilities = [], waitSeconds }) {
    this.noteNode({ id: nodeId, engines });
    const deadline = Date.now() + (waitSeconds ?? this.config.hub.leaseWaitSeconds) * 1000;
    // 先立即尝试一次
    let task = this.leaseNext({ nodeId, engines });
    if (task) return task;

    while (Date.now() < deadline) {
      const remaining = Math.max(50, deadline - Date.now());
      const got = await this.#wait(nodeId, remaining);
      if (got) {
        task = this.leaseNext({ nodeId, engines });
        if (task) return task;
      }
      task = this.leaseNext({ nodeId, engines });
      if (task) return task;
    }
    return null;
  }

  #wait(nodeId, ms) {
    return new Promise((resolve) => {
      const list = this.waiters.get(nodeId) || [];
      let done = false;
      const timer = setTimeout(() => finish(null), ms);
      // 不 unref：长轮询在等，进程就该活着（stop() 会清掉这些定时器）
      this.timers.add(timer);
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.timers.delete(timer);
        const idx = list.indexOf(finish);
        if (idx >= 0) list.splice(idx, 1);
        if (!list.length) this.waiters.delete(nodeId);
        resolve(v);
      };
      list.push(finish);
      this.waiters.set(nodeId, list);
    });
  }

  /** 有新任务入队时唤醒所有挂起的节点（含 any） */
  wakeAll() {
    const fns = [];
    for (const [, list] of this.waiters) fns.push(...list);
    for (const fn of fns) {
      try { fn(true); } catch { /* ignore */ }
    }
  }

  /**
   * 记一笔「这个节点此刻在线、能跑这些引擎」。
   * 每次 poll 与 heartbeat 都会刷新，饥饿检测据此判断有没有节点能干这活。
   */
  noteNode({ id, engines }) {
    if (!id) return;
    const prev = this.nodeSeen.get(id);
    this.nodeSeen.set(id, {
      id,
      engines: Array.isArray(engines) && engines.length ? [...engines] : (prev?.engines || []),
      lastSeenMs: Date.now(),
    });
  }

  /**
   * 在线节点能力表。超过 offlineAfterMs（默认 90 秒）没露面的节点算离线 ——
   * 长轮询窗口是 50 秒，连续两轮没来基本就是进程没了。
   */
  getNodeCapabilities(offlineAfterMs = 90_000) {
    const now = Date.now();
    const out = [];
    for (const [id, rec] of this.nodeSeen) {
      if (now - rec.lastSeenMs > offlineAfterMs) continue;
      out.push({ id, engines: rec.engines || [], last_seen_ms: rec.lastSeenMs });
    }
    return out;
  }

  /** 所有见过的节点（含已离线的），用于面板展示「谁在线上」 */
  listNodes(offlineAfterMs = 90_000) {
    const now = Date.now();
    return [...this.nodeSeen.values()].map((r) => ({
      id: r.id,
      engines: r.engines || [],
      online: now - r.lastSeenMs <= offlineAfterMs,
      idle_seconds: Math.round((now - r.lastSeenMs) / 1000),
    }));
  }

  #eligibleNodeClause({ nodeId, engines }) {
    // node 定向：task.node = nodeId 或 'any'
    const clauses = ['(node = ? OR node = \'any\')'];
    const params = [nodeId];
    if (engines?.length) {
      clauses.push(`engine IN (${engines.map(() => '?').join(',')})`);
      params.push(...engines);
    }
    return { clause: clauses.join(' AND '), params };
  }

  /**
   * 原子取一个可执行任务并加租约。
   * 优先 P0>P1>P2>P3，其次 created_at。
   */
  leaseNext(opts) {
    const now = nowIso();
    const { clause, params } = this.#eligibleNodeClause(opts);
    const sql = `
      SELECT * FROM tasks
      WHERE status = 'queued' AND available_at <= ? AND ${clause}
      ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
               available_at ASC
      LIMIT 1`;
    return this.ledger.tx(() => {
      const row = this.ledger.get(sql, now, ...params);
      if (!row) return null;
      // 并发上限：同一 rule 的 max_parallel
      let meta = {};
      try { meta = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }
      const maxParallel = meta?.limits?.max_parallel;
      if (Number.isFinite(maxParallel) && maxParallel > 0) {
        const running = this.ledger.get(
          `SELECT COUNT(*) c FROM tasks WHERE rule_id=? AND status IN ('leased','running') AND task_id<>?`,
          row.rule_id, row.task_id,
        );
        if (running.c >= maxParallel) {
          // 顺延 5 秒，让别的任务先走
          this.ledger.run(`UPDATE tasks SET available_at=? WHERE task_id=?`, addSeconds(now, 5), row.task_id);
          return null;
        }
      }
      const leaseExpires = addSeconds(now, Math.max(60, (meta?.limits?.timeout_seconds ?? 900)));
      const leaseId = newLeaseId();
      this.ledger.run(
        `UPDATE tasks SET status='leased', lease_owner=?, leased_at=?, lease_expires_at=?, started_at=COALESCE(started_at,?)
         WHERE task_id=? AND status='queued'`,
        opts.nodeId, now, leaseExpires, now, row.task_id,
      );
      this.ledger.run(
        `INSERT INTO runs(run_id,task_id,node,engine,kind,status,started_at,meta) VALUES(?,?,?,?,?,?,?,?)`,
        leaseId, row.task_id, opts.nodeId, row.engine, 'm3', 'leased', now, JSON.stringify({ lease_id: leaseId }),
      );
      this.ledger.audit({
        entity: 'task', entityId: row.task_id, fromStatus: 'queued', toStatus: 'leased', actor: 'm2',
        detail: { node: opts.nodeId, lease_id: leaseId, lease_expires_at: leaseExpires },
      });
      return { ...parseTask({ ...row, status: 'leased', lease_owner: opts.nodeId }), lease_id: leaseId, lease_expires_at: leaseExpires };
    });
  }

  /** 节点确认已开始执行 */
  markRunning(taskId, nodeId) {
    const now = nowIso();
    const prev = this.ledger.get('SELECT status, node FROM tasks WHERE task_id=?', taskId);
    if (!prev) return false;
    this.ledger.run(`UPDATE tasks SET status='running', lease_owner=? WHERE task_id=?`, nodeId, taskId);
    this.ledger.run(`UPDATE runs SET status='running' WHERE task_id=? AND status='leased'`, taskId);
    this.ledger.audit({
      entity: 'task', entityId: taskId, fromStatus: prev.status, toStatus: 'running', actor: nodeId,
    });
    return true;
  }

  /** 心跳续租。过期未续租的任务由 sweeper 回收。 */
  heartbeat(taskId, nodeId, extendSeconds = 120) {
    this.noteNode({ id: nodeId });
    const now = nowIso();
    const res = this.ledger.run(
      `UPDATE tasks SET lease_expires_at=? WHERE task_id=? AND lease_owner=? AND status IN ('leased','running')`,
      addSeconds(now, extendSeconds), taskId, nodeId,
    );
    return res.changes > 0;
  }

  /** 任务完成回写（方案 §5.2 步骤 6-7） */
  complete(taskId, nodeId, result) {
    const now = nowIso();
    const row = this.ledger.get('SELECT * FROM tasks WHERE task_id=?', taskId);
    if (!row) return null;
    const status = result?.ok === false ? 'failed' : 'completed';
    return this.ledger.tx(() => {
      this.ledger.run(
        `UPDATE tasks SET status=?, result=?, error=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL WHERE task_id=?`,
        status, JSON.stringify(result ?? {}), result?.error || null, now, taskId,
      );
      this.ledger.run(
        `UPDATE runs SET status=?, exit_code=?, finished_at=?, log_path=? WHERE task_id=? AND status IN ('leased','running')`,
        status === 'completed' ? 'completed' : 'failed', result?.exit_code ?? null, now, result?.log_path || null, taskId,
      );
      this.ledger.audit({
        entity: 'task', entityId: taskId, fromStatus: row.status, toStatus: status, actor: nodeId,
        detail: { ok: result?.ok !== false, error: result?.error || null },
      });
      return parseTask({ ...row, status, result: JSON.stringify(result ?? {}), error: result?.error || null, finished_at: now });
    });
  }

  /**
   * 失败重试：未超上限 → 回到 queued 并延迟重试；超上限 → dead_letter。
   */
  fail(taskId, nodeId, error, { retryable = true } = {}) {
    const now = nowIso();
    const row = this.ledger.get('SELECT * FROM tasks WHERE task_id=?', taskId);
    if (!row) return null;
    return this.ledger.tx(() => {
      const attempts = row.attempts + 1;
      const backoff = this.config.limits.retryBackoffSeconds * attempts;
      const canRetry = retryable && attempts < row.max_attempts;
      const status = canRetry ? 'queued' : 'dead_letter';
      this.ledger.run(
        `UPDATE tasks SET status=?, attempts=?, error=?, next_retry_at=?, available_at=?, lease_owner=NULL, lease_expires_at=NULL,
          finished_at=? WHERE task_id=?`,
        status, attempts, String(error || '未知错误'), canRetry ? addSeconds(now, backoff) : null,
        canRetry ? addSeconds(now, backoff) : now, canRetry ? null : now, taskId,
      );
      this.ledger.run(
        `UPDATE runs SET status='failed', finished_at=? WHERE task_id=? AND status IN ('leased','running')`,
        now, taskId,
      );
      this.ledger.audit({
        entity: 'task', entityId: taskId, fromStatus: row.status, toStatus: status, actor: nodeId || 'm2',
        detail: { attempts, max_attempts: row.max_attempts, error: String(error || ''), retry: canRetry },
      });
      return { status, attempts, retry: canRetry, backoff };
    });
  }

  /** 周期性清理：租约过期回收 + 死信通知 + 审批超时提醒 */
  async #sweep() {
    const now = nowIso();
    const stale = this.ledger.all(
      `SELECT task_id, lease_owner FROM tasks WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      now,
    );
    for (const t of stale) {
      this.log.warn('租约过期，回收任务', { task: t.task_id, node: t.lease_owner });
      this.fail(t.task_id, t.lease_owner, '节点租约过期（节点可能已离线）', { retryable: true });
    }

    // 新产生的死信 → P1 通知（只推一次）
    const dead = this.ledger.all(`SELECT * FROM tasks WHERE status='dead_letter' AND finished_at IS NOT NULL`);
    for (const row of dead) {
      const meta = safeParse(row.meta) || {};
      if (meta.dead_letter_notified) continue;
      meta.dead_letter_notified = true;
      this.ledger.run(`UPDATE tasks SET meta=? WHERE task_id=?`, JSON.stringify(meta), row.task_id);
      await this.notifier?.notify({
        level: 'P1',
        kind: 'dead_letter',
        title: '任务重试失败，进入死信',
        body: `任务 ${row.title || row.task_id}（${row.engine}）连续失败 ${row.attempts} 次。\n最后错误：${row.error || '未知'}`,
        ref: { task_id: row.task_id, event_id: row.event_id },
      });
    }

    await this.#sweepStarved(now);
  }

  /**
   * 饥饿检测：任务排着队，但没有任何在线节点能执行它。
   *
   * 这个坑是真实撞出来的：一个任务被指定「node=mac-b, engine=codex」，
   * 而 mac-b 只声明了 mock —— 任务就永远停在 queued，谁都不接、谁都不报，
   * 面板上看着像「还没轮到」，实际上已经死锁。方案 §M5 要求「一切留痕、
   * 不静默丢」，所以这种情况必须主动告警，而不是等人偶然发现。
   *
   * 判定口径：queued 超过 starvedSeconds（默认 180s，可配），
   * 且没有「在线节点 ∩ 任务可选节点 ∩ 任务引擎」的组合。
   * 「在线」以最近一次 poll/heartbeat 为准（心跳表由 index.mjs 维护）。
   */
  async #sweepStarved(now) {
    const threshold = Number(this.config?.limits?.starvedSeconds ?? 180);
    const cutoff = addSeconds(now, -threshold);
    const stuck = this.ledger.all(
      `SELECT * FROM tasks WHERE status='queued' AND created_at <= ?`,
      cutoff,
    );
    if (!stuck.length) return;

    // 在线节点能力表（可能为空：还没节点轮询过）
    const online = this.getNodeCapabilities ? this.getNodeCapabilities() : [];
    for (const row of stuck) {
      const meta = safeParse(row.meta) || {};
      if (meta.starved_notified) continue;

      const nodeMatches = (n) => row.node === 'any' || row.node === n.id;
      const engineMatches = (n) => (n.engines || []).includes(row.engine);
      const capable = online.filter((n) => nodeMatches(n) && engineMatches(n));

      if (capable.length) continue; // 有节点能干，只是没轮到，正常排队

      // 区分两种「没人干」：压根没节点在线 vs 有节点但能力不匹配
      const onlineAny = online.filter(nodeMatches);
      const reason = onlineAny.length === 0
        ? `节点 ${row.node === 'any' ? '（任意）' : row.node} 当前没有在线`
        : `节点 ${onlineAny.map((n) => n.id).join('/')} 在线，但都不支持引擎 ${row.engine}（它们声明的是 ${onlineAny.map((n) => (n.engines || []).join('+')).join('、')}）`;

      meta.starved_notified = true;
      meta.starved_seen_at = now;
      this.ledger.run(`UPDATE tasks SET meta=? WHERE task_id=?`, JSON.stringify(meta), row.task_id);
      this.log.warn('任务饥饿：没有能执行它的节点', { task: row.task_id, node: row.node, engine: row.engine });

      await this.notifier?.notify({
        level: 'P1',
        kind: 'starved',
        title: '有任务没人接：找不到能执行它的节点',
        body: [
          `任务 ${row.title || row.task_id}`,
          `要求：节点 ${row.node === 'any' ? '（任意）' : row.node} · 引擎 ${row.engine}`,
          `已等待：超过 ${threshold} 秒，状态仍是 queued`,
          `原因：${reason}`,
          '',
          '处理方式：',
          '· 起一个支持该引擎的节点（改 start-worker 的 NODE_ENGINES）',
          '· 或改派：在面板「派活」里指定一个在线节点支持的引擎',
          '· 或忽略：这台先不做',
        ].join('\n'),
        ref: { task_id: row.task_id, event_id: row.event_id },
      });
    }
  }

  pendingCount() {
    const row = this.ledger.get(`SELECT COUNT(*) c FROM tasks WHERE status IN ('queued','leased','running')`);
    return row?.c ?? 0;
  }

  /** 统计：用于战报 */
  statsSince(sinceIso) {
    const q = (sql, ...p) => this.ledger.get(sql, ...p)?.c ?? 0;
    return {
      since: sinceIso,
      total_events: q(`SELECT COUNT(*) c FROM events WHERE created_at >= ? AND status <> 'duplicate'`, sinceIso),
      duplicates: q(`SELECT COUNT(*) c FROM events WHERE created_at >= ? AND status = 'duplicate'`, sinceIso),
      completed: q(`SELECT COUNT(*) c FROM tasks WHERE finished_at >= ? AND status = 'completed'`, sinceIso),
      failed: q(`SELECT COUNT(*) c FROM tasks WHERE finished_at >= ? AND status = 'failed'`, sinceIso),
      dead_letter: q(`SELECT COUNT(*) c FROM tasks WHERE status = 'dead_letter' AND finished_at >= ?`, sinceIso),
      unrouted: q(`SELECT COUNT(*) c FROM events WHERE created_at >= ? AND status='unrouted'`, sinceIso),
      awaiting_approval: q(`SELECT COUNT(*) c FROM approvals WHERE status='pending'`),
      approved: q(`SELECT COUNT(*) c FROM approvals WHERE decided_at >= ? AND status IN ('approved','executed')`, sinceIso),
      rejected: q(`SELECT COUNT(*) c FROM approvals WHERE decided_at >= ? AND status='rejected'`, sinceIso),
      silent: q(`SELECT COUNT(*) c FROM tasks WHERE finished_at >= ? AND status='completed'`, sinceIso),
    };
  }
}

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
