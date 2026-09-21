---
id: DOC-PLAN-20260921-QUALITY-GAPS
status: draft（待评审，未立项）
created: 2026-09-21
source: docs/research/INDUSTRY-SURVEY-20260921.md
---

# context-maid 质量缺口计划（2026-09-21）

> **状态：只计划、未实现。** 用途是给深度研究提供材料与选项，不是执行记录。
> 证据来源三方交叉：本机 `maid.db` 实测 + 官方压缩源码 + 业界对照调研 + 独立外部核查。

## 0. 一页摘要

三项缺口、两项待研究。三项都有本机一手数据支撑，改动都不大。

| 编号 | 缺口 | 证据强度 | 建议方案 | 估工 |
|---|---|---|---|---|
| B12 | PIN 锚点校验口径不诚实 | **本机实测（38 次）** | 报可校验率 + status 展示分布 + 0/4 告警 | ≤0.5 天 |
| B13 | eventSlim 处置粒度粗 | **本机实测（14 条）+ 二进制取证** | 保留最近 N 条完整，更老的整条清 | 1 天 |
| B14 | FOLD 递归深度无记账 | **本机实测（17 轮）** | foldDepth 入审计 + status + 阈值告警 | ≤0.5 天 |
| S1 | PIN 硬排除可行性 | 源码分析，未实测 | spike 验证连续区切段 | 0.5 天 |
| S2 | sweep 中段 replace 的缓存代价 | 推理，未实测 | 开关实测 + 对用量曲线 | 0.5 天 |

**共同特征**：三项都不需要新机制、不碰官方引擎、不需要新依赖——都是把已有能力接上或把口径改对。

---

## 1. 证据基线（2026-09-21 15:59 快照，只读查询）

```
maid_audit 共 89 行

op=fold   estTokens   37 行  Σ shadowedTokenCount = 3,602,754   min 7,384 / max 555,332
op=pin    chars       38 行  命中分布见 2.1
op=slim   chars       14 行  576,115 chars → 23,756 chars（约 24:1）
op=sweep              0 行   ← 当前 profile 未开启

fold 递归（range = shadowedRange.start:end）：
  session-4deb7491   8:3569 → 3601:9490 → 9528:15305 → 15363:18276 → 18314:19860
                     → 21285:19923 → … → 22965:21687                      （17 轮）
  session-311f2b1c   8:44 → 1973:176 → 2035:272 → … → 2592:707          （9 轮）
  → 每项 start = 上一轮 summary 节点的新 seq（selectCompactableRange 从 surface 起始位选段）
```

---

## 2. 三项立项

### 2.1 MAID-B12 · PIN 锚点校验口径

**问题**：`op=pin` 的 summary 行报的是「命中率」，但真正该报的是「可校验率」——
而且 `/context-maid status` 只展示最近一次，形成幸存者偏差。

**证据**（本机 38 次校验）：

| 命中 | 次数 | 占比 |
|---|---:|---:|
| 0/4（4 个可校验锚点全部丢失） | 4 | 10.5% |
| 1/4 | 1 | 2.6% |
| 2/4 | 1 | 2.6% |
| 3/4 | 13 | 34.2% |
| 4/4 | 19 | 50.0% |

- 每次收集 **16 条** PIN 事实，仅 **4 条**抽得出字面锚点 → **可校验率 25%**；
- **50% 的压缩未把 PIN 全部带进摘要，10.5% 全部丢失**；
- `session-3a99455b` 连续两次（id 7、id 11）都是 0/4，`missed` 数组里 4 个锚点一个不剩；
- **调研过程本身复现了这个坑**：首次只查最近 12 行（全是 4/4）→ 误判为「保护 100% 有效」。

**注意**：这不是实现 bug——`anchor.mjs` 行为正确、校验确实抓到了丢失。这是**口径**问题。

**方案**：
1. `anchor.mjs` 报告增 `verifiableRatio = hits.length + missed.length / total`；
2. `engine.mjs` 的 summary 行改为 `可校验 4/16（25%）· 命中 0/4（0%）`；
3. `commands.mjs` 的 status 改为展示**近 N 次分布**（如 `近 20 次：4/4 ×12、3/4 ×6、0/4 ×2`）；
4. 出现 0/4 时 warn（不阻断，符合仓库「保留 warn 级别」惯例）。

