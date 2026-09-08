# dsh-context-maid 0.3.0 设计稿（定稿 v0.2，2026-09-08 用户拍板）

> 范围：MAID-B7 sweep 执行器 + MAID-B8 落地即瘦身 + MAID-B9 死键定夺（扩表）
> + B10 PIN 预算取舍 + B3/B4 清洁项。用户 2026-09-08 拍板立项：B7/B8 为 0.3.0 主线。
> 决策点已全部拍板（2026-09-08，六项均按推荐），记录见 §10；里程碑定稿见 §9。

## 1. 取证摘要（2026-09-08 读官方源码，防再走弯路）

### 1.1 表面（surface）事实
- 会话 = append-only 事件日志 + surfaceOp 投影。模型可见面 = surface 投影（含 replace 副本），
  人类 transcript 用 append-origin 事件（被替换原文仍在日志可追溯）。
- surface 事件仅三类：user/message、assistant/message、tool/result（均带 surfaceOp）。
- replace = 位置语义：新节点取代 surface 上 [start, end] 位置段，原节点被 shadow。
  契约（compaction/prune 定价事件）：model-free 替换前必须同步 append compaction/prune
  事件定价（shadowedRange/shadowedSeqs/shadowedTokenCount），随后紧跟 replace——相邻性是契约。
- tool/result 事件 data：message.content[0] = ToolResultMessage（result.content 为内容块、
  message.source.callId 配对工具调用）；tool-call 嵌在 assistant/message 的 content blocks 里
  （block.type === 'tool-call'，无独立 'tool/call' 事件）。
- 工具配对平衡（tool-pairing）：assistant/message 每含 N 个 tool-call block → 计数 +N；
  tool/result → -1；切点平衡才可切（压缩不能把 call 与其 result 切开）；result 无 call = corrupt。

### 1.2 压缩事务
- compactSurfaceRegion(session, start, end, ...)：接受任意区间（非只能从头压），
  事务 = compaction/start（锁）→ summarize → replace + compaction/end；stability whole-surface | selected-span。
- BasicCompactionEngine 公共缝：compactIfNeeded(agent, trigger, signal)（动态派发，子类可覆写）、
  compactRegion(start,end,agent,signal)（owner=current-turn，需 open turn）、
  compactNow(agent,signal,sourceCommandId)（owner=null，需 idle + agent.runMaintenance）。
- 官方 auto：构造时注册 agent/pre-step 监听 → this.compactIfNeeded(agent,'pressure',signal)——动态派发 =
  maid 覆写 compactIfNeeded 即插入官方逻辑之前的钩子。
- 官方 pressure 分支顺序：measure → resolveModelInfo（失败直接 throw，早于任何清理）→
  达标则 prune.pruneSession(session)（若注册了 pruner）→ remeasure → selectCompactableRange
  （head-anchored，从头选，保留 priced 尾部、不切配对）→ compactRegion 循环（compactionRetries）。
- selectCompactableRange 为模块函数不导出；maid 不需要它（用继承方法）。

### 1.3 ToolResultPruner（model-free 迷你化标准做法）
- pruneSession(session)：遍历当前 surface 全部 tool/result 节点 → 超预算者逐节点
  compaction/prune 定价 + tool/result replace（surfaceOp replace 自身位置，sourceEventSeqs 溯源）
  + 返回 { pruned, charsRemoved }。不依赖 LLM、不走压缩锁——这就是 sweep/落地瘦身共用的落地机制。
- MaidSlimmer 已继承并覆写 pruneContent（json 骨架 / error 头尾 / 官方回退），
  当前仅经官方 compactIfNeeded 压力路径被调用（压力合格才清）。

## 2. 现状缺口全景

### 2.1 死键/误导键全表（B9 扩表——比 backlog 登记多两个）
| 键 | 现状 | 去向（2026-09-08 已拍板） |
|---|---|---|
| trigger.minTokens | 死键（无消费方；官方阈值 = 窗口比例制） | **删键**（M7） |
| trigger.eventSlim | 死键（backlog B9 漏登记！B8 的天然开关位） | **激活**（M5，B8；默认 true） |
| sweep.enabled | 死键（sweeper 无执行器） | **激活**（M6，B7） |
| sweep.aggressive | 死键 | **激活**（M6，B7；语义见 A1，默认 false） |
| pin.inject | 死键（逐轮 PIN 注入未接线） | **删键**（M7）——逐轮注入 = ACP Composer 单轨职责；摘要内 PIN 注入（已实现）保留 |
| summarization.allowLocal | 死键（智能路由已覆盖意图） | **删键**（M7） |

### 2.2 sweeper.mjs 事件模型过时（B7 前置必修）
- 扫描假设 type === 'tool/call'——该事件不存在（tool-call 嵌 assistant/message）。
- 扫描输入是 events[]（全日志视角）——应改为 surface 投影视角（surface.nodes → eventAt(seq)），
  与 pruner 一致；shadowed 旧节点对模型不可见、无需清。
- 返回「区间建议」——实际处置是节点级（见 §4）；区间折叠应留给 FOLD，sweep 不做 LLM 折叠。

