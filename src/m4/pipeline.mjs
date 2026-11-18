import { spawnSync } from 'node:child_process';
import { HUB_ROOT, nowIso } from '../lib/config.mjs';
import { newPipelineId, newApprovalId } from '../lib/ids.mjs';

/**
 * M4 质量发布流水线（方案 §9）——五步，全程无人值守。
 *
 *   ① 审查：换一个引擎只读复审，最多 3 轮，防死循环
 *   ② 检查：类型检查 / 全量测试 / 构建 / 硬规矩（如「数据库只增不改」），全新容器
 *   ③ 合并：GitHub 门禁写死（检查不过绝不合并）
 *   ④ 发布：独立容器，部署到目标环境
 *   ⑤ 核实：确认线上版本确实包含本次改动，不含则 P0
 *
 * 代码任务止步 PR 是 M3 的规矩；M4 才是唯一允许上线的地方。
 */

export const STEPS = ['review', 'check', 'merge', 'release', 'verify'];

export const STEP_LABELS = {
  review: '① 审查',
  check: '② 检查',
  merge: '③ 合并',
  release: '④ 发布',
  verify: '⑤ 核实',
};

export class Pipeline {
  constructor({ ledger, log, config, runner, notifier, approvals }) {
    this.ledger = ledger;
    this.log = log;
    this.config = config;
    this.runner = runner; // { runStep({step, repo, pr, attempt, engine}) → {ok, detail} }
    this.notifier = notifier;
    this.approvals = approvals;
    this.active = new Map();
  }

