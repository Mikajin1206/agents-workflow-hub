import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HUB_ROOT } from '../lib/config.mjs';

/**
 * M3 引擎适配层（方案 §6）。
 *
 * 设计要点：
 *  - 引擎 = 可替换的外部 CLI，统一被包装成 run({prompt, workdir, model, mode}) → {ok, text, exitCode, logPath}
 *  - 代码任务一律「止步 PR」：引擎提示词里写死不许 push 到主干、不许部署。
 *  - mock 引擎用于端到端自测与断网演练，不依赖任何外部 CLI。
 */

const COMMON_RULES = [
  '你是一台 7×24 运行的自动化执行节点上的一次性工人，没有人实时盯着你。',
  '规则：',
  '1) 不询问、不等待，缺信息就按最保守的方式推进，并在结果里写清假设。',
  '2) 代码类任务止步于「提交 + 开 PR」，绝不直接合并到主干、绝不部署上线。',
  '3) 不删数据、不停服、不花钱、不对外发消息、不改权限——遇到这类事停下来，写明「需要批红」并说明原因。',
  '   例外（2026-11-17 定）：清理过程/tmp 文件（临时文件、缓存、构建产物等）不算删数据——'
  + '把它们移进仓库根的 tmp/ 目录留存，并在 docs/删除记录.md 里登记「日期、原路径、去向、原因」，可回滚即可；'
  + '数据库、配置、代码、文档等真实数据的删除仍必须批红。',
  '4) 完成后用一句话结论 + 3~6 条要点输出，不要贴大段日志。',
  '5) 一切操作要留下可复查的痕迹（改了哪些文件、跑了什么命令、结果如何）。',
].join('\n');

/* ───────────────────────── Claude Code ───────────────────────── */

/**
 * claude 干活模式的权限档位。
 * - 'bypassPermissions'：全放开，能改文件、跑命令、git 写。
 * - 'acceptEdits'：只自动接受文件编辑，跑命令仍需人工批准 → 在 headless 下等于半残。
 * 默认 bypass，理由见 buildArgs 里的注释；可用 HUB_CLAUDE_PERMISSION_MODE 覆盖。
 */
let CLAUDE_PERMISSION_MODE = process.env.HUB_CLAUDE_PERMISSION_MODE || 'bypassPermissions';

export function setClaudePermissionMode(mode) {
  if (mode) CLAUDE_PERMISSION_MODE = String(mode);
}

const claudeEngine = {
  id: 'claude-code',
  describe: 'Claude Code CLI（主力开发，多轮工具调用）',
  available() {
    return whichSync(['claude.cmd', 'claude', 'claude.exe']) !== null;
  },
  buildArgs({ prompt, workdir, model, mode }) {
    const args = ['-p', '--output-format', 'json'];
    if (prompt !== undefined) args.splice(1, 0, prompt);
    if (model) args.push('--model', model);
    if (mode === 'review') {
      args.push('--tools', '', '--no-session-persistence');
    } else if (mode === 'readonly') {
      // 审查/只读：plan 模式，只能看不能动——这是刻意的，审查不应改代码。
      args.push('--permission-mode', 'plan');
    } else {
      // 干活模式必须显式放开权限。
      //
      // 踩过的坑：`claude -p` 非交互运行时，任何「需要批准」的工具调用（改文件、
      // 跑 npm/node、git 写操作）都被自动拒绝，模型只在最终文本里报告
      // 「做不了：所有写操作 requires approval 且无人批准」。任务状态却是
      // completed、exit_code 0 —— **看起来成功，实际一行都没改**。
      // 不显式给 bypassPermissions，这个引擎在非交互场景下完全没有动手能力。
      //
      // 放手的边界不在 CLI 沙箱，而在本系统自己的护栏：提示词里的五条铁律
      // + M5 必问清单（删数据/停服/花钱/对外发消息/改方向/密钥/权限必须票拟）
      // + M4 五步流水线的独立审查与门禁。
      args.push('--permission-mode', CLAUDE_PERMISSION_MODE);
    }
    return args;
  },
  bin: () => whichSync(['claude.cmd', 'claude', 'claude.exe']),
};

