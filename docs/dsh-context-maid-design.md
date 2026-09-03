# dsh-context-maid — 自动上下文策展插件设计文档 v0.2（用户拍板后定稿）

> 日期：2026-09-03 | 状态：v0.2 定稿（M1-M4 全部实现（28 测试）；实机验证待挂载）（用户拍板：命名 dsh-context-maid、repo 在 my-plugins/、工具链 mjs+node --test、sweep aggressive 保留意见、新增 compact 模型用户可配 + 智能路由端点） | 前置调研：
> dsh-compaction-survey.md（本地基建）、context-mgmt-survey.md（业界）、
> context-compaction-assets-draft.md（资产）、context-compaction-survey-index.md（索引+实测）
> 用户拍板（verbatim 语义）：独立 repo；全阶段规划；阈值用户可调；
> **压缩重点 = 节约 tool 输出与无效日志**；**保护重点 = 正在进行的工作流 / 记忆 / 用户要求重点**；ACP 分类防御顺手修。

## 1. 背景与问题

DSH 自带 compaction 家族（自动 80% 窗口触发 + /compact + 固定头尾 pruner），但实测：
- 自动压缩从未触发（deepseek-v4-flash 默认 100 万窗口 → 阈值 80 万 token，会话到不了）
- 用户实际在 ~30-45% 上下文主动 /compact——手动是常态
- 官方 pruner 只做固定 head/tail 截断（不感知内容价值）；压缩 = 单次 LLM 总结，无记忆联动
- 上下文膨胀的主因不是对话本身，而是 **tool 输出堆积与无效日志**（重复读取、失败重试中间产物、
  超长 stderr、被取代的结果）——用户拍板：这才是压缩的主战场
- 同时：正在进行的工作流（goal/nextSteps）、记忆与用户明确要求的内容**不能被有损压缩误伤**
  （业界教训：Claude Code 指令/plan 被压丢 issue #24686/#36068；Governance Decay 论文：
  压缩静默删除安全约束）

## 2. 目标与非目标

### 目标
1. **自动、主动**地在上下文到达可调阈值前做策展（默认建议对齐用户习惯 ~35-45%）
2. **优先清理**：tool 输出（大结果、过时结果、重复读取）与无效日志（stderr 噪音、失败中间产物、
   被取代内容、僵尸消息）——按内容价值而非固定头尾
3. **保护**：进行中的工作流（work_state / 当前 goal / 活动 todo）、记忆与用户要求重点
   （user_explicit/user_correction 高 authority、用户明确"记住/重点"的内容）——物理钉扎，不进有损压缩
4. **归档**：被清理/压缩的高价值内容先进 ACP ledger（先沉淀后压缩），压缩摘要本身成为一条
   带 supersedes 链的证据——压缩可审计、可恢复
5. **可配置可观测**：阈值/开关全用户可调（设置页 + settings.yaml）；每次策展输出报告进审计

### 非目标（v0.1 不做）
- 不做跨会话共享上下文（单会话作用域，与官方一致）
- 不做 model-facing compact 工具（KNOWN_SESSION_EVENT_TYPES 门禁，探索期后置）
- 不重写 DSH compaction 引擎（继承/消费官方 seam）
- 不做图片/富块的压缩（官方限制同）

## 3. 核心概念：内容策展分级（Guardian Rating）

给 surface 上每个消息节点打「保留等级」，策展按等级决定去留：

| 等级 | 含义 | 处理 | 示例 |
|---|---|---|---|
| **PIN** | 钉扎：不可有损 | 永不进压缩/清理；如可能移到不可压缩前缀 | user_explicit/correction 原文、当前 goal、用户说"记住/重点"的内容、进行中步骤的指令 |
| **KEEP** | 保留：当前工作相关 | 正常保留，参与尾部预算 | 最近 N token 内的活动内容 |
| **SLIM** | 可瘦身：保价值去冗余 | 内容感知截断（非固定头尾） | 超长 tool 输出（保留关键段）、大 JSON/日志（保留结构+关键行） |
| **SWEEP** | 可清理：无效/过时 | 从 surface 移除（进 ledger 留痕） | 被后续取代的读取/结果、失败重试中间产物、stderr 噪音、僵尸消息 |
| **FOLD** | 可压缩：旧对话 | 标准 checkpoint 摘要（官方事务） | 早期对话、已归档的工作讨论 |

