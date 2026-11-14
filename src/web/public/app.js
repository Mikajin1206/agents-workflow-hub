/* 本地自动化 Agent 体系 · 控制台
   零依赖：原生 DOM + fetch。所有数据来自同一进程的 /api/*。 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'overview',
  snapshot: null,
  tasks: [],
  events: [],
  approvals: [],
  reports: [],
  decisions: [],
  rules: [],
  engines: [],
  skills: [],
  timers: [],
  nodes: [],
};

/* ─────────────── 小工具 ─────────────── */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isErr ? 'show err' : 'show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = ''), 2600);
}

// ── 访问令牌：中台设了 hub.secret 后，所有 /api 都要带 x-hub-token。
// 面板把令牌存在 localStorage；401 时弹输入框，存好自动重刷。
function hubToken() { return localStorage.getItem('hub_token') || ''; }

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  const tk = hubToken();
  if (tk) headers['x-hub-token'] = tk;
  const res = await fetch(path, {
    headers,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (res.status === 401 && path.startsWith('/api/')) askToken();
  if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  return data;
}

function askToken() {
  let box = document.querySelector('#token-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'token-box';
    box.style.cssText = 'position:fixed;inset:0;background:rgba(13,20,38,.55);display:flex;align-items:center;justify-content:center;z-index:999;';
    box.innerHTML = `
      <div style="background:var(--paper);border-radius:14px;padding:24px 26px;width:340px;box-shadow:0 18px 60px rgba(0,0,0,.35)">
        <div style="font-weight:700;margin-bottom:6px">需要访问令牌</div>
        <div style="color:var(--text-2);font-size:12.5px;line-height:1.6;margin-bottom:12px">中台已启用访问密钥（hub.secret）。令牌存在本机浏览器里，只发往本机中台。</div>
        <input id="token-input" type="password" placeholder="粘贴访问令牌" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--line);border-radius:8px;font-size:13px" />
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
          <button id="token-save" style="background:var(--teal);color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer">保存并刷新</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector('#token-save').addEventListener('click', () => {
      const v = box.querySelector('#token-input').value.trim();
      if (v) localStorage.setItem('hub_token', v);
      box.remove();
      loadAll();
    });
    box.querySelector('#token-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') box.querySelector('#token-save').click();
    });
  }
  box.style.display = 'flex';
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 11-14 13:40 */
function ago(iso) {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = Date.now() - t;
  if (d < 0) return clock(iso);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`;
  return clock(iso);
}

function clock(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dur(sec) {
  if (sec == null) return '-';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
  const h = Math.floor(sec / 3600);
  return `${h} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

/* ─────────────── 状态徽章 ─────────────── */

const STATUS_MAP = {
  received: ['已接收', 'idle'],
  duplicate: ['重复', 'idle'],
  routed: ['已路由', 'p2'],
  unrouted: ['待归类', 'warn'],
  queued: ['排队', 'idle'],
  leased: ['已派', 'run'],
  running: ['执行中', 'run'],
  awaiting_approval: ['待审批', 'p1'],
  deciding: ['待决策', 'p1'],
  approved: ['已批准', 'ok'],
  completed: ['完成', 'ok'],
  failed: ['失败', 'err'],
  rejected: ['已驳回', 'err'],
  dead_letter: ['死信', 'err'],
  pending: ['待审批', 'p1'],
  revising: ['调整中', 'warn'],
  executing: ['执行中', 'run'],
  executed: ['已完结', 'ok'],
  expired: ['已超时', 'warn'],
  cancelled: ['已撤销', 'idle'],
  active: ['生效', 'ok'],
  retired: ['已归档', 'idle'],
  success: ['通过', 'ok'],
  // 流水线步骤的终态就叫 passed（见 m4/pipeline.mjs 的 #record），需单独映射
  passed: ['通过', 'ok'],
  skipped: ['跳过', 'idle'],
  sent: ['已发', 'ok'],
  queued_n: ['待发', 'warn'],
  archived: ['归档', 'idle'],
};

function badge(status) {
  const [label, cls] = STATUS_MAP[status] || [status || '-', 'idle'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function prioBadge(p) {
  if (!p) return '<span class="muted">-</span>';
  return `<span class="badge ${String(p).toLowerCase()}">${esc(p)}</span>`;
}

function engineCell(t) {
  return `<span class="mono">${esc(t.engine || '-')}</span>`;
}

function emptyBox(text, icon = '☁') {
  return `<div class="empty"><div class="big">${icon}</div>${esc(text)}</div>`;
}

/* ─────────────── 表格渲染 ─────────────── */

function table(cols, rows, { onRow, empty = '暂无数据' } = {}) {
  if (!rows.length) return emptyBox(empty);
  const head = cols.map((c) => `<th${c.width ? ` style="width:${c.width}"` : ''}>${esc(c.label)}</th>`).join('');
  const body = rows
    .map((r, i) => {
      const tds = cols.map((c) => `<td class="${c.cls || ''}">${c.render ? c.render(r, i) : esc(r[c.key] ?? '-')}</td>`).join('');
      const clickable = onRow ? ' class="clickable" data-row="' + i + '"' : '';
      return `<tr${clickable}>${tds}</tr>`;
    })
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function bindRows(container, rows, onRow) {
  if (!onRow) return;
  $$('tr[data-row]', container).forEach((tr) => {
    tr.addEventListener('click', () => onRow(rows[Number(tr.dataset.row)]));
  });
}

/* ═══════════════ 数据加载 ═══════════════ */

async function loadSnapshot() {
  const snap = await api('/api/snapshot');
  state.snapshot = snap;
  $('#hubname').textContent = 'hub';
  $('#uptime').textContent = dur(snap.hub.uptime_seconds);
  $('#m-rules').textContent = snap.hub.rules;
  $('#m-skills').textContent = (snap.hub.skills || []).length;
  $('#m-feishu').textContent = snap.hub.feishu?.enabled ? '已配' : '本地';
  $('#n-approvals').textContent = snap.counters.approvals_pending || 0;
  state.engines = snap.hub.engines || [];
  state.skills = snap.hub.skills || [];
  state.timers = snap.hub.timers || [];
  return snap;
}

async function loadAll() {
  try {
    await loadSnapshot();
    const [ev, tk, ap, rp, dc, ru, pl, en, nt] = await Promise.all([
      api('/api/events?limit=80'),
      api('/api/tasks?limit=80'),
      api('/api/approvals?limit=40'),
      api('/api/reports?limit=40'),
      api('/api/decisions?limit=200'),
      api('/api/rules'),
      api('/api/pipeline?limit=30'),
      api('/api/engines'),
      api('/api/notifications?limit=60'),
    ]);
    state.notifications = nt.notifications || [];
    // 攒在聚合队列里的条数：>0 说明「有消息还没送到人手上」
    state.digestQueued = Number(nt.digest_queued || 0);
    state.events = ev.events || [];
    state.tasks = tk.tasks || [];
    state.approvals = ap.approvals || [];
    state.reports = rp.reports || [];
    state.decisions = dc.decisions || [];
    state.rules = ru.rules || [];
    // 节点在线状态：决定「某个引擎此刻真的有人能接」，没有它就会派出没人接的任务
    state.nodes = en.nodes || [];
    // 模拟/真实模式必须暴露到界面上，否则「流水线通过」会被误读成已上线
    state.pipelineMeta = {
      dry: Boolean(pl.dry),
      auto_start: Boolean(pl.auto_start),
      mode: pl.mode || 'auto',
      reviewer_engine: pl.reviewer_engine || null,
      release_configured: Boolean(pl.release_configured),
      verify_configured: Boolean(pl.verify_configured),
    };
    render();
  } catch (err) {
    toast(`加载失败：${err.message}`, true);
  }
}

/* ═══════════════ 各视图渲染 ═══════════════ */

function render() {
  renderOverview();
  renderApprovals();
  renderTasks();
  renderEvents();
  renderPipeline();
  renderReports();
  renderNotifications();
  renderDecisions();
  renderRules();
  renderEngines();
  renderDispatchOptions();
}

/* ── 总览 ── */

function renderOverview() {
  const s = state.snapshot;
  if (!s) return;
  const c = s.counters;
  const cards = [
    { k: '事件总数', v: c.events_total, sub: c.duplicates ? `重复 ${c.duplicates}` : '' },
    { k: '排队中', v: c.queued, sub: c.running ? `执行 ${c.running}` : '' },
    { k: '已完成', v: c.completed, sub: '' },
    { k: '失败', v: c.failed, sub: c.unrouted ? `待归类 ${c.unrouted}` : '', alert: false },
    { k: '待审批', v: c.approvals_pending, sub: `累计 ${c.approvals_total}`, alert: c.approvals_pending > 0 },
    { k: '决策记忆', v: c.decisions, sub: '条生效' },
    { k: '报告', v: c.reports, sub: '份归档' },
  ];
  $('#ov-cards').innerHTML = cards
    .map(
      (x) => `<div class="card${x.alert ? ' alert' : ''}">
        <div class="k">${esc(x.k)}</div>
        <div class="v">${esc(x.v)}${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</div>
      </div>`,
    )
    .join('');

  const warns = [];
  if (c.approvals_pending) warns.push(`<div class="notice warn"><span>✍</span><span>有 <b>${c.approvals_pending}</b> 个事项等待你审批，确认之前不会有任何默认动作。</span></div>`);
  if (c.failed) warns.push(`<div class="notice warn"><span>!</span><span>有 <b>${c.failed}</b> 个任务失败或进了死信，到「任务」页看细节并决定是否重试。</span></div>`);
  if (c.unrouted) warns.push(`<div class="notice info"><span>⇥</span><span>有 <b>${c.unrouted}</b> 条事件没有规则覆盖，在待归类队列里，可以考虑补一条规则。</span></div>`);
  if (!s.hub.feishu?.enabled) warns.push(`<div class="notice info"><span>✉</span><span>飞书未配置，P0/P1 通知走本地兜底（只打印到日志）。配好 <code>config/hub.config.json</code> 的 feishu 段即可切到真通道。</span></div>`);
  $('#ov-warn').innerHTML = warns.join('');

  const evBox = $('#ov-events');
  evBox.innerHTML = table(
    [
      { label: '时间', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.created_at))}</span>` },
      { label: '来源', width: '78px', render: (r) => `<span class="mono">${esc(r.source)}</span>` },
      { label: '类型', render: (r) => `<span class="mono">${esc(r.type)}</span>` },
      { label: '摘要', render: (r) => `<div class="trunc">${esc(r.summary || r.target || '-')}</div>` },
      { label: '级别', width: '72px', render: (r) => prioBadge(r.priority) },
      { label: '状态', width: '92px', render: (r) => badge(r.status) },
    ],
    (s.recent_events || []).slice(0, 8),
    { onRow: (r) => openEvent(r.event_id), empty: '还没有事件进来' },
  );
  bindRows(evBox, (s.recent_events || []).slice(0, 8), (r) => openEvent(r.event_id));

  const tkBox = $('#ov-tasks');
  const rows = (s.recent_tasks || []).slice(0, 8);
  tkBox.innerHTML = table(
    [
      { label: '时间', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.created_at))}</span>` },
      { label: '标题', render: (r) => `<div class="trunc">${esc(r.title || r.task_id)}</div>` },
      { label: '节点·引擎', width: '150px', render: (r) => `<span class="mono">${esc(r.node)} · ${esc(r.engine)}</span>` },
      { label: '技能', width: '120px', render: (r) => `<span class="mono">${esc(r.skill || '-')}</span>` },
      { label: '状态', width: '92px', render: (r) => badge(r.status) },
    ],
    rows,
    { empty: '还没有任务', onRow: (r) => openTask(r.task_id) },
  );
  bindRows(tkBox, rows, (r) => openTask(r.task_id));
}

/* ── 审批 ── */

function renderApprovals() {
  const pending = state.approvals.filter((a) => ['pending', 'revising'].includes(a.status));
  const box = $('#ap-pending');

  if (!pending.length) {
    box.innerHTML = `<div class="panel"><div class="body">${emptyBox('暂无待审批事项。清单之外的动作系统会自动完成并留痕。', '✓')}</div></div>`;
  } else {
    box.innerHTML = pending.map(renderApprovalCard).join('');
    $$('[data-decide]', box).forEach((btn) => {
      btn.addEventListener('click', () => decideApproval(btn.dataset.id, btn.dataset.decide));
    });
    $$('[data-revise]', box).forEach((btn) => {
      btn.addEventListener('click', () => reviseApproval(btn.dataset.id));
    });
  }

  const history = state.approvals.filter((a) => !['pending', 'revising'].includes(a.status));
  const hBox = $('#ap-history');
  hBox.innerHTML = table(
    [
      { label: '时间', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.created_at))}</span>` },
      { label: '事项', render: (r) => `<div class="trunc">${esc(r.title)}</div>` },
      { label: '分类', width: '120px', render: (r) => `<span class="mono">${esc(r.category || '-')}</span>` },
      { label: '状态', width: '92px', render: (r) => badge(r.status) },
      { label: '审批人', width: '90px', render: (r) => esc(r.decided_by || '-') },
      { label: '决定时间', width: '116px', render: (r) => `<span class="muted">${esc(r.decided_at ? clock(r.decided_at) : '-')}</span>` },
    ],
    history,
    { empty: '还没有历史审批' },
  );
}