/* ───────────────────────── Codex ───────────────────────── */

/**
 * codex 沙箱策略：默认 bypass。
 * 设为 '0' 或 'native' 可切回 codex 原生沙箱（Windows 上会大面积 block）。
 * 启动时由 setCodexSandboxPolicy() 按 config.engines.codexSandbox 覆盖。
 */
let CODEX_BYPASS_SANDBOX = process.env.HUB_CODEX_NO_SANDBOX !== '0';

export function setCodexSandboxPolicy(mode) {
  CODEX_BYPASS_SANDBOX = String(mode || 'bypass') !== 'native'
    && process.env.HUB_CODEX_NO_SANDBOX !== '0';
}

const codexEngine = {
  id: 'codex',
  describe: 'Codex CLI（运维/日报/查 BUG，exec 非交互模式）',
  available() {
    return whichSync(['codex.cmd', 'codex', 'codex.exe']) !== null;
  },
  buildArgs({ prompt, workdir, model, mode, outputFile, sandbox }) {
    // --ignore-user-config：不加载 ~/.codex/config.toml（auth 仍走 CODEX_HOME）。
    // 必需，因为用户桌面版的 config 里挂着 mcp_servers.node_repl（常驻子进程）
    // 和 notify 钩子（指向 Codex Desktop exe），exec 跑完 turn 后这两者不释放，
    // 进程永远不退出——实测 45s/90s 都超时，但输出其实早就写完了。
    const args = ['exec', '--skip-git-repo-check', '--ignore-user-config', '--color', 'never'];
    if (workdir) args.push('--cd', workdir);
    if (model) args.push('-m', model);
    // Windows 上 codex 的沙箱会把 powershell/sh 一律判为 "blocked by policy"，
    // 连 `Get-Location` 这种只读命令都拒（实测 workspace-write / read-only 都一样），
    // 结果模型拿不到任何事实，只能回"做不了"。
    // 折中：出格行为由**本系统**把控（引擎提示词里的五条铁律 + M5 白名单票拟），
    // 默认不让 codex 自己的沙箱把命令全卡死。
    // 想切回严格沙箱：HUB_CODEX_NO_SANDBOX=0 或配置 engines.codexSandbox='native'。
    const noSandbox = mode === 'unsafe' || sandbox === 'bypass' || CODEX_BYPASS_SANDBOX;
    if (noSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      const sb = sandbox || (mode === 'review' || mode === 'readonly' ? 'read-only' : 'workspace-write');
      args.push('--sandbox', sb);
    }
    if (outputFile) args.push('-o', outputFile);
    args.push(prompt ?? '-');
    return args;
  },
  bin: () => whichSync(['codex.cmd', 'codex', 'codex.exe']),
};

/* ───────────────────────── mock（自测/演练） ───────────────────────── */

const mockEngine = {
  id: 'mock',
  describe: '离线假引擎：按任务类型返回可预期的结构化结果，用于端到端自测',
  available: () => true,
  async run({ prompt, task, log }) {
    const started = Date.now();
    const kind = task?.meta?.envelope?.type || 'unknown';
    const behave = task?.meta?.payload?.mock || {};
    const delay = Math.min(Number(behave.delay_ms ?? 30), 10_000);
    await new Promise((r) => setTimeout(r, delay));
    if (behave.fail) {
      return {
        ok: false,
        exitCode: 1,
        text: '',
        error: behave.fail_reason || 'mock 引擎按剧本失败',
        durationMs: Date.now() - started,
      };
    }
    const text = behave.text
      || [
        `【mock 结果】任务类型 ${kind}`,
        `- 已完成 ${task?.skill || '未指定 skill'} 的模拟执行`,
        `- 提示词长度 ${String(prompt || '').length} 字符`,
        '- 结论：流程连通性正常',
        '- 未产生真实副作用',
      ].join('\n');
    log?.debug?.('mock 引擎执行完成', { task: task?.task_id, delay });
    return { ok: true, exitCode: 0, text, durationMs: Date.now() - started };
  },
};

