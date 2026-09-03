// src/slimmer.mjs — 内容感知 tool 输出瘦身（M2 主战场①）。
//
// 继承官方 ToolResultPruner，覆写 pruneContent：按内容类型选择保留策略，
// 而非固定 head/tail。类型识别失败回退官方策略。
//
// 策略：
//  - JSON/结构化：保留骨架（外层结构 + 关键字段采样 + 数组长度标注）
//  - 错误/stderr：头部摘要行 + 尾部错误段（诊断价值在尾部）
//  - 长文本/日志：官方 head/tail（头部上下文 + 尾部结论）
//  - 其它：回退官方策略

import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { codePointLength } from '@deepseek-ai/dsh-compaction-tool-result-pruner'

/** 文本内容类型（确定性探测，不调 LLM） */
export function detectContentType(text) {
  const s = String(text ?? '')
  const trimmed = s.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  // stderr / 错误特征
  if (/stderr|error|failed|exception|traceback|errno|exit code/i.test(s.slice(0, 400))) return 'error'
  // 日志特征（时间戳行首）
  if (/^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\[\d{2}:\d{2})/m.test(s)) return 'log'
  return 'plain'
}

/**
 * JSON 骨架化：保留顶层结构 + 键名与长度，正文截断。
 * 确定性规则：每层最多保留 depthChars 字符；数组标注 "[n items]"。
 */
export function jsonSkeleton(text, maxChars = 600) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return s
  let trimmed = s
  try {
    const parsed = JSON.parse(s)
    const summarize = (v, depth) => {
      if (depth > 4) return '…'
      if (v === null) return null
      if (typeof v !== 'object') {
        const str = typeof v === 'string' ? v : JSON.stringify(v)
        return str.length > 60 ? str.slice(0, 57) + '…' : str
      }
      if (Array.isArray(v)) {
        if (v.length === 0) return []
        if (depth >= 3) return '[array ' + v.length + ' items]'
        const head = v.slice(0, 3).map((x) => summarize(x, depth + 1))
        return v.length > 3 ? [...head, '… +' + (v.length - 3) + ' more'] : head
      }
      const out = {}
      const keys = Object.keys(v)
      for (const k of keys.slice(0, 8)) out[k] = summarize(v[k], depth + 1)
      if (keys.length > 8) out['…'] = '+' + (keys.length - 8) + ' keys'
      return out
    }
    trimmed = JSON.stringify(summarize(parsed, 0), null, 1)
  } catch { /* 非合法 JSON 字符串（如以 { 开头的中文）→ 走通用截断 */ }
  if (trimmed.length > maxChars) {
    trimmed = trimmed.slice(0, maxChars - 1) + '…'
  }
  return trimmed
}

/**
 * MaidSlimmer：内容感知瘦身器。
 * 注册为 ctx.toolResultPruner（官方 Service key）即被 compaction-basic 自动使用；
 * 卸载 maid 恢复官方行为。
 */
export class MaidSlimmer extends ToolResultPruner {
  /**
   * @param {object} ctx - cordis Context
   * @param {object} maidConfig - maid Config（读 slim.* 键）
   */
  constructor(ctx, maidConfig = {}) {
    super(ctx, {
      thresholdChars: Number(maidConfig['slim.thresholdChars']) || 4000,
      headChars: Number(maidConfig['slim.headChars']) || 800,
      tailChars: Number(maidConfig['slim.tailChars']) || 800,
    })
  }

  /** JSON 骨架保留上限（字符） */
  get jsonBudget() {
    return Math.max(300, this.config.headChars + this.config.tailChars)
  }

  /**
   * 覆写：内容感知截断。
   * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} blocks
   * @returns {import('@deepseek-ai/dsh-llm').ContentBlock[]|null}
   */
  pruneContent(blocks) {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    // 多块或非纯文本 → 官方策略（保持官方 block 顺序语义）
    const textBlocks = blocks.filter((b) => b.type === 'text')
    if (blocks.length !== textBlocks.length) return super.pruneContent(blocks)

    // 内容类型策略
    const joined = textBlocks.map((b) => b.text).join('\n')
    const type = detectContentType(joined)

    if (type === 'json') {
      const skeleton = jsonSkeleton(joined, this.jsonBudget)
      if (skeleton.length >= totalChars) return super.pruneContent(blocks) // 骨架没变小 → 回退
      const marker = '\n… [maid slim: JSON 骨架化 ' + totalChars + '→' + skeleton.length + ' chars]\n'
      return [{ type: 'text', text: skeleton + marker }]
    }

    if (type === 'error' || type === 'log') {
      // 错误/日志：头（少量上下文）+ 尾（诊断结论）。官方已是 head/tail，
      // 但错误类 tail 应该更大——通过调整有效 head/tail 实现
      const points = Array.from(joined)
      const headN = Math.min(this.config.headChars, points.length)
      const tailN = Math.min(Math.max(this.config.tailChars, this.config.headChars * 1.5), points.length)
      const head = points.slice(0, headN).join('')
      const tail = points.slice(points.length - tailN).join('')
      const marker = '\n… [maid slim: ' + type + ' 保留头尾 ' + totalChars + '→' + (headN + tailN) + ' chars]\n'
      const out = head + marker + tail
      if (out.length >= totalChars) return super.pruneContent(blocks)
      return [{ type: 'text', text: out }]
    }

    // plain / 其它 → 官方策略
    return super.pruneContent(blocks)
  }
}

export default MaidSlimmer
