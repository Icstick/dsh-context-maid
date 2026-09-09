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
import { freezeMessage } from '@deepseek-ai/dsh-llm'

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
      thresholdChars: Number(maidConfig['slim.thresholdChars']) || 30000,
      headChars: Number(maidConfig['slim.headChars']) || 800,
      tailChars: Number(maidConfig['slim.tailChars']) || 800,
    })
  }

  /** JSON 骨架保留上限（字符） */
  get jsonBudget() {
    return Math.max(300, this.config.headChars + this.config.tailChars)
  }

  /**
   * M5 eventSlim：增量落地瘦身——只处理 seq > fromSeq 的新 tool/result 节点。
   * 设计稿 §5：在 step 边界（agent/pre-step）调用；幂等（已瘦节点不再超预算）。
   * 落地协议与官方 pruneSession 一致：compaction/prune 定价事件紧跟 replace
   * （相邻性是契约），replace 保留 message envelope 与 sourceEventSeqs 溯源。
   * @param {object} session - dsh Session（surface.nodes / eventAt / append）
   * @param {number} fromSeq - 上次处理到的最大 seq（含）；新节点 = seq > fromSeq
   * @param {(row: object) => void} [onRow] - 每处置一个节点回调审计行（op=slim）
   * @returns {{processed: number, pruned: number, charsRemoved: number, maxSeen: number}}
   */
  incrementalSlim(session, fromSeq = -1, onRow) {
    const meter = getTokenMeter(this.ctx)
    let processed = 0
    let handled = 0
    let charsRemoved = 0
    let maxSeen = -1
    for (const seq of Array.from(session.surface.nodes)) { // 快照遍历：append replace 不干扰本轮
      if (seq <= fromSeq) continue
      if (seq > maxSeen) maxSeen = seq
      const event = session.eventAt(seq)
      if (!event || event.type !== 'tool/result') continue
      processed += 1
      const result = event.data?.message?.content?.[0]
      if (!result) continue
      let content = null
      try {
        content = this.pruneContent(result.content)
      } catch (err) {
        this.ctx?.logger?.warn?.('[context-maid] incrementalSlim pruneContent failed: '
          + (err instanceof Error ? err.message : String(err)))
        continue
      }
      if (content === null) continue
      const charsBefore = this.measureContent(result.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage({
        ...event.data.message,
        content: [{
          ...result,
          content,
        }],
      })
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: typeof meter?.estimateMessage === 'function'
          ? meter.estimateMessage(event.data.message)
          : 0,
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      if (replacement?.seq > maxSeen) maxSeen = replacement.seq
      handled += 1
      charsRemoved += charsBefore - charsAfter
      onRow?.({
        op: 'slim',
        range: seq + ':' + seq,
        tokensBefore: charsBefore,
        tokensAfter: charsAfter,
        summary: 'eventSlim：' + charsBefore + '→' + charsAfter + ' chars（seq ' + seq + '→' + replacement.seq + '）',
        detail: JSON.stringify({ kind: 'event-slim', originalSeq: seq, replacementSeq: replacement.seq, charsBefore, charsAfter }),
      })
    }
    return { processed, pruned: handled, charsRemoved, maxSeen }
  }

  /**
   * 覆写官方 pruneSession（2026-09-08 实测修复）：官方实现内部 this.ctx.tokenMeter
   * 属性访问依赖 cordis 框架注入——maid 直接 new 装配无注入 → 真实会话抛
   * "cannot get property tokenMeter without inject"。本覆写等价官方语义
   * （surface tool/result 全量扫描 + compaction/prune 定价 + replace），
   * meter 改经 getTokenMeter 安全获取（缺失时定价记 0，处置不中断）。
   * @param {object} session - dsh Session
   * @returns {{pruned: object[], charsRemoved: number}}
   */
  pruneSession(session) {
    const meter = getTokenMeter(this.ctx)
    const candidates = []
    for (const seq of Array.from(session.surface.nodes)) {
      const event = session.eventAt(seq)
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }
    const pruned = []
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const result = event.data.message.content[0]
      let content = null
      try {
        content = this.pruneContent(result.content)
      } catch { continue }
      if (content === null) continue
      const charsBefore = this.measureContent(result.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage({
        ...event.data.message,
        content: [{
          ...result,
          content,
        }],
      })
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: typeof meter?.estimateMessage === 'function'
          ? meter.estimateMessage(event.data.message)
          : 0,
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source?.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
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

/**
 * 安全获取 tokenMeter（cordis 注入兼容，2026-09-08 实测修复）：
 * maid 直接 new Service 子类（非 ctx.plugin 装配）时 cordis 的注入代理未绑定
 * inject 属性——this.ctx.tokenMeter 属性访问抛 "cannot get property without inject"。
 * 服务查找 ctx.get('tokenMeter') 不受注入代理限制（与 ctx.get('toolResultPruner') 同路径）。
 * @param {object} ctx - cordis Context
 * @returns {object|undefined}
 */
export function getTokenMeter(ctx) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const m = ctx.get('tokenMeter')
      if (m) return m
    }
  } catch { /* 继续下一路 */ }
  try { return ctx.tokenMeter } catch { return undefined }
}

/**
 * countTextChars：tool-result content blocks 文本总字符数（code point）。
 * @param {readonly object[]} blocks
 * @returns {number}
 */
export function countTextChars(blocks) {
  let n = 0
  if (!Array.isArray(blocks)) return n
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') n += Array.from(b.text).length
  }
  return n
}

/**
 * M6 sweep 执行：把单个 tool/result 表面节点 stub 为一行标记（model-free）。
 * 整段内容按结构性无价值处置（D1-A 拍板）；走官方 shadow-price 协议：
 * compaction/prune 定价事件紧跟 tool/result replace（相邻契约），
 * replace 保留 message envelope、source.callId 与 sourceEventSeqs 溯源。
 * 与 incrementalSlim 的区别：sweep 不留头尾/骨架——整节点换 marker。
 * @param {object} session - dsh Session
 * @param {number} seq - 被处置的 tool/result 表面 seq
 * @param {string} kind - sweep 类别（superseded-read / failed-retry）
 * @param {string} reason - 人类可读原因（进入 stub 标记与审计）
 * @param {object} [opts] - { meter?, onRow? } meter 提供 estimateMessage 定价；onRow 收审计行
 * @returns {{replacementSeq: number, charsBefore: number}|null} 未处置返回 null
 */
export function stubToolResultNode(session, seq, kind, reason, opts = {}) {
  const event = session.eventAt(seq)
  if (!event || event.type !== 'tool/result') return null
  const result = event.data?.message?.content?.[0]
  if (!result) return null
  const charsBefore = countTextChars(result.content)
  const marker = '[maid sweep: ' + kind + ' —— ' + reason + ']'
  const message = freezeMessage({
    ...event.data.message,
    content: [{
      ...result,
      content: [{ type: 'text', text: marker }],
    }],
  })
  const meter = opts?.meter
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: typeof meter?.estimateMessage === 'function'
      ? meter.estimateMessage(event.data.message)
      : 0,
  })
  const replacement = session.append('tool/result', {
    ...event.data,
    message,
  }, {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [seq],
  })
  opts?.onRow?.({
    op: 'sweep',
    range: seq + ':' + seq,
    tokensBefore: charsBefore,
    tokensAfter: marker.length,
    summary: 'sweep ' + kind + '：seq ' + seq + '→' + replacement.seq,
    detail: JSON.stringify({ kind, reason, originalSeq: seq, replacementSeq: replacement.seq, charsBefore }),
  })
  return { replacementSeq: replacement.seq, charsBefore }
}

export default MaidSlimmer