function renderApprovalCard(a) {
  const high = String(a.category || '').match(/delete_data|stop_service|secret_rotate|permissions/);
  const due = a.due_at ? `超时提醒时间 ${clock(a.due_at)}` : '';
  return `<div class="approval${high ? ' high' : ''}">
    <div class="ah">
      ${badge(a.status)}
      <span class="t">${esc(a.title)}</span>
      <span class="spacer" style="flex:1"></span>
      <span class="muted" style="font-size:12px">${esc(a.category || '')} · ${esc(ago(a.created_at))}</span>
    </div>
    <div class="q">${esc(a.question || '')}</div>
    ${a.proposal ? `<div class="p">${esc(a.proposal)}</div>` : ''}
    <div class="acts">
      <button class="btn primary sm" data-decide="agree" data-id="${esc(a.approval_id)}">批准</button>
      <button class="btn danger sm" data-decide="reject" data-id="${esc(a.approval_id)}">驳回</button>
      <button class="btn sm" data-revise="1" data-id="${esc(a.approval_id)}">改派 / 改方案</button>
      <span class="muted" style="font-size:12px">${esc(due)}</span>
    </div>
    <div class="foot">审批单 ${esc(a.approval_id)}${a.task_id ? ` · 任务 ${esc(a.task_id)}` : ''}${a.event_id ? ` · 事件 ${esc(a.event_id)}` : ''}</div>
  </div>`;
}

