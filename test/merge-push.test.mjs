/**
 * 「dev 双推」修复测试（2026-11-17）：
 *   飞书答复命中必问清单时，待批红信息并入答复一条推送，不再连发两道。
 *   - dev 类答复（skill≠query）命中必问清单 → 一张合成卡（正文+批红块+按钮），票拟单照常落库可批；
 *   - 查询类答复 → 仍只有一张查询反馈卡（不回归）；
 *   - 非飞书来源的产出 → 票拟照旧单独推卡（原行为不变）；
 *   - 飞书任务失败且涉及必问清单 → 失败回话与批红并一条推送。
 *   node --test test/merge-push.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 临时台账 + 真实 Hub（飞书关闭、cron 关闭、流水线不自动启动） */
async function makeHub(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hub-dual-${name}-`));
  process.env.HUB_DATA_DIR = tmp;
  const { loadConfig, ensureDirs } = await import('../src/lib/config.mjs');
  const config = loadConfig();
  config.pipeline = { ...config.pipeline, autoStart: false };
  config.cron.enabled = false;
  config.hub.secret = '';
  // 测试必须封闭：飞书未配置时推送降级本地通道，通知进台账可断言
  config.feishu = { ...config.feishu, enabled: false };
  ensureDirs(config);
  const { Hub } = await import('../src/hub.mjs');
  const hub = new Hub({ config });
  return {
    hub,
    cleanup: () => {
      try { hub.stop(); } catch { /* ignore */ }
      try { hub.ledger.close(); } catch { /* ignore */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
    },
  };
}

/** 派一个飞书来源的任务并完成它，返回 {task, added}（added = 这次新增的推送） */
async function runFeishuTask(hub, { dev = true, resultText, fail = false, error = null, key }) {
  const before = new Set(hub.ledger.all('SELECT notification_id n FROM notifications').map((r) => r.n));
  hub.ingest({
    source: 'feishu', type: 'feishu.message', target: 'ou_boss',
    summary: dev ? 'dev：修发布脚本' : '现在发布流程是什么',
    dedupe_key: `${key}-${Date.now()}-${Math.random().toString(36).slice(2)}`, priority: 'P2',
    payload: { text: dev ? 'dev：修发布脚本' : '现在发布流程是什么', ...(dev ? { dev: true } : {}), chat_id: 'oc_test' },
  }, 'test');
  const engines = dev ? ['claude-code', 'mock'] : ['claude-code', 'codex', 'mock'];
  const t = await hub.queue.poll({ nodeId: 'win-a', engines, waitSeconds: 2 });
  assert.ok(t, '任务能被领走');
  hub.queue.markRunning(t.task_id, 'win-a');
  if (fail) {
    // 真实链路里引擎 ok:false → queue.complete → 任务置 failed
    hub.queue.complete(t.task_id, 'win-a', { ok: false, error, engine: 'mock' });
  } else {
    hub.queue.complete(t.task_id, 'win-a', { ok: true, text: resultText, engine: 'mock' });
  }
  await hub.afterTaskUpdate(t.task_id);
  const added = hub.ledger.all('SELECT * FROM notifications').filter((r) => !before.has(r.notification_id));
  return { task: t, added };
}

test('dev 类飞书答复命中必问清单：答复与待批红并一条推送，不再连发两道', async () => {
  const { hub, cleanup } = await makeHub('dev');
  try {
    const { task, added } = await runFeishuTask(hub, {
      key: 'dual-dev',
      resultText: '完成：发布脚本已修。\n需要批红：生效要停掉服务 3 分钟，属短暂停服，需要批红后执行。',
    });
    // 之前是「票拟卡 + 答复文本」两条；现在必须只有一条
    assert.equal(added.length, 1, `应只推一条，实际 ${added.length} 条：${JSON.stringify(added.map((r) => [r.kind, r.title]))}`);
    assert.equal(added[0].kind, 'approval', '合并推送要带交互按钮（kind=approval 走卡片通道）');
    assert.match(added[0].title, /【待批红·停服】/, '标题保留待批红标记，便于过滤');
    assert.match(added[0].body, /发布脚本已修/, '答复正文在上');
    assert.match(added[0].body, /待批红/, '批红信息在下');
    assert.match(added[0].body, /超时不会默认同意/, '批红规矩照带');

    // 票拟单照常落库、待批、指向这条推送
    const ticket = hub.ledger.get('SELECT * FROM approvals WHERE task_id=?', task.task_id);
    assert.ok(ticket, '票拟单照常落库');
    assert.equal(ticket.status, 'pending', '票拟初始待批红');
    assert.equal(JSON.parse(added[0].ref).approval_id, ticket.approval_id, '推送挂的就是这张票拟');
    assert.equal(ticket.channel, 'local', '合并推送走了通知通道（飞书关闭降级 local）');

    // 批红链路照常可用：批掉之后票拟到 approved
    const decided = await hub.approvals.decide(ticket.approval_id, { decision: 'agree', note: '准', by: 'test' });
    assert.equal(decided.ok, true, '合并卡上的票拟仍可正常批红');
    assert.equal(decided.approval.status, 'approved');
  } finally { cleanup(); }
});

test('查询类飞书答复：仍只有一张查询反馈卡，不额外推批红卡（不回归）', async () => {
  const { hub, cleanup } = await makeHub('query');
  try {
    const { added } = await runFeishuTask(hub, {
      key: 'dual-query', dev: false,
      resultText: '问题分析：发布要停掉服务 3 分钟。\n执行建议：建议低峰停服，需要批红。',
    });
    assert.equal(added.length, 1, `查询答复只推一张反馈卡，实际 ${added.length} 条`);
    const ticket = hub.ledger.get(
      `SELECT * FROM approvals WHERE meta LIKE '%query_feedback%' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.ok(ticket, '查询反馈票拟存在');
    assert.equal(JSON.parse(ticket.options).includes('ack'), true, '查询反馈卡带已阅按钮');
    assert.equal(added[0].kind, 'approval');
    assert.equal(JSON.parse(added[0].ref).approval_id, ticket.approval_id);
    const escalations = hub.ledger.all(`SELECT * FROM approvals WHERE category <> 'query'`);
    assert.equal(escalations.length, 0, '查询任务不进必问票拟（2026-11-17 口径）');
  } finally { cleanup(); }
});

