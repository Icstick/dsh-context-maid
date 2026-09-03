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
   * M3：覆写官方唯一子类钩子——摘要前注入 PIN 事实（软保护）。
   * collectPinnedFacts 失败/无事实 → 走官方原样摘要（fail-open）。
   * @param {import('@deepseek-ai/dsh-compaction-basic').SummarizationInput} input
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {AbortSignal} [signal]
   */
  async summarize(input, agent, signal) {
    try {
      const maid = this.maidConfig ?? {}
      if (maid['pin.enabled'] === false) return super.summarize(input, agent, signal)
      const { collectPinnedFacts, buildPinInstruction } = await import('./pinner.mjs')
      const cwd = agent?.session?.cwd ?? ''
      const facts = await collectPinnedFacts(this.ctx, {
        scopeId: 'user-global',
        cwd,
        extra: Array.isArray(maid['pin.extra']) ? maid['pin.extra'] : [],
      })
      const pinBlock = buildPinInstruction(facts)
      if (!pinBlock) return super.summarize(input, agent, signal)
      // 把 PIN 段作为额外 user 消息附在重放消息后（随区域一起送给摘要模型）
      const pinMessage = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: pinBlock }],
        source: { kind: 'plugin', plugin: 'dsh-context-maid', form: 'pin' },
      }
      const messages = [...(input?.messages ?? []), pinMessage]
      return super.summarize({ ...input, messages }, agent, signal)
    } catch (err) {
      this.ctx.logger?.warn?.('[context-maid] pin inject failed, fallback to official summarize: '
        + (err instanceof Error ? err.message : String(err)))
      return super.summarize(input, agent, signal)
    }
  }
}

export default MaidCompactionEngine