**判定依据（确定性为主，LLM 为辅）**：
- authority 高者（user_explicit/user_correction/system_policy）→ PIN（ACP authority 模型直接复用）
- work_state 引用 / 当前 turn 近邻 / 未完成步骤 → KEEP
- tool 结果：按体积、时效（是否有更新的同工具结果/supersede）、内容类型（错误信息保留、日志压缩）→ SLIM/SWEEP
- 僵尸特征：孤儿 tool-call（无 result）、被 replace 遮蔽段、重复读同一文件、失败后的成功重试前体 → SWEEP
- 其余旧内容按时间/相关性 → FOLD

## 4. 架构总览

```
dsh-context-maid（独立 cordis 插件）
│
├─ ctx.compaction 关系：注册自研后端（extends BasicCompactionEngine）或挂 auto:false +
│   自研触发监听（二选一，绝不双 auto）
│
├─ 模块：
│  ├─ classifier.mjs    内容分级（PIN/KEEP/SLIM/SWEEP/FOLD）——确定性规则引擎
│  ├─ pinner.mjs        钉扎段管理：识别 PIN 内容并保护（压缩范围排除 + 必要时前置）
│  ├─ slimmer.mjs       tool 输出内容感知瘦身（可注册为 toolResultPruner 服务替换官方版）
│  ├─ sweeper.mjs       无效日志/僵尸清理（用官方 compactRegion 事务移除）
│  ├─ trigger.mjs       触发策略：可调阈值预检 + 事件触发 + 溢出回退 + 手动
│  ├─ archiver.mjs      归档：SWEEP/FOLD 内容 → ACP ledger（先沉淀后压缩）
│  ├─ summarizer.mjs    覆写 summarize()：归档后摘要 + 钉扎段保护（官方唯一子类钩子）
│  ├─ report.mjs        策展报告 + 审计（audit 表 + 每轮可查）
│  └─ index.mjs         apply 装配
│
├─ 数据：
│  ├─ 配置：Config schema（全部用户可调）+ 设置页卡片（namespace context-guardian）
│  └─ 审计：独立 SQLite（或复用 ctx 审计？见开放问题）—— 每次策展的决策记录
│
└─ 依赖：@deepseek-ai/dsh-compaction-basic（继承 + 复用事务）、ACP（可选：ledger 写入）、
     dsh-tools、dsh-session、schemastery
```

## 5. 关键机制设计

### 5.1 触发策略（trigger.mjs）——阈值用户可调
- **预检触发**（对齐 opencode）：agent/pre-step waterfall 中估算
  `totalTokens > 预算 − max(output预算, 安全buffer)` → 预算 = contextWindow × userRatio（默认 0.40，
  用户可调 0.2-0.8）；userRatio 是核心可调旋钮
- **内容事件触发**：大 tool 输出落地即处理（不等待总量阈值）——SLIM 立即瘦身、SWEEP 立即清；
  监听 session/event 的 tool/result 类型，体积 > slimThreshold（默认 4000 字符）即入队
- **溢出回退**：provider CONTEXT_WINDOW_EXCEEDED → 强制一轮（prune→retain=0 最大缩减）
- **手动**：注册 /context-guardian 命令族（status / run / slim-now / config）
- **节流与防抖**：同 turn 至多一次 FOLD；每日上限；与 ACP consolidation 错峰（后台队列）

### 5.2 钉扎段（pinner.mjs）——保护工作流/记忆/用户重点
- PIN 内容来源：
  a) ACP authority 判定 user_explicit / user_correction / system_policy 的原文（如 ACP 在线，调 ctx.acp.query authority 过滤）
  b) 本插件自维护轻量判定：消息文本含用户指令特征 + 长度阈值 + 关键词（"记住/重点/必须/不要/改成"）
     + 当前 work_state.goal 相关段（若 work-continuity 在线）
