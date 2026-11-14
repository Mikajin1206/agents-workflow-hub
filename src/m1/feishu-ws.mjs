// 飞书长连接（WebSocket）客户端 —— 零依赖实现。
//
// 为什么存在：SakuraFrp 自动 HTTPS 只发自家自签证书（CN=SakuraFrp Automatic TLS），
// 飞书服务端不信任，webhook 回调路线死在没有自有备案域名上。长连接是官方推荐方式：
// 不需要公网 IP / 域名 / 证书，出站 WSS 建连后事件与卡片回调全部从同一条连接推下来。
//
// 协议来源（三家官方 SDK 源码核对一致，字段号以 oapi-sdk-go ws/pbbp2.pb.go 为准）：
//   1) POST {domain}/callback/ws/endpoint  {"AppID","AppSecret"} → {code, data:{URL, ClientConfig}}
//      URL 自带 device_id / service_id 两个 query 参数。
//   2) 二进制 WS 帧 = protobuf pbbp2.Frame：
//      1 SeqID(varint) 2 LogID(varint) 3 Service(varint) 4 Method(varint: 0=Control 1=Data)
//      5 Headers(repeated {1 Key, 2 Value}) 6 PayloadEncoding 7 PayloadType 8 Payload(bytes) 9 LogIDNew
//   3) 保活：连上立即发 ping（Method=0, Headers[{type:"ping"}], Service=service_id），
//      之后每 PingInterval 秒一次；服务端 pong 的 payload 可能带 ClientConfig（秒），
//      要即时更新本地定时器。读超时 = 2*PingInterval + 5s。
//   4) 事件帧 Method=1，headers: type=event|card、message_id、sum、seq、trace_id；
//      sum>1 时按 message_id 分片重组（5 秒缓存，到齐 concat）。
//   5) 响应帧 = 原帧回写（headers 保留，可加 biz_rt），payload =
//      {"code":200,"data":"<base64(JSON.stringify(handlerResult))>"}；handler 抛错则 code=500。
//      卡片按钮的 toast 反馈就放在 handlerResult.toast 里。

import crypto from 'node:crypto';

/* ─────────────── protobuf varint / Frame 编解码 ─────────────── */

function encodeVarint(value) {
  const out = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function encodeTag(fieldNo, wireType) {
  return encodeVarint((fieldNo << 3) | wireType);
}

function encodeBytesField(fieldNo, buf) {
  return Buffer.concat([encodeTag(fieldNo, 2), encodeVarint(buf.length), buf]);
}

function encodeVarintField(fieldNo, value) {
  return Buffer.concat([encodeTag(fieldNo, 0), encodeVarint(value)]);
}

export function encodeFrame(frame) {
  const parts = [];
  if (frame.seqId !== undefined) parts.push(encodeVarintField(1, frame.seqId));
  if (frame.logId !== undefined) parts.push(encodeVarintField(2, frame.logId));
  if (frame.service !== undefined) parts.push(encodeVarintField(3, frame.service));
  if (frame.method !== undefined) parts.push(encodeVarintField(4, frame.method));
  for (const h of frame.headers || []) {
    const key = Buffer.from(String(h.key ?? ''), 'utf8');
    const value = Buffer.from(String(h.value ?? ''), 'utf8');
    parts.push(encodeBytesField(5, Buffer.concat([
      encodeBytesField(1, key),
      encodeBytesField(2, value),
    ])));
  }
  if (frame.payloadEncoding) parts.push(encodeBytesField(6, Buffer.from(frame.payloadEncoding, 'utf8')));
  if (frame.payloadType) parts.push(encodeBytesField(7, Buffer.from(frame.payloadType, 'utf8')));
  if (frame.payload !== undefined && frame.payload !== null) {
    parts.push(encodeBytesField(8, Buffer.isBuffer(frame.payload) ? frame.payload : Buffer.from(frame.payload)));
  }
  if (frame.logIdNew) parts.push(encodeBytesField(9, Buffer.from(frame.logIdNew, 'utf8')));
  return Buffer.concat(parts);
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const b = buf[i];
    i += 1;
    result += (b & 0x7f) * 2 ** shift; // 用乘法避免 32 位溢出
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
  return { value: result, next: i };
}

export function decodeFrame(buf) {
  const frame = { seqId: 0, logId: 0, service: 0, method: 0, headers: [], payload: null };
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    i = tag.next;
    const fieldNo = tag.value >>> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const v = readVarint(buf, i);
      i = v.next;
      if (fieldNo === 1) frame.seqId = v.value;
      else if (fieldNo === 2) frame.logId = v.value;
      else if (fieldNo === 3) frame.service = v.value;
      else if (fieldNo === 4) frame.method = v.value;
    } else if (wireType === 2) {
      const len = readVarint(buf, i);
      i = len.next;
      const slice = buf.subarray(i, i + len.value);
      i += len.value;
      if (fieldNo === 5) {
        // Header { 1: key, 2: value }
        let j = 0;
        const header = { key: '', value: '' };
        while (j < slice.length) {
          const t = readVarint(slice, j);
          j = t.next;
          const f = t.value >>> 3;
          const w = t.value & 7;
          if (w === 2) {
            const l = readVarint(slice, j);
            j = l.next;
            const s = slice.subarray(j, j + l.value).toString('utf8');
            j += l.value;
            if (f === 1) header.key = s;
            else if (f === 2) header.value = s;
          } else {
            break; // 不认识的字段，停止解析这个 header（正常不会出现）
          }
        }
        frame.headers.push(header);
      } else if (fieldNo === 6) frame.payloadEncoding = slice.toString('utf8');
      else if (fieldNo === 7) frame.payloadType = slice.toString('utf8');
      else if (fieldNo === 8) frame.payload = Buffer.from(slice);
      else if (fieldNo === 9) frame.logIdNew = slice.toString('utf8');
    } else {
      throw new Error(`不支持的 wire type: ${wireType}（field ${fieldNo}）`);
    }
  }
  return frame;
}

