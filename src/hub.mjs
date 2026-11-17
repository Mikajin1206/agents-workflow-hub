import path from 'node:path';
import { loadConfig, ensureDirs, nowIso, addSeconds } from './lib/config.mjs';
import { createLogger } from './lib/logger.mjs';
import { openLedger } from './lib/ledger.mjs';
import { RuleSet } from './lib/rules.mjs';
import { EventService, EVENT_STATUS, parseTask, parseApproval } from './m2/events.mjs';
import { TaskQueue } from './m2/queue.mjs';
import { ApprovalService, Notifier } from './m5/approvals.mjs';
import { FeishuClient } from './m5/feishu.mjs';
import { SkillLibrary } from './m6/skills.mjs';
import { DecisionMemory } from './m6/decisions.mjs';
import { ReportStore, ledgerReport } from './m6/reports.mjs';
import { CronScheduler } from './m1/cron-adapter.mjs';
import { WebhookAdapter } from './m1/webhook-adapter.mjs';
import { Pipeline, createRunner } from './m4/pipeline.mjs';
import { listEngines } from './m3/engines.mjs';
import { newTaskId } from './lib/ids.mjs';

/**
 * 中台装配（方案 §4 六模块接线）。
 *
 *   M1 接入 → M2 调度 → M3 执行（节点主动来取） → M4 流水线 → M5 决策/通知 → M6 资产
 *
 * 这个类是唯一持有全部依赖的地方，其余模块只依赖接口。
 */
export class Hub {
  constructor(options = {}) {
    this.config = options.config || loadConfig();
    ensureDirs(this.config);
    this.log = options.logger || createLogger({
      dir: this.config.paths.logs,
      level: options.logLevel || this.config.logging.level,
      name: 'hub',
    });
    this.ledger = openLedger(this.config.paths.db);
    this.rules = new RuleSet(this.config.paths.rules);
    if (this.rules.error) this.log.warn('规则加载异常', { error: this.rules.error });

    this.feishu = new FeishuClient(this.config.feishu, this.log);
    this.notifier = new Notifier({ ledger: this.ledger, log: this.log, config: this.config });
    this.notifier.setFeishuClient(this.feishu);

    this.approvals = new ApprovalService({
      ledger: this.ledger, log: this.log, config: this.config, notifier: this.notifier,
    });
    this.events = new EventService({
      ledger: this.ledger, rules: this.rules, log: this.log, config: this.config,
    });
    this.queue = new TaskQueue({
      ledger: this.ledger, log: this.log, config: this.config, notifier: this.notifier,
    });
    // 说明：#sweepStarved 直接调 this.getNodeCapabilities()，能力表由 queue 自己在
    // poll / heartbeat 时用 noteNode() 维护，这里不需要额外注入。
    this.skills = new SkillLibrary({ dir: this.config.paths.skills, log: this.log });
    /** 引擎清单（CLI/面板用） */
    this.engines = { list: () => listEngines() };
    this.decisions = new DecisionMemory({
      ledger: this.ledger, dir: this.config.paths.decisions, config: this.config, log: this.log,
    });
    this.reports = new ReportStore({ ledger: this.ledger, dir: this.config.paths.reports, log: this.log });

    this.cron = new CronScheduler({ config: this.config, events: this.events, log: this.log });
    this.cron.loadFromRules(this.rules);

    this.webhooks = new WebhookAdapter({ config: this.config, events: this.events, log: this.log });

    this.pipeline = new Pipeline({
      ledger: this.ledger,
      log: this.log,
      config: this.config,
      runner: createRunner({
        config: this.config,
        log: this.log,
        engines: listEngines(),
        mode: this.config.pipeline?.mode || 'auto',
      }),
      notifier: this.notifier,
      approvals: this.approvals,
    });
    // 审查换引擎时要判断目标引擎是否真装了
    this.pipeline.isAvailable = (id) => listEngines().some((e) => e.id === id && e.available);

    // 新任务入队立刻唤醒挂起节点（长轮询毫秒级响应）
    this.events.onQueued = () => this.queue.wakeAll();

    // action:'notify' 规则：不派活，直接建票拟 + 按等级推人
    this.events.onNotify = async ({ eventId, rule, env }) => {
      await this.#notifyDirect({ eventId, rule, env });
    };

    // 规则 approval:'always'（如周日大扫除）：任务停在 awaiting_approval，
    // 票拟单必须真的建出来并把 approval_id 挂回任务 —— 否则没人能批，
    // 任务永久卡死（实测踩过：r09-cleanup 派出后 approval_id 为 null）。
    this.events.onApprovalRequired = async ({ eventId, rule, env, task }) => {
      await this.#approvalForAwaitingTask({ eventId, rule, env, task });
    };

    // 批红通过后任务回 queued，立刻唤醒长轮询里的节点（否则最多干等 50 秒）
    this.approvals.onApproved = () => this.queue.wakeAll();

    // 查询反馈被「采纳」：把答复里的执行建议派成新任务去执行（2026-11-17 分类口径）。
    // 铁律不变——任务照常受必问清单与止步 PR 约束，采纳只是替老板点了个「开工」。
    this.approvals.onAdopt = async ({ approval, by }) => {
      const res = await this.dispatchManual({
        type: 'cmd.manual',
        source: 'adopt',
        summary: `采纳执行：${approval.title}`,
        priority: 'P1',
        node: 'win-a',
        engine: 'claude-code',
        prompt: [
          `老板已采纳一条查询答复里的执行建议，请按建议执行。`,
          `原查询：${approval.title}`,
          '',
          approval.proposal || approval.question || '',
          '',
          '铁律照旧：不询问不等待；代码类止步于提交 + 开 PR；碰到必问清单（删数据/停服/花钱/对外发消息/改方向/密钥/权限）停下来写「需要批红」。',
        ].join('\n'),
      });
      this.log.info('已采纳查询建议，派后续任务', { approval: approval.approval_id, task: res.task_id, by });
      return res;
    };

    this.startedAt = nowIso();
  }