- 保护机制：FOLD 压缩时**范围排除**——selectCompactableRange 只压 PIN 段之外的区域；
  实现 = 继承 BasicCompactionEngine 后覆写 compactIfNeeded/compactRegion 的区间选择，
  或自建 range 计算后调官方事务（官方事务本身尊重给定区间）
- 钉扎段的跨轮可见性：PIN 高价值短内容（用户要求）若在保留尾之外，压缩后**仍应注入**
  （每轮固定小段，~100-200 token，来源=ledger 高 authority observation）——这就是
  「记忆与用户要求重点不丢」的兜底

### 5.3 内容感知瘦身（slimmer.mjs）——tool 输出主战场
- 注册为 ctx.get('toolResultPruner') 的自研实现（官方结构：pruneSession(session): PruneResult，
  可重放、遵守影子价格协议）→ compaction-basic 自动使用
- 或独立于压缩在 tool/result 落地时瘦身（替换超大 result 为保留段）
- 策略（按内容类型，非固定 head/tail）：
  - 错误/stderr：保留尾部错误段 + 头部摘要行（诊断信息价值在尾部）
  - JSON/结构化：保留结构骨架 + 数组长度标注 + 关键字段采样
  - 长文本/日志：保留头尾 + 中间折叠计数
  - 文件读取：保留路径 + 行数 + 关键片段（若 ACP 已存全文则只留指针）
- 可回退：内容类型识别失败 → 官方 head/tail 策略
- 与官方 pruner 关系：默认替换官方版（卸载插件即恢复）

### 5.4 无效日志/僵尸清理（sweeper.mjs）
- 识别（确定性）：
  - 孤儿 tool-call（无配对 result）与已被 replace 遮蔽的段（compaction shadowedSeqs 可查）
  - 同工具连续多次调用中，被最后一次结果取代的前序结果（supersede 检测：同 toolName + 同参数指纹）
  - 失败中间产物：失败 tool 结果后同目标成功 → 失败段降级 SWEEP
  - permission/approval 噪音（非敏感、重复）
  - 超长 stderr 已解决（后续无相关错误引用）
- 执行：官方 compactRegion 事务移除（平衡边界内），每段留 audit
- 保守原则：拿不准就 SLIM 而非 SWEEP（宁可瘦身不可丢信息）；用户可设 aggressive 档

### 5.5 归档（archiver.mjs）——先沉淀后压缩
- SWEEP/FOLD 前：把区间内高价值内容写入 ACP ledger（ctx.acp.append，带 sourceRef 指向
  sessionEventId；ACP 离线时跳过——有 ACP 已摄入的事件不必重复）
- 摘要即证据：FOLD 的 checkpoint 摘要写入 ledger 为一条 observation
  （subject=session 标识，text=摘要，evidenceIds=被压段证据 id，supersedes 链关联）
- 效果：压缩后任何被压内容可经 ACP recall 找回；lineage = 递归总结链

### 5.6 摘要（summarizer.mjs）——继承官方、增强保护
- extends BasicCompactionEngine：
  - 覆写 summarize(input, agent, signal)：先跑 archiver（归档区间内容）→ 再调官方摘要
    （或增强版：摘要 prompt 注入「以下为必须保留的关键事实」清单——来自 ledger PIN observation）
  - 其余（事务/锁/收缩校验/影子价格）全复用
- 钉扎协同：FOLD 区间选择时排除 PIN 段（见 5.2）

### 5.7 策展报告与审计（report.mjs）
- 每次策展（SLIM/SWEEP/FOLD）写审计行：时间/类型/范围 seqs/token 前后/归档条目 id/摘要预览
- /context-guardian status：当前上下文预算占用、近 N 次策展、PIN 段清单
- 审计可导出（对齐 ACP export）

