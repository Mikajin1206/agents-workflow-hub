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
  /* 运行时长走本地时钟：每 8 秒一次的快照会让数字停住不动，
     看起来像坏了。这里只记服务端给的那一刻，之后自己每秒往上走。 */
  uptimeAt: 0,
  uptimeBase: null,
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
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
    // 校验类错误带着逐条原因，调用方要能拿到全部错误而不是只看第一条
    err.bodyText = text;
    err.errors = data?.errors || null;
    throw err;
  }
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

/** 用服务端快照做基准，本地每秒补差值 —— 快照之间数字也在走 */
function paintUptime() {
  const el = $('#uptime');
  if (!el || state.uptimeBase == null) return;
  const drift = Math.max(0, (Date.now() - state.uptimeAt) / 1000);
  el.textContent = dur(state.uptimeBase + drift);
}

async function loadSnapshot() {
  const snap = await api('/api/snapshot');
  state.snapshot = snap;
  $('#hubname').textContent = 'hub';
  state.uptimeBase = snap.hub.uptime_seconds;
  state.uptimeAt = Date.now();
  paintUptime();
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
      {
        label: '说明',
        render: (r) => `<div class="trunc">${esc(r.title || '-')}${r.enabled === false ? ' <span class="badge idle">已停用</span>' : ''}</div>`,
      },
      {
        label: '匹配',
        width: '230px',
        render: (r) => {
          const m = r.match || {};
          const extra = m.payload ? ` · ${Object.entries(m.payload).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
          return `<span class="mono">${esc(m.source || '*')} / ${esc(m.type || '*')}</span><span class="mono-xs">${esc(extra)}</span>`;
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
    { onRow: (r) => openRuleEditor(r), empty: '规则文件为空或解析失败' },
  );
  bindRows(box, state.rules, (r) => openRuleEditor(r));

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

/* ── 规则编辑器 ──────────────────────────────────────────────
   一条规则有三段：什么时候触发（match）/ 派给谁（route）/ 怎么执行（skill+limits+approval）。
   表单按这三段分组，每个字段都是下拉或带默认值的输入框 —— 手打 `github.pull_request`
   这种字符串最容易拼错一个下划线，而拼错后规则会安静地永远匹配不上。 */

let ruleCatalog = null;
let editingRule = null;

async function ensureCatalog() {
  if (ruleCatalog) return ruleCatalog;
  try {
    ruleCatalog = await api('/api/rules/catalog');
  } catch (err) {
    // 拿不到目录不致命：退化成「只用当前规则里已有的值」的降级界面
    ruleCatalog = { sources: [], event_types: [], priorities: [], approval_modes: [], actions: [], cron_presets: [], engines: [], nodes: [], skills: [] };
  }
  return ruleCatalog;
}

function opt(value, label, selected, hint) {
  return `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}${hint ? '' : ''}</option>`;
}

/** 下拉：把目录里的候选拼成 option，并保证当前值一定在列表里（否则显示空白） */
function selectHtml(id, options, current, { allowEmpty = null } = {}) {
  const list = [...options];
  if (allowEmpty !== null) list.unshift({ value: '', label: allowEmpty });
  const has = list.some((o) => String(o.value) === String(current ?? ''));
  const extra = !has && current ? [{ value: current, label: `${current}（已不在目录里）` }] : [];
  const opts = [...list, ...extra]
    .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(current ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
  return `<select id="${id}">${opts}</select>`;
}

async function openRuleEditor(rule) {
  const cat = await ensureCatalog();
  editingRule = rule ? JSON.parse(JSON.stringify(rule)) : null;
  const r = editingRule || {
    title: '', order: (Math.max(...state.rules.map((x) => Number(x.order) || 0), 0) || 0) + 10,
    priority: 'P2', match: { source: '*', type: '' }, route: { node: 'any', engine: '' },
    skill: '', limits: { per_key: 1, max_parallel: 3, attempts: 2, timeout_seconds: 1800 },
    approval: false, silent: true, action: 'dispatch',
  };
  const m = r.match || {};
  const rt = r.route || {};
  const lim = r.limits || {};
  const sched = r.schedule || null;
  const cronVal = typeof sched === 'string' ? sched : (sched?.cron || '');
  const presetHit = cat.cron_presets.some((p) => p.value === cronVal);
  const isNotify = r.action === 'notify';

  $('#rule-title').textContent = editingRule ? '编辑规则' : '新建规则';
  $('#rule-id').textContent = editingRule ? editingRule.id : '(保存后自动生成 ID)';
  $('#rule-delete').style.display = editingRule ? '' : 'none';
  $('#rule-err').textContent = '';

  const typeOpts = cat.event_types.map((t) => ({ value: t.value, label: `${t.label} · ${t.value}` }));
  const engineOpts = cat.engines.map((e) => ({ value: e.id, label: `${e.id}${e.available ? '' : '（未安装）'}` }));
  const skillOpts = cat.skills.map((s) => ({ value: s.name, label: `${s.title} · ${s.name}` }));

  $('#rule-form').innerHTML = `
    <div class="rg">
      <h4>什么时候触发</h4>
      <div class="field">
        <label>规则说明</label>
        <input id="rf-title" value="${esc(r.title || '')}" placeholder="一句话说清这条规则管什么，比如「GitHub Issue 自动修复」">
        <div class="sub">只给人看，会显示在规则表里。</div>
      </div>
      <div class="row2">
        <div class="field">
          <label>事件来源</label>
          ${selectHtml('rf-source', cat.sources, m.source || '*')}
          <div class="sub" id="rf-source-hint"></div>
        </div>
        <div class="field">
          <label>事件类型</label>
          ${selectHtml('rf-type', typeOpts, m.type || '')}
          <div class="sub">决定哪类事件走进来。<code>*</code> 表示任意类型。</div>
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label>额外匹配条件（可选）</label>
          <input id="rf-payload" value="${esc(m.payload ? Object.entries(m.payload).map(([k, v]) => `${k}=${v}`).join(', ') : '')}" placeholder="kind=dev">
          <div class="sub">按参数精确匹配，形如 <code>kind=dev</code>，多个用逗号分隔。留空表示不限。</div>
        </div>
        <div class="field">
          <label>序号</label>
          <input id="rf-order" type="number" value="${esc(r.order ?? '')}">
          <div class="sub">数字小的先匹配。同一事件命中多条规则时，序号小的赢。</div>
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label>优先级</label>
          ${selectHtml('rf-priority', cat.priorities, r.priority || 'P2')}
        </div>
        <div class="field">
          <label>定时触发（可选）</label>
          ${selectHtml('rf-cron', cat.cron_presets, presetHit ? cronVal : (cronVal ? 'custom' : ''))}
          <input id="rf-cron-custom" value="${esc(cronVal)}" placeholder="例如 0 18 * * *" style="margin-top:8px;display:${presetHit || !cronVal ? 'none' : 'block'}">
          <div class="sub">选定后系统会按这个时间自动投递事件。留空表示只被动等待事件。</div>
        </div>
      </div>
    </div>

    <div class="rg">
      <h4>派给谁</h4>
      <div class="row2">
        <div class="field">
          <label>处理方式</label>
          ${selectHtml('rf-action', cat.actions, r.action || 'dispatch')}
          <div class="sub">「直接推人」用于发布失败这类只需要通知、不需要动手的事。</div>
        </div>
        <div class="field" id="rf-notify-wrap" style="display:${isNotify ? '' : 'none'}">
          <label>通知级别</label>
          ${selectHtml('rf-notify-level', cat.priorities, r.notify_level || 'P1')}
        </div>
      </div>
      <div id="rf-dispatch-wrap" style="display:${isNotify ? 'none' : ''}">
        <div class="row2">
          <div class="field">
            <label>执行引擎</label>
            ${selectHtml('rf-engine', engineOpts, rt.engine || '', { allowEmpty: '— 请选择 —' })}
            <div class="sub" id="rf-engine-hint"></div>
          </div>
          <div class="field">
            <label>执行节点</label>
            ${selectHtml('rf-node', [{ value: 'any', label: '任意可用节点' }, ...cat.nodes.map((n) => ({ value: n.id, label: `${n.label} · ${n.id}` }))], rt.node || 'any')}
            <div class="sub">节点必须在线且声明了该引擎，否则任务会排队并触发饥饿告警。</div>
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label>技能（SOP）</label>
            ${selectHtml('rf-skill', skillOpts, r.skill || '', { allowEmpty: '不装技能（用提示词直接说）' })}
            <div class="sub">技能决定执行步骤。开发类务必用 repo-dev（写死「止步于开 PR」）。</div>
          </div>
          <div class="field">
            <label>工作目录（可选）</label>
            <input id="rf-workdir" value="${esc(rt.workdir || '')}" placeholder="D:\\Projects\\my-app">
            <div class="sub">留空则用中台自己所在目录 —— 代码任务一定要填，否则会在错的仓库里跑。</div>
          </div>
        </div>
        <div class="field">
          <label>额外指令（可选）</label>
          <textarea id="rf-prompt" placeholder="追加到技能之后的具体要求，例如「改完必须 typecheck + build 都过」">${esc(r.prompt || '')}</textarea>
        </div>
      </div>
    </div>

    <div class="rg">
      <h4>怎么执行</h4>
      <div class="row3" id="rf-limits" style="display:${isNotify ? 'none' : ''}">
        <div class="field">
          <label>同键并发</label>
          <input id="rf-per-key" type="number" min="0" value="${esc(lim.per_key ?? 1)}">
          <div class="sub">同一 dedupe_key 同时跑几个。0 表示不限制。</div>
        </div>
        <div class="field">
          <label>总并发</label>
          <input id="rf-max-parallel" type="number" min="1" value="${esc(lim.max_parallel ?? 3)}">
          <div class="sub">这类事件最多同时跑几个。</div>
        </div>
        <div class="field">
          <label>最多尝试次数</label>
          <input id="rf-attempts" type="number" min="1" value="${esc(lim.attempts ?? 2)}">
          <div class="sub">失败后重试，用完进死信。</div>
        </div>
      </div>
      <div class="field" id="rf-timeout-wrap" style="display:${isNotify ? 'none' : ''}">
        <label>超时（秒）</label>
        <input id="rf-timeout" type="number" min="60" value="${esc(lim.timeout_seconds ?? 1800)}">
      </div>
      <div class="row2">
        <div class="field">
          <label>审批</label>
          ${selectHtml('rf-approval', cat.approval_modes, r.approval === 'always' ? 'always' : 'no')}
          <div class="sub">「必须先批红」会让任务停在待批，不批不跑。删数据、停服这类一定要设。</div>
        </div>
        <div class="field">
          <label>结果是否通知人</label>
          <label class="switch">
            <input type="checkbox" id="rf-silent" ${r.silent === false ? 'checked' : ''}>
            <span>
              <span class="lbl">完成后推送结果</span>
              <span class="hint">关掉 = 只写台账不打扰（白名单外的默认做法）</span>
            </span>
          </label>
        </div>
      </div>
      <div class="field">
        <label>启用状态</label>
        <label class="switch">
          <input type="checkbox" id="rf-enabled" ${r.enabled === false ? '' : 'checked'}>
          <span>
            <span class="lbl">这条规则生效</span>
            <span class="hint">临时停用可以取消勾选，规则留在文件里但不再匹配</span>
          </span>
        </label>
      </div>
    </div>
  `;

  // 联动：处理方式决定下半张表单显示哪些段
  const actionSel = $('#rf-action');
  actionSel.addEventListener('change', () => {
    const notify = actionSel.value === 'notify';
    $('#rf-notify-wrap').style.display = notify ? '' : 'none';
    $('#rf-dispatch-wrap').style.display = notify ? 'none' : '';
    $('#rf-limits').style.display = notify ? 'none' : '';
    $('#rf-timeout-wrap').style.display = notify ? 'none' : '';
  });

  // 联动：来源过滤事件类型候选（只保留同来源与通配的）
  const syncTypeOptions = () => {
    const src = $('#rf-source').value;
    const keep = $('#rf-type').value;
    const list = cat.event_types.filter((t) => t.source === '*' || t.source === src || src === '*');
    $('#rf-type').innerHTML = list
      .map((t) => `<option value="${esc(t.value)}"${t.value === keep ? ' selected' : ''}>${esc(t.label)} · ${esc(t.value)}</option>`)
      .join('');
  };
  $('#rf-source').addEventListener('change', () => {
    syncTypeOptions();
    const hit = cat.sources.find((s) => s.value === $('#rf-source').value);
    $('#rf-source-hint').textContent = hit?.hint || '';
  });
  const srcHint = cat.sources.find((s) => s.value === ($('#rf-source').value));
  $('#rf-source-hint').textContent = srcHint?.hint || '';

  $('#rf-engine').addEventListener('change', () => {
    const id = $('#rf-engine').value;
    const online = (state.nodes || []).filter((n) => n.online && (n.engines || []).includes(id)).map((n) => n.id);
    $('#rf-engine-hint').textContent = id
      ? (online.length ? `当前在线可接：${online.join('、')}` : '此刻没有节点声明这个引擎，派出去会排队')
      : '';
  });

  // 定时：选「自定义」时露出输入框
  $('#rf-cron').addEventListener('change', () => {
    const v = $('#rf-cron').value;
    const box = $('#rf-cron-custom');
    if (v === 'custom') { box.style.display = 'block'; box.focus(); } else { box.style.display = 'none'; box.value = v; }
  });

  $('#rule-dialog').showModal();
  setTimeout(() => $('#rf-title')?.focus(), 40);
}

/** 把表单读回成一个 patch（只带用户改动的字段，其余交给后端深合并） */
function readRuleForm() {
  const isNotify = $('#rf-action').value === 'notify';
  const payloadText = $('#rf-payload').value.trim();
  let payload;
  if (payloadText) {
    payload = {};
    for (const pair of payloadText.split(/[,，]/)) {
      const [k, ...rest] = pair.split('=');
      if (!k.trim()) continue;
      const v = rest.join('=').trim();
      payload[k.trim()] = v === '' ? true : (v === 'true' ? true : v === 'false' ? false : (Number.isFinite(Number(v)) && v !== '' ? Number(v) : v));
    }
  }
  const cronPick = $('#rf-cron').value;
  const cronExpr = cronPick === 'custom' ? $('#rf-cron-custom').value.trim() : cronPick;

  const patch = {
    title: $('#rf-title').value.trim(),
    order: Number($('#rf-order').value) || undefined,
    priority: $('#rf-priority').value,
    action: $('#rf-action').value,
    approval: $('#rf-approval').value === 'always' ? 'always' : false,
    silent: !$('#rf-silent').checked,
    enabled: $('#rf-enabled').checked,
    match: {
      source: $('#rf-source').value,
      type: $('#rf-type').value,
      payload: payload || null,
    },
    schedule: cronExpr ? { cron: cronExpr, name: $('#rf-title').value.trim() || undefined, priority: $('#rf-priority').value } : null,
  };
  if (isNotify) {
    patch.notify_level = $('#rf-notify-level').value;
    patch.route = null;
    patch.limits = null;
  } else {
    patch.route = {
      node: $('#rf-node').value,
      engine: $('#rf-engine').value,
      workdir: $('#rf-workdir').value.trim(),
    };
    patch.skill = $('#rf-skill').value;
    patch.prompt = $('#rf-prompt').value.trim();
    patch.limits = {
      per_key: Number($('#rf-per-key').value) || 0,
      max_parallel: Number($('#rf-max-parallel').value) || 1,
      attempts: Number($('#rf-attempts').value) || 1,
      timeout_seconds: Number($('#rf-timeout').value) || 1800,
    };
  }
  return patch;
}

async function saveRule() {
  const patch = readRuleForm();
  const btn = $('#rule-save');
  btn.disabled = true;
  $('#rule-err').textContent = '';
  try {
    const res = editingRule
      ? await api(`/api/rules/${encodeURIComponent(editingRule.id)}`, { method: 'PUT', body: patch })
      : await api('/api/rules', { method: 'POST', body: patch });
    $('#rule-dialog').close();
    toast(editingRule ? '规则已保存并生效' : `规则已创建：${res.rule.id}`);
    await loadAll();
  } catch (err) {
    // 校验失败时把每条原因都摆出来，不要只说「保存失败」
    let msg = err.message;
    try { const body = JSON.parse(err.bodyText || '{}'); if (body.errors?.length) msg = body.errors.join('；'); } catch { /* 用原消息 */ }
    $('#rule-err').textContent = msg;
    toast(msg, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteRule() {
  if (!editingRule) return;
  if (!confirm(`删除规则「${editingRule.title || editingRule.id}」？\n\n删除后这类事件将不再被自动派活。`)) return;
  try {
    await api(`/api/rules/${encodeURIComponent(editingRule.id)}`, { method: 'DELETE' });
    $('#rule-dialog').close();
    toast('规则已删除');
    await loadAll();
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  }
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

  // 规则编辑器：新建 / 保存 / 删除 / 关闭
  $('#rule-new').addEventListener('click', () => openRuleEditor(null));
  $('#rule-save').addEventListener('click', saveRule);
  $('#rule-delete').addEventListener('click', deleteRule);
  $('#rule-cancel').addEventListener('click', () => $('#rule-dialog').close());
  // 点遮罩关闭（dialog 自身的点击目标就是 dialog 元素时说明点在了背景上）
  $('#rule-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'rule-dialog') $('#rule-dialog').close();
  });
}

/* ═══════════════ 启动 ═══════════════ */

bind();
const initial = (location.hash || '').replace('#', '');
if (initial && $(`#view-${initial}`)) switchView(initial);
loadAll();
setInterval(() => { if (!document.hidden) loadAll(); }, 8000);
setInterval(paintUptime, 1000);
