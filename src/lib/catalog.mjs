/**
 * 面板用的「可选值目录」：事件来源、事件类型、优先级等下拉选项集中在这里。
 *
 * 为什么要有这个文件：规则页从「手改 JSON」变成「下拉菜单」之后，
 * 人就不该再靠记忆拼 `github.pull_request` 这种字符串了 —— 拼错一个下划线，
 * 规则会安静地永远匹配不上，而系统看起来一切正常。下拉选项是唯一的防线。
 *
 * 新增入口适配器时，把新的事件类型加进 EVENT_TYPES，面板自动出现该选项。
 */

/** 事件来源（对应 envelope 的 source，已归一化后的值） */
export const SOURCES = [
  { value: 'cron', label: 'cron · 本地定时器', hint: 'rules.json 里的 schedule 到点投递' },
  { value: 'github', label: 'github · GitHub Webhook', hint: 'issue / PR / CI 事件' },
  { value: 'feishu', label: 'feishu · 飞书消息与卡片', hint: '群里 @机器人 或点卡片按钮' },
  { value: 'monitor', label: 'monitor · 监控告警', hint: '外部监控系统打 /webhook/monitor' },
  { value: 'cli', label: 'cli · 命令行提交', hint: 'node src/cli.mjs submit' },
  { value: 'web', label: 'web · 面板提交', hint: '面板「派发」页' },
  { value: 'system', label: 'system · 系统内部', hint: '中台自己产生的事件' },
  { value: '*', label: '任意来源', hint: '不限制来源' },
];

/** 事件类型（envelope 的 type） */
export const EVENT_TYPES = [
  { value: 'cron.daily-report', source: 'cron', label: '每日战报', hint: '每天 07:30 汇总过去 24 小时' },
  { value: 'cron.weekly-report', source: 'cron', label: '每周周报', hint: '周日汇总一周' },
  { value: 'cron.repo-sweep', source: 'cron', label: '仓库巡检', hint: '每天 18:00 扫仓库健康度' },
  { value: 'cron.cleanup', source: 'cron', label: '大扫除', hint: '周日清理僵尸分支/日志/skill' },
  { value: 'monitor.alert', source: 'monitor', label: '监控告警', hint: '服务不可用、指标越界' },
  { value: 'github.issue', source: 'github', label: 'GitHub Issue', hint: '新开或重开的 issue' },
  { value: 'github.pull_request', source: 'github', label: 'GitHub PR 动作', hint: 'PR 打开/同步/关闭' },
  { value: 'github.push', source: 'github', label: 'GitHub Push', hint: '推送到分支' },
  { value: 'release.failed', source: 'github', label: '发布失败', hint: 'CI 失败或超时（P0）' },
  { value: 'review.stalled', source: '*', label: '审查卡住', hint: '流水线审查 3 轮不过' },
  { value: 'feishu.message', source: 'feishu', label: '飞书群消息', hint: '群里 @机器人 说的话' },
  { value: 'feishu.card_action', source: 'feishu', label: '飞书卡片动作', hint: '点批红卡的按钮' },
  { value: 'cmd.manual', source: '*', label: '手动任务', hint: 'CLI / 面板提交的命令' },
  { value: '*', source: '*', label: '任意类型', hint: '不限制事件类型' },
];

export const PRIORITIES = [
  { value: 'P0', label: 'P0 告警级', hint: '立即强提醒，出问题才用' },
  { value: 'P1', label: 'P1 决策级', hint: '立即普通提醒' },
  { value: 'P2', label: 'P2 常规', hint: '进每日 07:30 聚合' },
  { value: 'P3', label: 'P3 汇总类', hint: '只归档，不打扰' },
];

export const APPROVAL_MODES = [
  { value: 'no', label: '不必批（默认）', hint: '白名单外的事系统自己做完，只写台账' },
  { value: 'always', label: '必须先批红', hint: '任务停在 awaiting_approval，不批不跑' },
];

export const ACTIONS = [
  { value: 'dispatch', label: '派活给节点', hint: '按 route 指定的引擎执行' },
  { value: 'notify', label: '直接推人（不派活）', hint: '只为通知人，比如发布失败' },
];

/** 常用 cron 预设，省得手打表达式 */
export const CRON_PRESETS = [
  { value: '', label: '不定时（默认）' },
  { value: '30 7 * * *', label: '每天 07:30' },
  { value: '0 18 * * *', label: '每天 18:00' },
  { value: '0 9 * * 1-5', label: '工作日 09:00' },
  { value: '0 20 * * 0', label: '每周日 20:00' },
  { value: '0 21 * * 0', label: '每周日 21:00' },
  { value: '0 3 * * *', label: '每天凌晨 03:00' },
  { value: '0 * * * *', label: '每小时整点' },
  { value: 'custom', label: '自定义（手填）' },
];
