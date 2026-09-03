// src/archiver.mjs — 先归档后压缩：消费 compaction/summary 事件，把摘要写入 ACP ledger。
//
// 设计（docs/dsh-context-maid-design.md §5.5）：
//  - 摘要即证据：每次 FOLD 的 checkpoint 摘要成为 ledger 一条 observation
//    （subject=session 标识，text=摘要，evidenceIds=被压段证据 id，supersedes 链关联）
//  - 与引擎解耦：监听 session/event 的 compaction/summary（旁路模式同样工作）
//  - ACP 为可选服务：不在线自动跳过（maid 不制造硬依赖）
//
// 注意：原始被压内容已在 ACP ledger（ACP 并行摄入全部会话事件）——
// 这里补的是「摘要级」沉淀，让被压区间的语义可经 ACP recall 一层找回。

/**
 * 从 compaction/summary 事件提取摘要文本。
 * @param {object} event - session/event 的 compaction/summary
 * @returns {string} 摘要文本（内容块拼接）
 */
export function summaryTextOf(event) {
  try {
    const summary = event?.data?.summary
    if (typeof summary === 'string') {
      try {
        const parsed = JSON.parse(summary)
        if (Array.isArray(parsed)) {
          return parsed.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        }
        return summary
      } catch { return summary }
    }
    if (Array.isArray(summary)) {
      return summary.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    }
    return ''
  } catch { return '' }
}

/**
 * 注册 archiver：session/event 上消费 compaction/summary → ctx.acp.append。
 * fail-open：任何异常只 warn，不阻断事件派发。
 * @param {object} ctx - cordis Context
 * @param {object} opts - { enabled, audit }
 */
export function registerArchiver(ctx, opts = {}) {
  const enabled = opts.enabled !== false
  ctx.on('session/event', (session, event) => {
    try {
      if (!enabled) return
      if (!event || event.type !== 'compaction/summary') return
      const acp = typeof ctx.get === 'function' ? ctx.get('acp') : undefined
      if (!acp || typeof acp.append !== 'function') return // ACP 不在线 → 跳过
      const text = summaryTextOf(event)
      if (!text) return

      const data = event.data ?? {}
      const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
      const summary = text.slice(0, 1800) // observation text 预算

      const result = acp.append({
        sourceClass: 'agent_authored',
        authority: 'single_observation',
        confidence: 0.6,
        durability: 0.5,
        sensitivity: 'internal',
        claimDomain: 'experience',
        content: '【maid 压缩归档】' + summary,
        sourceRef: { sessionEventId: String(event.seq ?? ''), maidCompactionId: String(data.compactionId ?? '') },
      })
      // 审计留痕
      try {
        opts.audit?.append?.({
          op: 'fold',
          sessionId: session?.id ?? '',
          range: (data.shadowedRange ? data.shadowedRange.start + ':' + data.shadowedRange.end : ''),
          tokensBefore: data.shadowedTokenCount,
          archiveIds: result?.id ? [result.id] : [],
          summary: 'compaction/summary → ACP ' + (result?.id ? result.id : '(跳过)'),
        })
      } catch { /* 审计失败不阻断 */ }
    } catch (err) {
      ctx.logger?.warn?.('[context-maid] wc:degraded archive_failed reason='
        + (err instanceof Error ? err.message : String(err)))
    }
  })
}

export default registerArchiver