## 6. 配置全表（全部用户可调；设置页 + settings.yaml）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | bool | true | 总开关 |
| trigger.userRatio | number | 0.40 | 预检触发阈值（占 contextWindow 比例；用户主旋钮 0.2-0.8） |
| trigger.minTokens | number | 30000 | 低于此总 token 不触发（小会话不折腾） |
| trigger.eventSlim | bool | true | tool/result 落地即瘦身 |
| slim.thresholdChars | number | 4000 | 超过即瘦身的 tool 输出长度 |
| slim.tailChars | number | 800 | 错误类保留尾部长度 |
| slim.headChars | number | 800 | 文本类保留头部长度 |
| sweep.enabled | bool | true | 僵尸/无效日志清理 |
| sweep.aggressive | bool | false | 保守(false)/激进(true) 清理档 |
| fold.retainRatio | number | 0.16 | FOLD 保留尾比例（透传官方） |
| pin.enabled | bool | true | 钉扎段保护 |
| pin.inject | bool | true | 压缩后仍注入 PIN 摘要（~150 token） |
| archive.enabled | bool | true | 先沉淀后压缩（需 ACP 在线；离线自动跳过） |
| summarization.provider | string | '' | 摘要模型 provider（空=跟随对话模型；可配便宜/本地模型） |
| summarization.model | string | '' | 摘要模型名（与 provider 成对；空=跟随） |
| summarization.allowLocal | bool | true | 允许把摘要路由到本地/pi-ai 网关 provider（智能路由用） |
| debug | bool | false | 调试日志 |

## 7. 分阶段计划（全部规划，里程碑落地合并 main）

- **M1 骨架与触发**（可独立交付）：插件骨架 + Config/设置页 + trigger 预检接入官方事务 +
  手动命令 + 审计表。验收：挂载后能按 userRatio 触发一次官方 FOLD，报告可见
- **M2 清理主战场**（tool/日志）：slimmer（替换官方 pruner）+ sweeper（僵尸/无效清理）+
  事件触发。验收：长会话 tool 堆积被自动瘦身/清理，token 占用明显下降，无信息事故
- **M3 保护与归档**：pinner（钉扎排除 + PIN 注入）+ archiver（先沉淀后压缩 + 摘要即证据）。
  验收：压缩后用户要求与 goal 仍在；被压内容可经 ACP recall 找回
- **M4 增强摘要与打磨**：summarizer 知识感知摘要 + 报告/观测完善 + 长期会话回归。
  验收：多轮压缩会话无关键信息丢失（对比基线）
- 每里程碑：独立 feature 分支 → 测试全绿 → 文档同步 → squash 合并 main（沿用既有流程）
- 附带独立小修：ACP extract.mjs 对 user/ 前缀事件检查 source.kind==='plugin' → 降权/跳过
  （防御性；可先行单独提交）

## 8. 测试计划

- 单元：classifier 分级规则表、slimmer 各内容类型策略、sweeper 僵尸识别、pinner 排除逻辑、
  trigger 阈值计算
- 集成（mock session/event + fake tokenMeter/llm）：SLIM/SWEEP/FOLD 全链路、与官方事务共存
  （同一把锁）、双 auto 防护测试（挂载后不得双压）
- 回归：挂载本插件前后官方 /compact 行为不变；卸载即恢复
- 真实回归用例：拿现有超长会话（ee1a/75a4）回放——统计可瘦身/清理的 token 占比（作为 M2 验收基线）
- 门禁：vitest/tsc 全绿（沿用 dsh 风格）或 node --test（沿用 ACP 风格）——与 repo 形态一致

## 9. 决策记录与开放问题

### 已拍板（2026-09-03 用户）
1. 命名：**dsh-context-maid**（repo：D:\\DSH_workspace\\my-plugins\\dsh-context-maid）
2. repo 位置：my-plugins/（与 ACP 同）
3. 工具链：mjs + node --test（与 ACP 一致，轻量）
4. sweep aggressive 档：**保留意见**——设计保留 sweep.aggressive 配置项，默认 false（保守）；
   是否加审批门待后续讨论
5. **新增需求：compact 模型用户可配 + 智能路由端点**（见 §5.8 与 §6 配置扩展）

### 剩余开放问题
1. **继承 vs 旁路**：M1-M3 推荐「挂 auto:false 官方后端 + 自研触发/清理走官方事务」；
   M4 summarize 增强需要继承 BasicCompactionEngine——同进程只能有一个 ctx.compaction 实现，
   继承注册会替换官方实例（卸载恢复）——按此推进，如有异议随时提