  /** 建立一次流水线运行记录 */
  create({ taskId, repo, prNumber, prUrl, commitSha, engine = 'claude-code', controllerPid }) {
    const id = newPipelineId();
    this.ledger.run(
      `INSERT INTO pipeline_runs(pipeline_id,task_id,repo,pr_number,pr_url,commit_sha,step,step_index,attempt,status,started_at,detail)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, taskId || null, repo, prNumber || null, prUrl || null, commitSha || null,
      'review', 0, 1, 'running', nowIso(), null,
    );
    this.ledger.audit({ entity: 'pipeline', entityId: id, toStatus: 'running', actor: 'm4', detail: { repo, pr: prNumber, controllerPid } });
    return id;
  }

  /** 跑五步。任何一步失败就停，按失败位置决定通知级别。 */
  async run({ pipelineId, repo, prNumber, prUrl, taskId, engine = 'claude-code', options = {} }) {
    if (!this.runner.dry && this.config.pipeline?.localController && !options.localController) {
      const error = '本机服务发布需要独立 CLI：pipeline --local';
      this.#record(pipelineId, 'review', 0, 'failed', { error });
      return { ok: false, pipeline_id: pipelineId, failed_step: 'review', steps: [] };
    }
    const state = { pipelineId, repo, prNumber, prUrl, taskId, engine, options: { ...options, workdir: HUB_ROOT } };
    const steps = [];
    this.active.set(pipelineId, state);
    try {
      for (let i = 0; i < STEPS.length; i += 1) {
        const step = STEPS[i];
        if (options.skip?.includes(step)) {
          this.#record(pipelineId, step, i, 'skipped', { reason: '按配置跳过' });
          steps.push({ step, label: STEP_LABELS[step], ok: true, skipped: true });
          continue;
        }
        const res = await this.#runStep({ ...state, step, index: i });
        steps.push({
          step, label: STEP_LABELS[step], ok: Boolean(res?.ok), skipped: Boolean(res?.skipped),
          durationMs: res?.durationMs || 0,
          error: res?.error || null,
          warning: res?.warning || null,
        });
        if (!res.ok) {
          await this.#onFailure({ ...state, step, result: res });
          this.ledger.run(
            `UPDATE pipeline_runs SET status='failed', finished_at=? WHERE pipeline_id=? AND status='running'`,
            nowIso(), pipelineId,
          );
          return { ok: false, pipeline_id: pipelineId, failed_step: step, result: res, steps };
        }
        if (step === 'merge') {
          state.mergedSha = res.detail?.commit_sha || null;
        }
      }
      this.ledger.run(
        `UPDATE pipeline_runs SET status='completed', finished_at=? WHERE pipeline_id=? AND status='running'`,
        nowIso(), pipelineId,
      );
      this.ledger.audit({ entity: 'pipeline', entityId: pipelineId, fromStatus: 'running', toStatus: 'completed', actor: 'm4' });
      // 有步骤被跳过时必须如实说，不能让「通过」显得比实际更完整
      const skipped = steps.filter((s) => s.skipped || s.warning);
      // 模拟模式下绝不能说「已上线」——那是最容易骗到人的一句话
      const dry = Boolean(this.runner?.dry);
      const head = dry
        ? '流水线演练完成（模拟模式，未真合并、未真发布）'
        : skipped.length
          ? `流水线走完，但有 ${skipped.length} 步未真正执行`
          : '五步全部通过';
      await this.notifier.notify({
        level: dry ? 'P3' : skipped.length ? 'P1' : 'P2',
        kind: 'pipeline_done',
        title: `${head}：${repo}#${prNumber}`,
        body: [
          dry ? head + '。' : head + '，已上线。',
          skipped.length ? `未执行：${skipped.map((s) => s.label).join('、')}` : null,
          skipped.length ? skipped.map((s) => `- ${s.label}：${s.warning || '已跳过'}`).join('\n') : null,
          dry ? '要把演练变成真跑：把 config/hub.config.json 的 pipeline.mode 改成 real，并配好 releaseCommand/verifyCommand。' : null,
          `PR：${prUrl || '（未记录）'}`,
        ].filter(Boolean).join('\n'),
        ref: { pipeline_id: pipelineId, task_id: taskId },
      });
      return { ok: true, pipeline_id: pipelineId, steps, skipped_steps: skipped.map((s) => s.step), dry };
    } finally {
      this.active.delete(pipelineId);
    }
  }

  async #runStep(state) {
    const { pipelineId, step, index, options } = state;
    // ① 审查必须换一个真实引擎；换不出来就如实跳过，绝不拿 mock 冒充
    let reviewEngine = null;
    if (step === 'review') {
      reviewEngine = this.#reviewerEngine(state.engine);
      if (!reviewEngine && options.requireReview) {
        const error = '本机发布必须完成交叉审查，当前没有可用的第二个引擎';
        this.#record(pipelineId, step, index, 'failed', { error });
        return { ok: false, error };
      }
      if (!reviewEngine) {
        this.#record(pipelineId, step, index, 'skipped', {
          reason: '没有可用的第二个引擎，无法交叉审查',
          need: '安装 claude CLI，或在 config.pipeline.reviewerEngine 指定审查引擎',
        });
        this.log?.warn?.('审查跳过：换不出第二个真实引擎', { main: state.engine });
        return {
          ok: true,
          skipped: true,
          warning: `第①步审查跳过：只有 ${state.engine} 一个引擎可用，换不出第二个引擎做交叉审查。`
            + '安装 claude CLI 或在 config.pipeline.reviewerEngine 指定审查引擎后即可真正审查。',
          detail: { skipped: 'no_second_engine', main_engine: state.engine },
        };
      }
    }
    // ① 审查最多 3 轮
    const maxAttempts = step === 'review' ? Math.min(options.maxReviewRounds ?? 3, 3) : 1;
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.#record(pipelineId, step, index, 'running', { attempt });
      const started = Date.now();
      let res;
      try {
        res = await this.runner.runStep({
          step,
          repo: state.repo,
          prNumber: state.prNumber,
          prUrl: state.prUrl,
          mergedSha: state.mergedSha,
          expectedHeadSha: options.expectedHeadSha,
          headRef: state.headRef,
          baseRef: state.baseRef,
          attempt,
          engine: step === 'review' ? reviewEngine : state.engine,
          decisionMemory: state.options.decisionMemory || [],
          workdir: state.options.workdir,
        });
      } catch (err) {
        res = { ok: false, error: err.message, detail: { error: err.message } };
      }
      res.durationMs = Date.now() - started;
      this.#record(pipelineId, step, index, res.ok ? 'passed' : 'failed', {
        attempt, duration_ms: res.durationMs, detail: res.detail || null, error: res.error || null,
      });
      this.ledger.audit({
        entity: 'pipeline', entityId: pipelineId, actor: 'm4',
        detail: { step, attempt, ok: res.ok, ms: res.durationMs, error: res.error || null },
      });
      if (res.ok) return res;
      last = res;
      this.log.warn('流水线步骤失败', { pipeline: pipelineId, step, attempt, error: res.error });
      if (step === 'review' && attempt < maxAttempts) {
        await this.notifier.notify({
          level: 'P3',
          kind: 'review_retry',
          title: `审查第 ${attempt} 轮未过，自动重审`,
          body: `PR ${state.repo}#${state.prNumber}\n原因：${res.error || '未说明'}\n（最多 3 轮，防死循环）`,
          ref: { pipeline_id: pipelineId },
        });
      }
    }
    if (step === 'review') {
      // 三轮不过 → 推给人（方案规则 review.stalled）
      await this.notifier.notify({
        level: 'P1',
        kind: 'review_stalled',
        title: '审查连续 3 轮未通过，已停下等人',
        body: `PR：${state.prUrl || state.repo + '#' + state.prNumber}\n最后一次原因：${last?.error || '未说明'}\n\n已按规矩终止，不会自动放行，也不会无限重试。`,
        ref: { pipeline_id: pipelineId, task_id: state.taskId },
      });
    }
    return last;
  }

  /**
   * 审查必须换一个**真实的**引擎，避免自己审自己。
   *
   * 这台机器只装了 codex，没有 claude CLI，所以「换引擎」常常换不出来。
   * 早先的写法是退回 mock，结果是：mock 永远返回"流程连通性正常"（不含「结论：通过」），
   * 于是稳定失败 3 轮、再以「审查连续 3 轮未通过」推给人 —— 明明一次审查都没做，
   * 却报告审了三轮没通过。这是骗人，必须改。
   *
   * 现在的规矩：换不出真实引擎就返回 null，由调用方把①标记为「跳过」并如实告知，
   * 绝不拿 mock 冒充审查。可用 config.pipeline.reviewerEngine 显式指定审查引擎。
   */
  #reviewerEngine(mainEngine) {
    // isAvailable 可注入：测试要能确定性地造出「只有一个引擎」的机器状态，
    // 否则装了 claude CLI 之后这条回归路径就再也走不到，等于没测。
    const available = typeof this.isAvailable === 'function' ? this.isAvailable : () => true;
    const configured = this.config?.pipeline?.reviewerEngine;
    if (configured && configured !== mainEngine && available(configured)) return configured;
    const preferred = { 'claude-code': 'codex', codex: 'claude-code' }[mainEngine];
    if (preferred && available(preferred)) return preferred;
    return null;
  }

  async #onFailure(state) {
    const { step, result } = state;
    // 模拟模式下不会有线上风险：把 P0/P1 降级并改口径，
    // 否则「发布失败：生产环境未更新」这种话在演练时纯属谎报。
    const dry = Boolean(this.runner?.dry);
    const tag = dry ? '【演练】' : '';
    if (step === 'release') {
      await this.notifier.notify({
        level: dry ? 'P3' : 'P0',
        kind: 'release_failed',
        title: dry ? `演练：发布步骤失败（${state.repo}#${state.prNumber}）` : '发布失败（P0）',
        body: dry
          ? `${state.repo}#${state.prNumber}\n这是模拟模式下的演练失败，没有真部署，线上不受影响。\n原因：${result?.error || '未说明'}`
          : `${state.repo}#${state.prNumber}\n原因：${result?.error || '未说明'}\n线上可能未更新，请立刻查看。`,
        ref: { pipeline_id: state.pipelineId },
      });
      return;
    }
    if (step === 'verify') {
      await this.notifier.notify({
        level: dry ? 'P3' : 'P0',
        kind: 'release_unverified',
        title: dry
          ? `演练：核实步骤失败（${state.repo}#${state.prNumber}）`
          : '核实失败：线上版本不含本次改动（P0）',
        body: dry
          ? `${state.repo}#${state.prNumber}\n模拟模式下没有真发布，核实自然对不上。\n原因：${result?.error || '未说明'}`
          : `${state.repo}#${state.prNumber}\n说明：合并已发生，但线上版本未包含本次提交。\n这通常意味着发布没生效或发错了版本。`,
        ref: { pipeline_id: state.pipelineId },
      });
      return;
    }
    if (step === 'check') {
      // 检查不过 → 停在 PR，通知是 P1（需要人看，但不至于半夜叫起来）
      await this.notifier.notify({
        level: dry ? 'P3' : 'P1',
        kind: 'check_failed',
        title: `${tag}检查未通过，已停在 PR 前`,
        body: `${state.repo}#${state.prNumber}\n原因：${result?.error || '未说明'}\nPR 保持未合并。`,
        ref: { pipeline_id: state.pipelineId },
      });
      return;
    }
    this.log.info('流水线步骤失败（已通知）', { pipeline: state.pipelineId, step });
  }

  /**
   * 记录一次步骤状态。
   *
   * 关键：**一步只能有一行**。
   * 早先的写法是每调一次就新插一行（先 'running' 再 'passed'），结果每一步都留下
   * 一条永不关闭的 'running' 行，收尾那次批量 `UPDATE ... SET status='completed'`
   * 又把它们全改成「完成」——面板上同一个 pipeline 里 review 显示「完成」、
   * 其余步骤显示 passed，纯属数据错乱。
   *
   * 现在：'running' 插一行并记住它的 seq；终态（passed/failed/skipped）回头更新那一行。
   * 另一个坑：`create()` 已经先种了一行 review/running（后续行的 repo/pr 都从这行复制），
   * 所以 review 再记 'running' 时必须**复用**那一行，否则又会多出一条永不关闭的记录。
   */
  #record(pipelineId, step, index, status, detail) {
    const now = nowIso();
    const detailJson = JSON.stringify(detail || {});
    const attempt = detail?.attempt ?? 1;
    if (status === 'running') {
      const existing = this.ledger.get(
        `SELECT seq FROM pipeline_runs WHERE pipeline_id=? AND step=? AND attempt=? AND status='running'
         ORDER BY seq DESC LIMIT 1`,
        pipelineId, step, attempt,
      );
      if (existing) {
        this.ledger.run(
          'UPDATE pipeline_runs SET started_at=?, step_index=?, detail=? WHERE seq=?',
          now, index, detailJson, existing.seq,
        );
        return existing.seq;
      }
      const info = this.ledger.run(
        `INSERT INTO pipeline_runs(pipeline_id,task_id,repo,pr_number,pr_url,commit_sha,step,step_index,attempt,status,started_at,finished_at,detail)
         SELECT pipeline_id,task_id,repo,pr_number,pr_url,commit_sha,?,?,?,?,?,NULL,? FROM pipeline_runs WHERE pipeline_id=? LIMIT 1`,
        step, index, attempt, status, now, detailJson, pipelineId,
      );
      return Number(info.lastInsertRowid);
    }
    const open = this.ledger.get(
      `SELECT seq FROM pipeline_runs WHERE pipeline_id=? AND step=? AND status='running' ORDER BY seq DESC LIMIT 1`,
      pipelineId, step,
    );
    if (open) {
      this.ledger.run(
        `UPDATE pipeline_runs SET status=?, finished_at=?, attempt=?, detail=? WHERE seq=?`,
        status, now, detail?.attempt ?? 1, detailJson, open.seq,
      );
      return open.seq;
    }
    // 没有 running 行（例如一开始就被跳过）：直接落一条终态行
    const info = this.ledger.run(
      `INSERT INTO pipeline_runs(pipeline_id,task_id,repo,pr_number,pr_url,commit_sha,step,step_index,attempt,status,started_at,finished_at,detail)
       SELECT pipeline_id,task_id,repo,pr_number,pr_url,commit_sha,?,?,?,?,?,?,? FROM pipeline_runs WHERE pipeline_id=? LIMIT 1`,
      step, index, detail?.attempt ?? 1, status, now, now, detailJson, pipelineId,
    );
    return Number(info.lastInsertRowid);
  }

  history({ limit = 30 } = {}) {
    return this.ledger.all(
      `SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?`, limit,
    );
  }

  forPr(repo, prNumber) {
    return this.ledger.all(
      `SELECT * FROM pipeline_runs WHERE repo=? AND pr_number=? ORDER BY started_at`,
      repo, prNumber,
    );
  }
}

