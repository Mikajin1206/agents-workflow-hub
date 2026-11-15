// 飞书长连接协议层的单元测试：protobuf 编解码、分片重组。
// 不做真实网络 —— 真连接在服务里起（或手动 node scripts/feishu-ws-probe.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, ChunkCache } from '../src/m1/feishu-ws.mjs';

test('帧编解码往返：headers + payload + varint 全部保留', () => {
  const frame = {
    seqId: 300,
    logId: 7,
    service: 9,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'msg-1' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
    ],
    payload: Buffer.from(JSON.stringify({ schema: '2.0', hello: '世界' }), 'utf8'),
  };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.equal(decoded.seqId, 300);
  assert.equal(decoded.logId, 7);
  assert.equal(decoded.service, 9);
  assert.equal(decoded.method, 1);
  assert.deepEqual(decoded.headers, frame.headers);
  assert.equal(JSON.parse(decoded.payload.toString('utf8')).hello, '世界');
});

test('大 varint（service_id 可能是很大的数）不丢精度', () => {
  const service = 12345678901; // > 2^32
  const decoded = decodeFrame(encodeFrame({ seqId: 0, logId: 0, service, method: 0, headers: [] }));
  assert.equal(decoded.service, service);
});

test('ping 帧编码：Method=0、headers 只有 type=ping', () => {
  const decoded = decodeFrame(encodeFrame({
    seqId: 0, logId: 0, service: 7, method: 0,
    headers: [{ key: 'type', value: 'ping' }],
  }));
  assert.equal(decoded.method, 0);
  assert.deepEqual(decoded.headers, [{ key: 'type', value: 'ping' }]);
  assert.equal(decoded.payload, null);
});

test('响应帧：payload 是 {"code":200,"data":"<base64>"}，headers 保留原帧并可附加 biz_rt', () => {
  const original = decodeFrame(encodeFrame({
    seqId: 5, logId: 6, service: 9, method: 1,
    headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm' }],
    payload: Buffer.from('{}'),
  }));
  const data = Buffer.from(JSON.stringify({ toast: { type: 'info', content: '已批红' } })).toString('base64');
  const out = decodeFrame(encodeFrame({
    seqId: original.seqId, logId: original.logId, service: original.service, method: original.method,
    headers: [...original.headers, { key: 'biz_rt', value: '12' }],
    payload: Buffer.from(JSON.stringify({ code: 200, data }), 'utf8'),
  }));
  const resp = JSON.parse(out.payload.toString('utf8'));
  assert.equal(resp.code, 200);
  assert.deepEqual(JSON.parse(Buffer.from(resp.data, 'base64').toString('utf8')), { toast: { type: 'info', content: '已批红' } });
  assert.equal(out.headers.find((h) => h.key === 'biz_rt').value, '12');
  assert.equal(out.seqId, 5);
});

test('分片重组：sum>1 按 seq 拼接，到齐才返回', () => {
  const cache = new ChunkCache();
  const a = Buffer.from('hello ');
  const b = Buffer.from('feishu-ws');
  assert.equal(cache.merge({ messageId: 'm1', sum: 2, seq: 1, data: b }), null);
  const full = cache.merge({ messageId: 'm1', sum: 2, seq: 0, data: a });
  assert.equal(full.toString('utf8'), 'hello feishu-ws');
  // 重组后缓存里已经没有这条消息
  assert.equal(cache.map.has('m1'), false);
  cache.destroy();
});

test('分片重组：单帧（sum<=1）直接透传', () => {
  const cache = new ChunkCache();
  const raw = Buffer.from('{"a":1}');
  const out = cache.merge({ messageId: '', sum: 1, seq: 0, data: raw });
  assert.equal(out.toString('utf8'), '{"a":1}');
  cache.destroy();
});

test('分片重组：5 秒 TTL 后丢弃不完整消息（不无限堆积）', async () => {
  const cache = new ChunkCache({ ttlMs: 30 });
  cache.merge({ messageId: 'm2', sum: 2, seq: 0, data: Buffer.from('half') });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cache.map.has('m2'), false);
  cache.destroy();
});
