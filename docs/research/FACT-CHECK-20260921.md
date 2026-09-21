---
id: DOC-RESEARCH-FACT-CHECK-20260921
status: final
checked_on: 2026-09-21
checker: 御影雪（子代理，独立执行）
subject: 知乎《横向拆解Claude Code、Codex等六大Agent上下文压缩策略后，我们做了第 7 个》
---

# 事实核查报告：AI Agent 上下文压缩的 10 条断言

**核查对象**：腾讯技术工程 / mervynyang，2026-06 发文
**方法**：优先官方文档 / 官方仓库源码；逆向结论标注「社区来源」；
对断言 2/3 另做**本机 Claude Code 2.1.202 二进制字符串取证**。

---

## 一、结论表

| # | 断言 | 结论 | 一手来源 |
|---|---|---|---|
| 1 | `context_management` API + beta `context-management-2025-06-27` + 云端支持 + 按 input_tokens 阈值裁剪 | **属实** | Anthropic 官方 Context editing 文档；SDK `BetaContextManagementConfigParam`；平台矩阵 |
| 2 | Claude Code 五段流水线（Budget Reduction → Snip → Microcompact → Context Collapse → Auto-Compact）+ 前四段零 API + 九段式摘要 | **存疑** | 本机 claude.exe 2.1.202 取证（三处命名零命中）；全网无出处 |
| 3 | `cached_microcompact` / `apiMicrocompact` / `cache_edits` | **存疑（标识符不属实，机制被反证）** | 三标识符零命中；官方文档对缓存失效的说明 |
| 4 | Codex ~95% 触发 + handoff 摘要 + 保留 ~20k token 用户消息 | **属实（约值）** | `openai/codex` `codex-rs/core/src/compact.rs` |
| 5 | OpenCode 两步压缩（Prune + Summary） | **属实** | `session/compaction.ts`、`session/overflow.ts`、`core/session/compaction.ts` |
| 6 | Cline 自 v3.25 起 /smol + Auto-Compact；Focus Chain 穿越压缩 | **部分属实** | Cline v3.25 官方博客；命令文档；Auto Compact 文档 |
| 7 | Cursor Dynamic Context Discovery，A/B 减少 46.9% | **部分属实（归属错误）** | Cursor 官方博客 |
| 8 | Amp 不做递归压缩 / /handoff；引 OpenAI 研究；Neo CLI 加 90% 自动管理 | **部分属实（时间线自相矛盾；研究未取到）** | `ampcode.com/news/handoff`、`/news/neo`、`/docs/threads` |
| 9 | 腾讯 "MUR AI" 是否开源 / 有无公开文档 | **未取到** | 多引擎多轮检索无一手结果 |
| 10 | cache write 单价约为 cache read 的 12.5 倍 | **属实（两家都是；有例外）** | Anthropic 定价页；OpenAI 定价页 |

**合计：4 条完全属实、5 条部分属实或有错、1 条完全未取到。**

---

## 二、关键证据摘句

### 断言 1 · 属实

> "Context editing is in beta with support for tool result clearing and thinking block clearing.
> To enable it, use the beta header `context-management-2025-06-27` in your API requests."

官方示例即按阈值裁剪旧工具调用：

```python
betas=["context-management-2025-06-27"],
context_management={"edits": [{
    "type": "clear_tool_uses_20250919",
    "trigger": {"type": "input_tokens", "value": 30000},
    "keep": {"type": "tool_uses", "value": 3},
    "clear_at_least": {"type": "input_tokens", "value": 5000},
    "exclude_tools": ["web_search"]}]}
```

> "Context editing is applied server-side before the prompt reaches Claude.
> Your client application maintains the full, unmodified conversation history."

**云端支持**：平台可用性矩阵显示 1P / P-AWS / Bedrock / Vertex / Foundry **五端全部为 beta**（非 GA）。
→ 文章说「Vertex/Bedrock 也支持」不算错，但准确表述应是「五端均为 beta」。

### 断言 2 · 存疑（最严重）

