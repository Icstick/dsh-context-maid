# dsh-context-maid — 开发计划与问题登记（Backlog）

> 仓库级 backlog：进行中/待办/已收口的工作条目与已知问题。
> 设计文档：docs/design.md（五级策展模型）；README 已诚实标注未接线能力。
> 当前消息来源：PIN 与摘要指令采用 `plugin:dsh-context-maid`，满足 Session v4 生产者归属要求。
> 维护规则：条目完成即更新状态并注明提交/日期；新发现先登记再动手（规划先行）。
> 本文件初版登记来源：D:\DSH_workspace\docs\audits\plugin-code-review-2026-09-07.md（2026-09-07 全面审查）

## 版本线

| 版本 | 收口提交 | 内容 |
|---|---|---|
| 0.1.0 | v0.1.0 | M1-M4：引擎接管/瘦身/归档/摘要路由 |
| 0.2.0 | 535d667 | P0-1 PIN 双来源修复（acp.queryObservations + scopeId 对齐）+ P0-2 死键标注/README 诚实化 + golden regression |
| 0.3.0 | ff8b719 | C0 清洁 + M5 eventSlim + M6 sweep + M7 收口（死键删除/B10 PIN 预算/version 0.3.0），52 测试全绿 |

## 待办（Backlog）

| ID | 级别 | 问题 | 解决方式 | 状态 |
|---|---|---|---|---|
| MAID-B2 | P1-4 交叉 | 折叠归档（agent_authored/single_observation/experience）无 kind=maid-checkpoint 标记——T2 权威闸门当前挡下回流注入（豁免已记录于 ACP-B7）；若 ACP 放宽 observationAuthorities 白名单即复活 | ACP 放宽白名单前：appendArchive（archiver.mjs:84-92）加 metadata kind='maid-checkpoint' + ACP composer 排除/降权 | 条件触发（ACP-B7 联动） |
| MAID-B3 | P3 | commands.mjs:4 误导注释："run/slim-now 等执行命令随对应里程碑（M2 sweeper/slimmer）加入"——M2 早已收口且 sweep 执行器未接线（README 已诚实化），注释与现实脱节 | 删除该注释或改为"执行命令暂不提供（sweep 未接线，见 README）" | ✅ 2026-09-10（3094765 已修正；注释现述 0.3.0 现状 + slim-now 运维口） |
| MAID-B4 | P3 | lint warnings 8 个（0 error）：slimmer.mjs:13 死 import codePointLength、archiver.mjs:64 无必要转义、test 6 个未用参数 | 一次 lint-clean 提交（`pnpm lint` 归零） | ✅ 2026-09-10（3094765 归零；实测 0 warnings / 0 errors） |
| MAID-B6 | 计划 | C6 压缩质量抽检：从 session 事件取 shadowed 原文 → 无损启发式抽检（或低频 LLM judge）→ 结果落审计 → status 展示。前置：slim/sweep/pin 审计写入补全（audit.mjs op 枚举已预留 slim/sweep/pin，当前仅 fold 有写入方） | **C6 v1 已落地（2026-09-09）**：`src/anchor.mjs` 确定性锚点校验（零 LLM、零新存储，借鉴 dsh-premise-guard）——PIN 事实抽字面锚点（路径/引号/key=value/常量）与摘要正文做归一化包含比对，结果落 `audit op=pin`（含命中率、missed、不可校验事实数），`/context-maid status` 展示。审计同时补 `unit`/`producer` 列（记账货币口径显式化：slim/sweep=chars，fold=estTokens）。剩余：shadowed 原文侧抽检、golden fixture 挂载 | **v1 完成**（原文侧抽检待做） |
| MAID-B11 | 记录 | 已知限制：官方压缩从头压连续段，中段 PIN 无法硬排除（pinner.mjs 头注）——硬保护（压缩范围排除 PIN 段）留作未来工作 | 不排期；若压缩引擎 seam 支持 range 排除再评估 | 保留 |
| MAID-B12 | P1 | **PIN 锚点校验口径不诚实**——`op=pin` 只报「命中率」、不报「可校验率」，且 `status` 只显示最近一次。本机实测 38 次校验：每次收集 16 条 PIN 事实、仅 4 条可抽字面锚点（25%）；命中分布 0/4×4、1/4×1、2/4×1、3/4×13、4/4×19 → **50% 的压缩未把 PIN 全部带进摘要，10.5% 全部丢失**（`session-3a99455b` 连续两次 0/4）。调研者本人即因「只看最近一次」误判为 100% | ① `anchor.mjs` 报告增 `verifiableRatio`（可校验/总数）；② `engine.mjs` 的 summary 行改为「可校验 4/16（25%）· 命中 0/4」；③ `commands.mjs` 的 status 展示**近 N 次分布**而非仅最近一次，0/4 时 warn（不阻断） | **已实现（2026-09-21，分支 `feat/b12-b14-pin-fold-observability`）**：① `anchor.mjs` 增 `factsCount`/`verifiableFacts`/`verifiableRatio` 与 `summarizePinHistory`；② `engine.mjs` summary 改「可校验 V/F（P%） · 命中 H/T（Q%）」，全丢 warn，并在落盘前压 `detail` 长度（审计截断 500 会让半截 JSON 不可解析）；③ `commands.mjs` status 改报近 20 次分布 + 0/N 告警。**实测修正**：本机 19 行 pin 全是 **5 个锚点**（非文档里的 4），分布 0/5×10、1/5×4、3/5×4、2/5×1——全丢占 53%，比原记录的 10.5% 严重得多，两者口径/样本窗口不一致，待与本机 `maid-audit-snapshot.csv` 核对 |
| MAID-B13 | P1 | **eventSlim 处置粒度与真实 microcompact 不一致**——本机 14 条 slim 记录 `charsAfter` 恒为 1639/2044（head 800 + tail 800 + marker），与输入（30010–50000 chars）无关：50000 chars 输出被砍到约 550 token，中部全丢。对照实测（本机 Claude Code 2.1.202 二进制）：真实 microcompact = `cleared`（整条清）+ `keep recent N`（保留最近 N 条完整），保住的是完整语义单元 | 方案 A（推荐）：保留最近 N 条**完整** tool 结果，更老的整条清空；方案 B：现状头尾但按内容类型自适应（error/json 已实现部分）；方案 C：按工具差异化预算（Read 30KB / Bash 50KB / WebSearch 15KB）。推荐 **A+C** 组合，B 作为 A 的兜底 | 待立项（见 PLAN §2.2） |
| MAID-B14 | P1 | **FOLD 递归深度无记账/无展示/无告警**——本机实测单会话折叠 17 轮（`session-4deb7491`）、`session-311f2b1c` 6.7 分钟内 8 轮。递归本身非缺陷（Amp 先废压缩、Neo CLI 又回到「压缩 + 90% 自动触发」），但深度是「本会话还要不要继续」的唯一判据，当前取不到 | ① `engine.mjs` 用 WeakMap 对 session 计 fold 次数；② `fold` 审计行 `detail` 增 `foldDepth`；③ `archiver.mjs` 写审计时带上；④ `commands.mjs` 的 status 展示当前会话深度；⑤ 深度 > 10 时 warn（不阻断、不引入线程模型） | **已实现（2026-09-21，同上分支）**：`archiver.mjs` 增 `nextFoldDepth`（按 `session.id` 计数、首次从审计库播种），fold 行 `summary` 带 `（foldDepth N）`、`detail` 改 JSON 并含 `foldDepth`；`commands.mjs` status 展示本会话深度，>10 时 warn。**偏离原设计**：不用 WeakMap 按 session **对象**计数——对象身份在事件派发间没有保证，一旦宿主换包装对象就会恒返回 0，深度永远写 1 且**静默无声**；改用字符串 id 作键 |

