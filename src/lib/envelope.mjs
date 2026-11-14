import { nowIso } from './config.mjs';

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

const SOURCE_ALIASES = new Map([
  ['feishu', 'feishu'],
  ['lark', 'feishu'],
  ['cron', 'cron'],
  ['timer', 'cron'],
  ['schedule', 'cron'],
  ['github', 'github'],
  ['gh', 'github'],
  ['web', 'web'],
  ['panel', 'web'],
  ['api', 'web'],
  ['cli', 'cli'],
  ['manual', 'cli'],
  ['monitor', 'monitor'],
  ['alert', 'monitor'],
  ['system', 'system'],
]);

export function normalizeSource(source) {
  const key = String(source || '').trim().toLowerCase();
  return SOURCE_ALIASES.get(key) || key || 'unknown';
}

export function normalizePriority(p, fallback = 'P2') {
  if (!p) return fallback;
  const v = String(p).toUpperCase();
  return PRIORITIES.includes(v) ? v : fallback;
}

/**
 * 统一事件信封（方案 §5.1）。
 * 所有入口都必须产出这个形状，M2 只认这个形状。
 */
export function makeEnvelope(input) {
  const source = normalizeSource(input.source);
  const type = String(input.type || '').trim();
  if (!type) throw new Error('事件信封缺少 type 字段');
  const target = input.target ? String(input.target).trim() : null;
  const summary = input.summary ? String(input.summary).trim() : null;
  const created_at = input.created_at || nowIso();
  const dedupe_key = input.dedupe_key
    ? String(input.dedupe_key)
    : `${type}${target ? '#' + target : ''}`;

  return {
    source,
    type,
    target,
    summary,
    link: input.link || null,
    dedupe_key,
    priority: normalizePriority(input.priority),
    created_at,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  };
}

export function validateEnvelope(env) {
  const errors = [];
  if (!env || typeof env !== 'object') return ['信封不是对象'];
  if (!env.source) errors.push('缺少 source');
  if (!env.type) errors.push('缺少 type');
  if (!env.dedupe_key) errors.push('缺少 dedupe_key');
  if (!PRIORITIES.includes(env.priority)) errors.push(`priority 非法：${env.priority}`);
  if (!env.created_at || Number.isNaN(Date.parse(env.created_at))) errors.push('created_at 非法');
  return errors;
}

export function summarize(env) {
  const bits = [`${env.source}/${env.type}`];
  if (env.target) bits.push(env.target);
  return bits.join(' ');
}
