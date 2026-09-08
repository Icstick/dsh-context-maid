// src/engine.mjs — MaidCompactionEngine：继承官方引擎，阈值/保留/摘要模型映射。
//
// 关键机制（设计文档 §5.1/§9）：
//  - cordis Service 构造即注册 ctx.compaction——maid 作为 ctx.compaction 提供者时，
//    宿主必须 disable 官方 compaction-basic（同 key 只能一个提供者）
//  - 阈值可调 = 官方原生 thresholdRatio：把 maid 的 trigger.userRatio 映射过去，
//    官方 pressure/overflow/manual 触发全保留，无需自建 pre-step 触发
//  - summarize() 官方唯一子类钩子：M4 知识感知摘要在此覆写
//  - 钉扎（M3 spike）：范围排除需在覆写点做，见设计 §5.2

import { randomUUID } from 'node:crypto'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { maidSummarizeWithLlm } from './maid-summarizer.mjs'

/**
 * 把 maid Config 映射为官方 BasicCompactionConfig 子集。
 * 未配置项不传（官方默认）；userRatio 是核心旋钮。
 * @param {object} maid - maid 原始 Config（含点号键）
 * @returns {object} 官方 config 子集
 */
export function toOfficialConfig(maid = {}) {
  const out = { auto: maid.enabled !== false }
  const ratio = Number(maid['trigger.userRatio'])
  if (Number.isFinite(ratio) && ratio > 0) out.thresholdRatio = ratio
  const retain = Number(maid['fold.retainRatio'])
  if (Number.isFinite(retain) && retain > 0) out.retainRatio = retain
  const sp = String(maid['summarization.provider'] ?? '').trim()
  const sm = String(maid['summarization.model'] ?? '').trim()
  if (sp && sm) {
    out.summarizationProvider = sp
    out.summarizationModel = sm
  }
  return out
}

/**
 * MaidCompactionEngine：官方引擎 + maid 映射。
 * 保留官方全部事务/锁/收缩校验/影子价格语义。
 */
export class MaidCompactionEngine extends BasicCompactionEngine {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {object} maidConfig - maid Config（点号键全集）
   */
  constructor(ctx, maidConfig = {}) {
    super(ctx, toOfficialConfig(maidConfig))
    this.maidConfig = maidConfig
  }

  /** M5 eventSlim 增量游标：session → 已处理到的最大 seq（WeakMap 随会话生命周期回收） */
  #slimProgress = new WeakMap()

