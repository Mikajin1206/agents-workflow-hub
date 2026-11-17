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

/** 组装最终提示词：任务背景 + Skill 正文 + 决定记忆 + 指令模板 */
export function buildPrompt({ task, skill, decisions, envelope, payload, hubUrl, token }) {
  // SOP 里可以用 {{hub}} / {{token}} 占位（"调 GET {{hub}}/api/stats，带头 x-hub-token: {{token}}"）。
  // 不替换的话模型会收到字面占位符，要么去猜地址、要么直接放弃——
  // 实测 codex 因此输出了"做不了：无法确认 Hub 地址"。
  // {{token}} 是中台访问令牌（hub.secret）：中台配了真实密钥后 /api/* 全部 401，
  // 不注入的话日报这类要调 API 取数的 SOP 会在第一步就死掉（2026-11-17 战报实测）。
  // 未配密钥（或仍是默认开发值）时调用方传空，占位保持原样——无密钥模式接口本就不设防。
  const subst = (s) => {
    let out = String(s);
    if (hubUrl) out = out.replaceAll('{{hub}}', hubUrl);
    if (token) out = out.replaceAll('{{token}}', token);
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

  parts.push('', '## 输出要求');
  parts.push('- 第一行给结论（做完了 / 需要批红 / 做不了）。');
  parts.push('- 然后列 3~6 条要点：改了什么、跑了什么、结果如何。');
  parts.push('- 代码类任务必须给出分支名与 PR 链接（如果已开）。');
  parts.push('- 如果踩到必问清单（删数据/停服/花钱/对外发消息/改产品方向/密钥/权限），明确写「需要批红」并说明原因，不要擅自执行。');
  return parts.join('\n');
}
