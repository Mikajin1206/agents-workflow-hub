import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from './config.mjs';

/**
 * M2 台账库 + M6 事件台账（同一 SQLite 文件）。
 * 铁律「一切留痕」：所有状态迁移都写 event_audit。
 */
const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  type          TEXT NOT NULL,
  target        TEXT,
  summary       TEXT,
  link          TEXT,
  dedupe_key    TEXT,
  priority      TEXT NOT NULL DEFAULT 'P2',
  status        TEXT NOT NULL,
  rule_id       TEXT,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  duplicate_of  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events(dedupe_key, created_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  rule_id        TEXT,
  title          TEXT,
  node           TEXT NOT NULL,
  engine         TEXT NOT NULL,
  model          TEXT,
  skill          TEXT,
  prompt         TEXT,
  status         TEXT NOT NULL,
  priority       TEXT NOT NULL DEFAULT 'P2',
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  concurrency_key TEXT,
  approval_id    TEXT,
  workdir        TEXT,
  created_at     TEXT NOT NULL,
  available_at   TEXT NOT NULL,
  leased_at      TEXT,
  lease_expires_at TEXT,
  lease_owner    TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  result         TEXT,
  error          TEXT,
  next_retry_at  TEXT,
  meta           TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, available_at);
CREATE INDEX IF NOT EXISTS idx_tasks_node ON tasks(node, status);
CREATE INDEX IF NOT EXISTS idx_tasks_event ON tasks(event_id);
CREATE INDEX IF NOT EXISTS idx_tasks_concurrency ON tasks(concurrency_key, status);

CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  node        TEXT,
  engine      TEXT,
  kind        TEXT NOT NULL DEFAULT 'm3',
  status      TEXT NOT NULL,
  exit_code   INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  log_path    TEXT,
  meta        TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id    TEXT PRIMARY KEY,
  event_id       TEXT,
  task_id        TEXT,
  category       TEXT NOT NULL,
  title          TEXT NOT NULL,
  question       TEXT NOT NULL,
  proposal       TEXT,
  options        TEXT,
  status         TEXT NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 1,
  requested_by   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  due_at         TEXT,
  decided_at     TEXT,
  decided_by     TEXT,
  decision_note  TEXT,
  reminded_at    TEXT,
  channel        TEXT,
  card_ref       TEXT,
  meta           TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, due_at);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  level          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  title          TEXT,
  body           TEXT,
  target         TEXT,
  channel        TEXT,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  sent_at        TEXT,
  error          TEXT,
  ref            TEXT,
  meta           TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id      TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  text             TEXT NOT NULL,
  quote            TEXT,
  decided_by       TEXT NOT NULL,
  decided_at       TEXT NOT NULL,
  source_approval  TEXT,
  source_task      TEXT,
  tags             TEXT,
  active           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_decisions_kind ON decisions(kind, active);

CREATE TABLE IF NOT EXISTS reports (
  report_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT,
  path       TEXT,
  task_id    TEXT,
  event_id   TEXT,
  created_at TEXT NOT NULL,
  meta       TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT NOT NULL,
  task_id     TEXT,
  repo        TEXT,
  pr_number   INTEGER,
  pr_url      TEXT,
  commit_sha  TEXT,
  step        TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  attempt     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_pr ON pipeline_runs(repo, pr_number);

CREATE TABLE IF NOT EXISTS event_audit (
  audit_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  from_status TEXT,
  to_status  TEXT,
  actor      TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON event_audit(entity, entity_id, audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON event_audit(ts);
`;

export class Ledger {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(DDL);
    this.#migrate();
    this.stmts = new Map();
  }

  #migrate() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    if (!row) {
      this.db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
    } else if (Number(row.value) < SCHEMA_VERSION) {
      this.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
    }
    // v1→v2：pipeline_runs 原来按 pipeline_id 做 PK，导致同一次运行只能记一行；
    // 改为自增 seq 主键（一个 pipeline 有五步多条记录）。老库直接重建该表。
    const cols = this.db.prepare('PRAGMA table_info(pipeline_runs)').all();
    if (cols.length && !cols.some((c) => c.name === 'seq')) {
      this.db.exec('DROP TABLE pipeline_runs;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS pipeline_runs (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id TEXT NOT NULL,
        task_id     TEXT,
        repo        TEXT,
        pr_number   INTEGER,
        pr_url      TEXT,
        commit_sha  TEXT,
        step        TEXT NOT NULL,
        step_index  INTEGER NOT NULL,
        attempt     INTEGER NOT NULL DEFAULT 1,
        status      TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        detail      TEXT
      );`);
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_pr ON pipeline_runs(repo, pr_number);');
      this.log?.warn?.('台账已迁移：pipeline_runs 改自增主键');
    }
    // v2→v3：notifications 加 meta 列，用来存 dedupe_ref。
    // 没有这一列，「同一件事只提醒一次」就无从判断，任务重试会把人反复吵醒。
    const ncols = this.db.prepare('PRAGMA table_info(notifications)').all();
    if (ncols.length && !ncols.some((c) => c.name === 'meta')) {
      this.db.exec('ALTER TABLE notifications ADD COLUMN meta TEXT;');
      this.log?.warn?.('台账已迁移：notifications 加 meta 列');
    }
  }

  prepare(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  audit({ entity, entityId, fromStatus, toStatus, actor = 'system', detail }) {
    this.run(
      'INSERT INTO event_audit(ts,entity,entity_id,from_status,to_status,actor,detail) VALUES(?,?,?,?,?,?,?)',
      nowIso(), entity, entityId, fromStatus || null, toStatus || null, actor,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }

  kvGet(key, fallback = null) {
    const row = this.get('SELECT value FROM meta WHERE key=?', key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  kvSet(key, value) {
    this.run(
      'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, JSON.stringify(value),
    );
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

export function openLedger(dbPath) {
  return new Ledger(dbPath);
}
