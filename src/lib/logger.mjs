import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * 轻量结构化日志：控制台 + 按天滚动的 JSONL 文件。
 * 一切留痕是全系统铁律之一，日志文件用于排障，业务留痕走 M6 台账。
 */
export function createLogger({ dir, level = 'info', name = 'hub' } = {}) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let streamDay = '';

  function ensureStream() {
    if (!dir) return null;
    const day = new Date().toISOString().slice(0, 10);
    if (stream && streamDay === day) return stream;
    try {
      stream?.end();
      stream = fs.createWriteStream(path.join(dir, `${name}-${day}.jsonl`), { flags: 'a' });
      streamDay = day;
      stream.on('error', () => { stream = null; });
    } catch {
      stream = null;
    }
    return stream;
  }

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg, ...fields };
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: lvl, msg, fields: String(fields) });
    }
    if (lvl === 'error') console.error(`[${lvl}] ${msg}${fields ? ' ' + safe(fields) : ''}`);
    else if (lvl === 'warn') console.warn(`[${lvl}] ${msg}${fields ? ' ' + safe(fields) : ''}`);
    else console.log(`${lvl === 'debug' ? '·' : '›'} ${msg}${fields ? ' ' + safe(fields) : ''}`);
    const s = ensureStream();
    if (s) s.write(line + '\n');
  }

  const logger = {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (scope) => createLogger({ dir, level, name: `${name}` }).withScope(scope),
    withScope(scope) {
      const wrap = (lvl) => (m, f) => emit(lvl, `[${scope}] ${m}`, f);
      return {
        debug: wrap('debug'),
        info: wrap('info'),
        warn: wrap('warn'),
        error: wrap('error'),
        child: (s) => createLogger({ dir, level, name }).withScope(`${scope}:${s}`),
      };
    },
    close() { try { stream?.end(); } catch { /* ignore */ } },
  };
  return logger;
}

function safe(obj) {
  try {
    const s = JSON.stringify(obj);
    return s.length > 800 ? s.slice(0, 800) + '…' : s;
  } catch {
    return String(obj);
  }
}