/* ───────────────────────── shell（逃生通道，仅测试） ───────────────────────── */

const shellEngine = {
  id: 'shell',
  describe: '直接跑一条命令（仅用于本机测试与运维脚本，不接外部输入）',
  available: () => process.platform === 'win32',
  async run({ task, log }) {
    const cmd = task?.meta?.payload?.mock?.command;
    if (!cmd) return { ok: false, exitCode: 1, text: '', error: 'shell 引擎缺少 command' };
    log?.warn?.('shell 引擎执行命令', { command: cmd });
    return runProcess(process.env.ComSpec || 'cmd.exe', ['/c', cmd], { timeoutMs: 60_000, onLog: log?.debug });
  },
};

/* ───────────────────────── 统一执行入口 ───────────────────────── */

export function getEngine(id) {
  switch (String(id || '').toLowerCase()) {
    case 'claude-code':
    case 'claude':
      return claudeEngine;
    case 'codex':
      return codexEngine;
    case 'mock':
      return mockEngine;
    case 'shell':
      return shellEngine;
    default:
      return null;
  }
}

export function listEngines() {
  return [claudeEngine, codexEngine, mockEngine, shellEngine].map((e) => ({
    id: e.id,
    describe: e.describe,
    available: safeAvailable(e),
  }));
}

function safeAvailable(e) {
  try { return e.available(); } catch { return false; }
}

/**
 * 业务代号 → 真实模型名。
 *
 * 方案里给 codex 起了 sol / terra 两个角色代号（"Sol 管运维日报、Terra 管浏览器"），
 * 那是**分工代号**，不是模型 id。直接把 terra 传给 codex 会报
 * "The 'terra' model is not supported when using Codex with a ChatGPT account"，
 * 任务重试到死信。这里做一层映射：认不出来的代号一律不传 -m，让 codex 用默认模型。
 */
const MODEL_ALIASES = {
  terra: null,   // null = 用 codex 默认模型（ChatGPT 账号可用的那个）
  sol: null,
  opus: null,
  'opus-high': null,
};

function resolveModel(engineId, model) {
  if (!model) return undefined;
  if (engineId !== 'codex') return model;
  const key = String(model).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, key)) {
    return MODEL_ALIASES[key] || undefined;
  }
  return model;
}

/**
 * 执行一次任务。返回 {ok, exitCode, text, error, durationMs, logPath, engine}
 *
 * redact：需要打码的秘密（字符串或数组，通常是中台访问令牌）。
 * 引擎会把派活提示词回显进自己的 stdout（提示词转储），而提示词里有注入的真实令牌——
 * 2026-11-18 发现它明文落进了 engine-*.log。引擎日志落盘前、以及回传中台的
 * stdout/stderr/error，都过 redactSecrets 打一层码。
 */