async function decideApproval(id, decision) {
  const labels = { agree: '批准', reject: '驳回', revise: '改派' };
  let note = '';
  if (decision !== 'agree') {
    note = prompt(`${labels[decision]}：给一句理由（会写入决策记忆）`, '') ?? '';
    if (note === null) return;
  }
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      body: { decision, note, by: 'panel' },
    });
    toast(`已${labels[decision]}`);
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function reviseApproval(id) {
  const proposal = prompt('新的方案是什么？', '');
  if (proposal === null) return;
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}/resubmit`, {
      method: 'POST',
      body: { proposal, by: 'panel' },
    });
    toast('已重新提交，回到待审批');
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ── 任务 ── */

function renderTasks() {
  const filter = $('#task-filter')?.value || '';
  const rows = filter ? state.tasks.filter((t) => t.status === filter) : state.tasks;
  const box = $('#tasks-table');
  box.innerHTML = table(
    [
      { label: '创建', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.created_at))}</span>` },
      { label: '标题', render: (r) => `<div class="trunc">${esc(r.title || '-')}</div>` },
      { label: '事件类型', width: '140px', render: (r) => `<span class="mono">${esc(r.envelope_type || '-')}</span>` },
      { label: '节点·引擎', width: '146px', render: (r) => `<span class="mono">${esc(r.node)} · ${esc(r.engine)}</span>` },
      { label: '技能', width: '120px', render: (r) => `<span class="mono">${esc(r.skill || '-')}</span>` },
      { label: '级别', width: '72px', render: (r) => prioBadge(r.priority) },
      { label: '尝试', width: '56px', render: (r) => `<span class="muted">${esc(r.attempts || 0)}/${esc(r.max_attempts || 1)}</span>` },
      { label: '状态', width: '92px', render: (r) => badge(r.status) },
    ],
    rows,
    { empty: filter ? '该状态下没有任务' : '还没有任务', onRow: (r) => openTask(r.task_id) },
  );
  bindRows(box, rows, (r) => openTask(r.task_id));
}

