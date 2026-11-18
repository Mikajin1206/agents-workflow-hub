import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitHubWebhookManager, normalizeRepo } from '../src/m1/github-webhooks.mjs';

test('normalizeRepo requires a single owner/name pair', () => {
  assert.equal(normalizeRepo(' owner/repo-name '), 'owner/repo-name');
  assert.throws(() => normalizeRepo('owner'), /owner\/name/);
  assert.throws(() => normalizeRepo('owner/repo/extra'), /owner\/name/);
});

test('adding and removing a repository syncs the hook and local allowlist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-github-hooks-'));
  const file = path.join(dir, 'hub.config.json');
  const config = {
    paths: { configFile: file },
    github: {
      webhookSecret: 'test-secret',
      webhookUrl: 'https://hub.example/webhook/github',
      allowedRepos: [],
      webhookIds: {},
    },
  };
  fs.writeFileSync(file, JSON.stringify(config));
  let hooks = [];
  const manager = new GitHubWebhookManager({
    config,
    tokenProvider: () => 'test-token',
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      const method = init.method || 'GET';
      if (pathname === '/repos/owner/repo' && method === 'GET') {
        return response({ full_name: 'owner/repo' });
      }
      if (pathname === '/repos/owner/repo/hooks' && method === 'GET') return response(hooks);
      if (pathname === '/repos/owner/repo/hooks' && method === 'POST') {
        const payload = JSON.parse(init.body);
        hooks.push({ id: 41, active: payload.active, config: payload.config, events: payload.events });
        return response(hooks[0]);
      }
      if (pathname === '/repos/owner/repo/hooks/41' && method === 'DELETE') {
        hooks = [];
        return response(null, 204);
      }
      throw new Error(`Unexpected request ${method} ${pathname}`);
    },
  });

  try {
    const added = await manager.add('owner/repo');
    assert.equal(added.hook_id, 41);
    assert.deepEqual(config.github.allowedRepos, ['owner/repo']);
    assert.equal(config.github.webhookIds['owner/repo'], 41);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).github.allowedRepos, ['owner/repo']);

    const removed = await manager.remove('owner/repo');
    assert.equal(removed.hook_removed, true);
    assert.deepEqual(config.github.allowedRepos, []);
    assert.deepEqual(config.github.webhookIds, {});
    assert.deepEqual(hooks, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return data; },
  };
}
