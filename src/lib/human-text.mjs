/**
 * 「写给人看」的文本整理（2026-11-17 老板定）。
 *
 * 老板不是程序员，收到的推送里不该出现反引号、星号、井号这类排版记号，
 * 也不该有大段空行和原始报错堆栈。 Worker 的产出在推给人之前过一遍 forHuman()，
 * 归档留底仍然存原文（可审计），两不耽误。
 */

/**
 * 把一段面向程序员的 Markdown 产出整理成给人看的纯文本：
 *  - 反引号代码标记 → 「」（飞书纯文本里反引号原样显示，是「阅读困难的单引号」的主源）；
 *  - Markdown 标题与粗体记号去掉，标题文字用「」框住；
 *  - 链接 [文字](地址) → 文字（地址），地址保留（PR 链接是后续流程的依据，不能丢）；
 *  - 行尾空白去掉，三个以上连续换行压成一个空行。
 */
export function forHuman(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  // 标题行：# 任务完成 → 「任务完成」（行尾的 #闭合记号一并去掉）
  s = s.replace(/^#{1,6}\s*(.+?)\s*#*$/gm, '「$1」');
  // 行内代码：`xxx` → 「xxx」
  s = s.replace(/`([^`\n]+)`/g, '「$1」');
  // 中日韩文字与「」之间不留空格（替换残留的排版空格，中文排版不需要）
  const cjk = '[\\u4e00-\\u9fff\\u3000-\\u303f，。、；：？！（）]';
  s = s.replace(new RegExp(`(${cjk}) +「`, 'g'), '$1「').replace(new RegExp(`」 +(${cjk})`, 'g'), '」$1');
  // 粗体/斜体记号：**xxx**、__xxx__ → xxx（飞书纯文本里星号原样显示）
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  // 链接：[PR #12](https://…) → PR #12（https://…）
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）');
  // 行尾空白；三个以上连续换行压成一个空行
  s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 把报错压成一行短句，包给人看用。
 * 堆栈、多行日志压掉空白后截断；完整记录在面板「任务」页，推送里只留一句原因。
 */
export function errorOneLine(err, max = 200) {
  const s = String(err ?? '未知原因').replace(/\s+/g, ' ').trim();
  if (!s) return '未知原因';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 从查询答复里摘出「下一步的执行建议」一段（2026-11-18 采纳执行优化）。
 *
 * 查询答复固定三段：问题理解 / 问题分析 / 下一步的执行建议。采纳派活时，
 * 干活的人只需要建议段——理解与分析是给老板看的背景，不是施工图，
 * 整篇塞进任务只会把执行带偏（实测：把答复全文派下去，执行者跑去重新调查一遍）。
 *
 * 兼容两种标题形态：原始 Markdown 的「### 下一步的执行建议」，
 * 和 forHuman() 整理后存进票拟单的「下一步的执行建议」。
 * 找不到结构化标题或段落为空时原样返回全文（宁多勿漏，不要派空任务）。
 */
export function suggestionsFromQueryAnswer(text) {
  const raw = String(text ?? '');
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const isHeading = (line) => {
    const t = line.trim();
    return /^#{1,6}\s*\S/.test(t) || /^「[^」\n]+」$/.test(t);
  };
  const start = lines.findIndex((l) => /下一步的执行建议/.test(l) && isHeading(l));
  if (start < 0) return raw.trim();
  const rest = lines.slice(start + 1);
  const next = rest.findIndex(isHeading);
  const body = (next < 0 ? rest : rest.slice(0, next)).join('\n').trim();
  return body || raw.trim();
}
