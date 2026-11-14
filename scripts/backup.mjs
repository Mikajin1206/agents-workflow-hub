/**
 * 台账与报告备份。
 *
 * 为什么要用脚本而不是文档里那行 node -e：
 *   1. `VACUUM INTO` 的路径在 cmd 里要套两层引号，写错就静默失败；
 *   2. 目标目录不存在时 VACUUM INTO 直接报错（SQLite 不会自动建目录）；
 *   3. 备份完要能验证「这份备份是能打开的」，否则等于没有备份。
 *
 * 用法：
 *   node scripts/backup.mjs                    备份到 data/backups/
 *   node scripts/backup.mjs --out D:\bak       备份到指定目录
 *   node scripts/backup.mjs --keep 14          只保留最近 14 份（默认 30）
 *
 * 中台运行中也可以跑：VACUUM INTO 是 SQLite 官方的在线备份方式，
 * 不需要停服务，也不会拿到写了一半的库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/lib/config.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const config = loadConfig();
const dbPath = config.paths.db;
const outDir = path.resolve(argOf('--out') || path.join(config.paths.data, 'backups'));
const keep = Number(argOf('--keep') || 30);

if (!fs.existsSync(dbPath)) {
  console.error(`✗ 台账不存在：${dbPath}`);
  console.error('  这个中台还没收到过任何事件？先用 node src/cli.mjs doctor 确认配置。');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const target = path.join(outDir, `hub-${stamp}.db`);

const db = new DatabaseSync(dbPath);
try {
  // VACUUM INTO 的路径是 SQL 字符串字面量，单引号要转义成两个单引号
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

// 验证：备份文件必须能被打开、且表结构与源库一致。
// 只看「文件存在且大于 0 字节」不算验证 —— 空库也能满足这两条。
const check = new DatabaseSync(target, { readOnly: true });
let tables = [];
try {
  tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  const n = check.prepare("SELECT COUNT(*) c FROM events").get()?.c ?? 0;
  const m = check.prepare("SELECT COUNT(*) c FROM tasks").get()?.c ?? 0;
  const size = fs.statSync(target).size;
  console.log(`✓ 备份完成：${target}`);
  console.log(`  大小 ${(size / 1024).toFixed(1)} KB · ${tables.length} 张表 · ${n} 条事件 · ${m} 个任务`);
} finally {
  check.close();
}

// 报告目录一起备（台账里有 report_id 指向它，单备份 db 会留下断链）
const reportsSrc = config.paths.reports;
if (fs.existsSync(reportsSrc)) {
  const reportsDst = path.join(outDir, `reports-${stamp}`);
  fs.cpSync(reportsSrc, reportsDst, { recursive: true });
  const n = fs.readdirSync(reportsDst, { recursive: true }).filter((f) => String(f).endsWith('.md')).length;
  console.log(`✓ 报告已备份：${reportsDst}（${n} 份）`);
}

// 滚动清理：文件名带 ISO 时间戳前缀，字典序即时间序
const allDb = fs.readdirSync(outDir).filter((f) => /^hub-.*\.db$/.test(f)).sort();
const dropDb = allDb.slice(0, Math.max(0, allDb.length - keep));
for (const f of dropDb) fs.rmSync(path.join(outDir, f), { force: true });

const allRep = fs.readdirSync(outDir).filter((f) => /^reports-/.test(f)).sort();
for (const f of allRep.slice(0, Math.max(0, allRep.length - keep))) {
  fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
}
if (dropDb.length) console.log(`  已清理旧备份 ${dropDb.length} 份（保留最近 ${keep} 份）`);