  start() {
    this.queue.start();
    this.approvals.start();
    this.cron.start();
    this.log.info('中台已启动', {
      port: this.config.hub.port,
      rules: this.rules.size,
      skills: this.skills.list().length,
      timers: this.cron.timers.length,
      feishu: this.feishu.enabled ? 'enabled' : 'disabled(local fallback)',
    });
  }

  stop() {
    this.queue.stop();
    this.approvals.stop();
    this.cron.stop();
    this.log.close();
  }

  /** M1 统一入口：任何通道都从这里进（同步版，action:notify 的推送由 ingestAsync 负责） */
  ingest(input, actor, opts) {
    return this.events.ingest(input, actor, opts);
  }

  /** M1 统一入口（异步版）：等 action:'notify' 的推送真正落库后再返回 */
  ingestAsync(input, actor, opts) {
    return this.events.ingestAsync(input, actor, opts);
  }

  /** M2 结果回写后的收尾：推进事件状态 + 触发 M4 + 按需票拟 */
  async afterTaskUpdate(taskId) {
    const task = parseTask(this.ledger.get('SELECT * FROM tasks WHERE task_id=?', taskId));
    if (!task) return null;
    const event = this.events.getEvent(task.event_id);

    if (task.status === 'completed') {
      this.events.updateEventStatus(task.event_id, EVENT_STATUS.COMPLETED, { task: taskId });
      await this.#maybePipeline(task, event);
      // 命中必问清单的产出，转成待批红（返回票拟单，给 #deliverResult 并卡用）
      const escalated = await this.#maybeEscalate(task, event);
      // 规则写了 silent:false 的（每日战报、周报这类），产出必须推给人。
      // 之前这里只打了一行「静默完成」日志，等于把「不静默」做成了静默：
      // 战报 07:30 准时跑完，却没有人收到任何东西。
      // 飞书答复命中必问清单时，批红信息在这里并入答复一次推送（修「dev 双推」）。
      await this.#deliverResult(task, escalated);
    } else if (task.status === 'failed') {
      this.events.updateEventStatus(task.event_id, EVENT_STATUS.FAILED, { task: taskId, error: task.error });
      const envelope = task.meta?.envelope || {};
      const isFeishuReply = envelope.source === 'feishu';
      const replyChatId = isFeishuReply ? (task.meta?.payload?.chat_id || null) : null;
      const ask = this.approvals.classify(`${task.title} ${task.error || ''}`);
      // 提问失败也要回话：否则人只看到「任务失败」的台账记录，不知道为什么。
      // 命中必问清单时不再「失败通知 + 批红卡」连发两道：票拟只建单不推卡，
      // 批红信息并入失败回话一次推送（2026-11-17 修「dev 双推」）。
      if (isFeishuReply) {
        const ticket = ask.length ? await this.approvals.create({
          title: `任务失败：${task.title}`,
          question: `任务 ${taskId} 执行失败，且涉及 ${ask.join('/')}。要重试、改派，还是先搁着？`,
          proposal: `错误：${(task.error || '').slice(0, 800)}`,
          taskId, eventId: task.event_id, category: ask[0],
          push: false,
        }) : null;
        const answer = `任务 ${taskId} 失败了。\n\n错误：${(task.error || '未知错误').slice(0, 800)}\n\n可以在面板「任务」页看完整日志，或直接再问一次。`;
        if (ticket) {
          const sent = await this.notifier.notify({
            level: 'P1',
            kind: 'approval',
            title: `【待批红·${ticket.meta?.category_label || ticket.category}】没做成：${task.title || taskId}`,
            body: this.approvals.renderReplyMergedText(ticket, answer),
            ref: { approval_id: ticket.approval_id, task_id: taskId, event_id: task.event_id },
            dedupeRef: `task_failed:${taskId}`,
            card: { approvalId: ticket.approval_id, options: ticket.options || ['agree', 'reject', 'revise'] },
            chatId: replyChatId,
          });
          this.ledger.run(`UPDATE approvals SET channel=? WHERE approval_id=?`, sent?.channel || 'local', ticket.approval_id);
        } else {
          await this.notifier.notify({
            level: 'P1',
            kind: 'feishu_reply',
            title: `没做成：${task.title || taskId}`,
            body: answer,
            ref: taskId,
            dedupeRef: `task_failed:${taskId}`,
            chatId: replyChatId,
          });
        }
      } else if (ask.length) {
        // 非飞书来源的失败：票拟照旧单独推卡（默认会话），不存在「双推」问题
        await this.approvals.create({
          title: `任务失败：${task.title}`,
          question: `任务 ${taskId} 执行失败，且涉及 ${ask.join('/')}。要重试、改派，还是先搁着？`,
          proposal: `错误：${(task.error || '').slice(0, 800)}`,
          taskId, eventId: task.event_id, category: ask[0],
        });
      }
    } else if (task.status === 'dead_letter') {
      this.events.updateEventStatus(task.event_id, EVENT_STATUS.DEAD_LETTER, { task: taskId, error: task.error });
      this.log.error('任务进入死信', { task: taskId, error: task.error });
      const envelope = task.meta?.envelope || {};
      const isFeishuReply = envelope.source === 'feishu';
      await this.notifier.notify({
        level: 'P1',
        kind: isFeishuReply ? 'feishu_reply' : 'dead_letter',
        title: `任务死信：${task.title}`,
        body: `任务 ${taskId} 重试 ${task.attempts} 次仍失败，已进死信。\n错误：${(task.error || '').slice(0, 500)}`,
        ref: taskId,
        dedupeRef: `dead_letter:${taskId}`,
        chatId: isFeishuReply ? (task.meta?.payload?.chat_id || null) : null,
      });
    }
    return task;
  }