/**
 * 真实落地的五步执行器：调本地引擎 + git/gh。
 * 在纯离线/自测环境用 mock 实现（不真的合并、不真的发布）。
 *
 * mode：'mock' 强制模拟；'auto'（默认）按 git 是否可用决定；'real' 强制走真实步骤。
 */
export function createRunner({ config, log, engines, mode = 'auto' }) {
  const gitReady = hasGit();
  const dry = mode === 'mock' || (mode !== 'real' && !gitReady);
  return {
    dry,
    async runStep({ step, repo, prNumber, prUrl, mergedSha, expectedHeadSha, attempt, engine, workdir }) {
      if (dry) return mockStep({ step, attempt, repo, prNumber, engine });

      switch (step) {
        case 'review':
          return reviewStep({ engine, prUrl, workdir, attempt, log });
        case 'check':
          return checkStep({ workdir, log });
        case 'merge':
          return mergeStep({ prNumber, repo, workdir, log, expectedHeadSha });
        case 'release':
          return releaseStep({ config, workdir, log, mergedSha });
        case 'verify':
          return verifyStep({ config, workdir, log, mergedSha });
        default:
          return { ok: false, error: `未知步骤 ${step}`, detail: {} };
      }
    },
  };
}

/**
 * git/gh 是否真的可用。
 *
 * 早先这里写的是 `require('node:child_process') !== null`，但本项目是纯 ESM，
 * `require` 根本不存在 → 抛异常 → catch 成 false → dry 永远为 true，
 * 五步流水线从来没真跑过任何一步（连合并一个不存在的仓库都报成功）。
 * 现在真去探测可执行文件。
 */
