import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuleSet, validateRule, applyPatch } from '../src/lib/rules.mjs';
import { parseCron } from '../src/lib/cron.mjs';

const tmp = path.join(os.tmpdir(), `rules-test-${Date.now()}.json`);
fs.writeFileSync(tmp, JSON.stringify({
  version: 1,
  rules: [
    { id: 'r-a', title: 'A', order: 10, match: { source: 'cron', type: 'cron.a' }, route: { engine: 'mock' }, _custom: 'keep-me' },
    { id: 'r-b', title: 'B', order: 20, match: { type: 'b' }, action: 'notify', notify_level: 'P1' },
  ],
}, null, 2));

const rs = new RuleSet(tmp);
const opts = { engines: ['mock', 'codex', 'claude-code'], nodes: ['win-a', 'mac-b'], skills: ['daily-report'], parseCron };
let pass = 0; let fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass += 1; console.log(`✓ ${name}`); } else { fail += 1; console.log(`✗ ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); } };

// 1 保存并保留自定义字段
const saved = rs.save('r-a', { title: 'A2', priority: 'P1', limits: { max_parallel: 2 } }, opts);
ok(saved.title === 'A2' && saved.priority === 'P1', '保存后读到新标题与级别', saved.title);
ok(saved.limits.max_parallel === 2, 'limits 深合并生效');
const onDisk = JSON.parse(fs.readFileSync(tmp, 'utf8')).rules.find((r) => r.id === 'r-a');
ok(onDisk._custom === 'keep-me', '不认识的字段原样保留', Object.keys(onDisk));

// 2 清空可选字段会被删掉，而不是留空串
rs.save('r-a', { route: { node: 'win-a' } }, opts);
const r2 = JSON.parse(fs.readFileSync(tmp, 'utf8')).rules.find((r) => r.id === 'r-a');
ok(r2.route.engine === 'mock' && r2.route.node === 'win-a', 'route 部分更新不影响未提交字段', r2.route);
rs.save('r-a', { prompt: '' }, opts);
ok(!('prompt' in JSON.parse(fs.readFileSync(tmp, 'utf8')).rules[0]), '清空 prompt 后不留空串键');

// 3 新建
const created = rs.create({ title: '新规则', match: { type: 'feishu.message' }, route: { engine: 'codex' }, priority: 'P3' }, opts);
ok(!!created.id && rs.size === 3, '新建规则并落盘', created.id);
ok(rs.byId(created.id) !== null, '新建的规则能被 byId 读到');

// 4 定时规则
const withSched = rs.save(created.id, { schedule: { cron: '0 9 * * 1-5', name: '工作日九点' } }, opts);
ok(withSched.raw.schedule.cron === '0 9 * * 1-5', '定时字段写入成功');

// 5 删除
rs.remove(created.id);
ok(rs.size === 2 && rs.byId(created.id) === null, '删除规则生效');

// 6 校验：非法引擎/技能/cron
const e1 = validateRule({ title: 'x', match: { type: 'a' }, route: { engine: 'nope' } }, opts);
ok(e1.some((m) => /引擎不存在/.test(m)), '拦非法引擎', e1);
const e2 = validateRule({ title: 'x', match: { type: 'a' }, route: { engine: 'mock' }, skill: 'nope' }, opts);
ok(e2.some((m) => /技能不存在/.test(m)), '拦非法技能', e2);
const e3 = validateRule({ title: 'x', match: { type: 'a' }, route: { engine: 'mock' }, schedule: { cron: 'bad' } }, opts);
ok(e3.some((m) => /cron 表达式不合法/.test(m)), '拦非法 cron', e3);
const e4 = validateRule({ title: '', match: { type: 'a' }, route: { engine: 'mock' } }, opts);
ok(e4.some((m) => /title/.test(m)), '拦空标题', e4);
const e5 = validateRule({ title: 'x', match: { type: '' }, route: { engine: 'mock' } }, opts);
ok(e5.some((m) => /match\.type/.test(m)), '拦空事件类型', e5);
const valid = validateRule({ title: 'x', match: { type: 'a' }, route: { engine: 'mock' } }, opts);
ok(valid.length === 0, '合法规则零错误', valid);

// 7 非法保存不会写盘（r-b 是 notify 规则，不需要引擎；这里用派活规则 r-a）
const before = fs.readFileSync(tmp, 'utf8');
try { rs.save('r-a', { route: { engine: 'nope' } }, opts); ok(false, '非法保存应抛错'); } catch (err) { ok(err.code === 'INVALID', '非法保存抛 INVALID', err.code); }
ok(fs.readFileSync(tmp, 'utf8') === before, '非法保存没动磁盘');
// notify 规则不要求引擎
ok(validateRule({ title: 'x', match: { type: 'a' }, action: 'notify', notify_level: 'P0' }, opts).length === 0, 'notify 规则不需要引擎');

// 8 applyPatch 边界
const ap = applyPatch({ match: { type: 'a', payload: { k: 1 } } }, { match: { payload: { k: null } } });
ok(ap.match && ap.match.payload === undefined, 'payload.k=null 表示删掉该键', ap.match);

fs.rmSync(tmp, { force: true });
console.log(`\nRESULT=${fail ? 'FAIL' : 'PASS'} (${pass} 通过 / ${fail} 失败)`);
process.exitCode = fail ? 1 : 0;
