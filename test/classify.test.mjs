/**
 * 分类口径测试（2026-11-17 老板定版）：
 *   1) 查询分类的反馈决策（已阅/采纳/驳回/改派）；
 *   2) 删除豁免——过程/tmp 文件不算「删数据」；
 *   3) 花钱豁免——讨论/采购不算「花钱」。
 *   node --test test/classify.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ApprovalService, matchKeyword, OPTION_LABELS, optionButtonStyle } from '../src/m5/approvals.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { openLedger } from '../src/lib/ledger.mjs';

/* ─────────────────────────── 豁免：删除 ─────────────────────────── */

test('删除豁免：过程/tmp 文件不算删除事项', () => {
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const exempt = [
    '清理 tmp 目录下的构建产物',
    '删除临时文件和缓存',
    '删掉 dist 目录重新打包',
    '清空缓存目录',
    'rm -rf /tmp/build-cache',
    '把过程文件移到 tmp/ 留存',
    '清理编译产物以释放磁盘',
  ];
  for (const t of exempt) {
    assert.equal(svc.classify(t).includes('delete_data'), false, `误判成删除事项：${t} → ${JSON.stringify(svc.classify(t))}`);
  }
});

test('删除豁免不放过真实数据：受保护对象同句出现即作废', () => {
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const mustHit = [
    '删除数据库里的旧表',
    '清空用户数据',
    '删除配置文件',
    '删掉这三张表',
    '清理生产数据和缓存',   // 同句有真实数据 → 不能因为「缓存」二字放行
  ];
  for (const t of mustHit) {
    assert.ok(svc.classify(t).includes('delete_data'), `漏判：${t} → ${JSON.stringify(svc.classify(t))}`);
  }
});

/* ─────────────────────────── 豁免：花钱 ─────────────────────────── */

test('花钱豁免：讨论、询价、采购、预算不算花钱事项', () => {
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const exempt = [
    '讨论一下服务器的采购方案',
    '对比几家云厂商的价格',
    '评估一下升级套餐的成本',
    '预算 3000 元采购监控服务',
    '这个方案成本太高，换个思路',
    '帮老板询价：企业版订阅费多少钱',
  ];
  for (const t of exempt) {
    assert.equal(svc.classify(t).includes('spend_money'), false, `误判成花钱事项：${t} → ${JSON.stringify(svc.classify(t))}`);
  }
});

test('花钱豁免不放过真支付动作', () => {
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const mustHit = [
    '花钱买服务器',
    '给账户充值 100 元',
    '今天必须付费开通监控服务',
    '讨论完了就直接续费域名',
    '下单购买企业版',
  ];
  for (const t of mustHit) {
    assert.ok(svc.classify(t).includes('spend_money'), `漏判：${t} → ${JSON.stringify(svc.classify(t))}`);
  }
});

test('matchKeyword 第三参数（分类 id）驱动豁免，缺省行为不变', () => {
  // 不传分类 id：删除关键词照旧命中（老调用点/老测试不受影响）
  assert.equal(matchKeyword('清理 tmp 目录下的构建产物'.toLowerCase(), '清理'), true);
  // 传 delete_data：tmp 豁免生效
  assert.equal(matchKeyword('清理 tmp 目录下的构建产物'.toLowerCase(), '清理', 'delete_data'), false);
});

/* ─────────────────────────── 查询反馈：已阅/采纳/驳回/改派 ─────────────────────────── */

/** 临时台账 + 最小通知桩，构造一个能真跑 decide 的 ApprovalService */
function makeService() {
  const dbPath = path.join(os.tmpdir(), `classify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const ledger = openLedger(dbPath);
  const svc = new ApprovalService({
    ledger,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: loadConfig(),
    notifier: { notify: async () => ({ ok: true, channel: 'local', id: 'n1' }) },
  });
  return { svc, ledger, cleanup: () => { svc.stop?.(); try { fs.rmSync(dbPath, { force: true }); } catch { /* Windows 句柄延迟 */ } } };
}

test('已阅：pending → executed，问题记入决定记忆，不碰任务', async () => {
  const { svc, ledger, cleanup } = makeService();
  try {
    const a = await svc.create({ title: '为什么巡检每天 18:00 跑', question: '答复正文', category: 'query', options: ['ack', 'adopt', 'reject', 'revise'] });
    const res = await svc.decide(a.approval_id, { decision: 'ack', by: 'boss' });
    assert.equal(res.ok, true);
    assert.equal(res.approval.status, 'executed');
    const d = ledger.get('SELECT * FROM decisions WHERE source_approval=?', a.approval_id);
    assert.ok(d, '已阅要写决定记忆（记录问题下来）');
    assert.match(d.text, /已阅/);
  } finally { cleanup(); }
});

test('采纳：pending → approved，并触发 onAdopt 把建议派成任务', async () => {
  const { svc, ledger, cleanup } = makeService();
  try {
    const adopted = [];
    svc.onAdopt = async ({ approval }) => { adopted.push(approval.approval_id); };
    const a = await svc.create({
      title: '要不要给 README 加英文版',
      question: '答复：建议加',
      proposal: '### 下一步的执行建议\n1. 新建 README.en.md',
      category: 'query', options: ['ack', 'adopt', 'reject', 'revise'],
    });
    const res = await svc.decide(a.approval_id, { decision: 'adopt', by: 'boss' });
    assert.equal(res.ok, true);
    assert.equal(res.approval.status, 'approved');
    assert.deepEqual(adopted, [a.approval_id], '采纳必须触发 onAdopt（按建议执行）');
    const d = ledger.get('SELECT * FROM decisions WHERE source_approval=?', a.approval_id);
    assert.match(d.text, /已采纳/);
  } finally { cleanup(); }
});

test('驳回：查询反馈只做记录，不把查询事件打成 rejected', async () => {
  const { svc, ledger, cleanup } = makeService();
  try {
    const now = new Date().toISOString();
    ledger.run(
      `INSERT INTO events(event_id,source,type,target,summary,link,dedupe_key,priority,status,rule_id,payload,created_at,updated_at,duplicate_of)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'ev-q1', 'feishu', 'feishu.message', 'ou_x', '查询', null, 'k1', 'P3', 'completed', 'r14', '{}', now, now, null,
    );
    const a = await svc.create({ title: '查询答复', question: 'q', category: 'query', options: ['ack', 'adopt', 'reject', 'revise'], eventId: 'ev-q1' });
    const res = await svc.decide(a.approval_id, { decision: 'reject', note: '不用了', by: 'boss' });
    assert.equal(res.ok, true);
    assert.equal(res.approval.status, 'rejected');
    const ev = ledger.get('SELECT status FROM events WHERE event_id=?', 'ev-q1');
    assert.equal(ev.status, 'completed', '查询驳回 = 不做任何操作，事件状态不该被改');
    const d = ledger.get("SELECT * FROM decisions WHERE source_approval=? AND kind='refused'", a.approval_id);
    assert.ok(d, '驳回记入「定了不做的事」');
  } finally { cleanup(); }
});