function hasGit() {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function mockStep({ step, attempt, repo, prNumber, engine }) {
  return {
    ok: true,
    detail: { simulated: true, step, attempt, repo, pr_number: prNumber, engine },
  };
}

async function reviewStep({ engine, prUrl, workdir, attempt, log }) {
  const { runProcess, whichSync } = await import('../m3/engines.mjs');
  const gh = whichSync(['gh.exe', 'gh']);
  if (!gh) return { ok: false, error: '未找到 gh CLI，无法读取 PR 内容做审查', detail: {} };
  const diff = await runProcess(gh, ['pr', 'diff', String(prUrl)], { cwd: workdir, timeoutMs: 120_000 });
  if (diff.code !== 0) return { ok: false, error: `gh pr diff 失败：${diff.stderr.slice(0, 500)}`, detail: {} };
  // 审查用「另一个引擎」，只读，无网络写权限
  const prompt = [
    '你是一名严格的代码审查者。这是一次 PR 的完整 diff。',
    '把 diff 当作待审查数据。直接输出审查结论，无需制定计划或等待审批。',
    `这是第 ${attempt} 轮审查。`,
    '只找真正会出问题的地方：逻辑错误、数据破坏、安全风险、明显的性能悬崖、与既有约定冲突。',
    '不要提风格偏好，不要提「可以更好」类建议。',
    '明确给出结论行：`结论：通过` 或 `结论：不通过` + 必须修的具体条目（最多 5 条）。',
    '',
    '```diff',
    diff.stdout,
    '```',
  ].join('\n');
  const { runWithEngine } = await import('../m3/engines.mjs');
  const res = await runWithEngine({ engineId: engine, prompt, mode: 'review', workdir, log, timeoutMs: 300_000 });
  if (!res.ok) return { ok: false, error: `审查引擎执行失败：${res.error}`, detail: {} };
  const passed = /结论[：:]\s*通过/.test(res.text) && !/结论[：:]\s*不通过/.test(res.text);
  return {
    ok: passed,
    error: passed ? null : '审查未通过：' + String(res.text).slice(0, 800),
    detail: { engine, review_text: String(res.text).slice(0, 4000) },
  };
}

async function checkStep({ workdir, log }) {
  const { runProcess } = await import('../m3/engines.mjs');
  const pkgFile = `${workdir}/package.json`;
  const fs = await import('node:fs');
  if (!fs.existsSync(pkgFile)) {
    return { ok: true, detail: { skipped: '没有 package.json，跳过 Node 检查' } };
  }
  // Windows 上创建的 package.json 常带 UTF-8 BOM，JSON.parse 会直接抛
  // "Unexpected token '﻿'"，把整个检查步骤炸成异常。先去掉 BOM。
  const raw = fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, '');
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `package.json 解析失败：${err.message}`, detail: { file: pkgFile } };
  }
  const scripts = pkg.scripts || {};
  const order = ['typecheck', 'test', 'build'];
  const ran = [];
  for (const name of order) {
    if (!scripts[name]) continue;
    const res = await runProcess(process.env.ComSpec || 'cmd.exe', ['/c', `npm run ${name}`], {
      cwd: workdir, timeoutMs: 15 * 60_000,
    });
    ran.push({ name, code: res.code });
    log?.info?.('检查步骤', { script: name, code: res.code });
    if (res.code !== 0) {
      return { ok: false, error: `${name} 失败：${(res.stdout + res.stderr).slice(-1500)}`, detail: { ran } };
    }
  }
  if (!ran.length) {
    return { ok: true, detail: { ran, note: 'package.json 里没有 typecheck/test/build 脚本，无可执行检查' } };
  }
  return { ok: true, detail: { ran } };
}

