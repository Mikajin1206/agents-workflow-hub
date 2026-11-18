/**
 * 单元测试：令牌注入哨兵与引擎日志打码。
 *   node --test test/
 * 背景（2026-11-18 战报 401 实测）：
 *  - 旧兜底判据「占位符原样出现=未配密钥」有歧义，codex 误判后主动不带鉴权头；
 *  - 真实令牌随提示词转储明文落进引擎日志。
 * 这里把两条修复都钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPrompt, TOKEN_NOT_SET } from '../src/m6/skills.mjs';
import { redactSecrets, runProcess } from '../src/m3/engines.mjs';

const base = {
  task: { title: '出日报' },
  skill: { name: 'daily-report', meta: { title: '每日战报' }, body: '带头 x-hub-token: {{token}} 调 {{hub}}/api/stats' },
  decisions: [],
  envelope: { type: 'cron.daily-report', priority: 'P2' },
  payload: {},
  hubUrl: 'http://127.0.0.1:8787',
};

/* ─────────────── {{token}} 哨兵替换 ─────────────── */

test('配了令牌：注入真实值，不出现哨兵和占位符', () => {
  const p = buildPrompt({ ...base, token: 'live-secret-token-abcd' });
  assert.ok(p.includes('x-hub-token: live-secret-token-abcd'), '真实令牌注入');
  assert.ok(!p.includes(TOKEN_NOT_SET), '配了令牌就不该出现哨兵');
  assert.ok(!p.includes('{{token}}'), '占位符被替换掉');
});

test('未配令牌：{{token}} 替换成哨兵 __TOKEN_NOT_SET__', () => {
  const p = buildPrompt(base);
  assert.ok(p.includes(`x-hub-token: ${TOKEN_NOT_SET}`), '哨兵出现在请求头值的位置');
  assert.ok(!p.includes('{{token}}'), '占位符不能留在提示词里——「原样出现=未配密钥」的旧判据有歧义');
  // 额外指令里同样替换（同一 subst 通道）
  const p2 = buildPrompt({ ...base, skill: null, task: { title: '出日报', prompt: '头用 {{token}}' } });
  assert.ok(p2.includes(`头用 ${TOKEN_NOT_SET}`), '额外指令里的占位符也替换成哨兵');
});

/* ─────────────── redactSecrets 打码 ─────────────── */

test('redactSecrets 把日志里的令牌换成「【已打码】」', () => {
  const secret = 'hub-live-token-9f8e7d';
  const out = redactSecrets(`提示词回显：x-hub-token: ${secret} …… 调用失败 401`, secret);
  assert.ok(!out.includes(secret), '明文令牌不能出现在打码结果里');
  assert.ok(out.includes('【已打码】'), '打码标记就位');
  assert.ok(out.includes('401'), '无关内容保留');
});

test('redactSecrets 支持多个秘密、跳过短字符串', () => {
  const out = redactSecrets('a=k1-secret-value b=k2-secret-value c=42', ['k1-secret-value', 'k2-secret-value', '42']);
  assert.ok(!out.includes('k1-secret-value') && !out.includes('k2-secret-value'));
  assert.ok(out.includes('c=42'), '长度不足 8 的不处理，避免误伤');
});

test('redactSecrets 空秘密（无密钥模式）原样返回', () => {
  const s = 'x-hub-token: nothing';
  assert.equal(redactSecrets(s, ''), s);
  assert.equal(redactSecrets(s, []), s);
});

/* ─────────────── runProcess 落盘与返回值都打码 ─────────────── */

test('runProcess 引擎日志落盘前对令牌打码，返回值同样打码', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-redact-'));
  const logPath = path.join(dir, 'engine-test.log');
  const secret = 'hub-live-token-9f8e7d';
  try {
    const res = await runProcess(
      process.execPath,
      ['-e', `process.stdout.write('req header x-hub-token: ${secret} sent'); process.stderr.write('err echoes ${secret} too');`],
      { logPath, redact: (s) => redactSecrets(s, secret) },
    );
    const logged = fs.readFileSync(logPath, 'utf8');
    assert.ok(!logged.includes(secret), '日志文件里不能有明文令牌');
    assert.ok(logged.includes('【已打码】'), '日志里有打码标记');
    assert.ok(!res.stdout.includes(secret), '返回的 stdout 也打码');
    assert.ok(!res.stderr.includes(secret), '返回的 stderr 也打码');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
