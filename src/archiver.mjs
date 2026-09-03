// src/archiver.mjs — 先归档后压缩：消费 compaction/summary 事件，把摘要写入 ACP ledger。
//
// 设计（docs/dsh-context-maid-design.md §5.5）：
//  - 摘要即证据：每次 FOLD 的 checkpoint 摘要成为 ledger 一条 observation
//    （subject=session 标识，text=摘要，evidenceIds=被压段证据 id，supersedes 链关联）
//  - 与引擎解耦：监听 session/event 的 compaction/summary（旁路模式同样工作）
//  - ACP 为可选服务：不在线自动跳过（maid 不制造硬依赖）
//
// 2026-09-03 实测修复（live 验证：/compact 成功但 maid_audit 0 行）：
//  - audit-first：事件到达即无条件写 audit（detail 记录归档结果/跳过原因），
//    审计不再依赖 ACP 在线——可区分「事件未达」与「归档路径断开」。
//  - acp 解析多路：ctx.get('acp') → ctx.acp（cordis provide 属性访问）兜底。
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
 * 解析 ACP service：多路兜底（ctx.get → ctx.acp）。
 * cordis 下 ctx.provide('acp', …) 注册的 service 可经 ctx.get('acp') 获取；
 * 部分宿主/上下文层级下 ctx.get 解析不到时，属性访问 ctx.acp 仍可命中。
 * @param {object} ctx
 * @returns {object|undefined} acp service（含 append 方法）或 undefined
 */
export function getAcpService(ctx) {
  if (!ctx) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('acp') : undefined
    if (viaGet && typeof viaGet.append === 'function') return viaGet
  } catch { /* 继续下一路 */ }
  try {
    if (ctx.acp && typeof ctx.acp.append === 'function') return ctx.acp
  } catch { /* 继续 */ }
  return undefined
}

/**
 * 注册 archiver：session/event 上消费 compaction/summary → ACP ledger + 审计。
 * audit-first：事件到达即写审计（无论 ACP 是否在线/摘要是否为空），
 * detail 字段记录归档结果或跳过原因——保证策展可观测。
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
      const data = event.data ?? {}
      const text = summaryTextOf(event)
      const acp = getAcpService(ctx)

      let archiveIds = []
      let note = ''
      if (!acp) {
        note = 'acp 不可用（ctx.get/ctx.acp 均未解析到 append）→ 跳过归档'
      } else if (!text) {
        note = 'summary 文本为空 → 跳过归档'
      } else {
        try {
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
          archiveIds = result?.id ? [result.id] : []
          note = archiveIds.length > 0 ? ('已归档 ' + result.id) : 'acp.append 未返回 id'
        } catch (err) {
          note = 'acp.append 失败: ' + (err instanceof Error ? err.message : String(err))
        }
      }
      // audit-first：无条件留痕（审计失败不阻断策展）
      try {
        opts.audit?.append?.({
          op: 'fold',
          sessionId: session?.id ?? '',
          range: data.shadowedRange ? data.shadowedRange.start + ':' + data.shadowedRange.end : '',
          tokensBefore: data.shadowedTokenCount,
          archiveIds,
          summary: 'compaction/summary → ' + (archiveIds.length > 0 ? 'ACP ' + archiveIds[0] : note),
          detail: note,
        })
      } catch { /* 审计失败不阻断 */ }
    } catch (err) {
      ctx.logger?.warn?.('[context-maid] archive_failed reason='
        + (err instanceof Error ? err.message : String(err)))
    }
  })
}

export default registerArchiver