test('非飞书来源的产出命中必问清单：票拟照旧单独推卡（原行为不变）', async () => {
  const { hub, cleanup } = await makeHub('cron');
  try {
    const before = new Set(hub.ledger.all('SELECT notification_id n FROM notifications').map((r) => r.n));
    const d = await hub.dispatchManual({
      type: 'cmd.manual', target: 'host', summary: '巡检结论',
      engine: 'mock', node: 'win-a', priority: 'P2', source: 'cron',
      payload: { mock: { text: '结论：要停掉服务升级内核，请批准停机窗口。' } },
    });
    const t = await hub.queue.poll({ nodeId: 'win-a', engines: ['mock'], waitSeconds: 2 });
    hub.queue.complete(t.task_id, 'win-a', { ok: true, text: '结论：要停掉服务升级内核，请批准停机窗口。', engine: 'mock' });
    await hub.afterTaskUpdate(t.task_id);
    const added = hub.ledger.all('SELECT * FROM notifications').filter((r) => !before.has(r.notification_id));
    // 票拟卡（approval）+ 产出推送（P2 进聚合）各自独立，不属于「答复双推」
    const kinds = added.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['approval', 'task_result'], `非飞书来源保持两条独立推送：${JSON.stringify(kinds)}`);
    const ticket = hub.ledger.get('SELECT * FROM approvals WHERE task_id=?', t.task_id ?? d.task_id);
    assert.ok(ticket && ticket.channel !== 'merged', '票拟照旧带自己的推送（channel 不是 merged）');
    assert.match(ticket.title, /执行结果涉及「停服」/, '票拟落库标题是升级语义');
    const ticketPush = added.find((r) => r.kind === 'approval');
    assert.match(ticketPush.title, /【待批红·停服】/, '票拟自己的推送标题带待批红前缀');
  } finally { cleanup(); }
});

