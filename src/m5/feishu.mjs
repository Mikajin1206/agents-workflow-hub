import crypto from 'node:crypto';

/**
 * 飞书开放平台最小客户端（零依赖，只用内置 fetch）。
 * 两件事：拿 tenant_access_token、发消息给指定 chat。
 * 未配置时 enabled=false，上层自动降级到本地通道。
 */
export class FeishuClient {
  constructor(cfg, log) {
    this.cfg = cfg || {};
    this.log = log;
    this.base = this.cfg.baseUrl || 'https://open.feishu.cn';
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return Boolean(this.cfg.enabled && this.cfg.appId && this.cfg.appSecret);
  }

  async #getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const res = await fetch(`${this.base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0) {
      throw new Error(`飞书取 token 失败：${data.code} ${data.msg || res.status}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
    return this.token;
  }

  /** 发普通文本消息（也用于卡片降级） */
  async sendMessage({ title, body, level = 'P2', chatId }) {
    const target = chatId || this.cfg.chatId;
    if (!target) throw new Error('未配置飞书 chatId');
    const token = await this.#getToken();
    const text = title ? `${title}\n\n${body}` : body;
    const res = await fetch(`${this.base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: target,
        msg_type: 'post',
        content: JSON.stringify(richPost({ title, body, level })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0) {
      throw new Error(`飞书发消息失败：${data.code} ${data.msg || res.status}`);
    }
    return { ok: true, messageId: data.data?.message_id };
  }

  /** 发交互卡片（票拟卡：批 / 驳 / 改派） */
  async sendApprovalCard({ title, body, approvalId, options = ['agree', 'reject', 'revise'] }) {
    const target = this.cfg.chatId;
    if (!target) throw new Error('未配置飞书 chatId');
    const token = await this.#getToken();
    const buttons = options.map((o) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: optionLabel(o) },
      type: o === 'agree' ? 'primary' : o === 'reject' ? 'danger' : 'default',
      value: { action: `approval:${o}`, approval_id: approvalId },
    }));
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: title } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: body } },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: buttons,
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: `编号 ${approvalId} · 超时不默认同意` }],
        },
      ],
    };
    const res = await fetch(`${this.base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ receive_id: target, msg_type: 'interactive', content: JSON.stringify(card) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0) throw new Error(`飞书发卡片失败：${data.code} ${data.msg || res.status}`);
    return { ok: true, messageId: data.data?.message_id };
  }

  /** URL 校验（配置回调地址时飞书会打一次） */
  verifyUrl({ timestamp, nonce, challenge, encryptKey }) {
    if (!encryptKey) return { ok: true, challenge };
    return { ok: true, challenge };
  }

  /**
   * 事件回调验签：官方算法 sha256(timestamp + nonce + encryptKey + body)。
   *
   * 这里曾经写成 `return Boolean(signature || true)` 和 `calc === signature || !signature`，
   * 两个都恒为 true —— 等于完全不校验。而这条路径直接决定「谁能批红」，
   * 放行的后果是任何人都能伪造一张卡片把我们的事情批掉。
   *
   * 现在的规矩：
   *  - 没配密钥（本地开发）→ 放行，但要显式说明，别让人以为验过了；
   *  - 配了密钥 → 必须带签名且算法对得上，缺签名一律拒绝。
   */
  verifySignature({ timestamp, nonce, body, token, signature, encryptKey }) {
    const secret = encryptKey || token || this.cfg.verificationToken;
    if (!secret) return true; // 未配置密钥：本地开发放行
    if (!signature) return false; // 配了密钥就必须带签名

    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const raw = String(timestamp) + String(nonce) + secret + payload;
    // 官方两种模式：加密模式用 encryptKey 走 sha256，普通模式用 token 走 sha1
    const algo = encryptKey ? 'sha256' : 'sha1';
    const calc = crypto.createHash(algo).update(raw).digest('hex');

    // 定长比较，避免按字节提前返回泄露签名前缀
    const a = Buffer.from(calc, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

function optionLabel(o) {
  if (o === 'agree') return '批';
  if (o === 'reject') return '驳';
  if (o === 'revise') return '改派';
  return String(o);
}

function richPost({ title, body, level }) {
  const paragraphs = String(body || '').split('\n').map((line) => [{ tag: 'text', text: line }]);
  return {
    zh_cn: {
      title: `${level === 'P0' ? '🔴 ' : ''}${title || '通知'}`,
      content: paragraphs.length ? paragraphs : [[{ tag: 'text', text: '（空）' }]],
    },
  };
}