test('驳回：非查询类票拟照旧把事件打成 rejected（原行为不变）', async () => {
  const { svc, ledger, cleanup } = makeService();
  try {
    const now = new Date().toISOString();
    ledger.run(
      `INSERT INTO events(event_id,source,type,target,summary,link,dedupe_key,priority,status,rule_id,payload,created_at,updated_at,duplicate_of)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'ev-d1', 'cron', 'cron.cleanup', null, '大扫除', null, 'k2', 'P2', 'running', 'r09', '{}', now, now, null,
    );
    const a = await svc.create({ title: '删除过期日志', question: '批不批？', category: 'delete_data', eventId: 'ev-d1' });
    const res = await svc.decide(a.approval_id, { decision: 'reject', note: '再放一周', by: 'boss' });
    assert.equal(res.ok, true);
    const ev = ledger.get('SELECT status FROM events WHERE event_id=?', 'ev-d1');
    assert.equal(ev.status, 'rejected');
  } finally { cleanup(); }
});

test('改派与重新票拟：查询反馈卡保留自己的按钮组', async () => {
  const { svc, cleanup } = makeService();
  try {
    const a = await svc.create({ title: 'q', question: 'q', category: 'query', options: ['ack', 'adopt', 'reject', 'revise'] });
    const rev = await svc.decide(a.approval_id, { decision: 'revise', note: '补充数据来源', by: 'boss' });
    assert.equal(rev.approval.status, 'revising');
    const re = await svc.resubmit(a.approval_id, { proposal: '补充后的方案', by: 'worker' });
    assert.equal(re.ok, true);
    assert.equal(re.approval.status, 'pending');
    assert.deepEqual(re.approval.options, ['ack', 'adopt', 'reject', 'revise']);
  } finally { cleanup(); }
});

test('非法决策名照旧被拒', async () => {
  const { svc, cleanup } = makeService();
  try {
    const a = await svc.create({ title: 't', question: 'q', category: 'query' });
    const res = await svc.decide(a.approval_id, { decision: 'whatever', by: 'boss' });
    assert.equal(res.ok, false);
    assert.match(res.error, /决策非法/);
  } finally { cleanup(); }
});

/* ─────────────────────────── 按钮标签 ─────────────────────────── */

test('按钮标签与风格：查询反馈卡四按钮、批红卡三按钮', () => {
  assert.equal(OPTION_LABELS.ack, '已阅');
  assert.equal(OPTION_LABELS.adopt, '采纳');
  assert.equal(OPTION_LABELS.reject, '驳回');
  assert.equal(OPTION_LABELS.revise, '改派');
  assert.equal(OPTION_LABELS.agree, '批');
  assert.equal(optionButtonStyle('adopt'), 'primary');
  assert.equal(optionButtonStyle('agree'), 'primary');
  assert.equal(optionButtonStyle('reject'), 'danger');
  assert.equal(optionButtonStyle('ack'), 'default');
});

test('renderCardText 的「可选」行跟随票拟单 options', () => {
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const queryCard = svc.renderCardText({
    title: 'q', question: '看下面', proposal: '建议…', approval_id: 'apq1',
    category: 'query', category_label: '查询', options: ['ack', 'adopt', 'reject', 'revise'],
  });
  assert.match(queryCard, /已阅 \/ 采纳 \/ 驳回 \/ 改派/);
  assert.match(queryCard, /采纳才会把建议派成任务/);
  const approvalCard = svc.renderCardText({
    title: 't', question: '批不批？', approval_id: 'apa1',
    category: 'delete_data', category_label: '删数据', options: ['agree', 'reject', 'revise'],
  });
  assert.match(approvalCard, /批 \/ 驳回 \/ 改派/);
  assert.match(approvalCard, /超时不会默认同意/);
});
