---
id: DOC-RESEARCH-INDUSTRY-SURVEY-20260921
status: draft
surveyed_on: 2026-09-21
scope: 业界主流 Agent 上下文压缩策略（生态外）→ dsh-context-maid 逐条对照
---

# 业界六家上下文压缩策略 → dsh-context-maid 对照（2026-09-21）

> 与 [PEER-SURVEY-20260909.md](PEER-SURVEY-20260909.md) 互补：那份看 DSH 生态内的兄弟插件，
> 这份看生态外的主流 Agent。两份合起来 = maid 的横向坐标。

## 0. 方法与范围

**被对照的一手材料**

| 材料 | 位置 | 用法 |
|---|---|---|
| 文章全文（11 页 PDF） | 知乎专栏，腾讯技术工程 / mervynyang，2026-06-08（3.x 节 2026-05-13 补） | 被对照的业界主张 |
| 官方压缩源码 | `deepseek-harness/packages/compaction/compaction-basic/src/{region,index}.ts` | 判定 maid 在压力维度上的真实行为 |
| maid 源码 | `src/{engine,slimmer,sweeper,pinner,archiver}.mjs` | 现状 |
| maid 设计文档 | `docs/design.md`、`docs/design-0.3.0.md`、`docs/DEVELOPMENT-PLAN.md` | 设计意图 vs 实际 |
| **本机 maid 真实审计** | `%DSH_HOME%/context-maid/maid.db`（只读查询，快照见 §8） | 行为实测，本文最强证据 |
| 运行探针 | `%DSH_HOME%/context-maid/maid-trace.log` | 触发路径实测 |

**外部核查已完成**（子代理独立执行，详见 §7）：文章 10 条关键断言中
**4 条完全属实、5 条部分属实或有错、1 条完全未取到**——而其中最吸引人的 Claude Code
内部实现部分（五段流水线、`cached_microcompact`）**在本机 Claude Code 2.1.202 官方二进制里零命中**。
因此本文对文章的使用一律限定在「设计思路」层，**不采信其产品行为细节**。

**没做什么**：没跑压缩质量 A/B 实验；没安装任何被测产品。
**审计库是活库**——本文所有数字标注查询时刻，后续新增行会使计数增长。

---

## 1. 结论先行

1. **maid 与文章解决的是两个正交的维度，各有一半。**
   文章六家都在做**压力维度**的渐进（什么时候压、压多狠：四级水位线 / 三档熔断 / 阈值切换）；
   maid 做的是**内容维度**的价值分级（压谁：PIN/KEEP/SLIM/SWEEP/FOLD）。
   两者不冲突也互不替代——**maid 缺的正是压力维度**：当前压力控制只有两个端点
   （`userRatio=0.40` 单阈值 bang-bang，与 `trigger.eventSlim` 常开），中间没有过渡档。

2. **共识第 3 条「增量摘要」maid 已实质满足**，且是源码级确认：
   官方 `selectCompactableRange` 永远从 surface 的**起始位置**选段（`firstIdx = 0 或 1`），
   而上一轮压缩产生的 summary 节点就占据那个位置 → **每轮压缩的输入 = 旧摘要 + 上次以来的 delta**，
   正是文章说的「保留一份活的摘要，每次只把新增部分合并进去」。
   本机数据佐证：`session-4deb7491` 的 `range.start` 序列 `8 → 3601 → 9528 → 15363 → 18314 → 21285`
   严格递增，每项正是上一轮 summary 节点的新 seq。

3. **但递归深度无上限、无观测、无告警。** 同一会话实测压缩 **17 轮**（`session-4deb7491`）、
   `session-311f2b1c` 在 6.7 分钟内连压 8 轮。递归本身不是错（Amp 一度废除压缩、Neo CLI 后又回到
   「压缩 + 90% 自动触发」，说明压缩不可替代），**问题是 maid 连这个数都不记**——
   而它应当回答「本会话还要不要继续」。