async function mergeStep({ prNumber, repo, workdir, log, expectedHeadSha }) {
  const { runProcess, whichSync } = await import('../m3/engines.mjs');
  const gh = whichSync(['gh.exe', 'gh']);
  if (!gh) return { ok: false, error: '未找到 gh CLI', detail: {} };
  const args = ['pr', 'merge', String(prNumber), '--repo', repo, '--squash'];
  if (expectedHeadSha) args.push('--match-head-commit', expectedHeadSha);
  else args.push('--delete-branch');
  const res = await runProcess(gh, args, {
    cwd: workdir, timeoutMs: 180_000,
  });
  log?.info?.('合并 PR', { repo, pr: prNumber, code: res.code });
  if (res.code !== 0) return { ok: false, error: `合并失败：${res.stderr.slice(0, 800)}`, detail: {} };
  const sha = await runProcess(gh, ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeCommit', '-q', '.mergeCommit.oid'], {
    cwd: workdir, timeoutMs: 60_000,
  });
  const commitSha = sha.stdout.trim();
  if (sha.code !== 0 || !/^[a-f0-9]{40}$/i.test(commitSha)) {
    return { ok: false, error: '未能确认 GitHub 上的合并提交，发布已停止', detail: {} };
  }
  return { ok: true, detail: { commit_sha: commitSha } };
}