export async function runWithEngine({ engineId, prompt, task, workdir, model, mode = 'work', log, logDir, timeoutMs, redact }) {
  const engine = getEngine(engineId);
  if (!engine) {
    return { ok: false, exitCode: 127, text: '', error: `未知引擎：${engineId}`, engine: engineId };
  }
  const started = Date.now();
  const finalPrompt = `${COMMON_RULES}\n\n${prompt}`;
  model = resolveModel(engineId, model);
  const mask = (s) => redactSecrets(s, redact);

  if (typeof engine.run === 'function') {
    const res = await engine.run({ prompt: finalPrompt, task, workdir, model, mode, log });
    return { ...res, engine: engine.id, durationMs: res.durationMs ?? Date.now() - started };
  }

  const bin = engine.bin();
  if (!bin) {
    return {
      ok: false, exitCode: 127, text: '',
      error: `引擎 ${engine.id} 的 CLI 不在 PATH 中（未安装或未配置）；可先用 mock 引擎跑通链路`,
      engine: engine.id, durationMs: Date.now() - started,
    };
  }

  // logDir 兜底到系统临时目录，绝不能是 '.' —— 否则每次直接调用 runWithEngine
  // （调试、脚本、单测）都会在仓库根目录留下一堆 engine-*.log 垃圾文件。
  const scratchDir = logDir || path.join(os.tmpdir(), 'agents-workflow-engine-logs');
  const outputFile = path.join(scratchDir, `last-message-${task?.task_id || Date.now()}.txt`);
  const args = engine.buildArgs({ workdir, model, mode, outputFile });
  const logPath = path.join(scratchDir, `engine-${task?.task_id || Date.now()}.log`);
  const res = await runProcess(bin, args, {
    cwd: workdir,
    input: finalPrompt,
    timeoutMs: timeoutMs ?? (task?.meta?.limits?.timeout_seconds ? task.meta.limits.timeout_seconds * 1000 : 900_000),
    logPath,
    onLog: log?.debug,
    env: engine.id === 'codex' ? codexIsolatedEnv() : undefined,
    redact: mask,
  });

  let text = '';
  if (fs.existsSync(outputFile)) {
    try { text = fs.readFileSync(outputFile, 'utf8').trim(); } catch { /* ignore */ }
    try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  }
  if (!text) text = extractTextFromStdout(engine.id, res.stdout);
  return {
    ok: res.code === 0,
    exitCode: res.code,
    text: mask(text),
    stdout: truncate(mask(res.stdout), 20_000),
    stderr: truncate(mask(res.stderr), 8_000),
    error: res.code === 0 ? null : mask(res.stderr || res.stdout || `退出码 ${res.code}`).slice(0, 2000),
    durationMs: Date.now() - started,
    logPath,
    engine: engine.id,
  };
}

/**
 * 秘密打码：把字符串里出现的真实令牌替换成「【已打码】」。
 * 只处理长度 ≥ 8 的秘密，避免短字符串把正文误伤成大片占位符；
 * 秘密为空（本地无密钥模式）时原样返回。
 */
export function redactSecrets(s, secrets) {
  let out = String(s ?? '');
  for (const sec of Array.isArray(secrets) ? secrets : [secrets]) {
    const v = String(sec || '');
    if (v.length >= 8) out = out.split(v).join('【已打码】');
  }
  return out;
}

function extractTextFromStdout(engineId, stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return '';
  if (engineId === 'codex') {
    // codex --json 是 JSONL；非 json 模式则是纯文本
    const lines = raw.split('\n').filter(Boolean);
    const texts = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.item?.type === 'agent_message' && obj.item?.text) texts.push(obj.item.text);
        else if (obj.type === 'agent_message' && obj.text) texts.push(obj.text);
        else if (obj.msg?.type === 'agent_message' && obj.msg?.message) texts.push(obj.msg.message);
      } catch {
        texts.push(line);
      }
    }
    return texts.join('\n').trim() || raw;
  }
  if (engineId === 'claude-code') {
    try {
      const obj = JSON.parse(raw);
      if (obj.result) return String(obj.result);
      if (obj.message?.content) {
        return obj.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      }
    } catch { /* 继续用原文 */ }
  }
  return raw;
}

/* ───────────────────────── 进程工具 ───────────────────────── */

/**
 * 把 npm 生成的 .cmd 包装脚本解析成 ["node", ["<entry>.js"]]。
 *
 * 为什么不直接 spawn codex.cmd：
 *   1. Node 20.12+ 禁止无 shell 执行 .cmd（CVE-2024-27980），会抛 EINVAL；
 *   2. 套 cmd.exe 后，中文提示词会经过 cmd 的代码页转换，实测 codex 收到乱码后
 *      卡住不返回（英文 prompt 正常）。
 * npm 的 .cmd 永远是 `"<node>" "<entry>.js" %*` 这种形状，直接读出 node 与 js 路径，
 * 用 node 起子进程，既没有引号地狱也没有代码页问题。
 */