| MAID-B15 | P1 | **折叠后没有「不可丢约束」校验**——C6 v1 只做了「PIN 事实的锚点是否出现在摘要里」（`_verifyPinAnchors`），另有两处缺口：① 折叠前没有「约束清单摘要」（PIN 集合 + 每条约束的稳定标识），跨折叠不可比对；② 被 PIN 预算（1800 chars）截断、**从未发给模型**的事实，仍被拿去抽锚点并算进 `missed`——把「我们自己没发出去」记成「模型丢了」，命中率被系统性低估且排查方向从一开始就错 | 新增 `src/fold-verify.mjs`（折叠前清单摘要：稳定标识 = `sha256(kind+NUL+归一化全文)` 前 10 位、注入记账；折叠后三态 `ok/partial/lost` + `unverifiable`/`not-injected`/`no-summary`/`idle`，`lostIds` 列出丢了哪些约束）；`pinner.planPinInstruction` 外露 `kept/omitted`；`engine._verifyPinAnchors` 接入 plan 并落 `op=pin`（`detail.status` 等）；`fold.verify.enabled`（maid 自持键，默认 true，**只告警不阻塞**）；`/context-maid status` 增三态分布 | ✅ 2026-09-25（86 测试全绿 / lint 0；**未接线**：折叠后 session surface 侧比对——观测点时序不成立，见 docs/design.md §9.8） |
| MAID-B16 | P1 | **B14 的「从审计库播种 foldDepth」在生产路径上恒不生效**：`audit.recent()` 返回的是 SQLite 原生列名 `session_id`（`audit.mjs:57` 只补了 `archiveIds`，未做 camelCase 映射），而 `archiver.nextFoldDepth`（`archiver.mjs:176`）与 `commands.renderStatus`（`commands.mjs:167`）读的都是 `r.sessionId`（camelCase）→ 恒为 `undefined` → 种子永远是 0。**本机实测复现**：真库里 3 条同会话 `op=fold`（`foldDepth` 1/2/3），`nextFoldDepth({id:'S'}, audit)` 返回 **1**（应为 4）。同因，`/context-maid status` 的 `foldDepth` 恒显示 0。B14 的单测用 `{ sessionId: … }` 的 mock 行，与真实行形状不一致，故未被抓住 | 读侧容忍两种形状（`r.sessionId ?? r.session_id`），并补一条**用真 audit 库播种**的测试（而不是 mock 行形状） | ⏳ 未做（本次范围外；已实测复现，证据见 `research-2026-09-25/I-maid-fold-verify.md`） |
## 0.3.0 设计拍板（2026-09-08，详见 docs/design-0.3.0.md §10）