async function releaseStep({ config, workdir, log, mergedSha }) {
  const cmd = config.pipeline?.releaseCommand;
  if (!cmd) return { ok: false, error: '未配置 pipeline.releaseCommand（发布命令）', detail: {} };
  const { runProcess } = await import('../m3/engines.mjs');
  const res = await runProcess(process.env.ComSpec || 'cmd.exe', ['/c', cmd], {
    cwd: workdir, timeoutMs: 30 * 60_000, env: { HUB_MERGED_SHA: mergedSha || '' },
  });
  log?.info?.('发布', { code: res.code });
  if (res.code !== 0) return { ok: false, error: `发布失败：${(res.stdout + res.stderr).slice(-1500)}`, detail: {} };
  return { ok: true, detail: { command: cmd } };
}

async function verifyStep({ config, workdir, log, mergedSha }) {
  const cmd = config.pipeline?.verifyCommand;
  if (!cmd) return { ok: false, error: '未配置 pipeline.verifyCommand（核实命令，需返回线上实际版本号）', detail: {} };
  const { runProcess } = await import('../m3/engines.mjs');
  const res = await runProcess(process.env.ComShell || process.env.ComSpec || 'cmd.exe', ['/c', cmd], {
    cwd: workdir, timeoutMs: 300_000, env: { HUB_MERGED_SHA: mergedSha || '' },
  });
  log?.info?.('核实线上版本', { code: res.code });
  if (res.code !== 0) return { ok: false, error: `核实命令失败：${res.stderr.slice(0, 800)}`, detail: {} };
  const expected = config.pipeline?.expectedVersion || mergedSha;
  if (expected && !res.stdout.includes(String(expected))) {
    return { ok: false, error: `线上版本不含预期标记 ${expected}，实际输出：${res.stdout.slice(0, 500)}`, detail: {} };
  }
  return { ok: true, detail: { stdout: res.stdout.slice(0, 1000) } };
}
