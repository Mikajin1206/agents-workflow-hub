/**
 * 「写给人看」文本整理测试（2026-11-17 汇报规范）：
 * 推给老板的文本不带反引号、星号、井号记号，空行紧凑，链接与 PR 地址保留。
 * node --test test/human-text.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { forHuman, errorOneLine } from '../src/lib/human-text.mjs';

test('forHuman：反引号代码标记换成「」', () => {
  const out = forHuman('已修改 `src/index.mjs` 和 `app.js` 两个文件。');
  assert.equal(out, '已修改「src/index.mjs」和「app.js」两个文件。');
  assert.doesNotMatch(out, /`/);
});

test('forHuman：Markdown 标题与粗体记号去掉', () => {
  const out = forHuman('## 任务完成\n\n**已核实**：面板正常。');
  assert.match(out, /「任务完成」/);
  assert.match(out, /已核实：面板正常。/);
  assert.doesNotMatch(out, /[#*]/);
});

test('forHuman：链接变成「文字（地址）」，PR 地址保留', () => {
  const out = forHuman('已开 [PR #12](https://github.com/acme/shop/pull/12)，请批红。');
  assert.match(out, /PR #12（https:\/\/github\.com\/acme\/shop\/pull\/12）/);
  assert.doesNotMatch(out, /\]\(/);
});

test('forHuman：三个以上连续换行压成一个空行，行尾空白去掉', () => {
  const out = forHuman('第一行。\n\n\n\n\n第二行。  \n第三行。');
  assert.equal(out, '第一行。\n\n第二行。\n第三行。');
});

test('forHuman：正文主体与换行结构原样保留', () => {
  const src = [
    '做完了。',
    '1. 修复了发布脚本的判断顺序。',
    '2. 补了回归测试，全部通过。',
    'PR：（https://github.com/acme/shop/pull/9）',
  ].join('\n');
  assert.equal(forHuman(src), src);
});

test('errorOneLine：多行堆栈压成一行并截断', () => {
  const stack = 'Error: connect timeout\n    at TCP.connect (node:net)\n    at async fetch (node:internal)';
  const out = errorOneLine(stack, 50);
  assert.doesNotMatch(out, /\n/);
  assert.ok(out.length <= 51, `截断生效（长度 ${out.length}）`);
  assert.match(out, /…$/);
});

test('errorOneLine：空报错给「未知原因」', () => {
  assert.equal(errorOneLine(null), '未知原因');
  assert.equal(errorOneLine('   '), '未知原因');
});