function resolveNpmShim(cmdPath) {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(cmdPath)) return null;
  try {
    const text = fs.readFileSync(cmdPath, 'utf8');
    // npm 的 shim 有两种形状：
    //   a) "%_prog%"  "<node_modules>/x/bin/y.js"  %*      ← 纯 JS 包（codex 是这样）
    //   b) "%dp0%\node_modules\<pkg>\bin\z.exe"    %*      ← 自带二进制的包（claude-code 是这样）
    // 两种都必须解析出来。解析失败就会落到 cmd.exe /c（见下），而 cmd.exe 把
    // 含换行的参数当成命令分隔符 —— 一个多行中文提示词会被砍到只剩第一行。
    const js = text.match(/"%_prog%"\s+"([^"]+\.js)"/);
    if (js) {
      const entry = js[1].replace(/^%dp0%\\?/i, path.dirname(cmdPath) + path.sep)
        .replace(/%dp0%/gi, path.dirname(cmdPath));
      if (!fs.existsSync(entry)) return null;
      return { bin: process.execPath, prefix: [entry] };
    }
    const exe = text.match(/"([^"]+\.exe)"\s+%?\*?/i);
    if (exe) {
      const target = exe[1].replace(/^%dp0%\\?/i, path.dirname(cmdPath) + path.sep)
        .replace(/%dp0%/gi, path.dirname(cmdPath));
      if (!fs.existsSync(target)) return null;
      return { bin: target, prefix: [] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 给 codex 一个隔离的 CODEX_HOME。
 *
 * 用户桌面版 ~/.codex/config.toml 里挂着 mcp_servers（node_repl 常驻子进程 +
 * 远程 codex MCP），`codex exec` 跑完 turn 后这些连接不释放，进程挂着不退出，
 * 表现为任务永远停在 running。`--ignore-user-config` 挡不住内置的远程 MCP。
 *
 * 隔离目录里只放 auth.json 的副本（登录态），不复制 config.toml，
 * 于是 codex 用纯默认配置跑 exec：无 MCP、无 notify、无 plugins。
 * 目录放在 data/ 下，随台账一起备份/清理。
 */
function codexIsolatedEnv() {
  try {
    const realHome = process.env.CODEX_HOME
      || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.codex');
    const authSrc = path.join(realHome, 'auth.json');
    if (!fs.existsSync(authSrc)) return undefined;
    const iso = path.join(HUB_ROOT, 'data', 'codex-home');
    fs.mkdirSync(iso, { recursive: true });
    const authDst = path.join(iso, 'auth.json');
    // 每次都覆盖：token 会刷新，拷旧的会 401
    fs.copyFileSync(authSrc, authDst);
    // 只写最小 config.toml，显式关掉可能拖住进程的东西
    fs.writeFileSync(path.join(iso, 'config.toml'), [
      '# 由 agents-workflow 自动生成：无人值守批处理用的最小配置',
      'suppress_unstable_features_warning = true',
      '[mcp_servers]',
      '',
    ].join('\n'), 'utf8');
    return { CODEX_HOME: iso };
  } catch {
    return undefined;
  }
}

export function whichSync(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const name of names) {
    const hasExt = path.extname(name) !== '';
    for (const dir of dirs) {
      for (const ext of hasExt ? [''] : exts) {
        const p = path.join(dir, name + ext);
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
        } catch { /* ignore */ }
      }
    }
  }
  return null;
}

/**
 * 给 cmd.exe 拼命令行时用的引号。
 * 只在「一个参数里含空白」这种确有必要时加，且不处理 \\ 转义
 * （cmd.exe 不认那套，那是 CreateProcess/argv 的规则）。
 */
