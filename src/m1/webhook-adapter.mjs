import { makeEnvelope } from '../lib/envelope.mjs';

/**
 * M1-③：外部 Webhook 适配器（GitHub / 监控系统）。
 * 只做一件事：把各家事件翻译成统一信封，然后交给 M2。
 */
export class WebhookAdapter {
  constructor({ config, events, log }) {
    this.config = config;
    this.events = events;
    this.log = log;
  }

  /** GitHub webhook → 信封 */
  github(headers, body) {
    const event = String(headers['x-github-event'] || 'unknown');
    const delivery = headers['x-github-delivery'] || '';
    const repo = body?.repository?.full_name || body?.repository?.name || null;

    const allowed = this.config.github.allowedRepos || [];
    if (!repo || !allowed.includes(repo)) {
      throw Object.assign(new Error(`仓库 ${repo} 不在 allowlist 内`), { code: 'REPO_NOT_ALLOWED' });
    }

    // GitHub 创建 webhook 后会发送 ping。它只用于确认 hook 可达，
    // 不应被当成业务事件入账或路由。
    if (event === 'ping') return null;

    if (event === 'issues' && body?.action === 'opened') {
      const issue = body.issue || {};
      return makeEnvelope({
        source: 'github',
        type: 'github.issue',
        target: repo,
        summary: `#${issue.number} ${issue.title || ''}`.trim(),
        link: issue.html_url || null,
        dedupe_key: `github.issue#${repo}#${issue.number}`,
        priority: 'P2',
        payload: {
          action: body.action,
          repo,
          issue_number: issue.number,
          issue_title: issue.title,
          issue_body: truncate(issue.body, 4000),
          author: issue.user?.login || null,
          labels: (issue.labels || []).map((l) => l.name || l),
          delivery,
        },
      });
    }

    if (event === 'pull_request') {
      const pr = body.pull_request || {};
      const decisive = ['opened', 'reopened', 'synchronize', 'closed'];
      if (!decisive.includes(body.action)) {
        throw Object.assign(new Error(`忽略的 PR action：${body.action}`), { code: 'IGNORED' });
      }
      return makeEnvelope({
        source: 'github',
        type: 'github.pull_request',
        target: repo,
        summary: `PR #${pr.number} ${body.action} ${pr.title || ''}`.trim(),
        link: pr.html_url || null,
        dedupe_key: `github.pr#${repo}#${pr.number}#${body.action}`,
        priority: 'P2',
        payload: {
          action: body.action,
          repo,
          pr_number: pr.number,
          pr_title: pr.title,
          pr_body: truncate(pr.body, 4000),
          pr_url: pr.html_url,
          head_ref: pr.head?.ref,
          base_ref: pr.base?.ref,
          merged: pr.merged,
          delivery,
        },
      });
    }

    if (event === 'check_suite' || event === 'workflow_run') {
      const ok = (body.check_suite || body.workflow_run || {}).conclusion;
      if (ok !== 'failure' && ok !== 'timed_out') {
        throw Object.assign(new Error(`忽略的非失败事件：${ok}`), { code: 'IGNORED' });
      }
      return makeEnvelope({
        source: 'github',
        type: 'release.failed',
        target: repo,
        summary: `CI 失败：${repo}`,
        link: (body.check_suite || body.workflow_run || {}).html_url || null,
        dedupe_key: `release.failed#${repo}`,
        priority: 'P0',
        payload: { repo, conclusion: ok, delivery },
      });
    }

    throw Object.assign(new Error(`未处理的 GitHub 事件：${event}`), { code: 'UNHANDLED' });
  }

  /** 通用监控 webhook：{level, title, message, key, ...} */
  generic(body) {
    const level = String(body.level || body.priority || 'P1').toUpperCase();
    return makeEnvelope({
      source: 'monitor',
      type: body.type || 'monitor.alert',
      target: body.target || body.host || null,
      summary: body.title || body.summary || '监控告警',
      link: body.link || null,
      dedupe_key: body.key || body.dedupe_key || `monitor.alert#${body.title || 'unknown'}`,
      priority: ['P0', 'P1', 'P2', 'P3'].includes(level) ? level : 'P1',
      payload: { message: truncate(body.message, 4000), ...(body.payload || {}) },
    });
  }