4. **共识第 5 条「用户消息有特权」maid 只做到软保护，而且实测证明它守不住。**
   本机 38 次 PIN 锚点校验的分布是：

   | 命中 | 次数 |
   |---|---|
   | 0/4（**全丢**） | **4** |
   | 1/4 | 1 |
   | 2/4 | 1 |
   | 3/4 | 13 |
   | 4/4 | 19 |

   即 **50% 的压缩没能把全部可校验 PIN 事实带进摘要，其中 4 次（10.5%）一个都没带进去**；
   `session-3a99455b` 更是**连续两次压缩 0/4**。
   而这 38 次校验每次收集 16 条 PIN 事实、**只有 4 条抽得出字面锚点**（12 条「不可校验」）——
   真实丢失率是**未知的**，已知的下界已经有一半。

5. **共识第 6 条（单调边界）与文章的「存储分离」「跨轮缓存」三条，DSH 架构天然满足，maid 不需要照搬。**
   append-only 事件日志 + surface 投影 = 天然的存储分离（原文方案是落盘 + `fullLogPath` 回取）；
   压缩决策本身已持久化在事件日志里 = 天然的跨轮/跨重启一致
   （原文为此在云端用了 Redis `ReplacementCache` + 30 分钟 TTL）。DSH 在这两点上更省事，不算差距。

---

## 2. 六家做法 vs maid

| 产品 | 文章说的做法（社区来源） | maid 的对应物 | 判断 |
|---|---|---|---|
| **Claude Code** | ⚠️ **文章描述存疑**。它称五段流水线（Budget Reduction → Snip → Microcompact → Context Collapse → Auto-Compact）+ 两条服务端路径；核查在本机 2.1.202 官方二进制里对 `Budget Reduction` / `Snip` / `Context Collapse` / `cached_microcompact` / `apiMicrocompact` / `cache_edits` **全部零命中**。**实测存在的是**：`microcompact`（**时间触发**：`tengu_time_based_microcompact`、`compact_micro_keep_recent`、日志 `[KEEP-RECENT MC] context_hint trigger, cleared N tool results (~X tokens), kept last N`）与 `compact_boundary` | SLIM/SWEEP（model-free）→ FOLD（LLM）确实成本递增；`runPreCleanup` 在官方测压**之前**跑 | **对照基线需重建**。真实存在的 microcompact 与 maid 的 eventSlim **在触发形态上一致**（都是常态化、非压力触发）；差别在处置粒度（`cleared` + 保留最近 N 条完整 vs maid 的头尾各 800） |
| **Codex CLI** | ~95% 触发，旧历史换 handoff 摘要，最近 ~20k token 用户消息**原文保留** | 触发阈值 `userRatio` 可调到 0.95，但没有「用户消息原文保留」的硬规则 | **差距**（见 G2） |
| **OpenCode** | Prune（无 LLM、标记为占位符、**数据不真删**）+ Summary（超上限才触发，五段摘要后**回放用户最后一条消息**）；一份摘要同时服务模型与界面 | SLIM/SWEEP 是 model-free 的 replace，原文在 append-only 日志可溯 = 等价「不真删」；FOLD 无回放 | **前一半同构**。缺「回放最后一条用户消息」——但 Tier 3 触发频率低，优先级低（与 design.md §10 判断一致） |
| **Cline** | `/smol` 手动 + Auto-Compact 自动；Focus Chain 待办**穿越压缩存活** | `/compact` 手动 + pressure 自动；PIN 把 `work_state.goal` 带进摘要指令 | **同构**，且 maid 的 PIN 来源比 Focus Chain 更宽（ACP 高权威 + goal + 用户显式清单） |
| **Cursor** | 自动摘要 + 可搜索历史（Dynamic Context Discovery，A/B 称降 46.9% token）；已知 bug：压缩后模型忘掉刚才的编辑 | 被压原文在 append-only 日志 + ACP ledger 双份可溯源，但**没有模型面向的检索入口** | **差距（形态选择）**——找回路径只面向人和审计。是否要做属产品判断 |
| **Amp** | ⚠️ **文章时间线矛盾**。它称「不做递归压缩、用 /handoff」——那属 *Handoff (No More Compaction)* 时代；官方博客 *Amp, Rebuilt (Neo CLI)* 已写下 **"So handoff is out. Compaction is in."**、**"Compaction now runs automatically when the context window is 90% full."** | 无「换线程」概念；无限递归 | **对照失效**：Amp 自己先废压缩、后又回到「压缩 + 90% 自动触发」。maid 的递归问题仍需处理，但**不能靠「Amp 反对压缩」来论证**（见 G3） |
| **MemGPT / Letta** | 上下文 = RAM / 历史 = 交换分区 / 归档 = 磁盘，Agent 自主换入换出 | 两级：surface（RAM）+ append-only 日志 + ACP ledger（磁盘）；换入换出由**人**去查，不是 Agent 自主 | **形态不同**。maid 的 select 是确定性规则而非 Agent 决策——这是有意的（低多样性规则处理结构性问题），不算差距 |

