import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../lib/config.mjs';
import { newDecisionId } from '../lib/ids.mjs';

/**
 * M6-②：决定记忆 ——「定过的事」与「定了不做的事」。
 *
 * 这是整套系统不跑偏的关键：每次派活都把相关的历史决定拼进提示词，
 * 让新的一次执行不会推翻你上周亲口定下的方案。
 *
 * 两层：SQLite decisions 表（可查询，带原话与日期）+ config/decisions/*.md（人可读，可手写）。
 */
export class DecisionMemory {
  constructor({ ledger, dir, config, log }) {
    this.ledger = ledger;
    this.dir = dir;
    this.config = config;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
    this.fileCache = null;
    this.fileMtime = 0;
  }

  /** 记一条决定（亲口决定 / 拒绝过的事项） */
  record({ kind = 'decided', text, quote, by = 'user', sourceApproval = null, sourceTask = null, tags = [] }) {
    if (!text) throw new Error('决定内容不能为空');
    const id = newDecisionId();
    this.ledger.run(
      `INSERT INTO decisions(decision_id,kind,text,quote,decided_by,decided_at,source_approval,source_task,tags,active)
       VALUES(?,?,?,?,?,?,?,?,?,1)`,
      id, kind, String(text).trim(), quote || null, by, nowIso(), sourceApproval, sourceTask, JSON.stringify(tags),
    );
    this.ledger.audit({ entity: 'decision', entityId: id, toStatus: kind, actor: by, detail: { text } });
    this.log.info('记录决定', { id, kind, text: String(text).slice(0, 80) });
    return this.get(id);
  }

  get(id) {
    const row = this.ledger.get('SELECT * FROM decisions WHERE decision_id=?', id);
    return row ? decodeDecision(row) : null;
  }

  /** 全量列表（含手写 md 文件） */
  list({ kind, active = true, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (active !== undefined) { where.push('active=?'); params.push(active ? 1 : 0); }
    if (kind) { where.push('kind=?'); params.push(kind); }
    const sql = `SELECT * FROM decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY decided_at DESC LIMIT ?`;
    const fromDb = this.ledger.all(sql, ...params, limit).map(decodeDecision);
    const fromFiles = this.#loadFiles();
    return [...fromDb, ...fromFiles].sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)));
  }

  /** 按任务上下文检索相关决定：只返回真正命中的，宁缺勿滥 */
  relevant(query, limit = 8) {
    const all = this.list({ limit: 500 });
    const q = String(query || '').toLowerCase();
    const { words, grams } = tokenize(q);
    if (!words.length && !grams.length) return [];
    const scored = all.map((d) => {
      const hay = `${d.text} ${d.quote || ''} ${(d.tags || []).join(' ')}`.toLowerCase();
      let wordHit = 0;
      for (const t of words) if (hay.includes(t)) wordHit += 1;
      let gramHit = 0;
      for (const g of grams) if (hay.includes(g)) gramHit += 1;
      let tagHit = 0;
      if (Array.isArray(d.tags)) for (const tag of d.tags) if (q.includes(String(tag).toLowerCase())) tagHit += 1;
      const score = wordHit * 3 + gramHit + tagHit * 2;
      return { d, score, wordHit, gramHit, tagHit };
    });
    // 相关性判定：拉丁词命中，或中文二元组命中足够多；否则宁可不给。
    // 阈值必须跟着查询长度走：两字查询（"删除""飞书"）只产出 1 个 bigram，
    // 写死 >=2 会让所有两字查询永远查不到东西。
    const need = Math.min(2, grams.length || 0);
    const hit = scored.filter((s) => s.wordHit > 0 || (need > 0 && s.gramHit >= need));
    return hit
      .sort((a, b) => b.score - a.score || String(b.d.decided_at).localeCompare(String(a.d.decided_at)))
      .slice(0, limit)
      .map((s) => s.d);
  }

  /** 停用一条决定（改主意了） */
  retire(id, { by = 'user', reason } = {}) {
    const d = this.get(id);
    if (!d) return { ok: false, error: '决定不存在' };
    this.ledger.run('UPDATE decisions SET active=0 WHERE decision_id=?', id);
    this.ledger.audit({ entity: 'decision', entityId: id, actor: by, detail: { retired: true, reason: reason || null } });
    return { ok: true };
  }

  /** 手写 Markdown 决定文件，格式宽松：`- [定过的事] 文本 —— 2026-11-01` */
  #loadFiles() {
    const files = [];
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.md')) continue;
        files.push(path.join(this.dir, f));
      }
    } catch {
      return [];
    }
    const out = [];
    for (const file of files) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*[-*]\s*(?:\[(定过的事|定了不做的事|decided|refused)\]\s*)?(.+?)(?:\s*——\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
        if (!m) continue;
        if (!m[1] && !/——/.test(line)) continue;
        const kind = m[1] === '定了不做的事' || m[1] === 'refused' ? 'refused' : 'decided';
        out.push({
          decision_id: `file:${path.basename(file)}:${hash(line)}`,
          kind,
          text: m[2].trim(),
          quote: null,
          decided_by: 'user',
          decided_at: m[3] ? `${m[3]}T00:00:00.000Z` : new Date(stat.mtimeMs).toISOString(),
          source: 'file',
          tags: [],
          active: true,
        });
      }
    }
    return out;
  }

  /** 周日大扫除：把长期未更新、互相矛盾的决定挑出来给人看 */
  weeklyCheck() {
    const all = this.list({ limit: 500 });
    const conflicts = [];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        if (a.kind === b.kind) continue;
        const aw = keywords(a.text);
        const bw = keywords(b.text);
        const overlap = aw.filter((w) => bw.includes(w));
        if (overlap.length >= 2) conflicts.push({ decided: a, refused: b, overlap });
      }
    }
    return {
      total: all.length,
      decided: all.filter((d) => d.kind === 'decided').length,
      refused: all.filter((d) => d.kind === 'refused').length,
      stale: all.filter((d) => Date.parse(d.decided_at) < Date.now() - 180 * 86400_000).length,
      conflicts,
    };
  }
}

function decodeDecision(row) {
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
  return {
    decision_id: row.decision_id,
    kind: row.kind,
    text: row.text,
    quote: row.quote,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    source_approval: row.source_approval,
    source_task: row.source_task,
    tags,
    active: Boolean(row.active),
    source: 'db',
  };
}

function keywords(text) {
  const s = String(text || '').toLowerCase();
  const parts = s.split(/[\s,，。;；:：/\\|·\-_（）()]+/).filter((t) => t.length >= 2);
  return [...new Set(parts)];
}

/**
 * 中英混排切词：拉丁词按空格切，中文按二元组（bigram）切。
 * 中文没有自然分隔符，靠整串 includes 基本匹配不上，必须走二元组。
 */
function tokenize(q) {
  const s = String(q || '').toLowerCase();
  const words = (s.match(/[a-z0-9][a-z0-9._-]{1,}/g) || []).filter((w) => w.length >= 2);
  const grams = [];
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i += 1) grams.push(run.slice(i, i + 2));
  }
  return { words: [...new Set(words)], grams: [...new Set(grams)] };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