  /** 手动/面板提交 → 信封 */
  manual(body) {
    return makeEnvelope({
      source: body.source || 'web',
      type: body.type || 'cmd.manual',
      target: body.target || null,
      summary: body.summary || body.title || null,
      link: body.link || null,
      dedupe_key: body.dedupe_key || `cmd.manual#${body.target || ''}#${Date.now()}`,
      priority: body.priority || 'P2',
      payload: body.payload || {},
    });
  }

  /** 飞书消息/卡片回调 → 信封 */
  feishu(body) {
    const msg = body.event?.message || {};
    const text = extractFeishuText(msg);
    const openId = body.event?.sender?.sender_id?.open_id
      || body.event?.operator?.operator_id?.open_id
      || body.operator?.open_id
      || null;
    // 卡片动作两种 schema：
    //   v1（卡片回调旧版）：body.action = { value: {...}, operator: {...} }
    //   v2（schema:"2.0"）： body.event.action = { value: {...} }，操作人在 event.operator
    // 只认 body.action 的话，v2 的按钮点击会掉进消息分支然后被 EMPTY_TEXT 拒掉。
    const action = body.action || body.event?.action || null;
    // 走 makeEnvelope 而不是手搓对象：created_at / link 这些字段必须由统一
    // 契约补齐。虽然 EventService.ingest() 会再 makeEnvelope 一次，但适配器
    // 的输出也可能被别处直接用（cli、测试、将来的入口），缺字段就是隐患。
    if (action?.value?.action) {
      return makeEnvelope({
        source: 'feishu',
        type: 'feishu.card_action',
        target: action.value.approval_id || null,
        summary: `卡片动作 ${action.value.action}`,
        dedupe_key: `feishu.card#${action.value.approval_id}#${action.value.action}#${body.event?.event_id || body.header?.event_id || Date.now()}`,
        priority: 'P1',
        payload: { action: action.value.action, value: action.value, operator: openId, raw: body },
      });
    }
    if (!text) throw Object.assign(new Error('飞书回调缺少可用文本'), { code: 'EMPTY_TEXT' });
    // 「发任务」约定：dev: 开头 = 开发类任务（走 repo-dev，止步 PR），其余 = 查询/操作类。
    const trimmed = stripMentions(text);
    if (!trimmed) throw Object.assign(new Error('飞书回调只有 @ 没有正文'), { code: 'EMPTY_TEXT' });
    const isDev = /^dev[:：]/i.test(trimmed);
    const devText = isDev ? trimmed.replace(/^dev[:：]\s*/i, '') : trimmed;
    return makeEnvelope({
      source: 'feishu',
      type: 'feishu.message',
      target: openId,
      summary: truncate(devText, 200),
      dedupe_key: `feishu.msg#${msg.message_id || body.event?.event_id || body.header?.event_id || Date.now()}`,
      priority: 'P1',
      payload: {
        text: truncate(devText, 4000),
        dev: isDev,
        operator: openId,
        chat_id: msg.chat_id || null,
        raw: body,
      },
    });
  }
}

/**
 * 飞书把 @某人 在纯文本里替换成 `@_user_1` 这样的占位符（@所有人 是 `@_all`）。
 * 群聊里必须 @ 机器人才收得到消息，于是每条指令都会带着这个占位符进来：
 * 既污染模型收到的指令，也污染台账标题（「@_user_1 现在工作状态报告」）。
 */
function stripMentions(text) {
  return String(text || '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/@_all\b/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractFeishuText(msg) {
  if (!msg?.content) return '';
  try {
    const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
    if (typeof content.text === 'string') return content.text;
    if (Array.isArray(content.content)) {
      return content.content.map((line) => (Array.isArray(line) ? line.map((c) => c.text || '').join('') : line.text || '')).join('\n');
    }
    if (content.title) return content.title;
  } catch {
    return typeof msg.content === 'string' ? msg.content : '';
  }
  return '';
}

function truncate(s, n) {
  const v = String(s || '');
  return v.length > n ? v.slice(0, n) + '…' : v;
}
