---
id: DOC-RESEARCH-PEER-SURVEY-20260909
status: draft
surveyed_on: 2026-09-09
scope: dsh-context-maid 同类插件与相邻项目同行调研
---

# dsh-context-maid 同行调研与可吸纳方法（2026-09-09）

## 0. 调研方法与范围

- **取证通道**：`gh` 2.98.0（账号 Icstick，keyring 认证）。星数一律用
  `gh api repos/<owner>/<repo> --jq '.stargazers_count'` 实测；README/源码用
  `gh api .../readme -H "Accept: application/vnd.github.raw"` 与
  `.../contents/<path> -H "Accept: application/vnd.github.raw"` 落盘后读取。
- **实测时间**：2026-09-09 20:20–20:35（UTC+8）。所有星数为该时刻快照。
- **读到的深度**：12 个 DSH 生态项目的 README 原文；其中 3 个另取源码原文
  （premise-guard 的 README 机制表、harness-memory 的 `index.js`、billion-context 的
  工作原理表）。生态外取 LLMLingua / contextkit / compact-memory 的 README 原文
  与 Claude Code 官方博客（2026-04-15）正文。
- **本仓现状基线**：`AGENTS.md`、`README.md`、`docs/DEVELOPMENT-PLAN.md`、
  `docs/design.md`、`docs/design-0.3.0.md`，以及 `src/engine.mjs`、`src/pinner.mjs`、
  `src/sweeper.mjs` 的关键函数原文。
- **没做什么**：没有安装/运行任何同行插件（结论全部来自原文，非行为实测）；
  没有做压缩质量对比实验；Codex CLI 的 compaction 细节只拿到二手摘要
  （release notes 提及 "token-budget context / history notes / new_context tool"），
  **本文件不据此下结论，标注为待核验**；`988hj7tczd-oss/harness-memory` 无独立仓库
  （GitHub API 404），实际位于 `988hj7tczd-oss/harness-desktop` 的
  `plugins/harness-memory` 子目录，按目录内容 API 取到源码。

## 1. 我们的定位（一句话）

把「清垃圾」和「护重点」拆成两条独立路径的自动策展层——**继承官方两个引擎接缝**
（`ctx.compaction` FOLD / `ctx.toolResultPruner` SLIM）而非另起一套压缩实现，五级
PIN/KEEP/SLIM/SWEEP/FOLD，折叠前 PIN 钉扎软保护 + 先归档后压缩（→ ACP ledger）。

## 2. 同行地图