本机安装 Claude Code **2.1.202**（`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，
240 MB 原生二进制，非 cli.js）。全量 ASCII 扫描：

| 检索串 | 命中 |
|---|---|
| `\bsnip\b` / `Snip` | **0**（"snippet"=38，此前 89 次 "snip" 全是噪声） |
| `Context Collapse` / `context_collapse` | **0**（"collapse" 170 次全是 `border-collapse` 等无关串） |
| `Budget Reduction` / `budget_reduction` | **0** |
| `Auto-Compact` | 3（仅出现在「提交 issue 的标题示例」字符串里） |
| `microcompact` | 4（**真实存在**） |
| `compact_boundary` | 67 |

**确实存在的**：遥测事件 `tengu_time_based_microcompact`、开关 `compact_micro_keep_recent`、
日志串 `[KEEP-RECENT MC] context_hint trigger, cleared N tool results (~X tokens), kept last N`、
系统消息子类型 `microcompact_boundary`。

Anthropic 官方工程博客对 Claude Code 压缩**只说两件事**（摘要 + 工具结果清理），
**没有**五段流水线、没有「前四段零 API 调用」、没有「九段式结构化摘要」。

### 断言 3 · 存疑（且被官方文档反证）

本机 2.1.202 取证：`cached_microcompact` = **0**、`apiMicrocompact` = **0**、`cache_edits` = **0**。

而文章声称的机制——「服务端在已缓存前缀上抠内容、因此缓存不失效」——与官方文档**直接冲突**：

> "Tool result clearing: **Invalidates cached prompt prefixes** when content is cleared.
> To account for this, clear enough tokens to make the cache invalidation worthwhile.
> Use the `clear_at_least` parameter… You'll incur cache write costs each time content is cleared,
> but subsequent requests can reuse the newly cached prefix."

**注**：microcompact 本身真实存在，但形态是「时间触发 / context_hint 触发 + 保留最近若干条」，
不是「API 层 cache_edits 指令」。

### 断言 4 · 属实

`codex-rs/core/src/compact.rs`：

> `const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;`

同文件导出 `SUMMARIZATION_PROMPT` / `SUMMARY_PREFIX`，含 `CompactionTrigger::Auto` / `Manual`、
`replace_compacted_history`、`InitialContextInjection::BeforeLastUserMessage | DoNotInject`。

**阈值口径修正**：名义阈值是**原始窗口的 90%**，因基数取错才落在**可用窗口的 94.74%**
（社区来源 issue #40095 给出可复现的源码路径）。写「约 95% 触发」作为实际表现可以，
写「阈值设为 95%」则错。

### 断言 5 · 属实

Prune（**无 LLM**，只打标记，数据不真删）：
`PRUNE_PROTECT = 40_000`、`PRUNE_MINIMUM = 20_000`、`PRUNE_PROTECTED_TOOLS = ["skill"]`；
只写 `part.state.time.compacted = Date.now()`，序列化时才替换为
`"[Old tool result content cleared]"`。

Summary 触发：`const COMPACTION_BUFFER = 20_000`，`count >= usable(input)`。

五段式模板确有 5 个二级标题：`## Objective` / `## Important Details` /
`## Work State`（Completed/Active/Blocked）/ `## Next Move` / `## Relevant Files`。

回放最后一条用户消息：`processCompaction` 的 `input.overflow` 分支按 `role === "user"`
向前回溯并重放（跳过 compaction 消息）。

→ 文章的「两步」框架、占位符、不真删、五段摘要、回放末条用户消息，**均能一一对上源码**。

### 断言 6 · 部分属实

- `/smol`（别名 `/compact`）：**属实**（官方命令文档）；
- Auto-Compact：**属实**（官方专页）；
- **「从 v3.25 起」需拆分**：v3.25 博客发布的是 **Deep Planning + Focus Chain + Auto Compact**，
  **未提及 /smol** → 「/smol 自 v3.25 起」无依据；
- 「待办穿越压缩存活」：官方措辞是 *"Structured task lists **can help** maintain progress across
  summarizations"* —— 是「有帮助」，不是保证。

### 断言 7 · 部分属实（46.9% 张冠李戴）

Cursor 官方博客原文：46.9% 是
**「把 MCP 工具描述同步到文件夹、按需加载」**这一策略的 A/B 结果，
且口径限定在**「会调用 MCP 工具的运行中」**。
而「聊历史变成可搜索文件」是同一篇博客的第 2 点，**文中未给数字**。
→ 文章把两个策略的数字与归属搞混了。

### 断言 8 · 部分属实（同一断言内自相矛盾）

*Handoff (No More Compaction)* 原文：

> "We have removed compaction from Amp and replaced it with something we think works a lot better: Handoff."
> "compaction, we found, encourages long, meandering threads… **stacking summary on top of summary**."

