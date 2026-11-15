#!/usr/bin/env node
/**
 * 飞书接入自检脚本（零依赖）。
 *
 * 用法：
 *   node scripts/feishu-setup.mjs --app-id cli_xxx --app-secret yyy
 *     拿 token、列出机器人所在的群，打印建议的配置片段。
 *
 *   node scripts/feishu-setup.mjs --app-id ... --app-secret ... --chat-id oc_xxx
 *     再向该群发一条「连通性测试」消息。
 *
 *   node scripts/feishu-setup.mjs ... --send-card
 *     再发一张假的批红卡（按钮回调需要公网可达的 webhook，点了没反应属正常）。
 *
 * 拿凭据的位置：飞书开放平台 https://open.feishu.cn → 开发者后台 → 你的应用：
 *   - 凭证与基础信息 → App ID / App Secret
 *   - 事件与回调 → 订阅方式 → Encrypt Key / Verification Token
 */
import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; }
      else out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const appId = args['app-id'] || process.env.FEISHU_APP_ID;
const appSecret = args['app-secret'] || process.env.FEISHU_APP_SECRET;
const chatId = args['chat-id'] || process.env.FEISHU_CHAT_ID || '';
const base = args['base-url'] || 'https://open.feishu.cn';

if (!appId || !appSecret) {
  console.error('缺少凭据。用法：');
  console.error('  node scripts/feishu-setup.mjs --app-id cli_xxx --app-secret yyy [--chat-id oc_xxx] [--send-card]');
  process.exit(2);
}

const jsonPost = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const jsonGet = async (path, token) => {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// 1. tenant_access_token
const tokenRes = await jsonPost('/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: appSecret });
if (tokenRes.status !== 200 || tokenRes.data.code !== 0) {
  console.error(`✗ 取 token 失败：code=${tokenRes.data.code} msg=${tokenRes.data.msg || tokenRes.status}`);
  console.error('  检查 App ID / App Secret 是否填对（凭证与基础信息页）。');
  process.exit(1);
}
const token = tokenRes.data.tenant_access_token;
console.log('✓ 凭据有效，已拿到 tenant_access_token');

// 2. 列出机器人所在的群（需要 im:chat:read 权限）
const chatsRes = await jsonGet('/open-apis/im/v1/chats?page_size=20', token);
if (chatsRes.status === 200 && chatsRes.data.code === 0) {
  const items = chatsRes.data.data?.items || [];
  if (!items.length) {
    console.log('· 机器人还没有加入任何群。在飞书里把机器人拉进目标群，再重跑本脚本。');
  } else {
    console.log(`✓ 机器人所在群 ${items.length} 个：`);
    for (const c of items) console.log(`  - ${c.name}  chat_id=${c.chat_id}`);
  }
} else {
  console.log(`· 列群失败（code=${chatsRes.data.code} msg=${chatsRes.data.msg}）。`);
  console.log('  多半是没开 im:chat:read 权限：开发者后台 → 权限管理 → 搜索 im:chat:read → 开通并发布版本。');
  console.log('  也可以直接从群的群设置/机器人说明里拿 chat_id 填进配置。');
}

// 3. 可选：发连通性测试消息 / 假批红卡
async function send(payload, label) {
  const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 200 && data.code === 0) console.log(`✓ ${label}已送达`);
  else {
    console.error(`✗ ${label}失败：code=${data.code} msg=${data.msg || res.status}`);
    if (data.code === 99991672 || data.code === 230001) {
      console.error('  多半是机器人没被加进该群，或缺 im:message 权限（权限管理 → im:message:send_as_bot）。');
    }
    process.exitCode = 1;
  }
}

if (chatId) {
  await send({
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text: '【中台连通性测试】本地自动化 Agent 体系已配置飞书通道。收到这条说明发送链路通了。' }),
  }, '测试消息');

  if (args['send-card']) {
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: '【演练】这是一张假的批红卡' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '**演练**：验证卡片样式与按钮显示。按钮回调需要公网可达的 webhook 地址，没配公网时点了不会有反应，属正常。' } },
        { tag: 'hr' },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '同意' }, type: 'primary', value: { action: 'approval:agree', approval_id: 'apr演练' } },
          { tag: 'button', text: { tag: 'plain_text', content: '驳回' }, type: 'danger', value: { action: 'approval:reject', approval_id: 'apr演练' } },
          { tag: 'button', text: { tag: 'plain_text', content: '改派' }, type: 'default', value: { action: 'approval:revise', approval_id: 'apr演练' } },
        ] },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '编号 apr演练 · 超时不默认同意' }] },
      ],
    };
    await send({ receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }, '演练卡片');
  }
}

// 4. 打印建议配置
console.log('\n----- 把下面片段填进 hub\\config\\hub.config.json 的 feishu 块 -----');
console.log(JSON.stringify({
  feishu: {
    enabled: true,
    appId,
    appSecret: '<你的 AppSecret>',
    chatId: chatId || '<从上面列表选一个群的 chat_id>',
    verificationToken: '<事件与回调页的 Verification Token>',
    encryptKey: '<事件与回调页的 Encrypt Key，可选>',
  },
}, null, 2));
console.log('----- 回调地址（只有要手机上点卡片按钮批红才需要）-----');
console.log('  事件与回调 → 订阅方式 → 请求网址配置为: http://<公网地址>/webhook/feishu');
console.log('  本机默认只监听 127.0.0.1；要接收回调需把 hub.host 改成 0.0.0.0 并做内网穿透/公网映射，');
console.log('  同时必须配置 verificationToken 或 encryptKey（没配密钥时 doctor 会判红：任何人都能伪造批红卡片）。');
