/**
 * 极简 cron 解析器（5 字段：分 时 日 月 周）。
 * 支持 * / 数字 / 逗号列表 / 连字符区间 / 步长（*\/5、1-10/2）。
 * 周日：0 或 7。
 */
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 表达式需要 5 个字段：${expr}`);
  const [min, hour, dom, mon, dow] = parts;
  return {
    minute: parseField(min, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dow: parseField(dow, 0, 7).map((d) => (d === 7 ? 0 : d)),
    expr: String(expr).trim(),
    raw: parts,
  };
}

function parseField(field, min, max) {
  const out = new Set();
  for (const chunk of String(field).split(',')) {
    const [rangePart, stepPart] = chunk.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step <= 0) throw new Error(`非法步长：${chunk}`);
    if (rangePart === '*') {
      for (let i = min; i <= max; i += step) out.add(i);
      continue;
    }
    const m = rangePart.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`非法 cron 字段：${chunk}`);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start < min || end > max || start > end) throw new Error(`cron 字段越界：${chunk}（允许 ${min}-${max}）`);
    for (let i = start; i <= end; i += step) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** 判断某时刻是否命中 */
export function cronMatches(parsed, date) {
  if (!parsed.minute.includes(date.getMinutes())) return false;
  if (!parsed.hour.includes(date.getHours())) return false;
  if (!parsed.month.includes(date.getMonth() + 1)) return false;
  if (!parsed.dow.includes(date.getDay())) return false;
  // 日与周：标准 cron 里若两者都受限，命中任一即可
  const domRestricted = parsed.raw[2] !== '*';
  const dowRestricted = parsed.raw[4] !== '*';
  if (domRestricted && dowRestricted) return parsed.dom.includes(date.getDate()) || parsed.dow.includes(date.getDay());
  if (domRestricted) return parsed.dom.includes(date.getDate());
  return true;
}

/** 下一次触发时间（当地时区），maxDays 内找不到返回 null */
export function nextCronTime(parsed, from = new Date(), maxDays = 366) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < maxDays * 24 * 60; i += 1) {
    if (cronMatches(parsed, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
