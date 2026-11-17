import fs from 'node:fs';
import path from 'node:path';
import { nowIso, addSeconds } from '../lib/config.mjs';
import { newApprovalId, newNotificationId } from '../lib/ids.mjs';
import { parseApproval } from '../m2/events.mjs';
import { forHuman } from '../lib/human-text.mjs';

/**
 * M5 决策反馈层（方案 §7）。
 *
 * 三条硬规矩：
 *  1) 只有命中必问清单的事才能推到人面前，白名单外全权做完只写台账。
 *  2) 待批红的卡片绝不默认同意，超时只升级提醒一次，然后继续等。
 *  3) 唯一通知出口 = 飞书；飞书未配置时退化为本地控制台/面板队列（不丢件）。
 */

export const APPROVAL_STATUS = {
  PENDING: 'pending',
  REVISING: 'revising',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTING: 'executing',
  EXECUTED: 'executed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

const APPROVAL_TRANSITIONS = {
  // pending 可直达 executed：「已阅」这类不需要任何操作、只记录问题的反馈
  // 不该被逼着走完 approve→execute 两步。
  pending: ['approved', 'rejected', 'revising', 'expired', 'cancelled', 'executed'],
  revising: ['pending', 'cancelled'],
  approved: ['executing', 'executed', 'cancelled'],
  executing: ['executed', 'rejected'],
  rejected: ['revising'],
  executed: [],
  expired: ['approved', 'rejected'],
  cancelled: [],
};

export class ApprovalService {
  constructor({ ledger, log, config, notifier }) {
    this.ledger = ledger;
    this.log = log;
    this.config = config;
    this.notifier = notifier;
    /** 批红通过、任务回 queued 之后由 Hub 注入唤醒逻辑（长轮询节点等活中） */
    this.onApproved = () => {};
    /** 查询反馈被「采纳」后由 Hub 注入：把建议派成新任务去执行 */
    this.onAdopt = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#checkDue().catch((e) => this.log.error('审批巡检失败', { e: e.message })), 60_000);
    this.timer.unref?.();
    this.#checkDue().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 判断一段文本/指令命中了必问清单的哪些分类 */
  classify(text) {
    const categories = this.config.approvals.categories || [];
    const hay = String(text || '').toLowerCase();
    return categories
      .filter((c) => (c.keywords || []).some((k) => matchKeyword(hay, k, c.id)) || semanticHit(c.id, hay))
      .map((c) => c.id);
  }

  isAlwaysRequired(categoryId) {
    return (this.config.approvals.categories || []).some((c) => c.id === categoryId);
  }

  /**
   * 创建票拟（待批红）。
   * @param {{title:string, question:string, proposal?:string, category?:string, options?:string[],
   *          taskId?:string, eventId?:string, requestedBy?:string, payload?:object, chatId?:string,
   *          push?:boolean}} input
   *  chatId：指定卡片送达的飞书会话（查询答复要回到提问的那个 p2p 会话）。
   *  push:false 只建单不推卡 —— 给「答复命中必问清单」的场景用：票拟由调用方
   *  并入答复一次推送（修「dev 双推」），避免同一段文字连发两道。
   *  票拟单照常落库、可批可驳，超时提醒（checkDue）不依赖这条推送，照常生效。
   */
  async create(input) {
    const category = input.category || this.classify(`${input.title} ${input.question} ${input.proposal || ''}`)[0] || 'manual';
    const now = nowIso();
    const id = newApprovalId();
    const dueAt = addSeconds(now, this.config.approvals.reminderHours * 3600);
    const options = input.options || ['agree', 'reject', 'revise'];
    const catLabel = (this.config.approvals.categories || []).find((c) => c.id === category)?.label
      || EXTRA_CATEGORY_LABELS[category] || category;

    this.ledger.run(
      `INSERT INTO approvals(approval_id,event_id,task_id,category,title,question,proposal,options,status,revision,
        requested_by,created_at,updated_at,due_at,channel,meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.eventId || null, input.taskId || null, category,
      input.title || '待批红事项', input.question || '是否准予？', input.proposal || null,
      JSON.stringify(options), APPROVAL_STATUS.PENDING, 1, input.requestedBy || 'm5',
      now, now, dueAt, null,
      JSON.stringify({ category_label: catLabel, payload: input.payload || {}, silent: false }),
    );
    this.ledger.audit({
      entity: 'approval', entityId: id, toStatus: APPROVAL_STATUS.PENDING, actor: input.requestedBy || 'm5',
      detail: { category, category_label: catLabel, task: input.taskId || null },
    });

    if (input.push === false) {
      // 不单独推卡：channel 记 'merged'，批红信息由调用方并入答复一次推送。
      this.ledger.run(`UPDATE approvals SET channel=? WHERE approval_id=?`, 'merged', id);
      this.log.info('已票拟待批红（不单独推卡，由调用方并入答复推送）', { approval: id, category });
      return this.get(id);
    }

    const sent = await this.notifier.notify({
      level: 'P1',
      kind: 'approval',
      // 查询反馈卡不是要人「批」，标题不带「待批红」；必问清单的票拟卡必须带。
      title: category === 'query' ? `【查询】${input.title || '查询答复'}` : `【待批红·${catLabel}】${input.title || '待批红事项'}`,
      body: this.renderCardText({ ...input, approval_id: id, category_label: catLabel, options }),
      ref: { approval_id: id, task_id: input.taskId || null, event_id: input.eventId || null },
      dedupeRef: `approval:${id}`,
      card: { approvalId: id, options },
      chatId: input.chatId || null,
    });
    this.ledger.run(`UPDATE approvals SET channel=? WHERE approval_id=?`, sent?.channel || 'local', id);
    this.log.info('已票拟待批红', { approval: id, category, channel: sent?.channel });
    return this.get(id);
  }

  renderCardText(a) {
    const isQuery = a.category === 'query';
    const lines = [
      `事项：${a.title}`,
      `分类：${a.category_label || EXTRA_CATEGORY_LABELS[a.category] || a.category || '未知'}`,
      '',
      a.question,
    ];
    // 方案可能引用 worker 的原话（带反引号、星号等排版记号），给人看之前先整理一遍
    if (a.proposal) lines.push('', `方案：\n${forHuman(a.proposal)}`);
    // 可选按钮跟随票拟单自己的 options：批红卡「批 / 驳 / 改派」，查询反馈卡「已阅 / 采纳 / 驳回 / 改派」
    const labels = (a.options || ['agree', 'reject', 'revise']).map((o) => OPTION_LABELS[o] || o);
    lines.push('', `可选：${labels.join(' / ')}${isQuery ? '' : '（改派请说明要求）'}`);
    // 批红入口写进卡片：手机上收到推送时能直接知道去哪儿操作。
    // 中台绑 127.0.0.1 时面板只在运行中台的那台机器上可达；绑局域网地址则同网手机可开。
    // 面板地址收进括号；CLI 命令是开发细节，不再写给人看（2026-11-17 汇报规范）。
    const { host, port } = this.config?.hub || {};
    const loopback = !host || host === '127.0.0.1' || host === 'localhost';
    const panelUrl = `http://${loopback ? '127.0.0.1' : host}:${port || 8787}`;
    lines.push(`操作入口：打开面板${isQuery ? '查询反馈' : '批红'}页（${panelUrl}）。`);
    lines.push(`编号：${a.approval_id}`, isQuery ? '已阅/驳回只做记录；采纳才会把建议派成任务。' : '超时不会默认同意，只会提醒一次。');
    return lines.join('\n');
  }

  /**
   * 「答复 + 批红」合成卡正文（2026-11-17 修「dev 双推」）。
   *
   * 飞书答复命中必问清单时，答复正文在上、批红信息在下，一张卡说完；
   * 之前是「票拟卡」+「答复文本」连发两道，同一段文字打扰人两次。
   * 按钮由 sendApprovalCard 按票拟单 options 追加（批 / 驳回 / 改派），
   * 卡片 note 自带编号，这里不重复。
   */
  renderReplyMergedText(a, answerText) {
    const { host, port } = this.config?.hub || {};
    const loopback = !host || host === '127.0.0.1' || host === 'localhost';
    const panelUrl = `http://${loopback ? '127.0.0.1' : host}:${port || 8787}`;
    const catLabel = a.meta?.category_label || EXTRA_CATEGORY_LABELS[a.category] || a.category || '事项';
    // 编号写进正文：纯文本降级（卡片发不出）时没有 note 元素，靠这行对得上票拟单
    return [
      String(answerText || '').trim() || '（无正文）',
      '',
      '──────────────',
      `⏳ 待批红：${a.question || `本答复涉及「${catLabel}」，相关动作已票拟，等待批红。`}`,
      `操作入口：打开面板批红页（${panelUrl}）。`,
      `编号：${a.approval_id}`,
      '超时不会默认同意，只会提醒一次。',
    ].join('\n');
  }

  get(id) {
    return parseApproval(this.ledger.get('SELECT * FROM approvals WHERE approval_id=?', id));
  }

  list({ status, limit = 50, offset = 0 } = {}) {
    const sql = status
      ? `SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM approvals ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const args = status ? [status, limit, offset] : [limit, offset];
    return this.ledger.all(sql, ...args).map(parseApproval);
  }

  pending() {
    return this.list({ status: APPROVAL_STATUS.PENDING, limit: 100 });
  }

  /**
   * 批红决策。decision: agree | reject | revise | ack（已阅） | adopt（采纳建议并执行）
   * 返回 {ok, approval, error}
   */
  async decide(approvalId, { decision, note, by = 'user', revisedProposal } = {}) {
    const a = this.get(approvalId);
    if (!a) return { ok: false, error: '审批单不存在' };
    const d = normalizeDecision(decision);
    if (!d) return { ok: false, error: `决策非法：${decision}（应为 agree/reject/revise/ack/adopt）` };
    const allowed = APPROVAL_TRANSITIONS[a.status] || [];
    const target = d === 'agree' || d === 'adopt'
      ? APPROVAL_STATUS.APPROVED
      : d === 'ack' ? APPROVAL_STATUS.EXECUTED
        : d === 'reject' ? APPROVAL_STATUS.REJECTED
          : APPROVAL_STATUS.REVISING;
    if (!allowed.includes(target)) {
      return { ok: false, error: `当前状态 ${a.status} 不接受该操作` };
    }
    const now = nowIso();
    const result = this.ledger.tx(() => {
      this.ledger.run(
        `UPDATE approvals SET status=?, decided_at=?, decided_by=?, decision_note=?, updated_at=?, proposal=COALESCE(?,proposal) WHERE approval_id=?`,
        target, now, by, note || null, now, revisedProposal || null, approvalId,
      );
      this.ledger.audit({
        entity: 'approval', entityId: approvalId, fromStatus: a.status, toStatus: target, actor: by,
        detail: { decision: d, note: note || null },
      });

      if (d === 'agree') {
        this.#recordDecision(a, 'decided', `已批红：${a.title}${a.proposal ? `（${a.proposal}）` : ''}`, by);
        if (a.task_id) {
          this.ledger.run(
            `UPDATE tasks SET status='queued', available_at=?, approval_id=? WHERE task_id=? AND status IN ('awaiting_approval','queued')`,
            now, approvalId, a.task_id,
          );
          this.ledger.audit({
            entity: 'task', entityId: a.task_id, fromStatus: 'awaiting_approval', toStatus: 'queued', actor: by,
            detail: { approved_by: by, approval: approvalId },
          });
          // 任务回到队列了，立刻唤醒挂在长轮询上的节点；不唤醒的话最多干等 50 秒。
          // onApproved 是同步的（只解析 waiter，不碰库），在事务回调里调用安全。
          this.onApproved();
        }
      }
      if (d === 'ack') {
        // 已阅：不需要任何操作，把问题记进决定记忆就完事
        this.#recordDecision(a, 'decided', `已阅（仅记录，无需操作）：${a.title}`, by);
      }
      if (d === 'adopt') {
        // 采纳：按建议执行。查询反馈卡没有挂任务（task_id 为空），执行由
        // Hub 注入的 onAdopt 钩子在事务提交后派新任务 —— 这里只记录决定。
        this.#recordDecision(a, 'decided', `已采纳，按建议执行：${a.title}`, by);
      }
      if (d === 'reject') {
        this.#recordDecision(a, 'refused', note || '（未填理由）', by);
        // 查询反馈的「驳回」= 不做任何操作，只记录；不把已答复完的查询事件打成 rejected
        const skipEvent = a.category === 'query';
        if (a.task_id) {
          this.ledger.run(`UPDATE tasks SET status='rejected', finished_at=?, error=? WHERE task_id=?`, now, '批红被驳', a.task_id);
          this.ledger.audit({ entity: 'task', entityId: a.task_id, fromStatus: 'awaiting_approval', toStatus: 'rejected', actor: by });
        }
        if (a.event_id && !skipEvent) {
          this.ledger.run(`UPDATE events SET status='rejected', updated_at=? WHERE event_id=?`, now, a.event_id);
        }
      }
      if (d === 'revise') {
        this.#recordDecision(a, 'decided', note || revisedProposal || '（改派）', by);
      }
      return { ok: true, approval: this.get(approvalId), decision: d };
    });
    // 采纳的后续派活在事务提交之后跑（要建任务、可能推通知，属于异步 IO）
    if (result.ok && d === 'adopt' && typeof this.onAdopt === 'function') {
      await this.onAdopt({ approval: result.approval, by, note: note || null });
    }
    return result;
  }

  /** 改派后重新票拟：版本号 +1，回到待批红 */
  async resubmit(approvalId, { proposal, question, by = 'system' } = {}) {
    const a = this.get(approvalId);
    if (!a) return { ok: false, error: '审批单不存在' };
    if (a.status !== APPROVAL_STATUS.REVISING && a.status !== APPROVAL_STATUS.REJECTED) {
      return { ok: false, error: `只有「调整中/已驳」状态可以重新票拟，当前 ${a.status}` };
    }
    if (a.revision >= this.config.approvals.maxRevisions) {
      return { ok: false, error: `超过最大改派次数 ${this.config.approvals.maxRevisions}` };
    }
    const now = nowIso();
    const revision = a.revision + 1;
    this.ledger.run(
      `UPDATE approvals SET status='pending', revision=?, proposal=COALESCE(?,proposal), question=COALESCE(?,question), updated_at=?, due_at=?, reminded_at=NULL WHERE approval_id=?`,
      revision, proposal || null, question || null, now, addSeconds(now, this.config.approvals.reminderHours * 3600), approvalId,
    );
    this.ledger.audit({
      entity: 'approval', entityId: approvalId, fromStatus: a.status, toStatus: APPROVAL_STATUS.PENDING, actor: by,
      detail: { revision, proposal: proposal || null },
    });
    await this.notifier.notify({
      level: 'P1',
      kind: 'approval',
      title: `【重新票拟·第${revision}版】${a.title}`,
      body: this.renderCardText({ ...a, proposal: proposal || a.proposal, question: question || a.question }),
      ref: { approval_id: approvalId },
      card: { approvalId, options: a.options?.length ? a.options : ['agree', 'reject', 'revise'] },
    });
    return { ok: true, approval: this.get(approvalId) };
  }

  #recordDecision(a, kind, text, by) {
    const id = newNotificationId();
    this.ledger.run(
      `INSERT INTO decisions(decision_id,kind,text,quote,decided_by,decided_at,source_approval,source_task,tags,active)
       VALUES(?,?,?,?,?,?,?,?,?,1)`,
      id, kind, text, text, by, nowIso(), a.approval_id, a.task_id || null,
      JSON.stringify([a.category]),
    );
    this.log.info('已写入决定记忆', { decision: id, kind, approval: a.approval_id });
  }

  /**
   * 超时巡检：只提醒一次，绝不默认同意。
   *
   * 公开给测试/CLI 是为了能立刻验证这条规矩。等 60 秒的定时器、再等 24 小时才
   * 到期，是不可能在测试里覆盖的 —— 而「绝不默认同意」恰恰是不能靠肉眼确认的那类行为。
   */
  async checkDue() {
    return this.#checkDue();
  }

  /** 超时巡检：只提醒一次，绝不默认同意 */
  async #checkDue() {
    const now = nowIso();
    const due = this.ledger.all(
      `SELECT * FROM approvals WHERE status='pending' AND due_at IS NOT NULL AND due_at <= ? AND reminded_at IS NULL`,
      now,
    );
    for (const row of due) {
      this.ledger.run(`UPDATE approvals SET reminded_at=? WHERE approval_id=?`, now, row.approval_id);
      const hours = Math.round((Date.now() - new Date(row.created_at).getTime()) / 3600000);
      await this.notifier.notify({
        level: 'P1',
        kind: 'approval_reminder',
        title: `【提醒】仍有待批红事项已 ${hours} 小时`,
        body: `事项：${row.title}\n编号：${row.approval_id}\n\n按规矩不会默认同意，也不会自动放行。要么批，要么驳，要么改派。`,
        ref: { approval_id: row.approval_id },
      });
      this.ledger.audit({
        entity: 'approval', entityId: row.approval_id, actor: 'm5',
        detail: { reminder: true, hours },
      });
      this.log.warn('审批超时，已升级提醒一次', { approval: row.approval_id, hours });
    }
  }

  /** 面板首页数据 */
  async stats() {
    const pending = this.pending();
    return {
      pending: pending.length,
      oldest: pending.length ? pending[pending.length - 1].created_at : null,
      items: pending,
    };
  }
}

function normalizeDecision(d) {
  const v = String(d || '').toLowerCase();
  if (['agree', 'approve', 'approved', 'ok', '同意', '批'].includes(v)) return 'agree';
  // 已阅/采纳：查询反馈卡的专属动作（2026-11-17 分类口径）
  if (['ack', 'read', 'acknowledged', '已阅'].includes(v)) return 'ack';
  if (['adopt', 'accepted', '采纳'].includes(v)) return 'adopt';
  if (['reject', 'rejected', 'deny', 'no', '拒绝', '驳', '驳回'].includes(v)) return 'reject';
  if (['revise', 'rework', 'reassign', '改派', '调整'].includes(v)) return 'revise';
  return null;
}

/* ────────────────────────── 通知出口 ────────────────────────── */

/**
 * 通知分层（方案 §7.4）：
 *  P0 即时强提醒 / P1 即时普通 / P2 每日战报聚合 / P3 报告卡片折叠。
 * 唯一出口是飞书；未配置时写本地队列 + 控制台，绝不丢件。
 */
export class Notifier {
  constructor({ ledger, log, config }) {
    this.ledger = ledger;
    this.log = log;
    this.config = config;
    this.feishu = null;
    this.dailyQueue = [];
  }

  setFeishuClient(client) {
    this.feishu = client;
  }

  /**
   * 发通知。P2 不即时推（入每日战报队列），P3 归档进报告。
   *
   * dedupeRef：同一个 dedupeRef 只推一次。没有它，任务重试、事件重投、
   * 巡检每轮都喊一遍，人会很快学会无视这些提醒 —— 那比不发更糟。
   */
  async notify({ level = 'P2', kind = 'info', title = '', body = '', ref = null, dedupeRef = null, card = null, chatId = null }) {
    const lvl = String(level).toUpperCase();
    const id = newNotificationId();
    const now = nowIso();
    // 传了 chatId 说明这是在「回复某个人的提问」，不是系统主动通知人。
    // 主动性通知才该分层（P2 攒到战报、P3 只归档）；回复必须立刻回到提问的会话，
    // 否则人问了话、看见「任务完成」，然后永远等不到答案。
    const isReply = Boolean(chatId);

    if (dedupeRef) {
      const seen = this.ledger.get(
        'SELECT notification_id FROM notifications WHERE meta=? LIMIT 1',
        JSON.stringify({ dedupe_ref: dedupeRef }),
      );
      if (seen) {
        this.log.debug('通知已推过，按 dedupeRef 跳过', { dedupeRef });
        return { ok: true, channel: 'deduped', id: seen.notification_id };
      }
    }
    const metaCol = dedupeRef ? JSON.stringify({ dedupe_ref: dedupeRef }) : null;

    if (lvl === 'P2' && !isReply) {
      this.dailyQueue.push({ id, title, body, ref, at: now });
      this.ledger.run(
        `INSERT INTO notifications(notification_id,level,kind,title,body,target,channel,status,created_at,ref,meta)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id, lvl, kind, title, body, null, 'digest', 'queued', now, ref ? JSON.stringify(ref) : null, metaCol,
      );
      this.log.debug('P2 通知进入每日战报队列', { id, title });
      return { ok: true, channel: 'digest', id };
    }

    if (lvl === 'P3' && !isReply) {
      this.ledger.run(
        `INSERT INTO notifications(notification_id,level,kind,title,body,target,channel,status,created_at,sent_at,ref,meta)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, lvl, kind, title, body, null, 'archive', 'archived', now, now, ref ? JSON.stringify(ref) : null, metaCol,
      );
      return { ok: true, channel: 'archive', id };
    }

    // P0/P1 即时推送
    this.ledger.run(
      `INSERT INTO notifications(notification_id,level,kind,title,body,target,channel,status,created_at,ref,meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, lvl, kind, title, body, null, null, 'pending', now, ref ? JSON.stringify(ref) : null, metaCol,
    );
    let channel = 'local';
    let error = null;
    if (this.feishu?.enabled) {
      try {
        // 批红卡走交互卡片（带「批 / 驳 / 改派」按钮），其余走文本。
        // 按钮的 value 结构 {action:'approval:<o>', approval_id} 与 /webhook/feishu
        // 的卡片动作分支一一对应；任何一步失败都降级成文本，不让票拟丢入口。
        if (card?.approvalId && kind === 'approval') {
          await this.feishu.sendApprovalCard({
            title,
            body,
            approvalId: card.approvalId,
            options: card.options || ['agree', 'reject', 'revise'],
            chatId: chatId || undefined,
          });
        } else {
          await this.feishu.sendMessage({ title, body, level: lvl, chatId: chatId || undefined });
        }
        channel = 'feishu';
      } catch (err) {
        error = err.message;
        channel = 'local';
        this.log.error('飞书推送失败，降级到本地队列', { error: err.message });
        // 卡片失败再补一条文本，保证批红入口至少有一条能到
        if (card?.approvalId) {
          try {
            await this.feishu.sendMessage({ title, body, level: lvl, chatId: chatId || undefined });
            error = `${err.message}（已降级为文本推送）`;
          } catch { /* 降级也失败就只留错误 */ }
        }
      }
    }
    this.ledger.run(
      `UPDATE notifications SET channel=?, status=?, sent_at=?, error=? WHERE notification_id=?`,
      channel, error ? 'degraded' : 'sent', nowIso(), error, id,
    );
    if (channel === 'local') {
      const marker = lvl === 'P0' ? '🔴 P0' : '🟡 P1';
      console.log(`\n${marker} ${title}\n${body}\n（本地兜底通道，配置飞书后自动改走飞书）\n`);
    }
    return { ok: true, channel, id, error };
  }

  /**
   * 取走并清空每日聚合队列。
   *
   * 队列有两份：内存里的 dailyQueue（本进程发起的 P2），和台账里
   * status='queued' 的 digest 通知（跨重启、跨进程都在）。只读内存那份的话，
   * 中台重启一次，夜里攒的 P2 就凭空消失了 —— 所以这里合并两个来源。
   */
  drainDigest() {
    const fromMemory = this.dailyQueue.splice(0, this.dailyQueue.length);
    const seen = new Set(fromMemory.map((i) => i.id));
    const rows = this.ledger.all(
      `SELECT * FROM notifications WHERE channel='digest' AND status='queued' ORDER BY created_at ASC`,
    );
    for (const r of rows) {
      if (seen.has(r.notification_id)) continue;
      seen.add(r.notification_id);
      fromMemory.push({ id: r.notification_id, title: r.title, body: r.body, ref: r.ref, at: r.created_at, level: r.level });
    }
    return fromMemory;
  }

  /** 把队列里的 P2 标记成已随战报发出（否则下次会被重复带上） */
  markDigestSent(ids) {
    if (!ids?.length) return 0;
    const now = nowIso();
    let n = 0;
    for (const id of ids) {
      this.ledger.run(
        `UPDATE notifications SET status='sent', channel='digest', sent_at=? WHERE notification_id=? AND status='queued'`,
        now, id,
      );
      n += 1;
    }
    return n;
  }

  async flushDigestFooter(extraText) {
    return this.notify({ level: 'P1', kind: 'digest', title: '每日战报', body: extraText, ref: null });
  }

  listRecent(limit = 30) {
    return this.ledger.all(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`, limit);
  }
}

/* ────────────────────────── 必问清单关键词匹配 ────────────────────────── */

/** 关键词同义扩展：写进配置的少量词，自动覆盖口语常见说法 */
const KEYWORD_SYNONYMS = {
  删数据: ['删除', '删掉', '删了', '清空', '清掉', '移除数据'],
  删除数据: ['删除', '删掉', '删表', '清空'],
  清空数据库: ['清空', '清库'],
  停服: ['停掉', '停用', '暂停服务', '关停', '停服'],
  停止服务: ['停掉服务', '关停', '停用服务'],
  花钱: ['付费', '收费', '开支', '成本', '购买'],
  // 同义词必须是「动作短语」。曾经写成 ['对外', ...]，结果模型复述规则时写的
  // 「未向飞书发送消息；对外发送需要批红」被「对外」两字命中，每答一句推一张批红卡。
  对外发消息: ['对外发', '对外发送', '对外通知', '对外公布', '对外发布', '发给外部', '群发', '发出去'],
  改产品方向: ['产品方向', '改方向', '转型', '砍掉'],
  轮换密钥: ['轮换密钥', '新建密钥', '重置密钥', '密钥轮换', 'apikey', 'api key', 'token 轮换', '改密码'],
  // 注意：这里的同义词必须是「动作短语」，不能只写名词。
  // 曾经写成 ['权限','授权','提权']，结果原文里「权限受限」「权限类」「被标记为权限类」
  // 全都命中 —— 只是提到「权限」两个字，并不代表要改权限。
  修改权限: ['改权限', '修改权限', '变更权限', '授予权限', '赋予权限', '调整权限', '提权', 'chmod'],
};

/**
 * 关键词→分类的语义补充（口语很难穷举，按意图兜一层）。
 * 中文会在动词和名词之间插入修饰语（"清理三个月前的测试数据"），
 * 所以一律写成 `动词[^。；\n]{0,N}名词`，而不是要求紧紧相邻。
 */
const GAP = '[^。；;！!？?\\n]{0,14}';
const SEMANTIC_RULES = [
  {
    id: 'delete_data',
    patterns: [
      new RegExp(`(删除|删掉|删了|清空|清理|移除|抹掉|drop|truncate|delete)${GAP}(表|数据|库|记录|文件|目录|行|索引)`, 'i'),
      /rm\s+-rf/i,
    ],
  },
  {
    id: 'stop_service',
    patterns: [
      new RegExp(`(停掉|停止|停用|关掉|关闭|下线|暂停|杀死|kill|stop|shutdown)${GAP}(服务|进程|容器|实例|节点|服务器|集群)`, 'i'),
      /\bsystemctl\s+stop\b/i,
      /\bdocker\s+(stop|rm)\b/i,
    ],
  },
  {
    id: 'spend_money',
    // 动词里收的都是「真花钱」的动作（2026-11-17 口径：讨论/询价/采购不算，
    // 由 moneyTalkExempt 豁免层再兜一道）；续费/下单/扣费这类支付动作要认得出。
    patterns: [new RegExp(`(付钱|付费|充值|购买|订购|订阅|升级套餐|升配|买单|续费|下单|扣费)${GAP}(元|块|美元|刀|套餐|服务|会员)?`, 'i'), /\$\d+/, /预算是?\s*\d+/i],
  },
  {
    id: 'outbound_message',
    patterns: [
      // 语序一：先动词后对象（"给客户发通知" 会把动词放在前面时命中）
      new RegExp(`(发送|推送|发布|群发|通知|发给|寄给|抄送|回复)${GAP}(客户|用户|群|所有人|全员|外部|公众号|微博|推特|twitter|x\\s*上|甲方|对方)`, 'i'),
      // 语序二：先对象后动词（"给所有用户发通知"）—— 中文两种语序都常见，必须都覆盖
      new RegExp(`(客户|用户|群|所有人|全员|外部|公众|甲方|对方|收件人)${GAP}(发|推送|通知|群发|公布|公告)`, 'i'),
      new RegExp(`(对外|公开发|外面)${GAP}(发|说|宣布|公布)`, 'i'),
    ],
  },
  {
    id: 'product_direction',
    patterns: [new RegExp(`(产品方向|产品定位|商业模式|改成订阅|砍掉|下线功能|战略|定位)`, 'i')],
  },
  {
    id: 'secret_rotate',
    patterns: [
      new RegExp(`(轮换|重置|新建|生成|更换|换掉|作废)${GAP}(密钥|token|api\\s*key|密码|凭据|secret|证书)`, 'i'),
      /\.env\b/i,
      /(私钥|ssh\s*key)/i,
    ],
  },
  {
    id: 'permissions',
    patterns: [
      new RegExp(`(修改|调整|变更|提升|收回|授予|放开)${GAP}(权限|角色|角色组|acl|iam|访问控制)`, 'i'),
      /\bchmod\b/i,
      /\bchown\b/i,
      /(提权|超管|root\s*权限)/i,
    ],
  },
];

/**
 * 否定前缀：「未修改权限」「没有删数据」「不打算停服」都不是要做这件事。
 *
 * 这是必问清单最怕的误判类型 —— 把「提到某个词」当成「要做某件事」。
 * 实测踩到过：一份日报写「本次未修改权限」「被策略拒绝」，被判成「修改权限」
 * 推到人面前要批红，白名单就失去了意义（人会被无关卡片淹没）。
 *
 * 判据：关键词左侧 8 个字符内出现否定词，就算否定。
 */
const NEGATIONS = ['未', '没', '没有', '不', '不会', '不得', '无需', '无需', '勿', '别', '禁止', '避免', '暂不', '尚未', '并非'];

/**
 * 元话语标记：这些词后面紧跟的内容是「在讨论这个词」，不是「要做这件事」。
 *
 * 实测踩到：战报正文里写「1项：README任务标记『花钱』，正文实际请求写权限」——
 * 模型在复述分类名，系统却判成「任务涉及花钱」推到人面前要批红。
 * 同类还有「分类：删数据」「被归为停服」「例如：轮换密钥」。
 */
const MENTION_MARKERS = ['标记', '分类', '归类', '归为', '例如', '比如', '所谓', '名为', '叫做', '称为', '标签', '原因是', '理由', '关键词'];

/**
 * 判断一次命中是「在做」还是「在说」。
 *
 * 两种都算「在说」（即不计入必问清单）：
 *  1) 左侧有否定词 ——「未删除任何数据」。
 *  2) 左侧有元话语标记，或命中处被引号/括号包住 ——「标记『花钱』」。
 */
function negatedBefore(hay, index) {
  // 取关键词左侧一段上下文（中文没有词边界，靠窗口判断）
  const from = Math.max(0, index - 8);
  const ctx = hay.slice(from, index);
  if (NEGATIONS.some((n) => ctx.includes(n))) return true;
  // 元话语：往前看更远一点，够得着「标记」「分类：」这类前缀
  const wider = hay.slice(Math.max(0, index - 14), index);
  if (MENTION_MARKERS.some((m) => wider.includes(m))) return true;
  // 被引号/括号包住：『花钱』「停服」(删数据)
  // 注意 hay[index-1] 在 index===0 时是 undefined（取到空串），
  // 而 '任何字符串'.includes('') 恒为 true —— 会让句首的关键词全部漏判。必须先判非空。
  const prev = index > 0 ? hay[index - 1] : '';
  if (prev && '『「「\'"（(【['.includes(prev)) return true;
  return false;
}

/**
 * 「动词只是名词的定语」判据 —— 判断一个命中是「要做某事」还是「在说某个事物」。
 *
 * 实测误判：飞书回复里写「端到端结果需查看飞书发送回执或群内实际消息」，
 * 被 outbound_message 的「(发送|…){0,14}(客户|用户|群|…)」命中成「发送回执或群」，
 * 于是又推了一张「对外发消息」的批红卡 —— 而这句话只是在说「去看回执」。
 *
 * 第一版判据只看命中之后紧邻的那一个字（方位词表），结果把真动作也放过了：
 * 「通知客户的负责人」「通知客户等三个部门」「发送报告给客户」全被判成不是动作。
 * 白名单漏判比多推一张卡严重得多，所以判据必须收得很窄、只认一种形态：
 *
 *   动词 + 内容名词      且   名词后面没有投递目标
 *
 * 「发送回执」        → 回执后什么都没剩/跟的是并列 → 名词短语，不是动作
 * 「发送回执给客户」  → 名词后跟「给」= 有投递目标     → 是动作
 * 「发送报告给客户」  → 同上，是动作（第一版在这里漏了）
 * 「通知客户的负责人」→ 「客户」不是内容名词          → 是动作（第一版在这里漏了）
 */
const ACTION_VERB_HEADS = ['发送', '推送', '通知', '回复', '群发', '公布', '公告', '宣布', '发', '说'];
const CONTENT_NOUNS = ['回执', '记录', '日志', '结果', '状态', '历史', '列表', '详情', '报告', '内容', '截图', '清单'];
/** 投递目标标记：出现这些字说明名词只是宾语，后面才是「发给谁」——那是真动作 */
const TARGET_MARKERS = ['给', '到', '向', '至', '于', '为', '往', '跟'];

/**
 * 政策陈述标记：命中之后紧跟着这些说法，是在描述「这件事要走审批」，
 * 不是在请求执行这件事。
 *
 * 实测：一条回复写「未向飞书发送消息；对外发送需要批红。」——
 * 模型在复述白名单规则，系统却把「对外发」判成要做「对外发消息」，又推一张批红卡。
 * 同一个模型每次回答都会复述这条规则，不拦住就每问一句推一张卡。
 */
const POLICY_MARKERS = ['需要批红', '需批红', '要批红', '待批红', '需要审批', '需审批', '需要批准', '需批准', '必须批红', '需人工'];

/** 真正的请求语气：出现这些说法时，即使讲了「需要批红」也是在请求执行，必须留卡 */
const REQUEST_MARKERS = ['请批准', '请批', '是否准予', '同意执行', '申请批准', '请审批', '盼批准', '准予'];

function notAnAction(hay, index, text) {
  const t = String(text || '');
  // 判据一：命中后面紧跟「需要批红」这类说法 —— 在陈述规则，不是请求执行。
  // 模型每次回答都会复述「对外发送需要批红」这条铁律，不拦住就每问一句推一张卡。
  // 但如果同一句里还有请求语气（「请批准」「是否准予」），那是真的在申请人批，
  // 必须留卡 —— 漏一张该批的卡比多推一张严重。
  const trailing = hay.slice(index + t.length, index + t.length + 14);
  if (POLICY_MARKERS.some((m) => trailing.includes(m))) {
    const stop = hay.indexOf('。', index);
    const sentence = hay.slice(index, stop === -1 ? hay.length : stop + 1);
    if (!REQUEST_MARKERS.some((m) => sentence.includes(m))) return true;
  }
  // 判据二：动词 + 内容名词，且名词后面没有投递目标 —— 名词短语
  const verb = ACTION_VERB_HEADS.find((v) => t.startsWith(v) && t.length > v.length);
  if (!verb) return false;
  const rest = t.slice(verb.length);
  const noun = CONTENT_NOUNS.find((n) => rest.startsWith(n));
  if (!noun) return false;
  const after = rest.slice(noun.length);
  // 名词后面还有投递目标 → 这是真动作，不能放过
  if (TARGET_MARKERS.some((m) => after.includes(m))) return false;
  // 名词后面空了，只剩并列/标点 → 「发送回执」「推送记录或日志」这类名词短语
  return true;
}

/* ────────────────────────── 分类口径豁免（2026-11-17 老板定） ──────────────────────────
 *
 * 两类「看着像、其实不算」的必问事项：
 *  1) 删除豁免：过程/tmp 文件的清理不算「删数据」——把它们移进 tmp/ 目录留存、
 *     在 docs/删除记录.md 登记原路径即可回滚，不该为这推批红卡打断人。
 *  2) 花钱豁免：讨论花钱、采购询价不算「花钱」——目前没有支付渠道，
 *     只有真支付动作（支付/付款/充值/续费/下单）才需要人批。
 *
 * 两条豁免都是窄口径，宁可漏豁免不可错豁免：
 *  命中句里同时出现受保护对象（数据库/代码/配置…）或真支付动作，照样必批。
 */

/** tmp/过程文件标记：删除命中附近出现这些，才进入豁免判断 */
const TMP_DELETE_MARKERS = ['临时文件', '临时目录', '临时数据', '临时产物', '过程文件', '过程数据', '中间产物', '中间文件', '缓存文件', '缓存目录', '缓存数据', '构建产物', '编译产物', '下载缓存', 'tmp', 'temp', 'cache', 'dist', 'build', 'node_modules', '.bak'];
/** 受保护对象：同句里出现这些，豁免作废（拿不准的一律保留 → 仍走批红） */
const PROTECTED_DELETE_MARKERS = ['数据库', '数据表', '生产数据', '用户数据', '业务数据', '配置', '代码', '源码', '密钥', '凭证', '分支', '文档', '表', '记录'];
/** 花钱讨论标记：同句里出现这些算「在谈钱」而不是「要花钱」 */
const MONEY_TALK_WORDS = ['讨论', '评估', '调研', '咨询', '了解', '询价', '报价', '比价', '对比', '采购', '预算', '估价', '成本', '开支', '收费', '订阅费', '多少钱', '价格', '费用'];
/** 真支付动作：讨论句里出现这些，豁免作废（「讨论一下要不要给账户充值」仍要批） */
const MONEY_ACTION_WORDS = ['支付', '付款', '充值', '扣费', '下单', '续费', '付费', '买单'];

/** 取命中所在的句子（按换行/句号/分号切） */
function sentenceAround(hay, index) {
  const start = Math.max(
    hay.lastIndexOf('\n', index),
    hay.lastIndexOf('。', index),
    hay.lastIndexOf('；', index),
    hay.lastIndexOf(';', index),
  );
  let end = hay.length;
  for (const ch of ['\n', '。', '；', ';']) {
    const at = hay.indexOf(ch, index);
    if (at >= 0) end = Math.min(end, at);
  }
  return hay.slice(start + 1, end);
}

/** 删除豁免：命中的是「清理过程/tmp 文件」，且句子里没有受保护对象 */
function tmpDeleteExempt(hay, index, text) {
  // 对象通常紧跟动词后面，取命中往后的短窗口找 tmp 标记
  const window = hay.slice(index, index + text.length + 6).toLowerCase();
  if (!TMP_DELETE_MARKERS.some((m) => window.includes(m))) return false;
  const sentence = sentenceAround(hay, index).toLowerCase();
  return !PROTECTED_DELETE_MARKERS.some((m) => sentence.includes(m));
}

/** 花钱豁免：句子在讨论/询价/采购，且没有真支付动作 */
function moneyTalkExempt(hay, index, text) {
  const sentence = sentenceAround(hay, index).toLowerCase();
  if (!MONEY_TALK_WORDS.some((m) => sentence.includes(m))) return false;
  return !MONEY_ACTION_WORDS.some((m) => sentence.includes(m));
}

/** 分类豁免入口：在「在做/在说」之后再判一层「这类命中算不算事项」 */
function exemptHit(categoryId, hay, index, text) {
  if (categoryId === 'delete_data') return tmpDeleteExempt(hay, index, text);
  if (categoryId === 'spend_money') return moneyTalkExempt(hay, index, text);
  return false;
}

/** 单个关键词匹配：支持英文边界，中文按包含。categoryId 用于分类口径豁免 */
function matchKeyword(hay, keyword, categoryId = null) {
  const k = String(keyword || '').toLowerCase().trim();
  if (!k) return false;
  const words = [k, ...(KEYWORD_SYNONYMS[k] || [])];
  for (const w of words) {
    const needle = String(w).toLowerCase();
    if (!needle) continue;
    if (/^[a-z0-9 ._-]+$/.test(needle)) {
      // 英文/符号类：按词边界，避免 "token" 命中 "tokenizer" 这类误伤
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, 'ig');
      let m;
      while ((m = re.exec(hay)) !== null) {
        // m.index 指向分隔符，关键词真正起点要加上它
        const at = m.index + (m[1] ? m[1].length : 0);
        if (!negatedBefore(hay, at) && !exemptHit(categoryId, hay, at, needle)) return true;
      }
    } else {
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        // 关键词通道同样要排除「在描述/在复述规则」：模型答一句「对外发送需要批红」
        // 里没有动作，但它包含关键词「对外发送」——不拦就会每答一次推一张卡。
        if (!negatedBefore(hay, at) && !notAnAction(hay, at, hay.slice(at, at + needle.length)) && !exemptHit(categoryId, hay, at, needle)) return true;
        from = at + needle.length;
      }
    }
  }
  return false;
}

/** 语义兜底：命中任一意图正则，就算命中该类（同样要排除否定语境与口径豁免） */
function semanticHit(categoryId, hay) {
  const rule = SEMANTIC_RULES.find((r) => r.id === categoryId);
  if (!rule) return false;
  for (const re of rule.patterns) {
    // 用全局副本逐个匹配，才能拿到命中位置做否定判断；
    // 原来 .some(re.test) 只看「有没有命中」，于是「未删除任何数据」也算命中。
    const gre = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = gre.exec(hay)) !== null) {
      if (!negatedBefore(hay, m.index) && !notAnAction(hay, m.index, m[0]) && !exemptHit(categoryId, hay, m.index, m[0])) return true;
      if (m.index === gre.lastIndex) gre.lastIndex += 1; // 防空匹配死循环
    }
  }
  return false;
}

/** 必问分类之外的自建票拟分类（查询反馈这类）在人面前显示的名字 */
const EXTRA_CATEGORY_LABELS = { query: '查询', manual: '手动事项' };

/** 反馈按钮标签：批红卡与查询反馈卡共用一套（飞书卡片与面板都从这里取） */
export const OPTION_LABELS = {
  agree: '批',
  adopt: '采纳',
  ack: '已阅',
  reject: '驳回',
  revise: '改派',
};

/** 按钮风格：同意/采纳=主按钮，驳回=红，其余默认 */
export function optionButtonStyle(o) {
  if (o === 'agree' || o === 'adopt') return 'primary';
  if (o === 'reject') return 'danger';
  return 'default';
}

export { APPROVAL_TRANSITIONS, matchKeyword, notAnAction, SEMANTIC_RULES };