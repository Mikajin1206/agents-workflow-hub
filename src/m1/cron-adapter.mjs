import { parseCron, cronMatches, nextCronTime } from '../lib/cron.mjs';
import { nowIso } from '../lib/config.mjs';

/**
 * M1-②：本地定时器入口。
 *
 * 到点就投一个标准信封进 M2，不直接干活。
 * 支持 rules.json 里的 schedule 定义，也支持独立 config/timers.json。
 */
export class CronScheduler {
  constructor({ config, events, log }) {
    this.config = config;
    this.events = events;
    this.log = log;
    this.timers = [];
    this.timer = null;
    this.lastMinuteKey = '';
    this.history = [];
  }

  /** 从 rules.json 收集带 schedule 的规则 */
  loadFromRules(rules) {
    const timers = [];
    for (const rule of rules.rules) {
      const sched = rule.raw?.schedule;
      if (!sched || sched.enabled === false) continue;
      const expr = typeof sched === 'string' ? sched : sched.cron;
      if (!expr) continue;
      try {
        const parsed = parseCron(expr);
        timers.push({
          id: rule.id,
          name: rule.raw.schedule.name || rule.title || rule.id,
          cron: expr,
          parsed,
          event: {
            source: 'cron',
            type: rule.match.type !== '*' ? rule.match.type : (sched.type || rule.id),
            target: sched.target || rule.match.target || null,
            summary: sched.summary || rule.title || rule.id,
            priority: sched.priority || rule.priority || 'P2',
            dedupe_key: sched.dedupe_key || `${rule.match.type || rule.id}`,
            payload: { ...(sched.payload || {}), timer: rule.id },
          },
          next: null,
        });
      } catch (err) {
        this.log.error('定时规则解析失败', { rule: rule.id, expr, error: err.message });
      }
    }
    this.timers = timers;
    for (const t of this.timers) t.next = nextCronTime(t.parsed, new Date());
    return timers.length;
  }

  start() {
    if (this.timer) return;
    if (!this.config.cron.enabled) {
      this.log.info('定时器已禁用（config.cron.enabled=false）');
      return;
    }
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref?.();
    this.tick();
    this.log.info('定时器已启动', {
      count: this.timers.length,
      next: this.timers.filter((t) => t.next).map((t) => `${t.name}@${t.next.toISOString()}`).slice(0, 5),
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 每分钟最多触发一次 */
  async tick(now = new Date()) {
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === this.lastMinuteKey) return [];
    this.lastMinuteKey = key;
    const fired = [];
    for (const t of this.timers) {
      if (!cronMatches(t.parsed, now)) continue;
      fired.push(t);
    }
    const results = [];
    for (const t of fired) {
      try {
        const res = await this.events.ingestAsync({
          ...t.event,
          created_at: nowIso(),
          payload: { ...t.event.payload, fired_at: nowIso(), cron: t.cron },
        }, 'cron');
        results.push({ timer: t.id, ok: true, event_id: res.event_id, duplicate: res.duplicate });
        this.log.info('定时事件已投递', { timer: t.id, event: res.event_id, duplicate: res.duplicate });
        this.history.unshift({ at: nowIso(), timer: t.id, ok: true, event_id: res.event_id });
      } catch (err) {
        results.push({ timer: t.id, ok: false, error: err.message });
        this.log.error('定时事件投递失败', { timer: t.id, error: err.message });
        this.history.unshift({ at: nowIso(), timer: t.id, ok: false, error: err.message });
      }
      this.history = this.history.slice(0, 50);
    }
    for (const t of this.timers) t.next = nextCronTime(t.parsed, now);
    return results;
  }

  describe() {
    return this.timers.map((t) => ({
      id: t.id, name: t.name, cron: t.cron,
      next: t.next ? t.next.toISOString() : null,
      next_local: t.next ? localStr(t.next) : null,
      type: t.event.type,
    }));
  }
}

function localStr(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
