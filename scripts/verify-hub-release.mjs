import { loadConfig } from '../src/lib/config.mjs';

try {
  const expected = process.env.HUB_MERGED_SHA;
  if (!/^[a-f0-9]{40}$/i.test(expected || '')) throw new Error('缺少本次合并的提交 SHA');

  const { hub } = loadConfig();
  const url = `http://${hub.host}:${hub.port}/api/version`;
  const response = await fetch(url, {
    headers: { 'x-hub-token': hub.secret },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`版本接口返回 HTTP ${response.status}`);
  const { commit, clean } = await response.json();
  if (!clean || commit !== expected) {
    throw new Error(`运行中的服务版本不符：预期 ${expected}，实际 ${commit || '未知'}，启动时工作区干净=${clean}`);
  }
  console.log(commit);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
