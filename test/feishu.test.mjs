import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { FeishuClient } from '../src/m5/feishu.mjs';

/**
 * 飞书客户端测试（不发真实请求，只测纯逻辑）。
 *
 * 重点在 verifySignature：它决定「谁能批红」。这条路径一旦恒为 true，
 * 任何知道回调地址的人都能伪造卡片把待批事项批掉 —— 比系统跑不起来严重得多。
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const makeClient = (cfg = {}) => new FeishuClient(cfg, silentLog);

function sign({ timestamp, nonce, secret, body, algo = 'sha1' }) {
  const raw = String(timestamp) + String(nonce) + secret + (typeof body === 'string' ? body : JSON.stringify(body));
  return crypto.createHash(algo).update(raw).digest('hex');
}

test('feishu: 未配置任何密钥时放行（本地开发语义）', () => {
  const c = makeClient({});
  assert.equal(c.verifySignature({ timestamp: '1', nonce: 'n', body: {}, signature: null }), true);
});

test('feishu: 配了 token 就必须带合法签名', () => {
  const token = 'vt-secret';
  const c = makeClient({ verificationToken: token });
  const timestamp = '1700000000';
  const nonce = 'n-1';
  const body = { event: { message: { text: 'hi' } } };
  const good = sign({ timestamp, nonce, secret: token, body });

  assert.equal(c.verifySignature({ timestamp, nonce, body, token, signature: good }), true);

  // 没有签名 → 拒绝（旧代码 `|| !signature` 会放行，是真实漏洞）
  assert.equal(c.verifySignature({ timestamp, nonce, body, token, signature: null }), false);
  assert.equal(c.verifySignature({ timestamp, nonce, body, token, signature: '' }), false);

  // 签名错 → 拒绝
  assert.equal(c.verifySignature({ timestamp, nonce, body, token, signature: 'deadbeef' }), false);

  // 时间戳被换 → 拒绝（防重放的基础）
  assert.equal(c.verifySignature({ timestamp: '1700000001', nonce, body, token, signature: good }), false);

  // 正文被改 → 拒绝
  assert.equal(c.verifySignature({ timestamp, nonce, body: { ...body, event: {} }, token, signature: good }), false);
});

test('regression: 加密模式不能用「有签名就算过」冒充验签', () => {
  // 旧实现：return Boolean(signature || true) —— 恒 true。
  // 现在必须真的算出 sha256 来比对。
  const encryptKey = 'ek-secret';
  const c = makeClient({ encryptKey });
  const timestamp = '1700000000';
  const nonce = 'n-2';
  const body = { encrypt: 'cipher-text' };
  const good = sign({ timestamp, nonce, secret: encryptKey, body, algo: 'sha256' });

  assert.equal(c.verifySignature({ timestamp, nonce, body, signature: good, encryptKey }), true);
  assert.equal(c.verifySignature({ timestamp, nonce, body, signature: 'anything', encryptKey }), false,
    '随便给个签名不能算通过');
  assert.equal(c.verifySignature({ timestamp, nonce, body, signature: null, encryptKey }), false);
});

test('feishu: enabled 需要 enabled + appId + appSecret 三者齐全', () => {
  assert.equal(makeClient({}).enabled, false);
  assert.equal(makeClient({ enabled: true }).enabled, false);
  assert.equal(makeClient({ enabled: true, appId: 'a' }).enabled, false);
  assert.equal(makeClient({ enabled: true, appId: 'a', appSecret: 's' }).enabled, true);
  // 关掉开关后即使填了凭据也不该发消息
  assert.equal(makeClient({ enabled: false, appId: 'a', appSecret: 's' }).enabled, false);
});

test('feishu: verifyUrl 回显 challenge', () => {
  const c = makeClient({});
  assert.deepEqual(c.verifyUrl({ challenge: 'abc' }), { ok: true, challenge: 'abc' });
});
