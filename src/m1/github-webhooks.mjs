import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';
const EVENTS = ['issues', 'pull_request', 'check_suite', 'workflow_run'];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubWebhookManager {
  constructor({ config, fetchImpl = fetch, tokenProvider = getGhToken }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.tokenProvider = tokenProvider;
  }

  async list() {
    const token = this.tokenProvider();
    const [available, user] = await Promise.all([
      this.#allPages('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', token),
      this.#request('/user', token),
    ]);
    const selected = new Set(this.config.github.allowedRepos || []);
    const monitored = await Promise.all([...selected].map(async (repo) => {
      const hookId = this.config.github.webhookIds?.[repo] || null;
      try {
        const hooks = await this.#request(`/repos/${repo}/hooks?per_page=100`, token);
        const hook = hooks.find((h) => h.config?.url === this.#webhookUrl())
          || hooks.find((h) => h.id === hookId);
        return { repo, hook_id: hook?.id || hookId, hook_active: Boolean(hook?.active), hook_found: Boolean(hook) };
      } catch {
        return { repo, hook_id: hookId, hook_active: false, hook_found: false };
      }
    }));
    return {
      account: user.login,
      available: available.map((r) => ({ full_name: r.full_name, private: Boolean(r.private), selected: selected.has(r.full_name) })),
      monitored,
      webhook_url: this.#webhookUrl(),
      insecure_ssl: true,
      events: EVENTS,
    };
  }

  async add(repoInput) {
    const repo = normalizeRepo(repoInput);
    const token = this.tokenProvider();
    const info = await this.#request(`/repos/${repo}`, token);
    const repoName = info.full_name;
    const allowed = [...(this.config.github.allowedRepos || [])];
    const hookIds = { ...(this.config.github.webhookIds || {}) };
    const alreadySelected = allowed.some((name) => name.toLowerCase() === repoName.toLowerCase());
    const hook = await this.#ensureHook(repoName, token);
    if (!alreadySelected) allowed.push(repoName);
    hookIds[repoName] = hook.id;
    this.#save(allowed, hookIds);
    return { repo: repoName, hook_id: hook.id, hook_active: Boolean(hook.active), events: EVENTS };
  }

  async remove(repoInput) {
    const repo = normalizeRepo(repoInput);
    const allowed = [...(this.config.github.allowedRepos || [])];
    const selected = allowed.find((name) => name.toLowerCase() === repo.toLowerCase());
    if (!selected) throw Object.assign(new Error('该仓库当前不在检测范围内'), { status: 404 });

    const token = this.tokenProvider();
    const hookIds = { ...(this.config.github.webhookIds || {}) };
    const repoPath = selected;
    const hooks = await this.#request(`/repos/${repoPath}/hooks?per_page=100`, token);
    const storedId = hookIds[selected];
    const hook = (storedId && hooks.find((h) => h.id === storedId && h.config?.url === this.#webhookUrl()))
      || hooks.find((h) => h.config?.url === this.#webhookUrl());
    if (hook) {
      const response = await this.fetch(`${API}/repos/${repoPath}/hooks/${hook.id}`, {
        method: 'DELETE',
        headers: this.#headers(token),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok && response.status !== 404) {
        throw await apiError(response);
      }
    }

    const nextAllowed = allowed.filter((name) => name.toLowerCase() !== selected.toLowerCase());
    delete hookIds[selected];
    this.#save(nextAllowed, hookIds);
    return { repo: selected, removed: true, hook_removed: Boolean(hook) };
  }

  async #ensureHook(repo, token) {
    const url = this.#webhookUrl();
    const hooks = await this.#request(`/repos/${repo}/hooks?per_page=100`, token);
    const existing = hooks.find((h) => h.config?.url === url);
    const body = {
      name: 'web',
      active: true,
      events: EVENTS,
      config: {
        url,
        content_type: 'json',
        secret: this.config.github.webhookSecret,
        insecure_ssl: '1',
      },
    };
    if (!body.config.secret) throw new Error('本地未设置 GitHub webhook 密钥');
    const path = existing
      ? `/repos/${repo}/hooks/${existing.id}`
      : `/repos/${repo}/hooks`;
    return this.#request(path, token, { method: existing ? 'PATCH' : 'POST', body });
  }

  async #allPages(firstPath, token) {
    const out = [];
    let url = `${API}${firstPath}`;
    for (let page = 0; url && page < 10; page += 1) {
      const response = await this.fetch(url, {
        headers: this.#headers(token),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw await apiError(response);
      out.push(...await response.json());
      const link = response.headers.get('link') || '';
      url = link.split(',').map((part) => part.trim()).find((part) => part.endsWith('rel="next"'))
        ?.match(/<([^>]+)>/)?.[1] || '';
    }
    return out;
  }

  async #request(path, token, { method = 'GET', body } = {}) {
    const response = await this.fetch(`${API}${path}`, {
      method,
      headers: this.#headers(token),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw await apiError(response);
    return response.json();
  }

  #headers(token) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  #webhookUrl() {
    const url = String(this.config.github.webhookUrl || '').trim();
    if (!url) throw new Error('未配置 GitHub webhook 公网地址');
    return url;
  }

  #save(allowedRepos, webhookIds) {
    const file = this.config.paths.configFile;
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const disk = JSON.parse(raw);
    disk.github = { ...(disk.github || {}), allowedRepos, webhookIds };
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(disk, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    this.config.github.allowedRepos = allowedRepos;
    this.config.github.webhookIds = webhookIds;
  }
}

export function normalizeRepo(input) {
  const repo = String(input || '').trim();
  if (!REPO_RE.test(repo)) throw Object.assign(new Error('仓库格式须为 owner/name'), { status: 422 });
  return repo;
}

function getGhToken() {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw Object.assign(new Error('GitHub CLI 未登录或令牌不可用，请先在本机完成 gh auth login'), { status: 503 });
  }
}

async function apiError(response) {
  let message = '';
  try { message = (await response.json()).message || ''; } catch { /* no response body */ }
  const safeMessage = message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 240);
  return Object.assign(new Error(`GitHub API ${response.status}${safeMessage ? `：${safeMessage}` : ''}`), { status: response.status });
}
