# dsh-context-maid — 开发计划与问题登记（Backlog）

> 仓库级 backlog：进行中/待办/已收口的工作条目与已知问题。
> 设计文档：docs/design.md（五级策展模型）；README 已诚实标注未接线能力。
> 维护规则：条目完成即更新状态并注明提交/日期；新发现先登记再动手（规划先行）。
> 本文件初版登记来源：D:\DSH_workspace\docs\plugin-code-review-2026-09-07.md（2026-09-07 全面审查）

## 版本线

| 版本 | 收口提交 | 内容 |
|---|---|---|
| 0.1.0 | v0.1.0 | M1-M4：引擎接管/瘦身/归档/摘要路由 |
| 0.2.0 | 535d667 | P0-1 PIN 双来源修复（acp.queryObservations + scopeId 对齐）+ P0-2 死键标注/README 诚实化 + golden regression |
| 0.3.0 | — | 待办合流（下表） |

## 待办（Backlog）

| ID | 级别 | 问题 | 解决方式 | 状态 |
|---|---|---|---|---|
| MAID-B1 | P2 | C3 迟滞带（trigger.recoverRatio / trigger.cooldownTurns）未实现——engine.mjs 无 compactIfNeeded 覆写；plugin-audit-summary 执行记录"迭代 A-D 全部落地"误标 C3 完成（实际完成的是 approval seam never 防护 fdd7780） | 二选一（拍板）：a) 实现——MaidCompactionEngine 覆写 compactIfNeeded（官方明示子类缝）：折叠后计数，官方连续 N turn 不触发即按 recoverRatio 提前再评估；Config 键留 maidConfig 自持（官方 validateKeys 拒未知键，不得透传 toOfficialConfig）b) 正式关闭并更正 audit summary 执行记录口径 | open（待拍板） |
| MAID-B2 | P1-4 交叉 | 折叠归档（agent_authored/single_observation/experience）无 kind=maid-checkpoint 标记——T2 权威闸门当前挡下回流注入（豁免已记录于 ACP-B7）；若 ACP 放宽 observationAuthorities 白名单即复活 | ACP 放宽白名单前：appendArchive（archiver.mjs:84-92）加 metadata kind='maid-checkpoint' + ACP composer 排除/降权 | 条件触发（ACP-B7 联动） |
| MAID-B3 | P3 | commands.mjs:4 误导注释："run/slim-now 等执行命令随对应里程碑（M2 sweeper/slimmer）加入"——M2 早已收口且 sweep 执行器未接线（README 已诚实化），注释与现实脱节 | 删除该注释或改为"执行命令暂不提供（sweep 未接线，见 README）" | open |
| MAID-B4 | P3 | lint warnings 8 个（0 error）：slimmer.mjs:13 死 import codePointLength、archiver.mjs:64 无必要转义、test 6 个未用参数 | 一次 lint-clean 提交（`pnpm lint` 归零） | open |
| MAID-B5 | P3 | git 残留分支 ×1：docs/pr-template（已 squash 并入 51b7e05/ae2f9dd） | git-guardrails 流程：本地 branch -D + push origin --delete | open（待批准） |
| MAID-B6 | 计划 | C6 压缩质量抽检：从 session 事件取 shadowed 原文 → 无损启发式抽检（或低频 LLM judge）→ 结果落审计 → status 展示。前置：slim/sweep/pin 审计写入补全（audit.mjs op 枚举已预留 slim/sweep/pin，当前仅 fold 有写入方） | archiver.mjs registerArchiver（:150-194）为公共观察点（旁路模式同样生效）；audit.mjs 扩列或 detail 复用；golden 集挂 fixture | planned |
| MAID-B7 | 计划 | sweep 执行器：scanSweepCandidates 纯函数全树无调用方（README 已诚实标注"执行器未接线"） | 拍板：实现（sweep.enabled 语义落地）或从设计移除 | open（待拍板） |
| MAID-B8 | 计划 | SLIM"落地即瘦身"监听：当前仅官方折叠压力路径内 pruneSession 生效（设计意图 = tool 输出落地即瘦身） | 拍板：实现独立监听 or 维持现状（README 已如实） | open（待拍板） |
| MAID-B9 | 计划 | 保留键三件：trigger.minTokens（低于此不触发暂无实现）、pin.inject（逐轮注入未接线）、sweep.enabled/aggressive（同 B7） | 随 B7/B8 拍板一并定：实现 or 删键 | open |
| MAID-B10 | 计划 | PIN 输出无 token 预算上限：buildPinInstruction 全量塞入（engine.mjs:76-88），ACP 高权威 observation 增长后 summarize 输入成本上升 | collectPinnedFacts 输出加预算（如 ≤600 token，截断 + 计数）；随 C6/C7 迭代做 | planned |
| MAID-B11 | 记录 | 已知限制：官方压缩从头压连续段，中段 PIN 无法硬排除（pinner.mjs 头注）——硬保护（压缩范围排除 PIN 段）留作未来工作 | 不排期；若压缩引擎 seam 支持 range 排除再评估 | 保留 |

## 已收口（近期）

- P0-1（PIN 双来源静默失效）✅ 520bc9d —— acp.queryObservations + work scopeIdForCwd 对齐 + mock 更新
- P0-2（SLIM/SWEEP 未接线）✅ 68be9d5 —— 死键标注 + README 诚实化 + 审计范围
- 版本收口 0.2.0 ✅ 535d667（对照 ACP/WC 节奏）