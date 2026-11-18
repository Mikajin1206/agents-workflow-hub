import fs from 'node:fs';
import path from 'node:path';

/**
 * M6-①：Skill 库（SOP）。
 *
 * 一个 Skill = 一个目录，含 SKILL.md（本体，Markdown + 可选 YAML front matter）。
 * 派活时把 Skill 正文拼进提示词，让同一类任务永远按同一套 SOP 执行。
 */
export class SkillLibrary {
  constructor({ dir, log }) {
    this.dir = dir;
    this.log = log;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  /** 扫描出所有可用 skill */
  list() {
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(this.dir, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const meta = this.#readMeta(file);
      out.push({ name: e.name, ...meta, path: file });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  #readMeta(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const fm = parseFrontMatter(raw);
      return {
        title: fm.title || fm.name || '',
        description: fm.description || '',
        tags: fm.tags || [],
        engine: fm.engine || null,
        version: fm.version || null,
      };
    } catch {
      return { title: '', description: '', tags: [] };
    }
  }

  load(name) {
    if (!name) return null;
    if (this.cache.has(name)) {
      const cached = this.cache.get(name);
      const stat = safeStat(cached.path);
      if (stat && stat.mtimeMs === cached.mtimeMs) return cached;
    }
    const file = path.join(this.dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    const stat = safeStat(file);
    const raw = fs.readFileSync(file, 'utf8');
    const fm = parseFrontMatter(raw);
    const skill = {
      name,
      path: file,
      mtimeMs: stat?.mtimeMs || 0,
      meta: { title: fm.title || name, description: fm.description || '', tags: fm.tags || [], engine: fm.engine || null },
      body: fm.body.trim(),
    };
    this.cache.set(name, skill);
    return skill;
  }

  /** 拼装提示词（转发到模块级 buildPrompt，方便调用方只拿库对象） */
  buildPrompt(args) {
    return buildPrompt(args);
  }

  /** 新 skill 脚手架 */
  scaffold(name, { title, description } = {}) {
    const dir = path.join(this.dir, name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`skill 已存在：${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const md = [
      '---',
      `title: ${title || name}`,
      `description: ${description || '（一句话说明这个 SOP 解决什么问题）'}`,
      '---',
      '',
      `# ${title || name}`,
      '',
      '## 何时触发',
      '',
      '- ',
      '',
      '## 标准步骤',
      '',
      '1. ',
      '',
      '## 判据（什么算做完）',
      '',
      '- ',
      '',
      '## 禁忌',
      '',
      '- 不删数据、不停服、不对外发消息；遇到就停下来要求批红。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
    return path.join(dir, 'SKILL.md');
  }
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/** 极简 front matter 解析（只支持 key: value 与 key: [a, b]） */
export function parseFrontMatter(raw) {
  const text = String(raw || '');
  if (!text.startsWith('---')) return { body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { body: text };
  const head = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const fm = {};
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    // tags 这类逗号分隔值统一成数组，避免下游 .map 崩
    if (m[1] === 'tags' && typeof val === 'string') {
      val = val.split(',').map((s) => s.trim()).filter(Boolean);
    }
    fm[m[1]] = val;
  }
  return { ...fm, body };
}

/**
 * 未配置中台令牌时，{{token}} 占位替换成的哨兵值。
 * 日报 SOP 的鉴权兜底判据只认这个哨兵；导出常量让测试与调用方共用同一字面量。
 */
export const TOKEN_NOT_SET = '__TOKEN_NOT_SET__';

/** 组装最终提示词：任务背景 + Skill 正文 + 决定记忆 + 指令模板 */
export function buildPrompt({ task, skill, decisions, envelope, payload, hubUrl, token }) {
  // SOP 里可以用 {{hub}} / {{token}} 占位（"调 GET {{hub}}/api/stats，带头 x-hub-token: {{token}}"）。
  // 不替换的话模型会收到字面占位符，要么去猜地址、要么直接放弃——
  // 实测 codex 因此输出了"做不了：无法确认 Hub 地址"。
  // {{token}} 是中台访问令牌（hub.secret）：中台配了真实密钥后 /api/* 全部 401，
  // 不注入的话日报这类要调 API 取数的 SOP 会在第一步就死掉（2026-11-17 战报实测）。
  // 未配密钥（或仍是默认开发值）时，{{token}} 替换成哨兵 __TOKEN_NOT_SET__，
  // 不再保留字面占位符：日报 SOP 的兜底判据只认哨兵。旧写法「占位符原样出现=未配密钥」
  // 有歧义——替换后提示词里依然有 token 字样（请求头名等正常文案），codex 按字面
  // 误判「未配密钥」、主动省掉鉴权头，三个接口全 401（2026-11-18 战报实测）。
  const subst = (s) => {
    let out = String(s);
    if (hubUrl) out = out.replaceAll('{{hub}}', hubUrl);
    out = out.replaceAll('{{token}}', token || TOKEN_NOT_SET);
    return out;
  };
  const parts = [];
  parts.push('## 任务');
  parts.push(`- 标题：${task.title || '(无)'}`);
  parts.push(`- 事件类型：${envelope?.type || '(未知)'}`);
  if (envelope?.target) parts.push(`- 目标：${envelope.target}`);
  if (envelope?.link) parts.push(`- 相关链接：${envelope.link}`);
  parts.push(`- 优先级：${envelope?.priority || 'P2'}`);
  if (task.workdir) parts.push(`- 工作目录：${task.workdir}`);

  if (payload && Object.keys(payload).length) {
    parts.push('', '## 事件携带参数');
    parts.push('```json');
    parts.push(JSON.stringify(payload, null, 2));
    parts.push('```');
  }

  if (decisions && decisions.length) {
    parts.push('', '## 已定过的事（必须遵守，不要推翻）');
    for (const d of decisions) {
      parts.push(`- [${d.kind === 'refused' ? '定了不做' : '定过的事'}] ${d.text}（${d.decided_at.slice(0, 10)}，${d.decided_by}${d.quote && d.quote !== d.text ? '：「' + d.quote + '」' : ''}）`);
    }
  }

  if (skill) {
    parts.push('', `## 执行 SOP：${skill.meta.title}（skill: ${skill.name}）`);
    parts.push(subst(skill.body));
  }

  if (task.prompt) {
    parts.push('', '## 额外指令');
    parts.push(subst(task.prompt));
  }

  // 汇报书写规范（2026-11-17 老板定）：汇报原样发到老板的飞书，老板不是程序员。
  // 要求：命名好懂、确认事项与预期结果明确、少开发细节、少路径少符号、
  // 语气明确、分行分序号、不复述规则。
  parts.push('', '## 输出要求（这份汇报会原样发给老板；老板不是程序员）');
  parts.push('- 第一行写结论：做完了 / 需要批红 / 做不了，三选一。');
  parts.push('- 然后用 3~6 条要点说清：做了哪些事、结果怎样、核心思路是什么。每条独立一行，用 1. 2. 3. 编号。');
  parts.push('- 事项命名让人一看就懂：说「清理了过期日志」，不说「清理 src/tmp/*.log」。');
  parts.push('- 讲核心逻辑，不讲过程流水账：不列文件清单，不贴命令、代码、日志原文和长串路径。');
  parts.push('- 确有必要提到的技术名词或位置，用「」或（）框起来，整份汇报最多一两处。');
  parts.push('- 语言通俗通顺：请老板做事用祈使句，向老板提问用疑问句，说明情况用陈述句。');
  parts.push('- 需要老板确认的事，单独一行「需要你确认：」，写清要确认什么、批准后会发生什么。');
  parts.push('- 代码任务必须附 PR 链接（系统靠它走后续流程）；分支名、提交号这类细节不用写。');
  parts.push('- 不复述「必问清单」「止步 PR」这类规则条文，做到即可；需要批红时直接写「需要批红：具体事项」。');
  parts.push('- SOP 对产出格式另有规定的（如删除清单），按 SOP 来。');
  return parts.join('\n');
}