/* ── 事件 ── */

function renderEvents() {
  const box = $('#events-table');
  box.innerHTML = table(
    [
      { label: '时间', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.created_at))}</span>` },
      { label: '来源', width: '76px', render: (r) => `<span class="mono">${esc(r.source)}</span>` },
      { label: '类型', width: '160px', render: (r) => `<span class="mono">${esc(r.type)}</span>` },
      { label: '摘要', render: (r) => `<div class="trunc">${esc(r.summary || '-')}</div>` },
      { label: '规则', width: '120px', render: (r) => `<span class="mono">${esc(r.rule_id || '-')}</span>` },
      { label: '级别', width: '72px', render: (r) => prioBadge(r.priority) },
      { label: '状态', width: '92px', render: (r) => badge(r.status) },
    ],
    state.events,
    { empty: '还没有事件进来' },
  );
  bindRows(box, state.events, (r) => openEvent(r.event_id));
}

/* ── 流水线 ── */

/**
 * 把 pipeline_runs.detail 的 JSON 摘成人话。
 * 直接显示原始 JSON 既看不清也说不出重点；这里按常见键挑关键的几句。
 */
function stepDetail(s) {
  let d = s.detail;
  if (!d) return '';
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return d.slice(0, 160); }
  }
  if (!d || typeof d !== 'object') return String(d).slice(0, 160);
  if (d.simulated) return '演练，未真执行';
  const bits = [];
  if (d.reason) bits.push(d.reason);
  if (d.error) bits.push(d.error);
  if (d.duration_ms != null) bits.push(`${d.duration_ms}ms`);
  else if (s.status === 'passed' && s.finished_at && s.started_at) {
    const ms = new Date(s.finished_at) - new Date(s.started_at);
    if (ms >= 0) bits.push(`${ms}ms`);
  }
  if (d.stdout) bits.push(`输出 ${String(d.stdout).trim().slice(0, 60)}`);
  if (d.ran && Array.isArray(d.ran)) bits.push(`跑了 ${d.ran.join('/')}`);
  if (d.commit_sha) bits.push(`合并 ${String(d.commit_sha).slice(0, 8)}`);
  if (d.note) bits.push(d.note);
  return bits.join(' · ').slice(0, 160);
}

function renderPipeline() {
  const runs = state.snapshot?.pipeline || [];
  const box = $('#pl-list');
  // 顶部横幅：是否为模拟模式、是否会自动启动。这两个必须一眼看见，
  // 否则「流水线通过」会让人误以为真上线了。
  const meta = state.pipelineMeta;
  let banner = '';
  if (meta) {
    const isDry = meta.dry;
    banner = `<div class="banner ${isDry ? 'warn' : 'ok'}">
      <b>${isDry ? '模拟模式' : '真实模式'}</b> · ${isDry
        ? '五步全部是演练，不合并、不发布。改 config/hub.config.json 的 pipeline.mode 为 real 才会真跑。'
        : '五步会真的合并 PR、执行发布命令。'}
      ${meta.auto_start ? ' · 代码任务开出 PR 后会自动进入流水线。' : ' · 自动启动已关闭，只能从这里手动触发。'}
      ${meta.reviewer_engine ? ` · 审查引擎指定为 ${esc(meta.reviewer_engine)}。` : ''}
      ${!meta.release_configured || !meta.verify_configured
        ? ' · <b>发布/核实命令未配置</b>，真跑时④⑤会如实报错。' : ''}
    </div>`;
  }
  if (!runs.length) {
    box.innerHTML = `${banner}<div class="panel"><div class="body">${emptyBox('还没有流水线记录。代码任务在开出 PR 后会自动进入 M4：审查 → 检查 → 合并 → 发布 → 核实。也可以在下面手动触发一次。', '⛓')}</div></div>`;
    return;
  }
  // 按 pipeline_id 分组
  const groups = new Map();
  for (const r of runs) {
    if (!groups.has(r.pipeline_id)) groups.set(r.pipeline_id, []);
    groups.get(r.pipeline_id).push(r);
  }
  box.innerHTML = banner + [...groups.entries()]
    .map(([id, stepsRaw]) => {
      const order = ['review', 'check', 'merge', 'release', 'verify'];
      // history() 是 started_at DESC，组内顺序是倒的；按 step_index 正排回来，
      // 否则「最新一步」会取成 review，顶部徽章永远显示第一步的状态。
      const steps = [...stepsRaw].sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
      // 同一步可能有多轮尝试（如审查 3 轮上限）；只看最新一次（attempt/seq 最大），
      // 否则「第 1 轮拦下、第 2 轮通过」的流水线会被永远标成失败。
      const byStep = {};
      for (const s of steps) {
        const prev = byStep[s.step];
        if (!prev || Number(s.attempt ?? 0) >= Number(prev.attempt ?? 0)) byStep[s.step] = s;
      }
      const latest = order.map((k) => byStep[k]).filter(Boolean);
      const anyFail = latest.some((s) => s.status === 'failed');
      const anyRun = latest.some((s) => s.status === 'running');
      const allSkipped = latest.length > 0 && latest.every((s) => s.status === 'skipped');
      const anySkip = latest.some((s) => s.status === 'skipped');
      // 整条流水线的结论：有失败→失败；还在跑→执行中；全跳过→跳过；否则取最后一步
      const overall = anyFail ? 'failed' : anyRun ? 'running' : allSkipped ? 'skipped' : (latest[latest.length - 1]?.status || 'idle');
      const skipCount = latest.filter((s) => s.status === 'skipped').length;
      const items = order
        .map((k) => {
          const s = byStep[k];
          if (!s) return `<li><div class="tt muted">${esc(k)}</div><div class="ts">未执行</div></li>`;
          const cls = s.status === 'failed' ? 'bad' : s.status === 'running' ? 'run' : s.status === 'skipped' ? 'skip' : 'done';
          const detail = stepDetail(s);
          return `<li class="${cls}"><div class="tt">${esc(k)} ${badge(s.status)}</div>
            <div class="ts">${esc(clock(s.started_at))}${s.finished_at ? ` → ${esc(clock(s.finished_at))}` : ''} ${detail ? '· ' + esc(detail) : ''}</div></li>`;
        })
        .join('');
      return `<div class="panel">
        <header>
          <span class="mono">${esc(id)}</span>
          <span class="spacer"></span>
          ${anyFail
            ? '<span class="badge err">有环节失败</span>'
            : anyRun
              ? badge('running')
              : anySkip
                ? `<span class="badge warn">${skipCount === latest.length ? '全部未执行' : `${skipCount} 步未执行`}</span>`
                : badge(overall)}
        </header>
        <div class="body">
          <ul class="timeline">${items}</ul>
          <div class="muted" style="font-size:12px;margin-top:8px">
            ${steps[0]?.repo ? `仓库 ${esc(steps[0].repo)}` : ''} ${steps[0]?.pr_number ? `· PR #${esc(steps[0].pr_number)}` : ''}
          </div>
        </div>
      </div>`;
    })
    .join('');
}

/* ── 报告 ── */

function renderReports() {
  const box = $('#reports-table');
  box.innerHTML = table(
    [
      { label: '时间', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.created_at))}</span>` },
      { label: '标题', render: (r) => `<div class="trunc">${esc(r.title)}</div>` },
      { label: '类别', width: '130px', render: (r) => `<span class="mono">${esc(r.kind || '-')}</span>` },
      { label: '任务', width: '180px', render: (r) => `<span class="mono trunc">${esc(r.task_id || '-')}</span>` },
    ],
    state.reports,
    { empty: '还没有报告' },
  );
  bindRows(box, state.reports, (r) => openReport(r.report_id));
}