## 3. 设计总纲（一个覆写点 + 两个执行器）

    agent/pre-step（官方 auto 已监听，动态派发）
      └─ MaidCompactionEngine.compactIfNeeded（覆写）           ← 唯一新增入口
           ├─ 1) eventSlim 增量瘦身（B8，trigger.eventSlim）    ← 只处理上次之后新落地的超预算 tool/result
           ├─ 2) sweep 增量清扫（B7，sweep.enabled）            ← 只处理新确认的垃圾节点
           └─ 3) super.compactIfNeeded(agent, trigger, signal)  ← 官方原逻辑（测压/FOLD/overflow）

理由：
- 官方 auto 监听调用的 this.compactIfNeeded 动态派发 → maid 覆写即成为每次 step 的入口，
  不需要第二个 pre-step 监听（避免与官方 FOLD 的 listener 顺序/锁竞争）。
- 1) 2) 都是 model-free 节点处置（pruner 协议），无锁、幂等、失败不影响 3)；
  3) 内部的官方 pruneSession 对已瘦身节点自然空转（幂等）。
- 溢出触发（context-overflow）同样先进覆写 → 溢出恢复前先清垃圾，提高恢复成功率。
- 附带修复官方行为缺口：官方 pressure 分支 resolveModelInfo 失败即 throw、清理永不发生；
  maid 覆写把清理放在模型解析之前 → 无模型信息也能瘦身/清扫（fail-open）。

## 4. 设计 A：sweep 执行器（B7）

### A1 扫描器重构（sweeper.mjs）
- 输入改为 surface 迭代：for (const seq of session.surface.nodes) + session.eventAt(seq)。
- 工具配对状态机按真实事件模型重写：
  - assistant/message → 逐个 content block（type=tool-call）取 name + 关键参数键
    （file_path/path/url/repo/file/query，复用现 toolFingerprint 思路）→ 记录待配对 call（callId）。
  - tool/result → 依 message.source.callId 配对 → 记录 { fp, ok, seq }。
- 识别规则（保守档）：
  1. superseded-read：同指纹成功 result 出现 ≥2 次 → 前序成功 result 节点建议 stub
     （保留最后一份；指纹含工具名+路径键，参数指纹防大参数入键）。
  2. failed-retry：同指纹 失败→后续成功 → 失败 result 节点建议 stub。
- aggressive 档（开启才放宽）：指纹放宽（同工具 + 同目录/前缀文件多次读）、
  连续失败批次（同工具连续 ≥2 失败且后有同工具成功）整批建议 stub。
- 明确不做：孤儿 tool-call 段（assistant/message 含未配对 call = 正在执行/执行中，
  tool-pairing 约束下不可切；保持保守）。
- 输出：[{ seq, kind, reason }]（节点级；不再产 startSeq/endSeq 区间）。

### A2 处置执行器（新函数 sweepStubs，sweeper.mjs）
- 对每个建议节点：原文本换为一行 stub 标记
  （如 [maid sweep: superseded-read —— 同工具同参数前序结果已被后序取代]），
  保留 message envelope、callId、rich blocks 顺序；走 compaction/prune 定价 + replace 协议。
- 审计：op=sweep（audit.mjs op 预留已有写入方），detail 记录 kind/reason/原 seq→新 seq。
- 与 pruner 的关系：sweep 是「结构性无价值」处置（整段内容无保留价值），
  slim 是「有价值但超预算」处置（留头尾/骨架）——互斥不重复。

### A3 触发与频率（并入 §3 覆写点 2)
- sweep.enabled=false 默认不变；开启后每 step 增量执行（增量状态 = 上次扫描到的 surface
  位置，只处理新节点；无需冷却键——垃圾是确定性的，处理完即无）。
- 处置量天然有界：每次 step 最多 N 个新垃圾节点。

## 5. 设计 B：落地即瘦身（B8，激活 trigger.eventSlim）

### B1 语义
- 「落地即瘦身」= 超预算 tool 输出在下一次模型请求前已被迷你化——目标省的是
  后续请求的携带成本，而非 append 时刻的内存（append-only 日志本来就不回收）。
- 因此正确触发点不是 tool/result append 的同步时刻（session/event 内 replace 与 agent
  回合写入竞争，风险高、收益零），而是 step 边界（pre-step）：上一回合的 result
  在下一模型请求前完成瘦身，语义与收益等价。
- 实现即 §3 覆写点 1)：增量遍历 surface 上新 tool/result 节点 → MaidSlimmer.pruneContent
  判定 → 超预算者 pruner 协议 replace（compaction/prune + tool/result replace）。
- 幂等：已瘦节点不再超预算；官方 FOLD 前的全量 pruneSession 自然空转。
- 审计：op=slim（audit op 预留），detail 记录原 seq→新 seq、charsBefore/After。
- 已拍板（D2）：eventSlim 默认 **true**（阈值 4000 保守、错误留尾/JSON 骨架保留诊断，
  信息事故风险低；这是 maid 核心价值）。

