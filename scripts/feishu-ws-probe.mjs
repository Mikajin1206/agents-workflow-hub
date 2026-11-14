// 长连接一次性探测：真实 bootstrap → WS 握手 → ping/pong → 退出。
// 用法：node scripts/feishu-ws-probe.mjs [--stay]（--stay 常驻收事件，Ctrl+C 退出）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeishuWSClient } from '../src/m1/feishu-ws.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/hub.config.json'), 'utf8').replace(/^\uFEFF/, ''));
const f = cfg.feishu || {};

if (!f.enabled || !f.appId || !f.appSecret) {
  console.error('config 里飞书未启用（enabled/appId/appSecret 缺一不可）');
  process.exit(1);
}

const stay = process.argv.includes('--stay');
const client = new FeishuWSClient({
  appId: f.appId,
  appSecret: f.appSecret,
  domain: f.domain,
  logger: console,
  onEvent: async (body) => {
    const kind = body?.header?.event_type || body?.type || JSON.stringify(body).slice(0, 60);
    console.log(`[事件] ${new Date().toISOString()} ${kind}`);
    console.log(JSON.stringify(body).slice(0, 500));
    return null;
  },
});

console.log('正在连接飞书长连接…');
client.start().then(() => {
  setTimeout(() => {
    console.log('status:', JSON.stringify(client.status()));
    if (client.status().connected) console.log('✓ 长连接可用：bootstrap + WS 握手 + ping 全部成功');
    else console.log('✗ 未能建立连接，看上面的错误日志');
    if (!stay) { client.stop(); process.exit(0); }
  }, 6000);
}).catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});

process.on('SIGINT', () => { client.stop(); process.exit(0); });
