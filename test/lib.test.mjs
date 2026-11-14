/**
 * 单元测试：纯函数与规则解析。
 *   node --test test/
 * 这些测试不碰数据库、不起服务，只验证最容易悄悄错的纯逻辑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCron, cronMatches, nextCronTime } from '../src/lib/cron.mjs';
import { matchForKey, RuleSet, normalizeRule } from '../src/lib/rules.mjs';
import { makeEnvelope, normalizeSource, normalizePriority, validateEnvelope } from '../src/lib/envelope.mjs';
import { matchKeyword, SEMANTIC_RULES, ApprovalService } from '../src/m5/approvals.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { parseFrontMatter } from '../src/m6/skills.mjs';
import { verifyHmacSha256 } from '../src/lib/http.mjs';

/* ─────────────────────── cron ─────────────────────── */

test('parseCron 解析五字段并展开范围与步长', () => {
  const c = parseCron('30 7 * * 1-5');
  assert.equal(c.minute.length, 1);
  assert.equal(c.minute[0], 30);
  assert.deepEqual(c.hour, [7]);
  assert.equal(c.dom.length, 31);
  assert.equal(c.dow.length, 5);
  assert.deepEqual(c.dow, [1, 2, 3, 4, 5]);

  const step = parseCron('*/15 * * * *');
  assert.deepEqual(step.minute, [0, 15, 30, 45]);
});

test('parseCron 拒绝非法表达式', () => {
  assert.throws(() => parseCron('* * * *'), /5 个字段/);
  assert.throws(() => parseCron('61 * * * *'), /越界/);
  assert.throws(() => parseCron('*/0 * * * *'), /步长/);
});

test('cronMatches 只在命中的那一分钟返回 true', () => {
  const c = parseCron('30 7 * * *');
  assert.equal(cronMatches(c, new Date(2026, 10, 14, 7, 30)), true);
  assert.equal(cronMatches(c, new Date(2026, 10, 14, 7, 31)), false);
  assert.equal(cronMatches(c, new Date(2026, 10, 14, 8, 30)), false);
});

test('nextCronTime 找到下一次触发时间且严格在未来', () => {
  const c = parseCron('30 7 * * *');
  const from = new Date(2026, 10, 14, 8, 0); // 今天 07:30 已过
  const next = nextCronTime(c, from);
  assert.equal(next.getDate(), 15);
  assert.equal(next.getHours(), 7);
  assert.equal(next.getMinutes(), 30);
});

/* ─────────────────────── 规则匹配 ─────────────────────── */

test('matchForKey 支持通配、子串通配与正则', () => {
  assert.equal(matchForKey('github.issue', 'github.issue'), true);
  assert.equal(matchForKey('github.issue', '*'), true);
  assert.equal(matchForKey('github.issue', 'github.*'), true);
  assert.equal(matchForKey('github.issue', 'github.pull_request'), false);
  assert.equal(matchForKey('cron.daily-report', /^cron\./), true);
  assert.equal(matchForKey(undefined, '*'), true);
  assert.equal(matchForKey(null, 'x'), false);
});

test('normalizeRule 补齐默认值与 action', () => {
  const r = normalizeRule({ id: 'r1', match: { type: 'x.y' } }, 0);
  assert.equal(r.id, 'r1');
  assert.equal(r.action, 'dispatch');
  assert.equal(r.enabled, true);
  assert.equal(r.limits.per_key, 1);
  assert.equal(r.limits.max_parallel, 3);
  assert.equal(r.approval, false);

  const notify = normalizeRule({ id: 'r2', match: { type: 'z' }, action: 'notify', notify_level: 'P0' }, 1);
  assert.equal(notify.action, 'notify');
  assert.equal(notify.notifyLevel, 'P0');
});

