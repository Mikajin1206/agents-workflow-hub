import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../lib/config.mjs';
import { newReportId } from '../lib/ids.mjs';

/**
 * M6-③④：报告归档 + 台账查询。
 * 每份产出都落成 Markdown 文件（人可读）+ reports 表（可检索）。
 */
export class ReportStore {
  constructor({ ledger, dir, log }) {
    this.ledger = ledger;
    this.dir = dir;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
  }

  save({ kind = 'report', title, body, taskId = null, eventId = null, meta = {} }) {
    const normalizedBody = String(body || '').trim();
    if (kind === 'task_output' && taskId) {
      const candidates = this.ledger.all(
        'SELECT report_id, path FROM reports WHERE kind=? AND task_id=? ORDER BY created_at, report_id',
        kind, taskId,
      );
      const existing = candidates.find((row) => readTaskOutput(row.path) === normalizedBody);
      if (existing) return existing;
    }
    const id = newReportId();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const subdir = path.join(this.dir, day.slice(0, 7));
    fs.mkdirSync(subdir, { recursive: true });
    const safeTitle = String(title || kind).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60);
    const file = path.join(subdir, `${day}-${safeTitle}-${id.slice(-6)}.md`);
    const content = [
      `# ${title || kind}`,
      '',
      `- 类型：${kind}`,
      `- 时间：${now.toISOString()}`,
      taskId ? `- 任务：${taskId}` : null,
      eventId ? `- 事件：${eventId}` : null,
      '',
      '---',
      '',
      normalizedBody,
      '',
    ].filter((l) => l !== null).join('\n');
    fs.writeFileSync(file, content, 'utf8');
    this.ledger.run(
      `INSERT INTO reports(report_id,kind,title,path,task_id,event_id,created_at,meta) VALUES(?,?,?,?,?,?,?,?)`,
      id, kind, title || kind, file, taskId, eventId, nowIso(), JSON.stringify(meta),
    );
    this.log.info('报告已归档', { id, kind, file });
    return { report_id: id, path: file };
  }

  list({ kind, limit = 30 } = {}) {
    const sql = kind
      ? `SELECT * FROM reports WHERE kind=? ORDER BY created_at DESC, report_id DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM reports ORDER BY created_at DESC, report_id DESC LIMIT ? OFFSET ?`;
    const args = kind ? [kind] : [];
    const rows = [];
    const seen = new Map();
    const pageSize = 100;
    for (let offset = 0; rows.length < limit; offset += pageSize) {
      const page = this.ledger.all(sql, ...args, pageSize, offset);
      for (const row of page) {
        if (row.kind === 'task_output' && row.task_id) {
          const body = readTaskOutput(row.path);
          if (body !== null) {
            if (!seen.has(row.task_id)) seen.set(row.task_id, new Set());
            const bodies = seen.get(row.task_id);
            if (bodies.has(body)) continue;
            bodies.add(body);
          }
        }
        rows.push(row);
        if (rows.length >= limit) break;
      }
      if (page.length < pageSize) break;
    }
    return rows.map((r) => ({
      report_id: r.report_id, kind: r.kind, title: r.title, path: r.path,
      task_id: r.task_id, event_id: r.event_id, created_at: r.created_at,
    }));
  }

  read(reportId) {
    const row = this.ledger.get('SELECT * FROM reports WHERE report_id=?', reportId);
    if (!row) return null;
    let body = '';
    try { body = fs.readFileSync(row.path, 'utf8'); } catch { body = '（文件已丢失）'; }
    return { ...row, body };
  }

  latest(kind) {
    const row = kind
      ? this.ledger.get('SELECT * FROM reports WHERE kind=? ORDER BY created_at DESC LIMIT 1', kind)
      : this.ledger.get('SELECT * FROM reports ORDER BY created_at DESC LIMIT 1');
    return row || null;
  }
}

function readTaskOutput(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const separator = /\r?\n---\r?\n\r?\n/.exec(content);
    return separator ? content.slice(separator.index + separator[0].length).trim() : null;
  } catch {
    return null;
  }
}

/** 台账查询：人要看「上周机器都干了什么」时的入口 */
export function ledgerReport({ ledger, since, until }) {
  const sinceIso = since || new Date(Date.now() - 24 * 3600_000).toISOString();
  const untilIso = until || nowIso();
  const tasks = ledger.all(
    `SELECT * FROM tasks WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 500`,
    sinceIso, untilIso,
  );
  const events = ledger.all(
    `SELECT * FROM events WHERE created_at >= ? AND created_at <= ? AND status <> 'duplicate' ORDER BY created_at DESC LIMIT 500`,
    sinceIso, untilIso,
  );
  const approvals = ledger.all(
    `SELECT * FROM approvals WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 200`,
    sinceIso, untilIso,
  );
  const byStatus = groupCount(tasks, 'status');
  const byEngine = groupCount(tasks, 'engine');
  const byType = groupCount(events, 'type');
  return {
    window: { since: sinceIso, until: untilIso },
    totals: {
      events: events.length,
      tasks: tasks.length,
      approvals: approvals.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed' || t.status === 'dead_letter').length,
      pending_approval: approvals.filter((a) => a.status === 'pending').length,
    },
    by_status: byStatus,
    by_engine: byEngine,
    by_type: byType,
    tasks: tasks.map((t) => ({
      task_id: t.task_id, title: t.title, node: t.node, engine: t.engine, skill: t.skill,
      status: t.status, priority: t.priority, created_at: t.created_at, finished_at: t.finished_at,
      error: t.error,
    })),
    approvals: approvals.map((a) => ({
      approval_id: a.approval_id, category: a.category, title: a.title,
      status: a.status, created_at: a.created_at, decided_at: a.decided_at,
    })),
  };
}

function groupCount(rows, key) {
  const map = {};
  for (const r of rows) map[r[key] || 'unknown'] = (map[r[key] || 'unknown'] || 0) + 1;
  return map;
}
