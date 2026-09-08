# dsh-context-maid — 开发计划与问题登记（Backlog）

> 仓库级 backlog：进行中/待办/已收口的工作条目与已知问题。
> 设计文档：docs/design.md（五级策展模型）；README 已诚实标注未接线能力。
> 维护规则：条目完成即更新状态并注明提交/日期；新发现先登记再动手（规划先行）。
> 本文件初版登记来源：D:\DSH_workspace\docs\audits\plugin-code-review-2026-09-07.md（2026-09-07 全面审查）

## 版本线

| 版本 | 收口提交 | 内容 |
|---|---|---|
| 0.1.0 | v0.1.0 | M1-M4：引擎接管/瘦身/归档/摘要路由 |
| 0.2.0 | 535d667 | P0-1 PIN 双来源修复（acp.queryObservations + scopeId 对齐）+ P0-2 死键标注/README 诚实化 + golden regression |
| 0.3.0 | — | C0 清洁 → M5 eventSlim（B8）→ M6 sweep（B7）→ M7 收口（死键删除 + B10）；设计稿 docs/design-0.3.0.md（2026-09-08 定稿） |

## 待办（Backlog）

| ID | 级别 | 问题 | 解决方式 | 状态 |
|---|---|---|---|---|
| MAID-B2 | P1-4 交叉 | 折叠归档（agent_authored/single_observation/experience）无 kind=maid-checkpoint 标记——T2 权威闸门当前挡下回流注入（豁免已记录于 ACP-B7）；若 ACP 放宽 observationAuthorities 白名单即复活 | ACP 放宽白名单前：appendArchive（archiver.mjs:84-92）加 metadata kind='maid-checkpoint' + ACP composer 排除/降权 | 条件触发（ACP-B7 联动） |
| MAID-B3 | P3 | commands.mjs:4 误导注释："run/slim-now 等执行命令随对应里程碑（M2 sweeper/slimmer）加入"——M2 早已收口且 sweep 执行器未接线（README 已诚实化），注释与现实脱节 | 删除该注释或改为"执行命令暂不提供（sweep 未接线，见 README）" | open |
| MAID-B4 | P3 | lint warnings 8 个（0 error）：slimmer.mjs:13 死 import codePointLength、archiver.mjs:64 无必要转义、test 6 个未用参数 | 一次 lint-clean 提交（`pnpm lint` 归零） | open |
| MAID-B6 | 计划 | C6 压缩质量抽检：从 session 事件取 shadowed 原文 → 无损启发式抽检（或低频 LLM judge）→ 结果落审计 → status 展示。前置：slim/sweep/pin 审计写入补全（audit.mjs op 枚举已预留 slim/sweep/pin，当前仅 fold 有写入方） | archiver.mjs registerArchiver（:150-194）为公共观察点（旁路模式同样生效）；audit.mjs 扩列或 detail 复用；golden 集挂 fixture | planned |
| MAID-B7 | 计划 | sweep 执行器：scanSweepCandidates 纯函数全树无调用方（README 已诚实标注"执行器未接线"） | M6（设计稿 §4）：surface 视角扫描重构 + model-free 节点 stub（D1-A 拍板）+ sweep.enabled/aggressive 激活 | decided（2026-09-08：M6，设计稿 §4） |
| MAID-B8 | 计划 | SLIM"落地即瘦身"：当前仅官方折叠压力路径内 pruneSession 生效（设计意图 = tool 输出落地即瘦身） | M5（设计稿 §5）：覆写 compactIfNeeded 前置增量瘦身 + trigger.eventSlim 激活（默认 true，D2 拍板） | decided（2026-09-08：M5，设计稿 §5） |
| MAID-B9 | 计划 | 死键全景（扩表）：trigger.minTokens / trigger.eventSlim / sweep.enabled / sweep.aggressive / pin.inject / summarization.allowLocal（eventSlim 为 B9 原漏登） | 2026-09-08 定：eventSlim 随 B8 激活（M5）；sweep.* 随 B7 激活（M6）；minTokens + pin.inject + allowLocal 删键（M7） | decided（2026-09-08：M5/M6/M7 分派，设计稿 §6） |
| MAID-B10 | 计划 | PIN 输出无 token 预算上限：buildPinInstruction 全量塞入（engine.mjs:76-88），ACP 高权威 observation 增长后 summarize 输入成本上升 | M7（设计稿 §7，D5 拍板并进）：≤600 token 预算截断 + 计数 + authority 优先级保留 | decided（2026-09-08：M7） |
| MAID-B11 | 记录 | 已知限制：官方压缩从头压连续段，中段 PIN 无法硬排除（pinner.mjs 头注）——硬保护（压缩范围排除 PIN 段）留作未来工作 | 不排期；若压缩引擎 seam 支持 range 排除再评估 | 保留 |

## 0.3.0 设计拍板（2026-09-08，详见 docs/design-0.3.0.md §10）

- D1 sweep 处置 = model-free 节点 stub（无 LLM）；D2 eventSlim 默认 true；D3 minTokens 删键；
  D4 pin.inject / summarization.allowLocal 删键；D5 B10 并进 M7；D6 里程碑 C0→M5→M6→M7。

## 已收口（近期）

- P0-1（PIN 双来源静默失效）✅ 520bc9d —— acp.queryObservations + work scopeIdForCwd 对齐 + mock 更新
- P0-2（SLIM/SWEEP 未接线）✅ 68be9d5 —— 死键标注 + README 诚实化 + 审计范围
- 版本收口 0.2.0 ✅ 535d667（对照 ACP/WC 节奏）
- MAID-B1（C3 迟滞带）✅ 2026-09-08 拍板关闭 —— 不实现 recoverRatio/cooldownTurns；plugin-audit-summary-2026-09-07.md 回顾段口径已更正（原误标“随 never 防护覆盖”系 fdd7780 张冠李戴）
- MAID-B5（残留分支 docs/pr-template）✅ 2026-09-08 —— 本地 branch -D + push origin --delete