**验收判据**：status 能一眼看出「保护是否可靠」，而不是只看最近一次；出现 0/4 时有可见提示。

**影响文件**：`src/anchor.mjs`、`src/engine.mjs`、`src/commands.mjs` + 测试。

**风险**：低。纯展示层。

---

### 2.2 MAID-B13 · eventSlim 处置粒度

**问题**：eventSlim 对**任意大小**的超阈值输出都做同样的头尾截断，输出长度是常数。

**证据**（本机 14 条 slim 记录）：

```
charsBefore ∈ 30010 / 30438 / 31414 / 32432 / 33341 / 39346 / 39646 / 39926 /
              39912 / 43227 / 47290 / 48725 / 49755 / 49999 / 50000
charsAfter  ∈ 1639 / 2044        ← 与输入无关（head 800 + tail 800 + marker）
```

一个 50000 字符的输出（≈17k tokens）被压成约 550 tokens——**中部全部丢弃，模型从未见过**。
`docs/design.md` §9.6 已记录过该副作用（阈值曾从 4000 提到 30000），但**提高阈值只挪了触发线，
没改处置形态**。

**对照**（本机 Claude Code 2.1.202 二进制取证）：

```
遥测事件  tengu_time_based_microcompact   {toolsCleared, toolsKept, keepRecent, tokensSaved, trigger}
开关      compact_micro_keep_recent
日志      [KEEP-RECENT MC] context_hint trigger, cleared N tool results (~X tokens), kept last N
```

即真实 microcompact = **`cleared`（整条清掉）+ `keep recent N`（保留最近 N 条完整）**。
对一份 3000 行的日志，「留头 800 + 尾 800」等于把中间扔光；「保留最近 N 条完整」保住的是完整语义单元。

**方案对比**：

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐）** | 保留最近 N 条**完整** tool 结果，更老的**整条清空** | 语义单元完整；与 microcompact 同形；token 释放更彻底 | 需要定义 N；旧结果彻底不可见（但原文在 append-only 日志 + ACP 可溯） |
| B | 现状头尾，但按内容类型自适应 | 改动小（error/json 策略已部分实现） | 不解决「中部丢失」的本质 |
| C | 按工具差异化预算（Read 30KB / Bash 50KB / WebSearch 15KB） | 贴合工具语义 | 仍是头尾截断；需维护工具表 |

**推荐 A + C 组合**：A 定形态，C 给每个工具一个「完整保留阈值」。

**验收判据**：`charsAfter` 不再是常数；长会话中最近使用的工具结果保持完整可读；
token 占用不高于现状。

**影响文件**：`src/slimmer.mjs`（incrementalSlim 策略）、`src/engine.mjs`（阈值来源）+ 测试。

**风险**：中。改了「模型看到什么」，必须挂 golden regression（仓库既有 `test/golden-regression.test.mjs` 机制）
+ 真机长会话验证。建议先出设计稿再动代码。

---

### 2.3 MAID-B14 · FOLD 递归深度记账

**问题**：`/context-maid status` 不显示当前会话折叠了几层，审计里也没有可读字段
（只能靠 `count(op=fold) group by session_id` 反推）。

**证据**：`session-4deb7491` 折叠 **17 轮**；`session-311f2b1c` 在 **6.7 分钟内**连折 8 轮
（`ts` 1789976995289 → 1789977395650）。

**为什么该记**（论证已按外部核查修正）：**不是**因为「某家产品反对递归」——
实测发现 Amp 一度废除压缩、Neo CLI 之后又回到「压缩 + 90% 自动触发」（官方博客原文
*"So handoff is out. Compaction is in."*），说明递归压缩不可替代。
真正的理由是：**深度是「本会话还要不要继续」的唯一判据**，而现在取不到。

**方案**：
1. `engine.mjs` 用 WeakMap 对 session 计数 fold 次数（随会话生命周期回收，零新依赖）；
2. `fold` 审计行 `detail` 增 `foldDepth`；
3. `commands.mjs` 的 status 展示当前会话深度；
4. 深度 > 10 时 warn（不阻断、不引入线程模型、不做路线选择）。

