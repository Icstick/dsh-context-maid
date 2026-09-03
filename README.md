# dsh-context-maid

DeepSeek Harness (dsh) 的**自动上下文策展**插件——帮你把越来越臃肿的上下文收拾干净：
优先清掉工具输出和无效日志，保护正在进行的工作和你在意的重点，压缩前先把值得留的存进记忆。

> 女仆的工作不是把房间一把火烧了，而是把垃圾扔掉、把重要的东西收进抽屉、把桌子擦干净——
> 你随时能打开抽屉找回东西。

## 为什么需要它

长会话跑久了，上下文里堆满了没人再看的东西：一次失败的构建刷了几百行 stderr、同一个文件被
读了五遍、某次实验的中间输出早被后来的结果取代。对话本身没多长，**工具输出和无效日志才是
占地方的大头**。

与此同时，真正重要的东西——你半小时前说"这个必须用 pnpm"、当前进行到一半的目标、上一步
刚确认的决策——夹在垃圾堆里，一旦触发压缩，可能连同垃圾一起被压成一段模糊的摘要。

dsh-context-maid 把这两件事分开处理：**垃圾按垃圾清，重点按重点护**。

## 一个小故事

你在调一个 FFT 工具的精度 bug，来回跑了十几轮。上下文里躺着：三次失败的调试输出（每次 300 行）、
两份过时的频谱截图描述、五轮"再试一次"的中间结论……而真正的关键是——你中途说过"参考 ADI 的
窗口函数实现，别自己发明"。

没有 maid：上下文到了阈值，一把梭压缩——你的关键要求可能被压成"用户提过窗口函数"。
有 maid：它先把过时工具输出清掉、把失败日志收走，你的原话被钉在不可压缩区，每次压缩前
还会把它带进摘要指令："以下为用户明确要求，必须保留"。

## 核心能力

| 能力 | 说明 |
|---|---|
| **内容分级策展** | 每个消息节点打标：钉扎 PIN / 保留 KEEP / 瘦身 SLIM / 清理 SWEEP / 压缩 FOLD |
| **tool 输出瘦身** | 按内容类型感知截断：错误留尾、JSON 留骨架、日志留头尾（非固定 head/tail） |
| **无效日志清理** | 僵尸消息、失败中间产物、被取代结果、孤儿 tool-call——确定性识别后移除 |
| **工作流/记忆钉扎** | 用户明确要求、纠正、当前 goal 永不进有损压缩；压缩后仍注入（~150 token 兜底） |
| **先归档后压缩** | 被清/被压内容先进 ACP ledger；压缩摘要本身成为一条带 supersedes 链的证据 |
| **阈值用户可调** | trigger.userRatio 主旋钮（默认 0.40）；大 tool 输出落地即瘦身（不等总量阈值） |
| **compact 模型可配** | 摘要可用便宜小模型/本地模型（OpenAI 兼容网关），也可接智能路由端点 |
| **可观测** | 每次策展写审计：时间/类型/范围/token 前后/归档条目；/context-maid status 随时查 |

## Agent 安装指南（面向自动化装配）

> 给需要在本机 dsh 装配本插件的 agent/脚本读；人工装配见下一节。
> 硬约束：① **必须 disable 官方 compaction-basic 与 tool-result-pruner**（maid 接管
> 同一 ctx.compaction 服务，官方不禁用则 maid 自动旁路不生效——防呆，见日志 warn）；
> ② pnpm install 前先停 dsh（Windows native DLL 锁）；③ 同 id patch 条目整体覆盖。

**1. 定位 profile**：`<DSH_HOME>/profiles/<profile>/`；先读 `package.json`，无
`dsh.profile.bundles` 键则 profile 未初始化，先初始化再继续。

**2. 添加依赖**（二选一）：

```bash
# A. GitHub 源：CLI 自动把声明 dsh.bundle 的包加入 dsh.profile.bundles
dsh plugin --profile <profile> add github:Icstick/dsh-context-maid
# B. 本地开发：profile package.json dependencies 加 "dsh-context-maid": "link:<绝对路径>",
#    并在同文件 dsh.profile.bundles 数组追加 "dsh-context-maid"
```

