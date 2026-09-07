# AGENTS.md —— 给 AI agent 的仓库导航与纪律（人类同样适用）

> 本文件是仓库的第一入口：任何 agent（DSH 会话 / Codex / 云端 headless）在本仓库动手前先读这里。维护：内容变化时同步更新，别让它过期。

## 这是什么

dsh-context-maid：DeepSeek Harness 的自动上下文策展插件。五级策展（PIN/KEEP/SLIM/SWEEP/FOLD）——继承官方 BasicCompactionEngine 注册为 ctx.compaction（FOLD）、官方 ToolResultPruner 注册为 ctx.toolResultPruner（SLIM，折叠压力路径内）、折叠前 PIN 钉扎软保护 + 摘要智能路由、先归档后压缩（compaction/summary → ACP ledger）。文档诚实化纪律：**未接线的能力不许宣称**。

## 结构地图

- `src/index.mjs` —— 插件入口（Config 点号键、占用探测、引擎/瘦身器/审计/归档/命令装配）
- `src/engine.mjs` —— MaidCompactionEngine extends BasicCompactionEngine（阈值映射 toOfficialConfig；summarize 覆写 = PIN 注入 + 智能路由 + 官方回落）
- `src/slimmer.mjs` —— MaidSlimmer extends ToolResultPruner（内容感知瘦身）
- `src/sweeper.mjs` —— 无效日志扫描**纯函数**（无执行器，未接线——README 已标注）
- `src/pinner.mjs` —— PIN 收集（ACP queryObservations 高权威 + WC goal + pin.extra）
- `src/archiver.mjs` —— 先归档后压缩（compaction/summary → ACP append；audit-first）
- `src/audit.mjs` / `commands.mjs` —— 策展审计库 / /context-maid 命令（status/config/help）
- `src/maid-summarizer.mjs` —— M4 摘要 LLM 调用（复刻官方调用语义 + resolver 链）
- `test/*.test.mjs` —— node:test（m1-m4/smoke/golden-regression）
- `docs/` —— design.md（设计）、DEVELOPMENT-PLAN.md（backlog）、adr/（决策记录）
- `cordis.patch.yml` —— bundle 装配补丁

## 铁律（违反会被打回）

1. **官方引擎必须 disable**：cordis 同 key 服务单提供者——compaction-basic/tool-result-pruner 不禁用则 maid 自动旁路（防呆 warn）；README 装配说明与此一致。
2. **未接线不宣称**：sweeper 无执行器、slim 仅在官方折叠压力路径内、pin.inject/minTokens 未接线——README/设计文档如实标注，不得夸大（P0-2 教训，golden CM 守护）。
3. **Config 键不进官方透传**：maid 自持键（点号键）不得进 toOfficialConfig（官方 validateKeys 拒未知键）；嵌套写法不生效，用扁平键。
4. **审计 first**：策展事件无条件留痕（区分「事件未达」与「路径断开」）；归档走 ACP 时 block → 脱敏重试一次。
5. **改代码必须补测试**：test/ 下同名 `.test.mjs`；golden regression 守护历史 issue。
6. **纯 ESM 零运行时依赖**：src 一律 `.mjs`；peerDependencies 之外需先讨论。

## 常用命令

- 测试：`pnpm test`（node --test "test/*.test.mjs"）
- 单个测试：`node --test test/<name>.test.mjs`
- lint：`pnpm lint`（oxlint）

## 提交纪律

小步提交；每个改动一个主题；feature 分支开发；合 main 前跑全量测试。README 是中文主文档，行为语义变化要同步 README、docs/design.md 与 docs/DEVELOPMENT-PLAN.md（backlog 状态一并更新）。