async function openReport(id) {
  try {
    const res = await api(`/api/reports/${encodeURIComponent(id)}`);
    const rep = res.report;
    $('#rd-title').textContent = rep.title || '报告';
    $('#rd-body').textContent = rep.body || '（内容为空，文件可能已被移动）';
    $('#report-detail').style.display = '';
    $('#report-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message, true);
  }
}

/* ── 通知流水 ── */

function renderNotifications() {
  const banner = $('#notify-banner');
  const q = state.digestQueued || 0;
  if (q > 0) {
    banner.innerHTML = `<div class="banner warn">还有 <b>${q}</b> 条 P2 通知攒在聚合队列里，等下一次日报一起送出（每天 07:30）。不想等可以手动派发一条 <code>cron.daily-report</code>。</div>`;
  } else {
    banner.innerHTML = '<div class="banner ok">聚合队列已清空，没有滞留在半路的通知。</div>';
  }
  const box = $('#notify-table');
  box.innerHTML = table(
    [
      { label: '时间', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.created_at))}</span>` },
      { label: '级别', width: '74px', render: (r) => prioBadge(r.level) },
      { label: '标题', render: (r) => `<div class="trunc">${esc(r.title || '-')}</div>` },
      { label: '类别', width: '124px', render: (r) => `<span class="mono trunc">${esc(r.kind || '-')}</span>` },
      { label: '通道', width: '96px', render: (r) => `<span class="mono">${esc(r.channel || '-')}</span>` },
      { label: '状态', width: '96px', render: (r) => badge(r.status) },
      { label: '送达', width: '116px', render: (r) => `<span class="muted nowrap">${r.sent_at ? esc(clock(r.sent_at)) : '未送达'}</span>` },
    ],
    state.notifications,
    { empty: '还没有任何通知' },
  );
  bindRows(box, state.notifications, (r) => {
    toast(`${r.title || r.notification_id}\n\n${(r.body || '').slice(0, 400)}`);
  });
}

/* ── 决策记忆 ── */

function renderDecisions() {
  const box = $('#decisions-table');
  $('#dc-count').textContent = `${state.decisions.length} 条`;
  box.innerHTML = table(
    [
      { label: '类型', width: '110px', render: (r) => (r.kind === 'refused' ? '<span class="badge err">不做</span>' : '<span class="badge ok">已决定</span>') },
      { label: '内容', render: (r) => `<div>${esc(r.text)}</div>${r.quote && r.quote !== r.text ? `<div class="muted" style="font-size:12px;margin-top:3px">原话：${esc(r.quote)}</div>` : ''}` },
      { label: '记录人', width: '92px', render: (r) => `<span class="mono">${esc(r.decided_by || '-')}</span>` },
      { label: '时间', width: '116px', render: (r) => `<span class="muted nowrap">${esc(clock(r.decided_at))}</span>` },
      { label: '状态', width: '80px', render: (r) => badge(r.active ? 'active' : 'retired') },
    ],
    state.decisions,
    { empty: '还没有记录。这里的每一条都会注入之后派发的任务。' },
  );
}

/* ── 规则 ── */

function renderRules() {
  const box = $('#rules-table');
  box.innerHTML = table(
    [
      { label: '序号', width: '56px', render: (r) => `<span class="muted">${esc(r.order ?? '-')}</span>` },
      { label: '规则', width: '180px', render: (r) => `<span class="mono">${esc(r.id)}</span>` },
      { label: '说明', render: (r) => `<div class="trunc">${esc(r.title || '-')}</div>` },
      {
        label: '匹配',
        width: '230px',
        render: (r) => {
          const m = r.match || {};
          return `<span class="mono">${esc(m.source || '*')} / ${esc(m.type || '*')}</span>`;
        },
      },
      {
        label: '派给',
        width: '160px',
        render: (r) => {
          if (r.action === 'notify') return '<span class="badge p1">直接通知</span>';
          return `<span class="mono">${esc(r.route?.node || 'any')} · ${esc(r.route?.engine || '-')}</span>`;
        },
      },
      { label: '技能', width: '122px', render: (r) => `<span class="mono">${esc(r.skill || '-')}</span>` },
      {
        label: '并发',
        width: '96px',
        render: (r) => `<span class="muted">${esc(r.limits?.per_key ?? 1)} / ${esc(r.limits?.max_parallel ?? 3)}</span>`,
      },
      {
        label: '审批',
        width: '78px',
        render: (r) => (r.approval === 'always' || r.action === 'notify' ? '<span class="badge warn">需审批</span>' : '<span class="muted">-</span>'),
      },
      {
        label: '定时',
        width: '110px',
        render: (r) => {
          const s = r.schedule ?? r.raw?.schedule;
          const cron = typeof s === 'string' ? s : s?.cron;
          return cron ? `<span class="mono">${esc(cron)}</span>` : '<span class="muted">-</span>';
        },
      },
    ],
    state.rules,
    { empty: '规则文件为空或解析失败' },
  );

  const tBox = $('#timers-table');
  tBox.innerHTML = table(
    [
      { label: '名称', width: '160px', render: (r) => esc(r.name || r.id) },
      { label: '类型', width: '180px', render: (r) => `<span class="mono">${esc(r.type || '-')}</span>` },
      { label: 'cron', width: '120px', render: (r) => `<span class="mono">${esc(r.cron)}</span>` },
      { label: '下次', render: (r) => `<span class="muted">${esc(r.next_local || r.next || '-')}</span>` },
    ],
    state.timers,
    { empty: '没有定时器' },
  );
}

/* ── 引擎/技能 ── */

function renderEngines() {
  // 「装没装」和「此刻有没有节点能跑」是两件事：codex 装好了，但一个声明 codex
  // 的节点都没起，这时候派 codex 任务只会排队到饥饿告警。两列都要显示。
  const nodes = state.nodes || [];
  const onlineFor = (id) => nodes.filter((n) => n.online && (n.engines || []).includes(id));

  const box = $('#engines-table');
  box.innerHTML = table(
    [
      { label: '引擎', width: '140px', render: (r) => `<span class="mono">${esc(r.id)}</span>` },
      { label: '说明', render: (r) => esc(r.describe || '-') },
      {
        label: '可用',
        width: '92px',
        render: (r) => (r.available ? '<span class="badge ok">可用</span>' : '<span class="badge idle">未安装</span>'),
      },
      {
        label: '在线的执行节点',
        width: '170px',
        render: (r) => {
          if (!r.available) return '<span class="muted">—</span>';
          const on = onlineFor(r.id);
          if (!on.length) return '<span class="badge warn">没有节点能跑</span>';
          return on.map((n) => `<span class="badge ok" style="margin-right:3px">${esc(n.id)}</span>`).join('');
        },
      },
    ],
    state.engines,
    { empty: '没有引擎' },
  );

  // 谁在线一览：没有这一块，人根本不知道「我起了几个节点、它们分别能跑什么」
  const nBox = $('#nodes-table');
  if (nBox) {
    nBox.innerHTML = nodes.length
      ? table(
        [
          { label: '节点', width: '130px', render: (r) => `<span class="mono">${esc(r.id)}</span>` },
          {
            label: '状态',
            width: '100px',
            render: (r) => (r.online ? '<span class="badge ok">在线</span>' : '<span class="badge idle">离线</span>'),
          },
          {
            label: '声明的引擎',
            render: (r) => (r.engines || []).map((e) => `<span class="badge idle" style="margin-right:3px">${esc(e)}</span>`).join('') || '<span class="muted">-</span>',
          },
          { label: '最近露面', width: '110px', render: (r) => `<span class="muted">${esc(r.idle_seconds)} 秒前</span>` },
        ],
        nodes,
      )
      : `<div class="empty"><div class="empty-ico">⌁</div><div>还没有节点连上来。起一个：<code class="mono">node src/m3/worker.mjs --node win-a --engines claude-code,codex,mock</code></div></div>`;
  }

  const sBox = $('#skills-table');
  sBox.innerHTML = table(
    [
      { label: '技能', width: '150px', render: (r) => `<span class="mono">${esc(r.name)}</span>` },
      { label: '标题', width: '190px', render: (r) => esc(r.title || r.meta?.title || '-') },
      { label: '说明', render: (r) => `<div class="trunc">${esc(r.description || r.meta?.description || '-')}</div>` },
      {
        label: '标签',
        width: '190px',
        render: (r) => {
          const raw = r.tags ?? r.meta?.tags ?? [];
          const arr = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
          return arr.map((t) => `<span class="badge idle" style="margin-right:3px">${esc(t)}</span>`).join('') || '<span class="muted">-</span>';
        },
      },
    ],
    state.skills,
    { empty: '技能库为空' },
  );

  const st = $('#st-engine');
  if (st && !st.options.length) {
    st.innerHTML = state.engines.map((e) => `<option value="${esc(e.id)}"${e.id === 'mock' ? ' selected' : ''}>${esc(e.id)}${e.available ? '' : '（未安装）'}</option>`).join('');
  }
}

/* ── 派发 ── */

function renderDispatchOptions() {
  const e = $('#dp-engine');
  if (e && !e.options.length) {
    e.innerHTML = state.engines
      .map((x) => `<option value="${esc(x.id)}"${x.id === 'codex' ? ' selected' : ''}>${esc(x.id)}${x.available ? '' : '（未安装）'}</option>`)
      .join('');
  }
  const s = $('#dp-skill');
  if (s && s.options.length <= 1) {
    s.innerHTML = '<option value="">不装技能</option>' + state.skills.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}${x.title ? ` · ${esc(x.title)}` : ''}</option>`).join('');
  }
}