⚠️ `dsh plugin add` 不会写配置条目——第 3 步必须做。

**3. 装配（profile 根 `cordis.patch.yml`，无则新建）**：先 disable 两个官方引擎，再挂 maid：

```yaml
- id: compaction-basic      # 必须：官方默认引擎禁用，否则 maid 旁路
  disabled: true
- id: tool-result-pruner    # 必须：官方瘦身器禁用
  disabled: true
- id: context-maid
  name: dsh-context-maid
  config:
    auditDir: C:\path\to\context-maid   # 建议显式（默认 $DSH_HOME/context-maid）
    trigger:
      userRatio: 0.4        # 可选：触发阈值主旋钮
```

**4. 安装并重启**：停 dsh → profile 目录 `pnpm install` → 重启 dsh。

**5. 验证**：对话里 `/context-maid status` 应输出
`engine: ctx.compaction = MaidCompactionEngine（maid 提供，阈值映射生效）`。

**故障速查**：status 显示 BasicCompactionEngine（官方）→ 官方没 disable，回去查第 3 步
前两条；audit 目录落在意外位置 → auditDir 未显式配置；/context-maid 命令不存在 →
commands 服务时序（插件会等待注册）或 bundle 未挂载。

## 安装与装配（重要）
> **GitHub 一键安装**：`dsh plugin --profile <name> add github:Icstick/dsh-context-maid`
> 会挂载 context-maid 条目。**装完必须按下方装配说明 disable 官方
> compaction-basic / tool-result-pruner**（maid 接管同一 ctx.compaction 服务，
> 官方不禁用则 maid 自动旁路不生效）；auditDir 建议显式配置。


maid 接管官方引擎（继承 BasicCompactionEngine 注册为 ctx.compaction）与官方瘦身器
（ctx.toolResultPruner）——cordis 同 key 服务只能有一个提供者，因此**必须 disable 官方
实例**，否则 maid 自动进入旁路模式（防呆，见日志 warn）：

```yaml
# profile cordis.patch.yml（如 web profile）
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true
```

然后在 profile package.json 加依赖并 insert maid：

```json
{ "dependencies": { "dsh-context-maid": "link:D:/path/to/dsh-context-maid" },
  "dsh": { "profile": { "bundles": ["dsh-context-maid"] } } }
```

```yaml
# 同一 cordis.patch.yml
- insert:
    - id: context-maid
      name: dsh-context-maid
```

重启后 `/context-maid status` 应显示 `ctx.compaction = MaidCompactionEngine（maid 提供）`。

## 配置（用户可调）

| 键 | 默认 | 说明 |
|---|---|---|
| trigger.userRatio | 0.4 | **主旋钮**：上下文阈值（占模型窗口比例）。映射官方 thresholdRatio，0.05-0.95 |
| trigger.minTokens | 30000 | 低于此总 token 不触发 |
| slim.thresholdChars | 4000 | tool 输出超过即内容感知瘦身 |
| slim.headChars / tailChars | 800 / 800 | 瘦身保留预算 |
| sweep.enabled / aggressive | true / false | 无效日志清理（aggressive 档待定） |
| fold.retainRatio | 0.16 | 压缩保留尾比例 |
| pin.enabled / inject | true / true | 钉扎保护（M3） |
| archive.enabled | true | 先归档后压缩（M3，需 ACP） |
| summarization.provider / model | '' / '' | **摘要模型可配**（空=跟随对话模型；可填便宜模型或本地 OpenAI 兼容网关） |
| auditDir | $DSH_HOME/context-maid | 审计库位置 |

## 设计文档

完整设计（五级策展模型、模块架构、配置全表、M1-M4 里程碑、测试计划）见
[docs/dsh-context-maid-design.md](docs/dsh-context-maid-design.md)。

## 开发

```bash
node --test "test/*.test.mjs"
```

## License

MIT License。
