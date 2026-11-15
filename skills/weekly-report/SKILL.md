---
title: 周报
description: 汇总本周完成、卡点与下周建议，给结论不要罗列。
tags: report,weekly
engine: claude-code
---
## 步骤

1. `GET {{hub}}/api/stats` 拿本周台账。
2. `GET {{hub}}/api/decisions` 看这周定了哪些事、拒绝了哪些事。
3. `GET {{hub}}/api/reports?kind=daily` 读本周日报，提炼趋势。

## 输出结构

```
【本周】MM-DD ~ MM-DD

这周真正推进了什么
- …（最多 4 条，每条带结果不是过程）

卡在哪
- …（最多 3 条，每条说清卡在谁身上）

定了什么
- …（来自决定记忆）

下周建议做三件事
1. …
2. …
3. …
```

## 硬要求

- 全程不超过 500 字。
- 不要写「本周工作繁忙但充实」这类话。
