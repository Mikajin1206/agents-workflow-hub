import fs from 'node:fs';
import path from 'node:path';

const RULE_KEYS = ['match', 'route', 'skill', 'prompt', 'limits', 'approval', 'silent', 'id', 'title', 'enabled', 'dedupe'];

export function matchForKey(value, pattern) {
  if (pattern === undefined || pattern === null) return true;
  if (Array.isArray(pattern)) return pattern.some((p) => matchForKey(value, p));
  const v = value === undefined || value === null ? '' : String(value);
  const p = String(pattern);
  if (p === '*' || p === '') return v === '' || p === '*';
  if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
    const end = p.lastIndexOf('/');
    const re = new RegExp(p.slice(1, end), p.slice(end + 1));
    return re.test(v);
  }
  if (p.includes('*')) {
    const re = new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$');
    return re.test(v);
  }
  return v === p;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * rules.json 规则库（方案 §5.2）。
 * 一条规则 = 哪类事件 → 哪台机器的哪个引擎 → 哪个 Skill → 什么指令 → 并发上限 → 是否必问。
 */
export class RuleSet {
  constructor(filePath) {
    this.filePath = filePath;
    this.rules = [];
    this.mtimeMs = 0;
    this.error = null;
    this.lastCheckMs = 0;
    this.reload(true);
  }

  /**
   * 热重载：改 rules.json 后不必重启中台。
   *
   * 早先只在 constructor 里 reload 一次，于是面板上写着「改文件后会自动热重载」
   * 却从来没生效过——运行中的进程一直用启动那一刻的规则副本。
   * 症状很隐蔽：新加的规则看着能匹配（说明该规则在旧副本里就有），
   * 但后来补的字段（如 route.workdir）永远读不到，任务被派到错误的目录。
   *
   * 每次匹配前做一次 mtime 检查（约几十微秒），节流到 1 秒，避免每事件都 stat。
   */
  #maybeReload() {
    const now = Date.now();
    if (now - this.lastCheckMs < 1000) return;
    this.lastCheckMs = now;
    this.reload(false);
  }

  reload(force = false) {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      if (force) {
        this.rules = [];
        this.error = `规则文件不存在：${this.filePath}`;
      }
      return { reloaded: false, error: this.error };
    }
    if (!force && stat.mtimeMs === this.mtimeMs) return { reloaded: false, error: this.error };
    this.mtimeMs = stat.mtimeMs;
    try {
      // 剥 BOM：Windows 上用 PowerShell 存盘很容易带 U+FEFF，JSON.parse 会直接报错。
      // 规则文件解析失败时中台不会崩（有 this.error 兜底），但会静默用空规则库 —— 更难查。
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, ''));
      const list = Array.isArray(raw) ? raw : raw.rules;
      if (!Array.isArray(list)) throw new Error('rules 必须是数组或 { rules: [] }');
      this.rules = list.map((r, i) => normalizeRule(r, i));
      this.error = null;
      return { reloaded: true, count: this.rules.length, error: null };
    } catch (err) {
      this.error = `规则文件解析失败：${err.message}`;
      return { reloaded: false, error: this.error };
    }
  }

  get size() {
    return this.rules.length;
  }

  /**
   * 按 source + type + target 匹配；priority 由高到低。
   * 未命中返回 null（进「待归类」队列）。
   */
  match(env) {
    this.#maybeReload();
    const hits = [];
    for (const rule of this.rules) {
      if (rule.enabled === false) continue;
      if (!matchForKey(env.source, rule.match.source)) continue;
      if (!matchForKey(env.type, rule.match.type)) continue;
      if (!matchForKey(env.target, rule.match.target)) continue;
      // 可选：payload 精确匹配，如 payload.reason = review.stalled
      if (rule.match.payload) {
        let ok = true;
        for (const [k, v] of Object.entries(rule.match.payload)) {
          if (!matchForKey(env.payload?.[k], v)) { ok = false; break; }
        }
        if (!ok) continue;
      }
      hits.push(rule);
    }
    if (!hits.length) return null;
    const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
    hits.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || rank[a.priority || 'P2'] - rank[b.priority || 'P2']);
    return hits[0];
  }

  byId(id) {
    this.#maybeReload();
    return this.rules.find((r) => r.id === id) || null;
  }

  /** 全量规则（按 order 排序），供面板/CLI 展示 */
  all() {
    this.#maybeReload();
    return [...this.rules];
  }
}

export function normalizeRule(raw, index) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const match = r.match && typeof r.match === 'object' ? r.match : {};
  const route = r.route && typeof r.route === 'object' ? r.route : {};
  const limits = r.limits && typeof r.limits === 'object' ? r.limits : {};
  return {
    id: r.id || `rule-${index + 1}`,
    title: r.title || '',
    enabled: r.enabled !== false,
    order: typeof r.order === 'number' ? r.order : index,
    priority: r.priority || null,
    match: {
      source: match.source ?? '*',
      type: match.type ?? '*',
      target: match.target ?? '*',
      payload: match.payload || null,
    },
    route: {
      node: route.node || 'any',
      engine: route.engine || 'claude-code',
      model: route.model || null,
      workdir: route.workdir || null,
    },
    skill: r.skill || null,
    prompt: r.prompt || '',
    // dispatch = 派活给节点；notify = 不派活，直接推到人面前（方案里 review.stalled / release.failed 这类）
    action: r.action === 'notify' ? 'notify' : 'dispatch',
    notifyLevel: r.notify_level || r.priority || 'P1',
    limits: {
      per_key: Number.isFinite(limits.per_key) ? limits.per_key : 1,
      max_parallel: Number.isFinite(limits.max_parallel) ? limits.max_parallel : 3,
      attempts: Number.isFinite(limits.attempts) ? limits.attempts : 2,
      timeout_seconds: Number.isFinite(limits.timeout_seconds) ? limits.timeout_seconds : 900,
    },
    approval: r.approval === true || r.approval === 'always' ? 'always' : (r.approval || false),
    silent: r.silent !== false,
    dedupe: r.dedupe && typeof r.dedupe === 'object' ? r.dedupe : null,
    raw: r,
  };
}
