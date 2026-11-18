import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebhookAdapter } from '../src/m1/webhook-adapter.mjs';
import { CronScheduler } from '../src/m1/cron-adapter.mjs';
import { RuleSet } from '../src/lib/rules.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { validateEnvelope } from '../src/lib/envelope.mjs';

/**
 * M1 入口适配器测试。
 *
 * 这些代码在 e2e 里只被绕过：e2e 直接调 hub.ingest()，从没走过
 * WebhookAdapter 的翻译逻辑和 CronScheduler 的到点判定。
 * 而它们恰恰是「外部世界 → 系统内部」的唯一关口，翻译错了整条链路全错。
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeAdapter(overrides = {}) {
  const config = loadConfig();
  config.github.allowedRepos = overrides.allowedRepos ?? ['acme/shop'];
  return new WebhookAdapter({ config, events: null, log: silentLog });
}

const ghHeaders = (event, delivery = 'd-1') => ({
  'x-github-event': event,
  'x-github-delivery': delivery,
});

// ---------- WebhookAdapter.github ----------

test('github: issues.opened 翻译成 github.issue 信封', () => {
  const a = makeAdapter();
  const env = a.github(ghHeaders('issues'), {
    action: 'opened',
    repository: { full_name: 'acme/shop' },
    issue: { number: 42, title: '下单页 500', body: 'b'.repeat(5000), html_url: 'https://github.com/acme/shop/issues/42', user: { login: 'tonj' }, labels: [{ name: 'bug' }] },
  });
  assert.equal(env.source, 'github');
  assert.equal(env.type, 'github.issue');
  assert.equal(env.target, 'acme/shop');
  assert.equal(env.summary, '#42 下单页 500');
  assert.equal(env.dedupe_key, 'github.issue#acme/shop#42');
  assert.equal(env.priority, 'P2');
  assert.deepEqual(env.payload.labels, ['bug']);
  // 长正文必须截断，否则会把整篇 issue 塞进提示词
  assert.equal(env.payload.issue_body.length, 4001, '4000 字符 + 省略号');
  assert.ok(env.payload.issue_body.endsWith('…'));
});

test('github: ping 只确认 webhook，不生成业务事件', () => {
  const a = makeAdapter();
  const env = a.github(ghHeaders('ping'), {
    zen: 'Keep it logically awesome.',
    repository: { full_name: 'acme/shop' },
  });
  assert.equal(env, null);
});

test('github: issues 的非 opened 动作要抛 UNHANDLED，不能静默变成任务', () => {
  const a = makeAdapter();
  assert.throws(
    () => a.github(ghHeaders('issues'), { action: 'closed', repository: { full_name: 'acme/shop' }, issue: { number: 1 } }),
    (err) => err.code === 'UNHANDLED',
  );
});

test('github: pull_request 只有四种决策性动作才进系统', () => {
  const a = makeAdapter();
  const pr = { number: 7, title: 'fix', html_url: 'https://x/pull/7', head: { ref: 'f' }, base: { ref: 'main' } };
  for (const action of ['opened', 'reopened', 'synchronize', 'closed']) {
    const env = a.github(ghHeaders('pull_request'), { action, repository: { full_name: 'acme/shop' }, pull_request: pr });
    assert.equal(env.type, 'github.pull_request');
    // 去重键必须带 action，否则 opened 与 closed 会被判成同一件事
    assert.equal(env.dedupe_key, `github.pr#acme/shop#7#${action}`);
  }
  assert.throws(
    () => a.github(ghHeaders('pull_request'), { action: 'labeled', repository: { full_name: 'acme/shop' }, pull_request: pr }),
    (err) => err.code === 'IGNORED',
  );
});

test('github: CI 失败才是 P0，成功事件必须忽略', () => {
  const a = makeAdapter();
  const env = a.github(ghHeaders('workflow_run'), {
    repository: { full_name: 'acme/shop' },
    workflow_run: { conclusion: 'failure', html_url: 'https://x/run/1' },
  });
  assert.equal(env.type, 'release.failed');
  assert.equal(env.priority, 'P0', 'CI 失败是告警级，必须即时强提醒');
  for (const conclusion of ['success', 'cancelled', null]) {
    assert.throws(
      () => a.github(ghHeaders('workflow_run'), { repository: { full_name: 'acme/shop' }, workflow_run: { conclusion } }),
      (err) => err.code === 'IGNORED',
      `conclusion=${conclusion} 不该进系统`,
    );
  }
});

test('github: allowlist 挡住非白名单仓库', () => {
  const a = makeAdapter({ allowedRepos: ['acme/shop'] });
  assert.throws(
    () => a.github(ghHeaders('issues'), { action: 'opened', repository: { full_name: 'stranger/repo' }, issue: { number: 1 } }),
    (err) => err.code === 'REPO_NOT_ALLOWED',
  );
  // 白名单内的照常通过
  const ok = a.github(ghHeaders('issues'), { action: 'opened', repository: { full_name: 'acme/shop' }, issue: { number: 2, title: 'x' } });
  assert.equal(ok.target, 'acme/shop');
});

test('github: allowlist 为空时拒绝所有仓库', () => {
  const a = makeAdapter({ allowedRepos: [] });
  assert.throws(
    () => a.github(ghHeaders('issues'), { action: 'opened', repository: { full_name: 'anyone/anything' }, issue: { number: 9, title: 'y' } }),
    (err) => err.code === 'REPO_NOT_ALLOWED',
  );
});

// ---------- WebhookAdapter.generic / manual / feishu ----------

test('generic: 非法的 level 要落回 P1，不能原样透传', () => {
  const a = makeAdapter();
  const env = a.generic({ level: 'CRITICAL', title: '磁盘满' });
  assert.equal(env.source, 'monitor');
  assert.equal(env.priority, 'P1');
  assert.equal(env.summary, '磁盘满');
  // 没给 key 时用标题兜底，保证同一告警能去重
  assert.equal(env.dedupe_key, 'monitor.alert#磁盘满');
});

test('manual: 同 target 两次提交必须视作两条（显式 dedupe_key 优先）', () => {
  const a = makeAdapter();
  const e1 = a.manual({ engine: 'mock', summary: '手动一' });
  const e2 = a.manual({ engine: 'mock', summary: '手动二', dedupe_key: 'manual-2' });
  assert.equal(e2.dedupe_key, 'manual-2');
  // 不显式给时带 Date.now()，所以两次不会误判成重复
  assert.notEqual(e1.dedupe_key, e2.dedupe_key);
});

test('feishu: 消息文本能从 post 富文本里抽出来', () => {
  const a = makeAdapter();
  const env = a.feishu({
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        content: JSON.stringify({ title: '标题', content: [[{ tag: 'text', text: '第一段' }], [{ tag: 'text', text: '第二段' }]] }),
      },
    },
  });
  assert.equal(env.type, 'feishu.message');
  assert.equal(env.target, 'ou_1');
  assert.equal(env.payload.text, '第一段\n第二段');
  assert.equal(env.dedupe_key, 'feishu.msg#om_1');
});

test('feishu: @ 占位符不能进指令（群聊里每条都要 @ 机器人）', () => {
  const a = makeAdapter();
  const mk = (text) => a.feishu({
    event: { message: { message_id: 'om_x', chat_id: 'oc_1', content: JSON.stringify({ text }) } },
  });
  // 飞书把 @某人 换成 @_user_N，@所有人 换成 @_all
  assert.equal(mk('@_user_1 现在工作状态报告').summary, '现在工作状态报告');
  assert.equal(mk('@_user_1 现在工作状态报告').payload.text, '现在工作状态报告');
  assert.equal(mk('@_all 汇报一下今天的情况').payload.text, '汇报一下今天的情况');
  // dev: 前缀判定要在剥掉 @ 之后 —— 否则「@_user_1 dev: xxx」认不出是开发任务
  assert.equal(mk('@_user_1 dev: 给 README 加 FAQ').payload.dev, true);
  // 只有 @ 没有正文：不能派一个空任务出去
  assert.throws(() => mk('@_user_1'), (e) => e.code === 'EMPTY_TEXT');
});

test('feishu: 卡片按钮回调翻译成 feishu.card_action', () => {
  const a = makeAdapter();
  const env = a.feishu({
    event: { event_id: 'e-1', sender: { sender_id: { open_id: 'ou_2' } } },
    action: { value: { action: 'approval:agree', approval_id: 'apr_1' } },
  });
  assert.equal(env.type, 'feishu.card_action');
  assert.equal(env.target, 'apr_1');
  assert.equal(env.payload.action, 'approval:agree');
});

test('feishu: 没有文本也没有动作时要报 EMPTY_TEXT', () => {
  const a = makeAdapter();
  assert.throws(() => a.feishu({ event: { message: { content: JSON.stringify({}) } } }),
    (err) => err.code === 'EMPTY_TEXT');
});

test('feishu v2: schema 2.0 的卡片按钮回调也要能认出来', () => {
  // 回归（2026-11-14）：卡片交互回调换成 schema 2.0 后，action 藏在 body.event.action，
  // 只认 body.action 的旧代码会把按钮点击掉进消息分支然后 EMPTY_TEXT。
  const a = makeAdapter();
  const env = a.feishu({
    schema: '2.0',
    header: { event_id: 'v2-1' },
    event: {
      action: { value: { action: 'approval:reject', approval_id: 'apr_v2' } },
      operator: { operator_id: { open_id: 'ou_v2' } },
    },
  });
  assert.equal(env.type, 'feishu.card_action');
  assert.equal(env.target, 'apr_v2');
  assert.equal(env.payload.action, 'approval:reject');
  assert.equal(env.payload.operator, 'ou_v2');
});

test('feishu: dev: 前缀翻译成开发任务标记', () => {
  const a = makeAdapter();
  const dev = a.feishu({ event: { message: { message_id: 'd1', content: JSON.stringify({ text: ' dev：修复登录页超时' }) } } });
  assert.equal(dev.payload.dev, true);
  assert.equal(dev.payload.text, '修复登录页超时');
  const plain = a.feishu({ event: { message: { message_id: 'd2', content: JSON.stringify({ text: '查询今天的战报' }) } } });
  assert.equal(plain.payload.dev, false);
  assert.equal(plain.payload.text, '查询今天的战报');
});

test('regression: 所有适配器输出都必须符合统一信封契约', () => {
  // 曾经的坑：feishu() 手搓对象返回，缺 created_at / link。
  // 因为 EventService.ingest() 会再 makeEnvelope 一次，问题被掩盖了；
  // 但任何直接消费适配器输出的地方（测试、CLI、将来的入口）都会拿到残信封。
  const a = makeAdapter();
  const cases = {
    'github.issue': a.github(ghHeaders('issues'), {
      action: 'opened', repository: { full_name: 'acme/shop' }, issue: { number: 1, title: 't' },
    }),
    'github.pr': a.github(ghHeaders('pull_request'), {
      action: 'opened', repository: { full_name: 'acme/shop' }, pull_request: { number: 2, title: 'p' },
    }),
    'github.ci': a.github(ghHeaders('workflow_run'), {
      repository: { full_name: 'acme/shop' }, workflow_run: { conclusion: 'failure' },
    }),
    monitor: a.generic({ level: 'P0', title: '告警' }),
    manual: a.manual({ summary: '手动' }),
    'feishu.message': a.feishu({ event: { message: { message_id: 'm', content: JSON.stringify({ text: 'hi' }) } } }),
    'feishu.card_action': a.feishu({ event: { event_id: 'e' }, action: { value: { action: 'approval:agree', approval_id: 'apr_1' } } }),
  };
  for (const [name, env] of Object.entries(cases)) {
    const errs = validateEnvelope(env);
    assert.deepEqual(errs, [], `${name} 的信封不合法：${errs.join('; ')}`);
    assert.ok(env.created_at && !Number.isNaN(Date.parse(env.created_at)), `${name} 缺 created_at`);
    assert.ok('link' in env, `${name} 缺 link 字段`);
    assert.ok('payload' in env && typeof env.payload === 'object', `${name} 缺 payload`);
  }
});

// ---------- CronScheduler ----------

function writeRules(obj) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cron-test-')), 'rules.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

function makeCron(rulesObj, ingested) {
  const config = loadConfig();
  config.cron.enabled = true;
  const rules = new RuleSet(writeRules(rulesObj));
  const events = {
    async ingestAsync(env) {
      ingested.push(env);
      return { ok: true, event_id: 'evt_test', duplicate: false };
    },
  };
  const sched = new CronScheduler({ config, events, log: silentLog });
  sched.loadFromRules(rules);
  return sched;
}

test('cron: 从 rules.json 的 schedule 字段生成定时器', () => {
  const sched = makeCron({
    rules: [{
      id: 'r-x', order: 1,
      match: { source: 'cron', type: 'cron.daily-report' },
      route: { engine: 'mock' },
      schedule: { cron: '30 7 * * *', name: '每日战报' },
    }],
  }, []);
  assert.equal(sched.timers.length, 1);
  const d = sched.describe()[0];
  assert.equal(d.id, 'r-x');
  assert.equal(d.name, '每日战报');
  assert.equal(d.cron, '30 7 * * *');
  assert.ok(d.next, '应该算出了下一次触发时间');
});

test('cron: schedule.enabled=false 的规则不生成定时器', () => {
  const sched = makeCron({
    rules: [{ id: 'r-off', match: { type: 'cron.x' }, route: { engine: 'mock' }, schedule: { cron: '0 1 * * *', enabled: false } }],
  }, []);
  assert.equal(sched.timers.length, 0);
});

test('cron: 非法表达式不崩，只是跳过并记日志', () => {
  const errors = [];
  const log = { ...silentLog, error: (m, ctx) => errors.push({ m, ...ctx }) };
  const config = loadConfig();
  const rules = new RuleSet(writeRules({
    rules: [{ id: 'r-bad', match: { type: 'cron.bad' }, route: { engine: 'mock' }, schedule: '99 99 * * *' }],
  }));
  const sched = new CronScheduler({ config, events: { async ingestAsync() {} }, log });
  assert.equal(sched.loadFromRules(rules), 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'r-bad');
});

test('cron: 到点才投递，同一分钟内只投一次', async () => {
  const ingested = [];
  const sched = makeCron({
    rules: [{ id: 'r-min', match: { source: 'cron', type: 'cron.every-minute' }, route: { engine: 'mock' }, schedule: '5 4 * * *' }],
  }, ingested);

  // 04:04 —— 不匹配
  const miss = await sched.tick(new Date(2026, 10, 14, 4, 4, 30));
  assert.equal(miss.length, 0);
  assert.equal(ingested.length, 0);

  // 04:05 —— 匹配
  const hit = await sched.tick(new Date(2026, 10, 14, 4, 5, 10));
  assert.equal(hit.length, 1);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].source, 'cron');
  assert.equal(ingested[0].type, 'cron.every-minute');
  // payload 里要带上触发时间与 cron，方便事后追查「这次是谁触发的」
  assert.equal(ingested[0].payload.cron, '5 4 * * *');
  assert.ok(ingested[0].payload.fired_at);

  // 同一分钟再 tick —— 不重复投递
  const again = await sched.tick(new Date(2026, 10, 14, 4, 5, 45));
  assert.equal(again.length, 0, '同一分钟只触发一次');
  assert.equal(ingested.length, 1);
});

test('cron: 投递失败不抛异常，记进 history', async () => {
  const config = loadConfig();
  const rules = new RuleSet(writeRules({
    rules: [{ id: 'r-fail', match: { source: 'cron', type: 'cron.fail' }, route: { engine: 'mock' }, schedule: '* * * * *' }],
  }));
  const sched = new CronScheduler({
    config,
    events: { async ingestAsync() { throw new Error('库写不进去'); } },
    log: silentLog,
  });
  sched.loadFromRules(rules);
  const res = await sched.tick(new Date(2026, 10, 14, 9, 0, 0));
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, false);
  assert.match(res[0].error, /库写不进去/);
  assert.equal(sched.history[0].ok, false);
  // history 只留最近 50 条，不能无限增长
  assert.ok(sched.history.length <= 50);
});
