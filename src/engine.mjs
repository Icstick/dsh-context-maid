// src/engine.mjs — MaidCompactionEngine：继承官方引擎，阈值/保留/摘要模型映射。
//
// 关键机制（设计文档 §5.1/§9）：
//  - cordis Service 构造即注册 ctx.compaction——maid 作为 ctx.compaction 提供者时，
//    宿主必须 disable 官方 compaction-basic（同 key 只能一个提供者）
//  - 阈值可调 = 官方原生 thresholdRatio：把 maid 的 trigger.userRatio 映射过去，
//    官方 pressure/overflow/manual 触发全保留，无需自建 pre-step 触发
//  - summarize() 官方唯一子类钩子：M4 知识感知摘要在此覆写
//  - 钉扎（M3 spike）：范围排除需在覆写点做，见设计 §5.2

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

  // M4：知识感知摘要在此覆写（归档 → PIN 事实注入 → 官方摘要）
  // protected summarize(input, agent, signal) { ... }
}

export default MaidCompactionEngine