---

## 3. 六条共识逐条打分

| # | 共识 | maid 现状 | 评级 |
|---|---|---|---|
| 1 | 分层渐进，不一刀切 | 五级策展**按内容价值**分层；但**按压力**只有单阈值（0.40）+ eventSlim 常开，缺渐进档位 | ⚠️ 半个 |
| 2 | 成本严格递增 | SLIM/SWEEP 零 LLM → FOLD 才调 LLM；`runPreCleanup` 在官方测压前跑，最坏情况送 LLM 的内容已被免费砍过 | ✅ |
| 3 | 增量摘要优于全量摘要 | 源码级确认已是「旧摘要 + delta 合并」形式；实测后续每轮 `shadowedTokenCount` 降到 7k–17k 量级，单次输入很短 | ✅（递归深度另计，见 G3） |
| 4 | 用真实 token，别估算 | 官方触发走 `ctx.tokenMeter.measure(session)`——DSH 的 token-meter 有 `baseline: {kind:'usage'}` **真实 usage 锚定**（`packages/llm/token-meter`），不是 `len/3` | ✅ |
| 5 | 用户消息有特权 | PIN 是**软保护**（把事实注入摘要指令，指望摘要模型照办），不能阻止原消息被压掉；实测 50% 的压缩没全保住 | ❌ 见 G2 |
| 6 | 保护近端 | 官方 `retainTokens = contextWindow × retainRatio`（maid 默认 0.16）+ 从尾部倒推保留 + 不切断 tool-call/result 配对 | ✅ |
| 7 | 单调边界，绝不滑窗 | **满足**：eventSlim 用 `_slimProgress` 游标只前进；sweep 的 `isMaidMarked` 让已处置节点不再进入指纹与规则 → 同一个 part 的字节一旦定下就不再变 | ✅ |

**第 1 条与第 7 条最容易混为一谈**：maid 满足的是「决策单调」（第 7 条），缺的是「压力渐进」（第 1 条）。

---

## 4. 三条差距（带证据）

### G1 · 压力维度缺失（最该补的一条）

**现状**：压力控制只有两个端点——
- `trigger.eventSlim = true`（默认）：**每一步**都把新落地的超阈值 tool 输出就地换掉，**不看上下文压力**；
- 官方 pressure：`measure.totalTokens ≥ contextWindow × userRatio`（0.40）才动，且是**一次全量 prune + 折叠**。

中间没有「60% 开始整理、80% 加力、95% 兜底」的过渡。这正是
weaver `project/wv-20260907-110` 判的「静态阈值 + bang-bang，无迟滞带、无微分项」。

**代价（本机实测）**：`slim.thresholdChars` 从 4000 提到 30000 之后，压缩比**依然与输入大小无关**——
14 条 slim 记录里 `charsBefore` 从 30010 到 50000 不等，`charsAfter` **恒定 1639 或 2044 chars**
（= headChars 800 + tailChars 800 + marker）。
即一个 50000 字符的输出（约 17k tokens）被压成约 550 tokens，**模型永远看不到中部**。
design.md §9.6 已记录此副作用（「eventSlim 的『常态前置压缩』语义下，阈值应瞄准巨型噪音」），
但**提高阈值只是把触发线往后挪，没有改变「压力低时也照压」的语义**。

