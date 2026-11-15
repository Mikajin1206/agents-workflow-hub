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
    // 也要触发热重载：面板顶栏与 /api/health 都直接读 size，
    // 少这一行就会出现「文件里 13 条、界面显示 14 条」的假象。
    this.#maybeReload();
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
    return [...this.rules].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.id).localeCompare(String(b.id)));
  }

  /**
   * 改写规则文件：面板要能直接编辑规则，而不是让人手改 JSON。
   *
   * 三条克制：
   *  1) 只合并认识的字段，规则里不认识的键（比如将来加的新字段）原样保留 ——
   *     面板保存一次就把别人手写的字段抹掉，是最讨厌的体验。
   *  2) 写盘用 2 空格缩进 + 末尾换行，和手写的格式一致，diff 干净。
   *  3) 校验放在写盘之前，任何一项不合法就整笔拒绝，绝不写进半条坏规则
   *     （坏规则会让整个规则库解析失败，那是全系统停摆）。
   */
  save(id, patch, options = {}) {
    const doc = this.#readDoc();
    const idx = doc.rules.findIndex((r) => r && r.id === id);
    if (idx < 0) throw Object.assign(new Error(`规则不存在：${id}`), { code: 'NOT_FOUND' });
    const merged = applyPatch(doc.rules[idx], patch);
    const errors = validateRule(merged, options);
    if (errors.length) throw Object.assign(new Error(errors.join('；')), { code: 'INVALID', errors });
    doc.rules[idx] = merged;
    this.#writeDoc(doc);
    this.reload(true);
    return normalizeRule(merged, idx);
  }

  create(patch, options = {}) {
    const doc = this.#readDoc();
    const draft = applyPatch({}, patch);
    draft.id = uniqueId(draft, doc.rules);
    const errors = validateRule(draft, options);
    if (errors.length) throw Object.assign(new Error(errors.join('；')), { code: 'INVALID', errors });
    doc.rules.push(draft);
    this.#writeDoc(doc);
    this.reload(true);
    return normalizeRule(draft, doc.rules.length - 1);
  }

  remove(id) {
    const doc = this.#readDoc();
    const idx = doc.rules.findIndex((r) => r && r.id === id);
    if (idx < 0) throw Object.assign(new Error(`规则不存在：${id}`), { code: 'NOT_FOUND' });
    const [gone] = doc.rules.splice(idx, 1);
    this.#writeDoc(doc);
    this.reload(true);
    return gone;
  }

  #readDoc() {
    const text = fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    const doc = Array.isArray(raw) ? { rules: raw } : raw;
    if (!Array.isArray(doc.rules)) doc.rules = [];
    return doc;
  }

  #writeDoc(doc) {
    // 先写临时文件再 rename：写一半被打断不会留下半个 JSON 把规则库搞崩。
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

/* ────────────────────── 面板编辑：合并与校验 ────────────────────── */

const PATCH_SECTIONS = ['match', 'route', 'limits', 'schedule'];
const PATCH_SCALARS = ['title', 'order', 'priority', 'skill', 'prompt', 'enabled', 'silent', 'action', 'notify_level', 'approval'];

/** 深合并：只覆盖 patch 里出现的键；某键给 null 表示删掉它 */
export function applyPatch(base, patch) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const key of PATCH_SCALARS) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  for (const key of PATCH_SECTIONS) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) { delete out[key]; continue; }
    const merged = deepMerge(out[key], patch[key]);
    if (merged === undefined) delete out[key]; else out[key] = merged;
  }
  // 空对象/空串清理：面板把可选字段清空后不该在文件里留 `"model": ""`
  for (const key of ['match', 'route', 'limits', 'schedule']) {
    if (out[key] && typeof out[key] === 'object' && !Object.keys(out[key]).length) delete out[key];
  }
  if (out.skill === '') delete out.skill;
  if (out.prompt === '') delete out.prompt;
  if (out.notify_level === '') delete out.notify_level;
  return out;
}

/**
 * 递归合并：patch 里的 null 表示「删掉这个键」，空串同样当删除
 * （面板里把输入框清空，本意就是不要这个字段，而不是留一个空字符串）。
 */
function deepMerge(dst, src) {
  if (src === null) return undefined;
  if (typeof src !== 'object' || Array.isArray(src)) return src === '' ? undefined : src;
  const out = dst && typeof dst === 'object' && !Array.isArray(dst) ? { ...dst } : {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    const merged = deepMerge(out[k], v);
    if (merged === undefined) delete out[k]; else out[k] = merged;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 校验一条规则。返回中文错误数组，空数组表示合法。
 * options: { engines:[id], nodes:[id], skills:[name], parseCron:fn }
 */
export function validateRule(rule, options = {}) {
  const errors = [];
  const r = rule || {};
  if (!r.title || !String(r.title).trim()) errors.push('说明（title）不能为空');
  if (r.order !== undefined && !Number.isFinite(Number(r.order))) errors.push('序号（order）必须是数字');
  if (r.priority && !['P0', 'P1', 'P2', 'P3'].includes(r.priority)) errors.push(`级别非法：${r.priority}`);

  const match = r.match || {};
  const type = String(match.type ?? '').trim();
  if (!type) errors.push('事件类型（match.type）不能为空');
  if (type.includes(' ') || /[^\w.*:/$-]/.test(type) && !type.startsWith('/')) errors.push('事件类型只能由字母数字和 . _ : / - * 组成');

  const action = r.action === 'notify' ? 'notify' : 'dispatch';
  if (action === 'dispatch') {
    const route = r.route || {};
    const engine = String(route.engine ?? '').trim();
    if (!engine) errors.push('派活规则必须指定引擎（route.engine）');
    else if (options.engines && options.engines.length && !options.engines.includes(engine)) {
      errors.push(`引擎不存在：${engine}（可选：${options.engines.join(' / ')}）`);
    }
    const node = String(route.node ?? 'any').trim() || 'any';
    if (node !== 'any' && options.nodes && options.nodes.length && !options.nodes.includes(node)) {
      errors.push(`节点未在配置里登记：${node}（可选：any / ${options.nodes.join(' / ')}）`);
    }
    if (r.skill && options.skills && options.skills.length && !options.skills.includes(r.skill)) {
      errors.push(`技能不存在：${r.skill}（可选：${options.skills.join(' / ')}）`);
    }
    const limits = r.limits || {};
    for (const k of ['per_key', 'max_parallel', 'attempts', 'timeout_seconds']) {
      if (limits[k] !== undefined && (!Number.isFinite(Number(limits[k])) || Number(limits[k]) < 0)) {
        errors.push(`${k} 必须是非负数字`);
      }
    }
  } else if (r.notify_level && !['P0', 'P1', 'P2', 'P3'].includes(r.notify_level)) {
    errors.push(`通知级别非法：${r.notify_level}`);
  }

  if (match.payload !== undefined && match.payload !== null) {
    if (typeof match.payload !== 'object' || Array.isArray(match.payload)) errors.push('匹配参数（match.payload）必须是对象');
  }

  const sched = r.schedule;
  if (sched) {
    const expr = typeof sched === 'string' ? sched : sched.cron;
    if (!expr) errors.push('定时规则缺少 cron 表达式');
    else if (options.parseCron) {
      try { options.parseCron(expr); } catch (err) { errors.push(`cron 表达式不合法：${err.message}`); }
    }
  }
  return errors;
}

function uniqueId(rule, existing) {
  const taken = new Set(existing.map((r) => r && r.id).filter(Boolean));
  const slug = String(rule.match?.type || 'rule').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'rule';
  const base = `r-${slug}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
  return `${base}-${Date.now()}`;
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