  /** M5 前置清理入口（eventSlim；M6 将在此加入 sweep）——在官方测压/折叠之前执行。
   *  设计稿 §3：model-free、无锁、幂等；失败只 warn 不阻断官方路径（fail-open）；
   *  无模型信息（resolveModelInfo 失败）时官方永不清理的缺口在此被补上。 */
  async runPreCleanup(agent) {
    const maid = this.maidConfig ?? {}
    const session = agent?.session
    if (!session) return { eventSlim: null, sweep: null }
    // ① eventSlim 增量瘦身（trigger.eventSlim，默认 true）
    let eventSlim = null
    if (maid['trigger.eventSlim'] !== false) {
      try {
        const pruner = typeof this.ctx?.get === 'function' ? this.ctx.get('toolResultPruner') : undefined
        if (pruner && typeof pruner.pruneSession === 'function') {
          const fromSeq = this.#slimProgress.get(session) ?? -1
          if (typeof pruner.incrementalSlim === 'function') {
            eventSlim = pruner.incrementalSlim(session, fromSeq, (row) => this.#auditRow(row, session))
          } else {
            // 官方 pruner（maid slimmer 未接管）→ 全量退化（官方语义幂等）
            const out = pruner.pruneSession(session)
            eventSlim = out
            if (Array.isArray(out?.pruned) && out.pruned.length > 0) {
              this.#auditRow({
                op: 'slim',
                summary: 'eventSlim（官方 pruner 全量退化）：' + out.pruned.length + ' 节点瘦身',
                detail: JSON.stringify({ kind: 'event-slim-fallback', pruned: out.pruned.length }),
              }, session)
            }
          }
          // 推进游标到当前 surface 最大 seq
          const nodes = session.surface?.nodes
          if (Array.isArray(nodes) && nodes.length > 0) {
            const maxSeq = Math.max(nodes[nodes.length - 1], eventSlim?.maxSeen ?? -1)
            this.#slimProgress.set(session, maxSeq)
          }
        }
      } catch (err) {
        this.ctx?.logger?.warn?.('[context-maid] eventSlim failed: '
          + (err instanceof Error ? err.message : String(err)) + '——继续官方路径')
      }
    }
    return { eventSlim, sweep: null }
  }

  /** 审计落行（audit 由 index.apply 装配在 engine.maidAudit；审计失败不阻断） */
  #auditRow(row, session) {
    try {
      this.maidAudit?.append?.({ ...row, sessionId: session?.id ?? '' })
    } catch { /* 审计失败不阻断策展 */ }
  }

  /**
   * M3+M4：覆写官方唯一子类钩子——PIN 注入 + 智能路由摘要。
   * 目标解析链：
   *   1. 注册的 resolver（外部智能路由插件 registerSummarizationResolver 接入；
   *      可返回 null/undefined 表示不决策，继续下一环）
   *   2. maid Config 显式 summarization.provider/model（用户配便宜/本地模型）
   *   3. 官方回落（最近路由对话模型）→ super.summarize
   * PIN 事实注入在 1/2 路径同样生效（消息末尾追加 pin user message）。
   * @param {object} input - SummarizationInput { system?, tools?, messages }
   * @param {object} agent - Agent
   * @param {AbortSignal} [signal]
   */
  async summarize(input, agent, signal) {
    const maid = this.maidConfig ?? {}
    // PIN 事实收集（两种路径共用）
    let pinMessage = null
    try {
      if (maid['pin.enabled'] !== false) {
        const { collectPinnedFacts, buildPinInstruction } = await import('./pinner.mjs')
        const cwd = agent?.session?.cwd ?? ''
        const facts = await collectPinnedFacts(this.ctx, {
          scopeId: 'user-global',
          cwd,
          extra: Array.isArray(maid['pin.extra']) ? maid['pin.extra'] : [],
        })
        const pinBlock = buildPinInstruction(facts)
        if (pinBlock) {
          pinMessage = {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: pinBlock }],
            source: { kind: 'plugin', plugin: 'dsh-context-maid', form: 'pin' },
          }
        }
      }
    } catch (err) {
      this.ctx.logger?.warn?.('[context-maid] pin collect failed: ' + (err instanceof Error ? err.message : String(err)))
    }
    const messages = pinMessage ? [...(input?.messages ?? []), pinMessage] : input?.messages

    // —— M4 智能路由目标解析 ——
    try {
      const defaultTarget = { provider: String(maid['summarization.provider'] ?? ''), model: String(maid['summarization.model'] ?? '') }
      const resolved = await this.resolveSummarizationTarget(agent, defaultTarget)
      if (resolved && resolved.provider && resolved.model) {
        const result = await maidSummarizeWithLlm(this.ctx, { ...resolved, maxTokens: maid.summarizationMaxTokens ?? 8192 }, { ...input, messages }, agent, signal)
        // 审计：路由决策
        try {
          this.ctx.logger?.info?.('[context-maid] summarize routed to ' + resolved.provider + '/' + resolved.model)
        } catch { /* ignore */ }
        return result
      }
    } catch (err) {
      this.ctx.logger?.warn?.('[context-maid] maid summarize failed, fallback to official: '
        + (err instanceof Error ? err.message : String(err)))
    }
    // 回落：官方路径（maid 显式配置经 toOfficialConfig 已映射 summarizationProvider/Model）
    return super.summarize({ ...input, messages }, agent, signal)
  }

  /**
   * M5 覆写官方自动入口：先 runPreCleanup（eventSlim 增量瘦身），再走官方逻辑。
   * agent/pre-step 动态派发 → maid 覆写即成为每次 step 的入口；官方
   * pressure/overflow 触发与折叠事务语义全部保留在 super。
   * @param {object} agent - Agent
   * @param {'pressure'|'context-overflow'} trigger - 官方触发类型
   * @param {AbortSignal} signal
   */
  async compactIfNeeded(agent, trigger, signal) {
    try {
      await this.runPreCleanup(agent)
    } catch (err) {
      this.ctx?.logger?.warn?.('[context-maid] runPreCleanup failed: '
        + (err instanceof Error ? err.message : String(err)))
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }

  /** 智能路由解析器注册表（外部插件接入点） */
  #resolvers = []

  /**
   * 注册摘要目标解析器。解析器签名：
   *   async (agent, defaultTarget) => { provider, model } | null | undefined
   * 返回 null/undefined = 不决策（继续 maid Config → 官方回落）。
   * @param {(agent: object, defaultTarget: object) => Promise<object|null|undefined>|object|null|undefined} fn
   * @returns {() => void} 注销函数
   */
  registerSummarizationResolver(fn) {
    if (typeof fn !== 'function') throw new TypeError('registerSummarizationResolver: fn must be a function')
    this.#resolvers.push(fn)
    return () => { this.#resolvers = this.#resolvers.filter((f) => f !== fn) }
  }

  /** 依次询问注册的 resolver；全不决策返回 maid Config 显式目标或 null。 */
  async resolveSummarizationTarget(agent, defaultTarget) {
    for (const fn of this.#resolvers) {
      try {
        const out = await fn(agent, defaultTarget)
        if (out && typeof out.provider === 'string' && out.provider && typeof out.model === 'string' && out.model) {
          return { provider: out.provider, model: out.model }
        }
      } catch (err) {
        this.ctx.logger?.warn?.('[context-maid] summarization resolver error: '
          + (err instanceof Error ? err.message : String(err)))
      }
    }
    if (defaultTarget && defaultTarget.provider && defaultTarget.model) return defaultTarget
    return null
  }
}

export default MaidCompactionEngine