**验收判据**：status 能看到当前会话折叠层数；超过阈值有提示。

**影响文件**：`src/engine.mjs`、`src/archiver.mjs`、`src/commands.mjs` + 测试。

**风险**：低。

---

## 3. 两项待研究（spike，不立项）

### 3.1 S1 · PIN 硬排除可行性

**现状判断**：`DEVELOPMENT-PLAN.md` MAID-B11 记的是「官方压缩从头压连续段，中段 PIN 无法硬性排除」。

**新证据**：`compactSurfaceRegion(deps, session, start, end, agent, options, signal)` 的签名
**接受任意区间**（`src/region.ts:174`）；design-0.3.0 §1.2 也已取证「接受任意区间（非只能从头压）」。
`selectCompactableRange` 内部靠 `toolPairingBalancedBefore` 找切点——即**配对平衡处皆可切**。

**要验证的**：把「PIN 段」前后的连续区切成多段，分别 `compactRegion`，
是否满足全部约束（配对平衡、事务相邻性契约、stability 检查）。

**若成立**：软保护可升级为硬保护，且不必改官方引擎——这是 B12 的根治方案。

**B11 需要据结果重新判定**（当前标「保留 / 不排期」）。

### 3.2 S2 · sweep 中段 replace 的缓存代价

**推理链**：`scanSweepCandidates` 全量扫描 surface → 会命中历史**中段**的 superseded-read / failed-retry
（design.md §9.6 实测过 #238-241）→ 在中段 replace 会让从该位置往后的整段 prompt 前缀失效。
DSH 确有前缀缓存计费（`cacheReadTokens`/`cacheWriteTokens` 是内核 tokenUsage 正式字段）。

**官方佐证**（外部核查取到）：Anthropic 文档明写
*"Tool result clearing: **Invalidates cached prompt prefixes** when content is cleared…
You'll incur cache write costs each time content is cleared. Use the `clear_at_least` parameter."*
——即「清了就失效」是官方承认的机制，对策是「**要么一次清够多，要么别清**」。

**待测**：开 `sweep.enabled=true` → 看 `op=sweep` 的 `originalSeq` 分布 → 对 dsh-usage-card 的
缓存命中率/缓存写入逐轮曲线。若出现 cacheRead 塌陷 + cacheWrite 尖峰，即复现业界同型事故。

**现状**：`sweep.enabled` 默认 false，当前 89 行审计里 0 条 `op=sweep` → **默认配置下风险不成立**。

---

## 4. 明确不做

| 项 | 理由 |
|---|---|
| 引入 ReplacementCache / 存储分离 | DSH 架构天然满足：append-only 日志 + surface 投影 = 存储分离；压缩决策持久化在事件日志里 = 跨轮/跨重启一致 |
| 四级水位线全套照搬 | 文章的 Tier 0 是 MUR AI 自家主张，不是业界共识（实测 Claude Code 本身就在做常态化 microcompact） |
| 线程模型 / 换会话机制 | 超出本插件职责；B14 只记数、不选路线 |
| PIN 注入「回放最后一条用户消息」 | Tier 3 触发频率低，优先级低（与 design.md §10 判断一致） |

---

## 5. 建议顺序

```
B12（口径，半天，零风险）
      ↓
B14（记账，半天，零风险）
      ↓
S1 spike（决定 PIN 能否硬保护 → 回过头影响 B12 的终态）
      ↓
S2 spike（决定 sweep 要不要收位置限制）
      ↓
B13（改「模型看到什么」，风险最高，最后做，需设计稿 + golden + 真机验证）
```

**B12 / B14 可以合并成一次「可观测性修补」提交**（都是展示层 + 审计字段，不碰策展语义）。

---

## 6. 纪律提醒（本仓 AGENTS.md）

1. 改代码必须补测试（`test/` 下同名 `.test.mjs`）；
2. 行为语义变化要同步 README / docs/design.md / docs/DEVELOPMENT-PLAN.md；
3. 未接线不宣称（B12/B13/B14 落地前，README 不得提前描述新行为）；
4. feature 分支开发，合 main 前跑全量测试。