/* ─────────────── 分片重组缓存 ─────────────── */

export class ChunkCache {
  constructor({ ttlMs = 5000 } = {}) {
    this.ttlMs = ttlMs;
    this.map = new Map(); // message_id → { sum, chunks: Map(seq→Buffer), timer }
  }

  // 返回完整 payload（Buffer）或 null（还没到齐）
  merge({ messageId, sum, seq, data }) {
    if (!messageId || sum <= 1) return Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    let entry = this.map.get(messageId);
    if (!entry) {
      entry = { sum, chunks: new Map(), timer: null };
      entry.timer = setTimeout(() => this.map.delete(messageId), this.ttlMs);
      this.map.set(messageId, entry);
    }
    entry.chunks.set(seq, Buffer.from(data || ''));
    if (entry.chunks.size < sum) return null;
    const parts = [];
    for (let k = 0; k < sum; k += 1) {
      const chunk = entry.chunks.get(k);
      if (!chunk) return null; // 缺中间片
      parts.push(chunk);
    }
    clearTimeout(entry.timer);
    this.map.delete(messageId);
    return Buffer.concat(parts);
  }

  destroy() {
    for (const entry of this.map.values()) clearTimeout(entry.timer);
    this.map.clear();
  }
}

/* ─────────────── WS 客户端 ─────────────── */

const DEFAULTS = {
  domain: 'https://open.feishu.cn',
  pingIntervalSec: 120,   // 服务端 ClientConfig 会覆盖
  reconnectIntervalSec: 120,
  reconnectNonceSec: 30,
  reconnectCount: -1,     // <0 = 无限重连
};

export class FeishuWSClient {
  constructor({ appId, appSecret, domain, logger, onEvent } = {}) {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(String(appId || ''))) {
      throw new Error(`飞书长连接：appId 格式不合法（应为 cli_ 开头 16 位十六进制）：${appId}`);
    }
    if (!appSecret) throw new Error('飞书长连接：缺少 appSecret');
    if (typeof onEvent !== 'function') throw new Error('飞书长连接：缺少 onEvent 处理器');
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = (domain || DEFAULTS.domain).replace(/\/+$/, '');
    this.log = logger || console;
    this.onEvent = onEvent;
    this.cache = new ChunkCache();