function quoteWin(s) {
  const str = String(s);
  return /[\s"&|<>^()]/.test(str) ? `"${str}"` : str;
}

export function runProcess(bin, args, { cwd, timeoutMs = 900_000, logPath, onLog, env, input, redact } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stream = null;
    // 日志落盘前打码（redact 是 (s) => string；未传就是原样写）。
    // 按 chunk 打码有一个理论残留：一个秘密恰好跨两个 chunk 被切开就打不掉，
    // 实际 chunk ≥ 64KB、令牌只出现一次，概率可忽略；resolve 前还会对累积全文再打一遍。
    const mask = typeof redact === 'function' ? redact : ((s) => s);
    if (logPath) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        stream = fs.createWriteStream(logPath, { flags: 'a' });
      } catch { stream = null; }
    }
    // Windows 上 .cmd/.bat 不能裸 spawn（CVE-2024-27980 之后 Node 会抛 EINVAL）。
    // 首选：把 npm 的 .cmd shim 解析成 node + js 入口，直接起 node；
    // 兜底：套一层 cmd.exe /c（会受 cmd 代码页影响，中文提示词可能乱码）。
    const shim = resolveNpmShim(bin);
    const isBatch = !shim && process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const spawnBin = shim ? shim.bin : (isBatch ? (process.env.ComSpec || 'cmd.exe') : bin);
    /**
     * 传给 cmd.exe 的 /c 命令不要再整体加引号。
     *
     * 教训：早先用 args.map(quote) 整体包引号 + windowsVerbatimArguments:false，
     * 结果是 `node -e "console.log(123)"` 被 Node 再转义一次，cmd 拼出来的命令行
     * 指向一个不存在的程序 —— 表现是「退出码 0，stdout 完全为空」，
     * 极难和「命令成功但没有输出」区分。实测 verbatim:true 才正常。
     *
     * 所以：cmd.exe 分支一律 verbatim，且命令串原样传（调用方已给出完整命令行）。
     */
    const viaCmd = !shim && (isBatch || /(^|[\\/])cmd(\.exe)?$/i.test(spawnBin));
    let spawnArgs;
    if (shim) {
      spawnArgs = [...shim.prefix, ...args];
    } else if (isBatch) {
      // .cmd/.bat：拼成 `"<路径>.cmd" 参数…`，再交给 cmd.exe /c
      spawnArgs = ['/d', '/s', '/c', `${quoteWin(bin)} ${args.map(quoteWin).join(' ')}`];
    } else if (viaCmd) {
      // 调用方已经按 cmd 语法给好参数（通常是 ['/c', '<完整命令串>']）。
      // 去掉 /d /s 之外的东西不再加工：verbatim 模式下 cmd.exe 自己解析。
      // cmd.exe 把换行当命令分隔符：一个多行提示词会静默截断成第一行，
      // 表现成「模型说没收到任务」。这类假故障值得显式报错，而不是悄悄跑。
      const bad = args.find((a) => typeof a === 'string' && /[\r\n]/.test(a));
      if (bad !== undefined) {
        resolve({
          code: 1,
          stdout: '',
          stderr: 'runProcess: 经 cmd.exe 传递的参数不能含换行（cmd 会把它当命令分隔符）',
          timedOut: false,
        });
        return;
      }
      spawnArgs = args;
    } else {
      spawnArgs = args;
    }
    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      windowsVerbatimArguments: viaCmd,
      shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (child.stdin) {
      // 子进程提前退出时，写入管道可能失败。退出状态和 stderr 仍由进程事件处理。
      child.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') stderr += `\nstdin: ${err.message}`;
      });
      child.stdin.end(input, 'utf8');
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on('data', (buf) => {
      const s = buf.toString();
      stdout += s;
      stream?.write(mask(s));
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (buf) => {
      const s = buf.toString();
      stderr += s;
      stream?.write(mask(s));
      if (stderr.length > 500_000) stderr = stderr.slice(-250_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      onLog?.('子进程启动失败', { bin, error: err.message });
      stream?.end();
      resolve({ code: 127, stdout: mask(stdout), stderr: mask(stderr) + '\n' + err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stream?.end();
      onLog?.('子进程结束', { bin, code, timedOut });
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout: mask(stdout), stderr: mask(stderr), timedOut });
    });
  });
}

function truncate(s, n) {
  const v = String(s || '');
  return v.length > n ? v.slice(0, n) + `\n…（已截断，共 ${v.length} 字符）` : v;
}

// resolveNpmShim 是内部实现，但它的两种 shim 形状（.js / .exe）值得被测试钉住：
// 只认 .js 时 claude-code 会落到 cmd.exe，多行提示词被截断成第一行（真实踩过）。
export { COMMON_RULES, resolveNpmShim };
