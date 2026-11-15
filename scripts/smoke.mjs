import { loadConfig, HUB_ROOT } from '../src/lib/config.mjs';
import { openLedger } from '../src/lib/ledger.mjs';

/** 冒烟检查：能读配置、能开台账、表结构完整。不启服务、不派活。 */
const cfg = loadConfig();
console.log('HUB_ROOT:', HUB_ROOT);
console.log('db      :', cfg.paths.db);

const led = openLedger(cfg.paths.db);
const expected = [
  'approvals', 'decisions', 'event_audit', 'events', 'meta',
  'notifications', 'pipeline_runs', 'reports', 'runs', 'tasks',
];
const actual = led.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
const missing = expected.filter((t) => !actual.includes(t));

console.log('tables  :', actual.join(', '));
if (missing.length) {
  console.error('缺少表:', missing.join(', '));
  led.close();
  process.exit(1);
}
console.log('smoke ok');
led.close();
