/**
 * 「写给人看」文本整理测试（2026-11-17 汇报规范）：
 * 推给老板的文本不带反引号、星号、井号记号，空行紧凑，链接与 PR 地址保留。
 * node --test test/human-text.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { forHuman, errorOneLine, suggestionsFromQueryAnswer } from '../src/lib/human-text.mjs';

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

/* ────────────────── 采纳执行优化：从查询答复摘出建议段（2026-11-18） ────────────────── */

test('suggestionsFromQueryAnswer：从 forHuman 整理后的答复里摘出建议段', () => {
  const answer = [
    '做完了（只读查询，未执行重推）。',
    '',
    '「问题理解」',
    '老板想把今天的战报重推一次。',
    '',
    '「问题分析」',
    '早上那份战报因接口 401 没有任何数字。',
    '',
    '「下一步的执行建议」',
    '1. 修复日报鉴权兜底判据。',
    '2. 修完后重启中台加载新代码（需要批红：重启属短暂停服）。',
  ].join('\n');
  const out = suggestionsFromQueryAnswer(answer);
  assert.match(out, /1\. 修复日报鉴权兜底判据/, '建议内容保留');
  assert.match(out, /需要批红/, '建议里的批红标注保留');
  assert.doesNotMatch(out, /问题理解|401/, '理解与分析不塞给执行者');
});

test('suggestionsFromQueryAnswer：兼容原始 Markdown 三段标题', () => {
  const answer = '### 问题理解\n想重推战报。\n\n### 问题分析\n接口 401。\n\n### 下一步的执行建议\n1. 修鉴权。\n2. 重推。';
  const out = suggestionsFromQueryAnswer(answer);
  assert.equal(out, '1. 修鉴权。\n2. 重推。');
});

test('suggestionsFromQueryAnswer：建议段在下一段标题处截断', () => {
  const answer = '「下一步的执行建议」\n1. 先修鉴权。\n\n「补充说明」\n这一段不该带进任务。';
  const out = suggestionsFromQueryAnswer(answer);
  assert.match(out, /先修鉴权/);
  assert.doesNotMatch(out, /补充说明|不该带进任务/);
});

test('suggestionsFromQueryAnswer：没有结构化标题时原样保留全文（宁多勿漏）', () => {
  const free = '建议：先修鉴权，再重推一次战报。';
  assert.equal(suggestionsFromQueryAnswer(free), free);
});

test('suggestionsFromQueryAnswer：建议段为空时回退全文，不派空任务', () => {
  const answer = '「问题理解」\n想重推。\n\n「下一步的执行建议」';
  assert.equal(suggestionsFromQueryAnswer(answer), answer.trim());
  assert.equal(suggestionsFromQueryAnswer(''), '');
  assert.equal(suggestionsFromQueryAnswer(null), '');
});