### B2 边界情形（实现期 dev 实例验证项）
- 工具循环内（多 tool 连续执行、中间无 pre-step）的 result 不即时瘦身——接受：
  循环内 result 通常需要即时喂给下一模型请求，瘦身反而可能截断正在用的信息。
  真正收益点在回合间（跨 user 消息的多次 step）。
- 与 context-overflow 的关系：溢出恢复也先走 1) → 恢复输入已瘦身。

## 6. 死键定夺（B9 扩表，决策点 D3/D4）

| 键 | 推荐 | 理由 |
|---|---|---|
| trigger.eventSlim | 激活（见 §5） | B8 开关位 |
| sweep.enabled / sweep.aggressive | 激活（见 §4） | B7；aggressive 语义见 A1 |
| trigger.minTokens | 二选一：实现（pressure 判定加 totalTokens < minTokens → 不触发，约 3 行）or 删 | 官方比例制下收益低；实现成本极低 |
| pin.inject | 删键 | 逐轮注入 = ACP Composer 单轨职责（rules/memory 段常驻注入）；maid 双轨重复且无 ACP 时无源可注；摘要内 PIN 注入（已实现）保留 |
| summarization.allowLocal | 删键 | 意图已被 summarization.provider/model 直配本地网关 + 智能路由 resolver 覆盖；键语义含糊 |

## 7. B10 PIN 预算（已拍板 D5：并进 0.3.0，随 M7）
- collectPinnedFacts 输出无上限（ACP 高权威 observation 增长后 summarize 输入成本上升）。
- 实现：buildPinInstruction 前加预算 ≤600 token（≈1800 字符按 3 字符/token 估）：
  截断 + [+N more] 计数标注；超出时按 authority 优先级保留（user_explicit/user_correction > system_policy）。
- 成本：pinner.mjs 内纯函数改造 + 1-2 测试。建议并进 0.3.0。

## 8. 清洁项（先行提交，不占里程碑）
- B3：commands.mjs 头注删除/改写（执行命令确实不提供，README 已诚实）。
- B4：lint 清零（slimmer.mjs 死 import codePointLength、archiver.mjs:64 转义、
  test 6 个未用参数）——0.3.0 实现前的卫生前提。
- 死键删除后的 Config/README/测试同步（键删除 = 破坏性变更，0.3.0 bump 时一并说明）。

## 9. 里程碑定稿（2026-09-08 拍板 D6：C0→M5→M6→M7 序列；feature 分支 + squash 合并 main）
- C0 清洁（不 bump）：B3 注释 + B4 lint 清零。验收：pnpm lint 归零、36 测试绿。
- M5 落地瘦身（feat/m5-event-slim）：覆写 compactIfNeeded 1) + eventSlim 激活 +
  slim 审计写入 + 测试（增量幂等/触发/审计）。验收：长会话 tool 输出每回合间被瘦身，
  audit op=slim 落行，无信息事故。
- M6 sweep 执行器（feat/m6-sweep）：sweeper 重构（surface 视角+真实事件模型）+ sweepStubs +
  aggressive 语义 + sweep 审计 + 测试（黄金套件重写）。验收：superseded-read/failed-retry
  被清、audit op=sweep 落行、配对平衡不破坏。
- M7 收口：死键落码（删 trigger.minTokens / pin.inject / summarization.allowLocal）+ B10 PIN 预算 +
  README/design 同步 + version 0.3.0。验收：全绿 + 文档诚实。

## 10. 决策记录（2026-09-08 用户拍板，六项均按推荐）

| # | 决策 | 结论 |
|---|---|---|
| D1 | sweep 处置深度 | **A：model-free 节点 stub**——整节点替换为一行标记（pruner 协议、无 LLM、原文日志可溯）；区间折叠留给 FOLD |
| D2 | eventSlim 默认值 | **默认 true**——落地即瘦身开箱即用（阈值 4000 保守） |
| D3 | trigger.minTokens | **删键**（官方比例阈值已够用） |
| D4 | pin.inject / summarization.allowLocal | **删键**（逐轮注入归 ACP Composer 单轨；本地模型意图已被 provider/model 直配覆盖） |
| D5 | B10 PIN 预算 | **并进 0.3.0**（M7：≤600 token 截断 + 计数，authority 优先级保留） |
| D6 | 里程碑切分 | **C0 清洁 → M5 eventSlim → M6 sweep → M7 收口**（独立分支 + squash 合并 main） |

## 11. 开放问题（实现期验证，不阻塞设计）
1. pre-step 内 maid 覆写里做多个 append（replace）与官方 FOLD 的 measurement 时序——
   需 dev 实例实测（预期：先清后测，官方逻辑在 super 内自然重测）。
2. token meter 对 replace 后 surface 的估算一致性（compaction/prune 定价协议已保证消费者减法正确）。
3. sweep 指纹放宽（aggressive）的误伤率——golden 集挂历史-issue fixture 回归。
4. maid 依赖官方 npm 发布物（lib/ 导出面）与源码树（D:\deepseek-harness）的 API 差异——
   写码前以 maid 仓库 node_modules 解析的发布物 d.ts 为准。