- D1 sweep 处置 = model-free 节点 stub（无 LLM）；D2 eventSlim 默认 true；D3 minTokens 删键；
  D4 pin.inject / summarization.allowLocal 删键；D5 B10 并进 M7；D6 里程碑 C0→M5→M6→M7。

## 已收口（近期）

- P0-1（PIN 双来源静默失效）✅ 520bc9d —— acp.queryObservations + work scopeIdForCwd 对齐 + mock 更新
- P0-2（SLIM/SWEEP 未接线）✅ 68be9d5 —— 死键标注 + README 诚实化 + 审计范围
- 版本收口 0.2.0 ✅ 535d667（对照 ACP/WC 节奏）
- MAID-B1（C3 迟滞带）✅ 2026-09-08 拍板关闭 —— 不实现 recoverRatio/cooldownTurns；plugin-audit-summary-2026-09-07.md 回顾段口径已更正（原误标“随 never 防护覆盖”系 fdd7780 张冠李戴）
- MAID-B5（残留分支 docs/pr-template）✅ 2026-09-08 —— 本地 branch -D + push origin --delete
- MAID-B8（eventSlim 落地即瘦身）✅ M5 —— MaidSlimmer.incrementalSlim + MaidCompactionEngine.runPreCleanup/compactIfNeeded 覆写 + trigger.eventSlim 默认 true + op=slim 审计，42 测试全绿（0.3.0 设计稿 §5）
- MAID-B3/B4（误导注释 + lint 清零）✅ C0 —— 8 warnings 归零
- MAID-B7（sweep 执行器）✅ M6
- MAID-B15（折叠后约束校验）✅ 2026-09-25 —— `src/fold-verify.mjs` 折叠前清单摘要（sha256 稳定标识 + 注入记账）+ 折叠后三态 ok/partial/lost + `lostIds`；`pinner.planPinInstruction` 外露 kept/omitted；修掉「预算截断被记成模型丢失」的口径错误；`fold.verify.enabled` 默认 true 且只告警不阻塞。**未接线**：折叠后 session surface 侧比对（时序不成立）
- MAID-B9（死键全景）✅ M7 —— 删除 trigger.minTokens / pin.inject / summarization.allowLocal（eventSlim 激活于 M5、sweep.* 激活于 M6）
- MAID-B10（PIN 预算）✅ M7
- 0.3.0 实测（2026-09-08 live）✅ —— eventSlim 21 pruned/217 checked（-134712 chars），审计闭环；修复集成问题 ×3（private field/HMR、tokenMeter 注入、pre-step 节奏确认）；运维口 /context-maid slim-now + status 诊断行（详见 design.md §9.6） —— buildPinInstruction ≤1800 字符（≈600 token）整条截断 + 计数，authority 优先级保留 —— scanSweepCandidates 真实事件模型重构（surface 视角 + callId 配对）+ stubToolResultNode（compaction/prune 协议）+ engine ② sweep 节流清扫 + op=sweep 审计；sweep.enabled 激活（aggressive 规则未扩展，保留开关）；48 测试全绿（0.3.0 设计稿 §4
- 0.3.0 sweep 实测（2026-09-08 live）✅ —— 自动 + 手动路径均处置（superseded-read/failed-retry 审计闭环）；规则收紧：superseded-read 仅路径键指纹（design.md §9.6））