**但「常开」本身不必然是错的**——这是本次外部核查带来的最大反转：

实测存在（本机 Claude Code 2.1.202 二进制取证）的 `microcompact` 是
**`tengu_time_based_microcompact`（时间触发）+ `compact_micro_keep_recent`**，
对应日志串 `[KEEP-RECENT MC] context_hint trigger, cleared N tool results (~X tokens), kept last N`。
**即 Claude Code 也在做常态化、非压力触发的清理**，并不遵循文章的 Tier 0。
文章那句「最好的优化是不优化」是 **MUR AI 自家的方案主张**，不是业界共识——不能当权威引用。

**因此真正的差距更精确**（不是「常开 vs 水位线」，而是处置形态）：

| | maid eventSlim | Claude Code microcompact（实测） |
|---|---|---|
| 触发 | 每 step、超 30000 chars | 时间触发 / context_hint |
| 处置 | **头 800 + 尾 800 + 标记**（任意大小输出恒得 1639–2044 chars） | **`cleared` 整条清掉 + 保留最近 N 条完整** |
| 保住的语义单元 | 一个输出的头尾片段 | 最近 N 个完整结果 |

关键差别：maid 把**每一条**大输出都砍成头尾 800；Claude Code 是**整条清掉一批、但保留最近 N 条完整**。
对一份 3000 行的日志，「保留头 800 + 尾 800」等于把中间全扔；「保留最近 N 条完整结果」保住的是完整语义单元。

**建议（修正版）**：
1. `eventSlim` 的处置粒度向 `keep recent N` 靠：**保留完整的最近 N 条** tool 结果，
   更老的才整体清空——而不是每条超标就地砍头尾；
2. 水位门控（`eventSlimMinPressure`）作为**可选**档位保留，但不作为「正解」；
3. 无论哪种，`charsAfter` 恒为 1639/2044 这个事实都该改——压缩后长度应与内容价值相关，而不是常数。

### G2 · PIN 只有软保护，而实测证明它守不住

**软保护的事实**（`src/pinner.mjs` 头注 + `DEVELOPMENT-PLAN.md` MAID-B11）：
spike 结论是「官方压缩从头部压连续段，中段 PIN 无法硬性排除（会破坏连续范围与事务语义）」，
所以 v1 的做法是压缩**前**把 PIN 事实作为一条 plugin user message 追加进摘要输入，
靠摘要模型配合。**原消息仍然会被压掉。**

**实测结果**（本机 38 次 `op=pin` 审计，快照 2026-09-21 15:59）：

| 命中率 | 次数 | 占比 |
|---|---:|---:|
| 0/4（4 个可校验锚点全部丢失） | 4 | 10.5% |
| 1/4 | 1 | 2.6% |
| 2/4 | 1 | 2.6% |
| 3/4 | 13 | 34.2% |
| 4/4 | 19 | 50.0% |

- **一半的压缩没有做到「PIN 全部进摘要」**；
- **10.5% 是全军覆没**——`missed` 数组里 4 个锚点一个不剩
  （`{"anchors":[...4项...],"missed":[...同样4项...],"ratio":0}`）；
- `session-3a99455b` 连续两次压缩（id 7、id 11）都是 0/4——**同一会话重复丢**。

**两层口径问题叠加**：
1. **可校验率只有 25%**：每次收集 16 条 PIN 事实，只有 4 条抽得出字面锚点，12 条标为「不可校验」。
   已知的下界是一半失败，未知的那 75% 完全没被观测。
2. **展示是「最近一次」**：`/context-maid status` 只显示最近一次校验结果。
   只要最近一次是 4/4，用户就会认为保护有效——这是**幸存者偏差**。
   DESIGN 上应展示分布（如「近 20 次：4/4 ×12、3/4 ×6、0/4 ×2」），
   或者至少在出现 0/4 时给出显式告警。

