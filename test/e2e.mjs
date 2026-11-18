/**
 * 端到端自测（零依赖）。
 *
 *   node test/e2e.mjs
 *
 * 覆盖方案 §5 的整条主干：
 *   M1 事件入口 → M2 去重/规则/并发/派活 → M3 长轮询与引擎执行 → M5 必问清单与批红
 *   → M6 报告归档与决定记忆 → M4 流水线（mock 模式）
 *
 * 自测全用 mock 引擎与临时数据库，不碰真实 codex/claude，不需要网络。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

/** 建一个隔离的中台实例（临时库 + 临时日志目录） */
async function makeHub(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hub-e2e-${name}-`));
  process.env.HUB_DATA_DIR = tmp;
  const { loadConfig, ensureDirs } = await import('../src/lib/config.mjs');
  const config = loadConfig();
  config.pipeline = { ...config.pipeline, mode: 'mock', autoStart: true };
  config.cron.enabled = false;
  config.hub.secret = '';
  // 回归（2026-11-14）：e2e 读真实配置，接入飞书后 enabled=true 会让
  // 「本地降级」断言失败，还把测试消息真发进了用户的飞书群 —— 测试必须封闭。
  config.feishu = { ...config.feishu, enabled: false };
  ensureDirs(config);
  const { Hub } = await import('../src/hub.mjs');
  const hub = new Hub({ config });
  return { hub, tmp };
}

async function main() {
  console.log('本地自动化 Agent 体系 · 端到端自测\n');

  /* ─────────── 1. M1 → M2：事件进、规则派 ─────────── */
  section('M1 → M2 事件入口与规则路由');
  const { hub, tmp } = await makeHub('main');
  const { EVENT_STATUS } = await import('../src/m2/events.mjs');

  const r1 = hub.ingest({
    source: 'github',
    type: 'github.issue',
    target: 'acme/shop',
    summary: '结算页金额少算一分钱',
    link: 'https://github.com/acme/shop/issues/42',
    priority: 'P2',
    dedupe_key: 'issue-42',
    payload: { issue_number: 42 },
  }, 'test');
  ok(r1.ok && r1.rule_id === 'r03-github-issue', 'github.issue 命中 r03 规则', r1);
  ok(r1.task?.node === 'win-a' && r1.task?.engine === 'claude-code', '规则把活派到 win-a / claude-code', r1.task);
  ok(r1.task?.skill === 'repo-fix', '任务带上 repo-fix 技能', r1.task?.skill);
  // 回归：任务状态必须是队列态 'queued'，不能是事件态的 'routed'。
  // 早先两者混用，导致规则派出的任务 leaseNext() 永远选不中（只有 adhoc 能跑）。
  ok(r1.task?.status === 'queued', '规则派出的任务状态是 queued（不是 routed）', r1.task?.status);
  const grabbed = await hub.queue.poll({ nodeId: 'win-a', engines: ['claude-code', 'mock'], waitSeconds: 1 });
  ok(grabbed?.task_id === r1.task?.task_id, '规则派出的任务节点真能接走', { got: grabbed?.task_id, want: r1.task?.task_id });
  if (grabbed) hub.queue.complete(grabbed.task_id, 'win-a', { ok: true, text: '已处理', engine: 'mock' });

  // 回归：只给 type 也能匹配规则。
  // cron / webhook 类事件天然没有 summary；早先 CLI 只写 `--type cron.daily-report` 时，
  // /api/dispatch 的校验要求 engine 或 summary，直接把这类调用拒了。
  const rTypeOnly = hub.ingest({ source: 'cron', type: 'cron.daily-report' }, 'test');
  ok(rTypeOnly.rule_id === 'r01-daily-report', '只给 type 也能命中 r01 规则', rTypeOnly.rule_id);
  ok(rTypeOnly.task?.engine === 'codex', 'r01 派给 codex 引擎', rTypeOnly.task?.engine);
  if (rTypeOnly.task) hub.queue.complete(rTypeOnly.task.task_id, 'win-a', { ok: true, text: '已处理', engine: 'mock' });

  /* ─────────── 2. 去重 ─────────── */
  section('M2 去重（dedupe_key 时间窗）');
  const r2 = hub.ingest({
    source: 'github', type: 'github.issue', target: 'acme/shop',
    summary: '结算页金额少算一分钱（重复投递）',
    dedupe_key: 'issue-42', payload: { issue_number: 42 },
  }, 'test');
  ok(r2.duplicate === true && r2.duplicate_of === r1.event_id, '同一 dedupe_key 被识别为重复，不产生新任务', r2);
  const taskCount = hub.ledger.get(`SELECT COUNT(*) c FROM tasks WHERE event_id=?`, r1.event_id).c;
  ok(taskCount === 1, '重复事件没有多建任务', taskCount);

  /* ─────────── 3. 未匹配规则 → 待归类 ─────────── */
  section('M2 未匹配规则 → 待归类队列');
  const r3 = hub.ingest({
    source: 'webhook', type: 'unknown.thing', target: 'x', summary: '没人认领的事件',
  }, 'test');
  ok(r3.unrouted === true, '未知类型事件进 unrouted，不抛弃', r3);

  /* ─────────── 4. 长轮询派活 + 引擎执行 ─────────── */
  section('M2 → M3 长轮询派活与引擎执行');
  const dispatched = await hub.dispatchManual({
    type: 'cmd.manual', target: 'host', summary: '自检：总结今天的事件',
    engine: 'mock', node: 'win-a', priority: 'P3',
    payload: { prompt: 'ping', mock: { delay_ms: 50, text: '自检完成：一切正常。' } },
    source: 'cli',
  });
  ok(dispatched.ok && dispatched.task_id, '手动派活建出任务', dispatched);

  const polled = await hub.queue.poll({ nodeId: 'win-a', engines: ['mock'], waitSeconds: 3 });
  ok(polled?.task_id === dispatched.task_id, '节点长轮询接到这个任务', { got: polled?.task_id, want: dispatched.task_id });
  ok(polled?.lease_id, '任务带租约 id', polled?.lease_id);

  const other = await hub.queue.poll({ nodeId: 'mac-b', engines: ['codex'], waitSeconds: 1 });
  ok(other === null, '别的节点/引擎接不到不属于它的任务', other);

  hub.queue.markRunning(dispatched.task_id, 'win-a');
  const completed = hub.queue.complete(dispatched.task_id, 'win-a', {
    ok: true, exit_code: 0, text: '自检完成：一切正常。', engine: 'mock', node: 'win-a', duration_ms: 50,
  });
  ok(completed?.status === 'completed', '任务完成回写', completed?.status);
  await hub.afterTaskUpdate(dispatched.task_id);
  const evAfter = hub.events.getEvent(dispatched.event_id);
  ok(evAfter?.status === EVENT_STATUS.COMPLETED, '事件状态推进为 completed', evAfter?.status);

  /* ─────────── 4b. 唤醒时效（回归：跨进程唤醒失效那个 bug） ─────────── */
  // 进程内场景：先挂起长轮询，再派活，必须在毫秒级被唤醒，
  // 而不是干等到 50 秒窗口结束。若 wakeAll() 失效，这里会耗时接近 30 秒。
  const wakeT0 = Date.now();
  const pendingPoll = hub.queue.poll({ nodeId: 'win-a', engines: ['mock'], waitSeconds: 30 });
  await new Promise((r) => setTimeout(r, 120)); // 让 waiter 完成注册
  await hub.dispatchManual({
    type: 'cmd.manual', target: 'host', summary: '唤醒时效回归', engine: 'mock', node: 'win-a',
    payload: { prompt: 'ping', mock: { delay_ms: 1, text: 'ok' } }, source: 'cli',
  });
  const woke = await pendingPoll;
  const wakeMs = Date.now() - wakeT0;
  ok(Boolean(woke), '挂起的长轮询被新任务唤醒', { task: woke?.task_id });
  ok(wakeMs < 3000, '唤醒是即时的不等满长轮询窗口', { wakeMs });
  if (woke) hub.queue.complete(woke.task_id, 'win-a', { ok: true, text: 'ok', engine: 'mock' });

  /* ─────────── 5. 失败重试 → 死信 ─────────── */
  section('M2 失败重试与死信');
  const failTask = await hub.dispatchManual({
    type: 'cmd.manual', target: 'host', summary: '故意失败的任务',
    engine: 'mock', node: 'win-a', priority: 'P3',
    payload: { mock: { fail: true, fail_reason: '模拟崩溃' } }, source: 'cli',
  });
  const leased = await hub.queue.poll({ nodeId: 'win-a', engines: ['mock'], waitSeconds: 2 });
  ok(leased?.task_id === failTask.task_id, '失败任务被接到', leased?.task_id);
  hub.queue.markRunning(failTask.task_id, 'win-a');
  const afterFail = hub.queue.fail(failTask.task_id, 'win-a', '模拟崩溃', { retryable: true });
  ok(afterFail?.status === 'queued' || afterFail?.status === 'failed', '失败后按重试策略回队或失败', afterFail?.status);
  const attempts = hub.ledger.get('SELECT attempts, max_attempts FROM tasks WHERE task_id=?', failTask.task_id);
  ok(attempts.attempts >= 1, '重试次数被记账', attempts);

  /* ─────────── 6. 必问清单 → 票拟 ─────────── */
  section('M5 必问清单与批红状态机');
  const hits = hub.approvals.classify('我准备删除这三张表并停掉服务');
  ok(hits.includes('delete_data'), '识别出「删数据」', hits);
  ok(hits.includes('stop_service'), '识别出「停服」', hits);

  const approval = await hub.approvals.create({
    title: '清空测试库',
    question: '是否准予清空 staging 库？',
    proposal: 'DELETE FROM orders WHERE created_at < ...',
    category: 'delete_data',
    taskId: failTask.task_id,
    eventId: failTask.event_id,
  });
  ok(approval.status === 'pending', '票拟初始为待批红', approval.status);

  const decided = await hub.approvals.decide(approval.approval_id, { decision: 'agree', note: '批准', by: 'tony' });
  ok(decided.ok && decided.approval.status === 'approved', '批红后状态为 approved', decided.approval?.status);
  const decision = hub.ledger.get('SELECT * FROM decisions WHERE source_approval=?', approval.approval_id);
  ok(Boolean(decision), '批红结果写进决定记忆', decision?.text);

  const rej = await hub.approvals.create({
    title: '改产品方向', question: '要不要改成订阅制？', category: 'product_direction',
  });
  const rejected = await hub.approvals.decide(rej.approval_id, { decision: 'reject', note: '不做', by: 'tony' });
  ok(rejected.approval?.status === 'rejected', '驳回后状态为 rejected', rejected.approval?.status);
  const refused = hub.ledger.get(`SELECT * FROM decisions WHERE source_approval=? AND kind='refused'`, rej.approval_id);
  ok(Boolean(refused), '拒绝过的事写进「定了不做的事」', refused?.text);

  // 回归（2026-11-14）：方案 §7 的票拟状态机是
  //   「驳/改派 → 调整中 → 重新票拟 → 待批红」，这里走完整条回头路。
  // 之前只测了「批」和「驳」，改派与重投从未被覆盖。
  const rev = await hub.approvals.create({
    title: '停掉线上服务', question: '停机维护？', proposal: '今晚 22:00 停服 30 分钟', category: 'stop_service',
  });
  ok(rev.status === 'pending' && rev.revision === 1, '票拟初始版本号为 1', rev.revision);

  const revised = await hub.approvals.decide(rev.approval_id, {
    decision: 'revise', note: '避开业务高峰，改到凌晨 3 点', by: 'tony',
  });
  ok(revised.ok && revised.approval.status === 'revising',
    '改派后进入「调整中」', revised.approval?.status);

  const resubmitted = await hub.approvals.resubmit(rev.approval_id, {
    proposal: '次日 03:00 停服 30 分钟', by: 'tony',
  });
  ok(resubmitted.ok && resubmitted.approval.status === 'pending' && resubmitted.approval.revision === 2,
    '重新票拟回到待批红且版本号 +1',
    { status: resubmitted.approval?.status, revision: resubmitted.approval?.revision });

  // 回到待批红之后，轮子得能转完：再批一次
  const reApproved = await hub.approvals.decide(rev.approval_id, { decision: 'agree', note: '准', by: 'tony' });
  ok(reApproved.ok && reApproved.approval.status === 'approved',
    '重新票拟后仍能批红（状态机闭环）', reApproved.approval?.status);

  // 终态不能再改（approved 只能走向 executing/executed/cancelled）
  const lateReject = await hub.approvals.decide(rev.approval_id, { decision: 'reject', by: 'tony' });
  ok(lateReject.ok === false || lateReject.approval?.status !== 'rejected',
    'regression: 已批红不能再被驳回到 rejected', lateReject.error || lateReject.approval?.status);

  // 已经 pending 的单子不能「重新票拟」（那是给调整中/已驳用的）
  const wrongState = await hub.approvals.resubmit(approval.approval_id, { proposal: 'x' });
  ok(wrongState.ok === false, 'regression: 非「调整中/已驳」状态不能重新票拟', wrongState.error);

  // regression（2026-11-14）：规则 approval:'always'（r09-cleanup 周日大扫除）
  // 曾把任务置为 awaiting_approval 却**从不建票拟单**（tasks.approval_id 为 null）——
  // 没人能批，任务永久卡死。这里走 ingestAsync 真实链路：事件进来自动挂票拟，
  // 批了之后节点才接得走。
  const cl = await hub.ingestAsync({ source: 'cron', type: 'cron.cleanup', target: 'hub', summary: '周日大扫除（测试）' }, 'cron');
  ok(cl.status === 'awaiting_approval' && cl.task?.status === 'awaiting_approval',
    'approval:always 的规则把任务停在待批红', { event: cl.status, task: cl.task?.status });
  const clTaskId = cl.task?.task_id;
  const clTaskRow = hub.ledger.get('SELECT approval_id FROM tasks WHERE task_id=?', clTaskId);
  ok(Boolean(clTaskRow?.approval_id), 'regression: 必批任务必须挂上票拟单（否则永久卡死）', clTaskRow);
  const clCard = clTaskRow?.approval_id ? hub.approvals.get(clTaskRow.approval_id) : null;
  ok(clCard?.status === 'pending', '票拟单处于待批红', clCard?.status);
  const noTake = await hub.queue.poll({ nodeId: 'win-a', engines: ['claude-code', 'mock'], waitSeconds: 1 });
  ok(!noTake || noTake.task_id !== clTaskId, '批红之前节点接不走该任务');
  const agreedClean = await hub.approvals.decide(clTaskRow.approval_id, { decision: 'agree', note: '准', by: 'tony' });
  ok(agreedClean.ok && agreedClean.approval.status === 'approved', '批红通过', agreedClean.approval?.status);
  const afterAgree = hub.ledger.get('SELECT status FROM tasks WHERE task_id=?', clTaskId);
  ok(afterAgree.status === 'queued', 'regression: 批红后任务回 queued', afterAgree.status);
  const takenAfter = await hub.queue.poll({ nodeId: 'win-a', engines: ['claude-code', 'mock'], waitSeconds: 1 });
  ok(takenAfter && takenAfter.task_id === clTaskId, 'regression: 批红后节点能接走该任务', takenAfter?.task_id);
  if (takenAfter && takenAfter.task_id === clTaskId) {
    hub.queue.complete(clTaskId, 'win-a', { ok: true, text: '【演练】没有删除任何东西', engine: 'mock' });
    await hub.afterTaskUpdate(clTaskId);
  }

  /* ─────────── 7. 通知分层 ─────────── */
  section('M5 通知分层（P0 即时 / P2 聚合 / P3 归档）');
  const n0 = await hub.notifier.notify({ level: 'P0', kind: 'test', title: '线上挂了', body: '立刻处理' });
  ok(n0.ok && n0.channel === 'local', 'P0 未配飞书时降级本地通道（不丢消息）', n0);
  const n2 = await hub.notifier.notify({ level: 'P2', kind: 'test', title: '日报', body: '聚合' });
  ok(n2.channel === 'digest', 'P2 进日报聚合队列', n2);
  const n3 = await hub.notifier.notify({ level: 'P3', kind: 'test', title: '归档', body: '归档' });
  ok(n3.channel === 'archive', 'P3 只归档不推送', n3);

  // 回归（2026-11-14）：dedupeRef 以前收下就丢，任务重试/巡检每轮都喊一遍。
  const d1 = await hub.notifier.notify({ level: 'P1', kind: 'test', title: '同一件事', body: 'x', dedupeRef: 'dup-key-1' });
  const d2 = await hub.notifier.notify({ level: 'P1', kind: 'test', title: '同一件事', body: 'x', dedupeRef: 'dup-key-1' });
  ok(d1.channel !== 'deduped' && d2.channel === 'deduped', 'regression: 同一 dedupeRef 只推一次', { d1: d1.channel, d2: d2.channel });

  // 回归：P2 队列以前只进不出，drainDigest 定义了却没人调用。
  await hub.notifier.notify({ level: 'P2', kind: 'test', title: '夜里攒的消息', body: '聚合内容' });
  const drained = hub.notifier.drainDigest();
  ok(drained.some((i) => i.title === '夜里攒的消息'), 'regression: P2 聚合队列能被取出', drained.map((i) => i.title));
  // 台账里 status=queued 的 digest 也要能取到（跨重启不丢）
  const queuedInDb = hub.ledger.all("SELECT notification_id FROM notifications WHERE channel='digest' AND status='queued'");
  ok(queuedInDb.length > 0, 'regression: 聚合队列同时覆盖台账里 queued 的 digest', queuedInDb.length);
  hub.notifier.markDigestSent(drained.map((i) => i.id));
  const afterMark = hub.ledger.all("SELECT notification_id FROM notifications WHERE channel='digest' AND status='queued'");
  ok(afterMark.length === 0, 'regression: 随战报发出后不再重复带上', afterMark.length);

  // 回归（2026-11-14）：silent 语义曾经写反 —— 规则写 silent:false 表示「要通知人」，
  // 代码却把条件写成 silent !== false 只打一行日志，于是每日战报 07:30 准时跑完、
  // 一个人也没收到。这里走真实链路验证「非静默任务完成会推送」。
  const notifyBefore = hub.notifier.listRecent(200).length;
  const dm = await hub.dispatchManual({
    type: 'cmd.manual', target: 'silent-probe', summary: '非静默任务应推送',
    engine: 'mock', priority: 'P1', source: 'test',
    payload: { mock: { text: '这份产出一句话就该推给人' } },
  });
  const grabbedQuiet = await hub.queue.poll({ nodeId: 'win-a', engines: ['mock'], waitSeconds: 2 });
  if (grabbedQuiet) {
    hub.queue.complete(grabbedQuiet.task_id, 'win-a', { ok: true, text: '这份产出一句话就该推给人', engine: 'mock' });
    await hub.afterTaskUpdate(grabbedQuiet.task_id);
  }
  const notifyAfter = hub.notifier.listRecent(200).length;
  ok(notifyAfter > notifyBefore, 'regression: 非静默任务完成会推送给', { notifyBefore, notifyAfter });

  // 回归（2026-11-15）：飞书提问的产出曾因为规则 silent:true + P3 级别，
  // 进了聚合队列或归档，人在群里问了问题、看见任务跑完，却永远收不到答案。
  // 回复不是系统主动打扰，必须立刻回到提问的会话。
  const replyHub = await makeHub('feishu-reply');
  try {
    const rh = replyHub.hub;
    await rh.notifier.notify({ level: 'P2', kind: 'x', title: '主动通知仍应进聚合' });
    const digestAfterActive = rh.ledger.get("SELECT count(*) AS c FROM notifications WHERE channel='digest'").c;
    ok(digestAfterActive >= 1, 'regression: 系统主动的 P2 仍走聚合（不受回复逻辑影响）', { digestAfterActive });

    await rh.notifier.notify({
      level: 'P3', kind: 'feishu_reply', title: '回答低优先级提问',
      body: '这是回答，不该被归档', chatId: 'oc_test',
    });
    const replyRow = rh.ledger.all("SELECT level, channel, status, target FROM notifications WHERE kind='feishu_reply' ORDER BY created_at DESC LIMIT 1")[0];
    ok(replyRow && replyRow.channel !== 'archive', 'regression: 飞书回复即使是 P3 也不能只归档', { replyRow });
    ok(replyRow && replyRow.channel !== 'digest', 'regression: 飞书回复不能进聚合队列（否则永远等不到）', { replyRow });

    await rh.notifier.notify({
      level: 'P2', kind: 'feishu_reply', title: '回答 P2 提问', body: 'b', chatId: 'oc_test',
    });
    const replyP2 = rh.ledger.all("SELECT channel FROM notifications WHERE kind='feishu_reply' ORDER BY created_at DESC LIMIT 1")[0];
    ok(replyP2 && replyP2.channel !== 'digest', 'regression: P2 回复同样不进聚合', { replyP2 });

    // 真实链路：飞书来源的任务即便规则 silent:true 也要推给提问者
    const envId = rh.events.ingest({
      source: 'feishu', type: 'feishu.message', target: 'ou_test', summary: '现在的工作状态',
      dedupe_key: 'feishu-reply-probe', priority: 'P3',
      payload: { text: '现在的工作状态', chat_id: 'oc_test_chat' },
    }, 'test');
    await new Promise((r) => setTimeout(r, 60));
    // r14 现在派给 claude-code（rules.json 已改），这里要把 claude-code 声明上才领得走
    const pulled = await rh.queue.poll({ nodeId: 'win-a', engines: ['claude-code', 'codex', 'mock'], waitSeconds: 2 });
    if (pulled) {
      rh.queue.complete(pulled.task_id, 'win-a', { ok: true, text: '中台在线，一切正常。', engine: 'mock' });
      await rh.afterTaskUpdate(pulled.task_id);
    }
    const taskReply = rh.ledger.all("SELECT kind, channel FROM notifications WHERE kind='feishu_reply' ORDER BY created_at DESC LIMIT 1")[0];
    ok(Boolean(pulled), 'regression: 飞书消息能派成任务', { eventId: envId?.event_id });
    ok(taskReply && taskReply.channel !== 'archive', 'regression: 飞书任务产出一律回话（silent 不拦）', { taskReply });
  } finally {
    replyHub.hub.queue.stop();
    replyHub.hub.ledger.close();
  }


  // 回归（2026-11-14）：聚合任务（战报/周报）自己也曾进聚合队列，
  // 于是 07:30 跑完的战报只是「攒起来等下一条战报带」，永远没人收到。
  await hub.notifier.notify({ level: 'P2', kind: 'test', title: '待聚合的一条', body: 'b' });
  await hub.dispatchManual({ type: 'cron.daily-report', target: 'agg', summary: '聚合出口',
    engine: 'mock', priority: 'P2', source: 'cron', payload: { mock: { text: 'x' } } });
  const aggTask = await hub.queue.poll({ nodeId: 'win-a', engines: ['mock'], waitSeconds: 2 });
  hub.ledger.run("UPDATE tasks SET skill='daily-report' WHERE task_id=?", aggTask.task_id);
  hub.queue.complete(aggTask.task_id, 'win-a', { ok: true, text: '【今日战报】结论：正常。', engine: 'mock' });
  await hub.afterTaskUpdate(aggTask.task_id);
  const aggRow = hub.ledger.all("SELECT level, channel, body FROM notifications WHERE kind='task_result' ORDER BY created_at DESC LIMIT 1")[0];
  ok(aggRow?.level === 'P1' && aggRow?.channel === 'local', 'regression: 聚合任务自己立即送出（P1），不进聚合队列', aggRow);
  ok(/待聚合的一条/.test(aggRow?.body || ''), 'regression: 战报正文里带上攒下的 P2', (aggRow?.body || '').slice(-80));
  const stuck = hub.ledger.all("SELECT count(*) c FROM notifications WHERE channel='digest' AND status='queued'")[0].c;
  ok(stuck === 0, 'regression: 聚合发出后队列清空，不会无限积压', stuck);

  // 回归（2026-11-14）：方案 §7 写着「超 24 小时未批 → 升级提醒一次，绝不默认同意」。
  // 这条规矩从来没被测过，因为它要么等 24 小时、要么等 60 秒定时器。
  // 现在 checkDue() 公开出来，直接把 due_at 拨到过去就能验证。
  const staleA = await hub.approvals.create({
    title: '过期票拟：删数据', question: '删不删？', proposal: '删除旧表', category: 'delete_data',
  });
  const staleB = await hub.approvals.create({
    title: '未过期票拟：停服', question: '停不停？', proposal: '停掉服务', category: 'stop_service',
  });
  // 只把 A 拨到过去；B 保持 24 小时后到期
  hub.ledger.run('UPDATE approvals SET due_at=? WHERE approval_id=?', '2020-01-01T00:00:00.000Z', staleA.approval_id);
  const reminderBefore = hub.ledger.all("SELECT count(*) c FROM notifications WHERE kind='approval_reminder'")[0].c;
  await hub.approvals.checkDue();
  await hub.approvals.checkDue(); // 连跑两次，验证「只提醒一次」
  const reminderAfter = hub.ledger.all("SELECT count(*) c FROM notifications WHERE kind='approval_reminder'")[0].c;
  ok(reminderAfter - reminderBefore === 1, 'regression: 超时票拟只提醒一次（连跑两次巡检只发一条）', reminderAfter - reminderBefore);

  const staleRow = hub.ledger.get('SELECT status, reminded_at FROM approvals WHERE approval_id=?', staleA.approval_id);
  ok(staleRow.status === 'pending' && staleRow.reminded_at,
    'regression: 超时绝不默认同意（状态仍是 pending，只记提醒时间）', staleRow);
  const freshRow = hub.ledger.get('SELECT status, reminded_at FROM approvals WHERE approval_id=?', staleB.approval_id);
  ok(freshRow.status === 'pending' && freshRow.reminded_at === null,
    'regression: 未到期的不误提醒', freshRow);

  /* ─────────── 8. 决定记忆 ─────────── */
  section('M6 决定记忆');
  hub.decisions.record({ kind: 'decided', text: '数据库只增不改，不做物理删除', by: 'tony', quote: '别删，加字段就行' });
  const rel = hub.decisions.relevant('要不要删除旧订单数据');
  ok(rel.length > 0, '相关查询能命中「定过的事」', rel.map((d) => d.text));
  const rel2 = hub.decisions.relevant('今天天气怎么样');
  ok(rel2.length === 0 || rel2.length < rel.length, '不相关的查询不硬塞决定（避免污染提示词）', rel2.length);
  // 两字中文查询只产出 1 个 bigram，阈值必须自适应，否则永远查不到
  const relShort = hub.decisions.relevant('删除');
  ok(relShort.length > 0, '两字中文查询也能命中（bigram 阈值自适应）', relShort.map((d) => d.text));

  // regression（2026-11-14）：每周日大扫除要用的自检。方案 §10 写着
  // 「每周日大扫除任务」，它靠 DecisionMemory.weeklyCheck() 出冲突与陈旧清单。
  // 之前这条只有手工验证过，进了测试才算数。
  hub.decisions.record({ kind: 'refused', text: '不做自动删除线上数据', by: 'tony', quote: '别动线上库' });
  const weekly = hub.decisions.weeklyCheck();
  ok(typeof weekly.total === 'number' && weekly.total >= 2,
    '大扫除自检能统计决定记忆条数', { total: weekly.total, decided: weekly.decided, refused: weekly.refused });
  ok(weekly.decided >= 1 && weekly.refused >= 1,
    '定过的事与定了不做的事分别计数', { decided: weekly.decided, refused: weekly.refused });
  ok(Array.isArray(weekly.conflicts),
    '大扫除自检给出冲突清单（结构正确，可以为空）', weekly.conflicts.length);

  /* ─────────── 9. 技能库 ─────────── */
  section('M6 技能库与提示词拼装');
  const skills = hub.skills.list();
  ok(skills.length >= 8, '八套 SOP 技能都在', skills.map((s) => s.name));
  const loaded = hub.skills.load('repo-fix');
  ok(loaded && loaded.body.includes('止步于开 PR'), 'repo-fix 正文包含止步 PR 铁律');
  const prompt = hub.skills.buildPrompt({
    task: { title: '修 issue 42', prompt: '按 SOP 做' },
    skill: loaded,
    decisions: rel,
    envelope: { type: 'github.issue', target: 'acme/shop', priority: 'P2' },
    payload: { issue_number: 42 },
  });
  ok(prompt.includes('执行 SOP') && prompt.includes('止步于开 PR'), '提示词里装上 SOP 正文', prompt.slice(0, 80));
  ok(prompt.includes('已定过的事'), '提示词里装上决定记忆', prompt.includes('数据库只增不改'));
  ok(prompt.includes('第一行写结论') && prompt.includes('需要你确认') && prompt.includes('不复述'),
    '提示词带上「写给人看」的汇报规范（2026-11-17）');

  // 回归：SOP 里的 {{hub}} 必须换成真实地址，否则模型收到字面量会直接放弃
  const promptWithHub = hub.skills.buildPrompt({
    task: { title: '出日报', prompt: '汇总一下' },
    skill: { name: 'daily-report', meta: { title: '每日战报' }, body: '调 GET {{hub}}/api/stats 拿统计' },
    decisions: [],
    envelope: { type: 'cron.daily-report', priority: 'P2' },
    payload: {},
    hubUrl: 'http://127.0.0.1:8787',
  });
  ok(!promptWithHub.includes('{{hub}}'), 'SOP 里的 {{hub}} 占位被替换掉');
  ok(promptWithHub.includes('http://127.0.0.1:8787/api/stats'), '替换成真实中台地址', promptWithHub.slice(0, 120));

  // 回归：中台配了真实 hub.secret 后 /api/* 全部 401，SOP 里的 {{token}}
  // 必须换成真实令牌，否则日报在取数第一步就死（2026-11-17 战报实测三个接口全 401）
  const promptWithToken = hub.skills.buildPrompt({
    task: { title: '出日报', prompt: '汇总一下' },
    skill: { name: 'daily-report', meta: { title: '每日战报' }, body: '带头 x-hub-token: {{token}} 调 {{hub}}/api/stats' },
    decisions: [],
    envelope: { type: 'cron.daily-report', priority: 'P2' },
    payload: {},
    hubUrl: 'http://127.0.0.1:8787',
    token: 'e2e-test-token',
  });
  ok(!promptWithToken.includes('{{token}}'), 'SOP 里的 {{token}} 占位被替换掉');
  ok(promptWithToken.includes('x-hub-token: e2e-test-token'), '替换成真实访问令牌', promptWithToken.slice(0, 120));
  // 未配令牌（调用方传空）时替换成哨兵 __TOKEN_NOT_SET__，不再保留字面占位符：
  // 日报 SOP 的兜底判据只认哨兵。旧写法「占位符原样出现=未配密钥」有歧义——
  // 替换后提示词里仍有 token 字样（请求头名等），codex 误判未配密钥、主动省掉
  // 鉴权头，三个接口全 401（2026-11-18 战报实测）
  const promptNoToken = hub.skills.buildPrompt({
    task: { title: '出日报', prompt: '汇总一下' },
    skill: { name: 'daily-report', meta: { title: '每日战报' }, body: '带头 x-hub-token: {{token}} 调 {{hub}}/api/stats' },
    decisions: [],
    envelope: { type: 'cron.daily-report', priority: 'P2' },
    payload: {},
    hubUrl: 'http://127.0.0.1:8787',
  });
  ok(promptNoToken.includes('x-hub-token: __TOKEN_NOT_SET__'), '未配令牌时 {{token}} 替换成哨兵 __TOKEN_NOT_SET__');
  ok(!promptNoToken.includes('{{token}}'), '占位符不再原样保留（消除「原样出现=未配密钥」的歧义判据）');

  /* ─────────── 10. 报告归档 ─────────── */
  section('M6 报告归档');
  const saved = hub.reports.save({ kind: 'daily', title: '每日战报 2026-11-14', body: '# 战报\n\n一切正常。' });
  ok(saved.report_id && fs.existsSync(saved.path), '报告落盘为 Markdown 文件', saved.path);
  const readBack = hub.reports.read(saved.report_id);
  ok(readBack?.body?.includes('一切正常'), '报告能按 id 读回原文');
  const latest = hub.reports.latest('daily');
  ok(latest?.report_id === saved.report_id, 'latest() 取到最新日报', latest?.report_id);

  /* ─────────── 11. M4 流水线（mock） ─────────── */
  section('M4 五步流水线');
  const pid = hub.pipeline.create({ taskId: dispatched.task_id, repo: 'acme/shop', prNumber: 42, prUrl: 'https://github.com/acme/shop/pull/42', engine: 'mock' });
  ok(Boolean(pid), '建出流水线记录', pid);
  const run = await hub.pipeline.run({ pipelineId: pid, repo: 'acme/shop', prNumber: 42, taskId: dispatched.task_id, engine: 'mock' });
  ok(run?.ok === true, '五步全部通过', run?.steps?.map((s) => `${s.step}:${s.ok ? 'ok' : 'fail'}`));
  ok(run?.steps?.length === 5, '真的跑了五步（审查/检查/合并/发布/核实）', run?.steps?.length);
  // 落库形状：一步一行、各有终态、没有残留的 running。
  // （早先每步先插 running 再插 passed，收尾又被批量改成 completed —— 同一个
  //   pipeline 里会同时出现「完成」和 passed，纯属数据错乱。）
  const pipeRows = hub.ledger.all('SELECT step,status FROM pipeline_runs WHERE pipeline_id=? ORDER BY step_index', pid);
  ok(pipeRows.length === 5, '五步各落一行（不多不少）', pipeRows.length);
  ok(pipeRows.every((r) => ['passed', 'failed', 'skipped'].includes(r.status)),
    '每步都到终态，没有残留 running', pipeRows.map((r) => `${r.step}:${r.status}`));
  ok(new Set(pipeRows.map((r) => r.step)).size === 5, '同一 pipeline 内步名不重复', pipeRows.map((r) => r.step));

  /* ─────────── 11b. M4 真跑相关的回归（这几个坑都真实踩过） ─────────── */
  section('M4 回归：dry 探测 / BOM / 审查换引擎 / cmd 传参');
  {
    const m4 = await import('../src/m4/pipeline.mjs');
    // 坑 1：hasGit 曾用 require('node:child_process')，ESM 下恒抛异常 → dry 永远 true，
    //       连"合并一个不存在的仓库"都返回成功。必须真的探测。
    const realRunner = m4.createRunner({ config: hub.config, log: hub.log, mode: 'real' });
    ok(realRunner.dry === false, 'mode=real 时 dry 必须是 false（否则五步全是假的）', realRunner.dry);
    const mockRunner = m4.createRunner({ config: hub.config, log: hub.log, mode: 'mock' });
    ok(mockRunner.dry === true, 'mode=mock 时仍走模拟', mockRunner.dry);

    // 坑 2：审查引擎换不出来时，不能拿 mock 冒充，必须如实跳过并给出原因。
    //       这里显式把 isAvailable 压成「只装了 codex」——装了 claude CLI 的机器上
    //       真实环境永远换得出来，不注入就没法测这条路径。
    const realIsAvailable = hub.pipeline.isAvailable;
    hub.pipeline.isAvailable = (id) => id === 'codex';
    const noSecond = await hub.pipeline.run({
      pipelineId: hub.pipeline.create({ repo: 'acme/shop', prNumber: 43, engine: 'codex' }),
      repo: 'acme/shop', prNumber: 43, engine: 'codex',
    });
    hub.pipeline.isAvailable = realIsAvailable;
    const reviewStep = noSecond.steps.find((s) => s.step === 'review');
    ok(reviewStep?.skipped === true, '换不出第二个引擎时，①审查标记为跳过而不是假装失败', reviewStep);
    ok(typeof reviewStep?.warning === 'string' && reviewStep.warning.includes('审查跳过'),
      '跳过时必须给出人看得懂的原因', reviewStep?.warning?.slice(0, 60));
    ok(noSecond.skipped_steps?.includes('review'), '结果里如实列出被跳过的步骤', noSecond.skipped_steps);

    // 反过来：换得出引擎时必须真的换，不能还用主引擎自审。
    const bothRunners = m4.createRunner({ config: hub.config, log: hub.log, mode: 'mock' });
    ok(typeof bothRunners.runStep === 'function', 'runner 暴露 runStep（dry 之外还要能单独跑一步）');

    // 坑 3（2026-11-14 真实踩到，最难查）：claude.cmd 的 npm shim 是
    //   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
    // 而 resolveNpmShim 当时只认 "%_prog%" "<entry>.js" 这种 node 形状 → 解析不出来
    // → 落到 cmd.exe /c → **cmd.exe 把提示词里的换行当命令分隔符**，多行提示词
    // 被砍到只剩第一行。表现是模型一本正经地回答「你只给了角色设定，没有具体任务」，
    // 于是审查连续 3 轮「不通过」，看起来像模型不配合，实际是传参被截断。
    const enginesMod = await import('../src/m3/engines.mjs');
    // (a) shim 解析必须同时认 .js 与 .exe 两种形状
    const fakeExe = path.join(tmp, 'fake-claude.exe');
    fs.writeFileSync(fakeExe, 'MZ'); // 内容无所谓，只验路径解析
    const fakeShim = path.join(tmp, 'fake-claude.cmd');
    fs.writeFileSync(fakeShim, '@ECHO off\n"%dp0%\\fake-claude.exe"   %*\n');
    const parsed = enginesMod.resolveNpmShim(fakeShim);
    ok(parsed?.bin === fakeExe,
      'npm shim 解析：直接指向 .exe 的 shim（claude-code 是这种）必须解析出来，不能落到 cmd.exe',
      parsed);
    // (b) 万一仍要走 cmd.exe，多行参数必须显式报错，绝不静默截断
    const nlProbe = await enginesMod.runProcess(
      process.env.ComSpec || 'cmd.exe',
      ['/c', 'echo line1\necho line2'],
      { timeoutMs: 20_000 },
    );
    ok(nlProbe.code !== 0 && /换行/.test(nlProbe.stderr || ''),
      'cmd.exe 分支遇到多行参数时显式报错（cmd 会把换行当命令分隔符，静默截断最难查）',
      { code: nlProbe.code, stderr: String(nlProbe.stderr || '').slice(0, 60) });

    // 坑 4（2026-11-14）：`claude -p` 非交互模式下不带 --permission-mode，
    // 任何要写文件/跑命令的工具调用都被自动拒绝（"requires approval"），
    // 而无人可批准 → 模型只在文本里写「做不了」，任务却是 completed + exit 0。
    // **看起来成功，实际一行没改。** 干活模式必须显式 bypassPermissions。
    const workArgs = enginesMod.getEngine('claude-code')
      .buildArgs({ prompt: 'x', workdir: '.', mode: 'work' });
    ok(workArgs.includes('--permission-mode') && workArgs.includes('bypassPermissions'),
      'claude 干活模式必须显式 bypassPermissions（否则 headless 下写操作全被拒，却仍报 completed）',
      workArgs);
    const reviewArgs = enginesMod.getEngine('claude-code')
      .buildArgs({ prompt: 'x', workdir: '.', mode: 'review' });
    ok(reviewArgs[reviewArgs.indexOf('--tools') + 1] === '' && !reviewArgs.includes('bypassPermissions'),
      'claude 审查只读入 diff，关闭工具和干活权限',
      reviewArgs);

    // 坑 5（2026-11-14）：rules.json 改了不生效。RuleSet 只在 constructor 里
    // reload 一次，运行中的进程一直用启动那一刻的规则副本。面板上写着
    // 「改文件后会自动热重载」，实际从来没实现。症状：新规则能匹配（说明旧副本里
    // 就有它），但后补的字段（如 route.workdir）永远读不到，任务被派到错误目录。
    const { RuleSet } = await import('../src/lib/rules.mjs');
    const liveRulesFile = path.join(tmp, 'live-rules.json');
    fs.writeFileSync(liveRulesFile, JSON.stringify({
      rules: [{ id: 'r-live', order: 1, match: { type: 'x' }, route: { engine: 'mock' } }],
    }));
    const liveRules = new RuleSet(liveRulesFile);
    const beforeEdit = liveRules.byId('r-live')?.route?.workdir ?? null;
    // 改文件（mtime 必须变，故先读再写并等待）
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(liveRulesFile, JSON.stringify({
      rules: [{ id: 'r-live', order: 1, match: { type: 'x' }, route: { engine: 'mock', workdir: 'D:/somewhere' } }],
    }));
    const afterEdit = liveRules.byId('r-live')?.route?.workdir ?? null;
    ok(beforeEdit === null && afterEdit === 'D:/somewhere',
      'rules.json 改了要热重载（不重启中台就生效），否则新加的 route.workdir 永远读不到',
      { beforeEdit, afterEdit });

    // 坑 6（2026-11-14）：任务排着队但没有任何在线节点能执行它。
    // 真实撞法：派 {node:'mac-b', engine:'codex'}，而 mac-b 只声明了 mock ——
    // 任务永远停在 queued，谁都不接、谁都不报，面板上看着像「还没轮到」，
    // 实际已经死锁。方案要求「一切留痕、不静默丢」，必须主动告警。
    const starveHub = await makeHub('starved');
    try {
      // 一个只说支持 mock 的节点在线
      await starveHub.hub.queue.poll({ nodeId: 'mac-b', engines: ['mock'], waitSeconds: 1 });
      ok(starveHub.hub.queue.getNodeCapabilities().some((n) => n.id === 'mac-b'),
        '在线节点能力表能记下「谁在线、能跑什么」',
        starveHub.hub.queue.getNodeCapabilities());

      // 派一个 mac-b 上没人能跑的引擎
      const starved = await starveHub.hub.dispatchManual({
        summary: '这活 mac-b 干不了（它没有 codex）',
        node: 'mac-b', engine: 'codex', dedupe_key: 'starved-1',
      });
      // 把 created_at 提前，模拟「已经等了很久」，再手动触发一次巡检
      starveHub.hub.ledger.run(
        `UPDATE tasks SET created_at=? WHERE task_id=?`,
        new Date(Date.now() - 600_000).toISOString(), starved.task_id,
      );
      await starveHub.hub.queue.sweepNow();
      const note = starveHub.hub.ledger.get(
        `SELECT * FROM notifications WHERE kind='starved' AND ref LIKE ? ORDER BY created_at DESC LIMIT 1`,
        `%${starved.task_id}%`,
      );
      ok(Boolean(note), '没人能接的任务会被判为饥饿并告警，而不是永远静默排队', note?.title || null);
      ok(/引擎 codex/.test(note?.body || ''),
        '饥饿告警要写清「谁在线、为什么不匹配」，否则人也不知道该改什么',
        String(note?.body || '').slice(0, 160));

      // 任务仍在排队，没被误杀 —— 告警不等于放弃
      const stillQueued = starveHub.hub.ledger.get(`SELECT status FROM tasks WHERE task_id=?`, starved.task_id);
      ok(stillQueued?.status === 'queued', '饥饿只是告警，不能把任务标成失败或丢掉', stillQueued?.status);

      // 重复巡检不能刷屏（只告一次）
      await starveHub.hub.queue.sweepNow();
      const dup = starveHub.hub.ledger.get(
        `SELECT COUNT(*) c FROM notifications WHERE kind='starved' AND ref LIKE ?`,
        `%${starved.task_id}%`,
      );
      ok(dup.c === 1, '同一个饥饿任务只告警一次，不能每 5 秒刷一条', dup.c);
    } finally {
      starveHub.hub.queue.stop();
      starveHub.hub.ledger.close();
    }
  }

  /* ─────────── 12. 台账完整性 ─────────── */
  section('M6 台账留痕（一切留痕铁律）');
  const auditCount = hub.ledger.get('SELECT COUNT(*) c FROM event_audit').c;
  ok(auditCount > 10, '审计表记录了每一步状态变化', auditCount);
  const notifCount = hub.ledger.get('SELECT COUNT(*) c FROM notifications').c;
  ok(notifCount >= 3, '通知也进了台账', notifCount);
  const stats = hub.stats();
  ok(stats && typeof stats.totals === 'object' && typeof stats.totals.tasks === 'number', '统计口径可出（供日报用）', Object.keys(stats));

  /* ─────────── 13. 直推规则（action:notify） ─────────── */
  section('M2 action:notify 规则 → 不派活直接票拟');
  const notifyRes = await hub.ingestAsync({
    source: 'monitor', type: 'release.failed', target: 'acme/shop',
    summary: '发布失败：生产环境未更新', priority: 'P0', dedupe_key: 'rel-fail-1',
  }, 'test');
  ok(notifyRes.notified === true, 'release.failed 不建任务，直接推人', notifyRes);
  const direct = hub.ledger.get(`SELECT * FROM approvals WHERE event_id=?`, notifyRes.event_id);
  ok(Boolean(direct), '生成了对应的票拟', direct?.title);

  /* ─────────── 14. 飞书验签（谁能批红） ─────────── */
  section('M1 飞书入口：验签是批红的唯一防线');
  const crypto = await import('node:crypto');
  const token = 'e2e-verify-token';
  const feishuSvc = new (await import('../src/m5/feishu.mjs')).FeishuClient(
    { verificationToken: token }, { info() {}, warn() {}, error() {}, debug() {} },
  );
  const signFor = (ts, nonce, raw, algo = 'sha1') =>
    crypto.createHash(algo).update(String(ts) + String(nonce) + token + raw).digest('hex');
  const rawBody = '{"action":{"value":{"action":"approval:agree","approval_id":"apr_x"}}}';

  ok(feishuSvc.verifySignature({
    timestamp: '1700000000', nonce: 'n', body: rawBody, token, signature: signFor('1700000000', 'n', rawBody),
  }) === true, '合法签名通过');

  // 回归：旧实现 `calc === signature || !signature` 会让缺签名的请求通过
  ok(feishuSvc.verifySignature({ timestamp: '1700000000', nonce: 'n', body: rawBody, token, signature: null }) === false,
    '缺签名必须拒绝（否则任何人都能伪造批红）');

  ok(feishuSvc.verifySignature({
    timestamp: '1700000001', nonce: 'n', body: rawBody, token, signature: signFor('1700000000', 'n', rawBody),
  }) === false, '时间戳被换必须拒绝（防重放）');

  ok(feishuSvc.verifySignature({
    timestamp: '1700000000', nonce: 'n', body: rawBody, token, signature: signFor('1700000000', 'n', rawBody + ' '),
  }) === false, '正文被改必须拒绝');

  /* ─────────── 收尾 ─────────── */
  const dbSize = fs.statSync(path.join(tmp, 'hub.db')).size;
  ok(dbSize > 0, 'SQLite 台账已落盘', `${dbSize} bytes`);

  hub.stop();
  hub.ledger.close();

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  · ${f.name} → ${JSON.stringify(f.detail ?? null).slice(0, 400)}`);
  }
  // 明确打一行结论：PowerShell 管道会把 $LASTEXITCODE 换成管道末尾命令的退出码，
  // 光看 exit code 容易把「全过」误判成失败（或反之）。这行是给人看的权威结论。
  console.log(failed ? '\nE2E_RESULT=FAIL' : `\nE2E_RESULT=PASS (${passed} 项)`);
  console.log(`${'═'.repeat(64)}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('\n自测崩溃：', err);
  process.exitCode = 1;
});