/* ═══════════════ 抽屉详情 ═══════════════ */

function openDrawer(title, html) {
  $('#drawer-title').textContent = title;
  $('#drawer-content').innerHTML = html;
  $('#drawer-wrap').classList.add('open');
}

function closeDrawer() {
  $('#drawer-wrap').classList.remove('open');
}

async function openEvent(eventId) {
  try {
    const res = await api(`/api/events/${encodeURIComponent(eventId)}`);
    const { event, tasks, approvals, runs, audit } = res;
    const html = `
      <div class="panel">
        <header>事件</header>
        <div class="body">
          ${row('ID', `<span class="mono">${esc(event.event_id)}</span>`)}
          ${row('来源 / 类型', `<span class="mono">${esc(event.source)} / ${esc(event.type)}</span>`)}
          ${row('目标', esc(event.target || '-'))}
          ${row('摘要', esc(event.summary || '-'))}
          ${row('级别', prioBadge(event.priority))}
          ${row('状态', badge(event.status))}
          ${row('规则', `<span class="mono">${esc(event.rule_id || '未命中')}</span>`)}
          ${row('去重键', `<span class="mono">${esc(event.dedupe_key || '-')}</span>`)}
          ${row('链接', event.link ? `<a href="${esc(event.link)}" target="_blank" rel="noreferrer">${esc(event.link)}</a>` : '-')}
          ${row('创建时间', esc(event.created_at))}
        </div>
      </div>
      ${Object.keys(event.payload || {}).length ? `<div class="panel"><header>参数</header><div class="body"><pre class="log">${esc(JSON.stringify(event.payload, null, 2))}</pre></div></div>` : ''}
      ${tasks.length ? `<div class="panel"><header>任务</header><div class="body flush">${table(
        [
          { label: '任务', render: (t) => `<span class="mono">${esc(t.task_id)}</span>` },
          { label: '节点·引擎', render: (t) => `<span class="mono">${esc(t.node)} · ${esc(t.engine)}</span>` },
          { label: '状态', width: '90px', render: (t) => badge(t.status) },
        ],
        tasks,
        {},
      )}</div></div>` : ''}
      ${approvals.length ? `<div class="panel"><header>审批</header><div class="body flush">${table(
        [
          { label: '事项', render: (a) => esc(a.title) },
          { label: '状态', width: '90px', render: (a) => badge(a.status) },
        ],
        approvals,
        {},
      )}</div></div>` : ''}
      ${runs.length ? `<div class="panel"><header>执行记录</header><div class="body flush">${table(
        [
          { label: '节点', width: '80px', render: (r) => `<span class="mono">${esc(r.node)}</span>` },
          { label: '引擎', width: '100px', render: (r) => `<span class="mono">${esc(r.engine)}</span>` },
          { label: '状态', width: '86px', render: (r) => badge(r.status) },
          { label: '退出码', width: '70px', render: (r) => `<span class="mono">${esc(r.exit_code ?? '-')}</span>` },
        ],
        runs,
        {},
      )}</div></div>` : ''}
      ${audit.length ? `<div class="panel"><header>操作留痕</header><div class="body"><ul class="timeline">${audit
        .map((a) => `<li class="done"><div class="tt">${esc(a.from_status || '·')} → ${esc(a.to_status || '·')} <span class="muted">${esc(a.actor || '')}</span></div><div class="ts">${esc(a.created_at)}</div></li>`)
        .join('')}</ul></div></div>` : ''}
    `;
    openDrawer('事件详情', html);
  } catch (err) {
    toast(err.message, true);
  }
}