**这不是实现 bug**（`anchor.mjs` 行为正确、校验确实抓到了丢失），
是**软保护本身的能力上限**——文章对第一代方案的批评原话就是
「无论 prompt 写得多好都会丢变量名、函数签名、错误堆栈、用户的具体措辞」。
Codex 用「原文保留」（**外部核查已证实**：官方源码 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`）、
OpenCode 用「回放最后一条」（**已证实**：`processCompaction` 的 overflow 分支按 role==='user' 回退重放）
——这两家是**机制级**保证；maid 还在「指望 prompt」这一档，实测数据正好印证了它的上限。

（原文提到的「Claude Code 用前缀稳定保持缓存」在核查中**被官方文档反证**，见 §5——这一点反而**强化**了
本文的 cache 风险结论。）

**建议**：
- **短期（半天）**：`op=pin` 审计加可校验率；`status` 展示历史分布而非仅最近一次；0/4 时告警。
- **中期（一次 spike）**：重新评估硬排除可行性。B11 记的是「官方压缩从头压连续段」，
  但源码显示 `compactSurfaceRegion(session, start, end, …)` **接受任意区间**
  （design-0.3.0 §1.2 也已取证：「接受任意区间（非只能从头压）」）。
  因此「PIN 段不参与」在协议上可能可行：把连续区域**切成多段**分别压，
  只要每段自身在 tool-pairing 平衡处切开即可（`selectCompactableRange` 内部就是靠
  `toolPairingBalancedBefore` 找切点的）。这条值得重新判定——若成立，
  它是把软保护升级为硬保护、且不需要改官方引擎的唯一路径。

### G3 · FOLD 递归深度无上限、无观测

**证据**：`session-4deb7491` 压缩 17 轮；`session-311f2b1c` 在 6.7 分钟内压 8 轮
（`ts` 从 1789976995289 到 1789977395650）。每轮输入都包含前一轮的摘要 → 递归深度 = 轮数。

**为什么是问题**：文章转述的 Amp 立场是「递归摘要会导致性能逐步衰减（引用了 OpenAI 一份内部研究）」。
外部核查后，这个论据**两头都得打折**：

- **Amp 的立场已经反转**——官方博客 *Amp, Rebuilt (Neo CLI)* 原文：
  **"So handoff is out. Compaction is in."**、**"Compaction now runs automatically when the context window is 90% full."**
  即 Amp 先废除压缩、后又回到压缩 + 90% 自动触发。「换线程优于压缩」不是定论。
- **那份 OpenAI 内部研究未取到**——Amp 的 Handoff/Neo 博客、Threads 文档与多引擎检索中都没有引用。

**所以护栏的理由要换**：不是「某家产品反对递归」，而是**递归深度是「本会话还要不要继续」的唯一判据**，
而 maid 现在不记这个数——`/context-maid status` 不显示递归深度，
`maid_audit` 也没有「本会话第 N 次折叠」这样的可读字段（只能靠 `count(op=fold) group by session_id` 反推）。

**建议**（低成本，三步）：
1. `fold` 审计行补 `detail: { foldDepth: N }`（引擎对 session 计数即可，零新依赖）；
2. `status` 展示当前会话的 fold 深度；
3. 深度超阈值（如 10）时给一次告警——不阻断，只提示「本会话已折叠 N 层，考虑开新会话」。
   这只是**度量**，不是路线选择——Amp 自己的路线已经回到压缩，maid 也没必要引入线程模型。

---

## 5. 一条风险（待实测）：sweep 的中段 replace 会打断 prompt prefix cache

文章 §3.x 是全文唯一带真实生产数据的部分：一个 4 轮 / 177 step / 59 分钟的会话烧了 $77.3，
其中 **83%（$64.8）全是 cache_write**，而 cache_write 单价是 cache_read 的 12.5 倍。
根因是「保留最近 N 条 tool 结果、更老的换 stub」这个判断**在每个 step 里重算**，
于是每步有 1 条旧结果滑出窗口被替换 → 从该位置往后的整个 prompt 前缀对 Prompt Cache 失效。

**在 maid 上逐条比对**：

| 文章的坑 | maid 的现状 | 是否命中 |
|---|---|---|
| stub 决策每 step 重算（滑窗） | eventSlim 用 `_slimProgress` 游标只处理新节点；sweep 用 `isMaidMarked` 让已处置节点出局 | ❌ 不命中（单调性已满足） |
| 替换点之后的前缀全失效 | eventSlim 处置的 `originalSeq` 实测为 34/46/51/57/60/80/116/137/234/243/1203/6158/6611/19056 —— 全是**新落地节点**，位于 surface 尾部 → 只影响尾部 | ❌ 默认不命中 |
| 同上 | **sweep 是 `scanSweepCandidates` 全量扫描 surface**，会命中历史**中段**的 superseded-read / failed-retry 节点；design.md §9.6 的实测记录正是「会话历史遗留的同路径重复读取被逐个处置（#238-241）」。在中段做 replace → 从 #238 往后整段前缀失效 | ⚠️ **命中，但 sweep.enabled 默认 false** |

**判定**：默认配置下（`eventSlim=true, sweep.enabled=false`）风险不成立；
本机 88 行审计里**没有 `op=sweep` 行**，说明当前 profile 未开启。
但一旦开启 sweep，每次处置中段节点就会触发一次「从该位置到末尾」的全量 cache_write。
DSH 确有前缀缓存计费（`cacheReadTokens` / `cacheWriteTokens` 是内核 tokenUsage 的正式字段），
所以这条代价是真实的、可计量的。

**一条官方佐证（来自外部核查）**：Anthropic 官方文档在 context editing 一节明确写——

> *"Tool result clearing: **Invalidates cached prompt prefixes** when content is cleared.
> To account for this, clear enough tokens to make the cache invalidation worthwhile.
> Use the `clear_at_least` parameter… You'll incur cache write costs each time content is cleared,
> but subsequent requests can reuse the newly cached prefix."*

也就是说「清理内容会失效前缀缓存并产生 cache write」是**官方承认的机制**，不是本文的推测。
官方给的对策是 `clear_at_least`——**要么一次清得够多、让这次缓存失效划算；要么别清**。
这条判据可以直接搬到 sweep 上：若一次 sweep 只处置一两个中段节点，
释放的 token 远不足以抵偿整段前缀重写的 cache_write——**正是文章 3.x 的事故形态**。

（顺带一提：文章声称 Claude Code 有 `cached_microcompact`「在已缓存前缀上抠内容、字节不变所以缓存不失效」，
核查在本机 2.1.202 二进制里对 `cached_microcompact`/`apiMicrocompact`/`cache_edits` **零命中**，
且该机制与上面这段官方文档**直接冲突**。文章 §3.x 的观测数据可信，但对 Claude Code 机制的归因不可信。）

**验证方法（可实测，不需要改代码）**：
1. 本机开 `sweep.enabled=true`，跑一个确有历史重复读取的长会话；
2. 对照 `maid.db` 里 `op=sweep` 行的 `originalSeq` 分布，判断处置点在 surface 的位置；
3. 同时看 dsh-usage-card 里该会话的**缓存命中率 / 缓存写入**逐轮曲线——
   若在 sweep 处置的那一轮出现 cacheRead 塌陷 + cacheWrite 尖峰，即复现文章 3.x 的同型事故。

**若复现，两个修法**：
- sweep 只处理「尾部 N 个节点内」的候选，中段历史留给 FOLD 一次性折叠（折叠本来就要重写前缀，
  把代价摊薄到同一次）；
- 或保留全量扫描，但把 sweep 的触发收紧到「会话即将折叠之前」，与 FOLD 合并成同一次前缀重写。

---

## 6. 可吸纳清单

| 优先级 | 项 | 出处 | 规模 |
|---|---|---|---|
| **P0-1** | PIN 校验口径诚实化：加可校验率、`status` 展示历史分布、0/4 告警 | 本文 G2（实测 50% 未全保住） | 小：audit 字段 + status 文案 |
| **P0-2** | `eventSlim` 处置粒度改为 `keep recent N`（整条清 + 保留最近 N 条完整），替掉「每条超标砍头尾 800」 | 本文 G1（Claude Code 实测 microcompact 形态） | 中：slimmer 增量策略 + 测试 |
| **P1-1** | `fold` 审计补递归深度 + status 展示 + 超阈值告警 | 本文 G3（理由已改为「缺判据」，非「Amp 反对」） | 小：engine 计数 + audit 字段 |
| **P1-2** | PIN 硬排除可行性 spike（连续区切段，而非「从头压连续段」） | 本文 G2 建议 | 中：先验证分区间配对约束 |
| **P1-3** | sweep 候选限制在尾部窗口内（或与 FOLD 合并触发） | 文章 §3.x cache 实测 | 中：sweeper 加位置过滤 |
| **P2-1** | 工具差异化预算（Read 30KB / Bash 50KB / WebSearch 15KB），替掉全局 `slim.thresholdChars` | 文章 §6.2 | 中：slimmer 按 toolName 取阈值 |
| **P2-2** | 模型面向的可搜索历史 | 文章 §3 Cursor | 大：产品判断，非本轮 |
| — | ~~ReplacementCache / 存储分离~~ | 文章 §6.1/§6.3 | **不需要**：DSH 天然满足 |

---

## 7. 外部核查结果（子代理独立执行，2026-09-21）

10 条关键断言的核查结论：**4 条完全属实、5 条部分属实或有错、1 条完全未取到**。

| # | 断言 | 结论 | 一手依据 |
|---|---|---|---|
| 1 | `context_management` API + beta `context-management-2025-06-27` + 云端支持 + 按 input_tokens 阈值裁剪 | **属实** | Anthropic 官方 Context editing 文档；SDK `BetaContextManagementConfigParam`；平台矩阵显示 **五端均为 beta**（非 GA） |
| 2 | Claude Code 五段流水线 + 前四段零 API + 九段式摘要 | **存疑** | 本机 claude.exe 2.1.202 二进制对 `Budget Reduction` / `Snip` / `Context Collapse` **零命中**；中英全网无出处 |
| 3 | `cached_microcompact` / `apiMicrocompact` / `cache_edits` | **存疑，且被反证** | 三个标识符零命中；官方文档明说清理内容**会**失效缓存前缀并产生 cache write |
| 4 | Codex ~95% 触发 + 最近 20k token 用户消息保留 | **属实** | `codex-rs/core/src/compact.rs`：`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（「95%」是可用窗口口径，名义值是原始窗口 90%） |
| 5 | OpenCode Prune + Summary 两步 | **属实** | `session/compaction.ts`、`session/overflow.ts`、`core/session/compaction.ts` 逐条对上 |
| 6 | Cline /smol 自 v3.25 + Focus Chain 穿越压缩 | **部分属实** | v3.25 博客确认 Auto-Compact/Focus Chain，**未提及 /smol**；官方措辞是 *can help*，不是保证 |
| 7 | Cursor 的 46.9% 归因 | **归属错误** | 官方博客：46.9% 属「MCP 工具描述落文件、按需加载」，且口径限定「会调用 MCP 工具的运行中」 |
| 8 | Amp 不做递归压缩 + 引 OpenAI 研究 | **部分属实** | Neo CLI 博客已反转：*"So handoff is out. Compaction is in."* + 90% 自动压缩；那份 OpenAI 研究**未取到** |
| 9 | 腾讯 MUR AI 是否开源 | **未取到** | 多引擎多轮检索无一手结果，仅同名噪声 |
| 10 | cache write ≈ cache read 的 12.5× | **属实** | Anthropic 与 OpenAI 定价页都是 12.5×；例外：Anthropic 1h 缓存 **20×**、Fable/Mythos 5.1 **50×** |