**但 Neo CLI 把结论反转了** —— *Amp, Rebuilt* 原文：

> "**Compaction now runs automatically when the context window is 90% full.** …
> **So handoff is out. Compaction is in.**"

→ 文章把两个时代的结论并列陈述为现状，**时间线错误**。
→ 「引用 OpenAI 内部研究」：在 Amp 的 Handoff/Neo 博客、Threads 文档与多引擎检索中**均未找到**。

### 断言 9 · 未取到

中英多轮检索（Bing / DuckDuckGo / Jina / DeepSeek-seam）结果全部为噪声：
Mur 猫迷因、MUR 汇率、《现代城市研究》期刊、同名第三方 Rust 项目 `mur-run/mur`（与腾讯无关）。
顺带检到的腾讯开源 agent 项目是 `TencentCloud/Octop`、`Tencent/teamai-cli`、WorkBuddy、Gander
—— **没有名为 MUR 的项目**。不排除是内部产品/内部代号。

### 断言 10 · 属实

两家都是 **12.5×**（cache write = 1.25× 基础价，cache hit = 0.1× 基础价）。

- Anthropic：Opus 5 $5 / $6.25 / $0.50 → 12.5；Sonnet 4.6、Haiku 4.5 同。
  **例外**：1h cache write = 2× 基础价 → **20×**；Fable 5.1 / Mythos 5.1 命中价 0.025× → **50×**。
- OpenAI：gpt-5.6-sol $4.00 / $0.40 / $5.00 → 12.5；gpt-6-astra、gpt-5.6-terra、gpt-5.6-luna 同。
  **例外**：gpt-rosalind-research 明确标注 "Cache-write pricing does not apply to this model"。

---

## 三、存疑清单（按严重度）

1. **【最严重】Claude Code 五段流水线**：三个阶段名在官方二进制中零命中、全网无出处。
   建议降级为「无法证实」，或请作者给出具体版本号与取证方法。
2. **【严重】`cached_microcompact` / `apiMicrocompact` / `cache_edits`**：三标识符零命中，
   且「不失效缓存」的说法与官方文档直接冲突。
3. **【矛盾】Amp 现状描述**：两个时代的结论被并列，时间线自相矛盾。
4. **【未取到】Amp 引用的 OpenAI 递归摘要研究**：无任何链接或标题。
5. **【归属错误】Cursor 46.9%**：属 MCP 工具加载策略，非「聊历史变文件」策略。
6. **【版本存疑】Cline /smol 与 v3.25**：v3.25 博客未提及 /smol。
7. **【措辞过强】Cline 待办穿越压缩**：官方是 *can help maintain*。
8. **【数值口径】Codex「约 95%」**：名义阈值是原始窗口 90%。
9. **【完全未取到】腾讯 MUR AI**：无一手依据。
10. **【需补注】12.5× 适用范围**：须注明 Anthropic 1h（20×）、Fable/Mythos 5.1（50×）；
    断言 1 应表述为「五端均为 beta」。

---

## 四、方法与限制

- **环境限制**：`docs.claude.com` 直连返回 "App unavailable in region"（区域封锁），
  改走 `platform.claude.com` + 无头浏览器取正文；Exa 与 DuckDuckGo 本会话不可用
  （mcporter 未安装 / fetch failed），Bing 对英文长尾术语基本无效。
- **GitHub 代码搜索不可用**（需 `GITHUB_TOKEN`）——代码级断言一律走 `raw.githubusercontent.com`
  原文与 GitHub REST contents API 直取文件，不依赖搜索摘要。
- **二进制取证的固有局限**：制品经打包/压缩，若某标识符仅在运行时由字符串拼接生成则可能漏检。
  因此「0 命中」表述为**「在官方制品中不可证实」**，而非「绝对不存在」。
- 所有「未取到」项均为真实检索失败，**未做任何推测性补全**。

---

## 五、对本文档使用者的结论

- **可用（思路层）**：分层、成本递增、增量摘要、用户消息特权、工具差异化预算；
- **可用且价值最高**：原文 §3.x 的生产事故数据（$77.3 / 83% cache_write）与 §9 的可观测性清单；
- **不可用**：对 Claude Code 内部实现的描述；
- **不可引用为行为规格**：Amp、Cursor 的现状描述。

配套对照分析见 [INDUSTRY-SURVEY-20260921.md](INDUSTRY-SURVEY-20260921.md)。