async function openTask(taskId) {
  try {
    const res = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    const t = res.task;
    let meta = {};
    let result = {};
    try { meta = JSON.parse(t.meta || '{}'); } catch { /* ignore */ }
    try { result = t.result ? JSON.parse(t.result) : {}; } catch { /* ignore */ }
    const html = `
      <div class="panel">
        <header>任务</header>
        <div class="body">
          ${row('ID', `<span class="mono">${esc(t.task_id)}</span>`)}
          ${row('标题', esc(t.title || '-'))}
          ${row('状态', badge(t.status))}
          ${row('节点 · 引擎', `<span class="mono">${esc(t.node)} · ${esc(t.engine)}${t.model ? ' · ' + esc(t.model) : ''}</span>`)}
          ${row('技能', `<span class="mono">${esc(t.skill || '-')}</span>`)}
          ${row('优先级', prioBadge(t.priority))}
          ${row('尝试', `${esc(t.attempts || 0)} / ${esc(t.max_attempts || 1)}`)}
          ${row('工作目录', `<span class="mono">${esc(t.workdir || '-')}</span>`)}
          ${row('创建 → 完成', `<span class="muted">${esc(clock(t.created_at))} → ${esc(t.finished_at ? clock(t.finished_at) : '未完成')}</span>`)}
          ${t.error ? row('错误', `<span style="color:var(--err)">${esc(t.error)}</span>`) : ''}
        </div>
      </div>
      ${t.status === 'failed' || t.status === 'dead_letter' ? `<div class="panel"><div class="body"><button class="btn primary sm" id="btn-retry">重试这个任务</button></div></div>` : ''}
      ${t.prompt ? `<div class="panel"><header>最终提示词</header><div class="body"><pre class="log">${esc(t.prompt)}</pre></div></div>` : ''}
      ${result.text ? `<div class="panel"><header>执行输出</header><div class="body"><pre class="log">${esc(result.text)}</pre></div></div>` : ''}
      ${res.runs?.length ? `<div class="panel"><header>执行记录</header><div class="body flush">${table(
        [
          { label: '节点', width: '78px', render: (r) => `<span class="mono">${esc(r.node)}</span>` },
          { label: '状态', width: '86px', render: (r) => badge(r.status) },
          { label: '退出码', width: '70px', render: (r) => `<span class="mono">${esc(r.exit_code ?? '-')}</span>` },
          { label: '开始', width: '116px', render: (r) => `<span class="muted">${esc(clock(r.started_at))}</span>` },
        ],
        res.runs,
        {},
      )}</div></div>` : ''}
    `;
    openDrawer('任务详情', html);
    const retry = $('#btn-retry');
    if (retry) {
      retry.addEventListener('click', async () => {
        try {
          await api(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST', body: {} });
          toast('已重新排队');
          closeDrawer();
          await loadAll();
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function row(k, v) {
  return `<div style="display:flex;gap:14px;padding:6px 0;border-bottom:1px solid var(--line-2)">
    <div class="muted" style="width:104px;flex-shrink:0;font-size:12.5px">${esc(k)}</div>
    <div style="flex:1;min-width:0;word-break:break-word">${v}</div>
  </div>`;
}

/* ═══════════════ 交互绑定 ═══════════════ */

function switchView(name) {
  state.view = name;
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $('#main').scrollTop = 0;
  location.hash = name;
}

function bind() {
  $$('.nav button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#btn-refresh').addEventListener('click', () => { toast('刷新中'); loadAll(); });
  $('#task-filter').addEventListener('change', renderTasks);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-wrap').addEventListener('click', (e) => { if (e.target.id === 'drawer-wrap') closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // 手动触发流水线：自动启动关闭时这是唯一入口
  $('#pl-run').addEventListener('click', async () => {
    const repo = $('#pl-repo').value.trim();
    const pr = $('#pl-pr').value.trim();
    if (!repo || !pr) return toast('仓库和 PR 编号都要填', true);
    const btn = $('#pl-run');
    btn.disabled = true;
    try {
      const r = await api('/api/pipeline', {
        method: 'POST',
        body: { repo, pr_number: Number(pr), engine: $('#pl-engine').value.trim() || 'codex' },
      });
      toast(`已开始：${r.pipeline_id}`);
      // 五步要跑几分钟，先让用户看到它已经进了队列
      setTimeout(loadAll, 1500);
      setTimeout(loadAll, 6000);
    } catch (e) {
      toast(`触发失败：${e.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('#dc-save').addEventListener('click', async () => {
    const text = $('#dc-text').value.trim();
    if (!text) return toast('先写内容', true);
    try {
      await api('/api/decisions', {
        method: 'POST',
        body: { kind: $('#dc-kind').value, text, quote: $('#dc-quote').value.trim() || text, by: 'panel' },
      });
      $('#dc-text').value = '';
      $('#dc-quote').value = '';
      toast('已保存');
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#dp-submit').addEventListener('click', async () => {
    const body = {
      engine: $('#dp-engine').value,
      node: $('#dp-node').value,
      priority: $('#dp-priority').value,
      skill: $('#dp-skill').value || null,
      summary: $('#dp-summary').value.trim() || '手动派发',
      prompt: $('#dp-prompt').value.trim(),
      workdir: $('#dp-workdir').value.trim() || null,
      type: 'cmd.manual',
    };
    if (!body.prompt) return toast('指令不能为空', true);
    try {
      const res = await api('/api/dispatch', { method: 'POST', body });
      toast(`已派发 ${res.task_id || ''}`);
      $('#dp-summary').value = '';
      $('#dp-prompt').value = '';
      await loadAll();
      switchView('tasks');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#st-run').addEventListener('click', async () => {
    try {
      const res = await api('/api/selftest', { method: 'POST', body: { engine: $('#st-engine').value } });
      toast(`自检任务已派出 ${res.task_id || ''}`);
      await loadAll();
      switchView('tasks');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ═══════════════ 启动 ═══════════════ */

bind();
const initial = (location.hash || '').replace('#', '');
if (initial && $(`#view-${initial}`)) switchView(initial);
loadAll();
setInterval(() => { if (!document.hidden) loadAll(); }, 8000);