test('飞书任务失败且涉及必问清单：失败回话与批红并一条推送', async () => {
  const { hub, cleanup } = await makeHub('fail');
  try {
    const { task, added } = await runFeishuTask(hub, {
      key: 'dual-fail', fail: true, error: '部署阶段要停掉服务重启，中途失败退出',
    });
    assert.equal(added.length, 1, `失败回话只推一条，实际 ${added.length} 条：${JSON.stringify(added.map((r) => [r.kind, r.title]))}`);
    assert.equal(added[0].kind, 'approval', '合并推送带批红按钮');
    assert.match(added[0].body, /失败了/, '失败说明在上');
    assert.match(added[0].body, /原因：（部署阶段要停掉服务重启，中途失败退出）/, '原始报错压成一行、收进括号');
    assert.match(added[0].body, /待批红/, '批红信息在下');
    const ticket = hub.ledger.get('SELECT * FROM approvals WHERE task_id=?', task.task_id);
    assert.ok(ticket, '失败票拟照常落库');
    assert.equal(ticket.status, 'pending');
    assert.equal(JSON.parse(added[0].ref).approval_id, ticket.approval_id);
  } finally { cleanup(); }
});

test('飞书任务失败但不涉及必问清单：只推失败回话，不建票拟', async () => {
  const { hub, cleanup } = await makeHub('failclean');
  try {
    const { added } = await runFeishuTask(hub, {
      key: 'dual-fail-clean', fail: true, error: '网络超时',
    });
    assert.equal(added.length, 1, `只推失败回话，实际 ${added.length} 条`);
    assert.equal(added[0].kind, 'feishu_reply', '无票拟时保持普通回话');
    const tickets = hub.ledger.all('SELECT * FROM approvals');
    assert.equal(tickets.length, 0, '不涉及必问清单就不建票拟');
  } finally { cleanup(); }
});

test('renderReplyMergedText：正文在上、批红信息在下、带操作入口', async () => {
  const { loadConfig } = await import('../src/lib/config.mjs');
  const { ApprovalService } = await import('../src/m5/approvals.mjs');
  const svc = Object.create(ApprovalService.prototype);
  svc.config = loadConfig();
  const merged = svc.renderReplyMergedText({
    approval_id: 'apr_t1',
    category: 'stop_service',
    meta: { category_label: '停服' },
    question: '任务已完成分析，但其结果涉及「停服」。是否准予继续执行这一步？',
  }, '完成：脚本已修。\n需要批红：要停掉服务 3 分钟。');
  const head = merged.indexOf('──────────────');
  assert.ok(head > 0, '存在答复与批红的分隔线');
  assert.ok(merged.indexOf('脚本已修') < head, '答复正文在分隔线之前');
  assert.ok(merged.indexOf('待批红') > head, '批红信息在分隔线之后');
  assert.match(merged, /apr_t1/, '带票拟编号（纯文本降级时也能对上票拟单）');
  assert.match(merged, /批红页/, '带面板操作入口');
  assert.doesNotMatch(merged, /cli\.mjs/, '不给人看 CLI 命令（2026-11-17 汇报规范）');
});

