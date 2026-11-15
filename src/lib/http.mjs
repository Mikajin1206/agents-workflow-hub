import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 零依赖 HTTP 路由：极简但够用（本地单机、内网长轮询场景）。
 */
export class Router {
  constructor() {
    this.routes = [];
    this.middlewares = [];
  }

  use(fn) {
    this.middlewares.push(fn);
    return this;
  }

  add(method, pattern, handler) {
    this.routes.push({ method: method.toUpperCase(), pattern, handler, keys: patternKeys(pattern) });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && r.method !== '*') continue;
      const params = matchPattern(r.pattern, pathname, r.keys);
      if (params) return { route: r, params };
    }
    return null;
  }
}

function patternKeys(pattern) {
  const keys = [];
  const re = pattern.replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; });
  return { keys, re: new RegExp('^' + re.replace(/\*/g, '.*') + '$') };
}

function matchPattern(pattern, pathname, compiled) {
  const m = pathname.match(compiled.re);
  if (!m) return null;
  const params = {};
  compiled.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  return params;
}

/* ────────────────────────── 请求/响应封装 ────────────────────────── */

export function createCtx(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ctx = {
    req,
    res,
    method: req.method,
    url,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    params: {},
    headers: req.headers,
    body: undefined,
    rawBody: '',
    status: 200,
    sent: false,
  };

  ctx.status_ = (code) => { ctx.status = code; return ctx; };
  ctx.json = (data, code) => {
    if (ctx.sent) return;
    ctx.sent = true;
    const payload = JSON.stringify(data, null, 2);
    res.writeHead(code || ctx.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };
  ctx.text = (body, code, type = 'text/plain; charset=utf-8') => {
    if (ctx.sent) return;
    ctx.sent = true;
    res.writeHead(code || ctx.status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  ctx.html = (body, code) => ctx.text(body, code, 'text/html; charset=utf-8');
  ctx.redirect = (loc) => {
    if (ctx.sent) return;
    ctx.sent = true;
    res.writeHead(302, { Location: loc });
    res.end();
  };
  ctx.error = (message, code = 400, extra = {}) => ctx.json({ ok: false, error: message, ...extra }, code);
  return ctx;
}

export function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseBody(raw, contentType = '') {
  if (!raw) return {};
  const ct = String(contentType).toLowerCase();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch (err) {
      throw Object.assign(new Error(`JSON 解析失败：${err.message}`), { code: 'BAD_JSON' });
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (ct.includes('text/') || ct === '') {
    try { return JSON.parse(raw); } catch { return { raw }; }
  }
  return { raw };
}

export function verifyHmacSha256(secret, rawBody, signature) {
  if (!secret) return true;
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function serveStatic(dir, urlPath, res) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(dir, safePath);
  if (!file.startsWith(dir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
    };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      // 本地单机面板，宁可每次都校验也不要缓存导致改了看不见
      'Cache-Control': 'no-cache, must-revalidate',
      'Content-Length': stat.size,
    });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}