**文章的价值分层很清晰：**

- **可用（思路层）**：分层、成本递增、增量摘要、用户消息特权、工具差异化预算——这些是主张，不依赖实现细节真伪；
- **可用且价值最高**：§3.x 的生产事故数据（$77.3 / 83% cache_write）与 §9 的可观测性清单——带原始数据、可复现；
- **不可用**：对 Claude Code 内部实现的描述（五段流水线、`cached_microcompact`）——官方二进制零命中，
  且「缓存不失效」的说法与官方文档**直接冲突**（详见 §5）；
- **不可引用为行为规格**：Amp、Cursor 的现状描述（一个时间线自相矛盾、一个数字张冠李戴）。

**对本文的实际影响**：§2 的 Claude Code / Amp 两行、§4 的 G1 与 G3 论证、§5 的 cache 佐证，
均已按核查结果重写。**不要**拿这份文章当 Claude Code 的行为规格用。

---

## 8. 附录：本机 maid 实测数据

> 快照时刻 2026-09-21 15:59（UTC+8），`%DSH_HOME%/context-maid/maid.db` 只读查询。
> 审计库是活库——两次查询之间就会多出行（本文写作过程中 slim 从 13 行涨到 14 行）。

```
maid_audit 共 89 行（ts 跨度 1789622376515 → 1789977416702）

op=fold   unit=estTokens   37 行   Σ tokens_before = 3,602,754   min 7,384 / max 555,332
op=pin    unit=chars       38 行   （命中率分布见 §1.4 / §4 G2）
op=slim   unit=chars       14 行   576,115 chars → 23,756 chars（约 24:1）
op=sweep                   0 行    ← 当前 profile 未开启

slim 记录：charsBefore ∈ {30010, 30438, 31414, 32432, 33341, 39346, 39646, 39926,
                          39912, 43227, 47290, 48725, 49755, 49999, 50000}
           charsAfter  ∈ {1639, 2044}      ← 与输入大小无关
           originalSeq ∈ {34,46,51,57,60,80,116,137,234,243,1203,6158,6611,19056}
                                          ← 均为新落地节点（surface 尾部）

fold 递归证据（range = shadowedRange.start:shadowedRange.end）：
  session-4deb7491   8:3569 → 3601:9490 → 9528:15305 → 15363:18276 → 18314:19860
                     → 21285:19923 → 21317:20067 → 21395:20137 → 21509:20250
                     → 21655:20546 → 21928:20639 → 21978:20772 → 22108:21189
                     → 22644:21291 → 22704:21295 → 22753:21568 → 22965:21687   （17 轮）
  session-311f2b1c   8:44 → 1973:176 → 2035:272 → 2215:381 → 2379:451
                     → 2464:530 → 2503:601 → 2536:675 → 2592:707              （9 轮）
  每项 start 严格递增，等于上一轮 summary 节点的新 seq → 递归摘要成立。

maid-trace.log 探针（2026-09-18，debug=true 期）：
  probe: tokenMeter=ok totalTokens=464651 session=session-3a99455b…
  compactIfNeeded(pressure) → compacted {"start":8,"end":1074}
  compactIfNeeded(pressure) → null（未达阈值或无范围）    ← 连续多次空转
  compactIfNeeded(pressure) THREW: LlmError: DeepSeek Messages transport failed
  压缩后 probe totalTokens=262990（464k → 263k）
  → 触发链路可用；但摘要 LLM 失败会使整次折叠 throw（无降级）。
```

---

## 9. 一句话

文章把「什么时候压」做到了四级水位线，maid 把「压谁」做到了五级价值分级——**各有一半**。
但文章的价值在核查后缩了水：它最吸引人的 Claude Code 实现细节在本机官方二进制里零命中，
**能用的只有思路层和 §3.x 的实测数据**。

maid 最该动的是三处，都不需要新机制：
1. **PIN 口径说实话**（38 次校验里 4 次 0/4、只有 25% 可校验）；
2. **eventSlim 的处置粒度**向 `keep recent N` 靠（现在是任意大小都砍成恒定 1639 chars）；
3. **fold 递归深度入账**——它能回答「本会话还要不要继续」，而 maid 现在连这个数都没有。