    this.ws = null;
    this.closed = false;      // stop() 之后不再重连
    this.connecting = false;
    this.serviceId = '';
    this.deviceId = '';
    this.pingIntervalMs = DEFAULTS.pingIntervalSec * 1000;
    this.pingTimer = null;
    this.watchdogTimer = null;
    this.lastInboundAt = 0;
    this.reconnectAttempts = 0;
    this.connectedAt = 0;
    this.lastEventAt = 0;
    // 重连参数（服务端 ClientConfig 会覆盖）
    this.reconnectIntervalMs = DEFAULTS.reconnectIntervalSec * 1000;
    this.reconnectNonceMs = DEFAULTS.reconnectNonceSec * 1000;
    this.reconnectMax = DEFAULTS.reconnectCount;
  }

  status() {
    return {
      mode: 'websocket',
      connected: Boolean(this.ws && this.connectedAt > 0),
      connected_since: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      device_id: this.deviceId ? `${this.deviceId.slice(0, 6)}…` : null,
      service_id: this.serviceId || null,
      reconnect_attempts: this.reconnectAttempts,
      last_event_at: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      ping_interval_sec: Math.round(this.pingIntervalMs / 1000),
    };
  }

  async start() {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    this.#scheduleReconnect(0).finally(() => { this.connecting = false; });
  }

  stop() {
    this.closed = true;
    clearTimeout(this.pingTimer);
    clearTimeout(this.watchdogTimer);
    this.cache.destroy();
    if (this.ws) {
      try { this.ws.close(); } catch { /* 已断开 */ }
      this.ws = null;
    }
    this.connectedAt = 0;
  }

  /* —— 连接生命周期 —— */

  async #scheduleReconnect(delayMs) {
    if (this.closed) return;
    if (delayMs > 0) {
      this.log.info?.(`飞书长连接：${Math.round(delayMs / 1000)} 秒后重连`);
      await new Promise((r) => setTimeout(r, delayMs));
      if (this.closed) return;
    }
    // ReconnectMax<0 视为无限重连；>=0 时超过次数就放弃
    if (this.reconnectMax >= 0 && this.reconnectAttempts >= this.reconnectMax) {
      this.log.error?.('飞书长连接：重连次数耗尽，放弃');
      return;
    }
    try {
      await this.#connectOnce();
      this.reconnectAttempts = 0;
      this.log.info?.('飞书长连接：已连接，开始接收事件与卡片回调');
    } catch (err) {
      this.reconnectAttempts += 1;
      this.log.error?.(`飞书长连接：连接失败（第 ${this.reconnectAttempts} 次）：${err.message}`);
      const nonce = this.reconnectNonceMs * Math.random();
      return this.#scheduleReconnect(nonce + this.reconnectIntervalMs);
    }
  }

  async #connectOnce() {
    const endpoint = await this.#bootstrap();
    this.log.info?.(`飞书长连接：拿到接入点（device_id=${this.deviceId?.slice(0, 6)}…）`);
    await this.#dial(endpoint);
    this.#startPingLoop();
    this.#startWatchdog();
  }

  async #bootstrap() {
    const resp = await fetch(`${this.domain}/callback/ws/endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        locale: 'zh',
        'User-Agent': 'agents-workflow-hub/1.0 (node; +long-connection)',
      },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await resp.json().catch(() => ({}));
    if (body.code !== 0) {
      throw new Error(`bootstrap code=${body.code} msg=${body.msg || resp.status}`);
    }
    const url = body.data?.URL;
    if (!url) throw new Error('bootstrap 返回里没有 URL');
    const parsed = new URL(url);
    this.deviceId = parsed.searchParams.get('device_id') || '';
    this.serviceId = parsed.searchParams.get('service_id') || '';
    const conf = body.data?.ClientConfig;
    if (conf) this.#applyConfig(conf);
    return url;
  }

  #applyConfig(conf) {
    // ClientConfig 字段单位是秒；注意字段名是帕斯卡（Go SDK json tag 原样）
    const pick = (v, fallbackMs) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 1000 : fallbackMs);
    this.pingIntervalMs = pick(conf.PingInterval, this.pingIntervalMs);
    if (Number.isFinite(Number(conf.ReconnectInterval)) && Number(conf.ReconnectInterval) > 0) {
      this.reconnectIntervalMs = Number(conf.ReconnectInterval) * 1000;
    }
    if (Number.isFinite(Number(conf.ReconnectNonce)) && Number(conf.ReconnectNonce) > 0) {
      this.reconnectNonceMs = Number(conf.ReconnectNonce) * 1000;
    }
    if (Number.isFinite(Number(conf.ReconnectCount))) this.reconnectMax = Number(conf.ReconnectCount);
  }

  #dial(url) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new globalThis.WebSocket(url);
        ws.binaryType = 'arraybuffer';
      } catch (err) {
        return reject(err);
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('WebSocket 握手超时'));
      }, 15_000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.connectedAt = Date.now();
        this.lastInboundAt = Date.now();
        ws.addEventListener('message', (ev) => this.#onRawMessage(ev));
        ws.addEventListener('close', () => this.#onClose());
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        if (!this.ws) reject(new Error('WebSocket 握手失败'));
      });
    });
  }

  #onClose() {
    if (this.closed) return;
    const wasConnected = this.connectedAt > 0;
    this.connectedAt = 0;
    this.ws = null;
    clearTimeout(this.pingTimer);
    clearTimeout(this.watchdogTimer);
    this.log.warn?.('飞书长连接：连接断开');
    const nonce = this.reconnectNonceMs * Math.random();
    this.#scheduleReconnect(wasConnected ? nonce : nonce + this.reconnectIntervalMs);
  }

  /* —— 保活 —— */

  #startPingLoop() {
    clearTimeout(this.pingTimer);
    this.#sendPing();
    this.pingTimer = setTimeout(() => this.#startPingLoop(), this.pingIntervalMs);
  }

  #sendPing() {
    if (!this.ws) return;
    try {
      const frame = encodeFrame({
        seqId: 0,
        logId: 0,
        service: Number(this.serviceId || 0),
        method: 0, // Control
        headers: [{ key: 'type', value: 'ping' }],
      });
      this.ws.send(frame);
    } catch (err) {
      this.log.warn?.(`飞书长连接：ping 发送失败：${err.message}`);
    }
  }

  // 读超时看门狗：超过 2*pingInterval+5s 没有任何入站帧就断开重连
  #startWatchdog() {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.closed || !this.ws) return;
      const deadline = 2 * this.pingIntervalMs + 5000;
      if (Date.now() - this.lastInboundAt > deadline) {
        this.log.warn?.('飞书长连接：读超时（服务端无响应），强制重连');
        try { this.ws.close(); } catch { /* ignore */ }
        this.#onClose();
        return;
      }
      this.#startWatchdog();
    }, 10_000);
  }

  /* —— 入站帧处理 —— */

  #onRawMessage(ev) {
    this.lastInboundAt = Date.now();
    let buf;
    try {
      buf = Buffer.from(new Uint8Array(ev.data));
    } catch {
      this.log.warn?.('飞书长连接：收到非二进制帧，忽略');
      return;
    }
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch (err) {
      this.log.error?.(`飞书长连接：帧解码失败：${err.message}`);
      return;
    }
    if (frame.method === 0) return this.#handleControl(frame);
    if (frame.method === 1) {
      // 事件处理可能比下一条消息慢，不阻塞读循环
      this.#handleData(frame).catch((err) => this.log.error?.(`飞书长连接：事件处理异常：${err.message}`));
    }
  }

  #handleControl(frame) {
    const type = frame.headers.find((h) => h.key === 'type')?.value;
    if (type !== 'pong' || !frame.payload?.length) return;
    try {
      const conf = JSON.parse(frame.payload.toString('utf8'));
      this.#applyConfig(conf);
      clearTimeout(this.pingTimer);
      this.#startPingLoop();
    } catch { /* pong payload 不一定是配置，忽略 */ }
  }

  async #handleData(frame) {
    const headerOf = (key) => frame.headers.find((h) => h.key === key)?.value;
    const type = headerOf('type');
    if (type !== 'event' && type !== 'card') return;
    const messageId = headerOf('message_id') || crypto.randomUUID();
    const sum = Number(headerOf('sum') || 1);
    const seq = Number(headerOf('seq') || 0);

    const payload = this.cache.merge({ messageId, sum, seq, data: frame.payload });
    if (!payload) return; // 分片还没到齐

    let body;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch (err) {
      this.log.error?.(`飞书长连接：事件 payload 不是合法 JSON：${err.message}`);
      return;
    }
    this.lastEventAt = Date.now();

    // 处理（与 /webhook/feishu 同一条业务链）；卡片动作的 toast 放在返回值里
    const resp = { code: 200 };
    const startedAt = Date.now();
    try {
      const result = await this.onEvent(body);
      if (result !== undefined && result !== null) {
        resp.data = Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
      }
    } catch (err) {
      resp.code = 500;
      this.log.error?.(`飞书长连接：事件处理失败：${err.message}`);
    }
    const bizRt = Date.now() - startedAt;

    if (!this.ws) return;
    try {
      const headers = [...frame.headers, { key: 'biz_rt', value: String(bizRt) }];
      const out = encodeFrame({
        seqId: frame.seqId,
        logId: frame.logId,
        service: frame.service,
        method: frame.method,
        headers,
        payload: Buffer.from(JSON.stringify(resp), 'utf8'),
      });
      this.ws.send(out);
    } catch (err) {
      this.log.warn?.(`飞书长连接：响应回写失败：${err.message}`);
    }
  }
}