| 项目 | ★ | 做什么 | 与我们的关系 |
|---|---|---|---|
| [Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh) | 77 | 模型驱动压缩（ACP 移植）：compress/decompress/search_context 工具 + nudge，不做自动摘要 | 同赛道最强对手；其**记账货币纪律**直接可吸纳 |
| [aerince/dsh-active-context-pruning](https://github.com/aerince/dsh-active-context-pruning) | 2 | 走官方 `ctx.compaction.compactRegion`，模型自写摘要替换 seq 范围 | 同路线（用官方接缝），约束比我们更严 |
| [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) | 1308 | 上下文可视化面板：组成/演进/压缩与剪枝事件逐条归因 | 生态里最成熟的**观测面**；我们审计 schema 的目标形状 |
| [Zhenyu98/dsh-context-doctor](https://github.com/Zhenyu98/dsh-context-doctor) | 29 | 只读审计常驻注入物（AGENTS.md 链/技能 catalog/tool schema/MCP）token 成本 + 重复块/冲突检测 | 审计我们**够不着**的那一半注入面 |
| [GooDAnDreaDY/dsh-context-lens](https://github.com/GooDAnDreaDY/dsh-context-lens) | 0 | AST 骨架化 + 日志冷凝 + 焦点路径 + 预算追踪 | SLIM 的相邻做法（结构保留 vs 内容保留） |
| [ICCuse/dsh-premise-guard](https://github.com/ICCuse/dsh-premise-guard) | 1 | 压缩后**校验摘要是否丢了关键字面锚点**，丢了就一次性通知模型 | 直接补我们 C6 的空白，机制可原样搬 |
| [dream12347/dsh-session-manager](https://github.com/dream12347/dsh-session-manager) | 63 | 会话管理 + 全局压缩阈值（17%–90%，保留 16%） | 独立实现，数值与我们的 `fold.retainRatio 0.16` 完全一致 |
| [PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) | 105 | 分层记忆 + 审批门 + 硬预算（满仓结构化拒绝，绝不截断） | 预算哲学与我们**相反**，值得对照 |
| [dsh-external/dsh-agent-budget](https://github.com/vibeinging/dsh-agent-budget) | 2 | 预占-结算式 token 准入 + `accuracy: reported\|estimated\|uncertain` | 记账三态口径的来源 |
| [scottfalconer/compact-memory](https://github.com/scottfalconer/compact-memory) | 0 | 压缩引擎插件化 + `ValidationMetric` 评测框架 | 我们 C6 抽检缺的「指标定义」 |
| [drandrewlaw/contextkit](https://github.com/drandrewlaw/contextkit) | 1 | 三层压缩：micro-compact（免费）/ auto-compact（LLM）/ 熔断 | 印证我们的分层，且我们**缺熔断** |
| [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) | 6639 | token 级提示压缩（最高 20x，LongLLMLingua 1/4 token） | 反向参照：我们不做 token 级改写 |
| [zhukunpenglinyutong/desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui) | 4184 | 多引擎桌面客户端；Context Ledger 列 token/字符估算 + 新鲜度 + 归因置信度 | 记账字段设计参照 |

## 3. 可吸纳的方法（核心）

### 🔴 P0-1：压缩后「锚点丢失校验」——把软保护变成可验证的保护

- **出处**：[ICCuse/dsh-premise-guard README「How it works」](https://github.com/ICCuse/dsh-premise-guard/blob/main/README.md)。
- **它怎么做**：在 `session/event` 的 `compaction/summary` 钩子里，用 `shadowedSeqs`
  从 append-only 日志重建被遮蔽区间的原文，**确定性抽取字面锚点**（文件路径、引号字面量、
  `key=value`、错误码），再与已提交的 `event.data.summary` 做包含比对；发现关键锚点
  消失就在下一次 `agent/pre-step` 注入**一次性通知**，告诉模型丢了什么、怎么从日志找回。
  全程零 LLM、零新存储。参数：`maxAnchors 5` / `minAnchorLength 6` / `maxNoticeChars 400`。
- **我们现状**：`src/engine.mjs:173-219` 的 `summarize` 只做**事前**注入——
  收集 PIN → `buildPinInstruction`（`src/pinner.mjs:81`）→ 作为 user message 追加
  （`engine.mjs:199`）。摘要写完之后**没有任何校验**：PIN 有没有真的进摘要、进了多少，
  我们不知道。`docs/DEVELOPMENT-PLAN.md` 里 MAID-B6（C6 质量抽检）仍是 `planned`，
  且原方案是「无损启发式抽检或低频 LLM judge」——成本高、门槛高。
- **建议**：C6 第一版直接降级为 premise-guard 式确定性锚点比对——对 PIN 段做字面命中
  检查（零 LLM、零新存储），结果落 `audit` 的 `op=pin`，`/context-maid status` 展示
  「上轮折叠 PIN 命中率」。

### 🔴 P0-2：记账货币纪律——绝不混用两套计价

- **出处**：[billion-context-dsh README「工作原理」表 · 压缩记账（影子价格）行](https://github.com/Tyan66666/billion-context-dsh/blob/main/README.md)，
  对应其 issue #54 / #103。
- **它怎么做**：`shadowedTokenCount`（宿主占用率据此扣减）**只**用宿主 token-meter 的
  固定启发价计价；README 明确写下两条禁止：① 绝不混用插件内部的 CJK 感知估算
  （「那是展示货币」，混用会把宿主账本扣成负数、卡死中文会话）；② 绝不按路由重定价的
  `node.tokens` 计价（图片路由下那是请求压力价，读它会让 claim 虚报视觉价）。
- **我们现状**：`src/audit.mjs` 与 eventSlim 实测（`docs/DEVELOPMENT-PLAN.md` 0.3.0 实测行
  「21 pruned/217 checked（-134712 chars）」）用的是**字符口径**；PIN 预算
  （`pinner.mjs:74-78`，1800 字符 ≈ 600 token @3 chars/token）用的是**估算 token**。
  两套货币同仓共存，但**没有任何地方显式声明它们不可换算、不可写回宿主**。
- **建议**：在 `audit.mjs` 记录里加 `unit` 字段（`chars` / `estTokens`），并在 README
  与 design.md 各写一行「审计口径不写回宿主账本」的硬约束。

### 🟠 P1-1：审计 schema 对齐「可归因事件」

- **出处**：[bowenliang123/dsh-context README「Context Events — when and why the window changed」](https://github.com/bowenliang123/dsh-context/blob/main/README.md)。
- **它怎么做**：每一次 injection / compaction / prune / model switch 都记一条事件，字段为
  **producer（instruction file / plugin id / skill name）+ net token delta（压缩显示回收量）
  + turn/step + 时间**，并用 Inject/Compact/Prune/Switch/Mode 五个 chip 过滤。
- **我们现状**：`docs/DEVELOPMENT-PLAN.md` MAID-B6 明确写「audit.mjs op 枚举已预留
  slim/sweep/pin，**当前仅 fold 有写入方**」——即我们现在只有折叠有完整留痕，
  瘦身/清扫/PIN 三类动作**无审计行**，面板拿不到「谁在什么时候动了什么、动了多少」。
- **建议**：把 slim/sweep/pin 的审计写入补全，字段按 dsh-context 形状对齐
  （producer / delta / turn / step / unit / time）。

### 🟠 P1-2：常驻注入物的成本分项与重复块检测

- **出处**：[Zhenyu98/dsh-context-doctor README「审计内容」表](https://github.com/Zhenyu98/dsh-context-doctor/blob/main/README.md)。
- **它怎么做**：把注入面切成互不重叠的四项（指令链 / 技能 catalog / 内置工具 schema / MCP），
  每项给 token 估算；并做**跨文件完全相同的重复段落**检测与同名技能 rank-shadow 冲突报告。
  安全边界：单文件 >256KB 跳过、只读、报告不含正文。
- **我们现状**：我们的 SLIM 只作用于 **tool result**，SWEEP 只作用于「同工具同参数重复
  读取 / 失败后重试成功的前序结果」（`src/sweeper.mjs:84-117` 的 callId 配对）。
  **常驻注入物（AGENTS.md 链、技能目录、工具 schema）完全不在我们的清扫面**——
  README 也说 sweep aggressive 档规则未扩展。
- **建议**：sweep aggressive 档扩展时把「跨文件完全相同段落」列为确定性候选，但
  **明确划界**：注入面成本属于 inject-scheduler 的段记账域，maid 只做「重复块」这一条
  确定性规则，避免两插件对同一事实重复记账。

### 🟠 P1-3：摘要链路的熔断

- **出处**：[drandrewlaw/contextkit README「The Solution」](https://github.com/drandrewlaw/contextkit/blob/main/README.md)。
- **它怎么做**：三层压缩——**micro-compact（免费，裁旧 tool result，不调 LLM）**、
  **auto-compact（LLM 摘要）**、**circuit breaker（连续失败 `maxConsecutiveFailures: 3`
  后停止重试）**；另有 `microCompactKeepRecent: 5`、`warningBuffer` 等阈值。
- **我们现状**：`engine.mjs:213-218` 在 maid 摘要失败时 `warn` + 回落官方 `super.summarize`
  ——**回落路径有，失败计数没有**。若摘要端点持续失败（如本地网关挂了），我们会每一轮
  都重试一次并刷一条 warn，没有「连续 N 次失败就停用 maid 路由」的熔断。
- **建议**：给 `summarize` 加连续失败计数与显式降级（阈值后停用路由、只走官方回落），
  降级动作写审计行。

### 🟡 P2-1：焦点感知的瘦身维度

- **出处**：[GooDAnDreaDY/dsh-context-lens README「Active Path Focus Scoping」](https://github.com/GooDAnDreaDY/dsh-context-lens/blob/main/README.md)。
- **它怎么做**：`context_lens_focus(paths)` 设定当前正在编辑的文件/目录，**焦点内保留
  全文实现**，焦点外自动降级为 AST 骨架（类型/类/签名/导出，保留 JSDoc 与 docstring）；
  日志侧是 O(n) 启发式行过滤，剥离 ANSI 后按 raw/balanced/aggressive 三档冷凝。
- **我们现状**：`src/slimmer.mjs` 是**内容感知**瘦身（错误留尾、JSON 留骨架、日志留头尾），
  **没有「按工作焦点区分文件」的维度**——正在改的文件和被翻过的旧文件一视同仁。
- **建议**：P2 观察项。要做需依赖 fs/observed 事件并定义焦点来源（用户指定 vs 最近编辑
  推断），成本高于收益；先记入 backlog，不进近期里程碑。

### 🟡 P2-2：抽检的指标定义

- **出处**：[scottfalconer/compact-memory README「Developing Engines: The Framework」](https://github.com/scottfalconer/compact-memory/blob/main/README.md)。
- **它怎么做**：`BaseCompressionEngine` 抽象基类 + `ValidationMetric` 指标套件 +
  entry-point 插件系统，让压缩引擎可被独立评测与共享。
- **我们现状**：C6（MAID-B6）只说了「无损启发式抽检 / 低频 LLM judge」，**没有定义
  指标**——「抽检通过」目前不可判定。
- **建议**：C6 落地时先写 2–3 个可计算指标（PIN 锚点命中率、摘要长度比、被遮蔽原文
  可检索率），再谈抽检频率。

## 4. 印证我们判断的地方

- **premise-guard 独立走到「压缩摘要必须被校验」**——与我们的 MAID-B11（官方压缩从头压
  连续段、中段 PIN 无法硬排除）是同一个痛点的两端：我们承认软保护有洞，它给出了补洞的
  确定性路径。方向对，缺的是校验环节。
- **aerince 把「工具配对平衡 + 摘要必须比被藏内容短」写成硬约束**（README「配置与限制」）——
  印证压缩事务里配对与长度是硬边界；我们的 SWEEP 路径已按 callId 配对
  （`sweeper.mjs:84-117`，无配对则保守跳过），同一纪律。
- **dream12347/dsh-session-manager 的默认值**是「17%–90% 阈值、每次压缩保留最近 16%」——
  与我们 `fold.retainRatio 0.16` 数值一致，说明 16% 保留比例是生态里被独立验证过的经验值。
- **contextkit 的「免费 micro-compact + 智能 auto-compact」两层**——正是我们
  eventSlim（无 LLM）与 FOLD（LLM）的分层；我们的 0.3.0 实测（21 pruned/217 checked）
  就是 micro-compact 那一层在起作用。
- **dsh-context 与 context-doctor 都选择「只读观测、不接管」**——印证我们
  `AGENTS.md` 铁律 2「未接线不宣称」与「审计 first」在生态里是稀缺且被认可的姿态。

## 5. 我们不该学的

- **LLMLingua 的 token 级改写（最高 20x）**：它删的是 token，模型看到的是**不可追溯的
  失真文本**，而我们无法验证丢了什么。我们的 SLIM 是「保留结构骨架」，压缩率不是我们的
  KPI（我们没有效果实验支撑任何压缩率宣称）。学它的方法论（先测量再压缩）可以，学它的
  手段不行。
- **billion-context 的「取消自动摘要、只 nudge 模型」**：那是把压缩时机交给模型自觉。
  我们的用户价值恰恰是「不打扰用户的自动策展」——定位相反。要学的是它的**记账纪律**，
  不是它的产品形态。
- **context-lens 的「up to 85%」压缩率口径**：我们没有对应的效果实验，
  写进文档即变成不可验证的宣称，违反铁律 2。
- **context-lens 的 `autoCollapse` 式 UI 强制干预**（预算将尽就自动关掉卡片）：
  maid 是 host 插件、不碰 UI；这类行为应由消费方（面板插件）决定。
- **dsh-session-manager 的「host 在 `agent/pre-step` 把阈值写进所有预设的压缩引擎配置」**：
  它能工作是因为它管的是阈值这一个标量；maid 已经通过 `toOfficialConfig` 映射
  `trigger.userRatio`（`engine.mjs:23/48/217`），再叠一层全局写入会造成两个写者。

## 6. 落地建议（最多 3 条）

1. **C6 第一版 = premise-guard 式确定性锚点校验**（零 LLM、零新存储、约 150 行），
   结果落 `audit op=pin`。投入最小、直接补上「软保护无法验证」这个真空白。
2. **补全 slim/sweep/pin 的审计写入，字段对齐 dsh-context 的事件形状**
   （producer / delta / turn / step / unit / time）。这是 MAID-B6 的前置，也是
   `/context-maid status` 从「接线状态」升级为「行为证据」的前提。
3. **PIN 预算超限改为结构化报告**：`pinner.mjs:81-96` 现在截断后只报 `[+N more facts
   omitted]`（计数有、身份无）。改为列出被丢弃条目的 authority 与首 40 字符，
   让「丢了谁」可见——这与 memento「满仓返回 usage+limit 而非静默截断」的哲学一致。

## 7. 来源清单

**原文（README / 源码 / 官方博客，抓取日 2026-09-09）**

| 来源 | 类型 | URL |
|---|---|---|
| billion-context-dsh | README 原文 | https://github.com/Tyan66666/billion-context-dsh |
| dsh-active-context-pruning | README 原文 | https://github.com/aerince/dsh-active-context-pruning |
| dsh-context | README 原文 | https://github.com/bowenliang123/dsh-context |
| dsh-context-doctor | README 原文 | https://github.com/Zhenyu98/dsh-context-doctor |
| dsh-context-lens | README 原文 | https://github.com/GooDAnDreaDY/dsh-context-lens |
| dsh-premise-guard | README 原文 | https://github.com/ICCuse/dsh-premise-guard |
| dsh-session-manager | README 原文 | https://github.com/dream12347/dsh-session-manager |
| dsh-memento | README 原文 | https://github.com/PerryLink/dsh-memento |
| dsh-agent-budget | README 原文 | https://github.com/vibeinging/dsh-agent-budget |
| harness-memory | 源码原文（`plugins/harness-memory/index.js`） | https://github.com/988hj7tczd-oss/harness-desktop/tree/main/plugins/harness-memory |
| compact-memory | README 原文 | https://github.com/scottfalconer/compact-memory |
| contextkit | README 原文 | https://github.com/drandrewlaw/contextkit |
| LLMLingua | README 原文（含论文链接） | https://github.com/microsoft/LLMLingua |
| desktop-cc-gui | README 原文（Context Ledger 行） | https://github.com/zhukunpenglinyutong/desktop-cc-gui |
| Claude Code 会话管理与压缩 | 官方博客原文（2026-04-15） | https://claude.com/blog/using-claude-code-session-management-and-1m-context |

**二手 / 待核验**

| 项 | 状态 |
|---|---|
| Codex CLI compaction 细节 | 仅见 openai/codex release notes 摘要提及 "token-budget context / history notes / new_context tool"，**未取到一手文档，不作为结论依据** |
| 各同行插件的行为表现 | 未安装运行，结论均来自其 README/源码自述 |
| 压缩质量对比 | 未做实验，本文件不给出任何压缩率结论 |