2. **钉扎段技术细节**：PIN 段压缩范围排除的实现路径需在 M3 前 spike（selectCompactableRange
   是模块函数不可继承；可能需在 range 计算后自校验/或 fork 官方 region 逻辑）——spike 先行
3. **ACP 依赖方向**：通过 ctx.acp 可选服务（ACP 不在线自动降级），不制造硬依赖
4. **审计存储**：独立 SQLite（与 ACP 一致模式）
5. **与官方 pruner 并存**：替换官方 tool-result-pruner 后，command-compact 等仍正常工作
   （结构兼容）——需在 M2 验证

### §5.8 新增：compact 模型配置与智能路由端点（用户 2026-09-03 拍板）
- 动机：摘要任务不需要最强模型——用户可配便宜小模型或本地模型（如局域网 LM Studio /
  OpenAI 兼容网关）进一步节约预算；同时给「LLM 智能路由」提供接入端点
- 现状基础：DSH 的 llm-pi-ai 网关适配器（base 依赖，dormant 零路由）可把 OpenAI-compatible
  端点注册为 provider；compaction-basic 原生支持 summarizationProvider/summarizationModel 字段
- maid 设计（配置 + 可选服务）：
  a) \`summarization.provider\` / \`summarization.model\`：用户指定摘要模型；**留空 = 跟随对话模型**
     （默认，零配置可用）
  b) 设置页可填 provider/model（提示可用 provider：deepseek-official、deepseek-vision、
     本地 pi-ai 网关等）
  c) 智能路由接入点：maid 暴露 \`maid.resolveSummarizationTarget(session, defaultTarget)\` 服务方法；
     外部智能路由插件可覆写决策（便宜模型优先/本地模型优先/成本感知），
     maid 自身实现 = Config 显式值 ?? 跟随对话模型；该 seam 也是未来 model-facing compact
     工具的路由口
- 注意：摘要模型质量直接决定压缩质量——文档将引导用户「便宜但别太弱；压缩是不可逆的，
  省下的预算不该用关键信息丢失来换」（与业界 Cursor/Claude 结论一致：摘要质量是最大抱怨点）

## 9.5 实测记录（2026-09-03 live，正式 web profile）

**挂载**：profile patch disable 官方 compaction-basic / tool-result-pruner，
maid 作为 ctx.compaction / ctx.toolResultPruner 唯一提供者（同 key 单提供者约束）；
bundle 只允许同 id 配置覆盖，禁止二次插入（否则 boot 报 duplicate loader entry id）。

**/context-maid status 实测**：
```
engine: ctx.compaction = MaidCompactionEngine（maid 提供，阈值映射生效）
userRatio: 0.4（→ 官方 thresholdRatio）
enabled: true
```

**/compact 实测**：压缩 761 条历史记录（≈372,810 tokens）成功——
事务由 MaidCompactionEngine 继承的官方路径执行（阈值映射未破坏事务语义）。

**发现与修复（commit 6b4d680）**：压缩成功但 maid_audit 0 行——archiver
旧实现把 audit 写在 acp.append 之后且依赖 ACP 在线解析（ctx.get('acp')），
任一前置 return（ACP 不可达 / 摘要空）都无痕，无法区分「事件未达」与
「归档路径断开」。修复：**audit-first**——compaction/summary 事件到达即写
审计（op=fold，detail 记录归档结果或跳过原因），ACP 归档降为可选附加；
acp 解析多路兜底 ctx.get('acp') → ctx.acp。测试同步更新
（ACP 离线 → 不 append 但审计留痕）。重启后 /compact 应见 maid_audit 落行。

**联动防御（ACP commit c75544a）**：压缩 checkpoint 消息（user/message +
surfaceOp={op:replace}）与插件源消息不再冒充 user_input 入 ledger。

## 10. 参考

- 本地：dsh-compaction-survey.md §5 扩展点 / §6 缺口 / §7 接口面
- 业界：context-mgmt-survey.md §3 洞察（1/2/3/4/5/7/8 直接对应本设计）
- 官方源码：packages/compaction/{compaction,compaction-basic,compaction-tool-result-pruner,command-compact}
- 我们的资产：ACP ledger/authority、consolidation 管道（刚修复）、work-continuity（P1-5/P1-6）、weaver
