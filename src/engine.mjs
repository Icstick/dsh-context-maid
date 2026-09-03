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