  /** action:'notify' 规则：不派活，直接建票拟 + 按等级推人 */
  async #notifyDirect({ eventId, rule, env }) {
    const approval = await this.approvals.create({
      title: env.summary || rule.title || env.type,
      question: rule.prompt || '需要人工判断，请批红。',
      proposal: [
        `事件：${env.type}${env.target ? ' · ' + env.target : ''}`,
        env.link ? `链接：${env.link}` : '',
        env.payload && Object.keys(env.payload).length ? `参数：${JSON.stringify(env.payload).slice(0, 1200)}` : '',
      ].filter(Boolean).join('\n'),
      eventId,
      category: this.approvals.classify(`${env.summary} ${env.type} ${rule.prompt}`)[0] || 'product_direction',
    });
    this.log.info('已生成直推票拟', { event: eventId, approval: approval.approval_id, level: rule.notifyLevel });
    return approval;
  }

  /**
   * 规则 approval:'always'：给停在 awaiting_approval 的任务补建票拟单。
   *
   * 批准后 decide() 会把任务回 queued 并触发 onApproved → wakeAll；
   * 驳回则任务进 rejected、事件记「定了不做的事」。
   */
  async #approvalForAwaitingTask({ eventId, rule, env, task }) {
    const already = this.ledger.get('SELECT approval_id FROM approvals WHERE task_id=?', task.task_id);
    if (already?.approval_id) return;
    const category = this.approvals.classify(`${task.title} ${rule.prompt || ''}`)[0] || 'manual';
    const catDef = this.config.approvals.categories.find((c) => c.id === category);
    const created = await this.approvals.create({
      title: task.title,
      question: rule.prompt || `该操作属于必问清单（${catDef?.label || category}），是否准予执行？`,
      proposal: [
        `规则：${rule.id}`,
        `引擎：${task.engine} · 节点：${task.node}${task.skill ? ` · 技能：${task.skill}` : ''}`,
        env.summary || '',
      ].filter(Boolean).join('\n'),
      taskId: task.task_id, eventId, category,
      requestedBy: `rule:${rule.id}`,
    });
    if (created?.approval_id) {
      this.ledger.run('UPDATE tasks SET approval_id=? WHERE task_id=?', created.approval_id, task.task_id);
      this.log.info('必批任务已挂票拟', { task: task.task_id, approval: created.approval_id, category });
    }
  }

  /** 代码类产出 → 进 M4 流水线 */
  async #maybePipeline(task, event) {
    const wantsPr = /PR|pull request|已开\s*PR|github\.com\/.+\/pull\//i.test(task.result?.text || '');
    const codeType = ['github.issue', 'cmd.manual', 'cron.repo-sweep'].includes(event?.type);
    if (!wantsPr || !codeType) return;
    if (this.config.pipeline?.autoStart === false) {
      this.log.info('流水线自动启动已关闭，仅记录', { task: task.task_id });
      return;
    }
    const prUrl = (task.result?.text || '').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
    const repo = event.target;
    const prNumber = prUrl ? Number(prUrl.split('/').pop()) : null;
    if (!repo || !prNumber) return;
    const pipelineId = this.pipeline.create({
      taskId: task.task_id, repo, prNumber, prUrl, engine: task.engine,
    });
    this.log.info('进入 M4 流水线', { pipeline: pipelineId, repo, pr: prNumber });
    this.pipeline.run({ pipelineId, repo, prNumber, prUrl, taskId: task.task_id, engine: task.engine })
      .catch((err) => this.log.error('流水线异常', { pipeline: pipelineId, error: err.message }));
  }

  /**
   * 产出里出现必问清单动作 → 必须票拟。返回建出的票拟单（没有则 null），
   * 供 #deliverResult 把批红信息并入答复推送。
   */
  async #maybeEscalate(task, event) {
    // 查询任务的产出只是「建议」，没有在执行任何东西；执行入口是反馈卡上的
    // 「采纳」（采纳后派的新任务会正常走这道 escalate）。在这里再推一张
    // 「是否准予继续执行」的批红卡，是对同一段文字的双重打扰。
    if (task.skill === 'query') return null;
    const hits = this.approvals.classify(`${task.result?.text || ''}`);
    if (!hits.length) return null;
    // 只有没有「还在拦着」的票拟时才建新单：
    // approval:'always' 的任务（如周日大扫除）进场时已有一张票拟，批准跑完后，
    // 产出里若再次提出要删东西（「将删除：本地分支…」），那是**新的动作**，
    // 必须有自己的第二张票拟 —— 不能因为「这任务有过票拟」就放走。
    const blocking = this.ledger.get(
      `SELECT approval_id FROM approvals WHERE task_id=? AND status IN ('pending','approved','executing')`,
      task.task_id,
    );
    if (blocking) return null;
    const cat = this.config.approvals.categories.find((c) => c.id === hits[0]);
    // 飞书答复：票拟只建单不推卡（push:false），待批红信息由 #deliverResult
    // 并入答复一次推送 —— 不再「票拟卡 + 答复文本」连发两道（2026-11-17 修「dev 双推」）。
    // 非飞书来源（战报/巡检这类）没有「连发两道」问题，票拟照旧单独推卡。
    const envelope = task.meta?.envelope || {};
    const isFeishuReply = envelope.source === 'feishu';
    return await this.approvals.create({
      title: `执行结果涉及「${cat?.label || hits[0]}」：${task.title}`,
      question: `任务已完成分析，但其结果涉及「${cat?.label || hits[0]}」。是否准予继续执行这一步？`,
      proposal: (task.result?.text || '').slice(0, 3000),
      taskId: task.task_id, eventId: task.event_id, category: hits[0],
      ...(isFeishuReply ? { push: false } : {}),
    });
  }

  /**
   * 把任务产出推给人（方案 §7 通知分层）。
   *
   * 判据是「这条规则要不要人看」= meta.silent === false，而不是反过来。
   * 只有 silent:false 的产出（战报/周报/巡检报告）才推；其余一律
   * 只写台账 —— 这是「白名单之外全权做完不打扰人」那条铁律的落点。
   *
   * 等级按任务优先级走：P2 进每日战报聚合队列（07:30 一起发），
   * P0/P1 立即推送。产出全文同时归档进报告库，推送里只放摘要 + 报告号。
   */
  async #deliverResult(task, escalated = null) {
    // 飞书消息是「有人问我话」，产出是回答，不是系统主动打扰。
    // 回答必须回到提问的那个会话 —— 否则人在群里问了「现在的工作状态」，
    // 看见任务跑完，却永远等不到答案（silent:true 会直接把回答吞掉）。
    const envelope = task.meta?.envelope || {};
    const isFeishuReply = envelope.source === 'feishu';
    const replyChatId = isFeishuReply ? (task.meta?.payload?.chat_id || null) : null;

    if (task.meta?.silent !== false && !isFeishuReply) return;  // 静默任务：只写台账
    const text = task.result?.text || '';
    if (!text.trim()) return;

    const report = this.reports.save({
      kind: 'task_output',
      title: task.title || task.task_id,
      body: text,
      taskId: task.task_id,
      eventId: task.event_id,
      meta: { engine: task.engine, node: task.node, skill: task.skill },
    });

    // 「查询」分类（2026-11-17 口径）：答复不直接回文本，而是转成反馈卡——
    // 问题理解/问题分析/执行建议 + 已阅/采纳/驳回/改派四个按钮。
    // 采纳才会真正执行建议；已阅/驳回只做记录。
    if (isFeishuReply && task.skill === 'query') {
      const approval = await this.approvals.create({
        title: task.title || '查询答复',
        question: '查询答复如下，请点按钮反馈（已阅 / 采纳 / 驳回 / 改派）：',
        proposal: text,
        eventId: task.event_id,
        category: 'query',
        options: ['ack', 'adopt', 'reject', 'revise'],
        chatId: replyChatId,
        requestedBy: `task:${task.task_id}`,
        payload: { kind: 'query_feedback', task_id: task.task_id },
      });
      this.log.info('查询答复已转反馈卡', { task: task.task_id, approval: approval.approval_id, report: report.report_id });
      return;
    }

    // 命中必问清单的飞书答复（dev 这类开发任务）：答复与批红并一张卡 ——
    // 答复正文在上、批红信息在下，按钮直接挂在同一张卡上（批 / 驳回 / 改派）。
    // 票拟单已在 #maybeEscalate 建好（push:false），这里只补一次合并推送，
    // 不再「票拟卡 + 答复文本」连发两道（2026-11-17 修「dev 双推」）。
    if (isFeishuReply && escalated) {
      const footer = text.length > 1800 ? `\n…（全文见报告库 ${report.report_id}）` : '';
      const sent = await this.notifier.notify({
        level: 'P1',
        kind: 'approval',
        title: `【待批红·${escalated.meta?.category_label || escalated.category}】${task.title || '答复'}`,
        body: this.approvals.renderReplyMergedText(escalated, `${text.slice(0, 1800)}${footer}`),
        ref: { approval_id: escalated.approval_id, task_id: task.task_id, event_id: task.event_id },
        dedupeRef: `task_result:${task.task_id}`,
        card: { approvalId: escalated.approval_id, options: escalated.options || ['agree', 'reject', 'revise'] },
        chatId: replyChatId,
      });
      this.ledger.run(`UPDATE approvals SET channel=? WHERE approval_id=?`, sent?.channel || 'local', escalated.approval_id);
      this.log.info('答复与待批红已并一张卡推送', {
        task: task.task_id, approval: escalated.approval_id, report: report.report_id, channel: sent?.channel,
      });
      return;
    }

    const level = task.priority || 'P2';
    const footer = text.length > 1500 ? `\n…（全文见报告库 ${report.report_id}）` : '';
    // 战报/周报就是聚合出口本身：它不能再进自己的聚合队列，否则 07:30
    // 跑完的战报只是「攒起来等下一条战报带出去」，永远没人看到。
    // 所以聚合任务的产出按 P1 立即送出，并把攒下的 P2 一并带上。
    const isAggregator = task.skill === 'daily-report' || task.skill === 'weekly-report';
    const digestBlock = isAggregator ? this.#renderDigest() : '';
    await this.notifier.notify({
      level: isAggregator ? 'P1' : level,
      kind: isFeishuReply ? 'feishu_reply' : 'task_result',
      title: task.title || `任务完成：${task.task_id}`,
      body: `${text.slice(0, 1500)}${footer}${digestBlock}`,
      ref: task.task_id,
      dedupeRef: `task_result:${task.task_id}`,
      chatId: replyChatId,
    });
    this.log.info('任务产出已推送', { task: task.task_id, level, report: report.report_id, reply: isFeishuReply });
  }

  /**
   * 把累积的 P2 排成一段附在战报后面，并标记为已发。
   * 只在聚合任务里调用（每日 07:30 / 周日），避免把聚合块塞进普通任务的推送。
   */
  #renderDigest() {
    const items = this.notifier.drainDigest();
    if (!items.length) return '';
    const lines = items.slice(0, 30).map((i) => `· ${i.title}${i.body ? '：' + String(i.body).replace(/\s+/g, ' ').slice(0, 80) : ''}`);
    if (items.length > 30) lines.push(`· …另有 ${items.length - 30} 条`);
    this.notifier.markDigestSent(items.map((i) => i.id));
    this.log.info('聚合队列已随战报发出', { count: items.length });
    return `\n\n【其间攒下的 ${items.length} 条常规通知】\n${lines.join('\n')}`;
  }

  /** 手动/定时派活（不经规则，直接指定引擎，用于面板与 CLI） */
  async dispatchManual({ type = 'cmd.manual', target, summary, payload = {}, node, engine, model, skill, prompt, workdir, priority = 'P2', source = 'cli', approvalRequired }) {
    // 明确指定了引擎 → 跳过规则匹配，直接建任务；否则走规则
    const explicit = Boolean(engine);
    const env = await this.ingestAsync({
      source, type, target, summary: summary || `${type} ${target || ''}`.trim(),
      priority, dedupe_key: `${type}#${target || ''}#${Date.now()}`,
      payload: { ...payload, ...(approvalRequired ? { approval_required: true } : {}) },
    }, source, { noRoute: explicit });
    if (env.unrouted || env.duplicate) {
      // 规则没覆盖 / 明确指定引擎 → 直接建任务（面板手填的场景）
      const taskId = this.#createAdhocTask({ type, target, summary, payload, node, engine, model, skill, prompt, workdir, priority, source, eventId: env.event_id, approvalRequired });
      return { ok: true, event_id: env.event_id, task_id: taskId, adhoc: true };
    }
    return { ok: true, event_id: env.event_id, task_id: env.task?.task_id, status: env.status };
  }

  #createAdhocTask({ type, target, summary, payload, node, engine, model, skill, prompt, workdir, priority, source, eventId, approvalRequired }) {
    const id = newTaskId();
    const now = nowIso();
    const status = approvalRequired ? 'awaiting_approval' : 'queued';
    this.ledger.run(
      `INSERT INTO tasks(task_id,event_id,rule_id,title,node,engine,model,skill,prompt,status,priority,attempts,max_attempts,concurrency_key,workdir,created_at,available_at,meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, eventId, 'adhoc', summary || `${type}`, node || 'any', engine || 'mock', model || null,
      skill || null, prompt || '', status, priority, 0, 3, `adhoc:${id}`, workdir || this.config.paths.root, now, now,
      JSON.stringify({ rule_id: 'adhoc', silent: false, limits: { max_parallel: 3, timeout_seconds: 900 }, envelope: { source, type, target, priority }, payload }),
    );
    this.ledger.run(`UPDATE events SET status=?, rule_id='adhoc', updated_at=? WHERE event_id=?`, status === 'queued' ? 'routed' : 'awaiting_approval', now, eventId);
    this.ledger.audit({ entity: 'task', entityId: id, toStatus: status, actor: source || 'cli', detail: { adhoc: true, engine, node } });
    if (status === 'queued') this.queue.wakeAll();
    return id;
  }

  /** 面板/接口用的一次性快照 */
  snapshot() {
    const q = (sql, ...p) => this.ledger.get(sql, ...p)?.c ?? 0;
    return {
      ok: true,
      hub: {
        started_at: this.startedAt,
        uptime_seconds: Math.round((Date.now() - Date.parse(this.startedAt)) / 1000),
        rules: this.rules.size,
        rules_error: this.rules.error,
        skills: this.skills.list(),
        engines: listEngines(),
        timers: this.cron.describe(),
        feishu: { enabled: this.feishu.enabled, chat: Boolean(this.config.feishu.chatId) },
      },
      counters: {
        events_total: q(`SELECT COUNT(*) c FROM events WHERE status<>'duplicate'`),
        duplicates: q(`SELECT COUNT(*) c FROM events WHERE status='duplicate'`),
        queued: q(`SELECT COUNT(*) c FROM tasks WHERE status='queued'`),
        running: q(`SELECT COUNT(*) c FROM tasks WHERE status IN ('leased','running')`),
        completed: q(`SELECT COUNT(*) c FROM tasks WHERE status='completed'`),
        failed: q(`SELECT COUNT(*) c FROM tasks WHERE status IN ('failed','dead_letter')`),
        unrouted: q(`SELECT COUNT(*) c FROM events WHERE status='unrouted'`),
        approvals_pending: q(`SELECT COUNT(*) c FROM approvals WHERE status='pending'`),
        approvals_total: q(`SELECT COUNT(*) c FROM approvals`),
        decisions: q(`SELECT COUNT(*) c FROM decisions WHERE active=1`),
        reports: q(`SELECT COUNT(*) c FROM reports`),
      },
      recent_events: this.events.listEvents({ limit: 20 }),
      recent_tasks: this.ledger.all(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 20`).map(parseTask),
      pending_approvals: this.approvals.pending(),
      notifications: this.notifier.listRecent(15),
      pipeline: this.pipeline.history({ limit: 10 }),
    };
  }

  stats({ since, until } = {}) {
    return ledgerReport({ ledger: this.ledger, since, until });
  }
}