test('产出推给人之前过可读化：反引号与星号记号不出现（2026-11-17 汇报规范）', async () => {
  const { hub, cleanup } = await makeHub('human');
  try {
    const { added } = await runFeishuTask(hub, {
      key: 'human-text', dev: false,
      resultText: '## 答复\n**已核实**：面板正常，见 `http://127.0.0.1:8787`。\n\n\n\n过程略，详见 `docs/部署运维.md`。',
    });
    assert.equal(added.length, 1, `查询答复只推一张反馈卡，实际 ${added.length} 条`);
    const body = added[0].body;
    assert.doesNotMatch(body, /`/, '反引号全部换成「」');
    assert.doesNotMatch(body, /\*\*|## /, '粗体与标题记号去掉');
    assert.match(body, /「答复」/, '标题行文字保留并加「」');
    assert.match(body, /已核实：面板正常/, '正文内容原样保留');
    assert.match(body, /「http:\/\/127\.0\.0\.1:8787」/, '行内代码换成「」');
  } finally { cleanup(); }
});

/* ─────────────────────────── 采纳执行优化（2026-11-18） ───────────────────────────
 * 查询反馈卡「采纳」派出的任务（source=adopt）此前游离在会话之外：
 * 任务说明塞整篇答复、回执走默认通道、命中必问清单时「批红卡 + 结果」连发两道。
 * 现在与 dev 飞书答复同一套会话回执行为。 */

/** 造一张查询反馈卡（proposal 走真实链路的 forHuman 整理），老板点「采纳」，返回派出的任务 */
async function adoptQuerySuggestion(hub, { title, answer, chatId = 'oc_adopt' }) {
  const { forHuman } = await import('../src/lib/human-text.mjs');
  const card = await hub.approvals.create({
    title,
    question: '查询答复如下，请点按钮反馈（已阅 / 采纳 / 驳回 / 改派）：',
    proposal: forHuman(answer),
    category: 'query',
    options: ['ack', 'adopt', 'reject', 'revise'],
    chatId,
  });
  const res = await hub.approvals.decide(card.approval_id, { decision: 'adopt', by: 'boss' });
  assert.equal(res.ok, true, '采纳决策成功');
  const task = hub.ledger.get('SELECT * FROM tasks WHERE title=? ORDER BY created_at DESC LIMIT 1', `采纳执行：${title}`);
  assert.ok(task, '采纳后派出了新任务');
  return { card, task };
}

test('采纳派活：任务说明只带建议段与完成标准，不塞整篇答复；采纳会话记在任务上', async () => {
  const { hub, cleanup } = await makeHub('adopt');
  try {
    const answer = [
      '做完了（只读查询，未执行重推）。',
      '',
      '「问题理解」',
      '老板想把今天的战报重推一次。',
      '',
      '「问题分析」',
      '早上那份战报因接口 401 没有任何数字。',
      '',
      '「下一步的执行建议」',
      '1. 修复日报鉴权兜底判据。',
      '2. 修完后重启中台加载新代码（需要批红：重启属短暂停服）。',
    ].join('\n');
    const { task } = await adoptQuerySuggestion(hub, { title: '重新推日报', answer });
    assert.match(task.prompt, /采纳执行.*任务：/, '开头一句话讲清这是什么任务');
    assert.match(task.prompt, /1\. 修复日报鉴权兜底判据/, '要执行的建议在任务说明里');
    assert.doesNotMatch(task.prompt, /问题理解|401/, '理解与分析不再塞进任务（只派建议段）');
    assert.match(task.prompt, /完成标准/, '写明做完的标准');
    assert.match(task.prompt, /需要批红/, '铁律保留');
    assert.match(task.title, /^采纳执行：重新推日报$/, '事项名 = 采纳执行 + 原查询');
    const meta = JSON.parse(task.meta);
    assert.equal(meta.envelope.feishu_chat, 'oc_adopt', '采纳发生的会话记在任务上，回执能送回去');
  } finally { cleanup(); }
});

test('采纳的任务命中必问清单：结果与批红并一张卡回原会话，不再连发两道', async () => {
  const { hub, cleanup } = await makeHub('adopt-esc');
  try {
    const answer = '「下一步的执行建议」\n1. 重启中台加载新代码（需要批红：重启属短暂停服）。';
    await adoptQuerySuggestion(hub, { title: '重启中台', answer });
    const before = new Set(hub.ledger.all('SELECT notification_id n FROM notifications').map((r) => r.n));
    const t = await hub.queue.poll({ nodeId: 'win-a', engines: ['claude-code', 'mock'], waitSeconds: 2 });
    assert.ok(t, '采纳的任务能被领走');
    hub.queue.complete(t.task_id, 'win-a', { ok: true, text: '做完了：中台已重启加载新代码。需要批红：生效要停服务 3 分钟。', engine: 'mock' });
    await hub.afterTaskUpdate(t.task_id);
    const added = hub.ledger.all('SELECT * FROM notifications').filter((r) => !before.has(r.notification_id));
    assert.equal(added.length, 1, `应只推一张合并卡，实际 ${added.length} 条：${JSON.stringify(added.map((r) => [r.kind, r.title]))}`);
    assert.equal(added[0].kind, 'approval', '合并卡带批红按钮');
    assert.match(added[0].title, /采纳执行：重启中台/, '标题就是事项名');
    assert.match(added[0].body, /中台已重启/, '答复正文在上');
    assert.match(added[0].body, /待批红/, '批红信息在下');
    const ticket = hub.ledger.get('SELECT * FROM approvals WHERE task_id=?', t.task_id);
    assert.ok(ticket, '票拟单照常落库');
    assert.equal(ticket.status, 'pending');
    assert.equal(JSON.parse(added[0].ref).approval_id, ticket.approval_id, '推送挂的就是这张票拟');
  } finally { cleanup(); }
});

test('采纳的任务正常完成：结果作为回话回到采纳的会话，不变成无主推送', async () => {
  const { hub, cleanup } = await makeHub('adopt-clean');
  try {
    const answer = '「下一步的执行建议」\n1. 把示例配置里的端口改成 9000。';
    await adoptQuerySuggestion(hub, { title: '改示例端口', answer });
    const before = new Set(hub.ledger.all('SELECT notification_id n FROM notifications').map((r) => r.n));
    const t = await hub.queue.poll({ nodeId: 'win-a', engines: ['claude-code', 'mock'], waitSeconds: 2 });
    assert.ok(t, '采纳的任务能被领走');
    hub.queue.complete(t.task_id, 'win-a', { ok: true, text: '完成：示例端口已改为 9000。', engine: 'mock' });
    await hub.afterTaskUpdate(t.task_id);
    const added = hub.ledger.all('SELECT * FROM notifications').filter((r) => !before.has(r.notification_id));
    assert.equal(added.length, 1, `只推一条回话，实际 ${added.length} 条`);
    assert.equal(added[0].kind, 'feishu_reply', '作为回话送回会话（不再是默认通道的 task_result）');
    assert.match(added[0].title, /采纳执行：改示例端口/, '标题就是事项名');
    assert.match(added[0].body, /示例端口已改为 9000/, '结果正文照常');
  } finally { cleanup(); }
});

test('采纳的任务失败：失败回话与批红并一张卡回到采纳的会话（与 dev 失败同路）', async () => {
  const { hub, cleanup } = await makeHub('adopt-fail');
  try {
    const answer = '「下一步的执行建议」\n1. 重启中台加载新代码。';
    await adoptQuerySuggestion(hub, { title: '重启中台', answer });
    const before = new Set(hub.ledger.all('SELECT notification_id n FROM notifications').map((r) => r.n));
    const t = await hub.queue.poll({ nodeId: 'win-a', engines: ['claude-code', 'mock'], waitSeconds: 2 });
    assert.ok(t, '采纳的任务能被领走');
    hub.queue.complete(t.task_id, 'win-a', { ok: false, error: '重启时要停服务 3 分钟，中途失败退出', engine: 'mock' });
    await hub.afterTaskUpdate(t.task_id);
    const added = hub.ledger.all('SELECT * FROM notifications').filter((r) => !before.has(r.notification_id));
    assert.equal(added.length, 1, `失败只推一条，实际 ${added.length} 条：${JSON.stringify(added.map((r) => [r.kind, r.title]))}`);
    assert.equal(added[0].kind, 'approval', '失败回话与批红并一张卡');
    assert.match(added[0].body, /执行失败/, '失败说明在上');
    assert.match(added[0].body, /原因：（重启时要停服务 3 分钟，中途失败退出）/, '原始报错压成一行、收进括号');
    assert.match(added[0].body, /待批红/, '批红信息在下');
  } finally { cleanup(); }
});