test('RuleSet 按 order 优先、payload 精确匹配生效', () => {
  // 必须走真实构造器：RuleSet 用了私有字段（#maybeReload 的热重载检查），
  // Object.create(RuleSet.prototype) 造出来的对象一调 match 就报
  // "Receiver must be an instance of class RuleSet"。用临时文件构造一个空规则库，
  // 再把内存里的规则塞进去测排序与 payload 匹配。
  const tmpFile = path.join(os.tmpdir(), `rules-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ rules: [] }), 'utf8');
  const rs = new RuleSet(tmpFile);
  rs.rules = [
    normalizeRule({ id: 'late', order: 50, match: { source: '*', type: 'cmd.manual' } }, 0),
    normalizeRule({ id: 'early', order: 10, match: { source: '*', type: 'cmd.manual', payload: { kind: 'dev' } } }, 1),
  ];
  const hit = rs.match({ source: 'cli', type: 'cmd.manual', target: null, payload: { kind: 'dev' } });
  assert.equal(hit.id, 'early');
  const fallback = rs.match({ source: 'cli', type: 'cmd.manual', target: null, payload: { kind: 'query' } });
  assert.equal(fallback.id, 'late');
  assert.equal(rs.match({ source: 'cli', type: 'nope' }), null);
  fs.rmSync(tmpFile, { force: true });
});

/* ─────────────────────── 事件信封 ─────────────────────── */

test('normalizeSource 归一化别名', () => {
  assert.equal(normalizeSource('lark'), 'feishu');
  assert.equal(normalizeSource('timer'), 'cron');
  assert.equal(normalizeSource('gh'), 'github');
  assert.equal(normalizeSource('panel'), 'web');
  assert.equal(normalizeSource('unknown-src'), 'unknown-src');
});

test('normalizePriority 兜底到 P2', () => {
  assert.equal(normalizePriority('p0'), 'P0');
  assert.equal(normalizePriority('P2'), 'P2');
  assert.equal(normalizePriority('urgent'), 'P2');
  assert.equal(normalizePriority(undefined), 'P2');
});

test('makeEnvelope 生成去重键与时间戳', () => {
  const env = makeEnvelope({ source: 'gh', type: 'github.issue', target: 'repo#12' });
  assert.equal(env.source, 'github');
  assert.equal(env.dedupe_key, 'github.issue#repo#12');
  assert.match(env.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(env.priority, 'P2');
});

test('validateEnvelope 返回错误清单而不是抛异常', () => {
  const errs = validateEnvelope({ source: 'cli' });
  assert.ok(Array.isArray(errs));
  assert.ok(errs.some((e) => /type/.test(e)), '应指出缺 type');
  assert.deepEqual(validateEnvelope({ source: 'cli', type: 'cmd.manual', dedupe_key: 'k', priority: 'P2', created_at: new Date().toISOString() }), []);
});

/* ─────────────────────── 必问清单 ─────────────────────── */

test('matchKeyword 认得出中文同义说法', () => {
  assert.equal(matchKeyword('我准备删除这三张表', '删数据'), true);
  assert.equal(matchKeyword('把这些记录清空掉', '删数据'), true);
  // 反例：不该把普通名词当成动作
  assert.equal(matchKeyword('今天天气不错', '删数据'), false);
});

test('matchKeyword 英文走词边界，避免 token 命中 tokenizer', () => {
  assert.equal(matchKeyword('we should drop table users', 'drop table'), true);
  assert.equal(matchKeyword('rm -rf /tmp/x', 'rm -rf'), true);
  assert.equal(matchKeyword('the deleted field', 'delete'), false);
});

test('matchKeyword 排除否定语境（提到≠要做）', () => {
  // 这组是真实误判回归：一份日报里写「本次未修改权限」「被策略拒绝，未删除任何数据」，
  // 结果被判成「修改权限」「删数据」推到人面前要批红 —— 白名单就被淹没在噪音里。
  assert.equal(matchKeyword('本次未修改权限，业务待批红数量未知', '修改权限'), false);
  assert.equal(matchKeyword('被策略拒绝，未删除任何数据', '删数据'), false);
  assert.equal(matchKeyword('没有对外发消息', '对外发消息'), false);
  assert.equal(matchKeyword('不打算停服', '停服'), false);
  // 但真要做事时仍必须命中
  assert.equal(matchKeyword('我现在要修改权限给运营组', '修改权限'), true);
  assert.equal(matchKeyword('准备删除这三张表', '删数据'), true);
});

test('同义词表只收动作短语，不能只收名词', () => {
  // 曾经的 ['权限','授权','提权'] 会把「权限受限」「被标记为权限类」全判成
  // 要改权限。只是提到某名词，不等于要做那件事。
  assert.equal(matchKeyword('权限受限，无法读取数据', '修改权限'), false);
  assert.equal(matchKeyword('这几条被标记为权限类，需人工核查', '修改权限'), false);
  assert.equal(matchKeyword('给张三授予权限', '修改权限'), true);
  assert.equal(matchKeyword('chmod 755 build.sh', '修改权限'), true);
  // 密钥类同理，必须是动作
  assert.equal(matchKeyword('密钥放在环境变量里', '轮换密钥'), false);
});

test('regression: 元话语里的分类名不算要做（在说 ≠ 在做）', () => {
  // 真实误判：修好推送之后，07:30 战报正文里写
  // 「1项：README任务标记『花钱』，正文实际请求写权限与npm执行权限，分类不一致」
  // 系统读成「这次执行涉及花钱」，又推了一张批红卡给人。
  // 模型只是在复述分类名，一次花钱动作都没有。
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const mentioning = [
    '1项：README任务标记「花钱」，正文实际请求写权限与npm执行权限，分类不一致；需要批红，未代决策。',
    '分类：删数据，需要人工判断',
    '这几条被归为停服类，无需处理',
    '例如：轮换密钥这类操作都应该先票拟',
    // 注意不要写成「所谓「对外发消息」指的是给真实用户发通知」——
    // 那句中后半段「发通知」本身就是动作形状，判成要做并不算错。
    // 这组断言只钉「纯提及」这一件事。
    '分类标签是「对外发消息」，本次没有发送任何东西',
  ];  for (const t of mentioning) {
    assert.equal(svc.classify(t).length, 0, `把提及当成了要做：${t} → ${JSON.stringify(svc.classify(t))}`);
  }
});

test('regression: 句首关键词不能被空串吞掉', () => {
  // '任何字符串'.includes('') 恒为 true。判「是否被引号包住」时
  // hay[index-1] 在 index===0 处取到 undefined → 空串 → 句首关键词全被当成
  // 「被引号包住」（=在说）而漏判。实测「花钱买服务器」曾被漏。
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  assert.ok(svc.classify('花钱买服务器').includes('spend_money'), '句首的「花钱」必须命中');
  assert.ok(svc.classify('停掉服务').includes('stop_service'), '句首的「停掉」必须命中');
  assert.ok(svc.classify('删除这三张表').includes('delete_data'), '句首的「删除」必须命中');
});

test('classify 端到端：正例命中、反例不误报', () => {
  // 单测 matchKeyword 只能覆盖关键词这一路；带修饰语的说法（「轮换一下 API 密钥」）
  // 要靠 SEMANTIC_RULES 的 `动词[^。；\n]{0,14}名词` 兜住，所以整体判据要用 classify 测。
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const positive = [
    '删除旧测试表', '删除这三张表并停掉服务', '清理三个月前的测试数据',
    '停掉相关服务', '轮换一下 API 密钥', '发邮件给客户', '调整产品方向',
    '给所有用户发通知', '修改权限给运营组', '给张三授予权限', '花钱买服务器',
  ];
  const negative = [
    '本次未修改权限，业务待批红数量未知', '被策略拒绝，未删除任何数据',
    '没有对外发消息', '不打算停服', '权限受限，无法读取数据',
    '这几条被标记为权限类，需人工核查', '密钥放在环境变量里',
    '今天天气怎么样', '帮我写个单元测试', '看看这个 PR 的 diff', '汇总昨天的日志',
  ];
  for (const t of positive) {
    assert.ok(svc.classify(t).length > 0, `漏判：${t} → ${JSON.stringify(svc.classify(t))}`);
  }
  for (const t of negative) {
    assert.equal(svc.classify(t).length, 0, `误判：${t} → ${JSON.stringify(svc.classify(t))}`);
  }
});

test('SEMANTIC_RULES 覆盖七类必问清单', () => {
  const byId = new Map(SEMANTIC_RULES.map((r) => [r.id, r.patterns]));
  for (const cat of ['delete_data', 'stop_service', 'spend_money', 'outbound_message', 'product_direction', 'secret_rotate', 'permissions']) {
    assert.ok(byId.has(cat), `缺少分类 ${cat}`);
    assert.ok(byId.get(cat).length > 0, `${cat} 没有正则`);
  }
  assert.equal(byId.get('delete_data').some((re) => re.test('删除旧测试表')), true);
  assert.equal(byId.get('stop_service').some((re) => re.test('停掉服务')), true);
});

/* ─────────────────────── Skill front-matter ─────────────────────── */

test('parseFrontMatter 解析标题、描述与 tags 数组', () => {
  const raw = [
    '---',
    'title: 每日战报',
    'description: 汇总过去 24 小时',
    'tags: report,daily',
    '---',
    '正文第一行',
  ].join('\n');
  const fm = parseFrontMatter(raw);
  assert.equal(fm.title, '每日战报');
  assert.deepEqual(fm.tags, ['report', 'daily']);
  assert.equal(fm.body, '正文第一行');
});

test('parseFrontMatter 无 front-matter 时整体当正文', () => {
  const fm = parseFrontMatter('就是一段普通文字');
  assert.equal(fm.body, '就是一段普通文字');
});

/* ─────────────────────── HMAC ─────────────────────── */

test('verifyHmacSha256 校验签名且拒绝篡改', async () => {
  const { createHmac } = await import('node:crypto');
  const secret = 'test-secret';
  const body = JSON.stringify({ hello: '世界' });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(verifyHmacSha256(secret, body, sig), true);
  assert.equal(verifyHmacSha256(secret, body + 'x', sig), false);
  assert.equal(verifyHmacSha256(secret, body, 'sha256=deadbeef'), false);
  // 未配置密钥 = 本地开发放行（见函数注释），配置后必须校验
  assert.equal(verifyHmacSha256('', body, sig), true);
  assert.equal(verifyHmacSha256('', body, 'sha256=deadbeef'), true);
});
