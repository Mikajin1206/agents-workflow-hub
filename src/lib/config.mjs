import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** hub 根目录（本文件位于 <hub>/src/lib/config.mjs） */
export const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULTS = {
  hub: {
    name: 'agents-workflow-hub',
    host: '127.0.0.1',
    port: 8787,
    leaseWaitSeconds: 50,
    heartbeatSeconds: 10,
    // 派活后多久没有任何回写视为超时（秒）
    resultTimeoutSeconds: 900,
    secret: '',
  },
  ledger: {
    dbPath: 'data/hub.db',
    dedupeWindowSeconds: 300,
  },
  limits: {
    globalMaxParallel: 3,
    attempts: 2,
    retryBackoffSeconds: 20,
    // 排了这么久还是 queued、且没有在线节点能执行 → 判为饥饿并告警（P1）。
    // 不设这个，任务会永远卡在「看起来还在排队」的状态里，没人知道它已经死锁。
    starvedSeconds: 180,
  },
  engines: {},
  nodes: [],
  approvals: {
    reminderHours: 24,
    maxRevisions: 3,
    // 必问清单：命中任一分类关键词即必须批红，未批红绝不执行
    categories: [
      { id: 'delete_data', label: '删数据', keywords: ['删数据', '删除数据', '清空数据库', 'drop table', 'truncate', 'rm -rf', 'delete from'] },
      { id: 'stop_service', label: '停服', keywords: ['停服', '停止服务', '下线服务', 'shutdown', '停掉服务'] },
      // 2026-11-17 口径：花钱类只收「真支付动作」——讨论成本、询价、采购不算，
      // 讨论语境的豁免在 approvals.mjs 的 moneyTalkExempt。
      { id: 'spend_money', label: '花钱', keywords: ['花钱', '付费', '升级套餐', '购买', '充值', '订阅费', '升配', '续费', '下单', '扣费'] },
      { id: 'outbound_message', label: '对外发消息', keywords: ['对外发消息', '公开发布', '发公告', '群发', '对外通知', '发邮件给客户', '发推特', '发微博'] },
      { id: 'product_direction', label: '改产品方向', keywords: ['改产品方向', '调整产品方向', '砍掉功能', '产品定位'] },
      { id: 'secret_rotate', label: '新建或轮换密钥', keywords: ['轮换密钥', '新建密钥', '重置密钥', 'apikey', 'api key', 'token 轮换', '改密码'] },
      // 关键词必须是「真要改权限」的说法，不能是「提到权限」。
      // 曾经的 '授权' 会把「未修改权限」「被策略拒绝」这类描述也判成人要批红。
      { id: 'permissions', label: '修改权限', keywords: ['修改权限', '改权限', '权限变更', '提权', 'chmod', 'iam policy', '赋予管理员'] },
    ],
    // 默认动作：超时未批 = 挂起，绝不默认同意
    defaultAction: 'hold',
  },
  feishu: {
    enabled: false,
    appId: '',
    appSecret: '',
    botWebhook: '',
    verificationToken: '',
    encryptKey: '',
    chatId: '',
  },
  github: { webhookSecret: '', allowedRepos: [], webhookUrl: '', webhookIds: {} },
  // 监控 webhook 的共享密钥。默认空 = 不校验（本地 127.0.0.1 够用）；
  // 一旦把 hub.host 改成局域网地址，这里必须填，否则同网段任何人都能伪造告警。
  monitor: { sharedSecret: '' },
  panel: { enabled: true, title: '本地自动化 Agent 体系' },
  reports: { dir: 'data/reports' },
  skills: { dir: 'skills' },
  decisions: { dir: 'config/decisions' },
  rulesPath: 'config/rules.json',
  logging: { level: 'info', dir: 'data/logs' },
  cron: { enabled: true },
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function resolvePath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(HUB_ROOT, p);
}

let cached = null;

export function loadConfig(overrides = {}) {
  const file = process.env.HUB_CONFIG || path.join(HUB_ROOT, 'config', 'hub.config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      // 必须剥掉 BOM：Windows 上用 PowerShell 的 Set-Content -Encoding utf8（PS 5.x）
      // 存盘会带 U+FEFF，JSON.parse 直接报 "Unexpected token '﻿'"，
      // 表现是中台启动即崩、且报错信息只说「配置文件解析失败」看不出是 BOM。
      user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error(`配置文件解析失败：${file}\n${err.message}`);
    }
  }
  const env = {};
  if (process.env.HUB_PORT) env.hub = { ...(env.hub || {}), port: Number(process.env.HUB_PORT) };
  if (process.env.HUB_HOST) env.hub = { ...(env.hub || {}), host: process.env.HUB_HOST };
  if (process.env.HUB_LOG_LEVEL) env.logging = { ...(env.logging || {}), level: process.env.HUB_LOG_LEVEL };

  const cfg = deepMerge(deepMerge(deepMerge(DEFAULTS, user), env), overrides);
  // HUB_DATA_DIR：把台账/日志/报告挪到指定目录（自测用临时目录，或多实例各用一份数据）
  const dataDir = process.env.HUB_DATA_DIR ? path.resolve(process.env.HUB_DATA_DIR) : null;
  cfg.paths = {
    root: HUB_ROOT,
    configFile: file,
    rules: resolvePath(cfg.rulesPath),
    db: dataDir ? path.join(dataDir, 'hub.db') : resolvePath(cfg.ledger.dbPath),
    logs: dataDir ? path.join(dataDir, 'logs') : resolvePath(cfg.logging.dir),
    reports: dataDir ? path.join(dataDir, 'reports') : resolvePath(cfg.reports.dir),
    skills: resolvePath(cfg.skills.dir),
    decisions: resolvePath(cfg.decisions.dir),
    data: dataDir || path.dirname(resolvePath(cfg.ledger.dbPath)),
    ui: path.join(HUB_ROOT, 'src', 'web', 'public'),
  };
  if (!cfg.hub.secret) cfg.hub.secret = 'local-dev-secret-change-me';
  cached = cfg;
  return cfg;
}

export function getConfig() {
  return cached || loadConfig();
}

export function ensureDirs(cfg) {
  for (const d of [cfg.paths.data, cfg.paths.logs, cfg.paths.reports, cfg.paths.skills, cfg.paths.decisions]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function addSeconds(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export function isExpired(iso, now = Date.now()) {
  return new Date(iso).getTime() <= now;
}
